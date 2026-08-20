use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::BTreeMap;
use std::sync::Arc;

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
    /// The account or subscription has exhausted its included usage. Unlike
    /// a short provider throttle, there is no useful near-term retry schedule
    /// for the current turn, so it must not occupy a durable Provider wait.
    QuotaExhausted,
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
    /// Runtime could not admit the request before its local Provider queue
    /// deadline. No Provider request was made, so health recovery is invalid.
    ProviderQueueTimeout,
    /// Runtime stopped a reasoning-only continuation loop at its configured
    /// safety boundary. The Provider completed its requests successfully.
    ReasoningContinuationExhausted,
    /// The Provider completed a syntactically valid response, but emitted
    /// neither public assistant text nor a tool call. This is a response
    /// protocol boundary, not evidence that the shared Provider is down.
    /// The Orchestrator may continue it when reasoning progress exists, or
    /// request one bounded protocol correction otherwise.
    EmptyResponse,
    StreamIdleTimeout,
    Unknown,
}

impl ModelFailureKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ContextLimit => "context_limit",
            Self::RateLimited => "rate_limited",
            Self::QuotaExhausted => "quota_exhausted",
            Self::TransientNetwork => "transient_network",
            Self::ServerUnavailable => "server_unavailable",
            Self::Authentication => "authentication",
            Self::InvalidModelOrRequest => "invalid_model_or_request",
            Self::FirstByteTimeout => "first_byte_timeout",
            Self::StreamStalled => "stream_stalled",
            Self::HardDeadlineExceeded => "hard_deadline_exceeded",
            Self::ProviderQueueTimeout => "provider_queue_timeout",
            Self::ReasoningContinuationExhausted => "reasoning_continuation_exhausted",
            Self::EmptyResponse => "empty_response",
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
    /// Authentication remains recoverable because refreshing the credential
    /// preserves the immutable physical request binding. A malformed request
    /// or unsupported model does not: a small health probe can succeed while
    /// the original request keeps returning HTTP 400, and a newly selected
    /// model must acquire a new binding on a new Attempt. Such failures must
    /// therefore stop the current turn instead of entering Provider recovery.
    /// ContextLimit is handled separately by Context maintenance.
    pub const fn uses_provider_recovery(self) -> bool {
        !matches!(
            self,
            Self::ContextLimit
                | Self::InvalidModelOrRequest
                | Self::QuotaExhausted
                | Self::HardDeadlineExceeded
                | Self::ProviderQueueTimeout
                | Self::ReasoningContinuationExhausted
                | Self::EmptyResponse
        )
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
        } else if contains_any(
            &normalized,
            &[
                "subscription:free-usage-exhausted",
                "free-usage-exhausted",
                "insufficient_quota",
                "quota exceeded",
                "usage limit reached",
                "reached your usage limit",
                "usage limit for this billing cycle",
                "quota will be refreshed in the next cycle",
                "used all the included free usage",
            ],
        ) {
            ModelFailureKind::QuotaExhausted
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
                "neither non-empty content nor a tool call",
                "neither nonempty content nor a tool call",
                "既没有非空正文，也没有工具调用",
            ],
        ) {
            ModelFailureKind::EmptyResponse
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

/// Failure while resolving one immutable physical model binding.
///
/// This boundary is typed because an unavailable account is a Provider/auth
/// condition, a malformed route is operator configuration, and a Store/lock
/// failure is Runtime infrastructure. Flattening them into one String caused
/// unavailable accounts to be reported as unrelated Runtime internal errors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelAttemptBindingError {
    AccountUnavailable(String),
    Configuration(String),
    Runtime(String),
}

impl ModelAttemptBindingError {
    pub fn account_unavailable(message: impl Into<String>) -> Self {
        Self::AccountUnavailable(message.into())
    }

    pub fn configuration(message: impl Into<String>) -> Self {
        Self::Configuration(message.into())
    }

    pub fn runtime(message: impl Into<String>) -> Self {
        Self::Runtime(message.into())
    }
}

