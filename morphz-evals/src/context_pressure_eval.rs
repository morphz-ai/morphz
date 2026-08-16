use chrono::Utc;
use morphz::config::OrchestratorConfig;
use morphz::event::{Event, TYPE_TOOL_OUTPUT};
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{EventStore, QueryFilter};
use morphz::orchestrator::context::{ContextEngine, ContextPressure};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

type DynError = Box<dyn std::error::Error + Send + Sync>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextPressureEvalManifest {
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
    pub seed_observation_ids: Vec<String>,
    pub expected_markers: Vec<String>,
    pub initial_pressure: ContextPressure,
    pub user_prompt: String,
    #[serde(default = "default_pressure_scenario")]
    pub scenario: String,
    #[serde(default)]
    pub seed_frame_ids: Vec<String>,
    #[serde(default)]
    pub preserve_frame_ids: Vec<String>,
    #[serde(default)]
    pub baseline_context_commits: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ContextPressureEvalEnvironment {
    pub run_root: PathBuf,
    pub manifest_path: PathBuf,
    pub manifest: ContextPressureEvalManifest,
    pub environment: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ContextPressureEvalReport {
    pub run_root: PathBuf,
    pub initial_pressure: ContextPressure,
    pub final_pressure: ContextPressure,
    pub estimated_token_reduction: isize,
    pub compression_ratio: f64,
    pub seeded_observations: usize,
    pub retired_seed_observations: usize,
    pub active_seed_observations: usize,
    pub active_frame_ids: Vec<String>,
    pub protected_ids: Vec<String>,
    pub expected_markers: Vec<String>,
    pub missing_markers: Vec<String>,
    pub context_commits: usize,
    pub model_context_commits: usize,
    pub context_failures: usize,
    pub replies: usize,
    pub scenario: String,
    pub active_seed_frame_ids: Vec<String>,
    pub retired_seed_frame_ids: Vec<String>,
    pub new_frame_ids: Vec<String>,
    pub revised_seed_frame_ids: Vec<String>,
    pub supersedes_relations: usize,
    pub preserved_required_frames: bool,
    pub semantic_frame_maintenance: bool,
    pub success: bool,
}

pub async fn create_context_pressure_eval(
    base_dir: Option<&Path>,
) -> Result<ContextPressureEvalEnvironment, DynError> {
    let base = base_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("morphz-evals"));
    std::fs::create_dir_all(&base)?;
    let base = std::fs::canonicalize(base)?;
    let id = format!(
        "context-pressure-v1-{}-{}",
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
    let session_id = format!("pressure-{id}");
    let context_id = format!("context-{id}");
    let store = Arc::new(SqliteStore::new(database_path.to_string_lossy().as_ref()).await?);
    let seed = synthetic_long_running_history();
    let mut seed_observation_ids = Vec::with_capacity(seed.len());
    for (index, text) in seed.into_iter().enumerate() {
        let event_id = format!("pressure-observation-{index:03}");
        seed_observation_ids.push(event_id.clone());
        store
            .append(Event::new(
                event_id,
                "Synthetic-LongRunning-Agent".to_string(),
                TYPE_TOOL_OUTPUT.to_string(),
                "chat/tool_output".to_string(),
                vec![
                    ("context_id".to_string(), json!(context_id)),
                    ("session_id".to_string(), json!(session_id)),
                    ("tool_name".to_string(), json!("synthetic_history")),
                    ("text".to_string(), json!(text)),
                ]
                .into_iter()
                .collect(),
            ))
            .await?;
    }

    let soft_token_limit = 6_000;
    let hard_token_limit = 9_000;
    let maintenance_reserve_tokens = 2_500;
    let observation_preview_chars = 800;
    let config = OrchestratorConfig {
        context_soft_token_limit: soft_token_limit,
        context_hard_token_limit: hard_token_limit,
        context_maintenance_reserve_tokens: maintenance_reserve_tokens,
        observation_preview_chars,
        ..Default::default()
    };
    let engine = ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config);
    let initial_pressure = engine
        .build_context_encoding(&context_id, &session_id, &HashSet::new())
        .await?
        .pressure;
    if initial_pressure.level != "critical" {
        return Err(format!(
            "合成 Context 未达到 critical：tokens={} level={}",
            initial_pressure.estimated_tokens, initial_pressure.level
        )
        .into());
    }

    let manifest_path = run_root.join("manifest.json");
    let expected_markers = vec![
        "ORBIT-7".to_string(),
        "9090".to_string(),
        "30天".to_string(),
        "SQLite WAL".to_string(),
    ];
    let manifest = ContextPressureEvalManifest {
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
        seed_observation_ids,
        expected_markers,
        initial_pressure,
        user_prompt: "继续这个长期项目：请基于已有信息准备进入下一阶段，并告诉我当前最重要的状态。"
            .to_string(),
        scenario: default_pressure_scenario(),
        seed_frame_ids: Vec::new(),
        preserve_frame_ids: Vec::new(),
        baseline_context_commits: 0,
    };
    std::fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?)?;

    let environment = BTreeMap::from([
        ("MORPHZ_SESSION_ID".to_string(), session_id),
        ("MORPHZ_CONTEXT_ID".to_string(), context_id),
        (
            "MORPHZ_STORAGE_SQLITE_PATH".to_string(),
            database_path.to_string_lossy().to_string(),
        ),
        (
            "MORPHZ_WORKSPACE_ROOT".to_string(),
            workspace_root.to_string_lossy().to_string(),
        ),
        (
            "MORPHZ_ARTIFACT_DIR".to_string(),
            artifact_dir.to_string_lossy().to_string(),
        ),
        ("MORPHZ_CODING_EVAL_MODE".to_string(), "true".to_string()),
        ("MORPHZ_CONTEXT_EVAL_MODE".to_string(), "true".to_string()),
        (
            "MORPHZ_CONTEXT_SOFT_TOKEN_LIMIT".to_string(),
            soft_token_limit.to_string(),
        ),
        (
            "MORPHZ_CONTEXT_HARD_TOKEN_LIMIT".to_string(),
            hard_token_limit.to_string(),
        ),
        (
            "MORPHZ_CONTEXT_MAINTENANCE_RESERVE_TOKENS".to_string(),
            maintenance_reserve_tokens.to_string(),
        ),
        (
            "MORPHZ_OBSERVATION_PREVIEW_CHARS".to_string(),
            observation_preview_chars.to_string(),
        ),
    ]);
    Ok(ContextPressureEvalEnvironment {
        run_root,
        manifest_path,
        manifest,
        environment,
    })
}

