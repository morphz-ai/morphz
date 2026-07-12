use morphz::config::ToolSecurityConfig;
use morphz::context_tools::ContextTxTool;
use morphz::event::{
    Event, InMemoryEventBus, TYPE_FILE_CHANGE, TYPE_TOOL_OUTPUT, TYPE_USER_MESSAGE,
};
use morphz::llm::{Client, Message, Response, ToolCallRepr, ToolDefinition};
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{EventStore, QueryFilter};
use morphz::orchestrator::context::ContextEngine;
use morphz::orchestrator::orchestrator::Orchestrator;
use morphz::tool::{EditFileTool, ReadFileTool, Registry, SpawnAgentTool, Tool, WriteFileTool};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tempfile::{NamedTempFile, TempDir};

struct MockClient {
    responses: Mutex<VecDeque<Response>>,
    tools_seen: Mutex<Vec<Vec<String>>>,
}

struct ConcurrencyProbeClient {
    active: AtomicUsize,
    max_active: AtomicUsize,
    calls: AtomicUsize,
}

struct BudgetProbeClient {
    calls: AtomicUsize,
    tool_counts: Mutex<Vec<usize>>,
    read_path: String,
}

struct FailingClient;

struct HangingClient;

struct BlockingClient;

#[async_trait::async_trait]
impl Client for FailingClient {
    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        Err("simulated LLM transport timeout".into())
    }

    async fn create_embedding(
        &self,
        _text: &str,
    ) -> Result<Vec<f32>, Box<dyn std::error::Error + Send + Sync>> {
        Ok(Vec::new())
    }
}

#[async_trait::async_trait]
impl Client for HangingClient {
    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        unreachable!("orchestrator deadline must cancel the hanging client")
    }

    async fn create_embedding(
        &self,
        _text: &str,
    ) -> Result<Vec<f32>, Box<dyn std::error::Error + Send + Sync>> {
        Ok(Vec::new())
    }
}

#[async_trait::async_trait]
impl Client for BlockingClient {
    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        std::thread::sleep(std::time::Duration::from_secs(10));
        unreachable!("isolated blocking client must not hold the caller task")
    }

    async fn create_embedding(
        &self,
        _text: &str,
    ) -> Result<Vec<f32>, Box<dyn std::error::Error + Send + Sync>> {
        Ok(Vec::new())
    }
}

#[async_trait::async_trait]
impl Client for BudgetProbeClient {
    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        self.tool_counts
            .lock()
            .map_err(|_| "budget probe mutex poisoned")?
            .push(tools.len());
        if tools.is_empty() {
            return Ok(Response {
                content: "budget forced final".to_string(),
                tool_calls: Vec::new(),
            });
        }
        Ok(Response {
            content: String::new(),
            tool_calls: vec![ToolCallRepr {
                id: format!("read-{call}"),
                r#type: "function".to_string(),
                func_name: "read".to_string(),
                arguments: json!({ "path": self.read_path }).to_string(),
            }],
        })
    }

    async fn create_embedding(
        &self,
        _text: &str,
    ) -> Result<Vec<f32>, Box<dyn std::error::Error + Send + Sync>> {
        Ok(Vec::new())
    }
}

#[async_trait::async_trait]
impl Client for ConcurrencyProbeClient {
    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_active.fetch_max(active, Ordering::SeqCst);
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
        self.active.fetch_sub(1, Ordering::SeqCst);
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        Ok(Response {
            content: format!("reply-{}", call),
            tool_calls: Vec::new(),
        })
    }

    async fn create_embedding(
        &self,
        _text: &str,
    ) -> Result<Vec<f32>, Box<dyn std::error::Error + Send + Sync>> {
        Ok(Vec::new())
    }
}

impl MockClient {
    fn new(responses: Vec<Response>) -> Self {
        Self {
            responses: Mutex::new(VecDeque::from(responses)),
            tools_seen: Mutex::new(Vec::new()),
        }
    }

