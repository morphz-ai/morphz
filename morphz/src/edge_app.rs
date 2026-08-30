//! Shared application boundary for the full `morphz edge` command and the
//! standalone `morphz-edge` execution-node binary.
//!
//! This module owns only the user-side Execution Target lifecycle. Server-side
//! administration such as issuing pairing codes, listing all Nodes, or
//! revoking a remote Node remains part of the full Morphz control plane.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::Utc;

use crate::config::{AppConfig, StorageBackend};
use crate::edge_node::{
    generate_device_identity, EdgeGatewayClient, EdgeLocalCapabilityLease,
    EdgeLocalCapabilityLeaseStore, EdgeNodeCredentials, EdgeNodeError, EdgeNodeWorker,
    EdgeWorkerConfig,
};
use crate::llm::{Client, Message, Response, ToolDefinition};
use crate::memory::{
    ExecutionNodeRecord, ExecutionTargetKind, ExecutionTargetRegistration, ExecutionTargetStatus,
};
use crate::runtime::{MorphzRuntime, RuntimeIdentity};
use crate::sdk::PairExecutionNodeCommand;

#[derive(Debug, Clone)]
pub struct PairEdgeNodeOptions {
    pub server_url: String,
    pub pairing_code: String,
    pub node_id: Option<String>,
    pub node_name: String,
    pub credential_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct PairedEdgeNode {
    pub node: ExecutionNodeRecord,
    pub credential_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct EdgeNodeStatus {
    pub node_id: String,
    pub server_url: String,
    pub credential_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct RunEdgeNodeOptions {
    pub credential_path: PathBuf,
    pub target_id: Option<String>,
    pub target_name: Option<String>,
    pub workers: Option<usize>,
}

pub struct RunningEdgeNode {
    pub node_id: String,
    pub target_id: String,
    pub worker_count: usize,
    shutdown_tx: tokio::sync::watch::Sender<bool>,
    workers: tokio::task::JoinSet<Result<(), EdgeNodeError>>,
}

impl RunningEdgeNode {
    pub async fn shutdown(mut self) -> Result<(), EdgeNodeError> {
        let _ = self.shutdown_tx.send(true);
        while let Some(result) = self.workers.join_next().await {
            result??;
        }
        Ok(())
    }
}

impl Drop for RunningEdgeNode {
    fn drop(&mut self) {
        let _ = self.shutdown_tx.send(true);
        self.workers.abort_all();
    }
}

pub async fn pair_edge_node(
    runtime: &MorphzRuntime,
    options: PairEdgeNodeOptions,
) -> Result<PairedEdgeNode, EdgeNodeError> {
    let identity = generate_device_identity()?;
    let gateway = EdgeGatewayClient::new(&options.server_url)?;
    let paired = gateway
        .pair(PairExecutionNodeCommand {
            code: options.pairing_code,
            node_id: options.node_id,
            name: options.node_name,
            device_key_fingerprint: identity.fingerprint.clone(),
            device_public_key: identity.public_key.clone(),
            protocol_version: 1,
            platform: Some(edge_platform()),
            capabilities: runtime.physical_tool_names(),
            metadata: edge_advertisement_metadata(),
        })
        .await?;
    EdgeNodeCredentials {
        server_url: options.server_url.trim_end_matches('/').to_string(),
        node_id: paired.node.id.clone(),
        device_key_fingerprint: identity.fingerprint,
        device_public_key: identity.public_key,
        device_private_key_pkcs8: identity.private_key_pkcs8,
    }
    .save(&options.credential_path)?;
    Ok(PairedEdgeNode {
        node: paired.node,
        credential_path: options.credential_path,
    })
}

pub fn edge_node_status(credential_path: &Path) -> Result<EdgeNodeStatus, EdgeNodeError> {
    let credentials = EdgeNodeCredentials::load(credential_path)?;
    Ok(EdgeNodeStatus {
        node_id: credentials.node_id,
        server_url: credentials.server_url,
        credential_path: credential_path.to_path_buf(),
    })
}

pub async fn rotate_edge_node_key(
    runtime: &MorphzRuntime,
    credential_path: &Path,
) -> Result<EdgeNodeStatus, EdgeNodeError> {
    let credentials = EdgeNodeCredentials::load(credential_path)?;
    let gateway = EdgeGatewayClient::new(&credentials.server_url)?;
    let node = gateway
        .heartbeat_node(
            &credentials,
            &crate::edge_node::EdgeNodeAdvertisement {
                platform: Some(edge_platform()),
                capabilities: runtime.physical_tool_names(),
                metadata: edge_advertisement_metadata(),
                targets: Vec::new(),
            },
        )
        .await?;
    let identity = generate_device_identity()?;
    let replacement = EdgeNodeCredentials {
        server_url: credentials.server_url.clone(),
        node_id: credentials.node_id.clone(),
        device_key_fingerprint: identity.fingerprint.clone(),
        device_public_key: identity.public_key.clone(),
        device_private_key_pkcs8: identity.private_key_pkcs8.clone(),
    };
    let pending_path = credential_path.with_extension("json.rotate-pending");
    replacement.save(&pending_path)?;
    if let Err(error) = gateway
        .rotate_device_key(&credentials, node.revision, &identity)
        .await
    {
        let _ = std::fs::remove_file(&pending_path);
        return Err(error);
    }
    std::fs::rename(&pending_path, credential_path).map_err(|error| {
        format!(
            "server key rotation succeeded, but replacing local credentials '{}' with '{}' failed: {error}",
            pending_path.display(),
            credential_path.display()
        )
    })?;
    Ok(EdgeNodeStatus {
        node_id: credentials.node_id,
        server_url: credentials.server_url,
        credential_path: credential_path.to_path_buf(),
    })
}

pub fn list_edge_local_leases(
    credential_path: &Path,
) -> Result<Vec<EdgeLocalCapabilityLease>, EdgeNodeError> {
    let credentials = EdgeNodeCredentials::load(credential_path)?;
    Ok(EdgeLocalCapabilityLeaseStore::for_node(&credentials.node_id).list())
}

pub fn revoke_edge_local_lease(
    credential_path: &Path,
    lease_id: &str,
) -> Result<bool, EdgeNodeError> {
    let credentials = EdgeNodeCredentials::load(credential_path)?;
    EdgeLocalCapabilityLeaseStore::for_node(&credentials.node_id).revoke(lease_id)
}

pub async fn start_edge_node(
    runtime: MorphzRuntime,
    app_config: &AppConfig,
    options: RunEdgeNodeOptions,
) -> Result<RunningEdgeNode, EdgeNodeError> {
    let credentials = EdgeNodeCredentials::load(&options.credential_path)?;
    let target_id = options
        .target_id
        .unwrap_or_else(|| format!("target-{}-workspace", credentials.node_id));
    let target_name = options
        .target_name
        .unwrap_or_else(|| "Edge Workspace".to_string());
    let worker_count = options
        .workers
        .unwrap_or(app_config.edge_execution.max_in_flight_per_node)
        .clamp(1, app_config.edge_execution.max_in_flight_per_node.max(1));
    let capabilities = runtime.physical_tool_names();
    let target = ExecutionTargetRegistration {
        id: target_id.clone(),
        owner_principal_id: None,
        provider_node_id: Some(credentials.node_id.clone()),
        kind: ExecutionTargetKind::EdgeNode,
        name: target_name,
        status: ExecutionTargetStatus::Online,
        platform: Some(edge_platform()),
        workspace_root: Some(app_config.permissions.workspace_root.clone()),
        capabilities: capabilities.clone(),
        metadata: serde_json::json!({
            "backend": "edge_node",
            "protocol_version": 1,
            "workspace_identity": target_id,
        }),
        policy_digest: runtime.execution_policy_digest(),
        last_seen_at: Some(Utc::now()),
    };
    let gateway = EdgeGatewayClient::new(&credentials.server_url)?;
    let advertisement = crate::edge_node::EdgeNodeAdvertisement {
        platform: target.platform.clone(),
        capabilities,
        metadata: edge_advertisement_metadata(),
        targets: vec![target],
    };
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let mut workers = tokio::task::JoinSet::new();
    for index in 0..worker_count {
        let worker = EdgeNodeWorker::new(
            gateway.clone(),
            credentials.clone(),
            advertisement.clone(),
            runtime.clone(),
            EdgeWorkerConfig {
                worker_id: format!("{}-{}-{index}", credentials.node_id, std::process::id()),
                lease_seconds: app_config.edge_execution.default_command_lease.as_secs(),
                ..Default::default()
            },
        );
        workers.spawn(worker.run_until_shutdown(shutdown_rx.clone()));
    }
    Ok(RunningEdgeNode {
        node_id: credentials.node_id,
        target_id,
        worker_count,
        shutdown_tx,
        workers,
    })
}

/// Construct the standalone Node's local execution host without inheriting
/// model Providers, cloud storage, Dashboard, or Context configuration.
pub async fn build_standalone_edge_runtime(
    source: &AppConfig,
    protected_paths: impl IntoIterator<Item = PathBuf>,
) -> Result<(MorphzRuntime, AppConfig), EdgeNodeError> {
    let state_dir = standalone_edge_state_dir()?;
    std::fs::create_dir_all(&state_dir)?;
    let config = standalone_edge_config(source, &state_dir, protected_paths);
    let runtime = MorphzRuntime::builder(config.clone(), Arc::new(EdgeOfflineClient))
        .identity(RuntimeIdentity {
            agent_id: "morphz-edge".to_string(),
            context_id: "morphz-edge-local".to_string(),
            principal_id: "morphz-edge-local".to_string(),
        })
        .database_path(config.storage.sqlite.path.clone())
        .build()
        .await?;
    Ok((runtime, config))
}

pub fn standalone_edge_config(
    source: &AppConfig,
    state_dir: &Path,
    protected_paths: impl IntoIterator<Item = PathBuf>,
) -> AppConfig {
    let mut config = AppConfig::default();
    config.storage.backend = StorageBackend::Sqlite;
    config.storage.sqlite.path = state_dir.join("runtime.db").to_string_lossy().into_owned();
    config.permissions = source.permissions.clone();
    config.permissions.auto_review_model = None;
    config.background_task = source.background_task.clone();
    config.background_task.artifact_dir =
        state_dir.join("artifacts").to_string_lossy().into_owned();
    config.edge_execution = source.edge_execution.clone();
    config.managed_ssh = source.managed_ssh.clone();
    for path in protected_paths
        .into_iter()
        .chain(std::env::current_exe().ok())
        .chain(Some(state_dir.to_path_buf()))
    {
        let protected = path.to_string_lossy().into_owned();
        if !config.permissions.protected_paths.contains(&protected) {
            config.permissions.protected_paths.push(protected);
        }
    }
    config
}

pub fn standalone_edge_state_dir() -> Result<PathBuf, EdgeNodeError> {
    if let Some(path) = std::env::var_os("MORPHZ_EDGE_STATE_DIR").filter(|value| !value.is_empty())
    {
        return Ok(PathBuf::from(path));
    }
    Ok(crate::config::morphz_home_dir()
        .ok_or("cannot determine Morphz user configuration directory")?
        .join("edge"))
}

fn edge_platform() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

fn edge_advertisement_metadata() -> serde_json::Value {
    let client_binary = std::env::current_exe()
        .ok()
        .and_then(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| "morphz-edge".to_string());
    serde_json::json!({
        "client_version": crate::build_info::VERSION,
        "client_binary": client_binary,
        "transport": "outbound_http_long_poll"
    })
}

struct EdgeOfflineClient;

#[async_trait::async_trait]
impl Client for EdgeOfflineClient {
    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        Err("morphz-edge is an execution-only binary and cannot evaluate models".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standalone_config_keeps_execution_policy_but_drops_control_plane_state() {
        let directory = tempfile::tempdir().unwrap();
        let mut source = AppConfig::default();
        source
            .provider_instances
            .insert("provider".to_string(), Default::default());
        source.auth_accounts.insert(
            "account".to_string(),
            crate::config::AuthAccountConfig::default(),
        );
        source.model_routes.insert(
            "model".to_string(),
            crate::config::ModelRouteConfig::default(),
        );
        source.permissions.workspace_root = directory.path().to_string_lossy().into_owned();
        source.edge_execution.max_in_flight_per_node = 3;
        let protected = directory.path().join("morphz.toml");

        let config = standalone_edge_config(&source, directory.path(), [protected.clone()]);

        assert_eq!(config.storage.backend, StorageBackend::Sqlite);
        assert_eq!(
            config.storage.sqlite.path,
            directory.path().join("runtime.db").to_string_lossy()
        );
        assert!(config.provider_instances.is_empty());
        assert!(config.auth_accounts.is_empty());
        assert!(config.model_routes.is_empty());
        assert_eq!(
            config.permissions.workspace_root,
            source.permissions.workspace_root
        );
        assert_eq!(config.edge_execution.max_in_flight_per_node, 3);
        assert!(config
            .permissions
            .protected_paths
            .contains(&protected.to_string_lossy().into_owned()));
    }
}
