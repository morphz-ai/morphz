//! Actual Runtime, permission broker, SQLite Jobs, Session IO and Objective
//! continuations against delayed loopback hosts. Model decisions are scripted;
//! no business service, provider credentials or paid model calls are used.
use morphz::{
    config::AppConfig,
    host_tools,
    llm::{Client, Message, Response, ToolCallRepr, ToolDefinition},
    memory::{
        sqlite::SqliteStore, ExecutionJobFilter, ExecutionJobStatus, ExecutionJobStore,
        ExecutionRetrySafety, NewObjective, NewSession, ObjectiveStatus, QueryFilter,
        SessionMountKind, ThreadLifecycle,
    },
    permission::PermissionMode,
    runtime::{MorphzRuntime, RuntimeToolPolicy},
    session_io::{Limits, Request},
};
use serde_json::{json, Value};
use std::{
    error::Error,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

type DynError = Box<dyn Error + Send + Sync>;
const TOOL: &str = "host_deadline_test";
const SESSION: &str = "deadline-session";
const OBJECTIVE: &str = "deadline-objective";
const CALL: &str = "deadline-call";
const ANSWER: &str = "Host deadline outcome verified.";

struct Model {
    calls: AtomicUsize,
    objective: bool,
    success: bool,
}

#[async_trait::async_trait]
impl Client for Model {
    fn supports_async_cancellation(&self) -> bool {
        true
    }
    fn model(&self) -> Option<String> {
        Some("deadline-fixture".into())
    }
    async fn create_completion(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
    ) -> Result<Response, DynError> {
        let index = self.calls.fetch_add(1, Ordering::SeqCst);
        assert!(
            index < if self.objective { 3 } else { 2 },
            "unexpected repair or replay request"
        );
        if index == 0 {
            let definition = tools.iter().find(|t| t.name == TOOL).unwrap();
            assert!(definition
                .parameters
                .get("transport_timeout_secs")
                .is_none());
            return Ok(Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: CALL.into(),
                    r#type: "function".into(),
                    func_name: TOOL.into(),
                    // Even a supplied business argument cannot override Host policy.
                    arguments: json!({"transport_timeout_secs":300}).to_string(),
                }],
            });
        }
        if index == 1 {
            let receipt = messages
                .iter()
                .find(|m| m.role == "tool" && m.tool_call_id.as_deref() == Some(CALL))
                .unwrap();
            let receipt: Value = serde_json::from_str(&receipt.content)?;
            assert_eq!(
                receipt["status"],
                if self.success { "success" } else { "error" }
            );
            if !self.success {
                assert!(receipt.to_string().contains("unknown"));
            }
            if self.objective {
                let marker = format!("(objective (id {OBJECTIVE})");
                let revision = messages
                    .iter()
                    .find_map(|m| {
                        let suffix = &m.content[m.content.find(&marker)?..];
                        let suffix = &suffix[suffix.find("(revision ")? + "(revision ".len()..];
                        suffix
                            .chars()
                            .take_while(char::is_ascii_digit)
                            .collect::<String>()
                            .parse::<u64>()
                            .ok()
                    })
                    .expect("the actual Objective revision must be present");
                return Ok(Response { content: String::new(), tool_calls: vec![ToolCallRepr {
                    id: "complete-deadline-objective".into(), r#type: "function".into(), func_name: "objective_update".into(),
                    arguments: json!({"objective_id":OBJECTIVE,"base_revision":revision,"status":"completed",
                        "reason":"The synthetic Host transport outcome was verified.","evidence_refs":[]}).to_string(),
                }] });
            }
        }
        Ok(Response {
            content: ANSWER.into(),
            tool_calls: vec![],
        })
    }
}

#[derive(Clone, Copy)]
enum Transport {
    Http,
    HttpBody,
    #[cfg(unix)]
    Ipc,
}

