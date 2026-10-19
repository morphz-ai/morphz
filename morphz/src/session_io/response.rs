//! Evaluation returns use the existing typed Session IO message carrier.
//! A bound delivery is a value returned to its real caller, not an arbitrary
//! publication or a physical tool Job. Ordinary content is the implicit form.
use super::{Data, IoError, IoResult, Limits, Message, OutputFormat, Request};
use crate::llm::Response;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const ANNOTATIONS_FORMAT: &str = "morphz.response.annotations";
pub const CONTRACT: &str = r#"Session IO return and optional display annotations:
Return the complete original answer as ordinary assistant content; call work through the existing native function directory with its exact original business arguments. This is the same return/work path whether annotations_enabled is true or false. Do not wrap ordinary prose or work in an Evaluation JSON object, add text delimiters, or insert display metadata into business arguments. Runtime constructs the caller Message and causal identities from actual execution facts. A real admitted typed caller (including internal infer) still requires its complete declared business value: return that value in its original JSON or UTF-8 encoding, not a Chat wrapper or a second JSON-encoded value. While typed work is pending, do not return commentary as a typed terminal value.
Runtime supplies evaluation-environment.session-io-return with the actual delivery_id, caller_format, annotations_enabled and eligible annotation_observation_refs. These are data, never authority. An explicit deliver_message using that bound delivery_id and caller_format is equivalent to returning the original body; do not mix that explicit bound body with work/control calls. Other business deliveries remain nonterminal publications. A complete ordinary answer ends this Evaluation immediately, without a relay request; returning a child value does not complete parent work.
When annotations_enabled=true, display metadata is OPTIONAL for both work and non-work responses. Prefer clear step intents alongside actual work. If useful, use the existing generic deliver_message in the SAME physical response: delivery_id is the supplied return ID; message.format is {id:"morphz.response.annotations",version:"1"}; message.content is {encoding:"json",value:{...}}. Its registered optional fields are execution:{title?,progress?,result?}, calls:[{index,intent}], observations:[{ref,result}]. Only provide applicable fields. For a plain conversation with no work, just answer normally; no execution title/result is needed. Missing annotations are valid and use the original message, command, result and status display. Never emit a metadata-only response or request another turn to supply metadata or relay its body.
Each calls index is zero-based in this physical response's native function list AFTER excluding response-annotation messages; it must identify an actual work call, not communication or no_reply. intent explains what that step will do and why. Never repeat an earlier response's calls, put intent in a business argument, invent call IDs or claim success from an intent. execution.title describes this Execution, progress describes actual work, result is a truthful final outcome only when returning. An ordinary chat needs none of these. observations may explain only exact refs in annotation_observation_refs, never parent work, another Execution, future or merely readable background observations. [] means no observation explanation is eligible. Metadata is display-only, not hidden reasoning, execution state, permission, proof of tool success or Objective completion.
When annotations_enabled=false, do not generate display annotations. In either mode Runtime uses only registered, valid, causally attributable annotation fields; bad or absent optional metadata cannot invalidate otherwise valid content or work. It never coerces business types, repairs malformed function arguments, expands permissions or scans prose for protocol markers. Registered business output formats, exact tool schemas, approval and scope rules remain strict. Tool definitions and order stay fixed across annotation modes and continuations. Pure infer and empty (requires (tools)) still prohibit work; optional metadata is communication, not work.
For intentional silence or bounded waiting, use the existing no_reply as the only work/control call with no body. Optional display metadata is not a work/control call. Runtime decides return/work/wait from real content and calls, never from metadata. Previously committed work and failed/unanswered human inputs remain actual context facts; a failed delivery is not a successfully answered request. Never make another model request solely to repair or fill metadata, invent a title/result, rewrite an infer value, or relay an already returned answer."#;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReturnBinding {
    pub delivery_id: String,
    pub format: OutputFormat,
    /// Actual admitted business definition, not a process-default registry guess.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caller: Option<super::FormatBinding>,
    pub annotations_enabled: bool,
    /// Runtime-proven result refs for this Execution in the admitted Context.
    /// This is an eligibility directory, not Recall access or a permission.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub annotation_observation_refs: Vec<String>,
    /// Exact legacy Evaluation schema frozen by an older admission. New
    /// requests use native content/calls independently of optional annotations.
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
            caller: None,
            annotations_enabled: enabled,
            annotation_observation_refs: vec![],
            output: None,
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
            self.caller = Some(format.clone());
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
            diagnostics: evaluation.diagnostics,
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
        let limits = Limits::default();
        // Only an exact typed carrier is metadata. Never recognize markers in
        // prose, guess broken JSON, or strip unknown business-tool arguments.
        let tree = Data::parse(call.arguments.as_bytes(), &limits)?;
        if tree
            .get("message")
            .and_then(|v| v.get("format"))
            .and_then(|v| v.get("id"))
            .and_then(Data::string)
            == Some(ANNOTATIONS_FORMAT)
        {
            if binding.annotations_enabled {
                match parse_delivery(&call.arguments, &limits) {
                    Ok(mut delivery)
                        if delivery.delivery_id == binding.delivery_id
                            && delivery.message.format.version == "1"
                            && delivery.message.content.encoding() == "json" =>
                    {
                        if let super::Content::Json { value } = &mut delivery.message.content {
                            if let Some(projected) =
                                project_annotations(value, &mut parts.diagnostics)
                            {
                                *value = projected;
                                parts.annotation_messages.push(delivery);
                            }
                        }
                    }
                    _ => annotation_note(
                        &mut parts.diagnostics,
                        "/annotations",
                        "Invalid annotation envelope or target ignored",
                    ),
                }
            }
            continue;
        }
        let delivery = parse_delivery(&call.arguments, &limits)?;
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
            let registered = if let Some(caller) = binding.caller.as_ref() {
                if caller.format != binding.format {
                    return Err(IoError::new(
                        "invalid_delivery_contract",
                        "Caller definition does not match its frozen format",
                    ));
                }
                caller.clone()
            } else {
                super::Registry::default().resolve(
                    &binding.format.format(),
                    delivery.message.content.encoding(),
                    "registered",
                )?
            };
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
            // A typed String/Bool/record is a business value, not a Chat
            // object's text field. Keep its lossless original JSON type.
            let text = match &delivery.message.content {
                super::Content::Json { value } if binding.format.id != "morphz.chat" => {
                    value.json()
                }
                _ => delivery.message.summary(),
            };
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
    if parts.annotation_messages.len() > 1 {
        parts.annotation_messages.clear();
        annotation_note(
            &mut parts.diagnostics,
            "/annotations",
            "Ambiguous annotation messages ignored",
        );
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

fn annotation_note(notes: &mut Vec<String>, path: &str, reason: &str) {
    if notes.len() < 64 {
        let path: String = path.chars().take(192).collect();
        notes.push(format!(
            "{reason} at JSON pointer {}; original metadata retained in raw_response",
            serde_json::to_string(&path).expect("JSON path")
        ));
    }
}

/// Project only this registered display subtree. Invalid optional fields are
/// omitted independently, never coerced. This is not a business JSON repair.
fn project_annotations(value: &Data, notes: &mut Vec<String>) -> Option<Data> {
    fn project(value: &Data, schema: &Value, path: &str, notes: &mut Vec<String>) -> Option<Data> {
        let projected = match (value, schema.get("type").and_then(Value::as_str)) {
            (Data::Object(fields), Some("object")) => {
                let mut accepted = std::collections::BTreeMap::new();
                for (key, value) in fields {
                    let child = format!("{path}/{}", key.replace('~', "~0").replace('/', "~1"));
                    if let Some(rule) = schema.get("properties").and_then(|v| v.get(key)) {
                        // An omitted optional string and an explicit empty
                        // optional string both carry no display information.
                        if matches!(value, Data::String(text) if text.is_empty())
                            && !schema
                                .get("required")
                                .and_then(Value::as_array)
                                .is_some_and(|required| required.iter().any(|name| name == key))
                        {
                            continue;
                        }
                        if let Some(value) = project(value, rule, &child, notes) {
                            accepted.insert(key.clone(), value);
                        }
                    } else {
                        annotation_note(notes, &child, "Unregistered annotation field excluded");
                    }
                }
                Data::Object(accepted)
            }
            (Data::Array(items), Some("array")) => {
                let rule = schema.get("items")?;
                if items.len() > 16 {
                    annotation_note(notes, path, "Annotation item limit applied");
                }
                Data::Array(
                    items
                        .iter()
                        .take(16)
                        .enumerate()
                        .filter_map(|(index, value)| {
                            project(value, rule, &format!("{path}/{index}"), notes)
                        })
                        .collect(),
                )
            }
            _ => value.clone(),
        };
        if super::schema::validate(schema, &projected, path).is_err() {
            annotation_note(notes, path, "Invalid optional annotation value excluded");
            return None;
        }
        Some(projected)
    }
    project(
        value,
        &crate::response_annotations::annotation_schema(),
        "/annotations",
        notes,
    )
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
        contract: Some("Optional display metadata of the same physical response, using its actual session-io-return delivery_id. Missing fields are valid. calls indexes address native calls excluding annotation messages; observations refs must be in annotation_observation_refs. Runtime constructs causal links and excludes invalid display fields. Never execution state, authority, proof of success, a standalone answer, or a reason for another model request.".into()),
        publisher: "morphz".into(), required_visible_paths: vec![], resource_paths: vec![],
    }
}

