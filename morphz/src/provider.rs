use crate::config::{
    AppConfig, CredentialConfig, CredentialSource, LlmConfig, ModelProtocol, ProviderConfig,
    ProviderModelConfig,
};
use crate::llm::{
    model_attachments, provider_continuation, Client, Message, ModelAttachment, ModelFailure,
    ModelFailureKind, ModelStreamEvent, ModelStreamSender, ModelUsage, PromptTokenAccuracy,
    PromptTokenCount, ProviderContinuation, ReasoningEffort, Response, ToolCallRepr,
    ToolDefinition,
};
use base64::Engine;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, RETRY_AFTER};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

pub mod auth;
pub mod control;
pub mod routing;

pub(crate) type ProviderError = Box<dyn std::error::Error + Send + Sync>;
pub type ConfiguredClient = (Arc<dyn Client>, SelectedProvider);

// ChatGPT's Codex catalog endpoint is versioned independently from Morphz.
// Keep this compatibility value aligned with the Codex request headers and
// allow operators to advance it without rebuilding if the upstream raises its
// minimum client version.
const CODEX_CLIENT_VERSION: &str = "0.144.4";

fn codex_client_version() -> String {
    std::env::var("MORPHZ_CODEX_CLIENT_VERSION")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| CODEX_CLIENT_VERSION.to_string())
}

#[derive(Debug, Clone)]
pub struct SelectedProvider {
    pub id: String,
    pub protocol: ModelProtocol,
    pub base_url: String,
    pub model: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProviderProbe {
    pub provider: String,
    pub protocol: String,
    pub base_url: String,
    pub models_discovered: usize,
    pub selected_model_available: Option<bool>,
    pub completion_stream_verified: bool,
    pub normalized_stream_events: usize,
    pub tool_call_verified: bool,
    pub catalog_error: Option<String>,
}

/// One model row returned by the Provider's catalog endpoint. Capacity fields
/// are copied only when the response contains an explicit numeric field; no
/// model-name lookup table or inferred default participates in discovery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DiscoveredProviderModel {
    pub id: String,
    pub profile: ProviderModelConfig,
}

fn positive_usize(value: Option<&Value>) -> Option<usize> {
    value
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0)
}

fn discovered_model_profile(row: &Value, protocol: ModelProtocol) -> ProviderModelConfig {
    let context_window_tokens = ["context_window_tokens", "context_window", "context_length"]
        .into_iter()
        .find_map(|field| positive_usize(row.get(field)));
    let max_input_tokens = positive_usize(row.get("max_input_tokens")).or_else(|| {
        (protocol == ModelProtocol::GeminiContent)
            .then(|| positive_usize(row.get("inputTokenLimit")))
            .flatten()
    });
    let max_output_tokens = positive_usize(row.get("max_output_tokens")).or_else(|| {
        (protocol == ModelProtocol::GeminiContent)
            .then(|| positive_usize(row.get("outputTokenLimit")))
            .flatten()
    });
    // These fields are consumed only when a service returns them explicitly.
    // There is intentionally no model-name table or inferred visual limit.
    let max_input_attachments = positive_usize(row.get("max_input_attachments"));
    let max_input_attachment_bytes = positive_usize(row.get("max_input_attachment_bytes"));
    let max_input_attachment_total_bytes =
        positive_usize(row.get("max_input_attachment_total_bytes"));
    ProviderModelConfig {
        context_window_tokens,
        max_input_tokens,
        max_output_tokens,
        max_input_attachments,
        max_input_attachment_bytes,
        max_input_attachment_total_bytes,
    }
}

pub fn build_configured_client(
    app: &AppConfig,
    provider_override: Option<&str>,
    model_override: Option<&str>,
) -> Result<ConfiguredClient, ProviderError> {
    // Normal Runtime startup always uses the routed client, including legacy
    // `providers + llm` configurations. `EffectiveProviderCatalog` already
    // normalizes that compatibility input into Provider/Account/Route objects;
    // keeping a direct `ProtocolClient` here made first-run OAuth setup unable
    // to hot-apply the newly created route until the process restarted.
    // Explicit provider overrides remain direct because they are used by
    // one-shot operator probes and intentionally bypass the active route.
    if provider_override.is_none() {
        let alias = model_override.unwrap_or(&app.llm.model).trim().to_string();
        if alias.is_empty() {
            return Err("模型别名不能为空".into());
        }
        let client = routing::RoutedClient::new(app, alias)?;
        let binding = client.primary_binding()?;
        let protocol = match binding.protocol.as_str() {
            "openai-responses" => ModelProtocol::OpenaiResponses,
            "openai-chat" => ModelProtocol::OpenaiChat,
            "anthropic-messages" => ModelProtocol::AnthropicMessages,
            "gemini-content" => ModelProtocol::GeminiContent,
            value => return Err(format!("Model Route 返回未知协议 '{value}'").into()),
        };
        let selected = SelectedProvider {
            id: binding.provider_instance_id.clone(),
            protocol,
            base_url: binding.endpoint.clone(),
            model: binding.requested_alias.clone(),
        };
        return Ok((Arc::new(client), selected));
    }
    let provider_id = provider_override
        .map(str::to_string)
        .or_else(|| app.llm.provider.clone())
        .ok_or("尚未选择模型 Provider；请先运行 `morphz setup`")?;
    let provider = app
        .providers
        .get(&provider_id)
        .ok_or_else(|| format!("Provider '{provider_id}' 未在用户配置中定义"))?;
    if provider.base_url.trim().is_empty() {
        return Err(format!("Provider '{provider_id}' 的 base_url 不能为空").into());
    }
    let model = model_override.unwrap_or(&app.llm.model).trim().to_string();
    if model.is_empty() {
        return Err("模型名称不能为空".into());
    }
    let credential = resolve_provider_credential(app, provider)?;
    let client = ProtocolClient::new(provider, model.clone(), credential, &app.llm)?;
    let selected = SelectedProvider {
        id: provider_id,
        protocol: provider.protocol,
        base_url: provider.base_url.clone(),
        model,
    };
    Ok((Arc::new(client), selected))
}

fn resolve_provider_credential(
    app: &AppConfig,
    provider: &ProviderConfig,
) -> Result<Option<String>, ProviderError> {
    let Some(reference) = provider.credential.as_deref() else {
        return Ok(None);
    };
    let credential = app
        .credentials
        .get(reference)
        .ok_or_else(|| format!("Provider 引用了不存在的 Credential '{reference}'"))?;
    resolve_credential(reference, credential)
}

pub(crate) fn resolve_credential(
    id: &str,
    credential: &CredentialConfig,
) -> Result<Option<String>, ProviderError> {
    match credential.source {
        CredentialSource::None => Ok(None),
        CredentialSource::Env => {
            let name = credential
                .name
                .as_deref()
                .ok_or_else(|| format!("Credential '{id}' 缺少环境变量名称"))?;
            let value = std::env::var(name)
                .map_err(|_| format!("Credential '{id}' 需要环境变量 {name}"))?;
            if value.trim().is_empty() {
                Err(format!("Credential '{id}' 的环境变量 {name} 为空").into())
            } else {
                Ok(Some(value))
            }
        }
        CredentialSource::Keychain => {
            let account = credential.name.as_deref().unwrap_or(id);
            let service = credential.service.as_deref().unwrap_or("morphz");
            let value = keyring::Entry::new(service, account)?.get_password()?;
            if value.trim().is_empty() {
                Err(format!("Credential '{id}' 的 Keychain 值为空").into())
            } else {
                Ok(Some(value))
            }
        }
        CredentialSource::Command => resolve_command_credential(id, &credential.command),
    }
}

