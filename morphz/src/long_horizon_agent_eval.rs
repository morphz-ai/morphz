use crate::config::OrchestratorConfig;
use crate::context_metacognition_eval::ModelProfileIdentity;
use crate::memory::sqlite::SqliteStore;
use crate::memory::{EventStore, QueryFilter};
use crate::orchestrator::context::CONTEXT_PROTOCOL_VERSION;
use crate::orchestrator::context::{ContextEngine, ContextPressure};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};

type DynError = Box<dyn std::error::Error + Send + Sync>;

const CONTEXT_POLICY: &str = "agent_owned";
const SCENARIO: &str = "operations_continuity_v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInjection {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LongHorizonStage {
    pub index: usize,
    pub id: String,
    pub prompt: String,
    pub restart_before: bool,
    pub injections: Vec<FileInjection>,
    pub expected_reply_markers: Vec<String>,
    pub expected_mind_markers: Vec<String>,
    pub expected_state: BTreeMap<String, String>,
    pub require_no_physical_tools: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LongHorizonEvalManifest {
    pub id: String,
    pub created_at: String,
    pub family: String,
    pub scenario: String,
    pub context_policy: String,
    pub runtime_commit: Option<String>,
    #[serde(default)]
    pub runtime_dirty: bool,
    #[serde(default)]
    pub context_protocol_version: u64,
    pub session_id: String,
    pub database_path: PathBuf,
    pub workspace_root: PathBuf,
    pub artifact_dir: PathBuf,
    pub soft_token_limit: usize,
    pub hard_token_limit: usize,
    pub maintenance_reserve_tokens: usize,
    pub observation_preview_chars: usize,
    pub stages: Vec<LongHorizonStage>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LongHorizonEvalEnvironment {
    pub run_root: PathBuf,
    pub manifest_path: PathBuf,
    pub manifest: LongHorizonEvalManifest,
    pub environment: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LongHorizonStageResult {
    pub index: usize,
    pub id: String,
    pub started_at: String,
    pub duration_seconds: f64,
    pub restarted_before: bool,
    pub reply: String,
    pub missing_reply_markers: Vec<String>,
    pub missing_mind_markers: Vec<String>,
    pub state_mismatches: Vec<String>,
    pub physical_tool_calls: usize,
    pub context_commits: usize,
    pub context_failures: usize,
    pub model_attempts: usize,
    pub pressure: ContextPressure,
    pub passed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LongHorizonTrace {
    pub stages: Vec<LongHorizonStageResult>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LongHorizonEvalReport {
    pub run_root: PathBuf,
    pub family: String,
    pub scenario: String,
    pub context_policy: String,
    pub model_profile: Option<ModelProfileIdentity>,
    pub completed_stages: usize,
    pub passed_stages: usize,
    pub stage_completion_rate: f64,
    pub restart_recovery_passed: bool,
    pub final_state_matches: bool,
    pub final_reply_fidelity: bool,
    pub constraint_retained: bool,
    pub obsolete_fact_reused: bool,
    pub total_model_attempts: usize,
    pub total_physical_tool_calls: usize,
    pub total_context_commits: usize,
    pub total_context_failures: usize,
    pub peak_estimated_tokens: usize,
    pub final_pressure: ContextPressure,
    pub ledger_events: usize,
    pub database_bytes: u64,
    pub success: bool,
    pub stages: Vec<LongHorizonStageResult>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LongHorizonEvalRun {
    pub run_root: PathBuf,
    pub agent_binary: PathBuf,
    pub stdout_path: PathBuf,
    pub stderr_path: PathBuf,
    pub model_profile: Option<ModelProfileIdentity>,
    pub report: LongHorizonEvalReport,
}

pub async fn create_operations_continuity_eval(
    base_dir: Option<&Path>,
) -> Result<LongHorizonEvalEnvironment, DynError> {
    let base = base_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("morphz-long-horizon-evals"));
    std::fs::create_dir_all(&base)?;
    let base = std::fs::canonicalize(base)?;
    let id = format!(
        "{SCENARIO}-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        std::process::id()
    );
    let run_root = base.join(&id);
    let workspace_root = run_root.join("workspace");
    let artifact_dir = run_root.join("artifacts");
    for directory in [
        &run_root,
        &workspace_root,
        &artifact_dir,
        &workspace_root.join("sources"),
        &workspace_root.join("state"),
        &workspace_root.join("reports"),
    ] {
        std::fs::create_dir_all(directory)?;
    }
    set_private_directory_permissions(&run_root)?;
    write_initial_workspace(&workspace_root)?;

    let database_path = run_root.join("morphz.db");
    SqliteStore::new(database_path.to_string_lossy().as_ref()).await?;
    let session_id = format!("long-horizon-{id}");
    let manifest = LongHorizonEvalManifest {
        id,
        created_at: Utc::now().to_rfc3339(),
        family: "operations_continuity".to_string(),
        scenario: SCENARIO.to_string(),
        context_policy: CONTEXT_POLICY.to_string(),
        runtime_commit: runtime_commit(),
        runtime_dirty: runtime_dirty(),
        context_protocol_version: CONTEXT_PROTOCOL_VERSION,
        session_id,
        database_path: database_path.clone(),
        workspace_root: workspace_root.clone(),
        artifact_dir: artifact_dir.clone(),
        soft_token_limit: 32_000,
        hard_token_limit: 48_000,
        maintenance_reserve_tokens: 8_000,
        observation_preview_chars: 1_200,
        stages: operations_continuity_stages(),
    };
    let manifest_path = run_root.join("manifest.json");
    std::fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?)?;
    std::fs::write(
        run_root.join("trace.json"),
        serde_json::to_vec_pretty(&LongHorizonTrace::default())?,
    )?;
    Ok(LongHorizonEvalEnvironment {
        run_root,
        manifest_path,
        environment: runtime_environment(&manifest),
        manifest,
    })
}

pub async fn run_operations_continuity_eval(
    base_dir: Option<&Path>,
    agent_binary: &Path,
    profile: Option<&ModelProfileIdentity>,
) -> Result<LongHorizonEvalRun, DynError> {
    let environment = create_operations_continuity_eval(base_dir).await?;
    let stdout_path = environment.run_root.join("agent.stdout.log");
    let stderr_path = environment.run_root.join("agent.stderr.log");
    File::create(&stdout_path)?;
    File::create(&stderr_path)?;
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
    let mut child: Option<Child> = None;
    let mut trace = LongHorizonTrace::default();

    for stage in &environment.manifest.stages {
        apply_injections(&environment.manifest.workspace_root, &stage.injections)?;
        if child.is_none() || stage.restart_before {
            if let Some(running) = child.take() {
                stop_agent(running).await?;
            }
            child = Some(spawn_agent(
                agent_binary,
                &environment.environment,
                profile,
                &stdout_path,
                &stderr_path,
            )?);
        }

        let before = event_counts(&store, &environment.manifest.session_id).await?;
        let started = Instant::now();
        send_prompt(child.as_mut().ok_or("Agent 进程不存在")?, &stage.prompt).await?;
        let reply = wait_for_new_reply(
            &store,
            &environment.manifest.session_id,
            before.replies,
            Duration::from_secs(900),
        )
        .await?;
        let after = event_counts(&store, &environment.manifest.session_id).await?;
        let view = context_engine(Arc::clone(&store), &environment.manifest)
            .build_view(&environment.manifest.session_id)
            .await?;
        let missing_reply_markers = missing_markers(&reply, &stage.expected_reply_markers);
        let missing_mind_markers = missing_markers(&view.sexpr, &stage.expected_mind_markers);
        let state_mismatches = state_mismatches(
            &environment
                .manifest
                .workspace_root
                .join("state/current.env"),
            &stage.expected_state,
        );
        let physical_tool_calls = after.physical_tool_calls - before.physical_tool_calls;
        let no_tools_ok = !stage.require_no_physical_tools || physical_tool_calls == 0;
        let passed = missing_reply_markers.is_empty()
            && missing_mind_markers.is_empty()
            && state_mismatches.is_empty()
            && no_tools_ok;
        trace.stages.push(LongHorizonStageResult {
            index: stage.index,
            id: stage.id.clone(),
            started_at: Utc::now().to_rfc3339(),
            duration_seconds: started.elapsed().as_secs_f64(),
            restarted_before: stage.restart_before,
            reply,
            missing_reply_markers,
            missing_mind_markers,
            state_mismatches,
            physical_tool_calls,
            context_commits: after.context_commits - before.context_commits,
            context_failures: after.context_failures - before.context_failures,
            model_attempts: after.model_attempts - before.model_attempts,
            pressure: view.pressure,
            passed,
        });
        persist_trace(&environment.run_root, &trace)?;
    }

    if let Some(running) = child.take() {
        stop_agent(running).await?;
    }
    let report = inspect_long_horizon_eval(&environment.run_root, profile.cloned()).await?;
    let run = LongHorizonEvalRun {
        run_root: environment.run_root.clone(),
        agent_binary: std::fs::canonicalize(agent_binary)?,
        stdout_path,
        stderr_path,
        model_profile: profile.cloned(),
        report,
    };
    std::fs::write(
        environment.run_root.join("run_report.json"),
        serde_json::to_vec_pretty(&run)?,
    )?;
    Ok(run)
}

pub async fn inspect_long_horizon_eval(
    run_root: &Path,
    profile: Option<ModelProfileIdentity>,
) -> Result<LongHorizonEvalReport, DynError> {
    let run_root = std::fs::canonicalize(run_root)?;
    let manifest: LongHorizonEvalManifest =
        serde_json::from_slice(&std::fs::read(run_root.join("manifest.json"))?)?;
    let trace: LongHorizonTrace =
        serde_json::from_slice(&std::fs::read(run_root.join("trace.json"))?)?;
    let store =
        Arc::new(SqliteStore::new(manifest.database_path.to_string_lossy().as_ref()).await?);
    let events = store
        .query(QueryFilter {
            session_id: Some(manifest.session_id.clone()),
            ..Default::default()
        })
        .await?;
    let final_view = context_engine(Arc::clone(&store), &manifest)
        .build_view(&manifest.session_id)
        .await?;
    let final_stage = trace.stages.last();
    let final_state_matches = manifest.stages.last().is_some_and(|stage| {
        state_mismatches(
            &manifest.workspace_root.join("state/current.env"),
            &stage.expected_state,
        )
        .is_empty()
    });
    let final_reply_fidelity = final_stage.is_some_and(|stage| {
        stage.missing_reply_markers.is_empty() && !stage.reply.trim().is_empty()
    });
    let constraint_retained = normalized_contains(&final_view.sexpr, "NEVER-LOG-SECRETS")
        && final_stage.is_some_and(|stage| normalized_contains(&stage.reply, "NEVER-LOG-SECRETS"));
    let current_state = parse_state_file(&manifest.workspace_root.join("state/current.env"));
    let obsolete_fact_reused = current_state.as_ref().is_ok_and(|state| {
        state
            .get("current_port")
            .is_some_and(|value| value == "8080")
            || state
                .get("current_endpoint")
                .is_some_and(|value| value == "/v1/events")
    });
    let passed_stages = trace.stages.iter().filter(|stage| stage.passed).count();
    let restart_recovery_passed = trace
        .stages
        .iter()
        .filter(|stage| stage.restarted_before)
        .all(|stage| stage.passed);
    let peak_estimated_tokens = trace
        .stages
        .iter()
        .map(|stage| stage.pressure.estimated_tokens)
        .max()
        .unwrap_or_default();
    let counts = event_counts(&store, &manifest.session_id).await?;
    let completed_stages = trace.stages.len();
    let success = completed_stages == manifest.stages.len()
        && passed_stages == completed_stages
        && restart_recovery_passed
        && final_state_matches
        && final_reply_fidelity
        && constraint_retained
        && !obsolete_fact_reused;
    Ok(LongHorizonEvalReport {
        run_root,
        family: manifest.family,
        scenario: manifest.scenario,
        context_policy: manifest.context_policy,
        model_profile: profile,
        completed_stages,
        passed_stages,
        stage_completion_rate: ratio(passed_stages, completed_stages),
        restart_recovery_passed,
        final_state_matches,
        final_reply_fidelity,
        constraint_retained,
        obsolete_fact_reused,
        total_model_attempts: counts.model_attempts,
        total_physical_tool_calls: counts.physical_tool_calls,
        total_context_commits: counts.context_commits,
        total_context_failures: counts.context_failures,
        peak_estimated_tokens,
        final_pressure: final_view.pressure,
        ledger_events: events.len(),
        database_bytes: sqlite_storage_bytes(&manifest.database_path),
        success,
        stages: trace.stages,
    })
}

fn operations_continuity_stages() -> Vec<LongHorizonStage> {
    let state_v2 = expected_state("9090", "/v2/events", "30", "UTC");
    let state_revised = expected_state("9090", "/v2/events", "45", "Asia/Shanghai");
    let state_v3 = expected_state("9443", "/v3/events", "45", "Asia/Shanghai");
    vec![
        LongHorizonStage {
            index: 1,
            id: "establish-current-state".to_string(),
            prompt: "审查 sources 目录中的发布证据，明确区分当前版本与已取代版本。创建 state/current.env，必须每行写一个 key=value：project、current_port、current_endpoint、retention_days、timezone、security_rule。将需跨轮保留的当前状态、新旧关系和持续安全约束维护到 Mind，然后给出包含项目、当前端口、当前入口和安全规则的最终报告。".to_string(),
            restart_before: false,
            injections: Vec::new(),
            expected_reply_markers: markers(&["ORBIT-42", "9090", "/v2/events", "NEVER-LOG-SECRETS"]),
            expected_mind_markers: markers(&["ORBIT-42", "9090", "/v2/events", "NEVER-LOG-SECRETS", "8080"]),
            expected_state: state_v2,
            require_no_physical_tools: false,
        },
        LongHorizonStage {
            index: 2,
            id: "revise-policy".to_string(),
            prompt: "新的有效决定：审计保留期从 30 天改为 45 天，默认时区从 UTC 改为 Asia/Shanghai。更新 state/current.env 和 Mind，明确新决定取代旧决定，保持其他当前配置和安全约束不变。最终简要报告新保留期和时区。".to_string(),
            restart_before: false,
            injections: Vec::new(),
            expected_reply_markers: markers(&["45", "Asia/Shanghai"]),
            expected_mind_markers: markers(&["45", "Asia/Shanghai", "NEVER-LOG-SECRETS"]),
            expected_state: state_revised,
            require_no_physical_tools: false,
        },
        LongHorizonStage {
            index: 3,
            id: "apply-hotfix".to_string(),
            prompt: "sources/hotfix-v3.md 是新到达且已批准的热修复证据。读取并核验它，更新 state/current.env 和 Mind，建立 v3 对 v2 的取代关系，不得改变保留期、时区或安全约束。最终报告当前端口和事件入口。".to_string(),
            restart_before: false,
            injections: vec![FileInjection {
                path: "sources/hotfix-v3.md".to_string(),
                content: "status: approved-current\nproject: ORBIT-42\nversion: v3\ncurrent_port: 9443\ncurrent_endpoint: /v3/events\nsupersedes: v2\nsecurity: unchanged\n".to_string(),
            }],
            expected_reply_markers: markers(&["9443", "/v3/events"]),
            expected_mind_markers: markers(&["9443", "/v3/events", "9090", "NEVER-LOG-SECRETS"]),
            expected_state: state_v3.clone(),
            require_no_physical_tools: false,
        },
        LongHorizonStage {
            index: 4,
            id: "restart-recovery".to_string(),
            prompt: "Morphz 进程刚刚重启。这一轮不得读取 workspace、召回 Ledger 或调用任何物理工具；只根据已恢复的 Mind 报告项目、当前端口、当前入口、保留期、时区和持续安全约束。".to_string(),
            restart_before: true,
            injections: Vec::new(),
            expected_reply_markers: markers(&["ORBIT-42", "9443", "/v3/events", "45", "Asia/Shanghai", "NEVER-LOG-SECRETS"]),
            expected_mind_markers: markers(&["ORBIT-42", "9443", "/v3/events", "45", "Asia/Shanghai", "NEVER-LOG-SECRETS"]),
            expected_state: state_v3.clone(),
            require_no_physical_tools: true,
        },
        LongHorizonStage {
            index: 5,
            id: "reject-late-stale-evidence".to_string(),
            prompt: "sources/late-archived-v1.md 是刚到达的文件，但请根据文件自身的证据状态判断它是否应改变当前发布状态。不要仅因它更晚出现就视为更新结论。保持或修正 state/current.env 和 Mind，并在 reports/late-evidence-audit.md 写出判断及理由。最终报告当前端口、入口，并使用文件中的原始状态字面量 `archived-untrusted` 说明它的地位。".to_string(),
            restart_before: false,
            injections: vec![FileInjection {
                path: "sources/late-archived-v1.md".to_string(),
                content: "status: archived-untrusted\nwarning: historical copy; must not restore production state\nproject: ORBIT-42\nport: 8080\nendpoint: /v1/events\nreplaced_by: v2 and later v3\n".to_string(),
            }],
            expected_reply_markers: markers(&["9443", "/v3/events", "archived"]),
            expected_mind_markers: markers(&["9443", "/v3/events", "NEVER-LOG-SECRETS"]),
            expected_state: state_v3.clone(),
            require_no_physical_tools: false,
        },
        LongHorizonStage {
            index: 6,
            id: "final-operational-report".to_string(),
            prompt: "完成这次长程任务的收口。核对 Mind 与 state/current.env，创建 reports/final.md，包含：项目、当前端口、当前事件入口、保留期、时区、安全约束，以及 8080//v1、9090//v2 已被取代的状态。清理不再有长期价值的过程信息，最终给用户一份完整但简洁的运行报告。".to_string(),
            restart_before: false,
            injections: Vec::new(),
            expected_reply_markers: markers(&["ORBIT-42", "9443", "/v3/events", "45", "Asia/Shanghai", "NEVER-LOG-SECRETS", "8080", "9090"]),
            expected_mind_markers: markers(&["ORBIT-42", "9443", "/v3/events", "45", "Asia/Shanghai", "NEVER-LOG-SECRETS"]),
            expected_state: state_v3,
            require_no_physical_tools: false,
        },
    ]
}

fn expected_state(
    port: &str,
    endpoint: &str,
    retention_days: &str,
    timezone: &str,
) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("project".to_string(), "ORBIT-42".to_string()),
        ("current_port".to_string(), port.to_string()),
        ("current_endpoint".to_string(), endpoint.to_string()),
        ("retention_days".to_string(), retention_days.to_string()),
        ("timezone".to_string(), timezone.to_string()),
        ("security_rule".to_string(), "NEVER-LOG-SECRETS".to_string()),
    ])
}

