//! Provider Instance, Auth Account and Model Route resolution.
//!
//! This module is the only compatibility boundary between the former
//! provider+credential input format and the authoritative routed model. Once
//! normalized, evaluation never consults both representations.

use super::auth::ProviderAuthManager;
use super::{resolve_credential, DiscoveredProviderModel, ProtocolClient, ProviderError};
use crate::config::{
    AppConfig, AuthAccountConfig, CredentialConfig, CredentialSource, LlmConfig, ModelProtocol,
    ModelRouteAffinity, ModelRouteCandidateConfig, ModelRouteConfig, ModelRouteSelection,
    PromptCacheStrategy, ProviderConfig, ProviderInstanceConfig,
};
use crate::llm::{
    Client, Message, ModelAttemptBinding, ModelAttemptBindingError, ModelFailure, ModelFailureKind,
    ModelRequestContext, ModelRouteDiagnostic, ModelStreamSender, PromptTokenCount,
    ProviderAccountDiagnostic, ReasoningEffort, Response, ToolDefinition,
};
use crate::memory::{
    ProviderAccountStateMutation, ProviderAccountStateStore, ProviderAccountStatus,
};
use chrono::{Duration as ChronoDuration, Utc};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, RwLock};

const ROUTE_ADAPTER_VERSION: &str = "1";

fn split_discovered_catalog(
    catalog: Vec<DiscoveredProviderModel>,
) -> (
    Vec<String>,
    BTreeMap<String, crate::config::ProviderModelConfig>,
) {
    let mut models = Vec::with_capacity(catalog.len());
    let mut profiles = BTreeMap::new();
    for discovered in catalog {
        let has_capacity = discovered.profile.context_window_tokens.is_some()
            || discovered.profile.max_input_tokens.is_some()
            || discovered.profile.max_output_tokens.is_some()
            || !discovered.profile.model_input_limits().is_unspecified();
        if has_capacity {
            profiles.insert(discovered.id.clone(), discovered.profile);
        }
        models.push(discovered.id);
    }
    (models, profiles)
}

#[derive(Debug, Clone)]
pub struct EffectiveProviderCatalog {
    pub provider_instances: BTreeMap<String, ProviderInstanceConfig>,
    pub auth_accounts: BTreeMap<String, AuthAccountConfig>,
    pub credentials: BTreeMap<String, CredentialConfig>,
    pub model_routes: BTreeMap<String, ModelRouteConfig>,
    aliases: BTreeMap<String, String>,
}

impl EffectiveProviderCatalog {
    pub fn empty() -> Self {
        Self {
            provider_instances: BTreeMap::new(),
            auth_accounts: BTreeMap::new(),
            credentials: BTreeMap::new(),
            model_routes: BTreeMap::new(),
            aliases: BTreeMap::new(),
        }
    }

    pub fn from_config(app: &AppConfig) -> Result<Self, String> {
        let mut provider_instances = app.provider_instances.clone();
        let mut auth_accounts = app.auth_accounts.clone();
        let mut model_routes = app.model_routes.clone();

        // Normalize deployments created before the routed model existed.
        // Legacy and routed entries may coexist while the operator composes a
        // new catalog through the control plane, so normalize every missing
        // legacy provider instead of doing so only while the routed map is
        // completely empty. Explicit routed entries remain authoritative.
        for (provider_id, provider) in &app.providers {
            if !provider_instances.contains_key(provider_id) {
                let account_id = format!("{provider_id}-default");
                let accounts = if let Some(credential_ref) = &provider.credential {
                    auth_accounts
                        .entry(account_id.clone())
                        .or_insert_with(|| AuthAccountConfig {
                            auth_adapter: "credential".to_string(),
                            credential_ref: credential_ref.clone(),
                            secret_backend: None,
                            provider: Some(provider_id.clone()),
                            label: Some(format!("{provider_id} default")),
                            enabled: true,
                        });
                    vec![account_id]
                } else {
                    let account_id = format!("{provider_id}-anonymous");
                    auth_accounts
                        .entry(account_id.clone())
                        .or_insert_with(|| AuthAccountConfig {
                            auth_adapter: "none".to_string(),
                            credential_ref: String::new(),
                            secret_backend: None,
                            provider: Some(provider_id.clone()),
                            label: Some(format!("{provider_id} anonymous")),
                            enabled: true,
                        });
                    vec![account_id]
                };
                provider_instances.insert(
                    provider_id.clone(),
                    ProviderInstanceConfig {
                        adapter: "protocol-compatible".to_string(),
                        protocol: provider.protocol,
                        base_url: provider.base_url.clone(),
                        accounts,
                        models: provider.models.clone(),
                        headers: provider.headers.clone(),
                        env_headers: provider.env_headers.clone(),
                    },
                );
            }
        }

        if model_routes.is_empty() {
            let provider_id = app
                .llm
                .provider
                .as_ref()
                .ok_or("no model Provider is selected; run `morphz setup` first")?;
            if !provider_instances.contains_key(provider_id) {
                return Err(format!("Provider Instance '{provider_id}' is not defined"));
            }
            let mut models = app.llm.models.clone();
            if !models.iter().any(|model| model == &app.llm.model) {
                models.push(app.llm.model.clone());
            }
            for model in models.into_iter().filter(|model| !model.trim().is_empty()) {
                model_routes.insert(
                    model.clone(),
                    ModelRouteConfig {
                        display_alias: None,
                        aliases: Vec::new(),
                        candidates: vec![ModelRouteCandidateConfig {
                            provider: provider_id.clone(),
                            model: model.clone(),
                            priority: 0,
                            account: None,
                            capabilities: Vec::new(),
                        }],
                        affinity: ModelRouteAffinity::Context,
                        selection: ModelRouteSelection::AvailableLeastRecentlyUsed,
                        fallback: false,
                    },
                );
            }
        }

        let mut aliases = BTreeMap::new();
        for (provider_id, provider) in &provider_instances {
            if provider.base_url.trim().is_empty() {
                return Err(format!(
                    "Provider Instance '{provider_id}' has an empty base_url"
                ));
            }
            validate_provider_adapter_protocol(provider_id, provider)?;
            for account_id in &provider.accounts {
                validate_account_for_provider(&auth_accounts, account_id, provider_id)?;
            }
        }
        for (account_id, account) in &auth_accounts {
            if account.auth_adapter.trim().is_empty() {
                return Err(format!(
                    "Auth Account '{account_id}' has an empty auth_adapter"
                ));
            }
            if account.credential_ref.trim().is_empty() && account.auth_adapter != "none" {
                return Err(format!(
                    "Auth Account '{account_id}' has an empty credential_ref"
                ));
            }
            if let Some(provider_id) = account.provider.as_deref() {
                if !provider_instances.contains_key(provider_id) {
                    return Err(format!(
                        "Auth Account '{account_id}' references missing Provider Instance '{provider_id}'"
                    ));
                }
            }
        }
        for (route_id, route) in &model_routes {
            validate_route_id(route_id)?;
            register_alias(&mut aliases, route_id, route_id)?;
            if route.candidates.is_empty() {
                return Err(format!(
                    "Model Route '{route_id}' has no Provider candidates"
                ));
            }
            for alias in &route.aliases {
                register_alias(&mut aliases, alias, route_id)?;
            }
            if let Some(display_alias) = route.display_alias.as_deref() {
                let display_alias = display_alias.trim();
                if display_alias.is_empty() {
                    return Err(format!(
                        "Model Route '{route_id}' has an empty display_alias"
                    ));
                }
                if display_alias != route_id
                    && !route.aliases.iter().any(|alias| alias == display_alias)
                {
                    return Err(format!(
                        "display alias '{display_alias}' is not an available alias of Model Route '{route_id}'"
                    ));
                }
            }
            for candidate in &route.candidates {
                let provider = provider_instances.get(&candidate.provider).ok_or_else(|| {
                    format!(
                        "Model Route '{route_id}' references missing Provider Instance '{}'",
                        candidate.provider
                    )
                })?;
                if candidate.model.trim().is_empty() {
                    return Err(format!(
                        "Model Route '{route_id}' contains an empty physical model name"
                    ));
                }
                if let Some(account_id) = &candidate.account {
                    validate_account_for_provider(&auth_accounts, account_id, &candidate.provider)?;
                } else if provider.accounts.is_empty() {
                    return Err(format!(
                        "Provider Instance '{}' has no Auth Account",
                        candidate.provider
                    ));
                }
            }
        }

        Ok(Self {
            provider_instances,
            auth_accounts,
            credentials: app.credentials.clone(),
            model_routes,
            aliases,
        })
    }

    pub fn resolve_route(&self, alias: &str) -> Result<(&str, &ModelRouteConfig), String> {
        let route_id = self
            .aliases
            .get(alias)
            .ok_or_else(|| format!("model alias '{alias}' has no configured Model Route"))?;
        Ok((
            route_id,
            self.model_routes
                .get(route_id)
                .expect("alias map must reference an existing route"),
        ))
    }
}

fn validate_provider_adapter_protocol(
    provider_id: &str,
    provider: &ProviderInstanceConfig,
) -> Result<(), String> {
    let expected = match provider.adapter.as_str() {
        "openai-codex" => Some(ModelProtocol::OpenaiResponses),
        "kimi-code" => Some(ModelProtocol::OpenaiChat),
        "xai-subscription" => Some(ModelProtocol::OpenaiResponses),
        _ => None,
    };
    if let Some(expected) = expected {
        if provider.protocol != expected {
            return Err(format!(
                "Adapter '{}' of Provider Instance '{provider_id}' requires protocol '{}', found '{}'",
                provider.adapter,
                expected.as_str(),
                provider.protocol.as_str()
            ));
        }
    }
    Ok(())
}

fn validate_route_id(value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err("Model Route ID must not be empty".to_string())
    } else {
        Ok(())
    }
}

fn register_alias(
    aliases: &mut BTreeMap<String, String>,
    alias: &str,
    route_id: &str,
) -> Result<(), String> {
    let alias = alias.trim();
    if alias.is_empty() {
        return Err(format!("Model Route '{route_id}' contains an empty alias"));
    }
    if let Some(existing) = aliases.insert(alias.to_string(), route_id.to_string()) {
        if existing != route_id {
            return Err(format!(
                "model alias '{alias}' belongs to both Route '{existing}' and '{route_id}'"
            ));
        }
    }
    Ok(())
}

