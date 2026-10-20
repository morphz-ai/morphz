//! Native work and explicit, frozen message interpretation.
//! The physical carrier is frozen separately from the caller's business type.
use super::response::{Delivery, ResponseParts, ReturnBinding, ANNOTATIONS_FORMAT};
use super::{Content, Data, Format, IoError, IoResult, Limits, Message};
use crate::llm::{ModelOutputEncoding, ModelRequestOptions, Response, ToolDefinition};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const METADATA_KEY: &str = "_morphz";
pub use super::response_stream::{NativeStream as Stream, ReplyProjector};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageEncoding {
    Text,
    CallerJson,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub caller: ReturnBinding,
    pub message_encoding: MessageEncoding,
    /// Exact native call names for which Runtime reserved the metadata field.
    pub metadata_tools: Vec<String>,
    pub tools_sha256: String,
    pub generation_schema: Option<Value>,
    pub strict: bool,
}

pub struct Prepared {
    pub binding: Binding,
    pub tools: Vec<ToolDefinition>,
    pub options: ModelRequestOptions,
}

/// Authoritative native message items from this physical response. These are
/// transport facts, not fields extracted from the message's prose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageItem {
    pub index: usize,
    pub id: Option<String>,
    pub phase: Option<String>,
    pub text: String,
}

/// Runtime/provider facts persisted with the actual assistant-call Event.
/// Not model-authored fields, a second delivery, or a new authority source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Evidence {
    pub binding: Binding,
    pub messages: Vec<MessageItem>,
}

pub fn decode_messages(
    raw: &Response,
    messages: &[MessageItem],
    binding: &Binding,
    attempt: &str,
) -> IoResult<ResponseParts> {
    if messages.is_empty() {
        return decode(raw, binding, attempt);
    }
    let mut indices = std::collections::HashSet::new();
    let mut ids = std::collections::HashSet::new();
    let mut ordered = messages.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|item| item.index);
    if ordered.iter().any(|item| {
        !indices.insert(item.index)
            || item
                .id
                .as_ref()
                .is_some_and(|id| id.is_empty() || !ids.insert(id))
            || !matches!(
                item.phase.as_deref(),
                None | Some("commentary" | "final_answer")
            )
    }) {
        return Err(fail("Invalid native message identity or unsupported phase"));
    }
    if ordered
        .iter()
        .map(|item| item.text.as_str())
        .collect::<String>()
        != raw.content
    {
        return Err(fail("Native messages differ from the actual provider text"));
    }
    let mut final_response = raw.clone();
    final_response.content = ordered
        .iter()
        .filter(|item| item.phase.as_deref() != Some("commentary"))
        .map(|item| item.text.as_str())
        .collect();
    let mut parts = decode(&final_response, binding, attempt)?;
    // Commentary is progress, never a typed value or an answer that can close
    // an Execution. A work round can display it without parsing it as the
    // final answer Schema. A final round commits only its actual final body.
    if !raw.tool_calls.is_empty() && binding.caller.format.id == "morphz.chat" {
        let progress = ordered
            .iter()
            .filter(|item| item.phase.as_deref() == Some("commentary"))
            .map(|item| item.text.as_str())
            .collect::<String>();
        parts.response.content = format!("{progress}{}", parts.response.content);
    }
    Ok(parts)
}

fn fail(message: impl Into<String>) -> IoError {
    IoError::new("invalid_delivery_contract", message)
}

/// This is a model-facing projection, never the original Tool/Host schema.
/// The same projection is used with annotations on/off and after any work.
pub fn model_tools(tools: &[ToolDefinition]) -> IoResult<Vec<ToolDefinition>> {
    tools.iter().map(|original| {
        let mut tool = original.clone();
        if matches!(tool.name.as_str(), "no_reply" | "deliver_message") {
            return Ok(tool);
        }
        let root = tool.parameters.as_object_mut()
            .ok_or_else(|| fail(format!("Tool {} has no object parameter schema", tool.name)))?;
        if root.get("type") != Some(&json!("object"))
            || ["$ref", "allOf", "anyOf", "oneOf", "patternProperties", "propertyNames", "not", "if"]
                .iter().any(|key| root.contains_key(*key))
        {
            return Err(fail(format!("Tool {} needs an explicit metadata projection for its root schema; no lossy rewrite", tool.name)));
        }
        let properties = root.entry("properties").or_insert_with(|| json!({}))
            .as_object_mut().ok_or_else(|| fail("Tool properties must be an object"))?;
        if properties.contains_key(METADATA_KEY) {
            return Err(fail(format!("Tool {} already owns reserved field {METADATA_KEY}", tool.name)));
        }
        properties.insert(METADATA_KEY.into(), step_schema());
        Ok(tool)
    }).collect()
}