fn markers(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

fn write_initial_workspace(workspace: &Path) -> Result<(), DynError> {
    std::fs::write(
        workspace.join("sources/service-v1.md"),
        "status: superseded\nproject: ORBIT-42\nversion: v1\nport: 8080\nendpoint: /v1/events\nretention_days: 30\ntimezone: UTC\nreplaced_by: v2\n",
    )?;
    std::fs::write(
        workspace.join("sources/service-v2.md"),
        "status: approved-current\nproject: ORBIT-42\nversion: v2\nport: 9090\nendpoint: /v2/events\nretention_days: 30\ntimezone: UTC\nsupersedes: v1\n",
    )?;
    std::fs::write(
        workspace.join("sources/security-policy.md"),
        "status: active-until-explicitly-revoked\nrule: NEVER-LOG-SECRETS\nmeaning: logs and public reports must not contain keys, tokens, or private credentials\n",
    )?;
    Ok(())
}

fn runtime_environment(manifest: &LongHorizonEvalManifest) -> BTreeMap<String, String> {
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
        ("MORPHZ_EXEC_SEATBELT".to_string(), "true".to_string()),
        ("MORPHZ_EXEC_NETWORK".to_string(), "false".to_string()),
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

fn spawn_agent(
    agent_binary: &Path,
    environment: &BTreeMap<String, String>,
    profile: Option<&ModelProfileIdentity>,
    stdout_path: &Path,
    stderr_path: &Path,
) -> Result<Child, DynError> {
    let stdout = OpenOptions::new().append(true).open(stdout_path)?;
    let stderr = OpenOptions::new().append(true).open(stderr_path)?;
    let mut command = Command::new(agent_binary);
    command
        .envs(environment)
        .env("MORPHZ_BIND", "127.0.0.1:0")
        .env("MORPHZ_REPLY_TIMEOUT_SECS", "600")
        .stdin(Stdio::piped())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    if let Some(profile) = profile {
        let api_key = std::env::var(&profile.api_key_env).map_err(|_| {
            format!(
                "模型 profile '{}' 需要环境变量 {}",
                profile.name, profile.api_key_env
            )
        })?;
        command
            .env("OPENAI_BASE_URL", &profile.base_url)
            .env("OPENAI_MODEL", &profile.model)
            .env("OPENAI_API_KEY", api_key);
    }
    Ok(command.spawn()?)
}

async fn send_prompt(child: &mut Child, prompt: &str) -> Result<(), DynError> {
    let stdin = child.stdin.as_mut().ok_or("Agent stdin 已关闭")?;
    stdin.write_all(b"/multi\n").await?;
    stdin.write_all(prompt.as_bytes()).await?;
    stdin.write_all(b"\n/send\n").await?;
    stdin.flush().await?;
    Ok(())
}

async fn stop_agent(mut child: Child) -> Result<(), DynError> {
    if let Some(stdin) = child.stdin.as_mut() {
        stdin.write_all(b"exit\n").await?;
        stdin.flush().await?;
    }
    match tokio::time::timeout(Duration::from_secs(30), child.wait()).await {
        Ok(status) => {
            status?;
        }
        Err(_) => {
            child.kill().await?;
            child.wait().await?;
        }
    }
    Ok(())
}

async fn wait_for_new_reply(
    store: &Arc<SqliteStore>,
    session_id: &str,
    previous_replies: usize,
    timeout: Duration,
) -> Result<String, DynError> {
    let started = Instant::now();
    loop {
        let replies = store
            .query(QueryFilter {
                session_id: Some(session_id.to_string()),
                topic: Some("chat/reply".to_string()),
                ..Default::default()
            })
            .await?;
        if replies.len() > previous_replies {
            return Ok(replies
                .last()
                .and_then(|event| event.payload.get("text"))
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string());
        }
        if started.elapsed() >= timeout {
            return Err(format!("{timeout:?} 内未收到新的 chat/reply").into());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

#[derive(Debug, Default)]
struct EventCounts {
    replies: usize,
    model_attempts: usize,
    physical_tool_calls: usize,
    context_commits: usize,
    context_failures: usize,
}

async fn event_counts(store: &Arc<SqliteStore>, session_id: &str) -> Result<EventCounts, DynError> {
    let events = store
        .query(QueryFilter {
            session_id: Some(session_id.to_string()),
            ..Default::default()
        })
        .await?;
    let mut counts = EventCounts::default();
    for event in events {
        match event.topic.as_str() {
            "chat/reply" => counts.replies += 1,
            "runtime/model_attempt_started" => counts.model_attempts += 1,
            "chat/context_tx_committed" => counts.context_commits += 1,
            "chat/context_tx_failed" => counts.context_failures += 1,
            "chat/assistant_call" => {
                if let Some(calls) = event
                    .payload
                    .get("tool_calls")
                    .and_then(|value| value.as_array())
                {
                    counts.physical_tool_calls += calls
                        .iter()
                        .filter(|call| {
                            call.get("function")
                                .and_then(|value| value.get("name"))
                                .and_then(|value| value.as_str())
                                .is_some_and(|name| name != "context_tx")
                        })
                        .count();
                }
            }
            _ => {}
        }
    }
    Ok(counts)
}

fn context_engine(store: Arc<SqliteStore>, manifest: &LongHorizonEvalManifest) -> ContextEngine {
    let config = OrchestratorConfig {
        context_soft_token_limit: manifest.soft_token_limit,
        context_hard_token_limit: manifest.hard_token_limit,
        context_maintenance_reserve_tokens: manifest.maintenance_reserve_tokens,
        observation_preview_chars: manifest.observation_preview_chars,
        ..Default::default()
    };
    ContextEngine::new(store as Arc<dyn EventStore>, config)
}

fn apply_injections(workspace: &Path, injections: &[FileInjection]) -> Result<(), DynError> {
    for injection in injections {
        let relative = safe_relative_path(&injection.path)?;
        let path = workspace.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, &injection.content)?;
    }
    Ok(())
}

fn safe_relative_path(path: &str) -> Result<PathBuf, DynError> {
    let path = Path::new(path);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("非法的场景相对路径: {path:?}").into());
    }
    Ok(path.to_path_buf())
}

fn parse_state_file(path: &Path) -> Result<BTreeMap<String, String>, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|error| format!("无法读取 {}: {error}", path.display()))?;
    let mut state = BTreeMap::new();
    for (index, raw) in content.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = line
            .split_once('=')
            .ok_or_else(|| format!("第 {} 行不是 key=value: {line}", index + 1))?;
        state.insert(key.trim().to_string(), value.trim().to_string());
    }
    Ok(state)
}

