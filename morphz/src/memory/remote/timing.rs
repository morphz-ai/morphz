//! Opt-in, payload-free diagnostics. No wire protocol, authority, retry or
//! observer-delivery behavior depends on these measurements.
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use std::{collections::BTreeMap, future::Future, sync::Arc};

// This scope follows only explicitly awaited attempt work. Tokio-spawned
// background tasks do not inherit it. Never infer causality from wall time.
tokio::task_local! {
    static ATTEMPT: Arc<AttemptScope>;
}

struct AttemptScope {
    observability: Arc<crate::observability::Observability>,
    root_turn_id: String,
}

pub(crate) async fn observe_attempt<T>(
    observability: Arc<crate::observability::Observability>,
    root_turn_id: &str,
    future: impl Future<Output = T>,
) -> T {
    if !tracing::enabled!(target: "morphz::remote_store_timing", tracing::Level::DEBUG) {
        return future.await;
    }
    ATTEMPT
        .scope(
            Arc::new(AttemptScope {
                observability,
                root_turn_id: root_turn_id.into(),
            }),
            future,
        )
        .await
}

/// Opt-in, process-local per-turn attribution, not a complete critical-path
/// trace. Counts include failed/cancelled calls and all attempts for this root.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct TurnStoreProfile {
    pub operations: BTreeMap<String, TurnStoreOperation>,
    pub dropped: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct TurnStoreOperation {
    pub count: u64,
    pub unvalidated: u64,
    pub queue_us: u64,
    pub restore_us: u64,
    pub local_us: u64,
    pub journal_us: u64,
    pub authority_us: u64,
    pub finalize_us: u64,
    pub total_us: u64,
}

impl TurnStoreProfile {
    pub(crate) fn record(&mut self, record: &Record) {
        if !self.operations.contains_key(record.operation) && self.operations.len() >= 128 {
            self.dropped = self.dropped.saturating_add(1);
            return;
        }
        let operation = self.operations.entry(record.operation.into()).or_default();
        operation.count = operation.count.saturating_add(1);
        operation.unvalidated = operation
            .unvalidated
            .saturating_add(u64::from(!record.validated));
        macro_rules! accumulate {
            ($($field:ident),+) => { $(operation.$field = operation.$field.saturating_add(record.$field);)+ };
        }
        accumulate!(
            queue_us,
            restore_us,
            local_us,
            journal_us,
            authority_us,
            finalize_us,
            total_us
        );
    }
}

#[derive(Clone, Copy, Debug)]
pub(super) enum Stage {
    Queue,
    Restore,
    Local,
    Journal,
    Authority,
    Finalize,
}

#[derive(Serialize)]
pub(crate) struct Record {
    operation: &'static str,
    mode: &'static str,
    validated: bool,
    queue_us: u64,
    restore_us: u64,
    local_us: u64,
    journal_us: u64,
    authority_us: u64,
    finalize_us: u64,
    total_us: u64,
}

struct Clock {
    attempt: Option<Arc<AttemptScope>>,
    operation: &'static str,
    mode: &'static str,
    validated: bool,
    started: Instant,
    changed: Instant,
    stage: Stage,
    durations: [Duration; 6],
}

impl Clock {
    fn new(operation: &'static str, now: Instant) -> Self {
        Self {
            // Capture at start, not at Drop: cancellation may drop this future
            // after its task-local scope has already been uninstalled.
            attempt: ATTEMPT.try_with(Arc::clone).ok(),
            // The caller is generated from the actual closed trait graph, not
            // request data. Unknown labels cannot put arbitrary text in logs.
            operation: if super::REMOTE_STORE_OPERATION_NAMES.contains(&operation) {
                operation
            } else {
                "unknown"
            },
            mode: "undecided",
            validated: false,
            started: now,
            changed: now,
            stage: Stage::Queue,
            durations: [Duration::ZERO; 6],
        }
    }

    fn mark(&mut self, stage: Stage, now: Instant) {
        self.durations[self.stage as usize] += now.saturating_duration_since(self.changed);
        self.changed = now;
        self.stage = stage;
    }

    fn record(&self, now: Instant) -> Record {
        let mut durations = self.durations;
        durations[self.stage as usize] += now.saturating_duration_since(self.changed);
        let micros = |duration: Duration| duration.as_micros().min(u64::MAX as u128) as u64;
        Record {
            operation: self.operation,
            mode: self.mode,
            validated: self.validated,
            queue_us: micros(durations[0]),
            restore_us: micros(durations[1]),
            local_us: micros(durations[2]),
            journal_us: micros(durations[3]),
            authority_us: micros(durations[4]),
            finalize_us: micros(durations[5]),
            total_us: micros(now.saturating_duration_since(self.started)),
        }
    }
}

