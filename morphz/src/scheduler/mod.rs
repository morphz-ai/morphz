//! Deterministic scheduling domain and kernel boundary.
//!
//! Policy layers decide what should happen. This module owns the typed facts
//! used to decide whether that transition is legal and ready to run. Database
//! backends implement the transactional commands in [`kernel`]; controllers
//! must not rebuild these rules from Ledger events.

#[path = "command.rs"]
pub mod commands;
pub mod domain;
pub mod kernel;
pub mod snapshot;
pub mod store;

pub use commands::{
    stable_command_id, ClaimObjectiveEvaluationCommand, CommitDeliveryOutcomeCommand,
    CommitExecutionJobOutcomeCommand, CommitThreadOutcomeCommand, ControlObjectiveCommand,
    ControlThreadCommand, FinishObjectiveEvaluationCommand, KernelCommand, KernelCommandHeader,
    KernelCommandPayload, KernelResult, PrepareObjectiveCompletionCommand, PromoteThreadCommand,
    RegisterDependencyCommand, RenewObjectiveEvaluationCommand, RestartDialogueTurnCommand,
    SatisfyDependencyCommand, SatisfyThreadResourceDependencyCommand, SpawnSupervisedGroupCommand,
    TransitionActivationCommand,
};
pub use domain::{
    audit_scheduler_invariants, derive_objective_readiness, objective_wait_dependency_key,
    stable_scheduler_dependency_id, ObjectiveReadiness, SchedulerDependencyFilter,
    SchedulerDependencyKind, SchedulerDependencyOwnerKind, SchedulerDependencyRecord,
    SchedulerDependencyStatus, SchedulerInvariantCode, SchedulerInvariantInput,
    SchedulerInvariantSeverity, SchedulerInvariantViolation,
};
pub use kernel::{KernelError, SchedulerKernel};
pub use snapshot::{
    job_snapshot, thread_phase, SchedulerActivationSnapshot, SchedulerAdmissionSnapshot,
    SchedulerDeliverySnapshot, SchedulerDetailBounds, SchedulerExternalOutboxSnapshot,
    SchedulerJobSnapshot, SchedulerObjectiveSnapshot, SchedulerQuery, SchedulerResultSnapshot,
    SchedulerSnapshot, SchedulerSummary, SchedulerThreadGroupSnapshot, SchedulerThreadSnapshot,
};
pub use store::{
    NewSchedulerDependency, SchedulerDependencyMutation, SchedulerDependencyStore,
    ThreadResourceWakeCommit,
};
