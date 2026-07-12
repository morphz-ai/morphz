use crate::config::OrchestratorConfig;
use crate::context_metacognition_eval::ModelProfileIdentity;
use crate::event::Event;
use crate::memory::sqlite::SqliteStore;
use crate::memory::{EventStore, QueryFilter};
use crate::orchestrator::context::CONTEXT_PROTOCOL_VERSION;
use crate::orchestrator::context::{ContextEngine, ContextPressure, ContextRelation, MindState};
use crate::orchestrator::orchestrator::{
    BASELINE_SYSTEM_PROMPT_MODE, COGNITIVE_SEXPR_VM_SYSTEM_PROMPT_MODE, SYSTEM_PROMPT_MODE_ENV,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
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
const TRANSFER_SCENARIO: &str = "autonomous_transfer_v1";
const EPISTEMIC_REALITY_SCENARIO: &str = "epistemic_reality_v1";
const EXPERIENCE_TRANSFER_SCENARIO: &str = "experience_transfer_v1";
const TARGET_STAGE_PREFIX: &str = "target-";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInjection {
    pub path: String,
    pub content: String,
}

/// 声明一个“事实必须晚于证据出现”的通用评测门。
///
/// 场景只描述事实标记与什么事件构成证据；评测器负责按 Ledger 顺序检查，
/// 不把任何业务事实或版本命名写入 Runtime。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidenceGate {
    pub id: String,
    /// Markers should describe an asserted fact shape (for example
    /// `(version v3)`), not a bare entity mention (`v3`). A bare mention may
    /// legitimately occur in a goal or hypothesis before evidence exists.
    pub guarded_markers: Vec<String>,
    pub evidence_markers: Vec<String>,
    #[serde(default)]
    pub evidence_topics: Vec<String>,
    #[serde(default)]
    pub evidence_tool_names: Vec<String>,
    #[serde(default)]
    pub require_context_reference: bool,
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
    #[serde(default = "default_state_path")]
    pub state_path: String,
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
    #[serde(default = "default_constraint_marker")]
    pub required_constraint_marker: String,
    #[serde(default)]
    pub obsolete_state_values: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub evidence_gates: Vec<EvidenceGate>,
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
    #[serde(default)]
    pub context_tx_attempts: usize,
    #[serde(default)]
    pub standalone_context_tx_attempts: usize,
    #[serde(default)]
    pub empty_standalone_context_tx_attempts: usize,
    #[serde(default)]
    pub rejected_context_tx_attempts: usize,
    #[serde(default)]
    pub exact_duplicate_physical_tool_calls: usize,
    #[serde(default)]
    pub same_path_repeat_physical_tool_calls: usize,
    #[serde(default)]
    pub read_guard_rejections: usize,
    #[serde(default)]
    pub temporal_violations: Vec<String>,
    #[serde(default)]
    pub provenance_violations: Vec<String>,
    #[serde(default)]
    pub state_passed: bool,
    #[serde(default)]
    pub mind_passed: bool,
    #[serde(default)]
    pub behavior_passed: bool,
    #[serde(default)]
    pub semantic_passed: bool,
    #[serde(default)]
    pub reply_passed: bool,
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
    pub strict_stage_pass_rate: f64,
    pub state_passed_stages: usize,
    pub state_stage_pass_rate: f64,
    pub mind_passed_stages: usize,
    pub mind_stage_pass_rate: f64,
    pub behavior_passed_stages: usize,
    pub behavior_stage_pass_rate: f64,
    pub semantic_passed_stages: usize,
    pub semantic_stage_pass_rate: f64,
    pub reply_passed_stages: usize,
    pub reply_stage_pass_rate: f64,
    pub restart_recovery_passed: bool,
    pub final_state_matches: bool,
    pub final_reply_fidelity: bool,
    pub constraint_retained: bool,
    pub obsolete_fact_reused: bool,
    pub total_model_attempts: usize,
    pub total_physical_tool_calls: usize,
    pub total_context_commits: usize,
    pub total_context_failures: usize,
    pub total_context_tx_attempts: usize,
    pub total_standalone_context_tx_attempts: usize,
    pub total_empty_standalone_context_tx_attempts: usize,
    pub standalone_context_tx_attempt_rate: f64,
    pub total_rejected_context_tx_attempts: usize,
    pub total_exact_duplicate_physical_tool_calls: usize,
    pub total_same_path_repeat_physical_tool_calls: usize,
    pub total_read_guard_rejections: usize,
    pub total_temporal_violations: usize,
    pub total_provenance_violations: usize,
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExperienceTransferArm {
    RelatedExperience,
    UnrelatedExperience,
    Fresh,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExperienceTransferPromptMode {
    AgentOwnedContext,
    CognitiveSexprVm,
}

impl ExperienceTransferPromptMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AgentOwnedContext => BASELINE_SYSTEM_PROMPT_MODE,
            Self::CognitiveSexprVm => COGNITIVE_SEXPR_VM_SYSTEM_PROMPT_MODE,
        }
    }
}