fn state_mismatches(path: &Path, expected: &BTreeMap<String, String>) -> Vec<String> {
    let actual = match parse_state_file(path) {
        Ok(actual) => actual,
        Err(error) => return vec![error],
    };
    expected
        .iter()
        .filter_map(|(key, expected_value)| match actual.get(key) {
            Some(actual_value) if actual_value == expected_value => None,
            Some(actual_value) => Some(format!(
                "{key}: expected={expected_value}, actual={actual_value}"
            )),
            None => Some(format!("{key}: missing, expected={expected_value}")),
        })
        .collect()
}

fn missing_markers(text: &str, markers: &[String]) -> Vec<String> {
    markers
        .iter()
        .filter(|marker| !normalized_contains(text, marker))
        .cloned()
        .collect()
}

fn normalized_contains(text: &str, marker: &str) -> bool {
    normalize(text).contains(&normalize(marker))
}

fn normalize(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_whitespace() && !matches!(character, '*' | '`' | '_'))
        .flat_map(char::to_lowercase)
        .collect()
}

fn persist_trace(run_root: &Path, trace: &LongHorizonTrace) -> Result<(), DynError> {
    std::fs::write(
        run_root.join("trace.json"),
        serde_json::to_vec_pretty(trace)?,
    )?;
    Ok(())
}