fn resolve_command_credential(
    id: &str,
    command: &[String],
) -> Result<Option<String>, ProviderError> {
    let executable = command
        .first()
        .ok_or_else(|| format!("Credential '{id}' 的 command 为空"))?;
    let mut child = Command::new(executable)
        .args(&command[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait()? {
            if !status.success() {
                return Err(format!("Credential '{id}' Helper 退出状态为 {status}").into());
            }
            let mut value = String::new();
            if let Some(mut stdout) = child.stdout.take() {
                stdout.read_to_string(&mut value)?;
            }
            let value = value.trim().to_string();
            if value.is_empty() {
                return Err(format!("Credential '{id}' Helper 返回了空值").into());
            }
            return Ok(Some(value));
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Credential '{id}' Helper 超过 5 秒未完成").into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

pub fn store_keychain_credential(
    service: &str,
    account: &str,
    secret: &str,
) -> Result<(), ProviderError> {
    if secret.is_empty() {
        return Err("拒绝把空凭证写入 Keychain".into());
    }
    keyring::Entry::new(service, account)?.set_password(secret)?;
    Ok(())
}

pub fn delete_keychain_credential(service: &str, account: &str) -> Result<(), ProviderError> {
    keyring::Entry::new(service, account)?.delete_credential()?;
    Ok(())
}

pub(crate) struct ProtocolClient {
    http: reqwest::Client,
    protocol: ModelProtocol,
    adapter: String,
    base_url: String,
    model: RwLock<String>,
    credential: Option<String>,
    headers: HeaderMap,
    max_retries: u32,
    initial_backoff_secs: u64,
    stream_idle_timeout: Duration,
    first_byte_timeout: Duration,
    max_output_tokens: Option<u32>,
    reasoning_effort: RwLock<Option<ReasoningEffort>>,
    usage_anchors: Mutex<HashMap<u64, PromptUsageAnchor>>,
}

fn boxed_model_failure(failure: ModelFailure) -> ProviderError {
    Box::new(failure)
}

fn retry_after_seconds(headers: &HeaderMap) -> Option<u64> {
    headers
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
}

fn provider_error_code(body: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(body).ok()?;
    let code_from = |object: &Value| {
        ["code", "type", "status"]
            .into_iter()
            .find_map(|key| match object.get(key) {
                Some(Value::String(value)) if !value.trim().is_empty() => Some(value.clone()),
                Some(Value::Number(value)) => Some(value.to_string()),
                _ => None,
            })
    };
    value
        .get("error")
        .filter(|error| error.is_object())
        .and_then(code_from)
        .or_else(|| code_from(&value))
}

fn http_model_failure(
    status: reqwest::StatusCode,
    body: String,
    retry_after: Option<u64>,
) -> ModelFailure {
    let message = format!("Provider returned HTTP {status}: {body}");
    let semantic = ModelFailure::classify_message(message.clone());
    let provider_code = provider_error_code(&body);
    let kind = if semantic.kind == ModelFailureKind::ContextLimit {
        ModelFailureKind::ContextLimit
    } else if semantic.kind == ModelFailureKind::QuotaExhausted
        || provider_code.as_deref().is_some_and(|code| {
            matches!(
                code,
                "subscription:free-usage-exhausted"
                    | "free-usage-exhausted"
                    | "insufficient_quota"
                    | "quota_exceeded"
                    | "usage_limit_reached"
            )
        })
    {
        ModelFailureKind::QuotaExhausted
    } else if status.as_u16() == 429 {
        ModelFailureKind::RateLimited
    } else if matches!(status.as_u16(), 401 | 403) {
        ModelFailureKind::Authentication
    } else if status.is_server_error() {
        ModelFailureKind::ServerUnavailable
    } else if status.is_client_error() {
        ModelFailureKind::InvalidModelOrRequest
    } else {
        semantic.kind
    };
    ModelFailure::new(kind, message)
        .with_http_status(status.as_u16())
        .with_provider_code(provider_code)
        .with_retry_after(retry_after)
}

fn request_model_failure(error: reqwest::Error) -> ModelFailure {
    let kind = if error.is_timeout() {
        ModelFailureKind::StreamIdleTimeout
    } else if error.is_connect() || error.is_request() || error.is_body() {
        ModelFailureKind::TransientNetwork
    } else {
        ModelFailure::classify_message(error.to_string()).kind
    };
    ModelFailure::new(kind, error.to_string())
}

/// Provider-local retries cover only the short request-establishment window.
/// Respect an explicit Retry-After as a lower bound and add bounded jitter so
/// concurrent Activations do not all hit the same endpoint on one clock edge.
/// Longer outage coordination is owned by the Runtime-wide recovery gate.
fn provider_retry_delay(
    exponential: Duration,
    retry_after_secs: Option<u64>,
    attempt: u32,
) -> Duration {
    const MAX_LOCAL_BACKOFF_SECS: u64 = 300;
    let base_millis = exponential
        .min(Duration::from_secs(MAX_LOCAL_BACKOFF_SECS))
        .as_millis();
    let entropy = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.subsec_nanos() as u64)
        .unwrap_or_default()
        ^ u64::from(attempt).wrapping_mul(0x9e37_79b9);
    // 80%..120% inclusive. Retry-After remains an exact lower bound.
    let jitter_percent = 80_u128 + u128::from(entropy % 41);
    let jittered_millis = base_millis.saturating_mul(jitter_percent) / 100;
    let retry_after_millis = retry_after_secs.unwrap_or_default().saturating_mul(1_000) as u128;
    Duration::from_millis(
        u64::try_from(jittered_millis.max(retry_after_millis)).unwrap_or(u64::MAX),
    )
}

#[derive(Debug, Clone, Copy)]
struct PromptUsageAnchor {
    base_estimate_tokens: usize,
    actual_prompt_tokens: usize,
}

pub(crate) fn supported_reasoning_efforts_for_model(
    adapter: &str,
    model: &str,
) -> Option<&'static [ReasoningEffort]> {
    if adapter != "xai-subscription" {
        return None;
    }

    let normalized = model.trim().to_ascii_lowercase();
    if normalized == "grok-4.5" || normalized.starts_with("grok-4.5-") {
        return Some(&[
            ReasoningEffort::Low,
            ReasoningEffort::Medium,
            ReasoningEffort::High,
        ]);
    }
    if normalized == "grok-4.3" || normalized.starts_with("grok-4.3-") {
        return Some(&[
            ReasoningEffort::Off,
            ReasoningEffort::Low,
            ReasoningEffort::Medium,
            ReasoningEffort::High,
        ]);
    }
    None
}

pub(crate) fn normalize_reasoning_effort_for_model(
    adapter: &str,
    model: &str,
    effort: Option<ReasoningEffort>,
) -> Option<ReasoningEffort> {
    if adapter != "xai-subscription" {
        return effort;
    }

    // xAI's OAuth catalog currently reports only whether an effort dial is
    // supported; it does not publish the accepted vocabulary for every
    // physical model. Keep this compatibility rule model-scoped. Native
    // reasoning models outside this allowlist must receive no `effort` field:
    // several Grok models reason by default but reject the dial with HTTP 400.
    let normalized = model.trim().to_ascii_lowercase();
    let configurable = normalized == "grok-latest"
        || normalized == "grok-4.3"
        || normalized.starts_with("grok-4.3-")
        || normalized == "grok-4.5"
        || normalized.starts_with("grok-4.5-");
    if !configurable {
        return None;
    }

    match effort {
        // Morphz's provider-neutral `max` means the strongest level available
        // on the selected physical model. Grok 4.3/4.5 call that level `high`.
        Some(ReasoningEffort::Max) => Some(ReasoningEffort::High),
        // Grok 4.5 cannot disable reasoning. Omitting the field preserves its
        // declared provider default instead of sending an invalid `none`.
        Some(ReasoningEffort::Off)
            if normalized == "grok-4.5" || normalized.starts_with("grok-4.5-") =>
        {
            None
        }
        other => other,
    }
}

impl ProtocolClient {
    pub(crate) fn new(
        provider: &ProviderConfig,
        model: String,
        credential: Option<String>,
        llm: &LlmConfig,
    ) -> Result<Self, ProviderError> {
        Self::new_with_adapter(provider, "", model, credential, llm)
    }

    pub(crate) fn new_with_adapter(
        provider: &ProviderConfig,
        adapter: &str,
        model: String,
        credential: Option<String>,
        llm: &LlmConfig,
    ) -> Result<Self, ProviderError> {
        let mut headers = HeaderMap::new();
        for (name, value) in &provider.headers {
            headers.insert(
                HeaderName::from_bytes(name.as_bytes())?,
                HeaderValue::from_str(value)?,
            );
        }
        for (name, variable) in &provider.env_headers {
            let value = std::env::var(variable)
                .map_err(|_| format!("Provider Header '{name}' 需要环境变量 {variable}"))?;
            headers.insert(
                HeaderName::from_bytes(name.as_bytes())?,
                HeaderValue::from_str(&value)?,
            );
        }
        let mut http_builder = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(llm.connect_timeout_secs.max(1)));
        // Antigravity rejects or intermittently stalls HTTP/2 requests. This
        // is a physical-provider compatibility requirement, not a Gemini
        // protocol rule, so it is scoped to the adapter.
        if adapter == "google-antigravity" {
            http_builder = http_builder.http1_only();
        }
        let http = http_builder.build()?;
        Ok(Self {
            http,
            protocol: provider.protocol,
            adapter: adapter.to_string(),
            base_url: provider.base_url.trim_end_matches('/').to_string(),
            model: RwLock::new(model),
            credential,
            headers,
            max_retries: llm.max_retries.max(1),
            initial_backoff_secs: llm.initial_backoff_secs,
            stream_idle_timeout: Duration::from_secs(llm.stream_idle_timeout_secs.max(1)),
            first_byte_timeout: Duration::from_secs(llm.first_byte_timeout_secs.max(1)),
            max_output_tokens: llm.max_output_tokens,
            reasoning_effort: RwLock::new(llm.reasoning_effort),
            usage_anchors: Mutex::new(HashMap::new()),
        })
    }

    fn model_snapshot(&self) -> String {
        self.model
            .read()
            .map(|model| model.clone())
            .unwrap_or_default()
    }

    fn endpoint_for(&self, streaming: bool, model: &str) -> Result<String, ProviderError> {
        if self.adapter == "google-antigravity" {
            let root = self
                .base_url
                .trim_end_matches('/')
                .trim_end_matches("/v1internal");
            let method = if streaming {
                "streamGenerateContent?alt=sse"
            } else {
                "generateContent"
            };
            return Ok(format!("{root}/v1internal:{method}"));
        }
        let endpoint = match self.protocol {
            ModelProtocol::OpenaiResponses => format!("{}/responses", self.base_url),
            ModelProtocol::OpenaiChat => format!("{}/chat/completions", self.base_url),
            ModelProtocol::AnthropicMessages => format!("{}/messages", self.base_url),
            ModelProtocol::GeminiContent => {
                let mut url = reqwest::Url::parse(&self.base_url)?;
                let method = if streaming {
                    "streamGenerateContent"
                } else {
                    "generateContent"
                };
                url.path_segments_mut()
                    .map_err(|_| "Gemini Provider base_url 不能作为分层 URL")?
                    .push("models")
                    .push(&format!("{model}:{method}"));
                if streaming {
                    url.query_pairs_mut().append_pair("alt", "sse");
                }
                url.to_string()
            }
        };
        Ok(endpoint)
    }

    fn request_for_model(
        &self,
        model: &str,
        messages: &[Message],
        tools: &[ToolDefinition],
    ) -> Value {
        let reasoning_effort = self
            .reasoning_effort
            .read()
            .map(|effort| *effort)
            .unwrap_or(None);
        let reasoning_effort =
            normalize_reasoning_effort_for_model(self.adapter.as_str(), model, reasoning_effort);
        let request = build_request(
            self.protocol,
            model,
            self.max_output_tokens,
            reasoning_effort,
            messages,
            tools,
        );
        self.adapt_request(model, request)
    }

    fn adapt_request(&self, model: &str, request: Value) -> Value {
        if self.adapter == "openai-codex" {
            return adapt_codex_request(request);
        }
        if self.adapter != "google-antigravity" {
            return request;
        }
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        request.to_string().hash(&mut hasher);
        let session_id = format!("-{}", hasher.finish() & i64::MAX as u64);
        let request_nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let mut nested = request;
        if let Some(object) = nested.as_object_mut() {
            object.remove("safetySettings");
            object.insert("sessionId".to_string(), json!(session_id));
        }
        let mut envelope = json!({
            "model": model,
            "userAgent": "antigravity",
            "requestType": "agent",
            "requestId": format!("agent-{request_nonce:x}"),
            "request": nested,
        });
        if let Some(project) = self
            .headers
            .get("x-goog-user-project")
            .and_then(|value| value.to_str().ok())
            .filter(|value| !value.trim().is_empty())
        {
            envelope["project"] = json!(project);
        }
        envelope
    }

    fn normalize_response(&self, event: Value) -> Value {
        if self.adapter == "google-antigravity" {
            event.get("response").cloned().unwrap_or(event)
        } else {
            event
        }
    }

    fn authorize(&self, mut request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        request = request.headers(self.headers.clone());
        if let Some(secret) = &self.credential {
            request = match self.protocol {
                ModelProtocol::OpenaiResponses | ModelProtocol::OpenaiChat => {
                    request.bearer_auth(secret)
                }
                ModelProtocol::AnthropicMessages => request
                    .header("x-api-key", secret)
                    .header("anthropic-version", "2023-06-01"),
                ModelProtocol::GeminiContent => request.header("x-goog-api-key", secret),
            };
        } else if self.protocol == ModelProtocol::AnthropicMessages {
            request = request.header("anthropic-version", "2023-06-01");
        }
        request
    }

    async fn send(&self, model: &str, body: &Value) -> Result<Value, ProviderError> {
        let endpoint = self.endpoint_for(false, model)?;
        let mut attempt = 0;
        let mut backoff = Duration::from_secs(self.initial_backoff_secs);
        loop {
            attempt += 1;
            let mut retry_after = None;
            let request = self.authorize(self.http.post(&endpoint));
            let send_result =
                match tokio::time::timeout(self.stream_idle_timeout, request.json(body).send())
                    .await
                {
                    Ok(Ok(response)) => Ok(response),
                    Ok(Err(error)) => Err(request_model_failure(error)),
                    Err(_) => Err(ModelFailure::new(
                        ModelFailureKind::StreamIdleTimeout,
                        format!(
                            "{} Provider 等待响应头超过 {} 秒 idle timeout",
                            self.protocol.as_str(),
                            self.stream_idle_timeout.as_secs()
                        ),
                    )),
                };
            match send_result {
                Ok(response) => {
                    let status = response.status();
                    if status.is_success() {
                        let body =
                            match tokio::time::timeout(self.stream_idle_timeout, response.json())
                                .await
                            {
                                Ok(Ok(body)) => body,
                                Ok(Err(error)) => {
                                    return Err(boxed_model_failure(request_model_failure(error)));
                                }
                                Err(_) => {
                                    return Err(boxed_model_failure(ModelFailure::new(
                                        ModelFailureKind::StreamIdleTimeout,
                                        format!(
                                            "{} Provider 响应体超过 {} 秒没有完成",
                                            self.protocol.as_str(),
                                            self.stream_idle_timeout.as_secs()
                                        ),
                                    )));
                                }
                            };
                        return Ok(body);
                    }
                    retry_after = retry_after_seconds(response.headers());
                    let text = response.text().await.unwrap_or_default();
                    let failure = http_model_failure(status, text, retry_after);
                    let retryable = failure.kind.is_provider_transient();
                    if retryable && attempt < self.max_retries {
                        tracing::warn!(
                            protocol = self.protocol.as_str(),
                            %status,
                            failure_kind = failure.kind.as_str(),
                            attempt,
                            max = self.max_retries,
                        event_code = "provider.request.retrying_status",
                        "Provider request failed; preparing to retry"
                        );
                    } else {
                        return Err(boxed_model_failure(failure));
                    }
                }
                Err(failure)
                    if failure.kind.is_provider_transient() && attempt < self.max_retries =>
                {
                    tracing::warn!(
                        protocol = self.protocol.as_str(),
                        error = %failure,
                        failure_kind = failure.kind.as_str(),
                        attempt,
                        max = self.max_retries,
                        event_code = "provider.request.retrying_network",
                        "Provider network error; preparing to retry"
                    );
                }
                Err(failure) => return Err(boxed_model_failure(failure)),
            }
            let delay = provider_retry_delay(backoff, retry_after, attempt);
            tracing::debug!(
                protocol = self.protocol.as_str(),
                attempt,
                delay_ms = delay.as_millis(),
                retry_after_secs = retry_after,
                event_code = "provider.request.local_backoff",
                "Applying local Provider request retry backoff"
            );
            tokio::time::sleep(delay).await;
            backoff = backoff.saturating_mul(2);
        }
    }

    async fn send_stream(
        &self,
        model: &str,
        body: &Value,
        measurement: Option<&PromptTokenCount>,
        stream: &ModelStreamSender,
    ) -> Result<Response, ProviderError> {
        let endpoint = self.endpoint_for(true, model)?;
        let mut streaming_body = body.clone();
        if self.protocol != ModelProtocol::GeminiContent {
            streaming_body["stream"] = Value::Bool(true);
        }
        if self.protocol == ModelProtocol::OpenaiChat {
            streaming_body["stream_options"] = json!({"include_usage": true});
        }

        // Retrying is safe until a successful response is accepted and stream
        // events begin. Once any event has been consumed we must not replay the
        // request, because that could duplicate model output or tool calls.
        let mut attempt = 0;
        let mut backoff = Duration::from_secs(self.initial_backoff_secs);
        let response = loop {
            attempt += 1;
            let mut retry_after = None;
            let request = self.authorize(self.http.post(&endpoint));
            let send_result = match tokio::time::timeout(
                self.first_byte_timeout,
                request.json(&streaming_body).send(),
            )
            .await
            {
                Ok(Ok(response)) => Ok(response),
                Ok(Err(error)) => Err(request_model_failure(error)),
                Err(_) => Err(ModelFailure::new(
                    ModelFailureKind::FirstByteTimeout,
                    format!(
                        "{} Provider first byte timeout：等待 HTTP 响应头超过 {} 秒",
                        self.protocol.as_str(),
                        self.first_byte_timeout.as_secs()
                    ),
                )),
            };
            match send_result {
                Ok(response) if response.status().is_success() => break response,
                Ok(response) => {
                    let status = response.status();
                    retry_after = retry_after_seconds(response.headers());
                    let text = response.text().await.unwrap_or_default();
                    let failure = http_model_failure(status, text, retry_after);
                    let retryable = failure.kind.is_provider_transient();
                    if !retryable || attempt >= self.max_retries {
                        return Err(boxed_model_failure(failure));
                    }
                    tracing::warn!(
                        protocol = self.protocol.as_str(),
                        %status,
                        failure_kind = failure.kind.as_str(),
                        attempt,
                        max = self.max_retries,
                        event_code = "provider.stream_open.retrying_status",
                        "Provider stream establishment failed; preparing to retry"
                    );
                }
                Err(failure)
                    if failure.kind.is_provider_transient() && attempt < self.max_retries =>
                {
                    tracing::warn!(
                        protocol = self.protocol.as_str(),
                        error = %failure,
                        failure_kind = failure.kind.as_str(),
                        attempt,
                        max = self.max_retries,
                        event_code = "provider.stream_open.retrying_network",
                        "Provider stream establishment encountered a network error; preparing to retry"
                    );
                }
                Err(failure) => return Err(boxed_model_failure(failure)),
            }
            let delay = provider_retry_delay(backoff, retry_after, attempt);
            tracing::debug!(
                protocol = self.protocol.as_str(),
                attempt,
                delay_ms = delay.as_millis(),
                retry_after_secs = retry_after,
                event_code = "provider.stream_open.local_backoff",
                "Applying local Provider stream-establishment retry backoff"
            );
            tokio::time::sleep(delay).await;
            backoff = backoff.saturating_mul(2);
        };

        let mut accumulator = StreamAccumulator::default();
        let mut bytes = response.bytes_stream();
        let mut pending = Vec::new();
        let mut received_body_bytes = false;
        loop {
            let timeout = if received_body_bytes {
                self.stream_idle_timeout
            } else {
                self.first_byte_timeout
            };
            let chunk = tokio::time::timeout(timeout, bytes.next())
                .await
                .map_err(|_| -> ProviderError {
                    let (kind, message) = if received_body_bytes {
                        (
                            ModelFailureKind::StreamStalled,
                            format!(
                                "{} Provider stream stalled：连续 {} 秒没有收到后续响应体字节",
                                self.protocol.as_str(),
                                timeout.as_secs()
                            ),
                        )
                    } else {
                        (
                            ModelFailureKind::FirstByteTimeout,
                            format!(
                                "{} Provider first byte timeout：收到 HTTP 响应头后 {} 秒仍无响应体字节",
                                self.protocol.as_str(),
                                timeout.as_secs()
                            ),
                        )
                    };
                    boxed_model_failure(ModelFailure::new(
                        kind,
                        message,
                    ))
                })?;
            let Some(chunk) = chunk else {
                break;
            };
            let chunk = chunk.map_err(|error| boxed_model_failure(request_model_failure(error)))?;
            if !chunk.is_empty() {
                received_body_bytes = true;
            }
            pending.extend_from_slice(&chunk);
            while let Some((frame, consumed)) = take_sse_frame(&pending) {
                pending.drain(..consumed);
                if let Some(data) = sse_data(&frame)? {
                    if data == "[DONE]" {
                        accumulator.terminal = true;
                        continue;
                    }
                    let event: Value = serde_json::from_str(&data).map_err(|error| {
                        format!("{} SSE 事件不是合法 JSON: {error}", self.protocol.as_str())
                    })?;
                    accumulator.apply(self.protocol, self.normalize_response(event), stream)?;
                }
            }
        }
        if !pending.is_empty() {
            if let Some(data) = sse_data(&pending)? {
                if data != "[DONE]" {
                    let event: Value = serde_json::from_str(&data)?;
                    accumulator.apply(self.protocol, self.normalize_response(event), stream)?;
                }
            }
        }
        let actual_prompt_tokens = accumulator.prompt_tokens;
        let response = accumulator.finish(stream)?;
        if let (Some(measurement), Some(actual_prompt_tokens)) = (measurement, actual_prompt_tokens)
        {
            self.observe_completion_usage(model, body, measurement, actual_prompt_tokens);
        }
        Ok(response)
    }

    fn observe_completion_usage(
        &self,
        model: &str,
        body: &Value,
        measurement: &PromptTokenCount,
        actual_prompt_tokens: u64,
    ) {
        let (Some(calibration_key), Some(calibration_shape)) =
            (measurement.calibration_key, measurement.calibration_shape)
        else {
            return;
        };
        let actual_shape = prompt_calibration_shape(self.protocol, model, body);
        if measurement.accuracy == PromptTokenAccuracy::Exact || calibration_shape != actual_shape {
            return;
        }

        let base_estimate_tokens = serialized_request_token_estimate(body);
        let actual_prompt_tokens = usize::try_from(actual_prompt_tokens).unwrap_or(usize::MAX);
        if let Ok(mut anchors) = self.usage_anchors.lock() {
            anchors.insert(
                calibration_key,
                PromptUsageAnchor {
                    base_estimate_tokens,
                    actual_prompt_tokens,
                },
            );
        }
        tracing::info!(
            protocol = self.protocol.as_str(),
            model,
            predicted_prompt_tokens = measurement.tokens,
            actual_prompt_tokens,
            base_estimate_tokens,
            absolute_error = measurement.tokens.abs_diff(actual_prompt_tokens),
            event_code = "provider.prompt_calibration.usage_recorded",
            "Recorded completion usage in the Prompt-token calibrator"
        );
    }

    pub(crate) async fn list_model_catalog(
        &self,
    ) -> Result<Vec<DiscoveredProviderModel>, ProviderError> {
        let mut endpoint = reqwest::Url::parse(&format!("{}/models", self.base_url))?;
        if self.adapter == "openai-codex" {
            let client_version = codex_client_version();
            endpoint
                .query_pairs_mut()
                .append_pair("client_version", client_version.trim());
        }
        let response = tokio::time::timeout(
            self.stream_idle_timeout,
            self.authorize(self.http.get(endpoint)).send(),
        )
        .await
        .map_err(|_| {
            format!(
                "{} 模型目录等待响应超过 {} 秒",
                self.protocol.as_str(),
                self.stream_idle_timeout.as_secs()
            )
        })??;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(format!(
                "{} 模型目录返回 HTTP {}: {}",
                self.protocol.as_str(),
                status,
                text
            )
            .into());
        }
        let value: Value = response.json().await?;
        let rows = value
            .get("data")
            .or_else(|| value.get("models"))
            .and_then(Value::as_array)
            .ok_or_else(|| format!("{} 模型目录缺少 data/models 数组", self.protocol.as_str()))?;
        let mut models = rows
            .iter()
            .filter_map(|row| {
                let id = row
                    .get("id")
                    .or_else(|| row.get("name"))
                    .or_else(|| row.get("slug"))
                    .and_then(Value::as_str)?;
                Some(DiscoveredProviderModel {
                    id: id.strip_prefix("models/").unwrap_or(id).to_string(),
                    profile: discovered_model_profile(row, self.protocol),
                })
            })
            .collect::<Vec<_>>();
        if self.adapter == "openai-codex" {
            let mut seen = HashSet::new();
            models.retain(|model| seen.insert(model.id.clone()));
        } else {
            models.sort_by(|left, right| left.id.cmp(&right.id));
            models.dedup_by(|left, right| left.id == right.id);
        }
        Ok(models)
    }

    pub async fn list_models(&self) -> Result<Vec<String>, ProviderError> {
        Ok(self
            .list_model_catalog()
            .await?
            .into_iter()
            .map(|model| model.id)
            .collect())
    }
}

