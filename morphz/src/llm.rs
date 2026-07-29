use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

/// Runtime-facing classification of a failed physical model request.
///
/// Protocol adapters must preserve this distinction instead of flattening all
/// failures into strings.  The scheduler uses it to decide whether an
/// Objective should enter Context maintenance, wait for a Provider, or stop
/// for operator configuration.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelFailureKind {
    ContextLimit,
    RateLimited,
    TransientNetwork,
    ServerUnavailable,
    Authentication,
    InvalidModelOrRequest,
    /// HTTP response headers were accepted, but the Provider emitted no body
    /// bytes before the first-byte deadline. This is request-local latency,
    /// not evidence that the shared Provider is unavailable.
    FirstByteTimeout,
    /// At least one response-body byte was received, then the stream stopped
    /// making progress for the configured idle interval.
    StreamStalled,
    /// Runtime's optional absolute wall-clock deadline ended one physical
    /// request. This is request-local policy, not shared Provider health.
    HardDeadlineExceeded,
    StreamIdleTimeout,
    Unknown,
}

impl ModelFailureKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ContextLimit => "context_limit",
            Self::RateLimited => "rate_limited",
            Self::TransientNetwork => "transient_network",
            Self::ServerUnavailable => "server_unavailable",
            Self::Authentication => "authentication",
            Self::InvalidModelOrRequest => "invalid_model_or_request",
            Self::FirstByteTimeout => "first_byte_timeout",
            Self::StreamStalled => "stream_stalled",
            Self::HardDeadlineExceeded => "hard_deadline_exceeded",
            Self::StreamIdleTimeout => "stream_idle_timeout",
            Self::Unknown => "unknown",
        }
    }

    pub const fn is_provider_transient(self) -> bool {
        matches!(
            self,
            Self::RateLimited
                | Self::TransientNetwork
                | Self::ServerUnavailable
                | Self::FirstByteTimeout
                | Self::StreamStalled
                | Self::HardDeadlineExceeded
                | Self::StreamIdleTimeout
        )
    }

    /// A single slow/large request must never poison the endpoint+model
    /// circuit shared by unrelated Sessions. It may still be retried by the
    /// owning Dialogue Turn or Objective.
    pub const fn is_request_scoped_latency(self) -> bool {
        matches!(
            self,
            Self::FirstByteTimeout | Self::StreamStalled | Self::HardDeadlineExceeded
        )
    }

    /// Whether a failed physical request should enter the durable Provider
    /// recovery loop for an Objective.
    ///
    /// Authentication and request/model configuration failures are not
    /// transient in the narrow HTTP sense, but they are still recoverable
    /// Runtime conditions: credentials, routing and the selected model can be
    /// repaired while the Objective remains valid.  They therefore use a
    /// slower/capped retry loop instead of turning the Objective into a
    /// terminal or manually-resumed state.  ContextLimit is deliberately
    /// excluded because it is handled by Context maintenance rather than by
    /// reconnecting to the same Provider with the same request.
    pub const fn uses_provider_recovery(self) -> bool {
        !matches!(self, Self::ContextLimit)
    }

    pub const fn requires_configuration(self) -> bool {
        matches!(self, Self::Authentication | Self::InvalidModelOrRequest)
    }
}

/// Structured error emitted by first-class Provider adapters.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelFailure {
    pub kind: ModelFailureKind,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_secs: Option<u64>,
}

