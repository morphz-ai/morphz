use crate::config::LlmConfig;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use std::sync::Mutex;

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

pub const OPENAI_COMPATIBLE_PROTOCOL: &str = "openai-chat-completions";

/// Prompt Token 计量的可信度，与具体 Provider 名称解耦。
///
/// 即使使用了真实 tokenizer，如果缺少 Provider 实际使用的 chat template，
/// 它仍然只是 tokenizer estimate，不能标记为 exact。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum PromptTokenAccuracy {
    Exact,
    LocalTokenizerEstimate,
    UsageCalibratedEstimate,
    #[default]
    HeuristicEstimate,
}

impl PromptTokenAccuracy {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Exact => "exact",
            Self::LocalTokenizerEstimate => "local-tokenizer-estimate",
            Self::UsageCalibratedEstimate => "usage-calibrated-estimate",
            Self::HeuristicEstimate => "heuristic-estimate",
        }
    }
}

/// 对一次即将发送给模型的完整 Prompt 的 Token 计量结果。
///
/// `source` 说明计量值的来源，`accuracy` 明确区分精确计数与各类估算，
/// 避免 Runtime 把近似值伪装成精确值。`tokens` 覆盖消息、System Prompt
/// 与工具定义构成的完整请求。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PromptTokenCount {
    pub tokens: usize,
    pub source: String,
    pub model: String,
    #[serde(default)]
    pub accuracy: PromptTokenAccuracy,
    /// 未加入 completion usage 校准前的完整请求估算。
    #[serde(default)]
    pub base_estimate_tokens: usize,
    /// 按 Context/Session 求值链路、模型与工具定义生成的稳定校准键。
    #[serde(default)]
    pub calibration_key: Option<u64>,
}

/// 交给 TokenCounter 的协议无关输入。`protocol` 由请求 Client 显式填写，
/// Counter 不从 Provider 名、模型名或 URL 推断协议。
pub struct PromptTokenRequest<'a> {
    pub protocol: &'static str,
    /// Context/Session 求值链路标识，用于隔离 usage 校准。
    pub scope: &'a str,
    pub model: &'a str,
    pub max_output_tokens: Option<u32>,
    pub messages: &'a [Message],
    pub tools: &'a [ToolDefinition],
}

/// 可插拔的本地 Prompt Token 计量能力。
///
/// 核心求值路径不允许 Token 计数产生额外远程请求。远程 Provider
/// 计数只能由将来的显式诊断命令调用，不实现此 trait。
pub trait LocalPromptTokenCounter: Send + Sync {
    fn count(
        &self,
        request: PromptTokenRequest<'_>,
    ) -> Result<Option<PromptTokenCount>, Box<dyn std::error::Error + Send + Sync>>;

    fn observe_completion_usage(
        &self,
        _measurement: &PromptTokenCount,
        _actual_prompt_tokens: usize,
    ) {
    }
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
    /// 在 completion 之前计量完整 Prompt。
    ///
    /// 第三方 Client 可以不实现；Orchestrator 会继续使用 Context 局部估算。
    /// Client 必须明确返回本地计量结果，不得根据 Provider/模型名
    /// 跨协议猜测，也不得为核心求值增加远程 Token 计数请求。
    async fn count_prompt_tokens(
        &self,
        _scope: &str,
        _messages: &[Message],
        _tools: &[ToolDefinition],
    ) -> Result<Option<PromptTokenCount>, Box<dyn std::error::Error + Send + Sync>> {
        Ok(None)
    }

    async fn create_completion(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>>;

    /// 携带本轮预请求计量。默认 Client 忽略它；OpenAIClient 会把 completion
    /// 回执的 prompt_tokens 反馈给同一 Context/Session 求值链路、模型与工具集，
    /// 校准后续预估。
    async fn create_completion_measured(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
        _measurement: Option<PromptTokenCount>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        self.create_completion(messages, tools).await
    }
}

pub struct OpenAIClient {
    http_client: reqwest::Client,
    api_key: String,
    base_url: String,
    model_name: String,
    max_retries: u32,
    initial_backoff_secs: u64,
    max_output_tokens: Option<u32>,
    prompt_token_counter: Arc<dyn LocalPromptTokenCounter>,
}

impl OpenAIClient {
    pub fn new(
        api_key: String,
        base_url: String,
        model_name: String,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Self::new_with_config(api_key, base_url, model_name, &LlmConfig::default())
    }

