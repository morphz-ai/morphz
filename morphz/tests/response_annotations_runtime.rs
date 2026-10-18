//! Production Runtime mechanisms, not a real-provider quality benchmark.
//! All model outputs are scripted through the native bound-with-options entry;
//! tools are synthetic but run as real durable physical Jobs in real SQLite.
use morphz::{
    config::AppConfig,
    event::Event,
    llm::{
        provider_continuation, Client, Message, ModelAttemptBinding, ModelAttemptBindingError,
        ModelRequestContext, ModelRequestOptions, ModelStreamEvent, ModelStreamSender, ModelUsage,
        PromptTokenCount, ProviderContinuation, Response, ToolCallRepr, ToolDefinition,
    },
    memory::{
        sqlite::SqliteStore, ActivationStore, EventStore, ExecutionJobFilter, ExecutionJobStore,
        NewAgent, NewCognitiveContext, NewSession, NewThread, NewThreadActivation, QueryFilter,
        RuntimeStore, SessionMountKind, ThreadActivationMutation, ThreadActivationStatus,
        ThreadKind, ThreadStore, ThreadSupervision,
    },
    response_annotations::{
        normalize_response, records_from_authorized_event, AnnotationKind, ExecutionScope,
        NormalizationContext, PersistedAnnotations, Producer, Protocol, BUNDLE_PAYLOAD_KEY,
        CONTRACT,
    },
    runtime::{MorphzRuntime, RuntimeIdentity, RuntimeToolPolicy, SessionHandle},
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
use tempfile::TempDir;
use tokio::sync::Notify;

type DynError = Box<dyn Error + Send + Sync>;
const FINAL_TEXT: &str = "检查完成，合成系统为 Linux。";
const RAW_WORK: &str = r#"{ "key": "system", "_annotations": {"execution":{"title":"检查合成环境","progress":"读取系统"},"intent":"读取合成系统"} }"#;
const RAW_BUSINESS: &str = r#"{"key":"system","_annotations":{"business":"ordinary payload"}}"#;
const RAW_LIFECYCLE_WORK: &str = r#"{"key":"system","_annotations":{"execution":{"title":"检查后选择生命周期边界","progress":"读取合成系统","result":"LIFECYCLE_CANDIDATE_MUST_NOT_FINALIZE"},"intent":"读取合成系统，不把候选结果当成终态"}}"#;

#[derive(Clone, Copy, Debug)]
enum Scenario {
    Plain,
    OffBusiness,
    WorkReply,
    WorkYield(bool),
    CompletionRejected(bool),
    NoReplySilent(bool),
    NoReplyWait(bool),
    CancelModel(bool),
    ReplyOnly,
    TextReply,
    InvalidObservation,
    Infer,
    InferRoot(u8),
    TextInferRoot(u8),
    Recovery,
    BadMixedReply,
    BadDuplicateReply,
    StrictWorkReply,
    StrictBadFinal(u8),
    ImplicitBadFinal(u8),
}

fn infer_root_case(case: u8) -> (&'static str, &'static str) {
    match case {
        0 | 4 | 5 => (
            r#"(infer (requires (tools)) (returns Bool) "Evaluate a synthetic boolean")"#,
            "false",
        ),
        1 => (
            r#"(infer (requires (tools)) (returns String) "Return synthetic Unicode")"#,
            r#""中文 🧠\n下一行""#,
        ),
        2 => (
            r#"(infer (requires (tools)) (returns Json) "Return ordinary business JSON")"#,
            r#"{"_annotations":{"business":true},"reply":"ordinary data","annotations":7}"#,
        ),
        3 => (
            r#"(infer (requires (tools)) (types (record Decision (ok Bool) (note String))) (returns Decision) "Return strictly typed business JSON")"#,
            r#"{"ok":false,"note":"业务字段"}"#,
        ),
        _ => panic!("unknown infer root case"),
    }
}

#[derive(Clone)]
struct CapturedRequest {
    messages: Vec<Message>,
    tools: Vec<ToolDefinition>,
    binding: ModelAttemptBinding,
    options: ModelRequestOptions,
}

struct ScriptClient {
    scenario: Scenario,
    calls: AtomicUsize,
    captured: Mutex<Vec<CapturedRequest>>,
    receipt_ref: Mutex<Option<String>>,
    rejected_refs: Mutex<Vec<String>>,
    second_request_entered: Notify,
    release_second_response: Notify,
    cancelled_request_drops: AtomicUsize,
}

impl ScriptClient {
    fn new(scenario: Scenario) -> Self {
        Self {
            scenario,
            calls: AtomicUsize::new(0),
            captured: Mutex::new(vec![]),
            receipt_ref: Mutex::new(None),
            rejected_refs: Mutex::new(vec![]),
            second_request_entered: Notify::new(),
            release_second_response: Notify::new(),
            cancelled_request_drops: AtomicUsize::new(0),
        }
    }

    fn continuation() -> ProviderContinuation {
        ProviderContinuation::OpenaiResponses {
            reasoning_items: vec![json!({
                "type":"reasoning", "id":"rs_annotations_fixture",
                "encrypted_content":"SYNTHETIC_NATIVE_SIGNATURE", "summary":[]
            })],
        }
    }

    fn work(arguments: &str) -> Response {
        Response {
            content: String::new(),
            tool_calls: vec![ToolCallRepr {
                id: "synthetic-work-call".into(),
                r#type: "function".into(),
                func_name: "annotation_probe".into(),
                arguments: arguments.into(),
            }],
        }
    }

    fn reply(arguments: Value) -> Response {
        Response {
            content: String::new(),
            tool_calls: vec![ToolCallRepr {
                id: "synthetic-reply-call".into(),
                r#type: "function".into(),
                func_name: "reply".into(),
                arguments: arguments.to_string(),
            }],
        }
    }

    fn text_reply(content: &str, title: &str, result: &str) -> Response {
        Response {
            content: json!({"annotations":{"execution":{"title":title,"result":result}},"content":content}).to_string(),
            tool_calls: vec![],
        }
    }

    fn no_reply(arguments: Value) -> Response {
        Response {
            content: String::new(),
            tool_calls: vec![ToolCallRepr {
                id: "synthetic-no-reply-call".into(),
                r#type: "function".into(),
                func_name: "no_reply".into(),
                arguments: arguments.to_string(),
            }],
        }
    }

    fn assert_lifecycle_receipt(messages: &[Message], tools: &[ToolDefinition], annotated: bool) {
        let call = messages
            .iter()
            .find(|message| {
                message.role == "assistant"
                    && message.tool_calls.as_ref().is_some_and(|calls| {
                        calls.iter().any(|call| call.id == "synthetic-work-call")
                    })
            })
            .expect("the second original request must contain its actual work call");
        assert_eq!(
            call.tool_calls.as_ref().unwrap()[0].function.arguments,
            if annotated {
                RAW_LIFECYCLE_WORK
            } else {
                r#"{"key":"system"}"#
            }
        );
        let receipt = messages
            .iter()
            .find(|message| {
                message.role == "tool"
                    && message.tool_call_id.as_deref() == Some("synthetic-work-call")
            })
            .expect("a real physical ToolOutput must precede the lifecycle decision");
        let receipt: Value = serde_json::from_str(&receipt.content).unwrap();
        assert_eq!(receipt["status"], "success");
        let control = tools.iter().find(|tool| tool.name == "no_reply").unwrap();
        assert_eq!(control.parameters["additionalProperties"], false);
        let properties = control.parameters["properties"].as_object().unwrap();
        assert_eq!(properties.len(), 2);
        assert!(properties.contains_key("mode") && properties.contains_key("wait_secs"));
        assert!(!properties.contains_key("_annotations"));
    }
}

// This guard is owned by the actual pending native provider future. Its Drop
// proves Runtime cancellation reached that future, rather than just changing
// a synthetic terminal row while the model kept running.
struct CancelledRequestDrop<'a>(&'a AtomicUsize);
impl Drop for CancelledRequestDrop<'_> {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[async_trait::async_trait]
impl Client for ScriptClient {
    fn supports_async_cancellation(&self) -> bool {
        true
    }
    fn model(&self) -> Option<String> {
        Some("annotations-fixture".into())
    }

