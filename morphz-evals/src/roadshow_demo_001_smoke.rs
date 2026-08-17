use crate::roadshow_demo_001::{
    score_observed_run, DemoArm, DemoScore, FixtureEvent, ModelCallUsage, ObservedAction,
    ObservedRun, ReleaseAction, RoadshowFixture, WorkerRecoveryObservation,
};
use chrono::Utc;
use morphz::config;
use morphz::llm::{
    Client, Message, ModelRequestContext, ModelStreamEvent, ModelUsage, ReasoningEffort, Response,
    ToolDefinition,
};
use morphz::provider::build_configured_client;
use morphz::runtime::MorphzRuntime;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};
use walkdir::WalkDir;

type DynError = Box<dyn std::error::Error + Send + Sync>;

const MODEL: &str = "gpt-5.6-sol";
const PROVIDER: &str = "custom";
const PROFILE: &str = "roadshow-demo-001";
const PROTOCOL_VERSION: &str = "frozen-v2.1";
const RUNTIME_BASELINE_ID: &str = "paper-eval-runtime-v2";
const RUNTIME_BASELINE_COMMIT: &str = "03a32f864a3c38026672b4076855137e0bbb5627";
const DEMO_TAG: &str = "demo-001-frozen-v2.1-selective-20260817";
const ACTIVE_INPUT_CAP: usize = 8192;
const BUSINESS_OUTPUT_CAP: usize = 512;
const MAINTENANCE_OUTPUT_CAP: usize = 1024;
const CALL_TIMEOUT: Duration = Duration::from_secs(180);
const RUN_TIMEOUT: Duration = Duration::from_secs(900);

const FIXTURE_TEXT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/roadshow_demo_001_v2/frozen/event_stream_normal_load.json"
));
const PROMPT_BUNDLE_TEXT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/roadshow_demo_001_v2/frozen/prompt_bundle.json"
));
const STATE_CONTRACT_TEXT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/roadshow_demo_001_v2/frozen/state_contract.json"
));
const MODEL_PROFILE_TEXT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/profiles/roadshow-demo-001.toml"
));

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Facts {
    project: Option<String>,
    version: Option<String>,
    port: Option<u16>,
    endpoint: Option<String>,
    retention_days: Option<u16>,
    timezone: Option<String>,
    security_rule: Option<String>,
}

impl Facts {
    fn action(&self) -> Result<ReleaseAction, DynError> {
        Ok(ReleaseAction {
            project: self.project.clone().ok_or("state missing project")?,
            version: self.version.clone().ok_or("state missing version")?,
            port: self.port.ok_or("state missing port")?,
            endpoint: self.endpoint.clone().ok_or("state missing endpoint")?,
            retention_days: self.retention_days.ok_or("state missing retention_days")?,
            timezone: self.timezone.clone().ok_or("state missing timezone")?,
            security_rule: self
                .security_rule
                .clone()
                .ok_or("state missing security_rule")?,
        })
    }

