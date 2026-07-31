//! Deterministic scheduling domain and kernel boundary.
//!
//! Policy layers decide what should happen. This module owns the typed facts
//! used to decide whether that transition is legal and ready to run. Database
//! backends implement the transactional commands in [`kernel`]; controllers
//! must not rebuild these rules from Ledger events.

pub mod command;
pub mod domain;
pub mod kernel;
pub mod store;

pub use command::{
    CommitThreadOutcomeCommand, ControlObjectiveCommand, ControlThreadCommand, KernelCommand,
    KernelCommandHeader, KernelCommandPayload, KernelResult, PromoteThreadCommand,
    RegisterDependencyCommand, SatisfyDependencyCommand, SpawnSupervisedGroupCommand,
};
pub use domain::{
    audit_scheduler_invariants, derive_objective_readiness, stable_scheduler_dependency_id,
    ObjectiveReadiness, SchedulerDependencyFilter, SchedulerDependencyKind,
    SchedulerDependencyOwnerKind, SchedulerDependencyRecord, SchedulerDependencyStatus,
    SchedulerInvariantCode, SchedulerInvariantInput, SchedulerInvariantSeverity,
    SchedulerInvariantViolation,
};
pub use kernel::{KernelError, SchedulerKernel};
pub use store::{NewSchedulerDependency, SchedulerDependencyMutation, SchedulerDependencyStore};
