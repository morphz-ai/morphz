use crate::memory::{ThreadControlAction, ThreadRecord};
use crate::scheduler::{
    ControlThreadCommand, KernelCommand, KernelCommandHeader, KernelCommandPayload,
};

/// Dialogue/operator policy for controlling a finite Thread. The same
/// revision/generation fencing applies to Dialogue, Execution and Delivery
/// Threads; only the policy caller differs.
pub struct DialogueController;

impl DialogueController {
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
