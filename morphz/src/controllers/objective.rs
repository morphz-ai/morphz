use crate::memory::{ObjectiveRecord, ObjectiveStatus, ObjectiveWaitCondition};
use crate::scheduler::{
    derive_objective_readiness, ClaimObjectiveEvaluationCommand, ControlObjectiveCommand,
    FinishObjectiveEvaluationCommand, KernelCommand, KernelCommandHeader, KernelCommandPayload,
    ObjectiveReadiness, RenewObjectiveEvaluationCommand, SatisfyDependencyCommand,
    SchedulerDependencyRecord,
};
use chrono::{DateTime, Utc};

pub struct ObjectiveController;

impl ObjectiveController {
    pub fn claim_evaluation(
        objective: &ObjectiveRecord,
        evaluation_id: &str,
        lease_expires_at: DateTime<Utc>,
        continuation: Option<(crate::event::Event, crate::memory::NewThread)>,
        causation_id: &str,
        actor: &str,
    ) -> KernelCommand {
        let material = format!(
            "objective-claim\0{}\0{}\0{}\0{}",
            objective.id, objective.revision, objective.generation, evaluation_id
        );
        KernelCommand {
            header: KernelCommandHeader::new(
                crate::scheduler::stable_command_id("objective-claim", &material),
                causation_id,
                &objective.context_id,
                actor,
            )
            .with_fence(objective.revision, Some(objective.generation)),
            payload: KernelCommandPayload::ClaimObjectiveEvaluation(
                ClaimObjectiveEvaluationCommand {
                    objective_id: objective.id.clone(),
                    evaluation_id: evaluation_id.to_string(),
                    lease_expires_at,
                    continuation,
                },
            ),
        }
    }

    pub fn renew_evaluation(
        objective: &ObjectiveRecord,
        evaluation_id: &str,
        lease_expires_at: DateTime<Utc>,
        causation_id: &str,
        actor: &str,
    ) -> KernelCommand {
        let material = format!(
            "objective-renew\0{}\0{}\0{}\0{}",
            objective.id, objective.generation, evaluation_id, lease_expires_at
        );
        KernelCommand {
            header: KernelCommandHeader::new(
                crate::scheduler::stable_command_id("objective-renew", &material),
                causation_id,
                &objective.context_id,
                actor,
            )
            .with_fence(objective.revision, Some(objective.generation)),
            payload: KernelCommandPayload::RenewObjectiveEvaluation(
                RenewObjectiveEvaluationCommand {
                    objective_id: objective.id.clone(),
                    evaluation_id: evaluation_id.to_string(),
                    lease_expires_at,
                },
            ),
        }
    }

    pub fn finish_evaluation(
        objective: &ObjectiveRecord,
        evaluation_id: &str,
        tokens_used: u64,
        time_used_seconds: u64,
        causation_id: &str,
        actor: &str,
    ) -> KernelCommand {
        let material = format!(
            "objective-finish\0{}\0{}\0{}\0{}\0{}",
            objective.id, objective.generation, evaluation_id, tokens_used, time_used_seconds
        );
        KernelCommand {
            header: KernelCommandHeader::new(
                crate::scheduler::stable_command_id("objective-finish", &material),
                causation_id,
                &objective.context_id,
                actor,
            )
            .with_fence(objective.revision, Some(objective.generation)),
            payload: KernelCommandPayload::FinishObjectiveEvaluation(
                FinishObjectiveEvaluationCommand {
                    objective_id: objective.id.clone(),
                    evaluation_id: evaluation_id.to_string(),
                    tokens_used,
                    time_used_seconds,
                },
            ),
        }
    }

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
