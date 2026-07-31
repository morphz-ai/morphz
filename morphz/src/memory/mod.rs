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
    use std::collections::HashSet;

    let mut seen = HashSet::new();
    let terms = query_terms
        .iter()
        .filter(|term| seen.insert(term.as_str()))
        .collect::<Vec<_>>();
    let total_weight = terms
        .iter()
        .map(|term| recall_term_weight(term))
        .sum::<f64>()
        .max(f64::EPSILON);

    let mut ranked = candidates
        .drain(..)
        .map(|candidate| {
            let stored = candidate
                .searchable_text
                .split_whitespace()
                .collect::<HashSet<_>>();
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
            let exact = candidate.hit.document_id == exact_document_id;
            (candidate.hit, exact, matched_count, coverage)
        })
        .collect::<Vec<_>>();

    let minimum_matches = usize::from(terms.len() > 1) + usize::from(!terms.is_empty());
    if !phrase && minimum_matches > 1 {
        let useful = ranked
            .iter()
            .filter(|(_, exact, matched, coverage)| {
                *exact || (*matched >= minimum_matches && *coverage >= 0.25)
            })
            .count();
        if useful > 0 {
            ranked.retain(|(_, exact, matched, coverage)| {
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
            .then_with(|| right.0.score.total_cmp(&left.0.score))
            .then_with(|| right.0.updated_sequence.cmp(&left.0.updated_sequence))
            .then_with(|| left.0.document_id.cmp(&right.0.document_id))
    });
    ranked
        .into_iter()
        .take(limit.clamp(1, 100))
        .map(|(mut hit, exact, _, coverage)| {
            // The public score now has one backend-independent interpretation:
            // exact id first, otherwise distinct query-term coverage.
            hit.score = if exact { 1_000_000.0 } else { coverage };
            hit
        })
        .collect()
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
    /// PostgreSQL full-text search over the same Runtime-segmented terms.
    /// `tsvector` is core PostgreSQL, so this needs no `CREATE EXTENSION`
    /// privilege a managed deployment may not grant.
    PostgresTsvectorSegmented,
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
/// Ledger and Mind commits only enqueue work; this result describes the
/// independent projection work and is never part of domain correctness.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecallProjectionBatch {
    pub claimed: usize,
    pub projected: usize,
    pub skipped: usize,
    pub failed: usize,
}

/// Runtime-owned read model for an operator's acknowledgement of one derived
/// attention fact. The immutable source Event remains in the Ledger.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AttentionAcknowledgementRecord {
    pub event_id: String,
    pub context_id: String,
    pub key: String,
    pub source_kind: String,
    pub source_id: String,
    pub source_revision: u64,
    pub acknowledged_by: String,
    pub rationale: Option<String>,
    pub acknowledged_at: DateTime<Utc>,
}

pub const RECALL_SEARCHABLE_TEXT_MAX_CHARS: usize = 16 * 1024;
pub const RECALL_PREVIEW_MAX_CHARS: usize = 500;

/// Runtime diagnostics and transient scheduler protocol are deliberately not
/// lexical memory. Keeping this allow-list small prevents internal duplicate
/// events and large inspection payloads from dominating Recall.
pub fn event_has_recall_value(event: &crate::event::Event) -> bool {
    matches!(
        event.topic.as_str(),
        "chat/user_message"
            | "chat/reply"
            | "chat/tool_output"
            | "chat/file_change"
            | "chat/outbound_message"
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
    let remaining = RECALL_SEARCHABLE_TEXT_MAX_CHARS.saturating_sub(output.chars().count());
    if remaining == 0 {
        return;
    }
    output.extend(value.chars().take(remaining));
}

fn collect_recall_scalars(value: &serde_json::Value, output: &mut String) {
    if output.chars().count() >= RECALL_SEARCHABLE_TEXT_MAX_CHARS {
        return;
    }
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
        preview,
        retired,
        updated_sequence: sequence,
        state_hash,
    }
}

