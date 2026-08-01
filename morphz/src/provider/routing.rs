//! Provider Instance, Auth Account and Model Route resolution.
//!
//! This module is the only compatibility boundary between the former
//! provider+credential input format and the authoritative routed model. Once
//! normalized, evaluation never consults both representations.

use super::auth::ProviderAuthManager;
use super::{resolve_credential, ProtocolClient, ProviderError};
use crate::config::{
    AppConfig, AuthAccountConfig, CredentialConfig, LlmConfig, ModelProtocol, ModelRouteAffinity,
    ModelRouteCandidateConfig, ModelRouteConfig, ModelRouteSelection, ProviderConfig,
    ProviderInstanceConfig,
};
use crate::llm::{
    Client, Message, ModelAttemptBinding, ModelFailure, ModelFailureKind, ModelRequestContext,
    ModelRouteDiagnostic, ModelStreamSender, PromptTokenCount, ReasoningEffort, Response,
    ToolDefinition,
};
use crate::memory::{ProviderAccountStateStore, ProviderAccountStatus};
use chrono::{Duration as ChronoDuration, Utc};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, RwLock};

const ROUTE_ADAPTER_VERSION: &str = "1";

#[derive(Debug, Clone)]
pub struct EffectiveProviderCatalog {
    pub provider_instances: BTreeMap<String, ProviderInstanceConfig>,
    pub auth_accounts: BTreeMap<String, AuthAccountConfig>,
    pub credentials: BTreeMap<String, CredentialConfig>,
    pub model_routes: BTreeMap<String, ModelRouteConfig>,
    aliases: BTreeMap<String, String>,
}

