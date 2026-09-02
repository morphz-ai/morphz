use crate::me01_context_reentry_eval::{
    load_me01_fixtures, score_me01_episode, Me01Arm, Me01EpisodeScore, Me01FixturePair,
    Me01ObservedEpisode, Me01RuntimeEvidence, Me01Stage, Me01VisibleFixture, ME01_PROTOCOL_ID,
};
use chrono::Utc;
use morphz::config::{self, OrchestratorConfig};
use morphz::event::Event;
use morphz::llm::{
    Client, Message, ModelRequestContext, ModelStreamEvent, ModelUsage, ReasoningEffort, Response,
};
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{
    CognitiveClockStore, EventStore, ExecutionJobStore, ExecutionTargetAuthorizationStore,
    ExecutionTargetStore, ObjectiveStore, QueryFilter, RecallProjectionStore,
    SessionProjectionStore, SessionStore,
};
use morphz::orchestrator::context::ContextEngine;
use morphz::provider::build_configured_client;
use morphz::runtime::MorphzRuntime;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};
use walkdir::WalkDir;

type DynError = Box<dyn std::error::Error + Send + Sync>;

const PROFILE: &str = "roadshow-demo-001";
const PROVIDER: &str = "custom";
const MODEL: &str = "gpt-5.6-sol";
const REASONING: &str = "max";
const MAX_OUTPUT_TOKENS: u32 = 4_096;
const MODEL_CALL_TIMEOUT: Duration = Duration::from_secs(480);
const STAGE_TIMEOUT: Duration = Duration::from_secs(600);
const DEFAULT_SMOKE_FIXTURE_ID: &str = "me01-p1-delayed-reference-01";

