//! One schema-bound Evaluation value. The model supplies content, not Session IO
//! envelopes, delivery identities, call IDs, or execution authority.
use super::{Content, Data, Descriptor, Format, FormatBinding, IoError, IoResult, Limits, Message};
use crate::llm::{Response, ToolCallRepr};
use serde_json::json;

pub const FORMAT: &str = "morphz.evaluation";

pub fn descriptor() -> Descriptor {
    Descriptor {
        id: FORMAT.into(), version: "1".into(), encodings: vec!["json".into()],
        publisher: "morphz".into(), required_visible_paths: vec![], resource_paths: vec![],
        contract: Some("One Evaluation value. Runtime constructs all transport and causal identities. Effects are unexecuted proposals subject to existing authority; annotations are not execution facts.".into()),
        schema: Some(json!({
            "type":"object", "additionalProperties":false,
            "required":["body","annotations","effects"],
            "properties":{
                "body":{"description":"Use session-io-return.body_value_schema. Chat uses its complete original String, never a text/Message object. Other JSON body formats, including typed infer, use their complete native business value and null while working. Runtime constructs and encodes the caller Message."},
                "annotations":{
                    "type":"object","additionalProperties":false,
                    "required":["execution","observations"],
                    "properties":{
                        "execution":{"type":"object","additionalProperties":false,
                            "required":["title","progress","result"],
                            "properties":{"title":{"type":"string"},"progress":{"type":"string"},"result":{"type":"string"}}},
                        "observations":{"type":"array","items":{
                            "type":"object","additionalProperties":false,"required":["ref","result"],
                            "properties":{"ref":{"type":"string"},"result":{"type":"string"}}}}
                    }
                },
                "effects":{"type":"array","items":{
                    "type":"object","additionalProperties":false,
                    "required":["name","arguments","intent"],
                    "properties":{"name":{"type":"string"},"arguments":{"type":"object"},"intent":{"type":"string"}}
                }}
            }
        })),
    }
}

pub fn binding() -> FormatBinding {
    super::Registry::default()
        .resolve(&Format::new(FORMAT, "1"), "json", "registered")
        .expect("built-in Evaluation format")
}

/// Validate the model's data against the exact, already-frozen definition and
/// construct the outer Message deterministically. No repair or permissive JSON
/// parser is involved; trailing bytes, duplicate fields and truncation fail.
pub fn message(raw: &str, binding: &FormatBinding, limits: &Limits) -> IoResult<Message> {
    let value = Data::parse(raw.as_bytes(), limits)?;
    let message = Message {
        format: binding.format.format(),
        validation: "registered".into(),
        content: Content::Json { value },
    };
    super::validate_content(&message, binding, limits)?;
    Ok(message)
}

/// A malformed display annotation cannot erase an independently valid return.
/// This is NOT a permissive Evaluation decoder: no work is admitted, no
/// metadata or registered Evaluation receipt is invented, and JSON syntax,
/// exact field boundaries and the caller's own body validation stay strict.
pub(crate) fn independent_return(
    raw: &Response,
    binding: &super::response::ReturnBinding,
) -> IoResult<Response> {
    if !binding.output.as_ref().is_some_and(|output| {
        output.format.id == FORMAT
            && output.format.version == "1"
            && output.format.encoding == "json"
    }) {
        return Err(IoError::new(
            "invalid_delivery_contract",
            "No current Evaluation binding",
        ));
    }
    if !raw.tool_calls.is_empty() {
        return Err(IoError::new(
            "invalid_delivery_contract",
            "Mixed native calls are not an independent return",
        ));
    }
    let data = Data::parse(raw.content.as_bytes(), &Limits::default())?;
    let fields = data.object()?;
    if fields
        .keys()
        .any(|key| !matches!(key.as_str(), "body" | "annotations" | "effects"))
        || !matches!(data.get("effects"), Some(Data::Array(effects)) if effects.is_empty())
    {
        return Err(IoError::new(
            "invalid_delivery_contract",
            "Only an unambiguous return can be delivered independently",
        ));
    }
    let body = data
        .get("body")
        .ok_or_else(|| IoError::new("invalid_delivery_contract", "Missing actual body"))?;
    let text = if binding.format.id != "morphz.chat" && binding.format.encoding == "json" {
        body.json()
    } else if let Data::String(text) = body {
        text.clone()
    } else {
        return Err(IoError::new(
            "invalid_delivery_contract",
            "The caller requires a String body",
        ));
    };
    if text.trim().is_empty() {
        return Err(IoError::new(
            "invalid_delivery_contract",
            "An independent return has no body",
        ));
    }
    Ok(Response {
        content: text,
        tool_calls: vec![],
    })
}

