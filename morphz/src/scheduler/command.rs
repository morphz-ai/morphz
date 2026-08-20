use crate::memory::{
    ActivationOutcomeCommit, DeliveryFlushCommit, DialogueTurnRetryMutation,
    DialogueTurnRetryRequest, ExecutionJobMutation, ExecutionJobTerminal, NewSchedule,
    NewScheduledObjective, NewThread, NewThreadGroupPlan, ObjectiveMutation, ObjectiveStatus,
    ObjectiveWaitCondition, ScheduleRecord, ScheduledObjectiveWaitBinding,
    ThreadActivationMutation, ThreadActivationStatus, ThreadControlAction, ThreadMutation,
    ThreadPromotionMutation, ThreadPromotionRequest,
};
use crate::scheduler::{
    NewSchedulerDependency, SchedulerDependencyMutation, SchedulerDependencyOwnerKind,
    ThreadResourceWakeCommit,
};
use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};

/// Stable logical command identity derived from immutable policy material.
/// Controller retries therefore hit the same Kernel idempotency fence.
pub fn stable_command_id(namespace: &str, material: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(material.as_bytes()));
    format!("kernel_{namespace}_{}", &digest[..32])
}

/// Stable audit and fencing envelope shared by every Scheduler Kernel command.
///
/// `command_id` is the logical idempotency identity. Entity-specific revisions
/// and generations remain in the payload when one atomic command touches more
/// than one owner; the optional envelope fields are used by single-owner
/// control commands and make omitted fences impossible to hide in a controller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelCommandHeader {
    pub command_id: String,
    pub causation_id: String,
    pub correlation_id: String,
    pub actor: String,
    pub expected_revision: Option<u64>,
    pub generation: Option<u64>,
    pub issued_at: DateTime<Utc>,
}

impl KernelCommandHeader {
    pub fn new(
        command_id: impl Into<String>,
        causation_id: impl Into<String>,
        correlation_id: impl Into<String>,
        actor: impl Into<String>,
    ) -> Self {
        Self {
            command_id: command_id.into(),
            causation_id: causation_id.into(),
            correlation_id: correlation_id.into(),
            actor: actor.into(),
            expected_revision: None,
            generation: None,
            issued_at: Utc::now(),
        }
    }

    pub fn with_fence(mut self, expected_revision: u64, generation: Option<u64>) -> Self {
        self.expected_revision = Some(expected_revision);
        self.generation = generation;
        self
    }

    pub fn with_generation(mut self, generation: u64) -> Self {
        self.generation = Some(generation);
        self
    }
}

#[derive(Debug, Clone)]
pub struct SpawnSupervisedGroupCommand {
    pub objectives: Vec<NewScheduledObjective>,
    pub objective_waits: Vec<ScheduledObjectiveWaitBinding>,
    pub threads: Vec<NewThread>,
    pub schedules: Vec<NewSchedule>,
    pub groups: Vec<NewThreadGroupPlan>,
}

#[derive(Debug, Clone)]
pub struct PromoteThreadCommand {
    pub request: ThreadPromotionRequest,
}

