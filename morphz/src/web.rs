use crate::approval::ApprovalDecision;
use crate::event::Event;
use crate::memory::{
    DelegationStatus, NewAgent, NewCognitiveContext, NewSession, QueryFilter, SessionMountKind,
    SessionStatus, SessionUpdate,
};
use crate::runtime::MorphzRuntime;
use axum::{
    extract::{
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{header, HeaderMap, Method, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde_json::json;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;

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
    context_id: Option<String>,
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

#[derive(Default, serde::Deserialize)]
struct EventQuery {
    token: Option<String>,
    after_sequence: Option<u64>,
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
        let broadcast_tx_clone = self.broadcast_tx.clone();
        let runtime = self.runtime.clone();
        let default_agent_id = self.default_agent_id.clone();

        // 通过 Runtime 事件流将所有事件分发给各 WebSocket 客户端。
        let mut events = self.runtime.subscribe("*", 1024);
        tokio::spawn(async move {
            while let Some(ev) = events.recv().await {
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
            auth_token: std::env::var("MORPHZ_DASHBOARD_TOKEN")
                .ok()
                .filter(|token| !token.trim().is_empty()),
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
                Method::OPTIONS,
            ])
            .allow_headers(vec![header::CONTENT_TYPE, header::AUTHORIZATION]);

        let app = Router::new()
            .route("/health", get(|| async { StatusCode::OK }))
            .route(
                "/api/agents",
                get(handle_list_agents).post(handle_create_agent),
            )
            .route(
                "/api/contexts",
                get(handle_list_contexts).post(handle_create_context),
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
                "/api/delegations/:delegation_id",
                get(handle_get_delegation),
            )
            .route(
                "/api/delegations/:delegation_id/cancel",
                post(handle_cancel_delegation),
            )
            .route("/api/approvals", get(handle_list_approvals))
            .route("/api/approvals/:approval_id", post(handle_decide_approval))
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

async fn handle_list_approvals(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    Json(json!({ "approvals": state.runtime.pending_approvals() })).into_response()
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
    match state.runtime.decide_approval(&approval_id, decision) {
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
    legacy_context_id: Option<String>,
    requested_agent_id: Option<String>,
    mount: Option<ContextMountRequest>,
) -> Result<ResolvedMount, (StatusCode, String)> {
    if legacy_context_id.is_some() && mount.is_some() {
        return Err((
            StatusCode::BAD_REQUEST,
            "context_id 与 mount 不能同时提供".to_string(),
        ));
    }
    let agent_was_explicit = requested_agent_id.is_some();
    let requested_agent_id = requested_agent_id.unwrap_or_else(|| state.default_agent_id.clone());
    if let Err(error) = validate_identifier("agent_id", &requested_agent_id) {
        return Err((StatusCode::BAD_REQUEST, error));
    }
    match mount {
        None | Some(ContextMountRequest::ExistingContext { .. }) => {
            let context_id = match mount {
                Some(ContextMountRequest::ExistingContext { context_id }) => context_id,
                _ => legacy_context_id.unwrap_or_else(|| state.default_context_id.clone()),
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
    let mount =
        match resolve_context_mount(&state, request.context_id, request.agent_id, request.mount)
            .await
        {
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
    match state
        .runtime
        .query_events(QueryFilter {
            session_id: Some(session_id),
            ..QueryFilter::default()
        })
        .await
    {
        Ok(mut events) => {
            if let Some(after) = query.after_sequence {
                events.retain(|event| event.sequence.is_some_and(|sequence| sequence > after));
                events.truncate(limit);
            } else if events.len() > limit {
                events.drain(..events.len() - limit);
            }
            Json(json!({ "events": events })).into_response()
        }
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
    let was_running = state.runtime.cancel_session(&delegation.child_session_id);
    match state
        .runtime
        .update_delegation_status(&delegation_id, DelegationStatus::Cancelled, None)
        .await
    {
        Ok(Some(updated)) => Json(json!({
            "cancelled": true,
            "was_running": was_running,
            "delegation": updated
        }))
        .into_response(),
        Ok(None) => error_response(StatusCode::NOT_FOUND, "Delegation 不存在"),
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

async fn handle_ws(mut socket: WebSocket, state: Arc<AppState>, session_filter: Option<String>) {
    let mut rx = state.broadcast_tx.subscribe();

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
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // 缓冲区滞后，忽略继续
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AppConfig;
    use crate::llm::{Client, Message, Response, ToolCallRepr, ToolDefinition};
    use crate::runtime::{RuntimeIdentity, RuntimeToolPolicy};
    use tempfile::NamedTempFile;

    struct ReplyClient;

    #[async_trait::async_trait]
    impl Client for ReplyClient {
        async fn create_completion(
            &self,
            _messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
        ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
            Ok(Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: "session-api-reply-call".to_string(),
                    r#type: "function".to_string(),
                    func_name: "reply".to_string(),
                    arguments: json!({
                        "disposition": "deliver",
                        "content": "session-api-reply"
                    })
                    .to_string(),
                }],
            })
        }
    }

    async fn test_state() -> (Arc<AppState>, MorphzRuntime) {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        drop(tmp);
        let runtime = MorphzRuntime::builder(AppConfig::default(), Arc::new(ReplyClient))
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

    #[test]
    fn dashboard_auth_accepts_local_no_token_mode() {
        assert!(token_is_authorized(None, &HeaderMap::new(), None));
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
    async fn session_message_endpoint_is_idempotent_and_routes_to_session() {
        let (state, runtime) = test_state().await;
        let create = handle_create_session(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Query(AuthQuery::default()),
            Json(CreateSessionRequest {
                id: Some("api-session".to_string()),
                agent_id: None,
                context_id: None,
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
                context_id: None,
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
                context_id: None,
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