fn validate_account_for_provider(
    accounts: &BTreeMap<String, AuthAccountConfig>,
    account_id: &str,
    provider_id: &str,
) -> Result<(), String> {
    let account = accounts.get(account_id).ok_or_else(|| {
        format!("Provider '{provider_id}' references missing account '{account_id}'")
    })?;
    if account
        .provider
        .as_deref()
        .is_some_and(|id| id != provider_id)
    {
        return Err(format!(
            "Auth Account '{account_id}' belongs to Provider '{}', not '{provider_id}'",
            account.provider.as_deref().unwrap_or_default()
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Default)]
struct AccountRuntimeState {
    active: usize,
    last_used: u64,
}

#[derive(Debug, Clone)]
struct DurableAccountAvailability {
    healthy: bool,
    recoverable_static_failure: bool,
    route_revision: Option<u64>,
    status: Option<ProviderAccountStatus>,
    cooldown_until: Option<chrono::DateTime<Utc>>,
    last_error_kind: Option<String>,
    last_used: i64,
}

impl DurableAccountAvailability {
    fn selectable(&self) -> bool {
        self.healthy || self.recoverable_static_failure
    }

    fn summary(&self, account_id: &str, default_enabled: bool) -> String {
        match self.status {
            Some(status) => {
                let mut detail = format!("{account_id}={}", status.as_str());
                if let Some(error) = self.last_error_kind.as_deref() {
                    detail.push_str(&format!("({error})"));
                }
                if let Some(until) = self.cooldown_until {
                    detail.push_str(&format!(" until {until}"));
                }
                detail
            }
            None if default_enabled => format!("{account_id}=ready(default)"),
            None => format!("{account_id}=disabled(config)"),
        }
    }
}

#[derive(Debug, Default)]
struct RoutingState {
    clock: u64,
    accounts: HashMap<String, AccountRuntimeState>,
    affinity: HashMap<String, String>,
}

pub struct RoutedClient {
    catalog: RwLock<EffectiveProviderCatalog>,
    llm: RwLock<LlmConfig>,
    selected_alias: RwLock<String>,
    state: Arc<Mutex<RoutingState>>,
    account_store: RwLock<Option<Arc<dyn ProviderAccountStateStore>>>,
    auth_manager: RwLock<Option<Arc<ProviderAuthManager>>>,
    clients: Mutex<HashMap<String, Arc<ProtocolClient>>>,
}

impl RoutedClient {
    fn validate_agent_model_allowlist(
        catalog: &EffectiveProviderCatalog,
        llm: &LlmConfig,
    ) -> Result<(), String> {
        for configured in &llm.allowed_evaluation_models {
            let alias = configured.trim();
            if alias.is_empty() {
                return Err(
                    "llm.allowed_evaluation_models must not contain an empty model alias"
                        .to_string(),
                );
            }
            catalog.resolve_route(alias).map_err(|error| {
                format!(
                    "model alias '{alias}' in llm.allowed_evaluation_models is unavailable: {error}"
                )
            })?;
        }
        Ok(())
    }

    /// Creates an unconfigured routed client for first-run Dashboard setup.
    /// It cannot evaluate until a catalog is installed, but it retains the
    /// same hot-reload surface as a configured Runtime so the first OAuth/API
    /// account can become usable without replacing the process-local client.
    pub fn empty(llm: LlmConfig) -> Self {
        Self {
            catalog: RwLock::new(EffectiveProviderCatalog::empty()),
            llm: RwLock::new(llm),
            selected_alias: RwLock::new(String::new()),
            state: Arc::new(Mutex::new(RoutingState::default())),
            account_store: RwLock::new(None),
            auth_manager: RwLock::new(None),
            clients: Mutex::new(HashMap::new()),
        }
    }

    pub fn new(app: &AppConfig, selected_alias: String) -> Result<Self, ProviderError> {
        let catalog = EffectiveProviderCatalog::from_config(app)?;
        catalog.resolve_route(&selected_alias)?;
        Self::validate_agent_model_allowlist(&catalog, &app.llm)?;
        Ok(Self {
            catalog: RwLock::new(catalog),
            llm: RwLock::new(app.llm.clone()),
            selected_alias: RwLock::new(selected_alias),
            state: Arc::new(Mutex::new(RoutingState::default())),
            account_store: RwLock::new(None),
            auth_manager: RwLock::new(None),
            clients: Mutex::new(HashMap::new()),
        })
    }

    pub fn primary_binding(&self) -> Result<ModelAttemptBinding, String> {
        let request = ModelRequestContext {
            context_id: "operator".to_string(),
            session_id: "operator".to_string(),
            attempt_id: "startup".to_string(),
            objective_id: None,
            required_capabilities: Vec::new(),
        };
        let alias = self.alias()?;
        let catalog = self.catalog()?;
        let (route_id, route) = catalog.resolve_route(&alias)?;
        let (candidate, account_id) = self
            .select_candidate_and_account_local(&catalog, route_id, route, &request)
            .map_err(|error| error.to_string())?;
        let provider = catalog
            .provider_instances
            .get(&candidate.provider)
            .expect("validated route provider");
        let model_input_limits = provider
            .models
            .get(&candidate.model)
            .map(crate::config::ProviderModelConfig::model_input_limits)
            .unwrap_or_default();
        let protocol = provider.protocol.effective_for_model(&candidate.model);
        Ok(ModelAttemptBinding {
            requested_alias: alias,
            route_id: route_id.to_string(),
            route_revision: Self::route_revision(route_id, route),
            provider_instance_id: candidate.provider,
            auth_account_id: account_id,
            physical_model: candidate.model,
            protocol: protocol.as_str().to_string(),
            provider_adapter: provider.adapter.clone(),
            provider_adapter_version: ROUTE_ADAPTER_VERSION.to_string(),
            endpoint: provider.base_url.clone(),
            capabilities: candidate.capabilities,
            model_input_limits,
        })
    }

    fn binding_from_selection(
        &self,
        catalog: &EffectiveProviderCatalog,
        alias: &str,
        route_id: &str,
        route: &ModelRouteConfig,
        candidate: ModelRouteCandidateConfig,
        account_id: String,
    ) -> ModelAttemptBinding {
        let provider = catalog
            .provider_instances
            .get(&candidate.provider)
            .expect("validated route provider");
        let model_input_limits = provider
            .models
            .get(&candidate.model)
            .map(crate::config::ProviderModelConfig::model_input_limits)
            .unwrap_or_default();
        let protocol = provider.protocol.effective_for_model(&candidate.model);
        ModelAttemptBinding {
            requested_alias: alias.to_string(),
            route_id: route_id.to_string(),
            route_revision: Self::route_revision(route_id, route),
            provider_instance_id: candidate.provider,
            auth_account_id: account_id,
            physical_model: candidate.model,
            protocol: protocol.as_str().to_string(),
            provider_adapter: provider.adapter.clone(),
            provider_adapter_version: ROUTE_ADAPTER_VERSION.to_string(),
            endpoint: provider.base_url.clone(),
            capabilities: candidate.capabilities,
            model_input_limits,
        }
    }

    async fn diagnostic_binding(
        &self,
        alias: &str,
        account_id: Option<&str>,
    ) -> Result<ModelAttemptBinding, String> {
        let catalog = self.catalog()?;
        let (route_id, route) = catalog.resolve_route(alias)?;
        let candidate_and_account = if let Some(account_id) = account_id {
            let account = catalog
                .auth_accounts
                .get(account_id)
                .ok_or_else(|| format!("Auth Account '{account_id}' does not exist"))?;
            let mut candidates = route.candidates.clone();
            candidates.sort_by_key(|candidate| candidate.priority);
            let candidate = candidates
                .into_iter()
                .find(|candidate| {
                    Self::candidate_accounts(&catalog, candidate)
                        .is_ok_and(|accounts| accounts.contains(&account_id))
                })
                .ok_or_else(|| {
                    format!(
                        "Auth Account '{account_id}' does not belong to any candidate of Model Route '{route_id}'"
                    )
                })?;
            if account
                .provider
                .as_deref()
                .is_some_and(|provider| provider != candidate.provider)
            {
                return Err(format!(
                    "Auth Account '{account_id}' does not match candidate Provider '{}'",
                    candidate.provider
                ));
            }
            (candidate, account_id.to_string())
        } else {
            self.select_candidate_and_account(
                &catalog,
                route_id,
                route,
                &ModelRequestContext {
                    context_id: "operator-diagnostic".to_string(),
                    session_id: "operator-diagnostic".to_string(),
                    attempt_id: format!("diagnostic:{route_id}"),
                    objective_id: None,
                    required_capabilities: Vec::new(),
                },
            )
            .await
            .map_err(|error| error.to_string())?
        };
        Ok(self.binding_from_selection(
            &catalog,
            alias,
            route_id,
            route,
            candidate_and_account.0,
            candidate_and_account.1,
        ))
    }

    fn alias(&self) -> Result<String, String> {
        self.selected_alias
            .read()
            .map(|value| value.clone())
            .map_err(|_| "Model Route selection lock is poisoned".to_string())
    }

    fn catalog(&self) -> Result<EffectiveProviderCatalog, String> {
        self.catalog
            .read()
            .map(|catalog| catalog.clone())
            .map_err(|_| "Provider routing table lock is poisoned".to_string())
    }

    fn candidate_accounts<'a>(
        catalog: &'a EffectiveProviderCatalog,
        candidate: &'a ModelRouteCandidateConfig,
    ) -> Result<Vec<&'a str>, String> {
        let provider = catalog
            .provider_instances
            .get(&candidate.provider)
            .ok_or_else(|| format!("Provider Instance '{}' does not exist", candidate.provider))?;
        let ids = candidate
            .account
            .as_deref()
            .map(|id| vec![id])
            .unwrap_or_else(|| provider.accounts.iter().map(String::as_str).collect());
        let mut accounts = Vec::new();
        for id in ids {
            catalog
                .auth_accounts
                .get(id)
                .ok_or_else(|| format!("Auth Account '{id}' does not exist"))?;
            accounts.push(id);
        }
        Ok(accounts)
    }

    fn affinity_key(
        route_id: &str,
        route: &ModelRouteConfig,
        request: &ModelRequestContext,
    ) -> Option<String> {
        let scope = match route.affinity {
            ModelRouteAffinity::None => return None,
            ModelRouteAffinity::Session => &request.session_id,
            ModelRouteAffinity::Context => &request.context_id,
            ModelRouteAffinity::Objective => {
                request.objective_id.as_ref().unwrap_or(&request.context_id)
            }
            ModelRouteAffinity::Explicit => return None,
        };
        Some(format!("{route_id}:{scope}"))
    }

    fn eligible_route_candidates(
        route_id: &str,
        route: &ModelRouteConfig,
        request: &ModelRequestContext,
    ) -> Result<Vec<ModelRouteCandidateConfig>, ModelAttemptBindingError> {
        let mut candidates = route.candidates.clone();
        candidates.sort_by_key(|candidate| candidate.priority);
        candidates.retain(|candidate| {
            request
                .required_capabilities
                .iter()
                .all(|required| candidate.capabilities.iter().any(|item| item == required))
        });
        if candidates.is_empty() {
            return Err(ModelAttemptBindingError::configuration(format!(
                "Model Route '{route_id}' has no candidate satisfying capabilities {:?}",
                request.required_capabilities
            )));
        }

        // Account failover and model fallback are separate authorities. A
        // route may contain several account-pinned targets for the same
        // physical model; those remain eligible by default. Crossing to a
        // different physical model is permitted only when the operator has
        // explicitly enabled fallback for this route.
        if !route.fallback {
            let primary_model = candidates
                .first()
                .expect("non-empty candidates")
                .model
                .clone();
            candidates.retain(|candidate| candidate.model == primary_model);
        }
        Ok(candidates)
    }

    fn select_candidate_and_account_local(
        &self,
        catalog: &EffectiveProviderCatalog,
        route_id: &str,
        route: &ModelRouteConfig,
        request: &ModelRequestContext,
    ) -> Result<(ModelRouteCandidateConfig, String), ModelAttemptBindingError> {
        let candidates = Self::eligible_route_candidates(route_id, route, request)?;

        let affinity_key = Self::affinity_key(route_id, route, request);
        let mut state = self.state.lock().map_err(|_| {
            ModelAttemptBindingError::runtime("account scheduling-state lock is poisoned")
        })?;
        if let Some(account_id) = affinity_key
            .as_ref()
            .and_then(|key| state.affinity.get(key))
            .cloned()
        {
            for candidate in &candidates {
                if Self::candidate_accounts(catalog, candidate)
                    .map_err(ModelAttemptBindingError::configuration)?
                    .contains(&account_id.as_str())
                {
                    return Ok((candidate.clone(), account_id));
                }
            }
        }

        let mut choices = Vec::new();
        for candidate in candidates {
            for account_id in Self::candidate_accounts(catalog, &candidate)
                .map_err(ModelAttemptBindingError::configuration)?
            {
                if !catalog
                    .auth_accounts
                    .get(account_id)
                    .is_some_and(AuthAccountConfig::enabled)
                {
                    continue;
                }
                let runtime = state.accounts.get(account_id).cloned().unwrap_or_default();
                choices.push((
                    candidate.priority,
                    runtime.active,
                    runtime.last_used,
                    candidate.clone(),
                    account_id.to_string(),
                ));
            }
        }
        choices.sort_by_key(
            |(priority, active, last_used, _, _)| match route.selection {
                ModelRouteSelection::Priority => (*priority, 0, 0),
                ModelRouteSelection::AvailableLeastRecentlyUsed => (*priority, *active, *last_used),
            },
        );
        let (_, _, _, candidate, account_id) = choices.into_iter().next().ok_or_else(|| {
            ModelAttemptBindingError::account_unavailable(format!(
                "Model Route '{route_id}' has no enabled Auth Account"
            ))
        })?;
        if let Some(key) = affinity_key {
            state.affinity.insert(key, account_id.clone());
        }
        Ok((candidate, account_id))
    }

    fn account_store(&self) -> Option<Arc<dyn ProviderAccountStateStore>> {
        self.account_store
            .read()
            .ok()
            .and_then(|store| store.clone())
    }

    async fn account_availability(
        store: &dyn ProviderAccountStateStore,
        route_id: &str,
        account_id: &str,
        config: &AuthAccountConfig,
    ) -> Result<DurableAccountAvailability, ModelAttemptBindingError> {
        let account_state =
            store
                .get_provider_account_state(account_id)
                .await
                .map_err(|error| {
                    ModelAttemptBindingError::runtime(format!(
                        "failed to read Provider Account '{account_id}' state: {error}"
                    ))
                })?;
        let route_state = store
            .get_provider_route_account_state(route_id, account_id)
            .await
            .map_err(|error| {
                ModelAttemptBindingError::runtime(format!(
                    "failed to read Model Route '{route_id}' Provider Account '{account_id}' state: {error}"
                ))
            })?;
        let last_used = route_state
            .as_ref()
            .and_then(|state| state.last_used_at)
            .map(|value| value.timestamp_millis())
            .unwrap_or_default();
        // A non-OAuth credential may be changed outside the Runtime (env,
        // keychain, command, managed secret, or a local gateway switching its
        // upstream account). A persisted Invalid(authentication) row cannot
        // prove the current credential is still invalid and must not form a
        // permanent restart-proof dead end. OAuth accounts remain fenced
        // until their explicit login/refresh authority marks them Ready.
        let recoverable_static_failure = config.enabled
            && !config.auth_adapter.ends_with("-oauth")
            && (account_state.as_ref().is_some_and(|state| {
                state.status == ProviderAccountStatus::Invalid
                    && state.last_error_kind.as_deref()
                        == Some(ModelFailureKind::Authentication.as_str())
            }) || route_state.as_ref().is_some_and(|state| {
                (state.status == ProviderAccountStatus::Invalid
                    && state.last_error_kind.as_deref()
                        == Some(ModelFailureKind::Authentication.as_str()))
                    || state.status == ProviderAccountStatus::QuotaExhausted
            }));
        let now = Utc::now();
        let account_healthy = account_state.as_ref().is_none_or(|state| {
            match state.status {
                ProviderAccountStatus::Ready => true,
                ProviderAccountStatus::Refreshing
                | ProviderAccountStatus::Invalid
                | ProviderAccountStatus::Revoked
                | ProviderAccountStatus::Disabled => false,
                // These statuses belonged to the legacy account-global
                // health model. They are deliberately ignored here even
                // before the startup migration cleans them up: throttling
                // and physical-model quota are route-local facts.
                ProviderAccountStatus::RateLimited
                | ProviderAccountStatus::QuotaExhausted
                | ProviderAccountStatus::Cooldown => true,
            }
        });
        let route_healthy = route_state
            .as_ref()
            .is_none_or(|state| state.status.is_selectable(state.cooldown_until, now));
        let diagnostic_state = route_state.as_ref().filter(|state| {
            state.status != ProviderAccountStatus::Ready || state.last_error_kind.is_some()
        });
        let status = diagnostic_state
            .map(|state| state.status)
            .or_else(|| account_state.as_ref().map(|state| state.status));
        let cooldown_until = diagnostic_state
            .and_then(|state| state.cooldown_until)
            .or_else(|| {
                account_state
                    .as_ref()
                    .and_then(|state| state.cooldown_until)
            });
        let last_error_kind = diagnostic_state
            .and_then(|state| state.last_error_kind.clone())
            .or_else(|| {
                account_state
                    .as_ref()
                    .and_then(|state| state.last_error_kind.clone())
            });
        Ok(DurableAccountAvailability {
            healthy: config.enabled && account_healthy && route_healthy,
            recoverable_static_failure,
            route_revision: route_state.as_ref().map(|state| state.revision),
            status,
            cooldown_until,
            last_error_kind,
            last_used,
        })
    }

    async fn select_candidate_and_account(
        &self,
        catalog: &EffectiveProviderCatalog,
        route_id: &str,
        route: &ModelRouteConfig,
        request: &ModelRequestContext,
    ) -> Result<(ModelRouteCandidateConfig, String), ModelAttemptBindingError> {
        let Some(store) = self.account_store() else {
            return self.select_candidate_and_account_local(catalog, route_id, route, request);
        };
        let candidates = Self::eligible_route_candidates(route_id, route, request)?;

        let affinity_scope = Self::affinity_key(route_id, route, request).map(|key| {
            key.strip_prefix(&format!("{route_id}:"))
                .unwrap_or(&key)
                .to_string()
        });
        if let Some(scope_key) = affinity_scope.as_deref() {
            if let Some(affinity) = store
                .get_provider_account_affinity(route_id, scope_key)
                .await
                .map_err(|error| {
                    ModelAttemptBindingError::runtime(format!(
                        "failed to read Model Route affinity: {error}"
                    ))
                })?
            {
                for candidate in &candidates {
                    let Some(account) = catalog.auth_accounts.get(&affinity.account_id) else {
                        continue;
                    };
                    if Self::candidate_accounts(catalog, candidate)
                        .map_err(ModelAttemptBindingError::configuration)?
                        .contains(&affinity.account_id.as_str())
                    {
                        let availability = Self::account_availability(
                            store.as_ref(),
                            route_id,
                            &affinity.account_id,
                            account,
                        )
                        .await?;
                        // A stale static credential/quota failure is a
                        // last-resort probe,
                        // not a sticky preference. Give every healthy account
                        // a chance below before retrying this affinity.
                        if !availability.healthy {
                            continue;
                        }
                        if store
                            .compare_and_set_provider_route_account_state(
                                route_id,
                                &affinity.account_id,
                                ProviderAccountStateMutation {
                                    expected_revision: availability.route_revision,
                                    status: ProviderAccountStatus::Ready,
                                    cooldown_until: None,
                                    last_error_kind: None,
                                    mark_used: true,
                                },
                            )
                            .await
                            .is_ok()
                        {
                            return Ok((candidate.clone(), affinity.account_id));
                        }
                    }
                }
            }
        }

        let local_accounts = self
            .state
            .lock()
            .map_err(|_| {
                ModelAttemptBindingError::runtime("account scheduling-state lock is poisoned")
            })?
            .accounts
            .clone();
        let mut healthy_choices = Vec::new();
        let mut recovery_choices = Vec::new();
        let mut unavailable = Vec::new();
        for candidate in candidates {
            for account_id in Self::candidate_accounts(catalog, &candidate)
                .map_err(ModelAttemptBindingError::configuration)?
            {
                let account = catalog
                    .auth_accounts
                    .get(account_id)
                    .expect("validated route account");
                let availability =
                    Self::account_availability(store.as_ref(), route_id, account_id, account)
                        .await?;
                if !availability.selectable() {
                    unavailable.push(availability.summary(account_id, account.enabled));
                    continue;
                }
                let local = local_accounts.get(account_id).cloned().unwrap_or_default();
                let choice = (
                    candidate.priority,
                    local.active,
                    availability.last_used,
                    local.last_used,
                    candidate.clone(),
                    account_id.to_string(),
                    availability.route_revision,
                );
                if availability.recoverable_static_failure {
                    recovery_choices.push(choice);
                } else {
                    healthy_choices.push(choice);
                }
            }
        }
        let mut choices = if healthy_choices.is_empty() {
            recovery_choices
        } else {
            healthy_choices
        };
        choices.sort_by_key(
            |(priority, active, durable_last_used, local_last_used, _, _, _)| match route.selection
            {
                ModelRouteSelection::Priority => (*priority, 0, 0, 0),
                ModelRouteSelection::AvailableLeastRecentlyUsed => (
                    *priority,
                    *active,
                    *durable_last_used,
                    i64::try_from(*local_last_used).unwrap_or(i64::MAX),
                ),
            },
        );
        let (_, _, _, _, candidate, account_id, expected_revision) =
            choices.into_iter().next().ok_or_else(|| {
                unavailable.sort();
                unavailable.dedup();
                ModelAttemptBindingError::account_unavailable(format!(
                    "Model Route '{route_id}' has no currently available Auth Account{}",
                    if unavailable.is_empty() {
                        String::new()
                    } else {
                        format!("：{}", unavailable.join(", "))
                    }
                ))
            })?;
        let usage_update = store
            .compare_and_set_provider_route_account_state(
                route_id,
                &account_id,
                ProviderAccountStateMutation {
                    expected_revision,
                    status: ProviderAccountStatus::Ready,
                    cooldown_until: None,
                    last_error_kind: None,
                    mark_used: true,
                },
            )
            .await;
        if let Err(error) = usage_update {
            // Another request or an operator may have changed the state after
            // selection. Accept the winner's state only when the account is
            // still healthy; an explicit disable/revoke or a newly observed
            // failure must fence this binding.
            let account = catalog
                .auth_accounts
                .get(&account_id)
                .expect("validated route account");
            let refreshed =
                Self::account_availability(store.as_ref(), route_id, &account_id, account).await?;
            if !refreshed.healthy {
                return Err(ModelAttemptBindingError::runtime(format!(
                    "failed to update Provider Account '{account_id}' usage state: {error}"
                )));
            }
        }
        if let Some(scope_key) = affinity_scope {
            store
                .put_provider_account_affinity(route_id, &scope_key, &account_id)
                .await
                .map_err(|error| {
                    ModelAttemptBindingError::runtime(format!(
                        "failed to write Model Route affinity: {error}"
                    ))
                })?;
        }
        Ok((candidate, account_id))
    }

    fn account_state_after_failure(
        account: Option<&AuthAccountConfig>,
        failure: Option<&ModelFailure>,
    ) -> (
        ProviderAccountStatus,
        Option<chrono::DateTime<Utc>>,
        Option<&'static str>,
    ) {
        match failure.map(|value| value.kind) {
            Some(ModelFailureKind::RateLimited) => (
                ProviderAccountStatus::RateLimited,
                Some(Utc::now() + ChronoDuration::seconds(60)),
                Some(ModelFailureKind::RateLimited.as_str()),
            ),
            Some(ModelFailureKind::Authentication)
                if account.is_some_and(|config| config.auth_adapter.ends_with("-oauth")) =>
            {
                (
                    ProviderAccountStatus::Invalid,
                    None,
                    Some(ModelFailureKind::Authentication.as_str()),
                )
            }
            Some(ModelFailureKind::QuotaExhausted) => (
                ProviderAccountStatus::QuotaExhausted,
                None,
                Some(ModelFailureKind::QuotaExhausted.as_str()),
            ),
            // Static credentials can change outside the Runtime, and a
            // protocol-compatible gateway may be switching an upstream
            // subscription behind one stable Morphz credential. Preserve the
            // diagnostic but never turn one request's 401/403 into a permanent
            // cross-model, cross-restart exclusion. Provider circuit backoff
            // remains the authority for repeated physical failures.
            Some(kind) => (ProviderAccountStatus::Ready, None, Some(kind.as_str())),
            None => (ProviderAccountStatus::Ready, None, Some("unknown")),
        }
    }

    async fn record_account_state_observation(
        &self,
        account_id: &str,
        status: ProviderAccountStatus,
        cooldown_until: Option<chrono::DateTime<Utc>>,
        error_kind: Option<&str>,
        mark_used: bool,
    ) {
        let Some(store) = self.account_store() else {
            return;
        };
        // A request or health probe only contributes an observation. It must
        // not revive an account disabled or revoked by newer operator action.
        let mut last_conflict = None;
        for _ in 0..3 {
            let current = match store.get_provider_account_state(account_id).await {
                Ok(current) => current,
                Err(error) => {
                    tracing::warn!(
                        account_id,
                        error = %error,
                        event_code = "provider.account_state.observation_read_failed",
                        "Failed to read the Provider Account state while recording an observation"
                    );
                    return;
                }
            };
            if current.as_ref().is_some_and(|state| {
                matches!(
                    state.status,
                    ProviderAccountStatus::Disabled | ProviderAccountStatus::Revoked
                )
            }) {
                return;
            }
            let expected_revision = current.as_ref().map(|state| state.revision);
            match store
                .compare_and_set_provider_account_state(
                    account_id,
                    expected_revision,
                    status,
                    cooldown_until,
                    error_kind,
                    mark_used,
                )
                .await
            {
                Ok(_) => return,
                Err(error) => last_conflict = Some(error.to_string()),
            }
        }
        tracing::warn!(
            account_id,
            error = last_conflict.as_deref().unwrap_or("unknown CAS conflict"),
            event_code = "provider.account_state.observation_cas_exhausted",
            "Provider Account observation was not persisted after bounded CAS retries"
        );
    }

    async fn record_route_account_state_observation(
        &self,
        route_id: &str,
        account_id: &str,
        status: ProviderAccountStatus,
        cooldown_until: Option<chrono::DateTime<Utc>>,
        error_kind: Option<&str>,
        mark_used: bool,
    ) {
        let Some(store) = self.account_store() else {
            return;
        };
        let mut last_conflict = None;
        for _ in 0..3 {
            let current = match store
                .get_provider_route_account_state(route_id, account_id)
                .await
            {
                Ok(current) => current,
                Err(error) => {
                    tracing::warn!(
                        route_id,
                        account_id,
                        error = %error,
                        event_code = "provider.route_account_state.observation_read_failed",
                        "Failed to read the Model Route account state while recording an observation"
                    );
                    return;
                }
            };
            let expected_revision = current.as_ref().map(|state| state.revision);
            match store
                .compare_and_set_provider_route_account_state(
                    route_id,
                    account_id,
                    ProviderAccountStateMutation {
                        expected_revision,
                        status,
                        cooldown_until,
                        last_error_kind: error_kind.map(ToOwned::to_owned),
                        mark_used,
                    },
                )
                .await
            {
                Ok(_) => return,
                Err(error) => last_conflict = Some(error.to_string()),
            }
        }
        tracing::warn!(
            route_id,
            account_id,
            error = last_conflict.as_deref().unwrap_or("unknown CAS conflict"),
            event_code = "provider.route_account_state.observation_cas_exhausted",
            "Model Route account observation was not persisted after bounded CAS retries"
        );
    }

    async fn recover_legacy_static_account_state_after_success(&self, account_id: &str) {
        let Some(store) = self.account_store() else {
            return;
        };
        let mut last_conflict = None;
        for _ in 0..3 {
            let current = match store.get_provider_account_state(account_id).await {
                Ok(Some(current)) => current,
                Ok(None) => return,
                Err(error) => {
                    tracing::warn!(
                        account_id,
                        error = %error,
                        event_code = "provider.account_state.legacy_recovery_read_failed",
                        "Failed to read legacy account-global Provider health after a successful static request"
                    );
                    return;
                }
            };
            let is_legacy_transient = matches!(
                current.status,
                ProviderAccountStatus::RateLimited
                    | ProviderAccountStatus::QuotaExhausted
                    | ProviderAccountStatus::Cooldown
            ) || (current.status == ProviderAccountStatus::Invalid
                && current.last_error_kind.as_deref()
                    == Some(ModelFailureKind::Authentication.as_str()));
            if !is_legacy_transient {
                return;
            }
            match store
                .compare_and_set_provider_account_state(
                    account_id,
                    Some(current.revision),
                    ProviderAccountStatus::Ready,
                    None,
                    None,
                    false,
                )
                .await
            {
                Ok(_) => return,
                Err(error) => last_conflict = Some(error.to_string()),
            }
        }
        tracing::warn!(
            account_id,
            error = last_conflict.as_deref().unwrap_or("unknown CAS conflict"),
            event_code = "provider.account_state.legacy_recovery_cas_exhausted",
            "Legacy account-global Provider health was not cleared after bounded CAS retries"
        );
    }

    async fn record_binding_observation(
        &self,
        binding: &ModelAttemptBinding,
        account: Option<&AuthAccountConfig>,
        result: Result<(), &ProviderError>,
    ) {
        let failure = result
            .err()
            .and_then(|error| error.downcast_ref::<ModelFailure>());
        let (status, cooldown_until, error_kind) = if result.is_ok() {
            (ProviderAccountStatus::Ready, None, None)
        } else {
            Self::account_state_after_failure(account, failure)
        };
        let oauth_authentication_failure = failure.is_some_and(|failure| {
            failure.kind == ModelFailureKind::Authentication
                && account.is_some_and(|config| config.auth_adapter.ends_with("-oauth"))
        });
        if oauth_authentication_failure {
            self.record_account_state_observation(
                &binding.auth_account_id,
                status,
                cooldown_until,
                error_kind,
                false,
            )
            .await;
        } else {
            if result.is_ok()
                && account.is_some_and(|config| !config.auth_adapter.ends_with("-oauth"))
            {
                self.recover_legacy_static_account_state_after_success(&binding.auth_account_id)
                    .await;
            }
            self.record_route_account_state_observation(
                &binding.route_id,
                &binding.auth_account_id,
                status,
                cooldown_until,
                error_kind,
                false,
            )
            .await;
        }
    }

    async fn record_account_result(
        &self,
        binding: &ModelAttemptBinding,
        result: &Result<Response, ProviderError>,
    ) {
        let account = self
            .catalog()
            .ok()
            .and_then(|catalog| catalog.auth_accounts.get(&binding.auth_account_id).cloned());
        self.record_binding_observation(binding, account.as_ref(), result.as_ref().map(|_| ()))
            .await;
    }

    fn auth_manager(&self) -> Option<Arc<ProviderAuthManager>> {
        self.auth_manager
            .read()
            .ok()
            .and_then(|manager| manager.clone())
    }

    async fn protocol_client(
        &self,
        binding: &ModelAttemptBinding,
    ) -> Result<Arc<ProtocolClient>, ProviderError> {
        let catalog = self.catalog()?;
        let account = catalog
            .auth_accounts
            .get(&binding.auth_account_id)
            .ok_or_else(|| {
                format!(
                    "Attempt Binding references missing Auth Account '{}'",
                    binding.auth_account_id
                )
            })?;
        let oauth = account.auth_adapter.ends_with("-oauth");
        let cache_key = format!(
            "{}:{}:{}",
            binding.provider_instance_id, binding.auth_account_id, binding.physical_model
        );
        if !oauth {
            if let Some(client) = self
                .clients
                .lock()
                .map_err(|_| "Provider Client cache lock is poisoned")?
                .get(&cache_key)
                .cloned()
            {
                return Ok(client);
            }
        }
        let provider = catalog
            .provider_instances
            .get(&binding.provider_instance_id)
            .ok_or_else(|| {
                format!(
                    "Attempt Binding references missing Provider Instance '{}'",
                    binding.provider_instance_id
                )
            })?;
        let mut headers = provider.headers.clone();
        let credential = match account.auth_adapter.as_str() {
            "none" => None,
            "credential" | "api-key" | "env" | "keychain" | "command" => {
                let config = catalog
                    .credentials
                    .get(&account.credential_ref)
                    .ok_or_else(|| {
                        format!(
                            "Auth Account '{}' references missing Credential '{}'",
                            binding.auth_account_id, account.credential_ref
                        )
                    })?;
                if config.source == CredentialSource::Env {
                    let alias = config.name.as_deref().ok_or_else(|| {
                        format!(
                            "Credential '{}' is missing an environment variable name",
                            account.credential_ref
                        )
                    })?;
                    Some(match self.auth_manager() {
                        Some(manager) => manager
                            .materialize_static_credential(alias)?
                            .ok_or_else(|| {
                                format!(
                                    "Credential '{}' requires managed secret or environment variable {alias}",
                                    account.credential_ref
                                )
                            })?,
                        None => resolve_credential(&account.credential_ref, config)?
                            .ok_or_else(|| {
                                format!("Credential '{}' resolved no value", account.credential_ref)
                            })?,
                    })
                } else {
                    resolve_credential(&account.credential_ref, config)?
                }
            }
            adapter if adapter.ends_with("-oauth") => {
                let manager = self.auth_manager().ok_or_else(|| {
                    format!(
                        "Auth Adapter '{adapter}' is not connected to the Runtime authentication manager; authorization for account '{}' cannot be materialized",
                        binding.auth_account_id
                    )
                })?;
                let authorization = manager
                    .materialize_authorization(&binding.auth_account_id)
                    .await?;
                let supplies_authorization_header = authorization
                    .headers
                    .keys()
                    .any(|name| name.eq_ignore_ascii_case("authorization"));
                headers.extend(authorization.headers);
                (!supplies_authorization_header).then_some(authorization.bearer_token)
            }
            adapter => {
                return Err(format!("Auth Adapter '{adapter}' is not registered").into());
            }
        };
        let physical = ProviderConfig {
            protocol: provider.protocol,
            base_url: provider.base_url.clone(),
            credential: None,
            models: provider.models.clone(),
            headers,
            env_headers: provider.env_headers.clone(),
        };
        let llm = self
            .llm
            .read()
            .map_err(|_| "LLM configuration lock is poisoned")?
            .clone();
        let client = Arc::new(ProtocolClient::new_with_adapter(
            &physical,
            &provider.adapter,
            binding.physical_model.clone(),
            credential,
            &llm,
        )?);
        if !oauth {
            self.clients
                .lock()
                .map_err(|_| "Provider Client cache lock is poisoned")?
                .insert(cache_key, Arc::clone(&client));
        }
        Ok(client)
    }

    fn route_revision(route_id: &str, route: &ModelRouteConfig) -> String {
        let bytes = serde_json::to_vec(&(route_id, route)).unwrap_or_default();
        let digest = Sha256::digest(bytes);
        format!("sha256:{:x}", digest)
    }

    async fn bind_model_attempt_for_alias(
        &self,
        alias: String,
        request: &ModelRequestContext,
    ) -> Result<ModelAttemptBinding, ModelAttemptBindingError> {
        let catalog = self
            .catalog()
            .map_err(ModelAttemptBindingError::configuration)?;
        let (route_id, route) = catalog
            .resolve_route(&alias)
            .map_err(ModelAttemptBindingError::configuration)?;
        let (candidate, account_id) = self
            .select_candidate_and_account(&catalog, route_id, route, request)
            .await?;
        let provider = catalog
            .provider_instances
            .get(&candidate.provider)
            .expect("validated route provider");
        let model_input_limits = provider
            .models
            .get(&candidate.model)
            .map(crate::config::ProviderModelConfig::model_input_limits)
            .unwrap_or_default();
        let protocol = provider.protocol.effective_for_model(&candidate.model);
        Ok(ModelAttemptBinding {
            requested_alias: alias,
            route_id: route_id.to_string(),
            route_revision: Self::route_revision(route_id, route),
            provider_instance_id: candidate.provider,
            auth_account_id: account_id,
            physical_model: candidate.model,
            protocol: protocol.as_str().to_string(),
            provider_adapter: provider.adapter.clone(),
            provider_adapter_version: ROUTE_ADAPTER_VERSION.to_string(),
            endpoint: provider.base_url.clone(),
            capabilities: candidate.capabilities,
            model_input_limits,
        })
    }
}

