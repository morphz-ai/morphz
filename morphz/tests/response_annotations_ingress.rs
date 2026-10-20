//! Ingress contracts through the production SessionHandle, atomic SQLite
//! acceptance and real Runtime startup. Provider responses are scripted; no
//! AcceptedInput/Event, scheduler Signal or request fingerprint is seeded.
use morphz::{
    config::AppConfig,
    event::Event,
    llm::{
        Client, Message, ModelAttemptBinding, ModelAttemptBindingError, ModelRequestContext,
        ModelRequestOptions, ModelStreamEvent, ModelStreamSender, PromptTokenCount, Response,
        ToolCallRepr, ToolDefinition,
    },
    memory::{
        sqlite::SqliteStore, ActivationStore, DeliveryIngressStore, EventStore, ExecutionJobFilter,
        ExecutionJobStore, NewAgent, NewCognitiveContext, NewSession, QueryFilter, RuntimeStore,
        SessionMountKind, ThreadLifecycle, ThreadStore,
    },
    response_annotations::Protocol,
    runtime::{
        MorphzRuntime, RuntimeIdentity, RuntimeToolPolicy, SessionHandle, SessionMessageOptions,
    },
    session_io::{AcceptedInput, IoError, Limits, Request},
    tool::Tool,
};
use serde_json::{json, Value};
use std::{
    error::Error,
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tempfile::TempDir;

type DynError = Box<dyn Error + Send + Sync>;
const AGENT: &str = "annotations-ingress-agent";
const CONTEXT: &str = "annotations-ingress-context";
const SESSION: &str = "annotations-ingress-session";
const PRINCIPAL: &str = "principal-default";
const FINAL_TEXT: &str = "合成业务操作完成。";

#[derive(Clone, Copy, Debug)]
enum BusinessSchema {
    ReplyName,
    AnnotationsParameter,
    Ordinary,
}

impl BusinessSchema {
    fn name(self) -> &'static str {
        match self {
            Self::ReplyName => "reply",
            Self::AnnotationsParameter | Self::Ordinary => "ingress_probe",
        }
    }

    fn arguments(self) -> Value {
        match self {
            Self::AnnotationsParameter => {
                json!({"value":"ordinary", "_annotations":{"business":"ordinary payload"}})
            }
            Self::ReplyName | Self::Ordinary => json!({"value":"ordinary"}),
        }
    }
}

struct BusinessTool {
    schema: BusinessSchema,
    arguments: Arc<Mutex<Vec<Value>>>,
}

#[async_trait::async_trait]
impl Tool for BusinessTool {
    fn name(&self) -> &str {
        self.schema.name()
    }

    fn definition(&self) -> ToolDefinition {
        let mut properties = json!({"value":{"type":"string"}});
        if matches!(self.schema, BusinessSchema::AnnotationsParameter) {
            properties["_annotations"] = json!({"type":"object"});
        }
        ToolDefinition {
            name: self.name().into(),
            description: "Synthetic business operation, without external effects.".into(),
            parameters: json!({
                "type":"object", "properties":properties,
                "required":["value"], "additionalProperties":false,
            }),
        }
    }

    async fn execute(&self, arguments: &str) -> Result<String, DynError> {
        self.arguments
            .lock()
            .unwrap()
            .push(serde_json::from_str(arguments)?);
        Ok("synthetic business receipt".into())
    }
}

struct NativeClient {
    schema: BusinessSchema,
    calls: AtomicUsize,
    captured_tools: Mutex<Vec<Vec<ToolDefinition>>>,
    captured_bind_requests: Mutex<Vec<Value>>,
    captured_requests: Mutex<Vec<Value>>,
    captured_responses: Mutex<Vec<Value>>,
}