pub(super) struct OperationTiming(Option<Clock>);

impl OperationTiming {
    pub(super) fn start(operation: &'static str) -> Self {
        Self(
            tracing::enabled!(target: "morphz::remote_store_timing", tracing::Level::DEBUG)
                .then(|| Clock::new(operation, Instant::now())),
        )
    }

    pub(super) fn mark(&mut self, stage: Stage) {
        if let Some(clock) = &mut self.0 {
            tracing::trace!(target: "morphz::remote_store_stage", operation = clock.operation, ?stage, "native store phase");
            clock.mark(stage, Instant::now());
        }
    }

    pub(super) fn read(&mut self) {
        if let Some(clock) = &mut self.0 {
            clock.mode = "read";
        }
    }

    pub(super) fn commit(&mut self) {
        if let Some(clock) = &mut self.0 {
            clock.mode = "commit";
        }
    }

    pub(super) fn validated(&mut self) {
        if let Some(clock) = &mut self.0 {
            // This describes the Store receipt, not a business Result::Ok.
            clock.validated = true;
        }
    }
}

impl Drop for OperationTiming {
    fn drop(&mut self) {
        // Drop also measures cancelled/failed operations, without recording an
        // error or claiming their speculative state was acknowledged. Disabled
        // diagnostics do not allocate or read the clock.
        if let Some(clock) = &self.0 {
            let record = clock.record(Instant::now());
            if let Some(attempt) = &clock.attempt {
                attempt
                    .observability
                    .record_remote_store_operation(&attempt.root_turn_id, &record);
            }
            if let Ok(record) = serde_json::to_string(&record) {
                tracing::debug!(target: "morphz::remote_store_timing", "morphz.remote.operation {record}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stages_account_for_queue_and_cancelled_current_phase() {
        let start = Instant::now();
        let mut clock = Clock::new("EventStore::query", start);
        clock.mark(Stage::Restore, start + Duration::from_micros(10));
        clock.mark(Stage::Local, start + Duration::from_micros(30));
        clock.mark(Stage::Journal, start + Duration::from_micros(60));
        clock.mark(Stage::Authority, start + Duration::from_micros(100));
        clock.mode = "read";
        let record = clock.record(start + Duration::from_micros(150));
        assert_eq!(record.operation, "EventStore::query");
        assert_eq!(
            [
                record.queue_us,
                record.restore_us,
                record.local_us,
                record.journal_us,
                record.authority_us,
                record.finalize_us
            ],
            [10, 20, 30, 40, 50, 0]
        );
        assert_eq!(record.total_us, 150);
        assert!(!record.validated);
    }

    #[test]
    fn record_is_closed_and_cannot_contain_dynamic_labels_or_payloads() {
        let start = Instant::now();
        let mut clock = Clock::new("credential or user supplied text", start);
        clock.mode = "commit";
        clock.validated = true;
        clock.mark(Stage::Finalize, start);
        let value = serde_json::to_value(clock.record(start)).unwrap();
        assert_eq!(value["operation"], "unknown");
        assert_eq!(value["validated"], true);
        assert_eq!(value["mode"], "commit");
        assert_eq!(value.as_object().unwrap().len(), 10);
        assert!(!value.to_string().contains("credential"));
        assert_eq!(value["total_us"], 0);
    }

    #[test]
    fn diagnostics_are_disabled_without_an_opted_in_subscriber() {
        tracing::subscriber::with_default(tracing::subscriber::NoSubscriber::default(), || {
            assert!(OperationTiming::start("EventStore::query").0.is_none());
        });
    }

    fn scope(
        observability: &Arc<crate::observability::Observability>,
        root: &str,
    ) -> Arc<AttemptScope> {
        Arc::new(AttemptScope {
            observability: Arc::clone(observability),
            root_turn_id: root.into(),
        })
    }

    #[tokio::test]
    async fn concurrent_turns_are_isolated_and_detached_tasks_do_not_inherit_causality() {
        let observability = Arc::new(crate::observability::Observability::default());
        for root in ["first", "second"] {
            observability.begin_turn(root, None, None);
        }
        let first = ATTEMPT.scope(scope(&observability, "first"), async {
            let mut timer = OperationTiming(Some(Clock::new("EventStore::query", Instant::now())));
            timer.read();
            tokio::task::yield_now().await;
            tokio::spawn(async {
                assert!(ATTEMPT.try_with(Arc::clone).is_err());
                drop(OperationTiming(Some(Clock::new(
                    "EventStore::query",
                    Instant::now(),
                ))));
            })
            .await
            .unwrap();
            timer.validated();
        });
        let second = ATTEMPT.scope(scope(&observability, "second"), async {
            let _timer = OperationTiming(Some(Clock::new("EventStore::query", Instant::now())));
            tokio::task::yield_now().await;
        });
        tokio::join!(first, second);
        assert!(ATTEMPT.try_with(Arc::clone).is_err());
        let first = observability.turn("first").unwrap().remote_store.unwrap();
        let second = observability.turn("second").unwrap().remote_store.unwrap();
        assert_eq!(first.operations["EventStore::query"].count, 1);
        assert_eq!(first.operations["EventStore::query"].unvalidated, 0);
        assert_eq!(second.operations["EventStore::query"].count, 1);
        assert_eq!(second.operations["EventStore::query"].unvalidated, 1);
        assert!(!observability.prometheus_text().contains("first"));
    }

    #[tokio::test]
    async fn cancelled_scope_keeps_its_attribution_but_never_resurrects_evicted_turns() {
        let observability = Arc::new(crate::observability::Observability::with_turn_capacity(1));
        observability.begin_turn("first", None, None);
        let timer = ATTEMPT
            .scope(scope(&observability, "first"), async {
                OperationTiming(Some(Clock::new("EventStore::query", Instant::now())))
            })
            .await;
        // Same destructor path as a dropped/aborted future, outside its scope.
        drop(timer);
        assert_eq!(
            observability
                .turn("first")
                .unwrap()
                .remote_store
                .unwrap()
                .operations["EventStore::query"]
                .unvalidated,
            1
        );
        let timer = ATTEMPT
            .scope(scope(&observability, "first"), async {
                OperationTiming(Some(Clock::new("EventStore::query", Instant::now())))
            })
            .await;
        observability.begin_turn("newer", None, None);
        drop(timer);
        assert!(observability.turn("first").is_none());
        assert!(observability.turn("newer").unwrap().remote_store.is_none());
    }

    #[tokio::test]
    async fn aborting_an_attempt_records_unvalidated_work_in_its_own_turn() {
        let observability = Arc::new(crate::observability::Observability::default());
        observability.begin_turn("cancelled", None, None);
        let (started, ready) = tokio::sync::oneshot::channel();
        let worker = tokio::spawn(ATTEMPT.scope(scope(&observability, "cancelled"), async {
            let _timer = OperationTiming(Some(Clock::new("EventStore::query", Instant::now())));
            started.send(()).unwrap();
            std::future::pending::<()>().await;
        }));
        ready.await.unwrap();
        worker.abort();
        assert!(worker.await.unwrap_err().is_cancelled());
        assert_eq!(
            observability
                .turn("cancelled")
                .unwrap()
                .remote_store
                .unwrap()
                .operations["EventStore::query"]
                .unvalidated,
            1
        );
    }

    #[tokio::test]
    async fn disabled_diagnostics_do_not_install_an_attempt_scope() {
        let _subscriber =
            tracing::subscriber::set_default(tracing::subscriber::NoSubscriber::default());
        let observability = Arc::new(crate::observability::Observability::default());
        observability.begin_turn("disabled", None, None);
        let result = observe_attempt(Arc::clone(&observability), "disabled", async {
            assert!(ATTEMPT.try_with(Arc::clone).is_err());
            assert!(OperationTiming::start("EventStore::query").0.is_none());
            42
        })
        .await;
        assert_eq!(result, 42);
        assert!(observability
            .turn("disabled")
            .unwrap()
            .remote_store
            .is_none());
    }

    #[test]
    fn per_turn_profile_is_bounded_numeric_and_saturating() {
        let now = Instant::now();
        let mut profile = TurnStoreProfile::default();
        let names = super::super::REMOTE_STORE_OPERATION_NAMES;
        assert!(names.len() > 128);
        for operation in &names[..128] {
            profile.record(&Clock::new(operation, now).record(now));
        }
        profile.record(&Clock::new(names[128], now).record(now));
        assert_eq!(profile.operations.len(), 128);
        assert_eq!(profile.dropped, 1);
        let mut record = Clock::new(names[0], now).record(now);
        record.total_us = u64::MAX;
        profile.record(&record);
        profile.record(&record);
        assert_eq!(profile.operations[names[0]].total_us, u64::MAX);
        assert_eq!(profile.operations[names[0]].count, 3);
        let value = serde_json::to_value(&profile).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 2);
        assert_eq!(value["operations"][names[0]].as_object().unwrap().len(), 9);
    }
}
