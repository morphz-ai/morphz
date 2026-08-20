//! Stable embedded SDK facade for Morphz.
//!
//! The Runtime owns scheduling and persistence. This module owns the public
//! application contract used by CLI and HTTP adapters. Ingress adapters must
//! authenticate credentials before constructing a [`PrincipalAssertion`];
//! message text is never accepted as identity evidence.

use crate::artifact::{ArtifactTransferRequest, ARTIFACT_TRANSFER_TOOL_NAME};
use crate::config::{
    remove_managed_provider_accounts_at, save_managed_auth_account_at,
    save_managed_auto_review_model_at, save_managed_model_route_at,
    save_managed_provider_account_at, save_managed_provider_account_models_at,
    save_managed_provider_catalog_at, save_managed_provider_instance_at, AppConfig,
    AuthAccountConfig, CredentialConfig, ModelProtocol, ModelRouteAffinity,
    ModelRouteCandidateConfig, ModelRouteConfig, ModelRouteSelection, ProviderInstanceConfig,
    ProviderModelConfig,
};
use crate::event::Event;
use crate::execution::JobReceipt;
use crate::execution_target::{
    edge_artifact_data_channel_from_route, EdgeArtifactDataChannel, EdgeArtifactDataDirection,
};
pub use crate::harness::ExactHarnessRef;
use crate::harness::{HarnessBinding, HarnessDescriptor};
use crate::harness_package::HarnessPackage;
use crate::identity::PrincipalAssertion;
use crate::llm::{ModelRouteDiagnostic, ProviderAccountDiagnostic};
pub use crate::memory::MessageDispatchMode;
use crate::memory::{
    ArtifactTransferExecutionRecord, CapabilityLeaseFilter, CapabilityLeaseMutation,
    CapabilityLeaseRecord, CognitiveContextRecord, ContextUpdate, EdgeCommandMutation,
    EdgeCommandOutputChunk, EdgeCommandRecord, EdgeCommandStatus, EdgeOutputStream,
    ExecutionJobFilter, ExecutionJobRecord, ExecutionJobStatus, ExecutionNodeMutation,
    ExecutionNodeRecord, ExecutionNodeStatus, ExecutionTargetAuthorizationFilter,
    ExecutionTargetAuthorizationMutation, ExecutionTargetAuthorizationRecord,
    ExecutionTargetAuthorizationScope, ExecutionTargetFilter, ExecutionTargetKind,
    ExecutionTargetMutation, ExecutionTargetRecord, ExecutionTargetRegistration,
    ExecutionTargetStatus, NewCognitiveContext, NewExecutionNodeChallenge,
    NewExecutionTargetAuthorization, NewNodePairingCode, NewObjective, NewSession, ObjectiveRecord,
    PairExecutionNode, QueryFilter, SessionRecord, SessionUpdate, ThreadControlAction,
    ThreadMutation,
};
use crate::orchestrator::context::{ContextTokenBudget, MindProjectionAudit};
use crate::provider::auth::{
    OAuthAccountMetadata, OAuthLoginChallenge, OAuthLoginCompletion, OAuthLoginProgress,
    ProviderSubscriptionUsage,
};
use crate::provider::control::{
    ProviderAccountControlAction, ProviderCatalogMutationReceipt, ProviderCatalogObjectKind,
    ProviderControlSnapshot,
};
use crate::provider::routing::EffectiveProviderCatalog;
use crate::runtime::{
    AcknowledgeAttentionCommand, AttentionAcknowledgement, AttentionAcknowledgementsPage,
    ContextOverview, ContextOverviewQuery, ContextTokenBudgetUpdate, DialogueTurnRetryReceipt,
    EventHistoryPage, EventHistoryQuery, MessageIngressError, MessageIngressErrorKind,
    MessageReceipt, ModelUsagePage, ModelUsageQuery, MorphzRuntime, RuntimeEventStream,
    RuntimeOverview, RuntimeOverviewQuery, RuntimeStatus, SchedulerQuery, SchedulerSnapshot,
    SessionMessageOptions, ThreadDetail,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

/// Version of the supported embedded application contract.
pub const SDK_CONTRACT_VERSION: &str = "1";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SdkErrorCode {
    InvalidArgument,
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    Internal,
}

impl SdkErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidArgument => "invalid_argument",
            Self::Unauthorized => "unauthorized",
            Self::Forbidden => "forbidden",
            Self::NotFound => "not_found",
            Self::Conflict => "conflict",
            Self::Internal => "internal",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SdkError {
    pub code: SdkErrorCode,
    pub message: String,
}

impl SdkError {
    pub fn new(code: SdkErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn internal(error: impl fmt::Display) -> Self {
        Self::new(SdkErrorCode::Internal, error.to_string())
    }
}

impl fmt::Display for SdkError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for SdkError {}

pub type SdkResult<T> = Result<T, SdkError>;

/// Product-level OAuth setup request. Callers choose a supported service;
/// Provider and account identifiers remain an implementation detail of
/// the SDK instead of leaking into the ordinary Dashboard flow.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OAuthProviderSetup {
    pub provider_id: String,
    pub provider_adapter: String,
    pub protocol: ModelProtocol,
    pub base_url: String,
    pub account_id: String,
    pub auth_adapter: String,
    /// Optional delivery adapter for this login attempt. The durable account
    /// keeps one canonical auth adapter while compatible transports (for
    /// example Codex browser PKCE and device code) remain a user choice.
    pub login_adapter: Option<String>,
    pub credential_ref: String,
    pub secret_backend: Option<String>,
    pub account_label: String,
}

fn validate_provider_catalog_snapshot(snapshot: &ProviderControlSnapshot) -> SdkResult<()> {
    let app = AppConfig {
        provider_instances: snapshot.provider_instances.clone(),
        auth_accounts: snapshot
            .auth_accounts
            .iter()
            .map(|(id, record)| (id.clone(), record.config.clone()))
            .collect(),
        model_routes: snapshot.model_routes.clone(),
        ..AppConfig::default()
    };
    EffectiveProviderCatalog::from_config(&app)
        .map(|_| ())
        .map_err(|error| SdkError::new(SdkErrorCode::InvalidArgument, error))
}

/// Fold catalog edits already persisted in the managed layer over the live
/// Runtime projection before validating the next edit.
fn merge_managed_provider_catalog(
    snapshot: &mut ProviderControlSnapshot,
    managed_config_path: &Path,
) -> SdkResult<()> {
    if !managed_config_path.exists() {
        return Ok(());
    }
    let contents = std::fs::read_to_string(managed_config_path).map_err(SdkError::internal)?;
    if contents.trim().is_empty() {
        return Ok(());
    }
    let managed: AppConfig = toml::from_str(&contents)
        .map_err(|error| SdkError::new(SdkErrorCode::InvalidArgument, error.to_string()))?;
    snapshot
        .provider_instances
        .extend(managed.provider_instances);
    for (account_id, account) in managed.auth_accounts {
        snapshot.auth_accounts.insert(
            account_id,
            crate::provider::control::ProviderAccountControlRecord {
                effective_enabled: account.enabled(),
                oauth: !matches!(
                    account.auth_adapter.as_str(),
                    "credential" | "none" | "env" | "api-key"
                ),
                authenticated: false,
                oauth_metadata: None,
                state: None,
                config: account,
            },
        );
    }
    snapshot.model_routes.extend(managed.model_routes);
    Ok(())
}

fn remove_accounts_from_catalog(config: &mut AppConfig, account_ids: &BTreeSet<String>) {
    let removed_credential_refs = account_ids
        .iter()
        .filter_map(|account_id| config.auth_accounts.get(account_id))
        .map(|account| account.credential_ref.trim())
        .filter(|credential_ref| !credential_ref.is_empty())
        .map(str::to_string)
        .collect::<BTreeSet<_>>();
    for account_id in account_ids {
        config.auth_accounts.remove(account_id);
    }

    let retained_credential_refs = config
        .auth_accounts
        .values()
        .map(|account| account.credential_ref.trim())
        .filter(|credential_ref| !credential_ref.is_empty())
        .chain(
            config
                .providers
                .values()
                .filter_map(|provider| provider.credential.as_deref())
                .map(str::trim)
                .filter(|credential_ref| !credential_ref.is_empty()),
        )
        .map(str::to_string)
        .collect::<BTreeSet<_>>();
    config.credentials.retain(|credential_id, _| {
        !removed_credential_refs.contains(credential_id)
            || retained_credential_refs.contains(credential_id)
    });

    let empty_providers = config
        .provider_instances
        .iter_mut()
        .filter_map(|(provider_id, provider)| {
            let previous_len = provider.accounts.len();
            provider
                .accounts
                .retain(|account_id| !account_ids.contains(account_id));
            (previous_len != provider.accounts.len() && provider.accounts.is_empty())
                .then(|| provider_id.clone())
        })
        .collect::<BTreeSet<_>>();
    config
        .provider_instances
        .retain(|provider_id, _| !empty_providers.contains(provider_id));

    let empty_routes = config
        .model_routes
        .iter_mut()
        .filter_map(|(route_id, route)| {
            let previous_len = route.candidates.len();
            route.candidates.retain(|candidate| {
                candidate
                    .account
                    .as_ref()
                    .is_none_or(|account_id| !account_ids.contains(account_id))
                    && !empty_providers.contains(&candidate.provider)
            });
            (previous_len != route.candidates.len() && route.candidates.is_empty())
                .then(|| route_id.clone())
        })
        .collect::<BTreeSet<_>>();
    config
        .model_routes
        .retain(|route_id, _| !empty_routes.contains(route_id));

    if config
        .llm
        .provider
        .as_ref()
        .is_some_and(|provider_id| empty_providers.contains(provider_id))
    {
        config.llm.provider = None;
    }
    let selected_model_exists = config.model_routes.iter().any(|(route_id, route)| {
        route_id == &config.llm.model
            || route.aliases.iter().any(|alias| alias == &config.llm.model)
    });
    if !selected_model_exists {
        config.llm.model = config
            .model_routes
            .keys()
            .next()
            .cloned()
            .unwrap_or_default();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MessageAttachmentInput {
    pub name: String,
    pub media_type: String,
    pub data: Vec<u8>,
}

/// A typed reference carried by one user message. The caller supplies only
/// the stable identity; Runtime resolves and persists authoritative display
/// metadata after checking the current Principal's visibility boundary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MessageReferenceInput {
    Session { session_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SendMessageCommand {
    pub session_id: String,
    pub text: String,
    pub actor: String,
    pub client_message_id: Option<String>,
    #[serde(default)]
    pub attachments: Vec<MessageAttachmentInput>,
    /// Stable typed references selected by the caller. Referencing a Session
    /// neither reads its transcript nor activates it; the Agent may choose to
    /// call `session_signal` after interpreting the current message.
    #[serde(default)]
    pub references: Vec<MessageReferenceInput>,
    /// Optional exact Harness selection for this ordinary Evaluation. Omit to
    /// let the model either answer normally or discover/select one lazily.
    #[serde(default)]
    pub harness: Option<crate::harness::ExactHarnessRef>,
    /// One-shot scheduling choice for this message. Omit to use the Runtime's
    /// configured default without changing that configuration.
    #[serde(default)]
    pub dispatch_mode: Option<MessageDispatchMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RetryDialogueTurnCommand {
    pub session_id: String,
    pub root_turn_id: String,
    pub expected_thread_revision: u64,
    pub expected_result_event_id: String,
    /// Caller-generated idempotency key. Retrying the HTTP request with the
    /// same key returns the same logical restart instead of advancing another
    /// generation.
    pub retry_request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionEventsQuery {
    pub session_id: String,
    pub after_sequence: Option<u64>,
    /// Stable backward cursor over the immutable Event Sequence. Mutually
    /// exclusive with `after_sequence`.
    pub before_sequence: Option<u64>,
    /// Restrict the page to Events required to reconstruct the human-facing
    /// Dialogue presentation, including the durable tool-call lifecycle. The
    /// limit then means "latest N presentation Events", not "latest N
    /// arbitrary persisted Events".
    pub conversation_only: bool,
    pub limit: usize,
}

fn conversation_event_topics() -> &'static [&'static str] {
    &[
        "chat/user_message",
        "chat/reply",
        "chat/outbound_message",
        "chat/session_signal",
        "chat/progress",
        "chat/assistant_call",
        // These Events are the durable fallback for the live WebSocket tool
        // lifecycle. Omitting them makes a completed call remain "running"
        // forever whenever the browser misses its live Tool Output.
        "runtime/tool_calls_selected",
        "chat/tool_output",
        "runtime/artifact_transfer_completed",
        "runtime/artifact_transfer_failed",
        "runtime/artifact_transfer_cancelled",
        "chat/cancelled",
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreateNodePairingCodeCommand {
    /// Short-lived authority only. The SDK clamps this to 1..=900 seconds.
    pub expires_in_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NodePairingCode {
    pub code: String,
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PairExecutionNodeCommand {
    pub code: String,
    pub node_id: Option<String>,
    pub name: String,
    pub device_key_fingerprint: String,
    /// Hex-encoded Ed25519 public key generated and retained by the Node.
    pub device_public_key: String,
    pub protocol_version: u32,
    pub platform: Option<String>,
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PairedExecutionNode {
    pub node: ExecutionNodeRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionNodeIdentityChallenge {
    pub challenge_id: String,
    pub nonce: String,
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConnectExecutionNodeCommand {
    pub challenge_id: String,
    pub nonce: String,
    /// Hex-encoded Ed25519 signature over the canonical connection proof.
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionNodeConnection {
    pub token: String,
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RotateExecutionNodeKeyCommand {
    pub expected_revision: u64,
    pub device_key_fingerprint: String,
    /// Hex-encoded replacement Ed25519 public key. The corresponding private
    /// key never leaves the Edge Node.
    pub device_public_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutionNodeHeartbeatCommand {
    pub platform: Option<String>,
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub metadata: serde_json::Value,
    #[serde(default)]
    pub targets: Vec<ExecutionTargetRegistration>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClaimEdgeCommand {
    pub worker_id: String,
    pub lease_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HeartbeatEdgeCommand {
    pub expected_revision: u64,
    pub claim_token: String,
    pub lease_seconds: u64,
    pub side_effect_started: bool,
    pub progress: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FinishEdgeCommand {
    pub expected_revision: u64,
    pub claim_token: String,
    pub status: EdgeCommandStatus,
    pub output: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppendEdgeOutputCommand {
    pub claim_token: String,
    pub stream: EdgeOutputStream,
    pub text: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionJobQuery {
    pub context_id: Option<String>,
    pub thread_id: Option<String>,
    pub target_id: Option<String>,
    pub status: Option<ExecutionJobStatus>,
    pub include_terminal: bool,
    pub newest_first: bool,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SubmitArtifactTransferCommand {
    pub session_id: String,
    pub transfer: ArtifactTransferRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ArtifactTransferOutput {
    pub job: ExecutionJobRecord,
    pub event: Option<Event>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthorizeExecutionTargetCommand {
    pub target_id: String,
    pub scope: ExecutionTargetAuthorizationScope,
    pub scope_id: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ObjectiveRequestOrigin {
    Embedded,
    Cli,
    Http,
}

impl ObjectiveRequestOrigin {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Embedded => "embedded",
            Self::Cli => "cli",
            Self::Http => "http",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreateObjectiveCommand {
    pub id: String,
    pub coordinator_session_id: String,
    pub delivery_session_id: Option<String>,
    pub parent_objective_id: Option<String>,
    pub stated_objective: String,
    pub token_budget: Option<u64>,
    pub source_event_id: String,
    pub source_origin: ObjectiveRequestOrigin,
    pub harness: Option<ExactHarnessRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreateObjectiveResult {
    pub objective: ObjectiveRecord,
    pub harness_binding: Option<HarnessBinding>,
}

/// Principal-authorized stream containing Events for exactly one Session.
///
/// The Runtime Event bus is process-wide. This wrapper is the SDK security
/// boundary which prevents a caller authorized for one Session from observing
/// another Session through a wildcard subscription.
pub struct SessionEventStream {
    inner: RuntimeEventStream,
    session_id: String,
}

impl SessionEventStream {
    fn matches(&self, event: &Event) -> bool {
        event
            .payload
            .get("session_id")
            .and_then(serde_json::Value::as_str)
            == Some(self.session_id.as_str())
    }

    pub async fn recv(&mut self) -> Option<Event> {
        while let Some(event) = self.inner.recv().await {
            if self.matches(&event) {
                return Some(event);
            }
        }
        None
    }

    pub fn try_recv(&mut self) -> Result<Event, tokio::sync::mpsc::error::TryRecvError> {
        loop {
            let event = self.inner.try_recv()?;
            if self.matches(&event) {
                return Ok(event);
            }
        }
    }
}

/// A cloneable, transport-neutral application facade.
#[derive(Clone)]
pub struct MorphzSdk {
    runtime: MorphzRuntime,
    pending_oauth_setups: Arc<RwLock<HashMap<String, PendingOAuthProviderSetup>>>,
}

#[derive(Clone)]
struct PendingOAuthProviderSetup {
    managed_config_path: PathBuf,
    setup: OAuthProviderSetup,
}

impl MorphzSdk {
    pub fn new(runtime: MorphzRuntime) -> Self {
        Self {
            runtime,
            pending_oauth_setups: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn default_principal(&self) -> PrincipalAssertion {
        PrincipalAssertion {
            principal_id: self.runtime.identity().principal_id.clone(),
            provider_id: "runtime-default".to_string(),
            assurance: "runtime-default".to_string(),
            display_name: None,
        }
    }

    /// Administrative Context projection shared by CLI, Dashboard and other
    /// trusted Runtime hosts. Principal-scoped products must authorize their
    /// Session before selecting it as the active Session.
    pub async fn context_overview(
        &self,
        context_id: &str,
        query: ContextOverviewQuery,
    ) -> SdkResult<ContextOverview> {
        self.runtime
            .context_overview(context_id, query)
            .await
            .map_err(SdkError::internal)
    }

    /// Runtime-wide bounded operator projection shared by the embedded
    /// Dashboard and any trusted host application.
    pub async fn runtime_overview(
        &self,
        query: RuntimeOverviewQuery,
    ) -> SdkResult<RuntimeOverview> {
        self.runtime
            .runtime_overview(query)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn scheduler_snapshot(
        &self,
        context_id: &str,
        query: SchedulerQuery,
    ) -> SdkResult<SchedulerSnapshot> {
        self.runtime
            .scheduler_snapshot(context_id, query)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn model_usage(
        &self,
        context_id: &str,
        query: ModelUsageQuery,
    ) -> SdkResult<ModelUsagePage> {
        self.runtime
            .model_usage(context_id, query)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn attention_acknowledgements(
        &self,
        context_id: &str,
    ) -> SdkResult<Vec<AttentionAcknowledgement>> {
        self.runtime
            .attention_acknowledgements(context_id)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn attention_acknowledgements_page(
        &self,
        context_id: &str,
        after_sequence: Option<u64>,
        limit: usize,
    ) -> SdkResult<AttentionAcknowledgementsPage> {
        self.runtime
            .attention_acknowledgements_page(context_id, after_sequence, limit)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn acknowledge_attention(
        &self,
        context_id: &str,
        command: AcknowledgeAttentionCommand,
    ) -> SdkResult<AttentionAcknowledgement> {
        self.runtime
            .acknowledge_attention(context_id, command)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn thread_detail(
        &self,
        context_id: &str,
        thread_id: &str,
    ) -> SdkResult<ThreadDetail> {
        self.runtime
            .thread_detail(context_id, thread_id)
            .await
            .map_err(SdkError::internal)?
            .ok_or_else(|| {
                SdkError::new(
                    SdkErrorCode::NotFound,
                    format!("Thread '{thread_id}' 在 Context '{context_id}' 中不存在"),
                )
            })
    }

    pub async fn control_thread(
        &self,
        context_id: &str,
        thread_id: &str,
        expected_revision: u64,
        action: ThreadControlAction,
        reason: &str,
    ) -> SdkResult<ThreadMutation> {
        self.runtime
            .control_thread(context_id, thread_id, expected_revision, action, reason)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn supersede_thread(
        &self,
        context_id: &str,
        thread_id: &str,
        expected_revision: u64,
        intent: &str,
        reason: &str,
    ) -> SdkResult<ThreadMutation> {
        self.runtime
            .supersede_thread(context_id, thread_id, expected_revision, intent, reason)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn query_event_history(
        &self,
        query: EventHistoryQuery,
    ) -> SdkResult<EventHistoryPage> {
        self.runtime
            .query_event_history(query)
            .await
            .map_err(SdkError::internal)
    }

    pub fn runtime_status(&self) -> RuntimeStatus {
        self.runtime.runtime_status()
    }

    pub fn secret_backend_id(&self) -> &str {
        self.runtime.secret_backend_id()
    }

    pub fn secret_backend_statuses(&self) -> Vec<crate::secret_store::SecretBackendStatus> {
        self.runtime.secret_backend_statuses()
    }

    pub fn secret_import_candidates(
        &self,
    ) -> SdkResult<Vec<crate::secret_store::SecretImportCandidate>> {
        self.runtime
            .secret_import_candidates()
            .map_err(SdkError::internal)
    }

    pub fn recent_secret_usage(
        &self,
        limit: usize,
    ) -> SdkResult<Vec<crate::secret_store::SecretUseAuditRecord>> {
        self.runtime
            .recent_secret_usage(limit)
            .map_err(SdkError::internal)
    }

    pub fn list_managed_secrets(&self) -> SdkResult<Vec<crate::secret_store::ManagedSecret>> {
        self.runtime
            .list_managed_secrets()
            .map_err(SdkError::internal)
    }

    pub fn put_managed_secret(
        &self,
        name: &str,
        value: &str,
        scope_kind: crate::secret_store::SecretScopeKind,
        scope_id: Option<String>,
    ) -> SdkResult<crate::secret_store::ManagedSecret> {
        self.runtime
            .put_managed_secret(name, value, scope_kind, scope_id)
            .map_err(SdkError::internal)
    }

    pub fn put_managed_secret_with_backend(
        &self,
        name: &str,
        value: &str,
        scope_kind: crate::secret_store::SecretScopeKind,
        scope_id: Option<String>,
        value_backend: &str,
    ) -> SdkResult<crate::secret_store::ManagedSecret> {
        self.runtime
            .put_managed_secret_with_backend(name, value, scope_kind, scope_id, value_backend)
            .map_err(SdkError::internal)
    }

    pub fn import_managed_secret(
        &self,
        name: &str,
        scope_kind: crate::secret_store::SecretScopeKind,
        scope_id: Option<String>,
        value_backend: &str,
    ) -> SdkResult<crate::secret_store::ManagedSecret> {
        self.runtime
            .import_managed_secret(name, scope_kind, scope_id, value_backend)
            .map_err(SdkError::internal)
    }

    pub fn delete_managed_secret(&self, name: &str) -> SdkResult<bool> {
        self.runtime
            .delete_managed_secret(name)
            .map_err(SdkError::internal)
    }

    pub async fn provider_control_snapshot(&self) -> SdkResult<ProviderControlSnapshot> {
        self.runtime
            .provider_control_snapshot()
            .await
            .map_err(SdkError::internal)
    }

    pub async fn discover_provider_models(
        &self,
        protocol: ModelProtocol,
        base_url: &str,
        api_key: &str,
    ) -> SdkResult<Vec<String>> {
        crate::provider::discover_protocol_models(protocol, base_url, api_key)
            .await
            .map_err(SdkError::internal)
    }

    pub fn provider_oauth_adapter_descriptors(
        &self,
    ) -> Vec<crate::provider::auth::AuthAdapterDescriptor> {
        self.runtime.provider_oauth_adapter_descriptors()
    }

    pub async fn recent_provider_attempts(
        &self,
        limit: usize,
    ) -> SdkResult<Vec<crate::runtime::ModelUsageRecord>> {
        self.runtime
            .recent_provider_attempts(limit)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn diagnose_model_route(
        &self,
        alias: &str,
        account_id: Option<&str>,
    ) -> SdkResult<ModelRouteDiagnostic> {
        self.runtime
            .diagnose_model_route(alias, account_id)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn refresh_model_catalog(
        &self,
        alias: &str,
        account_id: Option<&str>,
    ) -> SdkResult<ModelRouteDiagnostic> {
        self.runtime
            .refresh_model_catalog(alias, account_id)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn diagnose_provider_account(
        &self,
        account_id: &str,
        model: Option<&str>,
    ) -> SdkResult<ProviderAccountDiagnostic> {
        self.runtime
            .diagnose_provider_account(account_id, model)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn refresh_provider_account_catalog(
        &self,
        account_id: &str,
        model: Option<&str>,
    ) -> SdkResult<ProviderAccountDiagnostic> {
        self.runtime
            .refresh_provider_account_catalog(account_id, model)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn put_provider_instance_config(
        &self,
        managed_config_path: &Path,
        provider_id: &str,
        provider: ProviderInstanceConfig,
    ) -> SdkResult<ProviderCatalogMutationReceipt> {
        let mut snapshot = self.provider_control_snapshot().await?;
        merge_managed_provider_catalog(&mut snapshot, managed_config_path)?;
        snapshot
            .provider_instances
            .insert(provider_id.to_string(), provider.clone());
        validate_provider_catalog_snapshot(&snapshot)?;
        save_managed_provider_instance_at(managed_config_path, provider_id, &provider)
            .map_err(SdkError::internal)?;
        let mut live = self
            .runtime
            .provider_catalog_config()
            .map_err(SdkError::internal)?;
        live.provider_instances
            .insert(provider_id.to_string(), provider);
        self.runtime
            .replace_provider_catalog(live)
            .await
            .map_err(SdkError::internal)?;
        Ok(ProviderCatalogMutationReceipt::new(
            ProviderCatalogObjectKind::ProviderInstance,
            provider_id,
            managed_config_path,
        ))
    }

    /// Atomically persist one complete Provider/Account/Route graph.
    ///
    /// This is the setup boundary shared by Dashboard, HTTP clients and future
    /// SDK hosts.  Saving the three objects independently can expose a broken
    /// intermediate catalog after a process stop, so first-run setup must use
    /// this operation instead of sequencing the individual mutation methods.
    #[allow(clippy::too_many_arguments)]
    pub async fn put_provider_catalog_config(
        &self,
        managed_config_path: &Path,
        provider_id: &str,
        provider: ProviderInstanceConfig,
        account_id: &str,
        account: AuthAccountConfig,
        credential: Option<(&str, CredentialConfig)>,
        route_id: &str,
        route: ModelRouteConfig,
    ) -> SdkResult<ProviderCatalogMutationReceipt> {
        let mut snapshot = self.provider_control_snapshot().await?;
        merge_managed_provider_catalog(&mut snapshot, managed_config_path)?;
        snapshot
            .provider_instances
            .insert(provider_id.to_string(), provider.clone());
        snapshot.auth_accounts.insert(
            account_id.to_string(),
            crate::provider::control::ProviderAccountControlRecord {
                effective_enabled: account.enabled(),
                oauth: !matches!(
                    account.auth_adapter.as_str(),
                    "credential" | "none" | "env" | "api-key"
                ),
                authenticated: false,
                oauth_metadata: None,
                state: None,
                config: account.clone(),
            },
        );
        snapshot
            .model_routes
            .insert(route_id.to_string(), route.clone());
        validate_provider_catalog_snapshot(&snapshot)?;
        let selected_model = snapshot
            .model_routes
            .iter()
            .any(|(candidate_route_id, candidate_route)| {
                candidate_route_id == &snapshot.selected_model_alias
                    || candidate_route
                        .aliases
                        .iter()
                        .any(|alias| alias == &snapshot.selected_model_alias)
            })
            .then(|| snapshot.selected_model_alias.clone())
            .filter(|selected| !selected.trim().is_empty())
            .unwrap_or_else(|| route_id.to_string());

        let credential_ref = credential.as_ref().map(|(id, config)| (*id, config));
        save_managed_provider_catalog_at(
            managed_config_path,
            provider_id,
            &provider,
            account_id,
            &account,
            credential_ref,
            route_id,
            &route,
            &selected_model,
        )
        .map_err(SdkError::internal)?;
        if account.auth_adapter.ends_with("-oauth") {
            self.runtime
                .register_provider_auth_account(account_id, account.clone())
                .map_err(SdkError::internal)?;
        }
        let mut live = self
            .runtime
            .provider_catalog_config()
            .map_err(SdkError::internal)?;
        live.provider_instances
            .insert(provider_id.to_string(), provider);
        live.auth_accounts.insert(account_id.to_string(), account);
        if let Some((credential_id, credential)) = credential {
            live.credentials
                .insert(credential_id.to_string(), credential);
        }
        live.model_routes.insert(route_id.to_string(), route);
        live.llm.model = selected_model;
        self.runtime
            .replace_provider_catalog(live)
            .await
            .map_err(SdkError::internal)?;
        Ok(ProviderCatalogMutationReceipt::new(
            ProviderCatalogObjectKind::ProviderCatalog,
            route_id,
            managed_config_path,
        ))
    }

    /// Start OAuth for one account. No Provider, account, model or route is
    /// persisted until authorization succeeds.
    pub async fn setup_oauth_provider_account(
        &self,
        managed_config_path: &Path,
        setup: OAuthProviderSetup,
    ) -> SdkResult<OAuthLoginChallenge> {
        for (label, value) in [
            ("Provider ID", setup.provider_id.as_str()),
            ("Provider Adapter", setup.provider_adapter.as_str()),
            ("Provider URL", setup.base_url.as_str()),
            ("Account ID", setup.account_id.as_str()),
            ("Auth Adapter", setup.auth_adapter.as_str()),
            ("Credential Ref", setup.credential_ref.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(SdkError::new(
                    SdkErrorCode::InvalidArgument,
                    format!("{label} 不能为空"),
                ));
            }
        }

        let account = AuthAccountConfig {
            auth_adapter: setup.auth_adapter.clone(),
            credential_ref: setup.credential_ref.clone(),
            secret_backend: setup.secret_backend.clone(),
            provider: Some(setup.provider_id.clone()),
            label: Some(setup.account_label.clone()),
            enabled: true,
        };
        self.runtime
            .register_transient_provider_auth_account(&setup.account_id, account)
            .map_err(SdkError::internal)?;
        let challenge = match setup.login_adapter.as_deref() {
            Some(adapter_id) if adapter_id != setup.auth_adapter => {
                self.start_provider_oauth_login_using(&setup.account_id, adapter_id)
                    .await
            }
            _ => self.start_provider_oauth_login(&setup.account_id).await,
        };
        let challenge = match challenge {
            Ok(challenge) => challenge,
            Err(error) => {
                let _ = self
                    .runtime
                    .discard_transient_provider_auth_account(&setup.account_id);
                return Err(error);
            }
        };
        self.pending_oauth_setups
            .write()
            .map_err(|_| SdkError::internal("OAuth setup registry lock poisoned"))?
            .insert(
                challenge.login_id.clone(),
                PendingOAuthProviderSetup {
                    managed_config_path: managed_config_path.to_path_buf(),
                    setup,
                },
            );
        Ok(challenge)
    }

    /// One-time cleanup for catalogs written by older OAuth setup flows.
    /// Authentication attempts without a token are not accounts and are
    /// removed from managed config, the live router, Secret Store and state DB.
    pub async fn prune_unfinished_oauth_accounts(
        &self,
        managed_config_path: &Path,
    ) -> SdkResult<usize> {
        if !managed_config_path.exists() {
            return Ok(0);
        }
        let managed_contents =
            std::fs::read_to_string(managed_config_path).map_err(SdkError::internal)?;
        if managed_contents.trim().is_empty() {
            return Ok(0);
        }
        let managed: AppConfig = toml::from_str(&managed_contents)
            .map_err(|error| SdkError::new(SdkErrorCode::InvalidArgument, error.to_string()))?;
        let managed_account_ids = managed
            .auth_accounts
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>();
        let snapshot = self.provider_control_snapshot().await?;
        let account_ids = snapshot
            .auth_accounts
            .iter()
            .filter(|(account_id, record)| {
                // Legacy setup attempts were written before authentication
                // and never received a durable account-state row. Preserve a
                // completed account if its Secret Backend is temporarily
                // unavailable; absence of token metadata alone is not safe
                // deletion evidence.
                managed_account_ids.contains(*account_id)
                    && record.oauth
                    && !record.authenticated
                    && record.state.is_none()
            })
            .map(|(account_id, _)| account_id.clone())
            .collect::<BTreeSet<_>>();
        if account_ids.is_empty() {
            return Ok(0);
        }

        remove_managed_provider_accounts_at(managed_config_path, &account_ids)
            .map_err(SdkError::internal)?;
        for account_id in &account_ids {
            self.runtime
                .remove_provider_auth_account(account_id)
                .await
                .map_err(SdkError::internal)?;
        }
        let mut live = self
            .runtime
            .provider_catalog_config()
            .map_err(SdkError::internal)?;
        remove_accounts_from_catalog(&mut live, &account_ids);
        self.runtime
            .replace_provider_catalog(live)
            .await
            .map_err(SdkError::internal)?;
        Ok(account_ids.len())
    }

    async fn finalize_oauth_provider_account(
        &self,
        pending: &PendingOAuthProviderSetup,
    ) -> SdkResult<()> {
        let setup = &pending.setup;
        let mut snapshot = self.provider_control_snapshot().await?;
        merge_managed_provider_catalog(&mut snapshot, &pending.managed_config_path)?;

        let mut provider = snapshot
            .provider_instances
            .get(&setup.provider_id)
            .cloned()
            .unwrap_or_else(|| ProviderInstanceConfig {
                adapter: setup.provider_adapter.clone(),
                protocol: setup.protocol,
                base_url: setup.base_url.clone(),
                accounts: Vec::new(),
                models: BTreeMap::new(),
                headers: BTreeMap::new(),
                env_headers: BTreeMap::new(),
            });
        provider.adapter = setup.provider_adapter.clone();
        provider.protocol = setup.protocol;
        provider.base_url = setup.base_url.clone();
        if !provider.accounts.iter().any(|id| id == &setup.account_id) {
            provider.accounts.push(setup.account_id.clone());
        }

        let account = AuthAccountConfig {
            auth_adapter: setup.auth_adapter.clone(),
            credential_ref: setup.credential_ref.clone(),
            secret_backend: setup.secret_backend.clone(),
            provider: Some(setup.provider_id.clone()),
            label: Some(setup.account_label.clone()),
            enabled: true,
        };
        let mut live = self
            .runtime
            .provider_catalog_config()
            .map_err(SdkError::internal)?;
        live.provider_instances
            .insert(setup.provider_id.clone(), provider.clone());
        live.auth_accounts
            .insert(setup.account_id.clone(), account.clone());
        EffectiveProviderCatalog::from_config(&live)
            .map_err(|error| SdkError::new(SdkErrorCode::InvalidArgument, error))?;
        save_managed_provider_account_at(
            &pending.managed_config_path,
            &setup.provider_id,
            &provider,
            &setup.account_id,
            &account,
        )
        .map_err(SdkError::internal)?;
        self.runtime
            .replace_provider_catalog(live)
            .await
            .map_err(SdkError::internal)?;
        self.runtime
            .mark_provider_auth_account_ready(&setup.account_id)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn put_auth_account_config(
        &self,
        managed_config_path: &Path,
        account_id: &str,
        account: AuthAccountConfig,
    ) -> SdkResult<ProviderCatalogMutationReceipt> {
        let mut snapshot = self.provider_control_snapshot().await?;
        merge_managed_provider_catalog(&mut snapshot, managed_config_path)?;
        snapshot.auth_accounts.insert(
            account_id.to_string(),
            crate::provider::control::ProviderAccountControlRecord {
                effective_enabled: account.enabled(),
                oauth: !matches!(
                    account.auth_adapter.as_str(),
                    "credential" | "none" | "env" | "api-key"
                ),
                authenticated: false,
                oauth_metadata: None,
                state: None,
                config: account.clone(),
            },
        );
        validate_provider_catalog_snapshot(&snapshot)?;
        save_managed_auth_account_at(managed_config_path, account_id, &account)
            .map_err(SdkError::internal)?;
        if account.auth_adapter.ends_with("-oauth") {
            self.runtime
                .register_provider_auth_account(account_id, account.clone())
                .map_err(SdkError::internal)?;
        }
        let mut live = self
            .runtime
            .provider_catalog_config()
            .map_err(SdkError::internal)?;
        live.auth_accounts.insert(account_id.to_string(), account);
        self.runtime
            .replace_provider_catalog(live)
            .await
            .map_err(SdkError::internal)?;
        Ok(ProviderCatalogMutationReceipt::new(
            ProviderCatalogObjectKind::AuthAccount,
            account_id,
            managed_config_path,
        ))
    }

    /// Delete one Dashboard-managed authentication account and every catalog
    /// fragment that becomes unreachable with it. Shared credentials,
    /// Provider pools and routes are retained.
    pub async fn delete_auth_account_config(
        &self,
        managed_config_path: &Path,
        account_id: &str,
    ) -> SdkResult<ProviderCatalogMutationReceipt> {
        let account_id = account_id.trim();
        if account_id.is_empty() {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Auth Account ID 不能为空",
            ));
        }
        let managed_contents =
            std::fs::read_to_string(managed_config_path).map_err(SdkError::internal)?;
        let managed: AppConfig = toml::from_str(&managed_contents)
            .map_err(|error| SdkError::new(SdkErrorCode::InvalidArgument, error.to_string()))?;
        if !managed.auth_accounts.contains_key(account_id) {
            return Err(SdkError::new(
                SdkErrorCode::Conflict,
                format!("Auth Account '{account_id}' 不由 Dashboard 管理；请在其来源配置中删除"),
            ));
        }

        let mut live = self
            .runtime
            .provider_catalog_config()
            .map_err(SdkError::internal)?;
        let account = live.auth_accounts.get(account_id).cloned().ok_or_else(|| {
            SdkError::new(
                SdkErrorCode::NotFound,
                format!("Auth Account '{account_id}' 不存在"),
            )
        })?;
        let credential_id = (!account.credential_ref.trim().is_empty())
            .then(|| account.credential_ref.trim().to_string());
        let secret_name = credential_id.as_deref().and_then(|credential_id| {
            live.credentials
                .get(credential_id)
                .filter(|credential| credential.source == crate::config::CredentialSource::Env)
                .and_then(|credential| credential.name.clone())
        });

        let account_ids = BTreeSet::from([account_id.to_string()]);
        remove_accounts_from_catalog(&mut live, &account_ids);
        EffectiveProviderCatalog::from_config(&live).map_err(|error| {
            SdkError::new(
                SdkErrorCode::Conflict,
                format!(
                    "删除 Auth Account '{account_id}' 后没有可用模型路由；请先添加另一个模型服务：{error}"
                ),
            )
        })?;

        remove_managed_provider_accounts_at(managed_config_path, &account_ids)
            .map_err(SdkError::internal)?;
        self.runtime
            .replace_provider_catalog(live.clone())
            .await
            .map_err(SdkError::internal)?;
        self.runtime
            .remove_provider_auth_account(account_id)
            .await
            .map_err(SdkError::internal)?;

        let removed_credential = credential_id
            .as_ref()
            .is_some_and(|credential_id| !live.credentials.contains_key(credential_id));
        if removed_credential {
            if let Some(secret_name) = secret_name {
                self.delete_managed_secret(&secret_name)?;
            }
        }

        Ok(ProviderCatalogMutationReceipt::new(
            ProviderCatalogObjectKind::AuthAccount,
            account_id,
            managed_config_path,
        ))
    }

    pub async fn put_model_route_config(
        &self,
        managed_config_path: &Path,
        route_id: &str,
        route: ModelRouteConfig,
    ) -> SdkResult<ProviderCatalogMutationReceipt> {
        let mut snapshot = self.provider_control_snapshot().await?;
        merge_managed_provider_catalog(&mut snapshot, managed_config_path)?;
        snapshot
            .model_routes
            .insert(route_id.to_string(), route.clone());
        validate_provider_catalog_snapshot(&snapshot)?;
        save_managed_model_route_at(managed_config_path, route_id, &route)
            .map_err(SdkError::internal)?;
        let mut live = self
            .runtime
            .provider_catalog_config()
            .map_err(SdkError::internal)?;
        live.model_routes.insert(route_id.to_string(), route);
        self.runtime
            .replace_provider_catalog(live)
            .await
            .map_err(SdkError::internal)?;
        Ok(ProviderCatalogMutationReceipt::new(
            ProviderCatalogObjectKind::ModelRoute,
            route_id,
            managed_config_path,
        ))
    }

    pub fn put_auto_review_model(
        &self,
        managed_config_path: &Path,
        model: Option<String>,
    ) -> SdkResult<ProviderCatalogMutationReceipt> {
        let model = model
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let previous = self.runtime.auto_review_model();
        self.runtime
            .set_auto_review_model(model.as_deref())
            .map_err(|error| SdkError::new(SdkErrorCode::InvalidArgument, error.to_string()))?;
        if let Err(error) = save_managed_auto_review_model_at(managed_config_path, model.as_deref())
        {
            let rollback = self.runtime.set_auto_review_model(previous.as_deref());
            let message = match rollback {
                Ok(()) => error,
                Err(rollback_error) => format!(
                    "{error}; automatic reviewer runtime rollback also failed: {rollback_error}"
                ),
            };
            return Err(SdkError::internal(message));
        }
        Ok(ProviderCatalogMutationReceipt::new(
            ProviderCatalogObjectKind::PermissionSettings,
            "auto-review-model",
            managed_config_path,
        ))
    }

    /// Replace the enabled physical-model subset for one account. Remote
    /// discovery remains observational data; this method is the explicit
    /// operator decision that turns discovered models into logical routes.
    pub async fn put_provider_account_models(
        &self,
        managed_config_path: &Path,
        account_id: &str,
        models: BTreeMap<String, ProviderModelConfig>,
        display_aliases: BTreeMap<String, Option<String>>,
    ) -> SdkResult<ProviderCatalogMutationReceipt> {
        if models.is_empty() {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "每个已启用账号至少需要选择一个模型",
            ));
        }
        for (model, profile) in &models {
            if model.trim().is_empty() || model.trim() != model {
                return Err(SdkError::new(
                    SdkErrorCode::InvalidArgument,
                    "模型 ID 不能为空或包含首尾空白",
                ));
            }
            if [
                profile.context_window_tokens,
                profile.max_input_tokens,
                profile.max_output_tokens,
                profile.max_input_attachments,
                profile.max_input_attachment_bytes,
                profile.max_input_attachment_total_bytes,
            ]
            .into_iter()
            .flatten()
            .any(|value| value == 0)
            {
                return Err(SdkError::new(
                    SdkErrorCode::InvalidArgument,
                    format!("模型 '{model}' 的容量必须大于 0"),
                ));
            }
            if profile
                .context_window_tokens
                .zip(profile.max_output_tokens)
                .is_some_and(|(window, output)| output >= window)
            {
                return Err(SdkError::new(
                    SdkErrorCode::InvalidArgument,
                    format!("模型 '{model}' 的最大输出必须小于上下文窗口"),
                ));
            }
            if profile
                .max_input_attachment_bytes
                .zip(profile.max_input_attachment_total_bytes)
                .is_some_and(|(single, total)| single > total)
            {
                return Err(SdkError::new(
                    SdkErrorCode::InvalidArgument,
                    format!("模型 '{model}' 的单附件上限不能大于附件总量上限"),
                ));
            }
            if profile
                .context_window_tokens
                .zip(profile.max_input_tokens)
                .is_some_and(|(window, input)| input > window)
                || profile
                    .context_window_tokens
                    .zip(profile.max_input_tokens.zip(profile.max_output_tokens))
                    .is_some_and(|(window, (input, output))| input.saturating_add(output) > window)
            {
                return Err(SdkError::new(
                    SdkErrorCode::InvalidArgument,
                    format!("模型 '{model}' 的输入与输出容量超过上下文窗口"),
                ));
            }
            if let Some(alias) = display_aliases
                .get(model)
                .and_then(|alias| alias.as_deref())
            {
                if alias.trim().is_empty() || alias.trim() != alias {
                    return Err(SdkError::new(
                        SdkErrorCode::InvalidArgument,
                        format!("模型 '{model}' 的别名不能为空或包含首尾空白"),
                    ));
                }
            }
        }

        let mut snapshot = self.provider_control_snapshot().await?;
        merge_managed_provider_catalog(&mut snapshot, managed_config_path)?;
        let account = snapshot.auth_accounts.get(account_id).ok_or_else(|| {
            SdkError::new(
                SdkErrorCode::NotFound,
                format!("Auth Account '{account_id}' 不存在"),
            )
        })?;
        let provider_id = account
            .config
            .provider
            .clone()
            .or_else(|| {
                snapshot
                    .provider_instances
                    .iter()
                    .find(|(_, provider)| provider.accounts.iter().any(|id| id == account_id))
                    .map(|(provider_id, _)| provider_id.clone())
            })
            .ok_or_else(|| {
                SdkError::new(
                    SdkErrorCode::InvalidArgument,
                    format!("Auth Account '{account_id}' 尚未关联 Provider Instance"),
                )
            })?;
        let mut provider = snapshot
            .provider_instances
            .get(&provider_id)
            .cloned()
            .ok_or_else(|| {
                SdkError::new(
                    SdkErrorCode::NotFound,
                    format!("Provider Instance '{provider_id}' 不存在"),
                )
            })?;

        let mut selectable = snapshot
            .discovered_models
            .iter()
            .filter(|record| {
                record.provider_instance_id == provider_id && record.auth_account_id == account_id
            })
            .map(|record| record.physical_model.clone())
            .collect::<BTreeSet<_>>();
        let mut preferred_routes = BTreeMap::<String, String>::new();
        for (route_id, route) in &snapshot.model_routes {
            for candidate in &route.candidates {
                if candidate.provider == provider_id
                    && candidate.account.as_deref() == Some(account_id)
                {
                    selectable.insert(candidate.model.clone());
                    preferred_routes
                        .entry(candidate.model.clone())
                        .or_insert_with(|| route_id.clone());
                }
            }
        }
        if let Some(unknown) = models.keys().find(|model| !selectable.contains(*model)) {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                format!("模型 '{unknown}' 不在该账号最近发现的目录中"),
            ));
        }

        let original_routes = snapshot.model_routes.clone();
        for route in snapshot.model_routes.values_mut() {
            route.candidates.retain(|candidate| {
                candidate.provider != provider_id
                    || candidate.account.as_deref() != Some(account_id)
            });
        }
        snapshot
            .model_routes
            .retain(|_, route| !route.candidates.is_empty());

        for model in models.keys() {
            let existing_route = preferred_routes.get(model).cloned().or_else(|| {
                snapshot.model_routes.iter().find_map(|(route_id, route)| {
                    route
                        .candidates
                        .iter()
                        .any(|candidate| {
                            candidate.provider == provider_id && candidate.model == *model
                        })
                        .then(|| route_id.clone())
                })
            });
            let route_id = existing_route.unwrap_or_else(|| {
                let alias_in_use = |candidate: &str| {
                    snapshot.model_routes.iter().any(|(route_id, route)| {
                        route_id == candidate
                            || route.aliases.iter().any(|alias| alias == candidate)
                    })
                };
                if !alias_in_use(model) {
                    return model.clone();
                }
                let base = format!("{provider_id}:{model}");
                if !alias_in_use(&base) {
                    return base;
                }
                (2..)
                    .map(|index| format!("{base}:{index}"))
                    .find(|candidate| !alias_in_use(candidate))
                    .expect("an unbounded route suffix must eventually be unique")
            });
            let route = snapshot
                .model_routes
                .entry(route_id.clone())
                .or_insert_with(|| ModelRouteConfig {
                    display_alias: None,
                    aliases: Vec::new(),
                    candidates: Vec::new(),
                    affinity: ModelRouteAffinity::Context,
                    selection: ModelRouteSelection::AvailableLeastRecentlyUsed,
                    fallback: false,
                });
            let previous_display_alias = route
                .display_alias
                .clone()
                .or_else(|| route.aliases.first().cloned());
            if let Some(previous_display_alias) = previous_display_alias {
                if previous_display_alias != route_id {
                    route
                        .aliases
                        .retain(|alias| alias != &previous_display_alias);
                }
            }
            let display_alias = display_aliases
                .get(model)
                .and_then(|alias| alias.as_ref())
                .cloned();
            route.display_alias = display_alias.clone();
            if let Some(display_alias) = display_alias {
                if display_alias != route_id
                    && !route.aliases.iter().any(|alias| alias == &display_alias)
                {
                    route.aliases.insert(0, display_alias);
                }
            }
            let priority = route
                .candidates
                .iter()
                .map(|candidate| candidate.priority)
                .max()
                .map_or(0, |priority| priority.saturating_add(1));
            route.candidates.push(ModelRouteCandidateConfig {
                provider: provider_id.clone(),
                model: model.clone(),
                priority,
                account: Some(account_id.to_string()),
                capabilities: Vec::new(),
            });
        }

        let referenced_models = snapshot
            .model_routes
            .values()
            .flat_map(|route| route.candidates.iter())
            .filter(|candidate| candidate.provider == provider_id)
            .map(|candidate| candidate.model.clone())
            .collect::<BTreeSet<_>>();
        provider
            .models
            .retain(|model, _| referenced_models.contains(model));
        for (model, profile) in models {
            provider.models.insert(model, profile);
        }
        snapshot
            .provider_instances
            .insert(provider_id.clone(), provider.clone());
        validate_provider_catalog_snapshot(&snapshot)?;

        let changed_routes = snapshot
            .model_routes
            .iter()
            .filter(|(route_id, route)| original_routes.get(*route_id) != Some(*route))
            .map(|(route_id, route)| (route_id.clone(), route.clone()))
            .collect::<BTreeMap<_, _>>();
        let removed_route_ids = original_routes
            .keys()
            .filter(|route_id| !snapshot.model_routes.contains_key(*route_id))
            .cloned()
            .collect::<BTreeSet<_>>();
        let selected_still_exists = snapshot.model_routes.iter().any(|(route_id, route)| {
            route_id == &snapshot.selected_model_alias
                || route
                    .aliases
                    .iter()
                    .any(|alias| alias == &snapshot.selected_model_alias)
        });
        let fallback_model = (!selected_still_exists)
            .then(|| snapshot.model_routes.keys().next().cloned())
            .flatten();

        save_managed_provider_account_models_at(
            managed_config_path,
            &provider_id,
            &provider,
            &changed_routes,
            &removed_route_ids,
            fallback_model.as_deref(),
        )
        .map_err(SdkError::internal)?;
        let mut live = self
            .runtime
            .provider_catalog_config()
            .map_err(SdkError::internal)?;
        live.provider_instances.insert(provider_id, provider);
        for route_id in &removed_route_ids {
            live.model_routes.remove(route_id);
        }
        live.model_routes.extend(changed_routes);
        if let Some(model) = fallback_model {
            live.llm.model = model;
        }
        self.runtime
            .replace_provider_catalog(live)
            .await
            .map_err(SdkError::internal)?;
        Ok(ProviderCatalogMutationReceipt::new(
            ProviderCatalogObjectKind::ProviderCatalog,
            account_id,
            managed_config_path,
        ))
    }

    pub async fn control_provider_account(
        &self,
        account_id: &str,
        expected_revision: Option<u64>,
        action: ProviderAccountControlAction,
    ) -> SdkResult<crate::memory::ProviderAccountStateRecord> {
        self.runtime
            .control_provider_account(account_id, expected_revision, action)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn start_provider_oauth_login(
        &self,
        account_id: &str,
    ) -> SdkResult<OAuthLoginChallenge> {
        self.runtime
            .start_provider_oauth_login(account_id)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn start_provider_oauth_login_using(
        &self,
        account_id: &str,
        adapter_id: &str,
    ) -> SdkResult<OAuthLoginChallenge> {
        self.runtime
            .start_provider_oauth_login_using(account_id, adapter_id)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn continue_provider_oauth_login(
        &self,
        login_id: &str,
        completion: OAuthLoginCompletion,
    ) -> SdkResult<OAuthLoginProgress> {
        let progress = self
            .runtime
            .continue_provider_oauth_login(login_id, completion)
            .await
            .map_err(SdkError::internal);
        let progress = match progress {
            Ok(progress) => progress,
            Err(error) => {
                // Adapters may report a temporary transport failure while the
                // provider authorization is still valid. Keep the in-memory
                // setup whenever the Auth Manager still owns the login; only
                // expiry/terminal removal tears it down.
                if !self
                    .runtime
                    .provider_oauth_login_exists(login_id)
                    .unwrap_or(false)
                {
                    if let Ok(mut pending) = self.pending_oauth_setups.write() {
                        if let Some(pending) = pending.remove(login_id) {
                            let _ = self
                                .runtime
                                .discard_transient_provider_auth_account(&pending.setup.account_id);
                        }
                    }
                }
                return Err(error);
            }
        };
        if matches!(progress, OAuthLoginProgress::Complete { .. }) {
            let pending = self
                .pending_oauth_setups
                .read()
                .map_err(|_| SdkError::internal("OAuth setup registry lock poisoned"))?
                .get(login_id)
                .cloned();
            if let Some(pending) = pending {
                if let Err(error) = self.finalize_oauth_provider_account(&pending).await {
                    if let Ok(mut setups) = self.pending_oauth_setups.write() {
                        setups.remove(login_id);
                    }
                    let _ = self
                        .runtime
                        .discard_transient_provider_auth_account(&pending.setup.account_id);
                    return Err(error);
                }
                self.pending_oauth_setups
                    .write()
                    .map_err(|_| SdkError::internal("OAuth setup registry lock poisoned"))?
                    .remove(login_id);
            }
        }
        Ok(progress)
    }

    pub fn cancel_provider_oauth_login(&self, login_id: &str) -> SdkResult<bool> {
        let pending = self
            .pending_oauth_setups
            .write()
            .map_err(|_| SdkError::internal("OAuth setup registry lock poisoned"))?
            .remove(login_id);
        let cancelled = self
            .runtime
            .cancel_provider_oauth_login(login_id)
            .map_err(SdkError::internal)?;
        if let Some(pending) = pending {
            let _ = self
                .runtime
                .discard_transient_provider_auth_account(&pending.setup.account_id);
        }
        Ok(cancelled)
    }

    pub fn provider_oauth_account_metadata(
        &self,
        account_id: &str,
    ) -> SdkResult<OAuthAccountMetadata> {
        self.runtime
            .provider_oauth_account_metadata(account_id)
            .map_err(SdkError::internal)
    }

    pub async fn provider_subscription_usage(
        &self,
        account_id: &str,
    ) -> SdkResult<ProviderSubscriptionUsage> {
        self.runtime
            .provider_subscription_usage(account_id)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn logout_provider_oauth_account(&self, account_id: &str) -> SdkResult<bool> {
        self.runtime
            .logout_provider_oauth_account(account_id)
            .await
            .map_err(SdkError::internal)
    }

    /// Explicit integrity audit. This intentionally remains a command rather
    /// than a hot-path status query because it replays immutable Events.
    pub async fn audit_mind_projection(&self, context_id: &str) -> SdkResult<MindProjectionAudit> {
        self.runtime
            .audit_mind_projection(context_id)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn create_context(
        &self,
        context: NewCognitiveContext,
    ) -> SdkResult<CognitiveContextRecord> {
        self.runtime
            .create_context(context)
            .await
            .map_err(|error| SdkError::new(SdkErrorCode::Conflict, error.to_string()))
    }

    /// Installs one validated, versioned Harness package through the shared
    /// application boundary used by CLI and future HTTP/embedded adapters.
    pub async fn install_harness_package(
        &self,
        package: HarnessPackage,
    ) -> SdkResult<HarnessDescriptor> {
        let descriptor = package.descriptor();
        self.runtime
            .register_harness_package(package)
            .await
            .map_err(|error| SdkError::new(SdkErrorCode::Conflict, error.to_string()))?;
        Ok(descriptor)
    }

    pub fn list_harnesses(&self) -> Vec<HarnessDescriptor> {
        self.runtime.harnesses()
    }

    pub fn get_harness(&self, id: &str, version: &str) -> SdkResult<HarnessDescriptor> {
        self.runtime
            .harnesses()
            .into_iter()
            .find(|candidate| candidate.id == id && candidate.version == version)
            .ok_or_else(|| {
                SdkError::new(
                    SdkErrorCode::NotFound,
                    format!("Harness '{id}@{version}' 未安装"),
                )
            })
    }

    /// Reads the immutable exact Harness binding that was actually selected
    /// for one Evaluation. This does not substitute an Objective default.
    pub async fn evaluation_harness_binding(
        &self,
        evaluation_id: &str,
    ) -> SdkResult<Option<HarnessBinding>> {
        self.runtime
            .evaluation_harness_binding(evaluation_id)
            .await
            .map_err(SdkError::internal)
    }

    /// Creates one Objective through the same principal-aware application
    /// boundary used by CLI and HTTP. When a Harness is requested, the
    /// Objective row and immutable exact-version binding commit atomically.
    pub async fn create_objective(
        &self,
        principal: &PrincipalAssertion,
        command: CreateObjectiveCommand,
    ) -> SdkResult<CreateObjectiveResult> {
        let coordinator = self
            .authorize_session(&principal.principal_id, &command.coordinator_session_id)
            .await?;
        let delivery_session_id = command
            .delivery_session_id
            .as_deref()
            .unwrap_or(&command.coordinator_session_id);
        let delivery = self
            .authorize_session(&principal.principal_id, delivery_session_id)
            .await?;
        if coordinator.context_id != delivery.context_id {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Objective 的 coordinator/delivery Session 必须属于同一 Context",
            ));
        }
        if coordinator.agent_id != delivery.agent_id {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Objective 的 coordinator/delivery Session 必须属于同一 Agent",
            ));
        }
        let objective = NewObjective {
            id: command.id.clone(),
            agent_id: coordinator.agent_id.clone(),
            context_id: coordinator.context_id.clone(),
            coordinator_session_id: coordinator.id.clone(),
            delivery_session_id: delivery.id,
            parent_objective_id: command.parent_objective_id,
            source_event_id: command.source_event_id.clone(),
            initiating_principal_id: Some(principal.principal_id.clone()),
            stated_objective: command.stated_objective.clone(),
            token_budget: command.token_budget,
        };
        let source_event = Event::new(
            command.source_event_id,
            principal.principal_id.clone(),
            "objective_request".to_string(),
            "objective/requested".to_string(),
            [
                (
                    "context_id".to_string(),
                    serde_json::json!(coordinator.context_id),
                ),
                ("session_id".to_string(), serde_json::json!(coordinator.id)),
                (
                    "principal_id".to_string(),
                    serde_json::json!(principal.principal_id),
                ),
                (
                    "requested_objective_id".to_string(),
                    serde_json::json!(command.id),
                ),
                (
                    "source_origin".to_string(),
                    serde_json::json!(command.source_origin.as_str()),
                ),
                (
                    "text".to_string(),
                    serde_json::json!(command.stated_objective),
                ),
            ]
            .into_iter()
            .collect(),
        );
        match command.harness {
            Some(harness) => {
                let (objective, harness_binding) = self
                    .runtime
                    .create_objective_with_harness_and_initial_events(
                        objective,
                        &harness.id,
                        &harness.version,
                        vec![source_event],
                    )
                    .await
                    .map_err(|error| {
                        SdkError::new(SdkErrorCode::InvalidArgument, error.to_string())
                    })?;
                Ok(CreateObjectiveResult {
                    objective,
                    harness_binding: Some(harness_binding),
                })
            }
            None => self
                .runtime
                .create_objective_with_initial_events(objective, vec![source_event])
                .await
                .map(|objective| CreateObjectiveResult {
                    objective,
                    harness_binding: None,
                })
                .map_err(|error| SdkError::new(SdkErrorCode::Conflict, error.to_string())),
        }
    }

    pub async fn update_context(
        &self,
        context_id: &str,
        update: ContextUpdate,
    ) -> SdkResult<CognitiveContextRecord> {
        self.runtime
            .update_context(context_id, update)
            .await
            .map_err(|error| SdkError::new(SdkErrorCode::Conflict, error.to_string()))?
            .ok_or_else(|| {
                SdkError::new(
                    SdkErrorCode::NotFound,
                    format!("Context '{context_id}' 不存在"),
                )
            })
    }

    pub async fn context_token_budget(&self, context_id: &str) -> SdkResult<ContextTokenBudget> {
        if self
            .runtime
            .get_context(context_id)
            .await
            .map_err(SdkError::internal)?
            .is_none()
        {
            return Err(SdkError::new(
                SdkErrorCode::NotFound,
                format!("Context '{context_id}' 不存在"),
            ));
        }
        self.runtime
            .context_token_budget(context_id)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn update_context_token_budget(
        &self,
        context_id: &str,
        requested_hard_token_limit: Option<u64>,
        expected_revision: u64,
    ) -> SdkResult<ContextTokenBudgetUpdate> {
        self.runtime
            .update_context_token_budget(context_id, requested_hard_token_limit, expected_revision)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn list_execution_targets(
        &self,
        principal_id: &str,
    ) -> SdkResult<Vec<ExecutionTargetRecord>> {
        self.runtime
            .list_execution_targets(ExecutionTargetFilter {
                limit: Some(1_000),
                ..Default::default()
            })
            .await
            .map_err(SdkError::internal)
            .map(|targets| {
                targets
                    .into_iter()
                    .filter(|target| {
                        target.owner_principal_id.is_none()
                            || target.owner_principal_id.as_deref() == Some(principal_id)
                    })
                    .collect()
            })
    }

    pub async fn inspect_execution_target(
        &self,
        principal_id: &str,
        target_id: &str,
    ) -> SdkResult<ExecutionTargetRecord> {
        let target = self
            .runtime
            .get_execution_target(target_id)
            .await
            .map_err(SdkError::internal)?
            .ok_or_else(|| {
                SdkError::new(
                    SdkErrorCode::NotFound,
                    format!("Execution Target '{target_id}' 不存在"),
                )
            })?;
        if target.owner_principal_id.is_some()
            && target.owner_principal_id.as_deref() != Some(principal_id)
        {
            return Err(SdkError::new(
                SdkErrorCode::Forbidden,
                format!("当前 Principal 不能访问 Execution Target '{target_id}'"),
            ));
        }
        Ok(target)
    }

    /// Registers a Target in the caller's authority domain. Public ingress
    /// adapters cannot create global Targets by omitting the owner.
    pub async fn register_execution_target(
        &self,
        principal_id: &str,
        mut registration: ExecutionTargetRegistration,
    ) -> SdkResult<ExecutionTargetRecord> {
        registration.owner_principal_id = Some(principal_id.to_string());
        self.runtime
            .register_execution_target(registration)
            .await
            .map_err(|error| SdkError::new(SdkErrorCode::Conflict, error.to_string()))
    }

    pub async fn set_execution_target_status(
        &self,
        principal_id: &str,
        target_id: &str,
        expected_revision: u64,
        status: ExecutionTargetStatus,
    ) -> SdkResult<ExecutionTargetRecord> {
        let current = self
            .inspect_execution_target(principal_id, target_id)
            .await?;
        if current.owner_principal_id.is_none() {
            return Err(SdkError::new(
                SdkErrorCode::Forbidden,
                "Runtime 全局 Target 不能通过 Principal-scoped SDK 修改",
            ));
        }
        match self
            .runtime
            .set_execution_target_status(target_id, expected_revision, status)
            .await
            .map_err(SdkError::internal)?
        {
            ExecutionTargetMutation::Updated(target) => Ok(target),
            ExecutionTargetMutation::Conflict { current } => Err(SdkError::new(
                SdkErrorCode::Conflict,
                format!(
                    "Execution Target '{}' revision 冲突：当前为 {}",
                    current.id, current.revision
                ),
            )),
            ExecutionTargetMutation::NotFound => Err(SdkError::new(
                SdkErrorCode::NotFound,
                format!("Execution Target '{target_id}' 不存在"),
            )),
        }
    }

    pub async fn authorize_execution_target(
        &self,
        principal_id: &str,
        command: AuthorizeExecutionTargetCommand,
    ) -> SdkResult<ExecutionTargetAuthorizationRecord> {
        let target = self
            .inspect_execution_target(principal_id, &command.target_id)
            .await?;
        if target.owner_principal_id.as_deref() != Some(principal_id) {
            return Err(SdkError::new(
                SdkErrorCode::Forbidden,
                "Runtime 全局 Target 不能进入 Principal scoped authorization 模式",
            ));
        }
        if command.scope_id.trim().is_empty() {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Execution Target authorization scope_id 不能为空",
            ));
        }
        let identity = format!(
            "{}\u{0}{}\u{0}{}\u{0}{}",
            principal_id,
            command.target_id,
            command.scope.as_str(),
            command.scope_id
        );
        let digest = format!("{:x}", Sha256::digest(identity.as_bytes()));
        let authorization = NewExecutionTargetAuthorization {
            id: format!("target_auth_{}", &digest[..24]),
            target_id: command.target_id,
            owner_principal_id: principal_id.to_string(),
            scope: command.scope,
            scope_id: command.scope_id,
        };
        match self
            .runtime
            .authorize_execution_target(authorization)
            .await
            .map_err(SdkError::internal)?
        {
            ExecutionTargetAuthorizationMutation::Created(record)
            | ExecutionTargetAuthorizationMutation::Existing(record)
            | ExecutionTargetAuthorizationMutation::Updated(record) => Ok(record),
            ExecutionTargetAuthorizationMutation::Conflict { current } => Err(SdkError::new(
                SdkErrorCode::Conflict,
                format!(
                    "Execution Target authorization '{}' revision 冲突：当前为 {}",
                    current.id, current.revision
                ),
            )),
            ExecutionTargetAuthorizationMutation::NotFound => Err(SdkError::new(
                SdkErrorCode::NotFound,
                "Execution Target authorization 不存在",
            )),
        }
    }

    pub async fn list_execution_target_authorizations(
        &self,
        principal_id: &str,
        target_id: Option<String>,
        active_only: bool,
    ) -> SdkResult<Vec<ExecutionTargetAuthorizationRecord>> {
        self.runtime
            .list_execution_target_authorizations(ExecutionTargetAuthorizationFilter {
                target_id,
                owner_principal_id: Some(principal_id.to_string()),
                active_only,
                limit: Some(1_000),
                ..Default::default()
            })
            .await
            .map_err(SdkError::internal)
    }

    pub async fn revoke_execution_target_authorization(
        &self,
        principal_id: &str,
        authorization_id: &str,
        expected_revision: u64,
        reason: &str,
    ) -> SdkResult<ExecutionTargetAuthorizationRecord> {
        let current = self
            .runtime
            .get_execution_target_authorization(authorization_id)
            .await
            .map_err(SdkError::internal)?
            .ok_or_else(|| {
                SdkError::new(
                    SdkErrorCode::NotFound,
                    format!("Execution Target authorization '{authorization_id}' 不存在"),
                )
            })?;
        if current.owner_principal_id != principal_id {
            return Err(SdkError::new(
                SdkErrorCode::Forbidden,
                "当前 Principal 不能撤销这个 Execution Target authorization",
            ));
        }
        match self
            .runtime
            .revoke_execution_target_authorization(authorization_id, expected_revision, reason)
            .await
            .map_err(SdkError::internal)?
        {
            ExecutionTargetAuthorizationMutation::Updated(record)
            | ExecutionTargetAuthorizationMutation::Existing(record) => Ok(record),
            ExecutionTargetAuthorizationMutation::Conflict { current } => Err(SdkError::new(
                SdkErrorCode::Conflict,
                format!(
                    "Execution Target authorization '{}' revision 冲突：当前为 {}",
                    current.id, current.revision
                ),
            )),
            ExecutionTargetAuthorizationMutation::NotFound => Err(SdkError::new(
                SdkErrorCode::NotFound,
                format!("Execution Target authorization '{authorization_id}' 不存在"),
            )),
            ExecutionTargetAuthorizationMutation::Created(_) => Err(SdkError::new(
                SdkErrorCode::Internal,
                "撤销 Execution Target authorization 时返回了无效的 created 状态",
            )),
        }
    }

    pub async fn list_capability_leases(
        &self,
        principal_id: &str,
        thread_id: Option<String>,
        target_id: Option<String>,
        active_only: bool,
    ) -> SdkResult<Vec<CapabilityLeaseRecord>> {
        if principal_id.trim().is_empty() {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Principal ID 不能为空",
            ));
        }
        self.runtime
            .list_capability_leases(CapabilityLeaseFilter {
                principal_id: Some(principal_id.to_string()),
                thread_id,
                target_id,
                active_at: active_only.then(chrono::Utc::now),
                limit: Some(1_000),
                ..Default::default()
            })
            .await
            .map_err(SdkError::internal)
    }

    pub async fn revoke_capability_lease(
        &self,
        principal_id: &str,
        lease_id: &str,
        expected_revision: u64,
        reason: &str,
    ) -> SdkResult<CapabilityLeaseRecord> {
        let current = self
            .runtime
            .list_capability_leases(CapabilityLeaseFilter {
                principal_id: Some(principal_id.to_string()),
                limit: Some(1_000),
                ..Default::default()
            })
            .await
            .map_err(SdkError::internal)?
            .into_iter()
            .find(|lease| lease.id == lease_id)
            .ok_or_else(|| {
                SdkError::new(
                    SdkErrorCode::NotFound,
                    format!("Capability Lease '{lease_id}' 不存在"),
                )
            })?;
        if current.revision != expected_revision {
            return Err(SdkError::new(
                SdkErrorCode::Conflict,
                format!(
                    "Capability Lease '{lease_id}' revision 冲突：当前为 {}",
                    current.revision
                ),
            ));
        }
        match self
            .runtime
            .revoke_capability_lease(lease_id, expected_revision, reason)
            .await
            .map_err(SdkError::internal)?
        {
            CapabilityLeaseMutation::Updated(lease) | CapabilityLeaseMutation::Existing(lease) => {
                Ok(lease)
            }
            CapabilityLeaseMutation::Conflict { current } => Err(SdkError::new(
                SdkErrorCode::Conflict,
                format!(
                    "Capability Lease '{}' revision 冲突：当前为 {}",
                    current.id, current.revision
                ),
            )),
            CapabilityLeaseMutation::NotFound => Err(SdkError::new(
                SdkErrorCode::NotFound,
                format!("Capability Lease '{lease_id}' 不存在"),
            )),
            CapabilityLeaseMutation::Created(_) => Err(SdkError::new(
                SdkErrorCode::Internal,
                "撤销 Capability Lease 时返回了无效的 created 状态",
            )),
        }
    }

    pub async fn create_node_pairing_code(
        &self,
        principal_id: &str,
        command: CreateNodePairingCodeCommand,
    ) -> SdkResult<NodePairingCode> {
        if principal_id.trim().is_empty() {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Principal ID 不能为空",
            ));
        }
        let ttl = command.expires_in_seconds.clamp(1, 900);
        let code = random_secret("pair", 20)?;
        let expires_at =
            chrono::Utc::now() + chrono::Duration::seconds(i64::try_from(ttl).unwrap_or(900));
        self.runtime
            .create_node_pairing_code(NewNodePairingCode {
                code_hash: hash_secret(&code),
                owner_principal_id: principal_id.to_string(),
                expires_at,
            })
            .await
            .map_err(SdkError::internal)?;
        Ok(NodePairingCode { code, expires_at })
    }

    pub async fn pair_execution_node(
        &self,
        command: PairExecutionNodeCommand,
    ) -> SdkResult<PairedExecutionNode> {
        if command.code.trim().is_empty()
            || command.name.trim().is_empty()
            || command.device_key_fingerprint.trim().is_empty()
            || command.device_public_key.trim().is_empty()
        {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "配对码、Node 名称、设备密钥指纹和公钥不能为空",
            ));
        }
        if command.protocol_version == 0 {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Edge protocol_version 必须大于 0",
            ));
        }
        let node_id = match command.node_id {
            Some(node_id) if !node_id.trim().is_empty() => node_id,
            _ => random_secret("node", 12)?,
        };
        let public_key = decode_hex(&command.device_public_key).map_err(|error| {
            SdkError::new(
                SdkErrorCode::InvalidArgument,
                format!("Edge device_public_key 无效: {error}"),
            )
        })?;
        let expected_fingerprint = format!("sha256:{:x}", Sha256::digest(&public_key));
        if command.device_key_fingerprint != expected_fingerprint {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Edge 设备公钥与指纹不一致",
            ));
        }
        let node = self
            .runtime
            .pair_execution_node(PairExecutionNode {
                code_hash: hash_secret(&command.code),
                node_id,
                name: command.name,
                device_key_fingerprint: command.device_key_fingerprint,
                device_public_key: command.device_public_key,
                protocol_version: command.protocol_version,
                platform: command.platform,
                capabilities: command.capabilities,
                metadata: command.metadata,
            })
            .await
            .map_err(|error| SdkError::new(SdkErrorCode::Unauthorized, error.to_string()))?;
        Ok(PairedExecutionNode { node })
    }

    pub async fn create_execution_node_identity_challenge(
        &self,
        node_id: &str,
    ) -> SdkResult<ExecutionNodeIdentityChallenge> {
        if node_id.trim().is_empty() {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Execution Node ID 不能为空",
            ));
        }
        let challenge_id = random_secret("challenge", 16)?;
        let nonce = random_secret("nonce", 32)?;
        let expires_at = chrono::Utc::now() + chrono::Duration::seconds(60);
        self.runtime
            .create_execution_node_challenge(NewExecutionNodeChallenge {
                id: challenge_id.clone(),
                node_id: node_id.to_string(),
                nonce_hash: hash_secret(&nonce),
                expires_at,
            })
            .await
            .map_err(|error| SdkError::new(SdkErrorCode::NotFound, error.to_string()))?;
        Ok(ExecutionNodeIdentityChallenge {
            challenge_id,
            nonce,
            expires_at,
        })
    }

    pub async fn connect_execution_node(
        &self,
        node_id: &str,
        command: ConnectExecutionNodeCommand,
    ) -> SdkResult<ExecutionNodeConnection> {
        if node_id.trim().is_empty()
            || command.challenge_id.trim().is_empty()
            || command.nonce.trim().is_empty()
            || command.signature.trim().is_empty()
        {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Execution Node connection proof 不完整",
            ));
        }
        let node = self
            .runtime
            .consume_execution_node_challenge(
                node_id,
                &command.challenge_id,
                &hash_secret(&command.nonce),
            )
            .await
            .map_err(SdkError::internal)?
            .ok_or_else(|| {
                SdkError::new(
                    SdkErrorCode::Unauthorized,
                    "Execution Node challenge 无效、过期或已使用",
                )
            })?;
        let public_key = decode_hex(&node.device_public_key).map_err(|error| {
            SdkError::new(
                SdkErrorCode::Internal,
                format!("Execution Node 公钥存储损坏: {error}"),
            )
        })?;
        let signature = decode_hex(&command.signature).map_err(|error| {
            SdkError::new(
                SdkErrorCode::Unauthorized,
                format!("Execution Node signature 无效: {error}"),
            )
        })?;
        ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, public_key)
            .verify(
                &execution_node_connection_proof_message(
                    node_id,
                    &command.challenge_id,
                    &command.nonce,
                ),
                &signature,
            )
            .map_err(|_| {
                SdkError::new(
                    SdkErrorCode::Unauthorized,
                    "Execution Node 设备签名验证失败",
                )
            })?;
        let token = random_secret("edge_connection", 32)?;
        let expires_at = chrono::Utc::now() + chrono::Duration::minutes(15);
        self.runtime
            .issue_execution_node_connection_token(node_id, &hash_secret(&token), expires_at)
            .await
            .map_err(SdkError::internal)?
            .ok_or_else(|| {
                SdkError::new(SdkErrorCode::Unauthorized, "Execution Node 已撤销或不存在")
            })?;
        Ok(ExecutionNodeConnection { token, expires_at })
    }

    pub async fn heartbeat_execution_node(
        &self,
        node_id: &str,
        device_token: &str,
        command: ExecutionNodeHeartbeatCommand,
    ) -> SdkResult<ExecutionNodeRecord> {
        let node = self.authenticate_node(node_id, device_token).await?;
        if command.targets.len() > self.runtime.config().edge_execution.max_targets_per_node {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                format!(
                    "单个 Node 一次最多发布 {} 个 Target",
                    self.runtime.config().edge_execution.max_targets_per_node
                ),
            ));
        }
        let updated = self
            .runtime
            .heartbeat_execution_node(
                node_id,
                command.platform,
                command.capabilities,
                command.metadata,
            )
            .await
            .map_err(SdkError::internal)?
            .ok_or_else(|| SdkError::new(SdkErrorCode::NotFound, "Execution Node 不存在"))?;
        for mut target in command.targets {
            if !matches!(
                target.kind,
                ExecutionTargetKind::EdgeNode | ExecutionTargetKind::ManagedSsh
            ) {
                return Err(SdkError::new(
                    SdkErrorCode::InvalidArgument,
                    "Edge Node 只能发布 edge_node 或 managed_ssh Target",
                ));
            }
            target.owner_principal_id = Some(node.owner_principal_id.clone());
            target.provider_node_id = Some(node.id.clone());
            target.last_seen_at = Some(chrono::Utc::now());
            self.runtime
                .register_execution_target(target)
                .await
                .map_err(|error| SdkError::new(SdkErrorCode::Conflict, error.to_string()))?;
        }
        Ok(updated)
    }

    pub async fn list_execution_nodes(
        &self,
        principal_id: &str,
    ) -> SdkResult<Vec<ExecutionNodeRecord>> {
        self.runtime
            .list_execution_nodes(principal_id)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn revoke_execution_node(
        &self,
        principal_id: &str,
        node_id: &str,
        expected_revision: u64,
    ) -> SdkResult<ExecutionNodeRecord> {
        let current = self
            .runtime
            .list_execution_nodes(principal_id)
            .await
            .map_err(SdkError::internal)?
            .into_iter()
            .find(|node| node.id == node_id)
            .ok_or_else(|| SdkError::new(SdkErrorCode::NotFound, "Execution Node 不存在"))?;
        if current.revision != expected_revision {
            return Err(SdkError::new(
                SdkErrorCode::Conflict,
                format!("Execution Node revision 冲突：当前为 {}", current.revision),
            ));
        }
        let updated = self
            .runtime
            .revoke_execution_node(node_id, principal_id, expected_revision)
            .await
            .map_err(SdkError::internal)?
            .ok_or_else(|| SdkError::new(SdkErrorCode::NotFound, "Execution Node 不存在"))?;
        if updated.status != ExecutionNodeStatus::Revoked {
            return Err(SdkError::new(
                SdkErrorCode::Conflict,
                format!(
                    "Execution Node revoke 未提交；当前 revision {}",
                    updated.revision
                ),
            ));
        }
        Ok(updated)
    }

    pub async fn rotate_execution_node_key(
        &self,
        node_id: &str,
        device_token: &str,
        command: RotateExecutionNodeKeyCommand,
    ) -> SdkResult<ExecutionNodeRecord> {
        let current = self.authenticate_node(node_id, device_token).await?;
        if current.revision != command.expected_revision {
            return Err(SdkError::new(
                SdkErrorCode::Conflict,
                format!("Execution Node revision 冲突：当前为 {}", current.revision),
            ));
        }
        let public_key = decode_hex(&command.device_public_key).map_err(|error| {
            SdkError::new(
                SdkErrorCode::InvalidArgument,
                format!("Edge device_public_key 无效: {error}"),
            )
        })?;
        let expected_fingerprint = format!("sha256:{:x}", Sha256::digest(&public_key));
        if command.device_key_fingerprint != expected_fingerprint {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Edge 新设备公钥与指纹不一致",
            ));
        }
        match self
            .runtime
            .rotate_execution_node_key(
                node_id,
                command.expected_revision,
                &command.device_key_fingerprint,
                &command.device_public_key,
            )
            .await
            .map_err(SdkError::internal)?
        {
            ExecutionNodeMutation::Updated(node) => Ok(node),
            ExecutionNodeMutation::Conflict { current } => Err(SdkError::new(
                SdkErrorCode::Conflict,
                format!("Execution Node revision 冲突：当前为 {}", current.revision),
            )),
            ExecutionNodeMutation::NotFound => Err(SdkError::new(
                SdkErrorCode::NotFound,
                "Execution Node 不存在",
            )),
        }
    }

    pub async fn claim_edge_command(
        &self,
        node_id: &str,
        device_token: &str,
        command: ClaimEdgeCommand,
    ) -> SdkResult<Option<EdgeCommandRecord>> {
        self.authenticate_node(node_id, device_token).await?;
        if command.worker_id.trim().is_empty() {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "worker_id 不能为空",
            ));
        }
        let lease_seconds = command.lease_seconds.clamp(5, 300);
        let claim_token = random_secret("claim", 24)?;
        self.runtime
            .claim_edge_command(
                node_id,
                &command.worker_id,
                &claim_token,
                chrono::Utc::now()
                    + chrono::Duration::seconds(i64::try_from(lease_seconds).unwrap_or(30)),
                self.runtime.config().edge_execution.max_in_flight_per_node,
            )
            .await
            .map_err(SdkError::internal)
    }

    pub async fn heartbeat_edge_command(
        &self,
        node_id: &str,
        device_token: &str,
        job_id: &str,
        command: HeartbeatEdgeCommand,
    ) -> SdkResult<EdgeCommandRecord> {
        self.authorize_node_command(node_id, device_token, job_id)
            .await?;
        let lease_seconds = command.lease_seconds.clamp(5, 300);
        match self
            .runtime
            .heartbeat_edge_command(
                job_id,
                command.expected_revision,
                &command.claim_token,
                chrono::Utc::now()
                    + chrono::Duration::seconds(i64::try_from(lease_seconds).unwrap_or(30)),
                command.side_effect_started,
                command.progress,
            )
            .await
            .map_err(SdkError::internal)?
        {
            EdgeCommandMutation::Updated(command) => Ok(command),
            EdgeCommandMutation::Conflict { current } => Err(SdkError::new(
                SdkErrorCode::Conflict,
                format!(
                    "Edge Command revision/claim 冲突；当前为 {}",
                    current.revision
                ),
            )),
            EdgeCommandMutation::NotFound => {
                Err(SdkError::new(SdkErrorCode::NotFound, "Edge Command 不存在"))
            }
        }
    }

    pub async fn append_edge_command_output(
        &self,
        node_id: &str,
        device_token: &str,
        job_id: &str,
        command: AppendEdgeOutputCommand,
    ) -> SdkResult<EdgeCommandOutputChunk> {
        self.authorize_node_command(node_id, device_token, job_id)
            .await?;
        if command.text.is_empty() {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Edge output chunk 不能为空",
            ));
        }
        if command.text.len() > 64 * 1024 {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Edge output chunk 不能超过 64 KiB",
            ));
        }
        self.runtime
            .append_edge_command_output(job_id, &command.claim_token, command.stream, &command.text)
            .await
            .map_err(|error| SdkError::new(SdkErrorCode::Conflict, error.to_string()))
    }

    pub async fn list_edge_command_output(
        &self,
        job_id: &str,
        after_sequence: u64,
        limit: usize,
    ) -> SdkResult<Vec<EdgeCommandOutputChunk>> {
        self.runtime
            .list_edge_command_output(job_id, after_sequence, limit)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn finish_edge_command(
        &self,
        node_id: &str,
        device_token: &str,
        job_id: &str,
        command: FinishEdgeCommand,
    ) -> SdkResult<EdgeCommandRecord> {
        self.authorize_node_command(node_id, device_token, job_id)
            .await?;
        if !matches!(
            command.status,
            EdgeCommandStatus::Succeeded | EdgeCommandStatus::Failed | EdgeCommandStatus::Cancelled
        ) {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Edge Node 只能提交 succeeded、failed 或 cancelled 终态",
            ));
        }
        match self
            .runtime
            .finish_edge_command(
                job_id,
                command.expected_revision,
                &command.claim_token,
                command.status,
                command.output,
                command.error,
            )
            .await
            .map_err(SdkError::internal)?
        {
            EdgeCommandMutation::Updated(command) => Ok(command),
            EdgeCommandMutation::Conflict { current } => Err(SdkError::new(
                SdkErrorCode::Conflict,
                format!(
                    "Edge Command revision/claim 冲突；当前为 {}",
                    current.revision
                ),
            )),
            EdgeCommandMutation::NotFound => {
                Err(SdkError::new(SdkErrorCode::NotFound, "Edge Command 不存在"))
            }
        }
    }

    pub async fn list_execution_jobs(
        &self,
        principal_id: &str,
        query: ExecutionJobQuery,
    ) -> SdkResult<Vec<ExecutionJobRecord>> {
        let limit = query.limit.unwrap_or(200).clamp(1, 1_000);
        let mut jobs = self
            .runtime
            .list_execution_jobs(ExecutionJobFilter {
                context_id: query.context_id,
                thread_id: query.thread_id,
                target_id: query.target_id,
                status: query.status,
                include_terminal: query.include_terminal,
                newest_first: query.newest_first,
                // Principal is not a storage filter yet. Apply the limit only
                // after the authority filter so another Principal's rows can
                // never hide or expose the caller's Jobs.
                limit: None,
                ..Default::default()
            })
            .await
            .map_err(SdkError::internal)?;
        jobs.retain(|job| self.execution_job_visible_to_principal(job, principal_id));
        jobs.truncate(limit);
        Ok(jobs)
    }

    pub async fn submit_artifact_transfer(
        &self,
        principal_id: &str,
        command: SubmitArtifactTransferCommand,
    ) -> SdkResult<ArtifactTransferExecutionRecord> {
        self.authorize_session(principal_id, &command.session_id)
            .await?;
        self.runtime
            .submit_artifact_transfer(principal_id, &command.session_id, command.transfer)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn artifact_transfer_output(
        &self,
        principal_id: &str,
        job_id: &str,
    ) -> SdkResult<ArtifactTransferOutput> {
        let job = self.inspect_execution_job(principal_id, job_id).await?;
        if job.tool_name != crate::artifact::ARTIFACT_TRANSFER_TOOL_NAME {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Execution Job 不是 Artifact Transfer",
            ));
        }
        let event = match job.result_event_id.as_deref() {
            Some(event_id) => self
                .runtime
                .query_events(QueryFilter {
                    event_id: Some(event_id.to_string()),
                    top_k: Some(1),
                    ..Default::default()
                })
                .await
                .map_err(SdkError::internal)?
                .into_iter()
                .next(),
            None => None,
        };
        Ok(ArtifactTransferOutput { job, event })
    }

    pub async fn inspect_execution_job(
        &self,
        principal_id: &str,
        job_id: &str,
    ) -> SdkResult<ExecutionJobRecord> {
        let job = self
            .runtime
            .get_execution_job(job_id)
            .await
            .map_err(SdkError::internal)?
            .ok_or_else(|| SdkError::new(SdkErrorCode::NotFound, "Execution Job 不存在"))?;
        if !self.execution_job_visible_to_principal(&job, principal_id) {
            return Err(SdkError::new(
                SdkErrorCode::Forbidden,
                "当前 Principal 不能访问这个 Execution Job",
            ));
        }
        Ok(job)
    }

    pub async fn cancel_execution_job(
        &self,
        principal_id: &str,
        job_id: &str,
        expected_revision: u64,
        reason: Option<&str>,
    ) -> SdkResult<ExecutionJobRecord> {
        self.inspect_execution_job(principal_id, job_id).await?;
        match self
            .runtime
            .request_execution_job_cancel(job_id, expected_revision, reason)
            .await
            .map_err(SdkError::internal)?
        {
            JobReceipt::Applied { job, .. } | JobReceipt::Existing { job, .. } => Ok(job),
            JobReceipt::Conflict { current, .. } => Err(SdkError::new(
                SdkErrorCode::Conflict,
                format!("Execution Job revision 冲突：当前为 {}", current.revision),
            )),
            JobReceipt::Rejected {
                current, reason, ..
            } => Err(SdkError::new(
                SdkErrorCode::Conflict,
                format!(
                    "Execution Job 当前为 {}，不能取消：{reason}",
                    current.status.as_str()
                ),
            )),
            JobReceipt::NotFound { .. } => Err(SdkError::new(
                SdkErrorCode::NotFound,
                "Execution Job 不存在",
            )),
        }
    }

    fn execution_job_visible_to_principal(
        &self,
        job: &ExecutionJobRecord,
        principal_id: &str,
    ) -> bool {
        job.initiating_principal_id.as_deref() == Some(principal_id)
            || (job.initiating_principal_id.is_none()
                && self.runtime.identity().principal_id == principal_id)
    }

    async fn authenticate_node(
        &self,
        node_id: &str,
        device_token: &str,
    ) -> SdkResult<ExecutionNodeRecord> {
        if node_id.trim().is_empty() || device_token.trim().is_empty() {
            return Err(SdkError::new(
                SdkErrorCode::Unauthorized,
                "Execution Node 凭证缺失",
            ));
        }
        let node = self
            .runtime
            .authenticate_execution_node(node_id, &hash_secret(device_token))
            .await
            .map_err(SdkError::internal)?
            .ok_or_else(|| SdkError::new(SdkErrorCode::Unauthorized, "Execution Node 凭证无效"))?;
        if node.status == ExecutionNodeStatus::Revoked {
            return Err(SdkError::new(
                SdkErrorCode::Forbidden,
                "Execution Node 已被撤销",
            ));
        }
        Ok(node)
    }

    async fn authorize_node_command(
        &self,
        node_id: &str,
        device_token: &str,
        job_id: &str,
    ) -> SdkResult<EdgeCommandRecord> {
        self.authenticate_node(node_id, device_token).await?;
        let command = self
            .runtime
            .get_edge_command(job_id)
            .await
            .map_err(SdkError::internal)?
            .ok_or_else(|| SdkError::new(SdkErrorCode::NotFound, "Edge Command 不存在"))?;
        if command.provider_node_id != node_id {
            return Err(SdkError::new(
                SdkErrorCode::Forbidden,
                "Execution Node 不能访问其他 Node 的命令",
            ));
        }
        Ok(command)
    }

    /// Authorizes the private Artifact byte channel. The existing device
    /// connection proves Node identity; the per-command claim token fences the
    /// current Worker lease. Neither credential is encoded into a Route or an
    /// Artifact descriptor.
    pub async fn authorize_edge_artifact_channel(
        &self,
        node_id: &str,
        device_token: &str,
        job_id: &str,
        claim_token: &str,
        expected_direction: EdgeArtifactDataDirection,
    ) -> SdkResult<(EdgeCommandRecord, EdgeArtifactDataChannel)> {
        if claim_token.trim().is_empty() {
            return Err(SdkError::new(
                SdkErrorCode::Unauthorized,
                "Edge Artifact channel 缺少 claim token",
            ));
        }
        let command = self
            .authorize_node_command(node_id, device_token, job_id)
            .await?;
        if command.tool_name != ARTIFACT_TRANSFER_TOOL_NAME {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Edge Command 不是 Artifact Transfer",
            ));
        }
        if command.status != EdgeCommandStatus::Claimed
            || command.claim_token.as_deref() != Some(claim_token)
            || command
                .lease_expires_at
                .is_none_or(|expires_at| expires_at <= chrono::Utc::now())
        {
            return Err(SdkError::new(
                SdkErrorCode::Conflict,
                "Edge Artifact channel 的 Command claim 已失效",
            ));
        }
        let channel = edge_artifact_data_channel_from_route(&command.route)
            .map_err(SdkError::internal)?
            .ok_or_else(|| {
                SdkError::new(
                    SdkErrorCode::InvalidArgument,
                    "Edge Artifact Command 缺少私有数据通道",
                )
            })?;
        if channel.direction != expected_direction {
            return Err(SdkError::new(
                SdkErrorCode::Forbidden,
                "Edge Artifact channel 方向与冻结 Route 不一致",
            ));
        }
        Ok((command, channel))
    }

    pub async fn create_session(
        &self,
        principal: PrincipalAssertion,
        session: NewSession,
    ) -> SdkResult<SessionRecord> {
        if let Some(parent_session_id) = session.parent_session_id.as_deref() {
            self.authorize_session(&principal.principal_id, parent_session_id)
                .await?;
        }
        self.runtime
            .create_session_for_principal(session, principal)
            .await
            .map_err(|error| SdkError::new(SdkErrorCode::Conflict, error.to_string()))
    }

    /// Explicitly binds a legacy Session after a trusted ingress has looked up
    /// its pre-existing ownership mapping. The SDK never guesses this mapping.
    pub async fn bind_existing_session(
        &self,
        principal: PrincipalAssertion,
        session_id: &str,
    ) -> SdkResult<SessionRecord> {
        let session = self
            .runtime
            .get_session(session_id)
            .await
            .map_err(SdkError::internal)?
            .ok_or_else(|| {
                SdkError::new(
                    SdkErrorCode::NotFound,
                    format!("Session '{session_id}' 不存在"),
                )
            })?;
        self.runtime
            .bind_session_principal(session_id, principal)
            .await
            .map_err(SdkError::internal)?;
        Ok(session)
    }

    /// Makes every existing Session visible to the built-in Principal used by
    /// a single-user/default host. Existing historical bindings are preserved;
    /// only the current default binding is added when absent. This deliberately
    /// never runs in trusted-gateway mode, where only the gateway owns legacy
    /// Session ownership mappings.
    pub async fn adopt_sessions_for_default_principal(
        &self,
        principal: PrincipalAssertion,
        include_archived: bool,
    ) -> SdkResult<usize> {
        self.runtime
            .bind_all_sessions_to_principal(principal, include_archived)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn get_session(
        &self,
        principal_id: &str,
        session_id: &str,
    ) -> SdkResult<SessionRecord> {
        self.authorize_session(principal_id, session_id).await
    }

    pub async fn update_session(
        &self,
        principal_id: &str,
        session_id: &str,
        update: SessionUpdate,
    ) -> SdkResult<SessionRecord> {
        self.authorize_session(principal_id, session_id).await?;
        self.runtime
            .update_session(session_id, update)
            .await
            .map_err(SdkError::internal)?
            .ok_or_else(|| {
                SdkError::new(
                    SdkErrorCode::NotFound,
                    format!("Session '{session_id}' 不存在"),
                )
            })
    }

    pub async fn list_sessions(
        &self,
        principal_id: &str,
        include_archived: bool,
    ) -> SdkResult<Vec<SessionRecord>> {
        self.runtime
            .list_principal_sessions(principal_id, include_archived)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn send_message(
        &self,
        principal: &PrincipalAssertion,
        command: SendMessageCommand,
    ) -> SdkResult<MessageReceipt> {
        self.authorize_session(&principal.principal_id, &command.session_id)
            .await?;
        self.runtime
            .session(command.session_id)
            .send_as_principal_with_options(
                command.text,
                command.actor,
                principal.principal_id.clone(),
                command.client_message_id,
                SessionMessageOptions {
                    requested_harness: command.harness,
                    attachments: command.attachments,
                    references: command.references,
                    dispatch_mode: command.dispatch_mode,
                },
            )
            .await
            .map_err(|error| {
                let code = error
                    .downcast_ref::<MessageIngressError>()
                    .map(|error| match error.kind {
                        MessageIngressErrorKind::InvalidArgument => SdkErrorCode::InvalidArgument,
                        MessageIngressErrorKind::Conflict => SdkErrorCode::Conflict,
                        MessageIngressErrorKind::Forbidden => SdkErrorCode::Forbidden,
                    })
                    .unwrap_or(SdkErrorCode::InvalidArgument);
                SdkError::new(code, error.to_string())
            })
    }

    pub async fn retry_dialogue_turn(
        &self,
        principal: &PrincipalAssertion,
        command: RetryDialogueTurnCommand,
    ) -> SdkResult<DialogueTurnRetryReceipt> {
        self.authorize_session(&principal.principal_id, &command.session_id)
            .await?;
        self.runtime
            .session(command.session_id)
            .retry_dialogue_turn_as_principal(
                command.root_turn_id,
                principal.principal_id.clone(),
                command.expected_thread_revision,
                command.expected_result_event_id,
                command.retry_request_id,
            )
            .await
            .map_err(|error| SdkError::new(SdkErrorCode::Conflict, error.to_string()))
    }

    pub async fn session_events(
        &self,
        principal_id: &str,
        query: SessionEventsQuery,
    ) -> SdkResult<Vec<Event>> {
        self.authorize_session(principal_id, &query.session_id)
            .await?;
        let limit = query.limit.clamp(1, 1_000);
        if query.after_sequence.is_some() && query.before_sequence.is_some() {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "after_sequence 与 before_sequence 不能同时使用",
            ));
        }
        let filter = if let Some(after_sequence) = query.after_sequence {
            QueryFilter {
                session_id: Some(query.session_id),
                after_sequence: Some(after_sequence),
                top_k: Some(limit),
                topics: query
                    .conversation_only
                    .then(conversation_event_topics)
                    .map(|topics| topics.iter().map(|topic| (*topic).to_string()).collect())
                    .unwrap_or_default(),
                excluded_topics: vec!["chat/context_inspect".to_string()],
                ..QueryFilter::default()
            }
        } else {
            QueryFilter {
                session_id: Some(query.session_id),
                before_sequence: query.before_sequence,
                latest_k: Some(limit),
                topics: query
                    .conversation_only
                    .then(conversation_event_topics)
                    .map(|topics| topics.iter().map(|topic| (*topic).to_string()).collect())
                    .unwrap_or_default(),
                excluded_topics: vec!["chat/context_inspect".to_string()],
                ..QueryFilter::default()
            }
        };
        self.runtime
            .query_events(filter)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn authorize_session(
        &self,
        principal_id: &str,
        session_id: &str,
    ) -> SdkResult<SessionRecord> {
        let session = self
            .runtime
            .get_session(session_id)
            .await
            .map_err(SdkError::internal)?
            .ok_or_else(|| {
                SdkError::new(
                    SdkErrorCode::NotFound,
                    format!("Session '{session_id}' 不存在"),
                )
            })?;
        let bound = self
            .runtime
            .verify_session_principal(session_id, principal_id)
            .await
            .map_err(SdkError::internal)?;
        if !bound {
            return Err(SdkError::new(
                SdkErrorCode::Forbidden,
                format!("Principal '{principal_id}' 未参与 Session '{session_id}'"),
            ));
        }
        Ok(session)
    }

    pub fn subscribe_all(&self, capacity: usize) -> RuntimeEventStream {
        self.runtime.subscribe("*", capacity)
    }

    pub async fn subscribe_session(
        &self,
        principal_id: &str,
        session_id: &str,
        capacity: usize,
    ) -> SdkResult<SessionEventStream> {
        self.authorize_session(principal_id, session_id).await?;
        Ok(SessionEventStream {
            inner: self.runtime.subscribe("*", capacity),
            session_id: session_id.to_string(),
        })
    }

    /// Internal first-party adapters occasionally need Runtime-only surfaces
    /// which are intentionally not part of SDK v1 yet.
    #[doc(hidden)]
    pub fn runtime(&self) -> &MorphzRuntime {
        &self.runtime
    }
}

fn hash_secret(secret: &str) -> String {
    format!("{:x}", Sha256::digest(secret.as_bytes()))
}

/// Canonical bytes signed by an Edge Node when exchanging a one-shot
/// challenge for a short-lived connection credential.
pub fn execution_node_connection_proof_message(
    node_id: &str,
    challenge_id: &str,
    nonce: &str,
) -> Vec<u8> {
    format!("morphz-edge-connect-v1\0{node_id}\0{challenge_id}\0{nonce}").into_bytes()
}

fn decode_hex(value: &str) -> Result<Vec<u8>, &'static str> {
    if !value.len().is_multiple_of(2) {
        return Err("hex 长度必须为偶数");
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let high = hex_nibble(pair[0]).ok_or("包含非十六进制字符")?;
            let low = hex_nibble(pair[1]).ok_or("包含非十六进制字符")?;
            Ok((high << 4) | low)
        })
        .collect()
}

fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn random_secret(prefix: &str, byte_count: usize) -> SdkResult<String> {
    let mut bytes = vec![0_u8; byte_count];
    getrandom::fill(&mut bytes).map_err(|error| {
        SdkError::new(
            SdkErrorCode::Internal,
            format!("操作系统随机数生成失败: {error}"),
        )
    })?;
    let mut encoded = String::with_capacity(prefix.len() + 1 + byte_count * 2);
    encoded.push_str(prefix);
    encoded.push('_');
    use std::fmt::Write as _;
    for byte in bytes {
        write!(&mut encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AppConfig;
    use crate::llm::{Client, Message, Response, ToolDefinition};
    use crate::memory::{NewAgent, QueryFilter, SessionMountKind, SessionStatus};
    use async_trait::async_trait;
    use std::sync::Arc;
    use tempfile::NamedTempFile;

    struct OfflineClient;

    #[async_trait]
    impl Client for OfflineClient {
        async fn create_completion(
            &self,
            _messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
        ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
            Err("offline".into())
        }
    }

    fn principal(id: &str) -> PrincipalAssertion {
        PrincipalAssertion {
            principal_id: id.to_string(),
            provider_id: "morphz-site".to_string(),
            assurance: "trusted-gateway".to_string(),
            display_name: Some(id.to_string()),
        }
    }

    #[tokio::test]
    async fn principal_scoped_contract_rejects_cross_session_access() {
        let database = NamedTempFile::new().unwrap();
        let runtime = MorphzRuntime::builder(AppConfig::default(), Arc::new(OfflineClient))
            .database_path(database.path().to_str().unwrap())
            .build()
            .await
            .unwrap();
        runtime
            .ensure_agent(NewAgent {
                id: "agent-sdk".to_string(),
                title: "SDK".to_string(),
                root_context_id: "context-sdk".to_string(),
            })
            .await
            .unwrap();
        runtime
            .ensure_context(NewCognitiveContext {
                id: "context-sdk".to_string(),
                agent_id: "agent-sdk".to_string(),
                title: "SDK".to_string(),
            })
            .await
            .unwrap();
        let sdk = MorphzSdk::new(runtime);
        sdk.create_session(
            principal("principal-a"),
            NewSession {
                id: "session-a".to_string(),
                agent_id: "agent-sdk".to_string(),
                context_id: "context-sdk".to_string(),
                parent_session_id: None,
                title: "A".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            },
        )
        .await
        .unwrap();

        assert_eq!(
            sdk.list_sessions("principal-a", false).await.unwrap().len(),
            1
        );
        let parent_error = sdk
            .create_session(
                principal("principal-b"),
                NewSession {
                    id: "session-b-child".to_string(),
                    agent_id: "agent-sdk".to_string(),
                    context_id: "context-sdk".to_string(),
                    parent_session_id: Some("session-a".to_string()),
                    title: "B child".to_string(),
                    mount_kind: SessionMountKind::ExistingContext,
                },
            )
            .await
            .unwrap_err();
        assert_eq!(parent_error.code, SdkErrorCode::Forbidden);

        let error = sdk
            .get_session("principal-b", "session-a")
            .await
            .unwrap_err();
        assert_eq!(error.code, SdkErrorCode::Forbidden);

        let default_principal = sdk.default_principal();
        assert_eq!(default_principal.principal_id, "principal-default");
        assert_eq!(
            sdk.adopt_sessions_for_default_principal(default_principal.clone(), true)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sdk.list_sessions(&default_principal.principal_id, false)
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            sdk.list_sessions("principal-a", false).await.unwrap().len(),
            1
        );
    }

    #[tokio::test]
    async fn typed_session_reference_is_authorized_and_persisted_by_stable_id() {
        let database = NamedTempFile::new().unwrap();
        let runtime = MorphzRuntime::builder(AppConfig::default(), Arc::new(OfflineClient))
            .database_path(database.path().to_str().unwrap())
            .build()
            .await
            .unwrap();
        runtime
            .ensure_agent(NewAgent {
                id: "agent-reference".to_string(),
                title: "Reference".to_string(),
                root_context_id: "context-reference-a".to_string(),
            })
            .await
            .unwrap();
        for (context_id, title) in [
            ("context-reference-a", "Source Context"),
            ("context-reference-b", "Target Context"),
        ] {
            runtime
                .ensure_context(NewCognitiveContext {
                    id: context_id.to_string(),
                    agent_id: "agent-reference".to_string(),
                    title: title.to_string(),
                })
                .await
                .unwrap();
        }
        let sdk = MorphzSdk::new(runtime.clone());
        for (session_id, context_id, title) in [
            ("session-reference-a", "context-reference-a", "Coordinator"),
            ("session-reference-b", "context-reference-b", "Research"),
        ] {
            sdk.create_session(
                principal("principal-reference"),
                NewSession {
                    id: session_id.to_string(),
                    agent_id: "agent-reference".to_string(),
                    context_id: context_id.to_string(),
                    parent_session_id: None,
                    title: title.to_string(),
                    mount_kind: SessionMountKind::ExistingContext,
                },
            )
            .await
            .unwrap();
        }

        let receipt = sdk
            .send_message(
                &principal("principal-reference"),
                SendMessageCommand {
                    session_id: "session-reference-a".to_string(),
                    text: "Coordinate with @Research".to_string(),
                    actor: "User-API".to_string(),
                    client_message_id: Some("reference-message-1".to_string()),
                    attachments: Vec::new(),
                    references: vec![MessageReferenceInput::Session {
                        session_id: "session-reference-b".to_string(),
                    }],
                    harness: None,
                    dispatch_mode: Some(MessageDispatchMode::Parallel),
                },
            )
            .await
            .unwrap();
        let event = runtime
            .query_events(QueryFilter {
                event_id: Some(receipt.event_id),
                ..QueryFilter::default()
            })
            .await
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(event.payload["references"][0]["kind"], "session");
        assert_eq!(
            event.payload["references"][0]["session_id"],
            "session-reference-b"
        );
        assert_eq!(event.payload["references"][0]["title"], "Research");
        assert_eq!(
            event.payload["references"][0]["context_id"],
            "context-reference-b"
        );
        assert!(runtime
            .query_events(QueryFilter {
                context_id: Some("context-reference-b".to_string()),
                topic: Some("chat/user_message".to_string()),
                ..QueryFilter::default()
            })
            .await
            .unwrap()
            .is_empty());

        sdk.create_session(
            principal("principal-private"),
            NewSession {
                id: "session-reference-private".to_string(),
                agent_id: "agent-reference".to_string(),
                context_id: "context-reference-a".to_string(),
                parent_session_id: None,
                title: "Private".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            },
        )
        .await
        .unwrap();
        let forbidden = sdk
            .send_message(
                &principal("principal-reference"),
                SendMessageCommand {
                    session_id: "session-reference-a".to_string(),
                    text: "Reference private".to_string(),
                    actor: "User-API".to_string(),
                    client_message_id: Some("reference-message-private".to_string()),
                    attachments: Vec::new(),
                    references: vec![MessageReferenceInput::Session {
                        session_id: "session-reference-private".to_string(),
                    }],
                    harness: None,
                    dispatch_mode: None,
                },
            )
            .await
            .unwrap_err();
        assert_eq!(forbidden.code, SdkErrorCode::Forbidden);

        sdk.update_session(
            "principal-reference",
            "session-reference-b",
            SessionUpdate {
                title: None,
                status: Some(SessionStatus::Archived),
            },
        )
        .await
        .unwrap();
        let archived = sdk
            .send_message(
                &principal("principal-reference"),
                SendMessageCommand {
                    session_id: "session-reference-a".to_string(),
                    text: "Reference archived".to_string(),
                    actor: "User-API".to_string(),
                    client_message_id: Some("reference-message-archived".to_string()),
                    attachments: Vec::new(),
                    references: vec![MessageReferenceInput::Session {
                        session_id: "session-reference-b".to_string(),
                    }],
                    harness: None,
                    dispatch_mode: None,
                },
            )
            .await
            .unwrap_err();
        assert_eq!(archived.code, SdkErrorCode::Conflict);
    }

    #[tokio::test]
    async fn session_subscription_never_exposes_another_session() {
        let database = NamedTempFile::new().unwrap();
        let runtime = MorphzRuntime::builder(AppConfig::default(), Arc::new(OfflineClient))
            .database_path(database.path().to_str().unwrap())
            .build()
            .await
            .unwrap();
        runtime
            .ensure_agent(NewAgent {
                id: "agent-stream".to_string(),
                title: "Stream".to_string(),
                root_context_id: "context-stream".to_string(),
            })
            .await
            .unwrap();
        runtime
            .ensure_context(NewCognitiveContext {
                id: "context-stream".to_string(),
                agent_id: "agent-stream".to_string(),
                title: "Stream".to_string(),
            })
            .await
            .unwrap();
        let sdk = MorphzSdk::new(runtime.clone());
        for session_id in ["session-stream-a", "session-stream-b"] {
            sdk.create_session(
                principal("principal-stream"),
                NewSession {
                    id: session_id.to_string(),
                    agent_id: "agent-stream".to_string(),
                    context_id: "context-stream".to_string(),
                    parent_session_id: None,
                    title: session_id.to_string(),
                    mount_kind: SessionMountKind::ExistingContext,
                },
            )
            .await
            .unwrap();
        }

        let mut events = sdk
            .subscribe_session("principal-stream", "session-stream-a", 8)
            .await
            .unwrap();
        for (event_id, session_id) in [
            ("event-stream-b", "session-stream-b"),
            ("event-stream-a", "session-stream-a"),
        ] {
            runtime
                .publish(Event::new(
                    event_id.to_string(),
                    "test".to_string(),
                    "test".to_string(),
                    "test/session-stream".to_string(),
                    [("session_id".to_string(), serde_json::json!(session_id))]
                        .into_iter()
                        .collect(),
                ))
                .await
                .unwrap();
        }

        let received = tokio::time::timeout(std::time::Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(received.id, "event-stream-a");
    }
}
