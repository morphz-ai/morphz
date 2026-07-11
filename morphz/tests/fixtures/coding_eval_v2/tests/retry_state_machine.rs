use morphz_coding_eval_v2::{
    record_result, ExecutionResult, FailureKind, Job, JobState, JobStore, TransitionOutcome,
};

fn transient(retry_after_ms: Option<u64>) -> ExecutionResult {
    ExecutionResult::Failed(FailureKind::Transient { retry_after_ms })
}

#[test]
fn first_transient_failure_waits_one_base_interval() {
    let mut store = JobStore::default();
    store.insert(Job::new(1, 3));
    let claimed = store.claim(1, 1_000, 50).unwrap();

    assert_eq!(
        record_result(&mut store, &claimed, 1_010, transient(None)),
        TransitionOutcome::Applied
    );
    assert_eq!(
        store.get(1).unwrap().state,
        JobState::Waiting { ready_at_ms: 1_110 }
    );
}

#[test]
fn max_attempts_includes_the_first_execution() {
    let mut store = JobStore::default();
    store.insert(Job::new(2, 1));
    let claimed = store.claim(2, 0, 50).unwrap();

    record_result(&mut store, &claimed, 10, transient(None));
    assert_eq!(store.get(2).unwrap().state, JobState::FailedPermanently);
    assert!(store.claim(2, 10_000, 50).is_none());
}

#[test]
fn cancellation_cannot_be_overwritten_by_a_late_failure() {
    let mut store = JobStore::default();
    store.insert(Job::new(3, 3));
    let claimed = store.claim(3, 0, 50).unwrap();
    assert!(store.cancel(3));

    assert_eq!(
        record_result(&mut store, &claimed, 10, transient(None)),
        TransitionOutcome::IgnoredStale
    );
    assert_eq!(store.get(3).unwrap().state, JobState::Cancelled);
}

#[test]
fn retry_after_overrides_exponential_backoff() {
    let mut store = JobStore::default();
    store.insert(Job::new(4, 3));
    let claimed = store.claim(4, 500, 50).unwrap();

    record_result(&mut store, &claimed, 510, transient(Some(750)));
    assert_eq!(
        store.get(4).unwrap().state,
        JobState::Waiting { ready_at_ms: 1_260 }
    );
}

#[test]
fn permanent_failure_is_terminal() {
    let mut store = JobStore::default();
    store.insert(Job::new(5, 5));
    let claimed = store.claim(5, 0, 50).unwrap();

    record_result(
        &mut store,
        &claimed,
        10,
        ExecutionResult::Failed(FailureKind::Permanent),
    );
    assert_eq!(store.get(5).unwrap().state, JobState::FailedPermanently);
}
