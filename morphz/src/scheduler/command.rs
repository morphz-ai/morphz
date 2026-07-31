use crate::memory::{
    ActivationOutcomeCommit, NewSchedule, NewScheduledObjective, NewThread, NewThreadGroupPlan,
    ObjectiveMutation, ObjectiveStatus, ObjectiveWaitCondition, ScheduleRecord,
    ScheduledObjectiveWaitBinding, ThreadControlAction, ThreadMutation, ThreadPromotionMutation,
    ThreadPromotionRequest,
};
use crate::scheduler::{
    NewSchedulerDependency, SchedulerDependencyMutation, SchedulerDependencyOwnerKind,
};
use chrono::{DateTime, Utc};

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
pub struct CommitThreadOutcomeCommand {
    pub activation_id: String,
    pub event: crate::event::Event,
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
pub enum KernelCommandPayload {
    SpawnSupervisedGroup(SpawnSupervisedGroupCommand),
    PromoteThread(PromoteThreadCommand),
    ControlThread(ControlThreadCommand),
    ControlObjective(ControlObjectiveCommand),
    CommitThreadOutcome(CommitThreadOutcomeCommand),
    RegisterDependency(RegisterDependencyCommand),
    SatisfyDependency(SatisfyDependencyCommand),
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
pub enum KernelResult {
    SupervisedGroupSpawned { schedules: Vec<ScheduleRecord> },
    ThreadPromoted(ThreadPromotionMutation),
    ThreadControlled(ThreadMutation),
    ObjectiveControlled(ObjectiveMutation),
    ThreadOutcomeCommitted(ActivationOutcomeCommit),
    DependencyRegistered(SchedulerDependencyMutation),
    DependencySatisfied(SchedulerDependencyMutation),
    DependenciesCancelled { count: u64 },
}