    fn tools_seen(&self) -> Vec<Vec<String>> {
        self.tools_seen.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl Client for MockClient {
    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        self.tools_seen
            .lock()
            .map_err(|_| "mock tools mutex poisoned")?
            .push(tools.into_iter().map(|tool| tool.name).collect());
        self.responses
            .lock()
            .map_err(|_| "mock response mutex poisoned")?
            .pop_front()
            .ok_or_else(|| "mock response queue exhausted".into())
    }

    async fn create_embedding(
        &self,
        _text: &str,
    ) -> Result<Vec<f32>, Box<dyn std::error::Error + Send + Sync>> {
        Ok(Vec::new())
    }
}

async fn build_orchestrator(
    responses: Vec<Response>,
) -> (
    Arc<InMemoryEventBus>,
    Arc<SqliteStore>,
    Arc<Orchestrator>,
    TempDir,
) {
    let (bus, store, orchestrator, _client, tmp) =
        build_orchestrator_with_config(responses, morphz::config::OrchestratorConfig::default())
            .await;
    (bus, store, orchestrator, tmp)
}

async fn build_orchestrator_with_config(
    responses: Vec<Response>,
    orchestrator_config: morphz::config::OrchestratorConfig,
) -> (
    Arc<InMemoryEventBus>,
    Arc<SqliteStore>,
    Arc<Orchestrator>,
    Arc<MockClient>,
    TempDir,
) {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("attempt_loop.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    let client = Arc::new(MockClient::new(responses));
    let context_engine = Arc::new(ContextEngine::new(
        Arc::clone(&store) as Arc<dyn EventStore>,
        orchestrator_config.clone(),
    ));

    let registry = Arc::new(Registry::new());
    registry.register(Arc::new(ReadFileTool::default()));
    registry.register(Arc::new(WriteFileTool::default()));
    registry.register(Arc::new(ContextTxTool::new(Arc::clone(&context_engine))));

    let orchestrator = Arc::new(Orchestrator::new_with_context_engine(
        Arc::clone(&bus),
        Arc::clone(&store) as Arc<dyn EventStore>,
        Arc::clone(&client) as Arc<dyn Client>,
        registry,
        orchestrator_config,
        context_engine,
    ));
    orchestrator.clone().start().await.unwrap();
    (bus, store, orchestrator, client, tmp)
}

async fn publish_user(bus: &Arc<InMemoryEventBus>, session_id: &str, text: &str) {
    let mut payload = serde_json::Map::new();
    payload.insert("session_id".to_string(), json!(session_id));
    payload.insert("text".to_string(), json!(text));
    let ev = Event::new(
        format!(
            "test_user_{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ),
        "Test-User".to_string(),
        TYPE_USER_MESSAGE.to_string(),
        "chat/user_message".to_string(),
        payload,
    );
    bus.publish(ev).await.unwrap();
}

async fn publish_tool_output(bus: &Arc<InMemoryEventBus>, session_id: &str, id: &str) {
    let event = Event::new(
        id.to_string(),
        "Test-Tool".to_string(),
        TYPE_TOOL_OUTPUT.to_string(),
        "chat/tool_output".to_string(),
        vec![
            ("session_id".to_string(), json!(session_id)),
            ("tool_name".to_string(), json!("test")),
            ("text".to_string(), json!(id)),
        ]
        .into_iter()
        .collect(),
    );
    bus.publish(event).await.unwrap();
}

async fn wait_for_topic(store: &Arc<SqliteStore>, topic: &str, session_id: &str) -> Vec<Event> {
    for _ in 0..80 {
        let events = store
            .query(QueryFilter {
                session_id: Some(session_id.to_string()),
                topic: Some(topic.to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        let matched: Vec<Event> = events;
        if !matched.is_empty() {
            return matched;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    }
    Vec::new()
}

#[tokio::test]
async fn test_attempt_loop_no_tool_final_reply() {
    let session_id = "attempt_no_tool";
    let (bus, store, _orc, _tmp) = build_orchestrator(vec![Response {
        content: "hello user".to_string(),
        tool_calls: Vec::new(),
    }])
    .await;

    publish_user(&bus, session_id, "hello").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;

    assert_eq!(replies.len(), 1);
    assert_eq!(
        replies[0].payload.get("text").and_then(|v| v.as_str()),
        Some("hello user")
    );
}

#[tokio::test]
async fn test_llm_failure_is_audited_and_always_replies_to_user() {
    let session_id = "attempt_llm_failure";
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("llm-failure.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    let config = morphz::config::OrchestratorConfig::default();
    let engine = Arc::new(ContextEngine::new(
        Arc::clone(&store) as Arc<dyn EventStore>,
        config.clone(),
    ));
    let orchestrator = Arc::new(Orchestrator::new_with_context_engine(
        Arc::clone(&bus),
        Arc::clone(&store) as Arc<dyn EventStore>,
        Arc::new(FailingClient) as Arc<dyn Client>,
        Arc::new(Registry::new()),
        config,
        engine,
    ));
    orchestrator.start().await.unwrap();

    publish_user(&bus, session_id, "do work").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    let failures = wait_for_topic(&store, "chat/runtime_error", session_id).await;

    assert_eq!(replies.len(), 1);
    assert!(replies[0]
        .payload
        .get("text")
        .and_then(|value| value.as_str())
        .unwrap()
        .contains("模型请求在重试后仍然失败"));
    assert_eq!(failures.len(), 1);
    assert_eq!(
        failures[0]
            .payload
            .get("stage")
            .and_then(|value| value.as_str()),
        Some("llm_completion")
    );
    assert!(failures[0]
        .payload
        .get("error")
        .and_then(|value| value.as_str())
        .unwrap()
        .contains("simulated LLM transport timeout"));
}

#[tokio::test]
async fn test_orchestrator_deadline_cancels_hanging_client_and_replies() {
    let session_id = "attempt_llm_deadline";
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("llm-deadline.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    let config = morphz::config::OrchestratorConfig {
        model_attempt_timeout_secs: 1,
        ..Default::default()
    };
    let engine = Arc::new(ContextEngine::new(
        Arc::clone(&store) as Arc<dyn EventStore>,
        config.clone(),
    ));
    let orchestrator = Arc::new(Orchestrator::new_with_context_engine(
        Arc::clone(&bus),
        Arc::clone(&store) as Arc<dyn EventStore>,
        Arc::new(HangingClient) as Arc<dyn Client>,
        Arc::new(Registry::new()),
        config,
        engine,
    ));
    orchestrator.start().await.unwrap();

    let started = std::time::Instant::now();
    publish_user(&bus, session_id, "do work").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    let failures = wait_for_topic(&store, "chat/runtime_error", session_id).await;
    let starts = wait_for_topic(&store, "runtime/model_attempt_started", session_id).await;

    assert!(started.elapsed() < std::time::Duration::from_secs(3));
    assert_eq!(replies.len(), 1);
    assert_eq!(failures.len(), 1);
    assert_eq!(starts.len(), 1);
    assert_eq!(
        starts[0]
            .payload
            .get("deadline_secs")
            .and_then(|value| value.as_u64()),
        Some(1)
    );
    assert!(failures[0]
        .payload
        .get("error")
        .and_then(|value| value.as_str())
        .unwrap()
        .contains("deadline has elapsed"));
}

#[tokio::test]
async fn test_orchestrator_deadline_covers_waiting_for_concurrency_permit() {
    let session_id = "attempt_permit_deadline";
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("permit-deadline.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    let client = Arc::new(MockClient::new(vec![Response {
        content: "must not be called".to_string(),
        tool_calls: Vec::new(),
    }]));
    let config = morphz::config::OrchestratorConfig {
        concurrency_limit: 1,
        model_attempt_timeout_secs: 1,
        ..Default::default()
    };
    let engine = Arc::new(ContextEngine::new(
        Arc::clone(&store) as Arc<dyn EventStore>,
        config.clone(),
    ));
    let orchestrator = Arc::new(Orchestrator::new_with_context_engine(
        Arc::clone(&bus),
        Arc::clone(&store) as Arc<dyn EventStore>,
        Arc::clone(&client) as Arc<dyn Client>,
        Arc::new(Registry::new()),
        config,
        engine,
    ));
    orchestrator.clone().start().await.unwrap();
    let held_permit = orchestrator
        .concurrency_semaphore
        .clone()
        .acquire_owned()
        .await
        .unwrap();

    publish_user(&bus, session_id, "do work").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    let failures = wait_for_topic(&store, "chat/runtime_error", session_id).await;

    assert_eq!(replies.len(), 1);
    assert_eq!(failures.len(), 1);
    assert!(client.tools_seen().is_empty());
    drop(held_permit);
}

#[tokio::test]
async fn test_orchestrator_deadline_isolates_synchronously_blocking_client() {
    let session_id = "attempt_blocking_client";
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("blocking-client.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    let config = morphz::config::OrchestratorConfig {
        model_attempt_timeout_secs: 1,
        ..Default::default()
    };
    let engine = Arc::new(ContextEngine::new(
        Arc::clone(&store) as Arc<dyn EventStore>,
        config.clone(),
    ));
    let orchestrator = Arc::new(Orchestrator::new_with_context_engine(
        Arc::clone(&bus),
        Arc::clone(&store) as Arc<dyn EventStore>,
        Arc::new(BlockingClient) as Arc<dyn Client>,
        Arc::new(Registry::new()),
        config,
        engine,
    ));
    orchestrator.start().await.unwrap();

    let started = std::time::Instant::now();
    publish_user(&bus, session_id, "do work").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    let failures = wait_for_topic(&store, "chat/runtime_error", session_id).await;

    assert!(started.elapsed() < std::time::Duration::from_secs(3));
    assert_eq!(replies.len(), 1);
    assert_eq!(failures.len(), 1);
    assert_eq!(
        failures[0]
            .payload
            .get("stage")
            .and_then(|value| value.as_str()),
        Some("llm_completion")
    );
}

#[tokio::test]
async fn test_compiled_context_uses_kernel_mind_inbox_without_legacy_schema() {
    let session_id = "attempt_context_shape";
    let (bus, store, _orc, _tmp) = build_orchestrator(vec![Response {
        content: "shape checked".to_string(),
        tool_calls: Vec::new(),
    }])
    .await;

    publish_user(&bus, session_id, "inspect context").await;
    let inspections = wait_for_topic(&store, "chat/context_inspect", session_id).await;
    assert_eq!(inspections.len(), 1);
    let payload = &inspections[0].payload;
    let rendered = payload
        .get("text")
        .and_then(|value| value.as_str())
        .unwrap();
    assert!(rendered.contains("(kernel"));
    assert!(rendered.contains("(protocol"));
    assert!(rendered.contains("(response-contract"));
    assert!(rendered.contains("(context-tx-contract"));
    assert!(rendered.contains("(wake (cause user-message)"));
    assert!(rendered.contains("(mind"));
    assert!(rendered.contains("(inbox"));
    assert!(!rendered.contains("todo_stack"));
    assert!(!rendered.contains("(facts"));
    assert!(payload.get("mind").is_some());
    assert!(payload.get("inbox").is_some());
    assert!(payload.get("pressure").is_some());
    assert_eq!(
        payload
            .get("model_attempt_timeout_secs")
            .and_then(|value| value.as_u64()),
        Some(180)
    );
    let messages = serde_json::to_string(payload.get("messages").unwrap()).unwrap();
    assert!(messages.contains("相互独立的文件读取必须在同一响应中并行调用"));
    assert!(messages.contains("sha256 未被 file_change 改变的内容不得重复 read"));
    assert_eq!(
        payload
            .get("wake")
            .and_then(|wake| wake.get("cause"))
            .and_then(|cause| cause.as_str()),
        Some("user-message")
    );
}

#[tokio::test]
async fn test_attempt_loop_tool_call_then_reply() {
    let session_id = "attempt_tool_then_reply";
    let note = NamedTempFile::new().unwrap();
    std::fs::write(note.path(), "hello from note").unwrap();

    let (bus, store, _orc, _tmp) = build_orchestrator(vec![
        Response {
            content: "".to_string(),
            tool_calls: vec![ToolCallRepr {
                id: "call_read".to_string(),
                r#type: "function".to_string(),
                func_name: "read".to_string(),
                arguments: json!({ "path": note.path().to_string_lossy() }).to_string(),
            }],
        },
        Response {
            content: "已读取 notes".to_string(),
            tool_calls: Vec::new(),
        },
    ])
    .await;

    publish_user(&bus, session_id, "read note").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    let assistant_calls = wait_for_topic(&store, "chat/assistant_call", session_id).await;
    let tool_outputs = wait_for_topic(&store, "chat/tool_output", session_id).await;

    assert_eq!(replies.len(), 1);
    assert!(!assistant_calls.is_empty());
    assert!(!tool_outputs.is_empty());
    assert_eq!(
        replies[0].payload.get("text").and_then(|v| v.as_str()),
        Some("已读取 notes")
    );
}

#[tokio::test]
async fn test_attempt_loop_context_tx_failure_does_not_corrupt_mind() {
    let session_id = "attempt_context_tx_failure";
    let (bus, store, orc, _tmp) = build_orchestrator(vec![
        Response {
            content: "".to_string(),
            tool_calls: vec![ToolCallRepr {
                id: "call_context_tx".to_string(),
                r#type: "function".to_string(),
                func_name: "context_tx".to_string(),
                arguments: json!({
                    "session_id": session_id,
                    "transaction": "(context-tx (base-version 0) (create objective (goal \"A\")) (retire missing-id))"
                }).to_string(),
            }],
        },
        Response {
            content: "仍可继续".to_string(),
            tool_calls: Vec::new(),
        },
    ]).await;

    publish_user(&bus, session_id, "try invalid context transaction").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    assert_eq!(replies.len(), 1);

    let context = orc.get_current_context_view(session_id).await.unwrap();
    assert_eq!(context.state.version, 0);
    assert!(context.state.frames.is_empty());
}

#[tokio::test]
async fn test_reply_with_context_sidecar_commits_and_does_not_wake_again() {
    let session_id = "attempt_context_sidecar_reply";
    let (bus, store, orchestrator, client, _tmp) = build_orchestrator_with_config(
        vec![Response {
            content: "任务完成，Context 已在后台收口".to_string(),
            tool_calls: vec![ToolCallRepr {
                id: "context-sidecar".to_string(),
                r#type: "function".to_string(),
                func_name: "context_tx".to_string(),
                arguments: json!({
                    "session_id": session_id,
                    "transaction": "(context-tx (base-version 0) (reason \"sidecar 收口\") (create result (result (status completed))) (protect result))"
                })
                .to_string(),
            }],
        }],
        morphz::config::OrchestratorConfig::default(),
    )
    .await;

    publish_user(&bus, session_id, "finish with sidecar").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    assert_eq!(replies.len(), 1);
    assert_eq!(
        replies[0]
            .payload
            .get("text")
            .and_then(|value| value.as_str()),
        Some("任务完成，Context 已在后台收口")
    );
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    assert_eq!(client.tools_seen().len(), 1);
    assert_eq!(
        wait_for_topic(&store, "chat/tool_output", session_id)
            .await
            .len(),
        1
    );
    let context = orchestrator
        .get_current_context_view(session_id)
        .await
        .unwrap();
    assert_eq!(context.state.version, 1);
    assert!(context.state.protected.contains("result"));
}

#[tokio::test]
async fn test_context_only_call_commits_then_cooldown_forces_user_response() {
    let session_id = "attempt_context_cooldown_reply";
    let (bus, store, orchestrator, client, _tmp) = build_orchestrator_with_config(
        vec![
            Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: "context-only".to_string(),
                    r#type: "function".to_string(),
                    func_name: "context_tx".to_string(),
                    arguments: json!({
                        "session_id": session_id,
                        "transaction": "(context-tx (base-version 0) (create state (state active)))"
                    })
                    .to_string(),
                }],
            },
            Response {
                content: "维护完成后回复用户".to_string(),
                tool_calls: Vec::new(),
            },
        ],
        morphz::config::OrchestratorConfig::default(),
    )
    .await;

    publish_user(&bus, session_id, "maintain then answer").await;
    assert_eq!(
        wait_for_topic(&store, "chat/reply", session_id).await.len(),
        1
    );
    let tools_seen = client.tools_seen();
    assert_eq!(tools_seen.len(), 2);
    assert!(tools_seen[0].contains(&"context_tx".to_string()));
    assert!(!tools_seen[1].contains(&"context_tx".to_string()));
    let outputs = wait_for_topic(&store, "chat/tool_output", session_id).await;
    assert_eq!(outputs.len(), 1);
    assert_eq!(
        orchestrator
            .get_current_context_view(session_id)
            .await
            .unwrap()
            .state
            .version,
        1
    );
}

#[tokio::test]
async fn test_failed_context_only_call_keeps_context_tool_for_repair() {
    let session_id = "attempt_context_failure_repair";
    let (bus, store, orchestrator, client, _tmp) = build_orchestrator_with_config(
        vec![
            Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: "invalid-context".to_string(),
                    r#type: "function".to_string(),
                    func_name: "context_tx".to_string(),
                    arguments: json!({
                        "session_id": session_id,
                        "transaction": "(context-tx (base-version 0) (retire missing))"
                    })
                    .to_string(),
                }],
            },
            Response {
                content: "修复后完成".to_string(),
                tool_calls: vec![ToolCallRepr {
                    id: "repaired-context".to_string(),
                    r#type: "function".to_string(),
                    func_name: "context_tx".to_string(),
                    arguments: json!({
                        "session_id": session_id,
                        "transaction": "(context-tx (base-version 0) (create repaired (status completed)))"
                    })
                    .to_string(),
                }],
            },
        ],
        morphz::config::OrchestratorConfig::default(),
    )
    .await;

    publish_user(&bus, session_id, "repair failed transaction").await;
    assert_eq!(
        wait_for_topic(&store, "chat/reply", session_id).await.len(),
        1
    );
    let tools_seen = client.tools_seen();
    assert_eq!(tools_seen.len(), 2);
    assert!(tools_seen[1].contains(&"context_tx".to_string()));
    let context = orchestrator
        .get_current_context_view(session_id)
        .await
        .unwrap();
    assert_eq!(context.state.version, 1);
    assert_eq!(context.state.frames[0].id, "repaired");
}

