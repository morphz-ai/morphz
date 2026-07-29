use morphz::context_tools::ContextTxTool;
use morphz::event::{
    Event, InMemoryEventBus, TYPE_FILE_CHANGE, TYPE_TOOL_OUTPUT, TYPE_USER_MESSAGE,
};
use morphz::llm::{
    Client, Message, ModelFailure, ModelFailureKind, ModelStreamEvent, ModelStreamSender,
    PromptTokenAccuracy, PromptTokenCount, Response, ToolCallRepr, ToolDefinition,
};
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{
    ActionGroupFilter, ActionGroupStatus, ActionGroupStore as _, ActivationStore as _,
    DelegationStatus, DelegationStore as _, EventStore, NewAgent, NewCognitiveContext, NewSession,
    NewThread, NewThreadActivation, QueryFilter, SessionDirectoryStore as _, SessionMountKind,
    SessionProjectionStore, SessionStore, ThreadActivationMutation, ThreadActivationStatus,
    ThreadKind, ThreadLifecycle, ThreadStore as _, TimerStore,
};
use morphz::orchestrator::context::ContextEngine;
use morphz::orchestrator::orchestrator::Orchestrator;
use morphz::permission::PermissionConfig;
use morphz::sexpr::{parse, SExpr};
use morphz::timer::TimerEngine;
use morphz::tool::{DelegateTool, EditFileTool, ReadFileTool, Registry, Tool, WriteFileTool};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tempfile::{NamedTempFile, TempDir};

struct MockClient {
    responses: Mutex<VecDeque<Response>>,
    tools_seen: Mutex<Vec<Vec<String>>>,
    messages_seen: Mutex<Vec<Vec<Message>>>,
    prompt_token_count: Mutex<Option<usize>>,
    delivery_calls: AtomicUsize,
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

struct AsyncCancellationClient {
    dropped: Arc<AtomicBool>,
}

struct CancellationDropProbe(Arc<AtomicBool>);

impl Drop for CancellationDropProbe {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

struct CancellableClient {
    calls: AtomicUsize,
}

struct ReasoningContinuationClient {
    calls: AtomicUsize,
    messages_seen: Mutex<Vec<Vec<Message>>>,
}

struct SharedTransientFailureClient {
    calls: AtomicUsize,
    health_probe_calls: AtomicUsize,
    initial_barrier: tokio::sync::Barrier,
}

struct PartialReasoningProviderFailureClient {
    calls: AtomicUsize,
}

struct ConcurrentContextLimitClient {
    calls: AtomicUsize,
    initial_failures: AtomicUsize,
    initial_barrier: tokio::sync::Barrier,
    maintenance_calls: AtomicUsize,
}

struct EmptyOutputTool;

struct RoutingProbeTool {
    arguments: Arc<Mutex<Vec<serde_json::Value>>>,
    delay_ms: u64,
}

struct DelayedContextTxTool {
    started: Arc<AtomicUsize>,
    delay_ms: u64,
}

fn text_reply_response(content: impl Into<String>) -> Response {
    Response {
        content: content.into(),
        tool_calls: Vec::new(),
    }
}

fn no_reply_response() -> Response {
    Response {
        content: String::new(),
        tool_calls: vec![ToolCallRepr {
            id: "no-reply".to_string(),
            r#type: "function".to_string(),
            func_name: "no_reply".to_string(),
            arguments: json!({"mode":"silent"}).to_string(),
        }],
    }
}

fn wait_response() -> Response {
    Response {
        content: String::new(),
        tool_calls: vec![ToolCallRepr {
            id: "wait".to_string(),
            r#type: "function".to_string(),
            func_name: "no_reply".to_string(),
            arguments: json!({"mode":"wait"}).to_string(),
        }],
    }
}

fn pending_delivery_response(messages: &[Message]) -> Option<Response> {
    let encoded = messages
        .iter()
        .find(|message| {
            message.role == "user" && message.content.contains("(mode completion-delivery)")
        })?
        .content
        .as_str();
    let expression = parse(&encoded[encoded.find('(')?..]).ok()?;
    let mut results = Vec::new();
    collect_pending_thread_results(&expression, &mut results);
    Some(text_reply_response(if results.is_empty() {
        "完成结果已由另一个交付求值处理".to_string()
    } else {
        results.join("\n")
    }))
}

fn collect_pending_thread_results(expression: &SExpr, results: &mut Vec<String>) {
    let SExpr::List(items) = expression else {
        return;
    };
    if items.first() == Some(&SExpr::Atom("thread".to_string())) {
        let mut delivery = None;
        let mut result = None;
        for item in items.iter().skip(1) {
            let SExpr::List(pair) = item else {
                continue;
            };
            match pair.as_slice() {
                [SExpr::Atom(key), SExpr::Atom(value)] if key == "delivery" => {
                    delivery = Some(value.as_str())
                }
                [SExpr::Atom(key), SExpr::Atom(value)] if key == "result" => {
                    result = Some(value.clone())
                }
                _ => {}
            }
        }
        if matches!(delivery, Some("pending" | "deferred")) {
            if let Some(result) = result {
                results.push(result);
            }
        }
    }
    for item in items {
        collect_pending_thread_results(item, results);
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
impl Tool for DelayedContextTxTool {
    fn name(&self) -> &str {
        "context_tx"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().to_string(),
            description: "Delayed context maintenance test tool".to_string(),
            parameters: json!({
                "type": "object",
                "properties": { "transaction": { "type": "string" } },
                "required": ["transaction"]
            }),
        }
    }

    async fn execute(
        &self,
        _arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        self.started.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(tokio::time::Duration::from_millis(self.delay_ms)).await;
        Ok(json!({ "status": "committed", "after_version": 1 }).to_string())
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
impl Client for SharedTransientFailureClient {
    fn provider_resource_key(&self) -> String {
        "model-provider:test-shared-outage".to_string()
    }

    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        if call < 2 {
            self.initial_barrier.wait().await;
        }
        Err(Box::new(
            ModelFailure::new(
                ModelFailureKind::TransientNetwork,
                "simulated shared provider outage",
            )
            .with_retry_after(Some(1)),
        ))
    }

    async fn probe_health(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.health_probe_calls.fetch_add(1, Ordering::SeqCst);
        Err(Box::new(ModelFailure::new(
            ModelFailureKind::TransientNetwork,
            "simulated independent health probe failure",
        )))
    }
}

#[async_trait::async_trait]
impl Client for PartialReasoningProviderFailureClient {
    fn provider_resource_key(&self) -> String {
        "model-provider:test-partial-reasoning-outage".to_string()
    }

    fn supports_async_cancellation(&self) -> bool {
        true
    }

    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        unreachable!("partial reasoning failure probe uses streaming")
    }

    async fn create_completion_measured_stream(
        &self,
        _messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
        _measurement: Option<PromptTokenCount>,
        stream: ModelStreamSender,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let _ = stream.send(ModelStreamEvent::Started);
        let _ = stream.send(ModelStreamEvent::ReasoningSummaryDelta {
            text: "provider emitted useful partial reasoning before disconnect".to_string(),
        });
        let failure = ModelFailure::new(
            ModelFailureKind::TransientNetwork,
            "simulated disconnect after partial reasoning",
        );
        let _ = stream.send(ModelStreamEvent::Failed {
            message: failure.message.clone(),
        });
        Err(Box::new(failure))
    }
}

#[async_trait::async_trait]
impl Client for ConcurrentContextLimitClient {
    async fn create_completion(
        &self,
        messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let critical_maintenance = messages.iter().any(|message| {
            message
                .content
                .contains("Runtime 当前进入 critical-maintenance：")
        });
        if critical_maintenance {
            self.maintenance_calls.fetch_add(1, Ordering::SeqCst);
            return Ok(Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: "provider-overflow-maintenance".to_string(),
                    r#type: "function".to_string(),
                    func_name: "context_tx".to_string(),
                    arguments: json!({
                        "transaction": "(context-tx (base-version 0) (reason \"recover provider context overflow\") (create provider-overflow-recovered (status complete)))"
                    })
                    .to_string(),
                }],
            });
        }

        let failure = self.initial_failures.fetch_add(1, Ordering::SeqCst);
        if failure < 2 {
            self.initial_barrier.wait().await;
            return Err(Box::new(ModelFailure::new(
                ModelFailureKind::ContextLimit,
                "simulated provider context_length_exceeded",
            )));
        }
        Ok(text_reply_response(
            "continued after shared context maintenance",
        ))
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
impl Client for AsyncCancellationClient {
    fn supports_async_cancellation(&self) -> bool {
        true
    }

    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        let _drop_probe = CancellationDropProbe(Arc::clone(&self.dropped));
        std::future::pending::<()>().await;
        unreachable!("orchestrator deadline must drop the cancellable client future")
    }
}

#[async_trait::async_trait]
impl Client for CancellableClient {
    fn supports_async_cancellation(&self) -> bool {
        true
    }

    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            unreachable!("first attempt must be cancelled")
        }
        Ok(text_reply_response("resumed-after-cancel"))
    }
}

#[async_trait::async_trait]
impl Client for ReasoningContinuationClient {
    fn supports_async_cancellation(&self) -> bool {
        true
    }

    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        unreachable!("reasoning continuation probe uses the streaming entrypoint")
    }

    async fn create_completion_measured_stream(
        &self,
        messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
        _measurement: Option<PromptTokenCount>,
        stream: ModelStreamSender,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        self.messages_seen.lock().unwrap().push(messages);
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        let _ = stream.send(ModelStreamEvent::Started);
        if call < 3 {
            let _ = stream.send(ModelStreamEvent::ReasoningSummaryDelta {
                text: format!("reasoning segment {}", call + 1),
            });
            let _ = stream.send(ModelStreamEvent::Usage {
                usage: morphz::llm::ModelUsage {
                    input_tokens: Some(100),
                    output_tokens: Some(4_096),
                    total_tokens: Some(4_196),
                    ..Default::default()
                },
            });
            // Model adapters reject an otherwise-completed response with no
            // final text or tool call.  This is a reasoning-only boundary,
            // not a broken Provider stream: Runtime must feed this segment
            // back into the immediately following continuation request.
            let _ = stream.send(ModelStreamEvent::ReasoningSummaryCompleted);
            let _ = stream.send(ModelStreamEvent::Completed);
            return Err("模型响应既没有非空正文，也没有工具调用".into());
        }
        let response = text_reply_response("continued into final text");
        let _ = stream.send(ModelStreamEvent::ReasoningSummaryDelta {
            text: "second reasoning segment".to_string(),
        });
        let _ = stream.send(ModelStreamEvent::TextDelta {
            text: response.content.clone(),
        });
        let _ = stream.send(ModelStreamEvent::Completed);
        Ok(response)
    }
}

#[async_trait::async_trait]
impl Client for BudgetProbeClient {
    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        if let Some(response) = pending_delivery_response(&_messages) {
            return Ok(response);
        }
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        self.tool_counts
            .lock()
            .map_err(|_| "budget probe mutex poisoned")?
            .push(tools.len());
        if call >= self.reply_after {
            return Ok(text_reply_response("soft checkpoint continued"));
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
        messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        if let Some(response) = pending_delivery_response(&messages) {
            return Ok(response);
        }
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_active.fetch_max(active, Ordering::SeqCst);
        // Keep the probe open long enough for the second independently routed
        // Session to enter even under a fully loaded test runner.
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        self.active.fetch_sub(1, Ordering::SeqCst);
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        Ok(text_reply_response(format!("reply-{call}")))
    }
}

impl MockClient {
    fn new(responses: Vec<Response>) -> Self {
        Self {
            responses: Mutex::new(VecDeque::from(responses)),
            tools_seen: Mutex::new(Vec::new()),
            messages_seen: Mutex::new(Vec::new()),
            prompt_token_count: Mutex::new(None),
            delivery_calls: AtomicUsize::new(0),
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

    fn delivery_calls(&self) -> usize {
        self.delivery_calls.load(Ordering::SeqCst)
    }
}

fn new_test_orchestrator(
    bus: Arc<InMemoryEventBus>,
    store: Arc<SqliteStore>,
    client: Arc<dyn Client>,
    registry: Arc<Registry>,
    config: morphz::config::OrchestratorConfig,
    context_engine: Arc<ContextEngine>,
) -> Arc<Orchestrator> {
    // Production terminal delivery is driven by the durable TimerEngine. Keep
    // integration fixtures on the same execution path instead of relying on an
    // inline delivery fallback that does not exist in Runtime.
    let timers = Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>));
    Orchestrator::new_test_with_context_engine(
        bus,
        Arc::clone(&store) as Arc<dyn EventStore>,
        store as Arc<dyn morphz::memory::ActionGroupStore>,
        client,
        registry,
        config,
        context_engine,
        Arc::clone(&timers),
    )
    .unwrap()
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
            calibration_shape: Some(1),
        }))
    }

    async fn create_completion(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        if let Some(response) = pending_delivery_response(&messages) {
            self.delivery_calls.fetch_add(1, Ordering::SeqCst);
            return Ok(response);
        }
        let tool_names = tools.into_iter().map(|tool| tool.name).collect::<Vec<_>>();
        self.tools_seen
            .lock()
            .map_err(|_| "mock tools mutex poisoned")?
            .push(tool_names);
        self.messages_seen
            .lock()
            .map_err(|_| "mock messages mutex poisoned")?
            .push(messages);
        let response = self
            .responses
            .lock()
            .map_err(|_| "mock response mutex poisoned")?
            .pop_front()
            .ok_or("mock response queue exhausted")?;
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
    mut orchestrator_config: morphz::config::OrchestratorConfig,
    _auto_reply: bool,
) -> (
    Arc<InMemoryEventBus>,
    Arc<SqliteStore>,
    Arc<Orchestrator>,
    Arc<MockClient>,
    TempDir,
) {
    // Most integration assertions intentionally inspect the exact model request. Production
    // defaults to compact, content-addressed audit records; tests opt into the diagnostic form.
    orchestrator_config.persist_full_context_inspect = true;
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("attempt_loop.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    install_test_session_registry(&bus, &store);
    let client = Arc::new(MockClient::new(responses));
    let context_engine = Arc::new(
        ContextEngine::new(
            Arc::clone(&store) as Arc<dyn EventStore>,
            orchestrator_config.clone(),
        )
        .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
    );

    let registry = Arc::new(Registry::new());
    registry.register(Arc::new(ReadFileTool::default()));
    registry.register(Arc::new(WriteFileTool::default()));
    registry.register(Arc::new(ContextTxTool::new(Arc::clone(&context_engine))));
    registry.register(Arc::new(morphz::sexpr_eval::EvalTool::with_default_tools(
        Arc::clone(&registry),
    )));

    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        Arc::clone(&client) as Arc<dyn Client>,
        registry,
        orchestrator_config,
        context_engine,
    );
    orchestrator.clone().start().await.unwrap();
    (bus, store, orchestrator, client, tmp)
}