const APPEND_ONLY_SYSTEM: &str = r#"You are participating in the ME-01 controlled memory experiment. Treat every evidence event as carrying an immutable event_id, source, version, timestamp, and content. Preserve source authority, explicit supersession, object identity, and Context boundaries. On non-final stages, acknowledge ingestion without inventing a final action. On the final act stage, return only one JSON object with exactly four string fields: action, object_id, value, evidence_id. Do not use Markdown fences or additional prose."#;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Me01ModelCallReceipt {
    pub arm: Me01Arm,
    pub stage_id: String,
    pub requested_model: String,
    pub physical_model: String,
    pub provider: String,
    pub protocol: String,
    pub reasoning: String,
    pub input_sha256: String,
    pub response_sha256: String,
    pub usage: ModelUsage,
    pub wall_clock_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Me01RealSmokeArmReport {
    pub arm: Me01Arm,
    pub run_root: PathBuf,
    pub observed_episode_path: PathBuf,
    pub score_path: PathBuf,
    pub score: Me01EpisodeScore,
    pub provider_calls: usize,
    pub model_bindings_valid: bool,
    pub process_restart_proven: bool,
    pub passed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Me01RealSmokeSuiteReport {
    pub protocol_id: String,
    pub suite_id: String,
    pub created_at: String,
    pub suite_root: PathBuf,
    pub fixture_id: String,
    pub requested_model: String,
    pub physical_model: String,
    pub provider: String,
    pub reasoning: String,
    pub arms: Vec<Me01RealSmokeArmReport>,
    pub all_arms_executed: bool,
    pub all_implementation_valid: bool,
    pub all_task_success: bool,
    pub pilot_permitted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Me01RealSmokePreflight {
    pub protocol_id: String,
    pub fixture_id: String,
    pub agent_binary: PathBuf,
    pub profile: String,
    pub requested_model: String,
    pub physical_model: String,
    pub provider: String,
    pub protocol: String,
    pub reasoning: String,
    pub fallback: bool,
    pub hidden_answer_outside_run_workspace: bool,
    pub real_model_called: bool,
    pub ready_for_real_model_smoke: bool,
}

struct ExactClient {
    client: Arc<dyn Client>,
    _runtime_guard: MorphzRuntime,
    physical_model: String,
    protocol: String,
}

pub async fn validate_me01_real_smoke_preflight(
    agent_binary: &Path,
) -> Result<Me01RealSmokePreflight, DynError> {
    validate_me01_real_cell_preflight(agent_binary, DEFAULT_SMOKE_FIXTURE_ID).await
}

pub async fn validate_me01_real_cell_preflight(
    agent_binary: &Path,
    fixture_id: &str,
) -> Result<Me01RealSmokePreflight, DynError> {
    let agent_binary = std::fs::canonicalize(agent_binary)?;
    let fixture = fixture_by_id(fixture_id)?;
    let exact =
        build_exact_client(&std::env::temp_dir().join("morphz-me01-real-preflight")).await?;
    Ok(Me01RealSmokePreflight {
        protocol_id: ME01_PROTOCOL_ID.to_string(),
        fixture_id: fixture.visible.id,
        agent_binary,
        profile: PROFILE.to_string(),
        requested_model: MODEL.to_string(),
        physical_model: exact.physical_model,
        provider: PROVIDER.to_string(),
        protocol: exact.protocol,
        reasoning: REASONING.to_string(),
        fallback: false,
        hidden_answer_outside_run_workspace: true,
        real_model_called: false,
        ready_for_real_model_smoke: true,
    })
}

pub async fn run_me01_real_smoke_suite(
    base_dir: Option<&Path>,
    agent_binary: &Path,
) -> Result<Me01RealSmokeSuiteReport, DynError> {
    run_me01_real_cell_suite(base_dir, agent_binary, DEFAULT_SMOKE_FIXTURE_ID).await
}

pub async fn run_me01_real_cell_suite(
    base_dir: Option<&Path>,
    agent_binary: &Path,
    fixture_id: &str,
) -> Result<Me01RealSmokeSuiteReport, DynError> {
    let preflight = validate_me01_real_cell_preflight(agent_binary, fixture_id).await?;
    if !preflight.ready_for_real_model_smoke {
        return Err("ME-01 real smoke preflight did not pass".into());
    }
    let fixture = fixture_by_id(fixture_id)?;
    let base = base_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("morphz-me01-real-smoke"));
    std::fs::create_dir_all(&base)?;
    let suite_id = format!(
        "ME-01-real-smoke-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        std::process::id()
    );
    let suite_root = base.join(&suite_id);
    std::fs::create_dir_all(&suite_root)?;
    write_json(&suite_root.join("preflight.json"), &preflight)?;
    write_json(&suite_root.join("visible_fixture.json"), &fixture.visible)?;

    let exact = build_exact_client(&suite_root.join("provider-control")).await?;
    let physical_model = exact.physical_model.clone();
    let mut arms = Vec::new();
    arms.push(run_append_only(&suite_root, &fixture, &exact).await?);
    for arm in [Me01Arm::StructuredNoDirectReentry, Me01Arm::FullMorphz] {
        arms.push(run_morphz_arm(&suite_root, &fixture, arm, agent_binary).await?);
    }
    drop(exact);

    let all_arms_executed = arms.len() == Me01Arm::ALL.len();
    let all_implementation_valid = arms.iter().all(|arm| arm.score.implementation_valid);
    let all_task_success = arms.iter().all(|arm| arm.score.task_success);
    let report = Me01RealSmokeSuiteReport {
        protocol_id: ME01_PROTOCOL_ID.to_string(),
        suite_id,
        created_at: Utc::now().to_rfc3339(),
        suite_root: suite_root.clone(),
        fixture_id: fixture.visible.id.clone(),
        requested_model: MODEL.to_string(),
        physical_model,
        provider: PROVIDER.to_string(),
        reasoning: REASONING.to_string(),
        arms,
        all_arms_executed,
        all_implementation_valid,
        all_task_success,
        pilot_permitted: all_arms_executed && all_implementation_valid,
    };
    write_json(&suite_root.join("summary.json"), &report)?;
    write_checksums(&suite_root)?;
    Ok(report)
}

pub fn rehash_me01_artifacts(suite_root: &Path) -> Result<(), DynError> {
    for arm in Me01Arm::ALL {
        let arm_root = suite_root.join(arm.as_str());
        if arm_root.is_dir() {
            write_checksums(&arm_root)?;
        }
    }
    write_checksums(suite_root)
}

async fn run_append_only(
    suite_root: &Path,
    fixture: &Me01FixturePair,
    exact: &ExactClient,
) -> Result<Me01RealSmokeArmReport, DynError> {
    let arm = Me01Arm::AppendOnly;
    let run_root = prepare_arm_root(suite_root, arm, fixture)?;
    let mut messages = vec![message("system", APPEND_ONLY_SYSTEM.to_string())];
    let mut receipts = Vec::new();
    let mut final_response = String::new();
    for stage in &fixture.visible.stages {
        messages.push(message(
            "user",
            render_stage_prompt(stage, &fixture.visible.required_action)?,
        ));
        let input_sha256 = sha256(&serde_json::to_vec(&messages)?);
        let started = Instant::now();
        let measurement = exact
            .client
            .count_prompt_tokens("me01-append-only", &messages, &[])
            .await?;
        let (stream, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let response = tokio::time::timeout(
            MODEL_CALL_TIMEOUT,
            exact.client.create_completion_measured_stream(
                messages.clone(),
                Vec::new(),
                measurement,
                stream,
            ),
        )
        .await
        .map_err(|_| format!("ME-01 append-only stage {} timed out", stage.id))??;
        let mut usage = ModelUsage::default();
        while let Ok(event) = receiver.try_recv() {
            if let ModelStreamEvent::Usage { usage: newer } = event {
                usage.merge_from(&newer);
            }
        }
        let wall_clock_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let response_sha256 = sha256(&serde_json::to_vec(&response)?);
        receipts.push(Me01ModelCallReceipt {
            arm,
            stage_id: stage.id.clone(),
            requested_model: MODEL.to_string(),
            physical_model: exact.physical_model.clone(),
            provider: PROVIDER.to_string(),
            protocol: exact.protocol.clone(),
            reasoning: REASONING.to_string(),
            input_sha256,
            response_sha256,
            usage,
            wall_clock_ms,
        });
        messages.push(response_as_assistant_message(&response)?);
        if stage.id == "act" {
            final_response = response.content.clone();
        }
    }
    write_json(&run_root.join("message_transcript.json"), &messages)?;
    write_json(&run_root.join("model_call_receipts.json"), &receipts)?;
    let transcript_sha256 = sha256(&serde_json::to_vec(&messages)?);
    let observed = Me01ObservedEpisode {
        protocol_id: ME01_PROTOCOL_ID.to_string(),
        fixture_id: fixture.visible.id.clone(),
        arm,
        visible_input_sha256: fixture.canonical_semantic_sha256.clone(),
        final_response,
        runtime: Me01RuntimeEvidence {
            adapter_kind: "append_only_messages".to_string(),
            message_transcript_sha256: Some(transcript_sha256),
            ..Me01RuntimeEvidence::default()
        },
    };
    finish_arm(run_root, fixture, observed, receipts.len(), true, false)
}

async fn run_morphz_arm(
    suite_root: &Path,
    fixture: &Me01FixturePair,
    arm: Me01Arm,
    agent_binary: &Path,
) -> Result<Me01RealSmokeArmReport, DynError> {
    if arm == Me01Arm::AppendOnly {
        return Err("append-only must use its dedicated adapter".into());
    }
    let run_root = prepare_arm_root(suite_root, arm, fixture)?;
    let database_path = run_root.join("morphz.db");
    let workspace_root = run_root.join("workspace");
    let artifact_root = run_root.join("artifacts");
    std::fs::create_dir_all(&workspace_root)?;
    std::fs::create_dir_all(&artifact_root)?;
    let agent_id = format!("me01-agent-{}", filesystem_component(&fixture.visible.id));
    let principal_id = format!(
        "me01-principal-{}",
        filesystem_component(&fixture.visible.id)
    );
    let base_environment = BTreeMap::from([
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
            artifact_root.to_string_lossy().to_string(),
        ),
        ("MORPHZ_AGENT_ID".to_string(), agent_id),
        ("MORPHZ_PRINCIPAL_ID".to_string(), principal_id),
        ("MORPHZ_CONTEXT_EVAL_MODE".to_string(), "true".to_string()),
        ("MORPHZ_CODING_EVAL_MODE".to_string(), "true".to_string()),
        (
            "MORPHZ_PERMISSION_MODE".to_string(),
            "full_access".to_string(),
        ),
        ("MORPHZ_EXEC_NETWORK".to_string(), "false".to_string()),
        (
            "MORPHZ_CONTEXT_SOFT_TOKEN_LIMIT".to_string(),
            "98304".to_string(),
        ),
        (
            "MORPHZ_CONTEXT_HARD_TOKEN_LIMIT".to_string(),
            "131072".to_string(),
        ),
        (
            "MORPHZ_CONTEXT_MAINTENANCE_RESERVE_TOKENS".to_string(),
            "8192".to_string(),
        ),
        (
            "MORPHZ_CONTEXT_TRANSACTIONS_ENABLED".to_string(),
            (arm == Me01Arm::FullMorphz).to_string(),
        ),
    ]);
    let (context_ids, session_mounts) = fixture_runtime_bindings(&fixture.visible)?;
    let stage_bindings = fixture
        .visible
        .stages
        .iter()
        .map(|stage| {
            json!({
                "stage_id": stage.id,
                "context_key": stage.context_key,
                "session_key": stage.session_key,
                "context_id": actual_context_id(&fixture.visible.id, &stage.context_key),
                "session_id": actual_session_id(&fixture.visible.id, &stage.session_key),
            })
        })
        .collect::<Vec<_>>();
    write_json(
        &run_root.join("environment_non_secret.json"),
        &json!({
            "base": &base_environment,
            "stage_bindings": stage_bindings,
        }),
    )?;

    let stdout_path = run_root.join("agent.stdout.log");
    let stderr_path = run_root.join("agent.stderr.log");
    File::create(&stdout_path)?;
    File::create(&stderr_path)?;

    let mut active_process: Option<(Child, String, String)> = None;
    for stage in fixture
        .visible
        .stages
        .iter()
        .filter(|stage| stage.id != "act")
    {
        let context_id = actual_context_id(&fixture.visible.id, &stage.context_key);
        let session_id = actual_session_id(&fixture.visible.id, &stage.session_key);
        let binding_changed =
            active_process
                .as_ref()
                .is_none_or(|(_, active_context, active_session)| {
                    active_context != &context_id || active_session != &session_id
                });
        if binding_changed {
            if let Some((child, _, _)) = active_process.take() {
                stop_agent(child).await?;
            }
            let environment = stage_environment(
                &base_environment,
                &fixture.visible.id,
                &stage.context_key,
                &stage.session_key,
            );
            let child = spawn_agent(agent_binary, &environment, &stdout_path, &stderr_path)?;
            active_process = Some((child, context_id.clone(), session_id.clone()));
        }
        let store = wait_for_store(&database_path).await?;
        let replies_before = reply_count(&store, &session_id).await?;
        send_prompt(
            &mut active_process
                .as_mut()
                .ok_or("ME-01 pre-act process is missing")?
                .0,
            &render_stage_prompt(stage, &fixture.visible.required_action)?,
        )
        .await?;
        wait_for_new_reply(&store, &session_id, replies_before, STAGE_TIMEOUT).await?;
    }
    if let Some((child, _, _)) = active_process.take() {
        stop_agent(child).await?;
    }

    let before_restart_pid = read_last_pid(&run_root.join("process_pids.log"))?;
    let store = wait_for_store(&database_path).await?;
    let events_before_restart = store.query(QueryFilter::default()).await?;
    write_json(
        &run_root.join("events_before_restart.json"),
        &events_before_restart,
    )?;

    let act = fixture
        .visible
        .stages
        .iter()
        .find(|stage| stage.id == "act")
        .ok_or("ME-01 smoke fixture has no act stage")?;
    let act_context_id = actual_context_id(&fixture.visible.id, &act.context_key);
    let act_session_id = actual_session_id(&fixture.visible.id, &act.session_key);
    let act_environment = stage_environment(
        &base_environment,
        &fixture.visible.id,
        &act.context_key,
        &act.session_key,
    );
    let mut restarted = spawn_agent(agent_binary, &act_environment, &stdout_path, &stderr_path)?;
    let after_restart_pid = read_last_pid(&run_root.join("process_pids.log"))?;
    let process_restart_proven = before_restart_pid != after_restart_pid;
    let act_projection = wait_for_context_projection(
        &database_path,
        &act_context_id,
        &act_session_id,
        Duration::from_secs(30),
    )
    .await?;
    write_json(&run_root.join("act_projection.json"), &act_projection)?;
    let act_projection_frame_ids = act_projection["frame_ids"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<Vec<_>>();
    let replies_before_act = reply_count(&store, &act_session_id).await?;
    send_prompt(
        &mut restarted,
        &render_stage_prompt(act, &fixture.visible.required_action)?,
    )
    .await?;
    let final_response =
        wait_for_new_reply(&store, &act_session_id, replies_before_act, STAGE_TIMEOUT).await?;
    stop_agent(restarted).await?;

    let events = store.query(QueryFilter::default()).await?;
    write_json(&run_root.join("events.json"), &events)?;
    let committed_frame_ids = committed_frame_ids_before_act(&events, &act_projection_frame_ids);
    let context_tx_attempts = count_context_tx_attempts(&events);
    let context_tx_commits = events
        .iter()
        .filter(|event| event.topic == "chat/context_tx_committed")
        .count();
    // Exposure is a production capability fact proven by the Runtime-level switch and the
    // no-model registry Gate. Invocation remains separately measured from immutable Events.
    let context_tx_tool_exposed = arm == Me01Arm::FullMorphz;
    let model_bindings_valid = validate_event_model_bindings(&events)?;
    let usages = events
        .iter()
        .filter(|event| event.topic == "runtime/model_usage")
        .cloned()
        .collect::<Vec<_>>();
    write_json(&run_root.join("model_usage_events.json"), &usages)?;
    for (session_id, context_id) in &session_mounts {
        load_context_projection(&database_path, context_id, session_id).await?;
    }
    let final_projection =
        load_context_projection(&database_path, &act_context_id, &act_session_id).await?;
    write_json(
        &run_root.join("final_context_projection.json"),
        &final_projection,
    )?;
    let structured_context_snapshot_sha256 = sha256(&serde_json::to_vec(&act_projection)?);
    let observed = Me01ObservedEpisode {
        protocol_id: ME01_PROTOCOL_ID.to_string(),
        fixture_id: fixture.visible.id.clone(),
        arm,
        visible_input_sha256: fixture.canonical_semantic_sha256.clone(),
        final_response,
        runtime: Me01RuntimeEvidence {
            adapter_kind: match arm {
                Me01Arm::StructuredNoDirectReentry => {
                    "production_morphz_read_only_context".to_string()
                }
                Me01Arm::FullMorphz => "production_morphz_full_context".to_string(),
                Me01Arm::AppendOnly => unreachable!(),
            },
            production_morphz_runtime: true,
            database_path: Some(database_path),
            context_ids,
            session_mounts,
            context_tx_tool_exposed,
            context_tx_attempts,
            context_tx_commits,
            committed_frame_ids,
            act_projection_frame_ids,
            structured_context_snapshot_sha256: Some(structured_context_snapshot_sha256),
            message_transcript_sha256: None,
        },
    };
    drop(store);
    finish_arm(
        run_root,
        fixture,
        observed,
        usages.len(),
        model_bindings_valid,
        process_restart_proven,
    )
}

fn finish_arm(
    run_root: PathBuf,
    fixture: &Me01FixturePair,
    observed: Me01ObservedEpisode,
    provider_calls: usize,
    model_bindings_valid: bool,
    process_restart_proven: bool,
) -> Result<Me01RealSmokeArmReport, DynError> {
    let observed_episode_path = run_root.join("observed_episode.json");
    write_json(&observed_episode_path, &observed)?;
    let score = score_me01_episode(&observed, fixture);
    let score_path = run_root.join("score.json");
    write_json(&score_path, &score)?;
    let passed = score.strict_success && model_bindings_valid;
    let report = Me01RealSmokeArmReport {
        arm: observed.arm,
        run_root: run_root.clone(),
        observed_episode_path,
        score_path,
        score,
        provider_calls,
        model_bindings_valid,
        process_restart_proven,
        passed,
    };
    write_json(&run_root.join("arm_report.json"), &report)?;
    write_checksums(&run_root)?;
    Ok(report)
}

async fn build_exact_client(root: &Path) -> Result<ExactClient, DynError> {
    if let Some(path) = config::host_env_path() {
        if let Err(error) = config::load_env(&path.to_string_lossy()) {
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(format!("failed to load Morphz host environment: {error}").into());
            }
        }
    }
    std::fs::create_dir_all(root)?;
    let cwd = std::env::current_dir()?;
    let mut resolved = config::resolve_config(&cwd, None, Some(PROFILE))?;
    resolved.config.apply_runtime_env_overrides()?;
    let route = resolved
        .config
        .model_routes
        .get(MODEL)
        .ok_or("ME-01 exact gpt-5.6-sol route is not configured")?;
    if route.fallback || route.candidates.len() != 1 {
        return Err("ME-01 requires one gpt-5.6-sol candidate and fallback=false".into());
    }
    let candidate = &route.candidates[0];
    if candidate.provider != PROVIDER || candidate.model != MODEL {
        return Err("ME-01 profile is not bound to custom/gpt-5.6-sol".into());
    }
    resolved.config.llm.model = MODEL.to_string();
    resolved.config.llm.reasoning_effort = Some(ReasoningEffort::Max);
    resolved.config.llm.max_output_tokens = Some(MAX_OUTPUT_TOKENS);
    let (client, selected) = build_configured_client(&resolved.config, None, Some(MODEL))?;
    if selected.id != PROVIDER || selected.model != MODEL {
        return Err("ME-01 configured client selected a different model/provider".into());
    }
    client.set_reasoning_effort(Some(ReasoningEffort::Max))?;
    if client.reasoning_effort() != Some(ReasoningEffort::Max) {
        return Err("ME-01 client did not retain reasoning=max".into());
    }
    let runtime = MorphzRuntime::builder(resolved.config, Arc::clone(&client))
        .database_path(root.join("provider-control.db").to_string_lossy())
        .build()
        .await?;
    let binding = client
        .bind_model_attempt(&ModelRequestContext {
            context_id: "me01-provider-preflight".to_string(),
            session_id: "me01-provider-preflight".to_string(),
            attempt_id: "me01-provider-preflight".to_string(),
            objective_id: None,
            required_capabilities: Vec::new(),
        })
        .await?;
    if binding.requested_alias != MODEL
        || binding.physical_model != MODEL
        || binding.provider_instance_id != PROVIDER
        || binding.protocol != "openai-responses"
    {
        return Err("ME-01 exact model binding preflight failed".into());
    }
    Ok(ExactClient {
        client,
        _runtime_guard: runtime,
        physical_model: binding.physical_model,
        protocol: binding.protocol,
    })
}

fn prepare_arm_root(
    suite_root: &Path,
    arm: Me01Arm,
    fixture: &Me01FixturePair,
) -> Result<PathBuf, DynError> {
    let run_root = suite_root.join(arm.as_str());
    std::fs::create_dir_all(&run_root)?;
    write_json(&run_root.join("visible_fixture.json"), &fixture.visible)?;
    Ok(run_root)
}

fn spawn_agent(
    agent_binary: &Path,
    environment: &BTreeMap<String, String>,
    stdout_path: &Path,
    stderr_path: &Path,
) -> Result<Child, DynError> {
    let stdout = OpenOptions::new().append(true).open(stdout_path)?;
    let stderr = OpenOptions::new().append(true).open(stderr_path)?;
    let mut command = Command::new(agent_binary);
    command
        .arg(format!("--profile={PROFILE}"))
        .arg("--plain")
        .envs(environment)
        .env("MORPHZ_BIND", "127.0.0.1:0")
        .env("MORPHZ_REPLY_WAIT_NOTICE_SECS", "600")
        .stdin(Stdio::piped())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    let child = command.spawn()?;
    let child_id = child.id().ok_or("ME-01 spawned Agent has no process ID")?;
    let pid_path = stdout_path
        .parent()
        .ok_or("ME-01 stdout path has no parent")?
        .join("process_pids.log");
    let mut pids = OpenOptions::new()
        .create(true)
        .append(true)
        .open(pid_path)?;
    writeln!(pids, "{child_id}")?;
    Ok(child)
}

async fn send_prompt(child: &mut Child, prompt: &str) -> Result<(), DynError> {
    let stdin = child.stdin.as_mut().ok_or("ME-01 Agent stdin is closed")?;
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

async fn wait_for_store(database_path: &Path) -> Result<Arc<SqliteStore>, DynError> {
    let started = Instant::now();
    loop {
        if database_path.is_file() {
            match SqliteStore::new(&database_path.to_string_lossy()).await {
                Ok(store) => return Ok(Arc::new(store)),
                Err(error) if started.elapsed() < Duration::from_secs(30) => {
                    let _ = error;
                }
                Err(error) => return Err(error),
            }
        }
        if started.elapsed() >= Duration::from_secs(30) {
            return Err(
                "ME-01 production Agent did not initialize SQLite within 30 seconds".into(),
            );
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn reply_count(store: &Arc<SqliteStore>, session_id: &str) -> Result<usize, DynError> {
    Ok(store
        .query(QueryFilter {
            session_id: Some(session_id.to_string()),
            topic: Some("chat/reply".to_string()),
            ..QueryFilter::default()
        })
        .await?
        .len())
}

async fn wait_for_new_reply(
    store: &Arc<SqliteStore>,
    session_id: &str,
    previous: usize,
    timeout: Duration,
) -> Result<String, DynError> {
    let started = Instant::now();
    loop {
        let replies = store
            .query(QueryFilter {
                session_id: Some(session_id.to_string()),
                topic: Some("chat/reply".to_string()),
                ..QueryFilter::default()
            })
            .await?;
        if replies.len() > previous {
            return Ok(replies
                .last()
                .and_then(|event| event.payload.get("text"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string());
        }
        if started.elapsed() >= timeout {
            return Err(format!("ME-01 did not receive a new reply within {timeout:?}").into());
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

async fn load_context_projection(
    database_path: &Path,
    context_id: &str,
    session_id: &str,
) -> Result<Value, DynError> {
    let store = Arc::new(SqliteStore::new(&database_path.to_string_lossy()).await?);
    let config = OrchestratorConfig {
        context_soft_token_limit: 98_304,
        context_hard_token_limit: 131_072,
        context_maintenance_reserve_tokens: 8_192,
        ..OrchestratorConfig::default()
    };
    let engine = ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config)
        .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>)
        .with_context_store(Arc::clone(&store) as Arc<dyn morphz::memory::ContextStore>)
        .with_session_projection_store(Arc::clone(&store) as Arc<dyn SessionProjectionStore>)
        .with_recall_projection_store(Arc::clone(&store) as Arc<dyn RecallProjectionStore>)
        .with_cognitive_clock_store(Arc::clone(&store) as Arc<dyn CognitiveClockStore>)
        .with_objective_store(Arc::clone(&store) as Arc<dyn ObjectiveStore>)
        .with_execution_job_store(Arc::clone(&store) as Arc<dyn ExecutionJobStore>)
        .with_execution_target_store(Arc::clone(&store) as Arc<dyn ExecutionTargetStore>)
        .with_execution_target_authorization_store(
            Arc::clone(&store) as Arc<dyn ExecutionTargetAuthorizationStore>
        );
    let view = engine.build_view(session_id).await?;
    if view.context_id != context_id {
        return Err(format!(
            "ME-01 Context projection mismatch: expected {context_id}, got {}",
            view.context_id
        )
        .into());
    }
    Ok(json!({
        "context_id": view.context_id,
        "active_session_id": view.active_session_id,
        "mind_version": view.state.version,
        "frame_ids": view.state.frames.iter().map(|frame| frame.id.clone()).collect::<Vec<_>>(),
        "frames": view.state.frames,
        "relations": view.state.relations,
        "pressure": view.pressure,
        "sexpr_sha256": sha256(view.sexpr.as_bytes()),
        "sexpr": view.sexpr,
    }))
}

async fn wait_for_context_projection(
    database_path: &Path,
    context_id: &str,
    session_id: &str,
    timeout: Duration,
) -> Result<Value, DynError> {
    let started = Instant::now();
    loop {
        match load_context_projection(database_path, context_id, session_id).await {
            Ok(projection) => return Ok(projection),
            Err(error) if started.elapsed() >= timeout => {
                return Err(format!(
                    "ME-01 Context projection did not become available for session {session_id} in context {context_id} within {timeout:?}: {error}"
                )
                .into());
            }
            Err(_) => {}
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn committed_frame_ids_before_act(events: &[Event], act_frame_ids: &[String]) -> Vec<String> {
    let act = act_frame_ids.iter().cloned().collect::<BTreeSet<_>>();
    let changed = events
        .iter()
        .filter(|event| event.topic == "chat/context_tx_committed")
        .flat_map(|event| {
            event
                .payload
                .get("changes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|change| change.get("target").and_then(Value::as_str))
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .collect::<BTreeSet<_>>();
    changed.intersection(&act).cloned().collect()
}

fn count_context_tx_attempts(events: &[Event]) -> usize {
    events
        .iter()
        .filter(|event| event.topic == "chat/assistant_call")
        .filter(|event| {
            event
                .payload
                .get("continuation_tool_calls")
                .or_else(|| event.payload.get("transcript_tool_calls"))
                .or_else(|| event.payload.get("tool_calls"))
                .and_then(Value::as_array)
                .is_some_and(|calls| {
                    calls.iter().any(|call| {
                        call.get("function")
                            .and_then(|function| function.get("name"))
                            .and_then(Value::as_str)
                            == Some("context_tx")
                    })
                })
        })
        .count()
}

fn validate_event_model_bindings(events: &[Event]) -> Result<bool, DynError> {
    let usages = events
        .iter()
        .filter(|event| event.topic == "runtime/model_usage")
        .collect::<Vec<_>>();
    if usages.is_empty() {
        return Ok(false);
    }
    Ok(usages.iter().all(|event| {
        let binding = event.payload.get("model_binding");
        binding
            .and_then(|value| value.get("requested_alias"))
            .and_then(Value::as_str)
            == Some(MODEL)
            && binding
                .and_then(|value| value.get("physical_model"))
                .and_then(Value::as_str)
                == Some(MODEL)
            && binding
                .and_then(|value| value.get("provider_instance_id"))
                .and_then(Value::as_str)
                == Some(PROVIDER)
            && binding
                .and_then(|value| value.get("protocol"))
                .and_then(Value::as_str)
                == Some("openai-responses")
    }))
}

fn fixture_by_id(fixture_id: &str) -> Result<Me01FixturePair, DynError> {
    load_me01_fixtures()?
        .into_iter()
        .find(|fixture| fixture.visible.id == fixture_id)
        .ok_or_else(|| format!("ME-01 fixture is missing: {fixture_id}").into())
}

fn render_stage_prompt(stage: &Me01Stage, required_action: &str) -> Result<String, DynError> {
    Ok(format!(
        "ME-01 visible evidence for stage '{}':\n{}\n\nInstruction: {}\n\nThe final action contract, when requested, has exactly the fields action, object_id, value, and evidence_id. The required action vocabulary for this fixture is exactly '{}'.",
        stage.id,
        serde_json::to_string_pretty(&stage.events)?,
        stage.instruction,
        required_action,
    ))
}

fn message(role: &str, content: String) -> Message {
    Message {
        role: role.to_string(),
        content,
        name: None,
        tool_call_id: None,
        tool_calls: None,
    }
}

fn response_as_assistant_message(response: &Response) -> Result<Message, DynError> {
    if !response.tool_calls.is_empty() {
        return Err(
            "ME-01 append-only received unexpected tool calls with an empty tool set".into(),
        );
    }
    Ok(message("assistant", response.content.clone()))
}

fn actual_context_id(fixture_id: &str, context_key: &str) -> String {
    format!(
        "me01-{}-context-{}",
        filesystem_component(fixture_id),
        filesystem_component(context_key)
    )
}

fn stage_environment(
    base: &BTreeMap<String, String>,
    fixture_id: &str,
    context_key: &str,
    session_key: &str,
) -> BTreeMap<String, String> {
    let mut environment = base.clone();
    environment.insert(
        "MORPHZ_CONTEXT_ID".to_string(),
        actual_context_id(fixture_id, context_key),
    );
    environment.insert(
        "MORPHZ_SESSION_ID".to_string(),
        actual_session_id(fixture_id, session_key),
    );
    environment
}

fn fixture_runtime_bindings(
    fixture: &Me01VisibleFixture,
) -> Result<(Vec<String>, BTreeMap<String, String>), DynError> {
    let context_ids = fixture
        .stages
        .iter()
        .map(|stage| actual_context_id(&fixture.id, &stage.context_key))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let mut session_mounts = BTreeMap::new();
    for stage in &fixture.stages {
        let session_id = actual_session_id(&fixture.id, &stage.session_key);
        let context_id = actual_context_id(&fixture.id, &stage.context_key);
        if let Some(existing) = session_mounts.insert(session_id.clone(), context_id.clone()) {
            if existing != context_id {
                return Err(format!(
                    "ME-01 fixture maps session {session_id} to multiple Contexts: {existing} and {context_id}"
                )
                .into());
            }
        }
    }
    Ok((context_ids, session_mounts))
}

fn actual_session_id(fixture_id: &str, session_key: &str) -> String {
    format!(
        "me01-{}-{}",
        filesystem_component(fixture_id),
        filesystem_component(session_key)
    )
}

fn filesystem_component(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect()
}

fn read_last_pid(path: &Path) -> Result<u32, DynError> {
    std::fs::read_to_string(path)?
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .next_back()
        .ok_or_else(|| format!("ME-01 process PID log is empty: {}", path.display()).into())
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), DynError> {
    std::fs::write(path, serde_json::to_vec_pretty(value)?)?;
    Ok(())
}

fn write_checksums(root: &Path) -> Result<(), DynError> {
    let checksum_path = root.join("checksums.sha256");
    let mut paths = WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_type().is_file()
                && entry.path() != checksum_path
                && !entry
                    .path()
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.ends_with("-wal") || name.ends_with("-shm"))
        })
        .map(|entry| entry.path().to_path_buf())
        .collect::<Vec<_>>();
    paths.sort();
    let mut output = String::new();
    for path in paths {
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        let relative = path.strip_prefix(root)?;
        output.push_str(&format!("{}  {}\n", sha256(&bytes), relative.display()));
    }
    std::fs::write(checksum_path, output)?;
    Ok(())
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smoke_exposes_the_scored_action_vocabulary() {
        let fixture = fixture_by_id(DEFAULT_SMOKE_FIXTURE_ID).unwrap();
        assert_eq!(fixture.visible.family, "delayed_reference");
        for stage in &fixture.visible.stages {
            let prompt = render_stage_prompt(stage, &fixture.visible.required_action).unwrap();
            assert!(prompt.contains(&fixture.hidden.expected.action));
        }
    }

    #[test]
    fn real_cell_selection_uses_the_requested_fixture() {
        let fixture = fixture_by_id("me01-p1-supersession-conflict-01").unwrap();
        assert_eq!(fixture.visible.family, "supersession_conflict");
        assert_eq!(fixture.hidden.expected.value, "/hooks/v3");
    }

    #[test]
    fn append_only_system_requires_strict_contract_without_morphz_claims() {
        assert!(APPEND_ONLY_SYSTEM.contains("exactly four string fields"));
        assert!(!APPEND_ONLY_SYSTEM.contains("context_tx"));
        assert!(!APPEND_ONLY_SYSTEM.contains("Structured Context"));
    }

    #[test]
    fn checksums_exclude_transient_sqlite_sidecars() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("stable.json"), b"{}\n").unwrap();
        std::fs::write(root.path().join("morphz.db-wal"), b"transient").unwrap();
        std::fs::write(root.path().join("morphz.db-shm"), b"transient").unwrap();
        write_checksums(root.path()).unwrap();
        let manifest = std::fs::read_to_string(root.path().join("checksums.sha256")).unwrap();
        assert!(manifest.contains("stable.json"));
        assert!(!manifest.contains("morphz.db-wal"));
        assert!(!manifest.contains("morphz.db-shm"));
    }
}