pub async fn create_frame_value_eval(
    base_dir: Option<&Path>,
) -> Result<ContextPressureEvalEnvironment, DynError> {
    let mut environment = create_context_pressure_eval(base_dir).await?;
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
    let config = pressure_config(&environment.manifest);
    let engine = ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config);
    let durable_detail = (0..48)
        .map(|index| {
            format!(
                "约束-{index:02}：该控制面设计负责租约 fencing、幂等交付、因果顺序和崩溃恢复；内容较长不代表价值较低。"
            )
        })
        .collect::<Vec<_>>()
        .join("");
    let transaction = format!(
        "(context-tx (base-version 0) (reason \"seed frame value policy evaluation\") \
         (create durable-control-plane (identity DURABLE-CONTROL-PLANE) (priority long-lived-critical) (details {})) \
         (create old-route (port 8080) (status obsolete-small-note)) \
         (create current-route (port 9090) (status CURRENT-ROUTE-AUTHORITATIVE)) \
         (relate current-route supersedes old-route))",
        sexpr_string(&durable_detail)
    );
    engine
        .apply_context_transaction(
            &environment.manifest.context_id,
            &environment.manifest.session_id,
            &transaction,
        )
        .await?;
    let view = engine
        .build_context_encoding(
            &environment.manifest.context_id,
            &environment.manifest.session_id,
            &HashSet::new(),
        )
        .await?;
    if view.pressure.level != "critical" {
        return Err(format!(
            "Frame value 场景未达到 critical：tokens={} level={}",
            view.pressure.estimated_tokens, view.pressure.level
        )
        .into());
    }
    environment.manifest.scenario = "frame-value".to_string();
    environment.manifest.initial_pressure = view.pressure;
    environment.manifest.seed_frame_ids = vec![
        "durable-control-plane".to_string(),
        "old-route".to_string(),
        "current-route".to_string(),
    ];
    environment.manifest.preserve_frame_ids = vec![
        "durable-control-plane".to_string(),
        "current-route".to_string(),
    ];
    environment.manifest.baseline_context_commits = 1;
    environment.manifest.expected_markers.extend([
        "DURABLE-CONTROL-PLANE".to_string(),
        "CURRENT-ROUTE-AUTHORITATIVE".to_string(),
    ]);
    environment.manifest.user_prompt = "继续当前项目，并简要告诉我目前最重要的状态。".to_string();
    persist_manifest(&environment)?;
    Ok(environment)
}

