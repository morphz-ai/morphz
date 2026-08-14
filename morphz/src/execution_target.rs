//! Stable execution destinations and backend-neutral target selection.
//!
//! An [`ExecutionTargetRecord`] is a logical security/execution boundary. It
//! is deliberately distinct from a live Node connection and from the Worker
//! process which claims one Execution Job.

use std::collections::HashMap;
use std::error::Error;
use std::path::PathBuf;
use std::path::{Component, Path};
use std::process::Stdio;
use std::sync::{Arc, RwLock};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::approval::{ApprovalAction, CapabilityDelta};
use crate::config::ManagedSshTargetConfig;
use crate::llm::ToolDefinition;
use crate::memory::{
    EdgeCommandStatus, EdgeExecutionStore, ExecutionJobMutation, ExecutionJobRecord,
    ExecutionJobStatus, ExecutionJobStore, ExecutionJobTerminal, ExecutionRetrySafety,
    ExecutionTargetAuthorizationFilter, ExecutionTargetAuthorizationScope,
    ExecutionTargetAuthorizationStatus, ExecutionTargetAuthorizationStore, ExecutionTargetFilter,
    ExecutionTargetKind, ExecutionTargetRecord, ExecutionTargetRegistration, ExecutionTargetStatus,
    ExecutionTargetStore, NewEdgeCommand, NewExecutionJob,
};
use crate::tool::{Tool, ToolExecutionClass, ToolExecutionRouting, CURRENT_PRINCIPAL_ID};

pub type TargetExecutionError = Box<dyn Error + Send + Sync>;

/// Single-machine compatibility target. Local callers may omit `target`; the
/// Runtime resolves that omission to this explicit authority before it creates
/// an Execution Job.
pub const DEFAULT_EXECUTION_TARGET_ID: &str = "target-default";
pub const EXECUTION_ROUTE_REQUEST_KEY: &str = "_morphz_execution_route";
pub const ARTIFACT_TRANSFER_ROUTES_REQUEST_KEY: &str =
    crate::artifact::ARTIFACT_TRANSFER_ROUTES_REQUEST_KEY;
pub const EDGE_EXECUTION_SCOPE_KEY: &str = "execution_scope";

/// Host-owned connection descriptor for a Managed SSH Target. Authentication
/// stays inside OpenSSH (host config, key files, or ssh-agent); private keys
/// and passwords are never accepted as Agent-authored arguments.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ManagedSshEndpoint {
    /// When present, Runtime delegates connection resolution to the host
    /// user's existing OpenSSH configuration. The resolved host/user below
    /// are retained only for validation and policy hashing.
    #[serde(skip)]
    pub destination: Option<String>,
    pub host: String,
    pub user: Option<String>,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub known_hosts_file: PathBuf,
    /// Static endpoint admission flag. Dynamic hosts are admitted by the
    /// Runtime; connection authorization follows the active Permission Profile
    /// and the Thread + Target Capability Lease policy.
    #[serde(default)]
    pub approved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_digest: Option<String>,
}

fn default_ssh_port() -> u16 {
    22
}

impl ManagedSshEndpoint {
    pub fn load(endpoint_ref: &str) -> Result<Self, TargetExecutionError> {
        validate_endpoint_ref(endpoint_ref)?;
        let home = crate::config::morphz_home_dir()
            .ok_or("无法确定 Morphz 用户配置目录，不能解析 Managed SSH endpoint")?;
        let path = home
            .join("edge")
            .join("ssh")
            .join(format!("{endpoint_ref}.json"));
        let endpoint: Self = serde_json::from_slice(&std::fs::read(&path).map_err(|error| {
            format!(
                "Managed SSH endpoint '{}' 未配置（{}）：{error}",
                endpoint_ref,
                path.display()
            )
        })?)?;
        endpoint.validate()?;
        Ok(endpoint)
    }

    pub fn validate(&self) -> Result<(), TargetExecutionError> {
        if let Some(host) = self.destination.as_deref() {
            validate_ssh_host(host)?;
        }
        if self.host.trim().is_empty()
            || self.host.starts_with('-')
            || self.host.chars().any(char::is_whitespace)
        {
            return Err("Managed SSH host 不能为空、不能以 '-' 开头或包含空白".into());
        }
        if self.user.as_deref().is_some_and(|user| {
            user.is_empty() || user.starts_with('-') || user.chars().any(char::is_whitespace)
        }) {
            return Err("Managed SSH user 不能为空、不能以 '-' 开头或包含空白".into());
        }
        if self.port == 0 {
            return Err("Managed SSH port 必须大于 0".into());
        }
        if self.destination.is_none()
            && (!self.known_hosts_file.is_absolute() || !self.known_hosts_file.is_file())
        {
            return Err(format!(
                "Managed SSH known_hosts_file 必须是已存在的绝对文件：{}",
                self.known_hosts_file.display()
            )
            .into());
        }
        Ok(())
    }
}

fn validate_ssh_host(host: &str) -> Result<(), TargetExecutionError> {
    if host.is_empty()
        || host.starts_with('-')
        || !host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(
            "Managed SSH host 只能包含字母、数字、点、横线和下划线，且不能以 '-' 开头".into(),
        );
    }
    Ok(())
}

fn validate_ssh_user(user: &str) -> Result<(), TargetExecutionError> {
    if user.is_empty() || user.starts_with('-') || user.chars().any(char::is_whitespace) {
        return Err("Managed SSH user 不能为空、不能以 '-' 开头或包含空白".into());
    }
    Ok(())
}

async fn resolve_runtime_ssh_host(
    host: &str,
    user: Option<&str>,
    port: Option<u16>,
) -> Result<ManagedSshEndpoint, TargetExecutionError> {
    validate_ssh_host(host)?;
    if let Some(user) = user {
        validate_ssh_user(user)?;
    }
    if port == Some(0) {
        return Err("Managed SSH port 必须大于 0".into());
    }
    let mut command = tokio::process::Command::new("ssh");
    command.arg("-G");
    if let Some(user) = user {
        command.arg("-l").arg(user);
    }
    if let Some(port) = port {
        command.arg("-p").arg(port.to_string());
    }
    command
        .arg("--")
        .arg(host)
        .stdin(std::process::Stdio::null());
    let output = tokio::time::timeout(std::time::Duration::from_secs(5), command.output())
        .await
        .map_err(|_| format!("解析 SSH host '{host}' 超时"))??;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Runtime 无法解析 SSH host '{}': {}", host, stderr.trim()).into());
    }
    if output.stdout.len() > 1024 * 1024 {
        return Err(format!("SSH host '{host}' 的展开配置异常过大").into());
    }
    let expanded = String::from_utf8(output.stdout)?;
    managed_ssh_endpoint_from_expanded(host, &expanded)
}

fn managed_ssh_endpoint_from_expanded(
    ssh_host: &str,
    expanded: &str,
) -> Result<ManagedSshEndpoint, TargetExecutionError> {
    validate_ssh_host(ssh_host)?;
    let field = |name: &str| {
        expanded.lines().find_map(|line| {
            line.split_once(' ')
                .filter(|(key, value)| *key == name && !value.trim().is_empty())
                .map(|(_, value)| value.trim().to_string())
        })
    };
    let host = field("hostname").ok_or_else(|| format!("SSH host '{ssh_host}' 缺少 hostname"))?;
    let user = field("user");
    let port = field("port")
        .as_deref()
        .unwrap_or("22")
        .parse::<u16>()
        .map_err(|_| format!("SSH host '{ssh_host}' 的 port 无效"))?;
    let endpoint = ManagedSshEndpoint {
        destination: Some(ssh_host.to_string()),
        host,
        user,
        port,
        known_hosts_file: PathBuf::new(),
        approved: true,
        config_digest: Some(format!("sha256:{:x}", Sha256::digest(expanded.as_bytes()))),
    };
    endpoint.validate()?;
    Ok(endpoint)
}

fn validate_endpoint_ref(endpoint_ref: &str) -> Result<(), TargetExecutionError> {
    if endpoint_ref.is_empty()
        || !endpoint_ref
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("Managed SSH endpoint_ref 只能包含字母、数字、点、横线和下划线".into());
    }
    Ok(())
}

/// Cloud authority copied from the immutable parent Job into the Edge
/// command. It lets the Provider Node scope its own local Capability Lease to
/// the same logical work without trusting model-authored arguments.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EdgeExecutionScope {
    pub principal_id: String,
    pub agent_id: String,
    pub context_id: String,
    pub session_id: String,
    pub thread_id: String,
}

/// Immutable one-hop Route selected before an Execution Job becomes
/// claimable. A later Target heartbeat may update the registry, but it cannot
/// silently move an already-created physical action to another provider.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionRouteSnapshot {
    pub route_id: String,
    pub target_id: String,
    pub target_revision: u64,
    pub provider_node_id: Option<String>,
    pub backend_kind: ExecutionTargetKind,
    pub endpoint_ref: Option<String>,
    pub policy_digest: String,
}

/// Immutable dual-endpoint route carried by one Artifact Transfer
/// ExecutionJob. `ExecutionJob.target_id` remains the coordinator (currently
/// the destination); these two snapshots are the authoritative data route.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtifactTransferRouteSnapshot {
    pub source: ExecutionRouteSnapshot,
    pub destination: ExecutionRouteSnapshot,
}

pub const EDGE_ARTIFACT_DATA_CHANNEL_KEY: &str = "_morphz_edge_artifact_channel";

/// Private instruction between Runtime and an authenticated Edge Worker.  It
/// is never accepted from the model-facing transfer arguments and never
/// contains a credential or an arbitrary server-side path.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EdgeArtifactDataDirection {
    RuntimeToEdge,
    EdgeToRuntime,
}

/// Representation carried by the private Runtime↔Edge byte channel. This is
/// deliberately distinct from the logical Artifact media type/digest in the
/// final Receipt: a directory travels as a canonical archive, while its
/// logical identity is still computed from the materialized tree.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EdgeArtifactPayloadKind {
    #[default]
    File,
    DirectoryArchive,
    /// Edge→Runtime cannot know the source kind until the target-local
    /// permission check and Tool execution have inspected it.
    Detect,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EdgeArtifactDataChannel {
    pub direction: EdgeArtifactDataDirection,
    #[serde(default)]
    pub payload_kind: EdgeArtifactPayloadKind,
    /// Digest of the exact bytes carried by this channel. For a directory
    /// this is the canonical archive digest, not the logical directory digest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
}

pub fn attach_edge_artifact_data_channel(
    route: &mut serde_json::Value,
    channel: &EdgeArtifactDataChannel,
) -> Result<(), TargetExecutionError> {
    route
        .as_object_mut()
        .ok_or("Edge Artifact Route 必须编码为 JSON object")?
        .insert(
            EDGE_ARTIFACT_DATA_CHANNEL_KEY.to_string(),
            serde_json::to_value(channel)?,
        );
    Ok(())
}

pub fn edge_artifact_data_channel_from_route(
    route: &serde_json::Value,
) -> Result<Option<EdgeArtifactDataChannel>, TargetExecutionError> {
    route
        .get(EDGE_ARTIFACT_DATA_CHANNEL_KEY)
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(Into::into)
}

impl ExecutionRouteSnapshot {
    pub fn freeze(target: &ExecutionTargetRecord) -> Self {
        Self {
            route_id: format!("route:{}:r{}", target.id, target.revision),
            target_id: target.id.clone(),
            target_revision: target.revision,
            provider_node_id: target.provider_node_id.clone(),
            backend_kind: target.kind,
            endpoint_ref: target
                .metadata
                .get("endpoint_ref")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            policy_digest: target.policy_digest.clone(),
        }
    }
}

pub fn attach_route_snapshot(
    request: &mut serde_json::Value,
    route: &ExecutionRouteSnapshot,
) -> Result<(), TargetExecutionError> {
    let object = request
        .as_object_mut()
        .ok_or("Execution Job request 必须是 JSON object")?;
    object.insert(
        EXECUTION_ROUTE_REQUEST_KEY.to_string(),
        serde_json::to_value(route)?,
    );
    Ok(())
}

pub fn attach_artifact_transfer_routes(
    request: &mut serde_json::Value,
    routes: &ArtifactTransferRouteSnapshot,
) -> Result<(), TargetExecutionError> {
    let object = request
        .as_object_mut()
        .ok_or("Artifact Transfer Execution Job request 必须是 JSON object")?;
    object.insert(
        ARTIFACT_TRANSFER_ROUTES_REQUEST_KEY.to_string(),
        serde_json::to_value(routes)?,
    );
    // The ordinary dispatcher and Edge protocol still need one coordinator
    // route. The destination owns atomic publication, so it is the natural
    // coordinator in v1.
    object.insert(
        EXECUTION_ROUTE_REQUEST_KEY.to_string(),
        serde_json::to_value(&routes.destination)?,
    );
    Ok(())
}

pub fn artifact_transfer_routes_from_job(
    job: &ExecutionJobRecord,
) -> Result<ArtifactTransferRouteSnapshot, TargetExecutionError> {
    let routes: ArtifactTransferRouteSnapshot = serde_json::from_value(
        job.request
            .get(ARTIFACT_TRANSFER_ROUTES_REQUEST_KEY)
            .cloned()
            .ok_or("Artifact Transfer Execution Job 缺少冻结的双 Route")?,
    )?;
    if routes.destination.target_id != job.target_id {
        return Err("Artifact Transfer coordinator 与 destination Route 不一致".into());
    }
    Ok(routes)
}

pub fn route_snapshot_from_job(
    job: &ExecutionJobRecord,
) -> Result<ExecutionRouteSnapshot, TargetExecutionError> {
    let route = job
        .request
        .get(EXECUTION_ROUTE_REQUEST_KEY)
        .ok_or("Execution Job 缺少冻结的 Execution Route")?;
    let route: ExecutionRouteSnapshot = serde_json::from_value(route.clone())?;
    if route.target_id != job.target_id {
        return Err("Execution Job target_id 与冻结 Route 不一致".into());
    }
    Ok(route)
}

pub fn edge_command_route_from_job(
    job: &ExecutionJobRecord,
) -> Result<serde_json::Value, TargetExecutionError> {
    let mut value = serde_json::to_value(route_snapshot_from_job(job)?)?;
    let principal_id = job
        .initiating_principal_id
        .clone()
        .ok_or("远程 Execution Job 缺少权威 Principal")?;
    value
        .as_object_mut()
        .ok_or("Execution Route 必须编码为 JSON object")?
        .insert(
            EDGE_EXECUTION_SCOPE_KEY.to_string(),
            serde_json::to_value(EdgeExecutionScope {
                principal_id,
                agent_id: job.agent_id.clone(),
                context_id: job.context_id.clone(),
                session_id: job.session_id.clone(),
                thread_id: job.thread_id.clone(),
            })?,
        );
    Ok(value)
}

/// Encode an Artifact Transfer's dual immutable route together with the
/// authority scope that the Edge Node must independently enforce.  The scope
/// is intentionally outside `ArtifactTransferRouteSnapshot`: it is execution
/// authority, not part of the data route itself.
pub fn edge_artifact_transfer_route_from_job(
    job: &ExecutionJobRecord,
    routes: &ArtifactTransferRouteSnapshot,
) -> Result<serde_json::Value, TargetExecutionError> {
    let mut value = serde_json::to_value(routes)?;
    let principal_id = job
        .initiating_principal_id
        .clone()
        .ok_or("远程 Artifact Transfer Job 缺少权威 Principal")?;
    value
        .as_object_mut()
        .ok_or("Artifact Transfer Route 必须编码为 JSON object")?
        .insert(
            EDGE_EXECUTION_SCOPE_KEY.to_string(),
            serde_json::to_value(EdgeExecutionScope {
                principal_id,
                agent_id: job.agent_id.clone(),
                context_id: job.context_id.clone(),
                session_id: job.session_id.clone(),
                thread_id: job.thread_id.clone(),
            })?,
        );
    Ok(value)
}

pub fn edge_execution_scope_from_route(
    route: &serde_json::Value,
) -> Result<EdgeExecutionScope, TargetExecutionError> {
    let value = route
        .get(EDGE_EXECUTION_SCOPE_KEY)
        .ok_or("Edge Command 缺少权威 Execution Scope")?;
    Ok(serde_json::from_value(value.clone())?)
}

pub fn prepare_managed_ssh_exec_arguments(
    endpoint_ref: &str,
    endpoint: &ManagedSshEndpoint,
    target_id: &str,
    arguments: &str,
) -> Result<String, TargetExecutionError> {
    validate_endpoint_ref(endpoint_ref)?;
    endpoint.validate()?;
    if !endpoint.approved {
        return Err(format!("Managed SSH endpoint '{endpoint_ref}' 尚未明确批准").into());
    }
    if endpoint.destination.is_none()
        && std::env::var_os("SSH_AUTH_SOCK").is_none_or(|value| value.is_empty())
    {
        return Err("静态 Managed SSH endpoint 需要 Runtime 的 SSH_AUTH_SOCK".into());
    }
    build_managed_ssh_exec_arguments(endpoint_ref, endpoint, target_id, arguments)
}

