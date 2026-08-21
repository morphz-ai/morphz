use crate::coding_frame_eval::{inspect_coding_discipline, CodingDisciplineReport};
use crate::context_metacognition_eval::ModelProfileIdentity;
use crate::eval_sandbox::{
    create_coding_eval_v2, create_coding_eval_v3, exec_output_failed_tests, score_coding_eval,
    verify_coding_eval, CodingEvalEnvironment, CodingEvalScore, CodingEvalVerification,
};
use chrono::Utc;
use morphz::harness_package::{HarnessPackage, HARNESS_BINDING_TOPIC, HARNESS_PACKAGE_TOPIC};
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{
    EventStore, ExecutionJobFilter, ExecutionJobStore, PlanExecutionFilter, PlanExecutionStatus,
    PlanExecutionStore, QueryFilter,
};
use morphz::orchestrator::orchestrator::{
    SEMANTIC_SEXPR_VM_SYSTEM_PROMPT_MODE, SYSTEM_PROMPT_MODE_ENV,
};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::process::Command;

type DynError = Box<dyn std::error::Error + Send + Sync>;

pub const CODING_HARNESS_ID: &str = "coding";
pub const CODING_HARNESS_VERSION: &str = "1.0.0";
pub const CODING_HARNESS_SOURCE: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/harnesses/coding.hns"));
pub const PROCEDURE_PROBE_HARNESS_ID: &str = "coding-procedure-probe";
pub const PROCEDURE_PROBE_HARNESS_VERSION: &str = "1.0.0";
pub const PROCEDURE_PROBE_HARNESS_SOURCE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/harnesses/coding-procedure-probe.hns"
));
pub const RUNTIME_EVAL_HARNESS_ID: &str = "coding-runtime-eval";
pub const RUNTIME_EVAL_HARNESS_VERSION: &str = "1.0.0";
pub const RUNTIME_EVAL_HARNESS_SOURCE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/harnesses/coding-runtime-eval.hns"
));

const CODING_HARNESS_SCENARIO: &str = "coding_harness_ab_v1";
const RETRY_STATE_MACHINE_PROMPT: &str = "修复当前 Rust crate 的任务队列重试状态机：临时失败任务的退避时间与最大尝试次数不正确，已经取消的任务还可能被迟到的失败结果重新入队。只允许修改 src/retry.rs、src/store.rs、src/worker.rs；不得修改或删除测试、Cargo.toml、公共 API 或其他文件；不得增加依赖、访问网络或使用 unsafe。完成后简要说明实际修改和验证结果。";
const CACHE_COHERENCE_PROMPT: &str = "修复当前 Rust crate 的多租户策略缓存一致性缺陷：已接受的更新或删除不能继续返回旧值，同时失败的条件写入不能破坏仍然有效的热缓存。只允许修改 src/cache.rs、src/service.rs、src/store.rs；不得修改或删除测试、Cargo.toml、公共 API 或其他文件；不得增加依赖、访问网络或使用 unsafe。完成后简要说明实际修改和验证结果。";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CodingHarnessArm {
    Baseline,
    Harness,
}

