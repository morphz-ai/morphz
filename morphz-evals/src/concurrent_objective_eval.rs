use crate::context_metacognition_eval::ModelProfileIdentity;
use crate::{configure_agent_model_profile_with_overrides, EvalRuntimeOverrides};
use chrono::{DateTime, Utc};
use morphz::config::ModelProtocol;
use morphz::event::Event;
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{
    ActivationStore as _, EventStore as _, ObjectiveRecord, ObjectiveStatus, ObjectiveStore as _,
    QueryFilter, ThreadActivationRecord,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::{File, OpenOptions};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio as StdStdio};
use std::time::{Duration, Instant};
use tokio::process::{Child, Command};

type DynError = Box<dyn std::error::Error + Send + Sync>;

const SCENARIO: &str = "forgedepot-concurrent-objectives-v1";
const MIN_OBJECTIVES: usize = 2;
const OBJECTIVE_DISCOVERY_TIMEOUT_SECS: u64 = 20 * 60;
const OVERALL_TIMEOUT_SECS: u64 = 6 * 60 * 60;
const QUIESCENCE_SECS: u64 = 20;

const INITIAL_PROMPT: &str = r#"请在当前工作区完整实现 PROJECT_SPEC.md 中的 ForgeDepot 项目。

这是一个较大的真实开发任务。请自己识别能够独立推进的部分，在同一会话中并行实施，同时让各部分共享接口决策、测试结果与最新进度。不要只给方案或示例；持续工作直到项目达到可交付状态，执行必要的构建和测试，并在最后说明验证结果。"#;

const OBJECTIVE_GUIDED_INITIAL_PROMPT: &str = r#"请在当前工作区完整实现 PROJECT_SPEC.md 中的 ForgeDepot 项目。

这是一个较大的真实开发任务。请使用 Runtime 的 First-Class Objective 调度机制，自主识别并创建多个能够独立推进的同级 Objective，在同一 Session 内并发执行，并让它们共享接口决策、测试结果与最新进度。Objective 的数量、边界和依赖由你判断。不要只给方案或示例；持续工作直到项目达到可交付状态，执行必要的构建和测试，并在最后说明验证结果。"#;

const STATUS_PROMPT: &str = r#"现在整体进展如何？请基于 Runtime 中真实存在的目标、执行和测试状态回答；不需要停止正在推进的工作。"#;

const CROSS_CUTTING_PROMPT: &str = r#"补充一条跨模块语义：被 yank 的版本不得参与新的依赖解析，但已经生成的旧 lockfile 仍必须能够安装该版本。请把它纳入当前实现和测试，并协调受影响的模块继续推进。"#;

const PROJECT_SPEC: &str = r#"# ForgeDepot v1

实现一个完全本地、可离线运行的 Rust 软件包仓库与依赖安装器。项目必须能够在 Agent 当前工作区内通过 `cargo build --offline` 构建，最终二进制名为 `forgedepot`。

## 命令行契约

所有命令都接受 `--root <PATH>` 指定仓库根目录：

```text
forgedepot --root ROOT init
forgedepot --root ROOT publish PACKAGE_DIR
forgedepot --root ROOT resolve NAME@REQ --lock LOCK_PATH
forgedepot --root ROOT install --lock LOCK_PATH --dest DEST
forgedepot --root ROOT search QUERY --json
forgedepot --root ROOT yank NAME@VERSION
forgedepot --root ROOT serve --bind HOST:PORT --ready-file PATH
```

成功返回 0，输入或一致性错误返回非 0，并把可理解的错误写到 stderr。重复执行 `init` 必须安全。

## 包格式

PACKAGE_DIR 含 `forgedepot.toml` 与任意载荷文件。Manifest 格式：

```toml
[package]
name = "demo"
version = "1.2.3"

[dependencies]
util = "^1.0"
```

包名仅允许 ASCII 字母、数字、`-`、`_`，版本和依赖要求使用 SemVer。发布时对整个包目录生成稳定内容摘要，将不可变内容保存在 `ROOT/blobs/sha256/<hash>`，并把元数据事务性写入 `ROOT/registry.db`。相同 name/version 与相同内容的重复发布必须幂等；相同 name/version 的不同内容必须拒绝。并发发布不得破坏数据库或产生半成品。

## 解析与 Lockfile

`resolve NAME@REQ` 递归解析依赖，选择满足约束的最高版本；同一包的全部约束必须统一求解，无法满足时明确失败。输出稳定、可重复的 JSON lockfile：

```json
{
  "version": 1,
  "root": {"name": "app", "version": "1.0.0"},
  "packages": [
    {"name": "app", "version": "1.0.0", "sha256": "...", "dependencies": {}}
  ]
}
```

`packages` 必须按 name、version 稳定排序。新解析不得选择已 yank 的版本；已存在的 lockfile 仍可按其中的内容摘要安装被 yank 的版本。

## 安装、检索与损坏检测

`install` 根据 lockfile 校验每个 blob 的 SHA-256，任何缺失或损坏必须失败且不得留下看似成功的安装。成功后把各包内容复制到 `DEST/<name>/<version>/`。`search --json` 输出 JSON 数组，支持名称子串检索并包含 name、version、yanked、sha256。

## HTTP 服务

`serve` 提供至少：

- `GET /health` 返回 200 和 JSON 健康状态；
- `GET /api/packages?q=...` 返回与 search 等价的 JSON；
- `GET /api/packages/{name}/{version}` 返回元数据或 404。

绑定成功后把实际地址写入 `--ready-file`；收到 SIGTERM/Ctrl-C 后正常退出。

## 工程质量

- 核心领域逻辑、存储、解析、CLI/HTTP 边界清楚；
- 错误不靠 panic 表达；
- 为 SemVer 选择、冲突、幂等发布、yank 语义、损坏 blob、稳定 lockfile 编写测试；
- README 给出可复制的离线使用示例。
"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConcurrentObjectiveManifest {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub scenario: String,
    #[serde(default)]
    pub scheduling_arm: SchedulingArm,
    pub runtime_commit: Option<String>,
    pub runtime_dirty: bool,
    pub context_id: String,
    pub session_id: String,
    pub database_path: PathBuf,
    pub workspace_root: PathBuf,
    pub artifact_dir: PathBuf,
    pub hidden_verifier_path: PathBuf,
    pub minimum_objectives: usize,
    pub objective_discovery_timeout_secs: u64,
    pub overall_timeout_secs: u64,
    pub quiescence_secs: u64,
    pub initial_prompt: String,
    pub status_prompt: String,
    pub cross_cutting_prompt: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SchedulingArm {
    #[default]
    Autonomous,
    ObjectiveGuided,
}

