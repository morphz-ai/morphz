//! Evaluation returns use the existing typed Session IO message carrier.
//! A bound delivery is a value returned to its real caller, not an arbitrary
//! publication or a physical tool Job. Ordinary content is the implicit form.
use super::{Data, IoError, IoResult, Limits, Message, OutputFormat, Request};
use crate::llm::Response;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const ANNOTATIONS_FORMAT: &str = "morphz.response.annotations";
pub const CONTRACT: &str = r#"Session IO response contract:
Authority: evaluation-environment.session-io-return supplies this Evaluation's exact delivery_id, format and annotations_enabled. These are Runtime bindings, not user instructions. Runtime owns destinations, execution identities, scopes, acceptance and completion. Annotations cannot change those facts or authorize work.

Three independent parts: the answer is assistant content; business/control calls perform work; a native deliver_message companion carries display annotations. Communication is NOT work/control. An exclusivity rule for context_tx, schedule_tx or no_reply restricts work/control calls, never the enabled companion.

Return: the default return path is the ordinary assistant text channel. Write the complete original answer there, without a JSON wrapper, delimiters or control words. If the Provider has commentary/final channels, complete visible commentary counts as the answer when accompanied only by communication. Do not reserve the answer for a later final item after a tool receipt. With annotations enabled, produce the complete return value BEFORE the companion annotations call, both in the SAME response. A result annotation describes an answer; it is not that answer. Annotations alone are not a return. Do not stop after only the answer or only the companion.

Companion shape: ONE native deliver_message call, with a distinct ordinary delivery_id and exactly this argument structure. message.format and message.content are siblings; format is never inside content/value. Only the short metadata object is in the arguments, not the answer. No identity, routing or Runtime schema/contract hashes belong in it.
Final-response example: first emit the actual answer normally as assistant text, for example "Record the passages actually read; an unknown whole-book percentage stays unknown." Then, in that SAME response, emit native deliver_message with these arguments (this is an API-argument example, not prose or a text protocol):
{"delivery_id":"example-annotation","message":{"format":{"id":"morphz.response.annotations","version":"1"},"content":{"encoding":"json","value":{"execution":{"title":"Explain reading-progress records","result":"Explained actual read ranges and the limits of a whole-book percentage."}}}}}
For real answers use a truthful whole-task title and nonempty result. For an intermediate working response, include the work/control calls and the same companion without a final answer or a premature result. A complete working companion example for a work call at index 0 is:
{"delivery_id":"example-work-annotation","message":{"format":{"id":"morphz.response.annotations","version":"1"},"content":{"encoding":"json","value":{"execution":{"title":"Record reading progress","progress":"Saving the actual read range."},"calls":[{"index":0,"intent":"Save the observed read range for accurate continuation."}]}}}}

Steps: with annotations_enabled=true, EVERY actual work/control call, including recall, context_tx and delegation, needs exactly one calls entry in that SAME response. index is the zero-based position in the complete native call array, including communication positions; annotate only work/control calls, never communication or no_reply. Call indexes are local to the current response. Never repeat an earlier call's intent in the final answer; when no work is called, omit calls or use calls:[]. The title describes the entire current Execution; progress describes current work and result describes the actual returned outcome, not physical completion authority.

Observations: when relying on a supplied result of this Execution's work, include observations:[{ref:"actual supplied result ref",result:"what it establishes"}] in that companion. Only actual tool_output/result observations are eligible, not an agent_call proposal, user input, parent input or another Execution's background result. Never invent a ref or a future result. Readable Context is not proof that an observation is this Execution's work result.

Business types: the actual caller's value contract takes precedence over an embedded conversation. In internal-infer execute the complete Yao BODY and return its complete declared value as assistant content, preserving its required business JSON transport/schema. A Bool is exactly false/true; a record remains the whole record, never only its reply/text field. The parent Plan performs declared projections deterministically. Annotations stay outside that business value. Business-effect limits do not disable Session IO: a pure infer, empty (requires (tools)) or no-external-tools instruction still permits enabled companion communication. A body-only type rule limits the body, not that independent message.

