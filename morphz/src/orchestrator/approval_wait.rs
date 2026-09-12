//! Direct tool batches release their live evaluation stack before the Store
//! commits the approval checkpoint. Nested Plan stacks propagate a distinct
//! control outcome; they do not fabricate terminal tool results. Infer child
//! batches can checkpoint independently; infer parents persist exact dependency
//! edges after child stacks return. Objective ownership is handed off only by
//! the native checkpoint transaction after every live owner is covered.
use super::*;
use crate::memory::{ActivationApprovalWaitChanged, ActivationApprovalWaitRequest};

#[derive(Debug)]
pub(super) struct ReadyToSuspendApprovalBatch {
    pub assistant_call_event_id: String,
    pub pending_approval_ids: Vec<String>,
    pub pending_infer_activation_ids: Vec<String>,
    pub completed_output_event_ids: Vec<String>,
}

impl std::fmt::Display for ReadyToSuspendApprovalBatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Tool batch is ready for a durable human-approval suspension")
    }
}
impl std::error::Error for ReadyToSuspendApprovalBatch {}

#[derive(Debug)]
pub(super) struct DeferredPlanApproval {
    pub approval_ids: Vec<String>,
    pub infer_activation_ids: Vec<String>,
}
impl std::fmt::Display for DeferredPlanApproval {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Plan continuation is waiting on durable human approvals")
    }
}
impl std::error::Error for DeferredPlanApproval {}

impl Orchestrator {
    /// Objective control commits before physical cancellation. A process may
    /// exit between them, leaving a parked batch with no live Future to observe
    /// cancellation. Recover its exact immutable Evaluation binding before
    /// redispatch. The checkpoint, not Session membership or the presence of a
    /// pending approval, supplies ownership; admission remains unchanged.
    pub(super) async fn reconcile_revoked_objective_approval_waits(&self) -> Result<(), DynError> {
        let (Some(store), Some(supervisor)) = (
            self.context_engine.session_store(),
            self.objective_supervisor.as_ref(),
        ) else {
            return Ok(());
        };
        let mut reconciled = HashSet::new();
        for context in store.list_contexts(false).await? {
            for activation in store
                .list_context_thread_activations(&context.id, false)
                .await?
            {
                let Some(wait) = store
                    .get_thread_activation_approval_wait(&activation.id)
                    .await?
                else {
                    continue;
                };
                let call = self
                    .context_engine
                    .find_event(&activation.context_id, &wait.assistant_call_event_id)
                    .await?
                    .ok_or(
                        "Objective approval recovery is missing its immutable assistant batch",
                    )?;
                let outputs = self
                    .store
                    .query(QueryFilter {
                        context_id: Some(activation.context_id.clone()),
                        activation_id: Some(activation.id.clone()),
                        topic: Some("chat/tool_output".into()),
                        ..Default::default()
                    })
                    .await?;
                let Some(binding) =
                    crate::memory::approval_checkpoint_objective_binding(&call, &outputs)?
                else {
                    continue;
                };
                let route = crate::objective::ActiveObjectiveEvaluation::from_event(binding)
                    .ok_or("Objective approval recovery has an invalid Evaluation binding")?;
                let Some(objective) = supervisor.get(&route.objective_id).await? else {
                    return Err(
                        "Objective approval recovery is missing its durable Objective".into(),
                    );
                };
                if objective.agent_id != activation.agent_id
                    || objective.context_id != activation.context_id
                    || objective.coordinator_session_id != activation.session_id
                {
                    return Err("Objective approval recovery has conflicting owner scope".into());
                }
                // Evaluation IDs are fencing tokens and never reused. A
                // subsequent resume cannot make this old batch current again.
                // Stop states also cover an exit before finish_evaluation.
                if objective.active_evaluation_id.as_deref() == Some(route.evaluation_id.as_str())
                    && !matches!(
                        objective.status,
                        crate::memory::ObjectiveStatus::Paused
                            | crate::memory::ObjectiveStatus::Cancelled
                            | crate::memory::ObjectiveStatus::Failed
                    )
                {
                    continue;
                }
                if !reconciled.insert((route.objective_id.clone(), route.evaluation_id.clone())) {
                    continue;
                }
                self.cancel_objective_evaluation(&route.objective_id, &route.evaluation_id)
                    .await?;
                tracing::info!(
                    objective_id = %route.objective_id,
                    evaluation_id = %route.evaluation_id,
                    event_code = "orchestrator.startup.revoked_objective_approval_closed",
                    "Closed approval checkpoints whose Objective Evaluation was revoked before restart"
                );
            }
        }
        Ok(())
    }

