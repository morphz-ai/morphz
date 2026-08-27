pub mod lexical;
pub mod postgres;
pub mod sqlite;

pub use lexical::{
    recall_phrase_request, segment_recall_terms, segment_recall_text, RECALL_SEGMENTER,
};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sha2::Digest;
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecallDocumentKind {
    Event,
    Frame,
}

impl RecallDocumentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Event => "event",
            Self::Frame => "frame",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecallDocument {
    pub context_id: String,
    pub document_kind: RecallDocumentKind,
    pub document_id: String,
    pub revision: u64,
    pub searchable_text: String,
    /// Read compatibility for projection work enqueued by the temporary
    /// chunked-index release. New documents always leave this empty and store
    /// the complete canonical text in `searchable_text`.
    #[serde(
        default,
        rename = "searchable_chunks",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub legacy_searchable_chunks: Vec<String>,
    pub preview: String,
    pub retired: bool,
    pub updated_sequence: u64,
    pub state_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecallSearchHit {
    pub document_kind: RecallDocumentKind,
    pub document_id: String,
    pub revision: u64,
    pub retired: bool,
    pub score: f64,
    pub preview: String,
    pub updated_sequence: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occurred_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecallDocumentSearchRequest {
    pub context_id: String,
    /// Empty means chronological Event recall without a lexical predicate.
    pub normalized_query: Option<String>,
    pub start_time: Option<DateTime<Utc>>,
    pub end_time: Option<DateTime<Utc>>,
    /// Stable exclusive Event sequence boundary for backward pagination.
    pub before_sequence: Option<u64>,
    pub limit: usize,
}

/// One physical-index candidate before Runtime-level coverage ranking.
///
/// The physical index is deliberately recall-first: an unquoted query may
/// match any query term.  Ranking and the minimum useful coverage policy live
/// above SQLite/PostgreSQL so both backends expose the same semantics.
#[derive(Debug, Clone)]
pub(crate) struct RecallSearchCandidate {
    pub hit: RecallSearchHit,
    pub searchable_text: String,
}

/// Applies backend-independent broad-recall ranking.
///
/// A multi-term query must normally cover at least two distinct terms.  If
/// that would erase every candidate, the strongest one-term candidates are
/// retained: Recall must degrade in precision, not silently become empty.
/// Fully quoted phrase queries have already been narrowed by the physical
/// index and therefore bypass this fallback policy.
pub(crate) fn rank_recall_candidates(
    mut candidates: Vec<RecallSearchCandidate>,
    query_terms: &[String],
    phrase: bool,
    exact_document_id: &str,
    limit: usize,
) -> Vec<RecallSearchHit> {
    use std::collections::{HashMap, HashSet};

    // Defensively coalesce duplicate backend candidates before applying the
    // shared ranking contract. A conforming whole-document index produces one
    // candidate here; keeping this guard makes backend mistakes non-visible to
    // callers without reintroducing physical chunk semantics.
    let mut merged = HashMap::<(String, String), RecallSearchCandidate>::new();
    for candidate in candidates.drain(..) {
        let key = (
            candidate.hit.document_kind.as_str().to_string(),
            candidate.hit.document_id.clone(),
        );
        match merged.entry(key) {
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(candidate);
            }
            std::collections::hash_map::Entry::Occupied(mut entry) => {
                let current = entry.get_mut();
                if candidate.hit.score > current.hit.score {
                    current.hit.score = candidate.hit.score;
                    current.hit.preview = candidate.hit.preview;
                }
                if !candidate.searchable_text.is_empty() {
                    if !current.searchable_text.is_empty() {
                        current.searchable_text.push(' ');
                    }
                    current.searchable_text.push_str(&candidate.searchable_text);
                }
            }
        }
    }
    candidates = merged.into_values().collect();

    let mut seen = HashSet::new();
    let terms = query_terms
        .iter()
        .filter(|term| seen.insert(term.as_str()))
        .collect::<Vec<_>>();
    let requested_terms = terms
        .iter()
        .map(|term| term.as_str())
        .collect::<HashSet<_>>();
    let total_weight = terms
        .iter()
        .map(|term| recall_term_weight(term))
        .sum::<f64>()
        .max(f64::EPSILON);

    let mut ranked = candidates
        .drain(..)
        .map(|candidate| {
            let stored_terms = candidate
                .searchable_text
                .split_whitespace()
                .collect::<Vec<_>>();
            let stored = stored_terms.iter().copied().collect::<HashSet<_>>();
            let matched = terms
                .iter()
                .filter(|term| stored.contains(term.as_str()))
                .collect::<Vec<_>>();
            let matched_count = matched.len();
            let coverage = matched
                .iter()
                .map(|term| recall_term_weight(term))
                .sum::<f64>()
                / total_weight;
            let density = stored_terms
                .iter()
                .filter(|term| requested_terms.contains(**term))
                .count() as f64
                / stored_terms.len().max(1) as f64;
            let exact = candidate.hit.document_id == exact_document_id;
            (candidate.hit, exact, matched_count, coverage, density)
        })
        .collect::<Vec<_>>();

    // Physical indexes only select candidates. Always verify at least one
    // exact canonical term in the authoritative text so a backend/index bug
    // (or the astronomically unlikely term-key collision) cannot surface a
    // false Recall result. An exact document-id lookup remains intentional.
    if !terms.is_empty() {
        ranked.retain(|(_, exact, matched, _, _)| *exact || *matched > 0);
    }

    let minimum_matches = usize::from(terms.len() > 1) + usize::from(!terms.is_empty());
    if !phrase && minimum_matches > 1 {
        let useful = ranked
            .iter()
            .filter(|(_, exact, matched, coverage, _)| {
                *exact || (*matched >= minimum_matches && *coverage >= 0.25)
            })
            .count();
        if useful > 0 {
            ranked.retain(|(_, exact, matched, coverage, _)| {
                *exact || (*matched >= minimum_matches && *coverage >= 0.25)
            });
        }
    }

    ranked.sort_by(|left, right| {
        right
            .1
            .cmp(&left.1)
            .then_with(|| right.3.total_cmp(&left.3))
            .then_with(|| right.2.cmp(&left.2))
            .then_with(|| right.4.total_cmp(&left.4))
            .then_with(|| right.0.score.total_cmp(&left.0.score))
            .then_with(|| right.0.updated_sequence.cmp(&left.0.updated_sequence))
            .then_with(|| left.0.document_id.cmp(&right.0.document_id))
    });
    ranked
        .into_iter()
        .take(limit.clamp(1, 100))
        .map(|(mut hit, exact, _, coverage, _)| {
            // The public score now has one backend-independent interpretation:
            // exact id first, otherwise distinct query-term coverage.
            hit.score = if exact { 1_000_000.0 } else { coverage };
            hit
        })
        .collect()
}

pub(crate) fn recall_match_preview(
    searchable_text: &str,
    query_terms: &[String],
    fallback: &str,
) -> String {
    const WIDTH: usize = RECALL_PREVIEW_MAX_CHARS;
    let normalized = normalize_recall_text(searchable_text);
    let first = query_terms
        .iter()
        .filter_map(|term| normalized.find(term).map(|offset| (offset, term)))
        .min_by_key(|(offset, _)| *offset);
    let Some((byte_offset, _)) = first else {
        return fallback.chars().take(WIDTH).collect();
    };
    let char_offset = normalized[..byte_offset].chars().count();
    let chars = searchable_text.chars().collect::<Vec<_>>();
    let start = char_offset.saturating_sub(WIDTH / 3);
    let end = (start + WIDTH).min(chars.len());
    let mut preview = chars[start..end].iter().collect::<String>();
    if start > 0 {
        preview.insert(0, '…');
    }
    if end < chars.len() {
        preview.push('…');
    }
    preview
}

fn recall_term_weight(term: &str) -> f64 {
    // A single CJK character is useful evidence but far less discriminating
    // than a complete word. Longer words receive a small, bounded advantage.
    match term.chars().count() {
        0 => 0.0,
        1 => 0.35,
        count => (count.min(6) as f64).sqrt(),
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LexicalSearchMode {
    /// Terms are segmented by the Runtime and indexed whole, so a query only
    /// matches on the same word boundaries the Projection was written with.
    SqliteFts5Segmented,
    /// PostgreSQL GIN over the complete Runtime-segmented term array. This
    /// needs no extension and avoids imposing `tsvector`'s value-size ceiling
    /// on an otherwise valid long Recall document.
    PostgresGinSegmented,
    /// Full-text acceleration is unavailable. The Runtime may still resolve an
    /// exact Recall document id, but must not silently scan every document
    /// with a substring `LIKE` query.
    ExactDocumentOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecallIndexCapability {
    pub mode: LexicalSearchMode,
    pub indexed: bool,
    pub unicode_normalization: String,
    /// Identifies the word segmenter that produced the stored terms. Changing
    /// it changes tokenization, so a Projection is only comparable against a
    /// query segmented by the same value and must otherwise be rebuilt.
    pub segmenter: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecallIndexAudit {
    pub context_id: String,
    pub capability: RecallIndexCapability,
    pub event_documents: u64,
    pub frame_documents: u64,
}

/// Result of one bounded, rebuildable Recall Projection outbox pass.
/// Events and Mind commits only enqueue work; this result describes the
/// independent projection work and is never part of domain correctness.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecallProjectionBatch {
    pub claimed: usize,
    pub projected: usize,
    pub skipped: usize,
    pub failed: usize,
}

/// Runtime-owned read model for an operator's acknowledgement of one derived
/// attention fact. The immutable source Event remains persisted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AttentionAcknowledgementRecord {
    pub event_id: String,
    /// Immutable Event sequence that advanced this projection key. A zero
    /// value is used only by the synchronous command response before the
    /// committed projection is read back.
    #[serde(default)]
    pub event_sequence: u64,
    pub context_id: String,
    pub key: String,
    pub source_kind: String,
    pub source_id: String,
    pub source_revision: u64,
    pub acknowledged_by: String,
    pub rationale: Option<String>,
    pub acknowledged_at: DateTime<Utc>,
}

pub const RECALL_PREVIEW_MAX_CHARS: usize = 500;

/// Runtime diagnostics and transient scheduler protocol are deliberately not
/// lexical memory. Keeping this allow-list small prevents internal duplicate
/// events and large inspection payloads from dominating Recall.
pub fn event_has_recall_value(event: &crate::event::Event) -> bool {
    crate::event::assistant_call_has_tool_history(event)
        || matches!(
            event.topic.as_str(),
            "chat/user_message"
                | "chat/reply"
                | "chat/tool_output"
                | "chat/file_change"
                | "chat/outbound_message"
                | "chat/session_signal"
                | "chat/context_tx_committed"
                | "runtime/thread_result"
                | "runtime/delegation_result"
        )
}

/// Deterministic lexical normalization shared by indexing and querying.
/// NFKC resolves common full-width/half-width variants while lowercase keeps
/// mixed Latin/Chinese lookup stable without inventing business synonyms.
pub fn normalize_recall_text(value: &str) -> String {
    value.nfkc().flat_map(char::to_lowercase).collect()
}

/// Content hash of a document's indexed form.
///
/// The Projection rebuild migration re-derives stored text under the current
/// segmenter, so it must produce the hash exactly the way the write path does.
pub fn recall_state_hash(searchable_text: &str, retired: bool) -> String {
    format!(
        "{:x}",
        sha2::Sha256::digest(format!("{searchable_text}\0{retired}").as_bytes())
    )
}

fn push_recall_text(output: &mut String, value: &str) {
    output.push_str(value);
}

fn collect_recall_scalars(value: &serde_json::Value, output: &mut String) {
    match value {
        serde_json::Value::String(value) => {
            push_recall_text(output, " ");
            push_recall_text(output, value);
        }
        serde_json::Value::Number(value) => {
            push_recall_text(output, " ");
            push_recall_text(output, &value.to_string());
        }
        serde_json::Value::Bool(value) => {
            push_recall_text(output, " ");
            push_recall_text(output, if *value { "true" } else { "false" });
        }
        serde_json::Value::Array(values) => {
            for value in values {
                collect_recall_scalars(value, output);
            }
        }
        serde_json::Value::Object(values) => {
            for value in values.values() {
                collect_recall_scalars(value, output);
            }
        }
        serde_json::Value::Null => {}
    }
}

pub fn event_recall_document(
    event: &crate::event::Event,
    context_id: &str,
    sequence: u64,
) -> RecallDocument {
    event_recall_document_with_retired(event, context_id, sequence, false)
}

pub fn event_recall_document_with_retired(
    event: &crate::event::Event,
    context_id: &str,
    sequence: u64,
    retired: bool,
) -> RecallDocument {
    let mut readable = String::new();
    push_recall_text(
        &mut readable,
        &format!("{} {} {}", event.id, event.actor, event.topic),
    );
    collect_recall_scalars(
        &serde_json::Value::Object(event.payload.clone()),
        &mut readable,
    );
    let searchable_text = segment_recall_text(&readable);
    let preview = readable
        .chars()
        .take(RECALL_PREVIEW_MAX_CHARS)
        .collect::<String>();
    let state_hash = recall_state_hash(&searchable_text, retired);
    RecallDocument {
        context_id: context_id.to_string(),
        document_kind: RecallDocumentKind::Event,
        document_id: event.id.clone(),
        revision: 0,
        searchable_text,
        legacy_searchable_chunks: Vec::new(),
        preview,
        retired,
        updated_sequence: sequence,
        state_hash,
    }
}

/// Canonicalizes a Recall document prepared outside the Event projection.
///
/// `legacy_searchable_chunks` is consumed only when replaying work serialized by the
/// temporary chunked-index release. The resulting physical document always
/// contains the complete normalized text in one field.
pub fn canonicalize_recall_document(mut document: RecallDocument) -> RecallDocument {
    document.searchable_text = if document.legacy_searchable_chunks.is_empty() {
        segment_recall_text(&document.searchable_text)
    } else {
        lexical::merge_legacy_recall_chunks(&document.legacy_searchable_chunks)
    };
    document.legacy_searchable_chunks.clear();
    document.preview = document
        .preview
        .chars()
        .take(RECALL_PREVIEW_MAX_CHARS)
        .collect();
    document.state_hash = recall_state_hash(&document.searchable_text, document.retired);
    document
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Active,
    Archived,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SessionAttentionState {
    #[default]
    Active,
    Retired,
}

impl SessionAttentionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Retired => "retired",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentRecord {
    pub id: String,
    pub title: String,
    pub status: SessionStatus,
    pub root_context_id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct NewAgent {
    pub id: String,
    pub title: String,
    pub root_context_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentBootstrapRecord {
    pub agent: AgentRecord,
    pub root_context: CognitiveContextRecord,
    pub initial_session: SessionRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CognitiveContextRecord {
    pub id: String,
    pub agent_id: String,
    pub title: String,
    pub status: SessionStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed_context_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed_context_version: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed_snapshot_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed_projection: Option<String>,
    /// Operator/user preference. Runtime caps this value by the selected
    /// Provider+Model's physical prompt capacity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_hard_token_limit: Option<u64>,
    #[serde(default)]
    pub token_budget_revision: u64,
}

/// Persistent logical activity clock for one shared Cognitive Context.
/// Wall-clock time is deliberately absent: only a uniquely claimed Signal
/// batch containing an external cognitive fact advances this counter.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextCognitiveClock {
    pub context_id: String,
    pub tick: u64,
    pub last_signal_batch_id: Option<String>,
    pub revision: u64,
}

#[derive(Debug, Clone)]
pub struct NewCognitiveContext {
    pub id: String,
    pub agent_id: String,
    pub title: String,
}

#[derive(Debug, Clone, Default)]
pub struct ContextUpdate {
    pub title: Option<String>,
    pub status: Option<SessionStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ContextTokenBudgetMutation {
    Updated(CognitiveContextRecord),
    Conflict(CognitiveContextRecord),
    NotFound,
}

/// Operator-owned binding of one optional Runtime capability to a Cognitive
/// Context. Capability bindings are control-plane state: they do not become
/// Mind Frames and are projected into model input only while enabled.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextCapabilityBindingRecord {
    pub context_id: String,
    pub capability_id: String,
    pub enabled: bool,
    pub revision: u64,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ContextCapabilityBindingMutation {
    Updated(ContextCapabilityBindingRecord),
    Conflict(ContextCapabilityBindingRecord),
    NotFound,
}

/// Durable contract for one bounded unit of work assigned across an authority
/// boundary. The contract is deliberately generic: experimental Cognitive
/// Coordination is its first producer, while the stable Runtime owns only the
/// lifecycle, route and audit envelope.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkAssignmentRecord {
    /// Runtime-local durable identity. A protocol Assignment may have one
    /// issuer-side and one assignee-side record in the same Runtime.
    pub id: String,
    /// Extensible producer namespace, for example
    /// `cognitive_coordination/evaluation`.
    pub kind: String,
    /// Identity supplied by the producer protocol.
    pub external_id: String,
    pub agent_id: String,
    pub context_id: String,
    /// Session currently carrying execution or delivery. The Assignment is
    /// Context-visible and is not owned by this Session.
    pub session_id: String,
    /// Producer-defined role such as `coordinator` or `participant`.
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub objective_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub counterparty_id: Option<String>,
    pub summary: String,
    /// Immutable producer contract. Runtime does not interpret this payload.
    pub input: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<serde_json::Value>,
    pub status: WorkAssignmentStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_reason: Option<String>,
    /// Absolute end of the current execution claim. Recovery may interrupt a
    /// nonterminal Assignment only after this deadline, so another Runtime
    /// worker sharing the Store is never fenced merely because a peer starts.
    pub lease_expires_at: DateTime<Utc>,
    pub revision: u64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkAssignmentStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Interrupted,
}

impl WorkAssignmentStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Cancelled | Self::Interrupted
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NewWorkAssignment {
    pub id: String,
    pub kind: String,
    pub external_id: String,
    pub agent_id: String,
    pub context_id: String,
    pub session_id: String,
    pub role: String,
    pub request_id: Option<String>,
    pub objective_id: Option<String>,
    pub counterparty_id: Option<String>,
    pub summary: String,
    pub input: serde_json::Value,
    pub status: WorkAssignmentStatus,
    pub lease_expires_at: DateTime<Utc>,
}

/// Result of idempotently admitting one immutable Assignment contract. The
/// `created` bit is the durable execution claim: only the writer that inserted
/// the record may start the work; retries must reuse or observe the existing
/// lifecycle instead of executing it twice.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkAssignmentCreateResult {
    pub record: WorkAssignmentRecord,
    pub created: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkAssignmentMutation {
    pub expected_revision: u64,
    pub status: WorkAssignmentStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum WorkAssignmentMutationResult {
    Updated(WorkAssignmentRecord),
    Conflict(WorkAssignmentRecord),
    NotFound,
}

/// Rebuildable online materialization of one Cognitive Context's current Mind.
///
/// The persistence layer deliberately treats `state` as opaque canonical JSON:
/// Frame body semantics belong to the Agent/Context engine, while the Store
/// owns revision fencing, hashes and atomic durability.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MindProjectionRecord {
    pub context_id: String,
    pub revision: u64,
    pub state: serde_json::Value,
    pub state_hash: String,
    pub head_event_id: Option<String>,
    pub updated_at: DateTime<Utc>,
}

/// Small, bounded operator read model for a Mind Projection.  Global Runtime
/// surfaces must not load the opaque (and potentially very large) Mind state
/// merely to display its revision.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MindProjectionHead {
    pub context_id: String,
    pub revision: u64,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct NewMindProjection {
    pub context_id: String,
    pub revision: u64,
    pub state: serde_json::Value,
    pub state_hash: String,
    pub head_event_id: Option<String>,
    /// Changed Frame lexical documents prepared by the Context domain. Event
    /// documents are projected automatically when their Event row is added.
    pub recall_documents: Vec<RecallDocument>,
}

/// Observation membership changes caused by one Context transaction.
/// IDs which name Frames are harmless: Store implementations only mutate a
/// Session Projection when the target resolves to an Observation Event.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionProjectionMutation {
    pub retired_event_ids: Vec<String>,
    pub restored_event_ids: Vec<String>,
}

/// Causally consistent input for one model Context compilation. Mind and the
/// active Observation membership are committed together and must also be
/// observed from one database snapshot; independent reads can otherwise omit
/// both a retired source Event and the Frame derived from it.
#[derive(Debug, Clone)]
pub struct ContextEncodingProjectionSnapshot {
    pub mind: Option<MindProjectionRecord>,
    pub events: Vec<crate::event::Event>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MindSnapshotRecord {
    pub id: String,
    pub context_id: String,
    pub revision: u64,
    pub state: serde_json::Value,
    pub state_hash: String,
    pub head_event_id: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum MindProjectionCommit {
    Committed { projection: MindProjectionRecord },
    Conflict { current_revision: Option<u64> },
}

/// Durable online Mind projection with database-enforced revision fencing.
///
/// The append-only Event Store remains the source of truth. This store owns the
/// rebuildable current-state projection and the Context head used for CAS. A
/// successful Context mutation must persist its Event, Mind Projection,
/// Session Projection mutation and affected Session attention rows in one
/// database transaction.
#[async_trait::async_trait]
pub trait MindProjectionStore: Send + Sync {
    async fn get_mind_projection(
        &self,
        context_id: &str,
    ) -> Result<Option<MindProjectionRecord>, Box<dyn std::error::Error + Send + Sync>>;

    /// Bounded global projection metadata for operator overview surfaces.
    async fn list_mind_projection_heads(
        &self,
        context_ids: &[String],
    ) -> Result<Vec<MindProjectionHead>, Box<dyn std::error::Error + Send + Sync>>;

    async fn get_latest_mind_snapshot(
        &self,
        context_id: &str,
    ) -> Result<Option<MindSnapshotRecord>, Box<dyn std::error::Error + Send + Sync>>;

    /// Lazily installs a projection reconstructed by replaying persisted Events. Concurrent
    /// initializers converge on the already committed row.
    async fn initialize_mind_projection(
        &self,
        projection: NewMindProjection,
    ) -> Result<MindProjectionRecord, Box<dyn std::error::Error + Send + Sync>>;

    /// Atomically CASes the Context head, replaces the current Mind projection,
    /// mutates active Session observations, updates Session attention and
    /// appends the immutable transaction Event.
    async fn commit_mind_projection_transaction(
        &self,
        event: &crate::event::Event,
        attention_updates: &[SessionAttentionUpdate],
        session_projection: &SessionProjectionMutation,
        expected_revision: u64,
        next_projection: NewMindProjection,
    ) -> Result<MindProjectionCommit, Box<dyn std::error::Error + Send + Sync>>;

    /// Atomically installs a projected seed Mind, records seed provenance on
    /// the target Context and appends its immutable seed Event. Seeding keeps
    /// revision zero but is fenced by the empty Context head.
    #[allow(clippy::too_many_arguments)]
    async fn commit_mind_seed_projection(
        &self,
        event: &crate::event::Event,
        source_context_id: &str,
        source_version: u64,
        snapshot_hash: &str,
        projection_kind: &str,
        next_projection: NewMindProjection,
    ) -> Result<MindProjectionCommit, Box<dyn std::error::Error + Send + Sync>>;
}

impl SessionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Archived => "archived",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionRecord {
    pub id: String,
    pub agent_id: String,
    /// Immutable attachment to the Cognitive Context that owns the shared Mind.
    pub context_id: String,
    pub parent_session_id: Option<String>,
    pub title: String,
    pub status: SessionStatus,
    /// Optional model route selected for future Evaluations in this Session.
    /// `None` inherits the Runtime primary model at Evaluation binding time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_alias: Option<String>,
    /// Optional reasoning-effort override selected for future Evaluations in
    /// this Session. `None` inherits the Runtime/service default. The value is
    /// validated at the Runtime boundary before it reaches persistent state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// Whether this Session's conversation history may enter another
    /// Session's automatic Context working set. The current Session always
    /// sees its own history; shared Mind and explicit Recall remain
    /// Context-scoped.
    #[serde(default)]
    pub context_sharing: SessionContextSharing,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub last_activity_at: DateTime<Utc>,
    /// Attention belongs to the active Context mount, not to the IO lifecycle.
    #[serde(default)]
    pub attention_state: SessionAttentionState,
    #[serde(default)]
    pub attention_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attention_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attention_changed_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attention_event_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionContextSharing {
    #[default]
    Shared,
    Isolated,
}

impl SessionContextSharing {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Shared => "shared",
            Self::Isolated => "isolated",
        }
    }
}

/// Runtime-authoritative identity. A Principal is stable across Sessions and
/// is never inferred from message text or an LLM-generated Frame.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PrincipalRecord {
    pub id: String,
    pub provider_id: String,
    pub assurance: String,
    pub display_name: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// A bounded row in the operator-facing Principal directory.
///
/// The directory is deliberately a search API rather than a complete list:
/// a public Runtime may contain millions of Principals, while an operator only
/// needs enough identity and activity metadata to choose an observation scope.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PrincipalDirectoryEntry {
    pub principal: PrincipalRecord,
    pub session_count: u64,
    pub active_session_count: u64,
    pub context_count: u64,
    pub last_activity_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PrincipalDirectoryPage {
    pub entries: Vec<PrincipalDirectoryEntry>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewPrincipal {
    pub id: String,
    pub provider_id: String,
    pub assurance: String,
    pub display_name: Option<String>,
}

/// Participation is orthogonal to the Agent -> Context -> Session ownership
/// hierarchy. One Principal may participate in several Sessions and one
/// Session may eventually contain several Principals (for example a group
/// conversation). The exact sender still belongs to each immutable message
/// Event rather than to this directory record.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionPrincipalBinding {
    pub session_id: String,
    pub principal_id: String,
    pub bound_at: DateTime<Utc>,
    pub unbound_at: Option<DateTime<Utc>>,
}

/// Aggregate Session directory metadata used by bounded Runtime overview
/// projections.  Counts remain separate from the displayed Session window so
/// an operator can see that more Sessions exist without loading them all.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextSessionCount {
    pub context_id: String,
    pub active_sessions: u64,
    pub total_sessions: u64,
    pub last_activity_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionMountKind {
    ExistingContext,
    NewBlankContext,
    NewContextFromMind,
    DelegationProjection,
}

impl SessionMountKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ExistingContext => "existing_context",
            Self::NewBlankContext => "new_blank_context",
            Self::NewContextFromMind => "new_context_from_mind",
            Self::DelegationProjection => "delegation_projection",
        }
    }
}

#[derive(Debug, Clone)]
pub struct NewSession {
    pub id: String,
    pub agent_id: String,
    pub context_id: String,
    pub parent_session_id: Option<String>,
    pub title: String,
    pub mount_kind: SessionMountKind,
}

#[derive(Debug, Clone, Default)]
pub struct SessionUpdate {
    pub title: Option<String>,
    pub status: Option<SessionStatus>,
    /// `None` leaves the binding unchanged. `Some(None)` restores Runtime
    /// inheritance; `Some(Some(alias))` selects a concrete enabled route.
    pub model_alias: Option<Option<String>>,
    /// `None` leaves the override unchanged. `Some(None)` restores service
    /// inheritance; `Some(Some(level))` freezes a Session-specific level.
    pub reasoning_effort: Option<Option<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionAttentionUpdate {
    pub session_id: String,
    pub context_id: String,
    pub expected_revision: u64,
    pub state: SessionAttentionState,
    pub reason: Option<String>,
    pub changed_at: DateTime<Utc>,
    pub event_id: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThreadActivationStatus {
    Queued,
    Running,
    Succeeded,
    Cancelled,
    Failed,
}

impl ThreadActivationStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Cancelled | Self::Failed)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ThreadActivationRecord {
    pub id: String,
    pub revision: u64,
    /// Fences this physical Evaluation against restarts of the same logical
    /// Thread. A restarted DialogueTurn keeps its causal root but increments
    /// the Thread generation; outcomes from older generations are ignored.
    pub generation: u64,
    pub agent_id: String,
    pub context_id: String,
    pub session_id: String,
    pub initiating_principal_id: Option<String>,
    pub trigger_event_id: String,
    pub trigger_sequence: u64,
    pub trigger_kind: String,
    pub parent_activation_id: Option<String>,
    pub root_turn_id: String,
    pub context_snapshot_version: Option<u64>,
    /// Logical model route used to compile the Evaluation's initial Context
    /// Projection. Each physical request may use newer mutable Session policy;
    /// its exact binding is recorded in the corresponding Model Attempt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_alias: Option<String>,
    /// Initial reasoning-policy snapshot for the Evaluation. Physical requests
    /// resolve current Session policy and persist their effective value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    pub status: ThreadActivationStatus,
    pub claimed_by: Option<String>,
    pub lease_expires_at: Option<DateTime<Utc>>,
    /// The DialogueTurn has finished its conversational decision and handed
    /// physical work to the execution layer. The Activation may remain
    /// running, but it no longer serializes later DialogueTurns in the same
    /// Session. Persisting this boundary makes the queue crash-safe and keeps
    /// Thread kind/supervision immutable.
    pub dialogue_lane_released_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct NewThreadActivation {
    pub id: String,
    pub agent_id: String,
    pub context_id: String,
    pub session_id: String,
    pub initiating_principal_id: Option<String>,
    pub trigger_event_id: String,
    pub trigger_sequence: u64,
    pub trigger_kind: String,
    pub parent_activation_id: Option<String>,
    pub root_turn_id: String,
}

/// Strictly validates the durable causal graph of one Plan-owned infer
/// Evaluation. The two optional parent columns are the only fields allowed to
/// be absent for rows written before direct Signals carried explicit parent
/// routes.
pub(crate) fn validate_plan_evaluation_activation_route(
    plan: &PlanExecutionRecord,
    event: &crate::event::Event,
    child_thread: &ThreadRecord,
    signal: &ThreadSignalRecord,
    activation: &ThreadActivationRecord,
    parent_thread: &ThreadRecord,
    parent_activation: &ThreadActivationRecord,
) -> Result<(), String> {
    let payload_string = |key: &str| event.payload.get(key).and_then(JsonValue::as_str);
    let event_sequence = event
        .sequence
        .ok_or_else(|| format!("infer Event '{}' is missing a durable sequence", event.id))?;
    let expected_activation_id = stable_thread_activation_id(&event.id);
    let expected_signal_id = stable_thread_signal_id(&event.id);
    let expected_thread_id = stable_thread_id(&event.id);
    let expected_parent = Some(plan.activation_id.as_str());

    if plan.status != PlanExecutionStatus::Waiting
        || plan.pending_kind != Some(PlanExecutionWaitKind::Evaluation)
        || plan.pending_id.as_deref() != Some(activation.id.as_str())
        || activation.id != expected_activation_id
        || event.event_type != crate::event::TYPE_INFER_REQUEST
        || event.topic != "chat/infer_request"
        || payload_string("plan_execution_id") != Some(plan.id.as_str())
        || payload_string("agent_id") != Some(plan.agent_id.as_str())
        || payload_string("context_id") != Some(plan.context_id.as_str())
        || payload_string("session_id") != Some(plan.session_id.as_str())
        || payload_string("root_turn_id") != Some(event.id.as_str())
        || payload_string("parent_activation_id") != expected_parent
        || payload_string("principal_id") != plan.initiating_principal_id.as_deref()
    {
        return Err(
            "PlanExecution route is inconsistent with deterministic infer Event".to_string(),
        );
    }

    if child_thread.id != expected_thread_id
        || child_thread.agent_id != plan.agent_id
        || child_thread.context_id != plan.context_id
        || child_thread.session_id != plan.session_id
        || child_thread.initiating_principal_id != plan.initiating_principal_id
        || child_thread.root_turn_id != event.id
        || child_thread.kind != ThreadKind::Execution
        || child_thread.executor_kind != "plan_infer"
        || child_thread.executor_id.as_deref() != Some(plan.id.as_str())
    {
        return Err(
            "PlanExecution route is inconsistent with deterministic infer Thread".to_string(),
        );
    }

    if signal.id != expected_signal_id
        || signal.thread_id != child_thread.id
        || signal.thread_generation != child_thread.generation
        || signal.event_id != event.id
        || signal.principal_id != plan.initiating_principal_id
        || signal.sequence != event_sequence
        || signal.kind != event.topic
        || signal
            .parent_activation_id
            .as_deref()
            .is_some_and(|parent| Some(parent) != expected_parent)
    {
        return Err(
            "PlanExecution route is inconsistent with deterministic infer Signal".to_string(),
        );
    }

    if activation.agent_id != plan.agent_id
        || activation.context_id != plan.context_id
        || activation.session_id != plan.session_id
        || activation.initiating_principal_id != plan.initiating_principal_id
        || activation.trigger_event_id != event.id
        || activation.trigger_sequence != event_sequence
        || activation.trigger_kind != event.topic
        || activation.root_turn_id != child_thread.root_turn_id
        || activation.generation != child_thread.generation
        || activation
            .parent_activation_id
            .as_deref()
            .is_some_and(|parent| Some(parent) != expected_parent)
    {
        return Err(
            "PlanExecution route is inconsistent with deterministic infer Activation".to_string(),
        );
    }

    if parent_thread.id != plan.thread_id
        || parent_thread.agent_id != plan.agent_id
        || parent_thread.context_id != plan.context_id
        || parent_thread.session_id != plan.session_id
        || parent_thread.initiating_principal_id != plan.initiating_principal_id
        || parent_activation.id != plan.activation_id
        || parent_activation.agent_id != plan.agent_id
        || parent_activation.context_id != plan.context_id
        || parent_activation.session_id != plan.session_id
        || parent_activation.initiating_principal_id != plan.initiating_principal_id
        || parent_activation.root_turn_id != parent_thread.root_turn_id
        || parent_activation.generation != parent_thread.generation
    {
        return Err(
            "PlanExecution route is inconsistent with the existing parent Activation".to_string(),
        );
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ThreadActivationMutation {
    Updated(ThreadActivationRecord),
    Conflict { current: ThreadActivationRecord },
    NotFound,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActivationOutcomeCommit {
    Committed {
        /// Persisted Events whose authoritative Thread Signals were created in
        /// the same transaction. The Runtime only has to notify the live
        /// executor; it must not infer or materialize another route.
        ready_signal_event_ids: Vec<String>,
        /// Durable control-plane Events whose projection transition completed
        /// in the same transaction. They do not route through a Thread Signal,
        /// but their process-local supervisors still need an idempotent wake
        /// notification after the commit point.
        ready_supervisor_event_ids: Vec<String>,
    },
    /// The physical Activation reached a durable Provider-recovery boundary,
    /// but its logical Thread remains open. The same transaction appends the
    /// nonterminal notice, acknowledges the claimed Signal batch and registers
    /// one required Thread -> Resource dependency.
    Suspended {
        dependency_id: String,
    },
    Existing {
        event_id: String,
    },
    /// The Evaluation tried to publish a terminal reply while it still owns
    /// required attached work. The reply is not appended as a Thread outcome;
    /// the durable Thread Group barrier will wake a successor Activation once
    /// the children have reached terminal states.
    DeferredByOpenThreadGroups {
        group_ids: Vec<String>,
    },
    StaleGeneration,
    /// The physical Activation was already cancelled or otherwise reached a
    /// terminal state before it claimed an outcome. This durably fences an
    /// expired Objective Evaluation from its replacement.
    StaleActivation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CompletionContractEvaluation {
    pub passed: bool,
    pub check_results: JsonValue,
    pub unresolved_failures: Vec<String>,
}

/// Applies the Runtime-owned, deterministic part of a Thread completion
/// contract. Domain or semantic checks remain Harness/Supervisor work; their
/// reported results are preserved under `reported`.
pub fn evaluate_thread_completion_contract(
    contract: &JsonValue,
    terminal_kind: ThreadLifecycle,
    summary: Option<&str>,
    artifact_refs: &[JsonValue],
    evidence_refs: &[JsonValue],
    reported_checks: &JsonValue,
    reported_failures: &[JsonValue],
) -> CompletionContractEvaluation {
    let object = contract.as_object();
    let allow_unresolved = object
        .and_then(|value| value.get("allow_unresolved_failures"))
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    let require_summary = object
        .and_then(|value| value.get("require_summary"))
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    let min_artifacts = object
        .and_then(|value| value.get("min_artifacts"))
        .and_then(JsonValue::as_u64)
        .unwrap_or_else(|| {
            u64::from(
                object
                    .and_then(|value| value.get("require_artifacts"))
                    .and_then(JsonValue::as_bool)
                    .unwrap_or(false),
            )
        });
    let min_evidence = object
        .and_then(|value| value.get("min_evidence"))
        .and_then(JsonValue::as_u64)
        .unwrap_or_else(|| {
            u64::from(
                object
                    .and_then(|value| value.get("require_evidence"))
                    .and_then(JsonValue::as_bool)
                    .unwrap_or(false),
            )
        });
    let mut failures = reported_failures
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| value.to_string())
        })
        .collect::<Vec<_>>();
    let terminal_passed = terminal_kind == ThreadLifecycle::Completed;
    if !terminal_passed {
        failures.push(format!("thread_terminal_kind={}", terminal_kind.as_str()));
    }
    let summary_passed = !require_summary || summary.is_some_and(|value| !value.trim().is_empty());
    if !summary_passed {
        failures.push("completion_contract:summary_required".to_string());
    }
    let artifacts_passed = artifact_refs.len() as u64 >= min_artifacts;
    if !artifacts_passed {
        failures.push(format!(
            "completion_contract:artifacts={}<{}",
            artifact_refs.len(),
            min_artifacts
        ));
    }
    let evidence_passed = evidence_refs.len() as u64 >= min_evidence;
    if !evidence_passed {
        failures.push(format!(
            "completion_contract:evidence={}<{}",
            evidence_refs.len(),
            min_evidence
        ));
    }
    let required_checks = object
        .and_then(|value| value.get("required_checks"))
        .and_then(JsonValue::as_array)
        .cloned()
        .unwrap_or_default();
    let mut missing_checks = Vec::new();
    for name in required_checks.iter().filter_map(JsonValue::as_str) {
        let passed = reported_checks
            .get(name)
            .is_some_and(completion_check_value_passed);
        if !passed {
            missing_checks.push(name.to_string());
            failures.push(format!("completion_contract:check_failed:{name}"));
        }
    }
    failures.sort();
    failures.dedup();
    let unresolved_passed = allow_unresolved || failures.is_empty();
    let passed = terminal_passed
        && summary_passed
        && artifacts_passed
        && evidence_passed
        && missing_checks.is_empty()
        && unresolved_passed;
    CompletionContractEvaluation {
        passed,
        check_results: serde_json::json!({
            "reported": reported_checks,
            "runtime": {
                "passed": passed,
                "terminal": terminal_passed,
                "summary": summary_passed,
                "artifacts": {
                    "actual": artifact_refs.len(),
                    "minimum": min_artifacts,
                    "passed": artifacts_passed,
                },
                "evidence": {
                    "actual": evidence_refs.len(),
                    "minimum": min_evidence,
                    "passed": evidence_passed,
                },
                "required_checks": required_checks,
                "missing_checks": missing_checks,
                "allow_unresolved_failures": allow_unresolved,
            }
        }),
        unresolved_failures: failures,
    }
}

fn completion_check_value_passed(value: &JsonValue) -> bool {
    value.as_bool().unwrap_or_else(|| {
        value
            .get("passed")
            .and_then(JsonValue::as_bool)
            .or_else(|| {
                value
                    .get("status")
                    .and_then(JsonValue::as_str)
                    .map(|status| matches!(status, "passed" | "success" | "satisfied"))
            })
            .unwrap_or(false)
    })
}

#[derive(Debug, Clone)]
pub struct DialogueTurnRetryRequest {
    pub expected_thread_revision: u64,
    pub expected_result_event_id: String,
    pub event: crate::event::Event,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DialogueTurnRetryMutation {
    Accepted {
        thread_id: String,
        generation: u64,
    },
    Existing {
        thread_id: String,
        generation: u64,
    },
    Conflict {
        current: ThreadRecord,
    },
    Rejected {
        current: ThreadRecord,
        reason: String,
    },
    NotFound,
}

/// Fenced commit result for one persistent Delivery Timer generation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeliveryFlushCommit {
    Committed,
    Existing { event_id: String },
    Stale,
    Empty,
}

/// Per-message scheduling policy for an ordinary DialogueTurn.
///
/// The configured default is resolved at ingress. Persisted Events therefore
/// always carry one of these explicit modes and remain replayable even if the
/// process configuration changes later.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageDispatchMode {
    /// Replace a still-thinking DialogueTurn, including one suspended at a
    /// durable Provider-recovery boundary. Once the preceding turn has crossed
    /// into physical Execution, the new turn proceeds concurrently.
    Interrupt,
    /// Start an independent DialogueTurn without acquiring the Session's
    /// ordinary serial dialogue lane.
    Parallel,
    /// Start an independent DialogueTurn only after the immediately preceding
    /// user turn has reached a terminal, user-visible delivery state.
    FollowUp,
}

impl MessageDispatchMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Interrupt => "interrupt",
            Self::Parallel => "parallel",
            Self::FollowUp => "follow_up",
        }
    }
}

/// Durable mailbox fact addressed to one causal Thread. The immutable Event
/// remains the physical/audit fact; this record owns only scheduler delivery
/// and consumption state.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThreadSignalStatus {
    Pending,
    Claimed,
    Acknowledged,
}

impl ThreadSignalStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Claimed => "claimed",
            Self::Acknowledged => "acknowledged",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ThreadSignalRecord {
    pub id: String,
    pub thread_id: String,
    /// Fences this mailbox fact to the exact logical Thread generation that
    /// existed when the causative Kernel transaction committed it.
    pub thread_generation: u64,
    pub event_id: String,
    pub principal_id: Option<String>,
    pub sequence: u64,
    pub kind: String,
    pub parent_activation_id: Option<String>,
    pub status: ThreadSignalStatus,
    pub created_at: DateTime<Utc>,
    pub claimed_at: Option<DateTime<Utc>>,
    pub acknowledged_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub struct NewThreadSignal {
    pub id: String,
    pub thread_id: String,
    pub thread_generation: u64,
    pub event_id: String,
    pub principal_id: Option<String>,
    pub sequence: u64,
    pub kind: String,
    pub parent_activation_id: Option<String>,
}

/// Stable scheduler identity for the one mailbox Signal caused by an
/// immutable Event.  Every backend and recovery path uses this helper so an
/// idempotent replay cannot invent a second Signal identity.
pub fn stable_thread_signal_id(event_id: &str) -> String {
    let digest = sha2::Sha256::digest(event_id.as_bytes());
    let id = format!("signal_{digest:x}");
    id[..31].to_string()
}

/// Stable scheduler identity for the physical Activation caused by one
/// immutable trigger Event. Keeping the derivation in the Store contract lets
/// recovery validate legacy rows without depending on process-local router
/// state.
pub(crate) fn stable_thread_activation_id(event_id: &str) -> String {
    let digest = sha2::Sha256::digest(event_id.as_bytes());
    let id = format!("work_{digest:x}");
    id[..29].to_string()
}

/// Stable scheduler identity for the logical Thread rooted at one immutable
/// persisted Event fact.  Ingress, recovery and the Orchestrator must derive the same
/// identity so a crash between durable commit and in-process dispatch cannot
/// create a second Thread.
pub fn stable_thread_id(root_turn_id: &str) -> String {
    let digest = sha2::Sha256::digest(root_turn_id.as_bytes());
    let id = format!("thread_{digest:x}");
    id[..31].to_string()
}

/// Stable causal root for the primary Execution Thread supervised by one
/// Objective generation. Individual Evaluations are represented by immutable
/// Signals and finite Activations on this Thread; they must not invent a new
/// logical Thread on every continuation.
pub fn objective_primary_execution_root_id(
    objective_id: &str,
    objective_generation: u64,
) -> String {
    // The persisted causal root is intentionally stable across the semantic
    // correction from Objective Thread to primary Execution Thread. Changing
    // it would fork every active Objective into a second physical lane.
    format!(
        "objective_thread_{objective_id}_g{}",
        objective_generation.max(1)
    )
}

/// Maximum number of consecutive immutable Signals folded into one physical
/// model Activation.  This is a scheduler contract shared by ingress and
/// activation claiming, not an Orchestrator-local tuning knob.
pub const DEFAULT_THREAD_SIGNAL_BATCH_LIMIT: usize = 32;

/// Durable handoff between immutable Events and the Scheduler mailbox.
/// `pending` means the Event is committed but has not yet been materialized as
/// a Thread Signal. `materialized` means `signal_id` is the durable successor.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SignalOutboxStatus {
    Pending,
    Materialized,
    Discarded,
}

impl SignalOutboxStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Materialized => "materialized",
            Self::Discarded => "discarded",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SignalOutboxRecord {
    pub event_id: String,
    pub status: SignalOutboxStatus,
    pub signal_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub resolved_at: Option<DateTime<Utc>>,
}

/// Physical timer classes understood by the Runtime scheduler. The timer only
/// owns when an owner should be revisited; semantic completion remains owned by
/// the corresponding Schedule, Objective, Activation, or Execution Job.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeTimerKind {
    Schedule,
    ObjectiveWait,
    ObjectiveLease,
    BackgroundWake,
    ActivationLease,
    DeliveryFlush,
}

