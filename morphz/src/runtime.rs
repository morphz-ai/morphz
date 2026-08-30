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
use crate::config::{AppConfig, AuthAccountConfig, StorageBackend};
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
use crate::llm::{
    Client, ModelAttemptBinding, ModelRouteDiagnostic, ModelUsage, ProviderAccountDiagnostic,
    ReasoningEffort,
};
use crate::memory::postgres::PostgresStore;
use crate::memory::sqlite::SqliteStore;
use crate::memory::{
    AgentBootstrapRecord, AgentRecord, ApprovalFilter, ApprovalMutation, ApprovalResolution,
    ApprovalStore, ArtifactTransferExecutionRecord, AttentionAcknowledgementRecord,
    CapabilityLeaseFilter, CapabilityLeaseMutation, CapabilityLeaseRecord, CognitiveContextRecord,
    ContextCapabilityBindingMutation, ContextCapabilityBindingRecord, ContextTokenBudgetMutation,
    ContextUpdate, DelegationFilter, DelegationRecord, DelegationStatus, DialogueTurnRetryMutation,
    DialogueTurnRetryRequest, EdgeCommandMutation, EdgeCommandOutputChunk, EdgeCommandRecord,
    EdgeCommandStatus, EdgeOutputStream, EventStore, ExecutionApprovalStore, ExecutionJobFilter,
    ExecutionJobMonitorRecord, ExecutionJobRecord, ExecutionJobStatus, ExecutionJobStore,
    ExecutionNodeMutation, ExecutionNodeRecord, ExecutionTargetAuthorizationFilter,
    ExecutionTargetAuthorizationMutation, ExecutionTargetAuthorizationRecord,
    ExecutionTargetFilter, ExecutionTargetMutation, ExecutionTargetRecord,
    ExecutionTargetRegistration, ExecutionTargetStatus, ExecutionTargetStore, MessageClaim,
    MessageDispatchMode, MindProjectionHead, MindProjectionStore, NewAgent,
    NewArtifactTransferExecution, NewCognitiveContext, NewDelegation, NewExecutionNodeChallenge,
    NewExecutionTargetAuthorization, NewNodePairingCode, NewObjective, NewPrincipal, NewSession,
    NewThread, NewThreadActivation, ObjectiveMutation, ObjectiveRecord, ObjectiveStatus,
    ObjectiveStore, ObjectiveWaitCondition, PairExecutionNode, PrincipalDirectoryPage, QueryFilter,
    RecallDocumentKind, RecallProjectionStore, RuntimeStore, ScheduleMutation, ScheduleRecord,
    SessionContextSharing, SessionPrincipalBinding, SessionRecord, SessionStatus, SessionStore,
    SessionUpdate, ThreadActivationRecord, ThreadActivationStatus, ThreadControlAction,
    ThreadControlState, ThreadGroupFilter, ThreadGroupMemberRecord, ThreadKind, ThreadLifecycle,
    ThreadMutation, ThreadOutcomeRecord, ThreadPhase, ThreadRecord, ThreadSignalRecord,
    ThreadSignalStatus, ThreadSupervision, ThreadSupervisorKind, TimerStore,
    TransientStorageRetention,
};
use crate::objective::{
    ObjectiveAmendTool, ObjectiveCreateTool, ObjectiveEvaluationRegistry, ObjectiveSupervisor,
    ObjectiveUpdateTool, MODEL_CONFIGURATION_RESOURCE, TYPE_MODEL_CONFIGURATION_CHANGED,
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
use crate::provider::auth::{
    OAuthAccountMetadata, OAuthLoginChallenge, OAuthLoginCompletion, OAuthLoginProgress,
    ProviderSubscriptionUsage,
};
use crate::provider::control::{
    ProviderAccountControlAction, ProviderAccountControlRecord, ProviderControlSnapshot,
};
use crate::provider::routing::EffectiveProviderCatalog;
use crate::provider::{
    build_configured_client, normalize_reasoning_effort_for_model,
    supported_reasoning_efforts_for_model,
};
use crate::scheduler::{
    audit_scheduler_invariants, derive_objective_readiness, KernelResult,
    SchedulerDependencyFilter, SchedulerDependencyKind, SchedulerDependencyOwnerKind,
    SchedulerDependencyStatus, SchedulerInvariantCode, SchedulerInvariantInput,
    SchedulerInvariantSeverity, SchedulerInvariantViolation, SchedulerKernel,
};
pub use crate::scheduler::{
    SchedulerActivationSnapshot, SchedulerAdmissionSnapshot, SchedulerDeliverySnapshot,
    SchedulerDetailBounds, SchedulerExternalOutboxSnapshot, SchedulerJobSnapshot,
    SchedulerObjectiveSnapshot, SchedulerQuery, SchedulerResultSnapshot, SchedulerSnapshot,
    SchedulerSummary, SchedulerThreadGroupSnapshot, SchedulerThreadSnapshot,
};
use crate::secret_store::{
    ManagedSecret, SecretBackendStatus, SecretImportCandidate, SecretScopeKind, SecretStore,
    SecretUseAuditRecord,
};
use crate::timer::TimerEngine;
use crate::tool::{
    BackgroundTaskScheduler, CheckTaskAfterTool, DelegateTool, EditFileTool, ExecuteCommandTool,
    KillTaskTool, ListFilesTool, ListSecretsTool, ListSkillsTool, ListTasksTool, PrincipalTool,
    ReadFileTool, Registry, ScheduleTxTool, SearchTool, SendMessageTool, SessionSignalTool,
    TaskStatusTool, ThreadScheduler, Tool, WriteFileTool,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock, Weak};

pub type RuntimeError = Box<dyn std::error::Error + Send + Sync>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ContextTokenBudgetUpdate {
    Updated(ContextTokenBudget),
    Conflict(ContextTokenBudget),
    NotFound,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ContextCapabilityBindingUpdate {
    Updated(ContextCapabilityBindingRecord),
    Conflict(ContextCapabilityBindingRecord),
    NotFound,
}

fn resolve_model_context_capacity(config: &AppConfig, model: &str) -> ModelContextCapacity {
    let legacy_provider_id = config.llm.provider.clone();
    let legacy_profile = legacy_provider_id
        .as_deref()
        .and_then(|provider_id| config.providers.get(provider_id))
        .and_then(|provider| provider.models.get(model));
    let routed = EffectiveProviderCatalog::from_config(config)
        .ok()
        .and_then(|catalog| {
            let (_, route) = catalog.resolve_route(model).ok()?;
            let candidates = route
                .candidates
                .iter()
                .filter_map(|candidate| {
                    catalog
                        .provider_instances
                        .get(&candidate.provider)
                        .map(|provider| {
                            (
                                candidate.provider.clone(),
                                provider.models.get(&candidate.model).cloned(),
                            )
                        })
                })
                .collect::<Vec<_>>();
            (!candidates.is_empty()).then_some(candidates)
        });
    let fallback = config.orchestrator.context_hard_token_limit.max(1);
    let (provider_id, prompt_token_limit, context_window_tokens, max_output_tokens, source) =
        if let Some(candidates) = routed {
            let provider_id = candidates
                .iter()
                .map(|(provider_id, _)| provider_id)
                .all(|provider_id| provider_id == &candidates[0].0)
                .then(|| candidates[0].0.clone());
            let prompt_token_limit = candidates
                .iter()
                .map(|(_, profile)| {
                    profile
                        .as_ref()
                        .and_then(crate::config::ProviderModelConfig::prompt_token_limit)
                        .unwrap_or(fallback)
                })
                .min()
                .unwrap_or(fallback)
                .max(1);
            let all_context_windows = candidates
                .iter()
                .map(|(_, profile)| {
                    profile
                        .as_ref()
                        .and_then(|profile| profile.context_window_tokens)
                })
                .collect::<Option<Vec<_>>>();
            let all_output_limits = candidates
                .iter()
                .map(|(_, profile)| {
                    profile
                        .as_ref()
                        .and_then(|profile| profile.max_output_tokens)
                        .or(config.llm.max_output_tokens.map(|value| value as usize))
                })
                .collect::<Option<Vec<_>>>();
            let configured = candidates.iter().any(|(_, profile)| {
                profile
                    .as_ref()
                    .and_then(crate::config::ProviderModelConfig::prompt_token_limit)
                    .is_some()
            });
            (
                provider_id,
                prompt_token_limit,
                all_context_windows.and_then(|values| values.into_iter().min()),
                all_output_limits.and_then(|values| values.into_iter().min()),
                if configured {
                    "provider-route-model-config"
                } else {
                    "runtime-default"
                },
            )
        } else {
            let configured_prompt_token_limit =
                legacy_profile.and_then(crate::config::ProviderModelConfig::prompt_token_limit);
            (
                legacy_provider_id,
                configured_prompt_token_limit.unwrap_or(fallback).max(1),
                legacy_profile.and_then(|profile| profile.context_window_tokens),
                legacy_profile
                    .and_then(|profile| profile.max_output_tokens)
                    .or(config.llm.max_output_tokens.map(|value| value as usize)),
                if configured_prompt_token_limit.is_some() {
                    "provider-model-config"
                } else {
                    "runtime-default"
                },
            )
        };
    ModelContextCapacity {
        provider: provider_id,
        model: model.to_string(),
        prompt_token_limit,
        context_window_tokens,
        max_output_tokens,
        source: source.to_string(),
    }
}

fn resolve_model_context_capacities(config: &AppConfig) -> HashMap<String, ModelContextCapacity> {
    let mut models = config.llm.models.clone();
    models.push(config.llm.model.clone());
    models.extend(config.model_routes.keys().cloned());
    models.sort();
    models.dedup();
    models
        .into_iter()
        .filter(|model| !model.trim().is_empty())
        .map(|model| {
            let capacity = resolve_model_context_capacity(config, &model);
            (model, capacity)
        })
        .collect()
}

static RUNTIME_ID_COUNTER: AtomicU64 = AtomicU64::new(0);
const RUNTIME_DEFAULT_IDENTITY_PROVIDER_ID: &str = "runtime-default";
const ARTIFACT_TRANSFER_EXECUTOR_KIND: &str = "artifact_transfer";
const ARTIFACT_TRANSFER_REQUEST_TOPIC: &str = "runtime/artifact_transfer_requested";
const ARTIFACT_TRANSFER_PROGRESS_TOPIC: &str = "runtime/artifact_transfer_progress";
const ARTIFACT_TRANSFER_COMPLETED_TOPIC: &str = "runtime/artifact_transfer_completed";
const ARTIFACT_TRANSFER_FAILED_TOPIC: &str = "runtime/artifact_transfer_failed";
const ARTIFACT_TRANSFER_CANCELLED_TOPIC: &str = "runtime/artifact_transfer_cancelled";
const ARTIFACT_TRANSFER_WORKER_LEASE_SECS: i64 = 300;
/// Scheduler board history is a bounded projection. Exact, unbounded history
/// remains available through `thread_detail` when an operator opens a Thread.
const SCHEDULER_TERMINAL_ACTIVATIONS_PER_THREAD: usize = 32;

async fn prepare_message_attachments(
    configured_root: &str,
    model_input: &crate::config::ModelInputConfig,
    session_id: &str,
    event_id: &str,
    attachments: Vec<crate::sdk::MessageAttachmentInput>,
) -> Result<crate::model_input::PreparedMessageAttachments, RuntimeError> {
    crate::model_input::prepare_message_input_attachments(
        configured_root,
        session_id,
        event_id,
        attachments,
        model_input.import_limits(),
    )
    .await
}

async fn discard_message_attachments(
    prepared: crate::model_input::PreparedMessageAttachments,
    event_id: &str,
) {
    if let Err(error) = prepared.discard().await {
        // The pending manifest intentionally remains authoritative when a
        // best-effort discard fails; startup recovery will retry it.
        tracing::warn!(
            event_id,
            error = %error,
            event_code = "runtime.message_attachment_discard_failed",
            "Failed to discard message attachments; startup recovery will retry"
        );
    }
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
pub struct AttentionAcknowledgementsPage {
    pub acknowledgements: Vec<AttentionAcknowledgement>,
    pub latest_sequence: u64,
    pub has_more: bool,
}

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
        model_binding: payload
            .get("model_binding")
            .and_then(|value| serde_json::from_value(value.clone()).ok()),
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
/// than the unbounded Event History or the full Context Encoding S-expression.
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
    /// Optional operator drill-down. When present, the Runtime projects only
    /// this Context so the Dashboard can expand its Session cards without
    /// increasing the global command-board fan-out.
    pub context_id: Option<String>,
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
    pub revision: u64,
    pub generation: u64,
    pub kind: ThreadKind,
    pub lifecycle: ThreadLifecycle,
    pub phase: ThreadPhase,
    pub state: RuntimeSessionState,
    pub control_state: ThreadControlState,
    pub supervision: ThreadSupervision,
    pub objective_id: Option<String>,
    pub target_id: Option<String>,
    pub activations: Vec<RuntimeOverviewActivation>,
    pub execution_jobs: Vec<RuntimeOverviewExecutionJob>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeOverviewActivation {
    pub id: String,
    pub status: ThreadActivationStatus,
    pub trigger_kind: String,
    pub parent_activation_id: Option<String>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeOverviewExecutionJob {
    pub id: String,
    pub activation_id: String,
    pub thread_id: String,
    pub status: ExecutionJobStatus,
    pub tool_name: String,
    pub target_id: String,
    pub progress_ref: Option<String>,
    pub error: Option<String>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_generation: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_due_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeOverviewObjective {
    pub id: String,
    pub coordinator_session_id: String,
    pub delivery_session_id: String,
    pub stated_objective: String,
    pub status: ObjectiveStatus,
    pub state: RuntimeSessionState,
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
    pub active_execution_job_count: usize,
    pub objectives: Vec<RuntimeOverviewObjective>,
    pub threads: Vec<RuntimeOverviewThread>,
    /// Every active physical Job in the Session, including asynchronous Jobs
    /// whose causal Thread has already reached a terminal state.
    pub execution_jobs: Vec<RuntimeOverviewExecutionJob>,
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
    pub active_execution_job_count: usize,
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
    pub active_execution_jobs: usize,
    pub waiting: usize,
    pub queued: usize,
    pub paused: usize,
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
    /// A caller which requests the complete Scheduler aggregate in parallel
    /// can omit this duplicate projection. `None` preserves the authoritative
    /// summary for SDK compatibility.
    pub include_scheduler_summary: Option<bool>,
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
    /// Immutable physical routing identity captured before the Provider
    /// request started. Legacy usage events may not contain this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_binding: Option<ModelAttemptBinding>,
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

/// Transport-neutral Event History query. Payload identity/causal filters are kept in
/// this public contract even while a backend may satisfy them through a
/// bounded post-filter; the response makes that scan boundary explicit.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct EventHistoryQuery {
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
pub struct EventHistoryPage {
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
    /// Dashboard-facing choices. `id` is the stable route value submitted
    /// back to Runtime; `label` and `physical_models` contain only actual
    /// enabled physical models, never an operator alias presented as a model.
    #[serde(default)]
    pub model_options: Vec<InferenceModelOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_catalog_error: Option<String>,
    pub provider: Option<String>,
    pub reasoning_effort: Option<String>,
    pub tool_count: usize,
    pub storage: String,
    pub storage_backend: crate::config::StorageBackend,
    pub permission_mode: crate::permission::PermissionMode,
    pub sandbox_mode: SandboxMode,
    pub reviewer: ReviewerKind,
    /// Authoritative host import/request policy used by every ingress and tool
    /// backend. Dashboard consumes this instead of carrying its own constants.
    pub model_input: crate::config::ModelInputConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InferenceModelOption {
    pub id: String,
    pub label: String,
    pub physical_models: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    /// Exact native levels accepted by every currently eligible physical
    /// candidate. `None` means the adapter has not declared an exact
    /// vocabulary; an empty list means the model exposes no effort dial.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supported_reasoning_efforts: Option<Vec<String>>,
    /// `configured` means the physical model was explicitly enabled in the
    /// managed Provider catalog. `manual` is a direct operator-supplied LLM
    /// model that does not resolve through a managed Model Route.
    pub source: String,
}

fn common_supported_reasoning_efforts(
    capabilities: &[Option<&'static [ReasoningEffort]>],
) -> Option<Vec<String>> {
    if capabilities.is_empty() || capabilities.iter().any(Option::is_none) {
        return None;
    }
    let canonical = [
        ReasoningEffort::Off,
        ReasoningEffort::Low,
        ReasoningEffort::Medium,
        ReasoningEffort::High,
        ReasoningEffort::Max,
    ];
    Some(
        canonical
            .into_iter()
            .filter(|effort| {
                capabilities
                    .iter()
                    .all(|supported| supported.is_some_and(|levels| levels.contains(effort)))
            })
            .map(|effort| effort.as_str().to_string())
            .collect(),
    )
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
    reviewer_client: Option<Arc<dyn Client>>,
    identity_provider: Option<Arc<dyn IdentityProvider>>,
    principal_first_seen_cues: bool,
    secret_store: Option<Arc<SecretStore>>,
    provider_auth_registry: Option<crate::provider::auth::AuthAdapterRegistry>,
    execution_target_backends: Vec<Arc<dyn crate::execution_target::ExecutionTargetBackend>>,
    harness_packages: Vec<HarnessPackage>,
    extra_tools: Vec<Arc<dyn Tool>>,
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
            reviewer_client: None,
            identity_provider: None,
            principal_first_seen_cues: false,
            secret_store: None,
            provider_auth_registry: None,
            execution_target_backends: Vec::new(),
            harness_packages: Vec::new(),
            extra_tools: Vec::new(),
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

    /// Injects the model client used exclusively by the built-in automatic
    /// permission reviewer. Normal hosts use
    /// `permissions.auto_review_model`; this hook is for embedded runtimes and
    /// deterministic tests.
    pub fn reviewer_client(mut self, client: Arc<dyn Client>) -> Self {
        self.reviewer_client = Some(client);
        self
    }

    pub fn identity_provider(mut self, provider: Arc<dyn IdentityProvider>) -> Self {
        self.identity_provider = Some(provider);
        self
    }

    /// Presents a durable first-interaction cue on the first authenticated
    /// message from each Principal in a Cognitive Context. Trusted Gateway
    /// hosts enable this by default; embedded SDK hosts may opt in explicitly.
    pub fn principal_first_seen_cues(mut self, enabled: bool) -> Self {
        self.principal_first_seen_cues = enabled;
        self
    }

    /// Injects a secret authority. Public services and Edge hosts can provide
    /// Vault/KMS/target-local backends without changing the tool or HTTP API.
    pub fn secret_store(mut self, secret_store: Arc<SecretStore>) -> Self {
        self.secret_store = Some(secret_store);
        self
    }

    /// Replaces the built-in OAuth adapter catalog. This is primarily useful
    /// for embedding hosts and deterministic integration tests; normal CLI and
    /// Dashboard builds keep the Runtime's built-in adapters.
    pub fn provider_auth_registry(
        mut self,
        registry: crate::provider::auth::AuthAdapterRegistry,
    ) -> Self {
        self.provider_auth_registry = Some(registry);
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

    /// Registers an embedding-host tool before the local Execution Target is
    /// materialized. This keeps benchmark/domain adapters on the ordinary
    /// durable Tool -> ExecutionJob path without adding them to Morphz's
    /// built-in product tool catalog.
    pub fn extra_tool(mut self, tool: Arc<dyn Tool>) -> Self {
        self.extra_tools.push(tool);
        self
    }

    #[allow(unused_mut)] // Cognitive Coordination rewrites the Mesh participant route when compiled.
    pub async fn build(mut self) -> Result<MorphzRuntime, RuntimeError> {
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
                        return Err("storage.postgres.url_env must not be empty".into());
                    }
                    let database_url = std::env::var(url_env).map_err(|_| {
                        format!(
                            "PostgreSQL Storage was selected, but environment variable '{url_env}' does not exist or is not valid Unicode"
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
        if self.config.storage.retention.enabled {
            let now = chrono::Utc::now();
            let outbox_age = i64::try_from(
                self.config
                    .storage
                    .retention
                    .resolved_signal_outbox_age
                    .as_secs(),
            )?;
            let edge_credential_age = i64::try_from(
                self.config
                    .storage
                    .retention
                    .expired_edge_credential_age
                    .as_secs(),
            )?;
            let policy = TransientStorageRetention {
                resolved_signal_outbox_before: now - chrono::Duration::seconds(outbox_age),
                expired_edge_credentials_before: now
                    - chrono::Duration::seconds(edge_credential_age),
                batch_limit: self.config.storage.retention.startup_batch_limit,
            };
            match store.prune_transient_storage(policy).await {
                Ok(report) => tracing::debug!(
                    resolved_signal_outbox_deleted = report.resolved_signal_outbox_deleted,
                    expired_pairing_codes_deleted = report.expired_pairing_codes_deleted,
                    expired_challenges_deleted = report.expired_challenges_deleted,
                    event_code = "runtime.storage.transient_retention_completed",
                    "Bounded transient storage retention completed"
                ),
                Err(error) => tracing::warn!(
                    error = %error,
                    event_code = "runtime.storage.transient_retention_failed",
                    "Transient storage retention failed; durable Runtime startup will continue"
                ),
            }
        }
        #[cfg(feature = "experimental-cognitive-coordination")]
        if self
            .config
            .experimental
            .enabled
            .contains(crate::experimental::COGNITIVE_COORDINATION)
            && self
                .config
                .experimental
                .cognitive_coordination
                .mesh
                .is_some()
        {
            let participant = self
                .config
                .experimental
                .cognitive_coordination
                .participant
                .get_or_insert_with(crate::config::CognitiveCoordinationParticipantConfig::default);
            participant.agent_id = self.identity.agent_id.clone();
            participant.context_id = self.identity.context_id.clone();
            participant.session_id.clear();
        }
        self.client.attach_provider_account_state_store(
            Arc::clone(&store) as Arc<dyn crate::memory::ProviderAccountStateStore>
        );
        let provider_auth_manager = match self.provider_auth_registry {
            Some(registry) => crate::provider::auth::ProviderAuthManager::new_with_registry(
                self.config.auth_accounts.clone(),
                Arc::clone(&secret_store),
                Arc::clone(&store) as Arc<dyn crate::memory::ProviderAccountStateStore>,
                registry,
            ),
            None => crate::provider::auth::ProviderAuthManager::new(
                self.config.auth_accounts.clone(),
                Arc::clone(&secret_store),
                Arc::clone(&store) as Arc<dyn crate::memory::ProviderAccountStateStore>,
            ),
        };
        let provider_auth_manager = Arc::new(provider_auth_manager);
        self.client
            .attach_provider_auth_manager(Arc::clone(&provider_auth_manager));
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
        let model_context_capacities =
            Arc::new(RwLock::new(resolve_model_context_capacities(&self.config)));
        let provider_catalog_config = self.config.clone();
        let model_prompt_token_limit_overrides = RwLock::new(HashMap::new());
        let context_engine = Arc::new(
            ContextEngine::new(
                Arc::clone(&store) as Arc<dyn EventStore>,
                self.config.orchestrator.clone(),
            )
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>)
            .with_capability_binding_store(
                Arc::clone(&store) as Arc<dyn crate::memory::ContextCapabilityBindingStore>
            )
            .with_work_assignment_store(
                Arc::clone(&store) as Arc<dyn crate::memory::WorkAssignmentStore>
            )
            .with_principal_first_seen_cues(self.principal_first_seen_cues)
            .with_model_context_capacity(Arc::clone(&model_context_capacity))
            .with_model_context_capacities(Arc::clone(&model_context_capacities))
            .with_evaluation_model_policy(
                self.config.llm.model.clone(),
                self.config.llm.allowed_evaluation_models.clone(),
            )
            .with_mind_projection_store(Arc::clone(&store) as Arc<dyn MindProjectionStore>)
            .with_session_projection_store(
                Arc::clone(&store) as Arc<dyn crate::memory::SessionProjectionStore>
            )
            .with_recall_projection_store(Arc::clone(&store) as Arc<dyn RecallProjectionStore>)
            .with_cognitive_clock_store(
                Arc::clone(&store) as Arc<dyn crate::memory::CognitiveClockStore>
            )
            .with_objective_store(Arc::clone(&store) as Arc<dyn ObjectiveStore>)
            .with_execution_job_store(
                Arc::clone(&store) as Arc<dyn crate::memory::ExecutionJobStore>
            )
            .with_execution_target_store(
                Arc::clone(&store) as Arc<dyn crate::memory::ExecutionTargetStore>
            )
            .with_execution_target_authorization_store(
                Arc::clone(&store) as Arc<dyn crate::memory::ExecutionTargetAuthorizationStore>
            )
            .with_worker_coordination_mode(store.worker_coordination_mode()),
        );
        let human_approval_hub = HumanApprovalHub::default();
        let permission_profile = Arc::new(PermissionProfile::from_config(&permission_config)?);
        if permission_profile.sandbox_mode == SandboxMode::DangerFullAccess {
            tracing::warn!(event_code = "runtime.permissions.full_access_enabled", "Full access is enabled: file tools and Shell are not restricted by workspace or operating-system sandbox boundaries");
        }
        let separate_reviewer_client = if self.approval_provider.is_none()
            && permission_profile.reviewer == ReviewerKind::AutoReview
        {
            match self.reviewer_client {
                Some(client) => Some(client),
                None => match permission_profile.auto_review_model.as_deref() {
                    Some(model) => {
                        let (client, selected) =
                            build_configured_client(&self.config, None, Some(model))?;
                        tracing::info!(
                            route = model,
                            provider = %selected.id,
                            physical_model = %selected.model,
                            event_code = "runtime.auto_review.route_selected",
                            "Auto-review is using an independent Model Route"
                        );
                        Some(client)
                    }
                    None => None,
                },
            }
        } else {
            None
        };
        if let Some(client) = separate_reviewer_client.as_ref() {
            client.attach_provider_account_state_store(
                Arc::clone(&store) as Arc<dyn crate::memory::ProviderAccountStateStore>
            );
            client.attach_provider_auth_manager(Arc::clone(&provider_auth_manager));
        }
        let auto_review_client = separate_reviewer_client
            .as_ref()
            .cloned()
            .unwrap_or_else(|| Arc::clone(&self.client));
        let built_in_auto_review_provider = if self.approval_provider.is_none()
            && permission_profile.reviewer == ReviewerKind::AutoReview
        {
            Some(Arc::new(AiAutoReviewProvider::new(
                auto_review_client,
                Arc::clone(&store) as Arc<dyn EventStore>,
            )))
        } else {
            None
        };
        let approval_provider = match self.approval_provider {
            Some(provider) => provider,
            None => {
                let human_review: Arc<dyn ApprovalProvider> = Arc::new(HumanApprovalProvider::new(
                    human_approval_hub.clone(),
                    Arc::clone(&store) as Arc<dyn ApprovalStore>,
                ));
                match permission_profile.reviewer {
                    ReviewerKind::AutoReview => Arc::new(EscalatingApprovalProvider::new(
                        built_in_auto_review_provider
                            .as_ref()
                            .cloned()
                            .expect("built-in auto reviewer must exist"),
                        human_review,
                    )) as Arc<dyn ApprovalProvider>,
                    ReviewerKind::User => human_review,
                    ReviewerKind::Deny => Arc::new(DenyAllApprovalProvider::new(
                        "the current permission Profile forbids out-of-bound capability requests",
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
        let execution_jobs = Arc::new(
            ExecutionJobManager::new(Arc::clone(&store) as Arc<dyn ExecutionJobStore>)
                .with_scheduler_kernel(Arc::clone(&scheduler_kernel)),
        );
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
            .with_thread_store(Arc::clone(&store) as Arc<dyn crate::memory::ThreadStore>)
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
        let background_scheduler = Arc::new(
            BackgroundTaskScheduler::new_with_execution_jobs(
                Arc::clone(&bus),
                Arc::clone(&store) as Arc<dyn EventStore>,
                Arc::clone(&timer_engine),
                Arc::clone(&execution_jobs),
            )
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
        );
        background_scheduler.register_timer_handler()?;
        #[cfg(feature = "experimental-cognitive-coordination")]
        let cognitive_coordination_network = if let Ok(permit) =
            crate::experimental::require_enabled(
                &self.config.experimental.enabled,
                crate::experimental::COGNITIVE_COORDINATION,
            ) {
            let coordination = &self.config.experimental.cognitive_coordination;
            if coordination.participant.is_some() || coordination.mesh.is_some() {
                match crate::experimental::cognitive_coordination_network::CognitiveCoordinationNetworkService::new_with_secret_store(
                    permit,
                    self.config
                        .experimental
                        .cognitive_coordination
                        .clone(),
                    secret_store.as_ref(),
                ) {
                    Ok(service) => Some(Arc::new(service.with_assignment_store(
                        Arc::clone(&store) as Arc<dyn crate::memory::WorkAssignmentStore>,
                    ))),
                    Err(error) => {
                        tracing::warn!(
                            error = %error,
                            event_code = "runtime.cognitive_coordination.initialization_deferred",
                            "Cognitive Coordination is unavailable for this process; local Runtime startup will continue"
                        );
                        None
                    }
                }
            } else {
                None
            }
        } else {
            None
        };
        register_default_tools(DefaultToolDependencies {
            registry: &registry,
            context_engine: &context_engine,
            objective_supervisor: &objective_supervisor,
            objective_evaluations: &objective_evaluations,
            harness_registry: &harness_registry,
            event_store: &(Arc::clone(&store) as Arc<dyn EventStore>),
            capability_binding_store: Arc::clone(&store)
                as Arc<dyn crate::memory::ContextCapabilityBindingStore>,
            permissions: &permissions,
            bus: &bus,
            thread_scheduler: &thread_scheduler,
            scheduler_kernel: &scheduler_kernel,
            background_scheduler: &background_scheduler,
            secret_store: &secret_store,
            config: &self.config,
            policy: self.tool_policy,
            #[cfg(feature = "experimental-cognitive-coordination")]
            cognitive_coordination_network: cognitive_coordination_network.clone(),
        });
        for tool in self.extra_tools {
            registry.register(tool);
        }
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
                Arc::clone(&secret_store),
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
                return Err(format!(
                    "duplicate Runtime Managed SSH Target id '{}'",
                    target_config.id
                )
                .into());
            }
            let endpoint =
                crate::execution_target::ManagedSshEndpoint::load(&target_config.endpoint_ref)?;
            for (label, alias) in [
                ("private key", endpoint.private_key_secret.as_deref()),
                (
                    "private key passphrase",
                    endpoint.private_key_passphrase_secret.as_deref(),
                ),
                ("password", endpoint.password_secret.as_deref()),
            ] {
                if let Some(alias) = alias {
                    if !secret_store.contains_alias(alias)? {
                        return Err(format!(
                            "{label} Secret '{}' bound to Runtime Managed SSH Target '{}' does not exist",
                            alias, target_config.id
                        )
                        .into());
                    }
                }
            }
            if endpoint.destination.is_none() {
                permissions
                    .profile()
                    .canonical_permission_root(&endpoint.known_hosts_file.to_string_lossy())
                    .map_err(|error| {
                        format!(
                            "known_hosts_file for Runtime Managed SSH Target '{}' cannot be authorized: {error}",
                            target_config.id
                        )
                    })?;
            }
            runtime_managed_ssh_provisioner
                .register_configured_target(target_config, endpoint)
                .await?;
        }
        for durable_target in store
            .list_execution_targets(ExecutionTargetFilter {
                provider_node_is_null: true,
                kind: Some(crate::memory::ExecutionTargetKind::ManagedSsh),
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
            if !runtime_managed_ssh_provisioner.belongs_to_current_runtime_host(&durable_target) {
                tracing::debug!(
                    target_id = %durable_target.id,
                    owner_runtime_host_id = ?durable_target.metadata.get("runtime_host_id"),
                    event_code = "runtime.managed_ssh.foreign_host_route_skipped",
                    "Skipped a system OpenSSH Target owned by another Runtime host"
                );
                continue;
            }
            match runtime_managed_ssh_provisioner
                .restore_route(&durable_target)
                .await
            {
                Ok(()) => {
                    tracing::debug!(
                        target_id = %durable_target.id,
                        host = ?durable_target.metadata.get("host"),
                        event_code = "runtime.managed_ssh.route_restored",
                        "Restored the process-local Managed SSH route descriptor without dialing the remote host"
                    );
                }
                Err(error) => {
                    tracing::warn!(
                        target_id = %durable_target.id,
                        error = %error,
                        event_code = "runtime.managed_ssh.route_restore_deferred",
                        "Runtime Managed SSH route descriptor was not restored; it can be retried with resolve_target(target_id)"
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
            Arc::clone(&secret_store),
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
            self.config.model_input.clone(),
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
                provider_catalog_config: RwLock::new(provider_catalog_config),
                identity: self.identity,
                identity_provider,
                permissions,
                sqlite_database_path,
                storage_label,
                client: runtime_client,
                reviewer_client: RwLock::new(separate_reviewer_client),
                auto_review_provider: built_in_auto_review_provider,
                bus,
                store,
                registry,
                harness_registry,
                model_context_capacity,
                model_context_capacities,
                model_prompt_token_limit_overrides,
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
                provider_auth_manager,
                timer_engine,
                human_approval_hub,
                #[cfg(feature = "experimental-cognitive-coordination")]
                cognitive_coordination_network,
                runtime_instance_id: new_runtime_instance_id(),
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
    capability_binding_store: Arc<dyn crate::memory::ContextCapabilityBindingStore>,
    permissions: &'a Arc<PermissionBroker>,
    bus: &'a Arc<InMemoryEventBus>,
    thread_scheduler: &'a Arc<ThreadScheduler>,
    scheduler_kernel: &'a Arc<SchedulerKernel>,
    background_scheduler: &'a Arc<BackgroundTaskScheduler>,
    secret_store: &'a Arc<SecretStore>,
    config: &'a AppConfig,
    policy: RuntimeToolPolicy,
    #[cfg(feature = "experimental-cognitive-coordination")]
    cognitive_coordination_network: Option<
        Arc<
            crate::experimental::cognitive_coordination_network::CognitiveCoordinationNetworkService,
        >,
    >,
}

fn register_default_tools(dependencies: DefaultToolDependencies<'_>) {
    let DefaultToolDependencies {
        registry,
        context_engine,
        objective_supervisor,
        objective_evaluations,
        harness_registry,
        event_store,
        capability_binding_store,
        permissions,
        bus,
        thread_scheduler,
        scheduler_kernel,
        background_scheduler,
        secret_store,
        config,
        policy,
        #[cfg(feature = "experimental-cognitive-coordination")]
        cognitive_coordination_network,
    } = dependencies;
    if config.orchestrator.context_transactions_enabled {
        registry.register(Arc::new(ContextTxTool::new(Arc::clone(context_engine))));
    }
    #[cfg(not(feature = "experimental-cognitive-coordination"))]
    let _ = capability_binding_store;
    #[cfg(feature = "experimental-cognitive-coordination")]
    if let Ok(permit) = crate::experimental::require_enabled(
        &config.experimental.enabled,
        crate::experimental::COGNITIVE_COORDINATION,
    ) {
        let backend: Arc<
            dyn crate::experimental::cognitive_coordination_sdk::CognitiveCoordinationBackend,
        > = match cognitive_coordination_network {
            Some(service) => Arc::new(service),
            None => Arc::new(
                crate::experimental::cognitive_coordination_sdk::UnavailableCognitiveCoordinationBackend,
            ),
        };
        registry.register(Arc::new(
            crate::experimental::cognitive_coordination_sdk::CoordinateTool::new(
                permit,
                capability_binding_store,
                backend,
            ),
        ));
    }
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
    registry.register(Arc::new(ObjectiveAmendTool::new(
        Arc::clone(objective_supervisor),
        Arc::clone(context_engine),
    )));
    registry.register(Arc::new(SendMessageTool::new(
        Arc::clone(bus),
        context_engine
            .session_store()
            .expect("Runtime ContextEngine requires a SessionStore"),
    )));
    registry.register(Arc::new(SessionSignalTool::new(
        Arc::clone(bus),
        Arc::clone(event_store),
        context_engine
            .session_store()
            .expect("Runtime ContextEngine requires a SessionStore"),
    )));
    registry.register(Arc::new(
        ScheduleTxTool::new(
            Arc::clone(thread_scheduler),
            context_engine
                .session_store()
                .expect("Runtime ContextEngine requires a SessionStore"),
        )
        .with_objective_store(objective_supervisor.store())
        .with_scheduler_kernel(Arc::clone(scheduler_kernel))
        .with_allowed_evaluation_models(
            std::iter::once(config.llm.model.clone())
                .chain(config.llm.allowed_evaluation_models.iter().cloned()),
        )
        .with_evaluation_model_policy(Arc::clone(context_engine)),
    ));
    registry.register(Arc::new(PrincipalTool::new(
        context_engine
            .session_store()
            .expect("Runtime ContextEngine requires a SessionStore"),
    )));
    registry.register(Arc::new(ListSecretsTool::new(Arc::clone(secret_store))));
    if policy.context_only {
        return;
    }
    registry.register(Arc::new(WriteFileTool::new_with_runtime(
        Arc::clone(permissions),
        Arc::clone(bus),
    )));
    registry.register(Arc::new(ReadFileTool::new_with_permissions_and_limit(
        Arc::clone(permissions),
        config.model_input.max_artifact_bytes,
    )));
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
    /// Authoritative in-process Provider/Account/Route catalog. Unlike the
    /// immutable startup config, operator mutations replace this snapshot and
    /// the routed client atomically without restarting the Runtime.
    provider_catalog_config: RwLock<AppConfig>,
    identity: RuntimeIdentity,
    identity_provider: Arc<dyn IdentityProvider>,
    permissions: Arc<PermissionBroker>,
    sqlite_database_path: Option<String>,
    storage_label: String,
    client: Arc<dyn Client>,
    /// Independent automatic-review route, retained so Provider catalog hot
    /// replacement updates both the main and reviewer routers.
    reviewer_client: RwLock<Option<Arc<dyn Client>>>,
    /// Built-in reviewer handle used to atomically switch the review route
    /// from the operator control plane without rebuilding the Runtime.
    auto_review_provider: Option<Arc<AiAutoReviewProvider>>,
    bus: Arc<InMemoryEventBus>,
    store: Arc<dyn RuntimeStore>,
    registry: Arc<Registry>,
    harness_registry: Arc<DomainHarnessRegistry>,
    model_context_capacity: Arc<RwLock<ModelContextCapacity>>,
    model_context_capacities: Arc<RwLock<HashMap<String, ModelContextCapacity>>>,
    /// Operator changes are applied immediately and also persisted by the
    /// embedding surface. Keeping the in-process overlay means switching away
    /// from a model and back does not temporarily restore stale startup data.
    model_prompt_token_limit_overrides: RwLock<HashMap<String, usize>>,
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
    provider_auth_manager: Arc<crate::provider::auth::ProviderAuthManager>,
    timer_engine: Arc<TimerEngine>,
    human_approval_hub: HumanApprovalHub,
    #[cfg(feature = "experimental-cognitive-coordination")]
    cognitive_coordination_network: Option<
        Arc<
            crate::experimental::cognitive_coordination_network::CognitiveCoordinationNetworkService,
        >,
    >,
    runtime_instance_id: String,
    process_started_at: chrono::DateTime<chrono::Utc>,
    recovery: std::sync::RwLock<RuntimeRecoveryStatus>,
    started: AtomicBool,
    start_lock: tokio::sync::Mutex<()>,
}

async fn reconcile_pending_message_attachments(
    inner: &RuntimeInner,
) -> Result<crate::model_input::MessageAttachmentRecovery, RuntimeError> {
    let attachment_store = Arc::clone(&inner.store);
    crate::model_input::recover_pending_message_attachments(
        &inner.config.background_task.artifact_dir,
        std::time::Duration::from_secs(inner.config.model_input.pending_import_grace.as_secs()),
        move |event_id| {
            let store = Arc::clone(&attachment_store);
            async move {
                Ok(!store
                    .query(QueryFilter {
                        event_id: Some(event_id),
                        top_k: Some(1),
                        ..Default::default()
                    })
                    .await?
                    .is_empty())
            }
        },
    )
    .await
}

fn log_message_attachment_recovery(
    recovery: crate::model_input::MessageAttachmentRecovery,
    recovery_kind: &'static str,
) {
    if recovery != Default::default() {
        tracing::info!(
            committed_manifests = recovery.committed_manifests,
            orphaned_imports = recovery.orphaned_imports,
            deferred_live_imports = recovery.deferred_live_imports,
            invalid_manifests = recovery.invalid_manifests,
            recovery_kind,
            event_code = "runtime.message_attachments.recovery_completed",
            "Message-input attachment recovery completed"
        );
    }
}

#[derive(Clone)]
pub struct MorphzRuntime {
    inner: Arc<RuntimeInner>,
}

impl MorphzRuntime {
    pub fn builder(config: AppConfig, client: Arc<dyn Client>) -> MorphzRuntimeBuilder {
        MorphzRuntimeBuilder::new(config, client)
    }

    pub fn provider_catalog_config(&self) -> Result<AppConfig, RuntimeError> {
        self.inner
            .provider_catalog_config
            .read()
            .map(|config| config.clone())
            .map_err(|_| std::io::Error::other("Provider catalog lock poisoned").into())
    }

    pub async fn replace_provider_catalog(
        &self,
        mut config: AppConfig,
    ) -> Result<(), RuntimeError> {
        // Replace the actual request router before publishing the control-plane
        // snapshot. A failed catalog never becomes visible as active state.
        let reviewer_client = self
            .inner
            .reviewer_client
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if let Some(reviewer) = reviewer_client.as_ref() {
            reviewer.replace_provider_catalog(&config)?;
        }
        self.inner.client.replace_provider_catalog(&config)?;
        self.inner.context_engine.set_evaluation_model_policy(
            config.llm.model.clone(),
            config.llm.allowed_evaluation_models.clone(),
        );
        config.permissions.auto_review_model = self.inner.permissions.auto_review_model();
        let selected_model = self.model();
        let fallback_capacity = resolve_model_context_capacity(&config, &selected_model);
        let mut capacities = resolve_model_context_capacities(&config);
        for (model, limit) in self
            .inner
            .model_prompt_token_limit_overrides
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
        {
            if let Some(model_capacity) = capacities.get_mut(model) {
                model_capacity.prompt_token_limit = *limit;
                model_capacity.source = "managed-provider-model-override".to_string();
            }
        }
        let capacity = capacities
            .get(&selected_model)
            .cloned()
            .unwrap_or(fallback_capacity);
        {
            let mut current = self
                .inner
                .provider_catalog_config
                .write()
                .map_err(|_| std::io::Error::other("Provider catalog lock poisoned"))?;
            *current = config;
        }
        *self
            .inner
            .model_context_capacity
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = capacity.clone();
        *self
            .inner
            .model_context_capacities
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = capacities;
        self.publish_model_configuration_changed("provider_catalog_replaced")
            .await?;
        Ok(())
    }

    /// Commit one durable configuration epoch and wake work whose next model
    /// attempt is made runnable by that explicit configuration change.
    ///
    /// Objectives waiting on the abstract model-configuration resource and
    /// Threads waiting on a concrete model route are deliberately separate:
    /// the latter must be released when an operator switches routes, otherwise
    /// they remain pinned forever to the route that originally failed. The
    /// indexed dependency lookups avoid Context/Objectives/Threads sweeps,
    /// while the global epoch Event closes restart and in-flight request races
    /// even if a process stops before all context-local wake Events are
    /// dispatched.
    async fn publish_model_configuration_changed(&self, reason: &str) -> Result<(), RuntimeError> {
        let changed = Event::new(
            format!(
                "model_configuration_changed_{}_{}",
                self.inner.runtime_instance_id,
                chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
            ),
            "Runtime-ModelConfiguration".to_string(),
            "runtime_control".to_string(),
            TYPE_MODEL_CONFIGURATION_CHANGED.to_string(),
            [
                ("resource".to_string(), json!(MODEL_CONFIGURATION_RESOURCE)),
                ("reason".to_string(), json!(reason)),
                ("model".to_string(), json!(self.model())),
            ]
            .into_iter()
            .collect(),
        );
        self.inner.bus.publish(changed.clone()).await?;

        let dependencies = self
            .inner
            .store
            .list_scheduler_dependencies(SchedulerDependencyFilter {
                owner_kind: Some(SchedulerDependencyOwnerKind::Objective),
                dependency_kind: Some(SchedulerDependencyKind::Resource),
                dependency_id: Some(MODEL_CONFIGURATION_RESOURCE.to_string()),
                status: Some(SchedulerDependencyStatus::Pending),
                required_only: true,
                ..SchedulerDependencyFilter::default()
            })
            .await?;
        let mut contexts = BTreeMap::<String, Vec<String>>::new();
        for dependency in dependencies {
            let Some(objective) = self.inner.store.get_objective(&dependency.owner_id).await?
            else {
                continue;
            };
            if objective.status != ObjectiveStatus::Active
                || dependency.owner_generation != objective.generation
                || !matches!(
                    objective.wait_condition,
                    Some(ObjectiveWaitCondition::ResourceAvailable { ref resource })
                        if resource == MODEL_CONFIGURATION_RESOURCE
                )
            {
                continue;
            }
            contexts
                .entry(objective.context_id)
                .or_default()
                .push(objective.id);
        }

        for (index, (context_id, objective_ids)) in contexts.into_iter().enumerate() {
            self.inner
                .bus
                .publish(Event::new(
                    format!("model_configuration_available_{}_{}", changed.id, index),
                    "Runtime-ModelConfiguration".to_string(),
                    "runtime_control".to_string(),
                    "runtime/resource_available".to_string(),
                    [
                        ("context_id".to_string(), json!(context_id)),
                        ("resource".to_string(), json!(MODEL_CONFIGURATION_RESOURCE)),
                        ("reason".to_string(), json!(reason)),
                        ("configuration_event_id".to_string(), json!(&changed.id)),
                        ("objective_ids".to_string(), json!(objective_ids)),
                    ]
                    .into_iter()
                    .collect(),
                ))
                .await?;
        }

        let mut provider_waits = BTreeMap::<(String, String), (Vec<String>, Vec<String>)>::new();
        for owner_kind in [
            SchedulerDependencyOwnerKind::Thread,
            SchedulerDependencyOwnerKind::Objective,
        ] {
            let dependencies = self
                .inner
                .store
                .list_scheduler_dependencies(SchedulerDependencyFilter {
                    owner_kind: Some(owner_kind),
                    dependency_kind: Some(SchedulerDependencyKind::Resource),
                    status: Some(SchedulerDependencyStatus::Pending),
                    required_only: true,
                    ..SchedulerDependencyFilter::default()
                })
                .await?;
            for dependency in dependencies {
                if !dependency.dependency_id.starts_with("model-route:")
                    && !dependency.dependency_id.starts_with("model-provider:")
                {
                    continue;
                }
                match dependency.owner_kind {
                    SchedulerDependencyOwnerKind::Thread => {
                        let Some(thread) =
                            self.inner.store.get_thread(&dependency.owner_id).await?
                        else {
                            continue;
                        };
                        if thread.lifecycle != ThreadLifecycle::Open
                            || thread.generation != dependency.owner_generation
                        {
                            continue;
                        }
                        provider_waits
                            .entry((thread.context_id, dependency.dependency_id))
                            .or_default()
                            .1
                            .push(thread.id);
                    }
                    SchedulerDependencyOwnerKind::Objective => {
                        let Some(objective) =
                            self.inner.store.get_objective(&dependency.owner_id).await?
                        else {
                            continue;
                        };
                        if objective.status != ObjectiveStatus::Active
                            || objective.generation != dependency.owner_generation
                            || !matches!(
                                objective.wait_condition,
                                Some(ObjectiveWaitCondition::ResourceAvailable {
                                    ref resource
                                }) if resource == &dependency.dependency_id
                            )
                        {
                            continue;
                        }
                        provider_waits
                            .entry((objective.context_id, dependency.dependency_id))
                            .or_default()
                            .0
                            .push(objective.id);
                    }
                    SchedulerDependencyOwnerKind::Plan
                    | SchedulerDependencyOwnerKind::Schedule
                    | SchedulerDependencyOwnerKind::Delivery => continue,
                }
            }
        }

        for (index, ((context_id, resource), (objective_ids, thread_ids))) in
            provider_waits.into_iter().enumerate()
        {
            self.inner
                .bus
                .publish(Event::new(
                    format!(
                        "model_configuration_provider_available_{}_{}",
                        changed.id, index
                    ),
                    "Runtime-ModelConfiguration".to_string(),
                    "runtime_control".to_string(),
                    "runtime/resource_available".to_string(),
                    [
                        ("context_id".to_string(), json!(context_id)),
                        ("resource".to_string(), json!(resource)),
                        ("reason".to_string(), json!(reason)),
                        ("configuration_event_id".to_string(), json!(&changed.id)),
                        ("selected_model".to_string(), json!(self.model())),
                        ("objective_ids".to_string(), json!(objective_ids)),
                        ("thread_ids".to_string(), json!(thread_ids)),
                        (
                            "recovery_phase".to_string(),
                            json!("explicit_model_configuration_changed"),
                        ),
                        (
                            "recovery_reason".to_string(),
                            json!("operator_selected_or_reconfigured_model"),
                        ),
                    ]
                    .into_iter()
                    .collect(),
                ))
                .await?;
        }
        Ok(())
    }

    /// Wake only durable model waiters owned by one Session after its
    /// evaluation policy changes. The failed resource remains the dependency
    /// key for deterministic satisfaction, while the next Activation resolves
    /// the Session's current model and reasoning settings afresh.
    async fn publish_session_evaluation_policy_changed(
        &self,
        previous: &SessionRecord,
        current: &SessionRecord,
    ) -> Result<(), RuntimeError> {
        let changed = Event::new(
            format!(
                "session_model_configuration_changed_{}_{}_{}",
                current.id,
                current.updated_at.timestamp_micros(),
                chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
            ),
            "Runtime-SessionModelConfiguration".to_string(),
            "runtime_control".to_string(),
            TYPE_MODEL_CONFIGURATION_CHANGED.to_string(),
            [
                (
                    "resource".to_string(),
                    json!(format!("session-model-configuration:{}", current.id)),
                ),
                ("context_id".to_string(), json!(&current.context_id)),
                ("session_id".to_string(), json!(&current.id)),
                (
                    "reason".to_string(),
                    json!("session_evaluation_policy_changed"),
                ),
                ("previous_model".to_string(), json!(&previous.model_alias)),
                ("selected_model".to_string(), json!(&current.model_alias)),
                (
                    "previous_reasoning_effort".to_string(),
                    json!(&previous.reasoning_effort),
                ),
                (
                    "reasoning_effort".to_string(),
                    json!(&current.reasoning_effort),
                ),
            ]
            .into_iter()
            .collect(),
        );
        self.inner.bus.publish(changed.clone()).await?;

        let threads = self
            .inner
            .store
            .list_session_threads(&current.context_id, &current.id, false)
            .await?;
        let thread_by_id = threads
            .into_iter()
            .map(|thread| (thread.id.clone(), thread))
            .collect::<BTreeMap<_, _>>();
        let objectives = self
            .inner
            .store
            .list_session_objectives(&current.context_id, &current.id, false)
            .await?;
        let objective_by_id = objectives
            .into_iter()
            .map(|objective| (objective.id.clone(), objective))
            .collect::<BTreeMap<_, _>>();
        let mut provider_waits = BTreeMap::<String, (Vec<String>, Vec<String>)>::new();
        for (owner_kind, owner_ids) in [
            (
                SchedulerDependencyOwnerKind::Thread,
                thread_by_id.keys().cloned().collect::<Vec<_>>(),
            ),
            (
                SchedulerDependencyOwnerKind::Objective,
                objective_by_id.keys().cloned().collect::<Vec<_>>(),
            ),
        ] {
            let dependencies = self
                .inner
                .store
                .list_scheduler_dependencies_for_owners(owner_kind, &owner_ids)
                .await?;
            for dependency in dependencies {
                if dependency.status != SchedulerDependencyStatus::Pending
                    || dependency.dependency_kind != SchedulerDependencyKind::Resource
                    || !dependency.required
                    || (!dependency.dependency_id.starts_with("model-route:")
                        && !dependency.dependency_id.starts_with("model-provider:"))
                {
                    continue;
                }
                match dependency.owner_kind {
                    SchedulerDependencyOwnerKind::Thread => {
                        let Some(thread) = thread_by_id.get(&dependency.owner_id) else {
                            continue;
                        };
                        if thread.lifecycle != ThreadLifecycle::Open
                            || thread.generation != dependency.owner_generation
                        {
                            continue;
                        }
                        provider_waits
                            .entry(dependency.dependency_id)
                            .or_default()
                            .1
                            .push(thread.id.clone());
                    }
                    SchedulerDependencyOwnerKind::Objective => {
                        let Some(objective) = objective_by_id.get(&dependency.owner_id) else {
                            continue;
                        };
                        if objective.status != ObjectiveStatus::Active
                            || objective.generation != dependency.owner_generation
                            || !matches!(
                                objective.wait_condition,
                                Some(ObjectiveWaitCondition::ResourceAvailable {
                                    ref resource
                                }) if resource == &dependency.dependency_id
                            )
                        {
                            continue;
                        }
                        provider_waits
                            .entry(dependency.dependency_id)
                            .or_default()
                            .0
                            .push(objective.id.clone());
                    }
                    SchedulerDependencyOwnerKind::Plan
                    | SchedulerDependencyOwnerKind::Schedule
                    | SchedulerDependencyOwnerKind::Delivery => continue,
                }
            }
        }

        for (index, (resource, (objective_ids, thread_ids))) in
            provider_waits.into_iter().enumerate()
        {
            self.inner
                .bus
                .publish(Event::new(
                    format!("session_model_available_{}_{}", changed.id, index),
                    "Runtime-SessionModelConfiguration".to_string(),
                    "runtime_control".to_string(),
                    "runtime/resource_available".to_string(),
                    [
                        ("context_id".to_string(), json!(&current.context_id)),
                        ("session_id".to_string(), json!(&current.id)),
                        ("resource".to_string(), json!(resource)),
                        ("configuration_event_id".to_string(), json!(&changed.id)),
                        ("selected_model".to_string(), json!(&current.model_alias)),
                        ("objective_ids".to_string(), json!(objective_ids)),
                        ("thread_ids".to_string(), json!(thread_ids)),
                        (
                            "recovery_phase".to_string(),
                            json!("session_evaluation_policy_changed"),
                        ),
                        (
                            "recovery_reason".to_string(),
                            json!("operator_changed_session_model_or_reasoning"),
                        ),
                    ]
                    .into_iter()
                    .collect(),
                ))
                .await?;
        }
        Ok(())
    }

    async fn publish_session_sandbox_policy_changed(
        &self,
        previous: &SessionRecord,
        current: &SessionRecord,
    ) -> Result<(), RuntimeError> {
        let changed = Event::new(
            format!(
                "session_sandbox_policy_changed_{}_{}_{}",
                current.id,
                current.updated_at.timestamp_micros(),
                chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
            ),
            "Runtime-SessionSandboxPolicy".to_string(),
            "runtime_control".to_string(),
            "runtime/session_sandbox_policy_changed".to_string(),
            [
                ("context_id".to_string(), json!(&current.context_id)),
                ("session_id".to_string(), json!(&current.id)),
                (
                    "previous_sandbox_mode".to_string(),
                    json!(previous.sandbox_mode),
                ),
                ("sandbox_mode".to_string(), json!(current.sandbox_mode)),
                (
                    "effective_immediately".to_string(),
                    json!("subsequently_started_tool_operations"),
                ),
            ]
            .into_iter()
            .collect(),
        );
        self.inner.bus.publish(changed).await?;
        Ok(())
    }

    pub fn auto_review_model(&self) -> Option<String> {
        self.inner.permissions.auto_review_model()
    }

    /// Change the built-in permission reviewer route without affecting the
    /// conversation model. `None` restores the live main-model client.
    pub fn set_auto_review_model(&self, model: Option<&str>) -> Result<(), RuntimeError> {
        let reviewer = self
            .inner
            .auto_review_provider
            .as_ref()
            .ok_or("the current Runtime is not using the built-in automatic reviewer; its review model cannot be changed")?;
        let model = model.map(str::trim).filter(|value| !value.is_empty());
        let separate_client = if let Some(model) = model {
            let config = self.provider_catalog_config()?;
            let (client, selected) = build_configured_client(&config, None, Some(model))?;
            client
                .attach_provider_account_state_store(Arc::clone(&self.inner.store)
                    as Arc<dyn crate::memory::ProviderAccountStateStore>);
            client.attach_provider_auth_manager(Arc::clone(&self.inner.provider_auth_manager));
            tracing::info!(
                route = model,
                provider = %selected.id,
                physical_model = %selected.model,
                event_code = "runtime.auto_review.route_hot_switched",
                "Auto-review hot-switched to an independent Model Route"
            );
            Some(client)
        } else {
            None
        };
        let active_client = separate_client
            .as_ref()
            .cloned()
            .unwrap_or_else(|| Arc::clone(&self.inner.client));
        reviewer.replace_client(active_client)?;
        *self
            .inner
            .reviewer_client
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = separate_client;
        let model = model.map(str::to_string);
        self.inner.permissions.set_auto_review_model(model.clone());
        self.inner
            .provider_catalog_config
            .write()
            .map_err(|_| std::io::Error::other("Provider catalog lock poisoned"))?
            .permissions
            .auto_review_model = model;
        Ok(())
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
                    title: "Default Agent".to_string(),
                    root_context_id: self.inner.identity.context_id.clone(),
                })
                .await?;
        }
        self.inner
            .store
            .ensure_context(NewCognitiveContext {
                id: self.inner.identity.context_id.clone(),
                agent_id: self.inner.identity.agent_id.clone(),
                title: "Default Cognitive Context".to_string(),
            })
            .await?;
        // Archived Sessions cannot receive new work. Register only active
        // routes; archived records remain queryable through the directory and
        // are registered again if the user explicitly reactivates them.
        for session in self.inner.store.list_sessions(false).await? {
            self.inner
                .permissions
                .set_session_sandbox_mode(&session.id, session.sandbox_mode);
            self.inner
                .orchestrator
                .register_session_context(&session.id, &session.context_id);
        }
        log_message_attachment_recovery(
            reconcile_pending_message_attachments(&self.inner).await?,
            "startup",
        );
        let execution_recovery = self
            .inner
            .execution_jobs
            .reconcile_startup(
                self.inner.store.worker_coordination_mode(),
                self.inner.store.as_ref(),
                Some(self.inner.store.as_ref()),
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
            event_code = "runtime.execution_jobs.startup_recovery_completed",
            "Execution Job startup recovery completed"
        );
        self.reconcile_artifact_transfer_scheduler_projections()
            .await?;
        let artifact_transfer_records = self
            .inner
            .store
            .list_execution_jobs(ExecutionJobFilter {
                tool_name: Some(ARTIFACT_TRANSFER_TOOL_NAME.to_string()),
                include_terminal: false,
                newest_first: false,
                ..Default::default()
            })
            .await?;
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
                tracing::info!(
                    event_code = "runtime.artifact_transfer.stage_cleanup_completed",
                    removed,
                    "Artifact Transfer terminal-stage cleanup completed"
                )
            }
            Ok(_) => {}
            Err(error) => {
                tracing::warn!(event_code = "runtime.artifact_transfer.stage_cleanup_failed", %error, "Artifact Transfer startup stage cleanup failed")
            }
        }
        let artifact_transfer_jobs = artifact_transfer_records
            .into_iter()
            .filter(|job| job.status == ExecutionJobStatus::Queued)
            .map(|job| job.id)
            .collect::<Vec<_>>();
        Arc::clone(&self.inner.orchestrator).start().await?;
        Arc::clone(&self.inner.objective_supervisor).start().await?;
        // Loading the operator's persisted catalog/settings establishes a new
        // configuration epoch. This is an explicit recovery fact rather than
        // an unconditional Objective wait reset: only the exact indexed
        // model-configuration dependencies are released.
        self.publish_model_configuration_changed("runtime_started_with_loaded_configuration")
            .await?;
        self.inner.thread_scheduler.recover().await?;
        self.inner.timer_engine.start();
        for job_id in artifact_transfer_jobs {
            self.spawn_artifact_transfer_job(job_id);
        }
        let recall_store = Arc::clone(&self.inner.store);
        let recall_worker_id = format!("recall-projector:{}", self.inner.runtime_instance_id);
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
                        // single-writer slot ahead of Event, Timer, and Execution
                        // commits. Keep throughput high while giving the
                        // authoritative control plane a deterministic window.
                        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                    }
                    Ok(batch) if batch.claimed > 0 => {
                        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                    }
                    Ok(_) => {
                        // Recall is a rebuildable projection, not scheduler
                        // authority. Avoid four empty database probes per
                        // second on an idle Runtime; new work is still picked
                        // up within a small bounded projection lag.
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    }
                    Err(error) => {
                        tracing::warn!(event_code = "runtime.recall_projection.background_batch_failed", %error, "Recall Projection background batch failed");
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    }
                }
            }
        });
        let edge_store = Arc::clone(&self.inner.store);
        let edge_execution_jobs = Arc::clone(&self.inner.execution_jobs);
        let edge_background_scheduler = Arc::clone(&self.inner.background_scheduler);
        let edge_worker_coordination = self.inner.store.worker_coordination_mode();
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
            let mut background_outbox_recovery_needed = false;
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
                            event_code = "runtime.edge_execution.reconciliation_completed",
                            "Edge execution reconciliation completed"
                        );
                    }
                    Ok(_) => {}
                    Err(error) => {
                        tracing::warn!(event_code = "runtime.edge_execution.reconciliation_failed", %error, "Edge execution reconciliation failed")
                    }
                }
                match edge_execution_jobs
                    .reconcile_expired_edge_background_jobs(
                        edge_worker_coordination,
                        edge_store.as_ref(),
                        Some(edge_store.as_ref()),
                        now,
                    )
                    .await
                {
                    Ok(report) => {
                        let recovered = report.recovered_receipts.len();
                        let requeued = report.requeue_receipts.len();
                        let lost = report.lost_receipts.len();
                        background_outbox_recovery_needed |= recovered + lost > 0;
                        if recovered + requeued + lost > 0 {
                            tracing::info!(
                                recovered,
                                requeued,
                                lost,
                                event_code = "runtime.edge_background.reconciliation_completed",
                                "Expired Edge background Execution Jobs were reconciled"
                            );
                        }
                    }
                    Err(error) => {
                        tracing::warn!(
                            event_code = "runtime.edge_background.reconciliation_failed",
                            %error,
                            "Expired Edge background Execution Job reconciliation failed"
                        );
                    }
                }
                if background_outbox_recovery_needed {
                    match edge_background_scheduler
                        .recover_terminal_background_outboxes()
                        .await
                    {
                        Ok(_) => background_outbox_recovery_needed = false,
                        Err(error) => {
                            tracing::warn!(
                                event_code = "runtime.edge_background.outbox_recovery_failed",
                                %error,
                                "Reconciled Edge background results could not be delivered; retrying on the next cycle"
                            );
                        }
                    }
                }
            }
        });
        let attachment_runtime = Arc::downgrade(&self.inner);
        let attachment_recovery_interval = std::time::Duration::from_secs(
            self.inner.config.model_input.pending_import_grace.as_secs(),
        );
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(attachment_recovery_interval).await;
                let Some(runtime) = attachment_runtime.upgrade() else {
                    break;
                };
                match reconcile_pending_message_attachments(&runtime).await {
                    Ok(recovery) => log_message_attachment_recovery(recovery, "periodic"),
                    Err(error) => tracing::warn!(
                        error = %error,
                        event_code = "runtime.message_attachments.periodic_recovery_failed",
                        "Message-input attachment recovery failed and will be retried"
                    ),
                }
                drop(runtime);
            }
        });
        #[cfg(feature = "experimental-cognitive-coordination")]
        if let Some(service) = self.inner.cognitive_coordination_network.clone() {
            let interrupted = service.recover_interrupted_assignments().await?;
            if interrupted > 0 {
                tracing::warn!(
                    count = interrupted,
                    event_code = "runtime.cognitive_coordination.assignments_interrupted",
                    "Recovered expired Cognitive Coordination Assignments as interrupted"
                );
            }
            service.start_heartbeat();
        }
        self.inner.started.store(true, Ordering::Release);
        Ok(())
    }

    pub fn config(&self) -> &AppConfig {
        &self.inner.config
    }

    #[cfg(feature = "experimental-cognitive-coordination")]
    pub fn cognitive_coordination_network(
        &self,
    ) -> Option<
        Arc<
            crate::experimental::cognitive_coordination_network::CognitiveCoordinationNetworkService,
        >,
    >{
        self.inner.cognitive_coordination_network.clone()
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

    pub async fn start_provider_oauth_login(
        &self,
        account_id: &str,
    ) -> Result<OAuthLoginChallenge, RuntimeError> {
        self.inner
            .provider_auth_manager
            .start_login(account_id)
            .await
            .map_err(Into::into)
    }

    pub async fn start_provider_oauth_login_using(
        &self,
        account_id: &str,
        adapter_id: &str,
    ) -> Result<OAuthLoginChallenge, RuntimeError> {
        self.inner
            .provider_auth_manager
            .start_login_using(account_id, adapter_id)
            .await
            .map_err(Into::into)
    }

    /// Register a newly persisted auth account in the live OAuth authority.
    /// This deliberately does not hot-swap Provider routing: the account can
    /// authenticate now, while the saved route becomes active after restart.
    pub fn register_provider_auth_account(
        &self,
        account_id: &str,
        account: AuthAccountConfig,
    ) -> Result<(), RuntimeError> {
        self.inner
            .provider_auth_manager
            .register_account(account_id, account)
            .map_err(Into::into)
    }

    pub fn register_transient_provider_auth_account(
        &self,
        account_id: &str,
        account: AuthAccountConfig,
    ) -> Result<(), RuntimeError> {
        self.inner
            .provider_auth_manager
            .register_transient_account(account_id, account)
            .map_err(Into::into)
    }

    pub fn discard_transient_provider_auth_account(
        &self,
        account_id: &str,
    ) -> Result<bool, RuntimeError> {
        self.inner
            .provider_auth_manager
            .discard_transient_account(account_id)
            .map_err(Into::into)
    }

    pub fn cancel_provider_oauth_login(&self, login_id: &str) -> Result<bool, RuntimeError> {
        self.inner
            .provider_auth_manager
            .cancel_login(login_id)
            .map_err(Into::into)
    }

    pub fn provider_oauth_login_exists(&self, login_id: &str) -> Result<bool, RuntimeError> {
        self.inner
            .provider_auth_manager
            .has_login(login_id)
            .map_err(Into::into)
    }

    pub async fn remove_provider_auth_account(
        &self,
        account_id: &str,
    ) -> Result<bool, RuntimeError> {
        let removed = self
            .inner
            .provider_auth_manager
            .remove_account(account_id)?;
        let records_removed = self
            .inner
            .store
            .delete_provider_account_records(account_id)
            .await?;
        Ok(removed || records_removed)
    }

    pub async fn mark_provider_auth_account_ready(
        &self,
        account_id: &str,
    ) -> Result<(), RuntimeError> {
        self.inner
            .store
            .put_provider_account_state(
                account_id,
                None,
                crate::memory::ProviderAccountStatus::Ready,
                None,
                None,
                false,
            )
            .await?;
        Ok(())
    }

    pub async fn continue_provider_oauth_login(
        &self,
        login_id: &str,
        completion: OAuthLoginCompletion,
    ) -> Result<OAuthLoginProgress, RuntimeError> {
        self.inner
            .provider_auth_manager
            .continue_login(login_id, completion)
            .await
            .map_err(Into::into)
    }

    pub fn provider_oauth_account_metadata(
        &self,
        account_id: &str,
    ) -> Result<OAuthAccountMetadata, RuntimeError> {
        self.inner
            .provider_auth_manager
            .account_metadata(account_id)
            .map_err(Into::into)
    }

    /// Return a live, secret-free snapshot of subscription limits and token
    /// activity for one authenticated Provider account.
    pub async fn provider_subscription_usage(
        &self,
        account_id: &str,
    ) -> Result<ProviderSubscriptionUsage, RuntimeError> {
        let mut usage = self
            .inner
            .provider_auth_manager
            .subscription_usage(account_id)
            .await?;
        usage.selected_model_alias = Some(self.model());
        Ok(usage)
    }

    pub async fn logout_provider_oauth_account(
        &self,
        account_id: &str,
    ) -> Result<bool, RuntimeError> {
        self.inner
            .provider_auth_manager
            .logout(account_id)
            .await
            .map_err(Into::into)
    }

    /// OAuth capability discovery must remain available before a model
    /// Provider has been configured. First-run Dashboard setup depends only
    /// on the registered auth adapters, not on a valid routing catalog.
    pub fn provider_oauth_adapter_descriptors(
        &self,
    ) -> Vec<crate::provider::auth::AuthAdapterDescriptor> {
        self.inner.provider_auth_manager.adapter_descriptors()
    }

    /// Authoritative, secret-free Provider control-plane projection shared by
    /// SDK, CLI, HTTP and Dashboard.
    pub async fn provider_control_snapshot(&self) -> Result<ProviderControlSnapshot, RuntimeError> {
        let config = self.provider_catalog_config()?;
        let catalog = match EffectiveProviderCatalog::from_config(&config) {
            Ok(catalog) => catalog,
            Err(_)
                if config.providers.is_empty()
                    && config.provider_instances.is_empty()
                    && config.auth_accounts.is_empty()
                    && config.model_routes.is_empty() =>
            {
                EffectiveProviderCatalog::empty()
            }
            Err(error) => return Err(error.into()),
        };
        let mut auth_accounts = BTreeMap::new();
        for (account_id, config) in &catalog.auth_accounts {
            let state = self
                .inner
                .store
                .get_provider_account_state(account_id)
                .await?;
            let effective_enabled = state
                .as_ref()
                .map(|state| state.status != crate::memory::ProviderAccountStatus::Disabled)
                .unwrap_or(config.enabled);
            let oauth = config.auth_adapter.ends_with("-oauth");
            let oauth_metadata = if oauth {
                self.inner
                    .provider_auth_manager
                    .account_metadata(account_id)
                    .ok()
            } else {
                None
            };
            auth_accounts.insert(
                account_id.clone(),
                ProviderAccountControlRecord {
                    config: config.clone(),
                    state,
                    effective_enabled,
                    oauth,
                    authenticated: oauth_metadata.is_some(),
                    oauth_metadata,
                },
            );
        }
        Ok(ProviderControlSnapshot {
            generated_at: chrono::Utc::now(),
            experimental_features: if cfg!(feature = "experimental-structured-context-delta-cache")
            {
                vec!["structured-context-delta-cache".to_string()]
            } else {
                Vec::new()
            },
            selected_model_alias: self.model(),
            allowed_evaluation_models: config.llm.allowed_evaluation_models.clone(),
            permission_mode: self.inner.permissions.profile().mode,
            reviewer: self.inner.permissions.profile().reviewer,
            auto_review_model: self.auto_review_model(),
            auth_adapters: self.inner.provider_auth_manager.adapter_descriptors(),
            provider_instances: catalog.provider_instances,
            auth_accounts,
            model_routes: catalog.model_routes,
            discovered_models: self.inner.store.list_provider_model_catalog().await?,
        })
    }

    /// Return recent physical Model Attempts across all Contexts for the
    /// operator control plane. Principal-scoped APIs deliberately do not
    /// expose this global projection.
    pub async fn recent_provider_attempts(
        &self,
        limit: usize,
    ) -> Result<Vec<ModelUsageRecord>, RuntimeError> {
        let events = self
            .inner
            .store
            .query(QueryFilter {
                topic: Some("runtime/model_usage".to_string()),
                latest_k: Some(limit.clamp(1, 500)),
                ..Default::default()
            })
            .await?;
        let mut records = events
            .into_iter()
            .filter_map(model_usage_record_from_event)
            .collect::<Vec<_>>();
        records.reverse();
        for record in &mut records {
            let physical_model = record
                .model_binding
                .as_ref()
                .map(|binding| binding.physical_model.as_str())
                .or(record.model.as_deref());
            record.cost = calculate_model_usage_cost(
                &self.inner.config.usage_pricing,
                physical_model,
                &record.usage,
            );
        }
        Ok(records)
    }

    /// Run a small, explicit control-plane request against one logical route.
    /// The optional account pins the physical Auth Account without changing
    /// the process-wide selected model or normal routing affinity.
    pub async fn diagnose_model_route(
        &self,
        alias: &str,
        account_id: Option<&str>,
    ) -> Result<ModelRouteDiagnostic, RuntimeError> {
        self.inner
            .client
            .diagnose_model_route(alias, account_id)
            .await
    }

    /// Refresh and durably project a Provider's remote physical model
    /// catalog. A failed catalog request never erases the last good snapshot.
    pub async fn refresh_model_catalog(
        &self,
        alias: &str,
        account_id: Option<&str>,
    ) -> Result<ModelRouteDiagnostic, RuntimeError> {
        let diagnostic = self.diagnose_model_route(alias, account_id).await?;
        if diagnostic.catalog_error.is_none() {
            let binding = &diagnostic.binding;
            self.inner
                .store
                .replace_provider_model_catalog(
                    &binding.provider_instance_id,
                    &binding.auth_account_id,
                    &binding.provider_adapter,
                    &binding.provider_adapter_version,
                    &binding.protocol,
                    "remote_provider",
                    &diagnostic.discovered_models,
                    diagnostic.checked_at,
                )
                .await?;
        }
        Ok(diagnostic)
    }

    /// Test one Provider account without requiring the account to have an
    /// enabled Model Route already.
    pub async fn diagnose_provider_account(
        &self,
        account_id: &str,
        model: Option<&str>,
    ) -> Result<ProviderAccountDiagnostic, RuntimeError> {
        self.inner
            .client
            .diagnose_provider_account(account_id, model)
            .await
    }

    /// Refresh and durably project the remote model catalog for one account.
    /// This is the discovery step used before the operator enables models.
    pub async fn refresh_provider_account_catalog(
        &self,
        account_id: &str,
        model: Option<&str>,
    ) -> Result<ProviderAccountDiagnostic, RuntimeError> {
        let diagnostic = self.diagnose_provider_account(account_id, model).await?;
        if diagnostic.catalog_error.is_none() {
            self.inner
                .store
                .replace_provider_model_catalog(
                    &diagnostic.provider_instance_id,
                    &diagnostic.auth_account_id,
                    &diagnostic.provider_adapter,
                    &diagnostic.provider_adapter_version,
                    &diagnostic.protocol,
                    "remote_provider",
                    &diagnostic.discovered_models,
                    diagnostic.checked_at,
                )
                .await?;
        }
        Ok(diagnostic)
    }

    /// Dynamically enables or disables an account using durable Runtime
    /// state. Static config remains its startup default; the durable override
    /// is shared across workers and survives restart.
    pub async fn control_provider_account(
        &self,
        account_id: &str,
        expected_revision: Option<u64>,
        action: ProviderAccountControlAction,
    ) -> Result<crate::memory::ProviderAccountStateRecord, RuntimeError> {
        // Dashboard/SDK catalog mutations are hot-applied. Validate against
        // that live catalog instead of the immutable startup snapshot, or an
        // account created after boot can never be enabled or disabled.
        let config = self.provider_catalog_config()?;
        let catalog = EffectiveProviderCatalog::from_config(&config)?;
        if !catalog.auth_accounts.contains_key(account_id) {
            return Err(format!("Auth Account '{account_id}' does not exist").into());
        }
        let status = match action {
            ProviderAccountControlAction::Enable => crate::memory::ProviderAccountStatus::Ready,
            ProviderAccountControlAction::Disable => crate::memory::ProviderAccountStatus::Disabled,
        };
        self.inner
            .store
            .put_provider_account_state(account_id, expected_revision, status, None, None, false)
            .await
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

    pub async fn bind_unbound_sessions_to_principal(
        &self,
        assertion: PrincipalAssertion,
        include_archived: bool,
    ) -> Result<usize, RuntimeError> {
        let principal = self.ensure_principal(assertion).await?;
        self.inner
            .store
            .bind_unbound_sessions_to_principal(&principal.id, include_archived)
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

    /// Active model reasoning profile used by subsequent evaluations. The
    /// Runtime itself is storage-agnostic; embedding surfaces may persist a
    /// change before applying it here.
    pub fn reasoning_effort(&self) -> Option<ReasoningEffort> {
        self.inner.client.reasoning_effort()
    }

    /// Effective level sent to the selected route after applying the native
    /// vocabulary of every physical candidate. This keeps old provider-neutral
    /// settings readable without presenting a compatibility alias as a second
    /// model capability in the Dashboard.
    pub fn effective_reasoning_effort(&self) -> Option<ReasoningEffort> {
        let configured = self.reasoning_effort()?;
        let config = self.provider_catalog_config().ok()?;
        let catalog = EffectiveProviderCatalog::from_config(&config).ok()?;
        let model = self.model();
        let Ok((_, route)) = catalog.resolve_route(&model) else {
            return Some(configured);
        };
        let mut effective = route.candidates.iter().filter_map(|candidate| {
            let provider = catalog.provider_instances.get(&candidate.provider)?;
            Some(normalize_reasoning_effort_for_model(
                provider.adapter.as_str(),
                candidate.model.as_str(),
                Some(configured),
            ))
        });
        let first = effective.next().unwrap_or(Some(configured));
        if effective.all(|candidate| candidate == first) {
            first
        } else {
            None
        }
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
        if let Ok(config) = self.provider_catalog_config() {
            models.extend(config.model_routes.keys().cloned());
        }
        models.sort();
        models.dedup();
        models
    }

    /// Build the conversation model selector from explicit operator
    /// enablement. Remote discovery is used to validate new selections, but
    /// it is observational cache data and must not make an already enabled
    /// model disappear after a database move, restart, or failed refresh.
    /// Model Route IDs remain control values, but are never exposed as if they
    /// were physical model names.
    pub async fn inference_model_options(&self) -> Result<Vec<InferenceModelOption>, RuntimeError> {
        let config = self.provider_catalog_config()?;
        let snapshot = self.provider_control_snapshot().await?;
        let routed_names = config
            .model_routes
            .iter()
            .flat_map(|(route_id, route)| {
                std::iter::once(route_id.as_str()).chain(route.aliases.iter().map(String::as_str))
            })
            .collect::<HashSet<_>>();
        let mut options = Vec::new();

        for (route_id, route) in &snapshot.model_routes {
            let available_candidates = route
                .candidates
                .iter()
                .filter_map(|candidate| {
                    let provider = snapshot.provider_instances.get(&candidate.provider)?;
                    let account_available = |account_id: &str| {
                        snapshot
                            .auth_accounts
                            .get(account_id)
                            .is_some_and(|account| {
                                account.effective_enabled
                                    && (!account.oauth || account.authenticated)
                            })
                    };
                    let available = match candidate.account.as_deref() {
                        Some(account_id) => account_available(account_id),
                        None => provider
                            .accounts
                            .iter()
                            .any(|account_id| account_available(account_id)),
                    };
                    available.then_some((candidate, provider))
                })
                .collect::<Vec<_>>();
            let mut physical_models = available_candidates
                .iter()
                .map(|(candidate, _)| candidate.model.clone())
                .collect::<Vec<_>>();
            physical_models.sort();
            physical_models.dedup();
            if physical_models.is_empty() {
                continue;
            }
            let reasoning_capabilities = available_candidates
                .iter()
                .map(|(candidate, provider)| {
                    supported_reasoning_efforts_for_model(
                        provider.adapter.as_str(),
                        candidate.model.as_str(),
                    )
                })
                .collect::<Vec<_>>();
            let label = route
                .display_alias
                .as_deref()
                .into_iter()
                .chain(route.aliases.iter().map(String::as_str))
                .map(str::trim)
                .find(|alias| !alias.is_empty())
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| physical_models.join(" / "));
            options.push(InferenceModelOption {
                id: route_id.clone(),
                label,
                physical_models,
                aliases: route.aliases.clone(),
                supported_reasoning_efforts: common_supported_reasoning_efforts(
                    &reasoning_capabilities,
                ),
                source: "configured".to_string(),
            });
        }

        // Preserve direct, explicitly entered models that do not resolve to a
        // managed route. They are already physical names supplied by the
        // operator, not guessed aliases manufactured by OAuth setup.
        for model in config
            .llm
            .models
            .iter()
            .chain(std::iter::once(&config.llm.model))
            .map(|model| model.trim())
            .filter(|model| !model.is_empty() && !routed_names.contains(*model))
        {
            if options.iter().any(|option| option.id == model) {
                continue;
            }
            options.push(InferenceModelOption {
                id: model.to_string(),
                label: model.to_string(),
                physical_models: vec![model.to_string()],
                aliases: Vec::new(),
                supported_reasoning_efforts: None,
                source: "manual".to_string(),
            });
        }
        options.sort_by(|left, right| {
            left.label
                .cmp(&right.label)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(options)
    }

    pub async fn set_model(&self, model: &str) -> Result<(), RuntimeError> {
        let model = model.trim();
        if !self
            .configured_models()
            .iter()
            .any(|allowed| allowed == model)
        {
            return Err(format!("model '{model}' is not enabled; runtime switch rejected").into());
        }
        self.inner.client.set_model(model)?;
        let catalog = self.provider_catalog_config()?;
        self.inner.context_engine.set_evaluation_model_policy(
            catalog.llm.model.clone(),
            catalog.llm.allowed_evaluation_models.clone(),
        );
        let mut capacity = resolve_model_context_capacity(&catalog, model);
        if let Some(limit) = self
            .inner
            .model_prompt_token_limit_overrides
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(model)
            .copied()
        {
            capacity.prompt_token_limit = limit;
            capacity.source = "managed-provider-model-override".to_string();
        }
        *self
            .inner
            .model_context_capacity
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = capacity.clone();
        self.inner
            .model_context_capacities
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(model.to_string(), capacity);
        self.publish_model_configuration_changed("selected_model_changed")
            .await?;
        Ok(())
    }

    pub fn model_context_capacity(&self) -> ModelContextCapacity {
        self.inner
            .model_context_capacity
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub async fn set_model_prompt_token_limit(
        &self,
        model: &str,
        prompt_token_limit: usize,
    ) -> Result<(), RuntimeError> {
        let model = model.trim();
        if prompt_token_limit == 0 {
            return Err("model physical input capacity must be greater than 0".into());
        }
        if !self
            .configured_models()
            .iter()
            .any(|allowed| allowed == model)
        {
            return Err(format!("model '{model}' is not enabled; capacity update rejected").into());
        }
        self.inner
            .model_prompt_token_limit_overrides
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(model.to_string(), prompt_token_limit);
        let catalog = self.provider_catalog_config()?;
        let mut model_capacity = resolve_model_context_capacity(&catalog, model);
        model_capacity.prompt_token_limit = prompt_token_limit;
        model_capacity.source = "managed-provider-model-override".to_string();
        self.inner
            .model_context_capacities
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(model.to_string(), model_capacity);
        if self.model() == model {
            let mut capacity = resolve_model_context_capacity(&catalog, model);
            capacity.prompt_token_limit = prompt_token_limit;
            capacity.source = "managed-provider-model-override".to_string();
            *self
                .inner
                .model_context_capacity
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = capacity;
        }
        self.publish_model_configuration_changed("model_prompt_token_limit_changed")
            .await?;
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

    pub async fn context_token_budget_for_session(
        &self,
        context_id: &str,
        session_id: &str,
    ) -> Result<ContextTokenBudget, RuntimeError> {
        let session = self
            .inner
            .store
            .get_session(session_id)
            .await?
            .ok_or_else(|| format!("Session '{session_id}' does not exist"))?;
        if session.context_id != context_id {
            return Err(format!(
                "Session '{session_id}' does not belong to Context '{context_id}'"
            )
            .into());
        }
        let model = session.model_alias.unwrap_or_else(|| self.model());
        self.inner
            .context_engine
            .context_token_budget_for_model(context_id, Some(&model))
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

    pub async fn context_capability_binding(
        &self,
        context_id: &str,
        capability_id: &str,
    ) -> Result<Option<ContextCapabilityBindingRecord>, RuntimeError> {
        self.inner
            .store
            .get_context_capability_binding(context_id, capability_id)
            .await
    }

    pub fn experimental_feature_statuses(
        &self,
    ) -> Result<Vec<crate::experimental::ExperimentalFeatureStatus>, RuntimeError> {
        crate::experimental::statuses(&self.inner.config.experimental.enabled)
            .map_err(|error| error.into())
    }

    pub async fn update_context_capability_binding(
        &self,
        context_id: &str,
        capability_id: &str,
        enabled: bool,
        expected_revision: u64,
    ) -> Result<ContextCapabilityBindingUpdate, RuntimeError> {
        let feature = crate::experimental::feature(capability_id)?;
        if enabled {
            crate::experimental::require_enabled(
                &self.inner.config.experimental.enabled,
                feature.name,
            )?;
        }
        let mutation = self
            .inner
            .store
            .update_context_capability_binding(context_id, feature.name, enabled, expected_revision)
            .await?;
        Ok(match mutation {
            ContextCapabilityBindingMutation::Updated(binding) => {
                ContextCapabilityBindingUpdate::Updated(binding)
            }
            ContextCapabilityBindingMutation::Conflict(binding) => {
                ContextCapabilityBindingUpdate::Conflict(binding)
            }
            ContextCapabilityBindingMutation::NotFound => ContextCapabilityBindingUpdate::NotFound,
        })
    }

    pub async fn set_reasoning_effort(
        &self,
        effort: Option<ReasoningEffort>,
    ) -> Result<(), RuntimeError> {
        self.inner
            .client
            .set_reasoning_effort(effort)
            .map_err(|error| -> RuntimeError { error.into() })?;
        self.publish_model_configuration_changed("reasoning_effort_changed")
            .await
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
        let tool = self.inner.registry.get(&command.tool_name).ok_or_else(|| {
            format!(
                "Edge Node has not registered physical tool '{}'",
                command.tool_name
            )
        })?;
        if tool.execution_class() != crate::tool::ToolExecutionClass::PhysicalJob {
            return Err(format!(
                "Edge Node rejected approval for Runtime logical tool '{}'",
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
        let tool = self.inner.registry.get(&command.tool_name).ok_or_else(|| {
            format!(
                "Edge Node has not registered physical tool '{}'",
                command.tool_name
            )
        })?;
        if tool.execution_class() != crate::tool::ToolExecutionClass::PhysicalJob {
            return Err(format!(
                "Edge Node rejected Runtime logical tool '{}'; the remote protocol accepts physical tools only",
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
            checkpoint_generation: None,
            checkpoint_due_at: None,
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
                    "Context '{id}' is the root Context of Agent '{}' and cannot be archived",
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

    pub async fn wait_for_edge_command_change(&self, timeout: std::time::Duration) {
        self.inner.store.wait_for_edge_command_change(timeout).await;
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

    pub(crate) async fn reserve_edge_background_execution(
        &self,
        node_id: &str,
        parent_job_id: &str,
        worker_id: &str,
        claim_token: &str,
        lease_seconds: u64,
        background_source: &str,
    ) -> Result<ExecutionJobRecord, RuntimeError> {
        let parent_job = self
            .inner
            .store
            .get_execution_job(parent_job_id)
            .await?
            .ok_or_else(|| format!("Parent ExecutionJob '{parent_job_id}' does not exist"))?;
        let parent = crate::tool::ToolExecutionJobContext {
            parent_job_id: parent_job.id.clone(),
            activation_id: parent_job.activation_id.clone(),
            thread_id: parent_job.thread_id.clone(),
            agent_id: parent_job.agent_id.clone(),
            context_id: parent_job.context_id.clone(),
            session_id: parent_job.session_id.clone(),
            initiating_principal_id: parent_job.initiating_principal_id.clone(),
            target_id: parent_job.target_id.clone(),
            tool_call_id: parent_job.tool_call_id.clone(),
        };
        let (task_id, _) = self
            .inner
            .background_scheduler
            .durable_task_identity(&parent)?;
        self.inner
            .background_scheduler
            .reserve_edge_execution(
                &task_id,
                &parent,
                serde_json::json!({
                    "kind": "background_exec",
                    "parent_job_id": parent_job.id,
                    "task_id": task_id,
                    "background_source": background_source,
                    "owner_kind": "edge_worker",
                    "artifact_path": format!("edge://{node_id}/{task_id}/output"),
                }),
                worker_id,
                claim_token,
                lease_seconds,
            )
            .await
    }

    pub(crate) async fn heartbeat_edge_background_execution(
        &self,
        task_id: &str,
        expected_revision: u64,
        claim_token: &str,
        lease_seconds: u64,
        side_effect_started: bool,
        progress_ref: Option<&str>,
    ) -> Result<JobReceipt, RuntimeError> {
        self.inner
            .background_scheduler
            .heartbeat_edge_execution(
                task_id,
                expected_revision,
                claim_token,
                lease_seconds,
                side_effect_started,
                progress_ref,
            )
            .await
    }

    pub(crate) async fn cancel_edge_background_execution(
        &self,
        task_id: &str,
        expected_revision: u64,
        claim_token: &str,
        reason: &str,
    ) -> Result<JobReceipt, RuntimeError> {
        self.inner
            .background_scheduler
            .cancel_edge_execution(task_id, expected_revision, claim_token, reason)
            .await
    }

    pub(crate) async fn finish_edge_background_execution(
        &self,
        task_id: &str,
        claim_token: &str,
        exit_code: i32,
        output: &str,
        residual_note: &str,
    ) -> Result<bool, RuntimeError> {
        self.inner
            .background_scheduler
            .finish_edge_execution(task_id, claim_token, exit_code, output, residual_note)
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
            .ok_or_else(|| format!("Session '{session_id}' does not exist"))?;
        if !self
            .verify_session_principal(session_id, principal_id)
            .await?
        {
            return Err(format!(
                "Principal '{principal_id}' is not a participant in Session '{session_id}'"
            )
            .into());
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
            .ok_or("Artifact Transfer request must be a JSON object")?
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
            // A staged transfer can be retried safely before publication. Once
            // the persisted publication boundary is crossed, restart must
            // inspect reality rather than replaying the transfer blindly.
            retry_safety: crate::memory::ExecutionRetrySafety::ReconcileRequired,
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
                tracing::error!(event_code = "runtime.artifact_transfer.worker_failed", job_id, %error, "Artifact Transfer worker failed");
            }
        });
    }

    // The transition command keeps every fenced lifecycle coordinate explicit at the Kernel edge.
    #[allow(clippy::too_many_arguments)]
    async fn transition_thread_activation(
        &self,
        activation: &crate::memory::ThreadActivationRecord,
        status: ThreadActivationStatus,
        claimed_by: Option<String>,
        lease_expires_at: Option<chrono::DateTime<chrono::Utc>>,
        context_snapshot_version: Option<u64>,
        causation_id: &str,
        actor: &str,
    ) -> Result<crate::memory::ThreadActivationMutation, RuntimeError> {
        match self
            .inner
            .scheduler_kernel
            .execute(
                crate::controllers::DialogueController::transition_activation(
                    activation,
                    status,
                    claimed_by,
                    lease_expires_at,
                    context_snapshot_version,
                    causation_id,
                    actor,
                ),
            )
            .await?
        {
            crate::scheduler::KernelResult::ActivationTransitioned(mutation) => Ok(mutation),
            _ => Err("Scheduler Kernel returned an invalid Activation transition result".into()),
        }
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
            return Err(
                format!("Artifact Transfer Job '{job_id}' is missing an Activation").into(),
            );
        };
        if initial_activation.status == ThreadActivationStatus::Queued {
            match self
                .transition_thread_activation(
                    &initial_activation,
                    ThreadActivationStatus::Running,
                    Some("morphz-artifact-transfer".to_string()),
                    Some(
                        chrono::Utc::now()
                            + chrono::Duration::seconds(ARTIFACT_TRANSFER_WORKER_LEASE_SECS),
                    ),
                    None,
                    job_id,
                    "ArtifactTransfer",
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
            self.inner.runtime_instance_id,
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
            .ok_or("Runtime has not registered a transfer tool")?;
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
                                    tracing::warn!(event_code = "runtime.artifact_transfer.final_progress_persist_failed", job_id = %job.id, %error, "Failed to persist final Artifact Transfer progress");
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
                            break Err(
                                "Artifact Transfer Job disappeared before its publication boundary"
                                    .into(),
                            );
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
                                    "Artifact Transfer publication boundary revision conflict (current r{} / {})",
                                    current.revision,
                                    current.status.as_str()
                                ).into());
                            }
                            JobReceipt::Rejected { reason, .. } => break Err(reason.into()),
                            JobReceipt::NotFound { .. } => {
                                break Err(
                                    "Artifact Transfer Job disappeared before its publication boundary"
                                        .into(),
                                );
                            }
                        }
                        let _ = acknowledge.send(());
                    }
                    _ = control_tick.tick() => {
                        let Some(current) = self.inner.store.get_execution_job(job_id).await? else {
                            break Err("Artifact Transfer Job disappeared during execution".into());
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
                                    tracing::warn!(event_code = "runtime.artifact_transfer.progress_persist_failed", job_id = %job.id, %error, "Failed to persist Artifact Transfer progress");
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
            Ok(result) => ("success", result.text, None),
            Err(error) => {
                let cancelled = crate::artifact::is_artifact_transfer_cancelled(error.as_ref());
                let message = error.to_string();
                if cancelled {
                    (
                        "cancelled",
                        format!("Artifact Transfer was cancelled: {message}"),
                        Some(message),
                    )
                } else {
                    (
                        "failed",
                        format!("Artifact Transfer execution failed: {message}"),
                        Some(message),
                    )
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
                "Artifact Transfer Job '{}' terminal commit revision conflict (current r{} / {})",
                current.id,
                current.revision,
                current.status.as_str()
            )
                .into())
            }
            JobReceipt::Rejected { reason, .. } => return Err(reason.into()),
            JobReceipt::NotFound { .. } => {
                return Err("Artifact Transfer Job disappeared".into());
            }
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
                .transition_thread_activation(
                    &activation,
                    activation_status,
                    None,
                    None,
                    activation.context_snapshot_version,
                    result_event_id,
                    "ArtifactTransfer",
                )
                .await
            {
                tracing::warn!(event_code = "runtime.artifact_transfer.activation_projection_finalize_failed", job_id = %job.id, %error, "Failed to finalize the Artifact Transfer Activation projection");
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
                tracing::warn!(event_code = "runtime.artifact_transfer.thread_projection_finalize_failed", job_id = %job.id, %error, "Failed to finalize the Artifact Transfer Thread projection");
            }
        }
    }

    async fn reconcile_artifact_transfer_scheduler_projections(
        &self,
    ) -> Result<usize, RuntimeError> {
        // Recovery cost follows live scheduler authority, never lifetime
        // Transfer history. An open transfer Thread owns the deterministic
        // Job ID directly; the activation scan covers the narrow partial
        // state where a Thread was terminalized before its Activation.
        let mut candidate_job_ids = HashSet::new();
        for context in self.inner.store.list_contexts(false).await? {
            for thread in self
                .inner
                .store
                .list_context_threads(&context.id, false)
                .await?
            {
                if thread.executor_kind == ARTIFACT_TRANSFER_EXECUTOR_KIND {
                    let job_id = thread.executor_id.as_deref().ok_or_else(|| {
                        format!(
                            "open Artifact Transfer Thread '{}' is missing an Execution Job identity",
                            thread.id
                        )
                    })?;
                    candidate_job_ids.insert(job_id.to_string());
                }
            }
            for activation in self
                .inner
                .store
                .list_context_thread_activations(&context.id, false)
                .await?
            {
                let Some(thread) = self
                    .inner
                    .store
                    .get_thread_by_root(&activation.root_turn_id)
                    .await?
                else {
                    continue;
                };
                if thread.executor_kind == ARTIFACT_TRANSFER_EXECUTOR_KIND {
                    let job_id = thread.executor_id.as_deref().ok_or_else(|| {
                        format!(
                            "Thread '{}' of Artifact Transfer Activation '{}' is missing an Execution Job identity",
                            thread.id, activation.id
                        )
                    })?;
                    candidate_job_ids.insert(job_id.to_string());
                }
            }
        }
        let mut candidate_job_ids = candidate_job_ids.into_iter().collect::<Vec<_>>();
        candidate_job_ids.sort();
        let mut repaired = 0usize;
        for job_id in candidate_job_ids {
            let job = self
                .inner
                .store
                .get_execution_job(&job_id)
                .await?
                .ok_or_else(|| {
                    format!(
                        "Artifact Transfer scheduler projection references missing Job '{job_id}'"
                    )
                })?;
            if job.tool_name != ARTIFACT_TRANSFER_TOOL_NAME {
                return Err(format!(
                    "Artifact Transfer scheduler projection references Job '{}' with tool '{}'",
                    job.id, job.tool_name
                )
                .into());
            }
            if !job.status.is_terminal() {
                continue;
            }
            let activation_open = self
                .inner
                .store
                .get_thread_activation(&job.activation_id)
                .await?
                .is_some_and(|activation| !activation.status.is_terminal());
            let thread_open = self
                .inner
                .store
                .get_thread(&job.thread_id)
                .await?
                .is_some_and(|thread| !thread.lifecycle.is_terminal());
            if !activation_open && !thread_open {
                continue;
            }
            let result_event_id = job.result_event_id.as_deref().ok_or_else(|| {
                format!(
                    "terminal Artifact Transfer Job '{}' is missing result_event_id",
                    job.id
                )
            })?;
            let result = self
                .inner
                .store
                .query(QueryFilter {
                    event_id: Some(result_event_id.to_string()),
                    context_id: Some(job.context_id.clone()),
                    top_k: Some(1),
                    ..Default::default()
                })
                .await?
                .into_iter()
                .next()
                .ok_or_else(|| {
                    format!(
                        "result Event '{}' for terminal Artifact Transfer Job '{}' does not exist",
                        result_event_id, job.id
                    )
                })?;
            let text = result
                .payload
                .get("text")
                .and_then(serde_json::Value::as_str)
                .or(job.error.as_deref())
                .unwrap_or("Artifact Transfer is terminal")
                .to_string();
            let (activation_status, lifecycle) = match job.status {
                ExecutionJobStatus::Succeeded => (
                    ThreadActivationStatus::Succeeded,
                    ThreadLifecycle::Completed,
                ),
                ExecutionJobStatus::Cancelled => (
                    ThreadActivationStatus::Cancelled,
                    ThreadLifecycle::Cancelled,
                ),
                ExecutionJobStatus::Failed | ExecutionJobStatus::Lost => {
                    (ThreadActivationStatus::Failed, ThreadLifecycle::Failed)
                }
                _ => continue,
            };
            self.close_artifact_transfer_scheduler_projection(
                &job,
                activation_status,
                lifecycle,
                &text,
                result_event_id,
            )
            .await;
            repaired = repaired.saturating_add(1);
        }
        if repaired > 0 {
            tracing::info!(
                repaired,
                event_code = "runtime.artifact_transfer.scheduler_projection_recovered",
                "Recovered terminal Artifact Transfer scheduler projections from durable Job results"
            );
        }
        Ok(repaired)
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
        let previous = self.inner.store.get_session(id).await?;
        let updated = self.inner.store.update_session(id, update).await?;
        if let (Some(previous), Some(current)) = (previous.as_ref(), updated.as_ref()) {
            self.inner
                .permissions
                .set_session_sandbox_mode(&current.id, current.sandbox_mode);
            if previous.model_alias != current.model_alias
                || previous.reasoning_effort != current.reasoning_effort
            {
                self.publish_session_evaluation_policy_changed(previous, current)
                    .await?;
            }
            if previous.sandbox_mode != current.sandbox_mode {
                self.publish_session_sandbox_policy_changed(previous, current)
                    .await?;
            }
        }
        Ok(updated)
    }

    pub async fn set_session_context_sharing(
        &self,
        id: &str,
        sharing: SessionContextSharing,
    ) -> Result<Option<SessionRecord>, RuntimeError> {
        self.inner
            .store
            .set_session_context_sharing(id, sharing)
            .await
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
        self.query_delegations(DelegationFilter {
            include_terminal: true,
            newest_first: true,
            limit: Some(500),
            ..Default::default()
        })
        .await
    }

    pub async fn query_delegations(
        &self,
        filter: DelegationFilter,
    ) -> Result<Vec<DelegationRecord>, RuntimeError> {
        self.inner.store.list_delegations(filter).await
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

    /// Atomically creates a schedulable Objective and its immutable
    /// initialization facts before the first Evaluation can be claimed.
    pub async fn create_objective_with_initial_events(
        &self,
        objective: NewObjective,
        events: Vec<Event>,
    ) -> Result<ObjectiveRecord, RuntimeError> {
        self.inner
            .objective_supervisor
            .create_with_initial_events(objective, events)
            .await
    }

    /// Atomically creates a schedulable Objective and binds one exact Harness
    /// package before its first Evaluation can be claimed.
    pub async fn create_objective_with_harness(
        &self,
        objective: NewObjective,
        harness_id: &str,
        harness_version: &str,
    ) -> Result<(ObjectiveRecord, HarnessBinding), RuntimeError> {
        self.create_objective_with_harness_and_initial_events(
            objective,
            harness_id,
            harness_version,
            Vec::new(),
        )
        .await
    }

    /// Atomically creates an Objective, caller-supplied initialization facts,
    /// and the exact Harness binding used by every Evaluation.
    pub async fn create_objective_with_harness_and_initial_events(
        &self,
        objective: NewObjective,
        harness_id: &str,
        harness_version: &str,
        mut events: Vec<Event>,
    ) -> Result<(ObjectiveRecord, HarnessBinding), RuntimeError> {
        let harness = self
            .inner
            .harness_registry
            .get(harness_id, harness_version)
            .ok_or_else(|| format!("Harness '{harness_id}@{harness_version}' is not registered"))?;
        let (binding, event) = objective_harness_binding_event(
            &objective.context_id,
            &objective.id,
            harness.as_ref(),
        )?;
        events.push(event);
        let created = self
            .inner
            .objective_supervisor
            .create_with_initial_events(objective, events)
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
            .ok_or_else(|| format!("Objective '{objective_id}' does not exist"))?;
        let harness = self
            .inner
            .harness_registry
            .get(harness_id, harness_version)
            .ok_or_else(|| format!("Harness '{harness_id}@{harness_version}' is not registered"))?;
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
            .ok_or_else(|| format!("Objective '{id}' does not exist"))?;
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
            .ok_or_else(|| format!("Objective '{id}' does not exist"))?;
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
            .ok_or_else(|| format!("Objective '{id}' does not exist"))?;
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
        let root = self
            .inner
            .store
            .get_delegation(id)
            .await?
            .ok_or_else(|| format!("Delegation '{}' does not exist", id))?;
        let mut pending_sessions = vec![root.child_session_id.clone()];
        let mut selected = vec![root.clone()];
        let mut visited = std::collections::HashSet::new();
        while let Some(parent_session_id) = pending_sessions.pop() {
            let mut cursor: Option<(chrono::DateTime<chrono::Utc>, String)> = None;
            loop {
                let delegations = self
                    .inner
                    .store
                    .list_delegations(DelegationFilter {
                        parent_session_id: Some(parent_session_id.clone()),
                        include_terminal: true,
                        newest_first: true,
                        after_updated_at: cursor.as_ref().map(|(updated_at, _)| *updated_at),
                        after_id: cursor.as_ref().map(|(_, id)| id.clone()),
                        limit: Some(500),
                        ..Default::default()
                    })
                    .await?;
                if delegations.is_empty() {
                    break;
                }
                cursor = delegations
                    .last()
                    .map(|delegation| (delegation.updated_at, delegation.id.clone()));
                let page_is_full = delegations.len() == 500;
                for delegation in delegations {
                    if !visited.insert(delegation.id.clone()) {
                        continue;
                    }
                    pending_sessions.push(delegation.child_session_id.clone());
                    selected.push(delegation);
                }
                if !page_is_full {
                    break;
                }
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
            self.cancel_session_durable(
                &delegation.child_session_id,
                "Delegation tree was cancelled by its supervisor",
            )
            .await?;
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
                            "guidance": "Delegation was cancelled; continue from the current evidence or explain the cancellation to the user."
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

    /// Commit an immutable, versioned verifier fact after proving every
    /// declared Evidence reference exists in the same Context.
    pub async fn commit_trajectory_verifier_result(
        &self,
        input: crate::trajectory::CommitVerifierResult,
    ) -> Result<Event, RuntimeError> {
        for evidence_id in &input.evidence_refs {
            let exists = self
                .inner
                .store
                .query(QueryFilter {
                    event_id: Some(evidence_id.clone()),
                    context_id: Some(input.context_id.clone()),
                    top_k: Some(1),
                    ..QueryFilter::default()
                })
                .await?
                .into_iter()
                .any(|event| event.id == *evidence_id);
            if !exists {
                return Err(format!(
                    "Verifier Result Evidence '{}' does not exist in Context '{}'",
                    evidence_id, input.context_id
                )
                .into());
            }
        }
        let event = crate::trajectory::verifier_result_event(&input)?;
        self.commit_trajectory_fact(event).await
    }

    /// Commit a Reward Record as a separate interpretation of existing
    /// Outcome/Verifier facts. It never mutates the source facts.
    pub async fn commit_trajectory_reward_record(
        &self,
        input: crate::trajectory::CommitRewardRecord,
    ) -> Result<Event, RuntimeError> {
        for source_id in &input.sources {
            let source = self
                .inner
                .store
                .query(QueryFilter {
                    event_id: Some(source_id.clone()),
                    context_id: Some(input.context_id.clone()),
                    top_k: Some(1),
                    ..QueryFilter::default()
                })
                .await?
                .into_iter()
                .find(|event| event.id == *source_id)
                .ok_or_else(|| {
                    format!(
                        "Reward source '{}' does not exist in Context '{}'",
                        source_id, input.context_id
                    )
                })?;
            if !matches!(
                source.topic.as_str(),
                "runtime/trajectory/verifier_result"
                    | "runtime/yao/outcome"
                    | "runtime/trajectory/reward"
            ) {
                return Err(format!(
                    "Reward source '{}' is not an Outcome, Verifier Result, or Reward Record",
                    source_id
                )
                .into());
            }
        }
        let event = crate::trajectory::reward_record_event(&input)?;
        self.commit_trajectory_fact(event).await
    }

    async fn commit_trajectory_fact(&self, event: Event) -> Result<Event, RuntimeError> {
        if let Some(existing) = self
            .inner
            .store
            .query(QueryFilter {
                event_id: Some(event.id.clone()),
                context_id: event
                    .payload
                    .get("context_id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                top_k: Some(1),
                ..QueryFilter::default()
            })
            .await?
            .into_iter()
            .next()
        {
            if existing.actor != event.actor
                || existing.event_type != event.event_type
                || existing.topic != event.topic
                || existing.payload != event.payload
            {
                return Err(format!(
                    "Trajectory fact identity '{}' is occupied by different content",
                    event.id
                )
                .into());
            }
            return Ok(existing);
        }
        self.inner.store.append(event.clone()).await?;
        self.inner.bus.dispatch_persisted(event.clone()).await?;
        Ok(self
            .inner
            .store
            .query(QueryFilter {
                event_id: Some(event.id.clone()),
                top_k: Some(1),
                ..QueryFilter::default()
            })
            .await?
            .into_iter()
            .next()
            .unwrap_or(event))
    }

    pub async fn publish(&self, event: Event) -> Result<(), RuntimeError> {
        self.inner.bus.publish(event).await
    }

    /// Subscribe to process-local EventBus delivery.
    ///
    /// This is a live notification surface, not a durable request/reply
    /// protocol. In particular, exact-topic subscriptions are asynchronous
    /// business handlers and may still be queued when the publishing call
    /// returns. Callers waiting for the terminal reply of one DialogueTurn
    /// must use [`Self::wait_for_turn_reply`], which closes the durable
    /// commit/subscription race and fences the result by root turn.
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

    /// Wait for the durable Assistant reply belonging to exactly one
    /// DialogueTurn.
    ///
    /// The observer is installed before the indexed durable lookup. A reply
    /// committed before registration is therefore found in the Event Store;
    /// a reply committed after the lookup crosses the synchronous wildcard
    /// observation boundary. The live EventBus remains only a low-latency
    /// wakeup: the immutable Event Store is the completion authority.
    pub async fn wait_for_turn_reply(
        &self,
        session_id: &str,
        root_turn_id: &str,
        timeout: std::time::Duration,
    ) -> Result<Event, RuntimeError> {
        let session_id = session_id.trim();
        let root_turn_id = root_turn_id.trim();
        if session_id.is_empty() || root_turn_id.is_empty() {
            return Err("session_id and root_turn_id must not be empty".into());
        }

        // `*` observers are dispatched synchronously after the persistence
        // boundary and do not compete for an asynchronous business-handler
        // permit. Runtime model-stream drafts use try_send and may be dropped;
        // durable facts retain backpressure until this active waiter drains
        // them. Register before querying so commit-before-wait has no gap.
        let mut events = self.subscribe("*", 64);
        if let Some(reply) = self
            .query_events(QueryFilter {
                session_id: Some(session_id.to_string()),
                root_turn_id: Some(root_turn_id.to_string()),
                topic: Some("chat/reply".to_string()),
                latest_k: Some(1),
                ..QueryFilter::default()
            })
            .await?
            .into_iter()
            .find(|event| reply_matches_turn(event, session_id, root_turn_id))
        {
            return Ok(reply);
        }

        tokio::time::timeout(timeout, async {
            loop {
                let event = events
                    .recv()
                    .await
                    .ok_or("Runtime Event stream closed before the DialogueTurn reply")?;
                if reply_matches_turn(&event, session_id, root_turn_id) {
                    return Ok::<Event, RuntimeError>(event);
                }
            }
        })
        .await
        .map_err(|_| -> RuntimeError {
            format!(
                "DialogueTurn '{}' in Session '{}' did not produce a reply within {:?}",
                root_turn_id, session_id, timeout
            )
            .into()
        })?
    }

    /// Enable one process-local diagnostic projection for the lifetime of an
    /// external observer. This does not persist configuration or Event data.
    pub fn request_ephemeral_observation(
        &self,
        observer_id: impl Into<String>,
        topic: impl Into<String>,
        scope_id: impl Into<String>,
    ) {
        self.inner
            .bus
            .request_ephemeral_observation(observer_id, topic, scope_id);
    }

    pub fn clear_ephemeral_observations(&self, observer_id: &str) {
        self.inner.bus.clear_ephemeral_observations(observer_id);
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
                tracing::error!(event_code = "runtime.approvals.list_persistent_failed", %error, "Failed to read persistent pending approvals; falling back to the in-process view");
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
                    event_code = "runtime.approval.activation_missing",
                    "Pending approval request is missing its causal Activation"
                );
                continue;
            };
            let Ok(action) =
                serde_json::from_value::<crate::approval::ApprovalAction>(record.action.clone())
            else {
                tracing::error!(event_code = "runtime.approval.action_decode_failed", approval_id = %record.id, "Failed to decode the pending approval action");
                continue;
            };
            let Ok(requested) = serde_json::from_value::<crate::approval::CapabilityDelta>(
                record.requested.clone(),
            ) else {
                tracing::error!(event_code = "runtime.approval.capability_delta_decode_failed", approval_id = %record.id, "Failed to decode the pending approval capability delta");
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
            .ok_or_else(|| format!("Approval request '{approval_id}' does not exist"))?;
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
                    return Err("Runtime has disabled Capability Leases".to_string());
                }
                let job = self
                    .inner
                    .store
                    .get_execution_job(&current.job_id)
                    .await
                    .map_err(|error| error.to_string())?
                    .ok_or_else(|| {
                        format!("Approval '{}' is missing an Execution Job", current.id)
                    })?;
                if job.initiating_principal_id.is_none() {
                    return Err(
                        "a Capability Lease cannot be approved without an authoritative Principal"
                            .to_string(),
                    );
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
                return Err(
                    "a human approval decision must be allow_once, allow_lease, or deny"
                        .to_string(),
                );
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
                    "Approval '{}' was rejected while committing the decision (r{} / {}): {reason}",
                    current.id,
                    current.revision,
                    current.status.as_str()
                ));
            }
            ApprovalMutation::NotFound => {
                return Err(format!(
                    "Approval request '{approval_id}' no longer exists at submission time"
                ));
            }
            ApprovalMutation::Created(_) => {
                return Err("approval decision returned an impossible Created state".to_string());
            }
        };
        if commit.event_created {
            let event = commit.event.ok_or_else(|| {
                "Approval audit Event was created atomically, but the Store did not return its persisted projection"
                    .to_string()
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
            tracing::warn!(event_code = "runtime.approval.waiter_closed", approval_id, %error, "Approval was persisted after its in-process waiter had closed");
        }
        Ok(())
    }

    pub fn cancel_session(&self, session_id: &str) -> bool {
        self.inner.orchestrator.cancel_session(session_id)
    }

    /// Persistently cancel every open Thread in one Session. The legacy
    /// process-local cancellation signal is still sent for low latency, while
    /// Thread/Activation state is the cross-Runtime authority observed by the
    /// actual owner process.
    pub async fn cancel_session_durable(
        &self,
        session_id: &str,
        reason: &str,
    ) -> Result<usize, RuntimeError> {
        self.inner.orchestrator.cancel_session(session_id);
        let Some(session) = self.inner.store.get_session(session_id).await? else {
            return Ok(0);
        };
        let threads = self
            .inner
            .store
            .list_context_threads(&session.context_id, false)
            .await?
            .into_iter()
            .filter(|thread| thread.session_id == session_id)
            .collect::<Vec<_>>();
        let mut cancelled = 0usize;
        for mut current in threads {
            for _ in 0..8 {
                if current.lifecycle.is_terminal() {
                    break;
                }
                match self
                    .control_thread(
                        &session.context_id,
                        &current.id,
                        current.revision,
                        ThreadControlAction::Cancel,
                        reason,
                    )
                    .await?
                {
                    ThreadMutation::Updated(_) => {
                        cancelled = cancelled.saturating_add(1);
                        break;
                    }
                    ThreadMutation::Conflict { current: changed }
                        if !changed.lifecycle.is_terminal() =>
                    {
                        current = changed;
                    }
                    ThreadMutation::Conflict { .. } | ThreadMutation::NotFound => break,
                }
            }
        }
        Ok(cancelled)
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
            .ok_or_else(|| format!("Session '{}' does not exist", session_id))?;
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
            .ok_or_else(|| format!("Session '{}' does not exist", session_id))?;
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
            .ok_or_else(|| format!("Session '{}' does not exist", session_id).into())
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
            .ok_or_else(|| format!("Context '{context_id}' does not exist"))?;
        let include_terminal = query.include_terminal;
        let limit = query.limit.clamp(1, 2_000);
        let detail_fetch_limit = limit.saturating_add(1);
        let count_at = chrono::Utc::now();
        let (
            exact_open_threads,
            exact_activation_counts,
            exact_job_counts,
            exact_pending_approvals,
            exact_active_schedules,
            exact_objective_counts,
            exact_active_thread_groups,
        ) = tokio::try_join!(
            self.inner.store.count_context_open_threads(context_id),
            self.inner
                .store
                .count_context_activation_authority(context_id),
            self.inner
                .store
                .count_context_active_execution_jobs(context_id),
            self.inner.store.count_context_pending_approvals(context_id),
            self.inner.store.count_context_active_schedules(context_id),
            self.inner
                .store
                .count_context_objective_readiness(context_id, count_at),
            self.inner
                .store
                .count_context_active_thread_groups(context_id),
        )?;
        let mut sessions = self
            .inner
            .store
            .list_context_sessions_bounded(&[context_id.to_string()], true, detail_fetch_limit)
            .await?;
        let has_more_sessions = sessions.len() > limit;
        sessions.truncate(limit);
        let mut authority_objectives = self
            .inner
            .store
            .list_context_objectives_bounded(context_id, include_terminal, detail_fetch_limit)
            .await?;
        let has_more_objectives =
            authority_objectives.len() > limit || exact_objective_counts.live_objectives > limit;
        authority_objectives.truncate(limit);
        authority_objectives.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        let mut context_threads = self
            .inner
            .store
            .list_context_threads_bounded(context_id, false, detail_fetch_limit)
            .await?;
        let mut has_more_threads = context_threads.len() > limit || exact_open_threads > limit;
        context_threads.truncate(limit);
        if include_terminal {
            let active_ids = context_threads
                .iter()
                .map(|thread| thread.id.clone())
                .collect::<HashSet<_>>();
            context_threads.extend(
                self.inner
                    .store
                    .list_recent_terminal_threads(context_id, limit)
                    .await?
                    .into_iter()
                    .filter(|thread| !active_ids.contains(&thread.id)),
            );
        }
        context_threads.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        if context_threads.len() > limit {
            has_more_threads = true;
            context_threads.truncate(limit);
        }
        let authority_threads = context_threads.clone();
        let all_context_thread_ids = context_threads
            .iter()
            .map(|thread| thread.id.clone())
            .collect::<HashSet<_>>();
        let mut all_threads = context_threads;
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

        // Page the root aggregate first. Child history then follows those
        // selected Thread roots instead of using an independent Activation
        // page which would require hundreds of point lookups to repair parent
        // edges. Live orphan candidates are merged separately so operator
        // attention remains complete.
        let root_turn_ids = all_threads
            .iter()
            .map(|thread| thread.root_turn_id.clone())
            .collect::<Vec<_>>();
        let mut all_context_activations = self
            .inner
            .store
            .list_scheduler_thread_activations_by_roots(
                context_id,
                &root_turn_ids,
                SCHEDULER_TERMINAL_ACTIVATIONS_PER_THREAD,
            )
            .await?;
        let aggregate_activation_ids = all_context_activations
            .iter()
            .map(|activation| activation.id.clone())
            .collect::<HashSet<_>>();
        let active_activation_count = exact_activation_counts
            .queued_activations
            .saturating_add(exact_activation_counts.running_activations);
        let active_activation_candidates = self
            .inner
            .store
            .list_active_thread_activations_for_contexts(
                &[context_id.to_string()],
                detail_fetch_limit,
            )
            .await?;
        let has_more_activations =
            active_activation_candidates.len() > limit || active_activation_count > limit;
        let candidate_parent_roots = active_activation_candidates
            .iter()
            .filter(|activation| !aggregate_activation_ids.contains(&activation.id))
            .map(|activation| activation.root_turn_id.clone())
            .collect::<Vec<_>>();
        let existing_candidate_roots = self
            .inner
            .store
            .list_threads_by_roots(context_id, &candidate_parent_roots)
            .await?
            .into_iter()
            .filter(|thread| !thread.lifecycle.is_terminal())
            .map(|thread| thread.root_turn_id)
            .collect::<HashSet<_>>();
        // Only broken live routes are merged outside the bounded Thread root
        // page. Healthy Activations belonging to a displaced Thread remain
        // represented by exact summary counts and are loaded through focused
        // Thread detail, avoiding false orphan diagnostics.
        all_context_activations.extend(active_activation_candidates.into_iter().filter(
            |activation| {
                !aggregate_activation_ids.contains(&activation.id)
                    && !existing_candidate_roots.contains(&activation.root_turn_id)
            },
        ));
        if !include_terminal {
            all_context_activations.retain(|activation| !activation.status.is_terminal());
        }
        let mut sorted_activations = all_context_activations.clone();
        sorted_activations.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        let mut activations = sorted_activations;
        activations.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });

        let selected_thread_ids = thread_ids.iter().cloned().collect::<Vec<_>>();
        let mut all_signals = self
            .inner
            .store
            .list_context_thread_signals_bounded(
                context_id,
                Some(ThreadSignalStatus::Pending),
                detail_fetch_limit,
            )
            .await?;
        let has_more_signals =
            all_signals.len() > limit || exact_activation_counts.pending_signals > limit;
        all_signals.truncate(limit);
        all_signals.sort_by(|left, right| {
            left.sequence
                .cmp(&right.sequence)
                .then_with(|| left.id.cmp(&right.id))
        });

        let activation_ids = activations
            .iter()
            .map(|activation| activation.id.clone())
            .collect::<HashSet<_>>();
        let activation_id_list = activation_ids.iter().cloned().collect::<Vec<_>>();
        let mut jobs = self
            .inner
            .store
            .list_execution_jobs_for_activations(context_id, &activation_id_list)
            .await?;
        if !include_terminal {
            jobs.retain(|job| !job.status.is_terminal());
        }
        let aggregate_job_ids = jobs
            .iter()
            .map(|job| job.id.clone())
            .collect::<HashSet<_>>();
        let live_job_candidates = self
            .inner
            .store
            .list_execution_jobs(ExecutionJobFilter {
                context_id: Some(context_id.to_string()),
                include_terminal: false,
                newest_first: true,
                limit: Some(detail_fetch_limit),
                ..ExecutionJobFilter::default()
            })
            .await?;
        let has_more_jobs =
            live_job_candidates.len() > limit || exact_job_counts.active_jobs > limit;
        let displaced_job_activation_ids = live_job_candidates
            .iter()
            .filter(|job| {
                !aggregate_job_ids.contains(&job.id) && !activation_ids.contains(&job.activation_id)
            })
            .map(|job| job.activation_id.clone())
            .collect::<Vec<_>>();
        let valid_displaced_job_activations = self
            .inner
            .store
            .list_thread_activations_by_ids(context_id, &displaced_job_activation_ids)
            .await?
            .into_iter()
            .filter(|activation| !activation.status.is_terminal())
            .map(|activation| activation.id)
            .collect::<HashSet<_>>();
        let valid_displaced_job_ids = live_job_candidates
            .iter()
            .filter(|job| {
                !activation_ids.contains(&job.activation_id)
                    && valid_displaced_job_activations.contains(&job.activation_id)
            })
            .map(|job| job.id.clone())
            .collect::<HashSet<_>>();
        jobs.extend(live_job_candidates.into_iter().filter(|job| {
            !aggregate_job_ids.contains(&job.id)
                && (activation_ids.contains(&job.activation_id)
                    || !valid_displaced_job_activations.contains(&job.activation_id))
        }));
        jobs.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        let job_ids = jobs.iter().map(|job| job.id.clone()).collect::<Vec<_>>();
        let live_job_ids = jobs
            .iter()
            .filter(|job| !job.status.is_terminal())
            .map(|job| job.id.clone())
            .collect::<HashSet<_>>();
        let selected_job_ids = job_ids.iter().cloned().collect::<HashSet<_>>();
        let mut approval_by_job = self
            .inner
            .store
            .list_job_approvals(context_id, &job_ids)
            .await?
            .into_iter()
            .map(|approval| (approval.job_id.clone(), approval))
            .collect::<HashMap<_, _>>();
        let mut orphan_approvals = Vec::new();
        let pending_approval_candidates = self
            .inner
            .store
            .list_context_pending_approvals_bounded(context_id, detail_fetch_limit)
            .await?;
        let has_more_approvals =
            pending_approval_candidates.len() > limit || exact_pending_approvals > limit;
        for approval in pending_approval_candidates.into_iter().take(limit) {
            if !live_job_ids.contains(&approval.job_id)
                && !valid_displaced_job_ids.contains(&approval.job_id)
            {
                orphan_approvals.push(approval.clone());
            }
            if selected_job_ids.contains(&approval.job_id) {
                // A live pending request is the authoritative Approval view
                // even if the selected aggregate also contains older decided
                // history for the same Job.
                approval_by_job.insert(approval.job_id.clone(), approval);
            }
        }

        let mut jobs_by_activation = HashMap::<String, Vec<SchedulerJobSnapshot>>::new();
        let mut orphan_jobs = Vec::new();
        for job in jobs {
            let snapshot = crate::scheduler::job_snapshot(job, &mut approval_by_job);
            if activation_ids.contains(&snapshot.job.activation_id) {
                jobs_by_activation
                    .entry(snapshot.job.activation_id.clone())
                    .or_default()
                    .push(snapshot);
            } else {
                // Only live Jobs can arrive outside the selected aggregate;
                // every live Activation was merged above, so this is a true
                // missing durable parent rather than independent pagination.
                orphan_jobs.push(snapshot);
            }
        }

        let mut activations_by_thread = HashMap::<String, Vec<SchedulerActivationSnapshot>>::new();
        let mut orphan_activations = Vec::new();
        let mut signals_by_activation = HashMap::<String, Vec<ThreadSignalRecord>>::new();
        for (activation_id, signal) in self
            .inner
            .store
            .list_activation_signals_for_activations(&activation_id_list)
            .await?
        {
            signals_by_activation
                .entry(activation_id)
                .or_default()
                .push(signal);
        }
        for activation in activations {
            let signals = signals_by_activation
                .remove(&activation.id)
                .unwrap_or_default();
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
            } else {
                // Every live Thread and every selected historical root is in
                // `thread_by_root`; absence now means a true broken edge.
                orphan_activations.push(snapshot);
            }
        }
        orphan_jobs.extend(jobs_by_activation.into_values().flatten());

        let mut pending_signals_by_thread = HashMap::<String, Vec<ThreadSignalRecord>>::new();
        let mut orphan_signals = Vec::new();
        let nonselected_signal_thread_ids = all_signals
            .iter()
            .filter(|signal| !thread_ids.contains(&signal.thread_id))
            .map(|signal| signal.thread_id.clone())
            .collect::<Vec<_>>();
        let live_nonselected_signal_threads = self
            .inner
            .store
            .list_threads_by_ids(context_id, &nonselected_signal_thread_ids)
            .await?
            .into_iter()
            .filter(|thread| !thread.lifecycle.is_terminal())
            .map(|thread| thread.id)
            .collect::<HashSet<_>>();
        for signal in all_signals {
            if thread_ids.contains(&signal.thread_id) {
                pending_signals_by_thread
                    .entry(signal.thread_id.clone())
                    .or_default()
                    .push(signal);
            } else if !live_nonselected_signal_threads.contains(&signal.thread_id) {
                orphan_signals.push(signal);
            }
        }

        let mut schedules_by_thread = HashMap::<String, Vec<ScheduleRecord>>::new();
        for schedule in self
            .inner
            .store
            .list_thread_schedules(context_id, &selected_thread_ids)
            .await?
        {
            if all_context_thread_ids.contains(&schedule.thread_id) {
                schedules_by_thread
                    .entry(schedule.thread_id.clone())
                    .or_default()
                    .push(schedule);
            }
        }

        let mut authority_groups = self
            .inner
            .store
            .list_thread_groups(ThreadGroupFilter {
                context_id: Some(context_id.to_string()),
                include_terminal: false,
                newest_first: false,
                limit: Some(detail_fetch_limit),
                ..ThreadGroupFilter::default()
            })
            .await?;
        let mut has_more_thread_groups =
            authority_groups.len() > limit || exact_active_thread_groups > limit;
        authority_groups.truncate(limit);
        if include_terminal {
            let active_ids = authority_groups
                .iter()
                .map(|group| group.id.clone())
                .collect::<HashSet<_>>();
            authority_groups.extend(
                self.inner
                    .store
                    .list_thread_groups(ThreadGroupFilter {
                        context_id: Some(context_id.to_string()),
                        include_terminal: true,
                        newest_first: true,
                        limit: Some(detail_fetch_limit),
                        ..ThreadGroupFilter::default()
                    })
                    .await?
                    .into_iter()
                    .filter(|group| !active_ids.contains(&group.id)),
            );
            authority_groups.sort_by(|left, right| {
                left.created_at
                    .cmp(&right.created_at)
                    .then_with(|| left.id.cmp(&right.id))
            });
            if authority_groups.len() > limit {
                has_more_thread_groups = true;
                authority_groups.truncate(limit);
            }
        }
        let mut authority_group_members = Vec::new();
        let mut thread_groups = Vec::new();
        let authority_group_ids = authority_groups
            .iter()
            .map(|group| group.id.clone())
            .collect::<Vec<_>>();
        let mut members_by_group = HashMap::<String, Vec<ThreadGroupMemberRecord>>::new();
        for (group_id, member) in self
            .inner
            .store
            .list_thread_group_members_for_groups(&authority_group_ids)
            .await?
        {
            members_by_group.entry(group_id).or_default().push(member);
        }
        let mut outcomes_by_group = HashMap::<String, Vec<ThreadOutcomeRecord>>::new();
        for (group_id, outcome) in self
            .inner
            .store
            .list_thread_group_outcomes_for_groups(&authority_group_ids)
            .await?
        {
            outcomes_by_group.entry(group_id).or_default().push(outcome);
        }
        for group in &authority_groups {
            let members = members_by_group.remove(&group.id).unwrap_or_default();
            authority_group_members.extend(members.iter().cloned());
            let outcomes = outcomes_by_group.remove(&group.id).unwrap_or_default();
            if thread_groups.len() < limit && (!group.status.is_terminal() || include_terminal) {
                thread_groups.push(SchedulerThreadGroupSnapshot {
                    group: group.clone(),
                    members,
                    outcomes,
                });
            }
        }

        let authority_thread_ids = authority_threads
            .iter()
            .map(|thread| thread.id.clone())
            .collect::<Vec<_>>();
        let thread_dependencies = self
            .inner
            .store
            .list_scheduler_dependencies_for_owners(
                SchedulerDependencyOwnerKind::Thread,
                &authority_thread_ids,
            )
            .await?;
        let mut dependencies_by_thread = HashMap::<String, Vec<_>>::new();
        for dependency in &thread_dependencies {
            dependencies_by_thread
                .entry(dependency.owner_id.clone())
                .or_default()
                .push(dependency.clone());
        }

        let mut outcomes_by_thread = self
            .inner
            .store
            .list_thread_outcomes(&selected_thread_ids)
            .await?
            .into_iter()
            .map(|outcome| (outcome.thread_id.clone(), outcome))
            .collect::<HashMap<_, _>>();
        let mut threads = Vec::with_capacity(all_threads.len());
        for thread in all_threads {
            let outcome = outcomes_by_thread.remove(&thread.id);
            let pending_signals = pending_signals_by_thread
                .remove(&thread.id)
                .unwrap_or_default();
            let thread_activations = activations_by_thread.remove(&thread.id).unwrap_or_default();
            let schedules = schedules_by_thread.remove(&thread.id).unwrap_or_default();
            let dependencies = dependencies_by_thread
                .remove(&thread.id)
                .unwrap_or_default();
            let phase = crate::scheduler::thread_phase(
                &thread,
                &pending_signals,
                &thread_activations,
                &schedules,
                &dependencies,
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
        orphan_approvals.extend(
            approval_by_job
                .values()
                .filter(|approval| approval.status.is_pending())
                .cloned(),
        );

        let process_admission = self.inner.orchestrator.activation_admission_snapshot();
        let process_activation_ids = process_admission
            .queued_activation_ids
            .iter()
            .chain(process_admission.in_flight_activation_ids.iter())
            .cloned()
            .collect::<Vec<_>>();
        let process_context_activations = self
            .inner
            .store
            .list_thread_activations_by_ids(context_id, &process_activation_ids)
            .await?;
        let process_context_activation_ids = process_context_activations
            .iter()
            .map(|activation| activation.id.as_str())
            .collect::<HashSet<_>>();
        let context_loaded_queued = process_admission
            .queued_activation_ids
            .iter()
            .filter(|id| process_context_activation_ids.contains(id.as_str()))
            .count();
        let context_in_flight = process_admission
            .in_flight_activation_ids
            .iter()
            .filter(|id| process_context_activation_ids.contains(id.as_str()))
            .count();
        let context_deferred = exact_activation_counts
            .queued_activations
            .saturating_sub(context_loaded_queued);
        let objective_ids = authority_objectives
            .iter()
            .map(|objective| objective.id.clone())
            .collect::<Vec<_>>();
        let mut dependencies = thread_dependencies;
        dependencies.extend(
            self.inner
                .store
                .list_scheduler_dependencies_for_owners(
                    SchedulerDependencyOwnerKind::Objective,
                    &objective_ids,
                )
                .await?,
        );
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

        let authority_outcomes = self
            .inner
            .store
            .list_thread_outcomes(&authority_thread_ids)
            .await?;
        let mut invariant_violations = audit_scheduler_invariants(SchedulerInvariantInput {
            objectives: &authority_objectives,
            threads: &authority_threads,
            activations: &all_context_activations,
            outcomes: &authority_outcomes,
            groups: &authority_groups,
            group_members: &authority_group_members,
            dependencies: &dependencies,
        });
        let requested_barrier_event_ids = authority_groups
            .iter()
            .filter_map(|group| group.barrier_event_id.as_ref())
            .cloned()
            .collect::<Vec<_>>();
        let barrier_event_ids = if requested_barrier_event_ids.is_empty() {
            HashSet::new()
        } else {
            self.inner
                .store
                .query(QueryFilter {
                    event_ids: requested_barrier_event_ids,
                    ..QueryFilter::default()
                })
                .await?
                .into_iter()
                .map(|event| event.id)
                .collect::<HashSet<_>>()
        };
        invariant_violations.extend(crate::recovery::SchedulerReconciler::audit_supervision(
            &authority_objectives,
            &authority_threads,
            &all_context_activations,
            &authority_groups,
            &barrier_event_ids,
        ));
        invariant_violations.extend(orphan_activations.iter().map(|snapshot| {
            SchedulerInvariantViolation {
                severity: SchedulerInvariantSeverity::Error,
                code: SchedulerInvariantCode::OrphanActivation,
                entity_kind: "thread_activation".to_string(),
                entity_id: snapshot.activation.id.clone(),
                detail: format!(
                    "Activation '{}' has no selected Thread for root '{}'",
                    snapshot.activation.id, snapshot.activation.root_turn_id
                ),
            }
        }));
        invariant_violations.extend(orphan_signals.iter().map(|signal| {
            SchedulerInvariantViolation {
                severity: SchedulerInvariantSeverity::Error,
                code: SchedulerInvariantCode::OrphanSignal,
                entity_kind: "thread_signal".to_string(),
                entity_id: signal.id.clone(),
                detail: format!(
                    "Pending Signal '{}' has no live Thread route '{}'",
                    signal.id, signal.thread_id
                ),
            }
        }));
        invariant_violations.extend(orphan_jobs.iter().map(|snapshot| {
            SchedulerInvariantViolation {
                severity: SchedulerInvariantSeverity::Error,
                code: SchedulerInvariantCode::OrphanExecutionJob,
                entity_kind: "execution_job".to_string(),
                entity_id: snapshot.job.id.clone(),
                detail: format!(
                    "Execution Job '{}' has no live Activation route '{}'",
                    snapshot.job.id, snapshot.job.activation_id
                ),
            }
        }));
        invariant_violations.extend(orphan_approvals.iter().map(|approval| {
            SchedulerInvariantViolation {
                severity: SchedulerInvariantSeverity::Error,
                code: SchedulerInvariantCode::OrphanApproval,
                entity_kind: "approval".to_string(),
                entity_id: approval.id.clone(),
                detail: format!(
                    "Pending Approval '{}' has no live Execution Job route '{}'",
                    approval.id, approval.job_id
                ),
            }
        }));
        invariant_violations.sort();
        invariant_violations.dedup();
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
        let summary = SchedulerSummary {
            open_threads: exact_open_threads,
            pending_signals: exact_activation_counts.pending_signals,
            queued_activations: exact_activation_counts.queued_activations,
            running_activations: exact_activation_counts.running_activations,
            active_jobs: exact_job_counts.active_jobs,
            waiting_approval_jobs: exact_job_counts.waiting_approval_jobs,
            pending_approvals: exact_pending_approvals,
            active_schedules: exact_active_schedules,
            deferred_activations: context_deferred,
            runnable_objectives: exact_objective_counts.runnable_objectives,
            waiting_objectives: exact_objective_counts.waiting_objectives,
            invariant_violations: invariant_violations.len(),
        };
        Ok(SchedulerSnapshot {
            context_id: context_id.to_string(),
            generated_at: chrono::Utc::now(),
            summary,
            detail_bounds: SchedulerDetailBounds {
                limit,
                has_more_sessions,
                has_more_objectives,
                has_more_threads,
                has_more_activations,
                has_more_signals,
                has_more_jobs,
                has_more_approvals,
                has_more_thread_groups,
            },
            admission: SchedulerAdmissionSnapshot {
                process: process_admission,
                context_durable_queued: exact_activation_counts.queued_activations,
                context_durable_running: exact_activation_counts.running_activations,
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
            orphan_approvals,
        })
    }

    /// Lists the persisted operator dispositions for a Context. Attention
    /// cases themselves stay derived from authoritative scheduler state, so a
    /// repaired source disappears automatically without mutating any persisted Event.
    pub async fn attention_acknowledgements(
        &self,
        context_id: &str,
    ) -> Result<Vec<AttentionAcknowledgement>, RuntimeError> {
        if self.inner.store.get_context(context_id).await?.is_none() {
            return Err(format!("Context '{context_id}' does not exist").into());
        }
        self.inner
            .store
            .list_attention_acknowledgements_bounded(context_id, 500)
            .await
    }

    /// Reads a bounded acknowledgement page. Once the caller has an Event
    /// sequence cursor, only projection rows advanced after that cursor are
    /// returned; this keeps Dashboard polling independent of Context age.
    pub async fn attention_acknowledgements_page(
        &self,
        context_id: &str,
        after_sequence: Option<u64>,
        limit: usize,
    ) -> Result<AttentionAcknowledgementsPage, RuntimeError> {
        if self.inner.store.get_context(context_id).await?.is_none() {
            return Err(format!("Context '{context_id}' does not exist").into());
        }
        let limit = limit.clamp(1, 500);
        let mut acknowledgements = if let Some(sequence) = after_sequence {
            self.inner
                .store
                .list_attention_acknowledgements_after(context_id, sequence, limit + 1)
                .await?
        } else {
            self.inner
                .store
                .list_attention_acknowledgements_bounded(context_id, limit + 1)
                .await?
        };
        let has_more = acknowledgements.len() > limit;
        acknowledgements.truncate(limit);
        let latest_sequence = acknowledgements
            .iter()
            .map(|record| record.event_sequence)
            .max()
            .unwrap_or_else(|| after_sequence.unwrap_or(0));
        Ok(AttentionAcknowledgementsPage {
            acknowledgements,
            latest_sequence,
            has_more,
        })
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
            return Err(format!("Context '{context_id}' does not exist").into());
        }
        let key = command.key.trim();
        let source_kind = command.source_kind.trim();
        let source_id = command.source_id.trim();
        if key.is_empty() || source_kind.is_empty() || source_id.is_empty() {
            return Err(
                "attention acknowledgement requires non-empty key, source_kind, and source_id"
                    .into(),
            );
        }
        if key.len() > 512 || source_kind.len() > 80 || source_id.len() > 256 {
            return Err("attention acknowledgement identifier exceeds the allowed length".into());
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
            event_sequence: 0,
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
        self.inner
            .store
            .get_attention_acknowledgement(context_id, key)
            .await?
            .ok_or_else(|| {
                format!(
                    "attention acknowledgement Event '{}' was committed, but its projection has not converged",
                    record.event_id
                )
                .into()
            })
    }

    /// Returns one bounded Runtime-wide command-board projection.
    ///
    /// The storage reads are deliberately bulk queries. Product surfaces must
    /// not turn a Context or Session card into a separate database round trip,
    /// nor reconstruct scheduler state from immutable Events.
    pub async fn runtime_overview(
        &self,
        query: RuntimeOverviewQuery,
    ) -> Result<RuntimeOverview, RuntimeError> {
        const DEFAULT_CONTEXT_LIMIT: usize = 40;
        const MAX_CONTEXT_LIMIT: usize = 100;
        const DEFAULT_SESSIONS_PER_CONTEXT: usize = 6;
        const MAX_SESSIONS_PER_CONTEXT: usize = 200;
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
        let mut contexts = if let Some(context_id) = query.context_id.as_deref() {
            self.inner
                .store
                .get_context(context_id)
                .await?
                .filter(|context| query.include_archived || context.status == SessionStatus::Active)
                .into_iter()
                .collect()
        } else {
            self.inner
                .store
                .list_recent_contexts(query.include_archived, requested_context_rows)
                .await?
        };
        let has_more_contexts = query.context_id.is_none() && contexts.len() > context_limit;
        if query.context_id.is_none() {
            contexts.truncate(context_limit);
        }
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
            active_execution_jobs,
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
            self.inner
                .store
                .list_open_threads_for_contexts(&context_ids, activity_limit),
            self.inner
                .store
                .list_active_thread_activations_for_contexts(&context_ids, activity_limit),
            self.inner
                .store
                .list_active_execution_jobs_for_contexts(&context_ids, activity_limit),
            self.inner
                .store
                .list_recoverable_objectives_for_contexts(&context_ids, activity_limit),
            self.inner.store.list_delegations(DelegationFilter {
                related_context_ids: context_ids.clone(),
                include_terminal: true,
                newest_first: true,
                limit: Some(activity_limit),
                ..Default::default()
            }),
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

        let mut attention_sessions_by_context: HashMap<String, HashSet<String>> = HashMap::new();
        let mut execution_jobs_by_session: HashMap<String, Vec<ExecutionJobMonitorRecord>> =
            HashMap::new();
        let mut execution_job_count_by_context: HashMap<String, usize> = HashMap::new();
        for job in active_execution_jobs
            .into_iter()
            .filter(|job| context_id_set.contains(&job.context_id))
        {
            *execution_job_count_by_context
                .entry(job.context_id.clone())
                .or_default() += 1;
            if job.status == ExecutionJobStatus::WaitingApproval {
                attention_sessions_by_context
                    .entry(job.context_id.clone())
                    .or_default()
                    .insert(job.session_id.clone());
            }
            execution_jobs_by_session
                .entry(job.session_id.clone())
                .or_default()
                .push(job);
        }
        for jobs in execution_jobs_by_session.values_mut() {
            jobs.sort_by(|left, right| {
                right
                    .updated_at
                    .cmp(&left.updated_at)
                    .then_with(|| left.id.cmp(&right.id))
            });
        }

        let mut objectives_by_session: HashMap<String, Vec<ObjectiveRecord>> = HashMap::new();
        let mut objectives_by_context: HashMap<String, usize> = HashMap::new();
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
                        | Some(ObjectiveWaitCondition::Permission { .. })
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
                    let execution_jobs = execution_jobs_by_session
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
                        execution_jobs,
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
            let active_execution_job_count = execution_job_count_by_context
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
                active_execution_job_count,
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
            active_execution_jobs: projected_contexts
                .iter()
                .map(|context| context.active_execution_job_count)
                .sum(),
            waiting: projected_contexts
                .iter()
                .flat_map(|context| &context.sessions)
                .filter(|session| {
                    matches!(
                        session.state,
                        RuntimeSessionState::Waiting | RuntimeSessionState::WaitingUser
                    )
                })
                .count(),
            queued: projected_contexts
                .iter()
                .flat_map(|context| &context.sessions)
                .filter(|session| session.state == RuntimeSessionState::Queued)
                .count(),
            paused: projected_contexts
                .iter()
                .flat_map(|context| &context.sessions)
                .filter(|session| session.state == RuntimeSessionState::Paused)
                .count(),
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
            .ok_or_else(|| format!("Context '{context_id}' does not exist"))?;
        let agent = self.inner.store.get_agent(&context.agent_id).await?;
        let objectives = self.list_context_objectives(context_id, false).await?;
        let scheduler_summary = if query.include_scheduler_summary.unwrap_or(true) {
            self.scheduler_snapshot(
                context_id,
                SchedulerQuery {
                    include_terminal: false,
                    limit: 100,
                },
            )
            .await?
            .summary
        } else {
            SchedulerSummary::default()
        };

        let view = if let Some(session_id) = query.active_session_id.as_deref() {
            let session = self
                .inner
                .store
                .get_session(session_id)
                .await?
                .ok_or_else(|| format!("Session '{session_id}' does not exist"))?;
            if session.context_id != context_id {
                return Err(format!(
                    "Session '{session_id}' does not belong to Context '{context_id}'"
                )
                .into());
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
            let attribution =
                (view.attribution.total_weight_units > 0).then(|| view.attribution.clone());
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
            scheduler: scheduler_summary,
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
            let physical_model = record
                .model_binding
                .as_ref()
                .map(|binding| binding.physical_model.as_str())
                .or(record.model.as_deref());
            record.cost = calculate_model_usage_cost(
                &self.inner.config.usage_pricing,
                physical_model,
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
            .list_thread_activations_by_root(context_id, &thread.root_turn_id)
            .await?;
        activations.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });

        let activation_ids = activations
            .iter()
            .map(|activation| activation.id.clone())
            .collect::<Vec<_>>();
        let mut jobs = self
            .inner
            .store
            .list_execution_jobs_for_activations(context_id, &activation_ids)
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
            .list_job_approvals(context_id, &job_ids.iter().cloned().collect::<Vec<_>>())
            .await?
            .into_iter()
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
        let mut signals_by_activation = HashMap::<String, Vec<ThreadSignalRecord>>::new();
        for (activation_id, signal) in self
            .inner
            .store
            .list_activation_signals_for_activations(&activation_ids)
            .await?
        {
            signals_by_activation
                .entry(activation_id)
                .or_default()
                .push(signal);
        }
        for activation in activations {
            let signals = signals_by_activation
                .remove(&activation.id)
                .unwrap_or_default();
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
            .list_context_thread_signals_for_threads(
                context_id,
                &[thread_id.to_string()],
                Some(ThreadSignalStatus::Pending),
            )
            .await?
            .into_iter()
            .filter(|signal| !claimed_signal_ids.contains(&signal.id))
            .collect::<Vec<_>>();
        pending_signals.sort_by(|left, right| {
            left.sequence
                .cmp(&right.sequence)
                .then_with(|| left.id.cmp(&right.id))
        });
        let mut schedules = self
            .inner
            .store
            .list_thread_schedules(context_id, &[thread_id.to_string()])
            .await?;
        schedules.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        let dependencies = self
            .inner
            .store
            .list_scheduler_dependencies(SchedulerDependencyFilter {
                owner_kind: Some(SchedulerDependencyOwnerKind::Thread),
                owner_id: Some(thread_id.to_string()),
                ..SchedulerDependencyFilter::default()
            })
            .await?;
        let phase = crate::scheduler::thread_phase(
            &thread,
            &pending_signals,
            &activation_snapshots,
            &schedules,
            &dependencies,
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
    /// remain durable. Cancel advances the Thread generation and cancels every
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
            _ => return Err("Scheduler Kernel returned an invalid Thread control result".into()),
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
                ThreadControlAction::Cancel => {
                    self.inner
                        .orchestrator
                        .cancel_thread_activations(&current, reason)
                        .await?;
                    self.inner
                        .orchestrator
                        .wake_terminal_thread_supervisor(&current)
                        .await?;
                }
            }
        }
        Ok(mutation)
    }

    /// Replaces the current physical generation of one logical Thread with a
    /// corrected intent. The store commits the generation fence and new
    /// mailbox Signal atomically; process-local cancellation and wakeup are
    /// merely latency optimizations over that durable fact.
    pub async fn supersede_thread(
        &self,
        context_id: &str,
        thread_id: &str,
        expected_revision: u64,
        intent: &str,
        reason: &str,
    ) -> Result<ThreadMutation, RuntimeError> {
        let intent = intent.trim();
        if intent.is_empty() {
            return Err("Thread supersede requires a non-empty corrected intent".into());
        }
        let reason = reason.trim();
        let reason = if reason.is_empty() {
            "the user revised the requirements for the current concurrent work"
        } else {
            reason
        };
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
            .execute(crate::controllers::DialogueController::supersede_thread(
                &current,
                context_id,
                intent,
                reason,
                "Runtime-Operator",
            ))
            .await?
        {
            KernelResult::ThreadControlled(mutation) => mutation,
            _ => return Err("Scheduler Kernel returned an invalid Thread supersede result".into()),
        };
        if let ThreadMutation::Updated(updated) = &mutation {
            self.inner
                .orchestrator
                .cancel_thread_activations(&current, reason)
                .await?;
            self.inner
                .orchestrator
                .wake_resumed_thread(&updated.root_turn_id)
                .await?;
        }
        Ok(mutation)
    }

    pub async fn query_event_history(
        &self,
        query: EventHistoryQuery,
    ) -> Result<EventHistoryPage, RuntimeError> {
        if self
            .inner
            .store
            .get_context(&query.context_id)
            .await?
            .is_none()
        {
            return Err(format!("Context '{}' does not exist", query.context_id).into());
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
            return Ok(EventHistoryPage {
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
            .filter(|event| event_matches_causal_scope(event, &query))
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
        Ok(EventHistoryPage {
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
            model_options: Vec::new(),
            model_catalog_error: None,
            provider: self.inner.config.llm.provider.clone(),
            reasoning_effort: self
                .effective_reasoning_effort()
                .map(|effort| effort.as_str().to_string()),
            tool_count: self.tool_names().len(),
            storage: self.inner.storage_label.clone(),
            storage_backend: self.inner.config.storage.backend,
            permission_mode: self.inner.config.permissions.mode,
            sandbox_mode: self.inner.config.permissions.sandbox_mode,
            reviewer: self.inner.config.permissions.reviewer,
            model_input: self.inner.config.model_input.clone(),
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

    pub async fn apply_context_transaction_strict(
        &self,
        context_id: &str,
        acting_session_id: &str,
        transaction: &str,
    ) -> Result<crate::orchestrator::context::ContextCommit, RuntimeError> {
        self.inner
            .context_engine
            .apply_context_transaction_strict(context_id, acting_session_id, transaction)
            .await
    }

    pub async fn apply_context_transaction_strict_with_id(
        &self,
        context_id: &str,
        acting_session_id: &str,
        transaction: &str,
        transaction_id: &str,
    ) -> Result<crate::orchestrator::context::ContextCommit, RuntimeError> {
        self.inner
            .context_engine
            .apply_context_transaction_strict_with_id(
                context_id,
                acting_session_id,
                transaction,
                transaction_id,
            )
            .await
    }
}

fn new_runtime_instance_id() -> String {
    static NEXT_INSTANCE: AtomicU64 = AtomicU64::new(0);
    let instance = NEXT_INSTANCE.fetch_add(1, Ordering::Relaxed);
    let mut random = [0_u8; 16];
    let nonce = if getrandom::fill(&mut random).is_ok() {
        random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    } else {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos().to_string())
            .unwrap_or_default()
    };
    format!("{}:{nonce}:{instance}", std::process::id())
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
    execution_jobs: &[ExecutionJobMonitorRecord],
    objectives: &[ObjectiveRecord],
    thread_by_root: &HashMap<String, ThreadRecord>,
) -> RuntimeOverviewSession {
    let running_activation_count = activations
        .iter()
        .filter(|activation| activation.status == ThreadActivationStatus::Running)
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
    let projected_objectives = objectives
        .iter()
        .map(|objective| RuntimeOverviewObjective {
            id: objective.id.clone(),
            coordinator_session_id: objective.coordinator_session_id.clone(),
            delivery_session_id: objective.delivery_session_id.clone(),
            stated_objective: objective.stated_objective.clone(),
            status: objective.status,
            state: runtime_overview_objective_state(objective),
            status_reason: objective.status_reason.clone(),
            wait_condition: objective.wait_condition.clone(),
            revision: objective.revision,
            updated_at: objective.updated_at,
        })
        .collect::<Vec<_>>();
    let projected_execution_jobs = execution_jobs
        .iter()
        .map(|job| RuntimeOverviewExecutionJob {
            id: job.id.clone(),
            activation_id: job.activation_id.clone(),
            thread_id: job.thread_id.clone(),
            status: job.status,
            tool_name: job.tool_name.clone(),
            target_id: job.target_id.clone(),
            progress_ref: job.progress_ref.clone(),
            error: job.error.clone(),
            updated_at: job.updated_at,
            checkpoint_generation: job.checkpoint_generation,
            checkpoint_due_at: job.checkpoint_due_at,
        })
        .collect::<Vec<_>>();
    let projected_threads = threads
        .iter()
        .map(|thread| {
            let thread_activations = activations
                .iter()
                .filter(|activation| activation.root_turn_id == thread.root_turn_id)
                .collect::<Vec<_>>();
            let thread_job_records = execution_jobs
                .iter()
                .filter(|job| job.thread_id == thread.id)
                .collect::<Vec<_>>();
            let thread_jobs = projected_execution_jobs
                .iter()
                .filter(|job| job.thread_id == thread.id)
                .collect::<Vec<_>>();
            let activation_statuses = thread_activations
                .iter()
                .map(|activation| activation.status)
                .collect::<Vec<_>>();
            let phase = if activation_statuses.contains(&ThreadActivationStatus::Running) {
                ThreadPhase::Running
            } else if activation_statuses.contains(&ThreadActivationStatus::Queued) {
                ThreadPhase::Runnable
            } else if thread.control_state == ThreadControlState::Paused {
                ThreadPhase::Waiting
            } else {
                ThreadPhase::Idle
            };
            RuntimeOverviewThread {
                id: thread.id.clone(),
                revision: thread.revision,
                generation: thread.generation,
                kind: thread.kind,
                lifecycle: thread.lifecycle,
                phase,
                state: runtime_overview_thread_state(
                    thread,
                    &thread_activations,
                    &thread_job_records,
                ),
                control_state: thread.control_state,
                supervision: thread.supervision.clone(),
                objective_id: (thread.supervision.supervisor_kind
                    == ThreadSupervisorKind::Objective)
                    .then(|| thread.supervision.supervisor_id.clone())
                    .flatten(),
                target_id: thread.target_id.clone(),
                activations: thread_activations
                    .into_iter()
                    .map(|activation| RuntimeOverviewActivation {
                        id: activation.id.clone(),
                        status: activation.status,
                        trigger_kind: activation.trigger_kind.clone(),
                        parent_activation_id: activation.parent_activation_id.clone(),
                        updated_at: activation.updated_at,
                    })
                    .collect(),
                execution_jobs: thread_jobs.into_iter().cloned().collect(),
                updated_at: thread.updated_at,
            }
        })
        .collect::<Vec<_>>();
    let current_objective = projected_objectives.first().cloned();
    let current_thread = projected_threads.first().cloned();

    let state = runtime_overview_effective_session_state(
        &projected_objectives,
        &projected_threads,
        &projected_execution_jobs,
        pending_dialogue_turns,
    );
    let attention_required = matches!(
        state,
        RuntimeSessionState::NeedsAttention | RuntimeSessionState::WaitingUser
    );

    RuntimeOverviewSession {
        session,
        principal_ids,
        state,
        attention_required,
        pending_dialogue_turns,
        open_thread_count: threads.len(),
        running_activation_count,
        active_execution_job_count: execution_jobs.len(),
        objectives: projected_objectives,
        threads: projected_threads,
        execution_jobs: projected_execution_jobs,
        current_thread,
        current_objective,
    }
}

fn runtime_overview_effective_session_state(
    objectives: &[RuntimeOverviewObjective],
    threads: &[RuntimeOverviewThread],
    execution_jobs: &[RuntimeOverviewExecutionJob],
    pending_dialogue_turns: usize,
) -> RuntimeSessionState {
    objectives
        .iter()
        .map(|objective| objective.state)
        .chain(threads.iter().map(|thread| thread.state))
        .chain(
            execution_jobs
                .iter()
                .map(|job| runtime_overview_execution_job_state(job.status)),
        )
        .chain((pending_dialogue_turns > 0).then_some(RuntimeSessionState::Queued))
        .max_by_key(|state| state.priority())
        .unwrap_or(RuntimeSessionState::Idle)
}

fn runtime_overview_execution_job_state(status: ExecutionJobStatus) -> RuntimeSessionState {
    match status {
        ExecutionJobStatus::WaitingApproval => RuntimeSessionState::WaitingUser,
        ExecutionJobStatus::Running => RuntimeSessionState::Running,
        ExecutionJobStatus::Queued => RuntimeSessionState::Queued,
        // The overview only receives active Jobs. Keep this exhaustive mapping
        // defensive so an inconsistent Store row cannot manufacture activity.
        ExecutionJobStatus::Succeeded
        | ExecutionJobStatus::Failed
        | ExecutionJobStatus::Cancelled
        | ExecutionJobStatus::Lost => RuntimeSessionState::Idle,
    }
}

fn runtime_overview_objective_state(objective: &ObjectiveRecord) -> RuntimeSessionState {
    if objective.status == ObjectiveStatus::Blocked {
        RuntimeSessionState::NeedsAttention
    } else if matches!(
        objective.wait_condition,
        Some(ObjectiveWaitCondition::UserInput { .. })
            | Some(ObjectiveWaitCondition::Permission { .. })
    ) {
        RuntimeSessionState::WaitingUser
    } else if objective.status == ObjectiveStatus::Paused {
        RuntimeSessionState::Paused
    } else if objective.wait_condition.is_some() {
        RuntimeSessionState::Waiting
    } else if objective.active_evaluation_id.is_some() || objective.completion_intent.is_some() {
        RuntimeSessionState::Running
    } else {
        RuntimeSessionState::Queued
    }
}

fn runtime_overview_thread_state(
    thread: &ThreadRecord,
    activations: &[&ThreadActivationRecord],
    execution_jobs: &[&ExecutionJobMonitorRecord],
) -> RuntimeSessionState {
    if execution_jobs
        .iter()
        .any(|job| job.status == ExecutionJobStatus::WaitingApproval)
    {
        RuntimeSessionState::WaitingUser
    } else if activations
        .iter()
        .any(|activation| activation.status == ThreadActivationStatus::Running)
        || execution_jobs
            .iter()
            .any(|job| job.status == ExecutionJobStatus::Running)
    {
        RuntimeSessionState::Running
    } else if activations
        .iter()
        .any(|activation| activation.status == ThreadActivationStatus::Queued)
        || execution_jobs
            .iter()
            .any(|job| job.status == ExecutionJobStatus::Queued)
    {
        RuntimeSessionState::Queued
    } else if thread.control_state == ThreadControlState::Paused {
        RuntimeSessionState::Paused
    } else {
        RuntimeSessionState::Waiting
    }
}

fn event_matches_causal_scope(event: &Event, query: &EventHistoryQuery) -> bool {
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

fn reply_matches_turn(event: &Event, session_id: &str, root_turn_id: &str) -> bool {
    event.topic == "chat/reply"
        && crate::memory::causal_payload_string(event, "session_id") == Some(session_id)
        && crate::memory::causal_payload_string(event, "root_turn_id") == Some(root_turn_id)
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
    /// True when this message atomically replaced a still-thinking
    /// DialogueTurn. Once a turn has produced an Execution Thread, new input
    /// is concurrent and this remains false.
    #[serde(default)]
    pub interrupted: bool,
    /// Effective per-message scheduling mode after resolving the configured
    /// default at ingress.
    pub dispatch_mode: MessageDispatchMode,
}

#[derive(Debug, Clone, Default)]
pub struct SessionMessageOptions {
    pub requested_harness: Option<crate::harness::ExactHarnessRef>,
    pub attachments: Vec<crate::sdk::MessageAttachmentInput>,
    pub references: Vec<crate::sdk::MessageReferenceInput>,
    pub dispatch_mode: Option<MessageDispatchMode>,
    /// One-shot exact model route for the Evaluation rooted at this message.
    /// Unlike the Session binding, this value is persisted on the root Event
    /// and frozen on the resulting Activation only.
    pub model_alias: Option<String>,
    /// One-shot reasoning level persisted on the root Event and frozen on the
    /// resulting Activation without mutating the Session default.
    pub reasoning_effort: Option<String>,
    /// One-shot physical destination for the Dialogue Thread rooted at this
    /// message. Once persisted, Thread target affinity governs every
    /// continuation; later Events cannot silently redirect it.
    pub target_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageIngressErrorKind {
    InvalidArgument,
    Conflict,
    Forbidden,
}

#[derive(Debug)]
pub struct MessageIngressError {
    pub kind: MessageIngressErrorKind,
    pub message: String,
}

impl MessageIngressError {
    fn new(kind: MessageIngressErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for MessageIngressError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for MessageIngressError {}

fn validate_client_message_id(value: &str) -> Result<(), MessageIngressError> {
    if value.is_empty() || value.len() > 128 {
        return Err(MessageIngressError::new(
            MessageIngressErrorKind::InvalidArgument,
            "client_message_id length must be 1..=128 bytes",
        ));
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(MessageIngressError::new(
            MessageIngressErrorKind::InvalidArgument,
            "client_message_id may contain only ASCII letters, digits, -, _, ., and :",
        ));
    }
    Ok(())
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
        self.send_as_principal_with_options(
            text,
            actor,
            principal_id,
            client_message_id,
            SessionMessageOptions {
                requested_harness,
                ..SessionMessageOptions::default()
            },
        )
        .await
    }

    pub async fn send_as_principal_with_options(
        &self,
        text: impl Into<String>,
        actor: impl Into<String>,
        principal_id: impl Into<String>,
        client_message_id: Option<String>,
        options: SessionMessageOptions,
    ) -> Result<MessageReceipt, RuntimeError> {
        let SessionMessageOptions {
            requested_harness,
            attachments,
            references,
            dispatch_mode,
            model_alias,
            reasoning_effort,
            target_id,
        } = options;
        let actor = actor.into();
        let session = self
            .runtime
            .get_session(&self.id)
            .await?
            .ok_or_else(|| format!("Session '{}' does not exist", self.id))?;
        if session.status == crate::memory::SessionStatus::Archived {
            return Err("an archived Session cannot receive new messages".into());
        }
        let text = text.into().trim().to_string();
        if text.is_empty() && attachments.is_empty() && references.is_empty() {
            return Err("message text, attachments, and references cannot all be empty".into());
        }
        if text.chars().count() > 1_000_000 {
            return Err("message text exceeds 1,000,000 characters".into());
        }
        if references.len() > 64 {
            return Err(Box::new(MessageIngressError::new(
                MessageIngressErrorKind::InvalidArgument,
                "a message may reference at most 64 Sessions",
            )));
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
                "Principal '{}' is not bound to Session '{}'; message rejected",
                principal_id, self.id
            )
            .into());
        }
        let client_message_id = client_message_id.unwrap_or_else(|| runtime_id("client"));
        validate_client_message_id(&client_message_id)?;
        let model_alias = if let Some(model_alias) = model_alias {
            let model_alias = model_alias.trim().to_string();
            if model_alias.is_empty() {
                return Err(Box::new(MessageIngressError::new(
                    MessageIngressErrorKind::InvalidArgument,
                    "model_alias must not be empty; omit it to inherit the Session or Runtime model",
                )));
            }
            let options = self.runtime.inference_model_options().await?;
            if !options.iter().any(|option| option.id == model_alias) {
                return Err(Box::new(MessageIngressError::new(
                    MessageIngressErrorKind::InvalidArgument,
                    format!("model '{model_alias}' is not present in the discovered and enabled model catalog"),
                )));
            }
            Some(model_alias)
        } else {
            None
        };
        let reasoning_effort = if let Some(reasoning_effort) = reasoning_effort {
            let reasoning_effort = reasoning_effort.trim();
            let parsed = crate::llm::ReasoningEffort::parse(reasoning_effort).ok_or_else(|| {
                Box::new(MessageIngressError::new(
                    MessageIngressErrorKind::InvalidArgument,
                    format!("unsupported reasoning effort '{reasoning_effort}'"),
                )) as RuntimeError
            })?;
            let effective_model = model_alias
                .as_deref()
                .or(session.model_alias.as_deref())
                .unwrap_or_else(|| self.runtime.inner.config.llm.model.as_str());
            if let Some(supported) = self
                .runtime
                .inference_model_options()
                .await?
                .iter()
                .find(|option| option.id == effective_model)
                .and_then(|option| option.supported_reasoning_efforts.as_ref())
            {
                if !supported
                    .iter()
                    .any(|candidate| candidate == parsed.as_str())
                {
                    return Err(Box::new(MessageIngressError::new(
                        MessageIngressErrorKind::InvalidArgument,
                        format!(
                            "reasoning effort '{}' is not supported by model '{}'",
                            parsed.as_str(),
                            effective_model
                        ),
                    )));
                }
            }
            Some(parsed.as_str().to_string())
        } else {
            None
        };
        let target_id = if let Some(target_id) = target_id {
            let target_id = target_id.trim().to_string();
            if target_id.is_empty() {
                return Err(Box::new(MessageIngressError::new(
                    MessageIngressErrorKind::InvalidArgument,
                    "target_id must not be empty; omit it to use the default Execution Target",
                )));
            }
            let target = self
                .runtime
                .inner
                .store
                .get_execution_target(&target_id)
                .await?
                .ok_or_else(|| {
                    Box::new(MessageIngressError::new(
                        MessageIngressErrorKind::InvalidArgument,
                        format!("Execution Target '{target_id}' does not exist"),
                    )) as RuntimeError
                })?;
            if target.owner_principal_id.is_some()
                && target.owner_principal_id.as_deref() != Some(principal_id.as_str())
            {
                return Err(Box::new(MessageIngressError::new(
                    MessageIngressErrorKind::Forbidden,
                    format!(
                        "Principal '{principal_id}' cannot route to Execution Target '{target_id}'"
                    ),
                )));
            }
            if !target.status.accepts_jobs() {
                return Err(Box::new(MessageIngressError::new(
                    MessageIngressErrorKind::Conflict,
                    format!("Execution Target '{target_id}' is not online"),
                )));
            }
            Some(target_id)
        } else {
            None
        };
        let event_id = runtime_id("msg");
        let resolved_harness = if let Some(reference) = requested_harness {
            let id = reference.id.trim();
            let version = reference.version.trim();
            if id.is_empty() || version.is_empty() {
                return Err("Harness id and version must not be empty".into());
            }
            let harness = self
                .runtime
                .inner
                .harness_registry
                .get(id, version)
                .ok_or_else(|| format!("Harness '{id}@{version}' is not installed"))?;
            let artifact_hash = harness.artifact_hash().ok_or_else(|| {
                format!("Harness '{id}@{version}' has no artifact hash and cannot be bound exactly")
            })?;
            Some((id.to_string(), version.to_string(), artifact_hash))
        } else {
            None
        };
        // Resolve every logical reference before importing attachment bytes.
        // A rejected reference must not leave a pending attachment manifest
        // for startup recovery to clean later.
        let mut canonical_references = Vec::with_capacity(references.len());
        let mut referenced_session_ids = std::collections::HashSet::new();
        for reference in references {
            let crate::sdk::MessageReferenceInput::Session { session_id } = reference;
            let session_id = session_id.trim();
            if session_id.is_empty() {
                return Err(Box::new(MessageIngressError::new(
                    MessageIngressErrorKind::InvalidArgument,
                    "Session reference is missing session_id",
                )));
            }
            if !referenced_session_ids.insert(session_id.to_string()) {
                continue;
            }
            let referenced = self.runtime.get_session(session_id).await?.ok_or_else(|| {
                Box::new(MessageIngressError::new(
                    MessageIngressErrorKind::InvalidArgument,
                    format!("referenced Session '{session_id}' does not exist"),
                )) as RuntimeError
            })?;
            if referenced.status == crate::memory::SessionStatus::Archived {
                return Err(Box::new(MessageIngressError::new(
                    MessageIngressErrorKind::Conflict,
                    format!("referenced Session '{session_id}' is archived"),
                )));
            }
            if referenced.agent_id != session.agent_id {
                return Err(Box::new(MessageIngressError::new(
                    MessageIngressErrorKind::Forbidden,
                    format!(
                        "referenced Session '{session_id}' does not belong to the current Agent"
                    ),
                )));
            }
            if !self
                .runtime
                .inner
                .store
                .verify_session_principal(session_id, &principal_id)
                .await?
            {
                return Err(Box::new(MessageIngressError::new(
                    MessageIngressErrorKind::Forbidden,
                    format!("Principal '{principal_id}' may not reference Session '{session_id}'"),
                )));
            }
            canonical_references.push(json!({
                "kind": "session",
                "session_id": referenced.id,
                "title": referenced.title,
                "context_id": referenced.context_id,
                "agent_id": referenced.agent_id,
            }));
        }
        let prepared_attachments = prepare_message_attachments(
            &self.runtime.inner.config.background_task.artifact_dir,
            &self.runtime.inner.config.model_input,
            &self.id,
            &event_id,
            attachments,
        )
        .await?;
        let dispatch_mode = dispatch_mode.unwrap_or_else(|| {
            if self
                .runtime
                .inner
                .config
                .orchestrator
                .interrupt_dialogue_on_new_message
            {
                MessageDispatchMode::Interrupt
            } else {
                MessageDispatchMode::FollowUp
            }
        });
        // Resolve the Context routing switch at ingress. A later Dashboard
        // toggle must not change the meaning of a message that was already
        // accepted, and participant child Evaluations must never recursively
        // fan out through the Mesh again.
        let coordination_mode =
            if actor == crate::experimental::COGNITIVE_COORDINATION_PARTICIPANT_ACTOR {
                "local"
            } else if self
                .runtime
                .context_capability_binding(
                    &session.context_id,
                    crate::experimental::COGNITIVE_COORDINATION,
                )
                .await?
                .is_some_and(|binding| binding.enabled)
            {
                "required"
            } else {
                "local"
            };
        let mut payload = serde_json::Map::from_iter([
            ("context_id".to_string(), json!(session.context_id)),
            ("session_id".to_string(), json!(self.id)),
            ("principal_id".to_string(), json!(principal_id)),
            ("client_message_id".to_string(), json!(client_message_id)),
            ("text".to_string(), json!(text)),
            ("dispatch_mode".to_string(), json!(dispatch_mode.as_str())),
            ("coordination_mode".to_string(), json!(coordination_mode)),
        ]);
        if let Some(model_alias) = model_alias {
            payload.insert("model_alias".to_string(), json!(model_alias));
        }
        if let Some(reasoning_effort) = reasoning_effort {
            payload.insert("reasoning_effort".to_string(), json!(reasoning_effort));
        }
        if let Some(target_id) = target_id {
            payload.insert("target_id".to_string(), json!(target_id));
        }
        if !canonical_references.is_empty() {
            payload.insert("references".to_string(), Value::Array(canonical_references));
        }
        if !prepared_attachments.metadata().is_empty() {
            payload.insert(
                "attachments".to_string(),
                Value::Array(prepared_attachments.metadata().to_vec()),
            );
        }
        if let Some((id, version, artifact_hash)) = resolved_harness {
            payload.insert("requested_harness_id".to_string(), json!(id));
            payload.insert("requested_harness_version".to_string(), json!(version));
            payload.insert(
                "requested_harness_artifact_hash".to_string(),
                json!(artifact_hash),
            );
        }
        let event = Event::new(
            event_id.clone(),
            actor,
            TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            payload,
        );
        let claim = self
            .runtime
            .inner
            .store
            .claim_message(&self.id, &client_message_id, &event, dispatch_mode)
            .await;
        let claim = match claim {
            Ok(claim) => claim,
            Err(error) => {
                discard_message_attachments(prepared_attachments, &event_id).await;
                return Err(error);
            }
        };
        match claim {
            MessageClaim::Existing {
                event_id: existing_event_id,
            } => {
                discard_message_attachments(prepared_attachments, &event_id).await;
                Ok(MessageReceipt {
                    event_id: existing_event_id,
                    client_message_id,
                    duplicate: true,
                    interrupted: false,
                    dispatch_mode,
                })
            }
            MessageClaim::Conflict {
                event_id: existing_event_id,
            } => {
                discard_message_attachments(prepared_attachments, &event_id).await;
                Err(Box::new(MessageIngressError::new(
                    MessageIngressErrorKind::Conflict,
                    format!(
                        "client_message_id '{}' is already bound to a different request Event '{}'",
                        client_message_id, existing_event_id
                    ),
                )))
            }
            MessageClaim::InactiveSession => {
                discard_message_attachments(prepared_attachments, &event_id).await;
                Err(Box::new(MessageIngressError::new(
                    MessageIngressErrorKind::Conflict,
                    "an archived Session cannot receive new messages",
                )))
            }
            MessageClaim::ForbiddenPrincipal { principal_id } => {
                discard_message_attachments(prepared_attachments, &event_id).await;
                Err(Box::new(MessageIngressError::new(
                    MessageIngressErrorKind::Forbidden,
                    format!(
                        "Principal '{}' is not bound to Session '{}'; message rejected",
                        principal_id, self.id
                    ),
                )))
            }
            MessageClaim::InvalidReference { message } => {
                discard_message_attachments(prepared_attachments, &event_id).await;
                Err(Box::new(MessageIngressError::new(
                    MessageIngressErrorKind::InvalidArgument,
                    message,
                )))
            }
            MessageClaim::InactiveReference { session_id } => {
                discard_message_attachments(prepared_attachments, &event_id).await;
                Err(Box::new(MessageIngressError::new(
                    MessageIngressErrorKind::Conflict,
                    format!("referenced Session '{session_id}' is archived"),
                )))
            }
            MessageClaim::ForbiddenReference {
                session_id,
                principal_id,
            } => {
                discard_message_attachments(prepared_attachments, &event_id).await;
                Err(Box::new(MessageIngressError::new(
                    MessageIngressErrorKind::Forbidden,
                    format!("Principal '{principal_id}' may not reference Session '{session_id}'"),
                )))
            }
            MessageClaim::Accepted { event, interrupted } => {
                if let Err(error) = prepared_attachments.commit().await {
                    // The immutable Event owns the Event-specific links now.
                    // Startup reconciliation can safely remove a leftover
                    // manifest after observing that Event.
                    tracing::warn!(
                        event_id = %event.id,
                        error = %error,
                        event_code = "runtime.message_attachment_commit_deferred",
                        "Message attachments committed, but pending-manifest cleanup was deferred"
                    );
                }
                // claim_message committed the immutable Event and its
                // Dialogue Thread Signal atomically.  Dispatch only the
                // already-durable fact; routing it through publish() would
                // re-enter the legacy Event -> Signal Outbox bridge.
                if let Some(interrupted) = interrupted.as_ref() {
                    self.runtime
                        .inner
                        .orchestrator
                        .notify_dialogue_interruption(&interrupted.activation_id);
                }
                let event_id = event.id.clone();
                self.runtime.inner.bus.dispatch_persisted(event).await?;
                Ok(MessageReceipt {
                    event_id,
                    client_message_id,
                    duplicate: false,
                    interrupted: interrupted.is_some(),
                    dispatch_mode,
                })
            }
        }
    }

    pub fn cancel(&self) -> bool {
        self.runtime.cancel_session(&self.id)
    }

    pub async fn cancel_durable(&self, reason: &str) -> Result<usize, RuntimeError> {
        self.runtime.cancel_session_durable(&self.id, reason).await
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
                after_sequence,
                latest_k: after_sequence.is_none().then_some(1_000),
                top_k: after_sequence.is_some().then_some(1_000),
                ..Default::default()
            })
            .await
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
            .ok_or_else(|| format!("Session '{}' does not exist", self.id))?;
        if session.status == crate::memory::SessionStatus::Archived {
            return Err("an archived Session cannot restart a DialogueTurn".into());
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
                "Principal '{}' is not bound to Session '{}'; DialogueTurn restart rejected",
                principal_id, self.id
            )
            .into());
        }
        let root_turn_id = root_turn_id.into();
        let retry_request_id = retry_request_id.into();
        if root_turn_id.trim().is_empty() || retry_request_id.trim().is_empty() {
            return Err("root_turn_id and retry_request_id must not be empty".into());
        }
        let expected_result_event_id = expected_result_event_id.into();
        let thread = self
            .runtime
            .inner
            .store
            .get_thread_by_root(&root_turn_id)
            .await?
            .ok_or_else(|| format!("DialogueTurn '{}' does not exist", root_turn_id))?;
        if thread.session_id != self.id || thread.context_id != session.context_id {
            return Err(format!(
                "DialogueTurn '{}' does not belong to Session '{}'",
                root_turn_id, self.id
            )
            .into());
        }
        if thread
            .initiating_principal_id
            .as_deref()
            .is_some_and(|owner| owner != principal_id)
        {
            return Err(
                "the current Principal cannot restart a DialogueTurn initiated by another identity"
                    .into(),
            );
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
        let restart_request = DialogueTurnRetryRequest {
            expected_thread_revision,
            expected_result_event_id,
            event: event.clone(),
        };
        let mutation = match self
            .runtime
            .inner
            .scheduler_kernel
            .execute(crate::controllers::DialogueController::restart_turn(
                &thread,
                restart_request,
                "Runtime-DialogueRetry",
            ))
            .await?
        {
            crate::scheduler::KernelResult::DialogueTurnRestarted(mutation) => mutation,
            _ => {
                return Err(
                    "Scheduler Kernel returned an invalid DialogueTurn restart result".into(),
                )
            }
        };
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
                    "DialogueTurn changed: expected r{}, current r{} / generation {}",
                    expected_thread_revision, current.revision, current.generation
                )
                .into());
            }
            DialogueTurnRetryMutation::Rejected { reason, .. } => return Err(reason.into()),
            DialogueTurnRetryMutation::NotFound => {
                return Err(format!("DialogueTurn '{}' does not exist", root_turn_id).into());
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
            .ok_or_else(|| format!("DialogueTurn retry Event '{}' was not persisted", event_id))?;
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
    use crate::memory::{ActivationStore as _, ScheduleStatus, SessionDirectoryStore as _};
    use crate::permission::PermissionMode;
    use crate::sdk::MessageAttachmentInput;
    use base64::Engine as _;
    use tempfile::NamedTempFile;

    struct ReplyClient;

    struct EmbeddedProbeTool;

    #[async_trait::async_trait]
    impl Tool for EmbeddedProbeTool {
        fn name(&self) -> &str {
            "embedded_probe"
        }

        fn definition(&self) -> ToolDefinition {
            ToolDefinition {
                name: self.name().to_string(),
                description: "Embedding-host probe tool".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }),
            }
        }

        async fn execute(
            &self,
            _arguments: &str,
        ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
            Ok("embedded-probe-ok".to_string())
        }
    }

    struct SessionSignalCoordinationClient {
        target_started: tokio::sync::Notify,
        observed_concurrent_target: AtomicBool,
        source_initial_calls: AtomicU64,
        source_continuation_calls: AtomicU64,
        source_reply_calls: AtomicU64,
        target_initial_calls: AtomicU64,
        target_continuation_calls: AtomicU64,
    }

    struct ReviewerDecisionClient {
        calls: AtomicU64,
    }

    #[async_trait::async_trait]
    impl Client for ReviewerDecisionClient {
        async fn create_completion(
            &self,
            messages: Vec<Message>,
            tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            assert!(tools.is_empty());
            assert!(messages.first().is_some_and(|message| message
                .content
                .contains("independent permission reviewer")));
            Ok(text_response(
                r#"{"decision":"allow_once","rationale":"narrow test boundary","risk_tags":["test"]}"#,
            ))
        }
    }

    fn contains_cjk(text: &str) -> bool {
        text.chars().any(|character| {
            matches!(
                character,
                '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}' | '\u{f900}'..='\u{faff}'
            )
        })
    }

    #[test]
    fn runtime_overview_keeps_a_background_job_live_after_its_thread_is_terminal() {
        let now = chrono::Utc::now();
        let session = SessionRecord {
            id: "session-background".to_string(),
            agent_id: "agent-default".to_string(),
            context_id: "context-default".to_string(),
            parent_session_id: None,
            title: "Background work".to_string(),
            status: SessionStatus::Active,
            model_alias: None,
            reasoning_effort: None,
            sandbox_mode: None,
            context_sharing: crate::memory::SessionContextSharing::Shared,
            created_at: now,
            updated_at: now,
            last_activity_at: now,
            attention_state: crate::memory::SessionAttentionState::Active,
            attention_revision: 0,
            attention_reason: None,
            attention_changed_at: None,
            attention_event_id: None,
        };
        let job = ExecutionJobMonitorRecord {
            id: "job-background".to_string(),
            activation_id: "activation-background".to_string(),
            thread_id: "thread-completed".to_string(),
            context_id: "context-default".to_string(),
            session_id: "session-background".to_string(),
            status: ExecutionJobStatus::Running,
            tool_name: "exec/background".to_string(),
            target_id: "target-default".to_string(),
            progress_ref: None,
            error: None,
            updated_at: now,
            checkpoint_generation: None,
            checkpoint_due_at: None,
        };
        let overview =
            runtime_overview_session(session, Vec::new(), &[], &[], &[job], &[], &HashMap::new());

        assert_eq!(overview.state, RuntimeSessionState::Running);
        assert_eq!(overview.open_thread_count, 0);
        assert_eq!(overview.active_execution_job_count, 1);
        assert_eq!(overview.execution_jobs[0].id, "job-background");
        assert!(overview.threads.is_empty());
    }

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
                ..ProviderModelConfig::default()
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
    async fn model_configuration_change_wakes_configuration_objectives_and_provider_threads() {
        let database = NamedTempFile::new().unwrap();
        let runtime = MorphzRuntime::builder(AppConfig::default(), Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .build()
            .await
            .unwrap();
        runtime
            .inner
            .store
            .create_agent_bundle(
                NewAgent {
                    id: runtime.identity().agent_id.clone(),
                    title: "Configuration wake agent".to_string(),
                    root_context_id: runtime.identity().context_id.clone(),
                },
                NewCognitiveContext {
                    id: runtime.identity().context_id.clone(),
                    agent_id: runtime.identity().agent_id.clone(),
                    title: "Configuration wake context".to_string(),
                },
                NewSession {
                    id: "session-model-configuration-wake".to_string(),
                    agent_id: runtime.identity().agent_id.clone(),
                    context_id: runtime.identity().context_id.clone(),
                    parent_session_id: None,
                    title: "Configuration wake session".to_string(),
                    mount_kind: crate::memory::SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        let objective = runtime
            .inner
            .store
            .create_objective(NewObjective {
                id: "objective-model-configuration-wake".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                coordinator_session_id: "session-model-configuration-wake".to_string(),
                delivery_session_id: "session-model-configuration-wake".to_string(),
                parent_objective_id: None,
                source_event_id: "source-model-configuration-wake".to_string(),
                initiating_principal_id: None,
                stated_objective: "Resume after an explicit model configuration change".to_string(),
                token_budget: None,
            })
            .await
            .unwrap();
        match runtime
            .inner
            .store
            .update_objective_state(
                &objective.id,
                objective.revision,
                ObjectiveStatus::Active,
                Some(ObjectiveWaitCondition::ResourceAvailable {
                    resource: MODEL_CONFIGURATION_RESOURCE.to_string(),
                }),
                Some("test configuration wait"),
            )
            .await
            .unwrap()
        {
            ObjectiveMutation::Updated(_) => {}
            mutation => panic!("unexpected objective wait mutation: {mutation:?}"),
        }
        let dependencies = runtime
            .inner
            .store
            .list_scheduler_dependencies(SchedulerDependencyFilter {
                owner_kind: Some(SchedulerDependencyOwnerKind::Objective),
                owner_id: Some(objective.id.clone()),
                dependency_kind: Some(SchedulerDependencyKind::Resource),
                dependency_id: Some(MODEL_CONFIGURATION_RESOURCE.to_string()),
                status: Some(SchedulerDependencyStatus::Pending),
                required_only: true,
            })
            .await
            .unwrap();
        assert_eq!(dependencies.len(), 1);

        let thread = runtime
            .inner
            .store
            .ensure_thread(NewThread {
                id: "thread-model-configuration-provider-wake".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                session_id: "session-model-configuration-wake".to_string(),
                initiating_principal_id: None,
                root_turn_id: "root-model-configuration-provider-wake".to_string(),
                kind: ThreadKind::Execution,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: ThreadSupervision::legacy(),
            })
            .await
            .unwrap();
        let provider_resource = "model-route:route-that-operator-replaced";
        let thread_dependency_id = crate::scheduler::stable_scheduler_dependency_id(
            SchedulerDependencyOwnerKind::Thread,
            &thread.id,
            thread.generation,
            SchedulerDependencyKind::Resource,
            provider_resource,
            1,
        );
        runtime
            .inner
            .store
            .register_scheduler_dependency(crate::scheduler::NewSchedulerDependency {
                id: thread_dependency_id.clone(),
                owner_kind: SchedulerDependencyOwnerKind::Thread,
                owner_id: thread.id.clone(),
                owner_generation: thread.generation,
                dependency_kind: SchedulerDependencyKind::Resource,
                dependency_id: provider_resource.to_string(),
                dependency_generation: 1,
                required: true,
                metadata: json!({"source": "provider_wait"}),
            })
            .await
            .unwrap();
        let unrelated_dependency_id = crate::scheduler::stable_scheduler_dependency_id(
            SchedulerDependencyOwnerKind::Thread,
            &thread.id,
            thread.generation,
            SchedulerDependencyKind::Resource,
            "external-capacity:test",
            1,
        );
        runtime
            .inner
            .store
            .register_scheduler_dependency(crate::scheduler::NewSchedulerDependency {
                id: unrelated_dependency_id.clone(),
                owner_kind: SchedulerDependencyOwnerKind::Thread,
                owner_id: thread.id.clone(),
                owner_generation: thread.generation,
                dependency_kind: SchedulerDependencyKind::Resource,
                dependency_id: "external-capacity:test".to_string(),
                dependency_generation: 1,
                required: true,
                metadata: json!({"fixture": "must remain pending"}),
            })
            .await
            .unwrap();

        // Runtime::start installs the durable Event writer before publishing
        // the startup configuration epoch. This focused test starts the same
        // persistence boundary without starting unrelated Runtime workers.
        Arc::clone(&runtime.inner.orchestrator)
            .start()
            .await
            .unwrap();

        let mut available = runtime.subscribe("runtime/resource_available", 8);
        runtime
            .publish_model_configuration_changed("test_catalog_change")
            .await
            .unwrap();
        let mut events = Vec::new();
        for _ in 0..2 {
            events.push(
                tokio::time::timeout(std::time::Duration::from_secs(1), available.recv())
                    .await
                    .unwrap()
                    .unwrap(),
            );
        }
        let event = events
            .iter()
            .find(|event| {
                event.payload.get("resource").and_then(Value::as_str)
                    == Some(MODEL_CONFIGURATION_RESOURCE)
            })
            .unwrap();
        assert_eq!(
            event.payload.get("context_id").and_then(Value::as_str),
            Some(runtime.identity().context_id.as_str())
        );
        assert_eq!(
            event.payload.get("resource").and_then(Value::as_str),
            Some(MODEL_CONFIGURATION_RESOURCE)
        );
        assert_eq!(event.payload["objective_ids"], json!([objective.id]));

        let provider_event = events
            .iter()
            .find(|event| {
                event.payload.get("resource").and_then(Value::as_str) == Some(provider_resource)
            })
            .unwrap();
        assert_eq!(provider_event.payload["thread_ids"], json!([thread.id]));
        assert_eq!(
            provider_event
                .payload
                .get("recovery_phase")
                .and_then(Value::as_str),
            Some("explicit_model_configuration_changed")
        );

        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                let dependency = runtime
                    .inner
                    .store
                    .get_scheduler_dependency(&thread_dependency_id)
                    .await
                    .unwrap()
                    .unwrap();
                if dependency.status == SchedulerDependencyStatus::Satisfied {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("an explicit model configuration change must release the stale route wait");
        assert_eq!(
            runtime
                .inner
                .store
                .get_scheduler_dependency(&unrelated_dependency_id)
                .await
                .unwrap()
                .unwrap()
                .status,
            SchedulerDependencyStatus::Pending,
            "model configuration changes must not satisfy unrelated external resources"
        );

        let epochs = runtime
            .query_events(QueryFilter {
                topic: Some(TYPE_MODEL_CONFIGURATION_CHANGED.to_string()),
                top_k: Some(4),
                ..QueryFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(epochs.len(), 1);
        assert_eq!(
            epochs[0].payload.get("resource").and_then(Value::as_str),
            Some(MODEL_CONFIGURATION_RESOURCE)
        );
    }

    #[tokio::test]
    async fn session_model_change_wakes_only_that_sessions_provider_waiters() {
        let database = NamedTempFile::new().unwrap();
        let runtime = MorphzRuntime::builder(AppConfig::default(), Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .build()
            .await
            .unwrap();
        let session_a = "session-model-switch-a";
        let session_b = "session-model-switch-b";
        runtime
            .inner
            .store
            .create_agent_bundle(
                NewAgent {
                    id: runtime.identity().agent_id.clone(),
                    title: "Session model switch agent".to_string(),
                    root_context_id: runtime.identity().context_id.clone(),
                },
                NewCognitiveContext {
                    id: runtime.identity().context_id.clone(),
                    agent_id: runtime.identity().agent_id.clone(),
                    title: "Session model switch context".to_string(),
                },
                NewSession {
                    id: session_a.to_string(),
                    agent_id: runtime.identity().agent_id.clone(),
                    context_id: runtime.identity().context_id.clone(),
                    parent_session_id: None,
                    title: "Session A".to_string(),
                    mount_kind: crate::memory::SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        runtime
            .inner
            .store
            .create_session(NewSession {
                id: session_b.to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Session B".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();

        let resource = "model-route:exhausted-session-a-route";
        let mut dependency_ids = Vec::new();
        let mut thread_ids = Vec::new();
        for (suffix, session_id) in [("a", session_a), ("b", session_b)] {
            let thread = runtime
                .inner
                .store
                .ensure_thread(NewThread {
                    id: format!("thread-model-switch-{suffix}"),
                    agent_id: runtime.identity().agent_id.clone(),
                    context_id: runtime.identity().context_id.clone(),
                    session_id: session_id.to_string(),
                    initiating_principal_id: None,
                    root_turn_id: format!("root-model-switch-{suffix}"),
                    kind: ThreadKind::Execution,
                    executor_kind: "self".to_string(),
                    executor_id: None,
                    target_id: None,
                    supervision: ThreadSupervision::legacy(),
                })
                .await
                .unwrap();
            let dependency_id = crate::scheduler::stable_scheduler_dependency_id(
                SchedulerDependencyOwnerKind::Thread,
                &thread.id,
                thread.generation,
                SchedulerDependencyKind::Resource,
                resource,
                1,
            );
            runtime
                .inner
                .store
                .register_scheduler_dependency(crate::scheduler::NewSchedulerDependency {
                    id: dependency_id.clone(),
                    owner_kind: SchedulerDependencyOwnerKind::Thread,
                    owner_id: thread.id.clone(),
                    owner_generation: thread.generation,
                    dependency_kind: SchedulerDependencyKind::Resource,
                    dependency_id: resource.to_string(),
                    dependency_generation: 1,
                    required: true,
                    metadata: json!({"source": "provider_wait"}),
                })
                .await
                .unwrap();
            dependency_ids.push(dependency_id);
            thread_ids.push(thread.id);
        }

        Arc::clone(&runtime.inner.orchestrator)
            .start()
            .await
            .unwrap();
        let mut available = runtime.subscribe("runtime/resource_available", 4);
        runtime
            .update_session(
                session_a,
                SessionUpdate {
                    model_alias: Some(Some(runtime.model())),
                    ..SessionUpdate::default()
                },
            )
            .await
            .unwrap()
            .unwrap();

        let event = tokio::time::timeout(std::time::Duration::from_secs(1), available.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.payload["resource"], json!(resource));
        assert_eq!(event.payload["session_id"], json!(session_a));
        assert_eq!(event.payload["thread_ids"], json!([thread_ids[0].clone()]));
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if runtime
                    .inner
                    .store
                    .get_scheduler_dependency(&dependency_ids[0])
                    .await
                    .unwrap()
                    .unwrap()
                    .status
                    == SchedulerDependencyStatus::Satisfied
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the selected Session's stale route dependency must be satisfied");
        assert_eq!(
            runtime
                .inner
                .store
                .get_scheduler_dependency(&dependency_ids[1])
                .await
                .unwrap()
                .unwrap()
                .status,
            SchedulerDependencyStatus::Pending,
            "changing Session A must not wake Session B's unrelated waiter"
        );
    }

    #[test]
    fn transport_neutral_client_message_id_contract_is_bounded() {
        assert!(validate_client_message_id("wechat:message_123-4.5").is_ok());
        for invalid in ["", "contains whitespace", "包含中文"] {
            let error = validate_client_message_id(invalid).unwrap_err();
            assert_eq!(error.kind, MessageIngressErrorKind::InvalidArgument);
        }
        let oversized = "a".repeat(129);
        let error = validate_client_message_id(&oversized).unwrap_err();
        assert_eq!(error.kind, MessageIngressErrorKind::InvalidArgument);
    }

    #[tokio::test]
    async fn message_attachments_store_bytes_outside_events_by_digest() {
        let artifact_root = tempfile::tempdir().unwrap();
        let input = MessageAttachmentInput {
            name: "../diagram.png".to_string(),
            media_type: "image/png".to_string(),
            data: b"image-bytes".to_vec(),
        };
        let prepared = prepare_message_attachments(
            artifact_root.path().to_str().unwrap(),
            &AppConfig::default().model_input,
            "session-attachment-test",
            "event-attachment-test",
            vec![input.clone(), input],
        )
        .await
        .unwrap();
        let metadata = prepared.metadata();

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
        prepared.commit().await.unwrap();
    }

    #[tokio::test]
    async fn running_runtime_reclaims_an_import_deferred_during_startup() {
        let database = NamedTempFile::new().unwrap();
        let artifacts = tempfile::tempdir().unwrap();
        let mut config = AppConfig::default();
        config.background_task.artifact_dir = artifacts.path().to_string_lossy().into_owned();
        config.model_input.pending_import_grace = crate::config::HumanDuration::from_secs(2);
        let prepared = prepare_message_attachments(
            &config.background_task.artifact_dir,
            &config.model_input,
            "session-periodic-recovery",
            "event-periodic-orphan",
            vec![MessageAttachmentInput {
                name: "orphan.png".to_string(),
                media_type: "image/png".to_string(),
                data: b"periodic-orphan".to_vec(),
            }],
        )
        .await
        .unwrap();
        let path = PathBuf::from(prepared.metadata()[0]["storage_path"].as_str().unwrap());
        drop(prepared);

        let runtime = MorphzRuntime::builder(config, Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while tokio::fs::try_exists(&path).await.unwrap() {
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("periodic recovery must reclaim an import deferred at startup");
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

    struct InterruptibleDialogueClient {
        calls: AtomicU64,
        first_entered: Arc<tokio::sync::Notify>,
        observed_combined_input: Arc<AtomicBool>,
        observed_interrupted_attachment: Arc<AtomicBool>,
    }

    struct PhysicalBatchClient {
        calls: AtomicU64,
        observed_complete_batch: Arc<AtomicBool>,
        requests: Arc<std::sync::Mutex<Vec<Vec<Message>>>>,
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
        observed_tool_schemas: Arc<std::sync::Mutex<Vec<Vec<String>>>>,
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
    async fn embedding_host_can_register_a_physical_tool_before_target_materialization() {
        let database = NamedTempFile::new().unwrap();
        let runtime = MorphzRuntime::builder(AppConfig::default(), Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .extra_tool(Arc::new(EmbeddedProbeTool))
            .build()
            .await
            .unwrap();

        assert!(runtime
            .tool_names()
            .iter()
            .any(|name| name == "embedded_probe"));
        assert!(runtime
            .physical_tool_names()
            .iter()
            .any(|name| name == "embedded_probe"));
    }

    #[async_trait::async_trait]
    impl Client for SessionSignalCoordinationClient {
        async fn create_completion(
            &self,
            messages: Vec<Message>,
            tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            let prompt = messages
                .iter()
                .map(|message| message.content.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            let active_target = prompt.contains("(active-session session-signal-live-b)");
            let active_source = prompt.contains("(active-session session-signal-live-a)");
            let has_session_signal_result = messages
                .iter()
                .any(|message| message.role == "tool" && message.content.contains("signalled"));

            if active_target {
                if has_session_signal_result {
                    self.target_continuation_calls
                        .fetch_add(1, Ordering::SeqCst);
                    return Ok(text_response("target-finished"));
                }
                self.target_initial_calls.fetch_add(1, Ordering::SeqCst);
                assert!(prompt.contains("work-request-for-b"));
                assert!(tools.iter().any(|tool| tool.name == "session_signal"));
                self.target_started.notify_one();
                return Ok(Response {
                    content: String::new(),
                    tool_calls: vec![ToolCallRepr {
                        id: "session-signal-b-to-a".to_string(),
                        r#type: "function".to_string(),
                        func_name: "session_signal".to_string(),
                        arguments: json!({
                            "session_id": "session-signal-live-a",
                            "content": "target-result-from-b"
                        })
                        .to_string(),
                    }],
                });
            }

            if !active_source {
                return Ok(text_response("non-dialogue-maintenance"));
            }
            if prompt.contains("target-result-from-b") {
                self.source_reply_calls.fetch_add(1, Ordering::SeqCst);
                return Ok(text_response("source-received-result"));
            }
            if has_session_signal_result {
                self.source_continuation_calls
                    .fetch_add(1, Ordering::SeqCst);
                tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    self.target_started.notified(),
                )
                .await
                .map_err(|_| {
                    "target Session did not start while source Evaluation remained live"
                })?;
                self.observed_concurrent_target
                    .store(true, Ordering::SeqCst);
                return Ok(text_response("source-finished"));
            }
            self.source_initial_calls.fetch_add(1, Ordering::SeqCst);
            assert!(prompt.contains("start-session-coordination"));
            assert!(tools.iter().any(|tool| tool.name == "session_signal"));
            Ok(Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: "session-signal-a-to-b".to_string(),
                    r#type: "function".to_string(),
                    func_name: "session_signal".to_string(),
                    arguments: json!({
                        "session_id": "session-signal-live-b",
                        "content": "work-request-for-b"
                    })
                    .to_string(),
                }],
            })
        }
    }

    #[tokio::test]
    async fn one_shot_schedule_due_executes_through_the_live_runtime() {
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
                id: "session-live-schedule".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Live schedule".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        runtime
            .inner
            .store
            .ensure_thread(crate::memory::NewThread {
                id: "thread-live-schedule".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                session_id: "session-live-schedule".to_string(),
                initiating_principal_id: None,
                root_turn_id: "root-live-schedule".to_string(),
                kind: crate::memory::ThreadKind::Execution,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: crate::memory::ThreadSupervision::runtime("schedule-test"),
            })
            .await
            .unwrap();
        let schedule = runtime
            .inner
            .store
            .ensure_schedule(crate::memory::NewSchedule {
                id: "schedule-live-once".to_string(),
                thread_id: "thread-live-schedule".to_string(),
                source_turn_id: "root-live-schedule".to_string(),
                intent: "execute the persisted one-shot timer".to_string(),
                model_alias: None,
                not_before: Some(chrono::Utc::now() + chrono::Duration::milliseconds(30)),
                interval_seconds: None,
                dependency_thread_ids: Vec::new(),
            })
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 4);
        runtime.inner.thread_scheduler.arm(schedule).await.unwrap();

        let reply = tokio::time::timeout(std::time::Duration::from_secs(15), replies.recv())
            .await
            .expect("one-shot schedule must reach a live model Activation")
            .unwrap();
        assert_eq!(reply.payload["text"], "runtime-ok");
        assert_eq!(
            runtime
                .inner
                .store
                .get_schedule("schedule-live-once")
                .await
                .unwrap()
                .unwrap()
                .status,
            crate::memory::ScheduleStatus::Dispatched
        );
    }

    #[tokio::test]
    async fn recurring_schedule_due_executes_on_an_independent_occurrence_thread() {
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
                id: "session-live-recurring-schedule".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Live recurring schedule".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        runtime
            .inner
            .store
            .ensure_thread(crate::memory::NewThread {
                id: "thread-live-recurring-template".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                session_id: "session-live-recurring-schedule".to_string(),
                initiating_principal_id: None,
                root_turn_id: "root-live-recurring-template".to_string(),
                kind: crate::memory::ThreadKind::Execution,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: crate::memory::ThreadSupervision::runtime("schedule-template-test"),
            })
            .await
            .unwrap();
        let schedule = runtime
            .inner
            .store
            .ensure_schedule(crate::memory::NewSchedule {
                id: "schedule-live-recurring".to_string(),
                thread_id: "thread-live-recurring-template".to_string(),
                source_turn_id: "root-live-recurring-template".to_string(),
                intent: "execute one recurring occurrence".to_string(),
                model_alias: None,
                not_before: Some(chrono::Utc::now() + chrono::Duration::milliseconds(30)),
                interval_seconds: Some(60),
                dependency_thread_ids: Vec::new(),
            })
            .await
            .unwrap();
        let first_revision = schedule.revision;
        let mut replies = runtime.subscribe("chat/reply", 4);
        runtime.inner.thread_scheduler.arm(schedule).await.unwrap();

        let reply = tokio::time::timeout(std::time::Duration::from_secs(3), replies.recv())
            .await
            .expect("recurring schedule must reach a live model Activation")
            .unwrap();
        assert_eq!(reply.payload["text"], "runtime-ok");
        let occurrence_root =
            crate::tool::scheduled_occurrence_root("schedule-live-recurring", first_revision);
        let occurrence = runtime
            .inner
            .store
            .get_thread_by_root(&occurrence_root)
            .await
            .unwrap()
            .expect("recurring occurrence Thread must be durable");
        assert_ne!(occurrence.id, "thread-live-recurring-template");
        let current = runtime
            .inner
            .store
            .get_schedule("schedule-live-recurring")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(current.status, crate::memory::ScheduleStatus::Queued);
        assert_eq!(current.revision, first_revision + 1);
    }

    #[tokio::test]
    async fn live_runtime_reconciles_a_persisted_signal_after_notify_is_lost() {
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
                id: "session-live-signal-recovery".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Live signal recovery".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        runtime
            .inner
            .store
            .ensure_thread(crate::memory::NewThread {
                id: "thread-live-signal-recovery".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                session_id: "session-live-signal-recovery".to_string(),
                initiating_principal_id: None,
                root_turn_id: "root-live-signal-recovery".to_string(),
                kind: crate::memory::ThreadKind::Execution,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: crate::memory::ThreadSupervision::runtime("signal-recovery-test"),
            })
            .await
            .unwrap();
        let event = Event::new(
            "event-live-signal-recovery".to_string(),
            "Runtime-Test".to_string(),
            crate::event::TYPE_TOOL_OUTPUT.to_string(),
            "chat/schedule_due".to_string(),
            json!({
                "agent_id": runtime.identity().agent_id,
                "context_id": runtime.identity().context_id,
                "session_id": "session-live-signal-recovery",
                "root_turn_id": "root-live-signal-recovery",
                "intent": "recover this committed Signal without restarting",
                "text": "SCHEDULE_DUE: recover live signal"
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        runtime
            .inner
            .store
            .append_to_thread(event, "thread-live-signal-recovery")
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 4);

        assert_eq!(
            runtime
                .inner
                .orchestrator
                .reconcile_runnable_pending_thread_signals()
                .await
                .unwrap(),
            1
        );
        let reply = tokio::time::timeout(std::time::Duration::from_secs(3), replies.recv())
            .await
            .expect("runtime rescan must execute a Signal after its notify was lost")
            .unwrap();
        assert_eq!(reply.payload["text"], "runtime-ok");
    }

    #[tokio::test]
    async fn live_runtime_routes_background_session_wake_through_the_dialogue_router() {
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
        let session_id = "session-live-background-wake";
        runtime
            .ensure_session(NewSession {
                id: session_id.to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Live background wake".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let event = Event::new(
            "event-live-background-wake".to_string(),
            "System-TaskMonitor".to_string(),
            crate::event::TYPE_RUNTIME_WAKE.to_string(),
            "runtime/background_wake".to_string(),
            json!({
                "agent_id": runtime.identity().agent_id,
                "context_id": runtime.identity().context_id,
                "session_id": session_id,
                "wake_kind": "terminal_result",
                "event": "background_task_terminal",
                "text": "deliver this terminal background result"
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        let thread = runtime
            .inner
            .store
            .ensure_thread(crate::memory::NewThread {
                id: crate::memory::stable_thread_id(&event.id),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                session_id: session_id.to_string(),
                initiating_principal_id: None,
                root_turn_id: event.id.clone(),
                kind: crate::memory::ThreadKind::DialogueTurn,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: crate::memory::ThreadSupervision::runtime("dialogue-router"),
            })
            .await
            .unwrap();
        runtime
            .inner
            .store
            .append_to_thread(event.clone(), &thread.id)
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 4);

        runtime
            .inner
            .bus
            .dispatch_persisted(event.clone())
            .await
            .unwrap();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(3), replies.recv())
            .await
            .expect("a live Runtime Wake must enter the production dialogue router")
            .unwrap();
        assert_eq!(reply.payload["text"], "runtime-ok");
        let signals = runtime
            .inner
            .store
            .list_context_thread_signals(
                &runtime.identity().context_id,
                Some(ThreadSignalStatus::Acknowledged),
            )
            .await
            .unwrap();
        assert!(signals.iter().any(|signal| signal.event_id == event.id));
    }

    #[tokio::test]
    async fn restart_recovers_background_wake_before_following_user_signal_without_starvation() {
        let database = NamedTempFile::new().unwrap();
        let config = AppConfig::default();
        let tool_policy = RuntimeToolPolicy {
            context_only: true,
            coding_eval: true,
        };
        let crashed_runtime = MorphzRuntime::builder(config.clone(), Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .tool_policy(tool_policy)
            .build()
            .await
            .unwrap();
        crashed_runtime
            .ensure_agent(NewAgent {
                id: crashed_runtime.identity().agent_id.clone(),
                title: "Restart background wake agent".to_string(),
                root_context_id: crashed_runtime.identity().context_id.clone(),
            })
            .await
            .unwrap();
        crashed_runtime
            .ensure_context(NewCognitiveContext {
                id: crashed_runtime.identity().context_id.clone(),
                agent_id: crashed_runtime.identity().agent_id.clone(),
                title: "Restart background wake context".to_string(),
            })
            .await
            .unwrap();
        let session_id = "session-restart-background-wake";
        crashed_runtime
            .ensure_session(NewSession {
                id: session_id.to_string(),
                agent_id: crashed_runtime.identity().agent_id.clone(),
                context_id: crashed_runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Restart background wake".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let wake = Event::new(
            "event-restart-background-wake".to_string(),
            "System-TaskMonitor".to_string(),
            crate::event::TYPE_RUNTIME_WAKE.to_string(),
            "runtime/background_wake".to_string(),
            json!({
                "agent_id": crashed_runtime.identity().agent_id,
                "context_id": crashed_runtime.identity().context_id,
                "session_id": session_id,
                "wake_kind": "terminal_result",
                "event": "background_task_terminal",
                "text": "recover this terminal background result"
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        let thread = crashed_runtime
            .inner
            .store
            .ensure_thread(crate::memory::NewThread {
                id: crate::memory::stable_thread_id(&wake.id),
                agent_id: crashed_runtime.identity().agent_id.clone(),
                context_id: crashed_runtime.identity().context_id.clone(),
                session_id: session_id.to_string(),
                initiating_principal_id: None,
                root_turn_id: wake.id.clone(),
                kind: crate::memory::ThreadKind::DialogueTurn,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: crate::memory::ThreadSupervision::runtime("dialogue-router"),
            })
            .await
            .unwrap();
        crashed_runtime
            .inner
            .store
            .append_to_thread(wake.clone(), &thread.id)
            .await
            .unwrap();
        let user_message = Event::new(
            "event-after-restart-background-wake".to_string(),
            "User".to_string(),
            crate::event::TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            json!({
                "agent_id": crashed_runtime.identity().agent_id,
                "context_id": crashed_runtime.identity().context_id,
                "session_id": session_id,
                "text": "this later message must not stay behind the Runtime Wake"
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        crashed_runtime
            .inner
            .store
            .append_to_thread(user_message.clone(), &thread.id)
            .await
            .unwrap();
        drop(crashed_runtime);

        let recovered_runtime = MorphzRuntime::builder(config, Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .tool_policy(tool_policy)
            .build()
            .await
            .unwrap();
        let mut replies = recovered_runtime.subscribe("chat/reply", 4);
        recovered_runtime.start().await.unwrap();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(3), replies.recv())
            .await
            .expect("startup recovery must consume the oldest Runtime Wake")
            .unwrap();
        assert_eq!(reply.payload["text"], "runtime-ok");

        let acknowledged = recovered_runtime
            .inner
            .store
            .list_context_thread_signals(
                &recovered_runtime.identity().context_id,
                Some(ThreadSignalStatus::Acknowledged),
            )
            .await
            .unwrap();
        assert!(acknowledged.iter().any(|signal| signal.event_id == wake.id));
        assert!(
            acknowledged
                .iter()
                .any(|signal| signal.event_id == user_message.id),
            "the wake Activation must consume the later mailbox Signal instead of leaving it starved"
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(150), replies.recv())
                .await
                .is_err(),
            "the recovered Signal batch must produce exactly one reply"
        );
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

    #[cfg(feature = "experimental-cognitive-coordination")]
    #[tokio::test]
    async fn optional_coordination_keychain_failure_does_not_block_local_runtime_startup() {
        struct UnavailableNativeSecretBackend;

        impl crate::secret_store::SecretValueBackend for UnavailableNativeSecretBackend {
            fn backend_id(&self) -> &'static str {
                "unavailable_native_test"
            }

            fn storage_kind(&self) -> &'static str {
                "native_keyring"
            }

            fn put(&self, _locator: &str, _value: &str) -> Result<(), String> {
                Ok(())
            }

            fn get(&self, _locator: &str) -> Result<Option<String>, String> {
                Err("native authorization was not completed".to_string())
            }

            fn delete(&self, _locator: &str) -> Result<bool, String> {
                Ok(true)
            }
        }

        let directory = tempfile::tempdir().unwrap();
        let secret_store = Arc::new(
            SecretStore::new(
                directory.path().join("managed-secrets.json"),
                Arc::new(UnavailableNativeSecretBackend),
            )
            .unwrap(),
        );
        secret_store
            .put(
                crate::experimental::cognitive_coordination_identity::NODE_IDENTITY_SECRET_ALIAS,
                "opaque-test-identity",
                crate::secret_store::SecretScopeKind::Runtime,
                None,
            )
            .unwrap();

        let database = NamedTempFile::new().unwrap();
        let sqlite = Arc::new(
            SqliteStore::new(database.path().to_str().unwrap())
                .await
                .unwrap(),
        );
        let mut config = AppConfig::default();
        config
            .experimental
            .enabled
            .insert(crate::experimental::COGNITIVE_COORDINATION.to_string());
        config.experimental.cognitive_coordination.mesh =
            Some("static:http://127.0.0.1:9".to_string());
        config.experimental.cognitive_coordination.participant = Some(Default::default());

        let runtime = MorphzRuntime::builder(config, Arc::new(ReplyClient))
            .store(
                "sqlite:optional-coordination-secret-test",
                sqlite as Arc<dyn RuntimeStore>,
            )
            .secret_store(secret_store)
            .build()
            .await
            .unwrap();

        assert!(runtime.cognitive_coordination_network().is_none());
    }

    #[tokio::test]
    async fn trajectory_verifier_and_reward_facts_are_durable_idempotent_and_exportable() {
        let database = NamedTempFile::new().unwrap();
        let sqlite = Arc::new(
            SqliteStore::new(database.path().to_str().unwrap())
                .await
                .unwrap(),
        );
        let runtime = MorphzRuntime::builder(AppConfig::default(), Arc::new(ReplyClient))
            .store(
                "sqlite:trajectory-loop-test",
                Arc::clone(&sqlite) as Arc<dyn RuntimeStore>,
            )
            .build()
            .await
            .unwrap();
        let context_id = "trajectory-loop-context";
        let evidence = Event::new(
            "trajectory-loop-evidence".to_string(),
            "Runtime-Test".to_string(),
            "evidence".to_string(),
            "runtime/yao/evidence".to_string(),
            serde_json::json!({"context_id": context_id})
                .as_object()
                .unwrap()
                .clone(),
        );
        sqlite.append(evidence.clone()).await.unwrap();
        let input = crate::trajectory::CommitVerifierResult {
            context_id: context_id.to_string(),
            session_id: None,
            objective_id: None,
            verifier: "runtime-test".to_string(),
            verifier_version: "1".to_string(),
            checked_property: "evidence exists".to_string(),
            evidence_refs: vec![evidence.id.clone()],
            status: "pass".to_string(),
            output: serde_json::json!({"checked": true}),
            producer: "Verifier-RuntimeTest".to_string(),
        };
        let first = runtime
            .commit_trajectory_verifier_result(input.clone())
            .await
            .unwrap();
        let replayed = runtime
            .commit_trajectory_verifier_result(input)
            .await
            .unwrap();
        assert_eq!(first.id, replayed.id);

        let reward = runtime
            .commit_trajectory_reward_record(crate::trajectory::CommitRewardRecord {
                context_id: context_id.to_string(),
                session_id: None,
                objective_id: None,
                policy: "binary-verifier".to_string(),
                policy_version: "1".to_string(),
                sources: vec![first.id.clone()],
                scope: context_id.to_string(),
                attribution_target: evidence.id.clone(),
                signal_type: "scalar".to_string(),
                value: serde_json::json!(1.0),
                aggregation: "identity".to_string(),
                producer: "RewardPolicy-RuntimeTest".to_string(),
                timing: "retrospective".to_string(),
            })
            .await
            .unwrap();
        assert_eq!(reward.topic, "runtime/trajectory/reward");
        let bundle = crate::trajectory::AgentTrajectoryExporter::export(
            &runtime,
            crate::trajectory::TrajectoryExportRequest {
                context_id: context_id.to_string(),
                objective_id: None,
                activation_id: None,
                start_time: None,
                end_time: None,
                max_events: 100,
                profiles: vec!["AT-Core".to_string(), "AT-Evaluation".to_string()],
                include_payloads: true,
                include_user_content: false,
                rights: crate::trajectory::TrajectoryRights::default(),
            },
        )
        .await
        .unwrap();
        assert_eq!(bundle.verifier_results.len(), 1);
        assert_eq!(bundle.reward_records.len(), 1);
        assert!(bundle.verify().valid);
    }

    #[tokio::test]
    async fn production_tool_contracts_are_english_only() {
        let database = NamedTempFile::new().unwrap();
        let sqlite = Arc::new(
            SqliteStore::new(database.path().to_str().unwrap())
                .await
                .unwrap(),
        );
        let runtime = MorphzRuntime::builder(AppConfig::default(), Arc::new(ReplyClient))
            .store(
                "sqlite:english-tool-contract-test",
                sqlite as Arc<dyn RuntimeStore>,
            )
            .build()
            .await
            .unwrap();

        let mut violations = Vec::new();
        for definition in runtime.inner.registry.definitions() {
            if contains_cjk(&definition.description) {
                violations.push(format!(
                    "tool '{}' description: {}",
                    definition.name, definition.description
                ));
            }
            let schema = definition.parameters.to_string();
            if contains_cjk(&schema) {
                violations.push(format!("tool '{}' schema: {}", definition.name, schema));
            }
        }
        assert!(violations.is_empty(), "{}", violations.join("\n"));
    }

    #[tokio::test]
    async fn read_only_context_configuration_omits_context_tx_from_production_registry() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.orchestrator.context_transactions_enabled = false;
        let runtime = MorphzRuntime::builder(config, Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .build()
            .await
            .unwrap();

        assert!(!runtime
            .inner
            .registry
            .definitions()
            .iter()
            .any(|definition| definition.name == "context_tx"));
    }

    #[tokio::test]
    async fn automatic_review_uses_the_independent_reviewer_client() {
        let database = NamedTempFile::new().unwrap();
        let reviewer = Arc::new(ReviewerDecisionClient {
            calls: AtomicU64::new(0),
        });
        let runtime = MorphzRuntime::builder(AppConfig::default(), Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .reviewer_client(reviewer.clone())
            .build()
            .await
            .unwrap();
        let decision = runtime
            .review_edge_tool_permission(&ApprovalRequest {
                approval_id: "approval-independent-reviewer".to_string(),
                context_id: runtime.identity().context_id.clone(),
                session_id: "session-independent-reviewer".to_string(),
                attempt_id: "attempt-independent-reviewer".to_string(),
                thread_id: "thread-independent-reviewer".to_string(),
                root_turn_id: "turn-independent-reviewer".to_string(),
                trigger_event_id: "event-independent-reviewer".to_string(),
                trigger_sequence: 1,
                action: crate::approval::ApprovalAction::ToolOperation {
                    tool: "read".to_string(),
                    operation: "read".to_string(),
                    target: Some(PathBuf::from("/outside/workspace")),
                },
                requested: crate::approval::CapabilityDelta {
                    read_roots: vec![PathBuf::from("/outside")],
                    ..Default::default()
                },
                justification: "verify the independent reviewer route".to_string(),
                lease_offer: None,
            })
            .await
            .unwrap();
        assert!(matches!(decision, ApprovalDecision::AllowOnce { .. }));
        assert_eq!(reviewer.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn new_message_interrupts_a_thinking_dialogue_and_replays_both_inputs() {
        let database = NamedTempFile::new().unwrap();
        let artifacts = tempfile::tempdir().unwrap();
        let first_entered = Arc::new(tokio::sync::Notify::new());
        let observed_combined_input = Arc::new(AtomicBool::new(false));
        let observed_interrupted_attachment = Arc::new(AtomicBool::new(false));
        let client = Arc::new(InterruptibleDialogueClient {
            calls: AtomicU64::new(0),
            first_entered: first_entered.clone(),
            observed_combined_input: observed_combined_input.clone(),
            observed_interrupted_attachment: observed_interrupted_attachment.clone(),
        });
        let mut config = AppConfig::default();
        config.orchestrator.interrupt_dialogue_on_new_message = true;
        config.background_task.artifact_dir = artifacts.path().to_string_lossy().into_owned();
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
                id: "session-dialogue-interruption-e2e".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Dialogue interruption E2E".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        runtime.bind_default_principal(&session.id).await.unwrap();
        let mut replies = runtime.subscribe("chat/reply", 4);
        let first = session
            .send_as_principal_with_options(
                "first unfinished message",
                "User-Test",
                runtime.identity().principal_id.clone(),
                Some("client-dialogue-interruption-a".to_string()),
                SessionMessageOptions {
                    attachments: vec![MessageAttachmentInput {
                        name: "interrupted-image.png".to_string(),
                        media_type: "image/png".to_string(),
                        data: b"interrupted-image-bytes".to_vec(),
                    }],
                    dispatch_mode: Some(MessageDispatchMode::Interrupt),
                    ..SessionMessageOptions::default()
                },
            )
            .await
            .unwrap();
        assert!(!first.interrupted);
        tokio::time::timeout(std::time::Duration::from_secs(2), first_entered.notified())
            .await
            .expect("first model request did not start");

        let second = session
            .send(
                "second clarifying message",
                "User-Test",
                Some("client-dialogue-interruption-b".to_string()),
            )
            .await
            .unwrap();
        assert!(second.interrupted);
        let reply = tokio::time::timeout(std::time::Duration::from_secs(5), replies.recv())
            .await
            .expect("replacement DialogueTurn did not reply")
            .unwrap();
        assert_eq!(reply.payload["text"], "combined-dialogue-reply");
        assert!(observed_combined_input.load(Ordering::SeqCst));
        assert!(observed_interrupted_attachment.load(Ordering::SeqCst));
        assert_eq!(client.calls.load(Ordering::SeqCst), 2);

        let attempt_states = runtime
            .query_events(QueryFilter {
                session_id: Some(session.id.clone()),
                topic: Some("runtime/model_attempt_state".to_string()),
                top_k: Some(100),
                ..QueryFilter::default()
            })
            .await
            .unwrap();
        assert!(attempt_states.iter().any(|event| {
            event.payload["state"] == "cancelled"
                && event.payload["terminal"] == true
                && event.payload["thread_kind"] == "dialogue_turn"
        }));
    }

    #[tokio::test]
    async fn unconfigured_runtime_exposes_no_invented_models() {
        let database = NamedTempFile::new().unwrap();
        let runtime = MorphzRuntime::builder(AppConfig::default(), Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .build()
            .await
            .unwrap();

        assert!(runtime.model().is_empty());
        assert!(runtime.configured_models().is_empty());
        assert!(runtime.inference_model_options().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn explicit_routes_are_selectable_without_duplicate_service_model_entries() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.llm.model = "configured-route".to_string();
        config.provider_instances.insert(
            "configured-service".to_string(),
            crate::config::ProviderInstanceConfig {
                adapter: "protocol-compatible".to_string(),
                protocol: crate::config::ModelProtocol::OpenaiResponses,
                base_url: "https://models.example.test/v1".to_string(),
                accounts: vec!["configured-account".to_string()],
                ..crate::config::ProviderInstanceConfig::default()
            },
        );
        config.auth_accounts.insert(
            "configured-account".to_string(),
            AuthAccountConfig {
                auth_adapter: "none".to_string(),
                provider: Some("configured-service".to_string()),
                ..AuthAccountConfig::default()
            },
        );
        config.model_routes.insert(
            "configured-route".to_string(),
            crate::config::ModelRouteConfig {
                candidates: vec![crate::config::ModelRouteCandidateConfig {
                    provider: "configured-service".to_string(),
                    account: Some("configured-account".to_string()),
                    model: "physical-model".to_string(),
                    ..crate::config::ModelRouteCandidateConfig::default()
                }],
                ..crate::config::ModelRouteConfig::default()
            },
        );

        let runtime = MorphzRuntime::builder(config, Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .build()
            .await
            .unwrap();
        let options = runtime.inference_model_options().await.unwrap();

        assert_eq!(options.len(), 1);
        assert_eq!(options[0].id, "configured-route");
        assert_eq!(options[0].label, "physical-model");
        assert_eq!(options[0].physical_models, ["physical-model"]);
        assert_eq!(options[0].source, "configured");
    }

    #[tokio::test]
    async fn one_shot_message_model_is_persisted_on_its_root_event_without_mutating_session() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.llm.model = "primary-route".to_string();
        config.provider_instances.insert(
            "configured-service".to_string(),
            crate::config::ProviderInstanceConfig {
                adapter: "protocol-compatible".to_string(),
                protocol: crate::config::ModelProtocol::OpenaiResponses,
                base_url: "https://models.example.test/v1".to_string(),
                accounts: vec!["configured-account".to_string()],
                ..crate::config::ProviderInstanceConfig::default()
            },
        );
        config.auth_accounts.insert(
            "configured-account".to_string(),
            AuthAccountConfig {
                auth_adapter: "none".to_string(),
                provider: Some("configured-service".to_string()),
                ..AuthAccountConfig::default()
            },
        );
        for (alias, physical_model) in [
            ("primary-route", "physical-primary"),
            ("one-shot-route", "physical-one-shot"),
        ] {
            config.model_routes.insert(
                alias.to_string(),
                crate::config::ModelRouteConfig {
                    candidates: vec![crate::config::ModelRouteCandidateConfig {
                        provider: "configured-service".to_string(),
                        account: Some("configured-account".to_string()),
                        model: physical_model.to_string(),
                        ..crate::config::ModelRouteCandidateConfig::default()
                    }],
                    ..crate::config::ModelRouteConfig::default()
                },
            );
        }

        let runtime = MorphzRuntime::builder(config, Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        let session = runtime
            .ensure_session(NewSession {
                id: "session-one-shot-model".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "One-shot model".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        runtime.bind_default_principal(&session.id).await.unwrap();
        let receipt = session
            .send_as_principal_with_options(
                "evaluate once with another route",
                "User-Test",
                runtime.identity().principal_id.clone(),
                Some("client-one-shot-model".to_string()),
                SessionMessageOptions {
                    model_alias: Some("one-shot-route".to_string()),
                    reasoning_effort: Some("high".to_string()),
                    ..SessionMessageOptions::default()
                },
            )
            .await
            .unwrap();
        let events = runtime
            .query_events(QueryFilter {
                event_id: Some(receipt.event_id),
                ..QueryFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].payload["model_alias"], "one-shot-route");
        assert_eq!(events[0].payload["reasoning_effort"], "high");
        assert_eq!(
            runtime
                .get_session(&session.id)
                .await
                .unwrap()
                .unwrap()
                .model_alias,
            None,
            "a one-shot Evaluation model must not mutate the Session default"
        );
        assert_eq!(
            runtime
                .get_session(&session.id)
                .await
                .unwrap()
                .unwrap()
                .reasoning_effort,
            None,
            "a one-shot reasoning effort must not mutate the Session default"
        );

        let error = session
            .send_as_principal_with_options(
                "reject an unknown route",
                "User-Test",
                runtime.identity().principal_id.clone(),
                Some("client-unknown-one-shot-model".to_string()),
                SessionMessageOptions {
                    model_alias: Some("missing-route".to_string()),
                    ..SessionMessageOptions::default()
                },
            )
            .await
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("is not present in the discovered and enabled model catalog"));
    }

    #[tokio::test]
    async fn concurrent_sessions_bind_new_dialogue_threads_to_distinct_requested_targets() {
        let database = NamedTempFile::new().unwrap();
        let runtime = MorphzRuntime::builder(AppConfig::default(), Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        let principal_id = runtime.identity().principal_id.clone();
        for target_id in ["edge-session-a", "edge-session-b"] {
            runtime
                .register_execution_target(crate::memory::ExecutionTargetRegistration {
                    id: target_id.to_string(),
                    owner_principal_id: Some(principal_id.clone()),
                    provider_node_id: None,
                    kind: crate::memory::ExecutionTargetKind::EdgeNode,
                    name: target_id.to_string(),
                    status: crate::memory::ExecutionTargetStatus::Online,
                    platform: Some("linux-x86_64".to_string()),
                    workspace_root: None,
                    capabilities: vec!["exec".to_string()],
                    metadata: json!({"test": "message_ingress_target_affinity"}),
                    policy_digest: format!("policy-{target_id}"),
                    last_seen_at: Some(chrono::Utc::now()),
                })
                .await
                .unwrap();
        }
        let session_a = runtime
            .ensure_session(NewSession {
                id: "session-target-a".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Target A".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let session_b = runtime
            .ensure_session(NewSession {
                id: "session-target-b".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Target B".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        runtime.bind_default_principal(&session_a.id).await.unwrap();
        runtime.bind_default_principal(&session_b.id).await.unwrap();

        let (receipt_a, receipt_b) = tokio::join!(
            session_a.send_as_principal_with_options(
                "work only on target A",
                "User-Test",
                principal_id.clone(),
                Some("client-target-a".to_string()),
                SessionMessageOptions {
                    target_id: Some("edge-session-a".to_string()),
                    ..SessionMessageOptions::default()
                },
            ),
            session_b.send_as_principal_with_options(
                "work only on target B",
                "User-Test",
                principal_id.clone(),
                Some("client-target-b".to_string()),
                SessionMessageOptions {
                    target_id: Some("edge-session-b".to_string()),
                    ..SessionMessageOptions::default()
                },
            )
        );
        let receipt_a = receipt_a.unwrap();
        let receipt_b = receipt_b.unwrap();
        let (thread_a, thread_b) = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let thread_a = runtime
                    .inner
                    .store
                    .get_thread_by_root(&receipt_a.event_id)
                    .await
                    .unwrap();
                let thread_b = runtime
                    .inner
                    .store
                    .get_thread_by_root(&receipt_b.event_id)
                    .await
                    .unwrap();
                if let (Some(thread_a), Some(thread_b)) = (thread_a, thread_b) {
                    break (thread_a, thread_b);
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("both Dialogue Threads were not persisted");
        assert_eq!(thread_a.target_id.as_deref(), Some("edge-session-a"));
        assert_eq!(thread_b.target_id.as_deref(), Some("edge-session-b"));
        assert_ne!(thread_a.target_id, thread_b.target_id);

        for (event_id, target_id) in [
            (&receipt_a.event_id, "edge-session-a"),
            (&receipt_b.event_id, "edge-session-b"),
        ] {
            let event = runtime
                .query_events(QueryFilter {
                    event_id: Some(event_id.clone()),
                    ..QueryFilter::default()
                })
                .await
                .unwrap()
                .pop()
                .unwrap();
            assert_eq!(event.payload["target_id"], target_id);
        }
    }

    #[tokio::test]
    async fn message_ingress_rejects_missing_offline_and_foreign_targets_before_commit() {
        let database = NamedTempFile::new().unwrap();
        let runtime = MorphzRuntime::builder(AppConfig::default(), Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        let principal_id = runtime.identity().principal_id.clone();
        for (target_id, owner, status) in [
            (
                "edge-offline",
                principal_id.as_str(),
                crate::memory::ExecutionTargetStatus::Offline,
            ),
            (
                "edge-foreign",
                "principal-foreign",
                crate::memory::ExecutionTargetStatus::Online,
            ),
        ] {
            runtime
                .register_execution_target(crate::memory::ExecutionTargetRegistration {
                    id: target_id.to_string(),
                    owner_principal_id: Some(owner.to_string()),
                    provider_node_id: None,
                    kind: crate::memory::ExecutionTargetKind::EdgeNode,
                    name: target_id.to_string(),
                    status,
                    platform: None,
                    workspace_root: None,
                    capabilities: vec!["exec".to_string()],
                    metadata: json!({}),
                    policy_digest: format!("policy-{target_id}"),
                    last_seen_at: Some(chrono::Utc::now()),
                })
                .await
                .unwrap();
        }
        let session = runtime
            .ensure_session(NewSession {
                id: "session-target-rejections".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Target rejections".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        runtime.bind_default_principal(&session.id).await.unwrap();

        for (index, target_id, expected) in [
            (1, "edge-missing", "does not exist"),
            (2, "edge-offline", "is not online"),
            (3, "edge-foreign", "cannot route"),
        ] {
            let error = session
                .send_as_principal_with_options(
                    "this message must not commit",
                    "User-Test",
                    principal_id.clone(),
                    Some(format!("client-target-rejection-{index}")),
                    SessionMessageOptions {
                        target_id: Some(target_id.to_string()),
                        ..SessionMessageOptions::default()
                    },
                )
                .await
                .unwrap_err();
            assert!(error.to_string().contains(expected), "{error}");
        }
        let events = runtime
            .query_events(QueryFilter {
                session_id: Some(session.id.clone()),
                topic: Some(TYPE_USER_MESSAGE.to_string()),
                ..QueryFilter::default()
            })
            .await
            .unwrap();
        assert!(events.is_empty());
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
        assert!(acknowledged.event_sequence > 0);
        assert_eq!(records, vec![acknowledged.clone()]);
        let empty_delta = runtime
            .attention_acknowledgements_page(&context_id, Some(acknowledged.event_sequence), 10)
            .await
            .unwrap();
        assert!(empty_delta.acknowledgements.is_empty());
        assert_eq!(empty_delta.latest_sequence, acknowledged.event_sequence);

        let second = runtime
            .acknowledge_attention(
                &context_id,
                AcknowledgeAttentionCommand {
                    key: "thread:thread-2:r1:failed".to_string(),
                    source_kind: "thread".to_string(),
                    source_id: "thread-2".to_string(),
                    source_revision: 1,
                    rationale: None,
                },
            )
            .await
            .unwrap();
        let delta = runtime
            .attention_acknowledgements_page(&context_id, Some(acknowledged.event_sequence), 10)
            .await
            .unwrap();
        assert_eq!(delta.acknowledgements, vec![second.clone()]);
        assert_eq!(delta.latest_sequence, second.event_sequence);
        assert!(!delta.has_more);
        let initial_page = runtime
            .attention_acknowledgements_page(&context_id, None, 1)
            .await
            .unwrap();
        assert_eq!(initial_page.acknowledgements, vec![second]);
        assert!(initial_page.has_more);

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
    impl Client for InterruptibleDialogueClient {
        async fn create_completion(
            &self,
            messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call == 0 {
                self.first_entered.notify_one();
                return std::future::pending().await;
            }
            let prompt = messages
                .iter()
                .map(|message| message.content.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            self.observed_combined_input.store(
                prompt.contains("first unfinished message")
                    && prompt.contains("second clarifying message")
                    && prompt.find("first unfinished message")
                        < prompt.find("second clarifying message"),
                Ordering::SeqCst,
            );
            self.observed_interrupted_attachment.store(
                messages.iter().any(|message| {
                    crate::llm::model_attachments(message).is_some_and(|attachments| {
                        attachments.iter().any(|attachment| {
                            attachment.name == "interrupted-image.png"
                                && attachment.media_type == "image/png"
                                && base64::engine::general_purpose::STANDARD
                                    .decode(&attachment.data_base64)
                                    .is_ok_and(|data| data == b"interrupted-image-bytes")
                        })
                    })
                }),
                Ordering::SeqCst,
            );
            Ok(text_response("combined-dialogue-reply"))
        }
    }

    #[async_trait::async_trait]
    impl Client for PhysicalBatchClient {
        fn prefers_structured_delta_cache_transport(&self, _requested_model: Option<&str>) -> bool {
            cfg!(feature = "experimental-structured-context-delta-cache")
        }

        async fn create_completion(
            &self,
            messages: Vec<Message>,
            tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            self.requests
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(messages.clone());
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
                let complete = if cfg!(feature = "experimental-structured-context-delta-cache") {
                    let deltas = messages
                        .get(1)
                        .and_then(crate::llm::segmented_model_text)
                        .map(|content| {
                            content
                                .parts
                                .into_iter()
                                .skip(1)
                                .map(|part| part.text)
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    messages.len() == 2
                        && deltas.len() == 2
                        && deltas.iter().any(|delta| delta.contains("probe-a"))
                        && deltas.iter().any(|delta| delta.contains("probe-b"))
                        && deltas.iter().all(|delta| delta.contains("context-delta"))
                } else {
                    let delivered_tool_results = messages
                        .iter()
                        .filter(|message| message.role == "tool")
                        .filter_map(|message| message.tool_call_id.as_deref())
                        .collect::<std::collections::HashSet<_>>();
                    delivered_tool_results.len() == 2
                        && delivered_tool_results.contains("probe-a")
                        && delivered_tool_results.contains("probe-b")
                };
                self.observed_complete_batch
                    .store(complete, Ordering::SeqCst);
                if !complete {
                    return Err(
                        "model resumed before the full physical tool batch was durable".into(),
                    );
                }
                return Ok(Response {
                    content: String::new(),
                    tool_calls: vec![ToolCallRepr {
                        id: "probe-c".to_string(),
                        r#type: "function".to_string(),
                        func_name: "list_files".to_string(),
                        arguments: json!({
                            "path": ".",
                            "glob": "README.md",
                            "max_results": 10
                        })
                        .to_string(),
                    }],
                });
            }
            if call == 2 {
                let complete = if cfg!(feature = "experimental-structured-context-delta-cache") {
                    let deltas = messages
                        .get(1)
                        .and_then(crate::llm::segmented_model_text)
                        .map(|content| {
                            content
                                .parts
                                .into_iter()
                                .skip(1)
                                .map(|part| part.text)
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    messages.len() == 2
                        && deltas.len() == 3
                        && ["probe-a", "probe-b", "probe-c"]
                            .iter()
                            .all(|id| deltas.iter().any(|delta| delta.contains(id)))
                } else {
                    let delivered_tool_results = messages
                        .iter()
                        .filter(|message| message.role == "tool")
                        .filter_map(|message| message.tool_call_id.as_deref())
                        .collect::<std::collections::HashSet<_>>();
                    // The default path recompiles one current canonical
                    // Context containing probe-a/probe-b Observations. Only
                    // the current native continuation (probe-c) remains a
                    // separate assistant/tool pair.
                    messages.len() == 4
                        && messages.get(2).is_some_and(|message| {
                            message.role == "assistant"
                                && message.tool_calls.as_ref().is_some_and(|calls| {
                                    calls.len() == 1 && calls[0].id == "probe-c"
                                })
                        })
                        && delivered_tool_results.len() == 1
                        && delivered_tool_results.contains("probe-c")
                };
                self.observed_complete_batch
                    .store(complete, Ordering::SeqCst);
                if !complete {
                    return Err("structured cache transport lost a prior tool result".into());
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
                                    "(eval (requires (tools read)) (seq (bind body (call read (path {quoted_path}))) body))"
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
            tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            self.observed_tool_schemas.lock().unwrap().push(
                tools
                    .iter()
                    .map(|tool| tool.name.clone())
                    .collect::<Vec<_>>(),
            );
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
                        tool_text.contains("Tool execution rejected")
                            && tool_text.contains("approval did not authorize")
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
        ) -> Result<
            Box<crate::tool::ToolExecutionResult>,
            crate::execution_target::TargetExecutionError,
        > {
            let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
            Ok(crate::tool::ToolExecutionResult::text(format!(
                "managed-ssh-result-{call}"
            )))
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
                    let observed = tool_text.contains("Tool execution rejected")
                        && tool_text.contains("PROTECTED_PATH")
                        && tool_text.contains("protected_paths")
                        && tool_text.contains("did not start");
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

    struct ObjectiveCompletionRecoveryClient {
        calls: AtomicU64,
        observed_repaired_receipt: AtomicBool,
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
                // Keep every Activation shorter than the Objective heartbeat,
                // while making the whole Evaluation cross multiple lease
                // windows. This reproduces the production pattern of many
                // quick tool/no-reply continuations.
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
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
    impl Client for ObjectiveCompletionRecoveryClient {
        async fn create_completion(
            &self,
            messages: Vec<Message>,
            tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            if self.calls.fetch_add(1, Ordering::SeqCst) != 0 {
                return Err("completion recovery produced an extra model evaluation".into());
            }
            let transcript = serde_json::to_string(&messages)?;
            let observed_prepared_status = transcript.contains("completion_prepared");
            let observed_receipt =
                transcript.contains("The Runtime persisted your Objective completion decision");
            let observed_finalization_tools =
                !tools.is_empty() && tools.iter().all(|tool| tool.name == "no_reply");
            let observed =
                observed_prepared_status && observed_receipt && observed_finalization_tools;
            self.observed_repaired_receipt
                .store(observed, Ordering::SeqCst);
            if !observed {
                let diagnostic = format!(
                    "completion recovery did not reconstruct the finalization protocol: \
                     prepared_status={observed_prepared_status}, receipt={observed_receipt}, \
                     finalization_tools={observed_finalization_tools}, tools={:?}",
                    tools
                        .iter()
                        .map(|tool| tool.name.as_str())
                        .collect::<Vec<_>>()
                );
                eprintln!("{diagnostic}");
                return Err(diagnostic.into());
            }
            Ok(text_response("recovered-completion-final-report"))
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
                // Ordinary work requests expose a stable schema even though
                // Runtime admission allows only objective_update for this
                // bound Objective.
                assert!(tools.iter().any(|tool| tool.name == "objective_amend"));
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
            assert!(!tools.iter().any(|tool| tool.name == "objective_amend"));
            Ok(text_response("objective-complete"))
        }
    }

    #[tokio::test]
    async fn durable_turn_reply_waiter_bypasses_business_saturation_and_fences_root() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.orchestrator.event_bus.max_in_flight = 1;
        let runtime = MorphzRuntime::builder(config, Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();

        let blocker_started = Arc::new(tokio::sync::Notify::new());
        let blocker_release = Arc::new(tokio::sync::Notify::new());
        let started = Arc::clone(&blocker_started);
        let release = Arc::clone(&blocker_release);
        runtime.inner.bus.subscribe(
            "runtime/test_reply_blocker".to_string(),
            Arc::new(move |_event| {
                let started = Arc::clone(&started);
                let release = Arc::clone(&release);
                Box::pin(async move {
                    started.notify_one();
                    release.notified().await;
                    Ok(())
                })
            }),
        );
        runtime
            .publish(Event::new(
                "reply-blocker".to_string(),
                "Runtime-Test".to_string(),
                "runtime_control".to_string(),
                "runtime/test_reply_blocker".to_string(),
                serde_json::Map::new(),
            ))
            .await
            .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            blocker_started.notified(),
        )
        .await
        .expect("the only asynchronous business permit should be occupied");

        let stale_reply = Event::new(
            "reply-stale-root".to_string(),
            "Agent-Test".to_string(),
            "agent_call".to_string(),
            "chat/reply".to_string(),
            vec![
                ("context_id".to_string(), json!("context-reply-wait")),
                ("session_id".to_string(), json!("session-reply-wait")),
                ("root_turn_id".to_string(), json!("root-stale")),
                ("text".to_string(), json!("stale")),
            ]
            .into_iter()
            .collect(),
        );
        runtime.publish(stale_reply).await.unwrap();

        let wait_runtime = runtime.clone();
        let waiter = tokio::spawn(async move {
            wait_runtime
                .wait_for_turn_reply(
                    "session-reply-wait",
                    "root-target",
                    std::time::Duration::from_secs(2),
                )
                .await
        });
        // Let the waiter install its synchronous observation boundary and
        // finish the durable preflight before the target commit.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;

        let target_reply = Event::new(
            "reply-target-root".to_string(),
            "Agent-Test".to_string(),
            "agent_call".to_string(),
            "chat/reply".to_string(),
            vec![
                ("context_id".to_string(), json!("context-reply-wait")),
                ("session_id".to_string(), json!("session-reply-wait")),
                ("root_turn_id".to_string(), json!("root-target")),
                ("text".to_string(), json!("target")),
            ]
            .into_iter()
            .collect(),
        );
        tokio::time::timeout(
            std::time::Duration::from_millis(250),
            runtime.publish(target_reply),
        )
        .await
        .expect("a reply observer must not queue behind business admission")
        .unwrap();

        let reply = waiter.await.unwrap().unwrap();
        assert_eq!(reply.id, "reply-target-root");
        assert_eq!(reply.payload["text"], "target");
        blocker_release.notify_waiters();
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
            .ensure_agent(NewAgent {
                id: runtime.identity().agent_id.clone(),
                title: "Scheduler snapshot agent".to_string(),
                root_context_id: runtime.identity().context_id.clone(),
            })
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
                model_alias: None,
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
    async fn scheduler_snapshot_pages_complete_thread_aggregates_without_false_orphans() {
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

        // The history limit pages Thread roots. Once this Thread is selected,
        // all of its durable children belong to the same causal aggregate;
        // independently truncating Activations or Jobs would either lose the
        // fifth result or require point queries to repair its parent edge.
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
        assert_eq!(snapshot.threads[0].activations.len(), 5);
        assert!(snapshot.threads[0].pending_signals.is_empty());
        assert_eq!(snapshot.summary.pending_signals, 0);
        assert!(snapshot.orphan_activations.is_empty());
        assert!(snapshot.orphan_jobs.is_empty());
    }

    #[tokio::test]
    async fn scheduler_snapshot_keeps_exact_counts_when_detail_is_bounded() {
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
                id: "session-scheduler-bounds".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Scheduler bounds".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        for index in 0..3 {
            runtime
                .inner
                .store
                .ensure_thread(crate::memory::NewThread {
                    id: format!("thread-scheduler-bounds-{index}"),
                    agent_id: runtime.identity().agent_id.clone(),
                    context_id: runtime.identity().context_id.clone(),
                    session_id: "session-scheduler-bounds".to_string(),
                    initiating_principal_id: None,
                    root_turn_id: format!("root-scheduler-bounds-{index}"),
                    kind: crate::memory::ThreadKind::Execution,
                    executor_kind: "self".to_string(),
                    executor_id: None,
                    target_id: None,
                    supervision: crate::memory::ThreadSupervision::legacy(),
                })
                .await
                .unwrap();
        }

        let snapshot = runtime
            .scheduler_snapshot(
                runtime.identity().context_id.as_str(),
                SchedulerQuery {
                    include_terminal: false,
                    limit: 1,
                },
            )
            .await
            .unwrap();
        assert_eq!(snapshot.summary.open_threads, 3);
        assert_eq!(snapshot.threads.len(), 1);
        assert_eq!(snapshot.detail_bounds.limit, 1);
        assert!(snapshot.detail_bounds.has_more_threads);
    }

    #[tokio::test]
    async fn scheduler_snapshot_counts_live_rows_whose_terminal_parent_route_disappeared() {
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
                id: "session-scheduler-orphan".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Scheduler orphan audit".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let thread = runtime
            .inner
            .store
            .ensure_thread(crate::memory::NewThread {
                id: "thread-scheduler-orphan".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                session_id: "session-scheduler-orphan".to_string(),
                initiating_principal_id: None,
                root_turn_id: "root-scheduler-orphan".to_string(),
                kind: crate::memory::ThreadKind::Execution,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: crate::memory::ThreadSupervision::legacy(),
            })
            .await
            .unwrap();

        let first = Event::new(
            "event-scheduler-orphan-first".to_string(),
            "User-Test".to_string(),
            "user_message".to_string(),
            "chat/user_message".to_string(),
            json!({
                "context_id": runtime.identity().context_id,
                "session_id": "session-scheduler-orphan",
                "text": "first",
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        runtime.inner.store.append(first.clone()).await.unwrap();
        let first_sequence = runtime
            .inner
            .store
            .query(QueryFilter {
                event_id: Some(first.id.clone()),
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
                    id: "signal-scheduler-orphan-first".to_string(),
                    thread_id: thread.id.clone(),
                    thread_generation: thread.generation,
                    event_id: first.id.clone(),
                    principal_id: None,
                    sequence: first_sequence,
                    kind: first.topic,
                    parent_activation_id: None,
                },
                crate::memory::NewThreadActivation {
                    id: "activation-scheduler-orphan".to_string(),
                    agent_id: runtime.identity().agent_id.clone(),
                    context_id: runtime.identity().context_id.clone(),
                    session_id: "session-scheduler-orphan".to_string(),
                    initiating_principal_id: None,
                    trigger_event_id: first.id,
                    trigger_sequence: first_sequence,
                    trigger_kind: "chat/user_message".to_string(),
                    parent_activation_id: None,
                    root_turn_id: thread.root_turn_id.clone(),
                },
                32,
            )
            .await
            .unwrap()
            .unwrap();

        let second = Event::new(
            "event-scheduler-orphan-second".to_string(),
            "User-Test".to_string(),
            "user_message".to_string(),
            "chat/user_message".to_string(),
            json!({
                "context_id": runtime.identity().context_id,
                "session_id": "session-scheduler-orphan",
                "text": "second",
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        runtime.inner.store.append(second.clone()).await.unwrap();
        let second_sequence = runtime
            .inner
            .store
            .query(QueryFilter {
                event_id: Some(second.id.clone()),
                ..QueryFilter::default()
            })
            .await
            .unwrap()[0]
            .sequence
            .unwrap();
        assert!(runtime
            .inner
            .store
            .claim_thread_signal_batch(
                crate::memory::NewThreadSignal {
                    id: "signal-scheduler-orphan-pending".to_string(),
                    thread_id: thread.id.clone(),
                    thread_generation: thread.generation,
                    event_id: second.id.clone(),
                    principal_id: None,
                    sequence: second_sequence,
                    kind: second.topic,
                    parent_activation_id: None,
                },
                crate::memory::NewThreadActivation {
                    id: "activation-scheduler-orphan-unused".to_string(),
                    agent_id: runtime.identity().agent_id.clone(),
                    context_id: runtime.identity().context_id.clone(),
                    session_id: "session-scheduler-orphan".to_string(),
                    initiating_principal_id: None,
                    trigger_event_id: second.id,
                    trigger_sequence: second_sequence,
                    trigger_kind: "chat/user_message".to_string(),
                    parent_activation_id: None,
                    root_turn_id: thread.root_turn_id.clone(),
                },
                32,
            )
            .await
            .unwrap()
            .is_none());
        runtime
            .inner
            .store
            .update_thread(
                &thread.id,
                thread.revision,
                None,
                Some(crate::memory::ThreadLifecycle::Completed),
                Some("intentionally inconsistent fixture"),
                Some("missing-terminal-event"),
                None,
                None,
            )
            .await
            .unwrap();

        let snapshot = runtime
            .scheduler_snapshot(
                runtime.identity().context_id.as_str(),
                SchedulerQuery::default(),
            )
            .await
            .unwrap();
        assert_eq!(snapshot.orphan_activations.len(), 1);
        assert_eq!(snapshot.orphan_activations[0].activation.id, activation.id);
        assert_eq!(snapshot.orphan_signals.len(), 1);
        assert_eq!(
            snapshot.orphan_signals[0].id,
            "signal-scheduler-orphan-pending"
        );
        assert_eq!(snapshot.summary.pending_signals, 1);
        assert_eq!(snapshot.summary.invariant_violations, 2);
        assert!(snapshot.invariant_violations.iter().any(|violation| {
            violation.code == crate::scheduler::SchedulerInvariantCode::OrphanActivation
        }));
        assert!(snapshot.invariant_violations.iter().any(|violation| {
            violation.code == crate::scheduler::SchedulerInvariantCode::OrphanSignal
        }));
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
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let client = Arc::new(PhysicalBatchClient {
            calls: AtomicU64::new(0),
            observed_complete_batch: Arc::clone(&observed_complete_batch),
            requests: Arc::clone(&requests),
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
        let reply = match tokio::time::timeout(std::time::Duration::from_secs(15), replies.recv())
            .await
        {
            Ok(reply) => reply.unwrap(),
            Err(error) => {
                let request_roles = requests
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .iter()
                    .map(|request| {
                        request
                            .iter()
                            .map(|message| message.role.clone())
                            .collect::<Vec<_>>()
                    })
                    .collect::<Vec<_>>();
                panic!(
                    "physical batch reply timed out after {} model calls; request roles: {request_roles:?}; {error}",
                    client.calls.load(Ordering::SeqCst)
                );
            }
        };
        assert_eq!(reply.payload["text"], "physical-batch-complete");
        assert_eq!(reply.payload["thread_kind"], "execution");
        assert_eq!(reply.payload["delivery_kind"], "turn_reply");
        assert!(observed_complete_batch.load(Ordering::SeqCst));
        assert_eq!(client.calls.load(Ordering::SeqCst), 3);
        let requests = requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[0].len(), 2);
        if cfg!(feature = "experimental-structured-context-delta-cache") {
            assert_eq!(requests[1].len(), 2);
            assert_eq!(requests[2].len(), 2);
            assert_eq!(requests[1][0], requests[2][0]);
            assert_eq!(requests[1][1].role, "user");
            assert_eq!(requests[2][1].role, "user");
            let second = crate::llm::segmented_model_text(&requests[1][1]).unwrap();
            let third = crate::llm::segmented_model_text(&requests[2][1]).unwrap();
            assert_eq!(second.parts.len(), 3);
            assert_eq!(third.parts.len(), 4);
            assert_eq!(second.parts, third.parts[..second.parts.len()]);
            assert!(third.parts[1..]
                .iter()
                .all(|part| part.text.contains("context-delta")));
        } else {
            assert_eq!(requests[1].len(), 5);
            assert_eq!(requests[2].len(), 4);
            assert_eq!(requests[1][0], requests[2][0]);
            assert_eq!(requests[1][2].role, "assistant");
            assert_eq!(requests[1][2].tool_calls.as_ref().map(Vec::len), Some(2));
            assert_eq!(requests[1][3].role, "tool");
            assert_eq!(requests[1][4].role, "tool");
            assert_eq!(requests[2][2].role, "assistant");
            assert_eq!(requests[2][2].tool_calls.as_ref().map(Vec::len), Some(1));
            assert_eq!(requests[2][3].role, "tool");
        }

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
        assert_eq!(jobs.len(), 3);
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
                (infer
                  (requires (tools))
                  "complete the current evaluation")
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
    async fn detached_execution_delivers_exactly_once_after_completion_inbox_wake() {
        let database = NamedTempFile::new().unwrap();
        let artifacts = tempfile::tempdir().unwrap();
        let mut config = AppConfig::default();
        // This test exercises detached execution and delivery, not sandbox
        // policy. Linux deliberately fails closed when no validated native
        // sandbox is available, so use the same explicit FullAccess boundary
        // as the Terminal-Bench protocol on every platform.
        config.permissions.mode = PermissionMode::FullAccess;
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
        let delivery = (
            reply.payload.get("delivery_kind").and_then(Value::as_str),
            reply.payload.get("thread_kind").and_then(Value::as_str),
            reply
                .payload
                .get("delivery_strategy")
                .and_then(Value::as_str),
        );
        assert!(
            matches!(
                delivery,
                (Some("turn_reply"), Some("execution"), None)
                    | (
                        Some("thread_delivery"),
                        Some("delivery"),
                        Some("passthrough")
                    )
            ),
            "detached completion used an unsupported delivery envelope: {delivery:?}"
        );
        // The background Job completion and its final model answer can cross:
        // either the still-interactive Execution publishes the answer directly,
        // or the already-terminal result reaches the singleton Delivery fast
        // path. Both consume the same immutable Activation outcome, so neither
        // may be followed by a second user-visible copy.
        match tokio::time::timeout(std::time::Duration::from_millis(1_500), replies.recv()).await {
            Err(_) | Ok(None) => {}
            Ok(Some(duplicate)) => panic!(
                "detached execution produced a duplicate reply after {delivery:?}: {:?}",
                duplicate.payload
            ),
        }
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
        assert!(
            jobs.iter().any(|job| job.tool_name == "exec/background"),
            "detached execution jobs: {:?}",
            jobs.iter()
                .map(|job| {
                    (
                        &job.tool_name,
                        &job.status,
                        &job.result_event_id,
                        &job.error,
                    )
                })
                .collect::<Vec<_>>()
        );
        let events = runtime
            .inner
            .store
            .query(QueryFilter {
                session_id: Some(session.id().to_string()),
                topic: Some("chat/reply".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(
            events.len(),
            1,
            "the durable Event ledger must contain exactly one detached completion reply"
        );
        assert_eq!(client.calls.load(Ordering::SeqCst), 3);
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
        let observed_tool_schemas = Arc::new(std::sync::Mutex::new(Vec::new()));
        let client = Arc::new(ApprovalReadClient {
            calls: AtomicU64::new(0),
            path: fixture.path().to_string_lossy().into_owned(),
            expected_rejected,
            observed_result: Arc::clone(&observed_result),
            observed_tool_schemas: Arc::clone(&observed_tool_schemas),
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
        let schemas = observed_tool_schemas.lock().unwrap();
        assert_eq!(schemas.len(), 2);
        assert_eq!(schemas[0], schemas[1]);
        assert!(schemas[0].iter().any(|name| name == "objective_amend"));
        assert_eq!(schemas[0].last().map(String::as_str), Some("no_reply"));
        assert!(schemas[0][..schemas[0].len() - 1]
            .windows(2)
            .all(|pair| pair[0] <= pair[1]));

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
            observed_tool_schemas: Arc::new(std::sync::Mutex::new(Vec::new())),
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
            observed_tool_schemas: Arc::new(std::sync::Mutex::new(Vec::new())),
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
            "The following 2 work items are complete:\n\n1. first concise result\n\n2. second concise result"
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
                // A different nonce under this test process's own PID may be
                // another live embedded Runtime. Use an impossible local PID
                // to model a host process that the OS can prove has exited.
                Some("runtime:2147483647:previous-process-instance"),
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
        // Recovery is event-driven; this timeout reports a hang rather than
        // defining its semantics. Keep enough headroom for the fully parallel
        // lib suite: the invariant under test is takeover before the persisted
        // ten-minute lease expires, not completion within three wall seconds.
        let reply = tokio::time::timeout(std::time::Duration::from_secs(15), replies.recv())
            .await
            .expect("a provably exited same-host owner must recover before lease expiry")
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

        // Simulate process A: atomically commit the physical user input and its direct Thread
        // Signal, then crash before scheduler admission. The Runtime is deliberately never
        // started here.
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
        crashed_runtime
            .inner
            .store
            .ensure_principal(NewPrincipal {
                id: "principal-runtime-outbox-recovery".to_string(),
                provider_id: "runtime-test".to_string(),
                assurance: "test".to_string(),
                display_name: None,
            })
            .await
            .unwrap();
        crashed_runtime
            .inner
            .store
            .bind_session_principal(
                "session-runtime-outbox-recovery",
                "principal-runtime-outbox-recovery",
            )
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
                (
                    "principal_id".to_string(),
                    json!("principal-runtime-outbox-recovery"),
                ),
                ("text".to_string(), json!("recover this message")),
            ]
            .into_iter()
            .collect(),
        );
        assert!(matches!(
            crashed_runtime
                .inner
                .store
                .claim_message(
                    "session-runtime-outbox-recovery",
                    "client-runtime-outbox-recovery",
                    &event,
                    MessageDispatchMode::FollowUp,
                )
                .await
                .unwrap(),
            MessageClaim::Accepted { .. }
        ));
        assert_eq!(
            crashed_runtime
                .inner
                .store
                .list_signal_outbox(crate::memory::SignalOutboxStatus::Pending, 10)
                .await
                .unwrap()
                .len(),
            0
        );
        assert_eq!(
            crashed_runtime
                .inner
                .store
                .list_context_thread_signals(&crashed_runtime.identity().context_id, None)
                .await
                .unwrap()
                .iter()
                .filter(|signal| signal.event_id == event.id)
                .count(),
            1
        );
        drop(crashed_runtime);

        // Simulate process B: startup admission must consume the already-durable Signal into one
        // Activation and complete the ordinary reply path without another user input.
        let recovered_runtime = MorphzRuntime::builder(config, Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .tool_policy(tool_policy)
            .build()
            .await
            .unwrap();
        let mut replies = recovered_runtime.subscribe("chat/reply", 8);
        recovered_runtime.start().await.unwrap();
        // Startup recovery admits the durable Signal before the reply can be emitted. Preserve a
        // finite failure bound while leaving
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
        assert!(outbox
            .iter()
            .all(|entry| entry.event_id != "event-runtime-outbox-recovery"));
    }

    #[tokio::test]
    async fn runtime_restart_materializes_a_pre_routed_consecutive_message_batch() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let tool_policy = RuntimeToolPolicy {
            context_only: true,
            coding_eval: true,
        };

        // Commit two consecutive messages without starting the Runtime. The
        // second Signal is atomically routed onto the first message's pending
        // DialogueTurn, before EventBus has materialized any Activation.
        let crashed_runtime = MorphzRuntime::builder(config.clone(), Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .tool_policy(tool_policy)
            .build()
            .await
            .unwrap();
        crashed_runtime
            .ensure_agent(NewAgent {
                id: crashed_runtime.identity().agent_id.clone(),
                title: "Pre-routed batch recovery agent".to_string(),
                root_context_id: crashed_runtime.identity().context_id.clone(),
            })
            .await
            .unwrap();
        crashed_runtime
            .ensure_context(NewCognitiveContext {
                id: crashed_runtime.identity().context_id.clone(),
                agent_id: crashed_runtime.identity().agent_id.clone(),
                title: "Pre-routed batch recovery context".to_string(),
            })
            .await
            .unwrap();
        crashed_runtime
            .ensure_session(NewSession {
                id: "session-pre-routed-batch-recovery".to_string(),
                agent_id: crashed_runtime.identity().agent_id.clone(),
                context_id: crashed_runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Pre-routed batch recovery session".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        crashed_runtime
            .inner
            .store
            .ensure_principal(NewPrincipal {
                id: "principal-pre-routed-batch-recovery".to_string(),
                provider_id: "runtime-test".to_string(),
                assurance: "test".to_string(),
                display_name: None,
            })
            .await
            .unwrap();
        crashed_runtime
            .inner
            .store
            .bind_session_principal(
                "session-pre-routed-batch-recovery",
                "principal-pre-routed-batch-recovery",
            )
            .await
            .unwrap();

        let message = |suffix: &str| {
            Event::new(
                format!("event-pre-routed-batch-{suffix}"),
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
                        json!("session-pre-routed-batch-recovery"),
                    ),
                    (
                        "client_message_id".to_string(),
                        json!(format!("client-pre-routed-batch-{suffix}")),
                    ),
                    (
                        "principal_id".to_string(),
                        json!("principal-pre-routed-batch-recovery"),
                    ),
                    ("text".to_string(), json!(format!("message {suffix}"))),
                ]
                .into_iter()
                .collect(),
            )
        };
        let first = message("first");
        let second = message("second");
        for (client_message_id, event) in [
            ("client-pre-routed-batch-first", &first),
            ("client-pre-routed-batch-second", &second),
        ] {
            assert!(matches!(
                crashed_runtime
                    .inner
                    .store
                    .claim_message(
                        "session-pre-routed-batch-recovery",
                        client_message_id,
                        event,
                        MessageDispatchMode::Interrupt,
                    )
                    .await
                    .unwrap(),
                MessageClaim::Accepted { .. }
            ));
        }
        let signals = crashed_runtime
            .inner
            .store
            .list_context_thread_signals(&crashed_runtime.identity().context_id, None)
            .await
            .unwrap();
        let first_signal = signals
            .iter()
            .find(|signal| signal.event_id == first.id)
            .unwrap();
        let second_signal = signals
            .iter()
            .find(|signal| signal.event_id == second.id)
            .unwrap();
        assert_eq!(first_signal.thread_id, second_signal.thread_id);
        assert!(signals
            .iter()
            .all(|signal| signal.status == crate::memory::ThreadSignalStatus::Pending));
        let durable_thread_id = first_signal.thread_id.clone();
        let candidate = crashed_runtime
            .inner
            .store
            .ensure_thread(crate::memory::NewThread {
                id: crate::memory::stable_thread_id(&second.id),
                agent_id: crashed_runtime.identity().agent_id.clone(),
                context_id: crashed_runtime.identity().context_id.clone(),
                session_id: "session-pre-routed-batch-recovery".to_string(),
                initiating_principal_id: Some("principal-pre-routed-batch-recovery".to_string()),
                root_turn_id: second.id.clone(),
                kind: crate::memory::ThreadKind::DialogueTurn,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: crate::memory::ThreadSupervision::runtime("dialogue-router"),
            })
            .await
            .unwrap();
        let materialized = crashed_runtime
            .inner
            .store
            .claim_thread_signal_batch(
                crate::memory::NewThreadSignal {
                    id: crate::memory::stable_thread_signal_id(&second.id),
                    thread_id: candidate.id,
                    thread_generation: candidate.generation,
                    event_id: second.id.clone(),
                    principal_id: Some("principal-pre-routed-batch-recovery".to_string()),
                    sequence: second_signal.sequence,
                    kind: second.topic.clone(),
                    parent_activation_id: None,
                },
                crate::memory::NewThreadActivation {
                    id: crate::memory::stable_thread_activation_id(&second.id),
                    agent_id: crashed_runtime.identity().agent_id.clone(),
                    context_id: crashed_runtime.identity().context_id.clone(),
                    session_id: "session-pre-routed-batch-recovery".to_string(),
                    initiating_principal_id: Some(
                        "principal-pre-routed-batch-recovery".to_string(),
                    ),
                    trigger_event_id: second.id.clone(),
                    trigger_sequence: second_signal.sequence,
                    trigger_kind: second.topic.clone(),
                    parent_activation_id: None,
                    root_turn_id: second.id.clone(),
                },
                crate::memory::DEFAULT_THREAD_SIGNAL_BATCH_LIMIT,
            )
            .await
            .expect("a pre-routed Signal must adopt its durable Thread route")
            .expect("the durable pending batch must materialize one Activation");
        assert_eq!(materialized.root_turn_id, first.id);
        assert_eq!(materialized.trigger_event_id, second.id);
        assert!(crashed_runtime
            .inner
            .store
            .get_thread_by_root(&second.id)
            .await
            .unwrap()
            .is_none());
        drop(crashed_runtime);

        let recovered_runtime = MorphzRuntime::builder(config, Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .tool_policy(tool_policy)
            .build()
            .await
            .unwrap();
        let mut replies = recovered_runtime.subscribe("chat/reply", 4);
        recovered_runtime.start().await.unwrap();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(10), replies.recv())
            .await
            .expect("the durable consecutive batch must materialize without a route mismatch")
            .unwrap();
        assert_eq!(reply.payload["text"], "runtime-ok");

        let activations = recovered_runtime
            .inner
            .store
            .list_context_thread_activations(&recovered_runtime.identity().context_id, true)
            .await
            .unwrap();
        let activation = activations
            .iter()
            .find(|activation| activation.trigger_event_id == second.id)
            .expect("the newest Event remains the unique Activation trigger");
        let claimed = recovered_runtime
            .inner
            .store
            .list_activation_signals(&activation.id)
            .await
            .unwrap();
        assert_eq!(
            claimed
                .iter()
                .map(|signal| signal.event_id.as_str())
                .collect::<Vec<_>>(),
            vec![first.id.as_str(), second.id.as_str()]
        );
        assert_eq!(
            activation.root_turn_id,
            recovered_runtime
                .inner
                .store
                .get_thread(&durable_thread_id)
                .await
                .unwrap()
                .unwrap()
                .root_turn_id
        );
        assert!(
            recovered_runtime
                .inner
                .store
                .get_thread_by_root(&second.id)
                .await
                .unwrap()
                .is_none(),
            "the discarded Event-derived candidate Thread must not remain as an orphan"
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(150), replies.recv())
                .await
                .is_err(),
            "one durable Signal batch must produce exactly one reply"
        );
    }

    #[tokio::test]
    async fn runtime_restart_dispatches_a_committed_session_signal_once() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let tool_policy = RuntimeToolPolicy {
            context_only: true,
            coding_eval: true,
        };

        let crashed_runtime = MorphzRuntime::builder(config.clone(), Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .tool_policy(tool_policy)
            .build()
            .await
            .unwrap();
        crashed_runtime
            .ensure_agent(NewAgent {
                id: crashed_runtime.identity().agent_id.clone(),
                title: "Session Signal recovery agent".to_string(),
                root_context_id: crashed_runtime.identity().context_id.clone(),
            })
            .await
            .unwrap();
        crashed_runtime
            .ensure_context(NewCognitiveContext {
                id: crashed_runtime.identity().context_id.clone(),
                agent_id: crashed_runtime.identity().agent_id.clone(),
                title: "Session Signal recovery context".to_string(),
            })
            .await
            .unwrap();
        for session_id in [
            "session-signal-recovery-source",
            "session-signal-recovery-target",
        ] {
            crashed_runtime
                .ensure_session(NewSession {
                    id: session_id.to_string(),
                    agent_id: crashed_runtime.identity().agent_id.clone(),
                    context_id: crashed_runtime.identity().context_id.clone(),
                    parent_session_id: None,
                    title: session_id.to_string(),
                    mount_kind: crate::memory::SessionMountKind::ExistingContext,
                })
                .await
                .unwrap();
        }
        let event = Event::new(
            "event-session-signal-recovery".to_string(),
            "Agent-SessionSignal".to_string(),
            crate::event::TYPE_SESSION_SIGNAL.to_string(),
            "chat/session_signal".to_string(),
            json!({
                "agent_id": crashed_runtime.identity().agent_id,
                "context_id": crashed_runtime.identity().context_id,
                "session_id": "session-signal-recovery-target",
                "source_context_id": crashed_runtime.identity().context_id,
                "source_session_id": "session-signal-recovery-source",
                "source_thread_id": "thread-session-signal-recovery-source",
                "source_activation_id": "activation-session-signal-recovery-source",
                "source_attempt_id": "attempt-session-signal-recovery-source",
                "source_root_turn_id": "root-session-signal-recovery-source",
                "source_trigger_event_id": "trigger-session-signal-recovery-source",
                "correlation_id": "event-session-signal-recovery",
                "dedupe_id": "event-session-signal-recovery",
                "text": "recover this internal coordination message",
                "cross_context": false
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        assert!(matches!(
            crashed_runtime
                .inner
                .store
                .claim_session_signal(&event)
                .await
                .unwrap(),
            crate::memory::SessionSignalClaim::Accepted { .. }
        ));
        drop(crashed_runtime);

        let recovered_runtime = MorphzRuntime::builder(config, Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .tool_policy(tool_policy)
            .build()
            .await
            .unwrap();
        let mut replies = recovered_runtime.subscribe("chat/reply", 4);
        recovered_runtime.start().await.unwrap();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(10), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            reply.payload["session_id"],
            "session-signal-recovery-target"
        );
        assert_eq!(reply.payload["text"], "runtime-ok");
        assert_eq!(
            recovered_runtime
                .inner
                .store
                .list_context_thread_signals(&recovered_runtime.identity().context_id, None)
                .await
                .unwrap()
                .iter()
                .filter(|signal| signal.event_id == event.id)
                .count(),
            1
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(150), replies.recv())
                .await
                .is_err(),
            "one durable Session Signal must produce exactly one target Activation reply"
        );
    }

    #[tokio::test]
    async fn live_session_signal_is_symmetric_and_runs_target_concurrently() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let client = Arc::new(SessionSignalCoordinationClient {
            target_started: tokio::sync::Notify::new(),
            observed_concurrent_target: AtomicBool::new(false),
            source_initial_calls: AtomicU64::new(0),
            source_continuation_calls: AtomicU64::new(0),
            source_reply_calls: AtomicU64::new(0),
            target_initial_calls: AtomicU64::new(0),
            target_continuation_calls: AtomicU64::new(0),
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
        for session_id in ["session-signal-live-a", "session-signal-live-b"] {
            runtime
                .ensure_session(NewSession {
                    id: session_id.to_string(),
                    agent_id: runtime.identity().agent_id.clone(),
                    context_id: runtime.identity().context_id.clone(),
                    parent_session_id: None,
                    title: session_id.to_string(),
                    mount_kind: crate::memory::SessionMountKind::ExistingContext,
                })
                .await
                .unwrap();
        }
        let source = runtime.session("session-signal-live-a");
        let mut replies = runtime.subscribe("chat/reply", 8);
        source
            .send(
                "start-session-coordination",
                "User-Test",
                Some("client-session-signal-live".to_string()),
            )
            .await
            .unwrap();

        let mut received = std::collections::HashSet::new();
        let completed = tokio::time::timeout(std::time::Duration::from_secs(60), async {
            while received.len() < 3 {
                let reply = replies.recv().await.unwrap();
                let session_id = reply.payload["session_id"].as_str().unwrap();
                let text = reply.payload["text"].as_str().unwrap();
                received.insert((session_id.to_string(), text.to_string()));
            }
        })
        .await;
        assert!(
            completed.is_ok(),
            "Session Signal live flow timed out: received={received:?}, source_initial={}, source_continuation={}, source_reply={}, target_initial={}, target_continuation={}",
            client.source_initial_calls.load(Ordering::SeqCst),
            client.source_continuation_calls.load(Ordering::SeqCst),
            client.source_reply_calls.load(Ordering::SeqCst),
            client.target_initial_calls.load(Ordering::SeqCst),
            client.target_continuation_calls.load(Ordering::SeqCst),
        );
        assert!(received.contains(&(
            "session-signal-live-a".to_string(),
            "source-finished".to_string()
        )));
        assert!(received.contains(&(
            "session-signal-live-b".to_string(),
            "target-finished".to_string()
        )));
        assert!(received.contains(&(
            "session-signal-live-a".to_string(),
            "source-received-result".to_string()
        )));
        assert!(client.observed_concurrent_target.load(Ordering::SeqCst));

        let signals = runtime
            .query_events(QueryFilter {
                context_id: Some(runtime.identity().context_id.clone()),
                topic: Some("chat/session_signal".to_string()),
                top_k: Some(8),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(signals.len(), 2);
        let a_to_b = signals
            .iter()
            .find(|event| {
                event.payload["source_session_id"] == "session-signal-live-a"
                    && event.payload["session_id"] == "session-signal-live-b"
            })
            .unwrap();
        let b_to_a = signals
            .iter()
            .find(|event| {
                event.payload["source_session_id"] == "session-signal-live-b"
                    && event.payload["session_id"] == "session-signal-live-a"
            })
            .unwrap();
        assert_eq!(b_to_a.payload["reply_to_event_id"], a_to_b.id);
        assert_eq!(
            b_to_a.payload["correlation_id"],
            a_to_b.payload["correlation_id"]
        );
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
        config.orchestrator.objective_evaluation_lease_secs = 1;
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

        let assistant_calls = runtime
            .query_events(QueryFilter {
                topic: Some("chat/assistant_call".to_string()),
                ..Default::default()
            })
            .await
            .unwrap()
            .into_iter()
            .filter(|event| {
                event
                    .payload
                    .get("objective_id")
                    .and_then(|value| value.as_str())
                    == Some(objective_id.as_str())
            })
            .collect::<Vec<_>>();
        let completion_call = assistant_calls
            .iter()
            .find(|event| {
                event
                    .payload
                    .get("tool_calls")
                    .and_then(|value| value.as_array())
                    .is_some_and(|calls| {
                        calls.iter().any(|call| {
                            call.pointer("/function/name")
                                .and_then(|value| value.as_str())
                                == Some("objective_update")
                        })
                    })
            })
            .expect("completed control call should be durable");
        let final_call = assistant_calls
            .iter()
            .find(|event| {
                event.payload.get("phase").and_then(|value| value.as_str())
                    == Some("objective-finalization")
            })
            .expect("final report should have its own durable call boundary");
        assert!(final_call.id.ends_with("_final"));
        assert_eq!(
            completion_call
                .payload
                .get("activation_id")
                .and_then(|value| value.as_str()),
            final_call
                .payload
                .get("activation_id")
                .and_then(|value| value.as_str()),
            "completion decision and final report must stay in one Activation"
        );
        let completion_outputs = runtime
            .query_events(QueryFilter {
                topic: Some("chat/tool_output".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(completion_outputs.iter().any(|event| {
            event
                .payload
                .get("tool_name")
                .and_then(|value| value.as_str())
                == Some("objective_update")
                && event
                    .payload
                    .get("wake_policy")
                    .and_then(|value| value.as_str())
                    == Some("none")
                && event
                    .payload
                    .get("activation_id")
                    .and_then(|value| value.as_str())
                    == completion_call
                        .payload
                        .get("activation_id")
                        .and_then(|value| value.as_str())
        }));

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
        let objective = runtime
            .get_objective("objective-wait")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(objective.status, ObjectiveStatus::Completed);
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
    async fn runtime_restart_repairs_completion_receipt_and_finishes_original_activation() {
        let database = NamedTempFile::new().unwrap();
        let database_path = database.path().to_string_lossy().into_owned();
        let store = SqliteStore::new(&database_path).await.unwrap();
        store
            .create_agent_bundle(
                NewAgent {
                    id: "default-agent".to_string(),
                    title: "Completion Recovery Agent".to_string(),
                    root_context_id: "context-default".to_string(),
                },
                NewCognitiveContext {
                    id: "context-default".to_string(),
                    agent_id: "default-agent".to_string(),
                    title: "Completion Recovery Context".to_string(),
                },
                NewSession {
                    id: "session-completion-recover".to_string(),
                    agent_id: "default-agent".to_string(),
                    context_id: "context-default".to_string(),
                    parent_session_id: None,
                    title: "Completion Recovery Session".to_string(),
                    mount_kind: crate::memory::SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        store
            .create_objective(NewObjective {
                id: "objective-completion-recover".to_string(),
                agent_id: "default-agent".to_string(),
                context_id: "context-default".to_string(),
                coordinator_session_id: "session-completion-recover".to_string(),
                delivery_session_id: "session-completion-recover".to_string(),
                parent_objective_id: None,
                source_event_id: "completion-recovery-source".to_string(),
                initiating_principal_id: None,
                stated_objective: "恢复已准备但尚未交付的完成决定".to_string(),
                token_budget: None,
            })
            .await
            .unwrap();
        let root_turn_id =
            crate::memory::objective_primary_execution_root_id("objective-completion-recover", 1);
        let continuation = Event::new(
            "completion-recovery-continuation".to_string(),
            "ObjectiveSupervisor".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            serde_json::Map::from_iter([
                ("context_id".to_string(), json!("context-default")),
                (
                    "session_id".to_string(),
                    json!("session-completion-recover"),
                ),
                (
                    "objective_id".to_string(),
                    json!("objective-completion-recover"),
                ),
                (
                    "objective_evaluation_id".to_string(),
                    json!("completion-recovery-evaluation"),
                ),
                ("root_turn_id".to_string(), json!(root_turn_id)),
            ]),
        );
        let thread = NewThread {
            id: crate::memory::stable_thread_id(&root_turn_id),
            agent_id: "default-agent".to_string(),
            context_id: "context-default".to_string(),
            session_id: "session-completion-recover".to_string(),
            initiating_principal_id: None,
            root_turn_id: root_turn_id.clone(),
            kind: ThreadKind::Execution,
            executor_kind: "self".to_string(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::objective_primary_execution(
                "objective-completion-recover",
                1,
            ),
        };
        assert!(matches!(
            store
                .claim_objective_evaluation_with_signal(
                    "objective-completion-recover",
                    1,
                    "completion-recovery-evaluation",
                    chrono::Utc::now() + chrono::Duration::minutes(1),
                    &continuation,
                    &thread,
                )
                .await
                .unwrap(),
            ObjectiveMutation::Updated(_)
        ));
        let signal = store
            .list_context_thread_signals("context-default", Some(ThreadSignalStatus::Pending))
            .await
            .unwrap()
            .into_iter()
            .find(|signal| signal.event_id == continuation.id)
            .unwrap();
        let trigger_sequence = signal.sequence;
        let activation = store
            .claim_thread_signal_batch(
                crate::memory::NewThreadSignal {
                    id: signal.id,
                    thread_id: signal.thread_id,
                    thread_generation: signal.thread_generation,
                    event_id: signal.event_id,
                    principal_id: signal.principal_id,
                    sequence: signal.sequence,
                    kind: signal.kind,
                    parent_activation_id: signal.parent_activation_id,
                },
                NewThreadActivation {
                    id: "completion-recovery-activation".to_string(),
                    agent_id: "default-agent".to_string(),
                    context_id: "context-default".to_string(),
                    session_id: "session-completion-recover".to_string(),
                    initiating_principal_id: None,
                    trigger_event_id: continuation.id.clone(),
                    trigger_sequence,
                    trigger_kind: continuation.topic.clone(),
                    parent_activation_id: None,
                    root_turn_id: root_turn_id.clone(),
                },
                32,
            )
            .await
            .unwrap()
            .unwrap();
        let activation = match store
            .update_thread_activation(
                &activation.id,
                activation.revision,
                ThreadActivationStatus::Running,
                Some("dead-runtime"),
                Some(chrono::Utc::now() + chrono::Duration::milliseconds(1)),
                None,
            )
            .await
            .unwrap()
        {
            crate::memory::ThreadActivationMutation::Updated(activation) => activation,
            mutation => panic!("unexpected Activation mutation: {mutation:?}"),
        };
        let completion_call_id = "completion-recovery-call";
        let completion_arguments = json!({
            "objective_id": "objective-completion-recover",
            "base_revision": 2,
            "status": "completed",
            "reason": "完成条件与证据均已审计",
            "evidence_refs": []
        })
        .to_string();
        store
            .append(Event::new(
                format!("call_{}", activation.id),
                "Agent-Morphz".to_string(),
                crate::event::TYPE_AGENT_CALL.to_string(),
                "chat/assistant_call".to_string(),
                serde_json::Map::from_iter([
                    ("context_id".to_string(), json!("context-default")),
                    (
                        "session_id".to_string(),
                        json!("session-completion-recover"),
                    ),
                    ("attempt_id".to_string(), json!(activation.id)),
                    ("activation_id".to_string(), json!(activation.id)),
                    ("thread_id".to_string(), json!(thread.id)),
                    ("root_turn_id".to_string(), json!(root_turn_id)),
                    ("phase".to_string(), json!("work")),
                    ("text".to_string(), json!("")),
                    (
                        "tool_calls".to_string(),
                        json!([{
                            "id": completion_call_id,
                            "type": "function",
                            "function": {
                                "name": "objective_update",
                                "arguments": completion_arguments
                            }
                        }]),
                    ),
                ]),
            ))
            .await
            .unwrap();
        assert!(matches!(
            store
                .prepare_objective_completion(
                    "objective-completion-recover",
                    2,
                    "completion-recovery-evaluation",
                    &activation.id,
                    "完成条件与证据均已审计",
                    &[],
                )
                .await
                .unwrap(),
            ObjectiveMutation::Updated(_)
        ));
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        drop(store);

        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let client = Arc::new(ObjectiveCompletionRecoveryClient {
            calls: AtomicU64::new(0),
            observed_repaired_receipt: AtomicBool::new(false),
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
            reply.payload.get("text").and_then(Value::as_str),
            Some("recovered-completion-final-report")
        );
        assert_eq!(
            runtime
                .get_objective("objective-completion-recover")
                .await
                .unwrap()
                .unwrap()
                .status,
            ObjectiveStatus::Completed
        );
        assert_eq!(client.calls.load(Ordering::SeqCst), 1);
        assert!(client.observed_repaired_receipt.load(Ordering::SeqCst));
        let repaired = runtime
            .query_events(QueryFilter {
                event_id: Some(format!("output_{}_{}", activation.id, completion_call_id)),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(repaired.len(), 1);
        assert_eq!(repaired[0].payload.get("recovered"), Some(&json!(true)));
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
        // Keep the pre-deadline assertion deterministic under a fully parallel
        // workspace test run. Runtime construction can legitimately take more
        // than a second while hundreds of SQLite-backed tests are competing;
        // if the deadline expires before `start`, a correctly claimed timer
        // would look like a persistence failure. This test exercises restart
        // recovery, not sub-second timer precision.
        let deadline = chrono::Utc::now() + chrono::Duration::seconds(10);
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
        // Startup recovery first reconciles the durable dependency graph and
        // may briefly cancel the legacy display timer before rescheduling the
        // authoritative generation. Observe the settled pending timer rather
        // than racing that internal transition under a parallel test run.
        let wait_timer = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if let Some(timer) = runtime
                    .inner
                    .store
                    .get_runtime_timer("objective-wait:objective-recover")
                    .await
                    .unwrap()
                {
                    if timer.status == crate::memory::RuntimeTimerStatus::Pending {
                        break timer;
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("recoverable timer wait must settle as pending before it fires");
        assert_eq!(
            wait_timer.kind,
            crate::memory::RuntimeTimerKind::ObjectiveWait
        );
        assert_eq!(
            wait_timer.status,
            crate::memory::RuntimeTimerStatus::Pending
        );
        let reply = tokio::time::timeout(std::time::Duration::from_secs(15), replies.recv())
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
            .contains("does not exist"));
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
        let cancelled = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            let mut expected = running.clone();
            loop {
                match runtime
                    .request_execution_job_cancel(
                        &expected.id,
                        expected.revision,
                        Some("test cancellation"),
                    )
                    .await
                    .unwrap()
                {
                    JobReceipt::Applied { job, .. } | JobReceipt::Existing { job, .. } => {
                        break job;
                    }
                    JobReceipt::Conflict { current, .. } => {
                        // The worker heartbeat is allowed to win the optimistic
                        // revision fence. Retry the operator command against the
                        // returned authoritative revision instead of pretending
                        // the stale cancellation was accepted.
                        expected = current;
                    }
                    JobReceipt::Rejected {
                        current, reason, ..
                    } => panic!(
                        "Artifact Transfer cancellation was rejected: {reason}; {current:#?}"
                    ),
                    JobReceipt::NotFound { .. } => {
                        panic!("Artifact Transfer disappeared before cancellation")
                    }
                }
            }
        })
        .await
        .expect("Artifact Transfer cancellation CAS should converge");
        assert!(cancelled.cancel_requested_at.is_some());
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
        .await;
        let terminal = match terminal {
            Ok(terminal) => terminal,
            Err(_) => {
                let current = runtime
                    .get_execution_job(&running.id)
                    .await
                    .unwrap()
                    .unwrap();
                panic!("cancelled Artifact Transfer should durably close: {current:#?}");
            }
        };
        assert_eq!(terminal.status, ExecutionJobStatus::Cancelled);
        assert!(terminal.cancel_requested_at.is_some());
        assert!(terminal.side_effect_started_at.is_none());
        assert!(dropped.load(Ordering::SeqCst));
        assert!(!tokio::fs::try_exists(&destination_path).await.unwrap());

        let (activation, thread) =
            tokio::time::timeout(std::time::Duration::from_secs(15), async {
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

    #[tokio::test]
    async fn artifact_transfer_startup_repair_closes_terminal_scheduler_projection() {
        let database = NamedTempFile::new().unwrap();
        let runtime = MorphzRuntime::builder(AppConfig::default(), Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        let session = runtime
            .create_session(NewSession {
                id: "session-artifact-projection-recovery".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Artifact projection recovery".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let identity = artifact_transfer_execution_identity(
            &runtime.identity().principal_id,
            &session.id,
            "transfer-projection-recovery",
        );
        let request_event = Event::new(
            identity.event_id.clone(),
            "Runtime-ArtifactTransfer".to_string(),
            "runtime_control".to_string(),
            ARTIFACT_TRANSFER_REQUEST_TOPIC.to_string(),
            serde_json::Map::from_iter([
                ("context_id".to_string(), json!(session.context_id)),
                ("session_id".to_string(), json!(session.id)),
                ("thread_id".to_string(), json!(identity.thread_id)),
                ("activation_id".to_string(), json!(identity.activation_id)),
                ("job_id".to_string(), json!(identity.job_id)),
                ("tool_call_id".to_string(), json!(identity.tool_call_id)),
                ("tool_name".to_string(), json!(ARTIFACT_TRANSFER_TOOL_NAME)),
                ("wake_policy".to_string(), json!("none")),
            ]),
        );
        let seeded = runtime
            .inner
            .store
            .ensure_artifact_transfer_execution(NewArtifactTransferExecution {
                request_event,
                thread: NewThread {
                    id: identity.thread_id.clone(),
                    agent_id: session.agent_id.clone(),
                    context_id: session.context_id.clone(),
                    session_id: session.id.clone(),
                    initiating_principal_id: Some(runtime.identity().principal_id.clone()),
                    root_turn_id: identity.event_id.clone(),
                    kind: ThreadKind::Execution,
                    executor_kind: ARTIFACT_TRANSFER_EXECUTOR_KIND.to_string(),
                    executor_id: Some(identity.job_id.clone()),
                    target_id: Some(
                        crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
                    ),
                    supervision: ThreadSupervision::runtime("artifact-transfer-ingress"),
                },
                activation: NewThreadActivation {
                    id: identity.activation_id.clone(),
                    agent_id: session.agent_id.clone(),
                    context_id: session.context_id.clone(),
                    session_id: session.id.clone(),
                    initiating_principal_id: Some(runtime.identity().principal_id.clone()),
                    trigger_event_id: identity.event_id.clone(),
                    trigger_sequence: 0,
                    trigger_kind: ARTIFACT_TRANSFER_REQUEST_TOPIC.to_string(),
                    parent_activation_id: None,
                    root_turn_id: identity.event_id.clone(),
                },
                job: crate::memory::NewExecutionJob {
                    id: identity.job_id.clone(),
                    activation_id: identity.activation_id.clone(),
                    thread_id: identity.thread_id.clone(),
                    agent_id: session.agent_id.clone(),
                    context_id: session.context_id.clone(),
                    session_id: session.id.clone(),
                    initiating_principal_id: Some(runtime.identity().principal_id.clone()),
                    target_id: crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
                    tool_call_id: identity.tool_call_id.clone(),
                    tool_name: ARTIFACT_TRANSFER_TOOL_NAME.to_string(),
                    request: json!({"_morphz_wake_thread": false}),
                    retry_safety: crate::memory::ExecutionRetrySafety::ReconcileRequired,
                    requires_approval: false,
                },
            })
            .await
            .unwrap();
        let claimed = match runtime
            .inner
            .store
            .claim_execution_job(
                &seeded.job.id,
                seeded.job.revision,
                "projection-recovery-worker",
                "projection-recovery-claim",
                chrono::Utc::now() + chrono::Duration::minutes(1),
                None,
            )
            .await
            .unwrap()
        {
            crate::memory::ExecutionJobMutation::Updated(job) => job,
            mutation => panic!("unexpected Artifact Transfer claim: {mutation:?}"),
        };
        let result_event = Event::new(
            format!("output_{}", claimed.id),
            "Runtime-ArtifactTransfer".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            ARTIFACT_TRANSFER_FAILED_TOPIC.to_string(),
            serde_json::Map::from_iter([
                ("context_id".to_string(), json!(claimed.context_id)),
                ("session_id".to_string(), json!(claimed.session_id)),
                ("thread_id".to_string(), json!(claimed.thread_id)),
                ("activation_id".to_string(), json!(claimed.activation_id)),
                ("job_id".to_string(), json!(claimed.id)),
                ("tool_call_id".to_string(), json!(claimed.tool_call_id)),
                ("tool_name".to_string(), json!(claimed.tool_name)),
                ("tool_status".to_string(), json!("lost")),
                ("text".to_string(), json!("transfer outcome is unknown")),
                ("wake_policy".to_string(), json!("none")),
            ]),
        );
        let receipt = runtime
            .inner
            .execution_jobs
            .finish_with_event(
                &claimed.id,
                claimed.revision,
                Some("projection-recovery-claim"),
                JobOutcome::Lost {
                    result_event_id: Some(result_event.id.clone()),
                    reason: "transfer outcome is unknown".to_string(),
                },
                &result_event,
                false,
            )
            .await
            .unwrap();
        assert!(matches!(receipt, JobReceipt::Applied { .. }));

        assert_eq!(
            runtime
                .reconcile_artifact_transfer_scheduler_projections()
                .await
                .unwrap(),
            1
        );
        let activation = runtime
            .inner
            .store
            .get_thread_activation(&identity.activation_id)
            .await
            .unwrap()
            .unwrap();
        let thread = runtime
            .inner
            .store
            .get_thread(&identity.thread_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(activation.status, ThreadActivationStatus::Failed);
        assert_eq!(thread.lifecycle, ThreadLifecycle::Failed);
        assert!(activation.revision > seeded.activation.revision);
        assert_eq!(thread.result_event_id, Some(result_event.id));
    }
}
