//! Opt-in, display-only metadata produced alongside existing model responses.
//! Execution scope, authorization and status remain Runtime-owned facts. This
//! module never dispatches work, requests an inference or reads a database.
use crate::event::{Event, TYPE_AGENT_CALL};
use crate::llm::{Response, ToolDefinition};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fmt;

pub mod stream;

/// Stable payload key, separate from the scalar response_annotations protocol.
pub const BUNDLE_PAYLOAD_KEY: &str = "response_annotation_bundle";

/// Version of the model-visible, derived acceptance receipt, not the writer protocol.
pub const RECEIPT_ENCODING_VERSION: u8 = 1;
pub const RECEIPT_CONTRACT: &str = "Runtime response-annotation-receipt reports accepted field kinds for exactly its persisted source response, not generated prose. Accepted metadata is not a selected/effective title or final result, and never proves tool success. Working responses cannot establish execution.result. none_accepted means only zero accepted records in that source, not that metadata was never submitted. Missing, unknown or truncated receipts cannot prove missing annotations in this Execution; do not infer absence from cleaned business arguments. Receipt references grant no Recall access or permission. Do not add calls or model requests to repair metadata.";
const RECEIPT_DETAIL_LIMIT: usize = 16;
const RECEIPT_BYTE_LIMIT: usize = 2048;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReceiptState {
    Accepted,
    NoneAccepted,
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AcceptedFieldReceipt {
    pub kind: AnnotationKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation_ref: Option<String>,
}

/// Bounded evidence of persisted acceptance only. This is neither a new ledger
/// nor the selected execution projection. Unknown receipts do not bind a scope
/// whose durable producer could not be verified by the Context caller.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnnotationReceipt {
    pub protocol: Protocol,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_event_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_sequence: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<ExecutionScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_attempt_id: Option<String>,
    pub state: ReceiptState,
    pub accepted: Vec<AcceptedFieldReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic_count: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub omitted_diagnostics: Option<usize>,
    pub truncated: bool,
}

fn receipt_identifier(value: &str) -> bool {
    !value.is_empty() && value.is_ascii() && value.len() <= 128
}

impl AnnotationReceipt {
    pub(crate) fn unknown(protocol: Protocol, event: &Event, truncated: bool) -> Self {
        Self {
            protocol,
            source_event_id: receipt_identifier(&event.id).then(|| event.id.clone()),
            source_sequence: event.sequence,
            scope: None,
            activation_id: None,
            model_attempt_id: None,
            state: ReceiptState::Unknown,
            accepted: Vec::new(),
            diagnostic_count: None,
            omitted_diagnostics: None,
            truncated: truncated || !receipt_identifier(&event.id),
        }
    }

    /// Shared canonical form for both Full Inbox and Delta source evidence.
    pub(crate) fn expression(&self) -> crate::sexpr::SExpr {
        use crate::sexpr::SExpr;
        let pair = |name: &str, value: String| {
            SExpr::List(vec![SExpr::Atom(name.into()), SExpr::Atom(value)])
        };
        let mut fields = vec![
            SExpr::Atom("response-annotation-receipt".into()),
            pair("version", RECEIPT_ENCODING_VERSION.to_string()),
            pair("protocol", self.protocol.as_str().into()),
        ];
        for (name, value) in [
            ("source-event", self.source_event_id.as_ref()),
            ("activation", self.activation_id.as_ref()),
            ("model-attempt", self.model_attempt_id.as_ref()),
        ] {
            if let Some(value) = value {
                fields.push(pair(name, value.clone()));
            }
        }
        if let Some(sequence) = self.source_sequence {
            fields.push(pair("source-seq", sequence.to_string()));
        }
        if let Some(scope) = &self.scope {
            fields.push(pair("execution", scope.execution_id.clone()));
            fields.push(pair("generation", scope.generation.to_string()));
        }
        fields.push(pair(
            "state",
            match self.state {
                ReceiptState::Accepted => "accepted",
                ReceiptState::NoneAccepted => "none_accepted",
                ReceiptState::Unknown => "unknown",
            }
            .into(),
        ));
        let mut accepted = vec![SExpr::Atom("accepted".into())];
        for record in &self.accepted {
            let kind = match record.kind {
                AnnotationKind::Title => "execution.title",
                AnnotationKind::Progress => "execution.progress",
                AnnotationKind::Result => "execution.result",
                AnnotationKind::Intent => "intent",
                AnnotationKind::ObservationResult => "observation.result",
            };
            let mut record_fields = vec![SExpr::Atom("record".into()), pair("kind", kind.into())];
            if let Some(id) = &record.call_id {
                record_fields.push(pair("call-id", id.clone()));
            }
            if let Some(reference) = &record.observation_ref {
                record_fields.push(pair("observation-ref", reference.clone()));
            }
            accepted.push(SExpr::List(record_fields));
        }
        fields.push(SExpr::List(accepted));
        if let Some(count) = self.diagnostic_count {
            fields.push(pair("diagnostic-count", count.to_string()));
        }
        if let Some(count) = self.omitted_diagnostics {
            fields.push(pair("omitted-diagnostics", count.to_string()));
        }
        fields.push(pair("truncated", self.truncated.to_string()));
        SExpr::List(fields)
    }

    fn bounded(mut self) -> Self {
        let invalid_identity = self
            .source_event_id
            .as_deref()
            .is_none_or(|id| !receipt_identifier(id))
            || self
                .activation_id
                .as_deref()
                .is_none_or(|id| !receipt_identifier(id))
            || self
                .model_attempt_id
                .as_deref()
                .is_none_or(|id| !receipt_identifier(id))
            || self
                .scope
                .as_ref()
                .is_none_or(|scope| !receipt_identifier(&scope.execution_id));
        if invalid_identity {
            // Do not truncate an identity into a different identity or report
            // zero accepted records when the carrier cannot be represented.
            self.source_event_id = self.source_event_id.filter(|id| receipt_identifier(id));
            self.activation_id = self.activation_id.filter(|id| receipt_identifier(id));
            self.model_attempt_id = self.model_attempt_id.filter(|id| receipt_identifier(id));
            self.scope = self
                .scope
                .filter(|scope| receipt_identifier(&scope.execution_id));
            self.accepted.clear();
            self.state = ReceiptState::Unknown;
            self.truncated = true;
        }
        while self.expression().to_string().len() > RECEIPT_BYTE_LIMIT {
            self.truncated = true;
            if self.accepted.pop().is_some() {
                if self.accepted.is_empty() {
                    self.state = ReceiptState::Unknown;
                }
                continue;
            }
            self.state = ReceiptState::Unknown;
            self.scope = None;
            self.activation_id = None;
            self.model_attempt_id = None;
            break;
        }
        self
    }
}

/// Pure read projection. The caller must first prove actual current and source
/// Activation/Thread routes and visibility. These explicit IDs are host facts,
/// not model fields. Missing/corrupt bundles are unknown, never absence proof.
pub(crate) fn receipt_from_authorized_event(
    event: &Event,
    scope: &ExecutionScope,
    protocol: Protocol,
    activation_id: &str,
    model_attempt_id: &str,
) -> Option<AnnotationReceipt> {
    if protocol.is_off() {
        return None;
    }
    let mut receipt = AnnotationReceipt::unknown(protocol, event, false);
    receipt.scope = Some(scope.clone());
    receipt.activation_id = Some(activation_id.into());
    receipt.model_attempt_id = Some(model_attempt_id.into());
    let bundle = match annotations_from_authorized_event(event, scope) {
        Ok(Some(bundle)) if bundle.protocol == protocol => bundle,
        _ => return Some(receipt.bounded()),
    };
    receipt.diagnostic_count = Some(bundle.diagnostics.len());
    receipt.omitted_diagnostics = Some(bundle.omitted_diagnostics);
    receipt.truncated = bundle.omitted_diagnostics > 0;
    let mut records = bundle.records.iter().collect::<Vec<_>>();
    records.sort_by_key(|record| record.ordinal);
    let is_final_reply = event
        .payload
        .get("terminal_outcome")
        .and_then(Value::as_bool)
        == Some(true)
        && bundle.raw_response.tool_calls.len() == 1
        && bundle.raw_response.tool_calls[0].func_name == "reply";
    for record in records {
        if receipt.accepted.len() >= RECEIPT_DETAIL_LIMIT {
            receipt.truncated = true;
            break;
        }
        let mut field = AcceptedFieldReceipt {
            kind: record.kind,
            call_id: None,
            observation_ref: None,
        };
        match record.kind {
            AnnotationKind::Intent => {
                let Some(id) = record
                    .call_id
                    .as_deref()
                    .filter(|id| receipt_identifier(id))
                else {
                    receipt.truncated = true;
                    continue;
                };
                if bundle
                    .raw_response
                    .tool_calls
                    .iter()
                    .filter(|call| call.id == id)
                    .count()
                    != 1
                {
                    receipt.truncated = true;
                    continue;
                }
                field.call_id = Some(id.into());
            }
            AnnotationKind::ObservationResult => {
                let Some(reference) = record
                    .observation_ref
                    .as_deref()
                    .filter(|id| receipt_identifier(id))
                else {
                    receipt.truncated = true;
                    continue;
                };
                if record
                    .observation_event_id
                    .as_deref()
                    .is_none_or(str::is_empty)
                {
                    receipt.truncated = true;
                    continue;
                }
                field.observation_ref = Some(reference.into());
            }
            AnnotationKind::Result if !is_final_reply => {
                receipt.truncated = true;
                continue;
            }
            _ => {}
        }
        receipt.accepted.push(field);
    }
    receipt.state = if !receipt.accepted.is_empty() {
        ReceiptState::Accepted
    } else if bundle.records.is_empty() {
        ReceiptState::NoneAccepted
    } else {
        ReceiptState::Unknown
    };
    Some(receipt.bounded())
}

/// Added only when the Execution has explicitly selected v1. Do not include in
/// off or typed-infer prompts, and never request another response to repair it.
pub const CONTRACT_V1: &str = r#"Response annotations v1 (optional display metadata):
Work tools may carry optional top-level _annotations. Business parameters and permissions remain unchanged.
_annotations may contain execution {title,progress,result}, intent, observations [{ref,result}].
execution.title names the ENTIRE current Execution/request, never a step. Supply it once for the current input revision; subsequent steps must not rename the task. When the user supplements or adjusts this same task and Runtime has included that new instruction in the current model input, you may supply an updated whole-task title. Only Runtime determines the input revision; do not invent an identity or revision field.
execution.progress describes the current stage based on observations already received. intent describes the imminent purpose of its carrier tool call, not its result.
Submit execution metadata in only one call per response. Each work call may supply its own intent.
Interpret only exact observation refs provided by Runtime for this Execution and generation. Do not invent refs or describe another same-batch call's unavailable result.
title, progress and intent: at most 256 Unicode characters. result: at most 512. At most 16 observations per response; refs: at most 128 ASCII characters.
Work responses cannot establish execution.result. Missing annotations are valid; do not add calls or inference rounds just for metadata.
To deliver ordinary final text you may use reply({content,annotations}) as the SOLE call with no other tools or ordinary content. content is the user-facing text; execution.result is an optional short outcome including failure, partial work or unexecuted parts.
reply is a response form, not a work tool. It does not override background work, cancellation, approval, Runtime status or the actual Execution boundary.
Legacy plain text and no_reply remain valid. Do not annotate or change no_reply's silent/wait grammar. Typed-infer results are not this protocol.
Annotations are display text only, never identities, state, percentages, permissions, executable content, Mind or Custom updates."#;