Explicit equivalent: if choosing native Session IO to return the SAME value, use the Runtime-bound delivery_id and message.format={id:binding.format.id,version:binding.format.version}, with encoding in message.content. Put an utf8 body in content.value; for morphz.chat/json put it in content.value.text. That leaf is the complete original value, not an extra business wrapper. Native arguments use normal JSON encoding. Write routing/format before the body so it can stream. Return and companion must both be in this response; do not mix a bound return with work/control calls. Other delivery IDs remain nonterminal publications. Ordinary prose never requires this explicit alternative merely because annotations are on.

Off/termination: when annotations_enabled=false, omit the companion, not the body. Tool names, schemas and order stay the same; do not add metadata to business-tool arguments. Intentional no_reply has no body and is the only work/control call, but may accompany enabled metadata. A complete return plus communication ends after validation without another model request. Real work results may need normal continuation; communication receipts never need a second request to compose an answer. Never make another call or model request solely to repair display metadata. Progress/annotations alone cannot finish work or satisfy a parent Objective."#;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReturnBinding {
    pub delivery_id: String,
    pub format: OutputFormat,
    pub annotations_enabled: bool,
}
impl ReturnBinding {
    pub(crate) fn expression(&self) -> crate::sexpr::SExpr {
        use crate::sexpr::SExpr::{Atom, List};
        let pair = |name: &str, value: String| List(vec![Atom(name.into()), Atom(value)]);
        List(vec![
            Atom("session-io-return".into()),
            pair("delivery_id", self.delivery_id.clone()),
            List(vec![
                Atom("format".into()),
                pair("id", self.format.id.clone()),
                pair("version", self.format.version.clone()),
                pair("encoding", self.format.encoding.clone()),
            ]),
            pair("annotations_enabled", self.annotations_enabled.to_string()),
        ])
    }
    pub fn new(thread: &str, generation: u64, evaluation: &str, enabled: bool) -> Self {
        let digest = super::hash(&(thread, generation, evaluation));
        Self {
            delivery_id: format!("return_{}", digest.trim_start_matches("sha256:")),
            format: OutputFormat::chat(),
            annotations_enabled: enabled,
        }
    }
    pub fn with_formats(mut self, formats: &[super::FormatBinding]) -> Self {
        // Preserve the admitted encoding/definition rather than replacing a
        // frozen client contract with a new process default.
        if let Some(format) = formats
            .iter()
            .find(|binding| binding.format.id == "morphz.chat" && binding.format.encoding == "utf8")
            .or_else(|| {
                formats
                    .iter()
                    .find(|binding| binding.format.id == "morphz.chat")
            })
        {
            self.format = format.format.clone();
        }
        self
    }
}

#[derive(Debug, Clone)]
pub struct Delivery {
    pub delivery_id: String,
    pub message: Message,
}
pub fn parse_delivery(arguments: &str, limits: &Limits) -> IoResult<Delivery> {
    let tree = Data::parse(arguments.as_bytes(), limits)?;
    let fields = tree.object()?;
    if fields.len() != 2 || !fields.contains_key("delivery_id") || !fields.contains_key("message") {
        return Err(IoError::new(
            "invalid_content_syntax",
            "Only delivery_id and message are accepted",
        ));
    }
    let delivery_id = tree
        .get("delivery_id")
        .and_then(Data::string)
        .filter(|id| !id.is_empty() && id.len() <= 160)
        .ok_or_else(|| IoError::new("invalid_content_syntax", "Invalid delivery_id"))?
        .to_owned();
    let message = tree.get("message").expect("checked message field");
    let wire = format!(
        "{{\"io_version\":\"1\",\"client_message_id\":\"output-parser\",\"message\":{}}}",
        message.json()
    );
    Ok(Delivery {
        delivery_id,
        message: Request::parse(wire.as_bytes(), limits)?.message,
    })
}

#[derive(Debug, Clone)]
pub struct ResponseParts {
    pub response: Response,
    pub body_message: Option<Message>,
    pub annotation_messages: Vec<Delivery>,
    pub diagnostics: Vec<String>,
}

