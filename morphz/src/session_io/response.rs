//! Evaluation returns use the existing typed Session IO message carrier.
//! A bound delivery is a value returned to its real caller, not an arbitrary
//! publication or a physical tool Job. Ordinary content is the implicit form.
use super::{Data, IoError, IoResult, Limits, Message, OutputFormat, Request};
use crate::llm::Response;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const ANNOTATIONS_FORMAT: &str = "morphz.response.annotations";
pub const CONTRACT: &str = r#"Session IO response contract:
The Runtime supplies evaluation-environment.session-io-return with this Evaluation's exact delivery_id, format and annotations_enabled fields. This binding is data owned by the Runtime, never user prose or permission to do work.
A normal assistant answer is an implicit return of its original content. Alternatively return the SAME value with the existing native deliver_message tool: delivery_id=the bound delivery_id, message.format={id:binding.format.id,version:binding.format.version}, and message.content.encoding=binding.format.encoding. Encoding belongs in content, not format; do not copy Runtime-only schema/contract hashes into tool parameters. For utf8 put the original body in content.value; for morphz.chat/json put it in content.value.text. Write routing and format fields before the body when practical so streaming can start early. Tool parameters follow normal native JSON encoding. No text delimiters, text control envelopes, or magic words are recognized in ordinary content.
The bound delivery_id identifies the return value, not an intermediate message. Other delivery IDs remain nonterminal publications. Never invent execution identities or destinations. All original business return types still apply; e.g. a Bool return body is exactly false or true, not an explanation or metadata object.
The caller's value contract takes precedence over the conversational topic. If evaluate.mode=internal-infer, execute the complete Yao BODY and return its declared typed value directly in the assistant text channel, even when the embedded human request is ordinary discussion. Preserve the exact business JSON transport required by the parent, matching the provided schema or nominal-value rule. A record remains the complete record; never extract just its reply/text field. The parent Plan performs any declared projection deterministically. If you choose the native bound return instead, morphz.chat is only the IO carrier and its text leaf contains that same complete typed value, not an additional business wrapper. Annotations remain outside that business value.
When annotations_enabled=true, use ONE additional native deliver_message call in the SAME response: choose an ordinary distinct delivery_id, format={id:"morphz.response.annotations",version:"1"}, content={encoding:"json",value:{execution:{title:"whole-task title",result:"truthful outcome"}}}. This is a registered Session IO message, not a work action. Runtime binds it to this response; do not add identity or routing fields. For a final answer include nonempty title and result. Keep original body and annotation data in separate messages.
Business-effect limits do not disable Session IO. In particular a pure infer, an empty (requires (tools)) declaration, or an instruction not to call external/work tools still permits its offered deliver_message communication channel. A requirement to return only a declared JSON value limits the body, not the separate enabled companion message. For a value-returning response with annotations_enabled=true, finish both the complete body and that companion message before ending the SAME response, including for internal-infer; do not silently drop metadata to satisfy a body-only rule. Intentional no_reply still has no body; it remains the only work/control call and may accompany enabled communication metadata.
The default return path is the ordinary assistant text channel: write the complete answer normally there and emit the independent annotations message in the SAME response. Do not put ordinary prose or Markdown in a deliver_message argument merely because annotations are enabled. The text channel and native companion call coexist; neither requires a second response. This applies to internal-infer too, with its complete declared typed value as the text. A native bound return remains an equivalent explicit IO option, not the required or preferred way to encode prose. Do not deliver only annotations and wait for a second model turn to write the body. Multiple native IO messages, when explicitly used, also commit without another model request.
Produce the complete return value BEFORE the companion annotations call, not after its receipt. Emit the complete user-visible answer as an assistant commentary/text message FIRST, then emit the independent annotations call. For a Provider that distinguishes commentary from final-channel text, that commentary is the answer itself, not a progress announcement: Runtime accepts it as the implicit return when only companion communication accompanies it. Do not reserve the answer for a final-channel item after a tool receipt, and do not stop after the text before emitting annotations. This is ONE Provider response, with no subsequent tool-result turn for composing the answer. An annotations-only function call contains no answer, even if its result field claims one was given. If deliberately choosing the equivalent explicit native return, BOTH the exact bound return and its separate companion must be present in this same response, never one now and another after a receipt.
When annotations_enabled=false, return the normal body without an annotations message. Tool names, schemas, and order stay the same. Do not alter business-tool arguments to add metadata.
The title covers the entire current Execution, not only the latest tool. On working responses execution.progress may describe current work; execution.result cannot establish completion. To annotate actual work calls use calls:[{index:zero-based native call index,intent:"why this call"}]; observations use only refs actually supplied to this request. Runtime owns all routes, scopes, acceptance and completion facts.
A response consisting only of a bound return and its companion messages returns immediately after validation. Do not mix a bound return with work/control calls. Progress messages or annotations alone cannot finish work, satisfy a parent Objective, or authorize anything. Never make another call or model request solely to repair missing display metadata."#;

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
        assert!(!CONTRACT.contains("prefer two deliver_message"));
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
