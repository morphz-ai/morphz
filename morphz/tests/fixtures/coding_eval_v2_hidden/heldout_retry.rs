use morphz_coding_eval_v2::{
    record_result, ExecutionResult, FailureKind, Job, JobState, JobStore, TransitionOutcome,
};

fn transient(retry_after_ms: Option<u64>) -> ExecutionResult {
    ExecutionResult::Failed(FailureKind::Transient { retry_after_ms })
}

#[test]
fn second_failure_doubles_the_base_delay() {
    let mut store = JobStore::default();
    store.insert(Job::new(10, 4));

    let first = store.claim(10, 0, 20).unwrap();
    record_result(&mut store, &first, 0, transient(None));
    let second = store.claim(10, 100, 20).unwrap();
    record_result(&mut store, &second, 105, transient(None));

    assert_eq!(
        store.get(10).unwrap().state,
        JobState::Waiting { ready_at_ms: 305 }
    );
}

#[test]
fn zero_retry_after_is_respected() {
    let mut store = JobStore::default();
    store.insert(Job::new(11, 2));
    let claimed = store.claim(11, 40, 20).unwrap();
    record_result(&mut store, &claimed, 45, transient(Some(0)));

    assert_eq!(
        store.get(11).unwrap().state,
        JobState::Waiting { ready_at_ms: 45 }
    );
}

#[test]
fn stale_result_from_an_expired_lease_is_ignored() {
    let mut store = JobStore::default();
    store.insert(Job::new(12, 3));
    let stale = store.claim(12, 0, 10).unwrap();
    let current = store.claim(12, 10, 10).unwrap();

    assert_eq!(
        record_result(&mut store, &stale, 11, transient(None)),
        TransitionOutcome::IgnoredStale
    );
    assert_eq!(store.get(12).unwrap().attempts, current.attempts);
    assert!(matches!(
        store.get(12).unwrap().state,
        JobState::Leased { until_ms: 20 }
    ));
}

#[test]
fn success_after_cancellation_is_ignored() {
    let mut store = JobStore::default();
    store.insert(Job::new(13, 2));
    let claimed = store.claim(13, 0, 10).unwrap();
    store.cancel(13);

    assert_eq!(
        record_result(&mut store, &claimed, 1, ExecutionResult::Succeeded),
        TransitionOutcome::IgnoredStale
    );
    assert_eq!(store.get(13).unwrap().state, JobState::Cancelled);
}

#[test]
fn third_failure_exhausts_three_total_attempts() {
    let mut store = JobStore::default();
    store.insert(Job::new(14, 3));

    let first = store.claim(14, 0, 10).unwrap();
    record_result(&mut store, &first, 0, transient(None));
    let second = store.claim(14, 100, 10).unwrap();
    record_result(&mut store, &second, 100, transient(None));
    let third = store.claim(14, 300, 10).unwrap();
    record_result(&mut store, &third, 300, transient(None));

    assert_eq!(store.get(14).unwrap().attempts, 3);
    assert_eq!(store.get(14).unwrap().state, JobState::FailedPermanently);
}

#[test]
fn large_attempt_numbers_cap_the_default_delay() {
    assert_eq!(morphz_coding_eval_v2::retry::retry_delay_ms(31, None), 10_000);
}
