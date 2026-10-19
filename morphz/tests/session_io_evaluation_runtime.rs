//! Current Session IO carrier through the actual scheduler, Jobs, SQLite,
//! Context projection, annotations and public-output stream. Model values are
//! scripted here; the separately explicit live gate uses the configured route.
use morphz::{
    config::AppConfig,
    event::Event,
    llm::{
        Client, Message, ModelAttemptBinding, ModelRequestOptions, ModelStreamEvent,
        ModelStreamSender, PromptTokenCount, Response, ToolCallRepr, ToolDefinition,
    },
    memory::{ExecutionJobFilter, NewSession, QueryFilter, SessionMountKind},
    response_annotations::{AnnotationKind, PersistedAnnotations, Protocol, BUNDLE_PAYLOAD_KEY},
    runtime::{MorphzRuntime, RuntimeToolPolicy},
    session_io::{Limits, Request},
    tool::Tool,
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
type DynError = Box<dyn Error + Send + Sync>;

fn observation(messages: &[Message], tool: &str) -> Option<String> {
    use morphz::sexpr::SExpr;
    fn visit(value: &SExpr, tool: &str) -> Option<String> {
        if let SExpr::List(items) = value {
            if matches!(items.first(),Some(SExpr::Atom(name)) if name=="observation")
                && matches!(value.get_path(&["tool"]),Some(SExpr::Atom(name)) if name==tool)
            {
                if let Some(SExpr::Atom(reference)) = value.get_path(&["ref"]) {
                    return Some(reference.clone());
                }
            }
            return items.iter().find_map(|item| visit(item, tool));
        }
        None
    }
    messages.iter().rev().find_map(|message| {
        let text = morphz::llm::model_visible_message_text(message);
        let start = text.find("(context ")?;
        visit(&morphz::sexpr::parse(&text[start..]).ok()?, tool)
    })
}

struct Model {
    work: bool,
    infer: bool,
    malformed: bool,
    annotation_extras: bool,
    metadata: bool,
    requests: AtomicUsize,
    directory: Mutex<Vec<String>>,
    inputs: Mutex<Vec<Vec<Message>>>,
}
#[async_trait::async_trait]
impl Client for Model {
    fn supports_async_cancellation(&self) -> bool {
        true
    }
    async fn create_completion(
        &self,
        _: Vec<Message>,
        _: Vec<ToolDefinition>,
    ) -> Result<Response, DynError> {
        panic!("must use the bound request")
    }
    async fn create_completion_bound_stream_with_options(
        &self,
        _: &ModelAttemptBinding,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
        _: Option<PromptTokenCount>,
        stream: ModelStreamSender,
        options: ModelRequestOptions,
    ) -> Result<Response, DynError> {
        let index = self.requests.fetch_add(1, Ordering::SeqCst);
        assert!(
            index < if self.work { 2 } else { 1 },
            "no annotation-repair or reply-relay request"
        );
        assert_eq!(
            options.output_encoding, None,
            "annotation mode must not select a JSON envelope"
        );
        self.directory
            .lock()
            .unwrap()
            .push(serde_json::to_string(&tools)?);
        self.inputs.lock().unwrap().push(messages.clone());
        let mut observations = vec![];
        if self.work && index == 1 {
            assert!(
                messages.iter().any(|message| message.role == "tool"
                    && message.tool_call_id.as_deref() == Some("actual-probe-call")),
                "native work keeps its actual function receipt"
            );
            assert!(
                messages
                    .iter()
                    .flat_map(|m| m.tool_calls.iter().flatten())
                    .all(|call| call.function.name != "deliver_message"),
                "logical metadata never creates an unanswered function call in the continuation"
            );
            let reference = messages
                .iter()
                .find(|message| {
                    message.role == "tool"
                        && message.tool_call_id.as_deref() == Some("actual-probe-call")
                })
                .and_then(|message| serde_json::from_str::<Value>(&message.content).ok())
                .and_then(|value| value["observation_ref"].as_str().map(str::to_owned))
                .or_else(|| observation(&messages, "evaluation_probe"))
                .expect("actual native result must retain its real observation ref");
            observations
                .push(json!({"ref":reference,"result":"真实合成工具返回 PROBE_FACT_LINUX"}));
        }
        let working = self.work && index == 0;
        let mut value = json!({"execution":{"title":"核对合成环境","progress":if working {"读取合成工具"}else{""},"result":if working {""}else{"已返回完整结果"}},"observations":observations});
        if working {
            value["calls"] = json!([{"index":0,"intent":"读取真实合成工具以核对环境"}]);
        }
        if self.annotation_extras {
            value["observations_note"] = Value::Null;
            value["execution"]["progress"] = Value::Null;
            value["execution"]["unregistered"] = json!({"name":"not-a-proposal"});
            if let Some(observation) = value["observations"].as_array_mut().unwrap().first_mut() {
                observation["unregistered"] = json!(false);
            }
        }
        let mut tool_calls = vec![];
        if working {
            tool_calls.push(ToolCallRepr {
                id: "actual-probe-call".into(),
                r#type: "function".into(),
                func_name: "evaluation_probe".into(),
                arguments: json!({"key":"system","_annotations":{"business":true}}).to_string(),
            });
        }
        if self.metadata || self.malformed {
            let binding = ScriptBinding::from_messages(&messages);
            let mut arguments = json!({"delivery_id":binding,"message":{"format":{"id":"morphz.response.annotations","version":"1"},"content":{"encoding":"json","value":value}}}).to_string();
            if self.malformed {
                arguments.push('}');
            }
            tool_calls.push(ToolCallRepr {
                id: "actual-metadata-call".into(),
                r#type: "function".into(),
                func_name: "deliver_message".into(),
                arguments,
            });
        }
        let content = if working {
            String::new()
        } else if self.infer {
            json!("中文 🧠\n第二行").to_string()
        } else {
            "核对完成。\n正文里的 `deliver_message` 和 {\"body\":1} 都只是文字。".into()
        };
        stream.send(ModelStreamEvent::Started)?;
        for character in content.chars() {
            stream.send(ModelStreamEvent::TextDelta {
                text: character.to_string(),
            })?;
            tokio::task::yield_now().await;
        }
        for (index, call) in tool_calls.iter().enumerate() {
            stream.send(ModelStreamEvent::ToolCallStarted {
                index,
                id: call.id.clone(),
                name: call.func_name.clone(),
            })?;
            for c in call.arguments.chars() {
                stream.send(ModelStreamEvent::ToolArgumentsDelta {
                    index,
                    delta: c.to_string(),
                })?;
            }
            stream.send(ModelStreamEvent::ToolCallCompleted { index })?;
        }
        stream.send(ModelStreamEvent::Completed)?;
        Ok(Response {
            content,
            tool_calls,
        })
    }
}
struct ScriptBinding;
impl ScriptBinding {
    fn from_messages(messages: &[Message]) -> String {
        messages
            .iter()
            .rev()
            .find_map(|message| {
                let text = morphz::llm::model_visible_message_text(message);
                let start = text.find("(context ")?;
                let tree = morphz::sexpr::parse(&text[start..]).ok()?;
                match tree.get_path(&["evaluation-environment", "session-io-return", "delivery_id"])
                {
                    Some(morphz::sexpr::SExpr::Atom(id)) => Some(id.clone()),
                    _ => None,
                }
            })
            .expect("actual Runtime return binding")
    }
}
struct Probe(Arc<Mutex<Vec<Value>>>);
#[async_trait::async_trait]
impl Tool for Probe {
    fn name(&self) -> &str {
        "evaluation_probe"
    }
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().into(),
            description: "Synthetic read-only probe".into(),
            parameters: json!({"type":"object","additionalProperties":false,"required":["key"],"properties":{"key":{"type":"string"},"_annotations":{"type":"object"}}}),
        }
    }
    async fn execute(&self, args: &str) -> Result<String, DynError> {
        self.0.lock().unwrap().push(serde_json::from_str(args)?);
        Ok("PROBE_FACT_LINUX".into())
    }
}

