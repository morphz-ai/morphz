//! Provider authentication adapters and OAuth lifecycle management.
//!
//! This module deliberately stops at the authentication boundary. Protocol
//! request/response normalization remains in the internal `ProtocolClient`, while
//! OAuth browser/device flows, refresh fencing and request authorization are
//! owned here. Token material is stored only through [`SecretStore`].

use crate::config::AuthAccountConfig;
use crate::memory::{ProviderAccountStateStore, ProviderAccountStatus};
use crate::secret_store::{SecretScopeKind, SecretStore, SecretUseContext};
use base64::Engine;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::collections::{BTreeMap, HashMap};
use std::process::Stdio;
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

const TOKEN_REFRESH_SKEW_SECS: i64 = 300;
const REFRESH_LEASE_SECS: i64 = 45;
const REFRESH_WAIT_POLL_MILLIS: u64 = 125;
const CODEX_ADAPTER_ID: &str = "codex-oauth";
const CODEX_DEVICE_ADAPTER_ID: &str = "codex-device-oauth";
const KIMI_ADAPTER_ID: &str = "kimi-oauth";
const XAI_ADAPTER_ID: &str = "xai-oauth";
const CLAUDE_ADAPTER_ID: &str = "claude-oauth";
const ANTIGRAVITY_ADAPTER_ID: &str = "antigravity-oauth";
const XAI_GROK_CLIENT_VERSION: &str = "0.2.93";
const CODEX_ACCOUNT_PROBE_TIMEOUT_SECS: u64 = 20;

