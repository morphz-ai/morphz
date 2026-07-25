use crate::coding_frame_eval::{inspect_coding_discipline, CodingDisciplineReport};
use crate::context_metacognition_eval::ModelProfileIdentity;
use crate::eval_sandbox::{
    create_coding_eval_v2, create_coding_eval_v3, score_coding_eval, verify_coding_eval,
    CodingEvalEnvironment, CodingEvalScore, CodingEvalVerification,
};
use chrono::Utc;
use morphz::harness_package::{HarnessPackage, HARNESS_BINDING_TOPIC, HARNESS_PACKAGE_TOPIC};
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{EventStore, QueryFilter};
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
}

impl CodingHarnessScenario {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RetryStateMachine => "retry-state-machine",
            Self::CacheCoherence => "cache-coherence",
        }
    }

    fn neutral_prompt(self) -> &'static str {
        match self {
            Self::RetryStateMachine => RETRY_STATE_MACHINE_PROMPT,
            Self::CacheCoherence => CACHE_COHERENCE_PROMPT,
        }
    }
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
    pub ledger_score: CodingEvalScore,
    pub discipline: CodingDisciplineReport,
    pub harness: CodingHarnessEvidence,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodingHarnessDelta {
    pub ledger_score: i32,
    pub discipline_score: i32,
    pub assistant_attempts: i32,
    pub work_attempts: i32,
    pub context_attempts: i32,
    pub physical_tool_calls: i32,
    pub duplicate_physical_tool_calls: i32,
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

pub fn create_coding_harness_eval_environment(
    base_dir: Option<&Path>,
    arm: CodingHarnessArm,
    scenario: CodingHarnessScenario,
) -> Result<CodingEvalEnvironment, DynError> {
    let package = HarnessPackage::from_source("coding.hns", CODING_HARNESS_SOURCE)?;
    if package.manifest.id != CODING_HARNESS_ID
        || package.manifest.version != CODING_HARNESS_VERSION
    {
        return Err("内置 Coding Harness identity 与评测常量不一致".into());
    }
    let mut environment = match scenario {
        CodingHarnessScenario::RetryStateMachine => create_coding_eval_v2(base_dir)?,
        CodingHarnessScenario::CacheCoherence => create_coding_eval_v3(base_dir)?,
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
    let objective_id = format!("objective-{}", environment.manifest.id);
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
        let package_path = coding_harness_path();
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
        command.arg(format!(
            "--harness={CODING_HARNESS_ID}@{CODING_HARNESS_VERSION}"
        ));
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
    let ledger_score = score_coding_eval(&environment.run_root).await?;
    let discipline = inspect_coding_discipline(
        &environment.run_root,
        &environment.manifest,
        verification.success,
        &ledger_score,
    )
    .await?;
    let harness = inspect_harness_evidence(&environment, &objective_id).await?;
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
        ledger_score,
        discipline,
        harness,
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
        ledger_score: harness.ledger_score.score as i32 - baseline.ledger_score.score as i32,
        discipline_score: harness.discipline.score as i32 - baseline.discipline.score as i32,
        assistant_attempts: harness.ledger_score.attempts as i32
            - baseline.ledger_score.attempts as i32,
        work_attempts: harness.ledger_score.work_attempts as i32
            - baseline.ledger_score.work_attempts as i32,
        context_attempts: harness.ledger_score.context_attempts as i32
            - baseline.ledger_score.context_attempts as i32,
        physical_tool_calls: harness.discipline.physical_tool_calls as i32
            - baseline.discipline.physical_tool_calls as i32,
        duplicate_physical_tool_calls: harness.discipline.exact_duplicate_physical_tool_calls
            as i32
            - baseline.discipline.exact_duplicate_physical_tool_calls as i32,
        duration_seconds: harness.duration_seconds - baseline.duration_seconds,
    };
    let interpretation = if harness.verification.success && !baseline.verification.success {
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
                == Some(CODING_HARNESS_ID)
                && event
                    .payload
                    .get("harness_version")
                    .and_then(|value| value.as_str())
                    == Some(CODING_HARNESS_VERSION)
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
        _ => Err(format!(
            "未知 Coding Harness scenario '{value}'；支持 retry-state-machine、cache-coherence"
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
        assert!(package.contract.to_string().contains("inspect-before-edit"));
        assert!(package.mind.is_some());
    }

    #[test]
    fn paired_environments_have_identical_task_and_workspace() {
        for scenario in [
            CodingHarnessScenario::RetryStateMachine,
            CodingHarnessScenario::CacheCoherence,
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
    }
}
