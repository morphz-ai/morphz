use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Message {
    pub role: String, // system, user, assistant, tool
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>, // 对应 tool 消息的工具名称
    #[serde(rename = "tool_call_id", skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>, // 对应 tool 消息的 ToolCall ID
    #[serde(rename = "tool_calls", skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>, // 对应 assistant 消息的工具调用请求
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub r#type: String,
    pub function: FunctionCall,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FunctionCall {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: JsonValue, // JSON Schema 对应的对象
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Response {
    pub content: String,
    pub tool_calls: Vec<crate::llm::ToolCallRepr>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolCallRepr {
    pub id: String,
    pub r#type: String,
    pub func_name: String,
    pub arguments: String,
}

#[async_trait::async_trait]
pub trait Client: Send + Sync {
    async fn create_completion(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>>;

    async fn create_embedding(
        &self,
        text: &str,
    ) -> Result<Vec<f32>, Box<dyn std::error::Error + Send + Sync>>;
}

pub struct OpenAIClient {
    http_client: reqwest::Client,
    api_key: String,
    base_url: String,
    model_name: String,
    embedding_model: String,
    local_model: Option<Arc<executor::ModelStore>>,
}

impl OpenAIClient {
    pub fn new(
        api_key: String,
        mut base_url: String,
        model_name: String,
        local_model: Option<Arc<executor::ModelStore>>,
    ) -> Self {
        if !base_url.is_empty() {
            if !base_url.ends_with("/v1") && !base_url.ends_with("/v1/") {
                base_url = base_url.trim_end_matches('/').to_string() + "/v1";
            }
        } else {
            base_url = "https://api.openai.com/v1".to_string();
        }

        let embedding_model = std::env::var("OPENAI_EMBEDDING_MODEL")
            .unwrap_or_else(|_| "text-embedding-3-small".to_string());

        Self {
            http_client: reqwest::Client::new(),
            api_key,
            base_url,
            model_name,
            embedding_model,
            local_model,
        }
    }
}

// 定义 OpenAI 接口映射结构
#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatReqMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<ChatReqTool>>,
}

#[derive(Serialize)]
struct ChatReqMessage {
    role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(rename = "tool_call_id", skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
    #[serde(rename = "tool_calls", skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<ToolCall>>,
}

#[derive(Serialize)]
struct ChatReqTool {
    r#type: String,
    function: ChatReqFunction,
}

#[derive(Serialize)]
struct ChatReqFunction {
    name: String,
    description: String,
    parameters: JsonValue,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatRespMessage,
}

#[derive(Deserialize)]
struct ChatRespMessage {
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<ToolCall>,
}

#[derive(Serialize)]
struct EmbedRequest {
    input: Vec<String>,
    model: String,
}

#[derive(Deserialize)]
struct EmbedResponse {
    data: Vec<EmbedData>,
}

#[derive(Deserialize)]
struct EmbedData {
    embedding: Vec<f32>,
}

#[async_trait::async_trait]
impl Client for OpenAIClient {
    async fn create_completion(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        let req_messages = messages
            .into_iter()
            .map(|m| ChatReqMessage {
                role: m.role,
                content: Some(m.content),
                name: m.name,
                tool_call_id: m.tool_call_id,
                tool_calls: m.tool_calls,
            })
            .collect();

        let req_tools = if tools.is_empty() {
            None
        } else {
            Some(
                tools
                    .into_iter()
                    .map(|t| ChatReqTool {
                        r#type: "function".to_string(),
                        function: ChatReqFunction {
                            name: t.name,
                            description: t.description,
                            parameters: t.parameters,
                        },
                    })
                    .collect(),
            )
        };

        let request_payload = ChatRequest {
            model: self.model_name.clone(),
            messages: req_messages,
            tools: req_tools,
        };

        let url = format!("{}/chat/completions", self.base_url);
        let resp = self
            .http_client
            .post(&url)
            .bearer_auth(&self.api_key)
            .json(&request_payload)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let err_text = resp.text().await?;
            let mut extra_tip = "";
            if status.as_u16() == 400 || err_text.contains("INVALID_ARGUMENT") {
                extra_tip = "\n💡 [排查建议] 400 INVALID_ARGUMENT 错误通常是由于在自定义 API 代理上请求了不支持的模型名称造成的。请确认您的 .env 文件中 OPENAI_MODEL 配置是否与代理端点匹配。";
            }
            return Err(format!("HTTP {} - {}{}", status, err_text, extra_tip).into());
        }

        let chat_resp: ChatResponse = resp.json().await?;
        let choice = chat_resp
            .choices
            .first()
            .ok_or("Empty choices in chat response")?;

        let content = choice.message.content.clone().unwrap_or_default();
        let tool_calls = choice
            .message
            .tool_calls
            .iter()
            .map(|tc| ToolCallRepr {
                id: tc.id.clone(),
                r#type: tc.r#type.clone(),
                func_name: tc.function.name.clone(),
                arguments: tc.function.arguments.clone(),
            })
            .collect();

        Ok(Response { content, tool_calls })
    }

    async fn create_embedding(
        &self,
        text: &str,
    ) -> Result<Vec<f32>, Box<dyn std::error::Error + Send + Sync>> {
        // Level 1: 优先尝试官方远程 API
        let request_payload = EmbedRequest {
            input: vec![text.to_string()],
            model: self.embedding_model.clone(),
        };

        let url = format!("{}/embeddings", self.base_url);
        let remote_res = self
            .http_client
            .post(&url)
            .bearer_auth(&self.api_key)
            .json(&request_payload)
            .send()
            .await;

        if let Ok(resp) = remote_res {
            if resp.status().is_success() {
                if let Ok(embed_resp) = resp.json::<EmbedResponse>().await {
                    if let Some(data) = embed_resp.data.first() {
                        return Ok(data.embedding.clone());
                    }
                }
            }
        }

        // Level 2 [Fallback]: 内存直接调用本地高精度 BGE 向量生成（消除了本地网络调用开销）
        if let Some(ref local_store) = self.local_model {
            if let Ok(local_vec) = executor::compute_embedding(local_store, text) {
                return Ok(local_vec);
            }
        }

        // Level 3 [Fallback]: 极简本地 N-Gram Hashing 向量
        Ok(local_hashing_embedding(text))
    }
}

pub fn local_hashing_embedding(text: &str) -> Vec<f32> {
    let text = text.to_lowercase();
    let mut clean_chars = Vec::new();
    for c in text.chars() {
        if c.is_ascii_alphanumeric() || (c as u32 >= 0x4e00 && c as u32 <= 0x9fff) || c == '(' || c == ')' {
            clean_chars.push(c);
        } else {
            clean_chars.push(' ');
        }
    }
    let cleaned: String = clean_chars.into_iter().collect();
    let words: Vec<&str> = cleaned.split_whitespace().collect();

    const DIMENSION: usize = 256;
    let mut vec = vec![0.0f32; DIMENSION];

    let mut add_hash = |term: &[u8]| {
        let mut h: u32 = 0;
        for &b in term {
            h = h.wrapping_mul(31).wrapping_add(b as u32);
        }
        let idx = (h as usize) % DIMENSION;
        vec[idx] += 1.0;
    };

    for w in words {
        let w_bytes = w.as_bytes();
        add_hash(w_bytes);
        if w_bytes.len() > 2 {
            for i in 0..w_bytes.len() - 1 {
                add_hash(&w_bytes[i..i + 2]);
            }
        }
    }

    let sum_sq: f32 = vec.iter().map(|&x| x * x).sum();
    if sum_sq > 0.0 {
        let norm = sum_sq.sqrt();
        for x in vec.iter_mut() {
            *x /= norm;
        }
    }
    vec
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_local_hashing_embedding() {
        let vec1 = local_hashing_embedding("中文测试语句");
        let vec2 = local_hashing_embedding("中文测试语句");
        let vec3 = local_hashing_embedding("完全不一样的英文");

        assert_eq!(vec1.len(), 256);
        assert_eq!(vec1, vec2);
        assert_ne!(vec1, vec3);
    }
}
