use crate::config::OrchestratorConfig;
use crate::event::{Event, TYPE_TOOL_OUTPUT};
use crate::memory::sqlite::SqliteStore;
use crate::memory::{EventStore, QueryFilter};
use crate::orchestrator::context::{ContextEngine, ContextPressure};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;

type DynError = Box<dyn std::error::Error + Send + Sync>;

const SEED_TOOL: &str = "metacognition_eval_seed";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeContractSnapshot {
    pub chronological_order_visible: bool,
    pub physical_freshness_visible: bool,
    pub preview_residency_visible: bool,
    pub presentation_does_not_count_as_usage: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetacognitionEvalManifest {
    pub id: String,
    pub created_at: String,
    #[serde(default)]
    pub context_id: String,
    pub session_id: String,
    pub database_path: PathBuf,
    pub workspace_root: PathBuf,
    pub artifact_dir: PathBuf,
    pub soft_token_limit: usize,
    pub hard_token_limit: usize,
    pub maintenance_reserve_tokens: usize,
    pub observation_preview_chars: usize,
    pub old_fact_id: String,
    pub new_fact_id: String,
    pub constraint_id: String,
    pub recall_target_id: String,
    pub noise_ids: Vec<String>,
    pub project_marker: String,
    pub current_marker: String,
    pub obsolete_marker: String,
    pub constraint_marker: String,
    pub recalled_marker: String,
    pub initial_pressure: ContextPressure,
    pub runtime_contract: RuntimeContractSnapshot,
    pub user_prompt: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MetacognitionEvalEnvironment {
    pub run_root: PathBuf,
    pub manifest_path: PathBuf,
    pub manifest: MetacognitionEvalManifest,
    pub environment: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvalCriterion {
    pub id: String,
    pub name_zh: String,
    pub max_score: u32,
    pub score: u32,
    pub passed: bool,
    pub evidence: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetacognitionEvalReport {
    pub run_root: PathBuf,
    pub total_score: u32,
    pub runtime_score: u32,
    pub agent_score: u32,
    pub success: bool,
    #[serde(default = "default_true")]
    pub valid_for_model_comparison: bool,
    #[serde(default)]
    pub infrastructure_errors: Vec<String>,
    pub criteria: Vec<EvalCriterion>,
    pub final_pressure: ContextPressure,
    pub active_frame_ids: Vec<String>,
    pub protected_ids: Vec<String>,
    pub retired_noise: usize,
    pub total_noise: usize,
    pub context_commits: usize,
    pub context_failures: usize,
    pub recall_calls: usize,
    pub assistant_calls: usize,
    pub replies: usize,
    pub physical_tool_outputs: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct MetacognitionEvalComparison {
    pub baseline_run: PathBuf,
    pub candidate_run: PathBuf,
    pub baseline_score: u32,
    pub candidate_score: u32,
    pub score_delta: i32,
    pub improved: bool,
    pub criterion_deltas: BTreeMap<String, i32>,
    pub context_commit_delta: i32,
    pub recall_call_delta: i32,
    pub assistant_call_delta: i32,
    pub reply_delta: i32,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetacognitionEvalRun {
    pub run_root: PathBuf,
    pub agent_binary: PathBuf,
    pub stdout_path: PathBuf,
    pub stderr_path: PathBuf,
    pub duration_seconds: f64,
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub model_profile: Option<ModelProfileIdentity>,
    pub report: MetacognitionEvalReport,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelProfileIdentity {
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub api_key_env: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelProfileFile {
    pub profiles: Vec<ModelProfileIdentity>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CriterionAggregate {
    pub name_zh: String,
    pub max_score: u32,
    pub pass_count: usize,
    pub pass_rate: f64,
    pub mean_score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetacognitionSuiteReport {
    pub id: String,
    pub created_at: String,
    pub suite_root: PathBuf,
    #[serde(default)]
    pub model_profile: Option<ModelProfileIdentity>,
    pub requested_runs: usize,
    pub completed_runs: usize,
    #[serde(default)]
    pub valid_runs: usize,
    pub successful_runs: usize,
    pub success_rate: f64,
    pub mean_total_score: f64,
    pub total_score_stddev: f64,
    pub min_total_score: u32,
    pub max_total_score: u32,
    pub mean_runtime_score: f64,
    pub mean_agent_score: f64,
    pub mean_context_commits: f64,
    pub mean_recall_calls: f64,
    pub mean_assistant_calls: f64,
    pub criteria: BTreeMap<String, CriterionAggregate>,
    pub runs: Vec<MetacognitionEvalRun>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MetacognitionSuiteComparison {
    pub baseline_suite: PathBuf,
    pub candidate_suite: PathBuf,
    pub baseline_runs: usize,
    pub candidate_runs: usize,
    pub baseline_success_rate: f64,
    pub candidate_success_rate: f64,
    pub success_rate_delta: f64,
    pub baseline_mean_score: f64,
    pub candidate_mean_score: f64,
    pub mean_score_delta: f64,
    pub mean_context_commit_delta: f64,
    pub mean_recall_call_delta: f64,
    pub mean_assistant_call_delta: f64,
    pub paired_wins: usize,
    pub paired_ties: usize,
    pub paired_losses: usize,
    pub criterion_pass_rate_deltas: BTreeMap<String, f64>,
    pub recommendation: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelMatrixEntry {
    pub profile: ModelProfileIdentity,
    pub suite_root: PathBuf,
    pub completed_runs: usize,
    pub valid_runs: usize,
    pub success_rate: f64,
    pub mean_total_score: f64,
    pub total_score_stddev: f64,
    pub mean_context_commits: f64,
    pub mean_recall_calls: f64,
    pub mean_assistant_calls: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MetacognitionModelMatrixReport {
    pub id: String,
    pub created_at: String,
    pub matrix_root: PathBuf,
    pub runs_per_model: usize,
    pub entries: Vec<ModelMatrixEntry>,
    pub ranking_by_mean_score: Vec<String>,
    pub note: String,
}

pub async fn create_metacognition_eval(
    base_dir: Option<&Path>,
) -> Result<MetacognitionEvalEnvironment, DynError> {
    let base = base_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("morphz-evals"));
    std::fs::create_dir_all(&base)?;
    let base = std::fs::canonicalize(base)?;
    let id = format!(
        "context-metacognition-v1-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        std::process::id()
    );
    let run_root = base.join(&id);
    let workspace_root = run_root.join("workspace");
    let artifact_dir = run_root.join("artifacts");
    std::fs::create_dir_all(&workspace_root)?;
    std::fs::create_dir_all(&artifact_dir)?;
    set_private_directory_permissions(&run_root)?;

    let database_path = run_root.join("morphz.db");
    let session_id = format!("metacognition-{id}");
    let context_id = format!("context-{id}");
    let store = Arc::new(SqliteStore::new(database_path.to_string_lossy().as_ref()).await?);
    let old_fact_id = "meta-resource-service-port-v1".to_string();
    let new_fact_id = "meta-resource-service-port-v2".to_string();
    let constraint_id = "meta-rare-safety-constraint".to_string();
    let recall_target_id = "meta-truncated-decision-record".to_string();
    let project_marker = "AURORA-27".to_string();
    let current_marker = "9090".to_string();
    let obsolete_marker = "8080".to_string();
    let constraint_marker = "NEVER-PUBLISH-SECRETS".to_string();
    let recalled_marker = "LANTERN-731".to_string();

    append_seed(
        &store,
        &context_id,
        &session_id,
        &old_fact_id,
        "早期配置快照：AURORA-27 的服务端口为 8080。这是资源 service-port 的 v1 版本。",
        Some(json!({"kind":"configuration", "key":"service-port", "version":"v1"})),
    )
    .await?;
    append_seed(
        &store,
        &context_id,
        &session_id,
        &constraint_id,
        "稀有但持续有效的用户安全约束：NEVER-PUBLISH-SECRETS。任何公开输出都不得包含密钥、令牌或私密凭据；该约束必须跨轮保留，直到用户明确撤销。",
        None,
    )
    .await?;

    let mut noise_ids = Vec::new();
    for index in 0..12 {
        let event_id = format!("meta-repetitive-noise-{index:02}");
        noise_ids.push(event_id.clone());
        append_seed(
            &store,
            &context_id,
            &session_id,
            &event_id,
            &format!(
                "一次性过程噪声 {index:02}：临时采样 RUN-{index:02} 已结束，没有改变项目目标、正式配置或安全约束；不值得形成长期记忆。"
            ),
            None,
        )
        .await?;
    }

    let hidden_record = format!(
        "决策记录开头。{}关键验收口令是 LANTERN-731；它证明 Agent 主动召回过被预览截断的原始证据。{}决策记录结尾。",
        "前置背景。".repeat(900),
        "后置背景。".repeat(900)
    );
    append_seed(
        &store,
        &context_id,
        &session_id,
        &recall_target_id,
        &hidden_record,
        None,
    )
    .await?;
    append_seed(
        &store,
        &context_id,
        &session_id,
        &new_fact_id,
        "最新配置快照：AURORA-27 的正式服务端口已修订为 9090，资源 service-port 当前为 v2；8080 只属于旧版本。",
        Some(json!({"kind":"configuration", "key":"service-port", "version":"v2"})),
    )
    .await?;

    let soft_token_limit = 32_000;
    let hard_token_limit = 48_000;
    let maintenance_reserve_tokens = 8_000;
    let observation_preview_chars = 700;
    let config = OrchestratorConfig {
        context_soft_token_limit: soft_token_limit,
        context_hard_token_limit: hard_token_limit,
        context_maintenance_reserve_tokens: maintenance_reserve_tokens,
        observation_preview_chars,
        ..Default::default()
    };
    let view = ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config)
        .build_context_encoding(&context_id, &session_id, &HashSet::new())
        .await?;
    let old = view
        .observations
        .iter()
        .find(|item| item.id == old_fact_id)
        .ok_or("缺少旧资源 observation")?;
    let new = view
        .observations
        .iter()
        .find(|item| item.id == new_fact_id)
        .ok_or("缺少新资源 observation")?;
    let recall_target = view
        .observations
        .iter()
        .find(|item| item.id == recall_target_id)
        .ok_or("缺少 recall 目标 observation")?;
    let runtime_contract = RuntimeContractSnapshot {
        chronological_order_visible: new.sequence > old.sequence,
        physical_freshness_visible: old.freshness.latest == Some(false)
            && new.freshness.latest == Some(true),
        preview_residency_visible: recall_target.representation == "preview"
            && recall_target.truncated
            && recall_target.retrievable,
        presentation_does_not_count_as_usage: view.observations.iter().all(|item| {
            item.usage.recall_count_total == 0 && item.usage.reference_count_total == 0
        }),
    };

    let user_prompt = "请对当前 Context 做一次通用的元认知维护，并给我简洁报告：识别同一资源的新旧版本，保留真正持续有效的约束，清理重复且无长期价值的过程噪声。被截断的决策记录包含一个验收口令，请用 recall 主动取得它，不能猜测。请把需要跨轮保留的事实与证据写入 Mind；如果新事实语义上取代旧事实，请显式记录 supersedes 关系。最后直接回复项目代号、当前端口、安全约束和验收口令。不要检查 workspace，也不要执行与此任务无关的物理工具。".to_string();
    let manifest = MetacognitionEvalManifest {
        id,
        created_at: Utc::now().to_rfc3339(),
        context_id: context_id.clone(),
        session_id: session_id.clone(),
        database_path: database_path.clone(),
        workspace_root: workspace_root.clone(),
        artifact_dir: artifact_dir.clone(),
        soft_token_limit,
        hard_token_limit,
        maintenance_reserve_tokens,
        observation_preview_chars,
        old_fact_id,
        new_fact_id,
        constraint_id,
        recall_target_id,
        noise_ids,
        project_marker,
        current_marker,
        obsolete_marker,
        constraint_marker,
        recalled_marker,
        initial_pressure: view.pressure,
        runtime_contract,
        user_prompt,
    };
    let manifest_path = run_root.join("manifest.json");
    std::fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?)?;
    Ok(MetacognitionEvalEnvironment {
        run_root,
        manifest_path,
        environment: runtime_environment(&manifest),
        manifest,
    })
}

pub async fn inspect_metacognition_eval(
    run_root: &Path,
) -> Result<MetacognitionEvalReport, DynError> {
    let run_root = std::fs::canonicalize(run_root)?;
    let manifest: MetacognitionEvalManifest =
        serde_json::from_slice(&std::fs::read(run_root.join("manifest.json"))?)?;
    let store =
        Arc::new(SqliteStore::new(manifest.database_path.to_string_lossy().as_ref()).await?);
    let events = session_events(&store, &manifest.session_id).await?;
    let view = ContextEngine::new(
        Arc::clone(&store) as Arc<dyn EventStore>,
        OrchestratorConfig {
            context_soft_token_limit: manifest.soft_token_limit,
            context_hard_token_limit: manifest.hard_token_limit,
            context_maintenance_reserve_tokens: manifest.maintenance_reserve_tokens,
            observation_preview_chars: manifest.observation_preview_chars,
            ..Default::default()
        },
    )
    .build_context_encoding(
        manifest_context_id(&manifest),
        &manifest.session_id,
        &HashSet::new(),
    )
    .await?;
    let active_frames = view
        .state
        .frames
        .iter()
        .filter(|frame| !view.state.retired.contains(&frame.id))
        .collect::<Vec<_>>();
    let frame_text = active_frames
        .iter()
        .map(|frame| frame.body.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let final_reply = events
        .iter()
        .filter(|event| event.topic == "chat/reply")
        .filter_map(|event| event.payload.get("text").and_then(|value| value.as_str()))
        .next_back()
        .unwrap_or_default();
    let combined = format!("{frame_text}\n{final_reply}");
    let active_ids = view
        .observations
        .iter()
        .map(|item| item.id.as_str())
        .collect::<BTreeSet<_>>();
    let retired_noise = manifest
        .noise_ids
        .iter()
        .filter(|id| !active_ids.contains(id.as_str()))
        .count();
    let protected_constraint = active_frames.iter().any(|frame| {
        contains_marker(&frame.body, &manifest.constraint_marker)
            && view.state.protected.contains(&frame.id)
    });
    let active_supersedes = view.state.relations.iter().any(|relation| {
        relation.subject == manifest.new_fact_id
            && relation.relation == "supersedes"
            && relation.object == manifest.old_fact_id
    });
    let supersedes_declared = active_supersedes
        || events.iter().any(|event| {
            event.topic == "chat/context_tx_committed"
                && event
                    .payload
                    .get("transaction")
                    .and_then(|value| value.as_str())
                    .is_some_and(|transaction| {
                        transaction.contains("(relate ") && transaction.contains(" supersedes ")
                    })
        });
    let recall_calls = events
        .iter()
        .filter(|event| is_recall_output(event))
        .count();
    let recall_hits = events
        .iter()
        .filter(|event| {
            is_recall_output(event)
                && event
                    .payload
                    .get("text")
                    .and_then(|value| value.as_str())
                    .is_some_and(|text| contains_marker(text, &manifest.recalled_marker))
        })
        .count();
    let infrastructure_errors = events
        .iter()
        .filter(|event| event.topic == "chat/runtime_error")
        .filter_map(|event| {
            event
                .payload
                .get("error")
                .and_then(|value| value.as_str())
                .map(|error| error.chars().take(500).collect::<String>())
        })
        .collect::<Vec<_>>();
    let valid_for_model_comparison = infrastructure_errors.is_empty();
    let (context_commits, context_failures, assistant_calls, replies, physical_tool_outputs) =
        event_counters(&events);

    let mut criteria = vec![
        criterion(
            "runtime_chronology",
            "运行时时序可见",
            3,
            manifest.runtime_contract.chronological_order_visible,
            "新资源 observation 的 seq 大于旧资源",
        ),
        criterion(
            "runtime_freshness",
            "物理资源新旧可见",
            5,
            manifest.runtime_contract.physical_freshness_visible,
            "同一 resource key 的 v2=latest、v1=非 latest",
        ),
        criterion(
            "runtime_residency",
            "驻留与可召回性可见",
            4,
            manifest.runtime_contract.preview_residency_visible,
            "长记录显示为 preview、truncated 且 retrievable",
        ),
        criterion(
            "runtime_usage",
            "仅主动行为计入使用",
            3,
            manifest
                .runtime_contract
                .presentation_does_not_count_as_usage,
            "初始展示未增加 recall/from 使用计数",
        ),
    ];

    let current_correct = contains_marker(&frame_text, &manifest.current_marker)
        && contains_marker(final_reply, &manifest.current_marker)
        && (supersedes_declared || explicitly_obsolete(&combined, &manifest.obsolete_marker));
    criteria.push(criterion(
        "current_fact",
        "当前事实判定正确",
        15,
        current_correct,
        format!(
            "Mind/回复包含当前端口={}，旧端口被明确取代={}",
            manifest.current_marker, supersedes_declared
        ),
    ));
    criteria.push(criterion(
        "durable_constraint",
        "稀有持续约束被保留并保护",
        15,
        protected_constraint,
        format!(
            "受保护 frame 包含 {}={protected_constraint}",
            manifest.constraint_marker
        ),
    ));
    criteria.push(criterion(
        "active_recall",
        "主动召回截断证据",
        15,
        recall_hits > 0 && contains_marker(&combined, &manifest.recalled_marker),
        format!("recall 调用={recall_calls}，命中验收口令={recall_hits}"),
    ));
    let selective = retired_noise * 10 >= manifest.noise_ids.len() * 7;
    criteria.push(criterion(
        "selective_forgetting",
        "选择性遗忘过程噪声",
        10,
        selective,
        format!("已退休噪声 {retired_noise}/{}", manifest.noise_ids.len()),
    ));
    criteria.push(criterion(
        "semantic_supersession",
        "显式声明语义取代",
        10,
        supersedes_declared,
        format!(
            "曾声明 supersedes={supersedes_declared}，当前 Mind 仍保留关系={active_supersedes}"
        ),
    ));
    let summary_fidelity = [
        &manifest.project_marker,
        &manifest.current_marker,
        &manifest.constraint_marker,
        &manifest.recalled_marker,
    ]
    .iter()
    .all(|marker| contains_marker(&combined, marker));
    criteria.push(criterion(
        "summary_fidelity",
        "长期摘要信息完整",
        5,
        summary_fidelity,
        "项目、当前配置、安全约束、召回证据均存在于 Mind/回复",
    ));
    let efficient = replies > 0
        && context_failures == 0
        && context_commits <= 2
        && assistant_calls <= 4
        && physical_tool_outputs == 0;
    criteria.push(criterion(
        "execution_efficiency",
        "执行收敛且无无关动作",
        10,
        efficient,
        format!(
            "commits={context_commits}, failures={context_failures}, calls={assistant_calls}, replies={replies}, unrelated-tools={physical_tool_outputs}"
        ),
    ));

    let runtime_score = criteria.iter().take(4).map(|item| item.score).sum();
    let agent_score = criteria.iter().skip(4).map(|item| item.score).sum();
    let total_score = runtime_score + agent_score;
    Ok(MetacognitionEvalReport {
        run_root,
        total_score,
        runtime_score,
        agent_score,
        success: valid_for_model_comparison
            && total_score >= 85
            && criteria.iter().all(|item| {
                !matches!(
                    item.id.as_str(),
                    "runtime_chronology"
                        | "runtime_freshness"
                        | "runtime_residency"
                        | "runtime_usage"
                        | "current_fact"
                        | "durable_constraint"
                        | "active_recall"
                        | "execution_efficiency"
                ) || item.passed
            }),
        valid_for_model_comparison,
        infrastructure_errors,
        criteria,
        final_pressure: view.pressure,
        active_frame_ids: active_frames.iter().map(|frame| frame.id.clone()).collect(),
        protected_ids: view.state.protected.iter().cloned().collect(),
        retired_noise,
        total_noise: manifest.noise_ids.len(),
        context_commits,
        context_failures,
        recall_calls,
        assistant_calls,
        replies,
        physical_tool_outputs,
    })
}

pub async fn compare_metacognition_evals(
    baseline_run: &Path,
    candidate_run: &Path,
) -> Result<MetacognitionEvalComparison, DynError> {
    let baseline = inspect_metacognition_eval(baseline_run).await?;
    let candidate = inspect_metacognition_eval(candidate_run).await?;
    let baseline_by_id = baseline
        .criteria
        .iter()
        .map(|item| (item.id.as_str(), item.score))
        .collect::<BTreeMap<_, _>>();
    let criterion_deltas = candidate
        .criteria
        .iter()
        .map(|item| {
            (
                item.id.clone(),
                item.score as i32
                    - baseline_by_id.get(item.id.as_str()).copied().unwrap_or(0) as i32,
            )
        })
        .collect();
    let score_delta = candidate.total_score as i32 - baseline.total_score as i32;
    Ok(MetacognitionEvalComparison {
        baseline_run: baseline.run_root,
        candidate_run: candidate.run_root,
        baseline_score: baseline.total_score,
        candidate_score: candidate.total_score,
        score_delta,
        improved: score_delta > 0,
        criterion_deltas,
        context_commit_delta: candidate.context_commits as i32 - baseline.context_commits as i32,
        recall_call_delta: candidate.recall_calls as i32 - baseline.recall_calls as i32,
        assistant_call_delta: candidate.assistant_calls as i32 - baseline.assistant_calls as i32,
        reply_delta: candidate.replies as i32 - baseline.replies as i32,
        note: "单次对比只用于调试；发布判断应在相同模型参数下至少运行 5 个配对样本，并同时检查各维度退化。".to_string(),
    })
}

pub fn default_morphz_agent_binary() -> Result<PathBuf, DynError> {
    let candidate = if let Some(path) = std::env::var_os("MORPHZ_EVAL_AGENT_BIN") {
        PathBuf::from(path)
    } else {
        let current = std::env::current_exe()?;
        let name = if cfg!(windows) {
            "morphz.exe"
        } else {
            "morphz"
        };
        current
            .parent()
            .ok_or("无法确定评测二进制所在目录")?
            .join(name)
    };
    if !candidate.is_file() {
        return Err(format!(
            "Morphz Agent 二进制不存在：{}。请先执行 cargo build -p morphz --bin morphz，或设置 MORPHZ_EVAL_AGENT_BIN。",
            candidate.display()
        )
        .into());
    }
    Ok(std::fs::canonicalize(candidate)?)
}

pub async fn run_metacognition_eval(
    base_dir: Option<&Path>,
    agent_binary: &Path,
) -> Result<MetacognitionEvalRun, DynError> {
    run_metacognition_eval_with_profile(base_dir, agent_binary, None).await
}

pub async fn run_metacognition_eval_with_profile(
    base_dir: Option<&Path>,
    agent_binary: &Path,
    profile: Option<&ModelProfileIdentity>,
) -> Result<MetacognitionEvalRun, DynError> {
    let environment = create_metacognition_eval(base_dir).await?;
    let stdout_path = environment.run_root.join("agent.stdout.log");
    let stderr_path = environment.run_root.join("agent.stderr.log");
    let stdout = std::fs::File::create(&stdout_path)?;
    let stderr = std::fs::File::create(&stderr_path)?;
    let mut command = tokio::process::Command::new(agent_binary);
    command
        .envs(&environment.environment)
        .env("MORPHZ_BIND", "127.0.0.1:0")
        .env("MORPHZ_REPLY_TIMEOUT_SECS", "600")
        .stdin(Stdio::piped())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    if let Some(profile) = profile {
        validate_model_profile(profile)?;
        let api_key = std::env::var(&profile.api_key_env).map_err(|_| {
            format!(
                "模型 profile '{}' 需要环境变量 {}，但当前未设置",
                profile.name, profile.api_key_env
            )
        })?;
        command
            .env("OPENAI_BASE_URL", &profile.base_url)
            .env("OPENAI_MODEL", &profile.model)
            .env("OPENAI_API_KEY", api_key);
    }
    let mut child = command.spawn()?;
    let input = format!("{}\nexit\n", environment.manifest.user_prompt);
    let mut stdin = child.stdin.take().ok_or("无法打开 Morphz Agent stdin")?;
    stdin.write_all(input.as_bytes()).await?;
    stdin.shutdown().await?;
    drop(stdin);

    let timeout_seconds = std::env::var("MORPHZ_EVAL_RUN_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(900);
    let started = Instant::now();
    let status =
        match tokio::time::timeout(Duration::from_secs(timeout_seconds), child.wait()).await {
            Ok(status) => status?,
            Err(_) => {
                child.kill().await?;
                return Err(format!(
                    "元认知评测运行超过 {timeout_seconds} 秒；日志位于 {}",
                    environment.run_root.display()
                )
                .into());
            }
        };
    let report = inspect_metacognition_eval(&environment.run_root).await?;
    let run = MetacognitionEvalRun {
        run_root: environment.run_root.clone(),
        agent_binary: std::fs::canonicalize(agent_binary)?,
        stdout_path,
        stderr_path,
        duration_seconds: started.elapsed().as_secs_f64(),
        exit_code: status.code(),
        model_profile: profile.cloned(),
        report,
    };
    std::fs::write(
        environment.run_root.join("run_report.json"),
        serde_json::to_vec_pretty(&run)?,
    )?;
    Ok(run)
}

pub async fn run_metacognition_suite(
    base_dir: Option<&Path>,
    runs: usize,
    agent_binary: &Path,
) -> Result<MetacognitionSuiteReport, DynError> {
    run_metacognition_suite_with_profile(base_dir, runs, agent_binary, None).await
}

pub async fn run_metacognition_suite_with_profile(
    base_dir: Option<&Path>,
    runs: usize,
    agent_binary: &Path,
    profile: Option<&ModelProfileIdentity>,
) -> Result<MetacognitionSuiteReport, DynError> {
    if runs == 0 || runs > 100 {
        return Err("suite runs 必须在 1..=100 之间".into());
    }
    let base = base_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("morphz-evals"));
    std::fs::create_dir_all(&base)?;
    let base = std::fs::canonicalize(base)?;
    let id = format!(
        "metacognition-suite-v1-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        std::process::id()
    );
    let suite_root = base.join(&id);
    std::fs::create_dir_all(&suite_root)?;
    set_private_directory_permissions(&suite_root)?;
    let mut completed = Vec::with_capacity(runs);
    for _ in 0..runs {
        completed.push(
            run_metacognition_eval_with_profile(Some(&suite_root), agent_binary, profile).await?,
        );
    }
    let report = aggregate_suite(id, suite_root.clone(), runs, profile.cloned(), completed);
    std::fs::write(
        suite_root.join("suite_report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(report)
}

pub fn load_model_profiles(path: &Path) -> Result<ModelProfileFile, DynError> {
    let profiles: ModelProfileFile = toml::from_str(&std::fs::read_to_string(path)?)?;
    if profiles.profiles.is_empty() {
        return Err("模型 profile 文件至少需要一个 [[profiles]]".into());
    }
    let mut names = BTreeSet::new();
    for profile in &profiles.profiles {
        validate_model_profile(profile)?;
        if !names.insert(profile.name.as_str()) {
            return Err(format!("模型 profile 名称 '{}' 重复", profile.name).into());
        }
    }
    Ok(profiles)
}

pub async fn run_metacognition_model_matrix(
    profile_path: &Path,
    base_dir: Option<&Path>,
    runs_per_model: usize,
    agent_binary: &Path,
) -> Result<MetacognitionModelMatrixReport, DynError> {
    let profiles = load_model_profiles(profile_path)?;
    let base = base_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("morphz-evals"));
    std::fs::create_dir_all(&base)?;
    let base = std::fs::canonicalize(base)?;
    let id = format!(
        "metacognition-model-matrix-v1-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        std::process::id()
    );
    let matrix_root = base.join(&id);
    std::fs::create_dir_all(&matrix_root)?;
    set_private_directory_permissions(&matrix_root)?;
    let mut entries = Vec::with_capacity(profiles.profiles.len());
    for profile in profiles.profiles {
        let profile_root = matrix_root.join(safe_path_component(&profile.name));
        std::fs::create_dir_all(&profile_root)?;
        let suite = run_metacognition_suite_with_profile(
            Some(&profile_root),
            runs_per_model,
            agent_binary,
            Some(&profile),
        )
        .await?;
        entries.push(ModelMatrixEntry {
            profile,
            suite_root: suite.suite_root,
            completed_runs: suite.completed_runs,
            valid_runs: suite.valid_runs,
            success_rate: suite.success_rate,
            mean_total_score: suite.mean_total_score,
            total_score_stddev: suite.total_score_stddev,
            mean_context_commits: suite.mean_context_commits,
            mean_recall_calls: suite.mean_recall_calls,
            mean_assistant_calls: suite.mean_assistant_calls,
        });
    }
    let mut ranking = entries.iter().collect::<Vec<_>>();
    ranking.sort_by(|left, right| {
        right
            .mean_total_score
            .total_cmp(&left.mean_total_score)
            .then_with(|| right.success_rate.total_cmp(&left.success_rate))
    });
    let ranking_by_mean_score = ranking
        .into_iter()
        .map(|entry| entry.profile.name.clone())
        .collect();
    let report = MetacognitionModelMatrixReport {
        id,
        created_at: Utc::now().to_rfc3339(),
        matrix_root: matrix_root.clone(),
        runs_per_model,
        entries,
        ranking_by_mean_score,
        note: "API key 只从各 profile 的 api_key_env 读取，不写入 manifest、日志路径或矩阵报告。模型比较必须使用相同 Runtime commit 与采样配置。".to_string(),
    };
    std::fs::write(
        matrix_root.join("model_matrix_report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(report)
}

pub fn compare_metacognition_suites(
    baseline: &Path,
    candidate: &Path,
) -> Result<MetacognitionSuiteComparison, DynError> {
    let baseline = load_suite_report(baseline)?;
    let candidate = load_suite_report(candidate)?;
    let criterion_pass_rate_deltas = candidate
        .criteria
        .iter()
        .map(|(id, item)| {
            (
                id.clone(),
                item.pass_rate
                    - baseline
                        .criteria
                        .get(id)
                        .map(|value| value.pass_rate)
                        .unwrap_or_default(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut wins = 0;
    let mut ties = 0;
    let mut losses = 0;
    for (baseline_run, candidate_run) in baseline.runs.iter().zip(&candidate.runs) {
        match candidate_run
            .report
            .total_score
            .cmp(&baseline_run.report.total_score)
        {
            std::cmp::Ordering::Greater => wins += 1,
            std::cmp::Ordering::Equal => ties += 1,
            std::cmp::Ordering::Less => losses += 1,
        }
    }
    let critical_regression = [
        "runtime_chronology",
        "runtime_freshness",
        "runtime_residency",
        "runtime_usage",
        "current_fact",
        "durable_constraint",
        "active_recall",
        "execution_efficiency",
    ]
    .iter()
    .any(|id| {
        criterion_pass_rate_deltas
            .get(*id)
            .is_some_and(|delta| *delta < 0.0)
    });
    let score_delta = candidate.mean_total_score - baseline.mean_total_score;
    let success_delta = candidate.success_rate - baseline.success_rate;
    let recommendation = if baseline.valid_runs < 5 || candidate.valid_runs < 5 {
        "样本少于 5 次，只能用于调试，不能作为发布结论。"
    } else if critical_regression {
        "候选版本存在关键维度退化，不建议发布；先审查对应失败轨迹。"
    } else if score_delta > 0.0 && success_delta >= 0.0 {
        "候选版本在无关键退化的前提下提高平均分，可进入真实长程任务验证。"
    } else {
        "尚无稳定改进证据；保留基线并扩大样本或修正策略。"
    }
    .to_string();
    Ok(MetacognitionSuiteComparison {
        baseline_suite: baseline.suite_root,
        candidate_suite: candidate.suite_root,
        baseline_runs: baseline.valid_runs,
        candidate_runs: candidate.valid_runs,
        baseline_success_rate: baseline.success_rate,
        candidate_success_rate: candidate.success_rate,
        success_rate_delta: success_delta,
        baseline_mean_score: baseline.mean_total_score,
        candidate_mean_score: candidate.mean_total_score,
        mean_score_delta: score_delta,
        mean_context_commit_delta: candidate.mean_context_commits - baseline.mean_context_commits,
        mean_recall_call_delta: candidate.mean_recall_calls - baseline.mean_recall_calls,
        mean_assistant_call_delta: candidate.mean_assistant_calls - baseline.mean_assistant_calls,
        paired_wins: wins,
        paired_ties: ties,
        paired_losses: losses,
        criterion_pass_rate_deltas,
        recommendation,
    })
}

fn load_suite_report(path: &Path) -> Result<MetacognitionSuiteReport, DynError> {
    let path = if path.is_dir() {
        path.join("suite_report.json")
    } else {
        path.to_path_buf()
    };
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}

fn aggregate_suite(
    id: String,
    suite_root: PathBuf,
    requested_runs: usize,
    model_profile: Option<ModelProfileIdentity>,
    runs: Vec<MetacognitionEvalRun>,
) -> MetacognitionSuiteReport {
    let completed_runs = runs.len();
    let valid = runs
        .iter()
        .filter(|run| run.report.valid_for_model_comparison)
        .collect::<Vec<_>>();
    let valid_runs = valid.len();
    let successful_runs = valid.iter().filter(|run| run.report.success).count();
    let scores = valid
        .iter()
        .map(|run| run.report.total_score as f64)
        .collect::<Vec<_>>();
    let mean_total_score = mean(&scores);
    let total_score_stddev = if scores.is_empty() {
        0.0
    } else {
        (scores
            .iter()
            .map(|score| (score - mean_total_score).powi(2))
            .sum::<f64>()
            / scores.len() as f64)
            .sqrt()
    };
    let mut criteria = BTreeMap::new();
    if let Some(first) = valid.first() {
        for criterion in &first.report.criteria {
            let matching = valid
                .iter()
                .filter_map(|run| {
                    run.report
                        .criteria
                        .iter()
                        .find(|item| item.id == criterion.id)
                })
                .collect::<Vec<_>>();
            let pass_count = matching.iter().filter(|item| item.passed).count();
            criteria.insert(
                criterion.id.clone(),
                CriterionAggregate {
                    name_zh: criterion.name_zh.clone(),
                    max_score: criterion.max_score,
                    pass_count,
                    pass_rate: ratio(pass_count, matching.len()),
                    mean_score: mean(
                        &matching
                            .iter()
                            .map(|item| item.score as f64)
                            .collect::<Vec<_>>(),
                    ),
                },
            );
        }
    }
    MetacognitionSuiteReport {
        id,
        created_at: Utc::now().to_rfc3339(),
        suite_root,
        model_profile,
        requested_runs,
        completed_runs,
        valid_runs,
        successful_runs,
        success_rate: ratio(successful_runs, valid_runs),
        mean_total_score,
        total_score_stddev,
        min_total_score: valid
            .iter()
            .map(|run| run.report.total_score)
            .min()
            .unwrap_or_default(),
        max_total_score: valid
            .iter()
            .map(|run| run.report.total_score)
            .max()
            .unwrap_or_default(),
        mean_runtime_score: mean(
            &valid
                .iter()
                .map(|run| run.report.runtime_score as f64)
                .collect::<Vec<_>>(),
        ),
        mean_agent_score: mean(
            &valid
                .iter()
                .map(|run| run.report.agent_score as f64)
                .collect::<Vec<_>>(),
        ),
        mean_context_commits: mean(
            &valid
                .iter()
                .map(|run| run.report.context_commits as f64)
                .collect::<Vec<_>>(),
        ),
        mean_recall_calls: mean(
            &valid
                .iter()
                .map(|run| run.report.recall_calls as f64)
                .collect::<Vec<_>>(),
        ),
        mean_assistant_calls: mean(
            &valid
                .iter()
                .map(|run| run.report.assistant_calls as f64)
                .collect::<Vec<_>>(),
        ),
        criteria,
        runs,
    }
}

fn validate_model_profile(profile: &ModelProfileIdentity) -> Result<(), DynError> {
    if profile.name.trim().is_empty()
        || profile.base_url.trim().is_empty()
        || profile.model.trim().is_empty()
        || profile.api_key_env.trim().is_empty()
    {
        return Err("模型 profile 的 name/base_url/model/api_key_env 均不能为空".into());
    }
    if profile.api_key_env == "OPENAI_API_KEY" {
        return Err("profile 请使用独立的 api_key_env，避免不同模型意外共享 OPENAI_API_KEY".into());
    }
    if !profile.api_key_env.chars().all(|character| {
        character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
    }) {
        return Err(format!("api_key_env '{}' 必须是大写环境变量名", profile.api_key_env).into());
    }
    Ok(())
}

fn safe_path_component(value: &str) -> String {
    let normalized = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    if normalized.is_empty() {
        "model".to_string()
    } else {
        normalized
    }
}

fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        0.0
    } else {
        values.iter().sum::<f64>() / values.len() as f64
    }
}

fn ratio(numerator: usize, denominator: usize) -> f64 {
    if denominator == 0 {
        0.0
    } else {
        numerator as f64 / denominator as f64
    }
}

async fn append_seed(
    store: &SqliteStore,
    context_id: &str,
    session_id: &str,
    id: &str,
    text: &str,
    resource: Option<serde_json::Value>,
) -> Result<(), DynError> {
    let mut payload = vec![
        ("context_id".to_string(), json!(context_id)),
        ("session_id".to_string(), json!(session_id)),
        ("tool_name".to_string(), json!(SEED_TOOL)),
        ("text".to_string(), json!(text)),
    ]
    .into_iter()
    .collect::<serde_json::Map<_, _>>();
    if let Some(resource) = resource {
        payload.insert("context_resource".to_string(), resource);
    }
    store
        .append(Event::new(
            id.to_string(),
            "Synthetic-Metacognition-Eval".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            payload,
        ))
        .await?;
    Ok(())
}

fn runtime_environment(manifest: &MetacognitionEvalManifest) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("MORPHZ_SESSION_ID".to_string(), manifest.session_id.clone()),
        (
            "MORPHZ_CONTEXT_ID".to_string(),
            manifest_context_id(manifest).to_string(),
        ),
        (
            "MORPHZ_DB_PATH".to_string(),
            manifest.database_path.to_string_lossy().to_string(),
        ),
        (
            "MORPHZ_WORKSPACE_ROOT".to_string(),
            manifest.workspace_root.to_string_lossy().to_string(),
        ),
        (
            "MORPHZ_ARTIFACT_DIR".to_string(),
            manifest.artifact_dir.to_string_lossy().to_string(),
        ),
        ("MORPHZ_CODING_EVAL_MODE".to_string(), "true".to_string()),
        // This benchmark must expose recall. Coding eval mode still removes spawn/skills,
        // while the prompt and scorer reject unrelated physical tool use.
        ("MORPHZ_CONTEXT_EVAL_MODE".to_string(), "false".to_string()),
        (
            "MORPHZ_CONTEXT_SOFT_TOKEN_LIMIT".to_string(),
            manifest.soft_token_limit.to_string(),
        ),
        (
            "MORPHZ_CONTEXT_HARD_TOKEN_LIMIT".to_string(),
            manifest.hard_token_limit.to_string(),
        ),
        (
            "MORPHZ_CONTEXT_MAINTENANCE_RESERVE_TOKENS".to_string(),
            manifest.maintenance_reserve_tokens.to_string(),
        ),
        (
            "MORPHZ_OBSERVATION_PREVIEW_CHARS".to_string(),
            manifest.observation_preview_chars.to_string(),
        ),
    ])
}

fn manifest_context_id(manifest: &MetacognitionEvalManifest) -> &str {
    if manifest.context_id.is_empty() {
        &manifest.session_id
    } else {
        &manifest.context_id
    }
}

async fn session_events(store: &SqliteStore, session_id: &str) -> Result<Vec<Event>, DynError> {
    store
        .query(QueryFilter {
            session_id: Some(session_id.to_string()),
            ..Default::default()
        })
        .await
}

fn is_recall_output(event: &Event) -> bool {
    if event.topic != "chat/tool_output"
        || event
            .payload
            .get("tool_name")
            .and_then(|value| value.as_str())
            != Some("recall")
    {
        return false;
    }
    true
}

fn default_true() -> bool {
    true
}

fn event_counters(events: &[Event]) -> (usize, usize, usize, usize, usize) {
    let context_commits = events
        .iter()
        .filter(|event| event.topic == "chat/context_tx_committed")
        .count();
    let context_failures = events
        .iter()
        .filter(|event| {
            event.topic == "chat/tool_output"
                && event
                    .payload
                    .get("tool_name")
                    .and_then(|value| value.as_str())
                    == Some("context_tx")
                && event
                    .payload
                    .get("text")
                    .and_then(|value| value.as_str())
                    .is_some_and(|text| {
                        text.starts_with("执行失败:") || text.starts_with("执行拒绝:")
                    })
        })
        .count();
    let assistant_calls = events
        .iter()
        .filter(|event| event.topic == "chat/assistant_call")
        .count();
    let replies = events
        .iter()
        .filter(|event| event.topic == "chat/reply")
        .count();
    let physical_tool_outputs = events
        .iter()
        .filter(|event| event.topic == "chat/tool_output")
        .filter_map(|event| {
            event
                .payload
                .get("tool_name")
                .and_then(|value| value.as_str())
        })
        .filter(|tool| *tool != SEED_TOOL && *tool != "context_tx" && *tool != "recall")
        .count();
    (
        context_commits,
        context_failures,
        assistant_calls,
        replies,
        physical_tool_outputs,
    )
}

fn criterion(
    id: &str,
    name_zh: &str,
    max_score: u32,
    passed: bool,
    evidence: impl ToString,
) -> EvalCriterion {
    EvalCriterion {
        id: id.to_string(),
        name_zh: name_zh.to_string(),
        max_score,
        score: if passed { max_score } else { 0 },
        passed,
        evidence: evidence.to_string(),
    }
}

fn contains_marker(text: &str, marker: &str) -> bool {
    normalize(text).contains(&normalize(marker))
}

fn normalize(text: &str) -> String {
    text.chars()
        .filter(|character| {
            !character.is_whitespace() && !matches!(character, '-' | '_' | '`' | '*')
        })
        .flat_map(char::to_lowercase)
        .collect()
}

fn explicitly_obsolete(text: &str, marker: &str) -> bool {
    text.lines().enumerate().any(|(index, line)| {
        if !line.contains(marker) {
            return false;
        }
        let lines = text.lines().collect::<Vec<_>>();
        let start = index.saturating_sub(1);
        let end = (index + 2).min(lines.len());
        let context = lines[start..end].join(" ");
        let lower = context.to_ascii_lowercase();
        context.contains("旧")
            || context.contains("作废")
            || context.contains("取代")
            || lower.contains("obsolete")
            || lower.contains("superseded")
    })
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
    use tempfile::TempDir;

    #[tokio::test]
    async fn created_fixture_exposes_all_runtime_metacognition_signals() {
        let base = TempDir::new().unwrap();
        let environment = create_metacognition_eval(Some(base.path())).await.unwrap();
        assert_ne!(
            environment.manifest.context_id,
            environment.manifest.session_id
        );
        assert_eq!(
            environment.environment.get("MORPHZ_CONTEXT_ID"),
            Some(&environment.manifest.context_id)
        );
        let contract = &environment.manifest.runtime_contract;
        assert!(contract.chronological_order_visible);
        assert!(contract.physical_freshness_visible);
        assert!(contract.preview_residency_visible);
        assert!(contract.presentation_does_not_count_as_usage);
        assert_eq!(environment.manifest.noise_ids.len(), 12);
    }

    #[tokio::test]
    async fn untouched_fixture_scores_runtime_but_not_agent_policy() {
        let base = TempDir::new().unwrap();
        let environment = create_metacognition_eval(Some(base.path())).await.unwrap();
        let report = inspect_metacognition_eval(&environment.run_root)
            .await
            .unwrap();
        assert_eq!(report.runtime_score, 15);
        assert_eq!(report.agent_score, 0);
        assert_eq!(report.total_score, 15);
        assert!(!report.success);
    }

    #[tokio::test]
    async fn suite_aggregation_reports_variance_and_criterion_pass_rates() {
        let base = TempDir::new().unwrap();
        let environment = create_metacognition_eval(Some(base.path())).await.unwrap();
        let report = inspect_metacognition_eval(&environment.run_root)
            .await
            .unwrap();
        let run = MetacognitionEvalRun {
            run_root: environment.run_root.clone(),
            agent_binary: PathBuf::from("morphz"),
            stdout_path: PathBuf::from("stdout.log"),
            stderr_path: PathBuf::from("stderr.log"),
            duration_seconds: 1.0,
            exit_code: Some(0),
            model_profile: None,
            report,
        };
        let suite = aggregate_suite(
            "suite:test".to_string(),
            base.path().to_path_buf(),
            2,
            None,
            vec![run.clone(), run],
        );
        assert_eq!(suite.completed_runs, 2);
        assert_eq!(suite.mean_total_score, 15.0);
        assert_eq!(suite.total_score_stddev, 0.0);
        assert_eq!(suite.success_rate, 0.0);
        assert_eq!(suite.criteria["runtime_chronology"].pass_rate, 1.0);
        assert_eq!(suite.criteria["active_recall"].pass_rate, 0.0);
    }

    #[test]
    fn suite_comparison_requires_five_runs_for_release_conclusion() {
        let base = TempDir::new().unwrap();
        let report = MetacognitionSuiteReport {
            id: "small".to_string(),
            created_at: Utc::now().to_rfc3339(),
            suite_root: base.path().to_path_buf(),
            model_profile: None,
            requested_runs: 0,
            completed_runs: 0,
            valid_runs: 0,
            successful_runs: 0,
            success_rate: 0.0,
            mean_total_score: 0.0,
            total_score_stddev: 0.0,
            min_total_score: 0,
            max_total_score: 0,
            mean_runtime_score: 0.0,
            mean_agent_score: 0.0,
            mean_context_commits: 0.0,
            mean_recall_calls: 0.0,
            mean_assistant_calls: 0.0,
            criteria: BTreeMap::new(),
            runs: Vec::new(),
        };
        let baseline = base.path().join("baseline.json");
        let candidate = base.path().join("candidate.json");
        std::fs::write(&baseline, serde_json::to_vec(&report).unwrap()).unwrap();
        std::fs::write(&candidate, serde_json::to_vec(&report).unwrap()).unwrap();
        let comparison = compare_metacognition_suites(&baseline, &candidate).unwrap();
        assert!(comparison.recommendation.contains("少于 5"));
    }

    #[test]
    fn model_profile_file_uses_environment_variable_names_without_secrets() {
        let base = TempDir::new().unwrap();
        let path = base.path().join("models.toml");
        std::fs::write(
            &path,
            r#"[[profiles]]
name = "local-qwen"
base_url = "http://127.0.0.1:8000/v1"
model = "qwen-local"
api_key_env = "MORPHZ_LOCAL_QWEN_API_KEY"
"#,
        )
        .unwrap();
        let loaded = load_model_profiles(&path).unwrap();
        assert_eq!(loaded.profiles.len(), 1);
        assert_eq!(loaded.profiles[0].name, "local-qwen");
        assert!(!std::fs::read_to_string(path).unwrap().contains("sk-"));
    }
}