impl std::fmt::Display for ModelAttemptBindingError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AccountUnavailable(message)
            | Self::Configuration(message)
            | Self::Runtime(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for ModelAttemptBindingError {}

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
/// Event-backed attachment metadata immediately before a model request and is
/// never persisted as conversational text.
pub const MODEL_ATTACHMENT_MESSAGE_NAME: &str = "__morphz_model_attachments__";

/// Ephemeral marker carrying Provider-native state that is required to
/// continue a tool-calling response. The Runtime persists the typed value at
/// the assistant-call boundary, then reconstructs this marker immediately
/// before the next physical model request. It is protocol state, not Context
/// content, and must never be compiled into Mind, Inbox, Recall, or visible
/// conversation text.
pub const PROVIDER_CONTINUATION_MESSAGE_NAME: &str = "__morphz_provider_continuation__";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "protocol", rename_all = "kebab-case")]
pub enum ProviderContinuation {
    /// OpenAI-compatible Chat providers such as DeepSeek require the exact
    /// assistant `reasoning_content` to accompany the assistant tool_calls
    /// message on the next request.
    OpenaiChat { reasoning_content: String },
    /// The Responses protocol represents continuation state as output items.
    /// Keep the complete Provider-authored JSON so opaque fields such as
    /// `encrypted_content` survive without Morphz interpreting them.
    OpenaiResponses { reasoning_items: Vec<JsonValue> },
}

pub fn provider_continuation_message(
    continuation: ProviderContinuation,
) -> Result<Message, serde_json::Error> {
    Ok(Message {
        role: "system".to_string(),
        content: serde_json::to_string(&continuation)?,
        name: Some(PROVIDER_CONTINUATION_MESSAGE_NAME.to_string()),
        tool_call_id: None,
        tool_calls: None,
    })
}

pub fn provider_continuation(message: &Message) -> Option<ProviderContinuation> {
    (message.name.as_deref() == Some(PROVIDER_CONTINUATION_MESSAGE_NAME))
        .then(|| serde_json::from_str(&message.content).ok())
        .flatten()
}

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

/// Normalized representation of actual usage reported by a Provider for one model request.
///
/// These values are billing and audit facts, not local Prompt estimates presented as exact.
/// `raw` retains the original Provider usage object so normalization cannot lose new fields.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ModelUsage {
    /// All input tokens counted by the Provider, including cache hits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    /// Input tokens not read from the Provider cache, when the protocol distinguishes them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uncached_input_tokens: Option<u64>,
    /// Input tokens read from the Provider cache, when the protocol distinguishes them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_input_tokens: Option<u64>,
    /// Input tokens written to the Provider cache, when the protocol distinguishes them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    /// Subset of output tokens used for reasoning, when the protocol distinguishes them.
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

    /// Merges usage returned in multiple streaming segments. Scalar fields take the latest present
    /// value, while all raw Provider objects are retained for complete audit of segmented usage such
    /// as Anthropic's.
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
        // Protocols such as Anthropic may report input and output usage at opposite ends of a stream
        // without a total. When both parts are original Provider facts, their arithmetic sum remains
        // exact and must not appear as zero in statistics.
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
    use super::{ModelFailureKind, ModelUsage};

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

    #[test]
    fn deterministic_invalid_requests_do_not_enter_provider_health_recovery() {
        assert!(!ModelFailureKind::InvalidModelOrRequest.uses_provider_recovery());
        assert!(!ModelFailureKind::QuotaExhausted.uses_provider_recovery());
        assert!(!ModelFailureKind::ContextLimit.uses_provider_recovery());
        assert!(!ModelFailureKind::HardDeadlineExceeded.uses_provider_recovery());
        assert!(!ModelFailureKind::ProviderQueueTimeout.uses_provider_recovery());
        assert!(!ModelFailureKind::ReasoningContinuationExhausted.uses_provider_recovery());
        assert!(!ModelFailureKind::EmptyResponse.uses_provider_recovery());
        assert!(ModelFailureKind::Authentication.uses_provider_recovery());
        assert!(ModelFailureKind::TransientNetwork.uses_provider_recovery());
        assert!(ModelFailureKind::ServerUnavailable.uses_provider_recovery());
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
    /// Opaque protocol state needed to continue a Provider tool-call turn.
    /// The Orchestrator consumes this event internally; unlike a reasoning
    /// summary, it must never be published to presentation clients.
    ProviderContinuation {
        continuation: ProviderContinuation,
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
        usage: ModelUsage,
    },
    Completed,
    Failed {
        message: String,
    },
}

pub type ModelStreamSender = tokio::sync::mpsc::UnboundedSender<ModelStreamEvent>;

/// Confidence of Prompt-token measurement, independent of specific Provider names.
///
/// Even a real tokenizer remains an estimate when the Provider's actual chat template is unknown and
/// therefore cannot be marked exact.
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

