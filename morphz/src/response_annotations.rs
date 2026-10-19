//! Opt-in, display-only metadata produced alongside existing model responses.
//! Execution scope, authorization and status remain Runtime-owned facts. This
//! module never dispatches work, requests an inference or reads a database.
use crate::event::{Event, TYPE_AGENT_CALL};
use crate::llm::{Response, ToolCallRepr};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fmt;

pub mod diagnostics;

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
        == Some(true);
    let work_calls = persisted_work_calls(&bundle, event);
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
                if work_calls.iter().filter(|call| call.id == id).count() != 1 {
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

/// Current native Evaluation proposals are Runtime-derived calls. The raw
/// provider tool list is intentionally empty and is not their identity source.
/// Old immutable records still describe their actual original native calls;
/// this read projection never executes or replays them.
fn persisted_work_calls(bundle: &PersistedAnnotations, event: &Event) -> Vec<ToolCallRepr> {
    if let Some(binding) = bundle
        .return_binding
        .as_ref()
        .filter(|binding| binding.output.is_some())
    {
        return crate::session_io::evaluation::decode(
            &bundle.raw_response,
            binding,
            event
                .payload
                .get("model_attempt_id")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
        .map(|evaluation| evaluation.response.tool_calls)
        .unwrap_or_default();
    }
    bundle.raw_response.tool_calls.clone()
}

/// One opt-in metadata contract for every Evaluation, including child infers.
/// Disabled means no metadata protocol, not a historical response variant.
pub const CONTRACT: &str = crate::session_io::response::CONTRACT;

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    #[default]
    Off,
    On,
}
impl Protocol {
    pub const fn is_off(&self) -> bool {
        matches!(self, Self::Off)
    }
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::On => "on",
        }
    }
    #[expect(
        clippy::should_implement_trait,
        reason = "Preserve the existing public canonical-token parser alongside its FromStr implementation"
    )]
    pub fn from_str(value: &str) -> Result<Self, ProtocolError> {
        match value {
            "off" => Ok(Self::Off),
            "on" => Ok(Self::On),
            _ => Err(error("Unknown response annotations protocol")),
        }
    }
    pub const fn contract(&self) -> Option<&'static str> {
        match self {
            Self::Off => None,
            Self::On => Some(CONTRACT),
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
    // Session IO deliberately supports a structural JSON-Schema subset.
    // Unicode/reference/collection limits remain enforced by Extraction and
    // the frozen IO budget, not silently dropped schema keywords.
    json!({"type":"object", "additionalProperties":false, "properties":{
        "execution":{"type":"object", "additionalProperties":false, "properties":{
            "title":{"type":"string"}, "progress":{"type":"string"}, "result":{"type":"string"}
        }},
        "intent":{"type":"string"},
        "calls":{"type":"array", "items":{
            "type":"object", "additionalProperties":false, "required":["index","intent"],
            "properties":{"index":{"type":"integer"},"intent":{"type":"string"}}
        }},
        "observations":{"type":"array", "items":{
            "type":"object", "additionalProperties":false, "required":["ref","result"],
            "properties":{"ref":{"type":"string"},"result":{"type":"string"}}
        }}
    }})
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
    pub return_binding: Option<crate::session_io::response::ReturnBinding>,
    /// Must be the mode frozen for this execution, not mutable global config.
    pub protocol: Protocol,
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
    pub return_binding: Option<crate::session_io::response::ReturnBinding>,
    pub annotation_messages: Vec<crate::session_io::Message>,
    pub raw_response: Response,
    pub execution_response: Response,
    /// Protocol applied to this response, not the authoritative frozen execution
    /// mode, shared by typed inference and ordinary response normalization.
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub return_binding: Option<crate::session_io::response::ReturnBinding>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub annotation_messages: Vec<crate::session_io::Message>,
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
            return_binding: normalized.return_binding.clone(),
            annotation_messages: normalized.annotation_messages.clone(),
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
        && event
            .payload
            .get("response_annotations")
            .and_then(Value::as_str)
            != Some("on")
    {
        return Ok(None);
    }
    if bundle.protocol.is_off()
        || !event.payload.contains_key("response_annotations")
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
        || bundle.records.len()
            > bundle
                .return_binding
                .as_ref()
                .filter(|binding| binding.output.is_some())
                .and_then(|binding| {
                    crate::session_io::evaluation::decode(
                        &bundle.raw_response,
                        binding,
                        event
                            .payload
                            .get("model_attempt_id")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                    )
                    .ok()
                })
                .map(|output| output.response.tool_calls.len())
                .unwrap_or(bundle.raw_response.tool_calls.len())
                .saturating_add(19)
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
    // Absence never invents a callable route from a model attempt/name. Runtime
    // requests always supply the actual binding; read-only extraction without
    // a route may still inspect metadata but cannot recognize an explicit return.
    let binding = context.return_binding.clone().unwrap_or_else(|| {
        crate::session_io::response::ReturnBinding {
            delivery_id: String::new(),
            format: crate::session_io::OutputFormat::chat(),
            annotations_enabled: !context.protocol.is_off(),
            annotation_observation_refs: vec![],
            output: (!context.protocol.is_off()).then(crate::session_io::evaluation::binding),
        }
    });
    let parts = crate::session_io::response::split_response_for_attempt(
        response,
        &binding,
        context
            .producer
            .as_ref()
            .map(|producer| producer.attempt_id.as_str())
            .unwrap_or(&binding.delivery_id),
    )
    .map_err(|cause| error(&cause.to_string()))?;
    normalize_parts(response, context, parts)
}