#[tokio::test]
async fn test_critical_transaction_that_relieves_pressure_cools_down_next_attempt() {
    let session_id = "attempt_context_critical_then_cooldown";
    let config = morphz::config::OrchestratorConfig {
        context_soft_token_limit: 1_200,
        context_hard_token_limit: 1_600,
        context_maintenance_reserve_tokens: 300,
        ..Default::default()
    };
    let (bus, store, _orchestrator, client, _tmp) = build_orchestrator_with_config(
        vec![
            Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: "critical-release".to_string(),
                    r#type: "function".to_string(),
                    func_name: "context_tx".to_string(),
                    arguments: json!({
                        "session_id": session_id,
                        "transaction": "(context-tx (base-version 0) (reason \"释放 critical 压力\") (retire critical-seed))"
                    })
                    .to_string(),
                }],
            },
            Response {
                content: "压力解除后直接回复".to_string(),
                tool_calls: Vec::new(),
            },
        ],
        config,
    )
    .await;
    store
        .append(Event::new(
            "critical-seed".to_string(),
            "Synthetic".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            vec![
                ("session_id".to_string(), json!(session_id)),
                ("tool_name".to_string(), json!("synthetic")),
                (
                    "text".to_string(),
                    json!("需要在压力解除后退休的一次性中文过程数据。".repeat(20)),
                ),
            ]
            .into_iter()
            .collect(),
        ))
        .await
        .unwrap();

    publish_user(&bus, session_id, "relieve critical pressure").await;
    assert_eq!(
        wait_for_topic(&store, "chat/reply", session_id).await.len(),
        1
    );
    let tools_seen = client.tools_seen();
    assert_eq!(tools_seen.len(), 2);
    assert_eq!(tools_seen[0], vec!["context_tx"]);
    assert!(!tools_seen[1].contains(&"context_tx".to_string()));
}