/// A normalized ChatGPT subscription window returned by the official Codex
/// app-server protocol. `resets_at` is a Unix timestamp in seconds.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionUsageWindow {
    pub used_percent: i32,
    pub window_duration_mins: Option<i64>,
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionCreditsSnapshot {
    pub has_credits: bool,
    pub unlimited: bool,
    pub balance: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionSpendLimitSnapshot {
    pub limit: String,
    pub used: String,
    pub remaining_percent: i32,
    pub resets_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionRateLimitSnapshot {
    pub limit_id: Option<String>,
    pub limit_name: Option<String>,
    pub primary: Option<SubscriptionUsageWindow>,
    pub secondary: Option<SubscriptionUsageWindow>,
    pub credits: Option<SubscriptionCreditsSnapshot>,
    pub individual_limit: Option<SubscriptionSpendLimitSnapshot>,
    pub plan_type: Option<String>,
    pub rate_limit_reached_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionResetCredit {
    pub id: String,
    pub reset_type: String,
    pub status: String,
    pub granted_at: i64,
    pub expires_at: Option<i64>,
    pub title: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionResetCreditsSummary {
    pub available_count: i64,
    pub credits: Option<Vec<SubscriptionResetCredit>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionTokenUsageSummary {
    pub lifetime_tokens: Option<u64>,
    pub peak_daily_tokens: Option<u64>,
    pub longest_running_turn_sec: Option<u64>,
    pub current_streak_days: Option<u64>,
    pub longest_streak_days: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionDailyUsageBucket {
    pub start_date: String,
    pub tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionTokenUsage {
    pub summary: SubscriptionTokenUsageSummary,
    pub daily_usage_buckets: Option<Vec<SubscriptionDailyUsageBucket>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SubscriptionAvailability {
    Available,
    Low,
    Exhausted,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSubscriptionUsage {
    pub account_id: String,
    pub provider_account_id: Option<String>,
    pub email: Option<String>,
    pub adapter_id: String,
    /// Logical model route currently selected by the Runtime. The auth layer
    /// leaves this unset; the Runtime fills it before exposing the snapshot.
    pub selected_model_alias: Option<String>,
    pub source: String,
    pub checked_at: DateTime<Utc>,
    pub availability: SubscriptionAvailability,
    pub rate_limits: SubscriptionRateLimitSnapshot,
    pub rate_limits_by_limit_id: Option<BTreeMap<String, SubscriptionRateLimitSnapshot>>,
    pub rate_limit_reset_credits: Option<SubscriptionResetCreditsSummary>,
    pub token_usage: SubscriptionTokenUsage,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRateLimitsResponse {
    rate_limits: SubscriptionRateLimitSnapshot,
    rate_limits_by_limit_id: Option<BTreeMap<String, SubscriptionRateLimitSnapshot>>,
    rate_limit_reset_credits: Option<SubscriptionResetCreditsSummary>,
}

fn subscription_availability(
    rate_limits: &SubscriptionRateLimitSnapshot,
    by_limit_id: Option<&BTreeMap<String, SubscriptionRateLimitSnapshot>>,
) -> SubscriptionAvailability {
    let snapshots = std::iter::once(rate_limits)
        .chain(by_limit_id.into_iter().flat_map(|limits| limits.values()));
    let mut observed = false;
    let mut highest = 0;
    for snapshot in snapshots {
        if snapshot.rate_limit_reached_type.is_some() {
            return SubscriptionAvailability::Exhausted;
        }
        for window in [snapshot.primary.as_ref(), snapshot.secondary.as_ref()]
            .into_iter()
            .flatten()
        {
            observed = true;
            highest = highest.max(window.used_percent);
        }
    }
    if !observed {
        SubscriptionAvailability::Unknown
    } else if highest >= 100 {
        SubscriptionAvailability::Exhausted
    } else if highest >= 80 {
        SubscriptionAvailability::Low
    } else {
        SubscriptionAvailability::Available
    }
}

fn oauth_adapters_compatible(configured: &str, actual: &str) -> bool {
    configured == actual
        || matches!(
            (configured, actual),
            (CODEX_ADAPTER_ID, CODEX_DEVICE_ADAPTER_ID)
                | (CODEX_DEVICE_ADAPTER_ID, CODEX_ADAPTER_ID)
        )
}

fn oauth_http_client() -> reqwest::Client {
    // Provider traffic already uses an explicit no-proxy client. Keep OAuth
    // on the same deterministic transport path: reqwest's macOS system-proxy
    // discovery can return a null SCDynamicStore in headless/service contexts
    // and panic while the Runtime is starting.
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("OAuth HTTP client configuration must be valid")
}

#[derive(Debug, Clone)]
struct LoopbackOAuthResult {
    code: Option<String>,
    error: Option<String>,
}

static LOOPBACK_OAUTH_RESULTS: OnceLock<RwLock<HashMap<String, LoopbackOAuthResult>>> =
    OnceLock::new();
static LOOPBACK_OAUTH_PORTS: OnceLock<RwLock<HashSet<u16>>> = OnceLock::new();
#[derive(Debug, Clone)]
struct PendingOAuthCallback {
    expires_at: DateTime<Utc>,
    login_id: Option<String>,
}

static PENDING_OAUTH_CALLBACKS: OnceLock<RwLock<HashMap<String, PendingOAuthCallback>>> =
    OnceLock::new();

fn loopback_oauth_results() -> &'static RwLock<HashMap<String, LoopbackOAuthResult>> {
    LOOPBACK_OAUTH_RESULTS.get_or_init(|| RwLock::new(HashMap::new()))
}

fn loopback_oauth_ports() -> &'static RwLock<HashSet<u16>> {
    LOOPBACK_OAUTH_PORTS.get_or_init(|| RwLock::new(HashSet::new()))
}

fn pending_oauth_callbacks() -> &'static RwLock<HashMap<String, PendingOAuthCallback>> {
    PENDING_OAUTH_CALLBACKS.get_or_init(|| RwLock::new(HashMap::new()))
}

pub(crate) fn register_oauth_callback(
    state: &str,
    expires_at: DateTime<Utc>,
) -> Result<(), String> {
    let now = Utc::now();
    let mut pending = pending_oauth_callbacks()
        .write()
        .map_err(|_| "OAuth callback state lock is poisoned".to_string())?;
    pending.retain(|_, callback| callback.expires_at > now);
    pending.insert(
        state.to_string(),
        PendingOAuthCallback {
            expires_at,
            login_id: None,
        },
    );
    Ok(())
}

fn bind_oauth_callback_login(state: &str, login_id: &str) -> Result<(), String> {
    let now = Utc::now();
    let mut pending = pending_oauth_callbacks()
        .write()
        .map_err(|_| "OAuth callback state lock is poisoned".to_string())?;
    pending.retain(|_, callback| callback.expires_at > now);
    let callback = pending
        .get_mut(state)
        .ok_or("OAuth callback state is unregistered or expired")?;
    callback.login_id = Some(login_id.to_string());
    Ok(())
}

/// Resolve a pasted or public browser callback to the short-lived in-memory
/// login context that created its state. The Dashboard's currently open dialog
/// is not authoritative: a callback can outlive a page refresh or UI change.
pub(crate) fn oauth_callback_login_id(state: &str) -> Result<String, String> {
    let state = state.trim();
    if state.is_empty() {
        return Err("OAuth callback is missing state".to_string());
    }
    let now = Utc::now();
    let mut pending = pending_oauth_callbacks()
        .write()
        .map_err(|_| "OAuth callback state lock is poisoned".to_string())?;
    pending.retain(|_, callback| callback.expires_at > now);
    pending
        .get(state)
        .and_then(|callback| callback.login_id.clone())
        .ok_or_else(|| {
            "this callback does not belong to a pending login; restart login and use the callback URL from the new page"
                .to_string()
        })
}

fn state_fingerprint(state: &str) -> String {
    let suffix = state
        .char_indices()
        .rev()
        .nth(7)
        .map(|(index, _)| &state[index..])
        .unwrap_or(state);
    format!("…{suffix}")
}

pub(crate) fn parse_authorization_response(response: &str) -> Result<(String, String), String> {
    let response = response.trim();
    if response.is_empty() {
        return Err("OAuth authorization callback must not be empty".to_string());
    }
    let query = reqwest::Url::parse(response)
        .ok()
        .and_then(|url| url.query().map(str::to_string))
        .or_else(|| response.strip_prefix('?').map(str::to_string))
        .unwrap_or_else(|| response.to_string());
    let pairs = reqwest::Url::parse(&format!("http://localhost/?{query}"))
        .map_err(|error| format!("invalid OAuth authorization callback format: {error}"))?
        .query_pairs()
        .into_owned()
        .collect::<BTreeMap<_, _>>();
    if let Some(error) = pairs.get("error") {
        let description = pairs
            .get("error_description")
            .map(String::as_str)
            .unwrap_or(error);
        return Err(format!("OAuth authorization failed: {description}"));
    }
    let code = pairs
        .get("code")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .ok_or("callback URL has no code; copy the complete URL from the browser address bar, not the error page text")?;
    let state = pairs
        .get("state")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .ok_or("callback URL has no state; copy the complete URL containing code and state from the address bar")?;
    Ok((code.to_string(), state.to_string()))
}

/// Deliver one browser authorization result to the Runtime that owns the
/// pending login. The opaque state is the only unauthenticated callback
/// capability; unknown and expired states are rejected without retaining any
/// attacker-supplied payload.
pub fn submit_oauth_callback(
    state: &str,
    code: Option<String>,
    error: Option<String>,
) -> Result<(), String> {
    let state = state.trim();
    if state.is_empty() {
        return Err("OAuth callback is missing state".to_string());
    }
    let mut results = loopback_oauth_results()
        .write()
        .map_err(|_| "OAuth callback result lock is poisoned".to_string())?;
    let now = Utc::now();
    let mut pending = pending_oauth_callbacks()
        .write()
        .map_err(|_| "OAuth callback state lock is poisoned".to_string())?;
    pending.retain(|_, callback| callback.expires_at > now);
    if pending.remove(state).is_none() {
        return Err(
            "OAuth callback state does not exist, has expired, or does not belong to the current Runtime"
                .to_string(),
        );
    }
    results.insert(state.to_string(), LoopbackOAuthResult { code, error });
    Ok(())
}

fn discard_oauth_callback(state: &str) -> Result<(), String> {
    pending_oauth_callbacks()
        .write()
        .map_err(|_| "OAuth callback state lock is poisoned".to_string())?
        .remove(state);
    loopback_oauth_results()
        .write()
        .map_err(|_| "OAuth callback result lock is poisoned".to_string())?
        .remove(state);
    Ok(())
}

async fn ensure_loopback_oauth_listener(
    port: u16,
    callback_path: &'static str,
) -> Result<(), String> {
    if loopback_oauth_ports()
        .read()
        .map_err(|_| "OAuth callback listener state lock is poisoned".to_string())?
        .contains(&port)
    {
        return Ok(());
    }
    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|error| {
            format!("failed to listen for OAuth callback at http://127.0.0.1:{port}{callback_path}: {error}")
        })?;
    loopback_oauth_ports()
        .write()
        .map_err(|_| "OAuth callback listener state lock is poisoned".to_string())?
        .insert(port);
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut buffer = vec![0_u8; 16 * 1024];
                let read = socket.read(&mut buffer).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]);
                let target = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/");
                let parsed = reqwest::Url::parse(&format!("http://127.0.0.1:{port}{target}"));
                let mut state = None;
                let mut code = None;
                let mut error = None;
                if let Ok(url) = parsed {
                    if url.path() == callback_path {
                        for (key, value) in url.query_pairs() {
                            match key.as_ref() {
                                "state" => state = Some(value.into_owned()),
                                "code" => code = Some(value.into_owned()),
                                "error" => error = Some(value.into_owned()),
                                "error_description" if error.is_none() => {
                                    error = Some(value.into_owned())
                                }
                                _ => {}
                            }
                        }
                    } else {
                        error = Some("OAuth callback path mismatch".to_string());
                    }
                } else {
                    error = Some("invalid OAuth callback URL".to_string());
                }
                let success = state.is_some() && code.is_some() && error.is_none();
                let submitted = state
                    .as_deref()
                    .is_some_and(|state| submit_oauth_callback(state, code, error).is_ok());
                let success = success && submitted;
                let (status, title, detail) = if success {
                    (
                        "200 OK",
                        "Morphz login complete",
                        "The credential was delivered securely to Morphz. You may close this page.",
                    )
                } else {
                    (
                        "400 Bad Request",
                        "Morphz login failed",
                        "The authorization result is invalid. Return to the Dashboard and retry.",
                    )
                };
                let body = format!(
                    "<!doctype html><meta charset=\"utf-8\"><title>{title}</title><style>body{{font:16px system-ui;margin:10vh auto;max-width:34rem;padding:2rem;color:#20222a}}h1{{font-size:1.5rem}}</style><h1>{title}</h1><p>{detail}</p>"
                );
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
        if let Ok(mut ports) = loopback_oauth_ports().write() {
            ports.remove(&port);
        }
    });
    Ok(())
}

fn take_loopback_oauth_result(state: &str) -> Result<Option<LoopbackOAuthResult>, String> {
    let result = loopback_oauth_results()
        .write()
        .map_err(|_| "OAuth callback result lock is poisoned".to_string())?
        .remove(state);
    if result.is_some() {
        pending_oauth_callbacks()
            .write()
            .map_err(|_| "OAuth callback state lock is poisoned".to_string())?
            .remove(state);
    }
    Ok(result)
}

/// Encrypted-at-rest OAuth payload. This type intentionally has no `Debug`
/// implementation so accidental structured logging cannot reveal tokens.
#[derive(Clone, Serialize, Deserialize)]
pub struct OAuthTokenSet {
    pub adapter_id: String,
    pub adapter_version: String,
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_type: Option<String>,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(default)]
    pub metadata: BTreeMap<String, String>,
}

impl OAuthTokenSet {
    fn needs_refresh(&self, now: DateTime<Utc>) -> bool {
        self.expires_at.is_some_and(|expires| {
            expires <= now + ChronoDuration::seconds(TOKEN_REFRESH_SKEW_SECS)
        })
    }

    fn public_metadata(&self, account_id: &str) -> OAuthAccountMetadata {
        OAuthAccountMetadata {
            account_id: account_id.to_string(),
            adapter_id: self.adapter_id.clone(),
            adapter_version: self.adapter_version.clone(),
            subject: self.subject.clone(),
            provider_account_id: self.account_id.clone(),
            email: self.email.clone(),
            expires_at: self.expires_at,
            scopes: self.scopes.clone(),
        }
    }
}

/// Process-memory-only authorization material used to build one physical
/// client. It is neither serializable nor debuggable.
pub struct RequestAuthorization {
    pub bearer_token: String,
    pub headers: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OAuthFlowKind {
    AuthorizationCodePkce,
    DeviceCode,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OAuthCallbackMode {
    /// No redirect callback is used (for example RFC 8628 device code).
    None,
    /// The provider redirects the browser to a loopback address registered to
    /// a desktop/public client. It only completes automatically when browser
    /// and Runtime share that loopback network namespace (or a tunnel).
    Loopback,
    /// The provider redirects to the Runtime's public HTTP callback endpoint.
    /// This requires a web OAuth client that has the exact URI registered.
    Runtime,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthAdapterStability {
    Stable,
    Compatibility,
    Experimental,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthAdapterDescriptor {
    pub id: String,
    pub version: String,
    pub flow: OAuthFlowKind,
    pub callback_mode: OAuthCallbackMode,
    pub stability: AuthAdapterStability,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_reference: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_verified_on: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OAuthLoginChallenge {
    pub login_id: String,
    pub account_id: String,
    pub adapter_id: String,
    pub flow: OAuthFlowKind,
    pub callback_mode: OAuthCallbackMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub callback_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub redirect_uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authorization_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_uri_complete: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_code: Option<String>,
    pub expires_at: DateTime<Utc>,
    pub poll_interval_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OAuthLoginCompletion {
    AuthorizationCode {
        code: String,
        state: String,
    },
    /// Complete a browser authorization flow by pasting the callback URL (or
    /// its query string) back into a remote Dashboard. Runtime still validates
    /// the opaque state owned by the pending login.
    AuthorizationResponse {
        response: String,
    },
    Poll,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OAuthAccountMetadata {
    pub account_id: String,
    pub adapter_id: String,
    pub adapter_version: String,
    pub subject: Option<String>,
    pub provider_account_id: Option<String>,
    pub email: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub scopes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum OAuthLoginProgress {
    Pending { retry_after_secs: u64 },
    Complete { account: OAuthAccountMetadata },
}

#[derive(Clone)]
struct PendingLoginEnvelope {
    account_id: String,
    adapter_id: String,
    expires_at: DateTime<Utc>,
    callback_state: Option<String>,
    state: Value,
}

pub struct AdapterLoginStart {
    pub flow: OAuthFlowKind,
    pub callback_mode: OAuthCallbackMode,
    pub redirect_uri: Option<String>,
    pub authorization_url: Option<String>,
    pub verification_uri: Option<String>,
    pub verification_uri_complete: Option<String>,
    pub user_code: Option<String>,
    pub expires_at: DateTime<Utc>,
    pub poll_interval_secs: u64,
    pub state: Value,
}

pub enum AdapterLoginResult {
    Pending { retry_after_secs: u64, state: Value },
    Complete(Box<OAuthTokenSet>),
}

#[async_trait::async_trait]
pub trait AuthAdapter: Send + Sync {
    fn id(&self) -> &'static str;
    fn version(&self) -> &'static str;
    fn flow(&self) -> OAuthFlowKind;
    fn callback_mode(&self) -> OAuthCallbackMode {
        match self.flow() {
            OAuthFlowKind::AuthorizationCodePkce => OAuthCallbackMode::Loopback,
            OAuthFlowKind::DeviceCode => OAuthCallbackMode::None,
        }
    }
    fn stability(&self) -> AuthAdapterStability {
        AuthAdapterStability::Experimental
    }
    fn upstream_reference(&self) -> Option<&'static str> {
        None
    }
    fn last_verified_on(&self) -> Option<&'static str> {
        None
    }
    async fn start_login(&self) -> Result<AdapterLoginStart, String>;
    async fn continue_login(
        &self,
        state: &Value,
        completion: OAuthLoginCompletion,
    ) -> Result<AdapterLoginResult, String>;
    async fn refresh(&self, current: &OAuthTokenSet) -> Result<OAuthTokenSet, String>;
    fn materialize(&self, token: &OAuthTokenSet) -> Result<RequestAuthorization, String>;
    /// Optional authenticated account observability. Most Provider OAuth
    /// adapters do not expose subscription data; Codex implements this through
    /// the official app-server protocol using externally managed tokens.
    async fn subscription_usage(
        &self,
        _token: &OAuthTokenSet,
    ) -> Result<(CodexRateLimitsResponse, SubscriptionTokenUsage), String> {
        Err(format!(
            "Auth Adapter '{}' does not expose subscription usage",
            self.id()
        ))
    }
}

struct CodexAppServerProbe {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    state_dir: std::path::PathBuf,
}

impl CodexAppServerProbe {
    async fn start() -> Result<Self, String> {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("System clock cannot create Codex probe directory: {error}"))?
            .as_nanos();
        let state_dir = std::env::temp_dir().join(format!(
            "morphz-codex-account-probe-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&state_dir).map_err(|error| {
            format!(
                "Cannot create isolated Codex account probe directory '{}': {error}",
                state_dir.display()
            )
        })?;
        let executable = std::env::var("MORPHZ_CODEX_APP_SERVER_BIN")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "codex".to_string());
        let mut child = Command::new(&executable)
            .arg("app-server")
            .arg("--listen")
            .arg("stdio://")
            .env("CODEX_HOME", &state_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| {
                let _ = std::fs::remove_dir_all(&state_dir);
                format!(
                    "Cannot start official Codex app-server using '{executable}': {error}; install Codex CLI or set MORPHZ_CODEX_APP_SERVER_BIN"
                )
            })?;
        let stdin = child
            .stdin
            .take()
            .ok_or("Codex app-server did not expose stdin")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Codex app-server did not expose stdout")?;
        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            state_dir,
        })
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.write(json_rpc_message(method, None, params)).await
    }

    async fn request(&mut self, id: u64, method: &str, params: Value) -> Result<Value, String> {
        self.write(json_rpc_message(method, Some(id), params))
            .await?;
        let mut line = String::new();
        loop {
            line.clear();
            let read = self
                .stdout
                .read_line(&mut line)
                .await
                .map_err(|error| format!("Cannot read Codex app-server response: {error}"))?;
            if read == 0 {
                return Err("Codex app-server closed before returning account usage".to_string());
            }
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if message.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                return Err(format!(
                    "Codex app-server method '{method}' failed: {error}"
                ));
            }
            return message
                .get("result")
                .cloned()
                .ok_or_else(|| format!("Codex app-server method '{method}' returned no result"));
        }
    }

    async fn write(&mut self, message: Value) -> Result<(), String> {
        let mut encoded = serde_json::to_vec(&message)
            .map_err(|error| format!("Cannot encode Codex app-server request: {error}"))?;
        encoded.push(b'\n');
        self.stdin
            .write_all(&encoded)
            .await
            .map_err(|error| format!("Cannot write Codex app-server request: {error}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|error| format!("Cannot flush Codex app-server request: {error}"))
    }

    async fn finish(mut self) {
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
        let _ = std::fs::remove_dir_all(&self.state_dir);
    }
}

impl Drop for CodexAppServerProbe {
    fn drop(&mut self) {
        // `timeout` may cancel the async probe before `finish` runs. Make both
        // the subprocess and its isolated credential directory best-effort
        // cleanup invariants rather than happy-path behavior.
        let _ = self.child.start_kill();
        let _ = std::fs::remove_dir_all(&self.state_dir);
    }
}

fn json_rpc_message(method: &str, id: Option<u64>, params: Value) -> Value {
    let mut message = serde_json::json!({ "method": method, "params": params });
    if let Some(id) = id {
        message["id"] = Value::from(id);
    }
    message
}

async fn inspect_codex_subscription_usage(
    token: &OAuthTokenSet,
) -> Result<(CodexRateLimitsResponse, SubscriptionTokenUsage), String> {
    let account_id = token
        .account_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or("Codex OAuth token has no ChatGPT Account ID")?;
    let run = async {
        let mut probe = CodexAppServerProbe::start().await?;
        let result = async {
            probe
                .request(
                    1,
                    "initialize",
                    serde_json::json!({
                        "clientInfo": { "name": "morphz", "version": env!("CARGO_PKG_VERSION") },
                        "capabilities": { "experimentalApi": true }
                    }),
                )
                .await?;
            probe.notify("initialized", serde_json::json!({})).await?;
            probe
                .request(
                    2,
                    "account/login/start",
                    serde_json::json!({
                        "type": "chatgptAuthTokens",
                        "accessToken": token.access_token,
                        "chatgptAccountId": account_id
                    }),
                )
                .await?;
            let rate_limits = probe
                .request(3, "account/rateLimits/read", serde_json::json!({}))
                .await
                .and_then(|value| {
                    serde_json::from_value::<CodexRateLimitsResponse>(value).map_err(|error| {
                        format!("Cannot decode Codex rate-limit response: {error}")
                    })
                })?;
            let token_usage = probe
                .request(4, "account/usage/read", serde_json::json!({}))
                .await
                .and_then(|value| {
                    serde_json::from_value::<SubscriptionTokenUsage>(value).map_err(|error| {
                        format!("Cannot decode Codex token-usage response: {error}")
                    })
                })?;
            Ok::<_, String>((rate_limits, token_usage))
        }
        .await;
        probe.finish().await;
        result
    };
    tokio::time::timeout(
        std::time::Duration::from_secs(CODEX_ACCOUNT_PROBE_TIMEOUT_SECS),
        run,
    )
    .await
    .map_err(|_| {
        format!("Codex account usage probe exceeded {CODEX_ACCOUNT_PROBE_TIMEOUT_SECS} seconds")
    })?
}

#[derive(Default)]
pub struct AuthAdapterRegistry {
    adapters: HashMap<String, Arc<dyn AuthAdapter>>,
}

impl AuthAdapterRegistry {
    pub fn builtins() -> Self {
        let mut registry = Self::default();
        registry.register(Arc::new(CodexOAuthAdapter::default()));
        registry.register(Arc::new(CodexDeviceOAuthAdapter::default()));
        registry.register(Arc::new(KimiOAuthAdapter::default()));
        registry.register(Arc::new(XaiOAuthAdapter::default()));
        registry.register(Arc::new(ClaudeOAuthAdapter::default()));
        registry.register(Arc::new(AntigravityOAuthAdapter::default()));
        registry
    }

    pub fn register(&mut self, adapter: Arc<dyn AuthAdapter>) {
        self.adapters.insert(adapter.id().to_string(), adapter);
    }

    fn get(&self, id: &str) -> Result<Arc<dyn AuthAdapter>, String> {
        self.adapters
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Auth Adapter '{id}' is not registered"))
    }

    pub fn descriptors(&self) -> Vec<AuthAdapterDescriptor> {
        let mut descriptors = self
            .adapters
            .values()
            .map(|adapter| AuthAdapterDescriptor {
                id: adapter.id().to_string(),
                version: adapter.version().to_string(),
                flow: adapter.flow(),
                callback_mode: adapter.callback_mode(),
                stability: adapter.stability(),
                upstream_reference: adapter.upstream_reference().map(str::to_string),
                last_verified_on: adapter.last_verified_on().map(str::to_string),
            })
            .collect::<Vec<_>>();
        descriptors.sort_by(|left, right| left.id.cmp(&right.id));
        descriptors
    }
}

/// Runtime-wide OAuth authority. One manager owns adapters and Secret Store;
/// every request still carries an immutable account binding selected by the
/// router before authorization is materialized.
pub struct ProviderAuthManager {
    accounts: RwLock<BTreeMap<String, AuthAccountConfig>>,
    transient_accounts: RwLock<HashSet<String>>,
    pending_logins: RwLock<HashMap<String, PendingLoginEnvelope>>,
    secret_store: Arc<SecretStore>,
    account_store: Arc<dyn ProviderAccountStateStore>,
    adapters: AuthAdapterRegistry,
}

impl ProviderAuthManager {
    pub fn new(
        accounts: BTreeMap<String, AuthAccountConfig>,
        secret_store: Arc<SecretStore>,
        account_store: Arc<dyn ProviderAccountStateStore>,
    ) -> Self {
        Self::new_with_registry(
            accounts,
            secret_store,
            account_store,
            AuthAdapterRegistry::builtins(),
        )
    }

    pub fn new_with_registry(
        accounts: BTreeMap<String, AuthAccountConfig>,
        secret_store: Arc<SecretStore>,
        account_store: Arc<dyn ProviderAccountStateStore>,
        adapters: AuthAdapterRegistry,
    ) -> Self {
        Self {
            accounts: RwLock::new(accounts),
            transient_accounts: RwLock::new(HashSet::new()),
            pending_logins: RwLock::new(HashMap::new()),
            secret_store,
            account_store,
            adapters,
        }
    }

    pub fn account(&self, account_id: &str) -> Option<AuthAccountConfig> {
        self.accounts.read().ok()?.get(account_id).cloned()
    }

    /// Resolve a Runtime-managed static credential through the same Secret
    /// Store used by OAuth accounts. Unmanaged aliases retain the Secret
    /// Store's bootstrap compatibility with process environment variables.
    pub(crate) fn materialize_static_credential(
        &self,
        alias: &str,
    ) -> Result<Option<String>, String> {
        self.secret_store
            .resolve(alias, SecretUseContext::default())
    }

    /// Make a newly persisted OAuth account available to the current process.
    /// The Runtime publishes the matching Provider and Model Route through the
    /// same control-plane mutation before the login flow is started.
    pub fn register_account(
        &self,
        account_id: &str,
        account: AuthAccountConfig,
    ) -> Result<(), String> {
        self.accounts
            .write()
            .map_err(|_| "OAuth Auth Account registry lock poisoned".to_string())?
            .insert(account_id.to_string(), account);
        self.transient_accounts
            .write()
            .map_err(|_| "OAuth transient account registry lock poisoned".to_string())?
            .remove(account_id);
        Ok(())
    }

    /// Register an account only for the lifetime of one interactive login.
    /// It is deliberately absent from the Provider Catalog and durable account
    /// state until the provider has returned a verified identity.
    pub fn register_transient_account(
        &self,
        account_id: &str,
        account: AuthAccountConfig,
    ) -> Result<(), String> {
        self.accounts
            .write()
            .map_err(|_| "OAuth Auth Account registry lock poisoned".to_string())?
            .insert(account_id.to_string(), account);
        self.transient_accounts
            .write()
            .map_err(|_| "OAuth transient account registry lock poisoned".to_string())?
            .insert(account_id.to_string());
        Ok(())
    }

    pub fn discard_transient_account(&self, account_id: &str) -> Result<bool, String> {
        let transient = self
            .transient_accounts
            .write()
            .map_err(|_| "OAuth transient account registry lock poisoned".to_string())?
            .remove(account_id);
        if !transient {
            return Ok(false);
        }
        let account = self
            .accounts
            .write()
            .map_err(|_| "OAuth Auth Account registry lock poisoned".to_string())?
            .remove(account_id);
        if let Some(account) = account {
            let _ = self.secret_store.delete(&account.credential_ref);
        }
        Ok(true)
    }

    /// Remove an obsolete durable account from the live OAuth authority.
    /// New login attempts never reach this path because they are transient.
    pub fn remove_account(&self, account_id: &str) -> Result<bool, String> {
        self.transient_accounts
            .write()
            .map_err(|_| "OAuth transient account registry lock poisoned".to_string())?
            .remove(account_id);
        self.pending_logins
            .write()
            .map_err(|_| "OAuth pending login registry lock poisoned".to_string())?
            .retain(|_, pending| pending.account_id != account_id);
        let account = self
            .accounts
            .write()
            .map_err(|_| "OAuth Auth Account registry lock poisoned".to_string())?
            .remove(account_id);
        if let Some(account) = account {
            let _ = self.secret_store.delete(&account.credential_ref);
            return Ok(true);
        }
        Ok(false)
    }

    fn is_transient_account(&self, account_id: &str) -> bool {
        self.transient_accounts
            .read()
            .is_ok_and(|accounts| accounts.contains(account_id))
    }

    pub fn adapter_descriptors(&self) -> Vec<AuthAdapterDescriptor> {
        self.adapters.descriptors()
    }

    pub async fn start_login(&self, account_id: &str) -> Result<OAuthLoginChallenge, String> {
        self.start_login_with_adapter(account_id, None).await
    }

    /// Start an explicitly selected login delivery for an existing account.
    /// Only adapters with identical token/materialization semantics can be
    /// selected as alternatives; today that is Codex browser PKCE and Codex
    /// device authorization. The account configuration itself stays stable.
    pub async fn start_login_using(
        &self,
        account_id: &str,
        adapter_id: &str,
    ) -> Result<OAuthLoginChallenge, String> {
        self.start_login_with_adapter(account_id, Some(adapter_id))
            .await
    }

    async fn start_login_with_adapter(
        &self,
        account_id: &str,
        requested_adapter_id: Option<&str>,
    ) -> Result<OAuthLoginChallenge, String> {
        let account = self.oauth_account(account_id)?;
        validate_secret_alias(&account.credential_ref)?;
        let adapter_id = requested_adapter_id.unwrap_or(&account.auth_adapter);
        if !oauth_adapters_compatible(&account.auth_adapter, adapter_id) {
            return Err(format!(
                "Auth Account '{account_id}' uses '{}' and cannot switch to incompatible OAuth Adapter '{adapter_id}'",
                account.auth_adapter
            ));
        }
        let adapter = self.adapters.get(adapter_id)?;
        let started = adapter.start_login().await?;
        let callback_state = match started.callback_mode {
            OAuthCallbackMode::None => None,
            OAuthCallbackMode::Loopback | OAuthCallbackMode::Runtime => Some(
                started
                    .state
                    .get("state")
                    .and_then(Value::as_str)
                    .filter(|state| !state.trim().is_empty())
                    .ok_or("OAuth Adapter did not return an associable callback state")?
                    .to_string(),
            ),
        };
        let login_id = format!("MORPHZ_OAUTH_LOGIN_{}", random_hex(16)?);
        let pending = PendingLoginEnvelope {
            account_id: account_id.to_string(),
            adapter_id: adapter.id().to_string(),
            expires_at: started.expires_at,
            callback_state: callback_state.clone(),
            state: started.state,
        };
        self.pending_logins
            .write()
            .map_err(|_| "OAuth pending login registry lock poisoned".to_string())?
            .insert(login_id.clone(), pending);
        if let Some(callback_state) = callback_state.as_deref() {
            if let Err(error) = register_oauth_callback(callback_state, started.expires_at)
                .and_then(|()| bind_oauth_callback_login(callback_state, &login_id))
            {
                if let Ok(mut pending) = self.pending_logins.write() {
                    pending.remove(&login_id);
                }
                return Err(error);
            }
        }
        Ok(OAuthLoginChallenge {
            login_id,
            account_id: account_id.to_string(),
            adapter_id: adapter.id().to_string(),
            flow: started.flow,
            callback_mode: started.callback_mode,
            callback_state,
            redirect_uri: started.redirect_uri,
            authorization_url: started.authorization_url,
            verification_uri: started.verification_uri,
            verification_uri_complete: started.verification_uri_complete,
            user_code: started.user_code,
            expires_at: started.expires_at,
            poll_interval_secs: started.poll_interval_secs,
        })
    }

    pub async fn continue_login(
        &self,
        login_id: &str,
        completion: OAuthLoginCompletion,
    ) -> Result<OAuthLoginProgress, String> {
        let mut pending = self
            .pending_logins
            .read()
            .map_err(|_| "OAuth pending login registry lock poisoned".to_string())?
            .get(login_id)
            .cloned()
            .ok_or_else(|| format!("OAuth Login '{login_id}' does not exist or is complete"))?;
        if pending.expires_at <= Utc::now() {
            if let Ok(mut logins) = self.pending_logins.write() {
                logins.remove(login_id);
            }
            let _ = self.discard_transient_account(&pending.account_id);
            if let Some(state) = pending.callback_state.as_deref() {
                let _ = discard_oauth_callback(state);
            }
            return Err(format!("OAuth Login '{login_id}' has expired"));
        }
        let account = self.oauth_account(&pending.account_id)?;
        if !oauth_adapters_compatible(&account.auth_adapter, &pending.adapter_id) {
            return Err(format!(
                "Adapter '{}' for OAuth Login '{}' does not match the account's current configuration '{}'",
                pending.adapter_id, login_id, account.auth_adapter
            ));
        }
        let adapter = self.adapters.get(&pending.adapter_id)?;
        match adapter.continue_login(&pending.state, completion).await? {
            AdapterLoginResult::Pending {
                retry_after_secs,
                state,
            } => {
                pending.state = state;
                self.pending_logins
                    .write()
                    .map_err(|_| "OAuth pending login registry lock poisoned".to_string())?
                    .insert(login_id.to_string(), pending);
                Ok(OAuthLoginProgress::Pending { retry_after_secs })
            }
            AdapterLoginResult::Complete(token) => {
                self.store_token(&account, &token)?;
                self.pending_logins
                    .write()
                    .map_err(|_| "OAuth pending login registry lock poisoned".to_string())?
                    .remove(login_id);
                if !self.is_transient_account(&pending.account_id) {
                    let _ = self
                        .account_store
                        .put_provider_account_state(
                            &pending.account_id,
                            None,
                            ProviderAccountStatus::Ready,
                            None,
                            None,
                            false,
                        )
                        .await;
                }
                Ok(OAuthLoginProgress::Complete {
                    account: token.public_metadata(&pending.account_id),
                })
            }
        }
    }

    pub fn cancel_login(&self, login_id: &str) -> Result<bool, String> {
        let pending = self
            .pending_logins
            .write()
            .map_err(|_| "OAuth pending login registry lock poisoned".to_string())?
            .remove(login_id);
        let Some(pending) = pending else {
            return Ok(false);
        };
        if let Some(state) = pending.callback_state.as_deref() {
            let _ = discard_oauth_callback(state);
        }
        let _ = self.discard_transient_account(&pending.account_id);
        Ok(true)
    }

    pub fn has_login(&self, login_id: &str) -> Result<bool, String> {
        Ok(self
            .pending_logins
            .read()
            .map_err(|_| "OAuth pending login registry lock poisoned".to_string())?
            .contains_key(login_id))
    }

    pub async fn materialize_authorization(
        &self,
        account_id: &str,
    ) -> Result<RequestAuthorization, String> {
        let account = self.oauth_account(account_id)?;
        let adapter = self.adapters.get(&account.auth_adapter)?;
        let mut token = self.load_token(&account)?;
        if !oauth_adapters_compatible(adapter.id(), &token.adapter_id) {
            return Err(format!(
                "Token Adapter '{}' for Auth Account '{account_id}' does not match configuration '{}'",
                token.adapter_id,
                adapter.id()
            ));
        }
        if token.needs_refresh(Utc::now()) {
            token = self
                .refresh_token(account_id, &account, adapter.as_ref(), token)
                .await?;
        }
        adapter.materialize(&token)
    }

    pub fn account_metadata(&self, account_id: &str) -> Result<OAuthAccountMetadata, String> {
        let account = self.oauth_account(account_id)?;
        Ok(self.load_token(&account)?.public_metadata(account_id))
    }

    /// Read live ChatGPT subscription limits and token activity for one
    /// authenticated account. No token material is returned or persisted by
    /// the probe; the official Codex app-server runs in an isolated temporary
    /// state directory and is terminated after the snapshot is collected.
    pub async fn subscription_usage(
        &self,
        account_id: &str,
    ) -> Result<ProviderSubscriptionUsage, String> {
        let account = self.oauth_account(account_id)?;
        let adapter = self.adapters.get(&account.auth_adapter)?;
        let mut token = self.load_token(&account)?;
        if !oauth_adapters_compatible(adapter.id(), &token.adapter_id) {
            return Err(format!(
                "Auth Account '{account_id}' token adapter '{}' is incompatible with '{}'",
                token.adapter_id,
                adapter.id()
            ));
        }
        if token.needs_refresh(Utc::now()) {
            token = self
                .refresh_token(account_id, &account, adapter.as_ref(), token)
                .await?;
        }
        let metadata = token.public_metadata(account_id);
        let (limits, token_usage) = adapter.subscription_usage(&token).await?;
        let availability =
            subscription_availability(&limits.rate_limits, limits.rate_limits_by_limit_id.as_ref());
        Ok(ProviderSubscriptionUsage {
            account_id: account_id.to_string(),
            provider_account_id: metadata.provider_account_id,
            email: metadata.email,
            adapter_id: metadata.adapter_id,
            selected_model_alias: None,
            source: "codex_app_server".to_string(),
            checked_at: Utc::now(),
            availability,
            rate_limits: limits.rate_limits,
            rate_limits_by_limit_id: limits.rate_limits_by_limit_id,
            rate_limit_reset_credits: limits.rate_limit_reset_credits,
            token_usage,
        })
    }

    pub async fn logout(&self, account_id: &str) -> Result<bool, String> {
        let account = self.oauth_account(account_id)?;
        let deleted = self.secret_store.delete(&account.credential_ref)?;
        let _ = self
            .account_store
            .put_provider_account_state(
                account_id,
                None,
                ProviderAccountStatus::Revoked,
                None,
                Some("operator_logout"),
                false,
            )
            .await;
        Ok(deleted)
    }

    fn oauth_account(&self, account_id: &str) -> Result<AuthAccountConfig, String> {
        let account = self
            .accounts
            .read()
            .map_err(|_| "OAuth Auth Account registry lock poisoned".to_string())?
            .get(account_id)
            .cloned()
            .ok_or_else(|| format!("Auth Account '{account_id}' does not exist"))?;
        if !account.auth_adapter.ends_with("-oauth") {
            return Err(format!(
                "Auth Account '{account_id}' uses '{}', which is not an OAuth Adapter",
                account.auth_adapter
            ));
        }
        Ok(account)
    }

    fn put_secret(
        &self,
        account: &AuthAccountConfig,
        name: &str,
        value: &str,
    ) -> Result<(), String> {
        if let Some(backend) = account.secret_backend.as_deref() {
            self.secret_store.put_with_backend(
                name,
                value,
                SecretScopeKind::Runtime,
                None,
                backend,
            )?;
        } else {
            self.secret_store
                .put(name, value, SecretScopeKind::Runtime, None)?;
        }
        Ok(())
    }

    fn store_token(
        &self,
        account: &AuthAccountConfig,
        token: &OAuthTokenSet,
    ) -> Result<(), String> {
        validate_secret_alias(&account.credential_ref)?;
        let serialized = serde_json::to_string(token)
            .map_err(|error| format!("failed to serialize OAuth Token Set: {error}"))?;
        self.put_secret(account, &account.credential_ref, &serialized)
    }

    fn load_token(&self, account: &AuthAccountConfig) -> Result<OAuthTokenSet, String> {
        validate_secret_alias(&account.credential_ref)?;
        let raw = self
            .secret_store
            .resolve(&account.credential_ref, SecretUseContext::default())?
            .ok_or_else(|| {
                format!(
                    "OAuth Auth Account is not logged in; managed credential '{}' does not exist",
                    account.credential_ref
                )
            })?;
        serde_json::from_str(&raw).map_err(|error| {
            format!(
                "OAuth Token Set '{}' is corrupted: {error}",
                account.credential_ref
            )
        })
    }

    async fn refresh_token(
        &self,
        account_id: &str,
        account: &AuthAccountConfig,
        adapter: &dyn AuthAdapter,
        current: OAuthTokenSet,
    ) -> Result<OAuthTokenSet, String> {
        if current.refresh_token.as_deref().is_none_or(str::is_empty) {
            self.mark_account_invalid(account_id, "missing_refresh_token")
                .await;
            return Err(format!(
                "OAuth Auth Account '{account_id}' has no Refresh Token"
            ));
        }
        let owner_id = format!("oauth-refresh-{}", random_hex(12)?);
        let lease = self
            .account_store
            .claim_provider_refresh_lease(
                account_id,
                &owner_id,
                Utc::now() + ChronoDuration::seconds(REFRESH_LEASE_SECS),
            )
            .await
            .map_err(|error| format!("failed to claim OAuth Refresh Lease: {error}"))?;
        let Some(lease) = lease else {
            // Another worker owns the refresh. Wait for its durable token
            // publication rather than making every concurrent request fail.
            // The wait is bounded by the refresh lease, so a crashed owner can
            // never strand request admission indefinitely.
            let deadline = tokio::time::Instant::now()
                + std::time::Duration::from_secs(REFRESH_LEASE_SECS as u64 + 1);
            loop {
                let reloaded = self.load_token(account)?;
                if !reloaded.needs_refresh(Utc::now()) {
                    return Ok(reloaded);
                }
                if tokio::time::Instant::now() >= deadline {
                    return Err(format!(
                        "OAuth Auth Account '{account_id}' refresh wait exceeded {} seconds; the next request may claim the Lease again",
                        REFRESH_LEASE_SECS
                    ));
                }
                tokio::time::sleep(std::time::Duration::from_millis(REFRESH_WAIT_POLL_MILLIS))
                    .await;
            }
        };
        let guard = RefreshLeaseGuard::new(
            Arc::clone(&self.account_store),
            account_id.to_string(),
            lease.generation,
            owner_id,
        );
        let refreshed = match adapter.refresh(&current).await {
            Ok(mut refreshed) => {
                if refreshed.refresh_token.as_deref().is_none_or(str::is_empty) {
                    refreshed.refresh_token = current.refresh_token;
                }
                if refreshed.id_token.as_deref().is_none_or(str::is_empty) {
                    refreshed.id_token = current.id_token;
                }
                if refreshed.account_id.is_none() {
                    refreshed.account_id = current.account_id;
                }
                if refreshed.subject.is_none() {
                    refreshed.subject = current.subject;
                }
                if refreshed.email.is_none() {
                    refreshed.email = current.email;
                }
                if refreshed.device_id.is_none() {
                    refreshed.device_id = current.device_id;
                }
                self.store_token(account, &refreshed)?;
                let _ = self
                    .account_store
                    .put_provider_account_state(
                        account_id,
                        None,
                        ProviderAccountStatus::Ready,
                        None,
                        None,
                        false,
                    )
                    .await;
                Ok(refreshed)
            }
            Err(error) => {
                let lower = error.to_ascii_lowercase();
                if lower.contains("unauthorized")
                    || lower.contains("forbidden")
                    || lower.contains("invalid_grant")
                    || lower.contains("refresh_token_reused")
                {
                    self.mark_account_invalid(account_id, "oauth_refresh_rejected")
                        .await;
                } else {
                    let _ = self
                        .account_store
                        .put_provider_account_state(
                            account_id,
                            None,
                            ProviderAccountStatus::Cooldown,
                            Some(Utc::now() + ChronoDuration::seconds(30)),
                            Some("oauth_refresh_transient"),
                            false,
                        )
                        .await;
                }
                Err(error)
            }
        };
        guard.release().await;
        refreshed
    }

    async fn mark_account_invalid(&self, account_id: &str, reason: &str) {
        let _ = self
            .account_store
            .put_provider_account_state(
                account_id,
                None,
                ProviderAccountStatus::Invalid,
                None,
                Some(reason),
                false,
            )
            .await;
    }
}

struct RefreshLeaseGuard {
    store: Arc<dyn ProviderAccountStateStore>,
    account_id: String,
    generation: u64,
    owner_id: String,
    armed: bool,
}

impl RefreshLeaseGuard {
    fn new(
        store: Arc<dyn ProviderAccountStateStore>,
        account_id: String,
        generation: u64,
        owner_id: String,
    ) -> Self {
        Self {
            store,
            account_id,
            generation,
            owner_id,
            armed: true,
        }
    }

    async fn release(mut self) {
        self.armed = false;
        let _ = self
            .store
            .release_provider_refresh_lease(&self.account_id, self.generation, &self.owner_id)
            .await;
    }
}

impl Drop for RefreshLeaseGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let store = Arc::clone(&self.store);
            let account_id = self.account_id.clone();
            let owner_id = self.owner_id.clone();
            let generation = self.generation;
            runtime.spawn(async move {
                let _ = store
                    .release_provider_refresh_lease(&account_id, generation, &owner_id)
                    .await;
            });
        }
    }
}

#[derive(Clone)]
pub struct CodexOAuthAdapter {
    http: reqwest::Client,
    auth_url: String,
    token_url: String,
    client_id: String,
    redirect_uri: String,
    listen_loopback: bool,
}

impl Default for CodexOAuthAdapter {
    fn default() -> Self {
        Self {
            http: oauth_http_client(),
            auth_url: "https://auth.openai.com/oauth/authorize".to_string(),
            token_url: "https://auth.openai.com/oauth/token".to_string(),
            client_id: "app_EMoamEEZ73f0CkXaXp7hrann".to_string(),
            // This exact URI is allow-listed for the public Codex CLI client.
            // It must not be replaced with a remote Dashboard host.
            redirect_uri: "http://localhost:1455/auth/callback".to_string(),
            listen_loopback: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CodexBrowserPending {
    state: String,
    verifier: String,
}

impl CodexOAuthAdapter {
    #[cfg(test)]
    fn with_test_endpoints(
        auth_url: impl Into<String>,
        token_url: impl Into<String>,
        client_id: impl Into<String>,
        redirect_uri: impl Into<String>,
    ) -> Self {
        Self {
            http: oauth_http_client(),
            auth_url: auth_url.into(),
            token_url: token_url.into(),
            client_id: client_id.into(),
            redirect_uri: redirect_uri.into(),
            listen_loopback: false,
        }
    }
}

#[async_trait::async_trait]
impl AuthAdapter for CodexOAuthAdapter {
    fn id(&self) -> &'static str {
        CODEX_ADAPTER_ID
    }

    fn version(&self) -> &'static str {
        "openai-codex-browser-pkce-2026-08-03"
    }

    fn flow(&self) -> OAuthFlowKind {
        OAuthFlowKind::AuthorizationCodePkce
    }

    fn callback_mode(&self) -> OAuthCallbackMode {
        OAuthCallbackMode::Loopback
    }

    fn stability(&self) -> AuthAdapterStability {
        AuthAdapterStability::Stable
    }

    fn upstream_reference(&self) -> Option<&'static str> {
        Some("openai/codex")
    }

    fn last_verified_on(&self) -> Option<&'static str> {
        Some("2026-08-03")
    }

    async fn start_login(&self) -> Result<AdapterLoginStart, String> {
        if self.listen_loopback {
            ensure_loopback_oauth_listener(1455, "/auth/callback").await?;
        }
        let state = random_hex(32)?;
        let verifier = random_hex(32)?;
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(verifier.as_bytes()));
        let expires_at = Utc::now() + ChronoDuration::minutes(15);
        let mut url = reqwest::Url::parse(&self.auth_url)
            .map_err(|error| format!("invalid Codex OAuth Authorization URL: {error}"))?;
        url.query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", &self.client_id)
            .append_pair("redirect_uri", &self.redirect_uri)
            .append_pair(
                "scope",
                "openid profile email offline_access api.connectors.read api.connectors.invoke",
            )
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("id_token_add_organizations", "true")
            .append_pair("codex_cli_simplified_flow", "true")
            .append_pair("state", &state)
            .append_pair("originator", "codex_cli_rs");
        Ok(AdapterLoginStart {
            flow: OAuthFlowKind::AuthorizationCodePkce,
            callback_mode: OAuthCallbackMode::Loopback,
            redirect_uri: Some(self.redirect_uri.clone()),
            authorization_url: Some(url.to_string()),
            verification_uri: None,
            verification_uri_complete: None,
            user_code: None,
            expires_at,
            poll_interval_secs: 2,
            state: serde_json::to_value(CodexBrowserPending { state, verifier })
                .map_err(|error| error.to_string())?,
        })
    }

    async fn continue_login(
        &self,
        state: &Value,
        completion: OAuthLoginCompletion,
    ) -> Result<AdapterLoginResult, String> {
        let pending: CodexBrowserPending =
            serde_json::from_value(state.clone()).map_err(|error| error.to_string())?;
        let (code, returned_state) = match completion {
            OAuthLoginCompletion::Poll => {
                let Some(result) = take_loopback_oauth_result(&pending.state)? else {
                    return Ok(AdapterLoginResult::Pending {
                        retry_after_secs: 2,
                        state: state.clone(),
                    });
                };
                if let Some(error) = result.error {
                    return Err(format!("Codex OAuth authorization failed: {error}"));
                }
                (
                    result
                        .code
                        .ok_or("Codex OAuth callback is missing authorization code")?,
                    pending.state.clone(),
                )
            }
            OAuthLoginCompletion::AuthorizationCode { code, state } => (code, state),
            OAuthLoginCompletion::AuthorizationResponse { response } => {
                parse_authorization_response(&response)?
            }
        };
        if returned_state != pending.state {
            return Err(format!(
                "the pasted callback belongs to a different Codex login (current state {}, callback state {}). Authorize again using the link in the current window, or cancel and restart; do not submit a URL from an old page",
                state_fingerprint(&pending.state),
                state_fingerprint(&returned_state)
            ));
        }
        discard_oauth_callback(&pending.state)?;
        let response = post_token_form(
            &self.http,
            &self.token_url,
            &[
                ("grant_type", "authorization_code"),
                ("client_id", &self.client_id),
                ("code", code.trim()),
                ("redirect_uri", &self.redirect_uri),
                ("code_verifier", &pending.verifier),
            ],
            &BTreeMap::new(),
        )
        .await?;
        Ok(AdapterLoginResult::Complete(Box::new(codex_token_set(
            self.id(),
            self.version(),
            response,
        )?)))
    }

    async fn refresh(&self, current: &OAuthTokenSet) -> Result<OAuthTokenSet, String> {
        let refresh = current
            .refresh_token
            .as_deref()
            .ok_or("Codex OAuth is missing Refresh Token")?;
        let response = post_token_form(
            &self.http,
            &self.token_url,
            &[
                ("client_id", &self.client_id),
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh),
                ("scope", "openid profile email"),
            ],
            &BTreeMap::new(),
        )
        .await?;
        codex_token_set(self.id(), self.version(), response)
    }

    fn materialize(&self, token: &OAuthTokenSet) -> Result<RequestAuthorization, String> {
        codex_materialize(token)
    }

    async fn subscription_usage(
        &self,
        token: &OAuthTokenSet,
    ) -> Result<(CodexRateLimitsResponse, SubscriptionTokenUsage), String> {
        inspect_codex_subscription_usage(token).await
    }
}

