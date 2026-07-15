use crate::context_metacognition_eval::ModelProfileIdentity;
use crate::eval_sandbox::{
    create_coding_eval_v2, exec_output_failed_tests, exec_output_successful_tests,
    score_coding_eval, verify_coding_eval, CodingEvalEnvironment, CodingEvalManifest,
    CodingEvalScore, CodingEvalVerification,
};
use chrono::Utc;
use morphz::config::OrchestratorConfig;
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{EventStore, QueryFilter};
use morphz::orchestrator::context::ContextEngine;
use morphz::orchestrator::orchestrator::{
    SEMANTIC_SEXPR_VM_SYSTEM_PROMPT_MODE, SYSTEM_PROMPT_MODE_ENV,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashSet};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

type DynError = Box<dyn std::error::Error + Send + Sync>;

pub const CODING_FRAME_ID: &str = "coding-discipline-v1";
pub const CODING_FRAME_BODY: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/frames/coding_discipline_v1.sexpr"
));

const EXTERNAL_FRAME_REASON_PREFIX: &str = "evaluator-external-frame:";
const CODING_FRAME_SCENARIO: &str = "coding_frame_ab_v1";
const NEUTRAL_CODING_PROMPT: &str = "修复当前 Rust crate 的任务队列重试状态机：临时失败任务的退避时间与最大尝试次数不正确，已经取消的任务还可能被迟到的失败结果重新入队。只允许修改 src/retry.rs、src/store.rs、src/worker.rs；不得修改或删除测试、Cargo.toml、公共 API 或其他文件；不得增加依赖、访问网络或使用 unsafe。完成后简要说明实际修改和验证结果。";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CodingFrameArm {
    Fresh,
    CodingFrame,
}

