//! Stable execution destinations and backend-neutral target selection.
//!
//! An [`ExecutionTargetRecord`] is a logical security/execution boundary. It
//! is deliberately distinct from a live Node connection and from the Worker
//! process which claims one Execution Job.

use std::collections::HashMap;
use std::error::Error;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::approval::{ApprovalAction, CapabilityDelta};
use crate::config::ManagedSshTargetConfig;
use crate::llm::ToolDefinition;
use crate::memory::{
    EdgeCommandStatus, EdgeExecutionStore, ExecutionJobRecord, ExecutionTargetAuthorizationFilter,
    ExecutionTargetAuthorizationScope, ExecutionTargetAuthorizationStatus,
    ExecutionTargetAuthorizationStore, ExecutionTargetFilter, ExecutionTargetKind,
    ExecutionTargetRecord, ExecutionTargetRegistration, ExecutionTargetStatus,
    ExecutionTargetStore, NewEdgeCommand,
};
use crate::tool::{Tool, ToolExecutionClass, CURRENT_PRINCIPAL_ID};

pub type TargetExecutionError = Box<dyn Error + Send + Sync>;

/// Single-machine compatibility target. Local callers may omit `target`; the
/// Runtime resolves that omission to this explicit authority before it creates
/// an Execution Job.
pub const DEFAULT_EXECUTION_TARGET_ID: &str = "target-default";
pub const EXECUTION_ROUTE_REQUEST_KEY: &str = "_morphz_execution_route";
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

/// Routes Managed SSH either through the owning Edge Node or through the
/// current Runtime. A Target with `provider_node_id` is always remote; a
/// Runtime-local Target must name an endpoint loaded from host-owned config.
pub struct ManagedSshBackend {
    edge: EdgeNodeBackend,
    local_endpoints: Arc<RwLock<HashMap<String, ManagedSshEndpoint>>>,
    permission_policy_digest: String,
    approval_required: bool,
}

impl ManagedSshBackend {
    pub fn new(
        store: Arc<dyn EdgeExecutionStore>,
        local_endpoints: Arc<RwLock<HashMap<String, ManagedSshEndpoint>>>,
        permission_policy_digest: String,
        approval_required: bool,
    ) -> Self {
        Self {
            edge: EdgeNodeBackend::managed_ssh(store),
            local_endpoints,
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
        if tool.name() != "exec" {
            return Err(format!(
                "Managed SSH v1 只支持 exec，Target '{}' 收到不受支持的工具 '{}'",
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
        let prepared = prepare_managed_ssh_exec_arguments(
            endpoint_ref,
            &endpoint,
            &context.target.id,
            arguments,
        )?;
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
                                } if tool == "exec" && operation == "execute_on_remote_target"
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
        crate::tool::CURRENT_RUNTIME_MANAGED_SSH
            .scope(true, tool.execute(&prepared))
            .await
    }
}

/// Backend-neutral authority used at the physical side-effect boundary.
/// Selection is deterministic by the Target's persisted kind; it never falls
/// back to another Target when the requested destination is unavailable.
pub struct ExecutionTargetDispatcher {
    targets: Arc<dyn ExecutionTargetStore>,
    authorizations: Arc<dyn ExecutionTargetAuthorizationStore>,
    backends: RwLock<HashMap<ExecutionTargetKind, Arc<dyn ExecutionTargetBackend>>>,
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
        }
    }

    pub fn register_backend(&self, backend: Arc<dyn ExecutionTargetBackend>) {
        self.backends
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(backend.kind(), backend);
    }

    pub async fn execute(
        &self,
        job: &ExecutionJobRecord,
        tool: Arc<dyn Tool>,
        arguments: &str,
    ) -> Result<String, TargetExecutionError> {
        let route = route_snapshot_from_job(job)?;
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
        capabilities: vec!["exec".to_string()],
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
            description: "列出当前身份可使用的 Execution Target 紧凑索引。物理工具的 target 参数应使用这里返回的稳定 ID。注意：Runtime 托管 SSH 是按命令拨号，不维护常驻 SSH 租约；其 offline 只可能表示当前 Runtime 路由待重建，不等于远端主机物理离线，应按 recommended_action 调用 resolve_target 恢复。".to_string(),
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
            description: "按稳定 ID或按能力、平台和 Backend 确定性选择当前身份可用的 Execution Target。Runtime 托管 SSH 没有常驻连接租约：若 list_targets 显示 route_needs_rehydration，传入 target_id 即可重建路由；这不是对远端主机离线的判断。Managed SSH 也可直接传入宿主机已有的 OpenSSH alias 按需注册。返回的稳定 target_id 必须显式用于随后的非本地物理工具调用。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "target_id": {
                        "type": "string",
                        "description": "可选的稳定 Target ID。Runtime Managed SSH 路由待恢复时，传入该 ID 可原地重建；不要同时传 host/user/port"
                    },
                    "capabilities": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Target 必须同时具备的全部物理工具名；Managed SSH v1 请求 exec，不请求 ssh"
                    },
                    "platform": {"type": "string"},
                    "kind": {
                        "type": "string",
                        "enum": ["in_process_local", "edge_node", "managed_ssh", "managed_worker"]
                    },
                    "host": {
                        "type": "string",
                        "description": "SSH config 的 Host、DNS hostname 或 IPv4 地址。仅用于 managed_ssh；找不到现有 Target 时 Runtime 会按需创建"
                    },
                    "user": {
                        "type": "string",
                        "description": "可选 SSH 用户名；省略时使用 OpenSSH config 或宿主默认用户名"
                    },
                    "port": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 65535,
                        "description": "可选 SSH 端口；省略时使用 OpenSSH config 或默认端口 22"
                    },
                    "workspace_root": {
                        "type": "string",
                        "description": "可选的远端 Workspace 提示；按需创建 managed_ssh Target 时记录"
                    },
                    "allow_offline_queue": {
                        "type": "boolean",
                        "description": "是否允许选择支持持久离线排队的 Edge 或由 Edge Provider 承接的 Managed SSH Target"
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
            description: "按稳定 ID 查看一个 Execution Target 的能力、平台、Workspace、Provider 与策略摘要；不返回凭证。".to_string(),
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
    }

    #[test]
    fn runtime_managed_ssh_registration_is_online_and_exec_only() {
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
        assert_eq!(registration.capabilities, vec!["exec"]);
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
}