#[derive(Clone)]
pub struct CodexDeviceOAuthAdapter {
    http: reqwest::Client,
    device_user_code_url: String,
    device_token_url: String,
    token_url: String,
    client_id: String,
    redirect_uri: String,
}

impl Default for CodexDeviceOAuthAdapter {
    fn default() -> Self {
        Self {
            http: oauth_http_client(),
            device_user_code_url: "https://auth.openai.com/api/accounts/deviceauth/usercode"
                .to_string(),
            device_token_url: "https://auth.openai.com/api/accounts/deviceauth/token".to_string(),
            token_url: "https://auth.openai.com/oauth/token".to_string(),
            client_id: "app_EMoamEEZ73f0CkXaXp7hrann".to_string(),
            redirect_uri: "https://auth.openai.com/deviceauth/callback".to_string(),
        }
    }
}

impl CodexDeviceOAuthAdapter {
    /// Construct a Codex Device Flow adapter with explicit endpoints. This is
    /// used by deterministic contract tests and compatible private gateways.
    pub fn with_device_endpoints(
        device_user_code_url: impl Into<String>,
        device_token_url: impl Into<String>,
        token_url: impl Into<String>,
        client_id: impl Into<String>,
    ) -> Self {
        Self {
            http: oauth_http_client(),
            device_user_code_url: device_user_code_url.into(),
            device_token_url: device_token_url.into(),
            token_url: token_url.into(),
            client_id: client_id.into(),
            redirect_uri: "https://auth.openai.com/deviceauth/callback".to_string(),
        }
    }
}