struct AccountLease {
    account_id: String,
    state: Arc<Mutex<RoutingState>>,
}

impl AccountLease {
    fn acquire(account_id: &str, state: Arc<Mutex<RoutingState>>) -> Result<Self, String> {
        let mut guard = state
            .lock()
            .map_err(|_| "account scheduling-state lock is poisoned".to_string())?;
        guard.clock = guard.clock.saturating_add(1);
        let clock = guard.clock;
        let account = guard.accounts.entry(account_id.to_string()).or_default();
        account.active = account.active.saturating_add(1);
        account.last_used = clock;
        drop(guard);
        Ok(Self {
            account_id: account_id.to_string(),
            state,
        })
    }
}

impl Drop for AccountLease {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(account) = state.accounts.get_mut(&self.account_id) {
                account.active = account.active.saturating_sub(1);
            }
        }
    }
}

#[async_trait::async_trait]
impl Client for RoutedClient {
    fn replace_provider_catalog(&self, config: &AppConfig) -> Result<(), String> {
        let catalog = EffectiveProviderCatalog::from_config(config)?;
        Self::validate_agent_model_allowlist(&catalog, &config.llm)?;
        let selected = self.alias()?;
        if catalog.resolve_route(&selected).is_err() {
            let fallback = if !config.llm.model.trim().is_empty()
                && catalog.resolve_route(config.llm.model.trim()).is_ok()
            {
                config.llm.model.trim()
            } else {
                catalog
                    .model_routes
                    .keys()
                    .next()
                    .map(String::as_str)
                    .ok_or("updated Provider routing table contains no model aliases")?
            };
            catalog.resolve_route(fallback)?;
            *self
                .selected_alias
                .write()
                .map_err(|_| "Model Route selection lock is poisoned".to_string())? =
                fallback.to_string();
        }
        *self
            .catalog
            .write()
            .map_err(|_| "Provider routing table lock is poisoned".to_string())? = catalog;
        *self
            .llm
            .write()
            .map_err(|_| "LLM configuration lock is poisoned".to_string())? = config.llm.clone();
        self.clients
            .lock()
            .map_err(|_| "Provider Client cache lock is poisoned".to_string())?
            .clear();
        if let Ok(mut state) = self.state.lock() {
            state.affinity.clear();
        }
        Ok(())
    }