impl ModelFailure {
    pub fn new(kind: ModelFailureKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            http_status: None,
            provider_code: None,
            retry_after_secs: None,
        }
    }

    pub fn with_http_status(mut self, status: u16) -> Self {
        self.http_status = Some(status);
        self
    }

    pub fn with_provider_code(mut self, code: Option<String>) -> Self {
        self.provider_code = code;
        self
    }

    pub fn with_retry_after(mut self, seconds: Option<u64>) -> Self {
        self.retry_after_secs = seconds;
        self
    }

    /// Compatibility classifier for custom Client implementations that have
    /// not yet adopted `ModelFailure`.  First-class adapters should construct
    /// the structured value directly; this fallback deliberately recognizes
    /// only stable cross-provider phrases.
    pub fn classify_message(message: impl Into<String>) -> Self {
        let message = message.into();
        let normalized = message.to_ascii_lowercase();
        let kind = if contains_any(
            &normalized,
            &[
                "context_length_exceeded",
                "maximum context length",
                "max context length",
                "context window",
                "too many input tokens",
                "input token limit",
                "prompt is too long",
                "request too large",
                "上下文长度",
                "上下文上限",
                "输入 token 超",
            ],
        ) {
            ModelFailureKind::ContextLimit
        } else if contains_any(&normalized, &["429", "rate limit", "too many requests"]) {
            ModelFailureKind::RateLimited
        } else if contains_any(
            &normalized,
            &["first byte timeout", "first-byte timeout", "首字节超时"],
        ) {
            ModelFailureKind::FirstByteTimeout
        } else if contains_any(
            &normalized,
            &["stream stalled", "stream_stalled", "流已停滞"],
        ) {
            ModelFailureKind::StreamStalled
        } else if contains_any(
            &normalized,
            &["hard deadline exceeded", "hard_deadline_exceeded"],
        ) {
            ModelFailureKind::HardDeadlineExceeded
        } else if contains_any(
            &normalized,
            &[
                "401",
                "403",
                "unauthorized",
                "forbidden",
                "invalid api key",
                "authentication",
            ],
        ) {
            ModelFailureKind::Authentication
        } else if contains_any(
            &normalized,
            &[
                "model_not_found",
                "model not found",
                "unknown model",
                "invalid model",
                "invalid request",
            ],
        ) {
            ModelFailureKind::InvalidModelOrRequest
        } else if contains_any(
            &normalized,
            &[
                "connection refused",
                "connection reset",
                "connection closed",
                "dns error",
                "failed to lookup address",
                "no route to host",
                "network is unreachable",
                "tcp connect error",
            ],
        ) {
            ModelFailureKind::TransientNetwork
        } else if contains_any(
            &normalized,
            &["idle timeout", "timed out", "timeout awaiting response"],
        ) {
            ModelFailureKind::StreamIdleTimeout
        } else if contains_any(
            &normalized,
            &["http 500", "http 502", "http 503", "http 504"],
        ) {
            ModelFailureKind::ServerUnavailable
        } else {
            ModelFailureKind::Unknown
        };
        Self::new(kind, message)
    }
}

impl std::fmt::Display for ModelFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ModelFailure {}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

/// Normalized reasoning control forwarded by every first-class Morphz
/// protocol adapter. `None` is intentionally represented by `Option`: when
/// unset, Morphz omits the native field and preserves the model's own default.
/// Providers may still reject levels unsupported by a particular model.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    #[serde(rename = "none", alias = "off", alias = "disabled")]
    Off,
    Low,
    Medium,
    High,
    Max,
}

