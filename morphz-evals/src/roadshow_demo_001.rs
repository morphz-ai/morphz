use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

type DynError = Box<dyn std::error::Error + Send + Sync>;

const PURPOSE: &str = "roadshow_demo";
const DEMO_ID: &str = "DEMO-001";
const PROTOCOL_VERSION: &str = "candidate-v2";
const ERROR_TAXONOMY_VERSION: &str = "demo-001-errors-v1";
const FIXTURE_TEXT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/roadshow_demo_001_v2/event_stream.json"
));

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum DemoArm {
    PersistentMessages,
    SummaryJsonMemory,
    MorphzStructuredContext,
}

impl DemoArm {
    pub const ALL: [Self; 3] = [
        Self::PersistentMessages,
        Self::SummaryJsonMemory,
        Self::MorphzStructuredContext,
    ];

    pub fn slug(self) -> &'static str {
        match self {
            Self::PersistentMessages => "persistent_messages",
            Self::SummaryJsonMemory => "summary_json_memory",
            Self::MorphzStructuredContext => "morphz_structured_context",
        }
    }

    fn contract(self) -> ArmInterfaceContract {
        match self {
            Self::PersistentMessages => ArmInterfaceContract {
                implementation_status: "contract_only".to_string(),
                ingest: "append_event_to_durable_message_history".to_string(),
                maintain: "none".to_string(),
                compile_active_input: "frozen_budgeted_message_selector".to_string(),
                recover: "reopen_durable_message_history".to_string(),
                capture_usage: "business_model_calls".to_string(),
            },
            Self::SummaryJsonMemory => ArmInterfaceContract {
                implementation_status: "contract_only".to_string(),
                ingest: "append_event_to_durable_message_history".to_string(),
                maintain: "same_model_summary_json_maintenance".to_string(),
                compile_active_input: "recent_messages_plus_summary_json".to_string(),
                recover: "reload_messages_and_summary_json".to_string(),
                capture_usage: "business_and_memory_model_calls".to_string(),
            },
            Self::MorphzStructuredContext => ArmInterfaceContract {
                implementation_status: "runtime_mapping_required".to_string(),
                ingest: "append_observation_with_principal_session_thread".to_string(),
                maintain: "model_proposed_runtime_validated_context_transaction".to_string(),
                compile_active_input: "build_structured_context_projection".to_string(),
                recover: "reattach_agent_context_and_durable_store".to_string(),
                capture_usage: "business_and_context_model_calls".to_string(),
            },
        }
    }

    fn operation_for(self, event: &FixtureEvent) -> &'static str {
        match event.kind.as_str() {
            "worker_terminated" => "detach_runtime_worker",
            "worker_attached" => match self {
                Self::PersistentMessages => "reopen_durable_message_history",
                Self::SummaryJsonMemory => "reload_messages_and_summary_json",
                Self::MorphzStructuredContext => "reattach_agent_context_and_durable_store",
            },
            "final_action_request" | "user_request" => "invoke_agent_turn",
            _ => match self {
                Self::PersistentMessages | Self::SummaryJsonMemory => {
                    "append_event_to_durable_message_history"
                }
                Self::MorphzStructuredContext => "append_observation_with_principal_session_thread",
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoadshowFixture {
    pub fixture_id: String,
    pub fixture_version: String,
    pub purpose: String,
    pub events: Vec<FixtureEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FixtureEvent {
    pub sequence: u64,
    pub event_id: String,
    pub stage: String,
    pub kind: String,
    pub principal_id: String,
    pub session_id: String,
    pub thread_id: String,
    pub injection_group: Option<String>,
    pub scheduled_offset_ms: u64,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArmInterfaceContract {
    pub implementation_status: String,
    pub ingest: String,
    pub maintain: String,
    pub compile_active_input: String,
    pub recover: String,
    pub capture_usage: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactPaths {
    pub fixture: String,
    pub injection_trace: String,
    pub arm_interface_trace: String,
    pub observed_run: String,
    pub score: String,
    pub error_taxonomy: String,
    pub checksums: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnfrozenConfig {
    pub status: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub sampling: Option<Value>,
    pub budgets: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeIdentityStatus {
    pub status: String,
    pub runtime_commit: Option<String>,
    pub runner_commit: Option<String>,
    pub worktree_dirty: Option<bool>,
    pub dirty_diff_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvironmentSnapshot {
    pub os: String,
    pub architecture: String,
    pub rust_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DryRunManifest {
    pub purpose: String,
    pub demo_id: String,
    pub protocol_version: String,
    pub runner_mode: String,
    pub include_in_paper_statistics: bool,
    pub run_id: String,
    pub created_at: String,
    pub arm: DemoArm,
    pub fixture_id: String,
    pub fixture_version: String,
    pub fixture_sha256: String,
    pub event_order_sha256: String,
    pub arm_interface: ArmInterfaceContract,
    pub model_and_budget: UnfrozenConfig,
    pub code_identity: CodeIdentityStatus,
    pub environment: EnvironmentSnapshot,
    pub error_taxonomy_version: String,
    pub artifacts: ArtifactPaths,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReleaseAction {
    pub project: String,
    pub version: String,
    pub port: u16,
    pub endpoint: String,
    pub retention_days: u16,
    pub timezone: String,
    pub security_rule: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObservedAction {
    pub event_sequence: u64,
    pub tool_name: String,
    pub parameters: ReleaseAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerRecoveryObservation {
    pub replacement_attached: bool,
    pub durable_state_restored: bool,
    pub duplicate_external_actions: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelCallUsage {
    pub call_kind: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub active_context_tokens: u64,
    pub wall_clock_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObservedRun {
    pub measurement_mode: String,
    pub final_action_request_sequence: u64,
    pub actions: Vec<ObservedAction>,
    pub cross_session_current_state: Option<ReleaseAction>,
    pub field_sources: BTreeMap<String, String>,
    pub thread_terminal_counts: BTreeMap<String, usize>,
    pub worker_recovery: WorkerRecoveryObservation,
    pub current_state_claims_after_late_event: Vec<String>,
    pub model_calls: Vec<ModelCallUsage>,
    pub run_wall_clock_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DemoMetrics {
    pub status: String,
    pub total_input_tokens: u64,
    pub state_maintenance_input_tokens: u64,
    pub input_tokens_per_correct_completion: Option<f64>,
    pub final_action_active_context_tokens: Option<u64>,
    pub median_active_context_tokens: Option<u64>,
    pub peak_active_context_tokens: Option<u64>,
    pub wall_clock_seconds: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DemoScore {
    pub unique_correct_final_action: bool,
    pub action_count: usize,
    pub action_after_final_request: bool,
    pub correct_tool_name: bool,
    pub exact_parameter_match: bool,
    pub stale_state_reused: bool,
    pub cross_session_continuity_pass: bool,
    pub principal_attribution_pass: bool,
    pub thread_routing_pass: bool,
    pub restart_recovery_pass: bool,
    pub metrics: DemoMetrics,
    pub passed: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FailureSignal {
    Provider5xxOrConnection,
    ModelEmptyOrInvalidToolArguments,
    BudgetExceeded,
    RuntimeRecoveryFailed,
    HarnessOrScorerArtifactFailure,
    LivePresentationNetworkFailure,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorClass {
    ServiceFailure,
    ModelOutcome,
    BudgetOutcome,
    SystemOutcome,
    HarnessFailure,
    LivePresentationFailure,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ErrorDisposition {
    pub signal: FailureSignal,
    pub class: ErrorClass,
    pub count_in_arm_result: bool,
    pub retry_same_run: bool,
    pub replacement_run_allowed: bool,
    pub presentation_fallback_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InterfaceTraceEntry {
    pub sequence: u64,
    pub event_id: String,
    pub arm: DemoArm,
    pub operation: String,
    pub principal_id: String,
    pub session_id: String,
    pub thread_id: String,
    pub accepted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DryRunInspection {
    pub run_root: PathBuf,
    pub manifest_identity_pass: bool,
    pub artifact_set_pass: bool,
    pub checksum_pass: bool,
    pub fixture_injection_pass: bool,
    pub hidden_scorer_pass: bool,
    pub errors: Vec<String>,
    pub passed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScorerContractCase {
    pub case_id: String,
    pub expected_pass: bool,
    pub expected_stale: bool,
    pub actual_pass: bool,
    pub actual_stale: bool,
    pub contract_pass: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DryRunSuiteReport {
    pub suite_id: String,
    pub purpose: String,
    pub demo_id: String,
    pub protocol_version: String,
    pub runner_mode: String,
    pub created_at: String,
    pub demo_root: PathBuf,
    pub suite_root: PathBuf,
    pub fixture_validation_pass: bool,
    pub scorer_contract_pass: bool,
    pub error_taxonomy_pass: bool,
    pub run_inspections: Vec<DryRunInspection>,
    pub scorer_cases: Vec<ScorerContractCase>,
    pub arm_implementation_status: BTreeMap<String, String>,
    pub ready_for_model_smoke: bool,
    pub blocking_reasons: Vec<String>,
    pub passed: bool,
}

pub fn run_no_model_dry_run(base_dir: Option<&Path>) -> Result<DryRunSuiteReport, DynError> {
    let fixture: RoadshowFixture = serde_json::from_str(FIXTURE_TEXT)?;
    validate_fixture(&fixture)?;

    let base = base_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("morphz-roadshow-dry-runs"));
    std::fs::create_dir_all(&base)?;
    let base = std::fs::canonicalize(base)?;
    let demo_root = base.join(DEMO_ID);
    std::fs::create_dir_all(&demo_root)?;
    let timestamp = Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
    let suite_id = format!("DEMO-001-dry-run-{timestamp}-{}", std::process::id());
    let suite_root = demo_root.join("_dry_runs").join(&suite_id);
    std::fs::create_dir_all(&suite_root)?;
    set_private_directory_permissions(&suite_root)?;

    let mut run_inspections = Vec::new();
    let mut arm_implementation_status = BTreeMap::new();
    for arm in DemoArm::ALL {
        let run_id = format!(
            "DEMO-001-{}-no-model-{}-1",
            arm.slug(),
            Utc::now().format("%Y%m%dT%H%M%S%.3fZ")
        );
        let run_root = demo_root.join(&run_id);
        create_dry_run(&run_root, &run_id, arm, &fixture)?;
        run_inspections.push(inspect_dry_run(&run_root)?);
        arm_implementation_status
            .insert(arm.slug().to_string(), arm.contract().implementation_status);
    }

    let scorer_cases = scorer_contract_cases();
    let scorer_contract_pass = scorer_cases.iter().all(|case| case.contract_pass);
    let dispositions = error_contract_cases();
    let error_taxonomy_pass = dispositions.iter().all(valid_disposition);
    write_json(&suite_root.join("scorer_contract.json"), &scorer_cases)?;
    write_json(
        &suite_root.join("error_taxonomy_contract.json"),
        &dispositions,
    )?;

    let blocking_reasons = vec![
        "persistent_messages adapter is contract-only; no model-call implementation is wired"
            .to_string(),
        "summary_json_memory adapter, maintenance trigger, schema and usage accounting are not implemented"
            .to_string(),
        "morphz_structured_context still needs an explicit DEMO-001 Runtime mapping and observation capture adapter"
            .to_string(),
        "full long-history fixture, message selector, summary policy, exact model and common budgets remain unfrozen"
            .to_string(),
    ];
    let fixture_validation_pass = validate_fixture(&fixture).is_ok();
    let all_runs_pass = run_inspections.iter().all(|report| report.passed);
    let ready_for_model_smoke = blocking_reasons.is_empty();
    let passed =
        fixture_validation_pass && scorer_contract_pass && error_taxonomy_pass && all_runs_pass;
    let report = DryRunSuiteReport {
        suite_id,
        purpose: PURPOSE.to_string(),
        demo_id: DEMO_ID.to_string(),
        protocol_version: PROTOCOL_VERSION.to_string(),
        runner_mode: "no_model_dry_run".to_string(),
        created_at: Utc::now().to_rfc3339(),
        demo_root,
        suite_root: suite_root.clone(),
        fixture_validation_pass,
        scorer_contract_pass,
        error_taxonomy_pass,
        run_inspections,
        scorer_cases,
        arm_implementation_status,
        ready_for_model_smoke,
        blocking_reasons,
        passed,
    };
    write_json(&suite_root.join("summary.json"), &report)?;
    write_checksums(&suite_root)?;
    Ok(report)
}

fn create_dry_run(
    run_root: &Path,
    run_id: &str,
    arm: DemoArm,
    fixture: &RoadshowFixture,
) -> Result<(), DynError> {
    std::fs::create_dir_all(run_root.join("inputs"))?;
    std::fs::create_dir_all(run_root.join("traces"))?;
    std::fs::create_dir_all(run_root.join("outputs"))?;
    std::fs::create_dir_all(run_root.join("scores"))?;
    std::fs::create_dir_all(run_root.join("errors"))?;
    set_private_directory_permissions(run_root)?;

    let fixture_path = run_root.join("inputs/event_stream.json");
    std::fs::write(&fixture_path, FIXTURE_TEXT.as_bytes())?;
    write_jsonl(
        &run_root.join("traces/injections.jsonl"),
        fixture.events.iter(),
    )?;
    let interface_trace = fixture
        .events
        .iter()
        .map(|event| InterfaceTraceEntry {
            sequence: event.sequence,
            event_id: event.event_id.clone(),
            arm,
            operation: arm.operation_for(event).to_string(),
            principal_id: event.principal_id.clone(),
            session_id: event.session_id.clone(),
            thread_id: event.thread_id.clone(),
            accepted: true,
        })
        .collect::<Vec<_>>();
    write_jsonl(
        &run_root.join("traces/arm_interface.jsonl"),
        interface_trace.iter(),
    )?;

    // This deterministic observation validates the runner/scorer contract only.
    // It is not produced by a model and must never be reported as an Arm result.
    let observed = synthetic_correct_observed_run();
    write_json(&run_root.join("outputs/observed_run.json"), &observed)?;
    let score = score_observed_run(&observed);
    write_json(&run_root.join("scores/score.json"), &score)?;
    write_json(
        &run_root.join("errors/error_taxonomy.json"),
        &error_contract_cases(),
    )?;

    let manifest = DryRunManifest {
        purpose: PURPOSE.to_string(),
        demo_id: DEMO_ID.to_string(),
        protocol_version: PROTOCOL_VERSION.to_string(),
        runner_mode: "no_model_dry_run".to_string(),
        include_in_paper_statistics: false,
        run_id: run_id.to_string(),
        created_at: Utc::now().to_rfc3339(),
        arm,
        fixture_id: fixture.fixture_id.clone(),
        fixture_version: fixture.fixture_version.clone(),
        fixture_sha256: sha256(FIXTURE_TEXT.as_bytes()),
        event_order_sha256: event_order_sha256(fixture),
        arm_interface: arm.contract(),
        model_and_budget: UnfrozenConfig {
            status: "intentionally_unfrozen".to_string(),
            provider: None,
            model: None,
            sampling: None,
            budgets: None,
        },
        code_identity: CodeIdentityStatus {
            status: "capture_required_before_smoke".to_string(),
            runtime_commit: None,
            runner_commit: None,
            worktree_dirty: None,
            dirty_diff_sha256: None,
        },
        environment: EnvironmentSnapshot {
            os: std::env::consts::OS.to_string(),
            architecture: std::env::consts::ARCH.to_string(),
            rust_version: None,
        },
        error_taxonomy_version: ERROR_TAXONOMY_VERSION.to_string(),
        artifacts: ArtifactPaths {
            fixture: "inputs/event_stream.json".to_string(),
            injection_trace: "traces/injections.jsonl".to_string(),
            arm_interface_trace: "traces/arm_interface.jsonl".to_string(),
            observed_run: "outputs/observed_run.json".to_string(),
            score: "scores/score.json".to_string(),
            error_taxonomy: "errors/error_taxonomy.json".to_string(),
            checksums: "checksums.json".to_string(),
        },
    };
    write_json(&run_root.join("manifest.json"), &manifest)?;
    write_checksums(run_root)?;
    Ok(())
}

pub fn inspect_dry_run(run_root: &Path) -> Result<DryRunInspection, DynError> {
    let run_root = std::fs::canonicalize(run_root)?;
    let manifest: DryRunManifest =
        serde_json::from_slice(&std::fs::read(run_root.join("manifest.json"))?)?;
    let mut errors = Vec::new();
    let manifest_identity_pass = manifest.purpose == PURPOSE
        && manifest.demo_id == DEMO_ID
        && manifest.protocol_version == PROTOCOL_VERSION
        && manifest.runner_mode == "no_model_dry_run"
        && !manifest.include_in_paper_statistics
        && manifest.model_and_budget.status == "intentionally_unfrozen"
        && manifest.model_and_budget.provider.is_none()
        && manifest.model_and_budget.model.is_none()
        && manifest.model_and_budget.budgets.is_none()
        && manifest.code_identity.status == "capture_required_before_smoke";
    if !manifest_identity_pass {
        errors.push("manifest identity or no-model boundary is invalid".to_string());
    }

    let required = [
        &manifest.artifacts.fixture,
        &manifest.artifacts.injection_trace,
        &manifest.artifacts.arm_interface_trace,
        &manifest.artifacts.observed_run,
        &manifest.artifacts.score,
        &manifest.artifacts.error_taxonomy,
        &manifest.artifacts.checksums,
    ];
    let artifact_set_pass = required.iter().all(|path| run_root.join(path).is_file());
    if !artifact_set_pass {
        errors.push("required artifact set is incomplete".to_string());
    }

    let fixture: RoadshowFixture =
        serde_json::from_slice(&std::fs::read(run_root.join(&manifest.artifacts.fixture))?)?;
    let fixture_injection_pass = validate_fixture(&fixture).is_ok()
        && manifest.fixture_sha256 == sha256(FIXTURE_TEXT.as_bytes())
        && manifest.event_order_sha256 == event_order_sha256(&fixture)
        && jsonl_line_count(&run_root.join(&manifest.artifacts.injection_trace))?
            == fixture.events.len()
        && jsonl_line_count(&run_root.join(&manifest.artifacts.arm_interface_trace))?
            == fixture.events.len();
    if !fixture_injection_pass {
        errors.push("fixture, event order or injection trace is invalid".to_string());
    }

    let observed: ObservedRun = serde_json::from_slice(&std::fs::read(
        run_root.join(&manifest.artifacts.observed_run),
    )?)?;
    let stored_score: DemoScore =
        serde_json::from_slice(&std::fs::read(run_root.join(&manifest.artifacts.score))?)?;
    let rescored = score_observed_run(&observed);
    let hidden_scorer_pass = stored_score == rescored;
    if !hidden_scorer_pass {
        errors.push("stored score does not match deterministic re-score".to_string());
    }

    let checksum_pass = verify_checksums(&run_root)?;
    if !checksum_pass {
        errors.push("artifact checksum verification failed".to_string());
    }
    let passed = manifest_identity_pass
        && artifact_set_pass
        && checksum_pass
        && fixture_injection_pass
        && hidden_scorer_pass;
    Ok(DryRunInspection {
        run_root,
        manifest_identity_pass,
        artifact_set_pass,
        checksum_pass,
        fixture_injection_pass,
        hidden_scorer_pass,
        errors,
        passed,
    })
}

pub fn score_observed_run(observed: &ObservedRun) -> DemoScore {
    let expected = expected_action();
    let action_count = observed.actions.len();
    let action_after_final_request = observed
        .actions
        .first()
        .is_some_and(|action| action.event_sequence > observed.final_action_request_sequence);
    let correct_tool_name = observed
        .actions
        .first()
        .is_some_and(|action| action.tool_name == "commit_release");
    let exact_parameter_match = observed
        .actions
        .first()
        .is_some_and(|action| action.parameters == expected);
    let unique_correct_final_action = action_count == 1
        && action_after_final_request
        && correct_tool_name
        && exact_parameter_match;
    let stale_state_reused = observed
        .actions
        .iter()
        .any(|action| is_stale_action(&action.parameters))
        || observed
            .current_state_claims_after_late_event
            .iter()
            .any(|claim| is_stale_claim(claim));
    let cross_session_continuity_pass =
        observed.cross_session_current_state.as_ref() == Some(&expected);
    let principal_attribution_pass = [
        ("version", "principal-release-owner"),
        ("port", "principal-release-owner"),
        ("endpoint", "principal-release-owner"),
        ("retention_days", "principal-compliance-owner"),
        ("timezone", "principal-compliance-owner"),
        ("security_rule", "principal-compliance-owner"),
    ]
    .iter()
    .all(|(field, source)| {
        observed
            .field_sources
            .get(*field)
            .is_some_and(|actual| actual == source)
    });
    let thread_routing_pass = observed.thread_terminal_counts.get("release") == Some(&1)
        && observed.thread_terminal_counts.get("compliance") == Some(&1);
    let restart_recovery_pass = observed.worker_recovery.replacement_attached
        && observed.worker_recovery.durable_state_restored
        && observed.worker_recovery.duplicate_external_actions == 0;
    let metrics = summarize_metrics(observed, unique_correct_final_action);
    let passed = unique_correct_final_action
        && !stale_state_reused
        && cross_session_continuity_pass
        && principal_attribution_pass
        && thread_routing_pass
        && restart_recovery_pass;
    DemoScore {
        unique_correct_final_action,
        action_count,
        action_after_final_request,
        correct_tool_name,
        exact_parameter_match,
        stale_state_reused,
        cross_session_continuity_pass,
        principal_attribution_pass,
        thread_routing_pass,
        restart_recovery_pass,
        metrics,
        passed,
    }
}

pub fn classify_failure(signal: FailureSignal) -> ErrorDisposition {
    match signal {
        FailureSignal::Provider5xxOrConnection => ErrorDisposition {
            signal,
            class: ErrorClass::ServiceFailure,
            count_in_arm_result: false,
            retry_same_run: false,
            replacement_run_allowed: true,
            presentation_fallback_only: false,
        },
        FailureSignal::ModelEmptyOrInvalidToolArguments => ErrorDisposition {
            signal,
            class: ErrorClass::ModelOutcome,
            count_in_arm_result: true,
            retry_same_run: false,
            replacement_run_allowed: false,
            presentation_fallback_only: false,
        },
        FailureSignal::BudgetExceeded => ErrorDisposition {
            signal,
            class: ErrorClass::BudgetOutcome,
            count_in_arm_result: true,
            retry_same_run: false,
            replacement_run_allowed: false,
            presentation_fallback_only: false,
        },
        FailureSignal::RuntimeRecoveryFailed => ErrorDisposition {
            signal,
            class: ErrorClass::SystemOutcome,
            count_in_arm_result: true,
            retry_same_run: false,
            replacement_run_allowed: false,
            presentation_fallback_only: false,
        },
        FailureSignal::HarnessOrScorerArtifactFailure => ErrorDisposition {
            signal,
            class: ErrorClass::HarnessFailure,
            count_in_arm_result: false,
            retry_same_run: false,
            replacement_run_allowed: true,
            presentation_fallback_only: false,
        },
        FailureSignal::LivePresentationNetworkFailure => ErrorDisposition {
            signal,
            class: ErrorClass::LivePresentationFailure,
            count_in_arm_result: false,
            retry_same_run: false,
            replacement_run_allowed: false,
            presentation_fallback_only: true,
        },
    }
}

fn validate_fixture(fixture: &RoadshowFixture) -> Result<(), DynError> {
    if fixture.purpose != PURPOSE {
        return Err(format!("fixture purpose must be {PURPOSE}").into());
    }
    if fixture.events.is_empty() {
        return Err("fixture must contain events".into());
    }
    let mut ids = BTreeSet::new();
    let mut previous = 0;
    for event in &fixture.events {
        if event.sequence <= previous {
            return Err("fixture event sequence must be strictly increasing".into());
        }
        if !ids.insert(event.event_id.as_str()) {
            return Err(format!("duplicate fixture event id: {}", event.event_id).into());
        }
        if event.principal_id.is_empty()
            || event.session_id.is_empty()
            || event.thread_id.is_empty()
        {
            return Err(format!("event {} is missing routing identity", event.event_id).into());
        }
        previous = event.sequence;
    }

    let concurrent = fixture
        .events
        .iter()
        .filter(|event| event.injection_group.as_deref() == Some("stage-1-concurrent"))
        .collect::<Vec<_>>();
    if concurrent.len() != 2
        || concurrent[0].scheduled_offset_ms != concurrent[1].scheduled_offset_ms
        || concurrent[0].principal_id == concurrent[1].principal_id
        || concurrent[0].session_id == concurrent[1].session_id
        || concurrent[0].thread_id == concurrent[1].thread_id
    {
        return Err("stage-1 concurrent injection contract is invalid".into());
    }
    let terminated = fixture
        .events
        .iter()
        .position(|event| event.kind == "worker_terminated")
        .ok_or("missing worker_terminated event")?;
    let attached = fixture
        .events
        .iter()
        .position(|event| event.kind == "worker_attached")
        .ok_or("missing worker_attached event")?;
    let late = fixture
        .events
        .iter()
        .position(|event| event.stage == "stage_4_late_conflict")
        .ok_or("missing late conflict event")?;
    if !(terminated < attached && attached < late) {
        return Err("worker replacement must complete before the late conflict event".into());
    }
    if fixture
        .events
        .iter()
        .filter(|event| event.kind == "final_action_request")
        .count()
        != 1
    {
        return Err("fixture must contain exactly one final action request".into());
    }
    Ok(())
}

fn synthetic_correct_observed_run() -> ObservedRun {
    ObservedRun {
        measurement_mode: "no_model_dry_run".to_string(),
        final_action_request_sequence: 10,
        actions: vec![ObservedAction {
            event_sequence: 11,
            tool_name: "commit_release".to_string(),
            parameters: expected_action(),
        }],
        cross_session_current_state: Some(expected_action()),
        field_sources: BTreeMap::from([
            ("version".to_string(), "principal-release-owner".to_string()),
            ("port".to_string(), "principal-release-owner".to_string()),
            (
                "endpoint".to_string(),
                "principal-release-owner".to_string(),
            ),
            (
                "retention_days".to_string(),
                "principal-compliance-owner".to_string(),
            ),
            (
                "timezone".to_string(),
                "principal-compliance-owner".to_string(),
            ),
            (
                "security_rule".to_string(),
                "principal-compliance-owner".to_string(),
            ),
        ]),
        thread_terminal_counts: BTreeMap::from([
            ("release".to_string(), 1),
            ("compliance".to_string(), 1),
        ]),
        worker_recovery: WorkerRecoveryObservation {
            replacement_attached: true,
            durable_state_restored: true,
            duplicate_external_actions: 0,
        },
        current_state_claims_after_late_event: vec![
            "v3".to_string(),
            "9443".to_string(),
            "/v3/events".to_string(),
            "45".to_string(),
            "Asia/Shanghai".to_string(),
        ],
        model_calls: Vec::new(),
        run_wall_clock_ms: 0,
    }
}

fn summarize_metrics(observed: &ObservedRun, correct: bool) -> DemoMetrics {
    let total_input_tokens = observed
        .model_calls
        .iter()
        .map(|call| call.input_tokens)
        .sum::<u64>();
    let state_maintenance_input_tokens = observed
        .model_calls
        .iter()
        .filter(|call| call.call_kind == "state_maintenance")
        .map(|call| call.input_tokens)
        .sum::<u64>();
    let mut active = observed
        .model_calls
        .iter()
        .map(|call| call.active_context_tokens)
        .collect::<Vec<_>>();
    active.sort_unstable();
    let median_active_context_tokens = if active.is_empty() {
        None
    } else {
        Some(active[(active.len() - 1) / 2])
    };
    let peak_active_context_tokens = active.last().copied();
    let final_action_active_context_tokens = observed
        .model_calls
        .iter()
        .rev()
        .find(|call| call.call_kind == "final_action")
        .map(|call| call.active_context_tokens);
    DemoMetrics {
        status: match observed.measurement_mode.as_str() {
            "no_model_dry_run" => "not_applicable_no_model_dry_run".to_string(),
            "deterministic_fake_client" => "deterministic_fake_not_reportable".to_string(),
            _ => "measured".to_string(),
        },
        total_input_tokens,
        state_maintenance_input_tokens,
        input_tokens_per_correct_completion: if correct && !observed.model_calls.is_empty() {
            Some(total_input_tokens as f64)
        } else {
            None
        },
        final_action_active_context_tokens,
        median_active_context_tokens,
        peak_active_context_tokens,
        wall_clock_seconds: observed.run_wall_clock_ms as f64 / 1000.0,
    }
}

fn scorer_contract_cases() -> Vec<ScorerContractCase> {
    let correct = synthetic_correct_observed_run();
    let mut stale = correct.clone();
    stale.actions = vec![ObservedAction {
        event_sequence: 11,
        tool_name: "commit_release".to_string(),
        parameters: ReleaseAction {
            project: "ORBIT-42".to_string(),
            version: "v1".to_string(),
            port: 8080,
            endpoint: "/v1/events".to_string(),
            retention_days: 30,
            timezone: "UTC".to_string(),
            security_rule: "NEVER-LOG-SECRETS".to_string(),
        },
    }];
    stale.current_state_claims_after_late_event = vec!["version=v1 current".to_string()];
    let mut duplicate = correct.clone();
    duplicate.actions.push(ObservedAction {
        event_sequence: 12,
        tool_name: "commit_release".to_string(),
        parameters: expected_action(),
    });
    let mut missing = correct.clone();
    missing.actions.clear();
    let mut early = correct.clone();
    early.actions[0].event_sequence = 9;
    let mut wrong_tool = correct.clone();
    wrong_tool.actions[0].tool_name = "check_release_config".to_string();

    [
        ("correct-single-action", correct, true, false),
        ("stale-v1-action", stale, false, true),
        ("duplicate-action", duplicate, false, false),
        ("missing-action", missing, false, false),
        ("action-before-final-request", early, false, false),
        ("wrong-tool-name", wrong_tool, false, false),
    ]
    .into_iter()
    .map(|(case_id, observed, expected_pass, expected_stale)| {
        let score = score_observed_run(&observed);
        ScorerContractCase {
            case_id: case_id.to_string(),
            expected_pass,
            expected_stale,
            actual_pass: score.passed,
            actual_stale: score.stale_state_reused,
            contract_pass: score.passed == expected_pass
                && score.stale_state_reused == expected_stale,
        }
    })
    .collect()
}

fn error_contract_cases() -> Vec<ErrorDisposition> {
    [
        FailureSignal::Provider5xxOrConnection,
        FailureSignal::ModelEmptyOrInvalidToolArguments,
        FailureSignal::BudgetExceeded,
        FailureSignal::RuntimeRecoveryFailed,
        FailureSignal::HarnessOrScorerArtifactFailure,
        FailureSignal::LivePresentationNetworkFailure,
    ]
    .into_iter()
    .map(classify_failure)
    .collect()
}

fn valid_disposition(disposition: &ErrorDisposition) -> bool {
    !disposition.retry_same_run
        && match disposition.class {
            ErrorClass::ServiceFailure | ErrorClass::HarnessFailure => {
                !disposition.count_in_arm_result && disposition.replacement_run_allowed
            }
            ErrorClass::ModelOutcome | ErrorClass::BudgetOutcome | ErrorClass::SystemOutcome => {
                disposition.count_in_arm_result && !disposition.replacement_run_allowed
            }
            ErrorClass::LivePresentationFailure => {
                !disposition.count_in_arm_result
                    && !disposition.replacement_run_allowed
                    && disposition.presentation_fallback_only
            }
        }
}

fn expected_action() -> ReleaseAction {
    ReleaseAction {
        project: "ORBIT-42".to_string(),
        version: "v3".to_string(),
        port: 9443,
        endpoint: "/v3/events".to_string(),
        retention_days: 45,
        timezone: "Asia/Shanghai".to_string(),
        security_rule: "NEVER-LOG-SECRETS".to_string(),
    }
}

fn is_stale_action(action: &ReleaseAction) -> bool {
    matches!(action.version.as_str(), "v1" | "v2")
        || matches!(action.port, 8080 | 9090)
        || matches!(action.endpoint.as_str(), "/v1/events" | "/v2/events")
        || action.retention_days == 30
        || action.timezone == "UTC"
}

fn is_stale_claim(claim: &str) -> bool {
    let normalized = claim.to_ascii_lowercase();
    [
        "version=v1",
        "version=v2",
        "v1 current",
        "v2 current",
        "port=8080",
        "port=9090",
        "/v1/events current",
        "/v2/events current",
        "retention_days=30",
        "timezone=utc",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
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

fn write_jsonl<'a, T: Serialize + 'a>(
    path: &Path,
    values: impl IntoIterator<Item = &'a T>,
) -> Result<(), DynError> {
    let mut output = Vec::new();
    for value in values {
        serde_json::to_writer(&mut output, value)?;
        output.push(b'\n');
    }
    std::fs::write(path, output)?;
    Ok(())
}

fn jsonl_line_count(path: &Path) -> Result<usize, DynError> {
    let text = std::fs::read_to_string(path)?;
    for line in text.lines() {
        let _: Value = serde_json::from_str(line)?;
    }
    Ok(text.lines().count())
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

fn verify_checksums(root: &Path) -> Result<bool, DynError> {
    let expected: BTreeMap<String, String> =
        serde_json::from_slice(&std::fs::read(root.join("checksums.json"))?)?;
    for (relative, hash) in expected {
        let path = root.join(relative);
        if !path.is_file() || sha256(&std::fs::read(path)?) != hash {
            return Ok(false);
        }
    }
    Ok(true)
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<(), DynError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> Result<(), DynError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_has_valid_concurrent_and_recovery_order() {
        let fixture: RoadshowFixture = serde_json::from_str(FIXTURE_TEXT).unwrap();
        validate_fixture(&fixture).unwrap();
    }

    #[test]
    fn hidden_scorer_rejects_stale_duplicate_and_missing_actions() {
        let cases = scorer_contract_cases();
        assert_eq!(cases.len(), 6);
        assert!(cases.iter().all(|case| case.contract_pass));
    }

    #[test]
    fn error_taxonomy_matches_protocol_dispositions() {
        assert!(error_contract_cases().iter().all(valid_disposition));
    }

    #[test]
    fn no_model_dry_run_closes_artifact_contract_without_claiming_smoke_ready() {
        let temp = tempfile::tempdir().unwrap();
        let report = run_no_model_dry_run(Some(temp.path())).unwrap();
        assert!(report.passed);
        assert_eq!(report.run_inspections.len(), 3);
        assert!(report.run_inspections.iter().all(|run| run.passed));
        assert!(!report.ready_for_model_smoke);
        assert!(!report.blocking_reasons.is_empty());
    }

    #[test]
    fn checksum_inspection_rejects_tampered_artifact() {
        let temp = tempfile::tempdir().unwrap();
        let report = run_no_model_dry_run(Some(temp.path())).unwrap();
        let run_root = &report.run_inspections[0].run_root;
        let observed = run_root.join("outputs/observed_run.json");
        let mut bytes = std::fs::read(&observed).unwrap();
        bytes.push(b'\n');
        std::fs::write(&observed, bytes).unwrap();
        let inspection = inspect_dry_run(run_root).unwrap();
        assert!(!inspection.checksum_pass);
        assert!(!inspection.passed);
    }
}
