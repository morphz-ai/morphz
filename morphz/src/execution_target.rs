//! Stable execution destinations and backend-neutral target selection.
//!
//! An [`ExecutionTargetRecord`] is a logical security/execution boundary. It
//! is deliberately distinct from a live Node connection and from the Worker
//! process which claims one Execution Job.

use std::collections::HashMap;
use std::error::Error;
use std::sync::{Arc, RwLock};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::approval::{ApprovalAction, CapabilityDelta};
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
    Ok(crate::permission::ApprovalRequirement {
        action: ApprovalAction::ToolOperation {
            tool: tool_name.to_string(),
            operation: "execute_on_remote_target".to_string(),
            target: path,
        },
        requested,
        justification: format!(
            "当前 Thread 首次在非本地 Execution Target 上使用物理能力 '{tool_name}'；云端只授权逻辑 Target 范围，Provider Node 仍须独立完成本地预检和审批"
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
            && matches!(
                target.kind,
                ExecutionTargetKind::EdgeNode | ExecutionTargetKind::ManagedSsh
            );
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
            description: "列出当前身份可使用的 Execution Target 紧凑索引。物理工具的 target 参数应使用这里返回的稳定 ID。".to_string(),
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
                serde_json::json!({
                    "target_id": target.id,
                    "name": target.name,
                    "kind": target.kind,
                    "status": target.status,
                    "platform": target.platform,
                    "capabilities": target.capabilities,
                    "provider_node_id": target.provider_node_id,
                    "workspace_root": target.workspace_root,
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
}

impl ResolveTargetTool {
    pub fn new(targets: Arc<dyn ExecutionTargetStore>) -> Self {
        Self { targets }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResolveTargetArgs {
    #[serde(default)]
    capabilities: Vec<String>,
    platform: Option<String>,
    kind: Option<ExecutionTargetKind>,
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
            description: "按能力、平台和 Backend 确定性选择一个当前身份可用的 Execution Target。返回的稳定 target_id 必须显式用于随后的非本地物理工具调用。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "capabilities": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Target 必须同时具备的全部物理工具或设备能力"
                    },
                    "platform": {"type": "string"},
                    "kind": {
                        "type": "string",
                        "enum": ["in_process_local", "edge_node", "managed_ssh", "managed_worker"]
                    },
                    "allow_offline_queue": {
                        "type": "boolean",
                        "description": "是否允许选择支持持久离线排队的 Edge/Managed SSH Target"
                    }
                },
                "additionalProperties": false
            }),
        }
    }

    async fn execute(&self, arguments: &str) -> Result<String, TargetExecutionError> {
        let args: ResolveTargetArgs = serde_json::from_str(arguments)?;
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
                        && matches!(
                            target.kind,
                            ExecutionTargetKind::EdgeNode | ExecutionTargetKind::ManagedSsh
                        ))
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
        let selected = targets
            .into_iter()
            .next()
            .ok_or("没有满足当前 Principal、在线状态、平台和能力约束的 Execution Target")?;
        Ok(serde_json::json!({
            "target_id": selected.id,
            "name": selected.name,
            "kind": selected.kind,
            "status": selected.status,
            "platform": selected.platform,
            "capabilities": selected.capabilities,
            "provider_node_id": selected.provider_node_id,
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
        Ok(serde_json::to_string(&target)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
        let requirement =
            remote_target_approval_requirement("read", r#"{"path":"src/lib.rs"}"#).unwrap();
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
}
