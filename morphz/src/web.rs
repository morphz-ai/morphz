use crate::event::{Event, InMemoryEventBus};
use crate::memory::GraphStore;
use axum::{
    extract::{
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{header, HeaderMap, Method, StatusCode},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;

pub struct Server {
    store: Arc<dyn crate::memory::EventStore>,
    graph_store: Option<Arc<dyn GraphStore>>,
    bus: Arc<InMemoryEventBus>,
    broadcast_tx: broadcast::Sender<Event>,
}

struct AppState {
    _store: Arc<dyn crate::memory::EventStore>,
    graph_store: Option<Arc<dyn GraphStore>>,
    broadcast_tx: broadcast::Sender<Event>,
    auth_token: Option<String>,
}

#[derive(Default, serde::Deserialize)]
struct AuthQuery {
    token: Option<String>,
}

impl Server {
    pub fn new(
        store: Arc<dyn crate::memory::EventStore>,
        graph_store: Option<Arc<dyn GraphStore>>,
        bus: Arc<InMemoryEventBus>,
    ) -> Self {
        Self::new_with_capacity(store, graph_store, bus, 1000)
    }

    pub fn new_with_capacity(
        store: Arc<dyn crate::memory::EventStore>,
        graph_store: Option<Arc<dyn GraphStore>>,
        bus: Arc<InMemoryEventBus>,
        broadcast_capacity: usize,
    ) -> Self {
        let (broadcast_tx, _) = broadcast::channel(broadcast_capacity.max(1));

        Self {
            store,
            graph_store,
            bus,
            broadcast_tx,
        }
    }

    pub async fn start(
        &self,
        addr_str: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let broadcast_tx_clone = self.broadcast_tx.clone();

        // 注册 EventBus 拦截订阅：将所有事件通过广播信道分发给各 WebSocket 客户端
        self.bus.subscribe(
            "*".to_string(),
            Arc::new(move |ev| {
                let tx = broadcast_tx_clone.clone();
                Box::pin(async move {
                    let _ = tx.send(ev);
                    Ok(())
                })
            }),
        );

        let state = Arc::new(AppState {
            _store: Arc::clone(&self.store),
            graph_store: self.graph_store.clone(),
            broadcast_tx: self.broadcast_tx.clone(),
            auth_token: std::env::var("MORPHZ_DASHBOARD_TOKEN")
                .ok()
                .filter(|token| !token.trim().is_empty()),
        });

        // 跨域支持 (CORS)
        let cors = CorsLayer::new()
            .allow_origin(tower_http::cors::Any)
            .allow_methods(vec![Method::GET, Method::POST, Method::OPTIONS])
            .allow_headers(vec![header::CONTENT_TYPE, header::AUTHORIZATION]);

        let app = Router::new()
            .route("/health", get(|| async { StatusCode::OK }))
            .route("/api/graph", get(handle_get_graph))
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

async fn handle_get_graph(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let graph_store = match state.graph_store {
        Some(ref gs) => gs,
        None => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "GraphStore not available",
            )
                .into_response()
        }
    };

    match graph_store.get_all_nodes_and_edges().await {
        Ok((nodes, edges)) => {
            let resp = json!({
                "nodes": nodes,
                "edges": edges,
            });
            Json(resp).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Query error: {:?}", e),
        )
            .into_response(),
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
    ws.on_upgrade(|socket| handle_ws(socket, state))
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

async fn handle_ws(mut socket: WebSocket, state: Arc<AppState>) {
    // 1. 刚连接上时，主动推送一次全量图谱给前端渲染
    if let Some(ref graph_store) = state.graph_store {
        if let Ok((nodes, edges)) = graph_store.get_all_nodes_and_edges().await {
            let init_msg = json!({
                "type": "init_graph",
                "nodes": nodes,
                "edges": edges,
            });
            if let Ok(json_str) = serde_json::to_string(&init_msg) {
                if socket.send(WsMessage::Text(json_str)).await.is_err() {
                    return;
                }
            }
        }
    }

    let mut rx = state.broadcast_tx.subscribe();

    // 2. 双工循环：将 EventBus 的广播转发至 WebSocket；同时保持连接心跳
    loop {
        tokio::select! {
            // 从广播信道接收新事件，实时推回浏览器
            broadcast_msg = rx.recv() => {
                match broadcast_msg {
                    Ok(ev) => {
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
}
