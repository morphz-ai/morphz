use crate::roadshow_demo_001::{
    score_observed_run, DemoArm, DemoScore, FixtureEvent, ModelCallUsage, ObservedAction,
    ObservedRun, ReleaseAction, RoadshowFixture, WorkerRecoveryObservation,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

type DynError = Box<dyn std::error::Error + Send + Sync>;

const PURPOSE: &str = "roadshow_demo";
const DEMO_ID: &str = "DEMO-001";
const PROTOCOL_VERSION: &str = "candidate-v2";
const BASE_FIXTURE_TEXT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/roadshow_demo_001_v2/event_stream.json"
));
const DESIGN_TEXT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/roadshow_demo_001_v2/adapter_candidate_design.json"
));

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct CurrentState {
    project: Option<String>,
    version: Option<String>,
    port: Option<u16>,
    endpoint: Option<String>,
    retention_days: Option<u16>,
    timezone: Option<String>,
    security_rule: Option<String>,
    field_sources: BTreeMap<String, String>,
}

impl CurrentState {
    fn apply_evidence(&mut self, event: &FixtureEvent) {
        let payload = &event.payload;
        let status = payload
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if matches!(status, "superseded" | "archived-untrusted") {
            return;
        }
        if let Some(value) = payload.get("project").and_then(Value::as_str) {
            self.project = Some(value.to_string());
        }
        if status == "approved-current" {
            self.set_string("version", payload, &event.principal_id);
            self.set_u16("port", payload, &event.principal_id);
            self.set_string("endpoint", payload, &event.principal_id);
            self.set_u16("retention_days", payload, &event.principal_id);
            self.set_string("timezone", payload, &event.principal_id);
        }
        if status == "approved-policy" {
            self.set_u16("retention_days", payload, &event.principal_id);
            self.set_string("timezone", payload, &event.principal_id);
            self.set_string("security_rule", payload, &event.principal_id);
        }
        if status == "active-until-explicitly-revoked" {
            self.set_string("security_rule", payload, &event.principal_id);
        }
    }

    fn set_string(&mut self, field: &str, payload: &Value, principal: &str) {
        let Some(value) = payload.get(field).and_then(Value::as_str) else {
            return;
        };
        match field {
            "version" => self.version = Some(value.to_string()),
            "endpoint" => self.endpoint = Some(value.to_string()),
            "timezone" => self.timezone = Some(value.to_string()),
            "security_rule" => self.security_rule = Some(value.to_string()),
            _ => return,
        }
        self.field_sources
            .insert(field.to_string(), principal.to_string());
    }

    fn set_u16(&mut self, field: &str, payload: &Value, principal: &str) {
        let Some(value) = payload.get(field).and_then(Value::as_u64) else {
            return;
        };
        let Ok(value) = u16::try_from(value) else {
            return;
        };
        match field {
            "port" => self.port = Some(value),
            "retention_days" => self.retention_days = Some(value),
            _ => return,
        }
        self.field_sources
            .insert(field.to_string(), principal.to_string());
    }