impl EffectiveProviderCatalog {
    pub fn from_config(app: &AppConfig) -> Result<Self, String> {
        let mut provider_instances = app.provider_instances.clone();
        let mut auth_accounts = app.auth_accounts.clone();
        let mut model_routes = app.model_routes.clone();

        // One-time input normalization for deployments created before the
        // routed model existed. The generated objects are authoritative for
        // the rest of this process; callers never fall back per request.
        if provider_instances.is_empty() {
            for (provider_id, provider) in &app.providers {
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
                .ok_or("尚未选择模型 Provider；请先运行 `morphz setup`")?;
            if !provider_instances.contains_key(provider_id) {
                return Err(format!("Provider Instance '{provider_id}' 未定义"));
            }
            let mut models = app.llm.models.clone();
            if !models.iter().any(|model| model == &app.llm.model) {
                models.push(app.llm.model.clone());
            }
            for model in models.into_iter().filter(|model| !model.trim().is_empty()) {
                model_routes.insert(
                    model.clone(),
                    ModelRouteConfig {
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
                    "Provider Instance '{provider_id}' 的 base_url 不能为空"
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
                    "Auth Account '{account_id}' 的 auth_adapter 不能为空"
                ));
            }
            if account.credential_ref.trim().is_empty() && account.auth_adapter != "none" {
                return Err(format!(
                    "Auth Account '{account_id}' 的 credential_ref 不能为空"
                ));
            }
            if let Some(provider_id) = account.provider.as_deref() {
                if !provider_instances.contains_key(provider_id) {
                    return Err(format!(
                        "Auth Account '{account_id}' 引用了不存在的 Provider Instance '{provider_id}'"
                    ));
                }
            }
        }
        for (route_id, route) in &model_routes {
            validate_route_id(route_id)?;
            register_alias(&mut aliases, route_id, route_id)?;
            if route.candidates.is_empty() {
                return Err(format!("Model Route '{route_id}' 没有候选 Provider"));
            }
            for alias in &route.aliases {
                register_alias(&mut aliases, alias, route_id)?;
            }
            for candidate in &route.candidates {
                let provider = provider_instances.get(&candidate.provider).ok_or_else(|| {
                    format!(
                        "Model Route '{route_id}' 引用了不存在的 Provider Instance '{}'",
                        candidate.provider
                    )
                })?;
                if candidate.model.trim().is_empty() {
                    return Err(format!("Model Route '{route_id}' 包含空物理模型名"));
                }
                if let Some(account_id) = &candidate.account {
                    validate_account_for_provider(&auth_accounts, account_id, &candidate.provider)?;
                } else if provider.accounts.is_empty() {
                    return Err(format!(
                        "Provider Instance '{}' 没有 Auth Account",
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
            .ok_or_else(|| format!("模型别名 '{alias}' 未配置 Model Route"))?;
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
        _ => None,
    };
    if let Some(expected) = expected {
        if provider.protocol != expected {
            return Err(format!(
                "Provider Instance '{provider_id}' 的 Adapter '{}' 需要协议 '{}'，当前为 '{}'",
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
        Err("Model Route ID 不能为空".to_string())
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
        return Err(format!("Model Route '{route_id}' 包含空别名"));
    }
    if let Some(existing) = aliases.insert(alias.to_string(), route_id.to_string()) {
        if existing != route_id {
            return Err(format!(
                "模型别名 '{alias}' 同时属于 Route '{existing}' 与 '{route_id}'"
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
    let account = accounts
        .get(account_id)
        .ok_or_else(|| format!("Provider '{provider_id}' 引用了不存在的账号 '{account_id}'"))?;
    if account
        .provider
        .as_deref()
        .is_some_and(|id| id != provider_id)
    {
        return Err(format!(
            "Auth Account '{account_id}' 属于 Provider '{}' 而不是 '{provider_id}'",
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

#[derive(Debug, Default)]
struct RoutingState {
    clock: u64,
    accounts: HashMap<String, AccountRuntimeState>,
    affinity: HashMap<String, String>,
}

pub struct RoutedClient {
    catalog: EffectiveProviderCatalog,
    llm: RwLock<LlmConfig>,
    selected_alias: RwLock<String>,
    state: Arc<Mutex<RoutingState>>,
    account_store: RwLock<Option<Arc<dyn ProviderAccountStateStore>>>,
    auth_manager: RwLock<Option<Arc<ProviderAuthManager>>>,
    clients: Mutex<HashMap<String, Arc<ProtocolClient>>>,
}

impl RoutedClient {
    pub fn new(app: &AppConfig, selected_alias: String) -> Result<Self, ProviderError> {
        let catalog = EffectiveProviderCatalog::from_config(app)?;
        catalog.resolve_route(&selected_alias)?;
        Ok(Self {
            catalog,
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
        let (route_id, route) = self.catalog.resolve_route(&alias)?;
        let (candidate, account_id) =
            self.select_candidate_and_account_local(route_id, route, &request)?;
        let provider = self
            .catalog
            .provider_instances
            .get(&candidate.provider)
            .expect("validated route provider");
        Ok(ModelAttemptBinding {
            requested_alias: alias,
            route_id: route_id.to_string(),
            route_revision: Self::route_revision(route_id, route),
            provider_instance_id: candidate.provider,
            auth_account_id: account_id,
            physical_model: candidate.model,
            protocol: provider.protocol.as_str().to_string(),
            provider_adapter: provider.adapter.clone(),
            provider_adapter_version: ROUTE_ADAPTER_VERSION.to_string(),
            endpoint: provider.base_url.clone(),
            capabilities: candidate.capabilities,
        })
    }

    fn binding_from_selection(
        &self,
        alias: &str,
        route_id: &str,
        route: &ModelRouteConfig,
        candidate: ModelRouteCandidateConfig,
        account_id: String,
    ) -> ModelAttemptBinding {
        let provider = self
            .catalog
            .provider_instances
            .get(&candidate.provider)
            .expect("validated route provider");
        ModelAttemptBinding {
            requested_alias: alias.to_string(),
            route_id: route_id.to_string(),
            route_revision: Self::route_revision(route_id, route),
            provider_instance_id: candidate.provider,
            auth_account_id: account_id,
            physical_model: candidate.model,
            protocol: provider.protocol.as_str().to_string(),
            provider_adapter: provider.adapter.clone(),
            provider_adapter_version: ROUTE_ADAPTER_VERSION.to_string(),
            endpoint: provider.base_url.clone(),
            capabilities: candidate.capabilities,
        }
    }

    async fn diagnostic_binding(
        &self,
        alias: &str,
        account_id: Option<&str>,
    ) -> Result<ModelAttemptBinding, String> {
        let (route_id, route) = self.catalog.resolve_route(alias)?;
        let candidate_and_account = if let Some(account_id) = account_id {
            let account = self
                .catalog
                .auth_accounts
                .get(account_id)
                .ok_or_else(|| format!("Auth Account '{account_id}' 不存在"))?;
            let mut candidates = route.candidates.clone();
            candidates.sort_by_key(|candidate| candidate.priority);
            let candidate = candidates
                .into_iter()
                .find(|candidate| {
                    self.candidate_accounts(candidate)
                        .is_ok_and(|accounts| accounts.contains(&account_id))
                })
                .ok_or_else(|| {
                    format!(
                        "Auth Account '{account_id}' 不属于 Model Route '{route_id}' 的任何候选"
                    )
                })?;
            if account
                .provider
                .as_deref()
                .is_some_and(|provider| provider != candidate.provider)
            {
                return Err(format!(
                    "Auth Account '{account_id}' 与候选 Provider '{}' 不匹配",
                    candidate.provider
                ));
            }
            (candidate, account_id.to_string())
        } else {
            self.select_candidate_and_account(
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
            .await?
        };
        Ok(self.binding_from_selection(
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
            .map_err(|_| "Model Route 选择锁已损坏".to_string())
    }

    fn candidate_accounts<'a>(
        &'a self,
        candidate: &'a ModelRouteCandidateConfig,
    ) -> Result<Vec<&'a str>, String> {
        let provider = self
            .catalog
            .provider_instances
            .get(&candidate.provider)
            .ok_or_else(|| format!("Provider Instance '{}' 不存在", candidate.provider))?;
        let ids = candidate
            .account
            .as_deref()
            .map(|id| vec![id])
            .unwrap_or_else(|| provider.accounts.iter().map(String::as_str).collect());
        let mut accounts = Vec::new();
        for id in ids {
            self.catalog
                .auth_accounts
                .get(id)
                .ok_or_else(|| format!("Auth Account '{id}' 不存在"))?;
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

    fn select_candidate_and_account_local(
        &self,
        route_id: &str,
        route: &ModelRouteConfig,
        request: &ModelRequestContext,
    ) -> Result<(ModelRouteCandidateConfig, String), String> {
        let mut candidates = route.candidates.clone();
        candidates.sort_by_key(|candidate| candidate.priority);
        candidates.retain(|candidate| {
            request
                .required_capabilities
                .iter()
                .all(|required| candidate.capabilities.iter().any(|item| item == required))
        });
        if candidates.is_empty() {
            return Err(format!(
                "Model Route '{route_id}' 没有满足能力 {:?} 的候选",
                request.required_capabilities
            ));
        }

        let affinity_key = Self::affinity_key(route_id, route, request);
        let mut state = self
            .state
            .lock()
            .map_err(|_| "账号调度状态锁已损坏".to_string())?;
        if let Some(account_id) = affinity_key
            .as_ref()
            .and_then(|key| state.affinity.get(key))
            .cloned()
        {
            for candidate in &candidates {
                if self
                    .candidate_accounts(candidate)?
                    .contains(&account_id.as_str())
                {
                    return Ok((candidate.clone(), account_id));
                }
            }
        }

        let mut choices = Vec::new();
        for candidate in candidates {
            for account_id in self.candidate_accounts(&candidate)? {
                if !self
                    .catalog
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
        let (_, _, _, candidate, account_id) = choices
            .into_iter()
            .next()
            .ok_or_else(|| format!("Model Route '{route_id}' 没有启用的 Auth Account"))?;
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

    async fn account_is_selectable(
        store: &dyn ProviderAccountStateStore,
        account_id: &str,
        default_enabled: bool,
    ) -> Result<(bool, i64), String> {
        let state = store
            .get_provider_account_state(account_id)
            .await
            .map_err(|error| format!("读取 Provider Account '{account_id}' 状态失败: {error}"))?;
        let Some(state) = state else {
            return Ok((default_enabled, 0));
        };
        let last_used = state
            .last_used_at
            .map(|value| value.timestamp_millis())
            .unwrap_or_default();
        Ok((
            state.status.is_selectable(state.cooldown_until, Utc::now()),
            last_used,
        ))
    }

    async fn select_candidate_and_account(
        &self,
        route_id: &str,
        route: &ModelRouteConfig,
        request: &ModelRequestContext,
    ) -> Result<(ModelRouteCandidateConfig, String), String> {
        let Some(store) = self.account_store() else {
            return self.select_candidate_and_account_local(route_id, route, request);
        };
        let mut candidates = route.candidates.clone();
        candidates.sort_by_key(|candidate| candidate.priority);
        candidates.retain(|candidate| {
            request
                .required_capabilities
                .iter()
                .all(|required| candidate.capabilities.iter().any(|item| item == required))
        });
        if candidates.is_empty() {
            return Err(format!(
                "Model Route '{route_id}' 没有满足能力 {:?} 的候选",
                request.required_capabilities
            ));
        }

        let affinity_scope = Self::affinity_key(route_id, route, request).map(|key| {
            key.strip_prefix(&format!("{route_id}:"))
                .unwrap_or(&key)
                .to_string()
        });
        if let Some(scope_key) = affinity_scope.as_deref() {
            if let Some(affinity) = store
                .get_provider_account_affinity(route_id, scope_key)
                .await
                .map_err(|error| format!("读取 Model Route 亲和失败: {error}"))?
            {
                for candidate in &candidates {
                    let default_enabled = self
                        .catalog
                        .auth_accounts
                        .get(&affinity.account_id)
                        .is_some_and(AuthAccountConfig::enabled);
                    if self
                        .candidate_accounts(candidate)?
                        .contains(&affinity.account_id.as_str())
                        && Self::account_is_selectable(
                            store.as_ref(),
                            &affinity.account_id,
                            default_enabled,
                        )
                        .await?
                        .0
                    {
                        let _ = store
                            .put_provider_account_state(
                                &affinity.account_id,
                                None,
                                ProviderAccountStatus::Ready,
                                None,
                                None,
                                true,
                            )
                            .await;
                        return Ok((candidate.clone(), affinity.account_id));
                    }
                }
            }
        }

        let local_accounts = self
            .state
            .lock()
            .map_err(|_| "账号调度状态锁已损坏".to_string())?
            .accounts
            .clone();
        let mut choices = Vec::new();
        for candidate in candidates {
            for account_id in self.candidate_accounts(&candidate)? {
                let default_enabled = self
                    .catalog
                    .auth_accounts
                    .get(account_id)
                    .is_some_and(AuthAccountConfig::enabled);
                let (selectable, durable_last_used) =
                    Self::account_is_selectable(store.as_ref(), account_id, default_enabled)
                        .await?;
                if !selectable {
                    continue;
                }
                let local = local_accounts.get(account_id).cloned().unwrap_or_default();
                choices.push((
                    candidate.priority,
                    local.active,
                    durable_last_used,
                    local.last_used,
                    candidate.clone(),
                    account_id.to_string(),
                ));
            }
        }
        choices.sort_by_key(
            |(priority, active, durable_last_used, local_last_used, _, _)| match route.selection {
                ModelRouteSelection::Priority => (*priority, 0, 0, 0),
                ModelRouteSelection::AvailableLeastRecentlyUsed => (
                    *priority,
                    *active,
                    *durable_last_used,
                    i64::try_from(*local_last_used).unwrap_or(i64::MAX),
                ),
            },
        );
        let (_, _, _, _, candidate, account_id) = choices
            .into_iter()
            .next()
            .ok_or_else(|| format!("Model Route '{route_id}' 没有当前可用的 Auth Account"))?;
        if let Some(scope_key) = affinity_scope {
            store
                .put_provider_account_affinity(route_id, &scope_key, &account_id)
                .await
                .map_err(|error| format!("写入 Model Route 亲和失败: {error}"))?;
        }
        store
            .put_provider_account_state(
                &account_id,
                None,
                ProviderAccountStatus::Ready,
                None,
                None,
                true,
            )
            .await
            .map_err(|error| {
                format!("更新 Provider Account '{account_id}' 使用状态失败: {error}")
            })?;
        Ok((candidate, account_id))
    }

    async fn record_account_result(
        &self,
        account_id: &str,
        result: &Result<Response, ProviderError>,
    ) {
        let Some(store) = self.account_store() else {
            return;
        };
        let (status, cooldown_until, error_kind) = match result {
            Ok(_) => (ProviderAccountStatus::Ready, None, None),
            Err(error) => {
                let failure = error.downcast_ref::<ModelFailure>();
                match failure.map(|value| value.kind) {
                    Some(ModelFailureKind::RateLimited) => (
                        ProviderAccountStatus::RateLimited,
                        Some(Utc::now() + ChronoDuration::seconds(60)),
                        Some(ModelFailureKind::RateLimited.as_str()),
                    ),
                    Some(ModelFailureKind::Authentication) => (
                        ProviderAccountStatus::Invalid,
                        None,
                        Some(ModelFailureKind::Authentication.as_str()),
                    ),
                    Some(kind) => (ProviderAccountStatus::Ready, None, Some(kind.as_str())),
                    None => (ProviderAccountStatus::Ready, None, Some("unknown")),
                }
            }
        };
        let _ = store
            .put_provider_account_state(account_id, None, status, cooldown_until, error_kind, false)
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
        let account = self
            .catalog
            .auth_accounts
            .get(&binding.auth_account_id)
            .ok_or_else(|| {
                format!(
                    "Attempt Binding 引用了不存在的 Auth Account '{}'",
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
                .map_err(|_| "Provider Client 缓存锁已损坏")?
                .get(&cache_key)
                .cloned()
            {
                return Ok(client);
            }
        }
        let provider = self
            .catalog
            .provider_instances
            .get(&binding.provider_instance_id)
            .ok_or_else(|| {
                format!(
                    "Attempt Binding 引用了不存在的 Provider Instance '{}'",
                    binding.provider_instance_id
                )
            })?;
        let mut headers = provider.headers.clone();
        let credential = match account.auth_adapter.as_str() {
            "none" => None,
            "credential" | "api-key" | "env" | "keychain" | "command" => {
                let config = self
                    .catalog
                    .credentials
                    .get(&account.credential_ref)
                    .ok_or_else(|| {
                        format!(
                            "Auth Account '{}' 引用了不存在的 Credential '{}'",
                            binding.auth_account_id, account.credential_ref
                        )
                    })?;
                resolve_credential(&account.credential_ref, config)?
            }
            adapter if adapter.ends_with("-oauth") => {
                let manager = self.auth_manager().ok_or_else(|| {
                    format!(
                        "Auth Adapter '{adapter}' 尚未连接 Runtime 认证管理器；账号 '{}' 无法物化授权",
                        binding.auth_account_id
                    )
                })?;
                let authorization = manager
                    .materialize_authorization(&binding.auth_account_id)
                    .await?;
                headers.extend(authorization.headers);
                Some(authorization.bearer_token)
            }
            adapter => {
                return Err(format!("Auth Adapter '{adapter}' 尚未注册").into());
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
        let llm = self.llm.read().map_err(|_| "LLM 配置锁已损坏")?.clone();
        let client = Arc::new(ProtocolClient::new(
            &physical,
            binding.physical_model.clone(),
            credential,
            &llm,
        )?);
        if !oauth {
            self.clients
                .lock()
                .map_err(|_| "Provider Client 缓存锁已损坏")?
                .insert(cache_key, Arc::clone(&client));
        }
        Ok(client)
    }

    fn route_revision(route_id: &str, route: &ModelRouteConfig) -> String {
        let bytes = serde_json::to_vec(&(route_id, route)).unwrap_or_default();
        let digest = Sha256::digest(bytes);
        format!("sha256:{:x}", digest)
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
            .map_err(|_| "账号调度状态锁已损坏".to_string())?;
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

    fn supports_async_cancellation(&self) -> bool {
        true
    }

    fn model(&self) -> Option<String> {
        self.alias().ok()
    }

    fn set_model(&self, model: &str) -> Result<(), String> {
        let model = model.trim();
        self.catalog.resolve_route(model)?;
        *self
            .selected_alias
            .write()
            .map_err(|_| "Model Route 选择锁已损坏".to_string())? = model.to_string();
        Ok(())
    }

    fn reasoning_effort(&self) -> Option<ReasoningEffort> {
        self.llm.read().ok().and_then(|llm| llm.reasoning_effort)
    }

    fn set_reasoning_effort(&self, effort: Option<ReasoningEffort>) -> Result<(), String> {
        self.llm
            .write()
            .map_err(|_| "LLM 配置锁已损坏".to_string())?
            .reasoning_effort = effort;
        self.clients
            .lock()
            .map_err(|_| "Provider Client 缓存锁已损坏".to_string())?
            .clear();
        Ok(())
    }

    async fn bind_model_attempt(
        &self,
        request: &ModelRequestContext,
    ) -> Result<ModelAttemptBinding, String> {
        let alias = self.alias()?;
        let (route_id, route) = self.catalog.resolve_route(&alias)?;
        let (candidate, account_id) = self
            .select_candidate_and_account(route_id, route, request)
            .await?;
        let provider = self
            .catalog
            .provider_instances
            .get(&candidate.provider)
            .expect("validated route provider");
        Ok(ModelAttemptBinding {
            requested_alias: alias,
            route_id: route_id.to_string(),
            route_revision: Self::route_revision(route_id, route),
            provider_instance_id: candidate.provider,
            auth_account_id: account_id,
            physical_model: candidate.model,
            protocol: provider.protocol.as_str().to_string(),
            provider_adapter: provider.adapter.clone(),
            provider_adapter_version: ROUTE_ADAPTER_VERSION.to_string(),
            endpoint: provider.base_url.clone(),
            capabilities: candidate.capabilities,
        })
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
        let (discovered_models, catalog_error) = match client.list_models().await {
            Ok(models) => (models, None),
            Err(error) => (Vec::new(), Some(error.to_string())),
        };
        let health_result = client.probe_health().await;
        if let Some(store) = self.account_store() {
            let (status, cooldown_until, error_kind) = match health_result.as_ref() {
                Ok(()) => (ProviderAccountStatus::Ready, None, None),
                Err(error) => match error.downcast_ref::<ModelFailure>().map(|value| value.kind) {
                    Some(ModelFailureKind::RateLimited) => (
                        ProviderAccountStatus::RateLimited,
                        Some(Utc::now() + ChronoDuration::seconds(60)),
                        Some(ModelFailureKind::RateLimited.as_str()),
                    ),
                    Some(ModelFailureKind::Authentication) => (
                        ProviderAccountStatus::Invalid,
                        None,
                        Some(ModelFailureKind::Authentication.as_str()),
                    ),
                    Some(kind) => (ProviderAccountStatus::Ready, None, Some(kind.as_str())),
                    None => (ProviderAccountStatus::Ready, None, Some("unknown")),
                },
            };
            let _ = store
                .put_provider_account_state(
                    &binding.auth_account_id,
                    None,
                    status,
                    cooldown_until,
                    error_kind,
                    false,
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
            catalog_error,
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
        self.record_account_result(&binding.auth_account_id, &result)
            .await;
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
        self.record_account_result(&binding.auth_account_id, &result)
            .await;
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{CredentialSource, ModelProtocol, ProviderModelConfig};
    use crate::memory::sqlite::SqliteStore;
    use tempfile::NamedTempFile;

    fn routed_config() -> AppConfig {
        let mut app = AppConfig::default();
        app.llm.model = "gpt-5.6".to_string();
        app.llm.models = vec!["gpt-5.6".to_string()];
        app.provider_instances.insert(
            "direct".to_string(),
            ProviderInstanceConfig {
                adapter: "openai-compatible".to_string(),
                protocol: ModelProtocol::OpenaiResponses,
                base_url: "http://localhost:8317/v1".to_string(),
                accounts: vec!["account-a".to_string(), "account-b".to_string()],
                models: BTreeMap::<String, ProviderModelConfig>::new(),
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
                aliases: vec!["gpt-5.6".to_string()],
                candidates: vec![ModelRouteCandidateConfig {
                    provider: "direct".to_string(),
                    model: "gpt-5.6-sol".to_string(),
                    priority: 10,
                    ..ModelRouteCandidateConfig::default()
                }],
                affinity: ModelRouteAffinity::Context,
                ..ModelRouteConfig::default()
            },
        );
        app
    }

    #[tokio::test]
    async fn alias_resolves_to_physical_model_and_stable_context_account() {
        let client = RoutedClient::new(&routed_config(), "gpt-5.6".to_string()).unwrap();
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
        assert_eq!(first.requested_alias, "gpt-5.6");
        assert_eq!(first.route_id, "coding-primary");
        assert_eq!(first.physical_model, "gpt-5.6-sol");
        assert_eq!(first.auth_account_id, second.auth_account_id);
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
        let client = RoutedClient::new(&routed_config(), "gpt-5.6".to_string()).unwrap();
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

        assert_eq!(binding.requested_alias, "gpt-5.6");
        assert_eq!(binding.physical_model, "gpt-5.6-sol");
        assert_eq!(binding.auth_account_id, "account-b");
    }

    #[test]
    fn several_public_aliases_resolve_to_one_logical_route() {
        let mut app = routed_config();
        app.model_routes
            .get_mut("coding-primary")
            .unwrap()
            .aliases
            .push("openai/gpt-5.6".to_string());
        let catalog = EffectiveProviderCatalog::from_config(&app).unwrap();

        let (short_id, short_route) = catalog.resolve_route("gpt-5.6").unwrap();
        let (qualified_id, qualified_route) = catalog.resolve_route("openai/gpt-5.6").unwrap();
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
        assert!(error.contains("不存在"));
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
                aliases: vec!["gpt-5.6".to_string()],
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
            .contains("同时属于"));
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
