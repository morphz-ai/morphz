use morphz::context_tools::ContextTxTool;
use morphz::event::{
    Event, InMemoryEventBus, TYPE_FILE_CHANGE, TYPE_TOOL_OUTPUT, TYPE_USER_MESSAGE,
};
use morphz::llm::{
    Client, Message, PromptTokenAccuracy, PromptTokenCount, Response, ToolCallRepr, ToolDefinition,
};
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{
    DelegationStatus, EventStore, NewCognitiveContext, NewSession, QueryFilter, SessionMountKind,
    SessionStore,
};
use morphz::orchestrator::context::ContextEngine;
use morphz::orchestrator::orchestrator::Orchestrator;
use morphz::permission::PermissionConfig;
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
    messages_seen: Mutex<Vec<Vec<Message>>>,
    prompt_token_count: Mutex<Option<usize>>,
    auto_reply: bool,
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
    reply_after: usize,
}

struct FailingClient;

struct HangingClient;

struct BlockingClient;

struct CancellableClient {
    calls: AtomicUsize,
}

struct SlowBatchClient {
    started: AtomicUsize,
}

struct EmptyOutputTool;

struct RoutingProbeTool {
    arguments: Arc<Mutex<Vec<serde_json::Value>>>,
    delay_ms: u64,
}

fn explicit_reply_response(content: impl Into<String>) -> Response {
    Response {
        content: String::new(),
        tool_calls: vec![ToolCallRepr {
            id: "reply-decision".to_string(),
            r#type: "function".to_string(),
            func_name: "reply".to_string(),
            arguments: json!({
                "disposition": "deliver",
                "content": content.into()
            })
            .to_string(),
        }],
    }
}

fn suppressed_reply_response() -> Response {
    Response {
        content: String::new(),
        tool_calls: vec![ToolCallRepr {
            id: "reply-suppressed".to_string(),
            r#type: "function".to_string(),
            func_name: "reply".to_string(),
            arguments: json!({"disposition": "suppress"}).to_string(),
        }],
    }
}

#[async_trait::async_trait]
impl Tool for EmptyOutputTool {
    fn name(&self) -> &str {
        "empty_output"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().to_string(),
            description: "Completes successfully without textual output".to_string(),
            parameters: json!({ "type": "object", "properties": {} }),
        }
    }

    async fn execute(
        &self,
        _arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        Ok(String::new())
    }
}

#[async_trait::async_trait]
impl Tool for RoutingProbeTool {
    fn name(&self) -> &str {
        "route_probe"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().to_string(),
            description: "Records routed arguments".to_string(),
            parameters: json!({
                "type": "object",
                "properties": { "value": { "type": "string" } },
                "required": ["value"]
            }),
        }
    }

    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let value: serde_json::Value = serde_json::from_str(arguments)?;
        self.arguments.lock().unwrap().push(value.clone());
        tokio::time::sleep(tokio::time::Duration::from_millis(self.delay_ms)).await;
        Ok(format!(
            "probe:{}",
            value["value"].as_str().unwrap_or_default()
        ))
    }
}

#[async_trait::async_trait]
impl Client for FailingClient {
    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        Err("simulated LLM transport timeout".into())
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
}

#[async_trait::async_trait]
impl Client for CancellableClient {
    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            unreachable!("first attempt must be cancelled")
        }
        Ok(explicit_reply_response("resumed-after-cancel"))
    }
}

#[async_trait::async_trait]
impl Client for SlowBatchClient {
    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        self.started.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
        Ok(Response {
            content: String::new(),
            tool_calls: vec![ToolCallRepr {
                id: "cancel-batch-output".to_string(),
                r#type: "function".to_string(),
                func_name: "session_output".to_string(),
                arguments: json!({
                    "deliveries": [
                        {"session_id": "cancel-batch-a", "kind": "final", "text": "should-be-suppressed"},
                        {"session_id": "cancel-batch-b", "kind": "final", "text": "b-survives"}
                    ]
                })
                .to_string(),
            }],
        })
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
        if call >= self.reply_after {
            return Ok(explicit_reply_response("soft checkpoint continued"));
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
        // Keep the probe open long enough for the second independently routed
        // Session to enter even under a fully loaded test runner.
        tokio::time::sleep(tokio::time::Duration::from_millis(150)).await;
        self.active.fetch_sub(1, Ordering::SeqCst);
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        Ok(explicit_reply_response(format!("reply-{call}")))
    }
}

impl MockClient {
    fn new(responses: Vec<Response>) -> Self {
        Self::with_auto_reply(responses, true)
    }

    fn new_raw(responses: Vec<Response>) -> Self {
        Self::with_auto_reply(responses, false)
    }

    fn with_auto_reply(responses: Vec<Response>, auto_reply: bool) -> Self {
        Self {
            responses: Mutex::new(VecDeque::from(responses)),
            tools_seen: Mutex::new(Vec::new()),
            messages_seen: Mutex::new(Vec::new()),
            prompt_token_count: Mutex::new(None),
            auto_reply,
        }
    }

    fn tools_seen(&self) -> Vec<Vec<String>> {
        self.tools_seen.lock().unwrap().clone()
    }

    fn messages_seen(&self) -> Vec<Vec<Message>> {
        self.messages_seen.lock().unwrap().clone()
    }

    fn set_prompt_token_count(&self, tokens: usize) {
        *self.prompt_token_count.lock().unwrap() = Some(tokens);
    }
}

#[async_trait::async_trait]
impl Client for MockClient {
    async fn count_prompt_tokens(
        &self,
        _scope: &str,
        _messages: &[Message],
        _tools: &[ToolDefinition],
    ) -> Result<Option<PromptTokenCount>, Box<dyn std::error::Error + Send + Sync>> {
        let tokens = *self
            .prompt_token_count
            .lock()
            .map_err(|_| "mock prompt token mutex poisoned")?;
        Ok(tokens.map(|tokens| PromptTokenCount {
            tokens,
            source: "test-native-tokenizer".to_string(),
            model: "test-model".to_string(),
            accuracy: PromptTokenAccuracy::Exact,
            base_estimate_tokens: tokens,
            calibration_key: Some(1),
        }))
    }

