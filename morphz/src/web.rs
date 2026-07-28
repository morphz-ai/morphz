use crate::approval::ApprovalDecision;
use crate::artifact::ArtifactTransferStageKind;
use crate::config::{ServerIdentityConfig, ServerIdentityMode};
use crate::event::Event;
use crate::execution_target::EdgeArtifactDataDirection;
use crate::identity::PrincipalAssertion;
use crate::llm::ReasoningEffort;
use crate::memory::{
    ContextUpdate, DelegationStatus, ExecutionTargetRegistration, ExecutionTargetStatus, NewAgent,
    NewCognitiveContext, NewObjective, NewSession, ObjectiveMutation, ObjectiveStatus, QueryFilter,
    ScheduleMutation, SessionMountKind, SessionStatus, SessionUpdate, ThreadControlAction,
    ThreadMutation,
};
use crate::orchestrator::context::{FrameRecallDirection, FrameRecallRequest, RecallSearchRequest};
use crate::runtime::{
    AcknowledgeAttentionCommand, ContextOverviewQuery, LedgerQuery, ModelUsageQuery, MorphzRuntime,
    SchedulerQuery,
};
use crate::sdk::{
    AppendEdgeOutputCommand, AuthorizeExecutionTargetCommand, ClaimEdgeCommand,
    ConnectExecutionNodeCommand, CreateNodePairingCodeCommand, CreateObjectiveCommand,
    ExactHarnessRef, ExecutionJobQuery, ExecutionNodeHeartbeatCommand, FinishEdgeCommand,
    HeartbeatEdgeCommand, MorphzSdk, PairExecutionNodeCommand, RetryDialogueTurnCommand,
    RotateExecutionNodeKeyCommand, SdkError, SdkErrorCode, SendMessageCommand, SessionEventsQuery,
    SubmitArtifactTransferCommand,
};
use axum::{
    body::Body,
    extract::{
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{header, HeaderMap, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post},
    Json, Router,
};
use futures_util::StreamExt;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::broadcast;
use tower_http::{compression::CompressionLayer, cors::CorsLayer};

const DASHBOARD_INDEX: &[u8] = include_bytes!("../../dashboard/dist/index.html");
const DASHBOARD_APP_JS: &[u8] = include_bytes!("../../dashboard/dist/assets/app.js");
const DASHBOARD_APP_CSS: &[u8] = include_bytes!("../../dashboard/dist/assets/app.css");
const DASHBOARD_FAVICON: &[u8] = include_bytes!("../../dashboard/dist/favicon.svg");
const DASHBOARD_ICONS: &[u8] = include_bytes!("../../dashboard/dist/icons.svg");

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
    auth_token: Option<String>,
    default_agent_id: String,
    default_context_id: String,
    identity: ServerIdentityConfig,
}

#[derive(Default, serde::Deserialize)]
struct AuthQuery {
    token: Option<String>,
    session_id: Option<String>,
    principal_id: Option<String>,
}

#[derive(Default, serde::Deserialize)]
struct SessionListQuery {
    #[serde(default)]
    include_archived: bool,
    token: Option<String>,
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
struct UpdateSessionRequest {
    title: Option<String>,
    status: Option<SessionStatus>,
}

#[derive(serde::Deserialize)]
struct SendMessageRequest {
    text: String,
    client_message_id: Option<String>,
    #[serde(default)]
    harness: Option<crate::harness::ExactHarnessRef>,
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
struct MutateScheduleRequest {
    action: String,
    expected_revision: u64,
    not_before: Option<chrono::DateTime<chrono::Utc>>,
    interval_seconds: Option<u64>,
}

#[derive(serde::Deserialize)]
struct UpdateInferenceRequest {
    reasoning_effort: Option<String>,
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
    query: String,
    limit: Option<usize>,
}

#[derive(Default, serde::Deserialize)]
struct DialogueHistorySearchHttpQuery {
    token: Option<String>,
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
}

#[derive(Default, serde::Deserialize)]
struct ModelUsageHttpQuery {
    token: Option<String>,
    session_id: Option<String>,
    before_sequence: Option<u64>,
    limit: Option<usize>,
}

#[derive(Default, serde::Deserialize)]
struct LedgerHttpQuery {
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
        let auth_token = match self.identity.mode {
            ServerIdentityMode::Default => std::env::var("MORPHZ_DASHBOARD_TOKEN")
                .ok()
                .filter(|token| !token.trim().is_empty()),
            ServerIdentityMode::TrustedGateway => {
                if self.identity.provider_id.trim().is_empty() {
                    return Err("server.identity.provider_id 不能为空".into());
                }
                let variable = self.identity.service_token_env.trim();
                if variable.is_empty() {
                    return Err("server.identity.service_token_env 不能为空".into());
                }
                let token = std::env::var(variable)
                    .map_err(|_| format!("trusted-gateway 模式需要环境变量 {variable}"))?
                    .trim()
                    .to_string();
                if token.is_empty() {
                    return Err(format!("trusted-gateway 模式的 {variable} 不能为空").into());
                }
                Some(token)
            }
        };
        self.start_with_dashboard_token(addr_str, auth_token).await
    }

    pub async fn start_with_dashboard_token(
        &self,
        addr_str: &str,
        auth_token: Option<String>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
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
                tracing::info!(adopted, "默认身份已接管旧 Session");
            }
        }