struct Host {
    endpoint: String,
    ipc: Option<String>,
    seen: Arc<Mutex<Vec<Value>>>,
    task: tokio::task::JoinHandle<()>,
    _socket_directory: Option<tempfile::TempDir>,
}
impl Drop for Host {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn host(transport: Transport, delay: Duration) -> Host {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let observed = seen.clone();
    #[cfg(unix)]
    if matches!(transport, Transport::Ipc) {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::Builder::new()
            .prefix("mz-deadline-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = std::fs::canonicalize(directory.path()).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = root.join("host.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let length = socket.read_u32().await.unwrap() as usize;
                assert!(length < 64 * 1024);
                let mut bytes = vec![0; length];
                socket.read_exact(&mut bytes).await.unwrap();
                let envelope: Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(
                    envelope["token"],
                    "synthetic-host-deadline-token-not-a-real-credential"
                );
                observed.lock().unwrap().push(envelope["request"].clone());
                tokio::time::sleep(delay).await;
                let response = br#"{"protocol":1,"ok":true,"value":{"receipt":"saved-once"}}"#;
                if socket.write_u32(response.len() as u32).await.is_ok() {
                    let _ = socket.write_all(response).await;
                    let _ = socket.shutdown().await;
                }
            }
        });
        return Host {
            endpoint: String::new(),
            ipc: Some(path.to_string_lossy().into_owned()),
            seen,
            task,
            _socket_directory: Some(directory),
        };
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/tool", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 2048];
            loop {
                let count = socket.read(&mut buffer).await.unwrap();
                assert_ne!(count, 0);
                bytes.extend_from_slice(&buffer[..count]);
                assert!(bytes.len() < 64 * 1024);
                if let Some(index) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..index]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|n| n.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    if bytes.len() >= index + 4 + length {
                        assert!(headers.to_ascii_lowercase().contains("authorization: bearer synthetic-host-deadline-token-not-a-real-credential"));
                        observed.lock().unwrap().push(
                            serde_json::from_slice(&bytes[index + 4..index + 4 + length]).unwrap(),
                        );
                        break;
                    }
                }
            }
            let body = br#"{"receipt":"saved-once"}"#;
            let headers=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len());
            if matches!(transport, Transport::HttpBody)
                && socket.write_all(headers.as_bytes()).await.is_err()
            {
                continue;
            }
            tokio::time::sleep(delay).await;
            if matches!(transport, Transport::Http)
                && socket.write_all(headers.as_bytes()).await.is_err()
            {
                continue;
            }
            let _ = socket.write_all(body).await;
            let _ = socket.shutdown().await;
        }
    });
    Host {
        endpoint,
        ipc: None,
        seen,
        task,
        _socket_directory: None,
    }
}

