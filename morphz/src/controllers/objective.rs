use crate::memory::{ObjectiveRecord, ObjectiveStatus, ObjectiveWaitCondition};
use crate::scheduler::{
    derive_objective_readiness, ControlObjectiveCommand, KernelCommand, KernelCommandHeader,
    KernelCommandPayload, ObjectiveReadiness, SatisfyDependencyCommand,
    SchedulerDependencyRecord,
};
use chrono::{DateTime, Utc};

pub struct ObjectiveController;

impl ObjectiveController {
    pub fn readiness(
        objective: &ObjectiveRecord,
        dependencies: &[SchedulerDependencyRecord],
        now: DateTime<Utc>,
    ) -> ObjectiveReadiness {
        derive_objective_readiness(objective, dependencies, now)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn control(
        objective: &ObjectiveRecord,
        status: ObjectiveStatus,
        wait_condition: Option<ObjectiveWaitCondition>,
        reason: Option<String>,
        causation_id: &str,
        actor: &str,
    ) -> KernelCommand {
        let material = format!(
            "control-objective\0{}\0{}\0{}\0{status:?}\0{:?}\0{:?}",
            objective.id, objective.revision, objective.generation, wait_condition, reason
        );
        KernelCommand {
            header: KernelCommandHeader::new(
                crate::scheduler::stable_command_id("objective-control", &material),
                causation_id,
                &objective.context_id,
                actor,
            )
            .with_fence(objective.revision, Some(objective.generation)),
            payload: KernelCommandPayload::ControlObjective(ControlObjectiveCommand {
                objective_id: objective.id.clone(),
                status,
                wait_condition,
                reason,
            }),
        }
    }

    pub fn satisfy_dependency(
        objective: &ObjectiveRecord,
        dependency_id: &str,
        dependency_generation: u64,
        event_id: &str,
        actor: &str,
    ) -> KernelCommand {
        let material = format!(
            "objective-dependency\0{}\0{}\0{}\0{}",
            objective.id, objective.generation, dependency_generation, event_id
        );
        KernelCommand {
            header: KernelCommandHeader::new(
                crate::scheduler::stable_command_id("objective-satisfy", &material),
                event_id,
                &objective.context_id,
                actor,
            )
            .with_fence(objective.revision, Some(objective.generation)),
            payload: KernelCommandPayload::SatisfyDependency(SatisfyDependencyCommand {
                dependency_id: dependency_id.to_string(),
                owner_generation: objective.generation,
                dependency_generation,
                satisfied_by_event_id: event_id.to_string(),
            }),
        }
    }
}
