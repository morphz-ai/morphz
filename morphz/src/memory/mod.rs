pub mod sqlite;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

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

#[derive(Debug, Clone)]
pub struct NewCognitiveContext {
    pub id: String,
    pub agent_id: String,
    pub title: String,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActivationSignalRecord {
    pub activation_id: String,
    pub signal_id: String,
    pub ordinal: u64,
}

/// Durable causal lane owned by one Agent. A Work Thread survives all model
/// attempts and tool wakeups produced while completing the same root turn.
/// Attempts are replaceable execution records; this is the stable scheduling
/// and delivery identity.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkThreadKind {
    Dialogue,
    Work,
    Objective,
    Delegation,
    Delivery,
}

impl WorkThreadKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dialogue => "dialogue",
            Self::Work => "work",
            Self::Objective => "objective",
            Self::Delegation => "delegation",
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
pub struct WorkThreadRecord {
    pub id: String,
    pub revision: u64,
    pub agent_id: String,
    pub context_id: String,
    pub session_id: String,
    pub root_turn_id: String,
    pub kind: WorkThreadKind,
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
pub struct NewWorkThread {
    pub id: String,
    pub agent_id: String,
    pub context_id: String,
    pub session_id: String,
    pub root_turn_id: String,
    pub kind: WorkThreadKind,
    pub executor_kind: String,
    pub executor_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkThreadMutation {
    Updated(WorkThreadRecord),
    Conflict { current: WorkThreadRecord },
    NotFound,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScheduledIntentStatus {
    Queued,
    Dispatched,
    Completed,
    Cancelled,
}

impl ScheduledIntentStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Dispatched => "dispatched",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScheduledIntentRecord {
    pub id: String,
    pub revision: u64,
    pub thread_id: String,
    pub source_turn_id: String,
    pub intent: String,
    pub status: ScheduledIntentStatus,
    pub not_before: Option<DateTime<Utc>>,
    pub interval_seconds: Option<u64>,
    pub dependency_thread_ids: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct NewScheduledIntent {
    pub id: String,
    pub thread_id: String,
    pub source_turn_id: String,
    pub intent: String,
    pub not_before: Option<DateTime<Utc>>,
    pub interval_seconds: Option<u64>,
    pub dependency_thread_ids: Vec<String>,
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
    async fn query(
        &self,
        filter: QueryFilter,
    ) -> Result<Vec<crate::event::Event>, Box<dyn std::error::Error + Send + Sync>>;
}

/// Persistent product-level Session directory. It deliberately owns routing and
/// lifecycle metadata only; Mind semantics remain in the Context event stream.
#[async_trait::async_trait]
pub trait SessionStore: Send + Sync {
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
        work_item: NewThreadActivation,
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
    /// it in the same SQLite transaction.
    async fn commit_activation_outcome(
        &self,
        work_item_id: &str,
        event: &crate::event::Event,
    ) -> Result<ActivationOutcomeCommit, Box<dyn std::error::Error + Send + Sync>>;
    async fn ensure_work_thread(
        &self,
        thread: NewWorkThread,
    ) -> Result<WorkThreadRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_work_thread(
        &self,
        id: &str,
    ) -> Result<Option<WorkThreadRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_work_thread_by_root(
        &self,
        root_turn_id: &str,
    ) -> Result<Option<WorkThreadRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_context_work_threads(
        &self,
        context_id: &str,
        include_terminal: bool,
    ) -> Result<Vec<WorkThreadRecord>, Box<dyn std::error::Error + Send + Sync>>;
    #[allow(clippy::too_many_arguments)]
    async fn update_work_thread(
        &self,
        id: &str,
        expected_revision: u64,
        kind: Option<WorkThreadKind>,
        lifecycle: Option<ThreadLifecycle>,
        result_text: Option<&str>,
        result_event_id: Option<&str>,
        delivery_status: Option<DeliveryStatus>,
        delivery_event_id: Option<&str>,
    ) -> Result<WorkThreadMutation, Box<dyn std::error::Error + Send + Sync>>;
    async fn ensure_scheduled_intent(
        &self,
        intent: NewScheduledIntent,
    ) -> Result<ScheduledIntentRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_scheduled_intent(
        &self,
        id: &str,
    ) -> Result<Option<ScheduledIntentRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Atomically creates any new Work Threads and their queued intents.
    /// Validation happens before commit, so a failed multi-operation
    /// schedule_tx never leaves a partially-created scheduling plan.
    async fn commit_schedule_transaction(
        &self,
        threads: &[NewWorkThread],
        intents: &[NewScheduledIntent],
    ) -> Result<Vec<ScheduledIntentRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_scheduled_intents(
        &self,
        thread_id: Option<&str>,
        status: Option<ScheduledIntentStatus>,
    ) -> Result<Vec<ScheduledIntentRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn claim_scheduled_intent(
        &self,
        id: &str,
        expected_revision: u64,
        next_not_before: Option<DateTime<Utc>>,
    ) -> Result<Option<ScheduledIntentRecord>, Box<dyn std::error::Error + Send + Sync>>;
    /// Atomically advances a due schedule occurrence and appends the wake Event.
    /// The caller must use EventBus::dispatch_persisted after commit.
    async fn commit_scheduled_dispatch(
        &self,
        id: &str,
        expected_revision: u64,
        next_not_before: Option<DateTime<Utc>>,
        event: &crate::event::Event,
    ) -> Result<Option<ScheduledIntentRecord>, Box<dyn std::error::Error + Send + Sync>>;
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