/// Token measurement for one complete Prompt about to be sent to a model.
///
/// `source` identifies provenance and `accuracy` separates exact counts from estimates so the runtime
/// never presents an approximation as exact. `tokens` covers the full request: messages, System
/// Prompt, and tool definitions.
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
    /// Calibration shape formed by Provider protocol, model, and tool definitions. On completion
    /// usage, the client uses it to verify that the sent request still matches the pre-request
    /// measurement anchor.
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

/// Runtime facts available while resolving one physical model request. These
/// identifiers are routing inputs only; they never become model-visible prompt
/// text.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelRequestContext {
    pub context_id: String,
    pub session_id: String,
    pub attempt_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub objective_id: Option<String>,
    #[serde(default)]
    pub required_capabilities: Vec<String>,
}

/// Optional decoded-binary ceilings for one physical model request. Missing
/// values are deliberately unknown rather than guessed. The Runtime combines
/// a binding's declared limits with host policy by taking the stricter value
/// for each dimension.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ModelInputLimits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_attachments: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_attachment_bytes: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_total_bytes: Option<usize>,
}

impl ModelInputLimits {
    pub fn stricter(self, other: Self) -> Self {
        fn minimum(left: Option<usize>, right: Option<usize>) -> Option<usize> {
            match (left, right) {
                (Some(left), Some(right)) => Some(left.min(right)),
                (Some(value), None) | (None, Some(value)) => Some(value),
                (None, None) => None,
            }
        }
        Self {
            max_attachments: minimum(self.max_attachments, other.max_attachments),
            max_attachment_bytes: minimum(self.max_attachment_bytes, other.max_attachment_bytes),
            max_total_bytes: minimum(self.max_total_bytes, other.max_total_bytes),
        }
    }

    pub fn is_unspecified(&self) -> bool {
        self.max_attachments.is_none()
            && self.max_attachment_bytes.is_none()
            && self.max_total_bytes.is_none()
    }
}

/// Immutable physical identity of a Model Attempt. A retry may only change
/// these fields by creating and persisting a new binding revision explicitly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelAttemptBinding {
    pub requested_alias: String,
    pub route_id: String,
    pub route_revision: String,
    pub provider_instance_id: String,
    pub auth_account_id: String,
    pub physical_model: String,
    pub protocol: String,
    pub provider_adapter: String,
    pub provider_adapter_version: String,
    pub endpoint: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// Exact limits declared for this physical model. Empty means the service
    /// did not declare them; it does not mean unlimited.
    #[serde(default, skip_serializing_if = "ModelInputLimits::is_unspecified")]
    pub model_input_limits: ModelInputLimits,
}

/// Secret-free result of an explicit operator probe against one immutable
/// physical model binding. A failed catalog lookup or health request remains
/// data in this receipt so CLI, HTTP and Dashboard present the same diagnosis.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelRouteDiagnostic {
    pub checked_at: chrono::DateTime<chrono::Utc>,
    pub binding: ModelAttemptBinding,
    pub elapsed_ms: u64,
    #[serde(default)]
    pub discovered_models: Vec<String>,
    /// Exact capacity fields returned alongside the corresponding model row.
    /// Missing fields remain `None`; the Runtime never fills them from model
    /// names or a built-in capacity table.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub discovered_model_profiles: BTreeMap<String, crate::config::ProviderModelConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_error: Option<String>,
    pub health_verified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health_error: Option<String>,
}

/// Secret-free result of an explicit operator check against one Provider
/// account. Account checks do not require a Model Route: OAuth establishes the
/// account first, and model discovery/selection is a separate operator step.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderAccountDiagnostic {
    pub checked_at: chrono::DateTime<chrono::Utc>,
    pub provider_instance_id: String,
    pub auth_account_id: String,
    pub protocol: String,
    pub provider_adapter: String,
    pub provider_adapter_version: String,
    pub endpoint: String,
    pub elapsed_ms: u64,
    #[serde(default)]
    pub discovered_models: Vec<String>,
    /// Exact capacity fields returned alongside the corresponding model row.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub discovered_model_profiles: BTreeMap<String, crate::config::ProviderModelConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probed_model: Option<String>,
    pub health_verified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health_error: Option<String>,
}

#[async_trait::async_trait]
pub trait Client: Send + Sync {
    /// Replace the effective Provider/Account/Route catalog for subsequent
    /// requests. Direct clients keep the conservative default; routed clients
    /// use this after control-plane mutations so a completed OAuth login is
    /// usable without restarting the Runtime.
    fn replace_provider_catalog(&self, _config: &crate::config::AppConfig) -> Result<(), String> {
        Err("当前模型客户端不支持运行期更新 Provider 路由".to_string())
    }