pub async fn create_frame_consolidation_eval(
    base_dir: Option<&Path>,
) -> Result<ContextPressureEvalEnvironment, DynError> {
    let mut environment = create_context_pressure_eval(base_dir).await?;
    environment.manifest.soft_token_limit = 3_500;
    environment.manifest.hard_token_limit = 5_000;
    environment.manifest.maintenance_reserve_tokens = 1_500;
    for (key, value) in [
        ("MORPHZ_CONTEXT_SOFT_TOKEN_LIMIT", "3500"),
        ("MORPHZ_CONTEXT_HARD_TOKEN_LIMIT", "5000"),
        ("MORPHZ_CONTEXT_MAINTENANCE_RESERVE_TOKENS", "1500"),
    ] {
        environment
            .environment
            .insert(key.to_string(), value.to_string());
    }
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
    let engine = ContextEngine::new(
        Arc::clone(&store) as Arc<dyn EventStore>,
        pressure_config(&environment.manifest),
    );
    let mut operations = Vec::new();
    let durable_detail = (0..24)
        .map(|index| format!("长期边界-{index:02}：用户数据不得越权披露，审计证据必须可追溯。"))
        .collect::<Vec<_>>()
        .join("");
    operations.push(format!(
        "(create durable-user-boundary (identity DURABLE-USER-BOUNDARY) (details {}))",
        sexpr_string(&durable_detail)
    ));
    for index in 0..6 {
        let detail = repeated_case_detail(
            index,
            "VERIFY-BEFORE-RETRY",
            "工具结果未知时先读取权威状态，确认失败后才允许重试，避免重复副作用",
        );
        operations.push(format!(
            "(create retry-case-{index:02} (case retry-{index:02}) (principle VERIFY-BEFORE-RETRY) (details {}))",
            sexpr_string(&detail)
        ));
    }
    for index in 0..6 {
        let detail = repeated_case_detail(
            index,
            "LATEST-STATE-WINS",
            "同一资源发生明确取代时保留最新权威状态，并用 supersedes 维持旧结论的证据血缘",
        );
        operations.push(format!(
            "(create freshness-case-{index:02} (case freshness-{index:02}) (principle LATEST-STATE-WINS) (details {}))",
            sexpr_string(&detail)
        ));
    }
    let retired_observations = environment.manifest.seed_observation_ids.join(" ");
    let transaction = format!(
        "(context-tx (base-version 0) (reason \"seed frame consolidation evaluation\") {} (retire {}))",
        operations.join(" "),
        retired_observations
    );
    engine
        .apply_context_transaction(
            &environment.manifest.context_id,
            &environment.manifest.session_id,
            &transaction,
        )
        .await?;
    let view = engine
        .build_context_encoding(
            &environment.manifest.context_id,
            &environment.manifest.session_id,
            &HashSet::new(),
        )
        .await?;
    if view.pressure.level != "critical" {
        return Err(format!(
            "Frame consolidation 场景未达到 critical：tokens={} level={}",
            view.pressure.estimated_tokens, view.pressure.level
        )
        .into());
    }
    environment.manifest.scenario = "frame-consolidation".to_string();
    environment.manifest.initial_pressure = view.pressure;
    environment.manifest.seed_frame_ids = std::iter::once("durable-user-boundary".to_string())
        .chain((0..6).map(|index| format!("retry-case-{index:02}")))
        .chain((0..6).map(|index| format!("freshness-case-{index:02}")))
        .collect();
    environment.manifest.preserve_frame_ids = vec!["durable-user-boundary".to_string()];
    environment.manifest.baseline_context_commits = 1;
    environment.manifest.expected_markers = vec![
        "DURABLE-USER-BOUNDARY".to_string(),
        "VERIFY-BEFORE-RETRY".to_string(),
        "LATEST-STATE-WINS".to_string(),
    ];
    environment.manifest.user_prompt = "继续当前项目，并简要告诉我目前最重要的状态。".to_string();
    persist_manifest(&environment)?;
    Ok(environment)
}

