//! Decoder for exactly frozen pre-cutover Evaluation admissions and history.
//! New annotation modes do not select this transport. Never detect it in prose.
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

/// Construct registered annotation fields from the exact frozen definition,
/// validate the whole value, and construct the outer Message deterministically.
/// This is not a JSON repair parser: syntax, types and required fields remain
/// strict. The raw provider value remains in the producing response bundle.
pub fn message(raw: &str, binding: &FormatBinding, limits: &Limits) -> IoResult<Message> {
    message_with_diagnostics(raw, binding, limits).map(|(message, _)| message)
}

fn message_with_diagnostics(
    raw: &str,
    binding: &FormatBinding,
    limits: &Limits,
) -> IoResult<(Message, Vec<String>)> {
    let mut value = Data::parse(raw.as_bytes(), limits)?;
    let mut extras = AnnotationExtras::default();
    // Projection is confined to the display-only annotation subtree of the
    // built-in Evaluation. Never project business body, effects, arguments,
    // routing, arbitrary output formats or the root's closed field boundary.
    if binding.format.id == FORMAT
        && binding.format.version == "1"
        && binding.format.encoding == "json"
    {
        if let (Data::Object(fields), Some(schema)) = (
            &mut value,
            binding
                .definition
                .as_ref()
                .and_then(|definition| definition.schema.as_ref())
                .and_then(|schema| schema.get("properties"))
                .and_then(|properties| properties.get("annotations")),
        ) {
            if let Some(annotations) = fields.get_mut("annotations") {
                extras.project(annotations, schema, "/annotations");
            }
        }
    }
    let message = Message {
        format: binding.format.format(),
        validation: "registered".into(),
        content: Content::Json { value },
    };
    super::validate_content(&message, binding, limits)?;
    Ok((message, extras.diagnostics()))
}

#[derive(Default)]
struct AnnotationExtras {
    paths: Vec<String>,
    omitted: usize,
}

impl AnnotationExtras {
    fn project(&mut self, value: &mut Data, schema: &serde_json::Value, path: &str) {
        match value {
            Data::Object(fields) => {
                let Some(properties) = schema.get("properties").and_then(|v| v.as_object()) else {
                    return;
                };
                fields.retain(|key, value| {
                    let child = format!("{path}/{}", key.replace('~', "~0").replace('/', "~1"));
                    if let Some(rule) = properties.get(key) {
                        self.project(value, rule, &child);
                        true
                    } else if schema.get("additionalProperties").and_then(|v| v.as_bool())
                        == Some(false)
                    {
                        if self.paths.len() < 63 {
                            // Field names only, escaped and bounded; never echo
                            // arbitrary unknown values into model diagnostics.
                            self.paths.push(child.chars().take(192).collect());
                        } else {
                            self.omitted += 1;
                        }
                        false
                    } else {
                        true
                    }
                });
            }
            Data::Array(items) => {
                if let Some(rule) = schema.get("items") {
                    for (index, item) in items.iter_mut().enumerate() {
                        self.project(item, rule, &format!("{path}/{index}"));
                    }
                }
            }
            _ => {} // Missing fields and wrong types must fail full validation.
        }
    }

