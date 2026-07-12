use crate::config::LlmConfig;
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
    max_retries: u32,
    initial_backoff_secs: u64,
    max_output_tokens: Option<u32>,
    local_model: Option<Arc<executor::ModelStore>>,
}

impl OpenAIClient {
    pub fn new(
        api_key: String,
        base_url: String,
        model_name: String,
        local_model: Option<Arc<executor::ModelStore>>,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Self::new_with_config(
            api_key,
            base_url,
            model_name,
            local_model,
            &LlmConfig::default(),
        )
    }

    pub fn new_with_config(
        api_key: String,
        mut base_url: String,
        model_name: String,
        local_model: Option<Arc<executor::ModelStore>>,
        config: &LlmConfig,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        if !base_url.is_empty() {
            if !base_url.ends_with("/v1") && !base_url.ends_with("/v1/") {
                base_url = base_url.trim_end_matches('/').to_string() + "/v1";
            }
        } else {
            base_url = "https://api.openai.com/v1".to_string();
        }

        let embedding_model = std::env::var("OPENAI_EMBEDDING_MODEL")
            .unwrap_or_else(|_| config.embedding_model.clone());

        // reqwest 的 macOS 系统代理自动探测在部分无 GUI/沙箱环境中可能触发
        // system-configuration panic。默认禁用隐式探测；需要代理时使用显式变量。
        let mut client_builder =
            reqwest::Client::builder()
                .no_proxy()
                .timeout(std::time::Duration::from_secs(
                    config.request_timeout_secs.max(1),
                ));
        if let Ok(proxy_url) = std::env::var("OPENAI_HTTP_PROXY") {
            if !proxy_url.trim().is_empty() {
                client_builder = client_builder.proxy(reqwest::Proxy::all(&proxy_url)?);
            }
        }

        Ok(Self {
            http_client: client_builder.build()?,
            api_key,
            base_url,
            model_name,
            embedding_model,
            max_retries: config.max_retries.max(1),
            initial_backoff_secs: config.initial_backoff_secs,
            max_output_tokens: config.max_output_tokens,
            local_model,
        })
    }
}

// 定义 OpenAI 接口映射结构
#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatReqMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<ChatReqTool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
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
    #[serde(default)]
    usage: Option<ChatUsage>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatRespMessage,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct ChatUsage {
    #[serde(default)]
    prompt_tokens: Option<u64>,
    #[serde(default)]
    completion_tokens: Option<u64>,
    #[serde(default)]
    total_tokens: Option<u64>,
    #[serde(default)]
    prompt_tokens_details: Option<PromptTokensDetails>,
}

#[derive(Deserialize)]
struct PromptTokensDetails {
    #[serde(default)]
    cached_tokens: Option<u64>,
}

