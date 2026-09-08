//! Direct tool batches release their live evaluation stack before the Store
//! commits the approval checkpoint. Nested Plan stacks propagate a distinct
//! control outcome; they do not fabricate terminal tool results. Infer-child
//! and Objective Evaluation parent waits remain separate integration gates.
use super::*;
use crate::memory::{ActivationApprovalWaitChanged, ActivationApprovalWaitRequest};

#[derive(Debug)]
pub(super) struct ReadyToSuspendApprovalBatch {
    pub assistant_call_event_id: String,
    pub pending_approval_ids: Vec<String>,
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
}
impl std::fmt::Display for DeferredPlanApproval {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Plan continuation is waiting on durable human approvals")
    }
}
impl std::error::Error for DeferredPlanApproval {}

impl Orchestrator {
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
        plan.objective_evaluation_id.is_none()
            && self
                .durable_approvals
                .as_ref()
                .is_some_and(|s| s.durable_human_decisions)
            && self
                .objective_evaluations
                .get_for_activation(&plan.activation_id)
                .is_none()
            && self
                .activation_route(&plan.activation_id)
                .is_some_and(|r| !r.internal_child_handoff)
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
        {
            return Ok(None);
        }
        Ok(Some(DeferredPlanApproval {
            approval_ids: frontier.approval_ids,
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
                    completed_output_event_ids: batch.completed_output_event_ids.clone(),
                })
                .await;
            match result {
                Ok(ThreadActivationMutation::Updated(_)) => {
                    tracing::info!(
                        activation_id,
                        pending_approvals = batch.pending_approval_ids.len(),
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
