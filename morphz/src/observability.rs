//! Process-local service observability for Morphz Runtime.
//!
//! The durable Event graph remains the product authority. This module keeps a
//! bounded diagnostic projection that answers a different operational
//! question: where did one Runtime turn spend its wall-clock time? Stable IDs
//! stay in structured logs and the bounded turn timeline; Prometheus labels
//! contain only low-cardinality stage and outcome names.

use chrono::{DateTime, TimeDelta, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fmt::Write as _;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const DEFAULT_TURN_CAPACITY: usize = 512;
const MAX_TURN_STAGES: usize = 128;
const MAX_DETAIL_CHARS: usize = 512;
const HISTOGRAM_BUCKETS_SECONDS: [f64; 15] = [
    0.001, 0.005, 0.010, 0.025, 0.050, 0.100, 0.250, 0.500, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0,
];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnTraceStatus {
    InFlight,
    FirstOutput,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TurnStageRecord {
    pub stage: String,
    pub started_at: DateTime<Utc>,
    pub completed_at: DateTime<Utc>,
    pub duration_micros: u64,
    pub outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TurnTraceRecord {
    pub trace_id: String,
    pub root_turn_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub status: TurnTraceStatus,
    pub started_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub stages: Vec<TurnStageRecord>,
}

#[derive(Debug)]
struct LiveTurnTrace {
    record: TurnTraceRecord,
    started: Instant,
}

#[derive(Debug)]
struct TurnTraceStore {
    capacity: usize,
    order: VecDeque<String>,
    turns: HashMap<String, LiveTurnTrace>,
}

impl TurnTraceStore {
    fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            order: VecDeque::new(),
            turns: HashMap::new(),
        }
    }

    fn trim(&mut self) {
        while self.order.len() > self.capacity {
            if let Some(expired) = self.order.pop_front() {
                self.turns.remove(&expired);
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct HistogramKey {
    name: &'static str,
    help: &'static str,
    labels: BTreeMap<&'static str, String>,
}

#[derive(Debug, Clone)]
struct HistogramValue {
    bucket_counts: [u64; HISTOGRAM_BUCKETS_SECONDS.len()],
    count: u64,
    sum_seconds: f64,
    max_seconds: f64,
}

impl Default for HistogramValue {
    fn default() -> Self {
        Self {
            bucket_counts: [0; HISTOGRAM_BUCKETS_SECONDS.len()],
            count: 0,
            sum_seconds: 0.0,
            max_seconds: 0.0,
        }
    }
}

impl HistogramValue {
    fn observe(&mut self, duration: Duration) {
        let seconds = duration.as_secs_f64();
        self.count = self.count.saturating_add(1);
        self.sum_seconds += seconds;
        self.max_seconds = self.max_seconds.max(seconds);
        for (index, upper_bound) in HISTOGRAM_BUCKETS_SECONDS.iter().enumerate() {
            if seconds <= *upper_bound {
                self.bucket_counts[index] = self.bucket_counts[index].saturating_add(1);
            }
        }
    }
}

/// Shared, bounded observability state for one Runtime process.
#[derive(Debug)]
pub struct Observability {
    process_started_at: Instant,
    trace_sequence: AtomicU64,
    turns: Mutex<TurnTraceStore>,
    histograms: Mutex<BTreeMap<HistogramKey, HistogramValue>>,
}

impl Default for Observability {
    fn default() -> Self {
        Self::with_turn_capacity(DEFAULT_TURN_CAPACITY)
    }
}

impl Observability {
    pub fn with_turn_capacity(capacity: usize) -> Self {
        Self {
            process_started_at: Instant::now(),
            trace_sequence: AtomicU64::new(0),
            turns: Mutex::new(TurnTraceStore::new(capacity)),
            histograms: Mutex::new(BTreeMap::new()),
        }
    }

    pub fn next_trace_id(&self) -> String {
        let sequence = self.trace_sequence.fetch_add(1, Ordering::Relaxed);
        format!("trace_{}_{}", Utc::now().timestamp_micros(), sequence)
    }

    pub fn begin_turn(
        &self,
        root_turn_id: &str,
        context_id: Option<&str>,
        session_id: Option<&str>,
    ) {
        let now = Utc::now();
        let mut store = self
            .turns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(turn) = store.turns.get_mut(root_turn_id) {
            if turn.record.context_id.is_none() {
                turn.record.context_id = context_id.map(ToOwned::to_owned);
            }
            if turn.record.session_id.is_none() {
                turn.record.session_id = session_id.map(ToOwned::to_owned);
            }
            turn.record.updated_at = now;
            return;
        }
        store.order.push_back(root_turn_id.to_string());
        store.turns.insert(
            root_turn_id.to_string(),
            LiveTurnTrace {
                record: TurnTraceRecord {
                    trace_id: root_turn_id.to_string(),
                    root_turn_id: root_turn_id.to_string(),
                    context_id: context_id.map(ToOwned::to_owned),
                    session_id: session_id.map(ToOwned::to_owned),
                    status: TurnTraceStatus::InFlight,
                    started_at: now,
                    updated_at: now,
                    stages: Vec::new(),
                },
                started: Instant::now(),
            },
        );
        store.trim();
    }

    pub fn elapsed_since_turn_started(&self, root_turn_id: &str) -> Option<Duration> {
        self.turns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .turns
            .get(root_turn_id)
            .map(|turn| turn.started.elapsed())
    }

    pub fn mark_turn_status(&self, root_turn_id: &str, status: TurnTraceStatus) {
        let mut store = self
            .turns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(turn) = store.turns.get_mut(root_turn_id) {
            turn.record.status = status;
            turn.record.updated_at = Utc::now();
        }
    }

    pub fn discard_turn(&self, root_turn_id: &str) {
        let mut store = self
            .turns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        store.turns.remove(root_turn_id);
        store.order.retain(|candidate| candidate != root_turn_id);
    }

    pub fn record_turn_checkpoint(
        &self,
        root_turn_id: &str,
        context_id: Option<&str>,
        session_id: Option<&str>,
        stage: &'static str,
        outcome: &'static str,
    ) {
        self.begin_turn(root_turn_id, context_id, session_id);
        if let Some(elapsed) = self.elapsed_since_turn_started(root_turn_id) {
            self.record_turn_stage(
                root_turn_id,
                context_id,
                session_id,
                stage,
                elapsed,
                outcome,
                None,
            );
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record_turn_stage(
        &self,
        root_turn_id: &str,
        context_id: Option<&str>,
        session_id: Option<&str>,
        stage: &'static str,
        duration: Duration,
        outcome: &'static str,
        detail: Option<&str>,
    ) {
        self.begin_turn(root_turn_id, context_id, session_id);
        self.observe_histogram(
            "morphz_turn_stage_duration_seconds",
            "Wall-clock duration of a Morphz turn stage.",
            BTreeMap::from([
                ("stage", stage.to_string()),
                ("outcome", outcome.to_string()),
            ]),
            duration,
        );

        let completed_at = Utc::now();
        let duration_micros = u64::try_from(duration.as_micros()).unwrap_or(u64::MAX);
        let delta_micros = i64::try_from(duration_micros).unwrap_or(i64::MAX);
        let started_at = completed_at
            .checked_sub_signed(TimeDelta::microseconds(delta_micros))
            .unwrap_or(completed_at);
        let detail = detail.map(|value| bounded_text(value, MAX_DETAIL_CHARS));
        let mut store = self
            .turns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(turn) = store.turns.get_mut(root_turn_id) {
            if turn.record.stages.len() == MAX_TURN_STAGES {
                turn.record.stages.remove(0);
            }
            turn.record.stages.push(TurnStageRecord {
                stage: stage.to_string(),
                started_at,
                completed_at,
                duration_micros,
                outcome: outcome.to_string(),
                detail,
            });
            turn.record.updated_at = completed_at;
            if stage == "provider.first_output" && outcome == "ok" {
                turn.record.status = TurnTraceStatus::FirstOutput;
            } else if stage == "turn.completed" {
                turn.record.status = TurnTraceStatus::Completed;
            } else if stage == "turn.failed" {
                turn.record.status = TurnTraceStatus::Failed;
            } else if stage == "scheduler.activation_terminal" {
                turn.record.status = if outcome == "succeeded" {
                    TurnTraceStatus::Completed
                } else {
                    TurnTraceStatus::Failed
                };
            }
        }
        tracing::info!(
            trace_id = root_turn_id,
            root_turn_id,
            context_id,
            session_id,
            stage,
            outcome,
            duration_micros,
            event_code = "observability.turn_stage.completed",
            "Morphz turn stage completed"
        );
    }

    pub fn record_operation(
        &self,
        component: &'static str,
        operation: &'static str,
        duration: Duration,
        outcome: &'static str,
    ) {
        self.observe_histogram(
            "morphz_runtime_operation_duration_seconds",
            "Wall-clock duration of an internal Morphz Runtime operation.",
            BTreeMap::from([
                ("component", component.to_string()),
                ("operation", operation.to_string()),
                ("outcome", outcome.to_string()),
            ]),
            duration,
        );
    }

    /// Record one semantic Store command.  The histogram count is the actual
    /// command count; its duration includes pool admission and database work.
    /// Physical SQL statements are deliberately enforced by integration-test
    /// budgets instead of being guessed here.
    pub fn record_storage_command(
        &self,
        backend: &'static str,
        command: &'static str,
        duration: Duration,
        outcome: &'static str,
    ) {
        self.observe_histogram(
            "morphz_storage_command_duration_seconds",
            "Wall-clock duration of one semantic Morphz Store command, including pool admission.",
            BTreeMap::from([
                ("backend", backend.to_string()),
                ("command", command.to_string()),
                ("outcome", outcome.to_string()),
            ]),
            duration,
        );
    }

    pub fn record_http_request(
        &self,
        method: &str,
        route: &str,
        status_class: &str,
        duration: Duration,
    ) {
        self.observe_histogram(
            "morphz_http_request_duration_seconds",
            "Wall-clock duration of an HTTP request handled by Morphz.",
            BTreeMap::from([
                ("method", normalized_http_method(method).to_string()),
                ("route", bounded_text(route, 160)),
                ("status_class", bounded_text(status_class, 8)),
            ]),
            duration,
        );
    }

    pub fn recent_turns(&self, limit: usize) -> Vec<TurnTraceRecord> {
        let store = self
            .turns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        store
            .order
            .iter()
            .rev()
            .take(limit.clamp(1, store.capacity))
            .filter_map(|id| store.turns.get(id).map(|turn| turn.record.clone()))
            .collect()
    }

    pub fn turn(&self, root_turn_id: &str) -> Option<TurnTraceRecord> {
        self.turns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .turns
            .get(root_turn_id)
            .map(|turn| turn.record.clone())
    }

    pub fn prometheus_text(&self) -> String {
        let histograms = self
            .histograms
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let turns = self
            .turns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let retained = turns.turns.len();
        let in_flight = turns
            .turns
            .values()
            .filter(|turn| turn.record.status == TurnTraceStatus::InFlight)
            .count();
        drop(turns);

        let mut output = String::new();
        let _ = writeln!(
            output,
            "# HELP morphz_process_uptime_seconds Seconds since this Runtime observability registry was created."
        );
        let _ = writeln!(output, "# TYPE morphz_process_uptime_seconds gauge");
        let _ = writeln!(
            output,
            "morphz_process_uptime_seconds {}",
            self.process_started_at.elapsed().as_secs_f64()
        );
        let _ = writeln!(
            output,
            "# HELP morphz_observability_turns_retained Number of recent turn timelines retained in memory."
        );
        let _ = writeln!(output, "# TYPE morphz_observability_turns_retained gauge");
        let _ = writeln!(output, "morphz_observability_turns_retained {retained}");
        let _ = writeln!(
            output,
            "# HELP morphz_observability_turns_in_flight Number of retained turns that have not produced output or terminated."
        );
        let _ = writeln!(output, "# TYPE morphz_observability_turns_in_flight gauge");
        let _ = writeln!(output, "morphz_observability_turns_in_flight {in_flight}");

        let mut documented = std::collections::HashSet::new();
        for (key, value) in histograms {
            if documented.insert(key.name) {
                let _ = writeln!(output, "# HELP {} {}", key.name, key.help);
                let _ = writeln!(output, "# TYPE {} histogram", key.name);
                let _ = writeln!(
                    output,
                    "# HELP {}_max Maximum observed value in the current process.",
                    key.name
                );
                let _ = writeln!(output, "# TYPE {}_max gauge", key.name);
            }
            for (index, upper_bound) in HISTOGRAM_BUCKETS_SECONDS.iter().enumerate() {
                let mut labels = key.labels.clone();
                labels.insert("le", format_prometheus_number(*upper_bound));
                let _ = writeln!(
                    output,
                    "{}_bucket{} {}",
                    key.name,
                    render_labels(&labels),
                    value.bucket_counts[index]
                );
            }
            let mut infinite_labels = key.labels.clone();
            infinite_labels.insert("le", "+Inf".to_string());
            let _ = writeln!(
                output,
                "{}_bucket{} {}",
                key.name,
                render_labels(&infinite_labels),
                value.count
            );
            let labels = render_labels(&key.labels);
            let _ = writeln!(output, "{}_sum{} {}", key.name, labels, value.sum_seconds);
            let _ = writeln!(output, "{}_count{} {}", key.name, labels, value.count);
            let _ = writeln!(output, "{}_max{} {}", key.name, labels, value.max_seconds);
        }
        output
    }

    fn observe_histogram(
        &self,
        name: &'static str,
        help: &'static str,
        labels: BTreeMap<&'static str, String>,
        duration: Duration,
    ) {
        self.histograms
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entry(HistogramKey { name, help, labels })
            .or_default()
            .observe(duration);
    }
}

fn normalized_http_method(method: &str) -> &'static str {
    match method {
        "GET" => "GET",
        "HEAD" => "HEAD",
        "POST" => "POST",
        "PUT" => "PUT",
        "PATCH" => "PATCH",
        "DELETE" => "DELETE",
        "OPTIONS" => "OPTIONS",
        "TRACE" => "TRACE",
        "CONNECT" => "CONNECT",
        _ => "OTHER",
    }
}

fn bounded_text(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let bounded = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{bounded}…")
    } else {
        bounded
    }
}

fn render_labels(labels: &BTreeMap<&'static str, String>) -> String {
    if labels.is_empty() {
        return String::new();
    }
    let labels = labels
        .iter()
        .map(|(name, value)| format!("{name}=\"{}\"", escape_prometheus_label(value)))
        .collect::<Vec<_>>()
        .join(",");
    format!("{{{labels}}}")
}

fn escape_prometheus_label(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('\n', "\\n")
        .replace('"', "\\\"")
}

fn format_prometheus_number(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{value:.1}")
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turn_timeline_is_bounded_and_newest_first() {
        let observability = Observability::with_turn_capacity(2);
        observability.begin_turn("turn-1", Some("ctx"), Some("session"));
        observability.begin_turn("turn-2", Some("ctx"), Some("session"));
        observability.begin_turn("turn-3", Some("ctx"), Some("session"));

        let turns = observability.recent_turns(10);
        assert_eq!(
            turns
                .iter()
                .map(|turn| turn.root_turn_id.as_str())
                .collect::<Vec<_>>(),
            vec!["turn-3", "turn-2"]
        );
        assert!(observability.turn("turn-1").is_none());
    }

    #[test]
    fn prometheus_output_uses_low_cardinality_labels() {
        let observability = Observability::with_turn_capacity(2);
        observability.record_turn_stage(
            "msg-secret-id",
            Some("ctx-secret-id"),
            Some("session-secret-id"),
            "context.build",
            Duration::from_millis(250),
            "ok",
            None,
        );
        let output = observability.prometheus_text();

        assert!(output.contains("morphz_turn_stage_duration_seconds_bucket"));
        assert!(output.contains("stage=\"context.build\""));
        assert!(output.contains("outcome=\"ok\""));
        assert!(!output.contains("msg-secret-id"));
        assert!(!output.contains("ctx-secret-id"));
        assert!(!output.contains("session-secret-id"));
    }

    #[test]
    fn first_output_changes_turn_status() {
        let observability = Observability::with_turn_capacity(2);
        observability.record_turn_stage(
            "turn",
            Some("ctx"),
            Some("session"),
            "provider.first_output",
            Duration::from_secs(1),
            "ok",
            None,
        );

        assert_eq!(
            observability.turn("turn").map(|turn| turn.status),
            Some(TurnTraceStatus::FirstOutput)
        );
    }

    #[test]
    fn arbitrary_http_methods_do_not_create_unbounded_metric_labels() {
        let observability = Observability::with_turn_capacity(2);
        observability.record_http_request(
            "ATTACKER-CONTROLLED-METHOD",
            "/api/status",
            "2xx",
            Duration::from_millis(1),
        );

        let output = observability.prometheus_text();
        assert!(output.contains("method=\"OTHER\""));
        assert!(!output.contains("ATTACKER-CONTROLLED-METHOD"));
    }

    #[test]
    fn storage_commands_export_backend_command_outcome_and_real_count() {
        let observability = Observability::with_turn_capacity(2);
        observability.record_storage_command(
            "postgres",
            "claim_message",
            Duration::from_millis(12),
            "ok",
        );
        observability.record_storage_command(
            "postgres",
            "claim_message",
            Duration::from_millis(4),
            "error",
        );

        let output = observability.prometheus_text();
        assert!(output.contains("morphz_storage_command_duration_seconds_bucket"));
        assert!(output.contains("backend=\"postgres\""));
        assert!(output.contains("command=\"claim_message\""));
        assert!(output.contains("outcome=\"ok\""));
        assert!(output.contains("outcome=\"error\""));
        assert!(output.contains(
            "morphz_storage_command_duration_seconds_count{backend=\"postgres\",command=\"claim_message\",outcome=\"ok\"} 1"
        ));
    }

    #[test]
    fn activation_terminal_updates_turn_status() {
        let observability = Observability::with_turn_capacity(2);
        observability.record_turn_stage(
            "turn",
            Some("ctx"),
            Some("session"),
            "scheduler.activation_terminal",
            Duration::from_secs(2),
            "succeeded",
            None,
        );
        assert_eq!(
            observability.turn("turn").map(|turn| turn.status),
            Some(TurnTraceStatus::Completed)
        );

        observability.mark_turn_status("turn", TurnTraceStatus::InFlight);
        assert_eq!(
            observability.turn("turn").map(|turn| turn.status),
            Some(TurnTraceStatus::InFlight)
        );
    }
}
