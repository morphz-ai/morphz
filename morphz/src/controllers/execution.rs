use crate::event::Event;
use crate::memory::ExecutionJobTerminal;
use crate::scheduler::{
    CommitExecutionJobOutcomeCommand, KernelCommand, KernelCommandHeader, KernelCommandPayload,
};

/// Lowers one physical Execution Job terminal result to the Kernel's atomic
/// Job/Event/Thread-Signal transaction.
pub struct ExecutionController;

impl ExecutionController {
    #[allow(clippy::too_many_arguments)]
    pub fn commit_job_outcome(
        job_id: &str,
        expected_revision: u64,
        claim_token: Option<&str>,
        outcome: ExecutionJobTerminal,
        event: Option<Event>,
        wake_thread: bool,
        actor: &str,
    ) -> KernelCommand {
        let event_id = event
            .as_ref()
            .map(|event| event.id.as_str())
            .unwrap_or("no-event");
        let result_refs = outcome.result_refs.join("\0");
        let material = format!(
            "execution-job-outcome\0{job_id}\0{expected_revision}\0{event_id}\0{}\0{:?}\0{}\0{:?}\0{:?}\0{wake_thread}",
            outcome.status.as_str(),
            outcome.result_event_id,
            result_refs,
            outcome.error,
            outcome.exit_code,
        );
        KernelCommand {
            header: KernelCommandHeader::new(
                crate::scheduler::stable_command_id("execution-job-outcome", &material),
                event_id,
                job_id,
                actor,
            )
            .with_fence(expected_revision, None),
            payload: KernelCommandPayload::CommitExecutionJobOutcome(
                CommitExecutionJobOutcomeCommand {
                    job_id: job_id.to_string(),
                    claim_token: claim_token.map(str::to_string),
                    outcome,
                    event,
                    wake_thread,
                },
            ),
        }
    }
}