    pub fn new_with_config(
        api_key: String,
        mut base_url: String,
        model_name: String,
        config: &LlmConfig,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        if !base_url.is_empty() {
            if !base_url.ends_with("/v1") && !base_url.ends_with("/v1/") {
                base_url = base_url.trim_end_matches('/').to_string() + "/v1";
            }
        } else {
            base_url = "https://api.openai.com/v1".to_string();
        }

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
            max_retries: config.max_retries.max(1),
            initial_backoff_secs: config.initial_backoff_secs,
            max_output_tokens: config.max_output_tokens,
            prompt_token_counter: Arc::new(OpenAICompatibleEstimateCounter::default()),
        })
    }

    /// 为协议 Client 注入显式的本地 Token 计量能力。Provider profile 将来可根据
    /// 已声明的 tokenizer 与 chat template 资产选择实现，而无需修改 Runtime。
    pub fn with_local_prompt_token_counter(
        mut self,
        counter: Arc<dyn LocalPromptTokenCounter>,
    ) -> Self {
        self.prompt_token_counter = counter;
        self
    }

    /// 执行一次 completion，并把本轮计量沿调用栈直接带回对应的 usage 回执。
    /// 不能通过请求内容哈希暂存 measurement：两个并发 Session 可能产生完全相同
    /// 的请求，却必须分别校准各自的 Context/Session 求值链路。
    async fn create_completion_with_measurement(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
        measurement: Option<PromptTokenCount>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        let request_payload =
            build_chat_request(&self.model_name, self.max_output_tokens, &messages, &tools);

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
        if let (Some(measurement), Some(actual_prompt_tokens)) = (
            measurement,
            chat_resp
                .usage
                .as_ref()
                .and_then(|usage| usage.prompt_tokens),
        ) {
            let actual_prompt_tokens = usize::try_from(actual_prompt_tokens).unwrap_or(usize::MAX);
            self.prompt_token_counter
                .observe_completion_usage(&measurement, actual_prompt_tokens);
            tracing::info!(
                model = %self.model_name,
                predicted_prompt_tokens = measurement.tokens,
                actual_prompt_tokens,
                base_estimate_tokens = measurement.base_estimate_tokens,
                accuracy = measurement.accuracy.as_str(),
                absolute_error = measurement.tokens.abs_diff(actual_prompt_tokens),
                "已将 OpenAI-compatible completion usage 反馈给 Prompt TokenCounter"
            );
        }
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

fn build_chat_request(
    model: &str,
    max_tokens: Option<u32>,
    messages: &[Message],
    tools: &[ToolDefinition],
) -> ChatRequest {
    let req_messages = messages
        .iter()
        .map(|message| ChatReqMessage {
            role: message.role.clone(),
            content: Some(message.content.clone()),
            name: message.name.clone(),
            tool_call_id: message.tool_call_id.clone(),
            tool_calls: message.tool_calls.clone(),
        })
        .collect();
    let req_tools = (!tools.is_empty()).then(|| {
        tools
            .iter()
            .map(|tool| ChatReqTool {
                r#type: "function".to_string(),
                function: ChatReqFunction {
                    name: tool.name.clone(),
                    description: tool.description.clone(),
                    parameters: tool.parameters.clone(),
                },
            })
            .collect()
    });

    ChatRequest {
        model: model.to_string(),
        messages: req_messages,
        tools: req_tools,
        max_tokens,
    }
}

fn serialized_request_token_fallback(
    model: &str,
    max_tokens: Option<u32>,
    messages: &[Message],
    tools: &[ToolDefinition],
) -> usize {
    let request = build_chat_request(model, max_tokens, messages, tools);
    let serialized = serde_json::to_string(&request).unwrap_or_default();
    let ascii = serialized
        .chars()
        .filter(|character| character.is_ascii())
        .count();
    let non_ascii = serialized.chars().count().saturating_sub(ascii);
    (ascii.saturating_add(3) / 4).saturating_add(non_ascii)
}

fn apply_signed_token_delta(base: usize, delta: i64) -> usize {
    if delta >= 0 {
        base.saturating_add(usize::try_from(delta).unwrap_or(usize::MAX))
    } else {
        base.saturating_sub(usize::try_from(delta.unsigned_abs()).unwrap_or(usize::MAX))
    }
}

fn signed_token_delta(value: usize, baseline: usize) -> i64 {
    if value >= baseline {
        i64::try_from(value - baseline).unwrap_or(i64::MAX)
    } else {
        -i64::try_from(baseline - value).unwrap_or(i64::MAX)
    }
}

fn token_calibration_key(scope: &str, model: &str, tools: &[ToolDefinition]) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    scope.hash(&mut hasher);
    model.hash(&mut hasher);
    serde_json::to_string(tools)
        .unwrap_or_default()
        .hash(&mut hasher);
    hasher.finish()
}