#[derive(Debug)]
pub struct Evaluation {
    pub message: Message,
    pub response: Response,
    pub annotations: Message,
    pub returning: bool,
}

/// Interpretation is separate from JSON/Schema validation. This only constructs
/// proposals; the existing Runtime tool/type/permission/admission paths execute
/// them after the whole response has been validated.
pub fn decode(
    raw: &Response,
    binding: &super::response::ReturnBinding,
    model_attempt_id: &str,
) -> IoResult<Evaluation> {
    if !raw.tool_calls.is_empty() {
        return Err(IoError::new(
            "invalid_delivery_contract",
            "A schema-bound Evaluation cannot also contain native tool calls",
        ));
    }
    let output = binding.output.as_ref().ok_or_else(|| {
        IoError::new(
            "invalid_delivery_contract",
            "The Evaluation has no admitted output format",
        )
    })?;
    if output.format.id != FORMAT
        || output.format.version != "1"
        || output.format.encoding != "json"
    {
        return Err(IoError::new(
            "invalid_delivery_contract",
            "The Evaluation output binding has the wrong format",
        ));
    }
    let message = message(&raw.content, output, &Limits::default())?;
    let Content::Json { value } = &message.content else {
        unreachable!()
    };
    let Data::Array(effects) = value.get("effects").expect("validated effects") else {
        unreachable!()
    };
    if effects.len() > 64 {
        return Err(IoError::new(
            "message_limit_exceeded",
            "Too many Evaluation effects",
        ));
    }
    let body = value.get("body").expect("validated body");
    let returning = effects.is_empty();
    if !returning && binding.format.id != "morphz.chat" && !matches!(body, Data::Null) {
        return Err(IoError::new("invalid_delivery_contract", "A typed business return cannot accompany pending effects; use null body and annotations.execution.progress while working"));
    }
    let text = match body {
        _ if returning
            && binding.format.id != "morphz.chat"
            && binding.format.encoding == "json" =>
        {
            body.json()
        }
        Data::Null => String::new(),
        Data::String(text) => text.clone(),
        _ if binding.format.id != "morphz.chat" => body.json(),
        _ => {
            return Err(IoError::new(
                "invalid_delivery_contract",
                "The bound Chat body must be its complete original string",
            ))
        }
    };
    // Return/work/wait are Runtime decisions derived from the actual proposal
    // set. The model does not manufacture a second completion-state field.
    if returning && text.trim().is_empty() {
        return Err(IoError::new(
            "invalid_delivery_contract",
            "A return requires a complete body",
        ));
    }
    let mut calls = Vec::new();
    let mut intents = Vec::new();
    for (index, effect) in effects.iter().enumerate() {
        let name = effect
            .get("name")
            .and_then(Data::string)
            .expect("validated effect name");
        let intent = effect
            .get("intent")
            .and_then(Data::string)
            .expect("validated effect intent");
        let work = name != "no_reply" && name != "deliver_message";
        if name == "deliver_message"
            && effect
                .get("arguments")
                .and_then(|arguments| arguments.get("message"))
                .and_then(|message| message.get("format"))
                .and_then(|format| format.get("id"))
                .and_then(Data::string)
                == Some(super::response::ANNOTATIONS_FORMAT)
        {
            return Err(IoError::new(
                "invalid_delivery_contract",
                "Response annotations are fields of this value, not publication effects",
            ));
        }
        if name == "deliver_message"
            && effect
                .get("arguments")
                .and_then(|arguments| arguments.get("delivery_id"))
                .and_then(Data::string)
                == Some(binding.delivery_id.as_str())
        {
            return Err(IoError::new(
                "invalid_delivery_contract",
                "A schema-bound return belongs in body, not a publication effect",
            ));
        }
        if name.is_empty()
            || (work && (intent.trim().is_empty() || intent.chars().take(257).count() > 256))
        {
            return Err(IoError::new(
                "invalid_delivery_contract",
                "Every actual effect requires its name and intent",
            ));
        }
        if name == "no_reply" && (effects.len() != 1 || !text.is_empty()) {
            return Err(IoError::new(
                "invalid_delivery_contract",
                "no_reply cannot be mixed with work or a return",
            ));
        }
        // IDs belong to the actual frozen Evaluation, not model arguments.
        if model_attempt_id.is_empty() {
            return Err(IoError::new(
                "invalid_delivery_contract",
                "Effect proposals have no Runtime model-attempt binding",
            ));
        }
        let digest = super::hash(&(&binding.delivery_id, model_attempt_id, index));
        calls.push(ToolCallRepr {
            id: format!("effect_{}", digest.trim_start_matches("sha256:")),
            r#type: "function".into(),
            func_name: name.into(),
            arguments: effect.get("arguments").expect("validated arguments").json(),
        });
        if name != "no_reply" && name != "deliver_message" {
            intents.push(Data::from_value(&json!({"index":index,"intent":intent})));
        }
    }
    let mut annotations = value
        .get("annotations")
        .expect("validated annotations")
        .object()?
        .clone();
    let execution = annotations.get("execution").expect("validated execution");
    let title = execution
        .get("title")
        .and_then(Data::string)
        .expect("validated title");
    let result = execution
        .get("result")
        .and_then(Data::string)
        .expect("validated result");
    let control_only =
        effects.len() == 1 && effects[0].get("name").and_then(Data::string) == Some("no_reply");
    for (field, limit) in [("title", 256), ("progress", 256), ("result", 512)] {
        if execution
            .get(field)
            .and_then(Data::string)
            .expect("validated execution string")
            .chars()
            .take(limit + 1)
            .count()
            > limit
        {
            return Err(IoError::new(
                "invalid_delivery_contract",
                format!("Evaluation annotation {field} exceeds its published character limit"),
            ));
        }
    }
    if (!control_only && title.trim().is_empty()) || (returning && result.trim().is_empty()) {
        return Err(IoError::new(
            "invalid_delivery_contract",
            "Enabled Evaluation annotations require a title and a final result for a return",
        ));
    }
    if let Some(Data::Object(fields)) = annotations.get_mut("execution") {
        fields.retain(|_, value| value.string().is_none_or(|text| !text.is_empty()));
    }
    annotations.insert("calls".into(), Data::Array(intents));
    let annotations = Message {
        format: Format::new(super::response::ANNOTATIONS_FORMAT, "1"),
        validation: "registered".into(),
        content: Content::Json {
            value: Data::Object(annotations),
        },
    };
    Ok(Evaluation {
        message,
        response: Response {
            content: text,
            tool_calls: calls,
        },
        annotations,
        returning,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn raw(body: serde_json::Value, effects: serde_json::Value) -> Response {
        Response { content: json!({"body":body,"annotations":{"execution":{"title":"独立盲审","progress":"","result":"审阅完成"},"observations":[]},"effects":effects}).to_string(), tool_calls: vec![] }
    }
    fn bound() -> super::super::response::ReturnBinding {
        super::super::response::ReturnBinding::new("actual-thread", 3, "actual-evaluation", true)
    }
    #[test]
    fn runtime_constructs_envelopes_and_stable_effect_identity_without_model_routing() {
        let response = raw(
            json!(null),
            json!([{"name":"read","arguments":{"path":"actual.txt","large":9007199254740993u64},"intent":"读取原文进行独立审阅"}]),
        );
        let first = decode(&response, &bound(), "request-1").unwrap();
        let second = decode(&response, &bound(), "request-1").unwrap();
        assert_eq!(first.message.format.id, FORMAT);
        assert_eq!(
            first.response.tool_calls[0].id,
            second.response.tool_calls[0].id
        );
        assert_ne!(
            first.response.tool_calls[0].id,
            decode(&response, &bound(), "request-2")
                .unwrap()
                .response
                .tool_calls[0]
                .id
        );
        assert!(first.response.tool_calls[0]
            .arguments
            .contains("9007199254740993"));
        assert!(first.response.content.is_empty());
        assert_eq!(
            first.annotations.format.id,
            super::super::response::ANNOTATIONS_FORMAT
        );
    }
    #[test]
    fn body_is_data_even_when_it_discusses_the_protocol() {
        let body = "第一行\n\"JSON\" 🧠 {\"disposition\":\"work\"}\n:::morphz-reply\n只是正文";
        let decoded = decode(&raw(json!(body), json!([])), &bound(), "request-1").unwrap();
        assert_eq!(decoded.response.content, body);
        assert!(decoded.response.tool_calls.is_empty());
        assert!(decoded.returning);
    }

    #[test]
    fn custom_json_body_keeps_its_native_type_including_null_and_strings() {
        let mut binding = bound();
        binding.format = super::super::OutputFormat {
            id: "test.result".into(),
            version: "1".into(),
            encoding: "json".into(),
            schema_hash: None,
            contract_hash: None,
        };
        for value in [
            json!(null),
            json!(false),
            json!("正文 🧠"),
            json!([1, 2]),
            json!({"number":9007199254740993u64}),
        ] {
            let decoded = decode(&raw(value.clone(), json!([])), &binding, "request-1").unwrap();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&decoded.response.content).unwrap(),
                value
            );
        }
        assert!(decode(
            &raw(
                json!("not a return while work is pending"),
                json!([{"name":"read","arguments":{},"intent":"读取证据"}])
            ),
            &binding,
            "request-2"
        )
        .is_err());
        assert!(decode(
            &raw(
                json!(null),
                json!([{"name":"read","arguments":{},"intent":"读取证据"}])
            ),
            &binding,
            "request-2"
        )
        .is_ok());
    }

    #[test]
    fn domain_publication_is_not_a_second_response_return_or_annotation_tool() {
        let binding = bound();
        let effect = |id: &str| json!([{"name":"deliver_message","arguments":{"delivery_id":id,"message":{}},"intent":""}]);
        assert!(decode(
            &raw(json!(null), effect("domain-publication")),
            &binding,
            "request-1"
        )
        .is_ok());
        assert!(decode(
            &raw(json!(null), effect(&binding.delivery_id)),
            &binding,
            "request-1"
        )
        .is_err());
        let retired = raw(
            json!(null),
            json!([{"name":"deliver_message","arguments":{"delivery_id":"old-companion","message":{"format":{"id":super::super::response::ANNOTATIONS_FORMAT,"version":"1"},"content":{"encoding":"json","value":{}}}},"intent":""}]),
        );
        assert!(decode(&retired, &binding, "request-1").is_err());
    }
    #[test]
    fn malformed_or_mixed_results_fail_before_any_proposal_is_dispatched() {
        let mut response = raw(json!("原文"), json!([]));
        response.content.push('}');
        assert_eq!(
            decode(&response, &bound(), "request-1").unwrap_err().code,
            "invalid_content_syntax"
        );
        let mixed = raw(
            json!("原文"),
            json!([{"name":"no_reply","arguments":{"mode":"silent"},"intent":""}]),
        );
        assert!(decode(&mixed, &bound(), "request-1").is_err());
        let mut forged: serde_json::Value =
            serde_json::from_str(&raw(json!("原文"), json!([])).content).unwrap();
        forged["delivery_id"] = json!("forged");
        assert!(decode(
            &Response {
                content: forged.to_string(),
                tool_calls: vec![]
            },
            &bound(),
            "request-1"
        )
        .is_err());
    }
}