impl CodingFrameArm {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fresh => "fresh",
            Self::CodingFrame => "coding_frame",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CodingDisciplineReport {
    pub score: u32,
    pub max_score: u32,
    pub baseline_failure_before_first_change: bool,
    pub relevant_paths_read_before_first_change: Vec<String>,
    pub validation_success_after_last_change: bool,
    pub independent_verifier_passed: bool,
    pub scope_clean: bool,
    pub final_reply_mentions_changed_files: bool,
    pub final_reply_mentions_test_evidence: bool,
    pub final_reply: String,
    pub physical_tool_calls: usize,
    pub exact_duplicate_physical_tool_calls: usize,
    pub agent_context_commits: usize,
    pub task_specific_frames_created: usize,
    pub coding_frame_active_at_end: bool,
    pub coding_frame_protected_at_end: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodingFrameEvalRun {
    pub arm: CodingFrameArm,
    pub run_root: PathBuf,
    pub agent_binary: PathBuf,
    pub stdout_path: PathBuf,
    pub stderr_path: PathBuf,
    pub duration_seconds: f64,
    pub exit_code: Option<i32>,
    pub model_profile: ModelProfileIdentity,
    pub verification: CodingEvalVerification,
    pub ledger_score: CodingEvalScore,
    pub discipline: CodingDisciplineReport,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodingFrameDelta {
    pub ledger_score: i32,
    pub discipline_score: i32,
    pub assistant_attempts: i32,
    pub work_attempts: i32,
    pub context_attempts: i32,
    pub physical_tool_calls: i32,
    pub duration_seconds: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodingFrameEvalSuite {
    pub id: String,
    pub created_at: String,
    pub suite_root: PathBuf,
    pub model_profile: ModelProfileIdentity,
    pub fresh: CodingFrameEvalRun,
    pub coding_frame: CodingFrameEvalRun,
    pub delta: CodingFrameDelta,
    pub initial_interpretation: String,
}

pub async fn create_coding_frame_eval_environment(
    base_dir: Option<&Path>,
    arm: CodingFrameArm,
) -> Result<CodingEvalEnvironment, DynError> {
    morphz::sexpr::parse(CODING_FRAME_BODY)
        .map_err(|error| format!("Coding Frame SExpr 无法解析: {error}"))?;
    let mut environment = create_coding_eval_v2(base_dir)?;
    environment.manifest.benchmark = format!("{CODING_FRAME_SCENARIO}-{}", arm.as_str());
    environment.manifest.user_prompt = NEUTRAL_CODING_PROMPT.to_string();
    if arm == CodingFrameArm::CodingFrame {
        environment
            .manifest
            .injected_frame_ids
            .push(CODING_FRAME_ID.to_string());
    }
    std::fs::write(
        &environment.manifest_path,
        serde_json::to_vec_pretty(&environment.manifest)?,
    )?;
    if arm == CodingFrameArm::CodingFrame {
        inject_coding_frame(&environment).await?;
    }
    Ok(environment)
}

async fn inject_coding_frame(environment: &CodingEvalEnvironment) -> Result<(), DynError> {
    let store = Arc::new(
        SqliteStore::new(
            environment
                .manifest
                .database_path
                .to_string_lossy()
                .as_ref(),
        )
        .await?,
    );
    let context = ContextEngine::new(store, OrchestratorConfig::default());
    let transaction = format!(
        "(context-tx (base-version 0) (reason \"{EXTERNAL_FRAME_REASON_PREFIX}{CODING_FRAME_ID}\") (create {CODING_FRAME_ID} {}) (protect {CODING_FRAME_ID}))",
        CODING_FRAME_BODY.trim()
    );
    context
        .apply_context_transaction(
            &environment.manifest.context_id,
            "external-frame-evaluator",
            &transaction,
        )
        .await?;
    Ok(())
}

pub async fn run_coding_frame_eval(
    base_dir: Option<&Path>,
    arm: CodingFrameArm,
    agent_binary: &Path,
    profile: &ModelProfileIdentity,
) -> Result<CodingFrameEvalRun, DynError> {
    let mut environment = create_coding_frame_eval_environment(base_dir, arm).await?;
    environment.environment.insert(
        SYSTEM_PROMPT_MODE_ENV.to_string(),
        SEMANTIC_SEXPR_VM_SYSTEM_PROMPT_MODE.to_string(),
    );
    let stdout_path = environment.run_root.join("agent.stdout.log");
    let stderr_path = environment.run_root.join("agent.stderr.log");
    let stdout = File::create(&stdout_path)?;
    let stderr = File::create(&stderr_path)?;
    let mut command = Command::new(agent_binary);
    command
        .envs(&environment.environment)
        .env("MORPHZ_BIND", "127.0.0.1:0")
        .env("MORPHZ_REPLY_WAIT_NOTICE_SECS", "600")
        .stdin(Stdio::piped())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    crate::configure_agent_model_profile(
        &mut command,
        &environment.run_root,
        profile.protocol.as_str(),
        &profile.base_url,
        &profile.model,
        &profile.api_key_env,
    )?;

    let started = Instant::now();
    let mut child = command.spawn()?;
    let input = format!("{}\nexit\n", environment.manifest.user_prompt);
    let mut stdin = child.stdin.take().ok_or("无法打开 Morphz Agent stdin")?;
    stdin.write_all(input.as_bytes()).await?;
    stdin.shutdown().await?;
    drop(stdin);

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
                    "Coding Frame {} arm 超过 {timeout_seconds} 秒；日志位于 {}",
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
    let run = CodingFrameEvalRun {
        arm,
        run_root: environment.run_root.clone(),
        agent_binary: std::fs::canonicalize(agent_binary)?,
        stdout_path,
        stderr_path,
        duration_seconds: started.elapsed().as_secs_f64(),
        exit_code: status.code(),
        model_profile: profile.clone(),
        verification,
        ledger_score,
        discipline,
    };
    std::fs::write(
        environment.run_root.join("coding_frame_run.json"),
        serde_json::to_vec_pretty(&run)?,
    )?;
    Ok(run)
}

pub async fn run_coding_frame_suite(
    base_dir: Option<&Path>,
    agent_binary: &Path,
    profile: &ModelProfileIdentity,
) -> Result<CodingFrameEvalSuite, DynError> {
    let base = base_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("morphz-coding-frame-evals"));
    std::fs::create_dir_all(&base)?;
    let base = std::fs::canonicalize(base)?;
    let id = format!(
        "{CODING_FRAME_SCENARIO}-suite-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        std::process::id()
    );
    let suite_root = base.join(&id);
    std::fs::create_dir_all(&suite_root)?;

    let fresh = run_coding_frame_eval(
        Some(&suite_root),
        CodingFrameArm::Fresh,
        agent_binary,
        profile,
    )
    .await?;
    let coding_frame = run_coding_frame_eval(
        Some(&suite_root),
        CodingFrameArm::CodingFrame,
        agent_binary,
        profile,
    )
    .await?;
    let delta = CodingFrameDelta {
        ledger_score: coding_frame.ledger_score.score as i32 - fresh.ledger_score.score as i32,
        discipline_score: coding_frame.discipline.score as i32 - fresh.discipline.score as i32,
        assistant_attempts: coding_frame.ledger_score.attempts as i32
            - fresh.ledger_score.attempts as i32,
        work_attempts: coding_frame.ledger_score.work_attempts as i32
            - fresh.ledger_score.work_attempts as i32,
        context_attempts: coding_frame.ledger_score.context_attempts as i32
            - fresh.ledger_score.context_attempts as i32,
        physical_tool_calls: coding_frame.discipline.physical_tool_calls as i32
            - fresh.discipline.physical_tool_calls as i32,
        duration_seconds: coding_frame.duration_seconds - fresh.duration_seconds,
    };
    let initial_interpretation = if coding_frame.verification.success
        && !fresh.verification.success
    {
        "首个配对样本中 Coding Frame 改善了最终正确性；仍需重复运行排除采样方差。"
    } else if coding_frame.verification.success == fresh.verification.success
        && coding_frame.discipline.score > fresh.discipline.score
    {
        "首个配对样本最终正确性相同，但 Coding Frame 提高了过程纪律；仍需重复运行确认。"
    } else if coding_frame.verification.success == fresh.verification.success
        && coding_frame.discipline.score == fresh.discipline.score
    {
        "首个配对样本未观察到过程或正确性提升；不能据此证明 Frame 无效，需要检查轨迹并增加样本。"
    } else {
        "首个配对样本出现退化或混合结果；在定位原因前不应宣称 Coding Frame 有效。"
    }
    .to_string();
    let suite = CodingFrameEvalSuite {
        id,
        created_at: Utc::now().to_rfc3339(),
        suite_root: suite_root.clone(),
        model_profile: profile.clone(),
        fresh,
        coding_frame,
        delta,
        initial_interpretation,
    };
    std::fs::write(
        suite_root.join("suite_report.json"),
        serde_json::to_vec_pretty(&suite)?,
    )?;
    Ok(suite)
}

async fn inspect_coding_discipline(
    run_root: &Path,
    manifest: &CodingEvalManifest,
    verifier_passed: bool,
    ledger_score: &CodingEvalScore,
) -> Result<CodingDisciplineReport, DynError> {
    let store = SqliteStore::new(manifest.database_path.to_string_lossy().as_ref()).await?;
    let events = store
        .query(QueryFilter::default())
        .await?
        .into_iter()
        .filter(|event| {
            event
                .payload
                .get("context_id")
                .and_then(|value| value.as_str())
                .is_none_or(|context_id| context_id == manifest.context_id)
        })
        .collect::<Vec<_>>();
    let first_change = events
        .iter()
        .filter(|event| event.topic == "chat/file_change")
        .filter_map(|event| event.sequence)
        .min();
    let last_change = events
        .iter()
        .filter(|event| event.topic == "chat/file_change")
        .filter_map(|event| event.sequence)
        .max();
    let baseline_failure_before_first_change = first_change.is_some_and(|change_sequence| {
        events.iter().any(|event| {
            event
                .sequence
                .is_some_and(|sequence| sequence < change_sequence)
                && event.topic == "chat/tool_output"
                && event
                    .payload
                    .get("tool_name")
                    .and_then(|value| value.as_str())
                    == Some("exec")
                && event
                    .payload
                    .get("text")
                    .and_then(|value| value.as_str())
                    .is_some_and(exec_output_failed_tests)
        })
    });
    let validation_success_after_last_change = last_change.is_some_and(|change_sequence| {
        events.iter().any(|event| {
            event
                .sequence
                .is_some_and(|sequence| sequence > change_sequence)
                && event.topic == "chat/tool_output"
                && event
                    .payload
                    .get("tool_name")
                    .and_then(|value| value.as_str())
                    == Some("exec")
                && event
                    .payload
                    .get("text")
                    .and_then(|value| value.as_str())
                    .is_some_and(exec_output_successful_tests)
        })
    });

    let mut relevant_paths_read_before_first_change = BTreeSet::new();
    let mut physical_calls = Vec::new();
    for event in events
        .iter()
        .filter(|event| event.topic == "chat/assistant_call")
    {
        let before_first_change = first_change
            .zip(event.sequence)
            .is_some_and(|(change, call)| call < change);
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
            let arguments = normalized_arguments(function.get("arguments"));
            if !matches!(name, "context_tx" | "no_reply") {
                physical_calls.push((name.to_string(), arguments.clone()));
            }
            if before_first_change && name == "read" {
                if let Some(path) = argument_path(&arguments) {
                    if is_relevant_v2_path(&path) {
                        relevant_paths_read_before_first_change.insert(path);
                    }
                }
            }
        }
    }
    let mut seen_calls = HashSet::new();
    let exact_duplicate_physical_tool_calls = physical_calls
        .iter()
        .filter(|call| !seen_calls.insert((*call).clone()))
        .count();

    let final_reply = events
        .iter()
        .rev()
        .find(|event| event.topic == "chat/reply")
        .and_then(|event| event.payload.get("text"))
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let final_reply_lower = final_reply.to_lowercase();
    let final_reply_mentions_changed_files = ledger_score
        .scope_audit
        .changed_paths
        .iter()
        .any(|path| final_reply.contains(path))
        || final_reply_lower.contains(".rs");
    let final_reply_mentions_test_evidence = ["测试", "test", "cargo"]
        .iter()
        .any(|marker| final_reply_lower.contains(marker));

    let commits = events
        .iter()
        .filter(|event| event.topic == "chat/context_tx_committed")
        .collect::<Vec<_>>();
    let agent_context_commits = commits
        .iter()
        .filter(|event| !is_external_frame_seed(event))
        .count();
    let final_state = commits
        .last()
        .and_then(|event| event.payload.get("state_after"));
    let retired = final_state
        .and_then(|state| state.get("retired"))
        .and_then(|value| value.as_array())
        .map(|ids| {
            ids.iter()
                .filter_map(|value| value.as_str())
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    let protected = final_state
        .and_then(|state| state.get("protected"))
        .and_then(|value| value.as_array())
        .map(|ids| {
            ids.iter()
                .filter_map(|value| value.as_str())
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    let frame_ids = final_state
        .and_then(|state| state.get("frames"))
        .and_then(|value| value.as_array())
        .map(|frames| {
            frames
                .iter()
                .filter_map(|frame| frame.get("id").and_then(|value| value.as_str()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let coding_frame_active_at_end =
        frame_ids.contains(&CODING_FRAME_ID) && !retired.contains(CODING_FRAME_ID);
    let coding_frame_protected_at_end = protected.contains(CODING_FRAME_ID);
    let task_specific_frames_created = frame_ids
        .iter()
        .filter(|id| **id != CODING_FRAME_ID)
        .count();

    let scope_clean = ledger_score.scope_audit.clean_scope;
    let score = u32::from(baseline_failure_before_first_change) * 2
        + u32::from(relevant_paths_read_before_first_change.len() >= 3)
        + u32::from(validation_success_after_last_change) * 2
        + u32::from(verifier_passed) * 2
        + u32::from(scope_clean)
        + u32::from(final_reply_mentions_changed_files && final_reply_mentions_test_evidence);
    let _ = run_root;
    Ok(CodingDisciplineReport {
        score,
        max_score: 9,
        baseline_failure_before_first_change,
        relevant_paths_read_before_first_change: relevant_paths_read_before_first_change
            .into_iter()
            .collect(),
        validation_success_after_last_change,
        independent_verifier_passed: verifier_passed,
        scope_clean,
        final_reply_mentions_changed_files,
        final_reply_mentions_test_evidence,
        final_reply,
        physical_tool_calls: physical_calls.len(),
        exact_duplicate_physical_tool_calls,
        agent_context_commits,
        task_specific_frames_created,
        coding_frame_active_at_end,
        coding_frame_protected_at_end,
    })
}

fn normalized_arguments(value: Option<&serde_json::Value>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    if let Some(text) = value.as_str() {
        return serde_json::from_str::<serde_json::Value>(text)
            .ok()
            .and_then(|value| serde_json::to_string(&value).ok())
            .unwrap_or_else(|| text.to_string());
    }
    serde_json::to_string(value).unwrap_or_default()
}

fn argument_path(arguments: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(arguments)
        .ok()
        .and_then(|value| {
            value
                .get("path")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
}

fn is_relevant_v2_path(path: &str) -> bool {
    matches!(
        path.trim_start_matches("./"),
        "src/model.rs"
            | "src/retry.rs"
            | "src/store.rs"
            | "src/worker.rs"
            | "tests/retry_state_machine.rs"
    )
}

fn is_external_frame_seed(event: &&morphz::event::Event) -> bool {
    event
        .payload
        .get("reason")
        .and_then(|value| value.as_str())
        .is_some_and(|reason| reason.starts_with(EXTERNAL_FRAME_REASON_PREFIX))
}

pub fn parse_arm(value: &str) -> Result<CodingFrameArm, DynError> {
    match value {
        "fresh" => Ok(CodingFrameArm::Fresh),
        "coding_frame" | "frame" => Ok(CodingFrameArm::CodingFrame),
        _ => Err(format!("未知 Coding Frame arm '{value}'；支持 fresh、coding_frame").into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn coding_frame_is_valid_sexpr() {
        morphz::sexpr::parse(CODING_FRAME_BODY).unwrap();
        assert!(CODING_FRAME_BODY.contains("evidence-before-belief"));
        assert!(CODING_FRAME_BODY.contains("baseline"));
    }

    #[tokio::test]
    async fn paired_environments_only_differ_in_injected_mind() {
        let base = TempDir::new().unwrap();
        let fresh = create_coding_frame_eval_environment(Some(base.path()), CodingFrameArm::Fresh)
            .await
            .unwrap();
        let framed =
            create_coding_frame_eval_environment(Some(base.path()), CodingFrameArm::CodingFrame)
                .await
                .unwrap();
        assert_eq!(fresh.manifest.user_prompt, framed.manifest.user_prompt);
        assert_eq!(
            fresh.manifest.initial_sha256,
            framed.manifest.initial_sha256
        );
        assert!(fresh.manifest.injected_frame_ids.is_empty());
        assert_eq!(framed.manifest.injected_frame_ids, vec![CODING_FRAME_ID]);

        let store = Arc::new(
            SqliteStore::new(framed.manifest.database_path.to_string_lossy().as_ref())
                .await
                .unwrap(),
        );
        let context = ContextEngine::new(store, OrchestratorConfig::default());
        let stored = context
            .find_frame(&framed.manifest.context_id, CODING_FRAME_ID)
            .await
            .unwrap()
            .unwrap()
            .body;
        assert_eq!(
            morphz::sexpr::parse(&stored).unwrap(),
            morphz::sexpr::parse(CODING_FRAME_BODY).unwrap()
        );
        let score = score_coding_eval(&framed.run_root).await.unwrap();
        assert_eq!(score.context_commits, 0);
        assert_eq!(score.context_autonomy_points, 0);
    }
}
