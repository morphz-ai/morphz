use super::{KernelCommand, KernelCommandHeader, KernelCommandPayload, KernelResult};
use crate::memory::RuntimeStore;
use std::fmt;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KernelError {
    InvalidCommand(String),
    StaleFence(String),
    Store(String),
}

impl fmt::Display for KernelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidCommand(message) => {
                write!(formatter, "invalid Scheduler command: {message}")
            }
            Self::StaleFence(message) => write!(formatter, "stale Scheduler fence: {message}"),
            Self::Store(message) => write!(formatter, "Scheduler Kernel store failure: {message}"),
        }
    }
}

impl std::error::Error for KernelError {}

/// The sole deterministic facade for scheduler state mutations.
///
/// Backends still own the physical transaction implementation. The Kernel
/// owns command validation and makes those atomic primitives unavailable to
/// Runtime controllers through an untyped bundle of stores.
pub struct SchedulerKernel {
    store: Arc<dyn RuntimeStore>,
}

impl SchedulerKernel {
    pub fn new(store: Arc<dyn RuntimeStore>) -> Self {
        Self { store }
    }

    pub async fn execute(&self, command: KernelCommand) -> Result<KernelResult, KernelError> {
        validate_header(&command.header)?;
        match command.payload {
            KernelCommandPayload::SpawnSupervisedGroup(payload) => {
                if payload.threads.is_empty() && payload.schedules.is_empty() {
                    return Err(KernelError::InvalidCommand(
                        "SpawnSupervisedGroup requires at least one Thread or Schedule".into(),
                    ));
                }
                let schedules = self
                    .store
                    .commit_schedule_transaction(
                        &payload.objectives,
                        &payload.objective_waits,
                        &payload.threads,
                        &payload.schedules,
                        &payload.groups,
                    )
                    .await
                    .map_err(store_error)?;
                Ok(KernelResult::SupervisedGroupSpawned { schedules })
            }
            KernelCommandPayload::PromoteThread(payload) => {
                let mutation = self
                    .store
                    .promote_attached_thread(payload.request)
                    .await
                    .map_err(store_error)?;
                Ok(KernelResult::ThreadPromoted(mutation))
            }
            KernelCommandPayload::ControlThread(payload) => {
                let expected_revision = required_revision(&command.header)?;
                if let Some(expected_generation) = command.header.generation {
                    if let Some(current) = self
                        .store
                        .get_thread(&payload.thread_id)
                        .await
                        .map_err(store_error)?
                    {
                        if current.generation != expected_generation {
                            return Err(KernelError::StaleFence(format!(
                                "Thread '{}' generation {} != {}",
                                payload.thread_id, current.generation, expected_generation
                            )));
                        }
                    }
                }
                let mutation = self
                    .store
                    .control_thread(
                        &payload.thread_id,
                        expected_revision,
                        payload.action,
                        payload.reason.as_deref(),
                        Some(&command.header.actor),
                    )
                    .await
                    .map_err(store_error)?;
                Ok(KernelResult::ThreadControlled(mutation))
            }
            KernelCommandPayload::ControlObjective(payload) => {
                let expected_revision = required_revision(&command.header)?;
                if let Some(expected_generation) = command.header.generation {
                    if let Some(current) = self
                        .store
                        .get_objective(&payload.objective_id)
                        .await
                        .map_err(store_error)?
                    {
                        if current.generation != expected_generation {
                            return Err(KernelError::StaleFence(format!(
                                "Objective '{}' generation {} != {}",
                                payload.objective_id, current.generation, expected_generation
                            )));
                        }
                    }
                }
                let mutation = self
                    .store
                    .update_objective_state(
                        &payload.objective_id,
                        expected_revision,
                        payload.status,
                        payload.wait_condition,
                        payload.reason.as_deref(),
                    )
                    .await
                    .map_err(store_error)?;
                Ok(KernelResult::ObjectiveControlled(mutation))
            }
            KernelCommandPayload::CommitThreadOutcome(payload) => {
                let outcome = self
                    .store
                    .commit_activation_outcome(&payload.activation_id, &payload.event)
                    .await
                    .map_err(store_error)?;
                Ok(KernelResult::ThreadOutcomeCommitted(outcome))
            }
            KernelCommandPayload::RegisterDependency(payload) => {
                let mutation = self
                    .store
                    .register_scheduler_dependency(payload.dependency)
                    .await
                    .map_err(store_error)?;
                Ok(KernelResult::DependencyRegistered(mutation))
            }
            KernelCommandPayload::SatisfyDependency(payload) => {
                let mutation = self
                    .store
                    .satisfy_scheduler_dependency(
                        &payload.dependency_id,
                        payload.owner_generation,
                        payload.dependency_generation,
                        &payload.satisfied_by_event_id,
                    )
                    .await
                    .map_err(store_error)?;
                Ok(KernelResult::DependencySatisfied(mutation))
            }
            KernelCommandPayload::CancelDependencies {
                owner_kind,
                owner_id,
                owner_generation,
            } => {
                let count = self
                    .store
                    .cancel_scheduler_dependencies(owner_kind, &owner_id, owner_generation)
                    .await
                    .map_err(store_error)?;
                Ok(KernelResult::DependenciesCancelled { count })
            }
        }
    }
}