impl ExperienceTransferArm {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RelatedExperience => "related_experience",
            Self::UnrelatedExperience => "unrelated_experience",
            Self::Fresh => "fresh",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct MindFrameSnapshot {
    pub id: String,
    pub body: String,
    pub revision: u64,
    pub created_version: u64,
    pub updated_version: u64,
    pub source_count: usize,
    pub protected: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct MindStructureSnapshot {
    pub version: u64,
    pub active_frame_count: usize,
    pub retired_frame_count: usize,
    pub relation_count: usize,
    pub protected_entry_count: usize,
    pub retired_entry_count: usize,
    pub case_bound_frame_count: usize,
    pub multi_case_frame_count: usize,
    pub abstraction_candidate_frame_ids: Vec<String>,
    pub frames: Vec<MindFrameSnapshot>,
    pub relations: Vec<ContextRelation>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExperienceTransferTargetMetrics {
    pub target_stages: usize,
    pub state_passed_stages: usize,
    pub mind_passed_stages: usize,
    pub behavior_passed_stages: usize,
    pub semantic_passed_stages: usize,
    pub reply_passed_stages: usize,
    pub strict_passed_stages: usize,
    pub state_pass_rate: f64,
    pub mind_pass_rate: f64,
    pub semantic_pass_rate: f64,
    pub strict_pass_rate: f64,
    pub restart_recovery_passed: bool,
    pub model_attempts: usize,
    pub physical_tool_calls: usize,
    pub context_commits: usize,
    pub empty_standalone_context_tx_attempts: usize,
    pub temporal_violations: usize,
    pub provenance_violations: usize,
    pub exact_duplicate_physical_tool_calls: usize,
    pub same_path_repeat_physical_tool_calls: usize,
    pub read_guard_rejections: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExperienceTransferArmReport {
    pub arm: ExperienceTransferArm,
    pub run_root: PathBuf,
    pub full_run_success: bool,
    pub training_stages: usize,
    pub target: ExperienceTransferTargetMetrics,
    pub final_mind: MindStructureSnapshot,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExperienceTransferComparison {
    pub related_minus_fresh_semantic_pass_rate: f64,
    pub related_minus_fresh_strict_pass_rate: f64,
    pub related_minus_fresh_model_attempts: i64,
    pub related_minus_fresh_physical_tool_calls: i64,
    pub unrelated_minus_fresh_semantic_pass_rate: f64,
    pub unrelated_minus_fresh_strict_pass_rate: f64,
    pub unrelated_minus_fresh_model_attempts: i64,
    pub unrelated_minus_fresh_physical_tool_calls: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExperienceTransferSuiteRun {
    pub id: String,
    pub created_at: String,
    pub suite_root: PathBuf,
    pub system_prompt_mode: ExperienceTransferPromptMode,
    pub model_profile: Option<ModelProfileIdentity>,
    pub related_experience: ExperienceTransferArmReport,
    pub unrelated_experience: ExperienceTransferArmReport,
    pub fresh: ExperienceTransferArmReport,
    pub comparison: ExperienceTransferComparison,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExperienceTransferPromptArmDelta {
    pub arm: ExperienceTransferArm,
    pub candidate_minus_baseline_semantic_pass_rate: f64,
    pub candidate_minus_baseline_strict_pass_rate: f64,
    pub candidate_minus_baseline_model_attempts: i64,
    pub candidate_minus_baseline_physical_tool_calls: i64,
    pub candidate_minus_baseline_context_commits: i64,
    pub candidate_minus_baseline_abstraction_candidates: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExperienceTransferPromptAbRun {
    pub id: String,
    pub created_at: String,
    pub run_root: PathBuf,
    pub baseline: ExperienceTransferSuiteRun,
    pub cognitive_sexpr_vm: ExperienceTransferSuiteRun,
    pub arm_deltas: Vec<ExperienceTransferPromptArmDelta>,
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
        required_constraint_marker: "NEVER-LOG-SECRETS".to_string(),
        obsolete_state_values: BTreeMap::from([
            ("current_port".to_string(), vec!["8080".to_string()]),
            (
                "current_endpoint".to_string(),
                vec!["/v1/events".to_string()],
            ),
        ]),
        evidence_gates: operations_evidence_gates(),
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
    run_created_eval(environment, agent_binary, profile).await
}

pub async fn create_autonomous_transfer_eval(
    base_dir: Option<&Path>,
) -> Result<LongHorizonEvalEnvironment, DynError> {
    let base = base_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("morphz-long-horizon-evals"));
    std::fs::create_dir_all(&base)?;
    let base = std::fs::canonicalize(base)?;
    let id = format!(
        "{TRANSFER_SCENARIO}-{}-{}",
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
        &workspace_root.join("cases"),
        &workspace_root.join("state"),
        &workspace_root.join("reports"),
    ] {
        std::fs::create_dir_all(directory)?;
    }
    set_private_directory_permissions(&run_root)?;
    write_transfer_workspace(&workspace_root)?;

    let database_path = run_root.join("morphz.db");
    SqliteStore::new(database_path.to_string_lossy().as_ref()).await?;
    let session_id = format!("long-horizon-{id}");
    let manifest = LongHorizonEvalManifest {
        id,
        created_at: Utc::now().to_rfc3339(),
        family: "autonomous_evolution".to_string(),
        scenario: TRANSFER_SCENARIO.to_string(),
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
        required_constraint_marker: "EVIDENCE-AUTHORITY-BEFORE-RECENCY".to_string(),
        obsolete_state_values: BTreeMap::from([(
            "selected_value".to_string(),
            markers(&["ALPHA-99", "BETA-00", "GAMMA-1"]),
        )]),
        evidence_gates: Vec::new(),
        stages: autonomous_transfer_stages(),
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

pub async fn run_autonomous_transfer_eval(
    base_dir: Option<&Path>,
    agent_binary: &Path,
    profile: Option<&ModelProfileIdentity>,
) -> Result<LongHorizonEvalRun, DynError> {
    let environment = create_autonomous_transfer_eval(base_dir).await?;
    run_created_eval(environment, agent_binary, profile).await
}

/// Create a schema-independent epistemic boundary suite spanning two surface
/// domains. Future appointment and incident-closure evidence is injected only
/// immediately before the stage that authorizes the corresponding conclusion.
pub async fn create_epistemic_reality_eval(
    base_dir: Option<&Path>,
) -> Result<LongHorizonEvalEnvironment, DynError> {
    let base = base_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("morphz-long-horizon-evals"));
    std::fs::create_dir_all(&base)?;
    let base = std::fs::canonicalize(base)?;
    let id = format!(
        "{EPISTEMIC_REALITY_SCENARIO}-{}-{}",
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
        &workspace_root.join("people"),
        &workspace_root.join("incidents"),
        &workspace_root.join("state"),
        &workspace_root.join("reports"),
    ] {
        std::fs::create_dir_all(directory)?;
    }
    set_private_directory_permissions(&run_root)?;
    write_epistemic_reality_workspace(&workspace_root)?;

    let database_path = run_root.join("morphz.db");
    SqliteStore::new(database_path.to_string_lossy().as_ref()).await?;
    let session_id = format!("long-horizon-{id}");
    let manifest = LongHorizonEvalManifest {
        id,
        created_at: Utc::now().to_rfc3339(),
        family: "reality_constrained_epistemics".to_string(),
        scenario: EPISTEMIC_REALITY_SCENARIO.to_string(),
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
        required_constraint_marker: "PERSON-LIN-7".to_string(),
        obsolete_state_values: BTreeMap::from([(
            "status".to_string(),
            markers(&["investigating"]),
        )]),
        evidence_gates: epistemic_reality_evidence_gates(),
        stages: epistemic_reality_stages(),
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

pub async fn run_epistemic_reality_eval(
    base_dir: Option<&Path>,
    agent_binary: &Path,
    profile: Option<&ModelProfileIdentity>,
) -> Result<LongHorizonEvalRun, DynError> {
    let environment = create_epistemic_reality_eval(base_dir).await?;
    run_created_eval(environment, agent_binary, profile).await
}

pub async fn create_experience_transfer_arm_eval(
    base_dir: Option<&Path>,
    arm: ExperienceTransferArm,
) -> Result<LongHorizonEvalEnvironment, DynError> {
    let base = base_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("morphz-experience-transfer-evals"));
    std::fs::create_dir_all(&base)?;
    let base = std::fs::canonicalize(base)?;
    let id = format!(
        "{EXPERIENCE_TRANSFER_SCENARIO}-{}-{}-{}",
        arm.as_str(),
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
        &workspace_root.join("training"),
        &workspace_root.join("challenge"),
        &workspace_root.join("state"),
        &workspace_root.join("reports"),
    ] {
        std::fs::create_dir_all(directory)?;
    }
    set_private_directory_permissions(&run_root)?;

    let database_path = run_root.join("morphz.db");
    SqliteStore::new(database_path.to_string_lossy().as_ref()).await?;
    let session_id = format!("experience-transfer-{id}");
    let stages = experience_transfer_stages(arm);
    let manifest = LongHorizonEvalManifest {
        id,
        created_at: Utc::now().to_rfc3339(),
        family: "experience_transfer".to_string(),
        scenario: format!("{EXPERIENCE_TRANSFER_SCENARIO}-{}", arm.as_str()),
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
        required_constraint_marker: "GAMMA-2".to_string(),
        obsolete_state_values: BTreeMap::from([(
            "selected_value".to_string(),
            markers(&["GAMMA-1"]),
        )]),
        evidence_gates: Vec::new(),
        stages,
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

pub async fn run_experience_transfer_arm_eval(
    base_dir: Option<&Path>,
    arm: ExperienceTransferArm,
    agent_binary: &Path,
    profile: Option<&ModelProfileIdentity>,
) -> Result<LongHorizonEvalRun, DynError> {
    run_experience_transfer_arm_eval_with_prompt(
        base_dir,
        arm,
        agent_binary,
        profile,
        ExperienceTransferPromptMode::CognitiveSexprVm,
    )
    .await
}

async fn run_experience_transfer_arm_eval_with_prompt(
    base_dir: Option<&Path>,
    arm: ExperienceTransferArm,
    agent_binary: &Path,
    profile: Option<&ModelProfileIdentity>,
    prompt_mode: ExperienceTransferPromptMode,
) -> Result<LongHorizonEvalRun, DynError> {
    let mut environment = create_experience_transfer_arm_eval(base_dir, arm).await?;
    environment.environment.insert(
        SYSTEM_PROMPT_MODE_ENV.to_string(),
        prompt_mode.as_str().to_string(),
    );
    run_created_eval(environment, agent_binary, profile).await
}

pub async fn run_experience_transfer_suite(
    base_dir: Option<&Path>,
    agent_binary: &Path,
    profile: Option<&ModelProfileIdentity>,
) -> Result<ExperienceTransferSuiteRun, DynError> {
    run_experience_transfer_suite_with_prompt(
        base_dir,
        agent_binary,
        profile,
        ExperienceTransferPromptMode::CognitiveSexprVm,
    )
    .await
}

pub async fn run_experience_transfer_suite_with_prompt(
    base_dir: Option<&Path>,
    agent_binary: &Path,
    profile: Option<&ModelProfileIdentity>,
    prompt_mode: ExperienceTransferPromptMode,
) -> Result<ExperienceTransferSuiteRun, DynError> {
    let base = base_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("morphz-experience-transfer-suites"));
    std::fs::create_dir_all(&base)?;
    let base = std::fs::canonicalize(base)?;
    let id = format!(
        "{EXPERIENCE_TRANSFER_SCENARIO}-suite-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        std::process::id()
    );
    let suite_root = base.join(&id);
    std::fs::create_dir_all(&suite_root)?;
    set_private_directory_permissions(&suite_root)?;

    let related_root = suite_root.join(ExperienceTransferArm::RelatedExperience.as_str());
    let unrelated_root = suite_root.join(ExperienceTransferArm::UnrelatedExperience.as_str());
    let fresh_root = suite_root.join(ExperienceTransferArm::Fresh.as_str());
    let related_profile = profile.cloned();
    let unrelated_profile = profile.cloned();
    let fresh_profile = profile.cloned();
    let (related_run, unrelated_run, fresh_run) = tokio::try_join!(
        run_experience_transfer_arm_eval_with_prompt(
            Some(&related_root),
            ExperienceTransferArm::RelatedExperience,
            agent_binary,
            related_profile.as_ref(),
            prompt_mode,
        ),
        run_experience_transfer_arm_eval_with_prompt(
            Some(&unrelated_root),
            ExperienceTransferArm::UnrelatedExperience,
            agent_binary,
            unrelated_profile.as_ref(),
            prompt_mode,
        ),
        run_experience_transfer_arm_eval_with_prompt(
            Some(&fresh_root),
            ExperienceTransferArm::Fresh,
            agent_binary,
            fresh_profile.as_ref(),
            prompt_mode,
        ),
    )?;

    let related_experience =
        experience_transfer_arm_report(ExperienceTransferArm::RelatedExperience, &related_run)
            .await?;
    let unrelated_experience =
        experience_transfer_arm_report(ExperienceTransferArm::UnrelatedExperience, &unrelated_run)
            .await?;
    let fresh = experience_transfer_arm_report(ExperienceTransferArm::Fresh, &fresh_run).await?;
    let comparison = compare_experience_transfer_arms(
        &related_experience.target,
        &unrelated_experience.target,
        &fresh.target,
    );
    let suite = ExperienceTransferSuiteRun {
        id,
        created_at: Utc::now().to_rfc3339(),
        suite_root: suite_root.clone(),
        system_prompt_mode: prompt_mode,
        model_profile: profile.cloned(),
        related_experience,
        unrelated_experience,
        fresh,
        comparison,
    };
    std::fs::write(
        suite_root.join("suite_report.json"),
        serde_json::to_vec_pretty(&suite)?,
    )?;
    Ok(suite)
}

pub async fn run_experience_transfer_prompt_ab(
    base_dir: Option<&Path>,
    agent_binary: &Path,
    profile: Option<&ModelProfileIdentity>,
) -> Result<ExperienceTransferPromptAbRun, DynError> {
    let base = base_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("morphz-experience-prompt-ab"));
    std::fs::create_dir_all(&base)?;
    let base = std::fs::canonicalize(base)?;
    let id = format!(
        "{EXPERIENCE_TRANSFER_SCENARIO}-prompt-ab-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        std::process::id()
    );
    let run_root = base.join(&id);
    std::fs::create_dir_all(&run_root)?;
    set_private_directory_permissions(&run_root)?;

    let baseline_root = run_root.join(ExperienceTransferPromptMode::AgentOwnedContext.as_str());
    let candidate_root = run_root.join(ExperienceTransferPromptMode::CognitiveSexprVm.as_str());
    let baseline_profile = profile.cloned();
    let candidate_profile = profile.cloned();
    let (baseline, cognitive_sexpr_vm) = tokio::try_join!(
        run_experience_transfer_suite_with_prompt(
            Some(&baseline_root),
            agent_binary,
            baseline_profile.as_ref(),
            ExperienceTransferPromptMode::AgentOwnedContext,
        ),
        run_experience_transfer_suite_with_prompt(
            Some(&candidate_root),
            agent_binary,
            candidate_profile.as_ref(),
            ExperienceTransferPromptMode::CognitiveSexprVm,
        ),
    )?;
    let arm_deltas = vec![
        prompt_arm_delta(
            &baseline.related_experience,
            &cognitive_sexpr_vm.related_experience,
        ),
        prompt_arm_delta(
            &baseline.unrelated_experience,
            &cognitive_sexpr_vm.unrelated_experience,
        ),
        prompt_arm_delta(&baseline.fresh, &cognitive_sexpr_vm.fresh),
    ];
    let run = ExperienceTransferPromptAbRun {
        id,
        created_at: Utc::now().to_rfc3339(),
        run_root: run_root.clone(),
        baseline,
        cognitive_sexpr_vm,
        arm_deltas,
    };
    std::fs::write(
        run_root.join("prompt_ab_report.json"),
        serde_json::to_vec_pretty(&run)?,
    )?;
    Ok(run)
}

async fn experience_transfer_arm_report(
    arm: ExperienceTransferArm,
    run: &LongHorizonEvalRun,
) -> Result<ExperienceTransferArmReport, DynError> {
    let target = experience_transfer_target_metrics(&run.report);
    let final_mind = final_mind_structure(&run.run_root).await?;
    Ok(ExperienceTransferArmReport {
        arm,
        run_root: run.run_root.clone(),
        full_run_success: run.report.success,
        training_stages: run
            .report
            .stages
            .iter()
            .filter(|stage| !stage.id.starts_with(TARGET_STAGE_PREFIX))
            .count(),
        target,
        final_mind,
    })
}

fn experience_transfer_target_metrics(
    report: &LongHorizonEvalReport,
) -> ExperienceTransferTargetMetrics {
    let stages = report
        .stages
        .iter()
        .filter(|stage| stage.id.starts_with(TARGET_STAGE_PREFIX))
        .collect::<Vec<_>>();
    let target_stages = stages.len();
    let state_passed_stages = stages.iter().filter(|stage| stage.state_passed).count();
    let mind_passed_stages = stages.iter().filter(|stage| stage.mind_passed).count();
    let behavior_passed_stages = stages.iter().filter(|stage| stage.behavior_passed).count();
    let semantic_passed_stages = stages.iter().filter(|stage| stage.semantic_passed).count();
    let reply_passed_stages = stages.iter().filter(|stage| stage.reply_passed).count();
    let strict_passed_stages = stages.iter().filter(|stage| stage.passed).count();
    ExperienceTransferTargetMetrics {
        target_stages,
        state_passed_stages,
        mind_passed_stages,
        behavior_passed_stages,
        semantic_passed_stages,
        reply_passed_stages,
        strict_passed_stages,
        state_pass_rate: ratio(state_passed_stages, target_stages),
        mind_pass_rate: ratio(mind_passed_stages, target_stages),
        semantic_pass_rate: ratio(semantic_passed_stages, target_stages),
        strict_pass_rate: ratio(strict_passed_stages, target_stages),
        restart_recovery_passed: stages
            .iter()
            .filter(|stage| stage.restarted_before)
            .all(|stage| stage.semantic_passed),
        model_attempts: stages.iter().map(|stage| stage.model_attempts).sum(),
        physical_tool_calls: stages.iter().map(|stage| stage.physical_tool_calls).sum(),
        context_commits: stages.iter().map(|stage| stage.context_commits).sum(),
        empty_standalone_context_tx_attempts: stages
            .iter()
            .map(|stage| stage.empty_standalone_context_tx_attempts)
            .sum(),
        temporal_violations: stages
            .iter()
            .map(|stage| stage.temporal_violations.len())
            .sum(),
        provenance_violations: stages
            .iter()
            .map(|stage| stage.provenance_violations.len())
            .sum(),
        exact_duplicate_physical_tool_calls: stages
            .iter()
            .map(|stage| stage.exact_duplicate_physical_tool_calls)
            .sum(),
        same_path_repeat_physical_tool_calls: stages
            .iter()
            .map(|stage| stage.same_path_repeat_physical_tool_calls)
            .sum(),
        read_guard_rejections: stages.iter().map(|stage| stage.read_guard_rejections).sum(),
    }
}

async fn final_mind_structure(run_root: &Path) -> Result<MindStructureSnapshot, DynError> {
    let manifest: LongHorizonEvalManifest =
        serde_json::from_slice(&std::fs::read(run_root.join("manifest.json"))?)?;
    let store =
        Arc::new(SqliteStore::new(manifest.database_path.to_string_lossy().as_ref()).await?);
    let view = context_engine(store, &manifest)
        .build_view(&manifest.session_id)
        .await?;
    let active_frames = view
        .state
        .frames
        .iter()
        .filter(|frame| !view.state.retired.contains(&frame.id))
        .map(|frame| MindFrameSnapshot {
            id: frame.id.clone(),
            body: frame.body.clone(),
            revision: frame.revision,
            created_version: frame.created_version,
            updated_version: frame.updated_version,
            source_count: frame.sources.len(),
            protected: view.state.protected.contains(&frame.id),
        })
        .collect::<Vec<_>>();
    let retired_frame_count = view
        .state
        .frames
        .iter()
        .filter(|frame| view.state.retired.contains(&frame.id))
        .count();
    let case_counts = active_frames
        .iter()
        .map(|frame| frame.body.matches("(case_id").count())
        .collect::<Vec<_>>();
    let abstraction_candidate_frame_ids = active_frames
        .iter()
        .filter(|frame| is_abstraction_candidate(&frame.body))
        .map(|frame| frame.id.clone())
        .collect::<Vec<_>>();
    Ok(MindStructureSnapshot {
        version: view.state.version,
        active_frame_count: active_frames.len(),
        retired_frame_count,
        relation_count: view.state.relations.len(),
        protected_entry_count: view.state.protected.len(),
        retired_entry_count: view.state.retired.len(),
        case_bound_frame_count: case_counts.iter().filter(|count| **count > 0).count(),
        multi_case_frame_count: case_counts.iter().filter(|count| **count > 1).count(),
        abstraction_candidate_frame_ids,
        frames: active_frames,
        relations: view.state.relations,
    })
}

fn is_abstraction_candidate(body: &str) -> bool {
    let normalized = body.to_lowercase();
    [
        "(principle",
        "(rule",
        "(policy",
        "(strategy",
        "(procedure",
        "(pattern",
        "(heuristic",
        "(abstraction",
        "(原则",
        "(规则",
        "(策略",
        "(过程",
        "(模式",
        "(启发",
        "(抽象",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}

fn compare_experience_transfer_arms(
    related: &ExperienceTransferTargetMetrics,
    unrelated: &ExperienceTransferTargetMetrics,
    fresh: &ExperienceTransferTargetMetrics,
) -> ExperienceTransferComparison {
    ExperienceTransferComparison {
        related_minus_fresh_semantic_pass_rate: related.semantic_pass_rate
            - fresh.semantic_pass_rate,
        related_minus_fresh_strict_pass_rate: related.strict_pass_rate - fresh.strict_pass_rate,
        related_minus_fresh_model_attempts: signed_delta(
            related.model_attempts,
            fresh.model_attempts,
        ),
        related_minus_fresh_physical_tool_calls: signed_delta(
            related.physical_tool_calls,
            fresh.physical_tool_calls,
        ),
        unrelated_minus_fresh_semantic_pass_rate: unrelated.semantic_pass_rate
            - fresh.semantic_pass_rate,
        unrelated_minus_fresh_strict_pass_rate: unrelated.strict_pass_rate - fresh.strict_pass_rate,
        unrelated_minus_fresh_model_attempts: signed_delta(
            unrelated.model_attempts,
            fresh.model_attempts,
        ),
        unrelated_minus_fresh_physical_tool_calls: signed_delta(
            unrelated.physical_tool_calls,
            fresh.physical_tool_calls,
        ),
    }
}

fn prompt_arm_delta(
    baseline: &ExperienceTransferArmReport,
    candidate: &ExperienceTransferArmReport,
) -> ExperienceTransferPromptArmDelta {
    debug_assert_eq!(baseline.arm, candidate.arm);
    ExperienceTransferPromptArmDelta {
        arm: baseline.arm,
        candidate_minus_baseline_semantic_pass_rate: candidate.target.semantic_pass_rate
            - baseline.target.semantic_pass_rate,
        candidate_minus_baseline_strict_pass_rate: candidate.target.strict_pass_rate
            - baseline.target.strict_pass_rate,
        candidate_minus_baseline_model_attempts: signed_delta(
            candidate.target.model_attempts,
            baseline.target.model_attempts,
        ),
        candidate_minus_baseline_physical_tool_calls: signed_delta(
            candidate.target.physical_tool_calls,
            baseline.target.physical_tool_calls,
        ),
        candidate_minus_baseline_context_commits: signed_delta(
            candidate.target.context_commits,
            baseline.target.context_commits,
        ),
        candidate_minus_baseline_abstraction_candidates: signed_delta(
            candidate.final_mind.abstraction_candidate_frame_ids.len(),
            baseline.final_mind.abstraction_candidate_frame_ids.len(),
        ),
    }
}

fn signed_delta(left: usize, right: usize) -> i64 {
    left as i64 - right as i64
}

fn active_mind_evaluation_text(state: &MindState) -> String {
    let mut text = String::new();
    for frame in state
        .frames
        .iter()
        .filter(|frame| !state.retired.contains(&frame.id))
    {
        text.push_str(&frame.id);
        text.push('\n');
        text.push_str(&frame.body);
        text.push('\n');
    }
    for relation in &state.relations {
        text.push_str(&relation.subject);
        text.push(' ');
        text.push_str(&relation.relation);
        text.push(' ');
        text.push_str(&relation.object);
        text.push('\n');
    }
    text
}

async fn run_created_eval(
    environment: LongHorizonEvalEnvironment,
    agent_binary: &Path,
    profile: Option<&ModelProfileIdentity>,
) -> Result<LongHorizonEvalRun, DynError> {
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
        let mind_text = active_mind_evaluation_text(&view.state);
        let missing_mind_markers = missing_markers(&mind_text, &stage.expected_mind_markers);
        let state_mismatches = state_mismatches(
            &environment.manifest.workspace_root.join(&stage.state_path),
            &stage.expected_state,
        );
        let physical_tool_calls = after.physical_tool_calls - before.physical_tool_calls;
        let no_tools_ok = !stage.require_no_physical_tools || physical_tool_calls == 0;
        let state_passed = state_mismatches.is_empty();
        let mind_passed = missing_mind_markers.is_empty();
        let behavior_passed = no_tools_ok;
        let semantic_passed = state_passed && mind_passed && behavior_passed;
        let reply_passed = missing_reply_markers.is_empty() && !reply.trim().is_empty();
        let passed = semantic_passed && reply_passed;
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
            context_tx_attempts: 0,
            standalone_context_tx_attempts: 0,
            empty_standalone_context_tx_attempts: 0,
            rejected_context_tx_attempts: 0,
            exact_duplicate_physical_tool_calls: 0,
            same_path_repeat_physical_tool_calls: 0,
            read_guard_rejections: 0,
            temporal_violations: Vec::new(),
            provenance_violations: Vec::new(),
            state_passed,
            mind_passed,
            behavior_passed,
            semantic_passed,
            reply_passed,
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
    let mut manifest: LongHorizonEvalManifest =
        serde_json::from_slice(&std::fs::read(run_root.join("manifest.json"))?)?;
    if manifest.evidence_gates.is_empty() && manifest.scenario == SCENARIO {
        manifest.evidence_gates = operations_evidence_gates();
    }
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
    let stage_event_metrics = analyze_stage_events(&events, &manifest);
    let mut stages = trace.stages;
    for (position, stage_result) in stages.iter_mut().enumerate() {
        let Some(stage_manifest) = manifest.stages.get(position) else {
            break;
        };
        let metrics = stage_event_metrics
            .get(position)
            .cloned()
            .unwrap_or_default();
        stage_result.context_tx_attempts = metrics.context_tx_attempts;
        stage_result.standalone_context_tx_attempts = metrics.standalone_context_tx_attempts;
        stage_result.empty_standalone_context_tx_attempts =
            metrics.empty_standalone_context_tx_attempts;
        stage_result.rejected_context_tx_attempts = metrics.rejected_context_tx_attempts;
        stage_result.exact_duplicate_physical_tool_calls =
            metrics.exact_duplicate_physical_tool_calls;
        stage_result.same_path_repeat_physical_tool_calls =
            metrics.same_path_repeat_physical_tool_calls;
        stage_result.read_guard_rejections = metrics.read_guard_rejections;
        stage_result.temporal_violations = metrics.temporal_violations;
        stage_result.provenance_violations = metrics.provenance_violations;
        stage_result.state_passed = stage_result.state_mismatches.is_empty();
        stage_result.mind_passed = stage_result.missing_mind_markers.is_empty();
        stage_result.behavior_passed = (!stage_manifest.require_no_physical_tools
            || stage_result.physical_tool_calls == 0)
            && stage_result.temporal_violations.is_empty()
            && stage_result.provenance_violations.is_empty();
        stage_result.semantic_passed =
            stage_result.state_passed && stage_result.mind_passed && stage_result.behavior_passed;
        stage_result.reply_passed =
            stage_result.missing_reply_markers.is_empty() && !stage_result.reply.trim().is_empty();
        stage_result.passed = stage_result.semantic_passed && stage_result.reply_passed;
    }
    let final_view = context_engine(Arc::clone(&store), &manifest)
        .build_view(&manifest.session_id)
        .await?;
    let final_stage = stages.last();
    let final_state_matches = manifest.stages.last().is_some_and(|stage| {
        state_mismatches(
            &manifest.workspace_root.join(&stage.state_path),
            &stage.expected_state,
        )
        .is_empty()
    });
    let final_reply_fidelity = final_stage.is_some_and(|stage| {
        stage.missing_reply_markers.is_empty() && !stage.reply.trim().is_empty()
    });
    let constraint_retained =
        normalized_contains(&final_view.sexpr, &manifest.required_constraint_marker)
            && final_stage.is_some_and(|stage| {
                normalized_contains(&stage.reply, &manifest.required_constraint_marker)
            });
    let final_state_path = manifest
        .stages
        .last()
        .map(|stage| stage.state_path.as_str())
        .unwrap_or("state/current.env");
    let current_state = parse_state_file(&manifest.workspace_root.join(final_state_path));
    let obsolete_fact_reused = current_state.as_ref().is_ok_and(|state| {
        manifest
            .obsolete_state_values
            .iter()
            .any(|(key, obsolete)| {
                state
                    .get(key)
                    .is_some_and(|value| obsolete.iter().any(|candidate| candidate == value))
            })
    });
    let passed_stages = stages.iter().filter(|stage| stage.passed).count();
    let state_passed_stages = stages.iter().filter(|stage| stage.state_passed).count();
    let mind_passed_stages = stages.iter().filter(|stage| stage.mind_passed).count();
    let behavior_passed_stages = stages.iter().filter(|stage| stage.behavior_passed).count();
    let semantic_passed_stages = stages.iter().filter(|stage| stage.semantic_passed).count();
    let reply_passed_stages = stages.iter().filter(|stage| stage.reply_passed).count();
    let restart_recovery_passed = stages
        .iter()
        .filter(|stage| stage.restarted_before)
        .all(|stage| stage.passed);
    let peak_estimated_tokens = stages
        .iter()
        .map(|stage| stage.pressure.estimated_tokens)
        .max()
        .unwrap_or_default();
    let counts = event_counts(&store, &manifest.session_id).await?;
    let completed_stages = stages.len();
    let expected_stages = manifest.stages.len();
    let total_context_tx_attempts = stages.iter().map(|stage| stage.context_tx_attempts).sum();
    let total_standalone_context_tx_attempts = stages
        .iter()
        .map(|stage| stage.standalone_context_tx_attempts)
        .sum();
    let total_empty_standalone_context_tx_attempts = stages
        .iter()
        .map(|stage| stage.empty_standalone_context_tx_attempts)
        .sum();
    let total_rejected_context_tx_attempts = stages
        .iter()
        .map(|stage| stage.rejected_context_tx_attempts)
        .sum();
    let total_exact_duplicate_physical_tool_calls = stages
        .iter()
        .map(|stage| stage.exact_duplicate_physical_tool_calls)
        .sum();
    let total_same_path_repeat_physical_tool_calls = stages
        .iter()
        .map(|stage| stage.same_path_repeat_physical_tool_calls)
        .sum();
    let total_read_guard_rejections = stages.iter().map(|stage| stage.read_guard_rejections).sum();
    let total_temporal_violations = stages
        .iter()
        .map(|stage| stage.temporal_violations.len())
        .sum();
    let total_provenance_violations = stages
        .iter()
        .map(|stage| stage.provenance_violations.len())
        .sum();
    let success = completed_stages == expected_stages
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
        stage_completion_rate: ratio(completed_stages, expected_stages),
        strict_stage_pass_rate: ratio(passed_stages, completed_stages),
        state_passed_stages,
        state_stage_pass_rate: ratio(state_passed_stages, completed_stages),
        mind_passed_stages,
        mind_stage_pass_rate: ratio(mind_passed_stages, completed_stages),
        behavior_passed_stages,
        behavior_stage_pass_rate: ratio(behavior_passed_stages, completed_stages),
        semantic_passed_stages,
        semantic_stage_pass_rate: ratio(semantic_passed_stages, completed_stages),
        reply_passed_stages,
        reply_stage_pass_rate: ratio(reply_passed_stages, completed_stages),
        restart_recovery_passed,
        final_state_matches,
        final_reply_fidelity,
        constraint_retained,
        obsolete_fact_reused,
        total_model_attempts: counts.model_attempts,
        total_physical_tool_calls: counts.physical_tool_calls,
        total_context_commits: counts.context_commits,
        total_context_failures: counts.context_failures,
        total_context_tx_attempts,
        total_standalone_context_tx_attempts,
        total_empty_standalone_context_tx_attempts,
        standalone_context_tx_attempt_rate: ratio(
            total_empty_standalone_context_tx_attempts,
            counts.model_attempts,
        ),
        total_rejected_context_tx_attempts,
        total_exact_duplicate_physical_tool_calls,
        total_same_path_repeat_physical_tool_calls,
        total_read_guard_rejections,
        total_temporal_violations,
        total_provenance_violations,
        peak_estimated_tokens,
        final_pressure: final_view.pressure,
        ledger_events: events.len(),
        database_bytes: sqlite_storage_bytes(&manifest.database_path),
        success,
        stages,
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
            state_path: default_state_path(),
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
            state_path: default_state_path(),
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
            state_path: default_state_path(),
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
            state_path: default_state_path(),
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
            state_path: default_state_path(),
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
            state_path: default_state_path(),
            expected_state: state_v3,
            require_no_physical_tools: false,
        },
    ]
}

fn operations_evidence_gates() -> Vec<EvidenceGate> {
    vec![EvidenceGate {
        id: "approved-v3-evidence".to_string(),
        guarded_markers: markers(&[
            "(version v3)",
            "version-v3",
            "current_version=v3",
            "current-version v3",
        ]),
        evidence_markers: markers(&["version: v3"]),
        evidence_topics: markers(&["chat/tool_output"]),
        evidence_tool_names: markers(&["read"]),
        require_context_reference: true,
    }]
}

fn epistemic_reality_stages() -> Vec<LongHorizonStage> {
    let person_path = "state/person.env".to_string();
    let incident_path = "state/incident.env".to_string();
    let person_initial = person_state("reliability-engineer", "Shanghai", "R1", "disabled");
    let person_attributes = person_state("reliability-engineer", "Beijing", "R2", "enabled");
    let person_appointed = person_state("principal-engineer", "Beijing", "R2", "enabled");
    let incident_open = incident_state("investigating", "TEAM-A", "30", "not-deployed");
    let incident_deployed = incident_state(
        "investigating",
        "TEAM-B",
        "45",
        "deployed-awaiting-validation",
    );
    let incident_resolved = incident_state("resolved", "TEAM-B", "45", "validated");

    vec![
        LongHorizonStage {
            index: 1,
            id: "establish-person-record".to_string(),
            prompt: "审查 people/current-record.md，创建 state/person.env，每行一个 key=value，包含 person_id、legal_name、role、office、on_call_rotation、release_approval、employment_status。把当前人员状态与来源维护到 Mind，最终报告人员 ID、当前角色、办公地点和轮值。".to_string(),
            restart_before: false,
            injections: Vec::new(),
            expected_reply_markers: markers(&[
                "PERSON-LIN-7",
                "reliability-engineer",
                "Shanghai",
                "R1",
            ]),
            expected_mind_markers: markers(&[
                "PERSON-LIN-7",
                "reliability-engineer",
                "Shanghai",
            ]),
            state_path: person_path.clone(),
            expected_state: person_initial,
            require_no_physical_tools: false,
        },
        LongHorizonStage {
            index: 2,
            id: "attribute-change-without-appointment".to_string(),
            prompt: "新的有效决定：PERSON-LIN-7 的办公地点改为 Beijing，轮值改为 R2，并获得发布审批权限；委员会同时扩大了其职责范围，但本轮没有提供任何新的任命文件。更新 state/person.env 与 Mind，使它们只反映目前已获得支持的变化。最终报告当前角色、地点、轮值和发布审批权限。".to_string(),
            restart_before: false,
            injections: Vec::new(),
            expected_reply_markers: markers(&[
                "reliability-engineer",
                "Beijing",
                "R2",
                "enabled",
            ]),
            expected_mind_markers: markers(&[
                "PERSON-LIN-7",
                "reliability-engineer",
                "Beijing",
                "R2",
            ]),
            state_path: person_path.clone(),
            expected_state: person_attributes,
            require_no_physical_tools: false,
        },
        LongHorizonStage {
            index: 3,
            id: "apply-formal-appointment".to_string(),
            prompt: "people/appointment.md 是刚到达的正式任命证据。读取并核验后更新 state/person.env 与 Mind，保留此前已经生效的地点、轮值和审批权限。最终报告当前角色、任命编号及其来源。".to_string(),
            restart_before: false,
            injections: vec![FileInjection {
                path: "people/appointment.md".to_string(),
                content: "status: approved-current\nauthority: people-committee\nperson_id: PERSON-LIN-7\nrole: principal-engineer\nappointment_id: ROLE-2026-17\nsupersedes_role: reliability-engineer\n".to_string(),
            }],
            expected_reply_markers: markers(&[
                "PERSON-LIN-7",
                "principal-engineer",
                "ROLE-2026-17",
            ]),
            expected_mind_markers: markers(&[
                "PERSON-LIN-7",
                "principal-engineer",
                "ROLE-2026-17",
                "Beijing",
            ]),
            state_path: person_path,
            expected_state: person_appointed,
            require_no_physical_tools: false,
        },
        LongHorizonStage {
            index: 4,
            id: "establish-open-incident-after-restart".to_string(),
            prompt: "Morphz 进程刚刚重启。审查新到达的 incidents/open.md，创建 state/incident.env，每行一个 key=value，包含 incident_id、status、owner、severity、sla_minutes、remediation_status。将事件当前状态维护到 Mind，同时不得丢失 PERSON-LIN-7 的已确认当前角色。最终报告事件状态、负责人、SLA 和人员当前角色。".to_string(),
            restart_before: true,
            injections: vec![FileInjection {
                path: "incidents/open.md".to_string(),
                content: "status: investigating\nauthority: incident-command\nincident_id: INC-204\nowner: TEAM-A\nseverity: SEV-2\nsla_minutes: 30\nremediation_status: not-deployed\n".to_string(),
            }],
            expected_reply_markers: markers(&[
                "INC-204",
                "investigating",
                "TEAM-A",
                "30",
                "principal-engineer",
            ]),
            expected_mind_markers: markers(&[
                "INC-204",
                "investigating",
                "PERSON-LIN-7",
                "principal-engineer",
            ]),
            state_path: incident_path.clone(),
            expected_state: incident_open,
            require_no_physical_tools: false,
        },
        LongHorizonStage {
            index: 5,
            id: "remediation-without-closure".to_string(),
            prompt: "新的有效操作更新：INC-204 的负责人改为 TEAM-B，SLA 改为 45 分钟，修复已部署但仍在等待验证；写入机器状态时使用字面量 `remediation_status=deployed-awaiting-validation`。本轮没有提供事件关闭记录。更新 state/incident.env 与 Mind，使它们只反映当前可确认的状态。最终报告事件当前状态、负责人、SLA 和修复进度。".to_string(),
            restart_before: false,
            injections: Vec::new(),
            expected_reply_markers: markers(&[
                "INC-204",
                "investigating",
                "TEAM-B",
                "45",
                "deployed-awaiting-validation",
            ]),
            expected_mind_markers: markers(&[
                "INC-204",
                "investigating",
                "TEAM-B",
                "PERSON-LIN-7",
            ]),
            state_path: incident_path.clone(),
            expected_state: incident_deployed,
            require_no_physical_tools: false,
        },
        LongHorizonStage {
            index: 6,
            id: "apply-formal-closure-and-report".to_string(),
            prompt: "incidents/closure.md 是刚到达的正式关闭证据。读取并核验后更新 state/incident.env 与 Mind，创建 reports/epistemic-final.md。最终报告必须同时包含 INC-204 的当前状态、负责人、SLA、关闭编号，以及 PERSON-LIN-7 的当前角色和任命编号。".to_string(),
            restart_before: false,
            injections: vec![FileInjection {
                path: "incidents/closure.md".to_string(),
                content: "status: resolved\nauthority: incident-commander\nincident_id: INC-204\nclosure_id: CLOSE-204-A\nvalidation: passed\nremediation_status: validated\nowner: TEAM-B\nsla_minutes: 45\n".to_string(),
            }],
            expected_reply_markers: markers(&[
                "INC-204",
                "resolved",
                "TEAM-B",
                "45",
                "CLOSE-204-A",
                "PERSON-LIN-7",
                "principal-engineer",
                "ROLE-2026-17",
            ]),
            expected_mind_markers: markers(&[
                "INC-204",
                "resolved",
                "CLOSE-204-A",
                "PERSON-LIN-7",
                "principal-engineer",
                "ROLE-2026-17",
            ]),
            state_path: incident_path,
            expected_state: incident_resolved,
            require_no_physical_tools: false,
        },
    ]
}

fn epistemic_reality_evidence_gates() -> Vec<EvidenceGate> {
    vec![
        EvidenceGate {
            id: "formal-person-appointment".to_string(),
            guarded_markers: markers(&["principal-engineer"]),
            evidence_markers: markers(&[
                "status: approved-current",
                "role: principal-engineer",
                "appointment_id: ROLE-2026-17",
            ]),
            evidence_topics: markers(&["chat/tool_output"]),
            evidence_tool_names: markers(&["read"]),
            require_context_reference: true,
        },
        EvidenceGate {
            id: "formal-incident-closure".to_string(),
            guarded_markers: markers(&["(status resolved)", "status=resolved"]),
            evidence_markers: markers(&[
                "status: resolved",
                "closure_id: CLOSE-204-A",
                "validation: passed",
            ]),
            evidence_topics: markers(&["chat/tool_output"]),
            evidence_tool_names: markers(&["read"]),
            require_context_reference: true,
        },
    ]
}

fn person_state(
    role: &str,
    office: &str,
    on_call_rotation: &str,
    release_approval: &str,
) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("person_id".to_string(), "PERSON-LIN-7".to_string()),
        ("legal_name".to_string(), "Lin-Qiao".to_string()),
        ("role".to_string(), role.to_string()),
        ("office".to_string(), office.to_string()),
        ("on_call_rotation".to_string(), on_call_rotation.to_string()),
        ("release_approval".to_string(), release_approval.to_string()),
        ("employment_status".to_string(), "active".to_string()),
    ])
}

fn incident_state(
    status: &str,
    owner: &str,
    sla_minutes: &str,
    remediation_status: &str,
) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("incident_id".to_string(), "INC-204".to_string()),
        ("status".to_string(), status.to_string()),
        ("owner".to_string(), owner.to_string()),
        ("severity".to_string(), "SEV-2".to_string()),
        ("sla_minutes".to_string(), sla_minutes.to_string()),
        (
            "remediation_status".to_string(),
            remediation_status.to_string(),
        ),
    ])
}

fn experience_transfer_stages(arm: ExperienceTransferArm) -> Vec<LongHorizonStage> {
    let mut stages = match arm {
        ExperienceTransferArm::RelatedExperience => related_experience_training_stages(),
        ExperienceTransferArm::UnrelatedExperience => unrelated_experience_training_stages(),
        ExperienceTransferArm::Fresh => Vec::new(),
    };
    let start_index = stages.len() + 1;
    stages.extend(experience_transfer_target_stages(start_index));
    stages
}

fn related_experience_training_stages() -> Vec<LongHorizonStage> {
    let state_path = "state/training.env".to_string();
    vec![
        LongHorizonStage {
            index: 1,
            id: "training-related-late-draft".to_string(),
            prompt: "读取 training/related/a/approved.md 和 training/related/a/late-draft.md，判断当前应采用哪个值。创建 state/training.env，每行一个 key=value，包含 case_id、selected_value、rejected_value；将后续工作可能需要的当前决定和依据维护到 Mind，最终报告采用值和拒绝值。".to_string(),
            restart_before: false,
            injections: vec![
                FileInjection {
                    path: "training/related/a/approved.md".to_string(),
                    content: "status: approved-current\nauthority: release-board\ncase_id: A\nselected_value: ALPHA-17\n".to_string(),
                },
                FileInjection {
                    path: "training/related/a/late-draft.md".to_string(),
                    content: "status: draft-unapproved\nauthority: individual-proposal\ncase_id: A\nselected_value: ALPHA-99\n".to_string(),
                },
            ],
            expected_reply_markers: markers(&["ALPHA-17", "ALPHA-99"]),
            expected_mind_markers: markers(&["ALPHA-17", "ALPHA-99"]),
            state_path: state_path.clone(),
            expected_state: transfer_choice_state("A", "ALPHA-17", "ALPHA-99"),
            require_no_physical_tools: false,
        },
        LongHorizonStage {
            index: 2,
            id: "training-related-approved-update".to_string(),
            prompt: "读取 training/related/b/earlier.md 和 training/related/b/approved-amendment.md，判断案例 B 的当前值，更新 state/training.env 与 Mind。最终报告当前采用值、旧值和判断依据。".to_string(),
            restart_before: false,
            injections: vec![
                FileInjection {
                    path: "training/related/b/earlier.md".to_string(),
                    content: "status: superseded\nauthority: release-board\ncase_id: B\nselected_value: BETA-17\nsuperseded_by: amendment-b\n".to_string(),
                },
                FileInjection {
                    path: "training/related/b/approved-amendment.md".to_string(),
                    content: "status: approved-current\nauthority: emergency-board\ncase_id: B\nchange_id: amendment-b\nselected_value: BETA-42\nsupersedes: BETA-17\n".to_string(),
                },
            ],
            expected_reply_markers: markers(&["BETA-42", "BETA-17"]),
            expected_mind_markers: markers(&["BETA-42", "ALPHA-17"]),
            state_path: state_path.clone(),
            expected_state: transfer_choice_state("B", "BETA-42", "BETA-17"),
            require_no_physical_tools: false,
        },
        LongHorizonStage {
            index: 3,
            id: "training-related-late-archive".to_string(),
            prompt: "读取 training/related/c/current.md 和 training/related/c/late-archive.md，判断案例 C 的当前值，更新 state/training.env 与 Mind，最终报告采用值、被拒绝值和判断依据。".to_string(),
            restart_before: false,
            injections: vec![
                FileInjection {
                    path: "training/related/c/current.md".to_string(),
                    content: "status: approved-current\nauthority: change-control\ncase_id: C\nselected_value: CHARLIE-7\n".to_string(),
                },
                FileInjection {
                    path: "training/related/c/late-archive.md".to_string(),
                    content: "status: archived-untrusted\nauthority: historical-import\ncase_id: C\nselected_value: CHARLIE-0\nwarning: later arrival must not restore this value\n".to_string(),
                },
            ],
            expected_reply_markers: markers(&["CHARLIE-7", "CHARLIE-0"]),
            expected_mind_markers: markers(&["CHARLIE-7", "BETA-42", "ALPHA-17"]),
            state_path: state_path.clone(),
            expected_state: transfer_choice_state("C", "CHARLIE-7", "CHARLIE-0"),
            require_no_physical_tools: false,
        },
        LongHorizonStage {
            index: 4,
            id: "training-related-restart-recovery".to_string(),
            prompt: "Morphz 进程刚刚重启。本轮不得读取 workspace、召回 Ledger 或调用任何物理工具；只根据恢复后的 Mind，报告案例 A、B、C 的最终采用值以及形成这些决定时最重要的判断边界。".to_string(),
            restart_before: true,
            injections: Vec::new(),
            expected_reply_markers: markers(&["ALPHA-17", "BETA-42", "CHARLIE-7"]),
            expected_mind_markers: markers(&["ALPHA-17", "BETA-42", "CHARLIE-7"]),
            state_path,
            expected_state: transfer_choice_state("C", "CHARLIE-7", "CHARLIE-0"),
            require_no_physical_tools: true,
        },
    ]
}

fn unrelated_experience_training_stages() -> Vec<LongHorizonStage> {
    let state_path = "state/training.env".to_string();
    vec![
        LongHorizonStage {
            index: 1,
            id: "training-unrelated-sum".to_string(),
            prompt: "读取 training/unrelated/u1/measurements.txt，计算所有区域记录的总数。创建 state/training.env，每行一个 key=value，包含 task_id、result、unit；把后续工作可能需要的结果维护到 Mind，最终报告结果。".to_string(),
            restart_before: false,
            injections: vec![FileInjection {
                path: "training/unrelated/u1/measurements.txt".to_string(),
                content: "task_id=U1\nnorth=12\nsouth=15\nwest=15\nunit=items\n".to_string(),
            }],
            expected_reply_markers: markers(&["U1", "42", "items"]),
            expected_mind_markers: markers(&["U1", "42"]),
            state_path: state_path.clone(),
            expected_state: unrelated_training_state("U1", "42", "items"),
            require_no_physical_tools: false,
        },
        LongHorizonStage {
            index: 2,
            id: "training-unrelated-conversion".to_string(),
            prompt: "读取 training/unrelated/u2/duration.txt，把分钟换算为小时，更新 state/training.env 与 Mind，并最终报告 task_id、结果和单位。".to_string(),
            restart_before: false,
            injections: vec![FileInjection {
                path: "training/unrelated/u2/duration.txt".to_string(),
                content: "task_id=U2\nminutes=180\ntarget_unit=hours\n".to_string(),
            }],
            expected_reply_markers: markers(&["U2", "3", "hours"]),
            expected_mind_markers: markers(&["U1", "42", "U2", "3"]),
            state_path: state_path.clone(),
            expected_state: unrelated_training_state("U2", "3", "hours"),
            require_no_physical_tools: false,
        },
        LongHorizonStage {
            index: 3,
            id: "training-unrelated-catalog".to_string(),
            prompt: "读取 training/unrelated/u3/catalog.txt，计算所有分类的总记录数，更新 state/training.env 与 Mind，并最终报告结果。".to_string(),
            restart_before: false,
            injections: vec![FileInjection {
                path: "training/unrelated/u3/catalog.txt".to_string(),
                content: "task_id=U3\nbooks=8\nfilms=7\nmusic=5\nunit=records\n".to_string(),
            }],
            expected_reply_markers: markers(&["U3", "20", "records"]),
            expected_mind_markers: markers(&["U1", "42", "U2", "3", "U3", "20"]),
            state_path: state_path.clone(),
            expected_state: unrelated_training_state("U3", "20", "records"),
            require_no_physical_tools: false,
        },
        LongHorizonStage {
            index: 4,
            id: "training-unrelated-restart-recovery".to_string(),
            prompt: "Morphz 进程刚刚重启。本轮不得读取 workspace、召回 Ledger 或调用任何物理工具；只根据恢复后的 Mind，报告 U1、U2、U3 的结果与单位。".to_string(),
            restart_before: true,
            injections: Vec::new(),
            expected_reply_markers: markers(&["U1", "42", "U2", "3", "U3", "20"]),
            expected_mind_markers: markers(&["U1", "42", "U2", "3", "U3", "20"]),
            state_path,
            expected_state: unrelated_training_state("U3", "20", "records"),
            require_no_physical_tools: true,
        },
    ]
}

fn experience_transfer_target_stages(start_index: usize) -> Vec<LongHorizonStage> {
    let state_path = "state/target.env".to_string();
    vec![
        LongHorizonStage {
            index: start_index,
            id: "target-stale-proposal".to_string(),
            prompt: "读取 challenge/assignment/approved-record.md 和 challenge/assignment/late-proposal.md，判断当前应采用哪个负责人。创建 state/target.env，每行一个 key=value，包含 case_id、selected_value、rejected_value；将当前决定和依据维护到 Mind，最终报告采用值和拒绝值。".to_string(),
            restart_before: false,
            injections: vec![
                FileInjection {
                    path: "challenge/assignment/approved-record.md".to_string(),
                    content: "status: approved-current\nauthority: operations-board\ncase_id: D\nselected_value: OWNER-LIN-17\n".to_string(),
                },
                FileInjection {
                    path: "challenge/assignment/late-proposal.md".to_string(),
                    content: "status: draft-unapproved\nauthority: individual-proposal\ncase_id: D\nselected_value: OWNER-LIN-99\n".to_string(),
                },
            ],
            expected_reply_markers: markers(&["OWNER-LIN-17", "OWNER-LIN-99"]),
            expected_mind_markers: markers(&["OWNER-LIN-17", "OWNER-LIN-99"]),
            state_path: state_path.clone(),
            expected_state: transfer_choice_state("D", "OWNER-LIN-17", "OWNER-LIN-99"),
            require_no_physical_tools: false,
        },
        LongHorizonStage {
            index: start_index + 1,
            id: "target-valid-amendment".to_string(),
            prompt: "读取 challenge/supplier/earlier-approved.md 和 challenge/supplier/current-amendment.md，判断当前供应方。将 state/target.env 覆盖为且仅为三行 key=value：case_id、selected_value、rejected_value；其中 rejected_value 表示旧的、已被取代的值。同步更新 Mind，最终报告当前采用值、旧值和判断依据。".to_string(),
            restart_before: false,
            injections: vec![
                FileInjection {
                    path: "challenge/supplier/earlier-approved.md".to_string(),
                    content: "status: superseded\nauthority: procurement-board\ncase_id: E\nselected_value: GAMMA-1\nsuperseded_by: supplier-amendment-e\n".to_string(),
                },
                FileInjection {
                    path: "challenge/supplier/current-amendment.md".to_string(),
                    content: "status: approved-current\nauthority: procurement-board\ncase_id: E\nchange_id: supplier-amendment-e\nselected_value: GAMMA-2\nsupersedes: GAMMA-1\n".to_string(),
                },
            ],
            expected_reply_markers: markers(&["GAMMA-2", "GAMMA-1"]),
            expected_mind_markers: markers(&["OWNER-LIN-17", "GAMMA-2", "GAMMA-1"]),
            state_path: state_path.clone(),
            expected_state: transfer_choice_state("E", "GAMMA-2", "GAMMA-1"),
            require_no_physical_tools: false,
        },
        LongHorizonStage {
            index: start_index + 2,
            id: "target-restart-recovery".to_string(),
            prompt: "Morphz 进程刚刚重启。本轮不得读取 workspace、召回 Ledger 或调用任何物理工具；只根据恢复后的 Mind，报告目标案例 D 与 E 的最终采用值、被拒绝值和判断边界。".to_string(),
            restart_before: true,
            injections: Vec::new(),
            expected_reply_markers: markers(&[
                "OWNER-LIN-17",
                "OWNER-LIN-99",
                "GAMMA-2",
                "GAMMA-1",
            ]),
            expected_mind_markers: markers(&["OWNER-LIN-17", "GAMMA-2"]),
            state_path,
            expected_state: transfer_choice_state("E", "GAMMA-2", "GAMMA-1"),
            require_no_physical_tools: true,
        },
    ]
}

fn transfer_choice_state(
    case_id: &str,
    selected_value: &str,
    rejected_value: &str,
) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("case_id".to_string(), case_id.to_string()),
        ("selected_value".to_string(), selected_value.to_string()),
        ("rejected_value".to_string(), rejected_value.to_string()),
    ])
}

