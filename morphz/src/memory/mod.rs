pub mod postgres;
pub mod sqlite;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LexicalSearchMode {
    SqliteFts5Trigram,
    PostgresPgTrgm,
    DegradedSubstring,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecallIndexCapability {
    pub mode: LexicalSearchMode,
    pub indexed: bool,
    pub unicode_normalization: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecallIndexAudit {
    pub context_id: String,
    pub capability: RecallIndexCapability,
    pub event_documents: u64,
    pub frame_documents: u64,
}

/// Deterministic lexical normalization shared by indexing and querying.
/// NFKC resolves common full-width/half-width variants while lowercase keeps
/// mixed Latin/Chinese lookup stable without inventing business synonyms.
pub fn normalize_recall_text(value: &str) -> String {
    value.nfkc().flat_map(char::to_lowercase).collect()
}

fn collect_recall_scalars(value: &serde_json::Value, output: &mut String) {
    match value {
        serde_json::Value::String(value) => {
            output.push(' ');
            output.push_str(value);
        }
        serde_json::Value::Number(value) => {
            output.push(' ');
            output.push_str(&value.to_string());
        }
        serde_json::Value::Bool(value) => {
            output.push(' ');
            output.push_str(if *value { "true" } else { "false" });
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
    let mut readable = format!("{} {} {}", event.id, event.actor, event.topic);
    collect_recall_scalars(
        &serde_json::Value::Object(event.payload.clone()),
        &mut readable,
    );
    let searchable_text = normalize_recall_text(&readable);
    let preview = readable.chars().take(500).collect::<String>();
    let state_hash = format!(
        "{:x}",
        sha2::Sha256::digest(format!("{searchable_text}\0{retired}").as_bytes())
    );
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
    pub agent_id: String,
    pub context_id: String,
    pub session_id: String,
    pub trigger_event_id: String,
    pub trigger_sequence: u64,
    pub trigger_kind: String,
    pub parent_activation_id: Option<String>,
    pub root_turn_id: String,
    pub context_snapshot_version: Option<u64>,
    pub status: ThreadActivationStatus,
    pub claimed_by: Option<String>,
    pub lease_expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct NewThreadActivation {
    pub id: String,
    pub agent_id: String,
    pub context_id: String,
    pub session_id: String,
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
    Committed,
    Existing { event_id: String },
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
    pub event_id: String,
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
    pub event_id: String,
    pub sequence: u64,
    pub kind: String,
    pub parent_activation_id: Option<String>,
}

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
    pub tool_call_id: String,
    pub tool_name: String,
    pub request: serde_json::Value,
    pub retry_safety: ExecutionRetrySafety,
    pub requires_approval: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ExecutionJobFilter {
    pub context_id: Option<String>,
    pub session_id: Option<String>,
    pub thread_id: Option<String>,
    pub activation_id: Option<String>,
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThreadLifecycle {
    Open,
    Completed,
    Failed,
    Cancelled,
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
    pub agent_id: String,
    pub context_id: String,
    pub session_id: String,
    pub root_turn_id: String,
    pub kind: ThreadKind,
    pub lifecycle: ThreadLifecycle,
    pub executor_kind: String,
    pub executor_id: Option<String>,
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
    pub root_turn_id: String,
    pub kind: ThreadKind,
    pub executor_kind: String,
    pub executor_id: Option<String>,
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

/// An active Objective may sleep on one deterministic wake source. Keeping the
/// wait condition separate from lifecycle status prevents both busy polling and
/// treating ordinary asynchronous waits as permanent blockers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ObjectiveWaitCondition {
    ToolTask {
        task_id: String,
    },
    Delegation {
        delegation_id: String,
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
    pub stated_objective: String,
    pub revision: u64,
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
    pub start_time: Option<DateTime<Utc>>,
    pub end_time: Option<DateTime<Utc>>,
    pub actors: Vec<String>,
    pub types: Vec<String>,
    pub topic: Option<String>, // 支持精准或前缀通配符过滤
    /// Topics which must never be materialized by this query. Exact topics and
    /// `prefix/*` patterns are supported, matching `topic` semantics.
    pub excluded_topics: Vec<String>,
    pub search_query: Option<String>, // 全文检索关键词
    pub top_k: Option<usize>,         // 返回的最相关事件数量限制
    /// Return the newest N events, while preserving chronological order in the
    /// returned vector. This keeps tail reads bounded inside SQLite.
    pub latest_k: Option<usize>,
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
}

/// Rebuildable lexical projection shared by Tool, CLI, HTTP and Dashboard.
/// The Event Ledger and Mind Projection remain authoritative; implementations
/// must keep hot-path upserts in the same database transaction as their source
/// mutation and expose degraded capability explicitly when an indexed backend
/// is unavailable.
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

/// Durable physical execution plane. Every mutating operation is fenced by the
/// Job revision; worker-owned operations additionally require the current claim
/// token. This keeps process ownership separate from semantic Thread outcome.
#[async_trait::async_trait]
pub trait ExecutionJobStore: Send + Sync {
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
    /// Event. `signal_outbox` is true only for a standalone Action whose own
    /// result is the continuation boundary. Group members pass false and arm
    /// exactly one deterministic ActionGroup-settled Event instead.
    #[allow(clippy::too_many_arguments)]
    async fn finish_execution_job_with_event(
        &self,
        id: &str,
        expected_revision: u64,
        claim_token: Option<&str>,
        terminal: ExecutionJobTerminal,
        event: &crate::event::Event,
        signal_outbox: bool,
    ) -> Result<ExecutionJobMutation, Box<dyn std::error::Error + Send + Sync>>;
}

/// Durable coordination authority for sibling Actions emitted by one model
/// response. Individual result Events are immutable and immediately visible;
/// only the final member transition appends the deterministic settled Event
/// and its Signal Outbox.
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
    /// Group and appends `settled_event` with one Signal Outbox record.
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
    async fn update_thread_activation(
        &self,
        id: &str,
        expected_revision: u64,
        status: ThreadActivationStatus,
        claimed_by: Option<&str>,
        lease_expires_at: Option<DateTime<Utc>>,
        context_snapshot_version: Option<u64>,
    ) -> Result<ThreadActivationMutation, Box<dyn std::error::Error + Send + Sync>>;
    /// Claim the one terminal outcome for a Thread Activation and append
    /// it in the same Store transaction.
    async fn commit_activation_outcome(
        &self,
        activation_id: &str,
        event: &crate::event::Event,
    ) -> Result<ActivationOutcomeCommit, Box<dyn std::error::Error + Send + Sync>>;
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
        threads: &[NewThread],
        intents: &[NewSchedule],
    ) -> Result<Vec<ScheduleRecord>, Box<dyn std::error::Error + Send + Sync>>;
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
    + ScheduleStore
    + DeliveryIngressStore
    + DelegationStore
{
}

impl<T> SessionStore for T where
    T: SessionDirectoryStore
        + ActivationStore
        + ThreadStore
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
    + ExecutionJobStore
    + ActionGroupStore
    + ApprovalStore
    + ExecutionApprovalStore
    + SessionStore
    + ObjectiveStore
    + MindProjectionStore
    + SessionProjectionStore
    + RecallProjectionStore
    + CognitiveClockStore
    + Send
    + Sync
{
    fn worker_coordination_mode(&self) -> WorkerCoordinationMode;
}