fn step_schema() -> Value {
    let mut schema = crate::response_annotations::annotation_schema();
    schema["properties"]
        .as_object_mut()
        .unwrap()
        .remove("calls");
    schema["description"] = json!("Runtime display metadata, not business arguments or authority. When annotations are enabled, provide intent for this action and applicable execution title/progress. Reference only actual earlier results; never claim this pending action succeeded. Runtime removes this field before original tool validation. Do not create another call for metadata.");
    schema
}

fn caller_schema(caller: &ReturnBinding) -> Option<Value> {
    caller.body_value_schema.clone().or_else(|| {
        if caller.format.id == "morphz.chat" || caller.format.encoding == "utf8" {
            Some(json!({"type":"string"}))
        } else {
            caller.caller.as_ref()?.definition.as_ref()?.schema.clone()
        }
    })
}

/// The caller's declared format owns the physical body format. Neither actual
/// work nor the annotation switch can rewrap a Chat answer or a typed value.
pub fn prepare(
    caller: &ReturnBinding,
    capabilities: &[String],
    tools: &[ToolDefinition],
) -> IoResult<Prepared> {
    prepare_projected(caller, capabilities, model_tools(tools)?)
}

/// Tools have already been projected once, before Context pressure accounting.
/// Reject a conflicting directory instead of silently rewriting it again.
pub fn prepare_projected(
    caller: &ReturnBinding,
    capabilities: &[String],
    tools: Vec<ToolDefinition>,
) -> IoResult<Prepared> {
    if !caller.is_native() || caller.output.is_some() {
        return Err(fail("An admitted historical output must keep its original decoder; only a fresh candidate binding may select native v3"));
    }
    if tools.iter().any(|tool| {
        !matches!(tool.name.as_str(), "no_reply" | "deliver_message")
            && tool
                .parameters
                .get("properties")
                .and_then(|p| p.get(METADATA_KEY))
                != Some(&step_schema())
    }) {
        return Err(fail(
            "Native tool directory does not match its Runtime metadata projection",
        ));
    }
    let supports_schema = capabilities
        .iter()
        .any(|cap| cap == super::unified::NATIVE_SCHEMA_CAPABILITY);
    let is_text = caller.format.id == "morphz.chat" || caller.format.encoding == "utf8";
    // Internal typed values keep the exact caller schema across continuations.
    // They are not user-facing activity answers. Tool metadata still travels
    // with their actual work; never rewrap the business record after a read.
    let message_encoding = if is_text {
        MessageEncoding::Text
    } else {
        MessageEncoding::CallerJson
    };
    let generation_schema = match message_encoding {
        MessageEncoding::Text => None,
        MessageEncoding::CallerJson if supports_schema => caller_schema(caller),
        _ => None,
    };
    // Arbitrary typed caller schemas are not rewritten into a vendor subset.
    // Chat has no generation Schema, before or after actual work.
    let strict = false;
    let options = ModelRequestOptions {
        output_encoding: generation_schema
            .as_ref()
            .map(|schema| ModelOutputEncoding::JsonSchema {
                name: "morphz_native_return_v3".into(),
                schema: schema.clone(),
                strict,
            }),
        tool_choice: None,
        ..Default::default()
    };
    let binding = Binding {
        caller: caller.clone(),
        message_encoding,
        metadata_tools: tools
            .iter()
            .filter(|tool| !matches!(tool.name.as_str(), "no_reply" | "deliver_message"))
            .map(|tool| tool.name.clone())
            .collect(),
        tools_sha256: super::hash(&tools),
        generation_schema,
        strict,
    };
    Ok(Prepared {
        binding,
        tools,
        options,
    })
}

