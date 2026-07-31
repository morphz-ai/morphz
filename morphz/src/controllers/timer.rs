use crate::scheduler::{
    KernelCommand, KernelCommandHeader, KernelCommandPayload, SatisfyDependencyCommand,
};

/// Converts an authoritative Timer firing fact into a generation-fenced
/// dependency transition. Timer claim/retry remains physical recovery work.
pub struct TimerController;

impl TimerController {
    #[allow(clippy::too_many_arguments)]
    pub fn satisfy_dependency(
        dependency_id: &str,
        owner_generation: u64,
        dependency_generation: u64,
        event_id: &str,
        context_id: &str,
        actor: &str,
    ) -> KernelCommand {
        let material = format!(
            "timer-dependency\0{dependency_id}\0{owner_generation}\0{dependency_generation}\0{event_id}"
        );
        KernelCommand {
            header: KernelCommandHeader::new(
                crate::scheduler::stable_command_id("timer-satisfy", &material),
                event_id,
                context_id,
                actor,
            ),
            payload: KernelCommandPayload::SatisfyDependency(SatisfyDependencyCommand {
                dependency_id: dependency_id.to_string(),
                owner_generation,
                dependency_generation,
                satisfied_by_event_id: event_id.to_string(),
            }),
        }
    }
}
