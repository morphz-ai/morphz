use crate::model::{ExecutionResult, FailureKind};
use crate::retry::{can_retry, retry_delay_ms};
use crate::{Job, JobStore};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransitionOutcome {
    Applied,
    IgnoredStale,
}

pub fn record_result(
    store: &mut JobStore,
    claimed: &Job,
    now_ms: u64,
    result: ExecutionResult,
) -> TransitionOutcome {
    let applied = match result {
        ExecutionResult::Succeeded => store.finish_success(claimed.id, claimed.attempts),
        ExecutionResult::Failed(FailureKind::Permanent) => {
            store.finish_permanent(claimed.id, claimed.attempts)
        }
        ExecutionResult::Failed(FailureKind::Transient { retry_after_ms }) => {
            if !can_retry(claimed.attempts, claimed.max_attempts) {
                store.finish_permanent(claimed.id, claimed.attempts)
            } else {
                let delay = retry_delay_ms(claimed.attempts, retry_after_ms);
                store.schedule_retry(claimed.id, claimed.attempts, now_ms.saturating_add(delay))
            }
        }
    };

    if applied {
        TransitionOutcome::Applied
    } else {
        TransitionOutcome::IgnoredStale
    }
}