impl NativeClient {
    fn new(schema: BusinessSchema) -> Self {
        Self {
            schema,
            calls: AtomicUsize::new(0),
            captured_tools: Mutex::new(Vec::new()),
            captured_bind_requests: Mutex::new(Vec::new()),
            captured_requests: Mutex::new(Vec::new()),
            captured_responses: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait::async_trait]
impl Client for NativeClient {
    fn model(&self) -> Option<String> {
        Some("annotations-ingress-fixture".into())
    }

    fn supports_async_cancellation(&self) -> bool {
        true
    }

    async fn bind_model_attempt(
        &self,
        request: &ModelRequestContext,
    ) -> Result<ModelAttemptBinding, ModelAttemptBindingError> {
        self.captured_bind_requests
            .lock()
            .unwrap()
            .push(json!(request));
        Ok(ModelAttemptBinding {
            requested_alias: "annotations-ingress-fixture".into(),
            route_id: "synthetic-ingress-route".into(),
            route_revision: "fixture-v1".into(),
            provider_instance_id: "synthetic-provider".into(),
            auth_account_id: "synthetic-account".into(),
            physical_model: "synthetic-model".into(),
            protocol: "openai-responses".into(),
            provider_adapter: "synthetic-native".into(),
            provider_adapter_version: "1".into(),
            endpoint: "http://127.0.0.1:1/v1".into(),
            request_session_id: Some(request.session_id.clone()),
            capabilities: Vec::new(),
            model_input_limits: Default::default(),
        })
    }

    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
    ) -> Result<Response, DynError> {
        panic!("ingress fixture must use the bound native entry, not atomic fallback")
    }

    async fn create_completion_bound_stream_with_options(
        &self,
        binding: &ModelAttemptBinding,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
        _measurement: Option<PromptTokenCount>,
        stream: ModelStreamSender,
        options: ModelRequestOptions,
    ) -> Result<Response, DynError> {
        let index = self.calls.fetch_add(1, Ordering::SeqCst);
        // Keep the original per-request causal input, including all native
        // receipts. The restart case queues two roots in one Session, so a
        // tools-only snapshot cannot explain which receipt drove a response.
        // This fixture contains only synthetic data and synthetic credentials.
        self.captured_requests.lock().unwrap().push(json!({
            "index": index,
            "binding": binding,
            "options": format!("{options:?}"),
            "messages": &messages,
            "tools": &tools,
        }));
        assert!(
            index < 4,
            "retry/preflight must not cause an extra model request"
        );
        self.captured_tools.lock().unwrap().push(tools);
        let receipt = messages.iter().find(|message| {
            message.role == "tool"
                && message.tool_call_id.as_deref() == Some("ingress-business-call")
        });
        let response = if let Some(receipt) = receipt {
            let receipt: Value = serde_json::from_str(&receipt.content).unwrap();
            assert_eq!(receipt["status"], "success");
            Response {
                content: FINAL_TEXT.into(),
                tool_calls: Vec::new(),
            }
        } else {
            Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: "ingress-business-call".into(),
                    r#type: "function".into(),
                    func_name: self.schema.name().into(),
                    arguments: self.schema.arguments().to_string(),
                }],
            }
        };
        self.captured_responses.lock().unwrap().push(json!({
            "index": index,
            "selected_receipt": receipt,
            "content": &response.content,
            "tool_calls": &response.tool_calls,
        }));
        let _ = stream.send(ModelStreamEvent::Started);
        for (index, call) in response.tool_calls.iter().enumerate() {
            let _ = stream.send(ModelStreamEvent::ToolCallStarted {
                index,
                id: call.id.clone(),
                name: call.func_name.clone(),
            });
            let _ = stream.send(ModelStreamEvent::ToolArgumentsDelta {
                index,
                delta: call.arguments.clone(),
            });
            let _ = stream.send(ModelStreamEvent::ToolCallCompleted { index });
        }
        if !response.content.is_empty() {
            let _ = stream.send(ModelStreamEvent::TextDelta {
                text: response.content.clone(),
            });
        }
        let _ = stream.send(ModelStreamEvent::Completed);
        Ok(response)
    }
}

struct Fixture {
    store: Arc<SqliteStore>,
    runtime: MorphzRuntime,
    session: SessionHandle,
    client: Arc<NativeClient>,
    arguments: Arc<Mutex<Vec<Value>>>,
}