fn unrelated_training_state(task_id: &str, result: &str, unit: &str) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("task_id".to_string(), task_id.to_string()),
        ("result".to_string(), result.to_string()),
        ("unit".to_string(), unit.to_string()),
    ])
}

fn autonomous_transfer_stages() -> Vec<LongHorizonStage> {
    let state_path = "state/transfer.env".to_string();
    let state_a = transfer_state("A", "ALPHA-17");
    let state_b = transfer_state("B", "BETA-42");
    let state_c = transfer_state("C", "GAMMA-2");
    vec![
        LongHorizonStage {
            index: 1,
            id: "learn-from-case-a".to_string(),
            prompt: "审查 cases/a 目录中的全部证据，判断哪一个值具有当前权威性。不要把文件到达得更晚等同于更可信。创建 state/transfer.env，每行一个 key=value，写入 case_id 与 selected_value；把决定依据和被拒绝的候选维护到 Mind。最终报告选择结果及理由。".to_string(),
            restart_before: false,
            injections: Vec::new(),
            expected_reply_markers: markers(&["ALPHA-17", "ALPHA-99"]),
            expected_mind_markers: markers(&["ALPHA-17", "ALPHA-99"]),
            state_path: state_path.clone(),
            expected_state: state_a.clone(),
            require_no_physical_tools: false,
        },
        LongHorizonStage {
            index: 2,
            id: "consolidate-general-policy".to_string(),
            prompt: "反馈：你在案例 A 中选择 ALPHA-17 是正确的。现在不调用任何物理工具，只基于已有证据提炼一条可复用但不过度绝对化的判断策略，并以字面 ID `EVIDENCE-AUTHORITY-BEFORE-RECENCY` 长期维护到 Mind。策略必须表达：证据的权威性、批准状态和明确取代关系优先于单纯到达顺序；更新且已批准的当前证据仍可合法取代旧结论。最终说明策略及其适用边界。".to_string(),
            restart_before: false,
            injections: Vec::new(),
            expected_reply_markers: markers(&["EVIDENCE-AUTHORITY-BEFORE-RECENCY", "ALPHA-17"]),
            expected_mind_markers: markers(&["EVIDENCE-AUTHORITY-BEFORE-RECENCY", "ALPHA-17"]),
            state_path: state_path.clone(),
            expected_state: state_a,
            require_no_physical_tools: true,
        },
        LongHorizonStage {
            index: 3,
            id: "positive-transfer-case-b".to_string(),
            prompt: "新的案例 B 已放入 cases/b。应用你已形成的一般证据策略，而不是复用案例 A 的具体答案。核验全部文件，更新 state/transfer.env 与 Mind，并最终报告选择结果、被拒绝值和使用的策略 ID。".to_string(),
            restart_before: false,
            injections: vec![
                FileInjection {
                    path: "cases/b/approved-current.md".to_string(),
                    content: "status: approved-current\nauthority: change-control-board\ncase_id: B\nselected_value: BETA-42\n".to_string(),
                },
                FileInjection {
                    path: "cases/b/late-archive.md".to_string(),
                    content: "status: archived\nauthority: historical-import\ncase_id: B\nselected_value: BETA-00\nwarning: later arrival does not restore this value\n".to_string(),
                },
            ],
            expected_reply_markers: markers(&["BETA-42", "BETA-00", "EVIDENCE-AUTHORITY-BEFORE-RECENCY"]),
            expected_mind_markers: markers(&["BETA-42", "EVIDENCE-AUTHORITY-BEFORE-RECENCY"]),
            state_path: state_path.clone(),
            expected_state: state_b,
            require_no_physical_tools: false,
        },
        LongHorizonStage {
            index: 4,
            id: "counterexample-case-c".to_string(),
            prompt: "新的案例 C 已放入 cases/c。这是对既有策略的反例压力测试：不得把‘较晚证据’一概判为无效。读取并根据批准状态与明确取代关系判断，更新 state/transfer.env 与 Mind。最终报告当前值、旧值以及为何这次较新的证据有效。".to_string(),
            restart_before: false,
            injections: vec![
                FileInjection {
                    path: "cases/c/earlier-approved.md".to_string(),
                    content: "status: superseded\nauthority: release-board\ncase_id: C\nselected_value: GAMMA-1\nsuperseded_by: gamma-hotfix\n".to_string(),
                },
                FileInjection {
                    path: "cases/c/later-approved-hotfix.md".to_string(),
                    content: "status: approved-current\nauthority: emergency-change-board\ncase_id: C\nchange_id: gamma-hotfix\nselected_value: GAMMA-2\nsupersedes: GAMMA-1\n".to_string(),
                },
            ],
            expected_reply_markers: markers(&["GAMMA-2", "GAMMA-1"]),
            expected_mind_markers: markers(&["GAMMA-2", "EVIDENCE-AUTHORITY-BEFORE-RECENCY"]),
            state_path: state_path.clone(),
            expected_state: state_c.clone(),
            require_no_physical_tools: false,
        },
        LongHorizonStage {
            index: 5,
            id: "revise-policy-from-counterexample".to_string(),
            prompt: "反馈：案例 C 选择 GAMMA-2 正确。不要调用物理工具。检查并在必要时修订 Mind 中的通用策略，使 `EVIDENCE-AUTHORITY-BEFORE-RECENCY` 同时覆盖案例 A/B 的抗陈旧能力和案例 C 的合法更新能力；保留三个正确示例 ALPHA-17、BETA-42、GAMMA-2。最终给出修订后的规则和边界。".to_string(),
            restart_before: false,
            injections: Vec::new(),
            expected_reply_markers: markers(&["EVIDENCE-AUTHORITY-BEFORE-RECENCY", "ALPHA-17", "BETA-42", "GAMMA-2"]),
            expected_mind_markers: markers(&["EVIDENCE-AUTHORITY-BEFORE-RECENCY", "ALPHA-17", "BETA-42", "GAMMA-2"]),
            state_path: state_path.clone(),
            expected_state: state_c.clone(),
            require_no_physical_tools: true,
        },
        LongHorizonStage {
            index: 6,
            id: "restart-transfer-recovery".to_string(),
            prompt: "Morphz 进程刚刚重启。这一轮禁止读取 workspace、召回 Ledger 或调用任何物理工具。只根据恢复的 Mind，完整报告策略 ID `EVIDENCE-AUTHORITY-BEFORE-RECENCY`、它的判断边界，以及案例 A/B/C 的正确结果 ALPHA-17、BETA-42、GAMMA-2。".to_string(),
            restart_before: true,
            injections: Vec::new(),
            expected_reply_markers: markers(&["EVIDENCE-AUTHORITY-BEFORE-RECENCY", "ALPHA-17", "BETA-42", "GAMMA-2"]),
            expected_mind_markers: markers(&["EVIDENCE-AUTHORITY-BEFORE-RECENCY", "ALPHA-17", "BETA-42", "GAMMA-2"]),
            state_path,
            expected_state: state_c,
            require_no_physical_tools: true,
        },
    ]
}