/// Split typed carriers, never inspect or rewrite business prose. This also
/// runs with annotations disabled: return semantics are not an annotation mode.
pub fn split_response(response: &Response, binding: &ReturnBinding) -> IoResult<ResponseParts> {
    let mut parts = ResponseParts {
        response: response.clone(),
        body_message: None,
        annotation_messages: vec![],
        diagnostics: vec![],
    };
    let mut remaining = Vec::new();
    let mut malformed = Vec::new();
    for call in &response.tool_calls {
        if call.func_name != "deliver_message" {
            remaining.push(call.clone());
            continue;
        }
        let delivery = match parse_delivery(&call.arguments, &Limits::default()) {
            Ok(delivery) => delivery,
            Err(error) => {
                let annotation_only = Data::parse(call.arguments.as_bytes(), &Limits::default())
                    .ok()
                    .is_some_and(|tree| {
                        tree.get("message")
                            .and_then(|m| m.get("format"))
                            .and_then(|f| f.get("id"))
                            .and_then(Data::string)
                            == Some(ANNOTATIONS_FORMAT)
                            && tree.get("delivery_id").and_then(Data::string)
                                != Some(binding.delivery_id.as_str())
                    });
                if annotation_only {
                    parts.diagnostics.push(error.to_string());
                } else {
                    malformed.push((call.clone(), error.to_string()));
                }
                continue;
            }
        };
        if delivery.delivery_id == binding.delivery_id {
            if parts.body_message.is_some() {
                return Err(IoError::new(
                    "ambiguous_return",
                    "More than one bound return was supplied",
                ));
            }
            if delivery.message.format.id != binding.format.id
                || delivery.message.format.version != binding.format.version
                || delivery.message.content.encoding() != binding.format.encoding
            {
                return Err(IoError::new(
                    "invalid_delivery_contract",
                    "Bound return does not match its admitted format",
                ));
            }
            let registry = super::Registry::default();
            let registered = registry.resolve(
                &binding.format.format(),
                delivery.message.content.encoding(),
                "registered",
            )?;
            super::validate_content(&delivery.message, &registered, &Limits::default())?;
            if let super::Content::Json { value } = &delivery.message.content {
                for key in ["attachments", "references"] {
                    if value.get(key).is_some_and(
                        |value| !matches!(value, Data::Array(items) if items.is_empty()),
                    ) {
                        return Err(IoError::new("invalid_delivery_contract", "The text return cannot implicitly import resources; deliver those through the existing authorized resource path"));
                    }
                }
            }
            let text = delivery.message.summary();
            if text.trim().is_empty() {
                return Err(IoError::new(
                    "invalid_delivery_contract",
                    "The bound return has no body",
                ));
            }
            if !response.content.trim().is_empty() && response.content != text {
                return Err(IoError::new(
                    "ambiguous_return",
                    "Explicit and implicit returns contain different bodies",
                ));
            }
            parts.response.content = text;
            parts.body_message = Some(delivery.message);
        } else if delivery.message.format.id == ANNOTATIONS_FORMAT {
            let registry = super::Registry::default();
            let valid = registry
                .resolve(
                    &delivery.message.format,
                    delivery.message.content.encoding(),
                    "registered",
                )
                .and_then(|format| {
                    super::validate_content(&delivery.message, &format, &Limits::default())
                });
            if valid.is_err() {
                parts
                    .diagnostics
                    .push("Annotations message does not match the registered format".into());
            } else if !binding.annotations_enabled {
                parts
                    .diagnostics
                    .push("Annotations were not enabled for this Evaluation".into());
            } else {
                parts.annotation_messages.push(delivery);
            }
        } else {
            remaining.push(call.clone());
        }
    }
    // Invalid companion IO cannot invalidate an independently valid return.
    // Its content is NOT guessed or dispatched. Required business deliveries
    // remain checked by the original admitted output contract at commit.
    if !parts.response.content.trim().is_empty() && remaining.is_empty() {
        parts
            .diagnostics
            .extend(malformed.into_iter().map(|(_, error)| error));
    } else if let Some((_, error)) = malformed.first() {
        return Err(IoError::new("invalid_delivery_contract", error.clone()));
    }
    if parts.body_message.is_some() && !remaining.is_empty() {
        return Err(IoError::new(
            "ambiguous_return",
            "A bound return cannot accompany work or control calls",
        ));
    }
    if parts.annotation_messages.len() > 1 {
        parts.diagnostics.push(
            "More than one annotations message was supplied; ambiguous metadata ignored".into(),
        );
        parts.annotation_messages.clear();
    }
    if remaining.is_empty()
        && parts.response.content.trim().is_empty()
        && response
            .tool_calls
            .iter()
            .any(|call| call.func_name == "deliver_message")
    {
        return Err(IoError::new(
            "invalid_delivery_contract",
            "Annotations alone are not an answer",
        ));
    }
    parts.response.tool_calls = remaining;
    Ok(parts)
}