impl Fixture {
    async fn open(workspace: &Path, schema: BusinessSchema, default: Protocol) -> Self {
        // Integration dependencies do not have the library's #[cfg(test)]
        // failure print. Capture its real error when a durable generic failure
        // reply alone cannot explain why an Activation stopped.
        let _ = tracing_subscriber::fmt()
            .with_env_filter("morphz=warn")
            .with_test_writer()
            .try_init();
        let store = Arc::new(
            SqliteStore::new(workspace.join("ingress.db").to_str().unwrap())
                .await
                .unwrap(),
        );
        let client = Arc::new(NativeClient::new(schema));
        let arguments = Arc::new(Mutex::new(Vec::new()));
        let mut config = AppConfig::default();
        config.llm.model = "annotations-ingress-fixture".into();
        config.permissions.workspace_root = workspace.to_string_lossy().into_owned();
        config.background_task.artifact_dir =
            workspace.join("artifacts").to_string_lossy().into_owned();
        config.orchestrator.response_annotations = default;
        let runtime = MorphzRuntime::builder(config, client.clone() as Arc<dyn Client>)
            .identity(RuntimeIdentity {
                agent_id: AGENT.into(),
                context_id: CONTEXT.into(),
                principal_id: PRINCIPAL.into(),
            })
            .store(
                "sqlite:annotations-ingress",
                store.clone() as Arc<dyn RuntimeStore>,
            )
            .tool_policy(RuntimeToolPolicy {
                context_only: false,
                coding_eval: false,
            })
            .extra_tool(Arc::new(BusinessTool {
                schema,
                arguments: arguments.clone(),
            }))
            .build()
            .await
            .unwrap();
        // Construction deliberately does not start scheduling. All input below
        // still goes through the real authorized, transactional API ingress.
        runtime
            .ensure_agent(NewAgent {
                id: AGENT.into(),
                title: "Ingress fixture".into(),
                root_context_id: CONTEXT.into(),
            })
            .await
            .unwrap();
        runtime
            .ensure_context(NewCognitiveContext {
                id: CONTEXT.into(),
                agent_id: AGENT.into(),
                title: "Ingress context".into(),
            })
            .await
            .unwrap();
        let session = runtime
            .ensure_session(NewSession {
                id: SESSION.into(),
                agent_id: AGENT.into(),
                context_id: CONTEXT.into(),
                parent_session_id: None,
                title: "Annotations ingress".into(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        Self {
            store,
            runtime,
            session,
            client,
            arguments,
        }
    }

    fn request(id: &str, protocol: Option<Protocol>) -> Request {
        let mut request = Request::parse(
            json!({
                "io_version":"1", "client_message_id":id,
                "message":{
                    "format":{"id":"morphz.chat","version":"1"},
                    "content":{"encoding":"json","value":{"text":"Run synthetic business operation"}},
                },
            })
            .to_string()
            .as_bytes(),
            &Limits::default(),
        )
        .unwrap();
        request.activation.response_annotations = protocol;
        request
    }

    async fn send(&self, request: Request) -> Result<Event, IoError> {
        self.session.send_io_as_principal(request, PRINCIPAL).await
    }

    async fn jobs(&self) -> Vec<morphz::memory::ExecutionJobRecord> {
        self.store
            .list_execution_jobs(ExecutionJobFilter {
                session_id: Some(SESSION.into()),
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap()
    }

    async fn events(&self, root: &str, topic: Option<&str>) -> Vec<Event> {
        self.store
            .query(QueryFilter {
                session_id: Some(SESSION.into()),
                root_turn_id: Some(root.into()),
                topic: topic.map(str::to_owned),
                ..Default::default()
            })
            .await
            .unwrap()
    }

    async fn failure_diagnostics(&self, root: &str) -> Value {
        fn observed<T: serde::Serialize>(result: Result<T, DynError>) -> Value {
            match result {
                Ok(value) => json!({"value": value}),
                Err(error) => json!({"diagnostic_read_error": error.to_string()}),
            }
        }
        // Read the complete private fixture Context, not just the failed root:
        // a startup or storage error may have no root route. This Context has
        // at most the bounded synthetic model requests above; no user store is
        // connected. Preserve each read failure without replacing the original
        // lifecycle assertion with a diagnostic unwrap panic.
        let events = self
            .store
            .query(QueryFilter {
                context_id: Some(CONTEXT.into()),
                ..Default::default()
            })
            .await
            .map(|mut events| {
                events.sort_by_key(|event| event.sequence);
                events
            });
        let threads = self
            .store
            .list_session_threads(CONTEXT, SESSION, true)
            .await;
        let activations = self
            .store
            .list_context_thread_activations(CONTEXT, true)
            .await;
        let jobs = self
            .store
            .list_execution_jobs(ExecutionJobFilter {
                session_id: Some(SESSION.into()),
                include_terminal: true,
                ..Default::default()
            })
            .await;
        json!({
            "failed_root": root,
            "events": observed(events),
            "threads": observed(threads),
            "activations": observed(activations),
            "jobs": observed(jobs),
            "model_call_count": self.client.calls.load(Ordering::SeqCst),
            "model_bind_requests": self.client.captured_bind_requests.lock().unwrap().clone(),
            "model_requests": self.client.captured_requests.lock().unwrap().clone(),
            "model_responses": self.client.captured_responses.lock().unwrap().clone(),
            "business_arguments": self.arguments.lock().unwrap().clone(),
        })
    }

    async fn wait_completed(&self, root: &str) {
        tokio::time::timeout(Duration::from_secs(25), async {
            loop {
                let thread = self.store.get_thread_by_root(root).await.unwrap().unwrap();
                if thread.lifecycle.is_terminal() {
                    if thread.lifecycle != ThreadLifecycle::Completed {
                        eprintln!("Original durable ingress terminal state: {thread:#?}");
                        let diagnostics = self.failure_diagnostics(root).await;
                        assert_eq!(
                            thread.lifecycle,
                            ThreadLifecycle::Completed,
                            "Synthetic ingress durable failure:\n{}",
                            serde_json::to_string_pretty(&diagnostics).unwrap(),
                        );
                    }
                    assert_eq!(thread.lifecycle, ThreadLifecycle::Completed);
                    let replies = self.events(root, Some("chat/reply")).await;
                    assert_eq!(replies.len(), 1);
                    assert_eq!(replies[0].payload["text"], FINAL_TEXT);
                    return;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("original accepted Off input did not complete through Runtime");
    }
}

fn accepted_input(event: &Event) -> AcceptedInput {
    serde_json::from_value(event.payload["session_io"].clone()).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn annotation_mode_does_not_reserve_business_names_or_mutate_business_arguments() {
    for schema in [
        BusinessSchema::ReplyName,
        BusinessSchema::AnnotationsParameter,
    ] {
        let mut baseline_bytes = None;
        for protocol in [Protocol::Off, Protocol::On] {
            for typed in [true, false] {
                let temp = TempDir::new().unwrap();
                let fixture = Fixture::open(temp.path(), schema, Protocol::Off).await;
                fixture.runtime.start().await.unwrap();
                let accepted_id = if typed {
                    fixture
                        .send(Fixture::request("same-business-request", Some(protocol)))
                        .await
                        .unwrap()
                        .id
                } else {
                    fixture
                        .session
                        .send_as_principal_with_options(
                            "Run synthetic business operation",
                            "Session-Client",
                            PRINCIPAL,
                            Some("native-business-request".into()),
                            SessionMessageOptions {
                                response_annotations: Some(protocol),
                                ..Default::default()
                            },
                        )
                        .await
                        .unwrap()
                        .event_id
                };
                fixture.wait_completed(&accepted_id).await;
                assert_eq!(fixture.client.calls.load(Ordering::SeqCst), 2);
                assert_eq!(
                    fixture.arguments.lock().unwrap().as_slice(),
                    &[schema.arguments()]
                );
                let jobs = fixture.jobs().await;
                assert_eq!(jobs.len(), 1);
                assert_eq!(jobs[0].tool_name, schema.name());
                let actual_tools = fixture.client.captured_tools.lock().unwrap().clone();
                let bytes = serde_json::to_vec(&actual_tools[0]).unwrap();
                assert_eq!(*baseline_bytes.get_or_insert(bytes.clone()), bytes);
                assert_eq!(serde_json::to_vec(&actual_tools[1]).unwrap(), bytes);
                let actual = actual_tools[0]
                    .iter()
                    .find(|tool| tool.name == schema.name())
                    .unwrap();
                let baseline = morphz::tool::Registry::new();
                baseline.register(Arc::new(BusinessTool {
                    schema,
                    arguments: fixture.arguments.clone(),
                }));
                let original = baseline.definitions();
                let projected = morphz::session_io::native::model_tools(&original).unwrap();
                assert_eq!(actual.parameters, projected[0].parameters);
                // Projection only adds the registered display field. The Job
                // assertion above still checks the exact original arguments;
                // the business schema and its required fields are unchanged.
                let mut unwrapped = actual.parameters.clone();
                assert!(unwrapped["properties"]
                    .as_object_mut()
                    .unwrap()
                    .remove(morphz::session_io::native::METADATA_KEY)
                    .is_some());
                assert_eq!(unwrapped, original[0].parameters);
                let thread = fixture
                    .store
                    .get_thread_by_root(&accepted_id)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(thread.response_annotations, protocol);
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn omitted_choice_retry_after_restart_keeps_old_off_binding_despite_enabled_default_and_collision(
) {
    let temp = TempDir::new().unwrap();
    let original = Fixture::open(temp.path(), BusinessSchema::ReplyName, Protocol::Off).await;
    let request = Fixture::request("restart-omitted", None);
    let accepted = original.send(request.clone()).await.unwrap();
    let original_input = accepted_input(&accepted);
    assert!(original_input
        .request
        .activation
        .response_annotations
        .is_none());
    assert!(original_input
        .binding
        .execution
        .get("response_annotations")
        .is_none());
    assert!(accepted.payload.get("response_annotations").is_none());
    let original_thread = original
        .store
        .get_thread_by_root(&accepted.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(original_thread.response_annotations, Protocol::Off);
    assert_eq!(original.client.calls.load(Ordering::SeqCst), 0);
    assert!(original.jobs().await.is_empty());
    // Drop every seeding Runtime/Store handle. There is no hand-seeded receipt
    // and no first Runtime scheduler to race the genuinely new owner below.
    drop(original);

    let restarted = Fixture::open(temp.path(), BusinessSchema::ReplyName, Protocol::On).await;
    let duplicate = restarted.send(request.clone()).await.unwrap();
    assert_eq!(
        duplicate, accepted,
        "the persisted acceptance is the binding authority"
    );
    assert_eq!(accepted_input(&duplicate), original_input);
    assert_eq!(
        restarted
            .store
            .get_thread_by_root(&accepted.id)
            .await
            .unwrap(),
        Some(original_thread)
    );
    assert_eq!(restarted.client.calls.load(Ordering::SeqCst), 0);
    assert!(restarted.jobs().await.is_empty());
    assert_eq!(
        restarted
            .store
            .list_session_threads(CONTEXT, SESSION, true)
            .await
            .unwrap()
            .len(),
        1,
        "an exact retry must not manufacture another execution",
    );
    // Defaults affect only fresh acceptance. A business tool named reply is
    // not an annotation carrier or a reserved name in either mode.
    let fresh = restarted
        .send(Fixture::request("fresh-on-collision", None))
        .await
        .unwrap();
    assert_eq!(
        restarted
            .store
            .message_event_id(SESSION, "fresh-on-collision")
            .await
            .unwrap(),
        Some(fresh.id.clone())
    );
    assert_eq!(
        restarted
            .store
            .get_thread_by_root(&fresh.id)
            .await
            .unwrap()
            .unwrap()
            .response_annotations,
        Protocol::On
    );
    assert_eq!(restarted.client.calls.load(Ordering::SeqCst), 0);

    restarted.runtime.start().await.unwrap();
    restarted.wait_completed(&accepted.id).await;
    restarted.wait_completed(&fresh.id).await;
    assert_eq!(restarted.client.calls.load(Ordering::SeqCst), 4);
    assert_eq!(
        restarted.arguments.lock().unwrap().as_slice(),
        &[
            BusinessSchema::ReplyName.arguments(),
            BusinessSchema::ReplyName.arguments()
        ]
    );
    let jobs = restarted.jobs().await;
    assert_eq!(
        jobs.len(),
        2,
        "each distinct accepted input executes once, not each retry"
    );
    let original_thread_id = restarted
        .store
        .get_thread_by_root(&accepted.id)
        .await
        .unwrap()
        .unwrap()
        .id;
    assert!(jobs.iter().any(|job| job.thread_id == original_thread_id));
    let duplicate = restarted.send(request).await.unwrap();
    assert_eq!(duplicate, accepted);
    assert_eq!(accepted_input(&duplicate), original_input);
    assert_eq!(restarted.client.calls.load(Ordering::SeqCst), 4);
    assert_eq!(
        restarted.jobs().await,
        jobs,
        "post-completion retry must not dispatch again"
    );
    assert_eq!(
        restarted
            .events(&accepted.id, Some("chat/reply"))
            .await
            .len(),
        1
    );
    assert_eq!(
        restarted
            .store
            .get_thread_by_root(&accepted.id)
            .await
            .unwrap()
            .unwrap()
            .response_annotations,
        Protocol::Off
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn explicit_off_enabled_and_omitted_choices_have_distinct_durable_api_fingerprints() {
    let choices = [None, Some(Protocol::Off), Some(Protocol::On)];
    let mut fingerprints = Vec::new();
    for choice in choices {
        let temp = TempDir::new().unwrap();
        let fixture = Fixture::open(temp.path(), BusinessSchema::Ordinary, Protocol::Off).await;
        // The same ID, Principal and message in independent stores isolate the
        // raw protocol choice. Fingerprints below come only from actual API
        // acceptance; this test never invokes/simulates a hashing helper.
        let request = Fixture::request("identical-request-id", choice);
        let accepted = fixture.send(request.clone()).await.unwrap();
        let bound = accepted_input(&accepted);
        fingerprints.push(bound.request_fingerprint.clone());
        assert_eq!(bound.request.activation.response_annotations, choice);
        let thread = fixture
            .store
            .get_thread_by_root(&accepted.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(thread.response_annotations, choice.unwrap_or(Protocol::Off));
        if choice == Some(Protocol::On) {
            assert_eq!(bound.binding.execution["response_annotations"], "on");
        } else {
            assert!(bound
                .binding
                .execution
                .get("response_annotations")
                .is_none());
        }
        assert_eq!(fixture.send(request).await.unwrap(), accepted);
        for alternate in choices.into_iter().filter(|alternate| *alternate != choice) {
            let error = fixture
                .send(Fixture::request("identical-request-id", alternate))
                .await
                .unwrap_err();
            assert_eq!(error.code, "idempotency_conflict");
            assert_eq!(error.status(), 409);
        }
        assert_eq!(
            fixture
                .store
                .get_thread_by_root(&accepted.id)
                .await
                .unwrap(),
            Some(thread)
        );
        assert_eq!(
            fixture
                .store
                .list_session_threads(CONTEXT, SESSION, true)
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            fixture
                .events(&accepted.id, Some("chat/user_message"))
                .await,
            vec![accepted]
        );
        assert_eq!(fixture.client.calls.load(Ordering::SeqCst), 0);
        assert!(fixture.client.captured_tools.lock().unwrap().is_empty());
        assert!(fixture.jobs().await.is_empty());
    }
    assert_ne!(fingerprints[0], fingerprints[1]);
    assert_ne!(fingerprints[0], fingerprints[2]);
    assert_ne!(fingerprints[1], fingerprints[2]);
}
