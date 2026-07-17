use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

/// Cross-provider reasoning depth supported by every first-class Morphz
/// protocol adapter. `None` is intentionally represented by `Option`: when
/// unset, Morphz omits the native field and preserves the model's own default.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    Low,
    Medium,
    High,
}

impl ReasoningEffort {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "low" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" => Some(Self::High),
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
        prompt_tokens: Option<u64>,
        completion_tokens: Option<u64>,
        total_tokens: Option<u64>,
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
