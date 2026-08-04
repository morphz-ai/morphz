use crate::event::Event;
use crate::memory::NewThread;
use crate::scheduler::{
    CommitDeliveryOutcomeCommand, CommitThreadOutcomeCommand, KernelCommand, KernelCommandHeader,
    KernelCommandPayload, SatisfyThreadResourceDependencyCommand,
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

    #[allow(clippy::too_many_arguments)]
    pub fn satisfy_thread_resource_dependency(
        dependency_id: &str,
        owner_generation: u64,
        dependency_generation: u64,
        satisfied_by_event_id: &str,
        wake_event: Event,
        context_id: &str,
        actor: &str,
    ) -> KernelCommand {
        let material = format!(
            "thread-resource-wake\0{dependency_id}\0{owner_generation}\0{dependency_generation}\0{satisfied_by_event_id}\0{}",
            wake_event.id
        );
        KernelCommand {
            header: KernelCommandHeader::new(
                crate::scheduler::stable_command_id("thread-resource-wake", &material),
                satisfied_by_event_id,
                context_id,
                actor,
            )
            .with_generation(owner_generation),
            payload: KernelCommandPayload::SatisfyThreadResourceDependency(
                SatisfyThreadResourceDependencyCommand {
                    dependency_id: dependency_id.to_string(),
                    owner_generation,
                    dependency_generation,
                    satisfied_by_event_id: satisfied_by_event_id.to_string(),
                    wake_event,
                },
            ),
        }
    }
}