fn build_managed_ssh_exec_arguments(
    endpoint_ref: &str,
    endpoint: &ManagedSshEndpoint,
    target_id: &str,
    arguments: &str,
) -> Result<String, TargetExecutionError> {
    let mut arguments: serde_json::Value = serde_json::from_str(arguments)?;
    let object = arguments
        .as_object_mut()
        .ok_or("Managed SSH exec 参数必须是 JSON object")?;
    let remote_command = object
        .get("command")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|command| !command.is_empty())
        .ok_or("Managed SSH exec 缺少非空 command")?;
    let remote_command = match object.get("cwd").and_then(serde_json::Value::as_str) {
        Some(cwd) if !cwd.trim().is_empty() => {
            format!("cd -- {} && {remote_command}", shell_quote(cwd))
        }
        _ => remote_command.to_string(),
    };
    let mut ssh = vec!["ssh".to_string()];
    if endpoint.destination.is_none() {
        ssh.extend([
            "-F".to_string(),
            "/dev/null".to_string(),
            "-o".to_string(),
            "IdentitiesOnly=no".to_string(),
        ]);
    }
    ssh.extend([
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "StrictHostKeyChecking=yes".to_string(),
    ]);
    let destination = match endpoint.destination.as_deref() {
        Some(host) => {
            if let Some(user) = endpoint.user.as_deref() {
                ssh.extend(["-l".to_string(), user.to_string()]);
            }
            ssh.extend(["-p".to_string(), endpoint.port.to_string()]);
            host.to_string()
        }
        None => {
            ssh.extend([
                "-o".to_string(),
                format!("UserKnownHostsFile={}", endpoint.known_hosts_file.display()),
                "-p".to_string(),
                endpoint.port.to_string(),
            ]);
            endpoint
                .user
                .as_deref()
                .map(|user| format!("{user}@{}", endpoint.host))
                .unwrap_or_else(|| endpoint.host.clone())
        }
    };
    ssh.extend(["--".to_string(), destination, remote_command]);
    let ssh = ssh
        .iter()
        .map(|part| shell_quote(part))
        .collect::<Vec<_>>()
        .join(" ");
    let wait_ms = object
        .get("wait_ms")
        .cloned()
        .unwrap_or(serde_json::json!(10_000));
    let read_paths = endpoint
        .destination
        .is_none()
        .then(|| endpoint.known_hosts_file.clone())
        .into_iter()
        .collect::<Vec<_>>();
    let secret_env = std::env::var_os("SSH_AUTH_SOCK")
        .filter(|value| !value.is_empty())
        .map(|_| "SSH_AUTH_SOCK")
        .into_iter()
        .collect::<Vec<_>>();
    Ok(serde_json::to_string(&serde_json::json!({
        "command": ssh,
        "cwd": ".",
        "wait_ms": wait_ms,
        "sandbox_permissions": "require_escalated",
        "requested_permissions": {
            "network": true,
            "read_paths": read_paths,
            "secret_env": secret_env
        },
        "justification": format!(
            "Runtime 使用本地预授权 Managed SSH endpoint '{}' 执行 Target '{}'",
            endpoint_ref, target_id
        )
    }))?)
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Quotes a path for a remote POSIX shell while preserving the conventional
/// current-user home shorthand. Artifact transfer commands do not run through
/// an interactive shell, so quoting the whole `~/...` value would otherwise
/// turn `~` into a literal directory name.
fn shell_quote_remote_path(value: &str) -> String {
    if value == "~" {
        return "\"$HOME\"".to_string();
    }
    if let Some(relative) = value.strip_prefix("~/") {
        if relative.is_empty() {
            "\"$HOME\"".to_string()
        } else {
            format!("\"$HOME\"/{}", shell_quote(relative))
        }
    } else {
        shell_quote(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetInvocation {
    pub target_id: String,
    pub explicit_target: bool,
    /// Tool arguments after removing the Runtime-owned `target` routing field.
    pub tool_arguments: String,
}

/// Extracts the model-visible routing field without leaking it into individual
/// tool argument structs. This lets every physical tool share one protocol and
/// keeps logical tools completely unaware of Execution Targets.
pub fn split_target_argument(arguments: &str) -> Result<TargetInvocation, TargetExecutionError> {
    let mut value: serde_json::Value = serde_json::from_str(arguments)?;
    let object = value
        .as_object_mut()
        .ok_or("物理工具参数必须是 JSON object")?;
    let (target_id, explicit_target) = match object.remove("target") {
        None | Some(serde_json::Value::Null) => (DEFAULT_EXECUTION_TARGET_ID.to_string(), false),
        Some(serde_json::Value::String(value)) if !value.trim().is_empty() => (value, true),
        Some(_) => return Err("物理工具 target 必须是非空字符串".into()),
    };
    Ok(TargetInvocation {
        target_id,
        explicit_target,
        tool_arguments: serde_json::to_string(&value)?,
    })
}

/// Cloud-side authorization boundary for a non-local Target. It deliberately
/// does not canonicalize paths against the cloud host: paths belong to the
/// Target Workspace and are validated again by the Provider Node's real
/// PermissionProfile and native sandbox.
pub fn remote_target_approval_requirement(
    target: &ExecutionTargetRecord,
    tool_name: &str,
    arguments: &str,
) -> Result<crate::permission::ApprovalRequirement, TargetExecutionError> {
    let value: serde_json::Value = serde_json::from_str(arguments)?;
    let object = value
        .as_object()
        .ok_or("远程物理工具参数必须是 JSON object")?;
    let path = object
        .get("path")
        .or_else(|| object.get("cwd"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(std::path::PathBuf::from);
    let mut requested = CapabilityDelta::default();
    match tool_name {
        "read" | "list_files" | "search" => {
            if let Some(path) = path.clone() {
                requested.read_roots.push(path);
            }
            if tool_name == "search" {
                for path in json_string_array(object.get("paths")) {
                    let path = std::path::PathBuf::from(path);
                    if !requested.read_roots.contains(&path) {
                        requested.read_roots.push(path);
                    }
                }
            }
        }
        "write" | "edit" => {
            if let Some(path) = path.clone() {
                requested.write_roots.push(path);
            }
        }
        "exec" => {
            if let Some(permissions) = object
                .get("requested_permissions")
                .and_then(serde_json::Value::as_object)
            {
                requested.network = permissions
                    .get("network")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                requested.read_roots = json_string_array(permissions.get("read_paths"))
                    .into_iter()
                    .map(std::path::PathBuf::from)
                    .collect();
                requested.write_roots = json_string_array(permissions.get("write_paths"))
                    .into_iter()
                    .map(std::path::PathBuf::from)
                    .collect();
                requested.secret_env = json_string_array(permissions.get("secret_env"));
            }
        }
        _ => {}
    }
    if target.kind == ExecutionTargetKind::ManagedSsh {
        requested.network = true;
        if target.provider_node_id.is_none()
            && std::env::var_os("SSH_AUTH_SOCK").is_some_and(|value| !value.is_empty())
            && !requested
                .secret_env
                .iter()
                .any(|name| name == "SSH_AUTH_SOCK")
        {
            requested.secret_env.push("SSH_AUTH_SOCK".to_string());
        }
    }
    let execution_location =
        if target.kind == ExecutionTargetKind::ManagedSsh && target.provider_node_id.is_none() {
            "Runtime"
        } else {
            "Provider Node"
        };
    Ok(crate::permission::ApprovalRequirement {
        action: ApprovalAction::ToolOperation {
            tool: tool_name.to_string(),
            operation: "execute_on_remote_target".to_string(),
            target: path,
        },
        requested,
        justification: format!(
            "当前 Thread 首次在非本地 Execution Target '{}'（{}）上使用物理能力 '{tool_name}'；{execution_location} 将按已冻结 Route 执行，仍须通过现有自动审批或人工审批",
            target.id, target.name
        ),
    })
}

pub fn remote_artifact_transfer_approval_requirement(
    source: &ExecutionTargetRecord,
    destination: &ExecutionTargetRecord,
    request: &crate::artifact::ArtifactTransferRequest,
) -> Result<Option<crate::permission::ApprovalRequirement>, TargetExecutionError> {
    let mut requested = CapabilityDelta::default();
    if source.kind != ExecutionTargetKind::InProcessLocal {
        requested
            .read_roots
            .push(PathBuf::from(&request.source.path));
        extend_transfer_transport_capability(source, &mut requested);
    }
    if destination.kind != ExecutionTargetKind::InProcessLocal {
        requested
            .write_roots
            .push(PathBuf::from(&request.destination.path));
        extend_transfer_transport_capability(destination, &mut requested);
    }
    if requested.is_empty() {
        return Ok(None);
    }
    Ok(Some(crate::permission::ApprovalRequirement {
        action: ApprovalAction::ToolOperation {
            tool: crate::artifact::ARTIFACT_TRANSFER_TOOL_NAME.to_string(),
            operation: "transfer".to_string(),
            target: None,
        },
        requested,
        justification: format!(
            "Artifact Transfer 将从 Target '{}' 的 '{}' 读取，并向 Target '{}' 的 '{}' 写入；源与目的仍各自通过 Target 本地 PermissionProfile",
            source.id,
            request.source.path,
            destination.id,
            request.destination.path
        ),
    }))
}

fn extend_transfer_transport_capability(
    target: &ExecutionTargetRecord,
    requested: &mut CapabilityDelta,
) {
    if target.kind == ExecutionTargetKind::ManagedSsh {
        requested.network = true;
        if target.provider_node_id.is_none()
            && std::env::var_os("SSH_AUTH_SOCK").is_some_and(|value| !value.is_empty())
            && !requested
                .secret_env
                .iter()
                .any(|name| name == "SSH_AUTH_SOCK")
        {
            requested.secret_env.push("SSH_AUTH_SOCK".to_string());
        }
    }
}

fn json_string_array(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::to_string)
        .collect()
}

#[async_trait::async_trait]
pub trait ExecutionTargetBackend: Send + Sync {
    fn kind(&self) -> ExecutionTargetKind;

    async fn execute(
        &self,
        context: &TargetExecutionContext,
        tool: Arc<dyn Tool>,
        arguments: &str,
    ) -> Result<String, TargetExecutionError>;
}

/// Route-pair transport selected by Runtime for cross-Target Artifact
/// movement. It is separate from the model Tool registry: callers cannot name
/// one of these implementations or supply credentials.
#[async_trait::async_trait]
pub trait ArtifactTransferExecutionBackend: Send + Sync {
    fn name(&self) -> &'static str;

    fn supports(
        &self,
        source: &ExecutionRouteSnapshot,
        destination: &ExecutionRouteSnapshot,
    ) -> bool;

    async fn execute_transfer(
        &self,
        job: &ExecutionJobRecord,
        routes: &ArtifactTransferRouteSnapshot,
        request: &crate::artifact::ArtifactTransferRequest,
    ) -> Result<crate::artifact::ArtifactTransferReceipt, TargetExecutionError>;
}

#[derive(Debug, Clone)]
pub struct TargetExecutionContext {
    pub target: ExecutionTargetRecord,
    pub job: ExecutionJobRecord,
}

/// Existing single-process tool implementation exposed through the same
/// backend contract future Edge/SSH/managed workers use.
pub struct InProcessLocalBackend;

#[async_trait::async_trait]
impl ExecutionTargetBackend for InProcessLocalBackend {
    fn kind(&self) -> ExecutionTargetKind {
        ExecutionTargetKind::InProcessLocal
    }

    async fn execute(
        &self,
        context: &TargetExecutionContext,
        tool: Arc<dyn Tool>,
        arguments: &str,
    ) -> Result<String, TargetExecutionError> {
        if context.target.id != DEFAULT_EXECUTION_TARGET_ID {
            return Err(format!(
                "InProcessLocal Backend 只能执行 '{}'，不能隐式代理 '{}'",
                DEFAULT_EXECUTION_TARGET_ID, context.target.id
            )
            .into());
        }
        tool.execute(arguments).await
    }
}

/// Durable outbound transport used by user-owned Edge Nodes. The cloud-side
/// evaluator never opens an inbound connection to a user's computer: it
/// materializes one idempotent command and waits for an authenticated Node to
/// claim and fence the result.
pub struct EdgeNodeBackend {
    store: Arc<dyn EdgeExecutionStore>,
    kind: ExecutionTargetKind,
    poll_interval: std::time::Duration,
}

impl EdgeNodeBackend {
    pub fn new(store: Arc<dyn EdgeExecutionStore>) -> Self {
        Self {
            store,
            kind: ExecutionTargetKind::EdgeNode,
            poll_interval: std::time::Duration::from_millis(250),
        }
    }

    pub fn managed_ssh(store: Arc<dyn EdgeExecutionStore>) -> Self {
        Self {
            store,
            kind: ExecutionTargetKind::ManagedSsh,
            poll_interval: std::time::Duration::from_millis(250),
        }
    }

    pub fn with_poll_interval(mut self, interval: std::time::Duration) -> Self {
        self.poll_interval = interval.max(std::time::Duration::from_millis(25));
        self
    }
}

#[async_trait::async_trait]
impl ExecutionTargetBackend for EdgeNodeBackend {
    fn kind(&self) -> ExecutionTargetKind {
        self.kind
    }

    async fn execute(
        &self,
        context: &TargetExecutionContext,
        tool: Arc<dyn Tool>,
        arguments: &str,
    ) -> Result<String, TargetExecutionError> {
        let provider_node_id = context.target.provider_node_id.as_deref().ok_or_else(|| {
            format!(
                "Edge Target '{}' 没有权威 provider_node_id",
                context.target.id
            )
        })?;
        self.store
            .create_edge_command(NewEdgeCommand {
                job_id: context.job.id.clone(),
                target_id: context.target.id.clone(),
                provider_node_id: provider_node_id.to_string(),
                tool_name: tool.name().to_string(),
                arguments: arguments.to_string(),
                route: edge_command_route_from_job(&context.job)?,
            })
            .await?;
        loop {
            let command = self
                .store
                .get_edge_command(&context.job.id)
                .await?
                .ok_or("Edge Command 在等待期间消失")?;
            match command.status {
                EdgeCommandStatus::Succeeded => {
                    return Ok(command.output.unwrap_or_else(|| {
                        serde_json::json!({
                            "status": "success",
                            "output": null,
                            "message": "Edge tool completed without output"
                        })
                        .to_string()
                    }));
                }
                EdgeCommandStatus::Failed => {
                    return Err(command
                        .error
                        .unwrap_or_else(|| "Edge tool failed".to_string())
                        .into());
                }
                EdgeCommandStatus::Cancelled => return Err("Edge tool was cancelled".into()),
                EdgeCommandStatus::Lost => {
                    return Err(command
                        .error
                        .unwrap_or_else(|| "Edge tool outcome is unknown".to_string())
                        .into());
                }
                EdgeCommandStatus::Queued
                | EdgeCommandStatus::Claimed
                | EdgeCommandStatus::CancelRequested => {
                    tokio::time::sleep(self.poll_interval).await;
                }
            }
        }
    }
}

#[async_trait::async_trait]
impl ArtifactTransferExecutionBackend for EdgeNodeBackend {
    fn name(&self) -> &'static str {
        "edge_local_copy"
    }

    fn supports(
        &self,
        source: &ExecutionRouteSnapshot,
        destination: &ExecutionRouteSnapshot,
    ) -> bool {
        self.kind == ExecutionTargetKind::EdgeNode
            && source.backend_kind == ExecutionTargetKind::EdgeNode
            && destination.backend_kind == ExecutionTargetKind::EdgeNode
            && source.target_id == destination.target_id
            && source.provider_node_id.is_some()
            && source.provider_node_id == destination.provider_node_id
    }

    async fn execute_transfer(
        &self,
        job: &ExecutionJobRecord,
        routes: &ArtifactTransferRouteSnapshot,
        request: &crate::artifact::ArtifactTransferRequest,
    ) -> Result<crate::artifact::ArtifactTransferReceipt, TargetExecutionError> {
        if !self.supports(&routes.source, &routes.destination) {
            return Err("Edge local Artifact transport 只接受同一 Edge Target 内的传输".into());
        }
        let provider_node_id = routes
            .source
            .provider_node_id
            .as_deref()
            .ok_or("Edge Artifact Route 缺少 provider_node_id")?;
        self.store
            .create_edge_command(NewEdgeCommand {
                job_id: job.id.clone(),
                target_id: routes.source.target_id.clone(),
                provider_node_id: provider_node_id.to_string(),
                tool_name: crate::artifact::ARTIFACT_TRANSFER_TOOL_NAME.to_string(),
                arguments: crate::artifact::execution_arguments_from_transfer_request(request)?,
                route: edge_artifact_transfer_route_from_job(job, routes)?,
            })
            .await?;

        loop {
            let command = self
                .store
                .get_edge_command(&job.id)
                .await?
                .ok_or("Edge Artifact Command 在等待期间消失")?;
            match command.status {
                EdgeCommandStatus::Succeeded => {
                    let output = command
                        .output
                        .as_deref()
                        .ok_or("Edge Artifact Command 成功但没有 Receipt")?;
                    let mut receipt: crate::artifact::ArtifactTransferReceipt =
                        serde_json::from_str(output)?;
                    // The Edge worker localizes both endpoints to its own
                    // `target-default` before physical execution. Restore the
                    // cloud-authoritative locations in the public receipt.
                    receipt.source.location = request.source.clone();
                    receipt.destination.location = request.destination.clone();
                    receipt.transport = "edge_local_copy".to_string();
                    receipt.validate_against(request)?;
                    return Ok(receipt);
                }
                EdgeCommandStatus::Failed => {
                    return Err(command
                        .error
                        .unwrap_or_else(|| "Edge Artifact transfer failed".to_string())
                        .into())
                }
                EdgeCommandStatus::Cancelled => {
                    return Err(crate::artifact::ArtifactTransferCancelled.into())
                }
                EdgeCommandStatus::Lost => {
                    return Err(command
                        .error
                        .unwrap_or_else(|| "Edge Artifact transfer outcome is unknown".to_string())
                        .into())
                }
                EdgeCommandStatus::Queued
                | EdgeCommandStatus::Claimed
                | EdgeCommandStatus::CancelRequested => {
                    tokio::time::sleep(self.poll_interval).await;
                }
            }
        }
    }
}

/// Executes a transfer wholly inside one user-owned Provider Node, while one
/// or both logical endpoints are Managed SSH Targets proxied by that Node.
/// The cloud never opens SSH and never receives credentials or payload bytes;
/// it only persists the frozen dual Route and waits for the Node-side Runtime
/// to apply its own PermissionBroker at the physical boundary.
pub struct EdgeProxyArtifactTransferBackend {
    store: Arc<dyn EdgeExecutionStore>,
    poll_interval: std::time::Duration,
}

impl EdgeProxyArtifactTransferBackend {
    pub fn new(store: Arc<dyn EdgeExecutionStore>) -> Self {
        Self {
            store,
            poll_interval: std::time::Duration::from_millis(250),
        }
    }
}

#[async_trait::async_trait]
impl ArtifactTransferExecutionBackend for EdgeProxyArtifactTransferBackend {
    fn name(&self) -> &'static str {
        "edge_proxy_managed_ssh"
    }

    fn supports(
        &self,
        source: &ExecutionRouteSnapshot,
        destination: &ExecutionRouteSnapshot,
    ) -> bool {
        let supported = |route: &ExecutionRouteSnapshot| {
            matches!(
                route.backend_kind,
                ExecutionTargetKind::EdgeNode | ExecutionTargetKind::ManagedSsh
            ) && route.provider_node_id.is_some()
        };
        supported(source)
            && supported(destination)
            && source.provider_node_id == destination.provider_node_id
            && (source.backend_kind == ExecutionTargetKind::ManagedSsh
                || destination.backend_kind == ExecutionTargetKind::ManagedSsh)
    }

    async fn execute_transfer(
        &self,
        job: &ExecutionJobRecord,
        routes: &ArtifactTransferRouteSnapshot,
        request: &crate::artifact::ArtifactTransferRequest,
    ) -> Result<crate::artifact::ArtifactTransferReceipt, TargetExecutionError> {
        if !self.supports(&routes.source, &routes.destination) {
            return Err("Edge proxy Artifact transport 只接受同一 Provider Node 内的 Edge/Managed SSH Route".into());
        }
        let provider_node_id = routes
            .source
            .provider_node_id
            .clone()
            .ok_or("Edge proxy Artifact Route 缺少 provider_node_id")?;
        self.store
            .create_edge_command(NewEdgeCommand {
                job_id: job.id.clone(),
                target_id: routes.destination.target_id.clone(),
                provider_node_id,
                tool_name: crate::artifact::ARTIFACT_TRANSFER_TOOL_NAME.to_string(),
                arguments: crate::artifact::execution_arguments_from_transfer_request(request)?,
                route: edge_artifact_transfer_route_from_job(job, routes)?,
            })
            .await?;

        loop {
            let command = self
                .store
                .get_edge_command(&job.id)
                .await?
                .ok_or("Edge proxy Artifact Command 在等待期间消失")?;
            match command.status {
                EdgeCommandStatus::Succeeded => {
                    let mut receipt: crate::artifact::ArtifactTransferReceipt =
                        serde_json::from_str(
                            command
                                .output
                                .as_deref()
                                .ok_or("Edge proxy Artifact Command 成功但没有 Receipt")?,
                        )?;
                    receipt.source.location = request.source.clone();
                    receipt.destination.location = request.destination.clone();
                    receipt.transport = "edge_proxy_managed_ssh".to_string();
                    receipt.validate_against(request)?;
                    return Ok(receipt);
                }
                EdgeCommandStatus::Failed => {
                    return Err(command
                        .error
                        .unwrap_or_else(|| "Edge proxy Artifact transfer failed".to_string())
                        .into())
                }
                EdgeCommandStatus::Cancelled => {
                    return Err(crate::artifact::ArtifactTransferCancelled.into())
                }
                EdgeCommandStatus::Lost => {
                    return Err(command
                        .error
                        .unwrap_or_else(|| {
                            "Edge proxy Artifact transfer outcome is unknown".to_string()
                        })
                        .into())
                }
                EdgeCommandStatus::Queued
                | EdgeCommandStatus::Claimed
                | EdgeCommandStatus::CancelRequested => {
                    tokio::time::sleep(self.poll_interval).await;
                }
            }
        }
    }
}

/// Runtime↔Edge byte channel. Runtime-owned staging is not a user-visible
/// Target and never weakens endpoint policy: the Runtime endpoint is checked
/// here, while the Edge endpoint is checked again by the Node's own
/// PermissionBroker before local publication/read.
pub struct RuntimeEdgeArtifactTransferBackend {
    store: Arc<dyn EdgeExecutionStore>,
    jobs: Arc<dyn ExecutionJobStore>,
    stages: crate::artifact::ArtifactTransferStageStore,
    permissions: Arc<crate::permission::PermissionBroker>,
    poll_interval: std::time::Duration,
}

impl RuntimeEdgeArtifactTransferBackend {
    pub fn new(
        store: Arc<dyn EdgeExecutionStore>,
        jobs: Arc<dyn ExecutionJobStore>,
        stages: crate::artifact::ArtifactTransferStageStore,
        permissions: Arc<crate::permission::PermissionBroker>,
    ) -> Self {
        Self {
            store,
            jobs,
            stages,
            permissions,
            poll_interval: std::time::Duration::from_millis(250),
        }
    }

    async fn wait_for_edge_receipt(
        &self,
        job_id: &str,
    ) -> Result<crate::artifact::ArtifactTransferReceipt, TargetExecutionError> {
        loop {
            if self
                .jobs
                .get_execution_job(job_id)
                .await?
                .is_some_and(|job| job.cancel_requested_at.is_some())
            {
                let _ = self.store.request_edge_command_cancel(job_id).await?;
            }
            let command = self
                .store
                .get_edge_command(job_id)
                .await?
                .ok_or("Edge Artifact Command 在等待期间消失")?;
            match command.status {
                EdgeCommandStatus::Succeeded => {
                    return Ok(serde_json::from_str(command.output.as_deref().ok_or(
                        "Edge Artifact Command 成功但没有 ArtifactTransferReceipt",
                    )?)?)
                }
                EdgeCommandStatus::Failed => {
                    return Err(command
                        .error
                        .unwrap_or_else(|| "Edge Artifact transfer failed".to_string())
                        .into())
                }
                EdgeCommandStatus::Cancelled => {
                    return Err(crate::artifact::ArtifactTransferCancelled.into())
                }
                EdgeCommandStatus::Lost => {
                    return Err(command
                        .error
                        .unwrap_or_else(|| "Edge Artifact transfer outcome is unknown".to_string())
                        .into())
                }
                EdgeCommandStatus::Queued
                | EdgeCommandStatus::Claimed
                | EdgeCommandStatus::CancelRequested => {
                    tokio::time::sleep(self.poll_interval).await;
                }
            }
        }
    }

    async fn authorize_runtime_endpoint(
        &self,
        request: &crate::artifact::ArtifactTransferRequest,
        access: crate::permission::FilesystemAccess,
    ) -> Result<PathBuf, TargetExecutionError> {
        let location = if access == crate::permission::FilesystemAccess::Read {
            &request.source
        } else {
            &request.destination
        };
        let mut requested = CapabilityDelta::default();
        let path = match self
            .permissions
            .profile()
            .inspect_path(&location.path, access)?
        {
            crate::permission::PathDecision::Allowed(path) => path,
            crate::permission::PathDecision::Denied(reason) => return Err(reason.into()),
            crate::permission::PathDecision::NeedsApproval {
                candidate,
                resolved_anchor,
            } => {
                match access {
                    crate::permission::FilesystemAccess::Read => {
                        requested.read_roots.push(resolved_anchor)
                    }
                    crate::permission::FilesystemAccess::Write => {
                        requested.write_roots.push(resolved_anchor)
                    }
                }
                candidate
            }
        };
        self.permissions
            .authorize_delta(
                ApprovalAction::ToolOperation {
                    tool: crate::artifact::ARTIFACT_TRANSFER_TOOL_NAME.to_string(),
                    operation: "transfer".to_string(),
                    target: Some(path.clone()),
                },
                requested,
                format!("Artifact Transfer 访问 Runtime 路径 '{}'", location.path),
                crate::tool::current_approval_context(),
            )
            .await?;
        Ok(path)
    }
}

#[async_trait::async_trait]
impl ArtifactTransferExecutionBackend for RuntimeEdgeArtifactTransferBackend {
    fn name(&self) -> &'static str {
        "runtime_edge_channel"
    }

    fn supports(
        &self,
        source: &ExecutionRouteSnapshot,
        destination: &ExecutionRouteSnapshot,
    ) -> bool {
        matches!(
            (source.backend_kind, destination.backend_kind),
            (
                ExecutionTargetKind::InProcessLocal,
                ExecutionTargetKind::EdgeNode
            ) | (
                ExecutionTargetKind::EdgeNode,
                ExecutionTargetKind::InProcessLocal
            )
        ) && (source.backend_kind != ExecutionTargetKind::EdgeNode
            || source.provider_node_id.is_some())
            && (destination.backend_kind != ExecutionTargetKind::EdgeNode
                || destination.provider_node_id.is_some())
    }

    async fn execute_transfer(
        &self,
        job: &ExecutionJobRecord,
        routes: &ArtifactTransferRouteSnapshot,
        request: &crate::artifact::ArtifactTransferRequest,
    ) -> Result<crate::artifact::ArtifactTransferReceipt, TargetExecutionError> {
        request.validate()?;
        let (direction, channel, command_target, provider_node_id) =
            if routes.source.backend_kind == ExecutionTargetKind::InProcessLocal {
                let source = self
                    .authorize_runtime_endpoint(request, crate::permission::FilesystemAccess::Read)
                    .await?;
                let stage = self
                    .stages
                    .prepare_stage_path(
                        &job.id,
                        crate::artifact::ArtifactTransferStageKind::RuntimeSource,
                    )
                    .await?;
                let staged = spool_local_artifact(&source, &stage).await?;
                if request
                    .expected_source_digest
                    .as_deref()
                    .is_some_and(|expected| expected != staged.logical_digest())
                {
                    return Err(format!(
                        "Artifact source digest 冲突：期望 '{}'，实际 '{}'",
                        request
                            .expected_source_digest
                            .as_deref()
                            .unwrap_or_default(),
                        staged.logical_digest()
                    )
                    .into());
                }
                let edge = &routes.destination;
                (
                    EdgeArtifactDataDirection::RuntimeToEdge,
                    EdgeArtifactDataChannel {
                        direction: EdgeArtifactDataDirection::RuntimeToEdge,
                        payload_kind: staged.kind.into(),
                        expected_digest: Some(staged.payload_digest),
                        size_bytes: Some(staged.payload_size_bytes),
                    },
                    edge.target_id.clone(),
                    edge.provider_node_id
                        .clone()
                        .ok_or("Edge destination Route 缺少 provider_node_id")?,
                )
            } else {
                let edge = &routes.source;
                (
                    EdgeArtifactDataDirection::EdgeToRuntime,
                    EdgeArtifactDataChannel {
                        direction: EdgeArtifactDataDirection::EdgeToRuntime,
                        payload_kind: EdgeArtifactPayloadKind::Detect,
                        // The target-local Artifact digest is not necessarily
                        // the digest of its wire representation (directories
                        // use a canonical archive), so it is validated from
                        // the Tool Receipt after materialization.
                        expected_digest: None,
                        size_bytes: None,
                    },
                    edge.target_id.clone(),
                    edge.provider_node_id
                        .clone()
                        .ok_or("Edge source Route 缺少 provider_node_id")?,
                )
            };
        let mut route = edge_artifact_transfer_route_from_job(job, routes)?;
        attach_edge_artifact_data_channel(&mut route, &channel)?;
        self.store
            .create_edge_command(NewEdgeCommand {
                job_id: job.id.clone(),
                target_id: command_target,
                provider_node_id,
                tool_name: crate::artifact::ARTIFACT_TRANSFER_TOOL_NAME.to_string(),
                arguments: crate::artifact::execution_arguments_from_transfer_request(request)?,
                route,
            })
            .await?;
        let mut receipt = self.wait_for_edge_receipt(&job.id).await?;

        if direction == EdgeArtifactDataDirection::EdgeToRuntime {
            let logical_digest = receipt
                .source
                .content_digest
                .clone()
                .ok_or("Edge Artifact Receipt 缺少 source digest")?;
            let logical_size = receipt
                .source
                .size_bytes
                .ok_or("Edge Artifact Receipt 缺少大小")?;
            let stage = self.stages.stage_path(
                &job.id,
                crate::artifact::ArtifactTransferStageKind::EdgeUpload,
            );
            let kind = if receipt.source.media_type.as_deref()
                == Some("application/vnd.morphz.directory")
            {
                StagedArtifactKind::DirectoryArchive
            } else {
                StagedArtifactKind::File
            };
            let destination = self
                .authorize_runtime_endpoint(request, crate::permission::FilesystemAccess::Write)
                .await?;
            let mut publish_request = request.clone();
            // The exact upload bytes are separately verified by the Edge data
            // channel. A directory's logical digest describes the tree, not
            // its canonical archive, so publication must not compare those
            // two different representations.
            publish_request.expected_source_digest = None;
            publish_spooled_local_artifact(&publish_request, &stage, &destination, kind).await?;
            receipt.source.location = request.source.clone();
            receipt.destination.location = request.destination.clone();
            receipt.source.content_digest = Some(logical_digest.clone());
            receipt.destination.content_digest = Some(logical_digest);
            receipt.source.size_bytes = Some(logical_size);
            receipt.destination.size_bytes = Some(logical_size);
        } else {
            receipt.source.location = request.source.clone();
            receipt.destination.location = request.destination.clone();
        }
        receipt.transport = "runtime_edge_channel".to_string();
        receipt.validate_against(request)?;
        let _ = self.stages.remove_job(&job.id).await;
        Ok(receipt)
    }
}

/// Edge A→Edge B relay. Each physical leg is a durable child Execution Job
/// under the caller-visible parent transfer, so command identity, cancellation
/// and restart reconciliation remain explicit instead of overloading one Edge
/// command row with two owners.
pub struct EdgeRelayArtifactTransferBackend {
    edges: Arc<dyn EdgeExecutionStore>,
    jobs: Arc<dyn ExecutionJobStore>,
    stages: crate::artifact::ArtifactTransferStageStore,
    poll_interval: std::time::Duration,
}

impl EdgeRelayArtifactTransferBackend {
    pub fn new(
        edges: Arc<dyn EdgeExecutionStore>,
        jobs: Arc<dyn ExecutionJobStore>,
        stages: crate::artifact::ArtifactTransferStageStore,
    ) -> Self {
        Self {
            edges,
            jobs,
            stages,
            poll_interval: std::time::Duration::from_millis(250),
        }
    }

    async fn create_and_claim_leg(
        &self,
        parent: &ExecutionJobRecord,
        routes: &ArtifactTransferRouteSnapshot,
        request: &crate::artifact::ArtifactTransferRequest,
        leg: &str,
        target_id: &str,
    ) -> Result<(ExecutionJobRecord, String), TargetExecutionError> {
        let id = crate::artifact::artifact_transfer_relay_leg_job_id(&parent.id, leg);
        let mut request_value = serde_json::to_value(request)?;
        attach_artifact_transfer_routes(&mut request_value, routes)?;
        let job = self
            .jobs
            .create_execution_job(NewExecutionJob {
                id,
                activation_id: parent.activation_id.clone(),
                thread_id: parent.thread_id.clone(),
                agent_id: parent.agent_id.clone(),
                context_id: parent.context_id.clone(),
                session_id: parent.session_id.clone(),
                initiating_principal_id: parent.initiating_principal_id.clone(),
                target_id: target_id.to_string(),
                tool_call_id: format!("{}:{leg}", parent.tool_call_id),
                tool_name: crate::artifact::ARTIFACT_TRANSFER_TOOL_NAME.to_string(),
                request: request_value,
                retry_safety: ExecutionRetrySafety::Idempotent,
                // Keeps the generic Runtime worker from claiming this private
                // relay leg between materialization and the relay claim.
                requires_approval: true,
            })
            .await?;
        if job.status.is_terminal() {
            return if job.status == ExecutionJobStatus::Succeeded {
                Ok((job, String::new()))
            } else {
                Err(format!(
                    "Artifact relay leg '{}' 已以 {} 终止：{}",
                    job.id,
                    job.status.as_str(),
                    job.error.as_deref().unwrap_or("没有错误详情")
                )
                .into())
            };
        }
        let mut job = job;
        if job.status == ExecutionJobStatus::Running
            && job
                .lease_expires_at
                .is_some_and(|expires_at| expires_at <= Utc::now())
            && job.retry_safety == ExecutionRetrySafety::Idempotent
        {
            job = match self
                .jobs
                .requeue_execution_job(&job.id, job.revision)
                .await?
            {
                ExecutionJobMutation::Updated(job) | ExecutionJobMutation::Existing(job) => job,
                ExecutionJobMutation::Conflict { current } => current,
                ExecutionJobMutation::Rejected { reason, .. } => return Err(reason.into()),
                ExecutionJobMutation::NotFound => {
                    return Err("Artifact relay leg 在恢复前消失".into())
                }
            };
        }
        let claim_token = format!(
            "relay-claim-{:x}",
            Sha256::digest(format!("{}\0r{}", job.id, job.revision).as_bytes())
        );
        let claimed = self
            .jobs
            .claim_execution_job(
                &job.id,
                job.revision,
                "artifact-relay",
                &claim_token,
                Utc::now() + chrono::Duration::minutes(10),
                Some("runtime-internal-artifact-relay"),
            )
            .await?;
        match claimed {
            ExecutionJobMutation::Updated(job) | ExecutionJobMutation::Existing(job) => {
                Ok((job, claim_token))
            }
            ExecutionJobMutation::Conflict { current } => Err(format!(
                "Artifact relay leg '{}' claim 冲突：当前 {} r{}",
                current.id,
                current.status.as_str(),
                current.revision
            )
            .into()),
            ExecutionJobMutation::Rejected { reason, .. } => Err(reason.into()),
            ExecutionJobMutation::NotFound => Err("Artifact relay leg 在 claim 前消失".into()),
        }
    }

    async fn finish_leg(
        &self,
        job: &ExecutionJobRecord,
        claim_token: &str,
        status: ExecutionJobStatus,
        error: Option<String>,
    ) -> Result<(), TargetExecutionError> {
        let current = self
            .jobs
            .get_execution_job(&job.id)
            .await?
            .ok_or("Artifact relay leg 在 finish 前消失")?;
        if current.status == status && current.status.is_terminal() {
            return Ok(());
        }
        let terminal = ExecutionJobTerminal {
            status,
            result_event_id: None,
            result_refs: Vec::new(),
            error,
            exit_code: None,
        };
        match self
            .jobs
            .finish_execution_job(
                &current.id,
                current.revision,
                (!claim_token.is_empty()).then_some(claim_token),
                terminal,
            )
            .await?
        {
            ExecutionJobMutation::Updated(_) | ExecutionJobMutation::Existing(_) => Ok(()),
            ExecutionJobMutation::Conflict { current } => Err(format!(
                "Artifact relay leg '{}' finish 冲突：当前 {} r{}",
                current.id,
                current.status.as_str(),
                current.revision
            )
            .into()),
            ExecutionJobMutation::Rejected { reason, .. } => Err(reason.into()),
            ExecutionJobMutation::NotFound => Err("Artifact relay leg 在 finish 前消失".into()),
        }
    }

    async fn run_edge_leg(
        &self,
        parent_job_id: &str,
        leg_job: &ExecutionJobRecord,
        routes: &ArtifactTransferRouteSnapshot,
        request: &crate::artifact::ArtifactTransferRequest,
        route: &ExecutionRouteSnapshot,
        channel: EdgeArtifactDataChannel,
    ) -> Result<crate::artifact::ArtifactTransferReceipt, TargetExecutionError> {
        let mut command_route = edge_artifact_transfer_route_from_job(leg_job, routes)?;
        attach_edge_artifact_data_channel(&mut command_route, &channel)?;
        self.edges
            .create_edge_command(NewEdgeCommand {
                job_id: leg_job.id.clone(),
                target_id: route.target_id.clone(),
                provider_node_id: route
                    .provider_node_id
                    .clone()
                    .ok_or("Artifact relay Edge Route 缺少 provider_node_id")?,
                tool_name: crate::artifact::ARTIFACT_TRANSFER_TOOL_NAME.to_string(),
                arguments: crate::artifact::execution_arguments_from_transfer_request(request)?,
                route: command_route,
            })
            .await?;
        loop {
            if self
                .jobs
                .get_execution_job(parent_job_id)
                .await?
                .is_some_and(|job| job.cancel_requested_at.is_some())
            {
                let _ = self.edges.request_edge_command_cancel(&leg_job.id).await?;
            }
            let command = self
                .edges
                .get_edge_command(&leg_job.id)
                .await?
                .ok_or("Artifact relay Edge Command 消失")?;
            match command.status {
                EdgeCommandStatus::Succeeded => {
                    return Ok(serde_json::from_str(
                        command
                            .output
                            .as_deref()
                            .ok_or("Artifact relay leg 缺少 Receipt")?,
                    )?)
                }
                EdgeCommandStatus::Failed => {
                    return Err(command
                        .error
                        .unwrap_or_else(|| "Edge relay failed".to_string())
                        .into())
                }
                EdgeCommandStatus::Cancelled => {
                    return Err(crate::artifact::ArtifactTransferCancelled.into())
                }
                EdgeCommandStatus::Lost => return Err("Edge relay leg outcome lost".into()),
                _ => tokio::time::sleep(self.poll_interval).await,
            }
        }
    }
}

#[async_trait::async_trait]
impl ArtifactTransferExecutionBackend for EdgeRelayArtifactTransferBackend {
    fn name(&self) -> &'static str {
        "edge_relay_channel"
    }

    fn supports(
        &self,
        source: &ExecutionRouteSnapshot,
        destination: &ExecutionRouteSnapshot,
    ) -> bool {
        source.backend_kind == ExecutionTargetKind::EdgeNode
            && destination.backend_kind == ExecutionTargetKind::EdgeNode
            && source.provider_node_id.is_some()
            && destination.provider_node_id.is_some()
            && (source.provider_node_id != destination.provider_node_id
                || source.target_id != destination.target_id)
    }

    async fn execute_transfer(
        &self,
        parent: &ExecutionJobRecord,
        routes: &ArtifactTransferRouteSnapshot,
        request: &crate::artifact::ArtifactTransferRequest,
    ) -> Result<crate::artifact::ArtifactTransferReceipt, TargetExecutionError> {
        crate::artifact::report_artifact_bytes("edge_source", 0, None);
        let (source_leg, source_claim) = self
            .create_and_claim_leg(parent, routes, request, "source", &routes.source.target_id)
            .await?;
        let source_result = self
            .run_edge_leg(
                &parent.id,
                &source_leg,
                routes,
                request,
                &routes.source,
                EdgeArtifactDataChannel {
                    direction: EdgeArtifactDataDirection::EdgeToRuntime,
                    payload_kind: EdgeArtifactPayloadKind::Detect,
                    expected_digest: None,
                    size_bytes: None,
                },
            )
            .await;
        let source_receipt = match source_result {
            Ok(receipt) => {
                self.finish_leg(
                    &source_leg,
                    &source_claim,
                    ExecutionJobStatus::Succeeded,
                    None,
                )
                .await?;
                receipt
            }
            Err(error) => {
                let status = if crate::artifact::is_artifact_transfer_cancelled(error.as_ref()) {
                    ExecutionJobStatus::Cancelled
                } else {
                    ExecutionJobStatus::Failed
                };
                let message = error.to_string();
                let _ = self
                    .finish_leg(&source_leg, &source_claim, status, Some(message.clone()))
                    .await;
                return Err(error);
            }
        };
        source_receipt
            .source
            .content_digest
            .as_deref()
            .ok_or("Artifact relay source Receipt 缺少 digest")?;
        let logical_size = source_receipt
            .source
            .size_bytes
            .ok_or("Artifact relay source Receipt 缺少 size")?;
        let payload_kind = if source_receipt.source.media_type.as_deref()
            == Some("application/vnd.morphz.directory")
        {
            EdgeArtifactPayloadKind::DirectoryArchive
        } else {
            EdgeArtifactPayloadKind::File
        };
        crate::artifact::report_artifact_bytes("edge_relay", 0, Some(logical_size));

        let (destination_leg, destination_claim) = self
            .create_and_claim_leg(
                parent,
                routes,
                request,
                "destination",
                &routes.destination.target_id,
            )
            .await?;
        let source_stage = self.stages.stage_path(
            &source_leg.id,
            crate::artifact::ArtifactTransferStageKind::EdgeUpload,
        );
        let (payload_size, payload_digest) = hash_file(&source_stage).await?;
        let destination_stage = self
            .stages
            .prepare_stage_path(
                &destination_leg.id,
                crate::artifact::ArtifactTransferStageKind::RuntimeSource,
            )
            .await?;
        let mut source_file = tokio::fs::File::open(&source_stage).await?;
        let mut destination_file = tokio::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&destination_stage)
            .await?;
        let mut relayed = 0_u64;
        let mut buffer = vec![0_u8; 128 * 1024];
        loop {
            let count = source_file.read(&mut buffer).await?;
            if count == 0 {
                break;
            }
            destination_file.write_all(&buffer[..count]).await?;
            relayed = relayed.saturating_add(count as u64);
            crate::artifact::report_artifact_bytes("edge_relay", relayed, Some(payload_size));
        }
        destination_file.flush().await?;
        destination_file.sync_data().await?;
        crate::artifact::report_artifact_bytes("edge_destination", 0, Some(payload_size));
        let destination_result = self
            .run_edge_leg(
                &parent.id,
                &destination_leg,
                routes,
                request,
                &routes.destination,
                EdgeArtifactDataChannel {
                    direction: EdgeArtifactDataDirection::RuntimeToEdge,
                    payload_kind,
                    expected_digest: Some(payload_digest),
                    size_bytes: Some(payload_size),
                },
            )
            .await;
        let mut receipt = match destination_result {
            Ok(receipt) => {
                self.finish_leg(
                    &destination_leg,
                    &destination_claim,
                    ExecutionJobStatus::Succeeded,
                    None,
                )
                .await?;
                receipt
            }
            Err(error) => {
                let status = if crate::artifact::is_artifact_transfer_cancelled(error.as_ref()) {
                    ExecutionJobStatus::Cancelled
                } else {
                    ExecutionJobStatus::Failed
                };
                let message = error.to_string();
                let _ = self
                    .finish_leg(
                        &destination_leg,
                        &destination_claim,
                        status,
                        Some(message.clone()),
                    )
                    .await;
                return Err(error);
            }
        };
        receipt.source.location = request.source.clone();
        receipt.destination.location = request.destination.clone();
        receipt.transport = "edge_relay_channel".to_string();
        receipt.validate_against(request)?;
        let _ = self.stages.remove_job(&source_leg.id).await;
        let _ = self.stages.remove_job(&destination_leg.id).await;
        Ok(receipt)
    }
}