/// OpenAI Chat Completions 协议本身没有通用的预请求 Token 计数端点。
/// 这个实现对实际发送的完整 JSON 请求做启发式估算，并使用
/// 后续 completion 返回的 `usage.prompt_tokens` 建立真值锚点；下一次请求
/// 只把本地估算出的请求增量叠加到该锚点上。
///
/// 这仍然不是精确 tokenizer：同一 OpenAI-compatible 协议后面可以是任意模型。
#[derive(Default)]
pub struct OpenAICompatibleEstimateCounter {
    usage_anchors: Mutex<HashMap<u64, PromptUsageAnchor>>,
}

#[derive(Debug, Clone, Copy)]
struct PromptUsageAnchor {
    base_estimate_tokens: usize,
    actual_prompt_tokens: usize,
}

impl LocalPromptTokenCounter for OpenAICompatibleEstimateCounter {
    fn count(
        &self,
        request: PromptTokenRequest<'_>,
    ) -> Result<Option<PromptTokenCount>, Box<dyn std::error::Error + Send + Sync>> {
        if request.protocol != OPENAI_COMPATIBLE_PROTOCOL {
            return Err(format!(
                "OpenAI-compatible TokenCounter 不能计量协议 {}",
                request.protocol
            )
            .into());
        }

        let base_estimate_tokens = serialized_request_token_fallback(
            request.model,
            request.max_output_tokens,
            request.messages,
            request.tools,
        );
        let calibration_key = token_calibration_key(request.scope, request.model, request.tools);
        let usage_anchor = self
            .usage_anchors
            .lock()
            .ok()
            .and_then(|anchors| anchors.get(&calibration_key).copied());
        let (tokens, source, accuracy) = match usage_anchor {
            Some(anchor) => {
                let estimated_delta =
                    signed_token_delta(base_estimate_tokens, anchor.base_estimate_tokens);
                (
                    apply_signed_token_delta(anchor.actual_prompt_tokens, estimated_delta),
                    "openai-compatible-request-estimate+usage-calibration".to_string(),
                    PromptTokenAccuracy::UsageCalibratedEstimate,
                )
            }
            None => (
                base_estimate_tokens,
                "openai-compatible-request-estimate".to_string(),
                PromptTokenAccuracy::HeuristicEstimate,
            ),
        };

        Ok(Some(PromptTokenCount {
            tokens,
            source,
            model: request.model.to_string(),
            accuracy,
            base_estimate_tokens,
            calibration_key: Some(calibration_key),
        }))
    }

    fn observe_completion_usage(
        &self,
        measurement: &PromptTokenCount,
        actual_prompt_tokens: usize,
    ) {
        let Some(calibration_key) = measurement.calibration_key else {
            return;
        };
        if measurement.accuracy == PromptTokenAccuracy::Exact {
            return;
        }

        if let Ok(mut anchors) = self.usage_anchors.lock() {
            anchors.insert(
                calibration_key,
                PromptUsageAnchor {
                    base_estimate_tokens: measurement.base_estimate_tokens,
                    actual_prompt_tokens,
                },
            );
        }
    }
}

#[async_trait::async_trait]
impl Client for OpenAIClient {
    async fn count_prompt_tokens(
        &self,
        scope: &str,
        messages: &[Message],
        tools: &[ToolDefinition],
    ) -> Result<Option<PromptTokenCount>, Box<dyn std::error::Error + Send + Sync>> {
        self.prompt_token_counter.count(PromptTokenRequest {
            protocol: OPENAI_COMPATIBLE_PROTOCOL,
            scope,
            model: &self.model_name,
            max_output_tokens: self.max_output_tokens,
            messages,
            tools,
        })
    }

    async fn create_completion_measured(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
        measurement: Option<PromptTokenCount>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        self.create_completion_with_measurement(messages, tools, measurement)
            .await
    }