fn transfer_state(case_id: &str, selected_value: &str) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("case_id".to_string(), case_id.to_string()),
        ("selected_value".to_string(), selected_value.to_string()),
    ])
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

fn default_state_path() -> String {
    "state/current.env".to_string()
}

fn default_constraint_marker() -> String {
    "NEVER-LOG-SECRETS".to_string()
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

fn write_transfer_workspace(workspace: &Path) -> Result<(), DynError> {
    std::fs::create_dir_all(workspace.join("cases/a"))?;
    std::fs::write(
        workspace.join("cases/a/approved-current.md"),
        "status: approved-current\nauthority: release-board\ncase_id: A\nselected_value: ALPHA-17\n",
    )?;
    std::fs::write(
        workspace.join("cases/a/late-draft.md"),
        "status: draft-unapproved\nauthority: individual-proposal\ncase_id: A\nselected_value: ALPHA-99\nwarning: this file arrived later but was never approved\n",
    )?;
    Ok(())
}

fn write_epistemic_reality_workspace(workspace: &Path) -> Result<(), DynError> {
    std::fs::write(
        workspace.join("people/current-record.md"),
        "status: approved-current\nauthority: people-operations\nperson_id: PERSON-LIN-7\nlegal_name: Lin-Qiao\nrole: reliability-engineer\noffice: Shanghai\non_call_rotation: R1\nrelease_approval: disabled\nemployment_status: active\n",
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

#[derive(Debug, Clone, Default)]
struct StageEventMetrics {
    context_tx_attempts: usize,
    standalone_context_tx_attempts: usize,
    empty_standalone_context_tx_attempts: usize,
    rejected_context_tx_attempts: usize,
    exact_duplicate_physical_tool_calls: usize,
    same_path_repeat_physical_tool_calls: usize,
    read_guard_rejections: usize,
    temporal_violations: Vec<String>,
    provenance_violations: Vec<String>,
}

fn analyze_stage_events(
    events: &[Event],
    manifest: &LongHorizonEvalManifest,
) -> Vec<StageEventMetrics> {
    let mut metrics = vec![StageEventMetrics::default(); manifest.stages.len()];
    let mut current_stage = None;
    let mut seen_tool_calls = vec![HashSet::<String>::new(); manifest.stages.len()];
    let mut seen_tool_paths = vec![HashSet::<String>::new(); manifest.stages.len()];
    let mut evidence_references = manifest
        .evidence_gates
        .iter()
        .map(|gate| (gate.id.clone(), Vec::<String>::new()))
        .collect::<HashMap<_, _>>();
    let mut established_evidence_gates = HashSet::<String>::new();

    for event in events {
        if event.topic == "chat/user_message" {
            current_stage = Some(current_stage.map_or(0, |index| index + 1));
        }

        for gate in &manifest.evidence_gates {
            if evidence_event_matches(event, gate) {
                evidence_references
                    .entry(gate.id.clone())
                    .or_default()
                    .push(event_reference(event));
            }
        }

        let Some(stage_index) = current_stage.filter(|index| *index < metrics.len()) else {
            continue;
        };
        let stage = &mut metrics[stage_index];

        if event
            .payload
            .get("read_guard_status")
            .is_some_and(|value| !value.is_null())
            || event_payload_text(event)
                .is_some_and(|text| normalized_contains(text, "READ_ALREADY_COVERED"))
        {
            stage.read_guard_rejections += 1;
        }

        if event.topic == "chat/reply" {
            if let Some(text) = event_payload_text(event) {
                inspect_evidence_gates(
                    text,
                    event,
                    EvidenceInspectionChannel::Reply,
                    &mut EvidenceGateState {
                        gates: &manifest.evidence_gates,
                        evidence_references: &evidence_references,
                        established_gates: &mut established_evidence_gates,
                    },
                    stage,
                );
            }
            continue;
        }

        if event.topic != "chat/assistant_call" {
            continue;
        }

        let calls = event
            .payload
            .get("tool_calls")
            .and_then(|value| value.as_array())
            .map(Vec::as_slice)
            .unwrap_or_default();
        let mut context_transactions = Vec::new();
        let mut physical_calls = 0usize;

        for call in calls {
            let Some(name) = tool_call_name(call) else {
                continue;
            };
            let arguments = tool_call_arguments(call).unwrap_or_default();
            if name == "context_tx" {
                stage.context_tx_attempts += 1;
                context_transactions.push(context_transaction_text(arguments));
                continue;
            }

            physical_calls += 1;
            let signature = format!("{name}\u{0}{arguments}");
            if !seen_tool_calls[stage_index].insert(signature) {
                stage.exact_duplicate_physical_tool_calls += 1;
            }
            if let Some(path) = tool_call_path(arguments) {
                let path_signature = format!("{name}\u{0}{path}");
                if !seen_tool_paths[stage_index].insert(path_signature) {
                    stage.same_path_repeat_physical_tool_calls += 1;
                }
            }
        }

        if !context_transactions.is_empty() && physical_calls == 0 {
            stage.standalone_context_tx_attempts += 1;
            let empty_text = event
                .payload
                .get("text")
                .and_then(|value| value.as_str())
                .is_none_or(|text| text.trim().is_empty());
            if empty_text {
                stage.empty_standalone_context_tx_attempts += 1;
            }
        }

        let rejected_ids = event
            .payload
            .get("rejected_context_tx_ids")
            .and_then(|value| value.as_array())
            .map(Vec::len)
            .unwrap_or_default();
        if rejected_ids > 0 {
            stage.rejected_context_tx_attempts += rejected_ids;
        } else if event
            .payload
            .get("context_tx_rejection_status")
            .is_some_and(|value| !value.is_null())
        {
            stage.rejected_context_tx_attempts += 1;
        }

        for transaction in context_transactions {
            inspect_evidence_gates(
                &transaction,
                event,
                EvidenceInspectionChannel::ContextTransaction,
                &mut EvidenceGateState {
                    gates: &manifest.evidence_gates,
                    evidence_references: &evidence_references,
                    established_gates: &mut established_evidence_gates,
                },
                stage,
            );
        }
    }

    metrics
}

#[derive(Debug, Clone, Copy)]
enum EvidenceInspectionChannel {
    Reply,
    ContextTransaction,
}

impl EvidenceInspectionChannel {
    fn label(self) -> &'static str {
        match self {
            Self::Reply => "reply",
            Self::ContextTransaction => "context_tx",
        }
    }

    fn checks_provenance(self) -> bool {
        matches!(self, Self::ContextTransaction)
    }
}

struct EvidenceGateState<'a> {
    gates: &'a [EvidenceGate],
    evidence_references: &'a HashMap<String, Vec<String>>,
    established_gates: &'a mut HashSet<String>,
}

fn inspect_evidence_gates(
    text: &str,
    event: &Event,
    channel: EvidenceInspectionChannel,
    state: &mut EvidenceGateState<'_>,
    metrics: &mut StageEventMetrics,
) {
    for gate in state.gates {
        if !gate
            .guarded_markers
            .iter()
            .any(|marker| normalized_contains(text, marker))
        {
            continue;
        }
        let references = state
            .evidence_references
            .get(&gate.id)
            .map(Vec::as_slice)
            .unwrap_or_default();
        if references.is_empty() {
            metrics.temporal_violations.push(format!(
                "gate={} channel={} event={} fact appeared before evidence",
                gate.id,
                channel.label(),
                event_reference(event)
            ));
        } else if channel.checks_provenance() && !state.established_gates.contains(&gate.id) {
            if gate.require_context_reference
                && !references
                    .iter()
                    .any(|reference| normalized_contains(text, reference))
            {
                metrics.provenance_violations.push(format!(
                    "gate={} channel={} event={} missing evidence reference; expected one of {}",
                    gate.id,
                    channel.label(),
                    event_reference(event),
                    references.join(",")
                ));
            } else {
                state.established_gates.insert(gate.id.clone());
            }
        }
    }
}

fn evidence_event_matches(event: &Event, gate: &EvidenceGate) -> bool {
    if !gate.evidence_topics.is_empty() && !gate.evidence_topics.contains(&event.topic) {
        return false;
    }
    if !gate.evidence_tool_names.is_empty()
        && !event
            .payload
            .get("tool_name")
            .and_then(|value| value.as_str())
            .is_some_and(|name| {
                gate.evidence_tool_names
                    .iter()
                    .any(|allowed| allowed == name)
            })
    {
        return false;
    }
    !gate.evidence_markers.is_empty()
        && event_payload_text(event).is_some_and(|text| {
            gate.evidence_markers
                .iter()
                .all(|marker| normalized_contains(text, marker))
        })
}

fn event_payload_text(event: &Event) -> Option<&str> {
    event.payload.get("text").and_then(|value| value.as_str())
}

fn event_reference(event: &Event) -> String {
    event
        .sequence
        .map(|sequence| format!("@e{sequence}"))
        .unwrap_or_else(|| event.id.clone())
}

fn tool_call_name(call: &serde_json::Value) -> Option<&str> {
    call.get("function")
        .and_then(|value| value.get("name"))
        .and_then(|value| value.as_str())
}

fn tool_call_arguments(call: &serde_json::Value) -> Option<&str> {
    call.get("function")
        .and_then(|value| value.get("arguments"))
        .and_then(|value| value.as_str())
}

fn context_transaction_text(arguments: &str) -> String {
    serde_json::from_str::<serde_json::Value>(arguments)
        .ok()
        .and_then(|value| {
            value
                .get("transaction")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| arguments.to_string())
}

fn tool_call_path(arguments: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(arguments)
        .ok()?
        .get("path")?
        .as_str()
        .map(str::to_string)
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
    use crate::config::ToolSecurityConfig;
    use crate::tool_security::{resolve_tool_path, ToolAccess};
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
        assert_eq!(environment.manifest.evidence_gates.len(), 1);
        assert!(environment.manifest.evidence_gates[0].require_context_reference);
        assert!(!environment.manifest.evidence_gates[0]
            .guarded_markers
            .contains(&"v3".to_string()));
        assert!(environment.manifest.evidence_gates[0]
            .guarded_markers
            .contains(&"(version v3)".to_string()));
        assert_eq!(
            environment.manifest.context_protocol_version,
            CONTEXT_PROTOCOL_VERSION
        );
    }

    #[tokio::test]
    async fn transfer_fixture_covers_positive_negative_and_restart_transfer() {
        let temp = TempDir::new().unwrap();
        let environment = create_autonomous_transfer_eval(Some(temp.path()))
            .await
            .unwrap();
        assert_eq!(environment.manifest.stages.len(), 6);
        assert_eq!(environment.manifest.family, "autonomous_evolution");
        assert_eq!(
            environment.manifest.required_constraint_marker,
            "EVIDENCE-AUTHORITY-BEFORE-RECENCY"
        );
        assert!(environment
            .manifest
            .stages
            .iter()
            .any(|stage| stage.id == "positive-transfer-case-b"));
        assert!(environment
            .manifest
            .stages
            .iter()
            .any(|stage| stage.id == "counterexample-case-c"));
        assert!(environment
            .manifest
            .stages
            .last()
            .is_some_and(|stage| stage.restart_before && stage.require_no_physical_tools));
        assert!(!environment
            .manifest
            .workspace_root
            .join("cases/b/approved-current.md")
            .exists());
        assert!(!environment
            .manifest
            .workspace_root
            .join("cases/c/later-approved-hotfix.md")
            .exists());
        assert!(environment
            .manifest
            .stages
            .iter()
            .all(|stage| stage.state_path == "state/transfer.env"));
    }

    #[tokio::test]
    async fn epistemic_reality_fixture_hides_two_cross_domain_future_evidence_sources() {
        let temp = TempDir::new().unwrap();
        let environment = create_epistemic_reality_eval(Some(temp.path()))
            .await
            .unwrap();
        assert_eq!(environment.manifest.stages.len(), 6);
        assert_eq!(
            environment.manifest.family,
            "reality_constrained_epistemics"
        );
        assert_eq!(environment.manifest.evidence_gates.len(), 2);
        assert!(environment
            .manifest
            .evidence_gates
            .iter()
            .all(|gate| gate.require_context_reference));
        assert!(!environment
            .manifest
            .workspace_root
            .join("people/appointment.md")
            .exists());
        assert!(!environment
            .manifest
            .workspace_root
            .join("incidents/closure.md")
            .exists());
        assert!(environment
            .manifest
            .stages
            .iter()
            .any(|stage| stage.state_path == "state/person.env"));
        assert!(environment
            .manifest
            .stages
            .iter()
            .any(|stage| stage.state_path == "state/incident.env"));
        let pre_appointment = environment.manifest.stages[..2]
            .iter()
            .map(|stage| stage.prompt.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!pre_appointment.contains("principal-engineer"));
        assert!(!environment.manifest.stages[4].prompt.contains("resolved"));
        assert_eq!(
            environment.manifest.context_protocol_version,
            CONTEXT_PROTOCOL_VERSION
        );
    }

    #[tokio::test]
    async fn experience_transfer_arms_share_identical_unhinted_target_tasks() {
        let temp = TempDir::new().unwrap();
        let related = create_experience_transfer_arm_eval(
            Some(&temp.path().join("related")),
            ExperienceTransferArm::RelatedExperience,
        )
        .await
        .unwrap();
        let unrelated = create_experience_transfer_arm_eval(
            Some(&temp.path().join("unrelated")),
            ExperienceTransferArm::UnrelatedExperience,
        )
        .await
        .unwrap();
        let fresh = create_experience_transfer_arm_eval(
            Some(&temp.path().join("fresh")),
            ExperienceTransferArm::Fresh,
        )
        .await
        .unwrap();

        assert_eq!(related.manifest.stages.len(), 7);
        assert_eq!(unrelated.manifest.stages.len(), 7);
        assert_eq!(fresh.manifest.stages.len(), 3);

        let related_target = target_stages(&related.manifest);
        let unrelated_target = target_stages(&unrelated.manifest);
        let fresh_target = target_stages(&fresh.manifest);
        assert_eq!(related_target.len(), 3);
        assert_eq!(unrelated_target.len(), 3);
        assert_eq!(fresh_target.len(), 3);
        for ((related_stage, unrelated_stage), fresh_stage) in related_target
            .iter()
            .zip(unrelated_target.iter())
            .zip(fresh_target.iter())
        {
            assert_eq!(related_stage.id, fresh_stage.id);
            assert_eq!(unrelated_stage.id, fresh_stage.id);
            assert_eq!(related_stage.prompt, fresh_stage.prompt);
            assert_eq!(unrelated_stage.prompt, fresh_stage.prompt);
            assert_eq!(
                serde_json::to_value(&related_stage.injections).unwrap(),
                serde_json::to_value(&fresh_stage.injections).unwrap()
            );
            assert_eq!(
                serde_json::to_value(&unrelated_stage.injections).unwrap(),
                serde_json::to_value(&fresh_stage.injections).unwrap()
            );
            assert_eq!(related_stage.expected_state, fresh_stage.expected_state);
            assert_eq!(unrelated_stage.expected_state, fresh_stage.expected_state);
        }
        let target_prompts = fresh_target
            .iter()
            .map(|stage| stage.prompt.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        for leaked_hint in ["ALPHA", "BETA", "CHARLIE", "已有策略", "使用经验"] {
            assert!(!target_prompts.contains(leaked_hint));
        }
        assert!(fresh_target[1].prompt.contains("且仅为三行"));
        assert!(fresh_target[1].prompt.contains("rejected_value"));
        for environment in [&related, &unrelated, &fresh] {
            assert!(!environment
                .manifest
                .workspace_root
                .join("challenge/assignment/approved-record.md")
                .exists());
            assert!(!environment
                .manifest
                .workspace_root
                .join("challenge/supplier/current-amendment.md")
                .exists());
        }
        assert!(related.manifest.stages[3].restart_before);
        assert!(unrelated.manifest.stages[3].restart_before);
        assert!(fresh_target[2].restart_before);
    }

    #[tokio::test]
    async fn experience_transfer_challenge_paths_are_allowed_by_default_tool_security() {
        let temp = TempDir::new().unwrap();
        let environment =
            create_experience_transfer_arm_eval(Some(temp.path()), ExperienceTransferArm::Fresh)
                .await
                .unwrap();
        let security = ToolSecurityConfig {
            workspace_root: environment
                .manifest
                .workspace_root
                .to_string_lossy()
                .to_string(),
            ..ToolSecurityConfig::default()
        };

        assert!(resolve_tool_path(
            "challenge/assignment/approved-record.md",
            ToolAccess::Read,
            &security,
        )
        .is_ok());
        assert!(resolve_tool_path(
            "target/assignment/approved-record.md",
            ToolAccess::Read,
            &security,
        )
        .is_err());
    }

    #[test]
    fn experience_transfer_comparison_reports_directional_deltas_without_claiming_success() {
        let related = target_metrics_fixture(3, 3, 8, 5);
        let unrelated = target_metrics_fixture(2, 2, 11, 7);
        let fresh = target_metrics_fixture(2, 1, 10, 6);
        let comparison = compare_experience_transfer_arms(&related, &unrelated, &fresh);
        assert!((comparison.related_minus_fresh_semantic_pass_rate - 1.0 / 3.0).abs() < 1e-12);
        assert!((comparison.related_minus_fresh_strict_pass_rate - 2.0 / 3.0).abs() < 1e-12);
        assert_eq!(comparison.related_minus_fresh_model_attempts, -2);
        assert_eq!(comparison.related_minus_fresh_physical_tool_calls, -1);
        assert_eq!(comparison.unrelated_minus_fresh_model_attempts, 1);
        assert_eq!(comparison.unrelated_minus_fresh_physical_tool_calls, 1);
    }

    #[test]
    fn abstraction_signal_only_labels_explicit_reusable_structures() {
        assert!(is_abstraction_candidate(
            "(principle (when repeated-conflict) (prefer supported-current))"
        ));
        assert!(is_abstraction_candidate(
            "(规则 (适用范围 多任务) (反例 未知来源))"
        ));
        assert!(!is_abstraction_candidate(
            "(context-body (case_id A) (selected_value ALPHA-17) (basis approved-current))"
        ));
        assert_eq!(
            ExperienceTransferPromptMode::AgentOwnedContext.as_str(),
            "agent_owned_context"
        );
        assert_eq!(
            ExperienceTransferPromptMode::CognitiveSexprVm.as_str(),
            "cognitive_sexpr_vm"
        );
    }

    #[test]
    fn mind_scoring_excludes_inbox_text_and_retired_frames() {
        let state: MindState = serde_json::from_value(serde_json::json!({
            "version": 2,
            "frames": [
                {
                    "id": "active",
                    "body": "(fact MIND-ONLY)",
                    "sources": [],
                    "revision": 1,
                    "created_version": 1,
                    "updated_version": 1
                },
                {
                    "id": "retired-frame",
                    "body": "(fact RETIRED-ONLY)",
                    "sources": [],
                    "revision": 1,
                    "created_version": 1,
                    "updated_version": 1
                }
            ],
            "relations": [{
                "subject": "active",
                "relation": "supports",
                "object": "MIND-RELATION",
                "created_version": 2
            }],
            "retired": ["retired-frame"],
            "protected": [],
            "checkpoints": []
        }))
        .unwrap();
        let text = active_mind_evaluation_text(&state);
        assert!(text.contains("MIND-ONLY"));
        assert!(text.contains("MIND-RELATION"));
        assert!(!text.contains("RETIRED-ONLY"));
        assert!(!text.contains("INBOX-ONLY"));
    }

    fn target_stages(manifest: &LongHorizonEvalManifest) -> Vec<&LongHorizonStage> {
        manifest
            .stages
            .iter()
            .filter(|stage| stage.id.starts_with(TARGET_STAGE_PREFIX))
            .collect()
    }

    fn target_metrics_fixture(
        semantic: usize,
        strict: usize,
        attempts: usize,
        tools: usize,
    ) -> ExperienceTransferTargetMetrics {
        ExperienceTransferTargetMetrics {
            target_stages: 3,
            state_passed_stages: semantic,
            mind_passed_stages: semantic,
            behavior_passed_stages: semantic,
            semantic_passed_stages: semantic,
            reply_passed_stages: strict,
            strict_passed_stages: strict,
            state_pass_rate: ratio(semantic, 3),
            mind_pass_rate: ratio(semantic, 3),
            semantic_pass_rate: ratio(semantic, 3),
            strict_pass_rate: ratio(strict, 3),
            restart_recovery_passed: true,
            model_attempts: attempts,
            physical_tool_calls: tools,
            context_commits: 0,
            empty_standalone_context_tx_attempts: 0,
            temporal_violations: 0,
            provenance_violations: 0,
            exact_duplicate_physical_tool_calls: 0,
            same_path_repeat_physical_tool_calls: 0,
            read_guard_rejections: 0,
        }
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

    #[tokio::test]
    async fn event_metrics_separate_standalone_transactions_and_physical_duplicates() {
        let temp = TempDir::new().unwrap();
        let manifest = create_operations_continuity_eval(Some(temp.path()))
            .await
            .unwrap()
            .manifest;
        let events = vec![
            test_event(
                1,
                "user_message",
                "chat/user_message",
                serde_json::json!({"text":"go"}),
            ),
            test_event(
                2,
                "agent_call",
                "chat/assistant_call",
                serde_json::json!({
                    "text":"",
                    "tool_calls":[
                        test_tool_call("context_tx", r#"{"transaction":"(context-tx (base-version 0) (create task (status active)))"}"#),
                        test_tool_call("read", r#"{"path":"sources/a.md"}"#)
                    ]
                }),
            ),
            test_event(
                3,
                "agent_call",
                "chat/assistant_call",
                serde_json::json!({
                    "text":"",
                    "tool_calls":[test_tool_call("context_tx", r#"{"transaction":"(context-tx (base-version 1) (revise task (status done)))"}"#)],
                    "context_tx_rejection_status":"budget-exhausted",
                    "rejected_context_tx_ids":["tx-2"]
                }),
            ),
            test_event(
                4,
                "agent_call",
                "chat/assistant_call",
                serde_json::json!({
                    "text":"", "tool_calls":[test_tool_call("read", r#"{"path":"sources/a.md"}"#)]
                }),
            ),
            test_event(
                5,
                "agent_call",
                "chat/assistant_call",
                serde_json::json!({
                    "text":"", "tool_calls":[test_tool_call("read", r#"{"path":"sources/a.md"}"#)]
                }),
            ),
            test_event(
                6,
                "agent_call",
                "chat/assistant_call",
                serde_json::json!({
                    "text":"", "tool_calls":[test_tool_call("read", r#"{"path":"sources/a.md","start_line":2}"#)]
                }),
            ),
            test_event(
                7,
                "tool_output",
                "chat/tool_output",
                serde_json::json!({
                    "text":"READ_ALREADY_COVERED", "tool_name":"read", "tool_status":"rejected"
                }),
            ),
        ];

        let metrics = analyze_stage_events(&events, &manifest);
        let stage = &metrics[0];
        assert_eq!(stage.context_tx_attempts, 2);
        assert_eq!(stage.standalone_context_tx_attempts, 1);
        assert_eq!(stage.empty_standalone_context_tx_attempts, 1);
        assert_eq!(stage.rejected_context_tx_attempts, 1);
        assert_eq!(stage.exact_duplicate_physical_tool_calls, 2);
        assert_eq!(stage.same_path_repeat_physical_tool_calls, 3);
        assert_eq!(stage.read_guard_rejections, 1);
    }

    #[tokio::test]
    async fn evidence_gate_detects_early_facts_and_missing_provenance() {
        let temp = TempDir::new().unwrap();
        let manifest = create_operations_continuity_eval(Some(temp.path()))
            .await
            .unwrap()
            .manifest;
        let events = vec![
            test_event(
                1,
                "user_message",
                "chat/user_message",
                serde_json::json!({"text":"stage 1"}),
            ),
            test_event(
                2,
                "user_message",
                "chat/user_message",
                serde_json::json!({"text":"stage 2"}),
            ),
            test_event(
                3,
                "agent_call",
                "chat/assistant_call",
                serde_json::json!({
                    "text":"",
                    "tool_calls":[test_tool_call("context_tx", r#"{"transaction":"(context-tx (base-version 1) (derive service_v3 (from @e2) (version v3)))"}"#)]
                }),
            ),
            test_event(
                4,
                "agent_call",
                "chat/reply",
                serde_json::json!({"text":"current_version=v3"}),
            ),
            test_event(
                5,
                "user_message",
                "chat/user_message",
                serde_json::json!({"text":"stage 3"}),
            ),
            test_event(
                6,
                "tool_output",
                "chat/tool_output",
                serde_json::json!({
                    "text":"status: approved-current\nversion: v3\n", "tool_name":"read", "tool_status":"success"
                }),
            ),
            test_event(
                7,
                "agent_call",
                "chat/assistant_call",
                serde_json::json!({
                    "text":"",
                    "tool_calls":[test_tool_call("context_tx", r#"{"transaction":"(context-tx (base-version 2) (derive release-v3 (from @e5) (version v3)))"}"#)]
                }),
            ),
            test_event(
                8,
                "agent_call",
                "chat/assistant_call",
                serde_json::json!({
                    "text":"",
                    "tool_calls":[test_tool_call("context_tx", r#"{"transaction":"(context-tx (base-version 2) (derive release-v3 (from @e6) (version v3)))"}"#)]
                }),
            ),
        ];

        let metrics = analyze_stage_events(&events, &manifest);
        assert_eq!(metrics[1].temporal_violations.len(), 2);
        assert!(metrics[1].provenance_violations.is_empty());
        assert!(metrics[2].temporal_violations.is_empty());
        assert_eq!(metrics[2].provenance_violations.len(), 1);
    }

    fn test_tool_call(name: &str, arguments: &str) -> serde_json::Value {
        serde_json::json!({
            "id": format!("{name}-call"),
            "type":"function",
            "function":{"name":name,"arguments":arguments}
        })
    }

    fn test_event(
        sequence: u64,
        event_type: &str,
        topic: &str,
        payload: serde_json::Value,
    ) -> Event {
        let mut event = Event::new(
            format!("event-{sequence}"),
            "test".to_string(),
            event_type.to_string(),
            topic.to_string(),
            payload.as_object().unwrap().clone(),
        );
        event.sequence = Some(sequence);
        event
    }
}
