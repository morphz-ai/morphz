use crate::config::OrchestratorConfig;
use crate::event::{Event, TYPE_TOOL_OUTPUT};
use crate::memory::sqlite::SqliteStore;
use crate::memory::{EventStore, QueryFilter};
use crate::orchestrator::context::{ContextEngine, ContextPressure};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

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
        &session_id,
        &old_fact_id,
        "早期配置快照：AURORA-27 的服务端口为 8080。这是资源 service-port 的 v1 版本。",
        Some(json!({"kind":"configuration", "key":"service-port", "version":"v1"})),
    )
    .await?;
    append_seed(
        &store,
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
    append_seed(&store, &session_id, &recall_target_id, &hidden_record, None).await?;
    append_seed(
        &store,
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
        .build_view(&session_id)
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
    .build_view(&manifest.session_id)
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
        .filter(|event| recalled_event_id(event).as_deref() == Some(&manifest.recall_target_id))
        .count();
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
        protected_constraint && contains_marker(final_reply, &manifest.constraint_marker),
        format!(
            "受保护 frame 包含 {}={protected_constraint}",
            manifest.constraint_marker
        ),
    ));
    criteria.push(criterion(
        "active_recall",
        "主动召回截断证据",
        15,
        recall_calls > 0 && contains_marker(&combined, &manifest.recalled_marker),
        format!("正确 recall 次数={recall_calls}，验收口令已进入结果"),
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
        success: total_score >= 85
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

async fn append_seed(
    store: &SqliteStore,
    session_id: &str,
    id: &str,
    text: &str,
    resource: Option<serde_json::Value>,
) -> Result<(), DynError> {
    let mut payload = vec![
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

async fn session_events(store: &SqliteStore, session_id: &str) -> Result<Vec<Event>, DynError> {
    store
        .query(QueryFilter {
            session_id: Some(session_id.to_string()),
            ..Default::default()
        })
        .await
}

fn recalled_event_id(event: &Event) -> Option<String> {
    if event.topic != "chat/tool_output"
        || event
            .payload
            .get("tool_name")
            .and_then(|value| value.as_str())
            != Some("recall")
    {
        return None;
    }
    event
        .payload
        .get("text")
        .and_then(|value| value.as_str())
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        .and_then(|value| value.get("event_id")?.as_str().map(ToOwned::to_owned))
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
}