    fn attach_provider_auth_manager(&self, manager: Arc<ProviderAuthManager>) {
        if let Ok(mut target) = self.auth_manager.write() {
            *target = Some(manager);
        }
    }

    fn attach_provider_account_state_store(&self, store: Arc<dyn ProviderAccountStateStore>) {
        if let Ok(mut target) = self.account_store.write() {
            *target = Some(store);
        }
    }

    fn provider_resource_key(&self) -> String {
        format!("model-route:{}", self.alias().unwrap_or_default())
    }

    fn provider_resource_key_for_requested_model(&self, requested_model: Option<&str>) -> String {
        let requested = requested_model
            .map(str::trim)
            .filter(|model| !model.is_empty())
            .map(ToOwned::to_owned)
            .or_else(|| self.alias().ok())
            .unwrap_or_default();
        let route_id = self
            .catalog()
            .ok()
            .and_then(|catalog| {
                catalog
                    .resolve_route(&requested)
                    .ok()
                    .map(|(route_id, _)| route_id.to_string())
            })
            .unwrap_or(requested);
        format!("model-route:{route_id}")
    }

    fn provider_resource_key_for_binding(&self, binding: &ModelAttemptBinding) -> String {
        format!("model-route:{}", binding.route_id)
    }

    fn prefers_structured_delta_cache_transport(&self, requested_model: Option<&str>) -> bool {
        if !cfg!(feature = "experimental-openai-chatgpt-structured-cache") {
            return false;
        }
        let alias = requested_model
            .map(str::trim)
            .filter(|model| !model.is_empty())
            .map(ToOwned::to_owned)
            .or_else(|| self.alias().ok());
        let Some(alias) = alias else {
            return false;
        };
        let Ok(catalog) = self.catalog() else {
            return false;
        };
        let Ok((_, route)) = catalog.resolve_route(&alias) else {
            return false;
        };
        !route.candidates.is_empty()
            && route.candidates.iter().all(|candidate| {
                let Some(provider) = catalog.provider_instances.get(&candidate.provider) else {
                    return false;
                };
                let strategy = provider
                    .models
                    .get(&candidate.model)
                    .map(|profile| profile.prompt_cache_strategy)
                    .unwrap_or_default();
                provider.protocol.effective_for_model(&candidate.model)
                    == ModelProtocol::OpenaiResponses
                    && strategy == PromptCacheStrategy::ExperimentalStructuredDeltas
            })
    }