#[tokio::test]
async fn test_critical_pressure_does_not_cool_down_context_tool() {
    let session_id = "attempt_context_critical_no_cooldown";
    let config = morphz::config::OrchestratorConfig {
        context_soft_token_limit: 100,
        context_hard_token_limit: 200,
        context_maintenance_reserve_tokens: 20,
        ..Default::default()
    };
    let (bus, store, _orchestrator, client, _tmp) = build_orchestrator_with_config(
        vec![
            Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: "critical-context".to_string(),
                    r#type: "function".to_string(),
                    func_name: "context_tx".to_string(),
                    arguments: json!({
                        "session_id": session_id,
                        "transaction": "(context-tx (base-version 0) (create checkpoint (status partial)))"
                    })
                    .to_string(),
                }],
            },
            Response {
                content: "仍处于 critical，可以继续维护".to_string(),
                tool_calls: Vec::new(),
            },
        ],
        config,
    )
    .await;

    publish_user(&bus, session_id, "critical maintenance").await;
    assert_eq!(
        wait_for_topic(&store, "chat/reply", session_id).await.len(),
        1
    );
    let tools_seen = client.tools_seen();
    assert_eq!(tools_seen.len(), 2);
    assert_eq!(tools_seen[0], vec!["context_tx"]);
    assert_eq!(tools_seen[1], vec!["context_tx"]);
}

