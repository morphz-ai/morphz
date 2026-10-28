//! One model Evaluation value; Runtime owns its envelope, work identities and
//! terminal state. Display annotations never gate an otherwise valid value.
//! This decoder is selected only by an explicit frozen v2 output binding.
use super::response::{Delivery, ResponseParts, ReturnBinding, ANNOTATIONS_FORMAT};
use super::{Content, Data, Descriptor, Format, FormatBinding, IoError, IoResult, Limits, Message};
use crate::llm::{Response, ToolCallRepr, ToolDefinition};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const VERSION: &str = "2";
/// Operator-verified capability of an exact routed physical endpoint. This is
/// not guessed from a model name or merely from an OpenAI-compatible protocol.
pub const NATIVE_SCHEMA_CAPABILITY: &str = "native-json-schema";

/// Explicit receiving interpretation of a new request on a historical v2
/// binding. Provider generation constraints never change that declared format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Transport {
    EvaluationJson,
}

/// Prepare one new physical request. The selected options and receiving
/// interpretation have one source; replay never calls this function.
pub fn prepare_request(
    binding: &ReturnBinding,
    capabilities: &[String],
    tools: &[ToolDefinition],
) -> (
    ReturnBinding,
    Option<crate::llm::ModelOutputEncoding>,
    Option<crate::llm::ModelToolChoice>,
) {
    let (encoding, choice) = request_options(binding, capabilities, tools);
    let mut bound = binding.clone();
    if selected(binding) {
        bound.legacy_v2_transport = Some(Transport::EvaluationJson);
    }
    (bound, encoding, choice)
}

pub fn request_options(
    binding: &ReturnBinding,
    capabilities: &[String],
    tools: &[ToolDefinition],
) -> (
    Option<crate::llm::ModelOutputEncoding>,
    Option<crate::llm::ModelToolChoice>,
) {
    if selected(binding) {
        if capabilities
            .iter()
            .any(|value| value == NATIVE_SCHEMA_CAPABILITY)
        {
            return (
                Some(crate::llm::ModelOutputEncoding::JsonSchema {
                    name: "morphz_evaluation_v2".into(),
                    schema: generation_schema(binding, tools),
                    // Do not rewrite arbitrary original business schemas to fit a
                    // supplier's closed strict subset or claim constrained decoding.
                    strict: false,
                }),
                Some(crate::llm::ModelToolChoice::None),
            );
        }
        // Context still declares the same Evaluation JSON value without an
        // upstream constraint. Absence of native Schema support is not an
        // ordinary-text contract or permission to sniff a different carrier.
        return (None, None);
    }
    (
        binding
            .output
            .as_ref()
            .map(|_| crate::llm::ModelOutputEncoding::JsonObject),
        None,
    )
}

pub fn descriptor() -> Descriptor {
    Descriptor {
        id: super::evaluation::FORMAT.into(),
        version: VERSION.into(),
        encodings: vec!["json".into()],
        publisher: "morphz".into(),
        required_visible_paths: vec![],
        resource_paths: vec![],
        contract: Some("One returned business body and/or real work proposals with optional display annotations. Runtime constructs identities, validates work and commits results. No annotation companion call or text markers. Missing display metadata is valid; no metadata repair requests.".into()),
        // This is the receiving schema. The generation schema below asks for
        // applicable annotations explicitly, but their absence is not a gate.
        schema: Some(json!({"type":"object","additionalProperties":false,
            "properties":{
                "body":{},
                "effects":{"type":"array","items":{"type":"object",
                    "additionalProperties":false,"required":["name","arguments"],
                    "properties":{"name":{"type":"string"},"arguments":{"type":"object"},"intent":{}}}},
                "annotations":{}
            }})),
    }
}

pub fn binding() -> FormatBinding {
    super::Registry::default()
        .resolve(
            &Format::new(super::evaluation::FORMAT, VERSION),
            "json",
            "registered",
        )
        .expect("registered unified Evaluation")
}

pub fn selected(binding: &ReturnBinding) -> bool {
    binding.output.as_ref().is_some_and(|output| {
        output.format.id == super::evaluation::FORMAT
            && output.format.version == VERSION
            && output.format.encoding == "json"
    })
}