pub async fn inspect_context_pressure_eval(
    run_root: &Path,
) -> Result<ContextPressureEvalReport, DynError> {
    let run_root = std::fs::canonicalize(run_root)?;
    let manifest: ContextPressureEvalManifest =
        serde_json::from_slice(&std::fs::read(run_root.join("manifest.json"))?)?;
    let store =
        Arc::new(SqliteStore::new(manifest.database_path.to_string_lossy().as_ref()).await?);
    let config = OrchestratorConfig {
        context_soft_token_limit: manifest.soft_token_limit,
        context_hard_token_limit: manifest.hard_token_limit,
        context_maintenance_reserve_tokens: manifest.maintenance_reserve_tokens,
        observation_preview_chars: manifest.observation_preview_chars,
        ..Default::default()
    };
    let engine = ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config);
    let context_id = manifest_context_id(&manifest);
    let view = engine
        .build_context_encoding(context_id, &manifest.session_id, &HashSet::new())
        .await?;
    let active_observation_ids = view
        .observations
        .iter()
        .map(|observation| observation.id.as_str())
        .collect::<BTreeSet<_>>();
    let active_seed_observations = manifest
        .seed_observation_ids
        .iter()
        .filter(|id| active_observation_ids.contains(id.as_str()))
        .count();
    let retired_seed_observations = manifest
        .seed_observation_ids
        .len()
        .saturating_sub(active_seed_observations);
    let frame_text = view
        .state
        .frames
        .iter()
        .filter(|frame| !view.state.retired.contains(&frame.id))
        .map(|frame| frame.body.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let missing_markers = manifest
        .expected_markers
        .iter()
        .filter(|marker| !semantic_marker_present(&frame_text, marker))
        .cloned()
        .collect::<Vec<_>>();
    let events = store
        .query(QueryFilter {
            session_id: Some(manifest.session_id.clone()),
            ..Default::default()
        })
        .await?;
    let context_commits = events
        .iter()
        .filter(|event| event.topic == "chat/context_tx_committed")
        .count();
    let model_context_commits = context_commits.saturating_sub(manifest.baseline_context_commits);
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
    let replies = events
        .iter()
        .filter(|event| event.topic == "chat/reply")
        .count();
    let initial_tokens = manifest.initial_pressure.estimated_tokens;
    let final_tokens = view.pressure.estimated_tokens;
    let compression_ratio = if initial_tokens == 0 {
        1.0
    } else {
        final_tokens as f64 / initial_tokens as f64
    };
    let active_frame_ids = view
        .state
        .frames
        .iter()
        .filter(|frame| !view.state.retired.contains(&frame.id))
        .map(|frame| frame.id.clone())
        .collect::<BTreeSet<_>>();
    let seed_frame_ids = manifest
        .seed_frame_ids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let active_seed_frame_ids = seed_frame_ids
        .intersection(&active_frame_ids)
        .cloned()
        .collect::<Vec<_>>();
    let retired_seed_frame_ids = seed_frame_ids
        .difference(&active_frame_ids)
        .cloned()
        .collect::<Vec<_>>();
    let new_frame_ids = active_frame_ids
        .difference(&seed_frame_ids)
        .cloned()
        .collect::<Vec<_>>();
    let revised_seed_frame_ids = view
        .state
        .frames
        .iter()
        .filter(|frame| seed_frame_ids.contains(&frame.id) && frame.revision > 1)
        .map(|frame| frame.id.clone())
        .collect::<Vec<_>>();
    let supersedes_relations = view
        .state
        .relations
        .iter()
        .filter(|relation| relation.relation == "supersedes")
        .count();
    let preserved_required_frames = manifest
        .preserve_frame_ids
        .iter()
        .all(|id| active_frame_ids.contains(id));
    let semantic_frame_maintenance = !new_frame_ids.is_empty()
        || !revised_seed_frame_ids.is_empty()
        || !retired_seed_frame_ids.is_empty();
    let observations_ok = manifest.scenario == "frame-consolidation"
        || retired_seed_observations * 4 >= manifest.seed_observation_ids.len() * 3;
    let frame_maintenance_ok =
        manifest.scenario != "frame-consolidation" || semantic_frame_maintenance;
    let success = view.pressure.level != "critical"
        && observations_ok
        && frame_maintenance_ok
        && preserved_required_frames
        && missing_markers.is_empty()
        && model_context_commits >= 1
        && context_failures == 0
        && replies == 1;
    Ok(ContextPressureEvalReport {
        run_root,
        initial_pressure: manifest.initial_pressure,
        final_pressure: view.pressure,
        estimated_token_reduction: initial_tokens as isize - final_tokens as isize,
        compression_ratio,
        seeded_observations: manifest.seed_observation_ids.len(),
        retired_seed_observations,
        active_seed_observations,
        active_frame_ids: active_frame_ids.into_iter().collect(),
        protected_ids: view.state.protected.iter().cloned().collect(),
        expected_markers: manifest.expected_markers,
        missing_markers,
        context_commits,
        model_context_commits,
        context_failures,
        replies,
        scenario: manifest.scenario,
        active_seed_frame_ids,
        retired_seed_frame_ids,
        new_frame_ids,
        revised_seed_frame_ids,
        supersedes_relations,
        preserved_required_frames,
        semantic_frame_maintenance,
        success,
    })
}

