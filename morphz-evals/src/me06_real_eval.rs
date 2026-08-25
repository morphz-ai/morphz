use crate::me05_model_target::{build_exact_model_client, EvalModelTarget};
use crate::me06_long_horizon_eval::{
    generate_me06_fixtures, score_me06_episode, Me06Action, Me06ArchitectureEvidence, Me06Arm,
    Me06Event, Me06FixturePair, Me06ObservedEpisode, Me06Score, ME06_PROTOCOL_ID,
};
use chrono::Utc;
use morphz::event::Event;
use morphz::llm::{
    Client, Message, ModelAttemptBinding, ModelRequestOptions, ModelStreamEvent, ModelUsage,
    ReasoningEffort, Response,
};
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{EventStore, QueryFilter};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};

type DynError = Box<dyn std::error::Error + Send + Sync>;

const PROFILE: &str = "roadshow-demo-001";
const PROVIDER: &str = "custom";
const MODEL: &str = "gpt-5.6-sol";
const MAX_OUTPUT_TOKENS: u32 = 4_096;
const MODEL_TIMEOUT: Duration = Duration::from_secs(900);
const STAGE_TIMEOUT: Duration = Duration::from_secs(900);
const CONTROLLED_COMPACTION_STAGE: usize = 6;
const MORPHZ_CONTEXT_SOFT_TOKEN_LIMIT: usize = 196_608;
const MORPHZ_CONTEXT_HARD_TOKEN_LIMIT: usize = 262_144;
const MORPHZ_CONTEXT_MAINTENANCE_RESERVE_TOKENS: usize = 3_000;

const BUSINESS_SYSTEM: &str = r#"You are executing the frozen ME-06 long-horizon state task. Evidence events have stable event IDs, source IDs, authority classes, Context IDs, Session IDs, arrival order, and explicit supersession links. Determine current state by approval and source authority before recency. Preserve durable constraints, current facts, their sources, explicit supersession, unfinished work, and uncertainty. Completed diagnostic noise is not current state. A foreign Context is isolated.

At every checkpoint, return exactly one JSON object and no Markdown. Use this schema:
{"state":{"project":"...","current_port":"...","current_endpoint":"...","retention_days":"...","timezone":"...","storage":"...","security_rule":"...","decision_rule":"..."},"action":null}
At checkpoint 12, action must instead be {"name":"...","target":"...","evidence_id":"..."}. Use semantic values, not full evidence sentences. If your runtime provides durable structured Context operations, use them when they are appropriate; do not merely describe a state update."#;