    async fn create_completion(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        self.create_completion_with_measurement(messages, tools, None)
            .await
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

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn openai_chat_request_preserves_system_tool_rounds_and_tool_schema() {
        let messages = vec![
            Message {
                role: "system".to_string(),
                content: "system contract".to_string(),
                name: None,
                tool_call_id: None,
                tool_calls: None,
            },
            Message {
                role: "user".to_string(),
                content: "find it".to_string(),
                name: None,
                tool_call_id: None,
                tool_calls: None,
            },
            Message {
                role: "assistant".to_string(),
                content: "working".to_string(),
                name: None,
                tool_call_id: None,
                tool_calls: Some(vec![ToolCall {
                    id: "call-1".to_string(),
                    r#type: "function".to_string(),
                    function: FunctionCall {
                        name: "lookup".to_string(),
                        arguments: r#"{"query":"morphz"}"#.to_string(),
                    },
                }]),
            },
            Message {
                role: "tool".to_string(),
                content: "found".to_string(),
                name: Some("lookup".to_string()),
                tool_call_id: Some("call-1".to_string()),
                tool_calls: None,
            },
        ];
        let tools = vec![ToolDefinition {
            name: "lookup".to_string(),
            description: "search data".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"]
            }),
        }];

        let payload = serde_json::to_value(build_chat_request(
            "provider-model",
            Some(4096),
            &messages,
            &tools,
        ))
        .unwrap();
        assert_eq!(payload["messages"][0]["content"], "system contract");
        assert_eq!(
            payload["messages"][2]["tool_calls"][0]["function"]["arguments"],
            r#"{"query":"morphz"}"#
        );
        assert_eq!(payload["messages"][3]["content"], "found");
        assert_eq!(payload["tools"][0]["function"]["name"], "lookup");
        assert_eq!(
            payload["tools"][0]["function"]["parameters"]["required"][0],
            "query"
        );
        assert_eq!(payload["max_tokens"], 4096);
    }

    #[test]
    fn serialized_fallback_counts_the_complete_request_including_tools() {
        let messages = vec![Message {
            role: "user".to_string(),
            content: "中文请求".to_string(),
            name: None,
            tool_call_id: None,
            tool_calls: None,
        }];
        let without_tools = serialized_request_token_fallback("other-model", None, &messages, &[]);
        let with_tools = serialized_request_token_fallback(
            "other-model",
            None,
            &messages,
            &[ToolDefinition {
                name: "lookup".to_string(),
                description: "查找数据".to_string(),
                parameters: serde_json::json!({"type": "object", "properties": {}}),
            }],
        );
        assert!(with_tools > without_tools);
    }

    #[tokio::test]
    async fn model_name_never_selects_a_cross_protocol_token_counter() {
        let config = crate::config::LlmConfig {
            request_timeout_secs: 1,
            ..Default::default()
        };
        let client = OpenAIClient::new_with_config(
            "test-key".to_string(),
            "http://127.0.0.1:9".to_string(),
            "gemini-test".to_string(),
            &config,
        )
        .unwrap();
        let count = client
            .count_prompt_tokens(
                "test-scope",
                &[Message {
                    role: "user".to_string(),
                    content: "hello".to_string(),
                    name: None,
                    tool_call_id: None,
                    tool_calls: None,
                }],
                &[],
            )
            .await
            .unwrap()
            .unwrap();

        assert!(count.tokens > 0);
        assert_eq!(count.model, "gemini-test");
        assert_eq!(count.source, "openai-compatible-request-estimate");
        assert_eq!(count.accuracy, PromptTokenAccuracy::HeuristicEstimate);
    }

    #[tokio::test]
    async fn completion_usage_anchors_future_local_delta_estimates() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let client = OpenAIClient::new_with_config(
            "test-key".to_string(),
            format!("http://{address}"),
            "gemini-test".to_string(),
            &crate::config::LlmConfig {
                request_timeout_secs: 2,
                ..Default::default()
            },
        )
        .unwrap();
        let messages = vec![Message {
            role: "user".to_string(),
            content: "hello".to_string(),
            name: None,
            tool_call_id: None,
            tool_calls: None,
        }];
        let tools = vec![ToolDefinition {
            name: "lookup".to_string(),
            description: "search".to_string(),
            parameters: serde_json::json!({"type": "object", "properties": {}}),
        }];

        let first = client
            .count_prompt_tokens("test-scope", &messages, &tools)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first.accuracy, PromptTokenAccuracy::HeuristicEstimate);
        let actual_prompt_tokens = first.base_estimate_tokens.saturating_sub(7).max(1);
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = vec![0_u8; 32_768];
            let read = socket.read(&mut buffer).await.unwrap();
            let request = String::from_utf8_lossy(&buffer[..read]).to_string();
            let body = serde_json::json!({
                "choices": [{
                    "finish_reason": "stop",
                    "message": {"content": "done", "tool_calls": null}
                }],
                "usage": {
                    "prompt_tokens": actual_prompt_tokens,
                    "completion_tokens": 1,
                    "total_tokens": actual_prompt_tokens + 1
                }
            })
            .to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            request
        });
        client
            .create_completion_measured(messages.clone(), tools.clone(), Some(first))
            .await
            .unwrap();
        let calibrated = client
            .count_prompt_tokens("test-scope", &messages, &tools)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(calibrated.tokens, actual_prompt_tokens);
        assert_eq!(
            calibrated.accuracy,
            PromptTokenAccuracy::UsageCalibratedEstimate
        );
        assert_eq!(
            calibrated.source,
            "openai-compatible-request-estimate+usage-calibration"
        );
        let mut expanded_messages = messages.clone();
        expanded_messages[0]
            .content
            .push_str(" with enough additional context to increase the local estimate");
        let expanded = client
            .count_prompt_tokens("test-scope", &expanded_messages, &tools)
            .await
            .unwrap()
            .unwrap();
        let estimated_growth = signed_token_delta(
            expanded.base_estimate_tokens,
            calibrated.base_estimate_tokens,
        );
        assert_eq!(
            expanded.tokens,
            apply_signed_token_delta(actual_prompt_tokens, estimated_growth)
        );
        let other_scope = client
            .count_prompt_tokens("other-scope", &messages, &tools)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(other_scope.accuracy, PromptTokenAccuracy::HeuristicEstimate);
        let request = server.await.unwrap();
        assert!(request.contains("POST /v1/chat/completions"));
        assert!(!request.contains(":countTokens"));
    }

    #[tokio::test]
    async fn identical_concurrent_requests_keep_usage_attached_to_their_session_scope() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        async fn reply(mut socket: tokio::net::TcpStream, prompt_tokens: usize) {
            let body = serde_json::json!({
                "choices": [{
                    "finish_reason": "stop",
                    "message": {"content": "done", "tool_calls": null}
                }],
                "usage": {
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": 1,
                    "total_tokens": prompt_tokens + 1
                }
            })
            .to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let client = Arc::new(
            OpenAIClient::new_with_config(
                "test-key".to_string(),
                format!("http://{address}"),
                "test-model".to_string(),
                &crate::config::LlmConfig {
                    request_timeout_secs: 2,
                    ..Default::default()
                },
            )
            .unwrap(),
        );
        let messages = vec![Message {
            role: "user".to_string(),
            content: "identical request".to_string(),
            name: None,
            tool_call_id: None,
            tool_calls: None,
        }];
        let tools = Vec::new();
        let measurement_a = client
            .count_prompt_tokens("context-a:session-a", &messages, &tools)
            .await
            .unwrap()
            .unwrap();
        let measurement_b = client
            .count_prompt_tokens("context-b:session-b", &messages, &tools)
            .await
            .unwrap()
            .unwrap();
        let query_messages = messages.clone();
        let query_tools = tools.clone();
        let (first_accepted_tx, first_accepted_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket_a, _) = listener.accept().await.unwrap();
            let mut buffer = vec![0_u8; 32_768];
            let _ = socket_a.read(&mut buffer).await.unwrap();
            first_accepted_tx.send(()).unwrap();

            let (mut socket_b, _) = listener.accept().await.unwrap();
            let _ = socket_b.read(&mut buffer).await.unwrap();
            reply(socket_b, 222).await;
            reply(socket_a, 111).await;
        });

        let client_a = Arc::clone(&client);
        let messages_a = messages.clone();
        let tools_a = tools.clone();
        let task_a = tokio::spawn(async move {
            client_a
                .create_completion_measured(messages_a, tools_a, Some(measurement_a))
                .await
        });
        first_accepted_rx.await.unwrap();
        let client_b = Arc::clone(&client);
        let task_b = tokio::spawn(async move {
            client_b
                .create_completion_measured(messages, tools, Some(measurement_b))
                .await
        });

        task_a.await.unwrap().unwrap();
        task_b.await.unwrap().unwrap();
        server.await.unwrap();

        let count_a = client
            .count_prompt_tokens("context-a:session-a", &query_messages, &query_tools)
            .await
            .unwrap()
            .unwrap();
        let count_b = client
            .count_prompt_tokens("context-b:session-b", &query_messages, &query_tools)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(count_a.tokens, 111);
        assert_eq!(count_b.tokens, 222);
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