/// Routes Managed SSH either through the owning Edge Node or through the
/// current Runtime. A Target with `provider_node_id` is always remote; a
/// Runtime-local Target must name an endpoint loaded from host-owned config.
pub struct ManagedSshBackend {
    edge: EdgeNodeBackend,
    local_endpoints: Arc<RwLock<HashMap<String, ManagedSshEndpoint>>>,
    stages: crate::artifact::ArtifactTransferStageStore,
    permissions: Arc<crate::permission::PermissionBroker>,
    permission_policy_digest: String,
    approval_required: bool,
}

impl ManagedSshBackend {
    pub fn new(
        store: Arc<dyn EdgeExecutionStore>,
        local_endpoints: Arc<RwLock<HashMap<String, ManagedSshEndpoint>>>,
        stages: crate::artifact::ArtifactTransferStageStore,
        permissions: Arc<crate::permission::PermissionBroker>,
        permission_policy_digest: String,
        approval_required: bool,
    ) -> Self {
        Self {
            edge: EdgeNodeBackend::managed_ssh(store),
            local_endpoints,
            stages,
            permissions,
            permission_policy_digest,
            approval_required,
        }
    }
}

#[async_trait::async_trait]
impl ExecutionTargetBackend for ManagedSshBackend {
    fn kind(&self) -> ExecutionTargetKind {
        ExecutionTargetKind::ManagedSsh
    }

    async fn execute(
        &self,
        context: &TargetExecutionContext,
        tool: Arc<dyn Tool>,
        arguments: &str,
    ) -> Result<String, TargetExecutionError> {
        if context.target.provider_node_id.is_some() {
            return self.edge.execute(context, tool, arguments).await;
        }
        if context.target.status != ExecutionTargetStatus::Online {
            return Err(format!(
                "Runtime Managed SSH Target '{}' 当前为 {}，不能执行",
                context.target.id,
                context.target.status.as_str()
            )
            .into());
        }
        if !matches!(
            tool.name(),
            "exec" | "read" | "write" | "edit" | "list_files" | "search"
        ) {
            return Err(format!(
                "Managed SSH Target '{}' 尚未实现工具 '{}' 的远端执行协议",
                context.target.id,
                tool.name()
            )
            .into());
        }
        let route = route_snapshot_from_job(&context.job)?;
        let endpoint_ref = route
            .endpoint_ref
            .as_deref()
            .ok_or("Runtime Managed SSH Route 缺少 endpoint_ref")?;
        let endpoint = self
            .local_endpoints
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(endpoint_ref)
            .cloned()
            .ok_or_else(|| format!("Runtime 未配置 Managed SSH endpoint '{endpoint_ref}'"))?;
        if self.approval_required {
            let requires_ssh_agent =
                std::env::var_os("SSH_AUTH_SOCK").is_some_and(|value| !value.is_empty());
            let approved = crate::permission::CURRENT_DURABLE_APPROVAL
                .try_with(|grant| {
                    grant.as_ref().is_some_and(|grant| {
                        grant.policy_digest == self.permission_policy_digest
                            && grant.requested.network
                            && (!requires_ssh_agent
                                || grant
                                    .requested
                                    .secret_env
                                    .iter()
                                    .any(|name| name == "SSH_AUTH_SOCK"))
                            && matches!(
                                &grant.action,
                                ApprovalAction::ToolOperation {
                                    tool,
                                    operation,
                                    ..
                                } if tool == context.job.tool_name.as_str()
                                    && operation == "execute_on_remote_target"
                            )
                    })
                })
                .unwrap_or(false);
            if !approved {
                return Err(
                    "Runtime Managed SSH 缺少当前 Target 的有效审批或 Capability Lease，拒绝建立连接"
                        .into(),
                );
            }
        }
        match tool.name() {
            "exec" => {
                let prepared = prepare_managed_ssh_exec_arguments(
                    endpoint_ref,
                    &endpoint,
                    &context.target.id,
                    arguments,
                )?;
                crate::tool::CURRENT_RUNTIME_MANAGED_SSH
                    .scope(true, tool.execute(&prepared))
                    .await
            }
            "read" | "write" | "edit" | "list_files" | "search" => {
                execute_managed_ssh_file_tool(
                    &endpoint,
                    context.target.workspace_root.as_deref(),
                    tool.name(),
                    arguments,
                )
                .await
            }
            _ => unreachable!("Managed SSH tool support is checked above"),
        }
    }
}

#[async_trait::async_trait]
impl ArtifactTransferExecutionBackend for ManagedSshBackend {
    fn name(&self) -> &'static str {
        "runtime_managed_ssh"
    }

    fn supports(
        &self,
        source: &ExecutionRouteSnapshot,
        destination: &ExecutionRouteSnapshot,
    ) -> bool {
        let supported = |route: &ExecutionRouteSnapshot| {
            route.backend_kind == ExecutionTargetKind::InProcessLocal
                || (route.backend_kind == ExecutionTargetKind::ManagedSsh
                    && route.provider_node_id.is_none())
        };
        supported(source)
            && supported(destination)
            && (source.backend_kind == ExecutionTargetKind::ManagedSsh
                || destination.backend_kind == ExecutionTargetKind::ManagedSsh)
    }

    async fn execute_transfer(
        &self,
        job: &ExecutionJobRecord,
        routes: &ArtifactTransferRouteSnapshot,
        request: &crate::artifact::ArtifactTransferRequest,
    ) -> Result<crate::artifact::ArtifactTransferReceipt, TargetExecutionError> {
        request.validate()?;
        self.authorize_artifact_transfer(routes, request).await?;

        let spool_path = self
            .stages
            .prepare_stage_path(
                &job.id,
                crate::artifact::ArtifactTransferStageKind::RuntimeSource,
            )
            .await?;
        let staged = match routes.source.backend_kind {
            ExecutionTargetKind::InProcessLocal => {
                let source = self.local_transfer_path(
                    &request.source.path,
                    crate::permission::FilesystemAccess::Read,
                )?;
                spool_local_artifact(&source, &spool_path).await?
            }
            ExecutionTargetKind::ManagedSsh => {
                let endpoint = self.endpoint_for_route(&routes.source)?;
                download_managed_ssh_artifact(&endpoint, &request.source.path, &spool_path).await?
            }
            _ => return Err("Runtime Managed SSH transport 收到不支持的 source Route".into()),
        };
        if request
            .expected_source_digest
            .as_deref()
            .is_some_and(|expected| expected != staged.logical_digest())
        {
            return Err(format!(
                "Artifact source digest 冲突：期望 '{}'，实际 '{}'",
                request
                    .expected_source_digest
                    .as_deref()
                    .unwrap_or_default(),
                staged.logical_digest()
            )
            .into());
        }

        match routes.destination.backend_kind {
            ExecutionTargetKind::InProcessLocal => {
                let destination = self.local_transfer_path(
                    &request.destination.path,
                    crate::permission::FilesystemAccess::Write,
                )?;
                publish_spooled_local_artifact(request, &spool_path, &destination, staged.kind)
                    .await?;
            }
            ExecutionTargetKind::ManagedSsh => {
                let endpoint = self.endpoint_for_route(&routes.destination)?;
                upload_managed_ssh_artifact(
                    &endpoint,
                    &spool_path,
                    &request.destination.path,
                    request.overwrite,
                    &request.transfer_id,
                    &staged.payload_digest,
                    staged.logical_digest(),
                    staged.kind,
                )
                .await?;
            }
            _ => return Err("Runtime Managed SSH transport 收到不支持的 destination Route".into()),
        }

        let artifact_id = format!("artifact:{}", staged.logical_digest());
        let descriptor =
            |location: crate::artifact::ArtifactLocation| crate::artifact::ArtifactDescriptor {
                artifact_id: artifact_id.clone(),
                location,
                content_digest: Some(staged.logical_digest().to_string()),
                size_bytes: Some(staged.logical_size_bytes()),
                media_type: request.media_type.clone().or_else(|| {
                    (staged.kind == StagedArtifactKind::DirectoryArchive)
                        .then(|| "application/vnd.morphz.directory".to_string())
                }),
                origin: request.origin.clone(),
            };
        let receipt = crate::artifact::ArtifactTransferReceipt {
            transfer_id: request.transfer_id.clone(),
            source: descriptor(request.source.clone()),
            destination: descriptor(request.destination.clone()),
            transport: "runtime_managed_ssh".to_string(),
            bytes_transferred: staged.logical_size_bytes(),
        };
        let _ = self.stages.remove_job(&job.id).await;
        Ok(receipt)
    }
}