#[derive(Deserialize)]
struct ChatRespMessage {
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<ToolCall>>,
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
            max_tokens: self.max_output_tokens,
        };

        let url = format!("{}/chat/completions", self.base_url);
        let mut attempts = 0;
        let max_attempts = self.max_retries;
        let mut backoff = std::time::Duration::from_secs(self.initial_backoff_secs);
        let resp = loop {
            attempts += 1;
            let res = self
                .http_client
                .post(&url)
                .bearer_auth(&self.api_key)
                .json(&request_payload)
                .send()
                .await;

            match res {
                Ok(resp) => {
                    let status = resp.status();
                    if status.is_success() {
                        break resp;
                    } else if (status.as_u16() == 429 || status.is_server_error())
                        && attempts < max_attempts
                    {
                        tracing::warn!(status = %status, backoff = ?backoff, attempt = attempts, max = max_attempts, "LLM 客户端遇到错误，准备重试");
                        tokio::time::sleep(backoff).await;
                        backoff *= 2;
                    } else {
                        let err_text = resp.text().await?;
                        let mut extra_tip = "";
                        if status.as_u16() == 400 || err_text.contains("INVALID_ARGUMENT") {
                            extra_tip = "\n💡 [排查建议] 400 INVALID_ARGUMENT 错误通常是由于在自定义 API 代理上请求了不支持的模型名称造成的。请确认您的 .env 文件中 OPENAI_MODEL 配置是否与代理端点匹配。";
                        }
                        return Err(format!("HTTP {} - {}{}", status, err_text, extra_tip).into());
                    }
                }
                Err(e) if attempts < max_attempts => {
                    tracing::warn!(error = ?e, backoff = ?backoff, attempt = attempts, max = max_attempts, "LLM 客户端网络错误，准备重试");
                    tokio::time::sleep(backoff).await;
                    backoff *= 2;
                }
                Err(e) => {
                    return Err(Box::new(e));
                }
            }
        };

        let chat_resp: ChatResponse = resp.json().await?;
        let choice = chat_resp
            .choices
            .first()
            .ok_or("Empty choices in chat response")?;

        let tool_argument_chars = choice
            .message
            .tool_calls
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|call| call.function.arguments.chars().count())
            .collect::<Vec<_>>();
        tracing::info!(
            model = %self.model_name,
            finish_reason = ?choice.finish_reason,
            prompt_tokens = ?chat_resp.usage.as_ref().and_then(|usage| usage.prompt_tokens),
            completion_tokens = ?chat_resp.usage.as_ref().and_then(|usage| usage.completion_tokens),
            total_tokens = ?chat_resp.usage.as_ref().and_then(|usage| usage.total_tokens),
            cached_prompt_tokens = ?chat_resp
                .usage
                .as_ref()
                .and_then(|usage| usage.prompt_tokens_details.as_ref())
                .and_then(|details| details.cached_tokens),
            tool_argument_chars = ?tool_argument_chars,
            "LLM completion 元数据"
        );
        validate_chat_choice(choice)
            .map_err(|error| -> Box<dyn std::error::Error + Send + Sync> { error.into() })?;

        let content = choice.message.content.clone().unwrap_or_default();
        let tool_calls = choice
            .message
            .tool_calls
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|tc| ToolCallRepr {
                id: tc.id.clone(),
                r#type: tc.r#type.clone(),
                func_name: tc.function.name.clone(),
                arguments: tc.function.arguments.clone(),
            })
            .collect();

        Ok(Response {
            content,
            tool_calls,
        })
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
        let mut attempts = 0;
        let max_attempts = self.max_retries;
        let mut backoff = std::time::Duration::from_secs(self.initial_backoff_secs);
        let remote_res = loop {
            attempts += 1;
            let res = self
                .http_client
                .post(&url)
                .bearer_auth(&self.api_key)
                .json(&request_payload)
                .send()
                .await;

            match res {
                Ok(resp) => {
                    let status = resp.status();
                    if status.is_success() {
                        break Ok(resp);
                    } else if (status.as_u16() == 429 || status.is_server_error())
                        && attempts < max_attempts
                    {
                        tracing::warn!(status = %status, backoff = ?backoff, attempt = attempts, max = max_attempts, "Embedding 遇到错误，准备重试");
                        tokio::time::sleep(backoff).await;
                        backoff *= 2;
                    } else {
                        break Ok(resp);
                    }
                }
                Err(e) if attempts < max_attempts => {
                    tracing::warn!(
                        "Embedding 网络错误: {:?}，将在 {:?} 后重试 (第 {}/{} 次尝试)",
                        e,
                        backoff,
                        attempts,
                        max_attempts
                    );
                    tokio::time::sleep(backoff).await;
                    backoff *= 2;
                }
                Err(e) => {
                    break Err(e);
                }
            }
        };

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

fn validate_chat_choice(choice: &ChatChoice) -> Result<(), String> {
    if choice.finish_reason.as_deref() == Some("length") {
        return Err(
            "LLM 响应因输出长度限制而被截断，拒绝将不完整正文或工具参数作为有效结果".to_string(),
        );
    }
    let has_content = choice
        .message
        .content
        .as_deref()
        .is_some_and(|content| !content.trim().is_empty());
    let has_tool_calls = choice
        .message
        .tool_calls
        .as_deref()
        .is_some_and(|calls| !calls.is_empty());
    if !has_content && !has_tool_calls {
        return Err("LLM 响应既没有非空正文，也没有工具调用，不能作为最终回复".to_string());
    }
    Ok(())
}