fn validate_header(header: &KernelCommandHeader) -> Result<(), KernelError> {
    for (name, value) in [
        ("command_id", header.command_id.as_str()),
        ("causation_id", header.causation_id.as_str()),
        ("correlation_id", header.correlation_id.as_str()),
        ("actor", header.actor.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(KernelError::InvalidCommand(format!(
                "{name} must not be empty"
            )));
        }
    }
    Ok(())
}

fn required_revision(header: &KernelCommandHeader) -> Result<u64, KernelError> {
    header.expected_revision.ok_or_else(|| {
        KernelError::InvalidCommand("expected_revision is required for control commands".into())
    })
}

fn store_error(error: Box<dyn std::error::Error + Send + Sync>) -> KernelError {
    KernelError::Store(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::sqlite::SqliteStore;
    use crate::scheduler::{
        ControlThreadCommand, KernelCommandPayload, NewSchedulerDependency,
        RegisterDependencyCommand, SchedulerDependencyKind, SchedulerDependencyMutation,
        SchedulerDependencyOwnerKind,
    };
    use chrono::Utc;
    use serde_json::json;

    #[test]
    fn rejects_missing_command_identity_before_store_access() {
        let header = KernelCommandHeader {
            command_id: String::new(),
            causation_id: "cause".into(),
            correlation_id: "correlation".into(),
            actor: "test".into(),
            expected_revision: Some(1),
            generation: Some(1),
            issued_at: Utc::now(),
        };
        let result = validate_header(&header);
        assert!(matches!(result, Err(KernelError::InvalidCommand(_))));
    }

    #[test]
    fn control_command_requires_revision_fence() {
        let command = KernelCommand {
            header: KernelCommandHeader::new("command", "cause", "correlation", "test"),
            payload: KernelCommandPayload::ControlThread(ControlThreadCommand {
                thread_id: "thread".into(),
                action: crate::memory::ThreadControlAction::Pause,
                reason: None,
            }),
        };
        assert!(matches!(
            required_revision(&command.header),
            Err(KernelError::InvalidCommand(_))
        ));
    }

    #[tokio::test]
    async fn exact_dependency_command_replay_is_idempotent_in_sqlite() {
        let database = tempfile::NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(database.path().to_string_lossy().as_ref())
                .await
                .unwrap(),
        );
        let kernel = SchedulerKernel::new(store as Arc<dyn RuntimeStore>);
        let dependency = NewSchedulerDependency {
            id: "dependency-command-replay".into(),
            owner_kind: SchedulerDependencyOwnerKind::Objective,
            owner_id: "objective-command-replay".into(),
            owner_generation: 1,
            dependency_kind: SchedulerDependencyKind::Resource,
            dependency_id: "provider:test".into(),
            dependency_generation: 1,
            required: true,
            metadata: json!({"test": true}),
        };
        let command = KernelCommand {
            header: KernelCommandHeader::new(
                "command-register-dependency",
                "test-cause",
                "test-correlation",
                "Kernel-Test",
            ),
            payload: KernelCommandPayload::RegisterDependency(RegisterDependencyCommand {
                dependency,
            }),
        };

        let first = kernel.execute(command.clone()).await.unwrap();
        let second = kernel.execute(command).await.unwrap();
        assert!(matches!(
            first,
            KernelResult::DependencyRegistered(SchedulerDependencyMutation::Updated(_))
        ));
        assert!(matches!(
            second,
            KernelResult::DependencyRegistered(SchedulerDependencyMutation::Existing(_))
        ));
    }
}