impl ManagedSshBackend {
    async fn authorize_artifact_transfer(
        &self,
        routes: &ArtifactTransferRouteSnapshot,
        request: &crate::artifact::ArtifactTransferRequest,
    ) -> Result<(), TargetExecutionError> {
        let mut requested = CapabilityDelta::default();
        if routes.source.backend_kind == ExecutionTargetKind::InProcessLocal {
            extend_local_transfer_delta(
                self.permissions.as_ref(),
                &request.source.path,
                crate::permission::FilesystemAccess::Read,
                &mut requested,
            )?;
        } else {
            requested.network = true;
            requested
                .read_roots
                .push(PathBuf::from(&request.source.path));
        }
        if routes.destination.backend_kind == ExecutionTargetKind::InProcessLocal {
            extend_local_transfer_delta(
                self.permissions.as_ref(),
                &request.destination.path,
                crate::permission::FilesystemAccess::Write,
                &mut requested,
            )?;
        } else {
            requested.network = true;
            requested
                .write_roots
                .push(PathBuf::from(&request.destination.path));
        }
        if (routes.source.backend_kind == ExecutionTargetKind::ManagedSsh
            || routes.destination.backend_kind == ExecutionTargetKind::ManagedSsh)
            && std::env::var_os("SSH_AUTH_SOCK").is_some_and(|value| !value.is_empty())
        {
            requested.secret_env.push("SSH_AUTH_SOCK".to_string());
        }
        self.permissions
            .authorize_delta(
                ApprovalAction::ToolOperation {
                    tool: crate::artifact::ARTIFACT_TRANSFER_TOOL_NAME.to_string(),
                    operation: "transfer".to_string(),
                    target: None,
                },
                requested,
                format!(
                    "Artifact Transfer 读取 Target '{}' 的 '{}' 并写入 Target '{}' 的 '{}'",
                    request.source.target_id,
                    request.source.path,
                    request.destination.target_id,
                    request.destination.path
                ),
                crate::tool::current_approval_context(),
            )
            .await?;
        Ok(())
    }

    fn local_transfer_path(
        &self,
        path: &str,
        access: crate::permission::FilesystemAccess,
    ) -> Result<PathBuf, TargetExecutionError> {
        match self.permissions.profile().inspect_path(path, access)? {
            crate::permission::PathDecision::Allowed(path)
            | crate::permission::PathDecision::NeedsApproval {
                candidate: path, ..
            } => Ok(path),
            crate::permission::PathDecision::Denied(reason) => Err(reason.into()),
        }
    }

    fn endpoint_for_route(
        &self,
        route: &ExecutionRouteSnapshot,
    ) -> Result<ManagedSshEndpoint, TargetExecutionError> {
        if route.backend_kind != ExecutionTargetKind::ManagedSsh || route.provider_node_id.is_some()
        {
            return Err("Route 不是 Runtime Managed SSH endpoint".into());
        }
        let endpoint_ref = route
            .endpoint_ref
            .as_deref()
            .ok_or("Runtime Managed SSH Route 缺少 endpoint_ref")?;
        let endpoint = self
            .local_endpoints
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(endpoint_ref)
            .cloned()
            .ok_or_else(|| format!("Runtime 未配置 Managed SSH endpoint '{endpoint_ref}'"))?;
        validate_managed_ssh_endpoint_for_transfer(endpoint_ref, &endpoint)?;
        Ok(endpoint)
    }
}

fn extend_local_transfer_delta(
    permissions: &crate::permission::PermissionBroker,
    path: &str,
    access: crate::permission::FilesystemAccess,
    requested: &mut CapabilityDelta,
) -> Result<(), TargetExecutionError> {
    match permissions.profile().inspect_path(path, access)? {
        crate::permission::PathDecision::Allowed(_) => {}
        crate::permission::PathDecision::Denied(reason) => return Err(reason.into()),
        crate::permission::PathDecision::NeedsApproval {
            resolved_anchor, ..
        } => match access {
            crate::permission::FilesystemAccess::Read => requested.read_roots.push(resolved_anchor),
            crate::permission::FilesystemAccess::Write => {
                requested.write_roots.push(resolved_anchor)
            }
        },
    }
    Ok(())
}

fn validate_managed_ssh_endpoint_for_transfer(
    endpoint_ref: &str,
    endpoint: &ManagedSshEndpoint,
) -> Result<(), TargetExecutionError> {
    validate_endpoint_ref(endpoint_ref)?;
    endpoint.validate()?;
    if !endpoint.approved {
        return Err(format!("Managed SSH endpoint '{endpoint_ref}' 尚未明确批准").into());
    }
    if endpoint.destination.is_none()
        && std::env::var_os("SSH_AUTH_SOCK").is_none_or(|value| value.is_empty())
    {
        return Err("静态 Managed SSH endpoint 需要 Runtime 的 SSH_AUTH_SOCK".into());
    }
    Ok(())
}

fn validate_remote_artifact_path(path: &str) -> Result<(), TargetExecutionError> {
    if path.trim().is_empty() {
        return Err("远端 Artifact path 不能为空".into());
    }
    if path.bytes().any(|byte| matches!(byte, 0 | b'\n' | b'\r')) {
        return Err("远端 Artifact path 不能包含 NUL 或换行".into());
    }
    Ok(())
}

fn managed_ssh_command(
    endpoint: &ManagedSshEndpoint,
    remote_command: &str,
) -> Result<tokio::process::Command, TargetExecutionError> {
    endpoint.validate()?;
    let mut command = tokio::process::Command::new("ssh");
    if endpoint.destination.is_none() {
        command
            .arg("-F")
            .arg("/dev/null")
            .arg("-o")
            .arg("IdentitiesOnly=no");
    }
    command
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("StrictHostKeyChecking=yes");
    let destination = match endpoint.destination.as_deref() {
        Some(host) => {
            if let Some(user) = endpoint.user.as_deref() {
                command.arg("-l").arg(user);
            }
            command.arg("-p").arg(endpoint.port.to_string());
            host.to_string()
        }
        None => {
            command
                .arg("-o")
                .arg(format!(
                    "UserKnownHostsFile={}",
                    endpoint.known_hosts_file.display()
                ))
                .arg("-p")
                .arg(endpoint.port.to_string());
            endpoint
                .user
                .as_deref()
                .map(|user| format!("{user}@{}", endpoint.host))
                .unwrap_or_else(|| endpoint.host.clone())
        }
    };
    command
        .arg("--")
        .arg(destination)
        .arg(remote_command)
        .kill_on_drop(true);
    Ok(command)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum StagedArtifactKind {
    File,
    DirectoryArchive,
}

impl From<StagedArtifactKind> for EdgeArtifactPayloadKind {
    fn from(value: StagedArtifactKind) -> Self {
        match value {
            StagedArtifactKind::File => Self::File,
            StagedArtifactKind::DirectoryArchive => Self::DirectoryArchive,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct StagedArtifact {
    #[serde(alias = "bytes_transferred")]
    payload_size_bytes: u64,
    #[serde(alias = "digest")]
    payload_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    logical_size_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    logical_digest: Option<String>,
    kind: StagedArtifactKind,
}

impl StagedArtifact {
    fn logical_size_bytes(&self) -> u64 {
        self.logical_size_bytes.unwrap_or(self.payload_size_bytes)
    }

    fn logical_digest(&self) -> &str {
        self.logical_digest
            .as_deref()
            .unwrap_or(&self.payload_digest)
    }
}

fn staged_artifact_metadata_path(spool: &Path) -> PathBuf {
    spool.with_extension("metadata.json")
}

async fn persist_staged_artifact_metadata(
    spool: &Path,
    artifact: &StagedArtifact,
) -> Result<(), TargetExecutionError> {
    let path = staged_artifact_metadata_path(spool);
    let partial = path.with_extension("json.partial");
    tokio::fs::write(&partial, serde_json::to_vec(artifact)?).await?;
    tokio::fs::rename(partial, path).await?;
    Ok(())
}

async fn reusable_staged_artifact(
    spool: &Path,
) -> Result<Option<StagedArtifact>, TargetExecutionError> {
    if !tokio::fs::try_exists(spool).await? {
        return Ok(None);
    }
    let metadata_path = staged_artifact_metadata_path(spool);
    if !tokio::fs::try_exists(&metadata_path).await? {
        // Stages written by an older Runtime did not record their content
        // kind. They cannot be safely interpreted as a directory archive.
        tokio::fs::remove_file(spool).await?;
        return Ok(None);
    }
    let artifact: StagedArtifact = serde_json::from_slice(&tokio::fs::read(&metadata_path).await?)?;
    let (size, digest) = hash_file(spool).await?;
    let directory_identity_available = artifact.kind != StagedArtifactKind::DirectoryArchive
        || (artifact.logical_size_bytes.is_some() && artifact.logical_digest.is_some());
    if size == artifact.payload_size_bytes
        && digest == artifact.payload_digest
        && directory_identity_available
    {
        Ok(Some(artifact))
    } else {
        let _ = tokio::fs::remove_file(spool).await;
        let _ = tokio::fs::remove_file(metadata_path).await;
        Ok(None)
    }
}

async fn spool_local_artifact(
    source: &std::path::Path,
    spool: &std::path::Path,
) -> Result<StagedArtifact, TargetExecutionError> {
    if let Some(artifact) = reusable_staged_artifact(spool).await? {
        return Ok(artifact);
    }
    let metadata = tokio::fs::symlink_metadata(source).await?;
    if metadata.is_dir() {
        return create_canonical_directory_archive(source, spool).await;
    }
    if !metadata.is_file() {
        return Err(format!("Artifact source '{}' 不是普通文件或目录", source.display()).into());
    }
    // A completed deterministic stage is reusable after Runtime restart. The
    // digest check below also protects against partial/foreign contents.
    let partial = spool.with_extension("partial");
    let _ = tokio::fs::remove_file(&partial).await;
    let mut reader = tokio::fs::File::open(source).await?;
    let mut writer = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&partial)
        .await?;
    crate::artifact::report_artifact_bytes("staging_source", 0, Some(metadata.len()));
    let (size, digest) = copy_and_hash(
        &mut reader,
        &mut writer,
        Some("staging_source"),
        Some(metadata.len()),
    )
    .await?;
    writer.flush().await?;
    writer.sync_data().await?;
    drop(writer);
    tokio::fs::rename(&partial, spool).await?;
    let artifact = StagedArtifact {
        payload_size_bytes: size,
        payload_digest: digest.clone(),
        logical_size_bytes: Some(size),
        logical_digest: Some(digest),
        kind: StagedArtifactKind::File,
    };
    persist_staged_artifact_metadata(spool, &artifact).await?;
    Ok(artifact)
}

async fn download_managed_ssh_artifact(
    endpoint: &ManagedSshEndpoint,
    remote_path: &str,
    spool: &std::path::Path,
) -> Result<StagedArtifact, TargetExecutionError> {
    validate_remote_artifact_path(remote_path)?;
    if let Some(artifact) = reusable_staged_artifact(spool).await? {
        return Ok(artifact);
    }
    let probe = format!(
        "if test -f {path}; then printf file; elif test -d {path}; then printf directory; else exit 44; fi",
        path = shell_quote_remote_path(remote_path)
    );
    let probe_output = run_managed_ssh_output(endpoint, &probe).await?;
    if !probe_output.status.success() {
        return Err(format!(
            "Managed SSH Artifact source '{}' 不存在或类型不受支持",
            remote_path
        )
        .into());
    }
    let kind = match String::from_utf8(probe_output.stdout)?.as_str() {
        "file" => StagedArtifactKind::File,
        "directory" => StagedArtifactKind::DirectoryArchive,
        _ => return Err("Managed SSH Artifact 类型探测返回未知结果".into()),
    };
    let remote = match kind {
        StagedArtifactKind::File => {
            format!(
                "set -eu; cat -- {path}",
                path = shell_quote_remote_path(remote_path)
            )
        }
        StagedArtifactKind::DirectoryArchive => format!(
            "set -eu; command -v tar >/dev/null 2>&1; tar -C {path} -cf - .",
            path = shell_quote_remote_path(remote_path)
        ),
    };
    let partial = spool.with_extension("partial");
    let _ = tokio::fs::remove_file(&partial).await;
    let mut command = managed_ssh_command(endpoint, &remote)?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let mut stdout = child.stdout.take().ok_or("SSH download 缺少 stdout")?;
    let mut writer = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&partial)
        .await?;
    let (size, digest) = copy_and_hash(&mut stdout, &mut writer, Some("downloading"), None).await?;
    writer.flush().await?;
    writer.sync_data().await?;
    let output = child.wait_with_output().await?;
    if !output.status.success() {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(format!(
            "Managed SSH 读取 '{}' 失败：{}",
            remote_path,
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    match kind {
        StagedArtifactKind::File => {
            tokio::fs::rename(&partial, spool).await?;
            let artifact = StagedArtifact {
                payload_size_bytes: size,
                payload_digest: digest.clone(),
                logical_size_bytes: Some(size),
                logical_digest: Some(digest),
                kind,
            };
            persist_staged_artifact_metadata(spool, &artifact).await?;
            Ok(artifact)
        }
        StagedArtifactKind::DirectoryArchive => {
            // A remote tar stream may contain host-specific metadata/order.
            // Normalize it into the same canonical representation used for a
            // local directory before assigning the Artifact digest.
            let normalized = normalize_directory_archive(&partial, spool).await;
            let _ = tokio::fs::remove_file(&partial).await;
            normalized
        }
    }
}

async fn create_canonical_directory_archive(
    source: &Path,
    spool: &Path,
) -> Result<StagedArtifact, TargetExecutionError> {
    let (logical_size_bytes, logical_digest) =
        crate::artifact::inspect_local_directory_artifact(source).await?;
    let source = source.to_path_buf();
    let partial = spool.with_extension("partial");
    let _ = tokio::fs::remove_file(&partial).await;
    crate::artifact::report_artifact_bytes("archiving_directory", 0, None);
    let build_path = partial.clone();
    tokio::task::spawn_blocking(move || build_canonical_directory_archive(&source, &build_path))
        .await
        .map_err(|error| format!("Artifact directory archive worker 失败：{error}"))??;
    tokio::fs::rename(&partial, spool).await?;
    let (size, digest) = hash_file(spool).await?;
    crate::artifact::report_artifact_bytes("archiving_directory", size, Some(size));
    let artifact = StagedArtifact {
        payload_size_bytes: size,
        payload_digest: digest,
        logical_size_bytes: Some(logical_size_bytes),
        logical_digest: Some(logical_digest),
        kind: StagedArtifactKind::DirectoryArchive,
    };
    persist_staged_artifact_metadata(spool, &artifact).await?;
    Ok(artifact)
}

/// Build the deterministic byte-channel representation of a target-local
/// directory. The returned digest/size describe the archive bytes only; the
/// logical directory digest remains the one produced by the local transfer
/// Tool Receipt.
pub(crate) async fn stage_edge_directory_archive(
    source: &Path,
    spool: &Path,
) -> Result<(u64, String), TargetExecutionError> {
    let artifact = create_canonical_directory_archive(source, spool).await?;
    Ok((artifact.payload_size_bytes, artifact.payload_digest))
}

/// Safely materialize a canonical directory payload before the ordinary
/// target-local transfer Tool runs. Archive entries and symlink targets are
/// validated by `extract_directory_archive`; the caller must still run the
/// normal PermissionBroker for the final source/destination paths.
pub(crate) async fn materialize_edge_directory_archive(
    archive: &Path,
    destination: &Path,
) -> Result<(), TargetExecutionError> {
    let _ = tokio::fs::remove_dir_all(destination).await;
    tokio::fs::create_dir_all(destination).await?;
    let archive = archive.to_path_buf();
    let destination_for_extract = destination.to_path_buf();
    let result = tokio::task::spawn_blocking(move || {
        extract_directory_archive(&archive, &destination_for_extract)
    })
    .await
    .map_err(|error| format!("Artifact directory extract worker 失败：{error}"))?;
    if let Err(error) = result {
        let _ = tokio::fs::remove_dir_all(destination).await;
        return Err(error);
    }
    Ok(())
}

async fn normalize_directory_archive(
    input: &Path,
    spool: &Path,
) -> Result<StagedArtifact, TargetExecutionError> {
    let tree = spool.with_extension("normalize-tree");
    let _ = tokio::fs::remove_dir_all(&tree).await;
    tokio::fs::create_dir(&tree).await?;
    let input = input.to_path_buf();
    let tree_for_extract = tree.clone();
    let extracted =
        tokio::task::spawn_blocking(move || extract_directory_archive(&input, &tree_for_extract))
            .await
            .map_err(|error| format!("Artifact directory normalize worker 失败：{error}"))?;
    if let Err(error) = extracted {
        let _ = tokio::fs::remove_dir_all(&tree).await;
        return Err(error);
    }
    let result = create_canonical_directory_archive(&tree, spool).await;
    let _ = tokio::fs::remove_dir_all(&tree).await;
    result
}

fn build_canonical_directory_archive(
    source: &Path,
    destination: &Path,
) -> Result<(), TargetExecutionError> {
    let mut entries = walkdir::WalkDir::new(source)
        .follow_links(false)
        .min_depth(1)
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?;
    entries.sort_by(|left, right| left.path().cmp(right.path()));
    let output = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)?;
    let mut archive = tar::Builder::new(output);
    archive.mode(tar::HeaderMode::Deterministic);
    for entry in entries {
        let relative = entry.path().strip_prefix(source)?;
        validate_archive_relative_path(relative)?;
        let metadata = std::fs::symlink_metadata(entry.path())?;
        let mut header = tar::Header::new_gnu();
        header.set_path(relative)?;
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        if metadata.is_dir() {
            header.set_entry_type(tar::EntryType::Directory);
            header.set_mode(0o755);
            header.set_size(0);
            header.set_cksum();
            archive.append(&header, std::io::empty())?;
        } else if metadata.is_file() {
            header.set_entry_type(tar::EntryType::Regular);
            header.set_mode(canonical_file_mode(&metadata));
            header.set_size(metadata.len());
            header.set_cksum();
            let mut file = std::fs::File::open(entry.path())?;
            archive.append(&header, &mut file)?;
        } else if metadata.file_type().is_symlink() {
            let target = std::fs::read_link(entry.path())?;
            validate_archive_link_target(&target)?;
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_mode(0o777);
            header.set_size(0);
            header.set_link_name(target)?;
            header.set_cksum();
            archive.append(&header, std::io::empty())?;
        } else {
            return Err(format!(
                "Artifact directory 包含不支持的文件类型：'{}'",
                entry.path().display()
            )
            .into());
        }
    }
    archive.finish()?;
    let output = archive.into_inner()?;
    output.sync_all()?;
    Ok(())
}

fn extract_directory_archive(
    source: &Path,
    destination: &Path,
) -> Result<(), TargetExecutionError> {
    let file = std::fs::File::open(source)?;
    let mut archive = tar::Archive::new(file);
    archive.set_preserve_permissions(true);
    archive.set_preserve_mtime(false);
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        validate_archive_relative_path(&path)?;
        let kind = entry.header().entry_type();
        if !(kind.is_file() || kind.is_dir() || kind.is_symlink()) {
            return Err(format!(
                "Artifact directory archive 包含不支持的条目：'{}'",
                path.display()
            )
            .into());
        }
        if kind.is_symlink() {
            let target = entry
                .link_name()?
                .ok_or("Artifact directory symlink 缺少 target")?;
            validate_archive_link_target(&target)?;
        }
        if !entry.unpack_in(destination)? {
            return Err(
                format!("Artifact directory archive 条目越界：'{}'", path.display()).into(),
            );
        }
    }
    Ok(())
}

fn validate_archive_relative_path(path: &Path) -> Result<(), TargetExecutionError> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!(
            "Artifact directory archive 路径不安全：'{}'",
            path.display()
        )
        .into());
    }
    Ok(())
}

fn validate_archive_link_target(path: &Path) -> Result<(), TargetExecutionError> {
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!(
            "Artifact directory symlink target 不安全：'{}'",
            path.display()
        )
        .into());
    }
    Ok(())
}

#[cfg(unix)]
fn canonical_file_mode(metadata: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    if metadata.permissions().mode() & 0o111 != 0 {
        0o755
    } else {
        0o644
    }
}

#[cfg(not(unix))]
fn canonical_file_mode(_metadata: &std::fs::Metadata) -> u32 {
    0o644
}

async fn hash_file(path: &std::path::Path) -> Result<(u64, String), TargetExecutionError> {
    let mut reader = tokio::fs::File::open(path).await?;
    let mut sink = tokio::io::sink();
    copy_and_hash(&mut reader, &mut sink, None, None).await
}

async fn copy_and_hash<R, W>(
    reader: &mut R,
    writer: &mut W,
    progress_phase: Option<&str>,
    total_bytes: Option<u64>,
) -> Result<(u64, String), TargetExecutionError>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut hasher = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = vec![0_u8; 128 * 1024];
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        writer.write_all(&buffer[..count]).await?;
        hasher.update(&buffer[..count]);
        size = size.saturating_add(count as u64);
        if let Some(phase) = progress_phase {
            crate::artifact::report_artifact_bytes(phase, size, total_bytes);
        }
    }
    Ok((size, format!("sha256:{:x}", hasher.finalize())))
}

