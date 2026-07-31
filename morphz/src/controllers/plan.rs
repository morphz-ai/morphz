use crate::scheduler::{
    KernelCommand, KernelCommandHeader, KernelCommandPayload, SpawnSupervisedGroupCommand,
};

/// Lowers an already validated Plan/Harness scheduling decision to one atomic
/// Kernel command. It never persists intermediate scheduler state itself.
pub struct PlanController;

impl PlanController {
    pub fn spawn_supervised_group(
        payload: SpawnSupervisedGroupCommand,
        causation_id: &str,
        correlation_id: &str,
        actor: &str,
    ) -> KernelCommand {
        let objective_ids = payload
            .objectives
            .iter()
            .map(|entry| entry.objective.id.as_str())
            .collect::<Vec<_>>()
            .join(",");
        let wait_ids = payload
            .objective_waits
            .iter()
            .map(|entry| format!("{}@{}", entry.objective_id, entry.expected_revision))
            .collect::<Vec<_>>()
            .join(",");
        let thread_ids = payload
            .threads
            .iter()
            .map(|thread| thread.id.as_str())
            .collect::<Vec<_>>()
            .join(",");
        let schedule_ids = payload
            .schedules
            .iter()
            .map(|schedule| schedule.id.as_str())
            .collect::<Vec<_>>()
            .join(",");
        let group_ids = payload
            .groups
            .iter()
            .map(|group| group.group.id.as_str())
            .collect::<Vec<_>>()
            .join(",");
        let material = format!(
            "spawn-supervised-group\0{causation_id}\0{correlation_id}\0{objective_ids}\0{wait_ids}\0{thread_ids}\0{schedule_ids}\0{group_ids}"
        );
        KernelCommand {
            header: KernelCommandHeader::new(
                crate::scheduler::stable_command_id("group-spawn", &material),
                causation_id,
                correlation_id,
                actor,
            ),
            payload: KernelCommandPayload::SpawnSupervisedGroup(payload),
        }
    }
}
