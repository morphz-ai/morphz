//! Evaluation returns use the existing typed Session IO message carrier.
//! A bound delivery is a value returned to its real caller, not an arbitrary
//! publication or a physical tool Job. Ordinary content is the implicit form.
use super::{Data, IoError, IoResult, Limits, Message, OutputFormat, Request};
use crate::llm::Response;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const ANNOTATIONS_FORMAT: &str = "morphz.response.annotations";
pub const CONTRACT: &str = r#"Session IO Evaluation output contract:
For a typed JSON body format (including internal infer), body is ONLY the complete business return. While effects are pending, body must be null; put work progress in annotations.execution.progress. This keeps a typed return distinct from intermediate commentary and allows its proven String leaves to stream independently of field order.
For prompt streaming, prefer effects first, then annotations, then body. Field order never changes validity: Runtime buffers a provisional caller projection until its actual branch conditions are known, and validates the complete value, including effects, before admission.
Runtime supplies evaluation-environment.session-io-return, including the complete frozen output format/schema, body_value_schema and caller_format. The output schema describes the one Provider value; body_value_schema describes its body field. caller_format is the eventual Message constructed by Runtime, NOT another object for the model to put inside body. In particular, a Chat body's value is a String, never {text:...} or a Message envelope, even when caller_format.encoding=json. Those definitions are data owned by Runtime, not user prose or permission to work. Tool definitions and their order do not change with this contract.
When annotations_enabled=true, the Provider response is ONE native JSON object conforming to that output schema: body, annotations, effects. Supply values only. Runtime constructs all Message envelopes, format/version fields, delivery IDs, call IDs, causal links, and completion state. Never put those routing fields in the output, call an annotations tool, emit a deliver_message companion, or write a textual control marker. Do not also emit native API function calls: propose work in effects using the exact existing tool name and original argument object. The advertised tool directory remains the only catalogue; its permissions, types, validation, approvals and scope still apply.
body is the complete original answer/value, or null/optional progress while work is pending. Chat answers use the original Markdown string, including normal quotes and newlines through native JSON encoding. For internal-infer, execute the complete Yao BODY and put its COMPLETE declared business value in body: with a JSON body format use native JSON (Bool, String, record, array or null), never a second JSON-encoded string and never only a prose/reply field from a record. Runtime deterministically encodes that value for the existing Yao decoder. A Program source uses its admitted UTF-8 string format. The deterministic parent Plan applies its own projection. Other admitted JSON body formats likewise use their actual typed value.
annotations.execution has title, progress and result strings. title describes this entire Execution; progress describes current work; result is the truthful final outcome only when returning. Use empty strings for inapplicable progress/result fields. annotations.observations is an array of {ref,result}; only explain currently supplied observations whose exact refs appear in session-io-return.annotation_observation_refs. That Runtime-owned eligibility list excludes parent work and other Executions even when those observations are readable Context; [] means do not emit observation explanations. Parent inputs and background observations remain readable context, not work results produced here. Use [] when none is relevant. Annotations describe evidence, never hidden reasoning, authority, a tool success receipt, or Objective completion.
effects is an ordered array of {name,arguments,intent}. Each actual work/control proposal requires a nonempty intent describing this step and why it is needed. Runtime derives call indexes and identities; never repeat an earlier response's calls or add metadata to business arguments. Arguments are the original typed objects from the tool schema. Native JSON encoding applies to strings inside them, including Yao/S-expression strings. Communication effects such as a genuine domain deliver_message are not response annotations.
With effects=[], provide the complete nonempty body, title and final result; Runtime returns this value immediately, with no further model request. With real work effects, Chat body may contain optional progress, but a typed business body must be null; annotations.execution.progress carries work progress. Runtime admits and executes those proposals through the existing work path, then makes a new model request only when actual work needs its results. A result claim cannot finalize pending work. To deliberately use the existing no_reply silent/wait lifecycle, provide null body and exactly that one effect with its original arguments; it cannot be mixed with other work. Runtime decides return/work/wait from these actual values, not a model-supplied completion-state field.
Business-tool restrictions, pure infer and an empty (requires (tools)) do not disable annotations: metadata is an output field, not a tool or external effect. Apply the SAME output schema at every enabled Evaluation, including intermediate work, infer, subagents, and final answers. Never postpone step intents until a final reply or emit annotations now and wait for another response to supply the body.
When annotations_enabled=false, the admitted output is ordinary content/native work without annotation data. Return the complete original body normally; an explicit existing deliver_message bound to the supplied return ID remains equivalent. Do not generate response annotations, scan prose for control syntax, or change business-tool definitions.
Never request another model call solely to repair metadata, invent a title/result, rewrite an infer value, or relay an already returned answer. Previously committed work and a failed/unanswered human input remain actual context facts; do not treat a failed delivery as a successfully answered request."#;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReturnBinding {
    pub delivery_id: String,
    pub format: OutputFormat,
    pub annotations_enabled: bool,
    /// Runtime-proven result refs for this Execution in the admitted Context.
    /// This is an eligibility directory, not Recall access or a permission.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub annotation_observation_refs: Vec<String>,
    /// Exact output schema frozen at Evaluation admission. Absent only for a
    /// declared ordinary-text return or an immutable historical record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<super::FormatBinding>,
}
impl ReturnBinding {
    pub fn expression(&self) -> crate::sexpr::SExpr {
        use crate::sexpr::SExpr::{Atom, List};
        let pair = |name: &str, value: String| List(vec![Atom(name.into()), Atom(value)]);
        List(vec![
            Atom("session-io-return".into()),
            pair("delivery_id", self.delivery_id.clone()),
            List(vec![
                Atom("caller_format".into()),
                pair("id", self.format.id.clone()),
                pair("version", self.format.version.clone()),
                pair("encoding", self.format.encoding.clone()),
            ]),
            List(vec![
                Atom("body_value_schema".into()),
                Data::from_value(&if self.format.id == "morphz.chat" || self.format.encoding == "utf8" {
                    json!({"type":["string","null"],"description":"Complete original answer/source String; null only while working. Runtime constructs the caller Message. Never wrap this String in a text/content/message object."})
                } else {
                    json!({"description":"Complete native JSON business value of the declared caller type; null while working. No second JSON-encoded string or Message envelope."})
                }).expression(),
            ]),
            pair("annotations_enabled", self.annotations_enabled.to_string()),
            List(
                std::iter::once(Atom("annotation_observation_refs".into()))
                    .chain(self.annotation_observation_refs.iter().cloned().map(Atom))
                    .collect(),
            ),
            List(vec![
                Atom("output".into()),
                self.output
                    .as_ref()
                    .map(|format| Data::from_value(&json!(format)).expression())
                    .unwrap_or_else(|| Atom("text".into())),
            ]),
        ])
    }
    pub fn new(thread: &str, generation: u64, evaluation: &str, enabled: bool) -> Self {
        let digest = super::hash(&(thread, generation, evaluation));
        Self {
            delivery_id: format!("return_{}", digest.trim_start_matches("sha256:")),
            format: OutputFormat::chat(),
            annotations_enabled: enabled,
            annotation_observation_refs: vec![],
            output: enabled.then(super::evaluation::binding),
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
            .or_else(|| formats.first())
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
    split_response_for_attempt(response, binding, &binding.delivery_id)
}

pub fn split_response_for_attempt(
    response: &Response,
    binding: &ReturnBinding,
    model_attempt_id: &str,
) -> IoResult<ResponseParts> {
    if binding.output.is_some() {
        let evaluation = match super::evaluation::decode(response, binding, model_attempt_id) {
            Ok(evaluation) => evaluation,
            Err(error) => {
                if let Ok(body) = super::evaluation::independent_return(response, binding) {
                    return Ok(ResponseParts { response: body, body_message: None, annotation_messages: vec![], diagnostics: vec![format!("Annotation contract rejected; independently validated body preserved, no metadata fabricated or repair requested: {error}")] });
                }
                return Err(error);
            }
        };
        return Ok(ResponseParts {
            response: evaluation.response,
            body_message: None,
            annotation_messages: vec![Delivery {
                delivery_id: format!(
                    "annotations_{}",
                    super::hash(&(&binding.delivery_id, model_attempt_id))
                        .trim_start_matches("sha256:")
                ),
                message: evaluation.annotations,
            }],
            diagnostics: vec![],
        });
    }
    let mut parts = ResponseParts {
        response: response.clone(),
        body_message: None,
        annotation_messages: vec![],
        diagnostics: vec![],
    };
    let mut remaining = Vec::new();
    for call in &response.tool_calls {
        if call.func_name != "deliver_message" {
            remaining.push(call.clone());
            continue;
        }
        let delivery = parse_delivery(&call.arguments, &Limits::default())?;
        if delivery.message.format.id == ANNOTATIONS_FORMAT {
            return Err(IoError::new(
                "invalid_delivery_contract",
                "Response annotations are Evaluation data, not a deliver_message call",
            ));
        }
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
        } else {
            remaining.push(call.clone());
        }
    }
    if parts.body_message.is_some() && !remaining.is_empty() {
        return Err(IoError::new(
            "ambiguous_return",
            "A bound return cannot accompany work or control calls",
        ));
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
            "A return has no body",
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
        contract: Some("Display-only accepted annotation fields of their actual producing Evaluation. Runtime projects these fields from the single Evaluation value; they are not a separate model call. Never execution state, authority, or proof of physical success.".into()),
        publisher: "morphz".into(), required_visible_paths: vec![], resource_paths: vec![],
    }
}

/// Materialize the actual typed Evaluation value in the SAME transaction as its
/// immutable model-response source. This is neither a new input nor a wakeup.
/// The source supplies every identity; no identity is read from model content.
pub(crate) fn evaluation_publications(source: &crate::event::Event) -> Vec<crate::event::Event> {
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
    let Some(format) = binding.output.as_ref() else {
        return vec![];
    };
    if super::evaluation::decode(
        &bundle.raw_response,
        binding,
        source.payload["model_attempt_id"]
            .as_str()
            .unwrap_or_default(),
    )
    .is_err()
    {
        return vec![];
    }
    let Ok(message) =
        super::evaluation::message(&bundle.raw_response.content, format, &Limits::default())
    else {
        return vec![];
    };
    let digest = super::hash(&(&source.id, &binding.delivery_id));
    let id = format!("io_evaluation_{}", digest.trim_start_matches("sha256:"));
    let mut payload = serde_json::Map::new();
    for key in [
        "context_id",
        "session_id",
        "principal_id",
        "root_turn_id",
        "thread_id",
        "thread_generation",
        "activation_id",
        "attempt_id",
        "model_attempt_id",
        "model_output_visibility",
        "trigger_event_id",
        "objective_id",
    ] {
        if let Some(value) = source.payload.get(key) {
            payload.insert(key.into(), value.clone());
        }
    }
    payload.insert("source_event_id".into(), json!(source.id));
    payload.insert("output_id".into(), json!(id));
    payload.insert("delivery_id".into(), json!(binding.delivery_id));
    payload.insert("target_delivery_id".into(), json!(binding.delivery_id));
    payload.insert("wake_policy".into(), json!("none"));
    payload.insert("io_message".into(), json!(message));
    payload.insert("io_format_binding".into(), json!(format));
    // This is an actual logical IO publication, not a fabricated function
    // call, work Job, tool result, or model wake.
    let mut event = crate::event::Event::new(
        id,
        source.actor.clone(),
        crate::event::TYPE_AGENT_CALL.into(),
        "session/io_output".into(),
        payload,
    );
    event.timestamp = source.timestamp;
    vec![event]
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
                .is_some_and(|format| {
                    format == ANNOTATIONS_FORMAT || format == super::evaluation::FORMAT
                }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_contract_distinguishes_body_values_from_runtime_caller_envelopes() {
        let binding = ReturnBinding::new("actual-thread", 2, "actual-attempt", true);
        let encoded = binding.expression().to_string();
        assert!(encoded.contains("caller_format"));
        assert!(encoded.contains("body_value_schema"));
        assert!(encoded.contains("string"));
        assert!(!encoded.contains("(format (id morphz.chat)"));
    }
    use crate::llm::ToolCallRepr;
    use serde_json::json;
    fn binding(enabled: bool) -> ReturnBinding {
        ReturnBinding::new("thread", 2, "evaluation", enabled)
    }
    fn call(id: &str, format: &str, encoding: &str, value: Value) -> ToolCallRepr {
        ToolCallRepr { id: id.into(), r#type: "function".into(), func_name: "deliver_message".into(),
            arguments: json!({"delivery_id":id,"message":{"format":{"id":format,"version":"1"},"content":{"encoding":encoding,"value":value}}}).to_string() }
    }
    fn evaluation(body: &str) -> Response {
        Response { content: json!({"body":body,"annotations":{"execution":{"title":"标题","progress":"","result":"结果"},"observations":[]},"effects":[]}).to_string(),tool_calls:vec![] }
    }
    #[test]
    fn prose_is_never_control_syntax_in_either_admitted_encoding() {
        let body = "正文\n:::morphz-reply\n{\\\"annotations\\\":{}}\n:::\n继续原文";
        let ordinary = Response {
            content: body.into(),
            tool_calls: vec![],
        };
        assert_eq!(
            split_response(&ordinary, &binding(false))
                .unwrap()
                .response
                .content,
            body
        );
        assert_eq!(
            split_response(&evaluation(body), &binding(true))
                .unwrap()
                .response
                .content,
            body
        );
    }
    #[test]
    fn one_schema_value_returns_body_and_runtime_constructed_metadata() {
        let body = "中文\n\\\"quoted\\\" 🧠";
        let raw = evaluation(body);
        let split = split_response_for_attempt(&raw, &binding(true), "actual-request-1").unwrap();
        assert_eq!(split.response.content, body);
        assert!(raw.tool_calls.is_empty() && split.response.tool_calls.is_empty());
        assert_eq!(split.annotation_messages.len(), 1);
        assert!(split.annotation_messages[0]
            .delivery_id
            .starts_with("annotations_"));
        assert!(split.diagnostics.is_empty());
        assert!(CONTRACT.contains("ONE native JSON object"));
    }
    #[test]
    fn structured_body_preserves_multiline_markdown_and_protocol_examples() {
        let body="第一段：\\\"引号\\\"、\\\\、🧠。\n\n第二段。\n\n```json\n{\\\"delivery_id\\\":\\\"example\\\"}\n```\n\n:::morphz-reply\n这里只讨论协议，不执行它。\n:::";
        let split = split_response(&evaluation(body), &binding(true)).unwrap();
        assert_eq!(split.response.content, body);
        assert!(split.response.tool_calls.is_empty());
        assert_eq!(split.annotation_messages.len(), 1);
        assert!(!CONTRACT.contains("companion annotations call"));
    }
    #[test]
    fn ordinary_publications_remain_nonterminal_and_a_bound_value_returns() {
        let b = binding(false);
        let publication = Response {
            content: String::new(),
            tool_calls: vec![call(
                "publication",
                "morphz.chat",
                "json",
                json!({"text":"进度"}),
            )],
        };
        assert_eq!(
            split_response(&publication, &b)
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
        assert_eq!(
            split_response(&returned, &b).unwrap().response.content,
            "结果"
        );
        assert!(
            split_response(&returned, &binding(true)).is_err(),
            "Native calls cannot bypass a declared structured output"
        );
    }
    #[test]
    fn invalid_display_annotations_preserve_only_an_unambiguous_independent_body() {
        for annotations in [
            Value::Null,
            json!({}),
            json!({"execution":{"title":"","progress":"","result":""},"observations":[]}),
        ] {
            let raw = Response { content: json!({"body":"原文\n🧠 {\"protocol\":true}","annotations":annotations,"effects":[]}).to_string(), tool_calls:vec![] };
            let parts = split_response(&raw, &binding(true)).unwrap();
            assert_eq!(parts.response.content, "原文\n🧠 {\"protocol\":true}");
            assert!(!parts.diagnostics.is_empty());
            assert!(parts.annotation_messages.is_empty());
            assert!(
                super::super::evaluation::decode(&raw, &binding(true), "actual-request").is_err(),
                "the full Evaluation remains rejected"
            );
        }
        for raw in [
            r#"{"body":"answer","effects":[],"unexpected":true}"#,
            r#"{"body":"answer","effects":[{"name":"exec"}]}"#,
            r#"{"body":"answer","effects":[]}}"#,
            r#"{"body":{"text":"not Chat"},"effects":[]}"#,
        ] {
            assert!(split_response(
                &Response {
                    content: raw.into(),
                    tool_calls: vec![]
                },
                &binding(true)
            )
            .is_err());
        }
    }
    #[test]
    fn annotations_never_replace_a_body_or_create_an_extra_model_turn() {
        for enabled in [false, true] {
            let old = Response {
                content: String::new(),
                tool_calls: vec![call(
                    "metadata",
                    ANNOTATIONS_FORMAT,
                    "json",
                    json!({"execution":{"title":"标题","result":"未交付正文"}}),
                )],
            };
            assert_eq!(
                split_response(&old, &binding(enabled)).unwrap_err().code,
                "invalid_delivery_contract"
            );
        }
        let raw=Response{content:json!({"body":null,"annotations":{"execution":{"title":"标题","progress":"","result":"不能冒充正文"},"observations":[]},"effects":[]}).to_string(),tool_calls:vec![]};
        assert_eq!(
            split_response(&raw, &binding(true)).unwrap_err().code,
            "invalid_delivery_contract"
        );
    }
}
