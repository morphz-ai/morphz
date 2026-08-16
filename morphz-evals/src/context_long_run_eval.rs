use chrono::Utc;
use morphz::config::OrchestratorConfig;
use morphz::event::{Event, TYPE_TOOL_OUTPUT, TYPE_USER_MESSAGE};
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{EventStore, QueryFilter};
use morphz::orchestrator::context::{ContextEngine, ContextPressure, ContextView};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

type DynError = Box<dyn std::error::Error + Send + Sync>;

const ROUND_COUNT: usize = 6;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextLongRunEvalManifest {
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
    pub rounds: usize,
    pub expected_markers: Vec<String>,
    pub obsolete_marker: String,
    pub round_prompt: String,
    pub probe_prompt: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ContextLongRunEvalEnvironment {
    pub run_root: PathBuf,
    pub manifest_path: PathBuf,
    pub manifest: ContextLongRunEvalManifest,
    pub environment: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextLongRunSnapshot {
    pub sequence: usize,
    pub label: String,
    pub recorded_at: String,
    pub injected_rounds: usize,
    pub pressure: ContextPressure,
    pub active_seed_observations: usize,
    pub retired_seed_observations: usize,
    pub active_frame_ids: Vec<String>,
    pub protected_ids: Vec<String>,
    pub context_commits: usize,
    pub context_failures: usize,
    pub replies: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ContextLongRunTrace {
    snapshots: Vec<ContextLongRunSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ContextLongRunAdvance {
    pub run_root: PathBuf,
    pub round: usize,
    pub injected_observations: usize,
    pub pressure: ContextPressure,
    pub user_prompt: String,
    pub complete: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ContextLongRunEvalReport {
    pub run_root: PathBuf,
    pub rounds_injected: usize,
    pub snapshots: Vec<ContextLongRunSnapshot>,
    pub pressure_levels_observed: Vec<String>,
    pub maximum_estimated_tokens: usize,
    pub exceeded_hard_limit: bool,
    pub maintenance_cycles: usize,
    pub proactive_maintenance_cycles: usize,
    pub pressure_maintenance_cycles: usize,
    pub efficient_maintenance_cycles: usize,
    pub maximum_commits_in_one_cycle: usize,
    pub final_pressure: ContextPressure,
    pub seeded_observations: usize,
    pub retired_seed_observations: usize,
    pub active_seed_observations: usize,
    pub active_frame_ids: Vec<String>,
    pub protected_ids: Vec<String>,
    pub expected_markers: Vec<String>,
    pub missing_frame_markers: Vec<String>,
    pub missing_probe_markers: Vec<String>,
    pub obsolete_status_preserved_in_frame: bool,
    pub obsolete_status_preserved_in_probe: bool,
    pub unsupported_stage_completion: bool,
    pub context_commits: usize,
    pub context_failures: usize,
    pub physical_tool_outputs: usize,
    pub assistant_calls: usize,
    pub turns_reaching_soft_checkpoint: usize,
    pub replies: usize,
    pub capacity_success: bool,
    pub fidelity_success: bool,
    pub efficiency_success: bool,
    pub success: bool,
}

pub async fn create_context_long_run_eval(
    base_dir: Option<&Path>,
) -> Result<ContextLongRunEvalEnvironment, DynError> {
    let base = base_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("morphz-evals"));
    std::fs::create_dir_all(&base)?;
    let base = std::fs::canonicalize(base)?;
    let id = format!(
        "context-long-run-v1-{}-{}",
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
    SqliteStore::new(database_path.to_string_lossy().as_ref()).await?;
    let session_id = format!("long-run-{id}");
    let context_id = format!("context-{id}");
    // Metadata v3 adds objective chronology/residency/freshness fields to every
    // observation. Keep the fixture's intended round progression as
    // normal -> notice -> warning instead of accidentally jumping to critical.
    let soft_token_limit = 7_000;
    let hard_token_limit = 10_000;
    let maintenance_reserve_tokens = 1_700;
    let observation_preview_chars = 900;
    let expected_markers = vec![
        "HELIOS-9".to_string(),
        "9090".to_string(),
        "45天".to_string(),
        "SQLite WAL".to_string(),
        "/v2/events".to_string(),
        "Asia/Shanghai".to_string(),
    ];
    let manifest = ContextLongRunEvalManifest {
        id,
        created_at: Utc::now().to_rfc3339(),
        context_id,
        session_id: session_id.clone(),
        database_path: database_path.clone(),
        workspace_root: workspace_root.clone(),
        artifact_dir: artifact_dir.clone(),
        soft_token_limit,
        hard_token_limit,
        maintenance_reserve_tokens,
        observation_preview_chars,
        rounds: ROUND_COUNT,
        expected_markers,
        obsolete_marker: "/v1/ingest".to_string(),
        round_prompt: "继续这个长期项目：本轮只需根据已有 Context 简要报告当前最重要状态，不需要检查 workspace、召回事件历史 或调用任何工具。不要猜测或执行后续任务。".to_string(),
        probe_prompt: "长期运行核验：请只根据你目前维护的 Context 回答，不调用任何工具。明确区分当前结论与已作废方案：项目代号、正式服务端口、审计保留期、持久化模式、当前事件入口、默认时区分别是什么？旧事件入口是什么状态？".to_string(),
    };
    let manifest_path = run_root.join("manifest.json");
    std::fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?)?;
    std::fs::write(
        run_root.join("trace.json"),
        serde_json::to_vec_pretty(&ContextLongRunTrace::default())?,
    )?;

    let environment = runtime_environment(&manifest);
    Ok(ContextLongRunEvalEnvironment {
        run_root,
        manifest_path,
        manifest,
        environment,
    })
}

pub async fn advance_context_long_run_eval(
    run_root: &Path,
) -> Result<ContextLongRunAdvance, DynError> {
    let (run_root, manifest, store) = open_eval(run_root).await?;
    let events = session_events(&store, &manifest.session_id).await?;
    let injected_rounds = injected_round_count(&events);
    if injected_rounds >= manifest.rounds {
        let pressure = eval_view(&store, &manifest).await?.pressure;
        return Ok(ContextLongRunAdvance {
            run_root,
            round: injected_rounds,
            injected_observations: 0,
            pressure,
            user_prompt: manifest.probe_prompt,
            complete: true,
        });
    }

    let round = injected_rounds + 1;
    let entries = synthetic_round(round);
    for (index, text) in entries.iter().enumerate() {
        store
            .append(Event::new(
                seed_event_id(round, index),
                "Synthetic-LongRunning-Agent".to_string(),
                TYPE_TOOL_OUTPUT.to_string(),
                "chat/tool_output".to_string(),
                vec![
                    (
                        "context_id".to_string(),
                        json!(manifest_context_id(&manifest)),
                    ),
                    ("session_id".to_string(), json!(manifest.session_id)),
                    ("tool_name".to_string(), json!("synthetic_long_run")),
                    ("round".to_string(), json!(round)),
                    ("text".to_string(), json!(text)),
                ]
                .into_iter()
                .collect(),
            ))
            .await?;
    }
    let pressure = eval_view(&store, &manifest).await?.pressure;
    if pressure.estimated_tokens >= manifest.hard_token_limit {
        return Err(format!(
            "第 {round} 轮注入后已达到 hard limit：{} >= {}",
            pressure.estimated_tokens, manifest.hard_token_limit
        )
        .into());
    }
    Ok(ContextLongRunAdvance {
        run_root,
        round,
        injected_observations: entries.len(),
        pressure,
        user_prompt: manifest.round_prompt,
        complete: round == manifest.rounds,
    })
}

pub async fn snapshot_context_long_run_eval(
    run_root: &Path,
    label: &str,
) -> Result<ContextLongRunSnapshot, DynError> {
    let (run_root, manifest, store) = open_eval(run_root).await?;
    let events = session_events(&store, &manifest.session_id).await?;
    let view = eval_view(&store, &manifest).await?;
    let seed_ids = all_injected_seed_ids(&events);
    let active_ids = view
        .observations
        .iter()
        .map(|observation| observation.id.as_str())
        .collect::<BTreeSet<_>>();
    let active_seed_observations = seed_ids
        .iter()
        .filter(|id| active_ids.contains(id.as_str()))
        .count();
    let (context_commits, context_failures, replies) = event_counters(&events);
    let trace_path = run_root.join("trace.json");
    let mut trace: ContextLongRunTrace = serde_json::from_slice(&std::fs::read(&trace_path)?)?;
    let snapshot = ContextLongRunSnapshot {
        sequence: trace.snapshots.len(),
        label: label.to_string(),
        recorded_at: Utc::now().to_rfc3339(),
        injected_rounds: injected_round_count(&events),
        pressure: view.pressure,
        active_seed_observations,
        retired_seed_observations: seed_ids.len().saturating_sub(active_seed_observations),
        active_frame_ids: view
            .state
            .frames
            .iter()
            .filter(|frame| !view.state.retired.contains(&frame.id))
            .map(|frame| frame.id.clone())
            .collect(),
        protected_ids: view.state.protected.iter().cloned().collect(),
        context_commits,
        context_failures,
        replies,
    };
    trace.snapshots.push(snapshot.clone());
    std::fs::write(&trace_path, serde_json::to_vec_pretty(&trace)?)?;
    Ok(snapshot)
}

pub async fn inspect_context_long_run_eval(
    run_root: &Path,
) -> Result<ContextLongRunEvalReport, DynError> {
    let (run_root, manifest, store) = open_eval(run_root).await?;
    let events = session_events(&store, &manifest.session_id).await?;
    let view = eval_view(&store, &manifest).await?;
    let trace: ContextLongRunTrace =
        serde_json::from_slice(&std::fs::read(run_root.join("trace.json"))?)?;
    let seed_ids = all_injected_seed_ids(&events);
    let active_ids = view
        .observations
        .iter()
        .map(|observation| observation.id.as_str())
        .collect::<BTreeSet<_>>();
    let active_seed_observations = seed_ids
        .iter()
        .filter(|id| active_ids.contains(id.as_str()))
        .count();
    let retired_seed_observations = seed_ids.len().saturating_sub(active_seed_observations);
    let frame_text = view
        .state
        .frames
        .iter()
        .filter(|frame| !view.state.retired.contains(&frame.id))
        .map(|frame| frame.body.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let missing_frame_markers = missing_markers(&manifest.expected_markers, &frame_text);
    let probe_reply = events
        .iter()
        .filter(|event| event.topic == "chat/reply")
        .filter_map(|event| event.payload.get("text").and_then(|value| value.as_str()))
        .next_back()
        .unwrap_or_default();
    let missing_probe_markers = missing_markers(&manifest.expected_markers, probe_reply);
    let obsolete_status_preserved_in_frame =
        has_explicit_obsolete_status(&frame_text, &manifest.obsolete_marker);
    let obsolete_status_preserved_in_probe =
        has_explicit_obsolete_status(probe_reply, &manifest.obsolete_marker);
    let unsupported_stage_completion = contains_unsupported_stage_completion(&frame_text)
        || contains_unsupported_stage_completion(probe_reply);
    let (context_commits, context_failures, replies) = event_counters(&events);
    let physical_tool_outputs = physical_tool_output_count(&events);
    let assistant_calls = events
        .iter()
        .filter(|event| event.topic == "chat/assistant_call")
        .count();
    let turns_reaching_soft_checkpoint = turns_reaching_soft_checkpoint(
        &events,
        OrchestratorConfig::default().attempt_soft_checkpoint_interval,
    );
    let maximum_estimated_tokens = trace
        .snapshots
        .iter()
        .map(|snapshot| snapshot.pressure.estimated_tokens)
        .max()
        .unwrap_or(view.pressure.estimated_tokens);
    let exceeded_hard_limit = maximum_estimated_tokens >= manifest.hard_token_limit;
    let pressure_levels_observed = trace
        .snapshots
        .iter()
        .map(|snapshot| snapshot.pressure.level.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let maintenance = maintenance_cycles(&trace.snapshots);
    let rounds_injected = injected_round_count(&events);
    let capacity_success = rounds_injected == manifest.rounds
        && !exceeded_hard_limit
        && maintenance.cycles >= 2
        && maintenance.proactive >= 1
        && view.pressure.level != "critical"
        && retired_seed_observations * 3 >= seed_ids.len() * 2;
    let fidelity_success = missing_frame_markers.is_empty()
        && missing_probe_markers.is_empty()
        && obsolete_status_preserved_in_frame
        && obsolete_status_preserved_in_probe
        && !unsupported_stage_completion;
    let efficiency_success =
        context_failures == 0 && physical_tool_outputs == 0 && maintenance.maximum_commits <= 2;
    let success =
        capacity_success && fidelity_success && efficiency_success && replies > manifest.rounds;
    Ok(ContextLongRunEvalReport {
        run_root,
        rounds_injected,
        snapshots: trace.snapshots,
        pressure_levels_observed,
        maximum_estimated_tokens,
        exceeded_hard_limit,
        maintenance_cycles: maintenance.cycles,
        proactive_maintenance_cycles: maintenance.proactive,
        pressure_maintenance_cycles: maintenance.at_pressure,
        efficient_maintenance_cycles: maintenance.efficient,
        maximum_commits_in_one_cycle: maintenance.maximum_commits,
        final_pressure: view.pressure,
        seeded_observations: seed_ids.len(),
        retired_seed_observations,
        active_seed_observations,
        active_frame_ids: view
            .state
            .frames
            .iter()
            .filter(|frame| !view.state.retired.contains(&frame.id))
            .map(|frame| frame.id.clone())
            .collect(),
        protected_ids: view.state.protected.iter().cloned().collect(),
        expected_markers: manifest.expected_markers,
        missing_frame_markers,
        missing_probe_markers,
        obsolete_status_preserved_in_frame,
        obsolete_status_preserved_in_probe,
        unsupported_stage_completion,
        context_commits,
        context_failures,
        physical_tool_outputs,
        assistant_calls,
        turns_reaching_soft_checkpoint,
        replies,
        capacity_success,
        fidelity_success,
        efficiency_success,
        success,
    })
}

fn runtime_environment(manifest: &ContextLongRunEvalManifest) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("MORPHZ_SESSION_ID".to_string(), manifest.session_id.clone()),
        (
            "MORPHZ_CONTEXT_ID".to_string(),
            manifest_context_id(manifest).to_string(),
        ),
        (
            "MORPHZ_STORAGE_SQLITE_PATH".to_string(),
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
        ("MORPHZ_CONTEXT_EVAL_MODE".to_string(), "true".to_string()),
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

async fn open_eval(
    run_root: &Path,
) -> Result<(PathBuf, ContextLongRunEvalManifest, Arc<SqliteStore>), DynError> {
    let run_root = std::fs::canonicalize(run_root)?;
    let manifest: ContextLongRunEvalManifest =
        serde_json::from_slice(&std::fs::read(run_root.join("manifest.json"))?)?;
    let store =
        Arc::new(SqliteStore::new(manifest.database_path.to_string_lossy().as_ref()).await?);
    Ok((run_root, manifest, store))
}

fn engine(store: &Arc<SqliteStore>, manifest: &ContextLongRunEvalManifest) -> ContextEngine {
    ContextEngine::new(
        Arc::clone(store) as Arc<dyn EventStore>,
        OrchestratorConfig {
            context_soft_token_limit: manifest.soft_token_limit,
            context_hard_token_limit: manifest.hard_token_limit,
            context_maintenance_reserve_tokens: manifest.maintenance_reserve_tokens,
            observation_preview_chars: manifest.observation_preview_chars,
            ..Default::default()
        },
    )
}

async fn eval_view(
    store: &Arc<SqliteStore>,
    manifest: &ContextLongRunEvalManifest,
) -> Result<ContextView, DynError> {
    engine(store, manifest)
        .build_context_encoding(
            manifest_context_id(manifest),
            &manifest.session_id,
            &HashSet::new(),
        )
        .await
}

fn manifest_context_id(manifest: &ContextLongRunEvalManifest) -> &str {
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

fn injected_round_count(events: &[Event]) -> usize {
    events
        .iter()
        .filter(|event| is_seed_event(event))
        .filter_map(|event| event.payload.get("round").and_then(|value| value.as_u64()))
        .max()
        .unwrap_or(0) as usize
}

fn all_injected_seed_ids(events: &[Event]) -> Vec<String> {
    events
        .iter()
        .filter(|event| is_seed_event(event))
        .map(|event| event.id.clone())
        .collect()
}

fn is_seed_event(event: &Event) -> bool {
    event
        .payload
        .get("tool_name")
        .and_then(|value| value.as_str())
        == Some("synthetic_long_run")
}

fn event_counters(events: &[Event]) -> (usize, usize, usize) {
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
    let replies = events
        .iter()
        .filter(|event| event.topic == "chat/reply")
        .count();
    (context_commits, context_failures, replies)
}

fn missing_markers(expected: &[String], text: &str) -> Vec<String> {
    let normalized_text = normalize_marker_text(text);
    expected
        .iter()
        .filter(|marker| {
            let normalized_marker = normalize_marker_text(marker);
            let present = normalized_text.contains(&normalized_marker)
                || (normalized_marker == "45天"
                    && normalized_text.contains("auditretentiondays45"));
            !present
        })
        .cloned()
        .collect()
}

fn normalize_marker_text(text: &str) -> String {
    text.chars()
        .filter(|character| {
            !character.is_whitespace() && !matches!(character, '-' | '_' | '`' | '*')
        })
        .flat_map(char::to_lowercase)
        .collect()
}

#[derive(Default)]
struct MaintenanceSummary {
    cycles: usize,
    proactive: usize,
    at_pressure: usize,
    efficient: usize,
    maximum_commits: usize,
}

fn maintenance_cycles(snapshots: &[ContextLongRunSnapshot]) -> MaintenanceSummary {
    let mut summary = MaintenanceSummary::default();
    for pair in snapshots.windows(2) {
        let before = &pair[0];
        let after = &pair[1];
        let commits = after.context_commits.saturating_sub(before.context_commits);
        if commits > 0 && after.pressure.estimated_tokens < before.pressure.estimated_tokens {
            summary.cycles += 1;
            summary.maximum_commits = summary.maximum_commits.max(commits);
            if before.pressure.level != "critical" {
                summary.proactive += 1;
            }
            if before.pressure.level == "notice" || before.pressure.level == "warning" {
                summary.at_pressure += 1;
            }
            if commits == 1 && after.context_failures == before.context_failures {
                summary.efficient += 1;
            }
        }
    }
    summary
}

fn physical_tool_output_count(events: &[Event]) -> usize {
    events
        .iter()
        .filter(|event| event.topic == "chat/tool_output")
        .filter_map(|event| {
            event
                .payload
                .get("tool_name")
                .and_then(|value| value.as_str())
        })
        .filter(|tool| *tool != "context_tx" && *tool != "synthetic_long_run")
        .count()
}

fn turns_reaching_soft_checkpoint(events: &[Event], interval: usize) -> usize {
    let mut turns = 0;
    let mut calls = 0;
    let mut in_turn = false;
    for event in events {
        if event.event_type == TYPE_USER_MESSAGE {
            if in_turn && calls >= interval {
                turns += 1;
            }
            in_turn = true;
            calls = 0;
        } else if in_turn && event.topic == "chat/assistant_call" {
            calls += 1;
        }
    }
    if in_turn && calls >= interval {
        turns += 1;
    }
    turns
}

fn has_explicit_obsolete_status(text: &str, marker: &str) -> bool {
    let lines = text.lines().collect::<Vec<_>>();
    lines.iter().enumerate().any(|(index, line)| {
        if !line.contains(marker) {
            return false;
        }
        let start = index.saturating_sub(1);
        let end = (index + 3).min(lines.len());
        let context = lines[start..end].join(" ");
        let lower = context.to_ascii_lowercase();
        (context.contains("已作废")
            || context.contains("已经作废")
            || context.contains("已废弃")
            || context.contains("不得用于")
            || context.contains("不再使用")
            || lower.contains("deprecated")
            || lower.contains("obsolete"))
            && !context.contains("并非")
            && !context.contains("不是")
    })
}

fn contains_unsupported_stage_completion(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    (lower.contains("current-stage 2") && lower.contains("completed"))
        || lower.contains("stage 2 已完成")
        || lower.contains("stage 2 的执行状态已")
        || lower.contains("阶段 2 已")
        || lower.contains("阶段2已")
}

fn seed_event_id(round: usize, index: usize) -> String {
    format!("long-run-r{round:02}-observation-{index:02}")
}

fn synthetic_round(round: usize) -> Vec<String> {
    let mut entries = match round {
        1 => vec![
            "长期稳定事实：项目永久代号是 HELIOS-9，外部合同、验收记录和后续报告必须使用这个代号。".to_string(),
            "不可变安全约束：审计日志至少保留45天，处于保留期内的证据不得被清理。".to_string(),
            "已确认部署约束：正式服务端口是9090，健康检查和部署清单均以此为准。".to_string(),
        ],
        2 => vec![
            "已确认架构决策：本地状态持久化采用 SQLite WAL 模式，以支持崩溃恢复和单机审计。".to_string(),
            "长期用户偏好：使用中文汇报，并区分已验证事实、推断和开放问题。".to_string(),
            "早期事件入口候选为 /v1/ingest；这是尚未最终确认的旧候选，不能视为稳定接口。".to_string(),
        ],
        3 => vec![
            "最终接口修订：当前正式事件入口是 /v2/events；旧的 /v1/ingest 已作废，不得用于新实现。".to_string(),
            "接口修订证据已经通过集成检查；未来回答必须把 /v2/events 作为当前结论，把 /v1/ingest 标记为旧方案。".to_string(),
        ],
        4 => vec![
            "跨会话运行约束：所有计划时间和审计时间默认使用 Asia/Shanghai，除非用户为单项任务明确覆盖。".to_string(),
            "阶段验收结论：HELIOS-9 的基础事件链路已经通过，下一阶段仍不得改变端口9090和45天保留期。".to_string(),
        ],
        5 => vec![
            "恢复演练结论：SQLite WAL 在模拟中断后恢复成功；该结论强化既有架构决策，没有引入替代存储。".to_string(),
            "文档复核结论：正式事件入口、端口和时区已经同步到当前规范；旧入口仅保留在审计历史中。".to_string(),
        ],
        6 => vec![
            "长期运行检查点：当前稳定约束未发生变化，下一阶段应继续沿用已确认状态，不应从阶段实验中推导新需求。".to_string(),
            "最终一致性检查：项目代号、端口、保留期、存储、事件入口和时区之间没有冲突。".to_string(),
        ],
        _ => Vec::new(),
    };
    let noise_count = match round {
        1 | 2 => 7,
        3 => 4,
        _ => 8,
    };
    for index in 0..noise_count {
        entries.push(format!(
            "第{round}批次过程记录 {index:02}：临时候选 RUN-{round:02}-{index:02} 已完成一次性采样、诊断计时和调试输出检查。该记录只用于当轮排障，没有改变 HELIOS-9 的项目代号、正式端口、审计保留期、SQLite WAL 持久化、事件入口或默认时区。具体采样数值、临时路径和中间输出已经失去工作价值，应在形成必要结论后从活跃 Context 退休；原始证据仍可通过 Event History 的稳定事件 ID 召回。这不是项目阶段完成记录，不是新需求，也不是长期事实。"
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

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> Result<(), DynError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn grows_through_pressure_levels_without_crossing_hard_limit() {
        let base = TempDir::new().unwrap();
        let environment = create_context_long_run_eval(Some(base.path()))
            .await
            .unwrap();
        assert_ne!(
            environment.manifest.context_id,
            environment.manifest.session_id
        );
        assert_eq!(
            environment.environment.get("MORPHZ_CONTEXT_ID"),
            Some(&environment.manifest.context_id)
        );
        let mut levels = BTreeSet::new();
        for _ in 0..3 {
            let advance = advance_context_long_run_eval(&environment.run_root)
                .await
                .unwrap();
            assert!(advance.pressure.estimated_tokens < environment.manifest.hard_token_limit);
            levels.insert(advance.pressure.level);
        }
        assert!(levels.contains("normal"));
        assert!(levels.contains("notice"));
        assert!(levels.contains("warning"));
    }

    #[tokio::test]
    async fn snapshots_are_persistent_and_monotonic() {
        let base = TempDir::new().unwrap();
        let environment = create_context_long_run_eval(Some(base.path()))
            .await
            .unwrap();
        advance_context_long_run_eval(&environment.run_root)
            .await
            .unwrap();
        let first = snapshot_context_long_run_eval(&environment.run_root, "round-1-injected")
            .await
            .unwrap();
        let second = snapshot_context_long_run_eval(&environment.run_root, "round-1-after")
            .await
            .unwrap();
        assert_eq!(first.sequence, 0);
        assert_eq!(second.sequence, 1);
        assert_eq!(second.injected_rounds, 1);
        let report = inspect_context_long_run_eval(&environment.run_root)
            .await
            .unwrap();
        assert_eq!(report.snapshots.len(), 2);
        assert_eq!(report.seeded_observations, 10);
        assert!(!report.success);
    }

    #[test]
    fn obsolete_status_requires_an_explicit_local_statement() {
        assert!(has_explicit_obsolete_status(
            "当前入口 /v2/events；旧入口 /v1/ingest 已作废，不得用于新实现。",
            "/v1/ingest"
        ));
        assert!(!has_explicit_obsolete_status(
            "旧入口 /v1/ingest 仍保留，等待平滑弃用，并非已经作废。",
            "/v1/ingest"
        ));
    }

    #[test]
    fn unsupported_stage_completion_is_detected() {
        assert!(contains_unsupported_stage_completion(
            "阶段 2 已完成，可以进入下一阶段"
        ));
        assert!(!contains_unsupported_stage_completion(
            "批次 2 的一次性采样已完成"
        ));
    }

    #[test]
    fn marker_matching_ignores_presentation_separators() {
        assert!(missing_markers(
            &["45天".to_string(), "SQLite WAL".to_string()],
            "保留 45 天；存储使用 SQLite-WAL。"
        )
        .is_empty());
    }
}