/// V2 adds a strict ordinary-delivery boundary, not additional work or repair
/// requests. V1 is kept byte-for-byte separate for frozen legacy executions.
pub const CONTRACT_V2: &str = r#"Response annotations v2 (explicit display metadata contract):
Work tools may carry optional top-level _annotations. Business parameters and permissions remain unchanged.
_annotations may contain execution {title,progress,result}, intent, observations [{ref,result}].
execution.title names the ENTIRE current Execution/request, never a step. Supply it once for the current input revision; subsequent steps must not rename the task. When the user supplements or adjusts this same task and Runtime has included that new instruction in the current model input, you may supply an updated whole-task title. Only Runtime determines the input revision; do not invent an identity or revision field.
execution.progress describes the current stage based on observations already received. intent describes the imminent purpose of its carrier tool call, not its result.
Submit execution metadata in only one call per response. Each work call may supply its own intent.
Interpret only exact observation refs provided by Runtime for this Execution and generation. Do not invent refs or describe another same-batch call's unavailable result.
title, progress and intent: at most 256 Unicode characters. result: at most 512. At most 16 observations per response; refs: at most 128 ASCII characters.
Work responses cannot establish execution.result. Work annotations remain optional; do not add calls or inference rounds just for metadata.
To deliver ordinary final text you MUST use reply({content,annotations}) as the SOLE call with no other tools or ordinary content. In that SAME reply include nonempty annotations.execution.title naming the whole current task and annotations.execution.result describing the outcome, including failure, partial work or unexecuted parts. An earlier work title does not replace the required final title. Plain final text, missing or invalid required metadata fails the response protocol without a repair request.
reply is a response form, not a work tool. It does not override background work, cancellation, approval, Runtime status or the actual Execution boundary.
no_reply remains valid. Do not annotate or change no_reply's silent/wait grammar. Typed-infer results are not this protocol.
Annotations are display text only, never identities, state, percentages, permissions, executable content, Mind or Custom updates."#;

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    #[default]
    Off,
    V1,
    V2,
}
impl Protocol {
    pub const fn is_off(&self) -> bool {
        matches!(self, Self::Off)
    }
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::V1 => "v1",
            Self::V2 => "v2",
        }
    }
    #[expect(
        clippy::should_implement_trait,
        reason = "Preserve the existing public canonical-token parser alongside its FromStr implementation"
    )]
    pub fn from_str(value: &str) -> Result<Self, ProtocolError> {
        match value {
            "off" => Ok(Self::Off),
            "v1" => Ok(Self::V1),
            "v2" => Ok(Self::V2),
            _ => Err(error("Unknown response annotations protocol")),
        }
    }
    pub const fn contract(&self) -> Option<&'static str> {
        match self {
            Self::Off => None,
            Self::V1 => Some(CONTRACT_V1),
            Self::V2 => Some(CONTRACT_V2),
        }
    }
}
impl std::str::FromStr for Protocol {
    type Err = ProtocolError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Protocol::from_str(value)
    }
}
impl fmt::Display for Protocol {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProtocolError(pub String);
impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for ProtocolError {}
fn error(message: &str) -> ProtocolError {
    ProtocolError(message.into())
}
fn diagnostic_path(path: &str) -> String {
    let mut characters = path.chars();
    let mut bounded: String = characters.by_ref().take(255).collect();
    if characters.next().is_some() {
        bounded.push('…');
    }
    bounded
}

pub fn annotation_schema() -> Value {
    json!({"type":"object", "additionalProperties":false, "properties":{
        "execution":{"type":"object", "additionalProperties":false, "properties":{
            "title":{"type":"string", "maxLength":256},
            "progress":{"type":"string", "maxLength":256},
            "result":{"type":"string", "maxLength":512}
        }},
        "intent":{"type":"string", "maxLength":256},
        "observations":{"type":"array", "maxItems":16, "items":{
            "type":"object", "additionalProperties":false, "required":["ref","result"],
            "properties":{"ref":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[\\x00-\\x7F]+$"},
                "result":{"type":"string","maxLength":512}}
        }}
    }})
}

/// A candidate model-visible schema only. Strict/nullable provider adaptation
/// still needs real-provider validation; original business schemas are kept.
pub fn augment_tools(
    tools: &[ToolDefinition],
    protocol: Protocol,
    typed_infer: bool,
) -> Result<Vec<ToolDefinition>, ProtocolError> {
    if protocol == Protocol::Off || typed_infer {
        return Ok(tools.to_vec());
    }
    for tool in tools {
        if tool.name == "reply" {
            return Err(error("Reserved reply tool name is occupied"));
        }
        let parameters = &tool.parameters;
        if parameters
            .get("properties")
            .and_then(Value::as_object)
            .is_some_and(|p| p.contains_key("_annotations"))
            || parameters
                .get("required")
                .and_then(Value::as_array)
                .is_some_and(|r| r.iter().any(|v| v.as_str() == Some("_annotations")))
        {
            return Err(error("Reserved _annotations parameter is occupied"));
        }
        if tool.name == "no_reply" {
            continue;
        }
        if parameters.get("type").and_then(Value::as_str) != Some("object")
            || parameters.get("properties").is_some_and(|p| !p.is_object())
        {
            return Err(error("Root object tool schema required"));
        }
        if ["$ref", "allOf", "anyOf", "oneOf"]
            .iter()
            .any(|key| parameters.get(*key).is_some())
        {
            return Err(error(
                "Composite root schema needs explicit integration decision",
            ));
        }
    }
    let mut augmented = tools.to_vec();
    for tool in &mut augmented {
        if tool.name == "no_reply" {
            continue;
        }
        tool.parameters
            .as_object_mut()
            .unwrap()
            .entry("properties")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .unwrap()
            .insert("_annotations".into(), annotation_schema());
    }
    let mut reply_parameters = json!({"type":"object", "additionalProperties":false, "required":["content"],
        "properties":{"content":{"type":"string","minLength":1},"annotations":annotation_schema()}});
    if protocol == Protocol::V2 {
        reply_parameters["required"] = json!(["content", "annotations"]);
        reply_parameters["properties"]["annotations"]["required"] = json!(["execution"]);
        let execution =
            &mut reply_parameters["properties"]["annotations"]["properties"]["execution"];
        execution["required"] = json!(["title", "result"]);
        for field in ["title", "result"] {
            execution["properties"][field]["minLength"] = json!(1);
        }
    }
    augmented.push(ToolDefinition {
        name: "reply".into(),
        description: if protocol == Protocol::V2 {
            "Deliver the final user-facing response. Use alone with valid execution.title and execution.result in annotations. These display fields do not change execution state; this is not a work tool."
        } else {
            "Deliver the final user-facing response. Use alone. Optional annotations do not change execution state; this is not a work tool."
        }.into(),
        parameters: reply_parameters,
    });
    Ok(augmented)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionScope {
    pub execution_id: String,
    pub generation: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Producer {
    pub event_id: String,
    pub attempt_id: String,
    /// Trusted persisted event order. Never derive this from model refs.
    pub sequence: Option<u64>,
}
/// Host-only evidence that a supplemental input was actually visible to this
/// request. The caller proves its Human/Signal/Execution binding; model output
/// cannot supply it. Absence is the backwards-compatible initial revision 0.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TitleInputRevision {
    pub event_id: String,
    pub sequence: u64,
}
impl TitleInputRevision {
    pub fn is_valid(&self) -> bool {
        !self.event_id.trim().is_empty()
            && self.event_id.chars().take(257).count() <= 256
            && self.sequence > 0
    }
    fn precedes(&self, response_sequence: Option<u64>) -> bool {
        self.is_valid() && response_sequence.is_none_or(|sequence| self.sequence < sequence)
    }
}

/// A malformed display-only revision must never invalidate executable output
/// or trigger an inference repair. Other persisted bundle bindings stay strict.
fn deserialize_title_input_revision<'de, D>(
    deserializer: D,
) -> Result<Option<TitleInputRevision>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    Ok(serde_json::from_value::<TitleInputRevision>(value)
        .ok()
        .filter(TitleInputRevision::is_valid))
}
#[derive(Clone, Debug)]
pub struct TrustedObservation {
    pub event_id: String,
    pub scope: ExecutionScope,
    pub provided: bool,
    pub allowed: bool,
}
#[derive(Clone, Debug)]
pub struct ExecutionFact {
    pub scope: ExecutionScope,
    pub status: String,
    pub terminal: bool,
    pub terminal_sequence: Option<u64>,
}
#[derive(Clone, Debug, Default)]
pub struct NormalizationContext {
    /// Must be the version frozen for this execution, not mutable global config.
    pub protocol: Protocol,
    pub typed_infer: bool,
    pub scope: Option<ExecutionScope>,
    pub producer: Option<Producer>,
    pub title_input_revision: Option<TitleInputRevision>,
    pub observations: HashMap<String, TrustedObservation>,
    pub execution_fact: Option<ExecutionFact>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum AnnotationKind {
    #[serde(rename = "execution.title")]
    Title,
    #[serde(rename = "execution.progress")]
    Progress,
    #[serde(rename = "execution.result")]
    Result,
    #[serde(rename = "intent")]
    Intent,
    #[serde(rename = "observation.result")]
    ObservationResult,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnnotationRecord {
    /// Collision-free structured producer key; not an independently minted ID.
    pub identity: String,
    pub protocol: Protocol,
    pub kind: AnnotationKind,
    pub value: String,
    pub source: Producer,
    pub ordinal: usize,
    pub scope: ExecutionScope,
    pub call_id: Option<String>,
    pub observation_ref: Option<String>,
    pub observation_event_id: Option<String>,
    /// A delivery alone does not prove the execution truly terminated.
    pub effective: bool,
    /// Set only on title records by the host, never extracted from annotations.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_title_input_revision"
    )]
    pub title_input_revision: Option<TitleInputRevision>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Diagnostic {
    pub path: String,
    pub message: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NoReplyMode {
    Silent,
    Wait {
        wait_secs: u64,
        explicitly_requested: bool,
    },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TerminalDecision {
    Deliver(String),
    NoReply(NoReplyMode),
}
#[derive(Clone, Debug)]
pub struct NormalizedResponse {
    pub raw_response: Response,
    pub execution_response: Response,
    /// Protocol applied to this response, not the authoritative frozen execution
    /// version (typed infer bypasses v1 without changing the execution binding).
    pub protocol: Protocol,
    pub records: Vec<AnnotationRecord>,
    pub diagnostics: Vec<Diagnostic>,
    pub omitted_diagnostics: usize,
    pub terminal_decision: Option<TerminalDecision>,
    pub dispatch_allowed: bool,
    pub title_input_revision: Option<TitleInputRevision>,
}

/// Persisted atomically with its actual assistant_call Event. Producer.sequence
/// may be absent before insertion; read helpers hydrate only the enclosing
/// Event Store sequence after proving the producer/event/scope binding.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PersistedAnnotations {
    pub protocol: Protocol,
    pub scope: ExecutionScope,
    pub raw_response: Response,
    pub records: Vec<AnnotationRecord>,
    pub diagnostics: Vec<Diagnostic>,
    pub omitted_diagnostics: usize,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_title_input_revision"
    )]
    pub title_input_revision: Option<TitleInputRevision>,
}
impl PersistedAnnotations {
    pub fn from_normalized(scope: ExecutionScope, normalized: &NormalizedResponse) -> Self {
        Self {
            protocol: normalized.protocol,
            scope,
            raw_response: normalized.raw_response.clone(),
            records: normalized.records.clone(),
            diagnostics: normalized.diagnostics.clone(),
            omitted_diagnostics: normalized.omitted_diagnostics,
            title_input_revision: normalized.title_input_revision.clone(),
        }
    }
}