impl RuntimeTimerKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Schedule => "schedule",
            Self::ObjectiveWait => "objective_wait",
            Self::ObjectiveLease => "objective_lease",
            Self::BackgroundWake => "background_wake",
            Self::ActivationLease => "activation_lease",
            Self::DeliveryFlush => "delivery_flush",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeTimerStatus {
    Pending,
    Claimed,
    Fired,
    Cancelled,
}

impl RuntimeTimerStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Claimed => "claimed",
            Self::Fired => "fired",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RuntimeTimerRecord {
    pub id: String,
    pub generation: u64,
    pub kind: RuntimeTimerKind,
    pub owner_id: String,
    pub due_at: DateTime<Utc>,
    pub status: RuntimeTimerStatus,
    pub payload: serde_json::Value,
    pub claimed_by: Option<String>,
    pub claim_expires_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub fired_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub struct NewRuntimeTimer {
    pub id: String,
    pub generation: u64,
    pub kind: RuntimeTimerKind,
    pub owner_id: String,
    pub due_at: DateTime<Utc>,
    pub payload: serde_json::Value,
}

/// Stable logical destination for physical tools. A Target is not a Worker or
/// a live network connection: it survives process replacement and may be
/// provided by an in-process executor, an Edge Node or a managed route.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionTargetKind {
    InProcessLocal,
    EdgeNode,
    ManagedSsh,
    ManagedCloudWorker,
}

impl ExecutionTargetKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InProcessLocal => "in_process_local",
            Self::EdgeNode => "edge_node",
            Self::ManagedSsh => "managed_ssh",
            Self::ManagedCloudWorker => "managed_cloud_worker",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "in_process_local" => Some(Self::InProcessLocal),
            "edge_node" => Some(Self::EdgeNode),
            "managed_ssh" => Some(Self::ManagedSsh),
            "managed_cloud_worker" => Some(Self::ManagedCloudWorker),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionTargetStatus {
    Online,
    Offline,
    Disabled,
}