    async fn bind_model_attempt(
        &self,
        request: &ModelRequestContext,
    ) -> Result<ModelAttemptBinding, ModelAttemptBindingError> {
        Ok(ModelAttemptBinding {
            requested_alias: "annotations-fixture".into(),
            route_id: "synthetic-native-route".into(),
            route_revision: "fixture-v1".into(),
            provider_instance_id: "synthetic-provider".into(),
            auth_account_id: "synthetic-account".into(),
            physical_model: "synthetic-model".into(),
            protocol: "openai-responses".into(),
            provider_adapter: "synthetic-native".into(),
            provider_adapter_version: "1".into(),
            endpoint: "http://127.0.0.1:1/v1".into(),
            request_session_id: Some(request.session_id.clone()),
            capabilities: vec![],
            model_input_limits: Default::default(),
        })
    }

    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
    ) -> Result<Response, DynError> {
        panic!("Runtime must use the native bound-with-options entry, never atomic fallback")
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
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        assert!(
            call < if matches!(
                self.scenario,
                Scenario::InferRoot(_) | Scenario::TextInferRoot(_)
            ) {
                1
            } else if matches!(self.scenario, Scenario::Infer) {
                4
            } else if matches!(
                self.scenario,
                Scenario::Recovery | Scenario::BadMixedReply | Scenario::BadDuplicateReply
            ) {
                1
            } else {
                2
            },
            "annotations must not cause an extra model call"
        );
        self.captured.lock().unwrap().push(CapturedRequest {
            messages: messages.clone(),
            tools: tools.clone(),
            binding: binding.clone(),
            options,
        });
        let logical_call = if matches!(self.scenario, Scenario::Recovery) {
            call + 1
        } else {
            call
        };
        if let (Scenario::CancelModel(annotated), 1) = (self.scenario, logical_call) {
            Self::assert_lifecycle_receipt(&messages, &tools, annotated);
            let _guard = CancelledRequestDrop(&self.cancelled_request_drops);
            let _ = stream.send(ModelStreamEvent::Started);
            self.second_request_entered.notify_one();
            // The provider does not author a final response or result. Only
            // the real Runtime operator cancellation can end this request.
            return std::future::pending::<Result<Response, DynError>>().await;
        }
        if matches!(
            self.scenario,
            Scenario::WorkYield(_) | Scenario::NoReplyWait(_)
        ) && logical_call == 1
        {
            self.second_request_entered.notify_one();
            tokio::time::timeout(
                Duration::from_secs(20),
                self.release_second_response.notified(),
            )
            .await?;
        }
        let response = match (self.scenario, logical_call) {
            (Scenario::InferRoot(case) | Scenario::TextInferRoot(case), 0) => {
                let (_, expected) = infer_root_case(case);
                let value = if case == 5 { "\"not-a-boolean\"" } else { expected };
                if tools.iter().any(|tool| tool.name == "reply") {
                    if matches!(self.scenario, Scenario::TextInferRoot(_)) {
                        return self.stream_text_response(if case == 4 {
                            Response { content:value.into(), tool_calls:vec![] }
                        } else {
                            Self::text_reply(value, "核对合成返回值", "合成求值已返回")
                        }, stream).await;
                    }
                    let mut args = json!({"content":value,"annotations":{"execution":{"title":"核对合成返回值","result":"合成求值已返回"}}});
                    if case == 4 { args.as_object_mut().unwrap().remove("annotations"); }
                    Self::reply(args)
                } else {
                    Response {content:value.into(),tool_calls:vec![]}
                }
            }
            (Scenario::NoReplySilent(annotated) | Scenario::NoReplyWait(annotated) | Scenario::CancelModel(annotated), 0) => {
                Self::work(if annotated { RAW_LIFECYCLE_WORK } else { r#"{"key":"system"}"# })
            }
            (Scenario::NoReplySilent(annotated), 1) => {
                Self::assert_lifecycle_receipt(&messages, &tools, annotated);
                Self::no_reply(json!({"mode":"silent"}))
            }
            (Scenario::NoReplyWait(annotated), 1) => {
                Self::assert_lifecycle_receipt(&messages, &tools, annotated);
                Self::no_reply(json!({"mode":"wait","wait_secs":86_400}))
            }
            (Scenario::CompletionRejected(annotated), 0) => {
                // A real unbound Objective control call is rejected by the
                // Runtime's admission policy. Do not replace the builtin with
                // a fake handler or manufacture a successful completion fact.
                let mut arguments = json!({"objective_id":"unbound-synthetic-objective",
                    "status":"completed","summary":"Synthetic closure attempt"});
                if annotated {
                    arguments["_annotations"] = json!({"execution":{"title":"尝试关闭未绑定目标"},
                        "intent":"尝试完成未绑定目标，等待真实准入结果"});
                }
                Response { content:String::new(), tool_calls:vec![ToolCallRepr {
                    id:"synthetic-objective-completion".into(), r#type:"function".into(),
                    func_name:"objective_update".into(), arguments:arguments.to_string(),
                }] }
            }
            (Scenario::CompletionRejected(annotated), 1) => {
                assert!(messages.iter().any(|message| message.content.contains(
                    "The Objective completion request did not enter finalizing")),
                    "a real rejected completion receipt must keep this same Activation in its original work phase");
                assert!(messages.iter().any(|message| message.role == "tool"
                    && message.tool_call_id.as_deref() == Some("synthetic-objective-completion")),
                    "the next ordinary model request must contain its actual control receipt");
                if annotated {
                    Self::reply(json!({"content":"目标未绑定，因此未执行关闭。",
                        "annotations":{"execution":{"title":"核对目标关闭条件","result":"未绑定目标，关闭请求被拒绝"}}}))
                } else {
                    Response {content:"目标未绑定，因此未执行关闭。".into(),tool_calls:vec![]}
                }
            }
            (Scenario::BadMixedReply,0) => {
                let mut response=Self::reply(json!({"content":FINAL_TEXT,"annotations":{"execution":{"result":"MIXED_RESULT_MUST_NOT_APPLY"}}}));
                response.tool_calls.extend(Self::work(RAW_WORK).tool_calls);
                response
            }
            (Scenario::BadDuplicateReply,0) => Response {
                content:String::new(),tool_calls:vec![ToolCallRepr {
                    id:"synthetic-bad-reply".into(),r#type:"function".into(),func_name:"reply".into(),
                    arguments:r#"{"content":"检查完成，合成系统为 Linux。","annotations":{"execution":{"result":"DUPLICATE_RESULT_MUST_NOT_APPLY"}},"content":"duplicate"}"#.into(),
                }],
            },
            (Scenario::Infer, 0) => {
                assert!(tools.iter().any(|t| t.name == "reply"));
                Response {content:String::new(),tool_calls:vec![ToolCallRepr {
                    id:"synthetic-eval-call".into(),r#type:"function".into(),func_name:"eval".into(),
                    arguments:json!({"program":r#"(eval (requires (tools annotation_probe)) (infer (seq (bind source (call annotation_probe (key "system"))) (decode String source))))"#}).to_string(),
                }]}
            }
            (Scenario::Infer, 1) => Self::work(r#"{"key":"system","_annotations":{"execution":{"title":"读取合成系统","progress":"读取系统资料"},"intent":"核对系统名称"}}"#),
            (Scenario::Infer, 2) => Self::reply(json!({
                "content":"\"Linux\"",
                "annotations":{"execution":{"title":"读取合成系统","result":"系统名称为 Linux"}}
            })),
            (Scenario::Infer, 3) => {
                let mut args = json!({"content":FINAL_TEXT,"annotations":{"execution":{"result":"合成检查已完成"}}});
                if tools.iter().any(|tool| tool.name == "reply" && tool.parameters["required"].as_array().is_some_and(|required| required.iter().any(|field| field == "annotations"))) {
                    args["annotations"]["execution"]["title"] = json!("检查合成环境");
                }
                Self::reply(args)
            }
            (Scenario::StrictBadFinal(case) | Scenario::ImplicitBadFinal(case), 0) => {
                let mut args = json!({"content":FINAL_TEXT,"annotations":{"execution":{"title":"检查合成环境","result":"检查完成"}}});
                match case {
                    0 => { args.as_object_mut().unwrap().remove("annotations"); }
                    1 => args["annotations"] = Value::Null,
                    2 => args["annotations"]["execution"] = Value::Null,
                    3 => { args["annotations"]["execution"].as_object_mut().unwrap().remove("title"); }
                    4 => args["annotations"]["execution"]["title"] = json!(" \t"),
                    5 => args["annotations"]["execution"]["result"] = Value::Null,
                    6 => args["annotations"]["execution"]["result"] = json!("长".repeat(513)),
                    _ => panic!("unknown strict fixture case"),
                }
                if matches!(self.scenario, Scenario::ImplicitBadFinal(_)) {
                    return self.stream_text_response(Response {content:args.to_string(),tool_calls:vec![]},stream).await;
                }
                Self::reply(args)
            }
            (Scenario::Plain, 0) => Response {
                content: FINAL_TEXT.into(),
                tool_calls: vec![],
            },
            (Scenario::OffBusiness, 0) => Self::work(RAW_BUSINESS),
            (Scenario::OffBusiness, 1) => Response {
                content: FINAL_TEXT.into(),
                tool_calls: vec![],
            },
            (Scenario::WorkYield(false), 0) => Self::work(r#"{"key":"system"}"#),
            (Scenario::WorkYield(false), 1) => {
                assert!(!tools.iter().any(|tool| tool.name == "reply"));
                Self::assert_lifecycle_receipt(&messages, &tools, false);
                Response {content:FINAL_TEXT.into(),tool_calls:vec![]}
            }
            (Scenario::WorkReply | Scenario::StrictWorkReply | Scenario::WorkYield(true) | Scenario::InvalidObservation, 0) => Self::work(RAW_WORK),
            (Scenario::ReplyOnly, 0) => Self::reply(
                json!({"content":FINAL_TEXT,"annotations":{"execution":{"title":"检查合成环境","result":"合成检查已完成"}}}),
            ),
            (Scenario::TextReply, 0) => Self::text_reply(FINAL_TEXT, "检查合成环境", "合成检查已完成"),
            (Scenario::WorkReply | Scenario::StrictWorkReply | Scenario::WorkYield(true) | Scenario::InvalidObservation | Scenario::Recovery, 1) => {
                assert!(tools.iter().any(|t| t.name == "reply"));
                let marker = messages
                    .iter()
                    .position(|m| provider_continuation(m).is_some())
                    .expect("native signed continuation missing");
                assert_eq!(
                    provider_continuation(&messages[marker]),
                    Some(Self::continuation())
                );
                let raw = messages
                    .iter()
                    .position(|m| {
                        m.role == "assistant"
                            && m.tool_calls
                                .as_ref()
                                .is_some_and(|c| c.iter().any(|c| c.id == "synthetic-work-call"))
                    })
                    .unwrap();
                assert!(
                    marker < raw,
                    "signed state must precede its exact raw carrier call"
                );
                assert_eq!(
                    messages[raw].tool_calls.as_ref().unwrap()[0]
                        .function
                        .arguments,
                    RAW_WORK
                );
                let receipt = messages
                    .iter()
                    .find(|m| {
                        m.role == "tool" && m.tool_call_id.as_deref() == Some("synthetic-work-call")
                    })
                    .expect("actual tool receipt missing");
                let receipt: Value = serde_json::from_str(&receipt.content).unwrap();
                assert_eq!(receipt["status"], "success");
                let reference = receipt["observation_ref"].as_str().unwrap().to_owned();
                assert!(reference.starts_with("@e"));
                *self.receipt_ref.lock().unwrap() = Some(reference.clone());
                let mut observations = vec![json!({"ref":reference,"result":"合成系统为 Linux"})];
                if matches!(self.scenario, Scenario::InvalidObservation) {
                    observations.push(json!({"ref":"@e999999999999","result":"UNTRUSTED_RESULT_MUST_NOT_PROJECT"}));
                    for reference in self.rejected_refs.lock().unwrap().iter() {
                        observations.push(
                            json!({"ref":reference,"result":"FOREIGN_RESULT_MUST_NOT_PROJECT"}),
                        );
                    }
                }
                let mut args = json!({"content":FINAL_TEXT,"annotations":{
                    "execution":{"title":"检查合成环境","result":if matches!(self.scenario, Scenario::WorkYield(_)) {
                        "已确认合成系统为 Linux；后续任务保持排队" } else { "已确认合成系统为 Linux" }},"observations":observations,
                }});
                if matches!(self.scenario, Scenario::StrictWorkReply) {
                    args["annotations"]["execution"]["title"] = json!("检查合成环境");
                }
                Self::reply(args)
            }
            _ => panic!("unexpected scripted completion"),
        };
        let _ = stream.send(ModelStreamEvent::Started);
        if !response.content.is_empty() {
            for character in response.content.chars() {
                let _ = stream.send(ModelStreamEvent::TextDelta {
                    text: character.to_string(),
                });
                tokio::task::yield_now().await;
            }
        }
        for (index, tool) in response.tool_calls.iter().enumerate() {
            let _ = stream.send(ModelStreamEvent::ToolCallStarted {
                index,
                id: tool.id.clone(),
                name: tool.func_name.clone(),
            });
            let characters: Vec<char> = tool.arguments.chars().collect();
            for chunk in characters.chunks(5) {
                let _ = stream.send(ModelStreamEvent::ToolArgumentsDelta {
                    index,
                    delta: chunk.iter().collect(),
                });
                tokio::task::yield_now().await;
            }
            let _ = stream.send(ModelStreamEvent::ToolCallCompleted { index });
        }
        if call == 0
            && matches!(
                self.scenario,
                Scenario::WorkReply
                    | Scenario::StrictWorkReply
                    | Scenario::WorkYield(_)
                    | Scenario::InvalidObservation
                    | Scenario::NoReplySilent(_)
                    | Scenario::NoReplyWait(_)
                    | Scenario::CancelModel(_)
            )
        {
            let _ = stream.send(ModelStreamEvent::ProviderContinuation {
                continuation: Self::continuation(),
            });
        }
        let _ = stream.send(ModelStreamEvent::Usage {
            usage: ModelUsage {
                input_tokens: Some(123),
                output_tokens: Some(31),
                ..Default::default()
            },
        });
        let _ = stream.send(ModelStreamEvent::Completed);
        Ok(response)
    }
}

impl ScriptClient {
    async fn stream_text_response(
        &self,
        response: Response,
        stream: ModelStreamSender,
    ) -> Result<Response, DynError> {
        let _ = stream.send(ModelStreamEvent::Started);
        for character in response.content.chars() {
            let _ = stream.send(ModelStreamEvent::TextDelta {
                text: character.to_string(),
            });
            tokio::task::yield_now().await;
        }
        let _ = stream.send(ModelStreamEvent::Completed);
        Ok(response)
    }
}

struct ProbeTool {
    arguments: Arc<Mutex<Vec<Value>>>,
    business_reserved: bool,
}
#[async_trait::async_trait]
impl Tool for ProbeTool {
    fn name(&self) -> &str {
        "annotation_probe"
    }
    fn definition(&self) -> ToolDefinition {
        let mut properties = json!({"key":{"type":"string"}});
        if self.business_reserved {
            properties["_annotations"] = json!({"type":"object"});
        }
        ToolDefinition {
            name: self.name().into(),
            description: "Read a synthetic system fact; no external effects.".into(),
            parameters: json!({"type":"object","properties":properties,"required":["key"],"additionalProperties":false}),
        }
    }
    async fn execute(&self, arguments: &str) -> Result<String, DynError> {
        self.arguments
            .lock()
            .unwrap()
            .push(serde_json::from_str(arguments)?);
        Ok("Linux".into())
    }
}

struct Fixture {
    temp: TempDir,
    store: Arc<SqliteStore>,
    runtime: MorphzRuntime,
    session: SessionHandle,
    client: Arc<ScriptClient>,
    arguments: Arc<Mutex<Vec<Value>>>,
}

impl Fixture {
    async fn new(scenario: Scenario, default_protocol: Protocol) -> Self {
        Self::construct(scenario, default_protocol, true).await
    }

    async fn construct(scenario: Scenario, default_protocol: Protocol, start: bool) -> Self {
        let _ = tracing_subscriber::fmt()
            .with_env_filter("morphz=warn")
            .with_test_writer()
            .try_init();
        let temp = TempDir::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(temp.path().join("annotations.db").to_str().unwrap())
                .await
                .unwrap(),
        );
        let client = Arc::new(ScriptClient::new(scenario));
        let arguments = Arc::new(Mutex::new(vec![]));
        let mut config = AppConfig::default();
        config.llm.model = "annotations-fixture".into();
        config.permissions.workspace_root = temp.path().to_string_lossy().into_owned();
        config.background_task.artifact_dir =
            temp.path().join("artifacts").to_string_lossy().into_owned();
        config.orchestrator.response_annotations = default_protocol;
        if matches!(scenario, Scenario::Infer) {
            config.orchestrator.eval_callable_tools = vec!["annotation_probe".into()];
        }
        let mut builder = MorphzRuntime::builder(config, client.clone() as Arc<dyn Client>)
            .identity(RuntimeIdentity {
                agent_id: "annotations-agent".into(),
                context_id: "annotations-context".into(),
                principal_id: "principal-default".into(),
            })
            .store(
                "sqlite:annotations-fixture",
                store.clone() as Arc<dyn RuntimeStore>,
            )
            .tool_policy(RuntimeToolPolicy {
                context_only: false,
                coding_eval: false,
            })
            .extra_tool(Arc::new(ProbeTool {
                arguments: arguments.clone(),
                business_reserved: matches!(scenario, Scenario::OffBusiness),
            }));
        if let Scenario::InferRoot(case) | Scenario::TextInferRoot(case) = scenario {
            let (entry, _) = infer_root_case(case);
            let entry = if case == 1 {
                entry.to_string()
            } else {
                let declarations = if case == 3 {
                    "(types (record Decision (ok Bool) (note String)))"
                } else {
                    ""
                };
                let body = entry
                    .replace("(requires (tools))", "")
                    .replace(declarations, "");
                format!("(eval (requires (tools)) {declarations} (seq (bind value {body}) \"合成校验完成\"))")
            };
            builder = builder.harness_package(
                morphz::harness_package::HarnessPackage::from_source(
                    "TEST-infer-annotations.hns",
                    &format!(
                        r#"
                (manifest (id "TEST-infer-annotations") (version "1.0.0")
                  (title "TEST infer metadata") (capabilities (tools)))
                (contract (identity "Synthetic inference metadata test"))
                {entry}
                "#
                    ),
                )
                .unwrap(),
            );
        }
        let runtime = builder.build().await.unwrap();
        if start {
            runtime.start().await.unwrap();
        } else {
            runtime
                .ensure_agent(NewAgent {
                    id: "annotations-agent".into(),
                    title: "Annotations fixture".into(),
                    root_context_id: "annotations-context".into(),
                })
                .await
                .unwrap();
            runtime
                .ensure_context(NewCognitiveContext {
                    id: "annotations-context".into(),
                    agent_id: "annotations-agent".into(),
                    title: "Annotations context".into(),
                })
                .await
                .unwrap();
        }
        let session = runtime
            .ensure_session(NewSession {
                id: "annotations-session".into(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Response annotations".into(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        Self {
            temp,
            store,
            runtime,
            session,
            client,
            arguments,
        }
    }

    fn input(protocol: Option<Protocol>) -> Request {
        let mut input=Request::parse(json!({"io_version":"1","client_message_id":"annotations-input","message":{"format":{"id":"morphz.chat","version":"1"},"content":{"encoding":"json","value":{"text":"Read synthetic system"}}}}).to_string().as_bytes(),&Limits::default()).unwrap();
        input.activation.response_annotations = protocol;
        input
    }

    async fn submit(&self, protocol: Option<Protocol>) -> (Event, Event) {
        let mut input = Self::input(protocol);
        if matches!(
            self.client.scenario,
            Scenario::InferRoot(_) | Scenario::TextInferRoot(_)
        ) {
            input.activation.harness = Some(morphz::harness::ExactHarnessRef {
                id: "TEST-infer-annotations".into(),
                version: "1.0.0".into(),
            });
        }
        let accepted = self
            .session
            .send_io_as_principal(input, &self.runtime.identity().principal_id)
            .await
            .unwrap();
        let reply = tokio::time::timeout(Duration::from_secs(25), async {
            loop {
                let events = self.events(&accepted.id, None).await;
                if let Some(reply) = events.iter().find(|e| {
                    e.topic == "chat/reply"
                        || e.topic == "session/io_state"
                            && e.payload.get("terminal_kind").and_then(Value::as_str)
                                == Some("failed")
                }) {
                    return reply.clone();
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        let reply = match reply {
            Ok(reply) => reply,
            Err(error) => {
                let topics = self
                    .events(&accepted.id, None)
                    .await
                    .into_iter()
                    .map(|event| event.topic)
                    .collect::<Vec<_>>();
                panic!(
                    "scripted Runtime did not deliver for {:?}: {error}; topics: {topics:?}",
                    self.client.scenario
                );
            }
        };
        (accepted, reply)
    }

    async fn events(&self, root: &str, topic: Option<&str>) -> Vec<Event> {
        self.runtime
            .query_events(QueryFilter {
                root_turn_id: Some(root.into()),
                topic: topic.map(str::to_owned),
                ..Default::default()
            })
            .await
            .unwrap()
    }

    async fn jobs(&self) -> Vec<morphz::memory::ExecutionJobRecord> {
        self.store
            .list_execution_jobs(ExecutionJobFilter {
                session_id: Some("annotations-session".into()),
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn default_and_explicit_off_preserve_complete_system_and_tool_schema_bytes() {
    let default = Fixture::new(Scenario::Plain, Protocol::Off).await;
    let (root, reply) = default.submit(None).await;
    assert_eq!(reply.payload["text"], FINAL_TEXT);
    let explicit = Fixture::new(Scenario::Plain, Protocol::On).await;
    let (other_root, _) = explicit.submit(Some(Protocol::Off)).await;
    let a = default.client.captured.lock().unwrap()[0].clone();
    let b = explicit.client.captured.lock().unwrap()[0].clone();
    let systems = |r: &CapturedRequest| {
        r.messages
            .iter()
            .filter(|m| m.role == "system")
            .map(|m| m.content.as_bytes().to_vec())
            .collect::<Vec<_>>()
    };
    assert!(!systems(&a).is_empty());
    assert_eq!(
        systems(&a),
        systems(&b),
        "Off must not change any system byte"
    );
    assert_eq!(
        serde_json::to_vec(&a.tools).unwrap(),
        serde_json::to_vec(&b.tools).unwrap(),
        "Off must not change any schema byte"
    );
    assert!(!a.tools.iter().any(|t| t.name == "reply"));
    assert!(!systems(&a)
        .iter()
        .any(|s| String::from_utf8_lossy(s).contains(CONTRACT)));
    assert_eq!(a.binding.protocol, "openai-responses");
    assert_eq!(a.options, b.options);
    for (fixture, root) in [(&default, root), (&explicit, other_root)] {
        let thread = fixture
            .runtime
            .session_thread_by_root("annotations-session", &root.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(thread.response_annotations, Protocol::Off);
        assert!(fixture
            .runtime
            .session_thread_annotations("annotations-context", "annotations-session", &thread.id)
            .await
            .unwrap()
            .unwrap()
            .is_none());
        let detail = fixture
            .runtime
            .thread_detail("annotations-context", &thread.id)
            .await
            .unwrap()
            .unwrap();
        assert!(serde_json::to_value(&detail.snapshot)
            .unwrap()
            .get("response_annotations")
            .is_none());
        for event in fixture.events(&root.id, Some("chat/assistant_call")).await {
            assert!(event.payload.get(BUNDLE_PAYLOAD_KEY).is_none());
            assert!(event.payload.get("response_annotations").is_none());
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn off_keeps_reserved_looking_business_arguments_untouched() {
    let fixture = Fixture::new(Scenario::OffBusiness, Protocol::Off).await;
    let (root, _) = fixture.submit(None).await;
    assert_eq!(fixture.client.calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        fixture.arguments.lock().unwrap().as_slice(),
        &[serde_json::from_str::<Value>(RAW_BUSINESS).unwrap()]
    );
    assert_eq!(fixture.jobs().await.len(), 1);
    assert!(fixture
        .events(&root.id, Some("chat/assistant_call"))
        .await
        .iter()
        .all(|e| e.payload.get(BUNDLE_PAYLOAD_KEY).is_none()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn enabled_uses_exact_raw_native_replay_but_stripped_execution_and_durable_annotations() {
    let fixture = Fixture::new(Scenario::WorkReply, Protocol::Off).await;
    let mut stream = fixture.runtime.subscribe("runtime/model_stream", 512);
    let (accepted, reply) = fixture.submit(Some(Protocol::On)).await;
    assert_eq!(reply.payload["text"], FINAL_TEXT);
    assert_eq!(fixture.client.calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        fixture.arguments.lock().unwrap().as_slice(),
        &[json!({"key":"system"})]
    );
    let jobs = fixture.jobs().await;
    assert_eq!(
        jobs.len(),
        1,
        "reply must not dispatch another physical Job"
    );
    assert_eq!(jobs[0].tool_name, "annotation_probe");
    let thread = fixture
        .runtime
        .session_thread_by_root("annotations-session", &accepted.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(thread.response_annotations, Protocol::On);
    let sdk = morphz::sdk::MorphzSdk::new(fixture.runtime.clone());
    let projected = sdk
        .session_thread_annotations("principal-default", "annotations-session", &thread.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(projected.title.as_deref(), Some("检查合成环境"));
    assert!(
        projected.progress.is_none(),
        "terminal facts hide stage text"
    );
    assert_eq!(projected.result.as_deref(), Some("已确认合成系统为 Linux"));
    assert_eq!(projected.steps.len(), 1);
    assert_eq!(projected.steps[0].job_id, jobs[0].id);
    assert_eq!(projected.steps[0].intent.as_deref(), Some("读取合成系统"));
    assert_eq!(
        projected.steps[0].result.as_deref(),
        Some("合成系统为 Linux")
    );
    assert_eq!(projected.source_count, 2);
    assert!(!projected.truncated);
    let public_projection = serde_json::to_value(&projected).unwrap();
    assert!(
        public_projection.get("raw_response").is_none()
            && public_projection.get("records").is_none()
    );
    let board = fixture
        .runtime
        .scheduler_snapshot(
            "annotations-context",
            morphz::runtime::SchedulerQuery {
                include_terminal: true,
                limit: 200,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        board
            .threads
            .iter()
            .find(|snapshot| snapshot.thread.id == thread.id)
            .unwrap()
            .response_annotations
            .as_ref(),
        Some(&projected)
    );
    let forbidden = sdk
        .session_thread_annotations("foreign-principal", "annotations-session", &thread.id)
        .await
        .unwrap_err();
    assert_eq!(forbidden.code, morphz::sdk::SdkErrorCode::Forbidden);
    assert!(fixture
        .runtime
        .session_thread_annotations("annotations-context", "foreign-session", &thread.id)
        .await
        .unwrap()
        .is_none());
    assert!(fixture
        .runtime
        .session_thread_annotations("foreign-context", "annotations-session", &thread.id)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        fixture.client.calls.load(Ordering::SeqCst),
        2,
        "projection never asks a model"
    );
    let scope = ExecutionScope {
        execution_id: thread.id.clone(),
        generation: thread.generation,
    };
    let calls = fixture
        .events(&accepted.id, Some("chat/assistant_call"))
        .await;
    assert_eq!(calls.len(), 2);
    let work = calls
        .iter()
        .find(|e| {
            e.payload
                .get("continuation_tool_calls")
                .and_then(Value::as_array)
                .is_some_and(|c| {
                    c.iter()
                        .any(|c| c.get("id").and_then(Value::as_str) == Some("synthetic-work-call"))
                })
        })
        .expect("raw continuation calls not persisted");
    let bundle: PersistedAnnotations =
        serde_json::from_value(work.payload[BUNDLE_PAYLOAD_KEY].clone()).unwrap();
    assert_eq!(bundle.raw_response.tool_calls[0].arguments, RAW_WORK);
    assert_eq!(work.payload["response_annotations"], "on");
    let business = work.payload["tool_calls"][0]["function"]["arguments"]
        .as_str()
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(business).unwrap(),
        json!({"key":"system"})
    );
    assert_eq!(
        work.payload["continuation_tool_calls"][0]["function"]["arguments"],
        RAW_WORK
    );
    assert_eq!(bundle.scope, scope);
    assert!(bundle.records.iter().all(|r| r.source.sequence.is_none()));
    let mut records = vec![];
    for event in &calls {
        records.extend(records_from_authorized_event(event, &scope).unwrap());
    }
    assert!(records
        .iter()
        .any(|r| r.kind == AnnotationKind::Title && r.value == "检查合成环境"));
    assert!(records
        .iter()
        .any(|r| r.kind == AnnotationKind::Intent && r.value == "读取合成系统"));
    assert!(
        records
            .iter()
            .any(|r| r.kind == AnnotationKind::ObservationResult
                && r.observation_ref == *fixture.client.receipt_ref.lock().unwrap()
                && r.observation_event_id.is_some()),
        "calls={calls:#?}, outputs={:#?}",
        fixture.events(&accepted.id, Some("chat/tool_output")).await
    );
    assert!(records.iter().any(|r| r.kind == AnnotationKind::Result));
    assert!(records.iter().all(|r| r.source.sequence.is_some()));
    let wrong = ExecutionScope {
        generation: scope.generation + 1,
        ..scope.clone()
    };
    assert!(
        records_from_authorized_event(work, &wrong).is_err(),
        "stale generation must fail closed"
    );

    let mut public = String::new();
    let mut increments = 0;
    while let Ok(event) = stream.try_recv() {
        let raw = event.payload["stream"].to_string();
        assert!(!raw.contains("SYNTHETIC_NATIVE_SIGNATURE"));
        assert!(!raw.contains("_annotations"));
        assert!(!raw.contains("execution"));
        if event.payload["stream"]["kind"] == "text_delta" {
            increments += 1;
            public.push_str(event.payload["stream"]["text"].as_str().unwrap());
        }
    }
    assert!(
        increments > 1,
        "reply content must be streamed incrementally"
    );
    assert_eq!(public, FINAL_TEXT);

    // Reopen the actual SQL file, not a serialized in-memory fake. This verifies
    // storage persistence only; it is not claimed as crash/restart recovery.
    let reopened = SqliteStore::new(fixture.temp.path().join("annotations.db").to_str().unwrap())
        .await
        .unwrap();
    let persisted = reopened
        .query(QueryFilter {
            root_turn_id: Some(accepted.id.clone()),
            topic: Some("chat/assistant_call".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(persisted, calls);
    let duplicate = fixture
        .session
        .send_io_as_principal(
            Fixture::input(Some(Protocol::On)),
            &fixture.runtime.identity().principal_id,
        )
        .await
        .unwrap();
    assert_eq!(duplicate.id, accepted.id);
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert_eq!(fixture.client.calls.load(Ordering::SeqCst), 2);
    assert_eq!(fixture.arguments.lock().unwrap().len(), 1);
    assert_eq!(
        fixture
            .events(&accepted.id, Some("chat/assistant_call"))
            .await,
        calls
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reply_is_terminal_response_not_a_work_job() {
    let fixture = Fixture::new(Scenario::ReplyOnly, Protocol::Off).await;
    let (root, reply) = fixture.submit(Some(Protocol::On)).await;
    assert_eq!(reply.payload["text"], FINAL_TEXT);
    assert_eq!(fixture.client.calls.load(Ordering::SeqCst), 1);
    assert!(fixture.jobs().await.is_empty());
    assert!(fixture.arguments.lock().unwrap().is_empty());
    let calls = fixture.events(&root.id, Some("chat/assistant_call")).await;
    assert_eq!(calls.len(), 1);
    assert!(calls[0].payload["tool_calls"]
        .as_array()
        .unwrap()
        .is_empty());
    let bundle: PersistedAnnotations =
        serde_json::from_value(calls[0].payload[BUNDLE_PAYLOAD_KEY].clone()).unwrap();
    assert_eq!(bundle.raw_response.tool_calls[0].func_name, "reply");
    assert!(bundle
        .records
        .iter()
        .any(|r| r.kind == AnnotationKind::Result));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unknown_observation_ref_is_rejected_without_repair_or_extra_execution() {
    let fixture = Fixture::new(Scenario::InvalidObservation, Protocol::Off).await;
    for (id, session_id) in [
        ("other-root-output", "annotations-session"),
        ("foreign-session-output", "foreign-session"),
    ] {
        // These refs genuinely exist in the SQL Event Store, unlike the
        // nonexistent ref above, but do not belong to this Execution.
        fixture.store.append(Event::new(id.into(),"System-Executor".into(),"tool_output".into(),"chat/tool_output".into(),json!({
            "context_id":"annotations-context","session_id":session_id,
            "root_turn_id":"other-root","thread_id":"other-thread","thread_generation":1,
            "tool_name":"annotation_probe","tool_call_id":"foreign-probe","text":"Foreign synthetic fact",
        }).as_object().unwrap().clone())).await.unwrap();
        let event = fixture
            .store
            .query(QueryFilter {
                event_id: Some(id.into()),
                ..Default::default()
            })
            .await
            .unwrap()
            .remove(0);
        fixture
            .client
            .rejected_refs
            .lock()
            .unwrap()
            .push(format!("@e{}", event.sequence.unwrap()));
    }
    let (root, reply) = fixture.submit(Some(Protocol::On)).await;
    assert_eq!(reply.payload["text"], FINAL_TEXT);
    assert_eq!(fixture.client.calls.load(Ordering::SeqCst), 2);
    assert_eq!(fixture.arguments.lock().unwrap().len(), 1);
    let calls = fixture.events(&root.id, Some("chat/assistant_call")).await;
    let bundles: Vec<PersistedAnnotations> = calls
        .iter()
        .map(|e| serde_json::from_value(e.payload[BUNDLE_PAYLOAD_KEY].clone()).unwrap())
        .collect();
    assert!(bundles.iter().any(|b| !b.diagnostics.is_empty()));
    assert!(bundles
        .iter()
        .flat_map(|b| &b.records)
        .all(|r| r.value != "UNTRUSTED_RESULT_MUST_NOT_PROJECT"));
    assert!(bundles
        .iter()
        .flat_map(|b| &b.records)
        .all(|r| r.value != "FOREIGN_RESULT_MUST_NOT_PROJECT"));
    assert!(bundles
        .iter()
        .flat_map(|b| &b.records)
        .any(|r| r.kind == AnnotationKind::ObservationResult));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn single_infer_harness_keeps_required_annotations_typed_values_and_streaming_in_one_request()
{
    let mut stable_tools = None;
    let mut baseline_values = std::collections::HashMap::new();
    for protocol in [Protocol::Off, Protocol::On] {
        for text_carrier in [false, true] {
            for case in 0..=3 {
                let fixture = Fixture::new(
                    if text_carrier {
                        Scenario::TextInferRoot(case)
                    } else {
                        Scenario::InferRoot(case)
                    },
                    Protocol::Off,
                )
                .await;
                let mut stream = fixture.runtime.subscribe("runtime/model_stream", 512);
                let (_, reply) = fixture.submit(Some(protocol)).await;
                let (_, body) = infer_root_case(case);
                assert_eq!(
                    reply.payload["text"],
                    if case == 1 {
                        serde_json::from_str::<String>(body).unwrap()
                    } else {
                        "合成校验完成".into()
                    },
                    "one infer returns directly without a second model response"
                );
                let values = fixture
                    .store
                    .query(QueryFilter {
                        context_id: Some("annotations-context".into()),
                        topics: vec!["runtime/inference_value".into()],
                        latest_k: Some(4),
                        ..Default::default()
                    })
                    .await
                    .unwrap();
                assert_eq!(values.len(), 1);
                let actual_value =
                    serde_json::from_str::<Value>(values[0].payload["text"].as_str().unwrap())
                        .unwrap();
                let fields = serde_json::from_str::<Value>(body).unwrap();
                let expected_value = if case == 3 {
                    json!({"$yao":{"kind":"record","type":"Decision","fields":fields}})
                } else {
                    fields
                };
                assert_eq!(
                    actual_value, expected_value,
                    "annotations never enter the typed business value"
                );
                if protocol.is_off() {
                    baseline_values.insert(case, actual_value);
                } else {
                    assert_eq!(
                        baseline_values.get(&case),
                        Some(&actual_value),
                        "annotation choice cannot change the existing typed representation"
                    );
                }
                assert_eq!(
                    fixture.client.calls.load(Ordering::SeqCst),
                    1,
                    "one infer, no model relay or metadata-only inference"
                );
                let requests = fixture
                    .store
                    .query(QueryFilter {
                        context_id: Some("annotations-context".into()),
                        topics: vec!["chat/infer_request".into()],
                        latest_k: Some(4),
                        ..Default::default()
                    })
                    .await
                    .unwrap();
                assert_eq!(requests.len(), 1);
                let child = fixture
                    .runtime
                    .session_thread_by_root("annotations-session", &requests[0].id)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(child.response_annotations, protocol);
                let annotations = fixture
                    .runtime
                    .session_thread_annotations(
                        "annotations-context",
                        "annotations-session",
                        &child.id,
                    )
                    .await
                    .unwrap()
                    .unwrap();
                let captured = fixture.client.captured.lock().unwrap();
                assert_eq!(captured.len(), 1);
                if protocol.is_off() {
                    assert!(annotations.is_none());
                    assert!(
                        captured[0].tools.is_empty(),
                        "disabled infer tools remain byte-identical and no reply carrier is added"
                    );
                    assert!(captured[0]
                        .messages
                        .iter()
                        .all(|m| !m.content.contains(CONTRACT)));
                } else {
                    let annotations = annotations.unwrap();
                    assert_eq!(annotations.title.as_deref(), Some("核对合成返回值"));
                    assert_eq!(annotations.result.as_deref(), Some("合成求值已返回"));
                    assert_eq!(captured[0].tools.len(), 1);
                    assert_eq!(captured[0].tools[0].name, "reply");
                    if protocol == Protocol::On {
                        let encoded = serde_json::to_vec(&captured[0].tools).unwrap();
                        assert_eq!(
                            *stable_tools.get_or_insert(encoded.clone()),
                            encoded,
                            "return types do not change tool schemas or order"
                        );
                    }
                }
                drop(captured);
                let mut text = String::new();
                let mut increments = 0;
                while let Ok(event) = stream.try_recv() {
                    if let Ok(ModelStreamEvent::TextDelta { text: delta }) =
                        serde_json::from_value(event.payload["stream"].clone())
                    {
                        text.push_str(&delta);
                        increments += 1;
                    }
                }
                assert_eq!(
                    text, body,
                    "stream contains only the original value transport, not response metadata"
                );
                assert!(increments > 0, "typed values remain visible");
                if body.chars().count() > 5 {
                    assert!(
                        increments > 1,
                        "typed values are still incrementally visible"
                    );
                }
                assert!(fixture.arguments.lock().unwrap().is_empty());
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn invalid_infer_business_value_still_fails_without_repair_or_a_model_relay() {
    for scenario in [
        Scenario::InferRoot(4),
        Scenario::TextInferRoot(4),
        Scenario::InferRoot(5),
        Scenario::TextInferRoot(5),
    ] {
        let fixture = Fixture::new(scenario, Protocol::Off).await;
        let mut input = Fixture::input(Some(Protocol::On));
        input.activation.harness = Some(morphz::harness::ExactHarnessRef {
            id: "TEST-infer-annotations".into(),
            version: "1.0.0".into(),
        });
        let root = fixture
            .session
            .send_io_as_principal(input, &fixture.runtime.identity().principal_id)
            .await
            .unwrap();
        let thread = tokio::time::timeout(Duration::from_secs(25), async {
            loop {
                if let Some(thread) = fixture
                    .runtime
                    .session_thread_by_root("annotations-session", &root.id)
                    .await
                    .unwrap()
                {
                    if thread.lifecycle.is_terminal() {
                        break thread;
                    }
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("bad infer must reach an explicit failure boundary");
        assert_eq!(thread.lifecycle, morphz::memory::ThreadLifecycle::Failed);
        assert_eq!(fixture.client.calls.load(Ordering::SeqCst), 1);
        assert!(fixture.arguments.lock().unwrap().is_empty());
        assert!(
            fixture
                .jobs()
                .await
                .iter()
                .all(|job| job.tool_name == "eval"),
            "reply is not a physical Job"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn restart_replays_seeded_enabled_plan_once_without_reasking_or_rewriting_annotations() {
    assert_restart_replays_seeded_enabled_plan_once(None).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn restart_replays_imported_enabled_plan_using_actual_nonstable_thread_identity() {
    assert_restart_replays_seeded_enabled_plan_once(Some("imported-annotations-thread")).await;
}

async fn assert_restart_replays_seeded_enabled_plan_once(legacy_thread_id: Option<&str>) {
    use morphz::memory::{
        stable_thread_id, stable_thread_signal_id, CustomStore, DeliveryIngressStore, MessageClaim,
        MessageDispatchMode, NewThreadSignal, ThreadSignalStatus,
        DEFAULT_THREAD_SIGNAL_BATCH_LIMIT,
    };
    use sha2::{Digest, Sha256};

    let mut fixture = Fixture::construct(Scenario::Recovery, Protocol::Off, false).await;
    let root = Event::new(
        if legacy_thread_id.is_some() {
            "annotations-restart-imported-root"
        } else {
            "annotations-restart-root"
        }
        .into(),
        "Test-User".into(),
        "user_message".into(),
        "chat/user_message".into(),
        json!({
            "agent_id":"annotations-agent",
            "context_id":"annotations-context","session_id":"annotations-session",
            "text":"Read synthetic system","response_annotations":"on",
            "principal_id":"principal-default",
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    let root = if let Some(legacy_id) = legacy_thread_id {
        // Imported facts predate the atomic current ingress path. Preserve
        // their physical Thread identity with the public Store operations,
        // then create the real Signal ownership graph below. Calling current
        // claim_message here would instead try to INSERT a stable-ID Thread
        // for the same UNIQUE root, so it is not a legacy import operation.
        fixture.store.append(root.clone()).await.unwrap();
        let root = fixture
            .store
            .query(QueryFilter {
                event_id: Some(root.id.clone()),
                ..Default::default()
            })
            .await
            .unwrap()
            .remove(0);
        fixture
            .store
            .ensure_thread(NewThread {
                response_annotations: Protocol::On,
                model_alias: None,
                reasoning_effort: None,
                id: legacy_id.into(),
                agent_id: "annotations-agent".into(),
                context_id: "annotations-context".into(),
                session_id: "annotations-session".into(),
                initiating_principal_id: Some("principal-default".into()),
                root_turn_id: root.id.clone(),
                kind: ThreadKind::DialogueTurn,
                executor_kind: "self".into(),
                executor_id: None,
                target_id: None,
                supervision: ThreadSupervision::runtime("dialogue-router"),
            })
            .await
            .unwrap();
        root
    } else {
        // Current ingress atomically persists the Event, stable Thread and
        // Signal. A bare Event plus an independently inserted Activation is
        // not recoverable input: startup could enqueue it a second time.
        // No EventBus/model execution occurs while seeding.
        match fixture
            .store
            .claim_message(
                "annotations-session",
                "annotations-restart-client",
                &root,
                MessageDispatchMode::Interrupt,
            )
            .await
            .unwrap()
        {
            MessageClaim::Accepted { event, .. } => event,
            other => panic!("cannot seed actual durable ingress: {other:?}"),
        }
    };
    // claim_message returns the accepted immutable bytes; the physical
    // append sequence is hydrated by reading the authoritative Event Store.
    let root = fixture
        .store
        .query(QueryFilter {
            event_id: Some(root.id.clone()),
            context_id: Some("annotations-context".into()),
            ..Default::default()
        })
        .await
        .unwrap()
        .remove(0);
    let thread = fixture
        .store
        .get_thread_by_root(&root.id)
        .await
        .unwrap()
        .expect("durable input must have an owning Thread");
    if let Some(legacy_id) = legacy_thread_id {
        assert_eq!(thread.id, legacy_id);
        assert_ne!(thread.id, stable_thread_id(&root.id));
        assert!(fixture
            .store
            .get_thread(&stable_thread_id(&root.id))
            .await
            .unwrap()
            .is_none());
    } else {
        assert_eq!(thread.id, stable_thread_id(&root.id));
    }
    assert_eq!(thread.response_annotations, Protocol::On);
    // stable_thread_activation_id is crate-private. Reproduce that documented
    // scheduler identity in this external integration fixture rather than
    // expanding the production API solely for test seeding.
    let activation_id = format!("work_{:x}", Sha256::digest(root.id.as_bytes()))[..29].to_string();
    let activation = fixture
        .store
        .claim_thread_signal_batch_observed(
            NewThreadSignal {
                id: stable_thread_signal_id(&root.id),
                thread_id: thread.id.clone(),
                thread_generation: thread.generation,
                event_id: root.id.clone(),
                principal_id: thread.initiating_principal_id.clone(),
                sequence: root.sequence.unwrap(),
                kind: root.topic.clone(),
                parent_activation_id: None,
            },
            NewThreadActivation {
                id: activation_id,
                agent_id: thread.agent_id.clone(),
                context_id: thread.context_id.clone(),
                session_id: thread.session_id.clone(),
                initiating_principal_id: thread.initiating_principal_id.clone(),
                trigger_event_id: root.id.clone(),
                trigger_sequence: root.sequence.unwrap(),
                trigger_kind: root.topic.clone(),
                parent_activation_id: None,
                root_turn_id: root.id.clone(),
            },
            DEFAULT_THREAD_SIGNAL_BATCH_LIMIT,
        )
        .await
        .unwrap()
        .activation
        .expect("the real Signal claim must own an Activation");
    let owned_signals = fixture
        .store
        .list_activation_signals(&activation.id)
        .await
        .unwrap();
    assert_eq!(owned_signals.len(), 1);
    assert_eq!(owned_signals[0].event_id, root.id);
    assert_eq!(owned_signals[0].status, ThreadSignalStatus::Claimed);
    let activation = match fixture
        .store
        .update_thread_activation(
            &activation.id,
            activation.revision,
            ThreadActivationStatus::Running,
            Some("runtime:2147483647"),
            Some(chrono::Utc::now() - chrono::Duration::seconds(1)),
            Some(0),
        )
        .await
        .unwrap()
    {
        ThreadActivationMutation::Updated(value) => value,
        other => panic!("cannot seed dead claimant: {other:?}"),
    };
    let scope = ExecutionScope {
        execution_id: thread.id.clone(),
        generation: thread.generation,
    };
    let source_id = format!("call_{}", activation.id);
    let context = NormalizationContext {
        protocol: Protocol::On,
        scope: Some(scope.clone()),
        producer: Some(Producer {
            event_id: source_id.clone(),
            attempt_id: activation.id.clone(),
            sequence: None,
        }),
        ..Default::default()
    };
    let normalized = normalize_response(&ScriptClient::work(RAW_WORK), &context).unwrap();
    let bundle = PersistedAnnotations::from_normalized(scope.clone(), &normalized);
    let stored_calls = |response: &Response| {
        response.tool_calls.iter().map(|c|json!({"id":c.id,"type":c.r#type,"function":{"name":c.func_name,"arguments":c.arguments}})).collect::<Vec<_>>()
    };
    let manifest = morphz::orchestrator::context::ContextViewManifest::context_wide(
        "annotations-context",
        0,
        root.sequence.unwrap(),
        vec![root.id.clone()],
        Vec::<String>::new(),
    );
    let binding = fixture
        .client
        .bind_model_attempt(&ModelRequestContext {
            context_id: thread.context_id.clone(),
            session_id: thread.session_id.clone(),
            attempt_id: activation.id.clone(),
            objective_id: None,
            required_capabilities: vec![],
        })
        .await
        .unwrap();
    fixture.store.append(Event::new(source_id.clone(),"Agent-Morphz".into(),"agent_call".into(),"chat/assistant_call".into(),json!({
        "context_id":thread.context_id,"session_id":thread.session_id,"thread_id":thread.id,
        "thread_generation":thread.generation,"thread_kind":"execution",
        "attempt_id":activation.id,"model_attempt_id":activation.id,"activation_id":activation.id,
        "root_turn_id":root.id,"trigger_event_id":root.id,"trigger_sequence":root.sequence,
        "phase":"work","text":"","context_snapshot_version":0,
        "tool_calls":stored_calls(&normalized.execution_response),
        "continuation_tool_calls":stored_calls(&normalized.raw_response),
        "unavailable_tool_names":[],"context_tx_rejection_status":null,
        "response_annotations":"on",BUNDLE_PAYLOAD_KEY:bundle,
        "context_view_manifest":manifest,"provider_continuation":ScriptClient::continuation(),
        "model_binding":binding,
    }).as_object().unwrap().clone())).await.unwrap();
    let original = fixture
        .store
        .query(QueryFilter {
            event_id: Some(source_id.clone()),
            ..Default::default()
        })
        .await
        .unwrap()
        .remove(0);
    assert_eq!(
        records_from_authorized_event(&original, &scope)
            .unwrap()
            .len(),
        3
    );

    // The seeding Runtime was never started. Close it and construct a genuinely
    // new Runtime/SQLite handle, whose first startup finds the dead claimant.
    let reopened = Arc::new(
        SqliteStore::new(fixture.temp.path().join("annotations.db").to_str().unwrap())
            .await
            .unwrap(),
    );
    let runtime = MorphzRuntime::builder(
        fixture.runtime.config().clone(),
        fixture.client.clone() as Arc<dyn Client>,
    )
    .identity(fixture.runtime.identity().clone())
    .store(
        "sqlite:annotations-restart",
        reopened.clone() as Arc<dyn RuntimeStore>,
    )
    .tool_policy(RuntimeToolPolicy {
        context_only: false,
        coding_eval: false,
    })
    .extra_tool(Arc::new(ProbeTool {
        arguments: fixture.arguments.clone(),
        business_reserved: false,
    }))
    .build()
    .await
    .unwrap();
    let old = std::mem::replace(&mut fixture.runtime, runtime);
    fixture.session = fixture.runtime.session("annotations-session");
    drop(old);
    fixture.store = reopened;
    fixture.runtime.start().await.unwrap();
    let reply = tokio::time::timeout(Duration::from_secs(25), async {
        loop {
            if let Some(reply) = fixture
                .events(&root.id, Some("chat/reply"))
                .await
                .into_iter()
                .next()
            {
                return reply;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("new Runtime did not recover persisted annotated plan");
    assert_eq!(reply.payload["text"], FINAL_TEXT);
    assert_eq!(
        fixture.client.calls.load(Ordering::SeqCst),
        1,
        "recovery must not reask original tool plan"
    );
    assert_eq!(
        fixture.arguments.lock().unwrap().as_slice(),
        &[json!({"key":"system"})]
    );
    let jobs = fixture.jobs().await;
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].thread_id, thread.id);
    let recovered_thread = fixture
        .store
        .get_thread_by_root(&root.id)
        .await
        .unwrap()
        .expect("recovery must preserve the owning Thread");
    assert_eq!(recovered_thread.id, thread.id);
    assert_eq!(recovered_thread.response_annotations, Protocol::On);
    let bound_custom = fixture
        .store
        .get_thread_custom(&thread.id)
        .await
        .unwrap()
        .expect("recovered model Context must freeze the actual Thread Custom binding");
    assert_eq!(bound_custom.thread_id, thread.id);
    assert_eq!(bound_custom.agent_id, thread.agent_id);
    assert_eq!(
        bound_custom.initiating_principal_id,
        thread.initiating_principal_id
    );
    if legacy_thread_id.is_some() {
        assert!(
            fixture
                .store
                .get_thread(&stable_thread_id(&root.id))
                .await
                .unwrap()
                .is_none(),
            "recovery must not manufacture a second stable-ID Thread"
        );
    }
    let restored = fixture
        .store
        .query(QueryFilter {
            event_id: Some(source_id),
            ..Default::default()
        })
        .await
        .unwrap()
        .remove(0);
    assert_eq!(
        restored, original,
        "recovery must not mutate or duplicate the source annotations"
    );
    let outputs = fixture.events(&root.id, Some("chat/tool_output")).await;
    assert_eq!(
        outputs
            .iter()
            .filter(|e| e.payload.get("tool_call_id").and_then(Value::as_str)
                == Some("synthetic-work-call"))
            .count(),
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn invalid_reply_stream_fails_once_without_tool_dispatch_or_repair_inference() {
    for scenario in [Scenario::BadMixedReply, Scenario::BadDuplicateReply] {
        let fixture = Fixture::new(scenario, Protocol::Off).await;
        let mut stream = fixture.runtime.subscribe("runtime/model_stream", 512);
        let root = fixture
            .session
            .send_io_as_principal(
                Fixture::input(Some(Protocol::On)),
                &fixture.runtime.identity().principal_id,
            )
            .await
            .unwrap();
        let thread = tokio::time::timeout(Duration::from_secs(25), async {
            loop {
                if let Some(thread) = fixture
                    .runtime
                    .session_thread_by_root("annotations-session", &root.id)
                    .await
                    .unwrap()
                {
                    if thread.lifecycle.is_terminal() {
                        return thread;
                    }
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("invalid annotation grammar did not terminate");
        assert_eq!(thread.lifecycle, morphz::memory::ThreadLifecycle::Failed);
        assert_eq!(
            fixture.client.calls.load(Ordering::SeqCst),
            1,
            "display protocol must not trigger repair inference"
        );
        assert!(fixture.arguments.lock().unwrap().is_empty());
        assert!(
            fixture.jobs().await.is_empty(),
            "mixed reply must fail before dispatching work"
        );
        let fused = fixture
            .events(&root.id, Some("runtime/response_protocol_fused"))
            .await;
        assert_eq!(
            fused.len(),
            1,
            "session events={:#?}",
            fixture
                .runtime
                .query_events(QueryFilter {
                    session_id: Some("annotations-session".into()),
                    ..Default::default()
                })
                .await
                .unwrap()
        );
        assert_eq!(fused[0].payload["invalid_responses"], 1);
        let failures = fixture
            .events(&root.id, Some("runtime/response_protocol_error"))
            .await;
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].payload["response_capture"]["state"], "complete");
        assert_eq!(
            failures[0].payload["response_capture"]["raw_response"]["tool_calls"][0]["func_name"],
            "reply"
        );
        assert!(
            failures[0].payload["response_capture"]["raw_response"]["tool_calls"][0]["arguments"]
                .as_str()
                .unwrap()
                .contains("annotations")
        );
        let replies = fixture
            .events(&root.id, None)
            .await
            .into_iter()
            .filter(|event| {
                matches!(event.topic.as_str(), "chat/reply" | "session/io_state")
                    && event.payload.get("terminal_kind").and_then(Value::as_str) == Some("failed")
            })
            .collect::<Vec<_>>();
        assert_eq!(
            replies.len(),
            1,
            "terminal events={:#?}",
            fixture.events(&root.id, None).await
        );
        assert_ne!(replies[0].payload["text"], FINAL_TEXT);
        let mut public = String::new();
        while let Ok(event) = stream.try_recv() {
            let event_text = event.payload["stream"].to_string();
            assert!(!event_text.contains("annotations"));
            assert!(!event_text.contains("MUST_NOT_APPLY"));
            if event.payload["stream"]["kind"] == "text_delta" {
                public.push_str(event.payload["stream"]["text"].as_str().unwrap());
            }
        }
        assert!(
            FINAL_TEXT.starts_with(&public),
            "only the candidate public-body prefix may have streamed before failure"
        );
        let calls = fixture.events(&root.id, Some("chat/assistant_call")).await;
        assert!(
            calls
                .iter()
                .all(|event| event.payload.get(BUNDLE_PAYLOAD_KEY).is_none()),
            "invalid control result cannot apply an annotation bundle"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn real_kernel_supersede_keeps_enabled_and_fences_old_generation_annotations() {
    // Use the real Kernel/controller/store transaction, but do not start the
    // Runtime or dispatch its queued wake: generation fencing is deterministic.
    let fixture = Fixture::construct(Scenario::Plain, Protocol::Off, false).await;
    let root=Event::new("annotations-generation-root".into(),"Test-User".into(),"user_message".into(),"chat/user_message".into(),json!({
        "context_id":"annotations-context","session_id":"annotations-session","text":"old intent",
        "response_annotations":"on",
    }).as_object().unwrap().clone());
    fixture.store.append(root.clone()).await.unwrap();
    let thread = fixture
        .store
        .ensure_thread(NewThread {
            response_annotations: Protocol::On,
            model_alias: None,
            reasoning_effort: None,
            id: "annotations-generation-thread".into(),
            agent_id: "annotations-agent".into(),
            context_id: "annotations-context".into(),
            session_id: "annotations-session".into(),
            initiating_principal_id: Some("principal-default".into()),
            root_turn_id: root.id.clone(),
            kind: ThreadKind::Execution,
            executor_kind: "self".into(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::legacy(),
        })
        .await
        .unwrap();
    let old_scope = ExecutionScope {
        execution_id: thread.id.clone(),
        generation: thread.generation,
    };
    let source_id = "call_annotations-generation-old";
    let normalized = normalize_response(
        &ScriptClient::work(RAW_WORK),
        &NormalizationContext {
            protocol: Protocol::On,
            scope: Some(old_scope.clone()),
            producer: Some(Producer {
                event_id: source_id.into(),
                attempt_id: "annotations-generation-old".into(),
                sequence: None,
            }),
            ..Default::default()
        },
    )
    .unwrap();
    fixture.store.append(Event::new(source_id.into(),"Agent-Morphz".into(),"agent_call".into(),"chat/assistant_call".into(),json!({
        "context_id":thread.context_id,"session_id":thread.session_id,"thread_id":thread.id,
        "thread_generation":thread.generation,"root_turn_id":root.id,"model_attempt_id":"annotations-generation-old",
        "response_annotations":"on",BUNDLE_PAYLOAD_KEY:PersistedAnnotations::from_normalized(old_scope.clone(),&normalized),
    }).as_object().unwrap().clone())).await.unwrap();
    let source = fixture
        .store
        .query(QueryFilter {
            event_id: Some(source_id.into()),
            ..Default::default()
        })
        .await
        .unwrap()
        .remove(0);
    assert_eq!(
        records_from_authorized_event(&source, &old_scope)
            .unwrap()
            .len(),
        3
    );
    let kernel =
        morphz::scheduler::SchedulerKernel::new(fixture.store.clone() as Arc<dyn RuntimeStore>);
    let result = kernel
        .execute(morphz::controllers::DialogueController::supersede_thread(
            &thread,
            "annotations-context",
            "corrected intent",
            "fixture correction",
            "Runtime-Operator",
        ))
        .await
        .unwrap();
    let updated = match result {
        morphz::scheduler::KernelResult::ThreadControlled(
            morphz::memory::ThreadMutation::Updated(thread),
        ) => thread,
        other => panic!("Kernel did not supersede actual Thread: {other:?}"),
    };
    assert_eq!(updated.id, thread.id);
    assert_eq!(updated.generation, thread.generation + 1);
    assert_eq!(updated.response_annotations, Protocol::On);
    let display = fixture
        .runtime
        .session_thread_annotations("annotations-context", "annotations-session", &updated.id)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        display.title.is_none()
            && display.progress.is_none()
            && display.result.is_none()
            && display.steps.is_empty()
    );
    let new_scope = ExecutionScope {
        execution_id: updated.id.clone(),
        generation: updated.generation,
    };
    assert!(records_from_authorized_event(&source, &new_scope).is_err());
    let reopen = SqliteStore::new(fixture.temp.path().join("annotations.db").to_str().unwrap())
        .await
        .unwrap();
    assert_eq!(
        reopen
            .get_thread(&updated.id)
            .await
            .unwrap()
            .unwrap()
            .response_annotations,
        Protocol::On
    );
    assert_eq!(
        reopen
            .query(QueryFilter {
                event_id: Some(source_id.into()),
                ..Default::default()
            })
            .await
            .unwrap()
            .remove(0),
        source
    );
    assert_eq!(fixture.client.calls.load(Ordering::SeqCst), 0);
    assert!(fixture.jobs().await.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn restart_settles_seeded_enabled_wait_receipt_without_reasking_or_rearming() {
    assert_restart_settles_seeded_enabled_wait_receipt(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn restart_settles_legacy_enabled_wait_receipt_without_reasking_or_rearming() {
    assert_restart_settles_seeded_enabled_wait_receipt(true).await;
}

async fn assert_restart_settles_seeded_enabled_wait_receipt(legacy: bool) {
    use morphz::memory::{
        stable_thread_signal_id, DeliveryIngressStore, MessageClaim, MessageDispatchMode,
        NewRuntimeTimer, NewThreadSignal, RuntimeTimerKind, RuntimeTimerStatus, SignalOutboxStatus,
        ThreadSignalStatus, TimerStore, DEFAULT_THREAD_SIGNAL_BATCH_LIMIT,
    };
    use morphz::response_annotations::{project_execution, ExecutionFact};
    use sha2::Digest;

    // This is durable crash-boundary seeding, not an actual process kill or a
    // normal wait-control selection test. The authoritative wait receipt and
    // its previously armed Timer are recovered by a new Runtime/SQLite handle.
    // DialogueTurn avoids fabricating a physical-plan promotion just to enter
    // recovery; production waits selected by a model require an Execution.
    let mut fixture = Fixture::construct(Scenario::Plain, Protocol::Off, false).await;
    let root = Event::new(
        "annotations-wait-restart-root".into(),
        "Test-User".into(),
        "user_message".into(),
        "chat/user_message".into(),
        json!({
            "agent_id":"annotations-agent",
            "context_id":"annotations-context","session_id":"annotations-session",
            "principal_id":"principal-default","text":"Continue after pending work",
            "response_annotations":"on",
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    let root = match fixture
        .store
        .claim_message(
            "annotations-session",
            "annotations-wait-restart-client",
            &root,
            MessageDispatchMode::Interrupt,
        )
        .await
        .unwrap()
    {
        MessageClaim::Accepted { event, .. } => event,
        other => panic!("cannot create the actual wait-root ingress: {other:?}"),
    };
    let root = fixture
        .store
        .query(QueryFilter {
            event_id: Some(root.id.clone()),
            context_id: Some("annotations-context".into()),
            ..Default::default()
        })
        .await
        .unwrap()
        .remove(0);
    let thread = fixture
        .store
        .get_thread_by_root(&root.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(thread.response_annotations, Protocol::On);
    assert_eq!(thread.kind, ThreadKind::DialogueTurn);
    // The Store's stable activation helper is crate-private. Reproduce its
    // public scheduler-contract digest here, instead of inventing a new ID.
    let mut activation_id = format!("work_{:x}", sha2::Sha256::digest(root.id.as_bytes()));
    activation_id.truncate(29);
    let activation = fixture
        .store
        .claim_thread_signal_batch_observed(
            NewThreadSignal {
                id: stable_thread_signal_id(&root.id),
                thread_id: thread.id.clone(),
                thread_generation: thread.generation,
                event_id: root.id.clone(),
                principal_id: thread.initiating_principal_id.clone(),
                sequence: root.sequence.unwrap(),
                kind: root.topic.clone(),
                parent_activation_id: None,
            },
            NewThreadActivation {
                id: activation_id.clone(),
                agent_id: thread.agent_id.clone(),
                context_id: thread.context_id.clone(),
                session_id: thread.session_id.clone(),
                initiating_principal_id: thread.initiating_principal_id.clone(),
                trigger_event_id: root.id.clone(),
                trigger_sequence: root.sequence.unwrap(),
                trigger_kind: root.topic.clone(),
                parent_activation_id: None,
                root_turn_id: root.id.clone(),
            },
            DEFAULT_THREAD_SIGNAL_BATCH_LIMIT,
        )
        .await
        .unwrap()
        .activation
        .expect("the actual root Signal must own its queued Activation");
    assert_eq!(activation.id, activation_id);
    let signals = fixture
        .store
        .list_activation_signals(&activation.id)
        .await
        .unwrap();
    assert_eq!(signals.len(), 1);
    assert_eq!(signals[0].event_id, root.id);
    assert_eq!(signals[0].thread_id, thread.id);
    assert_eq!(signals[0].status, ThreadSignalStatus::Claimed);
    assert!(
        !fixture
            .store
            .list_signal_outbox(SignalOutboxStatus::Pending, 64)
            .await
            .unwrap()
            .iter()
            .any(|item| item.event_id == root.id),
        "the original ingress has already been materialized"
    );
    let activation = match fixture
        .store
        .update_thread_activation(
            &activation.id,
            activation.revision,
            ThreadActivationStatus::Running,
            Some("runtime:2147483647"),
            Some(chrono::Utc::now() - chrono::Duration::seconds(1)),
            Some(0),
        )
        .await
        .unwrap()
    {
        ThreadActivationMutation::Updated(value) => value,
        other => panic!("cannot seed a dead wait claimant: {other:?}"),
    };
    let mut timer_payload = json!({
        "context_id":thread.context_id,"session_id":thread.session_id,
        "thread_id":thread.id,"activation_id":activation.id,
        "wait_secs":86400,"wait_source":"runtime_default",
        "armed_at":chrono::Utc::now(),
    });
    if !legacy {
        timer_payload["response_annotations"] = json!("on");
        timer_payload["thread_generation"] = json!(thread.generation);
    }
    let timer = fixture
        .store
        .upsert_runtime_timer(NewRuntimeTimer {
            id: format!("thread-wait:{}", thread.id),
            generation: 42,
            kind: RuntimeTimerKind::ThreadWait,
            owner_id: thread.id.clone(),
            due_at: chrono::Utc::now() + chrono::Duration::hours(24),
            payload: timer_payload,
        })
        .await
        .unwrap();
    assert_eq!(timer.status, RuntimeTimerStatus::Pending);
    let scope = ExecutionScope {
        execution_id: thread.id.clone(),
        generation: thread.generation,
    };
    let source_id = if legacy {
        format!("call_{}", activation.id)
    } else {
        format!("call_{}_final", activation.id)
    };
    let normalized = normalize_response(
        &ScriptClient::reply(json!({
            "content":"等待尚未完成的工作。",
            "annotations":{"execution":{"title":"等待现有工作","result":"WAIT_CANDIDATE_MUST_NOT_APPLY"}},
        })),
        &NormalizationContext {
            protocol: Protocol::On,
            scope: Some(scope.clone()),
            producer: Some(Producer {
                event_id: source_id.clone(),
                attempt_id: activation.id.clone(),
                sequence: None,
            }),
            ..Default::default()
        },
    )
    .unwrap();
    let manifest = morphz::orchestrator::context::ContextViewManifest::context_wide(
        thread.context_id.clone(),
        0,
        root.sequence.unwrap(),
        vec![root.id.clone()],
        Vec::<String>::new(),
    );
    let binding = fixture
        .client
        .bind_model_attempt(&ModelRequestContext {
            context_id: thread.context_id.clone(),
            session_id: thread.session_id.clone(),
            attempt_id: activation.id.clone(),
            objective_id: None,
            required_capabilities: vec![],
        })
        .await
        .unwrap();
    fixture
        .store
        .append(Event::new(
            source_id.clone(),
            "Runtime".into(),
            "agent_call".into(),
            "runtime/thread_waiting".into(),
            json!({
                "context_id":thread.context_id,"session_id":thread.session_id,
                "thread_id":thread.id,"thread_generation":thread.generation,
                "thread_kind":"dialogue_turn","principal_id":"principal-default",
                "attempt_id":activation.id,"activation_id":activation.id,
                "model_attempt_id":activation.id,"root_turn_id":root.id,
                "trigger_event_id":root.id,"trigger_sequence":root.sequence,
                "phase":"waiting","terminal_outcome":false,
                "text":normalized.execution_response.content,"tool_calls":[],
                "context_snapshot_version":0,"context_view_manifest":manifest,
                "response_annotations":"on",
                BUNDLE_PAYLOAD_KEY:PersistedAnnotations::from_normalized(scope.clone(),&normalized),
                "provider_continuation":ScriptClient::continuation(),"model_binding":binding,
                "model_disposition":"deliver","wait_secs":86400,
                "wait_source":"runtime_default","wait_until":timer.due_at,
                "wait_timer_id":timer.id,"wait_timer_generation":timer.generation,
            })
            .as_object()
            .unwrap()
            .clone(),
        ))
        .await
        .unwrap();
    let original = fixture
        .store
        .query(QueryFilter {
            event_id: Some(source_id.clone()),
            ..Default::default()
        })
        .await
        .unwrap()
        .remove(0);
    let records = records_from_authorized_event(&original, &scope).unwrap();
    let candidate = records
        .iter()
        .find(|record| record.kind == AnnotationKind::Result)
        .expect("the receipt must contain a real candidate result, not an empty assertion");
    assert_eq!(candidate.value, "WAIT_CANDIDATE_MUST_NOT_APPLY");
    assert!(!candidate.effective, "yielding is not a terminal outcome");

    let reopened = Arc::new(
        SqliteStore::new(fixture.temp.path().join("annotations.db").to_str().unwrap())
            .await
            .unwrap(),
    );
    let runtime = MorphzRuntime::builder(
        fixture.runtime.config().clone(),
        fixture.client.clone() as Arc<dyn Client>,
    )
    .identity(fixture.runtime.identity().clone())
    .store(
        "sqlite:annotations-wait-restart",
        reopened.clone() as Arc<dyn RuntimeStore>,
    )
    .tool_policy(RuntimeToolPolicy {
        context_only: false,
        coding_eval: false,
    })
    .extra_tool(Arc::new(ProbeTool {
        arguments: fixture.arguments.clone(),
        business_reserved: false,
    }))
    .build()
    .await
    .unwrap();
    let old = std::mem::replace(&mut fixture.runtime, runtime);
    fixture.session = fixture.runtime.session("annotations-session");
    drop(old);
    fixture.store = reopened;
    fixture.runtime.start().await.unwrap();
    let settled = tokio::time::timeout(Duration::from_secs(25), async {
        loop {
            let current = fixture
                .store
                .get_thread_activation(&activation.id)
                .await
                .unwrap()
                .unwrap();
            if current.status.is_terminal() {
                return current;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("new Runtime did not settle the persisted annotated wait receipt");
    assert_eq!(settled.id, activation.id);
    assert_eq!(settled.generation, activation.generation);
    assert_eq!(settled.status, ThreadActivationStatus::Succeeded);
    assert_eq!(fixture.client.calls.load(Ordering::SeqCst), 0);
    assert!(fixture.client.captured.lock().unwrap().is_empty());
    assert!(fixture.arguments.lock().unwrap().is_empty());
    assert!(fixture.jobs().await.is_empty());
    let restored = fixture
        .store
        .query(QueryFilter {
            event_id: Some(source_id.clone()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(restored.len(), 1, "no duplicate original response Event");
    assert_eq!(
        restored[0], original,
        "raw/normalized receipt remains immutable"
    );
    assert_eq!(
        fixture.store.get_runtime_timer(&timer.id).await.unwrap(),
        Some(timer.clone()),
        "recovery must not rearm or mutate the previously armed wait Timer"
    );
    let waiting_timers = fixture
        .store
        .list_runtime_timers(None)
        .await
        .unwrap()
        .into_iter()
        .filter(|item| item.kind == RuntimeTimerKind::ThreadWait && item.owner_id == thread.id)
        .collect::<Vec<_>>();
    assert_eq!(waiting_timers, vec![timer]);
    assert!(fixture
        .events(&root.id, Some("chat/reply"))
        .await
        .is_empty());
    assert!(fixture
        .events(&root.id, Some("chat/assistant_call"))
        .await
        .is_empty());
    let current_thread = fixture.store.get_thread(&thread.id).await.unwrap().unwrap();
    assert!(!current_thread.lifecycle.is_terminal());
    let restored_records = records_from_authorized_event(&restored[0], &scope).unwrap();
    let projection = project_execution(
        &ExecutionFact {
            scope,
            status: current_thread.lifecycle.as_str().into(),
            terminal: false,
            terminal_sequence: None,
        },
        &restored_records,
    );
    assert!(
        projection.result.is_none(),
        "a waiting Result must not become effective"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn interactive_delivery_with_a_future_schedule_preserves_off_outcome_and_enabled_source() {
    use morphz::memory::{
        ExecutionJobStatus, NewSchedule, ScheduleStatus, ScheduleStore, ThreadLifecycle, TimerStore,
    };
    use morphz::response_annotations::{project_authorized_events, ExecutionFact};

    for annotated in [true, false] {
        let fixture = Fixture::new(Scenario::WorkYield(annotated), Protocol::Off).await;
        let accepted = fixture
            .session
            .send_io_as_principal(
                Fixture::input(annotated.then_some(Protocol::On)),
                &fixture.runtime.identity().principal_id,
            )
            .await
            .unwrap();
        tokio::time::timeout(
            Duration::from_secs(25),
            fixture.client.second_request_entered.notified(),
        )
        .await
        .expect("the original physical receipt did not reach the next native model request");
        let thread = fixture
            .store
            .get_thread_by_root(&accepted.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(thread.kind, ThreadKind::Execution);
        assert_eq!(
            thread.response_annotations,
            if annotated {
                Protocol::On
            } else {
                Protocol::Off
            }
        );
        let jobs = fixture.jobs().await;
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].thread_id, thread.id);
        assert_eq!(jobs[0].status, ExecutionJobStatus::Succeeded);
        // Only this future Schedule is host-authored via the actual Store.
        // The Runtime must decide its real Outcome; no terminal or wait facts
        // are injected, and enabled annotations may not change the existing Off decision.
        let schedule = fixture
            .store
            .ensure_schedule(NewSchedule {
                reasoning_effort: None,
                id: "annotations-delivery-future-schedule".into(),
                thread_id: thread.id.clone(),
                source_turn_id: accepted.id.clone(),
                intent: "Synthetic follow-up, not due during this test".into(),
                model_alias: None,
                not_before: Some(chrono::Utc::now() + chrono::Duration::hours(24)),
                interval_seconds: None,
                dependency_thread_ids: vec![],
            })
            .await
            .unwrap();
        assert_eq!(schedule.status, ScheduleStatus::Queued);
        fixture.client.release_second_response.notify_one();
        let detail = tokio::time::timeout(Duration::from_secs(25), async {
            loop {
                let detail = fixture
                    .runtime
                    .thread_detail(&thread.context_id, &thread.id)
                    .await
                    .unwrap()
                    .unwrap();
                if detail.snapshot.thread.lifecycle == ThreadLifecycle::Completed
                    && detail
                        .snapshot
                        .activations
                        .iter()
                        .all(|snapshot| snapshot.activation.status.is_terminal())
                    && detail.snapshot.outcome.is_some()
                {
                    break detail;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("normal interactive delivery did not settle its actual terminal Outcome");
        let outcome = detail.snapshot.outcome.unwrap();
        assert_eq!(outcome.terminal_kind, ThreadLifecycle::Completed);
        let events = fixture.events(&accepted.id, None).await;
        assert_eq!(
            events
                .iter()
                .filter(|event| event.topic == "chat/reply" && event.payload["text"] == FINAL_TEXT)
                .count(),
            1
        );
        assert!(!events.iter().any(|event| matches!(event.topic.as_str(),
            "runtime/thread_waiting" | "runtime/response_protocol_fused")),
            "interactive reply keeps its real terminal semantics; a future Schedule is not a forged wait");
        assert!(
            fixture
                .store
                .list_runtime_timers(None)
                .await
                .unwrap()
                .iter()
                .all(|timer| timer.owner_id != thread.id),
            "completed interactive delivery must not arm a ThreadWait timer"
        );
        if annotated {
            let final_source = events
                .iter()
                .find(|event| {
                    event.topic == "chat/assistant_call"
                        && event.payload.get("terminal_outcome") == Some(&json!(true))
                })
                .unwrap();
            assert_eq!(
                final_source.id,
                format!(
                    "call_{}_final",
                    final_source.payload["activation_id"].as_str().unwrap()
                )
            );
            assert_eq!(final_source.payload["thread_id"], thread.id);
            assert_eq!(final_source.payload["thread_generation"], thread.generation);
            assert_eq!(final_source.payload["response_annotations"], "on");
            assert_eq!(final_source.payload["text"], FINAL_TEXT);
            assert!(final_source.payload["tool_calls"]
                .as_array()
                .unwrap()
                .is_empty());
            let bundle: PersistedAnnotations =
                serde_json::from_value(final_source.payload[BUNDLE_PAYLOAD_KEY].clone()).unwrap();
            assert_eq!(bundle.raw_response.tool_calls[0].func_name, "reply");
            let scope = ExecutionScope {
                execution_id: thread.id.clone(),
                generation: thread.generation,
            };
            let records = records_from_authorized_event(final_source, &scope).unwrap();
            let result = records
                .iter()
                .find(|record| record.kind == AnnotationKind::Result)
                .unwrap();
            assert!(result.effective);
            assert_eq!(result.value, "已确认合成系统为 Linux；后续任务保持排队");
            assert_eq!(result.source.event_id, final_source.id);
            assert_eq!(result.source.sequence, final_source.sequence);
            let projection = project_authorized_events(
                &ExecutionFact {
                    scope,
                    status: detail.snapshot.thread.lifecycle.as_str().into(),
                    terminal: true,
                    terminal_sequence: outcome.terminal_event_sequence,
                },
                &events,
            )
            .unwrap();
            assert_eq!(
                projection.result.as_deref(),
                Some("已确认合成系统为 Linux；后续任务保持排队")
            );
        } else {
            assert!(events
                .iter()
                .all(|event| !event.payload.contains_key(BUNDLE_PAYLOAD_KEY)));
        }
        assert_eq!(fixture.client.calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            fixture.arguments.lock().unwrap().as_slice(),
            &[json!({"key":"system"})]
        );
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(
            fixture.client.calls.load(Ordering::SeqCst),
            2,
            "activity metadata must not manufacture a third inference request"
        );
        assert_eq!(fixture.jobs().await, jobs);
        assert_eq!(
            fixture.store.get_schedule(&schedule.id).await.unwrap(),
            Some(schedule)
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rejected_objective_completion_then_reply_has_distinct_enabled_boundaries_in_one_activation(
) {
    for annotated in [true, false] {
        let fixture = Fixture::new(Scenario::CompletionRejected(annotated), Protocol::Off).await;
        let protocol = annotated.then_some(Protocol::On);
        let (root, reply) = fixture.submit(protocol).await;
        assert_eq!(reply.payload["text"], "目标未绑定，因此未执行关闭。");
        assert_eq!(
            fixture.client.calls.load(Ordering::SeqCst),
            2,
            "the failed-control reassessment and final answer are the original two requests"
        );
        assert!(
            fixture.jobs().await.is_empty(),
            "rejected logical control and reply are not physical Jobs"
        );
        assert!(fixture.arguments.lock().unwrap().is_empty());
        let outputs = fixture.events(&root.id, Some("chat/tool_output")).await;
        let completion = outputs
            .iter()
            .filter(|event| event.payload["tool_name"] == "objective_update")
            .collect::<Vec<_>>();
        assert_eq!(
            completion.len(),
            1,
            "the actual rejected completion call must have exactly one receipt"
        );
        let completion = completion[0];
        let receipt = completion.payload["text"].as_str().unwrap();
        assert!(!receipt.contains("completion_prepared"));
        assert!(matches!(completion.payload["tool_status"].as_str(), Some("error" | "rejected")),
            "the fixture must exercise real control rejection, not successful finalization: {completion:?}");
        let calls = fixture.events(&root.id, Some("chat/assistant_call")).await;
        assert_eq!(
            calls.len(),
            2,
            "work and final response must both remain independently durable"
        );
        let work = calls
            .iter()
            .find(|event| {
                event.payload["tool_calls"].as_array().is_some_and(|calls| {
                    calls
                        .iter()
                        .any(|call| call["function"]["name"] == "objective_update")
                })
            })
            .unwrap();
        let final_event = calls
            .iter()
            .find(|event| event.payload.get("terminal_outcome") == Some(&json!(true)))
            .unwrap();
        let activation = work.payload["activation_id"].as_str().unwrap();
        assert_eq!(final_event.payload["activation_id"], activation);
        assert_eq!(completion.payload["activation_id"], activation);
        assert_eq!(work.id, format!("call_{activation}"));
        assert_eq!(final_event.id, format!("call_{activation}_final"));
        assert_ne!(work.id, final_event.id);
        assert!(work.sequence.unwrap() < completion.sequence.unwrap());
        assert!(completion.sequence.unwrap() < final_event.sequence.unwrap());
        if !annotated {
            assert!(calls
                .iter()
                .all(|event| !event.payload.contains_key(BUNDLE_PAYLOAD_KEY)));
            assert_eq!(final_event.payload["text"], "目标未绑定，因此未执行关闭。");
            assert!(final_event.payload["tool_calls"]
                .as_array()
                .unwrap()
                .is_empty());
            continue;
        }
        let work_bundle: PersistedAnnotations =
            serde_json::from_value(work.payload[BUNDLE_PAYLOAD_KEY].clone()).unwrap();
        let final_bundle: PersistedAnnotations =
            serde_json::from_value(final_event.payload[BUNDLE_PAYLOAD_KEY].clone()).unwrap();
        assert_eq!(
            work_bundle.raw_response.tool_calls[0].func_name,
            "objective_update"
        );
        assert_eq!(final_bundle.raw_response.tool_calls[0].func_name, "reply");
        assert_eq!(work_bundle.scope, final_bundle.scope);
        assert!(records_from_authorized_event(work, &work_bundle.scope)
            .unwrap()
            .iter()
            .all(|record| record.kind != AnnotationKind::Result || !record.effective));
        let result = records_from_authorized_event(final_event, &final_bundle.scope)
            .unwrap()
            .into_iter()
            .find(|record| record.kind == AnnotationKind::Result)
            .unwrap();
        assert_eq!(result.value, "未绑定目标，关闭请求被拒绝");
        assert!(result.effective);
        assert_eq!(result.source.event_id, final_event.id);
        assert_eq!(result.source.sequence, final_event.sequence);
        assert_eq!(fixture.client.captured.lock().unwrap().len(), 2);
    }
}

fn assert_lifecycle_work_result_rejected(
    event: &Event,
    scope: &ExecutionScope,
) -> Vec<morphz::response_annotations::AnnotationRecord> {
    let bundle: PersistedAnnotations =
        serde_json::from_value(event.payload[BUNDLE_PAYLOAD_KEY].clone()).unwrap();
    assert_eq!(bundle.scope, *scope);
    assert_eq!(bundle.raw_response.tool_calls.len(), 1);
    assert_eq!(
        bundle.raw_response.tool_calls[0].func_name,
        "annotation_probe"
    );
    assert_eq!(
        bundle.raw_response.tool_calls[0].arguments, RAW_LIFECYCLE_WORK,
        "rejection must retain the model's exact original candidate for audit"
    );
    let original: Value =
        serde_json::from_str(&bundle.raw_response.tool_calls[0].arguments).unwrap();
    assert_eq!(
        original["_annotations"]["execution"]["result"],
        "LIFECYCLE_CANDIDATE_MUST_NOT_FINALIZE"
    );
    assert_eq!(serde_json::to_value(&bundle.diagnostics).unwrap(), json!([{
        "path":"tool_calls[0]._annotations.execution.result",
        "message":"Working response cannot establish final result",
    }]), "a work carrier is rejected locally for the precise nonterminal-carrier rule, not retained as an effective or ineffective final result");
    assert_eq!(bundle.omitted_diagnostics, 0);
    let records = records_from_authorized_event(event, scope).unwrap();
    assert!(records
        .iter()
        .all(|record| record.kind != AnnotationKind::Result));
    assert_eq!(
        records
            .iter()
            .filter(|record| record.kind == AnnotationKind::Title)
            .count(),
        1
    );
    assert_eq!(
        records
            .iter()
            .filter(|record| record.kind == AnnotationKind::Progress)
            .count(),
        1
    );
    assert_eq!(
        records
            .iter()
            .filter(|record| record.kind == AnnotationKind::Intent)
            .count(),
        1
    );
    records
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn actual_no_reply_silent_preserves_enabled_grammar_without_a_result_or_extra_request() {
    use morphz::memory::{ExecutionJobStatus, ThreadLifecycle};
    use morphz::response_annotations::{project_authorized_events, ExecutionFact};

    for annotated in [true, false] {
        let fixture = Fixture::new(Scenario::NoReplySilent(annotated), Protocol::Off).await;
        let accepted = fixture
            .session
            .send_io_as_principal(
                Fixture::input(annotated.then_some(Protocol::On)),
                &fixture.runtime.identity().principal_id,
            )
            .await
            .unwrap();
        let detail = tokio::time::timeout(Duration::from_secs(25), async {
            loop {
                if let Some(thread) = fixture
                    .runtime
                    .session_thread_by_root("annotations-session", &accepted.id)
                    .await
                    .unwrap()
                {
                    if let Some(detail) = fixture
                        .runtime
                        .thread_detail(&thread.context_id, &thread.id)
                        .await
                        .unwrap()
                    {
                        if detail.snapshot.thread.lifecycle == ThreadLifecycle::Completed
                            && detail
                                .snapshot
                                .activations
                                .iter()
                                .all(|snapshot| snapshot.activation.status.is_terminal())
                        {
                            break detail;
                        }
                    }
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("actual no_reply(silent) did not settle its Execution");
        let thread = &detail.snapshot.thread;
        assert_eq!(thread.kind, ThreadKind::Execution);
        let outcome = detail
            .snapshot
            .outcome
            .as_ref()
            .expect("silent termination must own a real Outcome");
        assert_eq!(outcome.terminal_kind, ThreadLifecycle::Completed);
        assert_eq!(outcome.disposition, "no_reply");
        let events = fixture.events(&accepted.id, None).await;
        assert_eq!(
            events
                .iter()
                .filter(|event| event.topic == "chat/no_reply")
                .count(),
            1
        );
        assert!(!events.iter().any(|event| matches!(
            event.topic.as_str(),
            "chat/reply" | "runtime/thread_waiting"
        )));
        let final_event = events
            .iter()
            .find(|event| {
                event.topic == "chat/assistant_call"
                    && event.payload.get("terminal_outcome") == Some(&json!(true))
            })
            .expect("the actual silent control response must be durable");
        assert_eq!(final_event.payload["outcome_disposition"], "no_reply");
        assert_eq!(final_event.payload["text"], "");
        if annotated {
            let scope = ExecutionScope {
                execution_id: thread.id.clone(),
                generation: thread.generation,
            };
            assert_eq!(
                final_event.id,
                format!(
                    "call_{}_final",
                    final_event.payload["activation_id"].as_str().unwrap()
                )
            );
            let bundle: PersistedAnnotations =
                serde_json::from_value(final_event.payload[BUNDLE_PAYLOAD_KEY].clone()).unwrap();
            assert_eq!(bundle.raw_response.tool_calls[0].func_name, "no_reply");
            assert_eq!(
                serde_json::from_str::<Value>(&bundle.raw_response.tool_calls[0].arguments)
                    .unwrap(),
                json!({"mode":"silent"})
            );
            assert!(
                records_from_authorized_event(final_event, &scope)
                    .unwrap()
                    .is_empty(),
                "enabled annotations must not smuggle annotations into no_reply's original grammar"
            );
            let work = events
                .iter()
                .find(|event| {
                    event.topic == "chat/assistant_call"
                        && event.payload.get("terminal_outcome") != Some(&json!(true))
                })
                .unwrap();
            let records = assert_lifecycle_work_result_rejected(work, &scope);
            assert!(records
                .iter()
                .all(|record| record.kind != AnnotationKind::Result));
            let projection = project_authorized_events(
                &ExecutionFact {
                    scope,
                    status: thread.lifecycle.as_str().into(),
                    terminal: thread.lifecycle.is_terminal(),
                    terminal_sequence: outcome.terminal_event_sequence,
                },
                &events,
            )
            .unwrap();
            assert_eq!(projection.status, "completed");
            assert_eq!(projection.title.as_deref(), Some("检查后选择生命周期边界"));
            assert!(
                projection.progress.is_none() && projection.result.is_none(),
                "silent termination cannot invent a final model summary from a work candidate"
            );
        } else {
            assert!(events
                .iter()
                .all(|event| !event.payload.contains_key(BUNDLE_PAYLOAD_KEY)));
        }
        let jobs = fixture.jobs().await;
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].status, ExecutionJobStatus::Succeeded);
        assert_eq!(
            fixture.arguments.lock().unwrap().as_slice(),
            &[json!({"key":"system"})]
        );
        assert_eq!(fixture.client.calls.load(Ordering::SeqCst), 2);
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(
            fixture.client.calls.load(Ordering::SeqCst),
            2,
            "silent lifecycle metadata must not schedule a summary request"
        );
        assert_eq!(fixture.jobs().await, jobs);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn actual_no_reply_wait_uses_real_pending_work_and_does_not_finalize_or_reask() {
    use morphz::memory::{
        ExecutionJobStatus, NewSchedule, RuntimeTimerKind, RuntimeTimerStatus, ScheduleStatus,
        ScheduleStore, ThreadLifecycle, ThreadPhase, TimerStore,
    };
    use morphz::response_annotations::{project_authorized_events, ExecutionFact};

    for protocol in [Protocol::On, Protocol::Off] {
        let annotated = !protocol.is_off();
        let fixture = Fixture::new(Scenario::NoReplyWait(annotated), Protocol::Off).await;
        let accepted = fixture
            .session
            .send_io_as_principal(
                Fixture::input(annotated.then_some(protocol)),
                &fixture.runtime.identity().principal_id,
            )
            .await
            .unwrap();
        tokio::time::timeout(
            Duration::from_secs(25),
            fixture.client.second_request_entered.notified(),
        )
        .await
        .expect("the actual physical receipt did not reach the second original request");
        let thread = fixture
            .runtime
            .session_thread_by_root("annotations-session", &accepted.id)
            .await
            .unwrap()
            .unwrap();
        let jobs = fixture.jobs().await;
        assert_eq!(thread.kind, ThreadKind::Execution);
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].status, ExecutionJobStatus::Succeeded);
        // This pending fact is host-authored through the real ScheduleStore;
        // no wait Event, lifecycle transition, or Timer is hand-manufactured.
        let schedule = fixture
            .store
            .ensure_schedule(NewSchedule {
                reasoning_effort: None,
                id: "annotations-explicit-wait-schedule".into(),
                thread_id: thread.id.clone(),
                source_turn_id: accepted.id.clone(),
                intent: "Synthetic follow-up due after this fixture".into(),
                model_alias: None,
                not_before: Some(chrono::Utc::now() + chrono::Duration::hours(24)),
                interval_seconds: None,
                dependency_thread_ids: vec![],
            })
            .await
            .unwrap();
        assert_eq!(schedule.status, ScheduleStatus::Queued);
        fixture.client.release_second_response.notify_one();
        let (waiting, detail) = tokio::time::timeout(Duration::from_secs(25), async {
            loop {
                let events = fixture.events(&accepted.id, None).await;
                if let Some(waiting) = events
                    .iter()
                    .find(|event| event.topic == "runtime/thread_waiting")
                {
                    if let Some(detail) = fixture
                        .runtime
                        .thread_detail(&thread.context_id, &thread.id)
                        .await
                        .unwrap()
                    {
                        if detail.snapshot.phase == ThreadPhase::Waiting
                            && detail
                                .snapshot
                                .activations
                                .iter()
                                .all(|snapshot| snapshot.activation.status.is_terminal())
                        {
                            break (waiting.clone(), detail);
                        }
                    }
                }
                assert!(
                    !events.iter().any(|event| matches!(
                        event.topic.as_str(),
                        "runtime/response_protocol_error" | "runtime/response_protocol_fused"
                    )),
                    "real pending work must satisfy wait admission without a correction request"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("actual no_reply(wait) did not enter a durable waiting phase");
        assert_eq!(detail.snapshot.thread.lifecycle, ThreadLifecycle::Open);
        assert!(detail.snapshot.outcome.is_none());
        assert_eq!(waiting.payload["model_disposition"], "wait");
        assert_eq!(waiting.payload["wait_source"], "model");
        assert_eq!(waiting.payload["wait_secs"], 86_400);
        assert_eq!(waiting.payload["pending_schedules"], 1);
        let timer = fixture
            .store
            .get_runtime_timer(waiting.payload["wait_timer_id"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(timer.kind, RuntimeTimerKind::ThreadWait);
        assert_eq!(timer.status, RuntimeTimerStatus::Pending);
        assert_eq!(timer.owner_id, thread.id);
        assert_eq!(timer.payload["wait_secs"], 86_400);
        assert_eq!(
            Some(timer.generation),
            waiting.payload["wait_timer_generation"].as_u64()
        );
        assert!(
            timer.due_at > chrono::Utc::now() + chrono::Duration::hours(23),
            "explicit wait must remain finite and not turn into an immediate synthetic wake"
        );
        let events = fixture.events(&accepted.id, None).await;
        assert!(!events
            .iter()
            .any(|event| matches!(event.topic.as_str(), "chat/reply" | "chat/no_reply")));
        if annotated {
            let scope = ExecutionScope {
                execution_id: thread.id.clone(),
                generation: thread.generation,
            };
            assert_eq!(
                waiting.id,
                format!(
                    "call_{}_final",
                    waiting.payload["activation_id"].as_str().unwrap()
                )
            );
            assert_eq!(timer.payload["thread_generation"], thread.generation);
            assert_eq!(timer.payload["response_annotations"], protocol.as_str());
            let bundle: PersistedAnnotations =
                serde_json::from_value(waiting.payload[BUNDLE_PAYLOAD_KEY].clone()).unwrap();
            assert_eq!(bundle.protocol, protocol);
            assert_eq!(bundle.raw_response.tool_calls[0].func_name, "no_reply");
            assert_eq!(
                serde_json::from_str::<Value>(&bundle.raw_response.tool_calls[0].arguments)
                    .unwrap(),
                json!({"mode":"wait","wait_secs":86_400})
            );
            assert!(records_from_authorized_event(&waiting, &scope)
                .unwrap()
                .is_empty());
            let work = events
                .iter()
                .find(|event| {
                    event.topic == "chat/assistant_call"
                        && event.payload.get("terminal_outcome") != Some(&json!(true))
                })
                .unwrap();
            assert_lifecycle_work_result_rejected(work, &scope);
            let projection = project_authorized_events(
                &ExecutionFact {
                    scope,
                    status: detail.snapshot.thread.lifecycle.as_str().into(),
                    terminal: detail.snapshot.thread.lifecycle.is_terminal(),
                    terminal_sequence: None,
                },
                &events,
            )
            .unwrap();
            assert_eq!(projection.status, "open");
            assert_eq!(projection.title.as_deref(), Some("检查后选择生命周期边界"));
            assert_eq!(projection.progress.as_deref(), Some("读取合成系统"));
            assert!(projection.result.is_none(), "waiting is not terminal, even when the earlier work response included a candidate result");
        } else {
            assert!(events
                .iter()
                .all(|event| !event.payload.contains_key(BUNDLE_PAYLOAD_KEY)));
        }
        assert_eq!(fixture.client.calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            fixture.arguments.lock().unwrap().as_slice(),
            &[json!({"key":"system"})]
        );
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(
            fixture.client.calls.load(Ordering::SeqCst),
            2,
            "wait metadata cannot add a naming or summary request"
        );
        assert_eq!(fixture.jobs().await, jobs);
        assert_eq!(
            fixture.store.get_schedule(&schedule.id).await.unwrap(),
            Some(schedule)
        );
        assert_eq!(
            fixture.store.get_runtime_timer(&timer.id).await.unwrap(),
            Some(timer)
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn actual_operator_cancel_drops_native_request_without_model_final_or_extra_inference() {
    use morphz::memory::{
        ExecutionJobStatus, ThreadControlAction, ThreadLifecycle, ThreadMutation,
    };
    use morphz::response_annotations::{project_execution, ExecutionFact};

    for protocol in [Protocol::On, Protocol::Off] {
        let annotated = !protocol.is_off();
        let fixture = Fixture::new(Scenario::CancelModel(annotated), Protocol::Off).await;
        let accepted = fixture
            .session
            .send_io_as_principal(
                Fixture::input(annotated.then_some(protocol)),
                &fixture.runtime.identity().principal_id,
            )
            .await
            .unwrap();
        tokio::time::timeout(
            Duration::from_secs(25),
            fixture.client.second_request_entered.notified(),
        )
        .await
        .expect("the real second provider request did not start");
        let thread = fixture
            .runtime
            .session_thread_by_root("annotations-session", &accepted.id)
            .await
            .unwrap()
            .unwrap();
        let old_scope = ExecutionScope {
            execution_id: thread.id.clone(),
            generation: thread.generation,
        };
        assert_eq!(thread.kind, ThreadKind::Execution);
        let jobs = fixture.jobs().await;
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].status, ExecutionJobStatus::Succeeded);
        let calls = fixture
            .events(&accepted.id, Some("chat/assistant_call"))
            .await;
        assert_eq!(calls.len(), 1);
        let work = &calls[0];
        let work_records = if annotated {
            assert_lifecycle_work_result_rejected(work, &old_scope)
        } else {
            vec![]
        };
        let updated = match fixture
            .runtime
            .control_thread(
                &thread.context_id,
                &thread.id,
                thread.revision,
                ThreadControlAction::Cancel,
                "Synthetic operator cancelled before a model final response",
            )
            .await
            .unwrap()
        {
            ThreadMutation::Updated(updated) => updated,
            other => {
                panic!("actual Runtime cancellation did not update its owned Thread: {other:?}")
            }
        };
        assert_eq!(updated.lifecycle, ThreadLifecycle::Cancelled);
        assert_eq!(updated.generation, thread.generation + 1);
        assert_eq!(updated.response_annotations, protocol);
        let detail = tokio::time::timeout(Duration::from_secs(25), async {
            loop {
                let detail = fixture.runtime.thread_detail(&thread.context_id, &thread.id).await.unwrap().unwrap();
                if fixture.client.cancelled_request_drops.load(Ordering::SeqCst) == 1
                    && detail.snapshot.activations.iter().all(|snapshot| snapshot.activation.status.is_terminal())
                    && detail.model_attempt_events.iter().any(|event| event.topic == "runtime/model_attempt_state" && event.payload["state"] == "cancelled") {
                    break detail;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await.expect("Runtime cancellation did not drop the actual native model future and persist its cancellation");
        assert_eq!(detail.snapshot.thread.lifecycle, ThreadLifecycle::Cancelled);
        assert_eq!(detail.snapshot.thread.generation, updated.generation);
        let outcome =
            detail.snapshot.outcome.as_ref().expect(
                "operator cancellation must own a durable Runtime Outcome, not a model report",
            );
        assert_eq!(outcome.terminal_kind, ThreadLifecycle::Cancelled);
        let terminal = fixture
            .store
            .query(QueryFilter {
                event_id: Some(outcome.result_event_id.clone()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(terminal.len(), 1);
        assert_eq!(terminal[0].sequence, outcome.terminal_event_sequence);
        let events = fixture.events(&accepted.id, None).await;
        assert_eq!(
            events
                .iter()
                .filter(|event| event.topic == "chat/assistant_call")
                .count(),
            1,
            "the cancelled provider never authored another assistant response"
        );
        assert!(!events.iter().any(|event| matches!(
            event.topic.as_str(),
            "chat/reply" | "chat/no_reply" | "runtime/thread_waiting"
        )));
        assert!(!events
            .iter()
            .any(|event| event.topic == "chat/assistant_call"
                && event.payload.get("terminal_outcome") == Some(&json!(true))));
        assert_eq!(
            fixture
                .events(&accepted.id, Some("chat/assistant_call"))
                .await[0],
            *work,
            "cancellation must not retroactively rewrite committed model annotations"
        );
        if annotated {
            // The old-generation Outcome is a real Store fact. Project it as
            // cancelled, independently of the newer live Thread fence.
            let historical = project_execution(
                &ExecutionFact {
                    scope: ExecutionScope {
                        execution_id: outcome.thread_id.clone(),
                        generation: outcome.thread_generation,
                    },
                    status: outcome.terminal_kind.as_str().into(),
                    terminal: outcome.terminal_kind.is_terminal(),
                    terminal_sequence: outcome.terminal_event_sequence,
                },
                &work_records,
            );
            assert_eq!(historical.status, "cancelled");
            assert!(historical.progress.is_none() && historical.result.is_none());
            let current = project_execution(
                &ExecutionFact {
                    scope: ExecutionScope {
                        execution_id: detail.snapshot.thread.id.clone(),
                        generation: detail.snapshot.thread.generation,
                    },
                    status: detail.snapshot.thread.lifecycle.as_str().into(),
                    terminal: detail.snapshot.thread.lifecycle.is_terminal(),
                    terminal_sequence: outcome.terminal_event_sequence,
                },
                &work_records,
            );
            assert_eq!(current.status, "cancelled");
            assert!(
                current.title.is_none() && current.progress.is_none() && current.result.is_none(),
                "the new cancellation fence must not reuse stale-generation metadata"
            );
        } else {
            assert!(events
                .iter()
                .all(|event| !event.payload.contains_key(BUNDLE_PAYLOAD_KEY)));
        }
        assert_eq!(fixture.client.calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            fixture
                .client
                .cancelled_request_drops
                .load(Ordering::SeqCst),
            1
        );
        assert_eq!(
            fixture.arguments.lock().unwrap().as_slice(),
            &[json!({"key":"system"})]
        );
        assert_eq!(
            fixture.jobs().await,
            jobs,
            "already-completed physical work and its receipt must not be cancelled or replayed"
        );
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(
            fixture.client.calls.load(Ordering::SeqCst),
            2,
            "Runtime cancellation must not ask the model to write a final summary"
        );
        assert_eq!(
            fixture
                .client
                .cancelled_request_drops
                .load(Ordering::SeqCst),
            1
        );
        assert_eq!(
            fixture
                .events(&accepted.id, Some("chat/assistant_call"))
                .await
                .len(),
            1
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn genuine_scheduled_delivery_yields_without_an_interactive_root_or_extra_request() {
    use morphz::memory::{
        ExecutionJobStatus, NewSchedule, RuntimeTimerKind, RuntimeTimerStatus, ScheduleStatus,
        ScheduleStore, ThreadLifecycle, ThreadPhase, TimerStore,
    };
    use morphz::response_annotations::{project_authorized_events, ExecutionFact};

    let fixture = Fixture::new(Scenario::WorkYield(true), Protocol::On).await;
    let session = fixture
        .runtime
        .get_session("annotations-session")
        .await
        .unwrap()
        .unwrap();
    // The actual Scheduler arms and fires this immediate host-requested
    // schedule. No input Event, Activation, wait Event, or lifecycle is seeded.
    let initial = fixture
        .runtime
        .create_session_schedule(
            &session,
            &fixture.runtime.identity().principal_id,
            morphz::sdk::SessionScheduleRequest {
                response_annotations: None,
                id: "annotations-noninteractive-start".into(),
                intent: "Read the synthetic system on a real scheduled wake".into(),
                model_alias: None,
                reasoning_effort: None,
                not_before: chrono::Utc::now(),
                interval_seconds: None,
                dependency_thread_ids: vec![],
            },
        )
        .await
        .unwrap();
    tokio::time::timeout(
        Duration::from_secs(25),
        fixture.client.second_request_entered.notified(),
    ).await.expect("the genuine scheduled wake did not execute its physical tool and reach the original second request");
    let thread = fixture
        .store
        .get_thread(&initial.thread_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(thread.kind, ThreadKind::Execution);
    assert_eq!(thread.response_annotations, Protocol::On);
    assert_eq!(thread.root_turn_id, initial.source_turn_id);
    let before = fixture.events(&thread.root_turn_id, None).await;
    let due = before
        .iter()
        .find(|event| event.topic == "chat/schedule_due")
        .expect("the real Schedule timer must have committed a due Event");
    assert_eq!(due.actor, "Runtime-Scheduler");
    assert_eq!(due.event_type, morphz::event::TYPE_TOOL_OUTPUT);
    assert!(!morphz::event::is_input_event(due));
    assert!(due.sequence.is_some());
    assert_eq!(due.payload["schedule_id"], initial.id);
    assert_eq!(due.payload["root_turn_id"], thread.root_turn_id);
    assert_eq!(due.payload["scheduled_thread_id"], thread.id);
    assert!(
        !before.iter().any(morphz::event::is_input_event),
        "a genuine scheduled Execution must not be disguised as an interactive user turn"
    );
    assert_eq!(
        fixture
            .runtime
            .inspect_schedule(&initial.id)
            .await
            .unwrap()
            .unwrap()
            .status,
        ScheduleStatus::Dispatched
    );
    let jobs = fixture.jobs().await;
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].thread_id, thread.id);
    assert_eq!(jobs[0].tool_name, "annotation_probe");
    assert_eq!(jobs[0].status, ExecutionJobStatus::Succeeded);
    // Only this future pending Schedule is host-authored through the real
    // Store. The Runtime itself must select progress/wait, persist its source,
    // arm its Timer, and settle the actual owning Activation.
    let pending = fixture
        .store
        .ensure_schedule(NewSchedule {
            reasoning_effort: None,
            id: "annotations-noninteractive-pending".into(),
            thread_id: thread.id.clone(),
            source_turn_id: thread.root_turn_id.clone(),
            intent: "Synthetic follow-up, not due during this test".into(),
            model_alias: None,
            not_before: Some(chrono::Utc::now() + chrono::Duration::hours(24)),
            interval_seconds: None,
            dependency_thread_ids: vec![],
        })
        .await
        .unwrap();
    assert_eq!(pending.status, ScheduleStatus::Queued);
    fixture.client.release_second_response.notify_one();
    let (waiting, detail) = tokio::time::timeout(Duration::from_secs(25), async {
        loop {
            let events = fixture.events(&thread.root_turn_id, None).await;
            if let Some(waiting) = events
                .iter()
                .find(|event| event.topic == "runtime/thread_waiting")
            {
                let detail = fixture
                    .runtime
                    .thread_detail(&thread.context_id, &thread.id)
                    .await
                    .unwrap()
                    .unwrap();
                if detail.snapshot.phase == ThreadPhase::Waiting
                    && detail
                        .snapshot
                        .activations
                        .iter()
                        .all(|snapshot| snapshot.activation.status.is_terminal())
                {
                    break (waiting.clone(), detail);
                }
            }
            assert!(
                !events.iter().any(|event| matches!(
                    event.topic.as_str(),
                    "runtime/response_protocol_error" | "runtime/response_protocol_fused"
                )),
                "valid delivery plus a real pending Schedule must not need protocol correction"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("genuine noninteractive delivery did not select and durably settle normal yield");
    assert_eq!(detail.snapshot.thread.lifecycle, ThreadLifecycle::Open);
    let display = detail.snapshot.response_annotations.as_ref().unwrap();
    assert_eq!(display.title.as_deref(), Some("检查合成环境"));
    assert_eq!(display.progress.as_deref(), Some("读取系统"));
    assert!(
        display.result.is_none(),
        "a delivered candidate while waiting cannot establish a terminal result"
    );
    assert_eq!(display.steps.len(), 1);
    assert_eq!(display.steps[0].job_id, jobs[0].id);
    assert_eq!(detail.snapshot.thread.generation, thread.generation);
    assert!(detail.snapshot.outcome.is_none());
    assert!(
        detail
            .snapshot
            .activations
            .iter()
            .any(|snapshot| snapshot.activation.trigger_event_id == due.id),
        "the actual scheduled Event must own an Activation in this Execution"
    );
    let activation_id = waiting.payload["activation_id"].as_str().unwrap();
    let owner = detail
        .snapshot
        .activations
        .iter()
        .find(|snapshot| snapshot.activation.id == activation_id)
        .unwrap();
    assert_eq!(owner.activation.status, ThreadActivationStatus::Succeeded);
    assert_eq!(owner.activation.generation, thread.generation);
    assert_eq!(waiting.id, format!("call_{activation_id}_final"));
    assert_eq!(waiting.payload["thread_id"], thread.id);
    assert_eq!(waiting.payload["thread_generation"], thread.generation);
    assert_eq!(waiting.payload["response_annotations"], "on");
    assert_eq!(waiting.payload["model_disposition"], "deliver");
    assert_eq!(waiting.payload["wait_source"], "runtime_default");
    assert_eq!(waiting.payload["pending_schedules"], 1);
    assert_eq!(waiting.payload["text"], FINAL_TEXT);
    assert!(waiting.payload["tool_calls"].as_array().unwrap().is_empty());
    assert_ne!(waiting.payload.get("terminal_outcome"), Some(&json!(true)));
    let scope = ExecutionScope {
        execution_id: thread.id.clone(),
        generation: thread.generation,
    };
    let bundle: PersistedAnnotations =
        serde_json::from_value(waiting.payload[BUNDLE_PAYLOAD_KEY].clone()).unwrap();
    assert_eq!(bundle.scope, scope);
    assert!(bundle.raw_response.content.is_empty());
    assert_eq!(bundle.raw_response.tool_calls.len(), 1);
    assert_eq!(bundle.raw_response.tool_calls[0].func_name, "reply");
    let original: Value =
        serde_json::from_str(&bundle.raw_response.tool_calls[0].arguments).unwrap();
    assert_eq!(original["content"], FINAL_TEXT);
    assert_eq!(
        original["annotations"]["execution"]["result"],
        "已确认合成系统为 Linux；后续任务保持排队"
    );
    let records = records_from_authorized_event(&waiting, &scope).unwrap();
    let result = records
        .iter()
        .find(|record| record.kind == AnnotationKind::Result)
        .unwrap();
    assert_eq!(result.value, "已确认合成系统为 Linux；后续任务保持排队");
    assert!(
        !result.effective,
        "normal yield must not establish a terminal model result"
    );
    assert_eq!(result.source.event_id, waiting.id);
    assert_eq!(result.source.sequence, waiting.sequence);
    let timer = fixture
        .store
        .get_runtime_timer(waiting.payload["wait_timer_id"].as_str().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(timer.kind, RuntimeTimerKind::ThreadWait);
    assert_eq!(timer.status, RuntimeTimerStatus::Pending);
    assert_eq!(timer.owner_id, detail.snapshot.thread.id);
    assert_eq!(timer.payload["activation_id"], activation_id);
    assert_eq!(
        timer.payload["thread_generation"],
        detail.snapshot.thread.generation
    );
    assert_eq!(timer.payload["response_annotations"], "on");
    assert_eq!(
        Some(timer.generation),
        waiting.payload["wait_timer_generation"].as_u64()
    );
    assert!(timer.payload["wait_secs"].as_u64().unwrap() > 0);
    assert!(
        timer.due_at > chrono::Utc::now(),
        "a normal wait keeps a genuine finite fallback Timer"
    );
    let events = fixture.events(&thread.root_turn_id, None).await;
    assert_eq!(
        events
            .iter()
            .filter(|event| event.topic == "chat/progress"
                && event.payload.get("text") == Some(&json!(FINAL_TEXT)))
            .count(),
        1
    );
    assert!(!events
        .iter()
        .any(|event| matches!(event.topic.as_str(), "chat/reply" | "chat/no_reply")));
    let projection = project_authorized_events(
        &ExecutionFact {
            scope,
            status: detail.snapshot.thread.lifecycle.as_str().into(),
            terminal: detail.snapshot.thread.lifecycle.is_terminal(),
            terminal_sequence: None,
        },
        &events,
    )
    .unwrap();
    assert_eq!(projection.status, "open");
    assert_eq!(projection.title.as_deref(), Some("检查合成环境"));
    assert!(projection.result.is_none());
    assert_eq!(fixture.client.calls.load(Ordering::SeqCst), 2);
    assert_eq!(fixture.client.captured.lock().unwrap().len(), 2);
    assert_eq!(
        fixture.arguments.lock().unwrap().as_slice(),
        &[json!({"key":"system"})]
    );
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(
        fixture.client.calls.load(Ordering::SeqCst),
        2,
        "normal scheduled yield cannot add a title or summary request"
    );
    assert_eq!(fixture.jobs().await, jobs);
    assert_eq!(
        fixture.store.get_schedule(&pending.id).await.unwrap(),
        Some(pending)
    );
    assert_eq!(
        fixture.store.get_runtime_timer(&timer.id).await.unwrap(),
        Some(timer)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn enabled_final_reply_persists_required_metadata_in_original_requests_and_native_stream() {
    for (scenario, expected_calls, expected_jobs) in [
        (Scenario::ReplyOnly, 1, 0),
        (Scenario::TextReply, 1, 0),
        (Scenario::StrictWorkReply, 2, 1),
    ] {
        let fixture = Fixture::new(scenario, Protocol::Off).await;
        let mut stream = fixture.runtime.subscribe("runtime/model_stream", 512);
        let (accepted, reply) = fixture.submit(Some(Protocol::On)).await;
        assert_eq!(reply.payload["text"], FINAL_TEXT);
        assert_eq!(fixture.client.calls.load(Ordering::SeqCst), expected_calls);
        assert_eq!(
            fixture.jobs().await.len(),
            expected_jobs,
            "reply is never a physical Job"
        );
        let thread = fixture
            .runtime
            .session_thread_by_root("annotations-session", &accepted.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(thread.response_annotations, Protocol::On);
        assert_eq!(thread.lifecycle, morphz::memory::ThreadLifecycle::Completed);
        let projection = fixture
            .runtime
            .session_thread_annotations("annotations-context", "annotations-session", &thread.id)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(projection.protocol, Protocol::On);
        assert_eq!(projection.title.as_deref(), Some("检查合成环境"));
        assert!(projection.result.is_some());
        let events = fixture
            .events(&accepted.id, Some("chat/assistant_call"))
            .await;
        assert_eq!(events.len(), expected_calls);
        let final_source = events
            .iter()
            .find(|event| event.payload.get("terminal_outcome") == Some(&json!(true)))
            .unwrap();
        let scope = ExecutionScope {
            execution_id: thread.id.clone(),
            generation: thread.generation,
        };
        let bundle: PersistedAnnotations =
            serde_json::from_value(final_source.payload[BUNDLE_PAYLOAD_KEY].clone()).unwrap();
        assert_eq!(bundle.protocol, Protocol::On);
        assert!(bundle
            .records
            .iter()
            .all(|record| record.protocol == Protocol::On));
        assert!(bundle
            .records
            .iter()
            .any(|record| record.kind == AnnotationKind::Title));
        assert!(bundle
            .records
            .iter()
            .any(|record| record.kind == AnnotationKind::Result));
        if matches!(scenario, Scenario::TextReply) {
            assert!(bundle.raw_response.tool_calls.is_empty());
            let envelope: Value = serde_json::from_str(&bundle.raw_response.content).unwrap();
            assert_eq!(envelope["content"], FINAL_TEXT);
            assert!(envelope["annotations"]["execution"]["title"].is_string());
        } else {
            assert_eq!(bundle.raw_response.tool_calls[0].func_name, "reply");
        }
        assert!(records_from_authorized_event(final_source, &scope)
            .unwrap()
            .iter()
            .all(|record| record.source.sequence == final_source.sequence));
        for request in fixture.client.captured.lock().unwrap().iter() {
            assert!(request
                .messages
                .iter()
                .any(|message| message.role == "system" && message.content.contains(CONTRACT)));
            let schema = &request
                .tools
                .iter()
                .find(|tool| tool.name == "reply")
                .unwrap()
                .parameters;
            assert_eq!(schema["required"], json!(["content", "annotations"]));
            assert_eq!(
                schema["properties"]["annotations"]["properties"]["execution"]["required"],
                json!(["title", "result"])
            );
        }
        let mut public_text = String::new();
        let mut increments = 0;
        while let Ok(event) = stream.try_recv() {
            let value = event.payload["stream"].clone();
            assert!(!value.to_string().contains("annotations"));
            if let Ok(ModelStreamEvent::TextDelta { text }) = serde_json::from_value(value) {
                public_text.push_str(&text);
                increments += 1;
            }
        }
        assert_eq!(public_text, FINAL_TEXT);
        assert!(increments > 1);
        let reopened =
            SqliteStore::new(fixture.temp.path().join("annotations.db").to_str().unwrap())
                .await
                .unwrap();
        assert_eq!(
            reopened
                .get_thread(&thread.id)
                .await
                .unwrap()
                .unwrap()
                .response_annotations,
            Protocol::On
        );
        assert_eq!(
            fixture.client.calls.load(Ordering::SeqCst),
            expected_calls,
            "reading projection does not ask a model"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn enabled_plain_or_invalid_annotations_fail_with_exact_capture_and_no_repair() {
    for scenario in std::iter::once(Scenario::Plain)
        .chain((0..=6).map(Scenario::StrictBadFinal))
        .chain((0..=6).map(Scenario::ImplicitBadFinal))
    {
        let fixture = Fixture::new(scenario, Protocol::Off).await;
        let (root, reply) = fixture.submit(Some(Protocol::On)).await;
        assert_ne!(
            reply.payload["text"], FINAL_TEXT,
            "missing annotations must not masquerade as a successful annotated reply"
        );
        let thread = fixture
            .runtime
            .session_thread_by_root("annotations-session", &root.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(thread.lifecycle, morphz::memory::ThreadLifecycle::Failed);
        assert_eq!(fixture.client.calls.load(Ordering::SeqCst), 1);
        assert!(fixture.jobs().await.is_empty());
        let errors = fixture
            .events(&root.id, Some("runtime/response_protocol_error"))
            .await;
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].payload["response_capture"]["state"], "complete");
        let raw: &Value = &errors[0].payload["response_capture"]["raw_response"];
        assert_eq!(
            fixture
                .events(&root.id, Some("runtime/response_protocol_fused"))
                .await
                .len(),
            1
        );
        assert!(fixture
            .events(&root.id, Some("chat/assistant_call"))
            .await
            .is_empty());
        if let Scenario::StrictBadFinal(case) | Scenario::ImplicitBadFinal(case) = scenario {
            let captured: Response = serde_json::from_value(raw.clone()).unwrap();
            let args: Value = if matches!(scenario, Scenario::ImplicitBadFinal(_)) {
                assert!(captured.tool_calls.is_empty());
                serde_json::from_str(&captured.content).unwrap()
            } else {
                assert!(captured.content.is_empty());
                assert_eq!(captured.tool_calls.len(), 1);
                assert_eq!(captured.tool_calls[0].func_name, "reply");
                serde_json::from_str(&captured.tool_calls[0].arguments).unwrap()
            };
            assert_eq!(args["content"], FINAL_TEXT);
            match case {
                0 => assert!(args.get("annotations").is_none()),
                1 => assert!(args["annotations"].is_null()),
                2 => assert!(args["annotations"]["execution"].is_null()),
                3 => assert!(args["annotations"]["execution"].get("title").is_none()),
                4 => assert!(args["annotations"]["execution"]["title"]
                    .as_str()
                    .unwrap()
                    .trim()
                    .is_empty()),
                5 => assert!(args["annotations"]["execution"]["result"].is_null()),
                6 => assert_eq!(
                    args["annotations"]["execution"]["result"]
                        .as_str()
                        .unwrap()
                        .chars()
                        .count(),
                    513
                ),
                _ => unreachable!(),
            }
        } else {
            assert_eq!(raw["content"], FINAL_TEXT);
            assert_eq!(raw["tool_calls"], json!([]));
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_new_infer_has_scoped_metadata_and_stable_tools_without_extra_requests() {
    let fixture = Fixture::new(Scenario::Infer, Protocol::Off).await;
    let (root, reply) = fixture.submit(Some(Protocol::On)).await;
    assert_eq!(reply.payload["text"], FINAL_TEXT);
    assert_eq!(fixture.client.calls.load(Ordering::SeqCst), 4);
    let captured = fixture.client.captured.lock().unwrap().clone();
    for request in &captured[1..3] {
        assert!(request.tools.iter().any(|tool| tool.name == "reply"));
        assert!(request
            .tools
            .iter()
            .filter(|tool| tool.name != "reply")
            .all(|tool| tool.parameters["properties"].get("_annotations").is_some()));
        assert!(request
            .messages
            .iter()
            .filter(|message| message.role == "system")
            .any(|message| message.content.contains(CONTRACT)));
    }
    assert_eq!(
        serde_json::to_vec(&captured[1].tools).unwrap(),
        serde_json::to_vec(&captured[2].tools).unwrap(),
        "the complete infer tool contract stays byte-identical across physical tool continuations"
    );
    let request = fixture
        .store
        .query(QueryFilter {
            context_id: Some("annotations-context".into()),
            topics: vec!["chat/infer_request".into()],
            latest_k: Some(8),
            ..Default::default()
        })
        .await
        .unwrap()
        .pop()
        .unwrap();
    let child = fixture
        .runtime
        .session_thread_by_root("annotations-session", &request.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(child.response_annotations, Protocol::On);
    let projected = fixture
        .runtime
        .session_thread_annotations("annotations-context", "annotations-session", &child.id)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(projected.title.as_deref(), Some("读取合成系统"));
    assert_eq!(projected.result.as_deref(), Some("系统名称为 Linux"));
    assert_eq!(projected.steps.len(), 1);
    assert_eq!(projected.steps[0].intent.as_deref(), Some("核对系统名称"));
    assert!(fixture
        .runtime
        .session_thread_annotations("annotations-context", "foreign-session", &child.id)
        .await
        .unwrap()
        .is_none());
    let parent = fixture
        .runtime
        .session_thread_by_root("annotations-session", &root.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        child.supervision.parent_thread_id.as_deref(),
        Some(parent.id.as_str())
    );
    let parent_metadata = fixture
        .runtime
        .session_thread_annotations("annotations-context", "annotations-session", &parent.id)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_ne!(
        parent_metadata.title, projected.title,
        "child metadata must not rename the parent work"
    );
    let outputs = fixture.events(&root.id, Some("chat/tool_output")).await;
    assert!(outputs
        .iter()
        .any(|event| event.payload["tool_name"] == "eval" && event.payload["text"] == "\"Linux\""));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn enabled_no_reply_silent_preserves_grammar_without_required_final_metadata() {
    let fixture = Fixture::new(Scenario::NoReplySilent(true), Protocol::Off).await;
    let accepted = fixture
        .session
        .send_io_as_principal(Fixture::input(Some(Protocol::On)), "principal-default")
        .await
        .unwrap();
    let thread = tokio::time::timeout(Duration::from_secs(25), async {
        loop {
            if let Some(thread) = fixture
                .runtime
                .session_thread_by_root("annotations-session", &accepted.id)
                .await
                .unwrap()
            {
                if thread.lifecycle.is_terminal() {
                    break thread;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(thread.response_annotations, Protocol::On);
    assert_eq!(thread.lifecycle, morphz::memory::ThreadLifecycle::Completed);
    assert_eq!(fixture.client.calls.load(Ordering::SeqCst), 2);
    assert_eq!(fixture.jobs().await.len(), 1);
    assert!(fixture
        .events(&accepted.id, Some("runtime/response_protocol_error"))
        .await
        .is_empty());
    let projected = fixture
        .runtime
        .session_thread_annotations("annotations-context", "annotations-session", &thread.id)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(projected.protocol, Protocol::On);
    assert!(projected.result.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn schedule_annotation_override_is_frozen_and_none_keeps_legacy_retry_fingerprint() {
    let fixture = Fixture::construct(Scenario::Plain, Protocol::Off, false).await;
    let session = fixture
        .runtime
        .get_session("annotations-session")
        .await
        .unwrap()
        .unwrap();
    let request = morphz::sdk::SessionScheduleRequest {
        response_annotations: None,
        id: "annotation-schedule-legacy".into(),
        intent: "Synthetic future work".into(),
        model_alias: None,
        reasoning_effort: None,
        not_before: chrono::Utc::now() + chrono::Duration::days(1),
        interval_seconds: None,
        dependency_thread_ids: vec![],
    };
    assert!(serde_json::to_value(&request)
        .unwrap()
        .get("response_annotations")
        .is_none());
    let legacy = fixture
        .runtime
        .create_session_schedule(&session, "principal-default", request.clone())
        .await
        .unwrap();
    assert_eq!(
        fixture
            .store
            .get_thread(&legacy.thread_id)
            .await
            .unwrap()
            .unwrap()
            .response_annotations,
        Protocol::Off
    );
    let mut explicit = request.clone();
    explicit.id = "annotation-schedule-on".into();
    explicit.response_annotations = Some(Protocol::On);
    let enabled = fixture
        .runtime
        .create_session_schedule(&session, "principal-default", explicit.clone())
        .await
        .unwrap();
    let owner = fixture
        .store
        .get_thread(&enabled.thread_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(owner.response_annotations, Protocol::On);
    assert_eq!(
        fixture
            .runtime
            .create_session_schedule(&session, "principal-default", explicit.clone())
            .await
            .unwrap(),
        enabled
    );
    explicit.response_annotations = Some(Protocol::Off);
    assert!(fixture
        .runtime
        .create_session_schedule(&session, "principal-default", explicit)
        .await
        .is_err());
    assert_eq!(
        fixture
            .store
            .get_thread(&enabled.thread_id)
            .await
            .unwrap()
            .unwrap(),
        owner
    );
    // A hot operator toggle changes only subsequent schedule admissions. The
    // prior omitted-choice command retains its exact accepted owner on retry.
    assert!(fixture
        .runtime
        .set_default_response_annotations(
            Protocol::On,
            Protocol::Off,
            &fixture.temp.path().join("setting.toml")
        )
        .unwrap());
    assert_eq!(
        fixture
            .runtime
            .create_session_schedule(&session, "principal-default", request.clone())
            .await
            .unwrap(),
        legacy
    );
    let mut hot = request.clone();
    hot.id = "annotation-schedule-hot-default".into();
    let hot = fixture
        .runtime
        .create_session_schedule(&session, "principal-default", hot)
        .await
        .unwrap();
    assert_eq!(
        fixture
            .store
            .get_thread(&hot.thread_id)
            .await
            .unwrap()
            .unwrap()
            .response_annotations,
        Protocol::On
    );
    assert_eq!(
        fixture
            .store
            .get_thread(&legacy.thread_id)
            .await
            .unwrap()
            .unwrap()
            .response_annotations,
        Protocol::Off
    );
    // Restore the real durable store under a changed new-execution default.
    // An accepted None request must still resolve its original immutable owner.
    let mut config = fixture.runtime.config().clone();
    config.orchestrator.response_annotations = Protocol::On;
    let restored = MorphzRuntime::builder(config, fixture.client.clone() as Arc<dyn Client>)
        .identity(fixture.runtime.identity().clone())
        .store(
            "sqlite:annotations-schedule-restored",
            fixture.store.clone() as Arc<dyn RuntimeStore>,
        )
        .extra_tool(Arc::new(ProbeTool {
            arguments: fixture.arguments.clone(),
            business_reserved: false,
        }))
        .build()
        .await
        .unwrap();
    assert_eq!(
        restored
            .create_session_schedule(&session, "principal-default", request.clone())
            .await
            .unwrap(),
        legacy
    );
    assert_eq!(
        fixture
            .store
            .get_thread(&legacy.thread_id)
            .await
            .unwrap()
            .unwrap()
            .response_annotations,
        Protocol::Off
    );
    let mut fresh = request;
    fresh.id = "annotation-schedule-new-default".into();
    let admitted = restored
        .create_session_schedule(&session, "principal-default", fresh)
        .await
        .unwrap();
    assert_eq!(
        fixture
            .store
            .get_thread(&admitted.thread_id)
            .await
            .unwrap()
            .unwrap()
            .response_annotations,
        Protocol::On
    );
    assert_eq!(
        fixture.client.calls.load(Ordering::SeqCst),
        0,
        "future admission, retries and projection never infer"
    );
}