fn default_pressure_scenario() -> String {
    "observation-compression".to_string()
}

fn pressure_config(manifest: &ContextPressureEvalManifest) -> OrchestratorConfig {
    OrchestratorConfig {
        context_soft_token_limit: manifest.soft_token_limit,
        context_hard_token_limit: manifest.hard_token_limit,
        context_maintenance_reserve_tokens: manifest.maintenance_reserve_tokens,
        observation_preview_chars: manifest.observation_preview_chars,
        ..Default::default()
    }
}

fn persist_manifest(environment: &ContextPressureEvalEnvironment) -> Result<(), DynError> {
    std::fs::write(
        &environment.manifest_path,
        serde_json::to_vec_pretty(&environment.manifest)?,
    )?;
    Ok(())
}

fn sexpr_string(value: &str) -> String {
    serde_json::to_string(value).expect("serializing a Rust string cannot fail")
}

fn repeated_case_detail(index: usize, marker: &str, principle: &str) -> String {
    (0..12)
        .map(|step| {
            format!(
                "案例 {index:02} 证据 {step:02}：{marker}。{principle}。这是可归纳的重复案例，不应丢失共同原则。"
            )
        })
        .collect::<Vec<_>>()
        .join("")
}

fn semantic_marker_present(frame_text: &str, marker: &str) -> bool {
    if frame_text.contains(marker) {
        return true;
    }
    marker == "30天"
        && frame_text.contains("30")
        && (frame_text.contains("audit")
            || frame_text.contains("retention")
            || frame_text.contains("保留"))
}