impl CodingHarnessArm {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Baseline => "baseline",
            Self::Harness => "harness",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CodingHarnessScenario {
    RetryStateMachine,
    CacheCoherence,
    ProcedureAdherence,
    RuntimeEval,
}

impl CodingHarnessScenario {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RetryStateMachine => "retry-state-machine",
            Self::CacheCoherence => "cache-coherence",
            Self::ProcedureAdherence => "procedure-adherence",
            Self::RuntimeEval => "runtime-eval",
        }
    }

    fn neutral_prompt(self) -> &'static str {
        match self {
            Self::RetryStateMachine => RETRY_STATE_MACHINE_PROMPT,
            Self::CacheCoherence | Self::ProcedureAdherence | Self::RuntimeEval => {
                CACHE_COHERENCE_PROMPT
            }
        }
    }

    fn harness_candidate(self) -> HarnessCandidate {
        match self {
            Self::RetryStateMachine | Self::CacheCoherence => HarnessCandidate {
                id: CODING_HARNESS_ID,
                version: CODING_HARNESS_VERSION,
                filename: "coding.hns",
                source: CODING_HARNESS_SOURCE,
            },
            Self::ProcedureAdherence => HarnessCandidate {
                id: PROCEDURE_PROBE_HARNESS_ID,
                version: PROCEDURE_PROBE_HARNESS_VERSION,
                filename: "coding-procedure-probe.hns",
                source: PROCEDURE_PROBE_HARNESS_SOURCE,
            },
            Self::RuntimeEval => HarnessCandidate {
                id: RUNTIME_EVAL_HARNESS_ID,
                version: RUNTIME_EVAL_HARNESS_VERSION,
                filename: "coding-runtime-eval.hns",
                source: RUNTIME_EVAL_HARNESS_SOURCE,
            },
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct HarnessCandidate {
    id: &'static str,
    version: &'static str,
    filename: &'static str,
    source: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodingHarnessEvidence {
    pub package_registered: bool,
    pub objective_bound: bool,
    pub harness_id: Option<String>,
    pub harness_version: Option<String>,
    pub artifact_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProcedureAdherenceEvidence {
    pub score: u32,
    pub max_score: u32,
    pub baseline_failure_sequence: Option<u64>,
    pub marker_read_sequences: Vec<u64>,
    pub probe_exec_sequences: Vec<u64>,
    pub first_change_sequence: Option<u64>,
    pub marker_read_exactly_once: bool,
    pub probe_exec_exactly_once: bool,
    pub strict_order_satisfied: bool,
}

/// Evidence that a Runtime-owned mixed plan, rather than an unconstrained
/// model loop, controlled the physical workflow.
#[derive(Debug, Clone, Serialize)]
pub struct RuntimeEvalEvidence {
    pub plan_statuses: Vec<String>,
    pub physical_effect_order: Vec<String>,
    pub infer_request_count: usize,
    pub infer_result_count: usize,
    pub infer_tool_call_count: usize,
    pub infer_is_pure: bool,
    pub infer_returns_json: bool,
    pub strict_control_flow_satisfied: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodingHarnessEvalRun {
    pub arm: CodingHarnessArm,
    pub scenario: CodingHarnessScenario,
    pub run_root: PathBuf,
    pub agent_binary: PathBuf,
    pub duration_seconds: f64,
    pub exit_code: Option<i32>,
    pub model_profile: ModelProfileIdentity,
    pub objective_id: String,
    pub verification: CodingEvalVerification,
    pub event_score: CodingEvalScore,
    pub discipline: CodingDisciplineReport,
    pub harness: CodingHarnessEvidence,
    pub procedure_adherence: Option<ProcedureAdherenceEvidence>,
    pub runtime_eval: Option<RuntimeEvalEvidence>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodingHarnessDelta {
    pub event_score: i32,
    pub discipline_score: i32,
    pub assistant_attempts: i32,
    pub work_attempts: i32,
    pub context_attempts: i32,
    pub physical_tool_calls: i32,
    pub duplicate_physical_tool_calls: i32,
    pub procedure_adherence_score: Option<i32>,
    pub duration_seconds: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodingHarnessEvalSuite {
    pub id: String,
    pub scenario: CodingHarnessScenario,
    pub created_at: String,
    pub suite_root: PathBuf,
    pub model_profile: ModelProfileIdentity,
    pub baseline: CodingHarnessEvalRun,
    pub harness: CodingHarnessEvalRun,
    pub delta: CodingHarnessDelta,
    pub interpretation: String,
}

pub fn coding_harness_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("harnesses")
        .join("coding.hns")
}

pub fn procedure_probe_harness_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("harnesses")
        .join("coding-procedure-probe.hns")
}

pub fn runtime_eval_harness_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("harnesses")
        .join("coding-runtime-eval.hns")
}

fn harness_path(scenario: CodingHarnessScenario) -> PathBuf {
    match scenario {
        CodingHarnessScenario::ProcedureAdherence => procedure_probe_harness_path(),
        CodingHarnessScenario::RuntimeEval => runtime_eval_harness_path(),
        CodingHarnessScenario::RetryStateMachine | CodingHarnessScenario::CacheCoherence => {
            coding_harness_path()
        }
    }
}

pub fn create_coding_harness_eval_environment(
    base_dir: Option<&Path>,
    arm: CodingHarnessArm,
    scenario: CodingHarnessScenario,
) -> Result<CodingEvalEnvironment, DynError> {
    let candidate = scenario.harness_candidate();
    let package = HarnessPackage::from_source(candidate.filename, candidate.source)?;
    if package.manifest.id != candidate.id || package.manifest.version != candidate.version {
        return Err("内置 Coding Harness identity 与评测常量不一致".into());
    }
    let mut environment = match scenario {
        CodingHarnessScenario::RetryStateMachine => create_coding_eval_v2(base_dir)?,
        CodingHarnessScenario::CacheCoherence
        | CodingHarnessScenario::ProcedureAdherence
        | CodingHarnessScenario::RuntimeEval => create_coding_eval_v3(base_dir)?,
    };
    environment.manifest.benchmark = format!(
        "{CODING_HARNESS_SCENARIO}-{}-{}",
        scenario.as_str(),
        arm.as_str()
    );
    environment.manifest.user_prompt = scenario.neutral_prompt().to_string();
    std::fs::write(
        &environment.manifest_path,
        serde_json::to_vec_pretty(&environment.manifest)?,
    )?;
    Ok(environment)
}

pub async fn run_coding_harness_eval(
    base_dir: Option<&Path>,
    arm: CodingHarnessArm,
    scenario: CodingHarnessScenario,
    agent_binary: &Path,
    profile: &ModelProfileIdentity,
) -> Result<CodingHarnessEvalRun, DynError> {
    let mut environment = create_coding_harness_eval_environment(base_dir, arm, scenario)?;
    environment.environment.insert(
        SYSTEM_PROMPT_MODE_ENV.to_string(),
        SEMANTIC_SEXPR_VM_SYSTEM_PROMPT_MODE.to_string(),
    );
    if scenario == CodingHarnessScenario::RuntimeEval {
        environment.environment.insert(
            "MORPHZ_EVAL_CALLABLE_TOOLS".to_string(),
            "read,edit,exec".to_string(),
        );
    }
    let objective_id = format!("objective-{}", environment.manifest.id);
    let candidate = scenario.harness_candidate();
    let started = Instant::now();

    run_setup_command(
        agent_binary,
        &environment,
        profile,
        "session-create",
        &[
            "session",
            "create",
            &format!("--id={}", environment.manifest.session_id),
            "--title=Coding Harness Evaluation",
        ],
    )
    .await?;

    if arm == CodingHarnessArm::Harness {
        let package_path = harness_path(scenario);
        let package_path = package_path.to_string_lossy().into_owned();
        run_setup_command(
            agent_binary,
            &environment,
            profile,
            "harness-install",
            &["harness", "install", package_path.as_str()],
        )
        .await?;
    }

    let stdout_path = environment.run_root.join("objective.stdout.log");
    let stderr_path = environment.run_root.join("objective.stderr.log");
    let stdout = File::create(&stdout_path)?;
    let stderr = File::create(&stderr_path)?;
    let mut command = configured_command(agent_binary, &environment, profile)?;
    command
        .args([
            "objective",
            "create",
            &format!("--id={objective_id}"),
            &format!("--session={}", environment.manifest.session_id),
        ])
        .current_dir(&environment.manifest.workspace_root)
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    if arm == CodingHarnessArm::Harness {
        command.arg(format!("--harness={}@{}", candidate.id, candidate.version));
    }
    command.arg(&environment.manifest.user_prompt);

    let mut child = command.spawn()?;
    let timeout_seconds = std::env::var("MORPHZ_EVAL_RUN_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(1_200);
    let status =
        match tokio::time::timeout(Duration::from_secs(timeout_seconds), child.wait()).await {
            Ok(status) => status?,
            Err(_) => {
                child.kill().await?;
                child.wait().await?;
                return Err(format!(
                    "Coding Harness {} arm 超过 {timeout_seconds} 秒；日志位于 {}",
                    arm.as_str(),
                    environment.run_root.display()
                )
                .into());
            }
        };

    let verification = verify_coding_eval(&environment.run_root).await?;
    let event_score = score_coding_eval(&environment.run_root).await?;
    let discipline = inspect_coding_discipline(
        &environment.run_root,
        &environment.manifest,
        verification.success,
        &event_score,
    )
    .await?;
    let harness =
        inspect_harness_evidence(&environment, &objective_id, candidate.id, candidate.version)
            .await?;
    let procedure_adherence = if scenario == CodingHarnessScenario::ProcedureAdherence {
        Some(inspect_procedure_adherence(&environment).await?)
    } else {
        None
    };
    let runtime_eval = if scenario == CodingHarnessScenario::RuntimeEval {
        Some(inspect_runtime_eval(&environment, &objective_id).await?)
    } else {
        None
    };
    let run = CodingHarnessEvalRun {
        arm,
        scenario,
        run_root: environment.run_root.clone(),
        agent_binary: std::fs::canonicalize(agent_binary)?,
        duration_seconds: started.elapsed().as_secs_f64(),
        exit_code: status.code(),
        model_profile: profile.clone(),
        objective_id,
        verification,
        event_score,
        discipline,
        harness,
        procedure_adherence,
        runtime_eval,
    };
    std::fs::write(
        environment.run_root.join("coding_harness_run.json"),
        serde_json::to_vec_pretty(&run)?,
    )?;
    Ok(run)
}

pub async fn run_coding_harness_suite(
    base_dir: Option<&Path>,
    scenario: CodingHarnessScenario,
    agent_binary: &Path,
    profile: &ModelProfileIdentity,
) -> Result<CodingHarnessEvalSuite, DynError> {
    let base = base_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("morphz-coding-harness-evals"));
    std::fs::create_dir_all(&base)?;
    let base = std::fs::canonicalize(base)?;
    let id = format!(
        "{CODING_HARNESS_SCENARIO}-{}-suite-{}-{}",
        scenario.as_str(),
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        std::process::id()
    );
    let suite_root = base.join(&id);
    std::fs::create_dir_all(&suite_root)?;

    let baseline = run_coding_harness_eval(
        Some(&suite_root),
        CodingHarnessArm::Baseline,
        scenario,
        agent_binary,
        profile,
    )
    .await?;
    let harness = run_coding_harness_eval(
        Some(&suite_root),
        CodingHarnessArm::Harness,
        scenario,
        agent_binary,
        profile,
    )
    .await?;
    let delta = CodingHarnessDelta {
        event_score: harness.event_score.score as i32 - baseline.event_score.score as i32,
        discipline_score: harness.discipline.score as i32 - baseline.discipline.score as i32,
        assistant_attempts: harness.event_score.attempts as i32
            - baseline.event_score.attempts as i32,
        work_attempts: harness.event_score.work_attempts as i32
            - baseline.event_score.work_attempts as i32,
        context_attempts: harness.event_score.context_attempts as i32
            - baseline.event_score.context_attempts as i32,
        physical_tool_calls: harness.discipline.physical_tool_calls as i32
            - baseline.discipline.physical_tool_calls as i32,
        duplicate_physical_tool_calls: harness.discipline.exact_duplicate_physical_tool_calls
            as i32
            - baseline.discipline.exact_duplicate_physical_tool_calls as i32,
        procedure_adherence_score: harness
            .procedure_adherence
            .as_ref()
            .zip(baseline.procedure_adherence.as_ref())
            .map(|(harness, baseline)| harness.score as i32 - baseline.score as i32),
        duration_seconds: harness.duration_seconds - baseline.duration_seconds,
    };
    let interpretation = if scenario == CodingHarnessScenario::ProcedureAdherence
        && harness
            .procedure_adherence
            .as_ref()
            .is_some_and(|evidence| evidence.score == evidence.max_score)
        && baseline
            .procedure_adherence
            .as_ref()
            .zip(harness.procedure_adherence.as_ref())
            .is_some_and(|(baseline, harness)| baseline.score < harness.score)
    {
        "Harness 组完整执行了刻意反常的程序探针，而 Baseline 没有；本样本直接支持模型能够理解并遵守 .hns Contract 的程序顺序。"
    } else if harness.verification.success && !baseline.verification.success {
        "本次配对样本中 Harness 改善了最终正确性；需要重复样本确认不是采样方差。"
    } else if harness.verification.success == baseline.verification.success
        && harness.discipline.score > baseline.discipline.score
        && harness.discipline.exact_duplicate_physical_tool_calls
            <= baseline.discipline.exact_duplicate_physical_tool_calls
    {
        "本次配对样本最终正确性相同，Harness 提高了过程纪律且未增加重复调用；需要重复样本确认。"
    } else if harness.verification.success == baseline.verification.success
        && harness.discipline.score == baseline.discipline.score
    {
        "本次配对样本未观察到清晰提升；不能据此证明 Harness 无效，应结合轨迹并增加样本。"
    } else {
        "本次配对样本出现退化或混合结果；定位轨迹差异前不宣称 Harness 有效。"
    }
    .to_string();
    let suite = CodingHarnessEvalSuite {
        id,
        scenario,
        created_at: Utc::now().to_rfc3339(),
        suite_root: suite_root.clone(),
        model_profile: profile.clone(),
        baseline,
        harness,
        delta,
        interpretation,
    };
    std::fs::write(
        suite_root.join("suite_report.json"),
        serde_json::to_vec_pretty(&suite)?,
    )?;
    Ok(suite)
}

async fn run_setup_command(
    agent_binary: &Path,
    environment: &CodingEvalEnvironment,
    profile: &ModelProfileIdentity,
    phase: &str,
    arguments: &[&str],
) -> Result<(), DynError> {
    let stdout = File::create(environment.run_root.join(format!("{phase}.stdout.log")))?;
    let stderr = File::create(environment.run_root.join(format!("{phase}.stderr.log")))?;
    let status = configured_command(agent_binary, environment, profile)?
        .args(arguments)
        .current_dir(&environment.manifest.workspace_root)
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .status()
        .await?;
    if !status.success() {
        return Err(format!(
            "Coding Harness setup 阶段 '{phase}' 失败，退出码 {:?}；日志位于 {}",
            status.code(),
            environment.run_root.display()
        )
        .into());
    }
    Ok(())
}

fn configured_command(
    agent_binary: &Path,
    environment: &CodingEvalEnvironment,
    profile: &ModelProfileIdentity,
) -> Result<Command, DynError> {
    let mut command = Command::new(agent_binary);
    command
        .envs(&environment.environment)
        .env("MORPHZ_BIND", "127.0.0.1:0")
        .env("MORPHZ_REPLY_WAIT_NOTICE_SECS", "600");
    crate::configure_agent_model_profile(
        &mut command,
        &environment.run_root,
        profile.protocol.as_str(),
        &profile.base_url,
        &profile.model,
        &profile.api_key_env,
    )?;
    Ok(command)
}

async fn inspect_harness_evidence(
    environment: &CodingEvalEnvironment,
    objective_id: &str,
    expected_harness_id: &str,
    expected_harness_version: &str,
) -> Result<CodingHarnessEvidence, DynError> {
    let store = SqliteStore::new(
        environment
            .manifest
            .database_path
            .to_string_lossy()
            .as_ref(),
    )
    .await?;
    let package = store
        .query(QueryFilter {
            topic: Some(HARNESS_PACKAGE_TOPIC.to_string()),
            ..QueryFilter::default()
        })
        .await?
        .into_iter()
        .find(|event| {
            event
                .payload
                .get("harness_id")
                .and_then(|value| value.as_str())
                == Some(expected_harness_id)
                && event
                    .payload
                    .get("harness_version")
                    .and_then(|value| value.as_str())
                    == Some(expected_harness_version)
        });
    let binding = store
        .query(QueryFilter {
            topic: Some(HARNESS_BINDING_TOPIC.to_string()),
            ..QueryFilter::default()
        })
        .await?
        .into_iter()
        .find(|event| {
            event
                .payload
                .get("objective_id")
                .and_then(|value| value.as_str())
                == Some(objective_id)
        });
    Ok(CodingHarnessEvidence {
        package_registered: package.is_some(),
        objective_bound: binding.is_some(),
        harness_id: binding
            .as_ref()
            .and_then(|event| event.payload.get("harness_id"))
            .and_then(|value| value.as_str())
            .map(str::to_string),
        harness_version: binding
            .as_ref()
            .and_then(|event| event.payload.get("harness_version"))
            .and_then(|value| value.as_str())
            .map(str::to_string),
        artifact_hash: binding
            .as_ref()
            .and_then(|event| event.payload.get("artifact_hash"))
            .and_then(|value| value.as_str())
            .map(str::to_string),
    })
}

async fn inspect_procedure_adherence(
    environment: &CodingEvalEnvironment,
) -> Result<ProcedureAdherenceEvidence, DynError> {
    let store = SqliteStore::new(
        environment
            .manifest
            .database_path
            .to_string_lossy()
            .as_ref(),
    )
    .await?;
    let events = store.query(QueryFilter::default()).await?;
    let first_change_sequence = events
        .iter()
        .filter(|event| event.topic == "chat/file_change")
        .filter_map(|event| event.sequence)
        .min();
    let baseline_failure_sequence = events
        .iter()
        .filter(|event| event.topic == "chat/tool_output")
        .filter(|event| {
            event
                .payload
                .get("tool_name")
                .and_then(|value| value.as_str())
                == Some("exec")
        })
        .filter(|event| {
            event
                .payload
                .get("text")
                .and_then(|value| value.as_str())
                .is_some_and(exec_output_failed_tests)
        })
        .filter_map(|event| event.sequence)
        .min();

    let mut marker_read_sequences = Vec::new();
    let mut probe_exec_sequences = Vec::new();
    for event in events
        .iter()
        .filter(|event| event.topic == "chat/assistant_call")
    {
        let Some(sequence) = event.sequence else {
            continue;
        };
        for call in event
            .payload
            .get("tool_calls")
            .and_then(|value| value.as_array())
            .into_iter()
            .flatten()
        {
            let Some(function) = call.get("function") else {
                continue;
            };
            let Some(name) = function.get("name").and_then(|value| value.as_str()) else {
                continue;
            };
            let arguments = parse_function_arguments(function.get("arguments"));
            if name == "read"
                && arguments
                    .get("path")
                    .and_then(|value| value.as_str())
                    .is_some_and(|path| path == "PROCEDURE.md" || path.ends_with("/PROCEDURE.md"))
            {
                marker_read_sequences.push(sequence);
            }
            if name == "exec"
                && arguments
                    .get("command")
                    .and_then(|value| value.as_str())
                    .is_some_and(|command| command.trim() == "printf 'violet-otter-731\\n'")
            {
                probe_exec_sequences.push(sequence);
            }
        }
    }

    let marker_read_exactly_once = marker_read_sequences.len() == 1;
    let probe_exec_exactly_once = probe_exec_sequences.len() == 1;
    let baseline_before_marker = baseline_failure_sequence
        .zip(marker_read_sequences.first().copied())
        .is_some_and(|(failure, marker)| failure < marker);
    let marker_before_probe = marker_read_sequences
        .first()
        .copied()
        .zip(probe_exec_sequences.first().copied())
        .is_some_and(|(marker, probe)| marker < probe);
    let probe_before_change = probe_exec_sequences
        .first()
        .copied()
        .zip(first_change_sequence)
        .is_some_and(|(probe, change)| probe < change);
    let strict_order_satisfied = baseline_before_marker
        && marker_before_probe
        && probe_before_change
        && marker_read_exactly_once
        && probe_exec_exactly_once;
    let score = [
        baseline_before_marker,
        marker_read_exactly_once,
        marker_before_probe,
        probe_exec_exactly_once,
        probe_before_change,
    ]
    .into_iter()
    .filter(|satisfied| *satisfied)
    .count() as u32;

    Ok(ProcedureAdherenceEvidence {
        score,
        max_score: 5,
        baseline_failure_sequence,
        marker_read_sequences,
        probe_exec_sequences,
        first_change_sequence,
        marker_read_exactly_once,
        probe_exec_exactly_once,
        strict_order_satisfied,
    })
}

async fn inspect_runtime_eval(
    environment: &CodingEvalEnvironment,
    objective_id: &str,
) -> Result<RuntimeEvalEvidence, DynError> {
    let store = SqliteStore::new(
        environment
            .manifest
            .database_path
            .to_string_lossy()
            .as_ref(),
    )
    .await?;
    let plans = store
        .list_plan_executions(PlanExecutionFilter {
            context_id: Some(environment.manifest.context_id.clone()),
            objective_id: Some(objective_id.to_string()),
            include_terminal: true,
            ..PlanExecutionFilter::default()
        })
        .await?;
    let mut jobs = store
        .list_execution_jobs(ExecutionJobFilter {
            context_id: Some(environment.manifest.context_id.clone()),
            include_terminal: true,
            ..ExecutionJobFilter::default()
        })
        .await?;
    jobs.sort_by_key(|job| job.created_at);

    let events = store
        .query(QueryFilter {
            context_id: Some(environment.manifest.context_id.clone()),
            ..QueryFilter::default()
        })
        .await?;
    let infer_requests = events
        .iter()
        .filter(|event| event.topic == "chat/infer_request")
        .collect::<Vec<_>>();
    let infer_roots = infer_requests
        .iter()
        .filter_map(|event| {
            event
                .payload
                .get("root_turn_id")
                .and_then(|value| value.as_str())
        })
        .collect::<std::collections::HashSet<_>>();
    let infer_tool_call_count = events
        .iter()
        .filter(|event| event.topic == "chat/assistant_call")
        .filter(|event| {
            event
                .payload
                .get("root_turn_id")
                .and_then(|value| value.as_str())
                .is_some_and(|root| infer_roots.contains(root))
        })
        .map(|event| {
            event
                .payload
                .get("tool_calls")
                .and_then(|value| value.as_array())
                .map_or(0, Vec::len)
        })
        .sum();
    let infer_result_count = events
        .iter()
        .filter(|event| event.topic == "plan/infer_result")
        .count();
    let infer_is_pure = !infer_requests.is_empty()
        && infer_requests.iter().all(|event| {
            event
                .payload
                .get("tools")
                .and_then(|value| value.as_array())
                .is_some_and(Vec::is_empty)
        });
    let infer_returns_json = !infer_requests.is_empty()
        && infer_requests.iter().all(|event| {
            event
                .payload
                .get("result_kind")
                .and_then(|value| value.as_str())
                == Some("json")
        });
    let plan_statuses = plans
        .iter()
        .map(|plan| plan.status.as_str().to_string())
        .collect::<Vec<_>>();
    let physical_effect_order = jobs
        .iter()
        .map(|job| job.tool_name.clone())
        .collect::<Vec<_>>();
    let strict_control_flow_satisfied = plans.len() == 1
        && plans[0].status == PlanExecutionStatus::Succeeded
        && physical_effect_order == ["exec", "read", "edit", "exec"]
        && infer_requests.len() == 1
        && infer_result_count == 1
        && infer_tool_call_count == 0
        && infer_is_pure
        && infer_returns_json;

    Ok(RuntimeEvalEvidence {
        plan_statuses,
        physical_effect_order,
        infer_request_count: infer_requests.len(),
        infer_result_count,
        infer_tool_call_count,
        infer_is_pure,
        infer_returns_json,
        strict_control_flow_satisfied,
    })
}

fn parse_function_arguments(value: Option<&serde_json::Value>) -> serde_json::Value {
    match value {
        Some(serde_json::Value::String(text)) => {
            serde_json::from_str(text).unwrap_or(serde_json::Value::Null)
        }
        Some(value) if value.is_object() => value.clone(),
        _ => serde_json::Value::Null,
    }
}

pub fn parse_arm(value: &str) -> Result<CodingHarnessArm, DynError> {
    match value {
        "baseline" | "fresh" => Ok(CodingHarnessArm::Baseline),
        "harness" | "coding_harness" => Ok(CodingHarnessArm::Harness),
        _ => Err(format!("未知 Coding Harness arm '{value}'；支持 baseline、harness").into()),
    }
}

pub fn parse_scenario(value: &str) -> Result<CodingHarnessScenario, DynError> {
    match value {
        "retry-state-machine" | "retry" => Ok(CodingHarnessScenario::RetryStateMachine),
        "cache-coherence" | "cache" => Ok(CodingHarnessScenario::CacheCoherence),
        "procedure-adherence" | "procedure" | "probe" => {
            Ok(CodingHarnessScenario::ProcedureAdherence)
        }
        "runtime-eval" | "eval" | "mixed" => Ok(CodingHarnessScenario::RuntimeEval),
        _ => Err(format!(
            "未知 Coding Harness scenario '{value}'；支持 retry-state-machine、cache-coherence、procedure-adherence、runtime-eval"
        )
        .into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn coding_harness_is_a_valid_single_file_package() {
        let package = HarnessPackage::from_source("coding.hns", CODING_HARNESS_SOURCE).unwrap();
        assert_eq!(package.manifest.id, CODING_HARNESS_ID);
        assert_eq!(package.manifest.version, CODING_HARNESS_VERSION);
        assert_eq!(
            package.entry.owner,
            morphz::sexpr_eval::EvaluationOwner::Model
        );

        let runtime =
            HarnessPackage::from_source("coding-runtime-eval.hns", RUNTIME_EVAL_HARNESS_SOURCE)
                .unwrap();
        assert_eq!(runtime.manifest.id, RUNTIME_EVAL_HARNESS_ID);
        assert_eq!(
            runtime.entry.owner,
            morphz::sexpr_eval::EvaluationOwner::Runtime
        );
        assert!(runtime.entry.source.contains("(returns EditDecision)"));
        assert!(runtime.entry.source.contains("(tools)"));
        assert!(package.contract.to_string().contains("inspect-before-edit"));
        assert!(package.mind.is_some());

        let probe = HarnessPackage::from_source(
            "coding-procedure-probe.hns",
            PROCEDURE_PROBE_HARNESS_SOURCE,
        )
        .unwrap();
        assert_eq!(probe.manifest.id, PROCEDURE_PROBE_HARNESS_ID);
        assert!(probe.contract.to_string().contains("procedure-probe"));
        assert_eq!(
            probe.entry.owner,
            morphz::sexpr_eval::EvaluationOwner::Model
        );
    }

    #[test]
    fn paired_environments_have_identical_task_and_workspace() {
        for scenario in [
            CodingHarnessScenario::RetryStateMachine,
            CodingHarnessScenario::CacheCoherence,
            CodingHarnessScenario::ProcedureAdherence,
            CodingHarnessScenario::RuntimeEval,
        ] {
            let base = TempDir::new().unwrap();
            let baseline = create_coding_harness_eval_environment(
                Some(base.path()),
                CodingHarnessArm::Baseline,
                scenario,
            )
            .unwrap();
            let harness = create_coding_harness_eval_environment(
                Some(base.path()),
                CodingHarnessArm::Harness,
                scenario,
            )
            .unwrap();
            assert_eq!(baseline.manifest.user_prompt, harness.manifest.user_prompt);
            assert_eq!(
                baseline.manifest.initial_sha256,
                harness.manifest.initial_sha256
            );
            assert!(baseline.manifest.injected_frame_ids.is_empty());
            assert!(harness.manifest.injected_frame_ids.is_empty());
        }
    }

    #[test]
    fn scenarios_select_distinct_fixtures_and_hidden_suites() {
        let base = TempDir::new().unwrap();
        let retry = create_coding_harness_eval_environment(
            Some(base.path()),
            CodingHarnessArm::Baseline,
            CodingHarnessScenario::RetryStateMachine,
        )
        .unwrap();
        let cache = create_coding_harness_eval_environment(
            Some(base.path()),
            CodingHarnessArm::Baseline,
            CodingHarnessScenario::CacheCoherence,
        )
        .unwrap();

        assert_ne!(retry.manifest.user_prompt, cache.manifest.user_prompt);
        assert_ne!(
            retry.manifest.hidden_test_suite,
            cache.manifest.hidden_test_suite
        );
        assert!(retry.manifest.workspace_root.join("src/retry.rs").exists());
        assert!(cache.manifest.workspace_root.join("src/cache.rs").exists());

        let procedure = create_coding_harness_eval_environment(
            Some(base.path()),
            CodingHarnessArm::Harness,
            CodingHarnessScenario::ProcedureAdherence,
        )
        .unwrap();
        assert_eq!(procedure.manifest.user_prompt, cache.manifest.user_prompt);
        assert!(procedure
            .manifest
            .workspace_root
            .join("PROCEDURE.md")
            .exists());
        assert_eq!(
            CodingHarnessScenario::ProcedureAdherence
                .harness_candidate()
                .id,
            PROCEDURE_PROBE_HARNESS_ID
        );

        let runtime = create_coding_harness_eval_environment(
            Some(base.path()),
            CodingHarnessArm::Harness,
            CodingHarnessScenario::RuntimeEval,
        )
        .unwrap();
        assert_eq!(runtime.manifest.user_prompt, cache.manifest.user_prompt);
        assert_eq!(
            CodingHarnessScenario::RuntimeEval.harness_candidate().id,
            RUNTIME_EVAL_HARNESS_ID
        );
    }
}