pub async fn list_provider_models(
    app: &AppConfig,
    provider_id: &str,
) -> Result<Vec<String>, ProviderError> {
    let provider = app
        .providers
        .get(provider_id)
        .ok_or_else(|| format!("Provider '{provider_id}' 未定义"))?;
    let credential = resolve_provider_credential(app, provider)?;
    ProtocolClient::new(provider, app.llm.model.clone(), credential, &app.llm)?
        .list_models()
        .await
}

/// Discover a model catalog from setup credentials without registering a
/// Provider, Auth Account, credential, or route. The API key lives only in
/// this request and is dropped with the temporary protocol client.
pub(crate) async fn discover_protocol_models(
    protocol: ModelProtocol,
    base_url: &str,
    api_key: &str,
) -> Result<Vec<String>, ProviderError> {
    let base_url = base_url.trim().trim_end_matches('/');
    if base_url.is_empty() {
        return Err("Provider URL 不能为空".into());
    }
    if api_key.trim().is_empty() {
        return Err("API Key 不能为空".into());
    }
    let provider = ProviderConfig {
        protocol,
        base_url: base_url.to_string(),
        ..ProviderConfig::default()
    };
    ProtocolClient::new(
        &provider,
        String::new(),
        Some(api_key.trim().to_string()),
        &LlmConfig::default(),
    )?
    .list_models()
    .await
}

pub async fn probe_provider(
    app: &AppConfig,
    provider_id: &str,
    model: Option<&str>,
) -> Result<ProviderProbe, ProviderError> {
    let provider = app
        .providers
        .get(provider_id)
        .ok_or_else(|| format!("Provider '{provider_id}' 未定义"))?;
    let (models, catalog_error) = match list_provider_models(app, provider_id).await {
        Ok(models) => (models, None),
        Err(error) => (Vec::new(), Some(error.to_string())),
    };
    let selected_model_available = model.map(|model| models.iter().any(|item| item == model));
    let selected_model = model.unwrap_or(&app.llm.model).trim();
    if selected_model.is_empty() {
        return Err("Provider 测试需要模型 ID".into());
    }
    let credential = resolve_provider_credential(app, provider)?;
    let client = ProtocolClient::new(provider, selected_model.to_string(), credential, &app.llm)?;
    let probe_message = |content: &str| Message {
        role: "user".to_string(),
        content: content.to_string(),
        name: None,
        tool_call_id: None,
        tool_calls: None,
    };

    let (stream_tx, mut stream_rx) = tokio::sync::mpsc::unbounded_channel();
    let completion = client
        .create_completion_measured_stream(
            vec![probe_message(
                "Protocol health check. Reply with the plain text MORPHZ_OK and do not call tools.",
            )],
            Vec::new(),
            None,
            stream_tx,
        )
        .await?;
    let stream_events = std::iter::from_fn(|| stream_rx.try_recv().ok()).collect::<Vec<_>>();
    let completion_stream_verified = !completion.content.trim().is_empty()
        && stream_events
            .iter()
            .any(|event| matches!(event, ModelStreamEvent::Completed));

    let probe_tool = ToolDefinition {
        name: "morphz_probe".to_string(),
        description: "Protocol health-check tool. Call it exactly once when instructed."
            .to_string(),
        parameters: json!({
            "type": "object",
            "properties": {"value": {"type": "string"}},
            "required": ["value"],
            "additionalProperties": false
        }),
    };
    let (tool_tx, mut tool_rx) = tokio::sync::mpsc::unbounded_channel();
    let tool_response = client
        .create_completion_measured_stream(
            vec![probe_message(
                "Call morphz_probe exactly once with value MORPHZ_OK. Do not answer in plain text.",
            )],
            vec![probe_tool],
            None,
            tool_tx,
        )
        .await?;
    let tool_events = std::iter::from_fn(|| tool_rx.try_recv().ok()).collect::<Vec<_>>();
    let tool_call_verified = tool_response.tool_calls.iter().any(|call| {
        call.func_name == "morphz_probe"
            && serde_json::from_str::<Value>(&call.arguments)
                .ok()
                .and_then(|value| {
                    value
                        .get("value")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .as_deref()
                == Some("MORPHZ_OK")
    }) && tool_events
        .iter()
        .any(|event| matches!(event, ModelStreamEvent::ToolArgumentsDelta { .. }));
    Ok(ProviderProbe {
        provider: provider_id.to_string(),
        protocol: provider.protocol.as_str().to_string(),
        base_url: provider.base_url.clone(),
        models_discovered: models.len(),
        selected_model_available,
        completion_stream_verified,
        normalized_stream_events: stream_events.len() + tool_events.len(),
        tool_call_verified,
        catalog_error,
    })
}

#[async_trait::async_trait]
impl Client for ProtocolClient {
    fn provider_resource_key(&self) -> String {
        let model = self.model_snapshot();
        format!(
            "model-provider:{}:{}:{}",
            self.protocol.as_str(),
            self.base_url,
            model
        )
    }

    fn supports_async_cancellation(&self) -> bool {
        true
    }

    fn model(&self) -> Option<String> {
        Some(self.model_snapshot())
    }

    fn set_model(&self, model: &str) -> Result<(), String> {
        let model = model.trim();
        if model.is_empty() {
            return Err("模型名称不能为空".to_string());
        }
        *self
            .model
            .write()
            .map_err(|_| "模型配置锁已损坏".to_string())? = model.to_string();
        Ok(())
    }

    fn reasoning_effort(&self) -> Option<ReasoningEffort> {
        self.reasoning_effort
            .read()
            .map(|effort| *effort)
            .unwrap_or(None)
    }

    fn set_reasoning_effort(&self, effort: Option<ReasoningEffort>) -> Result<(), String> {
        *self
            .reasoning_effort
            .write()
            .map_err(|_| "推理深度配置锁已损坏".to_string())? = effort;
        Ok(())
    }

    async fn count_prompt_tokens(
        &self,
        scope: &str,
        messages: &[Message],
        tools: &[ToolDefinition],
    ) -> Result<Option<PromptTokenCount>, ProviderError> {
        let model = self.model_snapshot();
        let body = self.request_for_model(&model, messages, tools);
        let base_estimate_tokens = serialized_request_token_estimate(&body);
        let calibration_shape = prompt_calibration_shape(self.protocol, &model, &body);
        let calibration_key = prompt_calibration_key(scope, calibration_shape);
        let anchor = self
            .usage_anchors
            .lock()
            .ok()
            .and_then(|anchors| anchors.get(&calibration_key).copied());
        let (tokens, source, accuracy) = match anchor {
            Some(anchor) => {
                let delta = signed_token_delta(base_estimate_tokens, anchor.base_estimate_tokens);
                (
                    apply_signed_token_delta(anchor.actual_prompt_tokens, delta),
                    format!(
                        "{}-serialized-request-estimate+usage-calibration",
                        self.protocol.as_str()
                    ),
                    PromptTokenAccuracy::UsageCalibratedEstimate,
                )
            }
            None => (
                base_estimate_tokens,
                format!("{}-serialized-request-estimate", self.protocol.as_str()),
                PromptTokenAccuracy::HeuristicEstimate,
            ),
        };
        Ok(Some(PromptTokenCount {
            tokens,
            source,
            model,
            accuracy,
            base_estimate_tokens,
            calibration_key: Some(calibration_key),
            calibration_shape: Some(calibration_shape),
        }))
    }

    async fn create_completion(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
    ) -> Result<Response, ProviderError> {
        let model = self.model_snapshot();
        let request = self.request_for_model(&model, &messages, &tools);
        if self.adapter == "openai-codex" {
            // ChatGPT's Codex backend only accepts Responses requests in its
            // streaming form. Aggregate that stream here for callers using
            // the non-streaming Client API, matching the official client and
            // CLIProxyAPI compatibility boundary.
            let (stream, _events) = tokio::sync::mpsc::unbounded_channel();
            return self.send_stream(&model, &request, None, &stream).await;
        }
        let response = self.send(&model, &request).await?;
        parse_response(self.protocol, self.normalize_response(response))
    }

    async fn create_completion_measured_stream(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
        measurement: Option<PromptTokenCount>,
        stream: ModelStreamSender,
    ) -> Result<Response, ProviderError> {
        let _ = stream.send(ModelStreamEvent::Started);
        let model = self.model_snapshot();
        let request = self.request_for_model(&model, &messages, &tools);
        match self
            .send_stream(&model, &request, measurement.as_ref(), &stream)
            .await
        {
            Ok(response) => {
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

    async fn probe_health(&self) -> Result<(), ProviderError> {
        const HEALTH_PROBE_TIMEOUT: Duration = Duration::from_secs(30);
        let model = self.model_snapshot();
        let messages = [Message {
            role: "user".to_string(),
            content: "Reply with the plain text MORPHZ_OK.".to_string(),
            name: None,
            tool_call_id: None,
            tool_calls: None,
        }];
        // This request is intentionally independent from every Activation and
        // never carries Context, tools, configured long reasoning, or the
        // application's output budget.
        let body = self.adapt_request(
            &model,
            build_request(self.protocol, &model, Some(64), None, &messages, &[]),
        );
        if self.adapter == "openai-codex" {
            let (stream, _events) = tokio::sync::mpsc::unbounded_channel();
            return tokio::time::timeout(
                HEALTH_PROBE_TIMEOUT,
                self.send_stream(&model, &body, None, &stream),
            )
            .await
            .map_err(|_| {
                boxed_model_failure(ModelFailure::new(
                    ModelFailureKind::FirstByteTimeout,
                    "Codex health probe timed out",
                ))
            })?
            .map(|_| ());
        }
        let endpoint = self.endpoint_for(false, &model)?;
        let response = tokio::time::timeout(
            HEALTH_PROBE_TIMEOUT,
            self.authorize(self.http.post(&endpoint)).json(&body).send(),
        )
        .await
        .map_err(|_| {
            boxed_model_failure(ModelFailure::new(
                ModelFailureKind::FirstByteTimeout,
                "Provider health probe response header timeout",
            ))
        })?
        .map_err(|error| boxed_model_failure(request_model_failure(error)))?;
        let status = response.status();
        if !status.is_success() {
            let retry_after = retry_after_seconds(response.headers());
            let text = response.text().await.unwrap_or_default();
            return Err(boxed_model_failure(http_model_failure(
                status,
                text,
                retry_after,
            )));
        }
        let value = tokio::time::timeout(HEALTH_PROBE_TIMEOUT, response.json::<Value>())
            .await
            .map_err(|_| {
                boxed_model_failure(ModelFailure::new(
                    ModelFailureKind::FirstByteTimeout,
                    "Provider health probe first byte timeout",
                ))
            })?
            .map_err(|error| boxed_model_failure(request_model_failure(error)))?;
        // A reasoning model may legitimately spend this tiny budget on a
        // reasoning-only item or stop at its output limit. For circuit health,
        // a schema-valid successful response is sufficient; completeness and
        // instruction following belong to inference tests, not connectivity.
        let normalized = self.normalize_response(value);
        if !health_response_schema_valid(self.protocol, &normalized) {
            let _ = parse_response(self.protocol, normalized)?;
        }
        Ok(())
    }
}

fn health_response_schema_valid(protocol: ModelProtocol, value: &Value) -> bool {
    match protocol {
        ModelProtocol::OpenaiChat => value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
            .and_then(|choice| choice.get("message"))
            .is_some_and(Value::is_object),
        ModelProtocol::OpenaiResponses => {
            value.get("output").is_some_and(Value::is_array)
                || value.get("status").is_some_and(Value::is_string)
        }
        ModelProtocol::AnthropicMessages => value.get("content").is_some_and(Value::is_array),
        ModelProtocol::GeminiContent => value.get("candidates").is_some_and(Value::is_array),
    }
}

fn serialized_request_token_estimate(body: &Value) -> usize {
    let serialized = serde_json::to_string(body).unwrap_or_default();
    let ascii = serialized.chars().filter(char::is_ascii).count();
    let non_ascii = serialized.chars().count().saturating_sub(ascii);
    (ascii.saturating_add(3) / 4).saturating_add(non_ascii)
}

fn prompt_calibration_shape(protocol: ModelProtocol, model: &str, body: &Value) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    protocol.as_str().hash(&mut hasher);
    model.hash(&mut hasher);
    body.get("tools")
        .unwrap_or(&Value::Null)
        .to_string()
        .hash(&mut hasher);
    hasher.finish()
}

fn prompt_calibration_key(scope: &str, calibration_shape: u64) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    scope.hash(&mut hasher);
    calibration_shape.hash(&mut hasher);
    hasher.finish()
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

fn subtract_optional(total: Option<u64>, subset: Option<u64>) -> Option<u64> {
    match (total, subset) {
        (Some(total), Some(subset)) => Some(total.saturating_sub(subset)),
        (Some(total), None) => Some(total),
        _ => None,
    }
}

fn anthropic_usage(usage: &Value) -> ModelUsage {
    let uncached_input_tokens = usage.get("input_tokens").and_then(Value::as_u64);
    let cache_write_input_tokens = usage
        .get("cache_creation_input_tokens")
        .and_then(Value::as_u64);
    let cached_input_tokens = usage.get("cache_read_input_tokens").and_then(Value::as_u64);
    let input_tokens = [
        uncached_input_tokens,
        cache_write_input_tokens,
        cached_input_tokens,
    ]
    .into_iter()
    .flatten()
    .reduce(u64::saturating_add);
    ModelUsage {
        input_tokens,
        uncached_input_tokens,
        cached_input_tokens,
        cache_write_input_tokens,
        raw: vec![usage.clone()],
        ..ModelUsage::default()
    }
}

#[derive(Debug, Default)]
struct StreamAccumulator {
    content: String,
    tools: BTreeMap<usize, StreamingToolCall>,
    chat_reasoning_content: String,
    responses_reasoning_items: BTreeMap<usize, Value>,
    gemini_tool_index: usize,
    terminal: bool,
    prompt_tokens: Option<u64>,
    usage: ModelUsage,
}

#[derive(Debug, Default)]
struct StreamingToolCall {
    id: String,
    name: String,
    arguments: String,
    announced: bool,
    completed: bool,
}

impl StreamAccumulator {
    fn text(&mut self, text: &str, stream: &ModelStreamSender) {
        if text.is_empty() {
            return;
        }
        self.content.push_str(text);
        let _ = stream.send(ModelStreamEvent::TextDelta {
            text: text.to_string(),
        });
    }

    fn reasoning_summary(&self, text: &str, stream: &ModelStreamSender) {
        if text.is_empty() {
            return;
        }
        // Reasoning summaries are deliberately not accumulated into
        // `content`: they are an optional, ephemeral UI aid rather than part
        // of the model's final assistant message.
        let _ = stream.send(ModelStreamEvent::ReasoningSummaryDelta {
            text: text.to_string(),
        });
    }

    fn tool(
        &mut self,
        index: usize,
        id: Option<&str>,
        name: Option<&str>,
        stream: &ModelStreamSender,
    ) {
        let (started, buffered_arguments) = {
            let tool = self.tools.entry(index).or_default();
            if let Some(id) = id.filter(|value| !value.is_empty()) {
                tool.id = id.to_string();
            }
            if let Some(name) = name.filter(|value| !value.is_empty()) {
                tool.name = name.to_string();
            }

            // OpenAI Chat-compatible endpoints are allowed to split the tool
            // identity across deltas (commonly `id` first and `name` next).
            // Publishing an incomplete ToolCallStarted event is irreversible:
            // the normalized protocol has no later rename event. Delay the
            // announcement until the complete identity is known, and retain
            // any unusually early argument bytes until after that event.
            if !tool.announced && !tool.id.is_empty() && !tool.name.is_empty() {
                tool.announced = true;
                (
                    Some(ModelStreamEvent::ToolCallStarted {
                        index,
                        id: tool.id.clone(),
                        name: tool.name.clone(),
                    }),
                    (!tool.arguments.is_empty()).then(|| tool.arguments.clone()),
                )
            } else {
                (None, None)
            }
        };

        if let Some(started) = started {
            let _ = stream.send(started);
        }
        if let Some(delta) = buffered_arguments {
            let _ = stream.send(ModelStreamEvent::ToolArgumentsDelta { index, delta });
        }
    }

    fn arguments(&mut self, index: usize, delta: &str, stream: &ModelStreamSender) {
        if delta.is_empty() {
            return;
        }
        let tool = self.tools.entry(index).or_default();
        tool.arguments.push_str(delta);
        if tool.announced {
            let _ = stream.send(ModelStreamEvent::ToolArgumentsDelta {
                index,
                delta: delta.to_string(),
            });
        }
    }

    fn complete_tool(&mut self, index: usize, stream: &ModelStreamSender) {
        if let Some(tool) = self.tools.get_mut(&index) {
            if tool.announced && !tool.completed {
                tool.completed = true;
                let _ = stream.send(ModelStreamEvent::ToolCallCompleted { index });
            }
        }
    }

    fn usage(&mut self, usage: ModelUsage, stream: &ModelStreamSender) {
        if let Some(input_tokens) = usage.input_tokens {
            self.prompt_tokens = Some(input_tokens);
        }
        if usage.has_usage() {
            self.usage.merge_from(&usage);
            let _ = stream.send(ModelStreamEvent::Usage { usage });
        }
    }

    fn apply(
        &mut self,
        protocol: ModelProtocol,
        event: Value,
        stream: &ModelStreamSender,
    ) -> Result<(), ProviderError> {
        match protocol {
            ModelProtocol::OpenaiChat => self.apply_openai_chat(event, stream),
            ModelProtocol::OpenaiResponses => self.apply_openai_responses(event, stream),
            ModelProtocol::AnthropicMessages => self.apply_anthropic(event, stream),
            ModelProtocol::GeminiContent => self.apply_gemini(event, stream),
        }
    }

    fn apply_openai_chat(
        &mut self,
        event: Value,
        stream: &ModelStreamSender,
    ) -> Result<(), ProviderError> {
        if let Some(usage) = event.get("usage") {
            let input_tokens = usage.get("prompt_tokens").and_then(Value::as_u64);
            let cached_input_tokens = usage
                .pointer("/prompt_tokens_details/cached_tokens")
                .and_then(Value::as_u64);
            self.usage(
                ModelUsage {
                    input_tokens,
                    uncached_input_tokens: subtract_optional(input_tokens, cached_input_tokens),
                    cached_input_tokens,
                    output_tokens: usage.get("completion_tokens").and_then(Value::as_u64),
                    reasoning_tokens: usage
                        .pointer("/completion_tokens_details/reasoning_tokens")
                        .and_then(Value::as_u64),
                    total_tokens: usage.get("total_tokens").and_then(Value::as_u64),
                    raw: vec![usage.clone()],
                    ..ModelUsage::default()
                },
                stream,
            );
        }
        let Some(choice) = event
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|v| v.first())
        else {
            return Ok(());
        };
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            match reason {
                "stop" | "tool_calls" | "function_call" => self.terminal = true,
                "length" => return Err("OpenAI Chat 流因输出长度限制被截断".into()),
                _ => return Err(format!("OpenAI Chat 流未完成: {reason}").into()),
            }
        }
        let delta = choice.get("delta").unwrap_or(&Value::Null);
        if let Some(reasoning_content) = delta.get("reasoning_content").and_then(Value::as_str) {
            // DeepSeek Chat continuation requires this exact Provider-authored
            // value on the assistant tool-call message. It is deliberately
            // kept out of both public text and reasoning-summary UI events.
            self.chat_reasoning_content.push_str(reasoning_content);
        }
        if let Some(text) = delta.get("content").and_then(Value::as_str) {
            self.text(text, stream);
        }
        for call in delta
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            self.tool(
                index,
                call.get("id").and_then(Value::as_str),
                call.pointer("/function/name").and_then(Value::as_str),
                stream,
            );
            if let Some(arguments) = call.pointer("/function/arguments").and_then(Value::as_str) {
                self.arguments(index, arguments, stream);
            }
        }
        Ok(())
    }

    fn apply_openai_responses(
        &mut self,
        event: Value,
        stream: &ModelStreamSender,
    ) -> Result<(), ProviderError> {
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match kind {
            "response.output_text.delta" => {
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    self.text(delta, stream);
                }
            }
            "response.reasoning_summary_text.delta" => {
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    self.reasoning_summary(delta, stream);
                }
            }
            "response.reasoning_summary_text.done" => {
                let _ = stream.send(ModelStreamEvent::ReasoningSummaryCompleted);
            }
            "response.output_item.added" => {
                let item = event.get("item").unwrap_or(&Value::Null);
                let index = event
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                if item.get("type").and_then(Value::as_str) == Some("reasoning") {
                    self.responses_reasoning_items.insert(index, item.clone());
                } else if item.get("type").and_then(Value::as_str) == Some("function_call") {
                    self.tool(
                        index,
                        item.get("call_id")
                            .or_else(|| item.get("id"))
                            .and_then(Value::as_str),
                        item.get("name").and_then(Value::as_str),
                        stream,
                    );
                }
            }
            "response.function_call_arguments.delta" => {
                let index = event
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    self.arguments(index, delta, stream);
                }
            }
            "response.function_call_arguments.done" => {
                let index = event
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                if self
                    .tools
                    .get(&index)
                    .is_some_and(|tool| tool.arguments.is_empty())
                {
                    if let Some(arguments) = event.get("arguments").and_then(Value::as_str) {
                        self.arguments(index, arguments, stream);
                    }
                }
                self.complete_tool(index, stream);
            }
            "response.output_item.done" => {
                let item = event.get("item").unwrap_or(&Value::Null);
                let index = event
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                if item.get("type").and_then(Value::as_str) == Some("reasoning") {
                    // The done item is authoritative and can add opaque fields
                    // (notably encrypted_content) absent from the added event.
                    self.responses_reasoning_items.insert(index, item.clone());
                } else if item.get("type").and_then(Value::as_str) == Some("function_call") {
                    self.tool(
                        index,
                        item.get("call_id")
                            .or_else(|| item.get("id"))
                            .and_then(Value::as_str),
                        item.get("name").and_then(Value::as_str),
                        stream,
                    );
                    if self
                        .tools
                        .get(&index)
                        .is_some_and(|tool| tool.arguments.is_empty())
                    {
                        if let Some(arguments) = item.get("arguments").and_then(Value::as_str) {
                            self.arguments(index, arguments, stream);
                        }
                    }
                    self.complete_tool(index, stream);
                }
            }
            "response.completed" => {
                self.terminal = true;
                for (index, item) in event
                    .pointer("/response/output")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .enumerate()
                {
                    if item.get("type").and_then(Value::as_str) == Some("reasoning") {
                        self.responses_reasoning_items.insert(index, item.clone());
                    }
                }
                if let Some(usage) = event.pointer("/response/usage") {
                    let input_tokens = usage.get("input_tokens").and_then(Value::as_u64);
                    let cached_input_tokens = usage
                        .pointer("/input_tokens_details/cached_tokens")
                        .and_then(Value::as_u64);
                    self.usage(
                        ModelUsage {
                            input_tokens,
                            uncached_input_tokens: subtract_optional(
                                input_tokens,
                                cached_input_tokens,
                            ),
                            cached_input_tokens,
                            output_tokens: usage.get("output_tokens").and_then(Value::as_u64),
                            reasoning_tokens: usage
                                .pointer("/output_tokens_details/reasoning_tokens")
                                .and_then(Value::as_u64),
                            total_tokens: usage.get("total_tokens").and_then(Value::as_u64),
                            raw: vec![usage.clone()],
                            ..ModelUsage::default()
                        },
                        stream,
                    );
                }
            }
            "response.incomplete" | "response.failed" | "error" => {
                return Err(format!("OpenAI Responses 流失败: {event}").into());
            }
            _ => {}
        }
        Ok(())
    }

    fn apply_anthropic(
        &mut self,
        event: Value,
        stream: &ModelStreamSender,
    ) -> Result<(), ProviderError> {
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match kind {
            "message_start" => {
                let usage = event.pointer("/message/usage").unwrap_or(&Value::Null);
                self.usage(anthropic_usage(usage), stream);
            }
            "content_block_start" => {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let block = event.get("content_block").unwrap_or(&Value::Null);
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(text) = block.get("text").and_then(Value::as_str) {
                            self.text(text, stream);
                        }
                    }
                    Some("tool_use") => {
                        self.tool(
                            index,
                            block.get("id").and_then(Value::as_str),
                            block.get("name").and_then(Value::as_str),
                            stream,
                        );
                    }
                    _ => {}
                }
            }
            "content_block_delta" => {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let delta = event.get("delta").unwrap_or(&Value::Null);
                match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => {
                        if let Some(text) = delta.get("text").and_then(Value::as_str) {
                            self.text(text, stream);
                        }
                    }
                    Some("input_json_delta") => {
                        if let Some(arguments) = delta.get("partial_json").and_then(Value::as_str) {
                            self.arguments(index, arguments, stream);
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                self.complete_tool(index, stream);
            }
            "message_delta" => {
                if event.pointer("/delta/stop_reason").and_then(Value::as_str) == Some("max_tokens")
                {
                    return Err("Anthropic 流因 max_tokens 被截断".into());
                }
                let usage = event.pointer("/usage").unwrap_or(&Value::Null);
                self.usage(
                    ModelUsage {
                        output_tokens: usage.get("output_tokens").and_then(Value::as_u64),
                        raw: vec![usage.clone()],
                        ..ModelUsage::default()
                    },
                    stream,
                );
            }
            "message_stop" => self.terminal = true,
            "error" => return Err(format!("Anthropic 流失败: {event}").into()),
            _ => {}
        }
        Ok(())
    }

    fn apply_gemini(
        &mut self,
        event: Value,
        stream: &ModelStreamSender,
    ) -> Result<(), ProviderError> {
        if let Some(usage) = event.get("usageMetadata") {
            self.usage(
                ModelUsage {
                    input_tokens: usage.get("promptTokenCount").and_then(Value::as_u64),
                    cached_input_tokens: usage
                        .get("cachedContentTokenCount")
                        .and_then(Value::as_u64),
                    uncached_input_tokens: subtract_optional(
                        usage.get("promptTokenCount").and_then(Value::as_u64),
                        usage.get("cachedContentTokenCount").and_then(Value::as_u64),
                    ),
                    output_tokens: usage.get("candidatesTokenCount").and_then(Value::as_u64),
                    reasoning_tokens: usage.get("thoughtsTokenCount").and_then(Value::as_u64),
                    total_tokens: usage.get("totalTokenCount").and_then(Value::as_u64),
                    raw: vec![usage.clone()],
                    ..ModelUsage::default()
                },
                stream,
            );
        }
        let Some(candidate) = event
            .get("candidates")
            .and_then(Value::as_array)
            .and_then(|v| v.first())
        else {
            return Ok(());
        };
        let finish = candidate.get("finishReason").and_then(Value::as_str);
        if let Some(reason) = gemini_finish_failure(finish) {
            return Err(format!("Gemini 流未完成: {reason}").into());
        }
        if finish == Some("STOP") {
            self.terminal = true;
        }
        for part in candidate
            .pointer("/content/parts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            // Gemini may stream internal reasoning as a normal-looking text
            // part marked with `thought: true`. It is protocol metadata, not
            // assistant-visible content, and must never reach the user-facing
            // text channel. A sibling `thoughtSignature` is intentionally not
            // interpreted as text either.
            if part.get("thought").and_then(Value::as_bool) != Some(true) {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    self.text(text, stream);
                }
            }
            if let Some(call) = part.get("functionCall") {
                let index = self.gemini_tool_index;
                self.gemini_tool_index += 1;
                let id = call
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("gemini-call-{index}"));
                self.tool(
                    index,
                    Some(&id),
                    call.get("name").and_then(Value::as_str),
                    stream,
                );
                let arguments = serde_json::to_string(call.get("args").unwrap_or(&json!({})))?;
                self.arguments(index, &arguments, stream);
                self.complete_tool(index, stream);
            }
        }
        Ok(())
    }

    fn finish(mut self, stream: &ModelStreamSender) -> Result<Response, ProviderError> {
        if !self.terminal {
            return Err("Provider 流在协议终止事件之前断开".into());
        }
        let indices = self.tools.keys().copied().collect::<Vec<_>>();
        for index in indices {
            self.complete_tool(index, stream);
        }
        let tool_calls = self
            .tools
            .into_values()
            .map(|tool| ToolCallRepr {
                id: tool.id,
                r#type: "function".to_string(),
                func_name: tool.name,
                arguments: if tool.arguments.is_empty() {
                    "{}".to_string()
                } else {
                    tool.arguments
                },
            })
            .collect();
        let provider_continuation = if !self.chat_reasoning_content.is_empty() {
            Some(ProviderContinuation::OpenaiChat {
                reasoning_content: self.chat_reasoning_content,
            })
        } else if !self.responses_reasoning_items.is_empty() {
            Some(ProviderContinuation::OpenaiResponses {
                reasoning_items: self.responses_reasoning_items.into_values().collect(),
            })
        } else {
            None
        };
        if let Some(continuation) = provider_continuation {
            let _ = stream.send(ModelStreamEvent::ProviderContinuation { continuation });
        }
        ensure_nonempty(Response {
            content: self.content,
            tool_calls,
        })
    }
}