    async fn create_completion(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        let tool_names = tools.into_iter().map(|tool| tool.name).collect::<Vec<_>>();
        let reply_available = tool_names.iter().any(|name| name == "reply");
        self.tools_seen
            .lock()
            .map_err(|_| "mock tools mutex poisoned")?
            .push(tool_names);
        self.messages_seen
            .lock()
            .map_err(|_| "mock messages mutex poisoned")?
            .push(messages);
        let mut response = self
            .responses
            .lock()
            .map_err(|_| "mock response mutex poisoned")?
            .pop_front()
            .ok_or("mock response queue exhausted")?;
        if self.auto_reply
            && reply_available
            && response.tool_calls.is_empty()
            && !response.content.trim().is_empty()
        {
            response = explicit_reply_response(response.content);
        }
        Ok(response)
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
    build_orchestrator_with_config_and_reply_mode(responses, orchestrator_config, true).await
}

async fn build_orchestrator_with_config_and_reply_mode(
    responses: Vec<Response>,
    orchestrator_config: morphz::config::OrchestratorConfig,
    auto_reply: bool,
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
    let client = Arc::new(if auto_reply {
        MockClient::new(responses)
    } else {
        MockClient::new_raw(responses)
    });
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

fn deterministic_batch_config() -> morphz::config::OrchestratorConfig {
    morphz::config::OrchestratorConfig {
        merged_evaluation_enabled: true,
        session_batch_coalesce_ms: 200,
        ..Default::default()
    }
}

async fn publish_user(bus: &Arc<InMemoryEventBus>, session_id: &str, text: &str) {
    publish_user_in_context(bus, session_id, session_id, text).await;
}

async fn publish_user_in_context(
    bus: &Arc<InMemoryEventBus>,
    context_id: &str,
    session_id: &str,
    text: &str,
) {
    let mut payload = serde_json::Map::new();
    payload.insert("context_id".to_string(), json!(context_id));
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
    wait_for_topic_count(store, topic, session_id, 1).await
}

async fn wait_for_topic_count(
    store: &Arc<SqliteStore>,
    topic: &str,
    session_id: &str,
    expected: usize,
) -> Vec<Event> {
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
        if matched.len() >= expected {
            return matched;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    }
    Vec::new()
}

#[tokio::test]
async fn test_attempt_loop_explicit_reply_delivers() {
    let session_id = "attempt_explicit_reply";
    let (bus, store, _orc, _tmp) =
        build_orchestrator(vec![explicit_reply_response("hello user")]).await;

    publish_user(&bus, session_id, "hello").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;

    assert_eq!(replies.len(), 1);
    assert_eq!(
        replies[0].payload.get("text").and_then(|v| v.as_str()),
        Some("hello user")
    );
}

#[tokio::test]
async fn test_plain_text_terminal_is_corrected_to_explicit_reply() {
    let session_id = "attempt_reply_protocol_correction";
    let responses = vec![
        Response {
            content: "I am done".to_string(),
            tool_calls: Vec::new(),
        },
        explicit_reply_response("corrected reply"),
    ];
    let (bus, store, _orc, client, _tmp) = build_orchestrator_with_config_and_reply_mode(
        responses,
        morphz::config::OrchestratorConfig::default(),
        false,
    )
    .await;

    publish_user(&bus, session_id, "finish explicitly").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    let errors = wait_for_topic(&store, "runtime/reply_protocol_error", session_id).await;

    assert_eq!(replies.len(), 1);
    assert_eq!(
        replies[0].payload.get("text"),
        Some(&json!("corrected reply"))
    );
    assert_eq!(errors.len(), 1);
    assert_eq!(client.messages_seen().len(), 2);
    assert!(client.messages_seen()[1]
        .last()
        .unwrap()
        .content
        .contains("Reply protocol error"));
}

#[tokio::test]
async fn test_reply_suppress_is_terminal_without_session_delivery() {
    let session_id = "attempt_reply_suppress";
    let (bus, store, _orc, _client, _tmp) = build_orchestrator_with_config_and_reply_mode(
        vec![suppressed_reply_response()],
        morphz::config::OrchestratorConfig::default(),
        false,
    )
    .await;

    publish_user(&bus, session_id, "background event").await;
    let suppressed = wait_for_topic(&store, "chat/reply_suppressed", session_id).await;
    let delivered = store
        .query(QueryFilter {
            session_id: Some(session_id.to_string()),
            topic: Some("chat/reply".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();

    assert_eq!(suppressed.len(), 1);
    assert!(delivered.is_empty());
    assert_eq!(
        suppressed[0].payload.get("disposition"),
        Some(&json!("suppress"))
    );
}

#[tokio::test]
async fn test_reply_protocol_fuses_after_two_failed_corrections() {
    let session_id = "attempt_reply_protocol_fuse";
    let responses = (0..3)
        .map(|_| Response {
            content: "done without reply tool".to_string(),
            tool_calls: Vec::new(),
        })
        .collect();
    let (bus, store, _orc, client, _tmp) = build_orchestrator_with_config_and_reply_mode(
        responses,
        morphz::config::OrchestratorConfig::default(),
        false,
    )
    .await;

    publish_user(&bus, session_id, "fail reply protocol").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    let errors = wait_for_topic_count(&store, "runtime/reply_protocol_error", session_id, 3).await;
    let fused = wait_for_topic(&store, "runtime/reply_protocol_fused", session_id).await;

    assert_eq!(client.messages_seen().len(), 3);
    assert_eq!(errors.len(), 3);
    assert_eq!(fused.len(), 1);
    assert_eq!(replies.len(), 1);
    assert!(replies[0]
        .payload
        .get("text")
        .and_then(|value| value.as_str())
        .unwrap()
        .contains("安全熔断"));
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
async fn test_session_cancel_stops_current_attempt_until_new_user_message() {
    let session_id = "attempt_user_cancel";
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("user-cancel.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    let config = morphz::config::OrchestratorConfig {
        model_attempt_timeout_secs: 30,
        ..Default::default()
    };
    let engine = Arc::new(ContextEngine::new(
        Arc::clone(&store) as Arc<dyn EventStore>,
        config.clone(),
    ));
    let orchestrator = Arc::new(Orchestrator::new_with_context_engine(
        Arc::clone(&bus),
        Arc::clone(&store) as Arc<dyn EventStore>,
        Arc::new(CancellableClient {
            calls: AtomicUsize::new(0),
        }),
        Arc::new(Registry::new()),
        config,
        engine,
    ));
    orchestrator.clone().start().await.unwrap();

    publish_user(&bus, session_id, "first hangs").await;
    let starts = wait_for_topic(&store, "runtime/model_attempt_started", session_id).await;
    assert_eq!(starts.len(), 1);
    assert!(orchestrator.cancel_session(session_id));
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(store
        .query(QueryFilter {
            session_id: Some(session_id.to_string()),
            topic: Some("chat/reply".to_string()),
            ..Default::default()
        })
        .await
        .unwrap()
        .is_empty());

    publish_tool_output(&bus, session_id, "late-background-output").await;
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    publish_user(&bus, session_id, "resume explicitly").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    assert_eq!(replies.len(), 1);
    assert_eq!(
        replies[0]
            .payload
            .get("text")
            .and_then(|value| value.as_str()),
        Some("resumed-after-cancel")
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
    let note = NamedTempFile::new_in(".").unwrap();
    std::fs::write(note.path(), "hello from note").unwrap();

    let (bus, store, _orc, client, _tmp) = build_orchestrator_with_config(
        vec![
            Response {
                content: "".to_string(),
                tool_calls: vec![ToolCallRepr {
                    id: "call_read".to_string(),
                    r#type: "function".to_string(),
                    func_name: "read".to_string(),
                    arguments: json!({
                        "path": note.path().file_name().unwrap().to_string_lossy()
                    })
                    .to_string(),
                }],
            },
            Response {
                content: "已读取 notes".to_string(),
                tool_calls: Vec::new(),
            },
        ],
        morphz::config::OrchestratorConfig::default(),
    )
    .await;

    publish_user(&bus, session_id, "read note").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    let assistant_calls = wait_for_topic(&store, "chat/assistant_call", session_id).await;
    let tool_outputs = wait_for_topic(&store, "chat/tool_output", session_id).await;
    let tool_activity = wait_for_topic(&store, "runtime/tool_calls_selected", session_id).await;

    assert_eq!(replies.len(), 1);
    assert!(!assistant_calls.is_empty());
    assert!(!tool_outputs.is_empty());
    assert_eq!(tool_activity.len(), 1);
    let selected = tool_activity[0]
        .payload
        .get("calls")
        .and_then(|value| value.as_array())
        .unwrap();
    assert_eq!(selected.len(), 1);
    assert_eq!(
        selected[0].get("name").and_then(|value| value.as_str()),
        Some("read")
    );
    assert!(selected[0]
        .get("arguments")
        .and_then(|value| value.as_str())
        .is_some_and(|arguments| arguments.contains("path")));
    assert_eq!(
        replies[0].payload.get("text").and_then(|v| v.as_str()),
        Some("已读取 notes")
    );
    let messages_seen = client.messages_seen();
    assert_eq!(messages_seen.len(), 2);
    let continuation = &messages_seen[1];
    assert_eq!(
        continuation
            .iter()
            .map(|message| message.role.as_str())
            .collect::<Vec<_>>(),
        vec!["system", "user", "assistant", "tool"]
    );
    let assistant = &continuation[2];
    assert_eq!(
        assistant
            .tool_calls
            .as_ref()
            .and_then(|calls| calls.first())
            .map(|call| call.id.as_str()),
        Some("call_read")
    );
    let tool = &continuation[3];
    assert_eq!(tool.tool_call_id.as_deref(), Some("call_read"));
    let envelope: serde_json::Value = serde_json::from_str(&tool.content).unwrap();
    assert_eq!(
        envelope.get("status").and_then(|value| value.as_str()),
        Some("success")
    );
    assert_eq!(
        envelope
            .get("output_state")
            .and_then(|value| value.as_str()),
        Some("content")
    );
    assert!(envelope
        .get("observation_ref")
        .and_then(|value| value.as_str())
        .is_some_and(|reference| reference.starts_with("@e")));
    assert!(
        envelope
            .get("result")
            .and_then(|value| value.as_str())
            .is_some_and(|result| result.contains("hello from note")),
        "unexpected tool envelope: {envelope}"
    );
    assert!(!continuation[1].content.contains("hello from note"));
}

#[tokio::test]
async fn test_tool_result_returns_to_next_independent_context_as_observation() {
    let session_id = "tool_result_later_context";
    let note = NamedTempFile::new_in(".").unwrap();
    std::fs::write(note.path(), "durable tool evidence").unwrap();
    let (bus, store, _orc, client, _tmp) = build_orchestrator_with_config(
        vec![
            Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: "read-durable".to_string(),
                    r#type: "function".to_string(),
                    func_name: "read".to_string(),
                    arguments: json!({
                        "path": note.path().file_name().unwrap().to_string_lossy()
                    })
                    .to_string(),
                }],
            },
            Response {
                content: "first turn done".to_string(),
                tool_calls: Vec::new(),
            },
            Response {
                content: "second turn done".to_string(),
                tool_calls: Vec::new(),
            },
        ],
        morphz::config::OrchestratorConfig::default(),
    )
    .await;

    publish_user(&bus, session_id, "read durable evidence").await;
    assert_eq!(
        wait_for_topic_count(&store, "chat/reply", session_id, 1)
            .await
            .len(),
        1
    );
    publish_user(&bus, session_id, "use prior evidence").await;
    assert_eq!(
        wait_for_topic_count(&store, "chat/reply", session_id, 2)
            .await
            .len(),
        2
    );

    let messages = client.messages_seen();
    assert_eq!(messages.len(), 3);
    assert_eq!(
        messages[2]
            .iter()
            .map(|message| message.role.as_str())
            .collect::<Vec<_>>(),
        vec!["system", "user"]
    );
    assert!(messages[2][1].content.contains("durable tool evidence"));
}

#[tokio::test]
async fn test_empty_tool_output_is_explicit_success_and_does_not_require_retry() {
    let session_id = "empty_tool_result";
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("empty-tool.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    let client = Arc::new(MockClient::new(vec![
        Response {
            content: String::new(),
            tool_calls: vec![ToolCallRepr {
                id: "empty-call".to_string(),
                r#type: "function".to_string(),
                func_name: "empty_output".to_string(),
                arguments: "{}".to_string(),
            }],
        },
        Response {
            content: "empty tool completed".to_string(),
            tool_calls: Vec::new(),
        },
        Response {
            content: "empty tool history recognized".to_string(),
            tool_calls: Vec::new(),
        },
    ]));
    let config = morphz::config::OrchestratorConfig::default();
    let context_engine = Arc::new(ContextEngine::new(
        Arc::clone(&store) as Arc<dyn EventStore>,
        config.clone(),
    ));
    let registry = Arc::new(Registry::new());
    registry.register(Arc::new(EmptyOutputTool));
    let orchestrator = Arc::new(Orchestrator::new_with_context_engine(
        Arc::clone(&bus),
        Arc::clone(&store) as Arc<dyn EventStore>,
        Arc::clone(&client) as Arc<dyn Client>,
        registry,
        config,
        context_engine,
    ));
    orchestrator.start().await.unwrap();

    publish_user(&bus, session_id, "run empty tool once").await;
    assert_eq!(
        wait_for_topic(&store, "chat/reply", session_id).await.len(),
        1
    );
    let messages = client.messages_seen();
    assert_eq!(messages.len(), 2);
    let tool = messages[1]
        .iter()
        .find(|message| message.role == "tool")
        .unwrap();
    let envelope: serde_json::Value = serde_json::from_str(&tool.content).unwrap();
    assert_eq!(envelope["status"], "success");
    assert_eq!(envelope["output_state"], "empty");
    assert_eq!(envelope["result"], "");
    assert!(envelope["guidance"]
        .as_str()
        .unwrap()
        .contains("不要仅因输出为空而重复调用"));
    let outputs = wait_for_topic(&store, "chat/tool_output", session_id).await;
    assert_eq!(outputs.len(), 1);
    assert_eq!(
        outputs[0].payload.get("tool_status"),
        Some(&json!("success"))
    );
    assert_eq!(outputs[0].payload.get("output_empty"), Some(&json!(true)));
    publish_user(&bus, session_id, "inspect prior empty result").await;
    assert_eq!(
        wait_for_topic_count(&store, "chat/reply", session_id, 2)
            .await
            .len(),
        2
    );
    let messages = client.messages_seen();
    assert_eq!(messages.len(), 3);
    assert!(messages[2][1].content.contains("(tool-status success)"));
    assert!(messages[2][1].content.contains("(output-empty true)"));
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
async fn test_deprecated_final_reply_flag_is_ignored_and_tool_loop_continues() {
    let session_id = "attempt_deprecated_context_final_reply";
    let (bus, store, orchestrator, client, _tmp) = build_orchestrator_with_config(
        vec![
            Response {
                content: "我现在提交 Context 收口，稍后给出最终结果。".to_string(),
                tool_calls: vec![ToolCallRepr {
                    id: "context-with-deprecated-final-reply".to_string(),
                    r#type: "function".to_string(),
                    func_name: "context_tx".to_string(),
                    arguments: json!({
                        "session_id": session_id,
                        "transaction": "(context-tx (base-version 0) (reason \"收口\") (create result (result (status completed))) (protect result))",
                        "final_reply": true
                    })
                    .to_string(),
                }],
            },
            Response {
                content: "任务完成，Context 已收口。".to_string(),
                tool_calls: Vec::new(),
            },
        ],
        morphz::config::OrchestratorConfig::default(),
    )
    .await;

    publish_user(&bus, session_id, "finish after context transaction").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    assert_eq!(replies.len(), 1);
    assert_eq!(
        replies[0]
            .payload
            .get("text")
            .and_then(|value| value.as_str()),
        Some("任务完成，Context 已收口。")
    );
    let progress = wait_for_topic(&store, "chat/progress", session_id).await;
    assert_eq!(progress.len(), 1);
    assert_eq!(
        progress[0]
            .payload
            .get("text")
            .and_then(|value| value.as_str()),
        Some("我现在提交 Context 收口，稍后给出最终结果。")
    );
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    assert_eq!(client.tools_seen().len(), 2);
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
async fn test_tool_call_preamble_is_progress_and_does_not_end_the_loop() {
    let session_id = "attempt_context_progress_then_reply";
    let (bus, store, orchestrator, client, _tmp) = build_orchestrator_with_config(
        vec![
            Response {
                content: "我现在执行 Context 维护，稍后给出最终答案。".to_string(),
                tool_calls: vec![ToolCallRepr {
                    id: "context-progress".to_string(),
                    r#type: "function".to_string(),
                    func_name: "context_tx".to_string(),
                    arguments: json!({
                        "session_id": session_id,
                        "transaction": "(context-tx (base-version 0) (create result (status completed)))"
                    })
                    .to_string(),
                }],
            },
            Response {
                content: "最终答案已经完整交付。".to_string(),
                tool_calls: Vec::new(),
            },
        ],
        morphz::config::OrchestratorConfig::default(),
    )
    .await;

    publish_user(&bus, session_id, "maintain with visible progress").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    assert_eq!(replies.len(), 1);
    assert_eq!(
        replies[0]
            .payload
            .get("text")
            .and_then(|value| value.as_str()),
        Some("最终答案已经完整交付。")
    );
    let progress = wait_for_topic(&store, "chat/progress", session_id).await;
    assert_eq!(progress.len(), 1);
    assert_eq!(
        progress[0]
            .payload
            .get("text")
            .and_then(|value| value.as_str()),
        Some("我现在执行 Context 维护，稍后给出最终答案。")
    );
    assert_eq!(client.tools_seen().len(), 2);
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
    let messages = client.messages_seen();
    assert_eq!(messages.len(), 2);
    assert_eq!(
        messages[1]
            .iter()
            .map(|message| message.role.as_str())
            .collect::<Vec<_>>(),
        vec!["system", "user", "assistant", "tool"]
    );
    assert!(messages[1][1].content.contains("(id state)"));
    assert_eq!(messages[1][3].tool_call_id.as_deref(), Some("context-only"));
    let receipt: serde_json::Value = serde_json::from_str(&messages[1][3].content).unwrap();
    assert_eq!(receipt["status"], "success");
    assert_eq!(receipt["observation_ref"], serde_json::Value::Null);
    assert!(receipt["result"]
        .as_str()
        .is_some_and(|result| result.contains("committed")));
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
                content: "Context 事务已修复，正在收口。".to_string(),
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
            Response {
                content: "修复后完成".to_string(),
                tool_calls: Vec::new(),
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
    assert_eq!(tools_seen.len(), 3);
    assert!(tools_seen[1].contains(&"context_tx".to_string()));
    let context = orchestrator
        .get_current_context_view(session_id)
        .await
        .unwrap();
    assert_eq!(context.state.version, 1);
    assert_eq!(context.state.frames[0].id, "repaired");
}

#[tokio::test]
async fn model_native_prompt_count_drives_pressure_before_completion() {
    let session_id = "attempt_native_prompt_pressure";
    let config = morphz::config::OrchestratorConfig {
        context_soft_token_limit: 2_000,
        context_hard_token_limit: 3_000,
        context_maintenance_reserve_tokens: 200,
        ..Default::default()
    };
    let (bus, store, _orchestrator, client, _tmp) = build_orchestrator_with_config(
        vec![Response {
            content: "measured pressure observed".to_string(),
            tool_calls: Vec::new(),
        }],
        config,
    )
    .await;
    client.set_prompt_token_count(2_900);

    publish_user(&bus, session_id, "measure the real prompt").await;
    assert_eq!(
        wait_for_topic(&store, "chat/reply", session_id).await.len(),
        1
    );

    let messages = client.messages_seen();
    assert_eq!(messages.len(), 1);
    assert!(messages[0][1].content.contains("(level critical)"));
    assert!(messages[0][1].content.contains("(estimated-tokens 2900)"));
    assert!(messages[0][1]
        .content
        .contains("(token-source test-native-tokenizer)"));
    assert!(messages[0][1].content.contains("(token-accuracy exact)"));
    assert!(messages[0][1]
        .content
        .contains("(token-scope full-work-prompt)"));
    assert_eq!(client.tools_seen()[0], vec!["context_tx", "reply"]);
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
    assert_eq!(tools_seen[0], vec!["context_tx", "reply"]);
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
    assert_eq!(tools_seen[0], vec!["context_tx", "reply"]);
    assert_eq!(tools_seen[1], vec!["context_tx", "reply"]);
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
        attempt_soft_checkpoint_interval: 4,
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
    assert_eq!(context.turn_budget.attempt, 4);
    assert_eq!(context.turn_budget.phase, "soft-checkpoint");
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

    let (bus, store, _orc, client, _tmp) = build_orchestrator_with_config(
        vec![
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
        ],
        morphz::config::OrchestratorConfig::default(),
    )
    .await;

    publish_user(&bus, session_id, "read three files").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    let tool_outputs = wait_for_topic(&store, "chat/tool_output", session_id).await;

    assert_eq!(replies.len(), 1);
    assert_eq!(tool_outputs.len(), 3);
    let messages = client.messages_seen();
    assert_eq!(messages.len(), 2);
    assert_eq!(
        messages[1]
            .iter()
            .map(|message| message.role.as_str())
            .collect::<Vec<_>>(),
        vec!["system", "user", "assistant", "tool", "tool", "tool"]
    );
    assert_eq!(messages[1][2].tool_calls.as_ref().map(Vec::len), Some(3));
}

#[tokio::test]
async fn test_turn_soft_checkpoint_preserves_tools_and_continues() {
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
        reply_after: 4,
    });
    let config = morphz::config::OrchestratorConfig {
        attempt_soft_checkpoint_interval: 3,
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
    assert_eq!(assistant_calls.len(), 4);
    assert_eq!(tool_outputs.len(), 3);
    assert_eq!(client.calls.load(Ordering::SeqCst), 4);
    assert_eq!(client.tool_counts.lock().unwrap().as_slice(), &[2, 2, 2, 2]);
    assert_eq!(
        replies[0]
            .payload
            .get("text")
            .and_then(|value| value.as_str()),
        Some("soft checkpoint continued")
    );
}

#[tokio::test]
async fn test_soft_checkpoint_allows_context_maintenance_without_forcing_final_reply() {
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
        attempt_soft_checkpoint_interval: 3,
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
    assert!(tools_seen[2].contains(&"read".to_string()));
    assert!(tools_seen[2].contains(&"context_tx".to_string()));
    assert!(tools_seen[2].contains(&"reply".to_string()));
    assert!(tools_seen[3].contains(&"read".to_string()));
    assert!(!tools_seen[3].contains(&"context_tx".to_string()));
    assert!(tools_seen[3].contains(&"reply".to_string()));

    let assistant_calls = wait_for_topic(&store, "chat/assistant_call", session_id).await;
    assert_eq!(assistant_calls.len(), 4);
    assert_eq!(
        assistant_calls[2]
            .payload
            .get("phase")
            .and_then(|value| value.as_str()),
        Some("soft-checkpoint")
    );
    let context = orchestrator
        .get_current_context_view(session_id)
        .await
        .unwrap();
    assert_eq!(context.state.version, 1);
    assert_eq!(context.turn_budget.phase, "work");
    assert!(context.state.frames[0].body.contains("completed"));
    assert!(context.state.frames[0].body.contains("tests-passed"));
}

#[tokio::test]
async fn test_failed_context_tx_at_soft_checkpoint_does_not_force_final_reply() {
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
        attempt_soft_checkpoint_interval: 2,
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
    assert!(client.tools_seen()[1].contains(&"read".to_string()));
    assert!(client.tools_seen()[1].contains(&"context_tx".to_string()));
    assert!(client.tools_seen()[1].contains(&"reply".to_string()));
    assert!(client.tools_seen()[2].contains(&"read".to_string()));
    assert!(client.tools_seen()[2].contains(&"context_tx".to_string()));
    assert!(client.tools_seen()[2].contains(&"reply".to_string()));
    let context = orchestrator
        .get_current_context_view(session_id)
        .await
        .unwrap();
    assert_eq!(context.state.version, 0);
    assert_eq!(context.turn_budget.phase, "soft-checkpoint");
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
    let security = Arc::new(PermissionConfig {
        workspace_root: tmp.path().to_string_lossy().to_string(),
        read_roots: Vec::new(),
        write_roots: Vec::new(),
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
async fn test_delegate_isolates_siblings_returns_to_parent_and_parent_integrates_shared_mind() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("delegate-lifecycle.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    store
        .create_context(NewCognitiveContext {
            id: "delegate-main".to_string(),
            agent_id: "delegate-agent".to_string(),
            title: "Main".to_string(),
        })
        .await
        .unwrap();
    for session_id in ["delegate-a", "delegate-b", "delegate-c"] {
        store
            .create_session(NewSession {
                id: session_id.to_string(),
                agent_id: "delegate-agent".to_string(),
                context_id: "delegate-main".to_string(),
                parent_session_id: None,
                title: session_id.to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        store
            .append(Event::new(
                format!("{session_id}-message"),
                "User".to_string(),
                TYPE_USER_MESSAGE.to_string(),
                "chat/user_message".to_string(),
                vec![
                    ("context_id".to_string(), json!("delegate-main")),
                    ("session_id".to_string(), json!(session_id)),
                    ("text".to_string(), json!(format!("private {session_id}"))),
                ]
                .into_iter()
                .collect(),
            ))
            .await
            .unwrap();
    }
    let config = morphz::config::OrchestratorConfig::default();
    let engine = Arc::new(
        ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone())
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
    );
    engine
        .apply_context_transaction(
            "delegate-main",
            "delegate-c",
            "(context-tx (base-version 0) (create shared-principle (rule parent-verifies)))",
        )
        .await
        .unwrap();
    let client = Arc::new(MockClient::new(vec![
        Response {
            content: "SUB-RESULT-731".to_string(),
            tool_calls: Vec::new(),
        },
        Response {
            content: String::new(),
            tool_calls: vec![ToolCallRepr {
                id: "delegate-integrate".to_string(),
                r#type: "function".to_string(),
                func_name: "context_tx".to_string(),
                arguments: json!({
                    "transaction": "(context-tx (base-version 1) (create delegated-insight (result SUB-RESULT-731)))"
                })
                .to_string(),
            }],
        },
        Response {
            content: "PARENT-INTEGRATED".to_string(),
            tool_calls: Vec::new(),
        },
    ]));
    let registry = Arc::new(Registry::new());
    registry.register(Arc::new(ContextTxTool::new(Arc::clone(&engine))));
    let orchestrator = Arc::new(Orchestrator::new_with_context_engine(
        Arc::clone(&bus),
        Arc::clone(&store) as Arc<dyn EventStore>,
        Arc::clone(&client) as Arc<dyn Client>,
        registry,
        config,
        Arc::clone(&engine),
    ));
    Arc::clone(&orchestrator).start().await.unwrap();

    bus.publish(Event::new(
        "delegate-request-test".to_string(),
        "Parent-Agent-delegate-c".to_string(),
        morphz::event::TYPE_AGENT_CALL.to_string(),
        "chat/delegate".to_string(),
        vec![
            ("context_id".to_string(), json!("delegate-main")),
            ("session_id".to_string(), json!("delegate-c")),
            ("parent_context_id".to_string(), json!("delegate-main")),
            ("parent_session_id".to_string(), json!("delegate-c")),
            ("delegation_id".to_string(), json!("delegation-test")),
            (
                "child_context_id".to_string(),
                json!("delegate-child-context"),
            ),
            (
                "child_session_id".to_string(),
                json!("delegate-child-session"),
            ),
            ("task".to_string(), json!("return the verification token")),
            ("success_when".to_string(), json!("return SUB-RESULT-731")),
            ("context_scope".to_string(), json!("current_session")),
            ("text".to_string(), json!("Delegation requested")),
        ]
        .into_iter()
        .collect(),
    ))
    .await
    .unwrap();

    let parent_replies = wait_for_topic(&store, "chat/reply", "delegate-c").await;
    assert_eq!(parent_replies.len(), 1);
    assert_eq!(
        parent_replies[0].payload.get("text"),
        Some(&json!("PARENT-INTEGRATED"))
    );
    let delegation = store
        .get_delegation("delegation-test")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(delegation.status, DelegationStatus::Completed);
    assert!(delegation.result_event_id.is_some());

    let child = orchestrator
        .get_context_encoding("delegate-child-context", "delegate-child-session")
        .await
        .unwrap();
    assert!(child
        .state
        .frames
        .iter()
        .any(|frame| frame.id == "shared-principle"));
    assert!(child.observations.iter().any(|observation| {
        observation.session_id.as_deref() == Some("delegate-c")
            && observation.preview.contains("private delegate-c")
    }));
    assert!(!child.observations.iter().any(|observation| {
        matches!(
            observation.session_id.as_deref(),
            Some("delegate-a" | "delegate-b")
        )
    }));
    let parent_session_events = store
        .query(QueryFilter {
            session_id: Some("delegate-c".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(!parent_session_events
        .iter()
        .any(|event| event.topic == "context/projected_observation"));

    let main_from_a = orchestrator
        .get_context_encoding("delegate-main", "delegate-a")
        .await
        .unwrap();
    assert!(main_from_a
        .state
        .frames
        .iter()
        .any(|frame| frame.id == "delegated-insight"));
    assert_eq!(client.messages_seen().len(), 3);
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
async fn test_distinct_sessions_fall_back_to_concurrent_evaluations_when_batching_is_disabled() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("shared-context-concurrency.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    let client = Arc::new(ConcurrencyProbeClient {
        active: AtomicUsize::new(0),
        max_active: AtomicUsize::new(0),
        calls: AtomicUsize::new(0),
    });
    let config = morphz::config::OrchestratorConfig {
        merged_evaluation_enabled: false,
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
        Arc::clone(&engine),
    ));
    Arc::clone(&orchestrator).start().await.unwrap();

    tokio::join!(
        publish_user_in_context(&bus, "shared-context", "session-a", "message-a"),
        publish_user_in_context(&bus, "shared-context", "session-b", "message-b"),
    );

    let replies_a = wait_for_topic(&store, "chat/reply", "session-a").await;
    let replies_b = wait_for_topic(&store, "chat/reply", "session-b").await;
    assert_eq!(replies_a.len(), 1);
    assert_eq!(replies_b.len(), 1);
    assert_eq!(client.calls.load(Ordering::SeqCst), 2);
    assert_eq!(client.max_active.load(Ordering::SeqCst), 2);
    assert!(replies_a.iter().chain(&replies_b).all(|event| event
        .payload
        .get("context_id")
        .and_then(|value| value.as_str())
        == Some("shared-context")));

    engine
        .apply_context_transaction(
            "shared-context",
            "session-a",
            "(context-tx (base-version 0) (create shared-fact (value visible-to-all-sessions)))",
        )
        .await
        .unwrap();
    let encoding_b = orchestrator
        .get_context_encoding("shared-context", "session-b")
        .await
        .unwrap();
    assert_eq!(encoding_b.active_session_id, "session-b");
    assert!(encoding_b
        .state
        .frames
        .iter()
        .any(|frame| frame.id == "shared-fact"));
    assert!(encoding_b
        .observations
        .iter()
        .any(|observation| observation.session_id.as_deref() == Some("session-a")));
    assert!(encoding_b
        .observations
        .iter()
        .any(|observation| observation.session_id.as_deref() == Some("session-b")));
    assert!(encoding_b.sexpr.contains("(active-session session-b)"));
    assert!(encoding_b.sexpr.contains("(session session-a)"));
    assert!(encoding_b.sexpr.contains("(session session-b)"));
}

#[tokio::test]
async fn test_ready_sessions_share_one_model_request_and_receive_routed_final_replies() {
    let response = Response {
        content: String::new(),
        tool_calls: vec![ToolCallRepr {
            id: "batch-output-1".to_string(),
            r#type: "function".to_string(),
            func_name: "session_output".to_string(),
            arguments: json!({
                "deliveries": [
                    {"session_id": "batch-session-a", "kind": "final", "text": "reply-a"},
                    {"session_id": "batch-session-b", "kind": "final", "text": "reply-b"}
                ]
            })
            .to_string(),
        }],
    };
    let (bus, store, _orchestrator, client, _tmp) =
        build_orchestrator_with_config(vec![response], deterministic_batch_config()).await;

    tokio::join!(
        publish_user_in_context(&bus, "batch-context", "batch-session-a", "question-a"),
        publish_user_in_context(&bus, "batch-context", "batch-session-b", "question-b"),
    );

    let replies_a = wait_for_topic(&store, "chat/reply", "batch-session-a").await;
    let replies_b = wait_for_topic(&store, "chat/reply", "batch-session-b").await;
    assert_eq!(replies_a.len(), 1);
    assert_eq!(replies_b.len(), 1);
    assert_eq!(replies_a[0].payload.get("text"), Some(&json!("reply-a")));
    assert_eq!(replies_b[0].payload.get("text"), Some(&json!("reply-b")));
    let messages = client.messages_seen();
    assert_eq!(messages.len(), 1);
    assert!(messages[0][1].content.contains("(evaluation-mode batch)"));
    assert!(messages[0][1].content.contains("(ready-sessions"));
    assert!(messages[0][1].content.contains("(work-item @e"));
    assert!(messages[0][1]
        .content
        .contains("(input-preview question-a)"));
    assert!(messages[0][1]
        .content
        .contains("(input-preview question-b)"));
    assert!(client.tools_seen()[0]
        .iter()
        .any(|tool| tool == "session_output"));
}

#[tokio::test]
async fn test_partial_batch_delivery_only_falls_back_the_missing_session() {
    let batch_response = Response {
        content: String::new(),
        tool_calls: vec![ToolCallRepr {
            id: "partial-output".to_string(),
            r#type: "function".to_string(),
            func_name: "session_output".to_string(),
            arguments: json!({
                "deliveries": [
                    {"session_id": "partial-session-a", "kind": "final", "text": "batch-a"}
                ]
            })
            .to_string(),
        }],
    };
    let fallback_response = Response {
        content: "fallback-b".to_string(),
        tool_calls: Vec::new(),
    };
    let (bus, store, _orchestrator, client, _tmp) = build_orchestrator_with_config(
        vec![batch_response, fallback_response],
        deterministic_batch_config(),
    )
    .await;

    tokio::join!(
        publish_user_in_context(&bus, "partial-context", "partial-session-a", "question-a"),
        publish_user_in_context(&bus, "partial-context", "partial-session-b", "question-b"),
    );

    let replies_a = wait_for_topic(&store, "chat/reply", "partial-session-a").await;
    let replies_b = wait_for_topic(&store, "chat/reply", "partial-session-b").await;
    assert_eq!(replies_a.len(), 1);
    assert_eq!(replies_b.len(), 1);
    assert_eq!(replies_a[0].payload.get("text"), Some(&json!("batch-a")));
    assert_eq!(replies_b[0].payload.get("text"), Some(&json!("fallback-b")));
    assert_eq!(client.messages_seen().len(), 2);
}

#[tokio::test]
async fn test_batch_can_finish_one_session_while_another_updates_shared_mind() {
    let batch_response = Response {
        content: String::new(),
        tool_calls: vec![
            ToolCallRepr {
                id: "mixed-output".to_string(),
                r#type: "function".to_string(),
                func_name: "session_output".to_string(),
                arguments: json!({
                    "deliveries": [
                        {"session_id": "mixed-session-a", "kind": "progress", "text": "updating shared mind"},
                        {"session_id": "mixed-session-b", "kind": "final", "text": "b-finished"}
                    ]
                })
                .to_string(),
            },
            ToolCallRepr {
                id: "mixed-context-tx".to_string(),
                r#type: "function".to_string(),
                func_name: "context_tx".to_string(),
                arguments: json!({
                    "session_id": "mixed-session-a",
                    "transaction": "(context-tx (base-version 0) (create batch-fact (value shared)))"
                })
                .to_string(),
            },
        ],
    };
    let after_transaction = Response {
        content: "a-finished".to_string(),
        tool_calls: Vec::new(),
    };
    let (bus, store, orchestrator, client, _tmp) = build_orchestrator_with_config(
        vec![batch_response, after_transaction],
        deterministic_batch_config(),
    )
    .await;

    tokio::join!(
        publish_user_in_context(&bus, "mixed-context", "mixed-session-a", "remember a fact"),
        publish_user_in_context(
            &bus,
            "mixed-context",
            "mixed-session-b",
            "answer immediately"
        ),
    );

    let replies_a = wait_for_topic(&store, "chat/reply", "mixed-session-a").await;
    let replies_b = wait_for_topic(&store, "chat/reply", "mixed-session-b").await;
    assert_eq!(replies_a.len(), 1);
    assert_eq!(replies_b.len(), 1);
    assert_eq!(replies_a[0].payload.get("text"), Some(&json!("a-finished")));
    assert_eq!(replies_b[0].payload.get("text"), Some(&json!("b-finished")));
    assert_eq!(client.messages_seen().len(), 2);
    let view = orchestrator
        .get_context_encoding("mixed-context", "mixed-session-b")
        .await
        .unwrap();
    assert!(view
        .state
        .frames
        .iter()
        .any(|frame| frame.id == "batch-fact"));
}

#[tokio::test]
async fn test_batch_physical_tool_route_is_removed_before_execution_and_wakes_only_owner() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("batch-tool-routing.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    let client = Arc::new(MockClient::new(vec![
        Response {
            content: String::new(),
            tool_calls: vec![
                ToolCallRepr {
                    id: "route-progress".to_string(),
                    r#type: "function".to_string(),
                    func_name: "session_output".to_string(),
                    arguments: json!({
                        "deliveries": [
                            {"session_id": "route-session-a", "kind": "progress", "text": "running probe"},
                            {"session_id": "route-session-b", "kind": "final", "text": "b-complete"}
                        ]
                    })
                    .to_string(),
                },
                ToolCallRepr {
                    id: "route-call".to_string(),
                    r#type: "function".to_string(),
                    func_name: "route_probe".to_string(),
                    arguments: json!({
                        "session_id": "route-session-a",
                        "value": "owned-by-a"
                    })
                    .to_string(),
                },
            ],
        },
        Response {
            content: "a-complete".to_string(),
            tool_calls: Vec::new(),
        },
    ]));
    let config = deterministic_batch_config();
    let engine = Arc::new(ContextEngine::new(
        Arc::clone(&store) as Arc<dyn EventStore>,
        config.clone(),
    ));
    let routed_arguments = Arc::new(Mutex::new(Vec::new()));
    let registry = Arc::new(Registry::new());
    registry.register(Arc::new(RoutingProbeTool {
        arguments: Arc::clone(&routed_arguments),
        delay_ms: 150,
    }));
    let orchestrator = Arc::new(Orchestrator::new_with_context_engine(
        Arc::clone(&bus),
        Arc::clone(&store) as Arc<dyn EventStore>,
        Arc::clone(&client) as Arc<dyn Client>,
        registry,
        config,
        engine,
    ));
    Arc::clone(&orchestrator).start().await.unwrap();

    tokio::join!(
        publish_user_in_context(&bus, "route-context", "route-session-a", "run a tool"),
        publish_user_in_context(&bus, "route-context", "route-session-b", "reply now"),
    );

    let replies_a = wait_for_topic(&store, "chat/reply", "route-session-a").await;
    let replies_b = wait_for_topic(&store, "chat/reply", "route-session-b").await;
    assert_eq!(replies_a[0].payload.get("text"), Some(&json!("a-complete")));
    assert_eq!(replies_b[0].payload.get("text"), Some(&json!("b-complete")));
    assert_eq!(
        routed_arguments.lock().unwrap().as_slice(),
        &[json!({"value": "owned-by-a"})]
    );
    let outputs_a = store
        .query(QueryFilter {
            session_id: Some("route-session-a".to_string()),
            types: vec![TYPE_TOOL_OUTPUT.to_string()],
            ..Default::default()
        })
        .await
        .unwrap();
    let outputs_b = store
        .query(QueryFilter {
            session_id: Some("route-session-b".to_string()),
            types: vec![TYPE_TOOL_OUTPUT.to_string()],
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(outputs_a.iter().any(|event| event
        .payload
        .get("tool_name")
        .and_then(|value| value.as_str())
        == Some("route_probe")));
    let routed_output = outputs_a
        .iter()
        .find(|event| {
            event
                .payload
                .get("tool_name")
                .and_then(|value| value.as_str())
                == Some("route_probe")
        })
        .unwrap();
    assert!(replies_b[0].timestamp < routed_output.timestamp);
    assert!(!outputs_b.iter().any(|event| event
        .payload
        .get("tool_name")
        .and_then(|value| value.as_str())
        == Some("route_probe")));
}

#[tokio::test]
async fn test_two_tool_result_lanes_merge_again_into_one_followup_model_request() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("batch-tool-followup.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    let client = Arc::new(MockClient::new(vec![
        Response {
            content: String::new(),
            tool_calls: vec![
                ToolCallRepr {
                    id: "follow-progress".to_string(),
                    r#type: "function".to_string(),
                    func_name: "session_output".to_string(),
                    arguments: json!({
                        "deliveries": [
                            {"session_id": "follow-session-a", "kind": "progress", "text": "tool-a"},
                            {"session_id": "follow-session-b", "kind": "progress", "text": "tool-b"}
                        ]
                    })
                    .to_string(),
                },
                ToolCallRepr {
                    id: "follow-call-a".to_string(),
                    r#type: "function".to_string(),
                    func_name: "route_probe".to_string(),
                    arguments: json!({"session_id": "follow-session-a", "value": "a"})
                        .to_string(),
                },
                ToolCallRepr {
                    id: "follow-call-b".to_string(),
                    r#type: "function".to_string(),
                    func_name: "route_probe".to_string(),
                    arguments: json!({"session_id": "follow-session-b", "value": "b"})
                        .to_string(),
                },
            ],
        },
        Response {
            content: String::new(),
            tool_calls: vec![ToolCallRepr {
                id: "follow-final".to_string(),
                r#type: "function".to_string(),
                func_name: "session_output".to_string(),
                arguments: json!({
                    "deliveries": [
                        {"session_id": "follow-session-a", "kind": "final", "text": "done-a"},
                        {"session_id": "follow-session-b", "kind": "final", "text": "done-b"}
                    ]
                })
                .to_string(),
            }],
        },
    ]));
    let config = deterministic_batch_config();
    let engine = Arc::new(ContextEngine::new(
        Arc::clone(&store) as Arc<dyn EventStore>,
        config.clone(),
    ));
    let routed_arguments = Arc::new(Mutex::new(Vec::new()));
    let registry = Arc::new(Registry::new());
    registry.register(Arc::new(RoutingProbeTool {
        arguments: Arc::clone(&routed_arguments),
        delay_ms: 20,
    }));
    let orchestrator = Arc::new(Orchestrator::new_with_context_engine(
        Arc::clone(&bus),
        Arc::clone(&store) as Arc<dyn EventStore>,
        Arc::clone(&client) as Arc<dyn Client>,
        registry,
        config,
        engine,
    ));
    Arc::clone(&orchestrator).start().await.unwrap();

    tokio::join!(
        publish_user_in_context(&bus, "follow-context", "follow-session-a", "task-a"),
        publish_user_in_context(&bus, "follow-context", "follow-session-b", "task-b"),
    );

    let replies_a = wait_for_topic(&store, "chat/reply", "follow-session-a").await;
    let replies_b = wait_for_topic(&store, "chat/reply", "follow-session-b").await;
    assert_eq!(replies_a[0].payload.get("text"), Some(&json!("done-a")));
    assert_eq!(replies_b[0].payload.get("text"), Some(&json!("done-b")));
    let messages = client.messages_seen();
    assert_eq!(messages.len(), 2);
    let followup_tools = messages[1]
        .iter()
        .filter(|message| message.role == "tool")
        .collect::<Vec<_>>();
    let followup_assistant_calls = messages[1]
        .iter()
        .filter(|message| message.role == "assistant")
        .flat_map(|message| message.tool_calls.iter().flatten())
        .collect::<Vec<_>>();
    assert_eq!(followup_assistant_calls.len(), 2);
    assert!(followup_assistant_calls.iter().all(|call| {
        call.function.arguments.contains("session_id")
            && (call.function.arguments.contains("follow-session-a")
                || call.function.arguments.contains("follow-session-b"))
    }));
    assert_eq!(followup_tools.len(), 2);
    assert!(followup_tools
        .iter()
        .any(|message| message.content.contains("follow-session-a")));
    assert!(followup_tools
        .iter()
        .any(|message| message.content.contains("follow-session-b")));
    assert_eq!(routed_arguments.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn test_omitted_tool_result_lane_is_forced_through_single_fallback() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("batch-tool-fallback.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    let client = Arc::new(MockClient::new(vec![
        Response {
            content: String::new(),
            tool_calls: vec![
                ToolCallRepr {
                    id: "fallback-progress".to_string(),
                    r#type: "function".to_string(),
                    func_name: "session_output".to_string(),
                    arguments: json!({
                        "deliveries": [
                            {"session_id": "fallback-tool-a", "kind": "progress", "text": "tool-a"},
                            {"session_id": "fallback-tool-b", "kind": "progress", "text": "tool-b"}
                        ]
                    })
                    .to_string(),
                },
                ToolCallRepr {
                    id: "fallback-call-a".to_string(),
                    r#type: "function".to_string(),
                    func_name: "route_probe".to_string(),
                    arguments: json!({"session_id": "fallback-tool-a", "value": "a"}).to_string(),
                },
                ToolCallRepr {
                    id: "fallback-call-b".to_string(),
                    r#type: "function".to_string(),
                    func_name: "route_probe".to_string(),
                    arguments: json!({"session_id": "fallback-tool-b", "value": "b"}).to_string(),
                },
            ],
        },
        Response {
            content: String::new(),
            tool_calls: vec![ToolCallRepr {
                id: "fallback-only-a".to_string(),
                r#type: "function".to_string(),
                func_name: "session_output".to_string(),
                arguments: json!({
                    "deliveries": [
                        {"session_id": "fallback-tool-a", "kind": "final", "text": "done-a"}
                    ]
                })
                .to_string(),
            }],
        },
        Response {
            content: "done-b".to_string(),
            tool_calls: Vec::new(),
        },
    ]));
    let config = deterministic_batch_config();
    let engine = Arc::new(ContextEngine::new(
        Arc::clone(&store) as Arc<dyn EventStore>,
        config.clone(),
    ));
    let registry = Arc::new(Registry::new());
    registry.register(Arc::new(RoutingProbeTool {
        arguments: Arc::new(Mutex::new(Vec::new())),
        delay_ms: 20,
    }));
    let orchestrator = Arc::new(Orchestrator::new_with_context_engine(
        Arc::clone(&bus),
        Arc::clone(&store) as Arc<dyn EventStore>,
        Arc::clone(&client) as Arc<dyn Client>,
        registry,
        config,
        engine,
    ));
    Arc::clone(&orchestrator).start().await.unwrap();

    tokio::join!(
        publish_user_in_context(&bus, "fallback-context", "fallback-tool-a", "task-a"),
        publish_user_in_context(&bus, "fallback-context", "fallback-tool-b", "task-b"),
    );

    let replies_a = wait_for_topic(&store, "chat/reply", "fallback-tool-a").await;
    let replies_b = wait_for_topic(&store, "chat/reply", "fallback-tool-b").await;
    assert_eq!(replies_a[0].payload.get("text"), Some(&json!("done-a")));
    assert_eq!(replies_b[0].payload.get("text"), Some(&json!("done-b")));
    let messages = client.messages_seen();
    assert_eq!(messages.len(), 3);
    assert!(messages[2]
        .iter()
        .any(|message| { message.role == "tool" && message.content.contains("fallback-tool-b") }));

    let evaluations = store
        .query(QueryFilter {
            topic: Some("runtime/batch_evaluation".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(evaluations.iter().any(|event| {
        event
            .payload
            .get("fallback_sessions")
            .and_then(|value| value.as_array())
            .is_some_and(|sessions| sessions.iter().any(|value| value == "fallback-tool-b"))
    }));
}

#[tokio::test]
async fn test_cancelling_one_batch_lane_does_not_cancel_other_session_delivery() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("batch-cancel.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    let client = Arc::new(SlowBatchClient {
        started: AtomicUsize::new(0),
    });
    let config = deterministic_batch_config();
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
    Arc::clone(&orchestrator).start().await.unwrap();

    let bus_a = Arc::clone(&bus);
    let bus_b = Arc::clone(&bus);
    let send_a = tokio::spawn(async move {
        publish_user_in_context(
            &bus_a,
            "cancel-batch-context",
            "cancel-batch-a",
            "message-a",
        )
        .await;
    });
    let send_b = tokio::spawn(async move {
        publish_user_in_context(
            &bus_b,
            "cancel-batch-context",
            "cancel-batch-b",
            "message-b",
        )
        .await;
    });
    for _ in 0..100 {
        if client.started.load(Ordering::SeqCst) > 0 {
            break;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
    }
    assert!(orchestrator.cancel_session("cancel-batch-a"));
    send_a.await.unwrap();
    send_b.await.unwrap();

    let replies_b = wait_for_topic(&store, "chat/reply", "cancel-batch-b").await;
    assert_eq!(replies_b.len(), 1);
    assert_eq!(replies_b[0].payload.get("text"), Some(&json!("b-survives")));
    let replies_a = store
        .query(QueryFilter {
            session_id: Some("cancel-batch-a".to_string()),
            topic: Some("chat/reply".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(replies_a.is_empty());
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
