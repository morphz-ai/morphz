use crate::memory::{
    ThreadActivationRecord, ThreadActivationStatus, ThreadControlAction, ThreadRecord,
};
use crate::scheduler::{
    ControlThreadCommand, KernelCommand, KernelCommandHeader, KernelCommandPayload,
    TransitionActivationCommand,
};
use chrono::{DateTime, Utc};

/// Dialogue/operator policy for controlling a finite Thread. The same
/// revision/generation fencing applies to Dialogue, Execution and Delivery
/// Threads; only the policy caller differs.
pub struct DialogueController;

impl DialogueController {
    pub fn transition_activation(
        activation: &ThreadActivationRecord,
        status: ThreadActivationStatus,
        claimed_by: Option<String>,
        lease_expires_at: Option<DateTime<Utc>>,
        context_snapshot_version: Option<u64>,
        causation_id: &str,
        actor: &str,
    ) -> KernelCommand {
        let material = format!(
            "activation-transition\0{}\0{}\0{}\0{}\0{:?}\0{:?}\0{:?}",
            activation.id,
            activation.revision,
            activation.generation,
            status.as_str(),
            claimed_by,
            lease_expires_at,
            context_snapshot_version
        );
        KernelCommand {
            header: KernelCommandHeader::new(
                crate::scheduler::stable_command_id("activation-transition", &material),
                causation_id,
                &activation.context_id,
                actor,
            )
            .with_fence(activation.revision, Some(activation.generation)),
            payload: KernelCommandPayload::TransitionActivation(TransitionActivationCommand {
                activation_id: activation.id.clone(),
                status,
                claimed_by,
                lease_expires_at,
                context_snapshot_version,
            }),
        }
    }

    pub fn control_thread(
        thread: &ThreadRecord,
        context_id: &str,
        action: ThreadControlAction,
        reason: impl Into<String>,
        actor: &str,
    ) -> KernelCommand {
        let reason = reason.into();
        let material = format!(
            "control-thread\0{}\0{}\0{}\0{action:?}\0{reason}",
            thread.id, thread.revision, thread.generation
        );
        KernelCommand {
            header: KernelCommandHeader::new(
                crate::scheduler::stable_command_id("thread-control", &material),
                &thread.id,
                context_id,
                actor,
            )
            .with_fence(thread.revision, Some(thread.generation)),
            payload: KernelCommandPayload::ControlThread(ControlThreadCommand {
                thread_id: thread.id.clone(),
                action,
                reason: Some(reason),
            }),
        }
    }
}