/// Metadata extraction is deliberately independent from the model transport
/// decoder. Inputs here are Runtime-built parts of an admitted IO value.
fn normalize_parts(
    response: &Response,
    context: &NormalizationContext,
    parts: crate::session_io::response::ResponseParts,
) -> Result<NormalizedResponse, ProtocolError> {
    let execution_response = parts.response;
    let terminal_decision = terminal(&execution_response)?;
    let mut extraction = Extraction::new(context);
    for diagnostic in &parts.diagnostics {
        extraction.note("session_io.annotations", diagnostic);
    }
    if !context.protocol.is_off() {
        for delivery in &parts.annotation_messages {
            if let Some(annotations) =
                crate::session_io::response::annotations_value(&delivery.message)
            {
                let mut global = annotations.clone();
                let calls = global
                    .as_object_mut()
                    .and_then(|object| object.remove("calls"));
                extraction.extract(
                    &global,
                    "session_io.annotations",
                    None,
                    matches!(terminal_decision, Some(TerminalDecision::Deliver(_))),
                );
                if let Some(calls) = calls.and_then(|calls| calls.as_array().cloned()) {
                    for (ordinal, reference) in calls.iter().take(16).enumerate() {
                        let path = format!("session_io.annotations.calls[{ordinal}]");
                        let target = reference
                            .get("index")
                            .and_then(Value::as_u64)
                            .and_then(|index| execution_response.tool_calls.get(index as usize))
                            .filter(|target| {
                                target.func_name != "deliver_message"
                                    && target.func_name != "no_reply"
                            });
                        if let Some(target) = target {
                            extraction.extract(
                                &json!({"intent":reference.get("intent")}),
                                &path,
                                Some(&target.id),
                                false,
                            );
                        } else {
                            extraction.note(
                                &path,
                                "Intent target is not an actual work call in this response",
                            );
                        }
                    }
                }
            }
        }
        if matches!(terminal_decision, Some(TerminalDecision::Deliver(_))) {
            for (kind, field) in [
                (AnnotationKind::Title, "execution.title"),
                (AnnotationKind::Result, "execution.result"),
            ] {
                if !extraction.records.iter().any(|record| record.kind == kind) {
                    extraction.note(field, "Display metadata missing or invalid; original body preserved; no repair request sent");
                }
            }
        }
        for (index, call) in execution_response
            .tool_calls
            .iter()
            .enumerate()
            .filter(|(_, call)| call.func_name != "deliver_message" && call.func_name != "no_reply")
        {
            if !extraction.records.iter().any(|record| {
                record.kind == AnnotationKind::Intent && record.call_id.as_deref() == Some(&call.id)
            }) {
                extraction.note(&format!("calls[{index}].intent"), "Required work-call annotation missing or invalid; original work preserved; no repair request sent");
            }
        }
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
        title_input_revision: if context.protocol.is_off() {
            None
        } else {
            extraction.title_input_revision
        },
        return_binding: context.return_binding.clone(),
        annotation_messages: parts
            .annotation_messages
            .into_iter()
            .map(|delivery| delivery.message)
            .collect(),
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
    use crate::llm::ToolDefinition;
    // Negative test data only; production contains no delimiter parser.
    const REPLY_TRAILER: &str = "\n:::morphz-reply\n";
    use crate::session_io::response::ANNOTATIONS_FORMAT;
    // These are metadata-extraction unit tests, after transport admission.
    // Test literals keep logical work and metadata separate for readability;
    // they are not a model wire format or a retired Runtime execution path.
    // The actual model decoder is covered in session_io::evaluation/response
    // and by real Runtime integration tests.
    fn normalize_fixture_parts(
        raw: &Response,
        context: &NormalizationContext,
    ) -> Result<NormalizedResponse, ProtocolError> {
        use crate::session_io::response::{Delivery, ResponseParts};
        let mut logical = raw.clone();
        let mut annotations = Vec::<Delivery>::new();
        let mut work = Vec::new();
        let mut diagnostics = vec![];
        for call in &raw.tool_calls {
            if call.func_name == "deliver_message" {
                let value = crate::session_io::response::parse_delivery(
                    &call.arguments,
                    &crate::session_io::Limits::default(),
                )
                .map_err(|cause| error(&cause.to_string()))?;
                if value.message.format.id == ANNOTATIONS_FORMAT {
                    let limits = crate::session_io::Limits::default();
                    let binding = crate::session_io::Registry::default()
                        .resolve(&value.message.format, "json", "registered")
                        .unwrap();
                    if crate::session_io::validate_content(&value.message, &binding, &limits)
                        .is_ok()
                    {
                        annotations.push(value);
                    } else {
                        diagnostics.push("Malformed fixture metadata ignored".into());
                    }
                    continue;
                }
            }
            work.push(call.clone());
        }
        logical.tool_calls = work;
        if annotations.len() > 1 {
            annotations.clear();
            diagnostics.push("Ambiguous fixture metadata ignored".into());
        }
        super::normalize_parts(
            raw,
            context,
            ResponseParts {
                response: logical,
                body_message: None,
                annotation_messages: annotations,
                diagnostics,
            },
        )
    }
    // Test-only logical metadata fixture; never sent to the Runtime decoder.
    fn metadata_call(id: &str, metadata: Value) -> ToolCallRepr {
        ToolCallRepr { id:id.into(), r#type:"function".into(), func_name:"deliver_message".into(),
            arguments:json!({"delivery_id":format!("metadata-{id}"),"message":{"format":{"id":ANNOTATIONS_FORMAT,"version":"1"},"content":{"encoding":"json","value":metadata}}}).to_string() }
    }
    fn call(id: &str, name: &str, args: Value) -> ToolCallRepr {
        if name == ANNOTATIONS_FORMAT {
            return metadata_call(id, args.get("annotations").cloned().unwrap_or(Value::Null));
        }
        ToolCallRepr {
            id: id.into(),
            r#type: "function".into(),
            func_name: name.into(),
            arguments: args.to_string(),
        }
    }
    fn response(calls: Vec<ToolCallRepr>) -> Response {
        let terminal = calls.iter().any(|call| call.func_name == "deliver_message");
        let mut output = Vec::new();
        let mut metadata = serde_json::Map::new();
        let mut intents = Vec::new();
        let mut observations = Vec::new();
        for mut call in calls {
            if call.func_name != "deliver_message" && call.func_name != "no_reply" {
                let mut args: Value = serde_json::from_str(&call.arguments).unwrap();
                if let Some(annotations) = args
                    .as_object_mut()
                    .and_then(|args| args.remove("_annotations"))
                {
                    if let Some(execution) = annotations.get("execution") {
                        metadata
                            .entry("execution")
                            .or_insert_with(|| execution.clone());
                    }
                    if let Some(intent) = annotations.get("intent") {
                        intents.push(json!({"index":output.len(),"intent":intent}));
                    }
                    if let Some(items) = annotations.get("observations").and_then(Value::as_array) {
                        observations.extend(items.iter().cloned());
                    }
                    for (key, value) in annotations.as_object().into_iter().flatten() {
                        if !["execution", "intent", "observations"].contains(&key.as_str()) {
                            metadata.insert(key.clone(), value.clone());
                        }
                    }
                    call.arguments = args.to_string();
                }
            }
            output.push(call);
        }
        if !intents.is_empty() {
            metadata.insert("calls".into(), json!(intents));
        }
        if !observations.is_empty() {
            metadata.insert("observations".into(), json!(observations));
        }
        if !metadata.is_empty() {
            output.push(metadata_call("fixture-companion", json!(metadata)));
        }
        Response {
            content: if terminal {
                "正文".into()
            } else {
                String::new()
            },
            tool_calls: output,
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
            protocol: Protocol::On,
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

    #[test]
    fn every_work_call_requires_same_response_intent_without_blocking_or_repair() {
        let raw = Response {
            content: String::new(),
            tool_calls: vec![
                call("read-book", "host_morphz", json!({"action":"reader"})),
                call("recall-text", "recall", json!({"event_id":"@e123"})),
                metadata_call(
                    "step-metadata",
                    json!({"calls":[{"index":0,"intent":"读取当前原文以核对解释"}]}),
                ),
            ],
        };
        let normalized = normalize_fixture_parts(&raw, &context()).unwrap();
        assert!(normalized.dispatch_allowed);
        assert_eq!(normalized.execution_response.tool_calls.len(), 2);
        assert_eq!(
            normalized
                .records
                .iter()
                .filter(|r| r.kind == AnnotationKind::Intent)
                .count(),
            1
        );
        assert_eq!(normalized.diagnostics.len(), 1);
        assert!(format!("{:?}", normalized.diagnostics).contains("calls[1].intent"));
        assert_eq!(
            serde_json::to_value(&normalized.raw_response).unwrap(),
            serde_json::to_value(&raw).unwrap()
        );
        let mut complete = raw.clone();
        complete.tool_calls[2] = metadata_call(
            "step-metadata",
            json!({"calls":[
                {"index":0,"intent":"读取当前原文以核对解释"},
                {"index":1,"intent":"展开已取得的原文，避免凭记忆作答"}
            ]}),
        );
        assert!(normalize_fixture_parts(&complete, &context())
            .unwrap()
            .diagnostics
            .is_empty());
        let mut off = context();
        off.protocol = Protocol::Off;
        assert!(normalize_fixture_parts(
            &Response {
                content: String::new(),
                tool_calls: raw.tool_calls[..2].to_vec()
            },
            &off
        )
        .unwrap()
        .diagnostics
        .is_empty());
        assert!(crate::session_io::response::CONTRACT
            .contains("Each actual work/control proposal requires a nonempty intent"));
        assert!(crate::session_io::response::CONTRACT.contains("With effects=[]"));
    }
    fn persisted_event(sequence: u64, execution: Value, terminal: bool) -> Event {
        persisted_event_with_revision(sequence, execution, terminal, None)
    }
    fn persisted_event_with_revision(
        sequence: u64,
        mut execution: Value,
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
            let fields = execution.as_object_mut().expect("synthetic final metadata");
            fields.entry("title").or_insert(json!("完成合成核对"));
            fields.entry("result").or_insert(json!("合成核对已结束"));
            (
                ANNOTATIONS_FORMAT,
                json!({"annotations":{"execution":execution}}),
            )
        } else {
            (
                "exec",
                json!({"command":"safe","_annotations":{"execution":execution}}),
            )
        };
        let normalized =
            normalize_fixture_parts(&response(vec![call("call", name, args)]), &ctx).unwrap();
        let bundle = PersistedAnnotations::from_normalized(ctx.scope.clone().unwrap(), &normalized);
        let mut event = Event::new(
            format!("event-{sequence}"), "Agent-Morphz".into(), TYPE_AGENT_CALL.into(),
            "chat/assistant_call".into(),
            json!({"response_annotations":"on","thread_id":"execution-1","thread_generation":3,"model_attempt_id":format!("model-{sequence}"),BUNDLE_PAYLOAD_KEY:bundle}).as_object().unwrap().clone(),
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
            Protocol::On,
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
            Protocol::On,
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
                Protocol::On,
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
        let normalized = normalize_fixture_parts(&raw, &ctx).unwrap();
        let mut event = Event::new("response-event".into(), "Agent-Morphz".into(), TYPE_AGENT_CALL.into(), "chat/assistant_call".into(), json!({"response_annotations":"on", "thread_id":"execution-1", "thread_generation":3, "model_attempt_id":"attempt", BUNDLE_PAYLOAD_KEY:PersistedAnnotations::from_normalized(ctx.scope.clone().unwrap(), &normalized)}).as_object().unwrap().clone());
        event.sequence = Some(9);
        let receipt = receipt_from_authorized_event(
            &event,
            ctx.scope.as_ref().unwrap(),
            Protocol::On,
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
            Protocol::On,
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
            Protocol::On,
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
            receipt_from_authorized_event(&event, &scope, Protocol::On, "activation", "model-10")
                .unwrap();
        assert_eq!(receipt.state, ReceiptState::NoneAccepted);
        assert!(receipt.accepted.is_empty());
        assert_eq!(receipt.diagnostic_count, Some(2));
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
            Protocol::On,
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
            Protocol::On,
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
        let normalized = normalize_fixture_parts(&raw, &context()).unwrap();
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
        let normalized = normalize_fixture_parts(&raw, &off).unwrap();
        assert!(normalized.title_input_revision.is_none());
        assert_eq!(
            serde_json::to_vec(&normalized.execution_response).unwrap(),
            serde_json::to_vec(&Response {
                content: raw.content.clone(),
                tool_calls: vec![raw.tool_calls[0].clone()]
            })
            .unwrap()
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
            let normalized = normalize_fixture_parts(&raw, &ctx).unwrap();
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
            assert_eq!(bundle.raw_response.tool_calls.len(), 2);
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
    fn only_on_off_are_supported_without_version_aliases_or_auto_mode() {
        assert_eq!(Protocol::default(), Protocol::Off);
        assert!(Protocol::Off.is_off());
        assert!(!Protocol::On.is_off());
        for protocol in [Protocol::Off, Protocol::On] {
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
        for removed in ["v1", "v2", "auto", "v3"] {
            assert!(Protocol::from_str(removed).is_err());
            assert!(serde_json::from_value::<Protocol>(json!(removed)).is_err());
        }
        assert_eq!(Protocol::Off.contract(), None);
        assert_eq!(Protocol::On.contract(), Some(CONTRACT));
        assert!(serde_json::from_value::<Protocol>(json!(true)).is_err());
        assert!(CONTRACT.contains("title describes this entire Execution"));
        assert!(CONTRACT.contains("Never request another model call solely"));
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
        assert!(bundle
            .raw_response
            .tool_calls
            .iter()
            .any(|call| call.func_name == "deliver_message"));
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
        assert!(records
            .iter()
            .filter(|r| r.kind == AnnotationKind::Result)
            .all(|r| !r.effective));
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
    fn ordinary_business_fields_and_schemas_are_unchanged_in_both_modes() {
        let raw = Response {
            content: String::new(),
            tool_calls: vec![ToolCallRepr {
                id: "business".into(),
                r#type: "function".into(),
                func_name: "exec".into(),
                arguments: r#"{ "command":"original", "_annotations":{"business":true} }"#.into(),
            }],
        };
        for protocol in [Protocol::Off, Protocol::On] {
            let mut ctx = context();
            ctx.protocol = protocol;
            let normalized = normalize_fixture_parts(&raw, &ctx).unwrap();
            assert_eq!(
                serde_json::to_value(&normalized.execution_response).unwrap(),
                serde_json::to_value(&raw).unwrap()
            );
            assert!(normalized.records.is_empty());
            assert!(normalized.terminal_decision.is_none());
        }
    }
    #[test]
    fn annotation_schema_is_a_registered_format_not_a_tool_mutation() {
        let descriptor = crate::session_io::response::annotations_descriptor();
        assert_eq!(descriptor.id, ANNOTATIONS_FORMAT);
        assert_eq!(descriptor.encodings, vec!["json"]);
        let schema = descriptor.schema.unwrap();
        assert!(schema["properties"].get("execution").is_some());
        assert!(schema["properties"].get("content").is_none());
        assert!(tool().parameters["properties"]
            .get("_annotations")
            .is_none());
    }
    #[test]
    fn work_args_raw_and_nested_business_fields_preserved_precise_refs_only() {
        let args = json!({"command":"printf '中文\\n' \"$UNCHANGED\"", "payload":{"_annotations":{"business":true}},"_annotations":{
            "execution":{"title":"检查环境","result":"不能提前完成"},"intent":"确认架构","observations":[
                {"ref":"@e123","result":"Linux"},{"ref":"@future","result":"future"},{"ref":"@other","result":"other"},{"ref":"@old","result":"old"}]}});
        let raw = response(vec![call("provider-id", "exec", args.clone())]);
        let normalized = normalize_fixture_parts(&raw, &context()).unwrap();
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
        let normalized = normalize_fixture_parts(&raw, &context()).unwrap();
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
        let normalized = normalize_fixture_parts(&raw, &context()).unwrap();
        assert!(normalized.records.is_empty());
        assert!(!normalized.diagnostics.is_empty());
        assert_eq!(normalized.execution_response.tool_calls.len(), 1);
        let mut unknown = serde_json::Map::new();
        for i in 0..100 {
            unknown.insert(format!("unknown-{i}"), Value::Null);
        }
        let excessive = normalize_fixture_parts(
            &response(vec![call(
                "2",
                "exec",
                json!({"command":"x","_annotations":unknown}),
            )]),
            &context(),
        )
        .unwrap();
        assert!(!excessive.diagnostics.is_empty());
        assert!(excessive.records.is_empty());
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
        let normalized = normalize_fixture_parts(&raw, &context()).unwrap();
        assert!(!normalized.diagnostics.is_empty());
        assert!(normalized.records.is_empty());
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
    fn semantic_diagnostics_keep_the_count_and_unicode_path_bounds() {
        let ctx = context();
        let mut extraction = Extraction::new(&ctx);
        for _ in 0..100 {
            extraction.note(&"🧠".repeat(1000), "synthetic rejection");
        }
        assert_eq!(extraction.diagnostics.len(), 64);
        assert_eq!(extraction.omitted_diagnostics, 36);
        assert!(extraction
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.path.chars().count() <= 256));
        assert!(extraction.records.is_empty());
    }
    #[test]
    fn missing_or_invalid_display_metadata_never_invalidates_the_original_body() {
        let mut ctx = context();
        ctx.protocol = Protocol::On;
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
            let mut args = json!({});
            if let Some(annotations) = annotations {
                args["annotations"] = annotations;
            }
            let raw = response(vec![call("r", ANNOTATIONS_FORMAT, args.clone())]);
            let normalized = normalize_fixture_parts(&raw, &ctx).unwrap();
            assert_eq!(normalized.execution_response.content, "正文");
            assert!(normalized.execution_response.tool_calls.is_empty());
            assert!(!normalized.diagnostics.is_empty());
            let implicit = Response {
                content: args.to_string(),
                tool_calls: vec![],
            };
            assert_eq!(
                normalize_fixture_parts(&implicit, &ctx)
                    .unwrap()
                    .execution_response
                    .content,
                args.to_string()
            );
        }
        let plain = Response {
            content: "正文".into(),
            tool_calls: vec![],
        };
        assert_eq!(
            normalize_fixture_parts(&plain, &ctx)
                .unwrap()
                .execution_response
                .content,
            "正文"
        );
        assert!(normalize_fixture_parts(&plain, &NormalizationContext::default()).is_ok());
        let valid = response(vec![call(
            "r",
            ANNOTATIONS_FORMAT,
            json!({"annotations":{"execution":{"title":"整项工作","result":"完成"},
            "observations":[{"ref":"@other","result":"越界"}]}}),
        )]);
        let normalized = normalize_fixture_parts(&valid, &ctx).unwrap();
        assert_eq!(normalized.protocol, Protocol::On);
        assert!(normalized
            .records
            .iter()
            .all(|record| record.protocol == Protocol::On));
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
            let normalized = normalize_fixture_parts(&valid, &unbound).unwrap();
            assert!(
                normalized.records.is_empty(),
                "unbound metadata is never trusted"
            );
            assert!(!normalized.diagnostics.is_empty());
            assert_eq!(normalized.execution_response.content, "正文");
        }
    }

    #[test]
    fn metadata_contract_uses_one_schema_bound_evaluation_value() {
        assert!(CONTRACT.contains("ONE native JSON object"));
        assert!(CONTRACT.contains("body, annotations, effects"));
        assert!(!CONTRACT.contains(":::"));
        let schema = annotation_schema();
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(
            schema["properties"]["execution"]["additionalProperties"],
            false
        );
        assert_eq!(
            schema["properties"]["execution"]["properties"]["title"]["type"],
            "string"
        );
        assert_eq!(
            schema["properties"]["execution"]["properties"]["result"]["type"],
            "string"
        );
    }

    #[test]
    fn native_metadata_is_separate_from_the_implicit_return_value() {
        let metadata = json!({"execution":{"title":"读取合成系统","result":"合成结果"}});
        let raw = Response {
            content: "\"Linux\"".into(),
            tool_calls: vec![call(
                "r",
                ANNOTATIONS_FORMAT,
                json!({"annotations":metadata}),
            )],
        };
        let normalized = normalize_fixture_parts(&raw, &context()).unwrap();
        assert_eq!(
            serde_json::to_value(&normalized.raw_response).unwrap(),
            serde_json::to_value(&raw).unwrap()
        );
        assert_eq!(normalized.execution_response.content, "\"Linux\"");
        assert_eq!(normalized.records.len(), 2);
        assert!(normalized.diagnostics.is_empty());
        assert!(normalized
            .records
            .iter()
            .all(|record| record.scope == context().scope.unwrap()));
        let plain = Response {
            content: raw.content.clone(),
            tool_calls: vec![],
        };
        let plain = normalize_fixture_parts(&plain, &context()).unwrap();
        assert_eq!(
            plain.execution_response.content,
            normalized.execution_response.content
        );
        assert!(plain.records.is_empty());
        assert!(!plain.diagnostics.is_empty());
        let off = normalize_fixture_parts(&raw, &NormalizationContext::default()).unwrap();
        assert_eq!(off.execution_response.content, raw.content);
        assert!(off.execution_response.tool_calls.is_empty());
        assert!(off.records.is_empty());
    }

    #[test]
    fn retired_text_protocol_is_literal_body_and_never_a_control_carrier() {
        for trailer in [
            r#"{"annotations":{"execution":{"title":"标题","result":"结果"}}}
:::"#,
            "{bad\n:::",
            r#"{"annotations":null}"#,
        ] {
            let raw = Response {
                content: format!("正文{REPLY_TRAILER}{trailer}"),
                tool_calls: vec![],
            };
            let normalized = normalize_fixture_parts(&raw, &context()).unwrap();
            assert_eq!(normalized.execution_response.content, raw.content);
            assert!(normalized.records.is_empty());
            assert!(!normalized.diagnostics.is_empty());
        }
    }
    #[test]
    fn body_layout_does_not_drop_or_fabricate_required_annotations() {
        let body = "合成第一段。\n\n合成第二段。\t原始缩进。";
        let metadata = json!({"execution":{"title":"解释合成文字","result":"已解释两段"}});
        let raw = Response {
            content: body.into(),
            tool_calls: vec![call(
                "r",
                ANNOTATIONS_FORMAT,
                json!({"annotations":metadata}),
            )],
        };
        let normalized = normalize_fixture_parts(&raw, &context()).unwrap();
        assert_eq!(normalized.execution_response.content, body);
        assert_eq!(normalized.raw_response.content, raw.content);
        assert_eq!(normalized.records.len(), 2);
        assert!(normalized.diagnostics.is_empty());
        let missing = Response {
            content: body.into(),
            tool_calls: vec![],
        };
        let missing = normalize_fixture_parts(&missing, &context()).unwrap();
        assert_eq!(missing.execution_response.content, body);
        assert!(missing.records.is_empty());
        assert!(!missing.diagnostics.is_empty());
    }

    #[test]
    fn schema_bound_session_io_value_replays_without_model_or_side_effects() {
        let raw=Response {content:json!({"body":"原始中文正文\n第二行", "annotations":{"execution":{"title":"回放合成值","progress":"","result":"已返回原始正文"},"observations":[]},"effects":[]}).to_string(),tool_calls:vec![]};
        let normalized = normalize_response(&raw, &context()).unwrap();
        assert_eq!(normalized.records.len(), 2);
        assert!(normalized.diagnostics.is_empty());
        assert_eq!(normalized.raw_response.content, raw.content);
        assert!(normalized.execution_response.tool_calls.is_empty());
    }

    #[test]
    fn json_business_text_with_work_is_not_a_reply_control_object() {
        let raw = Response {
            content: json!({"content":"处理中","annotations":{"execution":{"title":"读取合成系统","result":"不得结算"}}}).to_string(),
            tool_calls: vec![call("work", "exec", json!({"command":"original"}))],
        };
        let normalized = normalize_fixture_parts(&raw, &context()).unwrap();
        assert_eq!(normalized.execution_response.content, raw.content);
        assert!(normalized.terminal_decision.is_none());
        assert!(normalized.records.is_empty());
    }

    #[test]
    fn optional_work_and_no_reply_keep_existing_boundaries() {
        let mut ctx = context();
        ctx.protocol = Protocol::On;
        let work = response(vec![call("w", "exec", json!({"command":"unchanged"}))]);
        let normalized = normalize_fixture_parts(&work, &ctx).unwrap();
        assert_eq!(normalized.protocol, Protocol::On);
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
                    normalize_fixture_parts(&control, &ctx)
                        .unwrap()
                        .execution_response
                )
                .unwrap(),
                serde_json::to_value(control).unwrap()
            );
        }
        let value = "{\"business\":true}";
        let mut raw = response(vec![call(
            "r",
            ANNOTATIONS_FORMAT,
            json!({
                "annotations":{"execution":{"title":"核对业务值","result":"返回布尔字段"}}
            }),
        )]);
        raw.content = value.into();
        let typed = normalize_fixture_parts(&raw, &ctx).unwrap();
        assert_eq!(typed.protocol, Protocol::On);
        assert_eq!(typed.execution_response.content, value);
        assert!(typed.execution_response.tool_calls.is_empty());
        assert_eq!(typed.records.len(), 2);
    }

    #[test]
    fn persisted_records_keep_actual_mode_and_reject_source_mismatch() {
        let mut event = persisted_event(12, json!({"title":"完整工作","progress":"阶段"}), false);
        event
            .payload
            .insert("response_annotations".into(), json!("on"));
        let value = event.payload.get_mut(BUNDLE_PAYLOAD_KEY).unwrap();
        value["protocol"] = json!("on");
        for record in value["records"].as_array_mut().unwrap() {
            record["protocol"] = json!("on");
        }
        let scope = context().scope.unwrap();
        let bundle = annotations_from_authorized_event(&event, &scope)
            .unwrap()
            .unwrap();
        assert_eq!(bundle.protocol, Protocol::On);
        assert!(bundle
            .records
            .iter()
            .all(|record| record.protocol == Protocol::On));
        event
            .payload
            .insert("response_annotations".into(), json!("off"));
        assert!(annotations_from_authorized_event(&event, &scope).is_err());
        event.payload.remove("response_annotations");
        assert!(annotations_from_authorized_event(&event, &scope).is_err());
    }

    #[test]
    fn reply_same_response_terminal_mapping_and_control_failures() {
        let raw = response(vec![call(
            "r",
            ANNOTATIONS_FORMAT,
            json!({"annotations":{"execution":{"title":"核对环境","result":"已确认"}}}),
        )]);
        let normalized = normalize_fixture_parts(&raw, &context()).unwrap();
        assert!(normalized.execution_response.tool_calls.is_empty());
        assert_eq!(
            normalized.terminal_decision,
            Some(TerminalDecision::Deliver("正文".into()))
        );
        assert!(
            !normalized
                .records
                .iter()
                .find(|record| record.kind == AnnotationKind::Result)
                .unwrap()
                .effective
        );
        let mut completed = context();
        completed.execution_fact = Some(ExecutionFact {
            scope: completed.scope.clone().unwrap(),
            status: "completed".into(),
            terminal: true,
            terminal_sequence: Some(9),
        });
        assert!(
            normalize_fixture_parts(&raw, &completed)
                .unwrap()
                .records
                .iter()
                .find(|record| record.kind == AnnotationKind::Result)
                .unwrap()
                .effective
        );
        let bad_metadata = normalize_fixture_parts(
            &response(vec![call(
                "r",
                ANNOTATIONS_FORMAT,
                json!({"annotations":null}),
            )]),
            &context(),
        )
        .unwrap();
        assert_eq!(bad_metadata.execution_response.content, "正文");
        assert!(!bad_metadata.diagnostics.is_empty());
        assert!(normalize_fixture_parts(
            &response(vec![
                call("r", ANNOTATIONS_FORMAT, json!({"content":"x"})),
                call("w", "exec", json!({"command":"x"}))
            ]),
            &context()
        )
        .unwrap()
        .terminal_decision
        .is_none());
        let mut empty = response(vec![call(
            "r",
            ANNOTATIONS_FORMAT,
            json!({"status":"success"}),
        )]);
        empty.content.clear();
        assert!(
            normalize_fixture_parts(&empty, &context()).is_err(),
            "metadata is never a substitute for an answer"
        );
    }
    #[test]
    fn no_reply_bound_mode_and_u64_range_unchanged_no_annotations() {
        let default = normalize_fixture_parts(
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
        let explicit = normalize_fixture_parts(
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
        assert!(normalize_fixture_parts(
            &response(vec![call(
                "n",
                "no_reply",
                json!({"mode":"silent","_annotations":{}})
            )]),
            &context()
        )
        .is_err());
        assert!(normalize_fixture_parts(
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
    fn malformed_typed_metadata_is_local_to_its_message() {
        for metadata in [
            Value::Null,
            json!({"execution":null}),
            json!({"unknown":"invalid"}),
        ] {
            let raw = Response {
                content: "正文".into(),
                tool_calls: vec![metadata_call("bad", metadata)],
            };
            let result = normalize_fixture_parts(&raw, &context()).unwrap();
            assert_eq!(result.execution_response.content, "正文");
            assert!(result.execution_response.tool_calls.is_empty());
            assert!(result.records.is_empty());
            assert!(!result.diagnostics.is_empty());
        }
    }
    #[test]
    fn text_headers_are_body_data_and_never_interpreted_as_metadata() {
        let raw = Response {
            content: "<morphz-annotations>{\"execution\":{\"title\":\"旧头\",\"result\":\"旧结果\"}}</morphz-annotations>\n正文".into(),
            tool_calls: vec![],
        };
        let normalized = normalize_fixture_parts(&raw, &context()).unwrap();
        assert_eq!(normalized.execution_response.content, raw.content);
        assert!(normalized.records.is_empty());
        assert_eq!(
            normalize_fixture_parts(&raw, &NormalizationContext::default())
                .unwrap()
                .execution_response
                .content,
            raw.content
        );
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
            ANNOTATIONS_FORMAT,
            json!({"annotations":{"execution":{"title":"核对执行事实","result":"结果"}}}),
        )]);
        let normalized = normalize_fixture_parts(&raw, &ctx).unwrap();
        assert!(normalized.dispatch_allowed);
        assert!(
            !normalized
                .records
                .iter()
                .find(|record| record.kind == AnnotationKind::Result)
                .unwrap()
                .effective
        );
        ctx.execution_fact.as_mut().unwrap().status = "completed".into();
        assert!(
            !normalize_fixture_parts(&raw, &ctx)
                .unwrap()
                .records
                .iter()
                .find(|record| record.kind == AnnotationKind::Result)
                .unwrap()
                .effective
        );
    }
    #[test]
    fn replay_idempotent_and_conflicting_rebind_rejected() {
        let raw = response(vec![call(
            "1",
            "exec",
            json!({"command":"x","_annotations":{"observations":[{"ref":"@e123","result":"Linux"}]}}),
        )]);
        let first = normalize_fixture_parts(&raw, &context()).unwrap();
        let repeated = normalize_fixture_parts(&raw, &context()).unwrap();
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
            ANNOTATIONS_FORMAT,
            json!({"annotations":{"execution":{"title":"标题","progress":"进展","result":"结果"}}}),
        )]);
        let mut records = normalize_fixture_parts(&raw, &ctx).unwrap().records;
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
            !normalize_fixture_parts(&raw, &cancel_context)
                .unwrap()
                .dispatch_allowed
        );
    }
    #[test]
    fn first_valid_title_survives_reordering_later_steps_terminal_and_replay() {
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
                    ANNOTATIONS_FORMAT,
                    json!({"annotations":{"execution":execution}}),
                )
            } else {
                (
                    "exec",
                    json!({"command":"safe","_annotations":{"execution":execution}}),
                )
            };
            normalize_fixture_parts(
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
