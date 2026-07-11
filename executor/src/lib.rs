use candle_core::{DType, Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::bert::{BertModel, Config};
use std::path::Path;
use tokenizers::Tokenizer;

pub struct ModelStore {
    pub model: BertModel,
    pub tokenizer: Tokenizer,
    pub device: Device,
}

pub fn load_model() -> Result<ModelStore, Box<dyn std::error::Error>> {
    let model_dir = Path::new("models/bge-small-zh-1.5");
    let config_path = model_dir.join("config.json");
    let tokenizer_path = model_dir.join("tokenizer.json");

    if !config_path.exists() || !tokenizer_path.exists() {
        return Err(format!(
            "缺失配置文件 {} 或 {}",
            config_path.display(),
            tokenizer_path.display()
        )
        .into());
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
        return Err(
            "未在 models/bge-small-zh-1.5/ 找到 model.safetensors 或 pytorch_model.bin"
                .to_string()
                .into(),
        );
    };

    // 4. 加载 BertModel
    let model = BertModel::load(vb, &config)?;

    Ok(ModelStore {
        model,
        tokenizer,
        device,
    })
}

pub fn compute_embedding(
    store: &ModelStore,
    text: &str,
) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
    // 1. 词例化
    let tokens = store
        .tokenizer
        .encode(text, true)
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
    let sequence_output = store.model.forward(&input_ids, &token_type_ids, None)?;

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
