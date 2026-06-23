use crate::event::{Event, InMemoryEventBus};
use crate::memory::GraphStore;
use axum::{
    extract::{ws::{Message as WsMessage, WebSocket, WebSocketUpgrade}, State},
    http::{Method, StatusCode},
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
}

impl Server {
    pub fn new(
        store: Arc<dyn crate::memory::EventStore>,
        graph_store: Option<Arc<dyn GraphStore>>,
        bus: Arc<InMemoryEventBus>,
    ) -> Self {
        // 创建一个容量为 1000 的广播通道
        let (broadcast_tx, _) = broadcast::channel(1000);

        Self {
            store,
            graph_store,
            bus,
            broadcast_tx,
        }
    }

    pub async fn start(&self, addr_str: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
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
        });

        // 跨域支持 (CORS)
        let cors = CorsLayer::new()
            .allow_origin(tower_http::cors::Any)
            .allow_methods(vec![Method::GET, Method::POST, Method::OPTIONS])
            .allow_headers(vec![axum::http::header::CONTENT_TYPE]);

        let app = Router::new()
            .route("/api/graph", get(handle_get_graph))
            .route("/ws", get(handle_ws_upgrade))
            .layer(cors)
            .with_state(state);

        let addr: SocketAddr = addr_str.parse()?;
        let listener = tokio::net::TcpListener::bind(addr).await?;
        println!("🌐 [Web Server] Dashboard API Server 启动成功，监听地址: http://{}", addr);

        tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, app).await {
                eprintln!("❌ [Web Server] Axum 运行出错: {:?}", e);
            }
        });

        Ok(())
    }
}

async fn handle_get_graph(
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let graph_store = match state.graph_store {
        Some(ref gs) => gs,
        None => return (StatusCode::INTERNAL_SERVER_ERROR, "GraphStore not available").into_response(),
    };

    match graph_store.get_all_nodes_and_edges().await {
        Ok((nodes, edges)) => {
            let resp = json!({
                "nodes": nodes,
                "edges": edges,
            });
            Json(resp).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Query error: {:?}", e)).into_response(),
    }
}

async fn handle_ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_ws(socket, state))
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