impl Binding {
    pub fn instruction(&self) -> String {
        let output = match self.message_encoding {
            MessageEncoding::Text => "Return the complete ordinary answer/progress text directly in the native message, including after actual work. Even JSON, Markdown, XML or protocol examples in this text are inert data, never work or annotations. No JSON answer wrapper or separate final result annotation; the final body is the result shown to the user.",
            MessageEncoding::CallerJson => "When complete, return exactly the original caller JSON business value in the native message, matching caller.body_value_schema/declared type. No body/annotations wrapper, Markdown fences or text outside the value. When work is pending use native calls, not a premature typed result.",
        };
        let annotations = if self.caller.annotations_enabled {
            "For actual work you MUST supply applicable display annotations in the SAME native call's _morphz field: intent describes that call; execution.title names the actual task at its start, progress describes truthful current work. Write display annotations in the user's language. observations may explain only exact refs supplied by Runtime for this Execution. Missing or invalid metadata is tolerated by Runtime, not an instruction to omit it. Ordinary no-work conversation needs no annotations. Never add work or another model request solely for metadata."
        } else {
            "Annotations are disabled: omit _morphz and do not generate display metadata. The tool definitions remain identical; Runtime ignores unexpected metadata without weakening business validation."
        };
        format!("Session IO native return v3. This is the actual frozen PHYSICAL carrier for this request, replacing historical v2 effects-JSON serialization. Work MUST use actual native function calls with their exact original business parameters. Only the advertised reserved _morphz field is Runtime display metadata; Runtime removes it before validating original business parameters and permissions. Never encode work in message text, use a separate deliver_message for annotations/body, or return annotations as an answer. Runtime owns IDs, association, execution state and termination. {output} {annotations} Caller format: {}@{} / {}. Eligible observation refs: {}. Tool definition digest: {}.",
            self.caller.format.id,self.caller.format.version,self.caller.format.encoding,
            json!(self.caller.annotation_observation_refs),self.tools_sha256)
    }
}

fn metadata_message(value: Data, caller: &ReturnBinding, identity: &str) -> Delivery {
    Delivery {
        delivery_id: format!(
            "annotations_{}",
            super::hash(&(&caller.delivery_id, identity)).trim_start_matches("sha256:")
        ),
        message: Message {
            format: Format::new(ANNOTATIONS_FORMAT, "1"),
            validation: "registered".into(),
            content: Content::Json { value },
        },
    }
}