fn synthetic_long_running_history() -> Vec<String> {
    let mut entries = vec![
        "长期稳定事实：项目永久代号是 ORBIT-7。这个代号是外部合同和审计引用的一部分，后续阶段不得更名。".to_string(),
        "不可变安全约束：所有审计日志至少保留30天；任何优化都不得删除仍处于保留期内的审计证据。".to_string(),
        "已确认架构决策：本地持久化采用 SQLite WAL 模式，以保证崩溃恢复和单机部署的可审计性。".to_string(),
        "早期候选记录：服务端口曾考虑使用8080。该条只是旧方案，等待后续决策确认。".to_string(),
        "最终更正：服务正式端口确定为9090；此前的8080候选已经作废，后续实现与文档都以9090为准。".to_string(),
        "长期用户偏好：对外报告使用中文，结论必须区分已验证事实、推断和仍待处理的问题。".to_string(),
    ];
    for index in 0..32 {
        entries.push(format!(
            "阶段性实验记录 {index:02}：候选参数组 EXP-{index:02} 已完成离线试验，采样窗口、临时日志路径、一次性计时数据和调试输出仅用于当时排障。该实验没有改变 ORBIT-7 的长期目标、安全约束、正式端口或持久化架构。实验过程已经结束，具体中间数值不需要在下一阶段持续占用工作 Context；若将来审计需要，原始记录仍可从 Event History 按稳定 ID 召回。重复说明：这是可退休的历史过程信息，不是新的长期事实。"
        ));
    }
    entries
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<(), DynError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn manifest_context_id(manifest: &ContextPressureEvalManifest) -> &str {
    if manifest.context_id.is_empty() {
        &manifest.session_id
    } else {
        &manifest.context_id
    }
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
    async fn creates_a_critical_synthetic_context_without_private_data() {
        let base = TempDir::new().unwrap();
        let environment = create_context_pressure_eval(Some(base.path()))
            .await
            .unwrap();
        assert_eq!(environment.manifest.initial_pressure.level, "critical");
        assert_ne!(
            environment.manifest.context_id,
            environment.manifest.session_id
        );
        assert_eq!(
            environment.environment.get("MORPHZ_CONTEXT_ID"),
            Some(&environment.manifest.context_id)
        );
        assert_eq!(environment.manifest.seed_observation_ids.len(), 38);
        assert!(environment.manifest.initial_pressure.estimated_tokens > 6_500);
        let report = inspect_context_pressure_eval(&environment.run_root)
            .await
            .unwrap();
        assert!(!report.success);
        assert_eq!(report.active_seed_observations, 38);
        assert_eq!(report.context_commits, 0);
    }

    #[tokio::test]
    async fn one_atomic_transaction_can_compress_the_seeded_context() {
        let base = TempDir::new().unwrap();
        let environment = create_context_pressure_eval(Some(base.path()))
            .await
            .unwrap();
        let store = Arc::new(
            SqliteStore::new(
                environment
                    .manifest
                    .database_path
                    .to_string_lossy()
                    .as_ref(),
            )
            .await
            .unwrap(),
        );
        let config = OrchestratorConfig {
            context_soft_token_limit: environment.manifest.soft_token_limit,
            context_hard_token_limit: environment.manifest.hard_token_limit,
            context_maintenance_reserve_tokens: environment.manifest.maintenance_reserve_tokens,
            observation_preview_chars: environment.manifest.observation_preview_chars,
            ..Default::default()
        };
        let engine = ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config);
        let sources = environment.manifest.seed_observation_ids.join(" ");
        let transaction = format!(
            "(context-tx (base-version 0) (reason \"压缩已完成的长期历史\") (derive long-term-state (from {sources}) (state (project ORBIT-7) (port 9090) (audit-retention 30天) (storage \"SQLite WAL\"))) (protect long-term-state) (retire {sources}))"
        );
        engine
            .apply_context_transaction(
                &environment.manifest.context_id,
                &environment.manifest.session_id,
                &transaction,
            )
            .await
            .unwrap();
        let view = engine
            .build_context_encoding(
                &environment.manifest.context_id,
                &environment.manifest.session_id,
                &HashSet::new(),
            )
            .await
            .unwrap();
        assert_eq!(view.pressure.level, "normal");
        assert_eq!(view.observations.len(), 0);
        assert_eq!(view.state.frames.len(), 1);
        assert!(view.state.protected.contains("long-term-state"));
        for marker in &environment.manifest.expected_markers {
            assert!(view.state.frames[0].body.contains(marker));
        }
    }

    #[tokio::test]
    async fn frame_value_fixture_is_critical_without_protecting_important_frames() {
        let base = TempDir::new().unwrap();
        let environment = create_frame_value_eval(Some(base.path())).await.unwrap();
        assert_eq!(environment.manifest.scenario, "frame-value");
        assert_eq!(environment.manifest.initial_pressure.level, "critical");
        assert_eq!(environment.manifest.baseline_context_commits, 1);
        let report = inspect_context_pressure_eval(&environment.run_root)
            .await
            .unwrap();
        assert!(!report.success);
        assert!(report.preserved_required_frames);
        assert_eq!(report.model_context_commits, 0);
        assert!(report.protected_ids.is_empty());
        assert!(report
            .active_seed_frame_ids
            .contains(&"durable-control-plane".to_string()));
    }

    #[tokio::test]
    async fn frame_consolidation_fixture_has_no_active_seed_observations() {
        let base = TempDir::new().unwrap();
        let environment = create_frame_consolidation_eval(Some(base.path()))
            .await
            .unwrap();
        assert_eq!(environment.manifest.scenario, "frame-consolidation");
        assert_eq!(environment.manifest.initial_pressure.level, "critical");
        let report = inspect_context_pressure_eval(&environment.run_root)
            .await
            .unwrap();
        assert!(!report.success);
        assert_eq!(report.active_seed_observations, 0);
        assert_eq!(report.model_context_commits, 0);
        assert!(!report.semantic_frame_maintenance);
        assert!(report.preserved_required_frames);
    }

    #[test]
    fn audit_retention_marker_accepts_structured_numeric_representation() {
        assert!(semantic_marker_present(
            "(safety (audit-log-retention-days 30))",
            "30天"
        ));
        assert!(!semantic_marker_present("(unrelated 30)", "30天"));
    }
}