#[tokio::test]
async fn test_identical_context_transactions_are_normalized_and_deduplicated() {
    let session_id = "attempt_duplicate_context_tx";
    let transaction = |id: &str| ToolCallRepr {
        id: id.to_string(),
        r#type: "function".to_string(),
        func_name: "context_tx".to_string(),
        arguments: json!({
            "session_id": session_id,
            "transaction": "(context-tx (base-version 0) (create first (status active)))"
        })
        .to_string(),
    };
    let (bus, store, orchestrator, _tmp) = build_orchestrator(vec![Response {
        content: "只执行一个 Context transaction".to_string(),
        tool_calls: vec![
            transaction("context-1"),
            transaction("context-2"),
            transaction("context-3"),
        ],
    }])
    .await;

    publish_user(&bus, session_id, "deduplicate context transactions").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    assert_eq!(replies.len(), 1);

    let commits = wait_for_topic(&store, "chat/context_tx_committed", session_id).await;
    assert_eq!(commits.len(), 1);
    let context_outputs = wait_for_topic(&store, "chat/tool_output", session_id).await;
    assert_eq!(context_outputs.len(), 1);
    assert_eq!(
        context_outputs[0]
            .payload
            .get("tool_name")
            .and_then(|value| value.as_str()),
        Some("context_tx")
    );
    let assistant_calls = wait_for_topic(&store, "chat/assistant_call", session_id).await;
    assert_eq!(
        assistant_calls[0]
            .payload
            .get("deduplicated_context_tx_ids")
            .and_then(|value| value.as_array())
            .map(Vec::len),
        Some(2)
    );
    let context = orchestrator
        .get_current_context_view(session_id)
        .await
        .unwrap();
    assert_eq!(context.state.version, 1);
    assert_eq!(context.state.frames.len(), 1);
    assert_eq!(context.state.frames[0].id, "first");
}

#[tokio::test]
async fn test_distinct_context_transactions_are_rejected_then_combined_atomically() {
    let session_id = "attempt_distinct_context_tx";
    let note = NamedTempFile::new().unwrap();
    std::fs::write(note.path(), "evidence").unwrap();
    let transaction = |id: &str, frame: &str| ToolCallRepr {
        id: id.to_string(),
        r#type: "function".to_string(),
        func_name: "context_tx".to_string(),
        arguments: json!({
            "session_id": session_id,
            "transaction": format!("(context-tx (base-version 0) (create {frame} (status active)))")
        })
        .to_string(),
    };
    let (bus, store, orchestrator, _tmp) = build_orchestrator(vec![
        Response {
            content: String::new(),
            tool_calls: vec![
                transaction("context-1", "first"),
                transaction("context-2", "second"),
                ToolCallRepr {
                    id: "read-evidence".to_string(),
                    r#type: "function".to_string(),
                    func_name: "read".to_string(),
                    arguments: json!({ "path": note.path().to_string_lossy() }).to_string(),
                },
            ],
        },
        Response {
            content: "多个修改已在一个事务中提交".to_string(),
            tool_calls: vec![ToolCallRepr {
                id: "context-combined".to_string(),
                r#type: "function".to_string(),
                func_name: "context_tx".to_string(),
                arguments: json!({
                    "session_id": session_id,
                    "transaction": "(context-tx (base-version 0) (reason \"合并多个修改\") (create first (status active)) (create second (status active)) (protect first second))"
                })
                .to_string(),
            }],
        },
    ])
    .await;

    publish_user(&bus, session_id, "combine distinct context transactions").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    assert_eq!(replies.len(), 1);
    let assistant_calls = wait_for_topic(&store, "chat/assistant_call", session_id).await;
    assert_eq!(assistant_calls.len(), 2);
    assert_eq!(
        assistant_calls[0]
            .payload
            .get("rejected_context_tx_ids")
            .and_then(|value| value.as_array())
            .map(Vec::len),
        Some(2)
    );
    let context = orchestrator
        .get_current_context_view(session_id)
        .await
        .unwrap();
    assert_eq!(context.state.version, 1);
    assert_eq!(context.state.frames.len(), 2);
    assert!(context.state.protected.contains("first"));
    assert!(context.state.protected.contains("second"));
    assert!(context
        .observations
        .iter()
        .any(|observation| { observation.preview.contains("MULTIPLE_DISTINCT_CONTEXT_TX") }));
}

