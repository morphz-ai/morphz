use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

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
}
