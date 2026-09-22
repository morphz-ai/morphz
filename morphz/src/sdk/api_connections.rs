//! API endpoint and credential editing. Secrets never cross the read contract;
//! each save has one effect, so an endpoint failure cannot partly rotate a key.
use super::*;
use crate::config::CredentialSource;
use crate::secret_store::SecretScopeKind;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ApiConnectionSettings {
    pub account_id: String,
    pub base_url: String,
    pub protocol: ModelProtocol,
    pub version: String,
    pub key_editable: bool,
    pub key_unavailable_reason: Option<String>,
    pub endpoint_accounts: Vec<String>,
    pub key_accounts: Vec<String>,
}

// Do not derive Debug: a replacement contains credential material.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ApiConnectionUpdate {
    Endpoint {
        expected_version: String,
        base_url: String,
    },
    Credential {
        expected_version: String,
        api_key: String,
    },
}

fn endpoint(value: &str) -> SdkResult<String> {
    let url = reqwest::Url::parse(value.trim())
        .map_err(|_| SdkError::new(SdkErrorCode::InvalidArgument, "Invalid API endpoint"))?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https"
            || (url.scheme() == "http"
                && matches!(
                    url.host_str(),
                    Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
                )))
    {
        return Err(SdkError::new(SdkErrorCode::InvalidArgument, "API endpoint requires HTTPS (HTTP is allowed for loopback), without credentials, query or fragment"));
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

impl MorphzSdk {
    pub fn api_connection_settings(&self, account_id: &str) -> SdkResult<ApiConnectionSettings> {
        let live = self
            .runtime
            .provider_catalog_config()
            .map_err(SdkError::internal)?;
        let catalog = EffectiveProviderCatalog::from_config(&live).map_err(SdkError::internal)?;
        let account = catalog
            .auth_accounts
            .get(account_id)
            .ok_or_else(|| SdkError::new(SdkErrorCode::NotFound, "API account not found"))?;
        if !matches!(
            account.auth_adapter.as_str(),
            "credential" | "api-key" | "env" | "keychain" | "command" | "none"
        ) {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "OAuth accounts use their login flow, not API credentials",
            ));
        }
        let provider_id = account.provider.as_deref().ok_or_else(|| {
            SdkError::new(SdkErrorCode::InvalidArgument, "Account has no provider")
        })?;
        let provider = catalog
            .provider_instances
            .get(provider_id)
            .ok_or_else(|| SdkError::new(SdkErrorCode::NotFound, "Provider not found"))?;
        let credential = catalog.credentials.get(&account.credential_ref);
        let name = credential
            .filter(|c| c.source == CredentialSource::Env)
            .and_then(|c| c.name.as_deref());
        let secret = self
            .list_managed_secrets()?
            .into_iter()
            .find(|s| Some(s.name.as_str()) == name);
        let key_editable = name.is_some()
            && secret
                .as_ref()
                .is_none_or(|s| s.scope_kind == SecretScopeKind::Runtime && s.scope_id.is_none());
        let endpoint_accounts = catalog
            .auth_accounts
            .iter()
            .filter(|(id, a)| {
                a.provider.as_deref() == Some(provider_id) || provider.accounts.contains(id)
            })
            .map(|(id, a)| a.label.clone().unwrap_or_else(|| id.clone()))
            .collect();
        let key_accounts = catalog
            .auth_accounts
            .iter()
            .filter(|(_, a)| {
                catalog
                    .credentials
                    .get(&a.credential_ref)
                    .and_then(|c| c.name.as_deref())
                    .is_some_and(|n| Some(n) == name)
            })
            .map(|(id, a)| a.label.clone().unwrap_or_else(|| id.clone()))
            .collect::<Vec<_>>();
        let version = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(
                    account,
                    provider,
                    credential,
                    &secret,
                    &endpoint_accounts,
                    &key_accounts
                ))
                .map_err(SdkError::internal)?
            )
        );
        Ok(ApiConnectionSettings {
            account_id: account_id.to_string(),
            base_url: endpoint(&provider.base_url)?,
            protocol: provider.protocol,
            version,
            key_editable,
            key_unavailable_reason: (!key_editable).then(|| {
                "此密钥由外部命令、钥匙串或受限凭据源管理，请在原凭据源中更新。".to_string()
            }),
            endpoint_accounts,
            key_accounts,
        })
    }

    pub async fn update_api_connection(
        &self,
        path: &Path,
        account_id: &str,
        update: ApiConnectionUpdate,
    ) -> SdkResult<ApiConnectionSettings> {
        let _guard = self.provider_settings_lock.lock().await;
        let current = self.api_connection_settings(account_id)?;
        let expected = match &update {
            ApiConnectionUpdate::Endpoint {
                expected_version, ..
            }
            | ApiConnectionUpdate::Credential {
                expected_version, ..
            } => expected_version,
        };
        if expected != &current.version {
            return Err(SdkError::new(
                SdkErrorCode::Conflict,
                "API connection changed; reload before saving",
            ));
        }
        let live = self
            .runtime
            .provider_catalog_config()
            .map_err(SdkError::internal)?;
        let catalog = EffectiveProviderCatalog::from_config(&live).map_err(SdkError::internal)?;
        let account = &catalog.auth_accounts[account_id];
        match update {
            ApiConnectionUpdate::Endpoint { base_url, .. } => {
                let base_url = endpoint(&base_url)?;
                if base_url != current.base_url {
                    let id = account.provider.as_deref().expect("validated provider");
                    let mut provider = catalog.provider_instances[id].clone();
                    provider.base_url = base_url;
                    self.put_provider_instance_config_unlocked(path, id, provider)
                        .await?;
                }
            }
            ApiConnectionUpdate::Credential { api_key, .. } => {
                let api_key = zeroize::Zeroizing::new(api_key);
                let value = api_key.trim();
                if value.is_empty() || value.len() > 16384 || value.chars().any(char::is_control) {
                    return Err(SdkError::new(
                        SdkErrorCode::InvalidArgument,
                        "API key is empty, too long or contains control characters",
                    ));
                }
                if !current.key_editable {
                    return Err(SdkError::new(
                        SdkErrorCode::InvalidArgument,
                        "Credential source is not editable here",
                    ));
                }
                let name = catalog.credentials[&account.credential_ref]
                    .name
                    .clone()
                    .expect("validated credential");
                let existing = self
                    .list_managed_secrets()?
                    .into_iter()
                    .find(|s| s.name == name);
                let backend = existing
                    .map(|s| s.value_backend)
                    .or_else(|| account.secret_backend.clone())
                    .unwrap_or_else(|| self.secret_backend_id().to_string());
                let sdk = self.clone();
                let value = zeroize::Zeroizing::new(value.to_string());
                tokio::task::spawn_blocking(move || {
                    sdk.put_managed_secret_with_backend(
                        &name,
                        value.as_str(),
                        SecretScopeKind::Runtime,
                        None,
                        &backend,
                    )
                })
                .await
                .map_err(|_| {
                    SdkError::new(SdkErrorCode::Internal, "Credential update worker failed")
                })??;
            }
        }
        self.api_connection_settings(account_id)
    }
}