    fn supports_async_cancellation(&self) -> bool {
        true
    }

    fn model(&self) -> Option<String> {
        self.alias().ok()
    }

    fn set_model(&self, model: &str) -> Result<(), String> {
        let model = model.trim();
        self.catalog()?.resolve_route(model)?;
        *self
            .selected_alias
            .write()
            .map_err(|_| "Model Route selection lock is poisoned".to_string())? = model.to_string();
        self.llm
            .write()
            .map_err(|_| "LLM configuration lock is poisoned".to_string())?
            .model = model.to_string();
        Ok(())
    }

    fn reasoning_effort(&self) -> Option<ReasoningEffort> {
        self.llm.read().ok().and_then(|llm| llm.reasoning_effort)
    }

    fn set_reasoning_effort(&self, effort: Option<ReasoningEffort>) -> Result<(), String> {
        self.llm
            .write()
            .map_err(|_| "LLM configuration lock is poisoned".to_string())?
            .reasoning_effort = effort;
        self.clients
            .lock()
            .map_err(|_| "Provider Client cache lock is poisoned".to_string())?
            .clear();
        Ok(())
    }

    fn model_is_agent_allowed(&self, model: &str) -> bool {
        let model = model.trim();
        let Ok(llm) = self.llm.read() else {
            return false;
        };
        model == llm.model
            || llm
                .allowed_evaluation_models
                .iter()
                .any(|allowed| allowed.trim() == model)
    }

    async fn bind_model_attempt(
        &self,
        request: &ModelRequestContext,
    ) -> Result<ModelAttemptBinding, ModelAttemptBindingError> {
        let alias = self
            .alias()
            .map_err(ModelAttemptBindingError::configuration)?;
        self.bind_model_attempt_for_alias(alias, request).await
    }