        // 通过 Runtime 事件流将所有事件分发给各 WebSocket 客户端。
        let mut events = self.runtime.subscribe("*", 1024);
        tokio::spawn(async move {
            while let Some(ev) = events.recv().await {
                // Model stream events are deliberately ephemeral. They must reach the
                // browser with the lowest possible latency and must not mutate durable
                // Session metadata once per token/chunk. Persisted events below still
                // pass through the normal routing validation and activity touch.
                if !dashboard_event_requires_session_touch(&ev) {
                    let _ = broadcast_tx_clone.send(ev);
                    continue;
                }
                let result: Result<(), crate::runtime::RuntimeError> = async {
                    if let Some(session_id) = ev
                        .payload
                        .get("session_id")
                        .and_then(|value| value.as_str())
                    {
                        let declared_context_id = ev
                            .payload
                            .get("context_id")
                            .and_then(|value| value.as_str());
                        let parent_session_id = ev
                            .payload
                            .get("parent_session_id")
                            .and_then(|value| value.as_str())
                            .map(ToOwned::to_owned);
                        ensure_dashboard_event_session_route(
                            &runtime,
                            &default_agent_id,
                            &default_context_id,
                            identity_mode,
                            session_id,
                            declared_context_id,
                            parent_session_id,
                        )
                        .await?;
                        runtime.touch_session(session_id, ev.timestamp).await?;
                    }
                    let _ = broadcast_tx_clone.send(ev);
                    Ok(())
                }
                .await;
                if let Err(error) = result {
                    tracing::warn!(error = %error, "WebSocket 事件镜像失败");
                }
            }
        });

        let state = Arc::new(AppState {
            runtime: self.runtime.clone(),
            sdk,
            broadcast_tx: self.broadcast_tx.clone(),
            auth_token: auth_token.filter(|token| !token.trim().is_empty()),
            default_agent_id: self.default_agent_id.clone(),
            default_context_id: self.default_context_id.clone(),
            identity: self.identity.clone(),
        });

        // 跨域支持 (CORS)
        let cors = CorsLayer::new()
            .allow_origin(tower_http::cors::Any)
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
            ]);

        let app = Router::new()
            .route("/", get(handle_dashboard_index))
            .route("/assets/app.js", get(handle_dashboard_app_js))
            .route("/assets/app.css", get(handle_dashboard_app_css))
            .route("/favicon.svg", get(handle_dashboard_favicon))
            .route("/icons.svg", get(handle_dashboard_icons))
            .route("/health", get(|| async { StatusCode::OK }))
            .route("/api/status", get(handle_status))
            .route(
                "/api/runtime/inference",
                get(handle_get_inference).put(handle_update_inference),
            )
            .route(
                "/api/agents",
                get(handle_list_agents).post(handle_create_agent),
            )
            .route(
                "/api/contexts",
                get(handle_list_contexts).post(handle_create_context),
            )
            .route("/api/contexts/:context_id", patch(handle_update_context))
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
                delete(handle_revoke_capability_lease),
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
            .route("/api/contexts/:context_id/ledger", get(handle_query_ledger))
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
                "/api/sessions/independent",
                post(handle_create_independent_session),
            )
            .route(
                "/api/sessions/:session_id",
                get(handle_get_session).patch(handle_update_session),
            )
            .route(
                "/api/sessions/:session_id/messages",
                post(handle_send_message),
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
            .layer(CompressionLayer::new())
            .layer(cors)
            .with_state(Arc::clone(&state));

        let addr: SocketAddr = addr_str.parse()?;
        if !addr.ip().is_loopback() && state.auth_token.is_none() {
            return Err("非本机监听必须配置服务访问令牌，避免事件流和记忆图谱无认证暴露".into());
        }
        let listener = tokio::net::TcpListener::bind(addr).await?;
        tracing::info!(addr = %addr, "Dashboard API Server 启动成功");

        tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, app).await {
                tracing::error!(error = ?e, "Web Server: Axum 运行出错");
            }
        });

        Ok(())
    }
}

fn embedded_asset(content_type: &'static str, body: &'static [u8]) -> Response {
    Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from(body))
        .expect("embedded Dashboard response must be valid")
}

async fn handle_dashboard_index() -> Response {
    embedded_asset("text/html; charset=utf-8", DASHBOARD_INDEX)
}

async fn handle_dashboard_fallback(uri: Uri) -> Response {
    if uri.path().starts_with("/api/") || uri.path() == "/api" || uri.path() == "/ws" {
        return StatusCode::NOT_FOUND.into_response();
    }
    handle_dashboard_index().await
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

async fn handle_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    Json(state.sdk.runtime_status()).into_response()
}

async fn handle_search_recall(
    State(state): State<Arc<AppState>>,
    Path(context_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<RecallSearchHttpQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if query.query.trim().is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "query 不能为空");
    }
    match state
        .runtime
        .search_recall(RecallSearchRequest {
            context_id,
            query: query.query,
            limit: query.limit.unwrap_or(20).clamp(1, 100),
        })
        .await
    {
        Ok(page) => Json(page).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

/// Search the human-facing transcript rather than the complete Event Ledger.
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
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let principal = match request_principal(&state, &headers, None) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    let query_text = query.query.trim();
    if query_text.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "query 不能为空");
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
            limit: candidate_limit,
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
                "chat/user_message" | "chat/reply" | "chat/outbound_message"
            ) && event_session_id.is_some_and(|session_id| visible_session_ids.contains(session_id))
        })
        .map(|event| (event.id.clone(), event))
        .collect::<HashMap<_, _>>();
    let matches = event_hits
        .into_iter()
        .filter_map(|hit| {
            let event = events_by_id.get(&hit.document_id)?;
            let kind = match event.topic.as_str() {
                "chat/user_message" => "user",
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
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
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
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
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
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
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
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let action = match request.action.trim() {
        "restore" => "restore",
        "protect" => "protect",
        "unprotect" => "unprotect",
        _ => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "action 只支持 restore、protect 或 unprotect",
            )
        }
    };
    let Some(session) = (match state.runtime.get_session(&request.session_id).await {
        Ok(session) => session,
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }) else {
        return error_response(StatusCode::NOT_FOUND, "Session 不存在");
    };
    if session.context_id != context_id {
        return error_response(StatusCode::BAD_REQUEST, "Session 不属于目标 Context");
    }
    let reason = request
        .reason
        .unwrap_or_else(|| format!("Dashboard 请求 {action} Frame"));
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
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    Json(json!({
        "reasoning_effort": state.runtime.reasoning_effort().map(ReasoningEffort::as_str),
    }))
    .into_response()
}

