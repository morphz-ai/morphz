use axum::{routing::post, Json, Router, extract::State};
use candle_core::{DType, Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::bert::{BertModel, Config};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::path::Path;
use tokenizers::Tokenizer;

struct ModelStore {
    model: BertModel,
    tokenizer: Tokenizer,
    device: Device,
}

// 采用 Arc<Option<ModelStore>>，即使模型未就绪，服务也可以正常启动监听，并在请求时返回友好提示
type AppState = Arc<Option<ModelStore>>;

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
    // 1. 初始化并加载 BERT 模型
    let model_store = match load_model() {
        Ok(store) => {
            println!("⚙️ [Rust Executor] BGE 语义模型加载成功，处于就绪状态。");
            Some(store)
        }
        Err(e) => {
            eprintln!("⚠️ [Rust Executor] 模型加载失败: {e}");
            eprintln!("💡 [排查建议] 请确保本地模型文件齐全：");
            eprintln!("   路径: models/bge-small-zh-1.5/");
            eprintln!("   文件: model.safetensors (或 pytorch_model.bin), config.json, tokenizer.json");
            eprintln!("   服务将在未加载模型的状态下启动，并在请求时返回软降级错误，不会导致控制端崩溃。");
            None
        }
    };

    let state: AppState = Arc::new(model_store);

    // 2. 构建 Axum 路由
    let app = Router::new()
        .route("/embed", post(handle_embed))
        .with_state(state);

    // 3. 绑定 TCP Loopback 监听 (127.0.0.1:8085)
    let addr = "127.0.0.1:8085";
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("❌ [Rust Executor] 绑定端口 {addr} 失败: {e}");
            return;
        }
    };

    println!("⚙️ [Rust Executor] 本地 HTTP 推理服务已启动，监听: {}", addr);

    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("❌ [Rust Executor] Axum 服务运行出错: {e}");
    }
}

fn load_model() -> Result<ModelStore, Box<dyn std::error::Error>> {
    let model_dir = Path::new("models/bge-small-zh-1.5");
    let config_path = model_dir.join("config.json");
    let tokenizer_path = model_dir.join("tokenizer.json");

    if !config_path.exists() || !tokenizer_path.exists() {
        return Err(format!("缺失配置文件 {} 或 {}", config_path.display(), tokenizer_path.display()).into());
    }

    // 1. 读取并解析 Config
    let config_str = std::fs::read_to_string(&config_path)?;
    let config: Config = serde_json::from_str(&config_str)?;

    // 2. 读取 Tokenizer
    let tokenizer = Tokenizer::from_file(&tokenizer_path)
        .map_err(|e| format!("加载 tokenizer.json 失败: {e}"))?;

    // 3. 寻找权重文件 (safetensors 优先，bin 兜底)
    let device = Device::Cpu;
    let safetensors_path = model_dir.join("model.safetensors");
    let bin_path = model_dir.join("pytorch_model.bin");

    let vb = if safetensors_path.exists() {
        unsafe { VarBuilder::from_mmaped_safetensors(&[safetensors_path], DType::F32, &device)? }
    } else if bin_path.exists() {
        VarBuilder::from_pth(&bin_path, DType::F32, &device)?
    } else {
        return Err(format!("未在 models/bge-small-zh-1.5/ 找到 model.safetensors 或 pytorch_model.bin").into());
    };

    // 4. 加载 BertModel
    let model = BertModel::load(vb, &config)?;

    Ok(ModelStore {
        model,
        tokenizer,
        device,
    })
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
                error: Some("本地 BGE 语义模型未加载，请检查 models/ 目录下的权重文件。".to_string()),
            });
        }
    };

    match compute_embedding(store, &payload.text) {
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

fn compute_embedding(store: &ModelStore, text: &str) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
    // 1. 词例化
    let tokens = store.tokenizer.encode(text, true)
        .map_err(|e| format!("分词失败: {e}"))?;
    
    let ids = tokens.get_ids();
    let token_len = ids.len();
    if token_len == 0 {
        return Err("输入文本分词后为空".into());
    }

    // 2. 将数据转为 Tensor [batch=1, seq_len]
    let input_ids = Tensor::new(ids, &store.device)?.unsqueeze(0)?;
    
    // token_type_ids: 单句全是 0
    let token_type_ids = Tensor::zeros((1, token_len), DType::U32, &store.device)?;

    // 3. BERT 前向传递
    let sequence_output = store.model.forward(&input_ids, &token_type_ids)?;

    // sequence_output 形状: [1, seq_len, hidden_size]
    // 4. Mean Pooling (对维度 1 沿着 Token 长度方向求平均)
    let mean_embedding = sequence_output.mean(1)?.squeeze(0)?; // 形状变回 [hidden_size]

    // 5. L2 归一化 (使得向量点积直接等于余弦相似度)
    // 归一化公式: v / sqrt(sum(v_i^2))
    let sqr = mean_embedding.sqr()?;
    let sum = sqr.sum(0)?;
    let norm = sum.sqrt()?;
    let normalized = mean_embedding.broadcast_div(&norm)?;

    // 6. 转为 Vec 并返回
    let res = normalized.to_vec1::<f32>()?;
    Ok(res)
}