    fn into_action(self) -> Result<ReleaseAction, DynError> {
        Ok(ReleaseAction {
            project: self.project.ok_or("missing project")?,
            version: self.version.ok_or("missing version")?,
            port: self.port.ok_or("missing port")?,
            endpoint: self.endpoint.ok_or("missing endpoint")?,
            retention_days: self.retention_days.ok_or("missing retention_days")?,
            timezone: self.timezone.ok_or("missing timezone")?,
            security_rule: self.security_rule.ok_or("missing security_rule")?,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SummaryMemory {
    schema_version: String,
    current_facts: CurrentState,
    open_items: Vec<String>,
    source_notes: Vec<String>,
    last_maintained_event_sequence: u64,
}

struct DeterministicFakeClient {
    invalid_summary_responses_remaining: usize,
}

impl DeterministicFakeClient {
    fn new(invalid_summary_responses_remaining: usize) -> Self {
        Self {
            invalid_summary_responses_remaining,
        }
    }

    fn infer_state(&self, events: &[FixtureEvent], seed: Option<CurrentState>) -> CurrentState {
        let mut state = seed.unwrap_or_default();
        for event in events {
            if event.kind == "evidence" {
                state.apply_evidence(event);
            }
        }
        state
    }

    fn maintain_summary(&mut self, events: &[FixtureEvent]) -> String {
        if self.invalid_summary_responses_remaining > 0 {
            self.invalid_summary_responses_remaining -= 1;
            return "{invalid-summary".to_string();
        }
        let state = self.infer_state(events, None);
        let memory = SummaryMemory {
            schema_version: "demo-001-summary-v1".to_string(),
            current_facts: state,
            open_items: Vec::new(),
            source_notes: events
                .iter()
                .filter(|event| event.kind == "evidence")
                .rev()
                .take(6)
                .map(|event| event.event_id.clone())
                .collect(),
            last_maintained_event_sequence: events
                .last()
                .map(|event| event.sequence)
                .unwrap_or_default(),
        };
        serde_json::to_string(&memory).expect("fake summary must serialize")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TraceRecord {
    trace_sequence: u64,
    source_event_sequence: u64,
    source_event_id: String,
    stage: String,
    arm: DemoArm,
    kind: String,
    principal_id: String,
    session_id: String,
    thread_id: String,
    payload: Value,
}

struct TraceWriter {
    arm: DemoArm,
    next_sequence: u64,
    records: Vec<TraceRecord>,
}

impl TraceWriter {
    fn new(arm: DemoArm) -> Self {
        Self {
            arm,
            next_sequence: 1,
            records: Vec::new(),
        }
    }

    fn push(&mut self, event: &FixtureEvent, kind: &str, payload: Value) -> u64 {
        let sequence = self.next_sequence;
        self.next_sequence += 1;
        self.records.push(TraceRecord {
            trace_sequence: sequence,
            source_event_sequence: event.sequence,
            source_event_id: event.event_id.clone(),
            stage: event.stage.clone(),
            arm: self.arm,
            kind: kind.to_string(),
            principal_id: event.principal_id.clone(),
            session_id: event.session_id.clone(),
            thread_id: event.thread_id.clone(),
            payload,
        });
        sequence
    }
}

trait RoadshowRunnerAdapter {
    fn arm(&self) -> DemoArm;
    fn ingest(
        &mut self,
        event: &FixtureEvent,
        client: &mut DeterministicFakeClient,
        trace: &mut TraceWriter,
    ) -> Result<(), DynError>;
    fn project(
        &mut self,
        event: &FixtureEvent,
        client: &mut DeterministicFakeClient,
        trace: &mut TraceWriter,
    ) -> Result<CurrentState, DynError>;
    fn durable_state_present(&self) -> bool;
}

#[derive(Default)]
struct PersistentMessagesAdapter {
    messages: Vec<FixtureEvent>,
}

impl RoadshowRunnerAdapter for PersistentMessagesAdapter {
    fn arm(&self) -> DemoArm {
        DemoArm::PersistentMessages
    }

    fn ingest(
        &mut self,
        event: &FixtureEvent,
        _client: &mut DeterministicFakeClient,
        trace: &mut TraceWriter,
    ) -> Result<(), DynError> {
        self.messages.push(event.clone());
        trace.push(
            event,
            "adapter_ingest",
            json!({"operation":"append_event_to_durable_message_history"}),
        );
        Ok(())
    }

    fn project(
        &mut self,
        event: &FixtureEvent,
        client: &mut DeterministicFakeClient,
        trace: &mut TraceWriter,
    ) -> Result<CurrentState, DynError> {
        let selected = select_messages(&self.messages, None);
        record_model_call(
            trace,
            event,
            request_call_kind(event),
            serde_json::to_vec(&selected)?.len(),
            1,
        );
        Ok(client.infer_state(&selected, None))
    }

    fn durable_state_present(&self) -> bool {
        !self.messages.is_empty()
    }
}

#[derive(Default)]
struct SummaryJsonMemoryAdapter {
    messages: Vec<FixtureEvent>,
    memory: Option<SummaryMemory>,
    evidence_since_maintenance: usize,
}

impl SummaryJsonMemoryAdapter {
    fn maintain(
        &mut self,
        event: &FixtureEvent,
        client: &mut DeterministicFakeClient,
        trace: &mut TraceWriter,
    ) -> Result<(), DynError> {
        let input_size = serde_json::to_vec(&self.messages)?.len();
        let first = client.maintain_summary(&self.messages);
        record_model_call(trace, event, "state_maintenance", input_size, 1);
        let memory = match serde_json::from_str::<SummaryMemory>(&first) {
            Ok(memory) => memory,
            Err(first_error) => {
                trace.push(
                    event,
                    "summary_parse_failure",
                    json!({"attempt":1,"error":first_error.to_string()}),
                );
                let repaired = client.maintain_summary(&self.messages);
                record_model_call(trace, event, "state_maintenance", input_size, 1);
                serde_json::from_str::<SummaryMemory>(&repaired).map_err(|second_error| {
                    format!(
                        "summary memory remained invalid after one counted repair: {second_error}"
                    )
                })?
            }
        };
        trace.push(
            event,
            "summary_memory_committed",
            json!({
                "schema_version": memory.schema_version,
                "last_maintained_event_sequence": memory.last_maintained_event_sequence
            }),
        );
        self.memory = Some(memory);
        self.evidence_since_maintenance = 0;
        Ok(())
    }

    fn ensure_current(
        &mut self,
        event: &FixtureEvent,
        client: &mut DeterministicFakeClient,
        trace: &mut TraceWriter,
    ) -> Result<(), DynError> {
        if self.memory.is_none() || self.evidence_since_maintenance > 0 {
            self.maintain(event, client, trace)?;
        }
        Ok(())
    }
}

impl RoadshowRunnerAdapter for SummaryJsonMemoryAdapter {
    fn arm(&self) -> DemoArm {
        DemoArm::SummaryJsonMemory
    }

    fn ingest(
        &mut self,
        event: &FixtureEvent,
        client: &mut DeterministicFakeClient,
        trace: &mut TraceWriter,
    ) -> Result<(), DynError> {
        self.messages.push(event.clone());
        trace.push(
            event,
            "adapter_ingest",
            json!({"operation":"append_event_to_durable_message_history"}),
        );
        if event.kind == "evidence" {
            self.evidence_since_maintenance += 1;
            if self.evidence_since_maintenance >= 8 {
                self.maintain(event, client, trace)?;
            }
        }
        Ok(())
    }

    fn project(
        &mut self,
        event: &FixtureEvent,
        client: &mut DeterministicFakeClient,
        trace: &mut TraceWriter,
    ) -> Result<CurrentState, DynError> {
        self.ensure_current(event, client, trace)?;
        let memory = self.memory.as_ref().ok_or("summary memory missing")?;
        let recent = self
            .messages
            .iter()
            .filter(|message| message.sequence > memory.last_maintained_event_sequence)
            .cloned()
            .collect::<Vec<_>>();
        let active_input = json!({"memory":memory,"recent_messages":recent});
        record_model_call(
            trace,
            event,
            request_call_kind(event),
            serde_json::to_vec(&active_input)?.len(),
            1,
        );
        Ok(client.infer_state(&recent, Some(memory.current_facts.clone())))
    }

    fn durable_state_present(&self) -> bool {
        !self.messages.is_empty() && self.memory.is_some()
    }
}

#[derive(Default)]
struct MorphzStructuredContextAdapter {
    state: CurrentState,
    observations: usize,
}

impl RoadshowRunnerAdapter for MorphzStructuredContextAdapter {
    fn arm(&self) -> DemoArm {
        DemoArm::MorphzStructuredContext
    }

    fn ingest(
        &mut self,
        event: &FixtureEvent,
        _client: &mut DeterministicFakeClient,
        trace: &mut TraceWriter,
    ) -> Result<(), DynError> {
        trace.push(
            event,
            "observation_appended",
            json!({
                "source_event_id":event.event_id,
                "principal_id":event.principal_id,
                "session_id":event.session_id,
                "thread_id":event.thread_id
            }),
        );
        self.observations += 1;
        if event.kind == "evidence" {
            record_model_call(
                trace,
                event,
                "state_maintenance",
                serde_json::to_vec(event)?.len(),
                1,
            );
            let before = self.state.clone();
            self.state.apply_evidence(event);
            trace.push(
                event,
                "context_transaction_committed",
                json!({
                    "object_keys":["release","policy","security"],
                    "source_event_id":event.event_id,
                    "changed": serde_json::to_value(&before)? != serde_json::to_value(&self.state)?
                }),
            );
        }
        Ok(())
    }

    fn project(
        &mut self,
        event: &FixtureEvent,
        _client: &mut DeterministicFakeClient,
        trace: &mut TraceWriter,
    ) -> Result<CurrentState, DynError> {
        let projection = json!({
            "principal_id":event.principal_id,
            "session_id":event.session_id,
            "allowed_objects":["release","policy","security"],
            "state":self.state
        });
        record_model_call(
            trace,
            event,
            request_call_kind(event),
            serde_json::to_vec(&projection)?.len(),
            1,
        );
        trace.push(
            event,
            "context_projection_built",
            json!({
                "principal_id":event.principal_id,
                "allowed_objects":["release","policy","security"]
            }),
        );
        Ok(self.state.clone())
    }

    fn durable_state_present(&self) -> bool {
        self.observations > 0 && self.state.version.is_some()
    }
}

fn adapter_for(arm: DemoArm) -> Box<dyn RoadshowRunnerAdapter> {
    match arm {
        DemoArm::PersistentMessages => Box::<PersistentMessagesAdapter>::default(),
        DemoArm::SummaryJsonMemory => Box::<SummaryJsonMemoryAdapter>::default(),
        DemoArm::MorphzStructuredContext => Box::<MorphzStructuredContextAdapter>::default(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FakeClientManifest {
    purpose: String,
    demo_id: String,
    protocol_version: String,
    runner_mode: String,
    include_in_paper_statistics: bool,
    run_id: String,
    created_at: String,
    arm: DemoArm,
    client: String,
    model_provider_budget_status: String,
    fixture_id: String,
    fixture_version: String,
    fixture_sha256: String,
    event_order_sha256: String,
    adapter_design_sha256: String,
    report_current_state_schema_sha256: String,
    artifacts: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FakeClientRunReport {
    pub run_id: String,
    pub arm: DemoArm,
    pub run_root: PathBuf,
    pub trace_records: usize,
    pub report_current_state_calls: usize,
    pub commit_release_calls: usize,
    pub observed_run: ObservedRun,
    pub score: DemoScore,
    pub passed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FakeClientSuiteReport {
    pub suite_id: String,
    pub purpose: String,
    pub demo_id: String,
    pub protocol_version: String,
    pub runner_mode: String,
    pub suite_root: PathBuf,
    pub fixture_version: String,
    pub fixture_event_count: usize,
    pub runs: Vec<FakeClientRunReport>,
    pub all_adapters_passed: bool,
    pub ready_for_protocol_frozen_v2_decision_gate: bool,
    pub real_model_smoke_permitted: bool,
    pub remaining_manual_freezes: Vec<String>,
}

pub fn run_fake_client_contract_suite(
    base_dir: Option<&Path>,
) -> Result<FakeClientSuiteReport, DynError> {
    let fixture = build_full_history_candidate()?;
    let base = base_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("morphz-roadshow-fake-client"));
    std::fs::create_dir_all(&base)?;
    let base = std::fs::canonicalize(base)?;
    let demo_root = base.join(DEMO_ID);
    std::fs::create_dir_all(&demo_root)?;
    let suite_id = format!(
        "DEMO-001-fake-client-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        std::process::id()
    );
    let suite_root = demo_root.join("_fake_client_runs").join(&suite_id);
    std::fs::create_dir_all(&suite_root)?;
    let mut runs = Vec::new();
    for arm in DemoArm::ALL {
        runs.push(run_fake_client_arm(&demo_root, arm, &fixture, 0)?);
    }
    let all_adapters_passed = runs.iter().all(|run| run.passed);
    let remaining_manual_freezes = vec![
        "full-history candidate wording, event ids/order and fixture hash".to_string(),
        "persistent message active-input limit and exact selector parameters".to_string(),
        "summary JSON prompt, trigger boundaries, maximum size and terminal failure wording"
            .to_string(),
        "Morphz Runtime object schema, Context transaction text and Principal projections"
            .to_string(),
        "exact model, Provider, sampling parameters and common budgets".to_string(),
        "interleaved run order, service-failure replacement queue and code/tag identity"
            .to_string(),
    ];
    let report = FakeClientSuiteReport {
        suite_id,
        purpose: PURPOSE.to_string(),
        demo_id: DEMO_ID.to_string(),
        protocol_version: PROTOCOL_VERSION.to_string(),
        runner_mode: "deterministic_fake_client".to_string(),
        suite_root: suite_root.clone(),
        fixture_version: fixture.fixture_version.clone(),
        fixture_event_count: fixture.events.len(),
        runs,
        all_adapters_passed,
        ready_for_protocol_frozen_v2_decision_gate: all_adapters_passed,
        real_model_smoke_permitted: false,
        remaining_manual_freezes,
    };
    write_json(&suite_root.join("summary.json"), &report)?;
    write_json(
        &suite_root.join("expanded_fixture_candidate.json"),
        &fixture,
    )?;
    std::fs::write(
        suite_root.join("adapter_candidate_design.json"),
        DESIGN_TEXT.as_bytes(),
    )?;
    write_checksums(&suite_root)?;
    Ok(report)
}

fn run_fake_client_arm(
    demo_root: &Path,
    arm: DemoArm,
    fixture: &RoadshowFixture,
    invalid_summary_responses: usize,
) -> Result<FakeClientRunReport, DynError> {
    let run_id = format!(
        "DEMO-001-{}-fake-client-{}-1",
        arm.slug(),
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ")
    );
    let run_root = demo_root.join(&run_id);
    std::fs::create_dir_all(run_root.join("inputs"))?;
    std::fs::create_dir_all(run_root.join("traces"))?;
    std::fs::create_dir_all(run_root.join("outputs"))?;
    std::fs::create_dir_all(run_root.join("scores"))?;
    let fixture_bytes = serde_json::to_vec_pretty(fixture)?;
    std::fs::write(run_root.join("inputs/event_stream.json"), &fixture_bytes)?;
    std::fs::write(
        run_root.join("inputs/adapter_candidate_design.json"),
        DESIGN_TEXT.as_bytes(),
    )?;

    let mut adapter = adapter_for(arm);
    if adapter.arm() != arm {
        return Err("adapter arm mismatch".into());
    }
    let mut client = DeterministicFakeClient::new(invalid_summary_responses);
    let mut trace = TraceWriter::new(arm);
    let start = std::time::Instant::now();

    for event in &fixture.events {
        trace.push(
            event,
            "fixture_event",
            json!({"kind":event.kind,"payload":event.payload}),
        );
        match event.kind.as_str() {
            "evidence" => {
                adapter.ingest(event, &mut client, &mut trace)?;
                if event.stage == "stage_1_concurrent_updates" {
                    trace.push(event, "thread_terminal", json!({"terminal_count":1}));
                }
            }
            "worker_terminated" => {
                trace.push(
                    event,
                    "worker_recovery",
                    json!({"replacement_attached":false,"durable_state_restored":false,"duplicate_external_actions":0}),
                );
            }
            "worker_attached" => {
                trace.push(
                    event,
                    "worker_recovery",
                    json!({
                        "replacement_attached":true,
                        "durable_state_restored":adapter.durable_state_present(),
                        "duplicate_external_actions":0
                    }),
                );
            }
            "user_request" => {
                let state = adapter.project(event, &mut client, &mut trace)?;
                invoke_report_current_state(event, state, &mut trace)?;
            }
            "final_action_request" => {
                let state = adapter.project(event, &mut client, &mut trace)?;
                invoke_commit_release(event, state, &mut trace)?;
            }
            other => return Err(format!("unsupported fixture event kind: {other}").into()),
        }
    }
    let elapsed_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);
    let final_event = fixture.events.last().ok_or("fixture has no events")?;
    trace.push(
        final_event,
        "run_finished",
        json!({"wall_clock_ms":elapsed_ms}),
    );

    let trace_path = run_root.join("traces/runtime_trace.jsonl");
    write_jsonl(&trace_path, &trace.records)?;
    let observed_run = collect_observed_run(&trace_path)?;
    let score = score_observed_run(&observed_run);
    write_json(&run_root.join("outputs/observed_run.json"), &observed_run)?;
    write_json(&run_root.join("scores/score.json"), &score)?;
    let report_calls = trace
        .records
        .iter()
        .filter(|record| {
            record.kind == "tool_call"
                && record.payload.get("tool_name").and_then(Value::as_str)
                    == Some("report_current_state")
        })
        .count();
    let commit_calls = trace
        .records
        .iter()
        .filter(|record| {
            record.kind == "tool_call"
                && record.payload.get("tool_name").and_then(Value::as_str) == Some("commit_release")
        })
        .count();
    let passed = score.passed && report_calls == 2 && commit_calls == 1;
    let manifest = FakeClientManifest {
        purpose: PURPOSE.to_string(),
        demo_id: DEMO_ID.to_string(),
        protocol_version: PROTOCOL_VERSION.to_string(),
        runner_mode: "deterministic_fake_client".to_string(),
        include_in_paper_statistics: false,
        run_id: run_id.clone(),
        created_at: Utc::now().to_rfc3339(),
        arm,
        client: "deterministic_fake_no_network_no_provider".to_string(),
        model_provider_budget_status: "intentionally_unfrozen".to_string(),
        fixture_id: fixture.fixture_id.clone(),
        fixture_version: fixture.fixture_version.clone(),
        fixture_sha256: sha256(&fixture_bytes),
        event_order_sha256: event_order_sha256(fixture),
        adapter_design_sha256: sha256(DESIGN_TEXT.as_bytes()),
        report_current_state_schema_sha256: sha256(
            report_current_state_schema().to_string().as_bytes(),
        ),
        artifacts: BTreeMap::from([
            (
                "fixture".to_string(),
                "inputs/event_stream.json".to_string(),
            ),
            (
                "trace".to_string(),
                "traces/runtime_trace.jsonl".to_string(),
            ),
            (
                "observed_run".to_string(),
                "outputs/observed_run.json".to_string(),
            ),
            ("score".to_string(), "scores/score.json".to_string()),
            ("checksums".to_string(), "checksums.json".to_string()),
        ]),
    };
    write_json(&run_root.join("manifest.json"), &manifest)?;
    write_checksums(&run_root)?;
    Ok(FakeClientRunReport {
        run_id,
        arm,
        run_root,
        trace_records: trace.records.len(),
        report_current_state_calls: report_calls,
        commit_release_calls: commit_calls,
        observed_run,
        score,
        passed,
    })
}

pub fn collect_observed_run(trace_path: &Path) -> Result<ObservedRun, DynError> {
    let records = read_jsonl::<TraceRecord>(trace_path)?;
    let mut final_action_request_sequence = None;
    let mut actions = Vec::new();
    let mut cross_session_current_state = None;
    let mut field_sources = BTreeMap::new();
    let mut thread_terminal_counts = BTreeMap::new();
    let mut worker_recovery = WorkerRecoveryObservation {
        replacement_attached: false,
        durable_state_restored: false,
        duplicate_external_actions: 0,
    };
    let mut current_state_claims_after_late_event = Vec::new();
    let mut model_calls = Vec::new();
    let mut run_wall_clock_ms = 0;

    for record in records {
        if record.kind == "fixture_event"
            && record.payload.get("kind").and_then(Value::as_str) == Some("final_action_request")
        {
            final_action_request_sequence = Some(record.trace_sequence);
        }
        match record.kind.as_str() {
            "tool_call" => {
                let tool_name = record
                    .payload
                    .get("tool_name")
                    .and_then(Value::as_str)
                    .ok_or("tool_call missing tool_name")?;
                let arguments: ReleaseAction = serde_json::from_value(
                    record
                        .payload
                        .get("arguments")
                        .cloned()
                        .ok_or("tool_call missing arguments")?,
                )?;
                let sources: BTreeMap<String, String> = serde_json::from_value(
                    record
                        .payload
                        .get("field_sources")
                        .cloned()
                        .unwrap_or_else(|| json!({})),
                )?;
                if tool_name == "commit_release" {
                    actions.push(ObservedAction {
                        event_sequence: record.trace_sequence,
                        tool_name: tool_name.to_string(),
                        parameters: arguments,
                    });
                } else if tool_name == "report_current_state" {
                    if record.stage == "stage_2_cross_session_continuation" {
                        cross_session_current_state = Some(arguments.clone());
                        field_sources = sources;
                    } else if record.stage == "stage_4_late_conflict" {
                        current_state_claims_after_late_event = action_claims(&arguments);
                    } else {
                        return Err(format!(
                            "report_current_state used in forbidden stage: {}",
                            record.stage
                        )
                        .into());
                    }
                }
            }
            "thread_terminal" => {
                *thread_terminal_counts
                    .entry(record.thread_id.clone())
                    .or_insert(0) += 1;
            }
            "worker_recovery" => {
                let candidate: WorkerRecoveryObservation =
                    serde_json::from_value(record.payload.clone())?;
                if candidate.replacement_attached {
                    worker_recovery = candidate;
                }
            }
            "model_call_usage" => {
                model_calls.push(serde_json::from_value(record.payload.clone())?);
            }
            "run_finished" => {
                run_wall_clock_ms = record
                    .payload
                    .get("wall_clock_ms")
                    .and_then(Value::as_u64)
                    .unwrap_or_default();
            }
            _ => {}
        }
    }
    Ok(ObservedRun {
        measurement_mode: "deterministic_fake_client".to_string(),
        final_action_request_sequence: final_action_request_sequence
            .ok_or("trace missing final action request")?,
        actions,
        cross_session_current_state,
        field_sources,
        thread_terminal_counts,
        worker_recovery,
        current_state_claims_after_late_event,
        model_calls,
        run_wall_clock_ms,
    })
}

fn invoke_report_current_state(
    event: &FixtureEvent,
    state: CurrentState,
    trace: &mut TraceWriter,
) -> Result<(), DynError> {
    if !matches!(
        event.stage.as_str(),
        "stage_2_cross_session_continuation" | "stage_4_late_conflict"
    ) {
        return Err(format!(
            "report_current_state is not allowed in stage {}",
            event.stage
        )
        .into());
    }
    let sources = state.field_sources.clone();
    let arguments = state.into_action()?;
    trace.push(
        event,
        "tool_call",
        json!({
            "tool_name":"report_current_state",
            "arguments":arguments,
            "field_sources":sources,
            "duration_ms":1,
            "result":{"recorded":true}
        }),
    );
    Ok(())
}

fn invoke_commit_release(
    event: &FixtureEvent,
    state: CurrentState,
    trace: &mut TraceWriter,
) -> Result<(), DynError> {
    let sources = state.field_sources.clone();
    let arguments = state.into_action()?;
    trace.push(
        event,
        "tool_call",
        json!({
            "tool_name":"commit_release",
            "arguments":arguments,
            "field_sources":sources,
            "duration_ms":1,
            "result":{"recorded_for_hidden_scoring":true}
        }),
    );
    Ok(())
}

fn report_current_state_schema() -> Value {
    json!({
        "type":"object",
        "required":["project","version","port","endpoint","retention_days","timezone","security_rule"],
        "properties":{
            "project":{"type":"string"},
            "version":{"type":"string"},
            "port":{"type":"integer"},
            "endpoint":{"type":"string"},
            "retention_days":{"type":"integer"},
            "timezone":{"type":"string"},
            "security_rule":{"type":"string"}
        },
        "additionalProperties":false
    })
}

fn record_model_call(
    trace: &mut TraceWriter,
    event: &FixtureEvent,
    call_kind: &str,
    input_bytes: usize,
    wall_clock_ms: u64,
) {
    let input_tokens = u64::try_from(input_bytes.div_ceil(4)).unwrap_or(u64::MAX);
    trace.push(
        event,
        "model_call_usage",
        json!(ModelCallUsage {
            call_kind: call_kind.to_string(),
            input_tokens,
            output_tokens: 0,
            active_context_tokens: input_tokens,
            wall_clock_ms,
        }),
    );
}

fn request_call_kind(event: &FixtureEvent) -> &'static str {
    if event.kind == "final_action_request" {
        "final_action"
    } else {
        "business"
    }
}

fn select_messages(messages: &[FixtureEvent], max_events: Option<usize>) -> Vec<FixtureEvent> {
    let limit = max_events.unwrap_or(messages.len());
    let start = messages.len().saturating_sub(limit);
    messages[start..].to_vec()
}

fn build_full_history_candidate() -> Result<RoadshowFixture, DynError> {
    let base: RoadshowFixture = serde_json::from_str(BASE_FIXTURE_TEXT)?;
    let design: Value = serde_json::from_str(DESIGN_TEXT)?;
    let diagnostic_count = design
        .pointer("/history/irrelevant_diagnostic_count")
        .and_then(Value::as_u64)
        .ok_or("candidate design missing diagnostic count")?;
    let migration_count = design
        .pointer("/history/migration_process_count")
        .and_then(Value::as_u64)
        .ok_or("candidate design missing migration count")?;
    let mut events = base.events[..3].to_vec();
    for index in 1..=diagnostic_count {
        events.push(candidate_history_event(
            format!("orbit42-history-diagnostic-{index:02}"),
            "diagnostic",
            format!(
                "Completed deployment diagnostic {index:02}; no change to approved release, compliance policy, or security rule."
            ),
        ));
    }
    for index in 1..=migration_count {
        events.push(candidate_history_event(
            format!("orbit42-history-migration-{index:02}"),
            "migration_process",
            format!(
                "Historical v1-to-v2 migration note {index:02}; process evidence only, not a current-state update."
            ),
        ));
    }
    events.extend(base.events[3..base.events.len() - 1].iter().cloned());
    let late = events
        .last()
        .cloned()
        .ok_or("candidate fixture missing late event")?;
    events.push(FixtureEvent {
        sequence: 0,
        event_id: "orbit42-stage4-current-state-request".to_string(),
        stage: "stage_4_late_conflict".to_string(),
        kind: "user_request".to_string(),
        principal_id: "principal-release-owner".to_string(),
        session_id: "release-coordination".to_string(),
        thread_id: "release".to_string(),
        injection_group: None,
        scheduled_offset_ms: 0,
        payload: json!({
            "request":"Report the current state after the late archived evidence using report_current_state."
        }),
    });
    let mut final_request = base
        .events
        .last()
        .cloned()
        .ok_or("candidate fixture missing final request")?;
    if late.stage != "stage_4_late_conflict" {
        return Err("candidate fixture late-event placement is invalid".into());
    }
    final_request.sequence = 0;
    events.push(final_request);
    for (index, event) in events.iter_mut().enumerate() {
        event.sequence = u64::try_from(index + 1)?;
    }
    Ok(RoadshowFixture {
        fixture_id: base.fixture_id,
        fixture_version: "candidate-v2-full-history-generated".to_string(),
        purpose: base.purpose,
        events,
    })
}

fn candidate_history_event(event_id: String, record_type: &str, text: String) -> FixtureEvent {
    FixtureEvent {
        sequence: 0,
        event_id,
        stage: "history".to_string(),
        kind: "evidence".to_string(),
        principal_id: "principal-release-owner".to_string(),
        session_id: "release-coordination".to_string(),
        thread_id: "history-load".to_string(),
        injection_group: None,
        scheduled_offset_ms: 0,
        payload: json!({
            "status":"process-record",
            "project":"ORBIT-42",
            "record_type":record_type,
            "text":text,
            "changes_current_state":false
        }),
    }
}

fn action_claims(action: &ReleaseAction) -> Vec<String> {
    vec![
        format!("project={}", action.project),
        format!("version={}", action.version),
        format!("port={}", action.port),
        format!("endpoint={}", action.endpoint),
        format!("retention_days={}", action.retention_days),
        format!("timezone={}", action.timezone),
        format!("security_rule={}", action.security_rule),
    ]
}

fn event_order_sha256(fixture: &RoadshowFixture) -> String {
    let order = fixture
        .events
        .iter()
        .map(|event| format!("{}:{}", event.sequence, event.event_id))
        .collect::<Vec<_>>()
        .join("\n");
    sha256(order.as_bytes())
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), DynError> {
    std::fs::write(path, serde_json::to_vec_pretty(value)?)?;
    Ok(())
}

fn write_jsonl(path: &Path, values: &[TraceRecord]) -> Result<(), DynError> {
    let mut output = Vec::new();
    for value in values {
        serde_json::to_writer(&mut output, value)?;
        output.push(b'\n');
    }
    std::fs::write(path, output)?;
    Ok(())
}

fn read_jsonl<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Vec<T>, DynError> {
    std::fs::read_to_string(path)?
        .lines()
        .map(|line| serde_json::from_str(line).map_err(Into::into))
        .collect()
}

fn write_checksums(root: &Path) -> Result<(), DynError> {
    let mut checksums = BTreeMap::new();
    for entry in WalkDir::new(root).sort_by_file_name() {
        let entry = entry?;
        if !entry.file_type().is_file() || entry.path() == root.join("checksums.json") {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(root)?
            .to_string_lossy()
            .to_string();
        checksums.insert(relative, sha256(&std::fs::read(entry.path())?));
    }
    write_json(&root.join("checksums.json"), &checksums)
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_history_candidate_has_expected_shape_without_being_frozen() {
        let fixture = build_full_history_candidate().unwrap();
        assert_eq!(
            fixture.fixture_version,
            "candidate-v2-full-history-generated"
        );
        assert_eq!(fixture.events.len(), 43);
        assert_eq!(
            fixture
                .events
                .iter()
                .filter(|event| event.stage == "history")
                .count(),
            35
        );
        assert_eq!(
            fixture
                .events
                .iter()
                .filter(|event| event.kind == "final_action_request")
                .count(),
            1
        );
    }

    #[test]
    fn all_three_adapters_round_trip_through_trace_collector() {
        let temp = tempfile::tempdir().unwrap();
        let report = run_fake_client_contract_suite(Some(temp.path())).unwrap();
        assert!(report.all_adapters_passed);
        assert!(report.ready_for_protocol_frozen_v2_decision_gate);
        assert!(!report.real_model_smoke_permitted);
        assert_eq!(report.runs.len(), 3);
        for run in report.runs {
            assert!(run.score.passed);
            assert_eq!(run.report_current_state_calls, 2);
            assert_eq!(run.commit_release_calls, 1);
            assert_eq!(
                run.score.metrics.status,
                "deterministic_fake_not_reportable"
            );
        }
    }

    #[test]
    fn summary_invalid_once_uses_one_counted_repair_and_still_collects() {
        let temp = tempfile::tempdir().unwrap();
        let demo_root = temp.path().join(DEMO_ID);
        std::fs::create_dir_all(&demo_root).unwrap();
        let fixture = build_full_history_candidate().unwrap();
        let run = run_fake_client_arm(&demo_root, DemoArm::SummaryJsonMemory, &fixture, 1).unwrap();
        assert!(run.passed);
        let trace =
            std::fs::read_to_string(run.run_root.join("traces/runtime_trace.jsonl")).unwrap();
        assert_eq!(trace.matches("summary_parse_failure").count(), 1);
        assert!(
            run.observed_run
                .model_calls
                .iter()
                .filter(|call| call.call_kind == "state_maintenance")
                .count()
                >= 2
        );
    }

    #[test]
    fn summary_invalid_twice_terminates_instead_of_overwriting_memory() {
        let temp = tempfile::tempdir().unwrap();
        let demo_root = temp.path().join(DEMO_ID);
        std::fs::create_dir_all(&demo_root).unwrap();
        let fixture = build_full_history_candidate().unwrap();
        let error = run_fake_client_arm(&demo_root, DemoArm::SummaryJsonMemory, &fixture, 2)
            .unwrap_err()
            .to_string();
        assert!(error.contains("remained invalid after one counted repair"));
    }

    #[test]
    fn message_selector_keeps_newest_complete_events_in_chronological_order() {
        let fixture = build_full_history_candidate().unwrap();
        let selected = select_messages(&fixture.events, Some(5));
        assert_eq!(selected.len(), 5);
        assert!(selected
            .windows(2)
            .all(|pair| pair[0].sequence < pair[1].sequence));
        assert_eq!(
            selected.last().map(|event| event.kind.as_str()),
            Some("final_action_request")
        );
    }

    #[test]
    fn report_current_state_rejects_forbidden_stage() {
        let fixture = build_full_history_candidate().unwrap();
        let event = fixture
            .events
            .iter()
            .find(|event| event.stage == "stage_1_concurrent_updates")
            .unwrap();
        let mut trace = TraceWriter::new(DemoArm::PersistentMessages);
        let error = invoke_report_current_state(event, CurrentState::default(), &mut trace)
            .unwrap_err()
            .to_string();
        assert!(error.contains("not allowed"));
    }
}
