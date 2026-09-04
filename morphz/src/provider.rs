use crate::config::{
    AppConfig, CredentialConfig, CredentialSource, LlmConfig, ModelProtocol, PromptCacheStrategy,
    ProviderConfig, ProviderModelConfig,
};
use crate::llm::{
    model_attachments, model_visible_message_text, provider_continuation, segmented_model_text,
    Client, GeminiFunctionCallContinuation, Message, ModelAttachment, ModelAttemptBinding,
    ModelFailure, ModelFailureKind, ModelStreamEvent, ModelStreamSender, ModelTextPart, ModelUsage,
    PromptTokenAccuracy, PromptTokenCount, ProviderContinuation, ReasoningEffort, Response,
    SegmentedModelText, ToolCallRepr, ToolDefinition, MODEL_ATTACHMENT_MESSAGE_NAME,
};
use base64::Engine;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, RETRY_AFTER, USER_AGENT};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

pub mod auth;
mod claude_oauth;
pub mod control;
pub(crate) mod gemini_schema;
pub mod routing;

pub(crate) type ProviderError = Box<dyn std::error::Error + Send + Sync>;
pub type ConfiguredClient = (Arc<dyn Client>, SelectedProvider);

// ChatGPT's Codex catalog endpoint is versioned independently from Morphz.
// Keep this compatibility value aligned with the Codex request headers and
// allow operators to advance it without rebuilding if the upstream raises its
// minimum client version.
const CODEX_CLIENT_VERSION: &str = "0.144.4";

pub(crate) const ANTIGRAVITY_DAILY_BASE_URL: &str = "https://daily-cloudcode-pa.googleapis.com";
pub(crate) const ANTIGRAVITY_PRODUCTION_BASE_URL: &str = "https://cloudcode-pa.googleapis.com";
const ANTIGRAVITY_FALLBACK_VERSION: &str = "2.9.1";

pub(crate) fn antigravity_request_user_agent() -> String {
    std::env::var("MORPHZ_ANTIGRAVITY_USER_AGENT")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("antigravity/hub/{ANTIGRAVITY_FALLBACK_VERSION} darwin/arm64"))
}

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
        .find_map(|field| positive_usize(row.get(field)))
        .or_else(|| {
            (protocol == ModelProtocol::GeminiContent)
                .then(|| positive_usize(row.get("maxTokens")))
                .flatten()
        });
    let max_input_tokens = positive_usize(row.get("max_input_tokens")).or_else(|| {
        (protocol == ModelProtocol::GeminiContent)
            .then(|| positive_usize(row.get("inputTokenLimit")))
            .flatten()
    });
    let max_output_tokens = positive_usize(row.get("max_output_tokens")).or_else(|| {
        (protocol == ModelProtocol::GeminiContent)
            .then(|| {
                positive_usize(row.get("outputTokenLimit"))
                    .or_else(|| positive_usize(row.get("maxOutputTokens")))
            })
            .flatten()
    });
    // These fields are consumed only when a service returns them explicitly.
    // There is intentionally no model-name table or inferred visual limit.
    let max_input_attachments = positive_usize(row.get("max_input_attachments"));
    let max_input_attachment_bytes = positive_usize(row.get("max_input_attachment_bytes"));
    let max_input_attachment_total_bytes =
        positive_usize(row.get("max_input_attachment_total_bytes"));
    ProviderModelConfig {
        prompt_cache_strategy: PromptCacheStrategy::Auto,
        context_window_tokens,
        max_input_tokens,
        max_output_tokens,
        max_input_attachments,
        max_input_attachment_bytes,
        max_input_attachment_total_bytes,
    }
}

fn push_unique_model_id(ids: &mut Vec<String>, seen: &mut HashSet<String>, value: &Value) {
    let Some(id) = value.as_str().map(str::trim).filter(|id| !id.is_empty()) else {
        return;
    };
    let id = id.strip_prefix("models/").unwrap_or(id).to_string();
    if seen.insert(id.clone()) {
        ids.push(id);
    }
}

fn collect_antigravity_agent_model_ids(
    value: &Value,
    ids: &mut Vec<String>,
    seen: &mut HashSet<String>,
) {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_antigravity_agent_model_ids(value, ids, seen);
            }
        }
        Value::Object(object) => {
            if let Some(Value::Array(model_ids)) = object.get("modelIds") {
                for model_id in model_ids {
                    push_unique_model_id(ids, seen, model_id);
                }
            }
            for (key, value) in object {
                if key != "modelIds" {
                    collect_antigravity_agent_model_ids(value, ids, seen);
                }
            }
        }
        _ => {}
    }
}

fn antigravity_deprecated_model_ids(value: &Value) -> HashSet<String> {
    match value.get("deprecatedModelIds") {
        Some(Value::Array(ids)) => ids
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        Some(Value::Object(ids)) => ids.keys().cloned().collect(),
        _ => HashSet::new(),
    }
}

fn parse_antigravity_model_catalog(
    value: &Value,
) -> Result<Vec<DiscoveredProviderModel>, ProviderError> {
    let metadata = value
        .get("models")
        .and_then(Value::as_object)
        .ok_or("Antigravity model catalog is missing the models object")?;
    let mut ids = Vec::new();
    let mut seen = HashSet::new();
    if let Some(default_model) = value.get("defaultAgentModelId") {
        push_unique_model_id(&mut ids, &mut seen, default_model);
    }
    if let Some(agent_sorts) = value.get("agentModelSorts") {
        collect_antigravity_agent_model_ids(agent_sorts, &mut ids, &mut seen);
    }
    if ids.is_empty() {
        return Err(
            "Antigravity model catalog has no defaultAgentModelId or agentModelSorts modelIds"
                .into(),
        );
    }
    let deprecated = antigravity_deprecated_model_ids(value);
    ids.retain(|id| !deprecated.contains(id));
    if ids.is_empty() {
        return Err("Antigravity model catalog contains only deprecated Agent models".into());
    }
    Ok(ids
        .into_iter()
        .map(|id| DiscoveredProviderModel {
            profile: metadata
                .get(&id)
                .map(|row| discovered_model_profile(row, ModelProtocol::GeminiContent))
                .unwrap_or_default(),
            id,
        })
        .collect())
}

