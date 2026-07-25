use crate::approval::{
    capability_lease_policy_digest, AiAutoReviewProvider, ApprovalDecision, ApprovalProvider,
    ApprovalRequest, CapabilityLeaseOffer, DenyAllApprovalProvider, EscalatingApprovalProvider,
    HumanApprovalHub, HumanApprovalProvider, PendingHumanApproval,
    CAPABILITY_LEASE_APPROVED_RISK_TAG,
};
use crate::config::{AppConfig, StorageBackend};
use crate::context_tools::{ContextTxTool, RecallTool};
#[cfg(test)]
use crate::event::TYPE_TOOL_OUTPUT;
use crate::event::{Event, InMemoryEventBus, TYPE_USER_MESSAGE};
use crate::execution::ExecutionJobManager;
use crate::harness::{HarnessBinding, HarnessDescriptor, HarnessRegistry as DomainHarnessRegistry};
use crate::harness_package::{
    load_objective_harness_binding, load_persisted_harness_packages, persist_harness_package,
    persist_objective_harness_binding, HarnessPackage,
};
use crate::identity::{
    IdentityEvidence, IdentityProvider, PrincipalAssertion, StaticIdentityProvider,
};
use crate::llm::{Client, ModelUsage, ReasoningEffort};
use crate::memory::postgres::PostgresStore;
use crate::memory::sqlite::SqliteStore;
use crate::memory::{
    AgentBootstrapRecord, AgentRecord, ApprovalFilter, ApprovalMutation, ApprovalRecord,
    ApprovalResolution, ApprovalStore, AttentionAcknowledgementRecord, CapabilityLeaseFilter,
    CapabilityLeaseMutation, CapabilityLeaseRecord, CognitiveContextRecord, ContextUpdate,
    DelegationRecord, DelegationStatus, EdgeCommandMutation, EdgeCommandOutputChunk,
    EdgeCommandRecord, EdgeCommandStatus, EdgeOutputStream, EventStore, ExecutionApprovalStore,
    ExecutionJobFilter, ExecutionJobRecord, ExecutionJobStatus, ExecutionJobStore,
    ExecutionNodeMutation, ExecutionNodeRecord, ExecutionTargetAuthorizationFilter,
    ExecutionTargetAuthorizationMutation, ExecutionTargetAuthorizationRecord,
    ExecutionTargetFilter, ExecutionTargetMutation, ExecutionTargetRecord,
    ExecutionTargetRegistration, ExecutionTargetStatus, ExecutionTargetStore, MessageClaim,
    MindProjectionStore, NewAgent, NewCognitiveContext, NewDelegation, NewExecutionNodeChallenge,
    NewExecutionTargetAuthorization, NewNodePairingCode, NewObjective, NewPrincipal, NewSession,
    ObjectiveMutation, ObjectiveRecord, ObjectiveStatus, ObjectiveStore, ObjectiveWaitCondition,
    PairExecutionNode, QueryFilter, RecallDocumentKind, RecallProjectionStore, RuntimeStore,
    ScheduleMutation, ScheduleRecord, ScheduleStatus, SessionRecord, SessionStore, SessionUpdate,
    ThreadActivationRecord, ThreadActivationStatus, ThreadPhase, ThreadRecord, ThreadSignalRecord,
    ThreadSignalStatus, TimerStore,
};
use crate::objective::{
    ObjectiveCreateTool, ObjectiveEvaluationRegistry, ObjectiveSupervisor, ObjectiveUpdateTool,
};
use crate::orchestrator::context::{
    ContextAttribution, ContextEngine, ContextPressure, ContextRecallService, ContextView,
    FrameRecallPage, FrameRecallRequest, ProjectedSession, RecallSearchPage, RecallSearchRequest,
    SessionWorkingSetView,
};
use crate::orchestrator::orchestrator::{DurableApprovalServices, Orchestrator};
use crate::permission::{
    ApprovalRequirement, PermissionBroker, PermissionProfile, ReviewerKind, SandboxMode,
};
use crate::timer::TimerEngine;
use crate::tool::{
    BackgroundTaskScheduler, CheckTaskAfterTool, DelegateTool, EditFileTool, ExecuteCommandTool,
    KillTaskTool, ListFilesTool, ListSkillsTool, ListTasksTool, ReadFileTool, Registry,
    ScheduleTxTool, SearchTool, SendMessageTool, TaskStatusTool, ThreadScheduler,
    VerifyIdentityTool, WriteFileTool,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};

