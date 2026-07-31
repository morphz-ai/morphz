use crate::event::Event;
use crate::memory::NewThread;
use crate::scheduler::{
    CommitDeliveryOutcomeCommand, CommitThreadOutcomeCommand, KernelCommand, KernelCommandHeader,
    KernelCommandPayload,
};

/// Lowers a finite Activation result to the Kernel's atomic
/// Thread/Activation/Group/Dependency/Delivery outcome transaction.
pub struct DeliveryController;

impl DeliveryController {
    pub fn commit_delivery_outcome(
        timer_id: &str,
        generation: u64,
        event: Event,
        delivery_thread: Option<NewThread>,
        session_id: &str,
        actor: &str,
    ) -> KernelCommand {
        let material = format!("{timer_id}\0{generation}\0{}", event.id);
        KernelCommand {
            header: KernelCommandHeader::new(
                crate::scheduler::stable_command_id("delivery-outcome", &material),
                timer_id,
                session_id,
                actor,
            )
            .with_generation(generation),
            payload: KernelCommandPayload::CommitDeliveryOutcome(CommitDeliveryOutcomeCommand {
                timer_id: timer_id.to_string(),
                event,
                delivery_thread,
            }),
        }
    }

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
