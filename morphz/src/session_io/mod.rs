//! Experimental Session IO contracts. Transport data, execution authority and
//! presentation preferences have separate, immutable boundaries.
pub mod data;
pub mod fence;
pub(crate) mod file_lock;
pub(crate) mod output;
pub mod projection;
pub mod resources;
pub(crate) mod schema;
pub(crate) mod stream;
#[cfg(test)]
mod tests;

pub use data::{Data, Limits};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub type IoResult<T> = Result<T, IoError>;

/// Decode only Runtime-persisted typed payloads, without domain number coercion.
pub fn event_message(event: &crate::event::Event) -> Option<Message> {
    event
        .payload
        .get("session_io")
        .cloned()
        .and_then(|value| serde_json::from_value::<AcceptedInput>(value).ok())
        .map(|input| input.request.message)
        .or_else(|| {
            event
                .payload
                .get("io_message")
                .cloned()
                .and_then(|value| serde_json::from_value(value).ok())
        })
}

/// Read adapter only: historical Events and their idempotency fingerprints
/// remain unchanged. Enable this projection only for an IO-aware Context.
pub fn standard_chat_event(event: &crate::event::Event) -> Option<Message> {
    if event.payload.contains_key("session_io")
        || event.payload.contains_key("io_message")
        || !(event.event_type == crate::event::TYPE_USER_MESSAGE || event.topic == "chat/reply")
    {
        return None;
    }
    let mut message = Message::chat(
        event
            .payload
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .into(),
    );
    if let Content::Json {
        value: Data::Object(content),
    } = &mut message.content
    {
        if let Some(attachments) = event.payload.get("attachments").and_then(Value::as_array) {
            content.insert(
                "attachments".into(),
                Data::Array(
                    attachments
                        .iter()
                        .map(|metadata| {
                            Data::from_value(&json!({"resource_id":resources::public_metadata(&event.id, metadata)["resource_id"]}))
                        })
                        .collect(),
                ),
            );
        }
        if let Some(references) = event.payload.get("references") {
            content.insert("references".into(), Data::from_value(references));
        }
    }
    Some(message)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IoError {
    pub code: String,
    pub message: String,
}
impl IoError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
    pub fn status(&self) -> u16 {
        match self.code.as_str() {
            "unauthenticated" => 401,
            "forbidden" => 403,
            "unsupported_io_version" => 400,
            "idempotency_conflict" | "format_definition_mismatch" => 409,
            "message_limit_exceeded" => 413,
            "unavailable" => 503,
            _ => 422,
        }
    }
}
impl std::fmt::Display for IoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for IoError {}