    fn value_for(&self, field: &str) -> Value {
        match field {
            "project" => json!(self.project),
            "version" => json!(self.version),
            "port" => json!(self.port),
            "endpoint" => json!(self.endpoint),
            "retention_days" => json!(self.retention_days),
            "timezone" => json!(self.timezone),
            "security_rule" => json!(self.security_rule),
            _ => Value::Null,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct SourceRef {
    event_id: String,
    principal_id: String,
    observed_sequence: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StateMemory {
    schema_version: String,
    current_facts: Facts,
    field_sources: BTreeMap<String, SourceRef>,
    #[serde(default)]
    open_items: Vec<String>,
    #[serde(default)]
    source_notes: Vec<String>,
    last_maintained_event_sequence: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct DurableArmState {
    history: Vec<FixtureEvent>,
    pending_evidence: Vec<FixtureEvent>,
    memory: Option<StateMemory>,
    report_transcript: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize)]
struct PromptBundle {
    system_prompt: String,
    tool_schemas: Vec<ToolDefinition>,
}

#[derive(Debug, Clone, Deserialize)]
struct StateContract {
    summary_schema: Value,
    summary_maintenance_prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CallReceipt {
    call_kind: String,
    stage: String,
    requested_model: String,
    physical_model: String,
    requested_reasoning: String,
    accepted_reasoning: String,
    requested_max_output_tokens: usize,
    provider_max_output_tokens: String,
    uncached_equivalent_input_tokens: usize,
    harness_output_tokens: usize,
    provider_usage: ModelUsage,
    wall_clock_ms: u64,
    tool_calls: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SmokeManifest {
    purpose: String,
    demo_id: String,
    protocol_version: String,
    include_in_paper_statistics: bool,
    runner_mode: String,
    run_id: String,
    created_at: String,
    arm: DemoArm,
    load_level: String,
    pair_cell_id: u64,
    model_profile: String,
    provider: String,
    model: String,
    physical_model: String,
    route_fallback: bool,
    requested_reasoning: String,
    accepted_reasoning: String,
    sampling_seed_applied: bool,
    active_input_cap: usize,
    business_output_acceptance_cap: usize,
    maintenance_output_acceptance_cap: usize,
    provider_max_output_tokens: String,
    cost_attribution: String,
    tokenizer: String,
    fixture_file_sha256: String,
    prompt_bundle_sha256: String,
    state_contract_sha256: String,
    model_profile_sha256: String,
    runtime_baseline_id: String,
    runtime_baseline_commit: String,
    code_commit: String,
    demo_tag: String,
    call_receipts: Vec<CallReceipt>,
    artifacts: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RealSmokeRunReport {
    pub run_id: String,
    pub arm: DemoArm,
    pub run_root: PathBuf,
    pub score: DemoScore,
    pub provider_calls: usize,
    pub passed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RealSmokeSuiteReport {
    pub suite_id: String,
    pub suite_root: PathBuf,
    pub exact_model: String,
    pub reasoning: String,
    pub runs: Vec<RealSmokeRunReport>,
    pub all_passed: bool,
    pub full_batch_permitted: bool,
}

struct SmokeClient {
    client: Arc<dyn Client>,
    physical_model: String,
}

impl SmokeClient {
    async fn call(
        &self,
        call_kind: &str,
        stage: &str,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
        output_cap: usize,
    ) -> Result<(Response, CallReceipt), DynError> {
        let input_tokens = count_harness_tokens(&json!({
            "messages": messages,
            "tools": tools
        }))?;
        if input_tokens > ACTIVE_INPUT_CAP {
            return Err(format!(
                "active input budget exceeded before request: {input_tokens} > {ACTIVE_INPUT_CAP}"
            )
            .into());
        }
        let measurement = self
            .client
            .count_prompt_tokens(call_kind, &messages, &tools)
            .await?;
        let (stream, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let started = Instant::now();
        let response = tokio::time::timeout(
            CALL_TIMEOUT,
            self.client
                .create_completion_measured_stream(messages, tools, measurement, stream),
        )
        .await
        .map_err(|_| format!("model call exceeded {} seconds", CALL_TIMEOUT.as_secs()))??;
        let wall_clock_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let mut usage = ModelUsage::default();
        while let Ok(event) = receiver.try_recv() {
            if let ModelStreamEvent::Usage { usage: newer } = event {
                usage.merge_from(&newer);
            }
        }
        let output_value = json!({
            "content": response.content,
            "tool_calls": response.tool_calls
        });
        let output_tokens = count_harness_tokens(&output_value)?;
        if output_tokens > output_cap {
            return Err(format!(
                "Harness output acceptance cap exceeded: {output_tokens} > {output_cap}"
            )
            .into());
        }
        let receipt = CallReceipt {
            call_kind: call_kind.to_string(),
            stage: stage.to_string(),
            requested_model: MODEL.to_string(),
            physical_model: self.physical_model.clone(),
            requested_reasoning: "max".to_string(),
            accepted_reasoning: "request_succeeded_with_max".to_string(),
            requested_max_output_tokens: output_cap,
            provider_max_output_tokens: "requested_provider_echo_unavailable".to_string(),
            uncached_equivalent_input_tokens: input_tokens,
            harness_output_tokens: output_tokens,
            provider_usage: usage,
            wall_clock_ms,
            tool_calls: response.tool_calls.len(),
        };
        Ok((response, receipt))
    }
}

pub fn validate_frozen_smoke_contract() -> Result<Value, DynError> {
    let fixture: RoadshowFixture = serde_json::from_str(FIXTURE_TEXT)?;
    if fixture.purpose != "roadshow_demo"
        || fixture.fixture_version != "frozen-v2-normal_load"
        || fixture.events.len() != 43
    {
        return Err("normal frozen fixture identity mismatch".into());
    }
    let bundle: PromptBundle = serde_json::from_str(PROMPT_BUNDLE_TEXT)?;
    if bundle.tool_schemas.len() != 5 {
        return Err("frozen prompt bundle must expose five common tools".into());
    }
    let state: StateContract = serde_json::from_str(STATE_CONTRACT_TEXT)?;
    if state.summary_schema.is_null() || state.summary_maintenance_prompt.trim().is_empty() {
        return Err("frozen state contract is incomplete".into());
    }
    Ok(json!({
        "passed": true,
        "fixture_events": fixture.events.len(),
        "tools": bundle.tool_schemas.len(),
        "model": MODEL,
        "model_profile": PROFILE,
        "model_profile_sha256": sha256(MODEL_PROFILE_TEXT.as_bytes()),
        "reasoning": "max",
        "active_input_cap": ACTIVE_INPUT_CAP,
        "runtime_baseline_id": RUNTIME_BASELINE_ID,
        "runtime_baseline_commit": RUNTIME_BASELINE_COMMIT,
        "real_model_called": false
    }))
}

pub async fn validate_morphz_profile_binding(base_dir: Option<&Path>) -> Result<Value, DynError> {
    validate_frozen_smoke_contract()?;
    let root = base_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("morphz-roadshow-profile-preflight"));
    std::fs::create_dir_all(&root)?;
    let (client, runtime, physical_model) = build_exact_smoke_client(&root).await?;
    drop(client);
    drop(runtime);
    Ok(json!({
        "passed": true,
        "profile": PROFILE,
        "provider": PROVIDER,
        "logical_model": MODEL,
        "physical_model": physical_model,
        "reasoning": "max",
        "morphz_profile_loaded": true,
        "real_model_called": false
    }))
}

pub async fn run_real_model_normal_smoke_suite(
    base_dir: Option<&Path>,
) -> Result<RealSmokeSuiteReport, DynError> {
    validate_frozen_smoke_contract()?;
    let fixture: RoadshowFixture = serde_json::from_str(FIXTURE_TEXT)?;
    let bundle: PromptBundle = serde_json::from_str(PROMPT_BUNDLE_TEXT)?;
    let state_contract: StateContract = serde_json::from_str(STATE_CONTRACT_TEXT)?;
    let base = base_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("morphz-roadshow-real-smoke"));
    std::fs::create_dir_all(&base)?;
    let suite_id = format!(
        "DEMO-001-normal-smoke-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        std::process::id()
    );
    let suite_root = base
        .join("DEMO-001")
        .join(PROTOCOL_VERSION)
        .join("runs")
        .join(&suite_id);
    std::fs::create_dir_all(&suite_root)?;

    let (client, runtime_guard, physical_model) = build_exact_smoke_client(&suite_root).await?;
    let smoke_client = SmokeClient {
        client,
        physical_model,
    };
    let started = Instant::now();
    let mut runs = Vec::new();
    for arm in DemoArm::ALL {
        if started.elapsed() > RUN_TIMEOUT {
            return Err(format!("smoke suite exceeded {} seconds", RUN_TIMEOUT.as_secs()).into());
        }
        runs.push(
            run_arm(
                &suite_root,
                arm,
                &fixture,
                &bundle,
                &state_contract,
                &smoke_client,
            )
            .await?,
        );
    }
    drop(runtime_guard);
    let all_passed = runs.iter().all(|run| run.passed);
    let report = RealSmokeSuiteReport {
        suite_id,
        suite_root: suite_root.clone(),
        exact_model: MODEL.to_string(),
        reasoning: "max".to_string(),
        runs,
        all_passed,
        full_batch_permitted: false,
    };
    write_json(&suite_root.join("summary.json"), &report)?;
    write_checksums(&suite_root)?;
    Ok(report)
}

async fn build_exact_smoke_client(
    suite_root: &Path,
) -> Result<(Arc<dyn Client>, MorphzRuntime, String), DynError> {
    if let Some(path) = config::host_env_path() {
        if let Err(error) = config::load_env(&path.to_string_lossy()) {
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(format!("failed to load Morphz host environment: {error}").into());
            }
        }
    }
    let cwd = std::env::current_dir()?;
    let mut resolved = config::resolve_config(&cwd, None, Some(PROFILE))?;
    let profile_path = config::morphz_home_dir()
        .ok_or("cannot resolve Morphz home for roadshow profile")?
        .join("profiles")
        .join(format!("{PROFILE}.toml"));
    let installed_profile = std::fs::read(&profile_path)?;
    if sha256(&installed_profile) != sha256(MODEL_PROFILE_TEXT.as_bytes()) {
        return Err(format!(
            "installed roadshow profile differs from frozen template: {}",
            profile_path.display()
        )
        .into());
    }
    resolved.config.apply_runtime_env_overrides()?;
    let route = resolved
        .config
        .model_routes
        .get(MODEL)
        .ok_or("exact gpt-5.6-sol route is not configured")?;
    if route.fallback || route.candidates.len() != 1 {
        return Err("gpt-5.6-sol route must have one candidate and fallback=false".into());
    }
    let candidate = &route.candidates[0];
    if candidate.provider != PROVIDER || candidate.model != MODEL {
        return Err("roadshow profile binding is not exact custom/gpt-5.6-sol".into());
    }
    resolved.config.llm.model = MODEL.to_string();
    resolved.config.llm.reasoning_effort = Some(ReasoningEffort::Max);
    resolved.config.llm.max_output_tokens = Some(MAINTENANCE_OUTPUT_CAP as u32);
    let (client, selected) = build_configured_client(&resolved.config, None, Some(MODEL))?;
    if selected.model != MODEL || selected.id != PROVIDER {
        return Err("configured client selected a different model/provider".into());
    }
    client.set_reasoning_effort(Some(ReasoningEffort::Max))?;
    if client.reasoning_effort() != Some(ReasoningEffort::Max) {
        return Err("client did not retain reasoning=max".into());
    }
    let database_path = suite_root.join("smoke-runtime.db");
    let runtime = MorphzRuntime::builder(resolved.config, Arc::clone(&client))
        .database_path(database_path.to_string_lossy().to_string())
        .build()
        .await?;
    let binding = client
        .bind_model_attempt(&ModelRequestContext {
            context_id: "demo-001-readiness".to_string(),
            session_id: "demo-001-readiness".to_string(),
            attempt_id: "pre-request-binding".to_string(),
            objective_id: None,
            required_capabilities: Vec::new(),
        })
        .await?;
    if binding.requested_alias != MODEL
        || binding.physical_model != MODEL
        || binding.provider_instance_id != PROVIDER
        || binding.protocol != "openai-responses"
    {
        return Err(format!(
            "exact binding mismatch before request: {}/{}/{}",
            binding.requested_alias, binding.provider_instance_id, binding.physical_model
        )
        .into());
    }
    Ok((client, runtime, binding.physical_model))
}

async fn run_arm(
    suite_root: &Path,
    arm: DemoArm,
    fixture: &RoadshowFixture,
    bundle: &PromptBundle,
    state_contract: &StateContract,
    client: &SmokeClient,
) -> Result<RealSmokeRunReport, DynError> {
    let run_id = format!(
        "DEMO-001-normal-{}-42001-{}",
        arm.slug(),
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ")
    );
    let run_root = suite_root.join(&run_id);
    std::fs::create_dir_all(run_root.join("inputs"))?;
    std::fs::create_dir_all(run_root.join("traces"))?;
    std::fs::create_dir_all(run_root.join("outputs"))?;
    std::fs::create_dir_all(run_root.join("scores"))?;
    std::fs::write(run_root.join("inputs/event_stream.json"), FIXTURE_TEXT)?;
    std::fs::write(
        run_root.join("inputs/prompt_bundle.json"),
        PROMPT_BUNDLE_TEXT,
    )?;
    std::fs::write(
        run_root.join("inputs/state_contract.json"),
        STATE_CONTRACT_TEXT,
    )?;

    let run_started = Instant::now();
    let mut durable = DurableArmState::default();
    let mut receipts = Vec::new();
    let mut trace = Vec::<Value>::new();
    let mut report_stage2 = None;
    let mut report_stage4 = None;
    let mut final_action = None;
    let mut final_request_trace_sequence = 0_u64;
    let mut thread_terminal_counts = BTreeMap::new();
    let mut recovery = WorkerRecoveryObservation {
        replacement_attached: false,
        durable_state_restored: false,
        duplicate_external_actions: 0,
    };

    for event in &fixture.events {
        trace.push(json!({"kind":"fixture_event","event":event}));
        match event.kind.as_str() {
            "evidence" => {
                durable.history.push(event.clone());
                durable.pending_evidence.push(event.clone());
                if event.stage == "stage_1_concurrent_updates" {
                    *thread_terminal_counts
                        .entry(event.thread_id.clone())
                        .or_insert(0) += 1;
                }
            }
            "worker_terminated" => {
                durable.history.push(event.clone());
                write_json(
                    &run_root.join("outputs/durable_state_before_replacement.json"),
                    &durable,
                )?;
            }
            "worker_attached" => {
                let restored: DurableArmState = serde_json::from_slice(&std::fs::read(
                    run_root.join("outputs/durable_state_before_replacement.json"),
                )?)?;
                durable = restored;
                durable.history.push(event.clone());
                recovery.replacement_attached = true;
                recovery.durable_state_restored = !durable.history.is_empty()
                    && (arm == DemoArm::PersistentMessages || durable.memory.is_some());
            }
            "user_request" => {
                ensure_state_current(
                    arm,
                    event,
                    &mut durable,
                    state_contract,
                    client,
                    &mut receipts,
                    &mut trace,
                )
                .await?;
                let (action, receipt) =
                    business_call(arm, event, &durable, bundle, client, "report_current_state")
                        .await?;
                receipts.push(receipt);
                durable.report_transcript.push(json!({
                    "stage":event.stage,
                    "tool":"report_current_state",
                    "arguments":action,
                    "receipt":{"recorded":true,"correctness_disclosed":false}
                }));
                if event.stage == "stage_2_cross_session_continuation" {
                    report_stage2 = Some(action);
                } else if event.stage == "stage_4_late_conflict" {
                    report_stage4 = Some(action);
                } else {
                    return Err(format!("report request in forbidden stage {}", event.stage).into());
                }
                durable.history.push(event.clone());
            }
            "final_action_request" => {
                final_request_trace_sequence = u64::try_from(trace.len())?;
                let (action, receipt) =
                    business_call(arm, event, &durable, bundle, client, "commit_release").await?;
                receipts.push(receipt);
                final_action = Some(action);
            }
            other => return Err(format!("unsupported fixture event kind {other}").into()),
        }
    }
    let stage2 = report_stage2.ok_or("missing Stage 2 report_current_state")?;
    let stage4 = report_stage4.ok_or("missing Stage 4 report_current_state")?;
    let final_action = final_action.ok_or("missing final commit_release")?;
    let sources = source_principals_for_action(&stage2, &durable.history);
    let actions = vec![ObservedAction {
        event_sequence: final_request_trace_sequence.saturating_add(1),
        tool_name: "commit_release".to_string(),
        parameters: final_action,
    }];
    let model_calls = receipts
        .iter()
        .map(|receipt| ModelCallUsage {
            call_kind: receipt.call_kind.clone(),
            input_tokens: receipt
                .provider_usage
                .input_tokens
                .unwrap_or(receipt.uncached_equivalent_input_tokens as u64),
            output_tokens: receipt
                .provider_usage
                .output_tokens
                .unwrap_or(receipt.harness_output_tokens as u64),
            active_context_tokens: receipt.uncached_equivalent_input_tokens as u64,
            wall_clock_ms: receipt.wall_clock_ms,
        })
        .collect::<Vec<_>>();
    let observed = ObservedRun {
        measurement_mode: "real_model_smoke_subscription".to_string(),
        final_action_request_sequence: final_request_trace_sequence,
        actions,
        cross_session_current_state: Some(stage2),
        field_sources: sources,
        thread_terminal_counts,
        worker_recovery: recovery,
        current_state_claims_after_late_event: action_claims(&stage4),
        model_calls,
        run_wall_clock_ms: u64::try_from(run_started.elapsed().as_millis()).unwrap_or(u64::MAX),
    };
    let score = score_observed_run(&observed);
    write_json(&run_root.join("traces/runtime_trace.json"), &trace)?;
    write_json(&run_root.join("outputs/observed_run.json"), &observed)?;
    write_json(&run_root.join("scores/score.json"), &score)?;
    let manifest = SmokeManifest {
        purpose: "roadshow_demo".to_string(),
        demo_id: "DEMO-001".to_string(),
        protocol_version: PROTOCOL_VERSION.to_string(),
        include_in_paper_statistics: false,
        runner_mode: "real_model_normal_smoke".to_string(),
        run_id: run_id.clone(),
        created_at: Utc::now().to_rfc3339(),
        arm,
        load_level: "normal_load".to_string(),
        pair_cell_id: 42001,
        model_profile: PROFILE.to_string(),
        provider: PROVIDER.to_string(),
        model: MODEL.to_string(),
        physical_model: client.physical_model.clone(),
        route_fallback: false,
        requested_reasoning: "max".to_string(),
        accepted_reasoning: "request_succeeded_with_max".to_string(),
        sampling_seed_applied: false,
        active_input_cap: ACTIVE_INPUT_CAP,
        business_output_acceptance_cap: BUSINESS_OUTPUT_CAP,
        maintenance_output_acceptance_cap: MAINTENANCE_OUTPUT_CAP,
        provider_max_output_tokens: "requested_provider_echo_unavailable".to_string(),
        cost_attribution: "subscription_not_monetarily_attributed".to_string(),
        tokenizer: "tiktoken:0.12.0:o200k_base".to_string(),
        fixture_file_sha256: sha256(FIXTURE_TEXT.as_bytes()),
        prompt_bundle_sha256: sha256(PROMPT_BUNDLE_TEXT.as_bytes()),
        state_contract_sha256: sha256(STATE_CONTRACT_TEXT.as_bytes()),
        model_profile_sha256: sha256(MODEL_PROFILE_TEXT.as_bytes()),
        runtime_baseline_id: RUNTIME_BASELINE_ID.to_string(),
        runtime_baseline_commit: RUNTIME_BASELINE_COMMIT.to_string(),
        code_commit: git_output(&["rev-parse", "HEAD"]),
        demo_tag: DEMO_TAG.to_string(),
        call_receipts: receipts,
        artifacts: BTreeMap::from([
            (
                "fixture".to_string(),
                "inputs/event_stream.json".to_string(),
            ),
            ("trace".to_string(), "traces/runtime_trace.json".to_string()),
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
    Ok(RealSmokeRunReport {
        run_id,
        arm,
        run_root,
        score: score.clone(),
        provider_calls: manifest.call_receipts.len(),
        passed: score.passed,
    })
}

async fn ensure_state_current(
    arm: DemoArm,
    event: &FixtureEvent,
    durable: &mut DurableArmState,
    state_contract: &StateContract,
    client: &SmokeClient,
    receipts: &mut Vec<CallReceipt>,
    trace: &mut Vec<Value>,
) -> Result<(), DynError> {
    if arm == DemoArm::PersistentMessages || durable.pending_evidence.is_empty() {
        return Ok(());
    }
    let mode_instruction = match arm {
        DemoArm::SummaryJsonMemory => state_contract.summary_maintenance_prompt.clone(),
        DemoArm::MorphzStructuredContext => format!(
            "Propose one atomic Structured Context transaction. {} Runtime validation will check schema, Principal/object permission, source event references, and supersession. Return only the resulting JSON state.",
            state_contract.summary_maintenance_prompt
        ),
        DemoArm::PersistentMessages => unreachable!(),
    };
    let system = format!(
        "{mode_instruction}\nSchema:\n{}\nState must use schema_version demo-001-summary-v1.",
        state_contract.summary_schema
    );
    let input = json!({
        "prior_valid_state": durable.memory,
        "new_complete_events": durable.pending_evidence
    });
    let messages = vec![
        message("system", system.clone()),
        message("user", input.to_string()),
    ];
    let (mut response, mut receipt) = client
        .call(
            "state_maintenance",
            &event.stage,
            messages,
            Vec::new(),
            MAINTENANCE_OUTPUT_CAP,
        )
        .await?;
    let mut memory = parse_state_memory(&response.content);
    if memory.as_ref().is_err() {
        receipts.push(receipt);
        let repair = vec![
            message("system", system.clone()),
            message(
                "user",
                format!(
                    "The prior answer was invalid. Return only valid JSON matching the schema. Invalid answer:\n{}\nInput:\n{}",
                    response.content, input
                ),
            ),
        ];
        (response, receipt) = client
            .call(
                "state_maintenance_repair",
                &event.stage,
                repair,
                Vec::new(),
                MAINTENANCE_OUTPUT_CAP,
            )
            .await?;
        memory = parse_state_memory(&response.content);
    }
    let memory = memory?;
    if count_harness_tokens(&serde_json::to_value(&memory)?)? > 2048 {
        return Err("maintained state exceeds 2,048-token cap".into());
    }
    validate_memory_shape(&memory, &durable.pending_evidence)?;
    if arm == DemoArm::MorphzStructuredContext {
        validate_context_transaction(&memory, &durable.history)?;
    }
    trace.push(json!({
        "kind": if arm == DemoArm::MorphzStructuredContext {"context_transaction_committed"} else {"summary_memory_committed"},
        "stage":event.stage,
        "last_maintained_event_sequence":memory.last_maintained_event_sequence
    }));
    durable.memory = Some(memory);
    durable.pending_evidence.clear();
    receipts.push(receipt);
    Ok(())
}

async fn business_call(
    arm: DemoArm,
    event: &FixtureEvent,
    durable: &DurableArmState,
    bundle: &PromptBundle,
    client: &SmokeClient,
    expected_tool: &str,
) -> Result<(ReleaseAction, CallReceipt), DynError> {
    let state_input = match arm {
        DemoArm::PersistentMessages => json!({
            "durable_append_only_events": durable.history,
            "prior_tool_transcript": durable.report_transcript
        }),
        DemoArm::SummaryJsonMemory => json!({
            "summary_json_memory": durable.memory,
            "prior_tool_transcript": durable.report_transcript
        }),
        DemoArm::MorphzStructuredContext => json!({
            "authorized_context_projection": durable.memory,
            "principal_id":event.principal_id,
            "session_id":event.session_id,
            "allowed_objects":[
                "release:orbit42/current",
                "policy:orbit42/retention",
                "policy:orbit42/timezone",
                "rule:orbit42/no-secret-logging"
            ],
            "prior_tool_transcript": durable.report_transcript
        }),
    };
    let request = event
        .payload
        .get("request")
        .and_then(Value::as_str)
        .ok_or("business event missing request")?;
    let messages = vec![
        message("system", bundle.system_prompt.clone()),
        message(
            "user",
            format!(
                "Available state/history:\n{}\n\nCurrent request:\n{request}",
                state_input
            ),
        ),
    ];
    let call_kind = if expected_tool == "commit_release" {
        "final_action"
    } else {
        "business"
    };
    let (response, receipt) = client
        .call(
            call_kind,
            &event.stage,
            messages,
            bundle.tool_schemas.clone(),
            BUSINESS_OUTPUT_CAP,
        )
        .await?;
    let matching = response
        .tool_calls
        .iter()
        .filter(|call| call.func_name == expected_tool)
        .collect::<Vec<_>>();
    if matching.len() != 1 {
        return Err(format!(
            "expected exactly one {expected_tool} call, observed {}",
            matching.len()
        )
        .into());
    }
    let action: ReleaseAction = serde_json::from_str(&matching[0].arguments)?;
    Ok((action, receipt))
}

fn parse_state_memory(text: &str) -> Result<StateMemory, DynError> {
    let trimmed = text.trim();
    if let Ok(memory) = serde_json::from_str(trimmed) {
        return Ok(memory);
    }
    let start = trimmed
        .find('{')
        .ok_or("maintenance output has no JSON object")?;
    let end = trimmed
        .rfind('}')
        .ok_or("maintenance output has no closing brace")?;
    Ok(serde_json::from_str(&trimmed[start..=end])?)
}

fn validate_memory_shape(memory: &StateMemory, pending: &[FixtureEvent]) -> Result<(), DynError> {
    if memory.schema_version != "demo-001-summary-v1" {
        return Err("maintenance returned wrong schema_version".into());
    }
    let expected_sequence = pending
        .last()
        .map(|event| event.sequence)
        .ok_or("maintenance pending evidence is empty")?;
    if memory.last_maintained_event_sequence != expected_sequence {
        return Err(format!(
            "maintenance sequence mismatch: {} != {}",
            memory.last_maintained_event_sequence, expected_sequence
        )
        .into());
    }
    memory.current_facts.action()?;
    for field in [
        "version",
        "port",
        "endpoint",
        "retention_days",
        "timezone",
        "security_rule",
    ] {
        if !memory.field_sources.contains_key(field) {
            return Err(format!("maintenance missing source for {field}").into());
        }
    }
    Ok(())
}

fn validate_context_transaction(
    memory: &StateMemory,
    history: &[FixtureEvent],
) -> Result<(), DynError> {
    for (field, source) in &memory.field_sources {
        let event = history
            .iter()
            .find(|event| event.event_id == source.event_id)
            .ok_or_else(|| format!("Context source event not found for {field}"))?;
        if event.principal_id != source.principal_id || event.sequence != source.observed_sequence {
            return Err(format!("Context source identity mismatch for {field}").into());
        }
        let status = event
            .payload
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if matches!(status, "superseded" | "archived-untrusted") {
            return Err(
                format!("Context transaction selected historical source for {field}").into(),
            );
        }
        if let Some(source_value) = event.payload.get(field) {
            let accepted = memory.current_facts.value_for(field);
            if accepted != *source_value {
                return Err(format!("Context source value mismatch for {field}").into());
            }
        }
    }
    Ok(())
}

fn source_principals_for_action(
    action: &ReleaseAction,
    history: &[FixtureEvent],
) -> BTreeMap<String, String> {
    let pairs = [
        ("version", json!(action.version)),
        ("port", json!(action.port)),
        ("endpoint", json!(action.endpoint)),
        ("retention_days", json!(action.retention_days)),
        ("timezone", json!(action.timezone)),
        ("security_rule", json!(action.security_rule)),
    ];
    pairs
        .into_iter()
        .filter_map(|(field, value)| {
            history
                .iter()
                .rev()
                .find(|event| {
                    let status = event
                        .payload
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    !matches!(status, "superseded" | "archived-untrusted")
                        && event.payload.get(field) == Some(&value)
                })
                .map(|event| (field.to_string(), event.principal_id.clone()))
        })
        .collect()
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

fn message(role: &str, content: String) -> Message {
    Message {
        role: role.to_string(),
        content,
        name: None,
        tool_call_id: None,
        tool_calls: None,
    }
}

fn count_harness_tokens(value: &Value) -> Result<usize, DynError> {
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tools/roadshow_demo_001_token_count.py");
    let cache = std::env::var("MORPHZ_DEMO_UV_CACHE")
        .unwrap_or_else(|_| "/private/tmp/morphz-demo-uv-cache".to_string());
    let mut child = Command::new("uv")
        .args([
            "run",
            "--with",
            "tiktoken==0.12.0",
            "python",
            script.to_string_lossy().as_ref(),
        ])
        .env("UV_CACHE_DIR", cache)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child
        .stdin
        .take()
        .ok_or("token counter stdin unavailable")?
        .write_all(&serde_json::to_vec(value)?)?;
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(format!(
            "frozen token counter failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(String::from_utf8(output.stdout)?.trim().parse()?)
}

fn git_output(args: &[&str]) -> String {
    Command::new("git")
        .args(args)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_else(|| "unavailable".to_string())
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), DynError> {
    std::fs::write(path, serde_json::to_vec_pretty(value)?)?;
    Ok(())
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
    fn frozen_smoke_contract_is_self_consistent_without_model_calls() {
        let report = validate_frozen_smoke_contract().unwrap();
        assert_eq!(report["passed"], true);
        assert_eq!(report["fixture_events"], 43);
        assert_eq!(report["model"], MODEL);
        assert_eq!(report["real_model_called"], false);
    }
}
