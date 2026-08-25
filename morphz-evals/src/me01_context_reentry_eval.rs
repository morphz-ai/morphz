use chrono::Utc;
use morphz::config::AppConfig;
use morphz::event::Event;
use morphz::llm::{Client, Message, Response, ToolCallRepr, ToolDefinition};
use morphz::memory::{NewCognitiveContext, NewSession, QueryFilter, SessionMountKind};
use morphz::runtime::{MorphzRuntime, RuntimeIdentity, RuntimeToolPolicy};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::process::Command;

type DynError = Box<dyn std::error::Error + Send + Sync>;

pub const ME01_PROTOCOL_ID: &str = "me01-context-reentry-p1.1-candidate";
const FIXTURE_ROOT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/me01_context_reentry_p1"
);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Me01Arm {
    AppendOnly,
    StructuredNoDirectReentry,
    FullMorphz,
}

impl Me01Arm {
    pub const ALL: [Self; 3] = [
        Self::AppendOnly,
        Self::StructuredNoDirectReentry,
        Self::FullMorphz,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AppendOnly => "append_only",
            Self::StructuredNoDirectReentry => "structured_no_direct_reentry",
            Self::FullMorphz => "full_morphz",
        }
    }

    pub fn parse(value: &str) -> Result<Self, DynError> {
        match value {
            "append_only" => Ok(Self::AppendOnly),
            "structured_no_direct_reentry" => Ok(Self::StructuredNoDirectReentry),
            "full_morphz" => Ok(Self::FullMorphz),
            _ => Err(format!("unknown ME-01 arm: {value}").into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me01VisibleEvent {
    pub event_id: String,
    pub source: String,
    pub version: u64,
    pub timestamp: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me01Stage {
    pub id: String,
    pub context_key: String,
    pub session_key: String,
    pub events: Vec<Me01VisibleEvent>,
    pub instruction: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me01VisibleFixture {
    pub id: String,
    pub family: String,
    pub title: String,
    pub required_action: String,
    pub stages: Vec<Me01Stage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Me01Action {
    pub action: String,
    pub object_id: String,
    pub value: String,
    pub evidence_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me01HiddenFixture {
    pub fixture_id: String,
    pub expected: Me01Action,
    #[serde(default)]
    pub stale_values: Vec<String>,
    #[serde(default)]
    pub foreign_values: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me01FixturePair {
    pub visible: Me01VisibleFixture,
    pub hidden: Me01HiddenFixture,
    pub visible_sha256: String,
    pub hidden_sha256: String,
    pub canonical_semantic_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct Me01RuntimeEvidence {
    pub adapter_kind: String,
    pub production_morphz_runtime: bool,
    pub database_path: Option<PathBuf>,
    #[serde(default)]
    pub context_ids: Vec<String>,
    #[serde(default)]
    pub session_mounts: BTreeMap<String, String>,
    pub context_tx_tool_exposed: bool,
    pub context_tx_attempts: usize,
    pub context_tx_commits: usize,
    #[serde(default)]
    pub committed_frame_ids: Vec<String>,
    #[serde(default)]
    pub act_projection_frame_ids: Vec<String>,
    pub structured_context_snapshot_sha256: Option<String>,
    pub message_transcript_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me01ObservedEpisode {
    pub protocol_id: String,
    pub fixture_id: String,
    pub arm: Me01Arm,
    pub visible_input_sha256: String,
    pub final_response: String,
    pub runtime: Me01RuntimeEvidence,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me01EpisodeScore {
    pub protocol_id: String,
    pub fixture_id: String,
    pub arm: Me01Arm,
    pub parsed_action: Option<Me01Action>,
    pub json_contract_valid: bool,
    pub action_matches: bool,
    pub object_matches: bool,
    pub value_matches: bool,
    pub evidence_matches: bool,
    pub stale_value_reused: bool,
    pub foreign_value_reused: bool,
    pub task_success: bool,
    pub implementation_valid: bool,
    pub strict_success: bool,
    pub integrity_violations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me01FakeGateSummary {
    pub protocol_id: String,
    pub created_at: String,
    pub fixture_count: usize,
    pub positive_episode_count: usize,
    pub positive_strict_passes: usize,
    pub negative_case_count: usize,
    pub negative_cases_rejected: usize,
    pub output_root: PathBuf,
    pub ready_for_runtime_adapter_implementation: bool,
    pub ready_for_real_model_smoke: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me01EmbeddedRuntimeArmGate {
    pub arm: Me01Arm,
    pub database_path: PathBuf,
    pub fake_provider_calls: usize,
    pub context_tx_tool_seen_by_provider: bool,
    pub context_tx_attempts: usize,
    pub context_tx_commits: usize,
    pub committed_frame_visible_in_act_request: bool,
    pub committed_frame_visible_in_final_context: bool,
    pub final_response: String,
    pub passed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me01EmbeddedRuntimeGateSummary {
    pub protocol_id: String,
    pub created_at: String,
    pub output_root: PathBuf,
    pub full_morphz: Me01EmbeddedRuntimeArmGate,
    pub structured_no_direct_reentry: Me01EmbeddedRuntimeArmGate,
    pub all_passed: bool,
    pub real_model_called: bool,
    pub ready_for_real_model_smoke: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Me01ProbePhase {
    BeforeRestart,
    AfterRestart,
}

impl Me01ProbePhase {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::BeforeRestart => "before_restart",
            Self::AfterRestart => "after_restart",
        }
    }

    pub fn parse(value: &str) -> Result<Self, DynError> {
        match value {
            "before_restart" => Ok(Self::BeforeRestart),
            "after_restart" => Ok(Self::AfterRestart),
            _ => Err(format!("unknown ME-01 probe phase: {value}").into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me01ProcessPhaseReport {
    pub protocol_id: String,
    pub fixture_id: String,
    pub arm: Me01Arm,
    pub phase: Me01ProbePhase,
    pub process_id: u32,
    pub database_path: PathBuf,
    pub context_ids: Vec<String>,
    pub session_mounts: BTreeMap<String, String>,
    pub fake_provider_calls: usize,
    pub context_tx_tool_seen_by_provider: bool,
    pub context_tx_attempts: usize,
    pub context_tx_commits: usize,
    pub committed_frame_visible_in_act_request: bool,
    pub committed_frame_visible_in_primary_context: bool,
    pub foreign_value_absent_from_primary_context: bool,
    pub structured_context_snapshot_sha256: String,
    pub final_response: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me01StandaloneEpisodeGate {
    pub fixture_id: String,
    pub arm: Me01Arm,
    pub observed_episode_path: PathBuf,
    pub score_path: PathBuf,
    pub before_restart_process_id: Option<u32>,
    pub after_restart_process_id: Option<u32>,
    pub process_restart_proven: bool,
    pub independent_database_proven: bool,
    pub score_replay_byte_identical: bool,
    pub strict_success: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me01StandaloneGateSummary {
    pub protocol_id: String,
    pub created_at: String,
    pub output_root: PathBuf,
    pub fixture_count: usize,
    pub episode_count: usize,
    pub strict_passes: usize,
    pub process_restart_checks: usize,
    pub process_restart_passes: usize,
    pub isolated_database_count: usize,
    pub score_replay_checks: usize,
    pub score_replay_passes: usize,
    pub cross_session_mount_passed: bool,
    pub context_isolation_passed: bool,
    pub all_passed: bool,
    pub real_model_called: bool,
    pub standalone_process_arm_adapters_complete: bool,
    pub ready_for_real_model_smoke: bool,
    pub episodes: Vec<Me01StandaloneEpisodeGate>,
}

pub fn load_me01_fixtures() -> Result<Vec<Me01FixturePair>, DynError> {
    let visible_root = Path::new(FIXTURE_ROOT).join("visible");
    let hidden_root = Path::new(FIXTURE_ROOT).join("hidden");
    let mut paths = std::fs::read_dir(&visible_root)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    paths.sort();

    let mut fixtures = Vec::with_capacity(paths.len());
    for visible_path in paths {
        let file_name = visible_path
            .file_name()
            .ok_or("ME-01 visible fixture is missing a file name")?;
        let hidden_path = hidden_root.join(file_name);
        let visible_bytes = std::fs::read(&visible_path)?;
        let hidden_bytes = std::fs::read(&hidden_path)?;
        let visible: Me01VisibleFixture = serde_json::from_slice(&visible_bytes)?;
        let hidden: Me01HiddenFixture = serde_json::from_slice(&hidden_bytes)?;
        validate_fixture_pair(&visible, &hidden)?;
        fixtures.push(Me01FixturePair {
            visible_sha256: sha256(&visible_bytes),
            hidden_sha256: sha256(&hidden_bytes),
            canonical_semantic_sha256: canonical_semantic_sha256(&visible)?,
            visible,
            hidden,
        });
    }
    if fixtures.is_empty() {
        return Err("ME-01 fixture set is empty".into());
    }
    Ok(fixtures)
}

pub fn canonical_semantic_sha256(fixture: &Me01VisibleFixture) -> Result<String, DynError> {
    Ok(sha256(&serde_json::to_vec(fixture)?))
}

pub fn score_me01_episode(
    observed: &Me01ObservedEpisode,
    fixture: &Me01FixturePair,
) -> Me01EpisodeScore {
    let parsed_action = serde_json::from_str::<Me01Action>(observed.final_response.trim()).ok();
    let json_contract_valid = parsed_action.is_some();
    let action_matches = parsed_action
        .as_ref()
        .is_some_and(|value| value.action == fixture.hidden.expected.action);
    let object_matches = parsed_action
        .as_ref()
        .is_some_and(|value| value.object_id == fixture.hidden.expected.object_id);
    let value_matches = parsed_action
        .as_ref()
        .is_some_and(|value| value.value == fixture.hidden.expected.value);
    let evidence_matches = parsed_action
        .as_ref()
        .is_some_and(|value| value.evidence_id == fixture.hidden.expected.evidence_id);
    let stale_value_reused = parsed_action.as_ref().is_some_and(|value| {
        fixture
            .hidden
            .stale_values
            .iter()
            .any(|candidate| candidate == &value.value)
    });
    let foreign_value_reused = parsed_action.as_ref().is_some_and(|value| {
        fixture
            .hidden
            .foreign_values
            .iter()
            .any(|candidate| candidate == &value.value)
    });
    let task_success = json_contract_valid
        && action_matches
        && object_matches
        && value_matches
        && evidence_matches;
    let integrity_violations = implementation_violations(observed, fixture);
    let implementation_valid = integrity_violations.is_empty();
    Me01EpisodeScore {
        protocol_id: ME01_PROTOCOL_ID.to_string(),
        fixture_id: observed.fixture_id.clone(),
        arm: observed.arm,
        parsed_action,
        json_contract_valid,
        action_matches,
        object_matches,
        value_matches,
        evidence_matches,
        stale_value_reused,
        foreign_value_reused,
        task_success,
        implementation_valid,
        strict_success: task_success && implementation_valid,
        integrity_violations,
    }
}

pub fn run_me01_fake_gate(base_dir: Option<&Path>) -> Result<Me01FakeGateSummary, DynError> {
    let fixtures = load_me01_fixtures()?;
    let base = base_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("morphz-me01-gates"));
    std::fs::create_dir_all(&base)?;
    let output_root = base.join(format!(
        "ME-01-fake-gate-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        std::process::id()
    ));
    std::fs::create_dir_all(&output_root)?;

    let mut positive_scores = Vec::new();
    for fixture in &fixtures {
        for arm in Me01Arm::ALL {
            let observed = fake_observed_episode(fixture, arm, &fixture.hidden.expected);
            let score = score_me01_episode(&observed, fixture);
            if !score.strict_success {
                return Err(format!(
                    "positive fake gate failed for {} / {}: {:?}",
                    fixture.visible.id,
                    arm.as_str(),
                    score.integrity_violations
                )
                .into());
            }
            let episode_root =
                output_root.join(format!("{}__{}", fixture.visible.id, arm.as_str()));
            std::fs::create_dir_all(&episode_root)?;
            std::fs::write(
                episode_root.join("observed_episode.json"),
                serde_json::to_vec_pretty(&observed)?,
            )?;
            std::fs::write(
                episode_root.join("score.json"),
                serde_json::to_vec_pretty(&score)?,
            )?;
            positive_scores.push(score);
        }
    }

    let negative_scores = fake_negative_scores(&fixtures[0]);
    if negative_scores.iter().any(|score| score.strict_success) {
        return Err("at least one ME-01 negative fake gate incorrectly passed".into());
    }
    std::fs::write(
        output_root.join("negative_scores.json"),
        serde_json::to_vec_pretty(&negative_scores)?,
    )?;

    let summary = Me01FakeGateSummary {
        protocol_id: ME01_PROTOCOL_ID.to_string(),
        created_at: Utc::now().to_rfc3339(),
        fixture_count: fixtures.len(),
        positive_episode_count: positive_scores.len(),
        positive_strict_passes: positive_scores
            .iter()
            .filter(|score| score.strict_success)
            .count(),
        negative_case_count: negative_scores.len(),
        negative_cases_rejected: negative_scores
            .iter()
            .filter(|score| !score.strict_success)
            .count(),
        output_root: output_root.clone(),
        ready_for_runtime_adapter_implementation: true,
        ready_for_real_model_smoke: false,
    };
    std::fs::write(
        output_root.join("summary.json"),
        serde_json::to_vec_pretty(&summary)?,
    )?;
    Ok(summary)
}

pub async fn run_me01_embedded_runtime_gate(
    base_dir: Option<&Path>,
) -> Result<Me01EmbeddedRuntimeGateSummary, DynError> {
    let fixture = load_me01_fixtures()?
        .into_iter()
        .find(|fixture| fixture.visible.family == "delayed_reference")
        .ok_or("ME-01 delayed-reference fixture is missing")?;
    let base = base_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("morphz-me01-runtime-gates"));
    std::fs::create_dir_all(&base)?;
    let output_root = base.join(format!(
        "ME-01-embedded-runtime-gate-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        std::process::id()
    ));
    std::fs::create_dir_all(&output_root)?;

    let full_morphz = run_embedded_runtime_arm(&output_root, &fixture, Me01Arm::FullMorphz).await?;
    let structured_no_direct_reentry =
        run_embedded_runtime_arm(&output_root, &fixture, Me01Arm::StructuredNoDirectReentry)
            .await?;
    let all_passed = full_morphz.passed && structured_no_direct_reentry.passed;
    let summary = Me01EmbeddedRuntimeGateSummary {
        protocol_id: ME01_PROTOCOL_ID.to_string(),
        created_at: Utc::now().to_rfc3339(),
        output_root: output_root.clone(),
        full_morphz,
        structured_no_direct_reentry,
        all_passed,
        real_model_called: false,
        ready_for_real_model_smoke: false,
    };
    std::fs::write(
        output_root.join("summary.json"),
        serde_json::to_vec_pretty(&summary)?,
    )?;
    Ok(summary)
}

pub async fn run_me01_process_probe_phase(
    episode_root: &Path,
    fixture_id: &str,
    arm: Me01Arm,
    phase: Me01ProbePhase,
) -> Result<Me01ProcessPhaseReport, DynError> {
    if arm == Me01Arm::AppendOnly {
        return Err("append-only does not use the production Runtime probe".into());
    }
    let fixture = load_me01_fixtures()?
        .into_iter()
        .find(|fixture| fixture.visible.id == fixture_id)
        .ok_or_else(|| format!("unknown ME-01 fixture: {fixture_id}"))?;
    std::fs::create_dir_all(episode_root)?;
    let workspace_root = episode_root.join("workspace");
    let artifact_root = episode_root.join("artifacts");
    std::fs::create_dir_all(&workspace_root)?;
    std::fs::create_dir_all(&artifact_root)?;
    let database_path = episode_root.join("morphz.db");
    let frame_id = fixture_frame_id(&fixture.visible.id);
    let client = Arc::new(ProcessProbeFakeClient {
        expected_action: fixture.hidden.expected.clone(),
        frame_id: frame_id.clone(),
        calls: AtomicUsize::new(0),
        context_tx_tool_seen: AtomicBool::new(false),
        frame_seen_in_act: AtomicBool::new(false),
    });
    let mut config = AppConfig::default();
    config.permissions.workspace_root = workspace_root.to_string_lossy().to_string();
    config.background_task.artifact_dir = artifact_root.to_string_lossy().to_string();
    config.orchestrator.context_transactions_enabled = arm == Me01Arm::FullMorphz;
    let primary_context_id = actual_context_id(&fixture.visible.id, "primary");
    let identity = RuntimeIdentity {
        agent_id: format!("me01-agent-{}", filesystem_component(&fixture.visible.id)),
        context_id: primary_context_id.clone(),
        principal_id: format!(
            "me01-principal-{}",
            filesystem_component(&fixture.visible.id)
        ),
    };
    let runtime = MorphzRuntime::builder(config, Arc::clone(&client) as Arc<dyn Client>)
        .identity(identity.clone())
        .database_path(database_path.to_string_lossy())
        .tool_policy(RuntimeToolPolicy {
            context_only: true,
            coding_eval: true,
        })
        .build()
        .await?;
    let mut replies = runtime.subscribe("chat/reply", 32);
    runtime.start().await?;

    let context_ids = fixture_context_ids_actual(&fixture.visible);
    for context_id in &context_ids {
        runtime
            .ensure_context(NewCognitiveContext {
                id: context_id.clone(),
                agent_id: identity.agent_id.clone(),
                title: format!("ME-01 context {context_id}"),
            })
            .await?;
    }
    let session_mounts = fixture_session_mounts_actual(&fixture.visible);
    for (session_id, context_id) in &session_mounts {
        runtime
            .ensure_session(NewSession {
                id: session_id.clone(),
                agent_id: identity.agent_id.clone(),
                context_id: context_id.clone(),
                parent_session_id: None,
                title: format!("ME-01 session {session_id}"),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await?;
    }

    let stages = fixture.visible.stages.iter().filter(|stage| match phase {
        Me01ProbePhase::BeforeRestart => stage.id != "act",
        Me01ProbePhase::AfterRestart => stage.id == "act",
    });
    let mut final_response = String::new();
    for stage in stages {
        let session_id = actual_session_id(&fixture.visible.id, &stage.session_key);
        runtime
            .session(session_id.clone())
            .send(
                render_stage_prompt(stage)?,
                "ME-01-Fixture",
                Some(format!(
                    "me01-{}-{}-{}",
                    arm.as_str(),
                    phase.as_str(),
                    stage.id
                )),
            )
            .await?;
        let reply = wait_for_session_reply(&mut replies, &session_id).await?;
        if stage.id == "act" {
            final_response = reply;
        }
    }

    let events = runtime.query_events(QueryFilter::default()).await?;
    let context_tx_attempts = count_context_tx_attempts(&events);
    let context_tx_commits = events
        .iter()
        .filter(|event| event.topic == "chat/context_tx_committed")
        .count();
    let mut snapshots = BTreeMap::new();
    for context_id in &context_ids {
        let session_id = session_mounts
            .iter()
            .find_map(|(session_id, mounted)| (mounted == context_id).then_some(session_id))
            .ok_or_else(|| format!("ME-01 context {context_id} has no mounted session"))?;
        let encoding = runtime.context_encoding(context_id, session_id).await?;
        snapshots.insert(context_id.clone(), encoding.sexpr);
    }
    let primary_context = snapshots
        .get(&primary_context_id)
        .ok_or("ME-01 primary Context snapshot is missing")?;
    let committed_frame_visible_in_primary_context = primary_context.contains(&frame_id);
    let foreign_value_absent_from_primary_context = fixture
        .hidden
        .foreign_values
        .iter()
        .all(|value| !primary_context.contains(value));
    let structured_context_snapshot_sha256 = sha256(&serde_json::to_vec(&snapshots)?);
    let report = Me01ProcessPhaseReport {
        protocol_id: ME01_PROTOCOL_ID.to_string(),
        fixture_id: fixture.visible.id,
        arm,
        phase,
        process_id: std::process::id(),
        database_path,
        context_ids,
        session_mounts,
        fake_provider_calls: client.calls.load(Ordering::SeqCst),
        context_tx_tool_seen_by_provider: client.context_tx_tool_seen.load(Ordering::SeqCst),
        context_tx_attempts,
        context_tx_commits,
        committed_frame_visible_in_act_request: client.frame_seen_in_act.load(Ordering::SeqCst),
        committed_frame_visible_in_primary_context,
        foreign_value_absent_from_primary_context,
        structured_context_snapshot_sha256,
        final_response,
    };
    write_json(
        &episode_root.join(format!("{}.json", phase.as_str())),
        &report,
    )?;
    Ok(report)
}

pub async fn run_me01_standalone_process_gate(
    executable: &Path,
    base_dir: Option<&Path>,
) -> Result<Me01StandaloneGateSummary, DynError> {
    let executable = std::fs::canonicalize(executable)?;
    let fixtures = load_me01_fixtures()?;
    let base = base_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("morphz-me01-process-gates"));
    std::fs::create_dir_all(&base)?;
    let output_root = base.join(format!(
        "ME-01-standalone-process-gate-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        std::process::id()
    ));
    std::fs::create_dir_all(&output_root)?;

    let mut episodes = Vec::new();
    let mut database_paths = BTreeSet::new();
    let mut cross_session_mount_passed = false;
    let mut context_isolation_passed = false;
    for fixture in &fixtures {
        episodes.push(run_append_only_gate(&output_root, fixture)?);
        for arm in [Me01Arm::StructuredNoDirectReentry, Me01Arm::FullMorphz] {
            let episode_root = output_root
                .join(fixture.visible.id.as_str())
                .join(arm.as_str());
            std::fs::create_dir_all(&episode_root)?;
            let before = spawn_process_probe(
                &executable,
                &episode_root,
                &fixture.visible.id,
                arm,
                Me01ProbePhase::BeforeRestart,
            )
            .await?;
            let after = spawn_process_probe(
                &executable,
                &episode_root,
                &fixture.visible.id,
                arm,
                Me01ProbePhase::AfterRestart,
            )
            .await?;
            if before.database_path != after.database_path {
                return Err(format!(
                    "ME-01 process phases used different databases for {} / {}",
                    fixture.visible.id,
                    arm.as_str()
                )
                .into());
            }
            database_paths.insert(after.database_path.clone());
            let frame_id = fixture_frame_id(&fixture.visible.id);
            let runtime = Me01RuntimeEvidence {
                adapter_kind: match arm {
                    Me01Arm::StructuredNoDirectReentry => {
                        "production_morphz_read_only_context".to_string()
                    }
                    Me01Arm::FullMorphz => "production_morphz_full_context".to_string(),
                    Me01Arm::AppendOnly => unreachable!(),
                },
                production_morphz_runtime: true,
                database_path: Some(after.database_path.clone()),
                context_ids: after.context_ids.clone(),
                session_mounts: after.session_mounts.clone(),
                context_tx_tool_exposed: before.context_tx_tool_seen_by_provider
                    || after.context_tx_tool_seen_by_provider,
                context_tx_attempts: after.context_tx_attempts,
                context_tx_commits: after.context_tx_commits,
                committed_frame_ids: (arm == Me01Arm::FullMorphz
                    && after.committed_frame_visible_in_primary_context)
                    .then_some(frame_id.clone())
                    .into_iter()
                    .collect(),
                act_projection_frame_ids: (arm == Me01Arm::FullMorphz
                    && after.committed_frame_visible_in_act_request)
                    .then_some(frame_id)
                    .into_iter()
                    .collect(),
                structured_context_snapshot_sha256: Some(
                    after.structured_context_snapshot_sha256.clone(),
                ),
                message_transcript_sha256: None,
            };
            let observed = Me01ObservedEpisode {
                protocol_id: ME01_PROTOCOL_ID.to_string(),
                fixture_id: fixture.visible.id.clone(),
                arm,
                visible_input_sha256: fixture.canonical_semantic_sha256.clone(),
                final_response: after.final_response.clone(),
                runtime,
            };
            let score = score_me01_episode(&observed, fixture);
            let observed_episode_path = episode_root.join("observed_episode.json");
            let score_path = episode_root.join("score.json");
            write_json(&observed_episode_path, &observed)?;
            write_json(&score_path, &score)?;
            let replayed_observed: Me01ObservedEpisode =
                serde_json::from_slice(&std::fs::read(&observed_episode_path)?)?;
            let replayed_score = score_me01_episode(&replayed_observed, fixture);
            let score_replay_byte_identical =
                serde_json::to_vec_pretty(&score)? == serde_json::to_vec_pretty(&replayed_score)?;
            let process_restart_proven = before.process_id != after.process_id;
            if fixture.visible.family == "cross_session_continuity" {
                let session_a = actual_session_id(&fixture.visible.id, "session-a");
                let session_b = actual_session_id(&fixture.visible.id, "session-b");
                cross_session_mount_passed = after.session_mounts.contains_key(&session_a)
                    && after.session_mounts.get(&session_a) == after.session_mounts.get(&session_b);
            }
            if fixture.visible.family == "context_isolation" {
                let foreign = actual_session_id(&fixture.visible.id, "session-foreign");
                let primary = actual_session_id(&fixture.visible.id, "session-primary");
                context_isolation_passed = after.session_mounts.contains_key(&foreign)
                    && after.session_mounts.contains_key(&primary)
                    && after.session_mounts.get(&foreign) != after.session_mounts.get(&primary)
                    && after.foreign_value_absent_from_primary_context;
            }
            episodes.push(Me01StandaloneEpisodeGate {
                fixture_id: fixture.visible.id.clone(),
                arm,
                observed_episode_path,
                score_path,
                before_restart_process_id: Some(before.process_id),
                after_restart_process_id: Some(after.process_id),
                process_restart_proven,
                independent_database_proven: true,
                score_replay_byte_identical,
                strict_success: score.strict_success,
            });
        }
    }

    let strict_passes = episodes
        .iter()
        .filter(|episode| episode.strict_success)
        .count();
    let process_episodes = episodes
        .iter()
        .filter(|episode| episode.arm != Me01Arm::AppendOnly)
        .collect::<Vec<_>>();
    let process_restart_passes = process_episodes
        .iter()
        .filter(|episode| episode.process_restart_proven)
        .count();
    let score_replay_passes = episodes
        .iter()
        .filter(|episode| episode.score_replay_byte_identical)
        .count();
    let all_passed = strict_passes == episodes.len()
        && process_restart_passes == process_episodes.len()
        && database_paths.len() == process_episodes.len()
        && score_replay_passes == episodes.len()
        && cross_session_mount_passed
        && context_isolation_passed;
    let summary = Me01StandaloneGateSummary {
        protocol_id: ME01_PROTOCOL_ID.to_string(),
        created_at: Utc::now().to_rfc3339(),
        output_root: output_root.clone(),
        fixture_count: fixtures.len(),
        episode_count: episodes.len(),
        strict_passes,
        process_restart_checks: process_episodes.len(),
        process_restart_passes,
        isolated_database_count: database_paths.len(),
        score_replay_checks: episodes.len(),
        score_replay_passes,
        cross_session_mount_passed,
        context_isolation_passed,
        all_passed,
        real_model_called: false,
        standalone_process_arm_adapters_complete: all_passed,
        ready_for_real_model_smoke: false,
        episodes,
    };
    write_json(&output_root.join("summary.json"), &summary)?;
    write_checksums(&output_root)?;
    Ok(summary)
}

fn validate_fixture_pair(
    visible: &Me01VisibleFixture,
    hidden: &Me01HiddenFixture,
) -> Result<(), DynError> {
    if visible.id != hidden.fixture_id {
        return Err(format!(
            "ME-01 fixture identity mismatch: {} != {}",
            visible.id, hidden.fixture_id
        )
        .into());
    }
    if visible.stages.len() < 3 {
        return Err(format!("{} must contain at least three stages", visible.id).into());
    }
    if visible.stages.last().map(|stage| stage.id.as_str()) != Some("act") {
        return Err(format!("{} must end with an act stage", visible.id).into());
    }
    if visible.required_action.trim().is_empty()
        || visible.required_action != hidden.expected.action
    {
        return Err(format!(
            "{} must expose the exact required action vocabulary used by the scorer",
            visible.id
        )
        .into());
    }
    let mut event_ids = BTreeSet::new();
    for stage in &visible.stages {
        if stage.context_key.trim().is_empty()
            || stage.session_key.trim().is_empty()
            || stage.instruction.trim().is_empty()
        {
            return Err(format!("{} has an incomplete stage", visible.id).into());
        }
        for event in &stage.events {
            if !event_ids.insert(event.event_id.as_str()) {
                return Err(
                    format!("{} repeats visible event id {}", visible.id, event.event_id).into(),
                );
            }
        }
    }
    if !event_ids.contains(hidden.expected.evidence_id.as_str()) {
        return Err(format!(
            "{} expected evidence {} is not visible",
            visible.id, hidden.expected.evidence_id
        )
        .into());
    }
    Ok(())
}

struct EmbeddedRuntimeFakeClient {
    expected_action: Me01Action,
    calls: AtomicUsize,
    context_tx_tool_seen: AtomicBool,
    frame_seen_in_act: AtomicBool,
}

struct ProcessProbeFakeClient {
    expected_action: Me01Action,
    frame_id: String,
    calls: AtomicUsize,
    context_tx_tool_seen: AtomicBool,
    frame_seen_in_act: AtomicBool,
}

#[async_trait::async_trait]
impl Client for ProcessProbeFakeClient {
    async fn create_completion(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
    ) -> Result<Response, DynError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let prompt = messages
            .iter()
            .map(|message| message.content.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let context_tx_exposed = tools.iter().any(|tool| tool.name == "context_tx");
        self.context_tx_tool_seen
            .fetch_or(context_tx_exposed, Ordering::SeqCst);

        if prompt.contains("Return only the strict four-field JSON action contract") {
            self.frame_seen_in_act
                .fetch_or(prompt.contains(&self.frame_id), Ordering::SeqCst);
            return Ok(Response {
                content: serde_json::to_string(&self.expected_action)?,
                tool_calls: Vec::new(),
            });
        }

        if context_tx_exposed
            && prompt.contains(&self.expected_action.evidence_id)
            && !prompt.contains(&self.frame_id)
        {
            let source_ref =
                observation_ref_before(&prompt, &self.expected_action.evidence_id).unwrap_or("@e1");
            let version = kernel_context_version(&prompt).unwrap_or(0);
            let transaction = format!(
                "(context-tx (base-version {version}) (reason \"ME-01 deterministic standalone-process gate\") (derive {} (from {source_ref}) (state (action \"{}\") (object-id \"{}\") (value \"{}\") (authoritative-evidence \"{}\"))))",
                self.frame_id,
                sexpr_string(&self.expected_action.action),
                sexpr_string(&self.expected_action.object_id),
                sexpr_string(&self.expected_action.value),
                sexpr_string(&self.expected_action.evidence_id),
            );
            return Ok(Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: format!("me01-context-tx-{}", self.calls.load(Ordering::SeqCst)),
                    r#type: "function".to_string(),
                    func_name: "context_tx".to_string(),
                    arguments: serde_json::json!({"transaction": transaction}).to_string(),
                }],
            });
        }

        Ok(Response {
            content: "ME-01 stage state accepted.".to_string(),
            tool_calls: Vec::new(),
        })
    }
}

#[async_trait::async_trait]
impl Client for EmbeddedRuntimeFakeClient {
    async fn create_completion(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
    ) -> Result<Response, DynError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let prompt = messages
            .iter()
            .map(|message| message.content.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let context_tx_exposed = tools.iter().any(|tool| tool.name == "context_tx");
        self.context_tx_tool_seen
            .fetch_or(context_tx_exposed, Ordering::SeqCst);

        if prompt.contains("Return only the strict four-field JSON action contract") {
            self.frame_seen_in_act
                .fetch_or(prompt.contains("service-orion-current"), Ordering::SeqCst);
            return Ok(Response {
                content: serde_json::to_string(&self.expected_action)?,
                tool_calls: Vec::new(),
            });
        }

        if context_tx_exposed
            && prompt.contains("ev-dr-001")
            && !prompt.contains("service-orion-current")
        {
            let source_ref = observation_ref_before(&prompt, "ev-dr-001").unwrap_or("@e1");
            let version = kernel_context_version(&prompt).unwrap_or(0);
            let transaction = format!(
                "(context-tx (base-version {version}) (reason \"ME-01 deterministic fake-provider contract gate\") (derive service-orion-current (from {source_ref}) (state (object-id service-orion) (deployment-channel blue-17) (authoritative-evidence ev-dr-001))))"
            );
            return Ok(Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: "me01-context-tx-1".to_string(),
                    r#type: "function".to_string(),
                    func_name: "context_tx".to_string(),
                    arguments: serde_json::json!({"transaction": transaction}).to_string(),
                }],
            });
        }

        Ok(Response {
            content: "ME-01 stage state accepted.".to_string(),
            tool_calls: Vec::new(),
        })
    }
}

async fn run_embedded_runtime_arm(
    output_root: &Path,
    fixture: &Me01FixturePair,
    arm: Me01Arm,
) -> Result<Me01EmbeddedRuntimeArmGate, DynError> {
    if arm == Me01Arm::AppendOnly {
        return Err("embedded Runtime gate does not run the append-only adapter".into());
    }
    let arm_root = output_root.join(arm.as_str());
    let workspace_root = arm_root.join("workspace");
    let artifact_root = arm_root.join("artifacts");
    std::fs::create_dir_all(&workspace_root)?;
    std::fs::create_dir_all(&artifact_root)?;
    let database_path = arm_root.join("morphz.db");

    let client = Arc::new(EmbeddedRuntimeFakeClient {
        expected_action: fixture.hidden.expected.clone(),
        calls: AtomicUsize::new(0),
        context_tx_tool_seen: AtomicBool::new(false),
        frame_seen_in_act: AtomicBool::new(false),
    });
    let mut config = AppConfig::default();
    config.permissions.workspace_root = workspace_root.to_string_lossy().to_string();
    config.background_task.artifact_dir = artifact_root.to_string_lossy().to_string();
    config.orchestrator.context_transactions_enabled = arm == Me01Arm::FullMorphz;
    let runtime = MorphzRuntime::builder(config, Arc::clone(&client) as Arc<dyn Client>)
        .database_path(database_path.to_string_lossy())
        .tool_policy(RuntimeToolPolicy {
            context_only: true,
            coding_eval: true,
        })
        .build()
        .await?;
    let mut replies = runtime.subscribe("chat/reply", 16);
    runtime.start().await?;
    let session_id = format!("me01-{}-session-a", arm.as_str());
    let session = runtime
        .ensure_session(NewSession {
            id: session_id.clone(),
            agent_id: runtime.identity().agent_id.clone(),
            context_id: runtime.identity().context_id.clone(),
            parent_session_id: None,
            title: format!("ME-01 {} embedded Runtime gate", arm.as_str()),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await?;

    let mut final_response = String::new();
    for stage in &fixture.visible.stages {
        let prompt = render_stage_prompt(stage)?;
        session
            .send(
                prompt,
                "ME-01-Fixture",
                Some(format!("me01-{}-{}", arm.as_str(), stage.id)),
            )
            .await?;
        let reply = wait_for_session_reply(&mut replies, &session_id).await?;
        if stage.id == "act" {
            final_response = reply;
        }
    }

    let events = runtime
        .query_events(QueryFilter {
            context_id: Some(runtime.identity().context_id.clone()),
            ..QueryFilter::default()
        })
        .await?;
    let context_tx_attempts = count_context_tx_attempts(&events);
    let context_tx_commits = events
        .iter()
        .filter(|event| event.topic == "chat/context_tx_committed")
        .count();
    let final_context = runtime
        .context_encoding(&runtime.identity().context_id, &session_id)
        .await?;
    let committed_frame_visible_in_final_context =
        final_context.sexpr.contains("service-orion-current");
    let fake_provider_calls = client.calls.load(Ordering::SeqCst);
    let context_tx_tool_seen_by_provider = client.context_tx_tool_seen.load(Ordering::SeqCst);
    let committed_frame_visible_in_act_request = client.frame_seen_in_act.load(Ordering::SeqCst);
    let task_action_valid = serde_json::from_str::<Me01Action>(&final_response)
        .is_ok_and(|action| action == fixture.hidden.expected);
    let passed = match arm {
        Me01Arm::FullMorphz => {
            context_tx_tool_seen_by_provider
                && context_tx_attempts >= 1
                && context_tx_commits >= 1
                && committed_frame_visible_in_act_request
                && committed_frame_visible_in_final_context
                && task_action_valid
        }
        Me01Arm::StructuredNoDirectReentry => {
            !context_tx_tool_seen_by_provider
                && context_tx_attempts == 0
                && context_tx_commits == 0
                && !committed_frame_visible_in_act_request
                && !committed_frame_visible_in_final_context
                && task_action_valid
        }
        Me01Arm::AppendOnly => false,
    };
    let report = Me01EmbeddedRuntimeArmGate {
        arm,
        database_path,
        fake_provider_calls,
        context_tx_tool_seen_by_provider,
        context_tx_attempts,
        context_tx_commits,
        committed_frame_visible_in_act_request,
        committed_frame_visible_in_final_context,
        final_response,
        passed,
    };
    std::fs::write(
        arm_root.join("gate.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(report)
}

async fn spawn_process_probe(
    executable: &Path,
    episode_root: &Path,
    fixture_id: &str,
    arm: Me01Arm,
    phase: Me01ProbePhase,
) -> Result<Me01ProcessPhaseReport, DynError> {
    let output = Command::new(executable)
        .arg("runtime-probe-phase")
        .arg(episode_root)
        .arg(fixture_id)
        .arg(arm.as_str())
        .arg(phase.as_str())
        .output()
        .await?;
    std::fs::write(
        episode_root.join(format!("{}.stdout.log", phase.as_str())),
        &output.stdout,
    )?;
    std::fs::write(
        episode_root.join(format!("{}.stderr.log", phase.as_str())),
        &output.stderr,
    )?;
    if !output.status.success() {
        return Err(format!(
            "ME-01 process probe failed for {fixture_id} / {} / {}: {}",
            arm.as_str(),
            phase.as_str(),
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    let report_path = episode_root.join(format!("{}.json", phase.as_str()));
    let report: Me01ProcessPhaseReport = serde_json::from_slice(&std::fs::read(&report_path)?)?;
    if report.fixture_id != fixture_id || report.arm != arm || report.phase != phase {
        return Err(format!(
            "ME-01 process probe identity mismatch for {fixture_id} / {} / {}",
            arm.as_str(),
            phase.as_str()
        )
        .into());
    }
    Ok(report)
}

fn run_append_only_gate(
    output_root: &Path,
    fixture: &Me01FixturePair,
) -> Result<Me01StandaloneEpisodeGate, DynError> {
    let episode_root = output_root
        .join(fixture.visible.id.as_str())
        .join(Me01Arm::AppendOnly.as_str());
    std::fs::create_dir_all(&episode_root)?;
    let mut transcript = Vec::new();
    for stage in &fixture.visible.stages {
        transcript.push(serde_json::json!({
            "role": "user",
            "context_key": stage.context_key,
            "session_key": stage.session_key,
            "stage_id": stage.id,
            "content": render_stage_prompt(stage)?,
        }));
        transcript.push(serde_json::json!({
            "role": "assistant",
            "context_key": stage.context_key,
            "session_key": stage.session_key,
            "stage_id": stage.id,
            "content": if stage.id == "act" {
                serde_json::to_string(&fixture.hidden.expected)?
            } else {
                "ME-01 stage state accepted.".to_string()
            },
        }));
    }
    let transcript_bytes = serde_json::to_vec_pretty(&transcript)?;
    std::fs::write(
        episode_root.join("message_transcript.json"),
        &transcript_bytes,
    )?;
    let observed = Me01ObservedEpisode {
        protocol_id: ME01_PROTOCOL_ID.to_string(),
        fixture_id: fixture.visible.id.clone(),
        arm: Me01Arm::AppendOnly,
        visible_input_sha256: fixture.canonical_semantic_sha256.clone(),
        final_response: serde_json::to_string(&fixture.hidden.expected)?,
        runtime: Me01RuntimeEvidence {
            adapter_kind: "append_only_messages".to_string(),
            message_transcript_sha256: Some(sha256(&transcript_bytes)),
            ..Me01RuntimeEvidence::default()
        },
    };
    let score = score_me01_episode(&observed, fixture);
    let observed_episode_path = episode_root.join("observed_episode.json");
    let score_path = episode_root.join("score.json");
    write_json(&observed_episode_path, &observed)?;
    write_json(&score_path, &score)?;
    let replayed_observed: Me01ObservedEpisode =
        serde_json::from_slice(&std::fs::read(&observed_episode_path)?)?;
    let replayed_score = score_me01_episode(&replayed_observed, fixture);
    let score_replay_byte_identical =
        serde_json::to_vec_pretty(&score)? == serde_json::to_vec_pretty(&replayed_score)?;
    Ok(Me01StandaloneEpisodeGate {
        fixture_id: fixture.visible.id.clone(),
        arm: Me01Arm::AppendOnly,
        observed_episode_path,
        score_path,
        before_restart_process_id: None,
        after_restart_process_id: None,
        process_restart_proven: false,
        independent_database_proven: false,
        score_replay_byte_identical,
        strict_success: score.strict_success,
    })
}

fn fixture_frame_id(fixture_id: &str) -> String {
    format!("{}-current-state", filesystem_component(fixture_id))
}

fn actual_context_id(fixture_id: &str, context_key: &str) -> String {
    format!(
        "me01-{}-context-{}",
        filesystem_component(fixture_id),
        filesystem_component(context_key)
    )
}

fn actual_session_id(fixture_id: &str, session_key: &str) -> String {
    format!(
        "me01-{}-{}",
        filesystem_component(fixture_id),
        filesystem_component(session_key)
    )
}

fn fixture_context_ids_actual(fixture: &Me01VisibleFixture) -> Vec<String> {
    fixture
        .stages
        .iter()
        .map(|stage| actual_context_id(&fixture.id, &stage.context_key))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn fixture_session_mounts_actual(fixture: &Me01VisibleFixture) -> BTreeMap<String, String> {
    fixture
        .stages
        .iter()
        .map(|stage| {
            (
                actual_session_id(&fixture.id, &stage.session_key),
                actual_context_id(&fixture.id, &stage.context_key),
            )
        })
        .collect()
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

fn sexpr_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), DynError> {
    std::fs::write(path, serde_json::to_vec_pretty(value)?)?;
    Ok(())
}

fn write_checksums(root: &Path) -> Result<(), DynError> {
    let checksum_path = root.join("checksums.sha256");
    let mut entries = walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && entry.path() != checksum_path)
        .map(|entry| entry.path().to_path_buf())
        .collect::<Vec<_>>();
    entries.sort();
    let mut output = String::new();
    for path in entries {
        let relative = path.strip_prefix(root)?;
        output.push_str(&format!(
            "{}  {}\n",
            sha256(&std::fs::read(&path)?),
            relative.display()
        ));
    }
    std::fs::write(checksum_path, output)?;
    Ok(())
}

fn render_stage_prompt(stage: &Me01Stage) -> Result<String, DynError> {
    Ok(format!(
        "ME-01 visible evidence for stage '{}':\n{}\n\nInstruction: {}\n\nThe final action contract, when requested, has exactly the fields action, object_id, value, and evidence_id.",
        stage.id,
        serde_json::to_string_pretty(&stage.events)?,
        stage.instruction
    ))
}

async fn wait_for_session_reply(
    replies: &mut morphz::runtime::RuntimeEventStream,
    session_id: &str,
) -> Result<String, DynError> {
    let deadline = tokio::time::sleep(Duration::from_secs(10));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => return Err(format!("ME-01 embedded Runtime did not reply to {session_id}").into()),
            event = replies.recv() => {
                let event = event.ok_or("ME-01 reply stream closed")?;
                if event.payload.get("session_id").and_then(serde_json::Value::as_str) == Some(session_id) {
                    return Ok(event.payload.get("text").and_then(serde_json::Value::as_str).unwrap_or_default().to_string());
                }
            }
        }
    }
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
                .and_then(serde_json::Value::as_array)
                .is_some_and(|calls| {
                    calls.iter().any(|call| {
                        call.get("function")
                            .and_then(|function| function.get("name"))
                            .and_then(serde_json::Value::as_str)
                            == Some("context_tx")
                    })
                })
        })
        .count()
}

fn observation_ref_before<'a>(prompt: &'a str, marker: &str) -> Option<&'a str> {
    let marker_index = prompt.find(marker)?;
    let prefix = &prompt[..marker_index];
    let start = prefix.rfind("@e")?;
    let end = prefix[start + 2..]
        .find(|character: char| !character.is_ascii_digit())
        .map(|offset| start + 2 + offset)
        .unwrap_or(prefix.len());
    (end > start + 2).then_some(&prefix[start..end])
}

fn kernel_context_version(prompt: &str) -> Option<u64> {
    let kernel = prompt.rfind("(kernel")?;
    let suffix = &prompt[kernel..];
    let version = suffix.find("(version ")? + "(version ".len();
    let digits = suffix[version..]
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>();
    digits.parse().ok()
}

fn implementation_violations(
    observed: &Me01ObservedEpisode,
    fixture: &Me01FixturePair,
) -> Vec<String> {
    let mut violations = Vec::new();
    if observed.protocol_id != ME01_PROTOCOL_ID {
        violations.push("protocol_id_mismatch".to_string());
    }
    if observed.fixture_id != fixture.visible.id {
        violations.push("fixture_id_mismatch".to_string());
    }
    if observed.visible_input_sha256 != fixture.canonical_semantic_sha256 {
        violations.push("visible_semantic_input_hash_mismatch".to_string());
    }
    match observed.arm {
        Me01Arm::AppendOnly => {
            if observed.runtime.adapter_kind != "append_only_messages" {
                violations.push("append_only_adapter_kind_invalid".to_string());
            }
            if observed.runtime.production_morphz_runtime {
                violations.push("append_only_must_not_claim_production_morphz".to_string());
            }
            if observed.runtime.message_transcript_sha256.is_none() {
                violations.push("append_only_transcript_hash_missing".to_string());
            }
            if observed.runtime.context_tx_attempts != 0 || observed.runtime.context_tx_commits != 0
            {
                violations.push("append_only_contains_context_transaction".to_string());
            }
        }
        Me01Arm::StructuredNoDirectReentry => {
            require_production_context_evidence(observed, &mut violations);
            if observed.runtime.adapter_kind != "production_morphz_read_only_context" {
                violations.push("read_only_adapter_kind_invalid".to_string());
            }
            if observed.runtime.context_tx_tool_exposed {
                violations.push("read_only_context_tx_tool_exposed".to_string());
            }
            if observed.runtime.context_tx_attempts != 0 || observed.runtime.context_tx_commits != 0
            {
                violations.push("read_only_context_transaction_observed".to_string());
            }
        }
        Me01Arm::FullMorphz => {
            require_production_context_evidence(observed, &mut violations);
            if observed.runtime.adapter_kind != "production_morphz_full_context" {
                violations.push("full_morphz_adapter_kind_invalid".to_string());
            }
            if !observed.runtime.context_tx_tool_exposed {
                violations.push("full_morphz_context_tx_tool_hidden".to_string());
            }
            if observed.runtime.context_tx_attempts == 0 {
                violations.push("full_morphz_context_tx_attempt_missing".to_string());
            }
            if observed.runtime.context_tx_commits == 0 {
                violations.push("full_morphz_context_tx_commit_missing".to_string());
            }
            let projected = observed
                .runtime
                .act_projection_frame_ids
                .iter()
                .collect::<BTreeSet<_>>();
            if observed.runtime.committed_frame_ids.is_empty()
                || !observed
                    .runtime
                    .committed_frame_ids
                    .iter()
                    .any(|frame| projected.contains(frame))
            {
                violations.push("committed_frame_missing_from_act_projection".to_string());
            }
        }
    }
    violations
}

fn require_production_context_evidence(
    observed: &Me01ObservedEpisode,
    violations: &mut Vec<String>,
) {
    if !observed.runtime.production_morphz_runtime {
        violations.push("production_morphz_runtime_not_proven".to_string());
    }
    if observed.runtime.database_path.is_none() {
        violations.push("sqlite_database_path_missing".to_string());
    }
    if observed.runtime.context_ids.is_empty() {
        violations.push("context_identity_missing".to_string());
    }
    if observed.runtime.session_mounts.is_empty() {
        violations.push("session_mount_evidence_missing".to_string());
    }
    if observed
        .runtime
        .structured_context_snapshot_sha256
        .is_none()
    {
        violations.push("structured_context_snapshot_hash_missing".to_string());
    }
}

fn fake_observed_episode(
    fixture: &Me01FixturePair,
    arm: Me01Arm,
    action: &Me01Action,
) -> Me01ObservedEpisode {
    let mut runtime = Me01RuntimeEvidence::default();
    match arm {
        Me01Arm::AppendOnly => {
            runtime.adapter_kind = "append_only_messages".to_string();
            runtime.message_transcript_sha256 = Some("fake-transcript-sha256".to_string());
        }
        Me01Arm::StructuredNoDirectReentry => {
            runtime.adapter_kind = "production_morphz_read_only_context".to_string();
            runtime.production_morphz_runtime = true;
            runtime.database_path = Some(PathBuf::from("/fake/read-only/morphz.db"));
            runtime.context_ids = fixture_context_ids(&fixture.visible);
            runtime.session_mounts = fixture_session_mounts(&fixture.visible);
            runtime.structured_context_snapshot_sha256 = Some("fake-context-sha256".to_string());
        }
        Me01Arm::FullMorphz => {
            runtime.adapter_kind = "production_morphz_full_context".to_string();
            runtime.production_morphz_runtime = true;
            runtime.database_path = Some(PathBuf::from("/fake/full/morphz.db"));
            runtime.context_ids = fixture_context_ids(&fixture.visible);
            runtime.session_mounts = fixture_session_mounts(&fixture.visible);
            runtime.context_tx_tool_exposed = true;
            runtime.context_tx_attempts = 1;
            runtime.context_tx_commits = 1;
            runtime.committed_frame_ids = vec!["frame-current-state".to_string()];
            runtime.act_projection_frame_ids = vec!["frame-current-state".to_string()];
            runtime.structured_context_snapshot_sha256 = Some("fake-context-sha256".to_string());
        }
    }
    Me01ObservedEpisode {
        protocol_id: ME01_PROTOCOL_ID.to_string(),
        fixture_id: fixture.visible.id.clone(),
        arm,
        visible_input_sha256: fixture.canonical_semantic_sha256.clone(),
        final_response: serde_json::to_string(action).expect("serializing an action cannot fail"),
        runtime,
    }
}

fn fake_negative_scores(fixture: &Me01FixturePair) -> Vec<Me01EpisodeScore> {
    let mut cases = Vec::new();

    let mut invalid_json =
        fake_observed_episode(fixture, Me01Arm::AppendOnly, &fixture.hidden.expected);
    invalid_json.final_response = "not-json".to_string();
    cases.push(score_me01_episode(&invalid_json, fixture));

    let mut wrong_evidence = fixture.hidden.expected.clone();
    wrong_evidence.evidence_id = "ev-wrong".to_string();
    let observed = fake_observed_episode(fixture, Me01Arm::AppendOnly, &wrong_evidence);
    cases.push(score_me01_episode(&observed, fixture));

    let mut full_without_commit =
        fake_observed_episode(fixture, Me01Arm::FullMorphz, &fixture.hidden.expected);
    full_without_commit.runtime.context_tx_commits = 0;
    cases.push(score_me01_episode(&full_without_commit, fixture));

    let mut read_only_with_commit = fake_observed_episode(
        fixture,
        Me01Arm::StructuredNoDirectReentry,
        &fixture.hidden.expected,
    );
    read_only_with_commit.runtime.context_tx_attempts = 1;
    read_only_with_commit.runtime.context_tx_commits = 1;
    cases.push(score_me01_episode(&read_only_with_commit, fixture));

    let mut wrong_input_hash =
        fake_observed_episode(fixture, Me01Arm::AppendOnly, &fixture.hidden.expected);
    wrong_input_hash.visible_input_sha256 = "wrong".to_string();
    cases.push(score_me01_episode(&wrong_input_hash, fixture));

    cases
}

fn fixture_context_ids(fixture: &Me01VisibleFixture) -> Vec<String> {
    fixture
        .stages
        .iter()
        .map(|stage| stage.context_key.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(|key| format!("context-{key}"))
        .collect()
}

fn fixture_session_mounts(fixture: &Me01VisibleFixture) -> BTreeMap<String, String> {
    fixture
        .stages
        .iter()
        .map(|stage| {
            (
                format!("session-{}", stage.session_key),
                format!("context-{}", stage.context_key),
            )
        })
        .collect()
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_set_is_complete_and_hidden_evidence_is_visible() {
        let fixtures = load_me01_fixtures().expect("fixtures should load");
        assert_eq!(fixtures.len(), 5);
        let families = fixtures
            .iter()
            .map(|fixture| fixture.visible.family.as_str())
            .collect::<BTreeSet<_>>();
        assert_eq!(families.len(), 5);
        for fixture in fixtures {
            assert_eq!(fixture.visible.id, fixture.hidden.fixture_id);
            assert_eq!(fixture.visible.stages.last().unwrap().id, "act");
            assert_ne!(fixture.visible_sha256, fixture.hidden_sha256);
        }
    }

    #[test]
    fn positive_contract_passes_all_three_arms() {
        let fixture = load_me01_fixtures().unwrap().remove(0);
        for arm in Me01Arm::ALL {
            let observed = fake_observed_episode(&fixture, arm, &fixture.hidden.expected);
            let score = score_me01_episode(&observed, &fixture);
            assert!(score.strict_success, "{arm:?}: {score:?}");
        }
    }

    #[test]
    fn strict_action_parser_rejects_extra_fields() {
        let fixture = load_me01_fixtures().unwrap().remove(0);
        let mut observed =
            fake_observed_episode(&fixture, Me01Arm::AppendOnly, &fixture.hidden.expected);
        observed.final_response = format!(
            "{{\"action\":\"{}\",\"object_id\":\"{}\",\"value\":\"{}\",\"evidence_id\":\"{}\",\"note\":\"extra\"}}",
            fixture.hidden.expected.action,
            fixture.hidden.expected.object_id,
            fixture.hidden.expected.value,
            fixture.hidden.expected.evidence_id
        );
        let score = score_me01_episode(&observed, &fixture);
        assert!(!score.json_contract_valid);
        assert!(!score.strict_success);
    }

    #[test]
    fn full_morphz_requires_a_committed_frame_in_the_act_projection() {
        let fixture = load_me01_fixtures().unwrap().remove(0);
        let mut observed =
            fake_observed_episode(&fixture, Me01Arm::FullMorphz, &fixture.hidden.expected);
        observed.runtime.act_projection_frame_ids = vec!["different-frame".to_string()];
        let score = score_me01_episode(&observed, &fixture);
        assert!(score.task_success);
        assert!(!score.implementation_valid);
        assert!(score
            .integrity_violations
            .contains(&"committed_frame_missing_from_act_projection".to_string()));
    }

    #[test]
    fn fake_gate_rejects_all_negative_cases() {
        let directory = tempfile::tempdir().unwrap();
        let summary = run_me01_fake_gate(Some(directory.path())).unwrap();
        assert_eq!(summary.fixture_count, 5);
        assert_eq!(summary.positive_episode_count, 15);
        assert_eq!(summary.positive_strict_passes, 15);
        assert_eq!(summary.negative_cases_rejected, summary.negative_case_count);
        assert!(summary.ready_for_runtime_adapter_implementation);
        assert!(!summary.ready_for_real_model_smoke);
    }

    #[tokio::test]
    async fn embedded_production_runtime_commits_and_projects_only_in_the_full_arm() {
        let directory = tempfile::tempdir().unwrap();
        let summary = run_me01_embedded_runtime_gate(Some(directory.path()))
            .await
            .unwrap();
        assert!(summary.all_passed, "{summary:?}");
        assert!(!summary.real_model_called);
        assert!(!summary.ready_for_real_model_smoke);
    }
}