async fn run_case(
    transport: Transport,
    timeout: Option<u64>,
    delay: u64,
    success: bool,
    objective: bool,
) {
    let directory = tempfile::tempdir().unwrap();
    let server = host(transport, Duration::from_secs(delay)).await;
    let mut registration = json!({"endpoint":server.endpoint,"token":"synthetic-host-deadline-token-not-a-real-credential",
        "context_ids":["context-default"],"definition":{"name":TOOL,"description":"Synthetic delayed Host tool", "parameters":{"type":"object"}}});
    if let Some(ipc) = &server.ipc {
        registration["ipc_path"] = json!(ipc);
    }
    if let Some(timeout) = timeout {
        registration["transport_timeout_secs"] = json!(timeout);
    }
    let manifest = directory.path().join("host.json");
    std::fs::write(
        &manifest,
        serde_json::to_vec(&json!({"protocol":1,"tools":[registration]})).unwrap(),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&manifest, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let tool = host_tools::load(&manifest).unwrap().pop().unwrap();
    assert_eq!(
        tool.retry_safety_for_arguments("{}"),
        ExecutionRetrySafety::AtMostOnce
    );
    let client = Arc::new(Model {
        calls: AtomicUsize::new(0),
        success,
        objective,
    });
    let mut config = AppConfig::default();
    config.llm.model = "deadline-fixture".into();
    config.permissions.mode = PermissionMode::FullAccess;
    config.permissions.workspace_root = directory.path().to_string_lossy().into_owned();
    config.background_task.artifact_dir = directory
        .path()
        .join("artifacts")
        .to_string_lossy()
        .into_owned();
    // A longer outer Job budget must not mask the per-Host transport deadline.
    config.orchestrator.tool_timeout_secs = 40;
    let database = directory.path().join("runtime.sqlite");
    let runtime = MorphzRuntime::builder(config, client.clone())
        .database_path(database.to_string_lossy())
        .tool_policy(RuntimeToolPolicy {
            context_only: false,
            coding_eval: false,
        })
        .extra_tool(tool)
        .build()
        .await
        .unwrap();
    runtime.start().await.unwrap();
    let session = runtime
        .ensure_session(NewSession {
            id: SESSION.into(),
            agent_id: runtime.identity().agent_id.clone(),
            context_id: runtime.identity().context_id.clone(),
            parent_session_id: None,
            title: "Host transport deadline regression".into(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    let mut replies = runtime.subscribe("chat/reply", 8);
    let started = Instant::now();
    if objective {
        runtime
            .create_objective(NewObjective {
                id: OBJECTIVE.into(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                coordinator_session_id: SESSION.into(),
                delivery_session_id: SESSION.into(),
                parent_objective_id: None,
                source_event_id: "synthetic-deadline-source".into(),
                initiating_principal_id: Some(runtime.identity().principal_id.clone()),
                stated_objective: "Verify one delayed synthetic Host call without replay.".into(),
                model_alias: None,
                reasoning_effort: None,
                token_budget: None,
            })
            .await
            .unwrap();
    } else {
        let input=Request::parse(json!({"io_version":"1","client_message_id":"deadline-input","message":{"format":{"id":"morphz.chat","version":"1"},"content":{"encoding":"json","value":{"text":"Call the synthetic Host once and report its actual outcome."}}}}).to_string().as_bytes(),&Limits::default()).unwrap();
        session
            .send_io_as_principal(input, &runtime.identity().principal_id)
            .await
            .unwrap();
    }
    let reply = tokio::time::timeout(Duration::from_secs(45), replies.recv())
        .await
        .expect("Host result must reach the normal continuation")
        .unwrap();
    assert_eq!(reply.payload["text"], ANSWER);
    assert_eq!(
        client.calls.load(Ordering::SeqCst),
        if objective { 3 } else { 2 }
    );
    let elapsed = started.elapsed();
    assert!(
        elapsed
            >= Duration::from_secs(if success {
                delay
            } else {
                timeout.unwrap_or(20)
            })
    );
    let jobs = runtime
        .list_execution_jobs(ExecutionJobFilter {
            session_id: Some(SESSION.into()),
            include_terminal: true,
            ..Default::default()
        })
        .await
        .unwrap();
    let jobs = jobs
        .iter()
        .filter(|j| j.tool_name == TOOL)
        .collect::<Vec<_>>();
    assert_eq!(
        jobs.len(),
        1,
        "one physical Host attempt, never an automatic retry"
    );
    let job = jobs[0];
    assert_eq!(
        job.status,
        if success {
            ExecutionJobStatus::Succeeded
        } else {
            ExecutionJobStatus::Failed
        }
    );
    assert_eq!(job.retry_safety, ExecutionRetrySafety::AtMostOnce);
    assert_eq!(job.tool_call_id, CALL);
    if success {
        assert!(job.error.is_none());
    } else {
        assert!(job.error.as_deref().unwrap().contains("unknown"));
    }
    let outputs = runtime
        .query_events(QueryFilter {
            session_id: Some(SESSION.into()),
            topic: Some("chat/tool_output".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    let output = outputs
        .iter()
        .find(|e| Some(e.id.as_str()) == job.result_event_id.as_deref())
        .unwrap();
    assert_eq!(
        output.payload["tool_status"],
        if success { "success" } else { "error" }
    );
    let requests = server.seen.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["invocation"]["job_id"], job.id);
    assert_eq!(requests[0]["invocation"]["thread_id"], job.thread_id);
    assert_eq!(requests[0]["invocation"]["session_id"], SESSION);
    assert_eq!(
        requests[0]["invocation"]["context_id"],
        runtime.identity().context_id
    );
    assert_eq!(
        requests[0]["invocation"]["principal_id"],
        runtime.identity().principal_id
    );
    assert_eq!(requests[0]["arguments"]["transport_timeout_secs"], 300);
    let store = SqliteStore::new(database.to_str().unwrap()).await.unwrap();
    assert_eq!(
        store.get_execution_job(&job.id).await.unwrap(),
        Some(job.clone())
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let done = if objective {
                runtime
                    .get_objective(OBJECTIVE)
                    .await
                    .unwrap()
                    .is_some_and(|o| {
                        o.status == ObjectiveStatus::Completed && o.active_evaluation_id.is_none()
                    })
            } else {
                runtime
                    .session_thread_by_root(
                        SESSION,
                        reply.payload["root_turn_id"].as_str().unwrap(),
                    )
                    .await
                    .unwrap()
                    .is_some_and(|t| t.lifecycle == ThreadLifecycle::Completed)
            };
            if done {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("actual Session or Objective must reach its durable terminal state");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        client.calls.load(Ordering::SeqCst),
        if objective { 3 } else { 2 }
    );
    assert_eq!(server.seen.lock().unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn omitted_host_deadline_still_times_out_at_twenty_seconds_without_retry() {
    run_case(Transport::Http, None, 21, false, false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn configured_http_objective_accepts_a_response_after_twenty_seconds() {
    run_case(Transport::Http, Some(25), 21, true, true).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn configured_http_receives_delayed_body_after_twenty_seconds() {
    run_case(Transport::HttpBody, Some(25), 21, true, false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http_timeout_is_unknown_and_does_not_retry_or_follow_model_override() {
    run_case(Transport::Http, Some(1), 2, false, false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http_body_timeout_is_unknown_and_does_not_retry() {
    run_case(Transport::HttpBody, Some(1), 2, false, false).await;
}
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn configured_ipc_objective_accepts_a_response_after_twenty_seconds() {
    run_case(Transport::Ipc, Some(25), 21, true, true).await;
}
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ipc_timeout_is_unknown_and_does_not_retry_or_follow_model_override() {
    run_case(Transport::Ipc, Some(1), 2, false, false).await;
}