fn take_sse_frame(bytes: &[u8]) -> Option<(Vec<u8>, usize)> {
    let lf = bytes.windows(2).position(|window| window == b"\n\n");
    let crlf = bytes.windows(4).position(|window| window == b"\r\n\r\n");
    match (lf, crlf) {
        (Some(left), Some(right)) if left <= right => Some((bytes[..left].to_vec(), left + 2)),
        (Some(_), Some(right)) => Some((bytes[..right].to_vec(), right + 4)),
        (Some(index), None) => Some((bytes[..index].to_vec(), index + 2)),
        (None, Some(index)) => Some((bytes[..index].to_vec(), index + 4)),
        (None, None) => None,
    }
}

fn sse_data(frame: &[u8]) -> Result<Option<String>, ProviderError> {
    let text = std::str::from_utf8(frame)?;
    let data = text
        .lines()
        .filter_map(|line| line.trim_end_matches('\r').strip_prefix("data:"))
        .map(|line| line.strip_prefix(' ').unwrap_or(line))
        .collect::<Vec<_>>();
    if data.is_empty() {
        Ok(None)
    } else {
        Ok(Some(data.join("\n")))
    }
}

fn build_request(
    protocol: ModelProtocol,
    model: &str,
    max_output_tokens: Option<u32>,
    reasoning_effort: Option<ReasoningEffort>,
    messages: &[Message],
    tools: &[ToolDefinition],
) -> Value {
    match protocol {
        ModelProtocol::OpenaiChat => {
            build_openai_chat_request(model, max_output_tokens, reasoning_effort, messages, tools)
        }
        ModelProtocol::OpenaiResponses => build_openai_responses_request(
            model,
            max_output_tokens,
            reasoning_effort,
            messages,
            tools,
        ),
        ModelProtocol::AnthropicMessages => {
            build_anthropic_request(model, max_output_tokens, reasoning_effort, messages, tools)
        }
        ModelProtocol::GeminiContent => {
            build_gemini_request(max_output_tokens, reasoning_effort, messages, tools)
        }
    }
}

fn build_openai_chat_request(
    model: &str,
    max_output_tokens: Option<u32>,
    reasoning_effort: Option<ReasoningEffort>,
    messages: &[Message],
    tools: &[ToolDefinition],
) -> Value {
    let mut converted = Vec::new();
    let mut pending_continuation = None;
    for message in messages {
        if let Some(continuation) = provider_continuation(message) {
            pending_continuation = Some(continuation);
            continue;
        }
        if let Some(attachments) = model_attachments(message) {
            let content = attachments
                .iter()
                .map(openai_chat_attachment_block)
                .collect::<Vec<_>>();
            converted.push(json!({"role": "user", "content": content}));
            continue;
        }
        let mut converted_message = serde_json::to_value(message).unwrap_or_else(|_| json!({}));
        if message.role == "assistant" {
            if let Some(ProviderContinuation::OpenaiChat { reasoning_content }) =
                pending_continuation.take()
            {
                converted_message["reasoning_content"] = json!(reasoning_content);
            }
        }
        converted.push(converted_message);
    }
    let mut request = json!({"model": model, "messages": converted});
    if let Some(max_tokens) = max_output_tokens {
        request["max_completion_tokens"] = json!(max_tokens);
    }
    if let Some(effort) = reasoning_effort {
        request["reasoning_effort"] = json!(effort.as_str());
    }
    if !tools.is_empty() {
        request["tools"] = Value::Array(
            tools
                .iter()
                .map(|tool| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": tool.parameters,
                        }
                    })
                })
                .collect(),
        );
    }
    request
}