async fn handle_update_inference(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<UpdateInferenceRequest>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let effort = match request
        .reasoning_effort
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("default"))
    {
        Some(value) => match ReasoningEffort::parse(value) {
            Some(effort) => Some(effort),
            None => {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "reasoning_effort 只支持 default、none、low、medium、high、max",
                )
            }
        },
        None => None,
    };
    match state.runtime.set_reasoning_effort(effort) {
        Ok(()) => Json(json!({
            "reasoning_effort": effort.map(ReasoningEffort::as_str),
            "scope": "subsequent_requests",
            "persistent": false,
        }))
        .into_response(),
        Err(error) => error_response(StatusCode::NOT_IMPLEMENTED, error.to_string()),
    }
}

async fn handle_list_approvals(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
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
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let rationale = request
        .rationale
        .unwrap_or_else(|| "用户通过 Morphz 审批通道作出决定".to_string());
    let decision = match request.decision.trim().to_ascii_lowercase().as_str() {
        "allow" | "allow_once" | "approve" => ApprovalDecision::AllowOnce {
            rationale,
            risk_tags: vec!["human-approved".to_string()],
        },
        "allow_lease" | "approve_lease" => ApprovalDecision::AllowLease {
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
                "decision 只支持 allow_once、allow_lease 或 deny",
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
        return Err(format!("{kind} 长度必须为 1..=128"));
    }
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':'))
    {
        return Err(format!(
            "{kind} 只能包含 ASCII 字母、数字、点、横线、下划线或冒号"
        ));
    }
    Ok(())
}

fn error_response(status: StatusCode, message: impl Into<String>) -> axum::response::Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}