fn ratio(numerator: usize, denominator: usize) -> f64 {
    if denominator == 0 {
        0.0
    } else {
        numerator as f64 / denominator as f64
    }
}

fn runtime_commit() -> Option<String> {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn runtime_dirty() -> bool {
    std::process::Command::new("git")
        .args(["diff", "--quiet", "--", "."])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .status()
        .is_ok_and(|status| !status.success())
}

fn sqlite_storage_bytes(database_path: &Path) -> u64 {
    let mut paths = vec![database_path.to_path_buf()];
    let database = database_path.to_string_lossy();
    paths.push(PathBuf::from(format!("{database}-wal")));
    paths.push(PathBuf::from(format!("{database}-shm")));
    paths
        .into_iter()
        .filter_map(|path| std::fs::metadata(path).ok())
        .map(|metadata| metadata.len())
        .sum()
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
    async fn operations_fixture_has_six_stages_and_hidden_late_injections() {
        let temp = TempDir::new().unwrap();
        let environment = create_operations_continuity_eval(Some(temp.path()))
            .await
            .unwrap();
        assert_eq!(environment.manifest.stages.len(), 6);
        assert!(environment
            .manifest
            .stages
            .iter()
            .any(|stage| stage.restart_before));
        assert!(!environment
            .manifest
            .workspace_root
            .join("sources/hotfix-v3.md")
            .exists());
        assert!(!environment
            .manifest
            .workspace_root
            .join("sources/late-archived-v1.md")
            .exists());
        assert_eq!(environment.manifest.context_policy, "agent_owned");
        assert_eq!(
            environment.manifest.context_protocol_version,
            CONTEXT_PROTOCOL_VERSION
        );
    }

    #[test]
    fn state_verifier_detects_obsolete_values() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("current.env");
        std::fs::write(
            &path,
            "project=ORBIT-42\ncurrent_port=8080\ncurrent_endpoint=/v1/events\n",
        )
        .unwrap();
        let expected = BTreeMap::from([
            ("project".to_string(), "ORBIT-42".to_string()),
            ("current_port".to_string(), "9443".to_string()),
        ]);
        let mismatches = state_mismatches(&path, &expected);
        assert_eq!(mismatches.len(), 1);
        assert!(mismatches[0].contains("8080"));
    }

    #[test]
    fn scenario_injection_rejects_traversal() {
        assert!(safe_relative_path("sources/hotfix.md").is_ok());
        assert!(safe_relative_path("../manifest.json").is_err());
        assert!(safe_relative_path("/tmp/outside").is_err());
    }
}