/// Native API constraint, not a prompt-only imitation or a claim that the
/// selected service enforces it. Existing arbitrary business argument objects
/// are intentionally not rewritten to satisfy a supplier's strict subset.
pub fn generation_schema(binding: &ReturnBinding, tools: &[ToolDefinition]) -> Value {
    let mut body = if let Some(schema) = &binding.body_value_schema {
        schema.clone()
    } else if binding.format.id == "morphz.chat" || binding.format.encoding == "utf8" {
        json!({"type":"string"})
    } else {
        binding
            .caller
            .as_ref()
            .and_then(|binding| binding.definition.as_ref())
            .and_then(|definition| definition.schema.clone())
            .unwrap_or_else(|| json!({}))
    };
    // Yao nominal schemas use document-root refs. Lift their original $defs
    // into the Evaluation document instead of leaving dangling refs beneath
    // properties.body. Do not re-encode or weaken the business definition.
    let body_definitions = body
        .as_object_mut()
        .and_then(|fields| fields.remove("$defs"));
    let mut annotations = crate::response_annotations::annotation_schema();
    annotations["description"] = json!("When enabled, supply applicable actual-work title/progress/result and observation explanations. This is display metadata, not body, authority, execution state or a reason to request another turn. For ordinary no-work chat use null.");
    // Per-call intent belongs next to the proposal it describes, not to a
    // second index list which can drift to the following physical response.
    annotations["properties"]
        .as_object_mut()
        .unwrap()
        .remove("calls");
    annotations["properties"]
        .as_object_mut()
        .unwrap()
        .remove("intent");
    let mut schema = json!({"type":"object","additionalProperties":false,
    "required":["body","effects","annotations"],"properties":{
        "body":{"anyOf":[body,{"type":"null"}],"description":"Complete original caller value, or null while working; never a Message envelope or a second JSON-encoded value. Runtime constructs the external envelope."},
        "effects":{"type":"array","items":{"type":"object","additionalProperties":false,
            "required":["name","arguments","intent"],"properties":{
                "name":{"type":"string","enum":tools.iter().map(|tool| &tool.name).collect::<Vec<_>>()},
                "arguments":{"type":"object","description":"The exact original business parameters from this tool's unchanged definition; no annotations, IDs or permission flags added."},
                "intent":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"When annotations are enabled, explain this actual work step and why before it runs. Never a result claim. For communication/control or disabled annotations use null."}
            }}},
        "annotations":{"anyOf":[annotations,{"type":"null"}]}
    }});
    if tools.is_empty() {
        schema["properties"]["effects"] =
            json!({"type":"array","maxItems":0,"items":{"type":"object"}});
    }
    if let Some(definitions) = body_definitions {
        schema["$defs"] = definitions;
    }
    schema
}

fn fail(message: &str) -> IoError {
    IoError::new("invalid_delivery_contract", message)
}

fn note(notes: &mut Vec<String>, path: &str, message: &str) {
    if notes.len() < 64 {
        notes.push(format!(
            "{message} at JSON pointer {}; raw response preserved",
            json!(path.chars().take(192).collect::<String>())
        ));
    }
}

fn implicit(raw: &Response, binding: &ReturnBinding) -> IoResult<ResponseParts> {
    if raw.content.trim().is_empty() && raw.tool_calls.is_empty() {
        return Err(fail("A return requires a complete body or actual work"));
    }
    // A native work response is still subject to the original function schema
    // and authorization path. It gains no invented annotation or new authority.
    check_native_deliveries(raw, binding)?;
    if binding.format.id != "morphz.chat"
        && !raw.tool_calls.is_empty()
        && !raw.content.trim().is_empty()
    {
        return Err(fail("A pending typed result cannot accompany native work"));
    }
    if raw.tool_calls.is_empty() && binding.format.id != "morphz.chat" {
        if let Some(caller) = &binding.caller {
            if caller.format != binding.format {
                return Err(fail("Caller definition differs from its frozen format"));
            }
            let content = if binding.format.encoding == "utf8" {
                Content::Utf8 {
                    value: raw.content.clone(),
                }
            } else {
                Content::Json {
                    value: Data::parse(raw.content.as_bytes(), &Limits::default())?,
                }
            };
            super::validate_content(
                &Message {
                    format: binding.format.format(),
                    validation: caller.validation.clone(),
                    content,
                },
                caller,
                &Limits::default(),
            )?;
        }
    }
    Ok(ResponseParts {
        response: raw.clone(),
        body_message: None,
        annotation_messages: vec![],
        diagnostics: vec![],
    })
}