fn install_test_session_registry(bus: &Arc<InMemoryEventBus>, store: &Arc<SqliteStore>) {
    let store = Arc::clone(store);
    bus.subscribe(
        "*".to_string(),
        Arc::new(move |event| {
            let store = Arc::clone(&store);
            Box::pin(async move {
                if !matches!(
                    event.event_type.as_str(),
                    TYPE_USER_MESSAGE | TYPE_TOOL_OUTPUT
                ) {
                    return Ok(());
                }
                let Some(session_id) = event
                    .payload
                    .get("session_id")
                    .and_then(|value| value.as_str())
                else {
                    return Ok(());
                };
                let context_id = event
                    .payload
                    .get("context_id")
                    .and_then(|value| value.as_str())
                    .unwrap_or(session_id);
                let agent_id = "test-agent";
                store
                    .ensure_agent(NewAgent {
                        id: agent_id.to_string(),
                        title: "Test Agent".to_string(),
                        root_context_id: context_id.to_string(),
                    })
                    .await?;
                store
                    .ensure_context(NewCognitiveContext {
                        id: context_id.to_string(),
                        agent_id: agent_id.to_string(),
                        title: context_id.to_string(),
                    })
                    .await?;
                store
                    .ensure_session(NewSession {
                        id: session_id.to_string(),
                        agent_id: agent_id.to_string(),
                        context_id: context_id.to_string(),
                        parent_session_id: None,
                        title: session_id.to_string(),
                        mount_kind: SessionMountKind::ExistingContext,
                    })
                    .await?;
                Ok(())
            })
        }),
    );
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
            ("context_id".to_string(), json!(session_id)),
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

async fn wait_for_context_terminal_count(
    store: &Arc<SqliteStore>,
    context_id: &str,
    expected: usize,
) -> Vec<Event> {
    for _ in 0..80 {
        let events = store
            .query(QueryFilter {
                context_id: Some(context_id.to_string()),
                ..Default::default()
            })
            .await
            .unwrap()
            .into_iter()
            .filter(|event| matches!(event.topic.as_str(), "chat/reply" | "chat/no_reply"))
            .collect::<Vec<_>>();
        if events.len() >= expected {
            return events;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    }
    Vec::new()
}

#[tokio::test]
async fn test_attempt_loop_plain_text_reply_delivers() {
    let session_id = "attempt_plain_text_reply";
    let (bus, store, _orc, _tmp) =
        build_orchestrator(vec![text_reply_response("hello user")]).await;

    publish_user(&bus, session_id, "hello").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;

    assert_eq!(replies.len(), 1);
    assert_eq!(
        replies[0].payload.get("text").and_then(|v| v.as_str()),
        Some("hello user")
    );
}

#[tokio::test]
async fn duplicate_routed_event_creates_one_activation_and_one_reply() {
    let session_id = "duplicate-routed-event";
    let (bus, store, _orchestrator, client, _tmp) = build_orchestrator_with_config(
        vec![text_reply_response("exactly once")],
        morphz::config::OrchestratorConfig::default(),
    )
    .await;
    let event = Event::new(
        "duplicate-trigger".to_string(),
        "Test-User".to_string(),
        TYPE_USER_MESSAGE.to_string(),
        "chat/user_message".to_string(),
        vec![
            ("context_id".to_string(), json!(session_id)),
            ("session_id".to_string(), json!(session_id)),
            ("text".to_string(), json!("run once")),
        ]
        .into_iter()
        .collect(),
    );
    let (first, second) = tokio::join!(bus.publish(event.clone()), bus.publish(event));
    first.unwrap();
    second.unwrap();
    assert_eq!(
        wait_for_topic(&store, "chat/reply", session_id).await.len(),
        1
    );
    assert_eq!(client.messages_seen().len(), 1);
    assert_eq!(
        store
            .list_context_thread_activations(session_id, true)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn runtime_start_resumes_unfinished_dialogue_activations() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("activation-recovery.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    store
        .create_agent_bundle(
            NewAgent {
                id: "recovery-agent".to_string(),
                title: "Recovery Agent".to_string(),
                root_context_id: "recovery-context".to_string(),
            },
            NewCognitiveContext {
                id: "recovery-context".to_string(),
                agent_id: "recovery-agent".to_string(),
                title: "Recovery Context".to_string(),
            },
            NewSession {
                id: "recovery-queued".to_string(),
                agent_id: "recovery-agent".to_string(),
                context_id: "recovery-context".to_string(),
                parent_session_id: None,
                title: "Queued".to_string(),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await
        .unwrap();
    let recovery_sessions = vec![
        "recovery-queued",
        "recovery-expired",
        "recovery-unexpired-lease",
    ];
    for session_id in recovery_sessions.iter().skip(1) {
        store
            .create_session(NewSession {
                id: (*session_id).to_string(),
                agent_id: "recovery-agent".to_string(),
                context_id: "recovery-context".to_string(),
                parent_session_id: None,
                title: (*session_id).to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
    }
    for (index, session_id) in recovery_sessions.iter().copied().enumerate() {
        let event = Event::new(
            format!("recovery-trigger-{index}"),
            "Test-User".to_string(),
            TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            vec![
                ("context_id".to_string(), json!("recovery-context")),
                ("session_id".to_string(), json!(session_id)),
                ("text".to_string(), json!(format!("recover {index}"))),
            ]
            .into_iter()
            .collect(),
        );
        store.append(event.clone()).await.unwrap();
        let sequence = store
            .query(QueryFilter {
                session_id: Some(session_id.to_string()),
                ..Default::default()
            })
            .await
            .unwrap()[0]
            .sequence
            .unwrap();
        store
            .ensure_thread(NewThread {
                id: format!("recovery-thread-{index}"),
                agent_id: "recovery-agent".to_string(),
                context_id: "recovery-context".to_string(),
                session_id: session_id.to_string(),
                initiating_principal_id: None,
                root_turn_id: event.id.clone(),
                kind: ThreadKind::DialogueTurn,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
            })
            .await
            .unwrap();
        let activation = store
            .ensure_thread_activation(NewThreadActivation {
                id: format!("recovery-work-{index}"),
                agent_id: "recovery-agent".to_string(),
                context_id: "recovery-context".to_string(),
                session_id: session_id.to_string(),
                initiating_principal_id: None,
                trigger_event_id: event.id.clone(),
                trigger_sequence: sequence,
                trigger_kind: event.topic,
                parent_activation_id: None,
                root_turn_id: event.id,
            })
            .await
            .unwrap();
        if index == 1 {
            assert!(matches!(
                store
                    .update_thread_activation(
                        &activation.id,
                        activation.revision,
                        ThreadActivationStatus::Running,
                        Some("dead-runtime"),
                        Some(chrono::Utc::now() - chrono::Duration::seconds(1)),
                        None,
                    )
                    .await
                    .unwrap(),
                ThreadActivationMutation::Updated(_)
            ));
        }
        if index == 2 {
            assert!(matches!(
                store
                    .update_thread_activation(
                        &activation.id,
                        activation.revision,
                        ThreadActivationStatus::Running,
                        Some("another-runtime"),
                        Some(chrono::Utc::now() + chrono::Duration::milliseconds(250)),
                        None,
                    )
                    .await
                    .unwrap(),
                ThreadActivationMutation::Updated(_)
            ));
        }
    }

    let orphan_session_id = "recovery-orphan";
    store
        .create_session(NewSession {
            id: orphan_session_id.to_string(),
            agent_id: "recovery-agent".to_string(),
            context_id: "recovery-context".to_string(),
            parent_session_id: None,
            title: "Orphan".to_string(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    let orphan_root = Event::new(
        "recovery-orphan-root".to_string(),
        "Test-User".to_string(),
        TYPE_USER_MESSAGE.to_string(),
        "chat/user_message".to_string(),
        vec![
            ("context_id".to_string(), json!("recovery-context")),
            ("session_id".to_string(), json!(orphan_session_id)),
            ("text".to_string(), json!("legacy orphan")),
        ]
        .into_iter()
        .collect(),
    );
    store.append(orphan_root.clone()).await.unwrap();
    let orphan_sequence = store
        .query(QueryFilter {
            event_id: Some(orphan_root.id.clone()),
            session_id: Some(orphan_session_id.to_string()),
            ..Default::default()
        })
        .await
        .unwrap()[0]
        .sequence
        .unwrap();
    store
        .ensure_thread(NewThread {
            id: "recovery-orphan-thread".to_string(),
            agent_id: "recovery-agent".to_string(),
            context_id: "recovery-context".to_string(),
            session_id: orphan_session_id.to_string(),
            initiating_principal_id: None,
            root_turn_id: orphan_root.id.clone(),
            kind: ThreadKind::Execution,
            executor_kind: "self".to_string(),
            executor_id: None,
            target_id: None,
        })
        .await
        .unwrap();
    let orphan_activation = store
        .ensure_thread_activation(NewThreadActivation {
            id: "recovery-orphan-work".to_string(),
            agent_id: "recovery-agent".to_string(),
            context_id: "recovery-context".to_string(),
            session_id: orphan_session_id.to_string(),
            initiating_principal_id: None,
            trigger_event_id: orphan_root.id.clone(),
            trigger_sequence: orphan_sequence,
            trigger_kind: orphan_root.topic.clone(),
            parent_activation_id: None,
            root_turn_id: orphan_root.id.clone(),
        })
        .await
        .unwrap();
    store
        .update_thread_activation(
            &orphan_activation.id,
            orphan_activation.revision,
            ThreadActivationStatus::Succeeded,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    let client = Arc::new(MockClient::new(vec![
        text_reply_response("recovered"),
        text_reply_response("recovered"),
        text_reply_response("recovered"),
    ]));
    let config = morphz::config::OrchestratorConfig::default();
    let engine = Arc::new(
        ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone())
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>)
            .with_worker_coordination_mode(morphz::memory::WorkerCoordinationMode::SharedLeases),
    );
    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        Arc::clone(&client) as Arc<dyn Client>,
        Arc::new(Registry::new()),
        config,
        engine,
    );
    Arc::clone(&orchestrator).start().await.unwrap();

    for session_id in &recovery_sessions {
        assert_eq!(
            wait_for_topic(&store, "chat/reply", session_id).await.len(),
            1
        );
        assert!(store
            .query(QueryFilter {
                session_id: Some((*session_id).to_string()),
                topic: Some("chat/cancelled".to_string()),
                ..Default::default()
            })
            .await
            .unwrap()
            .is_empty());
    }
    let orphan_thread = store
        .get_thread("recovery-orphan-thread")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(orphan_thread.lifecycle, ThreadLifecycle::Cancelled);
    assert!(orphan_thread
        .result_text
        .as_deref()
        .unwrap_or_default()
        .contains("遗留孤儿状态"));
    assert_eq!(
        wait_for_topic(&store, "runtime/thread_reconciled", orphan_session_id)
            .await
            .len(),
        1
    );
    assert_eq!(client.messages_seen().len(), recovery_sessions.len());
    let activations = store
        .list_context_thread_activations("recovery-context", true)
        .await
        .unwrap();
    assert_eq!(activations.len(), recovery_sessions.len() + 1);
    assert_eq!(
        activations
            .iter()
            .filter(|item| recovery_sessions.contains(&item.session_id.as_str()))
            .filter(|item| item.status == ThreadActivationStatus::Succeeded)
            .count(),
        recovery_sessions.len()
    );
}

#[tokio::test]
async fn runtime_restart_reuses_persisted_tool_plan_without_reasking_model() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("persisted-tool-plan-recovery.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    store
        .create_agent_bundle(
            NewAgent {
                id: "plan-recovery-agent".to_string(),
                title: "Plan Recovery Agent".to_string(),
                root_context_id: "plan-recovery-context".to_string(),
            },
            NewCognitiveContext {
                id: "plan-recovery-context".to_string(),
                agent_id: "plan-recovery-agent".to_string(),
                title: "Plan Recovery Context".to_string(),
            },
            NewSession {
                id: "plan-recovery-session".to_string(),
                agent_id: "plan-recovery-agent".to_string(),
                context_id: "plan-recovery-context".to_string(),
                parent_session_id: None,
                title: "Plan Recovery Session".to_string(),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await
        .unwrap();
    let root = Event::new(
        "plan-recovery-root".to_string(),
        "Test-User".to_string(),
        TYPE_USER_MESSAGE.to_string(),
        "chat/user_message".to_string(),
        vec![
            ("context_id".to_string(), json!("plan-recovery-context")),
            ("session_id".to_string(), json!("plan-recovery-session")),
            ("text".to_string(), json!("execute once")),
        ]
        .into_iter()
        .collect(),
    );
    store.append(root.clone()).await.unwrap();
    let trigger = Event::new(
        "plan-recovery-trigger".to_string(),
        "System-Executor".to_string(),
        TYPE_TOOL_OUTPUT.to_string(),
        "chat/tool_output".to_string(),
        vec![
            ("context_id".to_string(), json!("plan-recovery-context")),
            ("session_id".to_string(), json!("plan-recovery-session")),
            ("attempt_id".to_string(), json!("prior-work")),
            ("tool_call_id".to_string(), json!("prior-call")),
            ("tool_name".to_string(), json!("route_probe")),
            ("root_turn_id".to_string(), json!(root.id)),
            ("text".to_string(), json!("prior tool result")),
        ]
        .into_iter()
        .collect(),
    );
    store.append(trigger.clone()).await.unwrap();
    let trigger_sequence = store
        .query(QueryFilter {
            event_id: Some(trigger.id.clone()),
            session_id: Some("plan-recovery-session".to_string()),
            ..Default::default()
        })
        .await
        .unwrap()
        .into_iter()
        .find(|event| event.id == trigger.id)
        .and_then(|event| event.sequence)
        .unwrap();
    store
        .ensure_thread(NewThread {
            id: "plan-recovery-thread".to_string(),
            agent_id: "plan-recovery-agent".to_string(),
            context_id: "plan-recovery-context".to_string(),
            session_id: "plan-recovery-session".to_string(),
            initiating_principal_id: None,
            root_turn_id: root.id.clone(),
            kind: ThreadKind::DialogueTurn,
            executor_kind: "self".to_string(),
            executor_id: None,
            target_id: None,
        })
        .await
        .unwrap();
    let activation = store
        .ensure_thread_activation(NewThreadActivation {
            id: "plan-recovery-work".to_string(),
            agent_id: "plan-recovery-agent".to_string(),
            context_id: "plan-recovery-context".to_string(),
            session_id: "plan-recovery-session".to_string(),
            initiating_principal_id: None,
            trigger_event_id: trigger.id.clone(),
            trigger_sequence,
            trigger_kind: trigger.topic.clone(),
            parent_activation_id: None,
            root_turn_id: root.id.clone(),
        })
        .await
        .unwrap();
    let running = match store
        .update_thread_activation(
            &activation.id,
            activation.revision,
            ThreadActivationStatus::Running,
            // Runtime claimant IDs are structured as `runtime:<pid>`; use a
            // valid but impossible local PID so this direct-Orchestrator
            // recovery fixture exercises the definitely-dead claimant path.
            Some("runtime:2147483647"),
            Some(chrono::Utc::now() - chrono::Duration::seconds(1)),
            Some(7),
        )
        .await
        .unwrap()
    {
        ThreadActivationMutation::Updated(activation) => activation,
        other => panic!("unexpected Thread Activation mutation: {other:?}"),
    };
    let persisted_call = json!([{
        "id": "persisted-route-probe",
        "type": "function",
        "function": {
            "name": "route_probe",
            "arguments": json!({"value": "execute-exactly-once"}).to_string()
        }
    }]);
    store
        .append(Event::new(
            format!("call_{}", running.id),
            "Agent-Morphz".to_string(),
            "agent_call".to_string(),
            "chat/assistant_call".to_string(),
            vec![
                ("context_id".to_string(), json!(running.context_id)),
                ("session_id".to_string(), json!(running.session_id)),
                ("attempt_id".to_string(), json!(running.id)),
                ("phase".to_string(), json!("work")),
                ("text".to_string(), json!("")),
                ("tool_calls".to_string(), persisted_call.clone()),
                ("continuation_tool_calls".to_string(), persisted_call),
                ("unavailable_tool_names".to_string(), json!([])),
                ("context_tx_rejection_status".to_string(), json!(null)),
                ("activation_id".to_string(), json!(running.id)),
                ("root_turn_id".to_string(), json!(running.root_turn_id)),
                (
                    "trigger_event_id".to_string(),
                    json!(running.trigger_event_id),
                ),
                (
                    "trigger_sequence".to_string(),
                    json!(running.trigger_sequence),
                ),
                ("context_snapshot_version".to_string(), json!(7)),
            ]
            .into_iter()
            .collect(),
        ))
        .await
        .unwrap();
    // Reproduce the production failure: the Thread Activation's original Tool Output
    // has already appeared in a later Context snapshot. Recovery must still
    // resume the durable assistant plan instead of treating the stale wake as
    // a successfully completed Thread Activation.
    store
        .append(Event::new(
            "plan-recovery-covered-context".to_string(),
            "Runtime-Orchestrator".to_string(),
            "proposal".to_string(),
            "chat/context_inspect".to_string(),
            vec![
                ("context_id".to_string(), json!(running.context_id)),
                ("session_id".to_string(), json!(running.session_id)),
                ("root_turn_id".to_string(), json!(running.root_turn_id)),
                (
                    "text".to_string(),
                    json!(format!("covered {}", running.root_turn_id)),
                ),
            ]
            .into_iter()
            .collect(),
        ))
        .await
        .unwrap();

    let routed_arguments = Arc::new(Mutex::new(Vec::new()));
    let registry = Arc::new(Registry::new());
    registry.register(Arc::new(RoutingProbeTool {
        arguments: Arc::clone(&routed_arguments),
        delay_ms: 0,
    }));
    let client = Arc::new(MockClient::new(vec![text_reply_response(
        "recovered plan completed",
    )]));
    let config = morphz::config::OrchestratorConfig::default();
    let engine = Arc::new(
        ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone())
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
    );
    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        Arc::clone(&client) as Arc<dyn Client>,
        registry,
        config,
        engine,
    );
    orchestrator.start().await.unwrap();

    assert_eq!(
        wait_for_topic(&store, "chat/reply", "plan-recovery-session")
            .await
            .len(),
        1
    );
    assert_eq!(routed_arguments.lock().unwrap().len(), 1);
    assert_eq!(client.messages_seen().len(), 1);
    assert_eq!(
        store
            .query(QueryFilter {
                session_id: Some("plan-recovery-session".to_string()),
                topic: Some("chat/tool_output".to_string()),
                ..Default::default()
            })
            .await
            .unwrap()
            .iter()
            .filter(|event| {
                event
                    .payload
                    .get("tool_call_id")
                    .and_then(|value| value.as_str())
                    == Some("persisted-route-probe")
            })
            .count(),
        1
    );
}

#[tokio::test]
async fn runtime_restart_resumes_context_tx_continuation_until_final_reply() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("context-tx-continuation-recovery.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    store
        .create_agent_bundle(
            NewAgent {
                id: "context-tx-recovery-agent".to_string(),
                title: "Context Tx Recovery Agent".to_string(),
                root_context_id: "context-tx-recovery-context".to_string(),
            },
            NewCognitiveContext {
                id: "context-tx-recovery-context".to_string(),
                agent_id: "context-tx-recovery-agent".to_string(),
                title: "Context Tx Recovery Context".to_string(),
            },
            NewSession {
                id: "context-tx-recovery-session".to_string(),
                agent_id: "context-tx-recovery-agent".to_string(),
                context_id: "context-tx-recovery-context".to_string(),
                parent_session_id: None,
                title: "Context Tx Recovery Session".to_string(),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await
        .unwrap();

    let root = Event::new(
        "context-tx-recovery-root".to_string(),
        "Test-User".to_string(),
        TYPE_USER_MESSAGE.to_string(),
        "chat/user_message".to_string(),
        vec![
            (
                "context_id".to_string(),
                json!("context-tx-recovery-context"),
            ),
            (
                "session_id".to_string(),
                json!("context-tx-recovery-session"),
            ),
            ("text".to_string(), json!("remember this and confirm")),
        ]
        .into_iter()
        .collect(),
    );
    store.append(root.clone()).await.unwrap();

    let persisted_call = json!([{
        "id": "context-tx-recovery-call",
        "type": "function",
        "function": {
            "name": "context_tx",
            "arguments": json!({
                "transaction": "(context-tx (base-version 0) (create recovery-state (status committed)))"
            })
            .to_string()
        }
    }]);
    store
        .append(Event::new(
            "call_context-tx-recovery-origin".to_string(),
            "Agent-Morphz".to_string(),
            "agent_call".to_string(),
            "chat/assistant_call".to_string(),
            vec![
                (
                    "context_id".to_string(),
                    json!("context-tx-recovery-context"),
                ),
                (
                    "session_id".to_string(),
                    json!("context-tx-recovery-session"),
                ),
                (
                    "attempt_id".to_string(),
                    json!("context-tx-recovery-origin"),
                ),
                ("phase".to_string(), json!("work")),
                ("text".to_string(), json!("")),
                ("tool_calls".to_string(), persisted_call.clone()),
                ("continuation_tool_calls".to_string(), persisted_call),
                ("root_turn_id".to_string(), json!(root.id)),
            ]
            .into_iter()
            .collect(),
        ))
        .await
        .unwrap();

    let context_tx_output = Event::new(
        "context-tx-recovery-output".to_string(),
        "System-ContextTx".to_string(),
        TYPE_TOOL_OUTPUT.to_string(),
        "chat/tool_output".to_string(),
        vec![
            (
                "context_id".to_string(),
                json!("context-tx-recovery-context"),
            ),
            (
                "session_id".to_string(),
                json!("context-tx-recovery-session"),
            ),
            (
                "attempt_id".to_string(),
                json!("context-tx-recovery-origin"),
            ),
            (
                "tool_call_id".to_string(),
                json!("context-tx-recovery-call"),
            ),
            ("tool_name".to_string(), json!("context_tx")),
            ("tool_status".to_string(), json!("success")),
            ("root_turn_id".to_string(), json!(root.id)),
            (
                "text".to_string(),
                json!(r#"{"status":"committed","after_version":1}"#),
            ),
        ]
        .into_iter()
        .collect(),
    );
    store.append(context_tx_output.clone()).await.unwrap();
    let output_sequence = store
        .query(QueryFilter {
            event_id: Some(context_tx_output.id.clone()),
            session_id: Some("context-tx-recovery-session".to_string()),
            ..Default::default()
        })
        .await
        .unwrap()
        .into_iter()
        .find(|event| event.id == context_tx_output.id)
        .and_then(|event| event.sequence)
        .unwrap();
    // The interrupted continuation had already compiled this tool result into
    // its Context and entered model streaming. On restart that audit snapshot
    // must not make the recovered Activation look successfully completed: no
    // terminal assistant decision or Delivery exists yet.
    store
        .append(Event::new(
            "context-tx-recovery-inspect".to_string(),
            "Runtime-Orchestrator".to_string(),
            "proposal".to_string(),
            "chat/context_inspect".to_string(),
            vec![
                (
                    "context_id".to_string(),
                    json!("context-tx-recovery-context"),
                ),
                (
                    "session_id".to_string(),
                    json!("context-tx-recovery-session"),
                ),
                ("root_turn_id".to_string(), json!(root.id)),
                ("trigger_event_id".to_string(), json!(context_tx_output.id)),
                (
                    "text".to_string(),
                    json!("continuation entered model streaming"),
                ),
            ]
            .into_iter()
            .collect(),
        ))
        .await
        .unwrap();
    store
        .ensure_thread(NewThread {
            id: "context-tx-recovery-thread".to_string(),
            agent_id: "context-tx-recovery-agent".to_string(),
            context_id: "context-tx-recovery-context".to_string(),
            session_id: "context-tx-recovery-session".to_string(),
            initiating_principal_id: None,
            root_turn_id: root.id.clone(),
            kind: ThreadKind::DialogueTurn,
            executor_kind: "self".to_string(),
            executor_id: None,
            target_id: None,
        })
        .await
        .unwrap();
    let activation = store
        .ensure_thread_activation(NewThreadActivation {
            id: "context-tx-recovery-continuation".to_string(),
            agent_id: "context-tx-recovery-agent".to_string(),
            context_id: "context-tx-recovery-context".to_string(),
            session_id: "context-tx-recovery-session".to_string(),
            initiating_principal_id: None,
            trigger_event_id: context_tx_output.id.clone(),
            trigger_sequence: output_sequence,
            trigger_kind: context_tx_output.topic.clone(),
            parent_activation_id: None,
            root_turn_id: root.id.clone(),
        })
        .await
        .unwrap();
    assert!(matches!(
        store
            .update_thread_activation(
                &activation.id,
                activation.revision,
                ThreadActivationStatus::Running,
                Some("runtime:2147483647"),
                Some(chrono::Utc::now() - chrono::Duration::seconds(1)),
                Some(1),
            )
            .await
            .unwrap(),
        ThreadActivationMutation::Updated(_)
    ));

    let client = Arc::new(MockClient::new(vec![text_reply_response(
        "context maintenance recovered and delivered",
    )]));
    let config = morphz::config::OrchestratorConfig::default();
    let engine = Arc::new(
        ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone())
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
    );
    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        Arc::clone(&client) as Arc<dyn Client>,
        Arc::new(Registry::new()),
        config,
        engine,
    );
    orchestrator.start().await.unwrap();

    let replies = wait_for_topic(&store, "chat/reply", "context-tx-recovery-session").await;
    assert_eq!(replies.len(), 1);
    assert_eq!(
        replies[0].payload.get("text"),
        Some(&json!("context maintenance recovered and delivered"))
    );
    assert!(
        wait_for_topic_count(&store, "chat/cancelled", "context-tx-recovery-session", 0,)
            .await
            .is_empty()
    );
    assert_eq!(client.messages_seen().len(), 1);
    assert!(client.messages_seen()[0]
        .iter()
        .all(|message| message.role != "tool"));
    let mut terminal_status = None;
    for _ in 0..80 {
        let status = store
            .get_thread_activation("context-tx-recovery-continuation")
            .await
            .unwrap()
            .unwrap()
            .status;
        if status.is_terminal() {
            terminal_status = Some(status);
            break;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
    }
    assert_eq!(terminal_status, Some(ThreadActivationStatus::Succeeded));
}

#[tokio::test]
async fn test_plain_text_terminal_is_delivered_without_correction() {
    let session_id = "attempt_plain_text_terminal";
    let responses = vec![text_reply_response("I am done")];
    let (bus, store, _orc, client, _tmp) = build_orchestrator_with_config_and_reply_mode(
        responses,
        morphz::config::OrchestratorConfig::default(),
        false,
    )
    .await;

    publish_user(&bus, session_id, "finish explicitly").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    let errors = wait_for_topic(&store, "runtime/response_protocol_error", session_id).await;

    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0].payload.get("text"), Some(&json!("I am done")));
    assert!(errors.is_empty());
    assert_eq!(client.messages_seen().len(), 1);
}

#[tokio::test]
async fn test_reasoning_only_is_carried_forward_until_final_text() {
    let session_id = "attempt_reasoning_continuation";
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("reasoning-continuation.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    install_test_session_registry(&bus, &store);
    let client = Arc::new(ReasoningContinuationClient {
        calls: AtomicUsize::new(0),
        messages_seen: Mutex::new(Vec::new()),
    });
    let config = morphz::config::OrchestratorConfig {
        reasoning_continuation_safety_limit: None,
        persist_full_context_inspect: true,
        ..Default::default()
    };
    let engine = Arc::new(
        ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone())
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
    );
    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        Arc::clone(&client) as Arc<dyn Client>,
        Arc::new(Registry::new()),
        config,
        engine,
    );
    orchestrator.start().await.unwrap();

    publish_user(&bus, session_id, "finish the whole reasoning").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    let continuations =
        wait_for_topic_count(&store, "runtime/reasoning_continuation", session_id, 3).await;
    let summaries =
        wait_for_topic_count(&store, "runtime/model_reasoning_summary", session_id, 3).await;
    let usages = wait_for_topic_count(&store, "runtime/model_usage", session_id, 3).await;
    let protocol_errors = store
        .query(QueryFilter {
            session_id: Some(session_id.to_string()),
            topic: Some("runtime/response_protocol_error".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();

    assert_eq!(client.calls.load(Ordering::SeqCst), 4);
    assert_eq!(replies.len(), 1);
    assert_eq!(
        replies[0].payload.get("text"),
        Some(&json!("continued into final text"))
    );
    assert_eq!(continuations.len(), 3);
    assert!(continuations
        .iter()
        .all(|event| event.payload.get("response_state") == Some(&json!("reasoning_only"))));
    assert!(protocol_errors.is_empty());

    {
        let requests = client.messages_seen.lock().unwrap();
        assert_eq!(requests.len(), 4);
        assert!(requests[1].iter().any(|message| {
            message.role == "user"
                && message.content.contains("<previous_reasoning>")
                && message.content.contains("reasoning segment 1")
        }));
        assert!(requests[3].iter().any(|message| {
            message.role == "user"
                && message.content.contains("reasoning segment 1")
                && message.content.contains("reasoning segment 2")
                && message.content.contains("reasoning segment 3")
        }));
    }
    let inspections = store
        .query(QueryFilter {
            session_id: Some(session_id.to_string()),
            topic: Some("chat/context_inspect".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        inspections.len(),
        4,
        "each physical request must be inspectable"
    );
    let final_inspection = inspections
        .iter()
        .find(|event| {
            event
                .payload
                .get("attempt_id")
                .and_then(|value| value.as_str())
                .is_some_and(|attempt_id| attempt_id.ends_with("_response_retry_3"))
        })
        .expect("final continuation request must have its own Context Inspect");
    let inspected_messages = serde_json::to_string(&final_inspection.payload["messages"]).unwrap();
    assert!(inspected_messages.contains("reasoning segment 1"));
    assert!(inspected_messages.contains("reasoning segment 2"));
    assert!(inspected_messages.contains("reasoning segment 3"));
    assert!(final_inspection.payload["tools"]
        .as_array()
        .is_some_and(|tools| !tools.is_empty()));
    let first_summary = summaries
        .iter()
        .find(|event| event.payload.get("text") == Some(&json!("reasoning segment 1")))
        .expect("first reasoning segment should be durable");
    assert_eq!(
        first_summary.payload.get("complete"),
        Some(&json!(true)),
        "a normal reasoning-only response completes its stream even though it needs a continuation"
    );
    assert!(
        first_summary.payload.get("completion_tokens").is_none(),
        "reasoning artifacts must not duplicate the independently persisted usage fact"
    );
    let first_usage = usages
        .iter()
        .find(|event| event.payload.get("attempt_id") == first_summary.payload.get("attempt_id"))
        .expect("first reasoning request usage should be durable");
    assert_eq!(
        first_usage.payload["usage"].get("output_tokens"),
        Some(&json!(4_096))
    );
}

#[tokio::test]
async fn test_reasoning_continuation_limit_fuses_instead_of_looping_forever() {
    let session_id = "attempt_reasoning_continuation_fused";
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("reasoning-continuation-fused.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    install_test_session_registry(&bus, &store);
    let client = Arc::new(ReasoningContinuationClient {
        calls: AtomicUsize::new(0),
        messages_seen: Mutex::new(Vec::new()),
    });
    let config = morphz::config::OrchestratorConfig {
        reasoning_continuation_safety_limit: Some(1),
        ..Default::default()
    };
    let engine = Arc::new(
        ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone())
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
    );
    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        Arc::clone(&client) as Arc<dyn Client>,
        Arc::new(Registry::new()),
        config,
        engine,
    );
    orchestrator.start().await.unwrap();

    publish_user(&bus, session_id, "do not loop forever").await;
    let exhausted = wait_for_topic(
        &store,
        "runtime/reasoning_continuation_exhausted",
        session_id,
    )
    .await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;

    assert_eq!(client.calls.load(Ordering::SeqCst), 2);
    assert_eq!(exhausted.len(), 1);
    assert_eq!(
        exhausted[0].payload.get("requires_operator_attention"),
        Some(&json!(true))
    );
    assert_eq!(replies.len(), 1);
}

#[tokio::test]
async fn test_no_reply_silent_is_terminal_without_session_delivery() {
    let session_id = "attempt_no_reply";
    let (bus, store, _orc, _client, _tmp) = build_orchestrator_with_config_and_reply_mode(
        vec![no_reply_response()],
        morphz::config::OrchestratorConfig::default(),
        false,
    )
    .await;

    publish_user(&bus, session_id, "no session delivery needed").await;
    let suppressed = wait_for_topic(&store, "chat/no_reply", session_id).await;
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
        Some(&json!("no_reply"))
    );
}

#[tokio::test]
async fn test_no_reply_wait_without_pending_runtime_fact_is_corrected() {
    let session_id = "attempt_invalid_wait";
    let (bus, store, _orc, client, _tmp) = build_orchestrator_with_config_and_reply_mode(
        vec![
            wait_response(),
            text_reply_response("后台结果已经终结，我现在交付结果。"),
        ],
        morphz::config::OrchestratorConfig::default(),
        false,
    )
    .await;

    publish_user(&bus, session_id, "report the completed result").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    let errors = wait_for_topic(&store, "runtime/response_protocol_error", session_id).await;

    assert_eq!(client.messages_seen().len(), 2);
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].payload["response_state"], "invalid_wait");
    assert!(errors[0].payload["reason"]
        .as_str()
        .is_some_and(|reason| reason.contains("no_reply(mode=wait) 被拒绝")));
    assert_eq!(replies.len(), 1);
    assert_eq!(
        replies[0].payload["text"],
        "后台结果已经终结，我现在交付结果。"
    );
}

#[tokio::test]
async fn test_response_protocol_fuses_after_two_failed_corrections() {
    let session_id = "attempt_response_protocol_fuse";
    let responses = (0..3)
        .map(|_| Response {
            content: "no_reply cannot carry text".to_string(),
            tool_calls: no_reply_response().tool_calls,
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
    let errors =
        wait_for_topic_count(&store, "runtime/response_protocol_error", session_id, 3).await;
    let fused = wait_for_topic(&store, "runtime/response_protocol_fused", session_id).await;

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
    install_test_session_registry(&bus, &store);
    let config = morphz::config::OrchestratorConfig::default();
    let engine = Arc::new(
        ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone())
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
    );
    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        Arc::new(FailingClient) as Arc<dyn Client>,
        Arc::new(Registry::new()),
        config,
        engine,
    );
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
        .contains("模型请求失败"));
    assert_eq!(
        replies[0]
            .payload
            .get("runtime_failure_kind")
            .and_then(|value| value.as_str()),
        Some("unknown")
    );
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
    assert!(failures[0].payload.get("incident_id").is_some());
}

#[tokio::test]
async fn test_orchestrator_deadline_cancels_hanging_client_and_replies() {
    let session_id = "attempt_llm_deadline";
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("llm-deadline.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    install_test_session_registry(&bus, &store);
    let config = morphz::config::OrchestratorConfig {
        model_attempt_hard_timeout_secs: Some(1),
        ..Default::default()
    };
    let engine = Arc::new(
        ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone())
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
    );
    let dropped = Arc::new(AtomicBool::new(false));
    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        Arc::new(AsyncCancellationClient {
            dropped: Arc::clone(&dropped),
        }) as Arc<dyn Client>,
        Arc::new(Registry::new()),
        config,
        engine,
    );
    orchestrator.start().await.unwrap();

    let started = std::time::Instant::now();
    publish_user(&bus, session_id, "do work").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    let failures = wait_for_topic(&store, "chat/runtime_error", session_id).await;
    let states = wait_for_topic(&store, "runtime/model_attempt_state", session_id).await;
    let starts = states
        .iter()
        .filter(|event| event.payload.get("state") == Some(&json!("queued")))
        .collect::<Vec<_>>();

    assert!(started.elapsed() < std::time::Duration::from_secs(3));
    assert_eq!(replies.len(), 1);
    assert_eq!(failures.len(), 1);
    assert_eq!(starts.len(), 1);
    assert!(
        dropped.load(Ordering::SeqCst),
        "deadline must drop the client future, not only abandon its result receiver"
    );
    assert_eq!(
        starts[0]
            .payload
            .get("hard_deadline_secs")
            .and_then(|value| value.as_u64()),
        Some(1)
    );
    assert!(failures[0]
        .payload
        .get("error")
        .and_then(|value| value.as_str())
        .unwrap()
        .contains("model hard deadline exceeded after 1s"));
}

#[tokio::test]
async fn test_orchestrator_deadline_covers_waiting_for_concurrency_permit() {
    let session_id = "attempt_permit_deadline";
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("permit-deadline.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    install_test_session_registry(&bus, &store);
    let client = Arc::new(MockClient::new(vec![Response {
        content: "must not be called".to_string(),
        tool_calls: Vec::new(),
    }]));
    let config = morphz::config::OrchestratorConfig {
        model_provider_max_in_flight: 1,
        model_provider_queue_timeout_secs: 1,
        ..Default::default()
    };
    let engine = Arc::new(
        ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone())
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
    );
    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        Arc::clone(&client) as Arc<dyn Client>,
        Arc::new(Registry::new()),
        config,
        engine,
    );
    orchestrator.clone().start().await.unwrap();
    let held_permit = orchestrator
        .model_provider_semaphore
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
    let provider = orchestrator.model_provider_metrics();
    assert_eq!(provider.max_in_flight, 1);
    assert_eq!(provider.queued, 0);
    assert_eq!(provider.in_flight, 0);
    assert_eq!(
        orchestrator.activation_admission_snapshot().total_slots,
        16,
        "Activation slots must remain independent from the one-slot Provider"
    );
    drop(held_permit);
}

#[tokio::test]
async fn test_orchestrator_deadline_isolates_synchronously_blocking_client() {
    let session_id = "attempt_blocking_client";
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("blocking-client.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    install_test_session_registry(&bus, &store);
    let config = morphz::config::OrchestratorConfig {
        model_attempt_hard_timeout_secs: Some(1),
        ..Default::default()
    };
    let engine = Arc::new(
        ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone())
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
    );
    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        Arc::new(BlockingClient) as Arc<dyn Client>,
        Arc::new(Registry::new()),
        config,
        engine,
    );
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
    install_test_session_registry(&bus, &store);
    let config = morphz::config::OrchestratorConfig {
        model_attempt_hard_timeout_secs: Some(30),
        ..Default::default()
    };
    let engine = Arc::new(
        ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone())
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
    );
    let client = Arc::new(CancellableClient {
        calls: AtomicUsize::new(0),
    });
    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        Arc::clone(&client) as Arc<dyn Client>,
        Arc::new(Registry::new()),
        config,
        engine,
    );
    orchestrator.clone().start().await.unwrap();

    publish_user(&bus, session_id, "first hangs").await;
    let states = wait_for_topic(&store, "runtime/model_attempt_state", session_id).await;
    let starts = states
        .iter()
        .filter(|event| event.payload.get("state") == Some(&json!("queued")))
        .collect::<Vec<_>>();
    assert_eq!(starts.len(), 1);
    for _ in 0..80 {
        if client.calls.load(Ordering::SeqCst) == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(
        client.calls.load(Ordering::SeqCst),
        1,
        "cancel must race an active physical request rather than pre-empt its admission"
    );
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
            .get("model_provider_queue_timeout_secs")
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
async fn test_attempt_loop_preserves_wait_task_shaped_call_id_in_standard_tool_result() {
    let session_id = "attempt_tool_then_reply";
    let note = NamedTempFile::new_in(".").unwrap();
    std::fs::write(note.path(), "hello from note").unwrap();

    let (bus, store, _orc, client, _tmp) = build_orchestrator_with_config(
        vec![
            Response {
                content: "".to_string(),
                tool_calls: vec![ToolCallRepr {
                    // Regression: generic string redaction once misread the `sk-` inside
                    // `task-` as a provider key prefix and broke Function Calling correlation.
                    id: "wait_task-1783981186436392000-5698".to_string(),
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
        Some("wait_task-1783981186436392000-5698")
    );
    let tool = &continuation[3];
    assert_eq!(
        tool.tool_call_id.as_deref(),
        Some("wait_task-1783981186436392000-5698")
    );
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
    install_test_session_registry(&bus, &store);
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
    let context_engine = Arc::new(
        ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone())
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
    );
    let registry = Arc::new(Registry::new());
    registry.register(Arc::new(EmptyOutputTool));
    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        Arc::clone(&client) as Arc<dyn Client>,
        registry,
        config,
        context_engine,
    );
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
async fn test_context_transaction_progress_keeps_tool_loop_running_until_reply() {
    let session_id = "attempt_context_then_reply";
    let (bus, store, orchestrator, client, _tmp) = build_orchestrator_with_config(
        vec![
            Response {
                content: "我现在提交 Context 收口，稍后给出最终结果。".to_string(),
                tool_calls: vec![ToolCallRepr {
                    id: "context-before-reply".to_string(),
                    r#type: "function".to_string(),
                    func_name: "context_tx".to_string(),
                    arguments: json!({
                        "transaction": "(context-tx (base-version 0) (reason \"收口\") (create result (result (status completed))) (protect result))"
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
        vec!["system", "user"]
    );
    assert!(messages[1][1].content.contains("(id state)"));
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
async fn active_root_request_cannot_be_retired_before_the_reply_is_delivered() {
    let session_id = "attempt_active_root_retirement_fence";
    let (bus, store, orchestrator, client, _tmp) = build_orchestrator_with_config(
        vec![
            Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: "retire-active-root".to_string(),
                    r#type: "function".to_string(),
                    func_name: "context_tx".to_string(),
                    arguments: json!({
                        "transaction": "(context-tx (base-version 0) (reason absorbed) (retire @e1))"
                    })
                    .to_string(),
                }],
            },
            Response {
                content: "已保留当前请求并修复维护事务。".to_string(),
                tool_calls: vec![ToolCallRepr {
                    id: "repair-without-root-retirement".to_string(),
                    r#type: "function".to_string(),
                    func_name: "context_tx".to_string(),
                    arguments: json!({
                        "transaction": "(context-tx (base-version 0) (create repaired (status complete)))"
                    })
                    .to_string(),
                }],
            },
            Response {
                content: "当前请求已正常交付。".to_string(),
                tool_calls: Vec::new(),
            },
        ],
        morphz::config::OrchestratorConfig::default(),
    )
    .await;

    publish_user(&bus, session_id, "maintain context and answer me").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0].payload["text"], "当前请求已正常交付。");
    assert_eq!(client.tools_seen().len(), 3);
    let outputs = wait_for_topic(&store, "chat/tool_output", session_id).await;
    assert_eq!(outputs.len(), 2);
    assert!(outputs[0].payload["text"]
        .as_str()
        .is_some_and(|text| text.contains("Runtime 因果保护")));
    let context = orchestrator
        .get_current_context_view(session_id)
        .await
        .unwrap();
    assert_eq!(context.state.version, 1);
    assert_eq!(context.state.frames[0].id, "repaired");
    assert!(context
        .observations
        .iter()
        .any(|observation| observation.topic == "chat/user_message"));
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
    let restart_config = config.clone();
    let (bus, store, orchestrator, client, _tmp) = build_orchestrator_with_config(
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
    assert_eq!(client.tools_seen()[0], vec!["context_tx", "no_reply"]);

    let inspected = orchestrator
        .get_current_context_view(session_id)
        .await
        .unwrap();
    assert_eq!(inspected.pressure.estimated_tokens, 2_900);
    assert_eq!(inspected.pressure.token_source, "test-native-tokenizer");
    assert_eq!(inspected.pressure.token_accuracy, "exact");
    assert_eq!(inspected.pressure.token_scope, "full-work-prompt");
    assert_eq!(
        inspected.pressure.token_model.as_deref(),
        Some("test-model")
    );

    let restarted_engine = Arc::new(
        ContextEngine::new(
            Arc::clone(&store) as Arc<dyn EventStore>,
            restart_config.clone(),
        )
        .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
    );
    let restarted = new_test_orchestrator(
        Arc::new(InMemoryEventBus::new()),
        Arc::clone(&store),
        Arc::new(MockClient::new(Vec::new())) as Arc<dyn Client>,
        Arc::new(Registry::new()),
        restart_config,
        restarted_engine,
    );
    let restored = restarted
        .get_context_encoding(session_id, session_id)
        .await
        .unwrap();
    assert_eq!(restored.pressure.estimated_tokens, 2_900);
    assert_eq!(restored.pressure.token_scope, "full-work-prompt");
}

#[tokio::test]
async fn critical_maintenance_rejects_unoffered_physical_tool_with_same_call_id_receipt() {
    let session_id = "attempt_critical_rejects_physical_tool";
    let side_effect_dir = TempDir::new().unwrap();
    let side_effect_path = side_effect_dir.path().join("must-not-be-created.txt");
    let config = morphz::config::OrchestratorConfig {
        context_soft_token_limit: 2_000,
        context_hard_token_limit: 3_000,
        context_maintenance_reserve_tokens: 200,
        ..Default::default()
    };
    let (bus, store, _orchestrator, client, _tmp) = build_orchestrator_with_config(
        vec![
            Response {
                content: "继续执行刚才的写入".to_string(),
                tool_calls: vec![ToolCallRepr {
                    id: "write-while-critical".to_string(),
                    r#type: "function".to_string(),
                    func_name: "write".to_string(),
                    arguments: json!({
                        "path": side_effect_path.to_string_lossy(),
                        "content": "this must never be written",
                        "mode": "create"
                    })
                    .to_string(),
                }],
            },
            Response {
                content: "已识别临界维护边界，未执行写入。".to_string(),
                tool_calls: Vec::new(),
            },
        ],
        config,
    )
    .await;
    client.set_prompt_token_count(2_900);

    publish_user(&bus, session_id, "trigger critical maintenance").await;
    assert_eq!(
        wait_for_topic(&store, "chat/reply", session_id).await.len(),
        1
    );
    assert!(!side_effect_path.exists());

    let outputs = wait_for_topic(&store, "chat/tool_output", session_id).await;
    let rejection = outputs
        .iter()
        .find(|event| event.payload.get("tool_call_id") == Some(&json!("write-while-critical")))
        .expect("rejected tool call must produce a role=tool-compatible receipt");
    assert_eq!(
        rejection.payload.get("tool_status"),
        Some(&json!("rejected"))
    );
    assert_eq!(rejection.payload.get("executed"), Some(&json!(false)));
    assert_eq!(
        rejection.payload.get("rejection_code"),
        Some(&json!("TOOL_NOT_AVAILABLE_IN_CURRENT_PHASE"))
    );
    assert_eq!(
        rejection.payload.get("phase"),
        Some(&json!("critical-maintenance"))
    );

    let tools_seen = client.tools_seen();
    assert_eq!(tools_seen.len(), 2);
    assert_eq!(tools_seen[0], vec!["context_tx", "no_reply"]);
    assert_eq!(tools_seen[1], vec!["context_tx", "no_reply"]);
    let messages = client.messages_seen();
    assert_eq!(messages.len(), 2);
    assert!(messages[0]
        .iter()
        .any(|message| message.content.contains("critical-maintenance")));
    assert!(messages[0]
        .iter()
        .any(|message| message.content.contains("外部物理工具已被暂时撤下")));
    // The next critical-maintenance request deliberately uses a bounded
    // Context projection instead of replaying an unbounded Function Calling
    // transcript. The same immutable receipt must still be visible, including
    // its original call identity and rejection fact.
    assert!(messages[1].iter().any(|message| {
        message.role == "user"
            && message.content.contains("write-while-critical")
            && message
                .content
                .contains("TOOL_NOT_AVAILABLE_IN_CURRENT_PHASE")
    }));
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
    assert_eq!(tools_seen[0], vec!["context_tx", "no_reply"]);
    assert!(!tools_seen[1].contains(&"context_tx".to_string()));
}

#[tokio::test]
async fn test_critical_pressure_keeps_context_tool_available_for_semantic_correction() {
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
                        "transaction": "(context-tx (base-version 0) (create checkpoint (status partial)))"
                    })
                    .to_string(),
                }],
            },
            Response {
                content: "仍处于 critical，可以继续修正维护事务".to_string(),
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
    assert_eq!(tools_seen[0], vec!["context_tx", "no_reply"]);
    assert_eq!(tools_seen[1], vec!["context_tx", "no_reply"]);
}

#[tokio::test]
async fn test_identical_context_transactions_are_normalized_and_deduplicated() {
    let session_id = "attempt_duplicate_context_tx";
    let transaction = |id: &str| ToolCallRepr {
        id: id.to_string(),
        r#type: "function".to_string(),
        func_name: "context_tx".to_string(),
        arguments: json!({
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
    install_test_session_registry(&bus, &store);
    let client = Arc::new(MockClient::new(vec![
        Response {
            content: String::new(),
            tool_calls: vec![
                ToolCallRepr {
                    id: "context-initial".to_string(),
                    r#type: "function".to_string(),
                    func_name: "context_tx".to_string(),
                    arguments: json!({
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
    let engine = Arc::new(
        ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone())
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
    );
    let registry = Arc::new(Registry::new());
    registry.register(Arc::new(ReadFileTool::default()));
    registry.register(Arc::new(ContextTxTool::new(Arc::clone(&engine))));
    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        Arc::clone(&client) as Arc<dyn Client>,
        registry,
        config,
        engine,
    );
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
    let assistant_calls = wait_for_topic(&store, "chat/assistant_call", session_id).await;

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
    let groups = store
        .list_action_groups(ActionGroupFilter {
            context_id: Some(session_id.to_string()),
            include_terminal: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].status, ActionGroupStatus::Settled);
    assert_eq!(groups[0].member_count, 3);
    assert_eq!(groups[0].terminal_member_count, 3);
    let activations = store
        .list_context_thread_activations(session_id, true)
        .await
        .unwrap();
    assert_eq!(activations.len(), 2);
    assert!(activations.iter().any(|activation| {
        activation.trigger_kind == "runtime/action_group_settled"
            && activation.trigger_event_id == format!("action_group_settled_{}", groups[0].id)
    }));
    assert!(activations.iter().all(|activation| {
        !tool_outputs
            .iter()
            .any(|output| activation.trigger_event_id == output.id)
    }), "Action Group member results must remain visible facts without creating successor Activations");
    assert_eq!(
        store
            .query(QueryFilter {
                topic: Some("runtime/action_group_settled".to_string()),
                session_id: Some(session_id.to_string()),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1,
        "parallel Actions must create one durable barrier wake"
    );
    let tool_call_plan = assistant_calls
        .iter()
        .find(|event| event.payload.get("terminal_outcome") != Some(&json!(true)))
        .expect("tool call plan should be durable");
    assert_eq!(
        tool_call_plan.payload.get("model_attempt_id"),
        tool_call_plan.payload.get("attempt_id")
    );
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
    install_test_session_registry(&bus, &store);
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
    let engine = Arc::new(
        ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone())
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
    );
    let registry = Arc::new(Registry::new());
    registry.register(Arc::new(ReadFileTool::default()));
    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        Arc::clone(&client) as Arc<dyn Client>,
        registry,
        config,
        engine,
    );
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
    install_test_session_registry(&bus, &store);
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
    let engine = Arc::new(
        ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone())
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
    );
    let registry = Arc::new(Registry::new());
    registry.register(Arc::new(ReadFileTool::default()));
    registry.register(Arc::new(ContextTxTool::new(Arc::clone(&engine))));
    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        Arc::clone(&client) as Arc<dyn Client>,
        registry,
        config,
        Arc::clone(&engine),
    );
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
    assert!(tools_seen[2].contains(&"no_reply".to_string()));
    assert!(tools_seen[3].contains(&"read".to_string()));
    assert!(!tools_seen[3].contains(&"context_tx".to_string()));
    assert!(tools_seen[3].contains(&"no_reply".to_string()));

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
    install_test_session_registry(&bus, &store);
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
    let engine = Arc::new(
        ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone())
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
    );
    let registry = Arc::new(Registry::new());
    registry.register(Arc::new(ReadFileTool::default()));
    registry.register(Arc::new(ContextTxTool::new(Arc::clone(&engine))));
    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        Arc::clone(&client) as Arc<dyn Client>,
        registry,
        config,
        engine,
    );
    orchestrator.clone().start().await.unwrap();

    publish_user(&bus, session_id, "fail closure safely").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    assert_eq!(replies.len(), 1);
    assert_eq!(client.tools_seen().len(), 3);
    assert!(client.tools_seen()[1].contains(&"read".to_string()));
    assert!(client.tools_seen()[1].contains(&"context_tx".to_string()));
    assert!(client.tools_seen()[1].contains(&"no_reply".to_string()));
    assert!(client.tools_seen()[2].contains(&"read".to_string()));
    assert!(client.tools_seen()[2].contains(&"context_tx".to_string()));
    assert!(client.tools_seen()[2].contains(&"no_reply".to_string()));
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
    install_test_session_registry(&bus, &store);
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
    // This test intentionally inspects the full diagnostic snapshot. Production defaults persist
    // only compact context_inspect metadata to avoid duplicating every encoded prompt in Ledger.
    let config = morphz::config::OrchestratorConfig {
        persist_full_context_inspect: true,
        ..Default::default()
    };
    let engine = Arc::new(
        ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone())
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
    );
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
    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        client as Arc<dyn Client>,
        registry,
        config,
        engine,
    );
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
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>)
            .with_session_projection_store(Arc::clone(&store) as Arc<dyn SessionProjectionStore>),
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
    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        Arc::clone(&client) as Arc<dyn Client>,
        registry,
        config,
        Arc::clone(&engine),
    );
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
async fn attached_delegate_waits_for_result_without_model_polling() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("attached-delegate.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    store
        .create_context(NewCognitiveContext {
            id: "attached-context".to_string(),
            agent_id: "attached-agent".to_string(),
            title: "Attached".to_string(),
        })
        .await
        .unwrap();
    store
        .create_session(NewSession {
            id: "attached-parent".to_string(),
            agent_id: "attached-agent".to_string(),
            context_id: "attached-context".to_string(),
            parent_session_id: None,
            title: "Parent".to_string(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    let config = morphz::config::OrchestratorConfig::default();
    let engine = Arc::new(
        ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone())
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>)
            .with_session_projection_store(Arc::clone(&store) as Arc<dyn SessionProjectionStore>),
    );
    let client = Arc::new(MockClient::new(vec![
        Response {
            content: "delegating now".to_string(),
            tool_calls: ["delegate-attached", "delegate-duplicate"]
                .into_iter()
                .map(|id| ToolCallRepr {
                    id: id.to_string(),
                    r#type: "function".to_string(),
                    func_name: "delegate".to_string(),
                    arguments: json!({
                        "task": "return CHILD-DONE",
                        "success_when": "the result contains CHILD-DONE",
                        "mode": "attached"
                    })
                    .to_string(),
                })
                .collect(),
        },
        Response {
            content: "CHILD-DONE".to_string(),
            tool_calls: Vec::new(),
        },
        Response {
            content: "PARENT-VERIFIED-CHILD-DONE".to_string(),
            tool_calls: Vec::new(),
        },
    ]));
    let registry = Arc::new(Registry::new());
    registry.register(Arc::new(DelegateTool::new(Arc::clone(&bus))));
    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        Arc::clone(&client) as Arc<dyn Client>,
        registry,
        config,
        engine,
    );
    Arc::clone(&orchestrator).start().await.unwrap();

    publish_user_in_context(
        &bus,
        "attached-context",
        "attached-parent",
        "delegate the task",
    )
    .await;

    let replies = wait_for_topic(&store, "chat/reply", "attached-parent").await;
    assert_eq!(replies.len(), 1);
    assert_eq!(
        replies[0]
            .payload
            .get("text")
            .and_then(|value| value.as_str()),
        Some("PARENT-VERIFIED-CHILD-DONE")
    );
    assert_eq!(client.messages_seen().len(), 3);
    assert_eq!(store.list_delegations().await.unwrap().len(), 1);
    let assistant_calls = wait_for_topic(&store, "chat/assistant_call", "attached-parent").await;
    assert!(assistant_calls.iter().any(|event| {
        event
            .payload
            .get("deduplicated_delegate_ids")
            .and_then(|value| value.as_array())
            .is_some_and(|ids| ids.iter().any(|id| id == "delegate-duplicate"))
    }));
    let delegate_outputs =
        wait_for_topic_count(&store, "chat/tool_output", "attached-parent", 2).await;
    assert_eq!(delegate_outputs.len(), 2);
    assert!(delegate_outputs.iter().any(|event| {
        event
            .payload
            .get("wake_policy")
            .and_then(|value| value.as_str())
            == Some("delegation_result")
    }));
    assert!(delegate_outputs.iter().any(|event| {
        event
            .payload
            .get("text")
            .and_then(|value| value.as_str())
            .is_some_and(|text| text.contains("CHILD-DONE"))
    }));
}

#[tokio::test]
async fn delegation_depth_limit_rejects_recursive_spawn_before_creating_child() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("delegate-depth.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    store
        .create_context(NewCognitiveContext {
            id: "depth-root-context".to_string(),
            agent_id: "depth-agent".to_string(),
            title: "Depth root".to_string(),
        })
        .await
        .unwrap();
    store
        .create_session(NewSession {
            id: "depth-root-session".to_string(),
            agent_id: "depth-agent".to_string(),
            context_id: "depth-root-context".to_string(),
            parent_session_id: None,
            title: "Depth root".to_string(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    let config = morphz::config::OrchestratorConfig {
        max_delegation_depth: 1,
        model_attempt_hard_timeout_secs: Some(5),
        ..Default::default()
    };
    let engine = Arc::new(
        ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone())
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
    );
    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        Arc::new(HangingClient) as Arc<dyn Client>,
        Arc::new(Registry::new()),
        config,
        engine,
    );
    Arc::clone(&orchestrator).start().await.unwrap();

    let request = |id: &str,
                   parent_context: &str,
                   parent_session: &str,
                   child_context: &str,
                   child_session: &str| {
        Event::new(
            format!("request-{id}"),
            "Test".to_string(),
            morphz::event::TYPE_AGENT_CALL.to_string(),
            "chat/delegate".to_string(),
            vec![
                ("context_id".to_string(), json!(parent_context)),
                ("session_id".to_string(), json!(parent_session)),
                ("parent_context_id".to_string(), json!(parent_context)),
                ("parent_session_id".to_string(), json!(parent_session)),
                ("delegation_id".to_string(), json!(id)),
                ("child_context_id".to_string(), json!(child_context)),
                ("child_session_id".to_string(), json!(child_session)),
                ("task".to_string(), json!("hold")),
                ("success_when".to_string(), json!("never")),
                ("context_scope".to_string(), json!("mind_only")),
                ("text".to_string(), json!("Delegation requested")),
            ]
            .into_iter()
            .collect(),
        )
    };
    bus.publish(request(
        "depth-first",
        "depth-root-context",
        "depth-root-session",
        "depth-child-context",
        "depth-child-session",
    ))
    .await
    .unwrap();
    for _ in 0..40 {
        if store.get_delegation("depth-first").await.unwrap().is_some() {
            break;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(25)).await;
    }
    assert!(store.get_delegation("depth-first").await.unwrap().is_some());

    bus.publish(request(
        "depth-rejected",
        "depth-child-context",
        "depth-child-session",
        "depth-grandchild-context",
        "depth-grandchild-session",
    ))
    .await
    .unwrap();
    let failures = wait_for_topic(&store, "chat/tool_output", "depth-child-session").await;
    assert!(failures.iter().any(|event| {
        event
            .payload
            .get("text")
            .and_then(|value| value.as_str())
            .is_some_and(|text| text.contains("DELEGATION_DEPTH_EXCEEDED"))
    }));
    assert!(store
        .get_delegation("depth-rejected")
        .await
        .unwrap()
        .is_none());
    assert!(store
        .get_session("depth-grandchild-session")
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn same_session_dialogue_turns_are_serialized() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("single-writer.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    install_test_session_registry(&bus, &store);
    let client = Arc::new(ConcurrencyProbeClient {
        active: AtomicUsize::new(0),
        max_active: AtomicUsize::new(0),
        calls: AtomicUsize::new(0),
    });
    let config = morphz::config::OrchestratorConfig::default();
    let engine = Arc::new(
        ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone())
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
    );
    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        Arc::clone(&client) as Arc<dyn Client>,
        Arc::new(Registry::new()),
        config,
        engine,
    );
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
    assert_eq!(
        client.max_active.load(Ordering::SeqCst),
        1,
        "one Session has one ordered dialogue lane"
    );
    let activations = store
        .list_context_thread_activations("serialized-session", true)
        .await
        .unwrap();
    assert_eq!(activations.len(), 2);
    assert!(activations
        .iter()
        .all(|item| item.root_turn_id == item.trigger_event_id));
    assert_ne!(activations[0].root_turn_id, activations[1].root_turn_id);
    let inspections = store
        .query(QueryFilter {
            session_id: Some("serialized-session".to_string()),
            topic: Some("chat/context_inspect".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(inspections.len(), 2);
    assert!(inspections.iter().all(|inspection| {
        inspection
            .payload
            .get("trigger_event_id")
            .and_then(|value| value.as_str())
            == inspection
                .payload
                .get("wake")
                .and_then(|wake| wake.get("event_id"))
                .and_then(|value| value.as_str())
    }));
}

#[tokio::test]
async fn context_maintenance_keeps_the_dialogue_turn_serialized_until_reply() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("context-maintenance-dialogue.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    install_test_session_registry(&bus, &store);
    let client = Arc::new(MockClient::new(vec![
        Response {
            content: String::new(),
            tool_calls: vec![ToolCallRepr {
                id: "dialogue-context-tx".to_string(),
                r#type: "function".to_string(),
                func_name: "context_tx".to_string(),
                arguments: json!({
                    "transaction": "(context-tx (base-version 0) (create greeting-state (status current)))"
                })
                .to_string(),
            }],
        },
        text_reply_response("first-after-maintenance"),
        text_reply_response("second-reply"),
    ]));
    let started = Arc::new(AtomicUsize::new(0));
    let registry = Arc::new(Registry::new());
    registry.register(Arc::new(DelayedContextTxTool {
        started: Arc::clone(&started),
        delay_ms: 400,
    }));
    let config = morphz::config::OrchestratorConfig::default();
    let engine = Arc::new(
        ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone())
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
    );
    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        Arc::clone(&client) as Arc<dyn Client>,
        registry,
        config,
        engine,
    );
    orchestrator.start().await.unwrap();

    publish_user(&bus, "context-maintenance-dialogue", "first").await;
    for _ in 0..80 {
        if started.load(Ordering::SeqCst) > 0 {
            break;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
    }
    assert_eq!(started.load(Ordering::SeqCst), 1);
    publish_user(&bus, "context-maintenance-dialogue", "second").await;

    let replies =
        wait_for_topic_count(&store, "chat/reply", "context-maintenance-dialogue", 2).await;
    assert_eq!(
        replies[0].payload.get("text"),
        Some(&json!("first-after-maintenance"))
    );
    assert_eq!(replies[1].payload.get("text"), Some(&json!("second-reply")));
    assert!(replies.iter().all(|reply| {
        reply
            .payload
            .get("thread_kind")
            .and_then(|value| value.as_str())
            == Some("dialogue_turn")
    }));
}

#[tokio::test]
async fn same_session_message_is_answered_while_older_tool_is_still_running() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("same-session-tool-concurrency.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    install_test_session_registry(&bus, &store);
    let client = Arc::new(MockClient::new(vec![
        Response {
            content: "starting the long tool".to_string(),
            tool_calls: vec![ToolCallRepr {
                id: "slow-tool-a".to_string(),
                r#type: "function".to_string(),
                func_name: "route_probe".to_string(),
                arguments: json!({"value": "tool-a"}).to_string(),
            }],
        },
        text_reply_response("message-b-reply"),
        text_reply_response("tool-a-finished"),
    ]));
    let routed_arguments = Arc::new(Mutex::new(Vec::new()));
    let registry = Arc::new(Registry::new());
    registry.register(Arc::new(RoutingProbeTool {
        arguments: Arc::clone(&routed_arguments),
        delay_ms: 600,
    }));
    let config = morphz::config::OrchestratorConfig::default();
    let engine = Arc::new(
        ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone())
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
    );
    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        Arc::clone(&client) as Arc<dyn Client>,
        registry,
        config,
        engine,
    );
    orchestrator.start().await.unwrap();

    publish_user(&bus, "same-session-tool", "message-a starts tool").await;
    for _ in 0..80 {
        if !routed_arguments.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
    }
    assert_eq!(routed_arguments.lock().unwrap().len(), 1);
    publish_user(&bus, "same-session-tool", "message-b while tool runs").await;

    let replies = wait_for_topic_count(&store, "chat/reply", "same-session-tool", 2).await;
    let message_b_reply = replies
        .iter()
        .find(|event| event.payload.get("text") == Some(&json!("message-b-reply")))
        .expect("message B must receive its own reply");
    assert_eq!(
        message_b_reply.payload.get("thread_kind"),
        Some(&json!("dialogue_turn"))
    );
    let tool_reply = replies
        .iter()
        .find(|event| event.payload.get("text") == Some(&json!("tool-a-finished")))
        .expect("tool A must complete on its execution thread");
    assert_eq!(
        tool_reply.payload.get("thread_kind"),
        Some(&json!("execution"))
    );
    assert!(tool_reply.payload.get("covers").is_none());
    assert_eq!(client.delivery_calls(), 0);
    let tool_output = store
        .query(QueryFilter {
            session_id: Some("same-session-tool".to_string()),
            topic: Some("chat/tool_output".to_string()),
            ..Default::default()
        })
        .await
        .unwrap()
        .into_iter()
        .find(|event| event.payload.get("tool_call_id") == Some(&json!("slow-tool-a")))
        .expect("tool A must eventually complete");
    assert!(message_b_reply.sequence.unwrap() < tool_output.sequence.unwrap());

    let events = store
        .query(QueryFilter {
            session_id: Some("same-session-tool".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
    let user_messages = events
        .iter()
        .filter(|event| event.event_type == TYPE_USER_MESSAGE)
        .collect::<Vec<_>>();
    assert_eq!(user_messages.len(), 2);
    let tool_call = events
        .iter()
        .find(|event| {
            event.topic == "chat/assistant_call"
                && event
                    .payload
                    .get("tool_calls")
                    .and_then(|value| value.as_array())
                    .is_some_and(|calls| {
                        calls
                            .iter()
                            .any(|call| call.get("id") == Some(&json!("slow-tool-a")))
                    })
        })
        .expect("assistant tool call must be durable");
    assert!(tool_call.sequence.unwrap() < user_messages[1].sequence.unwrap());
    assert!(user_messages[1].sequence.unwrap() < tool_output.sequence.unwrap());
    assert_eq!(
        tool_output
            .payload
            .get("root_turn_id")
            .and_then(|value| value.as_str()),
        Some(user_messages[0].id.as_str())
    );
    assert_ne!(
        message_b_reply
            .payload
            .get("root_turn_id")
            .and_then(|value| value.as_str()),
        tool_output
            .payload
            .get("root_turn_id")
            .and_then(|value| value.as_str())
    );

    let message_b_request = client
        .messages_seen()
        .into_iter()
        .find(|messages| {
            messages.iter().any(|message| {
                message.role == "user"
                    && message.content.contains("message-b while tool runs")
                    && message.content.contains("(current-activation")
            })
        })
        .expect("message B must receive its own responsibility-scoped Context Encoding");
    let message_b_encoding = message_b_request
        .iter()
        .find(|message| message.role == "user")
        .unwrap();
    assert!(message_b_encoding.content.contains("message-a starts tool"));
    assert!(message_b_encoding
        .content
        .contains("(pending-tools route_probe)"));
    assert!(message_b_encoding
        .content
        .contains("不得接管、重复或继续它们的动作"));
    assert!(message_b_encoding.content.contains("(evaluate"));
    assert!(message_b_encoding
        .content
        .contains("(thread (kind dialogue-turn) (id same-session-tool)"));
    assert!(message_b_encoding
        .content
        .contains("(root-input \"message-b while tool runs\")"));
    assert!(message_b_encoding
        .content
        .contains("(objective-binding none)"));
    assert!(
        message_b_encoding.content.rfind("(evaluate").unwrap()
            > message_b_encoding.content.rfind("(inbox").unwrap()
    );
    assert!(!message_b_request
        .iter()
        .any(|message| message.role == "tool"));
}

#[tokio::test]
async fn concurrent_session_inspect_cannot_suppress_another_root_turns_tool_wake() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("causal-tool-wake-dedup.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    install_test_session_registry(&bus, &store);
    let client = Arc::new(MockClient::new(vec![
        Response {
            content: String::new(),
            tool_calls: vec![
                ToolCallRepr {
                    id: "causal-slow-tool".to_string(),
                    r#type: "function".to_string(),
                    func_name: "route_probe".to_string(),
                    arguments: json!({"value": "root-a"}).to_string(),
                },
                ToolCallRepr {
                    id: "causal-fast-context".to_string(),
                    r#type: "function".to_string(),
                    func_name: "context_tx".to_string(),
                    arguments: json!({
                        "transaction": "(context-tx (base-version 0) (create causal-note (status waiting-tool)))"
                    })
                    .to_string(),
                },
            ],
        },
        text_reply_response("root-b-reply"),
        text_reply_response("root-a-finished"),
    ]));
    let config = morphz::config::OrchestratorConfig::default();
    let engine = Arc::new(
        ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone())
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
    );
    let routed_arguments = Arc::new(Mutex::new(Vec::new()));
    let registry = Arc::new(Registry::new());
    registry.register(Arc::new(RoutingProbeTool {
        arguments: Arc::clone(&routed_arguments),
        delay_ms: 600,
    }));
    registry.register(Arc::new(ContextTxTool::new(Arc::clone(&engine))));
    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        Arc::clone(&client) as Arc<dyn Client>,
        registry,
        config,
        engine,
    );
    orchestrator.start().await.unwrap();

    publish_user(&bus, "causal-wake-session", "root A").await;
    for _ in 0..80 {
        if !routed_arguments.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
    }
    assert_eq!(routed_arguments.lock().unwrap().len(), 1);
    publish_user(&bus, "causal-wake-session", "root B").await;

    let replies = wait_for_topic_count(&store, "chat/reply", "causal-wake-session", 2).await;
    assert!(replies
        .iter()
        .any(|event| event.payload.get("text") == Some(&json!("root-b-reply"))));
    assert!(replies
        .iter()
        .any(|event| event.payload.get("text") == Some(&json!("root-a-finished"))));
    let messages_seen = client.messages_seen();
    assert_eq!(messages_seen.len(), 3);
    let root_a_continuation = messages_seen
        .iter()
        .find(|messages| {
            messages
                .iter()
                .any(|message| message.role == "tool" && message.content.contains("probe:root-a"))
        })
        .expect("root A must receive its own tool transcript");
    let root_a_encoding = root_a_continuation
        .iter()
        .find(|message| message.role == "user")
        .expect("root A continuation must include Context Encoding");
    assert!(root_a_encoding.content.contains("root A"));
    assert!(root_a_encoding.content.contains("(evaluate"));
    assert!(root_a_encoding.content.contains("(thread (kind execution)"));
    assert!(root_a_encoding
        .content
        .contains("(parent-dialogue causal-wake-session)"));
    assert!(
        !root_a_encoding.content.contains("root B"),
        "a newer concurrent user turn must not leak into an older Activation's Inbox"
    );
    let roots = replies
        .iter()
        .filter_map(|event| {
            event
                .payload
                .get("root_turn_id")
                .and_then(|value| value.as_str())
        })
        .collect::<HashSet<_>>();
    assert_eq!(roots.len(), 2);
}

#[tokio::test]
async fn test_distinct_sessions_evaluate_concurrently_in_shared_context() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("shared-context-concurrency.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    install_test_session_registry(&bus, &store);
    let client = Arc::new(ConcurrencyProbeClient {
        active: AtomicUsize::new(0),
        max_active: AtomicUsize::new(0),
        calls: AtomicUsize::new(0),
    });
    let config = morphz::config::OrchestratorConfig::default();
    let engine = Arc::new(
        ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone())
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
    );
    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        Arc::clone(&client) as Arc<dyn Client>,
        Arc::new(Registry::new()),
        config,
        Arc::clone(&engine),
    );
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
async fn shared_provider_outage_requires_three_small_probe_failures_before_opening() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("shared-provider-outage.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    install_test_session_registry(&bus, &store);
    let client = Arc::new(SharedTransientFailureClient {
        calls: AtomicUsize::new(0),
        health_probe_calls: AtomicUsize::new(0),
        initial_barrier: tokio::sync::Barrier::new(2),
    });
    let config = morphz::config::OrchestratorConfig::default();
    let engine = Arc::new(
        ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone())
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
    );
    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        Arc::clone(&client) as Arc<dyn Client>,
        Arc::new(Registry::new()),
        config,
        engine,
    );
    orchestrator.start().await.unwrap();

    tokio::join!(
        publish_user_in_context(&bus, "provider-outage-context", "outage-a", "first"),
        publish_user_in_context(&bus, "provider-outage-context", "outage-b", "second"),
    );
    assert_eq!(
        wait_for_context_terminal_count(&store, "provider-outage-context", 2)
            .await
            .len(),
        2
    );

    publish_user_in_context(
        &bus,
        "provider-outage-context",
        "outage-c",
        "third while outage is still unconfirmed",
    )
    .await;
    assert_eq!(
        wait_for_topic(&store, "chat/no_reply", "outage-c")
            .await
            .len(),
        1
    );
    assert_eq!(
        client.calls.load(Ordering::SeqCst),
        3,
        "business requests remain independent while only an application request has failed"
    );

    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while client.health_probe_calls.load(Ordering::SeqCst) < 3 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("three independent small health probes must confirm the outage");
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    publish_user_in_context(
        &bus,
        "provider-outage-context",
        "outage-d",
        "fourth after health probes confirm the outage",
    )
    .await;
    assert_eq!(
        wait_for_topic(&store, "chat/no_reply", "outage-d")
            .await
            .len(),
        1
    );
    assert_eq!(client.calls.load(Ordering::SeqCst), 3);

    let replies = store
        .query(QueryFilter {
            context_id: Some("provider-outage-context".to_string()),
            topic: Some("chat/reply".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
    let silent = store
        .query(QueryFilter {
            context_id: Some("provider-outage-context".to_string()),
            topic: Some("chat/no_reply".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
    let incidents = store
        .query(QueryFilter {
            context_id: Some("provider-outage-context".to_string()),
            topic: Some("chat/runtime_error".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        replies.len(),
        1,
        "one outage must produce one visible notice"
    );
    assert_eq!(silent.len(), 3, "other failed Activations still terminate");
    assert_eq!(incidents.len(), 1, "one outage must create one incident");
    assert!(silent.iter().all(
        |event| event.payload.get("runtime_failure_user_notice_suppressed") == Some(&json!(true))
    ));
}

#[tokio::test]
async fn partial_reasoning_before_provider_failure_does_not_retry_business_request() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("partial-reasoning-provider-outage.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    install_test_session_registry(&bus, &store);
    let client = Arc::new(PartialReasoningProviderFailureClient {
        calls: AtomicUsize::new(0),
    });
    let config = morphz::config::OrchestratorConfig::default();
    let engine = Arc::new(
        ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone())
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
    );
    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        Arc::clone(&client) as Arc<dyn Client>,
        Arc::new(Registry::new()),
        config,
        engine,
    );
    orchestrator.start().await.unwrap();

    publish_user(&bus, "partial-provider-a", "first request").await;
    assert_eq!(
        wait_for_topic(&store, "chat/reply", "partial-provider-a")
            .await
            .len(),
        1
    );
    assert_eq!(client.calls.load(Ordering::SeqCst), 1);

    // Partial reasoning is useful progress, but a real transport failure is
    // not a reasoning-only boundary. Runtime must not turn it into another
    // application request; only the independent health monitor may probe.
    assert_eq!(client.calls.load(Ordering::SeqCst), 1);
    assert!(
        store
            .query(QueryFilter {
                session_id: Some("partial-provider-a".to_string()),
                topic: Some("runtime/model_attempt_state".to_string()),
                ..Default::default()
            })
            .await
            .unwrap()
            .iter()
            .any(|event| {
                event.payload.get("state") == Some(&json!("failed"))
                    && event
                        .payload
                        .get("detail")
                        .and_then(|value| value.as_str())
                        .is_some_and(|detail| {
                            detail.contains("simulated disconnect after partial reasoning")
                        })
            }),
        "a real disconnect after partial reasoning must terminate the application attempt"
    );
    assert_eq!(
        store
            .query(QueryFilter {
                session_id: Some("partial-provider-a".to_string()),
                topic: Some("runtime/model_reasoning_summary".to_string()),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn concurrent_context_overflow_has_one_maintenance_owner_and_fresh_retries() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("shared-context-overflow.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    install_test_session_registry(&bus, &store);
    let client = Arc::new(ConcurrentContextLimitClient {
        calls: AtomicUsize::new(0),
        initial_failures: AtomicUsize::new(0),
        initial_barrier: tokio::sync::Barrier::new(2),
        maintenance_calls: AtomicUsize::new(0),
    });
    let config = morphz::config::OrchestratorConfig {
        context_soft_token_limit: 200_000,
        context_hard_token_limit: 256_000,
        ..Default::default()
    };
    let engine = Arc::new(
        ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone())
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
    );
    let registry = Arc::new(Registry::new());
    registry.register(Arc::new(ContextTxTool::new(Arc::clone(&engine))));
    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        Arc::clone(&client) as Arc<dyn Client>,
        registry,
        config,
        Arc::clone(&engine),
    );
    Arc::clone(&orchestrator).start().await.unwrap();

    tokio::join!(
        publish_user_in_context(&bus, "overflow-context", "overflow-a", "first"),
        publish_user_in_context(&bus, "overflow-context", "overflow-b", "second"),
    );
    let replies_a = wait_for_topic(&store, "chat/reply", "overflow-a").await;
    let replies_b = wait_for_topic(&store, "chat/reply", "overflow-b").await;
    assert_eq!(replies_a.len(), 1);
    assert_eq!(replies_b.len(), 1);
    assert_eq!(client.maintenance_calls.load(Ordering::SeqCst), 1);
    assert_eq!(client.calls.load(Ordering::SeqCst), 5);
    assert!(replies_a
        .iter()
        .chain(&replies_b)
        .all(|event| event.payload.get("text")
            == Some(&json!("continued after shared context maintenance"))));
    let encoding = orchestrator
        .get_context_encoding("overflow-context", "overflow-a")
        .await
        .unwrap();
    assert!(encoding
        .state
        .frames
        .iter()
        .any(|frame| frame.id == "provider-overflow-recovered"));
    let failures = store
        .query(QueryFilter {
            context_id: Some("overflow-context".to_string()),
            topic: Some("chat/runtime_error".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(failures.is_empty());
}

#[tokio::test]
async fn test_concurrent_tool_wakeups_are_non_blocking_and_may_coalesce() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("coalesced-wakeups.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    install_test_session_registry(&bus, &store);
    let client = Arc::new(ConcurrencyProbeClient {
        active: AtomicUsize::new(0),
        max_active: AtomicUsize::new(0),
        calls: AtomicUsize::new(0),
    });
    let config = morphz::config::OrchestratorConfig::default();
    let engine = Arc::new(
        ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone())
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
    );
    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        Arc::clone(&client) as Arc<dyn Client>,
        Arc::new(Registry::new()),
        config,
        engine,
    );
    orchestrator.start().await.unwrap();

    publish_user(&bus, "coalesced-session", "start").await;
    assert_eq!(
        wait_for_topic(&store, "chat/context_inspect", "coalesced-session")
            .await
            .len(),
        1
    );
    publish_tool_output(&bus, "coalesced-session", "tool-output-1").await;
    publish_tool_output(&bus, "coalesced-session", "tool-output-2").await;

    let mut source_activations = Vec::new();
    for _ in 0..100 {
        source_activations = store
            .list_context_thread_activations("coalesced-session", true)
            .await
            .unwrap()
            .into_iter()
            .filter(|activation| {
                activation.trigger_kind == "chat/user_message"
                    || matches!(
                        activation.trigger_event_id.as_str(),
                        "tool-output-1" | "tool-output-2"
                    )
            })
            .collect();
        if source_activations.len() == 3
            && source_activations
                .iter()
                .all(|activation| activation.status.is_terminal())
        {
            break;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    }
    assert_eq!(source_activations.len(), 3);
    assert!(source_activations
        .iter()
        .all(|activation| activation.status.is_terminal()));
    assert!((2..=3).contains(&client.calls.load(Ordering::SeqCst)));
    assert!(client.max_active.load(Ordering::SeqCst) >= 2);

    let result_events = store
        .query(QueryFilter {
            session_id: Some("coalesced-session".to_string()),
            topic: Some("runtime/thread_result".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!((1..=2).contains(&result_events.len()));
    let result_thread_ids = result_events
        .iter()
        .filter_map(|event| {
            event
                .payload
                .get("thread_id")
                .and_then(|value| value.as_str())
                .map(ToOwned::to_owned)
        })
        .collect::<HashSet<_>>();
    assert_eq!(result_thread_ids.len(), result_events.len());
    for _ in 0..100 {
        if store
            .list_session_delivery_threads("coalesced-session", true)
            .await
            .unwrap()
            .is_empty()
        {
            break;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    }
    assert!(store
        .list_session_delivery_threads("coalesced-session", true)
        .await
        .unwrap()
        .is_empty());

    let completion_events = store
        .query(QueryFilter {
            session_id: Some("coalesced-session".to_string()),
            topic: Some("chat/thread_completion_ready".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(completion_events.is_empty());
    let replies = store
        .query(QueryFilter {
            session_id: Some("coalesced-session".to_string()),
            topic: Some("chat/reply".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
    let delivery_replies = replies
        .iter()
        .filter(|event| event.payload.get("thread_kind") == Some(&json!("delivery")))
        .collect::<Vec<_>>();
    assert!((1..=2).contains(&delivery_replies.len()));
    assert!(delivery_replies.iter().all(|event| {
        matches!(
            event
                .payload
                .get("delivery_strategy")
                .and_then(|value| value.as_str()),
            Some("passthrough" | "deterministic_batch")
        )
    }));
    let covered_thread_ids = delivery_replies
        .iter()
        .flat_map(|event| {
            event.payload["covers"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|value| value.as_str())
                .map(ToOwned::to_owned)
        })
        .collect::<Vec<_>>();
    let unique_covered_thread_ids = covered_thread_ids.iter().cloned().collect::<HashSet<_>>();
    assert_eq!(
        covered_thread_ids.len(),
        unique_covered_thread_ids.len(),
        "delivery snapshots must never cover one execution thread twice"
    );
    assert_eq!(unique_covered_thread_ids, result_thread_ids);

    assert_eq!(replies.len(), 1 + delivery_replies.len());
    let activation_records = store
        .list_context_thread_activations("coalesced-session", true)
        .await
        .unwrap();
    assert_eq!(activation_records.len(), 3);
    assert_eq!(
        activation_records
            .iter()
            .filter(|activation| activation.trigger_kind == "chat/thread_completion_ready")
            .count(),
        0,
        "deterministic Delivery Router replies must not create Composer activations"
    );
}

#[tokio::test]
async fn tool_wakeups_for_one_root_are_single_flight_and_commit_one_reply() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("same-root-single-flight.db");
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(db_path.to_str().unwrap()).await.unwrap());
    install_test_session_registry(&bus, &store);
    let client = Arc::new(ConcurrencyProbeClient {
        active: AtomicUsize::new(0),
        max_active: AtomicUsize::new(0),
        calls: AtomicUsize::new(0),
    });
    let config = morphz::config::OrchestratorConfig::default();
    let engine = Arc::new(
        ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone())
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
    );
    let orchestrator = new_test_orchestrator(
        Arc::clone(&bus),
        Arc::clone(&store),
        Arc::clone(&client) as Arc<dyn Client>,
        Arc::new(Registry::new()),
        config,
        engine,
    );
    orchestrator.start().await.unwrap();

    let publish = |id: &'static str| {
        let bus = Arc::clone(&bus);
        async move {
            bus.publish(Event::new(
                id.to_string(),
                "Test-Tool".to_string(),
                TYPE_TOOL_OUTPUT.to_string(),
                "chat/tool_output".to_string(),
                vec![
                    ("context_id".to_string(), json!("same-root-session")),
                    ("session_id".to_string(), json!("same-root-session")),
                    ("root_turn_id".to_string(), json!("stable-root")),
                    ("tool_name".to_string(), json!("test")),
                    ("text".to_string(), json!(id)),
                ]
                .into_iter()
                .collect(),
            ))
            .await
            .unwrap();
        }
    };
    tokio::join!(publish("same-root-output-a"), publish("same-root-output-b"));

    wait_for_topic(&store, "chat/reply", "same-root-session").await;
    tokio::time::sleep(tokio::time::Duration::from_millis(650)).await;
    let replies = store
        .query(QueryFilter {
            session_id: Some("same-root-session".to_string()),
            topic: Some("chat/reply".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(replies.len(), 1);
    // Bare external results do not carry an ActionGroup settlement boundary,
    // so the first Activation cannot know whether another result will arrive.
    // Depending on durable-dispatch timing they may be evaluated together or
    // in two serialized Activations. The correctness contract is single-flight
    // execution and one visible Delivery; native parallel tool batches use the
    // explicit ActionGroup barrier when exactly one follow-up evaluation matters.
    assert!((1..=2).contains(&client.calls.load(Ordering::SeqCst)));
    assert_eq!(client.max_active.load(Ordering::SeqCst), 1);
    assert_eq!(replies[0].payload["thread_kind"], "delivery");
    assert_eq!(
        replies[0].payload["covers"].as_array().map(Vec::len),
        Some(1)
    );
}

fn eval_response(program: &str) -> Response {
    Response {
        content: String::new(),
        tool_calls: vec![ToolCallRepr {
            id: "eval-1".to_string(),
            r#type: "function".to_string(),
            func_name: "eval".to_string(),
            arguments: json!({ "program": program }).to_string(),
        }],
    }
}

#[tokio::test]
async fn eval_runs_a_submitted_program_and_hands_infer_back_to_the_model() {
    let session_id = "attempt_eval_program";
    // Three model turns: submit the program, answer the `infer` the Runtime
    // stopped at, then reply once the value has been folded back in.
    let (bus, store, _orchestrator, client, _tmp) = build_orchestrator_with_config(
        vec![
            eval_response(
                r#"(eval (seq
                     (bind body (call read (path "probe.txt")))
                     (bind judgement (infer (task "这个文件说了什么") (evidence $body)))
                     $judgement))"#,
            ),
            text_reply_response("看起来是一个 Rust 工程"),
            text_reply_response("已完成"),
        ],
        morphz::config::OrchestratorConfig::default(),
    )
    .await;

    publish_user(&bus, session_id, "看一下当前目录").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    assert_eq!(replies.len(), 1);
    assert_eq!(
        replies[0].payload.get("text").and_then(|v| v.as_str()),
        Some("已完成")
    );

    let turns = client.messages_seen();
    assert_eq!(
        turns.len(),
        3,
        "one turn submits the program, one answers the infer, one replies"
    );

    // The middle turn is the trampoline: control came back to the model with
    // the question, and it must not have been dressed as someone speaking.
    let inference_turn = turns[1]
        .iter()
        .rev()
        .find(|message| message.role == "user")
        .expect("the infer request reaches the model");
    assert!(
        inference_turn.content.contains("(infer-request"),
        "unexpected infer prompt: {}",
        inference_turn.content
    );
    assert!(
        inference_turn.content.contains("不是用户消息"),
        "the model must be able to tell nobody asked: {}",
        inference_turn.content
    );

    // The value the model produced is what the program bound and returned, so
    // the tool output carries it rather than the raw listing.
    let outputs = wait_for_topic(&store, "chat/tool_output", session_id).await;
    let eval_output = outputs
        .iter()
        .find(|event| event.payload.get("tool_name").and_then(|v| v.as_str()) == Some("eval"))
        .expect("the eval call produced an observation");
    assert!(
        eval_output
            .payload
            .get("text")
            .and_then(|v| v.as_str())
            .is_some_and(|text| text.contains("Rust 工程")),
        "eval output should carry the inferred value: {:?}",
        eval_output.payload.get("text")
    );
}

fn read_call_response(id: &str, path: &str) -> Response {
    Response {
        content: String::new(),
        tool_calls: vec![ToolCallRepr {
            id: id.to_string(),
            r#type: "function".to_string(),
            func_name: "read".to_string(),
            arguments: json!({ "path": path }).to_string(),
        }],
    }
}

#[tokio::test]
async fn infer_may_gather_evidence_but_is_never_offered_eval() {
    let session_id = "attempt_infer_tools";
    let probe = NamedTempFile::new().unwrap();
    std::fs::write(probe.path(), "fn main() {}").unwrap();
    let probe_path = probe.path().to_string_lossy().into_owned();
    let (bus, store, _orchestrator, client, _tmp) = build_orchestrator_with_config(
        vec![
            eval_response(r#"(eval (infer (task "这个仓库是什么语言写的")))"#),
            // Inside the infer, the model wants evidence before answering.
            read_call_response("infer-read", &probe_path),
            text_reply_response("Rust"),
            text_reply_response("已确认"),
        ],
        morphz::config::OrchestratorConfig::default(),
    )
    .await;

    publish_user(&bus, session_id, "看看这是什么项目").await;
    let replies = wait_for_topic(&store, "chat/reply", session_id).await;
    assert_eq!(replies.len(), 1);

    let turns = client.messages_seen();
    let tool_sets = client.tools_seen();
    assert_eq!(
        turns.len(),
        4,
        "submit, gather evidence, answer, then reply"
    );

    // The two middle turns are inside the infer. `eval` must not be on offer
    // there: the omission is what stops `eval -> infer -> eval` from nesting
    // and is why a submitted program stays statically bounded.
    for (index, offered) in tool_sets.iter().enumerate().skip(1).take(2) {
        assert!(
            !offered.iter().any(|name| name == "eval"),
            "turn {index} offered eval inside an infer: {offered:?}"
        );
        assert!(
            offered.iter().any(|name| name == "read"),
            "turn {index} should still allow evidence gathering: {offered:?}"
        );
    }

    // The tool ran and its outcome came back to the model that asked for it.
    // The outcome is a refusal, and that is the point: the probe sits outside
    // the workspace, and a boundary crossing discovered inside an `infer`
    // could not have been part of what the submitted program was admitted
    // for, so it fails closed instead of escalating for approval.
    let tool_result = turns[2]
        .iter()
        .find(|message| message.role == "tool")
        .expect("the read outcome must reach the model that asked for it");
    assert!(
        tool_result.content.contains("拒绝"),
        "an out-of-workspace read must be refused inside infer too: {}",
        tool_result.content
    );

    let outputs = wait_for_topic(&store, "chat/tool_output", session_id).await;
    let eval_output = outputs
        .iter()
        .find(|event| event.payload.get("tool_name").and_then(|v| v.as_str()) == Some("eval"))
        .expect("the eval call produced an observation");
    assert_eq!(
        eval_output.payload.get("text").and_then(|v| v.as_str()),
        Some("\"Rust\""),
        "the answer given without tool calls is the value of the step"
    );
}