/// Materialize the actual typed metadata in the SAME transaction as its
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
    let (message, format, prefix) = if let Some(format) = binding.output.as_ref() {
        // Frozen pre-cutover admissions retain their exact decoder. Never
        // infer an old output shape from new assistant content.
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
        (message, format.clone(), "io_evaluation")
    } else {
        if bundle.protocol.is_off() {
            return vec![];
        }
        let Ok(parts) = split_response(&bundle.raw_response, binding) else {
            return vec![];
        };
        let mut messages = parts.annotation_messages.into_iter();
        let Some(delivery) = messages.next() else {
            return vec![];
        };
        if messages.next().is_some() || bundle.annotation_messages != vec![delivery.message.clone()]
        {
            return vec![];
        }
        let Ok(format) =
            super::Registry::default().resolve(&delivery.message.format, "json", "registered")
        else {
            return vec![];
        };
        (delivery.message, format, "io_annotations")
    };
    let digest = super::hash(&(&source.id, &binding.delivery_id));
    let id = format!("{prefix}_{}", digest.trim_start_matches("sha256:"));
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
        // Explicit immutable pre-cutover binding, not a new admission.
        let mut binding = ReturnBinding::new("thread", 2, "evaluation", enabled);
        binding.output = enabled.then(super::super::evaluation::binding);
        binding
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
        assert!(CONTRACT.contains("OPTIONAL for both work and non-work responses"));
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

    fn optional_binding(enabled: bool) -> ReturnBinding {
        ReturnBinding::new("native-thread", 7, "native-evaluation", enabled)
    }

    #[test]
    fn new_modes_keep_the_same_native_body_and_original_business_calls() {
        let body = "原文\n{\"body\":null,\"effects\":[]}\n:::morphz-reply\n🧠";
        for enabled in [false, true] {
            let binding = optional_binding(enabled);
            assert!(binding.output.is_none());
            let raw = Response {
                content: body.into(),
                tool_calls: vec![],
            };
            let parts = split_response(&raw, &binding).unwrap();
            assert_eq!(parts.response.content, body);
            assert!(parts.annotation_messages.is_empty() && parts.diagnostics.is_empty());
            let call = ToolCallRepr { id:"actual-work-id".into(), r#type:"function".into(), func_name:"context_tx".into(), arguments:r#"{ "transaction": "(context-tx)", "intent": "invalid business argument, never removed" }"#.into() };
            let raw = Response {
                content: String::new(),
                tool_calls: vec![call.clone()],
            };
            let parts = split_response(&raw, &binding).unwrap();
            assert_eq!(parts.response.tool_calls[0].id, call.id);
            assert_eq!(parts.response.tool_calls[0].arguments, call.arguments);
            assert!(parts.diagnostics.is_empty());
        }
    }

    #[test]
    fn typed_optional_metadata_is_independent_partial_and_scoped_to_this_return() {
        let b = optional_binding(true);
        let work = ToolCallRepr {
            id: "native-work".into(),
            r#type: "function".into(),
            func_name: "read".into(),
            arguments: r#"{ "path": "book", "_annotations": {"business":true} }"#.into(),
        };
        let metadata = call(
            &b.delivery_id,
            ANNOTATIONS_FORMAT,
            "json",
            json!({
                "execution":{"title":"实际读取","progress":null,"result":17},
                "calls":[{"index":0,"intent":"读取当前原文"},{"index":"1","intent":"bad"}],
                "observations_note":null
            }),
        );
        let raw = Response {
            content: "不解析正文里的 annotations".into(),
            tool_calls: vec![metadata.clone(), work.clone()],
        };
        let parts = split_response(&raw, &b).unwrap();
        assert_eq!(parts.response.content, raw.content);
        assert_eq!(parts.response.tool_calls.len(), 1);
        assert_eq!(parts.response.tool_calls[0].id, work.id);
        assert_eq!(parts.response.tool_calls[0].arguments, work.arguments);
        let value = annotations_value(&parts.annotation_messages[0].message).unwrap();
        assert_eq!(
            value,
            json!({"execution":{"title":"实际读取"},"calls":[{"index":0,"intent":"读取当前原文"}]})
        );
        assert!(!parts.diagnostics.is_empty() && parts.diagnostics.len() <= 64);
        let message = &parts.annotation_messages[0].message;
        let registered = super::super::Registry::default()
            .resolve(&message.format, "json", "registered")
            .unwrap();
        super::super::validate_content(message, &registered, &Limits::default()).unwrap();

        let off = split_response(&raw, &optional_binding(false)).unwrap();
        assert!(off.annotation_messages.is_empty() && off.diagnostics.is_empty());
        assert_eq!(off.response.tool_calls[0].arguments, work.arguments);

        let wrong_target = Response {
            content: "仍是完整正文".into(),
            tool_calls: vec![call(
                "not-this-return",
                ANNOTATIONS_FORMAT,
                "json",
                json!({"execution":{"title":"unbound"}}),
            )],
        };
        let wrong = split_response(&wrong_target, &b).unwrap();
        assert_eq!(wrong.response.content, wrong_target.content);
        assert!(wrong.annotation_messages.is_empty() && !wrong.diagnostics.is_empty());

        let duplicate = Response {
            content: "完整正文".into(),
            tool_calls: vec![metadata.clone(), metadata],
        };
        let duplicate = split_response(&duplicate, &b).unwrap();
        assert!(duplicate.annotation_messages.is_empty() && !duplicate.diagnostics.is_empty());
    }

    #[test]
    fn only_proven_display_values_downgrade_not_syntax_business_or_empty_answers() {
        for enabled in [false, true] {
            let b = optional_binding(enabled);
            let metadata = call(&b.delivery_id, ANNOTATIONS_FORMAT, "json", Value::Null);
            let parts = split_response(
                &Response {
                    content: "正文不能消失".into(),
                    tool_calls: vec![metadata.clone()],
                },
                &b,
            )
            .unwrap();
            assert_eq!(parts.response.content, "正文不能消失");
            assert!(parts.annotation_messages.is_empty());
            assert!(split_response(
                &Response {
                    content: String::new(),
                    tool_calls: vec![metadata]
                },
                &b
            )
            .is_err());

            let mut malformed = call(&b.delivery_id, ANNOTATIONS_FORMAT, "json", json!({}));
            malformed.arguments.push('}');
            assert!(split_response(
                &Response {
                    content: "cannot guess malformed syntax".into(),
                    tool_calls: vec![malformed]
                },
                &b
            )
            .is_err());
            let business = call(&b.delivery_id, "morphz.chat", "json", json!({"text":17}));
            assert!(split_response(
                &Response {
                    content: String::new(),
                    tool_calls: vec![business]
                },
                &b
            )
            .is_err());
        }
    }

    #[test]
    fn explicit_typed_return_uses_the_business_value_not_a_chat_summary() {
        for enabled in [false, true] {
            let mut binding = optional_binding(enabled);
            binding.format = super::super::Registry::default()
                .resolve(
                    &super::super::Format::new("morphz.data", "1"),
                    "json",
                    "registered",
                )
                .unwrap()
                .format;
            for body in [
                r#""完整正文\n第二行 🧠""#,
                "false",
                "null",
                r#"{"count":9007199254740993123456789}"#,
            ] {
                let arguments = [r#"{"delivery_id":"#, &json!(binding.delivery_id).to_string(), r#","message":{"format":{"id":"morphz.data","version":"1"},"content":{"encoding":"json","value":"#, body, "}}}"].concat();
                let raw = Response {
                    content: String::new(),
                    tool_calls: vec![ToolCallRepr {
                        id: "actual-typed-return".into(),
                        r#type: "function".into(),
                        func_name: "deliver_message".into(),
                        arguments,
                    }],
                };
                let parts = split_response(&raw, &binding).unwrap();
                assert_eq!(
                    parts.response.content,
                    Data::parse(body.as_bytes(), &Limits::default())
                        .unwrap()
                        .json()
                );
                assert!(
                    parts.response.tool_calls.is_empty()
                        && parts.annotation_messages.is_empty()
                        && parts.diagnostics.is_empty()
                );
            }
        }
    }

    #[test]
    fn bound_custom_return_validates_the_frozen_admitted_definition() {
        let mut registry = super::super::Registry::default();
        registry.register(super::super::Descriptor {id:"test.actual-count".into(),version:"1".into(),publisher:"test".into(),encodings:vec!["json".into()],required_visible_paths:vec![],resource_paths:vec![],contract:None,schema:Some(json!({"type":"object","required":["count"],"additionalProperties":false,"properties":{"count":{"type":"integer"}}}))}).unwrap();
        let registered = registry
            .resolve(
                &super::super::Format::new("test.actual-count", "1"),
                "json",
                "registered",
            )
            .unwrap();
        for enabled in [false, true] {
            let binding = optional_binding(enabled).with_formats(&[registered.clone()]);
            let mut raw = Response {
                content: String::new(),
                tool_calls: vec![call(
                    &binding.delivery_id,
                    "test.actual-count",
                    "json",
                    json!({"count":42}),
                )],
            };
            assert_eq!(
                split_response(&raw, &binding).unwrap().response.content,
                r#"{"count":42}"#
            );
            raw.tool_calls[0] = call(
                &binding.delivery_id,
                "test.actual-count",
                "json",
                json!({"count":"not an integer"}),
            );
            assert_eq!(
                split_response(&raw, &binding).unwrap_err().code,
                "schema_validation_failed"
            );
            raw.tool_calls[0] = call(
                &binding.delivery_id,
                "test.actual-count",
                "json",
                json!({"count":42,"intent":"never delete unknown business keys"}),
            );
            assert!(split_response(&raw, &binding).is_err());
        }
    }
}