pub fn annotations_value(message: &Message) -> Option<Value> {
    if let super::Content::Json { value } = &message.content {
        serde_json::from_str(&value.json()).ok()
    } else {
        None
    }
}

pub fn annotations_descriptor() -> super::Descriptor {
    super::Descriptor {
        id: ANNOTATIONS_FORMAT.into(), version: "1".into(), encodings: vec!["json".into()],
        schema: Some(crate::response_annotations::annotation_schema()),
        contract: Some("Display-only companion metadata for its actual producing Evaluation. Never execution state, authority, or proof of physical success.".into()),
        publisher: "morphz".into(), required_visible_paths: vec![], resource_paths: vec![],
    }
}

/// Materialize the actual typed companion in the SAME transaction as its
/// immutable model-response source. This is neither a new input nor a wakeup.
/// The source supplies every identity; no identity is read from model content.
pub(crate) fn is_annotation_call_arguments(arguments: &str) -> bool {
    Data::parse(arguments.as_bytes(), &Limits::default())
        .ok()
        .is_some_and(|tree| {
            tree.get("message")
                .and_then(|message| message.get("format"))
                .and_then(|format| format.get("id"))
                .and_then(Data::string)
                == Some(ANNOTATIONS_FORMAT)
        })
}
pub(crate) fn companion_events(source: &crate::event::Event) -> Vec<crate::event::Event> {
    use crate::response_annotations::{PersistedAnnotations, BUNDLE_PAYLOAD_KEY};
    if source.topic != "chat/assistant_call" || source.event_type != crate::event::TYPE_AGENT_CALL {
        return vec![];
    }
    let Some(raw) = source.payload.get(BUNDLE_PAYLOAD_KEY) else {
        return vec![];
    };
    let Ok(bundle) = serde_json::from_value::<PersistedAnnotations>(raw.clone()) else {
        return vec![];
    };
    if source.payload.get("thread_id").and_then(Value::as_str)
        != Some(bundle.scope.execution_id.as_str())
        || source
            .payload
            .get("thread_generation")
            .and_then(Value::as_u64)
            != Some(bundle.scope.generation)
        || source
            .payload
            .get("model_attempt_id")
            .and_then(Value::as_str)
            .is_none()
    {
        return vec![];
    }
    let Some(binding) = bundle.return_binding.as_ref() else {
        return vec![];
    };
    let Some(evaluation) = source.payload.get("activation_id").and_then(Value::as_str) else {
        return vec![];
    };
    let expected = ReturnBinding::new(
        &bundle.scope.execution_id,
        bundle.scope.generation,
        evaluation,
        !bundle.protocol.is_off(),
    );
    if binding.delivery_id != expected.delivery_id
        || binding.annotations_enabled != expected.annotations_enabled
        || source
            .payload
            .get("response_annotations")
            .and_then(Value::as_str)
            != Some(bundle.protocol.as_str())
    {
        return vec![];
    }
    let registry = super::Registry::default();
    bundle.raw_response.tool_calls.iter().enumerate().filter_map(|(index,call)|{
        if call.func_name!="deliver_message" || !is_annotation_call_arguments(&call.arguments){return None;}
        let delivery=parse_delivery(&call.arguments,&Limits::default()).ok();
        let format=delivery.as_ref().and_then(|delivery|registry.resolve(&delivery.message.format,delivery.message.content.encoding(),"registered").ok());
        let accepted=!bundle.protocol.is_off() && delivery.as_ref().is_some_and(|delivery|
            bundle.annotation_messages.contains(&delivery.message) && format.as_ref().is_some_and(|format|
                super::validate_content(&delivery.message,format,&Limits::default()).is_ok()));
        let digest=super::hash(&(&source.id,index));
        let id=format!("io_annotations_{}",digest.trim_start_matches("sha256:"));
        let mut payload=serde_json::Map::new();
        for key in ["context_id","session_id","principal_id","root_turn_id","thread_id","thread_generation","activation_id","attempt_id","model_attempt_id","model_output_visibility","trigger_event_id","objective_id"] {
            if let Some(value)=source.payload.get(key){payload.insert(key.into(),value.clone());}
        }
        payload.insert("source_event_id".into(),json!(source.id));
        payload.insert("output_id".into(),json!(id));
        if let Some(delivery)=&delivery{payload.insert("delivery_id".into(),json!(delivery.delivery_id));}
        payload.insert("tool_call_id".into(),json!(call.id));
        payload.insert("tool_name".into(),json!("deliver_message"));
        payload.insert("tool_status".into(),json!(if accepted{"success"}else{"error"}));
        payload.insert("wake_policy".into(),json!("none"));
        if accepted {
            payload.insert("io_message".into(),json!(delivery.as_ref().unwrap().message));
            payload.insert("io_format_binding".into(),json!(format));
        }
        if let Some(binding)=&bundle.return_binding{payload.insert("target_delivery_id".into(),json!(binding.delivery_id));}
        payload.insert("text".into(),json!(json!({"status":if accepted{"committed"}else{"rejected"},"output_id":id,"execution_complete":false}).to_string()));
        let mut event=crate::event::Event::new(id,source.actor.clone(),crate::event::TYPE_TOOL_OUTPUT.into(),
            if accepted{"session/io_output"}else{"runtime/io_receipt"}.into(),payload);
        event.timestamp=source.timestamp;
        Some(event)
    }).collect()
}