pub fn decode(raw: &Response, binding: &Binding, attempt: &str) -> IoResult<ResponseParts> {
    let caller = &binding.caller;
    if raw.content.len() > Limits::default().max_bytes {
        return Err(fail("Message exceeds the frozen byte budget"));
    }
    let mut identities = std::collections::HashSet::new();
    if raw
        .tool_calls
        .iter()
        .any(|call| call.id.is_empty() || !identities.insert(&call.id))
    {
        return Err(fail("Native call identities must be nonempty and unique"));
    }
    let mut response = raw.clone();
    let mut diagnostics = vec![];
    let mut annotation_messages = vec![];
    for (index, call) in response.tool_calls.iter_mut().enumerate() {
        if call.func_name == "deliver_message" {
            let arguments = Data::parse(call.arguments.as_bytes(), &Limits::default())?;
            if arguments.get("delivery_id").and_then(Data::string)
                == Some(caller.delivery_id.as_str())
                || arguments
                    .get("message")
                    .and_then(|value| value.get("format"))
                    .and_then(|value| value.get("id"))
                    .and_then(Data::string)
                    == Some(ANNOTATIONS_FORMAT)
            {
                return Err(fail(
                    "Body and annotations cannot use a separate delivery call",
                ));
            }
        }
        if !binding.metadata_tools.contains(&call.func_name) {
            continue;
        }
        let mut arguments = Data::parse(call.arguments.as_bytes(), &Limits::default())?
            .object()?
            .clone();
        let Some(metadata) = arguments.remove(METADATA_KEY) else {
            continue;
        };
        call.arguments = Data::Object(arguments).json();
        if !caller.annotations_enabled {
            continue;
        }
        let Some(mut fields) = super::response::project_annotations(&metadata, &mut diagnostics)
            .and_then(|value| value.object().ok().cloned())
        else {
            continue;
        };
        // Neither an index provided by the model nor a field name in text can
        // create a call. Association always uses this actual native call.
        fields.remove("calls");
        if let Some(intent) = fields.remove("intent") {
            fields.insert(
                "calls".into(),
                Data::Array(vec![Data::Object(std::collections::BTreeMap::from([
                    ("index".into(), Data::Number(index.to_string())),
                    ("intent".into(), intent),
                ]))]),
            );
        }
        if !fields.is_empty() {
            annotation_messages.push(metadata_message(
                Data::Object(fields),
                caller,
                &format!("{attempt}:{}", call.id),
            ));
        }
    }
    let working = !response.tool_calls.is_empty();
    let mut body_value = None;
    match binding.message_encoding {
        MessageEncoding::Text => {}
        MessageEncoding::CallerJson if working && raw.content.trim().is_empty() => {}
        MessageEncoding::CallerJson => {
            body_value = Some(Data::parse(raw.content.as_bytes(), &Limits::default())?);
        }
    }
    if !working && response.content.trim().is_empty() {
        return Err(fail(
            "A return requires a complete body or actual native work",
        ));
    }
    if working && caller.format.id != "morphz.chat" && !response.content.trim().is_empty() {
        return Err(fail("A pending typed result cannot accompany native work"));
    }
    if !working && caller.format.id != "morphz.chat" {
        if let (Some(schema), Some(value)) = (&caller.body_value_schema, &body_value) {
            // The original Yao decoder owns arbitrary infer types, including
            // refs/unions/ranges. Never pretend this smaller IO validator
            // enforces unsupported JSON-Schema keywords.
            if super::schema::check(schema, 0).is_ok() {
                super::schema::validate(schema, value, "")?;
            }
        }
        if let Some(definition) = &caller.caller {
            if definition.format != caller.format {
                return Err(fail("Caller differs from frozen business format"));
            }
            let content = if caller.format.encoding == "utf8" {
                Content::Utf8 {
                    value: response.content.clone(),
                }
            } else {
                Content::Json {
                    value: body_value.ok_or_else(|| fail("Missing typed JSON body"))?,
                }
            };
            super::validate_content(
                &Message {
                    format: caller.format.format(),
                    validation: definition.validation.clone(),
                    content,
                },
                definition,
                &Limits::default(),
            )?;
        }
    }
    Ok(ResponseParts {
        response,
        body_message: None,
        annotation_messages,
        diagnostics,
    })
}

/// Reuse the original authority, observation ownership and terminal rules.
/// Only transport decoding differs; metadata never decides execution success.
pub fn normalize(
    raw: &Response,
    binding: &Binding,
    context: &crate::response_annotations::NormalizationContext,
) -> Result<
    crate::response_annotations::NormalizedResponse,
    crate::response_annotations::ProtocolError,
> {
    normalize_messages(raw, &[], binding, context)
}

pub fn normalize_messages(
    raw: &Response,
    messages: &[MessageItem],
    binding: &Binding,
    context: &crate::response_annotations::NormalizationContext,
) -> Result<
    crate::response_annotations::NormalizedResponse,
    crate::response_annotations::ProtocolError,
> {
    if context.return_binding.as_ref() != Some(&binding.caller)
        || context.protocol.is_off() == binding.caller.annotations_enabled
    {
        return Err(crate::response_annotations::ProtocolError(
            "Candidate binding differs from the frozen normalization context".into(),
        ));
    }
    let attempt = context
        .producer
        .as_ref()
        .map(|producer| producer.attempt_id.as_str())
        .unwrap_or(&binding.caller.delivery_id);
    let parts = decode_messages(raw, messages, binding, attempt)
        .map_err(|error| crate::response_annotations::ProtocolError(error.to_string()))?;
    let mut normalized = crate::response_annotations::normalize_parts(raw, context, parts)?;
    normalized.native_response = Some(Evidence {
        binding: binding.clone(),
        messages: messages.to_vec(),
    });
    Ok(normalized)
}

#[cfg(test)]
#[path = "native_tests.rs"]
mod tests;