fn sdk_error_response(error: SdkError) -> axum::response::Response {
    let status = match error.code {
        SdkErrorCode::InvalidArgument => StatusCode::BAD_REQUEST,
        SdkErrorCode::Unauthorized => StatusCode::UNAUTHORIZED,
        SdkErrorCode::Forbidden => StatusCode::FORBIDDEN,
        SdkErrorCode::NotFound => StatusCode::NOT_FOUND,
        SdkErrorCode::Conflict => StatusCode::CONFLICT,
        SdkErrorCode::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (
        status,
        Json(json!({
            "error": {
                "code": error.code.as_str(),
                "message": error.message,
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
                "Principal Header 不是有效 UTF-8",
            )
        })?;
    if let (Some(header), Some(query)) = (header_principal_id, query_principal_id) {
        if header != query {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Header 与 Query 的 Principal 不一致",
            ));
        }
    }
    let principal_id = header_principal_id
        .or(query_principal_id)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            SdkError::new(
                SdkErrorCode::Unauthorized,
                "trusted-gateway 请求缺少当前 Principal",
            )
        })?;
    validate_identifier("principal_id", principal_id)
        .map_err(|error| SdkError::new(SdkErrorCode::InvalidArgument, error))?;
    let display_name = headers
        .get("x-morphz-principal-name")
        .map(|value| value.to_str())
        .transpose()
        .map_err(|_| {
            SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Principal Name Header 不是有效 UTF-8",
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
                        format!("挂载 Context '{}' 不存在", context_id),
                    )
                })?;
            if agent_was_explicit && requested_agent_id != context.agent_id {
                return Err((
                    StatusCode::CONFLICT,
                    format!(
                        "请求 Agent '{}' 与 Context 所属 Agent '{}' 不一致",
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
                        format!("Agent '{}' 不存在；请先 create_agent", requested_agent_id),
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
                    title: bounded_title(context_title, "新空白 Context"),
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
                        format!("来源 Context '{}' 不存在", source_context_id),
                    )
                })?;
            if agent_was_explicit && requested_agent_id != source.agent_id {
                return Err((
                    StatusCode::CONFLICT,
                    format!(
                        "请求 Agent '{}' 与来源 Context 所属 Agent '{}' 不一致",
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
                            "来源 Context 版本冲突：请求 {}，当前 {}",
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
                    title: bounded_title(context_title, "独立认知 Context"),
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
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match state.runtime.list_agents(query.include_archived).await {
        Ok(agents) => Json(json!({ "agents": agents })).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn handle_create_agent(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<CreateAgentRequest>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
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
                title: bounded_title(request.title, "新 Agent"),
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
                title: bounded_title(request.initial_session_title, "初始会话"),
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
        return StatusCode::UNAUTHORIZED.into_response();
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

async fn handle_list_contexts(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<SessionListQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
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
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let principal = match request_principal(&state, &headers, query.principal_id.as_deref()) {
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
        return StatusCode::UNAUTHORIZED.into_response();
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
        return StatusCode::UNAUTHORIZED.into_response();
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
        return StatusCode::UNAUTHORIZED.into_response();
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
        return StatusCode::UNAUTHORIZED.into_response();
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
        return StatusCode::UNAUTHORIZED.into_response();
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
        return StatusCode::UNAUTHORIZED.into_response();
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
        .unwrap_or("由当前 Principal 主动撤销");
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
        return StatusCode::UNAUTHORIZED.into_response();
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
        return StatusCode::UNAUTHORIZED.into_response();
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
        .unwrap_or("由当前 Principal 主动撤销");
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

async fn handle_create_node_pairing_code(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(command): Json<CreateNodePairingCodeCommand>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
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
        return StatusCode::UNAUTHORIZED.into_response();
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
        return StatusCode::UNAUTHORIZED.into_response();
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
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
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
        Ok(_) => return (StatusCode::CONFLICT, "Artifact stage 不是普通文件").into_response(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return (StatusCode::NOT_FOUND, "Artifact stage 不存在").into_response()
        }
        Err(error) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
        }
    };
    if channel
        .size_bytes
        .is_some_and(|expected| expected != metadata.len())
    {
        return (StatusCode::CONFLICT, "Artifact stage 大小与冻结通道不一致").into_response();
    }
    if query.offset > metadata.len() {
        return (
            StatusCode::RANGE_NOT_SATISFIABLE,
            "Artifact download offset 超过冻结大小",
        )
            .into_response();
    }
    let mut file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(error) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
        }
    };
    use tokio::io::AsyncSeekExt as _;
    if let Err(error) = file.seek(std::io::SeekFrom::Start(query.offset)).await {
        return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response();
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
        None => return (StatusCode::BAD_REQUEST, "缺少 Artifact digest").into_response(),
    };
    if channel
        .size_bytes
        .is_some_and(|expected| expected != claimed_total)
        || channel
            .expected_digest
            .as_deref()
            .is_some_and(|expected| expected != claimed_digest)
    {
        return (StatusCode::CONFLICT, "上传声明与冻结通道不一致").into_response();
    }
    let final_path = match state
        .runtime
        .artifact_transfer_stages()
        .prepare_stage_path(&job_id, ArtifactTransferStageKind::EdgeUpload)
        .await
    {
        Ok(path) => path,
        Err(error) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
        }
    };
    let partial_path = final_path.with_extension("partial");
    if tokio::fs::try_exists(&final_path).await.unwrap_or(false) {
        let metadata = match tokio::fs::metadata(&final_path).await {
            Ok(metadata) => metadata,
            Err(error) => {
                return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
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
                "error": "Artifact upload offset 冲突",
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
                return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
            }
        };
        use tokio::io::AsyncReadExt as _;
        let mut buffer = vec![0_u8; 128 * 1024];
        loop {
            let count = match prefix.read(&mut buffer).await {
                Ok(count) => count,
                Err(error) => {
                    return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
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
        Err(error) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
        }
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
                return (StatusCode::BAD_REQUEST, error.to_string()).into_response();
            }
        };
        size_bytes = size_bytes.saturating_add(chunk.len() as u64);
        if channel
            .size_bytes
            .is_some_and(|expected| size_bytes > expected)
        {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                "Artifact upload 超过冻结大小",
            )
                .into_response();
        }
        hasher.update(&chunk);
        if let Err(error) = file.write_all(&chunk).await {
            let _ = tokio::fs::remove_file(&partial_path).await;
            return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response();
        }
    }
    if size_bytes != claimed_total {
        let _ = file.flush().await;
        return (StatusCode::CONFLICT, "Artifact upload 尚未达到声明大小").into_response();
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
        return (
            StatusCode::CONFLICT,
            "Artifact upload 摘要或大小与冻结通道不一致",
        )
            .into_response();
    }
    if digest != claimed_digest {
        let _ = tokio::fs::remove_file(&partial_path).await;
        return (StatusCode::CONFLICT, "Artifact upload 摘要与声明不一致").into_response();
    }
    if let Err(error) = file.sync_all().await {
        let _ = tokio::fs::remove_file(&partial_path).await;
        return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response();
    }
    drop(file);
    if let Err(error) = tokio::fs::rename(&partial_path, &final_path).await {
        let _ = tokio::fs::remove_file(&partial_path).await;
        return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response();
    }
    Json(json!({
        "job_id": job_id,
        "content_digest": digest,
        "size_bytes": size_bytes
    }))
    .into_response()
}

fn required_u64_header(headers: &HeaderMap, name: &'static str) -> Result<u64, Response> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                format!("缺少或无效 Header: {name}"),
            )
                .into_response()
        })
}

async fn handle_list_edge_command_output(
    State(state): State<Arc<AppState>>,
    Path(job_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<EdgeOutputQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
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
        return StatusCode::UNAUTHORIZED.into_response();
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
        return StatusCode::UNAUTHORIZED.into_response();
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
        return StatusCode::UNAUTHORIZED.into_response();
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
            "Execution Job 不是 Artifact Transfer",
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
        return StatusCode::UNAUTHORIZED.into_response();
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
        return StatusCode::UNAUTHORIZED.into_response();
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
        return StatusCode::UNAUTHORIZED.into_response();
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
                "Edge Node 需要 Authorization: Bearer <device-token>",
            )
        })?;
    Ok(token)
}

fn edge_claim_token(headers: &HeaderMap) -> Result<&str, Response> {
    headers
        .get("x-morphz-claim-token")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            error_response(
                StatusCode::UNAUTHORIZED,
                "Edge Artifact channel 需要 x-morphz-claim-token",
            )
        })
}