/// The caller MUST have authorized this Event through the real Thread, Session
/// and principal route before invoking this helper. Scope checks are not a
/// replacement for authorization, and model-provided routing is never trusted.
/// No bundle means no annotations; malformed/cross-bound bundles fail closed.
pub fn annotations_from_authorized_event(
    event: &Event,
    scope: &ExecutionScope,
) -> Result<Option<PersistedAnnotations>, ProtocolError> {
    let Some(value) = event.payload.get(BUNDLE_PAYLOAD_KEY) else {
        return Ok(None);
    };
    if !matches!(
        event.topic.as_str(),
        "chat/assistant_call" | "runtime/thread_waiting"
    ) || event.event_type != TYPE_AGENT_CALL
        || event.payload.get("thread_id").and_then(Value::as_str)
            != Some(scope.execution_id.as_str())
    {
        return Err(error(
            "Annotation bundle is outside authorized assistant-call scope",
        ));
    }
    let sequence = event
        .sequence
        .ok_or_else(|| error("Annotation source Event is not persisted"))?;
    let mut bundle: PersistedAnnotations = serde_json::from_value(value.clone())
        .map_err(|_| error("Malformed persisted annotation bundle"))?;
    if bundle.protocol.is_off()
        || (bundle.protocol == Protocol::V2 && !event.payload.contains_key("response_annotations"))
        || event
            .payload
            .get("response_annotations")
            .is_some_and(|value| value.as_str() != Some(bundle.protocol.as_str()))
        || bundle.scope != *scope
        || event
            .payload
            .get("thread_generation")
            .is_some_and(|value| value.as_u64() != Some(scope.generation))
    {
        return Err(error(
            "Annotation bundle protocol or generation does not match scope",
        ));
    }
    if bundle.diagnostics.len() > 64
        || bundle
            .diagnostics
            .iter()
            .any(|d| d.path.chars().take(257).count() > 256)
        || bundle.records.len() > bundle.raw_response.tool_calls.len().saturating_add(19)
    {
        return Err(error(
            "Persisted annotation bundle exceeds bounded contract",
        ));
    }
    let attempt_id = event.payload.get("model_attempt_id");
    // An input is earlier than its produced response. This is a structural
    // fence only; the caller must also verify the actual accepted input and
    // model-visible manifest. Downgrade bad revision metadata locally.
    let valid_revision = bundle
        .title_input_revision
        .clone()
        .filter(|revision| revision.precedes(Some(sequence)));
    let malformed_revision = value
        .get("title_input_revision")
        .is_some_and(|raw| !raw.is_null() && valid_revision.is_none())
        || bundle.records.iter().any(|record| {
            record.kind == AnnotationKind::Title && record.title_input_revision != valid_revision
        });
    bundle.title_input_revision = if malformed_revision {
        None
    } else {
        valid_revision
    };
    if malformed_revision {
        if bundle.diagnostics.len() < 64 {
            bundle.diagnostics.push(Diagnostic {
                path: "host.title_input_revision".into(),
                message: "Invalid host title revision ignored; original response remains valid"
                    .into(),
            });
        } else {
            bundle.omitted_diagnostics = bundle.omitted_diagnostics.saturating_add(1);
        }
    }
    let mut ordinals = std::collections::HashSet::new();
    for record in &mut bundle.records {
        let max = match record.kind {
            AnnotationKind::Result | AnnotationKind::ObservationResult => 512,
            _ => 256,
        };
        if record.protocol != bundle.protocol
            || record.scope != *scope
            || record.source.event_id != event.id
            || record.source.attempt_id.is_empty()
            || attempt_id
                .is_some_and(|value| value.as_str() != Some(record.source.attempt_id.as_str()))
            || record.identity.is_empty()
            || !ordinals.insert(record.ordinal)
            || record.value.trim().is_empty()
            || record.value.chars().take(max + 1).count() > max
        {
            return Err(error(
                "Annotation record is not bound to its persisted producer",
            ));
        }
        // Never use a pre-insertion estimate or a number serialized by a model.
        record.source.sequence = Some(sequence);
        if record.kind == AnnotationKind::Title {
            record.title_input_revision = bundle.title_input_revision.clone();
        } else {
            record.title_input_revision = None;
        }
        if event.topic == "runtime/thread_waiting" && record.kind == AnnotationKind::Result {
            // Yielding is not a terminal fact, even if a bundle was malformed
            // or a stale producer tried to mark its candidate as effective.
            record.effective = false;
        }
    }
    Ok(Some(bundle))
}

pub fn records_from_authorized_event(
    event: &Event,
    scope: &ExecutionScope,
) -> Result<Vec<AnnotationRecord>, ProtocolError> {
    Ok(annotations_from_authorized_event(event, scope)?
        .map(|bundle| bundle.records)
        .unwrap_or_default())
}

/// Input Events must already be authorized and bounded by the caller's query.
/// This function performs no storage reads or authorization expansion.
pub fn project_authorized_events(
    fact: &ExecutionFact,
    events: &[Event],
) -> Result<ExecutionProjection, ProtocolError> {
    let mut records = vec![];
    for event in events {
        let incoming = records_from_authorized_event(event, &fact.scope)?;
        let (merged, conflicts) = merge_records(&records, &incoming);
        if !conflicts.is_empty() {
            return Err(error("Conflicting persisted annotation producer identity"));
        }
        records = merged;
    }
    Ok(project_execution(fact, &records))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReplyArguments {
    pub content: String,
    // Preserve Some(Null) so an explicitly malformed metadata container still
    // produces a diagnostic; absence remains None. Derive rejects duplicates.
    #[serde(default, deserialize_with = "present_value")]
    pub annotations: Option<Value>,
}
fn present_value<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}
pub(crate) fn parse_reply_arguments(arguments: &str) -> Result<ReplyArguments, ProtocolError> {
    let reply: ReplyArguments = serde_json::from_str(arguments)
        .map_err(|_| error("Malformed, duplicate or unknown reply control field"))?;
    if reply.content.trim().is_empty() {
        return Err(error("Invalid reply content"));
    }
    Ok(reply)
}

fn terminal(response: &Response) -> Result<Option<TerminalDecision>, ProtocolError> {
    if response
        .tool_calls
        .iter()
        .any(|c| c.func_name == "no_reply")
    {
        if response.tool_calls.len() != 1 || !response.content.trim().is_empty() {
            return Err(error("no_reply must be sole call with no ordinary content"));
        }
        let args: Value = serde_json::from_str(&response.tool_calls[0].arguments)
            .map_err(|_| error("Malformed no_reply control JSON"))?;
        let args = args
            .as_object()
            .ok_or_else(|| error("no_reply arguments must be an object"))?;
        if args.keys().any(|k| k != "mode" && k != "wait_secs") {
            return Err(error("Unknown no_reply control parameters"));
        }
        let mode = match args.get("mode").and_then(Value::as_str) {
            Some("silent") if !args.contains_key("wait_secs") => NoReplyMode::Silent,
            Some("wait") => {
                let explicitly_requested = args.contains_key("wait_secs");
                let wait_secs = match args.get("wait_secs") {
                    Some(v) => v
                        .as_u64()
                        .filter(|v| *v > 0)
                        .ok_or_else(|| error("wait_secs must be a positive u64"))?,
                    None => 60,
                };
                NoReplyMode::Wait {
                    wait_secs,
                    explicitly_requested,
                }
            }
            _ => return Err(error("Invalid no_reply control mode")),
        };
        return Ok(Some(TerminalDecision::NoReply(mode)));
    }
    if !response.tool_calls.is_empty() {
        return Ok(None);
    }
    if response.content.trim().is_empty() {
        return Err(error("Empty terminal reply"));
    }
    Ok(Some(TerminalDecision::Deliver(response.content.clone())))
}

