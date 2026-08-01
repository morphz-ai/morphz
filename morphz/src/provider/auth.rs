//! Provider authentication adapters and OAuth lifecycle management.
//!
//! This module deliberately stops at the authentication boundary. Protocol
//! request/response normalization remains in [`super::ProtocolClient`], while
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
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

const TOKEN_REFRESH_SKEW_SECS: i64 = 300;
const REFRESH_LEASE_SECS: i64 = 45;
const REFRESH_WAIT_POLL_MILLIS: u64 = 125;
const CODEX_ADAPTER_ID: &str = "codex-oauth";
const KIMI_ADAPTER_ID: &str = "kimi-oauth";

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
    AuthorizationCode { code: String, state: String },
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

#[derive(Clone, Serialize, Deserialize)]
struct PendingLoginEnvelope {
    account_id: String,
    adapter_id: String,
    expires_at: DateTime<Utc>,
    state: Value,
}

pub struct AdapterLoginStart {
    pub flow: OAuthFlowKind,
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
    Complete(OAuthTokenSet),
}

#[async_trait::async_trait]
pub trait AuthAdapter: Send + Sync {
    fn id(&self) -> &'static str;
    fn version(&self) -> &'static str;
    fn flow(&self) -> OAuthFlowKind;
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
}

#[derive(Default)]
pub struct AuthAdapterRegistry {
    adapters: HashMap<String, Arc<dyn AuthAdapter>>,
}

impl AuthAdapterRegistry {
    pub fn builtins() -> Self {
        let mut registry = Self::default();
        registry.register(Arc::new(CodexOAuthAdapter::default()));
        registry.register(Arc::new(KimiOAuthAdapter::default()));
        registry
    }

    pub fn register(&mut self, adapter: Arc<dyn AuthAdapter>) {
        self.adapters.insert(adapter.id().to_string(), adapter);
    }

    fn get(&self, id: &str) -> Result<Arc<dyn AuthAdapter>, String> {
        self.adapters
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Auth Adapter '{id}' 尚未注册"))
    }

