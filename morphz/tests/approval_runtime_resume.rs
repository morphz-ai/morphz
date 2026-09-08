//! Actual Runtime + physical read tools, in three separate OS processes.
//! No model API, real credentials, or user files are used.
#![cfg(feature = "remote-store")]
use morphz::config::AppConfig;
use morphz::llm::{Client, Message, Response, ToolCallRepr, ToolDefinition};
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::*;
use morphz::permission::{PermissionMode, ReviewerKind};
use morphz::runtime::{MorphzRuntime, RuntimeToolPolicy};
use morphz::secret_store::{HostEnvFileSecretBackend, SecretStore};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

struct FixtureClient {
    root: PathBuf,
    stage: String,
    nested: bool,
    calls: AtomicUsize,
}

#[async_trait::async_trait]
impl Client for FixtureClient {
    fn supports_async_cancellation(&self) -> bool {
        true
    }
    async fn create_completion(
        &self,
        messages: Vec<Message>,
        _: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        assert_eq!(
            self.calls.fetch_add(1, Ordering::SeqCst),
            0,
            "unexpected extra model request"
        );
        if self.stage == "initial" {
            let mut calls = vec![ToolCallRepr {
                id: "read-0".into(),
                r#type: "function".into(),
                func_name: "read".into(),
                arguments: json!({"path":self.root.join("workspace/free.txt")}).to_string(),
            }];
            if self.nested {
                calls.push(ToolCallRepr {
                    id: "eval-root".into(), r#type: "function".into(), func_name: "eval".into(),
                    arguments: json!({"program":format!(
                        "(eval (requires (tools read)) (par (branch one (call read (path {}))) (branch two (call read (path {})))))",
                        json!(self.root.join("outside/one.txt")), json!(self.root.join("outside/two.txt")),
                    )}).to_string(),
                });
            } else {
                calls.extend(
                    ["outside/one.txt", "outside/two.txt"]
                        .into_iter()
                        .enumerate()
                        .map(|(i, name)| ToolCallRepr {
                            id: format!("read-{}", i + 1),
                            r#type: "function".into(),
                            func_name: "read".into(),
                            arguments: json!({"path":self.root.join(name)}).to_string(),
                        }),
                );
            }
            Ok(Response {
                content: String::new(),
                tool_calls: calls,
            })
        } else {
            assert_eq!(
                self.stage, "final",
                "resuming a partial batch must not call a model"
            );
            let tools = messages
                .iter()
                .filter(|m| m.role == "tool")
                .collect::<Vec<_>>();
            assert_eq!(
                tools.len(),
                if self.nested { 2 } else { 3 },
                "the resumed batch must contain every sibling result"
            );
            let content = tools
                .iter()
                .map(|m| m.content.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            assert!(content.contains("free-fixture"));
            if !self.nested {
                assert!(content.contains("approved-fixture"));
                assert!(content.contains("approval did not authorize"));
            } else {
                // The outer model receives the failed eval result, not the
                // internal physical read's permission-rejection envelope.
                assert!(content.contains("(par ...) failed"), "{content}");
                assert!(content.contains("synthetic denial"), "{content}");
            }
            assert!(!content.contains("must-not-be-read"));
            Ok(Response {
                content: "checkpoint-batch-complete".into(),
                tool_calls: Vec::new(),
            })
        }
    }
}

async fn store(root: &Path) -> Arc<SqliteStore> {
    Arc::new(
        SqliteStore::new(root.join("runtime.sqlite").to_str().unwrap())
            .await
            .unwrap(),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "subprocess fixture; invoked by approval_batch_resumes_across_real_process_exits"]
async fn approval_runtime_child() {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .with_test_writer()
        .try_init();
    let root = PathBuf::from(std::env::var("MORPHZ_APPROVAL_FIXTURE_ROOT").unwrap());
    let stage = std::env::var("MORPHZ_APPROVAL_FIXTURE_STAGE").unwrap();
    let native = store(&root).await;
    let client = Arc::new(FixtureClient {
        root: root.clone(),
        stage: stage.clone(),
        nested: std::env::var("MORPHZ_APPROVAL_FIXTURE_NESTED").as_deref() == Ok("1"),
        calls: AtomicUsize::new(0),
    });
    let mut config = AppConfig::default();
    config.orchestrator.activation_admission.max_in_flight = 1;
    config.orchestrator.event_bus.max_in_flight = 1;
    config.permissions.mode = PermissionMode::Custom;
    config.permissions.reviewer = ReviewerKind::User;
    config.permissions.read_only_outside_workspace = false;
    config.permissions.workspace_root = root.join("workspace").to_string_lossy().into_owned();
    config.background_task.artifact_dir = root.join("artifacts").to_string_lossy().into_owned();
    let runtime = MorphzRuntime::builder(config, client.clone())
        .store("sqlite:approval-fixture", native.clone())
        .secret_store(Arc::new(
            SecretStore::new(
                root.join("secrets.json"),
                Arc::new(HostEnvFileSecretBackend::new(root.join("test.env"))),
            )
            .unwrap(),
        ))
        .tool_policy(RuntimeToolPolicy {
            context_only: false,
            coding_eval: true,
        })
        .build()
        .await
        .unwrap();
    let mut replies = runtime.subscribe("chat/reply", 8);
    runtime.start().await.unwrap();
    if stage == "initial" {
        let session = runtime
            .ensure_session(NewSession {
                id: "approval-process-session".into(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Synthetic approval checkpoint".into(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        session
            .send(
                "read three synthetic files",
                "Checkpoint-Test",
                Some("checkpoint-ingress".into()),
            )
            .await
            .unwrap();
    }
    if stage == "final" {
        let reply = match tokio::time::timeout(Duration::from_secs(15), replies.recv()).await {
            Ok(reply) => reply.unwrap(),
            Err(error) => {
                let plans = native
                    .list_plan_executions(PlanExecutionFilter {
                        include_terminal: true,
                        ..Default::default()
                    })
                    .await
                    .unwrap();
                let jobs = native
                    .list_execution_jobs(ExecutionJobFilter {
                        include_terminal: true,
                        ..Default::default()
                    })
                    .await
                    .unwrap();
                let groups = native
                    .list_action_groups(ActionGroupFilter {
                        include_terminal: true,
                        ..Default::default()
                    })
                    .await
                    .unwrap();
                let events = native
                    .query(QueryFilter {
                        topic: Some("chat/tool_output".into()),
                        ..Default::default()
                    })
                    .await
                    .unwrap();
                panic!("final reply timed out: {error}; plans={:?}; jobs={:?}; groups={:?}; events={:?}",
                    plans.iter().map(|p| (&p.id, p.status, p.pending_kind, &p.error)).collect::<Vec<_>>(),
                    jobs.iter().map(|j| (&j.id, j.status)).collect::<Vec<_>>(),
                    groups.iter().map(|g| (&g.id, g.status)).collect::<Vec<_>>(),
                    events.iter().map(|e| (&e.topic, &e.payload)).collect::<Vec<_>>());
            }
        };
        assert_eq!(reply.payload["text"], "checkpoint-batch-complete");
    }
    let idle = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let jobs = native
                .list_execution_jobs(ExecutionJobFilter {
                    session_id: Some("approval-process-session".into()),
                    include_terminal: true,
                    ..Default::default()
                })
                .await
                .unwrap();
            if jobs.len() == 3 && runtime.hosted_process_is_quiescent() {
                let wait = native
                    .get_thread_activation_approval_wait(&jobs[0].activation_id)
                    .await
                    .unwrap();
                let expected = match stage.as_str() {
                    "initial" => 2,
                    "partial" => 1,
                    _ => 0,
                };
                if wait.as_ref().map_or(0, |wait| wait.approval_ids.len()) == expected {
                    assert_eq!(
                        jobs.iter()
                            .filter(|j| j.status == ExecutionJobStatus::WaitingApproval)
                            .count(),
                        expected
                    );
                    assert!(jobs
                        .iter()
                        .filter(|j| j.status == ExecutionJobStatus::WaitingApproval)
                        .all(|j| j.side_effect_started_at.is_none()));
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    if idle.is_err() {
        let plans = native
            .list_plan_executions(PlanExecutionFilter {
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap();
        let snapshot = runtime
            .scheduler_snapshot(
                &runtime.identity().context_id,
                morphz::runtime::SchedulerQuery {
                    include_terminal: true,
                    limit: 100,
                },
            )
            .await
            .unwrap();
        let jobs = native
            .list_execution_jobs(ExecutionJobFilter {
                session_id: Some("approval-process-session".into()),
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap();
        let wait = match jobs.first() {
            Some(job) => native
                .get_thread_activation_approval_wait(&job.activation_id)
                .await
                .unwrap(),
            None => None,
        };
        panic!(
            "Runtime did not settle; stage={stage}, process_idle={}, wait={wait:?}, summary={:?}, admission={:?}, plans={:?}, jobs={:?}",
            runtime.hosted_process_is_quiescent(), snapshot.summary, snapshot.admission,
            plans.iter().map(|p| (&p.id, p.status, p.pending_kind, &p.error)).collect::<Vec<_>>(),
            jobs.iter().map(|j| (&j.id, j.status, &j.claimed_by)).collect::<Vec<_>>(),
        );
    }
    assert_eq!(
        client.calls.load(Ordering::SeqCst),
        usize::from(stage != "partial")
    );
}

fn run_child(root: &Path, stage: &str, nested: bool) {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "approval_runtime_child",
            "--ignored",
            "--nocapture",
        ])
        .env("MORPHZ_APPROVAL_FIXTURE_ROOT", root)
        .env("MORPHZ_APPROVAL_FIXTURE_STAGE", stage)
        .env(
            "MORPHZ_APPROVAL_FIXTURE_NESTED",
            if nested { "1" } else { "0" },
        )
        .env_remove("RUST_MIN_STACK")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "child {stage} failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        !String::from_utf8_lossy(&output.stdout).contains("recovery_item_failed"),
        "Plan joins must not be misrouted through assistant-batch recovery: {}",
        String::from_utf8_lossy(&output.stdout)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn approval_batch_resumes_across_real_process_exits() {
    approval_process_case(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nested_plan_approval_resumes_across_real_process_exits() {
    approval_process_case(true).await;
}

async fn approval_process_case(nested: bool) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    std::fs::create_dir(root.join("workspace")).unwrap();
    std::fs::create_dir(root.join("outside")).unwrap();
    std::fs::write(root.join("workspace/free.txt"), "free-fixture").unwrap();
    std::fs::write(root.join("outside/one.txt"), "approved-fixture").unwrap();
    std::fs::write(root.join("outside/two.txt"), "must-not-be-read").unwrap();
    run_child(root, "initial", nested);
    let native = store(root).await;
    let before = native
        .list_execution_jobs(ExecutionJobFilter {
            include_terminal: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(before.len(), 3);
    let free = before
        .iter()
        .find(|j| j.tool_call_id == "read-0")
        .unwrap()
        .clone();
    assert_eq!(free.status, ExecutionJobStatus::Succeeded);
    let checkpoint = native
        .get_thread_activation_approval_wait(&free.activation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(checkpoint.approval_ids.len(), 2);
    let one = before
        .iter()
        .find(|j| j.request["path"] == json!(root.join("outside/one.txt")))
        .unwrap();
    let approvals = native
        .list_approvals(ApprovalFilter {
            job_id: Some(one.id.clone()),
            ..Default::default()
        })
        .await
        .unwrap();
    let allowed = &approvals[0];
    native
        .commit_approval_decision(
            &allowed.id,
            allowed.revision,
            ApprovalResolution::Allow {
                rationale: "synthetic exact read".into(),
                risk_tags: Vec::new(),
            },
        )
        .await
        .unwrap();
    drop(native);
    run_child(root, "partial", nested);
    let native = store(root).await;
    let remaining = native
        .get_thread_activation_approval_wait(&free.activation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        remaining.assistant_call_event_id,
        checkpoint.assistant_call_event_id
    );
    assert_eq!(remaining.approval_ids.len(), 1);
    assert!(checkpoint.approval_ids.contains(&remaining.approval_ids[0]));
    assert_eq!(
        native.get_execution_job(&free.id).await.unwrap().unwrap(),
        free,
        "completed sibling was replayed"
    );
    let approved = native.get_execution_job(&one.id).await.unwrap().unwrap();
    assert_eq!(approved.status, ExecutionJobStatus::Succeeded);
    assert!(native
        .get_approval(&allowed.id)
        .await
        .unwrap()
        .unwrap()
        .grant_consumed_at
        .is_some());
    let pending = native
        .list_approvals(ApprovalFilter {
            pending_only: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(pending.len(), 1);
    native
        .commit_approval_decision(
            &pending[0].id,
            pending[0].revision,
            ApprovalResolution::Deny {
                rationale: "synthetic denial".into(),
                risk_tags: Vec::new(),
            },
        )
        .await
        .unwrap();
    drop(native);
    run_child(root, "final", nested);
    let native = store(root).await;
    assert_eq!(
        native.get_execution_job(&free.id).await.unwrap().unwrap(),
        free
    );
    assert_eq!(
        native.get_execution_job(&one.id).await.unwrap().unwrap(),
        approved
    );
    let after = native
        .list_execution_jobs(ExecutionJobFilter {
            include_terminal: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(after.len(), 3);
    assert!(after.iter().all(|j| j.status.is_terminal()));
    assert!(after
        .iter()
        .find(|j| j.request["path"] == json!(root.join("outside/two.txt")))
        .unwrap()
        .side_effect_started_at
        .is_none());
    let outputs = native
        .query(QueryFilter {
            topic: Some("chat/tool_output".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(outputs.len(), if nested { 4 } else { 3 });
    let rejected = outputs
        .iter()
        .find(|e| e.payload["tool_status"] == "rejected")
        .unwrap();
    assert_eq!(rejected.payload["executed"], false);
    assert_eq!(rejected.payload["approval_status"], "denied");
    assert!(rejected.payload["text"]
        .as_str()
        .unwrap()
        .contains("approval did not authorize"));
    if nested {
        let plans = native
            .list_plan_executions(PlanExecutionFilter {
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(plans.len(), 3);
        assert!(plans.iter().all(|p| p.status.is_terminal()));
        assert!(outputs.iter().any(|e| e
            .payload
            .get("text")
            .and_then(|v| v.as_str())
            .is_some_and(|s| s.contains("approved-fixture"))));
    }
}