struct Extraction<'a> {
    context: &'a NormalizationContext,
    title_input_revision: Option<TitleInputRevision>,
    records: Vec<AnnotationRecord>,
    diagnostics: Vec<Diagnostic>,
    omitted_diagnostics: usize,
    execution_seen: bool,
    observation_inputs_seen: usize,
}
impl<'a> Extraction<'a> {
    fn new(context: &'a NormalizationContext) -> Self {
        let revision = context.title_input_revision.clone().filter(|revision| {
            revision.precedes(
                context
                    .producer
                    .as_ref()
                    .and_then(|producer| producer.sequence),
            )
        });
        let mut extraction = Self {
            context,
            title_input_revision: revision,
            records: vec![],
            diagnostics: vec![],
            omitted_diagnostics: 0,
            execution_seen: false,
            observation_inputs_seen: 0,
        };
        if context.title_input_revision.is_some() && extraction.title_input_revision.is_none() {
            extraction.note(
                "host.title_input_revision",
                "Invalid host title revision ignored; original response remains valid",
            );
        }
        extraction
    }
    fn note(&mut self, path: &str, message: &str) {
        if self.diagnostics.len() < 64 {
            self.diagnostics.push(Diagnostic {
                path: diagnostic_path(path),
                message: message.into(),
            });
        } else {
            self.omitted_diagnostics += 1;
        }
    }
    fn text(&mut self, value: &Value, max: usize, path: &str) -> Option<String> {
        let Some(text) = value
            .as_str()
            .filter(|text| text.chars().take(max + 1).count() <= max)
        else {
            self.note(path, "Invalid or over-limit annotation text");
            return None;
        };
        if text.trim().is_empty() {
            self.note(path, "Empty annotation does not erase prior text");
            return None;
        }
        Some(text.into())
    }
    fn record(
        &mut self,
        kind: AnnotationKind,
        value: String,
        path: &str,
        call_id: Option<&str>,
        observation: Option<(&str, &str)>,
        effective: bool,
    ) {
        let (Some(scope), Some(source)) = (&self.context.scope, &self.context.producer) else {
            self.note(path, "Missing trusted producer/scope");
            return;
        };
        if scope.execution_id.is_empty()
            || source.event_id.is_empty()
            || source.attempt_id.is_empty()
        {
            self.note(path, "Missing trusted producer/scope");
            return;
        }
        let identity = json!([
            source.event_id,
            source.attempt_id,
            scope.execution_id,
            scope.generation,
            call_id,
            path
        ])
        .to_string();
        self.records.push(AnnotationRecord {
            identity,
            protocol: self.context.protocol,
            kind,
            value,
            source: source.clone(),
            ordinal: self.records.len(),
            scope: scope.clone(),
            call_id: call_id.map(str::to_string),
            observation_ref: observation.map(|(r, _)| r.into()),
            observation_event_id: observation.map(|(_, e)| e.into()),
            effective,
            title_input_revision: (kind == AnnotationKind::Title)
                .then(|| self.title_input_revision.clone())
                .flatten(),
        });
    }
    fn extract(
        &mut self,
        value: &Value,
        path: &str,
        call_id: Option<&str>,
        terminal_carrier: bool,
    ) {
        let Some(annotations) = value.as_object() else {
            self.note(path, "Annotation container must be an object");
            return;
        };
        for key in annotations.keys() {
            if !["execution", "intent", "observations"].contains(&key.as_str()) {
                self.note(&format!("{path}.{key}"), "Unknown annotation field ignored");
            }
        }
        if let Some(execution) = annotations.get("execution") {
            if let Some(execution) = execution.as_object() {
                if self.execution_seen {
                    self.note(
                        &format!("{path}.execution"),
                        "Only one execution annotation allowed per response",
                    );
                } else {
                    for (key, value) in execution {
                        let item_path = format!("{path}.execution.{key}");
                        let (kind, max) = match key.as_str() {
                            "title" => (AnnotationKind::Title, 256),
                            "progress" => (AnnotationKind::Progress, 256),
                            "result" => (AnnotationKind::Result, 512),
                            _ => {
                                self.note(&item_path, "Unknown execution annotation field ignored");
                                continue;
                            }
                        };
                        let Some(text) = self.text(value, max, &item_path) else {
                            continue;
                        };
                        if kind == AnnotationKind::Result && !terminal_carrier {
                            self.note(&item_path, "Working response cannot establish final result");
                            continue;
                        }
                        self.execution_seen = true;
                        let effective = kind != AnnotationKind::Result
                            || self.context.execution_fact.as_ref().is_some_and(|fact| {
                                Some(&fact.scope) == self.context.scope.as_ref()
                                    && fact.terminal
                                    && fact.status != "cancelled"
                            });
                        self.record(kind, text, &item_path, None, None, effective);
                    }
                }
            } else {
                self.note(
                    &format!("{path}.execution"),
                    "Invalid execution annotation object",
                );
            }
        }
        if let Some(intent) = annotations.get("intent") {
            let item_path = format!("{path}.intent");
            if let Some(text) = self.text(intent, 256, &item_path) {
                if let Some(call_id) = call_id {
                    self.record(
                        AnnotationKind::Intent,
                        text,
                        &item_path,
                        Some(call_id),
                        None,
                        true,
                    );
                } else {
                    self.note(&item_path, "Terminal response has no work-call intent");
                }
            }
        }
        if let Some(observations) = annotations.get("observations") {
            if let Some(observations) = observations.as_array() {
                let remaining = 16usize.saturating_sub(self.observation_inputs_seen);
                if observations.len() > remaining {
                    self.note(
                        &format!("{path}.observations"),
                        "Response observation limit exceeded",
                    );
                }
                self.observation_inputs_seen = self
                    .observation_inputs_seen
                    .saturating_add(observations.len());
                for (index, observation) in observations.iter().take(remaining).enumerate() {
                    let item_path = format!("{path}.observations[{index}]");
                    let Some(observation) = observation.as_object() else {
                        self.note(&item_path, "Invalid observation object");
                        continue;
                    };
                    for key in observation.keys() {
                        if key != "ref" && key != "result" {
                            self.note(
                                &format!("{item_path}.{key}"),
                                "Unknown observation field ignored",
                            );
                        }
                    }
                    let Some(reference) = observation
                        .get("ref")
                        .and_then(Value::as_str)
                        .filter(|r| !r.is_empty() && r.len() <= 128 && r.is_ascii())
                    else {
                        self.note(&format!("{item_path}.ref"), "Invalid observation ref");
                        continue;
                    };
                    let Some(text) = self.text(
                        observation.get("result").unwrap_or(&Value::Null),
                        512,
                        &format!("{item_path}.result"),
                    ) else {
                        continue;
                    };
                    let target = self.context.observations.get(reference).filter(|target| {
                        target.provided
                            && target.allowed
                            && !target.event_id.is_empty()
                            && Some(&target.scope) == self.context.scope.as_ref()
                    });
                    if let Some(target) = target {
                        self.record(
                            AnnotationKind::ObservationResult,
                            text,
                            &format!("{item_path}.result"),
                            None,
                            Some((reference, &target.event_id)),
                            true,
                        );
                    } else {
                        self.note(
                            &format!("{item_path}.ref"),
                            "Observation not provided or outside trusted execution scope",
                        );
                    }
                }
            } else {
                self.note(
                    &format!("{path}.observations"),
                    "Observations must be an array",
                );
            }
        }
    }
}

pub fn normalize_response(
    response: &Response,
    context: &NormalizationContext,
) -> Result<NormalizedResponse, ProtocolError> {
    if context.protocol == Protocol::Off || context.typed_infer {
        return Ok(NormalizedResponse {
            raw_response: response.clone(),
            execution_response: response.clone(),
            protocol: Protocol::Off,
            records: vec![],
            diagnostics: vec![],
            omitted_diagnostics: 0,
            terminal_decision: None,
            dispatch_allowed: true,
            title_input_revision: None,
        });
    }
    let reply = response
        .tool_calls
        .iter()
        .find(|call| call.func_name == "reply");
    if reply.is_some() && (response.tool_calls.len() != 1 || !response.content.trim().is_empty()) {
        return Err(error("reply must be sole call with no ordinary content"));
    }
    let mut extraction = Extraction::new(context);
    let mut execution_response = response.clone();
    if response
        .tool_calls
        .iter()
        .any(|call| call.func_name == "no_reply")
    {
        // Do not strip or accept annotations in the legacy control grammar.
        terminal(response)?;
    } else if let Some(reply) = reply {
        let args = parse_reply_arguments(&reply.arguments)?;
        if let Some(annotations) = &args.annotations {
            extraction.extract(annotations, "reply.annotations", None, true);
        }
        execution_response.content = args.content;
        execution_response.tool_calls.clear();
    } else {
        for (index, call) in execution_response.tool_calls.iter_mut().enumerate() {
            let mut args: Value = match serde_json::from_str(&call.arguments) {
                Ok(args) => args,
                Err(_) => {
                    extraction.note(
                        &format!("tool_calls[{index}]"),
                        "Business arguments unchanged; original validation remains authoritative",
                    );
                    continue;
                }
            };
            if let Some(annotations) = args
                .as_object_mut()
                .and_then(|args| args.remove("_annotations"))
            {
                extraction.extract(
                    &annotations,
                    &format!("tool_calls[{index}]._annotations"),
                    Some(&call.id),
                    false,
                );
                call.arguments = args.to_string();
            }
        }
    }
    let terminal_decision = terminal(&execution_response)?;
    if context.protocol == Protocol::V2
        && matches!(terminal_decision, Some(TerminalDecision::Deliver(_)))
        && (reply.is_none()
            || ![AnnotationKind::Title, AnnotationKind::Result]
                .iter()
                .all(|kind| extraction.records.iter().any(|record| record.kind == *kind)))
    {
        return Err(error(
            "Required final reply title and result annotations are absent or invalid",
        ));
    }
    let dispatch_allowed = !context.execution_fact.as_ref().is_some_and(|fact| {
        Some(&fact.scope) == context.scope.as_ref() && fact.status == "cancelled"
    });
    Ok(NormalizedResponse {
        raw_response: response.clone(),
        execution_response,
        protocol: context.protocol,
        records: extraction.records,
        diagnostics: extraction.diagnostics,
        omitted_diagnostics: extraction.omitted_diagnostics,
        terminal_decision,
        dispatch_allowed,
        title_input_revision: extraction.title_input_revision,
    })
}