    pub fn descriptors(&self) -> Vec<AuthAdapterDescriptor> {
        let mut descriptors = self
            .adapters
            .values()
            .map(|adapter| AuthAdapterDescriptor {
                id: adapter.id().to_string(),
                version: adapter.version().to_string(),
                flow: adapter.flow(),
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
    accounts: BTreeMap<String, AuthAccountConfig>,
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
        Self {
            accounts,
            secret_store,
            account_store,
            adapters: AuthAdapterRegistry::builtins(),
        }
    }

    pub fn with_registry(mut self, adapters: AuthAdapterRegistry) -> Self {
        self.adapters = adapters;
        self
    }

    pub fn account(&self, account_id: &str) -> Option<&AuthAccountConfig> {
        self.accounts.get(account_id)
    }

    pub fn adapter_descriptors(&self) -> Vec<AuthAdapterDescriptor> {
        self.adapters.descriptors()
    }

    pub async fn start_login(&self, account_id: &str) -> Result<OAuthLoginChallenge, String> {
        let account = self.oauth_account(account_id)?;
        validate_secret_alias(&account.credential_ref)?;
        let adapter = self.adapters.get(&account.auth_adapter)?;
        let started = adapter.start_login().await?;
        let login_id = format!("MORPHZ_OAUTH_LOGIN_{}", random_hex(16)?);
        let pending = PendingLoginEnvelope {
            account_id: account_id.to_string(),
            adapter_id: adapter.id().to_string(),
            expires_at: started.expires_at,
            state: started.state,
        };
        self.put_secret(
            account,
            &login_id,
            &serde_json::to_string(&pending)
                .map_err(|error| format!("OAuth 登录状态无法序列化：{error}"))?,
        )?;
        Ok(OAuthLoginChallenge {
            login_id,
            account_id: account_id.to_string(),
            adapter_id: adapter.id().to_string(),
            flow: started.flow,
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
        validate_secret_alias(login_id)?;
        let pending_raw = self
            .secret_store
            .resolve(login_id, SecretUseContext::default())?
            .ok_or_else(|| format!("OAuth Login '{login_id}' 不存在或已完成"))?;
        let mut pending: PendingLoginEnvelope = serde_json::from_str(&pending_raw)
            .map_err(|error| format!("OAuth Login '{login_id}' 状态损坏：{error}"))?;
        if pending.expires_at <= Utc::now() {
            let _ = self.secret_store.delete(login_id);
            return Err(format!("OAuth Login '{login_id}' 已过期"));
        }
        let account = self.oauth_account(&pending.account_id)?;
        if account.auth_adapter != pending.adapter_id {
            return Err(format!(
                "OAuth Login '{}' 的 Adapter '{}' 与账号当前配置 '{}' 不一致",
                login_id, pending.adapter_id, account.auth_adapter
            ));
        }
        let adapter = self.adapters.get(&pending.adapter_id)?;
        match adapter.continue_login(&pending.state, completion).await? {
            AdapterLoginResult::Pending {
                retry_after_secs,
                state,
            } => {
                pending.state = state;
                self.put_secret(
                    account,
                    login_id,
                    &serde_json::to_string(&pending)
                        .map_err(|error| format!("OAuth 登录状态无法序列化：{error}"))?,
                )?;
                Ok(OAuthLoginProgress::Pending { retry_after_secs })
            }
            AdapterLoginResult::Complete(token) => {
                self.store_token(account, &token)?;
                let _ = self.secret_store.delete(login_id);
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
                Ok(OAuthLoginProgress::Complete {
                    account: token.public_metadata(&pending.account_id),
                })
            }
        }
    }

    pub async fn materialize_authorization(
        &self,
        account_id: &str,
    ) -> Result<RequestAuthorization, String> {
        let account = self.oauth_account(account_id)?;
        let adapter = self.adapters.get(&account.auth_adapter)?;
        let mut token = self.load_token(account)?;
        if token.adapter_id != adapter.id() {
            return Err(format!(
                "Auth Account '{account_id}' 的 Token Adapter '{}' 与配置 '{}' 不一致",
                token.adapter_id,
                adapter.id()
            ));
        }
        if token.needs_refresh(Utc::now()) {
            token = self
                .refresh_token(account_id, account, adapter.as_ref(), token)
                .await?;
        }
        adapter.materialize(&token)
    }

    pub fn account_metadata(&self, account_id: &str) -> Result<OAuthAccountMetadata, String> {
        let account = self.oauth_account(account_id)?;
        Ok(self.load_token(account)?.public_metadata(account_id))
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

    fn oauth_account(&self, account_id: &str) -> Result<&AuthAccountConfig, String> {
        let account = self
            .accounts
            .get(account_id)
            .ok_or_else(|| format!("Auth Account '{account_id}' 不存在"))?;
        if !account.auth_adapter.ends_with("-oauth") {
            return Err(format!(
                "Auth Account '{account_id}' 使用 '{}'，不是 OAuth Adapter",
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
            .map_err(|error| format!("OAuth Token Set 无法序列化：{error}"))?;
        self.put_secret(account, &account.credential_ref, &serialized)
    }

    fn load_token(&self, account: &AuthAccountConfig) -> Result<OAuthTokenSet, String> {
        validate_secret_alias(&account.credential_ref)?;
        let raw = self
            .secret_store
            .resolve(&account.credential_ref, SecretUseContext::default())?
            .ok_or_else(|| {
                format!(
                    "OAuth Auth Account 尚未登录；受管凭证 '{}' 不存在",
                    account.credential_ref
                )
            })?;
        serde_json::from_str(&raw)
            .map_err(|error| format!("OAuth Token Set '{}' 损坏：{error}", account.credential_ref))
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
                "OAuth Auth Account '{account_id}' 没有 Refresh Token"
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
            .map_err(|error| format!("领取 OAuth Refresh Lease 失败：{error}"))?;
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
                        "OAuth Auth Account '{account_id}' 刷新等待超过 {} 秒；可由下一次请求重新领取 Lease",
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
}

impl Default for CodexOAuthAdapter {
    fn default() -> Self {
        Self {
            http: reqwest::Client::new(),
            auth_url: "https://auth.openai.com/oauth/authorize".to_string(),
            token_url: "https://auth.openai.com/oauth/token".to_string(),
            client_id: "app_EMoamEEZ73f0CkXaXp7hrann".to_string(),
            redirect_uri: "http://localhost:1455/auth/callback".to_string(),
        }
    }
}

impl CodexOAuthAdapter {
    /// Construct a Codex-compatible adapter with explicit endpoints. This is
    /// useful for private compatible deployments and deterministic contract
    /// tests; the built-in defaults remain the official Codex endpoints.
    pub fn with_endpoints(
        auth_url: impl Into<String>,
        token_url: impl Into<String>,
        client_id: impl Into<String>,
        redirect_uri: impl Into<String>,
    ) -> Self {
        Self {
            http: reqwest::Client::new(),
            auth_url: auth_url.into(),
            token_url: token_url.into(),
            client_id: client_id.into(),
            redirect_uri: redirect_uri.into(),
        }
    }
}

#[derive(Serialize, Deserialize)]
struct CodexPending {
    state: String,
    verifier: String,
    redirect_uri: String,
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
impl AuthAdapter for CodexOAuthAdapter {
    fn id(&self) -> &'static str {
        CODEX_ADAPTER_ID
    }

    fn version(&self) -> &'static str {
        "cliproxyapi-compatible-2026-08-01"
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
        Some("2026-08-01")
    }

    async fn start_login(&self) -> Result<AdapterLoginStart, String> {
        let verifier = random_base64_url(96)?;
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(verifier.as_bytes()));
        let state = random_base64_url(32)?;
        let mut url = reqwest::Url::parse(&self.auth_url)
            .map_err(|error| format!("Codex OAuth authorize URL 无效：{error}"))?;
        url.query_pairs_mut()
            .append_pair("client_id", &self.client_id)
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", &self.redirect_uri)
            .append_pair("scope", "openid email profile offline_access")
            .append_pair("state", &state)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("prompt", "login")
            .append_pair("id_token_add_organizations", "true")
            .append_pair("codex_cli_simplified_flow", "true");
        Ok(AdapterLoginStart {
            flow: OAuthFlowKind::AuthorizationCodePkce,
            authorization_url: Some(url.to_string()),
            verification_uri: None,
            verification_uri_complete: None,
            user_code: None,
            expires_at: Utc::now() + ChronoDuration::minutes(15),
            poll_interval_secs: 0,
            state: serde_json::to_value(CodexPending {
                state,
                verifier,
                redirect_uri: self.redirect_uri.clone(),
            })
            .map_err(|error| error.to_string())?,
        })
    }

    async fn continue_login(
        &self,
        state: &Value,
        completion: OAuthLoginCompletion,
    ) -> Result<AdapterLoginResult, String> {
        let pending: CodexPending =
            serde_json::from_value(state.clone()).map_err(|error| error.to_string())?;
        let OAuthLoginCompletion::AuthorizationCode {
            code,
            state: returned_state,
        } = completion
        else {
            return Err("Codex OAuth 需要授权码与 state，不能轮询".to_string());
        };
        if returned_state != pending.state {
            return Err("Codex OAuth state 不匹配；拒绝可能的跨站请求伪造".to_string());
        }
        let response = post_token_form(
            &self.http,
            &self.token_url,
            &[
                ("grant_type", "authorization_code"),
                ("client_id", &self.client_id),
                ("code", code.trim()),
                ("redirect_uri", &pending.redirect_uri),
                ("code_verifier", &pending.verifier),
            ],
            &BTreeMap::new(),
        )
        .await?;
        Ok(AdapterLoginResult::Complete(codex_token_set(
            self.version(),
            response,
        )?))
    }

    async fn refresh(&self, current: &OAuthTokenSet) -> Result<OAuthTokenSet, String> {
        let refresh = current
            .refresh_token
            .as_deref()
            .ok_or("Codex OAuth 缺少 Refresh Token")?;
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
        codex_token_set(self.version(), response)
    }

    fn materialize(&self, token: &OAuthTokenSet) -> Result<RequestAuthorization, String> {
        if token.access_token.trim().is_empty() {
            return Err("Codex OAuth Access Token 为空".to_string());
        }
        let account_id = token
            .account_id
            .as_deref()
            .filter(|value| !value.is_empty())
            .ok_or("Codex OAuth Token 缺少 ChatGPT Account ID")?;
        Ok(RequestAuthorization {
            bearer_token: token.access_token.clone(),
            headers: BTreeMap::from([
                ("ChatGPT-Account-ID".to_string(), account_id.to_string()),
                ("Originator".to_string(), "codex-tui".to_string()),
                (
                    "User-Agent".to_string(),
                    "codex-tui/0.146.0 (morphz; oauth)".to_string(),
                ),
            ]),
        })
    }
}

fn codex_token_set(version: &str, response: OAuthTokenResponse) -> Result<OAuthTokenSet, String> {
    if response.access_token.trim().is_empty() {
        return Err("Codex OAuth Token Endpoint 返回空 Access Token".to_string());
    }
    let claims = parse_codex_claims(
        (!response.id_token.is_empty())
            .then_some(response.id_token.as_str())
            .or(Some(response.access_token.as_str())),
    );
    Ok(OAuthTokenSet {
        adapter_id: CODEX_ADAPTER_ID.to_string(),
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
            http: reqwest::Client::new(),
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
            http: reqwest::Client::new(),
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
        Some("2026-08-01")
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
            .map_err(|error| format!("Kimi Device Authorization 请求失败：{error}"))?;
        let status = response.status();
        let body = response
            .bytes()
            .await
            .map_err(|error| format!("Kimi Device Authorization 响应读取失败：{error}"))?;
        if !status.is_success() {
            return Err(format!(
                "Kimi Device Authorization 返回 HTTP {}: {}",
                status,
                safe_error_body(&body)
            ));
        }
        let payload: KimiDeviceCodeResponse = serde_json::from_slice(&body)
            .map_err(|error| format!("Kimi Device Authorization 响应无效：{error}"))?;
        if payload.device_code.is_empty() || payload.user_code.is_empty() {
            return Err("Kimi Device Authorization 缺少 device_code 或 user_code".to_string());
        }
        let interval = payload.interval.max(5) as u64;
        let expires_at = Utc::now() + ChronoDuration::seconds(payload.expires_in.min(900).max(1));
        Ok(AdapterLoginStart {
            flow: OAuthFlowKind::DeviceCode,
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
            return Err("Kimi Device Flow 只能轮询，不能提交授权码".to_string());
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
                "Kimi OAuth 错误 '{}': {}",
                response.error, response.error_description
            )),
            Ok(response) => Ok(AdapterLoginResult::Complete(kimi_token_set(
                self.version(),
                response,
                Some(pending.device_id),
            )?)),
            Err(error) => Err(error),
        }
    }

    async fn refresh(&self, current: &OAuthTokenSet) -> Result<OAuthTokenSet, String> {
        let refresh = current
            .refresh_token
            .as_deref()
            .ok_or("Kimi OAuth 缺少 Refresh Token")?;
        let device_id = current
            .device_id
            .as_deref()
            .ok_or("Kimi OAuth Token 缺少稳定 Device ID")?;
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
            .ok_or("Kimi OAuth Token 缺少稳定 Device ID")?;
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
        return Err("Kimi OAuth Token Endpoint 返回空 Access Token".to_string());
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
        .map_err(|error| format!("OAuth Token 请求失败：{error}"))?;
    let status = response.status();
    let body = response
        .bytes()
        .await
        .map_err(|error| format!("OAuth Token 响应读取失败：{error}"))?;
    let parsed: OAuthTokenResponse = serde_json::from_slice(&body)
        .map_err(|error| format!("OAuth Token 响应无法解析：{error}"))?;
    // RFC 8628 commonly returns pending with HTTP 400, while Kimi currently
    // returns 200. Preserve the structured OAuth error for either behavior.
    if !status.is_success() && parsed.error.is_empty() {
        return Err(format!(
            "OAuth Token Endpoint 返回 HTTP {}: {}",
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
                .map_err(|error| format!("OAuth Header 名称 '{name}' 无效：{error}"))?,
            reqwest::header::HeaderValue::from_str(value)
                .map_err(|error| format!("OAuth Header '{name}' 值无效：{error}"))?,
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

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut value = vec![0_u8; bytes];
    getrandom::fill(&mut value).map_err(|error| format!("操作系统随机数生成失败：{error}"))?;
    Ok(value.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn random_base64_url(bytes: usize) -> Result<String, String> {
    let mut value = vec![0_u8; bytes];
    getrandom::fill(&mut value).map_err(|error| format!("操作系统随机数生成失败：{error}"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value))
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
            "OAuth credential_ref '{value}' 必须是合法的 Secret Store/环境变量别名"
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
    use axum::http::HeaderMap;
    use axum::routing::post;
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
        let manager = Arc::new(
            ProviderAuthManager::new(
                BTreeMap::from([(account_id, account)]),
                Arc::clone(&secret_store),
                account_store,
            )
            .with_registry(registry),
        );
        (directory, manager, secret_store)
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
        id_token: String,
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
    async fn codex_pkce_contract_and_refresh_fencing_are_durable() {
        let refreshes = Arc::new(AtomicUsize::new(0));
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
                id_token,
            });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let adapter = Arc::new(CodexOAuthAdapter::with_endpoints(
            format!("http://{address}/authorize"),
            format!("http://{address}/token"),
            "test-client",
            "http://localhost:1455/auth/callback",
        ));
        let started = adapter.start_login().await.unwrap();
        let authorization_url =
            reqwest::Url::parse(started.authorization_url.as_ref().unwrap()).unwrap();
        let query = authorization_url
            .query_pairs()
            .into_owned()
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            query.get("code_challenge_method").map(String::as_str),
            Some("S256")
        );
        assert_eq!(query.get("prompt").map(String::as_str), Some("login"));
        let state = query.get("state").unwrap().clone();
        let rejected = adapter
            .continue_login(
                &started.state,
                OAuthLoginCompletion::AuthorizationCode {
                    code: "authorization-code".to_string(),
                    state: "wrong-state".to_string(),
                },
            )
            .await;
        assert!(matches!(rejected, Err(error) if error.contains("state 不匹配")));
        let AdapterLoginResult::Complete(token) = adapter
            .continue_login(
                &started.state,
                OAuthLoginCompletion::AuthorizationCode {
                    code: "authorization-code".to_string(),
                    state,
                },
            )
            .await
            .unwrap()
        else {
            panic!("codex authorization code unexpectedly remained pending");
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
            ..token
        };
        manager
            .store_token(manager.account("oauth-account").unwrap(), &expired)
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
}