pub fn local_hashing_embedding(text: &str) -> Vec<f32> {
    let text = text.to_lowercase();
    let mut clean_chars = Vec::new();
    for c in text.chars() {
        if c.is_ascii_alphanumeric()
            || (c as u32 >= 0x4e00 && c as u32 <= 0x9fff)
            || c == '('
            || c == ')'
        {
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

    #[test]
    fn chat_response_accepts_null_tool_calls_from_openai_compatible_proxies() {
        let response: ChatResponse = serde_json::from_value(serde_json::json!({
            "choices": [{
                "message": {
                    "content": "done",
                    "tool_calls": null
                }
            }]
        }))
        .unwrap();
        assert_eq!(response.choices[0].message.content.as_deref(), Some("done"));
        assert!(response.choices[0].message.tool_calls.is_none());
        assert!(validate_chat_choice(&response.choices[0]).is_ok());
    }

    #[test]
    fn truncated_or_empty_chat_response_is_not_a_valid_final_reply() {
        let truncated: ChatResponse = serde_json::from_value(serde_json::json!({
            "choices": [{
                "finish_reason": "length",
                "message": {"content": "partial", "tool_calls": null}
            }]
        }))
        .unwrap();
        let empty: ChatResponse = serde_json::from_value(serde_json::json!({
            "choices": [{
                "finish_reason": "stop",
                "message": {"content": "  ", "tool_calls": []}
            }]
        }))
        .unwrap();

        assert!(validate_chat_choice(&truncated.choices[0])
            .unwrap_err()
            .contains("输出长度限制"));
        assert!(validate_chat_choice(&empty.choices[0])
            .unwrap_err()
            .contains("没有非空正文"));
    }

    #[test]
    fn chat_request_serializes_explicit_max_output_tokens() {
        let request = ChatRequest {
            model: "test-model".to_string(),
            messages: Vec::new(),
            tools: None,
            max_tokens: Some(131_072),
        };
        let value = serde_json::to_value(request).unwrap();

        assert_eq!(value["max_tokens"], 131_072);
    }

    #[test]
    fn chat_usage_accepts_openai_compatible_cached_prompt_tokens() {
        let response: ChatResponse = serde_json::from_value(serde_json::json!({
            "choices": [{
                "finish_reason": "stop",
                "message": {"content": "done", "tool_calls": null}
            }],
            "usage": {
                "prompt_tokens": 1200,
                "completion_tokens": 10,
                "total_tokens": 1210,
                "prompt_tokens_details": {"cached_tokens": 900}
            }
        }))
        .unwrap();

        assert_eq!(
            response
                .usage
                .as_ref()
                .and_then(|usage| usage.prompt_tokens_details.as_ref())
                .and_then(|details| details.cached_tokens),
            Some(900)
        );
    }

    #[tokio::test]
    async fn completion_request_times_out_when_server_never_responds() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        });
        let config = crate::config::LlmConfig {
            request_timeout_secs: 1,
            max_retries: 1,
            ..Default::default()
        };
        let client = OpenAIClient::new_with_config(
            "test-key".to_string(),
            format!("http://{address}"),
            "test-model".to_string(),
            None,
            &config,
        )
        .unwrap();
        let started = std::time::Instant::now();

        let error = client
            .create_completion(
                vec![Message {
                    role: "user".to_string(),
                    content: "hello".to_string(),
                    name: None,
                    tool_call_id: None,
                    tool_calls: None,
                }],
                Vec::new(),
            )
            .await
            .unwrap_err();

        assert!(started.elapsed() < std::time::Duration::from_secs(3));
        assert!(error.to_string().contains("timed out"));
        server.abort();
    }
}
