//! Direct tool batches release their live evaluation stack before the Store
//! commits the approval checkpoint. Parent Plan/Objective waits are not yet
//! eligible and continue to block hosted parking.
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

impl Orchestrator {
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