const COMPACTION_SYSTEM: &str = r#"Maintain a bounded persistent state for a modern append-only-message Agent. Read the prior compacted state and all subsequent messages/events. Produce a concise Markdown state that preserves: current objective; durable constraints; current approved facts and source IDs; explicit supersession; unfinished work; uncertainty; and reusable rules. Authority and approval outrank arrival time. Do not copy completed diagnostic noise. This is the only persistent compaction state, so omissions are not recoverable from the active prompt without an explicit history recall."#;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Me06CallArtifact {
    pub arm: Me06Arm,
    pub fixture_id: String,
    pub stage: usize,
    pub kind: String,
    pub requested_alias: String,
    pub physical_model: String,
    pub provider: String,
    pub protocol: String,
    pub input_sha256: String,
    pub prompt_tokens: usize,
    pub response: Response,
    pub stream_events: Vec<ModelStreamEvent>,
    pub usage: ModelUsage,
    pub wall_clock_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Me06CheckpointOutput {
    pub stage: usize,
    pub session_key: String,
    pub context_key: String,
    pub raw_output: String,
    pub parsed_state: BTreeMap<String, String>,
    pub parsed_action: Option<Me06Action>,
    pub protocol_shape_valid: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Me06RealArmReport {
    pub arm: Me06Arm,
    pub fixture_id: String,
    pub run_root: PathBuf,
    pub score: Me06Score,
    pub checkpoints: Vec<Me06CheckpointOutput>,
    pub business_calls: usize,
    pub maintenance_calls: usize,
    pub provider_usage_events: usize,
    pub process_pids: Vec<u32>,
    pub model_binding_valid: bool,
    pub immutable_artifacts_complete: bool,
    pub passed_gate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Me06RealPilotReport {
    pub protocol_id: String,
    pub suite_id: String,
    pub created_at: String,
    pub suite_root: PathBuf,
    pub runtime_binary: PathBuf,
    pub runtime_binary_sha256: String,
    pub runtime_git_commit: String,
    pub requested_alias: String,
    pub physical_model: String,
    pub provider: String,
    pub protocol: String,
    pub reasoning_effort: String,
    pub fixture_count: usize,
    pub arms: Vec<Me06RealArmReport>,
    pub all_cells_executed: bool,
    pub all_bindings_valid: bool,
    pub semantic_success_by_arm: BTreeMap<String, usize>,
    pub state_field_accuracy_by_arm: BTreeMap<String, f64>,
    pub publishable_p1_result: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ParsedOutput {
    state: BTreeMap<String, String>,
    action: Option<Me06Action>,
}

struct ModelCaller<'a> {
    client: &'a dyn Client,
    binding: &'a ModelAttemptBinding,
    reasoning: ReasoningEffort,
    arm: Me06Arm,
    fixture_id: &'a str,
    artifact_root: &'a Path,
}

struct CellExecution {
    checkpoints: Vec<Me06CheckpointOutput>,
    business_calls: usize,
    maintenance_calls: usize,
    provider_usage_events: usize,
    process_pids: Vec<u32>,
    model_binding_valid: bool,
}

pub async fn run_me06_real_pilot(
    base: &Path,
    runtime_binary: &Path,
) -> Result<Me06RealPilotReport, DynError> {
    let runtime_binary = std::fs::canonicalize(runtime_binary)?;
    let fixtures = generate_me06_fixtures()?;
    let suite_id = format!(
        "ME-06-real-p1-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        std::process::id()
    );
    let suite_root = base.join(&suite_id);
    std::fs::create_dir_all(&suite_root)?;
    let provider_control_root = suite_root.join("provider-control");
    std::fs::create_dir_all(&provider_control_root)?;
    let target = EvalModelTarget::from_environment(PROFILE, PROVIDER, MODEL)?;
    let (client, _runtime_guard, binding) = build_exact_model_client(
        &provider_control_root,
        &target,
        "me06-provider-preflight",
        MAX_OUTPUT_TOKENS,
    )
    .await?;
    write_json(&suite_root.join("model_binding.json"), &binding)?;
    write_json(
        &suite_root.join("budget_binding.json"),
        &serde_json::json!({
            "budget_semantics": "production_context_capacity_with_fixed_lifecycle_compaction_baseline",
            "controlled_compaction_stage": CONTROLLED_COMPACTION_STAGE,
            "morphz_runtime_soft_token_limit": MORPHZ_CONTEXT_SOFT_TOKEN_LIMIT,
            "morphz_runtime_hard_token_limit": MORPHZ_CONTEXT_HARD_TOKEN_LIMIT,
            "morphz_runtime_maintenance_reserve_tokens": MORPHZ_CONTEXT_MAINTENANCE_RESERVE_TOKENS,
            "artificial_context_pressure": false,
            "all_actual_request_tokens_recorded": true,
        }),
    )?;
    write_json(
        &suite_root.join("visible_fixtures.json"),
        &fixtures
            .iter()
            .map(|fixture| &fixture.visible)
            .collect::<Vec<_>>(),
    )?;

    let mut arms = Vec::new();
    for (index, fixture) in fixtures.iter().enumerate() {
        let order = if index % 2 == 0 {
            Me06Arm::ALL
        } else {
            [Me06Arm::FullMorphz, Me06Arm::ControlledCompaction]
        };
        for arm in order {
            let report = match arm {
                Me06Arm::ControlledCompaction => {
                    run_controlled_compaction(
                        &suite_root,
                        fixture,
                        client.as_ref(),
                        &binding,
                        target.reasoning_effort,
                    )
                    .await?
                }
                Me06Arm::FullMorphz => {
                    run_full_morphz(&suite_root, fixture, &runtime_binary).await?
                }
            };
            arms.push(report);
        }
    }
    let all_cells_executed = arms.len() == fixtures.len() * Me06Arm::ALL.len();
    let all_bindings_valid = arms.iter().all(|arm| arm.model_binding_valid);
    let mut semantic_success_by_arm = BTreeMap::new();
    let mut state_field_accuracy_by_arm = BTreeMap::new();
    for arm in Me06Arm::ALL {
        let cells = arms
            .iter()
            .filter(|cell| cell.arm == arm)
            .collect::<Vec<_>>();
        semantic_success_by_arm.insert(
            arm.as_str().to_string(),
            cells
                .iter()
                .filter(|cell| cell.score.semantic_success)
                .count(),
        );
        state_field_accuracy_by_arm.insert(
            arm.as_str().to_string(),
            cells
                .iter()
                .map(|cell| cell.score.final_state_field_accuracy)
                .sum::<f64>()
                / cells.len().max(1) as f64,
        );
    }
    let runtime_binary_sha256 = sha256(&std::fs::read(&runtime_binary)?);
    let runtime_git_commit = git_stdout(&["rev-parse", "HEAD"])?;
    let report = Me06RealPilotReport {
        protocol_id: ME06_PROTOCOL_ID.to_string(),
        suite_id,
        created_at: Utc::now().to_rfc3339(),
        suite_root: suite_root.clone(),
        runtime_binary,
        runtime_binary_sha256,
        runtime_git_commit,
        requested_alias: binding.requested_alias.clone(),
        physical_model: binding.physical_model.clone(),
        provider: binding.provider_instance_id.clone(),
        protocol: binding.protocol.clone(),
        reasoning_effort: target.reasoning_effort.as_str().to_string(),
        fixture_count: fixtures.len(),
        arms,
        all_cells_executed,
        all_bindings_valid,
        semantic_success_by_arm,
        state_field_accuracy_by_arm,
        publishable_p1_result: all_cells_executed && all_bindings_valid,
    };
    write_json(&suite_root.join("report.json"), &report)?;
    write_checksums(&suite_root)?;
    Ok(report)
}

async fn run_controlled_compaction(
    suite_root: &Path,
    fixture: &Me06FixturePair,
    client: &dyn Client,
    binding: &ModelAttemptBinding,
    reasoning: ReasoningEffort,
) -> Result<Me06RealArmReport, DynError> {
    let arm = Me06Arm::ControlledCompaction;
    let root = cell_root(suite_root, fixture, arm)?;
    let raw_history_path = root.join("raw_events.jsonl");
    let compact_state_path = root.join("compaction_state.md");
    let transcript_path = root.join("active_messages.json");
    File::create(&raw_history_path)?;
    std::fs::write(
        &compact_state_path,
        "# Persistent state\n\nNo state has been compacted yet.\n",
    )?;
    let mut messages = vec![message("system", BUSINESS_SYSTEM)];
    let mut post_compaction_events = Vec::<Me06Event>::new();
    let mut calls = Vec::new();
    let mut checkpoints = Vec::new();
    let mut maintenance_calls = 0usize;
    let caller = ModelCaller {
        client,
        binding,
        reasoning,
        arm,
        fixture_id: &fixture.visible.fixture_id,
        artifact_root: &root,
    };

    for stage in 1..=fixture.visible.checkpoint_count {
        let stage_events = fixture
            .visible
            .events
            .iter()
            .filter(|event| event.stage == stage)
            .cloned()
            .collect::<Vec<_>>();
        append_jsonl(&raw_history_path, &stage_events)?;
        let stage_prompt = render_stage(
            &fixture.visible.fixture_id,
            stage,
            &stage_events,
            &fixture.visible.checkpoint_prompts[stage - 1],
        )?;
        if stage == CONTROLLED_COMPACTION_STAGE && !post_compaction_events.is_empty() {
            let prior = std::fs::read_to_string(&compact_state_path)?;
            let maintenance_input = format!(
                "Prior compacted state:\n{prior}\n\nMessages and evidence after that state:\n{}",
                serde_json::to_string_pretty(&messages.iter().skip(1).collect::<Vec<_>>())?
            );
            let maintenance_messages = vec![
                message("system", COMPACTION_SYSTEM),
                message("user", &maintenance_input),
            ];
            let artifact = caller
                .call(stage, "maintenance", maintenance_messages)
                .await?;
            let compacted = artifact.response.content.trim().to_string();
            if compacted.is_empty() {
                return Err(format!(
                    "{} compaction returned empty state",
                    fixture.visible.fixture_id
                )
                .into());
            }
            let revision = maintenance_calls + 1;
            std::fs::write(
                root.join(format!("compaction_state_r{revision:02}.md")),
                &compacted,
            )?;
            std::fs::write(&compact_state_path, &compacted)?;
            calls.push(artifact);
            maintenance_calls += 1;
            post_compaction_events.clear();
            messages = vec![
                message("system", BUSINESS_SYSTEM),
                message(
                    "user",
                    &format!("Persistent compaction state (revision {revision}):\n{compacted}"),
                ),
            ];
        }
        let artifact = caller
            .call(stage, "business", {
                let mut request = messages.clone();
                request.push(message("user", &stage_prompt));
                request
            })
            .await?;
        let checkpoint = parse_checkpoint(stage, stage_events.first(), &artifact.response.content);
        messages.push(message("user", &stage_prompt));
        messages.push(message("assistant", &artifact.response.content));
        post_compaction_events.extend(stage_events);
        calls.push(artifact);
        checkpoints.push(checkpoint);
        write_json(&transcript_path, &messages)?;
        if stage == 10 {
            messages = serde_json::from_slice(&std::fs::read(&transcript_path)?)?;
            let _: Vec<Value> = read_jsonl(&raw_history_path)?;
            let _ = std::fs::read_to_string(&compact_state_path)?;
        }
    }
    write_json(&root.join("model_calls.json"), &calls)?;
    finish_cell(
        root,
        fixture,
        arm,
        CellExecution {
            checkpoints,
            business_calls: calls.len() - maintenance_calls,
            maintenance_calls,
            provider_usage_events: 0,
            process_pids: Vec::new(),
            model_binding_valid: true,
        },
    )
}

impl ModelCaller<'_> {
    async fn call(
        &self,
        stage: usize,
        kind: &str,
        messages: Vec<Message>,
    ) -> Result<Me06CallArtifact, DynError> {
        let measurement = self
            .client
            .count_prompt_tokens(
                &format!("ME-06/{}/{kind}/{stage}", self.fixture_id),
                &messages,
                &[],
            )
            .await?;
        let input_sha256 = sha256(&serde_json::to_vec(&messages)?);
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let started = Instant::now();
        let completion = tokio::time::timeout(
            MODEL_TIMEOUT,
            self.client.create_completion_bound_stream_with_options(
                self.binding,
                messages,
                Vec::new(),
                measurement.clone(),
                sender,
                ModelRequestOptions {
                    reasoning_effort: Some(Some(self.reasoning)),
                },
            ),
        )
        .await;
        let mut stream_events = Vec::new();
        let mut usage = ModelUsage::default();
        while let Ok(event) = receiver.try_recv() {
            if let ModelStreamEvent::Usage { usage: newer } = &event {
                usage.merge_from(newer);
            }
            stream_events.push(event);
        }
        let response = match completion {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => {
                write_json(
                    &self
                        .artifact_root
                        .join(format!("failed_call_stage_{stage:02}_{kind}.json")),
                    &serde_json::json!({
                        "fixture_id": self.fixture_id,
                        "arm": self.arm,
                        "stage": stage,
                        "kind": kind,
                        "classification": "provider_or_service_error",
                        "error": error.to_string(),
                        "stream_events": stream_events,
                        "usage": usage,
                        "input_sha256": input_sha256,
                        "prompt_tokens": measurement.as_ref().map(|value| value.tokens),
                        "wall_clock_ms": u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
                    }),
                )?;
                return Err(error);
            }
            Err(_) => {
                let classification = if stream_events.is_empty() {
                    "service_timeout_without_stream"
                } else {
                    "model_timeout_with_stream"
                };
                write_json(
                    &self
                        .artifact_root
                        .join(format!("failed_call_stage_{stage:02}_{kind}.json")),
                    &serde_json::json!({
                        "fixture_id": self.fixture_id,
                        "arm": self.arm,
                        "stage": stage,
                        "kind": kind,
                        "classification": classification,
                        "stream_events": stream_events,
                        "usage": usage,
                        "input_sha256": input_sha256,
                        "prompt_tokens": measurement.as_ref().map(|value| value.tokens),
                        "wall_clock_ms": u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
                    }),
                )?;
                return Err(format!(
                    "ME-06 {} {kind} stage {stage} timed out ({classification})",
                    self.fixture_id
                )
                .into());
            }
        };
        let artifact = Me06CallArtifact {
            arm: self.arm,
            fixture_id: self.fixture_id.to_string(),
            stage,
            kind: kind.to_string(),
            requested_alias: self.binding.requested_alias.clone(),
            physical_model: self.binding.physical_model.clone(),
            provider: self.binding.provider_instance_id.clone(),
            protocol: self.binding.protocol.clone(),
            input_sha256,
            prompt_tokens: measurement
                .as_ref()
                .ok_or("ME-06 model call requires prompt-token measurement")?
                .tokens,
            response,
            stream_events,
            usage,
            wall_clock_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        };
        write_json(
            &self
                .artifact_root
                .join(format!("model_call_stage_{stage:02}_{kind}.json")),
            &artifact,
        )?;
        Ok(artifact)
    }
}

async fn run_full_morphz(
    suite_root: &Path,
    fixture: &Me06FixturePair,
    runtime_binary: &Path,
) -> Result<Me06RealArmReport, DynError> {
    let arm = Me06Arm::FullMorphz;
    let root = cell_root(suite_root, fixture, arm)?;
    let database_path = root.join("morphz.db");
    let workspace = root.join("workspace");
    let artifacts = root.join("artifacts");
    std::fs::create_dir_all(&workspace)?;
    std::fs::create_dir_all(&artifacts)?;
    let stdout_path = root.join("agent.stdout.log");
    let stderr_path = root.join("agent.stderr.log");
    File::create(&stdout_path)?;
    File::create(&stderr_path)?;
    let base = BTreeMap::from([
        (
            "MORPHZ_STORAGE_SQLITE_PATH".to_string(),
            database_path.to_string_lossy().to_string(),
        ),
        (
            "MORPHZ_WORKSPACE_ROOT".to_string(),
            workspace.to_string_lossy().to_string(),
        ),
        (
            "MORPHZ_ARTIFACT_DIR".to_string(),
            artifacts.to_string_lossy().to_string(),
        ),
        (
            "MORPHZ_AGENT_ID".to_string(),
            format!("me06-agent-{}", fixture.visible.fixture_id),
        ),
        (
            "MORPHZ_PRINCIPAL_ID".to_string(),
            "me06-principal".to_string(),
        ),
        ("MORPHZ_CONTEXT_EVAL_MODE".to_string(), "true".to_string()),
        ("MORPHZ_CODING_EVAL_MODE".to_string(), "true".to_string()),
        (
            "MORPHZ_PERMISSION_MODE".to_string(),
            "full_access".to_string(),
        ),
        ("MORPHZ_EXEC_NETWORK".to_string(), "false".to_string()),
        (
            "MORPHZ_CONTEXT_SOFT_TOKEN_LIMIT".to_string(),
            MORPHZ_CONTEXT_SOFT_TOKEN_LIMIT.to_string(),
        ),
        (
            "MORPHZ_CONTEXT_HARD_TOKEN_LIMIT".to_string(),
            MORPHZ_CONTEXT_HARD_TOKEN_LIMIT.to_string(),
        ),
        (
            "MORPHZ_CONTEXT_MAINTENANCE_RESERVE_TOKENS".to_string(),
            MORPHZ_CONTEXT_MAINTENANCE_RESERVE_TOKENS.to_string(),
        ),
        (
            "MORPHZ_CONTEXT_TRANSACTIONS_ENABLED".to_string(),
            "true".to_string(),
        ),
    ]);
    let mut active: Option<(Child, String, String)> = None;
    let mut checkpoints = Vec::new();
    let mut pids = Vec::new();
    let mut business_calls = 0usize;

    for stage in 1..=fixture.visible.checkpoint_count {
        if stage == 10 {
            if let Some((child, _, _)) = active.take() {
                stop_agent(child).await?;
            }
        }
        let stage_events = fixture
            .visible
            .events
            .iter()
            .filter(|event| event.stage == stage)
            .cloned()
            .collect::<Vec<_>>();
        let grouped = group_stage_events(&stage_events);
        if stage == 8 || stage == 9 {
            if let Some((child, _, _)) = active.take() {
                stop_agent(child).await?;
            }
            let mut processes = Vec::new();
            for ((context_key, session_key), events) in grouped {
                let environment = stage_environment(&base, fixture, &context_key, &session_key);
                let mut child =
                    spawn_agent(runtime_binary, &environment, &stdout_path, &stderr_path)?;
                pids.push(child.id().ok_or("ME-06 spawned process has no pid")?);
                let session_id = actual_session_id(fixture, &session_key);
                let store = wait_for_store(&database_path).await?;
                let before = reply_count(&store, &session_id).await?;
                let prompt = format!(
                    "{BUSINESS_SYSTEM}\n\n{}",
                    render_stage(
                        &fixture.visible.fixture_id,
                        stage,
                        &events,
                        &fixture.visible.checkpoint_prompts[stage - 1],
                    )?
                );
                send_prompt(&mut child, &prompt).await?;
                processes.push((child, context_key, session_key, session_id, before, events));
            }
            let store = wait_for_store(&database_path).await?;
            for (child, context_key, session_key, session_id, before, events) in processes {
                let raw = wait_for_new_reply(&store, &session_id, before, STAGE_TIMEOUT).await?;
                checkpoints.push(parse_checkpoint(stage, events.first(), &raw));
                stop_agent(child).await?;
                business_calls += 1;
                let _ = (context_key, session_key);
            }
            continue;
        }
        for ((context_key, session_key), events) in grouped {
            let context_id = actual_context_id(fixture, &context_key);
            let session_id = actual_session_id(fixture, &session_key);
            let changed = active
                .as_ref()
                .is_none_or(|(_, c, s)| c != &context_id || s != &session_id);
            if changed {
                if let Some((child, _, _)) = active.take() {
                    stop_agent(child).await?;
                }
                let environment = stage_environment(&base, fixture, &context_key, &session_key);
                let child = spawn_agent(runtime_binary, &environment, &stdout_path, &stderr_path)?;
                pids.push(child.id().ok_or("ME-06 spawned process has no pid")?);
                active = Some((child, context_id, session_id.clone()));
            }
            let store = wait_for_store(&database_path).await?;
            let before = reply_count(&store, &session_id).await?;
            let prompt = format!(
                "{BUSINESS_SYSTEM}\n\n{}",
                render_stage(
                    &fixture.visible.fixture_id,
                    stage,
                    &events,
                    &fixture.visible.checkpoint_prompts[stage - 1],
                )?
            );
            send_prompt(
                &mut active.as_mut().ok_or("ME-06 active process missing")?.0,
                &prompt,
            )
            .await?;
            let raw = wait_for_new_reply(&store, &session_id, before, STAGE_TIMEOUT).await?;
            checkpoints.push(parse_checkpoint(stage, events.first(), &raw));
            business_calls += 1;
        }
    }
    if let Some((child, _, _)) = active.take() {
        stop_agent(child).await?;
    }
    let store = wait_for_store(&database_path).await?;
    let events = store.query(QueryFilter::default()).await?;
    write_json(&root.join("events.json"), &events)?;
    let usage_events = events
        .iter()
        .filter(|event| event.topic == "runtime/model_usage")
        .count();
    let binding_valid = validate_model_events(&events);
    write_json(&root.join("checkpoints.json"), &checkpoints)?;
    finish_cell(
        root,
        fixture,
        arm,
        CellExecution {
            checkpoints,
            business_calls,
            maintenance_calls: usage_events.saturating_sub(business_calls),
            provider_usage_events: usage_events,
            process_pids: pids,
            model_binding_valid: binding_valid,
        },
    )
}

fn finish_cell(
    root: PathBuf,
    fixture: &Me06FixturePair,
    arm: Me06Arm,
    execution: CellExecution,
) -> Result<Me06RealArmReport, DynError> {
    let CellExecution {
        checkpoints,
        business_calls,
        maintenance_calls,
        provider_usage_events,
        process_pids,
        model_binding_valid,
    } = execution;
    let final_checkpoint = checkpoints
        .iter()
        .rev()
        .find(|checkpoint| checkpoint.stage == 12)
        .ok_or("ME-06 cell has no final checkpoint")?;
    let raw_output = checkpoints
        .iter()
        .map(|checkpoint| checkpoint.raw_output.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let forbidden_values_observed = fixture
        .hidden
        .forbidden_primary_values
        .iter()
        .filter(|value| final_checkpoint.raw_output.contains(value.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    let architecture = if arm == Me06Arm::FullMorphz {
        Me06ArchitectureEvidence {
            cross_session_continuity: Some(
                final_checkpoint.parsed_state.get("project")
                    == fixture.hidden.expected_state.get("project"),
            ),
            restart_recovery: Some(
                final_checkpoint.parsed_state.get("security_rule")
                    == fixture.hidden.expected_state.get("security_rule"),
            ),
            context_isolation: Some(forbidden_values_observed.is_empty()),
            concurrent_disjoint_updates_preserved: None,
            concurrent_conflict_detected: None,
            silent_lost_updates: None,
            causal_audit_complete: Some(provider_usage_events > 0),
        }
    } else {
        Me06ArchitectureEvidence {
            cross_session_continuity: Some(true),
            restart_recovery: Some(true),
            context_isolation: Some(forbidden_values_observed.is_empty()),
            ..Me06ArchitectureEvidence::default()
        }
    };
    let observed = Me06ObservedEpisode {
        protocol_id: ME06_PROTOCOL_ID.to_string(),
        fixture_id: fixture.visible.fixture_id.clone(),
        arm,
        visible_sha256: fixture.visible_sha256.clone(),
        observed_state: final_checkpoint.parsed_state.clone(),
        observed_action: final_checkpoint.parsed_action.clone(),
        forbidden_values_observed,
        protocol_shape_valid: final_checkpoint.protocol_shape_valid,
        raw_output,
        architecture,
    };
    let score = score_me06_episode(&observed, fixture);
    write_json(&root.join("observed_episode.json"), &observed)?;
    write_json(&root.join("score.json"), &score)?;
    let immutable_artifacts_complete = root.join("visible_fixture.json").is_file()
        && root.join("observed_episode.json").is_file()
        && root.join("score.json").is_file();
    let report = Me06RealArmReport {
        arm,
        fixture_id: fixture.visible.fixture_id.clone(),
        run_root: root.clone(),
        score: score.clone(),
        checkpoints,
        business_calls,
        maintenance_calls,
        provider_usage_events,
        process_pids,
        model_binding_valid,
        immutable_artifacts_complete,
        passed_gate: model_binding_valid && immutable_artifacts_complete,
    };
    write_json(&root.join("arm_report.json"), &report)?;
    write_checksums(&root)?;
    Ok(report)
}

fn cell_root(suite: &Path, fixture: &Me06FixturePair, arm: Me06Arm) -> Result<PathBuf, DynError> {
    let root = suite.join(&fixture.visible.fixture_id).join(arm.as_str());
    std::fs::create_dir_all(&root)?;
    write_json(&root.join("visible_fixture.json"), &fixture.visible)?;
    Ok(root)
}

fn parse_checkpoint(stage: usize, event: Option<&Me06Event>, raw: &str) -> Me06CheckpointOutput {
    let parsed =
        extract_json(raw).and_then(|value| serde_json::from_value::<ParsedOutput>(value).ok());
    Me06CheckpointOutput {
        stage,
        session_key: event
            .map(|event| event.session_key.clone())
            .unwrap_or_default(),
        context_key: event
            .map(|event| event.context_key.clone())
            .unwrap_or_default(),
        raw_output: raw.to_string(),
        parsed_state: parsed
            .as_ref()
            .map(|value| value.state.clone())
            .unwrap_or_default(),
        parsed_action: parsed.as_ref().and_then(|value| value.action.clone()),
        protocol_shape_valid: parsed.is_some(),
    }
}

fn extract_json(raw: &str) -> Option<Value> {
    if let Ok(value) = serde_json::from_str(raw.trim()) {
        return Some(value);
    }
    let start = raw.find('{')?;
    for (index, _) in raw.char_indices().rev().filter(|(_, c)| *c == '}') {
        if index > start {
            if let Ok(value) = serde_json::from_str(&raw[start..=index]) {
                return Some(value);
            }
        }
    }
    None
}

fn group_stage_events(events: &[Me06Event]) -> BTreeMap<(String, String), Vec<Me06Event>> {
    let mut grouped = BTreeMap::new();
    for event in events {
        grouped
            .entry((event.context_key.clone(), event.session_key.clone()))
            .or_insert_with(Vec::new)
            .push(event.clone());
    }
    grouped
}

fn render_stage(
    fixture_id: &str,
    stage: usize,
    events: &[Me06Event],
    instruction: &str,
) -> Result<String, DynError> {
    Ok(format!(
        "Fixture: {fixture_id}\nCheckpoint: {stage}/12\nInstruction: {instruction}\nEvidence events (JSON):\n{}",
        serde_json::to_string_pretty(events)?
    ))
}

fn message(role: &str, content: &str) -> Message {
    Message {
        role: role.to_string(),
        content: content.to_string(),
        name: None,
        tool_call_id: None,
        tool_calls: None,
    }
}

fn stage_environment(
    base: &BTreeMap<String, String>,
    fixture: &Me06FixturePair,
    context_key: &str,
    session_key: &str,
) -> BTreeMap<String, String> {
    let mut environment = base.clone();
    environment.insert(
        "MORPHZ_CONTEXT_ID".to_string(),
        actual_context_id(fixture, context_key),
    );
    environment.insert(
        "MORPHZ_SESSION_ID".to_string(),
        actual_session_id(fixture, session_key),
    );
    environment
}

fn actual_context_id(fixture: &Me06FixturePair, key: &str) -> String {
    format!("{}-context-{key}", fixture.visible.fixture_id)
}
fn actual_session_id(fixture: &Me06FixturePair, key: &str) -> String {
    format!("{}-{key}", fixture.visible.fixture_id)
}

fn spawn_agent(
    binary: &Path,
    environment: &BTreeMap<String, String>,
    stdout: &Path,
    stderr: &Path,
) -> Result<Child, DynError> {
    let mut command = Command::new(binary);
    command
        .arg(format!("--profile={PROFILE}"))
        .arg("--plain")
        .envs(environment)
        .env("MORPHZ_BIND", "127.0.0.1:0")
        .env("MORPHZ_REPLY_WAIT_NOTICE_SECS", "600")
        .stdin(Stdio::piped())
        .stdout(Stdio::from(OpenOptions::new().append(true).open(stdout)?))
        .stderr(Stdio::from(OpenOptions::new().append(true).open(stderr)?));
    Ok(command.spawn()?)
}

async fn send_prompt(child: &mut Child, prompt: &str) -> Result<(), DynError> {
    let stdin = child.stdin.as_mut().ok_or("ME-06 Agent stdin is closed")?;
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
    if tokio::time::timeout(Duration::from_secs(30), child.wait())
        .await
        .is_err()
    {
        child.kill().await?;
        child.wait().await?;
    }
    Ok(())
}

async fn wait_for_store(path: &Path) -> Result<Arc<SqliteStore>, DynError> {
    let started = Instant::now();
    loop {
        if path.is_file() {
            if let Ok(store) = SqliteStore::new(&path.to_string_lossy()).await {
                return Ok(Arc::new(store));
            }
        }
        if started.elapsed() > Duration::from_secs(30) {
            return Err("ME-06 Runtime did not initialize SQLite".into());
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
    before: usize,
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
        if replies.len() > before {
            return Ok(replies
                .last()
                .and_then(|event| event.payload.get("text"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string());
        }
        if started.elapsed() > timeout {
            return Err(format!("ME-06 no reply for {session_id} within {timeout:?}").into());
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

fn validate_model_events(events: &[Event]) -> bool {
    let usages = events
        .iter()
        .filter(|event| event.topic == "runtime/model_usage")
        .collect::<Vec<_>>();
    !usages.is_empty()
        && usages.iter().all(|event| {
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
        })
}

fn append_jsonl(path: &Path, events: &[Me06Event]) -> Result<(), DynError> {
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    for event in events {
        serde_json::to_writer(&mut file, event)?;
        writeln!(file)?;
    }
    Ok(())
}

fn read_jsonl(path: &Path) -> Result<Vec<Value>, DynError> {
    std::fs::read_to_string(path)?
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| Ok(serde_json::from_str(line)?))
        .collect()
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), DynError> {
    std::fs::write(path, serde_json::to_vec_pretty(value)?)?;
    Ok(())
}

fn write_checksums(root: &Path) -> Result<(), DynError> {
    let mut entries = Vec::new();
    for entry in walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
    {
        let path = entry.path();
        if path.file_name().and_then(|name| name.to_str()) == Some("checksums.sha256") {
            continue;
        }
        entries.push((
            path.strip_prefix(root)?.to_string_lossy().to_string(),
            sha256(&std::fs::read(path)?),
        ));
    }
    entries.sort();
    let body = entries
        .into_iter()
        .map(|(path, digest)| format!("{digest}  {path}\n"))
        .collect::<String>();
    std::fs::write(root.join("checksums.sha256"), body)?;
    Ok(())
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn git_stdout(args: &[&str]) -> Result<String, DynError> {
    let output = std::process::Command::new("git").args(args).output()?;
    if !output.status.success() {
        return Err(format!("git {:?} failed", args).into());
    }
    Ok(String::from_utf8(output.stdout)?.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fenced_or_plain_json_semantically() {
        let plain = r#"{"state":{"project":"ORBIT-42"},"action":null}"#;
        let fenced = format!("result:\n```json\n{plain}\n```");
        for raw in [plain.to_string(), fenced] {
            let value = extract_json(&raw).expect("json");
            let parsed: ParsedOutput = serde_json::from_value(value).expect("shape");
            assert_eq!(
                parsed.state.get("project").map(String::as_str),
                Some("ORBIT-42")
            );
        }
    }

    #[test]
    fn stage_grouping_preserves_every_event() {
        let fixture = &generate_me06_fixtures().unwrap()[0];
        let events = fixture
            .visible
            .events
            .iter()
            .filter(|event| event.stage == 8)
            .cloned()
            .collect::<Vec<_>>();
        let grouped = group_stage_events(&events);
        assert_eq!(grouped.values().map(Vec::len).sum::<usize>(), events.len());
        assert_eq!(grouped.len(), 2);
    }
}
