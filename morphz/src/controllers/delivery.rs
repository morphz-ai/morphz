use crate::event::Event;
use crate::scheduler::{
    CommitThreadOutcomeCommand, KernelCommand, KernelCommandHeader, KernelCommandPayload,
};

/// Lowers a finite Activation result to the Kernel's atomic
/// Thread/Activation/Group/Dependency/Delivery outcome transaction.
pub struct DeliveryController;

impl DeliveryController {
    pub fn commit_thread_outcome(
        activation_id: &str,
        event: Event,
        context_id: &str,
        actor: &str,
    ) -> KernelCommand {
        let material = format!("commit-outcome\0{activation_id}\0{}", event.id);
        KernelCommand {
            header: KernelCommandHeader::new(
                crate::scheduler::stable_command_id("thread-outcome", &material),
                &event.id,
                context_id,
                actor,
            ),
            payload: KernelCommandPayload::CommitThreadOutcome(CommitThreadOutcomeCommand {
                activation_id: activation_id.to_string(),
                event,
            }),
        }
    }
}