/// Applies the same hard storage bound to Frame documents prepared by the
/// Context domain. The hash is recomputed so a bounded Projection remains
/// deterministic and rebuildable.
pub fn bound_recall_document(mut document: RecallDocument) -> RecallDocument {
    document.searchable_text = document
        .searchable_text
        .chars()
        .take(RECALL_SEARCHABLE_TEXT_MAX_CHARS)
        .collect();
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
    /// documents are projected automatically when their Ledger row is added.
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
/// The immutable Event Ledger remains the source of truth. This store owns the
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

    /// Lazily installs a projection reconstructed from the Ledger. Concurrent
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ThreadActivationMutation {
    Updated(ThreadActivationRecord),
    Conflict { current: ThreadActivationRecord },
    NotFound,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActivationOutcomeCommit {
    Committed {
        /// Ledger Events whose authoritative Thread Signals were created in
        /// the same transaction. The Runtime only has to notify the live
        /// executor; it must not infer or materialize another route.
        ready_signal_event_ids: Vec<String>,
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

/// Stable scheduler identity for the logical Thread rooted at one immutable
/// Ledger fact.  Ingress, recovery and the Orchestrator must derive the same
/// identity so a crash between durable commit and in-process dispatch cannot
/// create a second Thread.
pub fn stable_thread_id(root_turn_id: &str) -> String {
    let digest = sha2::Sha256::digest(root_turn_id.as_bytes());
    let id = format!("thread_{digest:x}");
    id[..31].to_string()
}

/// Maximum number of consecutive immutable Signals folded into one physical
/// model Activation.  This is a scheduler contract shared by ingress and
/// activation claiming, not an Orchestrator-local tuning knob.
pub const DEFAULT_THREAD_SIGNAL_BATCH_LIMIT: usize = 32;

/// Durable handoff between the immutable Ledger and the Scheduler mailbox.
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
    pub provider_node_id: Option<String>,
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
}

impl PlanExecutionWaitKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ExecutionJob => "execution_job",
            Self::ActionGroup => "action_group",
            Self::Evaluation => "evaluation",
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
    pub include_terminal: bool,
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
        return Err(format!("Thread Group '{}' 尚未终止", group.id));
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
        ThreadSupervisorKind::Evaluation => {
            let parent = parent.ok_or_else(|| {
                format!("Evaluation Thread Group '{}' 缺少父 Thread 投影", group.id)
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
                    "Thread Group '{}' 已终止：{}（{}/{} 成功）",
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
                "Thread Group '{}' 不能由 {:?} supervisor 收口",
                group.id, group.supervisor_kind
            ));
        }
    };
    let mut event =
        crate::event::Event::new(event_id, "Runtime".to_string(), event_type, topic, payload);
    // The barrier is a deterministic projection of the terminal Group, so
    // recovery must reproduce the exact same immutable Event, including its
    // timestamp. Using `Utc::now()` here would make an idempotent repair look
    // like an Event-ID collision on its second pass.
    event.timestamp = group.satisfied_at.unwrap_or(group.updated_at);
    Ok(event)
}

/// Verifies that an already-persisted immutable Event is the terminal barrier
/// represented by the current Thread Group projection.
///
/// Older Runtime builds created the barrier a few milliseconds after storing
/// `satisfied_at`, and some paths used a more specific human-readable `text`.
/// Those fields are immutable historical facts, not reasons to replace the
/// Event. Recovery therefore validates the stable routing/fencing contract and
/// reuses the persisted Event instead of requiring byte-for-byte regeneration.
pub fn validate_thread_group_barrier_event(
    group: &ThreadGroupRecord,
    parent: Option<&ThreadRecord>,
    event: &crate::event::Event,
) -> Result<(), String> {
    let expected = thread_group_barrier_event(group, parent)?;
    if event.id != expected.id
        || event.actor != expected.actor
        || event.event_type != expected.event_type
        || event.topic != expected.topic
    {
        return Err(format!(
            "Thread Group '{}' 的既有 barrier Event '{}' 类型或路由不匹配",
            group.id, event.id
        ));
    }

    let mut stable_keys = vec![
        "context_id",
        "session_id",
        "thread_group_id",
        "thread_group_status",
    ];
    match group.supervisor_kind {
        ThreadSupervisorKind::Evaluation => {
            stable_keys.extend(["thread_id", "root_turn_id", "tool_name", "tool_status"]);
        }
        ThreadSupervisorKind::Objective => {
            stable_keys.extend(["objective_id", "correlation_id"]);
        }
        ThreadSupervisorKind::Runtime => {
            stable_keys.push("runtime_supervisor_id");
        }
        ThreadSupervisorKind::None | ThreadSupervisorKind::Legacy => {
            unreachable!("thread_group_barrier_event 已拒绝无有效 supervisor 的终态 Group")
        }
    }
    for key in stable_keys {
        if event.payload.get(key) != expected.payload.get(key) {
            return Err(format!(
                "Thread Group '{}' 的既有 barrier Event '{}' 字段 '{}' 与权威投影不匹配",
                group.id, event.id, key
            ));
        }
    }
    // `immediate` is the immutable spelling used by the legacy
    // Event→Signal-Outbox bridge. New barriers use `direct_signal` because
    // their mailbox row is committed atomically with the Event. Recovery must
    // accept both historical encodings without trying to overwrite the
    // existing Event ID.
    if !matches!(
        event.payload.get("wake_policy").and_then(JsonValue::as_str),
        Some("immediate" | "direct_signal")
    ) {
        return Err(format!(
            "Thread Group '{}' 的既有 barrier Event '{}' wake_policy 非法",
            group.id, event.id
        ));
    }
    Ok(())
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
    let (topic, event_type) =
        match thread.supervision.supervisor_kind {
            ThreadSupervisorKind::Evaluation => {
                let parent = parent
                    .ok_or_else(|| format!("attached Thread '{}' 缺少父 Thread 投影", thread.id))?;
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
                        "Thread '{}' 已终止：{}",
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
                    JsonValue::String(
                        thread.supervision.supervisor_id.clone().ok_or_else(|| {
                            format!("durable Thread '{}' 缺少 Objective", thread.id)
                        })?,
                    ),
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
                    JsonValue::String(thread.supervision.supervisor_id.clone().ok_or_else(
                        || format!("Runtime Thread '{}' 缺少 supervisor", thread.id),
                    )?),
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
    Objective,
    Delivery,
}

impl ThreadKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DialogueTurn => "dialogue_turn",
            Self::Execution => "execution",
            Self::Objective => "objective",
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
    Evaluation,
    Objective,
    Runtime,
    None,
    Legacy,
}

impl ThreadSupervisorKind {
    pub fn as_str(self) -> &'static str {
        match self {
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
    pub fn evaluation(
        evaluation_id: impl Into<String>,
        parent_thread_id: impl Into<String>,
    ) -> Self {
        let evaluation_id = evaluation_id.into();
        Self {
            lifetime: ThreadLifetime::Attached,
            supervisor_kind: ThreadSupervisorKind::Evaluation,
            supervisor_id: Some(evaluation_id.clone()),
            generation: 1,
            origin_evaluation_id: Some(evaluation_id),
            parent_thread_id: Some(parent_thread_id.into()),
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

    pub fn validate(&self, _kind: ThreadKind) -> Result<(), String> {
        if self.generation == 0 {
            return Err("Thread supervision generation 必须大于 0".to_string());
        }
        match (self.lifetime, self.supervisor_kind) {
            (ThreadLifetime::Attached, ThreadSupervisorKind::Evaluation)
                if self.supervisor_id.is_some()
                    && self.origin_evaluation_id.is_some()
                    && self.parent_thread_id.is_some() => {}
            (ThreadLifetime::Durable, ThreadSupervisorKind::Objective)
                if self.supervisor_id.is_some() && self.origin_evaluation_id.is_some() => {}
            (ThreadLifetime::Durable, ThreadSupervisorKind::Runtime)
                if self.supervisor_id.is_some() => {}
            (ThreadLifetime::Disposable, ThreadSupervisorKind::None)
                if self.supervisor_id.is_none() => {}
            (_, ThreadSupervisorKind::Legacy) => {}
            _ => {
                return Err(format!(
                    "非法 Thread 监督组合: lifetime={}, supervisor={}",
                    self.lifetime.as_str(),
                    self.supervisor_kind.as_str()
                ));
            }
        }
        if self.lifetime == ThreadLifetime::Disposable && self.thread_group_id.is_some() {
            return Err("disposable Thread 不能加入 required Thread Group".to_string());
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
    Close,
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

/// Atomic transfer of one open attached Thread from its owning Evaluation to
/// an Objective.  The source Group member is released in the same transaction
/// which installs the new Objective-owned Group, so neither supervisor can
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
    pub active_evaluation_id: Option<String>,
    pub evaluation_lease_expires_at: Option<DateTime<Utc>>,
    pub continuation_sequence: u64,
    pub token_budget: Option<u64>,
    pub tokens_used: u64,
    pub time_used_seconds: u64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
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
pub enum MessageClaim {
    Accepted,
    Existing { event_id: String },
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
    /// immutable Ledger without offset scans.
    pub before_sequence: Option<u64>,
    pub start_time: Option<DateTime<Utc>>,
    pub end_time: Option<DateTime<Utc>>,
    pub actors: Vec<String>,
    pub types: Vec<String>,
    pub topic: Option<String>, // 支持精准或前缀通配符过滤
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
    pub top_k: Option<usize>, // 返回的最相关事件数量限制
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

// EventStore 定义事件历史物理存储的接口
#[derive(Debug, Clone)]
pub struct EventAppend {
    pub event: crate::event::Event,
    pub signal_outbox: bool,
}

#[async_trait::async_trait]
pub trait EventStore: Send + Sync {
    async fn append(
        &self,
        ev: crate::event::Event,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;
    /// Atomically append an immutable Event and its scheduler-delivery intent.
    /// Repeating the same Event is idempotent; conflicting content is rejected.
    async fn append_with_signal_outbox(
        &self,
        ev: crate::event::Event,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;
    /// Atomically commits an ordered group of immutable Events. Entries which
    /// need scheduler delivery create their signal outbox row in the same
    /// database transaction. A failure rolls back the complete group.
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
    /// must not reconstruct it by scanning the immutable Ledger per request.
    async fn list_attention_acknowledgements(
        &self,
        context_id: &str,
    ) -> Result<Vec<AttentionAcknowledgementRecord>, Box<dyn std::error::Error + Send + Sync>>;
}

/// Rebuildable lexical projection shared by Tool, CLI, HTTP and Dashboard.
/// The Event Ledger and Mind Projection remain authoritative; implementations
/// source mutation only enqueues a lightweight Outbox intent. Expensive text
/// extraction and lexical index writes run independently and may be rebuilt
/// from Ledger + Mind after failure.
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

    /// Replaces the complete rebuildable index for one Context. This is an
    /// explicit maintenance operation and never mutates Ledger or Mind state.
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
/// Context Encoding. The immutable Ledger remains authoritative history;
/// this Projection contains only observations which have not been retired.
#[async_trait::async_trait]
pub trait SessionProjectionStore: Send + Sync {
    async fn query_session_projections(
        &self,
        context_id: &str,
        session_ids: &[String],
        include_context_wide: bool,
    ) -> Result<Vec<crate::event::Event>, Box<dyn std::error::Error + Send + Sync>>;
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
    /// Event which is already present in the Ledger. Unlike normal `finish`,
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
    /// Session mounted to it in the same database transaction; Ledger and
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
    async fn discard_signal_outbox(
        &self,
        event_id: &str,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_context_thread_signals(
        &self,
        context_id: &str,
        status: Option<ThreadSignalStatus>,
    ) -> Result<Vec<ThreadSignalRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_activation_signals(
        &self,
        activation_id: &str,
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
    async fn list_context_thread_activations(
        &self,
        context_id: &str,
        include_terminal: bool,
    ) -> Result<Vec<ThreadActivationRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Bounded global scheduler projection used by Runtime-level operator
    /// surfaces. It never scans the Event Ledger.
    async fn list_active_thread_activations(
        &self,
        limit: usize,
    ) -> Result<Vec<ThreadActivationRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Bounded, globally ordered durable admission source. The returned class
    /// is derived from the immutable Trigger Event by the Runtime-owned policy;
    /// durable age participates in the DB ordering so overflow cannot starve
    /// outside the in-memory window. Declared dialogue/delivery rows retain
    /// their reserved waiting room even when old general rows have aged into
    /// the same effective class. Callers must not scan the Context Event Ledger
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
    /// Commit the one authoritative terminal outcome for a Thread Activation.
    ///
    /// The Store transaction fences the running Activation generation, marks
    /// the Activation and Thread terminal, appends the immutable outcome Event,
    /// acknowledges every claimed input Signal, and advances the supervised
    /// Group/dependency/delivery projections before it commits.  Callers must
    /// not reproduce these state transitions in a second transaction.
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
    async fn list_thread_group_members(
        &self,
        group_id: &str,
    ) -> Result<Vec<ThreadGroupMemberRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_thread_outcome(
        &self,
        thread_id: &str,
    ) -> Result<Option<ThreadOutcomeRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_thread_group_outcomes(
        &self,
        group_id: &str,
    ) -> Result<Vec<ThreadOutcomeRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Idempotently restores the deterministic barrier Event and Signal
    /// Outbox row represented by a terminal Group projection.
    ///
    /// Returns true only when persistent recovery work was performed.
    async fn repair_thread_group_barrier(
        &self,
        group_id: &str,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>>;
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
    async fn list_context_threads(
        &self,
        context_id: &str,
        include_terminal: bool,
    ) -> Result<Vec<ThreadRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Bounded global Thread projection used by Runtime-level operator
    /// surfaces. Terminal history belongs to the Context detail page.
    async fn list_open_threads(
        &self,
        limit: usize,
    ) -> Result<Vec<ThreadRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Narrow indexed read for completion delivery; avoids scanning every
    /// Thread in a shared Cognitive Context.
    async fn list_session_delivery_threads(
        &self,
        session_id: &str,
        include_deferred: bool,
    ) -> Result<Vec<ThreadRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Sessions with recoverable pending/deferred completion results.
    async fn list_pending_delivery_sessions(
        &self,
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
    ) -> Result<Option<RuntimeTimerRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Generation-fenced, idempotent publication of one Delivery wake Event
    /// and its Signal Outbox row.
    async fn commit_delivery_flush(
        &self,
        timer_id: &str,
        generation: u64,
        event: &crate::event::Event,
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
    /// admission; close is terminal and advances the generation fence so late
    /// outcomes from already-running Activations cannot revive the Thread.
    async fn control_thread(
        &self,
        id: &str,
        expected_revision: u64,
        action: ThreadControlAction,
        reason: Option<&str>,
        actor: Option<&str>,
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
    /// Context-scoped schedule projection used by observability surfaces.
    /// The ownership join belongs in SQLite so one Context never scans every
    /// other Agent's scheduled work.
    async fn list_context_schedules(
        &self,
        context_id: &str,
    ) -> Result<Vec<ScheduleRecord>, Box<dyn std::error::Error + Send + Sync>>;
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
    ) -> Result<MessageClaim, Box<dyn std::error::Error + Send + Sync>>;
}

/// Parent/child delegation routing and result handoff.
#[async_trait::async_trait]
pub trait DelegationStore: Send + Sync {
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
    ) -> Result<Vec<DelegationRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_recent_delegations(
        &self,
        limit: usize,
    ) -> Result<Vec<DelegationRecord>, Box<dyn std::error::Error + Send + Sync>>;
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
/// optimistic concurrency; Objective semantics remain in Context Mind/Ledger.
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
    async fn list_context_objectives(
        &self,
        context_id: &str,
        include_terminal: bool,
    ) -> Result<Vec<ObjectiveRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_recoverable_objectives(
        &self,
    ) -> Result<Vec<ObjectiveRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_recoverable_objectives_bounded(
        &self,
        limit: usize,
    ) -> Result<Vec<ObjectiveRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn edit_objective(
        &self,
        id: &str,
        expected_revision: u64,
        stated_objective: &str,
    ) -> Result<ObjectiveMutation, Box<dyn std::error::Error + Send + Sync>>;
    async fn update_objective_state(
        &self,
        id: &str,
        expected_revision: u64,
        status: ObjectiveStatus,
        wait_condition: Option<ObjectiveWaitCondition>,
        reason: Option<&str>,
    ) -> Result<ObjectiveMutation, Box<dyn std::error::Error + Send + Sync>>;
    async fn claim_objective_evaluation(
        &self,
        id: &str,
        expected_revision: u64,
        evaluation_id: &str,
        lease_expires_at: DateTime<Utc>,
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
    /// 记录一次已准备提交给模型的完整 Prompt 成本。该记账不改变
    /// Objective 的语义 revision，并以 Evaluation ID 防止串账。
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
    + crate::scheduler::SchedulerDependencyStore
    + Send
    + Sync
{
    fn worker_coordination_mode(&self) -> WorkerCoordinationMode;
}
