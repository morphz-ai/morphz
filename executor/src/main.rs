use axum::{extract::State, routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

// Use `Arc<Option<ModelStore>>` so the service can listen before the model is ready and return a
// helpful response when requests arrive.
type AppState = Arc<Option<executor::ModelStore>>;

#[derive(Deserialize)]
struct EmbedRequest {
    text: String,
}

#[derive(Serialize)]
struct EmbedResponse {
    embedding: Option<Vec<f32>>,
    error: Option<String>,
}

#[tokio::main]
async fn main() {
    // 1. Initialize and load the BERT model.
    let model_store = match executor::load_model() {
        Ok(store) => {
            println!("⚙️ [Rust Executor] BGE 语义模型加载成功，处于就绪状态。");
            Some(store)
        }
        Err(e) => {
            eprintln!("⚠️ [Rust Executor] 模型加载失败: {e}");
            eprintln!("💡 [排查建议] 请确保本地模型文件齐全：");
            eprintln!("   路径: models/bge-small-zh-1.5/");
            eprintln!(
                "   文件: model.safetensors (或 pytorch_model.bin), config.json, tokenizer.json"
            );
            eprintln!(
                "   服务将在未加载模型的状态下启动，并在请求时返回软降级错误，不会导致控制端崩溃。"
            );
            None
        }
    };

    let state: AppState = Arc::new(model_store);

    // 2. Build the Axum router.
    let app = Router::new()
        .route("/embed", post(handle_embed))
        .with_state(state);

    // 3. Bind the TCP loopback listener (`127.0.0.1:8085`).
    let addr = "127.0.0.1:8085";
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("❌ [Rust Executor] 绑定端口 {addr} 失败: {e}");
            return;
        }
    };

    println!(
        "⚙️ [Rust Executor] 本地 HTTP 推理服务已启动，监听: {}",
        addr
    );

    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("❌ [Rust Executor] Axum 服务运行出错: {e}");
    }
}

async fn handle_embed(
    State(state): State<AppState>,
    Json(payload): Json<EmbedRequest>,
) -> Json<EmbedResponse> {
    let store = match state.as_ref() {
        Some(s) => s,
        None => {
            return Json(EmbedResponse {
                embedding: None,
                error: Some(
                    "本地 BGE 语义模型未加载，请检查 models/ 目录下的权重文件。".to_string(),
                ),
            });
        }
    };

    match executor::compute_embedding(store, &payload.text) {
        Ok(vec) => Json(EmbedResponse {
            embedding: Some(vec),
            error: None,
        }),
        Err(e) => Json(EmbedResponse {
            embedding: None,
            error: Some(format!("计算向量失败: {e}")),
        }),
    }
}