impl SchedulingArm {
    fn initial_prompt(self) -> &'static str {
        match self {
            Self::Autonomous => INITIAL_PROMPT,
            Self::ObjectiveGuided => OBJECTIVE_GUIDED_INITIAL_PROMPT,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ConcurrentObjectiveEnvironment {
    pub run_root: PathBuf,
    pub manifest_path: PathBuf,
    pub manifest: ConcurrentObjectiveManifest,
    pub environment: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbeRecord {
    pub kind: String,
    pub sent_at: DateTime<Utc>,
    pub reply_count_before: usize,
    #[serde(default)]
    pub message_event_id: Option<String>,
    #[serde(default)]
    pub reply_event_ids: Vec<String>,
    #[serde(default)]
    pub reply_texts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvaluationInterval {
    pub objective_id: String,
    pub evaluation_id: String,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrossObjectiveFileOverlap {
    pub path: String,
    pub objective_ids: Vec<String>,
    pub write_attempts: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerificationCheck {
    pub id: String,
    pub passed: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VerificationReport {
    pub passed: bool,
    pub checks: Vec<VerificationCheck>,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConcurrentObjectiveReport {
    pub run_root: PathBuf,
    pub model_profile: Option<ModelProfileIdentity>,
    pub started_at: DateTime<Utc>,
    pub finished_at: DateTime<Utc>,
    pub duration_seconds: f64,
    pub scheduling_arm: SchedulingArm,
    pub objective_mechanism_adopted: bool,
    pub restart_performed: bool,
    pub timed_out: bool,
    pub objectives: Vec<ObjectiveRecord>,
    pub objective_count: usize,
    pub terminal_objective_count: usize,
    pub completed_objective_count: usize,
    pub failed_or_cancelled_objective_count: usize,
    pub peak_concurrent_evaluations: usize,
    #[serde(default)]
    pub objective_launch_spread_seconds: f64,
    #[serde(default)]
    pub evaluation_active_seconds: f64,
    #[serde(default)]
    pub effective_parallelism: f64,
    pub evaluation_intervals: Vec<EvaluationInterval>,
    #[serde(default)]
    pub objective_tokens_used: u64,
    #[serde(default)]
    pub objective_file_write_attempts: usize,
    #[serde(default)]
    pub cross_objective_file_overlaps: Vec<CrossObjectiveFileOverlap>,
    pub model_attempts: usize,
    pub physical_tool_calls: usize,
    pub failed_tool_outputs: usize,
    pub context_transaction_conflicts: usize,
    pub activations: Vec<ThreadActivationRecord>,
    pub nonterminal_activations: usize,
    pub failed_activation_count: usize,
    pub terminal_failure_without_reply: bool,
    pub replies: Vec<String>,
    pub probes: Vec<ProbeRecord>,
    #[serde(default)]
    pub valid_probe_count: usize,
    #[serde(default)]
    pub answered_probe_count: usize,
    #[serde(default)]
    pub probe_reply_success: bool,
    pub database_bytes: u64,
    pub verification: VerificationReport,
    pub project_success: bool,
    #[serde(default)]
    pub structural_coordination_success: bool,
    pub coordination_success: bool,
    pub success: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConcurrentObjectiveRun {
    pub run_root: PathBuf,
    pub agent_binary: PathBuf,
    pub stdout_path: PathBuf,
    pub stderr_path: PathBuf,
    pub report: ConcurrentObjectiveReport,
}

struct AgentProcess {
    child: Child,
    base_url: String,
    client: reqwest::Client,
}

pub async fn create_forgedepot_eval(
    base_dir: Option<&Path>,
) -> Result<ConcurrentObjectiveEnvironment, DynError> {
    create_forgedepot_eval_with_arm(base_dir, SchedulingArm::Autonomous).await
}

pub async fn create_forgedepot_eval_with_arm(
    base_dir: Option<&Path>,
    scheduling_arm: SchedulingArm,
) -> Result<ConcurrentObjectiveEnvironment, DynError> {
    let base = base_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("morphz-concurrent-objective-evals"));
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
    let hidden_dir = run_root.join("hidden");
    for path in [&run_root, &workspace_root, &artifact_dir, &hidden_dir] {
        std::fs::create_dir_all(path)?;
    }
    set_private_directory_permissions(&run_root)?;
    std::fs::write(workspace_root.join("PROJECT_SPEC.md"), PROJECT_SPEC)?;
    std::fs::write(workspace_root.join(".gitignore"), "/target\n")?;
    let hidden_verifier_path = hidden_dir.join("verify.py");
    std::fs::write(&hidden_verifier_path, HIDDEN_VERIFIER)?;

    let database_path = run_root.join("morphz.db");
    SqliteStore::new(database_path.to_string_lossy().as_ref()).await?;
    let context_id = format!("context-{id}");
    let session_id = format!("session-{id}");
    let manifest = ConcurrentObjectiveManifest {
        id,
        created_at: Utc::now(),
        scenario: SCENARIO.to_string(),
        scheduling_arm,
        runtime_commit: runtime_commit(),
        runtime_dirty: runtime_dirty(),
        context_id,
        session_id,
        database_path,
        workspace_root,
        artifact_dir,
        hidden_verifier_path,
        minimum_objectives: MIN_OBJECTIVES,
        objective_discovery_timeout_secs: OBJECTIVE_DISCOVERY_TIMEOUT_SECS,
        overall_timeout_secs: OVERALL_TIMEOUT_SECS,
        quiescence_secs: QUIESCENCE_SECS,
        initial_prompt: scheduling_arm.initial_prompt().to_string(),
        status_prompt: STATUS_PROMPT.to_string(),
        cross_cutting_prompt: CROSS_CUTTING_PROMPT.to_string(),
    };
    let manifest_path = run_root.join("manifest.json");
    std::fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?)?;
    Ok(ConcurrentObjectiveEnvironment {
        run_root,
        manifest_path,
        environment: runtime_environment(&manifest),
        manifest,
    })
}

pub async fn run_forgedepot_eval(
    base_dir: Option<&Path>,
    agent_binary: &Path,
    profile: Option<&ModelProfileIdentity>,
) -> Result<ConcurrentObjectiveRun, DynError> {
    run_forgedepot_eval_with_arm(base_dir, agent_binary, profile, SchedulingArm::Autonomous).await
}

pub async fn run_forgedepot_eval_with_arm(
    base_dir: Option<&Path>,
    agent_binary: &Path,
    profile: Option<&ModelProfileIdentity>,
    scheduling_arm: SchedulingArm,
) -> Result<ConcurrentObjectiveRun, DynError> {
    let environment = create_forgedepot_eval_with_arm(base_dir, scheduling_arm).await?;
    run_created_forgedepot_eval(environment, agent_binary, profile).await
}

pub async fn inspect_forgedepot_eval(
    run_root: &Path,
    profile: Option<ModelProfileIdentity>,
) -> Result<ConcurrentObjectiveReport, DynError> {
    let previous_report = std::fs::read(run_root.join("run_report.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<ConcurrentObjectiveReport>(&bytes).ok());
    let manifest: ConcurrentObjectiveManifest =
        serde_json::from_slice(&std::fs::read(run_root.join("manifest.json"))?)?;
    let store = SqliteStore::new(manifest.database_path.to_string_lossy().as_ref()).await?;
    let events = context_events(&store, &manifest.context_id).await?;
    let objectives = store
        .list_context_objectives(&manifest.context_id, true)
        .await?;
    let activations = store
        .list_context_thread_activations(&manifest.context_id, true)
        .await?;
    let verification = run_hidden_verifier(&manifest)?;
    let started_at = previous_report
        .as_ref()
        .map(|report| report.started_at)
        .unwrap_or(manifest.created_at);
    let finished_at = events
        .iter()
        .map(|event| event.timestamp)
        .max()
        .unwrap_or(started_at);
    let profile = profile
        .or_else(|| {
            previous_report
                .as_ref()
                .and_then(|report| report.model_profile.clone())
        })
        .or_else(|| model_profile_from_run_config(run_root));
    let report = build_report(ReportBuildInput {
        run_root,
        model_profile: profile,
        started_at,
        finished_at,
        restart_performed: previous_report
            .as_ref()
            .is_some_and(|report| report.restart_performed),
        timed_out: previous_report
            .as_ref()
            .is_some_and(|report| report.timed_out),
        objectives,
        activations,
        events,
        probes: previous_report
            .as_ref()
            .map(|report| report.probes.clone())
            .unwrap_or_default(),
        verification,
        manifest: &manifest,
    });
    std::fs::write(
        run_root.join("run_report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(report)
}

async fn run_created_forgedepot_eval(
    environment: ConcurrentObjectiveEnvironment,
    agent_binary: &Path,
    profile: Option<&ModelProfileIdentity>,
) -> Result<ConcurrentObjectiveRun, DynError> {
    let stdout_path = environment.run_root.join("agent.stdout.log");
    let stderr_path = environment.run_root.join("agent.stderr.log");
    File::create(&stdout_path)?;
    File::create(&stderr_path)?;
    let store = SqliteStore::new(
        environment
            .manifest
            .database_path
            .to_string_lossy()
            .as_ref(),
    )
    .await?;
    let started_at = Utc::now();
    let started = Instant::now();
    let mut probes = Vec::new();
    let mut restart_performed = false;
    let mut agent = spawn_agent(
        agent_binary,
        &environment.environment,
        profile,
        &stdout_path,
        &stderr_path,
        &environment.run_root,
    )
    .await?;
    ensure_session(
        &agent,
        &environment.manifest.context_id,
        &environment.manifest.session_id,
    )
    .await?;
    let initial_reply_count = reply_count(&store, &environment.manifest.session_id).await?;
    send_prompt(
        &agent,
        &environment.manifest.session_id,
        &environment.manifest.initial_prompt,
        "initial",
    )
    .await?;
    println!(
        "[ForgeDepot] 已提交初始任务：{}",
        environment.run_root.display()
    );

    let discovered = wait_for_objectives(
        &store,
        &environment.manifest.context_id,
        environment.manifest.minimum_objectives,
        Duration::from_secs(environment.manifest.objective_discovery_timeout_secs),
    )
    .await?;
    println!("[ForgeDepot] 已观察到 {} 个 Objective", discovered.len());

    if discovered.len() >= environment.manifest.minimum_objectives {
        let replies_before = reply_count(&store, &environment.manifest.session_id).await?;
        let sent_at = Utc::now();
        let message_event_id = send_prompt(
            &agent,
            &environment.manifest.session_id,
            &environment.manifest.status_prompt,
            "status-probe",
        )
        .await?;
        probes.push(ProbeRecord {
            kind: "live_status_query".to_string(),
            sent_at,
            reply_count_before: replies_before,
            message_event_id: Some(message_event_id),
            reply_event_ids: Vec::new(),
            reply_texts: Vec::new(),
        });
        tokio::time::sleep(Duration::from_secs(15)).await;

        let replies_before = reply_count(&store, &environment.manifest.session_id).await?;
        let sent_at = Utc::now();
        let message_event_id = send_prompt(
            &agent,
            &environment.manifest.session_id,
            &environment.manifest.cross_cutting_prompt,
            "cross-cutting",
        )
        .await?;
        probes.push(ProbeRecord {
            kind: "cross_cutting_requirement".to_string(),
            sent_at,
            reply_count_before: replies_before,
            message_event_id: Some(message_event_id),
            reply_event_ids: Vec::new(),
            reply_texts: Vec::new(),
        });
        tokio::time::sleep(Duration::from_secs(30)).await;

        if has_nonterminal_objectives(&store, &environment.manifest.context_id).await? {
            println!("[ForgeDepot] 在活动 Objective 期间执行一次 Runtime 重启");
            stop_agent(agent).await?;
            restart_performed = true;
            agent = spawn_agent(
                agent_binary,
                &environment.environment,
                profile,
                &stdout_path,
                &stderr_path,
                &environment.run_root,
            )
            .await?;
        }
    }

    let remaining = Duration::from_secs(environment.manifest.overall_timeout_secs)
        .saturating_sub(started.elapsed());
    let timed_out = if discovered.is_empty() {
        !wait_for_reply_quiescence(
            &store,
            &environment.manifest.context_id,
            &environment.manifest.session_id,
            initial_reply_count,
            remaining,
            Duration::from_secs(environment.manifest.quiescence_secs),
        )
        .await?
    } else {
        !wait_for_terminal_quiescence(
            &store,
            &environment.manifest.context_id,
            remaining,
            Duration::from_secs(environment.manifest.quiescence_secs),
        )
        .await?
    };
    stop_agent(agent).await?;

    let objectives = store
        .list_context_objectives(&environment.manifest.context_id, true)
        .await?;
    let activations = store
        .list_context_thread_activations(&environment.manifest.context_id, true)
        .await?;
    let events = context_events(&store, &environment.manifest.context_id).await?;
    let verification = run_hidden_verifier(&environment.manifest)?;
    let report = build_report(ReportBuildInput {
        run_root: &environment.run_root,
        model_profile: profile.cloned(),
        started_at,
        finished_at: Utc::now(),
        restart_performed,
        timed_out,
        objectives,
        activations,
        events,
        probes,
        verification,
        manifest: &environment.manifest,
    });
    std::fs::write(
        environment.run_root.join("run_report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(ConcurrentObjectiveRun {
        run_root: environment.run_root,
        agent_binary: std::fs::canonicalize(agent_binary)?,
        stdout_path,
        stderr_path,
        report,
    })
}

struct ReportBuildInput<'a> {
    run_root: &'a Path,
    model_profile: Option<ModelProfileIdentity>,
    started_at: DateTime<Utc>,
    finished_at: DateTime<Utc>,
    restart_performed: bool,
    timed_out: bool,
    objectives: Vec<ObjectiveRecord>,
    activations: Vec<ThreadActivationRecord>,
    events: Vec<Event>,
    probes: Vec<ProbeRecord>,
    verification: VerificationReport,
    manifest: &'a ConcurrentObjectiveManifest,
}

fn build_report(input: ReportBuildInput<'_>) -> ConcurrentObjectiveReport {
    let ReportBuildInput {
        run_root,
        model_profile,
        started_at,
        finished_at,
        restart_performed,
        timed_out,
        objectives,
        activations,
        events,
        mut probes,
        verification,
        manifest,
    } = input;
    let evaluation_intervals = evaluation_intervals(&events);
    let peak_concurrent_evaluations = peak_concurrency(&evaluation_intervals, finished_at);
    let objective_launch_spread_seconds = objective_launch_spread(&evaluation_intervals);
    let evaluation_active_seconds = evaluation_intervals
        .iter()
        .map(|interval| {
            (interval.finished_at.unwrap_or(finished_at) - interval.started_at)
                .to_std()
                .map(|duration| duration.as_secs_f64())
                .unwrap_or_default()
        })
        .sum::<f64>();
    let wall_seconds = (finished_at - started_at)
        .to_std()
        .map(|duration| duration.as_secs_f64())
        .unwrap_or_default();
    let effective_parallelism = if wall_seconds > 0.0 {
        evaluation_active_seconds / wall_seconds
    } else {
        0.0
    };
    let objective_tokens_used = objectives
        .iter()
        .map(|objective| objective.tokens_used)
        .sum();
    let (objective_file_write_attempts, cross_objective_file_overlaps) =
        objective_file_write_coordination(&events, &objectives);
    let terminal_objective_count = objectives
        .iter()
        .filter(|objective| objective.status.is_terminal())
        .count();
    let completed_objective_count = objectives
        .iter()
        .filter(|objective| objective.status == ObjectiveStatus::Completed)
        .count();
    let failed_or_cancelled_objective_count = objectives
        .iter()
        .filter(|objective| {
            matches!(
                objective.status,
                ObjectiveStatus::Failed | ObjectiveStatus::Cancelled
            )
        })
        .count();
    let nonterminal_activations = activations
        .iter()
        .filter(|activation| !activation.status.is_terminal())
        .count();
    let failed_activation_count = activations
        .iter()
        .filter(|activation| activation.status.as_str() == "failed")
        .count();
    for probe in &mut probes {
        probe.reply_event_ids.clear();
        probe.reply_texts.clear();
        let Some(message_event_id) = probe.message_event_id.as_deref() else {
            continue;
        };
        for event in events.iter().filter(|event| event.topic == "chat/reply") {
            if event
                .payload
                .get("root_turn_id")
                .and_then(|value| value.as_str())
                != Some(message_event_id)
            {
                continue;
            }
            probe.reply_event_ids.push(event.id.clone());
            if let Some(text) = event.payload.get("text").and_then(|value| value.as_str()) {
                probe.reply_texts.push(text.to_string());
            }
        }
    }
    let (valid_probe_count, answered_probe_count, probe_reply_success) =
        probe_reply_coverage(&probes);
    let replies = events
        .iter()
        .filter(|event| event.topic == "chat/reply")
        .filter_map(|event| event.payload.get("text").and_then(|value| value.as_str()))
        .map(str::to_string)
        .collect::<Vec<_>>();
    let model_attempts = events
        .iter()
        .filter(|event| {
            event.topic == "runtime/model_attempt_state"
                && event.payload.get("state").and_then(|value| value.as_str()) == Some("queued")
        })
        .count();
    let physical_tool_calls = events
        .iter()
        .filter(|event| event.topic == "chat/tool_output")
        .filter(|event| {
            event
                .payload
                .get("tool_name")
                .and_then(|value| value.as_str())
                != Some("context_tx")
        })
        .count();
    let failed_tool_outputs = events
        .iter()
        .filter(|event| event.topic == "chat/tool_output")
        .filter(|event| tool_output_failed(event))
        .count();
    let context_transaction_conflicts = events
        .iter()
        .filter(|event| {
            if event.topic == "chat/context_tx_failed" {
                return true;
            }
            if event.topic != "chat/tool_output"
                || event
                    .payload
                    .get("tool_name")
                    .and_then(|value| value.as_str())
                    != Some("context_tx")
                || !tool_output_failed(event)
            {
                return false;
            }
            let text = event_text(event).to_lowercase();
            text.contains("version conflict")
                || text.contains("expected version")
                || text.contains("版本冲突")
        })
        .count();
    let objective_count = objectives.len();
    let terminal_failure_without_reply =
        nonterminal_activations == 0 && failed_activation_count > 0 && replies.is_empty();
    let objective_mechanism_adopted = objective_count >= manifest.minimum_objectives;
    let structural_coordination_success = !timed_out
        && objective_count >= manifest.minimum_objectives
        && terminal_objective_count == objective_count
        && failed_or_cancelled_objective_count == 0
        && peak_concurrent_evaluations >= 2
        && nonterminal_activations == 0;
    let coordination_success = structural_coordination_success && probe_reply_success;
    let project_success = !timed_out && verification.passed;
    let success = project_success && coordination_success;
    ConcurrentObjectiveReport {
        run_root: run_root.to_path_buf(),
        model_profile,
        started_at,
        finished_at,
        duration_seconds: wall_seconds,
        scheduling_arm: manifest.scheduling_arm,
        objective_mechanism_adopted,
        restart_performed,
        timed_out,
        objectives,
        objective_count,
        terminal_objective_count,
        completed_objective_count,
        failed_or_cancelled_objective_count,
        peak_concurrent_evaluations,
        objective_launch_spread_seconds,
        evaluation_active_seconds,
        effective_parallelism,
        evaluation_intervals,
        objective_tokens_used,
        objective_file_write_attempts,
        cross_objective_file_overlaps,
        model_attempts,
        physical_tool_calls,
        failed_tool_outputs,
        context_transaction_conflicts,
        activations,
        nonterminal_activations,
        failed_activation_count,
        terminal_failure_without_reply,
        replies,
        probes,
        valid_probe_count,
        answered_probe_count,
        probe_reply_success,
        database_bytes: std::fs::metadata(&manifest.database_path)
            .map(|metadata| metadata.len())
            .unwrap_or_default(),
        verification,
        project_success,
        structural_coordination_success,
        coordination_success,
        success,
    }
}

fn runtime_environment(manifest: &ConcurrentObjectiveManifest) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("MORPHZ_SESSION_ID".to_string(), manifest.session_id.clone()),
        ("MORPHZ_CONTEXT_ID".to_string(), manifest.context_id.clone()),
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
        (
            "MORPHZ_PERMISSION_MODE".to_string(),
            "auto_review".to_string(),
        ),
        ("MORPHZ_EXEC_NETWORK".to_string(), "false".to_string()),
        (
            "MORPHZ_REPLY_WAIT_NOTICE_SECS".to_string(),
            "600".to_string(),
        ),
    ])
}

async fn spawn_agent(
    agent_binary: &Path,
    environment: &BTreeMap<String, String>,
    profile: Option<&ModelProfileIdentity>,
    stdout_path: &Path,
    stderr_path: &Path,
    run_root: &Path,
) -> Result<AgentProcess, DynError> {
    let stdout = OpenOptions::new().append(true).open(stdout_path)?;
    let stderr = OpenOptions::new().append(true).open(stderr_path)?;
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    let bind = format!("127.0.0.1:{port}");
    let base_url = format!("http://{bind}");
    let mut command = Command::new(agent_binary);
    command
        .envs(environment)
        .arg("serve")
        .arg(format!("--bind={bind}"))
        .stdin(StdStdio::null())
        .stdout(StdStdio::from(stdout))
        .stderr(StdStdio::from(stderr));
    if let Some(profile) = profile {
        configure_agent_model_profile_with_overrides(
            &mut command,
            run_root,
            profile.protocol.as_str(),
            &profile.base_url,
            &profile.model,
            &profile.api_key_env,
            &EvalRuntimeOverrides {
                model_provider_max_in_flight: Some(8),
                activation_max_in_flight: Some(16),
                context_soft_token_limit: Some(196_608),
                context_hard_token_limit: Some(262_144),
                context_maintenance_reserve_tokens: Some(32_768),
            },
        )?;
    }
    let child = command.spawn()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;
    let mut agent = AgentProcess {
        child,
        base_url,
        client,
    };
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if agent
            .client
            .get(format!("{}/health", agent.base_url))
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
        {
            return Ok(agent);
        }
        if let Some(status) = agent.child.try_wait()? {
            return Err(format!("Morphz HTTP Runtime 在启动完成前退出：{status}").into());
        }
        if Instant::now() >= deadline {
            agent.child.kill().await?;
            let _ = agent.child.wait().await;
            return Err("等待 Morphz HTTP Runtime 启动超过 60 秒".into());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn ensure_session(
    agent: &AgentProcess,
    context_id: &str,
    session_id: &str,
) -> Result<(), DynError> {
    let existing = agent
        .client
        .get(format!("{}/api/sessions/{session_id}", agent.base_url))
        .send()
        .await?;
    if existing.status().is_success() {
        return Ok(());
    }
    if existing.status() != reqwest::StatusCode::NOT_FOUND {
        return Err(format!(
            "读取评测 Session 失败：HTTP {} {}",
            existing.status(),
            existing.text().await.unwrap_or_default()
        )
        .into());
    }
    let created = agent
        .client
        .post(format!("{}/api/sessions", agent.base_url))
        .json(&json!({
            "id": session_id,
            "title": "ForgeDepot concurrent objective benchmark",
            "mount": {"type": "existing_context", "context_id": context_id}
        }))
        .send()
        .await?;
    if !created.status().is_success() {
        return Err(format!(
            "创建评测 Session 失败：HTTP {} {}",
            created.status(),
            created.text().await.unwrap_or_default()
        )
        .into());
    }
    Ok(())
}

async fn send_prompt(
    agent: &AgentProcess,
    session_id: &str,
    prompt: &str,
    label: &str,
) -> Result<String, DynError> {
    let response = agent
        .client
        .post(format!(
            "{}/api/sessions/{session_id}/messages",
            agent.base_url
        ))
        .json(&json!({
            "text": prompt,
            "client_message_id": format!(
                "forgedepot-{label}-{}",
                Utc::now().timestamp_nanos_opt().unwrap_or_default()
            )
        }))
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(format!(
            "提交评测消息失败：HTTP {} {}",
            response.status(),
            response.text().await.unwrap_or_default()
        )
        .into());
    }
    let body = response.json::<serde_json::Value>().await?;
    body.get("event_id")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .ok_or_else(|| "提交评测消息成功，但响应缺少 event_id".into())
}

async fn stop_agent(mut agent: AgentProcess) -> Result<(), DynError> {
    if agent.child.try_wait()?.is_none() {
        agent.child.kill().await?;
        let _ = agent.child.wait().await?;
    }
    Ok(())
}

async fn wait_for_objectives(
    store: &SqliteStore,
    context_id: &str,
    minimum: usize,
    timeout: Duration,
) -> Result<Vec<ObjectiveRecord>, DynError> {
    let started = Instant::now();
    loop {
        let objectives = store.list_context_objectives(context_id, true).await?;
        if objectives.len() >= minimum || started.elapsed() >= timeout {
            return Ok(objectives);
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

async fn wait_for_terminal_quiescence(
    store: &SqliteStore,
    context_id: &str,
    timeout: Duration,
    quiet_period: Duration,
) -> Result<bool, DynError> {
    let started = Instant::now();
    let mut terminal_since = None::<Instant>;
    let mut next_progress = Duration::from_secs(60);
    loop {
        let objectives = store.list_context_objectives(context_id, true).await?;
        let activations = store
            .list_context_thread_activations(context_id, false)
            .await?;
        let terminal = !objectives.is_empty()
            && objectives
                .iter()
                .all(|objective| objective.status.is_terminal())
            && activations.is_empty();
        if terminal {
            let since = terminal_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= quiet_period {
                return Ok(true);
            }
        } else {
            terminal_since = None;
        }
        if started.elapsed() >= timeout {
            return Ok(false);
        }
        if started.elapsed() >= next_progress {
            println!(
                "[ForgeDepot] 仍在运行：{} Objectives，{} 非终态 Activations",
                objectives
                    .iter()
                    .filter(|objective| !objective.status.is_terminal())
                    .count(),
                activations.len()
            );
            next_progress += Duration::from_secs(60);
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

async fn wait_for_reply_quiescence(
    store: &SqliteStore,
    context_id: &str,
    session_id: &str,
    initial_reply_count: usize,
    timeout: Duration,
    quiet_period: Duration,
) -> Result<bool, DynError> {
    let started = Instant::now();
    let mut terminal_since = None::<Instant>;
    loop {
        let activations = store
            .list_context_thread_activations(context_id, false)
            .await?;
        let replies = reply_count(store, session_id).await?;
        let terminal = replies > initial_reply_count && activations.is_empty();
        if terminal {
            let since = terminal_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= quiet_period {
                return Ok(true);
            }
        } else {
            terminal_since = None;
        }
        if started.elapsed() >= timeout {
            return Ok(false);
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

async fn has_nonterminal_objectives(
    store: &SqliteStore,
    context_id: &str,
) -> Result<bool, DynError> {
    Ok(!store
        .list_context_objectives(context_id, false)
        .await?
        .is_empty())
}

async fn reply_count(store: &SqliteStore, session_id: &str) -> Result<usize, DynError> {
    Ok(store
        .query(QueryFilter {
            session_id: Some(session_id.to_string()),
            topic: Some("chat/reply".to_string()),
            ..Default::default()
        })
        .await?
        .len())
}

async fn context_events(store: &SqliteStore, context_id: &str) -> Result<Vec<Event>, DynError> {
    store
        .query(QueryFilter {
            context_id: Some(context_id.to_string()),
            ..Default::default()
        })
        .await
}

fn evaluation_intervals(events: &[Event]) -> Vec<EvaluationInterval> {
    let mut open = HashMap::<String, EvaluationInterval>::new();
    let mut finished = Vec::new();
    for event in events {
        let Some(objective_id) = event
            .payload
            .get("objective_id")
            .and_then(|value| value.as_str())
        else {
            continue;
        };
        let evaluation_id = event
            .payload
            .get("active_evaluation_id")
            .and_then(|value| value.as_str());
        if event.topic == "objective/evaluation_started" {
            if let Some(evaluation_id) = evaluation_id {
                // A recovered Objective can start a new fenced Evaluation without the
                // crashed process ever emitting `evaluation_finished` for the old one.
                // Only one Evaluation may own an Objective at a time, so the new start
                // is the authoritative end boundary for any older open interval.
                let superseded = open
                    .iter()
                    .filter(|(_, interval)| interval.objective_id == objective_id)
                    .map(|(key, _)| key.clone())
                    .collect::<Vec<_>>();
                for key in superseded {
                    if let Some(mut interval) = open.remove(&key) {
                        interval.finished_at = Some(event.timestamp);
                        finished.push(interval);
                    }
                }
                open.insert(
                    evaluation_id.to_string(),
                    EvaluationInterval {
                        objective_id: objective_id.to_string(),
                        evaluation_id: evaluation_id.to_string(),
                        started_at: event.timestamp,
                        finished_at: None,
                    },
                );
            }
        } else if event.topic == "objective/evaluation_finished" {
            if let Some((key, _)) = open
                .iter()
                .filter(|(_, interval)| interval.objective_id == objective_id)
                .max_by_key(|(_, interval)| interval.started_at)
                .map(|(key, value)| (key.clone(), value.clone()))
            {
                if let Some(mut interval) = open.remove(&key) {
                    interval.finished_at = Some(event.timestamp);
                    finished.push(interval);
                }
            }
        }
    }
    finished.extend(open.into_values());
    finished.sort_by_key(|interval| interval.started_at);
    finished
}

fn peak_concurrency(intervals: &[EvaluationInterval], open_end: DateTime<Utc>) -> usize {
    let mut points = Vec::with_capacity(intervals.len() * 2);
    for interval in intervals {
        points.push((interval.started_at, 1i32));
        points.push((interval.finished_at.unwrap_or(open_end), -1i32));
    }
    points.sort_by_key(|(time, delta)| (*time, *delta));
    let mut active = 0i32;
    let mut peak = 0i32;
    for (_, delta) in points {
        active += delta;
        peak = peak.max(active);
    }
    peak.max(0) as usize
}

fn objective_launch_spread(intervals: &[EvaluationInterval]) -> f64 {
    let mut first_start = HashMap::<&str, DateTime<Utc>>::new();
    for interval in intervals {
        first_start
            .entry(interval.objective_id.as_str())
            .and_modify(|started_at| *started_at = (*started_at).min(interval.started_at))
            .or_insert(interval.started_at);
    }
    if first_start.len() < 2 {
        return 0.0;
    }
    let Some(earliest) = first_start.values().min().copied() else {
        return 0.0;
    };
    let Some(latest) = first_start.values().max().copied() else {
        return 0.0;
    };
    (latest - earliest)
        .to_std()
        .map(|duration| duration.as_secs_f64())
        .unwrap_or_default()
}

fn probe_reply_coverage(probes: &[ProbeRecord]) -> (usize, usize, bool) {
    let valid = probes
        .iter()
        .filter(|probe| probe.message_event_id.is_some())
        .count();
    let answered = probes
        .iter()
        .filter(|probe| probe.message_event_id.is_some() && !probe.reply_event_ids.is_empty())
        .count();
    (valid, answered, valid == answered)
}

fn objective_file_write_coordination(
    events: &[Event],
    objectives: &[ObjectiveRecord],
) -> (usize, Vec<CrossObjectiveFileOverlap>) {
    let mut writes = 0usize;
    let mut paths = BTreeMap::<String, (BTreeSet<String>, usize)>::new();
    for event in events
        .iter()
        .filter(|event| event.topic == "runtime/tool_calls_selected")
    {
        let objective_id = event
            .payload
            .get("objective_id")
            .and_then(|value| value.as_str())
            .or_else(|| {
                let root_turn_id = event
                    .payload
                    .get("root_turn_id")
                    .and_then(|value| value.as_str())?;
                objectives
                    .iter()
                    .map(|objective| objective.id.as_str())
                    .find(|objective_id| root_turn_id.contains(objective_id))
            });
        let Some(objective_id) = objective_id else {
            continue;
        };
        let Some(calls) = event
            .payload
            .get("calls")
            .and_then(|value| value.as_array())
        else {
            continue;
        };
        for call in calls {
            let Some(name) = call.get("name").and_then(|value| value.as_str()) else {
                continue;
            };
            if !matches!(name, "write" | "edit") {
                continue;
            }
            let Some(arguments) = call.get("arguments").and_then(|value| value.as_str()) else {
                continue;
            };
            let Ok(arguments) = serde_json::from_str::<serde_json::Value>(arguments) else {
                continue;
            };
            let Some(path) = arguments.get("path").and_then(|value| value.as_str()) else {
                continue;
            };
            writes += 1;
            let entry = paths.entry(path.to_string()).or_default();
            entry.0.insert(objective_id.to_string());
            entry.1 += 1;
        }
    }
    let overlaps = paths
        .into_iter()
        .filter(|(_, (objective_ids, _))| objective_ids.len() > 1)
        .map(
            |(path, (objective_ids, write_attempts))| CrossObjectiveFileOverlap {
                path,
                objective_ids: objective_ids.into_iter().collect(),
                write_attempts,
            },
        )
        .collect();
    (writes, overlaps)
}

fn tool_output_failed(event: &Event) -> bool {
    event
        .payload
        .get("tool_status")
        .and_then(|value| value.as_str())
        .is_some_and(|status| matches!(status, "failed" | "rejected" | "cancelled"))
        || event_text(event).starts_with("执行失败:")
}

fn event_text(event: &Event) -> String {
    event
        .payload
        .get("text")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string()
}

fn run_hidden_verifier(
    manifest: &ConcurrentObjectiveManifest,
) -> Result<VerificationReport, DynError> {
    let output_path = manifest
        .hidden_verifier_path
        .with_file_name("verification.json");
    let output = StdCommand::new("python3")
        .arg(&manifest.hidden_verifier_path)
        .arg(&manifest.workspace_root)
        .arg(&output_path)
        .stdin(StdStdio::null())
        .output()?;
    let mut report = if output_path.is_file() {
        serde_json::from_slice::<VerificationReport>(&std::fs::read(output_path)?)?
    } else {
        VerificationReport::default()
    };
    report.stdout = String::from_utf8_lossy(&output.stdout).to_string();
    report.stderr = String::from_utf8_lossy(&output.stderr).to_string();
    report.passed &= output.status.success();
    Ok(report)
}

fn runtime_commit() -> Option<String> {
    StdCommand::new("git")
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim().to_string())
}

fn model_profile_from_run_config(run_root: &Path) -> Option<ModelProfileIdentity> {
    let value = std::fs::read_to_string(run_root.join("morphz-home/eval-provider.toml"))
        .ok()?
        .parse::<toml::Value>()
        .ok()?;
    let provider = value.get("llm")?.get("provider")?.as_str()?;
    let model = value.get("llm")?.get("model")?.as_str()?;
    let provider_config = value.get("providers")?.get(provider)?;
    let protocol = match provider_config.get("protocol")?.as_str()? {
        "openai-responses" => ModelProtocol::OpenaiResponses,
        "openai-chat" => ModelProtocol::OpenaiChat,
        "anthropic-messages" => ModelProtocol::AnthropicMessages,
        "gemini-content" => ModelProtocol::GeminiContent,
        _ => return None,
    };
    let credential = provider_config.get("credential")?.as_str()?;
    Some(ModelProfileIdentity {
        name: provider.to_string(),
        protocol,
        base_url: provider_config.get("base_url")?.as_str()?.to_string(),
        model: model.to_string(),
        api_key_env: value
            .get("credentials")?
            .get(credential)?
            .get("name")?
            .as_str()?
            .to_string(),
    })
}

fn runtime_dirty() -> bool {
    StdCommand::new("git")
        .args(["status", "--porcelain"])
        .output()
        .ok()
        .is_some_and(|output| output.status.success() && !output.stdout.is_empty())
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

const HIDDEN_VERIFIER: &str = r##"#!/usr/bin/env python3
import concurrent.futures
import hashlib
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.request import urlopen

workspace = Path(sys.argv[1]).resolve()
report_path = Path(sys.argv[2]).resolve()
checks = []

def check(name, fn):
    try:
        detail = fn()
        checks.append({"id": name, "passed": True, "detail": str(detail or "ok")})
    except Exception as exc:
        checks.append({"id": name, "passed": False, "detail": repr(exc)})

def run(args, cwd=workspace, ok=True, timeout=180):
    result = subprocess.run(args, cwd=cwd, text=True, capture_output=True, timeout=timeout)
    if ok and result.returncode != 0:
        raise RuntimeError(f"command failed {args}: {result.stderr[-2000:]}")
    return result

def manifest(path, name, version, deps=None, payload="payload"):
    path.mkdir(parents=True, exist_ok=True)
    deps = deps or {}
    lines = ["[package]", f'name = "{name}"', f'version = "{version}"', "", "[dependencies]"]
    lines += [f'{key} = "{value}"' for key, value in deps.items()]
    (path / "forgedepot.toml").write_text("\n".join(lines) + "\n")
    (path / "payload.txt").write_text(payload)

def binary():
    candidates = [workspace / "target/debug/forgedepot", workspace / "target/release/forgedepot"]
    for item in candidates:
        if item.is_file():
            return item
    raise RuntimeError("forgedepot binary not found")

def cli(root, *args, ok=True):
    return run([str(binary()), "--root", str(root), *map(str, args)], ok=ok)

check("cargo-test-offline", lambda: run(["cargo", "test", "--offline", "--all-targets"], timeout=600).stdout[-1000:])
check("cargo-build-offline", lambda: run(["cargo", "build", "--offline"], timeout=600).stdout[-1000:])

temp = Path(tempfile.mkdtemp(prefix="forgedepot-hidden-"))
root = temp / "registry"
packages = temp / "packages"
lock_old = temp / "old.lock"
lock_new = temp / "new.lock"
dest = temp / "install"

def functional():
    cli(root, "init")
    cli(root, "init")
    manifest(packages / "util-1.0", "util", "1.0.0", payload="util-v1")
    manifest(packages / "util-1.1", "util", "1.1.0", payload="util-v11")
    manifest(packages / "app", "app", "2.0.0", {"util": "^1.0"}, "app-v2")
    for item in [packages / "util-1.0", packages / "util-1.1", packages / "app"]:
        cli(root, "publish", item)
    cli(root, "publish", packages / "util-1.1")
    cli(root, "resolve", "app@^2", "--lock", lock_old)
    old = json.loads(lock_old.read_text())
    selected = {p["name"]: p["version"] for p in old["packages"]}
    assert selected.get("util") == "1.1.0", selected
    cli(root, "yank", "util@1.1.0")
    cli(root, "install", "--lock", lock_old, "--dest", dest)
    assert (dest / "util" / "1.1.0" / "payload.txt").read_text() == "util-v11"
    cli(root, "resolve", "app@^2", "--lock", lock_new)
    new = json.loads(lock_new.read_text())
    selected = {p["name"]: p["version"] for p in new["packages"]}
    assert selected.get("util") == "1.0.0", selected
    search = json.loads(cli(root, "search", "uti", "--json").stdout)
    assert any(p["version"] == "1.1.0" and p["yanked"] for p in search)
    return "resolve/install/yank/search contract passed"

check("functional-contract", functional)

def concurrent_publish():
    manifest(packages / "race", "race", "1.0.0", payload="race")
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda _: cli(root, "publish", packages / "race", ok=False), range(6)))
    assert all(result.returncode == 0 for result in results), [r.stderr for r in results]
    return "six duplicate publishers were idempotent"

check("concurrent-idempotent-publish", concurrent_publish)

def conflicting_publish():
    manifest(packages / "race-conflict", "race", "1.0.0", payload="different")
    result = cli(root, "publish", packages / "race-conflict", ok=False)
    assert result.returncode != 0
    return result.stderr[-500:]

check("conflicting-publish-rejected", conflicting_publish)

def corrupt_blob():
    lock = json.loads(lock_new.read_text())
    target = next(p for p in lock["packages"] if p["name"] == "util")
    blob = root / "blobs" / "sha256" / target["sha256"]
    if blob.is_dir():
        file = next(p for p in blob.rglob("*") if p.is_file())
        file.write_text("corrupt")
    else:
        blob.write_text("corrupt")
    result = cli(root, "install", "--lock", lock_new, "--dest", temp / "corrupt-dest", ok=False)
    assert result.returncode != 0
    return result.stderr[-500:]

check("blob-corruption-detected", corrupt_blob)

def http_health():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    ready = temp / "ready.txt"
    proc = subprocess.Popen(
        [str(binary()), "--root", str(root), "serve", "--bind", f"127.0.0.1:{port}", "--ready-file", str(ready)],
        cwd=workspace, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        deadline = time.time() + 15
        while time.time() < deadline and not ready.exists() and proc.poll() is None:
            time.sleep(0.1)
        assert ready.exists(), proc.stderr.read() if proc.poll() is not None else "ready file absent"
        with urlopen(f"http://127.0.0.1:{port}/health", timeout=3) as response:
            payload = json.loads(response.read())
            assert response.status == 200
            assert payload
        with urlopen(f"http://127.0.0.1:{port}/api/packages?q=app", timeout=3) as response:
            assert isinstance(json.loads(response.read()), list)
        return "health and search endpoints passed"
    finally:
        if proc.poll() is None:
            proc.send_signal(signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()

check("http-contract", http_health)

passed = all(item["passed"] for item in checks)
report = {"passed": passed, "checks": checks, "stdout": "", "stderr": ""}
report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2))
shutil.rmtree(temp, ignore_errors=True)
raise SystemExit(0 if passed else 1)
"##;

#[cfg(test)]
mod tests {
    use super::*;

    fn objective_event(
        id: &str,
        topic: &str,
        objective_id: &str,
        evaluation_id: Option<&str>,
        timestamp: DateTime<Utc>,
    ) -> Event {
        let mut payload = serde_json::Map::new();
        payload.insert("objective_id".to_string(), json!(objective_id));
        if let Some(evaluation_id) = evaluation_id {
            payload.insert("active_evaluation_id".to_string(), json!(evaluation_id));
        }
        let mut event = Event::new(
            id.to_string(),
            "test".to_string(),
            "runtime_control".to_string(),
            topic.to_string(),
            payload,
        );
        event.timestamp = timestamp;
        event
    }

    #[test]
    fn peak_concurrency_detects_overlap() {
        let base = Utc::now();
        let intervals = vec![
            EvaluationInterval {
                objective_id: "a".to_string(),
                evaluation_id: "ea".to_string(),
                started_at: base,
                finished_at: Some(base + chrono::Duration::seconds(10)),
            },
            EvaluationInterval {
                objective_id: "b".to_string(),
                evaluation_id: "eb".to_string(),
                started_at: base + chrono::Duration::seconds(2),
                finished_at: Some(base + chrono::Duration::seconds(8)),
            },
        ];
        assert_eq!(peak_concurrency(&intervals, base), 2);
        assert_eq!(objective_launch_spread(&intervals), 2.0);
    }

    #[test]
    fn recovered_evaluation_closes_superseded_open_interval() {
        let base = Utc::now();
        let events = vec![
            objective_event(
                "start-a1",
                "objective/evaluation_started",
                "a",
                Some("a1"),
                base,
            ),
            objective_event(
                "start-b1",
                "objective/evaluation_started",
                "b",
                Some("b1"),
                base + chrono::Duration::seconds(1),
            ),
            objective_event(
                "start-a2",
                "objective/evaluation_started",
                "a",
                Some("a2"),
                base + chrono::Duration::seconds(5),
            ),
            objective_event(
                "finish-a",
                "objective/evaluation_finished",
                "a",
                None,
                base + chrono::Duration::seconds(8),
            ),
            objective_event(
                "finish-b",
                "objective/evaluation_finished",
                "b",
                None,
                base + chrono::Duration::seconds(9),
            ),
        ];

        let intervals = evaluation_intervals(&events);
        assert_eq!(intervals.len(), 3);
        assert_eq!(
            intervals
                .iter()
                .find(|interval| interval.evaluation_id == "a1")
                .and_then(|interval| interval.finished_at),
            Some(base + chrono::Duration::seconds(5))
        );
        assert_eq!(
            peak_concurrency(&intervals, base + chrono::Duration::seconds(10)),
            2
        );
    }

    #[test]
    fn probe_coverage_ignores_legacy_records_and_requires_causal_reply() {
        let base = Utc::now();
        let probes = vec![
            ProbeRecord {
                kind: "legacy".to_string(),
                sent_at: base,
                reply_count_before: 0,
                message_event_id: None,
                reply_event_ids: Vec::new(),
                reply_texts: Vec::new(),
            },
            ProbeRecord {
                kind: "answered".to_string(),
                sent_at: base,
                reply_count_before: 0,
                message_event_id: Some("message-1".to_string()),
                reply_event_ids: vec!["reply-1".to_string()],
                reply_texts: vec!["done".to_string()],
            },
            ProbeRecord {
                kind: "missing".to_string(),
                sent_at: base,
                reply_count_before: 0,
                message_event_id: Some("message-2".to_string()),
                reply_event_ids: Vec::new(),
                reply_texts: Vec::new(),
            },
        ];

        assert_eq!(probe_reply_coverage(&probes), (2, 1, false));
    }

    #[tokio::test]
    async fn fixture_keeps_verifier_outside_agent_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let environment = create_forgedepot_eval(Some(temp.path())).await.unwrap();
        assert!(environment
            .manifest
            .workspace_root
            .join("PROJECT_SPEC.md")
            .is_file());
        assert!(environment.manifest.hidden_verifier_path.is_file());
        assert!(!environment
            .manifest
            .hidden_verifier_path
            .starts_with(&environment.manifest.workspace_root));
    }
}