pub type RuntimeError = Box<dyn std::error::Error + Send + Sync>;

static RUNTIME_ID_COUNTER: AtomicU64 = AtomicU64::new(0);
const RUNTIME_DEFAULT_IDENTITY_PROVIDER_ID: &str = "runtime-default";

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulerResultSnapshot {
    pub event_id: Option<String>,
    pub status: ExecutionJobStatus,
    pub refs: Vec<String>,
    pub error: Option<String>,
    pub exit_code: Option<i32>,
    pub finished_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulerJobSnapshot {
    pub job: ExecutionJobRecord,
    pub approval: Option<ApprovalRecord>,
    pub result: Option<SchedulerResultSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulerActivationSnapshot {
    pub activation: ThreadActivationRecord,
    pub signals: Vec<ThreadSignalRecord>,
    pub jobs: Vec<SchedulerJobSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulerThreadSnapshot {
    pub thread: ThreadRecord,
    pub phase: ThreadPhase,
    pub pending_signals: Vec<ThreadSignalRecord>,
    pub activations: Vec<SchedulerActivationSnapshot>,
    pub schedules: Vec<ScheduleRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulerAdmissionSnapshot {
    #[serde(flatten)]
    pub process: crate::activation_admission::ActivationAdmissionSnapshot,
    pub context_durable_queued: usize,
    pub context_durable_running: usize,
    pub context_loaded_queued: usize,
    pub context_in_flight: usize,
    pub context_deferred: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulerSummary {
    pub open_threads: usize,
    pub pending_signals: usize,
    pub queued_activations: usize,
    pub running_activations: usize,
    pub active_jobs: usize,
    pub waiting_approval_jobs: usize,
    pub pending_approvals: usize,
    pub active_schedules: usize,
    pub deferred_activations: usize,
}

/// One read model for every Dashboard scheduler surface. SQLite authorities
/// are joined by their causal IDs here so the UI never infers Runtime truth
/// from unrelated event counts or process-local task maps.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulerSnapshot {
    pub context_id: String,
    pub generated_at: chrono::DateTime<chrono::Utc>,
    pub summary: SchedulerSummary,
    pub admission: SchedulerAdmissionSnapshot,
    pub event_writer: crate::orchestrator::orchestrator::DurableEventWriterMetricsSnapshot,
    pub model_provider: crate::orchestrator::orchestrator::ModelProviderMetricsSnapshot,
    pub context_capacity: crate::orchestrator::context::ContextCapacityMetricsSnapshot,
    pub threads: Vec<SchedulerThreadSnapshot>,
    pub orphan_activations: Vec<SchedulerActivationSnapshot>,
    pub orphan_signals: Vec<ThreadSignalRecord>,
    pub orphan_jobs: Vec<SchedulerJobSnapshot>,
    pub orphan_approvals: Vec<ApprovalRecord>,
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

/// Shared query contract for the Rust SDK, CLI and HTTP scheduler read model.
/// All presentation layers consume the same [`SchedulerSnapshot`]; none may
/// reconstruct scheduler truth from events or process-local task maps.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct SchedulerQuery {
    #[serde(default)]
    pub include_terminal: bool,
    #[serde(default = "default_scheduler_limit")]
    pub limit: usize,
}

const fn default_scheduler_limit() -> usize {
    200
}

impl Default for SchedulerQuery {
    fn default() -> Self {
        Self {
            include_terminal: false,
            limit: default_scheduler_limit(),
        }
    }
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
        let context_engine = Arc::new(
            ContextEngine::new(
                Arc::clone(&store) as Arc<dyn EventStore>,
                self.config.orchestrator.clone(),
            )
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>)
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
        let objective_supervisor = Arc::new(
            ObjectiveSupervisor::new(
                Arc::clone(&store) as Arc<dyn ObjectiveStore>,
                Arc::clone(&store) as Arc<dyn EventStore>,
                Arc::clone(&bus),
                Arc::clone(&objective_evaluations),
                Arc::clone(&timer_engine),
                std::time::Duration::from_secs(objective_lease_secs),
            )
            .with_execution_job_store(Arc::clone(&store) as Arc<dyn ExecutionJobStore>),
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
            permissions: &permissions,
            bus: &bus,
            thread_scheduler: &thread_scheduler,
            background_scheduler: &background_scheduler,
            config: &self.config,
            policy: self.tool_policy,
        });
        registry.register(Arc::new(crate::execution_target::ListTargetsTool::new(
            Arc::clone(&store) as Arc<dyn ExecutionTargetStore>,
        )));
        registry.register(Arc::new(crate::execution_target::InspectTargetTool::new(
            Arc::clone(&store) as Arc<dyn ExecutionTargetStore>,
        )));
        registry.register(Arc::new(crate::execution_target::ResolveTargetTool::new(
            Arc::clone(&store) as Arc<dyn ExecutionTargetStore>,
        )));
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
        let execution_targets = Arc::new(crate::execution_target::ExecutionTargetDispatcher::new(
            Arc::clone(&store) as Arc<dyn ExecutionTargetStore>,
            Arc::clone(&store) as Arc<dyn crate::memory::ExecutionTargetAuthorizationStore>,
        ));
        execution_targets
            .register_backend(Arc::new(crate::execution_target::InProcessLocalBackend));
        execution_targets.register_backend(Arc::new(
            crate::execution_target::EdgeNodeBackend::new(
                Arc::clone(&store) as Arc<dyn crate::memory::EdgeExecutionStore>
            ),
        ));
        execution_targets.register_backend(Arc::new(
            crate::execution_target::EdgeNodeBackend::managed_ssh(
                Arc::clone(&store) as Arc<dyn crate::memory::EdgeExecutionStore>
            ),
        ));
        for backend in self.execution_target_backends {
            execution_targets.register_backend(backend);
        }
        let runtime_client = Arc::clone(&self.client);
        let orchestrator = Orchestrator::assemble_with_scheduler_kernel(
            Arc::clone(&bus),
            Arc::clone(&store) as Arc<dyn EventStore>,
            Some(Arc::clone(&store) as Arc<dyn RuntimeStore>),
            self.client,
            Arc::clone(&registry),
            self.config.orchestrator.clone(),
            Arc::clone(&context_engine),
            objective_evaluations,
            Some(Arc::clone(&objective_supervisor)),
            Arc::clone(&timer_engine),
            Some(Arc::clone(&thread_scheduler)),
            Some(Arc::clone(&execution_jobs)),
            Some(execution_targets),
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
                context_engine,
                orchestrator,
                objective_supervisor,
                thread_scheduler,
                execution_jobs,
                background_scheduler,
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
    permissions: &'a Arc<PermissionBroker>,
    bus: &'a Arc<InMemoryEventBus>,
    thread_scheduler: &'a Arc<ThreadScheduler>,
    background_scheduler: &'a Arc<BackgroundTaskScheduler>,
    config: &'a AppConfig,
    policy: RuntimeToolPolicy,
}

fn register_default_tools(dependencies: DefaultToolDependencies<'_>) {
    let DefaultToolDependencies {
        registry,
        context_engine,
        objective_supervisor,
        permissions,
        bus,
        thread_scheduler,
        background_scheduler,
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
    registry.register(Arc::new(ObjectiveCreateTool::new(
        Arc::clone(objective_supervisor),
        Arc::clone(context_engine),
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
    registry.register(Arc::new(ScheduleTxTool::new(
        Arc::clone(thread_scheduler),
        context_engine
            .session_store()
            .expect("Runtime ContextEngine 必须配置 SessionStore"),
    )));
    registry.register(Arc::new(VerifyIdentityTool::new(
        context_engine
            .session_store()
            .expect("Runtime ContextEngine 必须配置 SessionStore"),
    )));
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
    registry.register(Arc::new(RecallTool::new(Arc::clone(context_engine))));
    registry.register(Arc::new(
        ExecuteCommandTool::new_with_permissions_and_scheduler(
            Arc::clone(bus),
            Arc::new(config.background_task.clone()),
            Arc::clone(permissions),
            config.orchestrator.tool_timeout_secs,
            Some(Arc::clone(background_scheduler)),
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
    context_engine: Arc<ContextEngine>,
    orchestrator: Arc<Orchestrator>,
    objective_supervisor: Arc<ObjectiveSupervisor>,
    thread_scheduler: Arc<ThreadScheduler>,
    execution_jobs: Arc<ExecutionJobManager<dyn ExecutionJobStore>>,
    background_scheduler: Arc<BackgroundTaskScheduler>,
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
        Arc::clone(&self.inner.orchestrator).start().await?;
        Arc::clone(&self.inner.objective_supervisor).start().await?;
        self.inner.thread_scheduler.recover().await?;
        self.inner.timer_engine.start();
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

    pub fn identity(&self) -> &RuntimeIdentity {
        &self.inner.identity
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
                                                                tool.execute(&command.arguments)
                                                                    .await
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
        }
        Ok(receipt)
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

    pub fn harnesses(&self) -> Vec<HarnessDescriptor> {
        self.inner.harness_registry.descriptors()
    }

    pub async fn register_harness_package(
        &self,
        package: HarnessPackage,
    ) -> Result<Arc<HarnessPackage>, RuntimeError> {
        persist_harness_package(self.inner.store.as_ref(), &package).await?;
        self.inner
            .harness_registry
            .register_package(package)
            .map_err(Into::into)
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
            objective.active_evaluation_id.as_deref(),
        )
        .await
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
        if self.inner.store.get_context(context_id).await?.is_none() {
            return Err(format!("Context '{context_id}' 不存在").into());
        }
        let include_terminal = query.include_terminal;
        let limit = query.limit.clamp(1, 2_000);
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
            .list_context_thread_signals(context_id, None)
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
            let snapshot = scheduler_job_snapshot(job, &mut approval_by_job);
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
        let claimed_signal_ids = activations_by_thread
            .values()
            .flatten()
            .chain(orphan_activations.iter())
            .flat_map(|activation| activation.signals.iter().map(|signal| signal.id.clone()))
            .collect::<HashSet<_>>();
        let mut orphan_signals = Vec::new();
        for signal in all_signals {
            if claimed_signal_ids.contains(&signal.id) {
                continue;
            }
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

        let mut threads = Vec::with_capacity(all_threads.len());
        for thread in all_threads {
            let pending_signals = pending_signals_by_thread
                .remove(&thread.id)
                .unwrap_or_default();
            let thread_activations = activations_by_thread.remove(&thread.id).unwrap_or_default();
            let schedules = schedules_by_thread.remove(&thread.id).unwrap_or_default();
            let phase =
                scheduler_thread_phase(&thread, &pending_signals, &thread_activations, &schedules);
            threads.push(SchedulerThreadSnapshot {
                thread,
                phase,
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
            .map(|thread| thread.pending_signals.len())
            .sum::<usize>()
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
            threads,
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
                .push(scheduler_job_snapshot(job, &mut approval_by_job));
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
            .list_context_thread_signals(context_id, None)
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
        let phase =
            scheduler_thread_phase(&thread, &pending_signals, &activation_snapshots, &schedules);
        let mut model_attempt_events = Vec::new();
        for topic in [
            "runtime/model_attempt_state",
            "runtime/model_reasoning_summary",
        ] {
            // Rows written before the causal Event columns carry their route
            // only in the payload. A Thread that spans that upgrade holds both
            // projected and legacy rows, so a non-empty result is no evidence
            // that the fill already ran — asking only when the query came back
            // empty would hide the legacy half of such a Thread permanently.
            // The store keeps a marker and settles the filled case with a
            // keyed read, so this stays cheap in the polling path.
            self.inner
                .store
                .backfill_causal_projection_for_thread(
                    context_id,
                    &thread.session_id,
                    thread_id,
                    topic,
                )
                .await?;
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
                thread,
                phase,
                pending_signals,
                activations: activation_snapshots,
                schedules,
            },
            model_attempt_events,
        }))
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
            model: self.inner.config.llm.model.clone(),
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

fn scheduler_job_snapshot(
    job: ExecutionJobRecord,
    approvals: &mut HashMap<String, ApprovalRecord>,
) -> SchedulerJobSnapshot {
    let approval = approvals.remove(&job.id);
    let result = job.status.is_terminal().then(|| SchedulerResultSnapshot {
        event_id: job.result_event_id.clone(),
        status: job.status,
        refs: job.result_refs.clone(),
        error: job.error.clone(),
        exit_code: job.exit_code,
        finished_at: job.finished_at,
    });
    SchedulerJobSnapshot {
        job,
        approval,
        result,
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

fn scheduler_thread_phase(
    thread: &ThreadRecord,
    pending_signals: &[ThreadSignalRecord],
    activations: &[SchedulerActivationSnapshot],
    schedules: &[ScheduleRecord],
) -> ThreadPhase {
    if thread.lifecycle.is_terminal() {
        return ThreadPhase::Idle;
    }
    if activations.iter().any(|activation| {
        activation.activation.status == ThreadActivationStatus::Running
            || activation
                .jobs
                .iter()
                .any(|job| job.job.status == ExecutionJobStatus::Running)
    }) {
        return ThreadPhase::Running;
    }
    if activations.iter().any(|activation| {
        activation.activation.status == ThreadActivationStatus::Queued
            || activation
                .jobs
                .iter()
                .any(|job| job.job.status == ExecutionJobStatus::Queued)
    }) || pending_signals
        .iter()
        .any(|signal| signal.status == ThreadSignalStatus::Pending)
    {
        return ThreadPhase::Runnable;
    }
    if activations.iter().any(|activation| {
        activation
            .jobs
            .iter()
            .any(|job| job.job.status == ExecutionJobStatus::WaitingApproval)
    }) || schedules.iter().any(|schedule| {
        matches!(
            schedule.status,
            ScheduleStatus::Queued | ScheduleStatus::Paused
        )
    }) {
        return ThreadPhase::Waiting;
    }
    ThreadPhase::Idle
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
        let session = self
            .runtime
            .get_session(&self.id)
            .await?
            .ok_or_else(|| format!("Session '{}' 不存在", self.id))?;
        if session.status == crate::memory::SessionStatus::Archived {
            return Err("归档 Session 不能接收新消息".into());
        }
        let text = text.into().trim().to_string();
        if text.is_empty() {
            return Err("消息正文不能为空".into());
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
        let event = Event::new(
            event_id.clone(),
            actor.into(),
            TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            [
                ("context_id".to_string(), json!(session.context_id)),
                ("session_id".to_string(), json!(self.id)),
                ("principal_id".to_string(), json!(principal_id)),
                ("client_message_id".to_string(), json!(client_message_id)),
                ("text".to_string(), json!(text)),
            ]
            .into_iter()
            .collect(),
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
    use crate::llm::{Message, Response, ToolCallRepr, ToolDefinition};
    use crate::memory::SessionDirectoryStore as _;
    use crate::permission::PermissionMode;
    use tempfile::NamedTempFile;

    struct ReplyClient;

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

    struct DetachedExecClient {
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

    struct StaticApprovalProvider {
        decision: ApprovalDecision,
        delay: std::time::Duration,
        calls: AtomicU64,
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
        let marker = format!("(id {objective_id})");
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
        runtime.start().await.unwrap();
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
        let reply = tokio::time::timeout(std::time::Duration::from_secs(3), replies.recv())
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
            .inner
            .store
            .create_objective(NewObjective {
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
            })
            .await
            .unwrap();
        runtime
            .bind_objective_harness("objective-harness-entry", "automatic", "1.0.0")
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
        let reply = tokio::time::timeout(std::time::Duration::from_secs(3), replies.recv())
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
        let reply = tokio::time::timeout(std::time::Duration::from_secs(10), replies.recv())
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
        assert!(runtime
            .query_events(QueryFilter {
                topic: Some("objective/wait_satisfied".to_string()),
                ..Default::default()
            })
            .await
            .unwrap()
            .iter()
            .any(
                |event| event.payload.get("reason").and_then(|value| value.as_str())
                    == Some("timer-deadline-reached")
            ));
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
}