impl ReasoningEffort {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Off => "none",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Max => "max",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "none" | "off" | "disabled" => Some(Self::Off),
            "low" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" => Some(Self::High),
            "max" | "maximum" => Some(Self::Max),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Message {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(rename = "tool_call_id", skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(rename = "tool_calls", skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
}

/// Ephemeral provider-envelope marker. This message is assembled from
/// Ledger-backed attachment metadata immediately before a model request and is
/// never persisted as conversational text.
pub const MODEL_ATTACHMENT_MESSAGE_NAME: &str = "__morphz_model_attachments__";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelAttachment {
    pub name: String,
    pub media_type: String,
    pub data_base64: String,
}

pub fn attachment_message(attachments: Vec<ModelAttachment>) -> Result<Message, serde_json::Error> {
    Ok(Message {
        role: "user".to_string(),
        content: serde_json::to_string(&attachments)?,
        name: Some(MODEL_ATTACHMENT_MESSAGE_NAME.to_string()),
        tool_call_id: None,
        tool_calls: None,
    })
}

pub fn model_attachments(message: &Message) -> Option<Vec<ModelAttachment>> {
    (message.name.as_deref() == Some(MODEL_ATTACHMENT_MESSAGE_NAME))
        .then(|| serde_json::from_str(&message.content).unwrap_or_default())
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
    pub parameters: JsonValue,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Response {
    pub content: String,
    pub tool_calls: Vec<ToolCallRepr>,
}

/// Provider 返回的一次模型请求真实用量的规范化表示。
///
/// 这些值是计费与审计事实，不参与伪装成精确值的本地 Prompt 估算。
/// `raw` 保留 Provider 原始 usage 对象，以免规范化暂未覆盖的新字段丢失。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ModelUsage {
    /// Provider 计入本次请求的全部输入 Token，包含缓存命中部分。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    /// 未从 Provider 缓存读取的输入 Token（若协议可区分）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uncached_input_tokens: Option<u64>,
    /// 从 Provider 缓存读取的输入 Token（若协议可区分）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_input_tokens: Option<u64>,
    /// 本次写入 Provider 缓存的输入 Token（若协议可区分）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    /// 输出 Token 中用于推理的子集（若协议可区分）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub raw: Vec<JsonValue>,
}

impl ModelUsage {
    pub fn has_usage(&self) -> bool {
        self.input_tokens.is_some()
            || self.uncached_input_tokens.is_some()
            || self.cached_input_tokens.is_some()
            || self.cache_write_input_tokens.is_some()
            || self.output_tokens.is_some()
            || self.reasoning_tokens.is_some()
            || self.total_tokens.is_some()
            || !self.raw.is_empty()
    }

    /// 合并流式协议分多次返回的 usage。标量字段采用最新非空值，原始
    /// Provider 对象全部保留，保证 Anthropic 等分段 usage 可被完整审计。
    pub fn merge_from(&mut self, newer: &Self) {
        self.input_tokens = newer.input_tokens.or(self.input_tokens);
        self.uncached_input_tokens = newer.uncached_input_tokens.or(self.uncached_input_tokens);
        self.cached_input_tokens = newer.cached_input_tokens.or(self.cached_input_tokens);
        self.cache_write_input_tokens = newer
            .cache_write_input_tokens
            .or(self.cache_write_input_tokens);
        self.output_tokens = newer.output_tokens.or(self.output_tokens);
        self.reasoning_tokens = newer.reasoning_tokens.or(self.reasoning_tokens);
        self.total_tokens = newer.total_tokens.or(self.total_tokens);
        self.raw.extend(newer.raw.iter().cloned());
        // Anthropic 等协议会把输入与输出 usage 分别放在流首、流尾，且不
        // 一定提供 total。两部分都是 Provider 原始事实时，其算术和仍是
        // 精确值，不能在统计层错误地显示为 0。
        if self.total_tokens.is_none() {
            self.total_tokens = self
                .input_tokens
                .zip(self.output_tokens)
                .map(|(input, output)| input.saturating_add(output));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ModelUsage;

    #[test]
    fn split_provider_usage_merges_into_an_exact_total() {
        let mut usage = ModelUsage {
            input_tokens: Some(10),
            raw: vec![serde_json::json!({"input_tokens": 10})],
            ..Default::default()
        };
        usage.merge_from(&ModelUsage {
            output_tokens: Some(4),
            raw: vec![serde_json::json!({"output_tokens": 4})],
            ..Default::default()
        });
        assert_eq!(usage.total_tokens, Some(14));
        assert_eq!(usage.raw.len(), 2);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ModelStreamEvent {
    Started,
    TextDelta {
        text: String,
    },
    /// A provider-authored summary of its reasoning process. This is a
    /// transient presentation channel: callers must not merge it into the
    /// assistant reply or persist it as conversation content.
    ReasoningSummaryDelta {
        text: String,
    },
    /// Provider explicitly closed its reasoning-summary item, while the
    /// overall response may still be waiting for public text or tool calls.
    ReasoningSummaryCompleted,
    ToolCallStarted {
        index: usize,
        id: String,
        name: String,
    },
    ToolArgumentsDelta {
        index: usize,
        delta: String,
    },
    ToolCallCompleted {
        index: usize,
    },
    Usage {
        usage: ModelUsage,
    },
    Completed,
    Failed {
        message: String,
    },
}

pub type ModelStreamSender = tokio::sync::mpsc::UnboundedSender<ModelStreamEvent>;

/// Prompt Token 计量的可信度，与具体 Provider 名称解耦。
///
/// 即使使用真实 tokenizer，如果缺少 Provider 实际使用的 chat template，
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
    #[serde(default)]
    pub base_estimate_tokens: usize,
    #[serde(default)]
    pub calibration_key: Option<u64>,
    /// Provider protocol、model 与工具定义构成的校准形状。Client 在收到
    /// completion usage 时用它确认实际发送请求仍属于预请求计量的同一锚点。
    #[serde(default)]
    pub calibration_shape: Option<u64>,
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
    /// Stable Runtime resource identity used for shared backoff and durable
    /// Objective waits.  Custom clients may keep the conservative default;
    /// first-class protocol adapters include endpoint, protocol and model.
    fn provider_resource_key(&self) -> String {
        "model-provider:default".to_string()
    }

    /// Whether dropping an in-flight completion future reliably cancels its
    /// underlying I/O.
    ///
    /// This is deliberately independent from streaming support. Compatibility
    /// clients may implement an async trait method with synchronously blocking
    /// work inside it; awaiting such a client directly would let one bad
    /// implementation pin a Tokio worker past the Runtime deadline. The
    /// default therefore stays conservative and lets the Orchestrator isolate
    /// the call on a dedicated OS thread. Native async protocol adapters should
    /// opt in so a Tokio timeout can drop the reqwest future and close the
    /// actual HTTP request rather than merely abandoning a receiver.
    fn supports_async_cancellation(&self) -> bool {
        false
    }

    /// Current process-local model selected for subsequent requests.
    fn model(&self) -> Option<String> {
        None
    }

    /// Change the model for subsequent requests. Runtime callers must validate
    /// the requested value against the operator-configured model catalog.
    fn set_model(&self, _model: &str) -> Result<(), String> {
        Err("当前模型客户端不支持运行期切换模型".to_string())
    }

    /// Current process-local reasoning override. `None` means provider/model
    /// default and therefore emits no protocol-specific request field.
    fn reasoning_effort(&self) -> Option<ReasoningEffort> {
        None
    }

    /// Change the reasoning override for subsequent requests. Implementations
    /// without a controllable native protocol should return a clear error.
    fn set_reasoning_effort(&self, _effort: Option<ReasoningEffort>) -> Result<(), String> {
        Err("当前模型客户端不支持动态调整推理深度".to_string())
    }

    /// 在 completion 之前本地计量完整 Prompt。实现不得为核心求值增加远程请求。
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

    /// 携带本轮预请求计量，供协议适配器将 usage 反馈到后续本地估算。
    async fn create_completion_measured(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
        _measurement: Option<PromptTokenCount>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        self.create_completion(messages, tools).await
    }

    /// 统一流式入口。具有原生流协议的适配器应覆盖此方法；其他实现获得
    /// 无损原子降级，但上层始终只消费规范化事件。
    async fn create_completion_measured_stream(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
        measurement: Option<PromptTokenCount>,
        stream: ModelStreamSender,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        let _ = stream.send(ModelStreamEvent::Started);
        match self
            .create_completion_measured(messages, tools, measurement)
            .await
        {
            Ok(response) => {
                if !response.content.is_empty() {
                    let _ = stream.send(ModelStreamEvent::TextDelta {
                        text: response.content.clone(),
                    });
                }
                for (index, call) in response.tool_calls.iter().enumerate() {
                    let _ = stream.send(ModelStreamEvent::ToolCallStarted {
                        index,
                        id: call.id.clone(),
                        name: call.func_name.clone(),
                    });
                    let _ = stream.send(ModelStreamEvent::ToolArgumentsDelta {
                        index,
                        delta: call.arguments.clone(),
                    });
                    let _ = stream.send(ModelStreamEvent::ToolCallCompleted { index });
                }
                let _ = stream.send(ModelStreamEvent::Completed);
                Ok(response)
            }
            Err(error) => {
                let _ = stream.send(ModelStreamEvent::Failed {
                    message: error.to_string(),
                });
                Err(error)
            }
        }
    }

    /// Small request used exclusively to confirm shared Provider health.
    /// Implementations should not reuse an application request or its large
    /// Context as a recovery probe.
    async fn probe_health(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let _response = self
            .create_completion(
                vec![Message {
                    role: "user".to_string(),
                    content: "Reply MORPHZ_OK.".to_string(),
                    name: None,
                    tool_call_id: None,
                    tool_calls: None,
                }],
                Vec::new(),
            )
            .await?;
        Ok(())
    }
}