fn version_one() -> String {
    "1".into()
}
fn evaluate() -> String {
    "evaluate".into()
}
fn registered() -> String {
    "registered".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Format {
    pub id: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract_hash: Option<String>,
}
impl Format {
    pub fn new(id: &str, version: &str) -> Self {
        Self {
            id: id.into(),
            version: version.into(),
            schema_hash: None,
            contract_hash: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "encoding", rename_all = "snake_case", deny_unknown_fields)]
pub enum Content {
    Json { value: Data },
    Utf8 { value: String },
    Resource { resource_id: String },
}
impl Content {
    pub fn encoding(&self) -> &str {
        match self {
            Self::Json { .. } => "json",
            Self::Utf8 { .. } => "utf8",
            Self::Resource { .. } => "resource",
        }
    }
    pub fn expression(&self) -> crate::sexpr::SExpr {
        use crate::sexpr::SExpr::{Atom, List};
        match self {
            Self::Json { value } => List(vec![Atom("json".into()), value.expression()]),
            Self::Utf8 { value } => List(vec![
                Atom("utf8".into()),
                Data::String(value.clone()).expression(),
            ]),
            Self::Resource { resource_id } => {
                List(vec![Atom("resource".into()), Atom(resource_id.clone())])
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Message {
    pub format: Format,
    #[serde(default = "registered")]
    pub validation: String,
    pub content: Content,
}
impl Message {
    pub fn chat(text: String) -> Self {
        Self {
            format: Format::new("morphz.chat", "1"),
            validation: registered(),
            content: Content::Json {
                value: Data::Object(BTreeMap::from([
                    ("text".into(), Data::String(text)),
                    ("attachments".into(), Data::Array(vec![])),
                    ("references".into(), Data::Array(vec![])),
                ])),
            },
        }
    }
    /// The original domain JSON, reconstructed without a floating-point conversion.
    pub fn wire_data(&self) -> Data {
        let mut content = BTreeMap::from([(
            "encoding".into(),
            Data::String(self.content.encoding().into()),
        )]);
        match &self.content {
            Content::Json { value } => {
                content.insert("value".into(), value.clone());
            }
            Content::Utf8 { value } => {
                content.insert("value".into(), Data::String(value.clone()));
            }
            Content::Resource { resource_id } => {
                content.insert("resource_id".into(), Data::String(resource_id.clone()));
            }
        }
        Data::Object(BTreeMap::from([
            ("format".into(), Data::from_value(&json!(self.format))),
            ("validation".into(), Data::String(self.validation.clone())),
            ("content".into(), Data::Object(content)),
        ]))
    }
    /// Display/search hint only. Context Encoding always uses the typed content.
    pub fn summary(&self) -> String {
        match &self.content {
            Content::Utf8 { value } => value.clone(),
            Content::Json { value } => value
                .get("text")
                .and_then(Data::string)
                .unwrap_or("")
                .into(),
            Content::Resource { .. } => String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct OutputFormat {
    pub id: String,
    pub version: String,
    pub encoding: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract_hash: Option<String>,
}
impl OutputFormat {
    pub fn chat() -> Self {
        Self {
            id: "morphz.chat".into(),
            version: "1".into(),
            encoding: "json".into(),
            schema_hash: None,
            contract_hash: None,
        }
    }
    pub fn format(&self) -> Format {
        Format {
            id: self.id.clone(),
            version: self.version.clone(),
            schema_hash: self.schema_hash.clone(),
            contract_hash: self.contract_hash.clone(),
        }
    }
    pub fn same_type(&self, other: &Self) -> bool {
        self.id == other.id && self.version == other.version && self.encoding == other.encoding
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Delivery {
    pub accept_formats: Option<Vec<OutputFormat>>,
    #[serde(default)]
    pub required_formats: Vec<OutputFormat>,
    #[serde(default)]
    pub require_schema: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Activation {
    #[serde(default = "evaluate")]
    pub mode: String,
    pub dispatch_mode: Option<crate::memory::MessageDispatchMode>,
    pub model_alias: Option<String>,
    pub reasoning_effort: Option<String>,
    pub target_id: Option<String>,
    pub harness: Option<crate::harness::ExactHarnessRef>,
    pub input_destination: Option<crate::steering::InputDestination>,
}
impl Default for Activation {
    fn default() -> Self {
        Self {
            mode: evaluate(),
            dispatch_mode: None,
            model_alias: None,
            reasoning_effort: None,
            target_id: None,
            harness: None,
            input_destination: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub io_version: String,
    pub client_message_id: String,
    pub message: Message,
    #[serde(default)]
    pub activation: Activation,
    #[serde(default)]
    pub delivery: Delivery,
}
impl Request {
    pub fn wire_data(&self) -> Data {
        let mut wire = Data::from_value(&json!(self));
        if let Data::Object(fields) = &mut wire {
            fields.insert("message".into(), self.message.wire_data());
        }
        wire
    }
    pub fn parse(bytes: &[u8], limits: &Limits) -> IoResult<Self> {
        let mut tree = Data::parse(bytes, limits)?;
        if let Data::Object(root) = &mut tree {
            if let Some(Data::Object(message)) = root.get_mut("message") {
                if let Some(Data::Object(content)) = message.get_mut("content") {
                    match content.get("encoding").and_then(Data::string) {
                        Some("json") => {
                            let value = content.get("value").ok_or_else(|| IoError::new("invalid_content_syntax", "JSON content requires value"))?;
                            let persisted = Data::parse(&serde_json::to_vec(value).expect("data serialization"), &Limits { max_bytes: limits.max_bytes * 8, max_depth: limits.max_depth * 3 + 8, max_nodes: limits.max_nodes * 4, ..limits.clone() })?;
                            content.insert("value".into(), persisted);
                        }
                        Some("utf8" | "resource") => (),
                        _ => return Err(IoError::new("unsupported_encoding", "Supported representations are json and utf8; resource availability is separately declared")),
                    }
                }
            }
        }
        serde_json::from_str(&tree.json())
            .map_err(|_| IoError::new("invalid_content_syntax", "Invalid IO envelope fields"))
    }
    pub fn fingerprint(&self, principal: &str) -> String {
        hash(&json!({"principal":principal,"request":self}))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Descriptor {
    pub id: String,
    pub version: String,
    pub encodings: Vec<String>,
    pub schema: Option<Value>,
    pub contract: Option<String>,
    pub publisher: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub required_visible_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resource_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FormatBinding {
    pub format: OutputFormat,
    pub validation: String,
    pub schema_validation: String,
    /// Durable exact definition, including provenance; registry is only a cache.
    pub definition: Option<Descriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Binding {
    pub io_version: String,
    pub limits: Limits,
    pub input: FormatBinding,
    pub accept_formats: Vec<FormatBinding>,
    pub required_formats: Vec<OutputFormat>,
    pub execution: Value,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resources: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AcceptedInput {
    pub request: Request,
    pub request_fingerprint: String,
    pub binding: Binding,
}

#[derive(Debug, Clone)]
pub struct Registry {
    pub enabled: bool,
    pub allow_generic: bool,
    pub limits: Limits,
    definitions: BTreeMap<(String, String), Descriptor>,
}
impl Default for Registry {
    fn default() -> Self {
        let mut registry = Self {
            enabled: false,
            allow_generic: true,
            limits: Limits::default(),
            definitions: BTreeMap::new(),
        };
        for descriptor in [
            Descriptor { id: "morphz.chat".into(), version: "1".into(), encodings: vec!["json".into(), "utf8".into()],
                schema: Some(json!({"type":"object","properties":{"text":{"type":"string"},"attachments":{"type":"array"},"references":{"type":"array"}},"additionalProperties":false})),
                contract: Some("Standard chat. Text is user content; attachments and references require separate authorization.".into()), publisher: "morphz".into(), required_visible_paths: vec![], resource_paths: vec![] },
            Descriptor { id: "morphz.data".into(), version: "1".into(), encodings: vec!["json".into(), "resource".into()], schema: None,
                contract: None, publisher: "morphz".into(), required_visible_paths: vec![], resource_paths: vec![] },
        ] { registry.register(descriptor).expect("standard format definition"); }
        registry
    }
}
impl Registry {
    /// Trusted embedding-host configuration, never an input-message side effect.
    pub fn register(&mut self, descriptor: Descriptor) -> IoResult<()> {
        validate_name(&descriptor.id)?;
        validate_name(&descriptor.version)?;
        if descriptor.encodings.is_empty()
            || descriptor
                .encodings
                .iter()
                .any(|value| value != "json" && value != "utf8" && value != "resource")
        {
            return Err(IoError::new(
                "unsupported_encoding",
                "Format encoding is not supported",
            ));
        }
        if descriptor.publisher.trim().is_empty()
            || descriptor.required_visible_paths.len() > 32
            || descriptor.resource_paths.len() > 32
            || descriptor
                .required_visible_paths
                .iter()
                .chain(&descriptor.resource_paths)
                .any(|path| path.len() > 2048 || (!path.is_empty() && !path.starts_with('/')))
            || descriptor
                .contract
                .as_ref()
                .is_some_and(|value| value.len() > 8192)
        {
            return Err(IoError::new(
                "message_limit_exceeded",
                "Invalid publisher or oversized format contract",
            ));
        }
        // Syntax is host-validated at installation, not deferred until a message arrives.
        for path in descriptor
            .required_visible_paths
            .iter()
            .chain(&descriptor.resource_paths)
        {
            projection::validate_pointer(path)?;
        }
        if let Some(schema) = &descriptor.schema {
            Data::parse(
                &serde_json::to_vec(schema).expect("schema serialization"),
                &Limits {
                    max_bytes: 32 * 1024,
                    ..self.limits.clone()
                },
            )?;
            schema::check(schema, 0)?;
        }
        let key = (descriptor.id.clone(), descriptor.version.clone());
        if self
            .definitions
            .get(&key)
            .is_some_and(|previous| previous != &descriptor)
        {
            return Err(IoError::new(
                "format_definition_mismatch",
                "A registered version is immutable",
            ));
        }
        self.definitions.insert(key, descriptor);
        Ok(())
    }
    pub fn capabilities(&self) -> Value {
        json!({"experimental":true,"enabled":self.enabled,"io_versions":if self.enabled {vec!["1"]} else {vec![]},
            "stream_versions":["1"],"encodings":["json","utf8","resource"],"resources":true,"generic_json":self.allow_generic,
            "resource_inputs":["staged_attachment","event_attachment"],"typed_paging":true,"directed_input":self.enabled,
            "activation_modes":["evaluate"],"schema_keywords":schema::KEYWORDS,"schema_numeric_constants":"int64-or-uint64-only","limits":self.limits,
            "formats":self.definitions.values().map(|definition| json!({"definition":definition,"schema_hash":definition.schema.as_ref().map(hash),"contract_hash":definition.contract.as_ref().map(hash)})).collect::<Vec<_>>()})
    }
    pub fn resolve(
        &self,
        format: &Format,
        encoding: &str,
        validation: &str,
    ) -> IoResult<FormatBinding> {
        validate_name(&format.id)?;
        validate_name(&format.version)?;
        if encoding != "json" && encoding != "utf8" && encoding != "resource" {
            return Err(IoError::new(
                "unsupported_encoding",
                "Encoding is not available",
            ));
        }
        if validation != "registered" && validation != "generic" {
            return Err(IoError::new(
                "invalid_content_syntax",
                "Unknown validation mode",
            ));
        }
        let definition = self
            .definitions
            .get(&(format.id.clone(), format.version.clone()));
        if validation == "generic" {
            if !self.allow_generic
                || encoding != "json"
                || definition.is_some()
                || format.id.starts_with("morphz.")
            {
                return Err(IoError::new("unsupported_format", "Generic mode only permits unregistered domain JSON; it cannot bypass a registered schema"));
            }
        } else if definition.is_none() {
            return Err(IoError::new(
                "unsupported_format",
                "Exact format version is not installed",
            ));
        }
        if definition.is_some_and(|value| {
            !value
                .encodings
                .iter()
                .any(|candidate| candidate == encoding)
        }) {
            return Err(IoError::new(
                "unsupported_encoding",
                "Encoding is not supported by this format",
            ));
        }
        let schema_hash = definition.and_then(|value| value.schema.as_ref()).map(hash);
        let contract_hash = definition
            .and_then(|value| value.contract.as_ref())
            .map(hash);
        if format
            .schema_hash
            .as_ref()
            .is_some_and(|expected| Some(expected) != schema_hash.as_ref())
            || format
                .contract_hash
                .as_ref()
                .is_some_and(|expected| Some(expected) != contract_hash.as_ref())
        {
            return Err(IoError::new(
                "format_definition_mismatch",
                "Expected format hash does not match the installed definition",
            ));
        }
        Ok(FormatBinding {
            format: OutputFormat {
                id: format.id.clone(),
                version: format.version.clone(),
                encoding: encoding.into(),
                schema_hash,
                contract_hash,
            },
            validation: validation.into(),
            schema_validation: if encoding == "json"
                && definition.is_some_and(|value| value.schema.is_some())
            {
                "enforced"
            } else {
                "syntax_only"
            }
            .into(),
            definition: definition.cloned(),
        })
    }
    pub fn bind(&self, request: Request, principal: &str) -> IoResult<AcceptedInput> {
        if !self.enabled {
            return Err(IoError::new(
                "unsupported_io_version",
                "Experimental Session IO is disabled",
            ));
        }
        if request.io_version != "1" {
            return Err(IoError::new(
                "unsupported_io_version",
                "IO version is not supported",
            ));
        }
        if request.activation.mode != "evaluate" {
            return Err(IoError::new(
                "unsupported_activation_mode",
                "Only evaluate is supported",
            ));
        }
        if request.activation.input_destination.is_some()
            && (request.activation.model_alias.is_some()
                || request.activation.reasoning_effort.is_some()
                || request.activation.target_id.is_some()
                || request.activation.harness.is_some())
        {
            return Err(IoError::new(
                "unsupported_activation_mode",
                "Directed input inherits the existing work route; model, reasoning, Target and Harness overrides are not allowed",
            ));
        }
        let input = self.resolve(
            &request.message.format,
            request.message.content.encoding(),
            &request.message.validation,
        )?;
        validate_content(&request.message, &input, &self.limits)?;
        let mut accepted = request
            .delivery
            .accept_formats
            .clone()
            .unwrap_or_else(|| vec![OutputFormat::chat()]);
        if request.delivery.accept_formats.is_none() {
            for required in &request.delivery.required_formats {
                if !accepted
                    .iter()
                    .any(|candidate| candidate.same_type(required))
                {
                    accepted.push(required.clone());
                }
            }
        }
        if accepted.is_empty()
            || accepted.len() > 32
            || request.delivery.required_formats.len() > 32
            || request.delivery.required_formats.iter().any(|required| {
                !accepted
                    .iter()
                    .any(|candidate| candidate.same_type(required))
            })
        {
            return Err(IoError::new(
                "invalid_delivery_contract",
                "Required output formats must be a subset of a nonempty accepted set",
            ));
        }
        let accept_formats = accepted
            .iter()
            .map(|format| self.resolve(&format.format(), &format.encoding, "registered"))
            .collect::<IoResult<Vec<_>>>()?;
        for required in &request.delivery.required_formats {
            self.resolve(&required.format(), &required.encoding, "registered")?;
        }
        if request.delivery.require_schema
            && accept_formats
                .iter()
                .any(|binding| binding.schema_validation != "enforced")
        {
            return Err(IoError::new(
                "schema_validation_unavailable",
                "All accepted outputs must have enforced schemas",
            ));
        }
        let binding = Binding {
            io_version: "1".into(),
            limits: self.limits.clone(),
            input,
            accept_formats,
            required_formats: request.delivery.required_formats.clone(),
            execution: Value::Null,
            resources: Vec::new(),
        };
        // Definitions participate in the projection budget, not only values.
        let definition_bytes = std::iter::once(&binding.input)
            .chain(&binding.accept_formats)
            .map(|definition| {
                Data::from_value(&json!(definition))
                    .expression()
                    .to_string()
                    .len()
            })
            .sum::<usize>();
        projection::validate_budget(
            &request.message,
            &binding.input,
            &self.limits,
            definition_bytes,
        )?;
        Ok(AcceptedInput {
            request_fingerprint: request.fingerprint(principal),
            request,
            binding,
        })
    }
}

pub fn validate_content(
    message: &Message,
    binding: &FormatBinding,
    limits: &Limits,
) -> IoResult<()> {
    match &message.content {
        Content::Json { value } => {
            if Data::parse(value.json().as_bytes(), limits)? != *value {
                return Err(IoError::new(
                    "invalid_content_syntax",
                    "Invalid typed JSON value",
                ));
            }
            if let Some(schema) = binding
                .definition
                .as_ref()
                .and_then(|value| value.schema.as_ref())
            {
                schema::validate(schema, value, "")?;
            }
            if message.format.id == "morphz.chat" {
                resources::chat_inputs(message)?;
                if value
                    .get("text")
                    .and_then(Data::string)
                    .is_none_or(|text| text.trim().is_empty())
                    && ["attachments", "references"].iter().all(|name| {
                        value.get(name).is_none_or(
                            |items| matches!(items, Data::Array(items) if items.is_empty()),
                        )
                    })
                {
                    return Err(IoError::new(
                        "schema_validation_failed",
                        "Standard chat requires text, attachments or references",
                    ));
                }
            }
        }
        Content::Utf8 { value } => {
            if value.len() > limits.max_bytes {
                return Err(IoError::new("message_limit_exceeded", "Text exceeds limit"));
            }
            if message.format.id == "morphz.chat" && value.trim().is_empty() {
                return Err(IoError::new(
                    "schema_validation_failed",
                    "Standard chat must contain nonempty text",
                ));
            }
        }
        Content::Resource { resource_id } => {
            resources::decode_id(resource_id)?;
        }
    }
    Ok(())
}

fn validate_name(value: &str) -> IoResult<()> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err(IoError::new(
            "invalid_content_syntax",
            "Invalid format identifier or version",
        ));
    }
    Ok(())
}
pub(crate) fn hash(value: &impl Serialize) -> String {
    format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(value).expect("serializable contract"))
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Subscription {
    #[serde(default = "version_one")]
    pub io_version: String,
    #[serde(default = "version_one")]
    pub stream_version: String,
    pub receive_formats: Option<Vec<OutputFormat>>,
    #[serde(default = "inspect")]
    pub receive_unknown: String,
}
fn inspect() -> String {
    "inspect".into()
}
impl Default for Subscription {
    fn default() -> Self {
        Self {
            io_version: version_one(),
            stream_version: version_one(),
            receive_formats: None,
            receive_unknown: inspect(),
        }
    }
}
impl Subscription {
    pub fn normalize(mut self) -> IoResult<Self> {
        if self.io_version != "1" {
            return Err(IoError::new(
                "unsupported_io_version",
                "Unsupported IO version",
            ));
        }
        if self.stream_version != "1" {
            return Err(IoError::new(
                "unsupported_stream_version",
                "Unsupported stream version",
            ));
        }
        if self.receive_unknown != "inspect" && self.receive_unknown != "reject" {
            return Err(IoError::new(
                "invalid_content_syntax",
                "Invalid unknown-format policy",
            ));
        }
        let formats = self.receive_formats.get_or_insert_with(|| {
            let mut utf8 = OutputFormat::chat();
            utf8.encoding = "utf8".into();
            vec![OutputFormat::chat(), utf8]
        });
        if formats.len() > 64 {
            return Err(IoError::new(
                "message_limit_exceeded",
                "Too many receive formats",
            ));
        }
        for format in formats {
            validate_name(&format.id)?;
            validate_name(&format.version)?;
            if format.encoding != "json" && format.encoding != "utf8" {
                return Err(IoError::new(
                    "unsupported_encoding",
                    "Unsupported receive encoding",
                ));
            }
        }
        Ok(self)
    }
}