    async fn bind_requested_model_attempt(
        &self,
        request: &ModelRequestContext,
        requested_model: Option<&str>,
    ) -> Result<ModelAttemptBinding, ModelAttemptBindingError> {
        let alias = match requested_model
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(alias) => alias.to_string(),
            None => self
                .alias()
                .map_err(ModelAttemptBindingError::configuration)?,
        };
        self.bind_model_attempt_for_alias(alias, request).await
    }

    async fn diagnose_model_route(
        &self,
        alias: &str,
        account_id: Option<&str>,
    ) -> Result<ModelRouteDiagnostic, ProviderError> {
        let binding = self.diagnostic_binding(alias, account_id).await?;
        let started = std::time::Instant::now();
        let _lease = AccountLease::acquire(&binding.auth_account_id, Arc::clone(&self.state))?;
        let client = self.protocol_client(&binding).await?;
        let (discovered_models, discovered_model_profiles, catalog_error) =
            match client.list_model_catalog().await {
                Ok(catalog) => {
                    let (models, profiles) = split_discovered_catalog(catalog);
                    (models, profiles, None)
                }
                Err(error) => (Vec::new(), BTreeMap::new(), Some(error.to_string())),
            };
        let health_result = client.probe_health().await;
        if self.account_store().is_some() {
            let account = self
                .catalog()
                .ok()
                .and_then(|catalog| catalog.auth_accounts.get(&binding.auth_account_id).cloned());
            self.record_binding_observation(
                &binding,
                account.as_ref(),
                health_result.as_ref().map(|_| ()),
            )
            .await;
        }
        let (health_verified, health_error) = match health_result {
            Ok(()) => (true, None),
            Err(error) => (false, Some(error.to_string())),
        };
        Ok(ModelRouteDiagnostic {
            checked_at: Utc::now(),
            binding,
            elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            discovered_models,
            discovered_model_profiles,
            catalog_error,
            health_verified,
            health_error,
        })
    }

    async fn diagnose_provider_account(
        &self,
        account_id: &str,
        model: Option<&str>,
    ) -> Result<ProviderAccountDiagnostic, ProviderError> {
        let catalog = self.catalog()?;
        let account = catalog
            .auth_accounts
            .get(account_id)
            .ok_or_else(|| format!("Auth Account '{account_id}' does not exist"))?;
        let provider_id = account
            .provider
            .clone()
            .or_else(|| {
                catalog
                    .provider_instances
                    .iter()
                    .find(|(_, provider)| provider.accounts.iter().any(|id| id == account_id))
                    .map(|(provider_id, _)| provider_id.clone())
            })
            .ok_or_else(|| {
                format!("Auth Account '{account_id}' is not associated with a Provider Instance")
            })?;
        let provider = catalog
            .provider_instances
            .get(&provider_id)
            .ok_or_else(|| format!("Provider Instance '{provider_id}' does not exist"))?;
        if !provider.accounts.iter().any(|id| id == account_id) {
            return Err(format!(
                "Auth Account '{account_id}' does not belong to Provider Instance '{provider_id}'"
            )
            .into());
        }

        let requested_model = model
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
        let enabled_model = catalog.model_routes.values().find_map(|route| {
            route.candidates.iter().find_map(|candidate| {
                (candidate.provider == provider_id
                    && candidate.account.as_deref() == Some(account_id))
                .then(|| candidate.model.clone())
            })
        });
        let initial_model = requested_model
            .clone()
            .or(enabled_model.clone())
            .unwrap_or_default();
        let binding_for = |physical_model: String| {
            let model_input_limits = provider
                .models
                .get(&physical_model)
                .map(crate::config::ProviderModelConfig::model_input_limits)
                .unwrap_or_default();
            let protocol = provider.protocol.effective_for_model(&physical_model);
            ModelAttemptBinding {
                requested_alias: physical_model.clone(),
                route_id: format!("account:{account_id}"),
                route_revision: "account-diagnostic-v1".to_string(),
                provider_instance_id: provider_id.clone(),
                auth_account_id: account_id.to_string(),
                physical_model,
                protocol: protocol.as_str().to_string(),
                provider_adapter: provider.adapter.clone(),
                provider_adapter_version: ROUTE_ADAPTER_VERSION.to_string(),
                endpoint: provider.base_url.clone(),
                capabilities: Vec::new(),
                model_input_limits,
            }
        };

        let started = std::time::Instant::now();
        let _lease = AccountLease::acquire(account_id, Arc::clone(&self.state))?;
        let discovery_client = self
            .protocol_client(&binding_for(initial_model.clone()))
            .await?;
        let (discovered_models, discovered_model_profiles, catalog_error) =
            match discovery_client.list_model_catalog().await {
                Ok(catalog) => {
                    let (models, profiles) = split_discovered_catalog(catalog);
                    (models, profiles, None)
                }
                Err(error) => (Vec::new(), BTreeMap::new(), Some(error.to_string())),
            };
        let probed_model = requested_model
            .or_else(|| {
                enabled_model.filter(|model| {
                    discovered_models.is_empty() || discovered_models.contains(model)
                })
            })
            .or_else(|| discovered_models.first().cloned());
        let health_result = if let Some(probed_model) = probed_model.as_deref() {
            Some(
                self.protocol_client(&binding_for(probed_model.to_string()))
                    .await?
                    .probe_health()
                    .await,
            )
        } else {
            None
        };

        if let (true, Some(health_result)) =
            (self.account_store().is_some(), health_result.as_ref())
        {
            let physical_model = probed_model
                .clone()
                .unwrap_or_else(|| initial_model.clone());
            let matching_routes = catalog
                .model_routes
                .iter()
                .filter(|(_, route)| {
                    route.candidates.iter().any(|candidate| {
                        candidate.provider == provider_id
                            && candidate.model == physical_model
                            && (candidate.account.as_deref() == Some(account_id)
                                || (candidate.account.is_none()
                                    && provider.accounts.iter().any(|id| id == account_id)))
                    })
                })
                .map(|(route_id, _)| route_id.clone())
                .collect::<Vec<_>>();
            if matching_routes.is_empty() {
                let diagnostic_binding = binding_for(physical_model);
                self.record_binding_observation(
                    &diagnostic_binding,
                    Some(account),
                    health_result.as_ref().map(|_| ()),
                )
                .await;
            } else {
                for route_id in matching_routes {
                    let mut diagnostic_binding = binding_for(physical_model.clone());
                    diagnostic_binding.requested_alias = route_id.clone();
                    diagnostic_binding.route_id = route_id;
                    self.record_binding_observation(
                        &diagnostic_binding,
                        Some(account),
                        health_result.as_ref().map(|_| ()),
                    )
                    .await;
                }
            }
        }
        let (health_verified, health_error) = match health_result {
            Some(Ok(())) => (true, None),
            Some(Err(error)) => (false, Some(error.to_string())),
            None => (false, None),
        };
        Ok(ProviderAccountDiagnostic {
            checked_at: Utc::now(),
            provider_instance_id: provider_id,
            auth_account_id: account_id.to_string(),
            protocol: provider.protocol.as_str().to_string(),
            provider_adapter: provider.adapter.clone(),
            provider_adapter_version: ROUTE_ADAPTER_VERSION.to_string(),
            endpoint: provider.base_url.clone(),
            elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            discovered_models,
            discovered_model_profiles,
            catalog_error,
            probed_model,
            health_verified,
            health_error,
        })
    }

    async fn count_prompt_tokens(
        &self,
        scope: &str,
        messages: &[Message],
        tools: &[ToolDefinition],
    ) -> Result<Option<PromptTokenCount>, ProviderError> {
        let binding = self
            .bind_model_attempt(&ModelRequestContext {
                context_id: scope.to_string(),
                session_id: scope.to_string(),
                attempt_id: format!("measurement:{scope}"),
                objective_id: None,
                required_capabilities: Vec::new(),
            })
            .await?;
        self.protocol_client(&binding)
            .await?
            .count_prompt_tokens(scope, messages, tools)
            .await
    }

    async fn create_completion(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
    ) -> Result<Response, ProviderError> {
        let binding = self
            .bind_model_attempt(&ModelRequestContext {
                context_id: "operator".to_string(),
                session_id: "operator".to_string(),
                attempt_id: "direct-completion".to_string(),
                objective_id: None,
                required_capabilities: Vec::new(),
            })
            .await?;
        let _lease = AccountLease::acquire(&binding.auth_account_id, Arc::clone(&self.state))?;
        let result = self
            .protocol_client(&binding)
            .await?
            .create_completion(messages, tools)
            .await;
        self.record_account_result(&binding, &result).await;
        result
    }

    async fn create_completion_bound_stream(
        &self,
        binding: &ModelAttemptBinding,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
        measurement: Option<PromptTokenCount>,
        stream: ModelStreamSender,
    ) -> Result<Response, ProviderError> {
        let _lease = AccountLease::acquire(&binding.auth_account_id, Arc::clone(&self.state))?;
        let result = self
            .protocol_client(binding)
            .await?
            .create_completion_measured_stream(messages, tools, measurement, stream)
            .await;
        self.record_account_result(binding, &result).await;
        result
    }

    async fn create_completion_bound_stream_with_options(
        &self,
        binding: &ModelAttemptBinding,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
        measurement: Option<PromptTokenCount>,
        stream: ModelStreamSender,
        options: crate::llm::ModelRequestOptions,
    ) -> Result<Response, ProviderError> {
        let _lease = AccountLease::acquire(&binding.auth_account_id, Arc::clone(&self.state))?;
        let result = self
            .protocol_client(binding)
            .await?
            .create_completion_bound_stream_with_options(
                binding,
                messages,
                tools,
                measurement,
                stream,
                options,
            )
            .await;
        self.record_account_result(binding, &result).await;
        result
    }

    async fn probe_health(&self) -> Result<(), ProviderError> {
        let binding = self
            .bind_model_attempt(&ModelRequestContext {
                context_id: "operator".to_string(),
                session_id: "operator".to_string(),
                attempt_id: "health-probe".to_string(),
                objective_id: None,
                required_capabilities: Vec::new(),
            })
            .await?;
        let _lease = AccountLease::acquire(&binding.auth_account_id, Arc::clone(&self.state))?;
        self.protocol_client(&binding).await?.probe_health().await
    }

    async fn probe_health_bound(&self, binding: &ModelAttemptBinding) -> Result<(), ProviderError> {
        // Keep the logical route frozen while allowing that route's normal
        // account-selection policy to choose a now-healthy account. This
        // prevents a UI model switch from redirecting the probe without
        // pinning recovery forever to the exact account that just failed.
        let probe_binding = self
            .bind_model_attempt_for_alias(
                binding.requested_alias.clone(),
                &ModelRequestContext {
                    context_id: "operator".to_string(),
                    session_id: "operator".to_string(),
                    attempt_id: "health-probe-bound".to_string(),
                    objective_id: None,
                    required_capabilities: Vec::new(),
                },
            )
            .await?;
        let _lease =
            AccountLease::acquire(&probe_binding.auth_account_id, Arc::clone(&self.state))?;
        self.protocol_client(&probe_binding)
            .await?
            .probe_health()
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{CredentialSource, ModelProtocol, ProviderModelConfig};
    use crate::memory::sqlite::SqliteStore;
    use tempfile::NamedTempFile;

    fn routed_config() -> AppConfig {
        let mut app = AppConfig::default();
        app.llm.model = "coding".to_string();
        app.llm.models = vec!["coding".to_string()];
        app.provider_instances.insert(
            "direct".to_string(),
            ProviderInstanceConfig {
                adapter: "openai-compatible".to_string(),
                protocol: ModelProtocol::OpenaiResponses,
                base_url: "http://localhost:8317/v1".to_string(),
                accounts: vec!["account-a".to_string(), "account-b".to_string()],
                models: BTreeMap::from([(
                    "physical-model-alpha".to_string(),
                    ProviderModelConfig {
                        max_input_attachments: Some(48),
                        max_input_attachment_bytes: Some(96 * 1024 * 1024),
                        max_input_attachment_total_bytes: Some(192 * 1024 * 1024),
                        ..ProviderModelConfig::default()
                    },
                )]),
                ..ProviderInstanceConfig::default()
            },
        );
        for id in ["account-a", "account-b"] {
            app.auth_accounts.insert(
                id.to_string(),
                AuthAccountConfig {
                    auth_adapter: "none".to_string(),
                    provider: Some("direct".to_string()),
                    ..AuthAccountConfig::default()
                },
            );
        }
        app.model_routes.insert(
            "coding-primary".to_string(),
            ModelRouteConfig {
                aliases: vec!["coding".to_string()],
                candidates: vec![ModelRouteCandidateConfig {
                    provider: "direct".to_string(),
                    model: "physical-model-alpha".to_string(),
                    priority: 10,
                    ..ModelRouteCandidateConfig::default()
                }],
                affinity: ModelRouteAffinity::Context,
                ..ModelRouteConfig::default()
            },
        );
        app
    }

    #[test]
    fn routed_structured_delta_transport_requires_every_candidate_to_opt_in() {
        let public_config = routed_config();
        let public = RoutedClient::new(&public_config, "coding".to_string()).unwrap();
        assert!(!public.prefers_structured_delta_cache_transport(Some("coding")));

        let mut declared_implicit_config = public_config;
        declared_implicit_config
            .provider_instances
            .get_mut("direct")
            .unwrap()
            .models
            .get_mut("physical-model-alpha")
            .unwrap()
            .prompt_cache_strategy = PromptCacheStrategy::ImplicitPrefix;
        let declared_implicit =
            RoutedClient::new(&declared_implicit_config, "coding".to_string()).unwrap();
        assert!(!declared_implicit.prefers_structured_delta_cache_transport(Some("coding")));

        let mut codex_config = routed_config();
        let provider = codex_config.provider_instances.get_mut("direct").unwrap();
        provider.adapter = "openai-codex".to_string();
        provider
            .models
            .get_mut("physical-model-alpha")
            .unwrap()
            .prompt_cache_strategy = PromptCacheStrategy::Auto;
        let codex = RoutedClient::new(&codex_config, "coding".to_string()).unwrap();
        assert!(!codex.prefers_structured_delta_cache_transport(Some("coding")));

        codex_config
            .provider_instances
            .get_mut("direct")
            .unwrap()
            .models
            .get_mut("physical-model-alpha")
            .unwrap()
            .prompt_cache_strategy = PromptCacheStrategy::ExperimentalStructuredDeltas;
        let structured = RoutedClient::new(&codex_config, "coding".to_string()).unwrap();
        assert_eq!(
            structured.prefers_structured_delta_cache_transport(Some("coding")),
            cfg!(feature = "experimental-openai-chatgpt-structured-cache")
        );

        codex_config
            .provider_instances
            .get_mut("direct")
            .unwrap()
            .models
            .insert(
                "physical-model-beta".to_string(),
                ProviderModelConfig {
                    prompt_cache_strategy: PromptCacheStrategy::ExplicitContentBoundaries,
                    ..ProviderModelConfig::default()
                },
            );
        codex_config
            .model_routes
            .get_mut("coding-primary")
            .unwrap()
            .candidates
            .push(ModelRouteCandidateConfig {
                provider: "direct".to_string(),
                model: "physical-model-beta".to_string(),
                priority: 20,
                ..ModelRouteCandidateConfig::default()
            });
        let mixed = RoutedClient::new(&codex_config, "coding".to_string()).unwrap();
        assert!(!mixed.prefers_structured_delta_cache_transport(Some("coding")));
    }

    #[tokio::test]
    async fn alias_resolves_to_physical_model_and_stable_context_account() {
        let client = RoutedClient::new(&routed_config(), "coding".to_string()).unwrap();
        let request = ModelRequestContext {
            context_id: "context-a".to_string(),
            session_id: "session-a".to_string(),
            attempt_id: "attempt-a".to_string(),
            objective_id: None,
            required_capabilities: Vec::new(),
        };
        let first = client.bind_model_attempt(&request).await.unwrap();
        let second = client
            .bind_model_attempt(&ModelRequestContext {
                attempt_id: "attempt-b".to_string(),
                ..request
            })
            .await
            .unwrap();
        assert_eq!(first.requested_alias, "coding");
        assert_eq!(first.route_id, "coding-primary");
        assert_eq!(first.physical_model, "physical-model-alpha");
        assert_eq!(first.model_input_limits.max_attachments, Some(48));
        assert_eq!(
            first.model_input_limits.max_total_bytes,
            Some(192 * 1024 * 1024)
        );
        assert_eq!(first.auth_account_id, second.auth_account_id);
    }

    #[tokio::test]
    async fn claude_binding_records_the_effective_anthropic_protocol() {
        let mut config = routed_config();
        let provider = config.provider_instances.get_mut("direct").unwrap();
        provider
            .models
            .insert("claude-opus-5".to_string(), ProviderModelConfig::default());
        config
            .model_routes
            .get_mut("coding-primary")
            .unwrap()
            .candidates[0]
            .model = "claude-opus-5".to_string();
        let client = RoutedClient::new(&config, "coding".to_string()).unwrap();
        let binding = client
            .bind_model_attempt(&ModelRequestContext {
                context_id: "context-claude".to_string(),
                session_id: "session-claude".to_string(),
                attempt_id: "attempt-claude".to_string(),
                objective_id: None,
                required_capabilities: Vec::new(),
            })
            .await
            .unwrap();

        assert_eq!(binding.physical_model, "claude-opus-5");
        assert_eq!(binding.protocol, "anthropic-messages");
    }

    #[tokio::test]
    async fn bound_resource_identity_does_not_follow_later_model_selection() {
        let mut config = routed_config();
        config
            .provider_instances
            .get_mut("direct")
            .unwrap()
            .models
            .insert(
                "physical-model-beta".to_string(),
                ProviderModelConfig::default(),
            );
        config.model_routes.insert(
            "review-primary".to_string(),
            ModelRouteConfig {
                aliases: vec!["review".to_string()],
                candidates: vec![ModelRouteCandidateConfig {
                    provider: "direct".to_string(),
                    model: "physical-model-beta".to_string(),
                    priority: 10,
                    ..ModelRouteCandidateConfig::default()
                }],
                ..ModelRouteConfig::default()
            },
        );
        let client = RoutedClient::new(&config, "coding".to_string()).unwrap();
        let binding = client
            .bind_model_attempt(&ModelRequestContext {
                context_id: "context-bound-resource".to_string(),
                session_id: "session-bound-resource".to_string(),
                attempt_id: "attempt-bound-resource".to_string(),
                objective_id: None,
                required_capabilities: Vec::new(),
            })
            .await
            .unwrap();

        client.set_model("review").unwrap();
        assert_eq!(client.provider_resource_key(), "model-route:review");
        assert!(client.model_is_agent_allowed("review"));
        assert!(!client.model_is_agent_allowed("coding"));
        assert_eq!(
            client.provider_resource_key_for_binding(&binding),
            client.provider_resource_key_for_requested_model(Some("coding"))
        );
    }

    #[tokio::test]
    async fn agent_allowlist_selects_an_explicit_route_without_mutating_the_primary_model() {
        let mut config = routed_config();
        config
            .provider_instances
            .get_mut("direct")
            .unwrap()
            .models
            .insert(
                "physical-model-fast".to_string(),
                ProviderModelConfig::default(),
            );
        config.model_routes.insert(
            "fast-route".to_string(),
            ModelRouteConfig {
                candidates: vec![ModelRouteCandidateConfig {
                    provider: "direct".to_string(),
                    model: "physical-model-fast".to_string(),
                    priority: 10,
                    ..ModelRouteCandidateConfig::default()
                }],
                ..ModelRouteConfig::default()
            },
        );
        config.llm.allowed_evaluation_models = vec!["fast-route".to_string()];
        let client = RoutedClient::new(&config, "coding".to_string()).unwrap();
        assert!(client.model_is_agent_allowed("coding"));
        assert!(client.model_is_agent_allowed("fast-route"));
        assert!(!client.model_is_agent_allowed("unlisted-route"));

        let binding = client
            .bind_requested_model_attempt(
                &ModelRequestContext {
                    context_id: "context-explicit-route".to_string(),
                    session_id: "session-explicit-route".to_string(),
                    attempt_id: "attempt-explicit-route".to_string(),
                    objective_id: None,
                    required_capabilities: Vec::new(),
                },
                Some("fast-route"),
            )
            .await
            .unwrap();
        assert_eq!(binding.requested_alias, "fast-route");
        assert_eq!(binding.route_id, "fast-route");
        assert_eq!(binding.physical_model, "physical-model-fast");
        assert_eq!(client.model().as_deref(), Some("coding"));
    }

    #[test]
    fn configured_agent_model_allowlist_rejects_unknown_routes_at_startup() {
        let mut config = routed_config();
        config.llm.allowed_evaluation_models = vec!["missing-route".to_string()];

        let error = RoutedClient::new(&config, "coding".to_string())
            .err()
            .expect("unknown agent-selectable route must fail startup");
        let message = error.to_string();
        assert!(message.contains("allowed_evaluation_models"));
        assert!(message.contains("missing-route"));
    }

    #[tokio::test]
    async fn hot_catalog_replacement_routes_new_oauth_account_without_restart() {
        let initial = routed_config();
        let client = RoutedClient::new(&initial, "coding".to_string()).unwrap();

        let mut updated = initial;
        updated.provider_instances.insert(
            "oauth-provider".to_string(),
            ProviderInstanceConfig {
                adapter: "oauth-test".to_string(),
                protocol: ModelProtocol::OpenaiResponses,
                base_url: "https://api.example.test/v1".to_string(),
                accounts: vec!["oauth-account".to_string()],
                models: BTreeMap::new(),
                ..ProviderInstanceConfig::default()
            },
        );
        updated.auth_accounts.insert(
            "oauth-account".to_string(),
            AuthAccountConfig {
                auth_adapter: "web-test-oauth".to_string(),
                credential_ref: "MORPHZ_OAUTH_TEST_TOKEN".to_string(),
                provider: Some("oauth-provider".to_string()),
                ..AuthAccountConfig::default()
            },
        );
        updated.model_routes.insert(
            "oauth-model".to_string(),
            ModelRouteConfig {
                aliases: vec!["oauth/model".to_string()],
                candidates: vec![ModelRouteCandidateConfig {
                    provider: "oauth-provider".to_string(),
                    account: Some("oauth-account".to_string()),
                    model: "physical-oauth-model".to_string(),
                    ..ModelRouteCandidateConfig::default()
                }],
                ..ModelRouteConfig::default()
            },
        );
        updated.llm.model = "oauth/model".to_string();

        client.replace_provider_catalog(&updated).unwrap();
        client.set_model("oauth/model").unwrap();
        let binding = client
            .bind_model_attempt(&ModelRequestContext {
                context_id: "context-hot-oauth".to_string(),
                session_id: "session-hot-oauth".to_string(),
                attempt_id: "attempt-hot-oauth".to_string(),
                objective_id: None,
                required_capabilities: Vec::new(),
            })
            .await
            .unwrap();

        assert_eq!(binding.provider_instance_id, "oauth-provider");
        assert_eq!(binding.auth_account_id, "oauth-account");
        assert_eq!(binding.physical_model, "physical-oauth-model");
        assert_eq!(binding.endpoint, "https://api.example.test/v1");
    }

    #[tokio::test]
    async fn empty_first_run_client_accepts_its_first_provider_without_restart() {
        let client = RoutedClient::empty(LlmConfig::default());
        let mut configured = routed_config();
        configured.llm.model = "coding".to_string();

        client.replace_provider_catalog(&configured).unwrap();
        let binding = client
            .bind_model_attempt(&ModelRequestContext {
                context_id: "context-first-run".to_string(),
                session_id: "session-first-run".to_string(),
                attempt_id: "attempt-first-run".to_string(),
                objective_id: None,
                required_capabilities: Vec::new(),
            })
            .await
            .unwrap();

        assert_eq!(client.model().as_deref(), Some("coding"));
        assert_eq!(binding.route_id, "coding-primary");
        assert_eq!(binding.provider_instance_id, "direct");
        assert_eq!(binding.physical_model, "physical-model-alpha");
    }

    #[tokio::test]
    async fn durable_account_state_fails_over_without_changing_the_alias() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp_file.path().to_str().unwrap())
                .await
                .unwrap(),
        );
        store
            .put_provider_account_state(
                "account-a",
                None,
                ProviderAccountStatus::Disabled,
                None,
                Some("operator_disabled"),
                false,
            )
            .await
            .unwrap();
        let client = RoutedClient::new(&routed_config(), "coding".to_string()).unwrap();
        client.attach_provider_account_state_store(store);

        let binding = client
            .bind_model_attempt(&ModelRequestContext {
                context_id: "context-failover".into(),
                session_id: "session-failover".into(),
                attempt_id: "attempt-failover".into(),
                objective_id: None,
                required_capabilities: Vec::new(),
            })
            .await
            .unwrap();

        assert_eq!(binding.requested_alias, "coding");
        assert_eq!(binding.physical_model, "physical-model-alpha");
        assert_eq!(binding.auth_account_id, "account-b");
    }

    fn cross_model_fallback_config(fallback: bool) -> AppConfig {
        let mut config = routed_config();
        config
            .provider_instances
            .get_mut("direct")
            .unwrap()
            .models
            .insert(
                "physical-model-beta".to_string(),
                ProviderModelConfig::default(),
            );
        let route = config.model_routes.get_mut("coding-primary").unwrap();
        route.candidates = vec![
            ModelRouteCandidateConfig {
                provider: "direct".to_string(),
                model: "physical-model-alpha".to_string(),
                priority: 0,
                account: Some("account-a".to_string()),
                capabilities: Vec::new(),
            },
            ModelRouteCandidateConfig {
                provider: "direct".to_string(),
                model: "physical-model-beta".to_string(),
                priority: 1,
                account: Some("account-b".to_string()),
                capabilities: Vec::new(),
            },
        ];
        route.fallback = fallback;
        config
    }

    #[tokio::test]
    async fn account_failure_never_switches_physical_model_without_explicit_fallback() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp_file.path().to_str().unwrap())
                .await
                .unwrap(),
        );
        store
            .put_provider_account_state(
                "account-a",
                None,
                ProviderAccountStatus::Disabled,
                None,
                Some("operator_disabled"),
                false,
            )
            .await
            .unwrap();
        let client =
            RoutedClient::new(&cross_model_fallback_config(false), "coding".into()).unwrap();
        client.attach_provider_account_state_store(store);

        let error = client
            .bind_model_attempt(&ModelRequestContext {
                context_id: "context-no-model-fallback".into(),
                session_id: "session-no-model-fallback".into(),
                attempt_id: "attempt-no-model-fallback".into(),
                objective_id: None,
                required_capabilities: Vec::new(),
            })
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            ModelAttemptBindingError::AccountUnavailable(_)
        ));
    }

    #[tokio::test]
    async fn explicit_route_fallback_allows_switching_physical_model() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp_file.path().to_str().unwrap())
                .await
                .unwrap(),
        );
        store
            .put_provider_account_state(
                "account-a",
                None,
                ProviderAccountStatus::Disabled,
                None,
                Some("operator_disabled"),
                false,
            )
            .await
            .unwrap();
        let client =
            RoutedClient::new(&cross_model_fallback_config(true), "coding".into()).unwrap();
        client.attach_provider_account_state_store(store);

        let binding = client
            .bind_model_attempt(&ModelRequestContext {
                context_id: "context-model-fallback".into(),
                session_id: "session-model-fallback".into(),
                attempt_id: "attempt-model-fallback".into(),
                objective_id: None,
                required_capabilities: Vec::new(),
            })
            .await
            .unwrap();

        assert_eq!(binding.physical_model, "physical-model-beta");
        assert_eq!(binding.auth_account_id, "account-b");
    }

    #[tokio::test]
    async fn legacy_static_auth_failure_is_retried_after_restart() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp_file.path().to_str().unwrap())
                .await
                .unwrap(),
        );
        store
            .put_provider_account_state(
                "account-a",
                None,
                ProviderAccountStatus::Invalid,
                None,
                Some(ModelFailureKind::Authentication.as_str()),
                false,
            )
            .await
            .unwrap();
        store
            .put_provider_account_state(
                "account-b",
                None,
                ProviderAccountStatus::Disabled,
                None,
                Some("operator_disabled"),
                false,
            )
            .await
            .unwrap();
        let client = RoutedClient::new(&routed_config(), "coding".to_string()).unwrap();
        client.attach_provider_account_state_store(store.clone());

        let binding = client
            .bind_model_attempt(&ModelRequestContext {
                context_id: "context-static-recovery".into(),
                session_id: "session-static-recovery".into(),
                attempt_id: "attempt-static-recovery".into(),
                objective_id: None,
                required_capabilities: Vec::new(),
            })
            .await
            .unwrap();

        assert_eq!(binding.auth_account_id, "account-a");
        assert_eq!(
            store
                .get_provider_account_state("account-a")
                .await
                .unwrap()
                .unwrap()
                .status,
            ProviderAccountStatus::Invalid
        );
        client
            .record_account_result(
                &binding,
                &Ok(Response {
                    content: "credential recovered".to_string(),
                    tool_calls: Vec::new(),
                }),
            )
            .await;
        assert_eq!(
            store
                .get_provider_account_state("account-a")
                .await
                .unwrap()
                .unwrap()
                .status,
            ProviderAccountStatus::Ready
        );
    }

    #[tokio::test]
    async fn healthy_account_beats_stale_static_auth_affinity() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp_file.path().to_str().unwrap())
                .await
                .unwrap(),
        );
        let client = RoutedClient::new(&routed_config(), "coding".to_string()).unwrap();
        client.attach_provider_account_state_store(store.clone());
        let request = ModelRequestContext {
            context_id: "context-stale-affinity".into(),
            session_id: "session-stale-affinity".into(),
            attempt_id: "attempt-first".into(),
            objective_id: None,
            required_capabilities: Vec::new(),
        };
        let first = client.bind_model_attempt(&request).await.unwrap();
        assert_eq!(first.auth_account_id, "account-a");
        store
            .put_provider_account_state(
                "account-a",
                None,
                ProviderAccountStatus::Invalid,
                None,
                Some(ModelFailureKind::Authentication.as_str()),
                false,
            )
            .await
            .unwrap();

        let second = client
            .bind_model_attempt(&ModelRequestContext {
                attempt_id: "attempt-second".into(),
                ..request
            })
            .await
            .unwrap();

        assert_eq!(second.auth_account_id, "account-b");
    }

    #[tokio::test]
    async fn quota_exhaustion_fails_over_then_route_success_recovers_account() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp_file.path().to_str().unwrap())
                .await
                .unwrap(),
        );
        let client = RoutedClient::new(&routed_config(), "coding".to_string()).unwrap();
        client.attach_provider_account_state_store(store.clone());
        let request = ModelRequestContext {
            context_id: "context-quota-failover".into(),
            session_id: "session-quota-failover".into(),
            attempt_id: "attempt-quota-first".into(),
            objective_id: None,
            required_capabilities: Vec::new(),
        };
        let first = client.bind_model_attempt(&request).await.unwrap();
        assert_eq!(first.auth_account_id, "account-a");
        let selected_state = store
            .get_provider_route_account_state("coding-primary", "account-a")
            .await
            .unwrap()
            .unwrap();
        store
            .compare_and_set_provider_route_account_state(
                "coding-primary",
                "account-a",
                ProviderAccountStateMutation {
                    expected_revision: Some(selected_state.revision),
                    status: ProviderAccountStatus::QuotaExhausted,
                    cooldown_until: None,
                    last_error_kind: Some(ModelFailureKind::QuotaExhausted.as_str().to_string()),
                    mark_used: false,
                },
            )
            .await
            .unwrap();

        let second = client
            .bind_model_attempt(&ModelRequestContext {
                attempt_id: "attempt-quota-second".into(),
                ..request.clone()
            })
            .await
            .unwrap();
        assert_eq!(second.auth_account_id, "account-b");

        store
            .put_provider_account_state(
                "account-b",
                None,
                ProviderAccountStatus::Disabled,
                None,
                Some("operator_disabled"),
                false,
            )
            .await
            .unwrap();
        let third = client
            .bind_model_attempt(&ModelRequestContext {
                attempt_id: "attempt-quota-third".into(),
                ..request
            })
            .await
            .unwrap();
        assert_eq!(third.auth_account_id, "account-a");
        client
            .record_account_result(
                &third,
                &Ok(Response {
                    content: "route recovered".to_string(),
                    tool_calls: Vec::new(),
                }),
            )
            .await;
        assert_eq!(
            store
                .get_provider_route_account_state("coding-primary", "account-a")
                .await
                .unwrap()
                .unwrap()
                .status,
            ProviderAccountStatus::Ready
        );
    }

    #[tokio::test]
    async fn route_failure_does_not_fence_sibling_route_sharing_account() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp_file.path().to_str().unwrap())
                .await
                .unwrap(),
        );
        let mut config = routed_config();
        config
            .model_routes
            .get_mut("coding-primary")
            .unwrap()
            .candidates[0]
            .account = Some("account-a".to_string());
        config
            .provider_instances
            .get_mut("direct")
            .unwrap()
            .models
            .insert(
                "physical-model-beta".to_string(),
                ProviderModelConfig::default(),
            );
        config.model_routes.insert(
            "review-primary".to_string(),
            ModelRouteConfig {
                aliases: vec!["review".to_string()],
                candidates: vec![ModelRouteCandidateConfig {
                    provider: "direct".to_string(),
                    account: Some("account-a".to_string()),
                    model: "physical-model-beta".to_string(),
                    priority: 10,
                    ..ModelRouteCandidateConfig::default()
                }],
                ..ModelRouteConfig::default()
            },
        );
        store
            .compare_and_set_provider_route_account_state(
                "coding-primary",
                "account-a",
                ProviderAccountStateMutation {
                    expected_revision: None,
                    status: ProviderAccountStatus::RateLimited,
                    cooldown_until: Some(Utc::now() + ChronoDuration::minutes(5)),
                    last_error_kind: Some(ModelFailureKind::RateLimited.as_str().to_string()),
                    mark_used: false,
                },
            )
            .await
            .unwrap();
        let client = RoutedClient::new(&config, "coding".to_string()).unwrap();
        client.attach_provider_account_state_store(store.clone());
        let request = ModelRequestContext {
            context_id: "context-route-isolation".into(),
            session_id: "session-route-isolation".into(),
            attempt_id: "attempt-route-isolation".into(),
            objective_id: None,
            required_capabilities: Vec::new(),
        };

        assert!(matches!(
            client.bind_model_attempt(&request).await.unwrap_err(),
            ModelAttemptBindingError::AccountUnavailable(_)
        ));
        let review = client
            .bind_requested_model_attempt(&request, Some("review"))
            .await
            .unwrap();
        assert_eq!(review.route_id, "review-primary");
        assert_eq!(review.auth_account_id, "account-a");
        assert_eq!(review.physical_model, "physical-model-beta");
        assert_eq!(
            store
                .get_provider_route_account_state("coding-primary", "account-a")
                .await
                .unwrap()
                .unwrap()
                .status,
            ProviderAccountStatus::RateLimited
        );
        assert_eq!(
            store
                .get_provider_route_account_state("review-primary", "account-a")
                .await
                .unwrap()
                .unwrap()
                .status,
            ProviderAccountStatus::Ready
        );
    }

    #[tokio::test]
    async fn oauth_auth_failure_remains_fenced_until_login() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp_file.path().to_str().unwrap())
                .await
                .unwrap(),
        );
        let mut config = routed_config();
        let oauth_account = config.auth_accounts.get_mut("account-a").unwrap();
        oauth_account.auth_adapter = "test-oauth".to_string();
        oauth_account.credential_ref = "oauth-token".to_string();
        config.credentials.insert(
            "oauth-token".to_string(),
            CredentialConfig {
                source: CredentialSource::Env,
                name: Some("MORPHZ_TEST_OAUTH_TOKEN".to_string()),
                ..CredentialConfig::default()
            },
        );
        store
            .put_provider_account_state(
                "account-a",
                None,
                ProviderAccountStatus::Invalid,
                None,
                Some(ModelFailureKind::Authentication.as_str()),
                false,
            )
            .await
            .unwrap();
        store
            .put_provider_account_state(
                "account-b",
                None,
                ProviderAccountStatus::Disabled,
                None,
                Some("operator_disabled"),
                false,
            )
            .await
            .unwrap();
        let client = RoutedClient::new(&config, "coding".to_string()).unwrap();
        client.attach_provider_account_state_store(store);

        let error = client
            .bind_model_attempt(&ModelRequestContext {
                context_id: "context-oauth-fenced".into(),
                session_id: "session-oauth-fenced".into(),
                attempt_id: "attempt-oauth-fenced".into(),
                objective_id: None,
                required_capabilities: Vec::new(),
            })
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            ModelAttemptBindingError::AccountUnavailable(_)
        ));
    }

    #[tokio::test]
    async fn in_flight_success_does_not_revive_operator_disabled_account() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp_file.path().to_str().unwrap())
                .await
                .unwrap(),
        );
        let client = RoutedClient::new(&routed_config(), "coding".to_string()).unwrap();
        client.attach_provider_account_state_store(store.clone());
        let binding = client
            .bind_model_attempt(&ModelRequestContext {
                context_id: "context-disable-race".into(),
                session_id: "session-disable-race".into(),
                attempt_id: "attempt-disable-race".into(),
                objective_id: None,
                required_capabilities: Vec::new(),
            })
            .await
            .unwrap();
        store
            .put_provider_account_state(
                &binding.auth_account_id,
                None,
                ProviderAccountStatus::Disabled,
                None,
                Some("operator_disabled"),
                false,
            )
            .await
            .unwrap();

        client
            .record_account_result(
                &binding,
                &Ok(Response {
                    content: "ok".to_string(),
                    tool_calls: Vec::new(),
                }),
            )
            .await;

        assert_eq!(
            store
                .get_provider_account_state(&binding.auth_account_id)
                .await
                .unwrap()
                .unwrap()
                .status,
            ProviderAccountStatus::Disabled
        );
    }

    #[test]
    fn static_and_oauth_auth_failures_have_different_durable_transitions() {
        let static_account = AuthAccountConfig {
            auth_adapter: "credential".to_string(),
            ..AuthAccountConfig::default()
        };
        let oauth_account = AuthAccountConfig {
            auth_adapter: "test-oauth".to_string(),
            ..AuthAccountConfig::default()
        };
        let failure = ModelFailure::new(ModelFailureKind::Authentication, "expired");

        assert_eq!(
            RoutedClient::account_state_after_failure(Some(&static_account), Some(&failure)).0,
            ProviderAccountStatus::Ready
        );
        assert_eq!(
            RoutedClient::account_state_after_failure(Some(&oauth_account), Some(&failure)).0,
            ProviderAccountStatus::Invalid
        );
    }

    #[test]
    fn several_public_aliases_resolve_to_one_logical_route() {
        let mut app = routed_config();
        app.model_routes
            .get_mut("coding-primary")
            .unwrap()
            .aliases
            .push("coding/primary".to_string());
        let catalog = EffectiveProviderCatalog::from_config(&app).unwrap();

        let (short_id, short_route) = catalog.resolve_route("coding").unwrap();
        let (qualified_id, qualified_route) = catalog.resolve_route("coding/primary").unwrap();
        assert_eq!(short_id, "coding-primary");
        assert_eq!(qualified_id, short_id);
        assert_eq!(
            qualified_route.candidates[0].model,
            short_route.candidates[0].model
        );
    }

    #[test]
    fn provider_account_references_are_validated_before_routing() {
        let mut app = routed_config();
        app.provider_instances
            .get_mut("direct")
            .unwrap()
            .accounts
            .push("missing-account".to_string());
        let error = EffectiveProviderCatalog::from_config(&app).unwrap_err();
        assert!(error.contains("missing-account"));
        assert!(error.contains("references missing account"));
    }

    #[test]
    fn known_service_adapters_reject_an_incompatible_wire_protocol() {
        let mut app = routed_config();
        let provider = app.provider_instances.get_mut("direct").unwrap();
        provider.adapter = "openai-codex".to_string();
        provider.protocol = ModelProtocol::OpenaiChat;
        let error = EffectiveProviderCatalog::from_config(&app).unwrap_err();
        assert!(error.contains("openai-codex"));
        assert!(error.contains("openai-responses"));

        let provider = app.provider_instances.get_mut("direct").unwrap();
        provider.adapter = "kimi-code".to_string();
        provider.protocol = ModelProtocol::OpenaiResponses;
        let error = EffectiveProviderCatalog::from_config(&app).unwrap_err();
        assert!(error.contains("kimi-code"));
        assert!(error.contains("openai-chat"));
    }

    #[test]
    fn duplicate_alias_is_rejected() {
        let mut app = routed_config();
        app.model_routes.insert(
            "other".to_string(),
            ModelRouteConfig {
                aliases: vec!["coding".to_string()],
                candidates: vec![ModelRouteCandidateConfig {
                    provider: "direct".to_string(),
                    model: "other".to_string(),
                    ..ModelRouteCandidateConfig::default()
                }],
                ..ModelRouteConfig::default()
            },
        );
        assert!(EffectiveProviderCatalog::from_config(&app)
            .unwrap_err()
            .contains("belongs to both"));
    }

    #[test]
    fn legacy_provider_is_normalized_once() {
        let mut app = AppConfig::default();
        app.llm.provider = Some("legacy".to_string());
        app.llm.model = "model-a".to_string();
        app.providers.insert(
            "legacy".to_string(),
            ProviderConfig {
                protocol: ModelProtocol::OpenaiResponses,
                base_url: "http://localhost/v1".to_string(),
                ..ProviderConfig::default()
            },
        );
        let catalog = EffectiveProviderCatalog::from_config(&app).unwrap();
        assert!(catalog.provider_instances.contains_key("legacy"));
        assert!(catalog.resolve_route("model-a").is_ok());
    }

    #[test]
    fn credential_source_enum_remains_usable_by_normalized_accounts() {
        let credential = CredentialConfig {
            source: CredentialSource::None,
            ..CredentialConfig::default()
        };
        assert_eq!(credential.source, CredentialSource::None);
    }
}