#[derive(Serialize, Deserialize)]
struct CodexDevicePending {
    device_auth_id: String,
    user_code: String,
    interval_secs: u64,
}

#[derive(Deserialize)]
struct CodexDeviceUserCodeResponse {
    device_auth_id: String,
    #[serde(default)]
    user_code: String,
    #[serde(default)]
    usercode: String,
    #[serde(default)]
    interval: Value,
}

#[derive(Deserialize)]
struct CodexDeviceTokenResponse {
    authorization_code: String,
    code_verifier: String,
}

#[derive(Deserialize)]
struct OAuthTokenResponse {
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    #[serde(default)]
    id_token: String,
    #[serde(default)]
    token_type: String,
    #[serde(default)]
    expires_in: f64,
    #[serde(default)]
    scope: String,
    #[serde(default)]
    error: String,
    #[serde(default)]
    error_description: String,
}

#[async_trait::async_trait]
impl AuthAdapter for CodexDeviceOAuthAdapter {
    fn id(&self) -> &'static str {
        CODEX_DEVICE_ADAPTER_ID
    }

    fn version(&self) -> &'static str {
        "openai-device-auth-2026-08-03"
    }

    fn flow(&self) -> OAuthFlowKind {
        OAuthFlowKind::DeviceCode
    }

    fn stability(&self) -> AuthAdapterStability {
        AuthAdapterStability::Stable
    }

    fn upstream_reference(&self) -> Option<&'static str> {
        Some("openai/codex")
    }

    fn last_verified_on(&self) -> Option<&'static str> {
        Some("2026-08-03")
    }

    async fn start_login(&self) -> Result<AdapterLoginStart, String> {
        let response = self
            .http
            .post(&self.device_user_code_url)
            .header(reqwest::header::ACCEPT, "application/json")
            .json(&serde_json::json!({ "client_id": self.client_id }))
            .send()
            .await
            .map_err(|error| format!("Codex Device Authorization request failed: {error}"))?;
        let status = response.status();
        let body = response.bytes().await.map_err(|error| {
            format!("failed to read Codex Device Authorization response: {error}")
        })?;
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err(
                "the current ChatGPT account or workspace has not enabled Codex device-code login. Enable Device Code in ChatGPT security settings or workspace permissions, or continue with the browser callback"
                    .to_string(),
            );
        }
        if !status.is_success() {
            return Err(format!(
                "Codex Device Authorization returned HTTP {}: {}",
                status,
                safe_error_body(&body)
            ));
        }
        let payload: CodexDeviceUserCodeResponse = serde_json::from_slice(&body)
            .map_err(|error| format!("invalid Codex Device Authorization response: {error}"))?;
        let user_code = if payload.user_code.trim().is_empty() {
            payload.usercode.trim().to_string()
        } else {
            payload.user_code.trim().to_string()
        };
        if payload.device_auth_id.trim().is_empty() || user_code.is_empty() {
            return Err(
                "Codex Device Authorization is missing device_auth_id or user_code".to_string(),
            );
        }
        let interval_secs = parse_oauth_interval(&payload.interval, 5).clamp(1, 30);
        Ok(AdapterLoginStart {
            flow: OAuthFlowKind::DeviceCode,
            callback_mode: OAuthCallbackMode::None,
            redirect_uri: None,
            authorization_url: None,
            verification_uri: Some("https://auth.openai.com/codex/device".to_string()),
            verification_uri_complete: None,
            user_code: Some(user_code.clone()),
            expires_at: Utc::now() + ChronoDuration::minutes(15),
            poll_interval_secs: interval_secs,
            state: serde_json::to_value(CodexDevicePending {
                device_auth_id: payload.device_auth_id,
                user_code,
                interval_secs,
            })
            .map_err(|error| error.to_string())?,
        })
    }

    async fn continue_login(
        &self,
        state: &Value,
        completion: OAuthLoginCompletion,
    ) -> Result<AdapterLoginResult, String> {
        let mut pending: CodexDevicePending =
            serde_json::from_value(state.clone()).map_err(|error| error.to_string())?;
        if completion != OAuthLoginCompletion::Poll {
            return Err(
                "Codex Device Flow supports polling only and cannot submit an authorization code"
                    .to_string(),
            );
        }
        let response = self
            .http
            .post(&self.device_token_url)
            .header(reqwest::header::ACCEPT, "application/json")
            .json(&serde_json::json!({
                "device_auth_id": pending.device_auth_id,
                "user_code": pending.user_code,
            }))
            .send()
            .await
            .map_err(|error| format!("Codex Device Token polling failed: {error}"))?;
        let status = response.status();
        let body = response
            .bytes()
            .await
            .map_err(|error| format!("failed to read Codex Device Token response: {error}"))?;
        if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::NOT_FOUND {
            return Ok(AdapterLoginResult::Pending {
                retry_after_secs: pending.interval_secs,
                state: serde_json::to_value(pending).map_err(|error| error.to_string())?,
            });
        }
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            pending.interval_secs = pending.interval_secs.saturating_add(5).min(30);
            return Ok(AdapterLoginResult::Pending {
                retry_after_secs: pending.interval_secs,
                state: serde_json::to_value(pending).map_err(|error| error.to_string())?,
            });
        }
        if !status.is_success() {
            return Err(format!(
                "Codex Device Token returned HTTP {}: {}",
                status,
                safe_error_body(&body)
            ));
        }
        let device_token: CodexDeviceTokenResponse = serde_json::from_slice(&body)
            .map_err(|error| format!("invalid Codex Device Token response: {error}"))?;
        if device_token.authorization_code.trim().is_empty()
            || device_token.code_verifier.trim().is_empty()
        {
            return Err(
                "Codex Device Token is missing authorization code or PKCE data".to_string(),
            );
        }
        let response = post_token_form(
            &self.http,
            &self.token_url,
            &[
                ("grant_type", "authorization_code"),
                ("client_id", &self.client_id),
                ("code", device_token.authorization_code.trim()),
                ("redirect_uri", &self.redirect_uri),
                ("code_verifier", device_token.code_verifier.trim()),
            ],
            &BTreeMap::new(),
        )
        .await?;
        Ok(AdapterLoginResult::Complete(Box::new(codex_token_set(
            self.id(),
            self.version(),
            response,
        )?)))
    }

    async fn refresh(&self, current: &OAuthTokenSet) -> Result<OAuthTokenSet, String> {
        let refresh = current
            .refresh_token
            .as_deref()
            .ok_or("Codex OAuth is missing Refresh Token")?;
        let response = post_token_form(
            &self.http,
            &self.token_url,
            &[
                ("client_id", &self.client_id),
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh),
                ("scope", "openid profile email"),
            ],
            &BTreeMap::new(),
        )
        .await?;
        codex_token_set(self.id(), self.version(), response)
    }

    fn materialize(&self, token: &OAuthTokenSet) -> Result<RequestAuthorization, String> {
        codex_materialize(token)
    }

    async fn subscription_usage(
        &self,
        token: &OAuthTokenSet,
    ) -> Result<(CodexRateLimitsResponse, SubscriptionTokenUsage), String> {
        inspect_codex_subscription_usage(token).await
    }
}

fn codex_materialize(token: &OAuthTokenSet) -> Result<RequestAuthorization, String> {
    if token.access_token.trim().is_empty() {
        return Err("Codex OAuth Access Token is empty".to_string());
    }
    let account_id = token
        .account_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or("Codex OAuth Token is missing ChatGPT Account ID")?;
    let client_version = super::codex_client_version();
    Ok(RequestAuthorization {
        bearer_token: token.access_token.clone(),
        headers: BTreeMap::from([
            ("ChatGPT-Account-ID".to_string(), account_id.to_string()),
            ("Originator".to_string(), "codex_cli_rs".to_string()),
            (
                "User-Agent".to_string(),
                format!("codex_cli_rs/{client_version} (morphz; oauth)"),
            ),
        ]),
    })
}

fn codex_token_set(
    adapter_id: &str,
    version: &str,
    response: OAuthTokenResponse,
) -> Result<OAuthTokenSet, String> {
    if response.access_token.trim().is_empty() {
        return Err("Codex OAuth Token Endpoint returned an empty Access Token".to_string());
    }
    let claims = parse_codex_claims(
        (!response.id_token.is_empty())
            .then_some(response.id_token.as_str())
            .or(Some(response.access_token.as_str())),
    );
    Ok(OAuthTokenSet {
        adapter_id: adapter_id.to_string(),
        adapter_version: version.to_string(),
        access_token: response.access_token,
        refresh_token: (!response.refresh_token.is_empty()).then_some(response.refresh_token),
        id_token: (!response.id_token.is_empty()).then_some(response.id_token),
        token_type: (!response.token_type.is_empty()).then_some(response.token_type),
        scopes: response
            .scope
            .split_whitespace()
            .map(ToString::to_string)
            .collect(),
        expires_at: (response.expires_in > 0.0)
            .then(|| Utc::now() + ChronoDuration::seconds(response.expires_in as i64)),
        subject: claims.as_ref().and_then(|value| value.subject.clone()),
        account_id: claims.as_ref().and_then(|value| value.account_id.clone()),
        email: claims.and_then(|value| value.email),
        device_id: None,
        metadata: BTreeMap::new(),
    })
}

struct CodexClaims {
    subject: Option<String>,
    account_id: Option<String>,
    email: Option<String>,
}

fn parse_codex_claims(token: Option<&str>) -> Option<CodexClaims> {
    let payload = token?.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    Some(CodexClaims {
        subject: value.get("sub").and_then(Value::as_str).map(str::to_string),
        account_id: value
            .pointer("/https:~1~1api.openai.com~1auth/chatgpt_account_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        email: value
            .get("email")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

#[derive(Clone)]
pub struct KimiOAuthAdapter {
    http: reqwest::Client,
    device_code_url: String,
    token_url: String,
    client_id: String,
}

impl Default for KimiOAuthAdapter {
    fn default() -> Self {
        Self {
            http: oauth_http_client(),
            device_code_url: "https://auth.kimi.com/api/oauth/device_authorization".to_string(),
            token_url: "https://auth.kimi.com/api/oauth/token".to_string(),
            client_id: "17e5f671-d194-4dfb-9706-5516cb48c098".to_string(),
        }
    }
}

impl KimiOAuthAdapter {
    /// Construct a Kimi-compatible Device Flow adapter with explicit
    /// endpoints. Production uses the official Kimi endpoints by default.
    pub fn with_endpoints(
        device_code_url: impl Into<String>,
        token_url: impl Into<String>,
        client_id: impl Into<String>,
    ) -> Self {
        Self {
            http: oauth_http_client(),
            device_code_url: device_code_url.into(),
            token_url: token_url.into(),
            client_id: client_id.into(),
        }
    }
}

#[derive(Serialize, Deserialize)]
struct KimiPending {
    device_code: String,
    device_id: String,
    interval_secs: u64,
}

#[derive(Deserialize)]
struct KimiDeviceCodeResponse {
    device_code: String,
    user_code: String,
    #[serde(default)]
    verification_uri: String,
    #[serde(default)]
    verification_uri_complete: String,
    expires_in: i64,
    interval: i64,
}

#[async_trait::async_trait]
impl AuthAdapter for KimiOAuthAdapter {
    fn id(&self) -> &'static str {
        KIMI_ADAPTER_ID
    }

    fn version(&self) -> &'static str {
        "cliproxyapi-compatible-2026-08-01"
    }

    fn flow(&self) -> OAuthFlowKind {
        OAuthFlowKind::DeviceCode
    }

    fn stability(&self) -> AuthAdapterStability {
        AuthAdapterStability::Compatibility
    }

    fn upstream_reference(&self) -> Option<&'static str> {
        Some("router-for-me/CLIProxyAPI")
    }

    fn last_verified_on(&self) -> Option<&'static str> {
        None
    }

    async fn start_login(&self) -> Result<AdapterLoginStart, String> {
        let device_id = random_uuid_like()?;
        let headers = kimi_headers(&device_id);
        let response = self
            .http
            .post(&self.device_code_url)
            .headers(to_header_map(&headers)?)
            .form(&[("client_id", self.client_id.as_str())])
            .send()
            .await
            .map_err(|error| format!("Kimi Device Authorization request failed: {error}"))?;
        let status = response.status();
        let body = response.bytes().await.map_err(|error| {
            format!("failed to read Kimi Device Authorization response: {error}")
        })?;
        if !status.is_success() {
            return Err(format!(
                "Kimi Device Authorization returned HTTP {}: {}",
                status,
                safe_error_body(&body)
            ));
        }
        let payload: KimiDeviceCodeResponse = serde_json::from_slice(&body)
            .map_err(|error| format!("invalid Kimi Device Authorization response: {error}"))?;
        if payload.device_code.is_empty() || payload.user_code.is_empty() {
            return Err(
                "Kimi Device Authorization is missing device_code or user_code".to_string(),
            );
        }
        let interval = payload.interval.max(5) as u64;
        let expires_at = Utc::now() + ChronoDuration::seconds(payload.expires_in.clamp(1, 900));
        Ok(AdapterLoginStart {
            flow: OAuthFlowKind::DeviceCode,
            callback_mode: OAuthCallbackMode::None,
            redirect_uri: None,
            authorization_url: None,
            verification_uri: (!payload.verification_uri.is_empty())
                .then_some(payload.verification_uri),
            verification_uri_complete: (!payload.verification_uri_complete.is_empty())
                .then_some(payload.verification_uri_complete),
            user_code: Some(payload.user_code),
            expires_at,
            poll_interval_secs: interval,
            state: serde_json::to_value(KimiPending {
                device_code: payload.device_code,
                device_id,
                interval_secs: interval,
            })
            .map_err(|error| error.to_string())?,
        })
    }

    async fn continue_login(
        &self,
        state: &Value,
        completion: OAuthLoginCompletion,
    ) -> Result<AdapterLoginResult, String> {
        if completion != OAuthLoginCompletion::Poll {
            return Err(
                "Kimi Device Flow supports polling only and cannot submit an authorization code"
                    .to_string(),
            );
        }
        let mut pending: KimiPending =
            serde_json::from_value(state.clone()).map_err(|error| error.to_string())?;
        let headers = kimi_headers(&pending.device_id);
        let response = post_token_form(
            &self.http,
            &self.token_url,
            &[
                ("client_id", &self.client_id),
                ("device_code", &pending.device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ],
            &headers,
        )
        .await;
        match response {
            Ok(response) if response.error == "authorization_pending" => {
                Ok(AdapterLoginResult::Pending {
                    retry_after_secs: pending.interval_secs,
                    state: serde_json::to_value(pending).map_err(|error| error.to_string())?,
                })
            }
            Ok(response) if response.error == "slow_down" => {
                pending.interval_secs = pending.interval_secs.saturating_add(5).min(30);
                Ok(AdapterLoginResult::Pending {
                    retry_after_secs: pending.interval_secs,
                    state: serde_json::to_value(pending).map_err(|error| error.to_string())?,
                })
            }
            Ok(response) if !response.error.is_empty() => Err(format!(
                "Kimi OAuth error '{}': {}",
                response.error, response.error_description
            )),
            Ok(response) => Ok(AdapterLoginResult::Complete(Box::new(kimi_token_set(
                self.version(),
                response,
                Some(pending.device_id),
            )?))),
            Err(error) => Err(error),
        }
    }

    async fn refresh(&self, current: &OAuthTokenSet) -> Result<OAuthTokenSet, String> {
        let refresh = current
            .refresh_token
            .as_deref()
            .ok_or("Kimi OAuth is missing Refresh Token")?;
        let device_id = current
            .device_id
            .as_deref()
            .ok_or("Kimi OAuth Token is missing a stable Device ID")?;
        let response = post_token_form(
            &self.http,
            &self.token_url,
            &[
                ("client_id", &self.client_id),
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh),
            ],
            &kimi_headers(device_id),
        )
        .await?;
        kimi_token_set(self.version(), response, Some(device_id.to_string()))
    }

    fn materialize(&self, token: &OAuthTokenSet) -> Result<RequestAuthorization, String> {
        let device_id = token
            .device_id
            .as_deref()
            .filter(|value| !value.is_empty())
            .ok_or("Kimi OAuth Token is missing a stable Device ID")?;
        Ok(RequestAuthorization {
            bearer_token: token.access_token.clone(),
            headers: kimi_headers(device_id),
        })
    }
}

