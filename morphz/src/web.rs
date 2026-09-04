use crate::approval::ApprovalDecision;
use crate::artifact::ArtifactTransferStageKind;
use crate::config::{
    save_managed_inference_at, AuthAccountConfig, ModelProtocol, ModelRouteConfig,
    ProviderInstanceConfig, ProviderModelConfig, ServerIdentityConfig, ServerIdentityMode,
};
use crate::event::Event;
use crate::execution_target::EdgeArtifactDataDirection;
use crate::identity::PrincipalAssertion;
use crate::llm::ReasoningEffort;
use crate::memory::{
    CapabilityLeaseRestriction, ContextUpdate, DelegationFilter, DelegationStatus,
    ExecutionTargetRegistration, ExecutionTargetStatus, NewAgent, NewCognitiveContext, NewSession,
    ObjectiveMutation, ObjectiveRecord, ObjectiveStatus, QueryFilter, ScheduleMutation,
    SessionMountKind, SessionStatus, SessionUpdate, ThreadControlAction, ThreadMutation,
};
use crate::orchestrator::context::{FrameRecallDirection, FrameRecallRequest, RecallSearchRequest};
use crate::provider::auth::{
    oauth_callback_login_id, parse_authorization_response, submit_oauth_callback,
    OAuthLoginCompletion, OAuthLoginProgress,
};
use crate::provider::control::ProviderAccountControlAction;
use crate::runtime::{
    AcknowledgeAttentionCommand, ContextOverviewQuery, EventHistoryQuery, ModelUsageQuery,
    MorphzRuntime, RuntimeOverviewQuery, SchedulerQuery,
};
use crate::sdk::{
    AppendEdgeOutputCommand, AuthorizeExecutionTargetCommand, CancelEdgeBackgroundExecutionCommand,
    ClaimEdgeCommand, ConnectExecutionNodeCommand, CreateMessageAttachmentStageCommand,
    CreateNodePairingCodeCommand, CreateObjectiveCommand, ExactHarnessRef, ExecutionJobQuery,
    ExecutionNodeHeartbeatCommand, FinishEdgeBackgroundExecutionCommand, FinishEdgeCommand,
    HeartbeatEdgeBackgroundExecutionCommand, HeartbeatEdgeCommand, MessageAttachmentInput,
    MorphzSdk, OAuthProviderSetup, ObjectiveRequestOrigin, PairExecutionNodeCommand,
    ReserveEdgeBackgroundExecutionCommand, RetryDialogueTurnCommand, RotateExecutionNodeKeyCommand,
    SdkError, SdkErrorCode, SendMessageCommand, SessionEventsQuery, SubmitArtifactTransferCommand,
};
use axum::{
    body::Body,
    extract::{
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, MatchedPath, Path, Query, Request, State,
    },
    http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post},
    Json, Router,
};
use base64::Engine;
use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};
use tower_http::{
    compression::CompressionLayer,
    cors::{AllowOrigin, CorsLayer},
};

const DASHBOARD_INDEX: &[u8] = include_bytes!("../../dashboard/dist/index.html");
const DASHBOARD_APP_JS: &[u8] = include_bytes!("../../dashboard/dist/assets/app.js");
const DASHBOARD_APP_CSS: &[u8] = include_bytes!("../../dashboard/dist/assets/app.css");
const DASHBOARD_FAVICON: &[u8] = include_bytes!("../../dashboard/dist/favicon.svg");
const DASHBOARD_ICONS: &[u8] = include_bytes!("../../dashboard/dist/icons.svg");
const DASHBOARD_DURABLE_EVENT_POLL_INTERVAL: std::time::Duration =
    std::time::Duration::from_millis(500);
const DASHBOARD_WEBSOCKET_HEARTBEAT_INTERVAL: std::time::Duration =
    std::time::Duration::from_secs(20);
const DASHBOARD_DURABLE_EVENT_BATCH_SIZE: usize = 256;
const DASHBOARD_RECENT_EVENT_IDS: usize = 16_384;

#[derive(Default)]
struct RecentDashboardEventIds {
    ids: HashSet<String>,
    order: VecDeque<String>,
}

impl RecentDashboardEventIds {
    fn insert(&mut self, event_id: &str) -> bool {
        if !self.ids.insert(event_id.to_string()) {
            return false;
        }
        self.order.push_back(event_id.to_string());
        while self.order.len() > DASHBOARD_RECENT_EVENT_IDS {
            if let Some(expired) = self.order.pop_front() {
                self.ids.remove(&expired);
            }
        }
        true
    }

    fn remove(&mut self, event_id: &str) {
        self.ids.remove(event_id);
        self.order.retain(|candidate| candidate != event_id);
    }
}

pub struct Server {
    runtime: MorphzRuntime,
    broadcast_tx: broadcast::Sender<Event>,
    default_agent_id: String,
    default_context_id: String,
    identity: ServerIdentityConfig,
}

pub struct ServerDefaults {
    pub agent_id: String,
    pub context_id: String,
}

struct AppState {
    runtime: MorphzRuntime,
    sdk: MorphzSdk,
    broadcast_tx: broadcast::Sender<Event>,
    /// Privileged credential for the embedded Dashboard/operator surface.
    ///
    /// This credential never authorizes a gateway to assert an end-user
    /// Principal. Keeping it separate from `gateway_token` prevents enabling
    /// trusted-gateway mode from making the Dashboard unusable (or, worse,
    /// turning the gateway service credential into an operator credential).
    auth_token: Option<String>,
    /// Service credential accepted from a trusted identity gateway.
    gateway_token: Option<String>,
    default_agent_id: String,
    default_context_id: String,
    identity: ServerIdentityConfig,
    /// Kernel/runtime settings remain separate from the Provider catalog.
    core_config_path: Option<PathBuf>,
    /// The embedded operator surface persists Provider, Account, Route and
    /// model-level inference choices here. Tests inject an isolated path.
    managed_config_path: Option<PathBuf>,
}

#[derive(Default, serde::Deserialize)]
struct AuthQuery {
    token: Option<String>,
    session_id: Option<String>,
    principal_id: Option<String>,
    #[serde(default)]
    observe_model_requests: bool,
}

#[derive(Default, serde::Deserialize)]
struct AttentionAcknowledgementsQuery {
    token: Option<String>,
    after_sequence: Option<u64>,
    limit: Option<usize>,
}

#[derive(Default, serde::Deserialize)]
struct ProviderAttemptsQuery {
    token: Option<String>,
    limit: Option<usize>,
}

#[derive(Default, serde::Deserialize)]
struct ObservabilityQuery {
    token: Option<String>,
    limit: Option<usize>,
}

#[derive(Default, serde::Deserialize)]
struct ModelRouteDiagnosticRequest {
    account_id: Option<String>,
}

#[derive(Default, serde::Deserialize)]
struct ProviderAccountDiagnosticRequest {
    model: Option<String>,
}

#[derive(Default, serde::Deserialize)]
struct UpdateAutoReviewModelRequest {
    model: Option<String>,
}

#[derive(serde::Deserialize)]
struct UpdateEvaluationModelPolicyRequest {
    primary_model: String,
    #[serde(default)]
    allowed_evaluation_models: Vec<String>,
}

#[derive(Default, serde::Deserialize)]
struct SessionListQuery {
    #[serde(default)]
    include_archived: bool,
    token: Option<String>,
}

#[derive(Default, serde::Deserialize)]
struct PrincipalDirectoryQuery {
    token: Option<String>,
    #[serde(default)]
    query: String,
    cursor: Option<String>,
    limit: Option<usize>,
}

#[derive(Default, serde::Deserialize)]
struct OperatorPrincipalSessionsQuery {
    token: Option<String>,
    #[serde(default)]
    include_archived: bool,
}

#[derive(serde::Deserialize)]
struct CreateSessionRequest {
    id: Option<String>,
    agent_id: Option<String>,
    parent_session_id: Option<String>,
    title: Option<String>,
    mount: Option<ContextMountRequest>,
}

#[derive(serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ContextMountRequest {
    ExistingContext {
        context_id: String,
    },
    NewBlankContext {
        context_id: Option<String>,
        context_title: Option<String>,
    },
    NewContextFromMind {
        source_context_id: String,
        source_version: Option<u64>,
        context_id: Option<String>,
        context_title: Option<String>,
    },
}

#[derive(serde::Deserialize)]
struct CreateIndependentSessionRequest {
    source_context_id: String,
    source_version: Option<u64>,
    context_id: Option<String>,
    context_title: Option<String>,
    session_id: Option<String>,
    session_title: Option<String>,
}

#[derive(serde::Deserialize)]
struct CreateAgentRequest {
    id: Option<String>,
    title: Option<String>,
    root_context_id: Option<String>,
    root_context_title: Option<String>,
    initial_session_id: Option<String>,
    initial_session_title: Option<String>,
}

#[derive(serde::Deserialize)]
struct CreateContextRequest {
    id: Option<String>,
    agent_id: Option<String>,
    title: Option<String>,
}

#[derive(serde::Deserialize)]
struct UpdateContextRequest {
    title: Option<String>,
    status: Option<SessionStatus>,
}

#[derive(serde::Deserialize)]
struct UpdateContextTokenBudgetRequest {
    requested_hard_token_limit: Option<u64>,
    expected_revision: u64,
}

#[derive(serde::Deserialize)]
struct UpdateContextCapabilityBindingRequest {
    enabled: bool,
    expected_revision: u64,
}

#[derive(serde::Deserialize)]
struct UpdateSessionRequest {
    title: Option<String>,
    status: Option<SessionStatus>,
    model_alias: Option<String>,
    reasoning_effort: Option<String>,
    permission_mode: Option<crate::permission::PermissionMode>,
    sandbox_mode: Option<crate::permission::SandboxMode>,
    /// Empty string restores Runtime inheritance; a concrete id becomes the
    /// destination for subsequently-created Dialogue Threads only.
    default_target_id: Option<String>,
    context_sharing: Option<crate::memory::SessionContextSharing>,
}

#[derive(serde::Deserialize)]
struct SendMessageRequest {
    #[serde(default)]
    input_destination: Option<crate::steering::InputDestination>,
    text: String,
    client_message_id: Option<String>,
    #[serde(default)]
    attachments: Vec<IncomingMessageAttachment>,
    #[serde(default)]
    staged_attachment_ids: Vec<String>,
    #[serde(default)]
    references: Vec<crate::sdk::MessageReferenceInput>,
    #[serde(default)]
    harness: Option<crate::harness::ExactHarnessRef>,
    #[serde(default)]
    dispatch_mode: Option<crate::memory::MessageDispatchMode>,
    /// Optional one-shot model route for this message's Evaluation. This does
    /// not change the Session's default model.
    #[serde(default)]
    model_alias: Option<String>,
    /// Optional one-shot reasoning level for this message's Evaluation.
    #[serde(default)]
    reasoning_effort: Option<String>,
    /// Optional one-shot physical destination for this Dialogue Thread.
    #[serde(default)]
    target_id: Option<String>,
}

#[derive(serde::Deserialize)]
struct IncomingMessageAttachment {
    name: String,
    media_type: String,
    data_base64: String,
}

#[derive(serde::Deserialize)]
struct CreateMessageAttachmentStageRequest {
    stage_id: Option<String>,
    client_message_id: String,
    name: String,
    media_type: String,
    size_bytes: u64,
    expected_sha256: Option<String>,
}

#[derive(serde::Deserialize)]
struct MessageAttachmentStagesQuery {
    token: Option<String>,
    client_message_id: Option<String>,
}

#[derive(serde::Deserialize)]
struct RetryDialogueTurnRequest {
    expected_thread_revision: u64,
    expected_result_event_id: String,
    retry_request_id: Option<String>,
}

#[derive(serde::Deserialize)]
struct DecideApprovalRequest {
    decision: String,
    rationale: Option<String>,
}

#[derive(serde::Deserialize)]
struct PutManagedSecretRequest {
    name: String,
    value: String,
    scope_kind: crate::secret_store::SecretScopeKind,
    scope_id: Option<String>,
    value_backend: Option<String>,
}

#[derive(serde::Deserialize)]
struct ImportManagedSecretRequest {
    name: String,
    scope_kind: crate::secret_store::SecretScopeKind,
    scope_id: Option<String>,
    value_backend: String,
}

#[derive(serde::Deserialize)]
struct ControlProviderAccountRequest {
    action: ProviderAccountControlAction,
    expected_revision: Option<u64>,
}

#[derive(serde::Deserialize)]
struct PutProviderCatalogSetupRequest {
    provider_id: String,
    provider: ProviderInstanceConfig,
    account_id: String,
    account: AuthAccountConfig,
    credential_id: Option<String>,
    credential: Option<crate::config::CredentialConfig>,
    managed_secret: Option<PutManagedSecretRequest>,
    route_id: String,
    route: ModelRouteConfig,
}

#[derive(serde::Deserialize)]
struct DiscoverProviderModelsRequest {
    protocol: crate::config::ModelProtocol,
    base_url: String,
    api_key: String,
}

#[derive(serde::Serialize)]
struct DiscoverProviderModelsResponse {
    models: Vec<String>,
}

#[derive(serde::Deserialize)]
struct PutProviderAccountModelsRequest {
    models: Vec<ProviderAccountModelSelection>,
}

#[derive(serde::Deserialize)]
struct ProviderAccountModelSelection {
    id: String,
    alias: Option<String>,
    prompt_cache_strategy: Option<crate::config::PromptCacheStrategy>,
    context_window_tokens: Option<usize>,
    max_input_tokens: Option<usize>,
    max_output_tokens: Option<usize>,
    max_input_attachments: Option<usize>,
    max_input_attachment_bytes: Option<usize>,
    max_input_attachment_total_bytes: Option<usize>,
}

#[derive(serde::Deserialize)]
struct StartOAuthProviderSetupRequest {
    service: String,
}

#[derive(Default, serde::Deserialize)]
struct OAuthCallbackQuery {
    state: String,
    code: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(serde::Deserialize)]
struct SubmitOAuthCallbackRequest {
    redirect_url: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct SubmitOAuthCallbackResponse {
    login_id: String,
    progress: OAuthLoginProgress,
}

/// OAuth services whose complete Dashboard bootstrap path is implemented by
/// this exact Runtime build. This is deliberately separate from the auth
/// adapter catalog: an adapter may exist for SDK/CLI use while the embedded
/// Dashboard bootstrap endpoint is absent (for example when an older Runtime
/// serves a newer hot-reloaded Dashboard).
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
struct OAuthProviderSetupServiceDescriptor {
    id: &'static str,
    auth_adapter: &'static str,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
struct OAuthProviderSetupServicesResponse {
    services: Vec<OAuthProviderSetupServiceDescriptor>,
}

#[derive(serde::Deserialize)]
struct MutateScheduleRequest {
    action: String,
    expected_revision: u64,
    not_before: Option<chrono::DateTime<chrono::Utc>>,
    interval_seconds: Option<u64>,
}

#[derive(serde::Deserialize)]
struct UpdateInferenceRequest {
    model: Option<String>,
    reasoning_effort: Option<String>,
    prompt_token_limit: Option<u64>,
}

#[derive(serde::Deserialize)]
struct ResumeObjectiveRequest {
    expected_revision: u64,
    reason: Option<String>,
}

#[derive(serde::Deserialize)]
struct EditObjectiveRequest {
    expected_revision: u64,
    stated_objective: String,
}

#[derive(serde::Deserialize)]
struct CreateObjectiveRequest {
    id: Option<String>,
    coordinator_session_id: String,
    delivery_session_id: Option<String>,
    parent_objective_id: Option<String>,
    stated_objective: String,
    token_budget: Option<u64>,
    harness: Option<ExactHarnessRef>,
}

#[derive(serde::Deserialize)]
struct AcknowledgeAttentionRequest {
    key: String,
    source_kind: String,
    source_id: String,
    source_revision: u64,
    rationale: Option<String>,
}

#[derive(serde::Deserialize)]
struct ControlThreadRequest {
    action: ThreadControlAction,
    expected_revision: u64,
    reason: Option<String>,
}

#[derive(serde::Deserialize)]
struct SupersedeThreadRequest {
    expected_revision: u64,
    intent: String,
    reason: Option<String>,
}

#[derive(serde::Deserialize)]
struct MutateExecutionTargetRequest {
    expected_revision: u64,
    status: ExecutionTargetStatus,
}

#[derive(serde::Deserialize)]
struct RevokeExecutionNodeRequest {
    expected_revision: u64,
}

#[derive(Default, serde::Deserialize)]
struct CapabilityLeaseQuery {
    token: Option<String>,
    principal_id: Option<String>,
    thread_id: Option<String>,
    target_id: Option<String>,
    #[serde(default)]
    active_only: bool,
}

#[derive(serde::Deserialize)]
struct RevokeCapabilityLeaseRequest {
    expected_revision: u64,
    reason: Option<String>,
}

#[derive(serde::Deserialize)]
struct RestrictCapabilityLeaseRequest {
    expected_revision: u64,
    requested: serde_json::Value,
    expires_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Default, serde::Deserialize)]
struct TargetAuthorizationQuery {
    token: Option<String>,
    principal_id: Option<String>,
    target_id: Option<String>,
    #[serde(default)]
    active_only: bool,
}

#[derive(serde::Deserialize)]
struct RevokeTargetAuthorizationRequest {
    expected_revision: u64,
    reason: Option<String>,
}

#[derive(Default, serde::Deserialize)]
struct ExecutionJobHttpQuery {
    token: Option<String>,
    principal_id: Option<String>,
    context_id: Option<String>,
    thread_id: Option<String>,
    target_id: Option<String>,
    status: Option<crate::memory::ExecutionJobStatus>,
    #[serde(default)]
    include_terminal: bool,
    #[serde(default)]
    newest_first: bool,
    limit: Option<usize>,
}

#[derive(serde::Deserialize)]
struct CancelExecutionJobRequest {
    expected_revision: u64,
    reason: Option<String>,
}

#[derive(Default, serde::Deserialize)]
struct EdgeClaimQuery {
    wait_seconds: Option<u64>,
}

#[derive(Default, serde::Deserialize)]
struct EdgeOutputQuery {
    token: Option<String>,
    after_sequence: Option<u64>,
    limit: Option<usize>,
}

#[derive(Default, serde::Deserialize)]
struct EdgeArtifactDownloadQuery {
    #[serde(default)]
    offset: u64,
}

#[derive(Default, serde::Deserialize)]
struct RecallSearchHttpQuery {
    token: Option<String>,
    query: Option<String>,
    start_time: Option<chrono::DateTime<chrono::Utc>>,
    end_time: Option<chrono::DateTime<chrono::Utc>>,
    cursor: Option<String>,
    limit: Option<usize>,
}

#[derive(Default, serde::Deserialize)]
struct DialogueHistorySearchHttpQuery {
    token: Option<String>,
    principal_id: Option<String>,
    query: String,
    limit: Option<usize>,
}

#[derive(Default, serde::Deserialize)]
struct FrameRecallHttpQuery {
    token: Option<String>,
    depth: Option<usize>,
    direction: Option<FrameRecallDirection>,
    include_bodies: Option<bool>,
    include_events: Option<bool>,
    max_nodes: Option<usize>,
    cursor: Option<String>,
}

#[derive(serde::Deserialize)]
struct MutateFrameLifecycleRequest {
    session_id: String,
    expected_version: u64,
    action: String,
    reason: Option<String>,
}

#[derive(Default, serde::Deserialize)]
struct EventQuery {
    token: Option<String>,
    principal_id: Option<String>,
    after_sequence: Option<u64>,
    before_sequence: Option<u64>,
    #[serde(default)]
    conversation_only: bool,
    limit: Option<usize>,
}

#[derive(Default, serde::Deserialize)]
struct SchedulerSnapshotHttpQuery {
    token: Option<String>,
    #[serde(default)]
    include_terminal: bool,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Default, serde::Deserialize)]
struct ContextOverviewHttpQuery {
    token: Option<String>,
    session_id: Option<String>,
    include_scheduler_summary: Option<bool>,
}

#[derive(Default, serde::Deserialize)]
struct RuntimeOverviewHttpQuery {
    token: Option<String>,
    #[serde(default)]
    include_archived: bool,
    context_limit: Option<usize>,
    sessions_per_context: Option<usize>,
    context_id: Option<String>,
}

#[derive(Default, serde::Deserialize)]
struct DelegationHttpQuery {
    token: Option<String>,
    context_id: Option<String>,
    session_id: Option<String>,
    #[serde(default)]
    include_terminal: bool,
    limit: Option<usize>,
}

#[derive(Default, serde::Deserialize)]
struct ModelUsageHttpQuery {
    token: Option<String>,
    session_id: Option<String>,
    before_sequence: Option<u64>,
    limit: Option<usize>,
}

#[derive(Default, serde::Deserialize)]
struct EventHistoryHttpQuery {
    token: Option<String>,
    session_id: Option<String>,
    principal_id: Option<String>,
    thread_id: Option<String>,
    activation_id: Option<String>,
    actor: Option<String>,
    event_type: Option<String>,
    topic: Option<String>,
    query: Option<String>,
    after_sequence: Option<u64>,
    before_sequence: Option<u64>,
    start_time: Option<chrono::DateTime<chrono::Utc>>,
    end_time: Option<chrono::DateTime<chrono::Utc>>,
    limit: Option<usize>,
}

static API_ID_COUNTER: AtomicU64 = AtomicU64::new(0);
static WEBSOCKET_OBSERVER_COUNTER: AtomicU64 = AtomicU64::new(0);

impl Server {
    pub fn new(runtime: MorphzRuntime, defaults: ServerDefaults) -> Self {
        Self::new_with_capacity(runtime, defaults, 1000)
    }

    pub fn new_with_capacity(
        runtime: MorphzRuntime,
        defaults: ServerDefaults,
        broadcast_capacity: usize,
    ) -> Self {
        let (broadcast_tx, _) = broadcast::channel(broadcast_capacity.max(1));

        Self {
            runtime,
            broadcast_tx,
            default_agent_id: defaults.agent_id,
            default_context_id: defaults.context_id,
            identity: ServerIdentityConfig::default(),
        }
    }

    pub fn with_identity(mut self, identity: ServerIdentityConfig) -> Self {
        self.identity = identity;
        self
    }

    pub async fn start(
        &self,
        addr_str: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // Validate the reverse-proxy mount once during startup. The embedded
        // HTML reads this value on every request so the same binary can serve
        // Dashboard at `/` locally and, for example, `/console/` in Cloud.
        configured_dashboard_base_path()?;
        let dashboard_token = std::env::var("MORPHZ_DASHBOARD_TOKEN")
            .ok()
            .map(|token| token.trim().to_string())
            .filter(|token| !token.is_empty());
        let gateway_token = match self.identity.mode {
            ServerIdentityMode::Default => None,
            ServerIdentityMode::TrustedGateway => {
                if self.identity.provider_id.trim().is_empty() {
                    return Err("server.identity.provider_id must not be empty".into());
                }
                let variable = self.identity.service_token_env.trim();
                if variable.is_empty() {
                    return Err("server.identity.service_token_env must not be empty".into());
                }
                let token = std::env::var(variable)
                    .map_err(|_| {
                        format!("trusted-gateway mode requires environment variable {variable}")
                    })?
                    .trim()
                    .to_string();
                if token.is_empty() {
                    return Err(
                        format!("{variable} for trusted-gateway mode must not be empty").into(),
                    );
                }
                Some(token)
            }
        };
        if dashboard_token.is_some() && dashboard_token == gateway_token {
            return Err(
                "MORPHZ_DASHBOARD_TOKEN must differ from the trusted-gateway service token; the management plane and user identity gateway require separate credentials"
                    .into(),
            );
        }
        self.start_with_auth_tokens(addr_str, dashboard_token, gateway_token)
            .await
    }

    pub async fn start_with_dashboard_token(
        &self,
        addr_str: &str,
        auth_token: Option<String>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.start_with_auth_tokens(addr_str, auth_token, None)
            .await
    }

    async fn start_with_auth_tokens(
        &self,
        addr_str: &str,
        auth_token: Option<String>,
        gateway_token: Option<String>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let dashboard_body_limit = self
            .runtime
            .config()
            .model_input
            .dashboard_body_limit_bytes();
        let broadcast_tx_clone = self.broadcast_tx.clone();
        let runtime = self.runtime.clone();
        let sdk = MorphzSdk::new(self.runtime.clone());
        let default_agent_id = self.default_agent_id.clone();
        let default_context_id = self.default_context_id.clone();
        let identity_mode = self.identity.mode;

        if self.identity.mode == ServerIdentityMode::Default {
            let adopted = sdk
                .adopt_sessions_for_default_principal(sdk.default_principal(), true)
                .await?;
            if adopted > 0 {
                tracing::info!(
                    event_code = "web.default_identity.sessions_adopted",
                    adopted,
                    "Default identity adopted legacy Sessions"
                );
            }
        }

        // Merge the low-latency process-local stream with a durable Event tail.
        // Another Runtime can commit into the same Store without publishing on
        // this process's EventBus, so WebSocket invalidation cannot rely on the
        // in-memory stream alone.
        let durable_after_sequence = loop {
            match self
                .runtime
                .query_events(QueryFilter {
                    latest_k: Some(1),
                    ..Default::default()
                })
                .await
            {
                Ok(events) => break events.last().and_then(|event| event.sequence).unwrap_or(0),
                Err(error) => {
                    tracing::warn!(
                        event_code = "web.websocket.durable_tail_initialize_failed",
                        %error,
                        "Could not initialize the durable Dashboard Event tail; retrying without advancing its cursor"
                    );
                    tokio::time::sleep(DASHBOARD_DURABLE_EVENT_POLL_INTERVAL).await;
                }
            }
        };
        let mut events = self.runtime.subscribe("*", 1024);
        let recent_event_ids = Arc::new(Mutex::new(RecentDashboardEventIds::default()));
        let local_recent_event_ids = Arc::clone(&recent_event_ids);
        tokio::spawn(async move {
            while let Some(ev) = events.recv().await {
                if !local_recent_event_ids.lock().await.insert(&ev.id) {
                    continue;
                }
                let event_id = ev.id.clone();
                let result = mirror_dashboard_event(
                    &runtime,
                    &broadcast_tx_clone,
                    &default_agent_id,
                    &default_context_id,
                    identity_mode,
                    ev,
                )
                .await;
                if let Err(error) = result {
                    local_recent_event_ids.lock().await.remove(&event_id);
                    tracing::warn!(event_code = "web.websocket.event_mirror_failed", error = %error, "WebSocket Event mirroring failed");
                }
            }
        });

        let durable_runtime = self.runtime.clone();
        let durable_broadcast_tx = self.broadcast_tx.clone();
        let durable_default_agent_id = self.default_agent_id.clone();
        let durable_default_context_id = self.default_context_id.clone();
        let durable_identity_mode = self.identity.mode;
        tokio::spawn(async move {
            mirror_durable_dashboard_events(
                durable_runtime,
                durable_broadcast_tx,
                durable_default_agent_id,
                durable_default_context_id,
                durable_identity_mode,
                recent_event_ids,
                durable_after_sequence,
            )
            .await;
        });

        let state = Arc::new(AppState {
            runtime: self.runtime.clone(),
            sdk,
            broadcast_tx: self.broadcast_tx.clone(),
            auth_token: auth_token.filter(|token| !token.trim().is_empty()),
            gateway_token: gateway_token.filter(|token| !token.trim().is_empty()),
            default_agent_id: self.default_agent_id.clone(),
            default_context_id: self.default_context_id.clone(),
            identity: self.identity.clone(),
            core_config_path: crate::config::managed_config_path().ok(),
            managed_config_path: crate::config::managed_model_config_path().ok(),
        });

        let addr: SocketAddr = addr_str.parse()?;
        if !addr.ip().is_loopback() && state.auth_token.is_none() && state.gateway_token.is_none() {
            return Err("non-loopback listening requires a service access token to prevent unauthenticated exposure of Event streams and the memory graph".into());
        }

        // Tokenless localhost remains frictionless for the embedded Dashboard
        // and local frontend development, but an arbitrary Internet page must
        // not be able to read the loopback API through the browser's CORS path.
        let cors = CorsLayer::new();
        let cors = if addr.ip().is_loopback()
            && state.auth_token.is_none()
            && state.gateway_token.is_none()
        {
            cors.allow_origin(AllowOrigin::predicate(|origin, _| {
                is_loopback_web_origin(origin)
            }))
        } else {
            cors.allow_origin(tower_http::cors::Any)
        };
        let cors = cors
            .allow_methods(vec![
                Method::GET,
                Method::POST,
                Method::PATCH,
                Method::PUT,
                Method::DELETE,
                Method::OPTIONS,
            ])
            .allow_headers(vec![
                header::CONTENT_TYPE,
                header::AUTHORIZATION,
                header::HeaderName::from_static("x-morphz-principal"),
                header::HeaderName::from_static("x-morphz-principal-name"),
                header::HeaderName::from_static("x-morphz-claim-token"),
                header::HeaderName::from_static("x-morphz-trace-id"),
            ])
            .expose_headers([header::HeaderName::from_static("x-morphz-trace-id")]);

        let app = Router::new()
            .route("/", get(handle_dashboard_index))
            .route("/assets/app.js", get(handle_dashboard_app_js))
            .route("/assets/app.css", get(handle_dashboard_app_css))
            .route("/favicon.svg", get(handle_dashboard_favicon))
            .route("/icons.svg", get(handle_dashboard_icons))
            .route("/health", get(|| async { StatusCode::OK }))
            .route("/metrics", get(handle_prometheus_metrics))
            .route("/api/status", get(handle_status))
            .route("/api/observability/turns", get(handle_recent_turn_traces))
            .route(
                "/api/observability/turns/:root_turn_id",
                get(handle_turn_trace),
            )
            .route("/api/runtime/system-prompt", get(handle_get_system_prompt))
            .route("/api/overview", get(handle_get_runtime_overview))
            .route(
                "/api/runtime/secrets",
                get(handle_list_managed_secrets).post(handle_put_managed_secret),
            )
            .route(
                "/api/runtime/secrets/import",
                post(handle_import_managed_secret),
            )
            .route(
                "/api/runtime/secrets/scope-options",
                get(handle_secret_scope_options),
            )
            .route(
                "/api/runtime/secrets/:name",
                delete(handle_delete_managed_secret),
            )
            .route(
                "/api/runtime/providers",
                get(handle_provider_control_snapshot),
            )
            .route(
                "/api/runtime/providers/attempts",
                get(handle_recent_provider_attempts),
            )
            .route(
                "/api/runtime/providers/accounts/:account_id",
                patch(handle_control_provider_account).delete(handle_delete_provider_account),
            )
            .route(
                "/api/runtime/providers/setup",
                axum::routing::put(handle_put_provider_catalog_setup),
            )
            .route(
                "/api/runtime/providers/discover-models",
                post(handle_discover_provider_models),
            )
            .route(
                "/api/runtime/providers/oauth/start",
                post(handle_start_oauth_provider_setup),
            )
            .route(
                "/api/runtime/providers/oauth/callback",
                get(handle_provider_oauth_callback).post(handle_submit_provider_oauth_callback),
            )
            .route(
                "/api/runtime/providers/oauth/services",
                get(handle_oauth_provider_setup_services),
            )
            .route(
                "/api/runtime/providers/instances/:provider_id",
                axum::routing::put(handle_put_provider_instance_config),
            )
            .route(
                "/api/runtime/providers/accounts/:account_id/config",
                axum::routing::put(handle_put_auth_account_config),
            )
            .route(
                "/api/runtime/providers/accounts/:account_id/models",
                axum::routing::put(handle_put_provider_account_models),
            )
            .route(
                "/api/runtime/providers/accounts/:account_id/test",
                post(handle_diagnose_provider_account),
            )
            .route(
                "/api/runtime/providers/accounts/:account_id/usage",
                get(handle_provider_subscription_usage),
            )
            .route(
                "/api/runtime/providers/accounts/:account_id/refresh-models",
                post(handle_refresh_provider_account_catalog),
            )
            .route(
                "/api/runtime/providers/routes/:route_id",
                axum::routing::put(handle_put_model_route_config),
            )
            .route(
                "/api/runtime/providers/routes/:route_id/test",
                post(handle_diagnose_model_route),
            )
            .route(
                "/api/runtime/providers/routes/:route_id/refresh-models",
                post(handle_refresh_model_catalog),
            )
            .route(
                "/api/runtime/permissions/auto-review-model",
                axum::routing::put(handle_update_auto_review_model),
            )
            .route(
                "/api/runtime/evaluation-model-policy",
                axum::routing::put(handle_update_evaluation_model_policy),
            )
            .route(
                "/api/runtime/providers/accounts/:account_id/oauth/start",
                post(handle_start_provider_oauth_login),
            )
            .route(
                "/api/runtime/providers/accounts/:account_id/oauth/start/:adapter_id",
                post(handle_start_provider_oauth_login_using),
            )
            .route(
                "/api/runtime/providers/accounts/:account_id/oauth/logout",
                post(handle_logout_provider_oauth_account),
            )
            .route(
                "/api/runtime/providers/oauth/:login_id/continue",
                post(handle_continue_provider_oauth_login)
                    .delete(handle_cancel_provider_oauth_login),
            )
            .route(
                "/api/runtime/inference",
                get(handle_get_inference).put(handle_update_inference),
            )
            .route(
                "/api/agents",
                get(handle_list_agents).post(handle_create_agent),
            )
            .route(
                "/api/agents/:agent_id/provider-accounts",
                get(handle_get_agent_provider_bindings),
            )
            .route(
                "/api/agents/:agent_id/provider-accounts/:account_id",
                axum::routing::put(handle_bind_agent_provider_account)
                    .delete(handle_unbind_agent_provider_account),
            )
            .route(
                "/api/contexts",
                get(handle_list_contexts).post(handle_create_context),
            )
            .route("/api/contexts/:context_id", patch(handle_update_context))
            .route(
                "/api/contexts/:context_id/token-budget",
                get(handle_get_context_token_budget).patch(handle_update_context_token_budget),
            )
            .route(
                "/api/contexts/:context_id/capabilities/:capability_id",
                get(handle_get_context_capability_binding)
                    .patch(handle_update_context_capability_binding),
            )
            .route(
                "/api/experimental/cognitive-coordination/status",
                get(handle_cognitive_coordination_status),
            )
            .route(
                "/api/experimental/cognitive-coordination/identity",
                get(handle_cognitive_coordination_identity),
            )
            .route(
                "/api/experimental/cognitive-coordination/handshake",
                post(handle_cognitive_coordination_handshake),
            )
            .route(
                "/api/experimental/cognitive-coordination/projection",
                post(handle_cognitive_coordination_projection),
            )
            .route(
                "/api/experimental/cognitive-coordination/evaluate",
                post(handle_cognitive_coordination_evaluate),
            )
            .route(
                "/api/experimental/cognitive-coordination/cancel",
                post(handle_cognitive_coordination_cancel),
            )
            .route(
                "/api/execution-targets",
                get(handle_list_execution_targets).post(handle_register_execution_target),
            )
            .route(
                "/api/execution-targets/:target_id",
                get(handle_inspect_execution_target).patch(handle_mutate_execution_target),
            )
            .route(
                "/api/execution-target-authorizations",
                get(handle_list_execution_target_authorizations)
                    .post(handle_authorize_execution_target),
            )
            .route(
                "/api/execution-target-authorizations/:authorization_id",
                delete(handle_revoke_execution_target_authorization),
            )
            .route("/api/capability-leases", get(handle_list_capability_leases))
            .route(
                "/api/capability-leases/:lease_id",
                patch(handle_restrict_capability_lease).delete(handle_revoke_capability_lease),
            )
            .route(
                "/api/edge/pairing-codes",
                post(handle_create_node_pairing_code),
            )
            .route("/api/edge/pair", post(handle_pair_execution_node))
            .route(
                "/api/edge/nodes/:node_id/challenge",
                post(handle_create_execution_node_challenge),
            )
            .route(
                "/api/edge/nodes/:node_id/connect",
                post(handle_connect_execution_node),
            )
            .route(
                "/api/edge/nodes/:node_id/rotate-key",
                post(handle_rotate_execution_node_key),
            )
            .route("/api/edge/nodes", get(handle_list_execution_nodes))
            .route(
                "/api/edge/nodes/:node_id",
                delete(handle_revoke_execution_node),
            )
            .route(
                "/api/edge/nodes/:node_id/heartbeat",
                post(handle_heartbeat_execution_node),
            )
            .route(
                "/api/edge/nodes/:node_id/jobs/claim",
                post(handle_claim_edge_command),
            )
            .route(
                "/api/edge/nodes/:node_id/jobs/:job_id/heartbeat",
                post(handle_heartbeat_edge_command),
            )
            .route(
                "/api/edge/nodes/:node_id/jobs/:job_id/output",
                post(handle_append_edge_command_output),
            )
            .route(
                "/api/edge/nodes/:node_id/jobs/:job_id/finish",
                post(handle_finish_edge_command),
            )
            .route(
                "/api/edge/nodes/:node_id/jobs/:job_id/background/reserve",
                post(handle_reserve_edge_background_execution),
            )
            .route(
                "/api/edge/nodes/:node_id/jobs/:job_id/background/:task_id/heartbeat",
                post(handle_heartbeat_edge_background_execution),
            )
            .route(
                "/api/edge/nodes/:node_id/jobs/:job_id/background/:task_id/finish",
                post(handle_finish_edge_background_execution),
            )
            .route(
                "/api/edge/nodes/:node_id/jobs/:job_id/background/:task_id/cancel",
                post(handle_cancel_edge_background_execution),
            )
            .route(
                "/api/edge/nodes/:node_id/jobs/:job_id/artifact/download",
                get(handle_download_edge_artifact),
            )
            .route(
                "/api/edge/nodes/:node_id/jobs/:job_id/artifact/upload",
                get(handle_inspect_edge_artifact_upload).put(handle_upload_edge_artifact),
            )
            .route(
                "/api/execution-jobs/:job_id/output",
                get(handle_list_edge_command_output),
            )
            .route("/api/execution-jobs", get(handle_list_execution_jobs))
            .route(
                "/api/execution-jobs/:job_id",
                get(handle_inspect_execution_job),
            )
            .route(
                "/api/execution-jobs/:job_id/cancel",
                post(handle_cancel_execution_job),
            )
            .route(
                "/api/artifact-transfers",
                post(handle_submit_artifact_transfer),
            )
            .route(
                "/api/artifact-transfers/:job_id",
                get(handle_inspect_artifact_transfer),
            )
            .route(
                "/api/artifact-transfers/:job_id/output",
                get(handle_artifact_transfer_output),
            )
            .route(
                "/api/artifact-transfers/:job_id/cancel",
                post(handle_cancel_execution_job),
            )
            .route(
                "/api/contexts/:context_id/working-set",
                get(handle_get_context_working_set),
            )
            .route(
                "/api/contexts/:context_id/overview",
                get(handle_get_context_overview),
            )
            .route(
                "/api/contexts/:context_id/model-usage",
                get(handle_get_model_usage),
            )
            .route(
                "/api/contexts/:context_id/activations",
                get(handle_get_context_activations),
            )
            .route(
                "/api/contexts/:context_id/scheduler",
                get(handle_get_scheduler_snapshot),
            )
            .route(
                "/api/contexts/:context_id/attention/acknowledgements",
                get(handle_list_attention_acknowledgements).post(handle_acknowledge_attention),
            )
            .route(
                "/api/contexts/:context_id/threads/:thread_id",
                get(handle_get_thread_detail).post(handle_control_thread),
            )
            .route(
                "/api/contexts/:context_id/threads/:thread_id/supersede",
                post(handle_supersede_thread),
            )
            .route(
                "/api/contexts/:context_id/events",
                get(handle_query_event_history),
            )
            .route(
                "/api/contexts/:context_id/projection-audit",
                post(handle_audit_mind_projection),
            )
            .route(
                "/api/contexts/:context_id/recall/search",
                get(handle_search_recall),
            )
            .route(
                "/api/contexts/:context_id/dialogue/search",
                get(handle_search_dialogue_history),
            )
            .route(
                "/api/contexts/:context_id/recall/index",
                get(handle_inspect_recall_index),
            )
            .route(
                "/api/contexts/:context_id/recall/index/rebuild",
                post(handle_rebuild_recall_index),
            )
            .route(
                "/api/contexts/:context_id/frames/:frame_id/recall",
                get(handle_recall_frame),
            )
            .route(
                "/api/contexts/:context_id/frames/:frame_id/lifecycle",
                post(handle_mutate_frame_lifecycle),
            )
            .route(
                "/api/sessions",
                get(handle_list_sessions).post(handle_create_session),
            )
            .route(
                "/api/operator/principals",
                get(handle_search_operator_principals),
            )
            .route(
                "/api/operator/principals/:principal_id/sessions",
                get(handle_list_operator_principal_sessions),
            )
            .route(
                "/api/sessions/independent",
                post(handle_create_independent_session),
            )
            .route(
                "/api/sessions/:session_id",
                get(handle_get_session).patch(handle_update_session),
            )
            .route(
                "/api/sessions/:session_id/execution-targets",
                get(handle_get_session_execution_targets),
            )
            .route(
                "/api/sessions/:session_id/messages",
                post(handle_send_message),
            )
            .route(
                "/api/sessions/:session_id/attachment-stages",
                get(handle_list_message_attachment_stages)
                    .post(handle_create_message_attachment_stage),
            )
            .route(
                "/api/sessions/:session_id/attachment-stages/:stage_id",
                get(handle_get_message_attachment_stage)
                    .delete(handle_cancel_message_attachment_stage),
            )
            .route(
                "/api/sessions/:session_id/attachment-stages/:stage_id/content",
                axum::routing::put(handle_upload_message_attachment_stage),
            )
            .route(
                "/api/sessions/:session_id/dialogue-turns/:root_turn_id/retry",
                post(handle_retry_dialogue_turn),
            )
            .route(
                "/api/sessions/:session_id/principal",
                post(handle_bind_session_principal),
            )
            .route(
                "/api/sessions/:session_id/events",
                get(handle_get_session_events),
            )
            .route(
                "/api/sessions/:session_id/events/:event_id/attachments/:attachment_id",
                get(handle_get_session_event_attachment),
            )
            .route(
                "/api/sessions/:session_id/context",
                get(handle_get_session_context),
            )
            .route(
                "/api/sessions/:session_id/context/projection",
                get(handle_get_session_context_projection),
            )
            .route(
                "/api/sessions/:session_id/context/encoding",
                get(handle_get_session_context_encoding),
            )
            .route(
                "/api/sessions/:session_id/cancel",
                post(handle_cancel_session),
            )
            .route("/api/delegations", get(handle_list_delegations))
            .route("/api/objectives", post(handle_create_objective))
            .route(
                "/api/objectives/:objective_id/resume",
                post(handle_resume_objective),
            )
            .route(
                "/api/objectives/:objective_id/pause",
                post(handle_pause_objective),
            )
            .route(
                "/api/objectives/:objective_id",
                patch(handle_edit_objective).delete(handle_delete_objective),
            )
            .route(
                "/api/delegations/:delegation_id",
                get(handle_get_delegation),
            )
            .route(
                "/api/delegations/:delegation_id/cancel",
                post(handle_cancel_delegation),
            )
            .route("/api/approvals", get(handle_list_approvals))
            .route("/api/approvals/:approval_id", post(handle_decide_approval))
            .route("/api/schedules/:schedule_id", post(handle_mutate_schedule))
            .route("/ws", get(handle_ws_upgrade))
            .fallback(handle_dashboard_fallback)
            .layer(DefaultBodyLimit::max(dashboard_body_limit))
            .layer(middleware::from_fn(normalize_api_error_responses))
            .layer(middleware::from_fn_with_state(
                Arc::clone(&state),
                observe_http_requests,
            ))
            .layer(CompressionLayer::new())
            .layer(cors)
            .with_state(Arc::clone(&state));

        let listener = tokio::net::TcpListener::bind(addr).await?;
        tracing::info!(
            addr = %addr,
            dashboard_body_limit_bytes = dashboard_body_limit,
            event_code = "web.dashboard_api.started",
            "Dashboard API Server started"
        );

        tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, app).await {
                tracing::error!(event_code = "web.axum.run_failed", error = ?e, "Web Server Axum runtime failed");
            }
        });

        Ok(())
    }
}

fn is_loopback_web_origin(origin: &header::HeaderValue) -> bool {
    let Some(host) = origin
        .to_str()
        .ok()
        .and_then(|value| value.parse::<Uri>().ok())
        .and_then(|uri| uri.host().map(str::to_string))
    else {
        return false;
    };
    let host = host.trim_matches(['[', ']']);
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn embedded_asset(content_type: &'static str, body: &'static [u8]) -> Response {
    Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from(body))
        .expect("embedded Dashboard response must be valid")
}

fn invalid_dashboard_base_path(message: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidInput, message)
}

fn normalize_dashboard_base_path(value: &str) -> Result<String, std::io::Error> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed == "/" {
        return Ok("/".to_string());
    }
    if !trimmed.starts_with('/') {
        return Err(invalid_dashboard_base_path(
            "MORPHZ_DASHBOARD_BASE_PATH must start with '/'",
        ));
    }
    if trimmed.chars().any(|character| {
        !(character.is_ascii_alphanumeric()
            || matches!(character, '/' | '-' | '_' | '.' | '~' | '%'))
    }) {
        return Err(invalid_dashboard_base_path(
            "MORPHZ_DASHBOARD_BASE_PATH contains a character that is unsafe in an HTML base URL",
        ));
    }
    if trimmed
        .split('/')
        .any(|segment| matches!(segment, "." | ".."))
    {
        return Err(invalid_dashboard_base_path(
            "MORPHZ_DASHBOARD_BASE_PATH cannot contain dot segments",
        ));
    }

    let mut normalized = String::with_capacity(trimmed.len() + 1);
    for segment in trimmed.split('/').filter(|segment| !segment.is_empty()) {
        normalized.push('/');
        normalized.push_str(segment);
    }
    normalized.push('/');
    Ok(normalized)
}

fn configured_dashboard_base_path() -> Result<String, std::io::Error> {
    let value = std::env::var("MORPHZ_DASHBOARD_BASE_PATH").unwrap_or_else(|_| "/".to_string());
    normalize_dashboard_base_path(&value)
}

fn dashboard_index_html(base_path: &str) -> String {
    let index =
        std::str::from_utf8(DASHBOARD_INDEX).expect("embedded Dashboard index must be valid UTF-8");
    let replacement = format!("<base href=\"{base_path}\">");
    if index.contains("<base href=\"/\">") {
        index.replacen("<base href=\"/\">", &replacement, 1)
    } else {
        index.replacen("<base href=\"/\" />", &replacement, 1)
    }
}

async fn handle_dashboard_index() -> Response {
    let base_path = configured_dashboard_base_path().unwrap_or_else(|_| "/".to_string());
    Response::builder()
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from(dashboard_index_html(&base_path)))
        .expect("embedded Dashboard response must be valid")
}

async fn handle_dashboard_fallback(uri: Uri) -> Response {
    if uri.path().starts_with("/api/") || uri.path() == "/api" || uri.path() == "/ws" {
        return error_response(StatusCode::NOT_FOUND, "API route does not exist");
    }
    handle_dashboard_index().await
}

async fn normalize_api_error_responses(request: Request, next: Next) -> Response {
    let path = request.uri().path().to_string();
    normalize_api_error_response(&path, next.run(request).await)
}

async fn observe_http_requests(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    let started = std::time::Instant::now();
    let method = request.method().as_str().to_string();
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(|path| path.as_str().to_string())
        .unwrap_or_else(|| "__unmatched__".to_string());
    let trace_id = request
        .headers()
        .get("x-morphz-trace-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| valid_trace_id(value))
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| state.runtime.observability().next_trace_id());
    let mut response = next.run(request).await;
    let status = response.status();
    let status_class = format!("{}xx", status.as_u16() / 100);
    let duration = started.elapsed();
    state
        .runtime
        .observability()
        .record_http_request(&method, &route, &status_class, duration);
    if !response.headers().contains_key("x-morphz-trace-id") {
        if let Ok(value) = HeaderValue::from_str(&trace_id) {
            response.headers_mut().insert("x-morphz-trace-id", value);
        }
    }
    tracing::info!(
        trace_id,
        method,
        route,
        status = status.as_u16(),
        duration_micros = u64::try_from(duration.as_micros()).unwrap_or(u64::MAX),
        event_code = "observability.http_request.completed",
        "Morphz HTTP request completed"
    );
    response
}

fn valid_trace_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

/// Axum extractor and method-routing rejections happen before a handler can
/// call `error_response`. Keep those framework-generated failures inside the
/// same public JSON contract without rewriting successful or already
/// structured responses.
fn normalize_api_error_response(path: &str, response: Response) -> Response {
    let is_api = path == "/api" || path.starts_with("/api/");
    if !is_api || !(response.status().is_client_error() || response.status().is_server_error()) {
        return response;
    }
    let is_json = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"));
    if is_json {
        return response;
    }

    let status = response.status();
    let allow = response.headers().get(header::ALLOW).cloned();
    let retry_after = response.headers().get(header::RETRY_AFTER).cloned();
    let authenticate = response.headers().get(header::WWW_AUTHENTICATE).cloned();
    let message = match status {
        StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY => "Invalid request",
        StatusCode::METHOD_NOT_ALLOWED => "Method is not allowed for this API route",
        StatusCode::PAYLOAD_TOO_LARGE => "Request body exceeds the configured limit",
        StatusCode::UNSUPPORTED_MEDIA_TYPE => "Unsupported request content type",
        _ if status.is_server_error() => "Unhandled API failure",
        _ => status.canonical_reason().unwrap_or("Request failed"),
    };
    let mut normalized = error_response(status, message);
    for (name, value) in [
        (header::ALLOW, allow),
        (header::RETRY_AFTER, retry_after),
        (header::WWW_AUTHENTICATE, authenticate),
    ] {
        if let Some(value) = value {
            normalized.headers_mut().insert(name, value);
        }
    }
    normalized
}

async fn handle_dashboard_app_js() -> Response {
    embedded_asset("text/javascript; charset=utf-8", DASHBOARD_APP_JS)
}

async fn handle_dashboard_app_css() -> Response {
    embedded_asset("text/css; charset=utf-8", DASHBOARD_APP_CSS)
}

async fn handle_dashboard_favicon() -> Response {
    embedded_asset("image/svg+xml", DASHBOARD_FAVICON)
}

async fn handle_dashboard_icons() -> Response {
    embedded_asset("image/svg+xml", DASHBOARD_ICONS)
}

#[derive(serde::Serialize)]
struct DashboardStatusResponse {
    #[serde(flatten)]
    runtime: crate::runtime::RuntimeStatus,
    api_contract_version: &'static str,
    sdk_contract_version: &'static str,
    identity_mode: ServerIdentityMode,
    identity_provider_id: String,
}

async fn handle_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let mut status = state.sdk.runtime_status();
    match state.runtime.inference_model_options().await {
        Ok(options) => {
            status.models = options.iter().map(|option| option.id.clone()).collect();
            status.model_options = options;
        }
        Err(error) => {
            status.models.clear();
            status.model_catalog_error = Some(error.to_string());
        }
    }
    Json(DashboardStatusResponse {
        runtime: status,
        api_contract_version: "1",
        sdk_contract_version: crate::sdk::SDK_CONTRACT_VERSION,
        identity_mode: state.identity.mode,
        identity_provider_id: state.identity.provider_id.clone(),
    })
    .into_response()
}

async fn handle_prometheus_metrics(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> Response {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    Response::builder()
        .status(StatusCode::OK)
        .header(
            header::CONTENT_TYPE,
            "text/plain; version=0.0.4; charset=utf-8",
        )
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(state.runtime.prometheus_metrics()))
        .expect("Prometheus metrics response must be valid")
}

async fn handle_recent_turn_traces(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<ObservabilityQuery>,
) -> Response {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let limit = query.limit.unwrap_or(50).clamp(1, 512);
    let turns = state.runtime.observability().recent_turns(limit);
    Json(json!({
        "turns": turns,
        "retention": "process_local_bounded",
        "limit": limit,
    }))
    .into_response()
}

async fn handle_turn_trace(
    State(state): State<Arc<AppState>>,
    Path(root_turn_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> Response {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state.runtime.observability().turn(&root_turn_id) {
        Some(turn) => Json(turn).into_response(),
        None => error_response(
            StatusCode::NOT_FOUND,
            format!("No retained observability timeline exists for turn '{root_turn_id}'"),
        ),
    }
}

async fn handle_get_system_prompt(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let inspection = match crate::orchestrator::orchestrator::production_system_prompt_inspection()
    {
        Ok(inspection) => inspection,
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error),
    };
    let bytes = inspection.content.as_bytes();
    let sha256 = format!("sha256:{:x}", Sha256::digest(bytes));
    Json(json!({
        "profile": inspection.profile,
        "content": inspection.content,
        "sha256": sha256,
        "bytes": bytes.len(),
        "chars": inspection.content.chars().count(),
        "stable": true,
    }))
    .into_response()
}

async fn handle_list_managed_secrets(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let sdk = state.sdk.clone();
    match tokio::task::spawn_blocking(move || {
        let secrets = sdk
            .list_managed_secrets()
            .map_err(|error| error.to_string())?;
        let import_candidates = sdk
            .secret_import_candidates()
            .map_err(|error| error.to_string())?;
        let recent_usage = sdk
            .recent_secret_usage(100)
            .map_err(|error| error.to_string())?;
        Ok::<_, String>(json!({
            "secrets": secrets,
            "default_value_backend": sdk.secret_backend_id(),
            "backends": sdk.secret_backend_statuses(),
            "import_candidates": import_candidates,
            "recent_usage": recent_usage,
        }))
    })
    .await
    {
        Ok(Ok(response)) => Json(response).into_response(),
        Ok(Err(error)) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error),
        Err(error) => error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Secret Store worker failed: {error}"),
        ),
    }
}

async fn handle_put_managed_secret(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<PutManagedSecretRequest>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let PutManagedSecretRequest {
        name,
        value,
        scope_kind,
        scope_id,
        value_backend,
    } = request;
    let sdk = state.sdk.clone();
    let name = name.trim().to_string();
    let value = zeroize::Zeroizing::new(value);
    let scope_id = scope_id.map(|id| id.trim().to_string());
    match tokio::task::spawn_blocking(move || match value_backend.as_deref() {
        Some(value_backend) => sdk.put_managed_secret_with_backend(
            &name,
            value.as_str(),
            scope_kind,
            scope_id,
            value_backend,
        ),
        None => sdk.put_managed_secret(&name, value.as_str(), scope_kind, scope_id),
    })
    .await
    {
        Ok(Ok(secret)) => (StatusCode::CREATED, Json(secret)).into_response(),
        Ok(Err(error)) => error_response(StatusCode::BAD_REQUEST, error.to_string()),
        Err(error) => error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Secret Store worker failed: {error}"),
        ),
    }
}

async fn handle_import_managed_secret(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<ImportManagedSecretRequest>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let sdk = state.sdk.clone();
    let name = request.name.trim().to_string();
    let scope_id = request.scope_id.map(|id| id.trim().to_string());
    let value_backend = request.value_backend;
    match tokio::task::spawn_blocking(move || {
        sdk.import_managed_secret(&name, request.scope_kind, scope_id, &value_backend)
    })
    .await
    {
        Ok(Ok(secret)) => (StatusCode::CREATED, Json(secret)).into_response(),
        Ok(Err(error)) => error_response(StatusCode::BAD_REQUEST, error.to_string()),
        Err(error) => error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Secret Store worker failed: {error}"),
        ),
    }
}

async fn handle_secret_scope_options(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let contexts = match state.runtime.list_contexts(true).await {
        Ok(contexts) => contexts,
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let sessions = match state.runtime.list_sessions(true).await {
        Ok(sessions) => sessions,
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let targets = match state
        .runtime
        .list_execution_targets(crate::memory::ExecutionTargetFilter {
            limit: Some(1_000),
            ..Default::default()
        })
        .await
    {
        Ok(targets) => targets,
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let mut objectives = Vec::new();
    for context in contexts
        .iter()
        .filter(|context| context.status == crate::memory::SessionStatus::Active)
    {
        match state
            .runtime
            .list_context_objectives(&context.id, false)
            .await
        {
            Ok(mut records) => objectives.append(&mut records),
            Err(error) => {
                return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
            }
        }
    }
    Json(json!({
        "contexts": contexts,
        "sessions": sessions,
        "objectives": objectives,
        "execution_targets": targets,
    }))
    .into_response()
}

async fn handle_delete_managed_secret(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let sdk = state.sdk.clone();
    match tokio::task::spawn_blocking(move || sdk.delete_managed_secret(&name)).await {
        Ok(Ok(true)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Ok(false)) => error_response(StatusCode::NOT_FOUND, "managed credential does not exist"),
        Ok(Err(error)) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        Err(error) => error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Secret Store worker failed: {error}"),
        ),
    }
}

async fn handle_provider_control_snapshot(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    if let Some(path) = state.managed_config_path.as_deref() {
        if let Err(error) = state.sdk.prune_unfinished_oauth_accounts(path).await {
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    }
    match state.sdk.provider_control_snapshot().await {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn handle_discover_provider_models(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<DiscoverProviderModelsRequest>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state
        .sdk
        .discover_provider_models(request.protocol, &request.base_url, &request.api_key)
        .await
    {
        Ok(models) => Json(DiscoverProviderModelsResponse { models }).into_response(),
        Err(error) => error_response(StatusCode::BAD_REQUEST, error.message),
    }
}

async fn handle_recent_provider_attempts(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<ProviderAttemptsQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state
        .sdk
        .recent_provider_attempts(query.limit.unwrap_or(50))
        .await
    {
        Ok(records) => Json(records).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn handle_diagnose_model_route(
    State(state): State<Arc<AppState>>,
    Path(route_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<ModelRouteDiagnosticRequest>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state
        .sdk
        .diagnose_model_route(&route_id, request.account_id.as_deref())
        .await
    {
        Ok(diagnostic) => Json(diagnostic).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_refresh_model_catalog(
    State(state): State<Arc<AppState>>,
    Path(route_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<ModelRouteDiagnosticRequest>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state
        .sdk
        .refresh_model_catalog(&route_id, request.account_id.as_deref())
        .await
    {
        Ok(diagnostic) => Json(diagnostic).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_diagnose_provider_account(
    State(state): State<Arc<AppState>>,
    Path(account_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<ProviderAccountDiagnosticRequest>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state
        .sdk
        .diagnose_provider_account(&account_id, request.model.as_deref())
        .await
    {
        Ok(diagnostic) => Json(diagnostic).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_provider_subscription_usage(
    State(state): State<Arc<AppState>>,
    Path(account_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state.sdk.provider_subscription_usage(&account_id).await {
        Ok(usage) => Json(usage).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_refresh_provider_account_catalog(
    State(state): State<Arc<AppState>>,
    Path(account_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<ProviderAccountDiagnosticRequest>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state
        .sdk
        .refresh_provider_account_catalog(&account_id, request.model.as_deref())
        .await
    {
        Ok(diagnostic) => Json(diagnostic).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_put_provider_instance_config(
    State(state): State<Arc<AppState>>,
    Path(provider_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(provider): Json<ProviderInstanceConfig>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let Some(path) = state.managed_config_path.as_deref() else {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot determine Morphz model configuration path",
        );
    };
    match state
        .sdk
        .put_provider_instance_config(path, &provider_id, provider)
        .await
    {
        Ok(receipt) => Json(receipt).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn bind_dashboard_default_agent_provider_account(
    state: &AppState,
    account_id: &str,
) -> Result<(), SdkError> {
    let agent_exists = state
        .runtime
        .get_agent(&state.default_agent_id)
        .await
        .map_err(|error| SdkError::new(SdkErrorCode::Internal, error.to_string()))?
        .is_some();
    if !agent_exists {
        // Some embedded hosts construct the HTTP surface before Runtime
        // start. Startup's legacy-policy adoption will bind the saved account
        // once the default Agent is materialized.
        return Ok(());
    }
    state
        .sdk
        .bind_agent_provider_account(&state.default_agent_id, account_id)
        .await
        .map(|_| ())
}

async fn handle_put_provider_catalog_setup(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<PutProviderCatalogSetupRequest>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let Some(path) = state.managed_config_path.as_deref() else {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot determine Morphz managed configuration path",
        );
    };
    let account_id_for_binding = request.account_id.trim().to_string();
    let credential = match (request.credential_id.as_deref(), request.credential) {
        (Some(id), Some(config)) => Some((id, config)),
        (None, None) => None,
        _ => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "credential_id and credential must be provided or omitted together",
            )
        }
    };
    if request.managed_secret.is_some() && credential.is_none() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "managed_secret may be submitted only with credential_id and credential",
        );
    }
    if let (Some(secret), Some((credential_id, credential_config))) =
        (request.managed_secret.as_ref(), credential.as_ref())
    {
        let secret_name = secret.name.trim();
        if request.account.credential_ref.trim() != *credential_id
            || credential_config.source != crate::config::CredentialSource::Env
            || credential_config.name.as_deref().map(str::trim) != Some(secret_name)
        {
            return error_response(
                StatusCode::BAD_REQUEST,
                "managed_secret, credential, and account credential_ref must reference the same credential",
            );
        }
        if secret.scope_kind != crate::secret_store::SecretScopeKind::Runtime
            || secret.scope_id.is_some()
        {
            return error_response(
                StatusCode::BAD_REQUEST,
                "Provider API Key must use Runtime scope and must not set scope_id",
            );
        }
        if request.account.secret_backend.as_deref() != secret.value_backend.as_deref() {
            return error_response(
                StatusCode::BAD_REQUEST,
                "managed_secret value_backend must match the account secret_backend",
            );
        }
    }
    let created_secret_name = if let Some(secret) = request.managed_secret {
        let sdk = state.sdk.clone();
        match tokio::task::spawn_blocking(move || {
            let name = secret.name.trim().to_string();
            if sdk
                .list_managed_secrets()?
                .iter()
                .any(|existing| existing.name == name)
            {
                return Err(SdkError::new(
                    SdkErrorCode::InvalidArgument,
                    format!("managed credential '{name}' already exists; first-time setup refuses to overwrite it"),
                ));
            }
            let value = zeroize::Zeroizing::new(secret.value);
            let scope_id = secret.scope_id.map(|id| id.trim().to_string());
            match secret.value_backend.as_deref() {
                Some(value_backend) => sdk.put_managed_secret_with_backend(
                    &name,
                    value.as_str(),
                    secret.scope_kind,
                    scope_id,
                    value_backend,
                ),
                None => sdk.put_managed_secret(&name, value.as_str(), secret.scope_kind, scope_id),
            }?;
            Ok(name)
        })
        .await
        {
            Ok(Ok(name)) => Some(name),
            Ok(Err(error)) => return sdk_error_response(error),
            Err(error) => {
                return error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Secret Store worker failed: {error}"),
                )
            }
        }
    } else {
        None
    };
    let result = state
        .sdk
        .put_provider_catalog_config(
            path,
            request.provider_id.trim(),
            request.provider,
            &account_id_for_binding,
            request.account,
            credential,
            request.route_id.trim(),
            request.route,
        )
        .await;
    match result {
        Ok(receipt) => match bind_dashboard_default_agent_provider_account(
            state.as_ref(),
            &account_id_for_binding,
        )
        .await
        {
            Ok(_) => Json(receipt).into_response(),
            Err(error) => sdk_error_response(error),
        },
        Err(error) => {
            if let Some(name) = created_secret_name {
                let sdk = state.sdk.clone();
                let rollback_name = name.clone();
                match tokio::task::spawn_blocking(move || sdk.delete_managed_secret(&rollback_name))
                    .await
                {
                    Ok(Ok(true)) => {}
                    Ok(Ok(false)) => {
                        return error_response(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            format!(
                                "Provider setup failed ({}), and newly created credential '{}' could not be rolled back because it does not exist",
                                error.message, name
                            ),
                        )
                    }
                    Ok(Err(rollback_error)) => {
                        return error_response(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            format!(
                                "Provider setup failed ({}), and rollback of newly created credential '{}' failed: {}",
                                error.message, name, rollback_error
                            ),
                        )
                    }
                    Err(rollback_error) => {
                        return error_response(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            format!(
                                "Provider setup failed ({}), and the Secret Store rollback worker failed: {}",
                                error.message, rollback_error
                            ),
                        )
                    }
                }
            }
            sdk_error_response(error)
        }
    }
}

async fn handle_put_auth_account_config(
    State(state): State<Arc<AppState>>,
    Path(account_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(account): Json<AuthAccountConfig>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let Some(path) = state.managed_config_path.as_deref() else {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot determine Morphz managed configuration path",
        );
    };
    match state
        .sdk
        .put_auth_account_config(path, &account_id, account)
        .await
    {
        Ok(receipt) => {
            match bind_dashboard_default_agent_provider_account(state.as_ref(), &account_id).await {
                Ok(_) => Json(receipt).into_response(),
                Err(error) => sdk_error_response(error),
            }
        }
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_put_provider_account_models(
    State(state): State<Arc<AppState>>,
    Path(account_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<PutProviderAccountModelsRequest>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let Some(path) = state.managed_config_path.as_deref() else {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot determine Morphz managed configuration path",
        );
    };
    let mut models = BTreeMap::new();
    let mut display_aliases = BTreeMap::new();
    for selection in request.models {
        let id = selection.id.trim().to_string();
        if id.is_empty() || models.contains_key(&id) {
            return error_response(
                StatusCode::BAD_REQUEST,
                "model IDs must not be empty or duplicated",
            );
        }
        let display_alias = selection
            .alias
            .and_then(|alias| (!alias.trim().is_empty()).then_some(alias));
        display_aliases.insert(id.clone(), display_alias);
        let prompt_cache_strategy = selection.prompt_cache_strategy.unwrap_or_default();
        if prompt_cache_strategy == crate::config::PromptCacheStrategy::ExperimentalStructuredDeltas
            && !cfg!(feature = "experimental-structured-context-delta-cache")
        {
            return error_response(
                StatusCode::BAD_REQUEST,
                "experimental-structured-deltas requires a Morphz build with feature experimental-structured-context-delta-cache",
            );
        }
        models.insert(
            id,
            ProviderModelConfig {
                prompt_cache_strategy,
                context_window_tokens: selection.context_window_tokens,
                max_input_tokens: selection.max_input_tokens,
                max_output_tokens: selection.max_output_tokens,
                max_input_attachments: selection.max_input_attachments,
                max_input_attachment_bytes: selection.max_input_attachment_bytes,
                max_input_attachment_total_bytes: selection.max_input_attachment_total_bytes,
            },
        );
    }
    match state
        .sdk
        .put_provider_account_models(path, &account_id, models, display_aliases)
        .await
    {
        Ok(receipt) => Json(receipt).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_put_model_route_config(
    State(state): State<Arc<AppState>>,
    Path(route_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(route): Json<ModelRouteConfig>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let Some(path) = state.managed_config_path.as_deref() else {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot determine Morphz managed configuration path",
        );
    };
    match state
        .sdk
        .put_model_route_config(path, &route_id, route)
        .await
    {
        Ok(receipt) => Json(receipt).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_update_auto_review_model(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<UpdateAutoReviewModelRequest>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let Some(path) = state.core_config_path.as_deref() else {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot determine Morphz core configuration path",
        );
    };
    match state.sdk.put_auto_review_model(path, request.model) {
        Ok(receipt) => Json(receipt).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_update_evaluation_model_policy(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<UpdateEvaluationModelPolicyRequest>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let Some(path) = state.managed_config_path.as_deref() else {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot determine Morphz managed model configuration path",
        );
    };
    match state
        .sdk
        .put_evaluation_model_policy(
            path,
            &request.primary_model,
            request.allowed_evaluation_models,
        )
        .await
    {
        Ok(receipt) => Json(receipt).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_control_provider_account(
    State(state): State<Arc<AppState>>,
    Path(account_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<ControlProviderAccountRequest>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state
        .sdk
        .control_provider_account(&account_id, request.expected_revision, request.action)
        .await
    {
        Ok(record) => Json(record).into_response(),
        Err(error) => error_response(StatusCode::CONFLICT, error.to_string()),
    }
}

async fn handle_delete_provider_account(
    State(state): State<Arc<AppState>>,
    Path(account_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let Some(path) = state.managed_config_path.as_deref() else {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot determine Morphz managed configuration path",
        );
    };
    let bindings = match state
        .runtime
        .provider_account_agent_bindings(&account_id)
        .await
    {
        Ok(bindings) => bindings,
        Err(error) => {
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    };
    let non_default_agent_ids = bindings
        .iter()
        .filter(|binding| binding.agent_id != state.default_agent_id)
        .map(|binding| binding.agent_id.as_str())
        .collect::<Vec<_>>();
    if !non_default_agent_ids.is_empty() {
        return error_response(
            StatusCode::CONFLICT,
            format!(
                "Auth Account '{account_id}' is shared by Agent(s): {}; remove those Agent bindings before deleting the account",
                non_default_agent_ids.join(", ")
            ),
        );
    }
    let default_agent_was_bound = bindings
        .iter()
        .any(|binding| binding.agent_id == state.default_agent_id);
    if default_agent_was_bound {
        if let Err(error) = state
            .sdk
            .unbind_agent_provider_account(&state.default_agent_id, &account_id)
            .await
        {
            return sdk_error_response(error);
        }
    }

    match state
        .sdk
        .delete_auth_account_config(path, &account_id)
        .await
    {
        Ok(receipt) => Json(receipt).into_response(),
        Err(error) => {
            if default_agent_was_bound {
                if let Err(restore_error) = state
                    .sdk
                    .bind_agent_provider_account(&state.default_agent_id, &account_id)
                    .await
                {
                    return error_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!(
                            "{error}; additionally failed to restore the default Agent binding: {restore_error}"
                        ),
                    );
                }
            }
            sdk_error_response(error)
        }
    }
}

fn oauth_provider_setup(service: &str) -> Result<OAuthProviderSetup, &'static str> {
    let account_id = api_id("account");
    let credential_ref = format!(
        "MORPHZ_OAUTH_{}",
        account_id
            .chars()
            .map(|ch| if ch.is_ascii_alphanumeric() {
                ch.to_ascii_uppercase()
            } else {
                '_'
            })
            .collect::<String>()
    );
    let setup = match service.trim() {
        "codex" | "codex-device" => OAuthProviderSetup {
            provider_id: "codex-subscription".to_string(),
            provider_adapter: "openai-codex".to_string(),
            protocol: ModelProtocol::OpenaiResponses,
            base_url: "https://chatgpt.com/backend-api/codex".to_string(),
            account_id,
            auth_adapter: "codex-oauth".to_string(),
            login_adapter: Some(if service.trim() == "codex-device" {
                "codex-device-oauth".to_string()
            } else {
                "codex-oauth".to_string()
            }),
            credential_ref,
            secret_backend: Some("morphz_env_file".to_string()),
            account_label: "Codex".to_string(),
        },
        "kimi" => OAuthProviderSetup {
            provider_id: "kimi-code".to_string(),
            provider_adapter: "kimi-code".to_string(),
            protocol: ModelProtocol::OpenaiChat,
            base_url: "https://api.kimi.com/coding/v1".to_string(),
            account_id,
            auth_adapter: "kimi-oauth".to_string(),
            login_adapter: None,
            credential_ref,
            secret_backend: Some("morphz_env_file".to_string()),
            account_label: "Kimi".to_string(),
        },
        "claude" | "anthropic" => OAuthProviderSetup {
            provider_id: "claude-subscription".to_string(),
            provider_adapter: "claude-code".to_string(),
            protocol: ModelProtocol::AnthropicMessages,
            base_url: "https://api.anthropic.com/v1".to_string(),
            account_id,
            auth_adapter: "claude-oauth".to_string(),
            login_adapter: None,
            credential_ref,
            secret_backend: Some("morphz_env_file".to_string()),
            account_label: "Claude".to_string(),
        },
        "antigravity" => OAuthProviderSetup {
            provider_id: "antigravity-subscription".to_string(),
            provider_adapter: "google-antigravity".to_string(),
            protocol: ModelProtocol::GeminiContent,
            base_url: crate::provider::ANTIGRAVITY_DAILY_BASE_URL.to_string(),
            account_id,
            auth_adapter: "antigravity-oauth".to_string(),
            login_adapter: None,
            credential_ref,
            secret_backend: Some("morphz_env_file".to_string()),
            account_label: "Antigravity".to_string(),
        },
        "xai" => OAuthProviderSetup {
            provider_id: "xai-subscription".to_string(),
            provider_adapter: "xai-subscription".to_string(),
            protocol: ModelProtocol::OpenaiResponses,
            base_url: "https://cli-chat-proxy.grok.com/v1".to_string(),
            account_id,
            auth_adapter: "xai-oauth".to_string(),
            login_adapter: None,
            credential_ref,
            secret_backend: Some("morphz_env_file".to_string()),
            account_label: "xAI".to_string(),
        },
        _ => return Err("this OAuth service is not integrated with Runtime"),
    };
    Ok(setup)
}

fn oauth_provider_setup_service_descriptors() -> Vec<OAuthProviderSetupServiceDescriptor> {
    vec![
        OAuthProviderSetupServiceDescriptor {
            id: "codex",
            auth_adapter: "codex-oauth",
        },
        OAuthProviderSetupServiceDescriptor {
            id: "kimi",
            auth_adapter: "kimi-oauth",
        },
        OAuthProviderSetupServiceDescriptor {
            id: "anthropic",
            auth_adapter: "claude-oauth",
        },
        OAuthProviderSetupServiceDescriptor {
            id: "antigravity",
            auth_adapter: "antigravity-oauth",
        },
        OAuthProviderSetupServiceDescriptor {
            id: "xai",
            auth_adapter: "xai-oauth",
        },
    ]
}

async fn handle_oauth_provider_setup_services(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let registered = state
        .sdk
        .provider_oauth_adapter_descriptors()
        .into_iter()
        .map(|adapter| adapter.id)
        .collect::<HashSet<_>>();
    Json(OAuthProviderSetupServicesResponse {
        services: oauth_provider_setup_service_descriptors()
            .into_iter()
            .filter(|service| registered.contains(service.auth_adapter))
            .collect(),
    })
    .into_response()
}

async fn handle_start_oauth_provider_setup(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<StartOAuthProviderSetupRequest>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let Some(path) = state.managed_config_path.as_deref() else {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot determine Morphz managed configuration path",
        );
    };
    let setup = match oauth_provider_setup(&request.service) {
        Ok(setup) => setup,
        Err(message) => return error_response(StatusCode::BAD_REQUEST, message),
    };
    match state.sdk.setup_oauth_provider_account(path, setup).await {
        Ok(challenge) => (StatusCode::CREATED, Json(challenge)).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

/// Public OAuth redirect endpoint for web-client credentials registered to the
/// Runtime's public URL. It intentionally does not require the Dashboard bearer
/// token: the short-lived, unguessable state is the callback capability, and
/// unknown/expired states are rejected before any payload is retained.
async fn handle_provider_oauth_callback(Query(query): Query<OAuthCallbackQuery>) -> Response {
    let error = query
        .error_description
        .filter(|value| !value.trim().is_empty())
        .or_else(|| query.error.filter(|value| !value.trim().is_empty()));
    let success = error.is_none()
        && query
            .code
            .as_deref()
            .is_some_and(|code| !code.trim().is_empty());
    let submitted = submit_oauth_callback(&query.state, query.code, error);
    let (status, title, detail) = match submitted {
        Ok(()) if success => (
            StatusCode::OK,
            "Morphz login complete",
            "The credential was delivered securely to Runtime. You may close this page.",
        ),
        Ok(()) => (
            StatusCode::BAD_REQUEST,
            "Morphz login failed",
            "The authorization service returned an error. Return to the Dashboard for details.",
        ),
        Err(_) => (
            StatusCode::BAD_REQUEST,
            "Morphz login expired",
            "This authorization request does not exist or has expired. Return to the Dashboard and log in again.",
        ),
    };
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>{title}</title><style>body{{font:16px system-ui;margin:10vh auto;max-width:34rem;padding:2rem;color:#20222a}}h1{{font-size:1.5rem}}</style><h1>{title}</h1><p>{detail}</p>"
    );
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(body))
        .expect("OAuth callback response must be valid")
}

/// Authenticated remote-browser handoff. Unlike the account-specific
/// continuation endpoint, this resolves the original in-memory login context
/// from the callback's own state. A page refresh or a newer dialog therefore
/// cannot route a valid authorization code to the wrong PKCE verifier.
async fn handle_submit_provider_oauth_callback(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<SubmitOAuthCallbackRequest>,
) -> Response {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let (_, callback_state) = match parse_authorization_response(&request.redirect_url) {
        Ok(callback) => callback,
        Err(error) => return error_response(StatusCode::BAD_REQUEST, error),
    };
    let login_id = match oauth_callback_login_id(&callback_state) {
        Ok(login_id) => login_id,
        Err(error) => return error_response(StatusCode::BAD_REQUEST, error),
    };
    match state
        .sdk
        .continue_provider_oauth_login(
            &login_id,
            OAuthLoginCompletion::AuthorizationResponse {
                response: request.redirect_url,
            },
        )
        .await
    {
        Ok(progress) => {
            if let OAuthLoginProgress::Complete { account } = &progress {
                if let Err(error) = bind_dashboard_default_agent_provider_account(
                    state.as_ref(),
                    &account.account_id,
                )
                .await
                {
                    return sdk_error_response(error);
                }
            }
            Json(SubmitOAuthCallbackResponse { login_id, progress }).into_response()
        }
        Err(error) => error_response(StatusCode::BAD_REQUEST, error.message),
    }
}

async fn handle_start_provider_oauth_login(
    State(state): State<Arc<AppState>>,
    Path(account_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state.sdk.start_provider_oauth_login(&account_id).await {
        Ok(challenge) => (StatusCode::CREATED, Json(challenge)).into_response(),
        Err(error) => error_response(StatusCode::BAD_REQUEST, error.to_string()),
    }
}

async fn handle_start_provider_oauth_login_using(
    State(state): State<Arc<AppState>>,
    Path((account_id, adapter_id)): Path<(String, String)>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state
        .sdk
        .start_provider_oauth_login_using(&account_id, &adapter_id)
        .await
    {
        Ok(challenge) => (StatusCode::CREATED, Json(challenge)).into_response(),
        Err(error) => error_response(StatusCode::BAD_REQUEST, error.message),
    }
}

async fn handle_continue_provider_oauth_login(
    State(state): State<Arc<AppState>>,
    Path(login_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(completion): Json<OAuthLoginCompletion>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state
        .sdk
        .continue_provider_oauth_login(&login_id, completion)
        .await
    {
        Ok(progress) => {
            if let OAuthLoginProgress::Complete { account } = &progress {
                if let Err(error) = bind_dashboard_default_agent_provider_account(
                    state.as_ref(),
                    &account.account_id,
                )
                .await
                {
                    return sdk_error_response(error);
                }
            }
            Json(progress).into_response()
        }
        Err(error) => error_response(StatusCode::BAD_REQUEST, error.message),
    }
}

async fn handle_cancel_provider_oauth_login(
    State(state): State<Arc<AppState>>,
    Path(login_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state.sdk.cancel_provider_oauth_login(&login_id) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(error) => error_response(StatusCode::BAD_REQUEST, error.message),
    }
}

async fn handle_logout_provider_oauth_account(
    State(state): State<Arc<AppState>>,
    Path(account_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state.sdk.logout_provider_oauth_account(&account_id).await {
        Ok(deleted) => Json(json!({ "deleted": deleted })).into_response(),
        Err(error) => error_response(StatusCode::BAD_REQUEST, error.to_string()),
    }
}

async fn handle_search_recall(
    State(state): State<Arc<AppState>>,
    Path(context_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<RecallSearchHttpQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let query_text = query.query.unwrap_or_default();
    if query_text.trim().is_empty() && query.start_time.is_none() && query.end_time.is_none() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "query or time range must not be empty",
        );
    }
    match state
        .runtime
        .search_recall(RecallSearchRequest {
            context_id,
            query: query_text,
            start_time: query.start_time,
            end_time: query.end_time,
            limit: query.limit.unwrap_or(20).clamp(1, 100),
            cursor: query.cursor,
            view_manifest: None,
        })
        .await
    {
        Ok(page) => Json(page).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

/// Search the human-facing transcript rather than the complete Event History.
///
/// Recall remains the lexical candidate engine, but this read model only
/// admits persisted messages which can actually be opened in Dialogue. Frame,
/// transaction, diagnostic, raw tool and scheduler Events never leak into the
/// result set.
async fn handle_search_dialogue_history(
    State(state): State<Arc<AppState>>,
    Path(context_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<DialogueHistorySearchHttpQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_read_principal(
        &state,
        &headers,
        query.token.as_deref(),
        query.principal_id.as_deref(),
    ) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    let query_text = query.query.trim();
    if query_text.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "query must not be empty");
    }
    let limit = query.limit.unwrap_or(30).clamp(1, 100);
    let visible_session_ids = match state.sdk.list_sessions(&principal.principal_id, true).await {
        Ok(sessions) => sessions
            .into_iter()
            .filter(|session| session.context_id == context_id)
            .map(|session| session.id)
            .collect::<HashSet<_>>(),
        Err(error) => return sdk_error_response(error),
    };
    if visible_session_ids.is_empty() {
        return Json(json!({
            "context_id": context_id,
            "query": query_text,
            "matches": [],
        }))
        .into_response();
    }

    // Fetch more lexical candidates than the UI limit because Frame and
    // control-plane documents are intentionally removed below.
    let candidate_limit = limit.saturating_mul(8).clamp(limit, 500);
    let recall = match state
        .runtime
        .search_recall(RecallSearchRequest {
            context_id: context_id.clone(),
            query: query_text.to_string(),
            start_time: None,
            end_time: None,
            limit: candidate_limit,
            cursor: None,
            view_manifest: None,
        })
        .await
    {
        Ok(page) => page,
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let event_hits = recall
        .matches
        .into_iter()
        .filter(|hit| hit.document_kind == crate::memory::RecallDocumentKind::Event)
        .collect::<Vec<_>>();
    if event_hits.is_empty() {
        return Json(json!({
            "context_id": context_id,
            "query": query_text,
            "matches": [],
        }))
        .into_response();
    }
    let event_ids = event_hits
        .iter()
        .map(|hit| hit.document_id.clone())
        .collect::<Vec<_>>();
    let events = match state
        .runtime
        .query_events(QueryFilter {
            context_id: Some(context_id.clone()),
            session_ids: visible_session_ids.iter().cloned().collect(),
            event_ids,
            top_k: Some(event_hits.len()),
            ..QueryFilter::default()
        })
        .await
    {
        Ok(events) => events,
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let events_by_id = events
        .into_iter()
        .filter(|event| {
            let event_session_id = event
                .payload
                .get("session_id")
                .and_then(|value| value.as_str());
            matches!(
                event.topic.as_str(),
                "chat/user_message"
                    | "chat/steering"
                    | "chat/reply"
                    | "chat/outbound_message"
                    | "chat/session_signal"
            ) && event_session_id.is_some_and(|session_id| visible_session_ids.contains(session_id))
        })
        .map(|event| (event.id.clone(), event))
        .collect::<HashMap<_, _>>();
    let matches = event_hits
        .into_iter()
        .filter_map(|hit| {
            let event = events_by_id.get(&hit.document_id)?;
            let kind = match event.topic.as_str() {
                "chat/user_message" | "chat/steering" => "user",
                "chat/session_signal" => "coordination",
                "chat/reply" | "chat/outbound_message"
                    if event
                        .payload
                        .get("delivery_kind")
                        .and_then(|value| value.as_str())
                        == Some("thread_delivery")
                        || event
                            .payload
                            .get("thread_kind")
                            .and_then(|value| value.as_str())
                            .is_some_and(|kind| kind != "dialogue_turn")
                        || event.payload.get("objective_id").is_some() =>
                {
                    "execution_result"
                }
                _ => "agent",
            };
            Some(json!({
                "event_id": event.id,
                "sequence": event.sequence,
                "session_id": event.payload.get("session_id"),
                "topic": event.topic,
                "timestamp": event.timestamp,
                "actor": event.actor,
                "kind": kind,
                "score": hit.score,
                "retired": hit.retired,
                "preview": hit.preview,
            }))
        })
        .take(limit)
        .collect::<Vec<_>>();
    Json(json!({
        "context_id": context_id,
        "query": query_text,
        "matches": matches,
    }))
    .into_response()
}

async fn handle_recall_frame(
    State(state): State<Arc<AppState>>,
    Path((context_id, frame_id)): Path<(String, String)>,
    headers: HeaderMap,
    Query(query): Query<FrameRecallHttpQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state
        .runtime
        .recall_frame(FrameRecallRequest {
            context_id,
            frame_id,
            depth: query.depth.unwrap_or(0),
            direction: query.direction.unwrap_or_default(),
            include_bodies: query.include_bodies.unwrap_or(true),
            include_events: query.include_events.unwrap_or(false),
            max_nodes: query.max_nodes.unwrap_or(32),
            cursor: query.cursor.filter(|cursor| !cursor.trim().is_empty()),
            view_manifest: None,
        })
        .await
    {
        Ok(page) => Json(page).into_response(),
        Err(error) => error_response(StatusCode::BAD_REQUEST, error.to_string()),
    }
}

async fn handle_inspect_recall_index(
    State(state): State<Arc<AppState>>,
    Path(context_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state.runtime.inspect_recall_index(&context_id).await {
        Ok(audit) => Json(audit).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn handle_rebuild_recall_index(
    State(state): State<Arc<AppState>>,
    Path(context_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state.runtime.rebuild_recall_index(&context_id).await {
        Ok(audit) => Json(audit).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn handle_mutate_frame_lifecycle(
    State(state): State<Arc<AppState>>,
    Path((context_id, frame_id)): Path<(String, String)>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<MutateFrameLifecycleRequest>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let action = match request.action.trim() {
        "restore" => "restore",
        "protect" => "protect",
        "unprotect" => "unprotect",
        _ => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "action supports only restore, protect, or unprotect",
            )
        }
    };
    let Some(session) = (match state.runtime.get_session(&request.session_id).await {
        Ok(session) => session,
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }) else {
        return error_response(StatusCode::NOT_FOUND, "Session does not exist");
    };
    if session.context_id != context_id {
        return error_response(
            StatusCode::BAD_REQUEST,
            "Session does not belong to the target Context",
        );
    }
    let reason = request
        .reason
        .unwrap_or_else(|| format!("Dashboard requested Frame action {action}"));
    let transaction = format!(
        "(context-tx (base-version {}) (reason {}) ({} {}))",
        request.expected_version,
        crate::sexpr::SExpr::Atom(reason),
        action,
        crate::sexpr::SExpr::Atom(frame_id)
    );
    match state
        .runtime
        .apply_context_transaction(&context_id, &request.session_id, &transaction)
        .await
    {
        Ok(commit) => Json(commit).into_response(),
        Err(error) => error_response(StatusCode::CONFLICT, error.to_string()),
    }
}

async fn handle_get_inference(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let options = match state.runtime.inference_model_options().await {
        Ok(options) => options,
        Err(error) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to read the discovered and enabled model catalog: {error}"),
            )
        }
    };
    Json(json!({
        "model": state.runtime.model(),
        "models": options.iter().map(|option| option.id.clone()).collect::<Vec<_>>(),
        "model_options": options,
        "reasoning_effort": state.runtime.effective_reasoning_effort().map(ReasoningEffort::as_str),
        "prompt_token_limit": state.runtime.model_context_capacity().prompt_token_limit,
    }))
    .into_response()
}

async fn handle_update_inference(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<UpdateInferenceRequest>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let current_model = state.runtime.model();
    let model = request.model.as_deref().unwrap_or(&current_model).trim();
    let model_options = match state.runtime.inference_model_options().await {
        Ok(options) => options,
        Err(error) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to read the discovered and enabled model catalog: {error}"),
            )
        }
    };
    if request.model.is_some() && !model_options.iter().any(|option| option.id == model) {
        return error_response(
            StatusCode::BAD_REQUEST,
            format!("model '{model}' is not in the discovered and enabled model catalog; runtime switch rejected"),
        );
    }
    let effort = match request.reasoning_effort.as_deref().map(str::trim) {
        None => state.runtime.reasoning_effort(),
        Some(value) if value.is_empty() || value.eq_ignore_ascii_case("default") => None,
        Some(value) => match ReasoningEffort::parse(value) {
            Some(effort) => Some(effort),
            None => {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "reasoning_effort supports only default, none, low, medium, high, or max",
                )
            }
        },
    };
    if let Some(effort) = effort {
        if let Some(option) = model_options.iter().find(|option| option.id == model) {
            if option
                .supported_reasoning_efforts
                .as_ref()
                .is_some_and(|supported| !supported.iter().any(|level| level == effort.as_str()))
            {
                let supported = option
                    .supported_reasoning_efforts
                    .as_ref()
                    .map(|levels| levels.join(", "))
                    .unwrap_or_default();
                let detail = if supported.is_empty() {
                    "this model does not provide reasoning effort selection".to_string()
                } else {
                    format!("this model supports only: {supported}")
                };
                return error_response(
                    StatusCode::BAD_REQUEST,
                    format!(
                        "model '{model}' does not support reasoning effort '{}'; {detail}",
                        effort.as_str()
                    ),
                );
            }
        }
    }
    let prompt_token_limit = match request.prompt_token_limit {
        Some(0) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "prompt_token_limit must be greater than 0",
            )
        }
        Some(value) => match usize::try_from(value) {
            Ok(value) => Some(value),
            Err(_) => {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "prompt_token_limit exceeds the current platform integer range",
                )
            }
        },
        None => None,
    };
    let Some(managed_config_path) = state.managed_config_path.as_deref() else {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot determine Morphz managed configuration path; reasoning settings were not changed",
        );
    };
    if let Err(error) = save_managed_inference_at(
        managed_config_path,
        state.runtime.config().llm.provider.as_deref(),
        model,
        effort,
        prompt_token_limit,
    ) {
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, error);
    }
    if model != current_model {
        if let Err(error) = state.runtime.set_model(model).await {
            return error_response(StatusCode::BAD_REQUEST, error.to_string());
        }
    }
    if let Some(limit) = prompt_token_limit {
        if let Err(error) = state
            .runtime
            .set_model_prompt_token_limit(model, limit)
            .await
        {
            return error_response(StatusCode::BAD_REQUEST, error.to_string());
        }
    }
    if let Err(error) = state.runtime.set_reasoning_effort(effort).await {
        return error_response(StatusCode::NOT_IMPLEMENTED, error.to_string());
    }
    Json(json!({
        "model": state.runtime.model(),
        "models": model_options.iter().map(|option| option.id.clone()).collect::<Vec<_>>(),
        "model_options": model_options,
        "reasoning_effort": state.runtime.effective_reasoning_effort().map(ReasoningEffort::as_str),
        "prompt_token_limit": state.runtime.model_context_capacity().prompt_token_limit,
        "scope": "subsequent_requests",
        "persistent": true,
    }))
    .into_response()
}

async fn handle_list_approvals(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    Json(json!({ "approvals": state.runtime.pending_approvals().await })).into_response()
}

async fn handle_decide_approval(
    State(state): State<Arc<AppState>>,
    Path(approval_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<DecideApprovalRequest>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let rationale = request
        .rationale
        .unwrap_or_else(|| "the user decided through the Morphz approval channel".to_string());
    let normalized_decision = request.decision.trim().to_ascii_lowercase();
    let reusable_scope = match normalized_decision.as_str() {
        "allow_lease" | "approve_lease" | "allow_thread" => {
            Some(crate::memory::CapabilityLeaseScope::Thread)
        }
        "allow_objective" => Some(crate::memory::CapabilityLeaseScope::Objective),
        "allow_session" => Some(crate::memory::CapabilityLeaseScope::Session),
        _ => None,
    };
    if let Some(scope) = reusable_scope {
        return match state
            .runtime
            .allow_approval_capability_scope(&approval_id, scope, rationale)
            .await
        {
            Ok(()) => Json(json!({
                "approval_id": approval_id,
                "accepted": true,
                "scope": scope.as_str(),
            }))
            .into_response(),
            Err(error) => error_response(StatusCode::CONFLICT, error),
        };
    }
    if matches!(normalized_decision.as_str(), "allow_all" | "full_access") {
        return error_response(
            StatusCode::BAD_REQUEST,
            "An approval decision cannot enable Full Access; update the Session permission preset explicitly instead",
        );
    }
    let decision = match normalized_decision.as_str() {
        "allow" | "allow_once" | "approve" => ApprovalDecision::AllowOnce {
            rationale,
            risk_tags: vec!["human-approved".to_string()],
        },
        "deny" | "reject" => ApprovalDecision::Deny {
            rationale,
            risk_tags: vec!["human-denied".to_string()],
        },
        _ => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "decision supports only allow_once, allow_thread, allow_objective, allow_session, or deny",
            )
        }
    };
    match state.runtime.decide_approval(&approval_id, decision).await {
        Ok(()) => Json(json!({ "approval_id": approval_id, "accepted": true })).into_response(),
        Err(error) => error_response(StatusCode::NOT_FOUND, error),
    }
}

fn api_id(prefix: &str) -> String {
    let counter = API_ID_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
    format!(
        "{}_{}_{}",
        prefix,
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
        counter
    )
}

fn validate_identifier(kind: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 128 {
        return Err(format!("{kind} length must be 1..=128"));
    }
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':'))
    {
        return Err(format!(
            "{kind} may contain only ASCII letters, digits, dots, hyphens, underscores, or colons"
        ));
    }
    Ok(())
}

/// Validates an externally asserted Principal identifier.
///
/// A Principal ID is an opaque identifier owned by an Identity Provider, not
/// a Morphz resource name. Provider-native values such as an email address,
/// an IM address (`user@im.wechat`) or a namespaced subject must therefore not
/// be forced through the narrow Session/Context identifier grammar.
fn validate_principal_id(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 512 {
        return Err("principal_id length must be 1..=512 bytes".to_string());
    }
    if value.trim() != value {
        return Err("principal_id must not contain leading or trailing whitespace".to_string());
    }
    if value.chars().any(|ch| ch.is_control()) {
        return Err("principal_id must not contain control characters".to_string());
    }
    Ok(())
}

fn error_response(status: StatusCode, message: impl Into<String>) -> axum::response::Response {
    let message = message.into();
    let (code, public_message) = if status == StatusCode::INTERNAL_SERVER_ERROR {
        tracing::error!(
            event_code = "web.api.internal_error",
            error = %message,
            "HTTP API request failed with an internal error"
        );
        (
            "internal",
            "The server could not complete the request".to_string(),
        )
    } else {
        (http_error_code(status), message)
    };
    (
        status,
        Json(json!({
            "error": {
                "code": code,
                "message": public_message,
            }
        })),
    )
        .into_response()
}

fn http_error_code(status: StatusCode) -> &'static str {
    match status {
        StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY => "invalid_argument",
        StatusCode::UNAUTHORIZED => "unauthorized",
        StatusCode::FORBIDDEN => "forbidden",
        StatusCode::NOT_FOUND => "not_found",
        StatusCode::CONFLICT => "conflict",
        StatusCode::PAYLOAD_TOO_LARGE | StatusCode::TOO_MANY_REQUESTS => "resource_exhausted",
        StatusCode::RANGE_NOT_SATISFIABLE => "invalid_argument",
        StatusCode::SERVICE_UNAVAILABLE => "unavailable",
        StatusCode::GATEWAY_TIMEOUT => "deadline_exceeded",
        _ if status.is_server_error() => "internal",
        _ => "request_failed",
    }
}

fn unauthorized_response() -> axum::response::Response {
    error_response(StatusCode::UNAUTHORIZED, "Authentication is required")
}

fn sdk_error_response(error: SdkError) -> axum::response::Response {
    let status = match error.code {
        SdkErrorCode::InvalidArgument => StatusCode::BAD_REQUEST,
        SdkErrorCode::ResourceExhausted => StatusCode::PAYLOAD_TOO_LARGE,
        SdkErrorCode::Unauthorized => StatusCode::UNAUTHORIZED,
        SdkErrorCode::Forbidden => StatusCode::FORBIDDEN,
        SdkErrorCode::NotFound => StatusCode::NOT_FOUND,
        SdkErrorCode::Conflict => StatusCode::CONFLICT,
        SdkErrorCode::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
        SdkErrorCode::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    };
    let message = if error.code == SdkErrorCode::Internal {
        tracing::error!(
            event_code = "web.api.sdk_internal_error",
            error = %error.message,
            "SDK request failed with an internal error"
        );
        "The server could not complete the request".to_string()
    } else {
        error.message
    };
    (
        status,
        Json(json!({
            "error": {
                "code": error.code.as_str(),
                "message": message,
            }
        })),
    )
        .into_response()
}

fn request_principal(
    state: &AppState,
    headers: &HeaderMap,
    query_principal_id: Option<&str>,
) -> Result<PrincipalAssertion, SdkError> {
    // Dashboard/operator authentication is independent from the trusted
    // gateway. The operator surface uses the Runtime's administrative default
    // identity unless it deliberately goes through a principal-scoped API.
    if is_operator_authorized(state, headers, None) {
        return Ok(state.sdk.default_principal());
    }
    if state.identity.mode == ServerIdentityMode::Default {
        return Ok(state.sdk.default_principal());
    }
    let header_principal_id = headers
        .get("x-morphz-principal")
        .map(|value| value.to_str())
        .transpose()
        .map_err(|_| {
            SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Principal Header is not valid UTF-8",
            )
        })?;
    if let (Some(header), Some(query)) = (header_principal_id, query_principal_id) {
        if header != query {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Principal in Header and Query does not match",
            ));
        }
    }
    let principal_id = header_principal_id.or(query_principal_id).ok_or_else(|| {
        SdkError::new(
            SdkErrorCode::Unauthorized,
            "trusted-gateway request is missing the current Principal",
        )
    })?;
    validate_principal_id(principal_id)
        .map_err(|error| SdkError::new(SdkErrorCode::InvalidArgument, error))?;
    let display_name = headers
        .get("x-morphz-principal-name")
        .map(|value| value.to_str())
        .transpose()
        .map_err(|_| {
            SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Principal Name Header is not valid UTF-8",
            )
        })?
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(200).collect::<String>());
    Ok(PrincipalAssertion {
        principal_id: principal_id.to_string(),
        provider_id: state.identity.provider_id.clone(),
        assurance: "trusted-gateway".to_string(),
        display_name,
    })
}

/// Resolve the authority used by a read-only Session API.
///
/// Operator authentication may select another Principal as an observation
/// scope, but that scope is never reused by message delivery or other writes.
/// Trusted-gateway callers continue to be bound to their asserted identity.
fn request_read_principal(
    state: &AppState,
    headers: &HeaderMap,
    operator_token: Option<&str>,
    query_principal_id: Option<&str>,
) -> Result<PrincipalAssertion, SdkError> {
    if is_operator_authorized(state, headers, operator_token) {
        if let Some(principal_id) = query_principal_id {
            validate_principal_id(principal_id)
                .map_err(|error| SdkError::new(SdkErrorCode::InvalidArgument, error))?;
            return Ok(PrincipalAssertion {
                principal_id: principal_id.to_string(),
                provider_id: "operator-directory".to_string(),
                assurance: "operator-read".to_string(),
                display_name: None,
            });
        }
    }
    request_principal(state, headers, query_principal_id)
}

async fn authorize_objective_request(
    state: &AppState,
    headers: &HeaderMap,
    operator_token: Option<&str>,
    objective_id: &str,
) -> Result<ObjectiveRecord, Response> {
    let objective = state
        .runtime
        .get_objective(objective_id)
        .await
        .map_err(|error| error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Objective does not exist"))?;
    if is_operator_authorized(state, headers, operator_token) {
        return Ok(objective);
    }
    let principal = request_principal(state, headers, None).map_err(sdk_error_response)?;
    state
        .sdk
        .get_session(&principal.principal_id, &objective.coordinator_session_id)
        .await
        .map_err(sdk_error_response)?;
    Ok(objective)
}

fn bounded_title(value: Option<String>, fallback: &str) -> String {
    value
        .unwrap_or_else(|| fallback.to_string())
        .trim()
        .chars()
        .take(200)
        .collect()
}

struct ResolvedMount {
    agent_id: String,
    context_id: String,
    seed: Option<crate::orchestrator::context::MindSeedReceipt>,
    mount_kind: SessionMountKind,
}

async fn resolve_context_mount(
    state: &AppState,
    requested_agent_id: Option<String>,
    mount: Option<ContextMountRequest>,
) -> Result<ResolvedMount, (StatusCode, String)> {
    let agent_was_explicit = requested_agent_id.is_some();
    let requested_agent_id = requested_agent_id.unwrap_or_else(|| state.default_agent_id.clone());
    if let Err(error) = validate_identifier("agent_id", &requested_agent_id) {
        return Err((StatusCode::BAD_REQUEST, error));
    }
    match mount {
        None | Some(ContextMountRequest::ExistingContext { .. }) => {
            let context_id = match mount {
                Some(ContextMountRequest::ExistingContext { context_id }) => context_id,
                _ => state.default_context_id.clone(),
            };
            if let Err(error) = validate_identifier("context_id", &context_id) {
                return Err((StatusCode::BAD_REQUEST, error));
            }
            let context = state
                .runtime
                .get_context(&context_id)
                .await
                .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
                .ok_or_else(|| {
                    (
                        StatusCode::NOT_FOUND,
                        format!("mounted Context '{}' does not exist", context_id),
                    )
                })?;
            if agent_was_explicit && requested_agent_id != context.agent_id {
                return Err((
                    StatusCode::CONFLICT,
                    format!(
                        "requested Agent '{}' does not match Context owner Agent '{}'",
                        requested_agent_id, context.agent_id
                    ),
                ));
            }
            Ok(ResolvedMount {
                agent_id: context.agent_id,
                context_id,
                seed: None,
                mount_kind: SessionMountKind::ExistingContext,
            })
        }
        Some(ContextMountRequest::NewBlankContext {
            context_id,
            context_title,
        }) => {
            let agent = state
                .runtime
                .get_agent(&requested_agent_id)
                .await
                .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
                .ok_or_else(|| {
                    (
                        StatusCode::NOT_FOUND,
                        format!(
                            "Agent '{}' does not exist; call create_agent first",
                            requested_agent_id
                        ),
                    )
                })?;
            let context_id = context_id.unwrap_or_else(|| api_id("context"));
            if let Err(error) = validate_identifier("context_id", &context_id) {
                return Err((StatusCode::BAD_REQUEST, error));
            }
            state
                .runtime
                .create_context(NewCognitiveContext {
                    id: context_id.clone(),
                    agent_id: agent.id.clone(),
                    title: bounded_title(context_title, "New Blank Context"),
                })
                .await
                .map_err(|error| (StatusCode::CONFLICT, error.to_string()))?;
            Ok(ResolvedMount {
                agent_id: agent.id,
                context_id,
                seed: None,
                mount_kind: SessionMountKind::NewBlankContext,
            })
        }
        Some(ContextMountRequest::NewContextFromMind {
            source_context_id,
            source_version,
            context_id,
            context_title,
        }) => {
            let source = state
                .runtime
                .get_context(&source_context_id)
                .await
                .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
                .ok_or_else(|| {
                    (
                        StatusCode::NOT_FOUND,
                        format!("source Context '{}' does not exist", source_context_id),
                    )
                })?;
            if agent_was_explicit && requested_agent_id != source.agent_id {
                return Err((
                    StatusCode::CONFLICT,
                    format!(
                        "requested Agent '{}' does not match source Context owner Agent '{}'",
                        requested_agent_id, source.agent_id
                    ),
                ));
            }
            if let Some(expected_version) = source_version {
                let actual_version = state
                    .runtime
                    .mind_version(&source_context_id)
                    .await
                    .map_err(|error| (StatusCode::CONFLICT, error.to_string()))?;
                if expected_version != actual_version {
                    return Err((
                        StatusCode::CONFLICT,
                        format!(
                            "source Context version conflict: requested {}, current {}",
                            expected_version, actual_version
                        ),
                    ));
                }
            }
            let context_id = context_id.unwrap_or_else(|| api_id("context"));
            if let Err(error) = validate_identifier("context_id", &context_id) {
                return Err((StatusCode::BAD_REQUEST, error));
            }
            state
                .runtime
                .create_context(NewCognitiveContext {
                    id: context_id.clone(),
                    agent_id: source.agent_id.clone(),
                    title: bounded_title(context_title, "Independent Cognitive Context"),
                })
                .await
                .map_err(|error| (StatusCode::CONFLICT, error.to_string()))?;
            let seed = state
                .runtime
                .seed_context_from_mind(&source_context_id, source_version, &context_id)
                .await
                .map_err(|error| (StatusCode::CONFLICT, error.to_string()))?;
            Ok(ResolvedMount {
                agent_id: source.agent_id,
                context_id,
                seed: Some(seed),
                mount_kind: SessionMountKind::NewContextFromMind,
            })
        }
    }
}

async fn handle_list_agents(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<SessionListQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state.runtime.list_agents(query.include_archived).await {
        Ok(agents) => Json(json!({ "agents": agents })).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn handle_get_agent_provider_bindings(
    State(state): State<Arc<AppState>>,
    Path(agent_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state.sdk.agent_provider_bindings(&agent_id).await {
        Ok(bindings) => Json(bindings).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_bind_agent_provider_account(
    State(state): State<Arc<AppState>>,
    Path((agent_id, account_id)): Path<(String, String)>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state
        .sdk
        .bind_agent_provider_account(&agent_id, &account_id)
        .await
    {
        Ok(bindings) => Json(bindings).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_unbind_agent_provider_account(
    State(state): State<Arc<AppState>>,
    Path((agent_id, account_id)): Path<(String, String)>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state
        .sdk
        .unbind_agent_provider_account(&agent_id, &account_id)
        .await
    {
        Ok(bindings) => Json(bindings).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_create_agent(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<CreateAgentRequest>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, None) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    let agent_id = request.id.unwrap_or_else(|| api_id("agent"));
    let context_id = request.root_context_id.unwrap_or_else(|| api_id("context"));
    let session_id = request
        .initial_session_id
        .unwrap_or_else(|| api_id("session"));
    for (kind, id) in [
        ("agent_id", agent_id.as_str()),
        ("root_context_id", context_id.as_str()),
        ("initial_session_id", session_id.as_str()),
    ] {
        if let Err(error) = validate_identifier(kind, id) {
            return error_response(StatusCode::BAD_REQUEST, error);
        }
    }
    let bundle = match state
        .runtime
        .create_agent_bundle(
            NewAgent {
                id: agent_id.clone(),
                title: bounded_title(request.title, "New Agent"),
                root_context_id: context_id.clone(),
            },
            NewCognitiveContext {
                id: context_id.clone(),
                agent_id: agent_id.clone(),
                title: bounded_title(request.root_context_title, "Root Context"),
            },
            NewSession {
                id: session_id,
                agent_id,
                context_id,
                parent_session_id: None,
                title: bounded_title(request.initial_session_title, "Initial Session"),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await
    {
        Ok(bundle) => bundle,
        Err(error) => return error_response(StatusCode::CONFLICT, error.to_string()),
    };
    if let Err(error) = state
        .sdk
        .bind_existing_session(principal, &bundle.initial_session.id)
        .await
    {
        return sdk_error_response(error);
    }
    (StatusCode::CREATED, Json(bundle)).into_response()
}

async fn handle_list_sessions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<SessionListQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    // Operator visibility is administrative and must not be represented by
    // adding the Runtime's default Principal as a participant in every Session.
    if is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return match state.runtime.list_sessions(query.include_archived).await {
            Ok(sessions) => Json(json!({ "sessions": sessions })).into_response(),
            Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        };
    }
    let principal = match request_principal(&state, &headers, None) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    match state
        .sdk
        .list_sessions(&principal.principal_id, query.include_archived)
        .await
    {
        Ok(sessions) => Json(json!({ "sessions": sessions })).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_search_operator_principals(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<PrincipalDirectoryQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let query_text = query.query.trim();
    if query_text.chars().count() > 200 {
        return error_response(
            StatusCode::BAD_REQUEST,
            "Principal search term exceeds 200 characters",
        );
    }
    if query
        .cursor
        .as_deref()
        .is_some_and(|cursor| cursor.is_empty() || cursor.len() > 512)
    {
        return error_response(StatusCode::BAD_REQUEST, "invalid Principal cursor");
    }
    match state
        .runtime
        .search_principals(
            query_text,
            query.cursor.as_deref(),
            query.limit.unwrap_or(20).clamp(1, 100),
        )
        .await
    {
        Ok(page) => Json(page).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn handle_list_operator_principal_sessions(
    State(state): State<Arc<AppState>>,
    Path(principal_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<OperatorPrincipalSessionsQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    if let Err(error) = validate_principal_id(&principal_id) {
        return error_response(StatusCode::BAD_REQUEST, error);
    }
    match state
        .runtime
        .list_principal_sessions(&principal_id, query.include_archived)
        .await
    {
        Ok(sessions) => Json(json!({
            "principal_id": principal_id,
            "sessions": sessions,
        }))
        .into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn handle_list_contexts(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<SessionListQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state.runtime.list_contexts(query.include_archived).await {
        Ok(contexts) => Json(json!({ "contexts": contexts })).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn handle_list_execution_targets(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_read_principal(
        &state,
        &headers,
        query.token.as_deref(),
        query.principal_id.as_deref(),
    ) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    match state
        .sdk
        .list_execution_targets(&principal.principal_id)
        .await
    {
        Ok(targets) => Json(json!({ "targets": targets })).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_register_execution_target(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(registration): Json<ExecutionTargetRegistration>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, query.principal_id.as_deref()) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    match state
        .sdk
        .register_execution_target(&principal.principal_id, registration)
        .await
    {
        Ok(target) => (StatusCode::CREATED, Json(target)).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_inspect_execution_target(
    State(state): State<Arc<AppState>>,
    Path(target_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, query.principal_id.as_deref()) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    match state
        .sdk
        .inspect_execution_target(&principal.principal_id, &target_id)
        .await
    {
        Ok(target) => Json(target).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_mutate_execution_target(
    State(state): State<Arc<AppState>>,
    Path(target_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<MutateExecutionTargetRequest>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, query.principal_id.as_deref()) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    match state
        .sdk
        .set_execution_target_status(
            &principal.principal_id,
            &target_id,
            request.expected_revision,
            request.status,
        )
        .await
    {
        Ok(target) => Json(target).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_authorize_execution_target(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(command): Json<AuthorizeExecutionTargetCommand>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, query.principal_id.as_deref()) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    match state
        .sdk
        .authorize_execution_target(&principal.principal_id, command)
        .await
    {
        Ok(authorization) => (StatusCode::CREATED, Json(authorization)).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_list_execution_target_authorizations(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<TargetAuthorizationQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, query.principal_id.as_deref()) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    match state
        .sdk
        .list_execution_target_authorizations(
            &principal.principal_id,
            query.target_id,
            query.active_only,
        )
        .await
    {
        Ok(authorizations) => Json(json!({ "authorizations": authorizations })).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_revoke_execution_target_authorization(
    State(state): State<Arc<AppState>>,
    Path(authorization_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<RevokeTargetAuthorizationRequest>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, query.principal_id.as_deref()) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    let reason = request
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .unwrap_or("revoked explicitly by the current Principal");
    match state
        .sdk
        .revoke_execution_target_authorization(
            &principal.principal_id,
            &authorization_id,
            request.expected_revision,
            reason,
        )
        .await
    {
        Ok(authorization) => Json(authorization).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_list_capability_leases(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<CapabilityLeaseQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, query.principal_id.as_deref()) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    match state
        .sdk
        .list_capability_leases(
            &principal.principal_id,
            query.thread_id,
            query.target_id,
            query.active_only,
        )
        .await
    {
        Ok(leases) => Json(json!({ "leases": leases })).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_revoke_capability_lease(
    State(state): State<Arc<AppState>>,
    Path(lease_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<RevokeCapabilityLeaseRequest>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, query.principal_id.as_deref()) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    let reason = request
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .unwrap_or("revoked explicitly by the current Principal");
    match state
        .sdk
        .revoke_capability_lease(
            &principal.principal_id,
            &lease_id,
            request.expected_revision,
            reason,
        )
        .await
    {
        Ok(lease) => Json(lease).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_restrict_capability_lease(
    State(state): State<Arc<AppState>>,
    Path(lease_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<RestrictCapabilityLeaseRequest>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, query.principal_id.as_deref()) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    match state
        .sdk
        .restrict_capability_lease(
            &principal.principal_id,
            &lease_id,
            request.expected_revision,
            CapabilityLeaseRestriction {
                requested: request.requested,
                expires_at: request.expires_at,
            },
        )
        .await
    {
        Ok(lease) => Json(lease).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_create_node_pairing_code(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(command): Json<CreateNodePairingCodeCommand>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, query.principal_id.as_deref()) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    match state
        .sdk
        .create_node_pairing_code(&principal.principal_id, command)
        .await
    {
        Ok(pairing) => (StatusCode::CREATED, Json(pairing)).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_pair_execution_node(
    State(state): State<Arc<AppState>>,
    Json(command): Json<PairExecutionNodeCommand>,
) -> impl IntoResponse {
    // The one-shot, short-lived pairing code is the authority for this route.
    // Requiring the Dashboard bearer token here would prevent a new device
    // from pairing before it owns a device credential.
    match state.sdk.pair_execution_node(command).await {
        Ok(paired) => (StatusCode::CREATED, Json(paired)).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_create_execution_node_challenge(
    State(state): State<Arc<AppState>>,
    Path(node_id): Path<String>,
) -> impl IntoResponse {
    // A challenge has no authority by itself. Only a valid signature from the
    // paired device key can exchange it for a short-lived connection token.
    match state
        .sdk
        .create_execution_node_identity_challenge(&node_id)
        .await
    {
        Ok(challenge) => Json(challenge).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_connect_execution_node(
    State(state): State<Arc<AppState>>,
    Path(node_id): Path<String>,
    Json(command): Json<ConnectExecutionNodeCommand>,
) -> impl IntoResponse {
    match state.sdk.connect_execution_node(&node_id, command).await {
        Ok(connection) => Json(connection).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_rotate_execution_node_key(
    State(state): State<Arc<AppState>>,
    Path(node_id): Path<String>,
    headers: HeaderMap,
    Json(command): Json<RotateExecutionNodeKeyCommand>,
) -> impl IntoResponse {
    let device_token = match node_device_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    match state
        .sdk
        .rotate_execution_node_key(&node_id, device_token, command)
        .await
    {
        Ok(node) => Json(node).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_list_execution_nodes(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, query.principal_id.as_deref()) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    match state
        .sdk
        .list_execution_nodes(&principal.principal_id)
        .await
    {
        Ok(nodes) => Json(json!({ "nodes": nodes })).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_revoke_execution_node(
    State(state): State<Arc<AppState>>,
    Path(node_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<RevokeExecutionNodeRequest>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, query.principal_id.as_deref()) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    match state
        .sdk
        .revoke_execution_node(&principal.principal_id, &node_id, request.expected_revision)
        .await
    {
        Ok(node) => Json(node).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_heartbeat_execution_node(
    State(state): State<Arc<AppState>>,
    Path(node_id): Path<String>,
    headers: HeaderMap,
    Json(command): Json<ExecutionNodeHeartbeatCommand>,
) -> impl IntoResponse {
    let device_token = match node_device_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    match state
        .sdk
        .heartbeat_execution_node(&node_id, device_token, command)
        .await
    {
        Ok(node) => Json(node).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_claim_edge_command(
    State(state): State<Arc<AppState>>,
    Path(node_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<EdgeClaimQuery>,
    Json(command): Json<ClaimEdgeCommand>,
) -> impl IntoResponse {
    let device_token = match node_device_token(&headers) {
        Ok(token) => token.to_string(),
        Err(response) => return response,
    };
    let wait = std::time::Duration::from_secs(query.wait_seconds.unwrap_or(20).min(25));
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        match state
            .sdk
            .claim_edge_command(&node_id, &device_token, command.clone())
            .await
        {
            Ok(Some(job)) => return Json(json!({ "job": job })).into_response(),
            Ok(None) if tokio::time::Instant::now() < deadline => {
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                // Local producers wake this immediately. Five seconds is the
                // durable/cross-process fallback, replacing the previous 250ms
                // write-poll loop without weakening crash recovery.
                state
                    .runtime
                    .wait_for_edge_command_change(remaining.min(std::time::Duration::from_secs(5)))
                    .await;
            }
            Ok(None) => return StatusCode::NO_CONTENT.into_response(),
            Err(error) => return sdk_error_response(error),
        }
    }
}

async fn handle_heartbeat_edge_command(
    State(state): State<Arc<AppState>>,
    Path((node_id, job_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(command): Json<HeartbeatEdgeCommand>,
) -> impl IntoResponse {
    let device_token = match node_device_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    match state
        .sdk
        .heartbeat_edge_command(&node_id, device_token, &job_id, command)
        .await
    {
        Ok(job) => Json(job).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_finish_edge_command(
    State(state): State<Arc<AppState>>,
    Path((node_id, job_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(command): Json<FinishEdgeCommand>,
) -> impl IntoResponse {
    let device_token = match node_device_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    match state
        .sdk
        .finish_edge_command(&node_id, device_token, &job_id, command)
        .await
    {
        Ok(job) => Json(job).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_reserve_edge_background_execution(
    State(state): State<Arc<AppState>>,
    Path((node_id, job_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(command): Json<ReserveEdgeBackgroundExecutionCommand>,
) -> impl IntoResponse {
    let device_token = match node_device_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    match state
        .sdk
        .reserve_edge_background_execution(&node_id, device_token, &job_id, command)
        .await
    {
        Ok(lease) => Json(lease).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_heartbeat_edge_background_execution(
    State(state): State<Arc<AppState>>,
    Path((node_id, job_id, task_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Json(command): Json<HeartbeatEdgeBackgroundExecutionCommand>,
) -> impl IntoResponse {
    let device_token = match node_device_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    match state
        .sdk
        .heartbeat_edge_background_execution(&node_id, device_token, &job_id, &task_id, command)
        .await
    {
        Ok(job) => Json(job).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_finish_edge_background_execution(
    State(state): State<Arc<AppState>>,
    Path((node_id, job_id, task_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Json(command): Json<FinishEdgeBackgroundExecutionCommand>,
) -> impl IntoResponse {
    let device_token = match node_device_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    match state
        .sdk
        .finish_edge_background_execution(&node_id, device_token, &job_id, &task_id, command)
        .await
    {
        Ok(committed) => Json(json!({ "committed": committed })).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_cancel_edge_background_execution(
    State(state): State<Arc<AppState>>,
    Path((node_id, job_id, task_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Json(command): Json<CancelEdgeBackgroundExecutionCommand>,
) -> impl IntoResponse {
    let device_token = match node_device_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    match state
        .sdk
        .cancel_edge_background_execution(&node_id, device_token, &job_id, &task_id, command)
        .await
    {
        Ok(job) => Json(job).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_append_edge_command_output(
    State(state): State<Arc<AppState>>,
    Path((node_id, job_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(command): Json<AppendEdgeOutputCommand>,
) -> impl IntoResponse {
    let device_token = match node_device_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    match state
        .sdk
        .append_edge_command_output(&node_id, device_token, &job_id, command)
        .await
    {
        Ok(chunk) => Json(chunk).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_download_edge_artifact(
    State(state): State<Arc<AppState>>,
    Path((node_id, job_id)): Path<(String, String)>,
    headers: HeaderMap,
    Query(query): Query<EdgeArtifactDownloadQuery>,
) -> Response {
    let device_token = match node_device_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    let claim_token = match edge_claim_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    let (_, channel) = match state
        .sdk
        .authorize_edge_artifact_channel(
            &node_id,
            device_token,
            &job_id,
            claim_token,
            EdgeArtifactDataDirection::RuntimeToEdge,
        )
        .await
    {
        Ok(value) => value,
        Err(error) => return sdk_error_response(error),
    };
    let path = state
        .runtime
        .artifact_transfer_stages()
        .stage_path(&job_id, ArtifactTransferStageKind::RuntimeSource);
    let metadata = match tokio::fs::metadata(&path).await {
        Ok(metadata) if metadata.is_file() => metadata,
        Ok(_) => {
            return error_response(StatusCode::CONFLICT, "Artifact stage is not a regular file")
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return error_response(StatusCode::NOT_FOUND, "Artifact stage does not exist")
        }
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    if channel
        .size_bytes
        .is_some_and(|expected| expected != metadata.len())
    {
        return error_response(
            StatusCode::CONFLICT,
            "Artifact stage size does not match the frozen channel",
        );
    }
    if query.offset > metadata.len() {
        return error_response(
            StatusCode::RANGE_NOT_SATISFIABLE,
            "Artifact download offset exceeds the frozen size",
        );
    }
    let mut file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    use tokio::io::AsyncSeekExt as _;
    if let Err(error) = file.seek(std::io::SeekFrom::Start(query.offset)).await {
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
    }
    let stream = futures_util::stream::try_unfold(file, |mut file| async move {
        use tokio::io::AsyncReadExt as _;
        let mut buffer = vec![0_u8; 128 * 1024];
        let count = file.read(&mut buffer).await?;
        if count == 0 {
            Ok::<_, std::io::Error>(None)
        } else {
            buffer.truncate(count);
            Ok(Some((axum::body::Bytes::from(buffer), file)))
        }
    });
    let mut response = Body::from_stream(stream).into_response();
    if let Ok(value) =
        header::HeaderValue::from_str(&metadata.len().saturating_sub(query.offset).to_string())
    {
        response.headers_mut().insert(header::CONTENT_LENGTH, value);
    }
    if let Ok(value) = header::HeaderValue::from_str(&query.offset.to_string()) {
        response.headers_mut().insert(
            header::HeaderName::from_static("x-morphz-artifact-offset"),
            value,
        );
    }
    if let Ok(value) = header::HeaderValue::from_str(&metadata.len().to_string()) {
        response.headers_mut().insert(
            header::HeaderName::from_static("x-morphz-artifact-total-size"),
            value,
        );
    }
    if query.offset > 0 {
        *response.status_mut() = StatusCode::PARTIAL_CONTENT;
    }
    if let Some(digest) = channel.expected_digest {
        if let Ok(value) = header::HeaderValue::from_str(&digest) {
            response.headers_mut().insert(
                header::HeaderName::from_static("x-morphz-content-digest"),
                value,
            );
        }
    }
    response
}

async fn handle_inspect_edge_artifact_upload(
    State(state): State<Arc<AppState>>,
    Path((node_id, job_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let device_token = match node_device_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    let claim_token = match edge_claim_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    if let Err(error) = state
        .sdk
        .authorize_edge_artifact_channel(
            &node_id,
            device_token,
            &job_id,
            claim_token,
            EdgeArtifactDataDirection::EdgeToRuntime,
        )
        .await
    {
        return sdk_error_response(error);
    }
    let final_path = state
        .runtime
        .artifact_transfer_stages()
        .stage_path(&job_id, ArtifactTransferStageKind::EdgeUpload);
    let partial_path = final_path.with_extension("partial");
    let (path, completed) = if tokio::fs::try_exists(&final_path).await.unwrap_or(false) {
        (final_path, true)
    } else {
        (partial_path, false)
    };
    let size_bytes = tokio::fs::metadata(path)
        .await
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    Json(json!({
        "job_id": job_id,
        "offset": size_bytes,
        "completed": completed,
    }))
    .into_response()
}

async fn handle_upload_edge_artifact(
    State(state): State<Arc<AppState>>,
    Path((node_id, job_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let device_token = match node_device_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    let claim_token = match edge_claim_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    let (_, channel) = match state
        .sdk
        .authorize_edge_artifact_channel(
            &node_id,
            device_token,
            &job_id,
            claim_token,
            EdgeArtifactDataDirection::EdgeToRuntime,
        )
        .await
    {
        Ok(value) => value,
        Err(error) => return sdk_error_response(error),
    };
    let requested_offset = match required_u64_header(&headers, "x-morphz-artifact-offset") {
        Ok(value) => value,
        Err(response) => return response,
    };
    let claimed_total = match required_u64_header(&headers, "x-morphz-artifact-total-size") {
        Ok(value) => value,
        Err(response) => return response,
    };
    let claimed_digest = match headers
        .get("x-morphz-content-digest")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
    {
        Some(value) => value,
        None => return error_response(StatusCode::BAD_REQUEST, "missing Artifact digest"),
    };
    if channel
        .size_bytes
        .is_some_and(|expected| expected != claimed_total)
        || channel
            .expected_digest
            .as_deref()
            .is_some_and(|expected| expected != claimed_digest)
    {
        return error_response(
            StatusCode::CONFLICT,
            "upload declaration does not match the frozen channel",
        );
    }
    let final_path = match state
        .runtime
        .artifact_transfer_stages()
        .prepare_stage_path(&job_id, ArtifactTransferStageKind::EdgeUpload)
        .await
    {
        Ok(path) => path,
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let partial_path = final_path.with_extension("partial");
    if tokio::fs::try_exists(&final_path).await.unwrap_or(false) {
        let metadata = match tokio::fs::metadata(&final_path).await {
            Ok(metadata) => metadata,
            Err(error) => {
                return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
            }
        };
        return Json(json!({
            "job_id": job_id,
            "content_digest": claimed_digest,
            "size_bytes": metadata.len()
        }))
        .into_response();
    }
    let current_offset = tokio::fs::metadata(&partial_path)
        .await
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if requested_offset != current_offset {
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "error": {
                    "code": "conflict",
                    "message": "Artifact upload offset conflict",
                },
                "expected_offset": current_offset,
            })),
        )
            .into_response();
    }
    let mut hasher = Sha256::new();
    if current_offset > 0 {
        let mut prefix = match tokio::fs::File::open(&partial_path).await {
            Ok(prefix) => prefix,
            Err(error) => {
                return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
            }
        };
        use tokio::io::AsyncReadExt as _;
        let mut buffer = vec![0_u8; 128 * 1024];
        loop {
            let count = match prefix.read(&mut buffer).await {
                Ok(count) => count,
                Err(error) => {
                    return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
                }
            };
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }
    }
    let mut file = match tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&partial_path)
        .await
    {
        Ok(file) => file,
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let mut stream = body.into_data_stream();
    let mut size_bytes = current_offset;
    use tokio::io::AsyncWriteExt as _;
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => {
                // Keep the flushed prefix. The Edge client asks for the
                // authoritative offset and resumes instead of restarting.
                let _ = file.flush().await;
                return error_response(StatusCode::BAD_REQUEST, error.to_string());
            }
        };
        size_bytes = size_bytes.saturating_add(chunk.len() as u64);
        if channel
            .size_bytes
            .is_some_and(|expected| size_bytes > expected)
        {
            return error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Artifact upload exceeds the frozen size",
            );
        }
        hasher.update(&chunk);
        if let Err(error) = file.write_all(&chunk).await {
            let _ = tokio::fs::remove_file(&partial_path).await;
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    }
    if size_bytes != claimed_total {
        let _ = file.flush().await;
        return error_response(
            StatusCode::CONFLICT,
            "Artifact upload has not reached the declared size",
        );
    }
    let digest = format!("sha256:{:x}", hasher.finalize());
    if channel
        .expected_digest
        .as_deref()
        .is_some_and(|expected| expected != digest)
        || channel
            .size_bytes
            .is_some_and(|expected| expected != size_bytes)
    {
        let _ = tokio::fs::remove_file(&partial_path).await;
        return error_response(
            StatusCode::CONFLICT,
            "Artifact upload digest or size does not match the frozen channel",
        );
    }
    if digest != claimed_digest {
        let _ = tokio::fs::remove_file(&partial_path).await;
        return error_response(
            StatusCode::CONFLICT,
            "Artifact upload digest does not match the declaration",
        );
    }
    if let Err(error) = file.sync_all().await {
        let _ = tokio::fs::remove_file(&partial_path).await;
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
    }
    drop(file);
    if let Err(error) = tokio::fs::rename(&partial_path, &final_path).await {
        let _ = tokio::fs::remove_file(&partial_path).await;
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
    }
    Json(json!({
        "job_id": job_id,
        "content_digest": digest,
        "size_bytes": size_bytes
    }))
    .into_response()
}

// Axum handlers use `Response` directly as their rejection type throughout this boundary.
#[allow(clippy::result_large_err)]
fn required_u64_header(headers: &HeaderMap, name: &'static str) -> Result<u64, Response> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| {
            error_response(
                StatusCode::BAD_REQUEST,
                format!("missing or invalid Header: {name}"),
            )
        })
}

async fn handle_list_edge_command_output(
    State(state): State<Arc<AppState>>,
    Path(job_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<EdgeOutputQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state
        .sdk
        .list_edge_command_output(
            &job_id,
            query.after_sequence.unwrap_or(0),
            query.limit.unwrap_or(200),
        )
        .await
    {
        Ok(chunks) => Json(json!({ "chunks": chunks })).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_list_execution_jobs(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<ExecutionJobHttpQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, query.principal_id.as_deref()) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    match state
        .sdk
        .list_execution_jobs(
            &principal.principal_id,
            ExecutionJobQuery {
                context_id: query.context_id,
                thread_id: query.thread_id,
                target_id: query.target_id,
                status: query.status,
                include_terminal: query.include_terminal,
                newest_first: query.newest_first,
                limit: query.limit,
            },
        )
        .await
    {
        Ok(jobs) => Json(json!({ "jobs": jobs })).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_submit_artifact_transfer(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(command): Json<SubmitArtifactTransferCommand>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, query.principal_id.as_deref()) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    match state
        .sdk
        .submit_artifact_transfer(&principal.principal_id, command)
        .await
    {
        Ok(execution) => (StatusCode::ACCEPTED, Json(execution)).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_inspect_artifact_transfer(
    State(state): State<Arc<AppState>>,
    Path(job_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, query.principal_id.as_deref()) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    match state
        .sdk
        .inspect_execution_job(&principal.principal_id, &job_id)
        .await
    {
        Ok(job) if job.tool_name == crate::artifact::ARTIFACT_TRANSFER_TOOL_NAME => {
            Json(job).into_response()
        }
        Ok(_) => error_response(
            StatusCode::BAD_REQUEST,
            "Execution Job is not an Artifact Transfer",
        ),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_artifact_transfer_output(
    State(state): State<Arc<AppState>>,
    Path(job_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, query.principal_id.as_deref()) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    match state
        .sdk
        .artifact_transfer_output(&principal.principal_id, &job_id)
        .await
    {
        Ok(output) => Json(output).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_inspect_execution_job(
    State(state): State<Arc<AppState>>,
    Path(job_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, query.principal_id.as_deref()) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    match state
        .sdk
        .inspect_execution_job(&principal.principal_id, &job_id)
        .await
    {
        Ok(job) => Json(job).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_cancel_execution_job(
    State(state): State<Arc<AppState>>,
    Path(job_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<CancelExecutionJobRequest>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, query.principal_id.as_deref()) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    match state
        .sdk
        .cancel_execution_job(
            &principal.principal_id,
            &job_id,
            request.expected_revision,
            request.reason.as_deref(),
        )
        .await
    {
        Ok(job) => Json(job).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

// The error is an axum `Response` because this short-circuits a handler with a
// ready-to-send reply. Boxing it would add an allocation on the rejection path
// without changing anything a caller does with it.
#[allow(clippy::result_large_err)]
fn node_device_token(headers: &HeaderMap) -> Result<&str, Response> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            error_response(
                StatusCode::UNAUTHORIZED,
                "Edge Node requires Authorization: Bearer <device-token>",
            )
        })?;
    Ok(token)
}

// Axum handlers use `Response` directly as their rejection type throughout this boundary.
#[allow(clippy::result_large_err)]
fn edge_claim_token(headers: &HeaderMap) -> Result<&str, Response> {
    headers
        .get("x-morphz-claim-token")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            error_response(
                StatusCode::UNAUTHORIZED,
                "Edge Artifact channel requires x-morphz-claim-token",
            )
        })
}

async fn handle_get_context_working_set(
    State(state): State<Arc<AppState>>,
    Path(context_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state.runtime.get_context(&context_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "Context does not exist"),
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
    let sessions = match state
        .runtime
        .list_context_sessions(&context_id, false)
        .await
    {
        Ok(sessions) => sessions,
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let active_session_id = match query.session_id {
        Some(session_id) => {
            match sessions.iter().find(|session| session.id == session_id) {
                Some(_) => session_id,
                None => return error_response(
                    StatusCode::BAD_REQUEST,
                    "session_id does not belong to the target Context, or the Session is archived",
                ),
            }
        }
        None => match sessions
            .iter()
            .max_by(|left, right| {
                left.last_activity_at
                    .cmp(&right.last_activity_at)
                    .then_with(|| right.id.cmp(&left.id))
            })
            .map(|session| session.id.clone())
        {
            Some(session_id) => session_id,
            None => return error_response(StatusCode::CONFLICT, "Context has no active Session"),
        },
    };
    match state
        .runtime
        .context_encoding(&context_id, &active_session_id)
        .await
    {
        Ok(context) => Json(json!({
            "context_id": context_id,
            "active_session_id": active_session_id,
            "working_set": context.session_working_set,
            "session_directory": context.sessions,
            "active_activations": context.active_activations,
            "pressure": context.pressure,
            "context_version": context.state.version,
        }))
        .into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn handle_get_context_activations(
    State(state): State<Arc<AppState>>,
    Path(context_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state.runtime.get_context(&context_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "Context does not exist"),
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
    match state.runtime.active_thread_activations(&context_id).await {
        Ok(activations) => Json(json!({
            "context_id": context_id,
            "activations": activations,
        }))
        .into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn handle_get_context_overview(
    State(state): State<Arc<AppState>>,
    Path(context_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<ContextOverviewHttpQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state
        .sdk
        .context_overview(
            &context_id,
            ContextOverviewQuery {
                active_session_id: query.session_id,
                include_scheduler_summary: query.include_scheduler_summary,
            },
        )
        .await
    {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_get_runtime_overview(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<RuntimeOverviewHttpQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state
        .sdk
        .runtime_overview(RuntimeOverviewQuery {
            include_archived: query.include_archived,
            context_limit: query.context_limit,
            sessions_per_context: query.sessions_per_context,
            context_id: query.context_id,
        })
        .await
    {
        Ok(overview) => Json(overview).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_get_model_usage(
    State(state): State<Arc<AppState>>,
    Path(context_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<ModelUsageHttpQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state
        .sdk
        .model_usage(
            &context_id,
            ModelUsageQuery {
                session_id: query.session_id,
                before_sequence: query.before_sequence,
                limit: query.limit,
            },
        )
        .await
    {
        Ok(page) => Json(page).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_get_scheduler_snapshot(
    State(state): State<Arc<AppState>>,
    Path(context_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<SchedulerSnapshotHttpQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state
        .sdk
        .scheduler_snapshot(
            &context_id,
            SchedulerQuery {
                include_terminal: query.include_terminal,
                limit: query.limit.unwrap_or(200),
            },
        )
        .await
    {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) if error.to_string().contains("does not exist") => {
            error_response(StatusCode::NOT_FOUND, error.to_string())
        }
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn handle_list_attention_acknowledgements(
    State(state): State<Arc<AppState>>,
    Path(context_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AttentionAcknowledgementsQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state
        .sdk
        .attention_acknowledgements_page(
            &context_id,
            query.after_sequence,
            query.limit.unwrap_or(250),
        )
        .await
    {
        Ok(page) => Json(json!({
            "context_id": context_id,
            "acknowledgements": page.acknowledgements,
            "latest_sequence": page.latest_sequence,
            "has_more": page.has_more,
        }))
        .into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_acknowledge_attention(
    State(state): State<Arc<AppState>>,
    Path(context_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<AcknowledgeAttentionRequest>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state
        .sdk
        .acknowledge_attention(
            &context_id,
            AcknowledgeAttentionCommand {
                key: request.key,
                source_kind: request.source_kind,
                source_id: request.source_id,
                source_revision: request.source_revision,
                rationale: request.rationale,
            },
        )
        .await
    {
        Ok(acknowledgement) => Json(acknowledgement).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_get_thread_detail(
    State(state): State<Arc<AppState>>,
    Path((context_id, thread_id)): Path<(String, String)>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state.sdk.thread_detail(&context_id, &thread_id).await {
        Ok(detail) => Json(detail).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_control_thread(
    State(state): State<Arc<AppState>>,
    Path((context_id, thread_id)): Path<(String, String)>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<ControlThreadRequest>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let reason = request
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .unwrap_or("the user controlled the Thread through the Dashboard");
    match state
        .sdk
        .control_thread(
            &context_id,
            &thread_id,
            request.expected_revision,
            request.action,
            reason,
        )
        .await
    {
        Ok(ThreadMutation::Updated(thread)) => Json(json!({
            "updated": true,
            "thread": thread,
        }))
        .into_response(),
        Ok(ThreadMutation::Conflict { current }) => (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "Thread revision conflict; refresh and retry",
                "current": current,
            })),
        )
            .into_response(),
        Ok(ThreadMutation::NotFound) => {
            error_response(StatusCode::NOT_FOUND, "Thread does not exist")
        }
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_supersede_thread(
    State(state): State<Arc<AppState>>,
    Path((context_id, thread_id)): Path<(String, String)>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<SupersedeThreadRequest>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let reason = request
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .unwrap_or("the user revised the Thread through the Dashboard");
    match state
        .sdk
        .supersede_thread(
            &context_id,
            &thread_id,
            request.expected_revision,
            &request.intent,
            reason,
        )
        .await
    {
        Ok(ThreadMutation::Updated(thread)) => Json(json!({
            "updated": true,
            "thread": thread,
        }))
        .into_response(),
        Ok(ThreadMutation::Conflict { current }) => (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "Thread revision conflict; refresh and retry",
                "current": current,
            })),
        )
            .into_response(),
        Ok(ThreadMutation::NotFound) => {
            error_response(StatusCode::NOT_FOUND, "Thread does not exist")
        }
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_query_event_history(
    State(state): State<Arc<AppState>>,
    Path(context_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<EventHistoryHttpQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state
        .sdk
        .query_event_history(EventHistoryQuery {
            context_id,
            session_id: query.session_id,
            principal_id: query.principal_id,
            thread_id: query.thread_id,
            activation_id: query.activation_id,
            actor: query.actor,
            event_type: query.event_type,
            topic: query.topic,
            search_query: query.query,
            after_sequence: query.after_sequence,
            before_sequence: query.before_sequence,
            start_time: query.start_time,
            end_time: query.end_time,
            limit: query.limit.unwrap_or(100),
        })
        .await
    {
        Ok(page) => Json(page).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_audit_mind_projection(
    State(state): State<Arc<AppState>>,
    Path(context_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state.sdk.audit_mind_projection(&context_id).await {
        Ok(audit) => Json(audit).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_mutate_schedule(
    State(state): State<Arc<AppState>>,
    Path(schedule_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<MutateScheduleRequest>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let action = request.action.trim().to_ascii_lowercase();
    let mutation = match action.as_str() {
        "pause" => {
            state
                .runtime
                .pause_schedule(&schedule_id, request.expected_revision)
                .await
        }
        "resume" => {
            state
                .runtime
                .resume_schedule(&schedule_id, request.expected_revision)
                .await
        }
        "reschedule" => {
            state
                .runtime
                .reschedule(
                    &schedule_id,
                    request.expected_revision,
                    request.not_before,
                    request.interval_seconds,
                )
                .await
        }
        "cancel" => {
            state
                .runtime
                .cancel_schedule(&schedule_id, request.expected_revision)
                .await
        }
        _ => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "action supports only pause, resume, reschedule, or cancel",
            )
        }
    };
    match mutation {
        Ok(ScheduleMutation::Updated(schedule)) => Json(json!({
            "outcome": "updated",
            "schedule": schedule,
        }))
        .into_response(),
        Ok(ScheduleMutation::Conflict { current }) => (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "Schedule revision was updated by another writer",
                "outcome": "conflict",
                "schedule": current,
            })),
        )
            .into_response(),
        Ok(ScheduleMutation::Rejected { current, reason }) => (
            StatusCode::CONFLICT,
            Json(json!({
                "error": reason,
                "outcome": "rejected",
                "schedule": current,
            })),
        )
            .into_response(),
        Ok(ScheduleMutation::NotFound) => {
            error_response(StatusCode::NOT_FOUND, "Schedule does not exist")
        }
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn handle_create_context(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<CreateContextRequest>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let id = request.id.unwrap_or_else(|| api_id("context"));
    if let Err(error) = validate_identifier("context_id", &id) {
        return error_response(StatusCode::BAD_REQUEST, error);
    }
    let agent_id = request
        .agent_id
        .unwrap_or_else(|| state.default_agent_id.clone());
    if let Err(error) = validate_identifier("agent_id", &agent_id) {
        return error_response(StatusCode::BAD_REQUEST, error);
    }
    match state.runtime.get_agent(&agent_id).await {
        Ok(Some(_)) => {}
        Ok(None) => {
            return error_response(
                StatusCode::NOT_FOUND,
                format!(
                    "Agent '{}' does not exist; call create_agent first",
                    agent_id
                ),
            )
        }
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
    let title = request
        .title
        .unwrap_or_else(|| "New Cognitive Context".to_string())
        .trim()
        .chars()
        .take(200)
        .collect::<String>();
    match state
        .sdk
        .create_context(NewCognitiveContext {
            id,
            agent_id,
            title,
        })
        .await
    {
        Ok(context) => (StatusCode::CREATED, Json(context)).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_update_context(
    State(state): State<Arc<AppState>>,
    Path(context_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<UpdateContextRequest>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let title = request
        .title
        .map(|title| title.trim().chars().take(200).collect::<String>());
    if title.as_deref() == Some("") {
        return error_response(StatusCode::BAD_REQUEST, "title must not be empty");
    }
    match state
        .sdk
        .update_context(
            &context_id,
            ContextUpdate {
                title,
                status: request.status,
            },
        )
        .await
    {
        Ok(context) => Json(context).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_get_context_token_budget(
    State(state): State<Arc<AppState>>,
    Path(context_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let budget = if let Some(session_id) = query.session_id.as_deref() {
        state
            .sdk
            .context_token_budget_for_session(&context_id, session_id)
            .await
    } else {
        state.sdk.context_token_budget(&context_id).await
    };
    match budget {
        Ok(budget) => Json(budget).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_update_context_token_budget(
    State(state): State<Arc<AppState>>,
    Path(context_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<UpdateContextTokenBudgetRequest>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    if request.requested_hard_token_limit == Some(0) {
        return error_response(
            StatusCode::BAD_REQUEST,
            "requested_hard_token_limit must be greater than 0; use null to restore automatic mode",
        );
    }
    match state
        .sdk
        .update_context_token_budget(
            &context_id,
            request.requested_hard_token_limit,
            request.expected_revision,
        )
        .await
    {
        Ok(crate::runtime::ContextTokenBudgetUpdate::Updated(budget)) => {
            Json(json!({ "outcome": "updated", "budget": budget })).into_response()
        }
        Ok(crate::runtime::ContextTokenBudgetUpdate::Conflict(budget)) => (
            StatusCode::CONFLICT,
            Json(json!({
                "outcome": "conflict",
                "error": "Context token budget was updated by another writer",
                "budget": budget,
            })),
        )
            .into_response(),
        Ok(crate::runtime::ContextTokenBudgetUpdate::NotFound) => {
            error_response(StatusCode::NOT_FOUND, "Context does not exist")
        }
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_get_context_capability_binding(
    State(state): State<Arc<AppState>>,
    Path((context_id, capability_id)): Path<(String, String)>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let feature = match crate::experimental::feature(&capability_id) {
        Ok(feature) => feature,
        Err(error) => return error_response(StatusCode::BAD_REQUEST, error.to_string()),
    };
    match state.runtime.get_context(&context_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "Context does not exist"),
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
    let feature_status = match state.runtime.experimental_feature_statuses() {
        Ok(statuses) => statuses
            .into_iter()
            .find(|status| status.name == feature.name),
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    match state
        .sdk
        .context_capability_binding(&context_id, feature.name)
        .await
    {
        Ok(binding) => Json(json!({
            "context_id": context_id,
            "capability_id": feature.name,
            "enabled": binding.as_ref().is_some_and(|binding| binding.enabled),
            "revision": binding.as_ref().map_or(0, |binding| binding.revision),
            "updated_at": binding.as_ref().map(|binding| binding.updated_at),
            "feature": feature_status,
        }))
        .into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_update_context_capability_binding(
    State(state): State<Arc<AppState>>,
    Path((context_id, capability_id)): Path<(String, String)>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<UpdateContextCapabilityBindingRequest>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let feature = match crate::experimental::feature(&capability_id) {
        Ok(feature) => feature,
        Err(error) => return error_response(StatusCode::BAD_REQUEST, error.to_string()),
    };
    match state
        .sdk
        .update_context_capability_binding(
            &context_id,
            feature.name,
            request.enabled,
            request.expected_revision,
        )
        .await
    {
        Ok(crate::runtime::ContextCapabilityBindingUpdate::Updated(binding)) => {
            Json(json!({ "outcome": "updated", "binding": binding })).into_response()
        }
        Ok(crate::runtime::ContextCapabilityBindingUpdate::Conflict(binding)) => (
            StatusCode::CONFLICT,
            Json(json!({
                "outcome": "conflict",
                "error": "Context capability binding was updated by another writer",
                "binding": binding,
            })),
        )
            .into_response(),
        Ok(crate::runtime::ContextCapabilityBindingUpdate::NotFound) => {
            error_response(StatusCode::NOT_FOUND, "Context does not exist")
        }
        Err(error) => error_response(StatusCode::CONFLICT, error.to_string()),
    }
}

async fn handle_cognitive_coordination_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> Response {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    #[cfg(feature = "experimental-cognitive-coordination")]
    {
        let Some(service) = state.runtime.cognitive_coordination_network() else {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "Cognitive Coordination has no configured local participant",
            );
        };
        let local = match build_cognitive_coordination_advertisement(&state, &service).await {
            Ok(advertisement) => Some(advertisement),
            Err(error) => {
                return error_response(StatusCode::SERVICE_UNAVAILABLE, error.to_string())
            }
        };
        let peers = service.refresh_peer_statuses().await;
        let active = match service.list_assignments(false, 10_000).await {
            Ok(assignments) => assignments,
            Err(error) => {
                return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
            }
        };
        let mut assignments = active.clone();
        let mut assignment_ids = assignments
            .iter()
            .map(|assignment| assignment.id.clone())
            .collect::<std::collections::HashSet<_>>();
        let recent = match service.list_assignments(true, 50).await {
            Ok(assignments) => assignments,
            Err(error) => {
                return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
            }
        };
        assignments.extend(
            recent
                .into_iter()
                .filter(|assignment| assignment_ids.insert(assignment.id.clone())),
        );
        // The global control surface needs lifecycle and routing metadata, not
        // the potentially large or sensitive protocol input/output payloads.
        let assignment_summaries = assignments
            .iter()
            .map(|assignment| {
                json!({
                    "id": assignment.id,
                    "kind": assignment.kind,
                    "external_id": assignment.external_id,
                    "context_id": assignment.context_id,
                    "session_id": assignment.session_id,
                    "role": assignment.role,
                    "request_id": assignment.request_id,
                    "objective_id": assignment.objective_id,
                    "counterparty_id": assignment.counterparty_id,
                    "summary": assignment.summary,
                    "status": assignment.status,
                    "status_reason": assignment.status_reason,
                    "lease_expires_at": assignment.lease_expires_at,
                    "updated_at": assignment.updated_at,
                })
            })
            .collect::<Vec<_>>();
        Json(json!({
            "available": true,
            "local": local,
            "active_assignments": active.len(),
            "assignments": assignment_summaries,
            "peers": peers,
        }))
        .into_response()
    }
    #[cfg(not(feature = "experimental-cognitive-coordination"))]
    error_response(
        StatusCode::NOT_IMPLEMENTED,
        "Cognitive Coordination was not compiled into this Runtime",
    )
}

async fn handle_cognitive_coordination_handshake(
    State(state): State<Arc<AppState>>,
    Json(value): Json<Value>,
) -> Response {
    #[cfg(not(feature = "experimental-cognitive-coordination"))]
    let _ = (&state, &value);
    #[cfg(feature = "experimental-cognitive-coordination")]
    {
        use crate::experimental::cognitive_coordination_network::{
            AuthenticatedEnvelope, HandshakeRequest,
        };
        let Some(service) = state.runtime.cognitive_coordination_network() else {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "Cognitive Coordination participant is not configured",
            );
        };
        let envelope: AuthenticatedEnvelope<HandshakeRequest> = match serde_json::from_value(value)
        {
            Ok(envelope) => envelope,
            Err(error) => return error_response(StatusCode::BAD_REQUEST, error.to_string()),
        };
        if let Err(error) = service
            .verify_incoming_handshake(&envelope, envelope.payload.sender_endpoint.as_deref())
            .await
        {
            return error_response(StatusCode::UNAUTHORIZED, error.to_string());
        }
        let local_authority = match service.local_authority_id() {
            Ok(authority) => authority,
            Err(error) => {
                return error_response(StatusCode::SERVICE_UNAVAILABLE, error.to_string())
            }
        };
        if (envelope.payload.expected_authority_id != local_authority
            && !(service.mesh_enabled() && envelope.payload.expected_authority_id.is_empty()))
            || envelope.payload.protocol_version
                != crate::experimental::cognitive_coordination::EXPERIMENT_SPEC_VERSION
        {
            return error_response(
                StatusCode::CONFLICT,
                "Cognitive Coordination target Authority or protocol version mismatch",
            );
        }
        let advertisement = match build_cognitive_coordination_advertisement(&state, &service).await
        {
            Ok(advertisement) => advertisement,
            Err(error) => {
                return error_response(StatusCode::SERVICE_UNAVAILABLE, error.to_string())
            }
        };
        return match service.sign_response_to(&envelope.authority_id, advertisement) {
            Ok(response) => Json(response).into_response(),
            Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        };
    }
    #[cfg(not(feature = "experimental-cognitive-coordination"))]
    error_response(
        StatusCode::NOT_IMPLEMENTED,
        "Cognitive Coordination was not compiled into this Runtime",
    )
}

async fn handle_cognitive_coordination_identity(State(state): State<Arc<AppState>>) -> Response {
    #[cfg(feature = "experimental-cognitive-coordination")]
    {
        let Some(service) = state.runtime.cognitive_coordination_network() else {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "Coordination Mesh is not configured",
            );
        };
        return match service.identity_advertisement() {
            Ok(advertisement) => Json(advertisement).into_response(),
            Err(error) => error_response(StatusCode::SERVICE_UNAVAILABLE, error.to_string()),
        };
    }
    #[cfg(not(feature = "experimental-cognitive-coordination"))]
    {
        let _ = state;
        error_response(
            StatusCode::NOT_IMPLEMENTED,
            "Cognitive Coordination was not compiled into this Runtime",
        )
    }
}

async fn handle_cognitive_coordination_projection(
    State(state): State<Arc<AppState>>,
    Json(value): Json<Value>,
) -> Response {
    #[cfg(not(feature = "experimental-cognitive-coordination"))]
    let _ = (&state, &value);
    #[cfg(feature = "experimental-cognitive-coordination")]
    {
        use crate::experimental::cognitive_coordination::stable_digest;
        use crate::experimental::cognitive_coordination_network::{
            AuthenticatedEnvelope, ProjectionRequest,
        };
        let Some(service) = state.runtime.cognitive_coordination_network() else {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "participant is not configured",
            );
        };
        let envelope: AuthenticatedEnvelope<ProjectionRequest> = match serde_json::from_value(value)
        {
            Ok(envelope) => envelope,
            Err(error) => return error_response(StatusCode::BAD_REQUEST, error.to_string()),
        };
        if let Err(error) = service.verify_incoming(&envelope) {
            return error_response(StatusCode::UNAUTHORIZED, error.to_string());
        }
        let participant = match service.participant_config() {
            Ok(participant) => participant,
            Err(error) => {
                return error_response(StatusCode::SERVICE_UNAVAILABLE, error.to_string())
            }
        };
        if envelope.payload.target_authority_id != participant.authority_id {
            return error_response(StatusCode::CONFLICT, "projection target Authority mismatch");
        }
        let execution_session_id = coordination_evaluation_session_id(
            &envelope.payload.request_id,
            &participant.authority_id,
        );
        if let Err(error) = ensure_coordination_evaluation_session(
            &state,
            participant,
            &execution_session_id,
            &envelope.payload.request_id,
        )
        .await
        {
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
        let projection = match state
            .sdk
            .context_projection_as_operator(&participant.context_id, &execution_session_id)
            .await
        {
            Ok(projection) => projection,
            Err(error) => return sdk_error_response(error),
        };
        let digest = match stable_digest(&projection) {
            Ok(digest) => digest,
            Err(error) => {
                return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
            }
        };
        let snapshot = crate::experimental::cognitive_coordination::ProjectionSnapshot {
            context_id: participant.context_id.clone(),
            session_id: execution_session_id,
            context_version: projection.state.version,
            digest,
        };
        return match service.sign_response_to(&envelope.authority_id, snapshot) {
            Ok(response) => Json(response).into_response(),
            Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        };
    }
    #[cfg(not(feature = "experimental-cognitive-coordination"))]
    error_response(
        StatusCode::NOT_IMPLEMENTED,
        "Cognitive Coordination was not compiled into this Runtime",
    )
}

async fn handle_cognitive_coordination_evaluate(
    State(state): State<Arc<AppState>>,
    Json(value): Json<Value>,
) -> Response {
    #[cfg(not(feature = "experimental-cognitive-coordination"))]
    let _ = (&state, &value);
    #[cfg(feature = "experimental-cognitive-coordination")]
    {
        use crate::experimental::cognitive_coordination::CognitiveEvaluationTransport as _;
        use crate::experimental::cognitive_coordination_network::{
            AuthenticatedEnvelope, RemoteEvaluationRequest, RemoteEvaluationResponse,
            COORDINATION_ASSIGNMENT_PARTICIPANT_ROLE,
        };
        use crate::memory::WorkAssignmentStatus;
        let Some(service) = state.runtime.cognitive_coordination_network() else {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "participant is not configured",
            );
        };
        let envelope: AuthenticatedEnvelope<RemoteEvaluationRequest> =
            match serde_json::from_value(value) {
                Ok(envelope) => envelope,
                Err(error) => return error_response(StatusCode::BAD_REQUEST, error.to_string()),
            };
        if let Err(error) = service.verify_incoming(&envelope) {
            return error_response(StatusCode::UNAUTHORIZED, error.to_string());
        }
        let sender_authority_id = envelope.authority_id.clone();
        let participant = match service.participant_config() {
            Ok(participant) => participant.clone(),
            Err(error) => {
                return error_response(StatusCode::SERVICE_UNAVAILABLE, error.to_string())
            }
        };
        let assignment = envelope.payload.assignment;
        if assignment.participant.authority_id != participant.authority_id
            || assignment.participant.agent_id != participant.agent_id
            || assignment.participant.context_id != participant.context_id
        {
            return error_response(
                StatusCode::CONFLICT,
                "Evaluation Assignment does not match this participant's advertised identity",
            );
        }
        let advertisement = match build_cognitive_coordination_advertisement(&state, &service).await
        {
            Ok(advertisement) => advertisement,
            Err(error) => {
                return error_response(StatusCode::SERVICE_UNAVAILABLE, error.to_string())
            }
        };
        if let Err(error) = validate_remote_model_request(
            &assignment.model,
            &advertisement.participant.model_profiles,
        ) {
            return error_response(StatusCode::BAD_REQUEST, error);
        }
        let ephemeral_session_id =
            coordination_evaluation_session_id(&assignment.request_id, &participant.authority_id);
        if assignment.participant.session_id != ephemeral_session_id
            || assignment.projection.session_id != ephemeral_session_id
            || assignment.projection.context_id != participant.context_id
        {
            return error_response(
                StatusCode::CONFLICT,
                "Evaluation Assignment does not match its request-scoped execution Session",
            );
        }
        if let Err(error) = ensure_coordination_evaluation_session(
            &state,
            &participant,
            &ephemeral_session_id,
            &assignment.request_id,
        )
        .await
        {
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
        let assignment_start = match service
            .begin_assignment(
                &assignment,
                &participant.agent_id,
                &participant.context_id,
                &ephemeral_session_id,
                COORDINATION_ASSIGNMENT_PARTICIPANT_ROLE,
                &sender_authority_id,
            )
            .await
        {
            Ok(record) => record,
            Err(error) => {
                return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
            }
        };
        if let Some(existing) = assignment_start.as_ref().filter(|result| !result.created) {
            if existing.record.status == WorkAssignmentStatus::Succeeded {
                if let Some(output) = existing.record.output.clone() {
                    let draft = match serde_json::from_value(output) {
                        Ok(draft) => draft,
                        Err(error) => {
                            return error_response(
                                StatusCode::INTERNAL_SERVER_ERROR,
                                error.to_string(),
                            )
                        }
                    };
                    let response = RemoteEvaluationResponse {
                        draft,
                        effective_model: assignment.model,
                    };
                    return match service.sign_response_to(&sender_authority_id, response) {
                        Ok(response) => Json(response).into_response(),
                        Err(error) => {
                            error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
                        }
                    };
                }
            }
            return error_response(
                StatusCode::CONFLICT,
                format!(
                    "Evaluation Assignment '{}' already has status '{}' and cannot execute twice",
                    existing.record.external_id,
                    existing.record.status.as_str(),
                ),
            );
        }
        let assignment_record = assignment_start.map(|result| result.record);
        service.register_active_assignment(&assignment.assignment_id, &ephemeral_session_id);
        let permit = match crate::experimental::require_enabled(
            &state.runtime.config().experimental.enabled,
            crate::experimental::COGNITIVE_COORDINATION,
        ) {
            Ok(permit) => permit,
            Err(error) => {
                return error_response(StatusCode::SERVICE_UNAVAILABLE, error.to_string())
            }
        };
        let transport =
            crate::experimental::cognitive_coordination_sdk::SdkEvaluationTransport::new(
                permit,
                state.sdk.clone(),
                state.sdk.default_principal().clone(),
                service.request_timeout(),
            );
        let evaluated = transport.evaluate(&assignment).await;
        service.finish_active_assignment(&assignment.assignment_id);
        let draft = match evaluated {
            Ok(draft) => {
                let persisted = match service
                    .transition_assignment(
                        assignment_record,
                        WorkAssignmentStatus::Succeeded,
                        serde_json::to_value(&draft).ok(),
                        None,
                    )
                    .await
                {
                    Ok(record) => record,
                    Err(error) => {
                        return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
                    }
                };
                if let Some(record) = persisted {
                    if record.status != WorkAssignmentStatus::Succeeded {
                        return error_response(
                            StatusCode::CONFLICT,
                            format!(
                                "Evaluation Assignment '{}' completed locally after its durable status became '{}'",
                                record.external_id,
                                record.status.as_str(),
                            ),
                        );
                    }
                }
                draft
            }
            Err(error) => {
                if let Err(store_error) = service
                    .transition_assignment(
                        assignment_record,
                        WorkAssignmentStatus::Failed,
                        None,
                        Some(error.to_string()),
                    )
                    .await
                {
                    return error_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!(
                            "{error}; additionally failed to persist Assignment outcome: {store_error}"
                        ),
                    );
                }
                let _ = state
                    .runtime
                    .cancel_session_durable(
                        &ephemeral_session_id,
                        "remote Cognitive Coordination Evaluation failed or timed out",
                    )
                    .await;
                return error_response(StatusCode::BAD_GATEWAY, error.to_string());
            }
        };
        let response = RemoteEvaluationResponse {
            draft,
            effective_model: assignment.model,
        };
        return match service.sign_response_to(&sender_authority_id, response) {
            Ok(response) => Json(response).into_response(),
            Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        };
    }
    #[cfg(not(feature = "experimental-cognitive-coordination"))]
    error_response(
        StatusCode::NOT_IMPLEMENTED,
        "Cognitive Coordination was not compiled into this Runtime",
    )
}

async fn handle_cognitive_coordination_cancel(
    State(state): State<Arc<AppState>>,
    Json(value): Json<Value>,
) -> Response {
    #[cfg(not(feature = "experimental-cognitive-coordination"))]
    let _ = (&state, &value);
    #[cfg(feature = "experimental-cognitive-coordination")]
    {
        use crate::experimental::cognitive_coordination_network::{
            AuthenticatedEnvelope, CancelEvaluationRequest, CancelEvaluationResponse,
        };
        use crate::memory::WorkAssignmentStatus;
        let Some(service) = state.runtime.cognitive_coordination_network() else {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "participant is not configured",
            );
        };
        let envelope: AuthenticatedEnvelope<CancelEvaluationRequest> =
            match serde_json::from_value(value) {
                Ok(envelope) => envelope,
                Err(error) => return error_response(StatusCode::BAD_REQUEST, error.to_string()),
            };
        if let Err(error) = service.verify_incoming(&envelope) {
            return error_response(StatusCode::UNAUTHORIZED, error.to_string());
        }
        let sender_authority_id = envelope.authority_id.clone();
        if service.local_authority_id().ok() != Some(envelope.payload.target_authority_id.as_str())
        {
            return error_response(
                StatusCode::CONFLICT,
                "cancellation target Authority mismatch",
            );
        }
        let assignment_record = match service
            .participant_assignment(&envelope.payload.assignment_id)
            .await
        {
            Ok(record) => record,
            Err(error) => {
                return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
            }
        };
        let transitioned = match service
            .transition_assignment(
                assignment_record.clone(),
                WorkAssignmentStatus::Cancelled,
                None,
                Some("Remote coordinator cancelled this Cognitive Evaluation".to_string()),
            )
            .await
        {
            Ok(record) => record,
            Err(error) => {
                return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
            }
        };
        let cancellation_won = transitioned
            .as_ref()
            .is_some_and(|record| record.status == WorkAssignmentStatus::Cancelled);
        let session_id = service
            .active_assignment_session(&envelope.payload.assignment_id)
            .or_else(|| {
                assignment_record
                    .as_ref()
                    .filter(|record| !record.status.is_terminal())
                    .map(|record| record.session_id.clone())
            });
        let cancelled = if cancellation_won {
            if let Some(session_id) = session_id {
                match state
                    .runtime
                    .cancel_session_durable(
                        &session_id,
                        "remote coordinator cancelled this Cognitive Evaluation",
                    )
                    .await
                {
                    Ok(_) => true,
                    Err(error) => {
                        return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
                    }
                }
            } else {
                true
            }
        } else {
            false
        };
        service.finish_active_assignment(&envelope.payload.assignment_id);
        return match service.sign_response_to(
            &sender_authority_id,
            CancelEvaluationResponse {
                assignment_id: envelope.payload.assignment_id,
                cancelled,
            },
        ) {
            Ok(response) => Json(response).into_response(),
            Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        };
    }
    #[cfg(not(feature = "experimental-cognitive-coordination"))]
    error_response(
        StatusCode::NOT_IMPLEMENTED,
        "Cognitive Coordination was not compiled into this Runtime",
    )
}

#[cfg(feature = "experimental-cognitive-coordination")]
async fn build_cognitive_coordination_advertisement(
    state: &AppState,
    service: &crate::experimental::cognitive_coordination_network::CognitiveCoordinationNetworkService,
) -> Result<
    crate::experimental::cognitive_coordination_network::HandshakeAdvertisement,
    Box<dyn std::error::Error + Send + Sync>,
> {
    use crate::experimental::cognitive_coordination::{
        ModelExecutionProfile, ParticipantDescriptor, EXPERIMENT_SPEC_VERSION,
    };
    let participant = service.participant_config()?;
    if state.runtime.identity().agent_id != participant.agent_id
        || state.runtime.identity().context_id != participant.context_id
    {
        return Err("configured participant Agent/Context identity is inconsistent".into());
    }
    let effective_default = state.runtime.model();
    let mut allowed = participant.allowed_model_routes.clone();
    allowed.insert(effective_default);
    let max_output_tokens = state.runtime.config().llm.max_output_tokens.map(u64::from);
    let model_profiles = state
        .runtime
        .inference_model_options()
        .await?
        .into_iter()
        .filter(|option| allowed.contains(&option.id))
        .map(|option| ModelExecutionProfile {
            route: option.id,
            label: option.label,
            physical_models: option.physical_models,
            supported_reasoning_efforts: option.supported_reasoning_efforts,
            context_window: None,
            max_output_tokens,
        })
        .collect();
    let issued_at = chrono::Utc::now();
    let expires_at =
        issued_at + chrono::Duration::seconds(i64::try_from(service.config().handshake_ttl_secs)?);
    Ok(
        crate::experimental::cognitive_coordination_network::HandshakeAdvertisement {
            protocol_version: EXPERIMENT_SPEC_VERSION.to_string(),
            supported_operations: vec!["evaluate".to_string(), "cancel".to_string()],
            participant: ParticipantDescriptor {
                authority_id: participant.authority_id.clone(),
                agent_id: participant.agent_id.clone(),
                context_id: participant.context_id.clone(),
                session_id: String::new(),
                capabilities: participant.capabilities.clone(),
                model_profiles,
                default_model:
                    crate::experimental::cognitive_coordination::EvaluationModelRequest {
                        route: Some(state.runtime.model()),
                        reasoning_effort: state
                            .runtime
                            .effective_reasoning_effort()
                            .map(|effort| effort.as_str().to_string()),
                    },
                max_token_budget: participant.max_token_budget,
                priority: participant.priority,
                enabled: true,
            },
            issued_at,
            expires_at,
        },
    )
}

#[cfg(feature = "experimental-cognitive-coordination")]
fn validate_remote_model_request(
    request: &crate::experimental::cognitive_coordination::EvaluationModelRequest,
    profiles: &[crate::experimental::cognitive_coordination::ModelExecutionProfile],
) -> Result<(), String> {
    if request.is_default() {
        return Ok(());
    }
    let eligible = profiles
        .iter()
        .filter(|profile| {
            request
                .route
                .as_deref()
                .is_none_or(|route| profile.route == route)
        })
        .collect::<Vec<_>>();
    if eligible.is_empty() {
        return Err("requested model route is not advertised by this participant".to_string());
    }
    if let Some(effort) = request.reasoning_effort.as_deref() {
        if !eligible.iter().any(|profile| {
            profile
                .supported_reasoning_efforts
                .as_ref()
                .is_some_and(|levels| levels.iter().any(|level| level == effort))
        }) {
            return Err(format!(
                "reasoning effort '{effort}' is not advertised by the requested model route"
            ));
        }
    }
    Ok(())
}

#[cfg(feature = "experimental-cognitive-coordination")]
fn coordination_evaluation_session_id(request_id: &str, authority_id: &str) -> String {
    let digest = Sha256::digest(format!("{request_id}\0{authority_id}").as_bytes());
    format!(
        "coord-eval-{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&digest[..18])
    )
}

#[cfg(feature = "experimental-cognitive-coordination")]
async fn ensure_coordination_evaluation_session(
    state: &AppState,
    participant: &crate::config::CognitiveCoordinationParticipantConfig,
    session_id: &str,
    request_id: &str,
) -> Result<(), crate::runtime::RuntimeError> {
    state
        .runtime
        .ensure_session(NewSession {
            id: session_id.to_string(),
            agent_id: participant.agent_id.clone(),
            context_id: participant.context_id.clone(),
            parent_session_id: None,
            title: format!("Coordination {request_id}"),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await?;
    Ok(())
}

async fn handle_create_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<CreateSessionRequest>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, None) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    let id = request.id.unwrap_or_else(|| api_id("session"));
    if let Err(error) = validate_identifier("session_id", &id) {
        return error_response(StatusCode::BAD_REQUEST, error);
    }
    if let Some(parent) = request.parent_session_id.as_deref() {
        if let Err(error) = validate_identifier("parent_session_id", parent) {
            return error_response(StatusCode::BAD_REQUEST, error);
        }
    }
    match state.runtime.get_session(&id).await {
        Ok(Some(_)) => return error_response(StatusCode::CONFLICT, "Session ID already exists"),
        Ok(None) => {}
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
    // Resolve deterministic identity and parent authorization before creating
    // a requested Context. Otherwise a rejected Principal provider or foreign
    // parent can leave an orphan Context even though Session creation fails.
    if let Err(error) = state.runtime.ensure_principal(principal.clone()).await {
        return error_response(StatusCode::CONFLICT, error.to_string());
    }
    if let Some(parent_session_id) = request.parent_session_id.as_deref() {
        if let Err(error) = state
            .sdk
            .get_session(&principal.principal_id, parent_session_id)
            .await
        {
            return sdk_error_response(error);
        }
    }
    let mount = match resolve_context_mount(&state, request.agent_id, request.mount).await {
        Ok(mount) => mount,
        Err((status, error)) => return error_response(status, error),
    };
    match state
        .sdk
        .create_session(
            principal,
            NewSession {
                id,
                agent_id: mount.agent_id,
                context_id: mount.context_id,
                parent_session_id: request.parent_session_id,
                title: bounded_title(request.title, "New Session"),
                mount_kind: mount.mount_kind,
            },
        )
        .await
    {
        Ok(session) => (StatusCode::CREATED, Json(session)).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_create_independent_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<CreateIndependentSessionRequest>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, None) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    let session_id = request.session_id.unwrap_or_else(|| api_id("session"));
    if let Err(error) = validate_identifier("session_id", &session_id) {
        return error_response(StatusCode::BAD_REQUEST, error);
    }
    match state.runtime.get_session(&session_id).await {
        Ok(Some(_)) => return error_response(StatusCode::CONFLICT, "Session ID already exists"),
        Ok(None) => {}
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
    let mount = match resolve_context_mount(
        &state,
        None,
        Some(ContextMountRequest::NewContextFromMind {
            source_context_id: request.source_context_id,
            source_version: request.source_version,
            context_id: request.context_id,
            context_title: request.context_title,
        }),
    )
    .await
    {
        Ok(mount) => mount,
        Err((status, error)) => return error_response(status, error),
    };
    let context = match state.runtime.get_context(&mount.context_id).await {
        Ok(Some(context)) => context,
        Ok(None) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Seed Context could not be read after creation",
            )
        }
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    match state
        .sdk
        .create_session(
            principal,
            NewSession {
                id: session_id,
                agent_id: mount.agent_id,
                context_id: mount.context_id,
                parent_session_id: None,
                title: bounded_title(request.session_title, "Independent Session"),
                mount_kind: SessionMountKind::NewContextFromMind,
            },
        )
        .await
    {
        Ok(session) => (
            StatusCode::CREATED,
            Json(json!({ "context": context, "session": session, "seed": mount.seed })),
        )
            .into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_get_session(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_read_principal(
        &state,
        &headers,
        query.token.as_deref(),
        query.principal_id.as_deref(),
    ) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    match state
        .sdk
        .get_session(&principal.principal_id, &session_id)
        .await
    {
        Ok(session) => Json(session).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

/// Returns the Session selection together with deployment availability. This
/// is intentionally richer than the global target directory so cloud clients
/// can distinguish "choose one of your devices" from "install morphz-edge".
async fn handle_get_session_execution_targets(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_read_principal(
        &state,
        &headers,
        query.token.as_deref(),
        query.principal_id.as_deref(),
    ) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    let session = match state
        .sdk
        .get_session(&principal.principal_id, &session_id)
        .await
    {
        Ok(session) => session,
        Err(error) => return sdk_error_response(error),
    };
    let targets = match state
        .sdk
        .list_execution_targets(&principal.principal_id)
        .await
    {
        Ok(targets) => targets,
        Err(error) => return sdk_error_response(error),
    };

    let local_enabled = state.runtime.config().execution_targets.local_enabled;
    let selected_target_id = session.default_target_id.as_deref();
    let selected_target = selected_target_id
        .and_then(|target_id| targets.iter().find(|target| target.id == target_id));
    let local_target = targets
        .iter()
        .find(|target| target.id == crate::execution_target::DEFAULT_EXECUTION_TARGET_ID);
    let user_targets = targets
        .iter()
        .filter(|target| target.kind != crate::memory::ExecutionTargetKind::InProcessLocal)
        .collect::<Vec<_>>();

    let (effective_target_id, selection_source, ready, reason) =
        if let Some(target_id) = selected_target_id {
            match selected_target {
                Some(target) if target.status.accepts_jobs() => {
                    (Some(target_id), "session", true, "ready")
                }
                Some(_) => (Some(target_id), "session", false, "selected_target_offline"),
                None => (
                    Some(target_id),
                    "session",
                    false,
                    "selected_target_unavailable",
                ),
            }
        } else if local_enabled {
            match local_target {
                Some(target) if target.status.accepts_jobs() => (
                    Some(crate::execution_target::DEFAULT_EXECUTION_TARGET_ID),
                    "runtime_local",
                    true,
                    "ready",
                ),
                _ => (
                    Some(crate::execution_target::DEFAULT_EXECUTION_TARGET_ID),
                    "runtime_local",
                    false,
                    "local_target_unavailable",
                ),
            }
        } else if user_targets.is_empty() {
            (None, "none", false, "execution_target_required")
        } else {
            (None, "none", false, "target_selection_required")
        };
    let onboarding_required = reason == "execution_target_required";

    Json(json!({
        "session_id": session.id,
        "selected_target_id": session.default_target_id,
        "effective_target_id": effective_target_id,
        "selection_source": selection_source,
        "ready": ready,
        "reason": reason,
        "local_default_enabled": local_enabled,
        "targets": targets,
        "onboarding": {
            "required": onboarding_required,
            "client": "morphz-edge",
            "pairing_endpoint": "/api/edge/pairing-codes",
            "documentation": "docs/morphz_edge_cli.md"
        }
    }))
    .into_response()
}

async fn handle_update_session(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<UpdateSessionRequest>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let title = request
        .title
        .map(|title| title.trim().chars().take(200).collect::<String>());
    if title.as_deref() == Some("") {
        return error_response(StatusCode::BAD_REQUEST, "title must not be empty");
    }
    let context_sharing = request.context_sharing;
    let permission_mode = request.permission_mode;
    let sandbox_mode = request.sandbox_mode;
    let default_target_id = match request.default_target_id {
        None => None,
        Some(value) if value.trim().is_empty() => Some(None),
        Some(value) => Some(Some(value.trim().to_string())),
    };
    if permission_mode == Some(crate::permission::PermissionMode::Custom) {
        return error_response(
            StatusCode::BAD_REQUEST,
            "custom permission mode requires a complete Runtime policy and is not a Session preset",
        );
    }
    let model_alias = match request.model_alias {
        None => None,
        Some(model) if model.trim().is_empty() => Some(None),
        Some(model) => {
            let model = model.trim().to_string();
            let options = match state.runtime.inference_model_options().await {
                Ok(options) => options,
                Err(error) => {
                    return error_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("failed to read the discovered and enabled model catalog: {error}"),
                    )
                }
            };
            if !options.iter().any(|option| option.id == model) {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    format!("model '{model}' is not in the discovered and enabled model catalog"),
                );
            }
            Some(Some(model))
        }
    };
    let reasoning_effort = match request.reasoning_effort {
        None => None,
        Some(value)
            if value.trim().is_empty()
                || value.trim() == "provider_default"
                || value.trim() == "default" =>
        {
            Some(None)
        }
        Some(value) => {
            let normalized = crate::llm::ReasoningEffort::parse(&value)
                .map(|effort| effort.as_str().to_string());
            let Some(normalized) = normalized else {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    format!("unsupported reasoning effort '{value}'"),
                );
            };
            Some(Some(normalized))
        }
    };
    if model_alias.is_some() || reasoning_effort.is_some() {
        let existing = match state.runtime.get_session(&session_id).await {
            Ok(Some(session)) => session,
            Ok(None) => {
                return error_response(
                    StatusCode::NOT_FOUND,
                    format!("Session '{session_id}' does not exist"),
                )
            }
            Err(error) => {
                return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
            }
        };
        let effective_model = match &model_alias {
            Some(Some(model)) => model.clone(),
            Some(None) => state.runtime.model(),
            None => existing
                .model_alias
                .clone()
                .unwrap_or_else(|| state.runtime.model()),
        };
        let effective_reasoning = match &reasoning_effort {
            Some(Some(reasoning)) => Some(reasoning.as_str()),
            Some(None) => None,
            None => existing.reasoning_effort.as_deref(),
        };
        if let Some(reasoning) = effective_reasoning {
            let options = match state.runtime.inference_model_options().await {
                Ok(options) => options,
                Err(error) => {
                    return error_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("failed to read the discovered and enabled model catalog: {error}"),
                    )
                }
            };
            if let Some(supported) = options
                .iter()
                .find(|option| option.id == effective_model)
                .and_then(|option| option.supported_reasoning_efforts.as_ref())
            {
                if !supported.iter().any(|candidate| candidate == reasoning) {
                    return error_response(
                        StatusCode::BAD_REQUEST,
                        format!(
                            "reasoning effort '{reasoning}' is not supported by model '{effective_model}'"
                        ),
                    );
                }
            }
        }
    }
    let status = request.status;
    let operator_authorized = is_operator_authorized(&state, &headers, query.token.as_deref());
    if context_sharing.is_some() && (title.is_some() || status.is_some()) {
        return error_response(
            StatusCode::BAD_REQUEST,
            "context_sharing cannot be combined with participant-owned title or status changes",
        );
    }
    if operator_authorized
        && title.is_none()
        && status.is_none()
        && (model_alias.is_some()
            || reasoning_effort.is_some()
            || permission_mode.is_some()
            || sandbox_mode.is_some()
            || default_target_id.is_some()
            || context_sharing.is_some())
    {
        if default_target_id.is_some() {
            let principal = match request_read_principal(
                &state,
                &headers,
                query.token.as_deref(),
                query.principal_id.as_deref(),
            ) {
                Ok(principal) => principal,
                Err(error) => return sdk_error_response(error),
            };
            if let Err(error) = state
                .sdk
                .update_session(
                    &principal.principal_id,
                    &session_id,
                    SessionUpdate {
                        default_target_id: default_target_id.clone(),
                        ..Default::default()
                    },
                )
                .await
            {
                return sdk_error_response(error);
            }
        }
        if model_alias.is_some() || reasoning_effort.is_some() {
            if let Err(error) = state
                .sdk
                .set_session_evaluation_policy_as_operator(
                    &session_id,
                    model_alias.clone(),
                    reasoning_effort.clone(),
                )
                .await
            {
                return sdk_error_response(error);
            }
        }
        if permission_mode.is_some() || sandbox_mode.is_some() {
            if let Err(error) = state
                .runtime
                .update_session(
                    &session_id,
                    SessionUpdate {
                        permission_mode: permission_mode.map(Some),
                        sandbox_mode: sandbox_mode.map(Some),
                        ..Default::default()
                    },
                )
                .await
            {
                return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
            }
        }
        return if let Some(sharing) = context_sharing {
            match state
                .sdk
                .set_session_context_sharing_as_operator(&session_id, sharing)
                .await
            {
                Ok(session) => Json(session).into_response(),
                Err(error) => sdk_error_response(error),
            }
        } else {
            match state.runtime.get_session(&session_id).await {
                Ok(Some(session)) => Json(session).into_response(),
                Ok(None) => error_response(
                    StatusCode::NOT_FOUND,
                    format!("Session '{session_id}' does not exist"),
                ),
                Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
            }
        };
    }
    if context_sharing.is_some() {
        return error_response(
            StatusCode::FORBIDDEN,
            "only the Operator may change Session context sharing",
        );
    }
    let principal = match request_principal(&state, &headers, None) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    match state
        .sdk
        .update_session(
            &principal.principal_id,
            &session_id,
            SessionUpdate {
                title,
                status,
                model_alias,
                reasoning_effort,
                permission_mode: permission_mode.map(Some),
                sandbox_mode: sandbox_mode.map(Some),
                default_target_id,
            },
        )
        .await
    {
        Ok(session) => Json(session).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_send_message(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<SendMessageRequest>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, None) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    let session = match state
        .sdk
        .get_session(&principal.principal_id, &session_id)
        .await
    {
        Ok(session) => session,
        Err(error) => return sdk_error_response(error),
    };
    if session.status == SessionStatus::Archived {
        return error_response(
            StatusCode::CONFLICT,
            "an archived Session cannot receive new messages",
        );
    }
    if request.text.trim().is_empty()
        && request.attachments.is_empty()
        && request.staged_attachment_ids.is_empty()
        && request.references.is_empty()
    {
        return error_response(
            StatusCode::BAD_REQUEST,
            "message text, attachments, and references cannot all be empty",
        );
    }
    if request.text.chars().count() > 1_000_000 {
        return error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "message text exceeds 1,000,000 characters",
        );
    }
    let mut attachment_usage = crate::model_input::ModelInputUsage::default();
    for attachment in &request.attachments {
        let encoded = attachment
            .data_base64
            .split_once(',')
            .filter(|(prefix, _)| prefix.starts_with("data:") && prefix.ends_with(";base64"))
            .map(|(_, data)| data)
            .unwrap_or(&attachment.data_base64);
        let bytes = match crate::model_input::decoded_base64_len(encoded) {
            Ok(bytes) => bytes,
            Err(error) => return error_response(StatusCode::BAD_REQUEST, error.to_string()),
        };
        if let Err(error) = attachment_usage.add(bytes) {
            return error_response(StatusCode::PAYLOAD_TOO_LARGE, error.to_string());
        }
    }
    if let Err(error) = crate::model_input::validate_model_input_usage(
        attachment_usage,
        state.runtime.config().model_input.import_limits(),
        "Dashboard message attachment import",
    ) {
        return error_response(StatusCode::PAYLOAD_TOO_LARGE, error.to_string());
    }
    let client_message_id = request
        .client_message_id
        .unwrap_or_else(|| api_id("client"));
    if let Err(error) = validate_identifier("client_message_id", &client_message_id) {
        return error_response(StatusCode::BAD_REQUEST, error);
    }
    let mut attachments = Vec::with_capacity(request.attachments.len());
    for attachment in request.attachments {
        let encoded = attachment
            .data_base64
            .split_once(',')
            .filter(|(prefix, _)| prefix.starts_with("data:") && prefix.ends_with(";base64"))
            .map(|(_, data)| data)
            .unwrap_or(&attachment.data_base64);
        let data = match base64::engine::general_purpose::STANDARD.decode(encoded) {
            Ok(data) => data,
            Err(_) => {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    format!("attachment '{}' is not valid base64 data", attachment.name),
                )
            }
        };
        attachments.push(MessageAttachmentInput {
            name: attachment.name,
            media_type: attachment.media_type,
            data,
        });
    }
    match state
        .sdk
        .send_message(
            &principal,
            SendMessageCommand {
                input_destination: request.input_destination,
                session_id,
                text: request.text,
                actor: "User-API".to_string(),
                client_message_id: Some(client_message_id),
                attachments,
                staged_attachment_ids: request.staged_attachment_ids,
                references: request.references,
                harness: request.harness,
                dispatch_mode: request.dispatch_mode,
                model_alias: request.model_alias,
                reasoning_effort: request.reasoning_effort,
                target_id: request.target_id,
            },
        )
        .await
    {
        Ok(receipt) => {
            let status = if receipt.duplicate {
                StatusCode::OK
            } else {
                StatusCode::ACCEPTED
            };
            let trace_id = receipt.event_id.clone();
            let mut response = (
                status,
                Json(json!({
                    "accepted": true,
                    "duplicate": receipt.duplicate,
                    "interrupted": receipt.interrupted,
                    "dispatch_mode": receipt.dispatch_mode,
                    "event_id": receipt.event_id,
                    "client_message_id": receipt.client_message_id,
                })),
            )
                .into_response();
            if let Ok(value) = HeaderValue::from_str(&trace_id) {
                response.headers_mut().insert("x-morphz-trace-id", value);
            }
            response
        }
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_create_message_attachment_stage(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<CreateMessageAttachmentStageRequest>,
) -> Response {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, None) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    let stage_id = request
        .stage_id
        .unwrap_or_else(|| api_id("attachment-stage"));
    match state
        .sdk
        .create_message_attachment_stage(
            &principal,
            CreateMessageAttachmentStageCommand {
                session_id,
                stage_id,
                client_message_id: request.client_message_id,
                name: request.name,
                media_type: request.media_type,
                size_bytes: request.size_bytes,
                expected_sha256: request.expected_sha256,
            },
        )
        .await
    {
        Ok(stage) => Json(stage).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_list_message_attachment_stages(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<MessageAttachmentStagesQuery>,
) -> Response {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, None) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    match state
        .sdk
        .list_message_attachment_stages(&principal, &session_id, query.client_message_id.as_deref())
        .await
    {
        Ok(stages) => Json(json!({ "stages": stages })).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_get_message_attachment_stage(
    State(state): State<Arc<AppState>>,
    Path((session_id, stage_id)): Path<(String, String)>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> Response {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, None) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    match state
        .sdk
        .inspect_message_attachment_stage(&principal, &session_id, &stage_id)
        .await
    {
        Ok(stage) => Json(stage).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_upload_message_attachment_stage(
    State(state): State<Arc<AppState>>,
    Path((session_id, stage_id)): Path<(String, String)>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    body: Body,
) -> Response {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, None) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    let offset = match required_u64_header(&headers, "x-morphz-upload-offset") {
        Ok(offset) => offset,
        Err(response) => return response,
    };
    match state
        .sdk
        .upload_message_attachment_stage(
            &principal,
            &session_id,
            &stage_id,
            offset,
            body.into_data_stream(),
        )
        .await
    {
        Ok(stage) => Json(stage).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_cancel_message_attachment_stage(
    State(state): State<Arc<AppState>>,
    Path((session_id, stage_id)): Path<(String, String)>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> Response {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, None) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    match state
        .sdk
        .cancel_message_attachment_stage(&principal, &session_id, &stage_id)
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_retry_dialogue_turn(
    State(state): State<Arc<AppState>>,
    Path((session_id, root_turn_id)): Path<(String, String)>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<RetryDialogueTurnRequest>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, None) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    let retry_request_id = request.retry_request_id.unwrap_or_else(|| api_id("retry"));
    if let Err(error) = validate_identifier("retry_request_id", &retry_request_id) {
        return error_response(StatusCode::BAD_REQUEST, error);
    }
    match state
        .sdk
        .retry_dialogue_turn(
            &principal,
            RetryDialogueTurnCommand {
                session_id,
                root_turn_id,
                expected_thread_revision: request.expected_thread_revision,
                expected_result_event_id: request.expected_result_event_id,
                retry_request_id,
            },
        )
        .await
    {
        Ok(receipt) => {
            let status = if receipt.duplicate {
                StatusCode::OK
            } else {
                StatusCode::ACCEPTED
            };
            (status, Json(json!(receipt))).into_response()
        }
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_bind_session_principal(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    if state.identity.mode != ServerIdentityMode::TrustedGateway {
        return error_response(
            StatusCode::BAD_REQUEST,
            "default identity mode does not require explicitly claiming a Session",
        );
    }
    let principal = match request_principal(&state, &headers, None) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    match state
        .sdk
        .bind_existing_session(principal, &session_id)
        .await
    {
        Ok(session) => Json(json!({ "session": session, "bound": true })).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_get_session_events(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<EventQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_read_principal(
        &state,
        &headers,
        query.token.as_deref(),
        query.principal_id.as_deref(),
    ) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    let limit = query.limit.unwrap_or(100).clamp(1, 1_000);
    if query.after_sequence.is_some() && query.before_sequence.is_some() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "after_sequence and before_sequence cannot be used together",
        );
    }
    match state
        .sdk
        .session_events(
            &principal.principal_id,
            SessionEventsQuery {
                session_id,
                after_sequence: query.after_sequence,
                before_sequence: query.before_sequence,
                conversation_only: query.conversation_only,
                limit,
            },
        )
        .await
    {
        Ok(events) => {
            let next_before_sequence = (events.len() == limit)
                .then(|| events.first().and_then(|event| event.sequence))
                .flatten();
            let latest_sequence = events.iter().filter_map(|event| event.sequence).max();
            Json(json!({
                "events": events,
                "next_before_sequence": next_before_sequence,
                "latest_sequence": latest_sequence,
            }))
            .into_response()
        }
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_get_session_event_attachment(
    State(state): State<Arc<AppState>>,
    Path((session_id, event_id, attachment_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> Response {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_read_principal(
        &state,
        &headers,
        query.token.as_deref(),
        query.principal_id.as_deref(),
    ) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    let session = match state
        .sdk
        .get_session(&principal.principal_id, &session_id)
        .await
    {
        Ok(session) => session,
        Err(error) => return sdk_error_response(error),
    };
    let event = match state
        .runtime
        .query_events(QueryFilter {
            event_id: Some(event_id),
            context_id: Some(session.context_id),
            session_id: Some(session.id),
            latest_k: Some(1),
            ..QueryFilter::default()
        })
        .await
    {
        Ok(events) => match events.into_iter().next() {
            Some(event) => event,
            None => {
                return error_response(StatusCode::NOT_FOUND, "attachment Event does not exist")
            }
        },
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let attachment = event
        .payload
        .get("attachments")
        .and_then(serde_json::Value::as_array)
        .and_then(|attachments| {
            attachments.iter().find(|attachment| {
                attachment.get("id").and_then(serde_json::Value::as_str)
                    == Some(attachment_id.as_str())
            })
        });
    let Some(attachment) = attachment else {
        return error_response(
            StatusCode::NOT_FOUND,
            "attachment does not exist in the Event",
        );
    };
    let media_type = attachment
        .get("media_type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("application/octet-stream");
    if !media_type.starts_with("image/") {
        return error_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "attachment is not a previewable image",
        );
    }
    let loaded = match crate::model_input::read_stored_attachment(
        &state.runtime.config().background_task.artifact_dir,
        attachment,
    )
    .await
    {
        Ok(loaded) => loaded,
        Err(error) => return error_response(StatusCode::GONE, error.to_string()),
    };
    match Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, loaded.media_type)
        .header(
            header::CACHE_CONTROL,
            "private, max-age=31536000, immutable",
        )
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(Body::from(loaded.data))
    {
        Ok(response) => response,
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn handle_get_session_context(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_read_principal(
        &state,
        &headers,
        query.token.as_deref(),
        query.principal_id.as_deref(),
    ) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    let session = match state
        .sdk
        .get_session(&principal.principal_id, &session_id)
        .await
    {
        Ok(session) => session,
        Err(error) => return sdk_error_response(error),
    };
    match state
        .runtime
        .context_encoding(&session.context_id, &session_id)
        .await
    {
        Ok(context) => Json(context).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn handle_get_session_context_projection(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_read_principal(
        &state,
        &headers,
        query.token.as_deref(),
        query.principal_id.as_deref(),
    ) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    let session = match state
        .sdk
        .get_session(&principal.principal_id, &session_id)
        .await
    {
        Ok(session) => session,
        Err(error) => return sdk_error_response(error),
    };
    match state
        .runtime
        .context_projection(&session.context_id, &session_id)
        .await
    {
        Ok(context) => Json(context).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn handle_get_session_context_encoding(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_read_principal(
        &state,
        &headers,
        query.token.as_deref(),
        query.principal_id.as_deref(),
    ) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    let session = match state
        .sdk
        .get_session(&principal.principal_id, &session_id)
        .await
    {
        Ok(session) => session,
        Err(error) => return sdk_error_response(error),
    };
    match state
        .runtime
        .context_encoding(&session.context_id, &session_id)
        .await
    {
        Ok(context) => Json(json!({
            "context_id": context.context_id,
            "session_id": context.active_session_id,
            "mind_revision": context.state.version,
            "encoding": context.sexpr,
        }))
        .into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn handle_cancel_session(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, None) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    if let Err(error) = state
        .sdk
        .get_session(&principal.principal_id, &session_id)
        .await
    {
        return sdk_error_response(error);
    }
    let cancelled_threads = match state
        .runtime
        .cancel_session_durable(&session_id, "Session cancelled from Dashboard")
        .await
    {
        Ok(cancelled) => cancelled,
        Err(error) => {
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    };
    let was_running = cancelled_threads > 0;
    let payload = vec![
        ("session_id".to_string(), json!(session_id)),
        ("status".to_string(), json!("cancelled")),
        ("was_running".to_string(), json!(was_running)),
        (
            "text".to_string(),
            json!(if was_running {
                "Current Session execution was cancelled."
            } else {
                "The Session has no running execution; subsequent background wakeups are paused until the next user message."
            }),
        ),
    ]
    .into_iter()
    .collect();
    let event = Event::new(
        api_id("cancel"),
        "User-API".to_string(),
        crate::event::TYPE_AGENT_CALL.to_string(),
        "chat/cancelled".to_string(),
        payload,
    );
    let _ = state.runtime.publish(event).await;
    Json(json!({ "cancelled": true, "was_running": was_running })).into_response()
}

async fn handle_list_delegations(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<DelegationHttpQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let limit = query.limit.unwrap_or(200).clamp(1, 500);
    match state
        .runtime
        .query_delegations(DelegationFilter {
            related_context_id: query.context_id,
            related_session_id: query.session_id,
            include_terminal: query.include_terminal,
            newest_first: true,
            limit: Some(limit.saturating_add(1)),
            ..Default::default()
        })
        .await
    {
        Ok(mut delegations) => {
            let has_more = delegations.len() > limit;
            delegations.truncate(limit);
            Json(json!({ "delegations": delegations, "has_more": has_more })).into_response()
        }
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn handle_create_objective(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<CreateObjectiveRequest>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let principal = match request_principal(&state, &headers, None) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    let stated_objective = request.stated_objective.trim().to_string();
    if stated_objective.is_empty() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "stated_objective must not be empty",
        );
    }
    if request.token_budget == Some(0) {
        return error_response(
            StatusCode::BAD_REQUEST,
            "token_budget must be greater than 0",
        );
    }
    let coordinator = match state
        .sdk
        .get_session(&principal.principal_id, &request.coordinator_session_id)
        .await
    {
        Ok(session) => session,
        Err(error) => return sdk_error_response(error),
    };
    let delivery_session_id = request
        .delivery_session_id
        .unwrap_or_else(|| coordinator.id.clone());
    let delivery = match state
        .sdk
        .get_session(&principal.principal_id, &delivery_session_id)
        .await
    {
        Ok(session) => session,
        Err(error) => return sdk_error_response(error),
    };
    if delivery.context_id != coordinator.context_id || delivery.agent_id != coordinator.agent_id {
        return error_response(
            StatusCode::BAD_REQUEST,
            "coordinator and delivery Session must belong to the same Agent/Context",
        );
    }
    let objective_id = request.id.unwrap_or_else(|| api_id("objective"));
    if let Err(error) = validate_identifier("objective_id", &objective_id) {
        return error_response(StatusCode::BAD_REQUEST, error);
    }
    let source_event_id = api_id("objective_request");
    match state
        .sdk
        .create_objective(
            &principal,
            CreateObjectiveCommand {
                id: objective_id,
                coordinator_session_id: coordinator.id,
                delivery_session_id: Some(delivery.id),
                parent_objective_id: request.parent_objective_id,
                stated_objective,
                token_budget: request.token_budget,
                source_event_id,
                source_origin: ObjectiveRequestOrigin::Http,
                harness: request.harness,
            },
        )
        .await
    {
        Ok(result) => (StatusCode::CREATED, Json(result)).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_edit_objective(
    State(state): State<Arc<AppState>>,
    Path(objective_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<EditObjectiveRequest>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    if let Err(error) =
        authorize_objective_request(&state, &headers, query.token.as_deref(), &objective_id).await
    {
        return error;
    }
    let stated_objective = request.stated_objective.trim();
    if stated_objective.is_empty() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "stated_objective must not be empty",
        );
    }
    match state
        .runtime
        .edit_objective(&objective_id, request.expected_revision, stated_objective)
        .await
    {
        Ok(ObjectiveMutation::Updated(updated)) => Json(json!({
            "edited": true,
            "objective": updated,
        }))
        .into_response(),
        Ok(ObjectiveMutation::Conflict { current }) => (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "Objective revision conflict; refresh and retry",
                "current": current,
            })),
        )
            .into_response(),
        Ok(ObjectiveMutation::NotFound) => {
            error_response(StatusCode::NOT_FOUND, "Objective does not exist")
        }
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn handle_resume_objective(
    State(state): State<Arc<AppState>>,
    Path(objective_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<ResumeObjectiveRequest>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let objective =
        match authorize_objective_request(&state, &headers, query.token.as_deref(), &objective_id)
            .await
        {
            Ok(objective) => objective,
            Err(error) => return error,
        };
    if !matches!(
        objective.status,
        ObjectiveStatus::Blocked | ObjectiveStatus::Paused
    ) {
        return error_response(
            StatusCode::CONFLICT,
            format!(
                "Objective is currently '{}'; only blocked or paused Objectives can be resumed explicitly",
                objective.status.as_str()
            ),
        );
    }
    let reason = request
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .unwrap_or("the user explicitly resumed the Objective through the Dashboard");
    match state
        .runtime
        .resume_objective(&objective_id, request.expected_revision, reason)
        .await
    {
        Ok(ObjectiveMutation::Updated(updated)) => Json(json!({
            "resumed": true,
            "objective": updated,
        }))
        .into_response(),
        Ok(ObjectiveMutation::Conflict { current }) => (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "Objective revision conflict; refresh and retry",
                "current": current,
            })),
        )
            .into_response(),
        Ok(ObjectiveMutation::NotFound) => {
            error_response(StatusCode::NOT_FOUND, "Objective does not exist")
        }
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn handle_pause_objective(
    State(state): State<Arc<AppState>>,
    Path(objective_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<ResumeObjectiveRequest>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let objective =
        match authorize_objective_request(&state, &headers, query.token.as_deref(), &objective_id)
            .await
        {
            Ok(objective) => objective,
            Err(error) => return error,
        };
    if objective.status != ObjectiveStatus::Active {
        return error_response(
            StatusCode::CONFLICT,
            format!(
                "Objective is currently '{}'; only active Objectives can be paused explicitly",
                objective.status.as_str()
            ),
        );
    }
    let reason = request
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .unwrap_or("the user explicitly paused the Objective through the Dashboard");
    match state
        .runtime
        .pause_objective(&objective_id, request.expected_revision, reason)
        .await
    {
        Ok(ObjectiveMutation::Updated(updated)) => Json(json!({
            "paused": true,
            "objective": updated,
        }))
        .into_response(),
        Ok(ObjectiveMutation::Conflict { current }) => (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "Objective revision conflict; refresh and retry",
                "current": current,
            })),
        )
            .into_response(),
        Ok(ObjectiveMutation::NotFound) => {
            error_response(StatusCode::NOT_FOUND, "Objective does not exist")
        }
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

/// Remove an Objective from the live control plane without erasing its audit
/// history. Internally this is the `cancelled` terminal transition: it stops
/// the current evaluation and prevents the Supervisor from continuing it.
async fn handle_delete_objective(
    State(state): State<Arc<AppState>>,
    Path(objective_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<ResumeObjectiveRequest>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    if let Err(error) =
        authorize_objective_request(&state, &headers, query.token.as_deref(), &objective_id).await
    {
        return error;
    }
    let reason = request
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .unwrap_or("the user deleted the Objective through the Dashboard");
    match state
        .runtime
        .cancel_objective(&objective_id, request.expected_revision, reason)
        .await
    {
        Ok(ObjectiveMutation::Updated(updated)) => Json(json!({
            "deleted": true,
            "objective_id": updated.id,
            "terminal_status": updated.status,
        }))
        .into_response(),
        Ok(ObjectiveMutation::Conflict { current }) => (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "Objective revision conflict; refresh and retry",
                "current": current,
            })),
        )
            .into_response(),
        Ok(ObjectiveMutation::NotFound) => {
            error_response(StatusCode::NOT_FOUND, "Objective does not exist")
        }
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn handle_get_delegation(
    State(state): State<Arc<AppState>>,
    Path(delegation_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    match state.runtime.get_delegation(&delegation_id).await {
        Ok(Some(delegation)) => Json(delegation).into_response(),
        Ok(None) => error_response(StatusCode::NOT_FOUND, "Delegation does not exist"),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn handle_cancel_delegation(
    State(state): State<Arc<AppState>>,
    Path(delegation_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    let delegation = match state.runtime.get_delegation(&delegation_id).await {
        Ok(Some(delegation)) => delegation,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "Delegation does not exist"),
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    if matches!(
        delegation.status,
        DelegationStatus::Completed | DelegationStatus::Failed | DelegationStatus::Cancelled
    ) {
        return error_response(
            StatusCode::CONFLICT,
            format!(
                "Delegation is already terminal with status '{}' and cannot be cancelled",
                delegation.status.as_str()
            ),
        );
    }
    match state.runtime.cancel_delegation_tree(&delegation_id).await {
        Ok(cancelled) => Json(json!({
            "cancelled": true,
            "cancelled_count": cancelled.len(),
            "delegation": cancelled.iter().find(|item| item.id == delegation_id),
            "cancelled_delegations": cancelled
        }))
        .into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn handle_ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return unauthorized_response();
    }
    if let Some(session_id) = query.session_id.as_deref() {
        if !is_operator_authorized(&state, &headers, query.token.as_deref()) {
            let principal = match request_principal(&state, &headers, query.principal_id.as_deref())
            {
                Ok(principal) => principal,
                Err(error) => return sdk_error_response(error),
            };
            if let Err(error) = state
                .sdk
                .authorize_session(&principal.principal_id, session_id)
                .await
            {
                return sdk_error_response(error);
            }
        }
    } else if !websocket_may_subscribe_globally(&state, &headers, query.token.as_deref()) {
        return error_response(
            StatusCode::BAD_REQUEST,
            "a non-Operator WebSocket subscription must specify session_id",
        );
    }
    ws.on_upgrade(move |socket| {
        handle_ws(
            socket,
            state,
            query.session_id,
            query.observe_model_requests,
        )
    })
}

fn websocket_may_subscribe_globally(
    state: &AppState,
    headers: &HeaderMap,
    query_token: Option<&str>,
) -> bool {
    is_operator_authorized(state, headers, query_token)
}

fn is_authorized(state: &AppState, headers: &HeaderMap, query_token: Option<&str>) -> bool {
    is_operator_authorized(state, headers, query_token)
        || state
            .gateway_token
            .as_deref()
            .is_some_and(|expected| token_is_authorized(Some(expected), headers, query_token))
}

fn is_operator_authorized(
    state: &AppState,
    headers: &HeaderMap,
    query_token: Option<&str>,
) -> bool {
    match state.auth_token.as_deref() {
        Some(expected) => token_is_authorized(Some(expected), headers, query_token),
        None => {
            state.identity.mode == ServerIdentityMode::Default
                && state.gateway_token.is_none()
                && token_is_authorized(None, headers, query_token)
        }
    }
}

fn token_is_authorized(
    expected: Option<&str>,
    headers: &HeaderMap,
    query_token: Option<&str>,
) -> bool {
    let Some(expected) = expected else {
        return true;
    };

    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    bearer == Some(expected) || query_token == Some(expected)
}

fn dashboard_event_requires_session_touch(event: &Event) -> bool {
    // Provider deltas and model-request snapshots are
    // observability data, not user activity. Replaying them in the Dashboard
    // must not make an otherwise inactive Session look active.
    !matches!(
        event.topic.as_str(),
        "runtime/model_stream"
            | "runtime/model_reasoning_summary"
            | "runtime/model_usage"
            | "runtime/model_attempt_state"
            | "runtime/model_attempt_snapshot"
            | "runtime/model_request_snapshot"
            | "chat/context_inspect"
    )
}

async fn ensure_dashboard_event_session_route(
    runtime: &MorphzRuntime,
    default_agent_id: &str,
    default_context_id: &str,
    identity_mode: ServerIdentityMode,
    session_id: &str,
    declared_context_id: Option<&str>,
    parent_session_id: Option<String>,
) -> Result<(), crate::runtime::RuntimeError> {
    if let Some(existing) = runtime.get_session(session_id).await? {
        if let Some(declared_context_id) = declared_context_id {
            if existing.context_id != declared_context_id {
                return Err(format!(
                    "Event route rejected: Session '{}' belongs to Context '{}', while the Event declares '{}'",
                    session_id, existing.context_id, declared_context_id
                )
                .into());
            }
        }
        return Ok(());
    }

    if identity_mode == ServerIdentityMode::TrustedGateway {
        return Err(
            format!("trusted Gateway mode refuses to create unknown Session '{session_id}' implicitly from an Event").into(),
        );
    }

    // An Event that only carries a Session route cannot authoritatively name a
    // Context. Falling back to `session_id` here used to create Cognitive
    // Contexts named `session_*`, collapsing two distinct domain identities.
    // Default mode may still adopt an unknown local Session, but it must mount
    // it into the configured default Context unless the Event explicitly names
    // another Context.
    let context_id = declared_context_id.unwrap_or(default_context_id);
    let agent_id = match runtime.get_context(context_id).await? {
        Some(context) => context.agent_id,
        None => {
            runtime
                .ensure_context(NewCognitiveContext {
                    id: context_id.to_string(),
                    agent_id: default_agent_id.to_string(),
                    title: if context_id == default_context_id {
                        "Default Cognitive Context".to_string()
                    } else {
                        context_id.to_string()
                    },
                })
                .await?;
            default_agent_id.to_string()
        }
    };
    runtime
        .ensure_session(NewSession {
            id: session_id.to_string(),
            agent_id,
            context_id: context_id.to_string(),
            parent_session_id,
            title: session_id.to_string(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await?;
    Ok(())
}

async fn mirror_dashboard_event(
    runtime: &MorphzRuntime,
    broadcast_tx: &broadcast::Sender<Event>,
    default_agent_id: &str,
    default_context_id: &str,
    identity_mode: ServerIdentityMode,
    event: Event,
) -> Result<(), crate::runtime::RuntimeError> {
    // Model stream events are deliberately ephemeral. They must reach the
    // browser with the lowest possible latency and must not mutate durable
    // Session metadata once per token/chunk. Persisted events below still pass
    // through normal routing validation and activity touch.
    if dashboard_event_requires_session_touch(&event) {
        if let Some(session_id) = event
            .payload
            .get("session_id")
            .and_then(|value| value.as_str())
        {
            let declared_context_id = event
                .payload
                .get("context_id")
                .and_then(|value| value.as_str());
            let parent_session_id = event
                .payload
                .get("parent_session_id")
                .and_then(|value| value.as_str())
                .map(ToOwned::to_owned);
            ensure_dashboard_event_session_route(
                runtime,
                default_agent_id,
                default_context_id,
                identity_mode,
                session_id,
                declared_context_id,
                parent_session_id,
            )
            .await?;
            runtime.touch_session(session_id, event.timestamp).await?;
        }
    }
    let _ = broadcast_tx.send(event);
    Ok(())
}

async fn mirror_durable_dashboard_events(
    runtime: MorphzRuntime,
    broadcast_tx: broadcast::Sender<Event>,
    default_agent_id: String,
    default_context_id: String,
    identity_mode: ServerIdentityMode,
    recent_event_ids: Arc<Mutex<RecentDashboardEventIds>>,
    mut after_sequence: u64,
) {
    let mut wait_before_query = true;
    loop {
        if wait_before_query {
            tokio::time::sleep(DASHBOARD_DURABLE_EVENT_POLL_INTERVAL).await;
        }
        let events = match runtime
            .query_events(QueryFilter {
                after_sequence: Some(after_sequence),
                top_k: Some(DASHBOARD_DURABLE_EVENT_BATCH_SIZE),
                ..Default::default()
            })
            .await
        {
            Ok(events) => events,
            Err(error) => {
                tracing::warn!(
                    event_code = "web.websocket.durable_tail_failed",
                    %error,
                    "Durable Dashboard Event tail failed; retaining its cursor for retry"
                );
                wait_before_query = true;
                continue;
            }
        };
        wait_before_query = events.len() < DASHBOARD_DURABLE_EVENT_BATCH_SIZE;
        for event in events {
            let Some(sequence) = event.sequence else {
                tracing::warn!(
                    event_id = %event.id,
                    event_code = "web.websocket.durable_event_missing_sequence",
                    "Persisted Dashboard Event has no physical sequence; retaining the current tail cursor"
                );
                continue;
            };
            if !recent_event_ids.lock().await.insert(&event.id) {
                after_sequence = after_sequence.max(sequence);
                continue;
            }
            let event_id = event.id.clone();
            if let Err(error) = mirror_dashboard_event(
                &runtime,
                &broadcast_tx,
                &default_agent_id,
                &default_context_id,
                identity_mode,
                event,
            )
            .await
            {
                recent_event_ids.lock().await.remove(&event_id);
                tracing::warn!(
                    event_code = "web.websocket.durable_event_mirror_failed",
                    %error,
                    "Could not mirror a peer Runtime's durable Event to Dashboard WebSockets"
                );
                wait_before_query = true;
                break;
            }
            after_sequence = after_sequence.max(sequence);
        }
    }
}

async fn handle_ws(
    socket: WebSocket,
    state: Arc<AppState>,
    session_filter: Option<String>,
    observe_model_requests: bool,
) {
    let mut rx = state.broadcast_tx.subscribe();
    let observer_id = observe_model_requests
        .then(|| {
            format!(
                "dashboard-ws-{}",
                WEBSOCKET_OBSERVER_COUNTER.fetch_add(1, Ordering::Relaxed) + 1
            )
        })
        .filter(|_| session_filter.is_some());
    if let (Some(observer_id), Some(session_id)) = (&observer_id, &session_filter) {
        state.runtime.request_ephemeral_observation(
            observer_id,
            "runtime/model_request_snapshot",
            session_id,
        );
    }

    handle_ws_connection(
        socket,
        Arc::clone(&state),
        session_filter,
        observe_model_requests,
        &mut rx,
    )
    .await;

    if let Some(observer_id) = observer_id {
        state.runtime.clear_ephemeral_observations(&observer_id);
    }
}

async fn handle_ws_connection(
    mut socket: WebSocket,
    state: Arc<AppState>,
    session_filter: Option<String>,
    observe_model_requests: bool,
    rx: &mut broadcast::Receiver<Event>,
) {
    // Subscribe before reading the durable state. Events committed during the
    // snapshot query remain queued in `rx`, so the client sees a consistent
    // snapshot followed by its incremental suffix instead of losing the
    // transition that raced with reconnect.
    if let Some(session_id) = session_filter.as_deref() {
        match model_attempt_snapshot_event(&state.runtime, session_id).await {
            Ok(snapshot) => {
                if let Ok(json_str) = serde_json::to_string(&snapshot) {
                    if socket.send(WsMessage::Text(json_str)).await.is_err() {
                        return;
                    }
                }
            }
            Err(error) => {
                tracing::warn!(event_code = "web.model_attempt_snapshot.rebuild_failed", session_id, %error, "Failed to rebuild the Model Attempt WebSocket snapshot");
            }
        }
    }

    let mut heartbeat = tokio::time::interval(DASHBOARD_WEBSOCKET_HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    // Forward EventBus broadcasts to WebSocket while maintaining the connection heartbeat.
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                // Browser WebSocket implementations answer protocol Pings with
                // Pongs automatically. Besides keeping intermediaries from
                // expiring an otherwise idle Dashboard, a failed send closes
                // the server task so the client can reconnect promptly.
                if socket.send(WsMessage::Ping(Vec::new())).await.is_err() {
                    break;
                }
            }
            // Receive new Events from the broadcast channel and push them to the browser in real time.
            broadcast_msg = rx.recv() => {
                match broadcast_msg {
                    Ok(ev) => {
                        if ev.topic == "runtime/model_request_snapshot" && !observe_model_requests {
                            continue;
                        }
                        if let Some(ref expected_session) = session_filter {
                            let event_session = ev
                                .payload
                                .get("session_id")
                                .and_then(|value| value.as_str());
                            if event_session != Some(expected_session.as_str()) {
                                continue;
                            }
                        }
                        if let Ok(json_str) = serde_json::to_string(&ev) {
                            if socket.send(WsMessage::Text(json_str)).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        // Continuing would render a syntactically valid but incomplete
                        // model draft. Drop the connection so the client discards all
                        // transient text and reconnects to the durable snapshot.
                    tracing::warn!(event_code = "web.websocket.events_lagged", skipped, "Dashboard WebSocket lost Events; closing the connection for resynchronization");
                        break;
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        break;
                    }
                }
            }
            // Receive browser messages only for keepalive or diagnostics.
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(WsMessage::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => {} // Ignore normal heartbeats and messages.
                }
            }
        }
    }
}

async fn model_attempt_snapshot_event(
    runtime: &MorphzRuntime,
    session_id: &str,
) -> Result<Event, crate::runtime::RuntimeError> {
    let session = runtime
        .get_session(session_id)
        .await?
        .ok_or_else(|| format!("Session '{session_id}' does not exist"))?;
    let active_activation_ids = runtime
        .active_thread_activations(&session.context_id)
        .await?
        .into_iter()
        .map(|activation| activation.id)
        .collect::<HashSet<_>>();
    let events = runtime
        .query_events(QueryFilter {
            session_id: Some(session_id.to_string()),
            topic: Some("runtime/model_attempt_state".to_string()),
            latest_k: Some(4_096),
            ..Default::default()
        })
        .await?;
    let attempts = fold_active_model_attempts(events, &active_activation_ids);
    Ok(Event::new(
        format!(
            "model_attempt_snapshot_{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ),
        "Runtime-Web".to_string(),
        "runtime_ephemeral".to_string(),
        "runtime/model_attempt_snapshot".to_string(),
        [
            ("context_id".to_string(), json!(session.context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempts".to_string(), json!(attempts)),
        ]
        .into_iter()
        .collect(),
    ))
}

fn fold_active_model_attempts(
    events: Vec<Event>,
    active_activation_ids: &HashSet<String>,
) -> Vec<serde_json::Value> {
    let mut latest = HashMap::<String, Event>::new();
    for event in events {
        let Some(attempt_id) = event
            .payload
            .get("attempt_id")
            .and_then(serde_json::Value::as_str)
        else {
            continue;
        };
        latest.insert(attempt_id.to_string(), event);
    }
    let mut attempts = latest
        .into_values()
        .filter(|event| {
            !event
                .payload
                .get("terminal")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
                && event
                    .payload
                    .get("activation_id")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|id| active_activation_ids.contains(id))
        })
        .map(|event| {
            json!({
                "attempt_id": event.payload.get("attempt_id"),
                "activation_id": event.payload.get("activation_id"),
                "thread_id": event.payload.get("thread_id"),
                "root_turn_id": event.payload.get("root_turn_id"),
                "thread_kind": event.payload.get("thread_kind"),
                "objective_id": event.payload.get("objective_id"),
                "state": event.payload.get("state"),
                "continuation_pending": event.payload.get("continuation_pending"),
                "detail": event.payload.get("detail"),
                "timestamp": event.timestamp,
            })
        })
        .collect::<Vec<_>>();
    attempts.sort_by(|left, right| {
        left.get("timestamp")
            .and_then(serde_json::Value::as_str)
            .cmp(&right.get("timestamp").and_then(serde_json::Value::as_str))
    });
    attempts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AppConfig;
    use crate::llm::{
        Client, Message, ModelRequestContext, ModelStreamEvent, ModelStreamSender,
        PromptTokenCount, ReasoningEffort, Response, ToolDefinition,
    };
    use crate::memory::sqlite::SqliteStore;
    use crate::memory::{ProviderModelCatalogStore as _, ScheduleStore as _, ThreadStore as _};
    use crate::provider::auth::{
        AdapterLoginResult, AdapterLoginStart, AuthAdapter, AuthAdapterRegistry, OAuthCallbackMode,
        OAuthFlowKind, OAuthLoginProgress, OAuthTokenSet, RequestAuthorization,
    };
    use crate::runtime::{RuntimeIdentity, RuntimeToolPolicy};
    use crate::secret_store::{SecretStore, SecretValueBackend};
    use chrono::{Duration as ChronoDuration, Utc};
    use serde_json::Value;
    use std::collections::BTreeMap;
    use std::sync::Mutex;
    use tempfile::NamedTempFile;

    #[test]
    fn dashboard_event_deduplication_is_bounded_and_retryable() {
        let mut recent = RecentDashboardEventIds::default();
        assert!(recent.insert("event-a"));
        assert!(!recent.insert("event-a"));
        recent.remove("event-a");
        assert!(recent.insert("event-a"));

        for index in 0..=DASHBOARD_RECENT_EVENT_IDS {
            assert!(recent.insert(&format!("event-{index}")));
        }
        assert!(recent.order.len() <= DASHBOARD_RECENT_EVENT_IDS);
        assert!(recent.ids.len() <= DASHBOARD_RECENT_EVENT_IDS);
    }

    #[derive(Default)]
    struct WebTestSecretBackend {
        values: Mutex<BTreeMap<String, String>>,
    }

    impl SecretValueBackend for WebTestSecretBackend {
        fn backend_id(&self) -> &'static str {
            "web_test_memory"
        }

        fn storage_kind(&self) -> &'static str {
            "memory"
        }

        fn put(&self, locator: &str, value: &str) -> Result<(), String> {
            self.values
                .lock()
                .map_err(|_| "web test secret backend poisoned".to_string())?
                .insert(locator.to_string(), value.to_string());
            Ok(())
        }

        fn get(&self, locator: &str) -> Result<Option<String>, String> {
            Ok(self
                .values
                .lock()
                .map_err(|_| "web test secret backend poisoned".to_string())?
                .get(locator)
                .cloned())
        }

        fn delete(&self, locator: &str) -> Result<bool, String> {
            Ok(self
                .values
                .lock()
                .map_err(|_| "web test secret backend poisoned".to_string())?
                .remove(locator)
                .is_some())
        }
    }

    struct WebTestOAuthAdapter {
        id: &'static str,
        flow: OAuthFlowKind,
    }

    #[async_trait::async_trait]
    impl AuthAdapter for WebTestOAuthAdapter {
        fn id(&self) -> &'static str {
            self.id
        }

        fn version(&self) -> &'static str {
            "1"
        }

        fn flow(&self) -> OAuthFlowKind {
            self.flow
        }

        async fn start_login(&self) -> Result<AdapterLoginStart, String> {
            if self.flow == OAuthFlowKind::AuthorizationCodePkce {
                return Ok(AdapterLoginStart {
                    flow: self.flow,
                    callback_mode: OAuthCallbackMode::Loopback,
                    redirect_uri: Some("http://localhost/callback".to_string()),
                    authorization_url: Some(
                        "https://auth.example.test/authorize?state=morphz-test".to_string(),
                    ),
                    verification_uri: None,
                    verification_uri_complete: None,
                    user_code: None,
                    expires_at: Utc::now() + ChronoDuration::minutes(10),
                    poll_interval_secs: 1,
                    state: serde_json::json!({"state": "morphz-test"}),
                });
            }
            Ok(AdapterLoginStart {
                flow: self.flow,
                callback_mode: OAuthCallbackMode::None,
                redirect_uri: None,
                authorization_url: None,
                verification_uri: Some("https://auth.example.test/device".to_string()),
                verification_uri_complete: Some(
                    "https://auth.example.test/device?code=MORPHZ-TEST".to_string(),
                ),
                user_code: Some("MORPHZ-TEST".to_string()),
                expires_at: Utc::now() + ChronoDuration::minutes(10),
                poll_interval_secs: 5,
                state: serde_json::json!({"device_code": "device-test"}),
            })
        }

        async fn continue_login(
            &self,
            _state: &Value,
            completion: OAuthLoginCompletion,
        ) -> Result<AdapterLoginResult, String> {
            match completion {
                OAuthLoginCompletion::Poll => {}
                OAuthLoginCompletion::AuthorizationResponse { response } => {
                    assert_eq!(
                        parse_authorization_response(&response).unwrap(),
                        ("web-code".to_string(), "morphz-test".to_string())
                    );
                }
                other => panic!("unexpected web OAuth completion: {other:?}"),
            }
            Ok(AdapterLoginResult::Complete(Box::new(OAuthTokenSet {
                adapter_id: self.id().to_string(),
                adapter_version: self.version().to_string(),
                access_token: "web-test-access-token".to_string(),
                refresh_token: Some("web-test-refresh-token".to_string()),
                id_token: None,
                token_type: Some("Bearer".to_string()),
                scopes: vec!["model.invoke".to_string()],
                expires_at: Some(Utc::now() + ChronoDuration::hours(1)),
                subject: Some("subject-web-test".to_string()),
                account_id: Some("provider-account-web-test".to_string()),
                email: Some("oauth@example.test".to_string()),
                device_id: None,
                metadata: BTreeMap::new(),
            })))
        }

        async fn refresh(&self, current: &OAuthTokenSet) -> Result<OAuthTokenSet, String> {
            Ok(current.clone())
        }

        fn materialize(&self, token: &OAuthTokenSet) -> Result<RequestAuthorization, String> {
            Ok(RequestAuthorization {
                bearer_token: token.access_token.clone(),
                headers: BTreeMap::new(),
                request_context: BTreeMap::new(),
            })
        }
    }

    #[derive(Default)]
    struct ReplyClient {
        model: std::sync::RwLock<Option<String>>,
        reasoning_effort: std::sync::RwLock<Option<ReasoningEffort>>,
    }

    #[async_trait::async_trait]
    impl Client for ReplyClient {
        fn replace_provider_catalog(&self, _config: &AppConfig) -> Result<(), String> {
            Ok(())
        }

        fn model(&self) -> Option<String> {
            self.model.read().ok().and_then(|value| value.clone())
        }

        fn set_model(&self, model: &str) -> Result<(), String> {
            *self.model.write().unwrap() = Some(model.to_string());
            Ok(())
        }

        fn reasoning_effort(&self) -> Option<ReasoningEffort> {
            self.reasoning_effort.read().map(|value| *value).unwrap()
        }

        fn set_reasoning_effort(&self, effort: Option<ReasoningEffort>) -> Result<(), String> {
            *self.reasoning_effort.write().unwrap() = effort;
            Ok(())
        }

        async fn create_completion(
            &self,
            _messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
        ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
            Ok(Response {
                content: "session-api-reply".to_string(),
                tool_calls: Vec::new(),
            })
        }

        async fn create_completion_measured_stream(
            &self,
            _messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
            _measurement: Option<PromptTokenCount>,
            stream: ModelStreamSender,
        ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
            let _ = stream.send(ModelStreamEvent::Started);
            let _ = stream.send(ModelStreamEvent::ReasoningSummaryDelta {
                text: "provider-authored summary".to_string(),
            });
            let _ = stream.send(ModelStreamEvent::TextDelta {
                text: "session-api-".to_string(),
            });
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            let _ = stream.send(ModelStreamEvent::TextDelta {
                text: "reply".to_string(),
            });
            let _ = stream.send(ModelStreamEvent::Completed);
            Ok(Response {
                content: "session-api-reply".to_string(),
                tool_calls: Vec::new(),
            })
        }
    }

    async fn test_state_at_with_workers(
        path: &std::path::Path,
        start_workers: bool,
    ) -> (Arc<AppState>, MorphzRuntime) {
        test_state_at_with_workers_and_auth(path, start_workers, None).await
    }

    async fn test_state_at_with_workers_and_auth(
        path: &std::path::Path,
        start_workers: bool,
        auth_registry: Option<AuthAdapterRegistry>,
    ) -> (Arc<AppState>, MorphzRuntime) {
        test_state_at_with_workers_auth_and_secrets(path, start_workers, auth_registry, None).await
    }

    async fn test_state_at_with_workers_auth_and_secrets(
        path: &std::path::Path,
        start_workers: bool,
        auth_registry: Option<AuthAdapterRegistry>,
        secret_store: Option<Arc<SecretStore>>,
    ) -> (Arc<AppState>, MorphzRuntime) {
        let mut config = AppConfig::default();
        config.llm.provider = Some("fixture-provider".to_string());
        config.llm.model = "fixture-model".to_string();
        config.llm.models.push("fixture-model".to_string());
        config.providers.insert(
            "fixture-provider".to_string(),
            crate::config::ProviderConfig {
                protocol: crate::config::ModelProtocol::OpenaiResponses,
                base_url: "http://localhost:8317/v1".to_string(),
                ..crate::config::ProviderConfig::default()
            },
        );
        test_state_at_with_config_auth_and_secrets(
            path,
            start_workers,
            config,
            auth_registry,
            secret_store,
        )
        .await
    }

    async fn test_state_at_with_config_auth_and_secrets(
        path: &std::path::Path,
        start_workers: bool,
        config: AppConfig,
        auth_registry: Option<AuthAdapterRegistry>,
        secret_store: Option<Arc<SecretStore>>,
    ) -> (Arc<AppState>, MorphzRuntime) {
        test_state_at_with_config_client_auth_and_secrets(
            path,
            start_workers,
            config,
            Arc::new(ReplyClient::default()),
            auth_registry,
            secret_store,
        )
        .await
    }

    async fn test_state_at_with_config_client_auth_and_secrets(
        path: &std::path::Path,
        start_workers: bool,
        mut config: AppConfig,
        client: Arc<dyn Client>,
        auth_registry: Option<AuthAdapterRegistry>,
        secret_store: Option<Arc<SecretStore>>,
    ) -> (Arc<AppState>, MorphzRuntime) {
        if config.background_task.artifact_dir == ".morphz/artifacts" {
            config.background_task.artifact_dir = path
                .with_extension("artifacts")
                .to_string_lossy()
                .into_owned();
        }
        let secret_store = secret_store.unwrap_or_else(|| {
            Arc::new(
                SecretStore::new(
                    path.with_extension("managed-secrets.json"),
                    Arc::new(WebTestSecretBackend::default()),
                )
                .unwrap(),
            )
        });
        let mut builder = MorphzRuntime::builder(config, client)
            .database_path(path.to_str().unwrap())
            .identity(RuntimeIdentity {
                agent_id: "agent-test".to_string(),
                context_id: "context-test".to_string(),
                principal_id: "principal-web-test".to_string(),
            })
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: false,
            })
            .secret_store(secret_store);
        if let Some(registry) = auth_registry {
            builder = builder.provider_auth_registry(registry);
        }
        let runtime = builder.build().await.unwrap();
        if start_workers {
            runtime.start().await.unwrap();
        }
        let (broadcast_tx, _) = broadcast::channel(32);
        let sdk = MorphzSdk::new(runtime.clone());
        let managed_config_path = path.with_extension("managed").join("managed.toml");
        (
            Arc::new(AppState {
                runtime: runtime.clone(),
                sdk,
                broadcast_tx,
                auth_token: None,
                gateway_token: None,
                default_agent_id: "agent-test".to_string(),
                default_context_id: "context-test".to_string(),
                identity: ServerIdentityConfig::default(),
                core_config_path: Some(managed_config_path.clone()),
                managed_config_path: Some(managed_config_path),
            }),
            runtime,
        )
    }

    async fn test_state_at(path: &std::path::Path) -> (Arc<AppState>, MorphzRuntime) {
        test_state_at_with_workers(path, true).await
    }

    async fn test_state() -> (Arc<AppState>, MorphzRuntime) {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        drop(tmp);
        test_state_at(&path).await
    }

    async fn routed_completion_for_session(
        runtime: &MorphzRuntime,
        client: &crate::provider::routing::RoutedClient,
        session_id: &str,
        prompt: &str,
    ) -> Response {
        let identity = runtime.identity().clone();
        runtime
            .ensure_session(NewSession {
                id: session_id.to_string(),
                agent_id: identity.agent_id,
                context_id: identity.context_id.clone(),
                parent_session_id: None,
                title: "Provider route test".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let binding = client
            .bind_model_attempt(&ModelRequestContext {
                context_id: identity.context_id,
                session_id: session_id.to_string(),
                attempt_id: format!("provider-route-test:{session_id}"),
                objective_id: None,
                required_capabilities: Vec::new(),
            })
            .await
            .unwrap();
        let (stream, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let drain = tokio::spawn(async move { while receiver.recv().await.is_some() {} });
        let response = client
            .create_completion_bound_stream(
                &binding,
                vec![Message {
                    role: "user".to_string(),
                    content: prompt.to_string(),
                    name: None,
                    tool_call_id: None,
                    tool_calls: None,
                }],
                Vec::new(),
                None,
                stream,
            )
            .await
            .unwrap();
        drain.abort();
        response
    }

    #[test]
    fn dashboard_auth_accepts_local_no_token_mode() {
        assert!(token_is_authorized(None, &HeaderMap::new(), None));
    }

    #[test]
    fn tokenless_loopback_cors_accepts_only_loopback_web_origins() {
        for origin in [
            "http://localhost:5173",
            "http://127.0.0.1:3000",
            "http://[::1]:8080",
        ] {
            assert!(is_loopback_web_origin(&origin.parse().unwrap()), "{origin}");
        }
        for origin in ["https://example.com", "null", "not-an-origin"] {
            assert!(
                !is_loopback_web_origin(&origin.parse().unwrap()),
                "{origin}"
            );
        }
    }

    #[tokio::test]
    async fn api_errors_have_one_stable_envelope_and_hide_internal_details() {
        let bad_request = error_response(StatusCode::BAD_REQUEST, "bad input");
        let body = axum::body::to_bytes(bad_request.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["error"]["code"], "invalid_argument");
        assert_eq!(value["error"]["message"], "bad input");

        let internal = error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "database password and implementation detail",
        );
        let body = axum::body::to_bytes(internal.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["error"]["code"], "internal");
        assert_eq!(
            value["error"]["message"],
            "The server could not complete the request"
        );
        assert!(!body
            .windows("database password".len())
            .any(|window| window == b"database password"));

        let unavailable = sdk_error_response(SdkError::new(
            SdkErrorCode::Unavailable,
            "Edge pairing storage is temporarily unavailable; retry the same request",
        ));
        assert_eq!(unavailable.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = axum::body::to_bytes(unavailable.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["error"]["code"], "unavailable");
        assert_ne!(value["error"]["code"], "unauthorized");

        let extractor_rejection = normalize_api_error_response(
            "/api/objectives",
            (StatusCode::BAD_REQUEST, "Failed to deserialize JSON").into_response(),
        );
        assert_eq!(
            extractor_rejection
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some("application/json")
        );
        let body = axum::body::to_bytes(extractor_rejection.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["error"]["code"], "invalid_argument");
        assert_eq!(value["error"]["message"], "Invalid request");
        assert!(!body
            .windows("deserialize".len())
            .any(|window| window == b"deserialize"));

        let dashboard_error = normalize_api_error_response(
            "/assets/missing.js",
            (StatusCode::NOT_FOUND, "asset missing").into_response(),
        );
        let body = axum::body::to_bytes(dashboard_error.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&body[..], b"asset missing");
    }

    #[tokio::test]
    async fn status_declares_http_and_sdk_contract_versions() {
        let (state, _) = test_state().await;
        let response = handle_status(State(state), HeaderMap::new(), Query(AuthQuery::default()))
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["api_contract_version"], "1");
        assert_eq!(
            value["sdk_contract_version"],
            crate::sdk::SDK_CONTRACT_VERSION
        );
    }

    #[tokio::test]
    async fn observability_endpoints_require_operator_auth_and_export_metrics() {
        let (mut state, runtime) = test_state().await;
        Arc::get_mut(&mut state).unwrap().auth_token = Some("metrics-secret".to_string());
        runtime.observability().record_turn_stage(
            "msg-observability-test",
            Some("context-test"),
            Some("session-test"),
            "context.build",
            std::time::Duration::from_millis(125),
            "ok",
            None,
        );

        let unauthorized = handle_prometheus_metrics(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
        )
        .await;
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer metrics-secret"),
        );
        let response = handle_prometheus_metrics(
            State(Arc::clone(&state)),
            headers.clone(),
            Query(AuthQuery::default()),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body = std::str::from_utf8(&body).unwrap();
        assert!(body.contains("morphz_turn_stage_duration_seconds_bucket"));
        assert!(!body.contains("msg-observability-test"));

        let response = handle_turn_trace(
            State(state),
            Path("msg-observability-test".to_string()),
            headers,
            Query(AuthQuery::default()),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["root_turn_id"], "msg-observability-test");
        assert_eq!(value["stages"][0]["stage"], "context.build");
    }

    #[tokio::test]
    async fn system_prompt_endpoint_exposes_the_authoritative_profile_content_and_hash() {
        let (state, _) = test_state().await;
        let response =
            handle_get_system_prompt(State(state), HeaderMap::new(), Query(AuthQuery::default()))
                .await
                .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: Value = serde_json::from_slice(&body).unwrap();
        let inspection =
            crate::orchestrator::orchestrator::production_system_prompt_inspection().unwrap();
        assert_eq!(payload["profile"], inspection.profile);
        assert_eq!(payload["content"], inspection.content);
        assert_eq!(payload["stable"], true);
        assert_eq!(payload["bytes"], inspection.content.len());
        assert_eq!(payload["chars"], inspection.content.chars().count());
        assert_eq!(
            payload["sha256"],
            format!("sha256:{:x}", Sha256::digest(inspection.content.as_bytes()))
        );
    }

    #[tokio::test]
    async fn objective_http_creation_atomically_binds_exact_harness() {
        let (state, runtime) = test_state().await;
        let session_response = handle_create_session(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(CreateSessionRequest {
                id: Some("harness-http-session".to_string()),
                agent_id: None,
                parent_session_id: None,
                title: Some("Harness HTTP".to_string()),
                mount: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(session_response.status(), StatusCode::CREATED);
        let package = crate::harness_package::HarnessPackage::from_source(
            "http-test.hns",
            r#"
                (manifest
                  (id http-test)
                  (version "1.2.3")
                  (title "HTTP Test")
                  (capabilities (tools read)))
                (contract (identity "http-test"))
                (eval
                  (requires (tools read))
                  (call read (path "README.md")))
            "#,
        )
        .unwrap();
        runtime.register_harness_package(package).await.unwrap();

        let response = handle_create_objective(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(CreateObjectiveRequest {
                id: Some("objective-http-harness".to_string()),
                coordinator_session_id: "harness-http-session".to_string(),
                delivery_session_id: None,
                parent_objective_id: None,
                stated_objective: "通过 HTTP 运行精确 Harness".to_string(),
                token_budget: Some(4_096),
                harness: Some(ExactHarnessRef {
                    id: "http-test".to_string(),
                    version: "1.2.3".to_string(),
                }),
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::CREATED);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            value["objective"]["id"],
            serde_json::json!("objective-http-harness")
        );
        assert_eq!(
            value["harness_binding"]["harness_id"],
            serde_json::json!("http-test")
        );
        assert_eq!(
            value["harness_binding"]["harness_version"],
            serde_json::json!("1.2.3")
        );
        let objective_request_events = runtime
            .query_events(QueryFilter {
                context_id: Some("context-test".to_string()),
                topic: Some("objective/requested".to_string()),
                ..QueryFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(objective_request_events.len(), 1);
        assert_eq!(
            objective_request_events[0]
                .payload
                .get("requested_objective_id"),
            Some(&serde_json::json!("objective-http-harness"))
        );
        assert_eq!(
            objective_request_events[0].actor,
            objective_request_events[0]
                .payload
                .get("principal_id")
                .and_then(Value::as_str)
                .unwrap()
        );
        assert_eq!(
            objective_request_events[0].payload.get("source_origin"),
            Some(&serde_json::json!("http"))
        );

        let duplicate = handle_create_objective(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(CreateObjectiveRequest {
                id: Some("objective-http-harness".to_string()),
                coordinator_session_id: "harness-http-session".to_string(),
                delivery_session_id: None,
                parent_objective_id: None,
                stated_objective: "duplicate must not leave a source Event".to_string(),
                token_budget: None,
                harness: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(duplicate.status(), StatusCode::CONFLICT);
        assert_eq!(
            runtime
                .query_events(QueryFilter {
                    context_id: Some("context-test".to_string()),
                    topic: Some("objective/requested".to_string()),
                    ..QueryFilter::default()
                })
                .await
                .unwrap()
                .len(),
            1,
            "a rejected Objective must not leave an orphan request Event"
        );

        // Objective creation may immediately hand the record to the supervisor,
        // which advances its revision before this HTTP round trip continues.
        // Editing must therefore fence against the latest authoritative record,
        // not the creation response snapshot.
        let objective_before_edit = runtime
            .get_objective("objective-http-harness")
            .await
            .unwrap()
            .unwrap();
        let edit_response = handle_edit_objective(
            State(Arc::clone(&state)),
            Path("objective-http-harness".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(EditObjectiveRequest {
                expected_revision: objective_before_edit.revision,
                stated_objective: "通过 HTTP 编辑后的精确 Harness 目标".to_string(),
            }),
        )
        .await
        .into_response();
        assert_eq!(edit_response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(edit_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let edited: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            edited["objective"]["stated_objective"],
            serde_json::json!("通过 HTTP 编辑后的精确 Harness 目标")
        );
        assert_eq!(
            edited["objective"]["revision"],
            serde_json::json!(objective_before_edit.revision + 1)
        );
    }

    #[tokio::test]
    async fn event_with_only_session_route_mounts_into_default_context() {
        let (_, runtime) = test_state().await;

        ensure_dashboard_event_session_route(
            &runtime,
            "agent-test",
            "context-test",
            ServerIdentityMode::Default,
            "session-from-event",
            None,
            None,
        )
        .await
        .unwrap();

        let session = runtime
            .get_session("session-from-event")
            .await
            .unwrap()
            .expect("event route should adopt the local Session");
        assert_eq!(session.context_id, "context-test");
        assert!(runtime
            .get_context("session-from-event")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn event_without_context_uses_registered_session_mount() {
        let (state, runtime) = test_state().await;
        let response = handle_create_session(
            State(state),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(CreateSessionRequest {
                id: Some("registered-session".to_string()),
                agent_id: None,
                parent_session_id: None,
                title: Some("Registered".to_string()),
                mount: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::CREATED);

        ensure_dashboard_event_session_route(
            &runtime,
            "agent-test",
            "context-test",
            ServerIdentityMode::Default,
            "registered-session",
            None,
            None,
        )
        .await
        .unwrap();

        let session = runtime
            .get_session("registered-session")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(session.context_id, "context-test");
    }

    #[test]
    fn model_observability_events_do_not_mutate_session_activity() {
        let event = Event::new(
            "model-stream-test".to_string(),
            "Model-Provider".to_string(),
            "runtime_ephemeral".to_string(),
            "runtime/model_stream".to_string(),
            serde_json::Map::new(),
        );
        assert!(!dashboard_event_requires_session_touch(&event));

        let durable_summary = Event::new(
            "model-summary-test".to_string(),
            "Model-Provider".to_string(),
            "runtime_control".to_string(),
            "runtime/model_reasoning_summary".to_string(),
            serde_json::Map::new(),
        );
        assert!(!dashboard_event_requires_session_touch(&durable_summary));

        let model_usage = Event::new(
            "model-usage-test".to_string(),
            "Model-Provider".to_string(),
            "runtime_control".to_string(),
            "runtime/model_usage".to_string(),
            serde_json::Map::new(),
        );
        assert!(!dashboard_event_requires_session_touch(&model_usage));

        let model_request_snapshot = Event::new(
            "model-request-snapshot-test".to_string(),
            "System-ContextKernel".to_string(),
            crate::event::TYPE_PROPOSAL.to_string(),
            "runtime/model_request_snapshot".to_string(),
            serde_json::Map::new(),
        );
        assert!(!dashboard_event_requires_session_touch(
            &model_request_snapshot
        ));

        let unrelated_ephemeral = Event::new(
            "other-ephemeral-test".to_string(),
            "Runtime-Test".to_string(),
            "runtime_ephemeral".to_string(),
            "runtime/other_ephemeral".to_string(),
            serde_json::Map::new(),
        );
        assert!(dashboard_event_requires_session_touch(&unrelated_ephemeral));

        let durable = Event::new(
            "reply-test".to_string(),
            "Agent-Morphz".to_string(),
            crate::event::TYPE_AGENT_CALL.to_string(),
            "chat/reply".to_string(),
            serde_json::Map::new(),
        );
        assert!(dashboard_event_requires_session_touch(&durable));
    }

    #[test]
    fn model_attempt_snapshot_folds_latest_nonterminal_state_for_live_activation() {
        let state = |id: &str,
                     attempt: &str,
                     activation: &str,
                     value: &str,
                     terminal: bool,
                     continuation_pending: bool| {
            Event::new(
                id.to_string(),
                "Runtime-Test".to_string(),
                "runtime_control".to_string(),
                "runtime/model_attempt_state".to_string(),
                [
                    ("attempt_id".to_string(), json!(attempt)),
                    ("activation_id".to_string(), json!(activation)),
                    ("thread_id".to_string(), json!("thread-live")),
                    ("root_turn_id".to_string(), json!("root-live")),
                    ("thread_kind".to_string(), json!("dialogue_turn")),
                    ("objective_id".to_string(), json!("objective-live")),
                    ("state".to_string(), json!(value)),
                    ("terminal".to_string(), json!(terminal)),
                    (
                        "continuation_pending".to_string(),
                        json!(continuation_pending),
                    ),
                ]
                .into_iter()
                .collect(),
            )
        };
        let active = HashSet::from(["activation-live".to_string()]);
        let attempts = fold_active_model_attempts(
            vec![
                state(
                    "1",
                    "attempt-live",
                    "activation-live",
                    "queued",
                    false,
                    false,
                ),
                state(
                    "2",
                    "attempt-live",
                    "activation-live",
                    "waiting_final_output",
                    false,
                    true,
                ),
                state(
                    "3",
                    "attempt-done",
                    "activation-live",
                    "completed",
                    true,
                    false,
                ),
                state(
                    "4",
                    "attempt-stale",
                    "activation-stale",
                    "streaming",
                    false,
                    false,
                ),
            ],
            &active,
        );

        assert_eq!(attempts.len(), 1);
        assert_eq!(attempts[0].get("attempt_id"), Some(&json!("attempt-live")));
        assert_eq!(attempts[0].get("thread_id"), Some(&json!("thread-live")));
        assert_eq!(attempts[0].get("root_turn_id"), Some(&json!("root-live")));
        assert_eq!(
            attempts[0].get("objective_id"),
            Some(&json!("objective-live"))
        );
        assert_eq!(
            attempts[0].get("state"),
            Some(&json!("waiting_final_output"))
        );
        assert_eq!(attempts[0].get("continuation_pending"), Some(&json!(true)));
    }

    #[test]
    fn embedded_dashboard_assets_form_a_self_contained_entrypoint() {
        let index = std::str::from_utf8(DASHBOARD_INDEX).unwrap();
        assert!(index.contains("./assets/app.js"));
        assert!(index.contains("./assets/app.css"));
        assert!(index.contains("<base href=\"/\" />"));
        assert!(!DASHBOARD_APP_JS.is_empty());
        assert!(!DASHBOARD_APP_CSS.is_empty());
        assert!(std::str::from_utf8(DASHBOARD_FAVICON)
            .unwrap()
            .contains("<svg"));
    }

    #[test]
    fn dashboard_base_path_is_normalized_and_injected_into_embedded_html() {
        assert_eq!(normalize_dashboard_base_path("").unwrap(), "/");
        assert_eq!(
            normalize_dashboard_base_path("/console").unwrap(),
            "/console/"
        );
        assert_eq!(
            normalize_dashboard_base_path("/internal//console///").unwrap(),
            "/internal/console/"
        );
        assert!(normalize_dashboard_base_path("console").is_err());
        assert!(normalize_dashboard_base_path("/console/../admin").is_err());
        assert!(normalize_dashboard_base_path("/console/\"bad").is_err());

        let cloud_index = dashboard_index_html("/console/");
        assert!(cloud_index.contains("<base href=\"/console/\">"));
        assert!(cloud_index.contains("./assets/app.js"));
    }

    #[tokio::test]
    async fn dashboard_fallback_serves_spa_routes_but_never_masks_missing_api() {
        let route = handle_dashboard_fallback(
            "/contexts/context-a/threads/thread-b"
                .parse::<Uri>()
                .unwrap(),
        )
        .await;
        assert_eq!(route.status(), StatusCode::OK);
        assert_eq!(
            route.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/html; charset=utf-8"
        );

        let missing_api = handle_dashboard_fallback("/api/not-real".parse::<Uri>().unwrap()).await;
        assert_eq!(missing_api.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn dashboard_auth_requires_matching_bearer_or_query_token() {
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "Bearer correct".parse().unwrap());
        assert!(token_is_authorized(Some("correct"), &headers, None));
        assert!(token_is_authorized(
            Some("correct"),
            &HeaderMap::new(),
            Some("correct")
        ));
        assert!(!token_is_authorized(
            Some("correct"),
            &HeaderMap::new(),
            Some("wrong")
        ));
    }

    #[test]
    fn external_principal_ids_accept_provider_native_opaque_values() {
        assert!(validate_principal_id("o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat").is_ok());
        assert!(validate_principal_id("github/user+release=bot%2F1").is_ok());
        assert!(validate_principal_id(" principal").is_err());
        assert!(validate_principal_id("principal\nforged").is_err());
    }

    fn gateway_headers(principal_id: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            "Bearer gateway-secret".parse().unwrap(),
        );
        if let Some(principal_id) = principal_id {
            headers.insert(
                header::HeaderName::from_static("x-morphz-principal"),
                principal_id.parse().unwrap(),
            );
        }
        headers
    }

    fn dashboard_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            "Bearer dashboard-secret".parse().unwrap(),
        );
        headers
    }

    #[tokio::test]
    async fn rejected_gateway_preconditions_do_not_leave_new_blank_context() {
        let (default_state, runtime) = test_state().await;
        let state = Arc::new(AppState {
            runtime: runtime.clone(),
            sdk: MorphzSdk::new(runtime.clone()),
            broadcast_tx: default_state.broadcast_tx.clone(),
            auth_token: Some("dashboard-secret".to_string()),
            gateway_token: Some("gateway-secret".to_string()),
            default_agent_id: "agent-test".to_string(),
            default_context_id: "context-test".to_string(),
            identity: ServerIdentityConfig {
                mode: ServerIdentityMode::TrustedGateway,
                provider_id: "morphz-site".to_string(),
                service_token_env: "MORPHZ_API_TOKEN".to_string(),
            },
            core_config_path: default_state.core_config_path.clone(),
            managed_config_path: default_state.managed_config_path.clone(),
        });

        let response = handle_create_session(
            State(Arc::clone(&state)),
            gateway_headers(Some("principal-web-test")),
            Query(AuthQuery::default()),
            Json(CreateSessionRequest {
                id: Some("gateway-provider-conflict-session".to_string()),
                agent_id: None,
                parent_session_id: None,
                title: Some("Rejected".to_string()),
                mount: Some(ContextMountRequest::NewBlankContext {
                    context_id: Some("gateway-provider-conflict-context".to_string()),
                    context_title: Some("Must not remain".to_string()),
                }),
            }),
        )
        .await
        .into_response();

        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert!(runtime
            .get_context("gateway-provider-conflict-context")
            .await
            .unwrap()
            .is_none());
        assert!(runtime
            .get_session("gateway-provider-conflict-session")
            .await
            .unwrap()
            .is_none());

        let parent = handle_create_session(
            State(Arc::clone(&state)),
            gateway_headers(Some("site-user-parent-owner")),
            Query(AuthQuery::default()),
            Json(CreateSessionRequest {
                id: Some("gateway-owned-parent".to_string()),
                agent_id: None,
                parent_session_id: None,
                title: Some("Owned parent".to_string()),
                mount: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(parent.status(), StatusCode::CREATED);

        let foreign_child = handle_create_session(
            State(Arc::clone(&state)),
            gateway_headers(Some("site-user-foreign-child")),
            Query(AuthQuery::default()),
            Json(CreateSessionRequest {
                id: Some("gateway-foreign-child".to_string()),
                agent_id: None,
                parent_session_id: Some("gateway-owned-parent".to_string()),
                title: Some("Rejected child".to_string()),
                mount: Some(ContextMountRequest::NewBlankContext {
                    context_id: Some("gateway-foreign-child-context".to_string()),
                    context_title: Some("Must not remain".to_string()),
                }),
            }),
        )
        .await
        .into_response();
        assert_eq!(foreign_child.status(), StatusCode::FORBIDDEN);
        assert!(runtime
            .get_context("gateway-foreign-child-context")
            .await
            .unwrap()
            .is_none());
        assert!(runtime
            .get_session("gateway-foreign-child")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn catalog_mutations_rename_and_archive_without_erasing_context_history() {
        let (state, runtime) = test_state().await;
        let create_context = handle_create_context(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(CreateContextRequest {
                id: Some("context-catalog-test".to_string()),
                agent_id: Some("agent-test".to_string()),
                title: Some("Before".to_string()),
            }),
        )
        .await
        .into_response();
        assert_eq!(create_context.status(), StatusCode::CREATED);

        let create_session = handle_create_session(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(CreateSessionRequest {
                id: Some("session-catalog-test".to_string()),
                agent_id: Some("agent-test".to_string()),
                parent_session_id: None,
                title: Some("Catalog Session".to_string()),
                mount: Some(ContextMountRequest::ExistingContext {
                    context_id: "context-catalog-test".to_string(),
                }),
            }),
        )
        .await
        .into_response();
        assert_eq!(create_session.status(), StatusCode::CREATED);

        let rename = handle_update_context(
            State(Arc::clone(&state)),
            Path("context-catalog-test".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(UpdateContextRequest {
                title: Some("After".to_string()),
                status: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(rename.status(), StatusCode::OK);
        assert_eq!(
            runtime
                .get_context("context-catalog-test")
                .await
                .unwrap()
                .unwrap()
                .title,
            "After"
        );

        let archive = handle_update_context(
            State(Arc::clone(&state)),
            Path("context-catalog-test".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(UpdateContextRequest {
                title: None,
                status: Some(SessionStatus::Archived),
            }),
        )
        .await
        .into_response();
        assert_eq!(archive.status(), StatusCode::OK);
        assert_eq!(
            runtime
                .get_context("context-catalog-test")
                .await
                .unwrap()
                .unwrap()
                .status,
            SessionStatus::Archived
        );
        assert_eq!(
            runtime
                .get_session("session-catalog-test")
                .await
                .unwrap()
                .unwrap()
                .status,
            SessionStatus::Archived
        );

        let archive_root = handle_update_context(
            State(Arc::clone(&state)),
            Path("context-test".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(UpdateContextRequest {
                title: None,
                status: Some(SessionStatus::Archived),
            }),
        )
        .await
        .into_response();
        assert_eq!(archive_root.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn trusted_gateway_requires_principal_and_fences_cross_identity_sessions() {
        let (default_state, runtime) = test_state().await;
        let state = Arc::new(AppState {
            runtime: runtime.clone(),
            sdk: MorphzSdk::new(runtime.clone()),
            broadcast_tx: default_state.broadcast_tx.clone(),
            auth_token: Some("dashboard-secret".to_string()),
            gateway_token: Some("gateway-secret".to_string()),
            default_agent_id: "agent-test".to_string(),
            default_context_id: "context-test".to_string(),
            identity: ServerIdentityConfig {
                mode: ServerIdentityMode::TrustedGateway,
                provider_id: "morphz-site".to_string(),
                service_token_env: "MORPHZ_API_TOKEN".to_string(),
            },
            core_config_path: default_state.core_config_path.clone(),
            managed_config_path: default_state.managed_config_path.clone(),
        });
        assert!(!websocket_may_subscribe_globally(
            &state,
            &gateway_headers(Some("site-user-1")),
            None
        ));
        let mut operator_headers = HeaderMap::new();
        operator_headers.insert(
            header::AUTHORIZATION,
            "Bearer dashboard-secret".parse().unwrap(),
        );
        assert!(websocket_may_subscribe_globally(
            &state,
            &operator_headers,
            None
        ));
        let unauthorized = handle_status(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
        let body = axum::body::to_bytes(unauthorized.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"]["code"], "unauthorized");

        let gateway_overview = handle_get_runtime_overview(
            State(Arc::clone(&state)),
            gateway_headers(Some("site-user-1")),
            Query(RuntimeOverviewHttpQuery {
                token: None,
                include_archived: false,
                context_limit: Some(10),
                sessions_per_context: Some(4),
                context_id: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(gateway_overview.status(), StatusCode::UNAUTHORIZED);

        let gateway_status = handle_status(
            State(Arc::clone(&state)),
            gateway_headers(Some("site-user-1")),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(gateway_status.status(), StatusCode::UNAUTHORIZED);

        let gateway_inference = handle_get_inference(
            State(Arc::clone(&state)),
            gateway_headers(Some("site-user-1")),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(gateway_inference.status(), StatusCode::UNAUTHORIZED);

        let gateway_agents = handle_list_agents(
            State(Arc::clone(&state)),
            gateway_headers(Some("site-user-1")),
            Query(SessionListQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(gateway_agents.status(), StatusCode::UNAUTHORIZED);

        let operator_overview = handle_get_runtime_overview(
            State(Arc::clone(&state)),
            dashboard_headers(),
            Query(RuntimeOverviewHttpQuery {
                token: None,
                include_archived: false,
                context_limit: Some(10),
                sessions_per_context: Some(4),
                context_id: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(operator_overview.status(), StatusCode::OK);

        let gateway_secrets = handle_list_managed_secrets(
            State(Arc::clone(&state)),
            gateway_headers(Some("site-user-1")),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(gateway_secrets.status(), StatusCode::UNAUTHORIZED);

        let missing_principal = handle_create_session(
            State(Arc::clone(&state)),
            gateway_headers(None),
            Query(AuthQuery::default()),
            Json(CreateSessionRequest {
                id: Some("gateway-missing-principal".to_string()),
                agent_id: None,
                parent_session_id: None,
                title: None,
                mount: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(missing_principal.status(), StatusCode::UNAUTHORIZED);

        let created = handle_create_session(
            State(Arc::clone(&state)),
            gateway_headers(Some("site-user-1")),
            Query(AuthQuery::default()),
            Json(CreateSessionRequest {
                id: Some("gateway-session-a".to_string()),
                agent_id: None,
                parent_session_id: None,
                title: Some("A".to_string()),
                mount: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(created.status(), StatusCode::CREATED);

        let own = handle_get_session(
            State(Arc::clone(&state)),
            Path("gateway-session-a".to_string()),
            gateway_headers(Some("site-user-1")),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(own.status(), StatusCode::OK);

        let objective_created = handle_create_objective(
            State(Arc::clone(&state)),
            gateway_headers(Some("site-user-1")),
            Query(AuthQuery::default()),
            Json(CreateObjectiveRequest {
                id: Some("gateway-objective-a".to_string()),
                coordinator_session_id: "gateway-session-a".to_string(),
                delivery_session_id: None,
                parent_objective_id: None,
                stated_objective: "gateway owned objective".to_string(),
                token_budget: None,
                harness: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(objective_created.status(), StatusCode::CREATED);
        let objective = runtime
            .get_objective("gateway-objective-a")
            .await
            .unwrap()
            .unwrap();
        let foreign_objective_edit = handle_edit_objective(
            State(Arc::clone(&state)),
            Path("gateway-objective-a".to_string()),
            gateway_headers(Some("site-user-2")),
            Query(AuthQuery::default()),
            Json(EditObjectiveRequest {
                expected_revision: objective.revision,
                stated_objective: "stolen objective".to_string(),
            }),
        )
        .await
        .into_response();
        assert_eq!(foreign_objective_edit.status(), StatusCode::FORBIDDEN);

        let foreign = handle_get_session(
            State(Arc::clone(&state)),
            Path("gateway-session-a".to_string()),
            gateway_headers(Some("site-user-2")),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(foreign.status(), StatusCode::FORBIDDEN);
        let body = axum::body::to_bytes(foreign.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"]["code"], "forbidden");

        let foreign_send = handle_send_message(
            State(Arc::clone(&state)),
            Path("gateway-session-a".to_string()),
            gateway_headers(Some("site-user-2")),
            Query(AuthQuery::default()),
            Json(SendMessageRequest {
                input_destination: None,
                text: "I am user 1".to_string(),
                client_message_id: Some("forged-identity-message".to_string()),
                attachments: Vec::new(),
                staged_attachment_ids: Vec::new(),
                references: Vec::new(),
                harness: None,
                dispatch_mode: None,
                model_alias: None,
                reasoning_effort: None,
                target_id: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(foreign_send.status(), StatusCode::FORBIDDEN);

        let external_principal = handle_create_session(
            State(Arc::clone(&state)),
            gateway_headers(Some("o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat")),
            Query(AuthQuery::default()),
            Json(CreateSessionRequest {
                id: Some("gateway-session-wechat".to_string()),
                agent_id: None,
                parent_session_id: None,
                title: Some("WeChat".to_string()),
                mount: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(external_principal.status(), StatusCode::CREATED);

        // The Dashboard Operator sees the complete catalog through its
        // administrative authorization. It must not need to impersonate or be
        // added as a participant in either trusted-gateway Session.
        let operator_sessions = handle_list_sessions(
            State(Arc::clone(&state)),
            dashboard_headers(),
            Query(SessionListQuery {
                token: None,
                include_archived: true,
            }),
        )
        .await
        .into_response();
        assert_eq!(operator_sessions.status(), StatusCode::OK);
        let body = axum::body::to_bytes(operator_sessions.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let operator_session_ids = body["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|session| session["id"].as_str())
            .collect::<HashSet<_>>();
        assert!(operator_session_ids.contains("gateway-session-a"));
        assert!(operator_session_ids.contains("gateway-session-wechat"));

        let gateway_sessions = handle_list_sessions(
            State(Arc::clone(&state)),
            gateway_headers(Some("site-user-1")),
            Query(SessionListQuery {
                token: None,
                include_archived: true,
            }),
        )
        .await
        .into_response();
        assert_eq!(gateway_sessions.status(), StatusCode::OK);
        let body = axum::body::to_bytes(gateway_sessions.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let gateway_session_ids = body["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|session| session["id"].as_str())
            .collect::<HashSet<_>>();
        assert!(gateway_session_ids.contains("gateway-session-a"));
        assert!(!gateway_session_ids.contains("gateway-session-wechat"));

        let principal_search = handle_search_operator_principals(
            State(Arc::clone(&state)),
            dashboard_headers(),
            Query(PrincipalDirectoryQuery {
                token: None,
                query: "site-user".to_string(),
                cursor: None,
                limit: Some(20),
            }),
        )
        .await
        .into_response();
        assert_eq!(principal_search.status(), StatusCode::OK);
        let body = axum::body::to_bytes(principal_search.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(body["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["principal"]["id"] == "site-user-1"));

        let external_principal_search = handle_search_operator_principals(
            State(Arc::clone(&state)),
            dashboard_headers(),
            Query(PrincipalDirectoryQuery {
                token: None,
                query: "wechat".to_string(),
                cursor: None,
                limit: Some(20),
            }),
        )
        .await
        .into_response();
        assert_eq!(external_principal_search.status(), StatusCode::OK);
        let body = axum::body::to_bytes(external_principal_search.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(body["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| { entry["principal"]["id"] == "o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat" }));

        let status_response = handle_status(
            State(Arc::clone(&state)),
            dashboard_headers(),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(status_response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(status_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["identity_mode"], "trusted-gateway");
        assert_eq!(body["identity_provider_id"], "morphz-site");

        let observed_sessions = handle_list_operator_principal_sessions(
            State(Arc::clone(&state)),
            Path("site-user-1".to_string()),
            dashboard_headers(),
            Query(OperatorPrincipalSessionsQuery {
                token: None,
                include_archived: true,
            }),
        )
        .await
        .into_response();
        assert_eq!(observed_sessions.status(), StatusCode::OK);

        let operator_read = handle_get_session(
            State(Arc::clone(&state)),
            Path("gateway-session-a".to_string()),
            dashboard_headers(),
            Query(AuthQuery {
                token: None,
                session_id: None,
                principal_id: Some("site-user-1".to_string()),
                ..Default::default()
            }),
        )
        .await
        .into_response();
        assert_eq!(operator_read.status(), StatusCode::OK);

        // A Dashboard Operator may change the Session's Evaluation model as
        // control-plane policy without impersonating its participant.
        let operator_model_update = handle_update_session(
            State(Arc::clone(&state)),
            Path("gateway-session-a".to_string()),
            dashboard_headers(),
            Query(AuthQuery::default()),
            Json(UpdateSessionRequest {
                title: None,
                status: None,
                model_alias: Some("fixture-model".to_string()),
                reasoning_effort: None,
                permission_mode: None,
                sandbox_mode: None,
                default_target_id: None,
                context_sharing: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(operator_model_update.status(), StatusCode::OK);
        assert_eq!(
            runtime
                .get_session("gateway-session-a")
                .await
                .unwrap()
                .unwrap()
                .model_alias
                .as_deref(),
            Some("fixture-model")
        );
        let refreshed_sessions = handle_list_operator_principal_sessions(
            State(Arc::clone(&state)),
            Path("site-user-1".to_string()),
            dashboard_headers(),
            Query(OperatorPrincipalSessionsQuery {
                token: None,
                include_archived: true,
            }),
        )
        .await
        .into_response();
        assert_eq!(refreshed_sessions.status(), StatusCode::OK);
        let body = axum::body::to_bytes(refreshed_sessions.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let refreshed = body["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|session| session["id"] == "gateway-session-a")
            .unwrap();
        assert_eq!(refreshed["model_alias"], "fixture-model");

        // Session context sharing is also an Operator-owned control-plane
        // policy. It may be changed while observing another Principal without
        // granting authorship over that Session.
        let operator_sharing_update = handle_update_session(
            State(Arc::clone(&state)),
            Path("gateway-session-a".to_string()),
            dashboard_headers(),
            Query(AuthQuery::default()),
            Json(UpdateSessionRequest {
                title: None,
                status: None,
                model_alias: None,
                reasoning_effort: None,
                permission_mode: None,
                sandbox_mode: None,
                default_target_id: None,
                context_sharing: Some(crate::memory::SessionContextSharing::Isolated),
            }),
        )
        .await
        .into_response();
        assert_eq!(operator_sharing_update.status(), StatusCode::OK);
        assert_eq!(
            runtime
                .get_session("gateway-session-a")
                .await
                .unwrap()
                .unwrap()
                .context_sharing,
            crate::memory::SessionContextSharing::Isolated
        );
        let participant_sharing_update = handle_update_session(
            State(Arc::clone(&state)),
            Path("gateway-session-a".to_string()),
            gateway_headers(Some("site-user-1")),
            Query(AuthQuery::default()),
            Json(UpdateSessionRequest {
                title: None,
                status: None,
                model_alias: None,
                reasoning_effort: None,
                permission_mode: None,
                sandbox_mode: None,
                default_target_id: None,
                context_sharing: Some(crate::memory::SessionContextSharing::Shared),
            }),
        )
        .await
        .into_response();
        assert_eq!(participant_sharing_update.status(), StatusCode::FORBIDDEN);

        // The exception is intentionally narrow: participant-owned metadata
        // remains read-only to the observing Operator.
        let operator_title_update = handle_update_session(
            State(Arc::clone(&state)),
            Path("gateway-session-a".to_string()),
            dashboard_headers(),
            Query(AuthQuery::default()),
            Json(UpdateSessionRequest {
                title: Some("Operator must not rewrite this".to_string()),
                status: None,
                model_alias: None,
                reasoning_effort: None,
                permission_mode: None,
                sandbox_mode: None,
                default_target_id: None,
                context_sharing: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(operator_title_update.status(), StatusCode::FORBIDDEN);

        // Observation scope is intentionally ignored by write endpoints. An
        // Operator may inspect a Principal's Session, but may not send a
        // message while impersonating that Principal.
        let operator_impersonated_send = handle_send_message(
            State(Arc::clone(&state)),
            Path("gateway-session-a".to_string()),
            dashboard_headers(),
            Query(AuthQuery {
                token: None,
                session_id: None,
                principal_id: Some("site-user-1".to_string()),
                ..Default::default()
            }),
            Json(SendMessageRequest {
                input_destination: None,
                text: "operator must not impersonate".to_string(),
                client_message_id: Some("operator-impersonation-message".to_string()),
                attachments: Vec::new(),
                staged_attachment_ids: Vec::new(),
                references: Vec::new(),
                harness: None,
                dispatch_mode: None,
                model_alias: None,
                reasoning_effort: None,
                target_id: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(operator_impersonated_send.status(), StatusCode::FORBIDDEN);

        let operator = handle_create_session(
            State(state),
            dashboard_headers(),
            Query(AuthQuery::default()),
            Json(CreateSessionRequest {
                id: Some("dashboard-session-in-trusted-mode".to_string()),
                agent_id: None,
                parent_session_id: None,
                title: Some("Dashboard".to_string()),
                mount: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(operator.status(), StatusCode::CREATED);
    }

    #[tokio::test]
    async fn trusted_gateway_can_explicitly_claim_legacy_session_mapping() {
        let (default_state, runtime) = test_state().await;
        runtime
            .create_session(NewSession {
                id: "legacy-site-session".to_string(),
                agent_id: "agent-test".to_string(),
                context_id: "context-test".to_string(),
                parent_session_id: None,
                title: "Legacy".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let state = Arc::new(AppState {
            runtime: runtime.clone(),
            sdk: MorphzSdk::new(runtime),
            broadcast_tx: default_state.broadcast_tx.clone(),
            auth_token: Some("dashboard-secret".to_string()),
            gateway_token: Some("gateway-secret".to_string()),
            default_agent_id: "agent-test".to_string(),
            default_context_id: "context-test".to_string(),
            identity: ServerIdentityConfig {
                mode: ServerIdentityMode::TrustedGateway,
                provider_id: "morphz-site".to_string(),
                service_token_env: "MORPHZ_API_TOKEN".to_string(),
            },
            core_config_path: default_state.core_config_path.clone(),
            managed_config_path: default_state.managed_config_path.clone(),
        });

        let claim = handle_bind_session_principal(
            State(Arc::clone(&state)),
            Path("legacy-site-session".to_string()),
            gateway_headers(Some("site-user-9")),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(claim.status(), StatusCode::OK);

        let read = handle_get_session(
            State(state),
            Path("legacy-site-session".to_string()),
            gateway_headers(Some("site-user-9")),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(read.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn dashboard_reasoning_control_persists_for_restart_and_changes_subsequent_requests() {
        let (state, runtime) = test_state().await;
        let managed_config_path = state.managed_config_path.clone().unwrap();
        let response = handle_update_inference(
            State(state),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(UpdateInferenceRequest {
                model: None,
                reasoning_effort: Some("none".to_string()),
                prompt_token_limit: None,
            }),
        )
        .await
        .into_response();

        if response.status() != StatusCode::OK {
            let status = response.status();
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            panic!(
                "unexpected inference response {status}: {}",
                String::from_utf8_lossy(&body)
            );
        }
        assert_eq!(runtime.reasoning_effort(), Some(ReasoningEffort::Off));
        assert_eq!(runtime.config().llm.reasoning_effort, None);
        let managed = std::fs::read_to_string(managed_config_path).unwrap();
        assert!(managed.contains("reasoning_effort = \"none\""));
    }

    #[tokio::test]
    async fn dashboard_exposes_only_native_grok_45_effort_levels_and_rejects_max() {
        let tmp = NamedTempFile::new().unwrap();
        let database_path = tmp.path().to_path_buf();
        drop(tmp);
        let mut config = AppConfig::default();
        config.llm.model = "grok-route".to_string();
        config.provider_instances.insert(
            "xai-subscription".to_string(),
            ProviderInstanceConfig {
                adapter: "xai-subscription".to_string(),
                protocol: crate::config::ModelProtocol::OpenaiResponses,
                base_url: "https://cli-chat-proxy.grok.com/v1".to_string(),
                accounts: vec!["xai-account".to_string()],
                ..ProviderInstanceConfig::default()
            },
        );
        config.auth_accounts.insert(
            "xai-account".to_string(),
            AuthAccountConfig {
                auth_adapter: "none".to_string(),
                provider: Some("xai-subscription".to_string()),
                ..AuthAccountConfig::default()
            },
        );
        config.model_routes.insert(
            "grok-route".to_string(),
            crate::config::ModelRouteConfig {
                candidates: vec![crate::config::ModelRouteCandidateConfig {
                    provider: "xai-subscription".to_string(),
                    account: Some("xai-account".to_string()),
                    model: "grok-4.5".to_string(),
                    ..crate::config::ModelRouteCandidateConfig::default()
                }],
                ..crate::config::ModelRouteConfig::default()
            },
        );
        let (state, runtime) =
            test_state_at_with_config_auth_and_secrets(&database_path, false, config, None, None)
                .await;

        let options = runtime.inference_model_options().await.unwrap();
        assert_eq!(
            options[0].supported_reasoning_efforts.as_deref(),
            Some(["low".to_string(), "medium".to_string(), "high".to_string()].as_slice())
        );

        let response = handle_update_inference(
            State(state),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(UpdateInferenceRequest {
                model: Some("grok-route".to_string()),
                reasoning_effort: Some("max".to_string()),
                prompt_token_limit: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body = String::from_utf8_lossy(&body);
        assert!(body.contains("supports only: low, medium, high"));
        assert_eq!(runtime.reasoning_effort(), None);
    }

    #[tokio::test]
    async fn provider_catalog_http_mutations_compose_before_runtime_restart() {
        let tmp = NamedTempFile::new().unwrap();
        let database_path = tmp.path().to_path_buf();
        drop(tmp);
        let (state, _runtime) = test_state_at_with_workers(&database_path, false).await;
        let managed_config_path = state.managed_config_path.clone().unwrap();
        let provider = ProviderInstanceConfig {
            adapter: "openai-compatible".to_string(),
            protocol: crate::config::ModelProtocol::OpenaiResponses,
            base_url: "http://localhost:9911/v1".to_string(),
            ..ProviderInstanceConfig::default()
        };
        let response = handle_put_provider_instance_config(
            State(Arc::clone(&state)),
            Path("secondary".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(provider.clone()),
        )
        .await
        .into_response();
        if response.status() != StatusCode::OK {
            let status = response.status();
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            panic!(
                "unexpected provider mutation response {status}: {}",
                String::from_utf8_lossy(&body)
            );
        }

        let account = AuthAccountConfig {
            auth_adapter: "none".to_string(),
            provider: Some("secondary".to_string()),
            label: Some("Local anonymous".to_string()),
            ..AuthAccountConfig::default()
        };
        let response = handle_put_auth_account_config(
            State(Arc::clone(&state)),
            Path("secondary-local".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(account),
        )
        .await
        .into_response();
        if response.status() != StatusCode::OK {
            let status = response.status();
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            panic!(
                "unexpected account mutation response {status}: {}",
                String::from_utf8_lossy(&body)
            );
        }

        let response = handle_put_provider_instance_config(
            State(Arc::clone(&state)),
            Path("secondary".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(ProviderInstanceConfig {
                accounts: vec!["secondary-local".to_string()],
                ..provider
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);

        let response = handle_put_model_route_config(
            State(state),
            Path("coding-secondary".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(ModelRouteConfig {
                aliases: vec!["secondary/coding".to_string()],
                candidates: vec![crate::config::ModelRouteCandidateConfig {
                    provider: "secondary".to_string(),
                    model: "coding-model".to_string(),
                    ..crate::config::ModelRouteCandidateConfig::default()
                }],
                ..ModelRouteConfig::default()
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);

        let managed: AppConfig =
            toml::from_str(&std::fs::read_to_string(&managed_config_path).unwrap()).unwrap();
        assert_eq!(
            managed.provider_instances["secondary"].accounts,
            ["secondary-local"]
        );
        assert_eq!(
            managed.auth_accounts["secondary-local"].provider.as_deref(),
            Some("secondary")
        );
        assert_eq!(
            managed.model_routes["coding-secondary"].aliases,
            ["secondary/coding"]
        );
    }

    #[tokio::test]
    async fn dashboard_auto_review_model_is_hot_applied_persisted_and_removable() {
        let (state, runtime) = test_state().await;
        let snapshot = runtime.provider_control_snapshot().await.unwrap();
        assert_eq!(
            snapshot.reviewer,
            crate::permission::ReviewerKind::AutoReview
        );
        assert_eq!(snapshot.auto_review_model, None);
        let route_id = snapshot
            .model_routes
            .keys()
            .next()
            .cloned()
            .expect("fixture provider must expose one route");

        let response = handle_update_auto_review_model(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(UpdateAutoReviewModelRequest {
                model: Some(route_id.clone()),
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            runtime.auto_review_model().as_deref(),
            Some(route_id.as_str())
        );
        assert_eq!(
            runtime
                .provider_control_snapshot()
                .await
                .unwrap()
                .auto_review_model
                .as_deref(),
            Some(route_id.as_str())
        );
        let managed_path = state.managed_config_path.as_deref().unwrap();
        let persisted: AppConfig =
            toml::from_str(&std::fs::read_to_string(managed_path).unwrap()).unwrap();
        assert_eq!(
            persisted.permissions.auto_review_model.as_deref(),
            Some(route_id.as_str())
        );

        let response = handle_update_auto_review_model(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(UpdateAutoReviewModelRequest { model: None }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(runtime.auto_review_model(), None);
        let restored: AppConfig =
            toml::from_str(&std::fs::read_to_string(managed_path).unwrap()).unwrap();
        assert_eq!(restored.permissions.auto_review_model, None);
    }

    #[tokio::test]
    async fn dashboard_can_delete_an_account_bound_only_to_its_default_agent() {
        let tmp = tempfile::tempdir().unwrap();
        let database_path = tmp.path().join("morphz.db");
        let (state, runtime) = test_state_at_with_config_auth_and_secrets(
            &database_path,
            true,
            AppConfig::default(),
            None,
            None,
        )
        .await;

        let account_id = "dashboard-default-account";
        let created = handle_put_auth_account_config(
            State(Arc::clone(&state)),
            Path(account_id.to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(AuthAccountConfig {
                auth_adapter: "none".to_string(),
                ..AuthAccountConfig::default()
            }),
        )
        .await
        .into_response();
        assert_eq!(created.status(), StatusCode::OK);
        assert_eq!(
            runtime
                .agent_provider_bindings("agent-test")
                .await
                .unwrap()
                .bindings
                .iter()
                .map(|binding| binding.account_id.as_str())
                .collect::<Vec<_>>(),
            vec![account_id]
        );

        let deleted = handle_delete_provider_account(
            State(Arc::clone(&state)),
            Path(account_id.to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(deleted.status(), StatusCode::OK);
        assert!(!runtime
            .provider_catalog_config()
            .unwrap()
            .auth_accounts
            .contains_key(account_id));
        assert!(runtime
            .agent_provider_bindings("agent-test")
            .await
            .unwrap()
            .bindings
            .is_empty());
    }

    #[tokio::test]
    async fn dashboard_provider_setup_atomically_persists_a_complete_catalog() {
        let tmp = tempfile::tempdir().unwrap();
        let database_path = tmp.path().join("morphz.db");
        let (state, _runtime) = test_state_at_with_config_auth_and_secrets(
            &database_path,
            false,
            AppConfig::default(),
            None,
            None,
        )
        .await;
        let managed_config_path = state.managed_config_path.clone().unwrap();

        let response = handle_put_provider_catalog_setup(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(PutProviderCatalogSetupRequest {
                provider_id: "dashboard-provider".to_string(),
                provider: ProviderInstanceConfig {
                    adapter: "openai-compatible".to_string(),
                    protocol: crate::config::ModelProtocol::OpenaiResponses,
                    base_url: "http://localhost:9912/v1".to_string(),
                    accounts: vec!["dashboard-account".to_string()],
                    ..ProviderInstanceConfig::default()
                },
                account_id: "dashboard-account".to_string(),
                account: AuthAccountConfig {
                    auth_adapter: "credential".to_string(),
                    credential_ref: "dashboard-credential".to_string(),
                    provider: Some("dashboard-provider".to_string()),
                    ..AuthAccountConfig::default()
                },
                credential_id: Some("dashboard-credential".to_string()),
                credential: Some(crate::config::CredentialConfig {
                    source: crate::config::CredentialSource::Env,
                    name: Some("MORPHZ_PROVIDER_DASHBOARD_API_KEY".to_string()),
                    ..crate::config::CredentialConfig::default()
                }),
                managed_secret: Some(PutManagedSecretRequest {
                    name: "MORPHZ_PROVIDER_DASHBOARD_API_KEY".to_string(),
                    value: "dashboard-secret-value".to_string(),
                    scope_kind: crate::secret_store::SecretScopeKind::Runtime,
                    scope_id: None,
                    value_backend: None,
                }),
                route_id: "dashboard-model".to_string(),
                route: ModelRouteConfig {
                    aliases: vec!["dashboard/model".to_string()],
                    candidates: vec![crate::config::ModelRouteCandidateConfig {
                        provider: "dashboard-provider".to_string(),
                        account: Some("dashboard-account".to_string()),
                        model: "physical-model".to_string(),
                        ..crate::config::ModelRouteCandidateConfig::default()
                    }],
                    ..ModelRouteConfig::default()
                },
            }),
        )
        .await
        .into_response();
        let response_status = response.status();
        let response_body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            response_status,
            StatusCode::OK,
            "Provider setup failed: {}",
            String::from_utf8_lossy(&response_body)
        );

        let managed: AppConfig =
            toml::from_str(&std::fs::read_to_string(&managed_config_path).unwrap()).unwrap();
        assert_eq!(
            managed.provider_instances["dashboard-provider"].accounts,
            ["dashboard-account"]
        );
        assert_eq!(
            managed.auth_accounts["dashboard-account"].credential_ref,
            "dashboard-credential"
        );
        assert_eq!(
            managed.credentials["dashboard-credential"].name.as_deref(),
            Some("MORPHZ_PROVIDER_DASHBOARD_API_KEY")
        );
        assert_eq!(
            managed.model_routes["dashboard-model"].aliases,
            ["dashboard/model"]
        );
        assert_eq!(managed.llm.model, "dashboard-model");
        assert!(!std::fs::read_to_string(&managed_config_path)
            .unwrap()
            .contains("dashboard-secret-value"));
        let secrets = state.sdk.list_managed_secrets().unwrap();
        assert_eq!(secrets.len(), 1);
        assert_eq!(secrets[0].name, "MORPHZ_PROVIDER_DASHBOARD_API_KEY");
    }

    #[tokio::test]
    async fn dashboard_api_key_account_lifecycle_is_hot_and_cascading() {
        let tmp = tempfile::tempdir().unwrap();
        let database_path = tmp.path().join("morphz.db");
        let (state, runtime) = test_state_at_with_config_auth_and_secrets(
            &database_path,
            false,
            AppConfig::default(),
            None,
            None,
        )
        .await;
        let setup = |suffix: &str, with_secret: bool| {
            let env_suffix = suffix.to_ascii_uppercase();
            PutProviderCatalogSetupRequest {
                provider_id: format!("provider-{suffix}"),
                provider: ProviderInstanceConfig {
                    adapter: "openai-compatible".to_string(),
                    protocol: crate::config::ModelProtocol::OpenaiResponses,
                    base_url: format!("http://{suffix}.example.test/v1"),
                    accounts: vec![format!("account-{suffix}")],
                    ..ProviderInstanceConfig::default()
                },
                account_id: format!("account-{suffix}"),
                account: AuthAccountConfig {
                    auth_adapter: if with_secret { "credential" } else { "none" }.to_string(),
                    credential_ref: if with_secret {
                        format!("credential-{suffix}")
                    } else {
                        String::new()
                    },
                    provider: Some(format!("provider-{suffix}")),
                    label: Some(format!("Account {suffix}")),
                    ..AuthAccountConfig::default()
                },
                credential_id: with_secret.then(|| format!("credential-{suffix}")),
                credential: with_secret.then(|| crate::config::CredentialConfig {
                    source: crate::config::CredentialSource::Env,
                    name: Some(format!("MORPHZ_PROVIDER_{env_suffix}_API_KEY")),
                    ..crate::config::CredentialConfig::default()
                }),
                managed_secret: with_secret.then(|| PutManagedSecretRequest {
                    name: format!("MORPHZ_PROVIDER_{env_suffix}_API_KEY"),
                    value: format!("secret-{suffix}"),
                    scope_kind: crate::secret_store::SecretScopeKind::Runtime,
                    scope_id: None,
                    value_backend: None,
                }),
                route_id: format!("route-{suffix}"),
                route: ModelRouteConfig {
                    candidates: vec![crate::config::ModelRouteCandidateConfig {
                        provider: format!("provider-{suffix}"),
                        account: Some(format!("account-{suffix}")),
                        model: format!("model-{suffix}"),
                        ..crate::config::ModelRouteCandidateConfig::default()
                    }],
                    ..ModelRouteConfig::default()
                },
            }
        };

        for request in [setup("primary", true), setup("backup", false)] {
            let response = handle_put_provider_catalog_setup(
                State(Arc::clone(&state)),
                HeaderMap::new(),
                Query(AuthQuery::default()),
                Json(request),
            )
            .await
            .into_response();
            assert_eq!(response.status(), StatusCode::OK);
        }

        let disabled = handle_control_provider_account(
            State(Arc::clone(&state)),
            Path("account-primary".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(ControlProviderAccountRequest {
                action: ProviderAccountControlAction::Disable,
                expected_revision: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(disabled.status(), StatusCode::OK);
        let snapshot = runtime.provider_control_snapshot().await.unwrap();
        let disabled_account = &snapshot.auth_accounts["account-primary"];
        assert!(!disabled_account.effective_enabled);

        let enabled = handle_control_provider_account(
            State(Arc::clone(&state)),
            Path("account-primary".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(ControlProviderAccountRequest {
                action: ProviderAccountControlAction::Enable,
                expected_revision: disabled_account.state.as_ref().map(|state| state.revision),
            }),
        )
        .await
        .into_response();
        assert_eq!(enabled.status(), StatusCode::OK);

        let mut renamed =
            runtime.provider_catalog_config().unwrap().auth_accounts["account-primary"].clone();
        renamed.label = Some("Renamed account".to_string());
        let renamed_response = handle_put_auth_account_config(
            State(Arc::clone(&state)),
            Path("account-primary".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(renamed),
        )
        .await
        .into_response();
        assert_eq!(renamed_response.status(), StatusCode::OK);
        assert_eq!(
            runtime.provider_catalog_config().unwrap().auth_accounts["account-primary"]
                .label
                .as_deref(),
            Some("Renamed account")
        );

        let deleted = handle_delete_provider_account(
            State(Arc::clone(&state)),
            Path("account-primary".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(deleted.status(), StatusCode::OK);

        let live = runtime.provider_catalog_config().unwrap();
        assert!(!live.auth_accounts.contains_key("account-primary"));
        assert!(!live.provider_instances.contains_key("provider-primary"));
        assert!(!live.model_routes.contains_key("route-primary"));
        assert!(!live.credentials.contains_key("credential-primary"));
        assert_eq!(live.llm.model, "route-backup");
        assert!(live.auth_accounts.contains_key("account-backup"));
        assert!(state.sdk.list_managed_secrets().unwrap().is_empty());

        let managed_path = state.managed_config_path.as_deref().unwrap();
        let managed: AppConfig =
            toml::from_str(&std::fs::read_to_string(managed_path).unwrap()).unwrap();
        assert!(!managed.auth_accounts.contains_key("account-primary"));
        assert!(!managed.provider_instances.contains_key("provider-primary"));
        assert!(!managed.model_routes.contains_key("route-primary"));
        assert!(!managed.credentials.contains_key("credential-primary"));
        assert_eq!(managed.llm.model, "route-backup");
    }

    #[tokio::test]
    async fn dashboard_provider_setup_rolls_back_new_secret_when_catalog_is_invalid() {
        let tmp = tempfile::tempdir().unwrap();
        let database_path = tmp.path().join("morphz.db");
        let (state, _runtime) = test_state_at_with_workers(&database_path, false).await;

        let response = handle_put_provider_catalog_setup(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(PutProviderCatalogSetupRequest {
                provider_id: "invalid-provider".to_string(),
                provider: ProviderInstanceConfig {
                    adapter: "openai-compatible".to_string(),
                    protocol: crate::config::ModelProtocol::OpenaiResponses,
                    base_url: "http://localhost:9912/v1".to_string(),
                    accounts: vec!["invalid-account".to_string()],
                    ..ProviderInstanceConfig::default()
                },
                account_id: "invalid-account".to_string(),
                account: AuthAccountConfig {
                    auth_adapter: "credential".to_string(),
                    credential_ref: "invalid-credential".to_string(),
                    provider: Some("invalid-provider".to_string()),
                    ..AuthAccountConfig::default()
                },
                credential_id: Some("invalid-credential".to_string()),
                credential: Some(crate::config::CredentialConfig {
                    source: crate::config::CredentialSource::Env,
                    name: Some("MORPHZ_PROVIDER_ROLLBACK_API_KEY".to_string()),
                    ..crate::config::CredentialConfig::default()
                }),
                managed_secret: Some(PutManagedSecretRequest {
                    name: "MORPHZ_PROVIDER_ROLLBACK_API_KEY".to_string(),
                    value: "must-not-remain".to_string(),
                    scope_kind: crate::secret_store::SecretScopeKind::Runtime,
                    scope_id: None,
                    value_backend: None,
                }),
                route_id: "invalid-route".to_string(),
                route: ModelRouteConfig {
                    candidates: vec![crate::config::ModelRouteCandidateConfig {
                        provider: "missing-provider".to_string(),
                        account: Some("invalid-account".to_string()),
                        model: "physical-model".to_string(),
                        ..crate::config::ModelRouteCandidateConfig::default()
                    }],
                    ..ModelRouteConfig::default()
                },
            }),
        )
        .await
        .into_response();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(state.sdk.list_managed_secrets().unwrap().is_empty());
        assert!(!state.managed_config_path.as_ref().unwrap().exists());
    }

    #[tokio::test]
    async fn enabled_account_models_remain_visible_without_discovery_cache() {
        let tmp = NamedTempFile::new().unwrap();
        let database_path = tmp.path().to_path_buf();
        drop(tmp);
        let (state, runtime) = test_state_at_with_workers(&database_path, false).await;
        let managed_config_path = state.managed_config_path.clone().unwrap();

        let setup = handle_put_provider_catalog_setup(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(PutProviderCatalogSetupRequest {
                provider_id: "subscription-provider".to_string(),
                provider: ProviderInstanceConfig {
                    adapter: "openai-compatible".to_string(),
                    protocol: crate::config::ModelProtocol::OpenaiResponses,
                    base_url: "https://models.example.test/v1".to_string(),
                    accounts: vec!["subscription-account".to_string()],
                    models: BTreeMap::from([(
                        "physical-subscription-model".to_string(),
                        crate::config::ProviderModelConfig::default(),
                    )]),
                    ..ProviderInstanceConfig::default()
                },
                account_id: "subscription-account".to_string(),
                account: AuthAccountConfig {
                    auth_adapter: "none".to_string(),
                    provider: Some("subscription-provider".to_string()),
                    ..AuthAccountConfig::default()
                },
                credential_id: None,
                credential: None,
                managed_secret: None,
                route_id: "subscription-model".to_string(),
                route: ModelRouteConfig {
                    candidates: vec![crate::config::ModelRouteCandidateConfig {
                        provider: "subscription-provider".to_string(),
                        account: Some("subscription-account".to_string()),
                        model: "physical-subscription-model".to_string(),
                        ..crate::config::ModelRouteCandidateConfig::default()
                    }],
                    ..ModelRouteConfig::default()
                },
            }),
        )
        .await
        .into_response();
        assert_eq!(setup.status(), StatusCode::OK);
        assert!(runtime
            .configured_models()
            .contains(&"subscription-model".to_string()));

        let before_discovery = runtime.inference_model_options().await.unwrap();
        let configured = before_discovery
            .iter()
            .find(|option| option.id == "subscription-model")
            .expect("explicitly enabled model must not depend on discovery cache");
        assert_eq!(configured.label, "physical-subscription-model");
        assert_eq!(configured.physical_models, ["physical-subscription-model"]);
        assert_eq!(configured.source, "configured");

        let projection = SqliteStore::new(database_path.to_str().unwrap())
            .await
            .unwrap();
        projection
            .replace_provider_model_catalog(
                "subscription-provider",
                "subscription-account",
                "openai-compatible",
                "test",
                "openai-responses",
                "remote_provider",
                &["physical-subscription-model".to_string()],
                Utc::now(),
            )
            .await
            .unwrap();
        drop(projection);

        let saved = handle_put_provider_account_models(
            State(Arc::clone(&state)),
            Path("subscription-account".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(PutProviderAccountModelsRequest {
                models: vec![ProviderAccountModelSelection {
                    prompt_cache_strategy: None,
                    id: "physical-subscription-model".to_string(),
                    alias: None,
                    context_window_tokens: Some(200_000),
                    max_input_tokens: None,
                    max_output_tokens: Some(4_000),
                    max_input_attachments: None,
                    max_input_attachment_bytes: None,
                    max_input_attachment_total_bytes: None,
                }],
            }),
        )
        .await
        .into_response();
        assert_eq!(saved.status(), StatusCode::OK);

        let after_enablement = runtime.inference_model_options().await.unwrap();
        let physical = after_enablement
            .iter()
            .find(|option| option.label == "physical-subscription-model")
            .unwrap();
        assert_eq!(physical.id, "subscription-model");
        assert_eq!(physical.physical_models, ["physical-subscription-model"]);
        assert!(after_enablement
            .iter()
            .all(|option| option.label != "subscription-model"));

        let aliased = handle_put_provider_account_models(
            State(Arc::clone(&state)),
            Path("subscription-account".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(PutProviderAccountModelsRequest {
                models: vec![ProviderAccountModelSelection {
                    prompt_cache_strategy: None,
                    id: "physical-subscription-model".to_string(),
                    alias: Some("fast-subscription".to_string()),
                    context_window_tokens: Some(200_000),
                    max_input_tokens: None,
                    max_output_tokens: Some(4_000),
                    max_input_attachments: None,
                    max_input_attachment_bytes: None,
                    max_input_attachment_total_bytes: None,
                }],
            }),
        )
        .await
        .into_response();
        assert_eq!(aliased.status(), StatusCode::OK);
        let after_alias = runtime.inference_model_options().await.unwrap();
        let alias = after_alias
            .iter()
            .find(|option| option.id == "subscription-model")
            .unwrap();
        assert_eq!(alias.label, "fast-subscription");
        assert_eq!(alias.physical_models, ["physical-subscription-model"]);

        let managed_before_rejection =
            std::fs::read_to_string(state.managed_config_path.as_deref().unwrap()).unwrap();
        let rejected = handle_put_provider_account_models(
            State(Arc::clone(&state)),
            Path("subscription-account".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(PutProviderAccountModelsRequest { models: Vec::new() }),
        )
        .await
        .into_response();
        let rejected_status = rejected.status();
        let rejected_body = axum::body::to_bytes(rejected.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(rejected_status, StatusCode::BAD_REQUEST);
        assert!(String::from_utf8_lossy(&rejected_body).contains("at least one model"));
        assert_eq!(
            std::fs::read_to_string(state.managed_config_path.as_deref().unwrap()).unwrap(),
            managed_before_rejection
        );
        let zero_capacity = handle_put_provider_account_models(
            State(Arc::clone(&state)),
            Path("subscription-account".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(PutProviderAccountModelsRequest {
                models: vec![ProviderAccountModelSelection {
                    prompt_cache_strategy: None,
                    id: "physical-subscription-model".to_string(),
                    alias: None,
                    context_window_tokens: Some(0),
                    max_input_tokens: None,
                    max_output_tokens: None,
                    max_input_attachments: None,
                    max_input_attachment_bytes: None,
                    max_input_attachment_total_bytes: None,
                }],
            }),
        )
        .await
        .into_response();
        assert_eq!(zero_capacity.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            std::fs::read_to_string(state.managed_config_path.as_deref().unwrap()).unwrap(),
            managed_before_rejection
        );
        let options_after_rejection = runtime.inference_model_options().await.unwrap();
        assert!(
            options_after_rejection
                .iter()
                .any(|option| option.id == "subscription-model"
                    && option.label == "fast-subscription")
        );

        let status_response = handle_status(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(status_response.status(), StatusCode::OK);
        let status_body = axum::body::to_bytes(status_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let status_json: serde_json::Value = serde_json::from_slice(&status_body).unwrap();
        assert_eq!(status_json["identity_mode"], "default");
        assert_eq!(status_json["identity_provider_id"], "morphz-site");
        let status: crate::runtime::RuntimeStatus = serde_json::from_value(status_json).unwrap();
        assert!(status.models.contains(&"subscription-model".to_string()));
        assert!(status
            .model_options
            .iter()
            .any(|option| option.label == "fast-subscription"));
        assert!(!status
            .model_options
            .iter()
            .any(|option| option.label == "subscription-model"));

        let switched = handle_update_inference(
            State(state),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(UpdateInferenceRequest {
                model: Some("subscription-model".to_string()),
                reasoning_effort: None,
                prompt_token_limit: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(switched.status(), StatusCode::OK);
        assert_eq!(runtime.model(), "subscription-model");
        assert_eq!(runtime.model_context_capacity().prompt_token_limit, 196_000);
        assert_eq!(
            runtime.model_context_capacity().source,
            "provider-route-model-config"
        );

        let managed: AppConfig =
            toml::from_str(&std::fs::read_to_string(managed_config_path).unwrap()).unwrap();
        assert_eq!(
            managed.provider_instances["subscription-provider"].models
                ["physical-subscription-model"]
                .context_window_tokens,
            Some(200_000)
        );
        assert_eq!(managed.llm.model, "subscription-model");
        assert_eq!(
            managed.model_routes["subscription-model"]
                .display_alias
                .as_deref(),
            Some("fast-subscription")
        );
    }

    #[tokio::test]
    async fn public_runtime_oauth_callback_accepts_only_live_opaque_state() {
        let unknown = handle_provider_oauth_callback(Query(OAuthCallbackQuery {
            state: "unknown-state".to_string(),
            code: Some("unknown-code".to_string()),
            ..OAuthCallbackQuery::default()
        }))
        .await;
        assert_eq!(unknown.status(), StatusCode::BAD_REQUEST);

        let state = "runtime-callback-state";
        crate::provider::auth::register_oauth_callback(
            state,
            Utc::now() + ChronoDuration::minutes(5),
        )
        .unwrap();
        let accepted = handle_provider_oauth_callback(Query(OAuthCallbackQuery {
            state: state.to_string(),
            code: Some("authorization-code".to_string()),
            ..OAuthCallbackQuery::default()
        }))
        .await;
        assert_eq!(accepted.status(), StatusCode::OK);
        assert_eq!(
            accepted
                .headers()
                .get(header::CACHE_CONTROL)
                .and_then(|value| value.to_str().ok()),
            Some("no-store")
        );

        let replay = handle_provider_oauth_callback(Query(OAuthCallbackQuery {
            state: state.to_string(),
            code: Some("replacement-code".to_string()),
            ..OAuthCallbackQuery::default()
        }))
        .await;
        assert_eq!(replay.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn dashboard_oauth_bootstrap_catalog_and_start_cover_all_supported_services() {
        let tmp = tempfile::tempdir().unwrap();
        let database_path = tmp.path().join("morphz.db");
        let env_path = tmp.path().join(".env");
        let secret_store = Arc::new(
            SecretStore::with_backends(
                tmp.path().join("managed-secrets.json"),
                "morphz_env_file",
                vec![Arc::new(
                    crate::secret_store::HostEnvFileSecretBackend::new(&env_path),
                )],
            )
            .unwrap(),
        );
        let expected = [
            ("codex", "codex-oauth", OAuthFlowKind::AuthorizationCodePkce),
            ("kimi", "kimi-oauth", OAuthFlowKind::DeviceCode),
            (
                "anthropic",
                "claude-oauth",
                OAuthFlowKind::AuthorizationCodePkce,
            ),
            (
                "antigravity",
                "antigravity-oauth",
                OAuthFlowKind::AuthorizationCodePkce,
            ),
            ("xai", "xai-oauth", OAuthFlowKind::DeviceCode),
        ];
        let mut registry = AuthAdapterRegistry::default();
        for (_, adapter_id, flow) in expected {
            registry.register(Arc::new(WebTestOAuthAdapter {
                id: adapter_id,
                flow,
            }));
        }
        registry.register(Arc::new(WebTestOAuthAdapter {
            id: "codex-device-oauth",
            flow: OAuthFlowKind::DeviceCode,
        }));
        let config = AppConfig::default();
        let client = Arc::new(crate::provider::routing::RoutedClient::empty(
            config.llm.clone(),
        ));
        let (state, runtime) = test_state_at_with_config_client_auth_and_secrets(
            &database_path,
            false,
            config,
            client,
            Some(registry),
            Some(secret_store),
        )
        .await;

        let catalog = handle_oauth_provider_setup_services(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(catalog.status(), StatusCode::OK);
        let body = axum::body::to_bytes(catalog.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: Value = serde_json::from_slice(&body).unwrap();
        let services = payload["services"].as_array().unwrap();
        assert_eq!(services.len(), expected.len());
        assert!(!services
            .iter()
            .any(|service| service["id"] == "codex-device"));
        let mut authenticated_accounts = Vec::new();
        for (service_id, adapter_id, flow) in expected {
            assert!(services.iter().any(|service| {
                service["id"] == service_id && service["auth_adapter"] == adapter_id
            }));

            let started = handle_start_oauth_provider_setup(
                State(Arc::clone(&state)),
                HeaderMap::new(),
                Query(AuthQuery::default()),
                Json(StartOAuthProviderSetupRequest {
                    service: service_id.to_string(),
                }),
            )
            .await
            .into_response();
            let status = started.status();
            let body = axum::body::to_bytes(started.into_body(), usize::MAX)
                .await
                .unwrap();
            assert_eq!(
                status,
                StatusCode::CREATED,
                "{service_id} OAuth bootstrap failed: {}",
                String::from_utf8_lossy(&body)
            );
            let challenge: crate::provider::auth::OAuthLoginChallenge =
                serde_json::from_slice(&body).unwrap();
            assert_eq!(challenge.adapter_id, adapter_id);
            assert_eq!(challenge.flow, flow);
            let before_completion = runtime.provider_control_snapshot().await.unwrap();
            assert!(
                !before_completion
                    .auth_accounts
                    .contains_key(&challenge.account_id),
                "{service_id} created an account before authentication completed"
            );
            if let Some(path) = state.managed_config_path.as_deref() {
                let managed = std::fs::read_to_string(path).unwrap_or_default();
                assert!(
                    !managed.contains(&challenge.account_id),
                    "{service_id} wrote an unfinished account to managed config"
                );
            }
            match flow {
                OAuthFlowKind::DeviceCode => {
                    assert_eq!(challenge.user_code.as_deref(), Some("MORPHZ-TEST"));
                }
                OAuthFlowKind::AuthorizationCodePkce => {
                    assert!(challenge.authorization_url.is_some());
                    assert!(challenge.user_code.is_none());
                    assert_eq!(challenge.callback_state.as_deref(), Some("morphz-test"));
                }
            }

            if service_id == "codex" {
                let device_started = handle_start_oauth_provider_setup(
                    State(Arc::clone(&state)),
                    HeaderMap::new(),
                    Query(AuthQuery::default()),
                    Json(StartOAuthProviderSetupRequest {
                        service: "codex-device".to_string(),
                    }),
                )
                .await
                .into_response();
                assert_eq!(device_started.status(), StatusCode::CREATED);
                let device_body = axum::body::to_bytes(device_started.into_body(), usize::MAX)
                    .await
                    .unwrap();
                let device_challenge: crate::provider::auth::OAuthLoginChallenge =
                    serde_json::from_slice(&device_body).unwrap();
                assert_ne!(device_challenge.account_id, challenge.account_id);
                assert_eq!(device_challenge.adapter_id, "codex-device-oauth");
                assert_eq!(device_challenge.user_code.as_deref(), Some("MORPHZ-TEST"));

                let device_cancelled = handle_cancel_provider_oauth_login(
                    State(Arc::clone(&state)),
                    Path(device_challenge.login_id),
                    HeaderMap::new(),
                    Query(AuthQuery::default()),
                )
                .await
                .into_response();
                assert_eq!(device_cancelled.status(), StatusCode::NO_CONTENT);
                assert!(!runtime
                    .provider_control_snapshot()
                    .await
                    .unwrap()
                    .auth_accounts
                    .contains_key(&device_challenge.account_id));
            }

            let manual_callback = service_id == "codex";
            let completed = if manual_callback {
                handle_submit_provider_oauth_callback(
                    State(Arc::clone(&state)),
                    HeaderMap::new(),
                    Query(AuthQuery::default()),
                    Json(SubmitOAuthCallbackRequest {
                        redirect_url: "http://localhost/callback?code=web-code&state=morphz-test"
                            .to_string(),
                    }),
                )
                .await
            } else {
                handle_continue_provider_oauth_login(
                    State(Arc::clone(&state)),
                    Path(challenge.login_id.clone()),
                    HeaderMap::new(),
                    Query(AuthQuery::default()),
                    Json(OAuthLoginCompletion::Poll),
                )
                .await
                .into_response()
            };
            let completed_status = completed.status();
            let completed_body = axum::body::to_bytes(completed.into_body(), usize::MAX)
                .await
                .unwrap();
            assert_eq!(
                completed_status,
                StatusCode::OK,
                "{service_id} OAuth completion failed: {}",
                String::from_utf8_lossy(&completed_body)
            );
            let progress: OAuthLoginProgress = if manual_callback {
                let submission: SubmitOAuthCallbackResponse =
                    serde_json::from_slice(&completed_body).unwrap();
                assert_eq!(submission.login_id, challenge.login_id);
                submission.progress
            } else {
                serde_json::from_slice(&completed_body).unwrap()
            };
            let OAuthLoginProgress::Complete { account } = progress else {
                panic!("{service_id} OAuth login did not complete")
            };
            assert_eq!(account.account_id, challenge.account_id);
            authenticated_accounts.push(challenge.account_id);
        }

        let snapshot = runtime.provider_control_snapshot().await.unwrap();
        assert_eq!(
            snapshot.provider_instances["antigravity-subscription"].base_url,
            crate::provider::ANTIGRAVITY_DAILY_BASE_URL
        );
        for account_id in authenticated_accounts {
            let account = snapshot.auth_accounts.get(&account_id).unwrap();
            assert!(account.authenticated, "{account_id} was not authenticated");
        }
    }

    #[tokio::test]
    async fn dashboard_oauth_bootstrap_preserves_multiple_accounts_per_service() {
        let tmp = tempfile::tempdir().unwrap();
        let database_path = tmp.path().join("morphz.db");
        let env_path = tmp.path().join(".env");
        let secret_store = Arc::new(
            SecretStore::with_backends(
                tmp.path().join("managed-secrets.json"),
                "morphz_env_file",
                vec![Arc::new(
                    crate::secret_store::HostEnvFileSecretBackend::new(&env_path),
                )],
            )
            .unwrap(),
        );
        let mut registry = AuthAdapterRegistry::default();
        registry.register(Arc::new(WebTestOAuthAdapter {
            id: "codex-oauth",
            flow: OAuthFlowKind::DeviceCode,
        }));
        let (state, runtime) = test_state_at_with_workers_auth_and_secrets(
            &database_path,
            false,
            Some(registry),
            Some(secret_store),
        )
        .await;

        let mut account_ids = Vec::new();
        for _ in 0..2 {
            let started = handle_start_oauth_provider_setup(
                State(Arc::clone(&state)),
                HeaderMap::new(),
                Query(AuthQuery::default()),
                Json(StartOAuthProviderSetupRequest {
                    service: "codex".to_string(),
                }),
            )
            .await
            .into_response();
            assert_eq!(started.status(), StatusCode::CREATED);
            let body = axum::body::to_bytes(started.into_body(), usize::MAX)
                .await
                .unwrap();
            let challenge: crate::provider::auth::OAuthLoginChallenge =
                serde_json::from_slice(&body).unwrap();
            account_ids.push(challenge.account_id.clone());

            let completed = handle_continue_provider_oauth_login(
                State(Arc::clone(&state)),
                Path(challenge.login_id),
                HeaderMap::new(),
                Query(AuthQuery::default()),
                Json(OAuthLoginCompletion::Poll),
            )
            .await
            .into_response();
            assert_eq!(completed.status(), StatusCode::OK);
        }

        assert_ne!(account_ids[0], account_ids[1]);
        let snapshot = runtime.provider_control_snapshot().await.unwrap();
        let provider = &snapshot.provider_instances["codex-subscription"];
        assert_eq!(provider.accounts.len(), 2);
        assert!(account_ids.iter().all(|id| provider.accounts.contains(id)));
        assert!(provider.models.is_empty());
        assert!(snapshot
            .model_routes
            .values()
            .all(|route| account_ids.iter().all(|account_id| route
                .candidates
                .iter()
                .all(|candidate| candidate.account.as_deref() != Some(account_id.as_str())))));
        let managed: AppConfig = toml::from_str(
            &std::fs::read_to_string(state.managed_config_path.as_deref().unwrap()).unwrap(),
        )
        .unwrap();
        assert!(account_ids
            .iter()
            .all(|account_id| managed.auth_accounts.contains_key(account_id)));
        assert!(account_ids
            .iter()
            .all(
                |account_id| managed.provider_instances["codex-subscription"]
                    .accounts
                    .contains(account_id)
            ));
        assert!(managed
            .model_routes
            .values()
            .all(|route| account_ids.iter().all(|account_id| route
                .candidates
                .iter()
                .all(|candidate| candidate.account.as_deref() != Some(account_id.as_str())))));
    }

    #[tokio::test]
    async fn provider_snapshot_migrates_legacy_unfinished_oauth_accounts_away() {
        let tmp = tempfile::tempdir().unwrap();
        let database_path = tmp.path().join("morphz.db");
        let mut registry = AuthAdapterRegistry::default();
        registry.register(Arc::new(WebTestOAuthAdapter {
            id: "codex-oauth",
            flow: OAuthFlowKind::DeviceCode,
        }));
        let (state, runtime) =
            test_state_at_with_workers_and_auth(&database_path, false, Some(registry)).await;
        let managed_path = state.managed_config_path.clone().unwrap();
        let setup = oauth_provider_setup("codex").unwrap();
        let legacy_model = "invented-default-model";
        let legacy_route_id = "invented-default-route";
        let mut provider = ProviderInstanceConfig {
            adapter: setup.provider_adapter.clone(),
            protocol: setup.protocol,
            base_url: setup.base_url.clone(),
            accounts: vec![setup.account_id.clone()],
            ..ProviderInstanceConfig::default()
        };
        provider.models.insert(
            legacy_model.to_string(),
            crate::config::ProviderModelConfig::default(),
        );
        let account = AuthAccountConfig {
            auth_adapter: setup.auth_adapter.clone(),
            credential_ref: setup.credential_ref.clone(),
            provider: Some(setup.provider_id.clone()),
            enabled: true,
            ..AuthAccountConfig::default()
        };
        let route = ModelRouteConfig {
            candidates: vec![crate::config::ModelRouteCandidateConfig {
                provider: setup.provider_id.clone(),
                model: legacy_model.to_string(),
                account: Some(setup.account_id.clone()),
                ..crate::config::ModelRouteCandidateConfig::default()
            }],
            ..ModelRouteConfig::default()
        };
        state
            .sdk
            .put_provider_catalog_config(
                &managed_path,
                &setup.provider_id,
                provider,
                &setup.account_id,
                account,
                None,
                legacy_route_id,
                route,
            )
            .await
            .unwrap();
        let legacy = runtime.provider_control_snapshot().await.unwrap();
        let legacy_account = legacy.auth_accounts.get(&setup.account_id).unwrap();
        assert!(!legacy_account.authenticated);
        assert!(legacy_account.state.is_none());

        let projection = SqliteStore::new(database_path.to_str().unwrap())
            .await
            .unwrap();
        projection
            .replace_provider_model_catalog(
                &setup.provider_id,
                &setup.account_id,
                &setup.provider_adapter,
                "test",
                setup.protocol.as_str(),
                "remote_provider",
                &[legacy_model.to_string()],
                Utc::now(),
            )
            .await
            .unwrap();
        drop(projection);
        assert!(runtime
            .inference_model_options()
            .await
            .unwrap()
            .iter()
            .all(|option| option.id != legacy_route_id));

        let response = handle_provider_control_snapshot(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let migrated = runtime.provider_control_snapshot().await.unwrap();
        assert!(!migrated.auth_accounts.contains_key(&setup.account_id));
        assert!(!migrated.provider_instances.contains_key(&setup.provider_id));
        assert!(!migrated.model_routes.contains_key(legacy_route_id));
        assert!(!std::fs::read_to_string(managed_path)
            .unwrap()
            .contains(&setup.account_id));
    }

    #[tokio::test]
    async fn dashboard_oauth_setup_can_start_login_without_runtime_restart() {
        // SecretStore intentionally tightens its own directory permissions.
        // Give it a test-owned directory instead of placing the catalog next
        // to a NamedTempFile in macOS' shared temporary directory.
        let tmp = tempfile::tempdir().unwrap();
        let database_path = tmp.path().join("morphz.db");
        let mut registry = AuthAdapterRegistry::default();
        registry.register(Arc::new(WebTestOAuthAdapter {
            id: "web-test-oauth",
            flow: OAuthFlowKind::DeviceCode,
        }));
        let (state, runtime) =
            test_state_at_with_workers_and_auth(&database_path, false, Some(registry)).await;

        let setup = handle_put_provider_catalog_setup(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(PutProviderCatalogSetupRequest {
                provider_id: "oauth-provider".to_string(),
                provider: ProviderInstanceConfig {
                    adapter: "oauth-test".to_string(),
                    protocol: crate::config::ModelProtocol::OpenaiResponses,
                    base_url: "https://api.example.test/v1".to_string(),
                    accounts: vec!["oauth-account".to_string()],
                    ..ProviderInstanceConfig::default()
                },
                account_id: "oauth-account".to_string(),
                account: AuthAccountConfig {
                    auth_adapter: "web-test-oauth".to_string(),
                    credential_ref: "MORPHZ_OAUTH_TEST_TOKEN".to_string(),
                    provider: Some("oauth-provider".to_string()),
                    label: Some("OAuth test".to_string()),
                    ..AuthAccountConfig::default()
                },
                credential_id: None,
                credential: None,
                managed_secret: None,
                route_id: "oauth-model".to_string(),
                route: ModelRouteConfig {
                    aliases: vec!["oauth/model".to_string()],
                    candidates: vec![crate::config::ModelRouteCandidateConfig {
                        provider: "oauth-provider".to_string(),
                        account: Some("oauth-account".to_string()),
                        model: "physical-model".to_string(),
                        ..crate::config::ModelRouteCandidateConfig::default()
                    }],
                    ..ModelRouteConfig::default()
                },
            }),
        )
        .await
        .into_response();
        assert_eq!(setup.status(), StatusCode::OK);

        let start = handle_start_provider_oauth_login(
            State(Arc::clone(&state)),
            Path("oauth-account".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        let start_status = start.status();
        let body = axum::body::to_bytes(start.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            start_status,
            StatusCode::CREATED,
            "OAuth start failed: {}",
            String::from_utf8_lossy(&body)
        );
        let challenge: crate::provider::auth::OAuthLoginChallenge =
            serde_json::from_slice(&body).unwrap();
        assert_eq!(challenge.account_id, "oauth-account");
        assert_eq!(challenge.adapter_id, "web-test-oauth");
        assert_eq!(challenge.flow, OAuthFlowKind::DeviceCode);
        assert_eq!(challenge.user_code.as_deref(), Some("MORPHZ-TEST"));
        assert_eq!(
            challenge.verification_uri_complete.as_deref(),
            Some("https://auth.example.test/device?code=MORPHZ-TEST")
        );

        let login_id = challenge.login_id.clone();
        let completed = handle_continue_provider_oauth_login(
            State(Arc::clone(&state)),
            Path(login_id),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(OAuthLoginCompletion::Poll),
        )
        .await
        .into_response();
        let completed_status = completed.status();
        let completed_body = axum::body::to_bytes(completed.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            completed_status,
            StatusCode::OK,
            "OAuth completion failed: {}",
            String::from_utf8_lossy(&completed_body)
        );
        let progress: OAuthLoginProgress = serde_json::from_slice(&completed_body).unwrap();
        let OAuthLoginProgress::Complete { account } = progress else {
            panic!("OAuth login did not reach a terminal authenticated state")
        };
        assert_eq!(account.account_id, "oauth-account");
        assert_eq!(account.email.as_deref(), Some("oauth@example.test"));

        let snapshot = runtime.provider_control_snapshot().await.unwrap();
        let account = &snapshot.auth_accounts["oauth-account"];
        assert!(account.authenticated);
        assert_eq!(
            account
                .oauth_metadata
                .as_ref()
                .and_then(|metadata| metadata.email.as_deref()),
            Some("oauth@example.test")
        );
        assert!(snapshot.provider_instances.contains_key("oauth-provider"));
        assert!(snapshot.model_routes.contains_key("oauth-model"));

        let logout = handle_logout_provider_oauth_account(
            State(Arc::clone(&state)),
            Path("oauth-account".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(logout.status(), StatusCode::OK);
        let logged_out = runtime.provider_control_snapshot().await.unwrap();
        let account = &logged_out.auth_accounts["oauth-account"];
        assert!(!account.authenticated);
        let state = account.state.as_ref().unwrap();
        assert_eq!(state.status, crate::memory::ProviderAccountStatus::Revoked);
        assert_eq!(state.last_error_kind, None);
    }

    #[tokio::test]
    async fn dashboard_oauth_setup_uses_headless_env_secret_backend() {
        let tmp = tempfile::tempdir().unwrap();
        let database_path = tmp.path().join("morphz.db");
        let env_path = tmp.path().join(".env");
        let secret_store = Arc::new(
            SecretStore::with_backends(
                tmp.path().join("managed-secrets.json"),
                "morphz_env_file",
                vec![Arc::new(
                    crate::secret_store::HostEnvFileSecretBackend::new(&env_path),
                )],
            )
            .unwrap(),
        );
        let mut registry = AuthAdapterRegistry::default();
        registry.register(Arc::new(WebTestOAuthAdapter {
            id: "web-test-oauth",
            flow: OAuthFlowKind::DeviceCode,
        }));
        let (state, _runtime) = test_state_at_with_workers_auth_and_secrets(
            &database_path,
            false,
            Some(registry),
            Some(secret_store),
        )
        .await;

        let setup = handle_put_provider_catalog_setup(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(PutProviderCatalogSetupRequest {
                provider_id: "oauth-provider".to_string(),
                provider: ProviderInstanceConfig {
                    adapter: "oauth-test".to_string(),
                    protocol: crate::config::ModelProtocol::OpenaiResponses,
                    base_url: "https://api.example.test/v1".to_string(),
                    accounts: vec!["oauth-account".to_string()],
                    ..ProviderInstanceConfig::default()
                },
                account_id: "oauth-account".to_string(),
                account: AuthAccountConfig {
                    auth_adapter: "web-test-oauth".to_string(),
                    credential_ref: "MORPHZ_OAUTH_TEST_TOKEN".to_string(),
                    secret_backend: Some("morphz_env_file".to_string()),
                    provider: Some("oauth-provider".to_string()),
                    label: Some("OAuth test".to_string()),
                    ..AuthAccountConfig::default()
                },
                credential_id: None,
                credential: None,
                managed_secret: None,
                route_id: "oauth-model".to_string(),
                route: ModelRouteConfig {
                    aliases: vec!["oauth/model".to_string()],
                    candidates: vec![crate::config::ModelRouteCandidateConfig {
                        provider: "oauth-provider".to_string(),
                        account: Some("oauth-account".to_string()),
                        model: "physical-model".to_string(),
                        ..crate::config::ModelRouteCandidateConfig::default()
                    }],
                    ..ModelRouteConfig::default()
                },
            }),
        )
        .await
        .into_response();
        assert_eq!(setup.status(), StatusCode::OK);

        let start = handle_start_provider_oauth_login(
            State(Arc::clone(&state)),
            Path("oauth-account".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        let start_status = start.status();
        let body = axum::body::to_bytes(start.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            start_status,
            StatusCode::CREATED,
            "OAuth start failed: {}",
            String::from_utf8_lossy(&body)
        );
        let challenge: crate::provider::auth::OAuthLoginChallenge =
            serde_json::from_slice(&body).unwrap();
        assert_eq!(challenge.user_code.as_deref(), Some("MORPHZ-TEST"));

        // An unfinished login is process-local transaction state. It must not
        // create a Secret Backend record or even an empty env file.
        assert!(!env_path.exists());

        let completed = handle_continue_provider_oauth_login(
            State(state),
            Path(challenge.login_id),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(OAuthLoginCompletion::Poll),
        )
        .await
        .into_response();
        assert_eq!(completed.status(), StatusCode::OK);

        let env = std::fs::read_to_string(env_path).unwrap();
        assert!(!env.contains("MORPHZ_OAUTH_LOGIN_"));
        assert!(env.contains("MORPHZ_OAUTH_TEST_TOKEN="));
    }

    #[tokio::test]
    async fn dashboard_model_capacity_is_persistent_and_immediately_updates_context_budget() {
        let (state, runtime) = test_state().await;
        let managed_config_path = state.managed_config_path.clone().unwrap();
        let response = handle_update_inference(
            State(state),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(UpdateInferenceRequest {
                model: None,
                reasoning_effort: None,
                prompt_token_limit: Some(1_000_000),
            }),
        )
        .await
        .into_response();

        if response.status() != StatusCode::OK {
            let status = response.status();
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            panic!(
                "unexpected capacity response {status}: {}",
                String::from_utf8_lossy(&body)
            );
        }
        assert_eq!(
            runtime.model_context_capacity().prompt_token_limit,
            1_000_000
        );
        let budget = runtime.context_token_budget("context-test").await.unwrap();
        assert_eq!(budget.physical_prompt_token_limit, 1_000_000);
        let managed = std::fs::read_to_string(managed_config_path).unwrap();
        assert!(managed.contains("max_input_tokens = 1000000"));
    }

    #[tokio::test]
    async fn dashboard_model_capacity_follows_modern_route_without_legacy_provider() {
        let tmp = NamedTempFile::new().unwrap();
        let database_path = tmp.path().to_path_buf();
        drop(tmp);
        let managed_config_path = database_path.with_extension("managed").join("managed.toml");
        std::fs::create_dir_all(managed_config_path.parent().unwrap()).unwrap();
        let managed = r#"
[llm]
model = "grok-route"

[services.xai-subscription]
adapter = "xai-grok"
protocol = "openai-responses"
base_url = "https://api.x.ai/v1"
accounts = ["xai-account"]

[services.xai-subscription.models."grok-4.5"]
max_input_tokens = 262144

[accounts.xai-account]
auth_adapter = "none"
provider = "xai-subscription"

[models.grok-route]
service = "xai-subscription"
physical_model = "grok-4.5"
account = "xai-account"
"#;
        std::fs::write(&managed_config_path, managed).unwrap();
        let config: AppConfig = toml::from_str(managed).unwrap();
        assert_eq!(config.llm.provider, None);
        let (state, runtime) =
            test_state_at_with_config_auth_and_secrets(&database_path, true, config, None, None)
                .await;

        let response = handle_update_inference(
            State(state),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(UpdateInferenceRequest {
                model: None,
                reasoning_effort: None,
                prompt_token_limit: Some(1_000_000),
            }),
        )
        .await
        .into_response();

        if response.status() != StatusCode::OK {
            let status = response.status();
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            panic!(
                "unexpected routed capacity response {status}: {}",
                String::from_utf8_lossy(&body)
            );
        }
        assert_eq!(
            runtime.model_context_capacity().prompt_token_limit,
            1_000_000
        );
        let budget = runtime.context_token_budget("context-test").await.unwrap();
        assert_eq!(budget.physical_prompt_token_limit, 1_000_000);

        let persisted: AppConfig =
            toml::from_str(&std::fs::read_to_string(managed_config_path).unwrap()).unwrap();
        assert_eq!(persisted.llm.provider, None);
        assert_eq!(persisted.llm.model, "grok-route");
        assert_eq!(
            persisted.provider_instances["xai-subscription"].models["grok-4.5"].max_input_tokens,
            Some(1_000_000)
        );
    }

    #[tokio::test]
    async fn local_provider_setup_discovery_enablement_switch_probe_capacity_and_restart() {
        let provider_app = axum::Router::new()
            .route(
                "/models",
                get(|headers: HeaderMap| async move {
                    let authorized = headers
                        .get(header::AUTHORIZATION)
                        .and_then(|value| value.to_str().ok())
                        .is_some_and(|value| {
                            matches!(
                                value,
                                "Bearer ephemeral-test-key" | "Bearer durable-test-key"
                            )
                        });
                    if !authorized {
                        return StatusCode::UNAUTHORIZED.into_response();
                    }
                    Json(json!({
                        "data": [
                            {
                                "id": "model-a",
                                "context_window_tokens": 200_000,
                                "max_input_tokens": 190_000,
                                "max_output_tokens": 10_000
                            },
                            { "id": "model-b" }
                        ]
                    }))
                    .into_response()
                }),
            )
            .route(
                "/responses",
                post(|headers: HeaderMap, Json(request): Json<Value>| async move {
                    if headers
                        .get(header::AUTHORIZATION)
                        .and_then(|value| value.to_str().ok())
                        != Some("Bearer durable-test-key")
                    {
                        return StatusCode::UNAUTHORIZED.into_response();
                    }
                    if request.get("stream").and_then(Value::as_bool) == Some(true) {
                        return (
                            [(header::CONTENT_TYPE, "text/event-stream")],
                            concat!(
                                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"E2E_OK\"}\n\n",
                                "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"output_tokens\":1}}}\n\n"
                            ),
                        )
                            .into_response();
                    }
                    Json(json!({
                        "status": "completed",
                        "output": [{
                            "type": "message",
                            "content": [{ "type": "output_text", "text": "E2E_OK" }]
                        }]
                    }))
                    .into_response()
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, provider_app).await.unwrap();
        });
        let base_url = format!("http://{address}");

        let temp = tempfile::tempdir().unwrap();
        let database_path = temp.path().join("morphz.db");
        let secret_store = Arc::new(
            SecretStore::new(
                temp.path().join("managed-secrets.json"),
                Arc::new(WebTestSecretBackend::default()),
            )
            .unwrap(),
        );
        let initial_config = AppConfig::default();
        let routed_client = Arc::new(crate::provider::routing::RoutedClient::empty(
            initial_config.llm.clone(),
        ));
        let (state, runtime) = test_state_at_with_config_client_auth_and_secrets(
            &database_path,
            true,
            initial_config,
            routed_client.clone(),
            None,
            Some(Arc::clone(&secret_store)),
        )
        .await;

        let discovered = handle_discover_provider_models(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(DiscoverProviderModelsRequest {
                protocol: crate::config::ModelProtocol::OpenaiResponses,
                base_url: base_url.clone(),
                api_key: "ephemeral-test-key".to_string(),
            }),
        )
        .await
        .into_response();
        assert_eq!(discovered.status(), StatusCode::OK);
        let discovered_body = axum::body::to_bytes(discovered.into_body(), usize::MAX)
            .await
            .unwrap();
        let discovered: Value = serde_json::from_slice(&discovered_body).unwrap();
        assert_eq!(discovered["models"], json!(["model-a", "model-b"]));

        let setup = handle_put_provider_catalog_setup(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(PutProviderCatalogSetupRequest {
                provider_id: "local-provider".to_string(),
                provider: ProviderInstanceConfig {
                    adapter: "openai-compatible".to_string(),
                    protocol: crate::config::ModelProtocol::OpenaiResponses,
                    base_url: base_url.clone(),
                    accounts: vec!["local-account".to_string()],
                    models: BTreeMap::from([(
                        "model-a".to_string(),
                        crate::config::ProviderModelConfig::default(),
                    )]),
                    ..ProviderInstanceConfig::default()
                },
                account_id: "local-account".to_string(),
                account: AuthAccountConfig {
                    auth_adapter: "credential".to_string(),
                    credential_ref: "local-provider-api-key".to_string(),
                    provider: Some("local-provider".to_string()),
                    label: Some("Local test".to_string()),
                    ..AuthAccountConfig::default()
                },
                credential_id: Some("local-provider-api-key".to_string()),
                credential: Some(crate::config::CredentialConfig {
                    source: crate::config::CredentialSource::Env,
                    name: Some("MORPHZ_WEB_TEST_LOCAL_PROVIDER_API_KEY".to_string()),
                    ..crate::config::CredentialConfig::default()
                }),
                managed_secret: Some(PutManagedSecretRequest {
                    name: "MORPHZ_WEB_TEST_LOCAL_PROVIDER_API_KEY".to_string(),
                    value: "durable-test-key".to_string(),
                    scope_kind: crate::secret_store::SecretScopeKind::Runtime,
                    scope_id: None,
                    value_backend: None,
                }),
                route_id: "route-a".to_string(),
                route: ModelRouteConfig {
                    candidates: vec![crate::config::ModelRouteCandidateConfig {
                        provider: "local-provider".to_string(),
                        model: "model-a".to_string(),
                        account: Some("local-account".to_string()),
                        ..crate::config::ModelRouteCandidateConfig::default()
                    }],
                    ..ModelRouteConfig::default()
                },
            }),
        )
        .await
        .into_response();
        assert_eq!(setup.status(), StatusCode::OK);
        assert_eq!(runtime.model(), "route-a");
        assert_eq!(
            runtime.provider_catalog_config().unwrap().llm.model,
            "route-a"
        );

        let second_setup = handle_put_provider_catalog_setup(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(PutProviderCatalogSetupRequest {
                provider_id: "second-provider".to_string(),
                provider: ProviderInstanceConfig {
                    adapter: "openai-compatible".to_string(),
                    protocol: crate::config::ModelProtocol::OpenaiResponses,
                    base_url: base_url.clone(),
                    accounts: vec!["second-account".to_string()],
                    models: BTreeMap::from([(
                        "model-a".to_string(),
                        crate::config::ProviderModelConfig::default(),
                    )]),
                    ..ProviderInstanceConfig::default()
                },
                account_id: "second-account".to_string(),
                account: AuthAccountConfig {
                    auth_adapter: "none".to_string(),
                    provider: Some("second-provider".to_string()),
                    ..AuthAccountConfig::default()
                },
                credential_id: None,
                credential: None,
                managed_secret: None,
                route_id: "route-z".to_string(),
                route: ModelRouteConfig {
                    candidates: vec![crate::config::ModelRouteCandidateConfig {
                        provider: "second-provider".to_string(),
                        model: "model-a".to_string(),
                        account: Some("second-account".to_string()),
                        ..crate::config::ModelRouteCandidateConfig::default()
                    }],
                    ..ModelRouteConfig::default()
                },
            }),
        )
        .await
        .into_response();
        assert_eq!(second_setup.status(), StatusCode::OK);
        assert_eq!(runtime.model(), "route-a");
        assert_eq!(
            runtime.provider_catalog_config().unwrap().llm.model,
            "route-a"
        );
        let after_second_setup: AppConfig = toml::from_str(
            &std::fs::read_to_string(state.managed_config_path.as_deref().unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(after_second_setup.llm.model, "route-a");

        let refreshed = handle_refresh_provider_account_catalog(
            State(Arc::clone(&state)),
            Path("local-account".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(ProviderAccountDiagnosticRequest { model: None }),
        )
        .await
        .into_response();
        assert_eq!(refreshed.status(), StatusCode::OK);
        let refreshed_body = axum::body::to_bytes(refreshed.into_body(), usize::MAX)
            .await
            .unwrap();
        let refreshed: Value = serde_json::from_slice(&refreshed_body).unwrap();
        assert_eq!(
            refreshed["discovered_models"],
            json!(["model-a", "model-b"])
        );
        assert_eq!(
            refreshed["discovered_model_profiles"]["model-a"]["max_input_tokens"],
            190_000
        );
        assert_eq!(refreshed["health_verified"], true);

        let enabled = handle_put_provider_account_models(
            State(Arc::clone(&state)),
            Path("local-account".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(PutProviderAccountModelsRequest {
                models: vec![
                    ProviderAccountModelSelection {
                        prompt_cache_strategy: None,
                        id: "model-a".to_string(),
                        alias: Some("primary-local".to_string()),
                        context_window_tokens: Some(200_000),
                        max_input_tokens: Some(190_000),
                        max_output_tokens: Some(10_000),
                        max_input_attachments: Some(64),
                        max_input_attachment_bytes: Some(64 * 1024 * 1024),
                        max_input_attachment_total_bytes: Some(192 * 1024 * 1024),
                    },
                    ProviderAccountModelSelection {
                        prompt_cache_strategy: None,
                        id: "model-b".to_string(),
                        alias: None,
                        context_window_tokens: None,
                        max_input_tokens: None,
                        max_output_tokens: None,
                        max_input_attachments: None,
                        max_input_attachment_bytes: None,
                        max_input_attachment_total_bytes: None,
                    },
                ],
            }),
        )
        .await
        .into_response();
        assert_eq!(enabled.status(), StatusCode::OK);
        let options = runtime.inference_model_options().await.unwrap();
        assert!(options
            .iter()
            .any(|option| option.id == "route-a" && option.label == "primary-local"));
        assert!(options
            .iter()
            .any(|option| option.id == "model-b" && option.label == "model-b"));

        let switched = handle_update_inference(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(UpdateInferenceRequest {
                model: Some("model-b".to_string()),
                reasoning_effort: None,
                prompt_token_limit: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(switched.status(), StatusCode::OK);
        assert_eq!(runtime.model(), "model-b");

        let completion = routed_completion_for_session(
            &runtime,
            routed_client.as_ref(),
            "session-local-provider",
            "health",
        )
        .await;
        assert_eq!(completion.content, "E2E_OK");
        // The unscoped Client API and process health probe are explicit
        // operator operations. Neither may invent a fake `operator` Context,
        // while ordinary Runtime Evaluations remain Agent-account fenced.
        routed_client.probe_health().await.unwrap();

        let capacity = handle_update_inference(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(UpdateInferenceRequest {
                model: None,
                reasoning_effort: None,
                prompt_token_limit: Some(300_000),
            }),
        )
        .await
        .into_response();
        assert_eq!(capacity.status(), StatusCode::OK);
        assert_eq!(runtime.model_context_capacity().prompt_token_limit, 300_000);

        let managed_config_path = state.managed_config_path.as_deref().unwrap();
        let persisted: AppConfig =
            toml::from_str(&std::fs::read_to_string(managed_config_path).unwrap()).unwrap();
        assert_eq!(persisted.llm.provider, None);
        assert_eq!(persisted.llm.model, "model-b");
        assert_eq!(
            persisted.provider_instances["local-provider"].models["model-a"].max_input_attachments,
            Some(64)
        );
        assert_eq!(
            persisted.provider_instances["local-provider"].models["model-a"]
                .max_input_attachment_total_bytes,
            Some(192 * 1024 * 1024)
        );
        assert_eq!(
            persisted.provider_instances["local-provider"].models["model-b"].max_input_tokens,
            Some(300_000)
        );

        let restarted_client = Arc::new(
            crate::provider::routing::RoutedClient::new(&persisted, persisted.llm.model.clone())
                .unwrap(),
        );
        let restart_database_path = temp.path().join("restarted.db");
        let (_restarted_state, restarted_runtime) =
            test_state_at_with_config_client_auth_and_secrets(
                &restart_database_path,
                true,
                persisted,
                restarted_client.clone(),
                None,
                Some(secret_store),
            )
            .await;
        let restarted_completion = routed_completion_for_session(
            &restarted_runtime,
            restarted_client.as_ref(),
            "session-local-provider-restarted",
            "after restart",
        )
        .await;
        assert_eq!(restarted_completion.content, "E2E_OK");
    }

    #[tokio::test]
    async fn dashboard_model_control_switches_only_to_the_configured_catalog() {
        let (state, runtime) = test_state().await;
        let response = handle_update_inference(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(UpdateInferenceRequest {
                model: Some("fixture-model".to_string()),
                reasoning_effort: None,
                prompt_token_limit: None,
            }),
        )
        .await
        .into_response();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(runtime.model(), "fixture-model");

        let rejected = handle_update_inference(
            State(state),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(UpdateInferenceRequest {
                model: Some("unlisted-model".to_string()),
                reasoning_effort: None,
                prompt_token_limit: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
        assert_eq!(runtime.model(), "fixture-model");
    }

    #[tokio::test]
    async fn dashboard_evaluation_model_policy_updates_runtime_and_managed_config_atomically() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        drop(tmp);
        let mut config = AppConfig::default();
        config.llm.provider = Some("fixture-provider".to_string());
        config.llm.model = "primary-model".to_string();
        config.llm.models = vec!["primary-model".to_string(), "worker-model".to_string()];
        let mut provider = crate::config::ProviderConfig {
            protocol: crate::config::ModelProtocol::OpenaiResponses,
            base_url: "http://localhost:8317/v1".to_string(),
            ..crate::config::ProviderConfig::default()
        };
        provider.models.insert(
            "primary-model".to_string(),
            crate::config::ProviderModelConfig::default(),
        );
        provider.models.insert(
            "worker-model".to_string(),
            crate::config::ProviderModelConfig::default(),
        );
        config
            .providers
            .insert("fixture-provider".to_string(), provider);
        let (state, runtime) =
            test_state_at_with_config_auth_and_secrets(&path, true, config, None, None).await;

        let response = handle_update_evaluation_model_policy(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(UpdateEvaluationModelPolicyRequest {
                primary_model: "worker-model".to_string(),
                allowed_evaluation_models: vec![
                    "primary-model".to_string(),
                    "worker-model".to_string(),
                    "primary-model".to_string(),
                ],
            }),
        )
        .await
        .into_response();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(runtime.model(), "worker-model");
        let snapshot = runtime.provider_control_snapshot().await.unwrap();
        assert_eq!(snapshot.selected_model_alias, "worker-model");
        assert_eq!(
            snapshot.allowed_evaluation_models,
            vec!["primary-model".to_string()]
        );
        let managed_path = state.managed_config_path.as_ref().unwrap();
        let persisted: toml::Value = toml::from_str(
            &std::fs::read_to_string(managed_path)
                .expect("evaluation model policy should be persisted"),
        )
        .unwrap();
        assert_eq!(persisted["llm"]["model"].as_str(), Some("worker-model"));
        assert_eq!(
            persisted["llm"]["allowed_evaluation_models"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(toml::Value::as_str)
                .collect::<Vec<_>>(),
            vec!["primary-model"]
        );
    }

    #[tokio::test]
    async fn dashboard_session_policy_controls_are_scoped_persistent_and_catalog_validated() {
        let (state, runtime) = test_state().await;
        let session_id = "session-model-scope";
        runtime
            .ensure_session(crate::memory::NewSession {
                id: session_id.to_string(),
                agent_id: "agent-test".to_string(),
                context_id: "context-test".to_string(),
                parent_session_id: None,
                title: "Session model scope".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        runtime
            .register_execution_target(ExecutionTargetRegistration {
                id: "edge-dashboard-session".to_string(),
                owner_principal_id: Some(runtime.identity().principal_id.clone()),
                provider_node_id: None,
                kind: crate::memory::ExecutionTargetKind::EdgeNode,
                name: "Dashboard laptop".to_string(),
                status: crate::memory::ExecutionTargetStatus::Online,
                platform: Some("linux-x86_64".to_string()),
                workspace_root: None,
                capabilities: vec!["exec".to_string()],
                metadata: json!({"test": "session_default_target"}),
                policy_digest: "dashboard-session-target-policy".to_string(),
                last_seen_at: Some(chrono::Utc::now()),
            })
            .await
            .unwrap();

        let selected = handle_update_session(
            State(Arc::clone(&state)),
            Path(session_id.to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(UpdateSessionRequest {
                title: None,
                status: None,
                model_alias: Some("fixture-model".to_string()),
                reasoning_effort: None,
                permission_mode: None,
                sandbox_mode: None,
                default_target_id: None,
                context_sharing: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(selected.status(), StatusCode::OK);
        assert_eq!(
            runtime
                .get_session(session_id)
                .await
                .unwrap()
                .unwrap()
                .model_alias
                .as_deref(),
            Some("fixture-model")
        );
        assert_eq!(runtime.model(), "fixture-model");

        let reasoning = handle_update_session(
            State(Arc::clone(&state)),
            Path(session_id.to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(UpdateSessionRequest {
                title: None,
                status: None,
                model_alias: None,
                reasoning_effort: Some("high".to_string()),
                permission_mode: None,
                sandbox_mode: None,
                default_target_id: None,
                context_sharing: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(reasoning.status(), StatusCode::OK);
        assert_eq!(
            runtime
                .get_session(session_id)
                .await
                .unwrap()
                .unwrap()
                .reasoning_effort
                .as_deref(),
            Some("high")
        );

        let permissions = handle_update_session(
            State(Arc::clone(&state)),
            Path(session_id.to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(UpdateSessionRequest {
                title: None,
                status: None,
                model_alias: None,
                reasoning_effort: None,
                permission_mode: Some(crate::permission::PermissionMode::FullAccess),
                sandbox_mode: None,
                default_target_id: None,
                context_sharing: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(permissions.status(), StatusCode::OK);
        assert_eq!(
            runtime
                .get_session(session_id)
                .await
                .unwrap()
                .unwrap()
                .permission_mode,
            Some(crate::permission::PermissionMode::FullAccess)
        );
        assert_eq!(
            runtime
                .get_session(session_id)
                .await
                .unwrap()
                .unwrap()
                .sandbox_mode,
            None
        );

        let target = handle_update_session(
            State(Arc::clone(&state)),
            Path(session_id.to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(UpdateSessionRequest {
                title: None,
                status: None,
                model_alias: None,
                reasoning_effort: None,
                permission_mode: None,
                sandbox_mode: None,
                default_target_id: Some("edge-dashboard-session".to_string()),
                context_sharing: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(target.status(), StatusCode::OK);
        assert_eq!(
            runtime
                .get_session(session_id)
                .await
                .unwrap()
                .unwrap()
                .default_target_id
                .as_deref(),
            Some("edge-dashboard-session")
        );
        let availability = handle_get_session_execution_targets(
            State(Arc::clone(&state)),
            Path(session_id.to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(availability.status(), StatusCode::OK);
        let body = axum::body::to_bytes(availability.into_body(), usize::MAX)
            .await
            .unwrap();
        let availability: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(availability["selected_target_id"], "edge-dashboard-session");
        assert_eq!(
            availability["effective_target_id"],
            "edge-dashboard-session"
        );
        assert_eq!(availability["selection_source"], "session");
        assert_eq!(availability["ready"], true);
        assert_eq!(availability["onboarding"]["required"], false);

        let rejected = handle_update_session(
            State(Arc::clone(&state)),
            Path(session_id.to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(UpdateSessionRequest {
                title: None,
                status: None,
                model_alias: Some("missing-model".to_string()),
                reasoning_effort: None,
                permission_mode: None,
                sandbox_mode: None,
                default_target_id: None,
                context_sharing: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            runtime
                .get_session(session_id)
                .await
                .unwrap()
                .unwrap()
                .model_alias
                .as_deref(),
            Some("fixture-model")
        );

        let inherited = handle_update_session(
            State(state),
            Path(session_id.to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(UpdateSessionRequest {
                title: None,
                status: None,
                model_alias: Some(String::new()),
                reasoning_effort: Some("provider_default".to_string()),
                permission_mode: None,
                sandbox_mode: None,
                default_target_id: None,
                context_sharing: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(inherited.status(), StatusCode::OK);
        assert_eq!(
            runtime
                .get_session(session_id)
                .await
                .unwrap()
                .unwrap()
                .model_alias,
            None
        );
        assert_eq!(
            runtime
                .get_session(session_id)
                .await
                .unwrap()
                .unwrap()
                .reasoning_effort,
            None
        );
    }

    #[tokio::test]
    async fn cloud_session_target_api_distinguishes_edge_onboarding_from_device_selection() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        drop(tmp);
        let mut config = AppConfig::default();
        config.llm.provider = Some("fixture-provider".to_string());
        config.llm.model = "fixture-model".to_string();
        config.llm.models.push("fixture-model".to_string());
        config.providers.insert(
            "fixture-provider".to_string(),
            crate::config::ProviderConfig {
                protocol: crate::config::ModelProtocol::OpenaiResponses,
                base_url: "http://localhost:8317/v1".to_string(),
                ..crate::config::ProviderConfig::default()
            },
        );
        config.execution_targets.local_enabled = false;
        let (state, runtime) =
            test_state_at_with_config_auth_and_secrets(&path, true, config, None, None).await;
        let session_id = "cloud-session-without-device";
        runtime
            .ensure_session(crate::memory::NewSession {
                id: session_id.to_string(),
                agent_id: "agent-test".to_string(),
                context_id: "context-test".to_string(),
                parent_session_id: None,
                title: "Cloud target onboarding".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();

        let availability = handle_get_session_execution_targets(
            State(Arc::clone(&state)),
            Path(session_id.to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        let body = axum::body::to_bytes(availability.into_body(), usize::MAX)
            .await
            .unwrap();
        let availability: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(availability["effective_target_id"], Value::Null);
        assert_eq!(availability["ready"], false);
        assert_eq!(availability["reason"], "execution_target_required");
        assert_eq!(availability["onboarding"]["required"], true);
        assert_eq!(availability["onboarding"]["client"], "morphz-edge");

        runtime
            .register_execution_target(ExecutionTargetRegistration {
                id: "edge-cloud-laptop".to_string(),
                owner_principal_id: Some(runtime.identity().principal_id.clone()),
                provider_node_id: None,
                kind: crate::memory::ExecutionTargetKind::EdgeNode,
                name: "Cloud user's laptop".to_string(),
                status: crate::memory::ExecutionTargetStatus::Online,
                platform: Some("macos-aarch64".to_string()),
                workspace_root: None,
                capabilities: vec!["exec".to_string()],
                metadata: json!({"test": "cloud_target_selection"}),
                policy_digest: "cloud-laptop-policy".to_string(),
                last_seen_at: Some(chrono::Utc::now()),
            })
            .await
            .unwrap();
        let availability = handle_get_session_execution_targets(
            State(state),
            Path(session_id.to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        let body = axum::body::to_bytes(availability.into_body(), usize::MAX)
            .await
            .unwrap();
        let availability: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(availability["reason"], "target_selection_required");
        assert_eq!(availability["onboarding"]["required"], false);
    }

    #[tokio::test]
    async fn context_token_budget_http_control_is_revision_fenced_and_reversible() {
        let (state, _) = test_state().await;

        let initial = handle_get_context_token_budget(
            State(Arc::clone(&state)),
            Path("context-test".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(initial.status(), StatusCode::OK);
        let initial_body = axum::body::to_bytes(initial.into_body(), usize::MAX)
            .await
            .unwrap();
        let initial_json: serde_json::Value = serde_json::from_slice(&initial_body).unwrap();
        assert_eq!(initial_json["requested_hard_token_limit"], json!(null));
        assert_eq!(initial_json["token_budget_revision"], json!(0));

        let missing = handle_get_context_token_budget(
            State(Arc::clone(&state)),
            Path("context-missing".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);

        let updated = handle_update_context_token_budget(
            State(Arc::clone(&state)),
            Path("context-test".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(UpdateContextTokenBudgetRequest {
                requested_hard_token_limit: Some(12_000),
                expected_revision: 0,
            }),
        )
        .await
        .into_response();
        assert_eq!(updated.status(), StatusCode::OK);
        let updated_body = axum::body::to_bytes(updated.into_body(), usize::MAX)
            .await
            .unwrap();
        let updated_json: serde_json::Value = serde_json::from_slice(&updated_body).unwrap();
        assert_eq!(
            updated_json["budget"]["requested_hard_token_limit"],
            json!(12_000)
        );
        assert_eq!(
            updated_json["budget"]["effective_hard_token_limit"],
            json!(12_000)
        );
        assert_eq!(updated_json["budget"]["soft_token_limit"], json!(9_000));
        assert_eq!(
            updated_json["budget"]["maintenance_reserve_tokens"],
            json!(1_500)
        );
        assert_eq!(updated_json["budget"]["token_budget_revision"], json!(1));

        let conflict = handle_update_context_token_budget(
            State(Arc::clone(&state)),
            Path("context-test".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(UpdateContextTokenBudgetRequest {
                requested_hard_token_limit: Some(8_000),
                expected_revision: 0,
            }),
        )
        .await
        .into_response();
        assert_eq!(conflict.status(), StatusCode::CONFLICT);

        let automatic = handle_update_context_token_budget(
            State(state),
            Path("context-test".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(UpdateContextTokenBudgetRequest {
                requested_hard_token_limit: None,
                expected_revision: 1,
            }),
        )
        .await
        .into_response();
        assert_eq!(automatic.status(), StatusCode::OK);
        let automatic_body = axum::body::to_bytes(automatic.into_body(), usize::MAX)
            .await
            .unwrap();
        let automatic_json: serde_json::Value = serde_json::from_slice(&automatic_body).unwrap();
        assert_eq!(
            automatic_json["budget"]["requested_hard_token_limit"],
            json!(null)
        );
        assert_eq!(automatic_json["budget"]["token_budget_revision"], json!(2));
    }

    #[cfg(feature = "experimental-cognitive-coordination")]
    #[test]
    fn coordination_execution_sessions_are_request_scoped_not_interactive_session_scoped() {
        let first = coordination_evaluation_session_id("request-a", "authority-a");
        assert_eq!(
            first,
            coordination_evaluation_session_id("request-a", "authority-a")
        );
        assert_ne!(
            first,
            coordination_evaluation_session_id("request-b", "authority-a")
        );
        assert_ne!(
            first,
            coordination_evaluation_session_id("request-a", "authority-b")
        );
        assert!(first.starts_with("coord-eval-"));
    }

    #[cfg(feature = "experimental-cognitive-coordination")]
    #[tokio::test]
    async fn coordination_execution_sessions_follow_default_shared_context_semantics() {
        let tmp = tempfile::tempdir().unwrap();
        let database_path = tmp.path().join("coordination-session.db");
        let (state, runtime) = test_state_at_with_workers(&database_path, true).await;
        let participant = crate::config::CognitiveCoordinationParticipantConfig {
            agent_id: "agent-test".to_string(),
            context_id: "context-test".to_string(),
            ..Default::default()
        };
        let session_id = coordination_evaluation_session_id("request-shared", "authority-local");
        ensure_coordination_evaluation_session(
            state.as_ref(),
            &participant,
            &session_id,
            "request-shared",
        )
        .await
        .unwrap();

        let session = runtime.get_session(&session_id).await.unwrap().unwrap();
        assert_eq!(
            session.context_sharing,
            crate::memory::SessionContextSharing::Shared,
            "coordination work should participate in the Agent's shared Context unless an operator explicitly isolates its Session",
        );
    }

    #[cfg(feature = "experimental-cognitive-coordination")]
    #[tokio::test]
    async fn context_cognitive_coordination_http_control_is_gated_and_revision_fenced() {
        let tmp = tempfile::tempdir().unwrap();
        let database_path = tmp.path().join("morphz.db");
        let mut config = AppConfig::default();
        config.llm.provider = Some("fixture-provider".to_string());
        config.llm.model = "fixture-model".to_string();
        config.llm.models.push("fixture-model".to_string());
        config.providers.insert(
            "fixture-provider".to_string(),
            crate::config::ProviderConfig {
                protocol: crate::config::ModelProtocol::OpenaiResponses,
                base_url: "http://localhost:8317/v1".to_string(),
                ..crate::config::ProviderConfig::default()
            },
        );
        config
            .experimental
            .enabled
            .insert(crate::experimental::COGNITIVE_COORDINATION.to_string());
        let (state, runtime) =
            test_state_at_with_config_auth_and_secrets(&database_path, true, config, None, None)
                .await;

        let initial = handle_get_context_capability_binding(
            State(Arc::clone(&state)),
            Path((
                "context-test".to_string(),
                crate::experimental::COGNITIVE_COORDINATION.to_string(),
            )),
            HeaderMap::new(),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(initial.status(), StatusCode::OK);
        let initial_body = axum::body::to_bytes(initial.into_body(), usize::MAX)
            .await
            .unwrap();
        let initial_json: serde_json::Value = serde_json::from_slice(&initial_body).unwrap();
        assert_eq!(initial_json["enabled"], json!(false));
        assert_eq!(initial_json["revision"], json!(0));
        assert_eq!(initial_json["feature"]["available"], json!(true));

        let enabled = handle_update_context_capability_binding(
            State(Arc::clone(&state)),
            Path((
                "context-test".to_string(),
                crate::experimental::COGNITIVE_COORDINATION.to_string(),
            )),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(UpdateContextCapabilityBindingRequest {
                enabled: true,
                expected_revision: 0,
            }),
        )
        .await
        .into_response();
        assert_eq!(enabled.status(), StatusCode::OK);
        let enabled_body = axum::body::to_bytes(enabled.into_body(), usize::MAX)
            .await
            .unwrap();
        let enabled_json: serde_json::Value = serde_json::from_slice(&enabled_body).unwrap();
        assert_eq!(enabled_json["binding"]["enabled"], json!(true));
        assert_eq!(enabled_json["binding"]["revision"], json!(1));

        let session = runtime
            .create_session(crate::memory::NewSession {
                id: "coordination-context-session".to_string(),
                agent_id: "agent-test".to_string(),
                context_id: "context-test".to_string(),
                parent_session_id: None,
                title: "Coordination Context".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let enabled_projection = runtime
            .context_encoding("context-test", &session.id)
            .await
            .unwrap();
        assert!(enabled_projection.sexpr.contains("(cognitive-capabilities"));
        assert!(enabled_projection.sexpr.contains("(tool coordinate)"));

        let required_message = handle_send_message(
            State(Arc::clone(&state)),
            Path(session.id.clone()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(SendMessageRequest {
                input_destination: None,
                text: "evaluate this through the Mesh".to_string(),
                client_message_id: Some("coordination-required-message".to_string()),
                attachments: Vec::new(),
                staged_attachment_ids: Vec::new(),
                references: Vec::new(),
                harness: None,
                dispatch_mode: None,
                model_alias: None,
                reasoning_effort: None,
                target_id: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(required_message.status(), StatusCode::ACCEPTED);
        let required_body = axum::body::to_bytes(required_message.into_body(), usize::MAX)
            .await
            .unwrap();
        let required_json: serde_json::Value = serde_json::from_slice(&required_body).unwrap();
        let required_events = runtime
            .query_events(crate::memory::QueryFilter {
                event_id: required_json["event_id"].as_str().map(str::to_string),
                ..crate::memory::QueryFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(required_events.len(), 1);
        assert_eq!(
            required_events[0].payload["coordination_mode"], "required",
            "the Context switch must be frozen onto the accepted root message"
        );

        let stale = handle_update_context_capability_binding(
            State(Arc::clone(&state)),
            Path((
                "context-test".to_string(),
                crate::experimental::COGNITIVE_COORDINATION.to_string(),
            )),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(UpdateContextCapabilityBindingRequest {
                enabled: false,
                expected_revision: 0,
            }),
        )
        .await
        .into_response();
        assert_eq!(stale.status(), StatusCode::CONFLICT);

        let disabled = handle_update_context_capability_binding(
            State(state),
            Path((
                "context-test".to_string(),
                crate::experimental::COGNITIVE_COORDINATION.to_string(),
            )),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(UpdateContextCapabilityBindingRequest {
                enabled: false,
                expected_revision: 1,
            }),
        )
        .await
        .into_response();
        assert_eq!(disabled.status(), StatusCode::OK);
        let disabled_projection = runtime
            .context_encoding("context-test", &session.id)
            .await
            .unwrap();
        assert!(!disabled_projection
            .sexpr
            .contains("(cognitive-capabilities"));
        assert!(!disabled_projection.sexpr.contains("(tool coordinate)"));
    }

    #[tokio::test]
    async fn attachment_stage_http_flow_resumes_and_binds_once_to_the_message_event() {
        let (state, runtime) = test_state().await;
        let create_session = handle_create_session(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(CreateSessionRequest {
                id: Some("attachment-stage-session".to_string()),
                agent_id: None,
                parent_session_id: None,
                title: Some("Attachment stage session".to_string()),
                mount: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(create_session.status(), StatusCode::CREATED);

        let bytes = b"streamed-document-payload";
        let digest = format!("{:x}", sha2::Sha256::digest(bytes));
        let create_stage = handle_create_message_attachment_stage(
            State(Arc::clone(&state)),
            Path("attachment-stage-session".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(CreateMessageAttachmentStageRequest {
                stage_id: Some("attachment-stage-http-1".to_string()),
                client_message_id: "attachment-client-message-1".to_string(),
                name: "manual.pdf".to_string(),
                media_type: "application/pdf".to_string(),
                size_bytes: bytes.len() as u64,
                expected_sha256: Some(digest.clone()),
            }),
        )
        .await
        .into_response();
        assert_eq!(create_stage.status(), StatusCode::OK);

        let mut first_headers = HeaderMap::new();
        first_headers.insert("x-morphz-upload-offset", "0".parse().unwrap());
        let first_upload = handle_upload_message_attachment_stage(
            State(Arc::clone(&state)),
            Path((
                "attachment-stage-session".to_string(),
                "attachment-stage-http-1".to_string(),
            )),
            first_headers,
            Query(AuthQuery::default()),
            Body::from(bytes[..9].to_vec()),
        )
        .await
        .into_response();
        assert_eq!(first_upload.status(), StatusCode::OK);
        let first_body = axum::body::to_bytes(first_upload.into_body(), usize::MAX)
            .await
            .unwrap();
        let first_stage: crate::model_input::MessageAttachmentStage =
            serde_json::from_slice(&first_body).unwrap();
        assert_eq!(first_stage.offset, 9);
        assert_eq!(
            first_stage.status,
            crate::model_input::MessageAttachmentStageStatus::Uploading
        );

        let mut stale_headers = HeaderMap::new();
        stale_headers.insert("x-morphz-upload-offset", "0".parse().unwrap());
        let stale_upload = handle_upload_message_attachment_stage(
            State(Arc::clone(&state)),
            Path((
                "attachment-stage-session".to_string(),
                "attachment-stage-http-1".to_string(),
            )),
            stale_headers,
            Query(AuthQuery::default()),
            Body::from(bytes[9..].to_vec()),
        )
        .await
        .into_response();
        assert_eq!(stale_upload.status(), StatusCode::CONFLICT);

        let mut remaining_headers = HeaderMap::new();
        remaining_headers.insert("x-morphz-upload-offset", "9".parse().unwrap());
        let completed_upload = handle_upload_message_attachment_stage(
            State(Arc::clone(&state)),
            Path((
                "attachment-stage-session".to_string(),
                "attachment-stage-http-1".to_string(),
            )),
            remaining_headers,
            Query(AuthQuery::default()),
            Body::from(bytes[9..].to_vec()),
        )
        .await
        .into_response();
        assert_eq!(completed_upload.status(), StatusCode::OK);
        let completed_body = axum::body::to_bytes(completed_upload.into_body(), usize::MAX)
            .await
            .unwrap();
        let completed_stage: crate::model_input::MessageAttachmentStage =
            serde_json::from_slice(&completed_body).unwrap();
        assert_eq!(
            completed_stage.status,
            crate::model_input::MessageAttachmentStageStatus::Ready
        );
        assert_eq!(completed_stage.sha256.as_deref(), Some(digest.as_str()));

        let listed = handle_list_message_attachment_stages(
            State(Arc::clone(&state)),
            Path("attachment-stage-session".to_string()),
            HeaderMap::new(),
            Query(MessageAttachmentStagesQuery {
                token: None,
                client_message_id: Some("attachment-client-message-1".to_string()),
            }),
        )
        .await
        .into_response();
        assert_eq!(listed.status(), StatusCode::OK);
        let listed_body = axum::body::to_bytes(listed.into_body(), usize::MAX)
            .await
            .unwrap();
        let listed_json: serde_json::Value = serde_json::from_slice(&listed_body).unwrap();
        assert_eq!(listed_json["stages"].as_array().unwrap().len(), 1);

        for expected_status in [StatusCode::ACCEPTED, StatusCode::OK] {
            let sent = handle_send_message(
                State(Arc::clone(&state)),
                Path("attachment-stage-session".to_string()),
                HeaderMap::new(),
                Query(AuthQuery::default()),
                Json(SendMessageRequest {
                    input_destination: None,
                    text: String::new(),
                    client_message_id: Some("attachment-client-message-1".to_string()),
                    attachments: Vec::new(),
                    staged_attachment_ids: vec!["attachment-stage-http-1".to_string()],
                    references: Vec::new(),
                    harness: None,
                    dispatch_mode: None,
                    model_alias: None,
                    reasoning_effort: None,
                    target_id: None,
                }),
            )
            .await
            .into_response();
            assert_eq!(sent.status(), expected_status);
        }

        let user_events = runtime
            .query_events(QueryFilter {
                session_id: Some("attachment-stage-session".to_string()),
                topic: Some("chat/user_message".to_string()),
                ..QueryFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(user_events.len(), 1);
        let attachment = &user_events[0].payload["attachments"][0];
        assert_eq!(attachment["name"], "manual.pdf");
        assert_eq!(attachment["sha256"], digest);
        assert_eq!(
            tokio::fs::read(attachment["storage_path"].as_str().unwrap())
                .await
                .unwrap(),
            bytes
        );
        let consumed = runtime
            .message_attachment_stages()
            .inspect(
                &runtime.identity().principal_id,
                "attachment-stage-session",
                "attachment-stage-http-1",
            )
            .await
            .unwrap();
        assert_eq!(
            consumed.status,
            crate::model_input::MessageAttachmentStageStatus::Consumed
        );
        assert_eq!(
            consumed.consumed_event_id.as_deref(),
            Some(user_events[0].id.as_str())
        );
    }

    #[tokio::test]
    async fn session_message_endpoint_is_idempotent_and_routes_to_session() {
        let (state, runtime) = test_state().await;
        let create = handle_create_session(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(CreateSessionRequest {
                id: Some("api-session".to_string()),
                agent_id: None,
                parent_session_id: None,
                title: Some("API Session".to_string()),
                mount: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(create.status(), StatusCode::CREATED);
        let target = handle_create_session(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(CreateSessionRequest {
                id: Some("api-session-target".to_string()),
                agent_id: None,
                parent_session_id: None,
                title: Some("API Target".to_string()),
                mount: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(target.status(), StatusCode::CREATED);
        runtime
            .register_execution_target(crate::memory::ExecutionTargetRegistration {
                id: "api-message-target".to_string(),
                owner_principal_id: Some(runtime.identity().principal_id.clone()),
                provider_node_id: None,
                kind: crate::memory::ExecutionTargetKind::EdgeNode,
                name: "API message target".to_string(),
                status: crate::memory::ExecutionTargetStatus::Online,
                platform: Some("linux-x86_64".to_string()),
                workspace_root: None,
                capabilities: vec!["exec".to_string()],
                metadata: json!({"test": "http_message_target"}),
                policy_digest: "api-message-target-policy".to_string(),
                last_seen_at: Some(chrono::Utc::now()),
            })
            .await
            .unwrap();

        let rejected = handle_send_message(
            State(Arc::clone(&state)),
            Path("api-session".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(SendMessageRequest {
                input_destination: None,
                text: "too many".to_string(),
                client_message_id: Some("client-message-too-many".to_string()),
                staged_attachment_ids: Vec::new(),
                attachments: (0..129)
                    .map(|index| IncomingMessageAttachment {
                        name: format!("shot-{index}.png"),
                        media_type: "image/png".to_string(),
                        data_base64: base64::engine::general_purpose::STANDARD
                            .encode([index as u8]),
                    })
                    .collect(),
                references: Vec::new(),
                harness: None,
                dispatch_mode: None,
                model_alias: None,
                reasoning_effort: None,
                target_id: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(rejected.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let rejected_body = axum::body::to_bytes(rejected.into_body(), usize::MAX)
            .await
            .unwrap();
        assert!(String::from_utf8_lossy(&rejected_body).contains("exceeding the limit of 128"));

        for expected_status in [StatusCode::ACCEPTED, StatusCode::OK] {
            let response = handle_send_message(
                State(Arc::clone(&state)),
                Path("api-session".to_string()),
                HeaderMap::new(),
                Query(AuthQuery::default()),
                Json(SendMessageRequest {
                    input_destination: None,
                    text: "hello".to_string(),
                    client_message_id: Some("client-message-1".to_string()),
                    staged_attachment_ids: Vec::new(),
                    attachments: vec![IncomingMessageAttachment {
                        name: "hello.png".to_string(),
                        media_type: "image/png".to_string(),
                        data_base64: base64::engine::general_purpose::STANDARD
                            .encode(b"same-image"),
                    }],
                    references: vec![crate::sdk::MessageReferenceInput::Session {
                        session_id: "api-session-target".to_string(),
                    }],
                    harness: None,
                    dispatch_mode: Some(crate::memory::MessageDispatchMode::Parallel),
                    model_alias: None,
                    reasoning_effort: None,
                    target_id: Some("api-message-target".to_string()),
                }),
            )
            .await
            .into_response();
            assert_eq!(response.status(), expected_status);
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            let receipt: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(receipt["interrupted"], json!(false));
            assert_eq!(receipt["dispatch_mode"], json!("parallel"));
        }

        let conflict = handle_send_message(
            State(Arc::clone(&state)),
            Path("api-session".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(SendMessageRequest {
                input_destination: None,
                text: "different request".to_string(),
                client_message_id: Some("client-message-1".to_string()),
                attachments: Vec::new(),
                staged_attachment_ids: Vec::new(),
                references: Vec::new(),
                harness: None,
                dispatch_mode: None,
                model_alias: None,
                reasoning_effort: None,
                target_id: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(conflict.status(), StatusCode::CONFLICT);
        let conflict_body = axum::body::to_bytes(conflict.into_body(), usize::MAX)
            .await
            .unwrap();
        let conflict_json: serde_json::Value = serde_json::from_slice(&conflict_body).unwrap();
        assert_eq!(conflict_json["error"]["code"], "conflict");

        let user_message = runtime
            .query_events(QueryFilter {
                session_id: Some("api-session".to_string()),
                topic: Some("chat/user_message".to_string()),
                ..QueryFilter::default()
            })
            .await
            .unwrap()
            .into_iter()
            .next()
            .unwrap();
        assert_eq!(
            user_message.payload["dispatch_mode"],
            json!("parallel"),
            "the one-shot HTTP scheduling choice must be an immutable part of the accepted user Event",
        );
        assert_eq!(
            user_message.payload["target_id"],
            json!("api-message-target"),
            "the HTTP message Target must be persisted before Dialogue Thread creation",
        );
        assert_eq!(
            user_message.payload["references"][0]["session_id"],
            json!("api-session-target")
        );
        assert_eq!(
            user_message.payload["references"][0]["title"],
            json!("API Target")
        );
        let storage_path = user_message.payload["attachments"][0]["storage_path"]
            .as_str()
            .unwrap();
        assert_eq!(tokio::fs::read(storage_path).await.unwrap(), b"same-image");
        let attachment_id = user_message.payload["attachments"][0]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let preview = handle_get_session_event_attachment(
            State(Arc::clone(&state)),
            Path((
                "api-session".to_string(),
                user_message.id.clone(),
                attachment_id,
            )),
            HeaderMap::new(),
            Query(AuthQuery::default()),
        )
        .await;
        assert_eq!(preview.status(), StatusCode::OK);
        assert_eq!(
            preview.headers().get(header::CONTENT_TYPE).unwrap(),
            "image/png"
        );
        assert_eq!(
            axum::body::to_bytes(preview.into_body(), usize::MAX)
                .await
                .unwrap(),
            b"same-image".as_slice()
        );
        let cross_session_preview = handle_get_session_event_attachment(
            State(Arc::clone(&state)),
            Path((
                "api-session-target".to_string(),
                user_message.id.clone(),
                user_message.payload["attachments"][0]["id"]
                    .as_str()
                    .unwrap()
                    .to_string(),
            )),
            HeaderMap::new(),
            Query(AuthQuery::default()),
        )
        .await;
        assert_eq!(cross_session_preview.status(), StatusCode::NOT_FOUND);

        // Wait for the reply itself rather than for a fixed span. The suite
        // runs in parallel, and under CPU contention the orchestrator needs
        // longer than any constant short enough to keep the suite quick, which
        // turned load into spurious failures.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let events = loop {
            let events = runtime
                .query_events(QueryFilter {
                    session_id: Some("api-session".to_string()),
                    ..QueryFilter::default()
                })
                .await
                .unwrap();
            if events.iter().any(|event| event.topic == "chat/reply") {
                break events;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the session endpoint never produced a reply: {:?}",
                events
                    .iter()
                    .map(|event| event.topic.as_str())
                    .collect::<Vec<_>>()
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        };
        assert_eq!(
            events
                .iter()
                .filter(|event| event.event_type == crate::event::TYPE_USER_MESSAGE)
                .count(),
            1
        );
        assert!(events.iter().any(|event| event.topic == "chat/reply"));
    }

    #[tokio::test]
    async fn model_stream_precedes_durable_reply_and_carries_stable_route() {
        let (state, runtime) = test_state().await;
        let create = handle_create_session(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(CreateSessionRequest {
                id: Some("stream-session".to_string()),
                agent_id: None,
                parent_session_id: None,
                title: Some("Stream Session".to_string()),
                mount: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(create.status(), StatusCode::CREATED);

        let mut live_events = runtime.subscribe("*", 32);
        let response = handle_send_message(
            State(Arc::clone(&state)),
            Path("stream-session".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(SendMessageRequest {
                input_destination: None,
                text: "stream please".to_string(),
                client_message_id: Some("stream-message-1".to_string()),
                attachments: Vec::new(),
                staged_attachment_ids: Vec::new(),
                references: Vec::new(),
                harness: None,
                dispatch_mode: None,
                model_alias: None,
                reasoning_effort: None,
                target_id: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let trace_id = response
            .headers()
            .get("x-morphz-trace-id")
            .and_then(|value| value.to_str().ok())
            .expect("accepted message response must expose its root Turn ID")
            .to_string();

        let mut stream_kinds = Vec::new();
        let mut streamed_text = String::new();
        let mut streamed_reasoning_summary = String::new();
        let mut stable_activation_id = None;
        let mut reply_seen = false;
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !reply_seen {
                let event = live_events
                    .recv()
                    .await
                    .expect("runtime event stream closed");
                if event.topic == "runtime/model_stream" {
                    let activation_id = event
                        .payload
                        .get("activation_id")
                        .and_then(|value| value.as_str())
                        .expect("model stream route must include activation_id");
                    if let Some(expected) = stable_activation_id.as_deref() {
                        assert_eq!(activation_id, expected);
                    } else {
                        stable_activation_id = Some(activation_id.to_string());
                    }
                    let stream_kind = event
                        .payload
                        .get("stream")
                        .and_then(|value| value.get("kind"))
                        .and_then(|value| value.as_str())
                        .expect("stream kind");
                    stream_kinds.push(stream_kind.to_string());
                    if stream_kind == "text_delta" {
                        if let Some(text) = event
                            .payload
                            .get("stream")
                            .and_then(|value| value.get("text"))
                            .and_then(|value| value.as_str())
                        {
                            streamed_text.push_str(text);
                        }
                    } else if stream_kind == "reasoning_summary_delta" {
                        if let Some(text) = event
                            .payload
                            .get("stream")
                            .and_then(|value| value.get("text"))
                            .and_then(|value| value.as_str())
                        {
                            streamed_reasoning_summary.push_str(text);
                        }
                    }
                } else if event.topic == "chat/reply" {
                    assert_eq!(
                        event
                            .payload
                            .get("activation_id")
                            .and_then(|value| value.as_str()),
                        stable_activation_id.as_deref()
                    );
                    reply_seen = true;
                }
            }
        })
        .await
        .expect("stream and reply timed out");

        assert_eq!(
            stream_kinds,
            [
                "started",
                "reasoning_summary_delta",
                "text_delta",
                "text_delta",
                "completed"
            ]
        );
        assert_eq!(streamed_text, "session-api-reply");
        assert_eq!(streamed_reasoning_summary, "provider-authored summary");
        let turn_trace = runtime
            .observability()
            .turn(&trace_id)
            .expect("accepted message must retain a Turn timeline");
        let observed_stages = turn_trace
            .stages
            .iter()
            .map(|stage| stage.stage.as_str())
            .collect::<std::collections::HashSet<_>>();
        for expected in [
            "ingress.claim_message",
            "ingress.dispatch",
            "scheduler.to_activation_running",
            "context.build",
            "provider.request_ready",
            "provider.stream_started",
            "provider.first_output",
        ] {
            assert!(
                observed_stages.contains(expected),
                "Turn timeline is missing {expected}: {:?}",
                turn_trace.stages
            );
        }
        let persisted = runtime
            .query_events(QueryFilter {
                session_id: Some("stream-session".to_string()),
                ..QueryFilter::default()
            })
            .await
            .unwrap();
        assert!(persisted
            .iter()
            .all(|event| event.topic != "runtime/model_stream"));
        let reply = persisted.iter().find(|event| {
            event.topic == "chat/reply"
                && event.payload.get("text").and_then(|value| value.as_str())
                    == Some("session-api-reply")
        });
        assert!(reply.is_some());
        let summary = persisted
            .iter()
            .find(|event| event.topic == "runtime/model_reasoning_summary")
            .expect("reasoning summary must be durable independently of reply");
        assert_eq!(
            summary
                .payload
                .get("context_id")
                .and_then(|value| value.as_str()),
            Some("context-test")
        );
        assert_eq!(
            summary
                .payload
                .get("session_id")
                .and_then(|value| value.as_str()),
            Some("stream-session")
        );
        assert_eq!(
            summary
                .payload
                .get("activation_id")
                .and_then(|value| value.as_str()),
            stable_activation_id.as_deref()
        );
        assert_eq!(
            summary
                .payload
                .get("thread_kind")
                .and_then(|value| value.as_str()),
            Some("dialogue_turn")
        );
        assert_eq!(
            summary.payload.get("text").and_then(|value| value.as_str()),
            Some("provider-authored summary")
        );
        assert_eq!(
            summary
                .payload
                .get("complete")
                .and_then(|value| value.as_bool()),
            Some(true)
        );
        assert_ne!(summary.id, reply.unwrap().id);

        let context = runtime
            .context_encoding("context-test", "stream-session")
            .await
            .unwrap();
        assert!(context
            .observations
            .iter()
            .all(|observation| observation.preview != "provider-authored summary"));
    }

    #[tokio::test]
    async fn reasoning_summary_survives_runtime_rebuild_and_remains_queryable() {
        let directory = tempfile::tempdir().unwrap();
        let database_path = directory.path().join("reasoning-summary.db");
        let (state, runtime) = test_state_at(&database_path).await;
        let create = handle_create_session(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(CreateSessionRequest {
                id: Some("summary-restart-session".to_string()),
                agent_id: None,
                parent_session_id: None,
                title: Some("Reasoning Summary Restart".to_string()),
                mount: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(create.status(), StatusCode::CREATED);

        let response = handle_send_message(
            State(Arc::clone(&state)),
            Path("summary-restart-session".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(SendMessageRequest {
                input_destination: None,
                text: "persist summary".to_string(),
                client_message_id: Some("summary-restart-message".to_string()),
                attachments: Vec::new(),
                staged_attachment_ids: Vec::new(),
                references: Vec::new(),
                harness: None,
                dispatch_mode: None,
                model_alias: None,
                reasoning_effort: None,
                target_id: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::ACCEPTED);

        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let events = runtime
                    .query_events(QueryFilter {
                        session_id: Some("summary-restart-session".to_string()),
                        ..QueryFilter::default()
                    })
                    .await
                    .unwrap();
                if events
                    .iter()
                    .any(|event| event.topic == "runtime/model_reasoning_summary")
                    && events.iter().any(|event| event.topic == "chat/reply")
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("summary and reply were not durably committed");

        drop(state);
        drop(runtime);

        let (_restarted_state, restarted_runtime) = test_state_at(&database_path).await;
        let restored = restarted_runtime
            .query_events(QueryFilter {
                session_id: Some("summary-restart-session".to_string()),
                ..QueryFilter::default()
            })
            .await
            .unwrap();
        let summary = restored
            .iter()
            .find(|event| event.topic == "runtime/model_reasoning_summary")
            .expect("restarted Runtime must recover the reasoning summary from persisted Events");
        assert_eq!(
            summary.payload.get("text").and_then(|value| value.as_str()),
            Some("provider-authored summary")
        );
        assert_eq!(
            summary
                .payload
                .get("complete")
                .and_then(|value| value.as_bool()),
            Some(true)
        );
    }

    #[tokio::test]
    async fn context_observability_endpoints_expose_working_set_and_activations() {
        let (state, _) = test_state().await;
        let create = handle_create_session(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(CreateSessionRequest {
                id: Some("api-observability-session".to_string()),
                agent_id: None,
                parent_session_id: None,
                title: Some("Observability Session".to_string()),
                mount: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(create.status(), StatusCode::CREATED);

        let working_set = handle_get_context_working_set(
            State(Arc::clone(&state)),
            Path("context-test".to_string()),
            HeaderMap::new(),
            Query(AuthQuery {
                token: None,
                session_id: Some("api-observability-session".to_string()),
                principal_id: None,
                ..Default::default()
            }),
        )
        .await
        .into_response();
        assert_eq!(working_set.status(), StatusCode::OK);
        let working_set_body = axum::body::to_bytes(working_set.into_body(), usize::MAX)
            .await
            .unwrap();
        let working_set_json: serde_json::Value =
            serde_json::from_slice(&working_set_body).unwrap();
        assert_eq!(
            working_set_json["active_session_id"],
            json!("api-observability-session")
        );
        assert!(working_set_json.get("working_set").is_some());
        assert!(working_set_json.get("session_directory").is_some());

        let overview = handle_get_context_overview(
            State(Arc::clone(&state)),
            Path("context-test".to_string()),
            HeaderMap::new(),
            Query(ContextOverviewHttpQuery {
                token: None,
                session_id: Some("api-observability-session".to_string()),
                include_scheduler_summary: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(overview.status(), StatusCode::OK);
        let overview_body = axum::body::to_bytes(overview.into_body(), usize::MAX)
            .await
            .unwrap();
        let overview_json: serde_json::Value = serde_json::from_slice(&overview_body).unwrap();
        assert_eq!(overview_json["context"]["id"], json!("context-test"));
        assert_eq!(
            overview_json["active_session_id"],
            json!("api-observability-session")
        );
        assert!(overview_json["scheduler"].is_object());

        let runtime_overview = handle_get_runtime_overview(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(RuntimeOverviewHttpQuery {
                token: None,
                include_archived: false,
                context_limit: Some(10),
                sessions_per_context: Some(4),
                context_id: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(runtime_overview.status(), StatusCode::OK);
        let runtime_overview_body = axum::body::to_bytes(runtime_overview.into_body(), usize::MAX)
            .await
            .unwrap();
        let runtime_overview_json: serde_json::Value =
            serde_json::from_slice(&runtime_overview_body).unwrap();
        assert_eq!(runtime_overview_json["summary"]["contexts"], json!(1));
        assert_eq!(
            runtime_overview_json["contexts"][0]["context"]["id"],
            json!("context-test")
        );
        assert_eq!(
            runtime_overview_json["contexts"][0]["sessions"][0]["session"]["id"],
            json!("api-observability-session")
        );
        assert!(runtime_overview_json["summary"]["active_execution_jobs"].is_number());
        assert!(runtime_overview_json["summary"]["waiting"].is_number());
        assert!(runtime_overview_json["contexts"][0]["sessions"][0]["objectives"].is_array());
        assert!(runtime_overview_json["contexts"][0]["sessions"][0]["threads"].is_array());

        let full_context = handle_get_session_context(
            State(Arc::clone(&state)),
            Path("api-observability-session".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(full_context.status(), StatusCode::OK);
        let full_context_body = axum::body::to_bytes(full_context.into_body(), usize::MAX)
            .await
            .unwrap();
        let full_context_json: serde_json::Value =
            serde_json::from_slice(&full_context_body).unwrap();
        assert!(full_context_json["sexpr"].as_str().is_some());

        let projection = handle_get_session_context_projection(
            State(Arc::clone(&state)),
            Path("api-observability-session".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(projection.status(), StatusCode::OK);
        let projection_body = axum::body::to_bytes(projection.into_body(), usize::MAX)
            .await
            .unwrap();
        let projection_json: serde_json::Value = serde_json::from_slice(&projection_body).unwrap();
        assert_eq!(projection_json["context_id"], json!("context-test"));
        assert!(projection_json.get("state").is_some());
        assert!(projection_json.get("sexpr").is_none());

        let encoding = handle_get_session_context_encoding(
            State(Arc::clone(&state)),
            Path("api-observability-session".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(encoding.status(), StatusCode::OK);
        let encoding_body = axum::body::to_bytes(encoding.into_body(), usize::MAX)
            .await
            .unwrap();
        let encoding_json: serde_json::Value = serde_json::from_slice(&encoding_body).unwrap();
        assert_eq!(encoding_json["context_id"], json!("context-test"));
        assert_eq!(
            encoding_json["session_id"],
            json!("api-observability-session")
        );
        assert!(encoding_json["encoding"]
            .as_str()
            .is_some_and(|value| value.starts_with("(context")));

        let activations = handle_get_context_activations(
            State(Arc::clone(&state)),
            Path("context-test".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(activations.status(), StatusCode::OK);
        let activations_body = axum::body::to_bytes(activations.into_body(), usize::MAX)
            .await
            .unwrap();
        let activations_json: serde_json::Value =
            serde_json::from_slice(&activations_body).unwrap();
        assert!(activations_json["activations"].is_array());

        let scheduler = handle_get_scheduler_snapshot(
            State(Arc::clone(&state)),
            Path("context-test".to_string()),
            HeaderMap::new(),
            Query(SchedulerSnapshotHttpQuery {
                token: None,
                include_terminal: true,
                limit: Some(100),
            }),
        )
        .await
        .into_response();
        assert_eq!(scheduler.status(), StatusCode::OK);
        let scheduler_body = axum::body::to_bytes(scheduler.into_body(), usize::MAX)
            .await
            .unwrap();
        let scheduler_json: serde_json::Value = serde_json::from_slice(&scheduler_body).unwrap();
        assert_eq!(scheduler_json["context_id"], json!("context-test"));
        assert!(scheduler_json["threads"].is_array());
        assert!(scheduler_json["thread_groups"].is_array());
        assert!(scheduler_json["admission"].is_object());
        assert!(scheduler_json["model_provider"].is_object());
        assert!(scheduler_json["context_capacity"].is_object());

        let event_history = handle_query_event_history(
            State(Arc::clone(&state)),
            Path("context-test".to_string()),
            HeaderMap::new(),
            Query(EventHistoryHttpQuery {
                token: None,
                session_id: Some("api-observability-session".to_string()),
                limit: Some(50),
                ..EventHistoryHttpQuery::default()
            }),
        )
        .await
        .into_response();
        assert_eq!(event_history.status(), StatusCode::OK);
        let event_history_body = axum::body::to_bytes(event_history.into_body(), usize::MAX)
            .await
            .unwrap();
        let event_history_json: serde_json::Value =
            serde_json::from_slice(&event_history_body).unwrap();
        assert_eq!(event_history_json["context_id"], json!("context-test"));
        assert!(event_history_json["events"].is_array());
        assert!(event_history_json["scanned_count"].is_number());

        let projection_audit = handle_audit_mind_projection(
            State(Arc::clone(&state)),
            Path("context-test".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(projection_audit.status(), StatusCode::OK);
        let projection_audit_body = axum::body::to_bytes(projection_audit.into_body(), usize::MAX)
            .await
            .unwrap();
        let projection_audit_json: serde_json::Value =
            serde_json::from_slice(&projection_audit_body).unwrap();
        assert_eq!(projection_audit_json["context_id"], json!("context-test"));
        assert_eq!(projection_audit_json["matches"], json!(true));

        let status = handle_status(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(status.status(), StatusCode::OK);
        let status_body = axum::body::to_bytes(status.into_body(), usize::MAX)
            .await
            .unwrap();
        let status_json: serde_json::Value = serde_json::from_slice(&status_body).unwrap();
        assert_eq!(status_json["agent_id"], json!("agent-test"));
        assert_eq!(status_json["model"], json!("fixture-model"));
        assert_eq!(status_json["models"], json!(["fixture-model"]));
        assert_eq!(
            status_json["model_options"][0]["id"],
            json!("fixture-model")
        );
        assert_eq!(
            status_json["model_options"][0]["source"],
            json!("configured")
        );
        assert_eq!(status_json["storage_backend"], json!("sqlite"));
        assert!(status_json["git_commit"].is_string());
        assert!(status_json["uptime_seconds"].is_number());
        assert!(status_json["recovery"].is_object());
    }

    #[tokio::test]
    async fn event_history_query_returns_the_latest_page_and_pages_backward_without_overlap() {
        let (_, runtime) = test_state().await;
        for index in 1..=5 {
            runtime
                .publish(Event::new(
                    format!("event-history-page-{index}"),
                    "Event-History-Pagination-Test".to_string(),
                    "event_history_test".to_string(),
                    "test/event-history-pagination".to_string(),
                    vec![
                        ("context_id".to_string(), json!("context-test")),
                        ("ordinal".to_string(), json!(index)),
                    ]
                    .into_iter()
                    .collect(),
                ))
                .await
                .unwrap();
        }

        let latest = runtime
            .query_event_history(EventHistoryQuery {
                context_id: "context-test".to_string(),
                actor: Some("Event-History-Pagination-Test".to_string()),
                limit: 2,
                ..EventHistoryQuery::default()
            })
            .await
            .unwrap();
        assert_eq!(
            latest
                .events
                .iter()
                .map(|event| event.id.as_str())
                .collect::<Vec<_>>(),
            vec!["event-history-page-4", "event-history-page-5"]
        );
        let older_cursor = latest
            .next_before_sequence
            .expect("an older page must exist");

        let older = runtime
            .query_event_history(EventHistoryQuery {
                context_id: "context-test".to_string(),
                actor: Some("Event-History-Pagination-Test".to_string()),
                before_sequence: Some(older_cursor),
                limit: 2,
                ..EventHistoryQuery::default()
            })
            .await
            .unwrap();
        assert_eq!(
            older
                .events
                .iter()
                .map(|event| event.id.as_str())
                .collect::<Vec<_>>(),
            vec!["event-history-page-2", "event-history-page-3"]
        );
        assert!(older.next_before_sequence.is_some());
    }

    #[tokio::test]
    async fn model_usage_endpoint_returns_exact_durable_facts_without_pricing() {
        let (state, runtime) = test_state().await;
        runtime
            .publish(Event::new(
                "model_usage_http_attempt-1".to_string(),
                "Model-Provider".to_string(),
                "runtime_control".to_string(),
                "runtime/model_usage".to_string(),
                vec![
                    ("context_id".to_string(), json!("context-test")),
                    ("session_id".to_string(), json!("session-usage-http")),
                    ("attempt_id".to_string(), json!("attempt-1")),
                    ("model".to_string(), json!("fixture-model")),
                    (
                        "usage".to_string(),
                        json!({
                            "input_tokens": 10,
                            "cached_input_tokens": 6,
                            "uncached_input_tokens": 4,
                            "output_tokens": 4,
                            "total_tokens": 14,
                            "raw": [{"prompt_tokens": 10, "completion_tokens": 4}]
                        }),
                    ),
                ]
                .into_iter()
                .collect(),
            ))
            .await
            .unwrap();

        let response = handle_get_model_usage(
            State(state),
            Path("context-test".to_string()),
            HeaderMap::new(),
            Query(ModelUsageHttpQuery {
                token: None,
                session_id: Some("session-usage-http".to_string()),
                before_sequence: None,
                limit: Some(20),
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["records"][0]["usage"]["total_tokens"], json!(14));
        assert_eq!(value["totals"]["input_tokens"], json!(10));
        assert_eq!(value["totals"]["output_tokens"], json!(4));
        assert_eq!(value["totals"]["total_tokens"], json!(14));
        assert_eq!(value["cost_totals"], json!([]));
    }

    #[tokio::test]
    async fn schedule_control_endpoint_is_revision_fenced() {
        use crate::memory::sqlite::SqliteStore;
        use crate::memory::{NewSchedule, NewThread, ThreadKind};

        let (state, runtime) = test_state().await;
        runtime
            .ensure_session(NewSession {
                id: "api-schedule-session".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Schedule API".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let store = SqliteStore::new(runtime.sqlite_database_path().unwrap())
            .await
            .unwrap();
        let thread = store
            .ensure_thread(NewThread {
                id: "api-schedule-thread".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                session_id: "api-schedule-session".to_string(),
                initiating_principal_id: None,
                root_turn_id: "api-schedule-turn".to_string(),
                kind: ThreadKind::Execution,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: crate::memory::ThreadSupervision::legacy(),
            })
            .await
            .unwrap();
        let schedule = store
            .ensure_schedule(NewSchedule {
                id: "api-schedule".to_string(),
                thread_id: thread.id,
                source_turn_id: "api-schedule-turn".to_string(),
                intent: "continue later".to_string(),
                model_alias: None,
                not_before: Some(chrono::Utc::now() + chrono::Duration::hours(1)),
                interval_seconds: None,
                dependency_thread_ids: Vec::new(),
            })
            .await
            .unwrap();

        let paused = handle_mutate_schedule(
            State(Arc::clone(&state)),
            Path(schedule.id.clone()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(MutateScheduleRequest {
                action: "pause".to_string(),
                expected_revision: schedule.revision,
                not_before: None,
                interval_seconds: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(paused.status(), StatusCode::OK);

        let stale = handle_mutate_schedule(
            State(state),
            Path(schedule.id),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(MutateScheduleRequest {
                action: "pause".to_string(),
                expected_revision: schedule.revision,
                not_before: None,
                interval_seconds: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(stale.status(), StatusCode::CONFLICT);
        let body = axum::body::to_bytes(stale.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["outcome"], "conflict");
        assert_eq!(payload["schedule"]["status"], "paused");
    }

    #[tokio::test]
    async fn thread_supersede_endpoint_advances_one_logical_thread_generation() {
        use crate::memory::sqlite::SqliteStore;
        use crate::memory::{NewThread, ThreadKind};

        let (state, runtime) = test_state().await;
        runtime
            .ensure_session(NewSession {
                id: "api-supersede-session".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Thread Supersede API".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let store = SqliteStore::new(runtime.sqlite_database_path().unwrap())
            .await
            .unwrap();
        let thread = store
            .ensure_thread(NewThread {
                id: "api-supersede-thread".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                session_id: "api-supersede-session".to_string(),
                initiating_principal_id: None,
                root_turn_id: "api-supersede-turn".to_string(),
                kind: ThreadKind::Execution,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: crate::memory::ThreadSupervision::legacy(),
            })
            .await
            .unwrap();

        let superseded = handle_supersede_thread(
            State(Arc::clone(&state)),
            Path((thread.context_id.clone(), thread.id.clone())),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(SupersedeThreadRequest {
                expected_revision: thread.revision,
                intent: "Use the corrected contract".to_string(),
                reason: Some("operator correction".to_string()),
            }),
        )
        .await
        .into_response();
        assert_eq!(superseded.status(), StatusCode::OK);
        let body = axum::body::to_bytes(superseded.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["thread"]["id"], thread.id);
        assert_eq!(payload["thread"]["generation"], thread.generation + 1);
        assert_eq!(payload["thread"]["lifecycle"], "open");

        let stale = handle_supersede_thread(
            State(state),
            Path((thread.context_id, thread.id)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(SupersedeThreadRequest {
                expected_revision: thread.revision,
                intent: "Duplicate stale correction".to_string(),
                reason: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(stale.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn recall_http_endpoints_share_the_runtime_domain_service() {
        let (state, runtime) = test_state().await;
        runtime
            .ensure_session(NewSession {
                id: "api-recall-session".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Recall API".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        runtime
            .apply_context_transaction(
                "context-test",
                "api-recall-session",
                r#"(context-tx
                    (base-version 0)
                    (reason "验证统一 Recall HTTP API")
                    (create frame-source (fact "阳光电源项目资料"))
                    (create frame-summary (summary "新能源业务归纳"))
                    (relate frame-summary supersedes frame-source))"#,
            )
            .await
            .unwrap();
        // Recall is an eventually consistent, rebuildable Projection and is
        // deliberately outside the Event and Mind commit transaction.
        runtime.rebuild_recall_index("context-test").await.unwrap();

        let inspect = handle_inspect_recall_index(
            State(Arc::clone(&state)),
            Path("context-test".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(inspect.status(), StatusCode::OK);
        let body = axum::body::to_bytes(inspect.into_body(), usize::MAX)
            .await
            .unwrap();
        let audit: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(audit["frame_documents"], json!(2));
        assert!(audit["capability"]["indexed"].as_bool().unwrap());

        let search = handle_search_recall(
            State(Arc::clone(&state)),
            Path("context-test".to_string()),
            HeaderMap::new(),
            Query(RecallSearchHttpQuery {
                token: None,
                query: Some("阳光电源".to_string()),
                start_time: None,
                end_time: None,
                cursor: None,
                limit: Some(10),
            }),
        )
        .await
        .into_response();
        assert_eq!(search.status(), StatusCode::OK);
        let body = axum::body::to_bytes(search.into_body(), usize::MAX)
            .await
            .unwrap();
        let results: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(results["matches"][0]["document_id"], "frame-source");

        let graph = handle_recall_frame(
            State(Arc::clone(&state)),
            Path(("context-test".to_string(), "frame-source".to_string())),
            HeaderMap::new(),
            Query(FrameRecallHttpQuery {
                token: None,
                depth: Some(2),
                direction: Some(FrameRecallDirection::Both),
                include_bodies: Some(true),
                include_events: Some(false),
                max_nodes: Some(10),
                cursor: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(graph.status(), StatusCode::OK);
        let body = axum::body::to_bytes(graph.into_body(), usize::MAX)
            .await
            .unwrap();
        let graph: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(graph["nodes"].as_array().unwrap().len(), 2);
        assert_eq!(graph["edges"].as_array().unwrap().len(), 1);

        let lifecycle = handle_mutate_frame_lifecycle(
            State(Arc::clone(&state)),
            Path(("context-test".to_string(), "frame-summary".to_string())),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(MutateFrameLifecycleRequest {
                session_id: "api-recall-session".to_string(),
                expected_version: 1,
                action: "protect".to_string(),
                reason: Some("保留归纳结果".to_string()),
            }),
        )
        .await
        .into_response();
        assert_eq!(lifecycle.status(), StatusCode::OK);

        let rebuild = handle_rebuild_recall_index(
            State(state),
            Path("context-test".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(rebuild.status(), StatusCode::OK);
        let body = axum::body::to_bytes(rebuild.into_body(), usize::MAX)
            .await
            .unwrap();
        let audit: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(audit["frame_documents"], json!(2));
    }

    #[tokio::test]
    async fn dialogue_history_search_only_returns_openable_messages() {
        let (state, runtime) = test_state().await;
        runtime
            .ensure_session(NewSession {
                id: "dialogue-search-session".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Dialogue Search".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();

        for (id, topic, text, objective_id) in [
            (
                "dialogue-search-user",
                "chat/user_message",
                "dialogue-search-sentinel user request",
                None,
            ),
            (
                "dialogue-search-steering",
                "chat/steering",
                "dialogue-search-sentinel directed correction",
                None,
            ),
            (
                "dialogue-search-delivery",
                "chat/reply",
                "dialogue-search-sentinel application delivery",
                Some("objective-dialogue-search"),
            ),
            (
                "dialogue-search-control",
                "runtime/model_attempt_state",
                "dialogue-search-sentinel internal control event",
                None,
            ),
        ] {
            let mut payload = serde_json::Map::from_iter([
                ("context_id".to_string(), json!("context-test")),
                ("session_id".to_string(), json!("dialogue-search-session")),
                ("text".to_string(), json!(text)),
            ]);
            if let Some(objective_id) = objective_id {
                payload.insert("objective_id".to_string(), json!(objective_id));
            }
            runtime
                .publish(Event::new(
                    id.to_string(),
                    "Dialogue-Search-Test".to_string(),
                    "test".to_string(),
                    topic.to_string(),
                    payload,
                ))
                .await
                .unwrap();
        }
        runtime.rebuild_recall_index("context-test").await.unwrap();

        let response = handle_search_dialogue_history(
            State(state),
            Path("context-test".to_string()),
            HeaderMap::new(),
            Query(DialogueHistorySearchHttpQuery {
                token: None,
                principal_id: None,
                query: "dialogue-search-sentinel".to_string(),
                limit: Some(20),
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let matches = payload["matches"].as_array().unwrap();
        assert_eq!(matches.len(), 3);
        assert!(matches
            .iter()
            .all(|hit| hit["session_id"] == "dialogue-search-session"));
        assert!(matches
            .iter()
            .any(|hit| hit["kind"] == "user" && hit["event_id"] == "dialogue-search-user"));
        assert!(matches
            .iter()
            .any(|hit| hit["kind"] == "user" && hit["event_id"] == "dialogue-search-steering"));
        assert!(matches.iter().any(|hit| {
            hit["kind"] == "execution_result" && hit["event_id"] == "dialogue-search-delivery"
        }));
        assert!(!matches
            .iter()
            .any(|hit| hit["event_id"] == "dialogue-search-control"));
    }

    #[tokio::test]
    async fn session_events_http_pages_backward_without_losing_old_messages() {
        let (state, runtime) = test_state().await;
        runtime
            .ensure_session(NewSession {
                id: "dialogue-page-session".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Dialogue Pagination".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        for ordinal in 1..=5 {
            let mut event = Event::new(
                format!("dialogue-page-{ordinal}"),
                "Dialogue-Pagination-Test".to_string(),
                "test".to_string(),
                "chat/user_message".to_string(),
                serde_json::Map::from_iter([
                    ("context_id".to_string(), json!("context-test")),
                    ("session_id".to_string(), json!("dialogue-page-session")),
                    ("text".to_string(), json!(format!("message {ordinal}"))),
                ]),
            );
            event.timestamp =
                chrono::Utc::now() - chrono::Duration::days(1) + chrono::Duration::seconds(ordinal);
            runtime.publish(event).await.unwrap();
        }
        // Recent Runtime noise must not evict an old but still newest
        // Dialogue tail. The initial page is defined by message count and
        // immutable Event sequence, not by wall-clock date or arbitrary
        // Event count.
        for ordinal in 1..=8 {
            runtime
                .publish(Event::new(
                    format!("dialogue-page-runtime-{ordinal}"),
                    "Dialogue-Pagination-Test".to_string(),
                    "test".to_string(),
                    "runtime/internal_signal".to_string(),
                    serde_json::Map::from_iter([
                        ("context_id".to_string(), json!("context-test")),
                        ("session_id".to_string(), json!("dialogue-page-session")),
                    ]),
                ))
                .await
                .unwrap();
        }

        let latest = handle_get_session_events(
            State(Arc::clone(&state)),
            Path("dialogue-page-session".to_string()),
            HeaderMap::new(),
            Query(EventQuery {
                token: None,
                principal_id: None,
                after_sequence: None,
                before_sequence: None,
                conversation_only: true,
                limit: Some(2),
            }),
        )
        .await
        .into_response();
        assert_eq!(latest.status(), StatusCode::OK);
        let body = axum::body::to_bytes(latest.into_body(), usize::MAX)
            .await
            .unwrap();
        let latest: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            latest["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(|event| event["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["dialogue-page-4", "dialogue-page-5"]
        );
        let cursor = latest["next_before_sequence"].as_u64().unwrap();

        let older = handle_get_session_events(
            State(state),
            Path("dialogue-page-session".to_string()),
            HeaderMap::new(),
            Query(EventQuery {
                token: None,
                principal_id: None,
                after_sequence: None,
                before_sequence: Some(cursor),
                conversation_only: true,
                limit: Some(2),
            }),
        )
        .await
        .into_response();
        assert_eq!(older.status(), StatusCode::OK);
        let body = axum::body::to_bytes(older.into_body(), usize::MAX)
            .await
            .unwrap();
        let older: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            older["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(|event| event["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["dialogue-page-2", "dialogue-page-3"]
        );
    }

    #[tokio::test]
    async fn conversation_events_include_durable_tool_lifecycle() {
        let (state, runtime) = test_state().await;
        runtime
            .ensure_session(NewSession {
                id: "dialogue-tool-lifecycle-session".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Dialogue Tool Lifecycle".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();

        for (id, event_type, topic, payload) in [
            (
                "dialogue-tool-selected",
                "assistant_call",
                "runtime/tool_calls_selected",
                json!({
                    "context_id": "context-test",
                    "session_id": "dialogue-tool-lifecycle-session",
                    "calls": [{
                        "id": "call-list-skills",
                        "name": "list_skills",
                        "arguments": "{}"
                    }]
                }),
            ),
            (
                "dialogue-tool-output",
                "tool_output",
                "chat/tool_output",
                json!({
                    "context_id": "context-test",
                    "session_id": "dialogue-tool-lifecycle-session",
                    "tool_call_id": "call-list-skills",
                    "tool_name": "list_skills",
                    "tool_status": "success",
                    "text": "agent-reach"
                }),
            ),
            (
                "dialogue-transfer-output",
                "tool_output",
                "runtime/artifact_transfer_completed",
                json!({
                    "context_id": "context-test",
                    "session_id": "dialogue-tool-lifecycle-session",
                    "tool_call_id": "call-transfer",
                    "tool_name": "transfer",
                    "tool_status": "success",
                    "text": "transfer completed"
                }),
            ),
            (
                "dialogue-internal-projection",
                "tool_output",
                "context/projected_observation",
                json!({
                    "context_id": "context-test",
                    "session_id": "dialogue-tool-lifecycle-session",
                    "tool_call_id": "internal-projection"
                }),
            ),
        ] {
            runtime
                .publish(Event::new(
                    id.to_string(),
                    "Dialogue-Tool-Lifecycle-Test".to_string(),
                    event_type.to_string(),
                    topic.to_string(),
                    payload.as_object().unwrap().clone(),
                ))
                .await
                .unwrap();
        }

        let response = handle_get_session_events(
            State(state),
            Path("dialogue-tool-lifecycle-session".to_string()),
            HeaderMap::new(),
            Query(EventQuery {
                token: None,
                principal_id: None,
                after_sequence: None,
                before_sequence: None,
                conversation_only: true,
                limit: Some(10),
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            body["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(|event| event["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec![
                "dialogue-tool-selected",
                "dialogue-tool-output",
                "dialogue-transfer-output"
            ]
        );
    }

    #[tokio::test]
    async fn agent_and_independent_session_endpoints_preserve_lifecycle_semantics() {
        let (state, runtime) = test_state().await;
        let create_agent = handle_create_agent(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(CreateAgentRequest {
                id: Some("agent-fresh".to_string()),
                title: Some("Fresh Agent".to_string()),
                root_context_id: Some("context-fresh".to_string()),
                root_context_title: Some("Fresh Root".to_string()),
                initial_session_id: Some("session-fresh".to_string()),
                initial_session_title: Some("Fresh Session".to_string()),
            }),
        )
        .await
        .into_response();
        assert_eq!(create_agent.status(), StatusCode::CREATED);
        let fresh_agent = runtime.get_agent("agent-fresh").await.unwrap().unwrap();
        assert_eq!(fresh_agent.root_context_id, "context-fresh");
        assert!(runtime
            .list_context_sessions("context-fresh", true)
            .await
            .unwrap()
            .iter()
            .any(|session| session.id == "session-fresh"));
        let initially_unconfigured = handle_get_agent_provider_bindings(
            State(Arc::clone(&state)),
            Path("agent-fresh".to_string()),
            HeaderMap::new(),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(initially_unconfigured.status(), StatusCode::OK);
        let body = axum::body::to_bytes(initially_unconfigured.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["bindings"].as_array().unwrap().len(), 0);

        let account_id = "shared-test-account".to_string();
        let mut provider_catalog = runtime.provider_catalog_config().unwrap();
        provider_catalog.auth_accounts.insert(
            account_id.clone(),
            AuthAccountConfig {
                auth_adapter: "none".to_string(),
                ..AuthAccountConfig::default()
            },
        );
        runtime
            .replace_provider_catalog(provider_catalog)
            .await
            .unwrap();
        let associated = handle_bind_agent_provider_account(
            State(Arc::clone(&state)),
            Path(("agent-fresh".to_string(), account_id.clone())),
            HeaderMap::new(),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(associated.status(), StatusCode::OK);
        assert_eq!(
            runtime
                .agent_provider_bindings("agent-fresh")
                .await
                .unwrap()
                .bindings[0]
                .account_id,
            account_id
        );
        let removed = handle_unbind_agent_provider_account(
            State(Arc::clone(&state)),
            Path(("agent-fresh".to_string(), account_id)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
        )
        .await
        .into_response();
        assert_eq!(removed.status(), StatusCode::OK);
        assert!(runtime
            .agent_provider_bindings("agent-fresh")
            .await
            .unwrap()
            .bindings
            .is_empty());

        let shared = handle_create_session(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(CreateSessionRequest {
                id: Some("source-session".to_string()),
                agent_id: Some("agent-test".to_string()),
                parent_session_id: None,
                title: Some("Source".to_string()),
                mount: Some(ContextMountRequest::ExistingContext {
                    context_id: "context-test".to_string(),
                }),
            }),
        )
        .await
        .into_response();
        assert_eq!(shared.status(), StatusCode::CREATED);

        let independent = handle_create_independent_session(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(CreateIndependentSessionRequest {
                source_context_id: "context-test".to_string(),
                source_version: Some(0),
                context_id: Some("context-independent".to_string()),
                context_title: Some("Inherited Mind".to_string()),
                session_id: Some("session-independent".to_string()),
                session_title: Some("Independent".to_string()),
            }),
        )
        .await
        .into_response();
        assert_eq!(independent.status(), StatusCode::CREATED);
        let target = runtime
            .get_context("context-independent")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(target.seed_context_id.as_deref(), Some("context-test"));
        assert_eq!(target.seed_context_version, Some(0));
        let target_sessions = runtime
            .list_context_sessions("context-independent", true)
            .await
            .unwrap();
        assert_eq!(target_sessions.len(), 1);
        assert_eq!(target_sessions[0].id, "session-independent");

        let mismatched_mount = handle_create_session(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(CreateSessionRequest {
                id: Some("wrong-agent-session".to_string()),
                agent_id: Some("agent-fresh".to_string()),
                parent_session_id: None,
                title: None,
                mount: Some(ContextMountRequest::ExistingContext {
                    context_id: "context-test".to_string(),
                }),
            }),
        )
        .await
        .into_response();
        assert_eq!(mismatched_mount.status(), StatusCode::CONFLICT);
    }
}
