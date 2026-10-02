//! Real filesystem tools, real SQLite Jobs and receipts, deterministic model
//! decisions. This is a tool-status authority regression, not model quality.
use morphz::{
    config::AppConfig,
    llm::{Client, Message, Response, ToolCallRepr, ToolDefinition},
    memory::{
        sqlite::SqliteStore, ExecutionJobFilter, ExecutionJobStatus, ExecutionJobStore, NewSession,
        QueryFilter, SessionMountKind, ThreadLifecycle,
    },
    permission::{PermissionConfig, PermissionMode},
    runtime::{MorphzRuntime, RuntimeToolPolicy},
    tool::{ReadFileTool, Tool},
};
use serde_json::{json, Value};
use std::{
    error::Error,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tempfile::TempDir;

type DynError = Box<dyn Error + Send + Sync>;

struct ReadClient {
    path: String,
    calls: AtomicUsize,
    receipt: Mutex<Option<Value>>,
}

#[async_trait::async_trait]
impl Client for ReadClient {
    fn supports_async_cancellation(&self) -> bool {
        true
    }

    fn model(&self) -> Option<String> {
        Some("read-status-fixture".into())
    }

    async fn create_completion(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
    ) -> Result<Response, DynError> {
        match self.calls.fetch_add(1, Ordering::SeqCst) {
            0 => {
                assert!(tools.iter().any(|tool| tool.name == "read"));
                Ok(Response {
                    content: String::new(),
                    tool_calls: vec![ToolCallRepr {
                        id: "actual-read-call".into(),
                        r#type: "function".into(),
                        func_name: "read".into(),
                        arguments: json!({"path": self.path}).to_string(),
                    }],
                })
            }
            1 => {
                let receipt = messages
                    .iter()
                    .find(|message| {
                        message.role == "tool"
                            && message.tool_call_id.as_deref() == Some("actual-read-call")
                    })
                    .expect("the next original request must receive its actual read receipt");
                *self.receipt.lock().unwrap() = Some(serde_json::from_str(&receipt.content)?);
                Ok(Response {
                    content: "Read attempt handled.".into(),
                    tool_calls: vec![],
                })
            }
            call => panic!("unexpected extra model request {call}"),
        }
    }
}

#[derive(Clone, Copy)]
enum ReadCase {
    Missing,
    PolicyDenied,
    IoFailure,
    Success,
}

async fn assert_read_status(case: ReadCase) {
    let temp = TempDir::new().unwrap();
    let path = match case {
        ReadCase::Missing => temp.path().join("missing.txt"),
        ReadCase::PolicyDenied | ReadCase::Success => {
            let path = temp.path().join("fixture.txt");
            std::fs::write(&path, "actual file contents\n").unwrap();
            path
        }
        ReadCase::IoFailure => temp.path().to_path_buf(),
    };
    let mut tool_permissions = PermissionConfig {
        mode: PermissionMode::FullAccess,
        workspace_root: temp.path().to_string_lossy().into_owned(),
        ..Default::default()
    };
    if matches!(case, ReadCase::PolicyDenied) {
        tool_permissions.mode = PermissionMode::RequestApproval;
        tool_permissions.protected_paths = vec!["fixture.txt".into()];
    }
    let read = Arc::new(ReadFileTool::new(Arc::new(tool_permissions)));
    let actual_output = read
        .execute_result(&json!({"path": path}).to_string())
        .await
        .unwrap();
    let expected_text = actual_output.text;
    let expected_status = if matches!(case, ReadCase::Success) {
        assert!(expected_text.ends_with("\nactual file contents\n"));
        "success"
    } else {
        assert!(
            expected_text.starts_with("System error:"),
            "{expected_text}"
        );
        let cause = match case {
            ReadCase::Missing => "does not exist",
            ReadCase::PolicyDenied => "permission policy rejected the read path",
            ReadCase::IoFailure => "failed to read file",
            ReadCase::Success => unreachable!(),
        };
        assert!(expected_text.contains(cause), "{expected_text}");
        "error"
    };

    let db = temp.path().join("read-status.db");
    let client = Arc::new(ReadClient {
        path: path.to_string_lossy().into_owned(),
        calls: AtomicUsize::new(0),
        receipt: Mutex::new(None),
    });
    let mut config = AppConfig::default();
    config.llm.model = "read-status-fixture".into();
    config.permissions.mode = PermissionMode::FullAccess;
    config.permissions.workspace_root = temp.path().to_string_lossy().into_owned();
    config.background_task.artifact_dir =
        temp.path().join("artifacts").to_string_lossy().into_owned();
    // The host admits physical read Jobs; the registered production read tool
    // may enforce a stricter policy. This exercises an actual post-claim policy
    // denial, rather than injecting an error string or changing permissions.
    let runtime = MorphzRuntime::builder(config, client.clone() as Arc<dyn Client>)
        .database_path(db.to_string_lossy())
        .tool_policy(RuntimeToolPolicy {
            context_only: false,
            coding_eval: false,
        })
        .extra_tool(read)
        .build()
        .await
        .unwrap();
    runtime.start().await.unwrap();
    let session = runtime
        .ensure_session(NewSession {
            id: "read-status-session".into(),
            agent_id: runtime.identity().agent_id.clone(),
            context_id: runtime.identity().context_id.clone(),
            parent_session_id: None,
            title: "Read status regression".into(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    let mut replies = runtime.subscribe("chat/reply", 8);
    let accepted = session
        .send(
            "Attempt the fixture read once.",
            "Test",
            Some("read-status-input".into()),
        )
        .await
        .unwrap();
    let reply = tokio::time::timeout(Duration::from_secs(20), replies.recv())
        .await
        .expect("the read must produce a normal final model response")
        .unwrap();
    assert_eq!(reply.payload["text"], "Read attempt handled.");
    assert_eq!(client.calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        client.receipt.lock().unwrap().as_ref().unwrap()["status"],
        expected_status
    );

    let outputs = runtime
        .query_events(QueryFilter {
            root_turn_id: Some(accepted.event_id.clone()),
            topic: Some("chat/tool_output".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(outputs.len(), 1);
    assert_eq!(outputs[0].payload["tool_status"], expected_status);
    assert_eq!(outputs[0].payload["text"], expected_text);
    let jobs = runtime
        .list_execution_jobs(ExecutionJobFilter {
            session_id: Some(session.id().into()),
            include_terminal: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(jobs.len(), 1, "one physical read, no duplicate retry");
    let job = &jobs[0];
    assert_eq!(job.tool_name, "read");
    assert_eq!(job.result_event_id.as_deref(), Some(outputs[0].id.as_str()));
    assert_eq!(
        job.exit_code, None,
        "read must not acquire synthetic shell exit codes"
    );
    if expected_status == "error" {
        assert_eq!(job.status, ExecutionJobStatus::Failed);
        assert_eq!(job.error.as_deref(), Some(expected_text.as_str()));
    } else {
        assert_eq!(job.status, ExecutionJobStatus::Succeeded);
        assert_eq!(job.error, None);
    }
    let reopened = SqliteStore::new(db.to_str().unwrap()).await.unwrap();
    assert_eq!(
        reopened.get_execution_job(&job.id).await.unwrap(),
        Some(job.clone())
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let thread = runtime
                .session_thread_by_root(session.id(), &accepted.event_id)
                .await
                .unwrap()
                .unwrap();
            if thread.lifecycle == ThreadLifecycle::Completed {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("handled tool failure must still allow the Thread to complete normally");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn missing_read_is_error_in_receipt_and_failed_in_durable_job() {
    assert_read_status(ReadCase::Missing).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn read_policy_denial_is_error_in_receipt_and_failed_in_durable_job() {
    assert_read_status(ReadCase::PolicyDenied).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn read_io_failure_is_error_in_receipt_and_failed_in_durable_job() {
    assert_read_status(ReadCase::IoFailure).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn successful_read_remains_success_in_receipt_and_durable_job() {
    assert_read_status(ReadCase::Success).await;
}