fn kimi_token_set(
    version: &str,
    response: OAuthTokenResponse,
    device_id: Option<String>,
) -> Result<OAuthTokenSet, String> {
    if response.access_token.is_empty() {
        return Err("Kimi OAuth Token Endpoint returned an empty Access Token".to_string());
    }
    Ok(OAuthTokenSet {
        adapter_id: KIMI_ADAPTER_ID.to_string(),
        adapter_version: version.to_string(),
        access_token: response.access_token,
        refresh_token: (!response.refresh_token.is_empty()).then_some(response.refresh_token),
        id_token: None,
        token_type: (!response.token_type.is_empty()).then_some(response.token_type),
        scopes: response
            .scope
            .split_whitespace()
            .map(ToString::to_string)
            .collect(),
        expires_at: (response.expires_in > 0.0)
            .then(|| Utc::now() + ChronoDuration::seconds(response.expires_in as i64)),
        subject: None,
        account_id: None,
        email: None,
        device_id,
        metadata: BTreeMap::new(),
    })
}

fn kimi_headers(device_id: &str) -> BTreeMap<String, String> {
    let hostname = std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "morphz".to_string());
    BTreeMap::from([
        ("Accept".to_string(), "application/json".to_string()),
        ("X-Msh-Platform".to_string(), "Morphz".to_string()),
        (
            "X-Msh-Version".to_string(),
            env!("CARGO_PKG_VERSION").to_string(),
        ),
        ("X-Msh-Device-Name".to_string(), hostname),
        (
            "X-Msh-Device-Model".to_string(),
            format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        ),
        ("X-Msh-Device-Id".to_string(), device_id.to_string()),
        (
            "User-Agent".to_string(),
            format!("morphz/{}", env!("CARGO_PKG_VERSION")),
        ),
    ])
}

#[derive(Clone)]
pub struct ClaudeOAuthAdapter {
    http: reqwest::Client,
    auth_url: String,
    token_url: String,
    client_id: String,
    redirect_uri: String,
    listen_loopback: bool,
}

impl Default for ClaudeOAuthAdapter {
    fn default() -> Self {
        Self {
            http: oauth_http_client(),
            auth_url: "https://claude.ai/oauth/authorize".to_string(),
            token_url: "https://api.anthropic.com/v1/oauth/token".to_string(),
            client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e".to_string(),
            redirect_uri: "http://localhost:54545/callback".to_string(),
            listen_loopback: true,
        }
    }
}

impl ClaudeOAuthAdapter {
    #[cfg(test)]
    fn with_test_endpoints(
        auth_url: impl Into<String>,
        token_url: impl Into<String>,
        client_id: impl Into<String>,
        redirect_uri: impl Into<String>,
    ) -> Self {
        Self {
            http: oauth_http_client(),
            auth_url: auth_url.into(),
            token_url: token_url.into(),
            client_id: client_id.into(),
            redirect_uri: redirect_uri.into(),
            listen_loopback: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ClaudePending {
    state: String,
    verifier: String,
}

#[derive(Debug, Deserialize)]
struct ClaudeTokenResponse {
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    #[serde(default)]
    token_type: String,
    #[serde(default)]
    expires_in: i64,
    #[serde(default)]
    organization: ClaudeOrganization,
    #[serde(default)]
    account: ClaudeAccount,
}

#[derive(Debug, Default, Deserialize)]
struct ClaudeOrganization {
    #[serde(default)]
    uuid: String,
    #[serde(default)]
    name: String,
}

#[derive(Debug, Default, Deserialize)]
struct ClaudeAccount {
    #[serde(default)]
    uuid: String,
    #[serde(default)]
    email_address: String,
}

impl ClaudeOAuthAdapter {
    async fn exchange(&self, body: Value) -> Result<ClaudeTokenResponse, String> {
        let response = self
            .http
            .post(&self.token_url)
            .header(reqwest::header::ACCEPT, "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|error| format!("Claude OAuth Token request failed: {error}"))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("failed to read Claude OAuth Token response: {error}"))?;
        if !status.is_success() {
            return Err(format!(
                "Claude OAuth Token returned HTTP {}: {}",
                status,
                safe_error_body(&bytes)
            ));
        }
        serde_json::from_slice(&bytes)
            .map_err(|error| format!("invalid Claude OAuth Token response: {error}"))
    }

    fn token_set(
        &self,
        response: ClaudeTokenResponse,
        previous_refresh: Option<String>,
    ) -> Result<OAuthTokenSet, String> {
        if response.access_token.trim().is_empty() {
            return Err("Claude OAuth Token Endpoint returned an empty Access Token".to_string());
        }
        let mut metadata = BTreeMap::new();
        if !response.organization.name.trim().is_empty() {
            metadata.insert("organization_name".to_string(), response.organization.name);
        }
        Ok(OAuthTokenSet {
            adapter_id: CLAUDE_ADAPTER_ID.to_string(),
            adapter_version: self.version().to_string(),
            access_token: response.access_token,
            refresh_token: (!response.refresh_token.trim().is_empty())
                .then_some(response.refresh_token)
                .or(previous_refresh),
            id_token: None,
            token_type: (!response.token_type.trim().is_empty()).then_some(response.token_type),
            scopes: vec![
                "user:profile".to_string(),
                "user:inference".to_string(),
                "user:sessions:claude_code".to_string(),
                "user:mcp_servers".to_string(),
                "user:file_upload".to_string(),
            ],
            expires_at: (response.expires_in > 0)
                .then(|| Utc::now() + ChronoDuration::seconds(response.expires_in)),
            subject: (!response.account.uuid.trim().is_empty())
                .then_some(response.account.uuid.clone()),
            account_id: (!response.organization.uuid.trim().is_empty())
                .then_some(response.organization.uuid),
            email: (!response.account.email_address.trim().is_empty())
                .then_some(response.account.email_address),
            device_id: None,
            metadata,
        })
    }
}

#[async_trait::async_trait]
impl AuthAdapter for ClaudeOAuthAdapter {
    fn id(&self) -> &'static str {
        CLAUDE_ADAPTER_ID
    }

    fn version(&self) -> &'static str {
        "cliproxyapi-compatible-2026-08-02"
    }

    fn flow(&self) -> OAuthFlowKind {
        OAuthFlowKind::AuthorizationCodePkce
    }

    fn stability(&self) -> AuthAdapterStability {
        AuthAdapterStability::Compatibility
    }

    fn upstream_reference(&self) -> Option<&'static str> {
        Some("router-for-me/CLIProxyAPI")
    }

    fn last_verified_on(&self) -> Option<&'static str> {
        None
    }

    async fn start_login(&self) -> Result<AdapterLoginStart, String> {
        if self.listen_loopback {
            ensure_loopback_oauth_listener(54545, "/callback").await?;
        }
        let state = random_hex(16)?;
        let verifier = random_hex(32)?;
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(verifier.as_bytes()));
        let mut url = reqwest::Url::parse(&self.auth_url)
            .map_err(|error| format!("invalid Claude OAuth Authorization URL: {error}"))?;
        url.query_pairs_mut()
            .append_pair("code", "true")
            .append_pair("client_id", &self.client_id)
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", &self.redirect_uri)
            .append_pair(
                "scope",
                "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
            )
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &state);
        let expires_at = Utc::now() + ChronoDuration::minutes(15);
        Ok(AdapterLoginStart {
            flow: OAuthFlowKind::AuthorizationCodePkce,
            callback_mode: OAuthCallbackMode::Loopback,
            redirect_uri: Some(self.redirect_uri.clone()),
            authorization_url: Some(url.to_string()),
            verification_uri: None,
            verification_uri_complete: None,
            user_code: None,
            expires_at,
            poll_interval_secs: 2,
            state: serde_json::to_value(ClaudePending { state, verifier })
                .map_err(|error| error.to_string())?,
        })
    }

    async fn continue_login(
        &self,
        state: &Value,
        completion: OAuthLoginCompletion,
    ) -> Result<AdapterLoginResult, String> {
        let pending: ClaudePending =
            serde_json::from_value(state.clone()).map_err(|error| error.to_string())?;
        let (raw_code, returned_state) = match completion {
            OAuthLoginCompletion::Poll => {
                let Some(result) = take_loopback_oauth_result(&pending.state)? else {
                    return Ok(AdapterLoginResult::Pending {
                        retry_after_secs: 2,
                        state: state.clone(),
                    });
                };
                if let Some(error) = result.error {
                    return Err(format!("Claude OAuth authorization failed: {error}"));
                }
                (
                    result
                        .code
                        .ok_or("Claude OAuth callback is missing authorization code")?,
                    pending.state.clone(),
                )
            }
            OAuthLoginCompletion::AuthorizationCode { code, state } => (code, state),
            OAuthLoginCompletion::AuthorizationResponse { response } => {
                parse_authorization_response(&response)?
            }
        };
        let mut parts = raw_code.splitn(2, '#');
        let code = parts.next().unwrap_or_default().trim();
        let fragment_state = parts
            .next()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let verified_state = fragment_state.unwrap_or(returned_state.trim());
        if verified_state != pending.state {
            return Err(format!(
                "the pasted callback belongs to a different Claude login (current state {}, callback state {}). Authorize again using the link in the current window, or cancel and restart",
                state_fingerprint(&pending.state),
                state_fingerprint(verified_state)
            ));
        }
        discard_oauth_callback(&pending.state)?;
        let response = self
            .exchange(serde_json::json!({
                "code": code,
                "state": verified_state,
                "grant_type": "authorization_code",
                "client_id": self.client_id,
                "redirect_uri": self.redirect_uri,
                "code_verifier": pending.verifier,
            }))
            .await?;
        Ok(AdapterLoginResult::Complete(Box::new(
            self.token_set(response, None)?,
        )))
    }

    async fn refresh(&self, current: &OAuthTokenSet) -> Result<OAuthTokenSet, String> {
        let refresh = current
            .refresh_token
            .as_deref()
            .ok_or("Claude OAuth is missing Refresh Token")?;
        let response = self
            .exchange(serde_json::json!({
                "client_id": self.client_id,
                "grant_type": "refresh_token",
                "refresh_token": refresh,
            }))
            .await?;
        self.token_set(response, Some(refresh.to_string()))
    }

    fn materialize(&self, token: &OAuthTokenSet) -> Result<RequestAuthorization, String> {
        if token.access_token.trim().is_empty() {
            return Err("Claude OAuth Access Token is empty".to_string());
        }
        Ok(RequestAuthorization {
            bearer_token: token.access_token.clone(),
            headers: BTreeMap::from([
                (
                    "authorization".to_string(),
                    format!("Bearer {}", token.access_token),
                ),
                ("anthropic-version".to_string(), "2023-06-01".to_string()),
                (
                    "anthropic-beta".to_string(),
                    "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,structured-outputs-2025-12-15,fast-mode-2026-02-01,redact-thinking-2026-02-12,token-efficient-tools-2026-03-28".to_string(),
                ),
                ("user-agent".to_string(), "claude-cli/2.1.76 (morphz; oauth)".to_string()),
            ]),
        })
    }
}

#[derive(Clone)]
pub struct AntigravityOAuthAdapter {
    http: reqwest::Client,
    auth_url: String,
    token_url: String,
    userinfo_url: String,
    project_url: String,
    client_id: String,
    client_secret: String,
    redirect_uri: String,
    listen_loopback: bool,
    configuration_error: Option<String>,
}

impl Default for AntigravityOAuthAdapter {
    fn default() -> Self {
        let mut adapter = Self {
            http: oauth_http_client(),
            auth_url: "https://accounts.google.com/o/oauth2/v2/auth".to_string(),
            token_url: "https://oauth2.googleapis.com/token".to_string(),
            userinfo_url: "https://www.googleapis.com/oauth2/v2/userinfo?alt=json".to_string(),
            project_url: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
                .to_string(),
            client_id: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
                .to_string(),
            client_secret: "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".to_string(),
            redirect_uri: "http://localhost:51121/oauth-callback".to_string(),
            listen_loopback: true,
            configuration_error: None,
        };
        let public_base_url = std::env::var("MORPHZ_OAUTH_PUBLIC_BASE_URL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let client_id = std::env::var("MORPHZ_ANTIGRAVITY_OAUTH_CLIENT_ID")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let client_secret = std::env::var("MORPHZ_ANTIGRAVITY_OAUTH_CLIENT_SECRET")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        match (public_base_url, client_id, client_secret) {
            (None, None, None) => {}
            (Some(base), Some(client_id), Some(client_secret)) => {
                match runtime_oauth_callback_url(&base) {
                    Ok(redirect_uri) => {
                        adapter.client_id = client_id;
                        adapter.client_secret = client_secret;
                        adapter.redirect_uri = redirect_uri;
                        adapter.listen_loopback = false;
                    }
                    Err(error) => adapter.configuration_error = Some(error),
                }
            }
            _ => {
                adapter.configuration_error = Some(
                    "server-side Antigravity OAuth requires MORPHZ_OAUTH_PUBLIC_BASE_URL, MORPHZ_ANTIGRAVITY_OAUTH_CLIENT_ID, and MORPHZ_ANTIGRAVITY_OAUTH_CLIENT_SECRET together"
                        .to_string(),
                );
            }
        }
        adapter
    }
}

fn runtime_oauth_callback_url(public_base_url: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(public_base_url.trim())
        .map_err(|error| format!("invalid MORPHZ_OAUTH_PUBLIC_BASE_URL: {error}"))?;
    if url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "MORPHZ_OAUTH_PUBLIC_BASE_URL must not contain credentials, query parameters, or a fragment"
                .to_string(),
        );
    }
    let host = url.host_str().unwrap_or_default();
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err(
            "a public server-side OAuth callback must use HTTPS; only loopback development addresses may use HTTP"
                .to_string(),
        );
    }
    let prefix = url.path().trim_end_matches('/');
    url.set_path(&format!("{prefix}/api/runtime/providers/oauth/callback"));
    Ok(url.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AntigravityPending {
    state: String,
    verifier: String,
}

impl AntigravityOAuthAdapter {
    #[cfg(test)]
    fn with_test_endpoints(
        auth_url: impl Into<String>,
        token_url: impl Into<String>,
        userinfo_url: impl Into<String>,
        project_url: impl Into<String>,
        client_id: impl Into<String>,
        client_secret: impl Into<String>,
        redirect_uri: impl Into<String>,
    ) -> Self {
        Self {
            http: oauth_http_client(),
            auth_url: auth_url.into(),
            token_url: token_url.into(),
            userinfo_url: userinfo_url.into(),
            project_url: project_url.into(),
            client_id: client_id.into(),
            client_secret: client_secret.into(),
            redirect_uri: redirect_uri.into(),
            listen_loopback: false,
            configuration_error: None,
        }
    }

    async fn user_info(&self, access_token: &str) -> Result<Option<String>, String> {
        let response = self
            .http
            .get(&self.userinfo_url)
            .bearer_auth(access_token)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|error| format!("Antigravity user information request failed: {error}"))?;
        if !response.status().is_success() {
            return Ok(None);
        }
        let value: Value = response
            .json()
            .await
            .map_err(|error| format!("invalid Antigravity user information response: {error}"))?;
        Ok(value
            .get("email")
            .and_then(Value::as_str)
            .map(str::to_string))
    }

    async fn project_id(&self, access_token: &str) -> Result<Option<String>, String> {
        let response = self
            .http
            .post(&self.project_url)
            .bearer_auth(access_token)
            .header(reqwest::header::ACCEPT, "*/*")
            .header(
                reqwest::header::USER_AGENT,
                "antigravity/1.19.5 linux/amd64",
            )
            .json(&serde_json::json!({ "metadata": { "ideType": "ANTIGRAVITY" } }))
            .send()
            .await
            .map_err(|error| format!("Antigravity project discovery request failed: {error}"))?;
        if !response.status().is_success() {
            return Ok(None);
        }
        let value: Value = response
            .json()
            .await
            .map_err(|error| format!("invalid Antigravity project discovery response: {error}"))?;
        Ok(["cloudaicompanionProject", "projectId", "project"]
            .into_iter()
            .find_map(|key| {
                value.get(key).and_then(|entry| {
                    entry
                        .as_str()
                        .map(str::to_string)
                        .or_else(|| entry.get("id").and_then(Value::as_str).map(str::to_string))
                })
            }))
    }

    async fn token_set(
        &self,
        response: OAuthTokenResponse,
        previous_refresh: Option<String>,
    ) -> Result<OAuthTokenSet, String> {
        if response.access_token.trim().is_empty() {
            return Err(
                "Antigravity OAuth Token Endpoint returned an empty Access Token".to_string(),
            );
        }
        let email = self.user_info(&response.access_token).await?;
        let project_id = self.project_id(&response.access_token).await?;
        let mut metadata = BTreeMap::new();
        if let Some(project_id) = project_id {
            metadata.insert("project_id".to_string(), project_id);
        }
        Ok(OAuthTokenSet {
            adapter_id: ANTIGRAVITY_ADAPTER_ID.to_string(),
            adapter_version: self.version().to_string(),
            access_token: response.access_token,
            refresh_token: (!response.refresh_token.trim().is_empty())
                .then_some(response.refresh_token)
                .or(previous_refresh),
            id_token: (!response.id_token.trim().is_empty()).then_some(response.id_token),
            token_type: (!response.token_type.trim().is_empty()).then_some(response.token_type),
            scopes: response
                .scope
                .split_whitespace()
                .map(str::to_string)
                .collect(),
            expires_at: (response.expires_in > 0.0)
                .then(|| Utc::now() + ChronoDuration::seconds(response.expires_in as i64)),
            subject: None,
            account_id: None,
            email,
            device_id: None,
            metadata,
        })
    }
}