pub(crate) fn is_annotations_event(event: &crate::event::Event) -> bool {
    event.topic == "runtime/io_receipt"
        || (event.topic == "session/io_output"
            && event
                .payload
                .get("io_message")
                .and_then(|message| message.get("format"))
                .and_then(|format| format.get("id"))
                .and_then(Value::as_str)
                == Some(ANNOTATIONS_FORMAT))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::ToolCallRepr;
    use serde_json::json;
    fn binding() -> ReturnBinding {
        ReturnBinding::new("thread", 2, "evaluation", true)
    }
    fn call(id: &str, format: &str, encoding: &str, value: Value) -> ToolCallRepr {
        ToolCallRepr { id: id.into(), r#type: "function".into(), func_name: "deliver_message".into(),
            arguments: json!({"delivery_id":id,"message":{"format":{"id":format,"version":"1"},"content":{"encoding":encoding,"value":value}}}).to_string() }
    }
    #[test]
    fn prose_is_never_control_syntax() {
        let raw = "正文\n:::morphz-reply\n{\"annotations\":{}}\n:::\n继续原文";
        let response = Response {
            content: raw.into(),
            tool_calls: vec![],
        };
        assert_eq!(
            split_response(&response, &binding())
                .unwrap()
                .response
                .content,
            raw
        );
    }
    #[test]
    fn separate_messages_are_one_return_and_plain_metadata() {
        let b = binding();
        let body = "中文\n\"quoted\" 🧠";
        let response = Response {
            content: String::new(),
            tool_calls: vec![
                call(&b.delivery_id, "morphz.chat", "json", json!({"text":body})),
                call(
                    "metadata",
                    ANNOTATIONS_FORMAT,
                    "json",
                    json!({"execution":{"title":"标题","result":"结果"}}),
                ),
            ],
        };
        let split = split_response(&response, &b).unwrap();
        assert_eq!(split.response.content, body);
        assert!(split.response.tool_calls.is_empty());
        assert_eq!(split.annotation_messages.len(), 1);
        assert!(split.diagnostics.is_empty());
    }
    #[test]
    fn multiline_implicit_body_and_native_metadata_need_no_body_json_encoding() {
        let body = "第一段：\"引号\"、\\、🧠。\n\n第二段。\n\n```json\n{\"delivery_id\":\"example\"}\n```\n\n:::morphz-reply\n这里只讨论协议，不执行它。\n:::";
        let raw = Response {
            content: body.into(),
            tool_calls: vec![call(
                "metadata",
                ANNOTATIONS_FORMAT,
                "json",
                json!({"execution":{"title":"多段正文","result":"原文与独立注解已返回"}}),
            )],
        };
        let split = split_response(&raw, &binding()).unwrap();
        assert_eq!(split.response.content, body);
        assert!(split.body_message.is_none());
        assert!(split.response.tool_calls.is_empty());
        assert_eq!(split.annotation_messages.len(), 1);
        assert!(split.diagnostics.is_empty());
        assert!(CONTRACT.contains("default return path is the ordinary assistant text channel"));
        assert!(CONTRACT.contains("Call indexes are local to the current response"));
        assert!(CONTRACT.contains("omit calls or use calls:[]"));
        assert!(!CONTRACT.contains("prefer two deliver_message"));
    }

    #[test]
    fn model_contract_example_is_a_valid_companion_not_a_body_or_text_protocol() {
        let arguments = CONTRACT
            .lines()
            .find(|line| line.starts_with("{\"delivery_id\":\"example-annotation\""))
            .expect("model-facing example must contain complete native arguments");
        let b = binding();
        let delivery = parse_delivery(arguments, &Limits::default()).unwrap();
        assert_ne!(delivery.delivery_id, b.delivery_id);
        assert_eq!(delivery.message.format.id, ANNOTATIONS_FORMAT);
        let response = Response {
            content: "The real answer stays in the assistant text channel.".into(),
            tool_calls: vec![ToolCallRepr {
                id: "example-call".into(),
                r#type: "function".into(),
                func_name: "deliver_message".into(),
                arguments: arguments.into(),
            }],
        };
        let parts = split_response(&response, &b).unwrap();
        assert_eq!(parts.response.content, response.content);
        assert!(parts.body_message.is_none());
        assert!(parts.response.tool_calls.is_empty());
        assert_eq!(parts.annotation_messages.len(), 1);
        assert!(parts.diagnostics.is_empty());
        let missing_body = Response {
            content: String::new(),
            ..response
        };
        assert_eq!(
            split_response(&missing_body, &b).unwrap_err().code,
            "invalid_delivery_contract"
        );
        let working_arguments = CONTRACT
            .lines()
            .find(|line| line.starts_with("{\"delivery_id\":\"example-work-annotation\""))
            .expect("working and final responses share the same complete IO envelope");
        let working = Response {
            content: String::new(),
            tool_calls: vec![
                ToolCallRepr {
                    id: "work".into(),
                    r#type: "function".into(),
                    func_name: "context_tx".into(),
                    arguments: "{}".into(),
                },
                ToolCallRepr {
                    id: "work-companion".into(),
                    r#type: "function".into(),
                    func_name: "deliver_message".into(),
                    arguments: working_arguments.into(),
                },
            ],
        };
        let parts = split_response(&working, &b).unwrap();
        assert!(parts.response.content.is_empty());
        assert!(parts.body_message.is_none());
        assert_eq!(parts.response.tool_calls, working.tool_calls[..1]);
        assert_eq!(parts.annotation_messages.len(), 1);
        assert!(parts.diagnostics.is_empty());
    }
    #[test]
    fn publications_and_annotation_omission_do_not_change_return_semantics() {
        let b = binding();
        let ordinary = Response {
            content: String::new(),
            tool_calls: vec![call(
                "progress",
                "morphz.chat",
                "json",
                json!({"text":"进度"}),
            )],
        };
        assert_eq!(
            split_response(&ordinary, &b)
                .unwrap()
                .response
                .tool_calls
                .len(),
            1
        );
        let returned = Response {
            content: String::new(),
            tool_calls: vec![call(
                &b.delivery_id,
                "morphz.chat",
                "json",
                json!({"text":"结果"}),
            )],
        };
        let mut off = b;
        off.annotations_enabled = false;
        assert!(split_response(&returned, &off)
            .unwrap()
            .response
            .tool_calls
            .is_empty());
    }
    #[test]
    fn metadata_alone_is_never_a_reason_to_request_another_model_reply() {
        for enabled in [true, false] {
            let mut binding = binding();
            binding.annotations_enabled = enabled;
            for value in [
                json!({"execution":{"title":"标题","result":"结果"}}),
                json!({"invalid":"metadata"}),
            ] {
                let raw = Response {
                    content: String::new(),
                    tool_calls: vec![call("metadata", ANNOTATIONS_FORMAT, "json", value)],
                };
                assert_eq!(
                    split_response(&raw, &binding).unwrap_err().code,
                    "invalid_delivery_contract"
                );
            }
        }
    }
}