#[tokio::test]
async fn test_context_budget_exhaustion_preserves_physical_work_budget() {
    let session_id = "attempt_context_budget";
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("context-budget.db");
    let note = NamedTempFile::new().unwrap();
    std::fs::write(note.path(), "evidence").unwrap();
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    let client = Arc::new(MockClient::new(vec![
        Response {
            content: String::new(),
            tool_calls: vec![
                ToolCallRepr {
                    id: "context-initial".to_string(),
                    r#type: "function".to_string(),
                    func_name: "context_tx".to_string(),
                    arguments: json!({
                        "session_id": session_id,
                        "transaction": "(context-tx (base-version 0) (create task (status active)))"
                    })
                    .to_string(),
                },
                ToolCallRepr {
                    id: "read-initial".to_string(),
                    r#type: "function".to_string(),
                    func_name: "read".to_string(),
                    arguments: json!({ "path": note.path().to_string_lossy() }).to_string(),
                },
            ],
        },
        Response {
            content: String::new(),
            tool_calls: vec![
                ToolCallRepr {
                    id: "context-over-budget".to_string(),
                    r#type: "function".to_string(),
                    func_name: "context_tx".to_string(),
                    arguments: json!({
                        "session_id": session_id,
                        "transaction": "(context-tx (base-version 1) (revise task (status still-active)))"
                    })
                    .to_string(),
                },
                ToolCallRepr {
                    id: "read-still-allowed".to_string(),
                    r#type: "function".to_string(),
                    func_name: "read".to_string(),
                    arguments: json!({ "path": note.path().to_string_lossy() }).to_string(),
                },
            ],
        },
        Response {
            content: "物理工作仍可继续".to_string(),
            tool_calls: Vec::new(),
        },
    ]));
    let config = morphz::config::OrchestratorConfig {
        max_attempts_per_turn: 4,
        max_context_transactions_per_turn: 1,
        ..Default::default()
    };
    let engine = Arc::new(ContextEngine::new(
        Arc::clone(&store) as Arc<dyn EventStore>,
        config.clone(),
    ));
    let registry = Arc::new(Registry::new());
    registry.register(Arc::new(ReadFileTool::default()));
    registry.register(Arc::new(ContextTxTool::new(Arc::clone(&engine))));
    let orchestrator = Arc::new(Orchestrator::new_with_context_engine(
        Arc::clone(&bus),
        Arc::clone(&store) as Arc<dyn EventStore>,
        Arc::clone(&client) as Arc<dyn Client>,
        registry,
        config,
        engine,
    ));
    orchestrator.clone().start().await.unwrap();

    publish_user(&bus, session_id, "preserve physical work").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    assert_eq!(replies.len(), 1);
    let tools_seen = client.tools_seen();
    assert_eq!(tools_seen.len(), 3);
    assert!(tools_seen[0].contains(&"context_tx".to_string()));
    assert!(!tools_seen[1].contains(&"context_tx".to_string()));
    assert!(tools_seen[1].contains(&"read".to_string()));

    let context = orchestrator
        .get_current_context_view(session_id)
        .await
        .unwrap();
    assert_eq!(context.state.version, 1);
    assert_eq!(context.turn_budget.attempt, 3);
    assert_eq!(context.turn_budget.context_transactions_used, 2);
    assert!(!context.turn_budget.context_tx_available);
    assert!(context
        .observations
        .iter()
        .any(|observation| { observation.preview.contains("CONTEXT_TX_BUDGET_EXHAUSTED") }));
    assert!(wait_for_topic(&store, "chat/tool_output", session_id)
        .await
        .iter()
        .any(|event| {
            event
                .payload
                .get("text")
                .and_then(|value| value.as_str())
                .is_some_and(|text| text.contains("CONTEXT_TX_BUDGET_EXHAUSTED"))
        }));
}

#[tokio::test]
async fn test_attempt_loop_parallel_tool_barrier_single_reply() {
    let session_id = "attempt_parallel_barrier";
    let file_a = NamedTempFile::new().unwrap();
    let file_b = NamedTempFile::new().unwrap();
    let file_c = NamedTempFile::new().unwrap();
    std::fs::write(file_a.path(), "A").unwrap();
    std::fs::write(file_b.path(), "B").unwrap();
    std::fs::write(file_c.path(), "C").unwrap();

    let (bus, store, _orc, _tmp) = build_orchestrator(vec![
        Response {
            content: "".to_string(),
            tool_calls: vec![
                ToolCallRepr {
                    id: "read_a".to_string(),
                    r#type: "function".to_string(),
                    func_name: "read".to_string(),
                    arguments: json!({ "path": file_a.path().to_string_lossy() }).to_string(),
                },
                ToolCallRepr {
                    id: "read_b".to_string(),
                    r#type: "function".to_string(),
                    func_name: "read".to_string(),
                    arguments: json!({ "path": file_b.path().to_string_lossy() }).to_string(),
                },
                ToolCallRepr {
                    id: "read_c".to_string(),
                    r#type: "function".to_string(),
                    func_name: "read".to_string(),
                    arguments: json!({ "path": file_c.path().to_string_lossy() }).to_string(),
                },
            ],
        },
        Response {
            content: "三文件已读取".to_string(),
            tool_calls: Vec::new(),
        },
    ])
    .await;

    publish_user(&bus, session_id, "read three files").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    let tool_outputs = wait_for_topic(&store, "chat/tool_output", session_id).await;

    assert_eq!(replies.len(), 1);
    assert_eq!(tool_outputs.len(), 3);
}

#[tokio::test]
async fn test_turn_attempt_budget_forces_toolless_final_reply() {
    let session_id = "attempt_budget";
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("attempt-budget.db");
    let note = NamedTempFile::new().unwrap();
    std::fs::write(note.path(), "same evidence").unwrap();

    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    let client = Arc::new(BudgetProbeClient {
        calls: AtomicUsize::new(0),
        tool_counts: Mutex::new(Vec::new()),
        read_path: note.path().to_string_lossy().into_owned(),
    });
    let config = morphz::config::OrchestratorConfig {
        max_attempts_per_turn: 3,
        ..Default::default()
    };
    let engine = Arc::new(ContextEngine::new(
        Arc::clone(&store) as Arc<dyn EventStore>,
        config.clone(),
    ));
    let registry = Arc::new(Registry::new());
    registry.register(Arc::new(ReadFileTool::default()));
    let orchestrator = Arc::new(Orchestrator::new_with_context_engine(
        Arc::clone(&bus),
        Arc::clone(&store) as Arc<dyn EventStore>,
        Arc::clone(&client) as Arc<dyn Client>,
        registry,
        config,
        engine,
    ));
    orchestrator.clone().start().await.unwrap();

    publish_user(&bus, session_id, "keep reading forever").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    let assistant_calls = wait_for_topic(&store, "chat/assistant_call", session_id).await;
    let tool_outputs = wait_for_topic(&store, "chat/tool_output", session_id).await;

    assert_eq!(replies.len(), 1);
    assert_eq!(assistant_calls.len(), 2);
    assert_eq!(tool_outputs.len(), 2);
    assert_eq!(client.calls.load(Ordering::SeqCst), 3);
    assert_eq!(client.tool_counts.lock().unwrap().as_slice(), &[1, 1, 0]);
    assert_eq!(
        replies[0]
            .payload
            .get("text")
            .and_then(|value| value.as_str()),
        Some("budget forced final")
    );
}