fn check_native_deliveries(raw: &Response, binding: &ReturnBinding) -> IoResult<()> {
    for call in raw
        .tool_calls
        .iter()
        .filter(|call| call.func_name == "deliver_message")
    {
        let arguments = Data::parse(call.arguments.as_bytes(), &Limits::default())?;
        if forbidden_delivery(&arguments, binding) {
            return Err(fail(
                "A unified return cannot use a separate body or annotation delivery carrier",
            ));
        }
    }
    Ok(())
}

fn forbidden_delivery(arguments: &Data, binding: &ReturnBinding) -> bool {
    arguments.get("delivery_id").and_then(Data::string) == Some(binding.delivery_id.as_str())
        || arguments
            .get("message")
            .and_then(|value| value.get("format"))
            .and_then(|value| value.get("id"))
            .and_then(Data::string)
            == Some(ANNOTATIONS_FORMAT)
}

pub fn decode(raw: &Response, binding: &ReturnBinding, attempt: &str) -> IoResult<ResponseParts> {
    if !selected(binding) {
        return Err(fail("No frozen unified Evaluation binding"));
    }
    check_native_deliveries(raw, binding)?;
    match binding.legacy_v2_transport {
        Some(Transport::EvaluationJson) if !raw.tool_calls.is_empty() => {
            return Err(fail(
                "The declared Evaluation JSON carrier disallows native calls",
            ));
        }
        _ => {}
    }
    if raw.content.trim().is_empty() {
        if binding.legacy_v2_transport == Some(Transport::EvaluationJson) {
            return Err(fail("The requested Evaluation JSON value is missing"));
        }
        return implicit(raw, binding);
    }
    let parsed = match Data::parse(raw.content.as_bytes(), &Limits::default()) {
        Ok(value) => value,
        Err(error) => {
            // Ordinary native prose is the implicit form, never scanned for
            // embedded JSON, delimiters or annotation tags. A broken JSON value
            // in the bound structured channel must not leak as a JSON draft.
            if binding.legacy_v2_transport.is_none()
                && binding.format.id == "morphz.chat"
                && !raw.content.trim_start().starts_with(['{', '[', '"'])
            {
                return implicit(raw, binding);
            }
            return Err(error);
        }
    };
    let Data::Object(fields) = &parsed else {
        if binding.legacy_v2_transport == Some(Transport::EvaluationJson) {
            return Err(fail("The requested Evaluation JSON must be an object"));
        }
        let mut implicit_raw = raw.clone();
        if binding.format.id == "morphz.chat" {
            if let Data::String(text) = parsed {
                implicit_raw.content = text;
            }
        }
        return implicit(&implicit_raw, binding);
    };
    if !["body", "effects", "annotations"]
        .iter()
        .any(|name| fields.contains_key(*name))
    {
        if binding.legacy_v2_transport == Some(Transport::EvaluationJson) {
            return Err(fail(
                "The requested Evaluation JSON has no body or work fields",
            ));
        }
        return implicit(raw, binding);
    }
    let mut notes = vec![];
    for key in fields
        .keys()
        .filter(|key| !["body", "effects", "annotations"].contains(&key.as_str()))
    {
        note(
            &mut notes,
            &format!("/{key}"),
            "Unregistered outer field not used to construct the Runtime value",
        );
    }
    let effects = match fields.get("effects") {
        None => &[][..],
        Some(Data::Array(effects)) if effects.len() <= 64 => effects.as_slice(),
        Some(Data::Array(_)) => {
            return Err(IoError::new(
                "message_limit_exceeded",
                "Too many Evaluation effects",
            ))
        }
        _ => return Err(fail("effects must be an array of actual work proposals")),
    };
    if !raw.tool_calls.is_empty() && !effects.is_empty() {
        return Err(fail(
            "Native calls and Evaluation effects cannot both be executed",
        ));
    }
    let working = !effects.is_empty() || !raw.tool_calls.is_empty();
    let body = fields.get("body").unwrap_or(&Data::Null);
    if working && binding.format.id != "morphz.chat" && !matches!(body, Data::Null) {
        return Err(fail(
            "A typed business body cannot return while work is pending",
        ));
    }
    let text = match body {
        Data::Null if working => String::new(),
        _ if binding.format.id != "morphz.chat" && binding.format.encoding == "json" => body.json(),
        Data::String(text) => text.clone(),
        Data::Null => String::new(),
        _ => return Err(fail("The bound text body must be its original string")),
    };
    if !working && text.trim().is_empty() {
        return Err(fail(
            "Annotations alone are not an answer; missing complete body",
        ));
    }
    if !working && !fields.contains_key("body") {
        return Err(fail("Missing actual body"));
    }
    if !working && binding.format.id != "morphz.chat" {
        if let Some(caller) = binding.caller.as_ref() {
            if caller.format != binding.format {
                return Err(fail("Caller definition differs from its frozen format"));
            }
            let content = if binding.format.encoding == "utf8" {
                Content::Utf8 {
                    value: text.clone(),
                }
            } else {
                Content::Json {
                    value: body.clone(),
                }
            };
            super::validate_content(
                &Message {
                    format: binding.format.format(),
                    validation: caller.validation.clone(),
                    content,
                },
                caller,
                &Limits::default(),
            )?;
        }
    }
    let mut calls = raw.tool_calls.clone();
    let mut intents = vec![];
    for (index, effect) in effects.iter().enumerate() {
        let effect = effect.object()?;
        let name = effect
            .get("name")
            .and_then(Data::string)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| fail("Each effect requires its actual tool name"))?;
        let arguments = effect
            .get("arguments")
            .filter(|value| matches!(value, Data::Object(_)))
            .ok_or_else(|| fail("Effect business arguments must be an object"))?;
        if name == "deliver_message" && forbidden_delivery(arguments, binding) {
            return Err(fail(
                "Body and annotations belong to this value, not a delivery effect",
            ));
        }
        if name == "no_reply" && effects.len() != 1 {
            return Err(fail("no_reply must be the only work/control call"));
        }
        if attempt.is_empty() {
            return Err(fail("Work has no Runtime attempt identity"));
        }
        let id = format!(
            "effect_{}",
            super::hash(&(&binding.delivery_id, attempt, index)).trim_start_matches("sha256:")
        );
        calls.push(ToolCallRepr {
            id,
            r#type: "function".into(),
            func_name: name.into(),
            arguments: arguments.json(),
        });
        if binding.annotations_enabled && !matches!(name, "no_reply" | "deliver_message") {
            match effect.get("intent") {
                Some(Data::String(intent))
                    if !intent.trim().is_empty() && intent.chars().count() <= 256 =>
                {
                    intents.push(Data::from_value(&json!({"index":index,"intent":intent})))
                }
                Some(Data::Null) | None => {}
                _ => note(
                    &mut notes,
                    &format!("/effects/{index}/intent"),
                    "Invalid optional intent excluded",
                ),
            }
        }
        for key in effect
            .keys()
            .filter(|key| !["name", "arguments", "intent"].contains(&key.as_str()))
        {
            note(
                &mut notes,
                &format!("/effects/{index}/{key}"),
                "Unregistered proposal field excluded; business arguments unchanged",
            );
        }
    }
    let mut annotations = match fields.get("annotations") {
        Some(value) if binding.annotations_enabled && !matches!(value, Data::Null) => {
            super::response::project_annotations(value, &mut notes)
                .and_then(|value| value.object().ok().cloned())
                .unwrap_or_default()
        }
        _ => Default::default(),
    };
    // Never accept a second index list as authority over this value's effects.
    // The intent/proposal association is constructed only from actual effects.
    annotations.remove("calls");
    annotations.remove("intent");
    if !intents.is_empty() {
        annotations.insert("calls".into(), Data::Array(intents));
    }
    let annotation_messages = if annotations.is_empty() {
        vec![]
    } else {
        vec![Delivery {
            delivery_id: format!(
                "annotations_{}",
                super::hash(&(&binding.delivery_id, attempt)).trim_start_matches("sha256:")
            ),
            message: Message {
                format: Format::new(ANNOTATIONS_FORMAT, "1"),
                validation: "registered".into(),
                content: Content::Json {
                    value: Data::Object(annotations),
                },
            },
        }]
    };
    Ok(ResponseParts {
        response: Response {
            content: text,
            tool_calls: calls,
        },
        body_message: None,
        annotation_messages,
        diagnostics: notes,
    })
}
