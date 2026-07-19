use crate::approval::ApprovalDecision;
use crate::event::Event;
use crate::llm::ReasoningEffort;
use crate::memory::{
    DelegationStatus, NewAgent, NewCognitiveContext, NewSession, ObjectiveMutation,
    ObjectiveStatus, QueryFilter, ScheduleMutation, SessionMountKind, SessionStatus, SessionUpdate,
};
use crate::runtime::{MorphzRuntime, SchedulerQuery};
use axum::{
    body::Body,
    extract::{
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;

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
}

pub struct ServerDefaults {
    pub agent_id: String,
    pub context_id: String,
}

struct AppState {
    runtime: MorphzRuntime,
    broadcast_tx: broadcast::Sender<Event>,
    auth_token: Option<String>,
    default_agent_id: String,
    default_context_id: String,
}

#[derive(Default, serde::Deserialize)]
struct AuthQuery {
    token: Option<String>,
    session_id: Option<String>,
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
struct UpdateSessionRequest {
    title: Option<String>,
    status: Option<SessionStatus>,
}

#[derive(serde::Deserialize)]
struct SendMessageRequest {
    text: String,
    client_message_id: Option<String>,
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

#[derive(Default, serde::Deserialize)]
struct EventQuery {
    token: Option<String>,
    after_sequence: Option<u64>,
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
        }
    }

    pub async fn start(
        &self,
        addr_str: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let auth_token = std::env::var("MORPHZ_DASHBOARD_TOKEN")
            .ok()
            .filter(|token| !token.trim().is_empty());
        self.start_with_dashboard_token(addr_str, auth_token).await
    }

    pub async fn start_with_dashboard_token(
        &self,
        addr_str: &str,
        auth_token: Option<String>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let broadcast_tx_clone = self.broadcast_tx.clone();
        let runtime = self.runtime.clone();
        let default_agent_id = self.default_agent_id.clone();

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
                        let context_id = ev
                            .payload
                            .get("context_id")
                            .and_then(|value| value.as_str())
                            .unwrap_or(session_id)
                            .to_string();
                        let parent_session_id = ev
                            .payload
                            .get("parent_session_id")
                            .and_then(|value| value.as_str())
                            .map(ToOwned::to_owned);
                        if let Some(existing) = runtime.get_session(session_id).await? {
                            if existing.context_id != context_id {
                                return Err(format!(
                                    "事件路由拒绝：Session '{}' 属于 Context '{}'，事件声明 '{}'",
                                    session_id, existing.context_id, context_id
                                )
                                .into());
                            }
                        } else {
                            let agent_id = match runtime.get_context(&context_id).await? {
                                Some(context) => context.agent_id,
                                None => {
                                    runtime
                                        .ensure_context(NewCognitiveContext {
                                            id: context_id.clone(),
                                            agent_id: default_agent_id.clone(),
                                            title: context_id.clone(),
                                        })
                                        .await?;
                                    default_agent_id.clone()
                                }
                            };
                            runtime
                                .ensure_session(NewSession {
                                    id: session_id.to_string(),
                                    agent_id,
                                    context_id,
                                    parent_session_id,
                                    title: session_id.to_string(),
                                    mount_kind: SessionMountKind::ExistingContext,
                                })
                                .await?;
                        }
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
            broadcast_tx: self.broadcast_tx.clone(),
            auth_token: auth_token.filter(|token| !token.trim().is_empty()),
            default_agent_id: self.default_agent_id.clone(),
            default_context_id: self.default_context_id.clone(),
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
            .allow_headers(vec![header::CONTENT_TYPE, header::AUTHORIZATION]);

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
            .route(
                "/api/contexts/:context_id/working-set",
                get(handle_get_context_working_set),
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
                "/api/sessions/:session_id/events",
                get(handle_get_session_events),
            )
            .route(
                "/api/sessions/:session_id/context",
                get(handle_get_session_context),
            )
            .route(
                "/api/sessions/:session_id/cancel",
                post(handle_cancel_session),
            )
            .route("/api/delegations", get(handle_list_delegations))
            .route(
                "/api/objectives/:objective_id/resume",
                post(handle_resume_objective),
            )
            .route(
                "/api/objectives/:objective_id",
                delete(handle_delete_objective),
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
            .layer(cors)
            .with_state(Arc::clone(&state));

        let addr: SocketAddr = addr_str.parse()?;
        if !addr.ip().is_loopback() && state.auth_token.is_none() {
            return Err(
                "非本机监听必须设置 MORPHZ_DASHBOARD_TOKEN，避免事件流和记忆图谱无认证暴露".into(),
            );
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
    Json(json!({
        "agent_id": state.default_agent_id,
        "context_id": state.default_context_id,
        "model": state.runtime.config().llm.model,
        "provider": state.runtime.config().llm.provider,
        "reasoning_effort": state.runtime.reasoning_effort().map(ReasoningEffort::as_str),
        "tool_count": state.runtime.tool_names().len(),
    }))
    .into_response()
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
        "deny" | "reject" => ApprovalDecision::Deny {
            rationale,
            risk_tags: vec!["human-denied".to_string()],
        },
        _ => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "decision 只支持 allow_once 或 deny",
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
    match state
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
        Ok(bundle) => (StatusCode::CREATED, Json(bundle)).into_response(),
        Err(error) => error_response(StatusCode::CONFLICT, error.to_string()),
    }
}

async fn handle_list_sessions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<SessionListQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match state.runtime.list_sessions(query.include_archived).await {
        Ok(sessions) => Json(json!({ "sessions": sessions })).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
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
        .runtime
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
        .runtime
        .create_context(NewCognitiveContext {
            id,
            agent_id,
            title,
        })
        .await
    {
        Ok(context) => (StatusCode::CREATED, Json(context)).into_response(),
        Err(error) => error_response(StatusCode::CONFLICT, error.to_string()),
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
        .runtime
        .create_session(NewSession {
            id,
            agent_id: mount.agent_id,
            context_id: mount.context_id,
            parent_session_id: request.parent_session_id,
            title: bounded_title(request.title, "新会话"),
            mount_kind: mount.mount_kind,
        })
        .await
    {
        Ok(session) => (StatusCode::CREATED, Json(session)).into_response(),
        Err(error) => error_response(StatusCode::CONFLICT, error.to_string()),
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
        .runtime
        .create_session(NewSession {
            id: session_id,
            agent_id: mount.agent_id,
            context_id: mount.context_id,
            parent_session_id: None,
            title: bounded_title(request.session_title, "独立会话"),
            mount_kind: SessionMountKind::NewContextFromMind,
        })
        .await
    {
        Ok(session) => (
            StatusCode::CREATED,
            Json(json!({ "context": context, "session": session, "seed": mount.seed })),
        )
            .into_response(),
        Err(error) => error_response(StatusCode::CONFLICT, error.to_string()),
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
    match state.runtime.get_session(&session_id).await {
        Ok(Some(session)) => Json(session).into_response(),
        Ok(None) => error_response(StatusCode::NOT_FOUND, "Session 不存在"),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
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
    let title = request
        .title
        .map(|title| title.trim().chars().take(200).collect::<String>());
    if title.as_deref() == Some("") {
        return error_response(StatusCode::BAD_REQUEST, "title 不能为空");
    }
    match state
        .runtime
        .update_session(
            &session_id,
            SessionUpdate {
                title,
                status: request.status,
            },
        )
        .await
    {
        Ok(Some(session)) => Json(session).into_response(),
        Ok(None) => error_response(StatusCode::NOT_FOUND, "Session 不存在"),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
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
    let session = match state.runtime.get_session(&session_id).await {
        Ok(Some(session)) => session,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "Session 不存在"),
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
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
        .runtime
        .session(session_id)
        .send(request.text, "User-API", Some(client_message_id))
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
        Err(error) => error_response(StatusCode::BAD_REQUEST, error.to_string()),
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
    match state.runtime.get_session(&session_id).await {
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "Session 不存在"),
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        Ok(Some(_)) => {}
    }
    let limit = query.limit.unwrap_or(100).clamp(1, 1_000);
    let filter = if let Some(after_sequence) = query.after_sequence {
        QueryFilter {
            session_id: Some(session_id),
            after_sequence: Some(after_sequence),
            top_k: Some(limit),
            excluded_topics: vec!["chat/context_inspect".to_string()],
            ..QueryFilter::default()
        }
    } else {
        QueryFilter {
            session_id: Some(session_id),
            latest_k: Some(limit),
            excluded_topics: vec!["chat/context_inspect".to_string()],
            ..QueryFilter::default()
        }
    };
    match state.runtime.query_events(filter).await {
        Ok(events) => Json(json!({ "events": events })).into_response(),
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
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let session = match state.runtime.get_session(&session_id).await {
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "Session 不存在"),
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        Ok(Some(session)) => session,
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

async fn handle_cancel_session(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match state.runtime.get_session(&session_id).await {
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "Session 不存在"),
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        Ok(Some(_)) => {}
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
    // Provider deltas and their one-shot durable reasoning-summary snapshot
    // are observability data, not user activity. Replaying either in the
    // Dashboard must not make an otherwise inactive Session look active.
    !matches!(
        event.topic.as_str(),
        "runtime/model_stream"
            | "runtime/model_reasoning_summary"
            | "runtime/model_attempt_state"
            | "runtime/model_attempt_snapshot"
    )
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
        (
            Arc::new(AppState {
                runtime: runtime.clone(),
                broadcast_tx,
                auth_token: None,
                default_agent_id: "agent-test".to_string(),
                default_context_id: "context-test".to_string(),
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
                }),
            )
            .await
            .into_response();
            assert_eq!(response.status(), expected_status);
        }

        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let events = runtime
            .query_events(QueryFilter {
                session_id: Some("api-session".to_string()),
                ..QueryFilter::default()
            })
            .await
            .unwrap();
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
                root_turn_id: "api-schedule-turn".to_string(),
                kind: ThreadKind::Execution,
                executor_kind: "self".to_string(),
                executor_id: None,
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