fn build_openai_responses_request(
    model: &str,
    max_output_tokens: Option<u32>,
    reasoning_effort: Option<ReasoningEffort>,
    messages: &[Message],
    tools: &[ToolDefinition],
) -> Value {
    let mut input = Vec::new();
    for message in messages {
        if let Some(continuation) = provider_continuation(message) {
            if let ProviderContinuation::OpenaiResponses { reasoning_items } = continuation {
                input.extend(reasoning_items);
            }
            continue;
        }
        if let Some(attachments) = model_attachments(message) {
            input.push(json!({
                "role": "user",
                "content": attachments.iter().map(openai_responses_attachment_block).collect::<Vec<_>>(),
            }));
            continue;
        }
        if message.role == "tool" {
            input.push(json!({
                "type": "function_call_output",
                "call_id": message.tool_call_id,
                "output": message.content,
            }));
            continue;
        }
        if !message.content.is_empty() {
            input.push(json!({"role": message.role, "content": message.content}));
        }
        for call in message.tool_calls.as_deref().unwrap_or_default() {
            input.push(json!({
                "type": "function_call",
                "call_id": call.id,
                "name": call.function.name,
                "arguments": call.function.arguments,
            }));
        }
    }
    let mut request = json!({"model": model, "input": input});
    if let Some(max_tokens) = max_output_tokens {
        request["max_output_tokens"] = json!(max_tokens);
    }
    if let Some(effort) = reasoning_effort {
        request["reasoning"] = json!({"effort": effort.as_str()});
    }
    if !tools.is_empty() {
        request["tools"] = Value::Array(
            tools
                .iter()
                .map(|tool| {
                    json!({
                        "type": "function",
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.parameters,
                        "strict": false,
                    })
                })
                .collect(),
        );
    }
    request
}

fn adapt_codex_request(mut request: Value) -> Value {
    let Some(object) = request.as_object_mut() else {
        return request;
    };

    object.insert("store".to_string(), Value::Bool(false));
    object.insert(
        "include".to_string(),
        json!(["reasoning.encrypted_content"]),
    );

    // These fields are valid for the public Responses API but rejected by
    // the ChatGPT Codex backend. CLIProxyAPI applies the same compatibility
    // boundary before forwarding a request upstream.
    for field in [
        "max_output_tokens",
        "max_completion_tokens",
        "temperature",
        "top_p",
        "truncation",
        "context_management",
        "user",
        "previous_response_id",
        "generate",
        "prompt_cache_retention",
        "safety_identifier",
        "stream_options",
    ] {
        object.remove(field);
    }
    if object
        .get("service_tier")
        .and_then(Value::as_str)
        .is_some_and(|tier| tier != "priority")
    {
        object.remove("service_tier");
    }

    let has_tools = object
        .get("tools")
        .and_then(Value::as_array)
        .is_some_and(|tools| !tools.is_empty());
    if has_tools {
        object.insert("parallel_tool_calls".to_string(), Value::Bool(true));
    } else {
        object.remove("parallel_tool_calls");
    }

    if object.get("instructions").is_none_or(Value::is_null) {
        object.insert("instructions".to_string(), Value::String(String::new()));
    }
    if let Some(input) = object.get_mut("input").and_then(Value::as_array_mut) {
        for item in input {
            if item.get("role").and_then(Value::as_str) == Some("system") {
                item["role"] = Value::String("developer".to_string());
            }
        }
    }
    request
}

fn build_anthropic_request(
    model: &str,
    max_output_tokens: Option<u32>,
    reasoning_effort: Option<ReasoningEffort>,
    messages: &[Message],
    tools: &[ToolDefinition],
) -> Value {
    let system = messages
        .iter()
        .filter(|message| message.role == "system" && model_attachments(message).is_none())
        .map(|message| message.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut converted: Vec<Value> = Vec::new();
    for message in messages.iter().filter(|message| message.role != "system") {
        if let Some(attachments) = model_attachments(message) {
            let content = attachments
                .iter()
                .map(anthropic_attachment_block)
                .collect::<Vec<_>>();
            if !content.is_empty() {
                converted.push(json!({"role": "user", "content": content}));
            }
            continue;
        }
        let (role, mut content) = if message.role == "tool" {
            (
                "user",
                vec![json!({
                    "type": "tool_result",
                    "tool_use_id": message.tool_call_id,
                    "content": message.content,
                })],
            )
        } else {
            let role = if message.role == "assistant" {
                "assistant"
            } else {
                "user"
            };
            let mut blocks = Vec::new();
            if !message.content.is_empty() {
                blocks.push(json!({"type": "text", "text": message.content}));
            }
            for call in message.tool_calls.as_deref().unwrap_or_default() {
                let input = serde_json::from_str::<Value>(&call.function.arguments)
                    .unwrap_or_else(|_| json!({"raw": call.function.arguments}));
                blocks.push(json!({
                    "type": "tool_use",
                    "id": call.id,
                    "name": call.function.name,
                    "input": input,
                }));
            }
            (role, blocks)
        };
        if content.is_empty() {
            continue;
        }
        if let Some(last) = converted.last_mut() {
            if last.get("role").and_then(Value::as_str) == Some(role) {
                if let Some(blocks) = last.get_mut("content").and_then(Value::as_array_mut) {
                    blocks.append(&mut content);
                    continue;
                }
            }
        }
        converted.push(json!({"role": role, "content": content}));
    }
    let mut request = json!({
        "model": model,
        "max_tokens": max_output_tokens.unwrap_or(8192),
        "messages": converted,
    });
    if !system.is_empty() {
        request["system"] = json!(system);
    }
    if let Some(effort) = reasoning_effort {
        request["output_config"] = json!({"effort": effort.as_str()});
    }
    if !tools.is_empty() {
        request["tools"] = Value::Array(
            tools
                .iter()
                .map(|tool| {
                    json!({
                        "name": tool.name,
                        "description": tool.description,
                        "input_schema": tool.parameters,
                    })
                })
                .collect(),
        );
    }
    request
}

fn build_gemini_request(
    max_output_tokens: Option<u32>,
    reasoning_effort: Option<ReasoningEffort>,
    messages: &[Message],
    tools: &[ToolDefinition],
) -> Value {
    let system = messages
        .iter()
        .filter(|message| message.role == "system" && model_attachments(message).is_none())
        .map(|message| message.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut contents: Vec<Value> = Vec::new();
    for message in messages.iter().filter(|message| message.role != "system") {
        if let Some(attachments) = model_attachments(message) {
            let parts = attachments
                .iter()
                .map(|attachment| {
                    json!({
                        "inlineData": {
                            "mimeType": attachment.media_type,
                            "data": attachment.data_base64,
                        }
                    })
                })
                .collect::<Vec<_>>();
            if !parts.is_empty() {
                contents.push(json!({"role": "user", "parts": parts}));
            }
            continue;
        }
        let (role, mut parts) = if message.role == "tool" {
            let response = serde_json::from_str::<Value>(&message.content)
                .unwrap_or_else(|_| json!({"output": message.content}));
            let mut function_response = json!({
                "name": message.name.as_deref().unwrap_or("tool"),
                "response": response,
            });
            if let Some(id) = message.tool_call_id.as_deref().filter(|id| !id.is_empty()) {
                function_response["id"] = json!(id);
            }
            ("user", vec![json!({"functionResponse": function_response})])
        } else {
            let role = if message.role == "assistant" {
                "model"
            } else {
                "user"
            };
            let mut parts = Vec::new();
            if !message.content.is_empty() {
                parts.push(json!({"text": message.content}));
            }
            for call in message.tool_calls.as_deref().unwrap_or_default() {
                let args = serde_json::from_str::<Value>(&call.function.arguments)
                    .unwrap_or_else(|_| json!({"raw": call.function.arguments}));
                let mut function_call = json!({"name": call.function.name, "args": args});
                if !call.id.is_empty() {
                    function_call["id"] = json!(call.id);
                }
                parts.push(json!({"functionCall": function_call}));
            }
            (role, parts)
        };
        if parts.is_empty() {
            continue;
        }
        if let Some(last) = contents.last_mut() {
            if last.get("role").and_then(Value::as_str) == Some(role) {
                if let Some(existing) = last.get_mut("parts").and_then(Value::as_array_mut) {
                    existing.append(&mut parts);
                    continue;
                }
            }
        }
        contents.push(json!({"role": role, "parts": parts}));
    }
    let mut request = json!({"contents": contents});
    if !system.is_empty() {
        request["systemInstruction"] = json!({"parts": [{"text": system}]});
    }
    if max_output_tokens.is_some() || reasoning_effort.is_some() {
        let mut generation_config = json!({});
        if let Some(max_tokens) = max_output_tokens {
            generation_config["maxOutputTokens"] = json!(max_tokens);
        }
        if let Some(effort) = reasoning_effort {
            generation_config["thinkingConfig"] = json!({"thinkingLevel": effort.as_str()});
        }
        request["generationConfig"] = generation_config;
    }
    if !tools.is_empty() {
        request["tools"] = json!([{
            "functionDeclarations": tools.iter().map(|tool| json!({
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            })).collect::<Vec<_>>()
        }]);
    }
    request
}

fn data_url(attachment: &ModelAttachment) -> String {
    format!(
        "data:{};base64,{}",
        attachment.media_type, attachment.data_base64
    )
}

fn decoded_text_attachment(attachment: &ModelAttachment) -> Option<String> {
    if !attachment.media_type.starts_with("text/")
        && attachment.media_type != "application/json"
        && attachment.media_type != "application/xml"
    {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&attachment.data_base64)
        .ok()?;
    String::from_utf8(bytes).ok()
}

fn openai_chat_attachment_block(attachment: &ModelAttachment) -> Value {
    if attachment.media_type.starts_with("image/") {
        return json!({
            "type": "image_url",
            "image_url": {"url": data_url(attachment), "detail": "auto"},
        });
    }
    if let Some(text) = decoded_text_attachment(attachment) {
        return json!({
            "type": "text",
            "text": format!("Attached file '{}':\n{}", attachment.name, text),
        });
    }
    json!({
        "type": "text",
        "text": format!(
            "Attached file '{}' ({}) is available to the Runtime, but this OpenAI Chat-compatible protocol cannot transmit arbitrary binary files.",
            attachment.name, attachment.media_type
        ),
    })
}

fn openai_responses_attachment_block(attachment: &ModelAttachment) -> Value {
    if attachment.media_type.starts_with("image/") {
        json!({"type": "input_image", "image_url": data_url(attachment), "detail": "auto"})
    } else if let Some(text) = decoded_text_attachment(attachment) {
        json!({
            "type": "input_text",
            "text": format!("Attached file '{}':\n{}", attachment.name, text),
        })
    } else {
        json!({
            "type": "input_file",
            "filename": attachment.name,
            "file_data": data_url(attachment),
        })
    }
}

fn anthropic_attachment_block(attachment: &ModelAttachment) -> Value {
    if attachment.media_type.starts_with("image/") {
        json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": attachment.media_type,
                "data": attachment.data_base64,
            }
        })
    } else if attachment.media_type == "application/pdf" {
        json!({
            "type": "document",
            "source": {
                "type": "base64",
                "media_type": attachment.media_type,
                "data": attachment.data_base64,
            },
            "title": attachment.name,
        })
    } else if let Some(text) = decoded_text_attachment(attachment) {
        json!({
            "type": "text",
            "text": format!("Attached file '{}':\n{}", attachment.name, text),
        })
    } else {
        json!({
            "type": "text",
            "text": format!(
                "Attached file '{}' ({}) is not a natively supported Anthropic image/PDF/text input.",
                attachment.name, attachment.media_type
            ),
        })
    }
}

fn parse_response(protocol: ModelProtocol, value: Value) -> Result<Response, ProviderError> {
    match protocol {
        ModelProtocol::OpenaiChat => parse_openai_chat_response(value),
        ModelProtocol::OpenaiResponses => parse_openai_responses_response(value),
        ModelProtocol::AnthropicMessages => parse_anthropic_response(value),
        ModelProtocol::GeminiContent => parse_gemini_response(value),
    }
}

fn ensure_nonempty(response: Response) -> Result<Response, ProviderError> {
    if response.content.trim().is_empty() && response.tool_calls.is_empty() {
        Err(boxed_model_failure(ModelFailure::new(
            ModelFailureKind::EmptyResponse,
            "模型响应既没有非空正文，也没有工具调用",
        )))
    } else {
        Ok(response)
    }
}

fn parse_openai_chat_response(value: Value) -> Result<Response, ProviderError> {
    let choice = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .ok_or("OpenAI Chat 响应缺少 choices[0]")?;
    if choice.get("finish_reason").and_then(Value::as_str) == Some("length") {
        return Err("OpenAI Chat 响应因输出长度限制被截断".into());
    }
    let message = choice
        .get("message")
        .ok_or("OpenAI Chat 响应缺少 message")?;
    let content = message
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let tool_calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|call| ToolCallRepr {
            id: call
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            r#type: call
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("function")
                .to_string(),
            func_name: call
                .pointer("/function/name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            arguments: call
                .pointer("/function/arguments")
                .and_then(Value::as_str)
                .unwrap_or("{}")
                .to_string(),
        })
        .collect();
    ensure_nonempty(Response {
        content,
        tool_calls,
    })
}

fn parse_openai_responses_response(value: Value) -> Result<Response, ProviderError> {
    if value.get("status").and_then(Value::as_str) == Some("incomplete") {
        return Err(format!(
            "OpenAI Responses 响应不完整: {}",
            value.get("incomplete_details").unwrap_or(&Value::Null)
        )
        .into());
    }
    let mut content = Vec::new();
    let mut tool_calls = Vec::new();
    for item in value
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        match item.get("type").and_then(Value::as_str) {
            Some("message") => {
                for block in item
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        content.push(text.to_string());
                    }
                }
            }
            Some("function_call") => tool_calls.push(ToolCallRepr {
                id: item
                    .get("call_id")
                    .or_else(|| item.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                r#type: "function".to_string(),
                func_name: item
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                arguments: item
                    .get("arguments")
                    .and_then(Value::as_str)
                    .unwrap_or("{}")
                    .to_string(),
            }),
            _ => {}
        }
    }
    ensure_nonempty(Response {
        content: content.join(""),
        tool_calls,
    })
}

fn parse_anthropic_response(value: Value) -> Result<Response, ProviderError> {
    if value.get("stop_reason").and_then(Value::as_str) == Some("max_tokens") {
        return Err("Anthropic 响应因 max_tokens 被截断".into());
    }
    let mut content = Vec::new();
    let mut tool_calls = Vec::new();
    for block in value
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    content.push(text.to_string());
                }
            }
            Some("tool_use") => tool_calls.push(ToolCallRepr {
                id: block
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                r#type: "function".to_string(),
                func_name: block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                arguments: serde_json::to_string(block.get("input").unwrap_or(&json!({})))?,
            }),
            _ => {}
        }
    }
    ensure_nonempty(Response {
        content: content.join(""),
        tool_calls,
    })
}

fn parse_gemini_response(value: Value) -> Result<Response, ProviderError> {
    let candidate = value
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|candidates| candidates.first())
        .ok_or("Gemini 响应缺少 candidates[0]")?;
    let finish_reason = candidate.get("finishReason").and_then(Value::as_str);
    if let Some(reason) = gemini_finish_failure(finish_reason) {
        return Err(format!("Gemini 响应未完成: {reason}").into());
    }
    let mut content = Vec::new();
    let mut tool_calls = Vec::new();
    for (index, part) in candidate
        .pointer("/content/parts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        if part.get("thought").and_then(Value::as_bool) != Some(true) {
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                content.push(text.to_string());
            }
        }
        if let Some(call) = part.get("functionCall") {
            tool_calls.push(ToolCallRepr {
                id: call
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("gemini-call-{index}")),
                r#type: "function".to_string(),
                func_name: call
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                arguments: serde_json::to_string(call.get("args").unwrap_or(&json!({})))?,
            });
        }
    }
    ensure_nonempty(Response {
        content: content.join(""),
        tool_calls,
    })
}