    /// Attach the Runtime's provider authentication authority after Secret
    /// Store and durable storage have both been constructed. Routed clients
    /// use it to materialize OAuth authorization for one immutable binding.
    fn attach_provider_auth_manager(
        &self,
        _manager: Arc<crate::provider::auth::ProviderAuthManager>,
    ) {
    }

    /// Attach the Runtime's durable provider-account authority after physical
    /// storage has been constructed. Direct clients intentionally ignore it;
    /// routed clients use it for affinity, cooldown and refresh fencing.
    fn attach_provider_account_state_store(
        &self,
        _store: Arc<dyn crate::memory::ProviderAccountStateStore>,
    ) {
    }

    /// Stable Runtime resource identity used for shared backoff and durable
    /// Objective waits.  Custom clients may keep the conservative default;
    /// first-class protocol adapters include endpoint, protocol and model.
    fn provider_resource_key(&self) -> String {
        "model-provider:default".to_string()
    }

    /// Stable Runtime resource identity for one already-bound physical
    /// request. Routing and model selection may change while a request is in
    /// flight, so recovery attribution must use the immutable binding rather
    /// than recomputing the process-wide current selection afterwards.
    fn provider_resource_key_for_binding(&self, binding: &ModelAttemptBinding) -> String {
        binding.provider_instance_id.clone()
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

    /// Resolve one immutable physical binding before request-state persistence.
    /// Basic clients return a single-resource binding; routed clients override
    /// this to choose a Provider Instance and Auth Account.
    async fn bind_model_attempt(
        &self,
        _request: &ModelRequestContext,
    ) -> Result<ModelAttemptBinding, ModelAttemptBindingError> {
        let model = self.model().unwrap_or_else(|| "unknown".to_string());
        Ok(ModelAttemptBinding {
            requested_alias: model.clone(),
            route_id: "direct".to_string(),
            route_revision: "direct-v1".to_string(),
            provider_instance_id: self.provider_resource_key(),
            auth_account_id: "direct".to_string(),
            physical_model: model,
            protocol: "custom".to_string(),
            provider_adapter: "direct-client".to_string(),
            provider_adapter_version: "1".to_string(),
            endpoint: self.provider_resource_key(),
            capabilities: Vec::new(),
            model_input_limits: ModelInputLimits::default(),
        })
    }

    /// Explicit control-plane diagnosis for one logical route and optional
    /// account. Implementations must not silently change the process-wide
    /// selected model while running the probe.
    async fn diagnose_model_route(
        &self,
        _alias: &str,
        _account_id: Option<&str>,
    ) -> Result<ModelRouteDiagnostic, Box<dyn std::error::Error + Send + Sync>> {
        Err("当前模型客户端不支持 Model Route 诊断".into())
    }

    /// Discover and optionally probe one Provider account without requiring a
    /// pre-existing Model Route.
    async fn diagnose_provider_account(
        &self,
        _account_id: &str,
        _model: Option<&str>,
    ) -> Result<ProviderAccountDiagnostic, Box<dyn std::error::Error + Send + Sync>> {
        Err("当前模型客户端不支持 Provider Account 诊断".into())
    }

    /// Measures a complete Prompt locally before completion. Implementations must not add remote
    /// requests to core evaluation.
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

    /// Carries this turn's pre-request measurement so protocol adapters can feed usage back into
    /// subsequent local estimates.
    async fn create_completion_measured(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
        _measurement: Option<PromptTokenCount>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        self.create_completion(messages, tools).await
    }

    /// Unified streaming entry point. Adapters with native streaming should override this method;
    /// other implementations get lossless atomic fallback while callers consume normalized Events.
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

    /// Execute against a previously persisted immutable binding. Implementors
    /// that expose only one physical client can safely use the default.
    async fn create_completion_bound_stream(
        &self,
        _binding: &ModelAttemptBinding,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
        measurement: Option<PromptTokenCount>,
        stream: ModelStreamSender,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        self.create_completion_measured_stream(messages, tools, measurement, stream)
            .await
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

    /// Probe the logical Provider resource represented by an immutable
    /// binding. Single-resource clients can use their ordinary probe; routed
    /// clients must not let a later model selection redirect the probe, while
    /// they may still apply that route's configured account failover policy.
    async fn probe_health_bound(
        &self,
        _binding: &ModelAttemptBinding,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.probe_health().await
    }
}