#[derive(Debug, Clone)]
pub struct ControlThreadCommand {
    pub thread_id: String,
    pub action: ThreadControlAction,
    pub reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SupersedeThreadCommand {
    pub thread_id: String,
    pub event: crate::event::Event,
}

#[derive(Debug, Clone)]
pub struct ControlObjectiveCommand {
    pub objective_id: String,
    pub status: ObjectiveStatus,
    /// Migration-only projection field. Scheduler dependencies are the
    /// authoritative readiness facts; this preserves the existing display and
    /// compatibility surface until Phase 2 removes legacy wait writes.
    pub wait_condition: Option<ObjectiveWaitCondition>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ClaimObjectiveEvaluationCommand {
    pub objective_id: String,
    pub evaluation_id: String,
    pub lease_expires_at: DateTime<Utc>,
    /// Exact current-generation required dependency that an event-driven
    /// interrupt Evaluation may coexist with. Ordinary claims leave this
    /// unset and still require the Objective to be fully runnable.
    pub pending_dependency_id: Option<String>,
    /// When present, the Evaluation lease, continuation Event and Objective
    /// Thread are committed as one scheduler transition.
    pub continuation: Option<(crate::event::Event, NewThread)>,
}

#[derive(Debug, Clone)]
pub struct RenewObjectiveEvaluationCommand {
    pub objective_id: String,
    pub evaluation_id: String,
    pub lease_expires_at: DateTime<Utc>,
    pub pending_dependency_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PrepareObjectiveCompletionCommand {
    pub objective_id: String,
    pub evaluation_id: String,
    pub activation_id: String,
    pub reason: String,
    pub evidence_refs: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct FinishObjectiveEvaluationCommand {
    pub objective_id: String,
    pub evaluation_id: String,
    pub tokens_used: u64,
    pub time_used_seconds: u64,
}

#[derive(Debug, Clone)]
pub struct CommitThreadOutcomeCommand {
    pub activation_id: String,
    pub event: crate::event::Event,
}

/// Atomically terminalizes one physical Execution Job together with its
/// immutable result Event and optional exact Thread wakeup.
#[derive(Debug, Clone)]
pub struct CommitExecutionJobOutcomeCommand {
    pub job_id: String,
    pub claim_token: Option<String>,
    pub outcome: ExecutionJobTerminal,
    pub event: Option<crate::event::Event>,
    pub wake_thread: bool,
}

/// Fenced finalization of one Delivery timer generation. A direct reply has
/// no Thread; a model-routed delivery commits its Event and Delivery Thread in
/// the same transaction.
#[derive(Debug, Clone)]
pub struct CommitDeliveryOutcomeCommand {
    pub timer_id: String,
    pub event: crate::event::Event,
    pub delivery_thread: Option<NewThread>,
}

/// Fenced lifecycle/lease transition for one physical Evaluation Activation.
///
/// Activation rows are scheduler authority, not incidental worker metadata:
/// claim, heartbeat, recovery and terminalization must therefore pass through
/// the same Kernel boundary as logical Thread control.
#[derive(Debug, Clone)]
pub struct TransitionActivationCommand {
    pub activation_id: String,
    pub status: ThreadActivationStatus,
    pub claimed_by: Option<String>,
    pub lease_expires_at: Option<DateTime<Utc>>,
    pub context_snapshot_version: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct RestartDialogueTurnCommand {
    pub request: DialogueTurnRetryRequest,
}

#[derive(Debug, Clone)]
pub struct RegisterDependencyCommand {
    pub dependency: NewSchedulerDependency,
}

#[derive(Debug, Clone)]
pub struct SatisfyDependencyCommand {
    pub dependency_id: String,
    pub owner_generation: u64,
    pub dependency_generation: u64,
    pub satisfied_by_event_id: String,
}

#[derive(Debug, Clone)]
pub struct SatisfyThreadResourceDependencyCommand {
    pub dependency_id: String,
    pub owner_generation: u64,
    pub dependency_generation: u64,
    pub satisfied_by_event_id: String,
    pub wake_event: crate::event::Event,
}

#[derive(Debug, Clone)]
// Command variants intentionally carry complete fenced aggregates across the single Kernel boundary.
#[allow(clippy::large_enum_variant)]
pub enum KernelCommandPayload {
    SpawnSupervisedGroup(SpawnSupervisedGroupCommand),
    PromoteThread(PromoteThreadCommand),
    ControlThread(ControlThreadCommand),
    SupersedeThread(SupersedeThreadCommand),
    ControlObjective(ControlObjectiveCommand),
    ClaimObjectiveEvaluation(ClaimObjectiveEvaluationCommand),
    RenewObjectiveEvaluation(RenewObjectiveEvaluationCommand),
    PrepareObjectiveCompletion(PrepareObjectiveCompletionCommand),
    FinishObjectiveEvaluation(FinishObjectiveEvaluationCommand),
    TransitionActivation(TransitionActivationCommand),
    RestartDialogueTurn(RestartDialogueTurnCommand),
    CommitExecutionJobOutcome(CommitExecutionJobOutcomeCommand),
    CommitDeliveryOutcome(CommitDeliveryOutcomeCommand),
    CommitThreadOutcome(CommitThreadOutcomeCommand),
    RegisterDependency(RegisterDependencyCommand),
    SatisfyDependency(SatisfyDependencyCommand),
    SatisfyThreadResourceDependency(SatisfyThreadResourceDependencyCommand),
    CancelDependencies {
        owner_kind: SchedulerDependencyOwnerKind,
        owner_id: String,
        owner_generation: u64,
    },
}

#[derive(Debug, Clone)]
pub struct KernelCommand {
    pub header: KernelCommandHeader,
    pub payload: KernelCommandPayload,
}

#[derive(Debug, Clone, PartialEq)]
// Results return authoritative aggregate snapshots; boxing would spread allocation and unboxing
// through every controller without changing the protocol.
#[allow(clippy::large_enum_variant)]
pub enum KernelResult {
    SupervisedGroupSpawned { schedules: Vec<ScheduleRecord> },
    ThreadPromoted(ThreadPromotionMutation),
    ThreadControlled(ThreadMutation),
    ObjectiveControlled(ObjectiveMutation),
    ObjectiveEvaluationMutated(ObjectiveMutation),
    ActivationTransitioned(ThreadActivationMutation),
    DialogueTurnRestarted(DialogueTurnRetryMutation),
    ExecutionJobOutcomeCommitted(ExecutionJobMutation),
    DeliveryOutcomeCommitted(DeliveryFlushCommit),
    ThreadOutcomeCommitted(ActivationOutcomeCommit),
    DependencyRegistered(SchedulerDependencyMutation),
    DependencySatisfied(SchedulerDependencyMutation),
    ThreadResourceDependencySatisfied(ThreadResourceWakeCommit),
    DependenciesCancelled { count: u64 },
}