#[async_trait::async_trait]
impl AuthAdapter for AntigravityOAuthAdapter {
    fn id(&self) -> &'static str {
        ANTIGRAVITY_ADAPTER_ID
    }

    fn version(&self) -> &'static str {
        "cliproxyapi-compatible-2026-08-02"
    }

    fn flow(&self) -> OAuthFlowKind {
        OAuthFlowKind::AuthorizationCodePkce
    }

    fn callback_mode(&self) -> OAuthCallbackMode {
        if self.listen_loopback {
            OAuthCallbackMode::Loopback
        } else if self
            .redirect_uri
            .contains("/api/runtime/providers/oauth/callback")
        {
            OAuthCallbackMode::Runtime
        } else {
            OAuthCallbackMode::Loopback
        }
    }

    fn stability(&self) -> AuthAdapterStability {
        AuthAdapterStability::Compatibility
    }

    fn upstream_reference(&self) -> Option<&'static str> {
        Some("router-for-me/CLIProxyAPI")
    }

    fn last_verified_on(&self) -> Option<&'static str> {
        None
    }

    async fn start_login(&self) -> Result<AdapterLoginStart, String> {
        if let Some(error) = self.configuration_error.as_deref() {
            return Err(error.to_string());
        }
        if self.listen_loopback {
            ensure_loopback_oauth_listener(51121, "/oauth-callback").await?;
        }
        let state = random_hex(16)?;
        let verifier = random_hex(32)?;
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(verifier.as_bytes()));
        let mut url = reqwest::Url::parse(&self.auth_url)
            .map_err(|error| format!("invalid Antigravity Authorization URL: {error}"))?;
        url.query_pairs_mut()
            .append_pair("access_type", "offline")
            .append_pair("client_id", &self.client_id)
            .append_pair("prompt", "consent")
            .append_pair("redirect_uri", &self.redirect_uri)
            .append_pair("response_type", "code")
            .append_pair(
                "scope",
                "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs",
            )
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &state);
        let expires_at = Utc::now() + ChronoDuration::minutes(15);
        Ok(AdapterLoginStart {
            flow: OAuthFlowKind::AuthorizationCodePkce,
            callback_mode: self.callback_mode(),
            redirect_uri: Some(self.redirect_uri.clone()),
            authorization_url: Some(url.to_string()),
            verification_uri: None,
            verification_uri_complete: None,
            user_code: None,
            expires_at,
            poll_interval_secs: 2,
            state: serde_json::to_value(AntigravityPending { state, verifier })
                .map_err(|error| error.to_string())?,
        })
    }

    async fn continue_login(
        &self,
        state: &Value,
        completion: OAuthLoginCompletion,
    ) -> Result<AdapterLoginResult, String> {
        let pending: AntigravityPending =
            serde_json::from_value(state.clone()).map_err(|error| error.to_string())?;
        let (code, returned_state) = match completion {
            OAuthLoginCompletion::Poll => {
                let Some(result) = take_loopback_oauth_result(&pending.state)? else {
                    return Ok(AdapterLoginResult::Pending {
                        retry_after_secs: 2,
                        state: state.clone(),
                    });
                };
                if let Some(error) = result.error {
                    return Err(format!("Antigravity OAuth authorization failed: {error}"));
                }
                (
                    result
                        .code
                        .ok_or("Antigravity OAuth callback is missing authorization code")?,
                    pending.state.clone(),
                )
            }
            OAuthLoginCompletion::AuthorizationCode { code, state } => (code, state),
            OAuthLoginCompletion::AuthorizationResponse { response } => {
                parse_authorization_response(&response)?
            }
        };
        if returned_state != pending.state {
            return Err(format!(
                "the pasted callback belongs to a different Antigravity login (current state {}, callback state {}). Authorize again using the link in the current window, or cancel and restart",
                state_fingerprint(&pending.state),
                state_fingerprint(&returned_state)
            ));
        }
        discard_oauth_callback(&pending.state)?;
        let response = post_token_form(
            &self.http,
            &self.token_url,
            &[
                ("code", code.trim()),
                ("client_id", &self.client_id),
                ("client_secret", &self.client_secret),
                ("redirect_uri", &self.redirect_uri),
                ("grant_type", "authorization_code"),
                ("code_verifier", &pending.verifier),
            ],
            &BTreeMap::new(),
        )
        .await?;
        Ok(AdapterLoginResult::Complete(Box::new(
            self.token_set(response, None).await?,
        )))
    }

    async fn refresh(&self, current: &OAuthTokenSet) -> Result<OAuthTokenSet, String> {
        let refresh = current
            .refresh_token
            .as_deref()
            .ok_or("Antigravity OAuth is missing Refresh Token")?;
        let response = post_token_form(
            &self.http,
            &self.token_url,
            &[
                ("client_id", &self.client_id),
                ("client_secret", &self.client_secret),
                ("refresh_token", refresh),
                ("grant_type", "refresh_token"),
            ],
            &BTreeMap::new(),
        )
        .await?;
        self.token_set(response, Some(refresh.to_string())).await
    }

    fn materialize(&self, token: &OAuthTokenSet) -> Result<RequestAuthorization, String> {
        if token.access_token.trim().is_empty() {
            return Err("Antigravity OAuth Access Token is empty".to_string());
        }
        let mut headers = BTreeMap::from([
            (
                "authorization".to_string(),
                format!("Bearer {}", token.access_token),
            ),
            (
                "user-agent".to_string(),
                "antigravity/1.19.5 linux/amd64".to_string(),
            ),
        ]);
        if let Some(project_id) = token.metadata.get("project_id") {
            headers.insert("x-goog-user-project".to_string(), project_id.clone());
        }
        Ok(RequestAuthorization {
            bearer_token: token.access_token.clone(),
            headers,
        })
    }
}

#[derive(Clone)]
pub struct XaiOAuthAdapter {
    http: reqwest::Client,
    discovery_url: String,
    client_id: String,
    scope: String,
    validate_discovered_endpoints: bool,
}

impl Default for XaiOAuthAdapter {
    fn default() -> Self {
        Self {
            http: oauth_http_client(),
            discovery_url: "https://auth.x.ai/.well-known/openid-configuration".to_string(),
            client_id: "b1a00492-073a-47ea-816f-4c329264a828".to_string(),
            scope: "openid profile email offline_access grok-cli:access api:access".to_string(),
            validate_discovered_endpoints: true,
        }
    }
}

impl XaiOAuthAdapter {
    /// Construct an xAI-compatible Device Flow adapter with explicit discovery
    /// endpoint. Production uses xAI OIDC discovery by default.
    pub fn with_discovery_endpoint(
        discovery_url: impl Into<String>,
        client_id: impl Into<String>,
        scope: impl Into<String>,
    ) -> Self {
        Self {
            http: oauth_http_client(),
            discovery_url: discovery_url.into(),
            client_id: client_id.into(),
            scope: scope.into(),
            validate_discovered_endpoints: true,
        }
    }

    #[cfg(test)]
    fn with_test_discovery_endpoint(
        discovery_url: impl Into<String>,
        client_id: impl Into<String>,
        scope: impl Into<String>,
    ) -> Self {
        Self {
            http: oauth_http_client(),
            discovery_url: discovery_url.into(),
            client_id: client_id.into(),
            scope: scope.into(),
            validate_discovered_endpoints: false,
        }
    }

    fn validate_endpoint(&self, raw: &str, field: &str) -> Result<(), String> {
        if self.validate_discovered_endpoints {
            validate_xai_oauth_endpoint(raw, field)
        } else {
            Ok(())
        }
    }

    async fn discover(&self) -> Result<XaiDiscovery, String> {
        let response = self
            .http
            .get(&self.discovery_url)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|error| format!("xAI OIDC Discovery request failed: {error}"))?;
        let status = response.status();
        let body = response
            .bytes()
            .await
            .map_err(|error| format!("failed to read xAI OIDC Discovery response: {error}"))?;
        if !status.is_success() {
            return Err(format!(
                "xAI OIDC Discovery returned HTTP {}: {}",
                status,
                safe_error_body(&body)
            ));
        }
        let payload: XaiDiscovery = serde_json::from_slice(&body)
            .map_err(|error| format!("invalid xAI OIDC Discovery response: {error}"))?;
        self.validate_endpoint(
            &payload.device_authorization_endpoint,
            "device_authorization_endpoint",
        )?;
        self.validate_endpoint(&payload.token_endpoint, "token_endpoint")?;
        Ok(payload)
    }
}

#[derive(Debug, Clone, Deserialize)]
struct XaiDiscovery {
    device_authorization_endpoint: String,
    token_endpoint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct XaiPending {
    device_code: String,
    token_endpoint: String,
    interval_secs: u64,
}

#[derive(Debug, Clone, Deserialize)]
struct XaiDeviceCodeResponse {
    device_code: String,
    user_code: String,
    #[serde(default)]
    verification_uri: String,
    #[serde(default)]
    verification_uri_complete: String,
    #[serde(default)]
    expires_in: i64,
    #[serde(default)]
    interval: i64,
}

#[async_trait::async_trait]
impl AuthAdapter for XaiOAuthAdapter {
    fn id(&self) -> &'static str {
        XAI_ADAPTER_ID
    }

    fn version(&self) -> &'static str {
        "cliproxyapi-compatible-2026-08-02"
    }

    fn flow(&self) -> OAuthFlowKind {
        OAuthFlowKind::DeviceCode
    }

    fn stability(&self) -> AuthAdapterStability {
        AuthAdapterStability::Compatibility
    }

    fn upstream_reference(&self) -> Option<&'static str> {
        Some("router-for-me/CLIProxyAPI")
    }

    fn last_verified_on(&self) -> Option<&'static str> {
        None
    }

    async fn start_login(&self) -> Result<AdapterLoginStart, String> {
        let discovery = self.discover().await?;
        let response = self
            .http
            .post(&discovery.device_authorization_endpoint)
            .header(reqwest::header::ACCEPT, "application/json")
            .form(&[
                ("client_id", self.client_id.as_str()),
                ("scope", self.scope.as_str()),
            ])
            .send()
            .await
            .map_err(|error| format!("xAI Device Authorization request failed: {error}"))?;
        let status = response.status();
        let body = response.bytes().await.map_err(|error| {
            format!("failed to read xAI Device Authorization response: {error}")
        })?;
        if !status.is_success() {
            return Err(format!(
                "xAI Device Authorization returned HTTP {}: {}",
                status,
                safe_error_body(&body)
            ));
        }
        let payload: XaiDeviceCodeResponse = serde_json::from_slice(&body)
            .map_err(|error| format!("invalid xAI Device Authorization response: {error}"))?;
        if payload.device_code.trim().is_empty() || payload.user_code.trim().is_empty() {
            return Err("xAI Device Authorization is missing device_code or user_code".to_string());
        }
        if payload.verification_uri.trim().is_empty()
            && payload.verification_uri_complete.trim().is_empty()
        {
            return Err("xAI Device Authorization is missing verification URI".to_string());
        }
        let interval_secs = payload.interval.max(5) as u64;
        let expires_in = payload.expires_in.clamp(1, 1_800);
        Ok(AdapterLoginStart {
            flow: OAuthFlowKind::DeviceCode,
            callback_mode: OAuthCallbackMode::None,
            redirect_uri: None,
            authorization_url: None,
            verification_uri: (!payload.verification_uri.trim().is_empty())
                .then_some(payload.verification_uri),
            verification_uri_complete: (!payload.verification_uri_complete.trim().is_empty())
                .then_some(payload.verification_uri_complete),
            user_code: Some(payload.user_code),
            expires_at: Utc::now() + ChronoDuration::seconds(expires_in),
            poll_interval_secs: interval_secs,
            state: serde_json::to_value(XaiPending {
                device_code: payload.device_code,
                token_endpoint: discovery.token_endpoint,
                interval_secs,
            })
            .map_err(|error| error.to_string())?,
        })
    }

    async fn continue_login(
        &self,
        state: &Value,
        completion: OAuthLoginCompletion,
    ) -> Result<AdapterLoginResult, String> {
        if completion != OAuthLoginCompletion::Poll {
            return Err(
                "xAI Device Flow supports polling only and cannot submit an authorization code"
                    .to_string(),
            );
        }
        let mut pending: XaiPending =
            serde_json::from_value(state.clone()).map_err(|error| error.to_string())?;
        self.validate_endpoint(&pending.token_endpoint, "token_endpoint")?;
        let response = post_token_form(
            &self.http,
            &pending.token_endpoint,
            &[
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("device_code", &pending.device_code),
                ("client_id", &self.client_id),
            ],
            &BTreeMap::new(),
        )
        .await?;
        match response.error.as_str() {
            "authorization_pending" => Ok(AdapterLoginResult::Pending {
                retry_after_secs: pending.interval_secs,
                state: serde_json::to_value(pending).map_err(|error| error.to_string())?,
            }),
            "slow_down" => {
                pending.interval_secs = pending.interval_secs.saturating_add(5).min(30);
                Ok(AdapterLoginResult::Pending {
                    retry_after_secs: pending.interval_secs,
                    state: serde_json::to_value(pending).map_err(|error| error.to_string())?,
                })
            }
            "expired_token" => Err("xAI Device Authorization has expired".to_string()),
            "access_denied" => Err("xAI Device Authorization was denied".to_string()),
            error if !error.is_empty() => Err(format!(
                "xAI OAuth error '{}': {}",
                error, response.error_description
            )),
            _ => Ok(AdapterLoginResult::Complete(Box::new(xai_token_set(
                self.version(),
                response,
                pending.token_endpoint,
            )?))),
        }
    }

    async fn refresh(&self, current: &OAuthTokenSet) -> Result<OAuthTokenSet, String> {
        let refresh = current
            .refresh_token
            .as_deref()
            .ok_or("xAI OAuth is missing Refresh Token")?;
        let token_endpoint = match current.metadata.get("token_endpoint") {
            Some(endpoint) => {
                self.validate_endpoint(endpoint, "token_endpoint")?;
                endpoint.clone()
            }
            None => self.discover().await?.token_endpoint,
        };
        let response = post_token_form(
            &self.http,
            &token_endpoint,
            &[
                ("grant_type", "refresh_token"),
                ("client_id", &self.client_id),
                ("refresh_token", refresh),
            ],
            &BTreeMap::new(),
        )
        .await?;
        xai_token_set(self.version(), response, token_endpoint)
    }

    fn materialize(&self, token: &OAuthTokenSet) -> Result<RequestAuthorization, String> {
        if token.access_token.trim().is_empty() {
            return Err("xAI OAuth Access Token is empty".to_string());
        }
        Ok(RequestAuthorization {
            bearer_token: token.access_token.clone(),
            headers: BTreeMap::from([
                ("X-XAI-Token-Auth".to_string(), "xai-grok-cli".to_string()),
                (
                    "x-grok-client-version".to_string(),
                    XAI_GROK_CLIENT_VERSION.to_string(),
                ),
                (
                    "User-Agent".to_string(),
                    format!("xai-grok-workspace/{XAI_GROK_CLIENT_VERSION}"),
                ),
            ]),
        })
    }
}

fn validate_xai_oauth_endpoint(raw: &str, field: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(raw.trim())
        .map_err(|error| format!("invalid xAI Discovery {field}: {error}"))?;
    if url.scheme() != "https" {
        return Err(format!("xAI Discovery {field} must use HTTPS"));
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if host != "x.ai" && !host.ends_with(".x.ai") {
        return Err(format!(
            "xAI Discovery {field} host '{host}' does not belong to x.ai"
        ));
    }
    Ok(())
}

fn xai_token_set(
    version: &str,
    response: OAuthTokenResponse,
    token_endpoint: String,
) -> Result<OAuthTokenSet, String> {
    if response.access_token.trim().is_empty() {
        return Err("xAI OAuth Token Endpoint returned an empty Access Token".to_string());
    }
    let (subject, email) = parse_standard_jwt_identity(&response.id_token);
    Ok(OAuthTokenSet {
        adapter_id: XAI_ADAPTER_ID.to_string(),
        adapter_version: version.to_string(),
        access_token: response.access_token,
        refresh_token: (!response.refresh_token.is_empty()).then_some(response.refresh_token),
        id_token: (!response.id_token.is_empty()).then_some(response.id_token),
        token_type: (!response.token_type.is_empty()).then_some(response.token_type),
        scopes: response
            .scope
            .split_whitespace()
            .map(ToString::to_string)
            .collect(),
        expires_at: (response.expires_in > 0.0)
            .then(|| Utc::now() + ChronoDuration::seconds(response.expires_in as i64)),
        subject,
        account_id: None,
        email,
        device_id: None,
        metadata: BTreeMap::from([("token_endpoint".to_string(), token_endpoint)]),
    })
}

fn parse_standard_jwt_identity(token: &str) -> (Option<String>, Option<String>) {
    let value = token
        .split('.')
        .nth(1)
        .and_then(|payload| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(payload)
                .ok()
        })
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let subject = value
        .as_ref()
        .and_then(|value| value.get("sub"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let email = value
        .as_ref()
        .and_then(|value| value.get("email"))
        .and_then(Value::as_str)
        .map(str::to_string);
    (subject, email)
}

async fn post_token_form(
    http: &reqwest::Client,
    url: &str,
    form: &[(&str, &str)],
    headers: &BTreeMap<String, String>,
) -> Result<OAuthTokenResponse, String> {
    let response = http
        .post(url)
        .headers(to_header_map(headers)?)
        .form(form)
        .send()
        .await
        .map_err(|error| format!("OAuth Token request failed: {error}"))?;
    let status = response.status();
    let body = response
        .bytes()
        .await
        .map_err(|error| format!("failed to read OAuth Token response: {error}"))?;
    let parsed: OAuthTokenResponse = serde_json::from_slice(&body)
        .map_err(|error| format!("failed to parse OAuth Token response: {error}"))?;
    // RFC 8628 commonly returns pending with HTTP 400, while Kimi currently
    // returns 200. Preserve the structured OAuth error for either behavior.
    if !status.is_success() && parsed.error.is_empty() {
        return Err(format!(
            "OAuth Token Endpoint returned HTTP {}: {}",
            status,
            safe_error_body(&body)
        ));
    }
    Ok(parsed)
}

fn to_header_map(values: &BTreeMap<String, String>) -> Result<reqwest::header::HeaderMap, String> {
    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in values {
        headers.insert(
            reqwest::header::HeaderName::from_bytes(name.as_bytes())
                .map_err(|error| format!("invalid OAuth Header name '{name}': {error}"))?,
            reqwest::header::HeaderValue::from_str(value)
                .map_err(|error| format!("invalid OAuth Header '{name}' value: {error}"))?,
        );
    }
    Ok(headers)
}

fn safe_error_body(body: &[u8]) -> String {
    fn redact(value: &mut Value) {
        match value {
            Value::Object(object) => {
                for (key, value) in object {
                    let key = key.to_ascii_lowercase();
                    if key.contains("token")
                        || key.contains("secret")
                        || key.contains("code")
                        || key.contains("password")
                    {
                        *value = Value::String("<redacted>".to_string());
                    } else {
                        redact(value);
                    }
                }
            }
            Value::Array(values) => values.iter_mut().for_each(redact),
            _ => {}
        }
    }

    match serde_json::from_slice::<Value>(body) {
        Ok(mut value) => {
            redact(&mut value);
            serde_json::to_string(&value)
                .unwrap_or_else(|_| "<oauth error body unavailable>".to_string())
        }
        Err(_) => "<non-json oauth error body redacted>".to_string(),
    }
}

fn parse_oauth_interval(value: &Value, fallback: u64) -> u64 {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|value| value.parse::<u64>().ok()))
        .unwrap_or(fallback)
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut value = vec![0_u8; bytes];
    getrandom::fill(&mut value)
        .map_err(|error| format!("operating system random number generation failed: {error}"))?;
    Ok(value.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn random_uuid_like() -> Result<String, String> {
    let value = random_hex(16)?;
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &value[0..8],
        &value[8..12],
        &value[12..16],
        &value[16..20],
        &value[20..32]
    ))
}

