use crate::approval::{
    capability_lease_policy_digest, AiAutoReviewProvider, ApprovalDecision, ApprovalProvider,
    ApprovalRequest, CapabilityLeaseOffer, DenyAllApprovalProvider, EscalatingApprovalProvider,
    HumanApprovalHub, HumanApprovalProvider, PendingHumanApproval,
    CAPABILITY_LEASE_APPROVED_RISK_TAG,
};
use crate::artifact::{
    execution_arguments_from_transfer_request, ArtifactTransferProgress, ArtifactTransferRequest,
    ARTIFACT_TRANSFER_TOOL_NAME, CURRENT_ARTIFACT_TRANSFER_PROGRESS,
};
use crate::config::{AppConfig, StorageBackend};
use crate::context_tools::{ContextTxTool, RecallTool};
use crate::event::{
    Event, InMemoryEventBus, TYPE_INFER_REQUEST, TYPE_TOOL_OUTPUT, TYPE_USER_MESSAGE,
};
use crate::execution::{
    ExecutionJobManager, ExecutionJobSpec, JobClaim, JobHeartbeat, JobOutcome, JobReceipt,
};
use crate::harness::{HarnessBinding, HarnessDescriptor, HarnessRegistry as DomainHarnessRegistry};
use crate::harness_package::{
    load_evaluation_harness_binding, load_objective_harness_binding,
    load_persisted_harness_packages, objective_harness_binding_event, persist_harness_package,
    persist_objective_harness_binding, HarnessPackage,
};
use crate::harness_tool::{HarnessListTool, HarnessSelectTool};
use crate::identity::{
    IdentityEvidence, IdentityProvider, PrincipalAssertion, StaticIdentityProvider,
};
use crate::llm::{Client, ModelUsage, ReasoningEffort};
use crate::memory::postgres::PostgresStore;
use crate::memory::sqlite::SqliteStore;
use crate::memory::{
    AgentBootstrapRecord, AgentRecord, ApprovalFilter, ApprovalMutation, ApprovalResolution,
    ApprovalStore, ArtifactTransferExecutionRecord, AttentionAcknowledgementRecord,
    CapabilityLeaseFilter, CapabilityLeaseMutation, CapabilityLeaseRecord, CognitiveContextRecord,
    ContextTokenBudgetMutation, ContextUpdate, DelegationRecord, DelegationStatus,
    DialogueTurnRetryMutation, DialogueTurnRetryRequest, EdgeCommandMutation,
    EdgeCommandOutputChunk, EdgeCommandRecord, EdgeCommandStatus, EdgeOutputStream, EventStore,
    ExecutionApprovalStore, ExecutionJobFilter, ExecutionJobRecord, ExecutionJobStatus,
    ExecutionJobStore, ExecutionNodeMutation, ExecutionNodeRecord,
    ExecutionTargetAuthorizationFilter, ExecutionTargetAuthorizationMutation,
    ExecutionTargetAuthorizationRecord, ExecutionTargetFilter, ExecutionTargetMutation,
    ExecutionTargetRecord, ExecutionTargetRegistration, ExecutionTargetStatus,
    ExecutionTargetStore, MessageClaim, MindProjectionHead, MindProjectionStore, NewAgent,
    NewArtifactTransferExecution, NewCognitiveContext, NewDelegation, NewExecutionNodeChallenge,
    NewExecutionTargetAuthorization, NewNodePairingCode, NewObjective, NewPrincipal, NewSession,
    NewThread, NewThreadActivation, ObjectiveMutation, ObjectiveRecord, ObjectiveStatus,
    ObjectiveStore, ObjectiveWaitCondition, PairExecutionNode, PrincipalDirectoryPage, QueryFilter,
    RecallDocumentKind, RecallProjectionStore, RuntimeStore, ScheduleMutation, ScheduleRecord,
    ScheduleStatus, SessionPrincipalBinding, SessionRecord, SessionStore, SessionUpdate,
    ThreadActivationRecord, ThreadActivationStatus, ThreadControlAction, ThreadControlState,
    ThreadGroupFilter, ThreadKind, ThreadLifecycle, ThreadMutation, ThreadPhase, ThreadRecord,
    ThreadSignalRecord, ThreadSignalStatus, ThreadSupervision, ThreadSupervisorKind, TimerStore,
};
use crate::objective::{
    ObjectiveCreateTool, ObjectiveEvaluationRegistry, ObjectiveSupervisor, ObjectiveUpdateTool,
};
use crate::orchestrator::context::{
    ContextAttribution, ContextEngine, ContextPressure, ContextRecallService, ContextTokenBudget,
    ContextView, FrameRecallPage, FrameRecallRequest, ModelContextCapacity, ProjectedSession,
    RecallSearchPage, RecallSearchRequest, SessionWorkingSetView,
};
use crate::orchestrator::orchestrator::{DurableApprovalServices, Orchestrator};
use crate::permission::{
    ApprovalRequirement, PermissionBroker, PermissionProfile, ReviewerKind, SandboxMode,
};
use crate::scheduler::{
    audit_scheduler_invariants, derive_objective_readiness, KernelResult,
    SchedulerDependencyFilter, SchedulerDependencyOwnerKind, SchedulerInvariantInput,
    SchedulerKernel,
};
pub use crate::scheduler::{
    SchedulerActivationSnapshot, SchedulerAdmissionSnapshot, SchedulerDeliverySnapshot,
    SchedulerExternalOutboxSnapshot, SchedulerJobSnapshot, SchedulerObjectiveSnapshot,
    SchedulerQuery, SchedulerResultSnapshot, SchedulerSnapshot, SchedulerSummary,
    SchedulerThreadGroupSnapshot, SchedulerThreadSnapshot,
};
use crate::secret_store::{
    ManagedSecret, SecretBackendStatus, SecretImportCandidate, SecretScopeKind, SecretStore,
    SecretUseAuditRecord,
};
use crate::timer::TimerEngine;
use crate::tool::{
    BackgroundTaskScheduler, CheckTaskAfterTool, DelegateTool, EditFileTool, ExecuteCommandTool,
    KillTaskTool, ListFilesTool, ListSecretsTool, ListSkillsTool, ListTasksTool, ReadFileTool,
    Registry, ScheduleTxTool, SearchTool, SendMessageTool, TaskStatusTool, ThreadScheduler,
    VerifyIdentityTool, WriteFileTool,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock, Weak};
use tokio::io::AsyncWriteExt;

pub type RuntimeError = Box<dyn std::error::Error + Send + Sync>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ContextTokenBudgetUpdate {
    Updated(ContextTokenBudget),
    Conflict(ContextTokenBudget),
    NotFound,
}

fn resolve_model_context_capacity(config: &AppConfig, model: &str) -> ModelContextCapacity {
    let provider_id = config.llm.provider.clone();
    let profile = provider_id
        .as_deref()
        .and_then(|provider_id| config.providers.get(provider_id))
        .and_then(|provider| provider.models.get(model));
    let configured_prompt_token_limit =
        profile.and_then(crate::config::ProviderModelConfig::prompt_token_limit);
    let prompt_token_limit = configured_prompt_token_limit
        .unwrap_or(config.orchestrator.context_hard_token_limit)
        .max(1);
    ModelContextCapacity {
        provider: provider_id,
        model: model.to_string(),
        prompt_token_limit,
        context_window_tokens: profile.and_then(|profile| profile.context_window_tokens),
        max_output_tokens: profile
            .and_then(|profile| profile.max_output_tokens)
            .or(config.llm.max_output_tokens.map(|value| value as usize)),
        source: if configured_prompt_token_limit.is_some() {
            "provider-model-config".to_string()
        } else {
            "runtime-default".to_string()
        },
    }
}

static RUNTIME_ID_COUNTER: AtomicU64 = AtomicU64::new(0);
const RUNTIME_DEFAULT_IDENTITY_PROVIDER_ID: &str = "runtime-default";
const ARTIFACT_TRANSFER_EXECUTOR_KIND: &str = "artifact_transfer";
const ARTIFACT_TRANSFER_REQUEST_TOPIC: &str = "runtime/artifact_transfer_requested";
const ARTIFACT_TRANSFER_PROGRESS_TOPIC: &str = "runtime/artifact_transfer_progress";
const ARTIFACT_TRANSFER_COMPLETED_TOPIC: &str = "runtime/artifact_transfer_completed";
const ARTIFACT_TRANSFER_FAILED_TOPIC: &str = "runtime/artifact_transfer_failed";
const MAX_MESSAGE_ATTACHMENTS: usize = 8;
const MAX_MESSAGE_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;
const MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES: usize = 40 * 1024 * 1024;
const ARTIFACT_TRANSFER_CANCELLED_TOPIC: &str = "runtime/artifact_transfer_cancelled";
const ARTIFACT_TRANSFER_WORKER_LEASE_SECS: i64 = 300;

async fn persist_message_attachments(
    configured_root: &str,
    session_id: &str,
    event_id: &str,
    attachments: Vec<crate::sdk::MessageAttachmentInput>,
) -> Result<Vec<Value>, RuntimeError> {
    if attachments.len() > MAX_MESSAGE_ATTACHMENTS {
        return Err(format!("单条消息最多允许 {MAX_MESSAGE_ATTACHMENTS} 个附件").into());
    }
    let total_bytes = attachments
        .iter()
        .try_fold(0usize, |total, attachment| {
            if attachment.data.len() > MAX_MESSAGE_ATTACHMENT_BYTES {
                return Err(format!(
                    "附件 '{}' 超过单文件 {} MiB 限制",
                    attachment.name,
                    MAX_MESSAGE_ATTACHMENT_BYTES / 1024 / 1024
                ));
            }
            total
                .checked_add(attachment.data.len())
                .ok_or_else(|| "附件总大小溢出".to_string())
        })
        .map_err(|error| -> RuntimeError { error.into() })?;
    if total_bytes > MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES {
        return Err(format!(
            "单条消息附件总大小超过 {} MiB 限制",
            MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES / 1024 / 1024
        )
        .into());
    }
    if attachments.is_empty() {
        return Ok(Vec::new());
    }

    let root = PathBuf::from(configured_root);
    let root = if root.is_absolute() {
        root
    } else {
        std::env::current_dir()?.join(root)
    };
    let session_key = format!("{:x}", Sha256::digest(session_id.as_bytes()));
    let directory = root.join("message-inputs").join(session_key);
    tokio::fs::create_dir_all(&directory).await?;
    let directory = tokio::fs::canonicalize(&directory).await?;
    let mut metadata = Vec::with_capacity(attachments.len());

    for (index, attachment) in attachments.into_iter().enumerate() {
        let name = Path::new(attachment.name.trim())
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() || name.chars().count() > 255 {
            return Err("附件名称不能为空且不能超过 255 个字符".into());
        }
        let media_type = attachment.media_type.trim();
        let media_type = if media_type.is_empty() {
            "application/octet-stream"
        } else {
            media_type
        };
        if media_type.chars().count() > 128
            || !media_type
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "/.+-".contains(character))
        {
            return Err(format!("附件 '{}' 的 media type 非法", name).into());
        }

        let digest = format!("{:x}", Sha256::digest(&attachment.data));
        let final_path = directory.join(&digest);
        if !tokio::fs::try_exists(&final_path).await? {
            let temporary_path = directory.join(format!(".{digest}.{event_id}.{index}.partial"));
            let mut file = tokio::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary_path)
                .await?;
            file.write_all(&attachment.data).await?;
            file.sync_data().await?;
            drop(file);
            match tokio::fs::rename(&temporary_path, &final_path).await {
                Ok(()) => {}
                Err(error) if tokio::fs::try_exists(&final_path).await.unwrap_or(false) => {
                    let _ = tokio::fs::remove_file(&temporary_path).await;
                    tracing::debug!(
                        path = %final_path.display(),
                        error = %error,
                        "消息附件已由并发写入复用"
                    );
                }
                Err(error) => {
                    let _ = tokio::fs::remove_file(&temporary_path).await;
                    return Err(error.into());
                }
            }
        }
        metadata.push(json!({
            "id": format!("attachment_{digest}"),
            "name": name,
            "media_type": media_type,
            "size_bytes": attachment.data.len(),
            "sha256": digest,
            "storage_path": final_path.to_string_lossy(),
        }));
    }
    Ok(metadata)
}

struct ArtifactTransferExecutionIdentity {
    event_id: String,
    thread_id: String,
    activation_id: String,
    tool_call_id: String,
    job_id: String,
}

fn artifact_transfer_execution_identity(
    principal_id: &str,
    session_id: &str,
    transfer_id: &str,
) -> ArtifactTransferExecutionIdentity {
    let mut digest = Sha256::new();
    digest.update(b"morphz.artifact-transfer.execution.v1\0");
    for value in [principal_id, session_id, transfer_id] {
        digest.update((value.len() as u64).to_be_bytes());
        digest.update(value.as_bytes());
    }
    let key = format!("{:x}", digest.finalize());
    let activation_id = format!("activation_artifact_{key}");
    let tool_call_id = format!("call_artifact_{key}");
    let job_id = crate::execution::deterministic_job_id(&activation_id, &tool_call_id)
        .expect("artifact identity components are non-empty");
    ArtifactTransferExecutionIdentity {
        event_id: format!("artifact_transfer_requested_{key}"),
        thread_id: format!("thread_artifact_{key}"),
        activation_id,
        tool_call_id,
        job_id,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeIdentity {
    pub agent_id: String,
    pub context_id: String,
    #[serde(default = "default_runtime_principal_id")]
    pub principal_id: String,
}

fn default_runtime_principal_id() -> String {
    "principal-default".to_string()
}

/// Durable operator disposition for one exact revision of a derived attention
/// fact. The underlying scheduler authority remains unchanged: acknowledging a
/// failure only removes that exact fingerprint from the operator inbox. A new
/// source revision produces a new fingerprint and therefore reopens attention.
pub type AttentionAcknowledgement = AttentionAcknowledgementRecord;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AcknowledgeAttentionCommand {
    pub key: String,
    pub source_kind: String,
    pub source_id: String,
    pub source_revision: u64,
    pub rationale: Option<String>,
}

fn model_usage_record_from_event(event: Event) -> Option<ModelUsageRecord> {
    let payload = &event.payload;
    Some(ModelUsageRecord {
        event_id: event.id,
        sequence: event.sequence,
        timestamp: event.timestamp,
        context_id: payload.get("context_id")?.as_str()?.to_string(),
        session_id: payload.get("session_id")?.as_str()?.to_string(),
        attempt_id: payload.get("attempt_id")?.as_str()?.to_string(),
        model: payload
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string),
        usage: serde_json::from_value(payload.get("usage")?.clone()).ok()?,
        predicted_input_tokens: payload
            .get("predicted_input_tokens")
            .and_then(Value::as_u64),
        local_base_estimate_tokens: payload
            .get("local_base_estimate_tokens")
            .and_then(Value::as_u64),
        counter_source: payload
            .get("counter_source")
            .and_then(Value::as_str)
            .map(str::to_string),
        counter_accuracy: payload
            .get("counter_accuracy")
            .and_then(Value::as_str)
            .map(str::to_string),
        thread_id: payload
            .get("thread_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        activation_id: payload
            .get("activation_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        objective_id: payload
            .get("objective_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        cost: None,
    })
}

fn calculate_model_usage_cost(
    pricing: &crate::config::UsagePricingConfig,
    model: Option<&str>,
    usage: &ModelUsage,
) -> Option<ModelUsageCost> {
    let price = pricing.models.get(model?)?;
    if price.version.trim().is_empty() || pricing.currency.trim().is_empty() {
        return None;
    }
    let cached = usage.cached_input_tokens.unwrap_or(0);
    let cache_write = usage.cache_write_input_tokens.unwrap_or(0);
    let uncached = usage.uncached_input_tokens.unwrap_or_else(|| {
        usage
            .input_tokens
            .unwrap_or(0)
            .saturating_sub(cached)
            .saturating_sub(cache_write)
    });
    let output = usage.output_tokens.unwrap_or(0);
    let priced = |tokens: u64, rate: Option<f64>| -> Option<f64> {
        if tokens == 0 {
            Some(0.0)
        } else {
            rate.filter(|rate| rate.is_finite() && *rate >= 0.0)
                .map(|rate| tokens as f64 * rate / 1_000_000.0)
        }
    };
    let amount = priced(uncached, price.input_per_million)?
        + priced(cached, price.cached_input_per_million)?
        + priced(cache_write, price.cache_write_input_per_million)?
        + priced(output, price.output_per_million)?;
    Some(ModelUsageCost {
        amount,
        currency: pricing.currency.clone(),
        pricing_version: price.version.clone(),
    })
}

/// Bounded, authoritative summary used by every Context-level product surface.
/// The overview deliberately contains projections and aggregate counts rather
/// than the unbounded Ledger or the full Context Encoding S-expression.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextOverview {
    pub context: CognitiveContextRecord,
    pub agent: Option<AgentRecord>,
    pub generated_at: chrono::DateTime<chrono::Utc>,
    pub active_session_id: Option<String>,
    pub sessions: Vec<ProjectedSession>,
    pub working_set: Option<SessionWorkingSetView>,
    pub mind_revision: u64,
    pub active_frames: usize,
    pub retiring_frames: usize,
    pub retired_items: usize,
    pub pressure: Option<ContextPressure>,
    /// Latest full-Prompt component attribution. Values are estimates; exact
    /// Provider accounting is exposed separately through ModelUsage records.
    pub attribution: Option<ContextAttribution>,
    pub objectives: Vec<ObjectiveRecord>,
    pub scheduler: SchedulerSummary,
}

/// Bounded operator query for the Runtime-wide command board.
///
/// This is intentionally independent from `ContextOverviewQuery`: the global
/// overview may span a very large tenant directory, so both axes are bounded
/// before any projection rows are materialized.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeOverviewQuery {
    pub include_archived: bool,
    pub context_limit: Option<usize>,
    pub sessions_per_context: Option<usize>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeSessionState {
    NeedsAttention,
    WaitingUser,
    Running,
    Queued,
    Paused,
    Waiting,
    Idle,
}

impl RuntimeSessionState {
    fn priority(self) -> u8 {
        match self {
            Self::NeedsAttention => 6,
            Self::WaitingUser => 5,
            Self::Running => 4,
            Self::Queued => 3,
            Self::Paused => 2,
            Self::Waiting => 1,
            Self::Idle => 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeOverviewThread {
    pub id: String,
    pub kind: ThreadKind,
    pub phase: ThreadPhase,
    pub control_state: ThreadControlState,
    pub objective_id: Option<String>,
    pub target_id: Option<String>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeOverviewObjective {
    pub id: String,
    pub stated_objective: String,
    pub status: ObjectiveStatus,
    pub status_reason: Option<String>,
    pub wait_condition: Option<ObjectiveWaitCondition>,
    pub revision: u64,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeOverviewSession {
    pub session: SessionRecord,
    pub principal_ids: Vec<String>,
    pub state: RuntimeSessionState,
    pub attention_required: bool,
    pub pending_dialogue_turns: usize,
    pub open_thread_count: usize,
    pub running_activation_count: usize,
    pub current_thread: Option<RuntimeOverviewThread>,
    pub current_objective: Option<RuntimeOverviewObjective>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeOverviewDelegation {
    pub id: String,
    pub parent_context_id: String,
    pub parent_session_id: String,
    pub child_session_id: String,
    pub task: String,
    pub status: DelegationStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeOverviewContext {
    pub context: CognitiveContextRecord,
    pub mind_revision: Option<u64>,
    pub delegation: Option<RuntimeOverviewDelegation>,
    pub active_session_count: u64,
    pub total_session_count: u64,
    pub hidden_session_count: u64,
    pub objective_count: usize,
    pub open_thread_count: usize,
    pub running_activation_count: usize,
    pub attention_count: usize,
    pub last_activity_at: chrono::DateTime<chrono::Utc>,
    pub sessions: Vec<RuntimeOverviewSession>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeOverviewSummary {
    pub contexts: usize,
    pub active_sessions: u64,
    pub total_sessions: u64,
    pub objectives: usize,
    pub open_threads: usize,
    pub running_activations: usize,
    pub attention_required: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeOverview {
    pub generated_at: chrono::DateTime<chrono::Utc>,
    pub summary: RuntimeOverviewSummary,
    pub contexts: Vec<RuntimeOverviewContext>,
    pub has_more_contexts: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextOverviewQuery {
    pub active_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelUsageRecord {
    pub event_id: String,
    pub sequence: Option<u64>,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub context_id: String,
    pub session_id: String,
    pub attempt_id: String,
    pub model: Option<String>,
    pub usage: ModelUsage,
    pub predicted_input_tokens: Option<u64>,
    pub local_base_estimate_tokens: Option<u64>,
    pub counter_source: Option<String>,
    pub counter_accuracy: Option<String>,
    pub thread_id: Option<String>,
    pub activation_id: Option<String>,
    pub objective_id: Option<String>,
    pub cost: Option<ModelUsageCost>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelUsageCost {
    pub amount: f64,
    pub currency: String,
    pub pricing_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelUsageCostTotal {
    pub amount: f64,
    pub currency: String,
    pub pricing_version: String,
    pub priced_attempts: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelUsageTotals {
    pub attempts: u64,
    pub input_tokens: u64,
    pub uncached_input_tokens: u64,
    pub cached_input_tokens: u64,
    pub cache_write_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelUsageQuery {
    pub session_id: Option<String>,
    pub before_sequence: Option<u64>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelUsagePage {
    pub records: Vec<ModelUsageRecord>,
    pub totals: ModelUsageTotals,
    pub cost_totals: Vec<ModelUsageCostTotal>,
    pub next_before_sequence: Option<u64>,
}

/// One complete causal Thread aggregate. Scheduler lists and inspectors use
/// this same type so an Execution Job can never become a global, ownerless row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadDetail {
    pub context_id: String,
    pub generated_at: chrono::DateTime<chrono::Utc>,
    pub snapshot: SchedulerThreadSnapshot,
    /// Durable Model Attempt transitions and provider-authored reasoning
    /// summaries causally routed to this Thread. Ephemeral deltas remain on
    /// the live stream and are intentionally absent from this aggregate.
    pub model_attempt_events: Vec<Event>,
}

/// Transport-neutral Ledger query. Payload identity/causal filters are kept in
/// this public contract even while a backend may satisfy them through a
/// bounded post-filter; the response makes that scan boundary explicit.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct LedgerQuery {
    pub context_id: String,
    pub session_id: Option<String>,
    pub principal_id: Option<String>,
    pub thread_id: Option<String>,
    pub activation_id: Option<String>,
    pub actor: Option<String>,
    pub event_type: Option<String>,
    pub topic: Option<String>,
    pub search_query: Option<String>,
    pub after_sequence: Option<u64>,
    pub before_sequence: Option<u64>,
    pub start_time: Option<chrono::DateTime<chrono::Utc>>,
    pub end_time: Option<chrono::DateTime<chrono::Utc>>,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LedgerQueryPage {
    pub context_id: String,
    pub generated_at: chrono::DateTime<chrono::Utc>,
    pub events: Vec<Event>,
    pub scanned_count: usize,
    pub scan_exhaustive: bool,
    pub next_after_sequence: Option<u64>,
    pub next_before_sequence: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeStatus {
    pub generated_at: chrono::DateTime<chrono::Utc>,
    pub started: bool,
    pub uptime_seconds: u64,
    pub recovery: RuntimeRecoveryStatus,
    pub version: String,
    pub git_commit: String,
    pub agent_id: String,
    pub context_id: String,
    pub principal_id: String,
    pub model: String,
    pub models: Vec<String>,
    pub provider: Option<String>,
    pub reasoning_effort: Option<String>,
    pub tool_count: usize,
    pub storage: String,
    pub storage_backend: crate::config::StorageBackend,
    pub permission_mode: crate::permission::PermissionMode,
    pub sandbox_mode: SandboxMode,
    pub reviewer: ReviewerKind,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeRecoveryStatus {
    pub preserved_execution_jobs: usize,
    pub recovered_execution_jobs: usize,
    pub requeued_execution_jobs: usize,
    pub lost_execution_jobs: usize,
    pub recovered_background_outboxes: usize,
    pub completed_at: Option<chrono::DateTime<chrono::Utc>>,
}

impl Default for RuntimeIdentity {
    fn default() -> Self {
        Self {
            agent_id: "default-agent".to_string(),
            context_id: "context-default".to_string(),
            principal_id: default_runtime_principal_id(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RuntimeToolPolicy {
    pub context_only: bool,
    pub coding_eval: bool,
}

impl RuntimeToolPolicy {
    pub fn from_environment() -> Self {
        Self {
            context_only: env_flag_enabled("MORPHZ_CONTEXT_EVAL_MODE"),
            coding_eval: env_flag_enabled("MORPHZ_CODING_EVAL_MODE"),
        }
    }
}

pub struct MorphzRuntimeBuilder {
    config: AppConfig,
    client: Arc<dyn Client>,
    database_path: Option<String>,
    store: Option<Arc<dyn RuntimeStore>>,
    storage_label: Option<String>,
    identity: RuntimeIdentity,
    tool_policy: RuntimeToolPolicy,
    approval_provider: Option<Arc<dyn ApprovalProvider>>,
    identity_provider: Option<Arc<dyn IdentityProvider>>,
    secret_store: Option<Arc<SecretStore>>,
    execution_target_backends: Vec<Arc<dyn crate::execution_target::ExecutionTargetBackend>>,
    harness_packages: Vec<HarnessPackage>,
}

impl MorphzRuntimeBuilder {
    pub fn new(config: AppConfig, client: Arc<dyn Client>) -> Self {
        Self {
            database_path: None,
            store: None,
            storage_label: None,
            identity: RuntimeIdentity::default(),
            tool_policy: RuntimeToolPolicy::from_environment(),
            approval_provider: None,
            identity_provider: None,
            secret_store: None,
            execution_target_backends: Vec::new(),
            harness_packages: Vec::new(),
            config,
            client,
        }
    }

    pub fn database_path(mut self, path: impl Into<String>) -> Self {
        self.database_path = Some(path.into());
        self
    }

    /// Inject one complete durable authority. The label is safe operator-facing
    /// identity (for example `postgres:production`), never a credential URL.
    pub fn store(mut self, label: impl Into<String>, store: Arc<dyn RuntimeStore>) -> Self {
        self.store = Some(store);
        self.storage_label = Some(label.into());
        self
    }

    pub fn identity(mut self, identity: RuntimeIdentity) -> Self {
        self.identity = identity;
        self
    }

    pub fn tool_policy(mut self, policy: RuntimeToolPolicy) -> Self {
        self.tool_policy = policy;
        self
    }

    pub fn approval_provider(mut self, provider: Arc<dyn ApprovalProvider>) -> Self {
        self.approval_provider = Some(provider);
        self
    }

    pub fn identity_provider(mut self, provider: Arc<dyn IdentityProvider>) -> Self {
        self.identity_provider = Some(provider);
        self
    }

    /// Injects a secret authority. Public services and Edge hosts can provide
    /// Vault/KMS/target-local backends without changing the tool or HTTP API.
    pub fn secret_store(mut self, secret_store: Arc<SecretStore>) -> Self {
        self.secret_store = Some(secret_store);
        self
    }

    /// Adds a physical execution transport without coupling the SDK or model
    /// tool surface to its implementation (Edge Node, managed SSH, cloud
    /// worker, and so on).
    pub fn execution_target_backend(
        mut self,
        backend: Arc<dyn crate::execution_target::ExecutionTargetBackend>,
    ) -> Self {
        self.execution_target_backends.push(backend);
        self
    }

    /// Installs one normalized `.hns` package into the Runtime catalog during
    /// build. Registration is exact-version and content-addressed; a different
    /// artifact may not reuse an existing `(id, version)`.
    pub fn harness_package(mut self, package: HarnessPackage) -> Self {
        self.harness_packages.push(package);
        self
    }

    pub async fn build(self) -> Result<MorphzRuntime, RuntimeError> {
        let database_path = self
            .database_path
            .unwrap_or_else(|| self.config.storage.sqlite.path.clone());
        let mut permission_config = self.config.permissions.clone();
        if self.store.is_none()
            && self.config.storage.backend == StorageBackend::Sqlite
            && database_path != ":memory:"
        {
            let database_path = absolute_runtime_path(&database_path);
            for protected in [
                database_path.clone(),
                PathBuf::from(format!("{}-wal", database_path.to_string_lossy())),
                PathBuf::from(format!("{}-shm", database_path.to_string_lossy())),
            ] {
                let protected = protected.to_string_lossy().into_owned();
                if !permission_config.protected_paths.contains(&protected) {
                    permission_config.protected_paths.push(protected);
                }
            }
        }
        let identity_provider = self.identity_provider.unwrap_or_else(|| {
            Arc::new(StaticIdentityProvider::new(PrincipalAssertion {
                principal_id: self.identity.principal_id.clone(),
                provider_id: RUNTIME_DEFAULT_IDENTITY_PROVIDER_ID.to_string(),
                assurance: "local-process".to_string(),
                display_name: None,
            })) as Arc<dyn IdentityProvider>
        });
        let secret_store = match self.secret_store {
            Some(secret_store) => secret_store,
            None => Arc::new(SecretStore::native_default()?),
        };
        let bus = Arc::new(InMemoryEventBus::with_concurrency_limit(
            self.config.orchestrator.event_bus.max_in_flight,
        ));
        let (store, sqlite_database_path, storage_label): (
            Arc<dyn RuntimeStore>,
            Option<String>,
            String,
        ) = match self.store {
            Some(store) => (
                store,
                None,
                self.storage_label
                    .unwrap_or_else(|| "injected-runtime-store".to_string()),
            ),
            None => match self.config.storage.backend {
                StorageBackend::Sqlite => (
                    Arc::new(
                        SqliteStore::new_with_config(&database_path, &self.config.storage.sqlite)
                            .await?,
                    ),
                    Some(database_path.clone()),
                    format!("sqlite:{database_path}"),
                ),
                StorageBackend::Postgres => {
                    let url_env = self.config.storage.postgres.url_env.trim();
                    if url_env.is_empty() {
                        return Err("storage.postgres.url_env 不能为空".into());
                    }
                    let database_url = std::env::var(url_env).map_err(|_| {
                        format!(
                            "已选择 PostgreSQL Storage，但环境变量 '{url_env}' 不存在或不是有效 Unicode"
                        )
                    })?;
                    let store = PostgresStore::new(
                        &database_url,
                        self.config.storage.postgres.max_connections,
                    )
                    .await?;
                    (Arc::new(store), None, format!("postgres:env:{url_env}"))
                }
            },
        };
        let harness_registry = Arc::new(DomainHarnessRegistry::default());
        for package in load_persisted_harness_packages(store.as_ref()).await? {
            harness_registry.register_package(package)?;
        }
        for package in self.harness_packages {
            persist_harness_package(store.as_ref(), &package).await?;
            harness_registry.register_package(package)?;
        }
        let model_context_capacity = Arc::new(RwLock::new(resolve_model_context_capacity(
            &self.config,
            &self.config.llm.model,
        )));
        let context_engine = Arc::new(
            ContextEngine::new(
                Arc::clone(&store) as Arc<dyn EventStore>,
                self.config.orchestrator.clone(),
            )
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>)
            .with_model_context_capacity(Arc::clone(&model_context_capacity))
            .with_mind_projection_store(Arc::clone(&store) as Arc<dyn MindProjectionStore>)
            .with_session_projection_store(
                Arc::clone(&store) as Arc<dyn crate::memory::SessionProjectionStore>
            )
            .with_recall_projection_store(Arc::clone(&store) as Arc<dyn RecallProjectionStore>)
            .with_cognitive_clock_store(
                Arc::clone(&store) as Arc<dyn crate::memory::CognitiveClockStore>
            )
            .with_objective_store(Arc::clone(&store) as Arc<dyn ObjectiveStore>)
            .with_execution_target_store(
                Arc::clone(&store) as Arc<dyn crate::memory::ExecutionTargetStore>
            )
            .with_execution_target_authorization_store(
                Arc::clone(&store) as Arc<dyn crate::memory::ExecutionTargetAuthorizationStore>
            )
            .with_worker_coordination_mode(store.worker_coordination_mode()),
        );
        let execution_jobs = Arc::new(ExecutionJobManager::new(
            Arc::clone(&store) as Arc<dyn ExecutionJobStore>
        ));
        let human_approval_hub = HumanApprovalHub::default();
        let permission_profile = Arc::new(PermissionProfile::from_config(&permission_config)?);
        if permission_profile.sandbox_mode == SandboxMode::DangerFullAccess {
            tracing::warn!("完全访问权限已启用：文件工具与 Shell 均不受工作区或操作系统沙箱限制");
        }
        let approval_provider = match self.approval_provider {
            Some(provider) => provider,
            None => {
                let human_review: Arc<dyn ApprovalProvider> = Arc::new(HumanApprovalProvider::new(
                    human_approval_hub.clone(),
                    Arc::clone(&store) as Arc<dyn ApprovalStore>,
                ));
                match permission_profile.reviewer {
                    ReviewerKind::AutoReview => Arc::new(EscalatingApprovalProvider::new(
                        Arc::new(AiAutoReviewProvider::new(
                            Arc::clone(&self.client),
                            Arc::clone(&store) as Arc<dyn EventStore>,
                        )),
                        human_review,
                    )) as Arc<dyn ApprovalProvider>,
                    ReviewerKind::User => human_review,
                    ReviewerKind::Deny => Arc::new(DenyAllApprovalProvider::new(
                        "当前权限 Profile 禁止边界外能力申请",
                    )),
                }
            }
        };
        let permissions = Arc::new(PermissionBroker::new(permission_profile, approval_provider));
        // Evaluation leases are failure detectors, not model/tool wall-clock
        // budgets. Healthy long-running work renews this short lease; a dead
        // worker must not strand an Objective for the model hard timeout.
        let objective_lease_secs = self
            .config
            .orchestrator
            .objective_evaluation_lease_secs
            .max(3);
        let objective_evaluations = Arc::new(ObjectiveEvaluationRegistry::default());
        let timer_engine = Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>));
        let scheduler_kernel = Arc::new(SchedulerKernel::new(
            Arc::clone(&store) as Arc<dyn RuntimeStore>
        ));
        let objective_supervisor = Arc::new(
            ObjectiveSupervisor::new(
                Arc::clone(&store) as Arc<dyn ObjectiveStore>,
                Arc::clone(&store) as Arc<dyn EventStore>,
                Arc::clone(&bus),
                Arc::clone(&objective_evaluations),
                Arc::clone(&timer_engine),
                std::time::Duration::from_secs(objective_lease_secs),
            )
            .with_execution_job_store(Arc::clone(&store) as Arc<dyn ExecutionJobStore>)
            .with_delegation_store(Arc::clone(&store) as Arc<dyn crate::memory::DelegationStore>)
            .with_thread_group_store(Arc::clone(&store) as Arc<dyn crate::memory::ThreadGroupStore>)
            .with_activation_store(Arc::clone(&store) as Arc<dyn crate::memory::ActivationStore>)
            .with_scheduler_dependency_store(
                Arc::clone(&store) as Arc<dyn crate::scheduler::SchedulerDependencyStore>
            )
            .with_scheduler_kernel(Arc::clone(&scheduler_kernel)),
        );
        objective_supervisor.register_timer_handlers()?;
        let registry = Arc::new(Registry::new());
        let thread_scheduler = Arc::new(ThreadScheduler::new(
            Arc::clone(&bus),
            Arc::clone(&store) as Arc<dyn SessionStore>,
            Arc::clone(&store) as Arc<dyn EventStore>,
            Arc::clone(&timer_engine),
        ));
        thread_scheduler.register_timer_handler()?;
        let background_scheduler = Arc::new(BackgroundTaskScheduler::new_with_execution_jobs(
            Arc::clone(&bus),
            Arc::clone(&store) as Arc<dyn EventStore>,
            Arc::clone(&timer_engine),
            Arc::clone(&execution_jobs),
        ));
        background_scheduler.register_timer_handler()?;
        register_default_tools(DefaultToolDependencies {
            registry: &registry,
            context_engine: &context_engine,
            objective_supervisor: &objective_supervisor,
            objective_evaluations: &objective_evaluations,
            harness_registry: &harness_registry,
            event_store: &(Arc::clone(&store) as Arc<dyn EventStore>),
            permissions: &permissions,
            bus: &bus,
            thread_scheduler: &thread_scheduler,
            scheduler_kernel: &scheduler_kernel,
            background_scheduler: &background_scheduler,
            secret_store: &secret_store,
            config: &self.config,
            policy: self.tool_policy,
        });
        registry.register(Arc::new(crate::execution_target::ListTargetsTool::new(
            Arc::clone(&store) as Arc<dyn ExecutionTargetStore>,
        )));
        registry.register(Arc::new(crate::execution_target::InspectTargetTool::new(
            Arc::clone(&store) as Arc<dyn ExecutionTargetStore>,
        )));
        let runtime_managed_ssh_endpoints = Arc::new(std::sync::RwLock::new(HashMap::new()));
        let runtime_managed_ssh_provisioner =
            crate::execution_target::RuntimeManagedSshProvisioner::new(
                Arc::clone(&store) as Arc<dyn ExecutionTargetStore>,
                Arc::clone(&runtime_managed_ssh_endpoints),
                self.identity.principal_id.clone(),
                permissions.policy_digest(),
            );
        registry.register(Arc::new(
            crate::execution_target::ResolveTargetTool::new(
                Arc::clone(&store) as Arc<dyn ExecutionTargetStore>
            )
            .with_runtime_managed_ssh(runtime_managed_ssh_provisioner.clone()),
        ));
        let workspace_root = permissions
            .profile()
            .workspace_root
            .to_str()
            .map(str::to_string);
        store
            .register_execution_target(crate::execution_target::local_default_registration(
                workspace_root,
                registry.physical_tool_names(),
                permissions.policy_digest(),
            ))
            .await?;
        let mut runtime_managed_ssh_target_ids = HashSet::new();
        for target_config in &self.config.managed_ssh.targets {
            if !runtime_managed_ssh_target_ids.insert(target_config.id.trim().to_string()) {
                return Err(
                    format!("Runtime Managed SSH Target id '{}' 重复", target_config.id).into(),
                );
            }
            let endpoint =
                crate::execution_target::ManagedSshEndpoint::load(&target_config.endpoint_ref)?;
            if endpoint.destination.is_none() {
                permissions
                    .profile()
                    .canonical_permission_root(&endpoint.known_hosts_file.to_string_lossy())
                    .map_err(|error| {
                        format!(
                            "Runtime Managed SSH Target '{}' 的 known_hosts_file 不可授权：{error}",
                            target_config.id
                        )
                    })?;
            }
            let registration = crate::execution_target::runtime_managed_ssh_registration(
                target_config,
                &endpoint,
                &self.identity.principal_id,
                &permissions.policy_digest(),
            )?;
            store.register_execution_target(registration).await?;
            runtime_managed_ssh_endpoints
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .entry(target_config.endpoint_ref.clone())
                .or_insert(endpoint);
        }
        for durable_target in store
            .list_execution_targets(ExecutionTargetFilter {
                limit: Some(10_000),
                ..Default::default()
            })
            .await?
            .into_iter()
            .filter(|target| {
                target.kind == crate::memory::ExecutionTargetKind::ManagedSsh
                    && target.provider_node_id.is_none()
                    && target
                        .metadata
                        .get("execution_location")
                        .and_then(Value::as_str)
                        == Some("runtime")
                    && !runtime_managed_ssh_target_ids.contains(&target.id)
                    && target.status != ExecutionTargetStatus::Disabled
            })
        {
            match runtime_managed_ssh_provisioner
                .rehydrate(&durable_target)
                .await
            {
                Ok(target) => {
                    tracing::debug!(
                        target_id = %target.id,
                        host = ?target.metadata.get("host"),
                        "Runtime Managed SSH 按需路由已从持久 Target 重建"
                    );
                }
                Err(error) => {
                    if durable_target.status == ExecutionTargetStatus::Online {
                        let _ = store
                            .set_execution_target_status(
                                &durable_target.id,
                                durable_target.revision,
                                ExecutionTargetStatus::Offline,
                            )
                            .await?;
                    }
                    tracing::warn!(
                        target_id = %durable_target.id,
                        error = %error,
                        "Runtime Managed SSH 路由暂未重建；远端主机在线状态未知，可稍后通过 resolve_target(target_id) 重试"
                    );
                }
            }
        }
        let execution_targets = Arc::new(crate::execution_target::ExecutionTargetDispatcher::new(
            Arc::clone(&store) as Arc<dyn ExecutionTargetStore>,
            Arc::clone(&store) as Arc<dyn crate::memory::ExecutionTargetAuthorizationStore>,
        ));
        execution_targets
            .register_backend(Arc::new(crate::execution_target::InProcessLocalBackend));
        let edge_backend = Arc::new(crate::execution_target::EdgeNodeBackend::new(
            Arc::clone(&store) as Arc<dyn crate::memory::EdgeExecutionStore>,
        ));
        execution_targets
            .register_backend(Arc::clone(&edge_backend)
                as Arc<dyn crate::execution_target::ExecutionTargetBackend>);
        execution_targets.register_artifact_transfer_backend(edge_backend);
        execution_targets.register_artifact_transfer_backend(Arc::new(
            crate::execution_target::EdgeProxyArtifactTransferBackend::new(
                Arc::clone(&store) as Arc<dyn crate::memory::EdgeExecutionStore>
            ),
        ));
        let artifact_transfer_stages = crate::artifact::ArtifactTransferStageStore::new(
            self.config.background_task.artifact_dir.clone(),
        );
        let managed_ssh_backend = Arc::new(crate::execution_target::ManagedSshBackend::new(
            Arc::clone(&store) as Arc<dyn crate::memory::EdgeExecutionStore>,
            Arc::clone(&runtime_managed_ssh_endpoints),
            artifact_transfer_stages.clone(),
            Arc::clone(&permissions),
            permissions.policy_digest(),
            !permissions.profile().full_access(),
        ));
        execution_targets.register_backend(Arc::clone(&managed_ssh_backend)
            as Arc<dyn crate::execution_target::ExecutionTargetBackend>);
        execution_targets.register_artifact_transfer_backend(managed_ssh_backend);
        execution_targets.register_artifact_transfer_backend(Arc::new(
            crate::execution_target::RuntimeEdgeArtifactTransferBackend::new(
                Arc::clone(&store) as Arc<dyn crate::memory::EdgeExecutionStore>,
                Arc::clone(&store) as Arc<dyn crate::memory::ExecutionJobStore>,
                artifact_transfer_stages.clone(),
                Arc::clone(&permissions),
            ),
        ));
        execution_targets.register_artifact_transfer_backend(Arc::new(
            crate::execution_target::EdgeRelayArtifactTransferBackend::new(
                Arc::clone(&store) as Arc<dyn crate::memory::EdgeExecutionStore>,
                Arc::clone(&store) as Arc<dyn crate::memory::ExecutionJobStore>,
                artifact_transfer_stages.clone(),
            ),
        ));
        for backend in self.execution_target_backends {
            execution_targets.register_backend(backend);
        }
        let runtime_client = Arc::clone(&self.client);
        let message_attachment_root = PathBuf::from(&self.config.background_task.artifact_dir);
        let message_attachment_root = if message_attachment_root.is_absolute() {
            message_attachment_root
        } else {
            std::env::current_dir()?.join(message_attachment_root)
        };
        let orchestrator = Orchestrator::assemble_with_scheduler_kernel(
            Arc::clone(&bus),
            Arc::clone(&store) as Arc<dyn EventStore>,
            Some(Arc::clone(&store) as Arc<dyn RuntimeStore>),
            Some(Arc::clone(&scheduler_kernel)),
            self.client,
            Arc::clone(&registry),
            self.config.orchestrator.clone(),
            Arc::clone(&context_engine),
            objective_evaluations,
            Some(Arc::clone(&objective_supervisor)),
            Arc::clone(&timer_engine),
            Some(Arc::clone(&thread_scheduler)),
            Some(Arc::clone(&execution_jobs)),
            Some(Arc::clone(&execution_targets)),
            Some(Arc::clone(&store) as Arc<dyn crate::memory::ActionGroupStore>),
            Some(Arc::clone(&background_scheduler)),
            Some(DurableApprovalServices::new(
                Arc::clone(&permissions),
                Arc::clone(&store) as Arc<dyn ApprovalStore>,
                Arc::clone(&store) as Arc<dyn ExecutionApprovalStore>,
                Arc::clone(&store) as Arc<dyn crate::memory::CapabilityLeaseStore>,
                human_approval_hub.clone(),
                self.config.edge_execution.capability_leases_enabled,
                self.config.edge_execution.capability_lease_ttl.as_secs(),
            )),
            Some(Arc::clone(&harness_registry)),
            message_attachment_root,
        )?;
        Ok(MorphzRuntime {
            inner: Arc::new(RuntimeInner {
                config: self.config,
                identity: self.identity,
                identity_provider,
                permissions,
                sqlite_database_path,
                storage_label,
                client: runtime_client,
                bus,
                store,
                registry,
                harness_registry,
                model_context_capacity,
                context_engine,
                orchestrator,
                objective_supervisor,
                thread_scheduler,
                scheduler_kernel,
                execution_jobs,
                execution_targets,
                artifact_transfer_stages,
                background_scheduler,
                secret_store,
                timer_engine,
                human_approval_hub,
                process_started_at: chrono::Utc::now(),
                recovery: std::sync::RwLock::new(RuntimeRecoveryStatus::default()),
                started: AtomicBool::new(false),
                start_lock: tokio::sync::Mutex::new(()),
            }),
        })
    }
}

struct DefaultToolDependencies<'a> {
    registry: &'a Arc<Registry>,
    context_engine: &'a Arc<ContextEngine>,
    objective_supervisor: &'a Arc<ObjectiveSupervisor>,
    objective_evaluations: &'a Arc<ObjectiveEvaluationRegistry>,
    harness_registry: &'a Arc<DomainHarnessRegistry>,
    event_store: &'a Arc<dyn EventStore>,
    permissions: &'a Arc<PermissionBroker>,
    bus: &'a Arc<InMemoryEventBus>,
    thread_scheduler: &'a Arc<ThreadScheduler>,
    scheduler_kernel: &'a Arc<SchedulerKernel>,
    background_scheduler: &'a Arc<BackgroundTaskScheduler>,
    secret_store: &'a Arc<SecretStore>,
    config: &'a AppConfig,
    policy: RuntimeToolPolicy,
}

fn register_default_tools(dependencies: DefaultToolDependencies<'_>) {
    let DefaultToolDependencies {
        registry,
        context_engine,
        objective_supervisor,
        objective_evaluations,
        harness_registry,
        event_store,
        permissions,
        bus,
        thread_scheduler,
        scheduler_kernel,
        background_scheduler,
        secret_store,
        config,
        policy,
    } = dependencies;
    registry.register(Arc::new(ContextTxTool::new(Arc::clone(context_engine))));
    // The evaluator reaches other tools through the same Registry it is
    // registered in, so it is constructed with a handle to it rather than with
    // a private tool table that could drift.
    registry.register(Arc::new(crate::sexpr_eval::EvalTool::new(
        Arc::clone(registry),
        config.orchestrator.eval_callable_tools.clone(),
    )));
    registry.register(Arc::new(HarnessListTool::new(Arc::clone(harness_registry))));
    registry.register(Arc::new(HarnessSelectTool::new(
        Arc::clone(harness_registry),
        Arc::clone(event_store),
        Arc::clone(objective_evaluations),
    )));
    registry.register(Arc::new(ObjectiveCreateTool::new(
        Arc::clone(objective_supervisor),
        Arc::clone(context_engine),
        Arc::clone(harness_registry),
    )));
    registry.register(Arc::new(ObjectiveUpdateTool::new(
        Arc::clone(objective_supervisor),
        Arc::clone(context_engine),
    )));
    registry.register(Arc::new(SendMessageTool::new(
        Arc::clone(bus),
        context_engine
            .session_store()
            .expect("Runtime ContextEngine 必须配置 SessionStore"),
    )));
    registry.register(Arc::new(
        ScheduleTxTool::new(
            Arc::clone(thread_scheduler),
            context_engine
                .session_store()
                .expect("Runtime ContextEngine 必须配置 SessionStore"),
        )
        .with_objective_store(objective_supervisor.store())
        .with_scheduler_kernel(Arc::clone(scheduler_kernel)),
    ));
    registry.register(Arc::new(VerifyIdentityTool::new(
        context_engine
            .session_store()
            .expect("Runtime ContextEngine 必须配置 SessionStore"),
    )));
    registry.register(Arc::new(ListSecretsTool::new(Arc::clone(secret_store))));
    if policy.context_only {
        return;
    }
    registry.register(Arc::new(WriteFileTool::new_with_runtime(
        Arc::clone(permissions),
        Arc::clone(bus),
    )));
    registry.register(Arc::new(ReadFileTool::new_with_permissions(Arc::clone(
        permissions,
    ))));
    registry.register(Arc::new(EditFileTool::new_with_runtime(
        Arc::clone(permissions),
        Arc::clone(bus),
    )));
    registry.register(Arc::new(ListFilesTool::new_with_permissions(Arc::clone(
        permissions,
    ))));
    registry.register(Arc::new(SearchTool::new_with_permissions(Arc::clone(
        permissions,
    ))));
    registry.register(Arc::new(crate::artifact::TransferTool::new(Arc::clone(
        permissions,
    ))));
    registry.register(Arc::new(RecallTool::new(Arc::clone(context_engine))));
    registry.register(Arc::new(
        ExecuteCommandTool::new_with_permissions_scheduler_and_secret_store(
            Arc::clone(bus),
            Arc::new(config.background_task.clone()),
            Arc::clone(permissions),
            config.orchestrator.tool_timeout_secs,
            Some(Arc::clone(background_scheduler)),
            Arc::clone(secret_store),
        ),
    ));
    registry.register(Arc::new(ListTasksTool::new(Arc::clone(
        background_scheduler,
    ))));
    registry.register(Arc::new(TaskStatusTool::new(Arc::clone(
        background_scheduler,
    ))));
    let task_check: Arc<dyn crate::tool::Tool> = Arc::new(CheckTaskAfterTool::new(
        Arc::clone(background_scheduler),
        config.background_task.timeout_notify_secs,
    ));
    registry.register(Arc::clone(&task_check));
    registry.register_alias("wait_task", task_check);
    registry.register(Arc::new(KillTaskTool::new(Arc::clone(
        background_scheduler,
    ))));
    if !policy.coding_eval {
        registry.register(Arc::new(DelegateTool::new(Arc::clone(bus))));
        registry.register(Arc::new(ListSkillsTool));
    }
}

struct RuntimeInner {
    config: AppConfig,
    identity: RuntimeIdentity,
    identity_provider: Arc<dyn IdentityProvider>,
    permissions: Arc<PermissionBroker>,
    sqlite_database_path: Option<String>,
    storage_label: String,
    client: Arc<dyn Client>,
    bus: Arc<InMemoryEventBus>,
    store: Arc<dyn RuntimeStore>,
    registry: Arc<Registry>,
    harness_registry: Arc<DomainHarnessRegistry>,
    model_context_capacity: Arc<RwLock<ModelContextCapacity>>,
    context_engine: Arc<ContextEngine>,
    orchestrator: Arc<Orchestrator>,
    objective_supervisor: Arc<ObjectiveSupervisor>,
    thread_scheduler: Arc<ThreadScheduler>,
    scheduler_kernel: Arc<SchedulerKernel>,
    execution_jobs: Arc<ExecutionJobManager<dyn ExecutionJobStore>>,
    execution_targets: Arc<crate::execution_target::ExecutionTargetDispatcher>,
    artifact_transfer_stages: crate::artifact::ArtifactTransferStageStore,
    background_scheduler: Arc<BackgroundTaskScheduler>,
    secret_store: Arc<SecretStore>,
    timer_engine: Arc<TimerEngine>,
    human_approval_hub: HumanApprovalHub,
    process_started_at: chrono::DateTime<chrono::Utc>,
    recovery: std::sync::RwLock<RuntimeRecoveryStatus>,
    started: AtomicBool,
    start_lock: tokio::sync::Mutex<()>,
}

#[derive(Clone)]
pub struct MorphzRuntime {
    inner: Arc<RuntimeInner>,
}

impl MorphzRuntime {
    pub fn builder(config: AppConfig, client: Arc<dyn Client>) -> MorphzRuntimeBuilder {
        MorphzRuntimeBuilder::new(config, client)
    }

    pub async fn start(&self) -> Result<(), RuntimeError> {
        let _guard = self.inner.start_lock.lock().await;
        if self.inner.started.load(Ordering::Acquire) {
            return Ok(());
        }
        self.ensure_principal(PrincipalAssertion {
            principal_id: self.inner.identity.principal_id.clone(),
            provider_id: RUNTIME_DEFAULT_IDENTITY_PROVIDER_ID.to_string(),
            assurance: "runtime-default".to_string(),
            display_name: None,
        })
        .await?;
        if self
            .inner
            .store
            .get_agent(&self.inner.identity.agent_id)
            .await?
            .is_none()
        {
            self.inner
                .store
                .ensure_agent(NewAgent {
                    id: self.inner.identity.agent_id.clone(),
                    title: "默认 Agent".to_string(),
                    root_context_id: self.inner.identity.context_id.clone(),
                })
                .await?;
        }
        self.inner
            .store
            .ensure_context(NewCognitiveContext {
                id: self.inner.identity.context_id.clone(),
                agent_id: self.inner.identity.agent_id.clone(),
                title: "默认认知 Context".to_string(),
            })
            .await?;
        for session in self.inner.store.list_sessions(true).await? {
            self.inner
                .orchestrator
                .register_session_context(&session.id, &session.context_id);
        }
        let execution_recovery = self
            .inner
            .execution_jobs
            .reconcile_startup(
                self.inner.store.worker_coordination_mode(),
                self.inner.store.as_ref(),
            )
            .await?;
        let recovered_background_outboxes = self
            .inner
            .background_scheduler
            .recover_terminal_background_outboxes()
            .await?;
        if let Ok(mut recovery) = self.inner.recovery.write() {
            *recovery = RuntimeRecoveryStatus {
                preserved_execution_jobs: execution_recovery.preserved_job_ids.len(),
                recovered_execution_jobs: execution_recovery.recovered_receipts.len(),
                requeued_execution_jobs: execution_recovery.requeue_receipts.len(),
                lost_execution_jobs: execution_recovery.lost_receipts.len(),
                recovered_background_outboxes,
                completed_at: Some(chrono::Utc::now()),
            };
        }
        tracing::info!(
            preserved = execution_recovery.preserved_job_ids.len(),
            recovered = execution_recovery.recovered_receipts.len(),
            requeued = execution_recovery.requeue_receipts.len(),
            lost = execution_recovery.lost_receipts.len(),
            recovered_background_outboxes,
            "Execution Job 启动恢复完成"
        );
        let artifact_transfer_records = self
            .inner
            .store
            .list_execution_jobs(ExecutionJobFilter {
                include_terminal: false,
                newest_first: false,
                limit: Some(10_000),
                ..Default::default()
            })
            .await?
            .into_iter()
            .filter(|job| job.tool_name == ARTIFACT_TRANSFER_TOOL_NAME)
            .collect::<Vec<_>>();
        // A non-terminal relay parent may already have a succeeded source
        // leg.  The source leg's uploaded stage is still required by the
        // destination leg, even though that child Job is terminal.  Retain
        // deterministic relay-leg stages with their parent so restart GC
        // cannot delete bytes that are between physical hops.
        let mut active_stage_job_ids = artifact_transfer_records
            .iter()
            .map(|job| job.id.clone())
            .collect::<Vec<_>>();
        for job in &artifact_transfer_records {
            if !job.tool_call_id.ends_with(":source") && !job.tool_call_id.ends_with(":destination")
            {
                active_stage_job_ids.extend(
                    ["source", "destination"].map(|leg| {
                        crate::artifact::artifact_transfer_relay_leg_job_id(&job.id, leg)
                    }),
                );
            }
        }
        match self
            .inner
            .artifact_transfer_stages
            .cleanup_except(active_stage_job_ids.iter().map(String::as_str))
            .await
        {
            Ok(removed) if removed > 0 => {
                tracing::info!(removed, "Artifact Transfer 终态 stage 清理完成")
            }
            Ok(_) => {}
            Err(error) => tracing::warn!(%error, "Artifact Transfer stage 启动清理失败"),
        }
        let artifact_transfer_jobs = artifact_transfer_records
            .into_iter()
            .filter(|job| job.status == ExecutionJobStatus::Queued)
            .map(|job| job.id)
            .collect::<Vec<_>>();
        Arc::clone(&self.inner.orchestrator).start().await?;
        Arc::clone(&self.inner.objective_supervisor).start().await?;
        self.inner.thread_scheduler.recover().await?;
        self.inner.timer_engine.start();
        for job_id in artifact_transfer_jobs {
            self.spawn_artifact_transfer_job(job_id);
        }
        let recall_store = Arc::clone(&self.inner.store);
        let recall_worker_id = format!(
            "recall-projector:{}:{}",
            std::process::id(),
            self.inner.process_started_at.timestamp_micros()
        );
        tokio::spawn(async move {
            const BATCH_SIZE: usize = 4;
            loop {
                match recall_store
                    .project_recall_outbox_batch(&recall_worker_id, BATCH_SIZE)
                    .await
                {
                    Ok(batch) if batch.claimed == BATCH_SIZE => {
                        // A full batch proves that a backlog exists. A mere
                        // `yield_now` can schedule this worker again
                        // immediately, allowing a rebuildable Recall
                        // Projection to repeatedly reclaim SQLite's
                        // single-writer slot ahead of Ledger/Timer/Execution
                        // commits. Keep throughput high while giving the
                        // authoritative control plane a deterministic window.
                        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                    }
                    Ok(_) => tokio::time::sleep(std::time::Duration::from_millis(250)).await,
                    Err(error) => {
                        tracing::warn!(%error, "Recall Projection background batch failed");
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    }
                }
            }
        });
        let edge_store = Arc::clone(&self.inner.store);
        let reconcile_interval = std::time::Duration::from_secs(
            self.inner
                .config
                .edge_execution
                .reconcile_interval
                .as_secs()
                .max(1),
        );
        let node_stale_after = self
            .inner
            .config
            .edge_execution
            .node_stale_after
            .as_secs()
            .max(1);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(reconcile_interval);
            // Do not classify a freshly started Node before it has one full
            // heartbeat window to reconnect.
            ticker.tick().await;
            loop {
                ticker.tick().await;
                let now = chrono::Utc::now();
                let stale_before = now
                    - chrono::Duration::seconds(
                        i64::try_from(node_stale_after).unwrap_or(i64::MAX),
                    );
                match edge_store.reconcile_edge_execution(now, stale_before).await {
                    Ok(report) if report != crate::memory::EdgeReconciliationReport::default() => {
                        tracing::info!(
                            nodes_offline = report.nodes_marked_offline,
                            targets_offline = report.targets_marked_offline,
                            commands_requeued = report.commands_requeued,
                            commands_lost = report.commands_marked_lost,
                            "Edge execution reconciliation completed"
                        );
                    }
                    Ok(_) => {}
                    Err(error) => tracing::warn!(%error, "Edge execution reconciliation failed"),
                }
            }
        });
        self.inner.started.store(true, Ordering::Release);
        Ok(())
    }

    pub fn config(&self) -> &AppConfig {
        &self.inner.config
    }

    pub fn artifact_transfer_stages(&self) -> &crate::artifact::ArtifactTransferStageStore {
        &self.inner.artifact_transfer_stages
    }

    pub fn identity(&self) -> &RuntimeIdentity {
        &self.inner.identity
    }

    pub fn secret_backend_id(&self) -> &str {
        self.inner.secret_store.backend_id()
    }

    pub fn secret_backend_statuses(&self) -> Vec<SecretBackendStatus> {
        self.inner.secret_store.backend_statuses()
    }

    pub fn secret_import_candidates(&self) -> Result<Vec<SecretImportCandidate>, RuntimeError> {
        self.inner
            .secret_store
            .import_candidates()
            .map_err(Into::into)
    }

    pub fn recent_secret_usage(
        &self,
        limit: usize,
    ) -> Result<Vec<SecretUseAuditRecord>, RuntimeError> {
        self.inner
            .secret_store
            .recent_usage(limit)
            .map_err(Into::into)
    }

    pub fn list_managed_secrets(&self) -> Result<Vec<ManagedSecret>, RuntimeError> {
        self.inner.secret_store.list().map_err(Into::into)
    }

    pub fn put_managed_secret(
        &self,
        name: &str,
        value: &str,
        scope_kind: SecretScopeKind,
        scope_id: Option<String>,
    ) -> Result<ManagedSecret, RuntimeError> {
        self.inner
            .secret_store
            .put(name, value, scope_kind, scope_id)
            .map_err(Into::into)
    }

    pub fn put_managed_secret_with_backend(
        &self,
        name: &str,
        value: &str,
        scope_kind: SecretScopeKind,
        scope_id: Option<String>,
        value_backend: &str,
    ) -> Result<ManagedSecret, RuntimeError> {
        self.inner
            .secret_store
            .put_with_backend(name, value, scope_kind, scope_id, value_backend)
            .map_err(Into::into)
    }

    pub fn import_managed_secret(
        &self,
        name: &str,
        scope_kind: SecretScopeKind,
        scope_id: Option<String>,
        value_backend: &str,
    ) -> Result<ManagedSecret, RuntimeError> {
        self.inner
            .secret_store
            .import(name, scope_kind, scope_id, value_backend)
            .map_err(Into::into)
    }

    pub fn delete_managed_secret(&self, name: &str) -> Result<bool, RuntimeError> {
        self.inner.secret_store.delete(name).map_err(Into::into)
    }

    pub async fn authenticate_identity(
        &self,
        evidence: IdentityEvidence,
    ) -> Result<PrincipalAssertion, RuntimeError> {
        self.inner.identity_provider.authenticate(evidence).await
    }

    pub async fn ensure_principal(
        &self,
        assertion: PrincipalAssertion,
    ) -> Result<crate::memory::PrincipalRecord, RuntimeError> {
        self.inner
            .store
            .ensure_principal(NewPrincipal {
                id: assertion.principal_id,
                provider_id: assertion.provider_id,
                assurance: assertion.assurance,
                display_name: assertion.display_name,
            })
            .await
    }

    pub async fn bind_session_principal(
        &self,
        session_id: &str,
        assertion: PrincipalAssertion,
    ) -> Result<crate::memory::SessionPrincipalBinding, RuntimeError> {
        let principal = self.ensure_principal(assertion).await?;
        self.inner
            .store
            .bind_session_principal(session_id, &principal.id)
            .await
    }

    pub async fn list_session_principals(
        &self,
        session_id: &str,
    ) -> Result<Vec<crate::memory::SessionPrincipalBinding>, RuntimeError> {
        self.inner.store.list_session_principals(session_id).await
    }

    pub async fn bind_all_sessions_to_principal(
        &self,
        assertion: PrincipalAssertion,
        include_archived: bool,
    ) -> Result<usize, RuntimeError> {
        let principal = self.ensure_principal(assertion).await?;
        self.inner
            .store
            .bind_all_sessions_to_principal(&principal.id, include_archived)
            .await
    }

    pub async fn list_principal_sessions(
        &self,
        principal_id: &str,
        archived: bool,
    ) -> Result<Vec<SessionRecord>, RuntimeError> {
        self.inner
            .store
            .list_principal_sessions(principal_id, archived)
            .await
    }

    pub async fn search_principals(
        &self,
        query: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<PrincipalDirectoryPage, RuntimeError> {
        self.inner
            .store
            .search_principals(query, cursor, limit)
            .await
    }

    pub async fn verify_session_principal(
        &self,
        session_id: &str,
        principal_id: &str,
    ) -> Result<bool, RuntimeError> {
        self.inner
            .store
            .verify_session_principal(session_id, principal_id)
            .await
    }

    async fn bind_default_principal(
        &self,
        session_id: &str,
    ) -> Result<crate::memory::SessionPrincipalBinding, RuntimeError> {
        self.bind_session_principal(
            session_id,
            PrincipalAssertion {
                principal_id: self.inner.identity.principal_id.clone(),
                provider_id: RUNTIME_DEFAULT_IDENTITY_PROVIDER_ID.to_string(),
                assurance: "runtime-default".to_string(),
                display_name: None,
            },
        )
        .await
    }

    pub async fn inspect_schedule(&self, id: &str) -> Result<Option<ScheduleRecord>, RuntimeError> {
        self.inner.thread_scheduler.inspect(id).await
    }

    pub async fn pause_schedule(
        &self,
        id: &str,
        expected_revision: u64,
    ) -> Result<ScheduleMutation, RuntimeError> {
        self.inner
            .thread_scheduler
            .pause(id, expected_revision)
            .await
    }

    pub async fn resume_schedule(
        &self,
        id: &str,
        expected_revision: u64,
    ) -> Result<ScheduleMutation, RuntimeError> {
        self.inner
            .thread_scheduler
            .resume(id, expected_revision)
            .await
    }

    pub async fn reschedule(
        &self,
        id: &str,
        expected_revision: u64,
        not_before: Option<chrono::DateTime<chrono::Utc>>,
        interval_seconds: Option<u64>,
    ) -> Result<ScheduleMutation, RuntimeError> {
        self.inner
            .thread_scheduler
            .reschedule(id, expected_revision, not_before, interval_seconds)
            .await
    }

    pub async fn cancel_schedule(
        &self,
        id: &str,
        expected_revision: u64,
    ) -> Result<ScheduleMutation, RuntimeError> {
        self.inner
            .thread_scheduler
            .cancel(id, expected_revision)
            .await
    }

    pub fn sqlite_database_path(&self) -> Option<&str> {
        self.inner.sqlite_database_path.as_deref()
    }

    pub fn storage_label(&self) -> &str {
        &self.inner.storage_label
    }

    /// Process-local model reasoning override used by subsequent evaluations.
    /// This is deliberately not persisted when changed through Dashboard.
    pub fn reasoning_effort(&self) -> Option<ReasoningEffort> {
        self.inner.client.reasoning_effort()
    }

    pub fn model(&self) -> String {
        self.inner
            .client
            .model()
            .unwrap_or_else(|| self.inner.config.llm.model.clone())
    }

    pub fn configured_models(&self) -> Vec<String> {
        let mut models = self
            .inner
            .config
            .llm
            .models
            .iter()
            .map(|model| model.trim())
            .filter(|model| !model.is_empty())
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        let configured = self.inner.config.llm.model.trim();
        if !configured.is_empty() && !models.iter().any(|model| model == configured) {
            models.insert(0, configured.to_string());
        }
        models.sort();
        models.dedup();
        models
    }

    pub fn set_model(&self, model: &str) -> Result<(), RuntimeError> {
        let model = model.trim();
        if !self
            .configured_models()
            .iter()
            .any(|allowed| allowed == model)
        {
            return Err(format!("模型 '{model}' 未在 llm.models 中配置，拒绝运行期切换").into());
        }
        self.inner.client.set_model(model)?;
        let capacity = resolve_model_context_capacity(&self.inner.config, model);
        *self
            .inner
            .model_context_capacity
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = capacity;
        Ok(())
    }

    pub async fn context_token_budget(
        &self,
        context_id: &str,
    ) -> Result<ContextTokenBudget, RuntimeError> {
        self.inner
            .context_engine
            .context_token_budget(context_id)
            .await
    }

    pub async fn update_context_token_budget(
        &self,
        context_id: &str,
        requested_hard_token_limit: Option<u64>,
        expected_revision: u64,
    ) -> Result<ContextTokenBudgetUpdate, RuntimeError> {
        let mutation = self
            .inner
            .store
            .update_context_token_budget(context_id, requested_hard_token_limit, expected_revision)
            .await?;
        match mutation {
            ContextTokenBudgetMutation::Updated(_) => Ok(ContextTokenBudgetUpdate::Updated(
                self.context_token_budget(context_id).await?,
            )),
            ContextTokenBudgetMutation::Conflict(_) => Ok(ContextTokenBudgetUpdate::Conflict(
                self.context_token_budget(context_id).await?,
            )),
            ContextTokenBudgetMutation::NotFound => Ok(ContextTokenBudgetUpdate::NotFound),
        }
    }

    pub fn set_reasoning_effort(
        &self,
        effort: Option<ReasoningEffort>,
    ) -> Result<(), RuntimeError> {
        self.inner
            .client
            .set_reasoning_effort(effort)
            .map_err(Into::into)
    }

    pub fn tool_names(&self) -> Vec<String> {
        self.inner
            .registry
            .definitions()
            .iter()
            .map(|definition| definition.name.clone())
            .collect()
    }

    pub fn physical_tool_names(&self) -> Vec<String> {
        self.inner.registry.physical_tool_names()
    }

    pub fn execution_policy_digest(&self) -> String {
        self.inner.permissions.policy_digest()
    }

    pub(crate) fn edge_tool_approval_requirement(
        &self,
        command: &crate::memory::EdgeCommandRecord,
    ) -> Result<Option<ApprovalRequirement>, RuntimeError> {
        let tool = self
            .inner
            .registry
            .get(&command.tool_name)
            .ok_or_else(|| format!("Edge Node 未注册物理工具 '{}'", command.tool_name))?;
        if tool.execution_class() != crate::tool::ToolExecutionClass::PhysicalJob {
            return Err(format!(
                "Edge Node 拒绝审批 Runtime 逻辑工具 '{}'",
                command.tool_name
            )
            .into());
        }
        tool.approval_requirement(&command.arguments)
    }

    /// Invoke the Node-local reviewer. The request is constructed from the
    /// cloud Job's immutable authority scope plus the local Tool preflight;
    /// cloud approval decisions are deliberately not accepted here.
    pub(crate) async fn review_edge_tool_permission(
        &self,
        request: &ApprovalRequest,
    ) -> Result<ApprovalDecision, RuntimeError> {
        self.inner.permissions.review(request).await
    }

    /// Executes one cloud-issued Edge command inside this Runtime's local
    /// permission broker and native sandbox. The Edge transport owns the
    /// durable remote Job; this method deliberately does not create a second
    /// local Execution Job or let the caller bypass Tool classification.
    pub async fn execute_edge_tool(
        &self,
        command: &crate::memory::EdgeCommandRecord,
    ) -> Result<String, RuntimeError> {
        self.execute_edge_tool_with_local_authority(command, false)
            .await
    }

    /// Executes a command whose Provider-local Target configuration is itself
    /// the user's durable authorization for the exact generated boundary
    /// expansion (for example a managed SSH endpoint using ssh-agent). This
    /// never weakens protected paths and never trusts a cloud-provided grant:
    /// the boolean is supplied only by the local Edge control plane after it
    /// reads an explicitly approved local endpoint descriptor.
    pub(crate) async fn execute_edge_tool_with_local_authority(
        &self,
        command: &crate::memory::EdgeCommandRecord,
        provider_local_preauthorized: bool,
    ) -> Result<String, RuntimeError> {
        self.execute_edge_tool_streaming(command, provider_local_preauthorized, None)
            .await
    }

    pub(crate) async fn execute_edge_tool_streaming(
        &self,
        command: &crate::memory::EdgeCommandRecord,
        provider_local_preauthorized: bool,
        output_sink: Option<tokio::sync::mpsc::Sender<crate::tool::ToolOutputChunk>>,
    ) -> Result<String, RuntimeError> {
        let tool = self
            .inner
            .registry
            .get(&command.tool_name)
            .ok_or_else(|| format!("Edge Node 未注册物理工具 '{}'", command.tool_name))?;
        if tool.execution_class() != crate::tool::ToolExecutionClass::PhysicalJob {
            return Err(format!(
                "Edge Node 拒绝执行 Runtime 逻辑工具 '{}'；远程协议只接受物理工具",
                command.tool_name
            )
            .into());
        }
        let node_scope = command.provider_node_id.clone();
        let target_scope = command.target_id.clone();
        let job_scope = command.job_id.clone();
        let principal_scope = Some(self.inner.identity.principal_id.clone());
        let artifact_transfer =
            tool.execution_routing() == crate::tool::ToolExecutionRouting::ArtifactTransfer;
        let runtime = self.clone();
        let durable_grant = if provider_local_preauthorized {
            tool.approval_requirement(&command.arguments)?
                .map(|requirement| crate::permission::DurableApprovalGrant {
                    approval_id: format!("edge-local-authority:{}", command.target_id),
                    grant_id: format!(
                        "edge-local-authority:{}:{}",
                        command.target_id, command.job_id
                    ),
                    policy_digest: self.inner.permissions.policy_digest(),
                    action: requirement.action,
                    requested: requirement.requested,
                })
        } else {
            None
        };
        crate::tool::CURRENT_TOOL_OUTPUT_SINK
            .scope(output_sink, async move {
                crate::tool::CURRENT_PRINCIPAL_ID
                    .scope(principal_scope, async move {
                        crate::permission::CURRENT_DURABLE_APPROVAL
                            .scope(durable_grant, async move {
                                crate::tool::CURRENT_ATTEMPT_ID
                                    .scope(job_scope.clone(), async move {
                                        crate::tool::CURRENT_CONTEXT_ID
                                            .scope(
                                                format!("edge-context:{node_scope}"),
                                                async move {
                                                    crate::tool::CURRENT_SESSION_ID
                                                        .scope(
                                                            format!("edge-session:{target_scope}"),
                                                            async move {
                                                                if artifact_transfer {
                                                                    runtime
                                                                        .execute_edge_artifact_transfer(
                                                                            command,
                                                                        )
                                                                        .await
                                                                } else {
                                                                    tool.execute(&command.arguments)
                                                                        .await
                                                                }
                                                            },
                                                        )
                                                        .await
                                                },
                                            )
                                            .await
                                    })
                                    .await
                            })
                            .await
                    })
                    .await
            })
            .await
    }

    async fn execute_edge_artifact_transfer(
        &self,
        command: &crate::memory::EdgeCommandRecord,
    ) -> Result<String, RuntimeError> {
        let routes: crate::execution_target::ArtifactTransferRouteSnapshot =
            serde_json::from_value(command.route.clone())?;
        let request = crate::artifact::transfer_request_from_tool_arguments(
            &command.arguments,
            format!("transfer:{}", command.job_id),
        )?;
        let scope = crate::execution_target::edge_execution_scope_from_route(&command.route)?;
        let now = chrono::Utc::now();
        let job = crate::memory::ExecutionJobRecord {
            id: command.job_id.clone(),
            revision: command.revision,
            activation_id: command.job_id.clone(),
            thread_id: scope.thread_id,
            agent_id: scope.agent_id,
            context_id: scope.context_id,
            session_id: scope.session_id,
            initiating_principal_id: Some(scope.principal_id),
            target_id: routes.destination.target_id.clone(),
            tool_call_id: command.job_id.clone(),
            tool_name: crate::artifact::ARTIFACT_TRANSFER_TOOL_NAME.to_string(),
            request: serde_json::json!({}),
            status: crate::memory::ExecutionJobStatus::Running,
            retry_safety: crate::memory::ExecutionRetrySafety::Idempotent,
            claimed_by: command.claimed_by.clone(),
            claim_token: command.claim_token.clone(),
            lease_expires_at: command.lease_expires_at,
            heartbeat_at: command.heartbeat_at,
            approval_ref: None,
            side_effect_started_at: command.side_effect_started_at,
            cancel_requested_at: None,
            cancel_reason: None,
            progress_ref: command.progress.clone(),
            result_event_id: None,
            result_refs: Vec::new(),
            error: None,
            exit_code: None,
            created_at: command.created_at,
            started_at: Some(now),
            updated_at: now,
            finished_at: None,
        };
        let receipt = self
            .inner
            .execution_targets
            .execute_edge_artifact_transfer(&job, &routes, &request)
            .await?;
        Ok(serde_json::to_string(&receipt)?)
    }

    pub fn agent(&self, id: impl Into<String>) -> AgentHandle {
        AgentHandle {
            runtime: self.clone(),
            id: id.into(),
        }
    }

    pub fn context(&self, id: impl Into<String>) -> ContextHandle {
        ContextHandle {
            runtime: self.clone(),
            id: id.into(),
        }
    }

    pub fn session(&self, id: impl Into<String>) -> SessionHandle {
        SessionHandle {
            runtime: self.clone(),
            id: id.into(),
        }
    }

    pub async fn ensure_session(&self, session: NewSession) -> Result<SessionHandle, RuntimeError> {
        let id = session.id.clone();
        let session = self.inner.store.ensure_session(session).await?;
        self.bind_default_principal(&session.id).await?;
        self.inner
            .orchestrator
            .register_session_context(&session.id, &session.context_id);
        Ok(self.session(id))
    }

    pub async fn ensure_agent(&self, agent: NewAgent) -> Result<AgentRecord, RuntimeError> {
        self.inner.store.ensure_agent(agent).await
    }

    pub async fn ensure_context(
        &self,
        context: NewCognitiveContext,
    ) -> Result<CognitiveContextRecord, RuntimeError> {
        self.inner.store.ensure_context(context).await
    }

    pub async fn create_agent_bundle(
        &self,
        agent: NewAgent,
        context: NewCognitiveContext,
        session: NewSession,
    ) -> Result<AgentBootstrapRecord, RuntimeError> {
        let bundle = self
            .inner
            .store
            .create_agent_bundle(agent, context, session)
            .await?;
        self.bind_default_principal(&bundle.initial_session.id)
            .await?;
        self.inner.orchestrator.register_session_context(
            &bundle.initial_session.id,
            &bundle.initial_session.context_id,
        );
        Ok(bundle)
    }

    pub async fn list_agents(&self, archived: bool) -> Result<Vec<AgentRecord>, RuntimeError> {
        self.inner.store.list_agents(archived).await
    }

    pub async fn get_agent(&self, id: &str) -> Result<Option<AgentRecord>, RuntimeError> {
        self.inner.store.get_agent(id).await
    }

    pub async fn create_context(
        &self,
        context: NewCognitiveContext,
    ) -> Result<CognitiveContextRecord, RuntimeError> {
        self.inner.store.create_context(context).await
    }

    pub async fn get_context(
        &self,
        id: &str,
    ) -> Result<Option<CognitiveContextRecord>, RuntimeError> {
        self.inner.store.get_context(id).await
    }

    pub async fn list_contexts(
        &self,
        archived: bool,
    ) -> Result<Vec<CognitiveContextRecord>, RuntimeError> {
        self.inner.store.list_contexts(archived).await
    }

    pub async fn update_context(
        &self,
        id: &str,
        update: ContextUpdate,
    ) -> Result<Option<CognitiveContextRecord>, RuntimeError> {
        let Some(existing) = self.inner.store.get_context(id).await? else {
            return Ok(None);
        };
        if update.status == Some(crate::memory::SessionStatus::Archived) {
            let agent = self.inner.store.get_agent(&existing.agent_id).await?;
            if agent
                .as_ref()
                .is_some_and(|agent| agent.root_context_id == id)
            {
                return Err(format!(
                    "Context '{id}' 是 Agent '{}' 的根 Context，不能归档",
                    existing.agent_id
                )
                .into());
            }
        }
        self.inner.store.update_context(id, update).await
    }

    pub async fn register_execution_target(
        &self,
        registration: ExecutionTargetRegistration,
    ) -> Result<ExecutionTargetRecord, RuntimeError> {
        self.inner
            .store
            .register_execution_target(registration)
            .await
    }

    pub async fn get_execution_target(
        &self,
        target_id: &str,
    ) -> Result<Option<ExecutionTargetRecord>, RuntimeError> {
        self.inner.store.get_execution_target(target_id).await
    }

    pub async fn list_execution_targets(
        &self,
        filter: ExecutionTargetFilter,
    ) -> Result<Vec<ExecutionTargetRecord>, RuntimeError> {
        self.inner.store.list_execution_targets(filter).await
    }

    pub async fn set_execution_target_status(
        &self,
        target_id: &str,
        expected_revision: u64,
        status: ExecutionTargetStatus,
    ) -> Result<ExecutionTargetMutation, RuntimeError> {
        self.inner
            .store
            .set_execution_target_status(target_id, expected_revision, status)
            .await
    }

    pub async fn authorize_execution_target(
        &self,
        authorization: NewExecutionTargetAuthorization,
    ) -> Result<ExecutionTargetAuthorizationMutation, RuntimeError> {
        self.inner
            .store
            .authorize_execution_target(authorization)
            .await
    }

    pub async fn get_execution_target_authorization(
        &self,
        authorization_id: &str,
    ) -> Result<Option<ExecutionTargetAuthorizationRecord>, RuntimeError> {
        self.inner
            .store
            .get_execution_target_authorization(authorization_id)
            .await
    }

    pub async fn list_execution_target_authorizations(
        &self,
        filter: ExecutionTargetAuthorizationFilter,
    ) -> Result<Vec<ExecutionTargetAuthorizationRecord>, RuntimeError> {
        self.inner
            .store
            .list_execution_target_authorizations(filter)
            .await
    }

    pub async fn revoke_execution_target_authorization(
        &self,
        authorization_id: &str,
        expected_revision: u64,
        reason: &str,
    ) -> Result<ExecutionTargetAuthorizationMutation, RuntimeError> {
        self.inner
            .store
            .revoke_execution_target_authorization(authorization_id, expected_revision, reason)
            .await
    }

    pub async fn create_node_pairing_code(
        &self,
        pairing: NewNodePairingCode,
    ) -> Result<(), RuntimeError> {
        self.inner.store.create_node_pairing_code(pairing).await
    }

    pub async fn pair_execution_node(
        &self,
        request: PairExecutionNode,
    ) -> Result<ExecutionNodeRecord, RuntimeError> {
        self.inner.store.pair_execution_node(request).await
    }

    pub async fn create_execution_node_challenge(
        &self,
        challenge: NewExecutionNodeChallenge,
    ) -> Result<(), RuntimeError> {
        self.inner
            .store
            .create_execution_node_challenge(challenge)
            .await
    }

    pub async fn consume_execution_node_challenge(
        &self,
        node_id: &str,
        challenge_id: &str,
        nonce_hash: &str,
    ) -> Result<Option<ExecutionNodeRecord>, RuntimeError> {
        self.inner
            .store
            .consume_execution_node_challenge(node_id, challenge_id, nonce_hash)
            .await
    }

    pub async fn issue_execution_node_connection_token(
        &self,
        node_id: &str,
        token_hash: &str,
        expires_at: chrono::DateTime<chrono::Utc>,
    ) -> Result<Option<ExecutionNodeRecord>, RuntimeError> {
        self.inner
            .store
            .issue_execution_node_connection_token(node_id, token_hash, expires_at)
            .await
    }

    pub async fn authenticate_execution_node(
        &self,
        node_id: &str,
        device_token_hash: &str,
    ) -> Result<Option<ExecutionNodeRecord>, RuntimeError> {
        self.inner
            .store
            .authenticate_execution_node(node_id, device_token_hash)
            .await
    }

    pub async fn heartbeat_execution_node(
        &self,
        node_id: &str,
        platform: Option<String>,
        capabilities: Vec<String>,
        metadata: Value,
    ) -> Result<Option<ExecutionNodeRecord>, RuntimeError> {
        self.inner
            .store
            .heartbeat_execution_node(node_id, platform, capabilities, metadata)
            .await
    }

    pub async fn list_execution_nodes(
        &self,
        owner_principal_id: &str,
    ) -> Result<Vec<ExecutionNodeRecord>, RuntimeError> {
        self.inner
            .store
            .list_execution_nodes(owner_principal_id)
            .await
    }

    pub async fn revoke_execution_node(
        &self,
        node_id: &str,
        owner_principal_id: &str,
        expected_revision: u64,
    ) -> Result<Option<ExecutionNodeRecord>, RuntimeError> {
        self.inner
            .store
            .revoke_execution_node(node_id, owner_principal_id, expected_revision)
            .await
    }

    pub async fn rotate_execution_node_key(
        &self,
        node_id: &str,
        expected_revision: u64,
        device_key_fingerprint: &str,
        device_public_key: &str,
    ) -> Result<ExecutionNodeMutation, RuntimeError> {
        self.inner
            .store
            .rotate_execution_node_key(
                node_id,
                expected_revision,
                device_key_fingerprint,
                device_public_key,
            )
            .await
    }

    pub async fn claim_edge_command(
        &self,
        provider_node_id: &str,
        worker_id: &str,
        claim_token: &str,
        lease_expires_at: chrono::DateTime<chrono::Utc>,
        max_in_flight: usize,
    ) -> Result<Option<EdgeCommandRecord>, RuntimeError> {
        self.inner
            .store
            .claim_edge_command(
                provider_node_id,
                worker_id,
                claim_token,
                lease_expires_at,
                max_in_flight,
            )
            .await
    }

    pub async fn get_edge_command(
        &self,
        job_id: &str,
    ) -> Result<Option<EdgeCommandRecord>, RuntimeError> {
        self.inner.store.get_edge_command(job_id).await
    }

    pub async fn heartbeat_edge_command(
        &self,
        job_id: &str,
        expected_revision: u64,
        claim_token: &str,
        lease_expires_at: chrono::DateTime<chrono::Utc>,
        side_effect_started: bool,
        progress: Option<String>,
    ) -> Result<EdgeCommandMutation, RuntimeError> {
        self.inner
            .store
            .heartbeat_edge_command(
                job_id,
                expected_revision,
                claim_token,
                lease_expires_at,
                side_effect_started,
                progress,
            )
            .await
    }

    pub async fn finish_edge_command(
        &self,
        job_id: &str,
        expected_revision: u64,
        claim_token: &str,
        status: EdgeCommandStatus,
        output: Option<String>,
        error: Option<String>,
    ) -> Result<EdgeCommandMutation, RuntimeError> {
        self.inner
            .store
            .finish_edge_command(
                job_id,
                expected_revision,
                claim_token,
                status,
                output,
                error,
            )
            .await
    }

    pub async fn append_edge_command_output(
        &self,
        job_id: &str,
        claim_token: &str,
        stream: EdgeOutputStream,
        text: &str,
    ) -> Result<EdgeCommandOutputChunk, RuntimeError> {
        self.inner
            .store
            .append_edge_command_output(job_id, claim_token, stream, text)
            .await
    }

    pub async fn list_edge_command_output(
        &self,
        job_id: &str,
        after_sequence: u64,
        limit: usize,
    ) -> Result<Vec<EdgeCommandOutputChunk>, RuntimeError> {
        self.inner
            .store
            .list_edge_command_output(job_id, after_sequence, limit)
            .await
    }

    pub async fn request_edge_command_cancel(
        &self,
        job_id: &str,
    ) -> Result<Option<EdgeCommandRecord>, RuntimeError> {
        self.inner.store.request_edge_command_cancel(job_id).await
    }

    pub async fn get_execution_job(
        &self,
        job_id: &str,
    ) -> Result<Option<ExecutionJobRecord>, RuntimeError> {
        self.inner.store.get_execution_job(job_id).await
    }

    pub async fn list_execution_jobs(
        &self,
        filter: ExecutionJobFilter,
    ) -> Result<Vec<ExecutionJobRecord>, RuntimeError> {
        self.inner.store.list_execution_jobs(filter).await
    }

    pub async fn request_execution_job_cancel(
        &self,
        job_id: &str,
        expected_revision: u64,
        reason: Option<&str>,
    ) -> Result<crate::execution::JobReceipt, RuntimeError> {
        let receipt = self
            .inner
            .execution_jobs
            .request_cancel(job_id, expected_revision, reason)
            .await?;
        if matches!(
            &receipt,
            crate::execution::JobReceipt::Applied { .. }
                | crate::execution::JobReceipt::Existing { .. }
        ) {
            let _ = self.inner.store.request_edge_command_cancel(job_id).await?;
            if let Some(job) = receipt.applied_job() {
                if job.tool_name == ARTIFACT_TRANSFER_TOOL_NAME {
                    for leg in ["source", "destination"] {
                        let leg_id =
                            crate::artifact::artifact_transfer_relay_leg_job_id(&job.id, leg);
                        let _ = self
                            .inner
                            .store
                            .request_edge_command_cancel(&leg_id)
                            .await?;
                        if let Some(leg_job) = self.inner.store.get_execution_job(&leg_id).await? {
                            if !leg_job.status.is_terminal()
                                && leg_job.cancel_requested_at.is_none()
                            {
                                let _ = self
                                    .inner
                                    .execution_jobs
                                    .request_cancel(
                                        &leg_job.id,
                                        leg_job.revision,
                                        Some("parent Artifact Transfer was cancelled"),
                                    )
                                    .await?;
                            }
                        }
                    }
                }
            }
        }
        Ok(receipt)
    }

    /// Materialize one transport-neutral Artifact intent as a durable
    /// Event -> Execution Thread -> Activation -> ExecutionJob graph.
    ///
    /// Identity and both target routes are fixed before the Job is runnable.
    /// Repeating the same `(principal, session, transfer_id)` is idempotent;
    /// reusing it for different bytes or routes is rejected by the Store.
    pub async fn submit_artifact_transfer(
        &self,
        principal_id: &str,
        session_id: &str,
        request: ArtifactTransferRequest,
    ) -> Result<ArtifactTransferExecutionRecord, RuntimeError> {
        request.validate()?;
        let session = self
            .get_session(session_id)
            .await?
            .ok_or_else(|| format!("Session '{session_id}' 不存在"))?;
        if !self
            .verify_session_principal(session_id, principal_id)
            .await?
        {
            return Err(format!("Principal '{principal_id}' 未参与 Session '{session_id}'").into());
        }

        let identity =
            artifact_transfer_execution_identity(principal_id, session_id, &request.transfer_id);
        let arguments = execution_arguments_from_transfer_request(&request)?;
        let (source, destination) = self
            .inner
            .execution_targets
            .validate_artifact_transfer(
                &request,
                &arguments,
                Some(principal_id),
                &session.agent_id,
                &session.context_id,
                &identity.thread_id,
            )
            .await?;
        let routes = crate::execution_target::ArtifactTransferRouteSnapshot {
            source: crate::execution_target::ExecutionRouteSnapshot::freeze(&source),
            destination: crate::execution_target::ExecutionRouteSnapshot::freeze(&destination),
        };
        let mut job_request: Value = serde_json::from_str(&arguments)?;
        job_request
            .as_object_mut()
            .ok_or("Artifact Transfer request 必须是 JSON object")?
            .insert("request".to_string(), serde_json::to_value(&request)?);
        crate::execution_target::attach_artifact_transfer_routes(&mut job_request, &routes)?;

        let mut request_event = Event::new(
            identity.event_id.clone(),
            "Runtime-ArtifactTransfer".to_string(),
            "runtime_control".to_string(),
            ARTIFACT_TRANSFER_REQUEST_TOPIC.to_string(),
            serde_json::Map::from_iter([
                ("context_id".to_string(), json!(session.context_id)),
                ("session_id".to_string(), json!(session.id)),
                ("principal_id".to_string(), json!(principal_id)),
                ("thread_id".to_string(), json!(identity.thread_id)),
                ("activation_id".to_string(), json!(identity.activation_id)),
                ("job_id".to_string(), json!(identity.job_id)),
                ("tool_call_id".to_string(), json!(identity.tool_call_id)),
                ("tool_name".to_string(), json!(ARTIFACT_TRANSFER_TOOL_NAME)),
                ("transfer_id".to_string(), json!(request.transfer_id)),
                ("source".to_string(), serde_json::to_value(&request.source)?),
                (
                    "destination".to_string(),
                    serde_json::to_value(&request.destination)?,
                ),
                ("request".to_string(), serde_json::to_value(&request)?),
                ("wake_policy".to_string(), json!("none")),
            ]),
        );
        if let Some(existing) = self
            .inner
            .store
            .query(QueryFilter {
                event_id: Some(identity.event_id.clone()),
                top_k: Some(1),
                ..Default::default()
            })
            .await?
            .into_iter()
            .next()
        {
            // Preserve the original timestamp so an idempotent API retry is
            // byte-for-byte the same immutable Event.
            request_event = existing;
        }

        let job = ExecutionJobSpec {
            activation_id: identity.activation_id.clone(),
            thread_id: identity.thread_id.clone(),
            agent_id: session.agent_id.clone(),
            context_id: session.context_id.clone(),
            session_id: session.id.clone(),
            initiating_principal_id: Some(principal_id.to_string()),
            target_id: destination.id,
            tool_call_id: identity.tool_call_id.clone(),
            tool_name: ARTIFACT_TRANSFER_TOOL_NAME.to_string(),
            request: job_request,
            // A staged transfer can be retried safely only before the
            // persisted physical side-effect boundary. Once execution starts,
            // restart reconciliation must inspect reality instead of replaying.
            retry_safety: crate::memory::ExecutionRetrySafety::Idempotent,
            // PermissionBroker authorizes the exact source+destination delta
            // at the physical boundary. `claim` is ownership, not approval.
            requires_approval: false,
        }
        .into_new_job()?;
        debug_assert_eq!(job.id, identity.job_id);
        let record = self
            .inner
            .store
            .ensure_artifact_transfer_execution(NewArtifactTransferExecution {
                request_event: request_event.clone(),
                thread: NewThread {
                    id: identity.thread_id.clone(),
                    agent_id: session.agent_id.clone(),
                    context_id: session.context_id.clone(),
                    session_id: session.id.clone(),
                    initiating_principal_id: Some(principal_id.to_string()),
                    root_turn_id: identity.event_id.clone(),
                    kind: ThreadKind::Execution,
                    executor_kind: ARTIFACT_TRANSFER_EXECUTOR_KIND.to_string(),
                    executor_id: Some(identity.job_id.clone()),
                    target_id: Some(request.destination.target_id.clone()),
                    supervision: ThreadSupervision::runtime("artifact-transfer-ingress"),
                },
                activation: NewThreadActivation {
                    id: identity.activation_id,
                    agent_id: session.agent_id,
                    context_id: session.context_id,
                    session_id: session.id,
                    initiating_principal_id: Some(principal_id.to_string()),
                    trigger_event_id: identity.event_id.clone(),
                    trigger_sequence: 0,
                    trigger_kind: ARTIFACT_TRANSFER_REQUEST_TOPIC.to_string(),
                    parent_activation_id: None,
                    root_turn_id: identity.event_id,
                },
                job,
            })
            .await?;
        self.inner.bus.dispatch_persisted(request_event).await?;
        self.spawn_artifact_transfer_job(record.job.id.clone());
        Ok(record)
    }

    fn spawn_artifact_transfer_job(&self, job_id: String) {
        let runtime = self.clone();
        tokio::spawn(async move {
            if let Err(error) = runtime.run_artifact_transfer_job(&job_id).await {
                tracing::error!(job_id, %error, "Artifact Transfer worker 失败");
            }
        });
    }

    async fn run_artifact_transfer_job(&self, job_id: &str) -> Result<(), RuntimeError> {
        let Some(initial_job) = self.inner.store.get_execution_job(job_id).await? else {
            return Ok(());
        };
        if initial_job.status.is_terminal() || initial_job.status != ExecutionJobStatus::Queued {
            return Ok(());
        }
        let Some(initial_activation) = self
            .inner
            .store
            .get_thread_activation(&initial_job.activation_id)
            .await?
        else {
            return Err(format!("Artifact Transfer Job '{job_id}' 缺少 Activation").into());
        };
        if initial_activation.status == ThreadActivationStatus::Queued {
            match self
                .inner
                .store
                .update_thread_activation(
                    &initial_activation.id,
                    initial_activation.revision,
                    ThreadActivationStatus::Running,
                    Some("morphz-artifact-transfer"),
                    Some(
                        chrono::Utc::now()
                            + chrono::Duration::seconds(ARTIFACT_TRANSFER_WORKER_LEASE_SECS),
                    ),
                    None,
                )
                .await?
            {
                crate::memory::ThreadActivationMutation::Updated(_) => {}
                crate::memory::ThreadActivationMutation::Conflict { current }
                    if current.status == ThreadActivationStatus::Running => {}
                crate::memory::ThreadActivationMutation::Conflict { .. }
                | crate::memory::ThreadActivationMutation::NotFound => return Ok(()),
            }
        }

        let claim_token = format!(
            "artifact-claim:{}:{}:{}",
            std::process::id(),
            job_id,
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        );
        let mut job = match self
            .inner
            .execution_jobs
            .claim(
                job_id,
                initial_job.revision,
                JobClaim {
                    worker_id: "morphz-artifact-transfer",
                    claim_token: &claim_token,
                    lease_expires_at: chrono::Utc::now()
                        + chrono::Duration::seconds(ARTIFACT_TRANSFER_WORKER_LEASE_SECS),
                    approval_ref: None,
                },
            )
            .await?
        {
            JobReceipt::Applied { job, .. } | JobReceipt::Existing { job, .. } => job,
            JobReceipt::Conflict { .. }
            | JobReceipt::Rejected { .. }
            | JobReceipt::NotFound { .. } => return Ok(()),
        };
        job = match self
            .inner
            .execution_jobs
            .heartbeat(
                job_id,
                job.revision,
                JobHeartbeat {
                    claim_token: &claim_token,
                    lease_expires_at: chrono::Utc::now()
                        + chrono::Duration::seconds(ARTIFACT_TRANSFER_WORKER_LEASE_SECS),
                    // Artifact publication is reconciled by content digest
                    // and deterministic Job identity.  Do not mark the whole
                    // transport as an unknown side-effect boundary before it
                    // even starts; doing so would make a process crash turn an
                    // otherwise resumable transfer into `lost`.
                    side_effect_started_at: None,
                    progress_ref: Some("artifact_transfer_started"),
                },
            )
            .await?
        {
            JobReceipt::Applied { job, .. } | JobReceipt::Existing { job, .. } => job,
            JobReceipt::Conflict { current, .. } => current,
            JobReceipt::Rejected { reason, .. } => return Err(reason.into()),
            JobReceipt::NotFound { .. } => return Ok(()),
        };

        let request: ArtifactTransferRequest = serde_json::from_value(
            job.request
                .get("request")
                .cloned()
                .unwrap_or_else(|| job.request.clone()),
        )
        .or_else(|_| {
            crate::artifact::transfer_request_from_tool_arguments(
                &serde_json::to_string(&job.request)?,
                format!("transfer:{}", job.id),
            )
        })?;
        let arguments = execution_arguments_from_transfer_request(&request)?;
        let tool = self
            .inner
            .registry
            .get(ARTIFACT_TRANSFER_TOOL_NAME)
            .ok_or("Runtime 未注册 transfer 工具")?;
        let tool_context = crate::tool::ToolExecutionJobContext {
            parent_job_id: job.id.clone(),
            activation_id: job.activation_id.clone(),
            thread_id: job.thread_id.clone(),
            agent_id: job.agent_id.clone(),
            context_id: job.context_id.clone(),
            session_id: job.session_id.clone(),
            initiating_principal_id: job.initiating_principal_id.clone(),
            target_id: job.target_id.clone(),
            tool_call_id: job.tool_call_id.clone(),
        };
        let result = {
            let (progress_tx, mut progress_rx) = tokio::sync::mpsc::unbounded_channel();
            let (side_effect_tx, mut side_effect_rx) = tokio::sync::mpsc::unbounded_channel();
            // The physical executor must observe one immutable claim snapshot. The
            // control loop below advances the durable Job revision at heartbeats
            // and at the publication boundary, so borrowing that mutable control
            // copy for the lifetime of the executor would conflate two roles.
            let execution_job = job.clone();
            let execution_principal_id = job.initiating_principal_id.clone();
            let execution_activation_id = job.activation_id.clone();
            let execution_context_id = job.context_id.clone();
            let execution_session_id = job.session_id.clone();
            let execute = self
                .inner
                .execution_targets
                .execute(&execution_job, tool, &arguments);
            let execution = crate::artifact::CURRENT_ARTIFACT_TRANSFER_SIDE_EFFECT.scope(
                side_effect_tx,
                CURRENT_ARTIFACT_TRANSFER_PROGRESS.scope(
                    progress_tx,
                    crate::tool::CURRENT_EXECUTION_JOB.scope(Some(tool_context), async {
                        crate::tool::CURRENT_PRINCIPAL_ID
                            .scope(execution_principal_id, async {
                                crate::tool::CURRENT_ATTEMPT_ID
                                    .scope(execution_activation_id, async {
                                        crate::tool::CURRENT_CONTEXT_ID
                                            .scope(execution_context_id, async {
                                                crate::tool::CURRENT_SESSION_ID
                                                    .scope(execution_session_id, execute)
                                                    .await
                                            })
                                            .await
                                    })
                                    .await
                            })
                            .await
                    }),
                ),
            );
            tokio::pin!(execution);
            let mut control_tick = tokio::time::interval(std::time::Duration::from_secs(1));
            control_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let progress_started = std::time::Instant::now();
            let mut latest_progress: Option<ArtifactTransferProgress> = None;
            let mut persisted_progress: Option<ArtifactTransferProgress> = None;
            let mut progress_open = true;
            let mut side_effect_open = true;
            loop {
                tokio::select! {
                    result = &mut execution => {
                        while let Ok(progress) = progress_rx.try_recv() {
                            latest_progress = Some(progress);
                        }
                        if latest_progress != persisted_progress {
                            if let Some(progress) = latest_progress.clone() {
                                if let Err(error) = self.persist_artifact_transfer_progress(&job, &request, &progress).await {
                                    tracing::warn!(job_id = %job.id, %error, "Artifact Transfer 最终进度持久化失败");
                                }
                            }
                        }
                        break result;
                    },
                    progress = progress_rx.recv(), if progress_open => {
                        match progress {
                            Some(progress) => latest_progress = Some(progress),
                            None => progress_open = false,
                        }
                    }
                    side_effect = side_effect_rx.recv(), if side_effect_open => {
                        let Some(acknowledge) = side_effect else {
                            side_effect_open = false;
                            continue;
                        };
                        let Some(current) = self.inner.store.get_execution_job(job_id).await? else {
                            break Err("Artifact Transfer Job 在发布边界前消失".into());
                        };
                        match self.inner.execution_jobs.heartbeat(
                            job_id,
                            current.revision,
                            JobHeartbeat {
                                claim_token: &claim_token,
                                lease_expires_at: chrono::Utc::now()
                                    + chrono::Duration::seconds(ARTIFACT_TRANSFER_WORKER_LEASE_SECS),
                                side_effect_started_at: Some(chrono::Utc::now()),
                                progress_ref: Some("artifact_transfer_publishing"),
                            },
                        ).await? {
                            JobReceipt::Applied { job: updated, .. }
                            | JobReceipt::Existing { job: updated, .. } => job = updated,
                            JobReceipt::Conflict { current, .. }
                                if current.side_effect_started_at.is_some() => job = current,
                            JobReceipt::Conflict { current, .. } => {
                                break Err(format!(
                                    "Artifact Transfer 发布边界 revision 冲突（当前 r{} / {}）",
                                    current.revision,
                                    current.status.as_str()
                                ).into());
                            }
                            JobReceipt::Rejected { reason, .. } => break Err(reason.into()),
                            JobReceipt::NotFound { .. } => {
                                break Err("Artifact Transfer Job 在发布边界前消失".into());
                            }
                        }
                        let _ = acknowledge.send(());
                    }
                    _ = control_tick.tick() => {
                        let Some(current) = self.inner.store.get_execution_job(job_id).await? else {
                            break Err("Artifact Transfer Job 在执行期间消失".into());
                        };
                        if current.cancel_requested_at.is_some() {
                            let _ = self.inner.store.request_edge_command_cancel(job_id).await;
                            for leg in ["source", "destination"] {
                                let child_id = crate::artifact::artifact_transfer_relay_leg_job_id(job_id, leg);
                                let _ = self.inner.store.request_edge_command_cancel(&child_id).await;
                            }
                            // Dropping the physical future closes local streams
                            // and kills managed SSH children (`kill_on_drop`).
                            break Err(crate::artifact::ArtifactTransferCancelled.into());
                        }
                        let progress_ref = latest_progress.as_ref().map(|progress| {
                            let elapsed = progress_started.elapsed().as_secs_f64().max(0.001);
                            serde_json::to_string(&json!({
                                "kind": "artifact_transfer",
                                "phase": progress.phase,
                                "bytes_transferred": progress.bytes_transferred,
                                "total_bytes": progress.total_bytes,
                                "current_entry": progress.current_entry,
                                "throughput_bytes_per_second":
                                    (progress.bytes_transferred as f64 / elapsed).round() as u64,
                            }))
                            .unwrap_or_else(|_| "artifact_transfer_running".to_string())
                        }).unwrap_or_else(|| "artifact_transfer_running".to_string());
                        let heartbeat = self.inner.execution_jobs.heartbeat(
                            job_id,
                            current.revision,
                            JobHeartbeat {
                                claim_token: &claim_token,
                                lease_expires_at: chrono::Utc::now()
                                    + chrono::Duration::seconds(ARTIFACT_TRANSFER_WORKER_LEASE_SECS),
                                side_effect_started_at: None,
                                progress_ref: Some(&progress_ref),
                            },
                        ).await;
                        let _ = heartbeat;
                        if latest_progress != persisted_progress {
                            if let Some(progress) = latest_progress.clone() {
                                if let Err(error) = self.persist_artifact_transfer_progress(&job, &request, &progress).await {
                                    tracing::warn!(job_id = %job.id, %error, "Artifact Transfer progress 持久化失败");
                                } else {
                                    persisted_progress = latest_progress.clone();
                                }
                            }
                        }
                    }
                }
            }
        };

        let (status, text, error) = match result {
            Ok(text) => ("success", text, None),
            Err(error) => {
                let cancelled = crate::artifact::is_artifact_transfer_cancelled(error.as_ref());
                let message = error.to_string();
                if cancelled {
                    (
                        "cancelled",
                        format!("Artifact Transfer 已取消: {message}"),
                        Some(message),
                    )
                } else {
                    ("failed", format!("执行失败: {message}"), Some(message))
                }
            }
        };
        // A cancellation request increments the durable revision while the
        // physical executor is running. Refresh before the terminal CAS so
        // the worker never strands the Job by finishing with its stale claim
        // revision.
        if let Some(current) = self.inner.store.get_execution_job(job_id).await? {
            job = current;
        }
        let result_event_id = format!("output_{}", job.id);
        let mut payload = serde_json::Map::from_iter([
            ("context_id".to_string(), json!(job.context_id)),
            ("session_id".to_string(), json!(job.session_id)),
            ("thread_id".to_string(), json!(job.thread_id)),
            ("activation_id".to_string(), json!(job.activation_id)),
            ("tool_call_id".to_string(), json!(job.tool_call_id)),
            ("tool_name".to_string(), json!(job.tool_name)),
            ("job_id".to_string(), json!(job.id)),
            ("transfer_id".to_string(), json!(request.transfer_id)),
            ("source".to_string(), json!(request.source)),
            ("destination".to_string(), json!(request.destination)),
            ("tool_status".to_string(), json!(status)),
            ("text".to_string(), json!(text)),
            ("wake_policy".to_string(), json!("none")),
        ]);
        if let Some(principal_id) = &job.initiating_principal_id {
            payload.insert("principal_id".to_string(), json!(principal_id));
        }
        let result_topic = match status {
            "success" => ARTIFACT_TRANSFER_COMPLETED_TOPIC,
            "cancelled" => ARTIFACT_TRANSFER_CANCELLED_TOPIC,
            _ => ARTIFACT_TRANSFER_FAILED_TOPIC,
        };
        let result_event = Event::new(
            result_event_id.clone(),
            "Runtime-ArtifactTransfer".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            result_topic.to_string(),
            payload,
        );
        let outcome = match (status, error) {
            ("cancelled", reason) => JobOutcome::Cancelled {
                result_event_id: Some(result_event_id.clone()),
                result_refs: vec![request.transfer_id.clone()],
                reason,
                exit_code: None,
            },
            (_, Some(error)) => JobOutcome::Failed {
                result_event_id: Some(result_event_id.clone()),
                result_refs: vec![request.transfer_id.clone()],
                error,
                exit_code: None,
            },
            _ => JobOutcome::Succeeded {
                result_event_id: Some(result_event_id.clone()),
                result_refs: vec![request.transfer_id.clone()],
                exit_code: Some(0),
            },
        };
        let terminal_status = match status {
            "success" => ThreadActivationStatus::Succeeded,
            "cancelled" => ThreadActivationStatus::Cancelled,
            _ => ThreadActivationStatus::Failed,
        };
        let terminal_lifecycle = match status {
            "success" => ThreadLifecycle::Completed,
            "cancelled" => ThreadLifecycle::Cancelled,
            _ => ThreadLifecycle::Failed,
        };
        match self
            .inner
            .execution_jobs
            .finish_with_event(
                job_id,
                job.revision,
                Some(&claim_token),
                outcome,
                &result_event,
                false,
            )
            .await?
        {
            JobReceipt::Applied { .. } | JobReceipt::Existing { .. } => {}
            JobReceipt::Conflict { current, .. } if current.status.is_terminal() => {}
            JobReceipt::Conflict { current, .. } => {
                return Err(format!(
                    "Artifact Transfer Job '{}' 终态提交 revision 冲突（当前 r{} / {}）",
                    current.id,
                    current.revision,
                    current.status.as_str()
                )
                .into())
            }
            JobReceipt::Rejected { reason, .. } => return Err(reason.into()),
            JobReceipt::NotFound { .. } => return Err("Artifact Transfer Job 消失".into()),
        }
        self.inner.bus.dispatch_persisted(result_event).await?;
        self.close_artifact_transfer_scheduler_projection(
            &job,
            terminal_status,
            terminal_lifecycle,
            &text,
            &result_event_id,
        )
        .await;
        Ok(())
    }

    async fn persist_artifact_transfer_progress(
        &self,
        job: &ExecutionJobRecord,
        request: &ArtifactTransferRequest,
        progress: &ArtifactTransferProgress,
    ) -> Result<(), RuntimeError> {
        let event_id = format!(
            "artifact_transfer_progress_{}_{}",
            job.id,
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        self.inner
            .store
            .append(Event::new(
                event_id,
                "Runtime-ArtifactTransfer".to_string(),
                "artifact_transfer_progress".to_string(),
                ARTIFACT_TRANSFER_PROGRESS_TOPIC.to_string(),
                serde_json::Map::from_iter([
                    ("context_id".to_string(), json!(job.context_id)),
                    ("session_id".to_string(), json!(job.session_id)),
                    ("thread_id".to_string(), json!(job.thread_id)),
                    ("activation_id".to_string(), json!(job.activation_id)),
                    ("job_id".to_string(), json!(job.id)),
                    ("transfer_id".to_string(), json!(request.transfer_id)),
                    ("progress".to_string(), json!(progress)),
                    ("wake_policy".to_string(), json!("none")),
                ]),
            ))
            .await?;
        Ok(())
    }

    async fn close_artifact_transfer_scheduler_projection(
        &self,
        job: &ExecutionJobRecord,
        activation_status: ThreadActivationStatus,
        lifecycle: ThreadLifecycle,
        result_text: &str,
        result_event_id: &str,
    ) {
        if let Ok(Some(activation)) = self
            .inner
            .store
            .get_thread_activation(&job.activation_id)
            .await
        {
            if let Err(error) = self
                .inner
                .store
                .update_thread_activation(
                    &activation.id,
                    activation.revision,
                    activation_status,
                    None,
                    None,
                    activation.context_snapshot_version,
                )
                .await
            {
                tracing::warn!(job_id = %job.id, %error, "Artifact Transfer Activation 投影收口失败");
            }
        }
        if let Ok(Some(thread)) = self.inner.store.get_thread(&job.thread_id).await {
            if let Err(error) = self
                .inner
                .store
                .update_thread(
                    &thread.id,
                    thread.revision,
                    None,
                    Some(lifecycle),
                    Some(result_text),
                    Some(result_event_id),
                    None,
                    None,
                )
                .await
            {
                tracing::warn!(job_id = %job.id, %error, "Artifact Transfer Thread 投影收口失败");
            }
        }
    }

    pub async fn list_capability_leases(
        &self,
        filter: CapabilityLeaseFilter,
    ) -> Result<Vec<CapabilityLeaseRecord>, RuntimeError> {
        self.inner.store.list_capability_leases(filter).await
    }

    pub async fn revoke_capability_lease(
        &self,
        lease_id: &str,
        expected_revision: u64,
        reason: &str,
    ) -> Result<CapabilityLeaseMutation, RuntimeError> {
        self.inner
            .store
            .revoke_capability_lease(lease_id, expected_revision, reason)
            .await
    }

    pub async fn create_session(&self, session: NewSession) -> Result<SessionRecord, RuntimeError> {
        let principal = self
            .ensure_principal(PrincipalAssertion {
                principal_id: self.inner.identity.principal_id.clone(),
                provider_id: RUNTIME_DEFAULT_IDENTITY_PROVIDER_ID.to_string(),
                assurance: "runtime-default".to_string(),
                display_name: None,
            })
            .await?;
        let session = self
            .inner
            .store
            .create_session_for_principal(session, &principal.id)
            .await?;
        self.inner
            .orchestrator
            .register_session_context(&session.id, &session.context_id);
        Ok(session)
    }

    pub async fn create_session_for_principal(
        &self,
        session: NewSession,
        assertion: PrincipalAssertion,
    ) -> Result<SessionRecord, RuntimeError> {
        let principal = self.ensure_principal(assertion).await?;
        let session = self
            .inner
            .store
            .create_session_for_principal(session, &principal.id)
            .await?;
        self.inner
            .orchestrator
            .register_session_context(&session.id, &session.context_id);
        Ok(session)
    }

    pub async fn get_session(&self, id: &str) -> Result<Option<SessionRecord>, RuntimeError> {
        self.inner.store.get_session(id).await
    }

    pub async fn list_sessions(&self, archived: bool) -> Result<Vec<SessionRecord>, RuntimeError> {
        self.inner.store.list_sessions(archived).await
    }

    pub async fn list_context_sessions(
        &self,
        context_id: &str,
        archived: bool,
    ) -> Result<Vec<SessionRecord>, RuntimeError> {
        self.inner
            .store
            .list_context_sessions(context_id, archived)
            .await
    }

    pub async fn update_session(
        &self,
        id: &str,
        update: SessionUpdate,
    ) -> Result<Option<SessionRecord>, RuntimeError> {
        self.inner.store.update_session(id, update).await
    }

    pub async fn touch_session(
        &self,
        id: &str,
        timestamp: chrono::DateTime<chrono::Utc>,
    ) -> Result<(), RuntimeError> {
        self.inner.store.touch_session(id, timestamp).await
    }

    pub async fn create_delegation(
        &self,
        delegation: NewDelegation,
    ) -> Result<DelegationRecord, RuntimeError> {
        self.inner.store.create_delegation(delegation).await
    }

    pub async fn get_delegation(&self, id: &str) -> Result<Option<DelegationRecord>, RuntimeError> {
        self.inner.store.get_delegation(id).await
    }

    pub async fn list_delegations(&self) -> Result<Vec<DelegationRecord>, RuntimeError> {
        self.inner.store.list_delegations().await
    }

    pub async fn update_delegation_status(
        &self,
        id: &str,
        status: DelegationStatus,
        result_event_id: Option<&str>,
    ) -> Result<Option<DelegationRecord>, RuntimeError> {
        self.inner
            .store
            .update_delegation_status(id, status, result_event_id)
            .await
    }

    pub async fn create_objective(
        &self,
        objective: NewObjective,
    ) -> Result<ObjectiveRecord, RuntimeError> {
        self.inner.objective_supervisor.create(objective).await
    }

    /// Atomically creates a schedulable Objective and binds one exact Harness
    /// package before its first Evaluation can be claimed.
    pub async fn create_objective_with_harness(
        &self,
        objective: NewObjective,
        harness_id: &str,
        harness_version: &str,
    ) -> Result<(ObjectiveRecord, HarnessBinding), RuntimeError> {
        let harness = self
            .inner
            .harness_registry
            .get(harness_id, harness_version)
            .ok_or_else(|| format!("Harness '{harness_id}@{harness_version}' 未注册"))?;
        let (binding, event) = objective_harness_binding_event(
            &objective.context_id,
            &objective.id,
            harness.as_ref(),
        )?;
        let created = self
            .inner
            .objective_supervisor
            .create_with_initial_events(objective, vec![event])
            .await?;
        Ok((created, binding))
    }

    pub fn harnesses(&self) -> Vec<HarnessDescriptor> {
        self.inner.harness_registry.descriptors()
    }

    pub async fn register_harness_package(
        &self,
        package: HarnessPackage,
    ) -> Result<Arc<HarnessPackage>, RuntimeError> {
        persist_harness_package(self.inner.store.as_ref(), &package).await?;
        self.inner.harness_registry.register_package(package)
    }

    /// Binds one exact installed package to an Objective. The v1 binding is
    /// immutable and inherited by every Evaluation of that Objective.
    pub async fn bind_objective_harness(
        &self,
        objective_id: &str,
        harness_id: &str,
        harness_version: &str,
    ) -> Result<HarnessBinding, RuntimeError> {
        let objective = self
            .get_objective(objective_id)
            .await?
            .ok_or_else(|| format!("Objective '{objective_id}' 不存在"))?;
        let harness = self
            .inner
            .harness_registry
            .get(harness_id, harness_version)
            .ok_or_else(|| format!("Harness '{harness_id}@{harness_version}' 未注册"))?;
        persist_objective_harness_binding(
            self.inner.store.as_ref(),
            &objective.context_id,
            objective_id,
            harness.as_ref(),
        )
        .await
    }

    pub async fn objective_harness_binding(
        &self,
        objective_id: &str,
    ) -> Result<Option<HarnessBinding>, RuntimeError> {
        let Some(objective) = self.get_objective(objective_id).await? else {
            return Ok(None);
        };
        load_objective_harness_binding(
            self.inner.store.as_ref(),
            &objective.context_id,
            objective_id,
        )
        .await
    }

    /// Returns the exact Primary Harness selected for one concrete
    /// Evaluation. Objective defaults are deliberately not synthesized here:
    /// callers can distinguish an inherited default from the authoritative
    /// Evaluation-scoped binding that was actually evaluated.
    pub async fn evaluation_harness_binding(
        &self,
        evaluation_id: &str,
    ) -> Result<Option<HarnessBinding>, RuntimeError> {
        load_evaluation_harness_binding(self.inner.store.as_ref(), evaluation_id).await
    }

    pub async fn get_objective(&self, id: &str) -> Result<Option<ObjectiveRecord>, RuntimeError> {
        self.inner.objective_supervisor.get(id).await
    }

    pub async fn list_context_objectives(
        &self,
        context_id: &str,
        include_terminal: bool,
    ) -> Result<Vec<ObjectiveRecord>, RuntimeError> {
        self.inner
            .objective_supervisor
            .list(context_id, include_terminal)
            .await
    }

    pub async fn edit_objective(
        &self,
        id: &str,
        expected_revision: u64,
        stated_objective: &str,
    ) -> Result<ObjectiveMutation, RuntimeError> {
        self.inner
            .objective_supervisor
            .edit(id, expected_revision, stated_objective)
            .await
    }

    pub async fn update_objective_state(
        &self,
        id: &str,
        expected_revision: u64,
        status: ObjectiveStatus,
        wait_condition: Option<ObjectiveWaitCondition>,
        reason: Option<&str>,
    ) -> Result<ObjectiveMutation, RuntimeError> {
        self.inner
            .objective_supervisor
            .update_state(id, expected_revision, status, wait_condition, reason)
            .await
    }

    pub async fn pause_objective(
        &self,
        id: &str,
        expected_revision: u64,
        reason: &str,
    ) -> Result<ObjectiveMutation, RuntimeError> {
        let current = self
            .get_objective(id)
            .await?
            .ok_or_else(|| format!("Objective '{id}' 不存在"))?;
        let active_evaluation_id = current.active_evaluation_id.clone();
        let mutation = self
            .update_objective_state(
                id,
                expected_revision,
                ObjectiveStatus::Paused,
                None,
                Some(reason),
            )
            .await?;
        if matches!(&mutation, ObjectiveMutation::Updated(_)) {
            let mut cancellation_error = None;
            if let Some(evaluation_id) = active_evaluation_id {
                cancellation_error = self
                    .inner
                    .orchestrator
                    .cancel_objective_evaluation(&current.id, &evaluation_id)
                    .await
                    .err();
            }
            self.inner
                .objective_supervisor
                .reconcile_context(&current.context_id)
                .await?;
            if let Some(error) = cancellation_error {
                return Err(error);
            }
        }
        Ok(mutation)
    }

    pub async fn resume_objective(
        &self,
        id: &str,
        expected_revision: u64,
        reason: &str,
    ) -> Result<ObjectiveMutation, RuntimeError> {
        let _current = self
            .get_objective(id)
            .await?
            .ok_or_else(|| format!("Objective '{id}' 不存在"))?;
        self.update_objective_state(
            id,
            expected_revision,
            ObjectiveStatus::Active,
            None,
            Some(reason),
        )
        .await
    }

    pub async fn cancel_objective(
        &self,
        id: &str,
        expected_revision: u64,
        reason: &str,
    ) -> Result<ObjectiveMutation, RuntimeError> {
        let current = self
            .get_objective(id)
            .await?
            .ok_or_else(|| format!("Objective '{id}' 不存在"))?;
        let active_evaluation_id = current.active_evaluation_id.clone();
        let mutation = self
            .update_objective_state(
                id,
                expected_revision,
                ObjectiveStatus::Cancelled,
                None,
                Some(reason),
            )
            .await?;
        if matches!(&mutation, ObjectiveMutation::Updated(_)) {
            let mut cancellation_error = None;
            if let Some(evaluation_id) = active_evaluation_id {
                cancellation_error = self
                    .inner
                    .orchestrator
                    .cancel_objective_evaluation(&current.id, &evaluation_id)
                    .await
                    .err();
            }
            self.inner
                .objective_supervisor
                .reconcile_context(&current.context_id)
                .await?;
            if let Some(error) = cancellation_error {
                return Err(error);
            }
        }
        Ok(mutation)
    }

    /// Cancel a Delegation and every active descendant it spawned. The requested root's parent
    /// is woken with a terminal delegate Observation so an attached evaluation cannot remain
    /// suspended forever.
    pub async fn cancel_delegation_tree(
        &self,
        id: &str,
    ) -> Result<Vec<DelegationRecord>, RuntimeError> {
        let delegations = self.inner.store.list_delegations().await?;
        let root = delegations
            .iter()
            .find(|delegation| delegation.id == id)
            .cloned()
            .ok_or_else(|| format!("Delegation '{}' 不存在", id))?;
        let mut pending_sessions = vec![root.child_session_id.clone()];
        let mut selected = Vec::new();
        let mut visited = std::collections::HashSet::new();
        while let Some(parent_session_id) = pending_sessions.pop() {
            for delegation in delegations.iter().filter(|delegation| {
                delegation.child_session_id == parent_session_id
                    || delegation.parent_session_id == parent_session_id
            }) {
                if !visited.insert(delegation.id.clone()) {
                    continue;
                }
                pending_sessions.push(delegation.child_session_id.clone());
                selected.push(delegation.clone());
            }
        }

        // Stop leaves before ancestors so a descendant cannot enqueue more work while its parent
        // is being cancelled.
        let mut cancelled = Vec::new();
        for delegation in selected.into_iter().rev() {
            if matches!(
                delegation.status,
                DelegationStatus::Completed
                    | DelegationStatus::Failed
                    | DelegationStatus::Cancelled
            ) {
                continue;
            }
            self.cancel_session(&delegation.child_session_id);
            if let Some(updated) = self
                .inner
                .store
                .update_delegation_status(&delegation.id, DelegationStatus::Cancelled, None)
                .await?
            {
                cancelled.push(updated);
            }
        }

        if cancelled.iter().any(|delegation| delegation.id == root.id) {
            let mut cancelled_event = Event::new(
                format!(
                    "delegation_cancelled_{}_{}",
                    root.id,
                    chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
                ),
                "System-Delegation".to_string(),
                crate::event::TYPE_TOOL_OUTPUT.to_string(),
                "chat/tool_output".to_string(),
                vec![
                    ("context_id".to_string(), json!(root.parent_context_id)),
                    ("session_id".to_string(), json!(root.parent_session_id)),
                    ("delegation_id".to_string(), json!(root.id)),
                    ("tool_name".to_string(), json!("delegate")),
                    ("tool_status".to_string(), json!("cancelled")),
                    (
                        "text".to_string(),
                        json!(json!({
                            "delegation_id": id,
                            "status": "cancelled",
                            "cancelled_descendants": cancelled.len().saturating_sub(1),
                            "guidance": "Delegation 已取消；请根据当前证据继续或向用户说明。"
                        })
                        .to_string()),
                    ),
                ]
                .into_iter()
                .collect(),
            );
            if let Some(principal_id) = &root.initiating_principal_id {
                cancelled_event
                    .payload
                    .insert("principal_id".to_string(), json!(principal_id));
            }
            self.inner.bus.publish(cancelled_event).await?;
        }
        Ok(cancelled)
    }

    pub async fn query_events(&self, filter: QueryFilter) -> Result<Vec<Event>, RuntimeError> {
        self.inner.store.query(filter).await
    }

    pub async fn publish(&self, event: Event) -> Result<(), RuntimeError> {
        self.inner.bus.publish(event).await
    }

    pub fn subscribe(&self, topic: impl Into<String>, capacity: usize) -> RuntimeEventStream {
        let (sender, receiver) = tokio::sync::mpsc::channel(capacity.max(1));
        let subscription_id = self.inner.bus.subscribe(
            topic.into(),
            Arc::new(move |event| {
                let sender = sender.clone();
                Box::pin(async move {
                    if event.topic == "runtime/model_stream" {
                        // Provider deltas are transient UI drafts. A slow or
                        // abandoned observer must never apply backpressure to
                        // the model request (wildcard EventBus subscribers are
                        // otherwise synchronous). Dropping a draft chunk is
                        // safe because the terminal chat/reply or chat/progress
                        // fact below still takes the reliable await path and
                        // replaces the draft with durable complete text.
                        let _ = sender.try_send(event);
                    } else {
                        let _ = sender.send(event).await;
                    }
                    Ok(())
                })
            }),
        );
        RuntimeEventStream {
            receiver,
            bus: Arc::downgrade(&self.inner.bus),
            subscription_id,
        }
    }

    pub async fn pending_approvals(&self) -> Vec<PendingHumanApproval> {
        let mut pending = self.inner.human_approval_hub.pending();
        let mut known = pending
            .iter()
            .map(|entry| entry.request.approval_id.clone())
            .collect::<std::collections::HashSet<_>>();
        let records = match self
            .inner
            .store
            .list_approvals(ApprovalFilter {
                pending_only: true,
                ..ApprovalFilter::default()
            })
            .await
        {
            Ok(records) => records,
            Err(error) => {
                tracing::error!(%error, "读取持久化待审批列表失败；退回进程内视图");
                return pending;
            }
        };
        for record in records {
            if !known.insert(record.id.clone()) {
                continue;
            }
            let Ok(Some(job)) = self.inner.store.get_execution_job(&record.job_id).await else {
                continue;
            };
            let Ok(Some(activation)) = self
                .inner
                .store
                .get_thread_activation(&job.activation_id)
                .await
            else {
                tracing::error!(
                    approval_id = %record.id,
                    activation_id = %job.activation_id,
                    "待审批请求缺少因果 Activation"
                );
                continue;
            };
            let Ok(action) =
                serde_json::from_value::<crate::approval::ApprovalAction>(record.action.clone())
            else {
                tracing::error!(approval_id = %record.id, "待审批 action 无法解码");
                continue;
            };
            let Ok(requested) = serde_json::from_value::<crate::approval::CapabilityDelta>(
                record.requested.clone(),
            ) else {
                tracing::error!(approval_id = %record.id, "待审批 capability delta 无法解码");
                continue;
            };
            let lease_offer = if self.inner.config.edge_execution.capability_leases_enabled
                && self
                    .inner
                    .config
                    .edge_execution
                    .capability_lease_ttl
                    .as_secs()
                    > 0
            {
                match (
                    job.initiating_principal_id.as_ref(),
                    self.inner.store.get_thread(&job.thread_id).await,
                    self.inner.store.get_execution_target(&job.target_id).await,
                ) {
                    (Some(principal_id), Ok(Some(thread)), Ok(Some(target)))
                        if thread.lifecycle == crate::memory::ThreadLifecycle::Open =>
                    {
                        Some(CapabilityLeaseOffer {
                            principal_id: principal_id.clone(),
                            agent_id: job.agent_id.clone(),
                            thread_id: job.thread_id.clone(),
                            target_id: job.target_id.clone(),
                            capability: action.lease_capability(),
                            requested: requested.clone(),
                            policy_digest: capability_lease_policy_digest(
                                &self.inner.permissions.policy_digest(),
                                &target.policy_digest,
                            ),
                            expires_at: record.created_at
                                + chrono::Duration::seconds(
                                    i64::try_from(
                                        self.inner
                                            .config
                                            .edge_execution
                                            .capability_lease_ttl
                                            .as_secs(),
                                    )
                                    .unwrap_or(i64::MAX),
                                ),
                        })
                    }
                    _ => None,
                }
            } else {
                None
            };
            pending.push(PendingHumanApproval {
                request: crate::approval::ApprovalRequest {
                    approval_id: record.id,
                    context_id: job.context_id,
                    session_id: job.session_id,
                    attempt_id: job.activation_id,
                    thread_id: job.thread_id,
                    root_turn_id: activation.root_turn_id,
                    trigger_event_id: activation.trigger_event_id,
                    trigger_sequence: activation.trigger_sequence,
                    action,
                    requested,
                    justification: record.justification,
                    lease_offer,
                },
                requested_at: record.created_at,
            });
        }
        pending.sort_by_key(|entry| entry.requested_at);
        pending
    }

    pub async fn decide_approval(
        &self,
        approval_id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), String> {
        let current = self
            .inner
            .store
            .get_approval(approval_id)
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("审批请求 '{approval_id}' 不存在"))?;
        let resolution = match &decision {
            ApprovalDecision::AllowOnce {
                rationale,
                risk_tags,
            } => ApprovalResolution::Allow {
                rationale: rationale.clone(),
                risk_tags: risk_tags.clone(),
            },
            ApprovalDecision::AllowLease {
                rationale,
                risk_tags,
            } => {
                if !self.inner.config.edge_execution.capability_leases_enabled {
                    return Err("Runtime 已关闭 Capability Lease".to_string());
                }
                let job = self
                    .inner
                    .store
                    .get_execution_job(&current.job_id)
                    .await
                    .map_err(|error| error.to_string())?
                    .ok_or_else(|| format!("Approval '{}' 缺少 Execution Job", current.id))?;
                if job.initiating_principal_id.is_none() {
                    return Err("没有权威 Principal 的请求不能批准 Capability Lease".to_string());
                }
                let mut risk_tags = risk_tags.clone();
                if !risk_tags
                    .iter()
                    .any(|tag| tag == CAPABILITY_LEASE_APPROVED_RISK_TAG)
                {
                    risk_tags.push(CAPABILITY_LEASE_APPROVED_RISK_TAG.to_string());
                }
                ApprovalResolution::Allow {
                    rationale: rationale.clone(),
                    risk_tags,
                }
            }
            ApprovalDecision::Deny {
                rationale,
                risk_tags,
            } => ApprovalResolution::Deny {
                rationale: rationale.clone(),
                risk_tags: risk_tags.clone(),
            },
            ApprovalDecision::AskHuman { .. } => {
                return Err("人工审批结果只能是 allow_once、allow_lease 或 deny".to_string());
            }
        };
        let commit = self
            .inner
            .store
            .commit_approval_decision(&current.id, current.revision, resolution)
            .await
            .map_err(|error| error.to_string())?;
        let _approval = match commit.mutation {
            ApprovalMutation::Updated(record) | ApprovalMutation::Existing(record) => record,
            ApprovalMutation::Conflict { current, reason }
            | ApprovalMutation::Rejected { current, reason } => {
                return Err(format!(
                    "审批 '{}' 在提交决定时被拒绝（r{} / {}）: {reason}",
                    current.id,
                    current.revision,
                    current.status.as_str()
                ));
            }
            ApprovalMutation::NotFound => {
                return Err(format!("审批请求 '{approval_id}' 在提交时已不存在"));
            }
            ApprovalMutation::Created(_) => {
                return Err("审批决定返回了不可能的 Created 状态".to_string());
            }
        };
        if commit.event_created {
            let event = commit.event.ok_or_else(|| {
                "Approval 审计 Event 已原子创建，但 Store 未返回持久化投影".to_string()
            })?;
            self.inner
                .bus
                .dispatch_persisted(event)
                .await
                .map_err(|error| error.to_string())?;
        }
        if let Err(error) = self
            .inner
            .human_approval_hub
            .notify_decision(approval_id, decision)
        {
            tracing::warn!(approval_id, %error, "审批已持久化，但进程内 waiter 已结束");
        }
        Ok(())
    }

    pub fn cancel_session(&self, session_id: &str) -> bool {
        self.inner.orchestrator.cancel_session(session_id)
    }

    pub async fn inspect_session_context(
        &self,
        session_id: &str,
    ) -> Result<crate::sexpr::SExpr, RuntimeError> {
        let view = self.inspect_session_context_view(session_id).await?;
        Ok(crate::sexpr::parse(&view.sexpr)?)
    }

    pub async fn inspect_session_context_view(
        &self,
        session_id: &str,
    ) -> Result<ContextView, RuntimeError> {
        let session = self
            .inner
            .store
            .get_session(session_id)
            .await?
            .ok_or_else(|| format!("Session '{}' 不存在", session_id))?;
        self.inner
            .orchestrator
            .get_context_encoding(&session.context_id, session_id)
            .await
    }

    /// Structured projection for operator surfaces. Unlike
    /// [`Self::inspect_session_context_view`], this does not duplicate the
    /// projection as a rendered model-facing S-expression.
    pub async fn inspect_session_context_projection(
        &self,
        session_id: &str,
    ) -> Result<ContextView, RuntimeError> {
        let session = self
            .inner
            .store
            .get_session(session_id)
            .await?
            .ok_or_else(|| format!("Session '{}' 不存在", session_id))?;
        self.context_projection(&session.context_id, session_id)
            .await
    }

    pub async fn session_attention_state(
        &self,
        session_id: &str,
    ) -> Result<SessionRecord, RuntimeError> {
        self.inner
            .store
            .get_session(session_id)
            .await?
            .ok_or_else(|| format!("Session '{}' 不存在", session_id).into())
    }

    pub async fn active_thread_activations(
        &self,
        context_id: &str,
    ) -> Result<Vec<ThreadActivationRecord>, RuntimeError> {
        self.inner
            .store
            .list_context_thread_activations(context_id, false)
            .await
    }

    pub async fn scheduler_snapshot(
        &self,
        context_id: &str,
        query: SchedulerQuery,
    ) -> Result<SchedulerSnapshot, RuntimeError> {
        let context = self
            .inner
            .store
            .get_context(context_id)
            .await?
            .ok_or_else(|| format!("Context '{context_id}' 不存在"))?;
        let include_terminal = query.include_terminal;
        let limit = query.limit.clamp(1, 2_000);
        let sessions = self
            .inner
            .store
            .list_context_sessions(context_id, true)
            .await?;
        let mut authority_objectives = self
            .inner
            .store
            .list_context_objectives(context_id, true)
            .await?;
        authority_objectives.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        let mut context_threads = self
            .inner
            .store
            .list_context_threads(context_id, true)
            .await?;
        context_threads.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        let authority_threads = context_threads.clone();
        let all_context_thread_ids = context_threads
            .iter()
            .map(|thread| thread.id.clone())
            .collect::<HashSet<_>>();
        let all_context_thread_roots = context_threads
            .iter()
            .map(|thread| thread.root_turn_id.clone())
            .collect::<HashSet<_>>();
        let mut all_threads = context_threads
            .iter()
            .filter(|thread| !thread.lifecycle.is_terminal())
            .cloned()
            .collect::<Vec<_>>();
        if include_terminal {
            let terminal_budget = limit.saturating_sub(all_threads.len());
            all_threads.extend(
                context_threads
                    .into_iter()
                    .filter(|thread| thread.lifecycle.is_terminal())
                    .take(terminal_budget),
            );
        }
        all_threads.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });

        let thread_ids = all_threads
            .iter()
            .map(|thread| thread.id.clone())
            .collect::<HashSet<_>>();
        let thread_by_root = all_threads
            .iter()
            .map(|thread| (thread.root_turn_id.clone(), thread.id.clone()))
            .collect::<HashMap<_, _>>();

        let all_context_activations = self
            .inner
            .store
            .list_context_thread_activations(context_id, true)
            .await?;
        let all_context_activation_ids = all_context_activations
            .iter()
            .map(|activation| activation.id.clone())
            .collect::<HashSet<_>>();
        let durable_queued_ids = all_context_activations
            .iter()
            .filter(|activation| activation.status == ThreadActivationStatus::Queued)
            .map(|activation| activation.id.clone())
            .collect::<HashSet<_>>();
        let durable_running_ids = all_context_activations
            .iter()
            .filter(|activation| activation.status == ThreadActivationStatus::Running)
            .map(|activation| activation.id.clone())
            .collect::<HashSet<_>>();
        let mut sorted_activations = all_context_activations.clone();
        sorted_activations.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        let mut activations = sorted_activations
            .iter()
            .filter(|activation| !activation.status.is_terminal())
            .cloned()
            .collect::<Vec<_>>();
        if include_terminal {
            let terminal_budget = limit
                .saturating_mul(4)
                .min(8_000)
                .saturating_sub(activations.len());
            activations.extend(
                sorted_activations
                    .into_iter()
                    .filter(|activation| activation.status.is_terminal())
                    .take(terminal_budget),
            );
        }
        activations.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });

        let mut all_signals = self
            .inner
            .store
            // Signals already claimed or acknowledged belong to their
            // Activation history. They must never fall back into the
            // standalone pending bucket merely because that Activation is
            // outside this bounded history page.
            .list_context_thread_signals(context_id, Some(ThreadSignalStatus::Pending))
            .await?;
        all_signals.retain(|signal| thread_ids.contains(&signal.thread_id));
        all_signals.sort_by(|left, right| {
            left.sequence
                .cmp(&right.sequence)
                .then_with(|| left.id.cmp(&right.id))
        });

        let mut jobs = self
            .inner
            .store
            .list_execution_jobs(ExecutionJobFilter {
                context_id: Some(context_id.to_string()),
                include_terminal: false,
                limit: None,
                ..ExecutionJobFilter::default()
            })
            .await?;
        if include_terminal {
            let history = self
                .inner
                .store
                .list_execution_jobs(ExecutionJobFilter {
                    context_id: Some(context_id.to_string()),
                    include_terminal: true,
                    newest_first: true,
                    limit: Some(limit.saturating_mul(10).min(20_000)),
                    ..ExecutionJobFilter::default()
                })
                .await?;
            let live_ids = jobs
                .iter()
                .map(|job| job.id.clone())
                .collect::<HashSet<_>>();
            jobs.extend(
                history
                    .into_iter()
                    .filter(|job| job.status.is_terminal() && !live_ids.contains(&job.id)),
            );
        }
        jobs.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        let mut approval_by_job = self
            .inner
            .store
            .list_context_approvals(context_id)
            .await?
            .into_iter()
            .map(|approval| (approval.job_id.clone(), approval))
            .collect::<HashMap<_, _>>();

        let mut jobs_by_activation = HashMap::<String, Vec<SchedulerJobSnapshot>>::new();
        let mut orphan_jobs = Vec::new();
        let activation_ids = activations
            .iter()
            .map(|activation| activation.id.clone())
            .collect::<HashSet<_>>();
        for job in jobs {
            let snapshot = crate::scheduler::job_snapshot(job, &mut approval_by_job);
            if activation_ids.contains(&snapshot.job.activation_id) {
                jobs_by_activation
                    .entry(snapshot.job.activation_id.clone())
                    .or_default()
                    .push(snapshot);
            } else if !all_context_activation_ids.contains(&snapshot.job.activation_id) {
                // A bounded Scheduler query may omit an older terminal
                // Activation while still selecting one of its Jobs through
                // the independently bounded Job history. That is pagination,
                // not a broken causal edge. Only records whose parent truly
                // does not exist in the Context authority are orphans.
                orphan_jobs.push(snapshot);
            }
        }

        let mut activations_by_thread = HashMap::<String, Vec<SchedulerActivationSnapshot>>::new();
        let mut orphan_activations = Vec::new();
        for activation in activations {
            let signals = self
                .inner
                .store
                .list_activation_signals(&activation.id)
                .await?;
            let snapshot = SchedulerActivationSnapshot {
                jobs: jobs_by_activation
                    .remove(&activation.id)
                    .unwrap_or_default(),
                activation,
                signals,
            };
            if let Some(thread_id) = thread_by_root.get(&snapshot.activation.root_turn_id) {
                activations_by_thread
                    .entry(thread_id.clone())
                    .or_default()
                    .push(snapshot);
            } else if !all_context_thread_roots.contains(&snapshot.activation.root_turn_id) {
                // As above, an Activation whose owning Thread lies outside
                // this history page is not an orphan. Calling it one makes
                // operator attention depend on the page size.
                orphan_activations.push(snapshot);
            }
        }
        orphan_jobs.extend(jobs_by_activation.into_values().flatten());

        let mut pending_signals_by_thread = HashMap::<String, Vec<ThreadSignalRecord>>::new();
        let mut orphan_signals = Vec::new();
        for signal in all_signals {
            if thread_ids.contains(&signal.thread_id) {
                pending_signals_by_thread
                    .entry(signal.thread_id.clone())
                    .or_default()
                    .push(signal);
            } else {
                orphan_signals.push(signal);
            }
        }

        let mut schedules_by_thread = HashMap::<String, Vec<ScheduleRecord>>::new();
        for schedule in self.inner.store.list_context_schedules(context_id).await? {
            if all_context_thread_ids.contains(&schedule.thread_id)
                && thread_ids.contains(&schedule.thread_id)
            {
                schedules_by_thread
                    .entry(schedule.thread_id.clone())
                    .or_default()
                    .push(schedule);
            }
        }

        let authority_groups = self
            .inner
            .store
            .list_thread_groups(ThreadGroupFilter {
                context_id: Some(context_id.to_string()),
                include_terminal: true,
                newest_first: false,
                limit: None,
                ..ThreadGroupFilter::default()
            })
            .await?;
        let mut authority_group_members = Vec::new();
        let mut thread_groups = Vec::new();
        for group in &authority_groups {
            let members = self
                .inner
                .store
                .list_thread_group_members(&group.id)
                .await?;
            authority_group_members.extend(members.iter().cloned());
            let outcomes = self
                .inner
                .store
                .list_thread_group_outcomes(&group.id)
                .await?;
            if thread_groups.len() < limit && (!group.status.is_terminal() || include_terminal) {
                thread_groups.push(SchedulerThreadGroupSnapshot {
                    group: group.clone(),
                    members,
                    outcomes,
                });
            }
        }

        let mut threads = Vec::with_capacity(all_threads.len());
        for thread in all_threads {
            let outcome = self.inner.store.get_thread_outcome(&thread.id).await?;
            let pending_signals = pending_signals_by_thread
                .remove(&thread.id)
                .unwrap_or_default();
            let thread_activations = activations_by_thread.remove(&thread.id).unwrap_or_default();
            let schedules = schedules_by_thread.remove(&thread.id).unwrap_or_default();
            let phase = crate::scheduler::thread_phase(
                &thread,
                &pending_signals,
                &thread_activations,
                &schedules,
            );
            threads.push(SchedulerThreadSnapshot {
                thread,
                phase,
                outcome,
                pending_signals,
                activations: thread_activations,
                schedules,
            });
        }
        orphan_activations.extend(activations_by_thread.into_values().flatten());
        orphan_signals.extend(pending_signals_by_thread.into_values().flatten());

        let process_admission = self.inner.orchestrator.activation_admission_snapshot();
        let context_loaded_queued = process_admission
            .queued_activation_ids
            .iter()
            .filter(|id| durable_queued_ids.contains(*id))
            .count();
        let context_in_flight = process_admission
            .in_flight_activation_ids
            .iter()
            .filter(|id| durable_running_ids.contains(*id))
            .count();
        let context_deferred = durable_queued_ids
            .len()
            .saturating_sub(context_loaded_queued);
        let pending_signals = threads
            .iter()
            .flat_map(|thread| thread.pending_signals.iter())
            .filter(|signal| signal.status == ThreadSignalStatus::Pending)
            .count()
            + orphan_signals
                .iter()
                .filter(|signal| signal.status == ThreadSignalStatus::Pending)
                .count();
        // Summary counters describe executable work, not merely non-terminal
        // child rows. A legacy/inconsistent Job whose Activation or Thread is
        // already terminal must remain visible in the causal history, but it
        // must not make the Runtime appear active or ask the user to approve an
        // Action which no longer has a live result route.
        let live_job_snapshots = threads
            .iter()
            .filter(|thread| !thread.thread.lifecycle.is_terminal())
            .flat_map(|thread| thread.activations.iter())
            .filter(|activation| !activation.activation.status.is_terminal())
            .flat_map(|activation| activation.jobs.iter());
        let mut active_jobs = 0;
        let mut waiting_approval_jobs = 0;
        let mut pending_approvals = 0;
        for job in live_job_snapshots {
            if !job.job.status.is_terminal() {
                active_jobs += 1;
            }
            if job.job.status == ExecutionJobStatus::WaitingApproval {
                waiting_approval_jobs += 1;
            }
            if job
                .approval
                .as_ref()
                .is_some_and(|approval| approval.status.is_pending())
            {
                pending_approvals += 1;
            }
        }
        let active_schedules = threads
            .iter()
            .flat_map(|thread| thread.schedules.iter())
            .filter(|schedule| {
                matches!(
                    schedule.status,
                    ScheduleStatus::Queued | ScheduleStatus::Paused
                )
            })
            .count();
        let mut dependencies = Vec::new();
        for objective in &authority_objectives {
            dependencies.extend(
                self.inner
                    .store
                    .list_scheduler_dependencies(SchedulerDependencyFilter {
                        owner_kind: Some(SchedulerDependencyOwnerKind::Objective),
                        owner_id: Some(objective.id.clone()),
                        ..SchedulerDependencyFilter::default()
                    })
                    .await?,
            );
        }
        for thread in &authority_threads {
            dependencies.extend(
                self.inner
                    .store
                    .list_scheduler_dependencies(SchedulerDependencyFilter {
                        owner_kind: Some(SchedulerDependencyOwnerKind::Thread),
                        owner_id: Some(thread.id.clone()),
                        ..SchedulerDependencyFilter::default()
                    })
                    .await?,
            );
        }
        dependencies.sort_by(|left, right| left.id.cmp(&right.id));
        dependencies.dedup_by(|left, right| left.id == right.id);

        let now = chrono::Utc::now();
        let objective_snapshots = authority_objectives
            .iter()
            .filter(|objective| include_terminal || !objective.status.is_terminal())
            .take(limit)
            .map(|objective| {
                let objective_dependencies = dependencies
                    .iter()
                    .filter(|dependency| {
                        dependency.owner_kind == SchedulerDependencyOwnerKind::Objective
                            && dependency.owner_id == objective.id
                            && dependency.owner_generation == objective.generation
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                let active_evaluation = objective.active_evaluation_id.as_ref().and_then(|id| {
                    all_context_activations
                        .iter()
                        .find(|activation| activation.id == *id || activation.root_turn_id == *id)
                        .cloned()
                });
                SchedulerObjectiveSnapshot {
                    objective: objective.clone(),
                    readiness: derive_objective_readiness(objective, &objective_dependencies, now),
                    dependencies: objective_dependencies,
                    active_evaluation,
                }
            })
            .collect::<Vec<_>>();

        let mut authority_outcomes = Vec::new();
        for thread in &authority_threads {
            if let Some(outcome) = self.inner.store.get_thread_outcome(&thread.id).await? {
                authority_outcomes.push(outcome);
            }
        }
        let mut invariant_violations = audit_scheduler_invariants(SchedulerInvariantInput {
            objectives: &authority_objectives,
            threads: &authority_threads,
            activations: &all_context_activations,
            outcomes: &authority_outcomes,
            groups: &authority_groups,
            group_members: &authority_group_members,
            dependencies: &dependencies,
        });
        let mut barrier_event_ids = HashSet::new();
        for event_id in authority_groups
            .iter()
            .filter_map(|group| group.barrier_event_id.as_ref())
        {
            if self
                .inner
                .store
                .query(QueryFilter {
                    event_id: Some(event_id.clone()),
                    ..QueryFilter::default()
                })
                .await?
                .into_iter()
                .any(|event| event.id == *event_id)
            {
                barrier_event_ids.insert(event_id.clone());
            }
        }
        invariant_violations.extend(crate::recovery::SchedulerReconciler::audit_supervision(
            &authority_objectives,
            &all_context_activations,
            &authority_groups,
            &barrier_event_ids,
        ));
        let deliveries = authority_threads
            .iter()
            .filter(|thread| thread.delivery_status != crate::memory::DeliveryStatus::None)
            .map(|thread| SchedulerDeliverySnapshot {
                thread_id: thread.id.clone(),
                session_id: thread.session_id.clone(),
                generation: thread.generation,
                status: thread.delivery_status,
                event_id: thread.delivery_event_id.clone(),
                updated_at: thread.updated_at,
            })
            .collect::<Vec<_>>();
        let runnable_objectives = objective_snapshots
            .iter()
            .filter(|objective| {
                matches!(
                    objective.readiness,
                    crate::scheduler::ObjectiveReadiness::Runnable
                )
            })
            .count();
        let waiting_objectives = objective_snapshots
            .iter()
            .filter(|objective| {
                matches!(
                    objective.readiness,
                    crate::scheduler::ObjectiveReadiness::Waiting { .. }
                        | crate::scheduler::ObjectiveReadiness::Leased { .. }
                )
            })
            .count();
        let summary = SchedulerSummary {
            open_threads: threads
                .iter()
                .filter(|thread| !thread.thread.lifecycle.is_terminal())
                .count(),
            pending_signals,
            queued_activations: durable_queued_ids.len(),
            running_activations: durable_running_ids.len(),
            active_jobs,
            waiting_approval_jobs,
            pending_approvals,
            active_schedules,
            deferred_activations: context_deferred,
            runnable_objectives,
            waiting_objectives,
            invariant_violations: invariant_violations.len(),
        };
        Ok(SchedulerSnapshot {
            context_id: context_id.to_string(),
            generated_at: chrono::Utc::now(),
            summary,
            admission: SchedulerAdmissionSnapshot {
                process: process_admission,
                context_durable_queued: durable_queued_ids.len(),
                context_durable_running: durable_running_ids.len(),
                context_loaded_queued,
                context_in_flight,
                context_deferred,
            },
            event_writer: self.inner.orchestrator.durable_event_writer_metrics(),
            model_provider: self.inner.orchestrator.model_provider_metrics(),
            context_capacity: self.inner.orchestrator.context_capacity_metrics(),
            contexts: vec![context],
            sessions,
            objectives: objective_snapshots,
            threads,
            thread_groups,
            deliveries,
            // Internal scheduler Signals are not outboxes. The remaining
            // external transports expose their own authoritative stores; the
            // unified adapter is intentionally empty until those records are
            // lowered to the common cross-boundary envelope.
            external_outboxes: Vec::new(),
            invariant_violations,
            orphan_activations,
            orphan_signals,
            orphan_jobs,
            orphan_approvals: approval_by_job.into_values().collect(),
        })
    }

    /// Lists the persisted operator dispositions for a Context. Attention
    /// cases themselves stay derived from authoritative scheduler state, so a
    /// repaired source disappears automatically without mutating the Ledger.
    pub async fn attention_acknowledgements(
        &self,
        context_id: &str,
    ) -> Result<Vec<AttentionAcknowledgement>, RuntimeError> {
        if self.inner.store.get_context(context_id).await?.is_none() {
            return Err(format!("Context '{context_id}' 不存在").into());
        }
        self.inner
            .store
            .list_attention_acknowledgements(context_id)
            .await
    }

    /// Acknowledges one exact attention fingerprint without altering the
    /// Thread, Job, Approval or Delivery that produced it. This is an audited
    /// operator decision, not a repair and not deletion of failure evidence.
    pub async fn acknowledge_attention(
        &self,
        context_id: &str,
        command: AcknowledgeAttentionCommand,
    ) -> Result<AttentionAcknowledgement, RuntimeError> {
        if self.inner.store.get_context(context_id).await?.is_none() {
            return Err(format!("Context '{context_id}' 不存在").into());
        }
        let key = command.key.trim();
        let source_kind = command.source_kind.trim();
        let source_id = command.source_id.trim();
        if key.is_empty() || source_kind.is_empty() || source_id.is_empty() {
            return Err("关注确认需要非空的 key、source_kind 与 source_id".into());
        }
        if key.len() > 512 || source_kind.len() > 80 || source_id.len() > 256 {
            return Err("关注确认标识超过允许长度".into());
        }
        let acknowledged_at = chrono::Utc::now();
        let event_id = format!(
            "attention_ack_{}_{}",
            acknowledged_at.timestamp_nanos_opt().unwrap_or(0),
            RUNTIME_ID_COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let rationale = command
            .rationale
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let record = AttentionAcknowledgement {
            event_id: event_id.clone(),
            context_id: context_id.to_string(),
            key: key.to_string(),
            source_kind: source_kind.to_string(),
            source_id: source_id.to_string(),
            source_revision: command.source_revision,
            acknowledged_by: self.identity().principal_id.clone(),
            rationale,
            acknowledged_at,
        };
        let mut event = Event::new(
            event_id,
            "Runtime-Attention".to_string(),
            crate::event::TYPE_PROPOSAL.to_string(),
            "runtime/attention_acknowledged".to_string(),
            vec![
                ("context_id".to_string(), json!(record.context_id)),
                ("key".to_string(), json!(record.key)),
                ("source_kind".to_string(), json!(record.source_kind)),
                ("source_id".to_string(), json!(record.source_id)),
                ("source_revision".to_string(), json!(record.source_revision)),
                ("acknowledged_by".to_string(), json!(record.acknowledged_by)),
                ("rationale".to_string(), json!(record.rationale)),
            ]
            .into_iter()
            .collect(),
        );
        event.timestamp = acknowledged_at;
        self.publish(event).await?;
        Ok(record)
    }

    /// Returns one bounded Runtime-wide command-board projection.
    ///
    /// The storage reads are deliberately bulk queries. Product surfaces must
    /// not turn a Context or Session card into a separate database round trip,
    /// nor reconstruct scheduler state from the immutable Ledger.
    pub async fn runtime_overview(
        &self,
        query: RuntimeOverviewQuery,
    ) -> Result<RuntimeOverview, RuntimeError> {
        const DEFAULT_CONTEXT_LIMIT: usize = 40;
        const MAX_CONTEXT_LIMIT: usize = 100;
        const DEFAULT_SESSIONS_PER_CONTEXT: usize = 6;
        const MAX_SESSIONS_PER_CONTEXT: usize = 20;
        const MAX_ACTIVITY_ROWS: usize = 4_000;

        let context_limit = query
            .context_limit
            .unwrap_or(DEFAULT_CONTEXT_LIMIT)
            .clamp(1, MAX_CONTEXT_LIMIT);
        let sessions_per_context = query
            .sessions_per_context
            .unwrap_or(DEFAULT_SESSIONS_PER_CONTEXT)
            .clamp(1, MAX_SESSIONS_PER_CONTEXT);
        // Fetch a wider, still bounded candidate window before applying the
        // product-facing card limit. Storage ranks attention and active work
        // ahead of mere recency; the Runtime then applies the same semantic
        // ordering after joining authoritative scheduler state.
        let session_candidate_limit = MAX_SESSIONS_PER_CONTEXT;
        let requested_context_rows = context_limit.saturating_add(1);
        let mut contexts = self
            .inner
            .store
            .list_recent_contexts(query.include_archived, requested_context_rows)
            .await?;
        let has_more_contexts = contexts.len() > context_limit;
        contexts.truncate(context_limit);
        if contexts.is_empty() {
            return Ok(RuntimeOverview {
                generated_at: chrono::Utc::now(),
                summary: RuntimeOverviewSummary::default(),
                contexts: Vec::new(),
                has_more_contexts,
            });
        }

        let context_ids = contexts
            .iter()
            .map(|context| context.id.clone())
            .collect::<Vec<_>>();
        let context_id_set = context_ids.iter().cloned().collect::<HashSet<_>>();
        let activity_limit = context_limit
            .saturating_mul(session_candidate_limit)
            .saturating_mul(4)
            .clamp(100, MAX_ACTIVITY_ROWS);

        let (
            sessions,
            session_counts,
            mind_heads,
            open_threads,
            active_activations,
            objectives,
            delegations,
        ) = tokio::try_join!(
            self.inner.store.list_context_sessions_bounded(
                &context_ids,
                query.include_archived,
                session_candidate_limit,
            ),
            self.inner.store.count_context_sessions(&context_ids),
            self.inner.store.list_mind_projection_heads(&context_ids),
            self.inner.store.list_open_threads(activity_limit),
            self.inner
                .store
                .list_active_thread_activations(activity_limit),
            self.inner
                .store
                .list_recoverable_objectives_bounded(activity_limit),
            self.inner.store.list_recent_delegations(activity_limit),
        )?;

        let displayed_session_ids = sessions
            .iter()
            .map(|session| session.id.clone())
            .collect::<Vec<_>>();
        let principal_bindings = self
            .inner
            .store
            .list_session_principal_bindings_bounded(&displayed_session_ids)
            .await?;

        let counts_by_context = session_counts
            .into_iter()
            .map(|count| (count.context_id.clone(), count))
            .collect::<HashMap<_, _>>();
        let heads_by_context = mind_heads
            .into_iter()
            .map(|head| (head.context_id.clone(), head))
            .collect::<HashMap<String, MindProjectionHead>>();
        let bindings_by_session = runtime_overview_principals_by_session(principal_bindings);

        let mut threads_by_session: HashMap<String, Vec<ThreadRecord>> = HashMap::new();
        let mut thread_by_root = HashMap::new();
        let mut open_thread_count_by_context: HashMap<String, usize> = HashMap::new();
        for thread in open_threads
            .into_iter()
            .filter(|thread| context_id_set.contains(&thread.context_id))
        {
            *open_thread_count_by_context
                .entry(thread.context_id.clone())
                .or_default() += 1;
            thread_by_root.insert(thread.root_turn_id.clone(), thread.clone());
            threads_by_session
                .entry(thread.session_id.clone())
                .or_default()
                .push(thread);
        }
        for threads in threads_by_session.values_mut() {
            threads.sort_by(|left, right| {
                right
                    .updated_at
                    .cmp(&left.updated_at)
                    .then_with(|| left.id.cmp(&right.id))
            });
        }

        let mut activations_by_session: HashMap<String, Vec<ThreadActivationRecord>> =
            HashMap::new();
        let mut running_activation_count_by_context: HashMap<String, usize> = HashMap::new();
        for activation in active_activations
            .into_iter()
            .filter(|activation| context_id_set.contains(&activation.context_id))
        {
            if activation.status == ThreadActivationStatus::Running {
                *running_activation_count_by_context
                    .entry(activation.context_id.clone())
                    .or_default() += 1;
            }
            activations_by_session
                .entry(activation.session_id.clone())
                .or_default()
                .push(activation);
        }

        let mut objectives_by_session: HashMap<String, Vec<ObjectiveRecord>> = HashMap::new();
        let mut objectives_by_context: HashMap<String, usize> = HashMap::new();
        let mut attention_sessions_by_context: HashMap<String, HashSet<String>> = HashMap::new();
        for objective in objectives
            .into_iter()
            .filter(|objective| context_id_set.contains(&objective.context_id))
        {
            *objectives_by_context
                .entry(objective.context_id.clone())
                .or_default() += 1;
            if objective.status == ObjectiveStatus::Blocked
                || matches!(
                    objective.wait_condition.as_ref(),
                    Some(ObjectiveWaitCondition::UserInput { .. })
                )
            {
                let attention_sessions = attention_sessions_by_context
                    .entry(objective.context_id.clone())
                    .or_default();
                attention_sessions.insert(objective.coordinator_session_id.clone());
                attention_sessions.insert(objective.delivery_session_id.clone());
            }
            objectives_by_session
                .entry(objective.coordinator_session_id.clone())
                .or_default()
                .push(objective.clone());
            if objective.delivery_session_id != objective.coordinator_session_id {
                objectives_by_session
                    .entry(objective.delivery_session_id.clone())
                    .or_default()
                    .push(objective);
            }
        }
        for objectives in objectives_by_session.values_mut() {
            objectives.sort_by(|left, right| {
                right
                    .updated_at
                    .cmp(&left.updated_at)
                    .then_with(|| left.id.cmp(&right.id))
            });
        }

        let delegation_by_child_context = delegations
            .into_iter()
            .filter(|delegation| context_id_set.contains(&delegation.child_context_id))
            .fold(HashMap::new(), |mut map, delegation| {
                map.entry(delegation.child_context_id.clone())
                    .or_insert(delegation);
                map
            });
        let mut sessions_by_context: HashMap<String, Vec<SessionRecord>> = HashMap::new();
        for session in sessions {
            sessions_by_context
                .entry(session.context_id.clone())
                .or_default()
                .push(session);
        }

        let mut projected_contexts = Vec::with_capacity(contexts.len());
        for context in contexts {
            let count = counts_by_context.get(&context.id);
            let mut projected_sessions = sessions_by_context
                .remove(&context.id)
                .unwrap_or_default()
                .into_iter()
                .map(|session| {
                    let threads = threads_by_session
                        .get(&session.id)
                        .map(Vec::as_slice)
                        .unwrap_or(&[]);
                    let activations = activations_by_session
                        .get(&session.id)
                        .map(Vec::as_slice)
                        .unwrap_or(&[]);
                    let objectives = objectives_by_session
                        .get(&session.id)
                        .map(Vec::as_slice)
                        .unwrap_or(&[]);
                    let principal_ids = bindings_by_session
                        .get(&session.id)
                        .cloned()
                        .unwrap_or_default();
                    runtime_overview_session(
                        session,
                        principal_ids,
                        threads,
                        activations,
                        objectives,
                        &thread_by_root,
                    )
                })
                .collect::<Vec<_>>();
            projected_sessions.sort_by(|left, right| {
                right
                    .attention_required
                    .cmp(&left.attention_required)
                    .then_with(|| right.state.priority().cmp(&left.state.priority()))
                    .then_with(|| {
                        right
                            .session
                            .last_activity_at
                            .cmp(&left.session.last_activity_at)
                    })
                    .then_with(|| left.session.id.cmp(&right.session.id))
            });
            projected_sessions.truncate(sessions_per_context);

            // Context counters describe the complete bounded Runtime
            // projection, not only the Session cards currently displayed.
            let open_thread_count = open_thread_count_by_context
                .get(&context.id)
                .copied()
                .unwrap_or_default();
            let running_activation_count = running_activation_count_by_context
                .get(&context.id)
                .copied()
                .unwrap_or_default();
            let attention_count = attention_sessions_by_context
                .get(&context.id)
                .map(HashSet::len)
                .unwrap_or_default();
            let total_session_count = count
                .map(|count| count.total_sessions)
                .unwrap_or(projected_sessions.len() as u64);
            let active_session_count = count
                .map(|count| count.active_sessions)
                .unwrap_or(projected_sessions.len() as u64);
            let last_activity_at = count
                .and_then(|count| count.last_activity_at)
                .unwrap_or(context.updated_at)
                .max(context.updated_at);
            let delegation = delegation_by_child_context
                .get(&context.id)
                .map(|delegation| RuntimeOverviewDelegation {
                    id: delegation.id.clone(),
                    parent_context_id: delegation.parent_context_id.clone(),
                    parent_session_id: delegation.parent_session_id.clone(),
                    child_session_id: delegation.child_session_id.clone(),
                    task: delegation.task.clone(),
                    status: delegation.status.clone(),
                });
            projected_contexts.push(RuntimeOverviewContext {
                mind_revision: heads_by_context.get(&context.id).map(|head| head.revision),
                delegation,
                active_session_count,
                total_session_count,
                hidden_session_count: total_session_count
                    .saturating_sub(projected_sessions.len() as u64),
                objective_count: objectives_by_context.get(&context.id).copied().unwrap_or(0),
                open_thread_count,
                running_activation_count,
                attention_count,
                last_activity_at,
                sessions: projected_sessions,
                context,
            });
        }
        projected_contexts.sort_by(|left, right| {
            right
                .attention_count
                .cmp(&left.attention_count)
                .then_with(|| {
                    right
                        .running_activation_count
                        .cmp(&left.running_activation_count)
                })
                .then_with(|| right.last_activity_at.cmp(&left.last_activity_at))
                .then_with(|| left.context.id.cmp(&right.context.id))
        });

        let summary = RuntimeOverviewSummary {
            contexts: projected_contexts.len(),
            active_sessions: projected_contexts
                .iter()
                .map(|context| context.active_session_count)
                .sum(),
            total_sessions: projected_contexts
                .iter()
                .map(|context| context.total_session_count)
                .sum(),
            objectives: projected_contexts
                .iter()
                .map(|context| context.objective_count)
                .sum(),
            open_threads: projected_contexts
                .iter()
                .map(|context| context.open_thread_count)
                .sum(),
            running_activations: projected_contexts
                .iter()
                .map(|context| context.running_activation_count)
                .sum(),
            attention_required: projected_contexts
                .iter()
                .map(|context| context.attention_count)
                .sum(),
        };
        Ok(RuntimeOverview {
            generated_at: chrono::Utc::now(),
            summary,
            contexts: projected_contexts,
            has_more_contexts,
        })
    }

    pub async fn context_overview(
        &self,
        context_id: &str,
        query: ContextOverviewQuery,
    ) -> Result<ContextOverview, RuntimeError> {
        let context = self
            .inner
            .store
            .get_context(context_id)
            .await?
            .ok_or_else(|| format!("Context '{context_id}' 不存在"))?;
        let agent = self.inner.store.get_agent(&context.agent_id).await?;
        let objectives = self.list_context_objectives(context_id, false).await?;
        let scheduler = self
            .scheduler_snapshot(
                context_id,
                SchedulerQuery {
                    include_terminal: false,
                    limit: 100,
                },
            )
            .await?;

        let view = if let Some(session_id) = query.active_session_id.as_deref() {
            let session = self
                .inner
                .store
                .get_session(session_id)
                .await?
                .ok_or_else(|| format!("Session '{session_id}' 不存在"))?;
            if session.context_id != context_id {
                return Err(format!("Session '{session_id}' 不属于 Context '{context_id}'").into());
            }
            Some(
                self.inner
                    .orchestrator
                    .get_context_projection(context_id, session_id)
                    .await?,
            )
        } else {
            None
        };

        let (
            active_session_id,
            sessions,
            working_set,
            mind_revision,
            active_frames,
            retiring_frames,
            retired_items,
            pressure,
            attribution,
        ) = if let Some(view) = view {
            let attribution = self
                .inner
                .store
                .query(QueryFilter {
                    context_id: Some(context_id.to_string()),
                    session_id: Some(view.active_session_id.clone()),
                    topic: Some("chat/context_inspect".to_string()),
                    latest_k: Some(1),
                    ..Default::default()
                })
                .await?
                .pop()
                .and_then(|event| event.payload.get("attribution").cloned())
                .and_then(|value| serde_json::from_value(value).ok())
                .filter(|value: &ContextAttribution| value.total_weight_units > 0);
            let retired = &view.state.retired;
            (
                Some(view.active_session_id),
                view.sessions,
                Some(view.session_working_set),
                view.state.version,
                view.state
                    .frames
                    .iter()
                    .filter(|frame| !retired.contains(&frame.id))
                    .count(),
                view.state.retiring.len(),
                retired.len(),
                Some(view.pressure),
                attribution,
            )
        } else {
            (
                None,
                Vec::new(),
                None,
                self.mind_version(context_id).await?,
                0,
                0,
                0,
                None,
                None,
            )
        };

        Ok(ContextOverview {
            context,
            agent,
            generated_at: chrono::Utc::now(),
            active_session_id,
            sessions,
            working_set,
            mind_revision,
            active_frames,
            retiring_frames,
            retired_items,
            pressure,
            attribution,
            objectives,
            scheduler: scheduler.summary,
        })
    }

    /// Query exact Provider-returned usage facts. Component attribution and
    /// Context pressure are intentionally absent from this accounting API.
    pub async fn model_usage(
        &self,
        context_id: &str,
        query: ModelUsageQuery,
    ) -> Result<ModelUsagePage, RuntimeError> {
        let limit = query.limit.unwrap_or(100).clamp(1, 1_000);
        let events = self
            .inner
            .store
            .query(QueryFilter {
                context_id: Some(context_id.to_string()),
                session_id: query.session_id,
                before_sequence: query.before_sequence,
                topic: Some("runtime/model_usage".to_string()),
                latest_k: Some(limit),
                ..Default::default()
            })
            .await?;
        let mut records = events
            .into_iter()
            .filter_map(model_usage_record_from_event)
            .collect::<Vec<_>>();
        records.reverse();
        let mut totals = ModelUsageTotals::default();
        let mut cost_totals = BTreeMap::<(String, String), (f64, u64)>::new();
        for record in &mut records {
            record.cost = calculate_model_usage_cost(
                &self.inner.config.usage_pricing,
                record.model.as_deref(),
                &record.usage,
            );
            totals.attempts = totals.attempts.saturating_add(1);
            totals.input_tokens = totals
                .input_tokens
                .saturating_add(record.usage.input_tokens.unwrap_or(0));
            totals.uncached_input_tokens = totals
                .uncached_input_tokens
                .saturating_add(record.usage.uncached_input_tokens.unwrap_or(0));
            totals.cached_input_tokens = totals
                .cached_input_tokens
                .saturating_add(record.usage.cached_input_tokens.unwrap_or(0));
            totals.cache_write_input_tokens = totals
                .cache_write_input_tokens
                .saturating_add(record.usage.cache_write_input_tokens.unwrap_or(0));
            totals.output_tokens = totals
                .output_tokens
                .saturating_add(record.usage.output_tokens.unwrap_or(0));
            totals.reasoning_tokens = totals
                .reasoning_tokens
                .saturating_add(record.usage.reasoning_tokens.unwrap_or(0));
            totals.total_tokens = totals
                .total_tokens
                .saturating_add(record.usage.total_tokens.unwrap_or(0));
            if let Some(cost) = record.cost.as_ref() {
                let total = cost_totals
                    .entry((cost.currency.clone(), cost.pricing_version.clone()))
                    .or_insert((0.0, 0));
                total.0 += cost.amount;
                total.1 = total.1.saturating_add(1);
            }
        }
        let next_before_sequence = (records.len() == limit)
            .then(|| records.last().and_then(|record| record.sequence))
            .flatten();
        Ok(ModelUsagePage {
            records,
            totals,
            cost_totals: cost_totals
                .into_iter()
                .map(|((currency, pricing_version), (amount, priced_attempts))| {
                    ModelUsageCostTotal {
                        amount,
                        currency,
                        pricing_version,
                        priced_attempts,
                    }
                })
                .collect(),
            next_before_sequence,
        })
    }

    pub async fn thread_detail(
        &self,
        context_id: &str,
        thread_id: &str,
    ) -> Result<Option<ThreadDetail>, RuntimeError> {
        let Some(thread) = self.inner.store.get_thread(thread_id).await? else {
            return Ok(None);
        };
        if thread.context_id != context_id {
            return Ok(None);
        }

        // A deep link is an exact aggregate read, not a search through the
        // bounded Scheduler board. Otherwise an old terminal Thread would
        // become uninspectable as soon as enough newer history exists.
        let mut activations = self
            .inner
            .store
            .list_context_thread_activations(context_id, true)
            .await?
            .into_iter()
            .filter(|activation| activation.root_turn_id == thread.root_turn_id)
            .collect::<Vec<_>>();
        activations.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });

        let mut jobs = self
            .inner
            .store
            .list_execution_jobs(ExecutionJobFilter {
                context_id: Some(context_id.to_string()),
                thread_id: Some(thread_id.to_string()),
                include_terminal: true,
                ..ExecutionJobFilter::default()
            })
            .await?;
        jobs.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        let job_ids = jobs
            .iter()
            .map(|job| job.id.clone())
            .collect::<HashSet<_>>();
        let mut approval_by_job = self
            .inner
            .store
            .list_context_approvals(context_id)
            .await?
            .into_iter()
            .filter(|approval| job_ids.contains(&approval.job_id))
            .map(|approval| (approval.job_id.clone(), approval))
            .collect::<HashMap<_, _>>();
        let mut jobs_by_activation = HashMap::<String, Vec<SchedulerJobSnapshot>>::new();
        for job in jobs {
            jobs_by_activation
                .entry(job.activation_id.clone())
                .or_default()
                .push(crate::scheduler::job_snapshot(job, &mut approval_by_job));
        }

        let mut activation_snapshots = Vec::with_capacity(activations.len());
        let mut claimed_signal_ids = HashSet::new();
        for activation in activations {
            let signals = self
                .inner
                .store
                .list_activation_signals(&activation.id)
                .await?;
            claimed_signal_ids.extend(signals.iter().map(|signal| signal.id.clone()));
            let jobs = jobs_by_activation
                .remove(&activation.id)
                .unwrap_or_default();
            activation_snapshots.push(SchedulerActivationSnapshot {
                activation,
                signals,
                jobs,
            });
        }

        let mut pending_signals = self
            .inner
            .store
            .list_context_thread_signals(context_id, Some(ThreadSignalStatus::Pending))
            .await?
            .into_iter()
            .filter(|signal| {
                signal.thread_id == thread_id && !claimed_signal_ids.contains(&signal.id)
            })
            .collect::<Vec<_>>();
        pending_signals.sort_by(|left, right| {
            left.sequence
                .cmp(&right.sequence)
                .then_with(|| left.id.cmp(&right.id))
        });
        let mut schedules = self
            .inner
            .store
            .list_context_schedules(context_id)
            .await?
            .into_iter()
            .filter(|schedule| schedule.thread_id == thread_id)
            .collect::<Vec<_>>();
        schedules.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        let phase = crate::scheduler::thread_phase(
            &thread,
            &pending_signals,
            &activation_snapshots,
            &schedules,
        );
        let mut model_attempt_events = Vec::new();
        for topic in [
            "runtime/model_attempt_state",
            "runtime/model_reasoning_summary",
        ] {
            // Thread-detail inspection is a read path.  It must never perform
            // a compatibility migration: SQLite has one Writer, and locating
            // even a bounded number of legacy rows can scan a large JSON
            // history while that Writer is held.  New Events populate the
            // causal columns at append time.  Legacy projection repair remains
            // an explicit/background maintenance operation and may not delay
            // durable outcomes, Timers, Recall, or ordinary Dashboard reads.
            model_attempt_events.extend(
                self.query_events(QueryFilter {
                    context_id: Some(context_id.to_string()),
                    session_id: Some(thread.session_id.clone()),
                    topic: Some(topic.to_string()),
                    thread_id: Some(thread_id.to_string()),
                    latest_k: Some(2_048),
                    ..QueryFilter::default()
                })
                .await?,
            );
        }
        model_attempt_events.sort_by(|left, right| {
            left.sequence
                .cmp(&right.sequence)
                .then_with(|| left.timestamp.cmp(&right.timestamp))
                .then_with(|| left.id.cmp(&right.id))
        });

        Ok(Some(ThreadDetail {
            context_id: context_id.to_string(),
            generated_at: chrono::Utc::now(),
            snapshot: SchedulerThreadSnapshot {
                outcome: self.inner.store.get_thread_outcome(&thread.id).await?,
                thread,
                phase,
                pending_signals,
                activations: activation_snapshots,
                schedules,
            },
            model_attempt_events,
        }))
    }

    /// Applies an operator control command to one exact Thread revision.
    ///
    /// Pause is an admission control operation: already-running external side
    /// effects are not pretended to be frozen, while pending mailbox signals
    /// remain durable. Close advances the Thread generation and cancels every
    /// Activation from the generation that was visible to the operator.
    pub async fn control_thread(
        &self,
        context_id: &str,
        thread_id: &str,
        expected_revision: u64,
        action: ThreadControlAction,
        reason: &str,
    ) -> Result<ThreadMutation, RuntimeError> {
        let Some(current) = self.inner.store.get_thread(thread_id).await? else {
            return Ok(ThreadMutation::NotFound);
        };
        if current.context_id != context_id {
            return Ok(ThreadMutation::NotFound);
        }

        if current.revision != expected_revision {
            return Ok(ThreadMutation::Conflict { current });
        }
        let mutation = match self
            .inner
            .scheduler_kernel
            .execute(crate::controllers::DialogueController::control_thread(
                &current,
                context_id,
                action,
                reason,
                "Runtime-Operator",
            ))
            .await?
        {
            KernelResult::ThreadControlled(mutation) => mutation,
            _ => return Err("Scheduler Kernel 返回了错误的 Thread control 结果".into()),
        };
        if let ThreadMutation::Updated(updated) = &mutation {
            match action {
                ThreadControlAction::Pause => {}
                ThreadControlAction::Resume => {
                    self.inner
                        .orchestrator
                        .wake_resumed_thread(&updated.root_turn_id)
                        .await?;
                }
                ThreadControlAction::Close => {
                    self.inner
                        .orchestrator
                        .cancel_thread_activations(&current, reason)
                        .await?;
                }
            }
        }
        Ok(mutation)
    }

    pub async fn query_ledger(&self, query: LedgerQuery) -> Result<LedgerQueryPage, RuntimeError> {
        if self
            .inner
            .store
            .get_context(&query.context_id)
            .await?
            .is_none()
        {
            return Err(format!("Context '{}' 不存在", query.context_id).into());
        }
        let limit = if query.limit == 0 { 100 } else { query.limit }.clamp(1, 500);
        let (event_ids, has_search_term) = match query.search_query.as_deref() {
            None => (Vec::new(), false),
            Some(search) => {
                let normalized = crate::memory::normalize_recall_text(search.trim());
                if normalized.is_empty() {
                    (Vec::new(), false)
                } else {
                    (
                        self.inner
                            .store
                            .search_recall_documents(&query.context_id, &normalized, limit.min(100))
                            .await?
                            .into_iter()
                            .filter(|hit| hit.document_kind == RecallDocumentKind::Event)
                            .map(|hit| hit.document_id)
                            .collect::<Vec<_>>(),
                        true,
                    )
                }
            }
        };
        if has_search_term && event_ids.is_empty() {
            return Ok(LedgerQueryPage {
                context_id: query.context_id,
                generated_at: chrono::Utc::now(),
                events: Vec::new(),
                scanned_count: 0,
                scan_exhaustive: true,
                next_after_sequence: None,
                next_before_sequence: None,
            });
        }
        let requires_payload_scope_scan = query.principal_id.is_some();
        let scan_limit = if requires_payload_scope_scan {
            limit.saturating_mul(20).clamp(limit, 20_000)
        } else {
            limit
        };
        let fetch_limit = scan_limit.saturating_add(1);
        let forward_scan = query.after_sequence.is_some() && query.before_sequence.is_none();
        let mut filter = QueryFilter {
            context_id: Some(query.context_id.clone()),
            session_id: query.session_id.clone(),
            after_sequence: query.after_sequence,
            before_sequence: query.before_sequence,
            start_time: query.start_time,
            end_time: query.end_time,
            actors: query.actor.clone().into_iter().collect(),
            types: query.event_type.clone().into_iter().collect(),
            topic: query.topic.clone(),
            event_ids,
            thread_id: query.thread_id.clone(),
            activation_id: query.activation_id.clone(),
            ..QueryFilter::default()
        };
        if forward_scan {
            filter.top_k = Some(fetch_limit);
        } else {
            filter.latest_k = Some(fetch_limit);
        }
        let mut scanned = self.query_events(filter).await?;
        let has_more_in_scan_direction = scanned.len() > scan_limit;
        if has_more_in_scan_direction {
            if forward_scan {
                scanned.truncate(scan_limit);
            } else {
                let overflow = scanned.len().saturating_sub(scan_limit);
                scanned.drain(..overflow);
            }
        }
        let scanned_count = scanned.len();
        let scanned_first_sequence = scanned.first().and_then(|event| event.sequence);
        let scanned_last_sequence = scanned.last().and_then(|event| event.sequence);
        let mut matching = scanned
            .into_iter()
            .filter(|event| ledger_event_matches_causal_scope(event, &query))
            .collect::<Vec<_>>();
        let (events, next_after_sequence, next_before_sequence) = if forward_scan {
            let has_more_matches = matching.len() > limit;
            matching.truncate(limit);
            let next_after = if has_more_matches {
                matching.last().and_then(|event| event.sequence)
            } else if has_more_in_scan_direction {
                scanned_last_sequence
            } else {
                None
            };
            (matching, next_after, None)
        } else {
            let matching_start = matching.len().saturating_sub(limit);
            let events = matching.split_off(matching_start);
            let next_before = if matching_start > 0 {
                events.first().and_then(|event| event.sequence)
            } else if has_more_in_scan_direction {
                scanned_first_sequence
            } else {
                None
            };
            // The newest scanned sequence remains useful as a live-refresh
            // cursor even though backward pagination uses next_before_sequence.
            (events, scanned_last_sequence, next_before)
        };
        Ok(LedgerQueryPage {
            context_id: query.context_id,
            generated_at: chrono::Utc::now(),
            events,
            scanned_count,
            scan_exhaustive: !has_more_in_scan_direction,
            next_after_sequence,
            next_before_sequence,
        })
    }

    pub fn runtime_status(&self) -> RuntimeStatus {
        let generated_at = chrono::Utc::now();
        let uptime_seconds = generated_at
            .signed_duration_since(self.inner.process_started_at)
            .num_seconds()
            .max(0) as u64;
        RuntimeStatus {
            generated_at,
            started: self.inner.started.load(Ordering::Acquire),
            uptime_seconds,
            recovery: self
                .inner
                .recovery
                .read()
                .map(|recovery| recovery.clone())
                .unwrap_or_default(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            git_commit: env!("MORPHZ_GIT_COMMIT").to_string(),
            agent_id: self.inner.identity.agent_id.clone(),
            context_id: self.inner.identity.context_id.clone(),
            principal_id: self.inner.identity.principal_id.clone(),
            model: self.model(),
            models: self.configured_models(),
            provider: self.inner.config.llm.provider.clone(),
            reasoning_effort: self
                .reasoning_effort()
                .map(|effort| effort.as_str().to_string()),
            tool_count: self.tool_names().len(),
            storage: self.inner.storage_label.clone(),
            storage_backend: self.inner.config.storage.backend,
            permission_mode: self.inner.config.permissions.mode,
            sandbox_mode: self.inner.config.permissions.sandbox_mode,
            reviewer: self.inner.config.permissions.reviewer,
        }
    }

    pub async fn mind_version(&self, context_id: &str) -> Result<u64, RuntimeError> {
        self.inner.orchestrator.mind_version(context_id).await
    }

    pub async fn audit_mind_projection(
        &self,
        context_id: &str,
    ) -> Result<crate::orchestrator::context::MindProjectionAudit, RuntimeError> {
        self.inner
            .orchestrator
            .audit_mind_projection(context_id)
            .await
    }

    pub async fn seed_context_from_mind(
        &self,
        source_context_id: &str,
        source_version: Option<u64>,
        target_context_id: &str,
    ) -> Result<crate::orchestrator::context::MindSeedReceipt, RuntimeError> {
        self.inner
            .orchestrator
            .seed_context_from_mind(source_context_id, source_version, target_context_id)
            .await
    }

    pub async fn context_encoding(
        &self,
        context_id: &str,
        session_id: &str,
    ) -> Result<ContextView, RuntimeError> {
        self.inner
            .orchestrator
            .get_context_encoding(context_id, session_id)
            .await
    }

    pub async fn context_projection(
        &self,
        context_id: &str,
        session_id: &str,
    ) -> Result<ContextView, RuntimeError> {
        self.inner
            .orchestrator
            .get_context_projection(context_id, session_id)
            .await
    }

    pub async fn search_recall(
        &self,
        request: RecallSearchRequest,
    ) -> Result<RecallSearchPage, RuntimeError> {
        self.inner.context_engine.search_recall(request).await
    }

    pub async fn recall_frame(
        &self,
        request: FrameRecallRequest,
    ) -> Result<FrameRecallPage, RuntimeError> {
        self.inner.context_engine.recall_frame(request).await
    }

    pub async fn inspect_recall_index(
        &self,
        context_id: &str,
    ) -> Result<crate::memory::RecallIndexAudit, RuntimeError> {
        ContextRecallService::inspect_recall_index(self.inner.context_engine.as_ref(), context_id)
            .await
    }

    pub async fn rebuild_recall_index(
        &self,
        context_id: &str,
    ) -> Result<crate::memory::RecallIndexAudit, RuntimeError> {
        ContextRecallService::rebuild_recall_index(self.inner.context_engine.as_ref(), context_id)
            .await
    }

    pub async fn apply_context_transaction(
        &self,
        context_id: &str,
        acting_session_id: &str,
        transaction: &str,
    ) -> Result<crate::orchestrator::context::ContextCommit, RuntimeError> {
        self.inner
            .context_engine
            .apply_context_transaction(context_id, acting_session_id, transaction)
            .await
    }
}

fn runtime_overview_principals_by_session(
    bindings: Vec<SessionPrincipalBinding>,
) -> HashMap<String, Vec<String>> {
    let mut by_session: HashMap<String, Vec<String>> = HashMap::new();
    for binding in bindings
        .into_iter()
        .filter(|binding| binding.unbound_at.is_none())
    {
        by_session
            .entry(binding.session_id)
            .or_default()
            .push(binding.principal_id);
    }
    for principal_ids in by_session.values_mut() {
        principal_ids.sort();
        principal_ids.dedup();
    }
    by_session
}

fn runtime_overview_session(
    session: SessionRecord,
    principal_ids: Vec<String>,
    threads: &[ThreadRecord],
    activations: &[ThreadActivationRecord],
    objectives: &[ObjectiveRecord],
    thread_by_root: &HashMap<String, ThreadRecord>,
) -> RuntimeOverviewSession {
    let running_activation_count = activations
        .iter()
        .filter(|activation| activation.status == ThreadActivationStatus::Running)
        .count();
    let queued_activation_count = activations
        .iter()
        .filter(|activation| activation.status == ThreadActivationStatus::Queued)
        .count();
    let pending_dialogue_turns = activations
        .iter()
        .filter(|activation| activation.status == ThreadActivationStatus::Queued)
        .filter(|activation| {
            thread_by_root
                .get(&activation.root_turn_id)
                .is_some_and(|thread| thread.kind == ThreadKind::DialogueTurn)
        })
        .count();
    let current_objective = objectives
        .first()
        .map(|objective| RuntimeOverviewObjective {
            id: objective.id.clone(),
            stated_objective: objective.stated_objective.clone(),
            status: objective.status,
            status_reason: objective.status_reason.clone(),
            wait_condition: objective.wait_condition.clone(),
            revision: objective.revision,
            updated_at: objective.updated_at,
        });
    let current_thread = threads.first().map(|thread| {
        let activation_statuses = activations
            .iter()
            .filter(|activation| activation.root_turn_id == thread.root_turn_id)
            .map(|activation| activation.status)
            .collect::<Vec<_>>();
        let phase = if activation_statuses
            .iter()
            .any(|status| *status == ThreadActivationStatus::Running)
        {
            ThreadPhase::Running
        } else if activation_statuses
            .iter()
            .any(|status| *status == ThreadActivationStatus::Queued)
        {
            ThreadPhase::Runnable
        } else if thread.control_state == ThreadControlState::Paused {
            ThreadPhase::Waiting
        } else {
            ThreadPhase::Idle
        };
        RuntimeOverviewThread {
            id: thread.id.clone(),
            kind: thread.kind,
            phase,
            control_state: thread.control_state,
            objective_id: (thread.supervision.supervisor_kind == ThreadSupervisorKind::Objective)
                .then(|| thread.supervision.supervisor_id.clone())
                .flatten(),
            target_id: thread.target_id.clone(),
            updated_at: thread.updated_at,
        }
    });

    let waiting_for_user = objectives.iter().any(|objective| {
        matches!(
            objective.wait_condition,
            Some(ObjectiveWaitCondition::UserInput { .. })
        )
    });
    let blocked = objectives
        .iter()
        .any(|objective| objective.status == ObjectiveStatus::Blocked);
    let paused = objectives
        .iter()
        .any(|objective| objective.status == ObjectiveStatus::Paused)
        || threads
            .iter()
            .any(|thread| thread.control_state == ThreadControlState::Paused);
    let waiting = objectives
        .iter()
        .any(|objective| objective.wait_condition.is_some())
        || !threads.is_empty();
    let state = if blocked {
        RuntimeSessionState::NeedsAttention
    } else if waiting_for_user {
        RuntimeSessionState::WaitingUser
    } else if running_activation_count > 0 {
        RuntimeSessionState::Running
    } else if queued_activation_count > 0 {
        RuntimeSessionState::Queued
    } else if paused {
        RuntimeSessionState::Paused
    } else if waiting {
        RuntimeSessionState::Waiting
    } else {
        RuntimeSessionState::Idle
    };

    RuntimeOverviewSession {
        session,
        principal_ids,
        state,
        attention_required: blocked || waiting_for_user,
        pending_dialogue_turns,
        open_thread_count: threads.len(),
        running_activation_count,
        current_thread,
        current_objective,
    }
}

fn ledger_event_matches_causal_scope(event: &Event, query: &LedgerQuery) -> bool {
    fn payload_string<'a>(event: &'a Event, key: &str) -> Option<&'a str> {
        event
            .payload
            .get(key)
            .and_then(|value| value.as_str())
            .or_else(|| {
                event
                    .payload
                    .get("route")
                    .and_then(|value| value.as_object())
                    .and_then(|route| route.get(key))
                    .and_then(|value| value.as_str())
            })
    }

    query
        .principal_id
        .as_deref()
        .is_none_or(|expected| payload_string(event, "principal_id") == Some(expected))
        && query
            .thread_id
            .as_deref()
            .is_none_or(|expected| payload_string(event, "thread_id") == Some(expected))
        && query
            .activation_id
            .as_deref()
            .is_none_or(|expected| payload_string(event, "activation_id") == Some(expected))
}

pub struct RuntimeEventStream {
    receiver: tokio::sync::mpsc::Receiver<Event>,
    bus: Weak<InMemoryEventBus>,
    subscription_id: String,
}

impl RuntimeEventStream {
    pub async fn recv(&mut self) -> Option<Event> {
        self.receiver.recv().await
    }

    pub fn try_recv(&mut self) -> Result<Event, tokio::sync::mpsc::error::TryRecvError> {
        self.receiver.try_recv()
    }
}

impl Drop for RuntimeEventStream {
    fn drop(&mut self) {
        if let Some(bus) = self.bus.upgrade() {
            bus.unsubscribe(&self.subscription_id);
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MessageReceipt {
    pub event_id: String,
    pub client_message_id: String,
    pub duplicate: bool,
}

/// Result of restarting one failed logical DialogueTurn in place. The user
/// Event and logical Thread identity remain stable; only the physical
/// Evaluation generation advances.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DialogueTurnRetryReceipt {
    pub event_id: String,
    pub root_turn_id: String,
    pub thread_id: String,
    pub generation: u64,
    pub duplicate: bool,
}

#[derive(Clone)]
pub struct SessionHandle {
    runtime: MorphzRuntime,
    id: String,
}

impl SessionHandle {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub async fn record(&self) -> Result<Option<SessionRecord>, RuntimeError> {
        self.runtime.get_session(&self.id).await
    }

    pub async fn send(
        &self,
        text: impl Into<String>,
        actor: impl Into<String>,
        client_message_id: Option<String>,
    ) -> Result<MessageReceipt, RuntimeError> {
        self.runtime.bind_default_principal(&self.id).await?;
        self.send_as_principal(
            text,
            actor,
            self.runtime.identity().principal_id.clone(),
            client_message_id,
        )
        .await
    }

    pub async fn send_authenticated(
        &self,
        text: impl Into<String>,
        actor: impl Into<String>,
        evidence: IdentityEvidence,
        client_message_id: Option<String>,
    ) -> Result<MessageReceipt, RuntimeError> {
        let assertion = self.runtime.authenticate_identity(evidence).await?;
        self.runtime.ensure_principal(assertion.clone()).await?;
        self.send_as_principal(text, actor, assertion.principal_id, client_message_id)
            .await
    }

    pub async fn send_as_principal(
        &self,
        text: impl Into<String>,
        actor: impl Into<String>,
        principal_id: impl Into<String>,
        client_message_id: Option<String>,
    ) -> Result<MessageReceipt, RuntimeError> {
        self.send_as_principal_with_harness(text, actor, principal_id, client_message_id, None)
            .await
    }

    pub async fn send_as_principal_with_harness(
        &self,
        text: impl Into<String>,
        actor: impl Into<String>,
        principal_id: impl Into<String>,
        client_message_id: Option<String>,
        requested_harness: Option<crate::harness::ExactHarnessRef>,
    ) -> Result<MessageReceipt, RuntimeError> {
        self.send_as_principal_with_harness_and_attachments(
            text,
            actor,
            principal_id,
            client_message_id,
            requested_harness,
            Vec::new(),
        )
        .await
    }

    pub async fn send_as_principal_with_harness_and_attachments(
        &self,
        text: impl Into<String>,
        actor: impl Into<String>,
        principal_id: impl Into<String>,
        client_message_id: Option<String>,
        requested_harness: Option<crate::harness::ExactHarnessRef>,
        attachments: Vec<crate::sdk::MessageAttachmentInput>,
    ) -> Result<MessageReceipt, RuntimeError> {
        let session = self
            .runtime
            .get_session(&self.id)
            .await?
            .ok_or_else(|| format!("Session '{}' 不存在", self.id))?;
        if session.status == crate::memory::SessionStatus::Archived {
            return Err("归档 Session 不能接收新消息".into());
        }
        let text = text.into().trim().to_string();
        if text.is_empty() && attachments.is_empty() {
            return Err("消息正文和附件不能同时为空".into());
        }
        if text.chars().count() > 1_000_000 {
            return Err("消息正文超过 1,000,000 字符".into());
        }
        let principal_id = principal_id.into();
        if !self
            .runtime
            .inner
            .store
            .verify_session_principal(&self.id, &principal_id)
            .await?
        {
            return Err(format!(
                "Principal '{}' 未绑定到 Session '{}'，拒绝接收消息",
                principal_id, self.id
            )
            .into());
        }
        let client_message_id = client_message_id.unwrap_or_else(|| runtime_id("client"));
        let event_id = runtime_id("msg");
        let attachment_metadata = persist_message_attachments(
            &self.runtime.inner.config.background_task.artifact_dir,
            &self.id,
            &event_id,
            attachments,
        )
        .await?;
        let mut payload = serde_json::Map::from_iter([
            ("context_id".to_string(), json!(session.context_id)),
            ("session_id".to_string(), json!(self.id)),
            ("principal_id".to_string(), json!(principal_id)),
            ("client_message_id".to_string(), json!(client_message_id)),
            ("text".to_string(), json!(text)),
        ]);
        if !attachment_metadata.is_empty() {
            payload.insert("attachments".to_string(), Value::Array(attachment_metadata));
        }
        if let Some(reference) = requested_harness {
            let id = reference.id.trim();
            let version = reference.version.trim();
            if id.is_empty() || version.is_empty() {
                return Err("Harness id/version 不能为空".into());
            }
            let harness = self
                .runtime
                .inner
                .harness_registry
                .get(id, version)
                .ok_or_else(|| format!("Harness '{id}@{version}' 未安装"))?;
            let artifact_hash = harness.artifact_hash().ok_or_else(|| {
                format!("Harness '{id}@{version}' 没有 artifact hash，不能精确绑定")
            })?;
            payload.insert("requested_harness_id".to_string(), json!(id));
            payload.insert("requested_harness_version".to_string(), json!(version));
            payload.insert(
                "requested_harness_artifact_hash".to_string(),
                json!(artifact_hash),
            );
        }
        let event = Event::new(
            event_id.clone(),
            actor.into(),
            TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            payload,
        );
        match self
            .runtime
            .inner
            .store
            .claim_message(&self.id, &client_message_id, &event)
            .await?
        {
            MessageClaim::Existing { event_id } => Ok(MessageReceipt {
                event_id,
                client_message_id,
                duplicate: true,
            }),
            MessageClaim::Accepted => {
                self.runtime.publish(event).await?;
                Ok(MessageReceipt {
                    event_id,
                    client_message_id,
                    duplicate: false,
                })
            }
        }
    }

    pub fn cancel(&self) -> bool {
        self.runtime.cancel_session(&self.id)
    }

    pub async fn inspect_context(&self) -> Result<crate::sexpr::SExpr, RuntimeError> {
        self.runtime.inspect_session_context(&self.id).await
    }

    pub async fn inspect_context_view(&self) -> Result<ContextView, RuntimeError> {
        self.runtime.inspect_session_context_view(&self.id).await
    }

    pub async fn events(&self, after_sequence: Option<u64>) -> Result<Vec<Event>, RuntimeError> {
        self.runtime
            .query_events(QueryFilter {
                session_id: Some(self.id.clone()),
                top_k: Some(1_000),
                ..Default::default()
            })
            .await
            .map(|events| {
                events
                    .into_iter()
                    .filter(|event| {
                        after_sequence
                            .is_none_or(|after| event.sequence.is_some_and(|seq| seq > after))
                    })
                    .collect()
            })
    }

    pub async fn retry_dialogue_turn(
        &self,
        root_turn_id: impl Into<String>,
        expected_thread_revision: u64,
        expected_result_event_id: impl Into<String>,
        retry_request_id: impl Into<String>,
    ) -> Result<DialogueTurnRetryReceipt, RuntimeError> {
        self.runtime.bind_default_principal(&self.id).await?;
        self.retry_dialogue_turn_as_principal(
            root_turn_id,
            self.runtime.identity().principal_id.clone(),
            expected_thread_revision,
            expected_result_event_id,
            retry_request_id,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn retry_dialogue_turn_as_principal(
        &self,
        root_turn_id: impl Into<String>,
        principal_id: impl Into<String>,
        expected_thread_revision: u64,
        expected_result_event_id: impl Into<String>,
        retry_request_id: impl Into<String>,
    ) -> Result<DialogueTurnRetryReceipt, RuntimeError> {
        let session = self
            .runtime
            .get_session(&self.id)
            .await?
            .ok_or_else(|| format!("Session '{}' 不存在", self.id))?;
        if session.status == crate::memory::SessionStatus::Archived {
            return Err("归档 Session 不能重启 DialogueTurn".into());
        }
        let principal_id = principal_id.into();
        if !self
            .runtime
            .inner
            .store
            .verify_session_principal(&self.id, &principal_id)
            .await?
        {
            return Err(format!(
                "Principal '{}' 未绑定到 Session '{}'，拒绝重启 DialogueTurn",
                principal_id, self.id
            )
            .into());
        }
        let root_turn_id = root_turn_id.into();
        let retry_request_id = retry_request_id.into();
        if root_turn_id.trim().is_empty() || retry_request_id.trim().is_empty() {
            return Err("root_turn_id 与 retry_request_id 不能为空".into());
        }
        let expected_result_event_id = expected_result_event_id.into();
        let thread = self
            .runtime
            .inner
            .store
            .get_thread_by_root(&root_turn_id)
            .await?
            .ok_or_else(|| format!("DialogueTurn '{}' 不存在", root_turn_id))?;
        if thread.session_id != self.id || thread.context_id != session.context_id {
            return Err(format!(
                "DialogueTurn '{}' 不属于 Session '{}'",
                root_turn_id, self.id
            )
            .into());
        }
        if thread
            .initiating_principal_id
            .as_deref()
            .is_some_and(|owner| owner != principal_id)
        {
            return Err("当前 Principal 不能重启其他身份发起的 DialogueTurn".into());
        }

        let digest = Sha256::digest(
            format!("{}\0{}\0{}", self.id, root_turn_id, retry_request_id).as_bytes(),
        );
        let event_id = format!("dialogue_retry_{digest:x}");
        let event_id = event_id[..48].to_string();
        let event = Event::new(
            event_id.clone(),
            "Runtime-DialogueRetry".to_string(),
            TYPE_INFER_REQUEST.to_string(),
            "chat/dialogue_retry".to_string(),
            serde_json::Map::from_iter([
                ("context_id".to_string(), json!(session.context_id)),
                ("session_id".to_string(), json!(self.id)),
                ("principal_id".to_string(), json!(principal_id)),
                ("root_turn_id".to_string(), json!(root_turn_id)),
                ("thread_id".to_string(), json!(thread.id)),
                ("retry_request_id".to_string(), json!(retry_request_id)),
                (
                    "previous_result_event_id".to_string(),
                    json!(expected_result_event_id),
                ),
                ("runtime_force_evaluation".to_string(), json!(true)),
            ]),
        );
        let mutation = self
            .runtime
            .inner
            .store
            .restart_dialogue_turn(DialogueTurnRetryRequest {
                expected_thread_revision,
                expected_result_event_id,
                event: event.clone(),
            })
            .await?;
        let (thread_id, generation, duplicate) = match mutation {
            DialogueTurnRetryMutation::Accepted {
                thread_id,
                generation,
            } => (thread_id, generation, false),
            DialogueTurnRetryMutation::Existing {
                thread_id,
                generation,
            } => (thread_id, generation, true),
            DialogueTurnRetryMutation::Conflict { current } => {
                return Err(format!(
                    "DialogueTurn 已变化：期望 r{}，当前 r{} / generation {}",
                    expected_thread_revision, current.revision, current.generation
                )
                .into());
            }
            DialogueTurnRetryMutation::Rejected { reason, .. } => return Err(reason.into()),
            DialogueTurnRetryMutation::NotFound => {
                return Err(format!("DialogueTurn '{}' 不存在", root_turn_id).into());
            }
        };

        // The retry Event and its Signal Outbox were committed atomically by
        // the Store. Dispatch the exact durable representation; the Outbox
        // remains the crash-safe fallback and materialization is idempotent.
        let durable_event = self
            .runtime
            .inner
            .store
            .query(QueryFilter {
                event_id: Some(event_id.clone()),
                context_id: Some(session.context_id),
                ..QueryFilter::default()
            })
            .await?
            .into_iter()
            .find(|stored| stored.id == event_id)
            .ok_or_else(|| format!("DialogueTurn retry Event '{}' 未持久化", event_id))?;
        self.runtime
            .inner
            .bus
            .dispatch_persisted(durable_event)
            .await?;
        Ok(DialogueTurnRetryReceipt {
            event_id,
            root_turn_id,
            thread_id,
            generation,
            duplicate,
        })
    }
}

#[derive(Clone)]
pub struct AgentHandle {
    runtime: MorphzRuntime,
    id: String,
}

impl AgentHandle {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub async fn record(&self) -> Result<Option<AgentRecord>, RuntimeError> {
        self.runtime.get_agent(&self.id).await
    }
}

#[derive(Clone)]
pub struct ContextHandle {
    runtime: MorphzRuntime,
    id: String,
}

impl ContextHandle {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub async fn record(&self) -> Result<Option<CognitiveContextRecord>, RuntimeError> {
        self.runtime.get_context(&self.id).await
    }

    pub async fn sessions(&self, archived: bool) -> Result<Vec<SessionRecord>, RuntimeError> {
        self.runtime.list_context_sessions(&self.id, archived).await
    }
}

fn runtime_id(prefix: &str) -> String {
    let sequence = RUNTIME_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!(
        "{}_{}_{}_{}",
        prefix,
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        std::process::id(),
        sequence
    )
}

fn absolute_runtime_path(path: impl AsRef<std::path::Path>) -> PathBuf {
    let path = path.as_ref();
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn env_flag_enabled(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ProviderConfig, ProviderModelConfig};
    use crate::llm::{Message, Response, ToolCallRepr, ToolDefinition};
    use crate::memory::SessionDirectoryStore as _;
    use crate::permission::PermissionMode;
    use crate::sdk::MessageAttachmentInput;
    use tempfile::NamedTempFile;

    struct ReplyClient;

    #[test]
    fn model_context_capacity_uses_exact_provider_model_profile_and_falls_back() {
        let mut config = AppConfig::default();
        config.llm.provider = Some("proxy".to_string());
        config.orchestrator.context_hard_token_limit = 262_144;
        let mut provider = ProviderConfig::default();
        provider.models.insert(
            "model-a".to_string(),
            ProviderModelConfig {
                context_window_tokens: Some(1_000_000),
                max_input_tokens: None,
                max_output_tokens: Some(32_000),
            },
        );
        config.providers.insert("proxy".to_string(), provider);

        let configured = resolve_model_context_capacity(&config, "model-a");
        assert_eq!(configured.prompt_token_limit, 968_000);
        assert_eq!(configured.context_window_tokens, Some(1_000_000));
        assert_eq!(configured.max_output_tokens, Some(32_000));
        assert_eq!(configured.source, "provider-model-config");

        let fallback = resolve_model_context_capacity(&config, "MODEL-A");
        assert_eq!(fallback.prompt_token_limit, 262_144);
        assert_eq!(fallback.context_window_tokens, None);
        assert_eq!(fallback.source, "runtime-default");
    }

    #[tokio::test]
    async fn message_attachments_store_bytes_outside_the_ledger_by_digest() {
        let artifact_root = tempfile::tempdir().unwrap();
        let input = MessageAttachmentInput {
            name: "../diagram.png".to_string(),
            media_type: "image/png".to_string(),
            data: b"image-bytes".to_vec(),
        };
        let metadata = persist_message_attachments(
            artifact_root.path().to_str().unwrap(),
            "session-attachment-test",
            "event-attachment-test",
            vec![input.clone(), input],
        )
        .await
        .unwrap();

        assert_eq!(metadata.len(), 2);
        assert_eq!(metadata[0]["name"], "diagram.png");
        assert_eq!(metadata[0]["media_type"], "image/png");
        assert_eq!(metadata[0]["size_bytes"], 11);
        assert_eq!(metadata[0]["sha256"], metadata[1]["sha256"]);
        assert_eq!(metadata[0]["storage_path"], metadata[1]["storage_path"]);
        let stored_path = metadata[0]["storage_path"].as_str().unwrap();
        assert_eq!(tokio::fs::read(stored_path).await.unwrap(), b"image-bytes");

        let metadata_json = serde_json::to_vec(&metadata).unwrap();
        assert!(!metadata_json
            .windows(b"image-bytes".len())
            .any(|window| window == b"image-bytes"));
    }

    struct BlockingArtifactTransferBackend {
        entered: Arc<tokio::sync::Notify>,
        dropped: Arc<AtomicBool>,
    }

    struct BlockingArtifactTransferGuard(Arc<AtomicBool>);

    impl Drop for BlockingArtifactTransferGuard {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[async_trait::async_trait]
    impl crate::execution_target::ArtifactTransferExecutionBackend for BlockingArtifactTransferBackend {
        fn name(&self) -> &'static str {
            "000_test_blocking"
        }

        fn supports(
            &self,
            source: &crate::execution_target::ExecutionRouteSnapshot,
            destination: &crate::execution_target::ExecutionRouteSnapshot,
        ) -> bool {
            source.backend_kind == crate::memory::ExecutionTargetKind::InProcessLocal
                && destination.backend_kind == crate::memory::ExecutionTargetKind::InProcessLocal
        }

        async fn execute_transfer(
            &self,
            _job: &ExecutionJobRecord,
            _routes: &crate::execution_target::ArtifactTransferRouteSnapshot,
            _request: &ArtifactTransferRequest,
        ) -> Result<
            crate::artifact::ArtifactTransferReceipt,
            crate::execution_target::TargetExecutionError,
        > {
            let _guard = BlockingArtifactTransferGuard(self.dropped.clone());
            self.entered.notify_waiters();
            std::future::pending().await
        }
    }

    #[test]
    fn model_usage_cost_requires_explicit_versioned_rates() {
        let usage = ModelUsage {
            input_tokens: Some(1_000_000),
            uncached_input_tokens: Some(600_000),
            cached_input_tokens: Some(300_000),
            cache_write_input_tokens: Some(100_000),
            output_tokens: Some(200_000),
            ..Default::default()
        };
        let mut pricing = crate::config::UsagePricingConfig::default();
        assert!(calculate_model_usage_cost(&pricing, Some("model-a"), &usage).is_none());
        pricing.models.insert(
            "model-a".to_string(),
            crate::config::ModelUsagePrice {
                version: "2026-07".to_string(),
                input_per_million: Some(2.0),
                cached_input_per_million: Some(0.5),
                cache_write_input_per_million: Some(2.5),
                output_per_million: Some(8.0),
            },
        );
        let cost = calculate_model_usage_cost(&pricing, Some("model-a"), &usage).unwrap();
        assert_eq!(cost.currency, "USD");
        assert_eq!(cost.pricing_version, "2026-07");
        assert!((cost.amount - 3.2).abs() < f64::EPSILON);
    }

    struct ExternalIdentityProvider;

    #[async_trait::async_trait]
    impl IdentityProvider for ExternalIdentityProvider {
        fn provider_id(&self) -> &str {
            "test-oauth"
        }

        async fn authenticate(
            &self,
            evidence: IdentityEvidence,
        ) -> Result<PrincipalAssertion, crate::identity::IdentityError> {
            if evidence.channel != "dashboard" {
                return Err("unexpected identity channel".into());
            }
            Ok(PrincipalAssertion {
                principal_id: "principal-external".to_string(),
                provider_id: self.provider_id().to_string(),
                assurance: "test-authenticated".to_string(),
                display_name: Some("External User".to_string()),
            })
        }
    }

    struct BlockingReplyClient {
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    }

    struct PhysicalBatchClient {
        calls: AtomicU64,
        observed_complete_batch: Arc<AtomicBool>,
    }

    struct DurableEvalClient {
        calls: AtomicU64,
        path: String,
        observed_plan_result: Arc<AtomicBool>,
    }

    struct HarnessEntryClient {
        calls: AtomicU64,
        objective_id: String,
        observed_entry_result: Arc<AtomicBool>,
    }

    struct OrdinaryHarnessEntryClient {
        calls: AtomicU64,
        observed_entry_result: Arc<AtomicBool>,
    }

    struct HarnessDiscoveryClient {
        calls: AtomicU64,
        observed_mount: Arc<AtomicBool>,
    }

    struct DetachedExecClient {
        calls: AtomicU64,
    }

    struct LongLivedProcessReplyClient {
        calls: AtomicU64,
    }

    struct DeclaredServiceClient {
        calls: AtomicU64,
    }

    struct RecoveryMergeDeliveryClient {
        calls: AtomicU64,
        observed_both_results: Arc<AtomicBool>,
    }

    struct DeliverySnapshotRaceClient {
        calls: AtomicU64,
        entered: tokio::sync::Notify,
        release: tokio::sync::Notify,
    }

    struct NoDeliveryModelClient {
        calls: AtomicU64,
    }

    struct ApprovalReadClient {
        calls: AtomicU64,
        path: String,
        expected_rejected: bool,
        observed_result: Arc<AtomicBool>,
    }

    struct PreflightRejectedExecClient {
        calls: AtomicU64,
        protected_path: String,
        observed_result: Arc<AtomicBool>,
    }

    struct TwoManagedSshExecClient {
        calls: AtomicU64,
        target_id: String,
    }

    struct RecordingManagedSshBackend {
        calls: AtomicU64,
    }

    struct StaticApprovalProvider {
        decision: ApprovalDecision,
        delay: std::time::Duration,
        calls: AtomicU64,
    }

    /// Stops the processes a test deliberately left running. The registry is
    /// process-wide and the suite runs in parallel, so a test that walks away
    /// from a live process taxes every test scheduled after it.
    fn kill_tasks_for_context(context_id: &str) {
        let tasks = crate::tool::get_tasks_map();
        let ids = tasks
            .iter()
            .filter(|task| task.context_id == context_id)
            .map(|task| (task.id.clone(), task.pgid))
            .collect::<Vec<_>>();
        for (id, pgid) in ids {
            if pgid > 0 {
                let _ = nix::sys::signal::killpg(
                    nix::unistd::Pid::from_raw(pgid),
                    nix::sys::signal::Signal::SIGKILL,
                );
            }
            tasks.remove(&id);
        }
    }

    fn text_response(content: impl Into<String>) -> Response {
        Response {
            content: content.into(),
            tool_calls: Vec::new(),
        }
    }

    fn no_reply_response(id: impl Into<String>) -> Response {
        Response {
            content: String::new(),
            tool_calls: vec![ToolCallRepr {
                id: id.into(),
                r#type: "function".to_string(),
                func_name: "no_reply".to_string(),
                arguments: json!({"mode":"silent"}).to_string(),
            }],
        }
    }

    fn wait_response(id: impl Into<String>) -> Response {
        Response {
            content: String::new(),
            tool_calls: vec![ToolCallRepr {
                id: id.into(),
                r#type: "function".to_string(),
                func_name: "no_reply".to_string(),
                arguments: json!({"mode":"wait"}).to_string(),
            }],
        }
    }

    #[async_trait::async_trait]
    impl Client for ReplyClient {
        async fn create_completion(
            &self,
            _messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            Ok(text_response("runtime-ok"))
        }
    }

    #[tokio::test]
    async fn runtime_builder_accepts_one_injected_complete_store() {
        let database = NamedTempFile::new().unwrap();
        let sqlite = Arc::new(
            SqliteStore::new(database.path().to_str().unwrap())
                .await
                .unwrap(),
        );
        let runtime = MorphzRuntime::builder(AppConfig::default(), Arc::new(ReplyClient))
            .store(
                "sqlite:injected-test",
                Arc::clone(&sqlite) as Arc<dyn RuntimeStore>,
            )
            .build()
            .await
            .unwrap();

        assert_eq!(runtime.storage_label(), "sqlite:injected-test");
        assert_eq!(runtime.sqlite_database_path(), None);
        runtime
            .ensure_agent(NewAgent {
                id: "injected-agent".to_string(),
                title: "Injected Agent".to_string(),
                root_context_id: "injected-context".to_string(),
            })
            .await
            .unwrap();
        assert!(sqlite.get_agent("injected-agent").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn attention_acknowledgement_is_durable_audit_not_scheduler_work() {
        let database = NamedTempFile::new().unwrap();
        let runtime = MorphzRuntime::builder(AppConfig::default(), Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        let context_id = runtime.identity().context_id.clone();
        let before = runtime
            .scheduler_snapshot(&context_id, SchedulerQuery::default())
            .await
            .unwrap();

        let acknowledged = runtime
            .acknowledge_attention(
                &context_id,
                AcknowledgeAttentionCommand {
                    key: "execution_job:job-1:r4:failed".to_string(),
                    source_kind: "execution_job".to_string(),
                    source_id: "job-1".to_string(),
                    source_revision: 4,
                    rationale: Some("operator reviewed failure".to_string()),
                },
            )
            .await
            .unwrap();
        let records = runtime
            .attention_acknowledgements(&context_id)
            .await
            .unwrap();
        assert_eq!(records, vec![acknowledged]);

        let after = runtime
            .scheduler_snapshot(&context_id, SchedulerQuery::default())
            .await
            .unwrap();
        assert_eq!(after.summary.open_threads, before.summary.open_threads);
        assert_eq!(
            after.summary.pending_signals,
            before.summary.pending_signals
        );
        assert_eq!(
            after.summary.queued_activations,
            before.summary.queued_activations
        );
        assert_eq!(
            after.summary.running_activations,
            before.summary.running_activations
        );
    }

    #[tokio::test]
    async fn pluggable_identity_provider_anchors_authenticated_messages_without_owning_runtime_default(
    ) {
        let database = NamedTempFile::new().unwrap();
        let runtime = MorphzRuntime::builder(AppConfig::default(), Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .identity_provider(Arc::new(ExternalIdentityProvider))
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();

        let default_principal = runtime
            .inner
            .store
            .get_principal(&runtime.identity().principal_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            default_principal.provider_id,
            RUNTIME_DEFAULT_IDENTITY_PROVIDER_ID
        );

        let assertion = runtime
            .authenticate_identity(IdentityEvidence {
                channel: "dashboard".to_string(),
                credential: Some(Arc::from(b"opaque-test-token".as_slice())),
            })
            .await
            .unwrap();
        let session = runtime
            .create_session_for_principal(
                NewSession {
                    id: "external-identity-session".to_string(),
                    agent_id: runtime.identity().agent_id.clone(),
                    context_id: runtime.identity().context_id.clone(),
                    parent_session_id: None,
                    title: "External identity".to_string(),
                    mount_kind: crate::memory::SessionMountKind::ExistingContext,
                },
                assertion,
            )
            .await
            .unwrap();
        let receipt = runtime
            .session(session.id)
            .send_authenticated(
                "hello from authenticated ingress",
                "External User",
                IdentityEvidence {
                    channel: "dashboard".to_string(),
                    credential: Some(Arc::from(b"opaque-test-token".as_slice())),
                },
                Some("external-message-1".to_string()),
            )
            .await
            .unwrap();
        let event = runtime
            .query_events(QueryFilter {
                event_id: Some(receipt.event_id),
                ..Default::default()
            })
            .await
            .unwrap()
            .into_iter()
            .next()
            .unwrap();
        assert_eq!(
            event
                .payload
                .get("principal_id")
                .and_then(|value| value.as_str()),
            Some("principal-external")
        );

        let forged_event_id = "forged-cross-session-principal";
        let forged = Event::new(
            forged_event_id.to_string(),
            "Untrusted Adapter".to_string(),
            TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            [
                (
                    "context_id".to_string(),
                    json!(runtime.identity().context_id),
                ),
                ("session_id".to_string(), json!("external-identity-session")),
                (
                    "principal_id".to_string(),
                    json!(runtime.identity().principal_id),
                ),
                ("text".to_string(), json!("I claim another identity")),
            ]
            .into_iter()
            .collect(),
        );
        let _ = runtime.publish(forged).await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(runtime
            .inner
            .store
            .get_thread_by_root(forged_event_id)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn postgres_storage_requires_an_explicit_named_environment_credential() {
        let mut config = AppConfig::default();
        config.storage.backend = StorageBackend::Postgres;
        config.storage.postgres.url_env =
            "MORPHZ_TEST_INTENTIONALLY_MISSING_POSTGRES_URL_7E6C5F".to_string();
        let error = MorphzRuntime::builder(config, Arc::new(ReplyClient))
            .build()
            .await
            .err()
            .expect("missing named PostgreSQL credential must fail closed");
        assert!(error
            .to_string()
            .contains("MORPHZ_TEST_INTENTIONALLY_MISSING_POSTGRES_URL_7E6C5F"));
    }

    #[tokio::test]
    async fn runtime_builder_selects_postgres_only_when_explicitly_configured() {
        let Ok(_) = std::env::var("MORPHZ_TEST_POSTGRES_URL") else {
            return;
        };
        let mut config = AppConfig::default();
        config.storage.backend = StorageBackend::Postgres;
        config.storage.postgres.url_env = "MORPHZ_TEST_POSTGRES_URL".to_string();
        config.storage.postgres.max_connections = 4;
        let runtime = MorphzRuntime::builder(config, Arc::new(ReplyClient))
            .build()
            .await
            .unwrap();
        assert_eq!(
            runtime.storage_label(),
            "postgres:env:MORPHZ_TEST_POSTGRES_URL"
        );
        assert_eq!(runtime.sqlite_database_path(), None);
    }

    #[async_trait::async_trait]
    impl Client for BlockingReplyClient {
        async fn create_completion(
            &self,
            _messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            self.entered.notify_one();
            self.release.notified().await;
            Ok(text_response("lease-complete"))
        }
    }

    #[async_trait::async_trait]
    impl Client for PhysicalBatchClient {
        async fn create_completion(
            &self,
            messages: Vec<Message>,
            tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call == 0 {
                assert!(tools.iter().any(|tool| tool.name == "list_files"));
                return Ok(Response {
                    content: String::new(),
                    tool_calls: vec![
                        ToolCallRepr {
                            id: "probe-a".to_string(),
                            r#type: "function".to_string(),
                            func_name: "list_files".to_string(),
                            arguments: json!({
                                "path": ".",
                                "glob": "Cargo.toml",
                                "max_results": 10
                            })
                            .to_string(),
                        },
                        ToolCallRepr {
                            id: "probe-b".to_string(),
                            r#type: "function".to_string(),
                            func_name: "list_files".to_string(),
                            arguments: json!({
                                "path": ".",
                                "glob": "morphz/Cargo.toml",
                                "max_results": 10
                            })
                            .to_string(),
                        },
                    ],
                });
            }
            if call == 1 {
                let delivered_tool_results = messages
                    .iter()
                    .filter(|message| message.role == "tool")
                    .filter_map(|message| message.tool_call_id.as_deref())
                    .collect::<std::collections::HashSet<_>>();
                let complete = delivered_tool_results.len() == 2
                    && delivered_tool_results.contains("probe-a")
                    && delivered_tool_results.contains("probe-b");
                self.observed_complete_batch
                    .store(complete, Ordering::SeqCst);
                if !complete {
                    return Err(
                        "model resumed before the full physical tool batch was durable".into(),
                    );
                }
                return Ok(text_response("physical-batch-complete"));
            }
            Err("interactive physical tool batch caused a redundant Delivery evaluation".into())
        }
    }

    #[async_trait::async_trait]
    impl Client for DurableEvalClient {
        async fn create_completion(
            &self,
            messages: Vec<Message>,
            tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            match self.calls.fetch_add(1, Ordering::SeqCst) {
                0 => {
                    assert!(tools.iter().any(|tool| tool.name == "eval"));
                    assert!(tools.iter().any(|tool| tool.name == "read"));
                    let quoted_path = serde_json::to_string(&self.path)?;
                    Ok(Response {
                        content: String::new(),
                        tool_calls: vec![ToolCallRepr {
                            id: "durable-eval".to_string(),
                            r#type: "function".to_string(),
                            func_name: "eval".to_string(),
                            arguments: json!({
                                "program": format!(
                                    "(eval (requires (tools read)) (seq (bind body (call read (path {quoted_path}))) $body))"
                                )
                            })
                            .to_string(),
                        }],
                    })
                }
                1 => {
                    let observed = messages.iter().any(|message| {
                        message.role == "tool" && message.content.contains("durable-plan-fixture")
                    });
                    self.observed_plan_result.store(observed, Ordering::SeqCst);
                    if !observed {
                        return Err("后续模型求值未观测到 durable eval 的真实工具结果".into());
                    }
                    Ok(text_response("durable-eval-complete"))
                }
                _ => Err("durable eval 产生了冗余模型求值".into()),
            }
        }
    }

    #[async_trait::async_trait]
    impl Client for HarnessEntryClient {
        async fn create_completion(
            &self,
            messages: Vec<Message>,
            tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            match self.calls.fetch_add(1, Ordering::SeqCst) {
                0 => {
                    assert!(tools.iter().any(|tool| tool.name == "objective_update"));
                    assert!(messages
                        .iter()
                        .any(|message| message.content.contains("(entry (owner runtime)")));
                    let observed = messages.iter().any(|message| {
                        message.role == "tool"
                            && message.content.contains("automatic-harness-entry-fixture")
                    });
                    self.observed_entry_result.store(observed, Ordering::SeqCst);
                    if !observed {
                        return Err(
                            "Harness entry 的 Plan 结果没有回到 Objective Evaluation".into()
                        );
                    }
                    Ok(Response {
                        content: String::new(),
                        tool_calls: vec![ToolCallRepr {
                            id: "complete-harness-objective".to_string(),
                            r#type: "function".to_string(),
                            func_name: "objective_update".to_string(),
                            arguments: json!({
                                "objective_id": self.objective_id,
                                "base_revision": objective_revision_from_messages(
                                    &messages,
                                    &self.objective_id
                                ),
                                "status": "completed",
                                "reason": "Runtime 已自动执行 Harness entry",
                                "evidence_refs": []
                            })
                            .to_string(),
                        }],
                    })
                }
                1 => Ok(text_response("automatic-harness-entry-complete")),
                _ => Err("Harness entry 被重复求值".into()),
            }
        }
    }

    #[async_trait::async_trait]
    impl Client for OrdinaryHarnessEntryClient {
        async fn create_completion(
            &self,
            messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            if self.calls.fetch_add(1, Ordering::SeqCst) > 0 {
                return Err("普通 Evaluation 的 Harness entry 被重复求值".into());
            }
            assert!(messages
                .iter()
                .any(|message| message.content.contains("(entry (owner runtime)")));
            let observed = messages.iter().any(|message| {
                message.role == "tool" && message.content.contains("ordinary-harness-entry-fixture")
            });
            self.observed_entry_result.store(observed, Ordering::SeqCst);
            if !observed {
                return Err("Harness entry 的 Plan 结果没有回到普通 Evaluation".into());
            }
            Ok(text_response("ordinary-harness-entry-complete"))
        }
    }

    #[async_trait::async_trait]
    impl Client for HarnessDiscoveryClient {
        async fn create_completion(
            &self,
            messages: Vec<Message>,
            tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            match self.calls.fetch_add(1, Ordering::SeqCst) {
                0 => {
                    assert!(tools.iter().any(|tool| tool.name == "harness_list"));
                    assert!(tools.iter().any(|tool| tool.name == "harness_select"));
                    assert!(!messages
                        .iter()
                        .any(|message| message.content.contains("Harness discovery-test@1.0.0")));
                    Ok(Response {
                        content: String::new(),
                        tool_calls: vec![ToolCallRepr {
                            id: "list-discoverable-harnesses".to_string(),
                            r#type: "function".to_string(),
                            func_name: "harness_list".to_string(),
                            arguments: "{}".to_string(),
                        }],
                    })
                }
                1 => {
                    assert!(messages.iter().any(|message| {
                        message.role == "tool"
                            && message.content.contains("discovery-test")
                            && message.content.contains("1.0.0")
                    }));
                    assert!(!messages.iter().any(|message| message
                        .content
                        .contains("(evaluation-profile (id discovery-test)")));
                    Ok(Response {
                        content: String::new(),
                        tool_calls: vec![ToolCallRepr {
                            id: "select-discovered-harness".to_string(),
                            r#type: "function".to_string(),
                            func_name: "harness_select".to_string(),
                            arguments: json!({
                                "id": "discovery-test",
                                "version": "1.0.0",
                                "reason": "当前请求需要测试领域纪律"
                            })
                            .to_string(),
                        }],
                    })
                }
                2 => {
                    let observed = messages.iter().any(|message| {
                        message.content.contains("(evaluation-profile")
                            && message.content.contains("(harness-binding")
                            && message.content.contains("(id discovery-test)")
                            && message.content.contains("discovery-contract")
                    });
                    self.observed_mount.store(observed, Ordering::SeqCst);
                    if !observed {
                        return Err("自主选择的 Harness 没有挂载到 successor Evaluation".into());
                    }
                    Ok(text_response("discovered-harness-complete"))
                }
                _ => Err("Harness 自主发现产生了冗余模型求值".into()),
            }
        }
    }

    #[async_trait::async_trait]
    impl Client for DetachedExecClient {
        async fn create_completion(
            &self,
            messages: Vec<Message>,
            tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            match self.calls.fetch_add(1, Ordering::SeqCst) {
                0 => {
                    assert!(tools.iter().any(|tool| tool.name == "exec"));
                    assert!(tools.iter().any(|tool| tool.name == "check_task_after"));
                    assert!(!tools.iter().any(|tool| tool.name == "wait_task"));
                    Ok(Response {
                        content: String::new(),
                        tool_calls: vec![ToolCallRepr {
                            id: "detached-exec".to_string(),
                            r#type: "function".to_string(),
                            func_name: "exec".to_string(),
                            arguments: json!({
                                "command": "sleep 0.2; printf detached-done",
                                "wait_ms": 1
                            })
                            .to_string(),
                        }],
                    })
                }
                1 => {
                    let transcript = serde_json::to_string(&messages)?;
                    if !transcript.contains("execution") || !transcript.contains("background") {
                        return Err("exec did not detach before the control yield".into());
                    }
                    // Deliberately let the detached process finish while this
                    // model request is still in flight. The completion Event
                    // must fence the pending no_reply instead of being lost
                    // behind a prematurely terminal Execution Thread.
                    tokio::time::sleep(std::time::Duration::from_millis(350)).await;
                    Ok(wait_response("detached-yield"))
                }
                2 => {
                    let transcript = serde_json::to_string(&messages)?;
                    if !transcript.contains("detached-done") {
                        return Err(
                            "background completion did not resume its Execution Thread".into()
                        );
                    }
                    Ok(text_response("detached execution complete"))
                }
                _ => Err("detached execution caused a redundant Delivery model call".into()),
            }
        }
    }

    #[async_trait::async_trait]
    impl Client for LongLivedProcessReplyClient {
        async fn create_completion(
            &self,
            _messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            match self.calls.fetch_add(1, Ordering::SeqCst) {
                // A server the user asked to keep running. It outlives the
                // turn on purpose, so the Thread still owes background work
                // when the answer is ready.
                0 => Ok(Response {
                    content: String::new(),
                    tool_calls: vec![ToolCallRepr {
                        id: "long-lived-exec".to_string(),
                        r#type: "function".to_string(),
                        func_name: "exec".to_string(),
                        arguments: json!({ "command": "sleep 3", "wait_ms": 1 }).to_string(),
                    }],
                }),
                _ => Ok(text_response("dev server is listening on 3001")),
            }
        }
    }

    #[async_trait::async_trait]
    impl Client for DeclaredServiceClient {
        async fn create_completion(
            &self,
            _messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            match self.calls.fetch_add(1, Ordering::SeqCst) {
                // Declared as a service the Agent means to leave up, so the
                // turn is not waiting on it.
                0 => Ok(Response {
                    content: String::new(),
                    tool_calls: vec![ToolCallRepr {
                        id: "declared-service".to_string(),
                        r#type: "function".to_string(),
                        func_name: "exec".to_string(),
                        arguments: json!({
                            "command": "sleep 3",
                            "wait_ms": 1,
                            "keep_running": true
                        })
                        .to_string(),
                    }],
                }),
                _ => Ok(text_response("dev server is listening on 3002")),
            }
        }
    }

    #[async_trait::async_trait]
    impl Client for RecoveryMergeDeliveryClient {
        async fn create_completion(
            &self,
            messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call != 0 {
                return Err(
                    "two pending results produced more than one Delivery Evaluation".into(),
                );
            }
            let transcript = serde_json::to_string(&messages)?;
            let observed = transcript.contains("recovered-result-one")
                && transcript.contains("recovered-result-two")
                && transcript.contains("completion-delivery");
            self.observed_both_results.store(observed, Ordering::SeqCst);
            if !observed {
                return Err(
                    "Delivery Evaluation did not observe the complete pending batch".into(),
                );
            }
            Ok(text_response("merged-recovered-delivery"))
        }
    }

    #[async_trait::async_trait]
    impl Client for DeliverySnapshotRaceClient {
        async fn create_completion(
            &self,
            messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            if self.calls.fetch_add(1, Ordering::SeqCst) != 0 {
                return Err("delivery snapshot race produced an extra evaluation".into());
            }
            let transcript = serde_json::to_string(&messages)?;
            if !transcript.contains("snapshot-result-one")
                || !transcript.contains("snapshot-result-two")
                || transcript.contains("late-result-must-remain-pending")
            {
                return Err("Delivery Activation received the wrong immutable batch".into());
            }
            self.entered.notify_one();
            self.release.notified().await;
            Ok(text_response("snapshot-delivery"))
        }
    }

    #[async_trait::async_trait]
    impl Client for NoDeliveryModelClient {
        async fn create_completion(
            &self,
            _messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Err("deterministic Delivery route unexpectedly called the model".into())
        }
    }

    #[async_trait::async_trait]
    impl Client for ApprovalReadClient {
        async fn create_completion(
            &self,
            messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            match self.calls.fetch_add(1, Ordering::SeqCst) {
                0 => Ok(Response {
                    content: String::new(),
                    tool_calls: vec![ToolCallRepr {
                        id: "approval-read".to_string(),
                        r#type: "function".to_string(),
                        func_name: "read".to_string(),
                        arguments: json!({ "path": self.path }).to_string(),
                    }],
                }),
                1 => {
                    let tool_text = messages
                        .iter()
                        .find(|message| message.role == "tool")
                        .map(|message| message.content.as_str())
                        .unwrap_or_default();
                    let observed = if self.expected_rejected {
                        tool_text.contains("执行拒绝") && tool_text.contains("权限审批未授权")
                    } else {
                        tool_text.contains("durable-approval-fixture")
                    };
                    self.observed_result.store(observed, Ordering::SeqCst);
                    if !observed {
                        return Err(format!("未观测到预期审批工具结果: {tool_text}").into());
                    }
                    Ok(text_response("approval-work-complete"))
                }
                _ => Err("交互式审批工具产生了冗余 Delivery 模型求值".into()),
            }
        }
    }

    #[async_trait::async_trait]
    impl Client for TwoManagedSshExecClient {
        async fn create_completion(
            &self,
            messages: Vec<Message>,
            tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            match call {
                0 => {
                    assert!(tools.iter().any(|tool| tool.name == "exec"));
                    Ok(Response {
                        content: String::new(),
                        tool_calls: vec![ToolCallRepr {
                            id: "managed-ssh-first".to_string(),
                            r#type: "function".to_string(),
                            func_name: "exec".to_string(),
                            arguments: json!({
                                "command": "printf first",
                                "target": self.target_id,
                            })
                            .to_string(),
                        }],
                    })
                }
                1 => {
                    let transcript = serde_json::to_string(&messages)?;
                    if !transcript.contains("managed-ssh-result-1") {
                        return Err("first Managed SSH result was not observed".into());
                    }
                    Ok(Response {
                        content: String::new(),
                        tool_calls: vec![ToolCallRepr {
                            id: "managed-ssh-second".to_string(),
                            r#type: "function".to_string(),
                            func_name: "exec".to_string(),
                            arguments: json!({
                                "command": "printf second",
                                "target": self.target_id,
                            })
                            .to_string(),
                        }],
                    })
                }
                2 => {
                    let transcript = serde_json::to_string(&messages)?;
                    if !transcript.contains("managed-ssh-result-2") {
                        return Err("second Managed SSH result was not observed".into());
                    }
                    Ok(text_response("managed-ssh-complete"))
                }
                _ => Err("Managed SSH approval test produced an extra model evaluation".into()),
            }
        }
    }

    #[async_trait::async_trait]
    impl crate::execution_target::ExecutionTargetBackend for RecordingManagedSshBackend {
        fn kind(&self) -> crate::memory::ExecutionTargetKind {
            crate::memory::ExecutionTargetKind::ManagedSsh
        }

        async fn execute(
            &self,
            _context: &crate::execution_target::TargetExecutionContext,
            _tool: Arc<dyn crate::tool::Tool>,
            _arguments: &str,
        ) -> Result<String, crate::execution_target::TargetExecutionError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
            Ok(format!("managed-ssh-result-{call}"))
        }
    }

    #[async_trait::async_trait]
    impl Client for PreflightRejectedExecClient {
        async fn create_completion(
            &self,
            messages: Vec<Message>,
            tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            match self.calls.fetch_add(1, Ordering::SeqCst) {
                0 => {
                    assert!(tools.iter().any(|tool| tool.name == "exec"));
                    Ok(Response {
                        content: String::new(),
                        tool_calls: vec![ToolCallRepr {
                            id: "protected-path-exec".to_string(),
                            r#type: "function".to_string(),
                            func_name: "exec".to_string(),
                            arguments: json!({
                                "command": "true",
                                "sandbox_permissions": "require_escalated",
                                "requested_permissions": {
                                    "read_paths": [self.protected_path.clone()]
                                },
                                "justification": "exercise protected path preflight"
                            })
                            .to_string(),
                        }],
                    })
                }
                1 => {
                    let tool_text = messages
                        .iter()
                        .find(|message| message.role == "tool")
                        .map(|message| message.content.as_str())
                        .unwrap_or_default();
                    let observed = tool_text.contains("执行拒绝")
                        && tool_text.contains("PROTECTED_PATH")
                        && tool_text.contains("protected_paths")
                        && tool_text.contains("未开始执行");
                    self.observed_result.store(observed, Ordering::SeqCst);
                    if !observed {
                        return Err(format!("未观测到权限预检拒绝工具结果: {tool_text}").into());
                    }
                    Ok(text_response("preflight-rejection-observed"))
                }
                _ => Err("权限预检拒绝产生了冗余模型求值".into()),
            }
        }
    }

    #[async_trait::async_trait]
    impl ApprovalProvider for StaticApprovalProvider {
        async fn review(
            &self,
            _request: &crate::approval::ApprovalRequest,
        ) -> Result<ApprovalDecision, RuntimeError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if !self.delay.is_zero() {
                tokio::time::sleep(self.delay).await;
            }
            Ok(self.decision.clone())
        }
    }

    struct ObjectiveCompletingClient {
        calls: AtomicU64,
    }

    struct ObjectiveBlockedClient {
        calls: AtomicU64,
    }

    struct ObjectiveLongRunClient {
        calls: AtomicU64,
    }

    struct ObjectiveAutonomousCreateClient {
        calls: AtomicU64,
    }

    struct MultipleObjectiveAutonomousCreateClient {
        calls: AtomicU64,
        objective_phases: std::sync::Mutex<std::collections::HashMap<String, u64>>,
        both_objectives_started: tokio::sync::Barrier,
    }

    struct ObjectiveWaitingClient {
        calls: AtomicU64,
    }

    struct ObjectiveRecoveryClient {
        calls: AtomicU64,
    }

    struct SharedContextObjectiveClient {
        calls: AtomicU64,
    }

    struct ConcurrentObjectiveRouteClient {
        objective_started: tokio::sync::Notify,
        release_objective: tokio::sync::Notify,
    }

    struct ObjectiveScopedCancellationClient {
        objective_a_started: tokio::sync::Notify,
        objective_a_cancelled: tokio::sync::Notify,
        objective_b_started: tokio::sync::Notify,
        objective_b_cancelled: tokio::sync::Notify,
        objective_b_calls: AtomicU64,
        dialogue_started: tokio::sync::Notify,
        release_dialogue: tokio::sync::Notify,
    }

    struct NotifyIfDropped<'a> {
        notify: &'a tokio::sync::Notify,
        armed: bool,
    }

    impl Drop for NotifyIfDropped<'_> {
        fn drop(&mut self) {
            if self.armed {
                self.notify.notify_one();
            }
        }
    }

    #[async_trait::async_trait]
    impl Client for ConcurrentObjectiveRouteClient {
        async fn create_completion(
            &self,
            messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            let context = messages
                .iter()
                .map(|message| message.content.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            if context.contains("unrelated concurrent message") {
                return Ok(text_response("unrelated-user-reply"));
            }
            if context.contains("objective-continuation") {
                self.objective_started.notify_one();
                self.release_objective.notified().await;
                return Ok(no_reply_response("objective-concurrent-no-reply"));
            }
            Err("concurrent Objective route test received an unknown Evaluation".into())
        }
    }

    #[async_trait::async_trait]
    impl Client for ObjectiveScopedCancellationClient {
        fn supports_async_cancellation(&self) -> bool {
            true
        }

        async fn create_completion(
            &self,
            messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            let context = messages
                .iter()
                .map(|message| message.content.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            let current_evaluation = context.rsplit("(evaluate ").next().unwrap_or(&context);
            if current_evaluation.contains("(objective-binding objective-scoped-b)") {
                self.objective_b_calls.fetch_add(1, Ordering::SeqCst);
                self.objective_b_started.notify_one();
                let _drop_signal = NotifyIfDropped {
                    notify: &self.objective_b_cancelled,
                    armed: true,
                };
                std::future::pending::<()>().await;
                unreachable!("blocked Objective Evaluation must be cancelled by Runtime")
            }
            if current_evaluation.contains("(objective-binding objective-scoped-a)") {
                self.objective_a_started.notify_one();
                let _drop_signal = NotifyIfDropped {
                    notify: &self.objective_a_cancelled,
                    armed: true,
                };
                std::future::pending::<()>().await;
                unreachable!("blocked Objective Evaluation must be cancelled by Runtime")
            }
            if current_evaluation.contains("dialogue survives scoped objective cancellation") {
                self.dialogue_started.notify_one();
                self.release_dialogue.notified().await;
                return Ok(text_response("dialogue-still-alive"));
            }
            Err("scoped Objective cancellation test received an unknown Evaluation".into())
        }
    }

    #[async_trait::async_trait]
    impl Client for ObjectiveBlockedClient {
        async fn create_completion(
            &self,
            _messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call > 0 {
                return Ok(text_response("objective-needs-user-decision"));
            }
            let arguments = json!({
                "objective_id": "objective-blocked",
                "base_revision": 2,
                "status": "blocked",
                "reason": "缺少只能由使用者提供的必要决策",
                "evidence_refs": []
            });
            Ok(Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: format!("objective-blocked-call-{call}"),
                    r#type: "function".to_string(),
                    func_name: "objective_update".to_string(),
                    arguments: arguments.to_string(),
                }],
            })
        }
    }

    #[async_trait::async_trait]
    impl Client for ObjectiveLongRunClient {
        async fn create_completion(
            &self,
            messages: Vec<Message>,
            tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call < 100 {
                return Ok(no_reply_response(format!("objective-long-run-call-{call}")));
            }
            if !tools.iter().any(|tool| tool.name == "objective_update") {
                return Ok(text_response("long-objective-complete"));
            }
            let arguments = json!({
                "objective_id": "objective-long-run",
                "base_revision": objective_revision_from_messages(
                    &messages,
                    "objective-long-run"
                ),
                "status": "completed",
                "reason": "已跨越一百次持续求值并完成确定性验收",
                "evidence_refs": []
            });
            Ok(Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: format!("objective-long-run-call-{call}"),
                    r#type: "function".to_string(),
                    func_name: "objective_update".to_string(),
                    arguments: arguments.to_string(),
                }],
            })
        }
    }

    #[async_trait::async_trait]
    impl Client for ObjectiveAutonomousCreateClient {
        async fn create_completion(
            &self,
            messages: Vec<Message>,
            tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call == 2 {
                return Ok(no_reply_response("objective-autonomous-call-2"));
            }
            if call > 3 {
                return Ok(text_response("autonomous-objective-complete"));
            }
            let (name, arguments) = match call {
                0 | 1 => {
                    let create = tools
                        .iter()
                        .find(|tool| tool.name == "objective_create")
                        .expect("普通 Evaluation 应提供 objective_create");
                    let properties = create.parameters["properties"]
                        .as_object()
                        .expect("objective_create properties");
                    assert!(!properties.contains_key("objective_id"));
                    assert!(!properties.contains_key("context_id"));
                    assert!(!properties.contains_key("session_id"));
                    (
                        "objective_create",
                        json!({
                            "stated_objective": "自主创建并完成一个跨 Evaluation 的持久目标",
                            "reason": "该验收明确要求跨 Evaluation 自动续跑并验证重启级控制对象",
                            "source_refs": []
                        }),
                    )
                }
                3 => {
                    let objective_id = autonomous_objective_id_from_messages(&messages);
                    (
                        "objective_update",
                        json!({
                            "objective_id": objective_id,
                            "base_revision": objective_revision_from_messages(
                                &messages,
                                &objective_id
                            ),
                            "status": "completed",
                            "reason": "已验证自主创建、幂等与 Supervisor 续跑",
                            "evidence_refs": []
                        }),
                    )
                }
                _ => unreachable!("handled terminal response above"),
            };
            Ok(Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: format!("objective-autonomous-call-{call}"),
                    r#type: "function".to_string(),
                    func_name: name.to_string(),
                    arguments: arguments.to_string(),
                }],
            })
        }
    }

    #[async_trait::async_trait]
    impl Client for MultipleObjectiveAutonomousCreateClient {
        async fn create_completion(
            &self,
            messages: Vec<Message>,
            tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let Some(objective_id) = current_objective_binding_from_messages(&messages) else {
                assert!(tools.iter().any(|tool| tool.name == "objective_create"));
                return Ok(Response {
                    content: String::new(),
                    tool_calls: ["并发目标甲", "并发目标乙"]
                        .into_iter()
                        .enumerate()
                        .map(|(index, stated_objective)| ToolCallRepr {
                            id: format!("multi-objective-create-{index}"),
                            r#type: "function".to_string(),
                            func_name: "objective_create".to_string(),
                            arguments: json!({
                                "stated_objective": stated_objective,
                                "reason": "验证同一 Activation 创建的兄弟目标能够并发推进",
                                "source_refs": []
                            })
                            .to_string(),
                        })
                        .collect(),
                });
            };
            let phase = {
                let mut phases = self.objective_phases.lock().unwrap();
                let phase = phases.entry(objective_id.clone()).or_default();
                let current = *phase;
                *phase += 1;
                current
            };
            match phase {
                0 => {
                    self.both_objectives_started.wait().await;
                    Ok(Response {
                        content: String::new(),
                        tool_calls: vec![ToolCallRepr {
                            id: format!("multi-objective-complete-{objective_id}"),
                            r#type: "function".to_string(),
                            func_name: "objective_update".to_string(),
                            arguments: json!({
                                "objective_id": objective_id,
                                "base_revision": objective_revision_from_messages(
                                    &messages,
                                    &objective_id
                                ),
                                "status": "completed",
                                "reason": "兄弟 Objective 已并发进入模型并完成",
                                "evidence_refs": []
                            })
                            .to_string(),
                        }],
                    })
                }
                1 => Ok(text_response(format!("{objective_id}-complete"))),
                _ => Err(format!("Objective {objective_id} produced an extra Evaluation").into()),
            }
        }
    }

    #[async_trait::async_trait]
    impl Client for SharedContextObjectiveClient {
        async fn create_completion(
            &self,
            messages: Vec<Message>,
            tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let context = messages
                .iter()
                .map(|message| message.content.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            let (session_id, objective_id) = if context.contains("(active-session session-a)") {
                ("session-a", "objective-a")
            } else if context.contains("(active-session session-b)") {
                ("session-b", "objective-b")
            } else {
                return Err("shared Context Objective test cannot identify active Session".into());
            };
            if !tools.iter().any(|tool| tool.name == "objective_update") {
                return Ok(text_response(format!("{session_id}-complete")));
            }
            let arguments = json!({
                "objective_id": objective_id,
                "base_revision": objective_revision_from_messages(&messages, objective_id),
                "status": "completed",
                "reason": format!("{session_id} 已完成自己的 Objective"),
                "evidence_refs": []
            });
            Ok(Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: format!(
                        "shared-objective-{}-{}",
                        session_id,
                        self.calls.load(Ordering::SeqCst)
                    ),
                    r#type: "function".to_string(),
                    func_name: "objective_update".to_string(),
                    arguments: arguments.to_string(),
                }],
            })
        }
    }

    fn objective_revision_from_messages(messages: &[Message], objective_id: &str) -> u64 {
        // Only a complete Objective state record owns the revision used for
        // objective_update CAS. The same id can also appear in routing,
        // binding and scheduler structures followed by unrelated revisions.
        let marker = format!("(objective (id {objective_id})");
        messages
            .iter()
            .find_map(|message| {
                let objective_at = message.content.find(&marker)?;
                let suffix = &message.content[objective_at..];
                let revision_at = suffix.find("(revision ")? + "(revision ".len();
                let digits = suffix[revision_at..]
                    .chars()
                    .take_while(char::is_ascii_digit)
                    .collect::<String>();
                digits.parse().ok()
            })
            .expect("Objective revision should be visible in Context Encoding")
    }

    fn autonomous_objective_id_from_messages(messages: &[Message]) -> String {
        const MARKER: &str = "(objective (id ";
        messages
            .iter()
            .find_map(|message| {
                let start = message.content.find(MARKER)? + MARKER.len();
                let suffix = &message.content[start..];
                let end = suffix.find(')')?;
                let id = &suffix[..end];
                id.starts_with("objective-auto-").then(|| id.to_string())
            })
            .expect("autonomous Objective should be visible in Context Encoding")
    }

    fn current_objective_binding_from_messages(messages: &[Message]) -> Option<String> {
        const MARKER: &str = "(objective-binding ";
        let context = messages
            .iter()
            .map(|message| message.content.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let current_evaluation = context.rsplit("(evaluate ").next().unwrap_or(&context);
        let start = current_evaluation.find(MARKER)? + MARKER.len();
        let suffix = &current_evaluation[start..];
        let end = suffix.find(')')?;
        let objective_id = &suffix[..end];
        (objective_id != "none").then(|| objective_id.to_string())
    }

    async fn objective_after_evaluation_release(
        runtime: &MorphzRuntime,
        objective_id: &str,
    ) -> ObjectiveRecord {
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                let objective = runtime
                    .get_objective(objective_id)
                    .await
                    .unwrap()
                    .expect("Objective should exist");
                if objective.active_evaluation_id.is_none() {
                    break objective;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("terminal reply should release its Objective Evaluation")
    }

    #[async_trait::async_trait]
    impl Client for ObjectiveRecoveryClient {
        async fn create_completion(
            &self,
            messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call > 0 {
                return Ok(text_response("recovered-objective-complete"));
            }
            let arguments = json!({
                "objective_id": "objective-recover",
                "base_revision": objective_revision_from_messages(&messages, "objective-recover"),
                "status": "completed",
                "reason": "重启后已恢复并完成",
                "evidence_refs": []
            });
            Ok(Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: format!("objective-recovery-call-{call}"),
                    r#type: "function".to_string(),
                    func_name: "objective_update".to_string(),
                    arguments: arguments.to_string(),
                }],
            })
        }
    }

    #[async_trait::async_trait]
    impl Client for ObjectiveWaitingClient {
        async fn create_completion(
            &self,
            _messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call == 1 {
                return Ok(no_reply_response("objective-wait-call-1"));
            }
            if call > 2 {
                return Ok(text_response("wait-objective-complete"));
            }
            let (name, arguments) = match call {
                0 => (
                    "objective_update",
                    json!({
                        "objective_id": "objective-wait",
                        "base_revision": 2,
                        "status": "active",
                        "reason": "必须等待已启动的后台任务产生物理终态",
                        "evidence_refs": [],
                        "wait_condition": {
                            "kind": "tool_task",
                            "task_id": "task-wait-42"
                        }
                    }),
                ),
                2 => (
                    "objective_update",
                    json!({
                        "objective_id": "objective-wait",
                        "base_revision": 6,
                        "status": "completed",
                        "reason": "后台任务已经成功结束",
                        "evidence_refs": []
                    }),
                ),
                _ => unreachable!("handled terminal response above"),
            };
            Ok(Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: format!("objective-wait-call-{call}"),
                    r#type: "function".to_string(),
                    func_name: name.to_string(),
                    arguments: arguments.to_string(),
                }],
            })
        }
    }

    #[async_trait::async_trait]
    impl Client for ObjectiveCompletingClient {
        async fn create_completion(
            &self,
            messages: Vec<Message>,
            tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call == 0 {
                assert!(tools.iter().any(|tool| tool.name == "objective_update"));
                assert!(messages
                    .iter()
                    .any(|message| message.content.contains("(objective-contract")));
                assert!(messages
                    .iter()
                    .any(|message| message.content.contains("objective-continuation")));
                return Ok(Response {
                    content: String::new(),
                    tool_calls: vec![ToolCallRepr {
                        id: "complete-objective".to_string(),
                        r#type: "function".to_string(),
                        func_name: "objective_update".to_string(),
                        arguments: json!({
                            "objective_id": "objective-runtime",
                            "base_revision": 2,
                            "status": "completed",
                            "reason": "测试目标已由确定性夹具完成",
                            "evidence_refs": []
                        })
                        .to_string(),
                    }],
                });
            }
            assert!(!tools.iter().any(|tool| tool.name == "objective_update"));
            Ok(text_response("objective-complete"))
        }
    }

    #[tokio::test]
    async fn runtime_builder_handles_message_event_and_context_through_one_api() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let runtime = MorphzRuntime::builder(config, Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        runtime.start().await.unwrap();
        let session = runtime
            .ensure_session(NewSession {
                id: "session-runtime".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Runtime test".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 8);
        let receipt = session
            .send("hello", "User-Test", Some("client-runtime".to_string()))
            .await
            .unwrap();
        assert!(!receipt.duplicate);
        let reply = tokio::time::timeout(std::time::Duration::from_secs(2), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            reply.payload.get("text").and_then(|value| value.as_str()),
            Some("runtime-ok")
        );
        assert_eq!(
            session.record().await.unwrap().unwrap().id,
            "session-runtime"
        );
        assert!(session.inspect_context().await.is_ok());
    }

    #[tokio::test]
    async fn scheduler_snapshot_joins_the_durable_causal_chain_and_controls() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let runtime = MorphzRuntime::builder(config, Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime
            .ensure_context(NewCognitiveContext {
                id: runtime.identity().context_id.clone(),
                agent_id: runtime.identity().agent_id.clone(),
                title: "Scheduler snapshot context".to_string(),
            })
            .await
            .unwrap();
        runtime
            .ensure_session(NewSession {
                id: "session-scheduler-snapshot".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Scheduler snapshot".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();

        let objective = runtime
            .inner
            .store
            .create_objective(NewObjective {
                id: "objective-scheduler-snapshot".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                coordinator_session_id: "session-scheduler-snapshot".to_string(),
                delivery_session_id: "session-scheduler-snapshot".to_string(),
                parent_objective_id: None,
                source_event_id: "source-scheduler-snapshot".to_string(),
                initiating_principal_id: None,
                stated_objective: "验证统一 SchedulerSnapshot".to_string(),
                token_budget: None,
            })
            .await
            .unwrap();
        let dependency_id = crate::scheduler::stable_scheduler_dependency_id(
            crate::scheduler::SchedulerDependencyOwnerKind::Objective,
            &objective.id,
            objective.generation,
            crate::scheduler::SchedulerDependencyKind::Resource,
            "snapshot-fixture",
            1,
        );
        runtime
            .inner
            .store
            .register_scheduler_dependency(crate::scheduler::NewSchedulerDependency {
                id: dependency_id.clone(),
                owner_kind: crate::scheduler::SchedulerDependencyOwnerKind::Objective,
                owner_id: objective.id.clone(),
                owner_generation: objective.generation,
                dependency_kind: crate::scheduler::SchedulerDependencyKind::Resource,
                dependency_id: "snapshot-fixture".to_string(),
                dependency_generation: 1,
                required: true,
                metadata: json!({"fixture": true}),
            })
            .await
            .unwrap();

        let root_turn_id = "root-scheduler-snapshot";
        let thread = runtime
            .inner
            .store
            .ensure_thread(crate::memory::NewThread {
                id: "thread-scheduler-snapshot".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                session_id: "session-scheduler-snapshot".to_string(),
                initiating_principal_id: None,
                root_turn_id: root_turn_id.to_string(),
                kind: crate::memory::ThreadKind::Execution,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: crate::memory::ThreadSupervision::legacy(),
            })
            .await
            .unwrap();
        let signal_event = Event::new(
            "event-scheduler-snapshot".to_string(),
            "User-Test".to_string(),
            "user_message".to_string(),
            "chat/user_message".to_string(),
            json!({
                "context_id": runtime.identity().context_id,
                "session_id": "session-scheduler-snapshot",
                "text": "run a protected command",
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        runtime
            .inner
            .store
            .append(signal_event.clone())
            .await
            .unwrap();
        let trigger_sequence = runtime
            .inner
            .store
            .query(QueryFilter {
                event_id: Some(signal_event.id.clone()),
                ..QueryFilter::default()
            })
            .await
            .unwrap()[0]
            .sequence
            .unwrap();
        let activation = runtime
            .inner
            .store
            .claim_thread_signal_batch(
                crate::memory::NewThreadSignal {
                    id: "signal-scheduler-snapshot".to_string(),
                    thread_id: thread.id.clone(),
                    thread_generation: thread.generation,
                    event_id: signal_event.id.clone(),
                    principal_id: None,
                    sequence: trigger_sequence,
                    kind: signal_event.topic.clone(),
                    parent_activation_id: None,
                },
                crate::memory::NewThreadActivation {
                    id: "activation-scheduler-snapshot".to_string(),
                    agent_id: runtime.identity().agent_id.clone(),
                    context_id: runtime.identity().context_id.clone(),
                    session_id: "session-scheduler-snapshot".to_string(),
                    initiating_principal_id: None,
                    trigger_event_id: signal_event.id,
                    trigger_sequence,
                    trigger_kind: "chat/user_message".to_string(),
                    parent_activation_id: None,
                    root_turn_id: root_turn_id.to_string(),
                },
                32,
            )
            .await
            .unwrap()
            .unwrap();
        let job = runtime
            .inner
            .store
            .create_execution_job(crate::memory::NewExecutionJob {
                id: "job-scheduler-snapshot".to_string(),
                activation_id: activation.id.clone(),
                thread_id: thread.id.clone(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                session_id: "session-scheduler-snapshot".to_string(),
                initiating_principal_id: None,
                target_id: crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
                tool_call_id: "call-scheduler-snapshot".to_string(),
                tool_name: "exec".to_string(),
                request: json!({"command": "cargo test"}),
                retry_safety: crate::memory::ExecutionRetrySafety::AtMostOnce,
                requires_approval: true,
            })
            .await
            .unwrap();
        let action = json!({"kind": "shell", "command": "cargo test"});
        let requested = json!({"network": true});
        let identity = crate::approval_authority::stable_approval_identity(
            &job.id,
            &action,
            &requested,
            "permission-profile-v1",
        )
        .unwrap();
        runtime
            .inner
            .store
            .ensure_approval_request(crate::memory::NewApprovalRequest {
                id: identity.approval_id.clone(),
                job_id: job.id.clone(),
                request_digest: identity.request_digest,
                policy_digest: identity.policy_digest,
                action,
                requested,
                justification: "network access is required".to_string(),
                pending_status: crate::memory::ApprovalStatus::PendingHuman,
            })
            .await
            .unwrap();
        let schedule = runtime
            .inner
            .store
            .ensure_schedule(crate::memory::NewSchedule {
                id: "schedule-scheduler-snapshot".to_string(),
                thread_id: thread.id.clone(),
                source_turn_id: root_turn_id.to_string(),
                intent: "retry after the dependency is ready".to_string(),
                not_before: Some(chrono::Utc::now() + chrono::Duration::minutes(5)),
                interval_seconds: None,
                dependency_thread_ids: Vec::new(),
            })
            .await
            .unwrap();
        runtime
            .inner
            .store
            .append(Event::new(
                "attempt-state-scheduler-snapshot".to_string(),
                "Runtime-Orchestrator".to_string(),
                "runtime_control".to_string(),
                "runtime/model_attempt_state".to_string(),
                [
                    (
                        "context_id".to_string(),
                        json!(runtime.identity().context_id),
                    ),
                    (
                        "session_id".to_string(),
                        json!("session-scheduler-snapshot"),
                    ),
                    ("thread_id".to_string(), json!(thread.id.clone())),
                    ("activation_id".to_string(), json!(activation.id.clone())),
                    (
                        "attempt_id".to_string(),
                        json!("attempt-scheduler-snapshot"),
                    ),
                    ("state".to_string(), json!("running")),
                    ("terminal".to_string(), json!(false)),
                ]
                .into_iter()
                .collect(),
            ))
            .await
            .unwrap();

        let snapshot = runtime
            .scheduler_snapshot(
                runtime.identity().context_id.as_str(),
                SchedulerQuery {
                    include_terminal: true,
                    limit: 100,
                },
            )
            .await
            .unwrap();
        let causal_thread = snapshot
            .threads
            .iter()
            .find(|item| item.thread.id == thread.id)
            .unwrap();
        assert_eq!(causal_thread.activations.len(), 1);
        assert_eq!(causal_thread.activations[0].signals.len(), 1);
        assert_eq!(causal_thread.activations[0].jobs.len(), 1);
        assert_eq!(
            causal_thread.activations[0].jobs[0]
                .approval
                .as_ref()
                .map(|approval| approval.id.as_str()),
            Some(identity.approval_id.as_str())
        );
        assert_eq!(causal_thread.schedules[0].id, schedule.id);
        assert_eq!(snapshot.summary.waiting_approval_jobs, 1);
        assert_eq!(snapshot.summary.pending_approvals, 1);
        assert_eq!(snapshot.summary.active_schedules, 1);
        assert_eq!(snapshot.contexts.len(), 1);
        assert!(snapshot
            .sessions
            .iter()
            .any(|session| session.id == "session-scheduler-snapshot"));
        let objective_snapshot = snapshot
            .objectives
            .iter()
            .find(|item| item.objective.id == objective.id)
            .unwrap();
        assert_eq!(objective_snapshot.dependencies[0].id, dependency_id);
        assert!(matches!(
            objective_snapshot.readiness,
            crate::scheduler::ObjectiveReadiness::Waiting { .. }
        ));
        assert_eq!(snapshot.summary.waiting_objectives, 1);
        let contract = serde_json::to_value(&snapshot).unwrap();
        let contract_thread = contract["threads"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["thread"]["id"] == thread.id)
            .unwrap();
        assert_eq!(contract_thread["thread"]["kind"], json!("execution"));
        assert_eq!(
            contract_thread["activations"][0]["activation"]["id"],
            json!(activation.id)
        );
        let encoded = serde_json::to_string(&contract).unwrap();
        assert!(!encoded.contains("work_thread"));
        assert!(!encoded.contains("work_item"));
        assert!(!encoded.contains("scheduled_intent"));

        let detail = runtime
            .thread_detail(runtime.identity().context_id.as_str(), &thread.id)
            .await
            .unwrap()
            .expect("exact Thread aggregate must be addressable independently of list limits");
        assert_eq!(detail.snapshot.thread.id, thread.id);
        assert_eq!(detail.snapshot.activations.len(), 1);
        assert_eq!(detail.snapshot.activations[0].jobs.len(), 1);
        assert_eq!(detail.snapshot.schedules[0].id, schedule.id);
        assert_eq!(detail.model_attempt_events.len(), 1);
        assert_eq!(
            detail.model_attempt_events[0].payload["attempt_id"],
            json!("attempt-scheduler-snapshot")
        );

        let paused = runtime
            .pause_schedule(&schedule.id, schedule.revision)
            .await
            .unwrap();
        assert!(matches!(
            paused,
            ScheduleMutation::Updated(ref record)
                if record.status == ScheduleStatus::Paused
        ));
        assert!(matches!(
            runtime
                .pause_schedule(&schedule.id, schedule.revision)
                .await
                .unwrap(),
            ScheduleMutation::Conflict { .. }
        ));
    }

    #[tokio::test]
    async fn scheduler_snapshot_does_not_call_paginated_parents_orphans() {
        let database = NamedTempFile::new().unwrap();
        let runtime = MorphzRuntime::builder(AppConfig::default(), Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        runtime
            .ensure_session(NewSession {
                id: "session-scheduler-pagination".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Scheduler pagination".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();

        let root_turn_id = "root-scheduler-pagination";
        let thread = runtime
            .inner
            .store
            .ensure_thread(crate::memory::NewThread {
                id: "thread-scheduler-pagination".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                session_id: "session-scheduler-pagination".to_string(),
                initiating_principal_id: None,
                root_turn_id: root_turn_id.to_string(),
                kind: crate::memory::ThreadKind::Execution,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: crate::memory::ThreadSupervision::legacy(),
            })
            .await
            .unwrap();

        // limit=1 admits four terminal Activations but ten Jobs. The fifth
        // Job therefore has a real parent outside the bounded response. It
        // must be omitted from this page rather than mislabeled as an orphan.
        for index in 0..5 {
            let event = Event::new(
                format!("event-scheduler-pagination-{index}"),
                "User-Test".to_string(),
                "user_message".to_string(),
                "chat/user_message".to_string(),
                json!({
                    "context_id": runtime.identity().context_id,
                    "session_id": "session-scheduler-pagination",
                    "text": format!("message {index}"),
                })
                .as_object()
                .unwrap()
                .clone(),
            );
            runtime.inner.store.append(event.clone()).await.unwrap();
            let sequence = runtime
                .inner
                .store
                .query(QueryFilter {
                    event_id: Some(event.id.clone()),
                    ..QueryFilter::default()
                })
                .await
                .unwrap()[0]
                .sequence
                .unwrap();
            let activation = runtime
                .inner
                .store
                .claim_thread_signal_batch(
                    crate::memory::NewThreadSignal {
                        id: format!("signal-scheduler-pagination-{index}"),
                        thread_id: thread.id.clone(),
                        thread_generation: thread.generation,
                        event_id: event.id.clone(),
                        principal_id: None,
                        sequence,
                        kind: event.topic,
                        parent_activation_id: None,
                    },
                    crate::memory::NewThreadActivation {
                        id: format!("activation-scheduler-pagination-{index}"),
                        agent_id: runtime.identity().agent_id.clone(),
                        context_id: runtime.identity().context_id.clone(),
                        session_id: "session-scheduler-pagination".to_string(),
                        initiating_principal_id: None,
                        trigger_event_id: event.id,
                        trigger_sequence: sequence,
                        trigger_kind: "chat/user_message".to_string(),
                        parent_activation_id: None,
                        root_turn_id: root_turn_id.to_string(),
                    },
                    32,
                )
                .await
                .unwrap()
                .unwrap();
            runtime
                .inner
                .store
                .update_thread_activation(
                    &activation.id,
                    activation.revision,
                    crate::memory::ThreadActivationStatus::Failed,
                    None,
                    None,
                    None,
                )
                .await
                .unwrap();
            runtime
                .inner
                .store
                .create_execution_job(crate::memory::NewExecutionJob {
                    id: format!("job-scheduler-pagination-{index}"),
                    activation_id: activation.id,
                    thread_id: thread.id.clone(),
                    agent_id: runtime.identity().agent_id.clone(),
                    context_id: runtime.identity().context_id.clone(),
                    session_id: "session-scheduler-pagination".to_string(),
                    initiating_principal_id: None,
                    target_id: crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
                    tool_call_id: format!("call-scheduler-pagination-{index}"),
                    tool_name: "read".to_string(),
                    request: json!({"path": format!("file-{index}.txt")}),
                    retry_safety: crate::memory::ExecutionRetrySafety::Idempotent,
                    requires_approval: false,
                })
                .await
                .unwrap();
        }

        let snapshot = runtime
            .scheduler_snapshot(
                runtime.identity().context_id.as_str(),
                SchedulerQuery {
                    include_terminal: true,
                    limit: 1,
                },
            )
            .await
            .unwrap();
        assert_eq!(snapshot.threads.len(), 1);
        assert_eq!(snapshot.threads[0].activations.len(), 4);
        assert!(snapshot.threads[0].pending_signals.is_empty());
        assert_eq!(snapshot.summary.pending_signals, 0);
        assert!(snapshot.orphan_activations.is_empty());
        assert!(snapshot.orphan_jobs.is_empty());
    }

    #[tokio::test]
    async fn startup_closes_approved_job_whose_causal_owner_is_terminal() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let runtime = MorphzRuntime::builder(config, Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime
            .ensure_agent(NewAgent {
                id: runtime.identity().agent_id.clone(),
                title: "Recovery agent".to_string(),
                root_context_id: runtime.identity().context_id.clone(),
            })
            .await
            .unwrap();
        runtime
            .ensure_context(NewCognitiveContext {
                id: runtime.identity().context_id.clone(),
                agent_id: runtime.identity().agent_id.clone(),
                title: "Recovery context".to_string(),
            })
            .await
            .unwrap();
        runtime
            .ensure_session(NewSession {
                id: "session-orphaned-approved-job".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Orphaned approved Job".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let thread = runtime
            .inner
            .store
            .ensure_thread(crate::memory::NewThread {
                id: "thread-orphaned-approved-job".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                session_id: "session-orphaned-approved-job".to_string(),
                initiating_principal_id: None,
                root_turn_id: "root-orphaned-approved-job".to_string(),
                kind: crate::memory::ThreadKind::Execution,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: crate::memory::ThreadSupervision::legacy(),
            })
            .await
            .unwrap();
        let event = Event::new(
            "event-orphaned-approved-job".to_string(),
            "User-Test".to_string(),
            "user_message".to_string(),
            "chat/user_message".to_string(),
            json!({
                "context_id": runtime.identity().context_id,
                "session_id": "session-orphaned-approved-job",
                "text": "run protected action",
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        runtime.inner.store.append(event.clone()).await.unwrap();
        let sequence = runtime
            .inner
            .store
            .query(QueryFilter {
                event_id: Some(event.id.clone()),
                ..Default::default()
            })
            .await
            .unwrap()[0]
            .sequence
            .unwrap();
        let activation = runtime
            .inner
            .store
            .claim_thread_signal_batch(
                crate::memory::NewThreadSignal {
                    id: "signal-orphaned-approved-job".to_string(),
                    thread_id: thread.id.clone(),
                    thread_generation: thread.generation,
                    event_id: event.id.clone(),
                    principal_id: None,
                    sequence,
                    kind: event.topic,
                    parent_activation_id: None,
                },
                crate::memory::NewThreadActivation {
                    id: "activation-orphaned-approved-job".to_string(),
                    agent_id: runtime.identity().agent_id.clone(),
                    context_id: runtime.identity().context_id.clone(),
                    session_id: "session-orphaned-approved-job".to_string(),
                    initiating_principal_id: None,
                    trigger_event_id: event.id,
                    trigger_sequence: sequence,
                    trigger_kind: "chat/user_message".to_string(),
                    parent_activation_id: None,
                    root_turn_id: "root-orphaned-approved-job".to_string(),
                },
                32,
            )
            .await
            .unwrap()
            .unwrap();
        runtime
            .inner
            .store
            .update_thread_activation(
                &activation.id,
                activation.revision,
                crate::memory::ThreadActivationStatus::Failed,
                None,
                None,
                None,
            )
            .await
            .unwrap();
        runtime
            .inner
            .store
            .update_thread(
                &thread.id,
                thread.revision,
                None,
                Some(crate::memory::ThreadLifecycle::Cancelled),
                Some("seed terminal owner"),
                Some("thread-terminal-orphaned-approved-job"),
                None,
                None,
            )
            .await
            .unwrap();
        let job = runtime
            .inner
            .store
            .create_execution_job(crate::memory::NewExecutionJob {
                id: "job-orphaned-approved-job".to_string(),
                activation_id: activation.id.clone(),
                thread_id: thread.id.clone(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                session_id: "session-orphaned-approved-job".to_string(),
                initiating_principal_id: None,
                target_id: crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
                tool_call_id: "call-orphaned-approved-job".to_string(),
                tool_name: "exec".to_string(),
                request: json!({"command": "echo must-not-run"}),
                retry_safety: crate::memory::ExecutionRetrySafety::AtMostOnce,
                requires_approval: true,
            })
            .await
            .unwrap();
        let action = json!({"kind": "shell", "command": "echo must-not-run"});
        let requested = json!({"network": false});
        let identity = crate::approval_authority::stable_approval_identity(
            &job.id,
            &action,
            &requested,
            "permission-profile-v1",
        )
        .unwrap();
        runtime
            .inner
            .store
            .ensure_approval_request(crate::memory::NewApprovalRequest {
                id: identity.approval_id.clone(),
                job_id: job.id.clone(),
                request_digest: identity.request_digest,
                policy_digest: identity.policy_digest,
                action,
                requested,
                justification: "seed an allowed but unconsumed grant".to_string(),
                pending_status: crate::memory::ApprovalStatus::PendingHuman,
            })
            .await
            .unwrap();
        runtime
            .inner
            .store
            .commit_approval_decision(
                &identity.approval_id,
                1,
                crate::memory::ApprovalResolution::Allow {
                    rationale: "approved before the Activation failed".to_string(),
                    risk_tags: vec!["fixture".to_string()],
                },
            )
            .await
            .unwrap();

        runtime.start().await.unwrap();

        let recovered_job = runtime
            .inner
            .store
            .get_execution_job(&job.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            recovered_job.status,
            crate::memory::ExecutionJobStatus::Cancelled
        );
        let recovered_approval = runtime
            .inner
            .store
            .get_approval(&identity.approval_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            recovered_approval.status,
            crate::memory::ApprovalStatus::Cancelled
        );
        let snapshot = runtime
            .scheduler_snapshot(
                runtime.identity().context_id.as_str(),
                SchedulerQuery {
                    include_terminal: true,
                    limit: 100,
                },
            )
            .await
            .unwrap();
        assert_eq!(snapshot.summary.active_jobs, 0);
        assert_eq!(snapshot.summary.waiting_approval_jobs, 0);
        assert_eq!(snapshot.summary.pending_approvals, 0);
    }

    #[tokio::test]
    async fn interactive_physical_tool_batch_delivers_its_execution_terminal_directly() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let observed_complete_batch = Arc::new(AtomicBool::new(false));
        let client = Arc::new(PhysicalBatchClient {
            calls: AtomicU64::new(0),
            observed_complete_batch: Arc::clone(&observed_complete_batch),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: false,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        let session = runtime
            .ensure_session(NewSession {
                id: "session-physical-batch".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Physical batch".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 4);
        session
            .send(
                "run both probes",
                "User-Test",
                Some("client-physical-batch".to_string()),
            )
            .await
            .unwrap();
        // Event-driven, so the bound only decides how fast a hang is reported:
        // enough headroom to survive a loaded parallel run, short enough that a
        // real hang does not stall the suite for a minute.
        let reply = tokio::time::timeout(std::time::Duration::from_secs(15), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reply.payload["text"], "physical-batch-complete");
        assert_eq!(reply.payload["thread_kind"], "execution");
        assert_eq!(reply.payload["delivery_kind"], "turn_reply");
        assert!(observed_complete_batch.load(Ordering::SeqCst));
        assert_eq!(client.calls.load(Ordering::SeqCst), 2);

        let jobs = runtime
            .inner
            .store
            .list_execution_jobs(crate::memory::ExecutionJobFilter {
                session_id: Some("session-physical-batch".to_string()),
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(jobs.len(), 2);
        assert!(jobs
            .iter()
            .all(|job| job.status == crate::memory::ExecutionJobStatus::Succeeded));
        assert!(jobs.iter().all(|job| job.result_event_id.is_some()));
    }

    #[tokio::test]
    async fn eval_runs_through_durable_plan_and_physical_execution_job_before_replying() {
        let database = NamedTempFile::new().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let fixture_path = workspace.path().join("durable-plan.txt");
        std::fs::write(&fixture_path, "durable-plan-fixture").unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.workspace_root = workspace.path().to_string_lossy().into_owned();
        config.permissions.reviewer = ReviewerKind::Deny;
        let observed_plan_result = Arc::new(AtomicBool::new(false));
        let client = Arc::new(DurableEvalClient {
            calls: AtomicU64::new(0),
            path: fixture_path.to_string_lossy().into_owned(),
            observed_plan_result: Arc::clone(&observed_plan_result),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: false,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        let session = runtime
            .ensure_session(NewSession {
                id: "session-durable-eval".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Durable eval".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 4);

        session
            .send(
                "read the fixture through eval",
                "User-Test",
                Some("client-durable-eval".to_string()),
            )
            .await
            .unwrap();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(5), replies.recv())
            .await
            .unwrap()
            .unwrap();

        assert_eq!(reply.payload["text"], "durable-eval-complete");
        assert!(observed_plan_result.load(Ordering::SeqCst));
        assert_eq!(client.calls.load(Ordering::SeqCst), 2);
        let plans = runtime
            .inner
            .store
            .list_plan_executions(crate::memory::PlanExecutionFilter {
                context_id: Some(runtime.identity().context_id.clone()),
                session_id: Some(session.id().to_string()),
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(plans.len(), 1);
        assert_eq!(
            plans[0].status,
            crate::memory::PlanExecutionStatus::Succeeded
        );
        let jobs = runtime
            .inner
            .store
            .list_execution_jobs(crate::memory::ExecutionJobFilter {
                session_id: Some(session.id().to_string()),
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].status, crate::memory::ExecutionJobStatus::Succeeded);
    }

    #[tokio::test]
    async fn bound_runtime_harness_entry_runs_once_before_objective_model_evaluation() {
        let database = NamedTempFile::new().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let fixture_path = workspace.path().join("automatic-harness-entry.txt");
        std::fs::write(&fixture_path, "automatic-harness-entry-fixture").unwrap();
        let quoted_path =
            serde_json::to_string(&fixture_path.to_string_lossy().into_owned()).unwrap();
        let package = HarnessPackage::from_source(
            "automatic.hns",
            &format!(
                r#"
                    (manifest
                      (id automatic)
                      (version "1.0.0")
                      (title "Automatic Harness")
                      (capabilities (tools read)))
                    (contract (identity "automatic"))
                    (mind (frame (id automatic/evidence)))
                    (eval
                      (requires (tools read))
                      (call read (path {quoted_path})))
                "#
            ),
        )
        .unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.workspace_root = workspace.path().to_string_lossy().into_owned();
        config.permissions.reviewer = ReviewerKind::Deny;
        let observed_entry_result = Arc::new(AtomicBool::new(false));
        let client = Arc::new(HarnessEntryClient {
            calls: AtomicU64::new(0),
            objective_id: "objective-harness-entry".to_string(),
            observed_entry_result: Arc::clone(&observed_entry_result),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            .harness_package(package)
            .tool_policy(RuntimeToolPolicy {
                context_only: false,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();

        runtime
            .ensure_agent(NewAgent {
                id: runtime.identity().agent_id.clone(),
                title: "Harness entry agent".to_string(),
                root_context_id: runtime.identity().context_id.clone(),
            })
            .await
            .unwrap();
        runtime
            .ensure_context(NewCognitiveContext {
                id: runtime.identity().context_id.clone(),
                agent_id: runtime.identity().agent_id.clone(),
                title: "Harness entry context".to_string(),
            })
            .await
            .unwrap();
        runtime
            .ensure_session(NewSession {
                id: "session-harness-entry".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Harness entry".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        runtime
            .create_objective_with_harness(
                NewObjective {
                    id: "objective-harness-entry".to_string(),
                    agent_id: runtime.identity().agent_id.clone(),
                    context_id: runtime.identity().context_id.clone(),
                    coordinator_session_id: "session-harness-entry".to_string(),
                    delivery_session_id: "session-harness-entry".to_string(),
                    parent_objective_id: None,
                    source_event_id: "source-harness-entry".to_string(),
                    initiating_principal_id: None,
                    stated_objective: "执行绑定 Harness 的顶层入口".to_string(),
                    token_budget: None,
                },
                "automatic",
                "1.0.0",
            )
            .await
            .unwrap();

        let mut replies = runtime.subscribe("chat/reply", 4);
        runtime.start().await.unwrap();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(5), replies.recv())
            .await
            .unwrap()
            .unwrap();

        assert_eq!(
            reply.payload.get("text").and_then(Value::as_str),
            Some("automatic-harness-entry-complete")
        );
        assert!(observed_entry_result.load(Ordering::SeqCst));
        assert_eq!(client.calls.load(Ordering::SeqCst), 2);
        let plans = runtime
            .inner
            .store
            .list_plan_executions(crate::memory::PlanExecutionFilter {
                context_id: Some(runtime.identity().context_id.clone()),
                session_id: Some("session-harness-entry".to_string()),
                objective_id: Some("objective-harness-entry".to_string()),
                harness_id: Some("automatic".to_string()),
                harness_version: Some("1.0.0".to_string()),
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(plans.len(), 1);
        assert_eq!(
            plans[0].status,
            crate::memory::PlanExecutionStatus::Succeeded
        );
        assert!(plans[0].tool_call_id.starts_with("harness_entry_"));
        let jobs = runtime
            .inner
            .store
            .list_execution_jobs(crate::memory::ExecutionJobFilter {
                session_id: Some("session-harness-entry".to_string()),
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].tool_name, "read");
        assert_eq!(jobs[0].status, crate::memory::ExecutionJobStatus::Succeeded);
    }

    #[tokio::test]
    async fn ordinary_message_can_bind_exact_harness_to_its_evaluation() {
        let database = NamedTempFile::new().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let fixture_path = workspace.path().join("ordinary-harness-entry.txt");
        std::fs::write(&fixture_path, "ordinary-harness-entry-fixture").unwrap();
        let quoted_path =
            serde_json::to_string(&fixture_path.to_string_lossy().into_owned()).unwrap();
        let package = HarnessPackage::from_source(
            "ordinary.hns",
            &format!(
                r#"
                    (manifest
                      (id ordinary)
                      (version "1.0.0")
                      (title "Ordinary Harness")
                      (capabilities (tools read)))
                    (contract (identity "ordinary"))
                    (eval
                      (requires (tools read))
                      (call read (path {quoted_path})))
                "#
            ),
        )
        .unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.workspace_root = workspace.path().to_string_lossy().into_owned();
        config.permissions.reviewer = ReviewerKind::Deny;
        let observed_entry_result = Arc::new(AtomicBool::new(false));
        let client = Arc::new(OrdinaryHarnessEntryClient {
            calls: AtomicU64::new(0),
            observed_entry_result: Arc::clone(&observed_entry_result),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            .harness_package(package)
            .tool_policy(RuntimeToolPolicy {
                context_only: false,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        let session = runtime
            .ensure_session(NewSession {
                id: "session-ordinary-harness".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Ordinary Harness".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        runtime.bind_default_principal(session.id()).await.unwrap();
        let mut replies = runtime.subscribe("chat/reply", 4);
        session
            .send_as_principal_with_harness(
                "use the exact harness",
                "User-Test",
                runtime.identity().principal_id.clone(),
                Some("client-ordinary-harness".to_string()),
                Some(crate::harness::ExactHarnessRef {
                    id: "ordinary".to_string(),
                    version: "1.0.0".to_string(),
                }),
            )
            .await
            .unwrap();

        let reply = tokio::time::timeout(std::time::Duration::from_secs(5), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            reply.payload.get("text").and_then(Value::as_str),
            Some("ordinary-harness-entry-complete")
        );
        assert!(observed_entry_result.load(Ordering::SeqCst));
        assert_eq!(client.calls.load(Ordering::SeqCst), 1);
        let bindings = runtime
            .query_events(QueryFilter {
                context_id: Some(runtime.identity().context_id.clone()),
                topic: Some(crate::harness_package::EVALUATION_HARNESS_BINDING_TOPIC.to_string()),
                top_k: Some(10),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(!bindings.is_empty());
        assert!(bindings
            .iter()
            .all(|event| event.payload["scope"] == "evaluation"));
    }

    #[tokio::test]
    async fn model_can_discover_and_select_harness_for_ordinary_evaluation() {
        let database = NamedTempFile::new().unwrap();
        let package = HarnessPackage::from_source(
            "discovery-test.hns",
            r#"
                (manifest
                  (id discovery-test)
                  (version "1.0.0")
                  (title "Discovery Test")
                  (capabilities (tools read)))
                (contract (identity "discovery-contract"))
                (infer (task "complete the current evaluation"))
            "#,
        )
        .unwrap();
        let observed_mount = Arc::new(AtomicBool::new(false));
        let client = Arc::new(HarnessDiscoveryClient {
            calls: AtomicU64::new(0),
            observed_mount: Arc::clone(&observed_mount),
        });
        let runtime = MorphzRuntime::builder(AppConfig::default(), client.clone())
            .database_path(database.path().to_string_lossy())
            .harness_package(package)
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        let session = runtime
            .ensure_session(NewSession {
                id: "session-harness-discovery".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Harness discovery".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        runtime.bind_default_principal(session.id()).await.unwrap();
        let mut replies = runtime.subscribe("chat/reply", 4);
        session
            .send_as_principal(
                "choose a suitable harness",
                "User-Test",
                runtime.identity().principal_id.clone(),
                Some("client-harness-discovery".to_string()),
            )
            .await
            .unwrap();

        let reply = tokio::time::timeout(std::time::Duration::from_secs(5), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            reply.payload.get("text").and_then(Value::as_str),
            Some("discovered-harness-complete")
        );
        assert!(observed_mount.load(Ordering::SeqCst));
        assert_eq!(client.calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn detached_execution_uses_completion_inbox_then_singleton_passthrough() {
        let database = NamedTempFile::new().unwrap();
        let artifacts = tempfile::tempdir().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        config.background_task.artifact_dir = artifacts.path().to_string_lossy().into_owned();
        let client = Arc::new(DetachedExecClient {
            calls: AtomicU64::new(0),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: false,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        let session = runtime
            .ensure_session(NewSession {
                id: "session-detached-delivery".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Detached delivery".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 4);
        session
            .send(
                "run this past the synchronous budget",
                "User-Test",
                Some("client-detached-delivery".to_string()),
            )
            .await
            .unwrap();
        let reply =
            match tokio::time::timeout(std::time::Duration::from_secs(5), replies.recv()).await {
                Ok(Some(reply)) => reply,
                outcome => {
                    let events = runtime
                        .inner
                        .store
                        .query(QueryFilter {
                            session_id: Some(session.id().to_string()),
                            ..Default::default()
                        })
                        .await
                        .unwrap();
                    panic!(
                        "detached reply timeout: outcome={outcome:?}, calls={}, events={:?}",
                        client.calls.load(Ordering::SeqCst),
                        events
                            .iter()
                            .map(|event| (
                                event.topic.as_str(),
                                event.payload.get("text"),
                                event.payload.get("tool_status")
                            ))
                            .collect::<Vec<_>>()
                    );
                }
            };
        assert_eq!(reply.payload["text"], "detached execution complete");
        assert_eq!(reply.payload["delivery_strategy"], "passthrough");
        assert_eq!(reply.payload["delivery_kind"], "thread_delivery");
        assert_eq!(client.calls.load(Ordering::SeqCst), 3);
        let jobs = runtime
            .inner
            .store
            .list_execution_jobs(crate::memory::ExecutionJobFilter {
                session_id: Some(session.id().to_string()),
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(jobs.iter().any(|job| job.tool_name == "exec/background"));
    }

    #[tokio::test]
    async fn a_finished_answer_is_a_reply_even_while_a_server_keeps_running() {
        // The model called reply(deliver), so the turn is answered. Reporting
        // that as progress because the Thread still owed background work made
        // a finished answer look interim for good: a server the user asked to
        // keep running never exits, so the follow-up reply implied by the
        // downgrade could never arrive.
        let database = NamedTempFile::new().unwrap();
        let artifacts = tempfile::tempdir().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        config.background_task.artifact_dir = artifacts.path().to_string_lossy().into_owned();
        let client = Arc::new(LongLivedProcessReplyClient {
            calls: AtomicU64::new(0),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            // The background task registry is process-wide, so this test needs
            // its own Context: the server it deliberately leaves running would
            // otherwise be counted against every other test that takes the
            // default identity.
            .identity(RuntimeIdentity {
                agent_id: "agent-long-lived-reply".to_string(),
                context_id: "context-long-lived-reply".to_string(),
                ..Default::default()
            })
            .tool_policy(RuntimeToolPolicy {
                context_only: false,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        let session = runtime
            .ensure_session(NewSession {
                id: "session-long-lived-reply".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Long lived reply".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 4);
        session
            .send(
                "restart the dev server",
                "User-Test",
                Some("client-long-lived-reply".to_string()),
            )
            .await
            .unwrap();
        let reply = match tokio::time::timeout(std::time::Duration::from_secs(10), replies.recv())
            .await
        {
            Ok(Some(reply)) => reply,
            outcome => {
                let events = runtime
                    .inner
                    .store
                    .query(QueryFilter {
                        session_id: Some(session.id().to_string()),
                        ..Default::default()
                    })
                    .await
                    .unwrap();
                panic!(
                        "a finished answer never reached the user as a reply: outcome={outcome:?}, events={:?}",
                        events
                            .iter()
                            .map(|event| (event.topic.as_str(), event.payload.get("text")))
                            .collect::<Vec<_>>()
                    );
            }
        };
        assert_eq!(
            reply.payload.get("text").and_then(Value::as_str),
            Some("dev server is listening on 3001")
        );
        let events = runtime
            .inner
            .store
            .query(QueryFilter {
                session_id: Some(session.id().to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        // The answer reaches the user as an answer, and is not also filed as
        // interim progress.
        assert!(
            !events.iter().any(|event| event.topic == "chat/progress"
                && event.payload.get("text").and_then(Value::as_str)
                    == Some("dev server is listening on 3001")),
            "the answer must not also be published as progress"
        );
        kill_tasks_for_context("context-long-lived-reply");
    }

    #[tokio::test]
    async fn a_declared_service_does_not_hold_its_turn_open() {
        // A process the Agent declares it means to leave running is not work
        // the turn is waiting on. Counting it kept the Thread from ever
        // closing, because such a process never exits and the condition could
        // never clear.
        let database = NamedTempFile::new().unwrap();
        let artifacts = tempfile::tempdir().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        config.background_task.artifact_dir = artifacts.path().to_string_lossy().into_owned();
        let client = Arc::new(DeclaredServiceClient {
            calls: AtomicU64::new(0),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            .identity(RuntimeIdentity {
                agent_id: "agent-declared-service".to_string(),
                context_id: "context-declared-service".to_string(),
                ..Default::default()
            })
            .tool_policy(RuntimeToolPolicy {
                context_only: false,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        let session = runtime
            .ensure_session(NewSession {
                id: "session-declared-service".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Declared service".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 4);
        session
            .send(
                "start the dev server and leave it running",
                "User-Test",
                Some("client-declared-service".to_string()),
            )
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(10), replies.recv())
            .await
            .expect("declared service turn never produced a reply")
            .expect("reply stream closed");
        let events = runtime
            .inner
            .store
            .query(QueryFilter {
                session_id: Some(session.id().to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        let root_turn_id = events
            .iter()
            .find(|event| event.topic == "chat/user_message")
            .map(|event| event.id.clone())
            .expect("the turn has a root user message");
        // This count is what gates closing the turn, and the service is still
        // running as it is taken: it must not be owed work.
        assert_eq!(
            crate::tool::active_background_task_count_for_root(
                session.id(),
                runtime.identity().context_id.as_str(),
                &root_turn_id,
            ),
            0,
            "a service the Agent declared it would leave running was counted \
             as work the turn is waiting on"
        );
        kill_tasks_for_context("context-declared-service");
    }

    async fn run_static_approval_case(
        decision: ApprovalDecision,
        delay: std::time::Duration,
        expected_rejected: bool,
    ) {
        let database = NamedTempFile::new().unwrap();
        let fixture = NamedTempFile::new().unwrap();
        std::fs::write(fixture.path(), "durable-approval-fixture").unwrap();
        let observed_result = Arc::new(AtomicBool::new(false));
        let client = Arc::new(ApprovalReadClient {
            calls: AtomicU64::new(0),
            path: fixture.path().to_string_lossy().into_owned(),
            expected_rejected,
            observed_result: Arc::clone(&observed_result),
        });
        let provider = Arc::new(StaticApprovalProvider {
            decision,
            delay,
            calls: AtomicU64::new(0),
        });
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::AutoReview;
        // The approval delay must be outside this physical tool timeout.
        config.orchestrator.tool_timeout_secs = 1;
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: false,
                coding_eval: true,
            })
            .approval_provider(provider.clone())
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        let session_id = if expected_rejected {
            "session-approval-deny"
        } else {
            "session-approval-allow"
        };
        let session = runtime
            .ensure_session(NewSession {
                id: session_id.to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Durable approval".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 4);
        session
            .send(
                "read the exact fixture",
                "User-Test",
                Some(format!("client-{session_id}")),
            )
            .await
            .unwrap();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(8), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reply.payload["text"], "approval-work-complete");
        assert_eq!(reply.payload["thread_kind"], "execution");
        assert!(observed_result.load(Ordering::SeqCst));
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
        assert_eq!(client.calls.load(Ordering::SeqCst), 2);

        let approvals = runtime
            .inner
            .store
            .list_approvals(ApprovalFilter::default())
            .await
            .unwrap();
        assert_eq!(approvals.len(), 1);
        let jobs = runtime
            .inner
            .store
            .list_execution_jobs(crate::memory::ExecutionJobFilter {
                session_id: Some(session_id.to_string()),
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(jobs.len(), 1);
        if expected_rejected {
            assert_eq!(approvals[0].status, crate::memory::ApprovalStatus::Denied);
            assert!(approvals[0].grant_consumed_at.is_none());
            assert_eq!(jobs[0].status, crate::memory::ExecutionJobStatus::Cancelled);
        } else {
            assert_eq!(approvals[0].status, crate::memory::ApprovalStatus::Allowed);
            assert!(approvals[0].grant_consumed_at.is_some());
            assert_eq!(jobs[0].status, crate::memory::ExecutionJobStatus::Succeeded);
        }
    }

    async fn run_managed_ssh_target_approval_case(
        permission_mode: PermissionMode,
        suffix: &str,
        expected_approvals: usize,
        expected_leases: usize,
        expected_reviews: u64,
    ) {
        let database = NamedTempFile::new().unwrap();
        let target_id = format!("target-managed-ssh-{suffix}");
        let session_id = format!("session-managed-ssh-{suffix}");
        let client = Arc::new(TwoManagedSshExecClient {
            calls: AtomicU64::new(0),
            target_id: target_id.clone(),
        });
        let backend = Arc::new(RecordingManagedSshBackend {
            calls: AtomicU64::new(0),
        });
        let provider = Arc::new(StaticApprovalProvider {
            decision: ApprovalDecision::AllowLease {
                rationale: "approve this Thread's Managed SSH target".to_string(),
                risk_tags: vec!["test-managed-ssh-target".to_string()],
            },
            delay: std::time::Duration::ZERO,
            calls: AtomicU64::new(0),
        });
        let mut config = AppConfig::default();
        config.permissions.mode = permission_mode;
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: false,
                coding_eval: true,
            })
            .approval_provider(provider.clone())
            .execution_target_backend(backend.clone())
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        runtime
            .inner
            .store
            .register_execution_target(crate::memory::ExecutionTargetRegistration {
                id: target_id.clone(),
                owner_principal_id: Some(runtime.identity().principal_id.clone()),
                provider_node_id: None,
                kind: crate::memory::ExecutionTargetKind::ManagedSsh,
                name: "Managed SSH test target".to_string(),
                status: crate::memory::ExecutionTargetStatus::Online,
                platform: Some("linux-x86_64".to_string()),
                workspace_root: None,
                capabilities: vec!["exec".to_string()],
                metadata: json!({
                    "backend": "managed_ssh",
                    "execution_location": "runtime",
                    "endpoint_ref": "test"
                }),
                policy_digest: "target-policy-managed-ssh-test".to_string(),
                last_seen_at: Some(chrono::Utc::now()),
            })
            .await
            .unwrap();
        let session = runtime
            .ensure_session(NewSession {
                id: session_id.clone(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Managed SSH target approval".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 4);
        session
            .send(
                "run two commands on the managed SSH target",
                "User-Test",
                Some(format!("client-managed-ssh-{suffix}")),
            )
            .await
            .unwrap();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(8), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reply.payload["text"], "managed-ssh-complete");
        assert_eq!(client.calls.load(Ordering::SeqCst), 3);
        assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
        assert_eq!(provider.calls.load(Ordering::SeqCst), expected_reviews);

        let approvals = runtime
            .inner
            .store
            .list_approvals(ApprovalFilter::default())
            .await
            .unwrap();
        assert_eq!(approvals.len(), expected_approvals);
        let leases = runtime
            .inner
            .store
            .list_capability_leases(CapabilityLeaseFilter {
                target_id: Some(target_id),
                ..CapabilityLeaseFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(leases.len(), expected_leases);
        let jobs = runtime
            .inner
            .store
            .list_execution_jobs(crate::memory::ExecutionJobFilter {
                session_id: Some(session_id),
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(jobs.len(), 2);
        assert!(jobs
            .iter()
            .all(|job| job.status == crate::memory::ExecutionJobStatus::Succeeded));
        assert_eq!(
            jobs.iter().filter(|job| job.approval_ref.is_some()).count(),
            expected_approvals
        );
    }

    #[tokio::test]
    async fn full_access_managed_ssh_skips_runtime_approval() {
        run_managed_ssh_target_approval_case(PermissionMode::FullAccess, "full-access", 0, 0, 0)
            .await;
    }

    #[tokio::test]
    async fn managed_ssh_target_lease_avoids_per_command_approval() {
        run_managed_ssh_target_approval_case(PermissionMode::AutoReview, "target-lease", 1, 1, 1)
            .await;
    }

    #[tokio::test]
    async fn durable_auto_approval_waits_before_claim_without_consuming_tool_timeout() {
        run_static_approval_case(
            ApprovalDecision::AllowOnce {
                rationale: "fixture read is narrowly scoped".to_string(),
                risk_tags: vec!["test-allow".to_string()],
            },
            std::time::Duration::from_millis(1_250),
            false,
        )
        .await;
    }

    #[tokio::test]
    async fn durable_denial_becomes_explicit_batch_tool_result_without_execution() {
        run_static_approval_case(
            ApprovalDecision::Deny {
                rationale: "test denial".to_string(),
                risk_tags: vec!["test-deny".to_string()],
            },
            std::time::Duration::ZERO,
            true,
        )
        .await;
    }

    #[tokio::test]
    async fn protected_path_preflight_rejection_returns_to_the_same_thread() {
        let database = NamedTempFile::new().unwrap();
        let protected = tempfile::tempdir().unwrap();
        let protected_path = protected.path().to_string_lossy().into_owned();
        let observed_result = Arc::new(AtomicBool::new(false));
        let client = Arc::new(PreflightRejectedExecClient {
            calls: AtomicU64::new(0),
            protected_path: protected_path.clone(),
            observed_result: Arc::clone(&observed_result),
        });
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        config.permissions.protected_paths.push(protected_path);
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: false,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        let session = runtime
            .ensure_session(NewSession {
                id: "session-preflight-rejected".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Preflight rejection".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 4);
        session
            .send(
                "try the protected path",
                "User-Test",
                Some("client-preflight-rejected".to_string()),
            )
            .await
            .unwrap();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(5), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reply.payload["text"], "preflight-rejection-observed");
        assert!(observed_result.load(Ordering::SeqCst));
        assert_eq!(client.calls.load(Ordering::SeqCst), 2);

        let tool_outputs = runtime
            .inner
            .store
            .query(QueryFilter {
                session_id: Some(session.id.clone()),
                topic: Some("chat/tool_output".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(tool_outputs.len(), 1);
        assert_eq!(tool_outputs[0].payload["tool_status"], "rejected");
        assert_eq!(tool_outputs[0].payload["rejection_code"], "PROTECTED_PATH");
        assert_eq!(tool_outputs[0].payload["executed"], false);
        assert_eq!(tool_outputs[0].payload["wake_policy"], "immediate");

        let jobs = runtime
            .inner
            .store
            .list_execution_jobs(crate::memory::ExecutionJobFilter {
                session_id: Some(session.id.clone()),
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(jobs.is_empty(), "preflight rejection must not create a Job");
        let activations = runtime
            .inner
            .store
            .list_context_thread_activations(&runtime.identity().context_id, true)
            .await
            .unwrap();
        assert!(activations.iter().all(|activation| {
            activation.status != crate::memory::ThreadActivationStatus::Failed
        }));
    }

    #[tokio::test]
    async fn human_approval_can_outlive_model_deadline_and_executes_job_once() {
        let database = NamedTempFile::new().unwrap();
        let fixture = NamedTempFile::new().unwrap();
        std::fs::write(fixture.path(), "durable-approval-fixture").unwrap();
        let observed_result = Arc::new(AtomicBool::new(false));
        let client = Arc::new(ApprovalReadClient {
            calls: AtomicU64::new(0),
            path: fixture.path().to_string_lossy().into_owned(),
            expected_rejected: false,
            observed_result: Arc::clone(&observed_result),
        });
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::User;
        // The former whole-Attempt watchdog fired after
        // `model_timeout * (protocol_retries + 1) + 1`, i.e. four seconds for
        // this fixture.  Human authority must not inherit that model deadline.
        config.orchestrator.model_attempt_hard_timeout_secs = Some(1);
        let runtime = MorphzRuntime::builder(config, Arc::clone(&client) as Arc<dyn Client>)
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: false,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        let session = runtime
            .ensure_session(NewSession {
                id: "session-human-approval".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Human durable approval".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let mut requests = runtime.subscribe("runtime/approval_requested", 4);
        let mut replies = runtime.subscribe("chat/reply", 4);
        session
            .send(
                "read the human fixture",
                "User-Test",
                Some("client-human-approval".to_string()),
            )
            .await
            .unwrap();
        let request = tokio::time::timeout(std::time::Duration::from_secs(3), requests.recv())
            .await
            .unwrap()
            .unwrap();
        let approval_id = request.payload["approval_id"].as_str().unwrap().to_string();
        assert!(runtime
            .pending_approvals()
            .await
            .iter()
            .any(|entry| entry.request.approval_id == approval_id));

        tokio::time::sleep(std::time::Duration::from_millis(4_250)).await;
        let waiting_jobs = runtime
            .inner
            .store
            .list_execution_jobs(crate::memory::ExecutionJobFilter {
                session_id: Some(session.id.clone()),
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(waiting_jobs.len(), 1);
        assert_eq!(
            waiting_jobs[0].status,
            crate::memory::ExecutionJobStatus::WaitingApproval
        );
        let waiting_activations = runtime
            .inner
            .store
            .list_context_thread_activations(&runtime.identity().context_id, true)
            .await
            .unwrap();
        assert!(waiting_activations
            .iter()
            .any(|activation| activation.status == crate::memory::ThreadActivationStatus::Running));
        assert!(waiting_activations
            .iter()
            .all(|activation| activation.status != crate::memory::ThreadActivationStatus::Failed));
        assert!(runtime
            .inner
            .store
            .query(QueryFilter {
                session_id: Some(session.id.clone()),
                topic: Some("chat/runtime_error".to_string()),
                ..Default::default()
            })
            .await
            .unwrap()
            .is_empty());

        runtime
            .decide_approval(
                &approval_id,
                ApprovalDecision::AllowOnce {
                    rationale: "human approved exact fixture".to_string(),
                    risk_tags: vec!["human-approved".to_string()],
                },
            )
            .await
            .unwrap();
        let persisted = runtime
            .inner
            .store
            .get_approval(&approval_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(persisted.status, crate::memory::ApprovalStatus::Allowed);
        let reply = tokio::time::timeout(std::time::Duration::from_secs(8), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reply.payload["text"], "approval-work-complete");
        assert_eq!(reply.payload["thread_kind"], "execution");
        assert!(observed_result.load(Ordering::SeqCst));
        let consumed = runtime
            .inner
            .store
            .get_approval(&approval_id)
            .await
            .unwrap()
            .unwrap();
        assert!(consumed.grant_consumed_at.is_some());
        let jobs = runtime
            .inner
            .store
            .list_execution_jobs(crate::memory::ExecutionJobFilter {
                session_id: Some(session.id.clone()),
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(jobs.len(), 1, "one tool call must map to one physical Job");
        assert_eq!(jobs[0].status, crate::memory::ExecutionJobStatus::Succeeded);
        assert_eq!(client.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn session_cancellation_closes_unstarted_pending_human_job_and_waiter() {
        let database = NamedTempFile::new().unwrap();
        let fixture = NamedTempFile::new().unwrap();
        std::fs::write(fixture.path(), "must-not-be-read-after-cancel").unwrap();
        let client = Arc::new(ApprovalReadClient {
            calls: AtomicU64::new(0),
            path: fixture.path().to_string_lossy().into_owned(),
            expected_rejected: false,
            observed_result: Arc::new(AtomicBool::new(false)),
        });
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::User;
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: false,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        let session = runtime
            .ensure_session(NewSession {
                id: "session-cancel-pending-human".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Cancel pending human approval".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let mut requests = runtime.subscribe("runtime/approval_requested", 4);
        let mut replies = runtime.subscribe("chat/reply", 4);
        session
            .send(
                "read the fixture but wait for my approval",
                "User-Test",
                Some("client-cancel-pending-human".to_string()),
            )
            .await
            .unwrap();
        let request = tokio::time::timeout(std::time::Duration::from_secs(3), requests.recv())
            .await
            .unwrap()
            .unwrap();
        let approval_id = request.payload["approval_id"].as_str().unwrap().to_string();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if runtime
                    .inner
                    .human_approval_hub
                    .pending()
                    .iter()
                    .any(|pending| pending.request.approval_id == approval_id)
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("human waiter should attach before cancellation");

        assert!(session.cancel());
        let terminal = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let approval = runtime
                    .inner
                    .store
                    .get_approval(&approval_id)
                    .await
                    .unwrap()
                    .unwrap();
                let jobs = runtime
                    .inner
                    .store
                    .list_execution_jobs(crate::memory::ExecutionJobFilter {
                        session_id: Some(session.id().to_string()),
                        include_terminal: true,
                        ..Default::default()
                    })
                    .await
                    .unwrap();
                if approval.status == crate::memory::ApprovalStatus::Cancelled
                    && jobs.first().is_some_and(|job| {
                        job.status == crate::memory::ExecutionJobStatus::Cancelled
                    })
                {
                    break (approval, jobs.into_iter().next().unwrap());
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await;
        let (approval, job) = match terminal {
            Ok(value) => value,
            Err(_) => {
                let approval = runtime
                    .inner
                    .store
                    .get_approval(&approval_id)
                    .await
                    .unwrap()
                    .unwrap();
                let jobs = runtime
                    .inner
                    .store
                    .list_execution_jobs(crate::memory::ExecutionJobFilter {
                        session_id: Some(session.id().to_string()),
                        include_terminal: true,
                        ..Default::default()
                    })
                    .await
                    .unwrap();
                panic!(
                    "Session cancel did not close authority: approval={:?}, jobs={:?}, hub_pending={}",
                    approval.status,
                    jobs.iter()
                        .map(|job| (job.status, job.cancel_requested_at, job.error.as_deref()))
                        .collect::<Vec<_>>(),
                    runtime.inner.human_approval_hub.pending().len()
                );
            }
        };
        assert_eq!(approval.job_id, job.id);
        assert!(job.approval_ref.is_none());
        assert!(job.cancel_requested_at.is_some());
        assert!(job.side_effect_started_at.is_none());
        let result_event_id = job.result_event_id.as_deref().unwrap();
        let result = runtime
            .inner
            .store
            .query(QueryFilter {
                event_id: Some(result_event_id.to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].payload["tool_status"], "cancelled");
        assert_eq!(result[0].payload["executed"], false);
        assert!(runtime.inner.human_approval_hub.pending().is_empty());
        assert!(runtime.pending_approvals().await.is_empty());
        assert_eq!(client.calls.load(Ordering::SeqCst), 1);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(250), replies.recv())
                .await
                .is_err(),
            "cancelled pending action must not produce a user reply"
        );
    }

    async fn seed_pending_delivery_results(
        runtime: &MorphzRuntime,
        session_id: &str,
        texts: &[&str],
    ) {
        runtime
            .ensure_agent(NewAgent {
                id: runtime.identity().agent_id.clone(),
                title: "Delivery router agent".to_string(),
                root_context_id: runtime.identity().context_id.clone(),
            })
            .await
            .unwrap();
        runtime
            .ensure_context(NewCognitiveContext {
                id: runtime.identity().context_id.clone(),
                agent_id: runtime.identity().agent_id.clone(),
                title: "Delivery router context".to_string(),
            })
            .await
            .unwrap();
        runtime
            .ensure_session(NewSession {
                id: session_id.to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Delivery router".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        for (index, text) in texts.iter().enumerate() {
            let thread = runtime
                .inner
                .store
                .ensure_thread(crate::memory::NewThread {
                    id: format!("thread-{session_id}-{index}"),
                    agent_id: runtime.identity().agent_id.clone(),
                    context_id: runtime.identity().context_id.clone(),
                    session_id: session_id.to_string(),
                    initiating_principal_id: None,
                    root_turn_id: format!("root-{session_id}-{index}"),
                    kind: crate::memory::ThreadKind::Execution,
                    executor_kind: "self".to_string(),
                    executor_id: None,
                    target_id: None,
                    supervision: crate::memory::ThreadSupervision::legacy(),
                })
                .await
                .unwrap();
            runtime
                .inner
                .store
                .update_thread(
                    &thread.id,
                    thread.revision,
                    None,
                    Some(crate::memory::ThreadLifecycle::Completed),
                    Some(text),
                    Some(&format!("result-{session_id}-{index}")),
                    Some(crate::memory::DeliveryStatus::Pending),
                    None,
                )
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    async fn restart_passthrough_delivers_singleton_without_model_evaluation() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let policy = RuntimeToolPolicy {
            context_only: true,
            coding_eval: true,
        };
        let seed = MorphzRuntime::builder(config.clone(), Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .tool_policy(policy)
            .build()
            .await
            .unwrap();
        seed_pending_delivery_results(
            &seed,
            "session-delivery-singleton",
            &["singleton result is already user-facing"],
        )
        .await;
        drop(seed);

        let client = Arc::new(NoDeliveryModelClient {
            calls: AtomicU64::new(0),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            .tool_policy(policy)
            .build()
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 4);
        runtime.start().await.unwrap();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(4), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            reply.payload["text"],
            "singleton result is already user-facing"
        );
        assert_eq!(reply.payload["delivery_strategy"], "passthrough");
        assert_eq!(client.calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            runtime
                .inner
                .store
                .get_thread("thread-session-delivery-singleton-0")
                .await
                .unwrap()
                .unwrap()
                .delivery_status,
            crate::memory::DeliveryStatus::Delivered
        );
        assert!(runtime
            .inner
            .store
            .query(QueryFilter {
                session_id: Some("session-delivery-singleton".to_string()),
                topic: Some("chat/thread_completion_ready".to_string()),
                ..Default::default()
            })
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn restart_deterministically_batches_small_execution_results_without_model() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let policy = RuntimeToolPolicy {
            context_only: true,
            coding_eval: true,
        };
        let seed = MorphzRuntime::builder(config.clone(), Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .tool_policy(policy)
            .build()
            .await
            .unwrap();
        seed_pending_delivery_results(
            &seed,
            "session-delivery-deterministic",
            &["first concise result", "second concise result"],
        )
        .await;
        drop(seed);

        let client = Arc::new(NoDeliveryModelClient {
            calls: AtomicU64::new(0),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            .tool_policy(policy)
            .build()
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 4);
        runtime.start().await.unwrap();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(4), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reply.payload["delivery_strategy"], "deterministic_batch");
        assert_eq!(
            reply.payload["text"],
            "以下 2 项工作已完成：\n\n1. first concise result\n\n2. second concise result"
        );
        assert_eq!(reply.payload["covers"].as_array().unwrap().len(), 2);
        assert_eq!(client.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn semantic_delivery_hint_routes_a_small_batch_to_the_composer() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let policy = RuntimeToolPolicy {
            context_only: true,
            coding_eval: true,
        };
        let seed = MorphzRuntime::builder(config.clone(), Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .tool_policy(policy)
            .build()
            .await
            .unwrap();
        seed_pending_delivery_results(
            &seed,
            "session-delivery-semantic",
            &["recovered-result-one", "recovered-result-two"],
        )
        .await;
        seed.inner
            .store
            .append(Event::new(
                "result-session-delivery-semantic-0".to_string(),
                "Runtime-Test".to_string(),
                TYPE_TOOL_OUTPUT.to_string(),
                "runtime/test_delivery_result".to_string(),
                [
                    ("context_id".to_string(), json!(seed.identity().context_id)),
                    ("session_id".to_string(), json!("session-delivery-semantic")),
                    ("delivery_requires_composition".to_string(), json!(true)),
                ]
                .into_iter()
                .collect(),
            ))
            .await
            .unwrap();
        drop(seed);

        let observed_both_results = Arc::new(AtomicBool::new(false));
        let client = Arc::new(RecoveryMergeDeliveryClient {
            calls: AtomicU64::new(0),
            observed_both_results: Arc::clone(&observed_both_results),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            .tool_policy(policy)
            .build()
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 4);
        runtime.start().await.unwrap();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(4), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reply.payload["text"], "merged-recovered-delivery");
        assert!(observed_both_results.load(Ordering::SeqCst));
        assert_eq!(client.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn restart_merges_two_pending_results_into_one_delivery_evaluation() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        config.orchestrator.scheduler.delivery_merge_window =
            crate::config::HumanDuration::from_secs(1);
        config.orchestrator.scheduler.delivery_max_wait =
            crate::config::HumanDuration::from_secs(3);
        config
            .orchestrator
            .scheduler
            .delivery_deterministic_batch_max_chars = 1;
        let policy = RuntimeToolPolicy {
            context_only: true,
            coding_eval: true,
        };

        // Process A persisted two completed Threads but crashed before a
        // Delivery Timer could be armed or fired.
        let crashed = MorphzRuntime::builder(config.clone(), Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .tool_policy(policy)
            .build()
            .await
            .unwrap();
        crashed
            .ensure_agent(NewAgent {
                id: crashed.identity().agent_id.clone(),
                title: "Delivery recovery agent".to_string(),
                root_context_id: crashed.identity().context_id.clone(),
            })
            .await
            .unwrap();
        crashed
            .ensure_context(NewCognitiveContext {
                id: crashed.identity().context_id.clone(),
                agent_id: crashed.identity().agent_id.clone(),
                title: "Delivery recovery context".to_string(),
            })
            .await
            .unwrap();
        crashed
            .ensure_session(NewSession {
                id: "session-delivery-recovery".to_string(),
                agent_id: crashed.identity().agent_id.clone(),
                context_id: crashed.identity().context_id.clone(),
                parent_session_id: None,
                title: "Delivery recovery".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        for (index, text) in ["recovered-result-one", "recovered-result-two"]
            .into_iter()
            .enumerate()
        {
            let thread = crashed
                .inner
                .store
                .ensure_thread(crate::memory::NewThread {
                    id: format!("thread-delivery-recovery-{index}"),
                    agent_id: crashed.identity().agent_id.clone(),
                    context_id: crashed.identity().context_id.clone(),
                    session_id: "session-delivery-recovery".to_string(),
                    initiating_principal_id: None,
                    root_turn_id: format!("root-delivery-recovery-{index}"),
                    kind: crate::memory::ThreadKind::Execution,
                    executor_kind: "self".to_string(),
                    executor_id: None,
                    target_id: None,
                    supervision: crate::memory::ThreadSupervision::legacy(),
                })
                .await
                .unwrap();
            assert!(matches!(
                crashed
                    .inner
                    .store
                    .update_thread(
                        &thread.id,
                        thread.revision,
                        None,
                        Some(crate::memory::ThreadLifecycle::Completed),
                        Some(text),
                        Some(&format!("result-delivery-recovery-{index}")),
                        Some(crate::memory::DeliveryStatus::Pending),
                        None,
                    )
                    .await
                    .unwrap(),
                crate::memory::ThreadMutation::Updated(_)
            ));
        }
        drop(crashed);

        let observed_both_results = Arc::new(AtomicBool::new(false));
        let client = Arc::new(RecoveryMergeDeliveryClient {
            calls: AtomicU64::new(0),
            observed_both_results: Arc::clone(&observed_both_results),
        });
        let recovered = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            .tool_policy(policy)
            .build()
            .await
            .unwrap();
        let mut replies = recovered.subscribe("chat/reply", 4);
        recovered.start().await.unwrap();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(4), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reply.payload["text"], "merged-recovered-delivery");
        assert!(observed_both_results.load(Ordering::SeqCst));
        assert_eq!(client.calls.load(Ordering::SeqCst), 1);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(300), replies.recv())
                .await
                .is_err()
        );
        let ready_events = recovered
            .inner
            .store
            .query(QueryFilter {
                session_id: Some("session-delivery-recovery".to_string()),
                topic: Some("chat/thread_completion_ready".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(ready_events.len(), 1);
    }

    #[tokio::test]
    async fn delivery_reply_covers_only_the_trigger_snapshot() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        config.orchestrator.scheduler.delivery_merge_window =
            crate::config::HumanDuration::from_secs(1);
        config.orchestrator.scheduler.delivery_max_wait =
            crate::config::HumanDuration::from_secs(3);
        config
            .orchestrator
            .scheduler
            .delivery_deterministic_batch_max_items = 1;
        let policy = RuntimeToolPolicy {
            context_only: true,
            coding_eval: true,
        };

        let seed = MorphzRuntime::builder(config.clone(), Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .tool_policy(policy)
            .build()
            .await
            .unwrap();
        seed.ensure_agent(NewAgent {
            id: seed.identity().agent_id.clone(),
            title: "Delivery snapshot agent".to_string(),
            root_context_id: seed.identity().context_id.clone(),
        })
        .await
        .unwrap();
        seed.ensure_context(NewCognitiveContext {
            id: seed.identity().context_id.clone(),
            agent_id: seed.identity().agent_id.clone(),
            title: "Delivery snapshot context".to_string(),
        })
        .await
        .unwrap();
        seed.ensure_session(NewSession {
            id: "session-delivery-snapshot".to_string(),
            agent_id: seed.identity().agent_id.clone(),
            context_id: seed.identity().context_id.clone(),
            parent_session_id: None,
            title: "Delivery snapshot".to_string(),
            mount_kind: crate::memory::SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
        for (index, text) in ["snapshot-result-one", "snapshot-result-two"]
            .into_iter()
            .enumerate()
        {
            let thread = seed
                .inner
                .store
                .ensure_thread(crate::memory::NewThread {
                    id: format!("thread-delivery-snapshot-{index}"),
                    agent_id: seed.identity().agent_id.clone(),
                    context_id: seed.identity().context_id.clone(),
                    session_id: "session-delivery-snapshot".to_string(),
                    initiating_principal_id: None,
                    root_turn_id: format!("root-delivery-snapshot-{index}"),
                    kind: crate::memory::ThreadKind::Execution,
                    executor_kind: "self".to_string(),
                    executor_id: None,
                    target_id: None,
                    supervision: crate::memory::ThreadSupervision::legacy(),
                })
                .await
                .unwrap();
            seed.inner
                .store
                .update_thread(
                    &thread.id,
                    thread.revision,
                    None,
                    Some(crate::memory::ThreadLifecycle::Completed),
                    Some(text),
                    Some(&format!("result-delivery-snapshot-{index}")),
                    Some(crate::memory::DeliveryStatus::Pending),
                    None,
                )
                .await
                .unwrap();
        }
        drop(seed);

        let client = Arc::new(DeliverySnapshotRaceClient {
            calls: AtomicU64::new(0),
            entered: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            .tool_policy(policy)
            .build()
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 4);
        runtime.start().await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(4), client.entered.notified())
            .await
            .expect("Delivery model request should start");

        let late = runtime
            .inner
            .store
            .ensure_thread(crate::memory::NewThread {
                id: "thread-delivery-snapshot-late".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                session_id: "session-delivery-snapshot".to_string(),
                initiating_principal_id: None,
                root_turn_id: "root-delivery-snapshot-late".to_string(),
                kind: crate::memory::ThreadKind::Execution,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: crate::memory::ThreadSupervision::legacy(),
            })
            .await
            .unwrap();
        runtime
            .inner
            .store
            .update_thread(
                &late.id,
                late.revision,
                None,
                Some(crate::memory::ThreadLifecycle::Completed),
                Some("late-result-must-remain-pending"),
                Some("result-delivery-snapshot-late"),
                Some(crate::memory::DeliveryStatus::Pending),
                None,
            )
            .await
            .unwrap();
        client.release.notify_one();

        let reply = tokio::time::timeout(std::time::Duration::from_secs(3), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reply.payload["text"], "snapshot-delivery");
        assert_eq!(
            runtime
                .inner
                .store
                .get_thread("thread-delivery-snapshot-late")
                .await
                .unwrap()
                .unwrap()
                .delivery_status,
            crate::memory::DeliveryStatus::Pending,
            "a completion that arrived after the trigger snapshot must remain deliverable"
        );
        for index in 0..2 {
            assert_eq!(
                runtime
                    .inner
                    .store
                    .get_thread(&format!("thread-delivery-snapshot-{index}"))
                    .await
                    .unwrap()
                    .unwrap()
                    .delivery_status,
                crate::memory::DeliveryStatus::Delivered
            );
        }
    }

    #[tokio::test]
    async fn activation_claim_uses_persistent_lease_timer_and_terminal_commit_cancels_it() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let runtime = MorphzRuntime::builder(
            config,
            Arc::new(BlockingReplyClient {
                entered: Arc::clone(&entered),
                release: Arc::clone(&release),
            }),
        )
        .database_path(database.path().to_string_lossy())
        .tool_policy(RuntimeToolPolicy {
            context_only: true,
            coding_eval: true,
        })
        .build()
        .await
        .unwrap();
        runtime.start().await.unwrap();
        let session = runtime
            .ensure_session(NewSession {
                id: "session-activation-lease".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Activation lease".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 4);
        session
            .send(
                "hold activation",
                "User-Test",
                Some("client-activation-lease".to_string()),
            )
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), entered.notified())
            .await
            .unwrap();
        let activation = runtime
            .inner
            .store
            .list_context_thread_activations(runtime.identity().context_id.as_str(), false)
            .await
            .unwrap()
            .into_iter()
            .find(|activation| activation.session_id == "session-activation-lease")
            .expect("running activation must exist");
        assert_eq!(
            activation.status,
            crate::memory::ThreadActivationStatus::Running
        );
        let timer_id = format!("activation-lease:{}", activation.id);
        let timer = runtime
            .inner
            .store
            .get_runtime_timer(&timer_id)
            .await
            .unwrap()
            .expect("claim must persist activation lease timer");
        assert_eq!(timer.kind, crate::memory::RuntimeTimerKind::ActivationLease);
        assert_eq!(timer.generation, activation.revision);
        assert_eq!(timer.status, crate::memory::RuntimeTimerStatus::Pending);

        release.notify_one();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(2), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reply.payload["text"], "lease-complete");
        let timer = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let timer = runtime
                    .inner
                    .store
                    .get_runtime_timer(&timer_id)
                    .await
                    .unwrap()
                    .unwrap();
                if timer.status == crate::memory::RuntimeTimerStatus::Cancelled {
                    break timer;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(timer.status, crate::memory::RuntimeTimerStatus::Cancelled);
    }

    #[tokio::test]
    async fn expired_activation_lease_renews_while_same_local_execution_is_in_flight() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let runtime = MorphzRuntime::builder(
            config,
            Arc::new(BlockingReplyClient {
                entered: Arc::clone(&entered),
                release: Arc::clone(&release),
            }),
        )
        .database_path(database.path().to_string_lossy())
        .tool_policy(RuntimeToolPolicy {
            context_only: true,
            coding_eval: true,
        })
        .build()
        .await
        .unwrap();
        runtime.start().await.unwrap();
        let session = runtime
            .ensure_session(NewSession {
                id: "session-local-lease-renewal".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Local lease renewal".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 4);
        session
            .send(
                "hold activation through lease expiry",
                "User-Test",
                Some("client-local-lease-renewal".to_string()),
            )
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), entered.notified())
            .await
            .expect("model execution must hold the local admission permit");

        let running = runtime
            .inner
            .store
            .list_context_thread_activations(runtime.identity().context_id.as_str(), false)
            .await
            .unwrap()
            .into_iter()
            .find(|activation| activation.session_id == "session-local-lease-renewal")
            .expect("running activation must exist");
        let expired = match runtime
            .inner
            .store
            .update_thread_activation(
                &running.id,
                running.revision,
                crate::memory::ThreadActivationStatus::Running,
                running.claimed_by.as_deref(),
                Some(chrono::Utc::now() - chrono::Duration::seconds(1)),
                running.context_snapshot_version,
            )
            .await
            .unwrap()
        {
            crate::memory::ThreadActivationMutation::Updated(expired) => expired,
            other => panic!("unexpected activation mutation: {other:?}"),
        };
        let timer_id = format!("activation-lease:{}", expired.id);
        runtime
            .inner
            .timer_engine
            .schedule(crate::memory::NewRuntimeTimer {
                id: timer_id.clone(),
                generation: expired.revision,
                kind: crate::memory::RuntimeTimerKind::ActivationLease,
                owner_id: expired.id.clone(),
                due_at: expired.lease_expires_at.unwrap(),
                payload: json!({
                    "activation_id": expired.id,
                    "revision": expired.revision,
                    "claimed_by": expired.claimed_by,
                    "trigger_event_id": expired.trigger_event_id,
                }),
            })
            .await
            .unwrap();

        let renewed = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let activation = runtime
                    .inner
                    .store
                    .get_thread_activation(&expired.id)
                    .await
                    .unwrap()
                    .unwrap();
                let timer = runtime
                    .inner
                    .store
                    .get_runtime_timer(&timer_id)
                    .await
                    .unwrap()
                    .unwrap();
                if activation.revision > expired.revision
                    && activation
                        .lease_expires_at
                        .is_some_and(|expires_at| expires_at > chrono::Utc::now())
                    && timer.generation == activation.revision
                    && timer.status == crate::memory::RuntimeTimerStatus::Pending
                {
                    break activation;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("expired local Activation must advance to a pending recovery generation");
        assert_eq!(
            renewed.status,
            crate::memory::ThreadActivationStatus::Running
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), replies.recv())
                .await
                .is_err(),
            "lease renewal must not create a duplicate reply while the original execution runs"
        );

        release.notify_one();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(2), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reply.payload["text"], "lease-complete");
        let timer = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let timer = runtime
                    .inner
                    .store
                    .get_runtime_timer(&timer_id)
                    .await
                    .unwrap()
                    .unwrap();
                if timer.status == crate::memory::RuntimeTimerStatus::Cancelled {
                    break timer;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(timer.generation, renewed.revision);
    }

    #[tokio::test]
    async fn expired_activation_is_recovered_without_restarting_the_runtime() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let runtime = MorphzRuntime::builder(config, Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        runtime
            .ensure_session(NewSession {
                id: "session-live-activation-recovery".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Live Activation recovery".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let trigger = Event::new(
            "event-live-activation-recovery".to_string(),
            "System-Test".to_string(),
            crate::event::TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            [
                (
                    "context_id".to_string(),
                    json!(runtime.identity().context_id),
                ),
                (
                    "session_id".to_string(),
                    json!("session-live-activation-recovery"),
                ),
                ("tool_name".to_string(), json!("recovery_fixture")),
                ("text".to_string(), json!("recover without restart")),
                (
                    "root_turn_id".to_string(),
                    json!("root-live-activation-recovery"),
                ),
            ]
            .into_iter()
            .collect(),
        );
        runtime.inner.store.append(trigger.clone()).await.unwrap();
        let trigger_sequence = runtime
            .inner
            .store
            .query(QueryFilter {
                event_id: Some(trigger.id.clone()),
                ..Default::default()
            })
            .await
            .unwrap()[0]
            .sequence
            .unwrap();
        runtime
            .inner
            .store
            .ensure_thread(crate::memory::NewThread {
                id: "thread-live-activation-recovery".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                session_id: "session-live-activation-recovery".to_string(),
                initiating_principal_id: None,
                root_turn_id: "root-live-activation-recovery".to_string(),
                kind: crate::memory::ThreadKind::Execution,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: crate::memory::ThreadSupervision::legacy(),
            })
            .await
            .unwrap();
        let queued = runtime
            .inner
            .store
            .claim_thread_signal_batch(
                crate::memory::NewThreadSignal {
                    id: "signal-live-activation-recovery".to_string(),
                    thread_id: "thread-live-activation-recovery".to_string(),
                    thread_generation: 1,
                    event_id: trigger.id.clone(),
                    principal_id: None,
                    sequence: trigger_sequence,
                    kind: trigger.topic.clone(),
                    parent_activation_id: None,
                },
                crate::memory::NewThreadActivation {
                    id: "activation-live-recovery".to_string(),
                    agent_id: runtime.identity().agent_id.clone(),
                    context_id: runtime.identity().context_id.clone(),
                    session_id: "session-live-activation-recovery".to_string(),
                    initiating_principal_id: None,
                    trigger_event_id: trigger.id.clone(),
                    trigger_sequence,
                    trigger_kind: trigger.topic.clone(),
                    parent_activation_id: None,
                    root_turn_id: "root-live-activation-recovery".to_string(),
                },
                32,
            )
            .await
            .unwrap()
            .unwrap();
        let expired = match runtime
            .inner
            .store
            .update_thread_activation(
                &queued.id,
                queued.revision,
                crate::memory::ThreadActivationStatus::Running,
                Some("runtime:dead-owner"),
                Some(chrono::Utc::now() - chrono::Duration::milliseconds(1)),
                None,
            )
            .await
            .unwrap()
        {
            crate::memory::ThreadActivationMutation::Updated(expired) => expired,
            other => panic!("unexpected activation mutation: {other:?}"),
        };
        let mut replies = runtime.subscribe("chat/reply", 4);
        runtime
            .inner
            .timer_engine
            .schedule(crate::memory::NewRuntimeTimer {
                id: format!("activation-lease:{}", expired.id),
                generation: expired.revision,
                kind: crate::memory::RuntimeTimerKind::ActivationLease,
                owner_id: expired.id.clone(),
                due_at: expired.lease_expires_at.unwrap(),
                payload: json!({
                    "activation_id": expired.id,
                    "revision": expired.revision,
                    "trigger_event_id": expired.trigger_event_id,
                }),
            })
            .await
            .unwrap();

        let reply = tokio::time::timeout(std::time::Duration::from_secs(3), replies.recv())
            .await
            .expect("the live timer must recover an expired Activation")
            .unwrap();
        assert_eq!(reply.payload["text"], "runtime-ok");
        let recovered = runtime
            .inner
            .store
            .get_thread_activation("activation-live-recovery")
            .await
            .unwrap()
            .unwrap();
        assert!(recovered.status.is_terminal());
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(150), replies.recv())
                .await
                .is_err(),
            "one expired physical Activation must yield only one recovery reply",
        );
    }

    #[tokio::test]
    async fn stale_same_host_activation_recovers_before_lease_expiry_after_restart() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let policy = RuntimeToolPolicy {
            context_only: true,
            coding_eval: true,
        };
        let crashed = MorphzRuntime::builder(config.clone(), Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .tool_policy(policy)
            .build()
            .await
            .unwrap();
        crashed
            .ensure_agent(NewAgent {
                id: crashed.identity().agent_id.clone(),
                title: "Activation recovery agent".to_string(),
                root_context_id: crashed.identity().context_id.clone(),
            })
            .await
            .unwrap();
        crashed
            .ensure_context(NewCognitiveContext {
                id: crashed.identity().context_id.clone(),
                agent_id: crashed.identity().agent_id.clone(),
                title: "Activation recovery context".to_string(),
            })
            .await
            .unwrap();
        crashed
            .ensure_session(NewSession {
                id: "session-activation-recovery".to_string(),
                agent_id: crashed.identity().agent_id.clone(),
                context_id: crashed.identity().context_id.clone(),
                parent_session_id: None,
                title: "Activation recovery".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let trigger = Event::new(
            "event-activation-recovery".to_string(),
            "System-Test".to_string(),
            crate::event::TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            [
                (
                    "context_id".to_string(),
                    json!(crashed.identity().context_id),
                ),
                (
                    "session_id".to_string(),
                    json!("session-activation-recovery"),
                ),
                ("tool_name".to_string(), json!("recovery_fixture")),
                ("text".to_string(), json!("resume persisted work")),
                (
                    "root_turn_id".to_string(),
                    json!("root-activation-recovery"),
                ),
            ]
            .into_iter()
            .collect(),
        );
        crashed.inner.store.append(trigger.clone()).await.unwrap();
        let trigger_sequence = crashed
            .inner
            .store
            .query(QueryFilter {
                event_id: Some(trigger.id.clone()),
                ..Default::default()
            })
            .await
            .unwrap()[0]
            .sequence
            .unwrap();
        crashed
            .inner
            .store
            .ensure_thread(crate::memory::NewThread {
                id: "thread-activation-recovery".to_string(),
                agent_id: crashed.identity().agent_id.clone(),
                context_id: crashed.identity().context_id.clone(),
                session_id: "session-activation-recovery".to_string(),
                initiating_principal_id: None,
                root_turn_id: "root-activation-recovery".to_string(),
                kind: crate::memory::ThreadKind::Execution,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: crate::memory::ThreadSupervision::legacy(),
            })
            .await
            .unwrap();
        let activation = crashed
            .inner
            .store
            .claim_thread_signal_batch(
                crate::memory::NewThreadSignal {
                    id: "signal-activation-recovery".to_string(),
                    thread_id: "thread-activation-recovery".to_string(),
                    thread_generation: 1,
                    event_id: trigger.id.clone(),
                    principal_id: None,
                    sequence: trigger_sequence,
                    kind: trigger.topic.clone(),
                    parent_activation_id: None,
                },
                crate::memory::NewThreadActivation {
                    id: "activation-recovery".to_string(),
                    agent_id: crashed.identity().agent_id.clone(),
                    context_id: crashed.identity().context_id.clone(),
                    session_id: "session-activation-recovery".to_string(),
                    initiating_principal_id: None,
                    trigger_event_id: trigger.id.clone(),
                    trigger_sequence,
                    trigger_kind: trigger.topic.clone(),
                    parent_activation_id: None,
                    root_turn_id: "root-activation-recovery".to_string(),
                },
                32,
            )
            .await
            .unwrap()
            .unwrap();
        let running = match crashed
            .inner
            .store
            .update_thread_activation(
                &activation.id,
                activation.revision,
                crate::memory::ThreadActivationStatus::Running,
                Some(&format!(
                    "runtime:{}:previous-process-instance",
                    std::process::id()
                )),
                Some(chrono::Utc::now() + chrono::Duration::minutes(10)),
                None,
            )
            .await
            .unwrap()
        {
            crate::memory::ThreadActivationMutation::Updated(running) => running,
            other => panic!("unexpected activation mutation: {other:?}"),
        };
        crashed
            .inner
            .timer_engine
            .schedule(crate::memory::NewRuntimeTimer {
                id: format!("activation-lease:{}", running.id),
                generation: running.revision,
                kind: crate::memory::RuntimeTimerKind::ActivationLease,
                owner_id: running.id.clone(),
                due_at: running.lease_expires_at.unwrap(),
                payload: json!({
                    "activation_id": running.id,
                    "revision": running.revision,
                    "trigger_event_id": running.trigger_event_id,
                }),
            })
            .await
            .unwrap();
        drop(crashed);

        let recovered = MorphzRuntime::builder(config, Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .tool_policy(policy)
            .build()
            .await
            .unwrap();
        let mut replies = recovered.subscribe("chat/reply", 4);
        recovered.start().await.unwrap();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(3), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reply.payload["text"], "runtime-ok");
        let activation = recovered
            .inner
            .store
            .get_thread_activation("activation-recovery")
            .await
            .unwrap()
            .unwrap();
        assert!(activation.status.is_terminal());
        let lease_timer_id = format!("activation-lease:{}", activation.id);
        let lease_timer = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                let timer = recovered
                    .inner
                    .store
                    .get_runtime_timer(&lease_timer_id)
                    .await
                    .unwrap()
                    .unwrap();
                if matches!(
                    timer.status,
                    crate::memory::RuntimeTimerStatus::Fired
                        | crate::memory::RuntimeTimerStatus::Cancelled
                ) {
                    break timer;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(matches!(
            lease_timer.status,
            crate::memory::RuntimeTimerStatus::Fired | crate::memory::RuntimeTimerStatus::Cancelled
        ));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(150), replies.recv())
                .await
                .is_err(),
            "已死亡 Runtime 的未过期 Activation lease 在重启恢复后只能产生一次终态回复"
        );
    }

    #[tokio::test]
    async fn runtime_restart_dispatches_a_committed_but_unpublished_message() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let tool_policy = RuntimeToolPolicy {
            context_only: true,
            coding_eval: true,
        };

        // Simulate process A: commit the physical user input and its Outbox record, then crash
        // before EventBus publication. The Runtime is deliberately never started here.
        let crashed_runtime = MorphzRuntime::builder(config.clone(), Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .tool_policy(tool_policy)
            .build()
            .await
            .unwrap();
        crashed_runtime
            .ensure_agent(NewAgent {
                id: crashed_runtime.identity().agent_id.clone(),
                title: "Outbox recovery agent".to_string(),
                root_context_id: crashed_runtime.identity().context_id.clone(),
            })
            .await
            .unwrap();
        crashed_runtime
            .ensure_context(NewCognitiveContext {
                id: crashed_runtime.identity().context_id.clone(),
                agent_id: crashed_runtime.identity().agent_id.clone(),
                title: "Outbox recovery context".to_string(),
            })
            .await
            .unwrap();
        crashed_runtime
            .ensure_session(NewSession {
                id: "session-runtime-outbox-recovery".to_string(),
                agent_id: crashed_runtime.identity().agent_id.clone(),
                context_id: crashed_runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Outbox recovery session".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let event = Event::new(
            "event-runtime-outbox-recovery".to_string(),
            "User-Test".to_string(),
            TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            [
                (
                    "context_id".to_string(),
                    json!(crashed_runtime.identity().context_id),
                ),
                (
                    "session_id".to_string(),
                    json!("session-runtime-outbox-recovery"),
                ),
                (
                    "client_message_id".to_string(),
                    json!("client-runtime-outbox-recovery"),
                ),
                ("text".to_string(), json!("recover this message")),
            ]
            .into_iter()
            .collect(),
        );
        assert_eq!(
            crashed_runtime
                .inner
                .store
                .claim_message(
                    "session-runtime-outbox-recovery",
                    "client-runtime-outbox-recovery",
                    &event,
                )
                .await
                .unwrap(),
            MessageClaim::Accepted
        );
        assert_eq!(
            crashed_runtime
                .inner
                .store
                .list_signal_outbox(crate::memory::SignalOutboxStatus::Pending, 10)
                .await
                .unwrap()
                .len(),
            1
        );
        drop(crashed_runtime);

        // Simulate process B: startup recovery must materialize the pending Outbox record into
        // one Signal/Activation and complete the ordinary reply path without another user input.
        let recovered_runtime = MorphzRuntime::builder(config, Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .tool_policy(tool_policy)
            .build()
            .await
            .unwrap();
        let mut replies = recovered_runtime.subscribe("chat/reply", 8);
        recovered_runtime.start().await.unwrap();
        // Startup recovery performs durable Outbox materialization before the
        // reply can be emitted.  Preserve a finite failure bound while leaving
        // headroom for SQLite contention in the full parallel test suite.
        let reply = tokio::time::timeout(std::time::Duration::from_secs(10), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            reply.payload.get("text").and_then(|value| value.as_str()),
            Some("runtime-ok")
        );
        let outbox = recovered_runtime
            .inner
            .store
            .list_signal_outbox(crate::memory::SignalOutboxStatus::Materialized, 10)
            .await
            .unwrap();
        assert_eq!(outbox.len(), 1);
        assert_eq!(outbox[0].event_id, "event-runtime-outbox-recovery");
        assert!(outbox[0].signal_id.is_some());
    }

    #[tokio::test]
    async fn objective_supervisor_continues_without_fake_user_message_and_stops_after_commit() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let client = Arc::new(ObjectiveCompletingClient {
            calls: AtomicU64::new(0),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        runtime
            .ensure_session(NewSession {
                id: "session-objective-runtime".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Objective runtime test".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 8);
        runtime
            .create_objective(NewObjective {
                id: "objective-runtime".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                coordinator_session_id: "session-objective-runtime".to_string(),
                delivery_session_id: "session-objective-runtime".to_string(),
                parent_objective_id: None,
                source_event_id: "runtime-test-source".to_string(),
                initiating_principal_id: None,
                stated_objective: "完成 Supervisor 确定性回归测试".to_string(),
                token_budget: None,
            })
            .await
            .unwrap();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(3), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            reply.payload.get("text").and_then(|value| value.as_str()),
            Some("objective-complete")
        );
        assert_eq!(
            reply
                .payload
                .get("objective_id")
                .and_then(|value| value.as_str()),
            Some("objective-runtime")
        );
        let objective = objective_after_evaluation_release(&runtime, "objective-runtime").await;
        assert_eq!(objective.status, ObjectiveStatus::Completed);
        assert!(objective.active_evaluation_id.is_none());
        assert!(
            objective.tokens_used > 0,
            "Objective 应累计每次 Evaluation 的完整 Prompt 本地计量"
        );
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(client.calls.load(Ordering::SeqCst), 2);

        let events = runtime
            .query_events(QueryFilter {
                session_id: Some("session-objective-runtime".to_string()),
                top_k: Some(100),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(events
            .iter()
            .any(|event| event.topic == "objective/evaluation_started"));
        let continuation = events
            .iter()
            .find(|event| {
                event.topic == "chat/tool_output"
                    && event
                        .payload
                        .get("tool_name")
                        .and_then(|value| value.as_str())
                        == Some("objective_supervisor")
            })
            .expect("Supervisor should persist an internal continuation event");
        assert_ne!(continuation.event_type, TYPE_USER_MESSAGE);
    }

    #[tokio::test]
    async fn concurrent_user_reply_cannot_steal_an_active_objective_evaluation() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let client = Arc::new(ConcurrentObjectiveRouteClient {
            objective_started: tokio::sync::Notify::new(),
            release_objective: tokio::sync::Notify::new(),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        let session = runtime
            .ensure_session(NewSession {
                id: "session-objective-concurrent".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Concurrent Objective route test".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 8);
        runtime
            .create_objective(NewObjective {
                id: "objective-concurrent-route".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                coordinator_session_id: session.id().to_string(),
                delivery_session_id: session.id().to_string(),
                parent_objective_id: None,
                source_event_id: "objective-concurrent-source".to_string(),
                initiating_principal_id: None,
                stated_objective: "保持一个尚未结束的 Objective Evaluation".to_string(),
                token_budget: None,
            })
            .await
            .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            client.objective_started.notified(),
        )
        .await
        .expect("Objective Evaluation should enter the model before the user message");

        session
            .send(
                "unrelated concurrent message",
                "User-Test",
                Some("objective-concurrent-user-message".to_string()),
            )
            .await
            .unwrap();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(2), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            reply.payload.get("text"),
            Some(&json!("unrelated-user-reply"))
        );
        assert!(reply.payload.get("objective_id").is_none());
        assert!(reply.payload.get("objective_evaluation_id").is_none());

        let active = runtime
            .get_objective("objective-concurrent-route")
            .await
            .unwrap()
            .unwrap();
        assert!(active.active_evaluation_id.is_some());
        let lease_timer = runtime
            .inner
            .store
            .get_runtime_timer("objective-lease:objective-concurrent-route")
            .await
            .unwrap()
            .expect("active Objective Evaluation must have a persistent lease timer");
        assert_eq!(lease_timer.generation, active.revision);
        assert_eq!(
            lease_timer.kind,
            crate::memory::RuntimeTimerKind::ObjectiveLease
        );
        assert_eq!(
            lease_timer.status,
            crate::memory::RuntimeTimerStatus::Pending
        );
        runtime
            .cancel_objective(&active.id, active.revision, "结束并发路由确定性测试")
            .await
            .unwrap();
        assert_eq!(
            runtime
                .inner
                .store
                .get_runtime_timer("objective-lease:objective-concurrent-route")
                .await
                .unwrap()
                .unwrap()
                .status,
            crate::memory::RuntimeTimerStatus::Cancelled
        );
        client.release_objective.notify_one();
    }

    #[tokio::test]
    async fn same_session_objectives_run_concurrently_and_pause_is_scoped() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        config.orchestrator.activation_admission.max_in_flight = 8;
        let client = Arc::new(ObjectiveScopedCancellationClient {
            objective_a_started: tokio::sync::Notify::new(),
            objective_a_cancelled: tokio::sync::Notify::new(),
            objective_b_started: tokio::sync::Notify::new(),
            objective_b_cancelled: tokio::sync::Notify::new(),
            objective_b_calls: AtomicU64::new(0),
            dialogue_started: tokio::sync::Notify::new(),
            release_dialogue: tokio::sync::Notify::new(),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        let session = runtime
            .ensure_session(NewSession {
                id: "session-objective-scoped-cancel".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Objective scoped cancellation".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 8);
        runtime
            .create_objective(NewObjective {
                id: "objective-scoped-a".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                coordinator_session_id: session.id().to_string(),
                delivery_session_id: session.id().to_string(),
                parent_objective_id: None,
                source_event_id: "objective-scoped-a-source".to_string(),
                initiating_principal_id: None,
                stated_objective: "保持 Objective A 运行直到被暂停".to_string(),
                token_budget: None,
            })
            .await
            .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(3),
            client.objective_a_started.notified(),
        )
        .await
        .expect("Objective A should start");

        let activation = runtime
            .active_thread_activations(runtime.identity().context_id.as_str())
            .await
            .unwrap()
            .into_iter()
            .find(|activation| {
                activation.session_id == session.id()
                    && activation.status == crate::memory::ThreadActivationStatus::Running
            })
            .expect("Objective A should own one running Activation");
        let thread = runtime
            .inner
            .store
            .get_thread_by_root(&activation.root_turn_id)
            .await
            .unwrap()
            .expect("Objective Activation should have a Thread");
        assert_eq!(
            runtime
                .inner
                .objective_supervisor
                .evaluations()
                .get_for_activation(&activation.id)
                .as_ref()
                .map(|evaluation| evaluation.objective_id.as_str()),
            Some("objective-scoped-a")
        );
        let execution_spec = crate::execution::ExecutionJobSpec {
            activation_id: activation.id.clone(),
            thread_id: thread.id,
            agent_id: runtime.identity().agent_id.clone(),
            context_id: runtime.identity().context_id.clone(),
            session_id: session.id().to_string(),
            initiating_principal_id: None,
            target_id: crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
            tool_call_id: "objective-scoped-physical-call".to_string(),
            tool_name: "test-physical-tool".to_string(),
            request: json!({"probe": true}),
            retry_safety: crate::memory::ExecutionRetrySafety::Idempotent,
            requires_approval: false,
        };
        let execution_job = {
            let mut last_error = None;
            let mut created = None;
            for _ in 0..20 {
                match runtime
                    .inner
                    .execution_jobs
                    .ensure(execution_spec.clone())
                    .await
                {
                    Ok(job) => {
                        created = Some(job);
                        break;
                    }
                    Err(error) if error.to_string().contains("database is locked") => {
                        last_error = Some(error);
                        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    }
                    Err(error) => panic!("failed to create Execution Job: {error}"),
                }
            }
            created.unwrap_or_else(|| panic!("Execution Job remained locked: {last_error:?}"))
        };

        runtime
            .create_objective(NewObjective {
                id: "objective-scoped-b".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                coordinator_session_id: session.id().to_string(),
                delivery_session_id: session.id().to_string(),
                parent_objective_id: None,
                source_event_id: "objective-scoped-b-source".to_string(),
                initiating_principal_id: None,
                stated_objective: "Objective B 必须在 A 暂停后继续".to_string(),
                token_budget: None,
            })
            .await
            .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(3),
            client.objective_b_started.notified(),
        )
        .await
        .expect("Objective B should start while same-Session Objective A is still running");
        let objective_b_active = runtime
            .get_objective("objective-scoped-b")
            .await
            .unwrap()
            .unwrap();
        assert!(objective_b_active.active_evaluation_id.is_some());
        assert!(runtime
            .inner
            .objective_supervisor
            .evaluations()
            .get_for_objective("objective-scoped-a")
            .is_some());
        assert!(runtime
            .inner
            .objective_supervisor
            .evaluations()
            .get_for_objective("objective-scoped-b")
            .is_some());
        session
            .send(
                "dialogue survives scoped objective cancellation",
                "User-Test",
                Some("objective-scoped-dialogue".to_string()),
            )
            .await
            .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(3),
            client.dialogue_started.notified(),
        )
        .await
        .expect("same-Session dialogue should run alongside Objective A");

        let objective_a = runtime
            .get_objective("objective-scoped-a")
            .await
            .unwrap()
            .unwrap();
        runtime
            .pause_objective(
                &objective_a.id,
                objective_a.revision,
                "验证 Objective 作用域暂停",
            )
            .await
            .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(3),
            client.objective_a_cancelled.notified(),
        )
        .await
        .expect("Objective A model future should be dropped");
        let cancelled_activation = {
            let mut observed = None;
            for _ in 0..50 {
                let current = runtime
                    .inner
                    .store
                    .get_thread_activation(&activation.id)
                    .await
                    .unwrap()
                    .unwrap();
                if current.status == crate::memory::ThreadActivationStatus::Cancelled {
                    observed = Some(current);
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            observed.expect("Objective A Activation should commit a cancelled terminal fact")
        };
        assert_eq!(cancelled_activation.id, activation.id);
        let execution_job = {
            let mut observed = None;
            for _ in 0..50 {
                let current = runtime
                    .inner
                    .store
                    .get_execution_job(&execution_job.id)
                    .await
                    .unwrap()
                    .unwrap();
                if current.status == crate::memory::ExecutionJobStatus::Cancelled {
                    observed = Some(current);
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            observed.expect("Objective cancellation should persist physical Job intent")
        };
        assert!(execution_job.cancel_requested_at.is_some());
        assert_eq!(
            execution_job.status,
            crate::memory::ExecutionJobStatus::Cancelled
        );
        assert!(execution_job.side_effect_started_at.is_none());
        let cancellation_event = runtime
            .inner
            .store
            .query(QueryFilter {
                event_id: execution_job.result_event_id.clone(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(cancellation_event.len(), 1);
        assert_eq!(cancellation_event[0].payload["tool_status"], "cancelled");
        assert_eq!(cancellation_event[0].payload["executed"], false);
        assert_eq!(
            runtime
                .get_objective("objective-scoped-a")
                .await
                .unwrap()
                .unwrap()
                .status,
            ObjectiveStatus::Paused
        );
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(100),
                client.objective_b_cancelled.notified(),
            )
            .await
            .is_err(),
            "pausing Objective A must not cancel concurrent sibling Objective B"
        );
        assert!(runtime
            .get_objective("objective-scoped-b")
            .await
            .unwrap()
            .unwrap()
            .active_evaluation_id
            .is_some());

        client.release_dialogue.notify_one();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(3), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reply.payload["text"], "dialogue-still-alive");
        let objective_b = runtime
            .get_objective("objective-scoped-b")
            .await
            .unwrap()
            .unwrap();
        let objective_b_evaluation_id = objective_b
            .active_evaluation_id
            .clone()
            .expect("Objective B should still own its exact Evaluation before cancellation");
        runtime
            .cancel_objective(
                &objective_b.id,
                objective_b.revision,
                "结束 Objective B 验收",
            )
            .await
            .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(3),
            client.objective_b_cancelled.notified(),
        )
        .await
        .expect("Objective B should receive its own scoped cancellation");
        for _ in 0..50 {
            if runtime
                .inner
                .objective_supervisor
                .evaluations()
                .activation_ids_for_evaluation("objective-scoped-b", &objective_b_evaluation_id)
                .is_empty()
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(runtime
            .inner
            .objective_supervisor
            .evaluations()
            .activation_ids_for_evaluation("objective-scoped-b", &objective_b_evaluation_id)
            .is_empty());

        // A continuation persisted or delivered after the control commit must
        // be rejected against durable Objective state, even after the local
        // cancellation tombstone has been cleaned with the original Activation.
        let stale_event = Event::new(
            "objective-scoped-b-stale-continuation".to_string(),
            "Runtime-Test".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            [
                (
                    "context_id".to_string(),
                    json!(runtime.identity().context_id),
                ),
                ("session_id".to_string(), json!(session.id())),
                ("objective_id".to_string(), json!(objective_b.id)),
                (
                    "objective_evaluation_id".to_string(),
                    json!(objective_b_evaluation_id),
                ),
                ("runtime_force_evaluation".to_string(), json!(true)),
                ("tool_name".to_string(), json!("objective_supervisor")),
                ("tool_status".to_string(), json!("success")),
                (
                    "text".to_string(),
                    json!("stale Objective continuation after cancellation"),
                ),
            ]
            .into_iter()
            .collect(),
        );
        runtime.publish(stale_event).await.unwrap();
        let stale_activation = {
            let mut observed = None;
            for _ in 0..100 {
                let current = runtime
                    .inner
                    .store
                    .list_context_thread_activations(runtime.identity().context_id.as_str(), true)
                    .await
                    .unwrap()
                    .into_iter()
                    .find(|activation| {
                        activation.trigger_event_id == "objective-scoped-b-stale-continuation"
                    });
                if let Some(current) = current {
                    if current.status == crate::memory::ThreadActivationStatus::Cancelled {
                        observed = Some(current);
                        break;
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            observed
                .expect("late Objective continuation should reach an audited cancelled Activation")
        };
        assert_eq!(
            stale_activation.status,
            crate::memory::ThreadActivationStatus::Cancelled
        );
        assert_eq!(client.objective_b_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn blocked_objective_keeps_final_reply_routing_then_releases_its_evaluation() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let client = Arc::new(ObjectiveBlockedClient {
            calls: AtomicU64::new(0),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        runtime
            .ensure_session(NewSession {
                id: "session-objective-blocked".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Objective blocked test".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 8);
        runtime
            .create_objective(NewObjective {
                id: "objective-blocked".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                coordinator_session_id: "session-objective-blocked".to_string(),
                delivery_session_id: "session-objective-blocked".to_string(),
                parent_objective_id: None,
                source_event_id: "runtime-test-blocked-source".to_string(),
                initiating_principal_id: None,
                stated_objective: "验证真实阻塞会交付说明并停止自动续跑".to_string(),
                token_budget: None,
            })
            .await
            .unwrap();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(3), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            reply.payload.get("text").and_then(|value| value.as_str()),
            Some("objective-needs-user-decision")
        );
        assert_eq!(
            reply
                .payload
                .get("objective_id")
                .and_then(|value| value.as_str()),
            Some("objective-blocked")
        );
        let objective = objective_after_evaluation_release(&runtime, "objective-blocked").await;
        assert_eq!(objective.status, ObjectiveStatus::Blocked);
        assert!(objective.active_evaluation_id.is_none());
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(client.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn active_objective_survives_more_than_one_hundred_model_evaluations() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let client = Arc::new(ObjectiveLongRunClient {
            calls: AtomicU64::new(0),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        runtime
            .ensure_session(NewSession {
                id: "session-objective-long-run".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Objective long-run test".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 8);
        runtime
            .create_objective(NewObjective {
                id: "objective-long-run".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                coordinator_session_id: "session-objective-long-run".to_string(),
                delivery_session_id: "session-objective-long-run".to_string(),
                parent_objective_id: None,
                source_event_id: "runtime-test-long-run-source".to_string(),
                initiating_principal_id: None,
                stated_objective: "持续求值超过一百次后再显式完成".to_string(),
                token_budget: None,
            })
            .await
            .unwrap();
        // Over a hundred model evaluations, so this needs more headroom than a
        // wait for a single reply.
        let reply = tokio::time::timeout(std::time::Duration::from_secs(60), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            reply.payload.get("text").and_then(|value| value.as_str()),
            Some("long-objective-complete")
        );
        let objective = objective_after_evaluation_release(&runtime, "objective-long-run").await;
        assert_eq!(objective.status, ObjectiveStatus::Completed);
        assert_eq!(objective.continuation_sequence, 101);
        assert_eq!(client.calls.load(Ordering::SeqCst), 102);
    }

    #[tokio::test]
    async fn llm_can_create_one_idempotent_objective_and_current_evaluation_is_adopted() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let client = Arc::new(ObjectiveAutonomousCreateClient {
            calls: AtomicU64::new(0),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        let session = runtime
            .ensure_session(NewSession {
                id: "session-objective-autonomous".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Autonomous Objective test".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 8);
        session
            .send(
                "请自主建立一个需要跨 Evaluation 完成的持久目标并完成它",
                "User-Test",
                Some("autonomous-objective-message".to_string()),
            )
            .await
            .unwrap();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(5), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            reply.payload.get("text").and_then(|value| value.as_str()),
            Some("autonomous-objective-complete")
        );
        let objective_id = reply
            .payload
            .get("objective_id")
            .and_then(|value| value.as_str())
            .expect("final reply should retain autonomous Objective routing")
            .to_string();
        assert!(objective_id.starts_with("objective-auto-"));
        let objective = objective_after_evaluation_release(&runtime, &objective_id).await;
        assert_eq!(objective.status, ObjectiveStatus::Completed);
        assert_eq!(objective.continuation_sequence, 2);
        assert_eq!(client.calls.load(Ordering::SeqCst), 5);

        let matching = runtime
            .list_context_objectives(&runtime.identity().context_id, true)
            .await
            .unwrap()
            .into_iter()
            .filter(|objective| {
                objective.stated_objective == "自主创建并完成一个跨 Evaluation 的持久目标"
            })
            .collect::<Vec<_>>();
        assert_eq!(matching.len(), 1, "重复 objective_create 必须幂等");

        let autonomous_requests = runtime
            .query_events(QueryFilter {
                topic: Some("objective/autonomous_requested".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(autonomous_requests.len(), 1);
        assert_eq!(
            autonomous_requests[0]
                .payload
                .get("requested_objective_id")
                .and_then(|value| value.as_str()),
            Some(objective_id.as_str())
        );

        let continuations = runtime
            .query_events(QueryFilter {
                session_id: Some("session-objective-autonomous".to_string()),
                topic: Some("chat/tool_output".to_string()),
                top_k: Some(100),
                ..Default::default()
            })
            .await
            .unwrap()
            .into_iter()
            .filter(|event| {
                event
                    .payload
                    .get("tool_name")
                    .and_then(|value| value.as_str())
                    == Some("objective_supervisor")
            })
            .count();
        assert_eq!(
            continuations, 1,
            "创建时应收编当前 Evaluation，只在第一次 reply 后续跑一次"
        );
    }

    #[tokio::test]
    async fn one_activation_can_create_multiple_objectives_that_start_concurrently() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        config.orchestrator.activation_admission.max_in_flight = 8;
        let client = Arc::new(MultipleObjectiveAutonomousCreateClient {
            calls: AtomicU64::new(0),
            objective_phases: std::sync::Mutex::new(std::collections::HashMap::new()),
            both_objectives_started: tokio::sync::Barrier::new(2),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        let session = runtime
            .ensure_session(NewSession {
                id: "session-multiple-objectives".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Multiple concurrent Objectives".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 8);
        session
            .send(
                "请在本次 Activation 中创建两个需要同时推进的持久目标",
                "User-Test",
                Some("multiple-objectives-message".to_string()),
            )
            .await
            .unwrap();

        let mut delivered = std::collections::HashMap::new();
        while delivered.len() < 2 {
            let reply = match tokio::time::timeout(
                std::time::Duration::from_secs(5),
                replies.recv(),
            )
            .await
            {
                Ok(Some(reply)) => reply,
                outcome => {
                    let objectives = runtime
                        .list_context_objectives(&runtime.identity().context_id, true)
                        .await
                        .unwrap();
                    let phases = client.objective_phases.lock().unwrap().clone();
                    let events = runtime
                        .query_events(QueryFilter {
                            session_id: Some(session.id().to_string()),
                            top_k: Some(100),
                            ..Default::default()
                        })
                        .await
                        .unwrap();
                    panic!(
                        "same-Session sibling Objectives should both finish without queuing: outcome={outcome:?} calls={} phases={phases:?} objectives={objectives:?} events={events:?}",
                        client.calls.load(Ordering::SeqCst)
                    );
                }
            };
            assert_eq!(reply.payload["session_id"], session.id());
            let objective_id = reply.payload["objective_id"]
                .as_str()
                .expect("reply must retain its Objective route")
                .to_string();
            delivered.insert(
                objective_id,
                reply.payload["text"].as_str().unwrap().to_string(),
            );
        }
        assert_eq!(delivered.len(), 2);
        for (objective_id, text) in &delivered {
            assert_eq!(text, &format!("{objective_id}-complete"));
            let objective = objective_after_evaluation_release(&runtime, objective_id).await;
            assert_eq!(objective.status, ObjectiveStatus::Completed);
            assert_eq!(objective.coordinator_session_id, session.id());
        }
        assert_eq!(client.calls.load(Ordering::SeqCst), 5);
        assert!(client
            .objective_phases
            .lock()
            .unwrap()
            .values()
            .all(|phase| *phase == 2));

        let create_receipts = runtime
            .query_events(QueryFilter {
                session_id: Some(session.id().to_string()),
                topic: Some("chat/tool_output".to_string()),
                top_k: Some(100),
                ..Default::default()
            })
            .await
            .unwrap()
            .into_iter()
            .filter(|event| event.payload["tool_name"] == "objective_create")
            .filter_map(|event| event.payload["text"].as_str().map(str::to_string))
            .collect::<Vec<_>>();
        assert_eq!(create_receipts.len(), 2);
        assert!(create_receipts
            .iter()
            .any(|receipt| receipt.contains("\"activation_adoption\": \"current-activation\"")));
        assert!(create_receipts.iter().any(
            |receipt| receipt.contains("\"activation_adoption\": \"independent-continuation\"")
        ));
    }

    #[tokio::test]
    async fn objective_wait_is_event_driven_and_the_matching_task_event_resumes_it_once() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let client = Arc::new(ObjectiveWaitingClient {
            calls: AtomicU64::new(0),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        runtime
            .ensure_session(NewSession {
                id: "session-objective-wait".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Objective wait test".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let wait_thread = runtime
            .inner
            .store
            .ensure_thread(crate::memory::NewThread {
                id: "thread-objective-wait-task".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                session_id: "session-objective-wait".to_string(),
                initiating_principal_id: None,
                root_turn_id: "root-objective-wait-task".to_string(),
                kind: crate::memory::ThreadKind::Execution,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: crate::memory::ThreadSupervision::legacy(),
            })
            .await
            .unwrap();
        let wait_activation = runtime
            .inner
            .store
            .ensure_thread_activation(crate::memory::NewThreadActivation {
                id: "activation-objective-wait-task".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                session_id: "session-objective-wait".to_string(),
                initiating_principal_id: None,
                trigger_event_id: "trigger-objective-wait-task".to_string(),
                trigger_sequence: 1,
                trigger_kind: "chat/tool_output".to_string(),
                parent_activation_id: None,
                root_turn_id: wait_thread.root_turn_id.clone(),
            })
            .await
            .unwrap();
        let wait_job = runtime
            .inner
            .store
            .create_execution_job(crate::memory::NewExecutionJob {
                id: "task-wait-42".to_string(),
                activation_id: wait_activation.id,
                thread_id: wait_thread.id,
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                session_id: "session-objective-wait".to_string(),
                initiating_principal_id: None,
                target_id: crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
                tool_call_id: "call-objective-wait-task".to_string(),
                tool_name: "exec/background".to_string(),
                request: json!({"kind":"background_exec","command":"test fixture"}),
                retry_safety: crate::memory::ExecutionRetrySafety::ReconcileRequired,
                requires_approval: false,
            })
            .await
            .unwrap();
        let wait_job = match runtime
            .inner
            .store
            .claim_execution_job(
                &wait_job.id,
                wait_job.revision,
                "objective-wait-test-worker",
                "objective-wait-test-claim",
                chrono::Utc::now() + chrono::Duration::minutes(5),
                None,
            )
            .await
            .unwrap()
        {
            crate::memory::ExecutionJobMutation::Updated(job) => job,
            mutation => panic!("unexpected wait job claim: {mutation:?}"),
        };
        let mut no_reply = runtime.subscribe("chat/no_reply", 8);
        let mut replies = runtime.subscribe("chat/reply", 8);
        runtime
            .create_objective(NewObjective {
                id: "objective-wait".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                coordinator_session_id: "session-objective-wait".to_string(),
                delivery_session_id: "session-objective-wait".to_string(),
                parent_objective_id: None,
                source_event_id: "runtime-wait-source".to_string(),
                initiating_principal_id: None,
                stated_objective: "等待后台任务后完成".to_string(),
                token_budget: None,
            })
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(3), no_reply.recv())
            .await
            .unwrap()
            .unwrap();
        let mut waiting = runtime
            .get_objective("objective-wait")
            .await
            .unwrap()
            .unwrap();
        for _ in 0..50 {
            if waiting.active_evaluation_id.is_none() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            waiting = runtime
                .get_objective("objective-wait")
                .await
                .unwrap()
                .unwrap();
        }
        assert_eq!(
            waiting.wait_condition,
            Some(ObjectiveWaitCondition::ToolTask {
                task_id: "task-wait-42".to_string()
            })
        );
        assert!(waiting.active_evaluation_id.is_none());
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(client.calls.load(Ordering::SeqCst), 2);

        let terminal_event_id = "task-wait-42-completed";
        let terminal = runtime
            .inner
            .store
            .finish_execution_job(
                &wait_job.id,
                wait_job.revision,
                Some("objective-wait-test-claim"),
                crate::memory::ExecutionJobTerminal {
                    status: ExecutionJobStatus::Succeeded,
                    result_event_id: Some(terminal_event_id.to_string()),
                    result_refs: Vec::new(),
                    error: None,
                    exit_code: Some(0),
                },
            )
            .await
            .unwrap();
        assert!(matches!(
            terminal,
            crate::memory::ExecutionJobMutation::Updated(_)
        ));
        runtime
            .publish(Event::new(
                terminal_event_id.to_string(),
                "System-TaskMonitor".to_string(),
                crate::event::TYPE_TOOL_OUTPUT.to_string(),
                "chat/tool_output".to_string(),
                vec![
                    (
                        "context_id".to_string(),
                        json!(runtime.identity().context_id),
                    ),
                    ("session_id".to_string(), json!("session-objective-wait")),
                    ("task_id".to_string(), json!("task-wait-42")),
                    ("task_status".to_string(), json!("succeeded")),
                    ("tool_name".to_string(), json!("exec/background")),
                    ("text".to_string(), json!("background task succeeded")),
                ]
                .into_iter()
                .collect(),
            ))
            .await
            .unwrap();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(3), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            reply.payload.get("text").and_then(|value| value.as_str()),
            Some("wait-objective-complete")
        );
        assert_eq!(
            runtime
                .get_objective("objective-wait")
                .await
                .unwrap()
                .unwrap()
                .status,
            ObjectiveStatus::Completed
        );
        assert_eq!(client.calls.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn runtime_restart_recovers_an_expired_objective_evaluation_lease_once() {
        let database = NamedTempFile::new().unwrap();
        let database_path = database.path().to_string_lossy().into_owned();
        let store = SqliteStore::new(&database_path).await.unwrap();
        store
            .create_agent_bundle(
                NewAgent {
                    id: "default-agent".to_string(),
                    title: "Recovery Agent".to_string(),
                    root_context_id: "context-default".to_string(),
                },
                NewCognitiveContext {
                    id: "context-default".to_string(),
                    agent_id: "default-agent".to_string(),
                    title: "Recovery Context".to_string(),
                },
                NewSession {
                    id: "session-objective-recover".to_string(),
                    agent_id: "default-agent".to_string(),
                    context_id: "context-default".to_string(),
                    parent_session_id: None,
                    title: "Recovery Session".to_string(),
                    mount_kind: crate::memory::SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        store
            .create_objective(NewObjective {
                id: "objective-recover".to_string(),
                agent_id: "default-agent".to_string(),
                context_id: "context-default".to_string(),
                coordinator_session_id: "session-objective-recover".to_string(),
                delivery_session_id: "session-objective-recover".to_string(),
                parent_objective_id: None,
                source_event_id: "recovery-source".to_string(),
                initiating_principal_id: None,
                stated_objective: "验证 Runtime 重启恢复".to_string(),
                token_budget: None,
            })
            .await
            .unwrap();
        let stale = store
            .claim_objective_evaluation(
                "objective-recover",
                1,
                "evaluation-from-dead-process",
                chrono::Utc::now() - chrono::Duration::seconds(1),
            )
            .await
            .unwrap();
        assert!(matches!(stale, ObjectiveMutation::Updated(_)));
        drop(store);

        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let client = Arc::new(ObjectiveRecoveryClient {
            calls: AtomicU64::new(0),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(&database_path)
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 8);
        runtime.start().await.unwrap();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(3), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            reply.payload.get("text").and_then(|value| value.as_str()),
            Some("recovered-objective-complete")
        );
        let recovered = runtime
            .get_objective("objective-recover")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(recovered.status, ObjectiveStatus::Completed);
        assert_eq!(recovered.continuation_sequence, 2);
        assert_eq!(client.calls.load(Ordering::SeqCst), 2);
        assert!(runtime
            .query_events(QueryFilter {
                topic: Some("objective/recovered".to_string()),
                ..Default::default()
            })
            .await
            .unwrap()
            .iter()
            .any(|event| {
                event
                    .payload
                    .get("objective_id")
                    .and_then(|value| value.as_str())
                    == Some("objective-recover")
            }));
    }

    #[tokio::test]
    async fn shared_context_objectives_keep_two_session_evaluations_and_replies_isolated() {
        let database = NamedTempFile::new().unwrap();
        let database_path = database.path().to_string_lossy().into_owned();
        let store = SqliteStore::new(&database_path).await.unwrap();
        store
            .create_agent_bundle(
                NewAgent {
                    id: "default-agent".to_string(),
                    title: "Shared Objective Agent".to_string(),
                    root_context_id: "context-default".to_string(),
                },
                NewCognitiveContext {
                    id: "context-default".to_string(),
                    agent_id: "default-agent".to_string(),
                    title: "Shared Objective Context".to_string(),
                },
                NewSession {
                    id: "session-a".to_string(),
                    agent_id: "default-agent".to_string(),
                    context_id: "context-default".to_string(),
                    parent_session_id: None,
                    title: "Session A".to_string(),
                    mount_kind: crate::memory::SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        store
            .create_session(NewSession {
                id: "session-b".to_string(),
                agent_id: "default-agent".to_string(),
                context_id: "context-default".to_string(),
                parent_session_id: None,
                title: "Session B".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        for (objective_id, session_id) in
            [("objective-a", "session-a"), ("objective-b", "session-b")]
        {
            store
                .create_objective(NewObjective {
                    id: objective_id.to_string(),
                    agent_id: "default-agent".to_string(),
                    context_id: "context-default".to_string(),
                    coordinator_session_id: session_id.to_string(),
                    delivery_session_id: session_id.to_string(),
                    parent_objective_id: None,
                    source_event_id: format!("source-{objective_id}"),
                    initiating_principal_id: None,
                    stated_objective: format!("完成 {session_id} 的独立目标"),
                    token_budget: None,
                })
                .await
                .unwrap();
        }
        drop(store);

        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let client = Arc::new(SharedContextObjectiveClient {
            calls: AtomicU64::new(0),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(&database_path)
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 8);
        runtime.start().await.unwrap();
        let mut delivered = std::collections::HashMap::new();
        while delivered.len() < 2 {
            let reply = tokio::time::timeout(std::time::Duration::from_secs(3), replies.recv())
                .await
                .unwrap()
                .unwrap();
            delivered.insert(
                reply
                    .payload
                    .get("session_id")
                    .and_then(|value| value.as_str())
                    .unwrap()
                    .to_string(),
                (
                    reply
                        .payload
                        .get("objective_id")
                        .and_then(|value| value.as_str())
                        .unwrap()
                        .to_string(),
                    reply
                        .payload
                        .get("text")
                        .and_then(|value| value.as_str())
                        .unwrap()
                        .to_string(),
                ),
            );
        }
        assert_eq!(
            delivered.get("session-a"),
            Some(&("objective-a".to_string(), "session-a-complete".to_string()))
        );
        assert_eq!(
            delivered.get("session-b"),
            Some(&("objective-b".to_string(), "session-b-complete".to_string()))
        );
        for objective_id in ["objective-a", "objective-b"] {
            assert_eq!(
                runtime
                    .get_objective(objective_id)
                    .await
                    .unwrap()
                    .unwrap()
                    .status,
                ObjectiveStatus::Completed
            );
        }
        assert_eq!(client.calls.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn persisted_objective_timer_wakes_after_restart_without_polling() {
        let database = NamedTempFile::new().unwrap();
        let database_path = database.path().to_string_lossy().into_owned();
        let store = SqliteStore::new(&database_path).await.unwrap();
        store
            .create_agent_bundle(
                NewAgent {
                    id: "default-agent".to_string(),
                    title: "Timer Agent".to_string(),
                    root_context_id: "context-default".to_string(),
                },
                NewCognitiveContext {
                    id: "context-default".to_string(),
                    agent_id: "default-agent".to_string(),
                    title: "Timer Context".to_string(),
                },
                NewSession {
                    id: "session-objective-recover".to_string(),
                    agent_id: "default-agent".to_string(),
                    context_id: "context-default".to_string(),
                    parent_session_id: None,
                    title: "Timer Session".to_string(),
                    mount_kind: crate::memory::SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        store
            .create_objective(NewObjective {
                id: "objective-recover".to_string(),
                agent_id: "default-agent".to_string(),
                context_id: "context-default".to_string(),
                coordinator_session_id: "session-objective-recover".to_string(),
                delivery_session_id: "session-objective-recover".to_string(),
                parent_objective_id: None,
                source_event_id: "timer-source".to_string(),
                initiating_principal_id: None,
                stated_objective: "计时器到达后继续".to_string(),
                token_budget: None,
            })
            .await
            .unwrap();
        // Keep the pre-deadline assertion deterministic under a parallel
        // workspace test run. A 150 ms deadline could expire while the
        // Runtime was still being constructed on a busy CI host, making the
        // correctly claimed timer look like a persistence failure.
        let deadline = chrono::Utc::now() + chrono::Duration::seconds(1);
        assert!(matches!(
            store
                .update_objective_state(
                    "objective-recover",
                    1,
                    ObjectiveStatus::Active,
                    Some(ObjectiveWaitCondition::Timer { deadline }),
                    Some("等待计时器到期"),
                )
                .await
                .unwrap(),
            ObjectiveMutation::Updated(_)
        ));
        drop(store);

        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let client = Arc::new(ObjectiveRecoveryClient {
            calls: AtomicU64::new(0),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(&database_path)
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 8);
        runtime.start().await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(client.calls.load(Ordering::SeqCst), 0);
        let wait_timer = runtime
            .inner
            .store
            .get_runtime_timer("objective-wait:objective-recover")
            .await
            .unwrap()
            .expect("recoverable timer wait must be persisted before it fires");
        assert_eq!(
            wait_timer.kind,
            crate::memory::RuntimeTimerKind::ObjectiveWait
        );
        assert_eq!(
            wait_timer.status,
            crate::memory::RuntimeTimerStatus::Pending
        );
        let reply = tokio::time::timeout(std::time::Duration::from_secs(5), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            reply.payload.get("text").and_then(|value| value.as_str()),
            Some("recovered-objective-complete")
        );
        assert_eq!(client.calls.load(Ordering::SeqCst), 2);
        let objective = runtime
            .get_objective("objective-recover")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(objective.status, ObjectiveStatus::Completed);
        assert_eq!(
            runtime
                .inner
                .store
                .get_runtime_timer("objective-wait:objective-recover")
                .await
                .unwrap()
                .unwrap()
                .status,
            crate::memory::RuntimeTimerStatus::Fired
        );
        let timer_dependencies = runtime
            .inner
            .store
            .list_scheduler_dependencies(crate::scheduler::SchedulerDependencyFilter {
                owner_kind: Some(crate::scheduler::SchedulerDependencyOwnerKind::Objective),
                owner_id: Some("objective-recover".to_string()),
                dependency_kind: Some(crate::scheduler::SchedulerDependencyKind::Timer),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(timer_dependencies.len(), 1);
        assert_eq!(
            timer_dependencies[0].status,
            crate::scheduler::SchedulerDependencyStatus::Satisfied
        );
        assert!(timer_dependencies[0].satisfied_by_event_id.is_some());
    }

    #[tokio::test]
    async fn inspect_session_context_uses_persisted_mount_before_first_message() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let runtime = MorphzRuntime::builder(config, Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        runtime
            .ensure_context(NewCognitiveContext {
                id: "persisted-context".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                title: "Persisted".to_string(),
            })
            .await
            .unwrap();
        runtime
            .ensure_session(NewSession {
                id: "persisted-session".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: "persisted-context".to_string(),
                parent_session_id: None,
                title: "Persisted".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();

        let view = runtime
            .inspect_session_context_view("persisted-session")
            .await
            .unwrap();
        assert_eq!(view.context_id, "persisted-context");
        assert!(runtime
            .inspect_session_context_view("unknown-session")
            .await
            .unwrap_err()
            .to_string()
            .contains("不存在"));
    }

    #[tokio::test]
    async fn cancelling_delegation_recursively_cancels_descendants() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let runtime = MorphzRuntime::builder(config, Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        for context_id in ["cancel-child-context", "cancel-grand-context"] {
            runtime
                .create_context(NewCognitiveContext {
                    id: context_id.to_string(),
                    agent_id: runtime.identity().agent_id.clone(),
                    title: context_id.to_string(),
                })
                .await
                .unwrap();
        }
        for (session_id, context_id) in [
            ("cancel-root", runtime.identity().context_id.as_str()),
            ("cancel-child", "cancel-child-context"),
            ("cancel-grand", "cancel-grand-context"),
        ] {
            runtime
                .ensure_session(NewSession {
                    id: session_id.to_string(),
                    agent_id: runtime.identity().agent_id.clone(),
                    context_id: context_id.to_string(),
                    parent_session_id: None,
                    title: session_id.to_string(),
                    mount_kind: crate::memory::SessionMountKind::ExistingContext,
                })
                .await
                .unwrap();
        }
        for delegation in [
            NewDelegation {
                id: "cancel-delegation-root".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                parent_context_id: runtime.identity().context_id.clone(),
                parent_session_id: "cancel-root".to_string(),
                child_context_id: "cancel-child-context".to_string(),
                child_session_id: "cancel-child".to_string(),
                initiating_principal_id: None,
                task: "child".to_string(),
                success_when: None,
                context_scope: "mind_only".to_string(),
            },
            NewDelegation {
                id: "cancel-delegation-child".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                parent_context_id: "cancel-child-context".to_string(),
                parent_session_id: "cancel-child".to_string(),
                child_context_id: "cancel-grand-context".to_string(),
                child_session_id: "cancel-grand".to_string(),
                initiating_principal_id: None,
                task: "grand".to_string(),
                success_when: None,
                context_scope: "mind_only".to_string(),
            },
        ] {
            let id = delegation.id.clone();
            runtime.create_delegation(delegation).await.unwrap();
            runtime
                .update_delegation_status(&id, DelegationStatus::Running, None)
                .await
                .unwrap();
        }

        let cancelled = runtime
            .cancel_delegation_tree("cancel-delegation-root")
            .await
            .unwrap();
        assert_eq!(cancelled.len(), 2);
        for id in ["cancel-delegation-root", "cancel-delegation-child"] {
            assert_eq!(
                runtime.get_delegation(id).await.unwrap().unwrap().status,
                DelegationStatus::Cancelled
            );
        }
    }

    #[tokio::test]
    async fn slow_runtime_subscriber_drops_only_model_drafts_and_preserves_durable_correction() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let runtime = MorphzRuntime::builder(config, Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        let mut events = runtime.subscribe("*", 1);

        let draft = |id: &str, text: &str| {
            Event::new(
                id.to_string(),
                "Model-Provider".to_string(),
                "runtime_ephemeral".to_string(),
                "runtime/model_stream".to_string(),
                vec![(
                    "stream".to_string(),
                    json!({"kind":"text_delta","text":text}),
                )]
                .into_iter()
                .collect(),
            )
        };
        runtime
            .inner
            .bus
            .publish_ephemeral(draft("draft-1", "first"))
            .await
            .unwrap();

        // Capacity is already exhausted. The next transient chunk must be
        // dropped immediately instead of making the synchronous wildcard
        // EventBus handler wait for this deliberately stalled observer.
        tokio::time::timeout(
            std::time::Duration::from_millis(100),
            runtime
                .inner
                .bus
                .publish_ephemeral(draft("draft-2", "second")),
        )
        .await
        .expect("a full draft queue must not backpressure the provider stream")
        .unwrap();

        // Durable facts keep their reliable await semantics. Once the stalled
        // observer consumes the old draft, the complete committed reply is
        // delivered and becomes the authoritative UI correction.
        let publish_runtime = runtime.clone();
        let durable = tokio::spawn(async move {
            publish_runtime
                .publish(Event::new(
                    "durable-reply".to_string(),
                    "Agent-Morphz".to_string(),
                    "agent_call".to_string(),
                    "chat/reply".to_string(),
                    vec![("text".to_string(), json!("firstsecond"))]
                        .into_iter()
                        .collect(),
                ))
                .await
        });
        tokio::task::yield_now().await;
        assert!(!durable.is_finished());
        assert_eq!(events.recv().await.unwrap().id, "draft-1");
        durable.await.unwrap().unwrap();
        let correction = events.recv().await.unwrap();
        assert_eq!(correction.id, "durable-reply");
        assert_eq!(correction.topic, "chat/reply");
        assert_eq!(
            correction
                .payload
                .get("text")
                .and_then(serde_json::Value::as_str),
            Some("firstsecond")
        );
        assert!(events.try_recv().is_err());
    }

    #[tokio::test]
    async fn artifact_transfer_runtime_moves_local_bytes_and_is_idempotent() {
        let root = tempfile::tempdir().unwrap();
        let database_path = root.path().join("morphz.db");
        let source_path = root.path().join("source.bin");
        let destination_path = root.path().join("nested/destination.bin");
        let source_bytes = b"morphz-artifact-transfer\0binary\n";
        tokio::fs::write(&source_path, source_bytes).await.unwrap();

        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::FullAccess;
        config.permissions.workspace_root = root.path().to_string_lossy().into_owned();
        let runtime = MorphzRuntime::builder(config, Arc::new(ReplyClient))
            .database_path(database_path.to_string_lossy())
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        let session = runtime
            .create_session(NewSession {
                id: "session-artifact-transfer".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Artifact transfer".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let request = ArtifactTransferRequest {
            transfer_id: "transfer-local-idempotent".to_string(),
            source: crate::artifact::ArtifactLocation {
                target_id: crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
                workspace_identity: None,
                path: source_path.to_string_lossy().into_owned(),
            },
            destination: crate::artifact::ArtifactLocation {
                target_id: crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
                workspace_identity: None,
                path: destination_path.to_string_lossy().into_owned(),
            },
            overwrite: crate::artifact::ArtifactOverwritePolicy::Deny,
            expected_source_digest: None,
            media_type: Some("application/octet-stream".to_string()),
            origin: Some(crate::artifact::ArtifactOrigin {
                kind: crate::artifact::ArtifactOriginKind::User,
                principal_id: Some(runtime.identity().principal_id.clone()),
                session_id: Some(session.id.clone()),
                producer: Some("runtime-test".to_string()),
            }),
        };

        let first = runtime
            .submit_artifact_transfer(
                &runtime.identity().principal_id,
                &session.id,
                request.clone(),
            )
            .await
            .unwrap();
        let terminal = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let job = runtime
                    .get_execution_job(&first.job.id)
                    .await
                    .unwrap()
                    .unwrap();
                if job.status.is_terminal() {
                    break job;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("local Artifact Transfer should reach a durable terminal state");
        assert_eq!(
            terminal.status,
            ExecutionJobStatus::Succeeded,
            "unexpected terminal Artifact Transfer Job: {terminal:#?}"
        );
        assert!(
            terminal.side_effect_started_at.is_some(),
            "the destination must not become visible before the durable publication boundary"
        );
        assert_eq!(
            tokio::fs::read(&destination_path).await.unwrap(),
            source_bytes
        );

        let output_event_id = format!("output_{}", first.job.id);
        let output = runtime
            .query_events(QueryFilter {
                event_id: Some(output_event_id),
                top_k: Some(2),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(output.len(), 1);
        assert_eq!(
            output[0].payload.get("tool_status").and_then(Value::as_str),
            Some("success")
        );
        let progress = runtime
            .query_events(QueryFilter {
                context_id: Some(runtime.identity().context_id.clone()),
                session_id: Some(session.id.clone()),
                topic: Some(ARTIFACT_TRANSFER_PROGRESS_TOPIC.to_string()),
                latest_k: Some(10),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(
            progress.iter().any(|event| {
                event.payload.get("job_id").and_then(Value::as_str) == Some(first.job.id.as_str())
                    && event
                        .payload
                        .get("progress")
                        .and_then(|value| value.get("bytes_transferred"))
                        .and_then(Value::as_u64)
                        == Some(source_bytes.len() as u64)
            }),
            "even a short transfer must persist its final progress snapshot"
        );

        let replay = runtime
            .submit_artifact_transfer(&runtime.identity().principal_id, &session.id, request)
            .await
            .unwrap();
        assert_eq!(replay.job.id, first.job.id);
        assert_eq!(replay.thread.id, first.thread.id);
        assert_eq!(replay.activation.id, first.activation.id);
        assert_eq!(replay.request_event_sequence, first.request_event_sequence);
    }

    #[tokio::test]
    async fn artifact_transfer_cancellation_drops_physical_work_and_closes_durable_lineage() {
        let root = tempfile::tempdir().unwrap();
        let database_path = root.path().join("morphz.db");
        let source_path = root.path().join("source.bin");
        let destination_path = root.path().join("destination.bin");
        tokio::fs::write(&source_path, b"cancel-me").await.unwrap();

        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::FullAccess;
        config.permissions.workspace_root = root.path().to_string_lossy().into_owned();
        let runtime = MorphzRuntime::builder(config, Arc::new(ReplyClient))
            .database_path(database_path.to_string_lossy())
            .build()
            .await
            .unwrap();
        let entered = Arc::new(tokio::sync::Notify::new());
        let dropped = Arc::new(AtomicBool::new(false));
        runtime
            .inner
            .execution_targets
            .register_artifact_transfer_backend(Arc::new(BlockingArtifactTransferBackend {
                entered: entered.clone(),
                dropped: dropped.clone(),
            }));
        runtime.start().await.unwrap();
        let session = runtime
            .create_session(NewSession {
                id: "session-artifact-cancel".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Artifact cancellation".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let submitted = runtime
            .submit_artifact_transfer(
                &runtime.identity().principal_id,
                &session.id,
                ArtifactTransferRequest {
                    transfer_id: "transfer-cancel-before-publication".to_string(),
                    source: crate::artifact::ArtifactLocation {
                        target_id: crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
                        workspace_identity: None,
                        path: source_path.to_string_lossy().into_owned(),
                    },
                    destination: crate::artifact::ArtifactLocation {
                        target_id: crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
                        workspace_identity: None,
                        path: destination_path.to_string_lossy().into_owned(),
                    },
                    overwrite: crate::artifact::ArtifactOverwritePolicy::Deny,
                    expected_source_digest: None,
                    media_type: Some("application/octet-stream".to_string()),
                    origin: None,
                },
            )
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(3), entered.notified())
            .await
            .expect("custom Artifact backend should start");
        let running = runtime
            .get_execution_job(&submitted.job.id)
            .await
            .unwrap()
            .unwrap();
        runtime
            .request_execution_job_cancel(&running.id, running.revision, Some("test cancellation"))
            .await
            .unwrap();
        let terminal = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let current = runtime
                    .get_execution_job(&running.id)
                    .await
                    .unwrap()
                    .unwrap();
                if current.status.is_terminal() {
                    break current;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("cancelled Artifact Transfer should durably close");
        assert_eq!(terminal.status, ExecutionJobStatus::Cancelled);
        assert!(terminal.cancel_requested_at.is_some());
        assert!(terminal.side_effect_started_at.is_none());
        assert!(dropped.load(Ordering::SeqCst));
        assert!(!tokio::fs::try_exists(&destination_path).await.unwrap());

        let (activation, thread) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let activation = runtime
                    .inner
                    .store
                    .get_thread_activation(&submitted.activation.id)
                    .await
                    .unwrap()
                    .unwrap();
                let thread = runtime
                    .inner
                    .store
                    .get_thread(&submitted.thread.id)
                    .await
                    .unwrap()
                    .unwrap();
                if activation.status == ThreadActivationStatus::Cancelled
                    && thread.lifecycle == ThreadLifecycle::Cancelled
                {
                    break (activation, thread);
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("cancelled Artifact Transfer should close its scheduler lineage");
        assert_eq!(activation.status, ThreadActivationStatus::Cancelled);
        assert_eq!(thread.lifecycle, ThreadLifecycle::Cancelled);
        let event = runtime
            .query_events(QueryFilter {
                event_id: terminal.result_event_id.clone(),
                top_k: Some(2),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(event.len(), 1);
        assert_eq!(event[0].topic, ARTIFACT_TRANSFER_CANCELLED_TOPIC);
        assert_eq!(event[0].payload["tool_status"], "cancelled");
    }
}