impl ExecutionTargetStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Online => "online",
            Self::Offline => "offline",
            Self::Disabled => "disabled",
        }
    }

    pub fn accepts_jobs(self) -> bool {
        self == Self::Online
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "online" => Some(Self::Online),
            "offline" => Some(Self::Offline),
            "disabled" => Some(Self::Disabled),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutionTargetRecord {
    pub id: String,
    pub revision: u64,
    pub owner_principal_id: Option<String>,
    pub provider_node_id: Option<String>,
    pub kind: ExecutionTargetKind,
    pub name: String,
    pub status: ExecutionTargetStatus,
    pub platform: Option<String>,
    pub workspace_root: Option<String>,
    pub capabilities: Vec<String>,
    pub metadata: serde_json::Value,
    pub policy_digest: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub last_seen_at: Option<DateTime<Utc>>,
}

/// Registration/heartbeat projection supplied by the authoritative Target
/// provider. Credential material is forbidden from `metadata`; only opaque
/// local references may be published by future remote backends.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutionTargetRegistration {
    pub id: String,
    pub owner_principal_id: Option<String>,
    pub provider_node_id: Option<String>,
    pub kind: ExecutionTargetKind,
    pub name: String,
    pub status: ExecutionTargetStatus,
    pub platform: Option<String>,
    pub workspace_root: Option<String>,
    pub capabilities: Vec<String>,
    pub metadata: serde_json::Value,
    pub policy_digest: String,
    pub last_seen_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionTargetFilter {
    pub owner_principal_id: Option<String>,
    pub owner_principal_is_null: bool,
    /// Includes unowned shared Targets as well as those owned by this
    /// Principal. This is distinct from the exact owner filter above.
    pub visible_to_principal_id: Option<String>,
    pub provider_node_id: Option<String>,
    pub provider_node_is_null: bool,
    pub kind: Option<ExecutionTargetKind>,
    pub status: Option<ExecutionTargetStatus>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ExecutionTargetMutation {
    Updated(ExecutionTargetRecord),
    Conflict { current: ExecutionTargetRecord },
    NotFound,
}

/// Optional narrowing layer below Principal ownership. A Target without any
/// authorization history remains available to its owner. Once the first
/// scoped authorization is created, only matching active scopes may use it;
/// revoking the last authorization therefore closes the Target instead of
/// accidentally restoring owner-wide access.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionTargetAuthorizationScope {
    Agent,
    Context,
    Thread,
}

impl ExecutionTargetAuthorizationScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Context => "context",
            Self::Thread => "thread",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "agent" => Some(Self::Agent),
            "context" => Some(Self::Context),
            "thread" => Some(Self::Thread),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionTargetAuthorizationStatus {
    Active,
    Revoked,
}

impl ExecutionTargetAuthorizationStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Revoked => "revoked",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "active" => Some(Self::Active),
            "revoked" => Some(Self::Revoked),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutionTargetAuthorizationRecord {
    pub id: String,
    pub revision: u64,
    pub target_id: String,
    pub owner_principal_id: String,
    pub scope: ExecutionTargetAuthorizationScope,
    pub scope_id: String,
    pub status: ExecutionTargetAuthorizationStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub revoke_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewExecutionTargetAuthorization {
    pub id: String,
    pub target_id: String,
    pub owner_principal_id: String,
    pub scope: ExecutionTargetAuthorizationScope,
    pub scope_id: String,
}

#[derive(Debug, Clone, Default)]
pub struct ExecutionTargetAuthorizationFilter {
    pub target_id: Option<String>,
    pub owner_principal_id: Option<String>,
    pub scope: Option<ExecutionTargetAuthorizationScope>,
    pub scope_id: Option<String>,
    pub active_only: bool,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ExecutionTargetAuthorizationMutation {
    Created(ExecutionTargetAuthorizationRecord),
    Existing(ExecutionTargetAuthorizationRecord),
    Updated(ExecutionTargetAuthorizationRecord),
    Conflict {
        current: ExecutionTargetAuthorizationRecord,
    },
    NotFound,
}

/// Durable registry for stable physical destinations. Registration is an
/// idempotent descriptor/heartbeat projection; it never carries credentials.
#[async_trait::async_trait]
pub trait ExecutionTargetStore: Send + Sync {
    async fn register_execution_target(
        &self,
        registration: ExecutionTargetRegistration,
    ) -> Result<ExecutionTargetRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_execution_target(
        &self,
        id: &str,
    ) -> Result<Option<ExecutionTargetRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_execution_targets(
        &self,
        filter: ExecutionTargetFilter,
    ) -> Result<Vec<ExecutionTargetRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Revision-fenced administrative state transition. Heartbeats use
    /// registration; disabling a target must not be undone by a stale Node.
    async fn set_execution_target_status(
        &self,
        id: &str,
        expected_revision: u64,
        status: ExecutionTargetStatus,
    ) -> Result<ExecutionTargetMutation, Box<dyn std::error::Error + Send + Sync>>;
}

#[async_trait::async_trait]
pub trait ExecutionTargetAuthorizationStore: Send + Sync {
    async fn authorize_execution_target(
        &self,
        authorization: NewExecutionTargetAuthorization,
    ) -> Result<ExecutionTargetAuthorizationMutation, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_execution_target_authorization(
        &self,
        id: &str,
    ) -> Result<Option<ExecutionTargetAuthorizationRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_execution_target_authorizations(
        &self,
        filter: ExecutionTargetAuthorizationFilter,
    ) -> Result<Vec<ExecutionTargetAuthorizationRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Performs the physical-boundary authorization decision without
    /// materializing an arbitrarily bounded grant list. Any one of the exact
    /// Agent, Context or Thread scopes is sufficient.
    async fn has_active_execution_target_authorization(
        &self,
        target_id: &str,
        owner_principal_id: &str,
        agent_id: &str,
        context_id: &str,
        thread_id: &str,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>>;
    async fn revoke_execution_target_authorization(
        &self,
        id: &str,
        expected_revision: u64,
        reason: &str,
    ) -> Result<ExecutionTargetAuthorizationMutation, Box<dyn std::error::Error + Send + Sync>>;
    /// True after the Target has ever entered scoped mode, including when all
    /// grants are now revoked.
    async fn has_execution_target_authorization_history(
        &self,
        target_id: &str,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>>;
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionNodeStatus {
    Online,
    Offline,
    Revoked,
}

impl ExecutionNodeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Online => "online",
            Self::Offline => "offline",
            Self::Revoked => "revoked",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "online" => Some(Self::Online),
            "offline" => Some(Self::Offline),
            "revoked" => Some(Self::Revoked),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutionNodeRecord {
    pub id: String,
    pub revision: u64,
    pub owner_principal_id: String,
    pub name: String,
    pub status: ExecutionNodeStatus,
    pub device_key_fingerprint: String,
    /// Hex-encoded Ed25519 public key. This is an identity verifier, never a
    /// secret or an authorization bearer credential.
    pub device_public_key: String,
    pub protocol_version: u32,
    pub platform: Option<String>,
    pub capabilities: Vec<String>,
    pub metadata: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub last_seen_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ExecutionNodeMutation {
    Updated(ExecutionNodeRecord),
    Conflict { current: ExecutionNodeRecord },
    NotFound,
}

#[derive(Debug, Clone)]
pub struct NewNodePairingCode {
    pub code_hash: String,
    pub owner_principal_id: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodePairingCodeErrorKind {
    Invalid,
    Used,
    Expired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NodePairingCodeError {
    pub kind: NodePairingCodeErrorKind,
}

impl NodePairingCodeError {
    pub const fn new(kind: NodePairingCodeErrorKind) -> Self {
        Self { kind }
    }
}

impl std::fmt::Display for NodePairingCodeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self.kind {
            NodePairingCodeErrorKind::Invalid => "Node pairing code 无效",
            NodePairingCodeErrorKind::Used => "Node pairing code 已使用",
            NodePairingCodeErrorKind::Expired => "Node pairing code 已过期",
        })
    }
}

impl std::error::Error for NodePairingCodeError {}

pub(crate) fn is_transient_storage_contention(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut current = Some(error);
    while let Some(error) = current {
        let message = error.to_string().to_ascii_lowercase();
        if message.contains("database is locked")
            || message.contains("database table is locked")
            || message.contains("sqlite_busy")
            || message.contains("sqlite_locked")
            || message.contains("(code: 5)")
            || message.contains("(code: 6)")
        {
            return true;
        }
        current = error.source();
    }
    false
}

#[derive(Debug, Clone)]
pub struct PairExecutionNode {
    pub code_hash: String,
    pub node_id: String,
    pub name: String,
    pub device_key_fingerprint: String,
    pub device_public_key: String,
    pub protocol_version: u32,
    pub platform: Option<String>,
    pub capabilities: Vec<String>,
    pub metadata: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct NewExecutionNodeChallenge {
    pub id: String,
    pub node_id: String,
    pub nonce_hash: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum EdgeCommandStatus {
    Queued,
    Claimed,
    Succeeded,
    Failed,
    CancelRequested,
    Cancelled,
    Lost,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum EdgeOutputStream {
    Stdout,
    Stderr,
}

impl EdgeOutputStream {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "stdout" => Some(Self::Stdout),
            "stderr" => Some(Self::Stderr),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EdgeCommandOutputChunk {
    pub job_id: String,
    pub sequence: u64,
    pub stream: EdgeOutputStream,
    pub text: String,
    pub created_at: DateTime<Utc>,
}

impl EdgeCommandStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Claimed => "claimed",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::CancelRequested => "cancel_requested",
            Self::Cancelled => "cancelled",
            Self::Lost => "lost",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "queued" => Some(Self::Queued),
            "claimed" => Some(Self::Claimed),
            "succeeded" => Some(Self::Succeeded),
            "failed" => Some(Self::Failed),
            "cancel_requested" => Some(Self::CancelRequested),
            "cancelled" => Some(Self::Cancelled),
            "lost" => Some(Self::Lost),
            _ => None,
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Cancelled | Self::Lost
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EdgeCommandRecord {
    pub job_id: String,
    pub revision: u64,
    pub target_id: String,
    pub provider_node_id: String,
    pub tool_name: String,
    pub arguments: String,
    /// Frozen Execution Route copied from the parent Job. The Edge Node uses
    /// this authority to distinguish a local Target from a Proxy Target; it
    /// must never re-resolve the route from a later heartbeat.
    pub route: serde_json::Value,
    pub status: EdgeCommandStatus,
    pub claimed_by: Option<String>,
    pub claim_token: Option<String>,
    pub lease_expires_at: Option<DateTime<Utc>>,
    pub heartbeat_at: Option<DateTime<Utc>>,
    pub side_effect_started_at: Option<DateTime<Utc>>,
    pub progress: Option<String>,
    pub output: Option<String>,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub struct NewEdgeCommand {
    pub job_id: String,
    pub target_id: String,
    pub provider_node_id: String,
    pub tool_name: String,
    pub arguments: String,
    pub route: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum EdgeCommandMutation {
    Updated(EdgeCommandRecord),
    Conflict { current: EdgeCommandRecord },
    NotFound,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct EdgeReconciliationReport {
    pub nodes_marked_offline: u64,
    pub targets_marked_offline: u64,
    pub commands_requeued: u64,
    pub commands_marked_lost: u64,
}

/// Durable authority for the outbound Edge protocol. Pairing codes and signed
/// challenges are one-shot, short-lived connection credentials are stored
/// only as hashes, and every command transition is fenced by revision plus
/// claim token.
#[async_trait::async_trait]
pub trait EdgeExecutionStore: Send + Sync {
    async fn create_node_pairing_code(
        &self,
        pairing: NewNodePairingCode,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;
    async fn pair_execution_node(
        &self,
        request: PairExecutionNode,
    ) -> Result<ExecutionNodeRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn create_execution_node_challenge(
        &self,
        challenge: NewExecutionNodeChallenge,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;
    async fn consume_execution_node_challenge(
        &self,
        node_id: &str,
        challenge_id: &str,
        nonce_hash: &str,
    ) -> Result<Option<ExecutionNodeRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn issue_execution_node_connection_token(
        &self,
        node_id: &str,
        token_hash: &str,
        expires_at: DateTime<Utc>,
    ) -> Result<Option<ExecutionNodeRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn authenticate_execution_node(
        &self,
        node_id: &str,
        device_token_hash: &str,
    ) -> Result<Option<ExecutionNodeRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn heartbeat_execution_node(
        &self,
        node_id: &str,
        platform: Option<String>,
        capabilities: Vec<String>,
        metadata: serde_json::Value,
    ) -> Result<Option<ExecutionNodeRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_execution_nodes(
        &self,
        owner_principal_id: &str,
    ) -> Result<Vec<ExecutionNodeRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn revoke_execution_node(
        &self,
        node_id: &str,
        owner_principal_id: &str,
        expected_revision: u64,
    ) -> Result<Option<ExecutionNodeRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Revision-fenced device-key rotation. Existing connection credentials
    /// are invalidated atomically with the public-key update.
    async fn rotate_execution_node_key(
        &self,
        node_id: &str,
        expected_revision: u64,
        device_key_fingerprint: &str,
        device_public_key: &str,
    ) -> Result<ExecutionNodeMutation, Box<dyn std::error::Error + Send + Sync>>;
    async fn create_edge_command(
        &self,
        command: NewEdgeCommand,
    ) -> Result<EdgeCommandRecord, Box<dyn std::error::Error + Send + Sync>>;
    /// Waits for a process-local Edge queue change. Durable stores may use a
    /// database notification for cross-process producers; the default sleep
    /// remains a low-frequency recovery fallback for lightweight stores.
    async fn wait_for_edge_command_change(&self, timeout: std::time::Duration) {
        tokio::time::sleep(timeout).await;
    }
    async fn get_edge_command(
        &self,
        job_id: &str,
    ) -> Result<Option<EdgeCommandRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn claim_edge_command(
        &self,
        provider_node_id: &str,
        worker_id: &str,
        claim_token: &str,
        lease_expires_at: DateTime<Utc>,
        max_in_flight: usize,
    ) -> Result<Option<EdgeCommandRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn heartbeat_edge_command(
        &self,
        job_id: &str,
        expected_revision: u64,
        claim_token: &str,
        lease_expires_at: DateTime<Utc>,
        side_effect_started: bool,
        progress: Option<String>,
    ) -> Result<EdgeCommandMutation, Box<dyn std::error::Error + Send + Sync>>;
    /// Append one immutable output chunk under the active claim token. Output
    /// does not mutate Command revision, so heartbeat and pipe transport can
    /// proceed concurrently; claim-token fencing still rejects stale Workers.
    async fn append_edge_command_output(
        &self,
        job_id: &str,
        claim_token: &str,
        stream: EdgeOutputStream,
        text: &str,
    ) -> Result<EdgeCommandOutputChunk, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_edge_command_output(
        &self,
        job_id: &str,
        after_sequence: u64,
        limit: usize,
    ) -> Result<Vec<EdgeCommandOutputChunk>, Box<dyn std::error::Error + Send + Sync>>;
    async fn finish_edge_command(
        &self,
        job_id: &str,
        expected_revision: u64,
        claim_token: &str,
        status: EdgeCommandStatus,
        output: Option<String>,
        error: Option<String>,
    ) -> Result<EdgeCommandMutation, Box<dyn std::error::Error + Send + Sync>>;
    async fn request_edge_command_cancel(
        &self,
        job_id: &str,
    ) -> Result<Option<EdgeCommandRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn reconcile_edge_execution(
        &self,
        now: DateTime<Utc>,
        node_stale_before: DateTime<Utc>,
    ) -> Result<EdgeReconciliationReport, Box<dyn std::error::Error + Send + Sync>>;
}

/// Authoritative lifecycle of one physical execution attempt materialized from
/// a model Action. Cancellation is requested separately: a running process is
/// not `cancelled` until an executor or reconciler proves that it stopped.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionJobStatus {
    Queued,
    WaitingApproval,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Lost,
}

impl ExecutionJobStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::WaitingApproval => "waiting_approval",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Lost => "lost",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Cancelled | Self::Lost
        )
    }
}

/// Recovery policy after the Runtime loses ownership of a running Job.
/// `side_effect_started_at` determines whether the stricter branch applies.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionRetrySafety {
    /// Repeating the action with the same causal identity is safe.
    Idempotent,
    /// The Runtime must inspect external state before deciding to retry.
    ReconcileRequired,
    /// Once a side effect may have started, automatic retry is forbidden.
    AtMostOnce,
}

impl ExecutionRetrySafety {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idempotent => "idempotent",
            Self::ReconcileRequired => "reconcile_required",
            Self::AtMostOnce => "at_most_once",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutionJobRecord {
    pub id: String,
    pub revision: u64,
    pub activation_id: String,
    pub thread_id: String,
    pub agent_id: String,
    pub context_id: String,
    pub session_id: String,
    pub initiating_principal_id: Option<String>,
    /// Immutable physical destination selected before the Job becomes
    /// claimable. Retries and recovery must never silently move the Action.
    pub target_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub request: serde_json::Value,
    pub status: ExecutionJobStatus,
    pub retry_safety: ExecutionRetrySafety,
    pub claimed_by: Option<String>,
    /// Opaque per-claim fencing identity. A stale worker cannot heartbeat or
    /// publish a terminal result after another control-plane mutation wins.
    pub claim_token: Option<String>,
    pub lease_expires_at: Option<DateTime<Utc>>,
    pub heartbeat_at: Option<DateTime<Utc>>,
    pub approval_ref: Option<String>,
    pub side_effect_started_at: Option<DateTime<Utc>>,
    pub cancel_requested_at: Option<DateTime<Utc>>,
    pub cancel_reason: Option<String>,
    pub progress_ref: Option<String>,
    /// Semantic `check_task_after` checkpoint contract. `checkpoint_generation`
    /// is deliberately separate from `revision`: heartbeats, claims and other
    /// unrelated Job mutations bump `revision` but must not arm, validate or
    /// invalidate a checkpoint Timer.
    pub checkpoint_generation: Option<u64>,
    pub checkpoint_due_at: Option<DateTime<Utc>>,
    pub result_event_id: Option<String>,
    /// Durable references to stdout/stderr/artifacts or provider-owned result
    /// objects. Empty output is valid and is represented by an empty vector.
    pub result_refs: Vec<String>,
    pub error: Option<String>,
    pub exit_code: Option<i32>,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

/// Lightweight, nonterminal Execution Job projection for operator/runtime
/// monitoring. Deliberately excludes the request body, result references and
/// worker fencing fields so a monitor refresh cannot deserialize large tool
/// arguments or turn an observability read into an Execution history scan.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutionJobMonitorRecord {
    pub id: String,
    pub activation_id: String,
    pub thread_id: String,
    pub context_id: String,
    pub session_id: String,
    pub target_id: String,
    pub tool_name: String,
    pub status: ExecutionJobStatus,
    pub progress_ref: Option<String>,
    pub error: Option<String>,
    pub updated_at: DateTime<Utc>,
    /// Durable `check_task_after` generation. Independent of Job revision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_generation: Option<u64>,
    /// Due instant for the armed background-task checkpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_due_at: Option<DateTime<Utc>>,
}

impl From<ExecutionJobRecord> for ExecutionJobMonitorRecord {
    fn from(job: ExecutionJobRecord) -> Self {
        Self {
            id: job.id,
            activation_id: job.activation_id,
            thread_id: job.thread_id,
            context_id: job.context_id,
            session_id: job.session_id,
            target_id: job.target_id,
            tool_name: job.tool_name,
            status: job.status,
            progress_ref: job.progress_ref,
            error: job.error,
            updated_at: job.updated_at,
            checkpoint_generation: job.checkpoint_generation,
            checkpoint_due_at: job.checkpoint_due_at,
        }
    }
}

#[derive(Debug, Clone)]
pub struct NewExecutionJob {
    pub id: String,
    pub activation_id: String,
    pub thread_id: String,
    pub agent_id: String,
    pub context_id: String,
    pub session_id: String,
    pub initiating_principal_id: Option<String>,
    pub target_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub request: serde_json::Value,
    pub retry_safety: ExecutionRetrySafety,
    pub requires_approval: bool,
}

/// One direct SDK/HTTP Artifact Transfer materialized as the same durable
/// scheduler graph used by model-originated physical work. The Store commits
/// all four authorities together so a crash cannot leave an Event without a
/// runnable Job, or a Job without its stable Thread/Activation identity.
#[derive(Debug, Clone)]
pub struct NewArtifactTransferExecution {
    pub request_event: crate::event::Event,
    pub thread: NewThread,
    pub activation: NewThreadActivation,
    pub job: NewExecutionJob,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ArtifactTransferExecutionRecord {
    pub request_event_sequence: u64,
    pub thread: ThreadRecord,
    pub activation: ThreadActivationRecord,
    pub job: ExecutionJobRecord,
}

/// Durable lifecycle of one Runtime-owned Yao plan.
///
/// A Plan Execution owns only deterministic control state. Reality-facing
/// work remains an [`ExecutionJobRecord`], and model-owned work remains a
/// Thread Activation. `Waiting` therefore always carries a typed child
/// reference rather than hiding an in-process Future.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum PlanExecutionStatus {
    Queued,
    Running,
    Waiting,
    Succeeded,
    Failed,
    Cancelled,
}

impl PlanExecutionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Waiting => "waiting",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

/// Kernel primitive which must settle before a suspended plan can continue.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum PlanExecutionWaitKind {
    ExecutionJob,
    ActionGroup,
    Evaluation,
    PlanExecution,
}

impl PlanExecutionWaitKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ExecutionJob => "execution_job",
            Self::ActionGroup => "action_group",
            Self::Evaluation => "evaluation",
            Self::PlanExecution => "plan_execution",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlanExecutionRecord {
    pub id: String,
    pub revision: u64,
    pub activation_id: String,
    pub thread_id: String,
    pub agent_id: String,
    pub context_id: String,
    pub session_id: String,
    pub initiating_principal_id: Option<String>,
    /// Stable causal identity of the outer `eval` Function Call.
    pub tool_call_id: String,
    pub objective_id: Option<String>,
    pub objective_evaluation_id: Option<String>,
    pub harness_id: Option<String>,
    pub harness_version: Option<String>,
    pub source_artifact_hash: String,
    pub ir_schema_version: u32,
    /// Validated [`crate::sexpr_eval::Program`] encoded as JSON.
    pub program_json: JsonValue,
    /// Serializable VM stack, bindings and current result.
    pub state_json: JsonValue,
    /// Language/profile budgets as they stood at the latest durable boundary.
    pub budget_json: JsonValue,
    pub status: PlanExecutionStatus,
    pub pending_kind: Option<PlanExecutionWaitKind>,
    pub pending_id: Option<String>,
    pub claimed_by: Option<String>,
    /// Opaque per-claim fence. Revision alone is not sufficient when a stale
    /// worker retained the same in-memory record across a recovery race.
    pub claim_token: Option<String>,
    pub lease_expires_at: Option<DateTime<Utc>>,
    pub result_json: Option<JsonValue>,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub struct NewPlanExecution {
    pub id: String,
    pub activation_id: String,
    pub thread_id: String,
    pub agent_id: String,
    pub context_id: String,
    pub session_id: String,
    pub initiating_principal_id: Option<String>,
    pub tool_call_id: String,
    pub objective_id: Option<String>,
    pub objective_evaluation_id: Option<String>,
    pub harness_id: Option<String>,
    pub harness_version: Option<String>,
    pub source_artifact_hash: String,
    pub ir_schema_version: u32,
    pub program_json: JsonValue,
    pub state_json: JsonValue,
    pub budget_json: JsonValue,
}

#[derive(Debug, Clone, Default)]
pub struct PlanExecutionFilter {
    pub context_id: Option<String>,
    pub session_id: Option<String>,
    pub activation_id: Option<String>,
    pub tool_call_id: Option<String>,
    pub objective_id: Option<String>,
    pub objective_evaluation_id: Option<String>,
    pub harness_id: Option<String>,
    pub harness_version: Option<String>,
    pub source_artifact_hash: Option<String>,
    pub status: Option<PlanExecutionStatus>,
    pub pending_kind: Option<PlanExecutionWaitKind>,
    pub lease_expires_at_or_before: Option<DateTime<Utc>>,
    pub include_terminal: bool,
    /// Keyset scans use oldest-first order so a permanently waiting prefix
    /// cannot starve later durable completions.
    pub oldest_first: bool,
    pub after_updated_at: Option<DateTime<Utc>>,
    pub after_id: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PlanExecutionMutation {
    Updated(PlanExecutionRecord),
    Existing(PlanExecutionRecord),
    Conflict {
        current: PlanExecutionRecord,
    },
    Rejected {
        current: Option<PlanExecutionRecord>,
        reason: String,
    },
    NotFound,
}

/// Atomic hand-off from deterministic Plan control to one physical Kernel Job.
///
/// Both rows become visible in the same database transaction. `existing`
/// means the exact causal hand-off had already committed before the caller
/// lost its response; callers may reconnect to `execution_job` instead of
/// materializing another physical action.
#[derive(Debug, Clone, PartialEq)]
pub struct PlanExecutionJobCommit {
    pub plan: PlanExecutionRecord,
    pub execution_job: ExecutionJobRecord,
    pub existing: bool,
}

/// Atomic hand-off from deterministic Plan control to one model-owned child
/// Evaluation.
///
/// The immutable request Event and its Signal Outbox entry are committed in
/// the same transaction that releases the Plan into
/// `waiting(evaluation, activation_id)`.  Thread/Activation materialization is
/// deliberately left to the ordinary Scheduler router: the Outbox is the
/// durable bridge across a crash between this commit and dispatch.
#[derive(Debug, Clone)]
pub struct PlanEvaluationCommit {
    pub plan: PlanExecutionRecord,
    pub request_event: crate::event::Event,
    pub activation_id: String,
    pub existing: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ExecutionJobFilter {
    pub context_id: Option<String>,
    pub session_id: Option<String>,
    pub thread_id: Option<String>,
    pub activation_id: Option<String>,
    pub target_id: Option<String>,
    /// Exact physical tool identity.  Recovery and operator projections must
    /// push this predicate into the Store instead of reading every Job and
    /// filtering the durable history in memory.
    pub tool_name: Option<String>,
    pub status: Option<ExecutionJobStatus>,
    /// When no exact status is selected, terminal rows are omitted by default.
    pub include_terminal: bool,
    /// Read newest rows first so bounded observability/history queries do not
    /// return the oldest records in a long-running Context.
    pub newest_first: bool,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ExecutionJobMutation {
    Updated(ExecutionJobRecord),
    /// Exact replay of an already committed terminal Job/result Event pair.
    Existing(ExecutionJobRecord),
    Conflict {
        current: ExecutionJobRecord,
    },
    Rejected {
        current: ExecutionJobRecord,
        reason: String,
    },
    NotFound,
}

/// Durable result of arming one background-task checkpoint. Callers reconcile
/// process-local supervision state from this registration instead of trusting
/// local counters, so a peer or restarted Runtime cannot diverge from the
/// durable Job/Timer contract.
#[derive(Debug, Clone, PartialEq)]
pub struct ExecutionJobCheckpointRegistration {
    pub job_id: String,
    pub timer_id: String,
    pub checkpoint_generation: u64,
    pub due_at: DateTime<Utc>,
    pub check_after_secs: u64,
    pub wake_source: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionJobTerminal {
    pub status: ExecutionJobStatus,
    pub result_event_id: Option<String>,
    pub result_refs: Vec<String>,
    pub error: Option<String>,
    pub exit_code: Option<i32>,
}

/// Durable coordination state for two or more sibling Actions emitted by one
/// model response. A single Action continues to use its ExecutionJob (when
/// physical) as the authoritative state and does not create a redundant
/// one-member group.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ActionGroupStatus {
    Running,
    Settled,
    Cancelled,
    Lost,
}

impl ActionGroupStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Settled => "settled",
            Self::Cancelled => "cancelled",
            Self::Lost => "lost",
        }
    }

    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::Running)
    }
}

/// A Group member remains pending until its immutable ToolResult Event is
/// committed. Physical running/approval detail remains authoritative on the
/// associated ExecutionJob and is joined at read time instead of duplicated.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ActionGroupMemberStatus {
    Pending,
    Succeeded,
    Failed,
    Cancelled,
    Lost,
    Skipped,
}

impl ActionGroupMemberStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Lost => "lost",
            Self::Skipped => "skipped",
        }
    }

    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::Pending)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActionGroupRecord {
    pub id: String,
    pub revision: u64,
    pub activation_id: String,
    pub thread_id: String,
    pub agent_id: String,
    pub context_id: String,
    pub session_id: String,
    pub assistant_call_event_id: String,
    pub objective_id: Option<String>,
    pub objective_evaluation_id: Option<String>,
    pub objective_revision: Option<u64>,
    pub status: ActionGroupStatus,
    pub member_count: u64,
    pub terminal_member_count: u64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub settled_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub struct NewActionGroup {
    pub id: String,
    pub activation_id: String,
    pub thread_id: String,
    pub agent_id: String,
    pub context_id: String,
    pub session_id: String,
    pub assistant_call_event_id: String,
    pub objective_id: Option<String>,
    pub objective_evaluation_id: Option<String>,
    pub objective_revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActionGroupMemberRecord {
    pub group_id: String,
    pub ordinal: u64,
    pub tool_call_id: String,
    pub tool_name: String,
    pub execution_job_id: Option<String>,
    pub status: ActionGroupMemberStatus,
    pub result_event_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct NewActionGroupMember {
    pub ordinal: u64,
    pub tool_call_id: String,
    pub tool_name: String,
    pub execution_job_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ActionGroupFilter {
    pub context_id: Option<String>,
    pub session_id: Option<String>,
    pub activation_id: Option<String>,
    pub status: Option<ActionGroupStatus>,
    pub include_terminal: bool,
    pub newest_first: bool,
    /// Exclusive keyset cursor in the same direction as `newest_first`.
    /// Recovery callers must advance this cursor instead of repeatedly
    /// rescanning every live Group or using an unstable OFFSET.
    pub after_created_at: Option<DateTime<Utc>>,
    pub after_id: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ActionGroupMemberCommit {
    pub group: ActionGroupRecord,
    pub member: ActionGroupMemberRecord,
    /// True only for the transaction which moved the final pending member to
    /// terminal and atomically appended the Group-settled Event + Outbox.
    pub settled_now: bool,
    /// Exact replay of an already committed member/result pair.
    pub existing: bool,
}

/// Completion policy for sibling Threads spawned by one Evaluation decision.
///
/// This is intentionally different from `ActionGroup`: an ActionGroup joins
/// tool calls from one model response, while a ThreadGroup joins independently
/// scheduled causal Threads which may contain many Activations and Attempts.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ThreadGroupPolicy {
    All,
    Any,
}

impl ThreadGroupPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Any => "any",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ThreadGroupStatus {
    Open,
    Satisfied,
    Failed,
    Cancelled,
}

impl ThreadGroupStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Satisfied => "satisfied",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::Open)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ThreadGroupContractEvaluation {
    pub status: ThreadGroupStatus,
    pub contract_results: JsonValue,
}

/// Evaluates the Runtime-owned, count-based part of a Thread Group contract.
///
/// A member only contributes to `successful_count` after its own Thread
/// completion contract has passed. The Group contract therefore composes
/// verified Thread outcomes instead of reinterpreting chat text.
pub fn evaluate_thread_group_contract(
    policy: ThreadGroupPolicy,
    required_count: u64,
    terminal_count: u64,
    successful_count: u64,
    contract: &JsonValue,
) -> ThreadGroupContractEvaluation {
    let object = contract.as_object();
    let default_minimum = match policy {
        ThreadGroupPolicy::All => required_count,
        ThreadGroupPolicy::Any => u64::from(required_count > 0),
    };
    let minimum_successful = object
        .and_then(|value| value.get("minimum_successful_members"))
        .and_then(JsonValue::as_u64)
        .unwrap_or(default_minimum);
    let default_maximum_failed = required_count.saturating_sub(minimum_successful);
    let maximum_failed = object
        .and_then(|value| value.get("maximum_failed_members"))
        .and_then(JsonValue::as_u64)
        .unwrap_or(default_maximum_failed);
    let failed_count = terminal_count.saturating_sub(successful_count);
    let pending_count = required_count.saturating_sub(terminal_count);
    let success_reachable = successful_count.saturating_add(pending_count) >= minimum_successful;
    let success_threshold_met = successful_count >= minimum_successful;
    let failure_budget_met = failed_count <= maximum_failed;
    let policy_ready = match policy {
        ThreadGroupPolicy::All => terminal_count >= required_count,
        ThreadGroupPolicy::Any => success_threshold_met,
    };
    let status = if !failure_budget_met || !success_reachable {
        ThreadGroupStatus::Failed
    } else if policy_ready && success_threshold_met {
        ThreadGroupStatus::Satisfied
    } else if terminal_count >= required_count {
        ThreadGroupStatus::Failed
    } else {
        ThreadGroupStatus::Open
    };
    ThreadGroupContractEvaluation {
        status,
        contract_results: serde_json::json!({
            "passed": status == ThreadGroupStatus::Satisfied,
            "minimum_successful_members": minimum_successful,
            "maximum_failed_members": maximum_failed,
            "successful_members": successful_count,
            "failed_members": failed_count,
            "pending_members": pending_count,
            "success_reachable": success_reachable,
            "success_threshold_met": success_threshold_met,
            "failure_budget_met": failure_budget_met,
        }),
    }
}

#[cfg(test)]
mod supervised_concurrency_contract_tests {
    use super::*;

    #[test]
    fn any_group_can_require_more_than_one_verified_success() {
        let contract = serde_json::json!({
            "minimum_successful_members": 2,
            "maximum_failed_members": 1
        });
        let open = evaluate_thread_group_contract(ThreadGroupPolicy::Any, 3, 1, 1, &contract);
        assert_eq!(open.status, ThreadGroupStatus::Open);

        let satisfied = evaluate_thread_group_contract(ThreadGroupPolicy::Any, 3, 2, 2, &contract);
        assert_eq!(satisfied.status, ThreadGroupStatus::Satisfied);
    }

    #[test]
    fn group_fails_when_verified_success_is_no_longer_reachable() {
        let contract = serde_json::json!({
            "minimum_successful_members": 2
        });
        let failed = evaluate_thread_group_contract(ThreadGroupPolicy::Any, 3, 2, 0, &contract);
        assert_eq!(failed.status, ThreadGroupStatus::Failed);
        assert_eq!(
            failed.contract_results["success_reachable"],
            JsonValue::Bool(false)
        );
    }

    #[test]
    fn thread_contract_turns_unverified_completion_into_failure() {
        let evaluated = evaluate_thread_completion_contract(
            &serde_json::json!({
                "require_summary": true,
                "min_artifacts": 1,
                "required_checks": ["tests"]
            }),
            ThreadLifecycle::Completed,
            Some("implemented"),
            &[],
            &[JsonValue::String("event-1".to_string())],
            &serde_json::json!({"tests": false}),
            &[],
        );
        assert!(!evaluated.passed);
        assert!(evaluated
            .unresolved_failures
            .iter()
            .any(|failure| failure == "completion_contract:artifacts=0<1"));
        assert!(evaluated
            .unresolved_failures
            .iter()
            .any(|failure| failure == "completion_contract:check_failed:tests"));
    }

    #[test]
    fn message_request_fingerprint_binds_intent_but_not_storage_location() {
        let payload = |principal: &str, text: &str, storage_path: &str| {
            serde_json::json!({
                "principal_id": principal,
                "text": text,
                "attachments": [{
                    "name": "diagram.png",
                    "media_type": "image/png",
                    "sha256": "abc123",
                    "size_bytes": 42,
                    "storage_path": storage_path
                }],
                "requested_harness_id": "coding",
                "requested_harness_version": "1",
                "requested_harness_artifact_hash": "harness-sha"
            })
            .as_object()
            .unwrap()
            .clone()
        };
        let base =
            message_request_fingerprint(&payload("principal:a", "hello", "/node-a/blob")).unwrap();
        assert_eq!(
            base,
            message_request_fingerprint(&payload("principal:a", "hello", "/node-b/blob")).unwrap(),
            "physical storage paths are deployment details, not request intent"
        );
        assert_ne!(
            base,
            message_request_fingerprint(&payload("principal:b", "hello", "/node-a/blob")).unwrap()
        );
        assert_ne!(
            base,
            message_request_fingerprint(&payload("principal:a", "different", "/node-a/blob"))
                .unwrap()
        );
        let mut different_harness = payload("principal:a", "hello", "/node-a/blob");
        different_harness.insert(
            "requested_harness_artifact_hash".to_string(),
            serde_json::json!("other-harness-sha"),
        );
        assert_ne!(
            base,
            message_request_fingerprint(&different_harness).unwrap()
        );
        let mut with_reference = payload("principal:a", "hello", "/node-a/blob");
        with_reference.insert(
            "references".to_string(),
            serde_json::json!([{
                "kind": "session",
                "session_id": "session-target",
                "title": "Old title",
                "context_id": "context-target",
                "agent_id": "agent-a"
            }]),
        );
        let reference_fingerprint = message_request_fingerprint(&with_reference).unwrap();
        assert_ne!(base, reference_fingerprint);
        with_reference["references"][0]["title"] = serde_json::json!("Renamed");
        assert_eq!(
            reference_fingerprint,
            message_request_fingerprint(&with_reference).unwrap(),
            "display title snapshots do not replace stable Session identity"
        );
        with_reference["references"][0]["session_id"] = serde_json::json!("session-other");
        assert_ne!(
            reference_fingerprint,
            message_request_fingerprint(&with_reference).unwrap()
        );
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ThreadGroupMemberStatus {
    Pending,
    Completed,
    Failed,
    Cancelled,
}

impl ThreadGroupMemberStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::Pending)
    }

    pub fn is_success(self) -> bool {
        matches!(self, Self::Completed)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ThreadGroupRecord {
    pub id: String,
    pub revision: u64,
    pub context_id: String,
    pub session_id: String,
    pub supervisor_kind: ThreadSupervisorKind,
    pub supervisor_id: String,
    pub generation: u64,
    pub policy: ThreadGroupPolicy,
    pub required_count: u64,
    pub terminal_count: u64,
    pub successful_count: u64,
    pub status: ThreadGroupStatus,
    pub completion_contract: JsonValue,
    pub terminal_summary: JsonValue,
    pub barrier_event_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub satisfied_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub struct NewThreadGroup {
    pub id: String,
    pub context_id: String,
    pub session_id: String,
    pub supervisor_kind: ThreadSupervisorKind,
    pub supervisor_id: String,
    pub generation: u64,
    pub policy: ThreadGroupPolicy,
    pub completion_contract: JsonValue,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ThreadGroupMemberRecord {
    pub group_id: String,
    pub thread_id: String,
    pub ordinal: u64,
    pub required: bool,
    pub status: ThreadGroupMemberStatus,
    pub outcome_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct NewThreadGroupMember {
    pub thread_id: String,
    pub ordinal: u64,
    pub required: bool,
}

#[derive(Debug, Clone)]
pub struct NewThreadGroupPlan {
    pub group: NewThreadGroup,
    pub members: Vec<NewThreadGroupMember>,
}

#[derive(Debug, Clone, Default)]
pub struct ThreadGroupFilter {
    pub context_id: Option<String>,
    pub session_id: Option<String>,
    pub supervisor_kind: Option<ThreadSupervisorKind>,
    pub supervisor_id: Option<String>,
    pub status: Option<ThreadGroupStatus>,
    pub include_terminal: bool,
    pub newest_first: bool,
    pub limit: Option<usize>,
}

/// Durable, structured result of one causal Thread.
///
/// Human-readable text remains optional; supervisors consume the typed
/// terminal state and references instead of scraping chat prose.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ThreadOutcomeRecord {
    pub id: String,
    pub thread_id: String,
    pub thread_generation: u64,
    pub root_turn_id: String,
    pub activation_id: String,
    pub session_id: String,
    pub terminal_kind: ThreadLifecycle,
    pub disposition: String,
    pub summary: Option<String>,
    pub result_event_id: String,
    pub artifact_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub check_results: JsonValue,
    pub unresolved_failures: Vec<String>,
    pub terminal_event_sequence: Option<u64>,
    pub created_at: DateTime<Utc>,
    pub delivered_at: Option<DateTime<Utc>>,
}

/// Reconstructs the one generation-fenced wake Event represented by a
/// terminal Thread Group projection.
///
/// This is deliberately pure and shared by normal terminal commits and
/// recovery. A Reconciler must never invent a second payload for the same
/// deterministic Event id.
pub fn thread_group_barrier_event(
    group: &ThreadGroupRecord,
    parent: Option<&ThreadRecord>,
) -> Result<crate::event::Event, String> {
    if !group.status.is_terminal() {
        return Err(format!("Thread Group '{}' is not terminal", group.id));
    }
    let event_id = format!("thread_group_barrier_{}_g{}", group.id, group.generation);
    let mut payload = serde_json::Map::new();
    payload.insert(
        "context_id".to_string(),
        JsonValue::String(group.context_id.clone()),
    );
    payload.insert(
        "thread_group_id".to_string(),
        JsonValue::String(group.id.clone()),
    );
    payload.insert(
        "thread_group_status".to_string(),
        JsonValue::String(group.status.as_str().to_string()),
    );
    payload.insert(
        "wake_policy".to_string(),
        JsonValue::String("direct_signal".to_string()),
    );
    payload.insert(
        "terminal_summary".to_string(),
        group.terminal_summary.clone(),
    );
    let (topic, event_type) = match group.supervisor_kind {
        ThreadSupervisorKind::Thread | ThreadSupervisorKind::Evaluation => {
            let parent = parent.ok_or_else(|| {
                format!(
                    "attached Thread Group '{}' is missing its parent Thread projection",
                    group.id
                )
            })?;
            payload.insert(
                "session_id".to_string(),
                JsonValue::String(parent.session_id.clone()),
            );
            payload.insert(
                "thread_id".to_string(),
                JsonValue::String(parent.id.clone()),
            );
            payload.insert(
                "root_turn_id".to_string(),
                JsonValue::String(parent.root_turn_id.clone()),
            );
            payload.insert(
                "tool_name".to_string(),
                JsonValue::String("thread_group".to_string()),
            );
            payload.insert(
                "tool_status".to_string(),
                JsonValue::String(
                    if group.status == ThreadGroupStatus::Satisfied {
                        "success"
                    } else {
                        "error"
                    }
                    .to_string(),
                ),
            );
            payload.insert(
                "text".to_string(),
                JsonValue::String(format!(
                    "Thread Group '{}' is terminal: {} ({}/{} succeeded)",
                    group.id,
                    group.status.as_str(),
                    group.successful_count,
                    group.required_count
                )),
            );
            (
                "chat/thread_group_terminal".to_string(),
                crate::event::TYPE_TOOL_OUTPUT.to_string(),
            )
        }
        ThreadSupervisorKind::Objective => {
            payload.insert(
                "session_id".to_string(),
                JsonValue::String(group.session_id.clone()),
            );
            payload.insert(
                "objective_id".to_string(),
                JsonValue::String(group.supervisor_id.clone()),
            );
            payload.insert(
                "correlation_id".to_string(),
                JsonValue::String(group.id.clone()),
            );
            (
                "runtime/thread_group_terminal".to_string(),
                "runtime_control".to_string(),
            )
        }
        ThreadSupervisorKind::Runtime => {
            payload.insert(
                "session_id".to_string(),
                JsonValue::String(group.session_id.clone()),
            );
            payload.insert(
                "runtime_supervisor_id".to_string(),
                JsonValue::String(group.supervisor_id.clone()),
            );
            (
                "runtime/thread_group_terminal".to_string(),
                "runtime_control".to_string(),
            )
        }
        ThreadSupervisorKind::None | ThreadSupervisorKind::Legacy => {
            return Err(format!(
                "Thread Group '{}' cannot be finalized by a {:?} supervisor",
                group.id, group.supervisor_kind
            ));
        }
    };
    let mut event =
        crate::event::Event::new(event_id, "Runtime".to_string(), event_type, topic, payload);
    // The barrier is a deterministic projection of the terminal Group. A
    // retried Kernel command must therefore reproduce the exact same immutable
    // Event, including its timestamp; the Reconciler never synthesizes a
    // missing barrier after the terminal transaction has committed.
    event.timestamp = group.satisfied_at.unwrap_or(group.updated_at);
    Ok(event)
}

/// Builds the immutable result fact for an operator/runtime cancellation.
///
/// The result fact itself never wakes a supervisor. The same transaction
/// which stores it must either settle the owning Thread Group or append the
/// direct supervisor barrier returned by `thread_terminal_barrier_event`.
pub fn thread_cancellation_event(
    thread: &ThreadRecord,
    reason: &str,
    actor: &str,
) -> crate::event::Event {
    crate::event::Event::new(
        format!("thread_cancelled_{}_g{}", thread.id, thread.generation),
        actor.to_string(),
        "runtime_control".to_string(),
        "runtime/thread_cancelled".to_string(),
        serde_json::json!({
            "agent_id": thread.agent_id,
            "context_id": thread.context_id,
            "session_id": thread.session_id,
            "thread_id": thread.id,
            "root_turn_id": thread.root_turn_id,
            "thread_generation": thread.generation,
            "terminal_kind": ThreadLifecycle::Cancelled.as_str(),
            "disposition": "no_reply",
            "runtime_failure_kind": "thread_cancelled",
            "wake_policy": "none",
            "text": reason,
        })
        .as_object()
        .cloned()
        .unwrap_or_default(),
    )
}

/// Builds the immutable operator correction that starts a new physical
/// generation of the same logical Thread.
///
/// Supersede is deliberately not a terminal Thread outcome. The old
/// generation is fenced and cancelled, while this Event becomes the first
/// durable mailbox input for the next generation. Keeping the logical Thread
/// identity preserves its Thread Group membership and Supervisor barrier.
pub fn thread_supersede_event(
    thread: &ThreadRecord,
    intent: &str,
    reason: &str,
    actor: &str,
) -> crate::event::Event {
    crate::event::Event::new(
        format!(
            "thread_superseded_{}_r{}_g{}",
            thread.id, thread.revision, thread.generation
        ),
        actor.to_string(),
        "runtime_control".to_string(),
        "runtime/thread_superseded".to_string(),
        serde_json::json!({
            "agent_id": thread.agent_id,
            "context_id": thread.context_id,
            "session_id": thread.session_id,
            "thread_id": thread.id,
            "root_turn_id": thread.root_turn_id,
            "previous_generation": thread.generation,
            "thread_generation": thread.generation.saturating_add(1),
            "intent": intent,
            "reason": reason,
            "disposition": "continue",
            "wake_policy": "direct_thread",
            "text": format!(
                "The operator superseded the previous generation of this Thread. Stop the old plan and continue under this corrected intent:\n\n{intent}\n\nReason: {reason}"
            ),
        })
        .as_object()
        .cloned()
        .unwrap_or_default(),
    )
}

pub fn validate_thread_supersede_event(
    thread: &ThreadRecord,
    event: &crate::event::Event,
) -> Result<(), String> {
    let required = |key: &str| {
        event
            .payload
            .get(key)
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| format!("Thread supersede Event is missing '{key}'"))
    };
    if event.topic != "runtime/thread_superseded"
        || event.event_type != "runtime_control"
        || required("context_id")? != thread.context_id
        || required("session_id")? != thread.session_id
        || required("thread_id")? != thread.id
        || required("root_turn_id")? != thread.root_turn_id
        || event
            .payload
            .get("previous_generation")
            .and_then(serde_json::Value::as_u64)
            != Some(thread.generation)
        || event
            .payload
            .get("thread_generation")
            .and_then(serde_json::Value::as_u64)
            != Some(thread.generation.saturating_add(1))
        || event
            .payload
            .get("intent")
            .and_then(serde_json::Value::as_str)
            .is_none_or(|intent| intent.trim().is_empty())
    {
        return Err(format!(
            "Thread supersede Event '{}' is inconsistent with the fenced route of Thread '{}'",
            event.id, thread.id
        ));
    }
    Ok(())
}

/// Builds the one direct supervisor wake for a terminal Thread which is not
/// joined by a Thread Group.
pub fn thread_terminal_barrier_event(
    thread: &ThreadRecord,
    outcome: &ThreadOutcomeRecord,
    parent: Option<&ThreadRecord>,
) -> Result<Option<crate::event::Event>, String> {
    let mut payload = serde_json::Map::new();
    payload.insert(
        "context_id".to_string(),
        JsonValue::String(thread.context_id.clone()),
    );
    payload.insert(
        "thread_id".to_string(),
        JsonValue::String(thread.id.clone()),
    );
    payload.insert(
        "thread_generation".to_string(),
        JsonValue::from(outcome.thread_generation),
    );
    payload.insert(
        "outcome_id".to_string(),
        JsonValue::String(outcome.id.clone()),
    );
    payload.insert(
        "terminal_kind".to_string(),
        JsonValue::String(outcome.terminal_kind.as_str().to_string()),
    );
    payload.insert(
        "wake_policy".to_string(),
        JsonValue::String("direct_signal".to_string()),
    );
    payload.insert(
        "terminal_summary".to_string(),
        serde_json::json!({
            "thread_id": thread.id,
            "outcome_id": outcome.id,
            "terminal_kind": outcome.terminal_kind.as_str(),
            "summary": outcome.summary,
            "artifact_refs": outcome.artifact_refs,
            "evidence_refs": outcome.evidence_refs,
            "check_results": outcome.check_results,
            "unresolved_failures": outcome.unresolved_failures,
        }),
    );
    let (topic, event_type) = match thread.supervision.supervisor_kind {
        ThreadSupervisorKind::Thread | ThreadSupervisorKind::Evaluation => {
            let parent = parent.ok_or_else(|| {
                format!(
                    "attached Thread '{}' is missing its parent Thread projection",
                    thread.id
                )
            })?;
            payload.insert(
                "session_id".to_string(),
                JsonValue::String(parent.session_id.clone()),
            );
            payload.insert(
                "thread_id".to_string(),
                JsonValue::String(parent.id.clone()),
            );
            payload.insert(
                "root_turn_id".to_string(),
                JsonValue::String(parent.root_turn_id.clone()),
            );
            payload.insert(
                "tool_name".to_string(),
                JsonValue::String("thread".to_string()),
            );
            payload.insert(
                "tool_status".to_string(),
                JsonValue::String("error".to_string()),
            );
            payload.insert(
                "text".to_string(),
                JsonValue::String(format!(
                    "Thread '{}' is terminal: {}",
                    thread.id,
                    outcome.terminal_kind.as_str()
                )),
            );
            (
                "chat/thread_terminal".to_string(),
                crate::event::TYPE_TOOL_OUTPUT.to_string(),
            )
        }
        ThreadSupervisorKind::Objective => {
            payload.insert(
                "session_id".to_string(),
                JsonValue::String(thread.session_id.clone()),
            );
            payload.insert(
                "objective_id".to_string(),
                JsonValue::String(thread.supervision.supervisor_id.clone().ok_or_else(|| {
                    format!("durable Thread '{}' is missing its Objective", thread.id)
                })?),
            );
            (
                "runtime/thread_terminal".to_string(),
                "runtime_control".to_string(),
            )
        }
        ThreadSupervisorKind::Runtime => {
            payload.insert(
                "session_id".to_string(),
                JsonValue::String(thread.session_id.clone()),
            );
            payload.insert(
                "runtime_supervisor_id".to_string(),
                JsonValue::String(thread.supervision.supervisor_id.clone().ok_or_else(|| {
                    format!("Runtime Thread '{}' is missing its supervisor", thread.id)
                })?),
            );
            (
                "runtime/thread_terminal".to_string(),
                "runtime_control".to_string(),
            )
        }
        ThreadSupervisorKind::None | ThreadSupervisorKind::Legacy => return Ok(None),
    };
    Ok(Some(crate::event::Event::new(
        format!(
            "thread_terminal_{}_g{}",
            thread.id, outcome.thread_generation
        ),
        "Runtime".to_string(),
        event_type,
        topic,
        payload,
    )))
}

/// Durable authorization state for one exact Execution Job capability request.
/// Pending human approval has no Runtime timeout and survives process restart.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    PendingAuto,
    PendingHuman,
    Allowed,
    Denied,
    Cancelled,
}

impl ApprovalStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PendingAuto => "pending_auto",
            Self::PendingHuman => "pending_human",
            Self::Allowed => "allowed",
            Self::Denied => "denied",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn is_pending(self) -> bool {
        matches!(self, Self::PendingAuto | Self::PendingHuman)
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Denied | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "decision", rename_all = "snake_case")]
pub enum ApprovalResolution {
    Allow {
        rationale: String,
        #[serde(default)]
        risk_tags: Vec<String>,
    },
    Deny {
        rationale: String,
        #[serde(default)]
        risk_tags: Vec<String>,
    },
}

impl ApprovalResolution {
    pub fn status(&self) -> ApprovalStatus {
        match self {
            Self::Allow { .. } => ApprovalStatus::Allowed,
            Self::Deny { .. } => ApprovalStatus::Denied,
        }
    }

    pub fn rationale(&self) -> &str {
        match self {
            Self::Allow { rationale, .. } | Self::Deny { rationale, .. } => rationale,
        }
    }

    pub fn risk_tags(&self) -> &[String] {
        match self {
            Self::Allow { risk_tags, .. } | Self::Deny { risk_tags, .. } => risk_tags,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ApprovalRecord {
    pub id: String,
    pub revision: u64,
    pub job_id: String,
    pub request_digest: String,
    pub policy_digest: String,
    pub action: serde_json::Value,
    pub requested: serde_json::Value,
    pub justification: String,
    pub status: ApprovalStatus,
    pub rationale: Option<String>,
    pub risk_tags: Vec<String>,
    /// Stable one-use capability identity. `ExecutionApprovalStore` consumes
    /// it atomically with Job claim.
    pub grant_id: Option<String>,
    pub grant_consumed_at: Option<DateTime<Utc>>,
    pub consumed_by_claim_token: Option<String>,
    pub cancel_reason: Option<String>,
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub decided_at: Option<DateTime<Utc>>,
    pub cancelled_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub struct NewApprovalRequest {
    pub id: String,
    pub job_id: String,
    pub request_digest: String,
    pub policy_digest: String,
    pub action: serde_json::Value,
    pub requested: serde_json::Value,
    pub justification: String,
    /// Only a pending status is accepted when the authority is first created.
    pub pending_status: ApprovalStatus,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityLeaseStatus {
    Active,
    Revoked,
}

impl CapabilityLeaseStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Revoked => "revoked",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "active" => Some(Self::Active),
            "revoked" => Some(Self::Revoked),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CapabilityLeaseRecord {
    pub id: String,
    pub revision: u64,
    pub principal_id: String,
    pub agent_id: String,
    pub thread_id: String,
    pub target_id: String,
    pub capabilities: Vec<String>,
    pub requested: serde_json::Value,
    pub policy_digest: String,
    pub status: CapabilityLeaseStatus,
    pub issued_by_approval_id: Option<String>,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub revoke_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewCapabilityLease {
    pub id: String,
    pub principal_id: String,
    pub agent_id: String,
    pub thread_id: String,
    pub target_id: String,
    pub capabilities: Vec<String>,
    pub requested: serde_json::Value,
    pub policy_digest: String,
    pub issued_by_approval_id: Option<String>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default)]
pub struct CapabilityLeaseFilter {
    pub principal_id: Option<String>,
    pub agent_id: Option<String>,
    pub thread_id: Option<String>,
    pub target_id: Option<String>,
    /// Require an exact capability element rather than scanning unrelated
    /// leases in the same execution scope.
    pub capability: Option<String>,
    pub active_at: Option<DateTime<Utc>>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum CapabilityLeaseMutation {
    Created(CapabilityLeaseRecord),
    Existing(CapabilityLeaseRecord),
    Updated(CapabilityLeaseRecord),
    Conflict { current: CapabilityLeaseRecord },
    NotFound,
}

#[derive(Debug, Clone, Default)]
pub struct ApprovalFilter {
    pub job_id: Option<String>,
    pub status: Option<ApprovalStatus>,
    pub pending_only: bool,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ApprovalMutation {
    Created(ApprovalRecord),
    Updated(ApprovalRecord),
    /// Exact idempotent replay of an already persisted request or decision.
    Existing(ApprovalRecord),
    Conflict {
        current: ApprovalRecord,
        reason: String,
    },
    Rejected {
        current: ApprovalRecord,
        reason: String,
    },
    NotFound,
}

/// Result of atomically committing an Approval authority transition and its
/// immutable audit Event. `event_created` is true both for a new transition
/// and when an exact replay repairs an Event that was missing from data
/// written by an older Runtime.
#[derive(Debug, Clone)]
pub struct ApprovalAuditCommit {
    pub mutation: ApprovalMutation,
    pub event_created: bool,
    /// Exact immutable Event projection committed in the same transaction.
    /// Callers must dispatch this value rather than reconstructing it from a
    /// later, potentially changed authority read.
    pub event: Option<crate::event::Event>,
}

/// Result of a transaction which crosses the Execution Job and Approval
/// authorities. Returning both records keeps callers from making a second,
/// racy read before deciding what to do next.
#[derive(Debug, Clone, PartialEq)]
pub enum ExecutionApprovalMutation {
    Created {
        job: ExecutionJobRecord,
        approval: ApprovalRecord,
    },
    Updated {
        job: ExecutionJobRecord,
        approval: ApprovalRecord,
    },
    /// Exact replay of a transaction which was already committed.
    Existing {
        job: ExecutionJobRecord,
        approval: ApprovalRecord,
    },
    Conflict {
        job: Option<ExecutionJobRecord>,
        approval: Option<ApprovalRecord>,
        reason: String,
    },
    Rejected {
        job: Option<ExecutionJobRecord>,
        approval: Option<ApprovalRecord>,
        reason: String,
    },
    NotFound,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActivationSignalRecord {
    pub activation_id: String,
    pub signal_id: String,
    pub ordinal: u64,
}

/// Durable causal lane owned by one Agent. A Thread survives all model
/// attempts and tool wakeups produced while completing the same root turn.
/// Attempts are replaceable execution records; this is the stable scheduling
/// and delivery identity.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThreadKind {
    DialogueTurn,
    Execution,
    Delivery,
}

impl ThreadKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DialogueTurn => "dialogue_turn",
            Self::Execution => "execution",
            Self::Delivery => "delivery",
        }
    }
}

/// Declared lifetime of one Thread relative to the Evaluation which created it.
///
/// This is control-plane authority, not a UI hint. In particular, a durable
/// Thread is invalid unless it is supervised by an Objective.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThreadLifetime {
    Attached,
    Durable,
    Disposable,
}

impl ThreadLifetime {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Attached => "attached",
            Self::Durable => "durable",
            Self::Disposable => "disposable",
        }
    }
}

/// Authority responsible for consuming the terminal outcome of a Thread.
///
/// `Runtime` is reserved for kernel-owned lanes such as Delivery. `Legacy`
/// is a migration marker for rows created before supervision became
/// first-class; new model-authored Threads must never use it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThreadSupervisorKind {
    Thread,
    Evaluation,
    Objective,
    Runtime,
    None,
    Legacy,
}

impl ThreadSupervisorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Thread => "thread",
            Self::Evaluation => "evaluation",
            Self::Objective => "objective",
            Self::Runtime => "runtime",
            Self::None => "none",
            Self::Legacy => "legacy",
        }
    }
}

/// Durable supervision route stored on the Thread row itself so creation and
/// scheduling cannot expose an orphan between two transactions.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ThreadSupervision {
    pub lifetime: ThreadLifetime,
    pub supervisor_kind: ThreadSupervisorKind,
    pub supervisor_id: Option<String>,
    pub generation: u64,
    pub origin_evaluation_id: Option<String>,
    pub parent_thread_id: Option<String>,
    pub thread_group_id: Option<String>,
    #[serde(default)]
    pub completion_contract: JsonValue,
}

impl ThreadSupervision {
    pub fn attached(
        parent_thread_id: impl Into<String>,
        parent_thread_generation: u64,
        origin_evaluation_id: impl Into<String>,
    ) -> Self {
        let parent_thread_id = parent_thread_id.into();
        Self {
            lifetime: ThreadLifetime::Attached,
            supervisor_kind: ThreadSupervisorKind::Thread,
            supervisor_id: Some(parent_thread_id.clone()),
            generation: parent_thread_generation.max(1),
            origin_evaluation_id: Some(origin_evaluation_id.into()),
            parent_thread_id: Some(parent_thread_id),
            thread_group_id: None,
            completion_contract: JsonValue::Object(Default::default()),
        }
    }

    pub fn objective(
        objective_id: impl Into<String>,
        origin_evaluation_id: impl Into<String>,
        objective_revision: u64,
        parent_thread_id: Option<String>,
    ) -> Self {
        Self {
            lifetime: ThreadLifetime::Durable,
            supervisor_kind: ThreadSupervisorKind::Objective,
            supervisor_id: Some(objective_id.into()),
            generation: objective_revision.max(1),
            origin_evaluation_id: Some(origin_evaluation_id.into()),
            parent_thread_id,
            thread_group_id: None,
            completion_contract: JsonValue::Object(Default::default()),
        }
    }

    /// Supervision route for an Objective's long-lived primary Execution
    /// Thread. Unlike explicitly spawned Objective work, this route is owned
    /// by the Objective generation rather than one finite Evaluation and
    /// therefore deliberately has no `origin_evaluation_id`.
    pub fn objective_primary_execution(
        objective_id: impl Into<String>,
        objective_generation: u64,
    ) -> Self {
        Self {
            lifetime: ThreadLifetime::Durable,
            supervisor_kind: ThreadSupervisorKind::Objective,
            supervisor_id: Some(objective_id.into()),
            generation: objective_generation.max(1),
            origin_evaluation_id: None,
            parent_thread_id: None,
            thread_group_id: None,
            completion_contract: JsonValue::Object(Default::default()),
        }
    }

    pub fn runtime(supervisor_id: impl Into<String>) -> Self {
        Self {
            lifetime: ThreadLifetime::Durable,
            supervisor_kind: ThreadSupervisorKind::Runtime,
            supervisor_id: Some(supervisor_id.into()),
            generation: 1,
            origin_evaluation_id: None,
            parent_thread_id: None,
            thread_group_id: None,
            completion_contract: JsonValue::Object(Default::default()),
        }
    }

    pub fn disposable(origin_evaluation_id: impl Into<String>) -> Self {
        let origin_evaluation_id = origin_evaluation_id.into();
        Self {
            lifetime: ThreadLifetime::Disposable,
            supervisor_kind: ThreadSupervisorKind::None,
            supervisor_id: None,
            generation: 1,
            origin_evaluation_id: Some(origin_evaluation_id),
            parent_thread_id: None,
            thread_group_id: None,
            completion_contract: JsonValue::Object(Default::default()),
        }
    }

    pub fn legacy() -> Self {
        Self {
            lifetime: ThreadLifetime::Durable,
            supervisor_kind: ThreadSupervisorKind::Legacy,
            supervisor_id: None,
            generation: 1,
            origin_evaluation_id: None,
            parent_thread_id: None,
            thread_group_id: None,
            completion_contract: JsonValue::Object(Default::default()),
        }
    }

    pub fn validate(&self, kind: ThreadKind) -> Result<(), String> {
        if self.generation == 0 {
            return Err("Thread supervision generation must be greater than zero".to_string());
        }
        match (self.lifetime, self.supervisor_kind) {
            (ThreadLifetime::Attached, ThreadSupervisorKind::Thread)
                if self.supervisor_id.is_some()
                    && self.origin_evaluation_id.is_some()
                    && self.parent_thread_id.is_some()
                    && self.supervisor_id == self.parent_thread_id => {}
            (ThreadLifetime::Durable, ThreadSupervisorKind::Objective)
                if kind == ThreadKind::Execution
                    && self.supervisor_id.is_some()
                    && self.origin_evaluation_id.is_some() => {}
            (ThreadLifetime::Durable, ThreadSupervisorKind::Objective)
                if kind == ThreadKind::Execution
                    && self.supervisor_id.is_some()
                    && self.origin_evaluation_id.is_none() => {}
            (ThreadLifetime::Durable, ThreadSupervisorKind::Runtime)
                if self.supervisor_id.is_some() => {}
            (ThreadLifetime::Disposable, ThreadSupervisorKind::None)
                if self.supervisor_id.is_none() => {}
            (_, ThreadSupervisorKind::Legacy) => {}
            _ => {
                return Err(format!(
                    "invalid Thread supervision combination: lifetime={}, supervisor={}",
                    self.lifetime.as_str(),
                    self.supervisor_kind.as_str()
                ));
            }
        }
        if self.lifetime == ThreadLifetime::Disposable && self.thread_group_id.is_some() {
            return Err("a disposable Thread cannot join a required Thread Group".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThreadLifecycle {
    Open,
    Completed,
    Failed,
    Cancelled,
}

/// Operator control is orthogonal to the semantic Thread lifecycle. A paused
/// Thread remains open and keeps its durable mailbox, but the scheduler must
/// not create another Activation until it is resumed.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThreadControlState {
    Active,
    Paused,
}

impl ThreadControlState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Paused => "paused",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThreadControlAction {
    Pause,
    Resume,
    Cancel,
}

impl ThreadLifecycle {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

/// Scheduler phase is a projection, never authoritative Thread state.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThreadPhase {
    Idle,
    Runnable,
    Running,
    Waiting,
}

impl ThreadPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Runnable => "runnable",
            Self::Running => "running",
            Self::Waiting => "waiting",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryStatus {
    None,
    Pending,
    Deferred,
    Delivered,
}

impl DeliveryStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Pending => "pending",
            Self::Deferred => "deferred",
            Self::Delivered => "delivered",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ThreadRecord {
    pub id: String,
    pub revision: u64,
    /// Monotonic Evaluation generation for this logical Thread.
    pub generation: u64,
    pub agent_id: String,
    pub context_id: String,
    pub session_id: String,
    pub initiating_principal_id: Option<String>,
    pub root_turn_id: String,
    pub kind: ThreadKind,
    pub lifecycle: ThreadLifecycle,
    pub control_state: ThreadControlState,
    pub executor_kind: String,
    pub executor_id: Option<String>,
    /// Stable physical destination inherited by physical actions in this
    /// Thread. `None` means no physical destination has been chosen yet.
    pub target_id: Option<String>,
    pub supervision: ThreadSupervision,
    pub result_text: Option<String>,
    pub result_event_id: Option<String>,
    pub delivery_status: DeliveryStatus,
    pub delivery_event_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct NewThread {
    pub id: String,
    pub agent_id: String,
    pub context_id: String,
    pub session_id: String,
    pub initiating_principal_id: Option<String>,
    pub root_turn_id: String,
    pub kind: ThreadKind,
    pub executor_kind: String,
    pub executor_id: Option<String>,
    pub target_id: Option<String>,
    pub supervision: ThreadSupervision,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ThreadMutation {
    Updated(ThreadRecord),
    Conflict { current: ThreadRecord },
    NotFound,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleStatus {
    Queued,
    Paused,
    Dispatched,
    Completed,
    Cancelled,
}

impl ScheduleStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Paused => "paused",
            Self::Dispatched => "dispatched",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScheduleRecord {
    pub id: String,
    pub revision: u64,
    pub thread_id: String,
    pub source_turn_id: String,
    pub intent: String,
    /// Optional exact model route requested for every Evaluation dispatched
    /// by this Schedule. No cross-model fallback is implied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_alias: Option<String>,
    pub status: ScheduleStatus,
    pub not_before: Option<DateTime<Utc>>,
    pub interval_seconds: Option<u64>,
    pub dependency_thread_ids: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct NewSchedule {
    pub id: String,
    pub thread_id: String,
    pub source_turn_id: String,
    pub intent: String,
    pub model_alias: Option<String>,
    pub not_before: Option<DateTime<Utc>>,
    pub interval_seconds: Option<u64>,
    pub dependency_thread_ids: Vec<String>,
}

/// One Objective created in the same durable transaction as its initial
/// supervised Thread(s), Thread Group and Schedule intents.  Keeping the
/// initial wait beside the Objective prevents a newly-created Objective from
/// racing an independent Evaluation before its first execution plan exists.
#[derive(Debug, Clone)]
pub struct NewScheduledObjective {
    pub objective: NewObjective,
    pub initial_wait_condition: ObjectiveWaitCondition,
    pub status_reason: String,
    pub created_event: crate::event::Event,
}

/// Revision-fenced installation of the durable wait owned by an already
/// existing Objective.  This is committed in the same transaction as the
/// Objective-supervised Group and its Threads, so an Evaluation can never
/// hand work off and then expose `active + no wait` to the supervisor.
#[derive(Debug, Clone)]
pub struct ScheduledObjectiveWaitBinding {
    pub objective_id: String,
    pub expected_revision: u64,
    pub wait_condition: ObjectiveWaitCondition,
    pub status_reason: String,
    pub bound_event: crate::event::Event,
}

/// Atomic transfer of one open attached Thread from its owning parent Thread
/// generation to an Objective. The transaction releases the source Group
/// member while installing the new Objective-owned Group, so neither owner can
/// observe a half-transferred Thread.
#[derive(Debug, Clone)]
pub struct ThreadPromotionRequest {
    pub thread_id: String,
    pub expected_thread_revision: u64,
    pub source_group_id: String,
    pub objective_id: String,
    pub expected_objective_revision: Option<u64>,
    pub new_objective: Option<NewScheduledObjective>,
    pub target_group: NewThreadGroupPlan,
    pub promoted_event: crate::event::Event,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ThreadPromotionRecord {
    pub thread: ThreadRecord,
    pub objective: ObjectiveRecord,
    pub source_group: ThreadGroupRecord,
    pub target_group: ThreadGroupRecord,
}

#[derive(Debug, Clone, PartialEq)]
// Mutation payloads mirror persistent aggregate snapshots; boxing would move allocation cost into
// every backend and obscure the authoritative result shape.
#[allow(clippy::large_enum_variant)]
pub enum ThreadPromotionMutation {
    Updated(ThreadPromotionRecord),
    Conflict {
        current_thread: ThreadRecord,
        current_objective: Option<ObjectiveRecord>,
    },
    Rejected {
        current_thread: ThreadRecord,
        reason: String,
    },
    NotFound,
}

/// Result of a revision-fenced Schedule control-plane mutation. `Rejected`
/// means the caller held the current revision, but the requested lifecycle
/// transition was not legal; `Conflict` means a newer writer already won.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScheduleMutation {
    Updated(ScheduleRecord),
    Conflict {
        current: ScheduleRecord,
    },
    Rejected {
        current: ScheduleRecord,
        reason: String,
    },
    NotFound,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DelegationStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl DelegationStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DelegationRecord {
    pub id: String,
    pub agent_id: String,
    pub parent_context_id: String,
    pub parent_session_id: String,
    pub child_context_id: String,
    pub child_session_id: String,
    /// Runtime-authenticated Principal that initiated the parent Activation.
    /// This is causal identity metadata, not an authorization decision.
    pub initiating_principal_id: Option<String>,
    pub task: String,
    pub success_when: Option<String>,
    pub context_scope: String,
    pub status: DelegationStatus,
    pub result_event_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct NewDelegation {
    pub id: String,
    pub agent_id: String,
    pub parent_context_id: String,
    pub parent_session_id: String,
    pub child_context_id: String,
    pub child_session_id: String,
    pub initiating_principal_id: Option<String>,
    pub task: String,
    pub success_when: Option<String>,
    pub context_scope: String,
}

/// Bounded Delegation read model. Lifecycle recovery, operator APIs and
/// per-Session Dashboard views must state their scope explicitly instead of
/// materializing the complete historical table and filtering it in memory.
#[derive(Debug, Clone, Default)]
pub struct DelegationFilter {
    pub agent_id: Option<String>,
    pub parent_context_id: Option<String>,
    pub parent_session_id: Option<String>,
    pub child_context_id: Option<String>,
    pub child_session_id: Option<String>,
    /// Match either side of the delegation edge. Intended for product views
    /// that show work related to one selected Context/Session.
    pub related_context_id: Option<String>,
    pub related_session_id: Option<String>,
    pub related_context_ids: Vec<String>,
    /// Empty means every non-terminal status unless `include_terminal` is set.
    pub statuses: Vec<DelegationStatus>,
    pub include_terminal: bool,
    pub newest_first: bool,
    pub after_updated_at: Option<DateTime<Utc>>,
    pub after_id: Option<String>,
    pub limit: Option<usize>,
}

/// Runtime-owned lifecycle state for a persistent Objective. This is control
/// state, not the Agent's free-form semantic task representation in Mind.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ObjectiveStatus {
    Active,
    Paused,
    Blocked,
    Completed,
    Cancelled,
    Failed,
}

impl ObjectiveStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Paused => "paused",
            Self::Blocked => "blocked",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled | Self::Failed)
    }

    pub fn can_transition_to(self, next: Self) -> bool {
        match self {
            Self::Active => true,
            Self::Paused | Self::Blocked => {
                matches!(next, Self::Active | Self::Cancelled | Self::Failed)
            }
            Self::Completed | Self::Cancelled | Self::Failed => false,
        }
    }
}

/// Human-readable compatibility projection of an Objective's current wait.
/// Scheduler v2 derives readiness exclusively from `scheduler_dependencies`;
/// this typed value remains for API/UI display and lossless migration only.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ObjectiveWaitCondition {
    ToolTask {
        task_id: String,
    },
    Delegation {
        delegation_id: String,
    },
    /// Durable barrier for one group of independently scheduled Threads.
    /// The Group projection is authoritative; the terminal Event only wakes
    /// the supervisor so it can consume the complete member/outcome snapshot.
    ThreadGroup {
        group_id: String,
    },
    Timer {
        deadline: DateTime<Utc>,
    },
    Permission {
        request_id: String,
    },
    UserInput {
        session_id: String,
    },
    ExternalEvent {
        topic: String,
        correlation_id: String,
    },
    ResourceAvailable {
        resource: String,
    },
}

/// Durable hand-off between the model's completion decision and the final
/// user-facing reply. Preparing this intent does not terminalize the
/// Objective: its owning Evaluation keeps the lease until the same Activation
/// atomically commits the final reply and scheduler outcomes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObjectiveCompletionIntent {
    pub evaluation_id: String,
    pub activation_id: String,
    pub reason: String,
    pub evidence_refs: Vec<String>,
    pub requested_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObjectiveRecord {
    pub id: String,
    pub agent_id: String,
    pub context_id: String,
    pub coordinator_session_id: String,
    pub delivery_session_id: String,
    pub parent_objective_id: Option<String>,
    pub source_event_id: String,
    /// Runtime-authenticated Principal at Objective formation. Supervisor
    /// continuations retain this identity across waits and restarts.
    pub initiating_principal_id: Option<String>,
    pub stated_objective: String,
    pub revision: u64,
    /// Lifecycle fencing generation. Unlike `revision`, this does not change
    /// for ordinary edits, leases, accounting or dependency updates. It
    /// advances only when an Objective is explicitly resumed into a new
    /// executable lifetime.
    pub generation: u64,
    pub status: ObjectiveStatus,
    /// Latest rationale for the current lifecycle state. The immutable audit
    /// event remains authoritative; this projection makes UI/API reads direct.
    pub status_reason: Option<String>,
    pub wait_condition: Option<ObjectiveWaitCondition>,
    /// Present only while the owning Activation is producing the final reply.
    /// The public lifecycle status intentionally remains `active` until that
    /// reply and all physical scheduler outcomes commit together.
    pub completion_intent: Option<ObjectiveCompletionIntent>,
    pub active_evaluation_id: Option<String>,
    pub evaluation_lease_expires_at: Option<DateTime<Utc>>,
    pub continuation_sequence: u64,
    pub token_budget: Option<u64>,
    pub tokens_used: u64,
    pub time_used_seconds: u64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectiveRecoveryCursor {
    /// Stable creation coordinate. Recovery may update the Objective while it
    /// is being visited, so mutable `updated_at` is not a valid keyset cursor:
    /// it can move a just-processed row behind the cursor and starve later
    /// rows indefinitely.
    pub created_at: DateTime<Utc>,
    pub id: String,
}

/// Exact lightweight counters for the Scheduler read model. Detail pages are
/// intentionally bounded; these values let operator surfaces report the
/// complete durable backlog without deserializing every authority row.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ActivationContextCounts {
    pub pending_signals: usize,
    pub queued_activations: usize,
    pub running_activations: usize,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ExecutionJobContextCounts {
    pub active_jobs: usize,
    pub waiting_approval_jobs: usize,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ObjectiveReadinessCounts {
    pub live_objectives: usize,
    pub runnable_objectives: usize,
    pub waiting_objectives: usize,
}

#[derive(Debug, Clone)]
pub struct NewObjective {
    pub id: String,
    pub agent_id: String,
    pub context_id: String,
    pub coordinator_session_id: String,
    pub delivery_session_id: String,
    pub parent_objective_id: Option<String>,
    pub source_event_id: String,
    pub initiating_principal_id: Option<String>,
    pub stated_objective: String,
    pub token_budget: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObjectiveMutation {
    Updated(ObjectiveRecord),
    Conflict { current: ObjectiveRecord },
    NotFound,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InterruptedDialogueTurn {
    pub thread_id: String,
    pub root_turn_id: String,
    pub activation_id: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum MessageClaim {
    Accepted {
        event: crate::event::Event,
        interrupted: Option<InterruptedDialogueTurn>,
    },
    Existing {
        event_id: String,
    },
    Conflict {
        event_id: String,
    },
    InactiveSession,
    ForbiddenPrincipal {
        principal_id: String,
    },
    InvalidReference {
        message: String,
    },
    InactiveReference {
        session_id: String,
    },
    ForbiddenReference {
        session_id: String,
        principal_id: String,
    },
}

/// Atomic ingress result for one Runtime-authored internal Session Signal.
///
/// The caller does not provide an idempotency key. The Runtime derives the
/// immutable Event id from the source evaluation route and message intent;
/// `Existing` therefore means the same logical Signal was already committed
/// and must not create another target Activation.
#[derive(Debug, Clone, PartialEq)]
pub enum SessionSignalClaim {
    Accepted { event: crate::event::Event },
    Existing { event_id: String },
    InactiveSession,
    ForbiddenPrincipal { principal_id: String },
}

/// Atomic ingress result for one Runtime-authored background-task wake that
/// must be escalated from a terminal (or vanished) owning Execution Thread to
/// the owning Session as a fresh DialogueTurn.
#[derive(Debug, Clone, PartialEq)]
pub enum BackgroundSessionWakeClaim {
    Accepted {
        event: crate::event::Event,
    },
    /// Exact replay of an already committed wake; no new DialogueTurn.
    Existing {
        event_id: String,
    },
    /// The durable checkpoint generation no longer matches (a newer checkpoint
    /// was armed or the Job advanced); this wake is stale and must be dropped.
    StaleCheckpoint,
    ArchivedSession,
    /// ExecutionJobs carry a Session foreign key, so this is an integrity
    /// anomaly requiring operator attention, not ordinary suppression.
    MissingSession,
    /// The wake named a Context different from the Session registry. The
    /// checkpoint is closed with an operator-attention audit fact rather than
    /// retried forever.
    RouteConflict {
        registered_context_id: String,
    },
    ForbiddenPrincipal {
        principal_id: String,
    },
}

/// Atomic ingress result for one due background checkpoint delivered to its
/// still-live owning Thread.  The checkpoint CAS, immutable Event, and direct
/// Thread Signal are one Store transaction: a peer Runtime can therefore
/// neither deliver an obsolete generation nor leave a cleared Timer paired
/// with a still-armed Job projection.
#[derive(Debug, Clone, PartialEq)]
pub enum BackgroundThreadWakeClaim {
    Accepted { event: crate::event::Event },
    Existing { event_id: String },
    StaleCheckpoint,
    MissingThread,
    InactiveThread { status: String },
}

/// Build the immutable audit fact that closes a background wake which cannot
/// be delivered to its owning Session.  Both stores call this while holding
/// the same transaction that clears the checkpoint (when one exists), so a
/// crash cannot leave the durable projection cleared without a reason.
pub(crate) fn background_wake_audit_event(
    wake: &crate::event::Event,
    job_id: &str,
    expected_checkpoint_generation: Option<u64>,
    outcome: &str,
    operator_attention: bool,
) -> crate::event::Event {
    let id = expected_checkpoint_generation.map_or_else(
        || format!("background_wake_audit_result_{job_id}"),
        |generation| format!("background_wake_audit_{job_id}_g{generation}"),
    );
    let mut payload = wake.payload.clone();
    payload.insert("event".to_string(), serde_json::json!(outcome));
    payload.insert("execution_job_id".to_string(), serde_json::json!(job_id));
    payload.insert(
        "suppressed_wake_event_id".to_string(),
        serde_json::json!(wake.id),
    );
    payload.insert(
        "operator_attention".to_string(),
        serde_json::json!(operator_attention),
    );
    if let Some(generation) = expected_checkpoint_generation {
        payload.insert(
            "checkpoint_generation".to_string(),
            serde_json::json!(generation),
        );
    }
    crate::event::Event {
        id,
        sequence: None,
        timestamp: wake.timestamp,
        actor: "System-TaskMonitor".to_string(),
        event_type: crate::event::TYPE_EXCEPTION.to_string(),
        topic: "runtime/audit".to_string(),
        payload,
    }
}

/// Stable identity of one logical user-message request. The database key says
/// where the request lives; this digest says what immutable intent that key
/// names. Generated Event IDs, timestamps, and storage paths are deliberately
/// excluded so an exact transport retry remains identical across processes.
pub(crate) fn message_request_fingerprint(
    payload: &serde_json::Map<String, JsonValue>,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    fn field<'a>(
        payload: &'a serde_json::Map<String, JsonValue>,
        name: &str,
    ) -> Result<&'a str, Box<dyn std::error::Error + Send + Sync>> {
        payload
            .get(name)
            .and_then(JsonValue::as_str)
            .ok_or_else(|| format!("user message is missing {name}").into())
    }

    fn digest_field(digest: &mut sha2::Sha256, value: &str) {
        digest.update((value.len() as u64).to_be_bytes());
        digest.update(value.as_bytes());
    }

    let mut digest = sha2::Sha256::new();
    digest.update(b"morphz.message-request.v1\0");
    for name in ["principal_id", "text"] {
        digest_field(&mut digest, field(payload, name)?);
    }
    let attachments = payload
        .get("attachments")
        .and_then(JsonValue::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    digest.update((attachments.len() as u64).to_be_bytes());
    for attachment in attachments {
        for name in ["name", "media_type", "sha256"] {
            digest_field(
                &mut digest,
                attachment
                    .get(name)
                    .and_then(JsonValue::as_str)
                    .ok_or_else(|| format!("user message attachment is missing {name}"))?,
            );
        }
        let size = attachment
            .get("size_bytes")
            .and_then(JsonValue::as_u64)
            .ok_or("user message attachment is missing size_bytes")?;
        digest.update(size.to_be_bytes());
    }
    for name in [
        "requested_harness_id",
        "requested_harness_version",
        "requested_harness_artifact_hash",
    ] {
        match payload.get(name).and_then(JsonValue::as_str) {
            Some(value) => {
                digest.update([1]);
                digest_field(&mut digest, value);
            }
            None => digest.update([0]),
        }
    }
    // Preserve the v1 digest of every pre-reference message. Only requests
    // which actually carry typed references extend the intent fingerprint, so
    // an exact transport retry created before this field existed remains
    // idempotent after upgrading Runtime.
    if let Some(references) = payload.get("references").and_then(JsonValue::as_array) {
        if !references.is_empty() {
            digest.update(b"morphz.message-references.v1\0");
            digest.update((references.len() as u64).to_be_bytes());
            for reference in references {
                for name in ["kind", "session_id", "context_id", "agent_id"] {
                    digest_field(
                        &mut digest,
                        reference
                            .get(name)
                            .and_then(JsonValue::as_str)
                            .ok_or_else(|| format!("user message reference is missing {name}"))?,
                    );
                }
            }
        }
    }
    Ok(format!("v1:{:x}", digest.finalize()))
}

#[derive(Default, Debug, Clone)]
pub struct QueryFilter {
    pub event_id: Option<String>,
    /// Exact Event IDs, usually returned by the asynchronous Recall lexical
    /// projection. Empty means no ID constraint.
    pub event_ids: Vec<String>,
    pub sequence: Option<u64>,
    pub context_id: Option<String>,
    pub session_id: Option<String>,
    /// Bounded multi-Session query used by Context Encoding. This avoids
    /// scanning every Session attached to a shared Cognitive Context.
    pub session_ids: Vec<String>,
    /// When `session_ids` is set, also include Context-wide events whose
    /// physical `session_id` is NULL.
    pub include_context_wide: bool,
    /// Only return events physically appended after this sequence (SQLite rowid).
    pub after_sequence: Option<u64>,
    /// Only return events physically appended before this sequence. Combined
    /// with `latest_k`, this provides stable backward pagination over the
    /// immutable Event Sequence without offset scans.
    pub before_sequence: Option<u64>,
    pub start_time: Option<DateTime<Utc>>,
    pub end_time: Option<DateTime<Utc>>,
    pub actors: Vec<String>,
    pub types: Vec<String>,
    pub topic: Option<String>, // Supports exact or prefix-wildcard filtering.
    /// Exact topic allow-list. This is intentionally separate from `topic`,
    /// whose single value also supports prefix matching. Read models such as
    /// the Dialogue transcript use it to page the newest presentation Events
    /// without first scanning unrelated scheduler and diagnostic history.
    pub topics: Vec<String>,
    /// Topics which must never be materialized by this query. Exact topics and
    /// `prefix/*` patterns are supported, matching `topic` semantics.
    pub excluded_topics: Vec<String>,
    /// Exact causal route filters. These values are projected out of the
    /// immutable JSON payload into indexed Event columns on write. They must
    /// be used for scheduler and Dashboard queries instead of payload scans.
    pub thread_id: Option<String>,
    pub activation_id: Option<String>,
    pub root_turn_id: Option<String>,
    pub objective_id: Option<String>,
    pub top_k: Option<usize>, // Limits the number of most relevant Events returned.
    /// Return the newest N events, while preserving chronological order in the
    /// returned vector. This keeps tail reads bounded inside SQLite.
    pub latest_k: Option<usize>,
}

/// Read a causal identifier from the canonical top-level Event route. A small
/// number of older Events stored the route under `payload.route`; accepting
/// that legacy shape here keeps the write projection lossless during upgrade.
pub(crate) fn causal_payload_string<'a>(
    event: &'a crate::event::Event,
    key: &str,
) -> Option<&'a str> {
    event
        .payload
        .get(key)
        .and_then(|value| value.as_str())
        .or_else(|| {
            event
                .payload
                .get("route")
                .and_then(|value| value.as_object())
                .and_then(|route| route.get(key))
                .and_then(|value| value.as_str())
        })
}

// EventStore defines the physical persistence interface for immutable Events.
#[derive(Debug, Clone)]
pub struct EventAppend {
    pub event: crate::event::Event,
}

#[async_trait::async_trait]
pub trait EventStore: Send + Sync {
    async fn append(
        &self,
        ev: crate::event::Event,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;
    /// Atomically append an immutable Event and deliver it to an existing
    /// scheduler Thread. Internal producers which already know the owning
    /// Thread must use this instead of the legacy Signal Outbox bridge.
    async fn append_to_thread(
        &self,
        ev: crate::event::Event,
        thread_id: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;
    /// Atomically commits an ordered group of immutable persisted Events. A
    /// failure rolls back the complete group. Scheduler delivery is an
    /// explicit Kernel operation and is never inferred by this generic API.
    async fn append_batch(
        &self,
        entries: Vec<EventAppend>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;
    async fn query(
        &self,
        filter: QueryFilter,
    ) -> Result<Vec<crate::event::Event>, Box<dyn std::error::Error + Send + Sync>>;

    /// Lazily materialize causal route columns for legacy Events of one
    /// Dashboard Thread. This mutates only a rebuildable query projection,
    /// never the immutable Event payload. The default keeps lightweight test
    /// stores compatible; durable stores override it.
    async fn backfill_causal_projection_for_thread(
        &self,
        _context_id: &str,
        _session_id: &str,
        _thread_id: &str,
        _topic: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        Ok(())
    }

    /// Reads the current operator acknowledgement Projection. Implementations
    /// must not reconstruct it by scanning immutable Events per request.
    async fn list_attention_acknowledgements(
        &self,
        context_id: &str,
    ) -> Result<Vec<AttentionAcknowledgementRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_attention_acknowledgement(
        &self,
        context_id: &str,
        key: &str,
    ) -> Result<Option<AttentionAcknowledgementRecord>, Box<dyn std::error::Error + Send + Sync>>
    {
        Ok(self
            .list_attention_acknowledgements(context_id)
            .await?
            .into_iter()
            .find(|record| record.key == key))
    }
    async fn list_attention_acknowledgements_bounded(
        &self,
        context_id: &str,
        limit: usize,
    ) -> Result<Vec<AttentionAcknowledgementRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let mut records = self.list_attention_acknowledgements(context_id).await?;
        records.truncate(limit);
        Ok(records)
    }

    /// Reads acknowledgement changes strictly after one immutable Event
    /// sequence. Implementations return ascending sequence order so callers
    /// can advance a durable incremental cursor without gaps.
    async fn list_attention_acknowledgements_after(
        &self,
        context_id: &str,
        after_event_sequence: u64,
        limit: usize,
    ) -> Result<Vec<AttentionAcknowledgementRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let mut records = self.list_attention_acknowledgements(context_id).await?;
        records.retain(|record| record.event_sequence > after_event_sequence);
        records.sort_by(|left, right| {
            left.event_sequence
                .cmp(&right.event_sequence)
                .then_with(|| left.key.cmp(&right.key))
        });
        records.truncate(limit);
        Ok(records)
    }
}

/// Rebuildable lexical projection shared by Tool, CLI, HTTP and Dashboard.
/// The Event Store and Mind Projection remain authoritative; implementations
/// source mutation only enqueues a lightweight Outbox intent. Expensive text
/// extraction and lexical index writes run independently and may be rebuilt
/// from Events + Mind after failure.
#[async_trait::async_trait]
pub trait RecallProjectionStore: Send + Sync {
    async fn recall_index_capability(
        &self,
    ) -> Result<RecallIndexCapability, Box<dyn std::error::Error + Send + Sync>>;

    async fn search_recall_documents(
        &self,
        context_id: &str,
        normalized_query: &str,
        limit: usize,
    ) -> Result<Vec<RecallSearchHit>, Box<dyn std::error::Error + Send + Sync>>;

    /// Searches the Recall projection with optional lexical and authoritative
    /// Event-time constraints. Time-filtered results are ordered by immutable
    /// Event sequence and use an exclusive `before_sequence` cursor.
    async fn query_recall_documents(
        &self,
        request: RecallDocumentSearchRequest,
    ) -> Result<Vec<RecallSearchHit>, Box<dyn std::error::Error + Send + Sync>>;

    /// Replaces the complete rebuildable index for one Context. This is an
    /// explicit maintenance operation and never mutates Events or Mind state.
    /// Transactional Outbox intents must survive replacement: the input is a
    /// point-in-time snapshot and newer authoritative commits rely on those
    /// intents to converge the rebuilt index after the replacement commits.
    async fn replace_recall_documents(
        &self,
        context_id: &str,
        documents: &[RecallDocument],
    ) -> Result<RecallIndexAudit, Box<dyn std::error::Error + Send + Sync>>;

    async fn inspect_recall_index(
        &self,
        context_id: &str,
    ) -> Result<RecallIndexAudit, Box<dyn std::error::Error + Send + Sync>>;

    /// Claims and projects at most `limit` current Outbox entries. Claims are
    /// leased and generation-fenced so an older worker cannot overwrite a
    /// newer retire/restore or Frame revision.
    async fn project_recall_outbox_batch(
        &self,
        worker_id: &str,
        limit: usize,
    ) -> Result<RecallProjectionBatch, Box<dyn std::error::Error + Send + Sync>>;
}

#[async_trait::async_trait]
pub trait CognitiveClockStore: Send + Sync {
    async fn get_context_cognitive_clock(
        &self,
        context_id: &str,
    ) -> Result<ContextCognitiveClock, Box<dyn std::error::Error + Send + Sync>>;
}

/// Current, transactionally maintained Observation set for Session-aware
/// Context Encoding. Immutable Events remain authoritative history;
/// this Projection contains only observations which have not been retired.
#[async_trait::async_trait]
pub trait SessionProjectionStore: Send + Sync {
    async fn query_session_projections(
        &self,
        context_id: &str,
        session_ids: &[String],
        include_context_wide: bool,
    ) -> Result<Vec<crate::event::Event>, Box<dyn std::error::Error + Send + Sync>>;

    async fn read_context_encoding_projection_snapshot(
        &self,
        context_id: &str,
        session_ids: &[String],
        include_context_wide: bool,
    ) -> Result<ContextEncodingProjectionSnapshot, Box<dyn std::error::Error + Send + Sync>>;
}

/// Persistent physical clock queue shared by every scheduler policy. Claiming
/// is leased so multiple Runtime workers or crash recovery cannot fire one
/// generation concurrently without a deterministic retry boundary.
#[async_trait::async_trait]
pub trait TimerStore: Send + Sync {
    async fn upsert_runtime_timer(
        &self,
        timer: NewRuntimeTimer,
    ) -> Result<RuntimeTimerRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_runtime_timer(
        &self,
        id: &str,
    ) -> Result<Option<RuntimeTimerRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_runtime_timers(
        &self,
        status: Option<RuntimeTimerStatus>,
    ) -> Result<Vec<RuntimeTimerRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn next_runtime_timer_due_at(
        &self,
    ) -> Result<Option<DateTime<Utc>>, Box<dyn std::error::Error + Send + Sync>>;
    async fn claim_due_runtime_timers(
        &self,
        now: DateTime<Utc>,
        claim_token: &str,
        claim_expires_at: DateTime<Utc>,
        limit: usize,
    ) -> Result<Vec<RuntimeTimerRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn complete_runtime_timer(
        &self,
        id: &str,
        generation: u64,
        claim_token: &str,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>>;
    async fn retry_runtime_timer(
        &self,
        id: &str,
        generation: u64,
        claim_token: &str,
        due_at: DateTime<Utc>,
        error: Option<&str>,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>>;
    /// Cancel a timer which has not crossed the claim boundary. A claimed timer
    /// must finish through its fenced handler so audit state cannot hide a
    /// physical firing and owner-level CAS remains authoritative.
    async fn cancel_runtime_timer(
        &self,
        id: &str,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>>;
}

/// Runtime-owned physical tools may publish a domain-specific terminal topic
/// while retaining the canonical `tool_output` event type and complete causal
/// identity. Keep that vocabulary explicit so Store validation does not force
/// every physical capability back into the generic chat topic.
pub(crate) fn execution_job_result_topic_matches(tool_name: &str, topic: &str) -> bool {
    topic == "chat/tool_output"
        || (tool_name == crate::artifact::ARTIFACT_TRANSFER_TOOL_NAME
            && matches!(
                topic,
                "runtime/artifact_transfer_completed"
                    | "runtime/artifact_transfer_failed"
                    | "runtime/artifact_transfer_cancelled"
            ))
}

/// Durable physical execution plane. Every mutating operation is fenced by the
/// Job revision; worker-owned operations additionally require the current claim
/// token. This keeps process ownership separate from semantic Thread outcome.
#[async_trait::async_trait]
pub trait ExecutionJobStore: Send + Sync {
    /// Durably arms one background-task checkpoint as a composite Job+Timer
    /// transaction: validates the Job is nonterminal, increments
    /// `checkpoint_generation`, writes `checkpoint_due_at`, and upserts the
    /// physical BackgroundWake Timer in one transaction. `runtime_timers`
    /// remains the single durable clock source; the Job fields are the
    /// semantic contract used at dispatch to validate generation and route.
    async fn register_background_checkpoint(
        &self,
        id: &str,
        check_after_secs: u64,
        wake_source: &str,
    ) -> Result<ExecutionJobCheckpointRegistration, Box<dyn std::error::Error + Send + Sync>>;

    /// Clears one armed checkpoint only if its generation still matches.
    /// Used when a typed route intentionally suppresses a stale/undeliverable
    /// wake instead of creating a DialogueTurn.
    async fn clear_background_checkpoint(
        &self,
        id: &str,
        expected_generation: u64,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>>;

    /// Atomically materializes one Runtime-owned direct Artifact Transfer.
    /// Exact replay is idempotent; reuse of any causal identity for different
    /// immutable content is rejected.
    async fn ensure_artifact_transfer_execution(
        &self,
        execution: NewArtifactTransferExecution,
    ) -> Result<ArtifactTransferExecutionRecord, Box<dyn std::error::Error + Send + Sync>>;
    /// Idempotent on `(activation_id, tool_call_id)`. Reusing that causal key
    /// with different immutable fields is rejected instead of silently merged.
    async fn create_execution_job(
        &self,
        job: NewExecutionJob,
    ) -> Result<ExecutionJobRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_execution_job(
        &self,
        id: &str,
    ) -> Result<Option<ExecutionJobRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_execution_jobs(
        &self,
        filter: ExecutionJobFilter,
    ) -> Result<Vec<ExecutionJobRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Bounded active Job rows for an already selected operator Context set.
    /// Production stores push the Context predicate before LIMIT so the
    /// Runtime monitor never scans or truncates against unrelated tenants.
    async fn list_active_execution_jobs_for_contexts(
        &self,
        context_ids: &[String],
        limit: usize,
    ) -> Result<Vec<ExecutionJobMonitorRecord>, Box<dyn std::error::Error + Send + Sync>> {
        if context_ids.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let mut selected = std::collections::HashSet::new();
        let mut jobs = Vec::new();
        for context_id in context_ids {
            if !selected.insert(context_id) {
                continue;
            }
            jobs.extend(
                self.list_execution_jobs(ExecutionJobFilter {
                    context_id: Some(context_id.clone()),
                    include_terminal: false,
                    newest_first: true,
                    limit: Some(limit),
                    ..ExecutionJobFilter::default()
                })
                .await?
                .into_iter()
                .map(ExecutionJobMonitorRecord::from),
            );
        }
        jobs.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        jobs.truncate(limit);
        Ok(jobs)
    }
    async fn count_context_active_execution_jobs(
        &self,
        context_id: &str,
    ) -> Result<ExecutionJobContextCounts, Box<dyn std::error::Error + Send + Sync>> {
        let jobs = self
            .list_execution_jobs(ExecutionJobFilter {
                context_id: Some(context_id.to_string()),
                include_terminal: false,
                ..ExecutionJobFilter::default()
            })
            .await?;
        Ok(ExecutionJobContextCounts {
            active_jobs: jobs.len(),
            waiting_approval_jobs: jobs
                .iter()
                .filter(|job| job.status == ExecutionJobStatus::WaitingApproval)
                .count(),
        })
    }
    /// Exact Job projection for a bounded Activation aggregate. Production
    /// stores override this with one indexed `IN` query.
    async fn list_execution_jobs_for_activations(
        &self,
        context_id: &str,
        activation_ids: &[String],
    ) -> Result<Vec<ExecutionJobRecord>, Box<dyn std::error::Error + Send + Sync>> {
        if activation_ids.is_empty() {
            return Ok(Vec::new());
        }
        Ok(self
            .list_execution_jobs(ExecutionJobFilter {
                context_id: Some(context_id.to_string()),
                include_terminal: true,
                ..ExecutionJobFilter::default()
            })
            .await?
            .into_iter()
            .filter(|job| activation_ids.contains(&job.activation_id))
            .collect())
    }
    /// Terminal result outboxes which still need their one deterministic
    /// directed Signal or Session fallback. Production stores use indexed
    /// anti-joins over `thread_signals` and deterministic Runtime Wake/audit
    /// Event ids, keeping startup recovery proportional to unresolved crash
    /// windows even when the original Thread is already terminal or missing.
    async fn list_terminal_execution_jobs_needing_signal(
        &self,
        tool_name: &str,
    ) -> Result<Vec<ExecutionJobRecord>, Box<dyn std::error::Error + Send + Sync>> {
        Ok(self
            .list_execution_jobs(ExecutionJobFilter {
                tool_name: Some(tool_name.to_string()),
                include_terminal: true,
                ..ExecutionJobFilter::default()
            })
            .await?
            .into_iter()
            .filter(|job| job.status.is_terminal() && job.result_event_id.is_some())
            .collect())
    }
    /// Claims a queued Job, or consumes a waiting-approval Job when a durable
    /// approval reference is supplied. Running Jobs are never stolen merely
    /// because their lease expired; recovery must first reconcile them.
    #[allow(clippy::too_many_arguments)]
    async fn claim_execution_job(
        &self,
        id: &str,
        expected_revision: u64,
        worker_id: &str,
        claim_token: &str,
        lease_expires_at: DateTime<Utc>,
        approval_ref: Option<&str>,
    ) -> Result<ExecutionJobMutation, Box<dyn std::error::Error + Send + Sync>>;
    /// Extends worker ownership and optionally records the first known moment
    /// at which an external side effect may have begun.
    #[allow(clippy::too_many_arguments)]
    async fn heartbeat_execution_job(
        &self,
        id: &str,
        expected_revision: u64,
        claim_token: &str,
        lease_expires_at: DateTime<Utc>,
        side_effect_started_at: Option<DateTime<Utc>>,
        progress_ref: Option<&str>,
    ) -> Result<ExecutionJobMutation, Box<dyn std::error::Error + Send + Sync>>;
    /// Recovery-only transition for an idempotent Job whose previous worker
    /// disappeared before the persisted side-effect boundary. This is never a
    /// generic lease-steal operation.
    async fn requeue_execution_job(
        &self,
        id: &str,
        expected_revision: u64,
    ) -> Result<ExecutionJobMutation, Box<dyn std::error::Error + Send + Sync>>;
    /// Records intent to cancel without claiming that a running process has
    /// already stopped. A controller must subsequently commit `cancelled`.
    async fn request_cancel_execution_job(
        &self,
        id: &str,
        expected_revision: u64,
        reason: Option<&str>,
    ) -> Result<ExecutionJobMutation, Box<dyn std::error::Error + Send + Sync>>;
    /// Commits exactly one terminal physical fact. Succeeded/failed completion
    /// must carry the current worker claim token; cancelled/lost may be committed
    /// by the control-plane after a revision-fenced reconciliation.
    async fn finish_execution_job(
        &self,
        id: &str,
        expected_revision: u64,
        claim_token: Option<&str>,
        terminal: ExecutionJobTerminal,
    ) -> Result<ExecutionJobMutation, Box<dyn std::error::Error + Send + Sync>>;
    /// Atomically commits the terminal physical fact and its immutable result
    /// Event. `wake_thread` is true only for a standalone Action whose own
    /// result is the continuation boundary. The Store then appends the exact
    /// target Thread's durable Signal in this same transaction. Group members
    /// pass false and arm exactly one deterministic ActionGroup-settled Signal
    /// when the Group itself settles.
    #[allow(clippy::too_many_arguments)]
    async fn finish_execution_job_with_event(
        &self,
        id: &str,
        expected_revision: u64,
        claim_token: Option<&str>,
        terminal: ExecutionJobTerminal,
        event: &crate::event::Event,
        wake_thread: bool,
    ) -> Result<ExecutionJobMutation, Box<dyn std::error::Error + Send + Sync>>;
    /// Repairs a stale non-terminal Job projection from an immutable result
    /// Event which is already persisted. Unlike normal `finish`,
    /// this recovery boundary does not require a live worker claim; unlike
    /// `finish_with_event`, it must never create the Event it relies on.
    /// The Store must verify the complete Event contents and causal route in
    /// the same transaction before changing the Job.
    async fn reconcile_execution_job_from_event(
        &self,
        id: &str,
        expected_revision: u64,
        terminal: ExecutionJobTerminal,
        event: &crate::event::Event,
        wake_thread: bool,
    ) -> Result<ExecutionJobMutation, Box<dyn std::error::Error + Send + Sync>>;
}

/// Durable coordination authority for sibling Actions emitted by one model
/// response. Individual result Events are immutable and immediately visible;
/// only the final member transition appends the deterministic settled Event
/// and, when requested by its route, the exact owning Thread's durable Signal.
#[async_trait::async_trait]
pub trait ActionGroupStore: Send + Sync {
    async fn create_action_group(
        &self,
        group: NewActionGroup,
        members: Vec<NewActionGroupMember>,
    ) -> Result<ActionGroupRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_action_group(
        &self,
        id: &str,
    ) -> Result<Option<ActionGroupRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_action_groups(
        &self,
        filter: ActionGroupFilter,
    ) -> Result<Vec<ActionGroupRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_action_group_members(
        &self,
        group_id: &str,
    ) -> Result<Vec<ActionGroupMemberRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Bulk member projection for bounded recovery pages. Implementations must
    /// return rows ordered by `(group_id, ordinal, tool_call_id)` so callers
    /// can group them without one database round trip per Action Group.
    async fn list_action_group_members_for_groups(
        &self,
        group_ids: &[String],
    ) -> Result<Vec<ActionGroupMemberRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Commits one member's immutable result. The result Event may already
    /// exist because a physical ExecutionJob commits its terminal fact and
    /// Event first; exact Event replay is therefore required to be idempotent.
    /// If this is the final pending member, the Store atomically settles the
    /// Group and appends `settled_event` with one direct Thread Signal.
    async fn commit_action_group_member_result(
        &self,
        group_id: &str,
        tool_call_id: &str,
        status: ActionGroupMemberStatus,
        result_event: &crate::event::Event,
        settled_event: &crate::event::Event,
    ) -> Result<ActionGroupMemberCommit, Box<dyn std::error::Error + Send + Sync>>;
}

/// Durable approval authority. Audit Events remain immutable facts, while this
/// Store is the revision-fenced source of truth for pending and decided state.
#[async_trait::async_trait]
pub trait ApprovalStore: Send + Sync {
    /// Idempotently creates a pending request for an existing
    /// `waiting_approval` Execution Job. Exact replay returns `Existing`; the
    /// same identity or causal digest with different immutable content is a
    /// conflict.
    async fn ensure_approval_request(
        &self,
        request: NewApprovalRequest,
    ) -> Result<ApprovalMutation, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_approval(
        &self,
        id: &str,
    ) -> Result<Option<ApprovalRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_approvals(
        &self,
        filter: ApprovalFilter,
    ) -> Result<Vec<ApprovalRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Read Approval authorities through their Execution Job ownership. This
    /// keeps Context observability bounded to one durable aggregate instead
    /// of scanning global approvals or issuing one query per Job.
    async fn list_context_approvals(
        &self,
        context_id: &str,
    ) -> Result<Vec<ApprovalRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Pending Approval authorities for one Context. Scheduler observability
    /// uses this live projection to detect requests whose Execution Job no
    /// longer owns a valid result route without scanning lifetime history.
    async fn list_context_pending_approvals(
        &self,
        context_id: &str,
    ) -> Result<Vec<ApprovalRecord>, Box<dyn std::error::Error + Send + Sync>> {
        Ok(self
            .list_context_approvals(context_id)
            .await?
            .into_iter()
            .filter(|approval| approval.status.is_pending())
            .collect())
    }
    async fn list_context_pending_approvals_bounded(
        &self,
        context_id: &str,
        limit: usize,
    ) -> Result<Vec<ApprovalRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let mut records = self.list_context_pending_approvals(context_id).await?;
        records.truncate(limit);
        Ok(records)
    }
    async fn count_context_pending_approvals(
        &self,
        context_id: &str,
    ) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
        Ok(self.list_context_pending_approvals(context_id).await?.len())
    }
    /// Approval authorities for an already selected Job aggregate.
    async fn list_job_approvals(
        &self,
        context_id: &str,
        job_ids: &[String],
    ) -> Result<Vec<ApprovalRecord>, Box<dyn std::error::Error + Send + Sync>> {
        if job_ids.is_empty() {
            return Ok(Vec::new());
        }
        Ok(self
            .list_context_approvals(context_id)
            .await?
            .into_iter()
            .filter(|approval| job_ids.contains(&approval.job_id))
            .collect())
    }
    /// Atomically commits a revision-fenced allow/deny decision and its
    /// deterministic `runtime/approval_decision` Event. An exact retry of a
    /// committed decision returns `Existing` and repairs a missing Event; an
    /// opposite decision never overwrites it.
    async fn commit_approval_decision(
        &self,
        id: &str,
        expected_revision: u64,
        decision: ApprovalResolution,
    ) -> Result<ApprovalAuditCommit, Box<dyn std::error::Error + Send + Sync>>;
    /// Atomically cancels a still-pending request (or an unconsumed allowed
    /// grant) and appends the same immutable authority audit Event. Denied and
    /// consumed grants are immutable.
    async fn commit_approval_cancellation(
        &self,
        id: &str,
        expected_revision: u64,
        reason: &str,
    ) -> Result<ApprovalAuditCommit, Box<dyn std::error::Error + Send + Sync>>;
}

/// Reusable but narrowly scoped physical authority. A lease never replaces
/// the immutable per-Job Approval audit: it only lets Runtime derive an exact
/// one-use Job grant without invoking another reviewer when the requested
/// boundary is a subset of the active Thread + Target scope.
#[async_trait::async_trait]
pub trait CapabilityLeaseStore: Send + Sync {
    async fn ensure_capability_lease(
        &self,
        lease: NewCapabilityLease,
    ) -> Result<CapabilityLeaseMutation, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_capability_lease(
        &self,
        id: &str,
    ) -> Result<Option<CapabilityLeaseRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_capability_leases(
        &self,
        filter: CapabilityLeaseFilter,
    ) -> Result<Vec<CapabilityLeaseRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn revoke_capability_lease(
        &self,
        id: &str,
        expected_revision: u64,
        reason: &str,
    ) -> Result<CapabilityLeaseMutation, Box<dyn std::error::Error + Send + Sync>>;
}

/// Atomic boundary between durable physical work and its one-use authority.
///
/// This is intentionally separate from `ExecutionJobStore` and
/// `ApprovalStore`: ordinary mutations stay within one aggregate, while these
/// two operations must either commit both aggregates (and, for creation, the
/// immutable request Event) or commit nothing.
#[async_trait::async_trait]
pub trait ExecutionApprovalStore: Send + Sync {
    /// Atomically creates a `waiting_approval` Job, its pending Approval and
    /// the immutable request Event. Exact replay is idempotent; reusing any
    /// identity with different immutable content is fenced as a conflict.
    async fn ensure_execution_job_with_approval(
        &self,
        job: NewExecutionJob,
        approval: NewApprovalRequest,
        request_event: &crate::event::Event,
    ) -> Result<ExecutionApprovalMutation, Box<dyn std::error::Error + Send + Sync>>;

    /// Atomically consumes one exact allowed grant and claims its Job. The
    /// Job and Approval revisions are fenced together, so a grant can never be
    /// consumed without worker ownership (or vice versa).
    #[allow(clippy::too_many_arguments)]
    async fn claim_execution_job_with_grant(
        &self,
        job_id: &str,
        expected_job_revision: u64,
        approval_id: &str,
        expected_approval_revision: u64,
        worker_id: &str,
        claim_token: &str,
        lease_expires_at: DateTime<Utc>,
    ) -> Result<ExecutionApprovalMutation, Box<dyn std::error::Error + Send + Sync>>;
}

/// Persistent product-level Session directory. It deliberately owns routing and
/// lifecycle metadata only; Mind semantics remain in the Context event stream.
#[async_trait::async_trait]
pub trait SessionDirectoryStore: Send + Sync {
    async fn ensure_principal(
        &self,
        principal: NewPrincipal,
    ) -> Result<PrincipalRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_principal(
        &self,
        id: &str,
    ) -> Result<Option<PrincipalRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn search_principals(
        &self,
        query: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<PrincipalDirectoryPage, Box<dyn std::error::Error + Send + Sync>>;
    async fn bind_session_principal(
        &self,
        session_id: &str,
        principal_id: &str,
    ) -> Result<SessionPrincipalBinding, Box<dyn std::error::Error + Send + Sync>>;
    async fn bind_all_sessions_to_principal(
        &self,
        principal_id: &str,
        include_archived: bool,
    ) -> Result<usize, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_session_principals(
        &self,
        session_id: &str,
    ) -> Result<Vec<SessionPrincipalBinding>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_principal_sessions(
        &self,
        principal_id: &str,
        include_archived: bool,
    ) -> Result<Vec<SessionRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_context_principal_bindings(
        &self,
        context_id: &str,
    ) -> Result<Vec<SessionPrincipalBinding>, Box<dyn std::error::Error + Send + Sync>>;
    /// One bounded identity lookup for the Sessions already selected by an
    /// operator projection.  This avoids one query per Session card.
    async fn list_session_principal_bindings_bounded(
        &self,
        session_ids: &[String],
    ) -> Result<Vec<SessionPrincipalBinding>, Box<dyn std::error::Error + Send + Sync>>;
    async fn verify_session_principal(
        &self,
        session_id: &str,
        principal_id: &str,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>>;
    async fn create_agent_bundle(
        &self,
        agent: NewAgent,
        root_context: NewCognitiveContext,
        initial_session: NewSession,
    ) -> Result<AgentBootstrapRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn create_agent(
        &self,
        agent: NewAgent,
    ) -> Result<AgentRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn ensure_agent(
        &self,
        agent: NewAgent,
    ) -> Result<AgentRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_agent(
        &self,
        id: &str,
    ) -> Result<Option<AgentRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_agents(
        &self,
        include_archived: bool,
    ) -> Result<Vec<AgentRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn create_context(
        &self,
        context: NewCognitiveContext,
    ) -> Result<CognitiveContextRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn ensure_context(
        &self,
        context: NewCognitiveContext,
    ) -> Result<CognitiveContextRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_context(
        &self,
        id: &str,
    ) -> Result<Option<CognitiveContextRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_contexts(
        &self,
        include_archived: bool,
    ) -> Result<Vec<CognitiveContextRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Bounded Context directory ordered by recent product activity.
    async fn list_recent_contexts(
        &self,
        include_archived: bool,
        limit: usize,
    ) -> Result<Vec<CognitiveContextRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Updates Context metadata. Archiving a Context also archives every
    /// Session mounted to it in the same database transaction; Events and
    /// projections remain intact and auditable.
    async fn update_context(
        &self,
        id: &str,
        update: ContextUpdate,
    ) -> Result<Option<CognitiveContextRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Compare-and-swap the Context-scoped requested hard limit. `None`
    /// restores automatic mode while preserving the monotonic revision fence.
    async fn update_context_token_budget(
        &self,
        id: &str,
        requested_hard_token_limit: Option<u64>,
        expected_revision: u64,
    ) -> Result<ContextTokenBudgetMutation, Box<dyn std::error::Error + Send + Sync>>;
    async fn set_context_seed(
        &self,
        context_id: &str,
        source_context_id: &str,
        source_version: u64,
        snapshot_hash: &str,
        projection: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;
    async fn create_session(
        &self,
        session: NewSession,
    ) -> Result<SessionRecord, Box<dyn std::error::Error + Send + Sync>>;
    /// Atomically creates the Session and its initial Principal binding. A
    /// failed binding must never leave a caller-visible orphan Session.
    async fn create_session_for_principal(
        &self,
        session: NewSession,
        principal_id: &str,
    ) -> Result<SessionRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn ensure_session(
        &self,
        session: NewSession,
    ) -> Result<SessionRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_session(
        &self,
        id: &str,
    ) -> Result<Option<SessionRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_sessions(
        &self,
        include_archived: bool,
    ) -> Result<Vec<SessionRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_context_sessions(
        &self,
        context_id: &str,
        include_archived: bool,
    ) -> Result<Vec<SessionRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// One bounded query for a set of Contexts.  The per-Context window keeps
    /// a Runtime overview proportional to its UI budget instead of the total
    /// Session registry.
    async fn list_context_sessions_bounded(
        &self,
        context_ids: &[String],
        include_archived: bool,
        per_context_limit: usize,
    ) -> Result<Vec<SessionRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Aggregate counts for a bounded set of Contexts.
    async fn count_context_sessions(
        &self,
        context_ids: &[String],
    ) -> Result<Vec<ContextSessionCount>, Box<dyn std::error::Error + Send + Sync>>;
    async fn update_session(
        &self,
        id: &str,
        update: SessionUpdate,
    ) -> Result<Option<SessionRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Operator-owned sharing policy. This does not archive the Session or
    /// change shared Mind; it only controls automatic cross-Session history
    /// projection.
    async fn set_session_context_sharing(
        &self,
        id: &str,
        sharing: SessionContextSharing,
    ) -> Result<Option<SessionRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn touch_session(
        &self,
        id: &str,
        at: DateTime<Utc>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;
    async fn update_session_attention(
        &self,
        update: SessionAttentionUpdate,
    ) -> Result<Option<SessionRecord>, Box<dyn std::error::Error + Send + Sync>>;
}

/// Durable Signal/Activation scheduler boundary. This owns runnable work and
/// its lease-fenced outcome, not product-level Session metadata.
#[async_trait::async_trait]
pub trait ActivationStore: Send + Sync {
    /// Atomically append a Context transaction event and update all affected
    /// Session mount attention rows.
    async fn commit_context_transaction(
        &self,
        event: &crate::event::Event,
        attention_updates: &[SessionAttentionUpdate],
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;
    /// Atomically persists a scheduler Signal and, when this Thread has no
    /// queued/running Activation, claims the oldest bounded pending batch into
    /// one new Activation. `None` means the Signal is safely pending behind an
    /// Activation that already owns the Thread.
    async fn claim_thread_signal_batch(
        &self,
        signal: NewThreadSignal,
        activation: NewThreadActivation,
        max_signals: usize,
    ) -> Result<Option<ThreadActivationRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_signal_outbox(
        &self,
        status: SignalOutboxStatus,
        limit: usize,
    ) -> Result<Vec<SignalOutboxRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Reads one stable keyset page of legacy Event-to-Signal handoffs.
    ///
    /// Startup migration must be able to dispatch a page exactly once even
    /// though EventBus business handlers run asynchronously and therefore may
    /// leave that page `pending` for a while. Re-reading the first page until
    /// its status changes both races normal handlers and starves later rows.
    async fn list_signal_outbox_page(
        &self,
        status: SignalOutboxStatus,
        after_created_at: Option<DateTime<Utc>>,
        after_event_id: Option<String>,
        limit: usize,
    ) -> Result<Vec<SignalOutboxRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn discard_signal_outbox(
        &self,
        event_id: &str,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_context_thread_signals(
        &self,
        context_id: &str,
        status: Option<ThreadSignalStatus>,
    ) -> Result<Vec<ThreadSignalRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_context_thread_signals_bounded(
        &self,
        context_id: &str,
        status: Option<ThreadSignalStatus>,
        limit: usize,
    ) -> Result<Vec<ThreadSignalRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let mut records = self.list_context_thread_signals(context_id, status).await?;
        records.truncate(limit);
        Ok(records)
    }
    async fn count_context_activation_authority(
        &self,
        context_id: &str,
    ) -> Result<ActivationContextCounts, Box<dyn std::error::Error + Send + Sync>> {
        let pending_signals = self
            .list_context_thread_signals(context_id, Some(ThreadSignalStatus::Pending))
            .await?
            .len();
        let activations = self
            .list_context_thread_activations(context_id, false)
            .await?;
        Ok(ActivationContextCounts {
            pending_signals,
            queued_activations: activations
                .iter()
                .filter(|activation| activation.status == ThreadActivationStatus::Queued)
                .count(),
            running_activations: activations
                .iter()
                .filter(|activation| activation.status == ThreadActivationStatus::Running)
                .count(),
        })
    }
    async fn has_active_thread_activation_for_session(
        &self,
        context_id: &str,
        session_id: &str,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        Ok(self
            .list_context_thread_activations(context_id, false)
            .await?
            .iter()
            .any(|activation| activation.session_id == session_id))
    }
    /// Bounded cross-Context recovery view for mailbox work which has no
    /// queued/running Activation owner. Immediate EventBus dispatch remains
    /// the normal path; this query closes transient handler failures and
    /// cross-process commit-before-notify windows while the Runtime stays up.
    async fn list_runnable_pending_thread_signals(
        &self,
        _limit: usize,
    ) -> Result<Vec<ThreadSignalRecord>, Box<dyn std::error::Error + Send + Sync>> {
        Ok(Vec::new())
    }
    /// Waits until durable mailbox work may have become runnable. PostgreSQL
    /// overrides this with a commit-visible database notification so a Signal
    /// created by another Runtime process wakes this worker immediately. The
    /// timeout is deliberately retained as a recovery fallback: notifications
    /// accelerate discovery but never become scheduler authority.
    async fn wait_for_thread_signal_change(&self, timeout: std::time::Duration) {
        tokio::time::sleep(timeout).await;
    }
    /// Batch mailbox projection for an already selected Thread aggregate.
    /// Store implementations should override this with one indexed query;
    /// the default preserves compatibility for test stores.
    async fn list_context_thread_signals_for_threads(
        &self,
        context_id: &str,
        thread_ids: &[String],
        status: Option<ThreadSignalStatus>,
    ) -> Result<Vec<ThreadSignalRecord>, Box<dyn std::error::Error + Send + Sync>> {
        if thread_ids.is_empty() {
            return Ok(Vec::new());
        }
        Ok(self
            .list_context_thread_signals(context_id, status)
            .await?
            .into_iter()
            .filter(|signal| thread_ids.contains(&signal.thread_id))
            .collect())
    }
    async fn list_activation_signals(
        &self,
        activation_id: &str,
    ) -> Result<Vec<ThreadSignalRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Reads every Activation -> Signal binding for a selected aggregate in a
    /// single store round trip. The Activation ID is returned alongside the
    /// Signal because one immutable mailbox item may participate in different
    /// historical projections.
    async fn list_activation_signals_for_activations(
        &self,
        activation_ids: &[String],
    ) -> Result<Vec<(String, ThreadSignalRecord)>, Box<dyn std::error::Error + Send + Sync>> {
        let mut records = Vec::new();
        for activation_id in activation_ids {
            records.extend(
                self.list_activation_signals(activation_id)
                    .await?
                    .into_iter()
                    .map(|signal| (activation_id.clone(), signal)),
            );
        }
        Ok(records)
    }
    /// Atomically transfers responsibility for the selected pending mailbox
    /// Signals to one running Activation. Event IDs without a Thread Signal
    /// are ignored because non-waking Tool Outputs are semantic observations,
    /// not scheduler work. A Signal already owned by this Activation is an
    /// idempotent success; ownership by another Activation is a conflict.
    ///
    /// This is the authoritative model-input boundary. Diagnostics may report
    /// which inputs were visible, but scheduler correctness must depend only
    /// on `thread_signals` and `activation_signals`.
    async fn bind_activation_input_signals(
        &self,
        activation_id: &str,
        event_ids: &[String],
    ) -> Result<Vec<ThreadSignalRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn next_pending_thread_signal(
        &self,
        thread_id: &str,
    ) -> Result<Option<ThreadSignalRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn ensure_thread_activation(
        &self,
        activation: NewThreadActivation,
    ) -> Result<ThreadActivationRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_thread_activation(
        &self,
        id: &str,
    ) -> Result<Option<ThreadActivationRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Atomically freezes the logical model route for one Evaluation boundary.
    /// The first non-empty binding wins; later callers observe the persisted
    /// value and must never rewrite an in-flight or recovered Activation.
    async fn bind_thread_activation_model(
        &self,
        id: &str,
        model_alias: &str,
    ) -> Result<Option<ThreadActivationRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Atomically freezes the configured reasoning policy for this Evaluation.
    async fn bind_thread_activation_reasoning_effort(
        &self,
        id: &str,
        reasoning_effort: &str,
    ) -> Result<Option<ThreadActivationRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Exact Activation parents for an already-selected scheduler aggregate.
    async fn list_thread_activations_by_ids(
        &self,
        context_id: &str,
        activation_ids: &[String],
    ) -> Result<Vec<ThreadActivationRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let mut records = Vec::new();
        for activation_id in activation_ids {
            if let Some(activation) = self.get_thread_activation(activation_id).await? {
                if activation.context_id == context_id {
                    records.push(activation);
                }
            }
        }
        Ok(records)
    }
    async fn list_context_thread_activations(
        &self,
        context_id: &str,
        include_terminal: bool,
    ) -> Result<Vec<ThreadActivationRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Newest terminal Activation history for one Context. Operator and
    /// Context projections must use this bounded read instead of materializing
    /// the Context's complete durable history and truncating it in memory.
    async fn list_recent_terminal_thread_activations(
        &self,
        context_id: &str,
        limit: usize,
    ) -> Result<Vec<ThreadActivationRecord>, Box<dyn std::error::Error + Send + Sync>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let mut records = self
            .list_context_thread_activations(context_id, true)
            .await?
            .into_iter()
            .filter(|activation| activation.status.is_terminal())
            .collect::<Vec<_>>();
        records.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        records.truncate(limit);
        Ok(records)
    }
    /// Exact indexed aggregate read used by Thread detail pages.
    async fn list_thread_activations_by_root(
        &self,
        context_id: &str,
        root_turn_id: &str,
    ) -> Result<Vec<ThreadActivationRecord>, Box<dyn std::error::Error + Send + Sync>> {
        Ok(self
            .list_context_thread_activations(context_id, true)
            .await?
            .into_iter()
            .filter(|activation| activation.root_turn_id == root_turn_id)
            .collect())
    }
    /// The immutable first Activation for one logical Thread root.
    ///
    /// Scheduled Threads use a synthetic `root_turn_id`; their original task
    /// is carried by this Activation's trigger Event. Runtime continuation
    /// hydration uses this exact indexed lookup instead of scanning or relying
    /// on whichever Events happen to remain in the active Context projection.
    async fn get_first_thread_activation_by_root(
        &self,
        context_id: &str,
        root_turn_id: &str,
    ) -> Result<Option<ThreadActivationRecord>, Box<dyn std::error::Error + Send + Sync>> {
        Ok(self
            .list_thread_activations_by_root(context_id, root_turn_id)
            .await?
            .into_iter()
            .min_by(|left, right| {
                left.created_at
                    .cmp(&right.created_at)
                    .then_with(|| left.id.cmp(&right.id))
            }))
    }
    /// Exact aggregate read for a bounded set of Thread roots. Production
    /// stores override this with one query so Dashboard history never becomes
    /// one query per Thread.
    async fn list_thread_activations_by_roots(
        &self,
        context_id: &str,
        root_turn_ids: &[String],
    ) -> Result<Vec<ThreadActivationRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let mut records = Vec::new();
        for root_turn_id in root_turn_ids {
            records.extend(
                self.list_thread_activations_by_root(context_id, root_turn_id)
                    .await?,
            );
        }
        Ok(records)
    }
    /// Bounded Scheduler-board aggregate: every live Activation plus the most
    /// recent terminal history for each selected Thread root. Deep Thread
    /// inspection continues to use the exact unbounded method above.
    async fn list_scheduler_thread_activations_by_roots(
        &self,
        context_id: &str,
        root_turn_ids: &[String],
        terminal_limit_per_root: usize,
    ) -> Result<Vec<ThreadActivationRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let mut records = self
            .list_thread_activations_by_roots(context_id, root_turn_ids)
            .await?;
        records.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| right.id.cmp(&left.id))
        });
        let mut terminal_counts = std::collections::HashMap::<String, usize>::new();
        records.retain(|activation| {
            if !activation.status.is_terminal() {
                return true;
            }
            let count = terminal_counts
                .entry(activation.root_turn_id.clone())
                .or_default();
            let retain = *count < terminal_limit_per_root;
            *count = count.saturating_add(1);
            retain
        });
        Ok(records)
    }
    /// Bounded global scheduler projection used by Runtime-level operator
    /// surfaces. It never scans persisted Events.
    async fn list_active_thread_activations(
        &self,
        limit: usize,
    ) -> Result<Vec<ThreadActivationRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Bounded active rows for an already selected operator Context set. The
    /// Context predicate must be applied before LIMIT in production stores.
    async fn list_active_thread_activations_for_contexts(
        &self,
        context_ids: &[String],
        limit: usize,
    ) -> Result<Vec<ThreadActivationRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let selected = context_ids.iter().collect::<std::collections::HashSet<_>>();
        Ok(self
            .list_active_thread_activations(limit)
            .await?
            .into_iter()
            .filter(|record| selected.contains(&record.context_id))
            .collect())
    }
    /// Bounded, globally ordered durable admission source. The returned class
    /// is derived from the immutable Trigger Event by the Runtime-owned policy;
    /// durable age participates in the DB ordering so overflow cannot starve
    /// outside the in-memory window. Declared dialogue/delivery rows retain
    /// their reserved waiting room even when old general rows have aged into
    /// the same effective class. Callers must not scan all Context Events
    /// to rebuild this queue.
    async fn list_queued_thread_activations_for_admission(
        &self,
        limit: usize,
        dialogue_delivery_reserved_queue_slots: usize,
        aging_promotion_interval_ms: u64,
    ) -> Result<
        Vec<(ThreadActivationRecord, crate::admission::AdmissionClass)>,
        Box<dyn std::error::Error + Send + Sync>,
    >;
    /// Whether a queued Activation may attempt the durable `running`
    /// transition now. Non-dialogue Threads are always runnable here.
    ///
    /// DialogueTurns are serialized per Session: a candidate waits while
    /// another DialogueTurn is running and, when several principals have
    /// distinct queued turns in one Session, only the oldest candidate may
    /// enter. The final transition remains protected by
    /// `update_thread_activation`; this query keeps blocked rows out of the
    /// in-memory admission window so they do not busy-loop.
    async fn dialogue_turn_activation_runnable(
        &self,
        activation_id: &str,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>>;
    /// Persistently releases a running DialogueTurn from the per-Session
    /// dialogue lane while its physical work continues. Idempotent: returns
    /// `true` only for the first successful release.
    async fn release_dialogue_turn_activation(
        &self,
        activation_id: &str,
        released_at: DateTime<Utc>,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>>;
    async fn update_thread_activation(
        &self,
        id: &str,
        expected_revision: u64,
        status: ThreadActivationStatus,
        claimed_by: Option<&str>,
        lease_expires_at: Option<DateTime<Utc>>,
        context_snapshot_version: Option<u64>,
    ) -> Result<ThreadActivationMutation, Box<dyn std::error::Error + Send + Sync>>;
    /// Commit the one authoritative outcome boundary for a Thread Activation.
    ///
    /// A terminal outcome marks both Activation and Thread terminal. A
    /// `provider_wait` disposition instead marks only the Activation terminal
    /// and atomically registers a required Thread Resource dependency while
    /// leaving the logical Thread open. Callers must not reproduce either
    /// transition in a second transaction.
    async fn commit_activation_outcome(
        &self,
        activation_id: &str,
        event: &crate::event::Event,
    ) -> Result<ActivationOutcomeCommit, Box<dyn std::error::Error + Send + Sync>>;
    /// Atomically starts a new Evaluation generation for one failed logical
    /// DialogueTurn. The immutable user Event remains the causal root; the
    /// retry Event and its Signal Outbox are committed with the generation
    /// bump, so a crash cannot leave a reopened Thread without a wakeup.
    async fn restart_dialogue_turn(
        &self,
        request: DialogueTurnRetryRequest,
    ) -> Result<DialogueTurnRetryMutation, Box<dyn std::error::Error + Send + Sync>>;
}

/// Durable deterministic control plane for Runtime-owned Yao programs.
///
/// Claim/heartbeat/terminal transitions are fenced exactly like physical
/// Execution Jobs. Suspending a plan does not execute a child itself: it
/// records the Kernel primitive it is waiting for and releases ownership.
#[async_trait::async_trait]
pub trait PlanExecutionStore: Send + Sync {
    /// Idempotent on `(activation_id, tool_call_id)`. Reusing that causal key
    /// with a different program or route is rejected.
    async fn create_plan_execution(
        &self,
        execution: NewPlanExecution,
    ) -> Result<PlanExecutionRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_plan_execution(
        &self,
        id: &str,
    ) -> Result<Option<PlanExecutionRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_plan_executions(
        &self,
        filter: PlanExecutionFilter,
    ) -> Result<Vec<PlanExecutionRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Claims queued work or safely takes over an expired pure-control claim.
    async fn claim_plan_execution(
        &self,
        id: &str,
        expected_revision: u64,
        worker_id: &str,
        claim_token: &str,
        lease_expires_at: DateTime<Utc>,
    ) -> Result<PlanExecutionMutation, Box<dyn std::error::Error + Send + Sync>>;
    async fn heartbeat_plan_execution(
        &self,
        id: &str,
        expected_revision: u64,
        claim_token: &str,
        lease_expires_at: DateTime<Utc>,
        state_json: &JsonValue,
        budget_json: &JsonValue,
    ) -> Result<PlanExecutionMutation, Box<dyn std::error::Error + Send + Sync>>;
    /// Cancellation/error-safe claim release. The exact claim fence must
    /// still be current; otherwise a newer worker or a committed suspension
    /// wins and this operation is rejected without reopening it.
    async fn release_plan_execution_claim(
        &self,
        id: &str,
        expected_revision: u64,
        claim_token: &str,
    ) -> Result<PlanExecutionMutation, Box<dyn std::error::Error + Send + Sync>>;
    /// Releases the claim while waiting on a child primitive that does not
    /// require an additional durable row.
    ///
    /// Physical `call` effects must use
    /// `create_execution_job_and_suspend_plan`; creating the child and
    /// suspending the Plan separately leaves a crash gap.
    #[allow(clippy::too_many_arguments)]
    async fn suspend_plan_execution(
        &self,
        id: &str,
        expected_revision: u64,
        claim_token: &str,
        state_json: &JsonValue,
        budget_json: &JsonValue,
        pending_kind: PlanExecutionWaitKind,
        pending_id: &str,
    ) -> Result<PlanExecutionMutation, Box<dyn std::error::Error + Send + Sync>>;
    /// Atomically materializes one physical child and releases the current
    /// Plan claim into `waiting(execution_job, child.id)`.
    ///
    /// Replaying the exact already-committed hand-off returns `existing`.
    /// A different child, machine state, route or causal identity is rejected.
    #[allow(clippy::too_many_arguments)]
    async fn create_execution_job_and_suspend_plan(
        &self,
        plan_id: &str,
        expected_revision: u64,
        claim_token: &str,
        state_json: &JsonValue,
        budget_json: &JsonValue,
        job: NewExecutionJob,
    ) -> Result<PlanExecutionJobCommit, Box<dyn std::error::Error + Send + Sync>>;
    /// Atomically appends one internal inference request (including its
    /// Scheduler Signal Outbox row) and releases the current Plan claim into
    /// `waiting(evaluation, activation_id)`.
    ///
    /// `activation_id` is the deterministic identity the Scheduler will
    /// derive from `request_event.id`. Exact replay returns `existing`.
    #[allow(clippy::too_many_arguments)]
    async fn create_evaluation_and_suspend_plan(
        &self,
        plan_id: &str,
        expected_revision: u64,
        claim_token: &str,
        state_json: &JsonValue,
        budget_json: &JsonValue,
        request_event: &crate::event::Event,
        activation_id: &str,
    ) -> Result<PlanEvaluationCommit, Box<dyn std::error::Error + Send + Sync>>;
    /// Validates the complete durable route of a waiting deterministic infer
    /// child and returns its Activation. As a narrowly-scoped compatibility
    /// repair, an otherwise exact pre-parent-route row may adopt the Plan's
    /// existing parent Activation when both the Signal and child Activation
    /// parent columns are NULL. Non-NULL conflicts are never rewritten.
    async fn reconcile_plan_evaluation_activation(
        &self,
        plan_id: &str,
        activation_id: &str,
    ) -> Result<Option<ThreadActivationRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Makes a waiting plan runnable after validating the exact child route.
    async fn resume_plan_execution(
        &self,
        id: &str,
        expected_revision: u64,
        pending_kind: PlanExecutionWaitKind,
        pending_id: &str,
        state_json: &JsonValue,
        budget_json: &JsonValue,
    ) -> Result<PlanExecutionMutation, Box<dyn std::error::Error + Send + Sync>>;
    #[allow(clippy::too_many_arguments)]
    async fn finish_plan_execution(
        &self,
        id: &str,
        expected_revision: u64,
        claim_token: &str,
        status: PlanExecutionStatus,
        state_json: &JsonValue,
        budget_json: &JsonValue,
        result_json: Option<&JsonValue>,
        error: Option<&str>,
    ) -> Result<PlanExecutionMutation, Box<dyn std::error::Error + Send + Sync>>;
    async fn cancel_plan_execution(
        &self,
        id: &str,
        expected_revision: u64,
        reason: Option<&str>,
    ) -> Result<PlanExecutionMutation, Box<dyn std::error::Error + Send + Sync>>;
}

/// Durable join authority for independently scheduled sibling Threads.
///
/// Creation is normally part of `commit_schedule_transaction`; these reads
/// and reconciliation operations are shared by Runtime, SDK and operator
/// surfaces so none of them infer group state from Events independently.
#[async_trait::async_trait]
pub trait ThreadGroupStore: Send + Sync {
    async fn get_thread_group(
        &self,
        id: &str,
    ) -> Result<Option<ThreadGroupRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_thread_groups(
        &self,
        filter: ThreadGroupFilter,
    ) -> Result<Vec<ThreadGroupRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn count_context_active_thread_groups(
        &self,
        context_id: &str,
    ) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
        Ok(self
            .list_thread_groups(ThreadGroupFilter {
                context_id: Some(context_id.to_string()),
                include_terminal: false,
                ..ThreadGroupFilter::default()
            })
            .await?
            .len())
    }
    async fn list_thread_groups_by_ids(
        &self,
        context_id: &str,
        group_ids: &[String],
    ) -> Result<Vec<ThreadGroupRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let mut groups = Vec::new();
        for group_id in group_ids {
            if let Some(group) = self.get_thread_group(group_id).await? {
                if group.context_id == context_id {
                    groups.push(group);
                }
            }
        }
        Ok(groups)
    }
    async fn list_thread_group_members(
        &self,
        group_id: &str,
    ) -> Result<Vec<ThreadGroupMemberRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_thread_group_members_for_groups(
        &self,
        group_ids: &[String],
    ) -> Result<Vec<(String, ThreadGroupMemberRecord)>, Box<dyn std::error::Error + Send + Sync>>
    {
        let mut records = Vec::new();
        for group_id in group_ids {
            records.extend(
                self.list_thread_group_members(group_id)
                    .await?
                    .into_iter()
                    .map(|member| (group_id.clone(), member)),
            );
        }
        Ok(records)
    }
    async fn get_thread_outcome(
        &self,
        thread_id: &str,
    ) -> Result<Option<ThreadOutcomeRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Outcomes for a bounded Thread aggregate. Production stores override
    /// this with one indexed query.
    async fn list_thread_outcomes(
        &self,
        thread_ids: &[String],
    ) -> Result<Vec<ThreadOutcomeRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let mut outcomes = Vec::new();
        for thread_id in thread_ids {
            if let Some(outcome) = self.get_thread_outcome(thread_id).await? {
                outcomes.push(outcome);
            }
        }
        Ok(outcomes)
    }
    async fn list_thread_group_outcomes(
        &self,
        group_id: &str,
    ) -> Result<Vec<ThreadOutcomeRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_thread_group_outcomes_for_groups(
        &self,
        group_ids: &[String],
    ) -> Result<Vec<(String, ThreadOutcomeRecord)>, Box<dyn std::error::Error + Send + Sync>> {
        let mut records = Vec::new();
        for group_id in group_ids {
            records.extend(
                self.list_thread_group_outcomes(group_id)
                    .await?
                    .into_iter()
                    .map(|outcome| (group_id.clone(), outcome)),
            );
        }
        Ok(records)
    }
}

/// Stable Thread lifecycle and completion-delivery projection.
#[async_trait::async_trait]
pub trait ThreadStore: Send + Sync {
    async fn ensure_thread(
        &self,
        thread: NewThread,
    ) -> Result<ThreadRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_thread(
        &self,
        id: &str,
    ) -> Result<Option<ThreadRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_thread_by_root(
        &self,
        root_turn_id: &str,
    ) -> Result<Option<ThreadRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Exact parent rows for an already-selected scheduler aggregate.
    async fn list_threads_by_ids(
        &self,
        context_id: &str,
        thread_ids: &[String],
    ) -> Result<Vec<ThreadRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let mut records = Vec::new();
        for thread_id in thread_ids {
            if let Some(thread) = self.get_thread(thread_id).await? {
                if thread.context_id == context_id {
                    records.push(thread);
                }
            }
        }
        Ok(records)
    }
    /// Exact Thread parents for a bounded set of Activation roots.
    async fn list_threads_by_roots(
        &self,
        context_id: &str,
        root_turn_ids: &[String],
    ) -> Result<Vec<ThreadRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let mut records = Vec::new();
        for root_turn_id in root_turn_ids {
            if let Some(thread) = self.get_thread_by_root(root_turn_id).await? {
                if thread.context_id == context_id {
                    records.push(thread);
                }
            }
        }
        Ok(records)
    }
    async fn list_context_threads(
        &self,
        context_id: &str,
        include_terminal: bool,
    ) -> Result<Vec<ThreadRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Threads owned by one Session. Production stores override this with an
    /// indexed query; the default keeps alternate stores source-compatible.
    async fn list_session_threads(
        &self,
        context_id: &str,
        session_id: &str,
        include_terminal: bool,
    ) -> Result<Vec<ThreadRecord>, Box<dyn std::error::Error + Send + Sync>> {
        Ok(self
            .list_context_threads(context_id, include_terminal)
            .await?
            .into_iter()
            .filter(|thread| thread.session_id == session_id)
            .collect())
    }
    async fn list_context_threads_bounded(
        &self,
        context_id: &str,
        include_terminal: bool,
        limit: usize,
    ) -> Result<Vec<ThreadRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let mut records = self
            .list_context_threads(context_id, include_terminal)
            .await?;
        records.truncate(limit);
        Ok(records)
    }
    async fn count_context_open_threads(
        &self,
        context_id: &str,
    ) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
        Ok(self.list_context_threads(context_id, false).await?.len())
    }
    /// Newest terminal Thread history for one Context. This is deliberately
    /// separate from the live projection so idle Contexts do not repeatedly
    /// deserialize their entire lifetime.
    async fn list_recent_terminal_threads(
        &self,
        context_id: &str,
        limit: usize,
    ) -> Result<Vec<ThreadRecord>, Box<dyn std::error::Error + Send + Sync>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let mut records = self
            .list_context_threads(context_id, true)
            .await?
            .into_iter()
            .filter(|thread| thread.lifecycle.is_terminal())
            .collect::<Vec<_>>();
        records.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        records.truncate(limit);
        Ok(records)
    }
    /// Bounded global Thread projection used by Runtime-level operator
    /// surfaces. Terminal history belongs to the Context detail page.
    async fn list_open_threads(
        &self,
        limit: usize,
    ) -> Result<Vec<ThreadRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Bounded open rows for an already selected operator Context set. The
    /// Context predicate must be applied before LIMIT in production stores.
    async fn list_open_threads_for_contexts(
        &self,
        context_ids: &[String],
        limit: usize,
    ) -> Result<Vec<ThreadRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let selected = context_ids.iter().collect::<std::collections::HashSet<_>>();
        Ok(self
            .list_open_threads(limit)
            .await?
            .into_iter()
            .filter(|record| selected.contains(&record.context_id))
            .collect())
    }
    /// Narrow indexed read for completion delivery; avoids scanning every
    /// Thread in a shared Cognitive Context.
    async fn list_session_delivery_threads(
        &self,
        session_id: &str,
        include_deferred: bool,
        limit: usize,
    ) -> Result<Vec<ThreadRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Sessions with recoverable pending/deferred completion results.
    async fn list_pending_delivery_sessions(
        &self,
        limit: usize,
    ) -> Result<Vec<String>, Box<dyn std::error::Error + Send + Sync>>;
    /// Atomically bumps the Session's persistent Delivery Timer generation and
    /// computes its due time from the oldest/newest pending result. The due
    /// time can move with the merge window but never past the first result's
    /// max-wait deadline.
    async fn arm_delivery_flush_timer(
        &self,
        timer_id: &str,
        session_id: &str,
        merge_window_secs: u64,
        max_wait_secs: u64,
        snapshot_max_items: usize,
    ) -> Result<Option<RuntimeTimerRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Generation-fenced, idempotent publication of one Delivery wake Event
    /// and its Signal Outbox row.
    async fn commit_delivery_flush(
        &self,
        timer_id: &str,
        generation: u64,
        event: &crate::event::Event,
        thread: &NewThread,
    ) -> Result<DeliveryFlushCommit, Box<dyn std::error::Error + Send + Sync>>;
    /// Generation-fenced fast path for a Delivery Timer whose immutable
    /// snapshot can be rendered without another model request. The reply Event
    /// and every covered `pending/deferred -> delivered` transition commit in
    /// one transaction.
    async fn commit_delivery_flush_reply(
        &self,
        timer_id: &str,
        generation: u64,
        event: &crate::event::Event,
    ) -> Result<DeliveryFlushCommit, Box<dyn std::error::Error + Send + Sync>>;
    #[allow(clippy::too_many_arguments)]
    async fn update_thread(
        &self,
        id: &str,
        expected_revision: u64,
        kind: Option<ThreadKind>,
        lifecycle: Option<ThreadLifecycle>,
        result_text: Option<&str>,
        result_event_id: Option<&str>,
        delivery_status: Option<DeliveryStatus>,
        delivery_event_id: Option<&str>,
    ) -> Result<ThreadMutation, Box<dyn std::error::Error + Send + Sync>>;
    /// Revision-fenced operator control. Pause/resume only changes scheduler
    /// admission; cancel is terminal and advances the generation fence so late
    /// outcomes from already-running Activations cannot revive the Thread.
    async fn control_thread(
        &self,
        id: &str,
        expected_revision: u64,
        action: ThreadControlAction,
        reason: Option<&str>,
        actor: Option<&str>,
    ) -> Result<ThreadMutation, Box<dyn std::error::Error + Send + Sync>>;
    /// Atomically fences the current physical generation and enqueues the
    /// corrected intent as the first Signal of the next generation. The
    /// logical Thread, Group membership and Supervisor barrier are preserved.
    async fn supersede_thread(
        &self,
        id: &str,
        expected_revision: u64,
        event: &crate::event::Event,
    ) -> Result<ThreadMutation, Box<dyn std::error::Error + Send + Sync>>;
    /// Revision-fenced first binding of a Thread to one physical destination.
    /// A bound Thread cannot be silently moved to a different Target.
    async fn bind_thread_target(
        &self,
        id: &str,
        expected_revision: u64,
        target_id: &str,
    ) -> Result<ThreadMutation, Box<dyn std::error::Error + Send + Sync>>;
}

/// Durable scheduling intentions and their revision-fenced dispatches.
#[async_trait::async_trait]
pub trait ScheduleStore: Send + Sync {
    async fn ensure_schedule(
        &self,
        intent: NewSchedule,
    ) -> Result<ScheduleRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_schedule(
        &self,
        id: &str,
    ) -> Result<Option<ScheduleRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Control-plane read used by `schedule inspect`. It deliberately returns
    /// the revision token required by every subsequent Schedule mutation.
    async fn inspect_schedule(
        &self,
        id: &str,
    ) -> Result<Option<ScheduleRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn pause_schedule(
        &self,
        id: &str,
        expected_revision: u64,
    ) -> Result<ScheduleMutation, Box<dyn std::error::Error + Send + Sync>>;
    async fn resume_schedule(
        &self,
        id: &str,
        expected_revision: u64,
    ) -> Result<ScheduleMutation, Box<dyn std::error::Error + Send + Sync>>;
    /// Replaces the timing rule as one CAS operation. Dependency ownership and
    /// its reverse index are intentionally left untouched, so a timing-only
    /// reschedule cannot partially rewrite dependency routing. A one-shot rule
    /// that already reached `dispatched` cannot be rewound: its Signal is an
    /// immutable physical fact, and replay must use a new Schedule identity.
    async fn reschedule_schedule(
        &self,
        id: &str,
        expected_revision: u64,
        not_before: Option<DateTime<Utc>>,
        interval_seconds: Option<u64>,
    ) -> Result<ScheduleMutation, Box<dyn std::error::Error + Send + Sync>>;
    async fn cancel_schedule(
        &self,
        id: &str,
        expected_revision: u64,
    ) -> Result<ScheduleMutation, Box<dyn std::error::Error + Send + Sync>>;
    /// Atomically creates any new Threads and their queued intents.
    /// Validation happens before commit, so a failed multi-operation
    /// schedule_tx never leaves a partially-created scheduling plan.
    async fn commit_schedule_transaction(
        &self,
        objectives: &[NewScheduledObjective],
        objective_waits: &[ScheduledObjectiveWaitBinding],
        threads: &[NewThread],
        intents: &[NewSchedule],
        groups: &[NewThreadGroupPlan],
    ) -> Result<Vec<ScheduleRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Revision-fenced supervision handoff.  Implementations must update the
    /// Thread, source/target Groups, optional new Objective and immutable audit
    /// Events in one physical database transaction.
    async fn promote_attached_thread(
        &self,
        request: ThreadPromotionRequest,
    ) -> Result<ThreadPromotionMutation, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_schedules(
        &self,
        thread_id: Option<&str>,
        status: Option<ScheduleStatus>,
    ) -> Result<Vec<ScheduleRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Schedule occurrences committed before a crash but not yet delivered to
    /// their still-open Thread. Production stores implement this as an indexed
    /// Event/Thread/Signal anti-join, so restart recovery never scans all
    /// historical `chat/schedule_due` Events.
    async fn list_undelivered_schedule_events(
        &self,
    ) -> Result<Vec<crate::event::Event>, Box<dyn std::error::Error + Send + Sync>> {
        Ok(Vec::new())
    }
    /// Context-scoped schedule projection used by observability surfaces.
    /// The ownership join belongs in SQLite so one Context never scans every
    /// other Agent's scheduled work.
    async fn list_context_schedules(
        &self,
        context_id: &str,
    ) -> Result<Vec<ScheduleRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn count_context_active_schedules(
        &self,
        context_id: &str,
    ) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
        Ok(self
            .list_context_schedules(context_id)
            .await?
            .into_iter()
            .filter(|schedule| {
                matches!(
                    schedule.status,
                    ScheduleStatus::Queued | ScheduleStatus::Paused
                )
            })
            .count())
    }
    /// Schedule projection for an already selected Thread aggregate.
    async fn list_thread_schedules(
        &self,
        context_id: &str,
        thread_ids: &[String],
    ) -> Result<Vec<ScheduleRecord>, Box<dyn std::error::Error + Send + Sync>> {
        if thread_ids.is_empty() {
            return Ok(Vec::new());
        }
        Ok(self
            .list_context_schedules(context_id)
            .await?
            .into_iter()
            .filter(|schedule| thread_ids.contains(&schedule.thread_id))
            .collect())
    }
    /// Advance every queued schedule which names `dependency_thread_id` in
    /// the persistent reverse dependency index. The revision bump fences any
    /// timer generation that may already be claimed while the dependency
    /// crosses its terminal boundary.
    async fn wake_schedules_for_dependency(
        &self,
        dependency_thread_id: &str,
    ) -> Result<Vec<ScheduleRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn claim_schedule(
        &self,
        id: &str,
        expected_revision: u64,
        next_not_before: Option<DateTime<Utc>>,
    ) -> Result<Option<ScheduleRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Atomically advances a due schedule occurrence and appends the wake Event.
    /// The caller must use EventBus::dispatch_persisted after commit.
    async fn commit_scheduled_dispatch(
        &self,
        id: &str,
        expected_revision: u64,
        next_not_before: Option<DateTime<Utc>>,
        event: &crate::event::Event,
        occurrence_thread: Option<&NewThread>,
    ) -> Result<Option<ScheduleRecord>, Box<dyn std::error::Error + Send + Sync>>;
}

/// Atomic user-message ingress and user-visible Thread delivery boundary.
#[async_trait::async_trait]
pub trait DeliveryIngressStore: Send + Sync {
    /// Atomically append one user-visible delivery and mark every covered
    /// completion delivered. A completion can therefore never be delivered by
    /// two concurrent Delivery evaluations.
    async fn commit_thread_delivery(
        &self,
        thread_ids: &[String],
        event: &crate::event::Event,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>>;
    async fn claim_message(
        &self,
        session_id: &str,
        client_message_id: &str,
        event: &crate::event::Event,
        dispatch_mode: MessageDispatchMode,
    ) -> Result<MessageClaim, Box<dyn std::error::Error + Send + Sync>>;
    /// Atomically persist an internal coordination Event and the target
    /// Session's fresh DialogueTurn Signal. The Event is not a User Message
    /// and never participates in interrupt/batch semantics.
    async fn claim_session_signal(
        &self,
        event: &crate::event::Event,
    ) -> Result<SessionSignalClaim, Box<dyn std::error::Error + Send + Sync>>;
    /// Atomically validates and clears one durable checkpoint generation,
    /// persists its Event, and appends the direct Signal to a live Thread.
    async fn claim_background_thread_wake(
        &self,
        event: &crate::event::Event,
        job_id: &str,
        expected_checkpoint_generation: u64,
        thread_id: &str,
    ) -> Result<BackgroundThreadWakeClaim, Box<dyn std::error::Error + Send + Sync>>;
    /// Atomically close a checkpoint that typed routing deliberately cannot
    /// deliver (for example, a terminal supervisor-owned child) and persist
    /// the immutable suppression reason. `false` means the generation was
    /// already stale and no audit fact was created.
    async fn suppress_background_checkpoint(
        &self,
        event: &crate::event::Event,
        job_id: &str,
        expected_checkpoint_generation: u64,
        outcome: &str,
        operator_attention: bool,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>>;
    /// Atomically escalate one durable background-task wake into a fresh
    /// DialogueTurn in the owning Session when the owning Execution Thread is
    /// terminal or missing. The wake Event itself becomes the new
    /// `root_turn_id`; the original Thread/Activation are recorded in the
    /// payload as `source_thread_id`/`source_activation_id`.
    ///
    /// When `expected_checkpoint_generation` is `Some`, the same transaction
    /// validates and clears the Job checkpoint state (`checkpoint_generation`
    /// must still equal that value). Pass `None` for terminal-result Session
    /// fallback: that path must not require a live checkpoint generation and
    /// must not clobber an unrelated armed checkpoint.
    /// Route resolution, Event persistence, DialogueTurn creation, and any
    /// checkpoint clear happen in one transaction, removing the TOCTOU window.
    async fn claim_background_session_wake(
        &self,
        event: &crate::event::Event,
        job_id: &str,
        expected_checkpoint_generation: Option<u64>,
    ) -> Result<BackgroundSessionWakeClaim, Box<dyn std::error::Error + Send + Sync>>;
}

/// Parent/child delegation routing and result handoff.
#[async_trait::async_trait]
pub trait DelegationStore: Send + Sync {
    /// Atomically create the durable routing scaffold for one Delegation.
    /// The child Context must never become externally visible without its
    /// child Session and queued Delegation record: Dashboard/API readers may
    /// observe the Store between later cognitive-seed operations.
    async fn create_delegation_scaffold(
        &self,
        context: NewCognitiveContext,
        session: NewSession,
        delegation: NewDelegation,
    ) -> Result<DelegationRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn create_delegation(
        &self,
        delegation: NewDelegation,
    ) -> Result<DelegationRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_delegation(
        &self,
        id: &str,
    ) -> Result<Option<DelegationRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_delegation_by_child_session(
        &self,
        child_session_id: &str,
    ) -> Result<Option<DelegationRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_delegations(
        &self,
        filter: DelegationFilter,
    ) -> Result<Vec<DelegationRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_recent_delegations(
        &self,
        limit: usize,
    ) -> Result<Vec<DelegationRecord>, Box<dyn std::error::Error + Send + Sync>> {
        self.list_delegations(DelegationFilter {
            include_terminal: true,
            newest_first: true,
            limit: Some(limit),
            ..Default::default()
        })
        .await
    }
    async fn update_delegation_status(
        &self,
        id: &str,
        status: DelegationStatus,
        result_event_id: Option<&str>,
    ) -> Result<Option<DelegationRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Atomically complete one Delegation and enqueue the result Event for its
    /// parent Thread. `false` means another worker already completed it.
    async fn commit_delegation_result(
        &self,
        id: &str,
        event: &crate::event::Event,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>>;
}

/// Complete Session and scheduler authority required by a Runtime backend.
///
/// The capability traits above let a new physical backend land and verify one
/// coherent boundary at a time. This composition remains the product-facing
/// contract, so a partially implemented backend can never be selected by the
/// Runtime.
pub trait SessionStore:
    SessionDirectoryStore
    + ActivationStore
    + ThreadStore
    + ThreadGroupStore
    + ScheduleStore
    + DeliveryIngressStore
    + DelegationStore
{
}

impl<T> SessionStore for T where
    T: SessionDirectoryStore
        + ActivationStore
        + ThreadStore
        + ThreadGroupStore
        + ScheduleStore
        + DeliveryIngressStore
        + DelegationStore
{
}

/// Persistent Objective control plane. Implementations enforce lifecycle and
/// optimistic concurrency; Objective semantics remain in the Context Mind and persisted Events.
#[async_trait::async_trait]
pub trait ObjectiveStore: Send + Sync {
    async fn create_objective(
        &self,
        objective: NewObjective,
    ) -> Result<ObjectiveRecord, Box<dyn std::error::Error + Send + Sync>>;
    /// Creates an Objective and its immutable initialization Events in one
    /// database transaction. The Objective cannot become schedulable before
    /// bindings or other initialization facts are visible.
    async fn create_objective_with_events(
        &self,
        objective: NewObjective,
        events: Vec<crate::event::Event>,
    ) -> Result<ObjectiveRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_objective(
        &self,
        id: &str,
    ) -> Result<Option<ObjectiveRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Exact Objective parents for an already-selected scheduler aggregate.
    async fn list_objectives_by_ids(
        &self,
        context_id: &str,
        objective_ids: &[String],
    ) -> Result<Vec<ObjectiveRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let mut records = Vec::new();
        for objective_id in objective_ids {
            if let Some(objective) = self.get_objective(objective_id).await? {
                if objective.context_id == context_id {
                    records.push(objective);
                }
            }
        }
        Ok(records)
    }
    async fn list_context_objectives(
        &self,
        context_id: &str,
        include_terminal: bool,
    ) -> Result<Vec<ObjectiveRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Objectives coordinated or delivered by one Session. Production stores
    /// override this with indexed coordinator/delivery lookups.
    async fn list_session_objectives(
        &self,
        context_id: &str,
        session_id: &str,
        include_terminal: bool,
    ) -> Result<Vec<ObjectiveRecord>, Box<dyn std::error::Error + Send + Sync>> {
        Ok(self
            .list_context_objectives(context_id, include_terminal)
            .await?
            .into_iter()
            .filter(|objective| {
                objective.coordinator_session_id == session_id
                    || objective.delivery_session_id == session_id
            })
            .collect())
    }
    async fn list_context_objectives_bounded(
        &self,
        context_id: &str,
        include_terminal: bool,
        limit: usize,
    ) -> Result<Vec<ObjectiveRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let mut records = self
            .list_context_objectives(context_id, include_terminal)
            .await?;
        records.truncate(limit);
        Ok(records)
    }
    async fn count_context_objective_readiness(
        &self,
        context_id: &str,
        now: DateTime<Utc>,
    ) -> Result<ObjectiveReadinessCounts, Box<dyn std::error::Error + Send + Sync>> {
        let objectives = self.list_context_objectives(context_id, false).await?;
        let live_objectives = objectives.len();
        let waiting_objectives = objectives
            .iter()
            .filter(|objective| {
                objective.status == ObjectiveStatus::Active
                    && objective.active_evaluation_id.is_some()
                    && objective
                        .evaluation_lease_expires_at
                        .is_some_and(|expires_at| expires_at > now)
            })
            .count();
        Ok(ObjectiveReadinessCounts {
            live_objectives,
            runnable_objectives: live_objectives.saturating_sub(waiting_objectives),
            waiting_objectives,
        })
    }
    async fn list_recoverable_objectives(
        &self,
    ) -> Result<Vec<ObjectiveRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_recoverable_objectives_bounded(
        &self,
        limit: usize,
    ) -> Result<Vec<ObjectiveRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Bounded live Objective rows for an already selected operator Context
    /// set. Production implementations push the Context predicate into SQL.
    async fn list_recoverable_objectives_for_contexts(
        &self,
        context_ids: &[String],
        limit: usize,
    ) -> Result<Vec<ObjectiveRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let selected = context_ids.iter().collect::<std::collections::HashSet<_>>();
        Ok(self
            .list_recoverable_objectives_bounded(limit)
            .await?
            .into_iter()
            .filter(|record| selected.contains(&record.context_id))
            .collect())
    }
    /// Keyset page over live Objective authority for continuous convergence.
    /// Unlike Dashboard's newest-first bounded view, this cursor eventually
    /// visits every active/waiting/leased Objective without lifetime scans,
    /// OFFSET growth, or starvation behind frequently updated rows.
    async fn list_recoverable_objectives_page(
        &self,
        after: Option<&ObjectiveRecoveryCursor>,
        limit: usize,
    ) -> Result<Vec<ObjectiveRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn edit_objective(
        &self,
        id: &str,
        expected_revision: u64,
        stated_objective: &str,
    ) -> Result<ObjectiveMutation, Box<dyn std::error::Error + Send + Sync>>;
    /// Atomically amend the durable Objective contract and enqueue the
    /// authoritative DialogueTurn notification on its primary Thread. The
    /// Event and semantic revision either commit together or not at all.
    async fn amend_objective_with_signal(
        &self,
        id: &str,
        expected_revision: u64,
        stated_objective: &str,
        event: &crate::event::Event,
        thread: &NewThread,
    ) -> Result<ObjectiveMutation, Box<dyn std::error::Error + Send + Sync>>;
    async fn update_objective_state(
        &self,
        id: &str,
        expected_revision: u64,
        status: ObjectiveStatus,
        wait_condition: Option<ObjectiveWaitCondition>,
        reason: Option<&str>,
    ) -> Result<ObjectiveMutation, Box<dyn std::error::Error + Send + Sync>>;
    /// Persist an audited completion decision without ending the Objective or
    /// releasing its Evaluation lease. The matching Activation consumes this
    /// intent when it atomically commits its final outcome.
    #[allow(clippy::too_many_arguments)]
    async fn prepare_objective_completion(
        &self,
        id: &str,
        expected_revision: u64,
        evaluation_id: &str,
        activation_id: &str,
        reason: &str,
        evidence_refs: &[String],
    ) -> Result<ObjectiveMutation, Box<dyn std::error::Error + Send + Sync>>;
    async fn claim_objective_evaluation(
        &self,
        id: &str,
        expected_revision: u64,
        evaluation_id: &str,
        lease_expires_at: DateTime<Utc>,
    ) -> Result<ObjectiveMutation, Box<dyn std::error::Error + Send + Sync>>;
    /// Claim an event-driven Evaluation while preserving the Objective's
    /// current required wait. The exact dependency ID is fenced in the store:
    /// no other pending required dependency may be bypassed by this claim.
    async fn claim_objective_interrupt_evaluation(
        &self,
        id: &str,
        expected_revision: u64,
        evaluation_id: &str,
        lease_expires_at: DateTime<Utc>,
        pending_dependency_id: &str,
    ) -> Result<ObjectiveMutation, Box<dyn std::error::Error + Send + Sync>>;
    /// Atomically claim an Objective evaluation lease and enqueue the
    /// continuation Event that will activate its coordinator Thread.
    async fn claim_objective_evaluation_with_signal(
        &self,
        id: &str,
        expected_revision: u64,
        evaluation_id: &str,
        lease_expires_at: DateTime<Utc>,
        event: &crate::event::Event,
        thread: &NewThread,
    ) -> Result<ObjectiveMutation, Box<dyn std::error::Error + Send + Sync>>;
    /// Extend the lease owned by one exact Evaluation fencing token.
    ///
    /// Lease heartbeats are physical liveness metadata: they deliberately do
    /// not advance the Objective semantic revision seen by the model. A stale
    /// worker whose Evaluation ID has already been replaced must receive a
    /// Conflict and stop before crossing another side-effect boundary.
    async fn renew_objective_evaluation(
        &self,
        id: &str,
        evaluation_id: &str,
        lease_expires_at: DateTime<Utc>,
    ) -> Result<ObjectiveMutation, Box<dyn std::error::Error + Send + Sync>>;
    /// Renew an event-driven Evaluation which deliberately coexists with one
    /// exact required dependency. The dependency fence prevents this physical
    /// lease from turning an unrelated waiting Objective into runnable work.
    async fn renew_objective_interrupt_evaluation(
        &self,
        id: &str,
        evaluation_id: &str,
        lease_expires_at: DateTime<Utc>,
        pending_dependency_id: &str,
    ) -> Result<ObjectiveMutation, Box<dyn std::error::Error + Send + Sync>>;
    /// Records the cost of a complete Prompt prepared for model submission. This accounting does not
    /// alter the Objective's semantic revision and uses Evaluation ID to prevent cross-attribution.
    async fn record_objective_evaluation_usage(
        &self,
        id: &str,
        evaluation_id: &str,
        prompt_tokens_used: u64,
    ) -> Result<ObjectiveMutation, Box<dyn std::error::Error + Send + Sync>>;
    async fn finish_objective_evaluation(
        &self,
        id: &str,
        evaluation_id: &str,
        tokens_used: u64,
        time_used_seconds: u64,
    ) -> Result<ObjectiveMutation, Box<dyn std::error::Error + Send + Sync>>;
}

/// Runtime availability state of one configured model-provider account.
///
/// This is operational state rather than configuration or model-visible
/// memory.  It is persisted so restarts and multiple Runtime workers make the
/// same routing decision instead of reviving an invalid or cooling account.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderAccountStatus {
    Ready,
    Refreshing,
    RateLimited,
    QuotaExhausted,
    Cooldown,
    Invalid,
    Revoked,
    Disabled,
}

impl ProviderAccountStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Refreshing => "refreshing",
            Self::RateLimited => "rate_limited",
            Self::QuotaExhausted => "quota_exhausted",
            Self::Cooldown => "cooldown",
            Self::Invalid => "invalid",
            Self::Revoked => "revoked",
            Self::Disabled => "disabled",
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "ready" => Ok(Self::Ready),
            "refreshing" => Ok(Self::Refreshing),
            "rate_limited" => Ok(Self::RateLimited),
            "quota_exhausted" => Ok(Self::QuotaExhausted),
            "cooldown" => Ok(Self::Cooldown),
            "invalid" => Ok(Self::Invalid),
            "revoked" => Ok(Self::Revoked),
            "disabled" => Ok(Self::Disabled),
            other => Err(format!("unknown Provider Account status '{other}'")),
        }
    }

    pub fn is_selectable(self, cooldown_until: Option<DateTime<Utc>>, now: DateTime<Utc>) -> bool {
        match self {
            Self::Ready => true,
            Self::Cooldown | Self::RateLimited => cooldown_until.is_some_and(|until| until <= now),
            Self::Refreshing
            | Self::QuotaExhausted
            | Self::Invalid
            | Self::Revoked
            | Self::Disabled => false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderAccountStateRecord {
    pub account_id: String,
    pub revision: u64,
    pub status: ProviderAccountStatus,
    pub cooldown_until: Option<DateTime<Utc>>,
    pub last_error_kind: Option<String>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
}

/// Runtime health observed for one Auth Account on one Model Route.
///
/// Authentication and operator authority remain account-global in
/// `ProviderAccountStateRecord`. Rate limits, model quota and transient
/// cooldowns belong here so one physical model cannot fence every other
/// model that happens to share the same gateway credential.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderRouteAccountStateRecord {
    pub route_id: String,
    pub account_id: String,
    pub revision: u64,
    pub status: ProviderAccountStatus,
    pub cooldown_until: Option<DateTime<Utc>>,
    pub last_error_kind: Option<String>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderAccountStateMutation {
    pub expected_revision: Option<u64>,
    pub status: ProviderAccountStatus,
    pub cooldown_until: Option<DateTime<Utc>>,
    pub last_error_kind: Option<String>,
    pub mark_used: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderAccountAffinityRecord {
    pub route_id: String,
    pub scope_key: String,
    pub account_id: String,
    pub revision: u64,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderRefreshLeaseRecord {
    pub account_id: String,
    pub generation: u64,
    pub owner_id: String,
    pub lease_expires_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// One physical model observed from a Provider's remote catalog.
///
/// This projection is deliberately separate from the operator-authored
/// `ModelRouteConfig`: a remote catalog may change at any time, while aliases
/// and routing policy must remain stable and reviewable.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderModelCatalogRecord {
    pub provider_instance_id: String,
    pub auth_account_id: String,
    pub physical_model: String,
    pub adapter_id: String,
    pub adapter_version: String,
    pub protocol: String,
    pub source: String,
    pub observed_at: DateTime<Utc>,
}

#[async_trait::async_trait]
pub trait ProviderModelCatalogStore: Send + Sync {
    // Catalog replacement is an atomic persistence boundary whose provenance fields must remain
    // explicit rather than being partially defaulted by callers.
    #[allow(clippy::too_many_arguments)]
    async fn replace_provider_model_catalog(
        &self,
        provider_instance_id: &str,
        auth_account_id: &str,
        adapter_id: &str,
        adapter_version: &str,
        protocol: &str,
        source: &str,
        physical_models: &[String],
        observed_at: DateTime<Utc>,
    ) -> Result<Vec<ProviderModelCatalogRecord>, Box<dyn std::error::Error + Send + Sync>>;

    async fn list_provider_model_catalog(
        &self,
    ) -> Result<Vec<ProviderModelCatalogRecord>, Box<dyn std::error::Error + Send + Sync>>;
}

/// Durable authority for multi-account routing and OAuth refresh fencing.
#[async_trait::async_trait]
pub trait ProviderAccountStateStore: Send + Sync {
    async fn get_provider_account_state(
        &self,
        account_id: &str,
    ) -> Result<Option<ProviderAccountStateRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn put_provider_account_state(
        &self,
        account_id: &str,
        expected_revision: Option<u64>,
        status: ProviderAccountStatus,
        cooldown_until: Option<DateTime<Utc>>,
        last_error_kind: Option<&str>,
        mark_used: bool,
    ) -> Result<ProviderAccountStateRecord, Box<dyn std::error::Error + Send + Sync>>;
    /// Compare-and-set a Provider Account state. Unlike the compatibility
    /// `put` operation above, `None` explicitly means that the row must not
    /// exist. Runtime observations use this to avoid overwriting newer
    /// operator or OAuth authority changes.
    async fn compare_and_set_provider_account_state(
        &self,
        account_id: &str,
        expected_revision: Option<u64>,
        status: ProviderAccountStatus,
        cooldown_until: Option<DateTime<Utc>>,
        last_error_kind: Option<&str>,
        mark_used: bool,
    ) -> Result<ProviderAccountStateRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_provider_route_account_state(
        &self,
        route_id: &str,
        account_id: &str,
    ) -> Result<Option<ProviderRouteAccountStateRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn compare_and_set_provider_route_account_state(
        &self,
        route_id: &str,
        account_id: &str,
        mutation: ProviderAccountStateMutation,
    ) -> Result<ProviderRouteAccountStateRecord, Box<dyn std::error::Error + Send + Sync>>;
    /// Delete every durable row owned by an Auth Account. OAuth setup uses
    /// this only to migrate records created by older, pre-commit flows.
    async fn delete_provider_account_records(
        &self,
        account_id: &str,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_provider_account_affinity(
        &self,
        route_id: &str,
        scope_key: &str,
    ) -> Result<Option<ProviderAccountAffinityRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn put_provider_account_affinity(
        &self,
        route_id: &str,
        scope_key: &str,
        account_id: &str,
    ) -> Result<ProviderAccountAffinityRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn claim_provider_refresh_lease(
        &self,
        account_id: &str,
        owner_id: &str,
        lease_expires_at: DateTime<Utc>,
    ) -> Result<Option<ProviderRefreshLeaseRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn release_provider_refresh_lease(
        &self,
        account_id: &str,
        generation: u64,
        owner_id: &str,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>>;
}

/// Whether one Store is owned by exactly one Runtime process or coordinates
/// multiple independent Runtime workers. Startup recovery depends on this
/// physical fact: a shared worker must never treat another worker's live lease
/// as evidence of a crash merely because it has just started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerCoordinationMode {
    ExclusiveProcess,
    /// Multiple Runtime processes coordinate through one Store on the same
    /// physical host. A live lease is authoritative, but the operating system
    /// can prove that a local claimant process has exited and allow immediate
    /// recovery without waiting for the lease deadline.
    SharedHostLeases,
    /// Multiple Runtime workers may live on different hosts. The database
    /// lease/heartbeat is the only portable liveness authority.
    SharedLeases,
}

/// Cutoffs for bounded cleanup of records that are explicitly transient and
/// have already lost all authority. Persisted Events and Runtime outcomes are
/// intentionally outside this policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransientStorageRetention {
    pub resolved_signal_outbox_before: DateTime<Utc>,
    pub expired_edge_credentials_before: DateTime<Utc>,
    pub batch_limit: usize,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StorageMaintenanceReport {
    pub resolved_signal_outbox_deleted: u64,
    pub expired_pairing_codes_deleted: u64,
    pub expired_challenges_deleted: u64,
}

/// Bounded, auditable storage hygiene. Implementations may delete only the
/// three transient classes named by `StorageMaintenanceReport`; durable
/// domain history is governed by separate product retention decisions.
#[async_trait::async_trait]
pub trait StorageMaintenanceStore: Send + Sync {
    async fn prune_transient_storage(
        &self,
        policy: TransientStorageRetention,
    ) -> Result<StorageMaintenanceReport, Box<dyn std::error::Error + Send + Sync>>;
}

/// Durable Context-scoped capability modes. Cognitive Coordination uses its
/// binding as the default route for new ordinary user turns: enabled means
/// required network evaluation before local synthesis. This is deliberately
/// separate from Session model routing metadata and from the Agent-owned Mind.
#[async_trait::async_trait]
pub trait ContextCapabilityBindingStore: Send + Sync {
    async fn list_context_capability_bindings(
        &self,
        context_id: &str,
    ) -> Result<Vec<ContextCapabilityBindingRecord>, Box<dyn std::error::Error + Send + Sync>>;

    async fn get_context_capability_binding(
        &self,
        context_id: &str,
        capability_id: &str,
    ) -> Result<Option<ContextCapabilityBindingRecord>, Box<dyn std::error::Error + Send + Sync>>;

    /// Compare-and-swap one binding. A missing binding has revision zero.
    async fn update_context_capability_binding(
        &self,
        context_id: &str,
        capability_id: &str,
        enabled: bool,
        expected_revision: u64,
    ) -> Result<ContextCapabilityBindingMutation, Box<dyn std::error::Error + Send + Sync>>;
}

/// Durable Assignment lifecycle. Assignment identity and contract are
/// immutable after creation; status transitions are revision-fenced so a late
/// result cannot overwrite cancellation or another terminal outcome.
#[async_trait::async_trait]
pub trait WorkAssignmentStore: Send + Sync {
    async fn create_work_assignment(
        &self,
        assignment: NewWorkAssignment,
    ) -> Result<WorkAssignmentCreateResult, Box<dyn std::error::Error + Send + Sync>>;

    async fn get_work_assignment(
        &self,
        id: &str,
    ) -> Result<Option<WorkAssignmentRecord>, Box<dyn std::error::Error + Send + Sync>>;

    async fn list_context_work_assignments(
        &self,
        context_id: &str,
        kind: Option<&str>,
        include_terminal: bool,
        limit: usize,
    ) -> Result<Vec<WorkAssignmentRecord>, Box<dyn std::error::Error + Send + Sync>>;

    async fn list_agent_work_assignments(
        &self,
        agent_id: &str,
        kind: Option<&str>,
        include_terminal: bool,
        limit: usize,
    ) -> Result<Vec<WorkAssignmentRecord>, Box<dyn std::error::Error + Send + Sync>>;

    async fn update_work_assignment(
        &self,
        id: &str,
        mutation: WorkAssignmentMutation,
    ) -> Result<WorkAssignmentMutationResult, Box<dyn std::error::Error + Send + Sync>>;
}

/// Complete durable authority required by one Morphz Runtime worker.
///
/// This capability composition keeps Runtime assembly independent from a
/// concrete database. One implementation must provide every capability so
/// atomic commits never cross unrelated persistence systems.
pub trait RuntimeStore:
    EventStore
    + TimerStore
    + ExecutionTargetStore
    + ExecutionTargetAuthorizationStore
    + EdgeExecutionStore
    + ExecutionJobStore
    + PlanExecutionStore
    + ActionGroupStore
    + ApprovalStore
    + CapabilityLeaseStore
    + ExecutionApprovalStore
    + SessionStore
    + ObjectiveStore
    + MindProjectionStore
    + SessionProjectionStore
    + RecallProjectionStore
    + CognitiveClockStore
    + ProviderAccountStateStore
    + ProviderModelCatalogStore
    + StorageMaintenanceStore
    + ContextCapabilityBindingStore
    + WorkAssignmentStore
    + crate::scheduler::SchedulerDependencyStore
    + Send
    + Sync
{
    fn worker_coordination_mode(&self) -> WorkerCoordinationMode;
}