#[tokio::test]
async fn test_attempt_budget_reserves_context_closure_before_final_reply() {
    let session_id = "attempt_context_closure";
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("context-closure.db");
    let note = NamedTempFile::new().unwrap();
    std::fs::write(note.path(), "evidence").unwrap();

    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    let client = Arc::new(MockClient::new(vec![
        Response {
            content: String::new(),
            tool_calls: vec![ToolCallRepr {
                id: "read-1".to_string(),
                r#type: "function".to_string(),
                func_name: "read".to_string(),
                arguments: json!({ "path": note.path().to_string_lossy() }).to_string(),
            }],
        },
        Response {
            content: String::new(),
            tool_calls: vec![ToolCallRepr {
                id: "read-2".to_string(),
                r#type: "function".to_string(),
                func_name: "read".to_string(),
                arguments: json!({ "path": note.path().to_string_lossy() }).to_string(),
            }],
        },
        Response {
            content: String::new(),
            tool_calls: vec![ToolCallRepr {
                id: "close-context".to_string(),
                r#type: "function".to_string(),
                func_name: "context_tx".to_string(),
                arguments: json!({
                    "session_id": session_id,
                    "transaction": "(context-tx (base-version 0) (create task (task (goal repair) (status completed) (evidence tests-passed))) (protect task))"
                })
                .to_string(),
            }],
        },
        Response {
            content: "修复与 Context 均已收口".to_string(),
            tool_calls: Vec::new(),
        },
    ]));
    let config = morphz::config::OrchestratorConfig {
        max_attempts_per_turn: 3,
        ..Default::default()
    };
    let engine = Arc::new(ContextEngine::new(
        Arc::clone(&store) as Arc<dyn EventStore>,
        config.clone(),
    ));
    let registry = Arc::new(Registry::new());
    registry.register(Arc::new(ReadFileTool::default()));
    registry.register(Arc::new(ContextTxTool::new(Arc::clone(&engine))));
    let orchestrator = Arc::new(Orchestrator::new_with_context_engine(
        Arc::clone(&bus),
        Arc::clone(&store) as Arc<dyn EventStore>,
        Arc::clone(&client) as Arc<dyn Client>,
        registry,
        config,
        Arc::clone(&engine),
    ));
    orchestrator.clone().start().await.unwrap();

    publish_user(&bus, session_id, "repair and close context").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    assert_eq!(replies.len(), 1);
    assert_eq!(
        replies[0]
            .payload
            .get("text")
            .and_then(|value| value.as_str()),
        Some("修复与 Context 均已收口")
    );

    let tools_seen = client.tools_seen();
    assert_eq!(tools_seen.len(), 4);
    assert!(tools_seen[0].contains(&"read".to_string()));
    assert!(tools_seen[1].contains(&"read".to_string()));
    assert_eq!(tools_seen[2], vec!["context_tx"]);
    assert!(tools_seen[3].is_empty());

    let assistant_calls = wait_for_topic(&store, "chat/assistant_call", session_id).await;
    assert_eq!(assistant_calls.len(), 3);
    assert_eq!(
        assistant_calls[2]
            .payload
            .get("phase")
            .and_then(|value| value.as_str()),
        Some("context-closure")
    );
    let context = orchestrator
        .get_current_context_view(session_id)
        .await
        .unwrap();
    assert_eq!(context.state.version, 1);
    assert_eq!(context.turn_budget.phase, "final-reply");
    assert!(context.state.frames[0].body.contains("completed"));
    assert!(context.state.frames[0].body.contains("tests-passed"));
}

#[tokio::test]
async fn test_failed_context_closure_still_terminates_with_final_reply() {
    let session_id = "attempt_failed_context_closure";
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("failed-context-closure.db");
    let note = NamedTempFile::new().unwrap();
    std::fs::write(note.path(), "evidence").unwrap();

    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    let client = Arc::new(MockClient::new(vec![
        Response {
            content: String::new(),
            tool_calls: vec![ToolCallRepr {
                id: "read".to_string(),
                r#type: "function".to_string(),
                func_name: "read".to_string(),
                arguments: json!({ "path": note.path().to_string_lossy() }).to_string(),
            }],
        },
        Response {
            content: String::new(),
            tool_calls: vec![ToolCallRepr {
                id: "invalid-close".to_string(),
                r#type: "function".to_string(),
                func_name: "context_tx".to_string(),
                arguments: json!({
                    "session_id": session_id,
                    "transaction": "(context-tx (base-version 0) (retire missing-frame))"
                })
                .to_string(),
            }],
        },
        Response {
            content: "收口失败但仍然终止".to_string(),
            tool_calls: Vec::new(),
        },
    ]));
    let config = morphz::config::OrchestratorConfig {
        max_attempts_per_turn: 2,
        ..Default::default()
    };
    let engine = Arc::new(ContextEngine::new(
        Arc::clone(&store) as Arc<dyn EventStore>,
        config.clone(),
    ));
    let registry = Arc::new(Registry::new());
    registry.register(Arc::new(ReadFileTool::default()));
    registry.register(Arc::new(ContextTxTool::new(Arc::clone(&engine))));
    let orchestrator = Arc::new(Orchestrator::new_with_context_engine(
        Arc::clone(&bus),
        Arc::clone(&store) as Arc<dyn EventStore>,
        Arc::clone(&client) as Arc<dyn Client>,
        registry,
        config,
        engine,
    ));
    orchestrator.clone().start().await.unwrap();

    publish_user(&bus, session_id, "fail closure safely").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    assert_eq!(replies.len(), 1);
    assert_eq!(client.tools_seen().len(), 3);
    assert_eq!(client.tools_seen()[1], vec!["context_tx"]);
    assert!(client.tools_seen()[2].is_empty());
    let context = orchestrator
        .get_current_context_view(session_id)
        .await
        .unwrap();
    assert_eq!(context.state.version, 0);
    assert_eq!(context.turn_budget.phase, "final-reply");
}