pub fn merge_records(
    existing: &[AnnotationRecord],
    incoming: &[AnnotationRecord],
) -> (Vec<AnnotationRecord>, Vec<String>) {
    let mut records = existing.to_vec();
    let mut indices: HashMap<String, usize> = records
        .iter()
        .enumerate()
        .map(|(i, r)| (r.identity.clone(), i))
        .collect();
    let mut conflicts = vec![];
    for record in incoming {
        match indices.get(&record.identity) {
            Some(index) if records[*index] != *record => conflicts.push(record.identity.clone()),
            Some(_) => (),
            None => {
                indices.insert(record.identity.clone(), records.len());
                records.push(record.clone());
            }
        }
    }
    (records, conflicts)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutionProjection {
    pub status: String,
    pub title: Option<String>,
    pub progress: Option<String>,
    pub result: Option<String>,
}
pub fn project_execution(
    fact: &ExecutionFact,
    records: &[AnnotationRecord],
) -> ExecutionProjection {
    let mut matching: Vec<_> = records
        .iter()
        .filter(|record| {
            record.scope == fact.scope
                && record.source.sequence.is_some()
                && (!fact.terminal
                    || fact.terminal_sequence.is_none()
                    || record.source.sequence <= fact.terminal_sequence)
        })
        .collect();
    matching.sort_by_key(|record| (record.source.sequence, record.ordinal));
    let last = |kind| {
        matching
            .iter()
            .rev()
            .find(|r| r.kind == kind)
            .map(|r| r.value.clone())
    };
    // Within one host-proven input revision, the first valid title remains
    // stable. Newer supplemental input may rename the whole task; a delayed
    // response to older input must not replace the newer task title.
    let mut title = None;
    let mut title_revision = 0;
    for record in matching.iter().filter(|record| {
        record.kind == AnnotationKind::Title
            && !record.value.trim().is_empty()
            && record.value.chars().take(257).count() <= 256
    }) {
        let revision = record
            .title_input_revision
            .as_ref()
            .filter(|revision| revision.precedes(record.source.sequence))
            .map(|revision| revision.sequence)
            .unwrap_or(0);
        if title.is_none() || revision > title_revision {
            title = Some(record.value.clone());
            title_revision = revision;
        }
    }
    ExecutionProjection {
        status: fact.status.clone(),
        title,
        progress: if fact.terminal {
            None
        } else {
            last(AnnotationKind::Progress)
        },
        result: if fact.terminal && fact.status != "cancelled" {
            matching
                .iter()
                .rev()
                .find(|r| r.kind == AnnotationKind::Result && r.effective)
                .map(|r| r.value.clone())
        } else {
            None
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::ToolCallRepr;
    fn call(id: &str, name: &str, args: Value) -> ToolCallRepr {
        ToolCallRepr {
            id: id.into(),
            r#type: "function".into(),
            func_name: name.into(),
            arguments: args.to_string(),
        }
    }
    fn response(calls: Vec<ToolCallRepr>) -> Response {
        Response {
            content: String::new(),
            tool_calls: calls,
        }
    }
    fn tool() -> ToolDefinition {
        ToolDefinition {
            name: "exec".into(),
            description: "Synthetic".into(),
            parameters: json!({"type":"object","additionalProperties":false,"required":["command"],"properties":{"command":{"type":"string"},"payload":{"type":"object"}}}),
        }
    }
    fn context() -> NormalizationContext {
        let scope = ExecutionScope {
            execution_id: "execution-1".into(),
            generation: 3,
        };
        let mut observations = HashMap::new();
        observations.insert(
            "@e123".into(),
            TrustedObservation {
                event_id: "event-123".into(),
                scope: scope.clone(),
                provided: true,
                allowed: true,
            },
        );
        observations.insert(
            "@future".into(),
            TrustedObservation {
                event_id: "future-event".into(),
                scope: scope.clone(),
                provided: false,
                allowed: true,
            },
        );
        observations.insert(
            "@other".into(),
            TrustedObservation {
                event_id: "other-event".into(),
                scope: ExecutionScope {
                    execution_id: "other".into(),
                    generation: 3,
                },
                provided: true,
                allowed: true,
            },
        );
        observations.insert(
            "@old".into(),
            TrustedObservation {
                event_id: "old-event".into(),
                scope: ExecutionScope {
                    execution_id: "execution-1".into(),
                    generation: 2,
                },
                provided: true,
                allowed: true,
            },
        );
        NormalizationContext {
            protocol: Protocol::V1,
            scope: Some(scope),
            producer: Some(Producer {
                event_id: "response-event".into(),
                attempt_id: "attempt".into(),
                sequence: Some(9),
            }),
            observations,
            ..Default::default()
        }
    }
    fn persisted_event(sequence: u64, execution: Value, terminal: bool) -> Event {
        persisted_event_with_revision(sequence, execution, terminal, None)
    }
    fn persisted_event_with_revision(
        sequence: u64,
        execution: Value,
        terminal: bool,
        revision: Option<TitleInputRevision>,
    ) -> Event {
        let mut ctx = context();
        ctx.title_input_revision = revision;
        ctx.producer = Some(Producer {
            event_id: format!("event-{sequence}"),
            attempt_id: format!("model-{sequence}"),
            // Deliberately not the Store sequence; a payload cannot set order.
            sequence: Some(9999),
        });
        if terminal {
            ctx.execution_fact = Some(ExecutionFact {
                scope: ctx.scope.clone().unwrap(),
                status: "completed".into(),
                terminal: true,
                terminal_sequence: Some(sequence),
            });
        }
        let (name, args) = if terminal {
            (
                "reply",
                json!({"content":"正文","annotations":{"execution":execution}}),
            )
        } else {
            (
                "exec",
                json!({"command":"safe","_annotations":{"execution":execution}}),
            )
        };
        let normalized =
            normalize_response(&response(vec![call("call", name, args)]), &ctx).unwrap();
        let bundle = PersistedAnnotations::from_normalized(ctx.scope.clone().unwrap(), &normalized);
        let mut event = Event::new(
            format!("event-{sequence}"), "Agent-Morphz".into(), TYPE_AGENT_CALL.into(),
            "chat/assistant_call".into(),
            json!({"thread_id":"execution-1","thread_generation":3,"model_attempt_id":format!("model-{sequence}"),BUNDLE_PAYLOAD_KEY:bundle}).as_object().unwrap().clone(),
        );
        event.sequence = Some(sequence);
        event
    }
    #[test]
    fn acceptance_receipt_is_source_bound_not_selected_state_or_model_prose() {
        let event = persisted_event(
            10,
            json!({"title":"DO_NOT_REPEAT_TITLE", "progress":"DO_NOT_REPEAT_STEP"}),
            false,
        );
        let scope = context().scope.unwrap();
        let receipt = receipt_from_authorized_event(
            &event,
            &scope,
            Protocol::V1,
            "actual-activation",
            "model-10",
        )
        .unwrap();
        assert_eq!(receipt.state, ReceiptState::Accepted);
        assert_eq!(receipt.source_sequence, Some(10));
        assert_eq!(receipt.accepted.len(), 2);
        assert!(receipt
            .accepted
            .iter()
            .any(|record| record.kind == AnnotationKind::Title));
        assert!(receipt
            .accepted
            .iter()
            .any(|record| record.kind == AnnotationKind::Progress));
        let encoded = receipt.expression().to_string();
        assert!(encoded.contains("(source-seq 10)"));
        assert!(encoded.contains("(activation actual-activation)"));
        assert!(!encoded.contains("DO_NOT_REPEAT"));
        assert!(!encoded.contains("effective"));
        assert!(!encoded.contains("tool-success"));
        assert!(receipt_from_authorized_event(
            &event,
            &scope,
            Protocol::Off,
            "actual-activation",
            "model-10"
        )
        .is_none());
        let mut missing = event.clone();
        missing.payload.remove(BUNDLE_PAYLOAD_KEY);
        let unknown = receipt_from_authorized_event(
            &missing,
            &scope,
            Protocol::V1,
            "actual-activation",
            "model-10",
        )
        .unwrap();
        assert_eq!(unknown.state, ReceiptState::Unknown);
        assert!(unknown.accepted.is_empty());
        let mut broken = event;
        broken
            .payload
            .insert(BUNDLE_PAYLOAD_KEY.into(), json!({"broken":true}));
        assert_eq!(
            receipt_from_authorized_event(
                &broken,
                &scope,
                Protocol::V1,
                "actual-activation",
                "model-10"
            )
            .unwrap()
            .state,
            ReceiptState::Unknown
        );
    }

    #[test]
    fn acceptance_receipt_is_bounded_by_real_sexpr_bytes_and_precise_unique_call_id() {
        let ctx = context();
        let raw = response(
            (0..18)
                .map(|i| {
                    call(
                        &format!("{i}-{}", "\\\"".repeat(60)),
                        "exec",
                        json!({"command":"safe", "_annotations":{"intent":"accepted"}}),
                    )
                })
                .collect(),
        );
        let normalized = normalize_response(&raw, &ctx).unwrap();
        let mut event = Event::new("response-event".into(), "Agent-Morphz".into(), TYPE_AGENT_CALL.into(), "chat/assistant_call".into(), json!({"thread_id":"execution-1", "thread_generation":3, "model_attempt_id":"attempt", BUNDLE_PAYLOAD_KEY:PersistedAnnotations::from_normalized(ctx.scope.clone().unwrap(), &normalized)}).as_object().unwrap().clone());
        event.sequence = Some(9);
        let receipt = receipt_from_authorized_event(
            &event,
            ctx.scope.as_ref().unwrap(),
            Protocol::V1,
            "actual-activation",
            "attempt",
        )
        .unwrap();
        assert!(receipt.truncated);
        assert!(receipt.accepted.len() <= RECEIPT_DETAIL_LIMIT);
        assert!(receipt.expression().to_string().len() <= RECEIPT_BYTE_LIMIT);
        for field in &receipt.accepted {
            let id = field.call_id.as_deref().unwrap();
            assert_eq!(
                raw.tool_calls.iter().filter(|call| call.id == id).count(),
                1
            );
        }
        let mut bundle: PersistedAnnotations =
            serde_json::from_value(event.payload[BUNDLE_PAYLOAD_KEY].clone()).unwrap();
        bundle.raw_response.tool_calls[1].id = bundle.raw_response.tool_calls[0].id.clone();
        let duplicate = bundle.raw_response.tool_calls[0].id.clone();
        event.payload.insert(
            BUNDLE_PAYLOAD_KEY.into(),
            serde_json::to_value(bundle).unwrap(),
        );
        let rejected = receipt_from_authorized_event(
            &event,
            ctx.scope.as_ref().unwrap(),
            Protocol::V1,
            "actual-activation",
            "attempt",
        )
        .unwrap();
        assert!(rejected.truncated);
        assert!(!rejected
            .accepted
            .iter()
            .any(|field| field.call_id.as_deref() == Some(duplicate.as_str())));
        let overlong = receipt_from_authorized_event(
            &event,
            ctx.scope.as_ref().unwrap(),
            Protocol::V1,
            &"x".repeat(129),
            "attempt",
        )
        .unwrap();
        assert_eq!(overlong.state, ReceiptState::Unknown);
        assert!(overlong.activation_id.is_none());
        assert!(overlong.accepted.is_empty());
    }

    #[test]
    fn acceptance_receipt_none_is_per_source_and_work_result_is_not_final() {
        let event = persisted_event(10, json!({"result":"REJECT_WORK_RESULT"}), false);
        let scope = context().scope.unwrap();
        let receipt =
            receipt_from_authorized_event(&event, &scope, Protocol::V1, "activation", "model-10")
                .unwrap();
        assert_eq!(receipt.state, ReceiptState::NoneAccepted);
        assert!(receipt.accepted.is_empty());
        assert_eq!(receipt.diagnostic_count, Some(1));
        assert!(!receipt
            .expression()
            .to_string()
            .contains("execution.result"));
        let mut terminal = persisted_event(11, json!({"result":"DO_NOT_REPEAT_RESULT"}), true);
        terminal
            .payload
            .insert("terminal_outcome".into(), json!(true));
        let final_receipt = receipt_from_authorized_event(
            &terminal,
            &scope,
            Protocol::V1,
            "activation",
            "model-11",
        )
        .unwrap();
        assert_eq!(final_receipt.accepted[0].kind, AnnotationKind::Result);
        assert!(!final_receipt
            .expression()
            .to_string()
            .contains("DO_NOT_REPEAT_RESULT"));
        terminal.payload.remove("terminal_outcome");
        assert!(!receipt_from_authorized_event(
            &terminal,
            &scope,
            Protocol::V1,
            "activation",
            "model-11"
        )
        .unwrap()
        .accepted
        .iter()
        .any(|record| record.kind == AnnotationKind::Result));
    }

    #[test]
    fn host_title_revision_is_optional_and_does_not_change_model_schema_or_initial_shape() {
        let legacy = persisted_event(10, json!({"title":"原始整项工作"}), false);
        let bundle = &legacy.payload[BUNDLE_PAYLOAD_KEY];
        assert!(bundle.get("title_input_revision").is_none());
        assert!(bundle["records"][0].get("title_input_revision").is_none());
        assert!(!annotation_schema()
            .to_string()
            .contains("title_input_revision"));
        let raw = response(vec![call(
            "call",
            "exec",
            json!({"command":"unchanged",
            "_annotations":{"execution":{"title":"整项工作", "title_input_revision":{"event_id":"invented","sequence":999}}}}),
        )]);
        let normalized = normalize_response(&raw, &context()).unwrap();
        assert!(normalized.title_input_revision.is_none());
        assert!(normalized
            .records
            .iter()
            .all(|record| record.title_input_revision.is_none()));
        assert_eq!(normalized.execution_response.tool_calls.len(), 1);
        assert_eq!(
            serde_json::from_str::<Value>(&normalized.execution_response.tool_calls[0].arguments)
                .unwrap(),
            json!({"command":"unchanged"})
        );
        let mut off = context();
        off.protocol = Protocol::Off;
        off.title_input_revision = Some(TitleInputRevision {
            event_id: "host-steer".into(),
            sequence: 8,
        });
        let normalized = normalize_response(&raw, &off).unwrap();
        assert!(normalized.title_input_revision.is_none());
        assert_eq!(
            serde_json::to_vec(&normalized.execution_response).unwrap(),
            serde_json::to_vec(&raw).unwrap()
        );
    }
    #[test]
    fn title_revision_updates_once_per_actual_input_and_ignores_reorder_replay_and_old_late_response(
    ) {
        let scope = context().scope.unwrap();
        let first = persisted_event(10, json!({"title":"初始整项工作"}), false);
        let revision = TitleInputRevision {
            event_id: "accepted-steer-15".into(),
            sequence: 15,
        };
        let updated = persisted_event_with_revision(
            20,
            json!({"title":"补充后的整项工作"}),
            false,
            Some(revision.clone()),
        );
        let later_step = persisted_event_with_revision(
            25,
            json!({"title":"不该成为标题的第二步"}),
            false,
            Some(revision),
        );
        let old_late = persisted_event(30, json!({"title":"旧请求迟到的标题"}), false);
        let next_revision = TitleInputRevision {
            event_id: "accepted-steer-35".into(),
            sequence: 35,
        };
        let next = persisted_event_with_revision(
            40,
            json!({"title":"再次补充后的整项工作"}),
            false,
            Some(next_revision.clone()),
        );
        let next_step = persisted_event_with_revision(
            45,
            json!({"title":"不该覆盖的新步骤"}),
            false,
            Some(next_revision),
        );
        let mut events = vec![
            old_late,
            next_step,
            later_step,
            next,
            first,
            updated.clone(),
            updated,
        ];
        let mut fact = ExecutionFact {
            scope,
            status: "working".into(),
            terminal: false,
            terminal_sequence: None,
        };
        assert_eq!(
            project_authorized_events(&fact, &events)
                .unwrap()
                .title
                .as_deref(),
            Some("再次补充后的整项工作")
        );
        events.reverse();
        assert_eq!(
            project_authorized_events(&fact, &events)
                .unwrap()
                .title
                .as_deref(),
            Some("再次补充后的整项工作")
        );
        fact.terminal = true;
        fact.status = "completed".into();
        fact.terminal_sequence = Some(28);
        assert_eq!(
            project_authorized_events(&fact, &events)
                .unwrap()
                .title
                .as_deref(),
            Some("补充后的整项工作")
        );
    }
    #[test]
    fn newer_revision_without_valid_title_keeps_previous_title_until_first_valid_candidate() {
        let initial = persisted_event(10, json!({"title":"原始整项工作"}), false);
        let revision = TitleInputRevision {
            event_id: "accepted-steer-15".into(),
            sequence: 15,
        };
        let missing = persisted_event_with_revision(
            20,
            json!({"progress":"执行补充要求"}),
            false,
            Some(revision.clone()),
        );
        let empty = persisted_event_with_revision(
            25,
            json!({"title":"   "}),
            false,
            Some(revision.clone()),
        );
        let valid = persisted_event_with_revision(
            30,
            json!({"title":"补充后的整项工作"}),
            false,
            Some(revision),
        );
        let fact = ExecutionFact {
            scope: context().scope.unwrap(),
            status: "working".into(),
            terminal: false,
            terminal_sequence: None,
        };
        assert_eq!(
            project_authorized_events(&fact, &[missing.clone(), empty.clone(), initial.clone()])
                .unwrap()
                .title
                .as_deref(),
            Some("原始整项工作")
        );
        assert_eq!(
            project_authorized_events(&fact, &[valid, empty, missing, initial])
                .unwrap()
                .title
                .as_deref(),
            Some("补充后的整项工作")
        );
    }
    #[test]
    fn malformed_host_title_revision_falls_back_locally_without_changing_action() {
        let raw = response(vec![call(
            "call",
            "exec",
            json!({"command":"unchanged", "_annotations":{"execution":{"title":"整项工作"}}}),
        )]);
        for revision in [
            TitleInputRevision {
                event_id: "".into(),
                sequence: 8,
            },
            TitleInputRevision {
                event_id: "a".repeat(257),
                sequence: 8,
            },
            TitleInputRevision {
                event_id: "accepted-steer".into(),
                sequence: 0,
            },
            TitleInputRevision {
                event_id: "future".into(),
                sequence: 9,
            },
        ] {
            let mut ctx = context();
            ctx.title_input_revision = Some(revision);
            let normalized = normalize_response(&raw, &ctx).unwrap();
            assert!(normalized.title_input_revision.is_none());
            assert!(normalized.records[0].title_input_revision.is_none());
            assert_eq!(normalized.execution_response.tool_calls.len(), 1);
            assert!(normalized
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.path == "host.title_input_revision"));
        }
        let scope = context().scope.unwrap();
        for bad in [
            json!("bad"),
            json!({"event_id":"","sequence":8}),
            json!({"event_id":"bad","sequence":0}),
            json!({"event_id":"future","sequence":12}),
        ] {
            let mut event = persisted_event(12, json!({"title":"旧整项工作"}), false);
            event.payload.get_mut(BUNDLE_PAYLOAD_KEY).unwrap()["title_input_revision"] =
                bad.clone();
            event.payload.get_mut(BUNDLE_PAYLOAD_KEY).unwrap()["records"][0]
                ["title_input_revision"] = bad;
            let bundle = annotations_from_authorized_event(&event, &scope)
                .unwrap()
                .unwrap();
            assert!(bundle.title_input_revision.is_none());
            assert!(bundle.records[0].title_input_revision.is_none());
            assert_eq!(bundle.records[0].value, "旧整项工作");
            assert_eq!(bundle.raw_response.tool_calls.len(), 1);
            assert!(bundle.diagnostics.len() <= 64);
        }
        let mut mismatch = persisted_event_with_revision(
            12,
            json!({"title":"整项工作"}),
            false,
            Some(TitleInputRevision {
                event_id: "accepted-steer-8".into(),
                sequence: 8,
            }),
        );
        mismatch.payload.get_mut(BUNDLE_PAYLOAD_KEY).unwrap()["records"][0]
            ["title_input_revision"]["sequence"] = json!(7);
        assert!(annotations_from_authorized_event(&mismatch, &scope)
            .unwrap()
            .unwrap()
            .title_input_revision
            .is_none());
    }
    #[test]
    fn protocol_version_is_explicit_default_off_and_contract_is_opt_in() {
        assert_eq!(Protocol::default(), Protocol::Off);
        assert!(Protocol::Off.is_off());
        assert!(!Protocol::V1.is_off());
        for protocol in [Protocol::Off, Protocol::V1, Protocol::V2] {
            assert_eq!(Protocol::from_str(protocol.as_str()).unwrap(), protocol);
            assert_eq!(protocol.as_str().parse::<Protocol>().unwrap(), protocol);
            assert_eq!(
                serde_json::to_value(protocol).unwrap(),
                json!(protocol.as_str())
            );
            assert_eq!(
                serde_json::from_value::<Protocol>(json!(protocol.as_str())).unwrap(),
                protocol
            );
        }
        assert!(Protocol::from_str("v3").is_err());
        assert_eq!(Protocol::Off.contract(), None);
        assert_eq!(Protocol::V1.contract(), Some(CONTRACT_V1));
        assert_eq!(Protocol::V2.contract(), Some(CONTRACT_V2));
        assert!(serde_json::from_value::<Protocol>(json!(true)).is_err());
        assert!(CONTRACT_V1.contains("ENTIRE current Execution"));
        assert!(CONTRACT_V1.contains("do not add calls or inference rounds"));
        assert_ne!(BUNDLE_PAYLOAD_KEY, "response_annotations");
    }
    #[test]
    fn persisted_bundle_hydrates_actual_enclosing_event_order_and_keeps_raw_provider_args() {
        let event = persisted_event(12, json!({"title":"完整工作","progress":"阶段"}), false);
        let scope = context().scope.unwrap();
        let bundle = annotations_from_authorized_event(&event, &scope)
            .unwrap()
            .unwrap();
        assert!(bundle.records.iter().all(|r| r.source.sequence == Some(12)));
        let original: PersistedAnnotations =
            serde_json::from_value(event.payload[BUNDLE_PAYLOAD_KEY].clone()).unwrap();
        assert!(original
            .records
            .iter()
            .all(|r| r.source.sequence == Some(9999)));
        assert_eq!(
            serde_json::to_string(&bundle.raw_response).unwrap(),
            serde_json::to_string(&original.raw_response).unwrap()
        );
        assert!(bundle.raw_response.tool_calls[0]
            .arguments
            .contains("_annotations"));
        assert_eq!(
            event.payload[BUNDLE_PAYLOAD_KEY]["records"][0]["source"]["sequence"],
            json!(9999)
        );
        let mut absent = event.clone();
        absent.payload.remove(BUNDLE_PAYLOAD_KEY);
        assert!(records_from_authorized_event(&absent, &scope)
            .unwrap()
            .is_empty());
    }
    #[test]
    fn persisted_bundle_refuses_unpersisted_wrong_thread_generation_attempt_and_source() {
        let event = persisted_event(12, json!({"title":"完整工作"}), false);
        let scope = context().scope.unwrap();
        let mut invalid = event.clone();
        invalid.sequence = None;
        assert!(records_from_authorized_event(&invalid, &scope).is_err());
        for (field, value) in [
            ("thread_id", json!("other")),
            ("thread_generation", json!(2)),
            ("model_attempt_id", json!("other")),
        ] {
            let mut invalid = event.clone();
            invalid.payload.insert(field.into(), value);
            assert!(
                records_from_authorized_event(&invalid, &scope).is_err(),
                "{field}"
            );
        }
        for (path, value) in [("event_id", json!("other")), ("attempt_id", json!("other"))] {
            let mut invalid = event.clone();
            invalid.payload.get_mut(BUNDLE_PAYLOAD_KEY).unwrap()["records"][0]["source"][path] =
                value;
            assert!(
                records_from_authorized_event(&invalid, &scope).is_err(),
                "{path}"
            );
        }
        let mut invalid = event.clone();
        invalid.payload.get_mut(BUNDLE_PAYLOAD_KEY).unwrap()["scope"]["generation"] = json!(2);
        assert!(records_from_authorized_event(&invalid, &scope).is_err());
        let mut invalid = event.clone();
        invalid.payload.get_mut(BUNDLE_PAYLOAD_KEY).unwrap()["records"][0]["scope"]
            ["execution_id"] = json!("other");
        assert!(records_from_authorized_event(&invalid, &scope).is_err());
        let mut invalid = event;
        invalid.topic = "chat/tool_output".into();
        assert!(records_from_authorized_event(&invalid, &scope).is_err());
    }
    #[test]
    fn authorized_event_projection_uses_store_order_first_title_last_result_and_wait_is_not_terminal(
    ) {
        let first = persisted_event(10, json!({"title":"完整工作","progress":"初始阶段"}), false);
        let later = persisted_event(
            20,
            json!({"title":"不能改成步骤","progress":"最新阶段"}),
            false,
        );
        let result = persisted_event(30, json!({"result":"最终结果"}), true);
        let mut waiting = persisted_event(40, json!({"result":"尚未终结候选"}), true);
        waiting.topic = "runtime/thread_waiting".into();
        waiting.payload.remove("model_attempt_id");
        let fact = ExecutionFact {
            scope: context().scope.unwrap(),
            status: "running".into(),
            terminal: false,
            terminal_sequence: None,
        };
        let records = records_from_authorized_event(&waiting, &fact.scope).unwrap();
        assert!(records.iter().all(|r| !r.effective));
        let mut events = vec![later, first.clone(), first, result, waiting];
        for _ in 0..2 {
            let running = project_authorized_events(&fact, &events).unwrap();
            assert_eq!(running.title.as_deref(), Some("完整工作"));
            assert_eq!(running.progress.as_deref(), Some("最新阶段"));
            let completed = project_authorized_events(
                &ExecutionFact {
                    status: "completed".into(),
                    terminal: true,
                    terminal_sequence: Some(40),
                    ..fact.clone()
                },
                &events,
            )
            .unwrap();
            assert_eq!(completed.title.as_deref(), Some("完整工作"));
            assert_eq!(completed.result.as_deref(), Some("最终结果"));
            assert!(completed.progress.is_none());
            let cancelled = project_authorized_events(
                &ExecutionFact {
                    status: "cancelled".into(),
                    terminal: true,
                    terminal_sequence: Some(40),
                    ..fact.clone()
                },
                &events,
            )
            .unwrap();
            assert!(cancelled.result.is_none());
            events.reverse();
        }
    }
    #[test]
    fn runtime_style_baseline_off_serialized_response_schema_and_stream_contract_unchanged() {
        let tools = vec![ToolDefinition {
            name: "reply".into(),
            ..tool()
        }];
        assert_eq!(
            serde_json::to_vec(&tools).unwrap(),
            serde_json::to_vec(&augment_tools(&tools, Protocol::Off, false).unwrap()).unwrap()
        );
        let raw = response(vec![call(
            "1",
            "reply",
            json!({"command":"business", "_annotations":{"business":true}}),
        )]);
        let normalized = normalize_response(&raw, &NormalizationContext::default()).unwrap();
        assert_eq!(
            serde_json::to_vec(&raw).unwrap(),
            serde_json::to_vec(&normalized.execution_response).unwrap()
        );
        assert!(normalized.records.is_empty());
        assert!(normalized.terminal_decision.is_none());
        let mut typed = context();
        typed.typed_infer = true;
        assert_eq!(
            serde_json::to_vec(&raw).unwrap(),
            serde_json::to_vec(&normalize_response(&raw, &typed).unwrap().execution_response)
                .unwrap()
        );
    }
    #[test]
    fn schema_additive_optional_and_collisions_refused() {
        let original = tool();
        let before = serde_json::to_vec(&original).unwrap();
        let augmented =
            augment_tools(std::slice::from_ref(&original), Protocol::V1, false).unwrap();
        assert_eq!(before, serde_json::to_vec(&original).unwrap());
        assert_eq!(augmented[0].parameters["required"], json!(["command"]));
        assert_eq!(
            augmented[0].parameters["properties"]["command"],
            original.parameters["properties"]["command"]
        );
        assert_eq!(augmented[1].name, "reply");
        assert!(augment_tools(
            &[ToolDefinition {
                name: "reply".into(),
                ..original.clone()
            }],
            Protocol::V1,
            false
        )
        .is_err());
        let mut occupied = original;
        occupied.parameters["properties"]["_annotations"] = json!({});
        assert!(augment_tools(&[occupied], Protocol::V1, false).is_err());
    }
    #[test]
    fn work_args_raw_and_nested_business_fields_preserved_precise_refs_only() {
        let args = json!({"command":"printf '中文\\n' \"$UNCHANGED\"", "payload":{"_annotations":{"business":true}},"_annotations":{
            "execution":{"title":"检查环境","result":"不能提前完成"},"intent":"确认架构","observations":[
                {"ref":"@e123","result":"Linux"},{"ref":"@future","result":"future"},{"ref":"@other","result":"other"},{"ref":"@old","result":"old"}]}});
        let raw = response(vec![call("provider-id", "exec", args.clone())]);
        let normalized = normalize_response(&raw, &context()).unwrap();
        assert_eq!(
            raw.tool_calls[0].arguments,
            normalized.raw_response.tool_calls[0].arguments
        );
        let mut expected = args;
        expected.as_object_mut().unwrap().remove("_annotations");
        assert_eq!(
            serde_json::from_str::<Value>(&normalized.execution_response.tool_calls[0].arguments)
                .unwrap(),
            expected
        );
        assert_eq!(normalized.records.len(), 3);
        assert!(normalized.terminal_decision.is_none());
        let intent = normalized
            .records
            .iter()
            .find(|r| r.kind == AnnotationKind::Intent)
            .unwrap();
        assert_eq!(intent.call_id.as_deref(), Some("provider-id"));
        let observation = normalized
            .records
            .iter()
            .find(|r| r.kind == AnnotationKind::ObservationResult)
            .unwrap();
        assert_eq!(
            observation.observation_event_id.as_deref(),
            Some("event-123")
        );
    }
    #[test]
    fn batch_global_observation_limit_and_per_call_intents() {
        let observations: Vec<_> = (0..16)
            .map(|_| json!({"ref":"@e123","result":"有效"}))
            .collect();
        let raw = response((0..2).map(|i| call(&format!("call-{i}"), "exec", json!({"command":"x", "_annotations":{"intent":format!("step-{i}"),"execution":{"title":format!("title-{i}")},"observations":observations}}))).collect());
        let normalized = normalize_response(&raw, &context()).unwrap();
        assert_eq!(
            normalized
                .records
                .iter()
                .filter(|r| r.kind == AnnotationKind::ObservationResult)
                .count(),
            16
        );
        assert_eq!(
            normalized
                .records
                .iter()
                .filter(|r| r.kind == AnnotationKind::Intent)
                .count(),
            2
        );
        assert_eq!(
            normalized
                .records
                .iter()
                .filter(|r| r.kind == AnnotationKind::Title)
                .count(),
            1
        );
    }
    #[test]
    fn malformed_metadata_fallback_unicode_limit_and_diagnostics_bounded() {
        let raw = response(vec![call(
            "1",
            "exec",
            json!({"command":"x","_annotations":{"execution":{"title":"🧠".repeat(256),"progress":"🧠".repeat(257),"status":"success"},"intent":12,"observations":[{"ref":"@e123","result":"有效"}]}}),
        )]);
        let normalized = normalize_response(&raw, &context()).unwrap();
        assert_eq!(normalized.records.len(), 2);
        assert_eq!(normalized.execution_response.tool_calls.len(), 1);
        let mut unknown = serde_json::Map::new();
        for i in 0..100 {
            unknown.insert(format!("unknown-{i}"), Value::Null);
        }
        let excessive = normalize_response(
            &response(vec![call(
                "2",
                "exec",
                json!({"command":"x","_annotations":unknown}),
            )]),
            &context(),
        )
        .unwrap();
        assert_eq!(excessive.diagnostics.len(), 64);
        assert_eq!(excessive.omitted_diagnostics, 36);
    }
    #[test]
    fn oversized_unknown_keys_keep_diagnostics_bounded_without_changing_business_action() {
        let mut unknown = serde_json::Map::new();
        for index in 0..100 {
            unknown.insert(format!("{}{index}", "🧠".repeat(1000)), Value::Null);
        }
        let raw = response(vec![call(
            "work",
            "exec",
            json!({"command":"unchanged","payload":{"_annotations":"business"},"_annotations":unknown}),
        )]);
        let normalized = normalize_response(&raw, &context()).unwrap();
        assert_eq!(normalized.diagnostics.len(), 64);
        assert_eq!(normalized.omitted_diagnostics, 36);
        assert!(normalized.diagnostics.iter().all(|diagnostic| {
            diagnostic.path.chars().count() <= 256 && diagnostic.path.ends_with('…')
        }));
        assert_eq!(
            normalized.raw_response.tool_calls[0].arguments,
            raw.tool_calls[0].arguments
        );
        assert_eq!(
            serde_json::from_str::<Value>(&normalized.execution_response.tool_calls[0].arguments)
                .unwrap(),
            json!({"command":"unchanged","payload":{"_annotations":"business"}})
        );
        assert!(normalized.terminal_decision.is_none());
        assert!(normalized.records.is_empty());
    }
    #[test]
    fn v2_requires_valid_same_response_title_and_result_not_prior_metadata() {
        let mut ctx = context();
        ctx.protocol = Protocol::V2;
        for annotations in [
            None,
            Some(Value::Null),
            Some(json!({})),
            Some(json!({"execution":null})),
            Some(json!({"execution":{"title":"整项工作"}})),
            Some(json!({"execution":{"result":"完成"}})),
            Some(json!({"execution":{"title":" ","result":"完成"}})),
            Some(json!({"execution":{"title":"整项工作","result":null}})),
            Some(json!({"execution":{"title":"🧠".repeat(257),"result":"完成"}})),
            Some(json!({"execution":{"title":"整项工作","result":"🧠".repeat(513)}})),
        ] {
            let mut args = json!({"content":"已流出的草稿"});
            if let Some(annotations) = annotations {
                args["annotations"] = annotations;
            }
            let raw = response(vec![call("r", "reply", args)]);
            assert!(normalize_response(&raw, &ctx).is_err());
            assert!(
                normalize_response(&raw, &context()).is_ok(),
                "V1 remains optional"
            );
        }
        let plain = Response {
            content: "正文".into(),
            tool_calls: vec![],
        };
        assert!(normalize_response(&plain, &ctx).is_err());
        assert!(normalize_response(&plain, &context()).is_ok());
        let valid = response(vec![call(
            "r",
            "reply",
            json!({"content":"正文",
            "annotations":{"execution":{"title":"整项工作","result":"完成"},
            "progress":null,"observations":[{"ref":"@other","result":"越界"}]}}),
        )]);
        let normalized = normalize_response(&valid, &ctx).unwrap();
        assert_eq!(normalized.protocol, Protocol::V2);
        assert!(normalized
            .records
            .iter()
            .all(|record| record.protocol == Protocol::V2));
        assert_eq!(normalized.records.len(), 2);
        assert!(
            !normalized.diagnostics.is_empty(),
            "optional bad fields still downgrade locally"
        );
        assert_eq!(normalized.execution_response.content, "正文");
        assert!(normalized.execution_response.tool_calls.is_empty());
        for missing_scope in [true, false] {
            let mut unbound = ctx.clone();
            if missing_scope {
                unbound.scope = None;
            } else {
                unbound.producer = None;
            }
            assert!(
                normalize_response(&valid, &unbound).is_err(),
                "required records must actually bind"
            );
        }
    }

    #[test]
    fn v2_schema_keeps_work_optional_but_terminal_metadata_required() {
        let original = tool();
        let augmented =
            augment_tools(std::slice::from_ref(&original), Protocol::V2, false).unwrap();
        assert_eq!(
            augmented[0].parameters["required"],
            original.parameters["required"]
        );
        let terminal = &augmented[1].parameters;
        assert_eq!(terminal["required"], json!(["content", "annotations"]));
        let annotations = &terminal["properties"]["annotations"];
        assert_eq!(annotations["required"], json!(["execution"]));
        let execution = &annotations["properties"]["execution"];
        assert_eq!(execution["required"], json!(["title", "result"]));
        assert_eq!(execution["properties"]["title"]["minLength"], 1);
        assert_eq!(execution["properties"]["result"]["minLength"], 1);
        assert_eq!(
            serde_json::to_value(
                augment_tools(std::slice::from_ref(&original), Protocol::V2, true).unwrap()
            )
            .unwrap(),
            serde_json::to_value(vec![original]).unwrap()
        );
    }

    #[test]
    fn v2_optional_work_no_reply_and_typed_infer_keep_existing_boundaries() {
        let mut ctx = context();
        ctx.protocol = Protocol::V2;
        let work = response(vec![call("w", "exec", json!({"command":"unchanged"}))]);
        let normalized = normalize_response(&work, &ctx).unwrap();
        assert_eq!(normalized.protocol, Protocol::V2);
        assert_eq!(
            serde_json::to_value(normalized.execution_response).unwrap(),
            serde_json::to_value(work).unwrap()
        );
        assert!(normalized.records.is_empty() && normalized.terminal_decision.is_none());
        for args in [
            json!({"mode":"silent"}),
            json!({"mode":"wait","wait_secs":u64::MAX}),
        ] {
            let control = response(vec![call("n", "no_reply", args)]);
            assert_eq!(
                serde_json::to_value(
                    normalize_response(&control, &ctx)
                        .unwrap()
                        .execution_response
                )
                .unwrap(),
                serde_json::to_value(control).unwrap()
            );
        }
        ctx.typed_infer = true;
        let raw = Response {
            content: "{\"business\":true}".into(),
            tool_calls: vec![],
        };
        let typed = normalize_response(&raw, &ctx).unwrap();
        assert_eq!(typed.protocol, Protocol::Off);
        assert_eq!(
            serde_json::to_value(typed.execution_response).unwrap(),
            serde_json::to_value(raw).unwrap()
        );
    }

    #[test]
    fn v2_persisted_records_keep_actual_protocol_and_reject_source_mismatch() {
        let mut event = persisted_event(12, json!({"title":"完整工作","progress":"阶段"}), false);
        event
            .payload
            .insert("response_annotations".into(), json!("v2"));
        let value = event.payload.get_mut(BUNDLE_PAYLOAD_KEY).unwrap();
        value["protocol"] = json!("v2");
        for record in value["records"].as_array_mut().unwrap() {
            record["protocol"] = json!("v2");
        }
        let scope = context().scope.unwrap();
        let bundle = annotations_from_authorized_event(&event, &scope)
            .unwrap()
            .unwrap();
        assert_eq!(bundle.protocol, Protocol::V2);
        assert!(bundle
            .records
            .iter()
            .all(|record| record.protocol == Protocol::V2));
        event
            .payload
            .insert("response_annotations".into(), json!("v1"));
        assert!(annotations_from_authorized_event(&event, &scope).is_err());
        event.payload.remove("response_annotations");
        assert!(annotations_from_authorized_event(&event, &scope).is_err());
    }

    #[test]
    fn reply_same_response_terminal_mapping_and_control_failures() {
        let raw = response(vec![call(
            "r",
            "reply",
            json!({"content":"检查完成。","annotations":{"execution":{"result":"已确认"}}}),
        )]);
        let normalized = normalize_response(&raw, &context()).unwrap();
        assert!(normalized.execution_response.tool_calls.is_empty());
        assert_eq!(
            normalized.terminal_decision,
            Some(TerminalDecision::Deliver("检查完成。".into()))
        );
        assert!(!normalized.records[0].effective);
        let mut completed = context();
        completed.execution_fact = Some(ExecutionFact {
            scope: completed.scope.clone().unwrap(),
            status: "completed".into(),
            terminal: true,
            terminal_sequence: Some(9),
        });
        assert!(normalize_response(&raw, &completed).unwrap().records[0].effective);
        let bad_metadata = normalize_response(
            &response(vec![call(
                "r",
                "reply",
                json!({"content":"正文","annotations":null}),
            )]),
            &context(),
        )
        .unwrap();
        assert!(bad_metadata.records.is_empty());
        assert_eq!(bad_metadata.execution_response.content, "正文");
        assert!(normalize_response(
            &response(vec![
                call("r", "reply", json!({"content":"x"})),
                call("w", "exec", json!({"command":"x"}))
            ]),
            &context()
        )
        .is_err());
        assert!(normalize_response(
            &response(vec![call(
                "r",
                "reply",
                json!({"content":"", "status":"success"})
            )]),
            &context()
        )
        .is_err());
    }
    #[test]
    fn no_reply_bound_mode_and_u64_range_unchanged_no_annotations() {
        let default = normalize_response(
            &response(vec![call("n", "no_reply", json!({"mode":"wait"}))]),
            &context(),
        )
        .unwrap();
        assert_eq!(
            default.terminal_decision,
            Some(TerminalDecision::NoReply(NoReplyMode::Wait {
                wait_secs: 60,
                explicitly_requested: false
            }))
        );
        let explicit = normalize_response(
            &response(vec![call(
                "n",
                "no_reply",
                json!({"mode":"wait","wait_secs":u64::MAX}),
            )]),
            &context(),
        )
        .unwrap();
        assert_eq!(
            explicit.terminal_decision,
            Some(TerminalDecision::NoReply(NoReplyMode::Wait {
                wait_secs: u64::MAX,
                explicitly_requested: true
            }))
        );
        assert!(normalize_response(
            &response(vec![call(
                "n",
                "no_reply",
                json!({"mode":"silent","_annotations":{}})
            )]),
            &context()
        )
        .is_err());
        assert!(normalize_response(
            &response(vec![call(
                "n",
                "no_reply",
                json!({"mode":"wait","wait_secs":0})
            )]),
            &context()
        )
        .is_err());
    }
    #[test]
    fn reply_duplicate_control_fields_are_rejected_but_null_metadata_downgrades() {
        for args in [
            r#"{"content":"one","content":"two"}"#,
            r#"{"content":"正文","annotations":{},"annotations":{}}"#,
        ] {
            let raw = response(vec![ToolCallRepr {
                id: "r".into(),
                r#type: "function".into(),
                func_name: "reply".into(),
                arguments: args.into(),
            }]);
            assert!(normalize_response(&raw, &context()).is_err());
        }
        let raw = response(vec![call(
            "r",
            "reply",
            json!({"content":"正文","annotations":null}),
        )]);
        let normalized = normalize_response(&raw, &context()).unwrap();
        assert_eq!(normalized.execution_response.content, "正文");
        assert_eq!(normalized.diagnostics.len(), 1);
    }
    #[test]
    fn other_execution_fact_cannot_mark_result_effective_or_cancel_current_execution() {
        let mut ctx = context();
        ctx.execution_fact = Some(ExecutionFact {
            scope: ExecutionScope {
                execution_id: "other-execution".into(),
                generation: 3,
            },
            status: "cancelled".into(),
            terminal: true,
            terminal_sequence: Some(9),
        });
        let raw = response(vec![call(
            "r",
            "reply",
            json!({"content":"正文","annotations":{"execution":{"result":"结果"}}}),
        )]);
        let normalized = normalize_response(&raw, &ctx).unwrap();
        assert!(normalized.dispatch_allowed);
        assert!(!normalized.records[0].effective);
        ctx.execution_fact.as_mut().unwrap().status = "completed".into();
        assert!(!normalize_response(&raw, &ctx).unwrap().records[0].effective);
    }
    #[test]
    fn replay_idempotent_and_conflicting_rebind_rejected() {
        let raw = response(vec![call(
            "1",
            "exec",
            json!({"command":"x","_annotations":{"observations":[{"ref":"@e123","result":"Linux"}]}}),
        )]);
        let first = normalize_response(&raw, &context()).unwrap();
        let repeated = normalize_response(&raw, &context()).unwrap();
        let (merged, conflicts) = merge_records(&first.records, &repeated.records);
        assert_eq!(merged.len(), 1);
        assert!(conflicts.is_empty());
        let mut changed = repeated.records;
        changed[0].observation_event_id = Some("forged".into());
        assert_eq!(merge_records(&first.records, &changed).1.len(), 1);
    }
    #[test]
    fn projection_trusted_sequence_effective_result_cancel_and_late_facts() {
        let mut ctx = context();
        ctx.execution_fact = Some(ExecutionFact {
            scope: ctx.scope.clone().unwrap(),
            status: "completed".into(),
            terminal: true,
            terminal_sequence: Some(30),
        });
        let raw = response(vec![call(
            "r",
            "reply",
            json!({"content":"正文","annotations":{"execution":{"title":"标题","progress":"进展","result":"结果"}}}),
        )]);
        let mut records = normalize_response(&raw, &ctx).unwrap().records;
        let fact = ctx.execution_fact.clone().unwrap();
        let completed = project_execution(&fact, &records);
        assert_eq!(completed.result.as_deref(), Some("结果"));
        assert!(completed.progress.is_none());
        let mut late = records.clone();
        for r in &mut late {
            r.source.sequence = Some(40);
            r.value = "迟到".into();
        }
        records.extend(late);
        assert_eq!(
            project_execution(&fact, &records).result.as_deref(),
            Some("结果")
        );
        for r in &mut records {
            r.effective = false;
        }
        assert!(project_execution(&fact, &records).result.is_none());
        let cancelled = ExecutionFact {
            status: "cancelled".into(),
            ..fact
        };
        assert!(project_execution(&cancelled, &records).result.is_none());
        let mut cancel_context = context();
        cancel_context.execution_fact = Some(cancelled);
        assert!(
            !normalize_response(&raw, &cancel_context)
                .unwrap()
                .dispatch_allowed
        );
    }
    #[test]
    fn v1_first_valid_title_survives_reordering_later_steps_terminal_and_replay() {
        let produce = |sequence, execution: Value, terminal| {
            let mut ctx = context();
            ctx.producer = Some(Producer {
                event_id: format!("event-{sequence}"),
                attempt_id: format!("attempt-{sequence}"),
                sequence: Some(sequence),
            });
            if terminal {
                ctx.execution_fact = Some(ExecutionFact {
                    scope: ctx.scope.clone().unwrap(),
                    status: "completed".into(),
                    terminal: true,
                    terminal_sequence: Some(30),
                });
            }
            let (name, args) = if terminal {
                (
                    "reply",
                    json!({"content":"正文","annotations":{"execution":execution}}),
                )
            } else {
                (
                    "exec",
                    json!({"command":"safe","_annotations":{"execution":execution}}),
                )
            };
            normalize_response(
                &response(vec![call(&format!("call-{sequence}"), name, args)]),
                &ctx,
            )
            .unwrap()
            .records
        };
        let invalid = produce(5, json!({"title":"","progress":"准备"}), false);
        let first = produce(
            10,
            json!({"title":"核对运行环境","progress":"核对操作系统"}),
            false,
        );
        let later = produce(
            20,
            json!({"title":"核对处理器架构","progress":"核对处理器架构"}),
            false,
        );
        let final_records = produce(30, json!({"title":"结束步骤","result":"已核对环境"}), true);
        let late = produce(40, json!({"title":"迟到步骤","result":"迟到结果"}), true);
        let running = ExecutionFact {
            scope: context().scope.unwrap(),
            status: "running".into(),
            terminal: false,
            terminal_sequence: None,
        };
        let mut records: Vec<_> = later
            .iter()
            .chain(&first)
            .chain(&invalid)
            .cloned()
            .collect();
        for _ in 0..2 {
            let projected = project_execution(&running, &records);
            assert_eq!(projected.title.as_deref(), Some("核对运行环境"));
            assert_eq!(projected.progress.as_deref(), Some("核对处理器架构"));
            records.reverse();
        }
        records.extend(final_records);
        let replay: Vec<_> = first.iter().chain(&later).cloned().collect();
        let (mut stored, conflicts) = merge_records(&records, &replay);
        assert!(conflicts.is_empty());
        assert_eq!(
            stored
                .iter()
                .filter(|r| r.kind == AnnotationKind::Title)
                .count(),
            3
        );
        stored.extend(late);
        let mut unsequenced = produce(1, json!({"title":"没有可信顺序"}), false);
        unsequenced[0].source.sequence = None;
        stored.extend(unsequenced);
        assert_eq!(
            stored
                .iter()
                .filter(|r| r.kind == AnnotationKind::Title)
                .count(),
            5
        );
        let completed = ExecutionFact {
            status: "completed".into(),
            terminal: true,
            terminal_sequence: Some(30),
            ..running
        };
        for _ in 0..2 {
            let projected = project_execution(&completed, &stored);
            assert_eq!(projected.title.as_deref(), Some("核对运行环境"));
            assert_eq!(projected.result.as_deref(), Some("已核对环境"));
            assert!(projected.progress.is_none());
            stored.reverse();
        }
    }
}