async fn run(
    work: bool,
    infer: bool,
    malformed: bool,
) -> (
    tempfile::TempDir,
    MorphzRuntime,
    Arc<Model>,
    Arc<Mutex<Vec<Value>>>,
    Event,
    Event,
) {
    run_with_annotation_extras(work, infer, malformed, false).await
}

async fn run_with_annotation_extras(
    work: bool,
    infer: bool,
    malformed: bool,
    annotation_extras: bool,
) -> (
    tempfile::TempDir,
    MorphzRuntime,
    Arc<Model>,
    Arc<Mutex<Vec<Value>>>,
    Event,
    Event,
) {
    run_optional(
        work,
        infer,
        malformed,
        annotation_extras,
        true,
        Protocol::On,
    )
    .await
}

async fn run_optional(
    work: bool,
    infer: bool,
    malformed: bool,
    annotation_extras: bool,
    metadata: bool,
    protocol: Protocol,
) -> (
    tempfile::TempDir,
    MorphzRuntime,
    Arc<Model>,
    Arc<Mutex<Vec<Value>>>,
    Event,
    Event,
) {
    let temp = tempfile::TempDir::new().unwrap();
    let mut config = AppConfig::default();
    config.permissions.workspace_root = temp.path().to_string_lossy().into_owned();
    config.background_task.artifact_dir =
        temp.path().join("artifacts").to_string_lossy().into_owned();
    config.orchestrator.response_annotations = protocol;
    let model = Arc::new(Model {
        work,
        infer,
        malformed,
        annotation_extras,
        metadata,
        requests: AtomicUsize::new(0),
        directory: Mutex::new(vec![]),
        inputs: Mutex::new(vec![]),
    });
    let arguments = Arc::new(Mutex::new(vec![]));
    let mut builder = MorphzRuntime::builder(config, model.clone())
        .database_path(temp.path().join("runtime.db").to_str().unwrap())
        .tool_policy(RuntimeToolPolicy {
            context_only: false,
            coding_eval: false,
        })
        .extra_tool(Arc::new(Probe(arguments.clone())));
    if infer {
        builder=builder.harness_package(morphz::harness_package::HarnessPackage::from_source("TEST-session-io-infer.hns",r#"
            (manifest (id "TEST-session-io-infer") (version "1.0.0") (title "TEST single infer") (capabilities (tools)))
            (contract (identity "Synthetic single-infer return"))
            (infer (requires (tools)) (returns String) "Return a complete synthetic Chinese String")
        "#).unwrap());
    }
    let runtime = builder.build().await.unwrap();
    runtime.start().await.unwrap();
    let session = runtime
        .ensure_session(NewSession {
            id: "evaluation-session".into(),
            agent_id: runtime.identity().agent_id.clone(),
            context_id: runtime.identity().context_id.clone(),
            parent_session_id: None,
            title: "Synthetic IO".into(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    let mut request=Request::parse(json!({"io_version":"1","client_message_id":"evaluation-input","message":{"format":{"id":"morphz.chat","version":"1"},"content":{"encoding":"json","value":{"text":"只执行指定的合成核对"}}}}).to_string().as_bytes(),&Limits::default()).unwrap();
    if infer {
        request.activation.harness = Some(morphz::harness::ExactHarnessRef {
            id: "TEST-session-io-infer".into(),
            version: "1.0.0".into(),
        });
    }
    let root = session
        .send_io_as_principal(request, &runtime.identity().principal_id)
        .await
        .unwrap();
    let reply = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let events = runtime
                .query_events(QueryFilter {
                    root_turn_id: Some(root.id.clone()),
                    ..Default::default()
                })
                .await
                .unwrap();
            if let Some(reply) = events
                .into_iter()
                .find(|event| matches!(event.topic.as_str(), "chat/reply" | "session/io_state"))
            {
                break reply;
            }
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    })
    .await
    .expect("Runtime must reach a real terminal boundary");
    (temp, runtime, model, arguments, root, reply)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn native_body_and_optional_metadata_publish_once_without_a_relay() {
    let (_temp, runtime, model, args, root, reply) = run(false, false, false).await;
    assert_eq!(reply.topic, "chat/reply", "{reply:?}");
    assert_eq!(model.requests.load(Ordering::SeqCst), 1);
    assert!(args.lock().unwrap().is_empty());
    assert!(reply.payload["text"]
        .as_str()
        .unwrap()
        .contains("都只是文字"));
    let events = runtime
        .query_events(QueryFilter {
            root_turn_id: Some(root.id.clone()),
            ..Default::default()
        })
        .await
        .unwrap();
    let sources = events
        .iter()
        .filter(|event| event.topic == "chat/assistant_call")
        .collect::<Vec<_>>();
    assert_eq!(sources.len(), 1);
    let bundle: PersistedAnnotations =
        serde_json::from_value(sources[0].payload[BUNDLE_PAYLOAD_KEY].clone()).unwrap();
    assert_eq!(bundle.raw_response.tool_calls.len(), 1);
    assert!(bundle.return_binding.as_ref().unwrap().output.is_none());
    assert!(bundle
        .records
        .iter()
        .any(|record| record.kind == AnnotationKind::Title));
    assert!(bundle
        .records
        .iter()
        .any(|record| record.kind == AnnotationKind::Result));
    assert!(bundle.diagnostics.is_empty(), "{:?}", bundle.diagnostics);
    assert_eq!(
        events
            .iter()
            .filter(|event| event.topic == "session/io_output"
                && event.payload["io_message"]["format"]["id"] == "morphz.response.annotations")
            .count(),
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn effects_keep_real_jobs_original_arguments_actual_refs_and_stable_tools() {
    let (_temp, runtime, model, args, root, reply) = run(true, false, false).await;
    assert_eq!(reply.topic, "chat/reply", "{reply:?}");
    assert_eq!(model.requests.load(Ordering::SeqCst), 2);
    assert_eq!(
        args.lock().unwrap().as_slice(),
        &[json!({"key":"system","_annotations":{"business":true}})]
    );
    let directory = model.directory.lock().unwrap();
    assert_eq!(directory.len(), 2);
    assert_eq!(directory[0], directory[1]);
    let jobs = runtime
        .list_execution_jobs(ExecutionJobFilter {
            session_id: Some("evaluation-session".into()),
            include_terminal: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].tool_name, "evaluation_probe");
    let events = runtime
        .query_events(QueryFilter {
            root_turn_id: Some(root.id.clone()),
            ..Default::default()
        })
        .await
        .unwrap();
    let bundles = events
        .iter()
        .filter_map(|event| event.payload.get(BUNDLE_PAYLOAD_KEY))
        .map(|value| serde_json::from_value::<PersistedAnnotations>(value.clone()).unwrap())
        .collect::<Vec<_>>();
    assert!(bundles.iter().any(|bundle| bundle
        .records
        .iter()
        .any(|record| record.kind == AnnotationKind::Intent)));
    assert!(bundles.iter().any(|bundle| bundle
        .records
        .iter()
        .any(|record| record.kind == AnnotationKind::ObservationResult)));
    assert!(bundles.iter().all(|bundle| bundle.diagnostics.is_empty()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn missing_metadata_and_off_mode_use_the_same_work_chat_and_infer_path() {
    let mut directory = None;
    for protocol in [Protocol::On, Protocol::Off] {
        for (work, infer, metadata) in [
            (false, false, false),
            (true, false, false),
            (false, true, false),
            (true, false, true),
        ] {
            if !protocol.is_off() && metadata {
                continue;
            }
            let (_temp, runtime, model, args, root, reply) =
                run_optional(work, infer, false, metadata, metadata, protocol).await;
            assert_eq!(
                reply.topic, "chat/reply",
                "{protocol:?} {work} {infer}: {reply:?}"
            );
            assert_eq!(
                model.requests.load(Ordering::SeqCst),
                if work { 2 } else { 1 },
                "no metadata repair or answer relay"
            );
            assert_eq!(args.lock().unwrap().len(), usize::from(work));
            if !infer {
                let current = model.directory.lock().unwrap()[0].clone();
                if let Some(expected) = &directory {
                    assert_eq!(
                        &current, expected,
                        "tool definitions stay identical across on/off"
                    );
                } else {
                    directory = Some(current);
                }
            }
            let events = runtime
                .query_events(QueryFilter {
                    root_turn_id: Some(root.id),
                    ..Default::default()
                })
                .await
                .unwrap();
            assert!(!events
                .iter()
                .any(|event| event.topic == "runtime/response_protocol_error"));
            for value in events
                .iter()
                .filter_map(|event| event.payload.get(BUNDLE_PAYLOAD_KEY))
            {
                let bundle: PersistedAnnotations = serde_json::from_value(value.clone()).unwrap();
                assert!(bundle.records.is_empty() && bundle.diagnostics.is_empty());
                assert!(bundle.annotation_messages.is_empty());
                assert!(bundle.return_binding.unwrap().output.is_none());
            }
            assert!(
                !events.iter().any(|event| event.topic == "session/io_output"
                    && event.payload["io_message"]["format"]["id"]
                        == "morphz.response.annotations")
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unregistered_annotations_are_diagnosed_without_blocking_work_or_streamed_return() {
    let (_temp, runtime, model, args, root, reply) =
        run_with_annotation_extras(true, false, false, true).await;
    assert_eq!(reply.topic, "chat/reply", "{reply:?}");
    assert_eq!(
        model.requests.load(Ordering::SeqCst),
        2,
        "one work request and one actual result continuation, no repair"
    );
    assert_eq!(
        args.lock().unwrap().as_slice(),
        &[json!({"key":"system","_annotations":{"business":true}})]
    );
    let directory = model.directory.lock().unwrap();
    assert_eq!(directory.len(), 2);
    assert_eq!(directory[0], directory[1]);
    let events = runtime
        .query_events(QueryFilter {
            root_turn_id: Some(root.id.clone()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(!events
        .iter()
        .any(|event| event.topic == "runtime/response_protocol_error"));
    let sources = events
        .iter()
        .filter(|event| event.topic == "chat/assistant_call")
        .collect::<Vec<_>>();
    assert_eq!(sources.len(), 2);
    for source in sources {
        let bundle: PersistedAnnotations =
            serde_json::from_value(source.payload[BUNDLE_PAYLOAD_KEY].clone()).unwrap();
        assert!(bundle
            .raw_response
            .tool_calls
            .iter()
            .any(|call| call.arguments.contains("observations_note")));
        assert!(bundle.diagnostics.iter().any(|diagnostic| diagnostic
            .message
            .contains("/annotations/observations_note")));
        assert!(bundle
            .records
            .iter()
            .any(|record| record.kind == AnnotationKind::Title));
        assert!(bundle
            .annotation_messages
            .iter()
            .all(|message| match &message.content {
                morphz::session_io::Content::Json { value } =>
                    value.get("observations_note").is_none(),
                _ => false,
            }));
        let output = events
            .iter()
            .find(|event| {
                event.topic == "session/io_output"
                    && event.payload["source_event_id"] == source.id
                    && event.payload["io_message"]["format"]["id"] == "morphz.response.annotations"
            })
            .expect("real registered logical IO publication");
        let message: morphz::session_io::Message =
            serde_json::from_value(output.payload["io_message"].clone()).unwrap();
        let morphz::session_io::Content::Json { value } = &message.content else {
            panic!()
        };
        assert!(value.get("observations_note").is_none());
        morphz::session_io::validate_content(
            &message,
            &morphz::session_io::Registry::default()
                .resolve(&message.format, "json", "registered")
                .unwrap(),
            &Limits::default(),
        )
        .unwrap();
        assert!(
            morphz::response_annotations::annotations_from_authorized_event(source, &bundle.scope)
                .unwrap()
                .is_some()
        );
    }
    let bundles = events
        .iter()
        .filter_map(|event| event.payload.get(BUNDLE_PAYLOAD_KEY))
        .map(|value| serde_json::from_value::<PersistedAnnotations>(value.clone()).unwrap())
        .collect::<Vec<_>>();
    for kind in [
        AnnotationKind::Intent,
        AnnotationKind::ObservationResult,
        AnnotationKind::Result,
    ] {
        assert!(bundles
            .iter()
            .any(|bundle| bundle.records.iter().any(|record| record.kind == kind)));
    }
    assert_eq!(
        events
            .iter()
            .filter(|event| event.topic == "chat/reply")
            .count(),
        1
    );
    assert!(events.iter().any(
        |event| event.topic == "runtime/model_public_output" && event.sequence < reply.sequence
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn single_infer_returns_the_declared_value_without_a_relay_or_annotation_request() {
    let (_temp, runtime, model, _args, root, reply) = run(false, true, false).await;
    assert_eq!(reply.topic, "chat/reply", "{reply:?}");
    assert_eq!(model.requests.load(Ordering::SeqCst), 1);
    assert_eq!(reply.payload["text"], "中文 🧠\n第二行");
    let events = runtime
        .query_events(QueryFilter {
            root_turn_id: Some(root.id),
            ..Default::default()
        })
        .await
        .unwrap();
    let streamed = events
        .iter()
        .filter(|event| event.topic == "runtime/model_public_output")
        .collect::<Vec<_>>();
    assert_eq!(
        streamed.len(),
        1,
        "the real parent reply is public before final admission, not only an internal value"
    );
    assert_eq!(streamed[0].payload["text"], reply.payload["text"]);
    assert_eq!(
        streamed[0].payload["publication_key"],
        reply.payload["publication_key"]
    );
    assert_ne!(
        streamed[0].payload["model_attempt_id"], reply.payload["attempt_id"],
        "never invent a physical parent model request"
    );
    assert_eq!(streamed[0].payload["result_source"]["path"], json!([]));
    assert!(streamed[0].sequence < reply.sequence);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn invalid_carrier_never_executes_a_proposal_or_requests_a_repair() {
    let (_temp, _runtime, model, args, _root, reply) = run(true, false, true).await;
    assert_eq!(reply.topic, "session/io_state");
    assert_eq!(model.requests.load(Ordering::SeqCst), 1);
    assert!(args.lock().unwrap().is_empty());
}

struct NativeCount(AtomicUsize);
#[async_trait::async_trait]
impl Client for NativeCount {
    async fn create_completion(
        &self,
        messages: Vec<Message>,
        _: Vec<ToolDefinition>,
    ) -> Result<Response, DynError> {
        assert_eq!(
            self.0.fetch_add(1, Ordering::SeqCst),
            0,
            "no format repair request"
        );
        assert!(messages
            .iter()
            .any(|message| morphz::llm::model_visible_message_text(message)
                .contains("test.native-count")));
        Ok(Response {
            content: r#"{"count":9007199254740993123456789}"#.into(),
            tool_calls: vec![],
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn registered_non_chat_output_is_the_actual_native_value_not_a_chat_wrapper() {
    use morphz::session_io::{Descriptor, OutputFormat, Registry};
    let temp = tempfile::TempDir::new().unwrap();
    let mut registry = Registry::default();
    registry.register(Descriptor { id:"test.native-count".into(),version:"1".into(),publisher:"test".into(),encodings:vec!["json".into()],required_visible_paths:vec![],resource_paths:vec![],contract:None,schema:Some(json!({"type":"object","required":["count"],"additionalProperties":false,"properties":{"count":{"type":"integer"}}})) }).unwrap();
    let mut config = AppConfig::default();
    config.orchestrator.response_annotations = Protocol::On;
    config.permissions.workspace_root = temp.path().to_string_lossy().into_owned();
    config.background_task.artifact_dir =
        temp.path().join("artifacts").to_string_lossy().into_owned();
    let model = Arc::new(NativeCount(AtomicUsize::new(0)));
    let runtime = MorphzRuntime::builder(config, model.clone())
        .database_path(temp.path().join("runtime.db").to_str().unwrap())
        .session_io_registry(registry)
        .build()
        .await
        .unwrap();
    runtime.start().await.unwrap();
    let session = runtime
        .ensure_session(NewSession {
            id: "native-count".into(),
            agent_id: runtime.identity().agent_id.clone(),
            context_id: runtime.identity().context_id.clone(),
            parent_session_id: None,
            title: "TEST registered native output".into(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    let mut input = Request::parse(r#"{"io_version":"1","client_message_id":"count","message":{"format":{"id":"morphz.chat","version":"1"},"content":{"encoding":"json","value":{"text":"返回准确计数"}}}}"#.as_bytes(),&Limits::default()).unwrap();
    input.delivery.required_formats = vec![OutputFormat {
        id: "test.native-count".into(),
        version: "1".into(),
        encoding: "json".into(),
        schema_hash: None,
        contract_hash: None,
    }];
    input.delivery.accept_formats = Some(input.delivery.required_formats.clone());
    let root = session
        .send_io_as_principal(input, &runtime.identity().principal_id)
        .await
        .unwrap();
    let events = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let events = runtime
                .query_events(QueryFilter {
                    root_turn_id: Some(root.id.clone()),
                    ..Default::default()
                })
                .await
                .unwrap();
            if events
                .iter()
                .any(|event| matches!(event.topic.as_str(), "session/io_state" | "chat/reply"))
            {
                break events;
            }
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(model.0.load(Ordering::SeqCst), 1);
    let output = events
        .iter()
        .find(|event| {
            event.payload.get("io_message").is_some_and(|message| message["format"]["id"] == "test.native-count")
        })
        .unwrap_or_else(|| panic!("registered caller format must be delivered: {:?}", events.iter().map(|event| json!({"topic":event.topic,"terminal":event.payload.get("terminal_kind"),"error":event.payload.get("io_delivery_error"),"format":event.payload.get("io_message").and_then(|message|message.get("format")),"binding":event.payload.get(BUNDLE_PAYLOAD_KEY).and_then(|bundle|bundle.get("return_binding")),"text":event.payload.get("text")})).collect::<Vec<_>>()));
    let message = morphz::session_io::event_message(output).unwrap();
    let morphz::session_io::Content::Json { value } = message.content else {
        panic!("actual JSON output required")
    };
    assert_eq!(
        value.get("count"),
        Some(&morphz::session_io::Data::Number(
            "9007199254740993123456789".into()
        ))
    );
    assert!(!events
        .iter()
        .any(|event| event.topic == "runtime/response_protocol_error"));
}