async fn publish_spooled_local_artifact(
    request: &crate::artifact::ArtifactTransferRequest,
    spool: &std::path::Path,
    destination: &std::path::Path,
    kind: StagedArtifactKind,
) -> Result<(), TargetExecutionError> {
    match kind {
        StagedArtifactKind::File => publish_spooled_local_file(request, spool, destination).await,
        StagedArtifactKind::DirectoryArchive => {
            publish_spooled_local_directory(request, spool, destination).await
        }
    }
}

async fn publish_spooled_local_file(
    request: &crate::artifact::ArtifactTransferRequest,
    spool: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), TargetExecutionError> {
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or("Artifact destination 缺少父目录")?;
    if !tokio::fs::metadata(parent).await?.is_dir() {
        return Err(format!(
            "Artifact destination 父路径 '{}' 不是目录",
            parent.display()
        )
        .into());
    }
    if request.overwrite == crate::artifact::ArtifactOverwritePolicy::Deny
        && tokio::fs::try_exists(destination).await?
    {
        let (_, staged_digest) = hash_file(spool).await?;
        let (_, destination_digest) = hash_file(destination).await?;
        return if staged_digest == destination_digest {
            Ok(())
        } else {
            Err(format!(
                "Artifact destination '{}' 已存在且内容不同",
                destination.display()
            )
            .into())
        };
    }
    let temporary = parent.join(format!(
        ".morphz-transfer-{}-{}.part",
        sanitize_transfer_id(&request.transfer_id),
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    tokio::fs::copy(spool, &temporary).await?;
    let mut cleanup = LocalTransferStagingGuard::new(temporary.clone());
    crate::artifact::mark_artifact_transfer_side_effect().await?;
    match request.overwrite {
        crate::artifact::ArtifactOverwritePolicy::Deny => {
            tokio::fs::hard_link(&temporary, destination).await?;
            tokio::fs::remove_file(&temporary).await?;
        }
        crate::artifact::ArtifactOverwritePolicy::Replace => {
            if cfg!(windows) && tokio::fs::try_exists(destination).await? {
                tokio::fs::remove_file(destination).await?;
            }
            tokio::fs::rename(&temporary, destination).await?;
        }
    }
    cleanup.disarm();
    Ok(())
}

async fn publish_spooled_local_directory(
    request: &crate::artifact::ArtifactTransferRequest,
    spool: &Path,
    destination: &Path,
) -> Result<(), TargetExecutionError> {
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or("Artifact directory destination 缺少父目录")?;
    tokio::fs::create_dir_all(parent).await?;
    if !tokio::fs::metadata(parent).await?.is_dir() {
        return Err(format!(
            "Artifact destination 父路径 '{}' 不是目录",
            parent.display()
        )
        .into());
    }
    if request.overwrite == crate::artifact::ArtifactOverwritePolicy::Deny
        && tokio::fs::try_exists(destination).await?
    {
        if !tokio::fs::metadata(destination).await?.is_dir() {
            return Err(format!(
                "Artifact destination '{}' 已存在且不是目录",
                destination.display()
            )
            .into());
        }
        let (_, expected) = hash_file(spool).await?;
        let actual = canonical_directory_digest(destination).await?;
        return if actual == expected {
            Ok(())
        } else {
            Err(format!(
                "Artifact directory destination '{}' 已存在且内容不同",
                destination.display()
            )
            .into())
        };
    }

    let temporary = parent.join(format!(
        ".morphz-transfer-{}-{}.tree",
        sanitize_transfer_id(&request.transfer_id),
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    tokio::fs::create_dir(&temporary).await?;
    let mut cleanup = LocalTransferStagingGuard::directory(temporary.clone());
    let archive = spool.to_path_buf();
    let tree = temporary.clone();
    tokio::task::spawn_blocking(move || extract_directory_archive(&archive, &tree))
        .await
        .map_err(|error| format!("Artifact directory extract worker 失败：{error}"))??;
    crate::artifact::report_artifact_bytes("publishing_directory", 1, Some(1));

    crate::artifact::mark_artifact_transfer_side_effect().await?;
    match request.overwrite {
        crate::artifact::ArtifactOverwritePolicy::Deny => {
            tokio::fs::rename(&temporary, destination).await?;
        }
        crate::artifact::ArtifactOverwritePolicy::Replace => {
            if tokio::fs::try_exists(destination).await? {
                let backup = parent.join(format!(
                    ".morphz-transfer-{}-{}.backup",
                    sanitize_transfer_id(&request.transfer_id),
                    Utc::now().timestamp_nanos_opt().unwrap_or_default()
                ));
                tokio::fs::rename(destination, &backup).await?;
                match tokio::fs::rename(&temporary, destination).await {
                    Ok(()) => tokio::fs::remove_dir_all(backup).await?,
                    Err(error) => {
                        let _ = tokio::fs::rename(&backup, destination).await;
                        return Err(error.into());
                    }
                }
            } else {
                tokio::fs::rename(&temporary, destination).await?;
            }
        }
    }
    cleanup.disarm();
    Ok(())
}

async fn canonical_directory_digest(path: &Path) -> Result<String, TargetExecutionError> {
    let parent = path.parent().ok_or("Artifact directory 缺少父目录")?;
    let archive = parent.join(format!(
        ".morphz-directory-digest-{}.tar",
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    let source = path.to_path_buf();
    let output = archive.clone();
    tokio::task::spawn_blocking(move || build_canonical_directory_archive(&source, &output))
        .await
        .map_err(|error| format!("Artifact directory digest worker 失败：{error}"))??;
    let result = hash_file(&archive).await.map(|(_, digest)| digest);
    let _ = tokio::fs::remove_file(archive).await;
    result
}

struct LocalTransferStagingGuard {
    path: PathBuf,
    directory: bool,
    armed: bool,
}

impl LocalTransferStagingGuard {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            directory: false,
            armed: true,
        }
    }

    fn directory(path: PathBuf) -> Self {
        Self {
            path,
            directory: true,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for LocalTransferStagingGuard {
    fn drop(&mut self) {
        if self.armed {
            if self.directory {
                let _ = std::fs::remove_dir_all(&self.path);
            } else {
                let _ = std::fs::remove_file(&self.path);
            }
        }
    }
}

async fn upload_managed_ssh_artifact(
    endpoint: &ManagedSshEndpoint,
    spool: &std::path::Path,
    remote_path: &str,
    overwrite: crate::artifact::ArtifactOverwritePolicy,
    transfer_id: &str,
    expected_payload_digest: &str,
    logical_digest: &str,
    kind: StagedArtifactKind,
) -> Result<(), TargetExecutionError> {
    validate_remote_artifact_path(remote_path)?;
    let (parent, name) = remote_parent_and_name(remote_path)?;
    let digest_marker = format!("{parent}/.{name}.morphz-artifact-digest");
    if overwrite == crate::artifact::ArtifactOverwritePolicy::Deny {
        let probe = match kind {
            StagedArtifactKind::File => format!(
                "if test -f {path}; then if command -v sha256sum >/dev/null 2>&1; then sha256sum -- {path}; else shasum -a 256 -- {path}; fi; elif test -e {path}; then printf wrong-type; fi",
                path = shell_quote_remote_path(remote_path)
            ),
            StagedArtifactKind::DirectoryArchive => format!(
                "if test -d {path}; then if test -f {marker}; then cat -- {marker}; else printf unknown-directory; fi; elif test -e {path}; then printf wrong-type; fi",
                path = shell_quote_remote_path(remote_path),
                marker = shell_quote_remote_path(&digest_marker)
            ),
        };
        let output = run_managed_ssh_output(endpoint, &probe).await?;
        if !output.status.success() {
            return Err(format!(
                "Managed SSH 检查 destination '{}' 失败：{}",
                remote_path,
                String::from_utf8_lossy(&output.stderr).trim()
            )
            .into());
        }
        if let Some(value) = String::from_utf8(output.stdout)?.split_whitespace().next() {
            let actual = if kind == StagedArtifactKind::File {
                format!("sha256:{}", value.to_ascii_lowercase())
            } else {
                value.to_string()
            };
            return if actual == logical_digest {
                Ok(())
            } else {
                Err(format!("Managed SSH destination '{}' 已存在且内容不同", remote_path).into())
            };
        }
    }
    let temporary = format!(
        "{parent}/.morphz-transfer-{}-{}.part",
        sanitize_transfer_id(transfer_id),
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    );
    let upload = format!(
        "set -eu; test -d {parent}; umask 077; trap 'rm -f -- {tmp}' EXIT HUP INT TERM; cat > {tmp}; trap - EXIT HUP INT TERM",
        parent = shell_quote_remote_path(parent),
        tmp = shell_quote_remote_path(&temporary),
    );
    let mut command = managed_ssh_command(endpoint, &upload)?;
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let mut stdin = child.stdin.take().ok_or("SSH upload 缺少 stdin")?;
    let mut reader = tokio::fs::File::open(spool).await?;
    let total_bytes = tokio::fs::metadata(spool).await?.len();
    crate::artifact::report_artifact_bytes("uploading", 0, Some(total_bytes));
    let mut sent = 0_u64;
    let mut buffer = vec![0_u8; 128 * 1024];
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        stdin.write_all(&buffer[..count]).await?;
        sent = sent.saturating_add(count as u64);
        crate::artifact::report_artifact_bytes("uploading", sent, Some(total_bytes));
    }
    stdin.shutdown().await?;
    drop(stdin);
    let output = child.wait_with_output().await?;
    if !output.status.success() {
        return Err(format!(
            "Managed SSH 写入临时 Artifact '{}' 失败：{}",
            remote_path,
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    let mut cleanup = RemoteTransferStagingGuard::new(endpoint.clone(), temporary.clone());
    let verified = remote_file_digest(endpoint, &temporary).await?;
    if verified != expected_payload_digest {
        return Err(format!(
            "Managed SSH destination digest 校验失败：期望 '{}'，实际 '{}'",
            expected_payload_digest, verified
        )
        .into());
    }
    let publish = match (kind, overwrite) {
        (StagedArtifactKind::File, crate::artifact::ArtifactOverwritePolicy::Deny) => format!(
            "set -eu; ln -- {tmp} {dest}; rm -f -- {tmp}",
            tmp = shell_quote_remote_path(&temporary),
            dest = shell_quote_remote_path(remote_path)
        ),
        (StagedArtifactKind::File, crate::artifact::ArtifactOverwritePolicy::Replace) => format!(
            "set -eu; mv -f -- {tmp} {dest}",
            tmp = shell_quote_remote_path(&temporary),
            dest = shell_quote_remote_path(remote_path)
        ),
        (StagedArtifactKind::DirectoryArchive, overwrite) => {
            let temporary_tree = format!("{temporary}.tree");
            let marker_partial = format!("{temporary}.digest");
            let backup = format!("{temporary}.backup");
            let prepublish = format!(
                "command -v tar >/dev/null 2>&1; rm -rf -- {tree} {backup}; mkdir -- {tree}; tar -xf {tmp} -C {tree}; printf '%s\\n' {digest} > {marker_partial}",
                tree = shell_quote_remote_path(&temporary_tree),
                backup = shell_quote_remote_path(&backup),
                tmp = shell_quote_remote_path(&temporary),
                digest = shell_quote(logical_digest),
                marker_partial = shell_quote_remote_path(&marker_partial),
            );
            match overwrite {
                crate::artifact::ArtifactOverwritePolicy::Deny => format!(
                    "set -eu; test ! -e {dest}; {prepublish}; trap 'rm -rf -- {tree} {backup}; rm -f -- {tmp} {marker_partial}; if test ! -d {dest}; then rm -f -- {marker}; fi' EXIT HUP INT TERM; mv -- {marker_partial} {marker}; mv -- {tree} {dest}; rm -f -- {tmp}; trap - EXIT HUP INT TERM",
                    dest = shell_quote_remote_path(remote_path),
                    tree = shell_quote_remote_path(&temporary_tree),
                    backup = shell_quote_remote_path(&backup),
                    tmp = shell_quote_remote_path(&temporary),
                    marker_partial = shell_quote_remote_path(&marker_partial),
                    marker = shell_quote_remote_path(&digest_marker),
                ),
                crate::artifact::ArtifactOverwritePolicy::Replace => format!(
                    "set -eu; {prepublish}; trap 'rm -rf -- {tree}; rm -f -- {tmp} {marker_partial}; if test -e {backup} && test ! -e {dest}; then mv -- {backup} {dest}; fi' EXIT HUP INT TERM; if test -e {dest}; then mv -- {dest} {backup}; fi; mv -- {marker_partial} {marker}; mv -- {tree} {dest}; rm -rf -- {backup}; rm -f -- {tmp}; trap - EXIT HUP INT TERM",
                    tree = shell_quote_remote_path(&temporary_tree),
                    tmp = shell_quote_remote_path(&temporary),
                    marker_partial = shell_quote_remote_path(&marker_partial),
                    backup = shell_quote_remote_path(&backup),
                    dest = shell_quote_remote_path(remote_path),
                    marker = shell_quote_remote_path(&digest_marker),
                ),
            }
        }
    };
    crate::artifact::mark_artifact_transfer_side_effect().await?;
    let output = run_managed_ssh_output(endpoint, &publish).await?;
    if !output.status.success() {
        return Err(format!(
            "Managed SSH 原子发布 '{}' 失败（父目录 '{}'，文件 '{}'）：{}",
            remote_path,
            parent,
            name,
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    cleanup.disarm();
    Ok(())
}

fn remote_parent_and_name(path: &str) -> Result<(&str, &str), TargetExecutionError> {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("远端 Artifact destination 不能是根目录".into());
    }
    match trimmed.rsplit_once('/') {
        Some(("", name)) if !name.is_empty() => Ok(("/", name)),
        Some((parent, name)) if !parent.is_empty() && !name.is_empty() => Ok((parent, name)),
        None => Ok((".", trimmed)),
        _ => Err("远端 Artifact destination 缺少有效文件名".into()),
    }
}

fn sanitize_transfer_id(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .take(96)
        .collect()
}

async fn remote_file_digest(
    endpoint: &ManagedSshEndpoint,
    path: &str,
) -> Result<String, TargetExecutionError> {
    let command = format!(
        "set -eu; if command -v sha256sum >/dev/null 2>&1; then sha256sum -- {path}; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 -- {path}; else exit 127; fi",
        path = shell_quote_remote_path(path)
    );
    let output = run_managed_ssh_output(endpoint, &command).await?;
    if !output.status.success() {
        return Err(format!(
            "Managed SSH 远端缺少可用 SHA-256 工具或摘要失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    let hex = String::from_utf8(output.stdout)?
        .split_whitespace()
        .next()
        .ok_or("Managed SSH SHA-256 输出为空")?
        .to_ascii_lowercase();
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Managed SSH SHA-256 输出格式无效".into());
    }
    Ok(format!("sha256:{hex}"))
}

async fn run_managed_ssh_output(
    endpoint: &ManagedSshEndpoint,
    remote_command: &str,
) -> Result<std::process::Output, TargetExecutionError> {
    let mut command = managed_ssh_command(endpoint, remote_command)?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    Ok(command.output().await?)
}

/// Small provider-side protocol for the core file tools. The program is sent
/// as an OpenSSH command while the model-authored arguments travel over stdin
/// as JSON, so paths and file contents never become shell syntax.
const MANAGED_SSH_FILE_TOOL_SCRIPT: &str = r#"
import fnmatch
import hashlib
import json
import os
import pathlib
import sys
import tempfile

def emit(ok, output=None, error=None):
    print(json.dumps({"ok": ok, "output": output, "error": error}, ensure_ascii=False))

def resolve_path(value, workspace_root):
    path = os.path.expanduser(value)
    if not os.path.isabs(path) and workspace_root:
        path = os.path.join(workspace_root, path)
    return os.path.abspath(path)

def path_matches(relative, pattern):
    relative = relative.replace(os.sep, "/")
    if pattern in ("*", "**/*"):
        return True
    pure = pathlib.PurePosixPath(relative)
    return pure.match(pattern) or fnmatch.fnmatch(relative, pattern) or (
        pattern.startswith("**/") and fnmatch.fnmatch(relative, pattern[3:])
    )

def read_tool(args, workspace_root):
    original = args["path"]
    path = resolve_path(original, workspace_root)
    if not os.path.exists(path):
        return "系统报错：读取失败。指定的文件路径 '{}' 不存在，请检查路径是否正确。".format(original)
    with open(path, "rb") as handle:
        data = handle.read()
    text = data.decode("utf-8")
    digest = hashlib.sha256(data).hexdigest()
    header = "[path={}, bytes={}, sha256={}]\n".format(original, len(data), digest)
    if args.get("query") is None and args.get("start_line") is None and args.get("end_line") is None:
        return header + text

    lines = text.splitlines()
    total = len(lines)
    start = args.get("start_line") or 1
    end = min(args.get("end_line") or total, total)
    if start == 0 or (total > 0 and start > total) or end < start:
        raise ValueError("无效行范围：start_line={}，end_line={}，文件共 {} 行".format(start, end, total))
    selected = set()
    query = args.get("query")
    match_count = 0
    shown_matches = 0
    if query is not None:
        query = query.strip()
        if not query:
            raise ValueError("query 不能为空字符串")
        needle = query.lower()
        context = min(args.get("context_lines", 3), 20)
        max_matches = min(max(args.get("max_matches", 20), 1), 100)
        for line_number in range(start, end + 1):
            if needle in lines[line_number - 1].lower():
                match_count += 1
                if shown_matches < max_matches:
                    shown_matches += 1
                    context_start = max(start, line_number - context)
                    context_end = min(end, line_number + context)
                    selected.update(range(context_start, context_end + 1))
        body = "[query={}, matches={}, shown={}, lines={}..{}, total-lines={}]\n".format(
            json.dumps(query, ensure_ascii=False), match_count, shown_matches, start, end, total
        )
    else:
        if total > 0:
            selected.update(range(start, end + 1))
        body = "[lines={}..{}, total-lines={}]\n".format(start, end, total)
    for line_number in sorted(selected):
        body += "{:>6} | {}\n".format(line_number, lines[line_number - 1])
    return header + body

def write_tool(args, workspace_root):
    original = args["path"]
    path = resolve_path(original, workspace_root)
    content = args["content"]
    data = content.encode("utf-8")
    mode = args["mode"]
    current_mode = None
    if mode == "create":
        if os.path.exists(path):
            raise ValueError("create 拒绝覆盖已存在文件 '{}'；请先 read，再使用 edit 或 overwrite".format(original))
        operation = "create"
    elif mode == "overwrite":
        if not os.path.exists(path):
            raise ValueError("overwrite 目标 '{}' 不存在；创建新文件请使用 mode=create".format(original))
        with open(path, "rb") as handle:
            before = handle.read()
        current = hashlib.sha256(before).hexdigest()
        expected = args.get("expected_sha256")
        if not expected:
            raise ValueError("overwrite 必须提供最近一次 read 返回的 expected_sha256")
        if expected != current:
            raise ValueError("文件版本冲突：'{}' 当前 sha256={}，expected_sha256={}。请重新 read 后再修改".format(original, current, expected))
        current_mode = os.stat(path).st_mode & 0o7777
        operation = "overwrite"
    else:
        raise ValueError("write.mode 只支持 create 或 overwrite，实际为 '{}'".format(mode))

    parent = os.path.dirname(path) or "."
    if not os.path.isdir(parent):
        raise ValueError("父目录 '{}' 不存在".format(parent))
    descriptor, temporary = tempfile.mkstemp(prefix=".morphz-write-", dir=parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        if current_mode is not None:
            os.chmod(temporary, current_mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    digest = hashlib.sha256(data).hexdigest()
    return "文件写入成功：operation={} path={} bytes={} sha256={}".format(operation, original, len(data), digest)

def edit_tool(args, workspace_root):
    original = args["path"]
    path = resolve_path(original, workspace_root)
    if not os.path.isfile(path):
        raise ValueError("edit 目标 '{}' 不存在或不是文件".format(original))
    with open(path, "rb") as handle:
        before = handle.read()
    digest = hashlib.sha256(before).hexdigest()
    expected = args.get("expected_sha256")
    if expected != digest:
        raise ValueError("文件版本冲突：'{}' 当前 sha256={}，expected_sha256={}。请重新 read 后再编辑".format(original, digest, expected))
    text = before.decode("utf-8")
    edits = args.get("edits") or []
    if not edits:
        raise ValueError("edit.edits 至少需要一项")
    replacements = []
    for index, edit in enumerate(edits):
        old = edit.get("old_text", "")
        new = edit.get("new_text", "")
        if not old:
            raise ValueError("edit.edits[{}].old_text 不能为空".format(index))
        starts = []
        cursor = 0
        while True:
            found = text.find(old, cursor)
            if found < 0:
                break
            starts.append(found)
            cursor = found + len(old)
        if not starts:
            raise ValueError("edit.edits[{}] 的 old_text 在 '{}' 中没有精确匹配；请重新 read 并扩大上下文".format(index, original))
        replace_all = bool(edit.get("replace_all", False))
        if not replace_all and len(starts) != 1:
            raise ValueError("edit.edits[{}] 的 old_text 匹配 {} 次；请扩大上下文，或设置 replace_all=true".format(index, len(starts)))
        for start in starts if replace_all else starts[:1]:
            replacements.append((start, start + len(old), new))
    replacements.sort(key=lambda item: item[0])
    for left, right in zip(replacements, replacements[1:]):
        if left[1] > right[0]:
            raise ValueError("edit 中的两个替换范围发生重叠；请合并为一个更大的精确替换")
    parts = []
    cursor = 0
    for start, end, new in replacements:
        parts.append(text[cursor:start])
        parts.append(new)
        cursor = end
    parts.append(text[cursor:])
    updated = "".join(parts)
    if updated == text:
        raise ValueError("edit 没有产生任何内容变化")
    data = updated.encode("utf-8")
    parent = os.path.dirname(path) or "."
    descriptor, temporary = tempfile.mkstemp(prefix=".morphz-edit-", dir=parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, os.stat(path).st_mode & 0o7777)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    after_digest = hashlib.sha256(data).hexdigest()
    return "文件编辑成功：path={} replacements={} bytes={} sha256={}".format(original, len(replacements), len(data), after_digest)

def list_files_tool(args, workspace_root):
    original = args.get("path", ".")
    root = resolve_path(original, workspace_root)
    if not os.path.isdir(root):
        raise ValueError("list_files.path '{}' 不是目录".format(original))
    pattern = args.get("glob", "**/*")
    limit = min(max(args.get("max_results", 500), 1), 2000)
    include_hidden = bool(args.get("include_hidden", False))
    include_directories = bool(args.get("include_directories", False))
    entries = []
    truncated = False
    for directory, directories, files in os.walk(root, followlinks=False):
        if not include_hidden:
            directories[:] = sorted(name for name in directories if not name.startswith("."))
            files = [name for name in files if not name.startswith(".")]
        else:
            directories.sort()
        candidates = []
        if include_directories:
            candidates.extend((os.path.join(directory, name), "dir") for name in directories)
        candidates.extend((os.path.join(directory, name), "file") for name in sorted(files))
        for path, kind in candidates:
            relative = os.path.relpath(path, root).replace(os.sep, "/")
            if not path_matches(relative, pattern):
                continue
            if len(entries) == limit:
                truncated = True
                break
            size = os.path.getsize(path) if kind == "file" else None
            entries.append({"path": relative, "kind": kind, "bytes": size})
        if truncated:
            break
    return json.dumps({"root": original, "glob": pattern, "count": len(entries), "truncated": truncated, "entries": entries}, ensure_ascii=False, indent=2)

def search_tool(args, workspace_root):
    query = args["query"].strip()
    if not query:
        raise ValueError("search.query 不能为空")
    inputs = args.get("paths") or []
    if not inputs:
        raise ValueError("search.paths 至少需要一个路径")
    pattern = args.get("glob", "**/*")
    limit = min(max(args.get("max_matches", 100), 1), 1000)
    context_lines = min(max(args.get("context_lines", 2), 0), 20)
    case_sensitive = bool(args.get("case_sensitive", False))
    include_hidden = bool(args.get("include_hidden", False))
    needle = query if case_sensitive else query.lower()
    matches = []
    truncated = False

    for original in inputs:
        root = resolve_path(original, workspace_root)
        if os.path.isfile(root):
            candidates = [(root, os.path.basename(root))]
        elif os.path.isdir(root):
            candidates = []
            for directory, directories, files in os.walk(root, followlinks=False):
                if not include_hidden:
                    directories[:] = sorted(name for name in directories if not name.startswith("."))
                    files = [name for name in files if not name.startswith(".")]
                else:
                    directories.sort()
                for name in sorted(files):
                    path = os.path.join(directory, name)
                    candidates.append((path, os.path.relpath(path, root)))
        else:
            raise ValueError("search 路径 '{}' 不存在".format(original))

        for path, relative in candidates:
            if not path_matches(relative, pattern):
                continue
            try:
                if os.path.getsize(path) > 2 * 1024 * 1024:
                    continue
                with open(path, "r", encoding="utf-8") as handle:
                    lines = handle.read().splitlines()
            except (OSError, UnicodeError):
                continue
            for index, line in enumerate(lines):
                haystack = line if case_sensitive else line.lower()
                if needle not in haystack:
                    continue
                if len(matches) == limit:
                    truncated = True
                    break
                number = index + 1
                start = max(1, number - context_lines)
                end = min(len(lines), number + context_lines)
                display_path = original if os.path.isfile(root) else original.rstrip("/") + "/" + relative.replace(os.sep, "/")
                matches.append({
                    "path": display_path,
                    "line": number,
                    "context": [{"line": row, "text": lines[row - 1]} for row in range(start, end + 1)],
                })
            if truncated:
                break
        if truncated:
            break
    return json.dumps({"query": args["query"], "count": len(matches), "truncated": truncated, "matches": matches}, ensure_ascii=False, indent=2)

try:
    request = json.load(sys.stdin)
    operation = request["operation"]
    arguments = request["arguments"]
    workspace_root = request.get("workspace_root")
    if operation == "read":
        result = read_tool(arguments, workspace_root)
    elif operation == "write":
        result = write_tool(arguments, workspace_root)
    elif operation == "edit":
        result = edit_tool(arguments, workspace_root)
    elif operation == "list_files":
        result = list_files_tool(arguments, workspace_root)
    elif operation == "search":
        result = search_tool(arguments, workspace_root)
    else:
        raise ValueError("不支持的 Managed SSH 核心工具 '{}'".format(operation))
    emit(True, output=result)
except Exception as error:
    emit(False, error="{}: {}".format(type(error).__name__, error))
"#;

async fn execute_managed_ssh_file_tool(
    endpoint: &ManagedSshEndpoint,
    workspace_root: Option<&str>,
    operation: &str,
    arguments: &str,
) -> Result<String, TargetExecutionError> {
    let arguments: serde_json::Value = serde_json::from_str(arguments)?;
    let request = serde_json::to_vec(&serde_json::json!({
        "operation": operation,
        "arguments": arguments,
        "workspace_root": workspace_root,
    }))?;
    let command = managed_ssh_file_tool_command();
    let output = run_managed_ssh_output_with_input(endpoint, &command, &request).await?;
    if !output.status.success() {
        return Err(format!(
            "Managed SSH 工具 '{}' 执行失败：{}",
            operation,
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    let envelope: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|error| {
        format!(
            "Managed SSH 工具 '{}' 返回无效协议：{error}；stdout={}；stderr={}",
            operation,
            String::from_utf8_lossy(&output.stdout).trim(),
            String::from_utf8_lossy(&output.stderr).trim()
        )
    })?;
    if envelope.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
        return Ok(envelope
            .get("output")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string());
    }
    Err(format!(
        "Managed SSH 工具 '{}' 被远端拒绝：{}",
        operation,
        envelope
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("未知错误")
    )
    .into())
}

fn managed_ssh_file_tool_command() -> String {
    let script = shell_quote(MANAGED_SSH_FILE_TOOL_SCRIPT);
    let bootstrap = format!(
        "if command -v python3 >/dev/null 2>&1; then exec python3 -c {script}; elif command -v python >/dev/null 2>&1; then exec python -c {script}; else echo 'Managed SSH Target 缺少 Python 3，不能执行核心文件工具' >&2; exit 127; fi"
    );
    // OpenSSH gives the remote command to the account's login shell.  The
    // account may use fish, csh, or another non-POSIX shell, while the
    // bootstrap above deliberately uses portable POSIX syntax.  Enter an
    // explicit sh before evaluating it instead of assuming the user's shell.
    format!("sh -lc {}", shell_quote(&bootstrap))
}

async fn run_managed_ssh_output_with_input(
    endpoint: &ManagedSshEndpoint,
    remote_command: &str,
    input: &[u8],
) -> Result<std::process::Output, TargetExecutionError> {
    let mut command = managed_ssh_command(endpoint, remote_command)?;
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let mut stdin = child.stdin.take().ok_or("无法打开 Managed SSH stdin")?;
    stdin.write_all(input).await?;
    stdin.shutdown().await?;
    drop(stdin);
    Ok(child.wait_with_output().await?)
}

struct RemoteTransferStagingGuard {
    endpoint: ManagedSshEndpoint,
    path: String,
    armed: bool,
}

impl RemoteTransferStagingGuard {
    fn new(endpoint: ManagedSshEndpoint, path: String) -> Self {
        Self {
            endpoint,
            path,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for RemoteTransferStagingGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let endpoint = self.endpoint.clone();
        let command = format!("rm -f -- {}", shell_quote_remote_path(&self.path));
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let _ = run_managed_ssh_output(&endpoint, &command).await;
            });
        }
    }
}

/// Backend-neutral authority used at the physical side-effect boundary.
/// Selection is deterministic by the Target's persisted kind; it never falls
/// back to another Target when the requested destination is unavailable.
pub struct ExecutionTargetDispatcher {
    targets: Arc<dyn ExecutionTargetStore>,
    authorizations: Arc<dyn ExecutionTargetAuthorizationStore>,
    backends: RwLock<HashMap<ExecutionTargetKind, Arc<dyn ExecutionTargetBackend>>>,
    artifact_transfer_backends: RwLock<HashMap<String, Arc<dyn ArtifactTransferExecutionBackend>>>,
}

impl ExecutionTargetDispatcher {
    pub fn new(
        targets: Arc<dyn ExecutionTargetStore>,
        authorizations: Arc<dyn ExecutionTargetAuthorizationStore>,
    ) -> Self {
        Self {
            targets,
            authorizations,
            backends: RwLock::new(HashMap::new()),
            artifact_transfer_backends: RwLock::new(HashMap::new()),
        }
    }

    pub fn register_backend(&self, backend: Arc<dyn ExecutionTargetBackend>) {
        self.backends
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(backend.kind(), backend);
    }

    pub fn register_artifact_transfer_backend(
        &self,
        backend: Arc<dyn ArtifactTransferExecutionBackend>,
    ) {
        self.artifact_transfer_backends
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(backend.name().to_string(), backend);
    }

    pub async fn execute(
        &self,
        job: &ExecutionJobRecord,
        tool: Arc<dyn Tool>,
        arguments: &str,
    ) -> Result<String, TargetExecutionError> {
        let route = route_snapshot_from_job(job)?;
        if tool.execution_routing() == ToolExecutionRouting::ArtifactTransfer {
            let routes = artifact_transfer_routes_from_job(job)?;
            let transfer = crate::artifact::transfer_request_from_tool_arguments(
                arguments,
                format!("transfer:{}", job.id),
            )?;
            if transfer.source.target_id != routes.source.target_id
                || transfer.destination.target_id != routes.destination.target_id
            {
                return Err("Artifact Transfer 参数与 Execution Job 冻结的双 Route 不一致".into());
            }
            let source = self
                .authorized_target_for_route(
                    &routes.source,
                    job.initiating_principal_id.as_deref(),
                    &job.agent_id,
                    &job.context_id,
                    &job.thread_id,
                )
                .await?;
            let destination = self
                .authorized_target_for_route(
                    &routes.destination,
                    job.initiating_principal_id.as_deref(),
                    &job.agent_id,
                    &job.context_id,
                    &job.thread_id,
                )
                .await?;
            if let Some(backend) = self.artifact_transfer_backend_for(&routes) {
                let receipt = backend.execute_transfer(job, &routes, &transfer).await?;
                receipt.validate_against(&transfer)?;
                return Ok(serde_json::to_string(&receipt)?);
            }
            if routes.source.target_id != routes.destination.target_id {
                return Err(format!(
                    "没有 Runtime Artifact Transport 能处理 '{}' 到 '{}' 的冻结 Route（{} -> {}）",
                    source.id,
                    destination.id,
                    routes.source.backend_kind.as_str(),
                    routes.destination.backend_kind.as_str()
                )
                .into());
            }
        }
        let mut target = self
            .targets
            .get_execution_target(&job.target_id)
            .await?
            .ok_or_else(|| format!("Execution Target '{}' 不存在", job.target_id))?;
        if target.status == ExecutionTargetStatus::Disabled {
            return Err(format!("Execution Target '{}' 已被禁用", target.id).into());
        }
        self.ensure_target_authorized(
            &target,
            job.initiating_principal_id.as_deref(),
            &job.agent_id,
            &job.context_id,
            &job.thread_id,
        )
        .await?;
        target.provider_node_id = route.provider_node_id;
        target.kind = route.backend_kind;
        target.policy_digest = route.policy_digest;
        let backend = self.backend_for(&target)?;
        backend
            .execute(
                &TargetExecutionContext {
                    target,
                    job: job.clone(),
                },
                tool,
                arguments,
            )
            .await
    }

    /// Node-local Artifact execution after the cloud's frozen dual Route has
    /// already been authenticated and localized by the Edge control plane.
    /// This deliberately skips the cloud Target registry: a Provider Node may
    /// own private Managed SSH endpoint descriptors which are not materialized
    /// as local Target rows. Backend permission checks still run normally.
    pub(crate) async fn execute_edge_artifact_transfer(
        &self,
        job: &ExecutionJobRecord,
        routes: &ArtifactTransferRouteSnapshot,
        request: &crate::artifact::ArtifactTransferRequest,
    ) -> Result<crate::artifact::ArtifactTransferReceipt, TargetExecutionError> {
        request.validate()?;
        if request.source.target_id != routes.source.target_id
            || request.destination.target_id != routes.destination.target_id
        {
            return Err("Edge-localized Artifact 请求与冻结双 Route 不一致".into());
        }
        let backend = self
            .artifact_transfer_backend_for(routes)
            .ok_or("Edge Runtime 没有可处理本地化双 Route 的 Artifact Backend")?;
        let receipt = backend.execute_transfer(job, routes, request).await?;
        receipt.validate_against(request)?;
        Ok(receipt)
    }

    pub async fn validate_for_tool(
        &self,
        target_id: &str,
        tool_name: &str,
        arguments: &str,
        principal_id: Option<&str>,
        agent_id: &str,
        context_id: &str,
        thread_id: &str,
    ) -> Result<ExecutionTargetRecord, TargetExecutionError> {
        let target = self
            .targets
            .get_execution_target(target_id)
            .await?
            .ok_or_else(|| format!("Execution Target '{target_id}' 不存在"))?;
        self.ensure_target_authorized(&target, principal_id, agent_id, context_id, thread_id)
            .await?;
        let durable_offline_queue = target.status == ExecutionTargetStatus::Offline
            && (target.kind == ExecutionTargetKind::EdgeNode
                || (target.kind == ExecutionTargetKind::ManagedSsh
                    && target.provider_node_id.is_some()));
        if !target.status.accepts_jobs() && !durable_offline_queue {
            return Err(format!(
                "Execution Target '{}' 当前为 {}，不能执行新动作",
                target.id,
                target.status.as_str()
            )
            .into());
        }
        if !target.capabilities.iter().any(|name| name == tool_name) {
            return Err(format!(
                "Execution Target '{}' 未发布工具能力 '{}'",
                target.id, tool_name
            )
            .into());
        }
        if target.kind == ExecutionTargetKind::InProcessLocal {
            reject_unmanaged_ssh_invocation(&target.id, tool_name, arguments)?;
        }
        self.backend_for(&target)?;
        Ok(target)
    }

    pub async fn validate_artifact_transfer(
        &self,
        request: &crate::artifact::ArtifactTransferRequest,
        arguments: &str,
        principal_id: Option<&str>,
        agent_id: &str,
        context_id: &str,
        thread_id: &str,
    ) -> Result<(ExecutionTargetRecord, ExecutionTargetRecord), TargetExecutionError> {
        request.validate()?;
        let source = self
            .validate_for_tool(
                &request.source.target_id,
                crate::artifact::ARTIFACT_TRANSFER_TOOL_NAME,
                arguments,
                principal_id,
                agent_id,
                context_id,
                thread_id,
            )
            .await?;
        let destination = if request.destination.target_id == request.source.target_id {
            source.clone()
        } else {
            self.validate_for_tool(
                &request.destination.target_id,
                crate::artifact::ARTIFACT_TRANSFER_TOOL_NAME,
                arguments,
                principal_id,
                agent_id,
                context_id,
                thread_id,
            )
            .await?
        };
        Ok((source, destination))
    }

    async fn ensure_target_authorized(
        &self,
        target: &ExecutionTargetRecord,
        principal_id: Option<&str>,
        agent_id: &str,
        context_id: &str,
        thread_id: &str,
    ) -> Result<(), TargetExecutionError> {
        ensure_target_authorized_for_principal(target, principal_id)?;
        let Some(owner) = target.owner_principal_id.as_deref() else {
            return Ok(());
        };
        if !self
            .authorizations
            .has_execution_target_authorization_history(&target.id)
            .await?
        {
            return Ok(());
        }
        let grants = self
            .authorizations
            .list_execution_target_authorizations(ExecutionTargetAuthorizationFilter {
                target_id: Some(target.id.clone()),
                owner_principal_id: Some(owner.to_string()),
                active_only: true,
                limit: Some(1_000),
                ..Default::default()
            })
            .await?;
        let matches = grants.iter().any(|grant| {
            grant.status == ExecutionTargetAuthorizationStatus::Active
                && match grant.scope {
                    ExecutionTargetAuthorizationScope::Agent => grant.scope_id == agent_id,
                    ExecutionTargetAuthorizationScope::Context => grant.scope_id == context_id,
                    ExecutionTargetAuthorizationScope::Thread => grant.scope_id == thread_id,
                }
        });
        if !matches {
            return Err(format!(
                "Execution Target '{}' 已进入 scoped authorization 模式，但当前 Agent/Context/Thread 没有有效授权",
                target.id
            )
            .into());
        }
        Ok(())
    }

    async fn authorized_target_for_route(
        &self,
        route: &ExecutionRouteSnapshot,
        principal_id: Option<&str>,
        agent_id: &str,
        context_id: &str,
        thread_id: &str,
    ) -> Result<ExecutionTargetRecord, TargetExecutionError> {
        let mut target = self
            .targets
            .get_execution_target(&route.target_id)
            .await?
            .ok_or_else(|| format!("Execution Target '{}' 不存在", route.target_id))?;
        if target.status == ExecutionTargetStatus::Disabled {
            return Err(format!("Execution Target '{}' 已被禁用", target.id).into());
        }
        self.ensure_target_authorized(&target, principal_id, agent_id, context_id, thread_id)
            .await?;
        target.provider_node_id = route.provider_node_id.clone();
        target.kind = route.backend_kind;
        target.policy_digest = route.policy_digest.clone();
        Ok(target)
    }

    fn artifact_transfer_backend_for(
        &self,
        routes: &ArtifactTransferRouteSnapshot,
    ) -> Option<Arc<dyn ArtifactTransferExecutionBackend>> {
        let backends = self
            .artifact_transfer_backends
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut names = backends.keys().cloned().collect::<Vec<_>>();
        names.sort();
        names.into_iter().find_map(|name| {
            backends
                .get(&name)
                .filter(|backend| backend.supports(&routes.source, &routes.destination))
                .cloned()
        })
    }

    fn backend_for(
        &self,
        target: &ExecutionTargetRecord,
    ) -> Result<Arc<dyn ExecutionTargetBackend>, TargetExecutionError> {
        let backend = self
            .backends
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&target.kind)
            .cloned()
            .ok_or_else(|| {
                format!(
                    "Execution Target '{}' 的 Backend '{}' 未注册",
                    target.id,
                    target.kind.as_str()
                )
            })?;
        Ok(backend)
    }
}

fn exec_arguments_invoke_ssh(arguments: &str) -> Result<bool, TargetExecutionError> {
    let value: serde_json::Value = serde_json::from_str(arguments)?;
    let command = value
        .as_object()
        .and_then(|object| object.get("command"))
        .and_then(serde_json::Value::as_str)
        .ok_or("exec 参数缺少 command")?;
    Ok(shell_command_programs(command).iter().any(|program| {
        PathBuf::from(program)
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| matches!(name, "ssh" | "scp" | "sftp"))
    }))
}

pub fn reject_unmanaged_ssh_invocation(
    target_id: &str,
    tool_name: &str,
    arguments: &str,
) -> Result<(), TargetExecutionError> {
    if target_id == DEFAULT_EXECUTION_TARGET_ID
        && tool_name == "exec"
        && exec_arguments_invoke_ssh(arguments)?
    {
        return Err(
            "Agent 禁止通过本地 exec 直接调用 ssh/scp/sftp；请先选择 managed_ssh Execution Target"
                .into(),
        );
    }
    Ok(())
}

fn shell_command_programs(command: &str) -> Vec<String> {
    let mut programs = Vec::new();
    let mut token = String::new();
    let mut quote = None;
    let mut escaped = false;
    let mut command_position = true;
    let mut wrapper = false;
    let finish_token = |token: &mut String,
                        programs: &mut Vec<String>,
                        command_position: &mut bool,
                        wrapper: &mut bool| {
        if token.is_empty() {
            return;
        }
        if *command_position {
            let value = std::mem::take(token);
            let assignment = value
                .split_once('=')
                .is_some_and(|(name, _)| !name.is_empty() && !name.contains('/'));
            let wrapper_word = matches!(
                value.as_str(),
                "command"
                    | "exec"
                    | "env"
                    | "sudo"
                    | "nohup"
                    | "time"
                    | "if"
                    | "then"
                    | "do"
                    | "while"
                    | "until"
                    | "!"
            );
            if assignment || wrapper_word || (*wrapper && value.starts_with('-')) {
                *wrapper = wrapper_word || *wrapper;
                return;
            }
            programs.push(value);
            *command_position = false;
            *wrapper = false;
        } else {
            token.clear();
        }
    };

    for character in command.chars() {
        if escaped {
            token.push(character);
            escaped = false;
            continue;
        }
        match quote {
            Some('\'') => {
                if character == '\'' {
                    quote = None;
                } else {
                    token.push(character);
                }
            }
            Some('"') => {
                if character == '"' {
                    quote = None;
                } else if character == '\\' {
                    escaped = true;
                } else {
                    token.push(character);
                }
            }
            Some(_) => unreachable!(),
            None => match character {
                '\\' => escaped = true,
                '\'' | '"' => quote = Some(character),
                ';' | '|' | '&' | '(' | ')' | '\n' => {
                    finish_token(
                        &mut token,
                        &mut programs,
                        &mut command_position,
                        &mut wrapper,
                    );
                    command_position = true;
                    wrapper = false;
                }
                value if value.is_whitespace() => {
                    finish_token(
                        &mut token,
                        &mut programs,
                        &mut command_position,
                        &mut wrapper,
                    );
                }
                _ => token.push(character),
            },
        }
    }
    finish_token(
        &mut token,
        &mut programs,
        &mut command_position,
        &mut wrapper,
    );
    programs
}

fn ensure_target_authorized_for_principal(
    target: &ExecutionTargetRecord,
    principal_id: Option<&str>,
) -> Result<(), TargetExecutionError> {
    if let Some(owner) = target.owner_principal_id.as_deref() {
        if Some(owner) != principal_id {
            return Err(format!("当前 Principal 无权使用 Execution Target '{}'", target.id).into());
        }
    }
    Ok(())
}

/// Builds the authoritative descriptor for the in-process local execution
/// environment. The caller supplies capability and policy projections so the
/// registry never needs to inspect tool or sandbox implementations directly.
pub fn local_default_registration(
    workspace_root: Option<String>,
    capabilities: Vec<String>,
    policy_digest: String,
) -> ExecutionTargetRegistration {
    ExecutionTargetRegistration {
        id: DEFAULT_EXECUTION_TARGET_ID.to_string(),
        owner_principal_id: None,
        provider_node_id: None,
        kind: ExecutionTargetKind::InProcessLocal,
        name: "Default local execution environment".to_string(),
        status: ExecutionTargetStatus::Online,
        platform: Some(format!(
            "{}-{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        )),
        workspace_root,
        capabilities,
        metadata: serde_json::json!({
            "backend": "in_process_local",
            "protocol_version": 1
        }),
        policy_digest,
        last_seen_at: Some(Utc::now()),
    }
}

pub fn runtime_managed_ssh_registration(
    config: &ManagedSshTargetConfig,
    endpoint: &ManagedSshEndpoint,
    default_owner_principal_id: &str,
    permission_policy_digest: &str,
) -> Result<ExecutionTargetRegistration, TargetExecutionError> {
    let id = config.id.trim();
    if id.is_empty() || id == DEFAULT_EXECUTION_TARGET_ID {
        return Err("Runtime Managed SSH Target id 不能为空且不能使用 'target-default'".into());
    }
    let name = config.name.trim();
    if name.is_empty() {
        return Err(format!("Runtime Managed SSH Target '{id}' 的 name 不能为空").into());
    }
    validate_endpoint_ref(config.endpoint_ref.trim())?;
    endpoint.validate()?;
    if !endpoint.approved {
        return Err(format!(
            "Runtime Managed SSH Target '{}' 的 endpoint '{}' 尚未明确批准",
            id, config.endpoint_ref
        )
        .into());
    }
    let owner_principal_id = config
        .owner_principal_id
        .as_deref()
        .unwrap_or(default_owner_principal_id)
        .trim();
    if owner_principal_id.is_empty() {
        return Err(
            format!("Runtime Managed SSH Target '{id}' 的 owner_principal_id 不能为空").into(),
        );
    }
    if config
        .platform
        .as_deref()
        .is_some_and(|value| value.trim().is_empty())
    {
        return Err(format!("Runtime Managed SSH Target '{id}' 的 platform 不能为空").into());
    }
    if config
        .workspace_root
        .as_deref()
        .is_some_and(|value| value.trim().is_empty())
    {
        return Err(format!("Runtime Managed SSH Target '{id}' 的 workspace_root 不能为空").into());
    }

    let mut digest = Sha256::new();
    digest.update(b"morphz.runtime-managed-ssh-policy.v1\0");
    digest.update(permission_policy_digest.as_bytes());
    digest.update(b"\0");
    digest.update(id.as_bytes());
    digest.update(b"\0");
    digest.update(config.endpoint_ref.as_bytes());
    digest.update(b"\0");
    digest.update(endpoint.host.as_bytes());
    digest.update(b"\0");
    digest.update(endpoint.user.as_deref().unwrap_or_default().as_bytes());
    digest.update(endpoint.port.to_be_bytes());
    digest.update(endpoint.known_hosts_file.to_string_lossy().as_bytes());
    if endpoint.known_hosts_file.is_file() {
        digest.update(std::fs::read(&endpoint.known_hosts_file)?);
    }
    if let Some(config_digest) = endpoint.config_digest.as_deref() {
        digest.update(config_digest.as_bytes());
    }

    Ok(ExecutionTargetRegistration {
        id: id.to_string(),
        owner_principal_id: Some(owner_principal_id.to_string()),
        provider_node_id: None,
        kind: ExecutionTargetKind::ManagedSsh,
        name: name.to_string(),
        status: ExecutionTargetStatus::Online,
        platform: config.platform.clone(),
        workspace_root: config.workspace_root.clone(),
        capabilities: vec![
            "exec".to_string(),
            "read".to_string(),
            "write".to_string(),
            "edit".to_string(),
            "list_files".to_string(),
            "search".to_string(),
            crate::artifact::ARTIFACT_TRANSFER_TOOL_NAME.to_string(),
        ],
        metadata: serde_json::json!({
            "backend": "managed_ssh",
            "execution_location": "runtime",
            "endpoint_ref": config.endpoint_ref,
            "host": endpoint.destination,
            "user": endpoint.destination.as_ref().and(endpoint.user.as_ref()),
            "port": endpoint.destination.as_ref().map(|_| endpoint.port),
            "protocol_version": 1
        }),
        policy_digest: format!("sha256:{:x}", digest.finalize()),
        last_seen_at: Some(Utc::now()),
    })
}

fn target_visible_to_active_principal(target: &ExecutionTargetRecord) -> bool {
    let principal = CURRENT_PRINCIPAL_ID.try_with(Clone::clone).ok().flatten();
    target.owner_principal_id.is_none() || target.owner_principal_id == principal
}

pub struct ListTargetsTool {
    targets: Arc<dyn ExecutionTargetStore>,
}

impl ListTargetsTool {
    pub fn new(targets: Arc<dyn ExecutionTargetStore>) -> Self {
        Self { targets }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListTargetsArgs {
    status: Option<ExecutionTargetStatus>,
    limit: Option<usize>,
}

#[async_trait::async_trait]
impl Tool for ListTargetsTool {
    fn name(&self) -> &str {
        "list_targets"
    }

    fn execution_class(&self) -> ToolExecutionClass {
        ToolExecutionClass::LogicalInline
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().to_string(),
            description: "List a compact index of Execution Targets available to the current identity. Use the stable IDs returned here in physical-tool target parameters. Runtime-managed SSH dials per command and holds no persistent SSH lease: offline may mean only that the current Runtime route needs rehydration, not that the remote host is physically offline. Follow recommended_action and call resolve_target to restore it.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "status": {"type": "string", "enum": ["online", "offline", "disabled"]},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100}
                },
                "additionalProperties": false
            }),
        }
    }

    async fn execute(&self, arguments: &str) -> Result<String, TargetExecutionError> {
        let args: ListTargetsArgs = serde_json::from_str(arguments)?;
        let targets = self
            .targets
            .list_execution_targets(ExecutionTargetFilter {
                status: args.status,
                limit: Some(args.limit.unwrap_or(32).min(100)),
                ..Default::default()
            })
            .await?
            .into_iter()
            .filter(target_visible_to_active_principal)
            .map(|target| {
                let runtime_availability = target_runtime_availability(&target);
                serde_json::json!({
                    "target_id": target.id,
                    "name": target.name,
                    "kind": target.kind,
                    "status": target.status,
                    "platform": target.platform,
                    "capabilities": target.capabilities,
                    "provider_node_id": target.provider_node_id,
                    "workspace_root": target.workspace_root,
                    "runtime_availability": runtime_availability,
                })
            })
            .collect::<Vec<_>>();
        Ok(serde_json::json!({
            "default_target_id": DEFAULT_EXECUTION_TARGET_ID,
            "targets": targets
        })
        .to_string())
    }
}

pub struct InspectTargetTool {
    targets: Arc<dyn ExecutionTargetStore>,
}

pub struct ResolveTargetTool {
    targets: Arc<dyn ExecutionTargetStore>,
    runtime_managed_ssh: Option<RuntimeManagedSshProvisioner>,
}

#[derive(Clone)]
pub struct RuntimeManagedSshProvisioner {
    targets: Arc<dyn ExecutionTargetStore>,
    endpoints: Arc<RwLock<HashMap<String, ManagedSshEndpoint>>>,
    default_principal_id: String,
    permission_policy_digest: String,
}

impl RuntimeManagedSshProvisioner {
    pub fn new(
        targets: Arc<dyn ExecutionTargetStore>,
        endpoints: Arc<RwLock<HashMap<String, ManagedSshEndpoint>>>,
        default_principal_id: String,
        permission_policy_digest: String,
    ) -> Self {
        Self {
            targets,
            endpoints,
            default_principal_id,
            permission_policy_digest,
        }
    }

    async fn provision(
        &self,
        host: &str,
        user: Option<&str>,
        port: Option<u16>,
        platform: Option<String>,
        workspace_root: Option<String>,
    ) -> Result<ExecutionTargetRecord, TargetExecutionError> {
        validate_ssh_host(host)?;
        let endpoint = resolve_runtime_ssh_host(host, user, port).await?;
        let principal_id = CURRENT_PRINCIPAL_ID
            .try_with(Clone::clone)
            .ok()
            .flatten()
            .unwrap_or_else(|| self.default_principal_id.clone());
        if principal_id.trim().is_empty() {
            return Err("按需创建 Managed SSH Target 时缺少当前 Principal".into());
        }
        let identity_material = format!(
            "{principal_id}\0{host}\0{}\0{}",
            endpoint.user.as_deref().unwrap_or_default(),
            endpoint.port
        );
        let identity_hash = format!("{:x}", Sha256::digest(identity_material.as_bytes()));
        let target_id = format!("target-ssh-{}", &identity_hash[..24]);
        let endpoint_ref = format!("runtime_ssh_{}", &identity_hash[..24]);
        let display_destination = endpoint
            .user
            .as_deref()
            .map(|user| format!("{user}@{host}:{}", endpoint.port))
            .unwrap_or_else(|| format!("{host}:{}", endpoint.port));
        let config = ManagedSshTargetConfig {
            id: target_id,
            name: format!("SSH {display_destination}"),
            endpoint_ref: endpoint_ref.clone(),
            owner_principal_id: Some(principal_id.clone()),
            platform,
            workspace_root,
        };
        let registration = runtime_managed_ssh_registration(
            &config,
            &endpoint,
            &principal_id,
            &self.permission_policy_digest,
        )?;
        let target = self.targets.register_execution_target(registration).await?;
        if target.status != ExecutionTargetStatus::Online {
            return Err(format!(
                "Managed SSH Target '{}' 已被管理员禁用；需要显式 enable 后才能使用",
                target.id
            )
            .into());
        }
        self.endpoints
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(endpoint_ref, endpoint);
        Ok(target)
    }

    /// Rebuilds the process-local OpenSSH route for a durable Runtime-managed
    /// target. Runtime-managed SSH has no persistent connection or heartbeat:
    /// an `offline` record after restart means the route has not been
    /// rehydrated, not that the remote machine was observed offline.
    pub async fn rehydrate(
        &self,
        target: &ExecutionTargetRecord,
    ) -> Result<ExecutionTargetRecord, TargetExecutionError> {
        if target.kind != ExecutionTargetKind::ManagedSsh
            || target.provider_node_id.is_some()
            || target
                .metadata
                .get("execution_location")
                .and_then(serde_json::Value::as_str)
                != Some("runtime")
        {
            return Err(format!(
                "Execution Target '{}' 不是 Runtime 托管的 SSH 路由",
                target.id
            )
            .into());
        }
        if target.status == ExecutionTargetStatus::Disabled {
            return Err(format!(
                "Managed SSH Target '{}' 已被管理员禁用；需要显式 enable 后才能使用",
                target.id
            )
            .into());
        }
        let host = target
            .metadata
            .get("host")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                format!(
                    "Runtime Managed SSH Target '{}' 缺少可恢复的 host 元数据",
                    target.id
                )
            })?;
        let user = target
            .metadata
            .get("user")
            .and_then(serde_json::Value::as_str);
        let port = target
            .metadata
            .get("port")
            .and_then(serde_json::Value::as_u64)
            .map(u16::try_from)
            .transpose()
            .map_err(|_| format!("Managed SSH Target '{}' 的 port 无效", target.id))?;
        let endpoint_ref = target
            .metadata
            .get("endpoint_ref")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                format!(
                    "Runtime Managed SSH Target '{}' 缺少 endpoint_ref 元数据",
                    target.id
                )
            })?;
        validate_endpoint_ref(endpoint_ref)?;
        let owner_principal_id = target.owner_principal_id.as_deref().ok_or_else(|| {
            format!(
                "Runtime Managed SSH Target '{}' 缺少 owner_principal_id",
                target.id
            )
        })?;
        let endpoint = resolve_runtime_ssh_host(host, user, port).await?;
        let config = ManagedSshTargetConfig {
            id: target.id.clone(),
            name: target.name.clone(),
            endpoint_ref: endpoint_ref.to_string(),
            owner_principal_id: Some(owner_principal_id.to_string()),
            platform: target.platform.clone(),
            workspace_root: target.workspace_root.clone(),
        };
        let registration = runtime_managed_ssh_registration(
            &config,
            &endpoint,
            owner_principal_id,
            &self.permission_policy_digest,
        )?;
        let target = self.targets.register_execution_target(registration).await?;
        if target.status != ExecutionTargetStatus::Online {
            return Err(format!(
                "Managed SSH Target '{}' 路由恢复后仍为 {}",
                target.id,
                target.status.as_str()
            )
            .into());
        }
        self.endpoints
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(endpoint_ref.to_string(), endpoint);
        Ok(target)
    }
}

fn target_runtime_availability(target: &ExecutionTargetRecord) -> serde_json::Value {
    if target.status == ExecutionTargetStatus::Disabled {
        return serde_json::json!({
            "availability": "disabled",
            "usable_now": false,
            "recoverable": false,
            "connection_model": if target.provider_node_id.is_some() {
                "provider_heartbeat"
            } else if target.kind == ExecutionTargetKind::ManagedSsh {
                "dial_on_demand"
            } else {
                "local"
            },
            "status_explanation": "Target 被显式禁用；这不是临时离线状态",
            "recommended_action": "仅管理员可以显式启用该 Target"
        });
    }
    if target.kind == ExecutionTargetKind::ManagedSsh && target.provider_node_id.is_none() {
        if target.status == ExecutionTargetStatus::Online {
            return serde_json::json!({
                "availability": "ready_on_demand",
                "usable_now": true,
                "recoverable": true,
                "connection_model": "dial_on_demand",
                "status_explanation": "Runtime 已配置 SSH 路由；SSH 连接只在执行命令时建立，不存在需要续租的常驻连接",
                "recommended_action": "可直接把 target_id 用于 exec；不要把没有常驻 SSH 连接解释为节点离线"
            });
        }
        return serde_json::json!({
            "availability": "route_needs_rehydration",
            "usable_now": false,
            "recoverable": true,
            "connection_model": "dial_on_demand",
            "status_explanation": "当前 Runtime 尚未重建此按需 SSH 路由；这不表示远端主机已被探测为离线",
            "recommended_action": "调用 resolve_target 并传入此 target_id 重新解析路由，然后继续执行"
        });
    }
    if target.provider_node_id.is_some() {
        if target.status == ExecutionTargetStatus::Online {
            return serde_json::json!({
                "availability": "provider_connected",
                "usable_now": true,
                "recoverable": true,
                "connection_model": "provider_heartbeat",
                "status_explanation": "提供此 Target 的 Edge Node 心跳正常",
                "recommended_action": "可直接执行"
            });
        }
        return serde_json::json!({
            "availability": "provider_temporarily_disconnected",
            "usable_now": false,
            "recoverable": true,
            "connection_model": "provider_heartbeat",
            "status_explanation": "提供此 Target 的 Edge Node 心跳暂时过期；Target 并未删除",
            "recommended_action": "可等待 Provider Node 恢复，或在允许时选择持久离线排队"
        });
    }
    serde_json::json!({
        "availability": if target.status == ExecutionTargetStatus::Online {
            "ready"
        } else {
            "unavailable"
        },
        "usable_now": target.status == ExecutionTargetStatus::Online,
        "recoverable": target.status != ExecutionTargetStatus::Disabled,
        "connection_model": "local",
        "status_explanation": if target.status == ExecutionTargetStatus::Online {
            "Target 当前可用"
        } else {
            "Target 当前不可用"
        },
        "recommended_action": if target.status == ExecutionTargetStatus::Online {
            "可直接执行"
        } else {
            "等待 Runtime 恢复 Target"
        }
    })
}

impl ResolveTargetTool {
    pub fn new(targets: Arc<dyn ExecutionTargetStore>) -> Self {
        Self {
            targets,
            runtime_managed_ssh: None,
        }
    }

    pub fn with_runtime_managed_ssh(mut self, provisioner: RuntimeManagedSshProvisioner) -> Self {
        self.runtime_managed_ssh = Some(provisioner);
        self
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResolveTargetArgs {
    target_id: Option<String>,
    #[serde(default)]
    capabilities: Vec<String>,
    platform: Option<String>,
    kind: Option<ExecutionTargetKind>,
    host: Option<String>,
    user: Option<String>,
    port: Option<u16>,
    workspace_root: Option<String>,
    #[serde(default)]
    allow_offline_queue: bool,
}

#[async_trait::async_trait]
impl Tool for ResolveTargetTool {
    fn name(&self) -> &str {
        "resolve_target"
    }

    fn execution_class(&self) -> ToolExecutionClass {
        ToolExecutionClass::LogicalInline
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().to_string(),
            description: "Deterministically resolve an Execution Target available to the current identity by stable ID or by capabilities, platform, and backend. Runtime-managed SSH has no persistent connection lease: when list_targets reports route_needs_rehydration, pass target_id to rebuild the route; that report does not mean the remote host is offline. Managed SSH may also register an existing host OpenSSH alias on demand. Explicitly use the returned stable target_id in subsequent non-local physical tool calls.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "target_id": {
                        "type": "string",
                        "description": "Optional stable Target ID. Pass it to rebuild a Runtime Managed SSH route in place; do not combine it with host, user, or port"
                    },
                    "capabilities": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "All physical tool names the Target must provide; Managed SSH v1 requires exec, not ssh"
                    },
                    "platform": {"type": "string"},
                    "kind": {
                        "type": "string",
                        "enum": ["in_process_local", "edge_node", "managed_ssh", "managed_worker"]
                    },
                    "host": {
                        "type": "string",
                        "description": "An SSH config Host, DNS hostname, or IPv4 address. Used only for managed_ssh; the Runtime creates a Target on demand when none exists"
                    },
                    "user": {
                        "type": "string",
                        "description": "Optional SSH username; omission uses OpenSSH config or the host default"
                    },
                    "port": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 65535,
                        "description": "Optional SSH port; omission uses OpenSSH config or port 22"
                    },
                    "workspace_root": {
                        "type": "string",
                        "description": "Optional remote Workspace hint recorded when a managed_ssh Target is created on demand"
                    },
                    "allow_offline_queue": {
                        "type": "boolean",
                        "description": "Whether to allow an Edge Target with durable offline queueing or a Managed SSH Target backed by an Edge Provider"
                    }
                },
                "additionalProperties": false
            }),
        }
    }

    async fn execute(&self, arguments: &str) -> Result<String, TargetExecutionError> {
        let args: ResolveTargetArgs = serde_json::from_str(arguments)?;
        if args.target_id.is_some()
            && (args.host.is_some() || args.user.is_some() || args.port.is_some())
        {
            return Err("resolve_target.target_id 不能与 host/user/port 同时使用".into());
        }
        if (args.host.is_some() || args.user.is_some() || args.port.is_some())
            && args
                .kind
                .is_some_and(|kind| kind != ExecutionTargetKind::ManagedSsh)
        {
            return Err("resolve_target.host/user/port 只能与 kind=managed_ssh 一起使用".into());
        }
        if let Some(host) = args.host.as_deref() {
            validate_ssh_host(host)?;
        }
        if args.host.is_none() && (args.user.is_some() || args.port.is_some()) {
            return Err("resolve_target.user/port 必须与 host 一起使用".into());
        }
        if let Some(user) = args.user.as_deref() {
            validate_ssh_user(user)?;
        }
        if args.port == Some(0) {
            return Err("resolve_target.port 必须大于 0".into());
        }
        if args
            .workspace_root
            .as_deref()
            .is_some_and(|root| root.trim().is_empty())
        {
            return Err("resolve_target.workspace_root 不能为空".into());
        }
        let selected = if let Some(target_id) = args.target_id.as_deref() {
            let target = self
                .targets
                .get_execution_target(target_id)
                .await?
                .ok_or_else(|| format!("Execution Target '{target_id}' 不存在"))?;
            if !target_visible_to_active_principal(&target) {
                return Err(format!("当前身份不能使用 Execution Target '{}'", target.id).into());
            }
            if target.status == ExecutionTargetStatus::Offline
                && target.kind == ExecutionTargetKind::ManagedSsh
                && target.provider_node_id.is_none()
            {
                self.runtime_managed_ssh
                    .as_ref()
                    .ok_or("当前 Runtime 未启用按需 Managed SSH Target")?
                    .rehydrate(&target)
                    .await?
            } else if target.status == ExecutionTargetStatus::Online
                || (args.allow_offline_queue
                    && target.status == ExecutionTargetStatus::Offline
                    && (target.kind == ExecutionTargetKind::EdgeNode
                        || (target.kind == ExecutionTargetKind::ManagedSsh
                            && target.provider_node_id.is_some())))
            {
                target
            } else {
                return Err(format!(
                    "Execution Target '{}' 当前为 {}，不能按当前策略选择",
                    target.id,
                    target.status.as_str()
                )
                .into());
            }
        } else if let Some(host) = args.host.as_deref() {
            let provisioner = self
                .runtime_managed_ssh
                .as_ref()
                .ok_or("当前 Runtime 未启用按需 Managed SSH Target")?;
            provisioner
                .provision(
                    host,
                    args.user.as_deref(),
                    args.port,
                    args.platform.clone(),
                    args.workspace_root.clone(),
                )
                .await?
        } else {
            let mut targets = self
                .targets
                .list_execution_targets(ExecutionTargetFilter {
                    limit: Some(256),
                    ..Default::default()
                })
                .await?
                .into_iter()
                .filter(target_visible_to_active_principal)
                .filter(|target| {
                    target.status == ExecutionTargetStatus::Online
                        || (args.allow_offline_queue
                            && target.status == ExecutionTargetStatus::Offline
                            && (target.kind == ExecutionTargetKind::EdgeNode
                                || (target.kind == ExecutionTargetKind::ManagedSsh
                                    && target.provider_node_id.is_some())))
                })
                .filter(|target| args.kind.is_none_or(|kind| target.kind == kind))
                .filter(|target| {
                    args.platform.as_ref().is_none_or(|platform| {
                        target.platform.as_ref().is_some_and(|candidate| {
                            candidate.eq_ignore_ascii_case(platform)
                                || candidate
                                    .to_ascii_lowercase()
                                    .contains(&platform.to_ascii_lowercase())
                        })
                    })
                })
                .filter(|target| {
                    args.workspace_root.as_ref().is_none_or(|workspace_root| {
                        target.workspace_root.as_deref() == Some(workspace_root.as_str())
                    })
                })
                .filter(|target| {
                    args.capabilities
                        .iter()
                        .all(|required| target.capabilities.iter().any(|actual| actual == required))
                })
                .collect::<Vec<_>>();
            targets.sort_by(|left, right| {
                let left_offline = left.status != ExecutionTargetStatus::Online;
                let right_offline = right.status != ExecutionTargetStatus::Online;
                left_offline
                    .cmp(&right_offline)
                    .then_with(|| left.id.cmp(&right.id))
            });
            targets
                .into_iter()
                .next()
                .ok_or("没有满足当前 Principal、在线状态、平台和能力约束的 Execution Target")?
        };
        if !args.capabilities.iter().all(|required| {
            selected
                .capabilities
                .iter()
                .any(|actual| actual == required)
        }) {
            return Err(format!("Execution Target '{}' 不具备请求的全部能力", selected.id).into());
        }
        Ok(serde_json::json!({
            "target_id": selected.id,
            "name": selected.name,
            "kind": selected.kind,
            "status": selected.status,
            "platform": selected.platform,
            "capabilities": selected.capabilities,
            "provider_node_id": selected.provider_node_id,
            "host": selected.metadata.get("host"),
            "user": selected.metadata.get("user"),
            "port": selected.metadata.get("port"),
            "runtime_availability": target_runtime_availability(&selected),
            "selection": "deterministic_online_then_target_id"
        })
        .to_string())
    }
}

impl InspectTargetTool {
    pub fn new(targets: Arc<dyn ExecutionTargetStore>) -> Self {
        Self { targets }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InspectTargetArgs {
    target_id: String,
}

#[async_trait::async_trait]
impl Tool for InspectTargetTool {
    fn name(&self) -> &str {
        "inspect_target"
    }

    fn execution_class(&self) -> ToolExecutionClass {
        ToolExecutionClass::LogicalInline
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().to_string(),
            description: "Inspect an Execution Target's capabilities, platform, Workspace, Provider, and policy summary by stable ID. Credentials are never returned.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "target_id": {"type": "string"}
                },
                "required": ["target_id"],
                "additionalProperties": false
            }),
        }
    }

    async fn execute(&self, arguments: &str) -> Result<String, TargetExecutionError> {
        let args: InspectTargetArgs = serde_json::from_str(arguments)?;
        let target = self
            .targets
            .get_execution_target(&args.target_id)
            .await?
            .ok_or_else(|| format!("Execution Target '{}' 不存在", args.target_id))?;
        if !target_visible_to_active_principal(&target) {
            return Err(format!("当前身份不能查看 Execution Target '{}'", target.id).into());
        }
        let runtime_availability = target_runtime_availability(&target);
        let mut output = serde_json::to_value(target)?;
        output
            .as_object_mut()
            .ok_or("Execution Target 序列化结果不是 object")?
            .insert("runtime_availability".to_string(), runtime_availability);
        Ok(output.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::sqlite::SqliteStore;
    use crate::memory::{ExecutionJobStatus, ExecutionRetrySafety};

    #[test]
    fn managed_ssh_artifact_paths_expand_current_user_home_without_shell_injection() {
        assert_eq!(shell_quote_remote_path("~"), "\"$HOME\"");
        assert_eq!(
            shell_quote_remote_path("~/Codes/miao-social/exports/recent 3d.pdf"),
            "\"$HOME\"/'Codes/miao-social/exports/recent 3d.pdf'"
        );
        assert_eq!(
            shell_quote_remote_path("/srv/data/recent 3d.pdf"),
            "'/srv/data/recent 3d.pdf'"
        );
    }

    #[test]
    fn edge_route_carries_immutable_job_authority_scope() {
        let now = Utc::now();
        let job = ExecutionJobRecord {
            id: "job-a".to_string(),
            revision: 0,
            activation_id: "activation-a".to_string(),
            thread_id: "thread-a".to_string(),
            agent_id: "agent-a".to_string(),
            context_id: "context-a".to_string(),
            session_id: "session-a".to_string(),
            initiating_principal_id: Some("principal-a".to_string()),
            target_id: "target-a".to_string(),
            tool_call_id: "call-a".to_string(),
            tool_name: "exec".to_string(),
            request: serde_json::json!({
                EXECUTION_ROUTE_REQUEST_KEY: {
                    "route_id": "route-a",
                    "target_id": "target-a",
                    "target_revision": 2,
                    "provider_node_id": "node-a",
                    "backend_kind": "edge_node",
                    "endpoint_ref": null,
                    "policy_digest": "target-policy"
                }
            }),
            status: ExecutionJobStatus::Queued,
            retry_safety: ExecutionRetrySafety::AtMostOnce,
            claimed_by: None,
            claim_token: None,
            lease_expires_at: None,
            heartbeat_at: None,
            approval_ref: None,
            side_effect_started_at: None,
            cancel_requested_at: None,
            cancel_reason: None,
            progress_ref: None,
            result_event_id: None,
            result_refs: Vec::new(),
            error: None,
            exit_code: None,
            created_at: now,
            started_at: None,
            updated_at: now,
            finished_at: None,
        };
        let route = edge_command_route_from_job(&job).unwrap();
        let scope = edge_execution_scope_from_route(&route).unwrap();
        assert_eq!(scope.principal_id, "principal-a");
        assert_eq!(scope.thread_id, "thread-a");
        let frozen: ExecutionRouteSnapshot = serde_json::from_value(route).unwrap();
        assert_eq!(frozen.target_id, "target-a");
        assert_eq!(frozen.provider_node_id.as_deref(), Some("node-a"));
    }

    #[test]
    fn remote_preflight_keeps_target_paths_target_local() {
        let now = Utc::now();
        let target = ExecutionTargetRecord {
            id: "target-edge".to_string(),
            revision: 1,
            owner_principal_id: Some("principal-a".to_string()),
            provider_node_id: Some("node-a".to_string()),
            kind: ExecutionTargetKind::EdgeNode,
            name: "Edge".to_string(),
            status: ExecutionTargetStatus::Online,
            platform: None,
            workspace_root: None,
            capabilities: vec!["read".to_string()],
            metadata: serde_json::json!({}),
            policy_digest: "policy-a".to_string(),
            created_at: now,
            updated_at: now,
            last_seen_at: Some(now),
        };
        let requirement =
            remote_target_approval_requirement(&target, "read", r#"{"path":"src/lib.rs"}"#)
                .unwrap();
        assert_eq!(
            requirement.requested.read_roots,
            vec![std::path::PathBuf::from("src/lib.rs")]
        );
        assert!(matches!(
            requirement.action,
            ApprovalAction::ToolOperation { ref operation, .. }
                if operation == "execute_on_remote_target"
        ));
        let search = remote_target_approval_requirement(
            &target,
            "search",
            r#"{"query":"needle","paths":["src","tests"]}"#,
        )
        .unwrap();
        assert_eq!(
            search.requested.read_roots,
            vec![
                std::path::PathBuf::from("src"),
                std::path::PathBuf::from("tests")
            ]
        );
    }

    #[test]
    fn runtime_managed_ssh_registration_publishes_core_tools_and_transfer() {
        let temp = tempfile::TempDir::new().unwrap();
        let known_hosts = temp.path().join("known_hosts");
        std::fs::write(&known_hosts, "server.example ssh-ed25519 AAAA\n").unwrap();
        let endpoint = ManagedSshEndpoint {
            destination: None,
            host: "server.example".to_string(),
            user: Some("deploy".to_string()),
            port: 2222,
            known_hosts_file: known_hosts,
            approved: true,
            config_digest: None,
        };
        let config = ManagedSshTargetConfig {
            id: "target-server".to_string(),
            name: "Server".to_string(),
            endpoint_ref: "server".to_string(),
            platform: Some("linux-x86_64".to_string()),
            workspace_root: Some("/srv/app".to_string()),
            ..ManagedSshTargetConfig::default()
        };

        let registration =
            runtime_managed_ssh_registration(&config, &endpoint, "principal-a", "policy-a")
                .unwrap();

        assert_eq!(registration.kind, ExecutionTargetKind::ManagedSsh);
        assert_eq!(registration.status, ExecutionTargetStatus::Online);
        assert_eq!(
            registration.owner_principal_id.as_deref(),
            Some("principal-a")
        );
        assert_eq!(registration.provider_node_id, None);
        assert_eq!(
            registration.capabilities,
            vec![
                "exec",
                "read",
                "write",
                "edit",
                "list_files",
                "search",
                "transfer"
            ]
        );
        assert_eq!(registration.metadata["execution_location"], "runtime");
        assert_eq!(registration.metadata["endpoint_ref"], "server");
    }

    #[test]
    fn managed_ssh_arguments_pin_transport_and_ignore_agent_permissions() {
        let temp = tempfile::TempDir::new().unwrap();
        let known_hosts = temp.path().join("known_hosts");
        std::fs::write(&known_hosts, "server.example ssh-ed25519 AAAA\n").unwrap();
        let endpoint = ManagedSshEndpoint {
            destination: None,
            host: "server.example".to_string(),
            user: Some("deploy".to_string()),
            port: 2222,
            known_hosts_file: known_hosts.clone(),
            approved: true,
            config_digest: None,
        };

        let prepared = build_managed_ssh_exec_arguments(
            "server",
            &endpoint,
            "target-server",
            r#"{
                "command":"printf '%s' \"$TOKEN\"",
                "cwd":"/srv/app dir",
                "wait_ms":2500,
                "sandbox_permissions":"use_default",
                "requested_permissions":{"write_paths":["/"]}
            }"#,
        )
        .unwrap();
        let prepared: serde_json::Value = serde_json::from_str(&prepared).unwrap();
        let command = prepared["command"].as_str().unwrap();

        assert!(command.contains("'ssh' '-F' '/dev/null'"));
        assert!(command.contains("'IdentitiesOnly=no'"));
        assert!(command.contains("'StrictHostKeyChecking=yes'"));
        assert!(command.contains("'deploy@server.example'"));
        assert!(command.contains("'cd -- '\\''/srv/app dir'\\'' && printf"));
        assert_eq!(prepared["sandbox_permissions"], "require_escalated");
        assert_eq!(prepared["requested_permissions"]["network"], true);
        assert_eq!(
            prepared["requested_permissions"]["read_paths"][0],
            known_hosts.to_string_lossy().as_ref()
        );
        assert_eq!(
            prepared["requested_permissions"]["secret_env"][0],
            "SSH_AUTH_SOCK"
        );
        assert!(prepared["requested_permissions"]
            .get("write_paths")
            .is_none());
    }

    #[test]
    fn runtime_host_uses_openssh_config_without_static_endpoint_files() {
        let endpoint = managed_ssh_endpoint_from_expanded(
            "production",
            "host production\nhostname server.example\nuser deploy\nport 2222\n",
        )
        .unwrap();
        assert_eq!(endpoint.destination.as_deref(), Some("production"));
        assert_eq!(endpoint.host, "server.example");
        assert_eq!(endpoint.user.as_deref(), Some("deploy"));
        assert_eq!(endpoint.port, 2222);
        assert!(endpoint.config_digest.is_some());

        let prepared = build_managed_ssh_exec_arguments(
            "runtime_alias",
            &endpoint,
            "target-ssh-runtime",
            r#"{"command":"uname -a","cwd":"/srv/app"}"#,
        )
        .unwrap();
        let prepared: serde_json::Value = serde_json::from_str(&prepared).unwrap();
        let command = prepared["command"].as_str().unwrap();
        assert!(command.starts_with("'ssh' "));
        assert!(!command.contains("'-F' '/dev/null'"));
        assert!(!command.contains("'IdentitiesOnly=no'"));
        assert!(command.contains("'StrictHostKeyChecking=yes'"));
        assert!(command.contains("'-l' 'deploy'"));
        assert!(command.contains("'-p' '2222'"));
        assert!(command.contains("'--' 'production'"));
        assert_eq!(prepared["requested_permissions"]["network"], true);
        assert_eq!(
            prepared["requested_permissions"]["read_paths"],
            serde_json::json!([])
        );
    }

    #[test]
    fn managed_ssh_preflight_always_requests_network_approval() {
        let now = Utc::now();
        let target = ExecutionTargetRecord {
            id: "target-ssh-a".to_string(),
            revision: 1,
            owner_principal_id: Some("principal-a".to_string()),
            provider_node_id: None,
            kind: ExecutionTargetKind::ManagedSsh,
            name: "SSH production".to_string(),
            status: ExecutionTargetStatus::Online,
            platform: None,
            workspace_root: None,
            capabilities: vec!["exec".to_string()],
            metadata: serde_json::json!({"host": "production"}),
            policy_digest: "policy-a".to_string(),
            created_at: now,
            updated_at: now,
            last_seen_at: Some(now),
        };
        let requirement =
            remote_target_approval_requirement(&target, "exec", r#"{"command":"uname -a"}"#)
                .unwrap();
        assert!(requirement.requested.network);
        assert!(requirement.justification.contains("Runtime"));
        assert!(requirement.justification.contains("target-ssh-a"));
        assert!(requirement.justification.contains("SSH production"));
    }

    #[tokio::test]
    async fn resolve_target_provisions_a_runtime_ssh_host_without_prior_registration() {
        if std::process::Command::new("ssh")
            .arg("-V")
            .output()
            .is_err()
        {
            return;
        }
        let temp = tempfile::TempDir::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(temp.path().join("runtime-ssh.db").to_str().unwrap())
                .await
                .unwrap(),
        );
        let endpoints = Arc::new(RwLock::new(HashMap::new()));
        let provisioner = RuntimeManagedSshProvisioner::new(
            Arc::clone(&store) as Arc<dyn ExecutionTargetStore>,
            Arc::clone(&endpoints),
            "principal-default".to_string(),
            "policy-a".to_string(),
        );
        let tool = ResolveTargetTool::new(Arc::clone(&store) as Arc<dyn ExecutionTargetStore>)
            .with_runtime_managed_ssh(provisioner);

        let output = CURRENT_PRINCIPAL_ID
            .scope(
                Some("principal-a".to_string()),
                tool.execute(
                    r#"{
                        "kind":"managed_ssh",
                        "host":"localhost",
                        "user":"deploy",
                        "port":2222,
                        "capabilities":["exec"],
                        "workspace_root":"/srv/app"
                    }"#,
                ),
            )
            .await
            .unwrap();
        let output: serde_json::Value = serde_json::from_str(&output).unwrap();
        let target_id = output["target_id"].as_str().unwrap();
        let target = store
            .get_execution_target(target_id)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(output["kind"], "managed_ssh");
        assert_eq!(output["host"], "localhost");
        assert_eq!(output["user"], "deploy");
        assert_eq!(output["port"], 2222);
        assert_eq!(target.owner_principal_id.as_deref(), Some("principal-a"));
        assert_eq!(target.workspace_root.as_deref(), Some("/srv/app"));
        assert_eq!(target.metadata["execution_location"], "runtime");
        assert_eq!(endpoints.read().unwrap().len(), 1);

        let second = CURRENT_PRINCIPAL_ID
            .scope(
                Some("principal-a".to_string()),
                tool.execute(
                    r#"{
                        "kind":"managed_ssh",
                        "host":"localhost",
                        "user":"root",
                        "port":2222,
                        "capabilities":["exec"]
                    }"#,
                ),
            )
            .await
            .unwrap();
        let second: serde_json::Value = serde_json::from_str(&second).unwrap();
        assert_ne!(second["target_id"], output["target_id"]);
        assert_eq!(second["user"], "root");
        assert_eq!(endpoints.read().unwrap().len(), 2);

        let first = store
            .get_execution_target(target_id)
            .await
            .unwrap()
            .unwrap();
        store
            .set_execution_target_status(target_id, first.revision, ExecutionTargetStatus::Offline)
            .await
            .unwrap();
        endpoints.write().unwrap().clear();

        let recovered = CURRENT_PRINCIPAL_ID
            .scope(
                Some("principal-a".to_string()),
                tool.execute(&format!(r#"{{"target_id":"{target_id}"}}"#)),
            )
            .await
            .unwrap();
        let recovered: serde_json::Value = serde_json::from_str(&recovered).unwrap();
        assert_eq!(recovered["target_id"], target_id);
        assert_eq!(recovered["status"], "online");
        assert_eq!(
            recovered["runtime_availability"]["availability"],
            "ready_on_demand"
        );
        assert_eq!(endpoints.read().unwrap().len(), 1);
    }

    #[test]
    fn runtime_managed_ssh_offline_is_described_as_recoverable_route_state() {
        let now = Utc::now();
        let target = ExecutionTargetRecord {
            id: "target-ssh-a".to_string(),
            revision: 2,
            owner_principal_id: Some("principal-a".to_string()),
            provider_node_id: None,
            kind: ExecutionTargetKind::ManagedSsh,
            name: "SSH production".to_string(),
            status: ExecutionTargetStatus::Offline,
            platform: None,
            workspace_root: None,
            capabilities: vec!["exec".to_string()],
            metadata: serde_json::json!({
                "execution_location": "runtime",
                "host": "production"
            }),
            policy_digest: "policy-a".to_string(),
            created_at: now,
            updated_at: now,
            last_seen_at: Some(now),
        };

        let availability = target_runtime_availability(&target);
        assert_eq!(availability["availability"], "route_needs_rehydration");
        assert_eq!(availability["recoverable"], true);
        assert!(availability["status_explanation"]
            .as_str()
            .unwrap()
            .contains("不表示远端主机"));
    }

    #[test]
    fn direct_ssh_programs_are_distinguished_from_ordinary_arguments() {
        assert!(exec_arguments_invoke_ssh(r#"{"command":"ssh server uptime"}"#).unwrap());
        assert!(exec_arguments_invoke_ssh(
            r#"{"command":"cd repo && /usr/bin/scp file server:/tmp"}"#
        )
        .unwrap());
        assert!(exec_arguments_invoke_ssh(
            r#"{"command":"env SSH_AUTH_SOCK=/tmp/agent sftp server"}"#
        )
        .unwrap());
        assert!(!exec_arguments_invoke_ssh(r#"{"command":"echo ssh server"}"#).unwrap());
        assert!(!exec_arguments_invoke_ssh(r#"{"command":"rg ssh docs"}"#).unwrap());
    }

    #[tokio::test]
    async fn canonical_directory_archive_is_stable_and_safely_published() {
        let temp = tempfile::TempDir::new().unwrap();
        let source = temp.path().join("source");
        let first_archive = temp.path().join("first.tar");
        let second_archive = temp.path().join("second.tar");
        let destination = temp.path().join("destination");
        tokio::fs::create_dir_all(source.join("nested"))
            .await
            .unwrap();
        tokio::fs::write(source.join("root.txt"), b"root")
            .await
            .unwrap();
        tokio::fs::write(source.join("nested/leaf.txt"), b"leaf")
            .await
            .unwrap();

        let first = create_canonical_directory_archive(&source, &first_archive)
            .await
            .unwrap();
        let second = create_canonical_directory_archive(&source, &second_archive)
            .await
            .unwrap();
        assert_eq!(first.kind, StagedArtifactKind::DirectoryArchive);
        assert_eq!(first.payload_digest, second.payload_digest);
        assert_eq!(first.payload_size_bytes, second.payload_size_bytes);
        assert_eq!(first.logical_digest, second.logical_digest);
        assert_eq!(first.logical_size_bytes, second.logical_size_bytes);
        let (logical_size, logical_digest) =
            crate::artifact::inspect_local_directory_artifact(&source)
                .await
                .unwrap();
        assert_eq!(first.logical_size_bytes, Some(logical_size));
        assert_eq!(
            first.logical_digest.as_deref(),
            Some(logical_digest.as_str())
        );
        assert_ne!(
            first.payload_digest,
            first.logical_digest.clone().unwrap(),
            "transport envelope and logical directory identity are distinct"
        );

        let request = crate::artifact::ArtifactTransferRequest {
            transfer_id: "directory-cross-target".to_string(),
            source: crate::artifact::ArtifactLocation {
                target_id: "target-source".to_string(),
                workspace_identity: None,
                path: source.display().to_string(),
            },
            destination: crate::artifact::ArtifactLocation {
                target_id: "target-default".to_string(),
                workspace_identity: None,
                path: destination.display().to_string(),
            },
            overwrite: crate::artifact::ArtifactOverwritePolicy::Deny,
            expected_source_digest: first.logical_digest.clone(),
            media_type: None,
            origin: None,
        };
        publish_spooled_local_directory(&request, &first_archive, &destination)
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read(destination.join("nested/leaf.txt"))
                .await
                .unwrap(),
            b"leaf"
        );
        // A retry after publication reconciles by canonical content digest.
        publish_spooled_local_directory(&request, &first_archive, &destination)
            .await
            .unwrap();
    }

    #[test]
    fn managed_ssh_file_tool_bootstrap_does_not_depend_on_the_login_shell() {
        let command = managed_ssh_file_tool_command();
        assert!(command.starts_with("sh -lc "));
        assert!(!command.starts_with("if "));

        if std::process::Command::new("fish")
            .arg("--version")
            .output()
            .is_err()
            || std::process::Command::new("python3")
                .arg("--version")
                .output()
                .is_err()
        {
            return;
        }

        let temp = tempfile::TempDir::new().unwrap();
        let request = serde_json::json!({
            "operation": "list_files",
            "workspace_root": temp.path().display().to_string(),
            "arguments": {"path": ".", "max_depth": 1}
        });
        let mut child = std::process::Command::new("fish")
            .arg("-c")
            .arg(&command)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        std::io::Write::write_all(
            child.stdin.as_mut().unwrap(),
            serde_json::to_string(&request).unwrap().as_bytes(),
        )
        .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "fish must be able to hand the bootstrap to sh: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let envelope: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(envelope["ok"], true);
    }

    #[test]
    fn managed_ssh_protocol_supports_core_file_tools() {
        if std::process::Command::new("python3")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        fn invoke(request: serde_json::Value) -> serde_json::Value {
            let mut child = std::process::Command::new("python3")
                .arg("-c")
                .arg(MANAGED_SSH_FILE_TOOL_SCRIPT)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            std::io::Write::write_all(
                child.stdin.as_mut().unwrap(),
                serde_json::to_string(&request).unwrap().as_bytes(),
            )
            .unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(output.status.success());
            serde_json::from_slice(&output.stdout).unwrap()
        }

        let temp = tempfile::TempDir::new().unwrap();
        let workspace = temp.path().display().to_string();
        let written = invoke(serde_json::json!({
            "operation": "write",
            "workspace_root": &workspace,
            "arguments": {"path": "src/lib.rs", "content": "pub fn generated() {}\n", "mode": "create"}
        }));
        // The protocol deliberately does not create missing parent directories.
        assert_eq!(written["ok"], false);
        std::fs::create_dir_all(temp.path().join("src")).unwrap();
        let written = invoke(serde_json::json!({
            "operation": "write",
            "workspace_root": &workspace,
            "arguments": {"path": "src/lib.rs", "content": "pub fn generated() {}\n", "mode": "create"}
        }));
        assert_eq!(written["ok"], true);

        let read = invoke(serde_json::json!({
            "operation": "read",
            "workspace_root": &workspace,
            "arguments": {"path": "src/lib.rs", "query": "generated"}
        }));
        assert_eq!(read["ok"], true);
        assert!(read["output"].as_str().unwrap().contains("sha256="));
        assert!(read["output"].as_str().unwrap().contains("generated"));

        let digest = read["output"]
            .as_str()
            .unwrap()
            .split("sha256=")
            .nth(1)
            .unwrap()
            .split(']')
            .next()
            .unwrap();
        let edited = invoke(serde_json::json!({
            "operation": "edit",
            "workspace_root": &workspace,
            "arguments": {
                "path": "src/lib.rs",
                "expected_sha256": digest,
                "edits": [{"old_text": "generated", "new_text": "remote_generated"}]
            }
        }));
        assert_eq!(edited["ok"], true);

        let listed = invoke(serde_json::json!({
            "operation": "list_files",
            "workspace_root": &workspace,
            "arguments": {"path": "src", "glob": "**/*.rs"}
        }));
        assert_eq!(listed["ok"], true);
        let listing: serde_json::Value =
            serde_json::from_str(listed["output"].as_str().unwrap()).unwrap();
        assert_eq!(listing["count"], 1);
        assert_eq!(listing["entries"][0]["path"], "lib.rs");

        let search = invoke(serde_json::json!({
            "operation": "search",
            "workspace_root": &workspace,
            "arguments": {"paths": ["src"], "query": "remote_generated", "glob": "**/*.rs"}
        }));
        assert_eq!(search["ok"], true);
        let payload: serde_json::Value =
            serde_json::from_str(search["output"].as_str().unwrap()).unwrap();
        assert_eq!(payload["count"], 1);
        assert_eq!(payload["matches"][0]["path"], "src/lib.rs");
    }

    #[test]
    fn directory_archive_rejects_escaping_paths_and_links() {
        assert!(validate_archive_relative_path(Path::new("../escape")).is_err());
        assert!(validate_archive_relative_path(Path::new("/absolute")).is_err());
        assert!(validate_archive_link_target(Path::new("../../secret")).is_err());
        assert!(validate_archive_link_target(Path::new("nested/file")).is_ok());
    }
}