fn response_body_preview(text: String) -> String {
    const MAX_CHARS: usize = 2_000;
    if text.chars().count() <= MAX_CHARS {
        text
    } else {
        format!("{}…", text.chars().take(MAX_CHARS).collect::<String>())
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
            return Err("model alias must not be empty".into());
        }
        let client = routing::RoutedClient::new(app, alias)?;
        let binding = client.primary_binding()?;
        let protocol = match binding.protocol.as_str() {
            "openai-responses" => ModelProtocol::OpenaiResponses,
            "openai-chat" => ModelProtocol::OpenaiChat,
            "anthropic-messages" => ModelProtocol::AnthropicMessages,
            "gemini-content" => ModelProtocol::GeminiContent,
            value => return Err(format!("Model Route returned unknown protocol '{value}'").into()),
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
        .ok_or("no model Provider has been selected; run `morphz setup` first")?;
    let provider = app
        .providers
        .get(&provider_id)
        .ok_or_else(|| format!("Provider '{provider_id}' is not defined in user configuration"))?;
    if provider.base_url.trim().is_empty() {
        return Err(format!("Provider '{provider_id}' base_url must not be empty").into());
    }
    let model = model_override.unwrap_or(&app.llm.model).trim().to_string();
    if model.is_empty() {
        return Err("model name must not be empty".into());
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
        .ok_or_else(|| format!("Provider references nonexistent Credential '{reference}'"))?;
    resolve_credential(reference, credential)
}

pub(crate) fn resolve_credential(
    id: &str,
    credential: &CredentialConfig,
) -> Result<Option<String>, ProviderError> {
    match credential.source {
        CredentialSource::None => Ok(None),
        CredentialSource::Env => {
            let name = credential.name.as_deref().ok_or_else(|| {
                format!("Credential '{id}' is missing an environment variable name")
            })?;
            let value = std::env::var(name)
                .map_err(|_| format!("Credential '{id}' requires environment variable {name}"))?;
            if value.trim().is_empty() {
                Err(format!("environment variable {name} for Credential '{id}' is empty").into())
            } else {
                Ok(Some(value))
            }
        }
        CredentialSource::Keychain => {
            let account = credential.name.as_deref().unwrap_or(id);
            let service = credential.service.as_deref().unwrap_or("morphz");
            let value = keyring::Entry::new(service, account)?.get_password()?;
            if value.trim().is_empty() {
                Err(format!("Keychain value for Credential '{id}' is empty").into())
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
        .ok_or_else(|| format!("command for Credential '{id}' is empty"))?;
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
                return Err(format!("Credential '{id}' Helper exited with status {status}").into());
            }
            let mut value = String::new();
            if let Some(mut stdout) = child.stdout.take() {
                stdout.read_to_string(&mut value)?;
            }
            let value = value.trim().to_string();
            if value.is_empty() {
                return Err(format!("Credential '{id}' Helper returned an empty value").into());
            }
            return Ok(Some(value));
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Credential '{id}' Helper did not finish within 5 seconds").into());
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
        return Err("refusing to write an empty credential to Keychain".into());
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
    request_context: BTreeMap<String, String>,
    max_retries: u32,
    initial_backoff_secs: u64,
    stream_idle_timeout: Duration,
    first_byte_timeout: Duration,
    max_output_tokens: Option<u32>,
    reasoning_effort: RwLock<Option<ReasoningEffort>>,
    model_profiles: BTreeMap<String, ProviderModelConfig>,
    usage_anchors: Mutex<HashMap<u64, PromptUsageAnchor>>,
    /// Recent incremental Context-prefix boundaries, grouped by the exact
    /// stable Provider request cohort. This is transport optimization state:
    /// losing it on restart causes only a cold cache write, never a semantic
    /// change or an Event Store mutation.
    prompt_cache_lineages: Mutex<PromptCacheLineageStore>,
    /// Privacy-preserving fingerprints of the exact OpenAI Responses wire
    /// items sent for each cache cohort. This lets production evidence prove
    /// whether an earlier eligible message boundary is still a byte-identical
    /// prefix without logging prompt or tool contents.
    prompt_cache_wire_audits: Mutex<PromptCacheWireAuditStore>,
}

fn boxed_model_failure(failure: ModelFailure) -> ProviderError {
    Box::new(failure)
}

fn provider_protocol_failure(protocol: ModelProtocol, detail: impl Into<String>) -> ProviderError {
    boxed_model_failure(ModelFailure::new(
        ModelFailureKind::ServerUnavailable,
        format!(
            "{} Provider returned an invalid protocol response: {}",
            protocol.as_str(),
            detail.into()
        ),
    ))
}

fn provider_empty_response(protocol: ModelProtocol, detail: impl Into<String>) -> ProviderError {
    boxed_model_failure(ModelFailure::new(
        ModelFailureKind::EmptyResponse,
        format!(
            "{} Provider completed the request without usable output: {}",
            protocol.as_str(),
            detail.into()
        ),
    ))
}

fn provider_safety_refusal(protocol: ModelProtocol, detail: impl Into<String>) -> ProviderError {
    boxed_model_failure(
        ModelFailure::new(
            ModelFailureKind::SafetyRefusal,
            format!(
                "{} Provider explicitly refused the request at its safety boundary: {}",
                protocol.as_str(),
                detail.into()
            ),
        )
        .with_provider_code(Some("refusal".to_string())),
    )
}

fn provider_incomplete_response(protocol: ModelProtocol, reason: &str) -> ProviderError {
    let normalized_reason = reason.trim();
    let kind = match normalized_reason {
        "max_output_tokens" | "max_tokens" => ModelFailureKind::OutputLimit,
        "content_filter" => ModelFailureKind::SafetyRefusal,
        _ => ModelFailureKind::IncompleteResponse,
    };
    let message = match kind {
        ModelFailureKind::OutputLimit => format!(
            "{} Provider ended the physical response at its output-token boundary",
            protocol.as_str()
        ),
        ModelFailureKind::SafetyRefusal => format!(
            "{} Provider ended the response incomplete at its content-filter boundary",
            protocol.as_str()
        ),
        _ => format!(
            "{} Provider ended the response with an incomplete terminal (reason={})",
            protocol.as_str(),
            if normalized_reason.is_empty() {
                "unspecified"
            } else {
                normalized_reason
            }
        ),
    };
    boxed_model_failure(
        ModelFailure::new(kind, message).with_provider_code(
            (!normalized_reason.is_empty()).then(|| normalized_reason.to_string()),
        ),
    )
}

fn incomplete_reason(error: &ProviderError) -> Option<String> {
    let failure = error.downcast_ref::<ModelFailure>()?;
    if matches!(
        failure.kind,
        ModelFailureKind::OutputLimit | ModelFailureKind::IncompleteResponse
    ) || (failure.kind == ModelFailureKind::SafetyRefusal
        && failure.provider_code.as_deref() == Some("content_filter"))
    {
        Some(
            failure
                .provider_code
                .clone()
                .unwrap_or_else(|| "unspecified".to_string()),
        )
    } else {
        None
    }
}

fn provider_stream_error(protocol: ModelProtocol, payload: &str) -> ProviderError {
    let message = format!(
        "{} Provider stream returned an error event: {payload}",
        protocol.as_str()
    );
    let provider_code = provider_error_code(payload);
    let classified = ModelFailure::classify_message(message.clone());
    let kind = provider_failure_kind_from_code(provider_code.as_deref()).unwrap_or(
        match classified.kind {
            ModelFailureKind::Unknown | ModelFailureKind::EmptyResponse => {
                ModelFailureKind::ServerUnavailable
            }
            kind => kind,
        },
    );
    boxed_model_failure(ModelFailure::new(kind, message).with_provider_code(provider_code))
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

/// Maps only provider-authored, semantically unambiguous error codes.
///
/// Message classification remains the compatibility path for providers that
/// do not expose structured codes. Keeping this map exact is important: a
/// generic word such as `policy` can occur in transient gateway or account
/// errors and must not turn those failures into permanent safety refusals.
fn provider_failure_kind_from_code(code: Option<&str>) -> Option<ModelFailureKind> {
    match code {
        Some("cyber_policy") => Some(ModelFailureKind::SafetyRefusal),
        _ => None,
    }
}

fn http_model_failure(
    status: reqwest::StatusCode,
    body: String,
    retry_after: Option<u64>,
) -> ModelFailure {
    let message = format!("Provider returned HTTP {status}: {body}");
    // Classify the provider-authored body before adding the HTTP status text.
    // Otherwise every 403 body contains our synthetic "403 Forbidden"
    // prefix and is flattened into Authentication before quota/permission
    // semantics can be observed.
    let semantic = ModelFailure::classify_message(body.clone());
    let provider_code = provider_error_code(&body);
    let kind = if let Some(kind) = provider_failure_kind_from_code(provider_code.as_deref()) {
        kind
    } else if semantic.kind == ModelFailureKind::ContextLimit {
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
    } else if status.as_u16() == 401
        || (status.as_u16() == 403 && semantic.kind == ModelFailureKind::Authentication)
    {
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

const OPENAI_MAX_EXPLICIT_CACHE_BOUNDARIES: usize = 4;
const OPENAI_TRACKED_CACHE_BOUNDARIES: usize = 50;
const OPENAI_TRACKED_CACHE_COHORTS: usize = 256;
const OPENAI_TRACKED_WIRE_REQUESTS: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PromptCacheWireMode {
    /// Preserve the canonical model-visible text as one string and let the
    /// physical endpoint choose its implicit prefix boundary.
    ImplicitText,
    /// Preserve Morphz's planned boundaries as content blocks and mark them
    /// with the public Responses API's explicit breakpoint metadata.
    ExplicitContentBoundaries,
    /// Preserve the same content-block boundaries without explicit metadata.
    /// The ChatGPT Codex backend rejects the public breakpoint fields, while
    /// still accepting standard Responses `input_text` blocks.
    ImplicitContentBoundaries,
    /// Preserve the same canonical text and User role, but emit every
    /// structural segment as a consecutive Responses message item. Keeping
    /// old item boundaries fixed lets a growing Inbox remain append-only.
    ImplicitMessageBoundaries,
}

impl PromptCacheWireMode {
    fn cohort_tag(self) -> &'static [u8] {
        match self {
            Self::ImplicitText => b"implicit-prefix",
            Self::ExplicitContentBoundaries => b"explicit-content-boundaries",
            Self::ImplicitContentBoundaries => b"implicit-content-boundaries",
            Self::ImplicitMessageBoundaries => b"implicit-message-boundaries",
        }
    }

    fn plans_cache_boundaries(self) -> bool {
        self == Self::ExplicitContentBoundaries
    }

    fn emits_content_blocks(self) -> bool {
        matches!(
            self,
            Self::ExplicitContentBoundaries | Self::ImplicitContentBoundaries
        )
    }

    fn emits_explicit_breakpoints(self) -> bool {
        self == Self::ExplicitContentBoundaries
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PromptCacheBoundaryIdentity {
    visible_bytes: usize,
    digest: [u8; 32],
}

#[derive(Debug, Default)]
struct PromptCacheLineageStore {
    histories: HashMap<String, VecDeque<PromptCacheBoundaryIdentity>>,
    recency: VecDeque<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PromptCacheWireItemIdentity {
    kind: &'static str,
    encoded_bytes: usize,
    digest: [u8; 32],
}

#[derive(Debug, Clone)]
struct PromptCacheWireSnapshot {
    sequence: u64,
    request_digest: [u8; 32],
    request_properties_digest: [u8; 32],
    input_items: Vec<PromptCacheWireItemIdentity>,
    content_blocks: Vec<PromptCacheWireItemIdentity>,
    latest_implicit_boundary_items: Option<usize>,
}

#[derive(Debug, Clone)]
struct PromptCacheWireAudit {
    sequence: u64,
    cohort_prefix: String,
    request_digest_prefix: String,
    request_properties_digest_prefix: String,
    input_item_count: usize,
    latest_implicit_boundary_items: Option<usize>,
    latest_implicit_boundary_digest_prefix: Option<String>,
    previous_sequence: Option<u64>,
    previous_input_item_count: Option<usize>,
    longest_common_input_items: usize,
    previous_is_strict_prefix: bool,
    content_block_count: usize,
    previous_content_block_count: Option<usize>,
    longest_common_content_blocks: usize,
    previous_content_blocks_is_strict_prefix: bool,
    matched_prior_boundary_items: usize,
    matched_prior_boundary_sequence: Option<u64>,
    matched_prior_boundary_digest_prefix: Option<String>,
    input_item_fingerprints: String,
    content_block_fingerprints: String,
}

#[derive(Debug, Default)]
struct PromptCacheWireAuditStore {
    histories: HashMap<String, VecDeque<PromptCacheWireSnapshot>>,
    recency: VecDeque<String>,
    next_sequence: u64,
}

impl PromptCacheWireAuditStore {
    fn record(
        &mut self,
        cohort_key: &str,
        mut snapshot: PromptCacheWireSnapshot,
    ) -> PromptCacheWireAudit {
        self.next_sequence = self.next_sequence.saturating_add(1);
        snapshot.sequence = self.next_sequence;

        self.recency.retain(|key| key != cohort_key);
        self.recency.push_front(cohort_key.to_string());
        while self.recency.len() > OPENAI_TRACKED_CACHE_COHORTS {
            if let Some(stale_key) = self.recency.pop_back() {
                self.histories.remove(&stale_key);
            }
        }

        let history = self.histories.entry(cohort_key.to_string()).or_default();
        let previous = history.front();
        let longest_common_input_items = previous
            .map(|prior| common_wire_item_prefix_len(&prior.input_items, &snapshot.input_items))
            .unwrap_or_default();
        let previous_is_strict_prefix = previous.is_some_and(|prior| {
            prior.request_properties_digest == snapshot.request_properties_digest
                && prior.input_items.len() < snapshot.input_items.len()
                && longest_common_input_items == prior.input_items.len()
        });
        let longest_common_content_blocks = previous
            .map(|prior| {
                common_wire_item_prefix_len(&prior.content_blocks, &snapshot.content_blocks)
            })
            .unwrap_or_default();
        let previous_content_blocks_is_strict_prefix = previous.is_some_and(|prior| {
            prior.request_properties_digest == snapshot.request_properties_digest
                && prior.content_blocks.len() < snapshot.content_blocks.len()
                && longest_common_content_blocks == prior.content_blocks.len()
        });

        let matched_prior = history
            .iter()
            .filter(|prior| prior.request_properties_digest == snapshot.request_properties_digest)
            .filter_map(|prior| {
                let boundary_items = prior.latest_implicit_boundary_items?;
                wire_item_prefix_matches(&prior.input_items, &snapshot.input_items, boundary_items)
                    .then_some((prior, boundary_items))
            })
            .max_by_key(|(_, boundary_items)| *boundary_items);
        let matched_prior_boundary_items = matched_prior
            .map(|(_, boundary_items)| boundary_items)
            .unwrap_or_default();
        let matched_prior_boundary_sequence = matched_prior.map(|(prior, _)| prior.sequence);
        let matched_prior_boundary_digest_prefix = matched_prior.map(|(prior, boundary_items)| {
            digest_prefix(&wire_item_prefix_digest(&prior.input_items, boundary_items))
        });

        let audit = PromptCacheWireAudit {
            sequence: snapshot.sequence,
            cohort_prefix: cohort_key.chars().take(16).collect(),
            request_digest_prefix: digest_prefix(&snapshot.request_digest),
            request_properties_digest_prefix: digest_prefix(&snapshot.request_properties_digest),
            input_item_count: snapshot.input_items.len(),
            latest_implicit_boundary_items: snapshot.latest_implicit_boundary_items,
            latest_implicit_boundary_digest_prefix: snapshot.latest_implicit_boundary_items.map(
                |boundary_items| {
                    digest_prefix(&wire_item_prefix_digest(
                        &snapshot.input_items,
                        boundary_items,
                    ))
                },
            ),
            previous_sequence: previous.map(|prior| prior.sequence),
            previous_input_item_count: previous.map(|prior| prior.input_items.len()),
            longest_common_input_items,
            previous_is_strict_prefix,
            content_block_count: snapshot.content_blocks.len(),
            previous_content_block_count: previous.map(|prior| prior.content_blocks.len()),
            longest_common_content_blocks,
            previous_content_blocks_is_strict_prefix,
            matched_prior_boundary_items,
            matched_prior_boundary_sequence,
            matched_prior_boundary_digest_prefix,
            input_item_fingerprints: wire_item_diagnostics(&snapshot.input_items),
            content_block_fingerprints: wire_item_diagnostics(&snapshot.content_blocks),
        };

        history.push_front(snapshot);
        history.truncate(OPENAI_TRACKED_WIRE_REQUESTS);
        audit
    }
}

impl PromptCacheLineageStore {
    fn history_mut(&mut self, cohort_key: &str) -> &mut VecDeque<PromptCacheBoundaryIdentity> {
        self.recency.retain(|key| key != cohort_key);
        self.recency.push_front(cohort_key.to_string());
        while self.recency.len() > OPENAI_TRACKED_CACHE_COHORTS {
            if let Some(stale_key) = self.recency.pop_back() {
                self.histories.remove(&stale_key);
            }
        }
        self.histories.entry(cohort_key.to_string()).or_default()
    }
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

fn hash_prompt_cache_field(hasher: &mut Sha256, value: &[u8]) {
    hasher.update(value.len().to_le_bytes());
    hasher.update(value);
}

fn sha256_json(value: &Value) -> [u8; 32] {
    Sha256::digest(serde_json::to_vec(value).unwrap_or_default()).into()
}

fn digest_prefix(digest: &[u8; 32]) -> String {
    digest
        .iter()
        .take(6)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn prompt_cache_wire_item_kind(item: &Value) -> &'static str {
    match item.get("role").and_then(Value::as_str) {
        Some("user") => "user",
        Some("developer") => "developer",
        Some("system") => "system",
        Some("assistant") => "assistant",
        Some("tool") => "tool",
        Some(_) => "other-role",
        None => match item.get("type").and_then(Value::as_str) {
            Some("function_call_output") => "function-call-output",
            Some("function_call") => "function-call",
            Some("reasoning") => "reasoning",
            Some("message") => "message",
            Some(_) => "other-type",
            None => "unknown",
        },
    }
}

fn prompt_cache_wire_content_block_kind(block: &Value) -> &'static str {
    match block.get("type").and_then(Value::as_str) {
        Some("input_text") => "input-text",
        Some("input_image") => "input-image",
        Some("input_file") => "input-file",
        Some(_) => "other-content",
        None => "unknown-content",
    }
}

fn prompt_cache_wire_item_is_implicitly_eligible(item: &Value) -> bool {
    matches!(
        item.get("role").and_then(Value::as_str),
        Some("user" | "tool")
    ) || item.get("type").and_then(Value::as_str) == Some("function_call_output")
}

fn prompt_cache_wire_snapshot(body: &Value) -> Option<PromptCacheWireSnapshot> {
    let input = body.get("input")?.as_array()?;
    let input_items = input
        .iter()
        .map(|item| {
            let encoded = serde_json::to_vec(item).unwrap_or_default();
            PromptCacheWireItemIdentity {
                kind: prompt_cache_wire_item_kind(item),
                encoded_bytes: encoded.len(),
                digest: Sha256::digest(&encoded).into(),
            }
        })
        .collect::<Vec<_>>();
    let content_blocks = input
        .iter()
        .enumerate()
        .flat_map(|(item_index, item)| {
            item.get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(move |block| {
                    let encoded = serde_json::to_vec(block).unwrap_or_default();
                    let mut hasher = Sha256::new();
                    hash_prompt_cache_field(
                        &mut hasher,
                        b"morphz.prompt-cache-wire-content-block.v1",
                    );
                    hash_prompt_cache_field(&mut hasher, &item_index.to_le_bytes());
                    hash_prompt_cache_field(&mut hasher, &encoded);
                    PromptCacheWireItemIdentity {
                        kind: prompt_cache_wire_content_block_kind(block),
                        encoded_bytes: encoded.len(),
                        digest: hasher.finalize().into(),
                    }
                })
        })
        .collect::<Vec<_>>();
    let explicit_only = body
        .pointer("/prompt_cache_options/mode")
        .and_then(Value::as_str)
        == Some("explicit");
    let latest_implicit_boundary_items = (!explicit_only)
        .then(|| {
            input
                .iter()
                .rposition(prompt_cache_wire_item_is_implicitly_eligible)
                .map(|index| index + 1)
        })
        .flatten();
    let mut request_properties = body.clone();
    request_properties.as_object_mut()?.remove("input");

    Some(PromptCacheWireSnapshot {
        sequence: 0,
        request_digest: sha256_json(body),
        request_properties_digest: sha256_json(&request_properties),
        input_items,
        content_blocks,
        latest_implicit_boundary_items,
    })
}

fn common_wire_item_prefix_len(
    previous: &[PromptCacheWireItemIdentity],
    current: &[PromptCacheWireItemIdentity],
) -> usize {
    previous
        .iter()
        .zip(current)
        .take_while(|(left, right)| left == right)
        .count()
}

fn wire_item_prefix_matches(
    previous: &[PromptCacheWireItemIdentity],
    current: &[PromptCacheWireItemIdentity],
    prefix_items: usize,
) -> bool {
    prefix_items <= previous.len()
        && prefix_items <= current.len()
        && previous[..prefix_items] == current[..prefix_items]
}

fn wire_item_prefix_digest(items: &[PromptCacheWireItemIdentity], prefix_items: usize) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hash_prompt_cache_field(&mut hasher, b"morphz.prompt-cache-wire-prefix.v1");
    for item in items.iter().take(prefix_items) {
        hash_prompt_cache_field(&mut hasher, &item.digest);
    }
    hasher.finalize().into()
}

fn wire_item_diagnostics(items: &[PromptCacheWireItemIdentity]) -> String {
    items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            format!(
                "{index}:{}:{}:{}",
                item.kind,
                item.encoded_bytes,
                digest_prefix(&item.digest)
            )
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn prompt_cache_cohort_key(
    model: &str,
    reasoning_effort: Option<ReasoningEffort>,
    wire_mode: PromptCacheWireMode,
    messages: &[Message],
    tools: &[ToolDefinition],
) -> Option<String> {
    let segmented_index = messages
        .iter()
        .position(|message| segmented_model_text(message).is_some())?;
    let segmented = segmented_model_text(&messages[segmented_index])?;
    let stable_end = segmented
        .parts
        .iter()
        .position(|part| part.cache_boundary_after && !part.cache_boundary_candidate_after)?;

    let mut hasher = Sha256::new();
    hash_prompt_cache_field(&mut hasher, b"morphz.prompt-cache-cohort.v3");
    hash_prompt_cache_field(&mut hasher, model.as_bytes());
    hash_prompt_cache_field(&mut hasher, wire_mode.cohort_tag());
    hash_prompt_cache_field(
        &mut hasher,
        reasoning_effort
            .map(ReasoningEffort::as_str)
            .unwrap_or("provider_default")
            .as_bytes(),
    );
    for tool in tools {
        hash_prompt_cache_field(&mut hasher, tool.name.as_bytes());
        hash_prompt_cache_field(&mut hasher, tool.description.as_bytes());
        hash_prompt_cache_field(
            &mut hasher,
            serde_json::to_string(&tool.parameters)
                .unwrap_or_default()
                .as_bytes(),
        );
    }
    for (index, message) in messages.iter().enumerate().take(segmented_index + 1) {
        hash_prompt_cache_field(&mut hasher, message.role.as_bytes());
        if index == segmented_index {
            for part in segmented.parts.iter().take(stable_end + 1) {
                hash_prompt_cache_field(&mut hasher, part.text.as_bytes());
            }
        } else {
            hash_prompt_cache_field(&mut hasher, model_visible_message_text(message).as_bytes());
            hash_prompt_cache_field(
                &mut hasher,
                message.name.as_deref().unwrap_or_default().as_bytes(),
            );
        }
    }
    let digest = format!("{:x}", hasher.finalize());
    Some(format!("morphz-v3-{}", &digest[..54]))
}

fn incremental_cache_boundary_candidates(
    segmented: &SegmentedModelText,
) -> Vec<(usize, PromptCacheBoundaryIdentity)> {
    let mut hasher = Sha256::new();
    let mut visible_bytes = 0usize;
    let mut candidates = Vec::new();
    for (index, part) in segmented.parts.iter().enumerate() {
        hasher.update(part.text.as_bytes());
        visible_bytes = visible_bytes.saturating_add(part.text.len());
        if part.cache_boundary_candidate_after {
            candidates.push((
                index,
                PromptCacheBoundaryIdentity {
                    visible_bytes,
                    digest: hasher.clone().finalize().into(),
                },
            ));
        }
    }
    candidates
}

fn prompt_cache_boundary_diagnostics(segmented: &SegmentedModelText) -> String {
    let mut hasher = Sha256::new();
    let mut visible_bytes = 0usize;
    let mut boundaries = Vec::new();
    for part in &segmented.parts {
        hasher.update(part.text.as_bytes());
        visible_bytes = visible_bytes.saturating_add(part.text.len());
        if !part.cache_boundary_after {
            continue;
        }
        let digest = hasher.clone().finalize();
        let digest_prefix = digest
            .iter()
            .take(6)
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        boundaries.push(format!("{visible_bytes}:{digest_prefix}"));
    }
    boundaries.join(",")
}

/// Select at most four OpenAI explicit breakpoints: fixed protocol, the
/// longest still-matching recent Inbox prefixes, and the current Inbox end.
/// Returning the current identity lets the caller remember it for the next
/// physical request without persisting cache state into Context semantics.
fn plan_incremental_cache_boundaries(
    segmented: &mut SegmentedModelText,
    history: &VecDeque<PromptCacheBoundaryIdentity>,
) -> Option<PromptCacheBoundaryIdentity> {
    let candidates = incremental_cache_boundary_candidates(segmented);
    let (current_index, current_identity) = candidates.last()?.clone();

    for part in &mut segmented.parts {
        if part.cache_boundary_candidate_after {
            part.cache_boundary_after = false;
        }
    }
    let fixed_boundaries = segmented
        .parts
        .iter()
        .filter(|part| part.cache_boundary_after && !part.cache_boundary_candidate_after)
        .count();
    let mut selected = HashSet::from([current_index]);
    let mut matching_history = history
        .iter()
        .filter_map(|prior| {
            candidates
                .iter()
                .find(|(_, candidate)| candidate == prior)
                .map(|(index, candidate)| (*index, candidate.visible_bytes))
        })
        .collect::<Vec<_>>();
    matching_history.sort_by_key(|candidate| std::cmp::Reverse(candidate.1));
    matching_history.dedup_by_key(|(index, _)| *index);
    let remaining = OPENAI_MAX_EXPLICIT_CACHE_BOUNDARIES
        .saturating_sub(fixed_boundaries.saturating_add(selected.len()));
    for (index, _) in matching_history.into_iter().take(remaining) {
        selected.insert(index);
    }
    for index in selected {
        segmented.parts[index].cache_boundary_after = true;
    }
    Some(current_identity)
}

fn coalesce_selected_cache_parts(parts: &[ModelTextPart]) -> Vec<ModelTextPart> {
    let mut coalesced = Vec::new();
    let mut text = String::new();
    for part in parts {
        text.push_str(&part.text);
        if part.cache_boundary_after {
            coalesced.push(ModelTextPart {
                text: std::mem::take(&mut text),
                cache_boundary_after: true,
                cache_boundary_candidate_after: false,
            });
        }
    }
    if !text.is_empty() {
        coalesced.push(ModelTextPart {
            text,
            cache_boundary_after: false,
            cache_boundary_candidate_after: false,
        });
    }
    coalesced
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
        Self::new_with_adapter_and_context(
            provider,
            adapter,
            model,
            credential,
            llm,
            BTreeMap::new(),
        )
    }

    pub(crate) fn new_with_adapter_and_context(
        provider: &ProviderConfig,
        adapter: &str,
        model: String,
        credential: Option<String>,
        llm: &LlmConfig,
        request_context: BTreeMap<String, String>,
    ) -> Result<Self, ProviderError> {
        if provider.models.get(&model).is_some_and(|profile| {
            profile.prompt_cache_strategy == PromptCacheStrategy::ExperimentalStructuredDeltas
        }) && !cfg!(feature = "experimental-structured-context-delta-cache")
        {
            return Err("prompt_cache_strategy=experimental-structured-deltas requires build feature experimental-structured-context-delta-cache".into());
        }
        let mut headers = HeaderMap::new();
        for (name, value) in &provider.headers {
            headers.insert(
                HeaderName::from_bytes(name.as_bytes())?,
                HeaderValue::from_str(value)?,
            );
        }
        for (name, variable) in &provider.env_headers {
            let value = std::env::var(variable).map_err(|_| {
                format!("Provider Header '{name}' requires environment variable {variable}")
            })?;
            headers.insert(
                HeaderName::from_bytes(name.as_bytes())?,
                HeaderValue::from_str(&value)?,
            );
        }
        if adapter == "google-antigravity" && !headers.contains_key(USER_AGENT) {
            headers.insert(
                USER_AGENT,
                HeaderValue::from_str(&antigravity_request_user_agent())?,
            );
        }
        let mut http_builder =
            crate::http_transport::client_builder(crate::http_transport::HttpProxyScope::Provider)
                .connect_timeout(Duration::from_secs(llm.connect_timeout_secs.max(1)));
        // Antigravity rejects or intermittently stalls HTTP/2 requests. This
        // is a physical-provider compatibility requirement, not a Gemini
        // protocol rule, so it is scoped to the adapter.
        if adapter == "google-antigravity" {
            http_builder = http_builder.http1_only();
        }
        let http = crate::http_transport::build_client(
            http_builder,
            crate::http_transport::HttpProxyScope::Provider,
        )?;
        Ok(Self {
            http,
            protocol: provider.protocol,
            adapter: adapter.to_string(),
            base_url: provider.base_url.trim_end_matches('/').to_string(),
            model: RwLock::new(model),
            credential,
            headers,
            request_context,
            max_retries: llm.max_retries.max(1),
            initial_backoff_secs: llm.initial_backoff_secs,
            stream_idle_timeout: Duration::from_secs(llm.stream_idle_timeout_secs.max(1)),
            first_byte_timeout: Duration::from_secs(llm.first_byte_timeout_secs.max(1)),
            max_output_tokens: llm.max_output_tokens,
            reasoning_effort: RwLock::new(llm.reasoning_effort),
            model_profiles: provider.models.clone(),
            usage_anchors: Mutex::new(HashMap::new()),
            prompt_cache_lineages: Mutex::new(PromptCacheLineageStore::default()),
            prompt_cache_wire_audits: Mutex::new(PromptCacheWireAuditStore::default()),
        })
    }

    fn model_snapshot(&self) -> String {
        self.model
            .read()
            .map(|model| model.clone())
            .unwrap_or_default()
    }

    fn protocol_for_model(&self, model: &str) -> ModelProtocol {
        self.protocol.effective_for_model(model)
    }

    fn request_reasoning_effort(
        &self,
        model: &str,
        reasoning_override: Option<Option<ReasoningEffort>>,
    ) -> Option<ReasoningEffort> {
        let reasoning_effort = reasoning_override.unwrap_or_else(|| {
            self.reasoning_effort
                .read()
                .map(|effort| *effort)
                .unwrap_or(None)
        });
        normalize_reasoning_effort_for_model(self.adapter.as_str(), model, reasoning_effort)
    }

    fn prepare_prompt_cache_messages(
        &self,
        model: &str,
        messages: Vec<Message>,
        tools: &[ToolDefinition],
        reasoning_override: Option<Option<ReasoningEffort>>,
        record_current_boundary: bool,
    ) -> Result<Vec<Message>, ProviderError> {
        let protocol = self.protocol_for_model(model);
        let mut messages = if matches!(
            protocol,
            ModelProtocol::OpenaiChat | ModelProtocol::OpenaiResponses
        ) {
            normalize_openai_tool_result_batches(messages)?
        } else {
            messages
        };
        if protocol != ModelProtocol::OpenaiResponses {
            return Ok(messages);
        }
        let reasoning_effort = self.request_reasoning_effort(model, reasoning_override);
        let wire_mode = self.prompt_cache_wire_mode(model);
        let Some(cohort_key) =
            prompt_cache_cohort_key(model, reasoning_effort, wire_mode, &messages, tools)
        else {
            return Ok(messages);
        };

        for message in &mut messages {
            let Some(mut segmented) = segmented_model_text(message) else {
                continue;
            };
            segmented.prompt_cache_key = Some(cohort_key.clone());
            if wire_mode.plans_cache_boundaries() {
                if let Ok(mut lineages) = self.prompt_cache_lineages.lock() {
                    let tracked_cohorts_before = lineages.histories.len();
                    let history = lineages.history_mut(&cohort_key);
                    let history_before = history.len();
                    let candidate_count = incremental_cache_boundary_candidates(&segmented).len();
                    if let Some(current) =
                        plan_incremental_cache_boundaries(&mut segmented, history)
                    {
                        if record_current_boundary {
                            history.retain(|prior| prior != &current);
                            history.push_front(current);
                            history.truncate(OPENAI_TRACKED_CACHE_BOUNDARIES);
                        }
                    }
                    let cohort_prefix = cohort_key.chars().take(16).collect::<String>();
                    let selected_boundaries = prompt_cache_boundary_diagnostics(&segmented);
                    tracing::info!(
                        model,
                        cache_cohort = %cohort_prefix,
                        tracked_cohorts_before,
                        history_before,
                        history_after = history.len(),
                        candidate_count,
                        selected_boundaries = %selected_boundaries,
                        record_current_boundary,
                        event_code = "provider.prompt_cache.plan",
                        wire_mode = ?wire_mode,
                        "Planned Prompt Cache content boundaries"
                    );
                } else {
                    let empty_history = VecDeque::new();
                    plan_incremental_cache_boundaries(&mut segmented, &empty_history);
                }
            }
            message.content = serde_json::to_string(&segmented)?;
            break;
        }
        Ok(messages)
    }

    fn endpoint_for(&self, streaming: bool, model: &str) -> Result<String, ProviderError> {
        if self.adapter == "google-antigravity" {
            let configured_root = self
                .base_url
                .trim_end_matches('/')
                .trim_end_matches("/v1internal");
            // Older Morphz releases persisted the production control-plane
            // host as the inference endpoint. Treat both built-in host values
            // as one compatibility family so those accounts migrate to the
            // current daily inference endpoint without another OAuth login.
            let root = if configured_root == ANTIGRAVITY_DAILY_BASE_URL
                || configured_root == ANTIGRAVITY_PRODUCTION_BASE_URL
            {
                ANTIGRAVITY_DAILY_BASE_URL
            } else {
                configured_root
            };
            let method = if streaming {
                "streamGenerateContent?alt=sse"
            } else {
                "generateContent"
            };
            return Ok(format!("{root}/v1internal:{method}"));
        }
        let endpoint = match self.protocol_for_model(model) {
            ModelProtocol::OpenaiResponses => format!("{}/responses", self.base_url),
            ModelProtocol::OpenaiChat => format!("{}/chat/completions", self.base_url),
            ModelProtocol::AnthropicMessages if self.adapter == "claude-code" => {
                format!("{}/messages?beta=true", self.base_url)
            }
            ModelProtocol::AnthropicMessages => format!("{}/messages", self.base_url),
            ModelProtocol::GeminiContent => {
                let mut url = reqwest::Url::parse(&self.base_url)?;
                let method = if streaming {
                    "streamGenerateContent"
                } else {
                    "generateContent"
                };
                url.path_segments_mut()
                    .map_err(|_| "Gemini Provider base_url cannot be used as a hierarchical URL")?
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

    fn request_for_model_with_reasoning(
        &self,
        model: &str,
        messages: &[Message],
        tools: &[ToolDefinition],
        reasoning_override: Option<Option<ReasoningEffort>>,
    ) -> Value {
        let reasoning_effort = self.request_reasoning_effort(model, reasoning_override);
        let request = build_request_with_prompt_cache(
            self.protocol_for_model(model),
            model,
            self.max_output_tokens,
            reasoning_effort,
            messages,
            tools,
            self.prompt_cache_wire_mode(model),
        );
        self.adapt_request(model, request, tools)
    }

    fn record_prompt_cache_wire_audit(
        &self,
        model: &str,
        body: &Value,
    ) -> Option<PromptCacheWireAudit> {
        if self.protocol_for_model(model) != ModelProtocol::OpenaiResponses {
            return None;
        }
        let cohort_key = body.get("prompt_cache_key")?.as_str()?;
        let snapshot = prompt_cache_wire_snapshot(body)?;
        let audit = self
            .prompt_cache_wire_audits
            .lock()
            .ok()?
            .record(cohort_key, snapshot);
        tracing::info!(
            model,
            adapter = self.adapter.as_str(),
            cache_cohort = %audit.cohort_prefix,
            request_sequence = audit.sequence,
            request_digest = %audit.request_digest_prefix,
            request_properties_digest = %audit.request_properties_digest_prefix,
            input_item_count = audit.input_item_count,
            latest_implicit_boundary_items = ?audit.latest_implicit_boundary_items,
            latest_implicit_boundary_digest = ?audit.latest_implicit_boundary_digest_prefix,
            previous_sequence = ?audit.previous_sequence,
            previous_input_item_count = ?audit.previous_input_item_count,
            longest_common_input_items = audit.longest_common_input_items,
            previous_is_strict_prefix = audit.previous_is_strict_prefix,
            content_block_count = audit.content_block_count,
            previous_content_block_count = ?audit.previous_content_block_count,
            longest_common_content_blocks = audit.longest_common_content_blocks,
            previous_content_blocks_is_strict_prefix = audit.previous_content_blocks_is_strict_prefix,
            matched_prior_boundary_items = audit.matched_prior_boundary_items,
            matched_prior_boundary_sequence = ?audit.matched_prior_boundary_sequence,
            matched_prior_boundary_digest = ?audit.matched_prior_boundary_digest_prefix,
            input_item_fingerprints = %audit.input_item_fingerprints,
            content_block_fingerprints = %audit.content_block_fingerprints,
            event_code = "provider.prompt_cache.wire_audit",
            "Audited Prompt Cache wire-prefix identity without recording model-visible content"
        );
        Some(audit)
    }

    fn log_prompt_cache_wire_outcome(
        &self,
        model: &str,
        audit: &PromptCacheWireAudit,
        usage: &ModelUsage,
    ) {
        tracing::info!(
            model,
            adapter = self.adapter.as_str(),
            cache_cohort = %audit.cohort_prefix,
            request_sequence = audit.sequence,
            request_digest = %audit.request_digest_prefix,
            matched_prior_boundary_items = audit.matched_prior_boundary_items,
            matched_prior_boundary_sequence = ?audit.matched_prior_boundary_sequence,
            longest_common_content_blocks = audit.longest_common_content_blocks,
            previous_content_blocks_is_strict_prefix = audit.previous_content_blocks_is_strict_prefix,
            input_tokens = ?usage.input_tokens,
            uncached_input_tokens = ?usage.uncached_input_tokens,
            cached_input_tokens = ?usage.cached_input_tokens,
            cache_write_input_tokens = ?usage.cache_write_input_tokens,
            event_code = "provider.prompt_cache.wire_outcome",
            "Correlated Prompt Cache wire-prefix evidence with Provider-reported usage"
        );
    }

    fn prompt_cache_wire_mode(&self, model: &str) -> PromptCacheWireMode {
        let strategy = self
            .model_profiles
            .get(model)
            .map(|profile| profile.prompt_cache_strategy)
            .unwrap_or_default();
        if self.protocol_for_model(model) != ModelProtocol::OpenaiResponses {
            return if strategy == PromptCacheStrategy::ExperimentalStructuredDeltas
                && cfg!(feature = "experimental-structured-context-delta-cache")
            {
                PromptCacheWireMode::ImplicitContentBoundaries
            } else {
                PromptCacheWireMode::ImplicitText
            };
        }
        if strategy == PromptCacheStrategy::Disabled {
            return PromptCacheWireMode::ImplicitText;
        }

        if self.adapter == "openai-codex" {
            return match strategy {
                PromptCacheStrategy::ImplicitContentBoundaries
                | PromptCacheStrategy::ExplicitContentBoundaries => {
                    PromptCacheWireMode::ImplicitContentBoundaries
                }
                PromptCacheStrategy::ExperimentalStructuredDeltas
                    if cfg!(feature = "experimental-structured-context-delta-cache") =>
                {
                    PromptCacheWireMode::ImplicitContentBoundaries
                }
                PromptCacheStrategy::ImplicitMessageBoundaries => {
                    PromptCacheWireMode::ImplicitMessageBoundaries
                }
                // The Codex backend rejects public explicit-breakpoint fields.
                // Content/message splitting without those fields did not
                // create a deeper cache boundary in the real multi-step run,
                // and message splitting is not a strict item extension while
                // the canonical Context still has a trailing closing segment.
                // Keep Auto semantically minimal until a wire-audited run
                // proves a stronger endpoint-specific strategy.
                PromptCacheStrategy::Auto
                | PromptCacheStrategy::Disabled
                | PromptCacheStrategy::ImplicitPrefix
                | PromptCacheStrategy::ExperimentalStructuredDeltas => {
                    PromptCacheWireMode::ImplicitText
                }
            };
        }

        match strategy {
            PromptCacheStrategy::ImplicitContentBoundaries => {
                PromptCacheWireMode::ImplicitContentBoundaries
            }
            PromptCacheStrategy::ImplicitMessageBoundaries => {
                PromptCacheWireMode::ImplicitMessageBoundaries
            }
            PromptCacheStrategy::ExperimentalStructuredDeltas
                if cfg!(feature = "experimental-structured-context-delta-cache") =>
            {
                PromptCacheWireMode::ImplicitContentBoundaries
            }
            PromptCacheStrategy::ExplicitContentBoundaries => {
                PromptCacheWireMode::ExplicitContentBoundaries
            }
            PromptCacheStrategy::Auto
            | PromptCacheStrategy::Disabled
            | PromptCacheStrategy::ImplicitPrefix
            | PromptCacheStrategy::ExperimentalStructuredDeltas => {
                PromptCacheWireMode::ImplicitText
            }
        }
    }

    fn request_for_model(
        &self,
        model: &str,
        messages: &[Message],
        tools: &[ToolDefinition],
    ) -> Value {
        self.request_for_model_with_reasoning(model, messages, tools, None)
    }

    fn adapt_request(&self, model: &str, request: Value, tools: &[ToolDefinition]) -> Value {
        let request = if self.protocol_for_model(model) == ModelProtocol::GeminiContent {
            let dialect = if self.adapter == "google-antigravity" {
                gemini_schema::GeminiToolSchemaDialect::Antigravity
            } else {
                gemini_schema::GeminiToolSchemaDialect::PublicApi
            };
            gemini_schema::project_request_tool_schemas(request, dialect)
        } else {
            request
        };
        if self.adapter == "openai-codex" {
            return adapt_codex_request(request);
        }
        if self.adapter == "claude-code" {
            return claude_oauth::adapt_request(model, &self.request_context, tools, request).0;
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
            .request_context
            .get("project_id")
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

    fn authorize(
        &self,
        protocol: ModelProtocol,
        mut request: reqwest::RequestBuilder,
    ) -> reqwest::RequestBuilder {
        request = request.headers(self.headers.clone());
        if let Some(secret) = &self.credential {
            request = match protocol {
                ModelProtocol::OpenaiResponses | ModelProtocol::OpenaiChat => {
                    request.bearer_auth(secret)
                }
                ModelProtocol::AnthropicMessages => request
                    .header("x-api-key", secret)
                    .header("anthropic-version", "2023-06-01"),
                ModelProtocol::GeminiContent => request.header("x-goog-api-key", secret),
            };
        } else if protocol == ModelProtocol::AnthropicMessages {
            request = request.header("anthropic-version", "2023-06-01");
        }
        request
    }

    fn authorize_request(
        &self,
        protocol: ModelProtocol,
        request: reqwest::RequestBuilder,
        body: &Value,
    ) -> reqwest::RequestBuilder {
        let mut request = self.authorize(protocol, request);
        if self.adapter == "claude-code" && protocol == ModelProtocol::AnthropicMessages {
            request = request
                .header("anthropic-beta", claude_oauth::betas(body))
                .header("x-client-request-id", claude_oauth::fresh_request_id());
            if let Some(session_id) = claude_oauth::session_id(body) {
                request = request.header("x-claude-code-session-id", session_id);
            }
        }
        request
    }

    fn finalize_request_body(&self, body: Value) -> Result<Value, ProviderError> {
        if self.adapter == "claude-code" {
            return claude_oauth::finalize_body(body).map_err(Into::into);
        }
        Ok(body)
    }

    fn claude_tool_aliases(
        &self,
        tools: &[ToolDefinition],
    ) -> Option<claude_oauth::ClaudeOAuthToolAliases> {
        (self.adapter == "claude-code").then(|| {
            let device_id = self
                .request_context
                .get("device_id")
                .map(String::as_str)
                .unwrap_or_default();
            claude_oauth::ClaudeOAuthToolAliases::for_tools(tools, device_id)
        })
    }

    async fn send(&self, model: &str, body: &Value) -> Result<Value, ProviderError> {
        let protocol = self.protocol_for_model(model);
        let endpoint = self.endpoint_for(false, model)?;
        let body = self.finalize_request_body(body.clone())?;
        let mut attempt = 0;
        let mut backoff = Duration::from_secs(self.initial_backoff_secs);
        loop {
            attempt += 1;
            let mut retry_after = None;
            let request = self.authorize_request(protocol, self.http.post(&endpoint), &body);
            let send_result =
                match tokio::time::timeout(self.stream_idle_timeout, request.json(&body).send())
                    .await
                {
                    Ok(Ok(response)) => Ok(response),
                    Ok(Err(error)) => Err(request_model_failure(error)),
                    Err(_) => Err(ModelFailure::new(
                        ModelFailureKind::StreamIdleTimeout,
                        format!(
                            "{} Provider exceeded the {}-second idle timeout while waiting for response headers",
                            protocol.as_str(),
                            self.stream_idle_timeout.as_secs()
                        ),
                    )),
                };
            match send_result {
                Ok(response) => {
                    let status = response.status();
                    if status.is_success() {
                        let body = match tokio::time::timeout(
                            self.stream_idle_timeout,
                            response.json(),
                        )
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
                                            "{} Provider response body did not complete within {} seconds",
                                            protocol.as_str(),
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
                            protocol = protocol.as_str(),
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
                        protocol = protocol.as_str(),
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
                protocol = protocol.as_str(),
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
        claude_aliases: Option<&claude_oauth::ClaudeOAuthToolAliases>,
    ) -> Result<Response, ProviderError> {
        let protocol = self.protocol_for_model(model);
        let endpoint = self.endpoint_for(true, model)?;
        let mut streaming_body = body.clone();
        if protocol != ModelProtocol::GeminiContent {
            streaming_body["stream"] = Value::Bool(true);
        }
        if protocol == ModelProtocol::OpenaiChat {
            streaming_body["stream_options"] = json!({"include_usage": true});
        }
        streaming_body = self.finalize_request_body(streaming_body)?;
        let prompt_cache_wire_audit = self.record_prompt_cache_wire_audit(model, &streaming_body);

        // Retrying is safe until a successful response is accepted and stream
        // events begin. Once any event has been consumed we must not replay the
        // request, because that could duplicate model output or tool calls.
        let mut attempt = 0;
        let mut backoff = Duration::from_secs(self.initial_backoff_secs);
        let response = loop {
            attempt += 1;
            let mut retry_after = None;
            let request =
                self.authorize_request(protocol, self.http.post(&endpoint), &streaming_body);
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
                        "{} Provider first byte timeout: waited more than {} seconds for HTTP response headers",
                        protocol.as_str(),
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
                        protocol = protocol.as_str(),
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
                        protocol = protocol.as_str(),
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
                protocol = protocol.as_str(),
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
                                "{} Provider stream stalled: no additional response body bytes arrived for {} seconds",
                                protocol.as_str(),
                                timeout.as_secs()
                            ),
                        )
                    } else {
                        (
                            ModelFailureKind::FirstByteTimeout,
                            format!(
                                "{} Provider first byte timeout: no response body bytes arrived within {} seconds after HTTP response headers",
                                protocol.as_str(),
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
                self.apply_sse_frame(protocol, &frame, &mut accumulator, stream, claude_aliases)?;
            }
        }
        if !pending.is_empty() {
            self.apply_sse_frame(protocol, &pending, &mut accumulator, stream, claude_aliases)?;
        }
        let actual_prompt_tokens = accumulator.prompt_tokens;
        let actual_usage = accumulator.usage.clone();
        let response = accumulator.finish(stream)?;
        if let Some(audit) = prompt_cache_wire_audit.as_ref() {
            self.log_prompt_cache_wire_outcome(model, audit, &actual_usage);
        }
        if let (Some(measurement), Some(actual_prompt_tokens)) = (measurement, actual_prompt_tokens)
        {
            self.observe_completion_usage(protocol, model, body, measurement, actual_prompt_tokens);
        }
        Ok(response)
    }

    fn apply_sse_frame(
        &self,
        protocol: ModelProtocol,
        frame: &[u8],
        accumulator: &mut StreamAccumulator,
        stream: &ModelStreamSender,
        claude_aliases: Option<&claude_oauth::ClaudeOAuthToolAliases>,
    ) -> Result<(), ProviderError> {
        let frame = parse_sse_frame(frame)?;
        if frame.event.as_deref() == Some("error") {
            if protocol == ModelProtocol::OpenaiResponses
                && frame
                    .data
                    .as_deref()
                    .and_then(|data| serde_json::from_str::<Value>(data).ok())
                    .is_some_and(|event| accumulator.accept_reasoning_only_missing_terminal(&event))
            {
                return Ok(());
            }
            return Err(provider_stream_error(
                protocol,
                frame.data.as_deref().unwrap_or("<empty SSE error event>"),
            ));
        }
        let Some(data) = frame.data else {
            return Ok(());
        };
        if data == "[DONE]" {
            if accumulator.terminal {
                return Ok(());
            }
            if protocol == ModelProtocol::OpenaiChat {
                accumulator.terminal = true;
                return Ok(());
            }
            return Err(provider_protocol_failure(
                protocol,
                "received [DONE] before the native protocol terminal event",
            ));
        }
        let mut event: Value = serde_json::from_str(&data).map_err(|error| {
            provider_protocol_failure(protocol, format!("SSE event is not valid JSON: {error}"))
        })?;
        if let Some(aliases) = claude_aliases {
            aliases.restore_event(&mut event);
        }
        accumulator.apply(protocol, self.normalize_response(event), stream)
    }

    fn observe_completion_usage(
        &self,
        protocol: ModelProtocol,
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
        let actual_shape = prompt_calibration_shape(protocol, model, body);
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
            protocol = protocol.as_str(),
            model,
            predicted_prompt_tokens = measurement.tokens,
            actual_prompt_tokens,
            base_estimate_tokens,
            absolute_error = measurement.tokens.abs_diff(actual_prompt_tokens),
            event_code = "provider.prompt_calibration.usage_recorded",
            "Recorded completion usage in the Prompt-token calibrator"
        );
    }

    fn antigravity_catalog_base_urls(&self) -> Vec<String> {
        let configured = self
            .base_url
            .trim_end_matches('/')
            .trim_end_matches("/v1internal")
            .to_string();
        if configured == ANTIGRAVITY_DAILY_BASE_URL || configured == ANTIGRAVITY_PRODUCTION_BASE_URL
        {
            vec![
                ANTIGRAVITY_DAILY_BASE_URL.to_string(),
                ANTIGRAVITY_PRODUCTION_BASE_URL.to_string(),
            ]
        } else {
            vec![configured]
        }
    }

    async fn list_antigravity_model_catalog(
        &self,
    ) -> Result<Vec<DiscoveredProviderModel>, ProviderError> {
        let mut failures = Vec::new();
        for base_url in self.antigravity_catalog_base_urls() {
            let endpoint = format!(
                "{}/v1internal:fetchAvailableModels",
                base_url.trim_end_matches('/')
            );
            let response = match tokio::time::timeout(
                self.stream_idle_timeout,
                self.authorize(
                    self.protocol,
                    self.http.post(&endpoint).json(&serde_json::json!({})),
                )
                .send(),
            )
            .await
            {
                Err(_) => {
                    failures.push(format!(
                        "{endpoint} exceeded {} seconds",
                        self.stream_idle_timeout.as_secs()
                    ));
                    continue;
                }
                Ok(Err(error)) => {
                    failures.push(format!("{endpoint}: {error}"));
                    continue;
                }
                Ok(Ok(response)) => response,
            };
            let status = response.status();
            if !status.is_success() {
                let text = response_body_preview(response.text().await.unwrap_or_default());
                failures.push(format!("{endpoint} returned HTTP {status}: {text}"));
                continue;
            }
            let value = match response.json::<Value>().await {
                Ok(value) => value,
                Err(error) => {
                    failures.push(format!("{endpoint} returned invalid JSON: {error}"));
                    continue;
                }
            };
            match parse_antigravity_model_catalog(&value) {
                Ok(models) => return Ok(models),
                Err(error) => failures.push(format!("{endpoint}: {error}")),
            }
        }
        Err(format!(
            "Antigravity model catalog discovery failed: {}",
            failures.join("; ")
        )
        .into())
    }

    pub(crate) async fn list_model_catalog(
        &self,
    ) -> Result<Vec<DiscoveredProviderModel>, ProviderError> {
        if self.adapter == "google-antigravity" {
            return self.list_antigravity_model_catalog().await;
        }
        let mut endpoint = reqwest::Url::parse(&format!("{}/models", self.base_url))?;
        if self.adapter == "openai-codex" {
            let client_version = codex_client_version();
            endpoint
                .query_pairs_mut()
                .append_pair("client_version", client_version.trim());
        }
        let response = tokio::time::timeout(
            self.stream_idle_timeout,
            self.authorize(self.protocol, self.http.get(endpoint))
                .send(),
        )
        .await
        .map_err(|_| {
            format!(
                "{} model catalog response exceeded {} seconds",
                self.protocol.as_str(),
                self.stream_idle_timeout.as_secs()
            )
        })??;
        let status = response.status();
        if !status.is_success() {
            let text = response_body_preview(response.text().await.unwrap_or_default());
            return Err(format!(
                "{} model catalog returned HTTP {}: {}",
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
            .ok_or_else(|| {
                format!(
                    "{} model catalog is missing the data/models array",
                    self.protocol.as_str()
                )
            })?;
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
        .ok_or_else(|| format!("Provider '{provider_id}' is not defined"))?;
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
        return Err("Provider URL must not be empty".into());
    }
    if api_key.trim().is_empty() {
        return Err("API Key must not be empty".into());
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
        .ok_or_else(|| format!("Provider '{provider_id}' is not defined"))?;
    let (models, catalog_error) = match list_provider_models(app, provider_id).await {
        Ok(models) => (models, None),
        Err(error) => (Vec::new(), Some(error.to_string())),
    };
    let selected_model_available = model.map(|model| models.iter().any(|item| item == model));
    let selected_model = model.unwrap_or(&app.llm.model).trim();
    if selected_model.is_empty() {
        return Err("Provider test requires a model ID".into());
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
        let protocol = self.protocol_for_model(&model);
        format!(
            "model-provider:{}:{}:{}",
            protocol.as_str(),
            self.base_url,
            model
        )
    }

    fn prefers_structured_delta_cache_transport(&self, requested_model: Option<&str>) -> bool {
        if !cfg!(feature = "experimental-structured-context-delta-cache") {
            return false;
        }
        let model = requested_model
            .map(str::trim)
            .filter(|model| !model.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| self.model_snapshot());
        let strategy = self
            .model_profiles
            .get(&model)
            .map(|profile| profile.prompt_cache_strategy)
            .unwrap_or_default();
        strategy == PromptCacheStrategy::ExperimentalStructuredDeltas
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
            return Err("model name must not be empty".to_string());
        }
        *self
            .model
            .write()
            .map_err(|_| "model configuration lock is poisoned".to_string())? = model.to_string();
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
            .map_err(|_| "reasoning effort configuration lock is poisoned".to_string())? = effort;
        Ok(())
    }

    async fn count_prompt_tokens(
        &self,
        scope: &str,
        messages: &[Message],
        tools: &[ToolDefinition],
    ) -> Result<Option<PromptTokenCount>, ProviderError> {
        let model = self.model_snapshot();
        let protocol = self.protocol_for_model(&model);
        let messages =
            self.prepare_prompt_cache_messages(&model, messages.to_vec(), tools, None, false)?;
        let body = self.request_for_model(&model, &messages, tools);
        let base_estimate_tokens = serialized_request_token_estimate(&body);
        let calibration_shape = prompt_calibration_shape(protocol, &model, &body);
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
                        protocol.as_str()
                    ),
                    PromptTokenAccuracy::UsageCalibratedEstimate,
                )
            }
            None => (
                base_estimate_tokens,
                format!("{}-serialized-request-estimate", protocol.as_str()),
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
        let protocol = self.protocol_for_model(&model);
        let messages = self.prepare_prompt_cache_messages(&model, messages, &tools, None, true)?;
        let request = self.request_for_model(&model, &messages, &tools);
        let claude_aliases = self.claude_tool_aliases(&tools);
        if self.adapter == "openai-codex" {
            // ChatGPT's Codex backend only accepts Responses requests in its
            // streaming form. Aggregate that stream here for callers using
            // the non-streaming Client API, matching the official client and
            // CLIProxyAPI compatibility boundary.
            let (stream, _events) = tokio::sync::mpsc::unbounded_channel();
            return self
                .send_stream(&model, &request, None, &stream, None)
                .await;
        }
        let mut response = self.send(&model, &request).await?;
        if let Some(aliases) = claude_aliases.as_ref() {
            aliases.restore_event(&mut response);
        }
        parse_response(protocol, self.normalize_response(response))
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
        let messages = self.prepare_prompt_cache_messages(&model, messages, &tools, None, true)?;
        let request = self.request_for_model(&model, &messages, &tools);
        let claude_aliases = self.claude_tool_aliases(&tools);
        match self
            .send_stream(
                &model,
                &request,
                measurement.as_ref(),
                &stream,
                claude_aliases.as_ref(),
            )
            .await
        {
            Ok(response) => {
                let _ = stream.send(ModelStreamEvent::Completed);
                Ok(response)
            }
            Err(error) => {
                if let Some(reason) = incomplete_reason(&error) {
                    let _ = stream.send(ModelStreamEvent::Incomplete { reason });
                } else {
                    let _ = stream.send(ModelStreamEvent::Failed {
                        message: error.to_string(),
                    });
                }
                Err(error)
            }
        }
    }

    async fn create_completion_bound_stream_with_options(
        &self,
        _binding: &ModelAttemptBinding,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
        measurement: Option<PromptTokenCount>,
        stream: ModelStreamSender,
        options: crate::llm::ModelRequestOptions,
    ) -> Result<Response, ProviderError> {
        let _ = stream.send(ModelStreamEvent::Started);
        let model = self.model_snapshot();
        let messages = self.prepare_prompt_cache_messages(
            &model,
            messages,
            &tools,
            options.reasoning_effort,
            true,
        )?;
        let request = self.request_for_model_with_reasoning(
            &model,
            &messages,
            &tools,
            options.reasoning_effort,
        );
        let claude_aliases = self.claude_tool_aliases(&tools);
        match self
            .send_stream(
                &model,
                &request,
                measurement.as_ref(),
                &stream,
                claude_aliases.as_ref(),
            )
            .await
        {
            Ok(response) => {
                let _ = stream.send(ModelStreamEvent::Completed);
                Ok(response)
            }
            Err(error) => {
                if let Some(reason) = incomplete_reason(&error) {
                    let _ = stream.send(ModelStreamEvent::Incomplete { reason });
                } else {
                    let _ = stream.send(ModelStreamEvent::Failed {
                        message: error.to_string(),
                    });
                }
                Err(error)
            }
        }
    }

    async fn probe_health(&self) -> Result<(), ProviderError> {
        const HEALTH_PROBE_TIMEOUT: Duration = Duration::from_secs(30);
        let model = self.model_snapshot();
        let protocol = self.protocol_for_model(&model);
        let messages = vec![Message {
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
            build_request(protocol, &model, Some(64), None, &messages, &[]),
            &[],
        );
        if self.adapter == "openai-codex" {
            let (stream, _events) = tokio::sync::mpsc::unbounded_channel();
            return tokio::time::timeout(
                HEALTH_PROBE_TIMEOUT,
                self.send_stream(&model, &body, None, &stream, None),
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
        let body = self.finalize_request_body(body)?;
        let response = tokio::time::timeout(
            HEALTH_PROBE_TIMEOUT,
            self.authorize_request(protocol, self.http.post(&endpoint), &body)
                .json(&body)
                .send(),
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
        if !health_response_schema_valid(protocol, &normalized) {
            let _ = parse_response(protocol, normalized)?;
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

// Vision Providers account native image inputs as modal tokens rather than
// tokenizing the transport Base64. This deliberately conservative allowance
// is high enough for large/high-detail images while avoiding the several-
// hundred-thousand-token fiction produced by counting encoded bytes as text.
const HEURISTIC_IMAGE_INPUT_TOKENS: usize = 16_384;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct VisualInputShape {
    media_type: String,
    encoded_chars: usize,
    detail: Option<String>,
}

fn redact_visual_inputs(value: &mut Value, shapes: &mut Vec<VisualInputShape>) {
    let Value::Object(object) = value else {
        if let Value::Array(items) = value {
            for item in items {
                redact_visual_inputs(item, shapes);
            }
        }
        return;
    };

    let block_type = object
        .get("type")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    if matches!(block_type.as_deref(), Some("image_url" | "input_image")) {
        let (url, detail) = if block_type.as_deref() == Some("image_url") {
            let image_url = object.get_mut("image_url").and_then(Value::as_object_mut);
            let detail = image_url
                .as_ref()
                .and_then(|image_url| image_url.get("detail"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            (
                image_url.and_then(|image_url| image_url.get_mut("url")),
                detail,
            )
        } else {
            let detail = object
                .get("detail")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            (object.get_mut("image_url"), detail)
        };
        if let Some(Value::String(url)) = url {
            let (media_type, encoded_chars) = image_data_url_shape(url);
            if encoded_chars > 0 {
                *url = format!("data:{media_type};base64,<runtime-image-payload>");
            }
            shapes.push(VisualInputShape {
                media_type,
                encoded_chars,
                detail,
            });
            return;
        }
    }

    if block_type.as_deref() == Some("image") {
        if let Some(source) = object.get_mut("source").and_then(Value::as_object_mut) {
            let media_type = source
                .get("media_type")
                .and_then(Value::as_str)
                .filter(|media_type| media_type.starts_with("image/"))
                .map(ToOwned::to_owned);
            if let Some(media_type) = media_type {
                let encoded_chars = source
                    .get("data")
                    .and_then(Value::as_str)
                    .map(str::len)
                    .unwrap_or_default();
                if let Some(data) = source.get_mut("data") {
                    *data = Value::String("<runtime-image-payload>".to_string());
                }
                shapes.push(VisualInputShape {
                    media_type,
                    encoded_chars,
                    detail: None,
                });
                return;
            }
        }
    }

    if let Some(inline) = object.get_mut("inlineData").and_then(Value::as_object_mut) {
        let media_type = inline
            .get("mimeType")
            .and_then(Value::as_str)
            .filter(|media_type| media_type.starts_with("image/"))
            .map(ToOwned::to_owned);
        if let Some(media_type) = media_type {
            let encoded_chars = inline
                .get("data")
                .and_then(Value::as_str)
                .map(str::len)
                .unwrap_or_default();
            if let Some(data) = inline.get_mut("data") {
                *data = Value::String("<runtime-image-payload>".to_string());
            }
            shapes.push(VisualInputShape {
                media_type,
                encoded_chars,
                detail: None,
            });
            return;
        }
    }

    for child in object.values_mut() {
        redact_visual_inputs(child, shapes);
    }
}

fn image_data_url_shape(url: &str) -> (String, usize) {
    let Some(rest) = url.strip_prefix("data:") else {
        return ("remote-image".to_string(), 0);
    };
    let Some((media_type, encoded)) = rest.split_once(";base64,") else {
        return ("embedded-image".to_string(), 0);
    };
    if !media_type.starts_with("image/") {
        return ("embedded-image".to_string(), 0);
    }
    (media_type.to_string(), encoded.len())
}

fn request_token_estimate_input(body: &Value) -> (Value, Vec<VisualInputShape>) {
    let mut redacted = body.clone();
    let mut shapes = Vec::new();
    redact_visual_inputs(&mut redacted, &mut shapes);
    (redacted, shapes)
}

fn serialized_request_token_estimate(body: &Value) -> usize {
    let (redacted, visual_inputs) = request_token_estimate_input(body);
    let serialized = serde_json::to_string(&redacted).unwrap_or_default();
    let ascii = serialized.chars().filter(char::is_ascii).count();
    let non_ascii = serialized.chars().count().saturating_sub(ascii);
    (ascii.saturating_add(3) / 4)
        .saturating_add(non_ascii)
        .saturating_add(
            visual_inputs
                .len()
                .saturating_mul(HEURISTIC_IMAGE_INPUT_TOKENS),
        )
}

fn prompt_calibration_shape(protocol: ModelProtocol, model: &str, body: &Value) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    protocol.as_str().hash(&mut hasher);
    model.hash(&mut hasher);
    body.get("tools")
        .unwrap_or(&Value::Null)
        .to_string()
        .hash(&mut hasher);
    let (_, visual_inputs) = request_token_estimate_input(body);
    visual_inputs.hash(&mut hasher);
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

fn openai_responses_has_explicit_refusal(response: &Value) -> bool {
    response.get("stop_reason").and_then(Value::as_str) == Some("refusal")
        || response
            .pointer("/status_details/reason")
            .and_then(Value::as_str)
            == Some("refusal")
        || response
            .get("output")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .flat_map(|item| {
                item.get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
            })
            .any(|part| part.get("type").and_then(Value::as_str) == Some("refusal"))
}

#[derive(Debug, Default)]
struct StreamAccumulator {
    content: String,
    tools: BTreeMap<usize, StreamingToolCall>,
    chat_reasoning_content: String,
    responses_reasoning_items: BTreeMap<usize, Value>,
    responses_message_items: BTreeMap<usize, Value>,
    gemini_function_calls: BTreeMap<usize, GeminiFunctionCallContinuation>,
    gemini_tool_index: usize,
    terminal: bool,
    responses_completed: bool,
    responses_incomplete_reason: Option<String>,
    responses_completed_output_tokens: Option<u64>,
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

    fn apply_openai_responses_output_item(
        &mut self,
        index: usize,
        item: &Value,
        authoritative: bool,
        stream: &ModelStreamSender,
    ) {
        match item.get("type").and_then(Value::as_str) {
            Some("reasoning") => {
                self.responses_reasoning_items.insert(index, item.clone());
            }
            Some("message") => {
                // Responses-compatible gateways may omit text deltas and only
                // expose the complete assistant message in output_item.done or
                // response.completed. Retain the authoritative item so finish
                // can recover that text without duplicating streamed deltas.
                self.responses_message_items.insert(index, item.clone());
            }
            Some("function_call") => {
                self.tool(
                    index,
                    item.get("call_id")
                        .or_else(|| item.get("id"))
                        .and_then(Value::as_str),
                    item.get("name").and_then(Value::as_str),
                    stream,
                );
                if authoritative
                    && self
                        .tools
                        .get(&index)
                        .is_some_and(|tool| tool.arguments.is_empty())
                {
                    if let Some(arguments) = item.get("arguments").and_then(Value::as_str) {
                        self.arguments(index, arguments, stream);
                    }
                }
                if authoritative {
                    self.complete_tool(index, stream);
                }
            }
            _ => {}
        }
    }

    fn backfill_openai_responses_message_text(&mut self, stream: &ModelStreamSender) {
        if !self.content.is_empty() {
            return;
        }
        let content = self
            .responses_message_items
            .values()
            .flat_map(|item| {
                item.get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
            })
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<String>();
        self.text(&content, stream);
    }

    /// Some Responses compatibility gateways forward every authoritative
    /// `response.output_item.done` item and then synthesize an error because
    /// the upstream connection ended before `response.completed`. When the
    /// completed output is reasoning-only, it is safe and strictly more
    /// accurate to expose that opaque item as continuation state. Treating the
    /// gateway's missing envelope as a Provider outage discards the progress
    /// and makes provider recovery evaluate the same root turn from scratch.
    ///
    /// FIXME(cliproxyapi): delete this exact error-envelope compatibility path
    /// after the proxy guarantees a native terminal following every forwarded
    /// `response.output_item.done`; retain the regression fixture until that
    /// behavior is verified against the upgraded proxy.
    fn accept_reasoning_only_missing_terminal(&mut self, event: &Value) -> bool {
        let code = event
            .get("code")
            .or_else(|| event.pointer("/error/code"))
            .and_then(Value::as_str);
        let message = event
            .get("message")
            .or_else(|| event.pointer("/error/message"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        let missing_terminal_after_done = code == Some("internal_server_error")
            && message.contains("upstream stream closed before a terminal event")
            && message.contains("last event: response.output_item.done");
        if missing_terminal_after_done
            && self.content.trim().is_empty()
            && self.tools.is_empty()
            && !self.responses_reasoning_items.is_empty()
        {
            self.terminal = true;
            return true;
        }
        false
    }

    fn apply_openai_responses_usage(&mut self, usage: &Value, stream: &ModelStreamSender) {
        let input_tokens = usage.get("input_tokens").and_then(Value::as_u64);
        let cached_input_tokens = usage
            .pointer("/input_tokens_details/cached_tokens")
            .and_then(Value::as_u64);
        let cache_write_input_tokens = usage
            .pointer("/input_tokens_details/cache_write_tokens")
            .and_then(Value::as_u64);
        self.usage(
            ModelUsage {
                input_tokens,
                uncached_input_tokens: subtract_optional(
                    subtract_optional(input_tokens, cached_input_tokens),
                    cache_write_input_tokens,
                ),
                cached_input_tokens,
                cache_write_input_tokens,
                output_tokens: usage.get("output_tokens").and_then(Value::as_u64),
                reasoning_tokens: usage
                    .pointer("/output_tokens_details/reasoning_tokens")
                    .and_then(Value::as_u64),
                total_tokens: usage.get("total_tokens").and_then(Value::as_u64),
                raw: vec![usage.clone()],
            },
            stream,
        );
    }

    /// Absorb a standards-compliant Responses `incomplete` terminal without
    /// pretending it is either `completed` or `failed`.
    ///
    /// The terminal output and usage are still authoritative progress. Output
    /// items are deliberately not finalized as executable tool calls: an
    /// incomplete response may contain an in-progress function item, and only
    /// a later complete response may authorize its execution.
    fn apply_openai_responses_incomplete(
        &mut self,
        event: &Value,
        stream: &ModelStreamSender,
    ) -> Result<(), ProviderError> {
        let response = event.get("response").unwrap_or(&Value::Null);
        if let Some(status) = response
            .get("status")
            .and_then(Value::as_str)
            .filter(|status| *status != "incomplete")
        {
            return Err(provider_protocol_failure(
                ModelProtocol::OpenaiResponses,
                format!("response.incomplete carried status '{status}'"),
            ));
        }
        if let Some(error) = response.get("error").filter(|error| !error.is_null()) {
            return Err(provider_stream_error(
                ModelProtocol::OpenaiResponses,
                &error.to_string(),
            ));
        }

        let reason = response
            .pointer("/incomplete_details/reason")
            .and_then(Value::as_str)
            .unwrap_or("unspecified")
            .to_string();
        for (index, item) in response
            .get("output")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            self.apply_openai_responses_output_item(index, item, false, stream);
        }
        self.backfill_openai_responses_message_text(stream);
        if let Some(usage) = response.get("usage") {
            self.apply_openai_responses_usage(usage, stream);
        }
        self.responses_incomplete_reason = Some(reason);
        self.terminal = true;
        Ok(())
    }

    fn openai_responses_terminal_failure(&self, kind: &str, event: &Value) -> ProviderError {
        let response = event.get("response").unwrap_or(&Value::Null);
        if let Some(error) = response.get("error").filter(|error| !error.is_null()) {
            return provider_stream_error(ModelProtocol::OpenaiResponses, &error.to_string());
        }
        if kind == "error" {
            let error = event.get("error").unwrap_or(event);
            return provider_stream_error(ModelProtocol::OpenaiResponses, &error.to_string());
        }
        provider_protocol_failure(
            ModelProtocol::OpenaiResponses,
            format!("{kind} terminal without a Provider error object"),
        )
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
                "length" => {
                    return Err(
                        "OpenAI Chat stream was truncated by the output length limit".into(),
                    )
                }
                "content_filter" => {
                    return Err(provider_safety_refusal(
                        ModelProtocol::OpenaiChat,
                        "finish_reason=content_filter",
                    ));
                }
                _ => return Err(format!("OpenAI Chat stream did not complete: {reason}").into()),
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
                self.apply_openai_responses_output_item(index, item, false, stream);
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
                // The done item is authoritative and can add complete text,
                // tool arguments, or opaque reasoning fields absent from the
                // corresponding added event.
                self.apply_openai_responses_output_item(index, item, true, stream);
            }
            "response.completed" => {
                let response = event.get("response").unwrap_or(&Value::Null);
                if openai_responses_has_explicit_refusal(response) {
                    return Err(provider_safety_refusal(
                        ModelProtocol::OpenaiResponses,
                        "response.completed carried an explicit refusal terminal",
                    ));
                }
                if let Some(status) = response
                    .get("status")
                    .and_then(Value::as_str)
                    .filter(|status| *status != "completed")
                {
                    if let Some(error) = response.get("error").filter(|value| !value.is_null()) {
                        return Err(provider_stream_error(
                            ModelProtocol::OpenaiResponses,
                            &error.to_string(),
                        ));
                    }
                    return Err(provider_protocol_failure(
                        ModelProtocol::OpenaiResponses,
                        format!("response.completed carried non-completed status '{status}'"),
                    ));
                }
                if let Some(error) = response.get("error").filter(|value| !value.is_null()) {
                    return Err(provider_stream_error(
                        ModelProtocol::OpenaiResponses,
                        &error.to_string(),
                    ));
                }
                if let Some(details) = response
                    .get("incomplete_details")
                    .filter(|value| !value.is_null())
                {
                    return Err(provider_protocol_failure(
                        ModelProtocol::OpenaiResponses,
                        format!("response.completed carried incomplete_details: {details}"),
                    ));
                }
                self.responses_completed = true;
                self.terminal = true;
                for (index, item) in event
                    .pointer("/response/output")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .enumerate()
                {
                    self.apply_openai_responses_output_item(index, item, true, stream);
                }
                self.backfill_openai_responses_message_text(stream);
                if let Some(usage) = event.pointer("/response/usage") {
                    self.responses_completed_output_tokens =
                        usage.get("output_tokens").and_then(Value::as_u64);
                    self.apply_openai_responses_usage(usage, stream);
                }
            }
            "response.incomplete" => {
                self.apply_openai_responses_incomplete(&event, stream)?;
            }
            "error" if self.accept_reasoning_only_missing_terminal(&event) => {}
            "response.failed" | "error" => {
                return Err(self.openai_responses_terminal_failure(kind, &event));
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
                match event.pointer("/delta/stop_reason").and_then(Value::as_str) {
                    Some("max_tokens") => {
                        return Err("Anthropic stream was truncated by max_tokens".into());
                    }
                    Some("refusal") => {
                        return Err(provider_safety_refusal(
                            ModelProtocol::AnthropicMessages,
                            "message_delta.stop_reason=refusal",
                        ));
                    }
                    _ => {}
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
            "error" => return Err(format!("Anthropic stream failed: {event}").into()),
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
            return Err(format!("Gemini stream did not complete: {reason}").into());
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
                self.gemini_function_calls.insert(
                    index,
                    GeminiFunctionCallContinuation {
                        tool_call_id: id.clone(),
                        function_call: call.clone(),
                        thought_signature: part
                            .get("thoughtSignature")
                            .or_else(|| part.get("thought_signature"))
                            .and_then(Value::as_str)
                            .filter(|signature| !signature.is_empty())
                            .map(str::to_string),
                    },
                );
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
            return Err("Provider stream disconnected before the protocol terminal event".into());
        }
        if let Some(reason) = self.responses_incomplete_reason.take() {
            if !self.responses_reasoning_items.is_empty() {
                let _ = stream.send(ModelStreamEvent::ProviderContinuation {
                    continuation: ProviderContinuation::OpenaiResponses {
                        reasoning_items: self.responses_reasoning_items.values().cloned().collect(),
                    },
                });
            }
            return Err(provider_incomplete_response(
                ModelProtocol::OpenaiResponses,
                &reason,
            ));
        }
        if self.responses_completed
            && self.responses_completed_output_tokens == Some(0)
            && self.content.trim().is_empty()
            && self.tools.is_empty()
            && self.responses_reasoning_items.is_empty()
        {
            return Err(provider_empty_response(
                ModelProtocol::OpenaiResponses,
                "response.completed reported output_tokens=0 without text, tool calls, or resumable reasoning state",
            ));
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
        } else if self
            .gemini_function_calls
            .values()
            .any(|call| call.thought_signature.is_some())
        {
            Some(ProviderContinuation::GeminiContent {
                function_calls: self.gemini_function_calls.into_values().collect(),
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

#[cfg(test)]
fn sse_data(frame: &[u8]) -> Result<Option<String>, ProviderError> {
    Ok(parse_sse_frame(frame)?.data)
}

#[derive(Debug, PartialEq, Eq)]
struct ParsedSseFrame {
    event: Option<String>,
    data: Option<String>,
}

fn parse_sse_frame(frame: &[u8]) -> Result<ParsedSseFrame, ProviderError> {
    let text = std::str::from_utf8(frame)?;
    let mut event = None;
    let mut data = Vec::new();
    for line in text.lines().map(|line| line.trim_end_matches('\r')) {
        if let Some(value) = line.strip_prefix("event:") {
            let value = value.strip_prefix(' ').unwrap_or(value).trim();
            if !value.is_empty() {
                event = Some(value.to_string());
            }
        } else if let Some(value) = line.strip_prefix("data:") {
            data.push(value.strip_prefix(' ').unwrap_or(value));
        }
    }
    Ok(ParsedSseFrame {
        event,
        data: (!data.is_empty()).then(|| data.join("\n")),
    })
}

fn build_request(
    protocol: ModelProtocol,
    model: &str,
    max_output_tokens: Option<u32>,
    reasoning_effort: Option<ReasoningEffort>,
    messages: &[Message],
    tools: &[ToolDefinition],
) -> Value {
    build_request_with_prompt_cache(
        protocol,
        model,
        max_output_tokens,
        reasoning_effort,
        messages,
        tools,
        PromptCacheWireMode::ImplicitText,
    )
}

fn build_request_with_prompt_cache(
    protocol: ModelProtocol,
    model: &str,
    max_output_tokens: Option<u32>,
    reasoning_effort: Option<ReasoningEffort>,
    messages: &[Message],
    tools: &[ToolDefinition],
    prompt_cache_wire_mode: PromptCacheWireMode,
) -> Value {
    match protocol {
        ModelProtocol::OpenaiChat => build_openai_chat_request(
            model,
            max_output_tokens,
            reasoning_effort,
            messages,
            tools,
            prompt_cache_wire_mode,
        ),
        ModelProtocol::OpenaiResponses => build_openai_responses_request(
            model,
            max_output_tokens,
            reasoning_effort,
            messages,
            tools,
            prompt_cache_wire_mode,
        ),
        ModelProtocol::AnthropicMessages => build_anthropic_request(
            model,
            max_output_tokens,
            reasoning_effort,
            messages,
            tools,
            prompt_cache_wire_mode,
        ),
        ModelProtocol::GeminiContent => build_gemini_request(
            max_output_tokens,
            reasoning_effort,
            messages,
            tools,
            prompt_cache_wire_mode,
        ),
    }
}

/// OpenAI-compatible protocols require every result for one assistant tool-call
/// batch before the conversation may continue with a user message. Morphz keeps
/// image payloads in transport-only user messages immediately after the tool
/// result that produced them, so a parallel batch can otherwise become:
///
/// assistant(A, B), tool(A), image(A), tool(B), image(B)
///
/// Strict Chat-compatible gateways reject that transcript because image(A)
/// begins a new user turn while B is still unanswered. Preserve the relative
/// order of both result sets, but place every result before the batch's image
/// messages. The transformation is idempotent and deliberately validates the
/// complete batch rather than hiding a genuinely missing or duplicated result.
fn normalize_openai_tool_result_batches(
    messages: Vec<Message>,
) -> Result<Vec<Message>, ProviderError> {
    let message_count = messages.len();
    let mut pending = VecDeque::from(messages);
    let mut normalized = Vec::with_capacity(message_count);

    while let Some(message) = pending.pop_front() {
        let expected_ids = if message.role == "assistant" {
            message
                .tool_calls
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|call| call.id.clone())
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        normalized.push(message);
        if expected_ids.is_empty() {
            continue;
        }

        let expected = expected_ids.iter().cloned().collect::<HashSet<_>>();
        if expected.len() != expected_ids.len() || expected.contains("") {
            return Err(format!(
                "Runtime cannot assemble an OpenAI tool continuation: assistant tool-call IDs must be non-empty and unique ({expected_ids:?})"
            )
            .into());
        }

        let mut seen = HashSet::with_capacity(expected.len());
        let mut results = Vec::with_capacity(expected.len());
        let mut attachments = Vec::new();
        while let Some(next) = pending.front() {
            if next.role == "tool" {
                let result_id = next
                    .tool_call_id
                    .as_deref()
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| {
                        "Runtime cannot assemble an OpenAI tool continuation: a tool result has no tool_call_id"
                            .to_string()
                    })?;
                if !expected.contains(result_id) {
                    return Err(format!(
                        "Runtime cannot assemble an OpenAI tool continuation: result '{result_id}' does not belong to assistant batch {expected_ids:?}"
                    )
                    .into());
                }
                if !seen.insert(result_id.to_string()) {
                    return Err(format!(
                        "Runtime cannot assemble an OpenAI tool continuation: result '{result_id}' is duplicated"
                    )
                    .into());
                }
                results.push(pending.pop_front().expect("front was inspected"));
                continue;
            }
            if next.name.as_deref() == Some(MODEL_ATTACHMENT_MESSAGE_NAME) && !results.is_empty() {
                attachments.push(pending.pop_front().expect("front was inspected"));
                continue;
            }
            break;
        }

        if seen != expected {
            let missing = expected_ids
                .iter()
                .filter(|id| !seen.contains(id.as_str()))
                .cloned()
                .collect::<Vec<_>>();
            return Err(format!(
                "Runtime cannot assemble an OpenAI tool continuation: missing results for {missing:?}"
            )
            .into());
        }
        normalized.extend(results);
        normalized.extend(attachments);
    }

    Ok(normalized)
}

fn build_openai_chat_request(
    model: &str,
    max_output_tokens: Option<u32>,
    reasoning_effort: Option<ReasoningEffort>,
    messages: &[Message],
    tools: &[ToolDefinition],
    prompt_cache_wire_mode: PromptCacheWireMode,
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
        if let Some(segmented) = segmented_model_text(message) {
            let content = if prompt_cache_wire_mode.emits_content_blocks() {
                Value::Array(
                    segmented
                        .parts
                        .into_iter()
                        .filter(|part| !part.text.is_empty())
                        .map(|part| json!({"type": "text", "text": part.text}))
                        .collect(),
                )
            } else {
                Value::String(segmented.parts.into_iter().map(|part| part.text).collect())
            };
            converted.push(json!({"role": message.role, "content": content}));
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
    prompt_cache_wire_mode: PromptCacheWireMode,
) -> Value {
    let mut input = Vec::new();
    let mut prompt_cache_key = None;
    let mut has_explicit_breakpoint = false;
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
        if let Some(segmented) = segmented_model_text(message) {
            prompt_cache_key = segmented.prompt_cache_key.clone();
            if prompt_cache_wire_mode == PromptCacheWireMode::ImplicitMessageBoundaries {
                // Do not reuse the explicit-breakpoint planner here. Its
                // moving four-boundary window would regroup old text as the
                // Inbox grows, invalidating an otherwise identical prefix.
                input.extend(
                    segmented
                        .parts
                        .into_iter()
                        .filter(|part| !part.text.is_empty())
                        .map(|part| {
                            json!({
                                "role": message.role,
                                "content": part.text,
                            })
                        }),
                );
            } else if prompt_cache_wire_mode == PromptCacheWireMode::ImplicitContentBoundaries {
                // The implicit endpoint has no four-breakpoint limit. Keep
                // every structural block stable so extending the Inbox only
                // inserts a new block after the previously cached prefix.
                let content = segmented
                    .parts
                    .into_iter()
                    .filter(|part| !part.text.is_empty())
                    .map(|part| {
                        json!({
                            "type": "input_text",
                            "text": part.text,
                        })
                    })
                    .collect::<Vec<_>>();
                input.push(json!({"role": message.role, "content": content}));
            } else {
                let selected_parts = coalesce_selected_cache_parts(&segmented.parts);
                if prompt_cache_wire_mode.emits_content_blocks() {
                    let content = selected_parts
                        .into_iter()
                        .map(|part| {
                            let mut block = json!({
                                "type": "input_text",
                                "text": part.text,
                            });
                            if part.cache_boundary_after
                                && prompt_cache_wire_mode.emits_explicit_breakpoints()
                            {
                                block["prompt_cache_breakpoint"] = json!({"mode": "explicit"});
                                has_explicit_breakpoint = true;
                            }
                            block
                        })
                        .collect::<Vec<_>>();
                    input.push(json!({"role": message.role, "content": content}));
                } else {
                    input.push(json!({
                        "role": message.role,
                        "content": segmented.visible_text(),
                    }));
                }
            }
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
    if has_explicit_breakpoint {
        request["prompt_cache_options"] = json!({"mode": "explicit", "ttl": "30m"});
    }
    if let Some(prompt_cache_key) = prompt_cache_key {
        request["prompt_cache_key"] = json!(prompt_cache_key);
    }
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
    // the ChatGPT Codex backend. The separately tested CLIProxyAPI v7.2.140
    // revision applies the same compatibility boundary before forwarding;
    // do not generalize that observation to unknown gateway revisions.
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
        "prompt_cache_options",
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
            if let Some(content) = item.get_mut("content").and_then(Value::as_array_mut) {
                for block in content {
                    if let Some(block) = block.as_object_mut() {
                        block.remove("prompt_cache_breakpoint");
                    }
                }
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
    prompt_cache_wire_mode: PromptCacheWireMode,
) -> Value {
    let system = messages
        .iter()
        .filter(|message| message.role == "system" && model_attachments(message).is_none())
        .map(model_visible_message_text)
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut converted: Vec<Value> = Vec::new();
    let mut messages = messages
        .iter()
        .filter(|message| message.role != "system")
        .peekable();
    while let Some(message) = messages.next() {
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
        if let Some(segmented) = segmented_model_text(message) {
            let content = if prompt_cache_wire_mode.emits_content_blocks() {
                segmented
                    .parts
                    .into_iter()
                    .filter(|part| !part.text.is_empty())
                    .map(|part| json!({"type": "text", "text": part.text}))
                    .collect::<Vec<_>>()
            } else {
                let text = segmented
                    .parts
                    .into_iter()
                    .map(|part| part.text)
                    .collect::<String>();
                if text.is_empty() {
                    Vec::new()
                } else {
                    vec![json!({"type": "text", "text": text})]
                }
            };
            if !content.is_empty() {
                converted.push(json!({"role": "user", "content": content}));
            }
            continue;
        }
        let (role, mut content) = if message.role == "tool" {
            let mut attachment_content = Vec::new();
            while let Some(attachments) = messages
                .peek()
                .and_then(|message| model_attachments(message))
            {
                attachment_content.extend(attachments.iter().map(anthropic_attachment_block));
                messages.next();
            }
            let result = if attachment_content.is_empty() {
                json!({
                    "type": "tool_result",
                    "tool_use_id": message.tool_call_id,
                    "content": message.content,
                })
            } else {
                let mut result_content = Vec::with_capacity(attachment_content.len() + 1);
                if !message.content.is_empty() {
                    result_content.push(json!({"type": "text", "text": message.content}));
                }
                result_content.append(&mut attachment_content);
                json!({
                    "type": "tool_result",
                    "tool_use_id": message.tool_call_id,
                    "content": result_content,
                })
            };
            ("user", vec![result])
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
    prompt_cache_wire_mode: PromptCacheWireMode,
) -> Value {
    let system = messages
        .iter()
        .filter(|message| {
            message.role == "system"
                && model_attachments(message).is_none()
                && provider_continuation(message).is_none()
        })
        .map(model_visible_message_text)
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut contents: Vec<Value> = Vec::new();
    let mut pending_continuation = None;
    let mut idless_tool_call_ids = HashSet::new();
    for message in messages {
        if let Some(continuation) = provider_continuation(message) {
            pending_continuation = match continuation {
                ProviderContinuation::GeminiContent { function_calls } => Some(function_calls),
                _ => None,
            };
            continue;
        }
        if message.role == "system" {
            continue;
        }
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
        if let Some(segmented) = segmented_model_text(message) {
            let parts = if prompt_cache_wire_mode.emits_content_blocks() {
                segmented
                    .parts
                    .into_iter()
                    .filter(|part| !part.text.is_empty())
                    .map(|part| json!({"text": part.text}))
                    .collect::<Vec<_>>()
            } else {
                let text = segmented
                    .parts
                    .into_iter()
                    .map(|part| part.text)
                    .collect::<String>();
                if text.is_empty() {
                    Vec::new()
                } else {
                    vec![json!({"text": text})]
                }
            };
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
                if !idless_tool_call_ids.remove(id) {
                    function_response["id"] = json!(id);
                }
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
            if message.role == "assistant" {
                idless_tool_call_ids.clear();
            }
            let mut continuation_calls = pending_continuation.take().unwrap_or_default();
            for call in message.tool_calls.as_deref().unwrap_or_default() {
                let args = serde_json::from_str::<Value>(&call.function.arguments)
                    .unwrap_or_else(|_| json!({"raw": call.function.arguments}));
                let signed_call_index = continuation_calls.iter().position(|candidate| {
                    candidate.tool_call_id == call.id
                        && candidate.function_call.get("name").and_then(Value::as_str)
                            == Some(call.function.name.as_str())
                        && candidate
                            .function_call
                            .get("args")
                            .map_or(args == json!({}), |candidate_args| candidate_args == &args)
                });
                if let Some(index) = signed_call_index {
                    let signed_call = continuation_calls.remove(index);
                    if signed_call
                        .function_call
                        .get("id")
                        .and_then(Value::as_str)
                        .is_none()
                    {
                        idless_tool_call_ids.insert(call.id.clone());
                    }
                    let mut part = json!({"functionCall": signed_call.function_call});
                    if let Some(signature) = signed_call.thought_signature {
                        part["thoughtSignature"] = json!(signature);
                    }
                    parts.push(part);
                } else {
                    let mut function_call = json!({"name": call.function.name, "args": args});
                    if !call.id.is_empty() {
                        function_call["id"] = json!(call.id);
                    }
                    parts.push(json!({"functionCall": function_call}));
                }
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
                // Keep the canonical Runtime schema intact until the physical
                // Provider adapter projects it into its supported dialect.
                "parametersJsonSchema": tool.parameters,
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
            "model response contains neither non-empty content nor tool calls",
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
        .ok_or("OpenAI Chat response is missing choices[0]")?;
    if choice.get("finish_reason").and_then(Value::as_str) == Some("length") {
        return Err("OpenAI Chat response was truncated by the output-length limit".into());
    }
    if choice.get("finish_reason").and_then(Value::as_str) == Some("content_filter") {
        return Err(provider_safety_refusal(
            ModelProtocol::OpenaiChat,
            "finish_reason=content_filter",
        ));
    }
    let message = choice
        .get("message")
        .ok_or("OpenAI Chat response is missing message")?;
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
    if openai_responses_has_explicit_refusal(&value) {
        return Err(provider_safety_refusal(
            ModelProtocol::OpenaiResponses,
            "completed response carried an explicit refusal terminal",
        ));
    }
    let status = value.get("status").and_then(Value::as_str);
    if status == Some("incomplete") {
        if let Some(error) = value.get("error").filter(|error| !error.is_null()) {
            return Err(provider_stream_error(
                ModelProtocol::OpenaiResponses,
                &error.to_string(),
            ));
        }
        let reason = value
            .pointer("/incomplete_details/reason")
            .and_then(Value::as_str)
            .unwrap_or("unspecified");
        return Err(provider_incomplete_response(
            ModelProtocol::OpenaiResponses,
            reason,
        ));
    }
    if let Some(error) = value.get("error").filter(|value| !value.is_null()) {
        return Err(provider_stream_error(
            ModelProtocol::OpenaiResponses,
            &error.to_string(),
        ));
    }
    if let Some(status) = status.filter(|status| *status != "completed") {
        return Err(provider_protocol_failure(
            ModelProtocol::OpenaiResponses,
            format!("non-streaming response has non-completed status '{status}'"),
        ));
    }
    if let Some(details) = value
        .get("incomplete_details")
        .filter(|value| !value.is_null())
    {
        return Err(provider_protocol_failure(
            ModelProtocol::OpenaiResponses,
            format!("completed response contains incomplete_details: {details}"),
        ));
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
    let response = Response {
        content: content.join(""),
        tool_calls,
    };
    if value
        .pointer("/usage/output_tokens")
        .and_then(Value::as_u64)
        == Some(0)
        && response.content.trim().is_empty()
        && response.tool_calls.is_empty()
    {
        return Err(provider_empty_response(
            ModelProtocol::OpenaiResponses,
            "completed non-streaming response reports output_tokens=0 and contains neither content nor tool calls",
        ));
    }
    ensure_nonempty(response)
}

fn parse_anthropic_response(value: Value) -> Result<Response, ProviderError> {
    match value.get("stop_reason").and_then(Value::as_str) {
        Some("max_tokens") => {
            return Err("Anthropic response was truncated by max_tokens".into());
        }
        Some("refusal") => {
            return Err(provider_safety_refusal(
                ModelProtocol::AnthropicMessages,
                "stop_reason=refusal",
            ));
        }
        _ => {}
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
        .ok_or("Gemini response is missing candidates[0]")?;
    let finish_reason = candidate.get("finishReason").and_then(Value::as_str);
    if let Some(reason) = gemini_finish_failure(finish_reason) {
        return Err(format!("Gemini response did not complete: {reason}").into());
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
    use crate::llm::{
        attachment_message, segmented_text_message, FunctionCall, ModelTextPart,
        SegmentedModelText, ToolCall,
    };
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

    #[test]
    fn billing_cycle_quota_on_http_403_is_not_authentication() {
        let failure = http_model_failure(
            reqwest::StatusCode::FORBIDDEN,
            serde_json::json!({
                "error": {
                    "type": "permission_error",
                    "message": "You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle."
                },
                "type": "error"
            })
            .to_string(),
            None,
        );

        assert_eq!(failure.kind, ModelFailureKind::QuotaExhausted);
        assert_eq!(failure.http_status, Some(403));
    }

    #[test]
    fn generic_http_403_permission_error_does_not_poison_auth_account() {
        let failure = http_model_failure(
            reqwest::StatusCode::FORBIDDEN,
            serde_json::json!({
                "error": {
                    "type": "permission_error",
                    "message": "This model is not enabled for the current project."
                }
            })
            .to_string(),
            None,
        );

        assert_eq!(failure.kind, ModelFailureKind::InvalidModelOrRequest);
        assert_eq!(failure.http_status, Some(403));
    }

    #[test]
    fn cyber_policy_http_error_is_a_permanent_safety_refusal() {
        let failure = http_model_failure(
            reqwest::StatusCode::BAD_REQUEST,
            serde_json::json!({
                "error": {
                    "code": "cyber_policy",
                    "message": "Request rejected by the provider safety policy."
                }
            })
            .to_string(),
            None,
        );

        assert_eq!(failure.kind, ModelFailureKind::SafetyRefusal);
        assert_eq!(failure.http_status, Some(400));
        assert_eq!(failure.provider_code.as_deref(), Some("cyber_policy"));
        assert!(!failure.kind.uses_provider_recovery());
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
    fn claude_physical_models_use_native_anthropic_messages_on_compatibility_providers() {
        let client = ProtocolClient::new(
            &ProviderConfig {
                protocol: ModelProtocol::OpenaiResponses,
                base_url: "https://provider.invalid/v1".to_string(),
                ..ProviderConfig::default()
            },
            "Claude-Opus-5".to_string(),
            Some("secret".to_string()),
            &LlmConfig::default(),
        )
        .unwrap();

        assert_eq!(
            client.protocol_for_model("Claude-Opus-5"),
            ModelProtocol::AnthropicMessages
        );
        assert_eq!(
            client.endpoint_for(true, "Claude-Opus-5").unwrap(),
            "https://provider.invalid/v1/messages"
        );
        let request = client.request_for_model("Claude-Opus-5", &messages(), &[]);
        assert_eq!(request["model"], "Claude-Opus-5");
        assert_eq!(request["system"], "system");
        assert!(request["messages"].is_array());
        assert!(request.get("input").is_none());

        let authorized = client
            .authorize(
                ModelProtocol::AnthropicMessages,
                client.http.post("https://provider.invalid/v1/messages"),
            )
            .build()
            .unwrap();
        assert_eq!(authorized.headers()["x-api-key"], "secret");
        assert_eq!(authorized.headers()["anthropic-version"], "2023-06-01");
        assert!(authorized.headers().get("authorization").is_none());

        assert_eq!(
            client.protocol_for_model("Qwen3.8-27B-FP8"),
            ModelProtocol::OpenaiResponses
        );
    }

    #[test]
    fn antigravity_uses_internal_endpoints_and_request_envelope() {
        let client = ProtocolClient::new_with_adapter_and_context(
            &ProviderConfig {
                protocol: ModelProtocol::GeminiContent,
                base_url: "https://cloudcode-pa.googleapis.com".to_string(),
                ..ProviderConfig::default()
            },
            "google-antigravity",
            "gemini-test".to_string(),
            None,
            &LlmConfig::default(),
            BTreeMap::from([("project_id".to_string(), "project-123".to_string())]),
        )
        .unwrap();

        assert_eq!(
            client.endpoint_for(false, "gemini-test").unwrap(),
            "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent"
        );
        assert_eq!(
            client.endpoint_for(true, "gemini-test").unwrap(),
            "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
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
        assert!(client.headers[USER_AGENT]
            .to_str()
            .unwrap()
            .starts_with("antigravity/hub/"));
    }

    fn discriminated_schedule_tool() -> ToolDefinition {
        ToolDefinition {
            name: "schedule_tx".to_string(),
            description: "Inspect or pause a schedule".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "operations": {
                        "type": "array",
                        "minItems": 1,
                        "items": {
                            "oneOf": [
                                {
                                    "type": "object",
                                    "properties": {
                                        "op": {"const": "inspect"},
                                        "schedule_id": {"type": "string"}
                                    },
                                    "required": ["op", "schedule_id"],
                                    "additionalProperties": false
                                },
                                {
                                    "type": "object",
                                    "properties": {
                                        "op": {"const": "pause"},
                                        "schedule_id": {"type": "string"},
                                        "expected_revision": {"type": "integer", "minimum": 1}
                                    },
                                    "required": ["op", "schedule_id", "expected_revision"],
                                    "additionalProperties": false
                                }
                            ]
                        }
                    }
                },
                "required": ["operations"],
                "additionalProperties": false
            }),
        }
    }

    fn contains_keyword(value: &Value, keyword: &str, in_properties: bool) -> bool {
        match value {
            Value::Array(values) => values
                .iter()
                .any(|value| contains_keyword(value, keyword, false)),
            Value::Object(object) => object.iter().any(|(key, value)| {
                (!in_properties && key == keyword)
                    || contains_keyword(value, keyword, key == "properties")
            }),
            _ => false,
        }
    }

    #[test]
    fn gemini_and_antigravity_compile_runtime_tool_schemas_for_their_wire_dialects() {
        let tool = discriminated_schedule_tool();
        let canonical_request = build_gemini_request(
            None,
            None,
            &messages(),
            std::slice::from_ref(&tool),
            PromptCacheWireMode::ImplicitText,
        );

        let public_request = gemini_schema::project_request_tool_schemas(
            canonical_request.clone(),
            gemini_schema::GeminiToolSchemaDialect::PublicApi,
        );
        let public_declaration = &public_request["tools"][0]["functionDeclarations"][0];
        let public_schema = &public_declaration["parametersJsonSchema"];
        assert!(public_declaration.get("parameters").is_none());
        assert!(!contains_keyword(public_schema, "const", false));
        assert!(!contains_keyword(public_schema, "oneOf", false));
        assert_eq!(
            public_schema["properties"]["operations"]["items"]["properties"]["op"]["enum"],
            json!(["inspect", "pause"])
        );

        let antigravity_request = gemini_schema::project_request_tool_schemas(
            canonical_request,
            gemini_schema::GeminiToolSchemaDialect::Antigravity,
        );
        let antigravity_declaration = &antigravity_request["tools"][0]["functionDeclarations"][0];
        let antigravity_schema = &antigravity_declaration["parameters"];
        assert!(antigravity_declaration
            .get("parametersJsonSchema")
            .is_none());
        assert!(!contains_keyword(antigravity_schema, "const", false));
        assert!(!contains_keyword(antigravity_schema, "oneOf", false));
        assert!(!contains_keyword(antigravity_schema, "enum", false));
        assert!(
            antigravity_schema["properties"]["operations"]["items"]["properties"]
                .get("expected_revision")
                .is_some()
        );
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

    #[tokio::test]
    async fn antigravity_discovers_agent_models_and_probes_internal_generation() {
        let app = Router::new().fallback(
            |method: axum::http::Method,
             uri: axum::http::Uri,
             headers: axum::http::HeaderMap,
             Json(body): Json<Value>| async move {
                assert_eq!(method, axum::http::Method::POST);
                match uri.path() {
                    "/v1internal:fetchAvailableModels" => {
                        assert_eq!(body, json!({}));
                        assert_eq!(
                            headers
                                .get("authorization")
                                .and_then(|value| value.to_str().ok()),
                            Some("Bearer antigravity-access")
                        );
                        assert!(headers
                            .get("user-agent")
                            .and_then(|value| value.to_str().ok())
                            .is_some_and(|value| value.starts_with("antigravity/hub/")));
                        assert!(headers.get("x-goog-user-project").is_none());
                        Json(json!({
                            "defaultAgentModelId": "gemini-agent-default",
                            "agentModelSorts": [{
                                "groups": [{
                                    "modelIds": [
                                        "gemini-agent-default",
                                        "claude-agent-secondary",
                                        "deprecated-agent"
                                    ]
                                }]
                            }],
                            "deprecatedModelIds": {
                                "deprecated-agent": "gemini-agent-default"
                            },
                            "tabModelIds": ["tab-specialized"],
                            "models": {
                                "gemini-agent-default": {
                                    "maxTokens": 200000,
                                    "maxOutputTokens": 64000
                                },
                                "claude-agent-secondary": {"maxTokens": 180000},
                                "deprecated-agent": {"maxTokens": 1000},
                                "tab-specialized": {"maxTokens": 1000}
                            }
                        }))
                    }
                    "/v1internal:generateContent" => {
                        assert_eq!(body["model"], "gemini-agent-default");
                        assert_eq!(body["project"], "project-123");
                        assert_eq!(body["requestType"], "agent");
                        assert!(body["request"]["contents"].is_array());
                        assert_eq!(
                            headers
                                .get("authorization")
                                .and_then(|value| value.to_str().ok()),
                            Some("Bearer antigravity-access")
                        );
                        assert!(headers.get("x-goog-user-project").is_none());
                        Json(json!({
                                "response": {
                                    "candidates": [{
                                        "finishReason": "STOP",
                                        "content": {"parts": [{"text": "MORPHZ_OK"}]}
                                }]
                            }
                        }))
                    }
                    path => panic!("unexpected Antigravity test path {path}"),
                }
            },
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = ProtocolClient::new_with_adapter_and_context(
            &ProviderConfig {
                protocol: ModelProtocol::GeminiContent,
                base_url: format!("http://{address}"),
                headers: BTreeMap::from([(
                    "authorization".to_string(),
                    "Bearer antigravity-access".to_string(),
                )]),
                ..ProviderConfig::default()
            },
            "google-antigravity",
            "gemini-agent-default".to_string(),
            None,
            &LlmConfig::default(),
            BTreeMap::from([("project_id".to_string(), "project-123".to_string())]),
        )
        .unwrap();

        let catalog = client.list_model_catalog().await.unwrap();
        assert_eq!(
            catalog
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["gemini-agent-default", "claude-agent-secondary"]
        );
        assert_eq!(catalog[0].profile.context_window_tokens, Some(200_000));
        assert_eq!(catalog[0].profile.max_output_tokens, Some(64_000));
        assert_eq!(catalog[1].profile.context_window_tokens, Some(180_000));
        client.probe_health().await.unwrap();
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
            .send_stream("grok-4.5", &json!({}), None, &stream, None)
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
    async fn cyber_policy_stream_error_is_terminal_and_not_provider_recoverable() {
        let requests = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&requests);
        let app = Router::new().route(
            "/responses",
            post(move || {
                let observed = Arc::clone(&observed);
                async move {
                    observed.fetch_add(1, Ordering::SeqCst);
                    sse(concat!(
                        "event: error\n",
                        "data: {\"type\":\"error\",\"code\":\"cyber_policy\",\"message\":\"Request rejected by the provider safety policy.\"}\n\n"
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
            "test-model".to_string(),
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
            .send_stream("test-model", &json!({}), None, &stream, None)
            .await
            .unwrap_err();
        let failure = error.downcast_ref::<ModelFailure>().unwrap();
        assert_eq!(failure.kind, ModelFailureKind::SafetyRefusal);
        assert_eq!(failure.provider_code.as_deref(), Some("cyber_policy"));
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
    fn native_image_payloads_are_estimated_as_modal_inputs_not_base64_text() {
        let attachment = |name: &str, encoded_chars: usize| ModelAttachment {
            name: name.to_string(),
            media_type: "image/jpeg".to_string(),
            data_base64: "A".repeat(encoded_chars),
        };
        // Mirrors the two-image payload size that previously inflated a
        // roughly 24k prompt to about 392k tokens during ME-08.
        let messages = vec![
            Message {
                role: "user".to_string(),
                content: "Compare the two images and preserve the visual findings.".to_string(),
                name: None,
                tool_call_id: None,
                tool_calls: None,
            },
            attachment_message(vec![
                attachment("contact.jpg", 406_112),
                attachment("jump_detail.jpg", 1_065_196),
            ])
            .unwrap(),
        ];

        for protocol in [
            ModelProtocol::OpenaiChat,
            ModelProtocol::OpenaiResponses,
            ModelProtocol::AnthropicMessages,
            ModelProtocol::GeminiContent,
        ] {
            let body = build_request(protocol, "m", None, None, &messages, &[]);
            let raw_ascii_estimate = serde_json::to_string(&body).unwrap().len() / 4;
            assert!(raw_ascii_estimate > 300_000, "protocol={protocol:?}");

            let estimate = serialized_request_token_estimate(&body);
            assert!(
                estimate >= 2 * HEURISTIC_IMAGE_INPUT_TOKENS,
                "protocol={protocol:?}, estimate={estimate}"
            );
            assert!(
                estimate < 100_000,
                "protocol={protocol:?}, estimate={estimate}"
            );
        }
    }

    #[test]
    fn prompt_calibration_shape_separates_visual_input_shapes() {
        let user = Message {
            role: "user".to_string(),
            content: "inspect".to_string(),
            name: None,
            tool_call_id: None,
            tool_calls: None,
        };
        let attachment = |name: &str| ModelAttachment {
            name: name.to_string(),
            media_type: "image/png".to_string(),
            data_base64: "A".repeat(4_096),
        };
        let plain = build_request(
            ModelProtocol::OpenaiResponses,
            "m",
            None,
            None,
            std::slice::from_ref(&user),
            &[],
        );
        let one = build_request(
            ModelProtocol::OpenaiResponses,
            "m",
            None,
            None,
            &[
                user.clone(),
                attachment_message(vec![attachment("one.png")]).unwrap(),
            ],
            &[],
        );
        let two = build_request(
            ModelProtocol::OpenaiResponses,
            "m",
            None,
            None,
            &[
                user,
                attachment_message(vec![attachment("one.png"), attachment("two.png")]).unwrap(),
            ],
            &[],
        );

        let shape =
            |body: &Value| prompt_calibration_shape(ModelProtocol::OpenaiResponses, "m", body);
        assert_ne!(shape(&plain), shape(&one));
        assert_ne!(shape(&one), shape(&two));
    }

    #[test]
    fn anthropic_parallel_tool_results_keep_their_attachments_in_one_reply() {
        let tool_call = |id: &str, path: &str| ToolCall {
            id: id.to_string(),
            r#type: "function".to_string(),
            function: FunctionCall {
                name: "read".to_string(),
                arguments: json!({"path": path}).to_string(),
            },
        };
        let tool_result = |id: &str, content: &str| Message {
            role: "tool".to_string(),
            content: content.to_string(),
            name: Some("read".to_string()),
            tool_call_id: Some(id.to_string()),
            tool_calls: None,
        };
        let attachment = |name: &str, data: &str| {
            attachment_message(vec![ModelAttachment {
                name: name.to_string(),
                media_type: "image/jpeg".to_string(),
                data_base64: data.to_string(),
            }])
            .expect("attachment marker must serialize")
        };
        let messages = vec![
            Message {
                role: "user".to_string(),
                content: "Compare both images.".to_string(),
                name: None,
                tool_call_id: None,
                tool_calls: None,
            },
            Message {
                role: "assistant".to_string(),
                content: String::new(),
                name: None,
                tool_call_id: None,
                tool_calls: Some(vec![
                    tool_call("toolu_first", "/tmp/first.jpg"),
                    tool_call("toolu_second", "/tmp/second.jpg"),
                ]),
            },
            tool_result("toolu_first", "first image loaded"),
            attachment("first.jpg", "Zmlyc3Q="),
            tool_result("toolu_second", "second image loaded"),
            attachment("second.jpg", "c2Vjb25k"),
        ];

        let request = build_request(
            ModelProtocol::AnthropicMessages,
            "m",
            None,
            None,
            &messages,
            &[],
        );

        assert_eq!(request["messages"].as_array().map(Vec::len), Some(3));
        let results = request["messages"][2]["content"]
            .as_array()
            .expect("parallel tool results must share the immediate user message");
        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|block| block["type"] == "tool_result"));
        assert_eq!(results[0]["tool_use_id"], "toolu_first");
        assert_eq!(results[0]["content"][0]["type"], "text");
        assert_eq!(results[0]["content"][1]["type"], "image");
        assert_eq!(results[0]["content"][1]["source"]["data"], "Zmlyc3Q=");
        assert_eq!(results[1]["tool_use_id"], "toolu_second");
        assert_eq!(results[1]["content"][0]["type"], "text");
        assert_eq!(results[1]["content"][1]["type"], "image");
        assert_eq!(results[1]["content"][1]["source"]["data"], "c2Vjb25k");
    }

    #[test]
    fn openai_parallel_tool_results_precede_their_attachment_messages() {
        let tool_call = |id: &str, path: &str| ToolCall {
            id: id.to_string(),
            r#type: "function".to_string(),
            function: FunctionCall {
                name: "read".to_string(),
                arguments: json!({"path": path}).to_string(),
            },
        };
        let tool_result = |id: &str, content: &str| Message {
            role: "tool".to_string(),
            content: content.to_string(),
            name: Some("read".to_string()),
            tool_call_id: Some(id.to_string()),
            tool_calls: None,
        };
        let attachment = |name: &str, data: &str| {
            attachment_message(vec![ModelAttachment {
                name: name.to_string(),
                media_type: "image/jpeg".to_string(),
                data_base64: data.to_string(),
            }])
            .expect("attachment marker must serialize")
        };
        let messages = vec![
            Message {
                role: "user".to_string(),
                content: "Compare both images.".to_string(),
                name: None,
                tool_call_id: None,
                tool_calls: None,
            },
            Message {
                role: "assistant".to_string(),
                content: String::new(),
                name: None,
                tool_call_id: None,
                tool_calls: Some(vec![
                    tool_call("call_first", "/tmp/first.jpg"),
                    tool_call("call_second", "/tmp/second.jpg"),
                ]),
            },
            tool_result("call_first", "first image loaded"),
            attachment("first.jpg", "Zmlyc3Q="),
            tool_result("call_second", "second image loaded"),
            attachment("second.jpg", "c2Vjb25k"),
        ];

        for protocol in [ModelProtocol::OpenaiChat, ModelProtocol::OpenaiResponses] {
            let normalized = normalize_openai_tool_result_batches(messages.clone()).unwrap();
            assert_eq!(
                normalize_openai_tool_result_batches(normalized.clone()).unwrap(),
                normalized,
                "normalization must be safe for token measurement followed by dispatch"
            );
            assert_eq!(normalized[2].tool_call_id.as_deref(), Some("call_first"));
            assert_eq!(normalized[3].tool_call_id.as_deref(), Some("call_second"));
            assert_eq!(
                normalized[4].name.as_deref(),
                Some(MODEL_ATTACHMENT_MESSAGE_NAME)
            );
            assert_eq!(
                normalized[5].name.as_deref(),
                Some(MODEL_ATTACHMENT_MESSAGE_NAME)
            );

            let request = build_request(protocol, "m", None, None, &normalized, &[]);
            match protocol {
                ModelProtocol::OpenaiChat => {
                    assert_eq!(request["messages"][2]["role"], "tool");
                    assert_eq!(request["messages"][2]["tool_call_id"], "call_first");
                    assert_eq!(request["messages"][3]["role"], "tool");
                    assert_eq!(request["messages"][3]["tool_call_id"], "call_second");
                    assert_eq!(request["messages"][4]["role"], "user");
                    assert_eq!(request["messages"][5]["role"], "user");
                }
                ModelProtocol::OpenaiResponses => {
                    assert_eq!(request["input"][3]["type"], "function_call_output");
                    assert_eq!(request["input"][3]["call_id"], "call_first");
                    assert_eq!(request["input"][4]["type"], "function_call_output");
                    assert_eq!(request["input"][4]["call_id"], "call_second");
                    assert_eq!(request["input"][5]["role"], "user");
                    assert_eq!(request["input"][6]["role"], "user");
                }
                _ => unreachable!(),
            }
        }
    }

    #[test]
    fn openai_tool_result_preflight_rejects_an_incomplete_parallel_batch() {
        let calls = ["call_first", "call_second"]
            .into_iter()
            .map(|id| ToolCall {
                id: id.to_string(),
                r#type: "function".to_string(),
                function: FunctionCall {
                    name: "read".to_string(),
                    arguments: json!({"path": format!("/tmp/{id}.jpg")}).to_string(),
                },
            })
            .collect();
        let messages = vec![
            Message {
                role: "assistant".to_string(),
                content: String::new(),
                name: None,
                tool_call_id: None,
                tool_calls: Some(calls),
            },
            Message {
                role: "tool".to_string(),
                content: "first image loaded".to_string(),
                name: Some("read".to_string()),
                tool_call_id: Some("call_first".to_string()),
                tool_calls: None,
            },
            attachment_message(vec![ModelAttachment {
                name: "first.jpg".to_string(),
                media_type: "image/jpeg".to_string(),
                data_base64: "Zmlyc3Q=".to_string(),
            }])
            .unwrap(),
        ];

        let error = normalize_openai_tool_result_batches(messages).unwrap_err();
        assert!(error.to_string().contains("call_second"));
        assert!(error.to_string().contains("missing results"));
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
        client.observe_completion_usage(
            ModelProtocol::OpenaiChat,
            "test-model",
            &matching_body,
            &first,
            123,
        );

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
        client.observe_completion_usage(
            ModelProtocol::OpenaiChat,
            "test-model",
            &matching_body,
            &tool_measurement,
            999,
        );
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
    async fn visual_usage_calibration_does_not_contaminate_plain_text_requests() {
        let client = ProtocolClient::new(
            &ProviderConfig {
                protocol: ModelProtocol::OpenaiResponses,
                base_url: "http://127.0.0.1:1".to_string(),
                ..ProviderConfig::default()
            },
            "test-model".to_string(),
            None,
            &LlmConfig::default(),
        )
        .unwrap();
        let user = Message {
            role: "user".to_string(),
            content: "inspect".to_string(),
            name: None,
            tool_call_id: None,
            tool_calls: None,
        };
        let visual_prompt = vec![
            user.clone(),
            attachment_message(vec![ModelAttachment {
                name: "stable.jpg".to_string(),
                media_type: "image/jpeg".to_string(),
                data_base64: "A".repeat(304_582 * 4 / 3),
            }])
            .unwrap(),
        ];

        let visual = client
            .count_prompt_tokens("same-evaluation", &visual_prompt, &[])
            .await
            .unwrap()
            .unwrap();
        let visual_body = client.request_for_model("test-model", &visual_prompt, &[]);
        client.observe_completion_usage(
            ModelProtocol::OpenaiResponses,
            "test-model",
            &visual_body,
            &visual,
            24_000,
        );

        let same_visual = client
            .count_prompt_tokens("same-evaluation", &visual_prompt, &[])
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            same_visual.accuracy,
            PromptTokenAccuracy::UsageCalibratedEstimate
        );

        let plain = client
            .count_prompt_tokens("same-evaluation", &[user], &[])
            .await
            .unwrap()
            .unwrap();
        assert_eq!(plain.accuracy, PromptTokenAccuracy::HeuristicEstimate);
        assert!(plain.tokens < visual.tokens);
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
    fn gpt_5_6_auto_preserves_canonical_text_for_public_and_codex() {
        let context = segmented_text_message(
            "user",
            SegmentedModelText {
                parts: vec![
                    ModelTextPart {
                        text: "stable".to_string(),
                        cache_boundary_after: true,
                        cache_boundary_candidate_after: false,
                    },
                    ModelTextPart {
                        text: "dynamic".to_string(),
                        cache_boundary_after: false,
                        cache_boundary_candidate_after: false,
                    },
                ],
                prompt_cache_key: Some("morphz-context-test".to_string()),
            },
        )
        .unwrap();
        let provider = ProviderConfig {
            protocol: ModelProtocol::OpenaiResponses,
            base_url: "https://provider.invalid/v1".to_string(),
            ..ProviderConfig::default()
        };
        let client = ProtocolClient::new_with_adapter(
            &provider,
            "openai-codex",
            "gpt-5.6-sol".to_string(),
            None,
            &LlmConfig::default(),
        )
        .unwrap();

        let request = client.request_for_model("gpt-5.6-sol", std::slice::from_ref(&context), &[]);
        assert!(request.get("prompt_cache_options").is_none());
        assert_eq!(
            request.get("prompt_cache_key"),
            Some(&json!("morphz-context-test"))
        );
        assert_eq!(
            request.pointer("/input/0/content"),
            Some(&json!("stabledynamic"))
        );
        assert!(request.pointer("/input/1").is_none());
        assert!(request
            .to_string()
            .find("prompt_cache_breakpoint")
            .is_none());

        let generic = ProtocolClient::new(
            &provider,
            "gpt-5.6-sol".to_string(),
            None,
            &LlmConfig::default(),
        )
        .unwrap();
        let generic_request =
            generic.request_for_model("gpt-5.6-sol", std::slice::from_ref(&context), &[]);
        assert_eq!(
            generic_request.pointer("/input/0/content"),
            Some(&json!("stabledynamic"))
        );
        assert!(generic_request.get("prompt_cache_options").is_none());
        assert!(generic_request
            .to_string()
            .find("prompt_cache_breakpoint")
            .is_none());

        let older = client.request_for_model("gpt-5.5", std::slice::from_ref(&context), &[]);
        assert_eq!(
            older.pointer("/input/0/content"),
            Some(&json!("stabledynamic"))
        );
        assert!(older.pointer("/input/1").is_none());
        assert!(older.get("prompt_cache_options").is_none());
        assert_eq!(
            older.get("prompt_cache_key"),
            Some(&json!("morphz-context-test"))
        );

        let future = client.request_for_model("gpt-5.7-sol", &[context], &[]);
        assert_eq!(
            future.pointer("/input/0/content"),
            Some(&json!("stabledynamic"))
        );
        assert!(future.pointer("/input/1").is_none());
        assert!(future.to_string().find("prompt_cache_breakpoint").is_none());
        assert!(future.get("prompt_cache_options").is_none());

        let public_older = generic.request_for_model(
            "gpt-5.5",
            std::slice::from_ref(&incremental_context_message("older", &["one"])),
            &[],
        );
        assert_eq!(
            public_older.pointer("/input/0/content"),
            Some(&json!(
                "stable-system-and-protocol (inbox (observation one)) dynamic-tail"
            ))
        );
        assert!(public_older.get("prompt_cache_options").is_none());
    }

    fn incremental_context_message(provisional_key: &str, observations: &[&str]) -> Message {
        let mut parts = vec![
            ModelTextPart {
                text: "stable-system-and-protocol".to_string(),
                cache_boundary_after: true,
                cache_boundary_candidate_after: false,
            },
            ModelTextPart {
                text: " (inbox".to_string(),
                cache_boundary_after: observations.is_empty(),
                cache_boundary_candidate_after: observations.is_empty(),
            },
        ];
        for (index, observation) in observations.iter().enumerate() {
            parts.push(ModelTextPart {
                text: format!(" (observation {observation})"),
                cache_boundary_after: index + 1 == observations.len(),
                cache_boundary_candidate_after: true,
            });
        }
        parts.push(ModelTextPart {
            text: ") dynamic-tail".to_string(),
            cache_boundary_after: false,
            cache_boundary_candidate_after: false,
        });
        segmented_text_message(
            "user",
            SegmentedModelText {
                parts,
                prompt_cache_key: Some(provisional_key.to_string()),
            },
        )
        .unwrap()
    }

    fn explicit_breakpoint_texts(request: &Value) -> Vec<String> {
        request
            .pointer("/input/1/content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|block| block.get("prompt_cache_breakpoint").is_some())
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .map(ToOwned::to_owned)
            .collect()
    }

    fn prepare_incremental_request(
        history: &mut VecDeque<PromptCacheBoundaryIdentity>,
        provisional_key: &str,
        observations: &[&str],
        wire_mode: PromptCacheWireMode,
    ) -> (Value, String) {
        let mut messages = vec![
            Message {
                role: "system".to_string(),
                content: "stable system".to_string(),
                name: None,
                tool_call_id: None,
                tool_calls: None,
            },
            incremental_context_message(provisional_key, observations),
        ];
        let cohort_key =
            prompt_cache_cohort_key("gpt-5.6-sol", None, wire_mode, &messages, &[]).unwrap();
        let mut segmented = segmented_model_text(&messages[1]).unwrap();
        segmented.prompt_cache_key = Some(cohort_key.clone());
        if wire_mode.plans_cache_boundaries() {
            let current = plan_incremental_cache_boundaries(&mut segmented, history).unwrap();
            history.retain(|prior| prior != &current);
            history.push_front(current);
            history.truncate(OPENAI_TRACKED_CACHE_BOUNDARIES);
        }
        messages[1].content = serde_json::to_string(&segmented).unwrap();
        (
            build_openai_responses_request("gpt-5.6-sol", None, None, &messages, &[], wire_mode),
            cohort_key,
        )
    }

    fn model_visible_responses_contract(request: &Value) -> Value {
        let mut input = Vec::<Value>::new();
        for message in request.get("input").and_then(Value::as_array).unwrap() {
            let role = message.get("role").unwrap();
            let content = match message.get("content").unwrap() {
                Value::String(text) => text.clone(),
                Value::Array(blocks) => blocks
                    .iter()
                    .filter_map(|block| block.get("text").and_then(Value::as_str))
                    .collect::<String>(),
                other => panic!("unexpected Responses content: {other}"),
            };
            if let Some(previous) = input.last_mut().filter(|previous| {
                previous.get("role") == Some(role)
                    && previous.get("content").is_some_and(Value::is_string)
            }) {
                previous["content"] = json!(format!(
                    "{}{}",
                    previous["content"].as_str().unwrap(),
                    content
                ));
            } else {
                input.push(json!({"role": role, "content": content}));
            }
        }
        json!({
            "model": request.get("model").unwrap(),
            "input": input,
            "tools": request.get("tools").cloned().unwrap_or_else(|| json!([])),
        })
    }

    fn json_sha256(value: &Value) -> String {
        format!("{:x}", Sha256::digest(serde_json::to_vec(value).unwrap()))
    }

    fn record_wire_audit(
        store: &mut PromptCacheWireAuditStore,
        request: &Value,
    ) -> PromptCacheWireAudit {
        store.record(
            request["prompt_cache_key"].as_str().unwrap(),
            prompt_cache_wire_snapshot(request).unwrap(),
        )
    }

    #[test]
    fn prompt_cache_wire_audit_proves_strict_message_append_and_prior_boundary_match() {
        let first = json!({
            "model": "gpt-5.6-sol",
            "input": [
                {"role": "developer", "content": "fixed instructions"},
                {"role": "user", "content": "stable context"}
            ],
            "prompt_cache_key": "cohort-a",
            "stream": true
        });
        let second = json!({
            "model": "gpt-5.6-sol",
            "input": [
                {"role": "developer", "content": "fixed instructions"},
                {"role": "user", "content": "stable context"},
                {"role": "user", "content": "new suffix"}
            ],
            "prompt_cache_key": "cohort-a",
            "stream": true
        });
        let mut store = PromptCacheWireAuditStore::default();
        let cold = record_wire_audit(&mut store, &first);
        let warm = record_wire_audit(&mut store, &second);

        assert_eq!(cold.matched_prior_boundary_items, 0);
        assert_eq!(warm.longest_common_input_items, 2);
        assert!(warm.previous_is_strict_prefix);
        assert_eq!(warm.matched_prior_boundary_items, 2);
        assert_eq!(warm.matched_prior_boundary_sequence, Some(cold.sequence));
        assert_eq!(warm.latest_implicit_boundary_items, Some(3));
    }

    #[test]
    fn prompt_cache_wire_audit_rejects_insertion_before_trailing_user_item() {
        let first = json!({
            "model": "gpt-5.6-sol",
            "input": [
                {"role": "developer", "content": "fixed instructions"},
                {"role": "user", "content": "stable context"},
                {"role": "user", "content": "))"}
            ],
            "prompt_cache_key": "cohort-b",
            "stream": true
        });
        let second = json!({
            "model": "gpt-5.6-sol",
            "input": [
                {"role": "developer", "content": "fixed instructions"},
                {"role": "user", "content": "stable context"},
                {"role": "user", "content": "new observation"},
                {"role": "user", "content": "))"}
            ],
            "prompt_cache_key": "cohort-b",
            "stream": true
        });
        let mut store = PromptCacheWireAuditStore::default();
        record_wire_audit(&mut store, &first);
        let audit = record_wire_audit(&mut store, &second);

        assert_eq!(audit.longest_common_input_items, 2);
        assert!(!audit.previous_is_strict_prefix);
        assert_eq!(audit.matched_prior_boundary_items, 0);
        assert_eq!(audit.latest_implicit_boundary_items, Some(4));
    }

    #[test]
    fn prompt_cache_wire_audit_rejects_matching_input_when_request_properties_change() {
        let first = json!({
            "model": "gpt-5.6-sol",
            "reasoning": {"effort": "high"},
            "input": [{"role": "user", "content": "stable context"}],
            "prompt_cache_key": "cohort-c",
            "stream": true
        });
        let second = json!({
            "model": "gpt-5.6-sol",
            "reasoning": {"effort": "max"},
            "input": [
                {"role": "user", "content": "stable context"},
                {"role": "user", "content": "new suffix"}
            ],
            "prompt_cache_key": "cohort-c",
            "stream": true
        });
        let mut store = PromptCacheWireAuditStore::default();
        record_wire_audit(&mut store, &first);
        let audit = record_wire_audit(&mut store, &second);

        assert_eq!(audit.longest_common_input_items, 1);
        assert!(!audit.previous_is_strict_prefix);
        assert_eq!(audit.matched_prior_boundary_items, 0);
    }

    #[test]
    fn prompt_cache_wire_audit_treats_changed_content_blocks_as_one_changed_message() {
        let first = json!({
            "model": "gpt-5.6-sol",
            "input": [{"role": "user", "content": [
                {"type": "input_text", "text": "stable"},
                {"type": "input_text", "text": " observation one"},
                {"type": "input_text", "text": "))"}
            ]}],
            "prompt_cache_key": "cohort-d",
            "stream": true
        });
        let second = json!({
            "model": "gpt-5.6-sol",
            "input": [{"role": "user", "content": [
                {"type": "input_text", "text": "stable"},
                {"type": "input_text", "text": " observation one"},
                {"type": "input_text", "text": " observation two"},
                {"type": "input_text", "text": "))"}
            ]}],
            "prompt_cache_key": "cohort-d",
            "stream": true
        });
        let mut store = PromptCacheWireAuditStore::default();
        record_wire_audit(&mut store, &first);
        let audit = record_wire_audit(&mut store, &second);

        assert_eq!(audit.longest_common_input_items, 0);
        assert!(!audit.previous_is_strict_prefix);
        assert_eq!(audit.longest_common_content_blocks, 2);
        assert!(!audit.previous_content_blocks_is_strict_prefix);
        assert_eq!(audit.matched_prior_boundary_items, 0);
        assert!(!audit.input_item_fingerprints.contains("stable"));
        assert!(!audit.input_item_fingerprints.contains("observation"));
        assert!(!audit.content_block_fingerprints.contains("stable"));
        assert!(!audit.content_block_fingerprints.contains("observation"));
    }

    #[test]
    fn prompt_cache_wire_audit_proves_strict_content_block_append() {
        let first = json!({
            "model": "gpt-5.6-sol",
            "input": [{"role": "user", "content": [
                {"type": "input_text", "text": "closed canonical context"},
                {"type": "input_text", "text": "structured delta one"}
            ]}],
            "prompt_cache_key": "cohort-content-append",
            "stream": true
        });
        let second = json!({
            "model": "gpt-5.6-sol",
            "input": [{"role": "user", "content": [
                {"type": "input_text", "text": "closed canonical context"},
                {"type": "input_text", "text": "structured delta one"},
                {"type": "input_text", "text": "structured delta two"}
            ]}],
            "prompt_cache_key": "cohort-content-append",
            "stream": true
        });
        let mut store = PromptCacheWireAuditStore::default();
        record_wire_audit(&mut store, &first);
        let audit = record_wire_audit(&mut store, &second);

        assert_eq!(audit.longest_common_input_items, 0);
        assert!(!audit.previous_is_strict_prefix);
        assert_eq!(audit.longest_common_content_blocks, 2);
        assert!(audit.previous_content_blocks_is_strict_prefix);
    }

    #[test]
    fn gpt_5_6_prompt_cache_preserves_prior_inbox_ends_and_caps_breakpoints() {
        let mut history = VecDeque::new();
        let (first_request, first_key) = prepare_incremental_request(
            &mut history,
            "context-a",
            &["one"],
            PromptCacheWireMode::ExplicitContentBoundaries,
        );
        assert_eq!(explicit_breakpoint_texts(&first_request).len(), 2);

        let (second_request, second_key) = prepare_incremental_request(
            &mut history,
            "different-context-b",
            &["one", "two"],
            PromptCacheWireMode::ExplicitContentBoundaries,
        );
        assert_eq!(first_key, second_key);
        let second_breakpoints = explicit_breakpoint_texts(&second_request);
        assert_eq!(second_breakpoints.len(), 3);
        assert!(second_breakpoints[1].ends_with("(observation one)"));
        assert_eq!(second_breakpoints[2], " (observation two)");

        let (third_request, _) = prepare_incremental_request(
            &mut history,
            "context-c",
            &["one", "two", "three"],
            PromptCacheWireMode::ExplicitContentBoundaries,
        );
        assert_eq!(explicit_breakpoint_texts(&third_request).len(), 4);

        let (fourth_request, _) = prepare_incremental_request(
            &mut history,
            "context-d",
            &["one", "two", "three", "four"],
            PromptCacheWireMode::ExplicitContentBoundaries,
        );
        let fourth_breakpoints = explicit_breakpoint_texts(&fourth_request);
        assert_eq!(fourth_breakpoints.len(), 4);
        assert!(fourth_breakpoints
            .iter()
            .any(|text| text.ends_with("(observation three)")));
        assert_eq!(fourth_breakpoints.last().unwrap(), " (observation four)");

        let (rebuilt_request, _) = prepare_incremental_request(
            &mut history,
            "context-e",
            &["changed", "two", "three", "four", "five"],
            PromptCacheWireMode::ExplicitContentBoundaries,
        );
        assert_eq!(explicit_breakpoint_texts(&rebuilt_request).len(), 2);
    }

    #[test]
    fn prompt_cache_wire_modes_change_only_transport_metadata() {
        let mut explicit_history = VecDeque::new();
        let mut implicit_blocks_history = VecDeque::new();
        let mut implicit_messages_history = VecDeque::new();
        let mut implicit_history = VecDeque::new();

        let (explicit_first, explicit_key) = prepare_incremental_request(
            &mut explicit_history,
            "explicit-a",
            &["one"],
            PromptCacheWireMode::ExplicitContentBoundaries,
        );
        let (implicit_blocks_first, implicit_blocks_key) = prepare_incremental_request(
            &mut implicit_blocks_history,
            "implicit-blocks-a",
            &["one"],
            PromptCacheWireMode::ImplicitContentBoundaries,
        );
        let (implicit_messages_first, implicit_messages_key) = prepare_incremental_request(
            &mut implicit_messages_history,
            "implicit-messages-a",
            &["one"],
            PromptCacheWireMode::ImplicitMessageBoundaries,
        );
        let (implicit_first, implicit_key) = prepare_incremental_request(
            &mut implicit_history,
            "implicit-a",
            &["one"],
            PromptCacheWireMode::ImplicitText,
        );

        let explicit_visible = model_visible_responses_contract(&explicit_first);
        let implicit_blocks_visible = model_visible_responses_contract(&implicit_blocks_first);
        let implicit_messages_visible = model_visible_responses_contract(&implicit_messages_first);
        let implicit_visible = model_visible_responses_contract(&implicit_first);
        assert_eq!(explicit_visible, implicit_blocks_visible);
        assert_eq!(explicit_visible, implicit_messages_visible);
        assert_eq!(explicit_visible, implicit_visible);
        assert_eq!(
            json_sha256(&explicit_visible),
            json_sha256(&implicit_blocks_visible)
        );
        assert_eq!(
            json_sha256(&explicit_visible),
            json_sha256(&implicit_messages_visible)
        );
        assert_eq!(
            json_sha256(&explicit_visible),
            json_sha256(&implicit_visible)
        );
        assert_ne!(explicit_key, implicit_blocks_key);
        assert_ne!(explicit_key, implicit_messages_key);
        assert_ne!(explicit_key, implicit_key);
        assert_ne!(implicit_blocks_key, implicit_key);
        assert_eq!(
            explicit_first.get("prompt_cache_key"),
            Some(&json!(explicit_key))
        );
        assert_eq!(
            implicit_blocks_first.get("prompt_cache_key"),
            Some(&json!(implicit_blocks_key))
        );
        assert_eq!(
            implicit_messages_first.get("prompt_cache_key"),
            Some(&json!(implicit_messages_key))
        );
        assert_eq!(
            implicit_first.get("prompt_cache_key"),
            Some(&json!(implicit_key))
        );
        assert!(explicit_first.get("prompt_cache_options").is_some());
        assert!(implicit_blocks_first.get("prompt_cache_options").is_none());
        assert!(implicit_first.get("prompt_cache_options").is_none());
        assert!(explicit_first
            .pointer("/input/1/content")
            .unwrap()
            .is_array());
        assert!(implicit_blocks_first
            .pointer("/input/1/content")
            .unwrap()
            .is_array());
        assert!(implicit_messages_first["input"].as_array().unwrap().len() > 2);
        assert!(implicit_messages_first["input"]
            .as_array()
            .unwrap()
            .iter()
            .skip(1)
            .all(|item| item["role"] == "user" && item["content"].is_string()));
        assert!(implicit_first
            .pointer("/input/1/content")
            .unwrap()
            .is_string());
        let explicit_block_texts = explicit_first["input"][1]["content"]
            .as_array()
            .unwrap()
            .iter()
            .map(|block| block["text"].as_str().unwrap())
            .collect::<Vec<_>>();
        let implicit_block_texts = implicit_blocks_first["input"][1]["content"]
            .as_array()
            .unwrap()
            .iter()
            .map(|block| block["text"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(explicit_block_texts.concat(), implicit_block_texts.concat());
        assert!(implicit_block_texts.len() > explicit_block_texts.len());
        assert!(implicit_blocks_first["input"][1]["content"]
            .as_array()
            .unwrap()
            .iter()
            .all(|block| block.get("prompt_cache_breakpoint").is_none()));

        let (explicit_second, explicit_second_key) = prepare_incremental_request(
            &mut explicit_history,
            "explicit-b",
            &["one", "two"],
            PromptCacheWireMode::ExplicitContentBoundaries,
        );
        let (implicit_blocks_second, implicit_blocks_second_key) = prepare_incremental_request(
            &mut implicit_blocks_history,
            "implicit-blocks-b",
            &["one", "two"],
            PromptCacheWireMode::ImplicitContentBoundaries,
        );
        let (implicit_messages_second, implicit_messages_second_key) = prepare_incremental_request(
            &mut implicit_messages_history,
            "implicit-messages-b",
            &["one", "two"],
            PromptCacheWireMode::ImplicitMessageBoundaries,
        );
        let (implicit_second, implicit_second_key) = prepare_incremental_request(
            &mut implicit_history,
            "implicit-b",
            &["one", "two"],
            PromptCacheWireMode::ImplicitText,
        );
        assert_eq!(explicit_key, explicit_second_key);
        assert_eq!(implicit_blocks_key, implicit_blocks_second_key);
        assert_eq!(implicit_messages_key, implicit_messages_second_key);
        assert_eq!(implicit_key, implicit_second_key);
        assert_eq!(
            model_visible_responses_contract(&explicit_second),
            model_visible_responses_contract(&implicit_blocks_second)
        );
        assert_eq!(
            model_visible_responses_contract(&explicit_second),
            model_visible_responses_contract(&implicit_messages_second)
        );
        assert_eq!(
            model_visible_responses_contract(&explicit_second),
            model_visible_responses_contract(&implicit_second)
        );
        assert_eq!(explicit_breakpoint_texts(&explicit_second).len(), 3);
        assert!(explicit_breakpoint_texts(&implicit_blocks_second).is_empty());
        assert!(explicit_breakpoint_texts(&implicit_second).is_empty());
        let explicit_second_texts = explicit_second["input"][1]["content"]
            .as_array()
            .unwrap()
            .iter()
            .map(|block| block["text"].as_str().unwrap())
            .collect::<Vec<_>>();
        let implicit_blocks_second_texts = implicit_blocks_second["input"][1]["content"]
            .as_array()
            .unwrap()
            .iter()
            .map(|block| block["text"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            explicit_second_texts.concat(),
            implicit_blocks_second_texts.concat()
        );
        assert!(implicit_blocks_second_texts.len() > explicit_second_texts.len());
        assert_eq!(implicit_blocks_second_texts[2], " (observation one)");
        assert_eq!(implicit_blocks_second_texts[3], " (observation two)");
    }

    #[test]
    fn implicit_content_boundaries_keep_prior_inbox_blocks_append_only() {
        let mut history = VecDeque::new();
        let (first, first_key) = prepare_incremental_request(
            &mut history,
            "first",
            &["one"],
            PromptCacheWireMode::ImplicitContentBoundaries,
        );
        let (second, second_key) = prepare_incremental_request(
            &mut history,
            "second",
            &["one", "two"],
            PromptCacheWireMode::ImplicitContentBoundaries,
        );

        assert_eq!(first_key, second_key);
        assert!(history.is_empty());
        let first_blocks = first["input"][1]["content"].as_array().unwrap();
        let second_blocks = second["input"][1]["content"].as_array().unwrap();
        assert_eq!(first_blocks.len() + 1, second_blocks.len());
        assert_eq!(
            &first_blocks[..first_blocks.len() - 1],
            &second_blocks[..first_blocks.len() - 1]
        );
        assert_eq!(
            second_blocks[second_blocks.len() - 2]["text"],
            " (observation two)"
        );
        assert!(first_blocks
            .iter()
            .chain(second_blocks.iter())
            .all(|block| block["type"] == "input_text"
                && block.get("prompt_cache_breakpoint").is_none()));
    }

    #[test]
    fn implicit_message_boundaries_insert_before_the_canonical_trailing_item() {
        let mut history = VecDeque::new();
        let (first, first_key) = prepare_incremental_request(
            &mut history,
            "first",
            &["one"],
            PromptCacheWireMode::ImplicitMessageBoundaries,
        );
        let (second, second_key) = prepare_incremental_request(
            &mut history,
            "second",
            &["one", "two"],
            PromptCacheWireMode::ImplicitMessageBoundaries,
        );

        assert_eq!(first_key, second_key);
        assert!(history.is_empty());
        let first_items = first["input"].as_array().unwrap();
        let second_items = second["input"].as_array().unwrap();
        assert_eq!(first_items.len() + 1, second_items.len());

        // Historical observation items stay byte-identical, but the canonical
        // closing suffix remains the last User item. The new observation is
        // inserted before it, so the request as a whole is not a strict item
        // extension and the prior implicit end-of-message breakpoint cannot
        // match.
        assert_eq!(
            &first_items[..first_items.len() - 1],
            &second_items[..first_items.len() - 1]
        );
        assert_eq!(
            second_items[second_items.len() - 2]["content"],
            " (observation two)"
        );
        let mut audit_store = PromptCacheWireAuditStore::default();
        record_wire_audit(&mut audit_store, &first);
        let second_audit = record_wire_audit(&mut audit_store, &second);
        assert_eq!(
            second_audit.longest_common_input_items,
            first_items.len() - 1
        );
        assert!(!second_audit.previous_is_strict_prefix);
        assert_eq!(second_audit.matched_prior_boundary_items, 0);
        assert!(first_items
            .iter()
            .chain(second_items.iter())
            .all(|item| item["role"] == "system" || item["role"] == "user"));
        assert_eq!(
            model_visible_responses_contract(&first),
            model_visible_responses_contract(
                &prepare_incremental_request(
                    &mut VecDeque::new(),
                    "visible-first",
                    &["one"],
                    PromptCacheWireMode::ImplicitText,
                )
                .0
            )
        );
    }

    #[test]
    fn configured_codex_message_transport_preserves_context_role_and_text() {
        let mut provider = ProviderConfig {
            protocol: ModelProtocol::OpenaiResponses,
            base_url: "https://provider.invalid/v1".to_string(),
            ..ProviderConfig::default()
        };
        let public = ProtocolClient::new(
            &provider,
            "gpt-5.6-sol".to_string(),
            None,
            &LlmConfig::default(),
        )
        .unwrap();
        provider.models.insert(
            "gpt-5.6-sol".to_string(),
            ProviderModelConfig {
                prompt_cache_strategy: PromptCacheStrategy::ImplicitMessageBoundaries,
                ..ProviderModelConfig::default()
            },
        );
        let codex = ProtocolClient::new_with_adapter(
            &provider,
            "openai-codex",
            "gpt-5.6-sol".to_string(),
            None,
            &LlmConfig::default(),
        )
        .unwrap();

        for observations in [&["one"][..], &["one", "two"][..]] {
            let messages = vec![
                Message {
                    role: "system".to_string(),
                    content: "stable system".to_string(),
                    name: None,
                    tool_call_id: None,
                    tool_calls: None,
                },
                incremental_context_message("provisional", observations),
            ];
            let public_messages = public
                .prepare_prompt_cache_messages("gpt-5.6-sol", messages.clone(), &[], None, true)
                .unwrap();
            let codex_messages = codex
                .prepare_prompt_cache_messages("gpt-5.6-sol", messages, &[], None, true)
                .unwrap();
            let public_request = public.request_for_model("gpt-5.6-sol", &public_messages, &[]);
            let codex_request = codex.request_for_model("gpt-5.6-sol", &codex_messages, &[]);

            assert_eq!(public_request["input"].as_array().unwrap().len(), 2);
            assert!(codex_request["input"].as_array().unwrap().len() > 2);
            assert_eq!(
                public_request.pointer("/input/1/role"),
                Some(&json!("user"))
            );
            assert!(codex_request["input"]
                .as_array()
                .unwrap()
                .iter()
                .skip(1)
                .all(|item| item["role"] == "user" && item["content"].is_string()));
            let public_context = public_request
                .pointer("/input/1/content")
                .and_then(Value::as_str)
                .expect("Auto must preserve canonical Context as one text item")
                .to_string();
            let codex_context = codex_request["input"]
                .as_array()
                .unwrap()
                .iter()
                .skip(1)
                .filter_map(|item| item["content"].as_str())
                .collect::<String>();
            assert_eq!(public_context, codex_context);
            assert_eq!(
                model_visible_responses_contract(&public_request)["input"][1],
                model_visible_responses_contract(&codex_request)["input"][1]
            );
            assert!(codex_request.get("prompt_cache_options").is_none());
            assert!(codex_request
                .to_string()
                .find("prompt_cache_breakpoint")
                .is_none());
        }
    }

    #[test]
    fn structured_delta_cache_transport_requires_compiled_explicit_model_opt_in() {
        let mut provider = ProviderConfig {
            protocol: ModelProtocol::OpenaiResponses,
            base_url: "https://provider.invalid/v1".to_string(),
            ..ProviderConfig::default()
        };
        provider.models.insert(
            "auto".to_string(),
            ProviderModelConfig {
                prompt_cache_strategy: PromptCacheStrategy::Auto,
                ..ProviderModelConfig::default()
            },
        );
        provider.models.insert(
            "implicit".to_string(),
            ProviderModelConfig {
                prompt_cache_strategy: PromptCacheStrategy::ImplicitPrefix,
                ..ProviderModelConfig::default()
            },
        );
        provider.models.insert(
            "explicit".to_string(),
            ProviderModelConfig {
                prompt_cache_strategy: PromptCacheStrategy::ExplicitContentBoundaries,
                ..ProviderModelConfig::default()
            },
        );
        provider.models.insert(
            "message-blocks".to_string(),
            ProviderModelConfig {
                prompt_cache_strategy: PromptCacheStrategy::ImplicitMessageBoundaries,
                ..ProviderModelConfig::default()
            },
        );
        provider.models.insert(
            "structured-deltas".to_string(),
            ProviderModelConfig {
                prompt_cache_strategy: PromptCacheStrategy::ExperimentalStructuredDeltas,
                ..ProviderModelConfig::default()
            },
        );
        let codex = ProtocolClient::new_with_adapter(
            &provider,
            "openai-codex",
            "auto".to_string(),
            None,
            &LlmConfig::default(),
        )
        .unwrap();
        let public =
            ProtocolClient::new(&provider, "auto".to_string(), None, &LlmConfig::default())
                .unwrap();

        assert!(!codex.prefers_structured_delta_cache_transport(Some("auto")));
        assert!(!codex.prefers_structured_delta_cache_transport(Some("implicit")));
        assert!(!codex.prefers_structured_delta_cache_transport(Some("explicit")));
        assert!(!codex.prefers_structured_delta_cache_transport(Some("message-blocks")));
        assert!(!public.prefers_structured_delta_cache_transport(Some("auto")));
        assert!(!public.prefers_structured_delta_cache_transport(Some("implicit")));
        assert_eq!(
            codex.prefers_structured_delta_cache_transport(Some("structured-deltas")),
            cfg!(feature = "experimental-structured-context-delta-cache")
        );
        // The opt-in is an endpoint declaration, not adapter-name inference;
        // this also supports an OpenAI-compatible Proxy in front of ChatGPT.
        assert_eq!(
            public.prefers_structured_delta_cache_transport(Some("structured-deltas")),
            cfg!(feature = "experimental-structured-context-delta-cache")
        );
    }

    #[cfg(not(feature = "experimental-structured-context-delta-cache"))]
    #[test]
    fn structured_delta_cache_config_is_rejected_when_feature_is_not_compiled() {
        let mut provider = ProviderConfig {
            protocol: ModelProtocol::OpenaiResponses,
            base_url: "https://provider.invalid/v1".to_string(),
            ..ProviderConfig::default()
        };
        provider.models.insert(
            "structured-deltas".to_string(),
            ProviderModelConfig {
                prompt_cache_strategy: PromptCacheStrategy::ExperimentalStructuredDeltas,
                ..ProviderModelConfig::default()
            },
        );
        let error = ProtocolClient::new(
            &provider,
            "structured-deltas".to_string(),
            None,
            &LlmConfig::default(),
        )
        .err()
        .expect("an uncompiled experimental transport must be rejected");
        assert!(error
            .to_string()
            .contains("experimental-structured-context-delta-cache"));
    }

    #[cfg(feature = "experimental-structured-context-delta-cache")]
    #[test]
    fn structured_delta_cache_opt_in_emits_one_user_item_with_multiple_text_blocks() {
        let mut provider = ProviderConfig {
            protocol: ModelProtocol::OpenaiResponses,
            base_url: "https://proxy.invalid/v1".to_string(),
            ..ProviderConfig::default()
        };
        provider.models.insert(
            "proxied-chatgpt".to_string(),
            ProviderModelConfig {
                prompt_cache_strategy: PromptCacheStrategy::ExperimentalStructuredDeltas,
                ..ProviderModelConfig::default()
            },
        );
        let client = ProtocolClient::new_with_adapter(
            &provider,
            "openai-compatible",
            "proxied-chatgpt".to_string(),
            None,
            &LlmConfig::default(),
        )
        .unwrap();
        let message = segmented_text_message(
            "user",
            SegmentedModelText {
                parts: vec![
                    ModelTextPart {
                        text: "(context (inbox))".to_string(),
                        cache_boundary_after: true,
                        cache_boundary_candidate_after: true,
                    },
                    ModelTextPart {
                        text: "\n(context-delta (inbox-append (observation)))".to_string(),
                        cache_boundary_after: true,
                        cache_boundary_candidate_after: true,
                    },
                ],
                prompt_cache_key: Some("structured-cohort".to_string()),
            },
        )
        .unwrap();
        let request = client.request_for_model("proxied-chatgpt", &[message], &[]);
        let input = request["input"].as_array().unwrap();
        let content = input[0]["content"].as_array().unwrap();

        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["role"], "user");
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["text"], "(context (inbox))");
        assert!(content[1]["text"]
            .as_str()
            .unwrap()
            .contains("context-delta"));
        assert!(content
            .iter()
            .all(|block| block.get("prompt_cache_breakpoint").is_none()));
    }

    #[cfg(feature = "experimental-structured-context-delta-cache")]
    #[test]
    fn structured_delta_cache_preserves_native_text_blocks_across_protocols() {
        let message = segmented_text_message(
            "user",
            SegmentedModelText {
                parts: vec![
                    ModelTextPart {
                        text: "(context (inbox))".to_string(),
                        cache_boundary_after: true,
                        cache_boundary_candidate_after: true,
                    },
                    ModelTextPart {
                        text: "\n(context-delta (inbox-append (observation)))".to_string(),
                        cache_boundary_after: true,
                        cache_boundary_candidate_after: true,
                    },
                ],
                prompt_cache_key: Some("structured-cohort".to_string()),
            },
        )
        .unwrap();

        for protocol in [
            ModelProtocol::OpenaiChat,
            ModelProtocol::AnthropicMessages,
            ModelProtocol::GeminiContent,
        ] {
            let mut provider = ProviderConfig {
                protocol,
                base_url: "https://provider.invalid/v1".to_string(),
                ..ProviderConfig::default()
            };
            provider.models.insert(
                "model".to_string(),
                ProviderModelConfig {
                    prompt_cache_strategy: PromptCacheStrategy::ExperimentalStructuredDeltas,
                    ..ProviderModelConfig::default()
                },
            );
            let client =
                ProtocolClient::new(&provider, "model".to_string(), None, &LlmConfig::default())
                    .unwrap();
            assert!(client.prefers_structured_delta_cache_transport(Some("model")));
            let request = client.request_for_model("model", std::slice::from_ref(&message), &[]);
            let blocks = match protocol {
                ModelProtocol::OpenaiChat => request.pointer("/messages/0/content"),
                ModelProtocol::AnthropicMessages => request.pointer("/messages/0/content"),
                ModelProtocol::GeminiContent => request.pointer("/contents/0/parts"),
                ModelProtocol::OpenaiResponses => unreachable!(),
            }
            .and_then(Value::as_array)
            .unwrap();
            assert_eq!(blocks.len(), 2, "protocol={protocol:?}");
            assert_eq!(blocks[0]["text"], "(context (inbox))");
            assert!(blocks[1]["text"]
                .as_str()
                .unwrap()
                .contains("context-delta"));
        }
    }

    #[test]
    fn prompt_cache_cohort_tracks_model_reasoning_tools_and_stable_prefix() {
        let messages = vec![
            Message {
                role: "system".to_string(),
                content: "stable system".to_string(),
                name: None,
                tool_call_id: None,
                tool_calls: None,
            },
            incremental_context_message("context-a", &["one"]),
        ];
        let base = prompt_cache_cohort_key(
            "gpt-5.6-sol",
            None,
            PromptCacheWireMode::ExplicitContentBoundaries,
            &messages,
            &[],
        )
        .unwrap();
        assert_eq!(base.len(), 64);
        assert_ne!(
            base,
            prompt_cache_cohort_key(
                "gpt-5.6-sol",
                None,
                PromptCacheWireMode::ImplicitContentBoundaries,
                &messages,
                &[],
            )
            .unwrap()
        );
        assert_ne!(
            base,
            prompt_cache_cohort_key(
                "gpt-5.6-sol",
                None,
                PromptCacheWireMode::ImplicitText,
                &messages,
                &[],
            )
            .unwrap()
        );
        assert_eq!(
            base,
            prompt_cache_cohort_key(
                "gpt-5.6-sol",
                None,
                PromptCacheWireMode::ExplicitContentBoundaries,
                &[
                    messages[0].clone(),
                    incremental_context_message("other-context", &["different"]),
                ],
                &[],
            )
            .unwrap()
        );
        assert_ne!(
            base,
            prompt_cache_cohort_key(
                "gpt-5.6-sol",
                Some(ReasoningEffort::High),
                PromptCacheWireMode::ExplicitContentBoundaries,
                &messages,
                &[],
            )
            .unwrap()
        );
        assert_ne!(
            base,
            prompt_cache_cohort_key(
                "gpt-5.6-terra",
                None,
                PromptCacheWireMode::ExplicitContentBoundaries,
                &messages,
                &[],
            )
            .unwrap()
        );
        assert_ne!(
            base,
            prompt_cache_cohort_key(
                "gpt-5.6-sol",
                None,
                PromptCacheWireMode::ExplicitContentBoundaries,
                &messages,
                &[ToolDefinition {
                    name: "read".to_string(),
                    description: "Read a file".to_string(),
                    parameters: json!({"type": "object"}),
                }],
            )
            .unwrap()
        );
    }

    #[test]
    fn configured_prompt_cache_strategy_controls_the_physical_endpoint() {
        let context = incremental_context_message("configured", &["one"]);
        let mut provider = ProviderConfig {
            protocol: ModelProtocol::OpenaiResponses,
            base_url: "https://provider.invalid/v1".to_string(),
            ..ProviderConfig::default()
        };
        provider.models.insert(
            "auto-gpt-5.6-sol".to_string(),
            ProviderModelConfig {
                prompt_cache_strategy: PromptCacheStrategy::Auto,
                ..ProviderModelConfig::default()
            },
        );
        provider.models.insert(
            "gpt-5.6-sol".to_string(),
            ProviderModelConfig {
                prompt_cache_strategy: PromptCacheStrategy::ImplicitPrefix,
                ..ProviderModelConfig::default()
            },
        );
        provider.models.insert(
            "provider-gpt56-alias".to_string(),
            ProviderModelConfig {
                prompt_cache_strategy: PromptCacheStrategy::ExplicitContentBoundaries,
                ..ProviderModelConfig::default()
            },
        );
        provider.models.insert(
            "codex-proxy-gpt56-alias".to_string(),
            ProviderModelConfig {
                prompt_cache_strategy: PromptCacheStrategy::ImplicitContentBoundaries,
                ..ProviderModelConfig::default()
            },
        );
        provider.models.insert(
            "codex-proxy-message-gpt56-alias".to_string(),
            ProviderModelConfig {
                prompt_cache_strategy: PromptCacheStrategy::ImplicitMessageBoundaries,
                ..ProviderModelConfig::default()
            },
        );
        provider.models.insert(
            "disabled-gpt56-alias".to_string(),
            ProviderModelConfig {
                prompt_cache_strategy: PromptCacheStrategy::Disabled,
                ..ProviderModelConfig::default()
            },
        );

        let auto = ProtocolClient::new(
            &provider,
            "auto-gpt-5.6-sol".to_string(),
            None,
            &LlmConfig::default(),
        )
        .unwrap()
        .request_for_model("auto-gpt-5.6-sol", std::slice::from_ref(&context), &[]);
        assert!(auto.get("prompt_cache_options").is_none());
        assert_eq!(
            auto.pointer("/input/0/content"),
            Some(&json!(
                "stable-system-and-protocol (inbox (observation one)) dynamic-tail"
            ))
        );

        let implicit = ProtocolClient::new(
            &provider,
            "gpt-5.6-sol".to_string(),
            None,
            &LlmConfig::default(),
        )
        .unwrap()
        .request_for_model("gpt-5.6-sol", std::slice::from_ref(&context), &[]);
        assert!(implicit.get("prompt_cache_options").is_none());
        assert_eq!(
            implicit.pointer("/input/0/content"),
            Some(&json!(
                "stable-system-and-protocol (inbox (observation one)) dynamic-tail"
            ))
        );

        let explicit = ProtocolClient::new(
            &provider,
            "provider-gpt56-alias".to_string(),
            None,
            &LlmConfig::default(),
        )
        .unwrap()
        .request_for_model("provider-gpt56-alias", std::slice::from_ref(&context), &[]);
        assert_eq!(
            explicit.get("prompt_cache_options"),
            Some(&json!({"mode": "explicit", "ttl": "30m"}))
        );
        assert!(explicit
            .pointer("/input/0/content/0/prompt_cache_breakpoint")
            .is_some());

        let implicit_content_boundaries = ProtocolClient::new(
            &provider,
            "codex-proxy-gpt56-alias".to_string(),
            None,
            &LlmConfig::default(),
        )
        .unwrap()
        .request_for_model(
            "codex-proxy-gpt56-alias",
            std::slice::from_ref(&context),
            &[],
        );
        assert!(implicit_content_boundaries
            .get("prompt_cache_options")
            .is_none());
        assert!(implicit_content_boundaries
            .pointer("/input/0/content")
            .unwrap()
            .is_array());
        assert!(implicit_content_boundaries["input"][0]["content"]
            .as_array()
            .unwrap()
            .iter()
            .all(|block| block.get("prompt_cache_breakpoint").is_none()));

        let implicit_message_boundaries = ProtocolClient::new(
            &provider,
            "codex-proxy-message-gpt56-alias".to_string(),
            None,
            &LlmConfig::default(),
        )
        .unwrap()
        .request_for_model(
            "codex-proxy-message-gpt56-alias",
            std::slice::from_ref(&context),
            &[],
        );
        assert!(implicit_message_boundaries
            .get("prompt_cache_options")
            .is_none());
        assert!(
            implicit_message_boundaries["input"]
                .as_array()
                .unwrap()
                .len()
                > 1
        );
        assert!(implicit_message_boundaries["input"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["role"] == "user" && item["content"].is_string()));

        let codex = ProtocolClient::new_with_adapter(
            &provider,
            "openai-codex",
            "provider-gpt56-alias".to_string(),
            None,
            &LlmConfig::default(),
        )
        .unwrap()
        .request_for_model("provider-gpt56-alias", &[context], &[]);
        assert!(codex.get("prompt_cache_options").is_none());
        assert!(codex.pointer("/input/0/content").unwrap().is_array());
        assert!(codex["input"][0]["content"]
            .as_array()
            .unwrap()
            .iter()
            .all(|block| block.get("prompt_cache_breakpoint").is_none()));

        let disabled_context = incremental_context_message("disabled", &["one"]);
        let disabled_codex = ProtocolClient::new_with_adapter(
            &provider,
            "openai-codex",
            "disabled-gpt56-alias".to_string(),
            None,
            &LlmConfig::default(),
        )
        .unwrap()
        .request_for_model("disabled-gpt56-alias", &[disabled_context], &[]);
        assert!(disabled_codex
            .pointer("/input/0/content")
            .unwrap()
            .is_string());
    }

    #[test]
    fn providers_without_explicit_breakpoint_support_receive_canonical_text() {
        let message = segmented_text_message(
            "user",
            SegmentedModelText {
                parts: vec![
                    ModelTextPart {
                        text: "alpha".to_string(),
                        cache_boundary_after: true,
                        cache_boundary_candidate_after: false,
                    },
                    ModelTextPart {
                        text: " beta".to_string(),
                        cache_boundary_after: false,
                        cache_boundary_candidate_after: false,
                    },
                ],
                prompt_cache_key: Some("ignored".to_string()),
            },
        )
        .unwrap();

        let chat = build_request(
            ModelProtocol::OpenaiChat,
            "test",
            None,
            None,
            std::slice::from_ref(&message),
            &[],
        );
        assert_eq!(
            chat.pointer("/messages/0/content"),
            Some(&json!("alpha beta"))
        );
        assert!(chat.pointer("/messages/0/name").is_none());

        let anthropic = build_request(
            ModelProtocol::AnthropicMessages,
            "test",
            None,
            None,
            std::slice::from_ref(&message),
            &[],
        );
        assert_eq!(
            anthropic.pointer("/messages/0/content/0/text"),
            Some(&json!("alpha beta"))
        );

        let gemini = build_request(
            ModelProtocol::GeminiContent,
            "test",
            None,
            None,
            &[message],
            &[],
        );
        assert_eq!(
            gemini.pointer("/contents/0/parts/0/text"),
            Some(&json!("alpha beta"))
        );
    }

    #[test]
    fn responses_usage_preserves_cache_reads_and_cache_writes() {
        let mut accumulator = StreamAccumulator::default();
        let (stream, _receiver) = tokio::sync::mpsc::unbounded_channel();
        accumulator.apply_openai_responses_usage(
            &json!({
                "input_tokens": 100,
                "input_tokens_details": {
                    "cached_tokens": 70,
                    "cache_write_tokens": 20
                },
                "output_tokens": 5,
                "total_tokens": 105
            }),
            &stream,
        );

        assert_eq!(accumulator.usage.input_tokens, Some(100));
        assert_eq!(accumulator.usage.uncached_input_tokens, Some(10));
        assert_eq!(accumulator.usage.cached_input_tokens, Some(70));
        assert_eq!(accumulator.usage.cache_write_input_tokens, Some(20));
        assert_eq!(accumulator.usage.output_tokens, Some(5));
    }

    #[test]
    fn codex_request_matches_subscription_backend_contract() {
        let request = json!({
            "model": "codex-model-alpha",
            "input": [
                {"role": "system", "content": "system"},
                {"role": "user", "content": [
                    {
                        "type": "input_text",
                        "text": "hello",
                        "prompt_cache_breakpoint": {"mode": "explicit"}
                    }
                ]}
            ],
            "tools": [{"type": "function", "name": "probe"}],
            "max_output_tokens": 64,
            "temperature": 0.5,
            "truncation": "auto",
            "prompt_cache_options": {"mode": "explicit", "ttl": "30m"},
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
        assert_eq!(
            adapted.pointer("/input/1/content/0/text"),
            Some(&json!("hello"))
        );
        assert!(adapted
            .pointer("/input/1/content/0/prompt_cache_breakpoint")
            .is_none());
        for rejected in [
            "max_output_tokens",
            "temperature",
            "truncation",
            "prompt_cache_options",
            "user",
        ] {
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
    async fn claude_subscription_probe_uses_agent_request_class_without_context() {
        let app = Router::new().route(
            "/messages",
            post(
                |headers: axum::http::HeaderMap, Json(body): Json<Value>| async move {
                    assert_eq!(body.get("model"), Some(&json!("claude-sonnet-test")));
                    assert_eq!(body.get("max_tokens"), Some(&json!(64)));
                    assert_eq!(body.get("tools"), None);
                    assert!(body
                        .pointer("/system/0/text")
                        .and_then(Value::as_str)
                        .is_some_and(|text| text
                            .starts_with("x-anthropic-billing-header: cc_version=2.1.258.")
                            && text.contains("cch=")
                            && !text.contains("cch=00000;")));
                    assert_eq!(
                        body.pointer("/system/1/text").and_then(Value::as_str),
                        Some("You are Claude Code, Anthropic's official CLI for Claude.")
                    );
                    assert_eq!(
                        body.pointer("/messages/0/content/1/text")
                            .and_then(Value::as_str),
                        Some("Reply with the plain text MORPHZ_OK.")
                    );
                    assert!(headers
                        .get("anthropic-beta")
                        .and_then(|value| value.to_str().ok())
                        .is_some_and(|value| {
                            value.contains("oauth-2025-04-20")
                                && value.contains("mid-conversation-system-2026-04-07")
                                && !value.contains("advanced-tool-use-2025-11-20")
                        }));
                    assert!(headers.get("x-claude-code-session-id").is_some());
                    assert!(headers.get("x-client-request-id").is_some());
                    Json(json!({
                        "id": "msg-health",
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "text", "text": "MORPHZ_OK"}],
                        "stop_reason": "end_turn",
                        "usage": {"input_tokens": 8, "output_tokens": 2}
                    }))
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = ProtocolClient::new_with_adapter(
            &ProviderConfig {
                protocol: ModelProtocol::AnthropicMessages,
                base_url: format!("http://{address}"),
                headers: BTreeMap::from([
                    (
                        "user-agent".to_string(),
                        "claude-cli/2.1.258 (external, cli)".to_string(),
                    ),
                    (
                        "x-stainless-package-version".to_string(),
                        "0.112.1".to_string(),
                    ),
                ]),
                ..ProviderConfig::default()
            },
            "claude-code",
            "claude-sonnet-test".to_string(),
            None,
            &LlmConfig::default(),
        )
        .unwrap();

        client.probe_health().await.unwrap();
    }

    #[tokio::test]
    async fn claude_subscription_stream_uses_mcp_alias_and_restores_runtime_tool_name() {
        let app = Router::new().route(
            "/messages",
            post(|headers: axum::http::HeaderMap, Json(body): Json<Value>| async move {
                let upstream_name = body["tools"][0]["name"].as_str().unwrap().to_string();
                assert!(upstream_name.starts_with("mcp__"));
                assert_ne!(upstream_name, "read");
                assert!(headers
                    .get("anthropic-beta")
                    .and_then(|value| value.to_str().ok())
                    .is_some_and(|value| value.contains("advanced-tool-use-2025-11-20")));
                let body = format!(
                    concat!(
                        "event: message_start\ndata: {{\"type\":\"message_start\",\"message\":{{\"usage\":{{\"input_tokens\":4}}}}}}\n\n",
                        "event: content_block_start\ndata: {{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{{\"type\":\"tool_use\",\"id\":\"c1\",\"name\":{0:?},\"input\":{{}}}}}}\n\n",
                        "event: content_block_delta\ndata: {{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{{\"type\":\"input_json_delta\",\"partial_json\":\"{{\\\"path\\\":\\\"README.md\\\"}}\"}}}}\n\n",
                        "event: content_block_stop\ndata: {{\"type\":\"content_block_stop\",\"index\":0}}\n\n",
                        "event: message_delta\ndata: {{\"type\":\"message_delta\",\"delta\":{{\"stop_reason\":\"tool_use\"}},\"usage\":{{\"output_tokens\":4}}}}\n\n",
                        "event: message_stop\ndata: {{\"type\":\"message_stop\"}}\n\n"
                    ),
                    upstream_name
                );
                AxumResponse::builder()
                    .header("content-type", "text/event-stream")
                    .body(Body::from(body))
                    .unwrap()
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = ProtocolClient::new_with_adapter_and_context(
            &ProviderConfig {
                protocol: ModelProtocol::AnthropicMessages,
                base_url: format!("http://{address}"),
                ..ProviderConfig::default()
            },
            "claude-code",
            "claude-opus-5".to_string(),
            None,
            &LlmConfig::default(),
            BTreeMap::from([
                ("device_id".to_string(), "a".repeat(64)),
                (
                    "account_uuid".to_string(),
                    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
                ),
                ("session_id".to_string(), "session-1".to_string()),
            ]),
        )
        .unwrap();
        let tool = ToolDefinition {
            name: "read".to_string(),
            description: "Read a file".to_string(),
            parameters: json!({"type": "object"}),
        };
        let (stream, mut events) = tokio::sync::mpsc::unbounded_channel();
        let response = client
            .create_completion_measured_stream(
                vec![Message {
                    role: "user".to_string(),
                    content: "Read README.md".to_string(),
                    name: None,
                    tool_call_id: None,
                    tool_calls: None,
                }],
                vec![tool],
                None,
                stream,
            )
            .await
            .unwrap();

        assert_eq!(response.tool_calls[0].func_name, "read");
        assert!(std::iter::from_fn(|| events.try_recv().ok()).any(|event| {
            matches!(event, ModelStreamEvent::ToolCallStarted { name, .. } if name == "read")
        }));
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
    async fn responses_reasoning_only_output_limit_preserves_native_continuation() {
        let requests = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&requests);
        let app = Router::new().route(
            "/responses",
            post(move || {
                let observed = Arc::clone(&observed);
                async move {
                    observed.fetch_add(1, Ordering::SeqCst);
                    sse(concat!(
                        "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"reasoning\",\"id\":\"reasoning-output-limit\"}}\n\n",
                        "data: {\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\"reasoning reached the physical output boundary\"}\n\n",
                        "data: {\"type\":\"response.reasoning_summary_text.done\"}\n\n",
                        "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"reasoning\",\"id\":\"reasoning-output-limit\",\"encrypted_content\":\"opaque-output-limit\"}}\n\n",
                        "data: {\"type\":\"response.incomplete\",\"response\":{\"error\":null,\"incomplete_details\":{\"reason\":\"max_output_tokens\"},\"output\":[{\"type\":\"reasoning\",\"id\":\"reasoning-output-limit\",\"encrypted_content\":\"opaque-output-limit\"}],\"usage\":{\"input_tokens\":10,\"output_tokens\":4096,\"total_tokens\":4106,\"output_tokens_details\":{\"reasoning_tokens\":4096}}}}\n\n"
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
        assert_eq!(failure.kind, ModelFailureKind::OutputLimit);
        assert!(!failure.kind.uses_provider_recovery());
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        let events = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
        assert!(events.iter().any(|event| matches!(
            event,
            ModelStreamEvent::ProviderContinuation {
                continuation: ProviderContinuation::OpenaiResponses { reasoning_items }
            } if reasoning_items.iter().any(|item| {
                item["id"] == "reasoning-output-limit"
                    && item["encrypted_content"] == "opaque-output-limit"
            })
        )));
        assert!(!events.iter().any(|event| matches!(
            event,
            ModelStreamEvent::Failed { message }
                if message.contains("reasoning reached the physical output boundary")
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            ModelStreamEvent::Incomplete { reason }
                if reason == "max_output_tokens"
        )));
    }

    #[tokio::test]
    async fn responses_reasoning_done_before_missing_terminal_continues_without_provider_recovery()
    {
        let requests = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&requests);
        let app = Router::new().route(
            "/responses",
            post(move || {
                let observed = Arc::clone(&observed);
                async move {
                    observed.fetch_add(1, Ordering::SeqCst);
                    sse(concat!(
                        "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"reasoning\",\"id\":\"reasoning-recovered\"}}\n\n",
                        "data: {\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\"completed reasoning progress\"}\n\n",
                        "data: {\"type\":\"response.reasoning_summary_text.done\"}\n\n",
                        "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"reasoning\",\"id\":\"reasoning-recovered\",\"encrypted_content\":\"opaque-recovered\"}}\n\n",
                        "event: error\n",
                        "data: {\"type\":\"error\",\"code\":\"internal_server_error\",\"message\":\"upstream stream closed before a terminal event (last event: response.output_item.done)\",\"sequence_number\":0}\n\n"
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
                item["id"] == "reasoning-recovered"
                    && item["encrypted_content"] == "opaque-recovered"
            })
        )));
        assert!(!events.iter().any(|event| matches!(
            event,
            ModelStreamEvent::Failed { message }
                if message.contains("internal_server_error")
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