    pub(super) async fn can_defer_persisted_plan_approval(
        &self,
        plan_id: &str,
    ) -> Result<bool, DynError> {
        // Persisted ownership matters even before the process-local Objective
        // binding is reconstructed. Keep the loaded Plan off the large outer
        // tool-batch Future's inline layout.
        Ok(match self.plan_store.as_ref() {
            Some(store) => store
                .get_plan_execution(plan_id)
                .await?
                .is_some_and(|plan| self.can_defer_plan_approval(&plan)),
            None => false,
        })
    }

    pub(super) fn can_defer_plan_approval(&self, plan: &PlanExecutionRecord) -> bool {
        self.durable_approvals
            .as_ref()
            .is_some_and(|s| s.durable_human_decisions)
            && self.activation_route(&plan.activation_id).is_some()
    }

    /// All descendant stacks must have returned before their parent releases
    /// its own stack. The native transaction checks durable revisions again.
    pub(super) async fn deferred_plan_approval(
        &self,
        plan: &PlanExecutionRecord,
    ) -> Result<Option<DeferredPlanApproval>, DynError> {
        if !self.can_defer_plan_approval(plan) {
            return Ok(None);
        }
        let Some(store) = self.plan_store.as_ref() else {
            return Ok(None);
        };
        let Some(frontier) = crate::memory::plan_approval_frontier(store.as_ref(), plan).await?
        else {
            return Ok(None);
        };
        if frontier
            .plan_ids
            .iter()
            .any(|id| id != &plan.id && self.plan_child_runners.contains(id))
            || frontier.infer_activation_ids.iter().any(|id| {
                self.activation_routes.contains_key(id)
                    || self.activation_admission_slots.contains_key(id)
            })
        {
            return Ok(None);
        }
        Ok(Some(DeferredPlanApproval {
            approval_ids: frontier.approval_ids,
            infer_activation_ids: frontier.infer_activation_ids,
        }))
    }
    /// `false` means a decision won the race: replay this exact immutable
    /// assistant batch. Completed outputs and claimed grants are not repeated.
    pub(super) async fn checkpoint_tool_approval_wait(
        &self,
        activation_id: &str,
        batch: &ReadyToSuspendApprovalBatch,
    ) -> Result<bool, DynError> {
        let store = self
            .context_engine
            .session_store()
            .ok_or("Approval suspension requires a persistent SessionStore")?;
        for _ in 0..16 {
            let current = store
                .get_thread_activation(activation_id)
                .await?
                .ok_or("Approval suspension Activation disappeared")?;
            let result = store
                .suspend_thread_activation_for_approval(ActivationApprovalWaitRequest {
                    activation_id: activation_id.to_owned(),
                    expected_revision: current.revision,
                    claimed_by: self.runtime_claimant_id.clone(),
                    assistant_call_event_id: batch.assistant_call_event_id.clone(),
                    pending_approval_ids: batch.pending_approval_ids.clone(),
                    pending_infer_activation_ids: batch.pending_infer_activation_ids.clone(),
                    completed_output_event_ids: batch.completed_output_event_ids.clone(),
                })
                .await;
            match result {
                Ok(ThreadActivationMutation::Updated(_)) => {
                    tracing::info!(
                        activation_id,
                        pending_approvals = batch.pending_approval_ids.len(),
                        pending_infer_activations = batch.pending_infer_activation_ids.len(),
                        event_code = "orchestrator.activation.approval_suspended",
                        "Suspended the tool batch on durable human approval dependencies"
                    );
                    return Ok(true);
                }
                Ok(ThreadActivationMutation::Conflict { .. }) => continue,
                Ok(ThreadActivationMutation::NotFound) => {
                    return Err("Approval suspension Activation disappeared".into())
                }
                Err(error)
                    if error
                        .downcast_ref::<ActivationApprovalWaitChanged>()
                        .is_some() =>
                {
                    return Ok(false)
                }
                Err(error)
                    if error
                        .downcast_ref::<crate::memory::ApprovalOwnershipContended>()
                        .is_some() =>
                {
                    // No checkpoint committed. Replay after a bounded delay,
                    // preserving the exact batch and permission decisions.
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    return Ok(false);
                }
                Err(error) => return Err(error),
            }
        }
        Err("Approval suspension could not settle under repeated revision contention".into())
    }

    /// A durable decision is the authority; this notification only reduces
    /// latency in the live host. Startup rescans the same queued rows.
    pub(crate) async fn wake_approval_waits(&self) -> Result<(), DynError> {
        self.refill_activation_admission_queue().await?;
        Ok(())
    }
}
