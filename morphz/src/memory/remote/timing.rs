//! Opt-in, payload-free diagnostics. No wire protocol, authority, retry or
//! observer-delivery behavior depends on these measurements.
use serde::Serialize;
use std::time::{Duration, Instant};

#[derive(Clone, Copy)]
pub(super) enum Stage {
    Queue,
    Restore,
    Local,
    Journal,
    Authority,
    Finalize,
}

#[derive(Serialize)]
struct Record {
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
            if let Ok(record) = serde_json::to_string(&clock.record(Instant::now())) {
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
}
