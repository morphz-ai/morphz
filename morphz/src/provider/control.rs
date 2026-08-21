//! Transport-neutral operator projection for Provider, Auth Account and
//! Model Route management.
//!
//! This is deliberately a control-plane DTO layer. It exposes static catalog
//! metadata and durable operational state, but never credential or token
//! material. SDK, CLI, HTTP and Dashboard must consume this contract instead
//! of rebuilding subtly different provider views.

use super::auth::{AuthAdapterDescriptor, OAuthAccountMetadata};
use crate::config::{AuthAccountConfig, ModelRouteConfig, ProviderInstanceConfig};
use crate::memory::{ProviderAccountStateRecord, ProviderModelCatalogRecord};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderControlSnapshot {
    pub generated_at: DateTime<Utc>,
    pub selected_model_alias: String,
    /// Additional logical routes the Agent may explicitly select for infer or
    /// scheduled child Evaluations. The selected primary route is authorized
    /// implicitly and therefore is not duplicated here.
    #[serde(default)]
    pub allowed_evaluation_models: Vec<String>,
    pub permission_mode: crate::permission::PermissionMode,
    pub reviewer: crate::permission::ReviewerKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_review_model: Option<String>,
    pub auth_adapters: Vec<AuthAdapterDescriptor>,
    pub provider_instances: BTreeMap<String, ProviderInstanceConfig>,
    pub auth_accounts: BTreeMap<String, ProviderAccountControlRecord>,
    pub model_routes: BTreeMap<String, ModelRouteConfig>,
    /// Last successfully observed remote physical model catalogs. These are
    /// operational evidence, not aliases or routing policy.
    #[serde(default)]
    pub discovered_models: Vec<ProviderModelCatalogRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderAccountControlRecord {
    pub config: AuthAccountConfig,
    /// Durable operator/runtime state. `None` means the account has not yet
    /// acquired an operational override and therefore follows
    /// `config.enabled` as its startup default.
    pub state: Option<ProviderAccountStateRecord>,
    pub effective_enabled: bool,
    pub oauth: bool,
    pub authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth_metadata: Option<OAuthAccountMetadata>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderAccountControlAction {
    Enable,
    Disable,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderCatalogObjectKind {
    ProviderCatalog,
    ProviderInstance,
    AuthAccount,
    ModelRoute,
    EvaluationModelPolicy,
    PermissionSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderCatalogMutationReceipt {
    pub kind: ProviderCatalogObjectKind,
    pub id: String,
    pub managed_config_path: String,
    /// Whether applying this edit still requires restarting the Runtime.
    /// Provider catalog mutations are hot-applied, so this is normally false.
    pub restart_required: bool,
}

impl ProviderCatalogMutationReceipt {
    pub fn new(kind: ProviderCatalogObjectKind, id: &str, path: &Path) -> Self {
        Self {
            kind,
            id: id.to_string(),
            managed_config_path: path.display().to_string(),
            restart_required: false,
        }
    }
}