fn validate_secret_alias(value: &str) -> Result<(), String> {
    if value.is_empty()
        || !value.starts_with(|character: char| character.is_ascii_alphabetic() || character == '_')
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
    {
        return Err(format!(
            "OAuth credential_ref '{value}' must be a valid Secret Store or environment-variable alias"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::sqlite::SqliteStore;
    use crate::secret_store::SecretValueBackend;
    use axum::extract::{Form, State};
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::IntoResponse;
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemorySecretBackend {
        values: Mutex<BTreeMap<String, String>>,
    }

    impl SecretValueBackend for MemorySecretBackend {
        fn backend_id(&self) -> &'static str {
            "oauth_test_memory"
        }

        fn storage_kind(&self) -> &'static str {
            "memory"
        }

        fn put(&self, locator: &str, value: &str) -> Result<(), String> {
            self.values
                .lock()
                .map_err(|_| "test secret backend poisoned".to_string())?
                .insert(locator.to_string(), value.to_string());
            Ok(())
        }

        fn get(&self, locator: &str) -> Result<Option<String>, String> {
            Ok(self
                .values
                .lock()
                .map_err(|_| "test secret backend poisoned".to_string())?
                .get(locator)
                .cloned())
        }

        fn delete(&self, locator: &str) -> Result<bool, String> {
            Ok(self
                .values
                .lock()
                .map_err(|_| "test secret backend poisoned".to_string())?
                .remove(locator)
                .is_some())
        }
    }

    async fn test_manager(
        account: AuthAccountConfig,
        registry: AuthAdapterRegistry,
    ) -> (
        tempfile::TempDir,
        Arc<ProviderAuthManager>,
        Arc<SecretStore>,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let secret_store = Arc::new(
            SecretStore::new(
                directory.path().join("managed-secrets.json"),
                Arc::new(MemorySecretBackend::default()),
            )
            .unwrap(),
        );
        let database = directory.path().join("oauth.db");
        let account_store = Arc::new(SqliteStore::new(database.to_str().unwrap()).await.unwrap());
        let account_id = "oauth-account".to_string();
        let manager = Arc::new(ProviderAuthManager::new_with_registry(
            BTreeMap::from([(account_id, account)]),
            Arc::clone(&secret_store),
            account_store,
            registry,
        ));
        (directory, manager, secret_store)
    }

    #[tokio::test]
    async fn newly_registered_account_is_available_without_restart() {
        let (_directory, manager, _secret_store) =
            test_manager(oauth_account("test-oauth"), AuthAdapterRegistry::default()).await;
        let account = oauth_account("late-oauth");

        manager
            .register_account("late-account", account.clone())
            .unwrap();

        let registered = manager.account("late-account").unwrap();
        assert_eq!(registered.auth_adapter, account.auth_adapter);
        assert_eq!(registered.credential_ref, account.credential_ref);
        assert_eq!(registered.provider, account.provider);
        assert_eq!(registered.label, account.label);
        assert_eq!(registered.enabled, account.enabled);
    }

    #[tokio::test]
    async fn unfinished_login_exists_only_in_memory_and_cancel_leaves_no_account() {
        let mut registry = AuthAdapterRegistry::default();
        registry.register(Arc::new(CodexOAuthAdapter::with_test_endpoints(
            "https://auth.example.test/oauth/authorize",
            "https://auth.example.test/oauth/token",
            "test-client",
            "http://localhost:1455/auth/callback",
        )));
        let (_directory, manager, secret_store) =
            test_manager(oauth_account(CODEX_ADAPTER_ID), registry).await;
        manager
            .register_transient_account("attempt-only", oauth_account(CODEX_ADAPTER_ID))
            .unwrap();

        let challenge = manager.start_login("attempt-only").await.unwrap();
        assert!(manager.has_login(&challenge.login_id).unwrap());
        assert!(manager.account("attempt-only").is_some());
        assert!(secret_store
            .resolve("MORPHZ_TEST_OAUTH_TOKEN", SecretUseContext::default())
            .unwrap()
            .is_none());
        assert!(manager
            .account_store
            .get_provider_account_state("attempt-only")
            .await
            .unwrap()
            .is_none());

        assert!(manager.cancel_login(&challenge.login_id).unwrap());
        assert!(!manager.has_login(&challenge.login_id).unwrap());
        assert!(manager.account("attempt-only").is_none());
        assert!(secret_store
            .resolve("MORPHZ_TEST_OAUTH_TOKEN", SecretUseContext::default())
            .unwrap()
            .is_none());
    }

    fn oauth_account(adapter: &str) -> AuthAccountConfig {
        AuthAccountConfig {
            auth_adapter: adapter.to_string(),
            credential_ref: "MORPHZ_TEST_OAUTH_TOKEN".to_string(),
            secret_backend: None,
            provider: Some("test-provider".to_string()),
            label: Some("test account".to_string()),
            enabled: true,
        }
    }

    fn unsigned_jwt(payload: Value) -> String {
        let header = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"alg":"none","typ":"JWT"}"#);
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&payload).unwrap());
        format!("{header}.{payload}.")
    }

    #[derive(Clone)]
    struct CodexServerState {
        refreshes: Arc<AtomicUsize>,
        device_polls: Arc<AtomicUsize>,
        id_token: String,
    }

    async fn codex_device_user_code_endpoint() -> Json<Value> {
        Json(json!({
            "device_auth_id": "device-auth-1",
            "user_code": "CODEX-1234",
            "interval": "1"
        }))
    }

    async fn codex_device_token_endpoint(
        State(state): State<CodexServerState>,
        Json(payload): Json<Value>,
    ) -> impl IntoResponse {
        assert_eq!(payload["device_auth_id"], "device-auth-1");
        assert_eq!(payload["user_code"], "CODEX-1234");
        if state.device_polls.fetch_add(1, Ordering::SeqCst) == 0 {
            return (StatusCode::FORBIDDEN, Json(json!({ "status": "pending" }))).into_response();
        }
        Json(json!({
            "authorization_code": "authorization-code",
            "code_verifier": "device-code-verifier",
            "code_challenge": "device-code-challenge"
        }))
        .into_response()
    }

    async fn codex_token_endpoint(
        State(state): State<CodexServerState>,
        Form(form): Form<HashMap<String, String>>,
    ) -> Json<Value> {
        if form.get("grant_type").map(String::as_str) == Some("refresh_token") {
            state.refreshes.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            return Json(json!({
                "access_token": "codex-access-refreshed",
                "refresh_token": "codex-refresh-rotated",
                "token_type": "Bearer",
                "expires_in": 3600,
                "scope": "openid profile email"
            }));
        }
        assert_eq!(
            form.get("client_id").map(String::as_str),
            Some("test-client")
        );
        assert!(!form
            .get("code_verifier")
            .map(String::as_str)
            .unwrap_or_default()
            .is_empty());
        Json(json!({
            "access_token": "codex-access-initial",
            "refresh_token": "codex-refresh-initial",
            "id_token": state.id_token,
            "token_type": "Bearer",
            "expires_in": 3600,
            "scope": "openid profile email offline_access"
        }))
    }

    #[tokio::test]
    async fn codex_browser_pkce_is_default_and_refresh_fencing_is_durable() {
        let refreshes = Arc::new(AtomicUsize::new(0));
        let device_polls = Arc::new(AtomicUsize::new(0));
        let id_token = unsigned_jwt(json!({
            "sub": "subject-1",
            "email": "codex@example.test",
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "chatgpt-account-1"
            }
        }));
        let app = Router::new()
            .route("/token", post(codex_token_endpoint))
            .with_state(CodexServerState {
                refreshes: Arc::clone(&refreshes),
                device_polls: Arc::clone(&device_polls),
                id_token,
            });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let adapter = Arc::new(CodexOAuthAdapter::with_test_endpoints(
            "https://auth.example.test/oauth/authorize",
            format!("http://{address}/token"),
            "test-client",
            "http://localhost:1455/auth/callback",
        ));
        let started = adapter.start_login().await.unwrap();
        assert_eq!(started.flow, OAuthFlowKind::AuthorizationCodePkce);
        assert_eq!(started.callback_mode, OAuthCallbackMode::Loopback);
        assert_eq!(
            started.redirect_uri.as_deref(),
            Some("http://localhost:1455/auth/callback")
        );
        let auth_url = reqwest::Url::parse(started.authorization_url.as_deref().unwrap()).unwrap();
        let params = auth_url
            .query_pairs()
            .into_owned()
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            params.get("response_type").map(String::as_str),
            Some("code")
        );
        assert_eq!(
            params.get("code_challenge_method").map(String::as_str),
            Some("S256")
        );
        assert!(params
            .get("code_challenge")
            .is_some_and(|value| !value.is_empty()));
        assert_eq!(
            params.get("originator").map(String::as_str),
            Some("codex_cli_rs")
        );
        let state = params["state"].clone();
        let AdapterLoginResult::Complete(token) = adapter
            .continue_login(
                &started.state,
                OAuthLoginCompletion::AuthorizationResponse {
                    response: format!(
                        "http://localhost:1455/auth/callback?code=browser-code&state={state}"
                    ),
                },
            )
            .await
            .unwrap()
        else {
            panic!("codex browser authorization unexpectedly remained pending");
        };
        assert_eq!(token.account_id.as_deref(), Some("chatgpt-account-1"));
        assert_eq!(token.email.as_deref(), Some("codex@example.test"));
        let authorization = adapter.materialize(&token).unwrap();
        assert_eq!(authorization.bearer_token, "codex-access-initial");
        assert_eq!(
            authorization
                .headers
                .get("ChatGPT-Account-ID")
                .map(String::as_str),
            Some("chatgpt-account-1")
        );

        let mut registry = AuthAdapterRegistry::default();
        registry.register(adapter);
        let (directory, manager, secret_store) =
            test_manager(oauth_account(CODEX_ADAPTER_ID), registry).await;
        let expired = OAuthTokenSet {
            expires_at: Some(Utc::now() - ChronoDuration::seconds(1)),
            ..*token
        };
        manager
            .store_token(&manager.account("oauth-account").unwrap(), &expired)
            .unwrap();
        let (left, right) = tokio::join!(
            manager.materialize_authorization("oauth-account"),
            manager.materialize_authorization("oauth-account")
        );
        assert_eq!(left.unwrap().bearer_token, "codex-access-refreshed");
        assert_eq!(right.unwrap().bearer_token, "codex-access-refreshed");
        assert_eq!(refreshes.load(Ordering::SeqCst), 1);
        let catalog =
            std::fs::read_to_string(directory.path().join("managed-secrets.json")).unwrap();
        assert!(!catalog.contains("codex-access-refreshed"));
        assert!(secret_store
            .resolve("MORPHZ_TEST_OAUTH_TOKEN", SecretUseContext::default())
            .unwrap()
            .unwrap()
            .contains("codex-access-refreshed"));
    }

    #[tokio::test]
    async fn codex_device_flow_remains_an_explicit_fallback_adapter() {
        let id_token = unsigned_jwt(json!({
            "sub": "subject-device",
            "email": "codex-device@example.test",
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "chatgpt-account-device"
            }
        }));
        let state = CodexServerState {
            refreshes: Arc::new(AtomicUsize::new(0)),
            device_polls: Arc::new(AtomicUsize::new(0)),
            id_token,
        };
        let app = Router::new()
            .route("/device/usercode", post(codex_device_user_code_endpoint))
            .route("/device/token", post(codex_device_token_endpoint))
            .route("/token", post(codex_token_endpoint))
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let adapter = CodexDeviceOAuthAdapter::with_device_endpoints(
            format!("http://{address}/device/usercode"),
            format!("http://{address}/device/token"),
            format!("http://{address}/token"),
            "test-client",
        );
        let started = adapter.start_login().await.unwrap();
        assert_eq!(started.flow, OAuthFlowKind::DeviceCode);
        assert_eq!(started.callback_mode, OAuthCallbackMode::None);
        assert_eq!(started.user_code.as_deref(), Some("CODEX-1234"));
        assert!(matches!(
            adapter
                .continue_login(&started.state, OAuthLoginCompletion::Poll)
                .await
                .unwrap(),
            AdapterLoginResult::Pending { .. }
        ));
        let AdapterLoginResult::Complete(token) = adapter
            .continue_login(&started.state, OAuthLoginCompletion::Poll)
            .await
            .unwrap()
        else {
            panic!("codex device authorization unexpectedly remained pending");
        };
        assert_eq!(token.adapter_id, CODEX_DEVICE_ADAPTER_ID);

        let mut registry = AuthAdapterRegistry::default();
        registry.register(Arc::new(CodexOAuthAdapter::with_test_endpoints(
            "https://auth.example/authorize",
            format!("http://{address}/token"),
            "test-client",
            "http://localhost:1455/auth/callback",
        )));
        registry.register(Arc::new(adapter));
        let (_directory, manager, _secret_store) =
            test_manager(oauth_account(CODEX_ADAPTER_ID), registry).await;

        let challenge = manager
            .start_login_using("oauth-account", CODEX_DEVICE_ADAPTER_ID)
            .await
            .unwrap();
        assert_eq!(challenge.adapter_id, CODEX_DEVICE_ADAPTER_ID);
        assert_eq!(challenge.user_code.as_deref(), Some("CODEX-1234"));
        assert!(matches!(
            manager
                .continue_login(&challenge.login_id, OAuthLoginCompletion::Poll)
                .await
                .unwrap(),
            OAuthLoginProgress::Complete { .. }
        ));
        assert_eq!(
            manager
                .materialize_authorization("oauth-account")
                .await
                .unwrap()
                .bearer_token,
            "codex-access-initial"
        );
        assert!(manager
            .start_login_using("oauth-account", KIMI_ADAPTER_ID)
            .await
            .unwrap_err()
            .contains("cannot switch to incompatible"));
    }

    #[derive(Clone, Default)]
    struct KimiServerState {
        polls: Arc<AtomicUsize>,
        observed_device: Arc<Mutex<Option<String>>>,
    }

    async fn kimi_device_endpoint(headers: HeaderMap) -> Json<Value> {
        assert!(headers.get("x-msh-device-id").is_some());
        Json(json!({
            "device_code": "device-code-1",
            "user_code": "KIMI-1234",
            "verification_uri": "https://kimi.example/device",
            "verification_uri_complete": "https://kimi.example/device?code=KIMI-1234",
            "expires_in": 600,
            "interval": 1
        }))
    }

    async fn kimi_token_endpoint(
        State(state): State<KimiServerState>,
        headers: HeaderMap,
        Form(_form): Form<HashMap<String, String>>,
    ) -> Json<Value> {
        let device = headers
            .get("x-msh-device-id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        *state.observed_device.lock().unwrap() = device;
        if state.polls.fetch_add(1, Ordering::SeqCst) == 0 {
            Json(json!({
                "error": "authorization_pending",
                "error_description": "pending"
            }))
        } else {
            Json(json!({
                "access_token": "kimi-access",
                "refresh_token": "kimi-refresh",
                "token_type": "Bearer",
                "expires_in": 3600
            }))
        }
    }

    #[tokio::test]
    async fn kimi_device_flow_preserves_stable_device_identity() {
        let state = KimiServerState::default();
        let app = Router::new()
            .route("/device", post(kimi_device_endpoint))
            .route("/token", post(kimi_token_endpoint))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let adapter = KimiOAuthAdapter::with_endpoints(
            format!("http://{address}/device"),
            format!("http://{address}/token"),
            "kimi-test-client",
        );
        let started = adapter.start_login().await.unwrap();
        assert_eq!(started.flow, OAuthFlowKind::DeviceCode);
        assert_eq!(started.poll_interval_secs, 5);
        assert!(matches!(
            adapter
                .continue_login(&started.state, OAuthLoginCompletion::Poll)
                .await
                .unwrap(),
            AdapterLoginResult::Pending { .. }
        ));
        let AdapterLoginResult::Complete(token) = adapter
            .continue_login(&started.state, OAuthLoginCompletion::Poll)
            .await
            .unwrap()
        else {
            panic!("kimi device authorization unexpectedly remained pending");
        };
        assert_eq!(
            token.device_id.as_deref(),
            state.observed_device.lock().unwrap().as_deref()
        );
        let authorization = adapter.materialize(&token).unwrap();
        assert_eq!(authorization.bearer_token, "kimi-access");
        assert_eq!(
            authorization.headers.get("X-Msh-Device-Id"),
            state.observed_device.lock().unwrap().as_ref()
        );
    }

    fn authorization_state(started: &AdapterLoginStart) -> String {
        reqwest::Url::parse(started.authorization_url.as_deref().unwrap())
            .unwrap()
            .query_pairs()
            .find_map(|(key, value)| (key == "state").then(|| value.into_owned()))
            .unwrap()
    }

    async fn claude_token_endpoint(Json(payload): Json<Value>) -> Json<Value> {
        assert_eq!(payload["client_id"], "claude-test-client");
        assert!(!payload["code_verifier"]
            .as_str()
            .unwrap_or_default()
            .is_empty());
        Json(json!({
            "access_token": "claude-access",
            "refresh_token": "claude-refresh",
            "token_type": "Bearer",
            "expires_in": 3600,
            "organization": { "uuid": "claude-org", "name": "Morphz" },
            "account": { "uuid": "claude-user", "email_address": "claude@example.test" }
        }))
    }

    #[tokio::test]
    async fn claude_authorization_callback_is_exchanged_and_materialized() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().route("/token", post(claude_token_endpoint));
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let adapter = ClaudeOAuthAdapter::with_test_endpoints(
            "https://claude.example/authorize",
            format!("http://{address}/token"),
            "claude-test-client",
            "http://localhost/callback",
        );
        let started = adapter.start_login().await.unwrap();
        assert_eq!(started.flow, OAuthFlowKind::AuthorizationCodePkce);
        let state = authorization_state(&started);
        let AdapterLoginResult::Complete(token) = adapter
            .continue_login(
                &started.state,
                OAuthLoginCompletion::AuthorizationResponse {
                    response: format!(
                        "http://localhost/callback?code=claude-code%23{state}&state={state}"
                    ),
                },
            )
            .await
            .unwrap()
        else {
            panic!("claude authorization unexpectedly remained pending");
        };
        assert_eq!(token.account_id.as_deref(), Some("claude-org"));
        assert_eq!(token.subject.as_deref(), Some("claude-user"));
        assert_eq!(token.email.as_deref(), Some("claude@example.test"));
        let authorization = adapter.materialize(&token).unwrap();
        assert_eq!(authorization.bearer_token, "claude-access");
        assert_eq!(
            authorization
                .headers
                .get("anthropic-version")
                .map(String::as_str),
            Some("2023-06-01")
        );
    }

    async fn antigravity_token_endpoint(Form(form): Form<HashMap<String, String>>) -> Json<Value> {
        assert_eq!(
            form.get("client_id").map(String::as_str),
            Some("antigravity-test-client")
        );
        assert!(!form
            .get("code_verifier")
            .map(String::as_str)
            .unwrap_or_default()
            .is_empty());
        Json(json!({
            "access_token": "antigravity-access",
            "refresh_token": "antigravity-refresh",
            "token_type": "Bearer",
            "expires_in": 3600,
            "scope": "openid email cloud-platform"
        }))
    }

    async fn antigravity_userinfo_endpoint(headers: HeaderMap) -> Json<Value> {
        assert_eq!(
            headers
                .get("authorization")
                .and_then(|value| value.to_str().ok()),
            Some("Bearer antigravity-access")
        );
        Json(json!({ "email": "antigravity@example.test" }))
    }

    async fn antigravity_project_endpoint(headers: HeaderMap) -> Json<Value> {
        assert_eq!(
            headers
                .get("authorization")
                .and_then(|value| value.to_str().ok()),
            Some("Bearer antigravity-access")
        );
        Json(json!({ "cloudaicompanionProject": "morphz-project" }))
    }

    #[tokio::test]
    async fn antigravity_authorization_callback_discovers_account_and_project() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/token", post(antigravity_token_endpoint))
            .route("/userinfo", get(antigravity_userinfo_endpoint))
            .route("/project", post(antigravity_project_endpoint));
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let adapter = AntigravityOAuthAdapter::with_test_endpoints(
            "https://accounts.example/authorize",
            format!("http://{address}/token"),
            format!("http://{address}/userinfo"),
            format!("http://{address}/project"),
            "antigravity-test-client",
            "antigravity-test-secret",
            "http://localhost/oauth-callback",
        );
        let started = adapter.start_login().await.unwrap();
        let state = authorization_state(&started);
        let authorization_url =
            reqwest::Url::parse(started.authorization_url.as_deref().unwrap()).unwrap();
        let authorization_params = authorization_url
            .query_pairs()
            .into_owned()
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            authorization_params
                .get("code_challenge_method")
                .map(String::as_str),
            Some("S256")
        );
        assert!(authorization_params
            .get("code_challenge")
            .is_some_and(|value| !value.is_empty()));
        let AdapterLoginResult::Complete(token) = adapter
            .continue_login(
                &started.state,
                OAuthLoginCompletion::AuthorizationResponse {
                    response: format!(
                        "http://localhost/oauth-callback?code=google-code&state={state}"
                    ),
                },
            )
            .await
            .unwrap()
        else {
            panic!("antigravity authorization unexpectedly remained pending");
        };
        assert_eq!(token.email.as_deref(), Some("antigravity@example.test"));
        assert_eq!(
            token.metadata.get("project_id").map(String::as_str),
            Some("morphz-project")
        );
        let authorization = adapter.materialize(&token).unwrap();
        assert_eq!(authorization.bearer_token, "antigravity-access");
        assert_eq!(
            authorization
                .headers
                .get("x-goog-user-project")
                .map(String::as_str),
            Some("morphz-project")
        );
    }

    #[test]
    fn runtime_oauth_callback_url_preserves_mount_prefix_and_requires_https() {
        assert_eq!(
            runtime_oauth_callback_url("https://morphz.example/runtime").unwrap(),
            "https://morphz.example/runtime/api/runtime/providers/oauth/callback"
        );
        assert_eq!(
            runtime_oauth_callback_url("http://localhost:8080").unwrap(),
            "http://localhost:8080/api/runtime/providers/oauth/callback"
        );
        assert!(runtime_oauth_callback_url("http://192.168.1.61:8080").is_err());
        assert!(runtime_oauth_callback_url("https://user:pass@morphz.example").is_err());
    }

    #[derive(Clone)]
    struct XaiServerState {
        polls: Arc<AtomicUsize>,
        base_url: String,
        id_token: String,
    }

    async fn xai_discovery_endpoint(State(state): State<XaiServerState>) -> Json<Value> {
        Json(json!({
            "device_authorization_endpoint": format!("{}/device", state.base_url),
            "token_endpoint": format!("{}/token", state.base_url)
        }))
    }

    async fn xai_device_endpoint(Form(form): Form<HashMap<String, String>>) -> Json<Value> {
        assert_eq!(
            form.get("client_id").map(String::as_str),
            Some("xai-test-client")
        );
        Json(json!({
            "device_code": "xai-device",
            "user_code": "XAI-1234",
            "verification_uri": "https://accounts.x.ai/activate",
            "verification_uri_complete": "https://accounts.x.ai/activate?code=XAI-1234",
            "expires_in": 600,
            "interval": 1
        }))
    }

    async fn xai_token_endpoint(
        State(state): State<XaiServerState>,
        Form(_form): Form<HashMap<String, String>>,
    ) -> Json<Value> {
        if state.polls.fetch_add(1, Ordering::SeqCst) == 0 {
            Json(json!({
                "error": "authorization_pending",
                "error_description": "pending"
            }))
        } else {
            Json(json!({
                "access_token": "xai-access",
                "refresh_token": "xai-refresh",
                "id_token": state.id_token,
                "token_type": "Bearer",
                "expires_in": 3600,
                "scope": "openid profile email"
            }))
        }
    }

    #[tokio::test]
    async fn xai_discovery_device_flow_and_identity_are_preserved() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let state = XaiServerState {
            polls: Arc::new(AtomicUsize::new(0)),
            base_url: format!("http://{address}"),
            id_token: unsigned_jwt(json!({
                "sub": "xai-subject",
                "email": "xai@example.test"
            })),
        };
        let app = Router::new()
            .route("/discovery", get(xai_discovery_endpoint))
            .route("/device", post(xai_device_endpoint))
            .route("/token", post(xai_token_endpoint))
            .with_state(state);
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let adapter = XaiOAuthAdapter::with_test_discovery_endpoint(
            format!("http://{address}/discovery"),
            "xai-test-client",
            "openid profile email",
        );
        let started = adapter.start_login().await.unwrap();
        assert_eq!(started.user_code.as_deref(), Some("XAI-1234"));
        assert!(matches!(
            adapter
                .continue_login(&started.state, OAuthLoginCompletion::Poll)
                .await
                .unwrap(),
            AdapterLoginResult::Pending { .. }
        ));
        let AdapterLoginResult::Complete(token) = adapter
            .continue_login(&started.state, OAuthLoginCompletion::Poll)
            .await
            .unwrap()
        else {
            panic!("xAI device authorization unexpectedly remained pending");
        };
        assert_eq!(token.subject.as_deref(), Some("xai-subject"));
        assert_eq!(token.email.as_deref(), Some("xai@example.test"));
        let authorization = adapter.materialize(&token).unwrap();
        assert_eq!(authorization.bearer_token, "xai-access");
        assert_eq!(
            authorization
                .headers
                .get("x-grok-client-version")
                .map(String::as_str),
            Some(XAI_GROK_CLIENT_VERSION)
        );
        assert_eq!(
            authorization
                .headers
                .get("X-XAI-Token-Auth")
                .map(String::as_str),
            Some("xai-grok-cli")
        );
    }

    #[test]
    fn authorization_response_parser_requires_code_and_state() {
        assert_eq!(
            parse_authorization_response(
                "http://localhost/callback?code=abc%20123&state=state-value"
            )
            .unwrap(),
            ("abc 123".to_string(), "state-value".to_string())
        );
        assert!(parse_authorization_response("?code=abc").is_err());
        assert!(parse_authorization_response("?error=access_denied&state=s").is_err());
    }

    #[test]
    fn pasted_callback_state_routes_to_the_login_that_created_it() {
        let old_state = format!("old-state-{}", random_hex(8).unwrap());
        let new_state = format!("new-state-{}", random_hex(8).unwrap());
        let expires_at = Utc::now() + ChronoDuration::minutes(5);

        register_oauth_callback(&old_state, expires_at).unwrap();
        bind_oauth_callback_login(&old_state, "old-login").unwrap();
        register_oauth_callback(&new_state, expires_at).unwrap();
        bind_oauth_callback_login(&new_state, "new-login").unwrap();

        assert_eq!(oauth_callback_login_id(&old_state).unwrap(), "old-login");
        assert_eq!(oauth_callback_login_id(&new_state).unwrap(), "new-login");
        assert!(oauth_callback_login_id("unknown-state").is_err());

        discard_oauth_callback(&old_state).unwrap();
        discard_oauth_callback(&new_state).unwrap();
    }

    #[test]
    fn codex_subscription_snapshot_preserves_all_public_usage_fields() {
        let decoded: CodexRateLimitsResponse = serde_json::from_value(json!({
            "rateLimits": {
                "limitId": "codex",
                "limitName": null,
                "primary": {
                    "usedPercent": 73,
                    "windowDurationMins": 300,
                    "resetsAt": 1_786_900_000
                },
                "secondary": {
                    "usedPercent": 41,
                    "windowDurationMins": 10_080,
                    "resetsAt": 1_787_000_000
                },
                "credits": {
                    "hasCredits": true,
                    "unlimited": false,
                    "balance": "18.60"
                },
                "individualLimit": null,
                "planType": "pro",
                "rateLimitReachedType": null
            },
            "rateLimitsByLimitId": {
                "codex": {
                    "limitId": "codex",
                    "limitName": null,
                    "primary": { "usedPercent": 73, "windowDurationMins": 300, "resetsAt": 1_786_900_000 },
                    "secondary": { "usedPercent": 41, "windowDurationMins": 10_080, "resetsAt": 1_787_000_000 },
                    "credits": { "hasCredits": true, "unlimited": false, "balance": "18.60" },
                    "individualLimit": null,
                    "planType": "pro",
                    "rateLimitReachedType": null
                }
            },
            "rateLimitResetCredits": {
                "availableCount": 1,
                "credits": [{
                    "id": "reset-1",
                    "resetType": "codexRateLimits",
                    "status": "available",
                    "grantedAt": 1_786_800_000,
                    "expiresAt": null,
                    "title": "Rate-limit reset",
                    "description": "Reset an eligible Codex rate-limit window."
                }]
            }
        }))
        .unwrap();

        assert_eq!(decoded.rate_limits.plan_type.as_deref(), Some("pro"));
        assert_eq!(
            decoded
                .rate_limits
                .credits
                .as_ref()
                .and_then(|credits| credits.balance.as_deref()),
            Some("18.60")
        );
        assert_eq!(
            decoded
                .rate_limit_reset_credits
                .as_ref()
                .map(|credits| credits.available_count),
            Some(1)
        );
        assert_eq!(
            subscription_availability(
                &decoded.rate_limits,
                decoded.rate_limits_by_limit_id.as_ref()
            ),
            SubscriptionAvailability::Available
        );
    }

    #[test]
    fn codex_subscription_availability_is_exhausted_when_any_bucket_is_reached() {
        let exhausted = SubscriptionRateLimitSnapshot {
            limit_id: Some("codex".to_string()),
            limit_name: None,
            primary: Some(SubscriptionUsageWindow {
                used_percent: 96,
                window_duration_mins: Some(300),
                resets_at: Some(1_786_900_000),
            }),
            secondary: None,
            credits: None,
            individual_limit: None,
            plan_type: Some("pro".to_string()),
            rate_limit_reached_type: Some("rate_limit_reached".to_string()),
        };
        assert_eq!(
            subscription_availability(&exhausted, None),
            SubscriptionAvailability::Exhausted
        );
    }

    #[test]
    fn codex_token_activity_accepts_missing_optional_history() {
        let usage: SubscriptionTokenUsage = serde_json::from_value(json!({
            "summary": {
                "lifetimeTokens": 1234567,
                "peakDailyTokens": null,
                "longestRunningTurnSec": 540,
                "currentStreakDays": 8,
                "longestStreakDays": 14
            },
            "dailyUsageBuckets": null
        }))
        .unwrap();
        assert_eq!(usage.summary.lifetime_tokens, Some(1_234_567));
        assert!(usage.daily_usage_buckets.is_none());
    }

    /// Explicit end-to-end check of the external-token App Server contract.
    /// The test reads an existing Codex auth file only when the caller opts in
    /// and never prints or persists its credential values.
    #[tokio::test]
    #[ignore = "requires a live Codex auth file and network access"]
    async fn live_codex_external_token_probe_reads_subscription_usage() {
        let path = std::env::var("MORPHZ_TEST_CODEX_AUTH_JSON")
            .expect("MORPHZ_TEST_CODEX_AUTH_JSON must point to a Codex auth.json file");
        let auth: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let token = OAuthTokenSet {
            adapter_id: CODEX_ADAPTER_ID.to_string(),
            adapter_version: "test".to_string(),
            access_token: auth["tokens"]["access_token"]
                .as_str()
                .expect("Codex auth file has no access token")
                .to_string(),
            refresh_token: None,
            id_token: None,
            token_type: Some("Bearer".to_string()),
            scopes: Vec::new(),
            expires_at: None,
            subject: None,
            account_id: Some(
                auth["tokens"]["account_id"]
                    .as_str()
                    .expect("Codex auth file has no account id")
                    .to_string(),
            ),
            email: None,
            device_id: None,
            metadata: BTreeMap::new(),
        };
        let (limits, usage) = inspect_codex_subscription_usage(&token).await.unwrap();
        assert!(limits.rate_limits.plan_type.is_some());
        assert!(usage.summary.lifetime_tokens.is_some());
    }

    /// Explicit network smoke test for the upstream Codex subscription login
    /// contract. It stays ignored in the normal suite because it depends on an
    /// external service, but release verification can run it without completing
    /// or persisting a user login.
    #[tokio::test]
    #[ignore = "requires access to auth.openai.com"]
    async fn live_codex_browser_login_returns_a_real_challenge() {
        let started = CodexOAuthAdapter::default().start_login().await.unwrap();
        assert_eq!(started.flow, OAuthFlowKind::AuthorizationCodePkce);
        assert_eq!(started.callback_mode, OAuthCallbackMode::Loopback);
        assert!(started
            .authorization_url
            .as_deref()
            .is_some_and(|url| url.starts_with("https://auth.openai.com/oauth/authorize")));
    }

    /// Explicit network smoke test for the upstream Kimi subscription login
    /// contract. No token is persisted until a human completes the device flow.
    #[tokio::test]
    #[ignore = "requires access to auth.kimi.com"]
    async fn live_kimi_device_login_returns_a_real_challenge() {
        let started = KimiOAuthAdapter::default().start_login().await.unwrap();
        assert_eq!(started.flow, OAuthFlowKind::DeviceCode);
        assert!(started
            .user_code
            .as_deref()
            .is_some_and(|code| !code.is_empty()));
        assert!(started
            .verification_uri_complete
            .as_deref()
            .or(started.verification_uri.as_deref())
            .is_some_and(|url| url.starts_with("https://")));
    }
}