fn gemini_finish_failure(reason: Option<&str>) -> Option<&str> {
    reason.filter(|reason| !reason.is_empty() && *reason != "STOP")
}

pub fn builtin_provider_catalog() -> BTreeMap<String, ProviderConfig> {
    BTreeMap::from([
        (
            "openai".to_string(),
            ProviderConfig {
                protocol: ModelProtocol::OpenaiResponses,
                base_url: "https://api.openai.com/v1".to_string(),
                credential: Some("openai".to_string()),
                ..ProviderConfig::default()
            },
        ),
        (
            "anthropic".to_string(),
            ProviderConfig {
                protocol: ModelProtocol::AnthropicMessages,
                base_url: "https://api.anthropic.com/v1".to_string(),
                credential: Some("anthropic".to_string()),
                ..ProviderConfig::default()
            },
        ),
        (
            "gemini".to_string(),
            ProviderConfig {
                protocol: ModelProtocol::GeminiContent,
                base_url: "https://generativelanguage.googleapis.com/v1beta".to_string(),
                credential: Some("gemini".to_string()),
                ..ProviderConfig::default()
            },
        ),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::{attachment_message, FunctionCall, ToolCall};
    use axum::{
        body::Body,
        http::StatusCode,
        response::Response as AxumResponse,
        routing::{get, post},
        Json, Router,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn sse(body: &'static str) -> AxumResponse {
        AxumResponse::builder()
            .header("content-type", "text/event-stream")
            .body(Body::from(body))
            .unwrap()
    }

    fn gated_sse(chunks: Vec<&'static str>, gate: Arc<tokio::sync::Semaphore>) -> AxumResponse {
        let body = futures_util::stream::unfold(
            (chunks.into_iter(), true, gate),
            |(mut chunks, first, gate)| async move {
                let chunk = chunks.next()?;
                if !first {
                    gate.acquire()
                        .await
                        .expect("test gate must remain open")
                        .forget();
                }
                Some((
                    Ok::<_, std::convert::Infallible>(chunk.to_string()),
                    (chunks, false, gate),
                ))
            },
        );
        AxumResponse::builder()
            .header("content-type", "text/event-stream")
            .body(Body::from_stream(body))
            .unwrap()
    }

    fn gated_first_sse(
        chunks: Vec<&'static str>,
        gate: Arc<tokio::sync::Semaphore>,
    ) -> AxumResponse {
        let body = futures_util::stream::unfold(
            (chunks.into_iter(), gate),
            |(mut chunks, gate)| async move {
                gate.acquire()
                    .await
                    .expect("test gate must remain open")
                    .forget();
                let chunk = chunks.next()?;
                Some((
                    Ok::<_, std::convert::Infallible>(chunk.to_string()),
                    (chunks, gate),
                ))
            },
        );
        AxumResponse::builder()
            .header("content-type", "text/event-stream")
            .body(Body::from_stream(body))
            .unwrap()
    }

    fn messages() -> Vec<Message> {
        vec![
            Message {
                role: "system".to_string(),
                content: "system".to_string(),
                name: None,
                tool_call_id: None,
                tool_calls: None,
            },
            Message {
                role: "assistant".to_string(),
                content: String::new(),
                name: None,
                tool_call_id: None,
                tool_calls: Some(vec![ToolCall {
                    id: "call-1".to_string(),
                    r#type: "function".to_string(),
                    function: FunctionCall {
                        name: "read_file".to_string(),
                        arguments: "{\"path\":\"README.md\"}".to_string(),
                    },
                }]),
            },
            Message {
                role: "tool".to_string(),
                content: "contents".to_string(),
                name: Some("read_file".to_string()),
                tool_call_id: Some("call-1".to_string()),
                tool_calls: None,
            },
        ]
    }

    #[test]
    fn antigravity_uses_internal_endpoints_and_request_envelope() {
        let client = ProtocolClient::new_with_adapter(
            &ProviderConfig {
                protocol: ModelProtocol::GeminiContent,
                base_url: "https://cloudcode-pa.googleapis.com".to_string(),
                headers: BTreeMap::from([(
                    "x-goog-user-project".to_string(),
                    "project-123".to_string(),
                )]),
                ..ProviderConfig::default()
            },
            "google-antigravity",
            "gemini-test".to_string(),
            None,
            &LlmConfig::default(),
        )
        .unwrap();

        assert_eq!(
            client.endpoint_for(false, "gemini-test").unwrap(),
            "https://cloudcode-pa.googleapis.com/v1internal:generateContent"
        );
        assert_eq!(
            client.endpoint_for(true, "gemini-test").unwrap(),
            "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
        );

        let request = client.request_for_model("gemini-test", &messages(), &[]);
        assert_eq!(request["model"], "gemini-test");
        assert_eq!(request["userAgent"], "antigravity");
        assert_eq!(request["requestType"], "agent");
        assert_eq!(request["project"], "project-123");
        assert!(request["request"]["contents"].is_array());
        assert!(request["request"]["sessionId"]
            .as_str()
            .is_some_and(|value| value.starts_with('-')));
        assert!(request["requestId"]
            .as_str()
            .is_some_and(|value| value.starts_with("agent-")));
    }

    #[test]
    fn antigravity_unwraps_internal_response_without_changing_generic_gemini() {
        let provider = ProviderConfig {
            protocol: ModelProtocol::GeminiContent,
            base_url: "https://generativelanguage.googleapis.com/v1beta".to_string(),
            ..ProviderConfig::default()
        };
        let antigravity = ProtocolClient::new_with_adapter(
            &provider,
            "google-antigravity",
            "gemini-test".to_string(),
            None,
            &LlmConfig::default(),
        )
        .unwrap();
        let generic = ProtocolClient::new(
            &provider,
            "gemini-test".to_string(),
            None,
            &LlmConfig::default(),
        )
        .unwrap();
        let wrapped = json!({"response": {"candidates": [{"finishReason": "STOP"}]}});

        assert_eq!(
            antigravity.normalize_response(wrapped.clone()),
            wrapped["response"]
        );
        assert_eq!(generic.normalize_response(wrapped.clone()), wrapped);
        assert_eq!(
            generic.endpoint_for(true, "gemini-test").unwrap(),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse"
        );
        let generic_request = generic.request_for_model("gemini-test", &messages(), &[]);
        assert!(generic_request.get("request").is_none());
        assert!(generic_request["contents"].is_array());
    }

    #[test]
    fn model_failure_classifies_context_limit_before_generic_bad_request() {
        let failure = http_model_failure(
            reqwest::StatusCode::BAD_REQUEST,
            json!({
                "error": {
                    "code": "context_length_exceeded",
                    "message": "maximum context length is 262144 tokens"
                }
            })
            .to_string(),
            None,
        );
        assert_eq!(failure.kind, ModelFailureKind::ContextLimit);
        assert_eq!(failure.http_status, Some(400));
        assert_eq!(
            failure.provider_code.as_deref(),
            Some("context_length_exceeded")
        );
    }

    #[test]
    fn provider_retry_after_is_a_lower_bound_even_with_jitter() {
        let delay = provider_retry_delay(Duration::from_secs(1), Some(17), 3);
        assert!(delay >= Duration::from_secs(17));
    }

    #[tokio::test]
    async fn context_limit_is_not_retried_inside_protocol_adapter() {
        let requests = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&requests);
        let app = Router::new().route(
            "/chat/completions",
            post(move || {
                let observed = Arc::clone(&observed);
                async move {
                    observed.fetch_add(1, Ordering::SeqCst);
                    (
                        StatusCode::BAD_REQUEST,
                        Json(json!({
                            "error": {
                                "code": "context_length_exceeded",
                                "message": "maximum context length exceeded"
                            }
                        })),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = ProtocolClient::new(
            &ProviderConfig {
                protocol: ModelProtocol::OpenaiChat,
                base_url: format!("http://{address}"),
                ..ProviderConfig::default()
            },
            "test-model".to_string(),
            None,
            &LlmConfig {
                max_retries: 5,
                initial_backoff_secs: 0,
                ..LlmConfig::default()
            },
        )
        .unwrap();

        let error = client.send("test-model", &json!({})).await.unwrap_err();
        let failure = error.downcast_ref::<ModelFailure>().unwrap();
        assert_eq!(failure.kind, ModelFailureKind::ContextLimit);
        assert_eq!(requests.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn subscription_quota_exhaustion_is_terminal_and_not_retried() {
        let requests = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&requests);
        let app = Router::new().route(
            "/responses",
            post(move || {
                let observed = Arc::clone(&observed);
                async move {
                    observed.fetch_add(1, Ordering::SeqCst);
                    (
                        StatusCode::TOO_MANY_REQUESTS,
                        Json(json!({
                            "code": "subscription:free-usage-exhausted",
                            "error": "You've used all the included free usage for model grok-4.5 for now."
                        })),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = ProtocolClient::new(
            &ProviderConfig {
                protocol: ModelProtocol::OpenaiResponses,
                base_url: format!("http://{address}"),
                ..ProviderConfig::default()
            },
            "grok-4.5".to_string(),
            None,
            &LlmConfig {
                max_retries: 5,
                initial_backoff_secs: 0,
                ..LlmConfig::default()
            },
        )
        .unwrap();

        let (stream, _events) = tokio::sync::mpsc::unbounded_channel();
        let error = client
            .send_stream("grok-4.5", &json!({}), None, &stream)
            .await
            .unwrap_err();
        let failure = error.downcast_ref::<ModelFailure>().unwrap();
        assert_eq!(failure.kind, ModelFailureKind::QuotaExhausted);
        assert_eq!(failure.http_status, Some(429));
        assert_eq!(
            failure.provider_code.as_deref(),
            Some("subscription:free-usage-exhausted")
        );
        assert!(!failure.kind.uses_provider_recovery());
        assert_eq!(requests.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn response_header_idle_timeout_uses_bounded_local_retry() {
        let requests = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&requests);
        let app = Router::new().route(
            "/chat/completions",
            post(move || {
                let observed = Arc::clone(&observed);
                async move {
                    let call = observed.fetch_add(1, Ordering::SeqCst);
                    if call == 0 {
                        tokio::time::sleep(Duration::from_millis(1_100)).await;
                    }
                    Json(json!({
                        "choices": [{"finish_reason":"stop","message":{"content":"recovered"}}]
                    }))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = ProtocolClient::new(
            &ProviderConfig {
                protocol: ModelProtocol::OpenaiChat,
                base_url: format!("http://{address}"),
                ..ProviderConfig::default()
            },
            "test-model".to_string(),
            None,
            &LlmConfig {
                max_retries: 2,
                initial_backoff_secs: 0,
                stream_idle_timeout_secs: 1,
                ..LlmConfig::default()
            },
        )
        .unwrap();

        let body = client.send("test-model", &json!({})).await.unwrap();
        assert_eq!(
            body.pointer("/choices/0/message/content")
                .and_then(Value::as_str),
            Some("recovered")
        );
        assert_eq!(requests.load(Ordering::SeqCst), 2);
    }

    fn tools() -> Vec<ToolDefinition> {
        vec![ToolDefinition {
            name: "read_file".to_string(),
            description: "read".to_string(),
            parameters: json!({"type":"object"}),
        }]
    }

    #[test]
    fn protocol_requests_preserve_tool_call_and_result_identity() {
        let messages = messages();
        let tools = tools();
        let responses = build_request(
            ModelProtocol::OpenaiResponses,
            "m",
            Some(100),
            None,
            &messages,
            &tools,
        );
        assert_eq!(responses["input"][1]["call_id"], "call-1");
        assert_eq!(responses["input"][2]["call_id"], "call-1");

        let anthropic = build_request(
            ModelProtocol::AnthropicMessages,
            "m",
            Some(100),
            None,
            &messages,
            &tools,
        );
        assert_eq!(anthropic["messages"][0]["content"][0]["id"], "call-1");
        assert_eq!(
            anthropic["messages"][1]["content"][0]["tool_use_id"],
            "call-1"
        );

        let gemini = build_request(
            ModelProtocol::GeminiContent,
            "m",
            Some(100),
            None,
            &messages,
            &tools,
        );
        assert_eq!(
            gemini["contents"][0]["parts"][0]["functionCall"]["name"],
            "read_file"
        );
        assert_eq!(
            gemini["contents"][1]["parts"][0]["functionResponse"]["name"],
            "read_file"
        );
    }

    #[test]
    fn protocol_requests_translate_image_attachments_to_native_multimodal_inputs() {
        let attachment = ModelAttachment {
            name: "diagram.png".to_string(),
            media_type: "image/png".to_string(),
            data_base64: "aW1hZ2U=".to_string(),
        };
        let messages = vec![
            Message {
                role: "user".to_string(),
                content: "What is in this image?".to_string(),
                name: None,
                tool_call_id: None,
                tool_calls: None,
            },
            attachment_message(vec![attachment]).expect("attachment marker must serialize"),
        ];

        let chat = build_request(ModelProtocol::OpenaiChat, "m", None, None, &messages, &[]);
        assert_eq!(chat["messages"][1]["content"][0]["type"], "image_url");
        assert_eq!(
            chat["messages"][1]["content"][0]["image_url"]["url"],
            "data:image/png;base64,aW1hZ2U="
        );

        let responses = build_request(
            ModelProtocol::OpenaiResponses,
            "m",
            None,
            None,
            &messages,
            &[],
        );
        assert_eq!(responses["input"][1]["content"][0]["type"], "input_image");
        assert_eq!(
            responses["input"][1]["content"][0]["image_url"],
            "data:image/png;base64,aW1hZ2U="
        );

        let anthropic = build_request(
            ModelProtocol::AnthropicMessages,
            "m",
            None,
            None,
            &messages,
            &[],
        );
        assert_eq!(anthropic["messages"][1]["content"][0]["type"], "image");
        assert_eq!(
            anthropic["messages"][1]["content"][0]["source"]["media_type"],
            "image/png"
        );
        assert_eq!(
            anthropic["messages"][1]["content"][0]["source"]["data"],
            "aW1hZ2U="
        );

        let gemini = build_request(
            ModelProtocol::GeminiContent,
            "m",
            None,
            None,
            &messages,
            &[],
        );
        assert_eq!(
            gemini["contents"][1]["parts"][0]["inlineData"]["mimeType"],
            "image/png"
        );
        assert_eq!(
            gemini["contents"][1]["parts"][0]["inlineData"]["data"],
            "aW1hZ2U="
        );
    }

    #[test]
    fn reasoning_effort_maps_to_each_native_protocol_without_model_name_inference() {
        let messages = messages();
        let tools = tools();
        let chat = build_request(
            ModelProtocol::OpenaiChat,
            "model",
            None,
            Some(ReasoningEffort::High),
            &messages,
            &tools,
        );
        assert_eq!(chat["reasoning_effort"], "high");

        let responses = build_request(
            ModelProtocol::OpenaiResponses,
            "gemini-through-a-proxy",
            None,
            Some(ReasoningEffort::High),
            &messages,
            &tools,
        );
        assert_eq!(responses["reasoning"]["effort"], "high");
        assert!(responses.get("reasoning_effort").is_none());

        let responses_off = build_request(
            ModelProtocol::OpenaiResponses,
            "model",
            None,
            Some(ReasoningEffort::Off),
            &messages,
            &tools,
        );
        assert_eq!(responses_off["reasoning"]["effort"], "none");

        let responses_max = build_request(
            ModelProtocol::OpenaiResponses,
            "model",
            None,
            Some(ReasoningEffort::Max),
            &messages,
            &tools,
        );
        assert_eq!(responses_max["reasoning"]["effort"], "max");

        let anthropic = build_request(
            ModelProtocol::AnthropicMessages,
            "model",
            None,
            Some(ReasoningEffort::Medium),
            &messages,
            &tools,
        );
        assert_eq!(anthropic["output_config"]["effort"], "medium");

        let gemini = build_request(
            ModelProtocol::GeminiContent,
            "model",
            None,
            Some(ReasoningEffort::Low),
            &messages,
            &tools,
        );
        assert_eq!(
            gemini["generationConfig"]["thinkingConfig"]["thinkingLevel"],
            "low"
        );

        let provider_default = build_request(
            ModelProtocol::OpenaiResponses,
            "model",
            None,
            None,
            &messages,
            &tools,
        );
        assert!(provider_default.get("reasoning").is_none());
    }

    #[test]
    fn xai_subscription_maps_abstract_max_for_grok_45_only() {
        assert_eq!(
            supported_reasoning_efforts_for_model("xai-subscription", "grok-4.5"),
            Some(
                [
                    ReasoningEffort::Low,
                    ReasoningEffort::Medium,
                    ReasoningEffort::High,
                ]
                .as_slice()
            )
        );
        assert_eq!(
            supported_reasoning_efforts_for_model("xai-subscription", "grok-4"),
            None
        );
        let client = ProtocolClient::new_with_adapter(
            &ProviderConfig {
                protocol: ModelProtocol::OpenaiResponses,
                base_url: "https://cli-chat-proxy.grok.com/v1".to_string(),
                ..ProviderConfig::default()
            },
            "xai-subscription",
            "grok-4.5".to_string(),
            None,
            &LlmConfig {
                reasoning_effort: Some(ReasoningEffort::Max),
                ..LlmConfig::default()
            },
        )
        .unwrap();

        let request = client.request_for_model("grok-4.5", &messages(), &tools());

        assert_eq!(request["reasoning"]["effort"], "high");

        let unsupported = client.request_for_model("grok-4", &messages(), &tools());
        assert!(unsupported.get("reasoning").is_none());

        let off_client = ProtocolClient::new_with_adapter(
            &ProviderConfig {
                protocol: ModelProtocol::OpenaiResponses,
                base_url: "https://cli-chat-proxy.grok.com/v1".to_string(),
                ..ProviderConfig::default()
            },
            "xai-subscription",
            "grok-4.5".to_string(),
            None,
            &LlmConfig {
                reasoning_effort: Some(ReasoningEffort::Off),
                ..LlmConfig::default()
            },
        )
        .unwrap();
        let off_request = off_client.request_for_model("grok-4.5", &messages(), &tools());
        assert!(off_request.get("reasoning").is_none());
    }

    #[test]
    fn protocol_responses_normalize_text_and_function_calls() {
        let openai = parse_response(
            ModelProtocol::OpenaiResponses,
            json!({"status":"completed","output":[
                {"type":"message","content":[{"type":"output_text","text":"working"}]},
                {"type":"function_call","call_id":"c1","name":"reply","arguments":"{\"text\":\"done\"}"}
            ]}),
        )
        .unwrap();
        assert_eq!(openai.content, "working");
        assert_eq!(openai.tool_calls[0].func_name, "reply");

        let anthropic = parse_response(
            ModelProtocol::AnthropicMessages,
            json!({"stop_reason":"tool_use","content":[
                {"type":"text","text":"working"},
                {"type":"tool_use","id":"c1","name":"reply","input":{"text":"done"}}
            ]}),
        )
        .unwrap();
        assert_eq!(anthropic.tool_calls[0].arguments, "{\"text\":\"done\"}");

        let gemini = parse_response(
            ModelProtocol::GeminiContent,
            json!({"candidates":[{"finishReason":"STOP","content":{"parts":[
                {"text":"working"}, {"functionCall":{"name":"reply","args":{"text":"done"}}}
            ]}}]}),
        )
        .unwrap();
        assert_eq!(gemini.tool_calls[0].func_name, "reply");
    }

    #[test]
    fn configured_provider_never_infers_protocol_from_model_name() {
        let mut app = AppConfig::default();
        app.llm.provider = Some("proxy".to_string());
        app.llm.model = "gemini-looking-name".to_string();
        app.providers.insert(
            "proxy".to_string(),
            ProviderConfig {
                protocol: ModelProtocol::AnthropicMessages,
                base_url: "http://localhost:1234/v1".to_string(),
                ..ProviderConfig::default()
            },
        );

        let (_, selected) = build_configured_client(&app, None, None).unwrap();

        assert_eq!(selected.protocol, ModelProtocol::AnthropicMessages);
    }

    #[test]
    fn protocol_client_switches_models_without_rebuilding_the_provider() {
        let client = ProtocolClient::new(
            &ProviderConfig {
                protocol: ModelProtocol::OpenaiResponses,
                base_url: "http://127.0.0.1:1".to_string(),
                ..ProviderConfig::default()
            },
            "model-a".to_string(),
            None,
            &LlmConfig::default(),
        )
        .unwrap();

        assert_eq!(Client::model(&client).as_deref(), Some("model-a"));
        Client::set_model(&client, "model-b").unwrap();
        assert_eq!(Client::model(&client).as_deref(), Some("model-b"));
        let selected_model = Client::model(&client).unwrap();
        assert_eq!(
            client.request_for_model(&selected_model, &messages(), &[])["model"],
            "model-b"
        );
    }

    #[tokio::test]
    async fn usage_calibration_is_isolated_by_scope_and_tool_shape() {
        let client = ProtocolClient::new(
            &ProviderConfig {
                protocol: ModelProtocol::OpenaiChat,
                base_url: "http://127.0.0.1:1".to_string(),
                ..ProviderConfig::default()
            },
            "test-model".to_string(),
            None,
            &LlmConfig::default(),
        )
        .unwrap();
        let prompt = vec![Message {
            role: "user".to_string(),
            content: "hello".to_string(),
            name: None,
            tool_call_id: None,
            tool_calls: None,
        }];

        let first = client
            .count_prompt_tokens("scope-a", &prompt, &[])
            .await
            .unwrap()
            .unwrap();
        let matching_body = client.request_for_model("test-model", &prompt, &[]);
        client.observe_completion_usage("test-model", &matching_body, &first, 123);

        let calibrated = client
            .count_prompt_tokens("scope-a", &prompt, &[])
            .await
            .unwrap()
            .unwrap();
        assert_eq!(calibrated.tokens, 123);
        assert_eq!(
            calibrated.accuracy,
            PromptTokenAccuracy::UsageCalibratedEstimate
        );
        assert_eq!(
            client
                .count_prompt_tokens("scope-b", &prompt, &[])
                .await
                .unwrap()
                .unwrap()
                .accuracy,
            PromptTokenAccuracy::HeuristicEstimate
        );

        let tool_definitions = tools();
        let tool_measurement = client
            .count_prompt_tokens("scope-a", &prompt, &tool_definitions)
            .await
            .unwrap()
            .unwrap();
        client.observe_completion_usage("test-model", &matching_body, &tool_measurement, 999);
        assert_eq!(
            client
                .count_prompt_tokens("scope-a", &prompt, &tool_definitions)
                .await
                .unwrap()
                .unwrap()
                .accuracy,
            PromptTokenAccuracy::HeuristicEstimate
        );
    }

    #[tokio::test]
    async fn all_protocol_clients_reach_their_native_endpoint() {
        let app = Router::new()
            .route(
                "/models",
                get(|| async { Json(json!({"data":[{"id":"model-b"},{"id":"model-a"}]})) }),
            )
            .route(
                "/chat/completions",
                post(|| async {
                    Json(json!({"choices":[{"finish_reason":"stop","message":{"content":"chat"}}]}))
                }),
            )
            .route(
                "/responses",
                post(|| async {
                    Json(json!({"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"responses"}]}]}))
                }),
            )
            .route(
                "/messages",
                post(|| async {
                    Json(json!({"stop_reason":"end_turn","content":[{"type":"text","text":"anthropic"}]}))
                }),
            )
            .route(
                "/models/test-model:generateContent",
                post(|| async {
                    Json(json!({"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"gemini"}]}}]}))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let base_url = format!("http://{address}");
        let prompt = vec![Message {
            role: "user".to_string(),
            content: "hello".to_string(),
            name: None,
            tool_call_id: None,
            tool_calls: None,
        }];

        for (protocol, expected) in [
            (ModelProtocol::OpenaiChat, "chat"),
            (ModelProtocol::OpenaiResponses, "responses"),
            (ModelProtocol::AnthropicMessages, "anthropic"),
            (ModelProtocol::GeminiContent, "gemini"),
        ] {
            let client = ProtocolClient::new(
                &ProviderConfig {
                    protocol,
                    base_url: base_url.clone(),
                    ..ProviderConfig::default()
                },
                "test-model".to_string(),
                None,
                &LlmConfig {
                    max_retries: 1,
                    ..LlmConfig::default()
                },
            )
            .unwrap();
            assert!(client.supports_async_cancellation());
            let response = client
                .create_completion(prompt.clone(), Vec::new())
                .await
                .unwrap();
            assert_eq!(response.content, expected, "protocol={protocol:?}");
            let models = client.list_models().await.unwrap();
            assert_eq!(models, ["model-a", "model-b"]);
        }
    }

    #[test]
    fn codex_request_matches_subscription_backend_contract() {
        let request = json!({
            "model": "codex-model-alpha",
            "input": [
                {"role": "system", "content": "system"},
                {"role": "user", "content": "hello"}
            ],
            "tools": [{"type": "function", "name": "probe"}],
            "max_output_tokens": 64,
            "temperature": 0.5,
            "truncation": "auto",
            "user": "unsupported"
        });

        let adapted = adapt_codex_request(request);

        assert_eq!(adapted.get("store"), Some(&Value::Bool(false)));
        assert_eq!(
            adapted.get("include"),
            Some(&json!(["reasoning.encrypted_content"]))
        );
        assert_eq!(adapted.get("parallel_tool_calls"), Some(&Value::Bool(true)));
        assert_eq!(adapted.get("instructions"), Some(&json!("")));
        assert_eq!(adapted.pointer("/input/0/role"), Some(&json!("developer")));
        for rejected in ["max_output_tokens", "temperature", "truncation", "user"] {
            assert!(adapted.get(rejected).is_none(), "field={rejected}");
        }
    }

    #[tokio::test]
    async fn codex_catalog_uses_client_version_and_slug_ids() {
        let app =
            Router::new().route(
                "/models",
                get(
                    |axum::extract::Query(query): axum::extract::Query<
                        BTreeMap<String, String>,
                    >| async move {
                        let expected_version = codex_client_version();
                        assert_eq!(
                            query.get("client_version").map(String::as_str),
                            Some(expected_version.as_str())
                        );
                        Json(json!({
                            "models": [
                                {"slug": "codex-model-alpha", "context_window": 200000},
                                {"slug": "codex-review-model", "context_window": 120000},
                                {"slug": "codex-model-alpha", "context_window": 200000},
                                {"slug": "codex-model-beta", "context_window": 80000}
                            ]
                        }))
                    },
                ),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = ProtocolClient::new_with_adapter(
            &ProviderConfig {
                protocol: ModelProtocol::OpenaiResponses,
                base_url: format!("http://{address}"),
                ..ProviderConfig::default()
            },
            "openai-codex",
            String::new(),
            None,
            &LlmConfig::default(),
        )
        .unwrap();

        let catalog = client.list_model_catalog().await.unwrap();
        assert_eq!(
            catalog
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            [
                "codex-model-alpha",
                "codex-review-model",
                "codex-model-beta"
            ]
        );
        assert_eq!(catalog[0].profile.context_window_tokens, Some(200_000));
        assert_eq!(catalog[0].profile.max_input_tokens, None);
        assert_eq!(catalog[0].profile.max_output_tokens, None);
    }

    #[tokio::test]
    async fn model_catalog_copies_only_explicit_capacity_fields() {
        let app = Router::new().route(
            "/models",
            get(|| async {
                Json(json!({
                    "data": [
                        {"id": "model-with-context", "context_length": 262144},
                        {
                            "id": "model-with-explicit-limits",
                            "max_input_tokens": 120000,
                            "max_output_tokens": 8000
                        },
                        {"id": "model-without-capacity"}
                    ]
                }))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = ProtocolClient::new_with_adapter(
            &ProviderConfig {
                protocol: ModelProtocol::OpenaiChat,
                base_url: format!("http://{address}"),
                ..ProviderConfig::default()
            },
            "openai-compatible",
            String::new(),
            None,
            &LlmConfig::default(),
        )
        .unwrap();

        let catalog = client.list_model_catalog().await.unwrap();
        assert_eq!(catalog[0].id, "model-with-context");
        assert_eq!(catalog[0].profile.context_window_tokens, Some(262_144));
        assert_eq!(catalog[0].profile.max_input_tokens, None);
        assert_eq!(catalog[0].profile.max_output_tokens, None);
        assert_eq!(catalog[1].id, "model-with-explicit-limits");
        assert_eq!(catalog[1].profile.context_window_tokens, None);
        assert_eq!(catalog[1].profile.max_input_tokens, Some(120_000));
        assert_eq!(catalog[1].profile.max_output_tokens, Some(8_000));
        assert_eq!(catalog[2].id, "model-without-capacity");
        assert_eq!(catalog[2].profile, ProviderModelConfig::default());
    }

    #[tokio::test]
    async fn codex_health_probe_uses_required_streaming_request() {
        let app = Router::new().route(
            "/responses",
            post(|Json(body): Json<Value>| async move {
                assert_eq!(body.get("model"), Some(&json!("codex-model-alpha")));
                assert_eq!(body.get("stream"), Some(&Value::Bool(true)));
                assert_eq!(body.get("store"), Some(&Value::Bool(false)));
                assert_eq!(
                    body.get("include"),
                    Some(&json!(["reasoning.encrypted_content"]))
                );
                assert!(body.get("max_output_tokens").is_none());
                sse(
                    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"MORPHZ_OK\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{}}}\n\n",
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = ProtocolClient::new_with_adapter(
            &ProviderConfig {
                protocol: ModelProtocol::OpenaiResponses,
                base_url: format!("http://{address}"),
                ..ProviderConfig::default()
            },
            "openai-codex",
            "codex-model-alpha".to_string(),
            None,
            &LlmConfig::default(),
        )
        .unwrap();

        client.probe_health().await.unwrap();
    }

    #[tokio::test]
    async fn health_probe_accepts_schema_valid_length_limited_chat_response() {
        let app = Router::new().route(
            "/chat/completions",
            post(|| async {
                Json(json!({
                    "choices": [{
                        "finish_reason": "length",
                        "message": {"content": ""}
                    }]
                }))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = ProtocolClient::new(
            &ProviderConfig {
                protocol: ModelProtocol::OpenaiChat,
                base_url: format!("http://{address}"),
                ..ProviderConfig::default()
            },
            "chat-model-alpha".to_string(),
            None,
            &LlmConfig::default(),
        )
        .unwrap();

        client.probe_health().await.unwrap();
    }

    #[tokio::test]
    async fn setup_model_discovery_uses_ephemeral_api_key_without_catalog_state() {
        let app = Router::new().route(
            "/models",
            get(|headers: axum::http::HeaderMap| async move {
                assert_eq!(
                    headers
                        .get("authorization")
                        .and_then(|value| value.to_str().ok()),
                    Some("Bearer setup-secret")
                );
                Json(json!({"data":[{"id":"model-b"},{"id":"model-a"}]}))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let models = discover_protocol_models(
            ModelProtocol::OpenaiChat,
            &format!("http://{address}"),
            "setup-secret",
        )
        .await
        .unwrap();
        assert_eq!(models, ["model-a", "model-b"]);
    }

    #[tokio::test]
    async fn all_protocol_streams_normalize_text_tools_and_lifecycle() {
        let app = Router::new()
            .route(
                "/chat/completions",
                post(|| async {
                    sse(concat!(
                        "data: {\"choices\":[{\"delta\":{\"content\":\"hel\"}}]}\n\n",
                        "data: {\"choices\":[{\"delta\":{\"content\":\"lo\",\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"reply\",\"arguments\":\"{\\\"text\\\":\"}}]}}]}\n\n",
                        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"done\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
                        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":4,\"total_tokens\":14}}\n\n",
                        "data: [DONE]\n\n"
                    ))
                }),
            )
            .route(
                "/responses",
                post(|| async {
                    sse(concat!(
                        "data: {\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\"summary\"}\n\n",
                        "data: {\"type\":\"response.reasoning_summary_text.done\"}\n\n",
                        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n",
                        "data: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"type\":\"function_call\",\"call_id\":\"c1\",\"name\":\"reply\"}}\n\n",
                        "data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":1,\"delta\":\"{\\\"text\\\":\\\"done\\\"}\"}\n\n",
                        "data: {\"type\":\"response.function_call_arguments.done\",\"output_index\":1}\n\n",
                        "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":10,\"output_tokens\":4,\"total_tokens\":14}}}\n\n"
                    ))
                }),
            )
            .route(
                "/messages",
                post(|| async {
                    sse(concat!(
                        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":4,\"cache_creation_input_tokens\":2,\"cache_read_input_tokens\":4}}}\n\n",
                        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
                        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}\n\n",
                        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"c1\",\"name\":\"reply\",\"input\":{}}}\n\n",
                        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"text\\\":\\\"done\\\"}\"}}\n\n",
                        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
                        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":4}}\n\n",
                        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
                    ))
                }),
            )
            .route(
                "/models/test-model:streamGenerateContent",
                post(|| async {
                    sse(concat!(
                        "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hello\"}]}}]}\n\n",
                        "data: {\"candidates\":[{\"finishReason\":\"STOP\",\"content\":{\"parts\":[{\"functionCall\":{\"name\":\"reply\",\"args\":{\"text\":\"done\"}}}]}}],\"usageMetadata\":{\"promptTokenCount\":10,\"candidatesTokenCount\":4,\"totalTokenCount\":14}}\n\n"
                    ))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let base_url = format!("http://{address}");
        let prompt = vec![Message {
            role: "user".to_string(),
            content: "hello".to_string(),
            name: None,
            tool_call_id: None,
            tool_calls: None,
        }];

        for protocol in [
            ModelProtocol::OpenaiChat,
            ModelProtocol::OpenaiResponses,
            ModelProtocol::AnthropicMessages,
            ModelProtocol::GeminiContent,
        ] {
            let client = ProtocolClient::new(
                &ProviderConfig {
                    protocol,
                    base_url: base_url.clone(),
                    ..ProviderConfig::default()
                },
                "test-model".to_string(),
                None,
                &LlmConfig::default(),
            )
            .unwrap();
            let scope = format!("calibration-{protocol:?}");
            let initial_measurement = client
                .count_prompt_tokens(&scope, &prompt, &[])
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                initial_measurement.accuracy,
                PromptTokenAccuracy::HeuristicEstimate
            );
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            let response = client
                .create_completion_measured_stream(
                    prompt.clone(),
                    Vec::new(),
                    Some(initial_measurement),
                    tx,
                )
                .await
                .unwrap();
            assert_eq!(response.content, "hello", "protocol={protocol:?}");
            assert_eq!(response.tool_calls.len(), 1, "protocol={protocol:?}");
            assert_eq!(response.tool_calls[0].func_name, "reply");
            assert_eq!(response.tool_calls[0].arguments, "{\"text\":\"done\"}");
            let events = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
            assert_eq!(events.first(), Some(&ModelStreamEvent::Started));
            assert_eq!(events.last(), Some(&ModelStreamEvent::Completed));
            assert!(events.iter().any(|event| matches!(
                event,
                ModelStreamEvent::ToolArgumentsDelta { delta, .. } if delta.contains("done")
            )));
            let mut normalized_usage = ModelUsage::default();
            for event in &events {
                if let ModelStreamEvent::Usage { usage } = event {
                    normalized_usage.merge_from(usage);
                }
            }
            assert_eq!(
                normalized_usage.input_tokens,
                Some(10),
                "protocol={protocol:?}"
            );
            assert_eq!(
                normalized_usage.output_tokens,
                Some(4),
                "protocol={protocol:?}"
            );
            assert_eq!(
                normalized_usage.total_tokens,
                Some(14),
                "protocol={protocol:?}"
            );
            assert!(!normalized_usage.raw.is_empty(), "protocol={protocol:?}");
            let reasoning_summaries = events
                .iter()
                .filter_map(|event| match event {
                    ModelStreamEvent::ReasoningSummaryDelta { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>();
            if protocol == ModelProtocol::OpenaiResponses {
                assert_eq!(reasoning_summaries, ["summary"]);
            } else {
                assert!(reasoning_summaries.is_empty(), "protocol={protocol:?}");
            }

            let calibrated = client
                .count_prompt_tokens(&scope, &prompt, &[])
                .await
                .unwrap()
                .unwrap();
            assert_eq!(calibrated.tokens, 10, "protocol={protocol:?}");
            assert_eq!(
                calibrated.accuracy,
                PromptTokenAccuracy::UsageCalibratedEstimate,
                "protocol={protocol:?}"
            );
            assert!(calibrated.source.ends_with("+usage-calibration"));

            let mut expanded_prompt = prompt.clone();
            expanded_prompt[0]
                .content
                .push_str(" with enough additional context to grow the local estimate");
            let expanded = client
                .count_prompt_tokens(&scope, &expanded_prompt, &[])
                .await
                .unwrap()
                .unwrap();
            let estimated_growth = signed_token_delta(
                expanded.base_estimate_tokens,
                calibrated.base_estimate_tokens,
            );
            assert_eq!(
                expanded.tokens,
                apply_signed_token_delta(10, estimated_growth),
                "protocol={protocol:?}"
            );
        }
    }

    #[tokio::test]
    async fn responses_reasoning_only_completion_is_typed_and_preserves_native_continuation() {
        let requests = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&requests);
        let app = Router::new().route(
            "/responses",
            post(move || {
                let observed = Arc::clone(&observed);
                async move {
                    observed.fetch_add(1, Ordering::SeqCst);
                    sse(concat!(
                        "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"reasoning\",\"id\":\"reasoning-1\"}}\n\n",
                        "data: {\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\"still reasoning\"}\n\n",
                        "data: {\"type\":\"response.reasoning_summary_text.done\"}\n\n",
                        "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"reasoning\",\"id\":\"reasoning-1\",\"encrypted_content\":\"opaque-state\"}}\n\n",
                        "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":10,\"output_tokens\":4096,\"total_tokens\":4106}}}\n\n"
                    ))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = ProtocolClient::new(
            &ProviderConfig {
                protocol: ModelProtocol::OpenaiResponses,
                base_url: format!("http://{address}"),
                ..ProviderConfig::default()
            },
            "glm-5.3".to_string(),
            None,
            &LlmConfig {
                max_retries: 5,
                initial_backoff_secs: 0,
                ..LlmConfig::default()
            },
        )
        .unwrap();
        let (stream, mut events) = tokio::sync::mpsc::unbounded_channel();
        let error = client
            .create_completion_measured_stream(
                vec![Message {
                    role: "user".to_string(),
                    content: "continue".to_string(),
                    name: None,
                    tool_call_id: None,
                    tool_calls: None,
                }],
                Vec::new(),
                None,
                stream,
            )
            .await
            .unwrap_err();

        let failure = error.downcast_ref::<ModelFailure>().unwrap();
        assert_eq!(failure.kind, ModelFailureKind::EmptyResponse);
        assert!(!failure.kind.uses_provider_recovery());
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        let events = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
        assert!(events.iter().any(|event| matches!(
            event,
            ModelStreamEvent::ProviderContinuation {
                continuation: ProviderContinuation::OpenaiResponses { reasoning_items }
            } if reasoning_items.iter().any(|item| {
                item["id"] == "reasoning-1" && item["encrypted_content"] == "opaque-state"
            })
        )));
    }

    #[tokio::test]
    async fn all_protocols_deliver_first_text_delta_before_http_body_completes() {
        // The second chunk of every response is held behind a semaphore. This
        // is a real streaming HTTP body, not a pre-concatenated Body::from:
        // receiving `early` while the request task is still blocked proves
        // that ProtocolClient forwards bytes before response completion.
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let chat_gate = gate.clone();
        let responses_gate = gate.clone();
        let anthropic_gate = gate.clone();
        let gemini_gate = gate.clone();
        let app = Router::new()
            .route(
                "/chat/completions",
                post(move || {
                    let gate = chat_gate.clone();
                    async move {
                        gated_sse(
                            vec![
                                "data: {\"choices\":[{\"delta\":{\"content\":\"early\"}}]}\n\n",
                                concat!(
                                    "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                                    "data: [DONE]\n\n"
                                ),
                            ],
                            gate,
                        )
                    }
                }),
            )
            .route(
                "/responses",
                post(move || {
                    let gate = responses_gate.clone();
                    async move {
                        gated_sse(
                            vec![
                                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"early\"}\n\n",
                                "data: {\"type\":\"response.completed\",\"response\":{}}\n\n",
                            ],
                            gate,
                        )
                    }
                }),
            )
            .route(
                "/messages",
                post(move || {
                    let gate = anthropic_gate.clone();
                    async move {
                        gated_sse(
                            vec![
                                "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"early\"}}\n\n",
                                "data: {\"type\":\"message_stop\"}\n\n",
                            ],
                            gate,
                        )
                    }
                }),
            )
            .route(
                "/models/test-model:streamGenerateContent",
                post(move || {
                    let gate = gemini_gate.clone();
                    async move {
                        gated_sse(
                            vec![
                                "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"early\"}]}}]}\n\n",
                                "data: {\"candidates\":[{\"finishReason\":\"STOP\",\"content\":{\"parts\":[]}}]}\n\n",
                            ],
                            gate,
                        )
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let base_url = format!("http://{address}");

        for protocol in [
            ModelProtocol::OpenaiChat,
            ModelProtocol::OpenaiResponses,
            ModelProtocol::AnthropicMessages,
            ModelProtocol::GeminiContent,
        ] {
            let client = ProtocolClient::new(
                &ProviderConfig {
                    protocol,
                    base_url: base_url.clone(),
                    ..ProviderConfig::default()
                },
                "test-model".to_string(),
                None,
                &LlmConfig::default(),
            )
            .unwrap();
            let prompt = vec![Message {
                role: "user".to_string(),
                content: "hello".to_string(),
                name: None,
                tool_call_id: None,
                tool_calls: None,
            }];
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            let request = tokio::spawn(async move {
                client
                    .create_completion_measured_stream(prompt, Vec::new(), None, tx)
                    .await
            });

            assert_eq!(
                tokio::time::timeout(Duration::from_secs(1), rx.recv())
                    .await
                    .unwrap(),
                Some(ModelStreamEvent::Started),
                "protocol={protocol:?}"
            );
            let first_text = loop {
                let event = tokio::time::timeout(Duration::from_secs(1), rx.recv())
                    .await
                    .unwrap()
                    .expect("stream closed before text delta");
                if let ModelStreamEvent::TextDelta { text } = event {
                    break text;
                }
            };
            assert_eq!(first_text, "early", "protocol={protocol:?}");
            assert!(
                !request.is_finished(),
                "protocol={protocol:?} completed before the gated HTTP body"
            );

            gate.add_permits(1);
            let response = tokio::time::timeout(Duration::from_secs(1), request)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert_eq!(response.content, "early", "protocol={protocol:?}");
            assert!(
                std::iter::from_fn(|| rx.try_recv().ok())
                    .any(|event| event == ModelStreamEvent::Completed),
                "protocol={protocol:?}"
            );
        }
    }

    #[tokio::test]
    async fn streaming_idle_timeout_resets_after_every_received_chunk() {
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let route_gate = Arc::clone(&gate);
        let app = Router::new().route(
            "/chat/completions",
            post(move || {
                let gate = Arc::clone(&route_gate);
                async move {
                    gated_sse(
                        vec![
                            "data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\n",
                            "data: {\"choices\":[{\"delta\":{\"content\":\"b\"}}]}\n\n",
                            concat!(
                                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                                "data: [DONE]\n\n"
                            ),
                        ],
                        gate,
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = ProtocolClient::new(
            &ProviderConfig {
                protocol: ModelProtocol::OpenaiChat,
                base_url: format!("http://{address}"),
                ..ProviderConfig::default()
            },
            "test-model".to_string(),
            None,
            &LlmConfig {
                max_retries: 1,
                stream_idle_timeout_secs: 1,
                ..LlmConfig::default()
            },
        )
        .unwrap();
        let prompt = vec![Message {
            role: "user".to_string(),
            content: "hello".to_string(),
            name: None,
            tool_call_id: None,
            tool_calls: None,
        }];
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let request = tokio::spawn(async move {
            client
                .create_completion_measured_stream(prompt, Vec::new(), None, tx)
                .await
        });
        tokio::time::sleep(Duration::from_millis(600)).await;
        gate.add_permits(1);
        tokio::time::sleep(Duration::from_millis(600)).await;
        gate.add_permits(1);

        let response = tokio::time::timeout(Duration::from_secs(1), request)
            .await
            .expect("active stream should outlive one idle window")
            .unwrap()
            .unwrap();
        assert_eq!(response.content, "ab");
    }

    #[tokio::test]
    async fn streaming_distinguishes_first_byte_timeout_from_provider_outage() {
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let route_gate = Arc::clone(&gate);
        let app = Router::new().route(
            "/chat/completions",
            post(move || {
                let gate = Arc::clone(&route_gate);
                async move {
                    gated_first_sse(
                        vec![concat!(
                            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                            "data: [DONE]\n\n"
                        )],
                        gate,
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = ProtocolClient::new(
            &ProviderConfig {
                protocol: ModelProtocol::OpenaiChat,
                base_url: format!("http://{address}"),
                ..ProviderConfig::default()
            },
            "test-model".to_string(),
            None,
            &LlmConfig {
                max_retries: 0,
                first_byte_timeout_secs: 1,
                stream_idle_timeout_secs: 5,
                ..LlmConfig::default()
            },
        )
        .unwrap();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let error = client
            .create_completion_measured_stream(
                vec![Message {
                    role: "user".to_string(),
                    content: "large prompt".to_string(),
                    name: None,
                    tool_call_id: None,
                    tool_calls: None,
                }],
                Vec::new(),
                None,
                tx,
            )
            .await
            .unwrap_err();
        let failure = error.downcast_ref::<ModelFailure>().unwrap();
        assert_eq!(failure.kind, ModelFailureKind::FirstByteTimeout);
        assert!(failure.kind.is_request_scoped_latency());
    }

    #[tokio::test]
    async fn streaming_reports_stall_only_after_forwarding_received_output() {
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let route_gate = Arc::clone(&gate);
        let app = Router::new().route(
            "/chat/completions",
            post(move || {
                let gate = Arc::clone(&route_gate);
                async move {
                    gated_sse(
                        vec![
                            "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n",
                            concat!(
                                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                                "data: [DONE]\n\n"
                            ),
                        ],
                        gate,
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = ProtocolClient::new(
            &ProviderConfig {
                protocol: ModelProtocol::OpenaiChat,
                base_url: format!("http://{address}"),
                ..ProviderConfig::default()
            },
            "test-model".to_string(),
            None,
            &LlmConfig {
                max_retries: 0,
                first_byte_timeout_secs: 5,
                stream_idle_timeout_secs: 1,
                ..LlmConfig::default()
            },
        )
        .unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let request = tokio::spawn(async move {
            client
                .create_completion_measured_stream(
                    vec![Message {
                        role: "user".to_string(),
                        content: "hello".to_string(),
                        name: None,
                        tool_call_id: None,
                        tool_calls: None,
                    }],
                    Vec::new(),
                    None,
                    tx,
                )
                .await
        });
        let partial = loop {
            match tokio::time::timeout(Duration::from_secs(1), rx.recv())
                .await
                .unwrap()
                .unwrap()
            {
                ModelStreamEvent::TextDelta { text } => break text,
                _ => continue,
            }
        };
        assert_eq!(partial, "partial");
        let error = request.await.unwrap().unwrap_err();
        let failure = error.downcast_ref::<ModelFailure>().unwrap();
        assert_eq!(failure.kind, ModelFailureKind::StreamStalled);
        assert!(failure.kind.is_request_scoped_latency());
    }

    #[tokio::test]
    async fn provider_probe_verifies_catalog_stream_and_tool_call_separately() {
        let app = Router::new()
            .route(
                "/models",
                get(|| async { Json(json!({"data":[{"id":"test-model"}]})) }),
            )
            .route(
                "/chat/completions",
                post(|Json(body): Json<Value>| async move {
                    if body.get("tools").and_then(Value::as_array).is_some_and(|v| !v.is_empty()) {
                        sse(concat!(
                            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"probe-1\",\"function\":{\"name\":\"morphz_probe\",\"arguments\":\"{\\\"value\\\":\\\"MORPHZ_OK\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
                            "data: [DONE]\n\n"
                        ))
                    } else {
                        sse(concat!(
                            "data: {\"choices\":[{\"delta\":{\"content\":\"MORPHZ_OK\"},\"finish_reason\":\"stop\"}]}\n\n",
                            "data: [DONE]\n\n"
                        ))
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let mut config = AppConfig::default();
        config.llm.model = "test-model".to_string();
        config.providers.insert(
            "local".to_string(),
            ProviderConfig {
                protocol: ModelProtocol::OpenaiChat,
                base_url: format!("http://{address}"),
                ..ProviderConfig::default()
            },
        );

        let probe = probe_provider(&config, "local", Some("test-model"))
            .await
            .unwrap();

        assert_eq!(probe.models_discovered, 1);
        assert_eq!(probe.selected_model_available, Some(true));
        assert!(probe.completion_stream_verified);
        assert!(probe.tool_call_verified);
        assert!(probe.normalized_stream_events >= 8);
        assert!(probe.catalog_error.is_none());
    }
}

#[cfg(test)]
mod conformance;