#[tokio::test]
async fn test_edit_file_change_becomes_next_attempt_observation() {
    let session_id = "attempt_edit_event";
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("edit-event.db");
    let source_path = tmp.path().join("lib.rs");
    let original = "pub fn answer() -> i32 { 41 }\n";
    std::fs::write(&source_path, original).unwrap();
    let expected_sha256 = format!("{:x}", Sha256::digest(original.as_bytes()));

    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    let client = Arc::new(MockClient::new(vec![
        Response {
            content: String::new(),
            tool_calls: vec![ToolCallRepr {
                id: "edit-answer".to_string(),
                r#type: "function".to_string(),
                func_name: "edit".to_string(),
                arguments: json!({
                    "path": "lib.rs",
                    "expected_sha256": expected_sha256,
                    "edits": [{
                        "old_text": "41",
                        "new_text": "42"
                    }]
                })
                .to_string(),
            }],
        },
        Response {
            content: "edited safely".to_string(),
            tool_calls: Vec::new(),
        },
    ]));
    let config = morphz::config::OrchestratorConfig::default();
    let engine = Arc::new(ContextEngine::new(
        Arc::clone(&store) as Arc<dyn EventStore>,
        config.clone(),
    ));
    let security = Arc::new(ToolSecurityConfig {
        workspace_root: tmp.path().to_string_lossy().to_string(),
        extra_read_roots: Vec::new(),
        extra_write_roots: Vec::new(),
        ..Default::default()
    });
    let registry = Arc::new(Registry::new());
    registry.register(Arc::new(EditFileTool::new_with_bus(
        security,
        Arc::clone(&bus),
    )));
    let orchestrator = Arc::new(Orchestrator::new_with_context_engine(
        Arc::clone(&bus),
        Arc::clone(&store) as Arc<dyn EventStore>,
        client as Arc<dyn Client>,
        registry,
        config,
        engine,
    ));
    orchestrator.start().await.unwrap();

    publish_user(&bus, session_id, "fix answer").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    assert_eq!(replies.len(), 1);
    assert_eq!(
        std::fs::read_to_string(source_path).unwrap(),
        "pub fn answer() -> i32 { 42 }\n"
    );

    let changes = store
        .query(QueryFilter {
            session_id: Some(session_id.to_string()),
            types: vec![TYPE_FILE_CHANGE.to_string()],
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(changes.len(), 1);
    assert_eq!(
        changes[0]
            .payload
            .get("operation")
            .and_then(|value| value.as_str()),
        Some("edit")
    );
    let inspections = store
        .query(QueryFilter {
            session_id: Some(session_id.to_string()),
            topic: Some("chat/context_inspect".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(inspections.len() >= 2);
    assert!(inspections.iter().any(|event| event
        .payload
        .get("text")
        .and_then(|value| value.as_str())
        .is_some_and(|text| text.contains("(kind file_change)"))));
}

#[tokio::test]
async fn test_spawn_child_reply_wakes_parent() {
    let parent_session_id = "attempt_spawn_parent";
    let child_session_id = "attempt_spawn_child";
    let (bus, store, _orc, _tmp) = build_orchestrator(vec![
        Response {
            content: "子任务已完成".to_string(),
            tool_calls: Vec::new(),
        },
        Response {
            content: "父任务已收到子任务结果".to_string(),
            tool_calls: Vec::new(),
        },
    ])
    .await;

    let spawn = SpawnAgentTool::new(Arc::clone(&bus));
    spawn
        .execute(
            &json!({
                "sub_session_id": child_session_id,
                "parent_session_id": parent_session_id,
                "delegation": "(delegation (goal \"执行子任务\") (success-when \"返回结果\"))",
            })
            .to_string(),
        )
        .await
        .unwrap();

    let child_replies = wait_for_topic(&store, "chat/reply", child_session_id).await;
    assert_eq!(child_replies.len(), 1);
    assert_eq!(
        child_replies[0]
            .payload
            .get("parent_session_id")
            .and_then(|value| value.as_str()),
        Some(parent_session_id)
    );

    let parent_wakeups = wait_for_topic(&store, "chat/tool_output", parent_session_id).await;
    assert_eq!(parent_wakeups.len(), 1);
    assert!(
        parent_wakeups[0]
            .payload
            .get("sub_session_id")
            .and_then(|value| value.as_str())
            == Some(child_session_id)
    );
}

#[tokio::test]
async fn test_same_session_attempts_are_single_writer() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("single-writer.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    let client = Arc::new(ConcurrencyProbeClient {
        active: AtomicUsize::new(0),
        max_active: AtomicUsize::new(0),
        calls: AtomicUsize::new(0),
    });
    let config = morphz::config::OrchestratorConfig::default();
    let engine = Arc::new(ContextEngine::new(
        Arc::clone(&store) as Arc<dyn EventStore>,
        config.clone(),
    ));
    let orchestrator = Arc::new(Orchestrator::new_with_context_engine(
        Arc::clone(&bus),
        Arc::clone(&store) as Arc<dyn EventStore>,
        Arc::clone(&client) as Arc<dyn Client>,
        Arc::new(Registry::new()),
        config,
        engine,
    ));
    orchestrator.start().await.unwrap();

    publish_user(&bus, "serialized-session", "first").await;
    publish_user(&bus, "serialized-session", "second").await;

    for _ in 0..80 {
        let replies = store
            .query(QueryFilter {
                session_id: Some("serialized-session".to_string()),
                topic: Some("chat/reply".to_string()),
                ..Default::default()
            })
            .await
            .unwrap()
            .len();
        if replies == 2 {
            break;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(25)).await;
    }

    assert_eq!(client.calls.load(Ordering::SeqCst), 2);
    assert_eq!(client.max_active.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn test_concurrent_tool_wakeups_covered_by_one_context_are_coalesced() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("coalesced-wakeups.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    let client = Arc::new(ConcurrencyProbeClient {
        active: AtomicUsize::new(0),
        max_active: AtomicUsize::new(0),
        calls: AtomicUsize::new(0),
    });
    let config = morphz::config::OrchestratorConfig::default();
    let engine = Arc::new(ContextEngine::new(
        Arc::clone(&store) as Arc<dyn EventStore>,
        config.clone(),
    ));
    let orchestrator = Arc::new(Orchestrator::new_with_context_engine(
        Arc::clone(&bus),
        Arc::clone(&store) as Arc<dyn EventStore>,
        Arc::clone(&client) as Arc<dyn Client>,
        Arc::new(Registry::new()),
        config,
        engine,
    ));
    orchestrator.start().await.unwrap();

    publish_user(&bus, "coalesced-session", "start").await;
    tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
    publish_tool_output(&bus, "coalesced-session", "tool-output-1").await;
    publish_tool_output(&bus, "coalesced-session", "tool-output-2").await;

    for _ in 0..80 {
        if client.calls.load(Ordering::SeqCst) >= 2 {
            break;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
    }
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

    assert_eq!(client.calls.load(Ordering::SeqCst), 2);
    assert_eq!(client.max_active.load(Ordering::SeqCst), 1);
    let inspections = store
        .query(QueryFilter {
            session_id: Some("coalesced-session".to_string()),
            topic: Some("chat/context_inspect".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(inspections.len(), 2);
}