async fn handle_get_context_working_set(
    State(state): State<Arc<AppState>>,
    Path(context_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match state.runtime.get_context(&context_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "Context 不存在"),
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
        Some(session_id) => match sessions.iter().find(|session| session.id == session_id) {
            Some(_) => session_id,
            None => {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "session_id 不属于目标 Context，或 Session 已归档",
                )
            }
        },
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
            None => return error_response(StatusCode::CONFLICT, "Context 没有活跃 Session"),
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
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match state.runtime.get_context(&context_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "Context 不存在"),
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
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match state
        .sdk
        .context_overview(
            &context_id,
            ContextOverviewQuery {
                active_session_id: query.session_id,
            },
        )
        .await
    {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_get_model_usage(
    State(state): State<Arc<AppState>>,
    Path(context_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<ModelUsageHttpQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
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
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
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
        Err(error) if error.to_string().contains("不存在") => {
            error_response(StatusCode::NOT_FOUND, error.to_string())
        }
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn handle_list_attention_acknowledgements(
    State(state): State<Arc<AppState>>,
    Path(context_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match state.sdk.attention_acknowledgements(&context_id).await {
        Ok(acknowledgements) => Json(json!({
            "context_id": context_id,
            "acknowledgements": acknowledgements,
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
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
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
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
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
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let reason = request
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .unwrap_or("用户通过 Dashboard 控制 Thread");
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
                "error": "Thread revision 冲突，请刷新后重试",
                "current": current,
            })),
        )
            .into_response(),
        Ok(ThreadMutation::NotFound) => error_response(StatusCode::NOT_FOUND, "Thread 不存在"),
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_query_ledger(
    State(state): State<Arc<AppState>>,
    Path(context_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<LedgerHttpQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match state
        .sdk
        .query_ledger(LedgerQuery {
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
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
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
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
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
                "action 只支持 pause、resume、reschedule 或 cancel",
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
                "error": "Schedule revision 已被其他写者更新",
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
        Ok(ScheduleMutation::NotFound) => error_response(StatusCode::NOT_FOUND, "Schedule 不存在"),
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
        return StatusCode::UNAUTHORIZED.into_response();
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
                format!("Agent '{}' 不存在；请先 create_agent", agent_id),
            )
        }
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
    let title = request
        .title
        .unwrap_or_else(|| "新认知 Context".to_string())
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
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let title = request
        .title
        .map(|title| title.trim().chars().take(200).collect::<String>());
    if title.as_deref() == Some("") {
        return error_response(StatusCode::BAD_REQUEST, "title 不能为空");
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

async fn handle_create_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<CreateSessionRequest>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
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
        Ok(Some(_)) => return error_response(StatusCode::CONFLICT, "Session ID 已存在"),
        Ok(None) => {}
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
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
                title: bounded_title(request.title, "新会话"),
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
        return StatusCode::UNAUTHORIZED.into_response();
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
        Ok(Some(_)) => return error_response(StatusCode::CONFLICT, "Session ID 已存在"),
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
                "Seed Context 创建后无法读取",
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
                title: bounded_title(request.session_title, "独立会话"),
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
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let principal = match request_principal(&state, &headers, None) {
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

async fn handle_update_session(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<UpdateSessionRequest>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let principal = match request_principal(&state, &headers, None) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    let title = request
        .title
        .map(|title| title.trim().chars().take(200).collect::<String>());
    if title.as_deref() == Some("") {
        return error_response(StatusCode::BAD_REQUEST, "title 不能为空");
    }
    match state
        .sdk
        .update_session(
            &principal.principal_id,
            &session_id,
            SessionUpdate {
                title,
                status: request.status,
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
        return StatusCode::UNAUTHORIZED.into_response();
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
        return error_response(StatusCode::CONFLICT, "归档 Session 不能接收新消息");
    }
    if request.text.trim().is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "消息正文不能为空");
    }
    if request.text.chars().count() > 1_000_000 {
        return error_response(StatusCode::PAYLOAD_TOO_LARGE, "消息正文超过 1,000,000 字符");
    }
    let client_message_id = request
        .client_message_id
        .unwrap_or_else(|| api_id("client"));
    if let Err(error) = validate_identifier("client_message_id", &client_message_id) {
        return error_response(StatusCode::BAD_REQUEST, error);
    }
    match state
        .sdk
        .send_message(
            &principal,
            SendMessageCommand {
                session_id,
                text: request.text,
                actor: "User-API".to_string(),
                client_message_id: Some(client_message_id),
                harness: request.harness,
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
            (
                status,
                Json(json!({
                    "accepted": true,
                    "duplicate": receipt.duplicate,
                    "event_id": receipt.event_id,
                    "client_message_id": receipt.client_message_id,
                })),
            )
                .into_response()
        }
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
        return StatusCode::UNAUTHORIZED.into_response();
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
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if state.identity.mode != ServerIdentityMode::TrustedGateway {
        return error_response(
            StatusCode::BAD_REQUEST,
            "默认身份模式不需要显式认领 Session",
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
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let principal = match request_principal(&state, &headers, None) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    let limit = query.limit.unwrap_or(100).clamp(1, 1_000);
    if query.after_sequence.is_some() && query.before_sequence.is_some() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "after_sequence 与 before_sequence 不能同时使用",
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
            Json(json!({
                "events": events,
                "next_before_sequence": next_before_sequence,
            }))
            .into_response()
        }
        Err(error) => sdk_error_response(error),
    }
}

async fn handle_get_session_context(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
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
        return StatusCode::UNAUTHORIZED.into_response();
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
        return StatusCode::UNAUTHORIZED.into_response();
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
        return StatusCode::UNAUTHORIZED.into_response();
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
    let was_running = state.runtime.cancel_session(&session_id);
    let payload = vec![
        ("session_id".to_string(), json!(session_id)),
        ("status".to_string(), json!("cancelled")),
        ("was_running".to_string(), json!(was_running)),
        (
            "text".to_string(),
            json!(if was_running {
                "当前 Session 执行已取消。"
            } else {
                "Session 当前没有运行中的执行；后续后台唤醒已暂停到下一条用户消息。"
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
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match state.runtime.list_delegations().await {
        Ok(delegations) => Json(json!({ "delegations": delegations })).into_response(),
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
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let principal = match request_principal(&state, &headers, None) {
        Ok(principal) => principal,
        Err(error) => return sdk_error_response(error),
    };
    let stated_objective = request.stated_objective.trim().to_string();
    if stated_objective.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "stated_objective 不能为空");
    }
    if request.token_budget == Some(0) {
        return error_response(StatusCode::BAD_REQUEST, "token_budget 必须大于 0");
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
            "coordinator 与 delivery Session 必须属于同一 Agent/Context",
        );
    }
    let objective_id = request.id.unwrap_or_else(|| api_id("objective"));
    if let Err(error) = validate_identifier("objective_id", &objective_id) {
        return error_response(StatusCode::BAD_REQUEST, error);
    }
    let source_event_id = api_id("objective_request");
    let source_event = Event::new(
        source_event_id.clone(),
        "User-API".to_string(),
        "objective_request".to_string(),
        "objective/requested".to_string(),
        [
            ("context_id".to_string(), json!(coordinator.context_id)),
            ("session_id".to_string(), json!(coordinator.id)),
            ("principal_id".to_string(), json!(principal.principal_id)),
            ("requested_objective_id".to_string(), json!(objective_id)),
            ("text".to_string(), json!(stated_objective)),
        ]
        .into_iter()
        .collect(),
    );
    if let Err(error) = state.runtime.publish(source_event).await {
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
    }
    match state
        .sdk
        .create_objective(
            &principal,
            CreateObjectiveCommand {
                objective: NewObjective {
                    id: objective_id,
                    agent_id: coordinator.agent_id,
                    context_id: coordinator.context_id,
                    coordinator_session_id: coordinator.id,
                    delivery_session_id: delivery.id,
                    parent_objective_id: request.parent_objective_id,
                    source_event_id,
                    initiating_principal_id: None,
                    stated_objective,
                    token_budget: request.token_budget,
                },
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
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let stated_objective = request.stated_objective.trim();
    if stated_objective.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "stated_objective 不能为空");
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
                "error": "Objective revision 冲突，请刷新后重试",
                "current": current,
            })),
        )
            .into_response(),
        Ok(ObjectiveMutation::NotFound) => {
            error_response(StatusCode::NOT_FOUND, "Objective 不存在")
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
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let objective = match state.runtime.get_objective(&objective_id).await {
        Ok(Some(objective)) => objective,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "Objective 不存在"),
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    if !matches!(
        objective.status,
        ObjectiveStatus::Blocked | ObjectiveStatus::Paused
    ) {
        return error_response(
            StatusCode::CONFLICT,
            format!(
                "Objective 当前状态为 '{}'，只有 blocked/paused 可以显式恢复",
                objective.status.as_str()
            ),
        );
    }
    let reason = request
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .unwrap_or("用户通过 Dashboard 显式恢复 Objective");
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
                "error": "Objective revision 冲突，请刷新后重试",
                "current": current,
            })),
        )
            .into_response(),
        Ok(ObjectiveMutation::NotFound) => {
            error_response(StatusCode::NOT_FOUND, "Objective 不存在")
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
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let objective = match state.runtime.get_objective(&objective_id).await {
        Ok(Some(objective)) => objective,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "Objective 不存在"),
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    if objective.status != ObjectiveStatus::Active {
        return error_response(
            StatusCode::CONFLICT,
            format!(
                "Objective 当前状态为 '{}'，只有 active 可以显式暂停",
                objective.status.as_str()
            ),
        );
    }
    let reason = request
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .unwrap_or("用户通过 Dashboard 显式暂停 Objective");
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
                "error": "Objective revision 冲突，请刷新后重试",
                "current": current,
            })),
        )
            .into_response(),
        Ok(ObjectiveMutation::NotFound) => {
            error_response(StatusCode::NOT_FOUND, "Objective 不存在")
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
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let reason = request
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .unwrap_or("用户通过 Dashboard 删除 Objective");
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
                "error": "Objective revision 冲突，请刷新后重试",
                "current": current,
            })),
        )
            .into_response(),
        Ok(ObjectiveMutation::NotFound) => {
            error_response(StatusCode::NOT_FOUND, "Objective 不存在")
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
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match state.runtime.get_delegation(&delegation_id).await {
        Ok(Some(delegation)) => Json(delegation).into_response(),
        Ok(None) => error_response(StatusCode::NOT_FOUND, "Delegation 不存在"),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn handle_cancel_delegation(
    State(state): State<Arc<AppState>>,
    Path(delegation_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let delegation = match state.runtime.get_delegation(&delegation_id).await {
        Ok(Some(delegation)) => delegation,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "Delegation 不存在"),
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    if matches!(
        delegation.status,
        DelegationStatus::Completed | DelegationStatus::Failed | DelegationStatus::Cancelled
    ) {
        return error_response(
            StatusCode::CONFLICT,
            format!(
                "Delegation 已处于终态 '{}'，不能取消",
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
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if let Some(session_id) = query.session_id.as_deref() {
        let principal = match request_principal(&state, &headers, query.principal_id.as_deref()) {
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
    } else if state.identity.mode == ServerIdentityMode::TrustedGateway
        && query.principal_id.is_some()
    {
        return error_response(
            StatusCode::BAD_REQUEST,
            "Principal 订阅必须同时指定 session_id",
        );
    }
    ws.on_upgrade(|socket| handle_ws(socket, state, query.session_id))
}

fn is_authorized(state: &AppState, headers: &HeaderMap, query_token: Option<&str>) -> bool {
    token_is_authorized(state.auth_token.as_deref(), headers, query_token)
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
    // Provider deltas, model-attempt snapshots and Context Inspect are
    // observability data, not user activity. Replaying them in the Dashboard
    // must not make an otherwise inactive Session look active.
    !matches!(
        event.topic.as_str(),
        "runtime/model_stream"
            | "runtime/model_reasoning_summary"
            | "runtime/model_usage"
            | "runtime/model_attempt_state"
            | "runtime/model_attempt_snapshot"
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
                    "事件路由拒绝：Session '{}' 属于 Context '{}'，事件声明 '{}'",
                    session_id, existing.context_id, declared_context_id
                )
                .into());
            }
        }
        return Ok(());
    }

    if identity_mode == ServerIdentityMode::TrustedGateway {
        return Err(
            format!("可信 Gateway 模式拒绝从事件隐式创建未知 Session '{session_id}'").into(),
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
                        "默认认知 Context".to_string()
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

async fn handle_ws(mut socket: WebSocket, state: Arc<AppState>, session_filter: Option<String>) {
    let mut rx = state.broadcast_tx.subscribe();

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
                tracing::warn!(session_id, %error, "重建 Model Attempt WebSocket 快照失败");
            }
        }
    }

    // 将 EventBus 的广播转发至 WebSocket；同时保持连接心跳。
    loop {
        tokio::select! {
            // 从广播信道接收新事件，实时推回浏览器
            broadcast_msg = rx.recv() => {
                match broadcast_msg {
                    Ok(ev) => {
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
                        tracing::warn!(skipped, "Dashboard WebSocket 已丢失事件，关闭连接以重新同步");
                        break;
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        break;
                    }
                }
            }
            // 接收浏览器发来的信息（仅为保持连接或排查日志）
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(WsMessage::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => {} // 忽略正常的心跳或消息
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
        .ok_or_else(|| format!("Session '{session_id}' 不存在"))?;
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
                "thread_kind": event.payload.get("thread_kind"),
                "state": event.payload.get("state"),
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
        Client, Message, ModelStreamEvent, ModelStreamSender, PromptTokenCount, ReasoningEffort,
        Response, ToolDefinition,
    };
    use crate::memory::{ScheduleStore as _, ThreadStore as _};
    use crate::runtime::{RuntimeIdentity, RuntimeToolPolicy};
    use tempfile::NamedTempFile;

    #[derive(Default)]
    struct ReplyClient {
        reasoning_effort: std::sync::RwLock<Option<ReasoningEffort>>,
    }

    #[async_trait::async_trait]
    impl Client for ReplyClient {
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

    async fn test_state_at(path: &std::path::Path) -> (Arc<AppState>, MorphzRuntime) {
        let runtime =
            MorphzRuntime::builder(AppConfig::default(), Arc::new(ReplyClient::default()))
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
                .build()
                .await
                .unwrap();
        runtime.start().await.unwrap();
        let (broadcast_tx, _) = broadcast::channel(32);
        let sdk = MorphzSdk::new(runtime.clone());
        (
            Arc::new(AppState {
                runtime: runtime.clone(),
                sdk,
                broadcast_tx,
                auth_token: None,
                default_agent_id: "agent-test".to_string(),
                default_context_id: "context-test".to_string(),
                identity: ServerIdentityConfig::default(),
            }),
            runtime,
        )
    }

    async fn test_state() -> (Arc<AppState>, MorphzRuntime) {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        drop(tmp);
        test_state_at(&path).await
    }

    #[test]
    fn dashboard_auth_accepts_local_no_token_mode() {
        assert!(token_is_authorized(None, &HeaderMap::new(), None));
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
            State(state),
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

        let context_inspect = Event::new(
            "context-inspect-test".to_string(),
            "System-ContextKernel".to_string(),
            crate::event::TYPE_PROPOSAL.to_string(),
            "chat/context_inspect".to_string(),
            serde_json::Map::new(),
        );
        assert!(!dashboard_event_requires_session_touch(&context_inspect));

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
        let state = |id: &str, attempt: &str, activation: &str, value: &str, terminal: bool| {
            Event::new(
                id.to_string(),
                "Runtime-Test".to_string(),
                "runtime_control".to_string(),
                "runtime/model_attempt_state".to_string(),
                [
                    ("attempt_id".to_string(), json!(attempt)),
                    ("activation_id".to_string(), json!(activation)),
                    ("thread_kind".to_string(), json!("dialogue_turn")),
                    ("state".to_string(), json!(value)),
                    ("terminal".to_string(), json!(terminal)),
                ]
                .into_iter()
                .collect(),
            )
        };
        let active = HashSet::from(["activation-live".to_string()]);
        let attempts = fold_active_model_attempts(
            vec![
                state("1", "attempt-live", "activation-live", "queued", false),
                state(
                    "2",
                    "attempt-live",
                    "activation-live",
                    "waiting_final_output",
                    false,
                ),
                state("3", "attempt-done", "activation-live", "completed", true),
                state("4", "attempt-stale", "activation-stale", "streaming", false),
            ],
            &active,
        );

        assert_eq!(attempts.len(), 1);
        assert_eq!(attempts[0].get("attempt_id"), Some(&json!("attempt-live")));
        assert_eq!(
            attempts[0].get("state"),
            Some(&json!("waiting_final_output"))
        );
    }

    #[test]
    fn embedded_dashboard_assets_form_a_self_contained_entrypoint() {
        let index = std::str::from_utf8(DASHBOARD_INDEX).unwrap();
        assert!(index.contains("/assets/app.js"));
        assert!(index.contains("/assets/app.css"));
        assert!(!DASHBOARD_APP_JS.is_empty());
        assert!(!DASHBOARD_APP_CSS.is_empty());
        assert!(std::str::from_utf8(DASHBOARD_FAVICON)
            .unwrap()
            .contains("<svg"));
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
            auth_token: Some("gateway-secret".to_string()),
            default_agent_id: "agent-test".to_string(),
            default_context_id: "context-test".to_string(),
            identity: ServerIdentityConfig {
                mode: ServerIdentityMode::TrustedGateway,
                provider_id: "morphz-site".to_string(),
                service_token_env: "MORPHZ_API_TOKEN".to_string(),
            },
        });

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
                text: "I am user 1".to_string(),
                client_message_id: Some("forged-identity-message".to_string()),
                harness: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(foreign_send.status(), StatusCode::FORBIDDEN);
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
            auth_token: Some("gateway-secret".to_string()),
            default_agent_id: "agent-test".to_string(),
            default_context_id: "context-test".to_string(),
            identity: ServerIdentityConfig {
                mode: ServerIdentityMode::TrustedGateway,
                provider_id: "morphz-site".to_string(),
                service_token_env: "MORPHZ_API_TOKEN".to_string(),
            },
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
    async fn dashboard_reasoning_control_changes_only_subsequent_runtime_requests() {
        let (state, runtime) = test_state().await;
        let response = handle_update_inference(
            State(state),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(UpdateInferenceRequest {
                reasoning_effort: Some("none".to_string()),
            }),
        )
        .await
        .into_response();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(runtime.reasoning_effort(), Some(ReasoningEffort::Off));
        assert_eq!(runtime.config().llm.reasoning_effort, None);
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

        for expected_status in [StatusCode::ACCEPTED, StatusCode::OK] {
            let response = handle_send_message(
                State(Arc::clone(&state)),
                Path("api-session".to_string()),
                HeaderMap::new(),
                Query(AuthQuery::default()),
                Json(SendMessageRequest {
                    text: "hello".to_string(),
                    client_message_id: Some("client-message-1".to_string()),
                    harness: None,
                }),
            )
            .await
            .into_response();
            assert_eq!(response.status(), expected_status);
        }

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
                text: "stream please".to_string(),
                client_message_id: Some("stream-message-1".to_string()),
                harness: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::ACCEPTED);

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
                text: "persist summary".to_string(),
                client_message_id: Some("summary-restart-message".to_string()),
                harness: None,
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
            .expect("restarted Runtime must recover the reasoning summary from the Ledger");
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
        assert!(scheduler_json["admission"].is_object());
        assert!(scheduler_json["model_provider"].is_object());
        assert!(scheduler_json["context_capacity"].is_object());

        let ledger = handle_query_ledger(
            State(Arc::clone(&state)),
            Path("context-test".to_string()),
            HeaderMap::new(),
            Query(LedgerHttpQuery {
                token: None,
                session_id: Some("api-observability-session".to_string()),
                limit: Some(50),
                ..LedgerHttpQuery::default()
            }),
        )
        .await
        .into_response();
        assert_eq!(ledger.status(), StatusCode::OK);
        let ledger_body = axum::body::to_bytes(ledger.into_body(), usize::MAX)
            .await
            .unwrap();
        let ledger_json: serde_json::Value = serde_json::from_slice(&ledger_body).unwrap();
        assert_eq!(ledger_json["context_id"], json!("context-test"));
        assert!(ledger_json["events"].is_array());
        assert!(ledger_json["scanned_count"].is_number());

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
        assert_eq!(status_json["model"], json!("gpt-4o-mini"));
        assert_eq!(status_json["storage_backend"], json!("sqlite"));
        assert!(status_json["git_commit"].is_string());
        assert!(status_json["uptime_seconds"].is_number());
        assert!(status_json["recovery"].is_object());
    }

    #[tokio::test]
    async fn ledger_query_returns_the_latest_page_and_pages_backward_without_overlap() {
        let (_, runtime) = test_state().await;
        for index in 1..=5 {
            runtime
                .publish(Event::new(
                    format!("ledger-page-{index}"),
                    "Ledger-Pagination-Test".to_string(),
                    "ledger_test".to_string(),
                    "test/ledger-pagination".to_string(),
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
            .query_ledger(LedgerQuery {
                context_id: "context-test".to_string(),
                actor: Some("Ledger-Pagination-Test".to_string()),
                limit: 2,
                ..LedgerQuery::default()
            })
            .await
            .unwrap();
        assert_eq!(
            latest
                .events
                .iter()
                .map(|event| event.id.as_str())
                .collect::<Vec<_>>(),
            vec!["ledger-page-4", "ledger-page-5"]
        );
        let older_cursor = latest
            .next_before_sequence
            .expect("an older page must exist");

        let older = runtime
            .query_ledger(LedgerQuery {
                context_id: "context-test".to_string(),
                actor: Some("Ledger-Pagination-Test".to_string()),
                before_sequence: Some(older_cursor),
                limit: 2,
                ..LedgerQuery::default()
            })
            .await
            .unwrap();
        assert_eq!(
            older
                .events
                .iter()
                .map(|event| event.id.as_str())
                .collect::<Vec<_>>(),
            vec!["ledger-page-2", "ledger-page-3"]
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
            })
            .await
            .unwrap();
        let schedule = store
            .ensure_schedule(NewSchedule {
                id: "api-schedule".to_string(),
                thread_id: thread.id,
                source_turn_id: "api-schedule-turn".to_string(),
                intent: "continue later".to_string(),
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
        // deliberately outside the Ledger/Mind commit transaction.
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
                query: "阳光电源".to_string(),
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
        assert_eq!(matches.len(), 2);
        assert!(matches
            .iter()
            .all(|hit| hit["session_id"] == "dialogue-search-session"));
        assert!(matches
            .iter()
            .any(|hit| hit["kind"] == "user" && hit["event_id"] == "dialogue-search-user"));
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
        // immutable Ledger sequence, not by wall-clock date or arbitrary
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