    fn diagnostics(self) -> Vec<String> {
        let mut diagnostics = self.paths.into_iter().map(|path| {
            format!("Unregistered annotation field at JSON pointer {} excluded from the Runtime-built value; original value retained in raw_response", serde_json::to_string(&path).expect("JSON path"))
        }).collect::<Vec<_>>();
        if self.omitted > 0 {
            diagnostics.push(format!("{} additional unregistered annotation fields excluded; complete original values retained in raw_response", self.omitted));
        }
        diagnostics
    }
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
    pub diagnostics: Vec<String>,
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
    let (message, diagnostics) =
        message_with_diagnostics(&raw.content, output, &Limits::default())?;
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
        diagnostics,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn raw(body: serde_json::Value, effects: serde_json::Value) -> Response {
        Response { content: json!({"body":body,"annotations":{"execution":{"title":"独立盲审","progress":"","result":"审阅完成"},"observations":[]},"effects":effects}).to_string(), tool_calls: vec![] }
    }
    fn bound() -> super::super::response::ReturnBinding {
        let mut binding = super::super::response::ReturnBinding::new(
            "actual-thread",
            3,
            "actual-evaluation",
            true,
        );
        binding.output = Some(super::binding());
        binding
    }
    #[test]
    fn captured_deepseek_extra_annotation_does_not_block_reader_proposals() {
        // Actual failed response from the named TEST workspace import, not a
        // synthesized model success. No user book, credentials or reasoning.
        let raw: Response = serde_json::from_str(include_str!(
            "../../tests/fixtures/session-io-deepseek-annotation-extra.json"
        ))
        .unwrap();
        assert_eq!(
            crate::response_annotations::diagnostics::response_capture(Some(&raw))["sha256"],
            "e2895eac00b51fea4992c48bad7164f8c338f9d4951931769e33b90aff377fc0"
        );
        let decoded = decode(&raw, &bound(), "captured-request").unwrap();
        assert_eq!(decoded.response.tool_calls.len(), 2);
        assert!(!decoded.returning);
        assert!(decoded.response.content.is_empty());
        for (index, operation) in ["reader.contents", "reader.read"].iter().enumerate() {
            let call = &decoded.response.tool_calls[index];
            assert_eq!(call.func_name, "host_morphz");
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&call.arguments).unwrap(),
                json!({"action":"operations","operations":{"action":"describe","operationId":operation}})
            );
        }
        let Content::Json { value } = decoded.message.content else {
            panic!()
        };
        assert!(value
            .get("annotations")
            .unwrap()
            .get("observations_note")
            .is_none());
        assert!(raw.content.contains("observations_note"));
        assert_eq!(decoded.diagnostics.len(), 1);
        assert!(decoded.diagnostics[0].contains("/annotations/observations_note"));
    }
    #[test]
    fn annotation_projection_uses_frozen_registered_fields_without_changing_business_data() {
        let mut binding = bound();
        binding.format.id = "test.native-record".into();
        binding.format.encoding = "json".into();
        let raw = Response {
            content: r#"{"effects":[],"body":{"observations_note":9007199254740993123456789,"text":"正文\n{\"annotations\":1}"},"annotations":{"execution":{"title":"核对原值","progress":"","result":"返回原记录","extra":{"effects":[{"name":"exec"}]}},"observations":[{"ref":"@actual","result":"原观察","extra":false}],"unregistered":null}}"#.into(),
            tool_calls: vec![],
        };
        let decoded = decode(&raw, &binding, "request-1").unwrap();
        assert_eq!(decoded.diagnostics.len(), 3);
        assert!(decoded
            .response
            .content
            .contains("9007199254740993123456789"));
        assert!(decoded.response.content.contains("observations_note"));
        assert!(decoded.response.tool_calls.is_empty());
        let Content::Json { value } = &decoded.message.content else {
            panic!()
        };
        let annotations = value.get("annotations").unwrap();
        assert!(annotations.get("unregistered").is_none());
        assert!(annotations.get("execution").unwrap().get("extra").is_none());
        let Data::Array(observations) = annotations.get("observations").unwrap() else {
            panic!()
        };
        assert!(observations[0].get("extra").is_none());
        assert_eq!(
            observations[0].get("result").and_then(Data::string),
            Some("原观察")
        );

        let args = r#"{"body":null,"annotations":{"execution":{"title":"只读","progress":"读取原文","result":""},"observations":[],"extra":null},"effects":[{"name":"host_morphz","arguments":{"unregistered":9007199254740993123456789,"annotations":{"business":true}},"intent":"原样交给现有工具校验"}]}"#;
        let decoded = decode(
            &Response {
                content: args.into(),
                tool_calls: vec![],
            },
            &bound(),
            "request-2",
        )
        .unwrap();
        assert_eq!(
            decoded.response.tool_calls[0].arguments,
            r#"{"annotations":{"business":true},"unregistered":9007199254740993123456789}"#
        );
    }

    #[test]
    fn extra_annotations_do_not_repair_missing_fields_wrong_types_or_effect_boundaries() {
        let base: serde_json::Value = serde_json::from_str(
            &raw(
                json!(null),
                json!([
                    {"name":"host_morphz","arguments":{},"intent":"核对原文"}
                ]),
            )
            .content,
        )
        .unwrap();
        let mut invalid = vec![];
        for pointer in [
            "/annotations",
            "/annotations/execution",
            "/annotations/execution/title",
            "/annotations/execution/progress",
            "/annotations/execution/result",
            "/annotations/observations",
            "/effects/0/name",
            "/effects/0/intent",
            "/effects/0/arguments",
        ] {
            let mut value = base.clone();
            *value.pointer_mut(pointer).unwrap() = json!(42);
            invalid.push(value);
        }
        for field in ["title", "progress", "result"] {
            let mut value = base.clone();
            value["annotations"]["execution"]
                .as_object_mut()
                .unwrap()
                .remove(field);
            invalid.push(value);
        }
        let mut missing = base.clone();
        missing["annotations"]
            .as_object_mut()
            .unwrap()
            .remove("observations");
        invalid.push(missing);
        let mut root = base.clone();
        root["delivery_id"] = json!("forged");
        invalid.push(root);
        let mut effect = base.clone();
        effect["effects"][0]["extra"] = json!(null);
        invalid.push(effect);
        let mut body = base.clone();
        body["body"] = json!({"text":"not a Chat string"});
        invalid.push(body);
        for mut value in invalid {
            if let Some(fields) = value["annotations"].as_object_mut() {
                fields.insert("observations_note".into(), json!(null));
            }
            assert!(
                decode(
                    &Response {
                        content: value.to_string(),
                        tool_calls: vec![]
                    },
                    &bound(),
                    "request-1"
                )
                .is_err(),
                "{value}"
            );
        }
        for content in [
            r#"{"body":null,"annotations":{"extra":null,"extra":true},"effects":[]}"#,
            r#"{"body":null,"annotations":{"extra":null},"effects":[]} trailing"#,
            r#"{"body":null,"annotations":{"extra":null},"effects":["#,
        ] {
            assert!(decode(
                &Response {
                    content: content.into(),
                    tool_calls: vec![]
                },
                &bound(),
                "request-1"
            )
            .is_err());
        }
    }

    #[test]
    fn annotation_projection_diagnostics_are_bounded_and_unknown_formats_stay_strict() {
        let mut value: serde_json::Value =
            serde_json::from_str(&raw(json!("原文"), json!([])).content).unwrap();
        for index in 0..100 {
            value["annotations"][format!("extra_{index}")] = json!({"private":"DO_NOT_ECHO_VALUE"});
        }
        let decoded = decode(
            &Response {
                content: value.to_string(),
                tool_calls: vec![],
            },
            &bound(),
            "request-1",
        )
        .unwrap();
        assert_eq!(decoded.diagnostics.len(), 64);
        assert!(decoded.diagnostics[63].contains("37 additional"));
        assert!(decoded
            .diagnostics
            .iter()
            .all(|message| !message.contains("DO_NOT_ECHO_VALUE")));
        let mut other = binding();
        other.format.id = "not-an-evaluation".into();
        assert!(message(&value.to_string(), &other, &Limits::default()).is_err());
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
