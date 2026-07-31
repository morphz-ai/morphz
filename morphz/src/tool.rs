use crate::approval::{ApprovalAction, ApprovalProvider, CapabilityDelta, DenyAllApprovalProvider};
use crate::config::BackgroundTaskConfig;
use crate::event::{Event, InMemoryEventBus, TYPE_AGENT_CALL, TYPE_FILE_CHANGE, TYPE_TOOL_OUTPUT};
use crate::execution::{
    deterministic_job_id, ExecutionJobManager, ExecutionJobSpec, JobClaim, JobHeartbeat,
    JobOutcome, JobReceipt,
};
use crate::llm::ToolDefinition;
use crate::memory::{
    EdgeOutputStream, EventStore, ExecutionJobFilter, ExecutionJobRecord, ExecutionJobStatus,
    ExecutionJobStore, ExecutionRetrySafety, NewObjective, NewRuntimeTimer, NewSchedule,
    NewScheduledObjective, NewThread, NewThreadGroup, NewThreadGroupMember, NewThreadGroupPlan,
    ObjectiveStatus, ObjectiveStore, ObjectiveWaitCondition, QueryFilter, RuntimeTimerKind,
    RuntimeTimerRecord, ScheduleMutation, ScheduleRecord, ScheduleStatus,
    ScheduledObjectiveWaitBinding, SessionStatus, SessionStore, ThreadGroupPolicy, ThreadKind,
    ThreadLifecycle, ThreadLifetime, ThreadPromotionMutation, ThreadPromotionRequest,
    ThreadSupervision, ThreadSupervisorKind,
};
use crate::objective::TYPE_OBJECTIVE_CONTROL;
use crate::permission::{
    ApprovalContext, ApprovalRequirement, FilesystemAccess, PermissionBroker, PermissionConfig,
    PermissionProfile, SandboxMode, ShellEnvironmentPolicy,
};
use crate::sandbox::{
    EnforcementStatus, NativeSandbox, NetworkPolicy, SandboxPolicy, ShellRequest,
};
use crate::timer::{TimerDisposition, TimerEngine};
use dashmap::DashMap;
use glob::Pattern;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::fs::{OpenOptions, Permissions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, RwLock};
use tokio::io::{AsyncBufReadExt, BufReader};
use walkdir::WalkDir;

const MAX_SCHEDULE_OPERATIONS: usize = 32;
const MAX_SCHEDULE_INTENT_CHARS: usize = 1_000_000;

tokio::task_local! {
    pub static CURRENT_SESSION_ID: String;
    pub static CURRENT_CONTEXT_ID: String;
    pub static CURRENT_OBJECTIVE_ID: Option<String>;
    pub static CURRENT_PRINCIPAL_ID: Option<String>;
    pub static CURRENT_ATTEMPT_ID: String;
    pub static CURRENT_CAUSAL_ROUTE: Option<ToolCausalRoute>;
    pub static CURRENT_EXECUTION_JOB: Option<ToolExecutionJobContext>;
    pub static CURRENT_TOOL_OUTPUT_SINK: Option<tokio::sync::mpsc::Sender<ToolOutputChunk>>;
    /// Set only by the Runtime Managed SSH backend after Target authorization.
    /// It lets the host-owned OpenSSH client read the user's SSH configuration
    /// without making that configuration available to model-authored Shell.
    pub static CURRENT_RUNTIME_MANAGED_SSH: bool;
}

#[derive(Debug, Clone)]
pub struct ToolOutputChunk {
    pub stream: EdgeOutputStream,
    pub text: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct VerifyIdentityArgs {
    claimed_principal_id: String,
}

pub struct VerifyIdentityTool {
    sessions: Arc<dyn SessionStore>,
}

impl VerifyIdentityTool {
    pub fn new(sessions: Arc<dyn SessionStore>) -> Self {
        Self { sessions }
    }
}

#[async_trait::async_trait]
impl Tool for VerifyIdentityTool {
    fn name(&self) -> &str {
        "verify_identity"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().to_string(),
            description: "验证消息正文中声称的 Principal 是否就是当前 Activation 的 Runtime 权威身份。不要传 session_id；Runtime 自动使用当前求值路由。身份声明与 kernel.active-principal 冲突、身份等价关系会影响判断、或用户明确要求验证时使用。它只验证身份事实，不替你决定是否分享信息。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "claimed_principal_id": {
                        "type": "string",
                        "minLength": 1,
                        "description": "需要验证的稳定 Principal ID，不是显示名称或 Session ID"
                    }
                },
                "required": ["claimed_principal_id"],
                "additionalProperties": false
            }),
        }
    }

    fn execution_class(&self) -> ToolExecutionClass {
        ToolExecutionClass::LogicalInline
    }

    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: VerifyIdentityArgs = serde_json::from_str(arguments)?;
        let claimed = args.claimed_principal_id.trim();
        if claimed.is_empty() {
            return Err("claimed_principal_id 不能为空".into());
        }
        let session_id = CURRENT_SESSION_ID
            .try_with(Clone::clone)
            .map_err(|_| "verify_identity 缺少当前 Session 路由")?;
        let active_principal_id = CURRENT_PRINCIPAL_ID.try_with(Clone::clone).ok().flatten();
        let Some(active_principal_id) = active_principal_id else {
            return Ok(serde_json::json!({
                "verified": false,
                "claimed_principal_id": claimed,
                "reason": "no_active_principal",
                "authority": "runtime"
            })
            .to_string());
        };
        let binding_valid = self
            .sessions
            .verify_session_principal(&session_id, &active_principal_id)
            .await?;
        Ok(serde_json::json!({
            "verified": binding_valid && claimed == active_principal_id,
            "claimed_principal_id": claimed,
            "active_principal_id": active_principal_id,
            "session_binding_valid": binding_valid,
            "authority": "runtime"
        })
        .to_string())
    }
}

#[derive(Debug, Clone)]
pub struct ToolCausalRoute {
    pub thread_id: String,
    pub activation_id: String,
    pub root_turn_id: String,
    pub trigger_event_id: String,
    pub trigger_sequence: u64,
}

/// Durable identity of the physical tool invocation currently crossing the
/// reality boundary. Long-running tools may derive a child ExecutionJob from
/// this identity when ownership outlives the immediate Function Call.
#[derive(Debug, Clone)]
pub struct ToolExecutionJobContext {
    pub parent_job_id: String,
    pub activation_id: String,
    pub thread_id: String,
    pub agent_id: String,
    pub context_id: String,
    pub session_id: String,
    pub initiating_principal_id: Option<String>,
    pub target_id: String,
    pub tool_call_id: String,
}

fn extend_causal_route(
    payload: &mut serde_json::Map<String, serde_json::Value>,
    route: Option<&ToolCausalRoute>,
) {
    let Some(route) = route else {
        return;
    };
    payload.insert("thread_id".to_string(), serde_json::json!(route.thread_id));
    payload.insert(
        "activation_id".to_string(),
        serde_json::json!(route.activation_id),
    );
    payload.insert(
        "root_turn_id".to_string(),
        serde_json::json!(route.root_turn_id),
    );
    payload.insert(
        "trigger_event_id".to_string(),
        serde_json::json!(route.trigger_event_id),
    );
    payload.insert(
        "trigger_sequence".to_string(),
        serde_json::json!(route.trigger_sequence),
    );
}

pub(crate) fn current_approval_context() -> ApprovalContext {
    let route = CURRENT_CAUSAL_ROUTE.try_with(Clone::clone).ok().flatten();
    ApprovalContext {
        session_id: CURRENT_SESSION_ID
            .try_with(Clone::clone)
            .unwrap_or_default(),
        context_id: CURRENT_CONTEXT_ID
            .try_with(Clone::clone)
            .unwrap_or_default(),
        attempt_id: CURRENT_ATTEMPT_ID
            .try_with(Clone::clone)
            .unwrap_or_default(),
        thread_id: route
            .as_ref()
            .map(|route| route.thread_id.clone())
            .unwrap_or_default(),
        root_turn_id: route
            .as_ref()
            .map(|route| route.root_turn_id.clone())
            .unwrap_or_default(),
        trigger_event_id: route
            .as_ref()
            .map(|route| route.trigger_event_id.clone())
            .unwrap_or_default(),
        trigger_sequence: route
            .as_ref()
            .map(|route| route.trigger_sequence)
            .unwrap_or_default(),
    }
}

fn approval_context() -> ApprovalContext {
    current_approval_context()
}

fn broker_from_config(config: Arc<PermissionConfig>) -> Arc<PermissionBroker> {
    let profile = PermissionProfile::from_config(&config)
        .unwrap_or_else(|error| panic!("无效 PermissionConfig: {error}"));
    Arc::new(PermissionBroker::new(
        Arc::new(profile),
        Arc::new(DenyAllApprovalProvider::new(
            "当前工具未配置边界外权限审批提供者",
        )),
    ))
}

#[async_trait::async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn definition(&self) -> ToolDefinition;
    /// Runtime execution ownership. Physical tools must be materialized as a
    /// durable ExecutionJob before `execute` may cross a reality boundary.
    fn execution_class(&self) -> ToolExecutionClass {
        ToolExecutionClass::PhysicalJob
    }
    /// Physical routing shape. Most tools execute at the Thread's single
    /// Target. Artifact Transfer is deliberately different: it freezes and
    /// authorizes an independent source and destination without rebinding the
    /// caller's Thread affinity.
    fn execution_routing(&self) -> ToolExecutionRouting {
        ToolExecutionRouting::ThreadTarget
    }
    /// Conservative restart policy for a physical Action. Tools should opt in
    /// to idempotent replay only when repeating the exact causal request is safe.
    fn retry_safety(&self) -> ExecutionRetrySafety {
        ExecutionRetrySafety::AtMostOnce
    }
    /// Pure preflight for the exact capability delta this invocation would
    /// request before crossing a physical boundary. Runtime persists and
    /// resolves this requirement before claiming the ExecutionJob.
    fn approval_requirement(
        &self,
        _arguments: &str,
    ) -> Result<Option<ApprovalRequirement>, Box<dyn std::error::Error + Send + Sync>> {
        Ok(None)
    }
    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolExecutionClass {
    /// Atomic Runtime/Context control transaction; no separate physical Job.
    LogicalInline,
    /// Reality-facing operation whose lifecycle belongs to ExecutionJob.
    PhysicalJob,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolExecutionRouting {
    ThreadTarget,
    ArtifactTransfer,
}

pub struct Registry {
    tools: RwLock<HashMap<String, RegisteredTool>>,
    /// Execution-only compatibility names. Aliases deliberately do not appear
    /// in fresh model tool definitions, but persisted calls from an older
    /// Runtime can still resume safely after a rename.
    aliases: RwLock<HashMap<String, Arc<dyn Tool>>>,
}

struct RegisteredTool {
    tool: Arc<dyn Tool>,
    definition: ToolDefinition,
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

impl Registry {
    pub fn new() -> Self {
        Self {
            tools: RwLock::new(HashMap::new()),
            aliases: RwLock::new(HashMap::new()),
        }
    }

    pub fn register(&self, tool: Arc<dyn Tool>) {
        let name = tool.name().to_string();
        let definition = tool.definition();
        self.tools
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(name, RegisteredTool { tool, definition });
    }

    pub fn register_alias(&self, alias: impl Into<String>, tool: Arc<dyn Tool>) {
        self.aliases
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(alias.into(), tool);
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(name)
            .map(|entry| Arc::clone(&entry.tool))
            .or_else(|| {
                self.aliases
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .get(name)
                    .map(Arc::clone)
            })
    }

    pub fn definitions(&self) -> Vec<ToolDefinition> {
        self.tools
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .map(|entry| {
                let mut definition = entry.definition.clone();
                if entry.tool.execution_class() == ToolExecutionClass::PhysicalJob
                    && entry.tool.execution_routing() == ToolExecutionRouting::ThreadTarget
                {
                    if let Some(properties) = definition
                        .parameters
                        .get_mut("properties")
                        .and_then(serde_json::Value::as_object_mut)
                    {
                        properties.insert(
                            "target".to_string(),
                            serde_json::json!({
                                "type": "string",
                                "description": "可选 Execution Target ID。未绑定 Thread 首次省略时绑定 target-default；已绑定 Thread 省略时继承其 Target。显式值若与 Thread 绑定不同会被拒绝，跨 Target 请用 schedule_tx.spawn 新建 Execution Thread。"
                            }),
                        );
                    }
                }
                definition
            })
            .collect()
    }

    /// Stable capability projection for Execution Target discovery. Logical
    /// Context/Scheduler tools never appear in a physical Target descriptor.
    pub fn physical_tool_names(&self) -> Vec<String> {
        let mut names = self
            .tools
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .filter(|(_, entry)| entry.tool.execution_class() == ToolExecutionClass::PhysicalJob)
            .map(|(name, _)| name.clone())
            .collect::<Vec<_>>();
        names.sort();
        names
    }
}

pub struct SendMessageTool {
    bus: Arc<InMemoryEventBus>,
    sessions: Arc<dyn SessionStore>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SendMessageArgs {
    session_id: String,
    content: String,
}

impl SendMessageTool {
    pub fn new(bus: Arc<InMemoryEventBus>, sessions: Arc<dyn SessionStore>) -> Self {
        Self { bus, sessions }
    }
}

#[async_trait::async_trait]
impl Tool for SendMessageTool {
    fn name(&self) -> &str {
        "send_message"
    }

    fn execution_class(&self) -> ToolExecutionClass {
        ToolExecutionClass::LogicalInline
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().to_string(),
            description: "向同一 Agent 的另一个 Session 主动发送消息。它不是当前 active Session 的回复，不结束当前 Evaluation，也不触发目标 Session 的新求值。当前 active Session 必须使用普通 assistant 文本回复。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "description": "目标 Session ID；必须属于当前 Agent 且不能是当前 active Session"
                    },
                    "content": {
                        "type": "string",
                        "description": "发送给目标 Session 的非空消息"
                    }
                },
                "required": ["session_id", "content"],
                "additionalProperties": false
            }),
        }
    }

    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: SendMessageArgs = serde_json::from_str(arguments)?;
        let source_session_id = CURRENT_SESSION_ID
            .try_with(Clone::clone)
            .map_err(|_| "send_message 缺少当前 Session 路由")?;
        let source_context_id = CURRENT_CONTEXT_ID
            .try_with(Clone::clone)
            .map_err(|_| "send_message 缺少当前 Context 路由")?;
        let attempt_id = CURRENT_ATTEMPT_ID
            .try_with(Clone::clone)
            .map_err(|_| "send_message 缺少当前 Evaluation 路由")?;
        let target_session_id = args.session_id.trim();
        if target_session_id.is_empty() {
            return Err("send_message.session_id 不能为空".into());
        }
        if target_session_id == source_session_id {
            return Err(
                "不能用 send_message 回复当前 active Session；请返回普通 assistant 文本".into(),
            );
        }
        if args.content.trim().is_empty() {
            return Err("send_message.content 不能为空".into());
        }
        if args.content.chars().count() > 1_000_000 {
            return Err("send_message.content 超过 1,000,000 字符".into());
        }
        let source = self
            .sessions
            .get_session(&source_session_id)
            .await?
            .ok_or("当前 Session 不存在")?;
        let target = self
            .sessions
            .get_session(target_session_id)
            .await?
            .ok_or_else(|| format!("目标 Session '{target_session_id}' 不存在"))?;
        if source.agent_id != target.agent_id {
            return Err("send_message 只能投递给同一 Agent 拥有的 Session".into());
        }
        if target.status == SessionStatus::Archived {
            return Err("目标 Session 已归档，不能接收新消息".into());
        }

        let digest =
            sha256_hex(format!("{attempt_id}\0{target_session_id}\0{}", args.content).as_bytes());
        let event_id = format!("outbound_{}_{}", attempt_id, &digest[..16]);
        let mut payload = serde_json::Map::from_iter([
            (
                "context_id".to_string(),
                serde_json::json!(target.context_id),
            ),
            ("session_id".to_string(), serde_json::json!(target.id)),
            (
                "source_context_id".to_string(),
                serde_json::json!(source_context_id),
            ),
            (
                "source_session_id".to_string(),
                serde_json::json!(source_session_id),
            ),
            ("attempt_id".to_string(), serde_json::json!(attempt_id)),
            ("text".to_string(), serde_json::json!(args.content)),
        ]);
        let causal_route = CURRENT_CAUSAL_ROUTE.try_with(Clone::clone).ok().flatten();
        let initiating_principal_id = CURRENT_PRINCIPAL_ID.try_with(Clone::clone).ok().flatten();
        if let Some(principal_id) = &initiating_principal_id {
            payload.insert("principal_id".to_string(), serde_json::json!(principal_id));
        }
        extend_causal_route(&mut payload, causal_route.as_ref());
        self.bus
            .publish(Event::new(
                event_id.clone(),
                "Agent-Morphz".to_string(),
                TYPE_AGENT_CALL.to_string(),
                "chat/outbound_message".to_string(),
                payload,
            ))
            .await?;
        Ok(serde_json::json!({
            "status": "sent",
            "session_id": target_session_id,
            "event_id": event_id,
            "guidance": "消息已投递给目标 Session；当前 Evaluation 尚未结束。如果当前 active Session 需要回复，请最终返回普通 assistant 文本。"
        })
        .to_string())
    }
}

/// Durable control plane for long-running Shell processes. ExecutionJob owns
/// lifecycle truth; the process-local map only retains the live PGID and output
/// cache required to interact with a process owned by this Runtime instance.
pub struct BackgroundTaskScheduler {
    bus: Arc<InMemoryEventBus>,
    events: Arc<dyn EventStore>,
    timers: Arc<TimerEngine>,
    execution_jobs: Option<Arc<ExecutionJobManager<dyn ExecutionJobStore>>>,
}

impl BackgroundTaskScheduler {
    pub fn new(
        bus: Arc<InMemoryEventBus>,
        events: Arc<dyn EventStore>,
        timers: Arc<TimerEngine>,
    ) -> Self {
        Self {
            bus,
            events,
            timers,
            execution_jobs: None,
        }
    }

    pub fn new_with_execution_jobs(
        bus: Arc<InMemoryEventBus>,
        events: Arc<dyn EventStore>,
        timers: Arc<TimerEngine>,
        execution_jobs: Arc<ExecutionJobManager<dyn ExecutionJobStore>>,
    ) -> Self {
        Self {
            bus,
            events,
            timers,
            execution_jobs: Some(execution_jobs),
        }
    }

    fn durable_task_identity(
        &self,
        parent: &ToolExecutionJobContext,
    ) -> Result<(String, String), Box<dyn std::error::Error + Send + Sync>> {
        let child_tool_call_id = format!("{}:background", parent.tool_call_id);
        let job_id = deterministic_job_id(&parent.activation_id, &child_tool_call_id)?;
        Ok((job_id, child_tool_call_id))
    }

    async fn ensure_parent_accepts_background_child(
        &self,
        parent: &ToolExecutionJobContext,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(manager) = &self.execution_jobs else {
            return Err("后台任务 Scheduler 未配置 ExecutionJob Store".into());
        };
        let parent_job = manager
            .store()
            .get_execution_job(&parent.parent_job_id)
            .await?
            .ok_or_else(|| format!("父 ExecutionJob '{}' 不存在", parent.parent_job_id))?;
        if parent_job.status != ExecutionJobStatus::Running
            || parent_job.cancel_requested_at.is_some()
        {
            return Err(format!(
                "父 ExecutionJob '{}' 已取消或不再 running，拒绝挂载后台 child",
                parent.parent_job_id
            )
            .into());
        }
        Ok(())
    }

    async fn attach_execution_job(
        &self,
        task_id: &str,
        parent: &ToolExecutionJobContext,
    ) -> Result<ExecutionJobRecord, Box<dyn std::error::Error + Send + Sync>> {
        let Some(manager) = &self.execution_jobs else {
            return Err("后台任务 Scheduler 未配置 ExecutionJob Store".into());
        };
        self.ensure_parent_accepts_background_child(parent).await?;
        let (_, child_tool_call_id) = self.durable_task_identity(parent)?;
        let request = {
            let task = get_tasks_map()
                .get(task_id)
                .ok_or_else(|| format!("后台进程 '{task_id}' 的 live handle 不存在"))?;
            serde_json::json!({
                "kind": "background_exec",
                "parent_job_id": parent.parent_job_id,
                "task_id": task.id,
                "command": task.cmd_str,
                "process_group_id": task.pgid,
                "started_at": task.started_at,
                "artifact_path": task.artifact_path,
                "effective_boundary": {
                    "network_enabled": task.effective_network,
                    "permission_request_available": task.permission_request_available,
                    "secret_env": task.secret_env,
                    "sandbox_backend": task.sandbox_backend,
                    "sandbox_status": task.sandbox_status,
                }
            })
        };
        let mut job = manager
            .ensure(ExecutionJobSpec {
                activation_id: parent.activation_id.clone(),
                thread_id: parent.thread_id.clone(),
                agent_id: parent.agent_id.clone(),
                context_id: parent.context_id.clone(),
                session_id: parent.session_id.clone(),
                initiating_principal_id: parent.initiating_principal_id.clone(),
                target_id: parent.target_id.clone(),
                tool_call_id: child_tool_call_id,
                tool_name: "exec/background".to_string(),
                request,
                retry_safety: ExecutionRetrySafety::ReconcileRequired,
                requires_approval: false,
            })
            .await?;
        if job.id != task_id {
            return Err(format!(
                "后台任务 ID '{}' 与派生 ExecutionJob '{}' 不一致",
                task_id, job.id
            )
            .into());
        }
        if job.status != ExecutionJobStatus::Queued {
            return Err(format!(
                "后台 ExecutionJob '{}' 当前为 {}，无法接管新进程",
                job.id,
                job.status.as_str()
            )
            .into());
        }
        self.ensure_parent_accepts_background_child(parent).await?;
        let claim_token = format!(
            "background-claim-{}-{}-{}",
            job.id,
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        let lease_expires_at = chrono::Utc::now() + chrono::Duration::minutes(2);
        job = applied_background_job(
            manager
                .claim(
                    &job.id,
                    job.revision,
                    JobClaim {
                        worker_id: "morphz-background-executor",
                        claim_token: &claim_token,
                        lease_expires_at,
                        approval_ref: None,
                    },
                )
                .await?,
            "claim",
        )?;
        job = applied_background_job(
            manager
                .heartbeat(
                    &job.id,
                    job.revision,
                    JobHeartbeat {
                        claim_token: &claim_token,
                        lease_expires_at,
                        side_effect_started_at: Some(
                            job.started_at.unwrap_or_else(chrono::Utc::now),
                        ),
                        progress_ref: job
                            .request
                            .get("artifact_path")
                            .and_then(serde_json::Value::as_str),
                    },
                )
                .await?,
            "side-effect boundary",
        )?;
        if let Err(error) = self.ensure_parent_accepts_background_child(parent).await {
            for _ in 0..8 {
                match manager
                    .request_cancel(&job.id, job.revision, Some(&error.to_string()))
                    .await?
                {
                    JobReceipt::Applied { .. } | JobReceipt::Existing { .. } => break,
                    JobReceipt::Conflict { current, .. } if !current.status.is_terminal() => {
                        job = current;
                    }
                    JobReceipt::Conflict { .. }
                    | JobReceipt::Rejected { .. }
                    | JobReceipt::NotFound { .. } => break,
                }
            }
            return Err(error);
        }
        self.spawn_execution_heartbeat(job.id.clone(), claim_token);
        Ok(job)
    }

    fn spawn_execution_heartbeat(&self, job_id: String, claim_token: String) {
        let Some(manager) = self.execution_jobs.clone() else {
            return;
        };
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                let Ok(Some(job)) = manager.store().get_execution_job(&job_id).await else {
                    break;
                };
                if job.status != ExecutionJobStatus::Running
                    || job.claim_token.as_deref() != Some(claim_token.as_str())
                {
                    break;
                }
                let progress_ref = job
                    .request
                    .get("artifact_path")
                    .and_then(serde_json::Value::as_str);
                match manager
                    .heartbeat(
                        &job.id,
                        job.revision,
                        JobHeartbeat {
                            claim_token: &claim_token,
                            lease_expires_at: chrono::Utc::now() + chrono::Duration::minutes(2),
                            side_effect_started_at: None,
                            progress_ref,
                        },
                    )
                    .await
                {
                    Ok(JobReceipt::Applied { .. }) | Ok(JobReceipt::Existing { .. }) => {}
                    Ok(JobReceipt::Conflict { .. }) => continue,
                    Ok(_) | Err(_) => break,
                }
            }
        });
    }

    async fn finish_background_execution(
        &self,
        task_id: &str,
        exit_code: i32,
        output: &str,
        residual_note: &str,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        let Some(manager) = &self.execution_jobs else {
            return Ok(false);
        };
        for _ in 0..4 {
            let Some(job) = manager.store().get_execution_job(task_id).await? else {
                return Err(format!("后台 ExecutionJob '{task_id}' 不存在").into());
            };
            if job.status.is_terminal() {
                return Ok(false);
            }
            let cancelled = job.cancel_requested_at.is_some();
            let status_text = if cancelled {
                "cancelled"
            } else if exit_code == 0 {
                "succeeded"
            } else {
                "failed"
            };
            let text = format!(
                "\n[后台任务 {} 执行结束，状态: {}，退出码: {}]{}\n--- 输出 ---\n{}",
                task_id, status_text, exit_code, residual_note, output
            );
            let mut payload = serde_json::Map::from_iter([
                ("context_id".to_string(), serde_json::json!(job.context_id)),
                ("session_id".to_string(), serde_json::json!(job.session_id)),
                (
                    "attempt_id".to_string(),
                    serde_json::json!(job.activation_id),
                ),
                (
                    "activation_id".to_string(),
                    serde_json::json!(job.activation_id),
                ),
                ("thread_id".to_string(), serde_json::json!(job.thread_id)),
                (
                    "tool_call_id".to_string(),
                    serde_json::json!(job.tool_call_id),
                ),
                ("caused_by".to_string(), serde_json::json!(job.tool_call_id)),
                ("tool_name".to_string(), serde_json::json!(job.tool_name)),
                ("tool_status".to_string(), serde_json::json!(status_text)),
                ("wake_policy".to_string(), serde_json::json!("immediate")),
                (
                    "output_empty".to_string(),
                    serde_json::json!(output.is_empty()),
                ),
                ("task_id".to_string(), serde_json::json!(task_id)),
                ("task_status".to_string(), serde_json::json!(status_text)),
                ("process_status".to_string(), serde_json::json!(status_text)),
                ("exit_code".to_string(), serde_json::json!(exit_code)),
                ("text".to_string(), serde_json::json!(text)),
            ]);
            if let Some(effective_boundary) = job.request.get("effective_boundary") {
                payload.insert("effective_boundary".to_string(), effective_boundary.clone());
            }
            if exit_code != 0 {
                let permission_request_available = job
                    .request
                    .pointer("/effective_boundary/permission_request_available")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                let effective_network = job
                    .request
                    .pointer("/effective_boundary/network_enabled")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                payload.insert(
                    "boundary_remediation".to_string(),
                    serde_json::json!(boundary_remediation(
                        permission_request_available,
                        effective_network,
                    )),
                );
            }
            let artifact_path = job
                .request
                .get("artifact_path")
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned);
            if let Some(path) = artifact_path.as_deref() {
                payload.insert("artifact_path".to_string(), serde_json::json!(path));
            }
            if let Some(route) = get_tasks_map()
                .get(task_id)
                .and_then(|task| task.causal_route.clone())
            {
                payload.insert(
                    "root_turn_id".to_string(),
                    serde_json::json!(route.root_turn_id),
                );
                payload.insert(
                    "trigger_event_id".to_string(),
                    serde_json::json!(route.trigger_event_id),
                );
                payload.insert(
                    "trigger_sequence".to_string(),
                    serde_json::json!(route.trigger_sequence),
                );
            }
            let event = Event::new(
                format!("background_output_{}", job.id),
                "System-TaskMonitor".to_string(),
                TYPE_TOOL_OUTPUT.to_string(),
                "chat/tool_output".to_string(),
                payload,
            );
            let result_refs = artifact_path.into_iter().collect::<Vec<_>>();
            let outcome = if cancelled {
                JobOutcome::Cancelled {
                    result_event_id: Some(event.id.clone()),
                    result_refs,
                    reason: job.cancel_reason.clone(),
                    exit_code: Some(exit_code),
                }
            } else if exit_code == 0 {
                JobOutcome::Succeeded {
                    result_event_id: Some(event.id.clone()),
                    result_refs,
                    exit_code: Some(exit_code),
                }
            } else {
                JobOutcome::Failed {
                    result_event_id: Some(event.id.clone()),
                    result_refs,
                    error: format!("后台进程退出码为 {exit_code}"),
                    exit_code: Some(exit_code),
                }
            };
            match manager
                .finish_with_event(
                    &job.id,
                    job.revision,
                    job.claim_token.as_deref(),
                    outcome,
                    &event,
                    true,
                )
                .await?
            {
                JobReceipt::Applied { .. } | JobReceipt::Existing { .. } => {
                    self.events.append_with_signal_outbox(event.clone()).await?;
                    // The in-memory task must remain non-terminal until its
                    // completion Event is durable. Otherwise an Evaluation
                    // finishing concurrently can observe "0 active tasks",
                    // commit no_reply, and terminalize the Thread before this
                    // causal result reaches its mailbox.
                    mark_background_task_terminal(task_id, exit_code);
                    self.bus.dispatch_persisted(event).await?;
                    return Ok(true);
                }
                JobReceipt::Conflict { .. } => continue,
                JobReceipt::Rejected { reason, .. } => return Err(reason.into()),
                JobReceipt::NotFound { .. } => {
                    return Err(format!("后台 ExecutionJob '{task_id}' 不存在").into());
                }
            }
        }
        Err(format!("后台 ExecutionJob '{task_id}' 完成时持续发生 revision 冲突").into())
    }

    async fn get_background_job(
        &self,
        task_id: &str,
    ) -> Result<Option<ExecutionJobRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let Some(manager) = &self.execution_jobs else {
            return Ok(None);
        };
        Ok(manager
            .store()
            .get_execution_job(task_id)
            .await?
            .filter(|job| job.tool_name == "exec/background"))
    }

    /// Repairs the crash window between a detached background Job/result Event
    /// terminal commit and arming its scheduler delivery intent. Generic
    /// physical Action batches arm one barrier only after every sibling result
    /// is durable, so the generic ExecutionJob reconciler deliberately commits
    /// Event without Outbox. A detached background process is its own Action
    /// boundary and therefore owns exactly one deterministic Event + Outbox.
    /// Replaying this scan is safe because both inserts are idempotent and a
    /// materialized Outbox row is never reset to pending.
    pub async fn recover_terminal_background_outboxes(
        &self,
    ) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
        let Some(manager) = &self.execution_jobs else {
            return Ok(0);
        };
        let jobs = manager
            .store()
            .list_execution_jobs(ExecutionJobFilter {
                include_terminal: true,
                ..Default::default()
            })
            .await?;
        let mut armed = 0;
        for job in jobs {
            if job.tool_name != "exec/background" || !job.status.is_terminal() {
                continue;
            }
            let event_id = job
                .result_event_id
                .as_deref()
                .ok_or_else(|| format!("后台 ExecutionJob '{}' lost 但缺少结果 Event", job.id))?;
            let mut events = self
                .events
                .query(QueryFilter {
                    event_id: Some(event_id.to_string()),
                    ..Default::default()
                })
                .await?;
            if events.len() != 1 {
                return Err(format!(
                    "后台 ExecutionJob '{}' 的 lost 结果 Event '{}' 数量异常：{}",
                    job.id,
                    event_id,
                    events.len()
                )
                .into());
            }
            self.events
                .append_with_signal_outbox(events.remove(0))
                .await?;
            armed += 1;
        }
        Ok(armed)
    }

    async fn background_job_snapshot(
        &self,
        task_id: &str,
        context_id: &str,
    ) -> Result<Option<serde_json::Value>, Box<dyn std::error::Error + Send + Sync>> {
        let Some(job) = self.get_background_job(task_id).await? else {
            return Ok(None);
        };
        if !context_id.is_empty() && job.context_id != context_id {
            return Err(format!("后台任务 '{task_id}' 不属于当前 Context").into());
        }
        let live = get_tasks_map().get(task_id);
        Ok(Some(background_execution_snapshot(&job, live.as_deref())))
    }

    async fn list_background_job_snapshots(
        &self,
        context_id: &str,
        session_id: Option<&str>,
        include_finished: bool,
    ) -> Result<Option<Vec<serde_json::Value>>, Box<dyn std::error::Error + Send + Sync>> {
        let Some(manager) = &self.execution_jobs else {
            return Ok(None);
        };
        let jobs = manager
            .store()
            .list_execution_jobs(ExecutionJobFilter {
                context_id: (!context_id.is_empty()).then(|| context_id.to_string()),
                session_id: session_id.map(ToOwned::to_owned),
                include_terminal: include_finished,
                ..Default::default()
            })
            .await?;
        let mut snapshots = jobs
            .into_iter()
            .filter(|job| job.tool_name == "exec/background")
            .map(|job| {
                let live = get_tasks_map().get(&job.id);
                background_execution_snapshot(&job, live.as_deref())
            })
            .collect::<Vec<_>>();
        snapshots.sort_by(|left, right| {
            left["started_at"]
                .as_str()
                .cmp(&right["started_at"].as_str())
        });
        Ok(Some(snapshots))
    }

    async fn request_cancel_and_signal(
        &self,
        task_id: &str,
        context_id: &str,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
        let Some(manager) = &self.execution_jobs else {
            return Err("后台任务 Scheduler 未配置 ExecutionJob Store".into());
        };
        let mut job = self
            .get_background_job(task_id)
            .await?
            .ok_or_else(|| format!("未找到后台任务 '{task_id}'"))?;
        if !context_id.is_empty() && job.context_id != context_id {
            return Err(format!("后台任务 '{task_id}' 不属于当前 Context").into());
        }
        if job.status.is_terminal() {
            let live = get_tasks_map().get(task_id);
            return Ok(serde_json::json!({
                "kind": "background_task_kill",
                "task": background_execution_snapshot(&job, live.as_deref()),
                "killed": false,
                "reason": "task_already_finished",
            }));
        }
        for _ in 0..4 {
            match manager
                .request_cancel(&job.id, job.revision, Some("Agent requested kill_task"))
                .await?
            {
                JobReceipt::Applied { job: updated, .. }
                | JobReceipt::Existing { job: updated, .. } => {
                    job = updated;
                    break;
                }
                JobReceipt::Conflict { current, .. } => {
                    job = current;
                    if job.status.is_terminal() {
                        break;
                    }
                }
                JobReceipt::Rejected {
                    current, reason, ..
                } => {
                    return Err(format!(
                        "后台 ExecutionJob '{}' 取消请求被拒绝：{}",
                        current.id, reason
                    )
                    .into());
                }
                JobReceipt::NotFound { .. } => {
                    return Err(format!("后台 ExecutionJob '{task_id}' 不存在").into());
                }
            }
        }
        if job.status.is_terminal() {
            let live = get_tasks_map().get(task_id);
            return Ok(serde_json::json!({
                "kind": "background_task_kill",
                "task": background_execution_snapshot(&job, live.as_deref()),
                "killed": false,
                "reason": "task_finished_during_cancel",
            }));
        }
        let task_pgid = get_tasks_map()
            .get(task_id)
            .map(|task| task.pgid)
            .ok_or_else(|| {
                format!(
                    "后台任务 '{task_id}' 没有当前 Runtime 的 live process owner；已持久化取消请求但不能伪造物理终止"
                )
            })?;
        if let Some(mut task) = get_tasks_map().get_mut(task_id) {
            task.status = BackgroundTaskStatus::KillRequested;
            task.wake_generation = task.wake_generation.wrapping_add(1);
            task.next_wakeup_at = None;
        }
        self.cancel(task_id).await;
        let pgid = nix::unistd::Pid::from_raw(-task_pgid);
        match nix::sys::signal::kill(pgid, nix::sys::signal::Signal::SIGKILL) {
            Ok(()) => Ok(serde_json::json!({
                "kind": "background_task_kill",
                "task_id": task_id,
                "execution_job_id": job.id,
                "status": "cancel_requested",
                "process_group_id": task_pgid,
                "killed": true,
                "guidance": "取消意图已持久化；只有进程退出观察提交后，ExecutionJob 才会进入 cancelled 终态。"
            })),
            Err(nix::errno::Errno::ESRCH) => Ok(serde_json::json!({
                "kind": "background_task_kill",
                "task_id": task_id,
                "execution_job_id": job.id,
                "status": "cancel_requested",
                "process_group_id": task_pgid,
                "killed": false,
                "reason": "process_group_not_found",
                "guidance": "取消意图已持久化；等待进程 watcher 提交真实终态，Runtime 不把 ESRCH 猜成 cancelled。"
            })),
            Err(error) => Err(format!(
                "强杀进程组 {} 遭遇系统级错误: {:?}；取消请求仍保持持久化",
                task_pgid, error
            )
            .into()),
        }
    }

    /// Physically terminates every live exec process owned by one Activation.
    /// The durable ExecutionJob cancellation is performed first by the
    /// Orchestrator; this method closes the OS side of that same causal route.
    /// A detached child that raced the first store scan is fenced here too by
    /// persisting cancellation on its derived background Job before killpg.
    pub async fn cancel_live_tasks_for_activation(
        &self,
        activation_id: &str,
        reason: &str,
    ) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
        let live_tasks = get_tasks_map()
            .iter()
            .filter(|entry| {
                entry
                    .causal_route
                    .as_ref()
                    .is_some_and(|route| route.activation_id == activation_id)
            })
            .map(|entry| (entry.id.clone(), entry.pgid))
            .collect::<Vec<_>>();
        let mut targeted = 0usize;
        for (task_id, pgid) in live_tasks {
            if let (Some(manager), Some(mut job)) = (
                self.execution_jobs.as_ref(),
                self.get_background_job(&task_id).await?,
            ) {
                for _ in 0..8 {
                    if job.status.is_terminal() || job.cancel_requested_at.is_some() {
                        break;
                    }
                    match manager
                        .request_cancel(&job.id, job.revision, Some(reason))
                        .await?
                    {
                        JobReceipt::Applied { job: current, .. }
                        | JobReceipt::Existing { job: current, .. }
                        | JobReceipt::Conflict { current, .. } => job = current,
                        JobReceipt::Rejected { .. } => break,
                        JobReceipt::NotFound { .. } => break,
                    }
                }
            }
            if let Some(mut task) = get_tasks_map().get_mut(&task_id) {
                task.status = BackgroundTaskStatus::KillRequested;
                task.wake_generation = task.wake_generation.wrapping_add(1);
                task.next_wakeup_at = None;
            }
            self.cancel(&task_id).await;
            match nix::sys::signal::killpg(
                nix::unistd::Pid::from_raw(pgid),
                nix::sys::signal::Signal::SIGKILL,
            ) {
                Ok(()) | Err(nix::errno::Errno::ESRCH) => {
                    targeted = targeted.saturating_add(1);
                }
                Err(error) => {
                    return Err(format!(
                        "Activation '{}' 的进程组 {} 终止失败: {}；取消意图仍保持持久化",
                        activation_id, pgid, error
                    )
                    .into());
                }
            }
        }
        Ok(targeted)
    }

    pub fn register_timer_handler(
        self: &Arc<Self>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let scheduler = Arc::downgrade(self);
        self.timers
            .register_handler(RuntimeTimerKind::BackgroundWake, move |timer| {
                let scheduler = scheduler.clone();
                async move {
                    let Some(scheduler) = scheduler.upgrade() else {
                        return Ok(TimerDisposition::Complete);
                    };
                    scheduler.dispatch_timer(timer).await
                }
            })
    }

    async fn schedule(
        &self,
        task_id: &str,
        check_after_secs: u64,
        wake_source: &str,
    ) -> Result<chrono::DateTime<chrono::Utc>, String> {
        if !(1..=MAX_TASK_WAIT_SECS).contains(&check_after_secs) {
            return Err(format!(
                "check_after_secs 必须在 1 到 {MAX_TASK_WAIT_SECS} 秒之间"
            ));
        }
        if self.execution_jobs.is_some() {
            let job = self
                .get_background_job(task_id)
                .await
                .map_err(|error| error.to_string())?
                .ok_or_else(|| format!("未找到后台 ExecutionJob '{task_id}'"))?;
            if job.status.is_terminal() {
                return Err(format!(
                    "后台任务 '{task_id}' 已经以 {} 结束，无需继续等待",
                    job.status.as_str()
                ));
            }
        }
        let (generation, wakeup_at) = {
            let tasks = get_tasks_map();
            let mut task = tasks
                .get_mut(task_id)
                .ok_or_else(|| format!("未找到后台任务 '{task_id}'，它可能已被历史保留策略清理"))?;
            if task.status.is_terminal() {
                return Err(format!("后台任务 '{task_id}' 已经结束，无需继续等待"));
            }
            task.wake_generation = task.wake_generation.wrapping_add(1);
            let generation = task.wake_generation;
            let wakeup_at = chrono::Utc::now()
                + chrono::Duration::seconds(i64::try_from(check_after_secs).unwrap_or(i64::MAX));
            task.next_wakeup_at = Some(wakeup_at);
            (generation, wakeup_at)
        };
        if let Err(error) = self
            .timers
            .schedule(NewRuntimeTimer {
                id: background_wake_timer_id(task_id),
                generation,
                kind: RuntimeTimerKind::BackgroundWake,
                owner_id: task_id.to_string(),
                due_at: wakeup_at,
                payload: serde_json::json!({
                    "task_id": task_id,
                    "generation": generation,
                    "check_after_secs": check_after_secs,
                    "wake_source": wake_source,
                }),
            })
            .await
        {
            if let Some(mut task) = get_tasks_map().get_mut(task_id) {
                if task.wake_generation == generation {
                    task.next_wakeup_at = None;
                }
            }
            return Err(format!("持久化后台任务唤醒失败: {error}"));
        }
        Ok(wakeup_at)
    }

    pub async fn cancel(&self, task_id: &str) {
        if let Err(error) = self.timers.cancel(&background_wake_timer_id(task_id)).await {
            tracing::warn!(task_id, %error, "取消后台任务唤醒 Timer 失败");
        }
    }

    async fn dispatch_timer(
        self: Arc<Self>,
        timer: RuntimeTimerRecord,
    ) -> Result<TimerDisposition, Box<dyn std::error::Error + Send + Sync>> {
        let generation = timer
            .payload
            .get("generation")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(timer.generation);
        let check_after_secs = timer
            .payload
            .get("check_after_secs")
            .or_else(|| timer.payload.get("wait_secs"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or_default();
        let wake_source = timer
            .payload
            .get("wake_source")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("runtime");
        let authoritative_job = if self.execution_jobs.is_some() {
            let Some(job) = self.get_background_job(&timer.owner_id).await? else {
                return Ok(TimerDisposition::Complete);
            };
            if job.status.is_terminal() {
                return Ok(TimerDisposition::Complete);
            }
            Some(job)
        } else {
            None
        };
        let mut payload = {
            let tasks = get_tasks_map();
            let Some(mut task) = tasks.get_mut(&timer.owner_id) else {
                return Ok(TimerDisposition::Complete);
            };
            if task.status.is_terminal() || task.wake_generation != generation {
                return Ok(TimerDisposition::Complete);
            }
            if task
                .next_wakeup_at
                .is_some_and(|due| due > chrono::Utc::now())
            {
                return Ok(TimerDisposition::Reschedule {
                    due_at: task.next_wakeup_at.expect("checked Some"),
                    reason: Some("后台任务检查点尚未到期".to_string()),
                });
            }
            task.next_wakeup_at = None;
            background_check_due_payload(&task, check_after_secs, wake_source)
        };
        if let Some(job) = authoritative_job {
            payload.insert(
                "task_status".to_string(),
                serde_json::json!(if job.cancel_requested_at.is_some() {
                    "cancel_requested"
                } else {
                    job.status.as_str()
                }),
            );
            payload.insert("execution_job_id".to_string(), serde_json::json!(job.id));
            payload.insert(
                "execution_job_revision".to_string(),
                serde_json::json!(job.revision),
            );
        }
        let event = Event::new(
            format!("task_check_due_{}_g{}", timer.owner_id, generation),
            "System-TaskMonitor".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            payload,
        );
        self.events.append_with_signal_outbox(event.clone()).await?;
        self.bus.dispatch_persisted(event).await?;
        Ok(TimerDisposition::Complete)
    }
}

fn applied_background_job(
    receipt: JobReceipt,
    operation: &str,
) -> Result<ExecutionJobRecord, Box<dyn std::error::Error + Send + Sync>> {
    match receipt {
        JobReceipt::Applied { job, .. } | JobReceipt::Existing { job, .. } => Ok(job),
        JobReceipt::Conflict { current, .. } => Err(format!(
            "后台 ExecutionJob {} {} 发生 revision 冲突（当前 r{}）",
            current.id, operation, current.revision
        )
        .into()),
        JobReceipt::Rejected {
            current, reason, ..
        } => Err(format!(
            "后台 ExecutionJob {} {} 被拒绝：{}",
            current.id, operation, reason
        )
        .into()),
        JobReceipt::NotFound { .. } => {
            Err(format!("后台 ExecutionJob {operation} 时不存在").into())
        }
    }
}

fn background_wake_timer_id(task_id: &str) -> String {
    format!("background-wake:{task_id}")
}

/// Durable timer and dependency dispatcher for schedule_tx. Timers are only
/// wake sources: when they become due they append one directed observation to
/// the target Thread mailbox. They never run model logic themselves.
pub struct ThreadScheduler {
    bus: Arc<InMemoryEventBus>,
    sessions: Arc<dyn SessionStore>,
    events: Arc<dyn EventStore>,
    timers: Arc<TimerEngine>,
}

impl ThreadScheduler {
    pub fn new(
        bus: Arc<InMemoryEventBus>,
        sessions: Arc<dyn SessionStore>,
        events: Arc<dyn EventStore>,
        timers: Arc<TimerEngine>,
    ) -> Self {
        Self {
            bus,
            sessions,
            events,
            timers,
        }
    }

    pub fn register_timer_handler(
        self: &Arc<Self>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let scheduler = Arc::downgrade(self);
        self.timers
            .register_handler(RuntimeTimerKind::Schedule, move |timer| {
                let scheduler = scheduler.clone();
                async move {
                    let Some(scheduler) = scheduler.upgrade() else {
                        return Ok(TimerDisposition::Complete);
                    };
                    scheduler.dispatch_timer(timer).await
                }
            })
    }

    pub async fn recover(self: &Arc<Self>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let schedules = self.sessions.list_schedules(None, None).await?;
        let queued = schedules
            .iter()
            .filter(|intent| intent.status == ScheduleStatus::Queued)
            .cloned()
            .collect::<Vec<_>>();
        // The owner row is authoritative. A crash may happen after pause or
        // cancel commits but before its timer is cancelled; proactively clean
        // those generations before the Timer Engine starts. A timer which was
        // already claimed is still harmless because dispatch_timer fences on
        // both owner status and revision.
        for intent in schedules
            .iter()
            .filter(|intent| intent.status != ScheduleStatus::Queued)
        {
            self.timers.cancel(&schedule_timer_id(&intent.id)).await?;
        }
        // Close the crash window between a dependency Thread's terminal
        // commit and its in-process notification. Replaying terminal
        // dependency IDs through the persistent reverse index advances owner
        // revisions, so a previously-fired blocked generation can be armed
        // again without fixed polling.
        let mut replayed_dependencies = BTreeSet::new();
        for dependency_id in queued
            .iter()
            .flat_map(|intent| intent.dependency_thread_ids.iter())
        {
            if replayed_dependencies.contains(dependency_id) {
                continue;
            }
            if self
                .sessions
                .get_thread(dependency_id)
                .await?
                .is_some_and(|thread| thread.lifecycle.is_terminal())
            {
                replayed_dependencies.insert(dependency_id.clone());
                self.dependency_completed(dependency_id).await?;
            }
        }
        for intent in self
            .sessions
            .list_schedules(None, Some(ScheduleStatus::Queued))
            .await?
        {
            self.arm(intent).await?;
        }
        // A crash may happen after the schedule occurrence and its wake Event
        // commit atomically but before in-process dispatch. Re-dispatch is safe:
        // trigger_event_id is unique and Thread Activation claiming is idempotent.
        for event in self
            .events
            .query(QueryFilter {
                topic: Some("chat/schedule_due".to_string()),
                ..Default::default()
            })
            .await?
        {
            let root_turn_id = event
                .payload
                .get("root_turn_id")
                .and_then(|value| value.as_str());
            let terminal = match root_turn_id {
                Some(root) => self
                    .sessions
                    .get_thread_by_root(root)
                    .await?
                    .is_some_and(|thread| thread.lifecycle.is_terminal()),
                None => true,
            };
            if !terminal {
                self.events.append_with_signal_outbox(event.clone()).await?;
                self.bus.dispatch_persisted(event).await?;
            }
        }
        Ok(())
    }

    pub async fn inspect(
        &self,
        id: &str,
    ) -> Result<Option<ScheduleRecord>, Box<dyn std::error::Error + Send + Sync>> {
        self.sessions.inspect_schedule(id).await
    }

    pub async fn pause(
        &self,
        id: &str,
        expected_revision: u64,
    ) -> Result<ScheduleMutation, Box<dyn std::error::Error + Send + Sync>> {
        let mutation = self.sessions.pause_schedule(id, expected_revision).await?;
        self.reconcile_control_mutation(&mutation).await?;
        Ok(mutation)
    }

    pub async fn resume(
        &self,
        id: &str,
        expected_revision: u64,
    ) -> Result<ScheduleMutation, Box<dyn std::error::Error + Send + Sync>> {
        let mutation = self.sessions.resume_schedule(id, expected_revision).await?;
        self.reconcile_control_mutation(&mutation).await?;
        Ok(mutation)
    }

    pub async fn reschedule(
        &self,
        id: &str,
        expected_revision: u64,
        not_before: Option<chrono::DateTime<chrono::Utc>>,
        interval_seconds: Option<u64>,
    ) -> Result<ScheduleMutation, Box<dyn std::error::Error + Send + Sync>> {
        let mutation = self
            .sessions
            .reschedule_schedule(id, expected_revision, not_before, interval_seconds)
            .await?;
        self.reconcile_control_mutation(&mutation).await?;
        Ok(mutation)
    }

    pub async fn cancel(
        &self,
        id: &str,
        expected_revision: u64,
    ) -> Result<ScheduleMutation, Box<dyn std::error::Error + Send + Sync>> {
        let mutation = self.sessions.cancel_schedule(id, expected_revision).await?;
        self.reconcile_control_mutation(&mutation).await?;
        Ok(mutation)
    }

    async fn reconcile_control_mutation(
        &self,
        mutation: &ScheduleMutation,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let ScheduleMutation::Updated(intent) = mutation else {
            return Ok(());
        };
        if intent.status == ScheduleStatus::Queued {
            self.arm(intent.clone()).await?;
        } else {
            self.timers.cancel(&schedule_timer_id(&intent.id)).await?;
        }
        Ok(())
    }

    pub async fn arm(
        &self,
        intent: ScheduleRecord,
    ) -> Result<RuntimeTimerRecord, Box<dyn std::error::Error + Send + Sync>> {
        let due_at = intent.not_before.unwrap_or_else(chrono::Utc::now);
        self.timers
            .schedule(NewRuntimeTimer {
                id: schedule_timer_id(&intent.id),
                generation: intent.revision,
                kind: RuntimeTimerKind::Schedule,
                owner_id: intent.id.clone(),
                due_at,
                payload: serde_json::json!({
                    "schedule_id": intent.id,
                    "revision": intent.revision,
                }),
            })
            .await
    }

    /// Event-driven dependency wake. The store uses a persistent reverse index
    /// and advances each matching owner revision before a new timer generation
    /// is armed, so an already-claimed stale timer cannot win the race.
    pub async fn dependency_completed(
        &self,
        dependency_thread_id: &str,
    ) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
        let intents = self
            .sessions
            .wake_schedules_for_dependency(dependency_thread_id)
            .await?;
        let count = intents.len();
        for intent in intents {
            self.arm(intent).await?;
        }
        Ok(count)
    }

    async fn dispatch_timer(
        self: Arc<Self>,
        timer: RuntimeTimerRecord,
    ) -> Result<TimerDisposition, Box<dyn std::error::Error + Send + Sync>> {
        let Some(current) = self.sessions.get_schedule(&timer.owner_id).await? else {
            return Ok(TimerDisposition::Complete);
        };
        if current.status != ScheduleStatus::Queued || current.revision != timer.generation {
            if current.status == ScheduleStatus::Queued {
                self.arm(current).await?;
            }
            return Ok(TimerDisposition::Complete);
        }
        if let Some(not_before) = current.not_before {
            if not_before > chrono::Utc::now() {
                return Ok(TimerDisposition::Reschedule {
                    due_at: not_before,
                    reason: Some("Schedule 尚未到达 not_before".to_string()),
                });
            }
        }

        let mut dependency_states = serde_json::Map::new();
        let mut dependencies_ready = true;
        for dependency_id in &current.dependency_thread_ids {
            let state = self.sessions.get_thread(dependency_id).await?;
            let status = state
                .as_ref()
                .map(|thread| thread.lifecycle.as_str())
                .unwrap_or("missing");
            dependency_states.insert(dependency_id.clone(), serde_json::json!(status));
            dependencies_ready &= state.is_some_and(|thread| thread.lifecycle.is_terminal());
        }
        if !dependencies_ready {
            // The persistent reverse dependency index will arm a newer owner
            // generation when any missing dependency becomes terminal. This
            // generation is finished instead of polling every few seconds.
            return Ok(TimerDisposition::Complete);
        }

        let occurrence_revision = current.revision;
        let next_not_before = current.interval_seconds.map(|seconds| {
            chrono::Utc::now()
                + chrono::Duration::seconds(i64::try_from(seconds).unwrap_or(i64::MAX))
        });
        let owner = self
            .sessions
            .get_thread(&current.thread_id)
            .await?
            .ok_or_else(|| format!("Schedule '{}' 的目标 Thread 不存在", current.id))?;
        let root_turn_id = if current.interval_seconds.is_some() {
            scheduled_occurrence_root(&current.id, occurrence_revision)
        } else {
            owner.root_turn_id.clone()
        };
        let event_id = format!("schedule_due_{}_r{}", current.id, occurrence_revision);
        let payload = serde_json::Map::from_iter([
            ("agent_id".to_string(), serde_json::json!(owner.agent_id)),
            (
                "context_id".to_string(),
                serde_json::json!(owner.context_id),
            ),
            (
                "session_id".to_string(),
                serde_json::json!(owner.session_id),
            ),
            (
                "principal_id".to_string(),
                serde_json::json!(owner.initiating_principal_id),
            ),
            ("root_turn_id".to_string(), serde_json::json!(root_turn_id)),
            ("schedule_id".to_string(), serde_json::json!(current.id)),
            (
                "scheduled_thread_id".to_string(),
                serde_json::json!(current.thread_id),
            ),
            (
                "source_turn_id".to_string(),
                serde_json::json!(current.source_turn_id),
            ),
            ("intent".to_string(), serde_json::json!(current.intent)),
            (
                "occurrence_revision".to_string(),
                serde_json::json!(occurrence_revision),
            ),
            (
                "dependency_states".to_string(),
                serde_json::Value::Object(dependency_states),
            ),
            (
                "interval_seconds".to_string(),
                serde_json::json!(current.interval_seconds),
            ),
            (
                "text".to_string(),
                serde_json::json!(format!("SCHEDULE_DUE: {}\n{}", current.id, current.intent)),
            ),
        ]);
        let event = Event::new(
            event_id,
            "Runtime-Scheduler".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/schedule_due".to_string(),
            payload,
        );
        let Some(claimed) = self
            .sessions
            .commit_scheduled_dispatch(&current.id, current.revision, next_not_before, &event)
            .await?
        else {
            return Ok(TimerDisposition::Complete);
        };
        self.bus.dispatch_persisted(event).await?;
        if claimed.status == ScheduleStatus::Queued {
            self.arm(claimed).await?;
        }
        Ok(TimerDisposition::Complete)
    }
}

fn schedule_timer_id(schedule_id: &str) -> String {
    format!("schedule:{schedule_id}")
}

pub struct ScheduleTxTool {
    scheduler: Arc<ThreadScheduler>,
    sessions: Arc<dyn SessionStore>,
    objectives: Option<Arc<dyn ObjectiveStore>>,
}

impl ScheduleTxTool {
    pub fn new(scheduler: Arc<ThreadScheduler>, sessions: Arc<dyn SessionStore>) -> Self {
        Self {
            scheduler,
            sessions,
            objectives: None,
        }
    }

    pub fn with_objective_store(mut self, objectives: Arc<dyn ObjectiveStore>) -> Self {
        self.objectives = Some(objectives);
        self
    }

    async fn execute_control(
        &self,
        operation: ScheduleOperation,
        context_id: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let schedule_id = match &operation {
            ScheduleOperation::Inspect { schedule_id }
            | ScheduleOperation::Pause { schedule_id, .. }
            | ScheduleOperation::Resume { schedule_id, .. }
            | ScheduleOperation::Reschedule { schedule_id, .. }
            | ScheduleOperation::Cancel { schedule_id, .. } => schedule_id,
            ScheduleOperation::Enqueue { .. }
            | ScheduleOperation::Spawn { .. }
            | ScheduleOperation::Promote { .. } => {
                return Err("内部错误：创建操作不能进入 Schedule 控制面".into());
            }
        };
        if schedule_id.trim().is_empty() {
            return Err("schedule_id 不能为空".into());
        }
        let inspected = self.scheduler.inspect(schedule_id).await?;
        if let Some(intent) = &inspected {
            let target = self
                .sessions
                .get_thread(&intent.thread_id)
                .await?
                .ok_or_else(|| format!("Schedule '{}' 的目标 Thread 不存在", intent.id))?;
            if target.context_id != context_id {
                return Err("不能检查或修改其他 Context 的 Schedule".into());
            }
        }

        let (operation_name, mutation) = match operation {
            ScheduleOperation::Inspect { .. } => {
                return Ok(serde_json::json!({
                    "status": if inspected.is_some() { "ok" } else { "not_found" },
                    "operation": "inspect",
                    "schedule": inspected,
                    "guidance": "后续修改必须提交这里返回的当前 revision；Runtime 会拒绝过期 revision。"
                })
                .to_string());
            }
            ScheduleOperation::Pause {
                schedule_id,
                expected_revision,
            } => (
                "pause",
                self.scheduler
                    .pause(&schedule_id, expected_revision)
                    .await?,
            ),
            ScheduleOperation::Resume {
                schedule_id,
                expected_revision,
            } => (
                "resume",
                self.scheduler
                    .resume(&schedule_id, expected_revision)
                    .await?,
            ),
            ScheduleOperation::Reschedule {
                schedule_id,
                expected_revision,
                not_before,
                delay_seconds,
                every_seconds,
            } => {
                if not_before.is_some() && delay_seconds.is_some() {
                    return Err("not_before 与 delay_seconds 只能提供一个".into());
                }
                let due_at = schedule_due_at(not_before.as_deref(), delay_seconds)?;
                (
                    "reschedule",
                    self.scheduler
                        .reschedule(&schedule_id, expected_revision, due_at, every_seconds)
                        .await?,
                )
            }
            ScheduleOperation::Cancel {
                schedule_id,
                expected_revision,
            } => (
                "cancel",
                self.scheduler
                    .cancel(&schedule_id, expected_revision)
                    .await?,
            ),
            ScheduleOperation::Enqueue { .. }
            | ScheduleOperation::Spawn { .. }
            | ScheduleOperation::Promote { .. } => unreachable!(),
        };
        Ok(schedule_mutation_receipt(operation_name, mutation).to_string())
    }

    async fn execute_promotion(
        &self,
        thread_id: String,
        expected_revision: u64,
        objective_binding: ScheduleObjectiveBinding,
        attempt_id: &str,
        context_id: &str,
        session_id: &str,
        route: &ToolCausalRoute,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let target = self
            .sessions
            .get_thread(&thread_id)
            .await?
            .ok_or_else(|| format!("待升格 Thread '{thread_id}' 不存在"))?;
        if target.context_id != context_id || target.session_id != session_id {
            return Err("只能升格当前 Context/Session 中的 attached Thread".into());
        }
        if target.lifecycle != ThreadLifecycle::Open
            || target.supervision.lifetime != ThreadLifetime::Attached
            || target.supervision.supervisor_kind != ThreadSupervisorKind::Evaluation
        {
            return Err("只有仍 open、由当前 Evaluation 监督的 attached Thread 可以升格".into());
        }
        if target.supervision.supervisor_id.as_deref() != Some(route.activation_id.as_str())
            || target.supervision.origin_evaluation_id.as_deref()
                != Some(route.activation_id.as_str())
        {
            return Err("不能升格其他 Evaluation 拥有的 attached Thread".into());
        }
        let source_group_id = target
            .supervision
            .thread_group_id
            .clone()
            .ok_or("attached Thread 缺少源 Thread Group，不能安全转移监督权")?;
        let objectives = self
            .objectives
            .as_ref()
            .ok_or("当前 Runtime 未配置 Objective Store，不能升格 durable Thread")?;

        let (objective_id, expected_objective_revision, new_objective_spec, completion_criteria) =
            match objective_binding {
                ScheduleObjectiveBinding::Current => {
                    let objective_id = CURRENT_OBJECTIVE_ID
                        .try_with(Clone::clone)
                        .ok()
                        .flatten()
                        .ok_or(
                        "当前 Evaluation 未绑定 Objective，不能使用 objective.mode=current",
                    )?;
                    let objective = objectives
                        .get_objective(&objective_id)
                        .await?
                        .ok_or_else(|| format!("Objective '{objective_id}' 不存在"))?;
                    validate_promotion_objective(&objective, &target)?;
                    (
                        objective_id,
                        Some(objective.revision),
                        None,
                        objective.stated_objective,
                    )
                }
                ScheduleObjectiveBinding::Existing { objective_id } => {
                    let objective_id = objective_id.trim().to_string();
                    if objective_id.is_empty() {
                        return Err("objective_id 不能为空".into());
                    }
                    let objective = objectives
                        .get_objective(&objective_id)
                        .await?
                        .ok_or_else(|| format!("Objective '{objective_id}' 不存在"))?;
                    validate_promotion_objective(&objective, &target)?;
                    (
                        objective_id,
                        Some(objective.revision),
                        None,
                        objective.stated_objective,
                    )
                }
                ScheduleObjectiveBinding::Create {
                    stated_objective,
                    completion_criteria,
                    token_budget,
                } => {
                    let stated_objective = stated_objective.trim().to_string();
                    let completion_criteria = completion_criteria.trim().to_string();
                    if stated_objective.is_empty() || completion_criteria.is_empty() {
                        return Err("objective.mode=create 必须提供非空目标与完成标准".into());
                    }
                    let digest = sha256_hex(
                    format!(
                        "{attempt_id}\0thread-promote\0{thread_id}\0{stated_objective}\0{completion_criteria}\0{token_budget:?}"
                    )
                    .as_bytes(),
                );
                    let objective_id = format!("objective-auto-{}", &digest[..24]);
                    (
                        objective_id,
                        None,
                        Some((stated_objective, completion_criteria.clone(), token_budget)),
                        completion_criteria,
                    )
                }
            };

        // A supervision transfer creates a new fencing epoch even when the
        // target Objective itself is still at revision 1.
        let target_generation = target.supervision.generation.saturating_add(1).max(2);
        let group_digest = sha256_hex(
            format!(
                "{attempt_id}\0thread-promotion-group\0{thread_id}\0{objective_id}\0{target_generation}"
            )
            .as_bytes(),
        );
        let target_group_id = format!("thread_group_{}", &group_digest[..24]);
        let target_group = NewThreadGroupPlan {
            group: NewThreadGroup {
                id: target_group_id.clone(),
                context_id: context_id.to_string(),
                session_id: session_id.to_string(),
                supervisor_kind: ThreadSupervisorKind::Objective,
                supervisor_id: objective_id.clone(),
                generation: target_generation,
                policy: ThreadGroupPolicy::All,
                completion_contract: target.supervision.completion_contract.clone(),
            },
            members: vec![NewThreadGroupMember {
                thread_id: thread_id.clone(),
                ordinal: 0,
                required: true,
            }],
        };
        let new_objective = new_objective_spec.map(
            |(stated_objective, new_completion_criteria, token_budget)| {
                let source_event_id = format!("objective_promoted_{objective_id}");
                let initial_wait_condition = ObjectiveWaitCondition::ThreadGroup {
                    group_id: target_group_id.clone(),
                };
                NewScheduledObjective {
                    objective: NewObjective {
                        id: objective_id.clone(),
                        agent_id: target.agent_id.clone(),
                        context_id: target.context_id.clone(),
                        coordinator_session_id: target.session_id.clone(),
                        delivery_session_id: target.session_id.clone(),
                        parent_objective_id: None,
                        source_event_id: source_event_id.clone(),
                        initiating_principal_id: target.initiating_principal_id.clone(),
                        stated_objective: stated_objective.clone(),
                        token_budget,
                    },
                    initial_wait_condition: initial_wait_condition.clone(),
                    status_reason: format!(
                        "接管已运行的 attached Thread；验收标准：{new_completion_criteria}"
                    ),
                    created_event: Event::new(
                        source_event_id,
                        "Agent-Morphz".to_string(),
                        TYPE_OBJECTIVE_CONTROL.to_string(),
                        "objective/promoted_created".to_string(),
                        serde_json::json!({
                            "objective_id": objective_id,
                            "agent_id": target.agent_id,
                            "context_id": target.context_id,
                            "session_id": target.session_id,
                            "source_evaluation_id": attempt_id,
                            "source_thread_id": route.thread_id,
                            "promoted_thread_id": thread_id,
                            "stated_objective": stated_objective,
                            "completion_criteria": new_completion_criteria,
                            "token_budget": token_budget,
                            "initial_wait_condition": initial_wait_condition,
                        })
                        .as_object()
                        .expect("promotion objective event payload")
                        .clone(),
                    ),
                }
            },
        );
        let promotion_digest = sha256_hex(
            format!(
                "{attempt_id}\0thread-promote-event\0{thread_id}\0{objective_id}\0{expected_revision}"
            )
            .as_bytes(),
        );
        let promoted_event = Event::new(
            format!("thread_promoted_{}", &promotion_digest[..24]),
            "Agent-Morphz".to_string(),
            TYPE_OBJECTIVE_CONTROL.to_string(),
            "runtime/thread_promoted".to_string(),
            serde_json::json!({
                "agent_id": target.agent_id,
                "context_id": context_id,
                "session_id": session_id,
                "thread_id": thread_id,
                "root_turn_id": target.root_turn_id,
                "activation_id": route.activation_id,
                "source_evaluation_id": attempt_id,
                "source_group_id": source_group_id,
                "objective_id": objective_id,
                "target_group_id": target_group_id,
                "target_generation": target_generation,
                "completion_criteria": completion_criteria,
                "text": format!(
                    "Thread '{}' 已由当前 Evaluation 原子移交给 Objective '{}'",
                    thread_id, objective_id
                ),
            })
            .as_object()
            .expect("thread promotion event payload")
            .clone(),
        );
        let mutation = self
            .sessions
            .promote_attached_thread(ThreadPromotionRequest {
                thread_id,
                expected_thread_revision: expected_revision,
                source_group_id,
                objective_id,
                expected_objective_revision,
                new_objective,
                target_group,
                promoted_event,
            })
            .await?;
        Ok(thread_promotion_receipt(mutation).to_string())
    }
}

fn schedule_mutation_receipt(operation: &str, mutation: ScheduleMutation) -> serde_json::Value {
    match mutation {
        ScheduleMutation::Updated(schedule) => serde_json::json!({
            "status": "updated",
            "operation": operation,
            "schedule": schedule,
            "guidance": "Schedule 与对应 Timer generation 已按同一个 revision 收口。"
        }),
        ScheduleMutation::Conflict { current } => serde_json::json!({
            "status": "conflict",
            "operation": operation,
            "schedule": current,
            "guidance": "提交的 expected_revision 已过期；请依据返回的当前状态重新决策，不要盲目重试旧请求。"
        }),
        ScheduleMutation::Rejected { current, reason } => serde_json::json!({
            "status": "rejected",
            "operation": operation,
            "schedule": current,
            "reason": reason
        }),
        ScheduleMutation::NotFound => serde_json::json!({
            "status": "not_found",
            "operation": operation
        }),
    }
}

fn validate_promotion_objective(
    objective: &crate::memory::ObjectiveRecord,
    thread: &crate::memory::ThreadRecord,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if objective.agent_id != thread.agent_id
        || objective.context_id != thread.context_id
        || objective.coordinator_session_id != thread.session_id
        || objective.status != ObjectiveStatus::Active
    {
        return Err(format!(
            "Objective '{}' 不是当前 Agent/Context/Session 中的 active Objective",
            objective.id
        )
        .into());
    }
    if objective.wait_condition.is_some() {
        return Err(format!(
            "Objective '{}' 已有等待条件，不能再接管另一个独立 Thread Group",
            objective.id
        )
        .into());
    }
    Ok(())
}

fn thread_promotion_receipt(mutation: ThreadPromotionMutation) -> serde_json::Value {
    match mutation {
        ThreadPromotionMutation::Updated(record) => serde_json::json!({
            "status": "updated",
            "operation": "promote",
            "thread": record.thread,
            "objective": record.objective,
            "source_group": record.source_group,
            "target_group": record.target_group,
            "guidance": "同一 Thread 已转为 durable；原 Evaluation barrier 已释放，后续终态由 Objective Group 验收。不要为同一工作再创建重复 Thread。"
        }),
        ThreadPromotionMutation::Conflict {
            current_thread,
            current_objective,
        } => serde_json::json!({
            "status": "conflict",
            "operation": "promote",
            "thread": current_thread,
            "objective": current_objective,
            "guidance": "Thread 或 Objective revision 已变化；请依据当前状态重新决策，不要盲目重试旧升格请求。"
        }),
        ThreadPromotionMutation::Rejected {
            current_thread,
            reason,
        } => serde_json::json!({
            "status": "rejected",
            "operation": "promote",
            "thread": current_thread,
            "reason": reason
        }),
        ThreadPromotionMutation::NotFound => serde_json::json!({
            "status": "not_found",
            "operation": "promote"
        }),
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScheduleTxArgs {
    operations: Vec<ScheduleOperation>,
    #[serde(default)]
    group: Option<ScheduleGroupArgs>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScheduleGroupArgs {
    #[serde(default = "default_thread_group_policy")]
    policy: ThreadGroupPolicy,
    #[serde(default)]
    completion_contract: serde_json::Value,
}

fn default_thread_group_policy() -> ThreadGroupPolicy {
    ThreadGroupPolicy::All
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
enum ScheduleObjectiveBinding {
    Current,
    Existing {
        objective_id: String,
    },
    Create {
        stated_objective: String,
        completion_criteria: String,
        #[serde(default)]
        token_budget: Option<u64>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScheduleCompletionArgs {
    #[serde(default = "default_required_thread")]
    required: bool,
    #[serde(default)]
    contract: serde_json::Value,
}

fn default_required_thread() -> bool {
    true
}

impl Default for ScheduleCompletionArgs {
    fn default() -> Self {
        Self {
            required: true,
            contract: serde_json::Value::Object(Default::default()),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum ScheduleOperation {
    Enqueue {
        #[serde(default)]
        thread_id: Option<String>,
        intent: String,
        #[serde(default)]
        not_before: Option<String>,
        #[serde(default)]
        delay_seconds: Option<u64>,
        #[serde(default)]
        after: Vec<String>,
    },
    Spawn {
        #[serde(default)]
        client_id: Option<String>,
        intent: String,
        #[serde(default)]
        not_before: Option<String>,
        #[serde(default)]
        delay_seconds: Option<u64>,
        #[serde(default)]
        every_seconds: Option<u64>,
        #[serde(default)]
        after: Vec<String>,
        #[serde(default)]
        target: Option<String>,
        lifetime: ThreadLifetime,
        #[serde(default)]
        objective: Option<ScheduleObjectiveBinding>,
        #[serde(default)]
        completion: ScheduleCompletionArgs,
    },
    /// Transfer an already-running attached Thread from the current
    /// Evaluation to a durable Objective without starting duplicate work.
    Promote {
        thread_id: String,
        expected_revision: u64,
        objective: ScheduleObjectiveBinding,
    },
    Inspect {
        schedule_id: String,
    },
    Pause {
        schedule_id: String,
        expected_revision: u64,
    },
    Resume {
        schedule_id: String,
        expected_revision: u64,
    },
    Reschedule {
        schedule_id: String,
        expected_revision: u64,
        #[serde(default)]
        not_before: Option<String>,
        #[serde(default)]
        delay_seconds: Option<u64>,
        #[serde(default)]
        every_seconds: Option<u64>,
    },
    Cancel {
        schedule_id: String,
        expected_revision: u64,
    },
}

impl ScheduleOperation {
    fn is_control(&self) -> bool {
        matches!(
            self,
            Self::Inspect { .. }
                | Self::Pause { .. }
                | Self::Resume { .. }
                | Self::Reschedule { .. }
                | Self::Cancel { .. }
        )
    }

    fn is_promotion(&self) -> bool {
        matches!(self, Self::Promote { .. })
    }
}

fn schedule_objective_binding_schema() -> serde_json::Value {
    serde_json::json!({
        "oneOf": [
            {
                "type": "object",
                "properties": {"mode": {"const": "current"}},
                "required": ["mode"],
                "additionalProperties": false
            },
            {
                "type": "object",
                "properties": {
                    "mode": {"const": "existing"},
                    "objective_id": {"type": "string"}
                },
                "required": ["mode", "objective_id"],
                "additionalProperties": false
            },
            {
                "type": "object",
                "properties": {
                    "mode": {"const": "create"},
                    "stated_objective": {"type": "string", "description": "拥有独立暂停、恢复、取消和验收生命周期的新目标"},
                    "completion_criteria": {"type": "string", "description": "新 Objective 的明确完成标准"},
                    "token_budget": {"type": "integer", "minimum": 1}
                },
                "required": ["mode", "stated_objective", "completion_criteria"],
                "additionalProperties": false
            }
        ]
    })
}

fn schedule_promote_operation_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "op": {"const": "promote"},
            "thread_id": {"type": "string", "description": "当前 Evaluation 拥有的 open attached Thread"},
            "expected_revision": {"type": "integer", "minimum": 1, "description": "创建/检查 Thread 时返回的 revision；过期值会返回 conflict"},
            "objective": schedule_objective_binding_schema()
        },
        "required": ["op", "thread_id", "expected_revision", "objective"],
        "additionalProperties": false
    })
}

#[async_trait::async_trait]
impl Tool for ScheduleTxTool {
    fn name(&self) -> &str {
        "schedule_tx"
    }

    fn execution_class(&self) -> ToolExecutionClass {
        ToolExecutionClass::LogicalInline
    }

    fn definition(&self) -> ToolDefinition {
        let objective_binding_schema = schedule_objective_binding_schema();
        let promote_operation_schema = schedule_promote_operation_schema();
        ToolDefinition {
            name: self.name().to_string(),
            description: "创建或控制受监督 Thread 调度计划。spawn 必须声明 lifetime：attached 由当前 Evaluation 检查，durable 必须绑定 current/existing/create Objective，disposable 是不保证恢复或交付的尽力执行；多个 sibling 可用 group(all|any) 形成一次权威 barrier。promote 可把当前 Evaluation 已启动的 attached Thread 原子移交给 current/existing/create Objective，不会重复启动工作。objective.mode=create 会把独立 Objective、初始等待、Thread、Group 与 Schedule 原子提交。enqueue/spawn 可原子批量创建；promote 与 inspect/pause/resume/reschedule/cancel 必须单独提交，并使用 expected_revision 防止过期写。not_before 或 delay_seconds 设置时间，every_seconds 设置周期；after 指定依赖 Thread。schedule_tx 必须是本次响应中唯一的工具调用。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "operations": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": MAX_SCHEDULE_OPERATIONS,
                        "description": "按数组顺序原子提交的调度操作",
                        "items": {
                            "oneOf": [
                                {
                                    "type": "object",
                                    "properties": {
                                        "op": {"const": "enqueue"},
                                        "thread_id": {"type": "string", "description": "目标 Thread ID；省略时为当前 Thread"},
                                        "intent": {"type": "string", "description": "Thread 被唤醒后需要执行的自然语言意图"},
                                        "not_before": {"type": "string", "description": "RFC 3339 绝对时间"},
                                        "delay_seconds": {"type": "integer", "minimum": 0},
                                        "after": {"type": "array", "items": {"type": "string"}, "description": "依赖 Thread ID，或同一事务中 spawn 的 $client_id"}
                                    },
                                    "required": ["op", "intent"],
                                    "additionalProperties": false
                                },
                                {
                                    "type": "object",
                                    "properties": {
                                        "op": {"const": "spawn"},
                                        "client_id": {"type": "string", "description": "本事务局部名称，可被后续 after 用 $client_id 引用"},
                                        "intent": {"type": "string"},
                                        "not_before": {"type": "string", "description": "RFC 3339 绝对时间"},
                                        "delay_seconds": {"type": "integer", "minimum": 0},
                                        "every_seconds": {"type": "integer", "minimum": 1, "description": "固定间隔周期；每次到期生成独立 occurrence Thread"},
                                        "after": {"type": "array", "items": {"type": "string"}},
                                        "target": {"type": "string", "description": "新 Execution Thread 绑定的稳定 Execution Target ID；省略时保持未绑定，首个物理动作决定"},
                                        "lifetime": {
                                            "type": "string",
                                            "enum": ["attached", "durable", "disposable"],
                                            "description": "attached 必须由本轮消费结果；durable 必须绑定 Objective；disposable 不得成为 required 依赖"
                                        },
                                        "objective": {
                                            "oneOf": objective_binding_schema["oneOf"].clone(),
                                            "description": "仅 lifetime=durable 使用；current 指向当前绑定 Objective；create 仅用于真正独立的持久生命周期"
                                        },
                                        "completion": {
                                            "type": "object",
                                            "properties": {
                                                "required": {"type": "boolean", "default": true},
                                                "contract": {"type": "object", "description": "Runtime/Harness 可验证的有界完成契约"}
                                            },
                                            "additionalProperties": false
                                        }
                                    },
                                    "required": ["op", "intent", "lifetime"],
                                    "additionalProperties": false
                                },
                                promote_operation_schema,
                                {
                                    "type": "object",
                                    "properties": {
                                        "op": {"const": "inspect"},
                                        "schedule_id": {"type": "string"}
                                    },
                                    "required": ["op", "schedule_id"],
                                    "additionalProperties": false
                                },
                                {
                                    "type": "object",
                                    "properties": {
                                        "op": {"const": "pause"},
                                        "schedule_id": {"type": "string"},
                                        "expected_revision": {"type": "integer", "minimum": 1, "description": "inspect 返回的当前 revision；过期值会返回 conflict"}
                                    },
                                    "required": ["op", "schedule_id", "expected_revision"],
                                    "additionalProperties": false
                                },
                                {
                                    "type": "object",
                                    "properties": {
                                        "op": {"const": "resume"},
                                        "schedule_id": {"type": "string"},
                                        "expected_revision": {"type": "integer", "minimum": 1}
                                    },
                                    "required": ["op", "schedule_id", "expected_revision"],
                                    "additionalProperties": false
                                },
                                {
                                    "type": "object",
                                    "properties": {
                                        "op": {"const": "reschedule"},
                                        "schedule_id": {"type": "string"},
                                        "expected_revision": {"type": "integer", "minimum": 1},
                                        "not_before": {"type": "string", "description": "新的 RFC 3339 绝对时间；与 delay_seconds 二选一"},
                                        "delay_seconds": {"type": "integer", "minimum": 0},
                                        "every_seconds": {"type": "integer", "minimum": 1, "description": "新的周期；省略表示改为一次性"}
                                    },
                                    "required": ["op", "schedule_id", "expected_revision"],
                                    "additionalProperties": false
                                },
                                {
                                    "type": "object",
                                    "properties": {
                                        "op": {"const": "cancel"},
                                        "schedule_id": {"type": "string"},
                                        "expected_revision": {"type": "integer", "minimum": 1}
                                    },
                                    "required": ["op", "schedule_id", "expected_revision"],
                                    "additionalProperties": false
                                }
                            ]
                        }
                    },
                    "group": {
                        "type": "object",
                        "properties": {
                            "policy": {"type": "string", "enum": ["all", "any"], "default": "all"},
                            "completion_contract": {"type": "object"}
                        },
                        "additionalProperties": false,
                        "description": "为本事务创建的 sibling Thread 建立一个持久 join barrier；attached spawn 会自动建立 all Group"
                    }
                },
                "required": ["operations"],
                "additionalProperties": false
            }),
        }
    }

    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: ScheduleTxArgs = serde_json::from_str(arguments)?;
        if args.operations.is_empty() || args.operations.len() > MAX_SCHEDULE_OPERATIONS {
            return Err(
                format!("schedule_tx.operations 数量必须在 1..={MAX_SCHEDULE_OPERATIONS}").into(),
            );
        }
        let session_id = CURRENT_SESSION_ID
            .try_with(Clone::clone)
            .map_err(|_| "schedule_tx 缺少当前 Session 路由")?;
        let context_id = CURRENT_CONTEXT_ID
            .try_with(Clone::clone)
            .map_err(|_| "schedule_tx 缺少当前 Context 路由")?;
        let attempt_id = CURRENT_ATTEMPT_ID
            .try_with(Clone::clone)
            .map_err(|_| "schedule_tx 缺少当前 Evaluation 路由")?;
        let route = CURRENT_CAUSAL_ROUTE
            .try_with(Clone::clone)
            .ok()
            .flatten()
            .ok_or("schedule_tx 缺少当前 Thread 路由")?;
        let session = self
            .sessions
            .get_session(&session_id)
            .await?
            .ok_or("schedule_tx 当前 Session 不存在")?;
        if session.context_id != context_id {
            return Err("schedule_tx Session 与 Context 路由不一致".into());
        }
        let control_count = args
            .operations
            .iter()
            .filter(|operation| operation.is_control())
            .count();
        if control_count > 0 {
            if args.group.is_some() {
                return Err("Schedule 控制操作不能携带 group".into());
            }
            if control_count != 1 || args.operations.len() != 1 {
                return Err(
                    "Schedule 控制操作必须单独提交，不能与创建操作或其他控制操作混合".into(),
                );
            }
            return self
                .execute_control(
                    args.operations
                        .into_iter()
                        .next()
                        .expect("validated one control operation"),
                    &context_id,
                )
                .await;
        }
        let current_thread = self
            .sessions
            .get_thread(&route.thread_id)
            .await?
            .ok_or("schedule_tx 当前 Thread 不存在")?;
        let promotion_count = args
            .operations
            .iter()
            .filter(|operation| operation.is_promotion())
            .count();
        if promotion_count > 0 {
            if args.group.is_some() {
                return Err("Thread 升格会原子建立新的 Objective Group，不能再携带 group".into());
            }
            if promotion_count != 1 || args.operations.len() != 1 {
                return Err("promote 必须单独提交，不能与创建、控制或其他升格操作混合".into());
            }
            let ScheduleOperation::Promote {
                thread_id,
                expected_revision,
                objective,
            } = args
                .operations
                .into_iter()
                .next()
                .expect("validated one promotion operation")
            else {
                unreachable!("validated promotion operation")
            };
            return self
                .execute_promotion(
                    thread_id,
                    expected_revision,
                    objective,
                    &attempt_id,
                    &context_id,
                    &session_id,
                    &route,
                )
                .await;
        }

        let mut create_spec: Option<(String, String, Option<u64>)> = None;
        for operation in &args.operations {
            let ScheduleOperation::Spawn {
                lifetime,
                objective:
                    Some(ScheduleObjectiveBinding::Create {
                        stated_objective,
                        completion_criteria,
                        token_budget,
                    }),
                ..
            } = operation
            else {
                continue;
            };
            if *lifetime != ThreadLifetime::Durable {
                return Err("objective.mode=create 只能用于 lifetime=durable".into());
            }
            let stated_objective = stated_objective.trim();
            let completion_criteria = completion_criteria.trim();
            if stated_objective.is_empty() || completion_criteria.is_empty() {
                return Err("objective.mode=create 必须提供非空目标与完成标准".into());
            }
            let candidate = (
                stated_objective.to_string(),
                completion_criteria.to_string(),
                *token_budget,
            );
            if let Some(existing) = &create_spec {
                if existing != &candidate {
                    return Err(
                        "一次 schedule_tx 只能原子创建一个 Objective；多个 spawn 必须复用完全相同的 create 声明"
                            .into(),
                    );
                }
            } else {
                create_spec = Some(candidate);
            }
        }
        let created_objective_id = create_spec.as_ref().map(
            |(stated_objective, completion_criteria, token_budget)| {
                let digest = sha256_hex(
                    format!(
                        "{attempt_id}\0objective-create\0{stated_objective}\0{completion_criteria}\0{token_budget:?}"
                    )
                    .as_bytes(),
                );
                format!("objective-auto-{}", &digest[..24])
            },
        );

        let mut threads = Vec::new();
        let mut prepared = Vec::new();
        let mut prepared_supervisions = Vec::<Option<ThreadSupervision>>::new();
        let mut prepared_required = Vec::<bool>::new();
        let mut local_refs = HashMap::<String, String>::new();
        let mut existing_objective_revisions = HashMap::<String, u64>::new();
        for (index, operation) in args.operations.iter().enumerate() {
            if let ScheduleOperation::Spawn {
                client_id,
                target,
                lifetime,
                objective,
                completion,
                ..
            } = operation
            {
                let seed = format!(
                    "{attempt_id}\0{index}\0{}",
                    client_id.as_deref().unwrap_or("")
                );
                let digest = sha256_hex(seed.as_bytes());
                let thread_id = format!("thread_{}", &digest[..24]);
                let root_turn_id = format!("scheduled_root_{}", &digest[..24]);
                if let Some(client_id) = client_id {
                    if client_id.trim().is_empty() || local_refs.contains_key(client_id) {
                        return Err("schedule_tx.spawn.client_id 必须非空且在事务内唯一".into());
                    }
                    local_refs.insert(client_id.clone(), thread_id.clone());
                }
                let mut supervision = match lifetime {
                    ThreadLifetime::Attached => {
                        if objective.is_some() {
                            return Err(
                                "lifetime=attached 由当前 Evaluation 监督，不能携带 objective"
                                    .into(),
                            );
                        }
                        ThreadSupervision::evaluation(
                            route.activation_id.clone(),
                            route.thread_id.clone(),
                        )
                    }
                    ThreadLifetime::Durable => {
                        let binding = objective.as_ref().ok_or(
                            "lifetime=durable 必须显式绑定 objective=current 或 objective=existing",
                        )?;
                        let objective_id = match binding {
                            ScheduleObjectiveBinding::Current => {
                                CURRENT_OBJECTIVE_ID
                                    .try_with(Clone::clone)
                                    .ok()
                                    .flatten()
                                    .ok_or("当前 Evaluation 未绑定 Objective，不能使用 objective.mode=current")?
                            }
                            ScheduleObjectiveBinding::Existing { objective_id } => {
                                objective_id.trim().to_string()
                            }
                            ScheduleObjectiveBinding::Create { .. } => created_objective_id
                                .clone()
                                .ok_or("objective.mode=create 缺少预备 Objective")?,
                        };
                        if objective_id.is_empty() {
                            return Err("objective_id 不能为空".into());
                        }
                        let objective_revision = if created_objective_id.as_deref()
                            == Some(objective_id.as_str())
                        {
                            1
                        } else if let Some(revision) =
                            existing_objective_revisions.get(&objective_id)
                        {
                            *revision
                        } else {
                            let objectives = self.objectives.as_ref().ok_or(
                                "当前 Runtime 未配置 Objective Store，不能创建 durable Thread",
                            )?;
                            let objective = objectives
                                .get_objective(&objective_id)
                                .await?
                                .ok_or_else(|| format!("Objective '{}' 不存在", objective_id))?;
                            if objective.agent_id != session.agent_id
                                || objective.context_id != context_id
                                || objective.coordinator_session_id != session_id
                                || objective.status != ObjectiveStatus::Active
                            {
                                return Err(format!(
                                    "Objective '{}' 不是当前 Agent/Context/Session 中的 active Objective",
                                    objective_id
                                )
                                .into());
                            }
                            if objective.wait_condition.is_some() {
                                return Err(format!(
                                    "Objective '{}' 已有等待条件，不能同时绑定新的 required Thread Group",
                                    objective_id
                                )
                                .into());
                            }
                            existing_objective_revisions
                                .insert(objective_id.clone(), objective.revision);
                            objective.revision
                        };
                        ThreadSupervision::objective(
                            objective_id,
                            route.activation_id.clone(),
                            objective_revision,
                            Some(route.thread_id.clone()),
                        )
                    }
                    ThreadLifetime::Disposable => {
                        if objective.is_some() {
                            return Err(
                                "lifetime=disposable 不受 Objective 监督，不能携带 objective"
                                    .into(),
                            );
                        }
                        if completion.required {
                            return Err(
                                "disposable Thread 不保证恢复或交付，completion.required 必须为 false"
                                    .into(),
                            );
                        }
                        ThreadSupervision::disposable(route.activation_id.clone())
                    }
                };
                supervision.completion_contract = completion.contract.clone();
                prepared_supervisions.push(Some(supervision));
                prepared_required.push(completion.required);
                threads.push(NewThread {
                    id: thread_id.clone(),
                    agent_id: session.agent_id.clone(),
                    context_id: context_id.clone(),
                    session_id: session_id.clone(),
                    initiating_principal_id: current_thread.initiating_principal_id.clone(),
                    root_turn_id,
                    kind: ThreadKind::Execution,
                    executor_kind: "self".to_string(),
                    executor_id: None,
                    target_id: target.clone(),
                    // Group identity is installed below after all siblings have
                    // been validated against one common supervisor.
                    supervision: prepared_supervisions
                        .last()
                        .and_then(Clone::clone)
                        .expect("spawn supervision prepared"),
                });
                prepared.push(thread_id);
            } else {
                prepared_supervisions.push(None);
                prepared_required.push(false);
                prepared.push(String::new());
            }
        }

        let spawn_indices = prepared_supervisions
            .iter()
            .enumerate()
            .filter_map(|(index, supervision)| supervision.as_ref().map(|_| index))
            .collect::<Vec<_>>();
        let attached_spawned = spawn_indices.iter().any(|index| {
            prepared_supervisions[*index]
                .as_ref()
                .is_some_and(|supervision| supervision.lifetime == ThreadLifetime::Attached)
        });
        let required_durable_spawned = spawn_indices.iter().any(|index| {
            prepared_required[*index]
                && prepared_supervisions[*index]
                    .as_ref()
                    .is_some_and(|supervision| supervision.lifetime == ThreadLifetime::Durable)
        });
        let create_group = args.group.is_some()
            || attached_spawned
            // Required durable work is not fire-and-forget. Existing and
            // current Objectives need the same barrier authority as a newly
            // created Objective, otherwise the Evaluation can finish and the
            // supervisor immediately starts a duplicate continuation.
            || required_durable_spawned
            // A newly-created Objective must start with one durable wait
            // authority. A singleton Group may look redundant, but it keeps
            // creation, terminal wake, restart recovery and later fan-out on
            // the same barrier protocol instead of inventing a weaker
            // one-Thread special case.
            || (created_objective_id.is_some() && !spawn_indices.is_empty());
        let mut group_plans = Vec::new();
        if create_group {
            if spawn_indices.is_empty() {
                return Err("group 至少需要一个 spawn Thread".into());
            }
            let first = prepared_supervisions[spawn_indices[0]]
                .as_ref()
                .expect("spawn supervision")
                .clone();
            if first.lifetime == ThreadLifetime::Disposable {
                return Err("disposable Thread 不能加入受监督 Thread Group".into());
            }
            for index in &spawn_indices {
                let supervision = prepared_supervisions[*index]
                    .as_ref()
                    .expect("spawn supervision");
                if supervision.supervisor_kind != first.supervisor_kind
                    || supervision.supervisor_id != first.supervisor_id
                    || supervision.generation != first.generation
                {
                    return Err(
                        "同一个 Thread Group 的成员必须拥有相同 lifetime、supervisor 与 generation；请拆成多个 schedule_tx"
                            .into(),
                    );
                }
            }
            let digest = sha256_hex(format!("{attempt_id}\0thread-group").as_bytes());
            let group_id = format!("thread_group_{}", &digest[..24]);
            for index in &spawn_indices {
                prepared_supervisions[*index]
                    .as_mut()
                    .expect("spawn supervision")
                    .thread_group_id = Some(group_id.clone());
                let thread_id = &prepared[*index];
                threads
                    .iter_mut()
                    .find(|thread| thread.id == *thread_id)
                    .expect("prepared spawn Thread")
                    .supervision
                    .thread_group_id = Some(group_id.clone());
            }
            let group_args = args.group.as_ref();
            group_plans.push(NewThreadGroupPlan {
                group: NewThreadGroup {
                    id: group_id,
                    context_id: context_id.clone(),
                    session_id: session_id.clone(),
                    supervisor_kind: first.supervisor_kind,
                    supervisor_id: first
                        .supervisor_id
                        .clone()
                        .ok_or("受监督 Thread Group 缺少 supervisor_id")?,
                    generation: first.generation,
                    policy: group_args
                        .map(|group| group.policy)
                        .unwrap_or(ThreadGroupPolicy::All),
                    completion_contract: group_args
                        .map(|group| group.completion_contract.clone())
                        .unwrap_or_default(),
                },
                members: spawn_indices
                    .iter()
                    .enumerate()
                    .map(|(ordinal, index)| NewThreadGroupMember {
                        thread_id: prepared[*index].clone(),
                        ordinal: ordinal as u64,
                        required: prepared_required[*index],
                    })
                    .collect(),
            });
        }

        let mut objective_waits = Vec::new();
        for plan in &group_plans {
            if plan.group.supervisor_kind != ThreadSupervisorKind::Objective
                || created_objective_id.as_deref() == Some(plan.group.supervisor_id.as_str())
            {
                continue;
            }
            let expected_revision = existing_objective_revisions
                .get(&plan.group.supervisor_id)
                .copied()
                .ok_or_else(|| {
                    format!(
                        "Objective Group '{}' 缺少现有 Objective '{}' 的 revision fence",
                        plan.group.id, plan.group.supervisor_id
                    )
                })?;
            let wait_condition = ObjectiveWaitCondition::ThreadGroup {
                group_id: plan.group.id.clone(),
            };
            let event_digest = sha256_hex(
                format!(
                    "{attempt_id}\0objective-thread-group-bound\0{}\0{}\0{expected_revision}",
                    plan.group.supervisor_id, plan.group.id
                )
                .as_bytes(),
            );
            let bound_event = Event::new(
                format!("objective_thread_group_bound_{}", &event_digest[..24]),
                "Agent-Morphz".to_string(),
                TYPE_OBJECTIVE_CONTROL.to_string(),
                "objective/thread_group_bound".to_string(),
                serde_json::json!({
                    "objective_id": plan.group.supervisor_id,
                    "agent_id": session.agent_id,
                    "context_id": context_id,
                    "session_id": session_id,
                    "source_evaluation_id": attempt_id,
                    "source_thread_id": route.thread_id,
                    "thread_group_id": plan.group.id,
                    "expected_objective_revision": expected_revision,
                    "wait_condition": wait_condition,
                    "member_thread_ids": plan.members.iter()
                        .map(|member| &member.thread_id)
                        .collect::<Vec<_>>(),
                })
                .as_object()
                .expect("objective group binding event payload")
                .clone(),
            );
            objective_waits.push(ScheduledObjectiveWaitBinding {
                objective_id: plan.group.supervisor_id.clone(),
                expected_revision,
                wait_condition,
                status_reason: "等待受监督执行线程组完成".to_string(),
                bound_event,
            });
        }

        let mut scheduled_objectives = Vec::new();
        if let (Some(objective_id), Some((stated_objective, completion_criteria, token_budget))) =
            (created_objective_id.as_ref(), create_spec.as_ref())
        {
            let member_thread_ids = threads
                .iter()
                .filter(|thread| {
                    thread.supervision.supervisor_id.as_deref() == Some(objective_id.as_str())
                })
                .map(|thread| thread.id.clone())
                .collect::<Vec<_>>();
            if member_thread_ids.is_empty() {
                return Err("objective.mode=create 没有对应的初始 durable Thread".into());
            }
            let initial_wait_condition = if let Some(group) = group_plans.iter().find(|plan| {
                plan.group.supervisor_id == *objective_id
                    && plan.group.supervisor_kind == crate::memory::ThreadSupervisorKind::Objective
            }) {
                ObjectiveWaitCondition::ThreadGroup {
                    group_id: group.group.id.clone(),
                }
            } else {
                return Err("新 Objective 的初始 Thread 必须属于同一个受监督 Thread Group".into());
            };
            let source_event_id = format!("objective_scheduled_{objective_id}");
            let created_event = Event::new(
                source_event_id.clone(),
                "Agent-Morphz".to_string(),
                TYPE_OBJECTIVE_CONTROL.to_string(),
                "objective/scheduled_created".to_string(),
                serde_json::json!({
                    "objective_id": objective_id,
                    "agent_id": session.agent_id,
                    "context_id": context_id,
                    "session_id": session_id,
                    "source_evaluation_id": attempt_id,
                    "source_thread_id": route.thread_id,
                    "stated_objective": stated_objective,
                    "completion_criteria": completion_criteria,
                    "token_budget": token_budget,
                    "initial_thread_ids": member_thread_ids,
                    "initial_wait_condition": initial_wait_condition
                })
                .as_object()
                .expect("objective scheduled event payload")
                .clone(),
            );
            scheduled_objectives.push(NewScheduledObjective {
                objective: NewObjective {
                    id: objective_id.clone(),
                    agent_id: session.agent_id.clone(),
                    context_id: context_id.clone(),
                    coordinator_session_id: session_id.clone(),
                    delivery_session_id: session_id.clone(),
                    parent_objective_id: None,
                    source_event_id,
                    initiating_principal_id: current_thread.initiating_principal_id.clone(),
                    stated_objective: stated_objective.clone(),
                    token_budget: *token_budget,
                },
                initial_wait_condition,
                status_reason: format!("等待首批受监督执行完成；验收标准：{completion_criteria}"),
                created_event,
            });
        }

        let mut intents = Vec::with_capacity(args.operations.len());
        for (index, operation) in args.operations.into_iter().enumerate() {
            let (target_thread_id, intent, not_before, delay_seconds, interval_seconds, after) =
                match operation {
                    ScheduleOperation::Enqueue {
                        thread_id,
                        intent,
                        not_before,
                        delay_seconds,
                        after,
                    } => (
                        thread_id.unwrap_or_else(|| route.thread_id.clone()),
                        intent,
                        not_before,
                        delay_seconds,
                        None,
                        after,
                    ),
                    ScheduleOperation::Spawn {
                        intent,
                        not_before,
                        delay_seconds,
                        every_seconds,
                        after,
                        ..
                    } => (
                        prepared[index].clone(),
                        intent,
                        not_before,
                        delay_seconds,
                        every_seconds,
                        after,
                    ),
                    ScheduleOperation::Inspect { .. }
                    | ScheduleOperation::Pause { .. }
                    | ScheduleOperation::Resume { .. }
                    | ScheduleOperation::Reschedule { .. }
                    | ScheduleOperation::Promote { .. }
                    | ScheduleOperation::Cancel { .. } => {
                        unreachable!("control operations returned before create transaction")
                    }
                };
            validate_schedule_intent(&intent)?;
            if not_before.is_some() && delay_seconds.is_some() {
                return Err("not_before 与 delay_seconds 只能提供一个".into());
            }
            let waits_for_future = not_before.is_some()
                || delay_seconds.is_some_and(|seconds| seconds > 0)
                || !after.is_empty();
            if target_thread_id == route.thread_id
                && current_thread.kind == ThreadKind::DialogueTurn
                && waits_for_future
            {
                return Err("DialogueTurn Thread 不能挂起等待未来时间或依赖；请使用 spawn 创建独立 Execution Thread，再向当前 Session 回复调度结果".into());
            }
            let not_before = schedule_due_at(not_before.as_deref(), delay_seconds)?;
            let mut dependencies = Vec::with_capacity(after.len());
            for dependency in after {
                let resolved = dependency
                    .strip_prefix('$')
                    .and_then(|name| local_refs.get(name))
                    .cloned()
                    .unwrap_or(dependency);
                if resolved == target_thread_id {
                    return Err("Thread 不能依赖自己".into());
                }
                dependencies.push(resolved);
            }
            let digest = sha256_hex(
                format!("{attempt_id}\0{index}\0{target_thread_id}\0{intent}").as_bytes(),
            );
            intents.push(NewSchedule {
                id: format!("schedule_{}", &digest[..24]),
                thread_id: target_thread_id,
                source_turn_id: route.root_turn_id.clone(),
                intent,
                not_before,
                interval_seconds,
                dependency_thread_ids: dependencies,
            });
        }
        for intent in &intents {
            for dependency_id in &intent.dependency_thread_ids {
                let newly_created = threads.iter().any(|thread| thread.id == *dependency_id);
                if !newly_created && self.sessions.get_thread(dependency_id).await?.is_none() {
                    return Err(format!("依赖 Thread '{dependency_id}' 不存在").into());
                }
            }
        }
        let mut records = self
            .sessions
            .commit_schedule_transaction(
                &scheduled_objectives,
                &objective_waits,
                &threads,
                &intents,
                &group_plans,
            )
            .await?;
        for record in &mut records {
            let continues_current_thread = record.thread_id == route.thread_id
                && record.not_before.is_none()
                && record.interval_seconds.is_none()
                && record.dependency_thread_ids.is_empty();
            if continues_current_thread {
                if let Some(dispatched) = self
                    .sessions
                    .claim_schedule(&record.id, record.revision, None)
                    .await?
                {
                    *record = dispatched;
                }
            } else {
                self.scheduler.arm(record.clone()).await?;
            }
        }
        Ok(serde_json::json!({
            "status": "committed",
            "operations": records,
            "created_thread_ids": threads.iter().map(|thread| &thread.id).collect::<Vec<_>>(),
            "created_objective_ids": scheduled_objectives.iter().map(|objective| &objective.objective.id).collect::<Vec<_>>(),
            "thread_groups": group_plans.iter().map(|plan| serde_json::json!({
                "group_id": plan.group.id,
                "policy": plan.group.policy,
                "supervisor_kind": plan.group.supervisor_kind,
                "supervisor_id": plan.group.supervisor_id,
                "member_thread_ids": plan.members.iter().map(|member| &member.thread_id).collect::<Vec<_>>()
            })).collect::<Vec<_>>(),
            "guidance": if group_plans.is_empty() {
                "调度计划已原子持久化。durable Thread 的终态将唤醒绑定 Objective；disposable Thread 不保证恢复或交付。"
            } else {
                "调度计划与 Thread Group 已原子持久化。Group 达到 all/any 条件后只产生一次 barrier；attached 会重新唤醒父 Evaluation，durable 会唤醒绑定 Objective。"
            }
        })
        .to_string())
    }
}

fn validate_schedule_intent(intent: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if intent.trim().is_empty() {
        return Err("schedule_tx intent 不能为空".into());
    }
    if intent.chars().count() > MAX_SCHEDULE_INTENT_CHARS {
        return Err(format!("schedule_tx intent 超过 {MAX_SCHEDULE_INTENT_CHARS} 字符").into());
    }
    Ok(())
}

fn schedule_due_at(
    not_before: Option<&str>,
    delay_seconds: Option<u64>,
) -> Result<Option<chrono::DateTime<chrono::Utc>>, Box<dyn std::error::Error + Send + Sync>> {
    if let Some(value) = not_before {
        return Ok(Some(
            chrono::DateTime::parse_from_rfc3339(value)
                .map_err(|error| format!("not_before 不是合法 RFC 3339 时间: {error}"))?
                .with_timezone(&chrono::Utc),
        ));
    }
    Ok(delay_seconds.map(|seconds| {
        chrono::Utc::now() + chrono::Duration::seconds(i64::try_from(seconds).unwrap_or(i64::MAX))
    }))
}

fn scheduled_occurrence_root(intent_id: &str, revision: u64) -> String {
    let digest = sha256_hex(format!("{intent_id}\0{revision}").as_bytes());
    format!("scheduled_occurrence_{}", &digest[..24])
}

// ==========================================
// 工业级后台长任务托管机制
// ==========================================
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundTaskStatus {
    Starting,
    Running,
    KillRequested,
    Succeeded,
    Failed,
    Killed,
}

impl BackgroundTaskStatus {
    pub(crate) fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Killed)
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::KillRequested => "kill_requested",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Killed => "killed",
        }
    }
}

pub struct BackgroundTask {
    pub id: String,
    pub cmd_str: String,
    pub pgid: i32,
    pub session_id: String,
    pub context_id: String,
    pub initiating_principal_id: Option<String>,
    pub causal_route: Option<ToolCausalRoute>,
    /// Declared by the Agent that started the process: a service it means to
    /// leave running rather than work this turn is waiting on. The distinction
    /// belongs to whoever launched it, so the Runtime does not guess it.
    pub keep_running: bool,
    pub started_at: chrono::DateTime<chrono::Utc>,
    pub last_output_at: chrono::DateTime<chrono::Utc>,
    pub output_bytes: usize,
    pub output_tail: String,
    pub wake_generation: u64,
    pub next_wakeup_at: Option<chrono::DateTime<chrono::Utc>>,
    pub status: BackgroundTaskStatus,
    pub effective_network: bool,
    pub permission_request_available: bool,
    pub secret_env: Vec<String>,
    pub sandbox_backend: String,
    pub sandbox_status: String,
    pub artifact_path: String,
    pub ended_at: Option<chrono::DateTime<chrono::Utc>>,
    pub exit_code: Option<i32>,
}

static BACKGROUND_TASKS: OnceLock<Arc<DashMap<String, BackgroundTask>>> = OnceLock::new();

pub fn get_tasks_map() -> &'static Arc<DashMap<String, BackgroundTask>> {
    BACKGROUND_TASKS.get_or_init(|| Arc::new(DashMap::new()))
}

const MAX_RETAINED_BACKGROUND_TASKS: usize = 256;

fn prune_background_task_history() {
    let tasks = get_tasks_map();
    if tasks.len() <= MAX_RETAINED_BACKGROUND_TASKS {
        return;
    }
    let mut completed = tasks
        .iter()
        .filter(|entry| entry.status.is_terminal())
        .map(|entry| (entry.id.clone(), entry.ended_at.unwrap_or(entry.started_at)))
        .collect::<Vec<_>>();
    completed.sort_by_key(|(_, ended_at)| *ended_at);
    let remove_count = tasks.len().saturating_sub(MAX_RETAINED_BACKGROUND_TASKS);
    for (task_id, _) in completed.into_iter().take(remove_count) {
        tasks.remove(&task_id);
    }
}

pub(crate) fn background_task_snapshot(task: &BackgroundTask) -> serde_json::Value {
    let now = chrono::Utc::now();
    serde_json::json!({
        "task_id": task.id,
        "status": task.status,
        "command": task.cmd_str,
        "process_group_id": task.pgid,
        "session_id": task.session_id,
        "context_id": task.context_id,
        "initiating_principal_id": task.initiating_principal_id,
        "activation_id": task.causal_route.as_ref().map(|route| &route.activation_id),
        "root_turn_id": task.causal_route.as_ref().map(|route| &route.root_turn_id),
        "started_at": task.started_at,
        "ended_at": task.ended_at,
        "elapsed_secs": (task.ended_at.unwrap_or(now) - task.started_at).num_seconds().max(0),
        "last_output_at": task.last_output_at,
        "last_output_age_secs": (now - task.last_output_at).num_seconds().max(0),
        "output_bytes": task.output_bytes,
        "output_tail": task.output_tail,
        "next_wakeup_at": task.next_wakeup_at,
        "exit_code": task.exit_code,
        "effective_boundary": {
            "network_enabled": task.effective_network,
            "permission_request_available": task.permission_request_available,
            "secret_env": task.secret_env,
            "sandbox_backend": task.sandbox_backend,
            "sandbox_status": task.sandbox_status,
        },
        "artifact_path": task.artifact_path,
    })
}

fn background_execution_snapshot(
    job: &ExecutionJobRecord,
    live: Option<&BackgroundTask>,
) -> serde_json::Value {
    let now = chrono::Utc::now();
    let started_at = job
        .request
        .get("started_at")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&chrono::Utc))
        .or(job.started_at)
        .unwrap_or(job.created_at);
    let ended_at = job.finished_at;
    let status = if job.cancel_requested_at.is_some() && !job.status.is_terminal() {
        "cancel_requested"
    } else {
        job.status.as_str()
    };
    serde_json::json!({
        "task_id": job.id,
        "execution_job_id": job.id,
        "target_id": job.target_id,
        "revision": job.revision,
        "status": status,
        "command": job.request.get("command"),
        "process_group_id": job.request.get("process_group_id"),
        "session_id": job.session_id,
        "context_id": job.context_id,
        "activation_id": job.activation_id,
        "thread_id": job.thread_id,
        "started_at": started_at,
        "ended_at": ended_at,
        "elapsed_secs": (ended_at.unwrap_or(now) - started_at).num_seconds().max(0),
        "last_output_at": live.map(|task| task.last_output_at),
        "last_output_age_secs": live.map(|task| (now - task.last_output_at).num_seconds().max(0)),
        "output_bytes": live.map_or(0, |task| task.output_bytes),
        "output_tail": live.map_or("", |task| task.output_tail.as_str()),
        "next_wakeup_at": live.and_then(|task| task.next_wakeup_at),
        "exit_code": job.exit_code,
        "error": job.error,
        "cancel_reason": job.cancel_reason,
        "effective_boundary": job.request.get("effective_boundary"),
        "artifact_path": job.request.get("artifact_path"),
        "result_refs": job.result_refs,
        "live_owner": live.is_some(),
    })
}

pub(crate) fn active_background_task_count(session_id: &str, context_id: &str) -> usize {
    get_tasks_map()
        .iter()
        .filter(|task| task.session_id == session_id && task.context_id == context_id)
        .filter(|task| !task.keep_running)
        .filter(|task| !task.status.is_terminal())
        .count()
}

/// Counts the work a turn is still waiting on.
///
/// A process the Agent declared with `keep_running` is deliberately outliving
/// the turn, so it is not owed work: counting it kept a Thread from ever
/// closing, because a dev server never exits and the condition could never
/// clear. Anything that will finish and whose result the turn needs — a build,
/// a test run — still counts.
pub(crate) fn active_background_task_count_for_root(
    session_id: &str,
    context_id: &str,
    root_turn_id: &str,
) -> usize {
    get_tasks_map()
        .iter()
        .filter(|task| task.session_id == session_id && task.context_id == context_id)
        .filter(|task| {
            task.causal_route
                .as_ref()
                .is_some_and(|route| route.root_turn_id == root_turn_id)
        })
        .filter(|task| !task.keep_running)
        .filter(|task| !task.status.is_terminal())
        .count()
}

fn mark_background_task_terminal(task_id: &str, exit_code: i32) -> BackgroundTaskStatus {
    let tasks = get_tasks_map();
    let status = if tasks
        .get(task_id)
        .is_some_and(|task| task.status == BackgroundTaskStatus::KillRequested)
    {
        BackgroundTaskStatus::Killed
    } else if exit_code == 0 {
        BackgroundTaskStatus::Succeeded
    } else {
        BackgroundTaskStatus::Failed
    };
    if let Some(mut task) = tasks.get_mut(task_id) {
        task.status = status;
        task.exit_code = Some(exit_code);
        task.ended_at = Some(chrono::Utc::now());
        task.wake_generation = task.wake_generation.wrapping_add(1);
        task.next_wakeup_at = None;
    }
    status
}

const MAX_TASK_WAIT_SECS: u64 = 365 * 24 * 60 * 60;

fn background_check_due_payload(
    task: &BackgroundTask,
    check_after_secs: u64,
    wake_source: &str,
) -> serde_json::Map<String, serde_json::Value> {
    let elapsed_secs = (chrono::Utc::now() - task.started_at).num_seconds().max(0);
    let output_tail = if task.output_tail.is_empty() {
        "（任务尚未产生输出）".to_string()
    } else {
        task.output_tail.clone()
    };
    let mut payload = serde_json::Map::new();
    payload.insert("context_id".to_string(), serde_json::json!(task.context_id));
    payload.insert("session_id".to_string(), serde_json::json!(task.session_id));
    if let Some(principal_id) = &task.initiating_principal_id {
        payload.insert("principal_id".to_string(), serde_json::json!(principal_id));
    }
    payload.insert(
        "tool_name".to_string(),
        serde_json::json!("check_task_after"),
    );
    payload.insert("task_id".to_string(), serde_json::json!(task.id));
    payload.insert(
        "event".to_string(),
        serde_json::json!("background_task_check_due"),
    );
    payload.insert(
        "legacy_event".to_string(),
        serde_json::json!("background_task_wait_elapsed"),
    );
    payload.insert("wake_source".to_string(), serde_json::json!(wake_source));
    payload.insert(
        "check_after_secs".to_string(),
        serde_json::json!(check_after_secs),
    );
    payload.insert("wait_secs".to_string(), serde_json::json!(check_after_secs));
    payload.insert("elapsed_secs".to_string(), serde_json::json!(elapsed_secs));
    payload.insert("task_status".to_string(), serde_json::json!(task.status));
    payload.insert(
        "last_output_age_secs".to_string(),
        serde_json::json!((chrono::Utc::now() - task.last_output_at)
            .num_seconds()
            .max(0)),
    );
    payload.insert(
        "output_bytes".to_string(),
        serde_json::json!(task.output_bytes),
    );
    payload.insert(
        "artifact_path".to_string(),
        serde_json::json!(task.artifact_path),
    );
    payload.insert(
        "effective_boundary".to_string(),
        serde_json::json!({
            "network_enabled": task.effective_network,
            "permission_request_available": task.permission_request_available,
            "secret_env": task.secret_env,
            "sandbox_backend": task.sandbox_backend,
            "sandbox_status": task.sandbox_status,
        }),
    );
    payload.insert("text".to_string(), serde_json::json!(format!(
        "后台任务 {} 的 {} 秒检查点已经到达；任务仍在运行，Runtime 没有终止它。\n--- 最近输出 ---\n{}\n\n请自行决定：若有明确的下一检查期限，调用 check_task_after；否则继续依赖完成事件唤醒；不应继续时调用 kill_task。",
        task.id, check_after_secs, output_tail
    )));
    extend_causal_route(&mut payload, task.causal_route.as_ref());
    payload
}

// 共享的实时输出管道缓冲
struct ExecutionBuffer {
    output: std::sync::Mutex<String>,
    archive: std::sync::Mutex<std::fs::File>,
    event_pending: std::sync::Mutex<String>,
    archive_path: String,
    truncated: AtomicBool,
    event_flush_scheduled: AtomicBool,
    max_bytes: usize,
    event_coalesce_ms: u64,
    max_event_chars: usize,
    injected_secret_values: Vec<String>,
    task_id: String,
    bus: Arc<crate::event::InMemoryEventBus>,
    session_id: String,
    context_id: String,
    initiating_principal_id: Option<String>,
    causal_route: Option<ToolCausalRoute>,
}

impl ExecutionBuffer {
    fn append(self: &Arc<Self>, text: &str, publish: bool) -> String {
        // Only values explicitly injected into this child are isolated on the return path.
        // Runtime never guesses whether arbitrary text "looks like" a secret.
        let safe_text = isolate_injected_secret_output(text, &self.injected_secret_values);
        let archive_result = match self.archive.lock() {
            Ok(mut archive) => archive.write_all(safe_text.as_bytes()),
            Err(poisoned) => poisoned.into_inner().write_all(safe_text.as_bytes()),
        };
        if let Err(error) = archive_result {
            tracing::error!(archive = %self.archive_path, %error, "写入 exec 原始输出归档失败");
        }
        {
            let mut guard = match self.output.lock() {
                Ok(guard) => guard,
                Err(poisoned) => {
                    tracing::error!("ExecutionBuffer Mutex poisoned, recovering");
                    poisoned.into_inner()
                }
            };
            guard.push_str(&safe_text);
            if self.max_bytes == 0 {
                guard.clear();
                self.truncated.store(true, Ordering::Relaxed);
            } else if guard.len() > self.max_bytes {
                let mut keep_from = guard.len() - self.max_bytes;
                while !guard.is_char_boundary(keep_from) {
                    keep_from += 1;
                }
                guard.drain(..keep_from);
                self.truncated.store(true, Ordering::Relaxed);
            }
            if let Some(mut task) = get_tasks_map().get_mut(&self.task_id) {
                task.last_output_at = chrono::Utc::now();
                task.output_bytes = task.output_bytes.saturating_add(safe_text.len());
                task.output_tail.push_str(&safe_text);
                task.output_tail = tail_chars(&task.output_tail, 2_000);
            }
        }
        if publish {
            match self.event_pending.lock() {
                Ok(mut pending) => pending.push_str(&safe_text),
                Err(poisoned) => poisoned.into_inner().push_str(&safe_text),
            }
            if !self.event_flush_scheduled.swap(true, Ordering::SeqCst) {
                let buffer = Arc::clone(self);
                tokio::spawn(async move { buffer.flush_output_events().await });
            }
        }
        safe_text
    }

    async fn flush_output_events(self: Arc<Self>) {
        loop {
            tokio::time::sleep(tokio::time::Duration::from_millis(
                self.event_coalesce_ms.max(1),
            ))
            .await;
            let pending = match self.event_pending.lock() {
                Ok(mut pending) => std::mem::take(&mut *pending),
                Err(poisoned) => {
                    let mut pending = poisoned.into_inner();
                    std::mem::take(&mut *pending)
                }
            };
            if !pending.is_empty() {
                self.publish_output_event(pending).await;
            }
            self.event_flush_scheduled.store(false, Ordering::SeqCst);
            let has_pending = match self.event_pending.lock() {
                Ok(pending) => !pending.is_empty(),
                Err(poisoned) => !poisoned.into_inner().is_empty(),
            };
            if !has_pending
                || self
                    .event_flush_scheduled
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_err()
            {
                break;
            }
        }
    }

    async fn publish_output_event(&self, text: String) {
        let total_chars = text.chars().count();
        let truncated = total_chars > self.max_event_chars;
        let rendered = if truncated {
            let tail = text
                .chars()
                .rev()
                .take(self.max_event_chars)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>();
            format!(
                "[本事件合并了 {total_chars} 字符，仅展示末尾 {} 字符；完整输出见 {}]\n{tail}",
                self.max_event_chars, self.archive_path
            )
        } else {
            text
        };
        let mut payload = serde_json::Map::new();
        payload.insert("context_id".to_string(), serde_json::json!(self.context_id));
        payload.insert("session_id".to_string(), serde_json::json!(self.session_id));
        if let Some(principal_id) = &self.initiating_principal_id {
            payload.insert("principal_id".to_string(), serde_json::json!(principal_id));
        }
        payload.insert("task_id".to_string(), serde_json::json!(self.task_id));
        payload.insert(
            "coalesced_chars".to_string(),
            serde_json::json!(total_chars),
        );
        payload.insert("truncated".to_string(), serde_json::json!(truncated));
        payload.insert("text".to_string(), serde_json::json!(rendered));
        extend_causal_route(&mut payload, self.causal_route.as_ref());
        let event = Event::new(
            format!(
                "task_out_{}_{}",
                self.task_id,
                chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
            ),
            "System-TaskMonitor".to_string(),
            "task_output".to_string(),
            format!("task/output/{}", self.task_id),
            payload,
        );
        let _ = self.bus.publish(event).await;
    }

    async fn flush_pending_now(&self) {
        let pending = match self.event_pending.lock() {
            Ok(mut pending) => std::mem::take(&mut *pending),
            Err(poisoned) => {
                let mut pending = poisoned.into_inner();
                std::mem::take(&mut *pending)
            }
        };
        if !pending.is_empty() {
            self.publish_output_event(pending).await;
        }
    }

    fn get_all(&self) -> String {
        let guard = match self.output.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                tracing::error!("ExecutionBuffer Mutex poisoned in get_all, recovering");
                poisoned.into_inner()
            }
        };
        if self.truncated.load(Ordering::Relaxed) {
            format!(
                "[Context preview 已按缓冲上限截断；完整原始输出: {}]\n{}",
                self.archive_path, *guard
            )
        } else {
            guard.clone()
        }
    }
}

async fn monitor_pipe<R>(
    reader: R,
    buffer: Arc<ExecutionBuffer>,
    publish_ref: Arc<AtomicBool>,
    stream: EdgeOutputStream,
    output_sink: Option<tokio::sync::mpsc::Sender<ToolOutputChunk>>,
) where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    while let Ok(n) = reader.read_line(&mut line).await {
        if n == 0 {
            break;
        }
        let publish = publish_ref.load(Ordering::SeqCst);
        let safe_text = buffer.append(&line, publish);
        if let Some(output_sink) = &output_sink {
            if output_sink
                .send(ToolOutputChunk {
                    stream,
                    text: safe_text,
                })
                .await
                .is_err()
            {
                break;
            }
        }
        line.clear();
    }
}

#[derive(Debug)]
struct FileSnapshot {
    content: String,
    sha256: String,
    bytes: usize,
    permissions: Permissions,
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn isolate_injected_secret_output(input: &str, injected_values: &[String]) -> String {
    injected_values
        .iter()
        .fold(input.to_string(), |output, value| {
            if value.is_empty() {
                output
            } else {
                output.replace(value, "[INJECTED_SECRET_BLOCKED]")
            }
        })
}

fn is_sensitive_environment_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    upper.contains("TOKEN")
        || upper.contains("SECRET")
        || upper.contains("PASSWORD")
        || upper.contains("CREDENTIAL")
        || upper.contains("API_KEY")
        || upper.ends_with("_KEY")
        || upper.starts_with("OPENAI_")
        || upper.starts_with("AWS_")
        || upper.starts_with("GITHUB_")
        || upper == "SSH_AUTH_SOCK"
}

fn read_text_snapshot(path: &Path) -> Result<FileSnapshot, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("无法读取文件元数据 '{}': {}", path.display(), error))?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "为避免原子替换改变符号链接语义，禁止直接修改符号链接 '{}'",
            path.display()
        ));
    }
    if !metadata.is_file() {
        return Err(format!("'{}' 不是普通文件", path.display()));
    }
    let bytes = std::fs::read(path)
        .map_err(|error| format!("无法读取文件 '{}': {}", path.display(), error))?;
    let content = String::from_utf8(bytes.clone())
        .map_err(|_| format!("文件 '{}' 不是 UTF-8 文本", path.display()))?;
    Ok(FileSnapshot {
        sha256: sha256_hex(&bytes),
        bytes: bytes.len(),
        content,
        permissions: metadata.permissions(),
    })
}

fn atomic_write_text(
    path: &Path,
    content: &str,
    permissions: Option<Permissions>,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("写入路径 '{}' 缺少父目录", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("无法创建目录 '{}': {}", parent.display(), error))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("file");
    let temp_path = parent.join(format!(
        ".{}.morphz-tmp-{}-{}",
        file_name,
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
    ));
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|error| {
                format!(
                    "无法创建原子写入临时文件 '{}': {}",
                    temp_path.display(),
                    error
                )
            })?;
        file.write_all(content.as_bytes())
            .map_err(|error| format!("写入临时文件失败: {}", error))?;
        if let Some(permissions) = permissions {
            file.set_permissions(permissions)
                .map_err(|error| format!("保留文件权限失败: {}", error))?;
        }
        file.sync_all()
            .map_err(|error| format!("同步临时文件失败: {}", error))?;
        drop(file);
        std::fs::rename(&temp_path, path).map_err(|error| {
            format!(
                "原子替换 '{}' -> '{}' 失败: {}",
                temp_path.display(),
                path.display(),
                error
            )
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    result
}

fn diff_line_count(text: &str) -> usize {
    if text.is_empty() {
        0
    } else {
        text.bytes().filter(|byte| *byte == b'\n').count() + usize::from(!text.ends_with('\n'))
    }
}

fn prefix_lines(text: &str, prefix: char) -> String {
    if text.is_empty() {
        return String::new();
    }
    let mut output = String::new();
    for segment in text.split_inclusive('\n') {
        output.push(prefix);
        output.push_str(segment);
    }
    if !text.ends_with('\n') && !output.ends_with('\n') {
        output.push('\n');
    }
    output
}

fn replacement_diff(path: &str, hunks: &[(usize, usize, usize, String, String)]) -> String {
    let mut diff = format!("--- a/{path}\n+++ b/{path}\n");
    for (old_start, old_count, new_start, old_text, new_text) in hunks {
        diff.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            old_start,
            old_count,
            new_start,
            diff_line_count(new_text)
        ));
        diff.push_str(&prefix_lines(old_text, '-'));
        diff.push_str(&prefix_lines(new_text, '+'));
    }
    diff
}

fn bounded_text(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let head = text.chars().take(max_chars).collect::<String>();
    format!(
        "{}\n...[diff 截断，原文 {} 字符]",
        head,
        text.chars().count()
    )
}

struct FileChangeRecord<'a> {
    path: &'a str,
    operation: &'a str,
    before_sha256: Option<&'a str>,
    after_sha256: &'a str,
    bytes_before: usize,
    bytes_after: usize,
    diff: &'a str,
}

async fn publish_file_change(
    bus: Option<&Arc<crate::event::InMemoryEventBus>>,
    change: FileChangeRecord<'_>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let Some(bus) = bus else {
        return Ok(());
    };
    let session_id = CURRENT_SESSION_ID
        .try_with(Clone::clone)
        .unwrap_or_else(|_| "default_session".to_string());
    let context_id = CURRENT_CONTEXT_ID
        .try_with(Clone::clone)
        .unwrap_or_else(|_| session_id.clone());
    let mut payload = vec![
        ("context_id".to_string(), serde_json::json!(context_id)),
        ("session_id".to_string(), serde_json::json!(session_id)),
        ("path".to_string(), serde_json::json!(change.path)),
        ("operation".to_string(), serde_json::json!(change.operation)),
        (
            "before_sha256".to_string(),
            serde_json::json!(change.before_sha256),
        ),
        (
            "after_sha256".to_string(),
            serde_json::json!(change.after_sha256),
        ),
        (
            "bytes_before".to_string(),
            serde_json::json!(change.bytes_before),
        ),
        (
            "bytes_after".to_string(),
            serde_json::json!(change.bytes_after),
        ),
        ("diff".to_string(), serde_json::json!(change.diff)),
        (
            "text".to_string(),
            serde_json::json!(format!(
                "文件变更已提交：operation={} path={} sha256={}\n{}",
                change.operation,
                change.path,
                change.after_sha256,
                bounded_text(change.diff, 8_000)
            )),
        ),
    ]
    .into_iter()
    .collect::<serde_json::Map<_, _>>();
    let causal_route = CURRENT_CAUSAL_ROUTE.try_with(Clone::clone).ok().flatten();
    extend_causal_route(&mut payload, causal_route.as_ref());
    bus.publish(Event::new(
        format!(
            "file_change_{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ),
        "System-CodingTools".to_string(),
        TYPE_FILE_CHANGE.to_string(),
        "chat/file_change".to_string(),
        payload,
    ))
    .await?;
    Ok(())
}

// ==========================================
// 1. WriteFileTool 工业级路径与权限容错
// ==========================================
pub struct WriteFileTool {
    permissions: Arc<PermissionBroker>,
    bus: Option<Arc<crate::event::InMemoryEventBus>>,
}

impl WriteFileTool {
    pub fn new(config: Arc<PermissionConfig>) -> Self {
        Self {
            permissions: broker_from_config(config),
            bus: None,
        }
    }

    pub fn new_with_permissions(permissions: Arc<PermissionBroker>) -> Self {
        Self {
            permissions,
            bus: None,
        }
    }

    pub fn new_with_bus(
        config: Arc<PermissionConfig>,
        bus: Arc<crate::event::InMemoryEventBus>,
    ) -> Self {
        Self {
            permissions: broker_from_config(config),
            bus: Some(bus),
        }
    }

    pub fn new_with_runtime(
        permissions: Arc<PermissionBroker>,
        bus: Arc<crate::event::InMemoryEventBus>,
    ) -> Self {
        Self {
            permissions,
            bus: Some(bus),
        }
    }
}

impl Default for WriteFileTool {
    fn default() -> Self {
        Self::new(Arc::new(PermissionConfig::default()))
    }
}

#[derive(Deserialize)]
struct WriteFileArgs {
    path: String,
    content: String,
    mode: String,
    expected_sha256: Option<String>,
}

#[async_trait::async_trait]
impl Tool for WriteFileTool {
    fn name(&self) -> &str {
        "write"
    }

    fn definition(&self) -> ToolDefinition {
        let params_json = serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "要写入的文件路径，例如: test.txt"
                },
                "content": {
                    "type": "string",
                    "description": "要写入文件的文本内容"
                },
                "mode": {
                    "type": "string",
                    "enum": ["create", "overwrite"],
                    "description": "create 只允许新文件；overwrite 只允许已存在文件且必须提供 expected_sha256"
                },
                "expected_sha256": {
                    "type": "string",
                    "description": "overwrite 必填，必须等于最近一次 read 返回的 SHA-256；不一致时拒绝覆盖"
                }
            },
            "required": ["path", "content", "mode"]
        });

        ToolDefinition {
            name: "write".to_string(),
            description: "原子创建或显式覆盖 UTF-8 文本文件。修改既有代码优先使用 edit；overwrite 必须携带 read 返回的 expected_sha256，防止覆盖并发变化。成功后返回 diff/hash 并产生 file_change observation。".to_string(),
            parameters: params_json,
        }
    }

    fn approval_requirement(
        &self,
        arguments: &str,
    ) -> Result<Option<ApprovalRequirement>, Box<dyn std::error::Error + Send + Sync>> {
        let args: WriteFileArgs = serde_json::from_str(arguments)?;
        Ok(self
            .permissions
            .approval_requirement_for_path(
                &args.path,
                FilesystemAccess::Write,
                self.name(),
                &args.mode,
            )?
            .1)
    }

    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: WriteFileArgs = serde_json::from_str(arguments)?;
        let absolute_path = match self
            .permissions
            .authorize_path(
                &args.path,
                FilesystemAccess::Write,
                self.name(),
                &args.mode,
                approval_context(),
            )
            .await
        {
            Ok(path) => path,
            Err(e) => return Ok(format!("系统报错：写入路径被权限策略拒绝：{}", e)),
        };

        let (operation, before_content, before_sha256, before_bytes, permissions) = match args
            .mode
            .as_str()
        {
            "create" => {
                if absolute_path.exists() {
                    return Err(format!(
                        "create 拒绝覆盖已存在文件 '{}'；请先 read，再使用 edit 或 overwrite",
                        args.path
                    )
                    .into());
                }
                ("create", String::new(), None, 0, None)
            }
            "overwrite" => {
                if !absolute_path.exists() {
                    return Err(format!(
                        "overwrite 目标 '{}' 不存在；创建新文件请使用 mode=create",
                        args.path
                    )
                    .into());
                }
                let snapshot = read_text_snapshot(&absolute_path)?;
                let expected = args
                    .expected_sha256
                    .as_deref()
                    .ok_or("overwrite 必须提供最近一次 read 返回的 expected_sha256")?;
                if expected != snapshot.sha256 {
                    return Err(format!(
                            "文件版本冲突：'{}' 当前 sha256={}，expected_sha256={}。请重新 read 后再修改",
                            args.path, snapshot.sha256, expected
                        )
                        .into());
                }
                (
                    "overwrite",
                    snapshot.content,
                    Some(snapshot.sha256),
                    snapshot.bytes,
                    Some(snapshot.permissions),
                )
            }
            other => {
                return Err(
                    format!("write.mode 只支持 create 或 overwrite，实际为 '{other}'").into(),
                )
            }
        };

        atomic_write_text(&absolute_path, &args.content, permissions)?;
        let after_sha256 = sha256_hex(args.content.as_bytes());
        let diff = replacement_diff(
            &args.path,
            &[(
                1,
                diff_line_count(&before_content),
                1,
                before_content,
                args.content.clone(),
            )],
        );
        publish_file_change(
            self.bus.as_ref(),
            FileChangeRecord {
                path: &args.path,
                operation,
                before_sha256: before_sha256.as_deref(),
                after_sha256: &after_sha256,
                bytes_before: before_bytes,
                bytes_after: args.content.len(),
                diff: &diff,
            },
        )
        .await?;
        Ok(format!(
            "文件写入成功：operation={} path={} bytes={} sha256={}\n{}",
            operation,
            args.path,
            args.content.len(),
            after_sha256,
            bounded_text(&diff, 8_000)
        ))
    }
}

// ==========================================
// 2. ReadFileTool 工业级路径与权限容错
// ==========================================
pub struct ReadFileTool {
    permissions: Arc<PermissionBroker>,
}

impl ReadFileTool {
    pub fn new(config: Arc<PermissionConfig>) -> Self {
        Self {
            permissions: broker_from_config(config),
        }
    }

    pub fn new_with_permissions(permissions: Arc<PermissionBroker>) -> Self {
        Self { permissions }
    }
}

impl Default for ReadFileTool {
    fn default() -> Self {
        Self::new(Arc::new(PermissionConfig::default()))
    }
}

#[derive(Deserialize)]
struct ReadFileArgs {
    path: String,
    start_line: Option<usize>,
    end_line: Option<usize>,
    query: Option<String>,
    context_lines: Option<usize>,
    max_matches: Option<usize>,
}

#[async_trait::async_trait]
impl Tool for ReadFileTool {
    fn name(&self) -> &str {
        "read"
    }

    fn retry_safety(&self) -> ExecutionRetrySafety {
        ExecutionRetrySafety::Idempotent
    }

    fn definition(&self) -> ToolDefinition {
        let params_json = serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "要读取的文件路径，例如: test.txt"
                },
                "start_line": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "可选，1-based 起始行；与 end_line 配合精确读取"
                },
                "end_line": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "可选，1-based 包含式结束行"
                },
                "query": {
                    "type": "string",
                    "description": "可选，在文件中进行大小写不敏感的字面文本查询，并返回带行号的匹配上下文；查证具体实现时优先使用，避免重复读取整文件或调用 grep"
                },
                "context_lines": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 20,
                    "description": "query 每个匹配前后的上下文行数，默认 3"
                },
                "max_matches": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 100,
                    "description": "query 最多展示的匹配数，默认 20"
                }
            },
            "required": ["path"]
        });

        ToolDefinition {
            name: "read".to_string(),
            description: "读取指定路径的 UTF-8 文件，并始终返回 bytes 与 SHA-256 版本标识，供后续 edit/overwrite 使用。短文件可只传 path；长文件应使用 query 查找带行号的窄证据，或使用 start_line/end_line 精确分页。"
                .to_string(),
            parameters: params_json,
        }
    }

    fn approval_requirement(
        &self,
        arguments: &str,
    ) -> Result<Option<ApprovalRequirement>, Box<dyn std::error::Error + Send + Sync>> {
        let args: ReadFileArgs = serde_json::from_str(arguments)?;
        Ok(self
            .permissions
            .approval_requirement_for_path(&args.path, FilesystemAccess::Read, self.name(), "read")?
            .1)
    }

    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: ReadFileArgs = serde_json::from_str(arguments)?;
        let absolute_path = match self
            .permissions
            .authorize_path(
                &args.path,
                FilesystemAccess::Read,
                self.name(),
                "read",
                approval_context(),
            )
            .await
        {
            Ok(path) => path,
            Err(e) => return Ok(format!("系统报错：读取路径被权限策略拒绝：{}", e)),
        };

        if !absolute_path.exists() {
            return Ok(format!(
                "系统报错：读取失败。指定的文件路径 '{}' 不存在，请检查路径是否正确。",
                args.path
            ));
        }

        match tokio::fs::read_to_string(&absolute_path).await {
            Ok(content) => {
                let sha256 = sha256_hex(content.as_bytes());
                let header = format!(
                    "[path={}, bytes={}, sha256={}]\n",
                    args.path,
                    content.len(),
                    sha256
                );
                if args.query.is_none() && args.start_line.is_none() && args.end_line.is_none() {
                    return Ok(format!("{}{}", header, content));
                }
                Ok(format!("{}{}", header, select_file_lines(&content, &args)?))
            }
            Err(e) => {
                if e.kind() == std::io::ErrorKind::PermissionDenied {
                    return Ok(format!("系统报错：无权限读取文件 '{}'。请检查操作系统权限设置或更换有读取权限的路径。", absolute_path.display()));
                }
                Ok(format!(
                    "系统报错：读取文件 '{}' 失败，原因: {:?}",
                    absolute_path.display(),
                    e
                ))
            }
        }
    }
}

fn select_file_lines(
    content: &str,
    args: &ReadFileArgs,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let lines = content.lines().collect::<Vec<_>>();
    let total = lines.len();
    let start = args.start_line.unwrap_or(1);
    let end = args.end_line.unwrap_or(total).min(total);
    if start == 0 || (total > 0 && start > total) || end < start {
        return Err(format!(
            "无效行范围：start_line={}，end_line={}，文件共 {} 行",
            start, end, total
        )
        .into());
    }

    let mut selected = BTreeSet::new();
    let mut match_count = 0usize;
    let mut shown_matches = 0usize;
    if let Some(query) = args.query.as_deref() {
        let query = query.trim();
        if query.is_empty() {
            return Err("query 不能为空字符串".into());
        }
        let needle = query.to_lowercase();
        let context = args.context_lines.unwrap_or(3).min(20);
        let max_matches = args.max_matches.unwrap_or(20).clamp(1, 100);
        for line_number in start..=end {
            if lines[line_number - 1].to_lowercase().contains(&needle) {
                match_count += 1;
                if shown_matches < max_matches {
                    shown_matches += 1;
                    let context_start = line_number.saturating_sub(context).max(start);
                    let context_end = line_number.saturating_add(context).min(end);
                    selected.extend(context_start..=context_end);
                }
            }
        }
    } else if total > 0 {
        selected.extend(start..=end);
    }

    let mut output = if let Some(query) = args.query.as_deref() {
        format!(
            "[query={query:?}, matches={match_count}, shown={shown_matches}, lines={start}..{end}, total-lines={total}]\n"
        )
    } else {
        format!("[lines={start}..{end}, total-lines={total}]\n")
    };
    for line_number in selected {
        output.push_str(&format!(
            "{:>6} | {}\n",
            line_number,
            lines[line_number - 1]
        ));
    }
    Ok(output)
}

// ==========================================
// 3. EditFileTool — 带版本前提的精确局部编辑
// ==========================================
pub struct EditFileTool {
    permissions: Arc<PermissionBroker>,
    bus: Option<Arc<crate::event::InMemoryEventBus>>,
}

impl EditFileTool {
    pub fn new(config: Arc<PermissionConfig>) -> Self {
        Self {
            permissions: broker_from_config(config),
            bus: None,
        }
    }

    pub fn new_with_permissions(permissions: Arc<PermissionBroker>) -> Self {
        Self {
            permissions,
            bus: None,
        }
    }

    pub fn new_with_bus(
        config: Arc<PermissionConfig>,
        bus: Arc<crate::event::InMemoryEventBus>,
    ) -> Self {
        Self {
            permissions: broker_from_config(config),
            bus: Some(bus),
        }
    }

    pub fn new_with_runtime(
        permissions: Arc<PermissionBroker>,
        bus: Arc<crate::event::InMemoryEventBus>,
    ) -> Self {
        Self {
            permissions,
            bus: Some(bus),
        }
    }
}

#[derive(Deserialize)]
struct ExactEdit {
    old_text: String,
    new_text: String,
    #[serde(default)]
    replace_all: bool,
}

#[derive(Deserialize)]
struct EditFileArgs {
    path: String,
    expected_sha256: String,
    edits: Vec<ExactEdit>,
}

struct PlannedReplacement {
    start: usize,
    end: usize,
    old_text: String,
    new_text: String,
}

#[async_trait::async_trait]
impl Tool for EditFileTool {
    fn name(&self) -> &str {
        "edit"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "edit".to_string(),
            description: "对已读取的 UTF-8 文件执行带 SHA-256 版本前提的精确文本替换。默认要求 old_text 在原文件中唯一匹配；需要替换全部匹配时显式设置 replace_all=true。全部编辑先校验、再原子提交，成功后返回 diff/hash 并产生 file_change observation。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "工作区内已存在的文本文件" },
                    "expected_sha256": { "type": "string", "description": "最近一次 read 返回的完整 SHA-256" },
                    "edits": {
                        "type": "array",
                        "minItems": 1,
                        "items": {
                            "type": "object",
                            "properties": {
                                "old_text": { "type": "string", "minLength": 1, "description": "必须在原文件中精确出现的文本" },
                                "new_text": { "type": "string", "description": "替换后的文本；空字符串表示删除" },
                                "replace_all": { "type": "boolean", "default": false, "description": "false 时 old_text 必须唯一；true 时替换全部匹配" }
                            },
                            "required": ["old_text", "new_text"]
                        }
                    }
                },
                "required": ["path", "expected_sha256", "edits"]
            }),
        }
    }

    fn approval_requirement(
        &self,
        arguments: &str,
    ) -> Result<Option<ApprovalRequirement>, Box<dyn std::error::Error + Send + Sync>> {
        let args: EditFileArgs = serde_json::from_str(arguments)?;
        Ok(self
            .permissions
            .approval_requirement_for_path(
                &args.path,
                FilesystemAccess::Write,
                self.name(),
                "edit",
            )?
            .1)
    }

    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: EditFileArgs = serde_json::from_str(arguments)?;
        if args.edits.is_empty() {
            return Err("edit.edits 至少需要一项".into());
        }
        let absolute_path = self
            .permissions
            .authorize_path(
                &args.path,
                FilesystemAccess::Write,
                self.name(),
                "edit",
                approval_context(),
            )
            .await?;
        let snapshot = read_text_snapshot(&absolute_path)?;
        if snapshot.sha256 != args.expected_sha256 {
            return Err(format!(
                "文件版本冲突：'{}' 当前 sha256={}，expected_sha256={}。请重新 read 后再编辑",
                args.path, snapshot.sha256, args.expected_sha256
            )
            .into());
        }

        let mut replacements = Vec::new();
        for (index, edit) in args.edits.iter().enumerate() {
            if edit.old_text.is_empty() {
                return Err(format!("edit.edits[{index}].old_text 不能为空").into());
            }
            let matches = snapshot
                .content
                .match_indices(&edit.old_text)
                .map(|(start, _)| start)
                .collect::<Vec<_>>();
            if matches.is_empty() {
                return Err(format!(
                    "edit.edits[{index}] 的 old_text 在 '{}' 中没有精确匹配；请重新 read 并扩大上下文",
                    args.path
                )
                .into());
            }
            if !edit.replace_all && matches.len() != 1 {
                return Err(format!(
                    "edit.edits[{index}] 的 old_text 匹配 {} 次；默认编辑要求唯一匹配。请扩大 old_text 上下文，或明确设置 replace_all=true",
                    matches.len()
                )
                .into());
            }
            for start in matches
                .into_iter()
                .take(if edit.replace_all { usize::MAX } else { 1 })
            {
                replacements.push(PlannedReplacement {
                    start,
                    end: start + edit.old_text.len(),
                    old_text: edit.old_text.clone(),
                    new_text: edit.new_text.clone(),
                });
            }
        }
        replacements.sort_by_key(|replacement| replacement.start);
        for pair in replacements.windows(2) {
            if pair[0].end > pair[1].start {
                return Err("edit 中的两个替换范围发生重叠；请合并为一个更大的精确替换".into());
            }
        }

        let mut updated = String::with_capacity(snapshot.content.len());
        let mut cursor = 0usize;
        let mut line_delta = 0isize;
        let mut hunks = Vec::new();
        for replacement in &replacements {
            updated.push_str(&snapshot.content[cursor..replacement.start]);
            updated.push_str(&replacement.new_text);
            let old_start = snapshot.content[..replacement.start]
                .bytes()
                .filter(|byte| *byte == b'\n')
                .count()
                + 1;
            let new_start = old_start.saturating_add_signed(line_delta);
            let old_count = diff_line_count(&replacement.old_text);
            let new_count = diff_line_count(&replacement.new_text);
            hunks.push((
                old_start,
                old_count,
                new_start,
                replacement.old_text.clone(),
                replacement.new_text.clone(),
            ));
            line_delta += new_count as isize - old_count as isize;
            cursor = replacement.end;
        }
        updated.push_str(&snapshot.content[cursor..]);
        if updated == snapshot.content {
            return Err("edit 没有产生任何内容变化".into());
        }

        atomic_write_text(&absolute_path, &updated, Some(snapshot.permissions.clone()))?;
        let after_sha256 = sha256_hex(updated.as_bytes());
        let diff = replacement_diff(&args.path, &hunks);
        publish_file_change(
            self.bus.as_ref(),
            FileChangeRecord {
                path: &args.path,
                operation: "edit",
                before_sha256: Some(&snapshot.sha256),
                after_sha256: &after_sha256,
                bytes_before: snapshot.bytes,
                bytes_after: updated.len(),
                diff: &diff,
            },
        )
        .await?;
        Ok(format!(
            "文件编辑成功：path={} replacements={} bytes={} sha256={}\n{}",
            args.path,
            replacements.len(),
            updated.len(),
            after_sha256,
            bounded_text(&diff, 8_000)
        ))
    }
}

// ==========================================
// 4. ListFilesTool / SearchTool — 结构化代码发现
// ==========================================
pub struct ListFilesTool {
    permissions: Arc<PermissionBroker>,
}

impl ListFilesTool {
    pub fn new(config: Arc<PermissionConfig>) -> Self {
        Self {
            permissions: broker_from_config(config),
        }
    }

    pub fn new_with_permissions(permissions: Arc<PermissionBroker>) -> Self {
        Self { permissions }
    }
}

#[derive(Deserialize)]
struct ListFilesArgs {
    #[serde(default = "default_dot")]
    path: String,
    #[serde(default = "default_all_glob")]
    glob: String,
    #[serde(default = "default_list_limit")]
    max_results: usize,
    #[serde(default)]
    include_hidden: bool,
    #[serde(default)]
    include_directories: bool,
}

fn default_dot() -> String {
    ".".to_string()
}

fn default_all_glob() -> String {
    "**/*".to_string()
}

fn default_list_limit() -> usize {
    500
}

fn is_hidden_relative(path: &Path) -> bool {
    path.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(|part| part.starts_with('.') && part != ".")
    })
}

fn matches_glob(pattern: &Pattern, pattern_text: &str, relative: &str) -> bool {
    pattern.matches(relative)
        || pattern_text
            .strip_prefix("**/")
            .and_then(|tail| Pattern::new(tail).ok())
            .is_some_and(|tail| tail.matches(relative))
}

fn candidate_allowed(
    candidate: &Path,
    profile: &PermissionProfile,
    access: FilesystemAccess,
) -> bool {
    profile.path_allowed(candidate, access)
}

fn discovery_entries(
    root: &Path,
    include_hidden: bool,
    profile: &PermissionProfile,
) -> Vec<walkdir::DirEntry> {
    WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            entry.path() == root
                || include_hidden
                || !is_hidden_relative(entry.path().strip_prefix(root).unwrap_or(entry.path()))
        })
        .filter_map(Result::ok)
        .filter(|entry| entry.path() != root)
        .filter(|entry| candidate_allowed(entry.path(), profile, FilesystemAccess::Read))
        .collect()
}

#[async_trait::async_trait]
impl Tool for ListFilesTool {
    fn name(&self) -> &str {
        "list_files"
    }

    fn retry_safety(&self) -> ExecutionRetrySafety {
        ExecutionRetrySafety::Idempotent
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "list_files".to_string(),
            description: "在当前 Permission Profile 允许的目录内递归发现文件。支持 glob、结果上限和隐藏文件控制；用于代码导航，避免通过 exec/ls/find 产生不受控输出。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "default": ".", "description": "搜索根目录" },
                    "glob": { "type": "string", "default": "**/*", "description": "相对于 path 的 glob，例如 **/*.rs" },
                    "max_results": { "type": "integer", "minimum": 1, "maximum": 2000, "default": 500 },
                    "include_hidden": { "type": "boolean", "default": false },
                    "include_directories": { "type": "boolean", "default": false }
                }
            }),
        }
    }

    fn approval_requirement(
        &self,
        arguments: &str,
    ) -> Result<Option<ApprovalRequirement>, Box<dyn std::error::Error + Send + Sync>> {
        let args: ListFilesArgs = serde_json::from_str(arguments)?;
        Ok(self
            .permissions
            .approval_requirement_for_path(&args.path, FilesystemAccess::Read, self.name(), "list")?
            .1)
    }

    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: ListFilesArgs = serde_json::from_str(arguments)?;
        let root = self
            .permissions
            .authorize_path(
                &args.path,
                FilesystemAccess::Read,
                self.name(),
                "list",
                approval_context(),
            )
            .await?;
        if !root.is_dir() {
            return Err(format!("list_files.path '{}' 不是目录", args.path).into());
        }
        let pattern = Pattern::new(&args.glob)
            .map_err(|error| format!("无效 glob '{}': {}", args.glob, error))?;
        let limit = args.max_results.clamp(1, 2_000);
        let mut matches = Vec::new();
        let mut truncated = false;
        for entry in discovery_entries(
            &root,
            args.include_hidden,
            self.permissions.profile().as_ref(),
        ) {
            if !args.include_directories && !entry.file_type().is_file() {
                continue;
            }
            let relative = entry.path().strip_prefix(&root).unwrap_or(entry.path());
            let relative_text = relative.to_string_lossy().replace('\\', "/");
            if !matches_glob(&pattern, &args.glob, &relative_text) {
                continue;
            }
            if matches.len() == limit {
                truncated = true;
                break;
            }
            let kind = if entry.file_type().is_dir() {
                "dir"
            } else {
                "file"
            };
            let bytes = entry.metadata().ok().map(|metadata| metadata.len());
            matches.push(serde_json::json!({
                "path": relative_text,
                "kind": kind,
                "bytes": bytes,
            }));
        }
        Ok(serde_json::to_string_pretty(&serde_json::json!({
            "root": args.path,
            "glob": args.glob,
            "count": matches.len(),
            "truncated": truncated,
            "entries": matches,
        }))?)
    }
}

pub struct SearchTool {
    permissions: Arc<PermissionBroker>,
}

impl SearchTool {
    pub fn new(config: Arc<PermissionConfig>) -> Self {
        Self {
            permissions: broker_from_config(config),
        }
    }

    pub fn new_with_permissions(permissions: Arc<PermissionBroker>) -> Self {
        Self { permissions }
    }
}

#[derive(Deserialize)]
struct SearchArgs {
    query: String,
    paths: Vec<String>,
    #[serde(default = "default_all_glob")]
    glob: String,
    #[serde(default = "default_search_limit")]
    max_matches: usize,
    #[serde(default = "default_search_context")]
    context_lines: usize,
    #[serde(default)]
    case_sensitive: bool,
    #[serde(default)]
    include_hidden: bool,
}

fn default_search_limit() -> usize {
    100
}

fn default_search_context() -> usize {
    2
}

#[async_trait::async_trait]
impl Tool for SearchTool {
    fn name(&self) -> &str {
        "search"
    }

    fn retry_safety(&self) -> ExecutionRetrySafety {
        ExecutionRetrySafety::Idempotent
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "search".to_string(),
            description: "在当前 Permission Profile 允许的目录内对 UTF-8 源文件执行大小受限的字面文本搜索，返回路径、行号和上下文。用于定位代码，避免使用 exec/rg/grep。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "minLength": 1, "description": "字面搜索文本，不是正则表达式" },
                    "paths": { "type": "array", "minItems": 1, "items": { "type": "string" }, "description": "文件或目录列表" },
                    "glob": { "type": "string", "default": "**/*", "description": "目录内文件过滤，例如 **/*.rs" },
                    "max_matches": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 100 },
                    "context_lines": { "type": "integer", "minimum": 0, "maximum": 20, "default": 2 },
                    "case_sensitive": { "type": "boolean", "default": false },
                    "include_hidden": { "type": "boolean", "default": false }
                },
                "required": ["query", "paths"]
            }),
        }
    }

    fn approval_requirement(
        &self,
        arguments: &str,
    ) -> Result<Option<ApprovalRequirement>, Box<dyn std::error::Error + Send + Sync>> {
        let args: SearchArgs = serde_json::from_str(arguments)?;
        if args.paths.is_empty() {
            return Err("search.paths 至少需要一个路径".into());
        }
        let mut requested = CapabilityDelta::default();
        let mut targets = Vec::new();
        for input in &args.paths {
            if let Some(requirement) = self
                .permissions
                .approval_requirement_for_path(
                    input,
                    FilesystemAccess::Read,
                    self.name(),
                    "search",
                )?
                .1
            {
                for root in requirement.requested.read_roots {
                    if !requested.read_roots.contains(&root) {
                        requested.read_roots.push(root);
                    }
                }
                if let ApprovalAction::ToolOperation {
                    target: Some(target),
                    ..
                } = requirement.action
                {
                    targets.push(target);
                }
            }
        }
        self.permissions.approval_requirement_for_delta(
            ApprovalAction::ToolOperation {
                tool: self.name().to_string(),
                operation: "search".to_string(),
                target: None,
            },
            requested,
            format!(
                "工具 search 需要读取边界外路径：{}",
                targets
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )
    }

    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: SearchArgs = serde_json::from_str(arguments)?;
        if args.query.trim().is_empty() {
            return Err("search.query 不能为空".into());
        }
        if args.paths.is_empty() {
            return Err("search.paths 至少需要一个路径".into());
        }
        let pattern = Pattern::new(&args.glob)
            .map_err(|error| format!("无效 glob '{}': {}", args.glob, error))?;
        let limit = args.max_matches.clamp(1, 1_000);
        let context_lines = args.context_lines.min(20);
        let needle = if args.case_sensitive {
            args.query.clone()
        } else {
            args.query.to_lowercase()
        };
        let mut results = Vec::new();
        let mut truncated = false;

        'paths: for input in &args.paths {
            let resolved = self
                .permissions
                .authorize_path(
                    input,
                    FilesystemAccess::Read,
                    self.name(),
                    "search",
                    approval_context(),
                )
                .await?;
            let candidates = if resolved.is_file() {
                vec![(
                    resolved.clone(),
                    PathBuf::from(resolved.file_name().unwrap_or_default()),
                )]
            } else if resolved.is_dir() {
                discovery_entries(
                    &resolved,
                    args.include_hidden,
                    self.permissions.profile().as_ref(),
                )
                .into_iter()
                .filter(|entry| entry.file_type().is_file())
                .map(|entry| {
                    let relative = entry
                        .path()
                        .strip_prefix(&resolved)
                        .unwrap_or(entry.path())
                        .to_path_buf();
                    (entry.into_path(), relative)
                })
                .collect::<Vec<_>>()
            } else {
                return Err(format!("search 路径 '{}' 不存在", input).into());
            };

            for (path, relative) in candidates {
                let relative_text = relative.to_string_lossy().replace('\\', "/");
                if !matches_glob(&pattern, &args.glob, &relative_text) {
                    continue;
                }
                let metadata = match std::fs::metadata(&path) {
                    Ok(metadata) if metadata.len() <= 2 * 1024 * 1024 => metadata,
                    _ => continue,
                };
                let _ = metadata;
                let content = match std::fs::read_to_string(&path) {
                    Ok(content) => content,
                    Err(_) => continue,
                };
                let lines = content.lines().collect::<Vec<_>>();
                for (index, line) in lines.iter().enumerate() {
                    let haystack = if args.case_sensitive {
                        (*line).to_string()
                    } else {
                        line.to_lowercase()
                    };
                    if !haystack.contains(&needle) {
                        continue;
                    }
                    if results.len() == limit {
                        truncated = true;
                        break 'paths;
                    }
                    let line_number = index + 1;
                    let start = line_number.saturating_sub(context_lines).max(1);
                    let end = line_number.saturating_add(context_lines).min(lines.len());
                    let context = (start..=end)
                        .map(|number| {
                            serde_json::json!({
                                "line": number,
                                "text": lines[number - 1],
                            })
                        })
                        .collect::<Vec<_>>();
                    results.push(serde_json::json!({
                        "path": if resolved.is_file() { input.clone() } else { format!("{}/{}", input.trim_end_matches('/'), relative_text) },
                        "line": line_number,
                        "context": context,
                    }));
                }
            }
        }
        Ok(serde_json::to_string_pretty(&serde_json::json!({
            "query": args.query,
            "count": results.len(),
            "truncated": truncated,
            "matches": results,
        }))?)
    }
}

// ==========================================
// 5. ExecuteCommandTool 异步 Detach + 进程组级销毁
// ==========================================

pub struct ExecuteCommandTool {
    bus: Arc<crate::event::InMemoryEventBus>,
    background_config: Arc<BackgroundTaskConfig>,
    background_scheduler: Option<Arc<BackgroundTaskScheduler>>,
    permissions: Arc<PermissionBroker>,
    secret_store: Arc<crate::secret_store::SecretStore>,
    sandbox: NativeSandbox,
    max_sync_wait: tokio::time::Duration,
}

impl ExecuteCommandTool {
    pub fn new(bus: Arc<crate::event::InMemoryEventBus>) -> Self {
        Self::new_with_config(bus, Arc::new(BackgroundTaskConfig::default()))
    }

    pub fn new_with_config(
        bus: Arc<crate::event::InMemoryEventBus>,
        background_config: Arc<BackgroundTaskConfig>,
    ) -> Self {
        Self::new_with_configs(
            bus,
            background_config,
            Arc::new(PermissionConfig::default()),
            30,
        )
    }

    pub fn new_with_configs(
        bus: Arc<crate::event::InMemoryEventBus>,
        background_config: Arc<BackgroundTaskConfig>,
        config: Arc<PermissionConfig>,
        tool_timeout_secs: u64,
    ) -> Self {
        Self::new_with_runtime(
            bus,
            background_config,
            config,
            Arc::new(DenyAllApprovalProvider::new(
                "当前 ExecuteCommandTool 未配置审批提供者",
            )),
            tool_timeout_secs,
        )
    }

    pub fn new_with_runtime(
        bus: Arc<crate::event::InMemoryEventBus>,
        background_config: Arc<BackgroundTaskConfig>,
        config: Arc<PermissionConfig>,
        approval: Arc<dyn ApprovalProvider>,
        tool_timeout_secs: u64,
    ) -> Self {
        let profile = PermissionProfile::from_config(&config)
            .unwrap_or_else(|error| panic!("无效 PermissionConfig: {error}"));
        Self::new_with_permissions(
            bus,
            background_config,
            Arc::new(PermissionBroker::new(Arc::new(profile), approval)),
            tool_timeout_secs,
        )
    }

    pub fn new_with_permissions(
        bus: Arc<crate::event::InMemoryEventBus>,
        background_config: Arc<BackgroundTaskConfig>,
        permissions: Arc<PermissionBroker>,
        tool_timeout_secs: u64,
    ) -> Self {
        Self::new_with_permissions_and_scheduler(
            bus,
            background_config,
            permissions,
            tool_timeout_secs,
            None,
        )
    }

    pub fn new_with_permissions_and_scheduler(
        bus: Arc<crate::event::InMemoryEventBus>,
        background_config: Arc<BackgroundTaskConfig>,
        permissions: Arc<PermissionBroker>,
        tool_timeout_secs: u64,
        background_scheduler: Option<Arc<BackgroundTaskScheduler>>,
    ) -> Self {
        let secret_store = Arc::new(
            crate::secret_store::SecretStore::native_default()
                .expect("无法初始化默认 Secret Store metadata catalog"),
        );
        Self::new_with_permissions_scheduler_and_secret_store(
            bus,
            background_config,
            permissions,
            tool_timeout_secs,
            background_scheduler,
            secret_store,
        )
    }

    pub fn new_with_permissions_scheduler_and_secret_store(
        bus: Arc<crate::event::InMemoryEventBus>,
        background_config: Arc<BackgroundTaskConfig>,
        permissions: Arc<PermissionBroker>,
        tool_timeout_secs: u64,
        background_scheduler: Option<Arc<BackgroundTaskScheduler>>,
        secret_store: Arc<crate::secret_store::SecretStore>,
    ) -> Self {
        let max_sync_wait_ms = tool_timeout_secs
            .saturating_mul(1000)
            .saturating_sub(250)
            .max(100);
        Self {
            bus,
            background_config,
            background_scheduler,
            permissions,
            secret_store,
            sandbox: NativeSandbox::for_current_platform(),
            max_sync_wait: tokio::time::Duration::from_millis(max_sync_wait_ms),
        }
    }

    fn validate_secret_aliases(
        &self,
        names: &[String],
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        for name in validate_secret_env_names(names)? {
            if !self.secret_store.contains_alias(&name)? {
                return Err(format!(
                    "secret_env '{}' 在 Secret Store 或 Runtime bootstrap 环境中不存在",
                    name
                )
                .into());
            }
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum SandboxPermissionMode {
    #[default]
    UseDefault,
    RequireEscalated,
}

#[derive(Debug, Deserialize, Default)]
struct RequestedExecPermissions {
    #[serde(default)]
    network: bool,
    #[serde(default)]
    read_paths: Vec<String>,
    #[serde(default)]
    write_paths: Vec<String>,
    #[serde(default)]
    secret_env: Vec<String>,
}

fn requested_capability_delta(
    requested: &RequestedExecPermissions,
    profile: &PermissionProfile,
    base_policy: &SandboxPolicy,
) -> Result<CapabilityDelta, Box<dyn std::error::Error + Send + Sync>> {
    let canonical_base_reads = canonicalize_permission_roots(&base_policy.read_roots)?;
    let canonical_base_writes = canonicalize_permission_roots(&base_policy.write_roots)?;
    let mut delta = CapabilityDelta {
        network: requested.network && base_policy.network == NetworkPolicy::Deny,
        secret_env: validate_secret_env_names(&requested.secret_env)?,
        ..CapabilityDelta::default()
    };

    for input in &requested.write_paths {
        let root = profile.canonical_permission_root(input)?;
        if !path_is_covered_by(&root, &canonical_base_writes) {
            push_unique_permission_root(&mut delta.write_roots, root);
        }
    }

    for input in &requested.read_paths {
        let root = profile.canonical_permission_root(input)?;
        if path_is_covered_by(&root, &canonical_base_reads)
            || path_is_covered_by(&root, &delta.write_roots)
        {
            continue;
        }
        push_unique_permission_root(&mut delta.read_roots, root);
    }

    Ok(delta)
}

fn validate_secret_env_names(
    names: &[String],
) -> Result<Vec<String>, Box<dyn std::error::Error + Send + Sync>> {
    let mut validated = Vec::new();
    for name in names {
        let normalized = name.trim();
        if normalized.is_empty()
            || !normalized
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_')
        {
            return Err(format!("secret_env 包含非法环境变量名 '{name}'").into());
        }
        if !validated.iter().any(|existing| existing == normalized) {
            validated.push(normalized.to_string());
        }
    }
    Ok(validated)
}

fn canonicalize_permission_roots(
    roots: &[PathBuf],
) -> Result<Vec<PathBuf>, Box<dyn std::error::Error + Send + Sync>> {
    roots
        .iter()
        .map(|root| {
            std::fs::canonicalize(root).map_err(|error| {
                format!("无法解析当前沙箱权限目录 '{}': {error}", root.display()).into()
            })
        })
        .collect()
}

fn path_is_covered_by(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| path.starts_with(root))
}

fn push_unique_permission_root(roots: &mut Vec<PathBuf>, root: PathBuf) {
    if !roots.iter().any(|existing| existing == &root) {
        roots.push(root);
    }
}

fn apply_capability_delta(policy: &mut SandboxPolicy, delta: &CapabilityDelta) {
    if delta.network {
        policy.network = NetworkPolicy::Allow;
    }
    for root in &delta.read_roots {
        policy.add_read_root(root.clone());
    }
    for root in &delta.write_roots {
        policy.add_write_root(root.clone());
    }
}

fn contains_unquoted_background_operator(command: &str) -> bool {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Quote {
        None,
        Single,
        Double,
    }

    let chars = command.chars().collect::<Vec<_>>();
    let mut quote = Quote::None;
    let mut index = 0;
    while index < chars.len() {
        let current = chars[index];
        match quote {
            Quote::Single => {
                if current == '\'' {
                    quote = Quote::None;
                }
                index += 1;
            }
            Quote::Double => {
                if current == '\\' {
                    index = (index + 2).min(chars.len());
                } else {
                    if current == '"' {
                        quote = Quote::None;
                    }
                    index += 1;
                }
            }
            Quote::None => match current {
                '\\' => index = (index + 2).min(chars.len()),
                '\'' => {
                    quote = Quote::Single;
                    index += 1;
                }
                '"' => {
                    quote = Quote::Double;
                    index += 1;
                }
                '#' if index == 0
                    || chars[index - 1].is_whitespace()
                    || matches!(chars[index - 1], ';' | '|' | '&' | '(' | ')') =>
                {
                    while index < chars.len() && chars[index] != '\n' {
                        index += 1;
                    }
                }
                '&' => {
                    let previous = index.checked_sub(1).and_then(|i| chars.get(i)).copied();
                    let next = chars.get(index + 1).copied();
                    if next == Some('&') {
                        index += 2;
                    } else if matches!(previous, Some('>') | Some('<')) || next == Some('>') {
                        // File-descriptor duplication (`2>&1`, `<&0`) and `&>` redirection
                        // are not process detachment.
                        index += 1;
                    } else {
                        return true;
                    }
                }
                _ => index += 1,
            },
        }
    }
    false
}

fn validate_managed_shell_command(
    command: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if contains_unquoted_background_operator(command) {
        return Err(
            "exec 禁止使用 Shell '&' 自行创建非托管后台进程。请直接执行前台命令；超过 wait_ms 后 Runtime 会自动转入后台并返回 task_id。"
                .into(),
        );
    }
    Ok(())
}

fn terminate_residual_process_group(
    pgid: i32,
) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    let pgid = nix::unistd::Pid::from_raw(pgid);
    match nix::sys::signal::killpg(pgid, None) {
        Ok(()) => {
            nix::sys::signal::killpg(pgid, nix::sys::signal::Signal::SIGKILL)?;
            Ok(true)
        }
        Err(nix::errno::Errno::ESRCH) => Ok(false),
        Err(error) => Err(format!("检查 exec 残留进程组失败: {error}").into()),
    }
}

/// Fail-closed lifetime guard for one foreground shell process group.
///
/// A physical Tool future can be cancelled by an Objective fence, an Edge
/// command cancellation or Runtime shutdown. Dropping `tokio::process::Child`
/// alone is not a sufficient process-tree boundary: descendants may keep
/// running after the shell exits. Keeping this guard in the same future makes
/// cancellation terminate the whole process group even when normal async
/// cleanup code is never polled again.
struct ProcessGroupGuard {
    pgid: i32,
    armed: bool,
    task_id: Option<String>,
}

impl ProcessGroupGuard {
    fn new(pgid: i32) -> Self {
        Self {
            pgid,
            armed: true,
            task_id: None,
        }
    }

    fn track_task(&mut self, task_id: &str) {
        self.task_id = Some(task_id.to_string());
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for ProcessGroupGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let _ = nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(self.pgid),
            nix::sys::signal::Signal::SIGKILL,
        );
        if let Some(task_id) = self.task_id.as_deref() {
            get_tasks_map().remove(task_id);
        }
    }
}

/// Establish the physical boundary shared by every non-interactive `exec`.
///
/// Piping stdout/stderr is not enough to make a child non-interactive. Programs
/// such as OpenSSH may bypass stdin and open the process's controlling
/// `/dev/tty` directly for host-key or password prompts. A detached session
/// makes that open fail immediately, while null stdin gives ordinary prompt
/// readers EOF. `setsid` also creates the process group that
/// `ProcessGroupGuard` owns, so cancellation can still terminate the complete
/// descendant tree.
fn configure_noninteractive_process(command: &mut tokio::process::Command) {
    command
        .stdin(std::process::Stdio::null())
        .env("SSH_ASKPASS_REQUIRE", "never");
    unsafe {
        command.pre_exec(|| {
            if nix::libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecuteCommandArgs {
    command: String,
    cwd: Option<String>,
    wait_ms: Option<u64>,
    #[serde(default)]
    keep_running: bool,
    #[serde(default)]
    sandbox_permissions: SandboxPermissionMode,
    #[serde(default)]
    requested_permissions: RequestedExecPermissions,
    justification: Option<String>,
}

fn boundary_remediation(permission_request_available: bool, network_enabled: bool) -> String {
    if !permission_request_available {
        return "当前 Permission Profile 不允许申请额外能力；不要重复调用。".to_string();
    }
    let network = if network_enabled {
        "当前网络已启用；不要把普通网络服务错误误判为沙箱拒绝。"
    } else {
        "当前网络未启用。"
    };
    format!(
        "{network} 仅当 stderr/事实明确表明失败源于缺少网络、边界外目录或秘密环境变量时，才用同一条必要命令重试一次：sandbox_permissions=require_escalated，requested_permissions 只列最小能力，并提供 justification。protected_paths 或审批拒绝不可覆盖。"
    )
}

#[async_trait::async_trait]
impl Tool for ExecuteCommandTool {
    fn name(&self) -> &str {
        "exec"
    }

    fn definition(&self) -> ToolDefinition {
        let params_json = serde_json::json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "要在本地终端执行的前台 Shell 命令，例如 'cargo test' 或 'ls'。秘密应通过 requested_permissions.secret_env 按环境变量名注入；禁止用 '&' 自行后台化。"
                },
                "cwd": {
                    "type": "string",
                    "description": "可选，命令工作目录；默认 workspace_root。边界外目录必须配合 require_escalated 申请最小权限。"
                },
                "wait_ms": {
                    "type": "integer",
                    "description": "同步等待输出的最长超时毫秒数。默认 10000 毫秒；测试/编译超过该时长后自动转入后台异步运行。"
                },
                "keep_running": {
                    "type": "boolean",
                    "description": "默认 false。设为 true 表示这个进程是要一直留着的常驻服务（dev server、watcher、后端进程），本回合不等它结束；Runtime 因此不会把它当作未完成的工作而阻止回合收口。编译、测试、脚本这类最终会退出、且结果本回合需要的命令必须保持 false。"
                },
                "sandbox_permissions": {
                    "type": "string",
                    "enum": ["use_default", "require_escalated"],
                    "description": "默认 use_default，在当前原生沙箱内运行。若回执和 stderr 明确证明失败源于缺少网络、边界外目录或秘密环境变量，且能力确为当前任务所必需，可用同一条必要命令和 require_escalated 重试一次；普通命令失败、protected_paths 或审批拒绝不得盲目重试。"
                },
                "requested_permissions": {
                    "type": "object",
                    "description": "require_escalated 时申请的最小额外能力。审批只对本次准确命令有效，不能申请关闭沙箱。",
                    "properties": {
                        "network": {
                            "type": "boolean",
                            "description": "是否申请本次命令访问网络。"
                        },
                        "read_paths": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "额外只读目录；相对路径按 workspace_root 解析。"
                        },
                        "write_paths": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "额外可写目录；相对路径按 workspace_root 解析。"
                        },
                        "secret_env": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "需要注入本次子进程的敏感环境变量名。只传名称，不得把值写入 command；必须经过一次性审批。"
                        }
                    },
                    "additionalProperties": false
                },
                "justification": {
                    "type": "string",
                    "description": "require_escalated 时必填：说明额外能力与当前用户任务的直接关系。"
                }
            },
            "required": ["command"]
        });

        ToolDefinition {
            name: "exec".to_string(),
            description: "在当前操作系统的原生沙箱中执行 Shell 命令，默认仅允许配置的工作区路径且禁止网络。适合运行测试、编译和格式化；文件发现优先使用 list_files/search，修改优先使用 edit/write。禁止在本地 Target 直接调用 ssh/scp/sftp；远程命令必须先解析 managed_ssh Target，再把目标 ID 作为 target 参数传给 exec，由 Runtime 受管连接。确需其他网络、目录或秘密环境变量时，使用 require_escalated 申请最小能力，由独立审批者决定；若默认执行因明确的边界拒绝失败，回执会说明申请方式。命令等待超时后由 Runtime 转为后台托管；禁止通过 '&' 自行创建非托管后台进程。".to_string(),
            parameters: params_json,
        }
    }

    fn approval_requirement(
        &self,
        arguments: &str,
    ) -> Result<Option<ApprovalRequirement>, Box<dyn std::error::Error + Send + Sync>> {
        let args: ExecuteCommandArgs = serde_json::from_str(arguments)?;
        self.validate_secret_aliases(&args.requested_permissions.secret_env)?;
        let command = args.command.trim();
        validate_managed_shell_command(command)?;
        let profile = self.permissions.profile();
        if profile.sandbox_mode != SandboxMode::WorkspaceWrite {
            return Ok(None);
        }
        let cwd_input = args.cwd.as_deref().unwrap_or(".");
        let resolved_cwd = profile.resolve_candidate(cwd_input)?;
        if resolved_cwd.protected {
            return Err(format!(
                "exec.cwd '{}' 命中不可覆盖的 protected_paths 规则",
                cwd_input
            )
            .into());
        }
        if !resolved_cwd.candidate.is_dir() {
            return Err(format!("exec.cwd '{}' 不是已存在目录", cwd_input).into());
        }
        let exec_cwd = std::fs::canonicalize(&resolved_cwd.candidate)?;
        let policy = SandboxPolicy {
            read_roots: profile.read_roots.clone(),
            write_roots: profile.write_roots.clone(),
            denied_read_paths: Vec::new(),
            denied_write_paths: Vec::new(),
            denied_read_patterns: Vec::new(),
            denied_write_patterns: Vec::new(),
            network: if profile.network {
                NetworkPolicy::Allow
            } else {
                NetworkPolicy::Deny
            },
            fail_closed: true,
        };
        let mut requested =
            requested_capability_delta(&args.requested_permissions, profile.as_ref(), &policy)?;
        let canonical_reads = canonicalize_permission_roots(&policy.read_roots)?;
        let canonical_writes = canonicalize_permission_roots(&policy.write_roots)?;
        if !path_is_covered_by(&exec_cwd, &canonical_reads)
            && !path_is_covered_by(&exec_cwd, &canonical_writes)
            && !path_is_covered_by(&exec_cwd, &requested.read_roots)
            && !path_is_covered_by(&exec_cwd, &requested.write_roots)
        {
            push_unique_permission_root(&mut requested.read_roots, exec_cwd.clone());
        }
        match args.sandbox_permissions {
            SandboxPermissionMode::UseDefault if !requested.is_empty() => Err(
                "requested_permissions 只能与 sandbox_permissions=require_escalated 一起使用"
                    .into(),
            ),
            SandboxPermissionMode::RequireEscalated if !requested.is_empty() => {
                let justification = args
                    .justification
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or("require_escalated 必须提供非空 justification")?;
                self.permissions.approval_requirement_for_delta(
                    ApprovalAction::Shell {
                        command: command.to_string(),
                        cwd: exec_cwd,
                    },
                    requested,
                    justification.to_string(),
                )
            }
            SandboxPermissionMode::RequireEscalated | SandboxPermissionMode::UseDefault => Ok(None),
        }
    }

    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        // `exec` is also wrapped by the orchestrator's whole-tool timeout. Permission review,
        // sandbox preparation and process spawning consume part of that same budget, so the
        // synchronous child wait must be measured from tool entry rather than process start.
        // Otherwise an approval delay can let the outer timeout cancel this future while the
        // child is still in `Starting`, before its background watcher has been installed.
        let sync_budget_started_at = tokio::time::Instant::now();
        let args: ExecuteCommandArgs = serde_json::from_str(arguments)?;
        self.validate_secret_aliases(&args.requested_permissions.secret_env)?;
        let cmd_trimmed = args.command.trim();
        validate_managed_shell_command(cmd_trimmed)?;

        let mut request_context = approval_context();
        let mut session_id = request_context.session_id.clone();
        if session_id.is_empty() {
            if let Ok(fallback_id) = CURRENT_SESSION_ID.try_with(|id| id.clone()) {
                session_id = fallback_id;
            }
        }
        if session_id.is_empty() {
            session_id = "default_session".to_string();
        }
        let context_id = CURRENT_CONTEXT_ID
            .try_with(Clone::clone)
            .unwrap_or_else(|_| session_id.clone());
        let attempt_id = CURRENT_ATTEMPT_ID
            .try_with(Clone::clone)
            .unwrap_or_else(|_| "unknown-attempt".to_string());
        let causal_route = CURRENT_CAUSAL_ROUTE.try_with(Clone::clone).ok().flatten();
        let initiating_principal_id = CURRENT_PRINCIPAL_ID.try_with(Clone::clone).ok().flatten();
        let execution_job_context = CURRENT_EXECUTION_JOB.try_with(Clone::clone).ok().flatten();
        request_context.session_id = session_id.clone();
        request_context.context_id = context_id.clone();
        request_context.attempt_id = attempt_id.clone();

        use std::process::Stdio;
        let cwd_input = args.cwd.as_deref().unwrap_or(".");
        let profile = self.permissions.profile();
        let permission_request_available = profile.permission_request_available();
        let resolved_cwd = profile.resolve_candidate(cwd_input)?;
        if resolved_cwd.protected {
            return Err(format!(
                "exec.cwd '{}' 命中不可覆盖的 protected_paths 规则",
                cwd_input
            )
            .into());
        }
        let exec_cwd = resolved_cwd.candidate;
        if !exec_cwd.is_dir() {
            return Err(format!("exec.cwd '{}' 不是已存在目录", cwd_input).into());
        }
        let exec_cwd = std::fs::canonicalize(&exec_cwd)?;
        let workspace_root = profile.workspace_root.clone();

        let sandbox_tmp = workspace_root.join(".morphz/tmp");
        std::fs::create_dir_all(&sandbox_tmp)?;
        let runtime_managed_ssh = CURRENT_RUNTIME_MANAGED_SSH
            .try_with(|enabled| *enabled)
            .unwrap_or(false);
        if !runtime_managed_ssh {
            // Keep this check at the physical exec boundary as well as in the
            // orchestrator preflight. ExecuteCommandTool is also used by tests
            // and embedding callers that do not necessarily pass through that
            // preflight. The transport policy must hold at every entry point.
            crate::execution_target::reject_unmanaged_ssh_invocation(
                crate::execution_target::DEFAULT_EXECUTION_TARGET_ID,
                "exec",
                arguments,
            )?;
        }
        let (prepared, effective_network, approved_secret_env) = if runtime_managed_ssh {
            if !cmd_trimmed.starts_with("'ssh' ")
                || !args.requested_permissions.network
                || !args.requested_permissions.write_paths.is_empty()
                || args.sandbox_permissions != SandboxPermissionMode::RequireEscalated
                || args
                    .requested_permissions
                    .secret_env
                    .iter()
                    .any(|name| name != "SSH_AUTH_SOCK")
            {
                return Err(
                    "Runtime Managed SSH authority 只允许内部生成的 ssh 命令及固定网络/ssh-agent 能力"
                        .into(),
                );
            }
            (
                self.sandbox.prepare_unconfined_shell(cmd_trimmed),
                true,
                validate_secret_env_names(&args.requested_permissions.secret_env)?,
            )
        } else if profile.sandbox_mode == SandboxMode::WorkspaceWrite {
            let mut policy = SandboxPolicy {
                read_roots: profile.read_roots.clone(),
                write_roots: profile.write_roots.clone(),
                denied_read_paths: Vec::new(),
                denied_write_paths: Vec::new(),
                denied_read_patterns: Vec::new(),
                denied_write_patterns: Vec::new(),
                network: if profile.network {
                    NetworkPolicy::Allow
                } else {
                    NetworkPolicy::Deny
                },
                fail_closed: true,
            };
            policy.network = if profile.network {
                NetworkPolicy::Allow
            } else {
                NetworkPolicy::Deny
            };

            let mut requested =
                requested_capability_delta(&args.requested_permissions, profile.as_ref(), &policy)?;
            let canonical_reads = canonicalize_permission_roots(&policy.read_roots)?;
            let canonical_writes = canonicalize_permission_roots(&policy.write_roots)?;
            if !path_is_covered_by(&exec_cwd, &canonical_reads)
                && !path_is_covered_by(&exec_cwd, &canonical_writes)
                && !path_is_covered_by(&exec_cwd, &requested.read_roots)
                && !path_is_covered_by(&exec_cwd, &requested.write_roots)
            {
                push_unique_permission_root(&mut requested.read_roots, exec_cwd.clone());
            }
            match args.sandbox_permissions {
                SandboxPermissionMode::UseDefault if !requested.is_empty() => {
                    return Err("requested_permissions 只能与 sandbox_permissions=require_escalated 一起使用".into());
                }
                SandboxPermissionMode::RequireEscalated if !requested.is_empty() => {
                    let justification = args
                        .justification
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .ok_or("require_escalated 必须提供非空 justification")?;
                    self.permissions
                        .authorize_delta(
                            ApprovalAction::Shell {
                                command: cmd_trimmed.to_string(),
                                cwd: exec_cwd.clone(),
                            },
                            requested.clone(),
                            justification.to_string(),
                            request_context,
                        )
                        .await?;
                    apply_capability_delta(&mut policy, &requested);
                }
                SandboxPermissionMode::RequireEscalated | SandboxPermissionMode::UseDefault => {}
            }
            let protected = profile.sandbox_protected_patterns(&policy.read_roots);
            for pattern in protected {
                policy.deny_pattern(pattern);
            }
            let effective_network = policy.network == NetworkPolicy::Allow;
            let prepared = self.sandbox.prepare_shell(&ShellRequest {
                command: cmd_trimmed.to_string(),
                cwd: exec_cwd.clone(),
                policy,
            })?;
            (prepared, effective_network, requested.secret_env)
        } else {
            (
                self.sandbox.prepare_unconfined_shell(cmd_trimmed),
                true,
                validate_secret_env_names(&args.requested_permissions.secret_env)?,
            )
        };
        tracing::info!(
            backend = prepared.report.backend.as_str(),
            status = ?prepared.report.status,
            network_enabled = effective_network,
            "已为 exec 准备操作系统执行边界"
        );
        let sandbox_backend = prepared.report.backend.as_str().to_string();
        let sandbox_status = match prepared.report.status {
            EnforcementStatus::Enforced => "enforced",
            EnforcementStatus::Unavailable => "unavailable",
        }
        .to_string();
        let mut cmd = prepared.into_tokio_command();
        cmd.current_dir(&exec_cwd)
            .env("TMPDIR", &sandbox_tmp)
            .kill_on_drop(true)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_noninteractive_process(&mut cmd);
        if profile.shell_environment_policy == ShellEnvironmentPolicy::RemoveSensitive {
            for (key, _) in std::env::vars() {
                if is_sensitive_environment_name(&key) {
                    cmd.env_remove(key);
                }
            }
        }
        let effective_secret_env = approved_secret_env.clone();
        let objective_id = CURRENT_OBJECTIVE_ID.try_with(Clone::clone).ok().flatten();
        let target_id = execution_job_context
            .as_ref()
            .map(|job| job.target_id.clone());
        let secret_store = Arc::clone(&self.secret_store);
        let secret_context_id = context_id.clone();
        let secret_session_id = session_id.clone();
        let resolved_secret_env =
            tokio::task::spawn_blocking(move || -> Result<Vec<(String, String)>, String> {
                approved_secret_env
                    .into_iter()
                    .map(|name| {
                        let value = secret_store
                            .resolve(
                                &name,
                                crate::secret_store::SecretUseContext {
                                    context_id: Some(&secret_context_id),
                                    session_id: Some(&secret_session_id),
                                    objective_id: objective_id.as_deref(),
                                    target_id: target_id.as_deref(),
                                },
                            )?
                            .ok_or_else(|| format!("secret_env '{}' 在 Runtime 中不存在", name))?;
                        Ok((name, value))
                    })
                    .collect()
            })
            .await
            .map_err(|error| format!("Secret Store 阻塞任务异常终止：{error}"))??;
        let mut injected_secret_values = Vec::with_capacity(resolved_secret_env.len());
        for (name, value) in resolved_secret_env {
            cmd.env(&name, &value);
            injected_secret_values.push(value);
        }

        let artifact_dir = std::path::PathBuf::from(&self.background_config.artifact_dir);
        std::fs::create_dir_all(&artifact_dir).map_err(|error| {
            format!(
                "无法创建 exec 原始输出归档目录 '{}': {}",
                artifact_dir.display(),
                error
            )
        })?;

        if let (Some(scheduler), Some(parent)) =
            (&self.background_scheduler, execution_job_context.as_ref())
        {
            if scheduler.execution_jobs.is_some() {
                scheduler
                    .ensure_parent_accepts_background_child(parent)
                    .await?;
            }
        }

        let mut child = cmd.spawn()?;
        let pid = child.id().ok_or("无法获取进程 ID")? as i32;
        let mut process_group_guard = ProcessGroupGuard::new(pid);

        let task_id = match (
            self.background_scheduler.as_ref(),
            execution_job_context.as_ref(),
        ) {
            (Some(scheduler), Some(parent)) if scheduler.execution_jobs.is_some() => {
                scheduler.durable_task_identity(parent)?.0
            }
            _ => format!(
                "task_{}_{}",
                chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
                pid
            ),
        };
        let archive_path = artifact_dir.join(format!("{}.log", task_id));
        process_group_guard.track_task(&task_id);
        // Publish the live PGID immediately after spawn. Objective cancellation
        // can now always find this process even while archive/pipes/background
        // attachment are still being prepared.
        let tasks = get_tasks_map();
        let now = chrono::Utc::now();
        tasks.insert(
            task_id.clone(),
            BackgroundTask {
                id: task_id.clone(),
                cmd_str: cmd_trimmed.to_string(),
                pgid: pid,
                session_id: session_id.clone(),
                context_id: context_id.clone(),
                initiating_principal_id: initiating_principal_id.clone(),
                causal_route: causal_route.clone(),
                keep_running: args.keep_running,
                started_at: now,
                last_output_at: now,
                output_bytes: 0,
                output_tail: String::new(),
                wake_generation: 0,
                next_wakeup_at: None,
                status: BackgroundTaskStatus::Starting,
                effective_network,
                permission_request_available,
                secret_env: effective_secret_env.clone(),
                sandbox_backend: sandbox_backend.clone(),
                sandbox_status: sandbox_status.clone(),
                artifact_path: archive_path.to_string_lossy().to_string(),
                ended_at: None,
                exit_code: None,
            },
        );
        if let (Some(scheduler), Some(parent)) =
            (&self.background_scheduler, execution_job_context.as_ref())
        {
            if scheduler.execution_jobs.is_some() {
                if let Err(error) = scheduler
                    .ensure_parent_accepts_background_child(parent)
                    .await
                {
                    if let Some(mut task) = tasks.get_mut(&task_id) {
                        task.status = BackgroundTaskStatus::KillRequested;
                    }
                    let _ = nix::sys::signal::killpg(
                        nix::unistd::Pid::from_raw(pid),
                        nix::sys::signal::Signal::SIGKILL,
                    );
                    let _ = child.wait().await;
                    tasks.remove(&task_id);
                    return Err(error);
                }
            }
        }
        let archive = match std::fs::File::create(&archive_path) {
            Ok(archive) => archive,
            Err(error) => {
                let _ = nix::sys::signal::killpg(
                    nix::unistd::Pid::from_raw(pid),
                    nix::sys::signal::Signal::SIGKILL,
                );
                let _ = child.wait().await;
                tasks.remove(&task_id);
                return Err(format!(
                    "无法创建 exec 原始输出归档 '{}': {}",
                    archive_path.display(),
                    error
                )
                .into());
            }
        };

        let stdout = child.stdout.take().ok_or("无法捕获 stdout 管道")?;
        let stderr = child.stderr.take().ok_or("无法捕获 stderr 管道")?;

        let bus_clone = Arc::clone(&self.bus);
        let session_id_clone = session_id.clone();
        let context_id_clone = context_id.clone();
        let task_id_clone = task_id.clone();

        // 共享缓冲区
        let buffer = Arc::new(ExecutionBuffer {
            output: std::sync::Mutex::new(String::new()),
            archive: std::sync::Mutex::new(archive),
            event_pending: std::sync::Mutex::new(String::new()),
            archive_path: archive_path.to_string_lossy().to_string(),
            truncated: AtomicBool::new(false),
            event_flush_scheduled: AtomicBool::new(false),
            max_bytes: self.background_config.max_output_buffer_bytes,
            event_coalesce_ms: self.background_config.output_event_coalesce_ms,
            max_event_chars: self.background_config.max_output_event_chars,
            injected_secret_values,
            task_id: task_id_clone.clone(),
            bus: bus_clone,
            session_id: session_id_clone,
            context_id: context_id_clone,
            initiating_principal_id: initiating_principal_id.clone(),
            causal_route: causal_route.clone(),
        });

        // 共享的“是否开启事件发布”标志 (前 N 秒同步时不发布，转入后台时才发布)
        let publish_flag = Arc::new(AtomicBool::new(false));
        let output_sink = CURRENT_TOOL_OUTPUT_SINK
            .try_with(Clone::clone)
            .ok()
            .flatten();

        let buffer_out = Arc::clone(&buffer);
        let publish_out = Arc::clone(&publish_flag);
        let stdout_sink = output_sink.clone();
        let stdout_task = tokio::spawn(async move {
            monitor_pipe(
                stdout,
                buffer_out,
                publish_out,
                EdgeOutputStream::Stdout,
                stdout_sink,
            )
            .await;
        });

        let buffer_err = Arc::clone(&buffer);
        let publish_err = Arc::clone(&publish_flag);
        let stderr_task = tokio::spawn(async move {
            monitor_pipe(
                stderr,
                buffer_err,
                publish_err,
                EdgeOutputStream::Stderr,
                output_sink,
            )
            .await;
        });

        // 同步等待设定时间
        let requested_wait = tokio::time::Duration::from_millis(args.wait_ms.unwrap_or(10_000));
        let remaining_sync_budget = self
            .max_sync_wait
            .saturating_sub(sync_budget_started_at.elapsed());
        let wait_duration = requested_wait.min(remaining_sync_budget);
        let wait_result = tokio::time::timeout(wait_duration, child.wait()).await;

        match wait_result {
            Ok(exit_status_res) => {
                // 命令在同步时间内直接执行完成
                tasks.remove(&task_id);
                process_group_guard.disarm();
                // `/bin/sh -c 'command &'` can exit while descendants keep running. The lexical
                // guard above catches normal cases; this process-group check is the fail-closed
                // backstop for dynamically constructed shell commands.
                let residual_processes_terminated = terminate_residual_process_group(pid)?;
                // 进程退出不代表异步 pipe reader 已经消费完内核管道；必须等待两条 reader
                // 完成后再读取 preview，才能保证归档文件和返回结果包含尾部输出。
                let _ = stdout_task.await;
                let _ = stderr_task.await;
                let code = exit_status_res
                    .map(|s| s.code().unwrap_or(-1))
                    .unwrap_or(-1);
                let output_str = buffer.get_all();
                let boundary_remediation = (code != 0)
                    .then(|| boundary_remediation(permission_request_available, effective_network));
                if residual_processes_terminated {
                    return Err(format!(
                        "exec 检测到 Shell 主进程退出后仍有子进程存活，已终止整个残留进程组。禁止自行后台化；请让前台命令运行超过 wait_ms，由 Runtime 托管。\n--- 已捕获输出 ---\n{output_str}"
                    )
                    .into());
                }
                Ok(serde_json::json!({
                    "kind": "exec_result",
                    "execution": "completed",
                    "process_status": if code == 0 { "succeeded" } else { "failed" },
                    "exit_code": code,
                    "effective_boundary": {
                        "network_enabled": effective_network,
                        "permission_request_available": permission_request_available,
                        "secret_env": effective_secret_env,
                        "sandbox_backend": sandbox_backend,
                        "sandbox_status": sandbox_status,
                    },
                    "artifact_path": buffer.archive_path,
                    "output_empty": output_str.is_empty(),
                    "output": output_str,
                    "boundary_remediation": boundary_remediation,
                })
                .to_string())
            }
            Err(_) => {
                // 运行超时，正式脱离 (Detach) 为后台长任务
                if let (Some(scheduler), Some(parent)) =
                    (&self.background_scheduler, execution_job_context.as_ref())
                {
                    if scheduler.execution_jobs.is_some() {
                        if let Err(error) = scheduler.attach_execution_job(&task_id, parent).await {
                            let _ = nix::sys::signal::killpg(
                                nix::unistd::Pid::from_raw(pid),
                                nix::sys::signal::Signal::SIGKILL,
                            );
                            let _ = child.wait().await;
                            let _ = stdout_task.await;
                            let _ = stderr_task.await;
                            tasks.remove(&task_id);
                            return Err(format!(
                                "后台进程未能交接给持久 ExecutionJob，已终止进程组: {error}"
                            )
                            .into());
                        }
                    }
                }
                publish_flag.store(true, Ordering::SeqCst);
                if let Some(mut task) = tasks.get_mut(&task_id) {
                    task.status = BackgroundTaskStatus::Running;
                }

                // 可选 watchdog 检查点只唤醒 LLM，不自动 kill。默认关闭；正常路径
                // 只依赖任务完成事件。Agent 有明确监督期限时可用 check_task_after
                // 覆盖下一次检查时间，或调用 kill_task。
                if self.background_config.timeout_notify_enabled {
                    if let Some(scheduler) = &self.background_scheduler {
                        let _ = scheduler
                            .schedule(
                                &task_id,
                                self.background_config.timeout_notify_secs.max(1),
                                "runtime_default",
                            )
                            .await;
                    }
                }

                // 启动一个后台协程，在进程最终退出时清理 map 并发送完成事件通知大模型
                let bus_cleanup = Arc::clone(&self.bus);
                let task_id_cleanup = task_id.clone();
                let session_id_cleanup = session_id.clone();
                let context_id_cleanup = context_id.clone();
                let buffer_cleanup = Arc::clone(&buffer);
                let background_scheduler_cleanup = self.background_scheduler.clone();
                tokio::spawn(async move {
                    let wait_res = child.wait().await;
                    process_group_guard.disarm();
                    let residual_cleanup = terminate_residual_process_group(pid);
                    let _ = stdout_task.await;
                    let _ = stderr_task.await;
                    buffer_cleanup.flush_pending_now().await;
                    let tasks_cleanup = get_tasks_map();

                    let code = wait_res.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
                    let output_str = buffer_cleanup.get_all();
                    let residual_note = match residual_cleanup {
                        Ok(true) => "\n[Runtime 已终止 Shell 退出后残留的非托管子进程组。请勿在 exec 命令中自行后台化。]",
                        Ok(false) => "",
                        Err(_) => "\n[Runtime 无法确认 Shell 退出后的进程组是否已完整清理。]",
                    };
                    if let Some(scheduler) = &background_scheduler_cleanup {
                        if scheduler.execution_jobs.is_some() {
                            match scheduler
                                .finish_background_execution(
                                    &task_id_cleanup,
                                    code,
                                    &output_str,
                                    residual_note,
                                )
                                .await
                            {
                                Ok(_) => scheduler.cancel(&task_id_cleanup).await,
                                Err(error) => tracing::error!(
                                    task_id = %task_id_cleanup,
                                    %error,
                                    "后台进程已退出，但持久 ExecutionJob 终态提交失败"
                                ),
                            }
                            prune_background_task_history();
                            return;
                        }
                        scheduler.cancel(&task_id_cleanup).await;
                    }
                    // Legacy (non-ExecutionJob) tasks publish directly through
                    // the EventBus, so finalize them immediately before that
                    // publication. The durable ExecutionJob path above is
                    // finalized inside finish_background_execution only after
                    // its completion Event has been appended atomically.
                    let final_status = mark_background_task_terminal(&task_id_cleanup, code);
                    let effective_boundary = tasks_cleanup.get(&task_id_cleanup).map(|task| {
                        serde_json::json!({
                            "network_enabled": task.effective_network,
                            "permission_request_available": task.permission_request_available,
                            "secret_env": task.secret_env,
                            "sandbox_backend": task.sandbox_backend,
                            "sandbox_status": task.sandbox_status,
                        })
                    });

                    let mut payload = serde_json::Map::new();
                    payload.insert(
                        "context_id".to_string(),
                        serde_json::json!(context_id_cleanup),
                    );
                    payload.insert(
                        "session_id".to_string(),
                        serde_json::json!(session_id_cleanup),
                    );
                    payload.insert("task_id".to_string(), serde_json::json!(task_id_cleanup));
                    payload.insert("task_status".to_string(), serde_json::json!(final_status));
                    payload.insert(
                        "process_status".to_string(),
                        serde_json::json!(if code == 0 { "succeeded" } else { "failed" }),
                    );
                    payload.insert("exit_code".to_string(), serde_json::json!(code));
                    if code != 0 {
                        let permission_request_available = tasks_cleanup
                            .get(&task_id_cleanup)
                            .is_some_and(|task| task.permission_request_available);
                        let effective_network = tasks_cleanup
                            .get(&task_id_cleanup)
                            .is_some_and(|task| task.effective_network);
                        payload.insert(
                            "boundary_remediation".to_string(),
                            serde_json::json!(boundary_remediation(
                                permission_request_available,
                                effective_network,
                            )),
                        );
                    }
                    if let Some(effective_boundary) = effective_boundary {
                        payload.insert("effective_boundary".to_string(), effective_boundary);
                    }
                    payload.insert(
                        "artifact_path".to_string(),
                        serde_json::json!(buffer_cleanup.archive_path),
                    );
                    payload.insert(
                        "text".to_string(),
                        serde_json::json!(format!(
                            "\n[后台任务 {} 执行结束，退出码: {}]{}\n--- 输出 ---\n{}",
                            task_id_cleanup, code, residual_note, output_str
                        )),
                    );
                    let causal_route = tasks_cleanup
                        .get(&task_id_cleanup)
                        .and_then(|task| task.causal_route.clone());
                    if let Some(principal_id) = tasks_cleanup
                        .get(&task_id_cleanup)
                        .and_then(|task| task.initiating_principal_id.clone())
                    {
                        payload.insert("principal_id".to_string(), serde_json::json!(principal_id));
                    }
                    extend_causal_route(&mut payload, causal_route.as_ref());

                    let ev = Event::new(
                        format!(
                            "task_exit_{}_{}",
                            task_id_cleanup,
                            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
                        ),
                        "System-TaskMonitor".to_string(),
                        crate::event::TYPE_TOOL_OUTPUT.to_string(),
                        "chat/tool_output".to_string(),
                        payload,
                    );
                    let _ = bus_cleanup.publish(ev).await;
                    prune_background_task_history();
                });

                let elapsed_str = format!("{} 毫秒", wait_duration.as_millis());

                let output_str = buffer.get_all();
                Ok(serde_json::json!({
                    "kind": "exec_result",
                    "execution": "background",
                    "task_status": "running",
                    "task_id": task_id,
                    "waited": elapsed_str,
                    "effective_boundary": {
                        "network_enabled": effective_network,
                        "permission_request_available": permission_request_available,
                        "secret_env": effective_secret_env,
                        "sandbox_backend": sandbox_backend,
                        "sandbox_status": sandbox_status,
                    },
                    "artifact_path": buffer.archive_path,
                    "output_empty": output_str.is_empty(),
                    "output": output_str,
                    "guidance": "任务完成会通过 Inbox 主动唤醒；普通等待直接 no_reply，不要调用等待工具。只有存在明确截止时间或停滞监督需求时，才用 check_task_after 安排一次检查点；不应继续时调用 kill_task。不要 sleep、ps 或重复读取空日志轮询。",
                })
                .to_string())
            }
        }
    }
}

// ==========================================
// 5. Background task control plane
// ==========================================
pub struct ListTasksTool {
    background_scheduler: Option<Arc<BackgroundTaskScheduler>>,
}
pub struct TaskStatusTool {
    background_scheduler: Option<Arc<BackgroundTaskScheduler>>,
}
pub struct CheckTaskAfterTool {
    background_scheduler: Arc<BackgroundTaskScheduler>,
    default_check_after_secs: u64,
}
pub struct KillTaskTool {
    background_scheduler: Option<Arc<BackgroundTaskScheduler>>,
}

impl CheckTaskAfterTool {
    pub fn new(background_scheduler: Arc<BackgroundTaskScheduler>, default_wait_secs: u64) -> Self {
        Self {
            background_scheduler,
            default_check_after_secs: default_wait_secs.clamp(1, MAX_TASK_WAIT_SECS),
        }
    }
}

/// Source-level compatibility for embedders. Fresh Runtime tool definitions
/// expose `check_task_after`; persisted `wait_task` calls are handled through a
/// Registry execution alias.
pub type WaitTaskTool = CheckTaskAfterTool;

impl ListTasksTool {
    pub fn new(background_scheduler: Arc<BackgroundTaskScheduler>) -> Self {
        Self {
            background_scheduler: Some(background_scheduler),
        }
    }

    #[cfg(test)]
    fn without_scheduler() -> Self {
        Self {
            background_scheduler: None,
        }
    }
}

impl TaskStatusTool {
    pub fn new(background_scheduler: Arc<BackgroundTaskScheduler>) -> Self {
        Self {
            background_scheduler: Some(background_scheduler),
        }
    }

    #[cfg(test)]
    fn without_scheduler() -> Self {
        Self {
            background_scheduler: None,
        }
    }
}

impl KillTaskTool {
    pub fn new(background_scheduler: Arc<BackgroundTaskScheduler>) -> Self {
        Self {
            background_scheduler: Some(background_scheduler),
        }
    }

    #[cfg(test)]
    fn without_scheduler() -> Self {
        Self {
            background_scheduler: None,
        }
    }
}

fn task_visible_in_current_context(task: &BackgroundTask) -> bool {
    let current_context = CURRENT_CONTEXT_ID
        .try_with(Clone::clone)
        .unwrap_or_default();
    current_context.is_empty() || task.context_id == current_context
}

fn require_visible_task(
    task_id: &str,
) -> Result<dashmap::mapref::one::Ref<'static, String, BackgroundTask>, String> {
    let task = get_tasks_map()
        .get(task_id)
        .ok_or_else(|| format!("未找到后台任务 '{task_id}'，它可能已被历史保留策略清理"))?;
    if !task_visible_in_current_context(&task) {
        return Err(format!("后台任务 '{task_id}' 不属于当前 Context"));
    }
    Ok(task)
}

#[derive(Deserialize, Default)]
struct ListTasksArgs {
    #[serde(default)]
    include_finished: bool,
    session_id: Option<String>,
}

#[async_trait::async_trait]
impl Tool for ListTasksTool {
    fn name(&self) -> &str {
        "list_tasks"
    }

    fn execution_class(&self) -> ToolExecutionClass {
        ToolExecutionClass::LogicalInline
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().to_string(),
            description: "列出当前认知 Context 内由 Runtime 托管的后台 Shell 任务。返回真实运行状态、有效网络/沙箱边界、最后输出时间和归档路径；不要使用 ps 猜测任务状态。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "include_finished": {
                        "type": "boolean",
                        "description": "是否包含 Runtime 最近保留的已完成任务；默认 false。"
                    },
                    "session_id": {
                        "type": "string",
                        "description": "可选，仅查看某个 Session 发起的任务。"
                    }
                },
                "additionalProperties": false
            }),
        }
    }

    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: ListTasksArgs = serde_json::from_str(arguments)?;
        let current_context = CURRENT_CONTEXT_ID
            .try_with(Clone::clone)
            .unwrap_or_default();
        if let Some(scheduler) = &self.background_scheduler {
            if let Some(tasks) = scheduler
                .list_background_job_snapshots(
                    &current_context,
                    args.session_id.as_deref(),
                    args.include_finished,
                )
                .await?
            {
                return Ok(serde_json::json!({
                    "kind": "background_task_list",
                    "count": tasks.len(),
                    "tasks": tasks,
                })
                .to_string());
            }
        }
        let mut tasks = get_tasks_map()
            .iter()
            .filter(|task| task_visible_in_current_context(task))
            .filter(|task| args.include_finished || !task.status.is_terminal())
            .filter(|task| {
                args.session_id
                    .as_deref()
                    .is_none_or(|session_id| task.session_id == session_id)
            })
            .map(|task| background_task_snapshot(&task))
            .collect::<Vec<_>>();
        tasks.sort_by(|left, right| {
            left["started_at"]
                .as_str()
                .cmp(&right["started_at"].as_str())
        });
        Ok(serde_json::json!({
            "kind": "background_task_list",
            "count": tasks.len(),
            "tasks": tasks,
        })
        .to_string())
    }
}

#[derive(Deserialize)]
struct TaskStatusArgs {
    task_id: String,
}

#[derive(Deserialize)]
struct CheckTaskAfterArgs {
    task_id: String,
    #[serde(alias = "wait_secs")]
    check_after_secs: Option<u64>,
}

#[async_trait::async_trait]
impl Tool for TaskStatusTool {
    fn name(&self) -> &str {
        "task_status"
    }

    fn execution_class(&self) -> ToolExecutionClass {
        ToolExecutionClass::LogicalInline
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().to_string(),
            description: "读取一个 Runtime 托管后台任务的权威状态。用它确认任务是否真正运行、是否具有所需网络边界、是否无输出停滞以及最终退出码。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "exec 返回的后台任务 ID。"
                    }
                },
                "required": ["task_id"],
                "additionalProperties": false
            }),
        }
    }

    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: TaskStatusArgs = serde_json::from_str(arguments)?;
        let current_context = CURRENT_CONTEXT_ID
            .try_with(Clone::clone)
            .unwrap_or_default();
        if let Some(scheduler) = &self.background_scheduler {
            if let Some(task) = scheduler
                .background_job_snapshot(&args.task_id, &current_context)
                .await?
            {
                return Ok(serde_json::json!({
                    "kind": "background_task_status",
                    "task": task,
                })
                .to_string());
            }
        }
        let task = require_visible_task(&args.task_id)?;
        Ok(serde_json::json!({
            "kind": "background_task_status",
            "task": background_task_snapshot(&task),
        })
        .to_string())
    }
}

#[async_trait::async_trait]
impl Tool for CheckTaskAfterTool {
    fn name(&self) -> &str {
        "check_task_after"
    }

    fn execution_class(&self) -> ToolExecutionClass {
        ToolExecutionClass::LogicalInline
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().to_string(),
            description: "仅在确实需要截止时间或停滞监督时，为后台任务安排一次未来检查点。任务完成本来就会主动唤醒，因此普通后台等待不要调用本工具。该调用不轮询、不占用 LLM，也不终止任务；检查点到达后可按事实继续等待或调用 kill_task。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "要等待的后台任务 ID。"
                    },
                    "check_after_secs": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_TASK_WAIT_SECS,
                        "description": "多久后重新唤醒 Agent 检查该任务。省略时使用 Runtime 配置的监督间隔。"
                    }
                },
                "required": ["task_id"],
                "additionalProperties": false
            }),
        }
    }

    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: CheckTaskAfterArgs = serde_json::from_str(arguments)?;
        let current_context = CURRENT_CONTEXT_ID
            .try_with(Clone::clone)
            .unwrap_or_default();
        if self.background_scheduler.execution_jobs.is_some() {
            let job = self
                .background_scheduler
                .get_background_job(&args.task_id)
                .await?
                .ok_or_else(|| format!("未找到后台任务 '{}'", args.task_id))?;
            if !current_context.is_empty() && job.context_id != current_context {
                return Err(format!("后台任务 '{}' 不属于当前 Context", args.task_id).into());
            }
            if job.status.is_terminal() {
                let live = get_tasks_map().get(&args.task_id);
                return Ok(serde_json::json!({
                    "kind": "background_task_check",
                    "scheduled": false,
                    "waiting": false,
                    "task": background_execution_snapshot(&job, live.as_deref()),
                    "next_action": "任务已经结束，直接根据持久 ExecutionJob 的退出码和结果继续处理。",
                })
                .to_string());
            }
        }
        let task = require_visible_task(&args.task_id)?;
        let terminal = task.status.is_terminal();
        drop(task);
        if terminal {
            let task = require_visible_task(&args.task_id)?;
            return Ok(serde_json::json!({
                "kind": "background_task_check",
                "scheduled": false,
                "waiting": false,
                "task": background_task_snapshot(&task),
                "next_action": "任务已经结束，直接根据退出码和输出继续处理。",
            })
            .to_string());
        }

        let check_after_secs = args
            .check_after_secs
            .unwrap_or(self.default_check_after_secs);
        let wakeup_at = match self
            .background_scheduler
            .schedule(&args.task_id, check_after_secs, "agent_requested")
            .await
        {
            Ok(wakeup_at) => wakeup_at,
            Err(error) => {
                if let Ok(task) = require_visible_task(&args.task_id) {
                    if task.status.is_terminal() {
                        return Ok(serde_json::json!({
                            "kind": "background_task_check",
                            "scheduled": false,
                            "waiting": false,
                            "task": background_task_snapshot(&task),
                            "next_action": "任务在安排等待时已经结束，直接根据退出码和输出继续处理。",
                        })
                        .to_string());
                    }
                }
                return Err(error.into());
            }
        };
        let task = require_visible_task(&args.task_id)?;
        Ok(serde_json::json!({
            "kind": "background_task_check",
            "scheduled": true,
            "waiting": true,
            "check_after_secs": check_after_secs,
            "wait_secs": check_after_secs,
            "check_at": wakeup_at,
            "wakeup_at": wakeup_at,
            "task": background_task_snapshot(&task),
            "next_action": "若无需立即发送消息，调用 no_reply 结束当前求值；任务结束或检查点到达时 Runtime 会主动唤醒。不要 sleep、ps、轮询日志或立即重复安排检查点。",
        })
        .to_string())
    }
}

#[derive(Deserialize)]
struct KillTaskArgs {
    task_id: String,
}

#[async_trait::async_trait]
impl Tool for KillTaskTool {
    fn name(&self) -> &str {
        "kill_task"
    }

    fn execution_class(&self) -> ToolExecutionClass {
        ToolExecutionClass::LogicalInline
    }

    fn definition(&self) -> ToolDefinition {
        let params_json = serde_json::json!({
            "type": "object",
            "properties": {
                "task_id": {
                    "type": "string",
                    "description": "要强杀的后台任务 ID，例如 task_1719234560"
                }
            },
            "required": ["task_id"]
        });

        ToolDefinition {
            name: "kill_task".to_string(),
            description:
                "强行终止失控或已无用处的后台托管 Shell 任务，释放其占用的全部进程树及物理资源。"
                    .to_string(),
            parameters: params_json,
        }
    }

    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: KillTaskArgs = serde_json::from_str(arguments)?;
        if let Some(scheduler) = &self.background_scheduler {
            if scheduler.execution_jobs.is_some() {
                let current_context = CURRENT_CONTEXT_ID
                    .try_with(Clone::clone)
                    .unwrap_or_default();
                return Ok(scheduler
                    .request_cancel_and_signal(&args.task_id, &current_context)
                    .await?
                    .to_string());
            }
        }
        let tasks = get_tasks_map();

        if let Some(mut task) = tasks.get_mut(&args.task_id) {
            if !task_visible_in_current_context(&task) {
                return Err(format!("后台任务 '{}' 不属于当前 Context", args.task_id).into());
            }
            if task.status.is_terminal() {
                return Ok(serde_json::json!({
                    "kind": "background_task_kill",
                    "task": background_task_snapshot(&task),
                    "killed": false,
                    "reason": "task_already_finished",
                })
                .to_string());
            }
            let task_pgid = task.pgid;
            task.status = BackgroundTaskStatus::KillRequested;
            task.wake_generation = task.wake_generation.wrapping_add(1);
            task.next_wakeup_at = None;
            drop(task);
            if let Some(scheduler) = &self.background_scheduler {
                scheduler.cancel(&args.task_id).await;
            }
            let pgid = nix::unistd::Pid::from_raw(-task_pgid); // 负数代表杀死整个进程组
            match nix::sys::signal::kill(pgid, nix::sys::signal::Signal::SIGKILL) {
                Ok(_) => Ok(serde_json::json!({
                    "kind": "background_task_kill",
                    "task_id": args.task_id,
                    "status": "kill_requested",
                    "process_group_id": task_pgid,
                    "killed": true,
                    "guidance": "进程退出事件会携带最终 killed 状态和退出码。"
                })
                .to_string()),
                Err(e) => {
                    if e == nix::errno::Errno::ESRCH {
                        if let Some(mut task) = tasks.get_mut(&args.task_id) {
                            task.status = BackgroundTaskStatus::Failed;
                            task.ended_at = Some(chrono::Utc::now());
                            task.exit_code = Some(-1);
                            task.next_wakeup_at = None;
                        }
                        Ok(serde_json::json!({
                            "kind": "background_task_kill",
                            "task_id": args.task_id,
                            "status": "failed",
                            "process_group_id": task_pgid,
                            "killed": false,
                            "reason": "process_group_not_found"
                        })
                        .to_string())
                    } else {
                        if let Some(mut task) = tasks.get_mut(&args.task_id) {
                            task.status = BackgroundTaskStatus::Running;
                        }
                        Err(format!("强杀进程组 {} 遭遇系统级错误: {:?}", task_pgid, e).into())
                    }
                }
            }
        } else {
            Err(format!(
                "未找到后台任务 '{}'，它可能已被历史保留策略清理",
                args.task_id
            )
            .into())
        }
    }
}

// ==========================================
// 6. DelegateTool 并发子智能体派生
// ==========================================
pub struct DelegateTool {
    bus: Arc<InMemoryEventBus>,
}

impl DelegateTool {
    pub fn new(bus: Arc<InMemoryEventBus>) -> Self {
        Self { bus }
    }
}

#[derive(Deserialize)]
struct DelegateArgs {
    task: String,
    #[serde(default)]
    success_when: Option<String>,
    #[serde(default = "default_delegation_scope")]
    context_scope: String,
    #[serde(default = "default_delegation_mode")]
    mode: String,
}

fn default_delegation_scope() -> String {
    "current_session".to_string()
}

fn default_delegation_mode() -> String {
    "attached".to_string()
}

#[async_trait::async_trait]
impl Tool for DelegateTool {
    fn name(&self) -> &str {
        "delegate"
    }

    fn execution_class(&self) -> ToolExecutionClass {
        ToolExecutionClass::LogicalInline
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "delegate".to_string(),
            description: "把一项较重任务委派给认知隔离的 Sub Agent。注意：它不是新容器、新进程或新的物理沙箱；父子共享同一个 Runtime workspace、文件系统和权限边界，不能通过修改 Runtime 配置来制造隔离。默认 attached：Runtime 挂起当前求值，不把 queued 回执当作新 Observation 唤醒你；Sub Agent 完成后才用 delegate 结果恢复当前 Session，因此不要轮询 recall。只有任务明确应脱离当前回合继续后台运行时才用 detached。Sub Agent 继承共享 Mind 与可选的当前 Session 证据，但不能直接修改父 Mind；结果由你验证、回复或整合。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "task": {
                        "type": "string",
                        "description": "交给 Sub Agent 的完整任务"
                    },
                    "success_when": {
                        "type": "string",
                        "description": "可验证的完成条件"
                    },
                    "context_scope": {
                        "type": "string",
                        "enum": ["current_session", "mind_only"],
                        "description": "current_session 继承 Mind 与当前 Session；mind_only 只继承 Mind",
                        "default": "current_session"
                    },
                    "mode": {
                        "type": "string",
                        "enum": ["attached", "detached"],
                        "description": "attached 等待 Sub Agent 结果后再恢复当前求值；detached 立即返回 queued 回执并允许当前回合继续",
                        "default": "attached"
                    }
                },
                "required": ["task"]
            }),
        }
    }

    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: DelegateArgs = serde_json::from_str(arguments)?;
        if args.task.trim().is_empty() {
            return Err("delegate.task 不能为空".into());
        }
        if !matches!(args.context_scope.as_str(), "current_session" | "mind_only") {
            return Err(format!("不支持的 delegate.context_scope: {}", args.context_scope).into());
        }
        if !matches!(args.mode.as_str(), "attached" | "detached") {
            return Err(format!("不支持的 delegate.mode: {}", args.mode).into());
        }
        let parent_session_id = CURRENT_SESSION_ID
            .try_with(Clone::clone)
            .map_err(|_| "delegate 必须在 Session 求值中调用")?;
        let parent_context_id = CURRENT_CONTEXT_ID
            .try_with(Clone::clone)
            .map_err(|_| "delegate 缺少当前 Context 路由")?;
        let suffix = chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0);
        let delegation_id = format!("delegation_{suffix}");
        let child_context_id = format!("delegate-context-{suffix}");
        let child_session_id = format!("delegate-session-{suffix}");
        let mut payload = vec![
            (
                "context_id".to_string(),
                serde_json::json!(parent_context_id),
            ),
            (
                "session_id".to_string(),
                serde_json::json!(parent_session_id),
            ),
            (
                "parent_context_id".to_string(),
                serde_json::json!(parent_context_id),
            ),
            (
                "parent_session_id".to_string(),
                serde_json::json!(parent_session_id),
            ),
            (
                "delegation_id".to_string(),
                serde_json::json!(delegation_id),
            ),
            (
                "child_context_id".to_string(),
                serde_json::json!(child_context_id),
            ),
            (
                "child_session_id".to_string(),
                serde_json::json!(child_session_id),
            ),
            ("task".to_string(), serde_json::json!(args.task)),
            (
                "success_when".to_string(),
                serde_json::json!(args.success_when),
            ),
            (
                "context_scope".to_string(),
                serde_json::json!(args.context_scope),
            ),
            ("mode".to_string(), serde_json::json!(args.mode)),
            (
                "text".to_string(),
                serde_json::json!("Delegation requested"),
            ),
        ]
        .into_iter()
        .collect::<serde_json::Map<_, _>>();
        let causal_route = CURRENT_CAUSAL_ROUTE.try_with(Clone::clone).ok().flatten();
        if let Some(principal_id) = CURRENT_PRINCIPAL_ID.try_with(Clone::clone).ok().flatten() {
            payload.insert("principal_id".to_string(), serde_json::json!(principal_id));
        }
        extend_causal_route(&mut payload, causal_route.as_ref());
        self.bus
            .publish(Event::new(
                format!("delegate_request_{suffix}"),
                format!("Parent-Agent-{parent_session_id}"),
                crate::event::TYPE_AGENT_CALL.to_string(),
                "chat/delegate".to_string(),
                payload,
            ))
            .await?;
        Ok(serde_json::json!({
            "delegation_id": delegation_id,
            "status": "queued",
            "mode": args.mode,
            "child_context_id": child_context_id,
            "child_session_id": child_session_id,
            "guidance": if args.mode == "attached" {
                "Sub Agent 已排队；Runtime 将等待完成结果后恢复当前 Session，请勿轮询。"
            } else {
                "Sub Agent 已在后台排队；当前回合可以继续或回复，完成结果稍后返回当前 Session。"
            }
        })
        .to_string())
    }
}

// ==========================================
// 7. ListSkillsTool 传统技能自动发现工具
// ==========================================
pub struct ListSkillsTool;

pub struct ListSecretsTool {
    secret_store: Arc<crate::secret_store::SecretStore>,
}

impl ListSecretsTool {
    pub fn new(secret_store: Arc<crate::secret_store::SecretStore>) -> Self {
        Self { secret_store }
    }
}

#[async_trait::async_trait]
impl Tool for ListSecretsTool {
    fn name(&self) -> &str {
        "list_secrets"
    }

    fn execution_class(&self) -> ToolExecutionClass {
        ToolExecutionClass::LogicalInline
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().to_string(),
            description: "列出当前 Context/Session 可引用的受管凭证别名和作用域元数据。此工具永远不返回凭证值；需要执行命令时，只把别名放入 exec.requested_permissions.secret_env，由 Runtime 审批并向单个子进程注入。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        }
    }

    async fn execute(
        &self,
        _arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let context_id = CURRENT_CONTEXT_ID.try_with(Clone::clone).ok();
        let session_id = CURRENT_SESSION_ID.try_with(Clone::clone).ok();
        let objective_id = CURRENT_OBJECTIVE_ID.try_with(Clone::clone).ok().flatten();
        let execution_job = CURRENT_EXECUTION_JOB.try_with(Clone::clone).ok().flatten();
        let secrets = self
            .secret_store
            .list_authorized(crate::secret_store::SecretUseContext {
                context_id: context_id.as_deref(),
                session_id: session_id.as_deref(),
                objective_id: objective_id.as_deref(),
                target_id: execution_job.as_ref().map(|job| job.target_id.as_str()),
            })?;
        Ok(serde_json::json!({
            "status": if secrets.is_empty() { "empty" } else { "ok" },
            "secrets": secrets,
            "value_backend": self.secret_store.backend_id(),
            "guidance": "这里只包含别名。不要索要、读取或回显值；将所需别名放入 exec.requested_permissions.secret_env。"
        })
        .to_string())
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct SkillCatalogEntry {
    name: String,
    description: String,
    path: String,
}

fn unquote_frontmatter_value(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() >= 2
        && ((trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('\'') && trimmed.ends_with('\'')))
    {
        trimmed[1..trimmed.len() - 1].to_string()
    } else {
        trimmed.to_string()
    }
}

fn parse_skill_frontmatter(default_name: &str, content: &str) -> (String, String) {
    let mut name = default_name.to_string();
    let mut description = "无详细描述".to_string();
    let Some(stripped) = content.strip_prefix("---") else {
        return (name, description);
    };
    let Some(end_idx) = stripped.find("---") else {
        return (name, description);
    };
    let lines = stripped[..end_idx].lines().collect::<Vec<_>>();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        let Some((raw_key, raw_value)) = line.split_once(':') else {
            index += 1;
            continue;
        };
        let key = raw_key.trim();
        let value = raw_value.trim();
        if key == "name" {
            let parsed = unquote_frontmatter_value(value);
            if !parsed.is_empty() {
                name = parsed;
            }
        } else if key == "description" {
            if value == ">" || value == "|-" || value == "|" || value == ">-" {
                let literal = value.starts_with('|');
                let mut parts = Vec::new();
                index += 1;
                while index < lines.len() {
                    let continuation = lines[index];
                    if continuation.trim().is_empty() {
                        index += 1;
                        continue;
                    }
                    if !continuation.starts_with(' ') && !continuation.starts_with('\t') {
                        index -= 1;
                        break;
                    }
                    parts.push(continuation.trim());
                    index += 1;
                }
                let parsed = if literal {
                    parts.join("\n")
                } else {
                    parts.join(" ")
                };
                if !parsed.is_empty() {
                    description = parsed;
                }
            } else {
                let parsed = unquote_frontmatter_value(value);
                if !parsed.is_empty() {
                    description = parsed;
                }
            }
        }
        index += 1;
    }
    (name, description)
}

async fn discover_skills_in_roots(
    roots: &[PathBuf],
) -> Result<Vec<SkillCatalogEntry>, Box<dyn std::error::Error + Send + Sync>> {
    let mut skills = Vec::new();
    for skills_dir in roots {
        if !skills_dir.exists() {
            continue;
        }
        let mut entries = match tokio::fs::read_dir(skills_dir).await {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let skill_md_path = path.join("SKILL.md");
            if !skill_md_path.exists() {
                continue;
            }
            let content = tokio::fs::read_to_string(&skill_md_path).await?;
            let default_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("unknown");
            let (name, description) = parse_skill_frontmatter(default_name, &content);
            skills.push(SkillCatalogEntry {
                name,
                description,
                path: skill_md_path.to_string_lossy().into_owned(),
            });
        }
    }
    skills.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.path.cmp(&right.path))
    });
    Ok(skills)
}

#[async_trait::async_trait]
impl Tool for ListSkillsTool {
    fn name(&self) -> &str {
        "list_skills"
    }

    fn execution_class(&self) -> ToolExecutionClass {
        ToolExecutionClass::LogicalInline
    }

    fn definition(&self) -> ToolDefinition {
        let params_json = serde_json::json!({
            "type": "object",
            "properties": {}
        });

        ToolDefinition {
            name: "list_skills".to_string(),
            description: "按需发现当前安装的 Skill 能力目录。当本轮已有 Function Calling 工具不能直接满足当前意图，或直接能力明确失败时，在断言能力不可用之前调用。返回紧凑的 name/description/path 索引；选择最相关的一项后用 read 读取其 SKILL.md，并按说明调用真实工具。不要预读全部 Skill。".to_string(),
            parameters: params_json,
        }
    }

    async fn execute(
        &self,
        _arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let mut paths_to_scan = Vec::new();
        if let Ok(home) = std::env::var("HOME") {
            let home_path = std::path::Path::new(&home);
            paths_to_scan.push(home_path.join(".agents").join("skills"));
            paths_to_scan.push(home_path.join(".morphz").join("skills"));
        }
        let skills = discover_skills_in_roots(&paths_to_scan).await?;
        Ok(serde_json::json!({
            "status": if skills.is_empty() { "empty" } else { "ok" },
            "skills": skills,
            "guidance": if paths_to_scan.is_empty() {
                "HOME 未配置，无法定位 Skill 目录。"
            } else if skills.is_empty() {
                "当前 Skill 目录为空；如果本轮直接工具也不能满足意图，才可说明缺少对应能力。"
            } else {
                "按当前意图选择最相关的一项，用 read 读取其 path 指向的 SKILL.md；不要预读全部 Skill。"
            }
        })
        .to_string())
    }
}

fn tail_chars(s: &str, max_chars: usize) -> String {
    let total = s.chars().count();
    if total <= max_chars {
        return s.to_string();
    }
    let tail: String = s.chars().skip(total - max_chars).collect();
    format!("... [前 {} 字符已省略]\n{}", total - max_chars, tail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::{ApprovalDecision, ApprovalRequest};
    use crate::memory::sqlite::SqliteStore;
    use crate::memory::{
        ActivationStore as _, NewAgent, NewCognitiveContext, NewPrincipal, NewSchedule, NewSession,
        NewThreadActivation, ScheduleStore as _, SessionDirectoryStore as _, SessionMountKind,
        SessionStore, ThreadGroupStore as _, ThreadLifecycle, ThreadStore as _, TimerStore,
    };
    use crate::permission::PermissionMode;
    #[cfg(target_os = "macos")]
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::sync::Weak;
    use tempfile::{NamedTempFile, TempDir};

    #[cfg(target_os = "macos")]
    static MACOS_SANDBOX_EXEC_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    static SECRET_ENV_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[test]
    fn noninteractive_child_probe() {
        if std::env::var_os("MORPHZ_NONINTERACTIVE_CHILD_PROBE").is_none() {
            return;
        }

        assert_eq!(
            unsafe { nix::libc::getsid(0) },
            unsafe { nix::libc::getpid() },
            "child must lead a detached session"
        );
        let mut byte = [0_u8; 1];
        assert_eq!(
            std::io::Read::read(&mut std::io::stdin(), &mut byte).unwrap(),
            0,
            "non-interactive stdin must immediately return EOF"
        );
        let tty = std::ffi::CString::new("/dev/tty").unwrap();
        assert_eq!(
            unsafe { nix::libc::open(tty.as_ptr(), nix::libc::O_RDONLY) },
            -1,
            "detached child must not be able to open a controlling terminal"
        );
        assert_eq!(std::env::var("SSH_ASKPASS_REQUIRE").as_deref(), Ok("never"));
    }

    #[tokio::test]
    async fn noninteractive_process_has_no_input_or_controlling_terminal() {
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command
            .arg("--exact")
            .arg("tool::tests::noninteractive_child_probe")
            .arg("--nocapture")
            .env("MORPHZ_NONINTERACTIVE_CHILD_PROBE", "1")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        configure_noninteractive_process(&mut command);

        let output = tokio::time::timeout(std::time::Duration::from_secs(2), command.output())
            .await
            .expect("non-interactive child must not wait for terminal input")
            .unwrap();
        assert!(
            output.status.success(),
            "stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn skill_frontmatter_parser_supports_inline_and_folded_descriptions() {
        let inline = r#"---
name: compact-search
description: "Find information using the smallest relevant capability."
---
Body
"#;
        assert_eq!(
            parse_skill_frontmatter("fallback", inline),
            (
                "compact-search".to_string(),
                "Find information using the smallest relevant capability.".to_string()
            )
        );

        let folded = r#"---
name: capability-router
description: >
  Discover a relevant capability only when direct tools are insufficient.
  Read only the selected operational description.
---
Body
"#;
        assert_eq!(
            parse_skill_frontmatter("fallback", folded),
            (
                "capability-router".to_string(),
                "Discover a relevant capability only when direct tools are insufficient. Read only the selected operational description.".to_string()
            )
        );
    }

    #[tokio::test]
    async fn skill_catalog_is_compact_structured_and_deterministic() {
        let tmp = TempDir::new().unwrap();
        for (directory, name, description) in [
            ("z-last", "zeta", "Last capability"),
            ("a-first", "alpha", "First capability"),
        ] {
            let skill_dir = tmp.path().join(directory);
            std::fs::create_dir_all(&skill_dir).unwrap();
            std::fs::write(
                skill_dir.join("SKILL.md"),
                format!("---\nname: {name}\ndescription: {description}\n---\n"),
            )
            .unwrap();
        }

        let skills = discover_skills_in_roots(&[tmp.path().to_path_buf()])
            .await
            .unwrap();
        assert_eq!(
            skills
                .iter()
                .map(|skill| skill.name.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha", "zeta"]
        );
        let encoded = serde_json::to_value(&skills).unwrap();
        assert_eq!(encoded[0]["description"], "First capability");
        assert!(encoded[0]["path"]
            .as_str()
            .unwrap()
            .ends_with("a-first/SKILL.md"));
    }

    #[tokio::test]
    async fn verify_identity_uses_runtime_route_not_model_supplied_session() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(database.path().to_string_lossy().as_ref())
                .await
                .unwrap(),
        );
        store
            .create_agent_bundle(
                NewAgent {
                    id: "verify-agent".to_string(),
                    title: "Verify Agent".to_string(),
                    root_context_id: "verify-context".to_string(),
                },
                NewCognitiveContext {
                    id: "verify-context".to_string(),
                    agent_id: "verify-agent".to_string(),
                    title: "Verify Context".to_string(),
                },
                NewSession {
                    id: "verify-session".to_string(),
                    agent_id: "verify-agent".to_string(),
                    context_id: "verify-context".to_string(),
                    parent_session_id: None,
                    title: "Verify Session".to_string(),
                    mount_kind: SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        store
            .ensure_principal(NewPrincipal {
                id: "principal:a".to_string(),
                provider_id: "test".to_string(),
                assurance: "verified".to_string(),
                display_name: None,
            })
            .await
            .unwrap();
        store
            .bind_session_principal("verify-session", "principal:a")
            .await
            .unwrap();
        let tool = VerifyIdentityTool::new(store as Arc<dyn SessionStore>);

        let execute = |claim: &'static str| {
            let tool = &tool;
            CURRENT_SESSION_ID.scope(
                "verify-session".to_string(),
                CURRENT_PRINCIPAL_ID.scope(Some("principal:a".to_string()), async move {
                    tool.execute(&serde_json::json!({"claimed_principal_id": claim}).to_string())
                        .await
                        .unwrap()
                }),
            )
        };
        let verified: serde_json::Value =
            serde_json::from_str(&execute("principal:a").await).unwrap();
        assert_eq!(verified["verified"], true);
        assert_eq!(verified["authority"], "runtime");
        let rejected: serde_json::Value =
            serde_json::from_str(&execute("principal:b").await).unwrap();
        assert_eq!(rejected["verified"], false);
        assert_eq!(rejected["active_principal_id"], "principal:a");
    }

    struct ReplacementDefinitionTool;

    fn build_test_scheduler(
        bus: Arc<InMemoryEventBus>,
        store: Arc<SqliteStore>,
    ) -> (Arc<ThreadScheduler>, Arc<TimerEngine>) {
        let timers = Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>));
        let scheduler = Arc::new(ThreadScheduler::new(
            bus,
            Arc::clone(&store) as Arc<dyn SessionStore>,
            store as Arc<dyn EventStore>,
            Arc::clone(&timers),
        ));
        scheduler.register_timer_handler().unwrap();
        (scheduler, timers)
    }

    fn start_test_scheduler(
        bus: Arc<InMemoryEventBus>,
        store: Arc<SqliteStore>,
    ) -> Arc<ThreadScheduler> {
        let (scheduler, timers) = build_test_scheduler(bus, store);
        timers.start();
        scheduler
    }

    async fn start_test_background_scheduler(
        bus: Arc<InMemoryEventBus>,
    ) -> (Arc<BackgroundTaskScheduler>, NamedTempFile) {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(database.path().to_string_lossy().as_ref())
                .await
                .unwrap(),
        );
        let timers = Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>));
        let scheduler = Arc::new(BackgroundTaskScheduler::new(
            bus,
            store as Arc<dyn EventStore>,
            Arc::clone(&timers),
        ));
        scheduler.register_timer_handler().unwrap();
        timers.start();
        (scheduler, database)
    }

    fn start_test_durable_background_scheduler(
        bus: Arc<InMemoryEventBus>,
        store: Arc<SqliteStore>,
    ) -> Arc<BackgroundTaskScheduler> {
        let timers = Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>));
        let execution_jobs = Arc::new(ExecutionJobManager::new(
            Arc::clone(&store) as Arc<dyn ExecutionJobStore>
        ));
        let scheduler = Arc::new(BackgroundTaskScheduler::new_with_execution_jobs(
            bus,
            store as Arc<dyn EventStore>,
            Arc::clone(&timers),
            execution_jobs,
        ));
        scheduler.register_timer_handler().unwrap();
        timers.start();
        scheduler
    }

    async fn seed_test_execution_route(
        store: &Arc<SqliteStore>,
        parent: &ToolExecutionJobContext,
        root_turn_id: &str,
        trigger_event_id: &str,
    ) {
        store
            .ensure_agent(NewAgent {
                id: parent.agent_id.clone(),
                title: "Durable background agent".to_string(),
                root_context_id: parent.context_id.clone(),
            })
            .await
            .unwrap();
        store
            .ensure_context(NewCognitiveContext {
                id: parent.context_id.clone(),
                agent_id: parent.agent_id.clone(),
                title: "Durable background context".to_string(),
            })
            .await
            .unwrap();
        store
            .ensure_session(NewSession {
                id: parent.session_id.clone(),
                agent_id: parent.agent_id.clone(),
                context_id: parent.context_id.clone(),
                parent_session_id: None,
                title: "Durable background session".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        store
            .ensure_thread(NewThread {
                id: parent.thread_id.clone(),
                agent_id: parent.agent_id.clone(),
                context_id: parent.context_id.clone(),
                session_id: parent.session_id.clone(),
                initiating_principal_id: None,
                root_turn_id: root_turn_id.to_string(),
                kind: ThreadKind::Execution,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: crate::memory::ThreadSupervision::legacy(),
            })
            .await
            .unwrap();
        store
            .ensure_thread_activation(NewThreadActivation {
                id: parent.activation_id.clone(),
                agent_id: parent.agent_id.clone(),
                context_id: parent.context_id.clone(),
                session_id: parent.session_id.clone(),
                initiating_principal_id: None,
                trigger_event_id: trigger_event_id.to_string(),
                trigger_sequence: 7,
                trigger_kind: "chat/user_message".to_string(),
                parent_activation_id: None,
                root_turn_id: root_turn_id.to_string(),
            })
            .await
            .unwrap();

        let manager = ExecutionJobManager::new(Arc::clone(store) as Arc<dyn ExecutionJobStore>);
        let mut parent_job = manager
            .ensure(ExecutionJobSpec {
                activation_id: parent.activation_id.clone(),
                thread_id: parent.thread_id.clone(),
                agent_id: parent.agent_id.clone(),
                context_id: parent.context_id.clone(),
                session_id: parent.session_id.clone(),
                initiating_principal_id: None,
                target_id: parent.target_id.clone(),
                tool_call_id: parent.tool_call_id.clone(),
                tool_name: "exec".to_string(),
                request: serde_json::json!({"command": "test-parent-exec"}),
                retry_safety: ExecutionRetrySafety::ReconcileRequired,
                requires_approval: false,
            })
            .await
            .unwrap();
        assert_eq!(parent_job.id, parent.parent_job_id);
        let claim_token = format!("test-parent-claim-{}", parent.activation_id);
        parent_job = applied_background_job(
            manager
                .claim(
                    &parent_job.id,
                    parent_job.revision,
                    JobClaim {
                        worker_id: "test-parent-executor",
                        claim_token: &claim_token,
                        lease_expires_at: chrono::Utc::now() + chrono::Duration::minutes(2),
                        approval_ref: None,
                    },
                )
                .await
                .unwrap(),
            "parent claim",
        )
        .unwrap();
        applied_background_job(
            manager
                .heartbeat(
                    &parent_job.id,
                    parent_job.revision,
                    JobHeartbeat {
                        claim_token: &claim_token,
                        lease_expires_at: chrono::Utc::now() + chrono::Duration::minutes(2),
                        side_effect_started_at: Some(chrono::Utc::now()),
                        progress_ref: None,
                    },
                )
                .await
                .unwrap(),
            "parent side-effect boundary",
        )
        .unwrap();
    }

    #[tokio::test]
    async fn send_message_routes_to_another_session_without_ending_current_evaluation() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(database.path().to_string_lossy().as_ref())
                .await
                .unwrap(),
        );
        store
            .ensure_agent(NewAgent {
                id: "agent-a".to_string(),
                title: "Agent A".to_string(),
                root_context_id: "context-a".to_string(),
            })
            .await
            .unwrap();
        for context_id in ["context-a", "context-b"] {
            store
                .ensure_context(NewCognitiveContext {
                    id: context_id.to_string(),
                    agent_id: "agent-a".to_string(),
                    title: context_id.to_string(),
                })
                .await
                .unwrap();
        }
        for (session_id, context_id) in [("session-a", "context-a"), ("session-b", "context-b")] {
            store
                .ensure_session(NewSession {
                    id: session_id.to_string(),
                    agent_id: "agent-a".to_string(),
                    context_id: context_id.to_string(),
                    parent_session_id: None,
                    title: session_id.to_string(),
                    mount_kind: SessionMountKind::ExistingContext,
                })
                .await
                .unwrap();
        }

        let bus = Arc::new(InMemoryEventBus::new());
        let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
        bus.subscribe(
            "chat/outbound_message".to_string(),
            Arc::new(move |event| {
                let sender = sender.clone();
                Box::pin(async move { sender.send(event).await.map_err(|error| error.into()) })
            }),
        );
        let tool = SendMessageTool::new(
            Arc::clone(&bus),
            Arc::clone(&store) as Arc<dyn SessionStore>,
        );
        let arguments = serde_json::json!({
            "session_id": "session-b",
            "content": "background task finished"
        })
        .to_string();
        let result = CURRENT_SESSION_ID
            .scope(
                "session-a".to_string(),
                CURRENT_CONTEXT_ID.scope(
                    "context-a".to_string(),
                    CURRENT_ATTEMPT_ID.scope(
                        "attempt-a".to_string(),
                        CURRENT_CAUSAL_ROUTE.scope(None, tool.execute(&arguments)),
                    ),
                ),
            )
            .await
            .unwrap();
        let receipt: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(receipt["status"], "sent");
        assert!(receipt["guidance"].as_str().unwrap().contains("尚未结束"));

        let event = receiver.recv().await.unwrap();
        assert_eq!(event.payload["session_id"], "session-b");
        assert_eq!(event.payload["context_id"], "context-b");
        assert_eq!(event.payload["source_session_id"], "session-a");
        assert_eq!(event.payload["text"], "background task finished");
    }

    #[tokio::test]
    async fn schedule_tx_persists_and_dispatches_a_timed_spawn_once() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(database.path().to_string_lossy().as_ref())
                .await
                .unwrap(),
        );
        store
            .ensure_agent(NewAgent {
                id: "agent-scheduler".to_string(),
                title: "Scheduler Agent".to_string(),
                root_context_id: "context-scheduler".to_string(),
            })
            .await
            .unwrap();
        store
            .ensure_context(NewCognitiveContext {
                id: "context-scheduler".to_string(),
                agent_id: "agent-scheduler".to_string(),
                title: "Scheduler Context".to_string(),
            })
            .await
            .unwrap();
        store
            .ensure_session(NewSession {
                id: "session-scheduler".to_string(),
                agent_id: "agent-scheduler".to_string(),
                context_id: "context-scheduler".to_string(),
                parent_session_id: None,
                title: "Scheduler Session".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        store
            .ensure_thread(NewThread {
                id: "thread-current".to_string(),
                agent_id: "agent-scheduler".to_string(),
                context_id: "context-scheduler".to_string(),
                session_id: "session-scheduler".to_string(),
                initiating_principal_id: None,
                root_turn_id: "root-current".to_string(),
                kind: ThreadKind::DialogueTurn,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: crate::memory::ThreadSupervision::legacy(),
            })
            .await
            .unwrap();

        let bus = Arc::new(InMemoryEventBus::new());
        let (sender, mut receiver) = tokio::sync::mpsc::channel(2);
        bus.subscribe(
            "chat/schedule_due".to_string(),
            Arc::new(move |event| {
                let sender = sender.clone();
                Box::pin(async move { sender.send(event).await.map_err(|error| error.into()) })
            }),
        );
        let sessions = Arc::clone(&store) as Arc<dyn SessionStore>;
        let scheduler = start_test_scheduler(Arc::clone(&bus), Arc::clone(&store));
        let tool = ScheduleTxTool::new(Arc::clone(&scheduler), sessions);
        let due_at = (chrono::Utc::now() + chrono::Duration::milliseconds(40)).to_rfc3339();
        let arguments = serde_json::json!({
            "operations": [{
                "op": "spawn",
                "lifetime": "attached",
                "client_id": "reminder",
                "intent": "检查长期任务状态并根据真实结果继续",
                "not_before": due_at
            }]
        })
        .to_string();
        let route = Some(ToolCausalRoute {
            thread_id: "thread-current".to_string(),
            activation_id: "work-current".to_string(),
            root_turn_id: "root-current".to_string(),
            trigger_event_id: "user-current".to_string(),
            trigger_sequence: 7,
        });
        let output = CURRENT_SESSION_ID
            .scope(
                "session-scheduler".to_string(),
                CURRENT_CONTEXT_ID.scope(
                    "context-scheduler".to_string(),
                    CURRENT_ATTEMPT_ID.scope(
                        "attempt-scheduler".to_string(),
                        CURRENT_CAUSAL_ROUTE.scope(route, tool.execute(&arguments)),
                    ),
                ),
            )
            .await
            .unwrap();
        let receipt: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(receipt["status"], "committed");
        assert_eq!(receipt["created_thread_ids"].as_array().unwrap().len(), 1);

        let event = tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.event_type, TYPE_TOOL_OUTPUT);
        assert_eq!(
            event.payload["intent"],
            "检查长期任务状态并根据真实结果继续"
        );
        assert_eq!(event.payload["session_id"], "session-scheduler");
        let records = store.list_schedules(None, None).await.unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].status, ScheduleStatus::Dispatched);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(80), receiver.recv())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn schedule_tx_atomically_creates_objective_singleton_group_and_durable_thread() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(database.path().to_string_lossy().as_ref())
                .await
                .unwrap(),
        );
        store
            .ensure_agent(NewAgent {
                id: "agent-objective-schedule".to_string(),
                title: "Objective Scheduler Agent".to_string(),
                root_context_id: "context-objective-schedule".to_string(),
            })
            .await
            .unwrap();
        store
            .ensure_context(NewCognitiveContext {
                id: "context-objective-schedule".to_string(),
                agent_id: "agent-objective-schedule".to_string(),
                title: "Objective Scheduler Context".to_string(),
            })
            .await
            .unwrap();
        store
            .ensure_session(NewSession {
                id: "session-objective-schedule".to_string(),
                agent_id: "agent-objective-schedule".to_string(),
                context_id: "context-objective-schedule".to_string(),
                parent_session_id: None,
                title: "Objective Scheduler Session".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        store
            .ensure_thread(NewThread {
                id: "thread-objective-schedule-current".to_string(),
                agent_id: "agent-objective-schedule".to_string(),
                context_id: "context-objective-schedule".to_string(),
                session_id: "session-objective-schedule".to_string(),
                initiating_principal_id: None,
                root_turn_id: "root-objective-schedule-current".to_string(),
                kind: ThreadKind::DialogueTurn,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: crate::memory::ThreadSupervision::legacy(),
            })
            .await
            .unwrap();

        let bus = Arc::new(InMemoryEventBus::new());
        let sessions = Arc::clone(&store) as Arc<dyn SessionStore>;
        let scheduler = start_test_scheduler(Arc::clone(&bus), Arc::clone(&store));
        let tool = ScheduleTxTool::new(Arc::clone(&scheduler), sessions)
            .with_objective_store(Arc::clone(&store) as Arc<dyn ObjectiveStore>);
        let arguments = serde_json::json!({
            "operations": [{
                "op": "spawn",
                "lifetime": "durable",
                "objective": {
                    "mode": "create",
                    "stated_objective": "持续验证并发布独立基准",
                    "completion_criteria": "基准可重复运行且报告包含稳定性结论",
                    "token_budget": 12000
                },
                "client_id": "initial-benchmark",
                "intent": "建立第一轮基准方案",
                "delay_seconds": 3600
            }]
        })
        .to_string();
        let route = Some(ToolCausalRoute {
            thread_id: "thread-objective-schedule-current".to_string(),
            activation_id: "evaluation-objective-schedule".to_string(),
            root_turn_id: "root-objective-schedule-current".to_string(),
            trigger_event_id: "user-objective-schedule".to_string(),
            trigger_sequence: 9,
        });
        let output = CURRENT_SESSION_ID
            .scope(
                "session-objective-schedule".to_string(),
                CURRENT_CONTEXT_ID.scope(
                    "context-objective-schedule".to_string(),
                    CURRENT_ATTEMPT_ID.scope(
                        "attempt-objective-schedule".to_string(),
                        CURRENT_CAUSAL_ROUTE.scope(route, tool.execute(&arguments)),
                    ),
                ),
            )
            .await
            .unwrap();
        let receipt: serde_json::Value = serde_json::from_str(&output).unwrap();
        let objective_id = receipt["created_objective_ids"][0]
            .as_str()
            .expect("created objective id");
        let thread_id = receipt["created_thread_ids"][0]
            .as_str()
            .expect("created thread id");
        let group_id = receipt["thread_groups"][0]["group_id"]
            .as_str()
            .expect("created group id");

        let objective = store
            .get_objective(objective_id)
            .await
            .unwrap()
            .expect("objective");
        assert_eq!(objective.status, ObjectiveStatus::Active);
        assert_eq!(objective.token_budget, Some(12000));
        assert_eq!(
            objective.wait_condition,
            Some(ObjectiveWaitCondition::ThreadGroup {
                group_id: group_id.to_string()
            })
        );
        let thread = store
            .get_thread(thread_id)
            .await
            .unwrap()
            .expect("durable thread");
        assert_eq!(thread.supervision.lifetime, ThreadLifetime::Durable);
        assert_eq!(
            thread.supervision.supervisor_id.as_deref(),
            Some(objective_id)
        );
        assert_eq!(
            thread.supervision.thread_group_id.as_deref(),
            Some(group_id)
        );
        let group = store
            .get_thread_group(group_id)
            .await
            .unwrap()
            .expect("singleton group");
        assert_eq!(group.required_count, 1);
        assert_eq!(group.supervisor_id, objective_id);
        assert_eq!(
            store
                .list_thread_group_members(group_id)
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(
            store
                .query(QueryFilter {
                    event_id: Some(objective.source_event_id),
                    ..QueryFilter::default()
                })
                .await
                .unwrap()
                .len()
                == 1
        );
    }

    #[tokio::test]
    async fn schedule_tx_atomically_binds_existing_objective_to_required_durable_group() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(database.path().to_string_lossy().as_ref())
                .await
                .unwrap(),
        );
        store
            .ensure_agent(NewAgent {
                id: "agent-existing-objective".to_string(),
                title: "Existing Objective Agent".to_string(),
                root_context_id: "context-existing-objective".to_string(),
            })
            .await
            .unwrap();
        store
            .ensure_context(NewCognitiveContext {
                id: "context-existing-objective".to_string(),
                agent_id: "agent-existing-objective".to_string(),
                title: "Existing Objective Context".to_string(),
            })
            .await
            .unwrap();
        store
            .ensure_session(NewSession {
                id: "session-existing-objective".to_string(),
                agent_id: "agent-existing-objective".to_string(),
                context_id: "context-existing-objective".to_string(),
                parent_session_id: None,
                title: "Existing Objective Session".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        store
            .ensure_thread(NewThread {
                id: "thread-existing-objective-current".to_string(),
                agent_id: "agent-existing-objective".to_string(),
                context_id: "context-existing-objective".to_string(),
                session_id: "session-existing-objective".to_string(),
                initiating_principal_id: None,
                root_turn_id: "root-existing-objective-current".to_string(),
                kind: ThreadKind::DialogueTurn,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: crate::memory::ThreadSupervision::legacy(),
            })
            .await
            .unwrap();
        let objective = store
            .create_objective(NewObjective {
                id: "objective-existing".to_string(),
                agent_id: "agent-existing-objective".to_string(),
                context_id: "context-existing-objective".to_string(),
                coordinator_session_id: "session-existing-objective".to_string(),
                delivery_session_id: "session-existing-objective".to_string(),
                parent_objective_id: None,
                source_event_id: "source-objective-existing".to_string(),
                initiating_principal_id: None,
                stated_objective: "持续完成已有目标".to_string(),
                token_budget: None,
            })
            .await
            .unwrap();

        let bus = Arc::new(InMemoryEventBus::new());
        let scheduler = start_test_scheduler(Arc::clone(&bus), Arc::clone(&store));
        let tool = ScheduleTxTool::new(
            Arc::clone(&scheduler),
            Arc::clone(&store) as Arc<dyn SessionStore>,
        )
        .with_objective_store(Arc::clone(&store) as Arc<dyn ObjectiveStore>);
        let arguments = serde_json::json!({
            "operations": [{
                "op": "spawn",
                "lifetime": "durable",
                "objective": {
                    "mode": "existing",
                    "objective_id": objective.id
                },
                "client_id": "required-work",
                "intent": "执行必须完成的长期工作",
                "delay_seconds": 3600
            }]
        })
        .to_string();
        let route = Some(ToolCausalRoute {
            thread_id: "thread-existing-objective-current".to_string(),
            activation_id: "evaluation-existing-objective".to_string(),
            root_turn_id: "root-existing-objective-current".to_string(),
            trigger_event_id: "user-existing-objective".to_string(),
            trigger_sequence: 11,
        });
        let output = CURRENT_SESSION_ID
            .scope(
                "session-existing-objective".to_string(),
                CURRENT_CONTEXT_ID.scope(
                    "context-existing-objective".to_string(),
                    CURRENT_ATTEMPT_ID.scope(
                        "attempt-existing-objective".to_string(),
                        CURRENT_CAUSAL_ROUTE.scope(route, tool.execute(&arguments)),
                    ),
                ),
            )
            .await
            .unwrap();
        let receipt: serde_json::Value = serde_json::from_str(&output).unwrap();
        let group_id = receipt["thread_groups"][0]["group_id"]
            .as_str()
            .expect("required durable work must create a group");
        let updated = store
            .get_objective("objective-existing")
            .await
            .unwrap()
            .expect("existing objective");
        assert_eq!(updated.revision, objective.revision + 1);
        assert_eq!(
            updated.wait_condition,
            Some(ObjectiveWaitCondition::ThreadGroup {
                group_id: group_id.to_string(),
            })
        );
        let group = store
            .get_thread_group(group_id)
            .await
            .unwrap()
            .expect("required durable group");
        assert_eq!(group.supervisor_kind, ThreadSupervisorKind::Objective);
        assert_eq!(group.supervisor_id, objective.id);
        assert_eq!(group.required_count, 1);
        let bound_events = store
            .query(QueryFilter {
                context_id: Some("context-existing-objective".to_string()),
                topic: Some("objective/thread_group_bound".to_string()),
                ..QueryFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(bound_events.len(), 1);
        assert_eq!(bound_events[0].payload["thread_group_id"], group_id);
    }

    #[tokio::test]
    async fn schedule_tx_promotes_the_same_attached_thread_to_a_durable_objective() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(database.path().to_string_lossy().as_ref())
                .await
                .unwrap(),
        );
        store
            .ensure_agent(NewAgent {
                id: "agent-thread-promotion".to_string(),
                title: "Thread Promotion Agent".to_string(),
                root_context_id: "context-thread-promotion".to_string(),
            })
            .await
            .unwrap();
        store
            .ensure_context(NewCognitiveContext {
                id: "context-thread-promotion".to_string(),
                agent_id: "agent-thread-promotion".to_string(),
                title: "Thread Promotion Context".to_string(),
            })
            .await
            .unwrap();
        store
            .ensure_session(NewSession {
                id: "session-thread-promotion".to_string(),
                agent_id: "agent-thread-promotion".to_string(),
                context_id: "context-thread-promotion".to_string(),
                parent_session_id: None,
                title: "Thread Promotion Session".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        store
            .ensure_thread(NewThread {
                id: "thread-thread-promotion-parent".to_string(),
                agent_id: "agent-thread-promotion".to_string(),
                context_id: "context-thread-promotion".to_string(),
                session_id: "session-thread-promotion".to_string(),
                initiating_principal_id: None,
                root_turn_id: "root-thread-promotion".to_string(),
                kind: ThreadKind::DialogueTurn,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: crate::memory::ThreadSupervision::legacy(),
            })
            .await
            .unwrap();

        let bus = Arc::new(InMemoryEventBus::new());
        let sessions = Arc::clone(&store) as Arc<dyn SessionStore>;
        let scheduler = start_test_scheduler(Arc::clone(&bus), Arc::clone(&store));
        let tool = ScheduleTxTool::new(Arc::clone(&scheduler), sessions)
            .with_objective_store(Arc::clone(&store) as Arc<dyn ObjectiveStore>);
        let route = Some(ToolCausalRoute {
            thread_id: "thread-thread-promotion-parent".to_string(),
            activation_id: "evaluation-thread-promotion".to_string(),
            root_turn_id: "root-thread-promotion".to_string(),
            trigger_event_id: "user-thread-promotion".to_string(),
            trigger_sequence: 3,
        });
        let spawn = serde_json::json!({
            "operations": [{
                "op": "spawn",
                "lifetime": "attached",
                "client_id": "candidate",
                "intent": "先检查范围，再继续长期处理",
                "delay_seconds": 3600
            }]
        })
        .to_string();
        let spawn_output = CURRENT_SESSION_ID
            .scope(
                "session-thread-promotion".to_string(),
                CURRENT_CONTEXT_ID.scope(
                    "context-thread-promotion".to_string(),
                    CURRENT_ATTEMPT_ID.scope(
                        "attempt-thread-promotion".to_string(),
                        CURRENT_CAUSAL_ROUTE.scope(route.clone(), tool.execute(&spawn)),
                    ),
                ),
            )
            .await
            .unwrap();
        let spawn_receipt: serde_json::Value =
            serde_json::from_str(&spawn_output).expect("spawn receipt");
        let thread_id = spawn_receipt["created_thread_ids"][0]
            .as_str()
            .expect("attached thread id")
            .to_string();
        let source_group_id = spawn_receipt["thread_groups"][0]["group_id"]
            .as_str()
            .expect("source group id")
            .to_string();
        let revision = store
            .get_thread(&thread_id)
            .await
            .unwrap()
            .expect("attached thread")
            .revision;

        let promote = serde_json::json!({
            "operations": [{
                "op": "promote",
                "thread_id": thread_id,
                "expected_revision": revision,
                "objective": {
                    "mode": "create",
                    "stated_objective": "持续完成已经开始的长期处理",
                    "completion_criteria": "产生经过检查的最终结果",
                    "token_budget": 9000
                }
            }]
        })
        .to_string();
        let promote_output = CURRENT_SESSION_ID
            .scope(
                "session-thread-promotion".to_string(),
                CURRENT_CONTEXT_ID.scope(
                    "context-thread-promotion".to_string(),
                    CURRENT_ATTEMPT_ID.scope(
                        "attempt-thread-promotion".to_string(),
                        CURRENT_CAUSAL_ROUTE.scope(route, tool.execute(&promote)),
                    ),
                ),
            )
            .await
            .unwrap();
        let receipt: serde_json::Value =
            serde_json::from_str(&promote_output).expect("promotion receipt");
        assert_eq!(receipt["status"], "updated");
        assert_eq!(receipt["thread"]["id"], thread_id);
        assert_eq!(receipt["thread"]["lifecycle"], "open");
        assert_eq!(receipt["thread"]["supervision"]["lifetime"], "durable");
        assert_eq!(
            receipt["thread"]["supervision"]["supervisor_kind"],
            "objective"
        );
        let objective_id = receipt["objective"]["id"].as_str().expect("objective id");
        let target_group_id = receipt["target_group"]["id"]
            .as_str()
            .expect("target group id");
        assert_eq!(receipt["source_group"]["id"], source_group_id);
        assert_eq!(receipt["source_group"]["status"], "satisfied");
        assert_eq!(
            store
                .get_thread(&thread_id)
                .await
                .unwrap()
                .expect("promoted thread")
                .supervision
                .supervisor_id
                .as_deref(),
            Some(objective_id)
        );
        assert_eq!(
            store
                .get_objective(objective_id)
                .await
                .unwrap()
                .expect("created objective")
                .wait_condition,
            Some(ObjectiveWaitCondition::ThreadGroup {
                group_id: target_group_id.to_string(),
            })
        );
        let historical = store
            .list_thread_group_members(&source_group_id)
            .await
            .unwrap();
        assert_eq!(historical.len(), 1);
        assert!(!historical[0].required);
        assert_eq!(
            historical[0].status,
            crate::memory::ThreadGroupMemberStatus::Cancelled
        );
        let current = store
            .list_thread_group_members(target_group_id)
            .await
            .unwrap();
        assert_eq!(current.len(), 1);
        assert!(current[0].required);
        assert_eq!(
            current[0].status,
            crate::memory::ThreadGroupMemberStatus::Pending
        );
    }

    async fn scheduler_store_with_threads(
        database: &NamedTempFile,
        thread_ids: &[(&str, &str)],
    ) -> Arc<SqliteStore> {
        let store = Arc::new(
            SqliteStore::new(database.path().to_string_lossy().as_ref())
                .await
                .unwrap(),
        );
        store
            .ensure_agent(NewAgent {
                id: "agent-scheduler-test".to_string(),
                title: "Scheduler Test Agent".to_string(),
                root_context_id: "context-scheduler-test".to_string(),
            })
            .await
            .unwrap();
        store
            .ensure_context(NewCognitiveContext {
                id: "context-scheduler-test".to_string(),
                agent_id: "agent-scheduler-test".to_string(),
                title: "Scheduler Test Context".to_string(),
            })
            .await
            .unwrap();
        store
            .ensure_session(NewSession {
                id: "session-scheduler-test".to_string(),
                agent_id: "agent-scheduler-test".to_string(),
                context_id: "context-scheduler-test".to_string(),
                parent_session_id: None,
                title: "Scheduler Test Session".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        for (thread_id, root_turn_id) in thread_ids {
            store
                .ensure_thread(NewThread {
                    id: (*thread_id).to_string(),
                    agent_id: "agent-scheduler-test".to_string(),
                    context_id: "context-scheduler-test".to_string(),
                    session_id: "session-scheduler-test".to_string(),
                    initiating_principal_id: None,
                    root_turn_id: (*root_turn_id).to_string(),
                    kind: ThreadKind::Execution,
                    executor_kind: "self".to_string(),
                    executor_id: None,
                    target_id: None,
                    supervision: crate::memory::ThreadSupervision::legacy(),
                })
                .await
                .unwrap();
        }
        store
    }

    async fn seed_test_schedule(
        store: &SqliteStore,
        id: &str,
        thread_id: &str,
        due_at: chrono::DateTime<chrono::Utc>,
    ) -> ScheduleRecord {
        store
            .ensure_schedule(NewSchedule {
                id: id.to_string(),
                thread_id: thread_id.to_string(),
                source_turn_id: format!("source-{id}"),
                intent: format!("intent-{id}"),
                not_before: Some(due_at),
                interval_seconds: None,
                dependency_thread_ids: Vec::new(),
            })
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn scheduler_pause_cancels_timer_and_resume_rearms_current_generation() {
        let database = NamedTempFile::new().unwrap();
        let store = scheduler_store_with_threads(
            &database,
            &[("thread-control-pause", "root-control-pause")],
        )
        .await;
        let bus = Arc::new(InMemoryEventBus::new());
        let (sender, mut receiver) = tokio::sync::mpsc::channel(2);
        bus.subscribe(
            "chat/schedule_due".to_string(),
            Arc::new(move |event| {
                let sender = sender.clone();
                Box::pin(async move { sender.send(event).await.map_err(|error| error.into()) })
            }),
        );
        let (scheduler, timers) = build_test_scheduler(bus, Arc::clone(&store));
        let created = seed_test_schedule(
            &store,
            "schedule-control-pause",
            "thread-control-pause",
            chrono::Utc::now() - chrono::Duration::seconds(1),
        )
        .await;
        scheduler.arm(created.clone()).await.unwrap();

        let paused = match scheduler
            .pause(&created.id, created.revision)
            .await
            .unwrap()
        {
            ScheduleMutation::Updated(intent) => intent,
            other => panic!("unexpected pause result: {other:?}"),
        };
        assert_eq!(paused.status, ScheduleStatus::Paused);
        assert_eq!(
            store
                .get_runtime_timer("schedule:schedule-control-pause")
                .await
                .unwrap()
                .unwrap()
                .status,
            crate::memory::RuntimeTimerStatus::Cancelled
        );
        assert_eq!(timers.dispatch_due_once().await.unwrap(), 0);
        assert!(receiver.try_recv().is_err());

        let resumed = match scheduler
            .pause(&created.id, created.revision)
            .await
            .unwrap()
        {
            ScheduleMutation::Conflict { current } => {
                assert_eq!(current, paused);
                match scheduler
                    .resume(&current.id, current.revision)
                    .await
                    .unwrap()
                {
                    ScheduleMutation::Updated(intent) => intent,
                    other => panic!("unexpected resume result: {other:?}"),
                }
            }
            other => panic!("stale pause must conflict: {other:?}"),
        };
        let timer = store
            .get_runtime_timer("schedule:schedule-control-pause")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(timer.generation, resumed.revision);
        assert_eq!(timer.status, crate::memory::RuntimeTimerStatus::Pending);
        assert_eq!(timers.dispatch_due_once().await.unwrap(), 1);
        let event = receiver.recv().await.unwrap();
        assert_eq!(event.payload["occurrence_revision"], resumed.revision);
        assert_eq!(
            store
                .get_schedule(&created.id)
                .await
                .unwrap()
                .unwrap()
                .status,
            ScheduleStatus::Dispatched
        );
    }

    #[tokio::test]
    async fn schedule_tx_exposes_revision_fenced_control_receipts() {
        let database = NamedTempFile::new().unwrap();
        let store = scheduler_store_with_threads(
            &database,
            &[("thread-control-tool", "root-control-tool")],
        )
        .await;
        let (scheduler, _timers) =
            build_test_scheduler(Arc::new(InMemoryEventBus::new()), Arc::clone(&store));
        let created = seed_test_schedule(
            &store,
            "schedule-control-tool",
            "thread-control-tool",
            chrono::Utc::now() + chrono::Duration::hours(1),
        )
        .await;
        scheduler.arm(created.clone()).await.unwrap();
        let tool = ScheduleTxTool::new(
            Arc::clone(&scheduler),
            Arc::clone(&store) as Arc<dyn SessionStore>,
        );
        let route = Some(ToolCausalRoute {
            thread_id: "thread-control-tool".to_string(),
            activation_id: "activation-control-tool".to_string(),
            root_turn_id: "root-control-tool".to_string(),
            trigger_event_id: "event-control-tool".to_string(),
            trigger_sequence: 1,
        });

        let inspect = CURRENT_SESSION_ID
            .scope(
                "session-scheduler-test".to_string(),
                CURRENT_CONTEXT_ID.scope(
                    "context-scheduler-test".to_string(),
                    CURRENT_ATTEMPT_ID.scope(
                        "attempt-control-tool-inspect".to_string(),
                        CURRENT_CAUSAL_ROUTE.scope(
                            route.clone(),
                            tool.execute(
                                &serde_json::json!({
                                    "operations": [{
                                        "op": "inspect",
                                        "schedule_id": created.id
                                    }]
                                })
                                .to_string(),
                            ),
                        ),
                    ),
                ),
            )
            .await
            .unwrap();
        let inspect: serde_json::Value = serde_json::from_str(&inspect).unwrap();
        assert_eq!(inspect["status"], "ok");
        assert_eq!(inspect["schedule"]["revision"], 1);

        let pause = CURRENT_SESSION_ID
            .scope(
                "session-scheduler-test".to_string(),
                CURRENT_CONTEXT_ID.scope(
                    "context-scheduler-test".to_string(),
                    CURRENT_ATTEMPT_ID.scope(
                        "attempt-control-tool-pause".to_string(),
                        CURRENT_CAUSAL_ROUTE.scope(
                            route.clone(),
                            tool.execute(
                                &serde_json::json!({
                                    "operations": [{
                                        "op": "pause",
                                        "schedule_id": "schedule-control-tool",
                                        "expected_revision": 1
                                    }]
                                })
                                .to_string(),
                            ),
                        ),
                    ),
                ),
            )
            .await
            .unwrap();
        let pause: serde_json::Value = serde_json::from_str(&pause).unwrap();
        assert_eq!(pause["status"], "updated");
        assert_eq!(pause["schedule"]["status"], "paused");

        let stale_resume = CURRENT_SESSION_ID
            .scope(
                "session-scheduler-test".to_string(),
                CURRENT_CONTEXT_ID.scope(
                    "context-scheduler-test".to_string(),
                    CURRENT_ATTEMPT_ID.scope(
                        "attempt-control-tool-stale".to_string(),
                        CURRENT_CAUSAL_ROUTE.scope(
                            route,
                            tool.execute(
                                &serde_json::json!({
                                    "operations": [{
                                        "op": "resume",
                                        "schedule_id": "schedule-control-tool",
                                        "expected_revision": 1
                                    }]
                                })
                                .to_string(),
                            ),
                        ),
                    ),
                ),
            )
            .await
            .unwrap();
        let stale_resume: serde_json::Value = serde_json::from_str(&stale_resume).unwrap();
        assert_eq!(stale_resume["status"], "conflict");
        assert_eq!(stale_resume["schedule"]["revision"], 2);
    }

    #[tokio::test]
    async fn scheduler_reschedule_moves_timer_both_later_and_earlier_and_fences_stale_timer() {
        let database = NamedTempFile::new().unwrap();
        let store = scheduler_store_with_threads(
            &database,
            &[("thread-control-reschedule", "root-control-reschedule")],
        )
        .await;
        let bus = Arc::new(InMemoryEventBus::new());
        let (sender, mut receiver) = tokio::sync::mpsc::channel(2);
        bus.subscribe(
            "chat/schedule_due".to_string(),
            Arc::new(move |event| {
                let sender = sender.clone();
                Box::pin(async move { sender.send(event).await.map_err(|error| error.into()) })
            }),
        );
        let (scheduler, timers) = build_test_scheduler(bus, Arc::clone(&store));
        let created = seed_test_schedule(
            &store,
            "schedule-control-reschedule",
            "thread-control-reschedule",
            chrono::Utc::now() + chrono::Duration::minutes(10),
        )
        .await;
        let stale_timer = scheduler.arm(created.clone()).await.unwrap();

        let later_due = chrono::Utc::now() + chrono::Duration::minutes(20);
        let later = match scheduler
            .reschedule(&created.id, created.revision, Some(later_due), None)
            .await
            .unwrap()
        {
            ScheduleMutation::Updated(intent) => intent,
            other => panic!("unexpected later reschedule: {other:?}"),
        };
        let later_timer = store
            .get_runtime_timer("schedule:schedule-control-reschedule")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(later_timer.generation, later.revision);
        assert_eq!(later_timer.due_at, later_due);
        assert_eq!(timers.dispatch_due_once().await.unwrap(), 0);

        // A worker may already hold the old generation when reschedule wins.
        // Feeding that stale record to the handler must neither emit a due
        // Event nor overwrite the new timer generation.
        assert_eq!(
            Arc::clone(&scheduler)
                .dispatch_timer(stale_timer)
                .await
                .unwrap(),
            TimerDisposition::Complete
        );
        assert!(receiver.try_recv().is_err());
        assert_eq!(
            store
                .get_runtime_timer("schedule:schedule-control-reschedule")
                .await
                .unwrap()
                .unwrap()
                .generation,
            later.revision
        );

        let earlier_due = chrono::Utc::now() - chrono::Duration::seconds(1);
        let earlier = match scheduler
            .reschedule(&created.id, later.revision, Some(earlier_due), None)
            .await
            .unwrap()
        {
            ScheduleMutation::Updated(intent) => intent,
            other => panic!("unexpected earlier reschedule: {other:?}"),
        };
        assert_eq!(timers.dispatch_due_once().await.unwrap(), 1);
        let event = receiver.recv().await.unwrap();
        assert_eq!(event.payload["occurrence_revision"], earlier.revision);
        assert!(receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn scheduler_restart_recovers_pause_and_resume_crash_windows_without_duplicate_signal() {
        let database = NamedTempFile::new().unwrap();
        let path = database.path().to_string_lossy().to_string();
        let store = scheduler_store_with_threads(
            &database,
            &[("thread-control-restart", "root-control-restart")],
        )
        .await;
        let (scheduler, timers) =
            build_test_scheduler(Arc::new(InMemoryEventBus::new()), Arc::clone(&store));
        let created = seed_test_schedule(
            &store,
            "schedule-control-restart",
            "thread-control-restart",
            chrono::Utc::now() - chrono::Duration::seconds(1),
        )
        .await;
        scheduler.arm(created.clone()).await.unwrap();
        let paused = match store
            .pause_schedule(&created.id, created.revision)
            .await
            .unwrap()
        {
            ScheduleMutation::Updated(intent) => intent,
            other => panic!("unexpected direct pause: {other:?}"),
        };
        // Crash after owner CAS but before timer cancellation.
        drop(scheduler);
        drop(timers);
        drop(store);

        let paused_store = Arc::new(SqliteStore::new(&path).await.unwrap());
        let (paused_recovery, paused_timers) =
            build_test_scheduler(Arc::new(InMemoryEventBus::new()), Arc::clone(&paused_store));
        paused_recovery.recover().await.unwrap();
        assert_eq!(
            paused_store
                .get_runtime_timer("schedule:schedule-control-restart")
                .await
                .unwrap()
                .unwrap()
                .status,
            crate::memory::RuntimeTimerStatus::Cancelled
        );
        assert_eq!(paused_timers.dispatch_due_once().await.unwrap(), 0);

        let resumed = match paused_store
            .resume_schedule(&paused.id, paused.revision)
            .await
            .unwrap()
        {
            ScheduleMutation::Updated(intent) => intent,
            other => panic!("unexpected direct resume: {other:?}"),
        };
        // Crash after resume CAS but before the new generation is armed.
        drop(paused_recovery);
        drop(paused_timers);
        drop(paused_store);

        let recovered_store = Arc::new(SqliteStore::new(&path).await.unwrap());
        let recovered_bus = Arc::new(InMemoryEventBus::new());
        let (sender, mut receiver) = tokio::sync::mpsc::channel(4);
        recovered_bus.subscribe(
            "chat/schedule_due".to_string(),
            Arc::new(move |event| {
                let sender = sender.clone();
                Box::pin(async move { sender.send(event).await.map_err(|error| error.into()) })
            }),
        );
        let (recovered, recovered_timers) =
            build_test_scheduler(recovered_bus, Arc::clone(&recovered_store));
        recovered.recover().await.unwrap();
        let timer = recovered_store
            .get_runtime_timer("schedule:schedule-control-restart")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(timer.generation, resumed.revision);
        assert_eq!(timer.status, crate::memory::RuntimeTimerStatus::Pending);
        assert_eq!(recovered_timers.dispatch_due_once().await.unwrap(), 1);
        receiver.recv().await.unwrap();

        // Replaying recovery may re-broadcast the immutable Event, but Event +
        // Outbox identities remain unique, so it cannot create a second
        // persistent Thread Signal.
        recovered.recover().await.unwrap();
        let due_events = recovered_store
            .query(QueryFilter {
                topic: Some("chat/schedule_due".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(due_events.len(), 1);
        assert_eq!(
            recovered_store
                .list_signal_outbox(crate::memory::SignalOutboxStatus::Pending, 16)
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn scheduler_waits_for_dependency_terminal_state_before_dispatch() {
        let database = NamedTempFile::new().unwrap();
        let store = scheduler_store_with_threads(
            &database,
            &[
                ("thread-dependency", "root-dependency"),
                ("thread-dependent", "root-dependent"),
            ],
        )
        .await;
        let bus = Arc::new(InMemoryEventBus::new());
        let (sender, mut receiver) = tokio::sync::mpsc::channel(2);
        bus.subscribe(
            "chat/schedule_due".to_string(),
            Arc::new(move |event| {
                let sender = sender.clone();
                Box::pin(async move { sender.send(event).await.map_err(|error| error.into()) })
            }),
        );
        let scheduler = start_test_scheduler(Arc::clone(&bus), Arc::clone(&store));
        let intent = store
            .ensure_schedule(NewSchedule {
                id: "schedule-dependent".to_string(),
                thread_id: "thread-dependent".to_string(),
                source_turn_id: "root-dependent".to_string(),
                intent: "依赖结束后再执行".to_string(),
                not_before: None,
                interval_seconds: None,
                dependency_thread_ids: vec!["thread-dependency".to_string()],
            })
            .await
            .unwrap();
        scheduler.arm(intent).await.unwrap();

        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(150), receiver.recv())
                .await
                .is_err(),
            "依赖未结束时不应投递"
        );
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if store
                    .get_runtime_timer("schedule:schedule-dependent")
                    .await
                    .unwrap()
                    .is_some_and(|timer| timer.status == crate::memory::RuntimeTimerStatus::Fired)
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let dependency = store
            .get_thread("thread-dependency")
            .await
            .unwrap()
            .unwrap();
        store
            .update_thread(
                &dependency.id,
                dependency.revision,
                None,
                Some(ThreadLifecycle::Completed),
                Some("依赖结果"),
                Some("dependency-result"),
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            scheduler
                .dependency_completed("thread-dependency")
                .await
                .unwrap(),
            1
        );

        let event = tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.payload["intent"], "依赖结束后再执行");
        assert_eq!(
            event.payload["dependency_states"]["thread-dependency"],
            "completed"
        );
    }

    #[tokio::test]
    async fn scheduler_recovery_replays_terminal_dependency_after_notification_crash_window() {
        let database = NamedTempFile::new().unwrap();
        let store = scheduler_store_with_threads(
            &database,
            &[
                ("thread-recovery-dependency", "root-recovery-dependency"),
                ("thread-recovery-dependent", "root-recovery-dependent"),
            ],
        )
        .await;
        let first_bus = Arc::new(InMemoryEventBus::new());
        let first_scheduler = start_test_scheduler(first_bus, Arc::clone(&store));
        let intent = store
            .ensure_schedule(NewSchedule {
                id: "schedule-recovery-dependent".to_string(),
                thread_id: "thread-recovery-dependent".to_string(),
                source_turn_id: "root-recovery-dependent".to_string(),
                intent: "恢复后由依赖终态唤醒".to_string(),
                not_before: None,
                interval_seconds: None,
                dependency_thread_ids: vec!["thread-recovery-dependency".to_string()],
            })
            .await
            .unwrap();
        first_scheduler.arm(intent).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if store
                    .get_runtime_timer("schedule:schedule-recovery-dependent")
                    .await
                    .unwrap()
                    .is_some_and(|timer| timer.status == crate::memory::RuntimeTimerStatus::Fired)
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let dependency = store
            .get_thread("thread-recovery-dependency")
            .await
            .unwrap()
            .unwrap();
        store
            .update_thread(
                &dependency.id,
                dependency.revision,
                None,
                Some(ThreadLifecycle::Completed),
                Some("dependency completed before crash"),
                Some("dependency-recovery-result"),
                None,
                None,
            )
            .await
            .unwrap();
        // Simulate a crash before dependency_completed can run.
        drop(first_scheduler);

        let recovered_bus = Arc::new(InMemoryEventBus::new());
        let (sender, mut receiver) = tokio::sync::mpsc::channel(2);
        recovered_bus.subscribe(
            "chat/schedule_due".to_string(),
            Arc::new(move |event| {
                let sender = sender.clone();
                Box::pin(async move { sender.send(event).await.map_err(|error| error.into()) })
            }),
        );
        let recovered = start_test_scheduler(recovered_bus, Arc::clone(&store));
        recovered.recover().await.unwrap();
        let event = tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.payload["intent"], "恢复后由依赖终态唤醒");
        assert_eq!(
            event.payload["dependency_states"]["thread-recovery-dependency"],
            "completed"
        );
    }

    #[tokio::test]
    async fn concurrent_dependency_notifications_deliver_one_schedule_occurrence() {
        let database = NamedTempFile::new().unwrap();
        let store = scheduler_store_with_threads(
            &database,
            &[
                ("thread-fenced-dependency", "root-fenced-dependency"),
                ("thread-fenced-dependent", "root-fenced-dependent"),
            ],
        )
        .await;
        let bus = Arc::new(InMemoryEventBus::new());
        let (sender, mut receiver) = tokio::sync::mpsc::channel(4);
        bus.subscribe(
            "chat/schedule_due".to_string(),
            Arc::new(move |event| {
                let sender = sender.clone();
                Box::pin(async move { sender.send(event).await.map_err(|error| error.into()) })
            }),
        );
        let scheduler = start_test_scheduler(bus, Arc::clone(&store));
        let intent = store
            .ensure_schedule(NewSchedule {
                id: "schedule-fenced-dependent".to_string(),
                thread_id: "thread-fenced-dependent".to_string(),
                source_turn_id: "root-fenced-dependent".to_string(),
                intent: "并发通知只投递一次".to_string(),
                not_before: None,
                interval_seconds: None,
                dependency_thread_ids: vec!["thread-fenced-dependency".to_string()],
            })
            .await
            .unwrap();
        scheduler.arm(intent).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        let dependency = store
            .get_thread("thread-fenced-dependency")
            .await
            .unwrap()
            .unwrap();
        store
            .update_thread(
                &dependency.id,
                dependency.revision,
                None,
                Some(ThreadLifecycle::Completed),
                Some("done"),
                Some("fenced-dependency-result"),
                None,
                None,
            )
            .await
            .unwrap();

        let first = Arc::clone(&scheduler);
        let second = Arc::clone(&scheduler);
        let (first_result, second_result) = tokio::join!(
            async move { first.dependency_completed("thread-fenced-dependency").await },
            async move {
                second
                    .dependency_completed("thread-fenced-dependency")
                    .await
            }
        );
        first_result.unwrap();
        second_result.unwrap();
        let event = tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.payload["intent"], "并发通知只投递一次");
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(150), receiver.recv())
                .await
                .is_err(),
            "同一个 schedule occurrence 不应被并发依赖通知重复投递"
        );
    }

    #[tokio::test]
    async fn scheduler_recover_rearms_queued_intent_after_restart() {
        let database = NamedTempFile::new().unwrap();
        let store = scheduler_store_with_threads(
            &database,
            &[("thread-after-restart", "root-after-restart")],
        )
        .await;
        store
            .ensure_schedule(NewSchedule {
                id: "schedule-after-restart".to_string(),
                thread_id: "thread-after-restart".to_string(),
                source_turn_id: "root-after-restart".to_string(),
                intent: "重启后继续执行".to_string(),
                not_before: Some(chrono::Utc::now() + chrono::Duration::milliseconds(40)),
                interval_seconds: None,
                dependency_thread_ids: Vec::new(),
            })
            .await
            .unwrap();

        let bus = Arc::new(InMemoryEventBus::new());
        let (sender, mut receiver) = tokio::sync::mpsc::channel(2);
        bus.subscribe(
            "chat/schedule_due".to_string(),
            Arc::new(move |event| {
                let sender = sender.clone();
                Box::pin(async move { sender.send(event).await.map_err(|error| error.into()) })
            }),
        );
        let restarted_scheduler = start_test_scheduler(Arc::clone(&bus), Arc::clone(&store));
        restarted_scheduler.recover().await.unwrap();

        let event = tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.payload["schedule_id"], "schedule-after-restart");
        assert_eq!(event.payload["intent"], "重启后继续执行");
        let recovered = store
            .get_schedule("schedule-after-restart")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(recovered.status, ScheduleStatus::Dispatched);
    }

    #[async_trait::async_trait]
    impl Tool for ReplacementDefinitionTool {
        fn name(&self) -> &str {
            "reentrant-definition"
        }

        fn definition(&self) -> ToolDefinition {
            ToolDefinition {
                name: self.name().to_string(),
                description: "replacement".to_string(),
                parameters: serde_json::json!({ "type": "object" }),
            }
        }

        async fn execute(
            &self,
            _arguments: &str,
        ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
            Ok(String::new())
        }
    }

    struct ReentrantDefinitionTool {
        registry: Weak<Registry>,
    }

    #[async_trait::async_trait]
    impl Tool for ReentrantDefinitionTool {
        fn name(&self) -> &str {
            "reentrant-definition"
        }

        fn definition(&self) -> ToolDefinition {
            self.registry
                .upgrade()
                .unwrap()
                .register(Arc::new(ReplacementDefinitionTool));
            ToolDefinition {
                name: self.name().to_string(),
                description: "original".to_string(),
                parameters: serde_json::json!({ "type": "object" }),
            }
        }

        async fn execute(
            &self,
            _arguments: &str,
        ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
            Ok(String::new())
        }
    }

    /// 测试用：显式选择完全访问预设。
    fn permissive_security() -> Arc<PermissionConfig> {
        Arc::new(PermissionConfig {
            mode: PermissionMode::FullAccess,
            ..PermissionConfig::default()
        })
    }

    fn jailed_security(root: &Path) -> Arc<PermissionConfig> {
        Arc::new(PermissionConfig {
            mode: PermissionMode::AutoReview,
            workspace_root: root.to_string_lossy().to_string(),
            read_roots: Vec::new(),
            write_roots: Vec::new(),
            ..PermissionConfig::default()
        })
    }

    fn exec_tool_for_tests(bus: Arc<crate::event::InMemoryEventBus>) -> ExecuteCommandTool {
        ExecuteCommandTool::new_with_configs(
            bus,
            Arc::new(BackgroundTaskConfig::default()),
            permissive_security(),
            30,
        )
    }

    struct StaticApprovalProvider {
        decision: ApprovalDecision,
        calls: Arc<AtomicUsize>,
    }

    #[async_trait::async_trait]
    impl ApprovalProvider for StaticApprovalProvider {
        async fn review(
            &self,
            _request: &ApprovalRequest,
        ) -> Result<ApprovalDecision, Box<dyn std::error::Error + Send + Sync>> {
            self.calls.fetch_add(1, AtomicOrdering::SeqCst);
            Ok(self.decision.clone())
        }
    }

    #[cfg(target_os = "macos")]
    struct DelayedApprovalProvider {
        delay: tokio::time::Duration,
    }

    #[cfg(target_os = "macos")]
    #[async_trait::async_trait]
    impl ApprovalProvider for DelayedApprovalProvider {
        async fn review(
            &self,
            _request: &ApprovalRequest,
        ) -> Result<ApprovalDecision, Box<dyn std::error::Error + Send + Sync>> {
            tokio::time::sleep(self.delay).await;
            Ok(ApprovalDecision::AllowOnce {
                rationale: "测试延迟审批".to_string(),
                risk_tags: Vec::new(),
            })
        }
    }

    fn hash_from_read(output: &str) -> &str {
        output
            .lines()
            .next()
            .and_then(|header| header.split("sha256=").nth(1))
            .and_then(|tail| tail.strip_suffix(']'))
            .expect("read output should contain sha256 header")
    }

    #[test]
    fn registry_caches_definitions_without_running_tool_code_during_reads() {
        let registry = Arc::new(Registry::new());
        registry.register(Arc::new(ReentrantDefinitionTool {
            registry: Arc::downgrade(&registry),
        }));

        let definitions = registry.definitions();

        assert_eq!(definitions.len(), 1);
        assert_eq!(definitions[0].description, "original");
        assert_eq!(registry.definitions()[0].description, "original");
    }

    #[test]
    fn registry_alias_executes_persisted_name_without_advertising_it() {
        let registry = Arc::new(Registry::new());
        let tool: Arc<dyn Tool> = Arc::new(ReentrantDefinitionTool {
            registry: Arc::downgrade(&registry),
        });
        registry.register(Arc::clone(&tool));
        registry.register_alias("legacy_original", tool);

        assert!(registry.get("legacy_original").is_some());
        assert_eq!(registry.definitions().len(), 1);
        assert_eq!(registry.definitions()[0].name, "reentrant-definition");
    }

    #[test]
    fn task_check_arguments_accept_legacy_wait_secs() {
        let args: CheckTaskAfterArgs = serde_json::from_value(serde_json::json!({
            "task_id": "legacy-task",
            "wait_secs": 45
        }))
        .unwrap();
        assert_eq!(args.task_id, "legacy-task");
        assert_eq!(args.check_after_secs, Some(45));
    }

    #[tokio::test]
    async fn test_file_tools_allow_repeated_reads() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("note.txt");
        let path_str = path.to_str().unwrap().to_string();

        let write_tool = WriteFileTool::new(permissive_security());
        let read_tool = ReadFileTool::new(permissive_security());

        let write_args = serde_json::json!({
            "path": path_str,
            "content": "hello rust tool",
            "mode": "create"
        });

        let write_res = write_tool.execute(&write_args.to_string()).await.unwrap();
        assert!(write_res.contains("成功"));

        let read_args = serde_json::json!({
            "path": path_str
        });

        let read_res = read_tool.execute(&read_args.to_string()).await.unwrap();
        assert!(read_res.ends_with("hello rust tool"));
        let repeated_read_res = read_tool.execute(&read_args.to_string()).await.unwrap();
        assert_eq!(repeated_read_res, read_res);
        let hash = hash_from_read(&read_res).to_string();

        let overwrite_res = write_tool
            .execute(
                &serde_json::json!({
                    "path": path_str,
                    "content": "updated",
                    "mode": "overwrite",
                    "expected_sha256": hash,
                })
                .to_string(),
            )
            .await
            .unwrap();
        assert!(overwrite_res.contains("operation=overwrite"));
        assert_eq!(std::fs::read_to_string(path).unwrap(), "updated");
    }

    #[tokio::test]
    async fn direct_file_tool_uses_same_broker_for_outside_approval() {
        let workspace = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let outside_file = outside.path().join("shared.txt");
        std::fs::write(&outside_file, "shared evidence").unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let provider = Arc::new(StaticApprovalProvider {
            decision: ApprovalDecision::AllowOnce {
                rationale: "用户任务需要这个文件".to_string(),
                risk_tags: Vec::new(),
            },
            calls: Arc::clone(&calls),
        });
        let profile = PermissionProfile::from_config(&jailed_security(workspace.path())).unwrap();
        let broker = Arc::new(PermissionBroker::new(Arc::new(profile), provider));
        let read = ReadFileTool::new_with_permissions(broker)
            .execute(&serde_json::json!({ "path": outside_file.to_string_lossy() }).to_string())
            .await
            .unwrap();

        assert!(read.contains("shared evidence"));
        assert_eq!(calls.load(AtomicOrdering::SeqCst), 1);
    }

    #[tokio::test]
    async fn test_write_rejects_create_overwrite_and_stale_hash() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("existing.txt");
        std::fs::write(&path, "original").unwrap();
        let write_tool = WriteFileTool::new(jailed_security(tmp.path()));

        let create_error = write_tool
            .execute(
                &serde_json::json!({
                    "path": "existing.txt",
                    "content": "clobber",
                    "mode": "create"
                })
                .to_string(),
            )
            .await
            .unwrap_err();
        assert!(create_error.to_string().contains("拒绝覆盖"));

        let stale_error = write_tool
            .execute(
                &serde_json::json!({
                    "path": "existing.txt",
                    "content": "clobber",
                    "mode": "overwrite",
                    "expected_sha256": "stale"
                })
                .to_string(),
            )
            .await
            .unwrap_err();
        assert!(stale_error.to_string().contains("版本冲突"));
        assert_eq!(std::fs::read_to_string(path).unwrap(), "original");
    }

    #[tokio::test]
    async fn test_edit_is_versioned_atomic_and_emits_file_change() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("src.rs");
        std::fs::write(&path, "fn answer() -> i32 {\n    41\n}\n").unwrap();
        let security = jailed_security(tmp.path());
        let read_tool = ReadFileTool::new(Arc::clone(&security));
        let read_output = read_tool
            .execute(&serde_json::json!({ "path": "src.rs" }).to_string())
            .await
            .unwrap();
        let expected_sha256 = hash_from_read(&read_output).to_string();

        let bus = Arc::new(crate::event::InMemoryEventBus::new());
        let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
        bus.subscribe(
            "chat/file_change".to_string(),
            Arc::new(move |event| {
                let sender = sender.clone();
                Box::pin(async move { sender.send(event).await.map_err(|error| error.into()) })
            }),
        );
        let edit_tool = EditFileTool::new_with_bus(security, Arc::clone(&bus));
        let result = CURRENT_SESSION_ID
            .scope("coding-session".to_string(), async {
                edit_tool
                    .execute(
                        &serde_json::json!({
                            "path": "src.rs",
                            "expected_sha256": expected_sha256,
                            "edits": [{
                                "old_text": "    41",
                                "new_text": "    42"
                            }]
                        })
                        .to_string(),
                    )
                    .await
            })
            .await
            .unwrap();
        assert!(result.contains("-    41"));
        assert!(result.contains("+    42"));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "fn answer() -> i32 {\n    42\n}\n"
        );
        let event = tokio::time::timeout(tokio::time::Duration::from_secs(1), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.event_type, TYPE_FILE_CHANGE);
        assert_eq!(
            event
                .payload
                .get("session_id")
                .and_then(|value| value.as_str()),
            Some("coding-session")
        );
        assert_eq!(
            event
                .payload
                .get("operation")
                .and_then(|value| value.as_str()),
            Some("edit")
        );
    }

    #[tokio::test]
    async fn test_edit_rejects_stale_hash_and_ambiguous_match_without_writing() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("duplicate.txt");
        std::fs::write(&path, "same\nsame\n").unwrap();
        let edit_tool = EditFileTool::new(jailed_security(tmp.path()));

        let stale = edit_tool
            .execute(
                &serde_json::json!({
                    "path": "duplicate.txt",
                    "expected_sha256": "stale",
                    "edits": [{ "old_text": "same", "new_text": "new" }]
                })
                .to_string(),
            )
            .await
            .unwrap_err();
        assert!(stale.to_string().contains("版本冲突"));

        let hash = sha256_hex(b"same\nsame\n");
        let ambiguous = edit_tool
            .execute(
                &serde_json::json!({
                    "path": "duplicate.txt",
                    "expected_sha256": hash,
                    "edits": [{ "old_text": "same", "new_text": "new" }]
                })
                .to_string(),
            )
            .await
            .unwrap_err();
        assert!(ambiguous.to_string().contains("匹配 2 次"));
        assert_eq!(std::fs::read_to_string(path).unwrap(), "same\nsame\n");
    }

    #[tokio::test]
    async fn test_read_file_query_and_line_range_return_numbered_evidence() {
        let tmp_file = NamedTempFile::new().unwrap();
        std::fs::write(
            tmp_file.path(),
            "alpha\ncontext before\nRetire requires reason\ncontext after\nomega\n",
        )
        .unwrap();
        let read_tool = ReadFileTool::new(permissive_security());

        let query_result = read_tool
            .execute(
                &serde_json::json!({
                    "path": tmp_file.path(),
                    "query": "retire requires",
                    "context_lines": 1
                })
                .to_string(),
            )
            .await
            .unwrap();
        assert!(query_result.contains("matches=1"));
        assert!(query_result.contains("     2 | context before"));
        assert!(query_result.contains("     3 | Retire requires reason"));
        assert!(query_result.contains("     4 | context after"));
        assert!(!query_result.contains("alpha"));

        let range_result = read_tool
            .execute(
                &serde_json::json!({
                    "path": tmp_file.path(),
                    "start_line": 3,
                    "end_line": 4
                })
                .to_string(),
            )
            .await
            .unwrap();
        assert!(range_result.contains("lines=3..4"));
        assert!(range_result.contains("     3 | Retire requires reason"));
        assert!(!range_result.contains("context before"));
    }

    #[tokio::test]
    async fn test_list_files_and_search_are_scoped_and_structured() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join("src")).unwrap();
        std::fs::create_dir_all(tmp.path().join("target")).unwrap();
        std::fs::create_dir_all(tmp.path().join(".hidden")).unwrap();
        std::fs::write(
            tmp.path().join("src/lib.rs"),
            "pub fn alpha() {}\npub fn answer() -> i32 { 42 }\n",
        )
        .unwrap();
        std::fs::write(tmp.path().join("src/readme.txt"), "answer text\n").unwrap();
        std::fs::write(tmp.path().join("target/generated.rs"), "answer\n").unwrap();
        std::fs::write(tmp.path().join(".hidden/secret.rs"), "answer\n").unwrap();
        let security = jailed_security(tmp.path());

        let list_tool = ListFilesTool::new(Arc::clone(&security));
        let listed: serde_json::Value = serde_json::from_str(
            &list_tool
                .execute(
                    &serde_json::json!({
                        "path": ".",
                        "glob": "**/*.rs"
                    })
                    .to_string(),
                )
                .await
                .unwrap(),
        )
        .unwrap();
        let entries = listed["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|entry| entry["path"] == "src/lib.rs"));
        assert!(entries
            .iter()
            .any(|entry| entry["path"] == "target/generated.rs"));

        let search_tool = SearchTool::new(security);
        let searched: serde_json::Value = serde_json::from_str(
            &search_tool
                .execute(
                    &serde_json::json!({
                        "query": "answer",
                        "paths": ["src"],
                        "glob": "**/*.rs",
                        "context_lines": 1
                    })
                    .to_string(),
                )
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(searched["count"], 1);
        assert_eq!(searched["matches"][0]["path"], "src/lib.rs");
        assert_eq!(searched["matches"][0]["line"], 2);
        assert_eq!(searched["matches"][0]["context"][0]["line"], 1);
    }

    #[tokio::test]
    async fn test_coding_tools_end_to_end_bugfix() {
        #[cfg(target_os = "macos")]
        let _sandbox_guard = MACOS_SANDBOX_EXEC_TEST_LOCK.lock().await;
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join("src")).unwrap();
        std::fs::write(
            tmp.path().join("src/lib.rs"),
            "pub fn parse_retry_after(value: &str) -> Option<u64> {\n    value.parse().ok()\n}\n",
        )
        .unwrap();
        std::fs::write(
            tmp.path().join("check.rs"),
            "#[path = \"src/lib.rs\"]\nmod lib;\n\n#[test]\nfn accepts_whitespace() {\n    assert_eq!(lib::parse_retry_after(\" 120 \\t\"), Some(120));\n}\n",
        )
        .unwrap();
        let security = jailed_security(tmp.path());

        let list = ListFilesTool::new(Arc::clone(&security))
            .execute(&serde_json::json!({ "path": ".", "glob": "**/*.rs" }).to_string())
            .await
            .unwrap();
        assert!(list.contains("src/lib.rs"));

        let search = SearchTool::new(Arc::clone(&security))
            .execute(
                &serde_json::json!({
                    "query": "parse_retry_after",
                    "paths": ["src"],
                    "glob": "**/*.rs"
                })
                .to_string(),
            )
            .await
            .unwrap();
        assert!(search.contains("src/lib.rs"));

        let read_tool = ReadFileTool::new(Arc::clone(&security));
        let read = read_tool
            .execute(&serde_json::json!({ "path": "src/lib.rs" }).to_string())
            .await
            .unwrap();
        let expected_sha256 = hash_from_read(&read).to_string();
        EditFileTool::new(Arc::clone(&security))
            .execute(
                &serde_json::json!({
                    "path": "src/lib.rs",
                    "expected_sha256": expected_sha256,
                    "edits": [{
                        "old_text": "value.parse().ok()",
                        "new_text": "value.trim().parse().ok()"
                    }]
                })
                .to_string(),
            )
            .await
            .unwrap();

        let bus = Arc::new(crate::event::InMemoryEventBus::new());
        let background = Arc::new(BackgroundTaskConfig {
            artifact_dir: tmp.path().join("artifacts").to_string_lossy().to_string(),
            ..BackgroundTaskConfig::default()
        });
        let result = ExecuteCommandTool::new_with_configs(bus, background, security, 30)
            .execute(
                &serde_json::json!({
                    "cwd": ".",
                    "command": "rustc --edition=2021 --test check.rs -o check-bin && ./check-bin",
                    "wait_ms": 30000
                })
                .to_string(),
            )
            .await
            .unwrap();
        let result_json: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(result_json["exit_code"], 0);
        assert_eq!(result_json["process_status"], "succeeded");
        assert!(result.contains("1 passed"));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn failed_exec_explains_conditional_permission_request() {
        let _sandbox_guard = MACOS_SANDBOX_EXEC_TEST_LOCK.lock().await;
        let workspace = TempDir::new().unwrap();
        let bus = Arc::new(crate::event::InMemoryEventBus::new());
        let background = Arc::new(BackgroundTaskConfig {
            artifact_dir: workspace
                .path()
                .join("artifacts")
                .to_string_lossy()
                .into_owned(),
            ..BackgroundTaskConfig::default()
        });
        let output = ExecuteCommandTool::new_with_configs(
            bus,
            background,
            jailed_security(workspace.path()),
            30,
        )
        .execute(&serde_json::json!({ "command": "exit 7" }).to_string())
        .await
        .unwrap();
        let output: serde_json::Value = serde_json::from_str(&output).unwrap();

        assert_eq!(output["exit_code"], 7);
        assert_eq!(
            output["effective_boundary"]["permission_request_available"],
            true
        );
        let guidance = output["boundary_remediation"].as_str().unwrap();
        assert!(guidance.contains("sandbox_permissions=require_escalated"));
        assert!(guidance.contains("仅当 stderr/事实明确"));
        assert!(guidance.contains("protected_paths"));
    }

    #[tokio::test]
    async fn test_tool_path_permission_fallback() {
        let read_tool = ReadFileTool::new(permissive_security());
        // 读取一个显然不存在的文件目录，校验是否返回了优雅的容错字符串而不是 panic
        let bad_args = serde_json::json!({
            "path": "/obviously_not_exist_dir/no_file.txt"
        });
        let res = read_tool.execute(&bad_args.to_string()).await.unwrap();
        assert!(res.contains("不存在") || res.contains("系统报错"));
    }

    #[tokio::test]
    async fn default_profile_requires_approval_for_path_outside_allowed_roots() {
        // 绝对路径语法本身合法；/etc/passwd 因最终路径不在允许根中而进入审批。
        let read_tool = ReadFileTool::new(Arc::new(PermissionConfig::default()));
        let bad_args = serde_json::json!({
            "path": "/etc/passwd"
        });
        let res = read_tool.execute(&bad_args.to_string()).await.unwrap();
        assert!(res.contains("权限策略") || res.contains("系统报错"));
    }

    #[tokio::test]
    async fn test_exec_tool() {
        let bus = Arc::new(crate::event::InMemoryEventBus::new());
        let tool = exec_tool_for_tests(Arc::clone(&bus));

        let args = serde_json::json!({
            "command": "echo 'hello exec'"
        });

        let res = tool.execute(&args.to_string()).await.unwrap();
        assert!(res.contains("hello exec"));
    }

    #[test]
    fn injected_secret_isolation_never_guesses_from_arbitrary_text() {
        let input = "wait_task-1783981186436392000-5698 Bearer abc.def-123 agtk_1234567890";
        assert_eq!(isolate_injected_secret_output(input, &[]), input);
        assert_eq!(
            isolate_injected_secret_output(input, &["abc.def-123".to_string()]),
            "wait_task-1783981186436392000-5698 Bearer [INJECTED_SECRET_BLOCKED] agtk_1234567890"
        );
    }

    #[tokio::test]
    async fn exec_preserves_arbitrary_text_and_isolates_only_named_environment_secrets() {
        let literal_result = exec_tool_for_tests(Arc::new(crate::event::InMemoryEventBus::new()))
            .execute(
                &serde_json::json!({
                    "command": "printf agtk_1234567890"
                })
                .to_string(),
            )
            .await
            .unwrap();
        let literal_value: serde_json::Value = serde_json::from_str(&literal_result).unwrap();
        assert_eq!(literal_value["output"], "agtk_1234567890");

        let _environment_guard = SECRET_ENV_TEST_LOCK.lock().await;
        const NAME: &str = "MORPHZ_TEST_OPAQUE";
        unsafe { std::env::set_var(NAME, "test-secret-value-123") };
        let result = exec_tool_for_tests(Arc::new(crate::event::InMemoryEventBus::new()))
            .execute(
                &serde_json::json!({
                    "command": "printf \"$MORPHZ_TEST_OPAQUE\"",
                    "requested_permissions": { "secret_env": [NAME] }
                })
                .to_string(),
            )
            .await;
        unsafe { std::env::remove_var(NAME) };
        let value: serde_json::Value = serde_json::from_str(&result.unwrap()).unwrap();
        assert_eq!(value["exit_code"], 0);
        assert_eq!(value["effective_boundary"]["secret_env"][0], NAME);
        assert!(!value.to_string().contains("test-secret-value-123"));
        assert_eq!(value["output"], "[INJECTED_SECRET_BLOCKED]");
    }

    #[test]
    fn exec_background_operator_detection_respects_shell_quoting_and_redirection() {
        assert!(contains_unquoted_background_operator("sleep 10 &"));
        assert!(contains_unquoted_background_operator(
            "python job.py > job.log 2>&1 &"
        ));
        assert!(!contains_unquoted_background_operator(
            "cargo test && echo done"
        ));
        assert!(!contains_unquoted_background_operator("printf 'R&D' 2>&1"));
        assert!(!contains_unquoted_background_operator(
            "printf \"R&D\" # background & is only a comment"
        ));
    }

    #[tokio::test]
    async fn exec_rejects_explicit_unmanaged_background_processes() {
        let workspace = TempDir::new().unwrap();
        let tool = ExecuteCommandTool::new_with_configs(
            Arc::new(crate::event::InMemoryEventBus::new()),
            Arc::new(BackgroundTaskConfig {
                artifact_dir: workspace
                    .path()
                    .join("artifacts")
                    .to_string_lossy()
                    .into_owned(),
                ..BackgroundTaskConfig::default()
            }),
            permissive_security(),
            30,
        );

        let error = tool
            .execute(&serde_json::json!({ "command": "sleep 100 &" }).to_string())
            .await
            .unwrap_err();

        assert!(error.to_string().contains("禁止使用 Shell '&'"));
    }

    #[tokio::test]
    async fn exec_kills_residual_process_group_when_detachment_is_constructed_dynamically() {
        let workspace = TempDir::new().unwrap();
        let tool = ExecuteCommandTool::new_with_configs(
            Arc::new(crate::event::InMemoryEventBus::new()),
            Arc::new(BackgroundTaskConfig {
                artifact_dir: workspace
                    .path()
                    .join("artifacts")
                    .to_string_lossy()
                    .into_owned(),
                ..BackgroundTaskConfig::default()
            }),
            permissive_security(),
            30,
        );

        let error = tool
            .execute(
                &serde_json::json!({
                    "command": "/bin/sh -c 'sleep 100 &'",
                    "wait_ms": 1_000
                })
                .to_string(),
            )
            .await
            .unwrap_err();

        assert!(error.to_string().contains("仍有子进程存活"));
    }

    #[tokio::test]
    async fn exec_cwd_outside_profile_requires_explicit_escalation() {
        let _sandbox_guard = MACOS_SANDBOX_EXEC_TEST_LOCK.lock().await;
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join("crate-a")).unwrap();
        let security = jailed_security(tmp.path());
        let background = Arc::new(BackgroundTaskConfig {
            artifact_dir: tmp.path().join("artifacts").to_string_lossy().to_string(),
            ..BackgroundTaskConfig::default()
        });
        let bus = Arc::new(crate::event::InMemoryEventBus::new());
        let tool = ExecuteCommandTool::new_with_configs(bus, background, security, 30);

        let result = tool
            .execute(
                &serde_json::json!({
                    "command": "pwd",
                    "cwd": "crate-a"
                })
                .to_string(),
            )
            .await
            .unwrap();
        assert!(
            result.contains("crate-a"),
            "unexpected exec result: {result}"
        );

        let rejected = tool
            .execute(
                &serde_json::json!({
                    "command": "pwd",
                    "cwd": "/tmp"
                })
                .to_string(),
            )
            .await
            .unwrap_err();
        assert!(rejected
            .to_string()
            .contains("sandbox_permissions=require_escalated"));
    }

    #[test]
    fn exec_permission_delta_omits_existing_scope_and_rejects_sensitive_roots() {
        let workspace = TempDir::new().unwrap();
        let inside = workspace.path().join("inside");
        std::fs::create_dir(&inside).unwrap();
        let security = jailed_security(workspace.path());
        let profile = PermissionProfile::from_config(&security).unwrap();
        let policy = SandboxPolicy::workspace(workspace.path());

        let already_allowed = requested_capability_delta(
            &RequestedExecPermissions {
                read_paths: vec![inside.to_string_lossy().into_owned()],
                ..RequestedExecPermissions::default()
            },
            &profile,
            &policy,
        )
        .unwrap();
        assert!(already_allowed.is_empty());

        let external = TempDir::new().unwrap();
        let external_file = external.path().join("known_hosts");
        std::fs::write(&external_file, "host ssh-ed25519 AAAA\n").unwrap();
        let file_delta = requested_capability_delta(
            &RequestedExecPermissions {
                read_paths: vec![external_file.to_string_lossy().into_owned()],
                ..RequestedExecPermissions::default()
            },
            &profile,
            &policy,
        )
        .unwrap();
        assert_eq!(
            file_delta.read_roots,
            vec![std::fs::canonicalize(external_file).unwrap()]
        );

        let sensitive = external.path().join(".ssh");
        std::fs::create_dir_all(&sensitive).unwrap();
        let error = requested_capability_delta(
            &RequestedExecPermissions {
                read_paths: vec![sensitive.to_string_lossy().into_owned()],
                ..RequestedExecPermissions::default()
            },
            &profile,
            &policy,
        )
        .unwrap_err();
        assert!(error.to_string().contains("protected_paths"));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn exec_escalation_is_reviewed_and_granted_for_one_command_only() {
        let _sandbox_guard = MACOS_SANDBOX_EXEC_TEST_LOCK.lock().await;
        let workspace = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let provider = Arc::new(StaticApprovalProvider {
            decision: ApprovalDecision::AllowOnce {
                rationale: "测试允许一次".to_string(),
                risk_tags: Vec::new(),
            },
            calls: Arc::clone(&calls),
        });
        let background = Arc::new(BackgroundTaskConfig {
            artifact_dir: workspace
                .path()
                .join("artifacts")
                .to_string_lossy()
                .into_owned(),
            ..BackgroundTaskConfig::default()
        });
        let tool = ExecuteCommandTool::new_with_runtime(
            Arc::new(crate::event::InMemoryEventBus::new()),
            background,
            jailed_security(workspace.path()),
            provider,
            30,
        );
        let approved_path = outside.path().join("approved.txt");
        let denied_path = outside.path().join("not-approved.txt");

        let approved = tool
            .execute(
                &serde_json::json!({
                    "command": format!("printf approved > '{}'", approved_path.display()),
                    "sandbox_permissions": "require_escalated",
                    "requested_permissions": {
                        "write_paths": [outside.path()]
                    },
                    "justification": "验证一次性目录授权"
                })
                .to_string(),
            )
            .await
            .unwrap();
        let approved_json: serde_json::Value = serde_json::from_str(&approved).unwrap();
        assert_eq!(approved_json["exit_code"], 0, "{approved}");
        assert_eq!(std::fs::read_to_string(&approved_path).unwrap(), "approved");
        assert_eq!(calls.load(AtomicOrdering::SeqCst), 1);

        let denied = tool
            .execute(
                &serde_json::json!({
                    "command": format!("printf denied > '{}'", denied_path.display())
                })
                .to_string(),
            )
            .await
            .unwrap();
        assert!(!denied.contains("退出码: 0"));
        assert!(!denied_path.exists());
        assert_eq!(calls.load(AtomicOrdering::SeqCst), 1);
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn exec_approval_time_is_deducted_before_synchronous_child_wait() {
        let _sandbox_guard = MACOS_SANDBOX_EXEC_TEST_LOCK.lock().await;
        let workspace = TempDir::new().unwrap();
        let bus = Arc::new(crate::event::InMemoryEventBus::new());
        let tool = ExecuteCommandTool::new_with_runtime(
            Arc::clone(&bus),
            Arc::new(BackgroundTaskConfig {
                timeout_notify_enabled: false,
                artifact_dir: workspace
                    .path()
                    .join("artifacts")
                    .to_string_lossy()
                    .into_owned(),
                ..BackgroundTaskConfig::default()
            }),
            jailed_security(workspace.path()),
            Arc::new(DelayedApprovalProvider {
                delay: tokio::time::Duration::from_millis(800),
            }),
            2,
        );

        // The orchestrator applies this same two-second timeout around the complete tool call.
        // Approval consumes 800ms. The child must therefore detach using the remaining budget,
        // rather than waiting another full 1.75s and being abandoned in `Starting`.
        let result = tokio::time::timeout(
            tokio::time::Duration::from_secs(2),
            tool.execute(
                &serde_json::json!({
                    "command": "sleep 5",
                    "wait_ms": 2_000,
                    "sandbox_permissions": "require_escalated",
                    "requested_permissions": { "network": true },
                    "justification": "验证审批耗时计入 exec 同步预算"
                })
                .to_string(),
            ),
        )
        .await
        .expect("exec must detach before the whole-tool timeout")
        .unwrap();
        let result: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(result["execution"], "background", "{result}");
        assert_eq!(result["task_status"], "running", "{result}");

        let task_id = result["task_id"].as_str().unwrap();
        KillTaskTool::without_scheduler()
            .execute(&serde_json::json!({ "task_id": task_id }).to_string())
            .await
            .unwrap();
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn exec_escalation_denial_prevents_process_start() {
        let workspace = TempDir::new().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let provider = Arc::new(StaticApprovalProvider {
            decision: ApprovalDecision::Deny {
                rationale: "测试拒绝".to_string(),
                risk_tags: vec!["test".to_string()],
            },
            calls: Arc::clone(&calls),
        });
        let tool = ExecuteCommandTool::new_with_runtime(
            Arc::new(crate::event::InMemoryEventBus::new()),
            Arc::new(BackgroundTaskConfig {
                artifact_dir: workspace
                    .path()
                    .join("artifacts")
                    .to_string_lossy()
                    .into_owned(),
                ..BackgroundTaskConfig::default()
            }),
            jailed_security(workspace.path()),
            provider,
            30,
        );

        let error = tool
            .execute(
                &serde_json::json!({
                    "command": "printf should-not-run > denied.txt",
                    "sandbox_permissions": "require_escalated",
                    "requested_permissions": { "network": true },
                    "justification": "验证拒绝路径"
                })
                .to_string(),
            )
            .await
            .unwrap_err();

        assert!(error.to_string().contains("权限审批拒绝"));
        assert!(!workspace.path().join("denied.txt").exists());
        assert_eq!(calls.load(AtomicOrdering::SeqCst), 1);
    }

    #[tokio::test]
    async fn test_exec_archives_full_output_when_context_preview_is_truncated() {
        let tmp = TempDir::new().unwrap();
        let bus = Arc::new(crate::event::InMemoryEventBus::new());
        let background = Arc::new(BackgroundTaskConfig {
            max_output_buffer_bytes: 5,
            artifact_dir: tmp.path().to_string_lossy().to_string(),
            ..BackgroundTaskConfig::default()
        });
        let tool = ExecuteCommandTool::new_with_configs(bus, background, permissive_security(), 30);
        let result = tool
            .execute(&serde_json::json!({ "command": "printf abcdefghi" }).to_string())
            .await
            .unwrap();
        assert!(result.contains("Context preview 已按缓冲上限截断"));

        let archive_path = std::fs::read_dir(tmp.path())
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(std::fs::read_to_string(archive_path).unwrap(), "abcdefghi");
    }

    #[tokio::test]
    async fn test_command_detach_to_background() {
        let bus = Arc::new(crate::event::InMemoryEventBus::new());
        let tool = exec_tool_for_tests(Arc::clone(&bus));

        // 启动一个长耗时命令并缩短同步等待超时
        let args = serde_json::json!({
            "command": "sleep 10 && echo 'finished'",
            "wait_ms": 1000
        });

        let res = tool.execute(&args.to_string()).await.unwrap();
        let result: serde_json::Value = serde_json::from_str(&res).unwrap();
        assert_eq!(result["execution"], "background");
        assert_eq!(result["task_status"], "running");
        let task_id = result["task_id"].as_str().unwrap();
        assert!(task_id.starts_with("task_"));
        KillTaskTool::without_scheduler()
            .execute(&serde_json::json!({ "task_id": task_id }).to_string())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn cancelling_exec_future_terminates_the_whole_process_group() {
        let workspace = TempDir::new().unwrap();
        let artifacts = workspace.path().join("artifacts");
        let started = workspace.path().join("started");
        let completed = workspace.path().join("completed");
        let tool = Arc::new(ExecuteCommandTool::new_with_configs(
            Arc::new(crate::event::InMemoryEventBus::new()),
            Arc::new(BackgroundTaskConfig {
                artifact_dir: artifacts.to_string_lossy().into_owned(),
                ..BackgroundTaskConfig::default()
            }),
            permissive_security(),
            30,
        ));
        let arguments = serde_json::json!({
            "command": format!(
                "touch '{}' && sleep 1 && touch '{}'",
                started.display(),
                completed.display()
            ),
            "wait_ms": 10_000
        })
        .to_string();
        let execution = {
            let tool = Arc::clone(&tool);
            tokio::spawn(async move { tool.execute(&arguments).await })
        };

        tokio::time::timeout(tokio::time::Duration::from_secs(2), async {
            while !started.exists() {
                tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("exec process should start before cancellation");
        execution.abort();
        let _ = execution.await;
        tokio::time::sleep(tokio::time::Duration::from_millis(1_200)).await;

        assert!(started.exists());
        assert!(
            !completed.exists(),
            "aborted exec future left a descendant process running"
        );
    }

    #[tokio::test]
    async fn durable_background_process_completion_commits_one_terminal_event_and_outbox() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(database.path().to_string_lossy().as_ref())
                .await
                .unwrap(),
        );
        let bus = Arc::new(InMemoryEventBus::new());
        let (sender, mut receiver) = tokio::sync::mpsc::channel(4);
        bus.subscribe(
            "chat/tool_output".to_string(),
            Arc::new(move |event| {
                let sender = sender.clone();
                Box::pin(async move { sender.send(event).await.map_err(|error| error.into()) })
            }),
        );
        let scheduler =
            start_test_durable_background_scheduler(Arc::clone(&bus), Arc::clone(&store));
        let artifacts = TempDir::new().unwrap();
        let tool = ExecuteCommandTool::new_with_permissions_and_scheduler(
            Arc::clone(&bus),
            Arc::new(BackgroundTaskConfig {
                artifact_dir: artifacts.path().to_string_lossy().to_string(),
                timeout_notify_enabled: false,
                ..BackgroundTaskConfig::default()
            }),
            broker_from_config(permissive_security()),
            30,
            Some(Arc::clone(&scheduler)),
        );
        let parent = ToolExecutionJobContext {
            parent_job_id: deterministic_job_id(
                "activation-durable-background-success",
                "exec-call-durable-background-success",
            )
            .unwrap(),
            activation_id: "activation-durable-background-success".to_string(),
            thread_id: "thread-durable-background-success".to_string(),
            agent_id: "agent-durable-background-success".to_string(),
            context_id: "context-durable-background-success".to_string(),
            session_id: "session-durable-background-success".to_string(),
            initiating_principal_id: None,
            target_id: crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
            tool_call_id: "exec-call-durable-background-success".to_string(),
        };
        seed_test_execution_route(
            &store,
            &parent,
            "root-durable-background-success",
            "trigger-durable-background-success",
        )
        .await;
        let result = CURRENT_EXECUTION_JOB
            .scope(
                Some(parent.clone()),
                CURRENT_SESSION_ID.scope(
                    parent.session_id.clone(),
                    CURRENT_CONTEXT_ID.scope(
                        parent.context_id.clone(),
                        CURRENT_ATTEMPT_ID.scope(
                            parent.activation_id.clone(),
                            tool.execute(
                                &serde_json::json!({
                                    "command": "sleep 0.2 && printf durable-done",
                                    "wait_ms": 10
                                })
                                .to_string(),
                            ),
                        ),
                    ),
                ),
            )
            .await
            .unwrap();
        let result: serde_json::Value = serde_json::from_str(&result).unwrap();
        let task_id = result["task_id"].as_str().unwrap().to_string();
        assert_eq!(result["execution"], "background");

        let completion = tokio::time::timeout(std::time::Duration::from_secs(3), receiver.recv())
            .await
            .expect("background process must complete")
            .expect("completion channel must remain open");
        assert_eq!(completion.payload["task_id"], task_id);
        assert_eq!(completion.payload["task_status"], "succeeded");
        assert_eq!(completion.payload["exit_code"], 0);
        let terminal = store.get_execution_job(&task_id).await.unwrap().unwrap();
        assert_eq!(terminal.status, ExecutionJobStatus::Succeeded);
        assert_eq!(
            terminal.result_event_id.as_deref(),
            Some(completion.id.as_str())
        );
        assert_eq!(
            store
                .query(QueryFilter {
                    event_id: Some(completion.id.clone()),
                    ..Default::default()
                })
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .list_signal_outbox(crate::memory::SignalOutboxStatus::Pending, 16)
                .await
                .unwrap()
                .into_iter()
                .filter(|outbox| outbox.event_id == completion.id)
                .count(),
            1
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(150), receiver.recv())
                .await
                .is_err(),
            "one physical completion must not produce duplicate wakes"
        );
        get_tasks_map().remove(&task_id);
    }

    #[tokio::test]
    async fn durable_background_execution_is_authoritative_and_cancelled_after_pgid_exit() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(database.path().to_string_lossy().as_ref())
                .await
                .unwrap(),
        );
        let bus = Arc::new(InMemoryEventBus::new());
        let (sender, mut receiver) = tokio::sync::mpsc::channel(4);
        bus.subscribe(
            "chat/tool_output".to_string(),
            Arc::new(move |event| {
                let sender = sender.clone();
                Box::pin(async move { sender.send(event).await.map_err(|error| error.into()) })
            }),
        );
        let scheduler =
            start_test_durable_background_scheduler(Arc::clone(&bus), Arc::clone(&store));
        let artifacts = TempDir::new().unwrap();
        let tool = ExecuteCommandTool::new_with_permissions_and_scheduler(
            Arc::clone(&bus),
            Arc::new(BackgroundTaskConfig {
                artifact_dir: artifacts.path().to_string_lossy().to_string(),
                timeout_notify_enabled: false,
                ..BackgroundTaskConfig::default()
            }),
            broker_from_config(permissive_security()),
            30,
            Some(Arc::clone(&scheduler)),
        );
        let parent = ToolExecutionJobContext {
            parent_job_id: deterministic_job_id(
                "activation-durable-background",
                "exec-call-durable-background",
            )
            .unwrap(),
            activation_id: "activation-durable-background".to_string(),
            thread_id: "thread-durable-background".to_string(),
            agent_id: "agent-durable-background".to_string(),
            context_id: "context-durable-background".to_string(),
            session_id: "session-durable-background".to_string(),
            initiating_principal_id: None,
            target_id: crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
            tool_call_id: "exec-call-durable-background".to_string(),
        };
        seed_test_execution_route(
            &store,
            &parent,
            "root-durable-background",
            "trigger-durable-background",
        )
        .await;
        let result = CURRENT_EXECUTION_JOB
            .scope(
                Some(parent.clone()),
                CURRENT_SESSION_ID.scope(
                    parent.session_id.clone(),
                    CURRENT_CONTEXT_ID.scope(
                        parent.context_id.clone(),
                        CURRENT_ATTEMPT_ID.scope(
                            parent.activation_id.clone(),
                            CURRENT_CAUSAL_ROUTE.scope(
                                Some(ToolCausalRoute {
                                    thread_id: parent.thread_id.clone(),
                                    activation_id: parent.activation_id.clone(),
                                    root_turn_id: "root-durable-background".to_string(),
                                    trigger_event_id: "trigger-durable-background".to_string(),
                                    trigger_sequence: 7,
                                }),
                                tool.execute(
                                    &serde_json::json!({
                                        "command": "sleep 30",
                                        "wait_ms": 10
                                    })
                                    .to_string(),
                                ),
                            ),
                        ),
                    ),
                ),
            )
            .await
            .unwrap();
        let result: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(result["execution"], "background");
        let task_id = result["task_id"].as_str().unwrap().to_string();
        assert!(task_id.starts_with("job_"));

        let running = store.get_execution_job(&task_id).await.unwrap().unwrap();
        assert_eq!(running.status, ExecutionJobStatus::Running);
        assert_eq!(running.tool_name, "exec/background");
        assert!(running.side_effect_started_at.is_some());

        let status = CURRENT_CONTEXT_ID
            .scope(
                parent.context_id.clone(),
                TaskStatusTool::new(Arc::clone(&scheduler))
                    .execute(&serde_json::json!({ "task_id": task_id }).to_string()),
            )
            .await
            .unwrap();
        let status: serde_json::Value = serde_json::from_str(&status).unwrap();
        assert_eq!(status["task"]["status"], "running");
        assert_eq!(status["task"]["live_owner"], true);

        let waiting = CURRENT_CONTEXT_ID
            .scope(
                parent.context_id.clone(),
                CheckTaskAfterTool::new(Arc::clone(&scheduler), 60).execute(
                    &serde_json::json!({ "task_id": task_id, "check_after_secs": 1 }).to_string(),
                ),
            )
            .await
            .unwrap();
        let waiting: serde_json::Value = serde_json::from_str(&waiting).unwrap();
        assert_eq!(waiting["waiting"], true);
        let replaced_wait = CURRENT_CONTEXT_ID
            .scope(
                parent.context_id.clone(),
                CheckTaskAfterTool::new(Arc::clone(&scheduler), 60).execute(
                    &serde_json::json!({ "task_id": task_id, "check_after_secs": 1 }).to_string(),
                ),
            )
            .await
            .unwrap();
        let replaced_wait: serde_json::Value = serde_json::from_str(&replaced_wait).unwrap();
        assert_eq!(replaced_wait["waiting"], true);
        let checkpoint = tokio::time::timeout(std::time::Duration::from_secs(2), receiver.recv())
            .await
            .expect("wait timer must wake without polling")
            .expect("wait checkpoint channel must remain open");
        assert_eq!(checkpoint.payload["event"], "background_task_check_due");
        assert_eq!(checkpoint.payload["task_status"], "running");
        assert_eq!(
            store
                .get_execution_job(&task_id)
                .await
                .unwrap()
                .unwrap()
                .status,
            ExecutionJobStatus::Running,
            "wait checkpoint must not terminate the child ExecutionJob"
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(150), receiver.recv())
                .await
                .is_err(),
            "replacing a wait timer generation must not produce duplicate wakes"
        );

        let killed = CURRENT_CONTEXT_ID
            .scope(
                parent.context_id.clone(),
                KillTaskTool::new(Arc::clone(&scheduler))
                    .execute(&serde_json::json!({ "task_id": task_id }).to_string()),
            )
            .await
            .unwrap();
        let killed: serde_json::Value = serde_json::from_str(&killed).unwrap();
        assert_eq!(killed["status"], "cancel_requested");
        assert_eq!(killed["killed"], true);

        let completion = tokio::time::timeout(std::time::Duration::from_secs(3), receiver.recv())
            .await
            .expect("cancelled process must emit one durable completion")
            .expect("completion channel must remain open");
        assert_eq!(completion.payload["task_id"], task_id);
        assert_eq!(completion.payload["task_status"], "cancelled");
        assert_eq!(completion.payload["tool_name"], "exec/background");

        let terminal = store.get_execution_job(&task_id).await.unwrap().unwrap();
        assert_eq!(terminal.status, ExecutionJobStatus::Cancelled);
        assert_eq!(
            terminal.result_event_id.as_deref(),
            Some(completion.id.as_str())
        );
        assert!(
            !scheduler
                .finish_background_execution(&task_id, -9, "", "")
                .await
                .unwrap(),
            "terminal replay must not emit another completion"
        );
        let completion_events = store
            .query(QueryFilter {
                event_id: Some(completion.id.clone()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(completion_events.len(), 1);
        let completion_outboxes = store
            .list_signal_outbox(crate::memory::SignalOutboxStatus::Pending, 16)
            .await
            .unwrap()
            .into_iter()
            .filter(|outbox| outbox.event_id == completion.id)
            .collect::<Vec<_>>();
        assert_eq!(completion_outboxes.len(), 1);

        get_tasks_map().remove(&task_id);
        let terminal_status = CURRENT_CONTEXT_ID
            .scope(
                parent.context_id.clone(),
                TaskStatusTool::new(Arc::clone(&scheduler))
                    .execute(&serde_json::json!({ "task_id": task_id }).to_string()),
            )
            .await
            .unwrap();
        let terminal_status: serde_json::Value = serde_json::from_str(&terminal_status).unwrap();
        assert_eq!(terminal_status["task"]["status"], "cancelled");
        assert_eq!(terminal_status["task"]["live_owner"], false);
        let terminal_list = CURRENT_CONTEXT_ID
            .scope(
                parent.context_id.clone(),
                ListTasksTool::new(Arc::clone(&scheduler))
                    .execute(&serde_json::json!({ "include_finished": true }).to_string()),
            )
            .await
            .unwrap();
        let terminal_list: serde_json::Value = serde_json::from_str(&terminal_list).unwrap();
        assert_eq!(terminal_list["count"], 1);
        assert_eq!(terminal_list["tasks"][0]["status"], "cancelled");
        let terminal_check = CURRENT_CONTEXT_ID
            .scope(
                parent.context_id.clone(),
                CheckTaskAfterTool::new(Arc::clone(&scheduler), 60)
                    .execute(&serde_json::json!({ "task_id": task_id }).to_string()),
            )
            .await
            .unwrap();
        let terminal_check: serde_json::Value = serde_json::from_str(&terminal_check).unwrap();
        assert_eq!(terminal_check["scheduled"], false);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(150), receiver.recv())
                .await
                .is_err(),
            "terminal wait must not poll or wake the Thread again"
        );
    }

    #[tokio::test]
    async fn restart_marks_unowned_background_job_lost_and_controls_read_store() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(database.path().to_string_lossy().as_ref())
                .await
                .unwrap(),
        );
        let bus = Arc::new(InMemoryEventBus::new());
        let (sender, mut receiver) = tokio::sync::mpsc::channel(2);
        bus.subscribe(
            "chat/tool_output".to_string(),
            Arc::new(move |event| {
                let sender = sender.clone();
                Box::pin(async move { sender.send(event).await.map_err(|error| error.into()) })
            }),
        );
        let timers = Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>));
        let manager = Arc::new(ExecutionJobManager::new(
            Arc::clone(&store) as Arc<dyn ExecutionJobStore>
        ));
        let scheduler = Arc::new(BackgroundTaskScheduler::new_with_execution_jobs(
            Arc::clone(&bus),
            Arc::clone(&store) as Arc<dyn EventStore>,
            Arc::clone(&timers),
            Arc::clone(&manager),
        ));
        scheduler.register_timer_handler().unwrap();
        let parent = ToolExecutionJobContext {
            parent_job_id: deterministic_job_id(
                "activation-restart-background",
                "exec-call-restart-background",
            )
            .unwrap(),
            activation_id: "activation-restart-background".to_string(),
            thread_id: "thread-restart-background".to_string(),
            agent_id: "agent-restart-background".to_string(),
            context_id: "context-restart-background".to_string(),
            session_id: "session-restart-background".to_string(),
            initiating_principal_id: None,
            target_id: crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
            tool_call_id: "exec-call-restart-background".to_string(),
        };
        seed_test_execution_route(
            &store,
            &parent,
            "root-restart-background",
            "trigger-restart-background",
        )
        .await;
        let child_call_id = format!("{}:background", parent.tool_call_id);
        let task_id = deterministic_job_id(&parent.activation_id, &child_call_id).unwrap();
        let mut job = manager
            .ensure(ExecutionJobSpec {
                activation_id: parent.activation_id.clone(),
                thread_id: parent.thread_id.clone(),
                agent_id: parent.agent_id.clone(),
                context_id: parent.context_id.clone(),
                session_id: parent.session_id.clone(),
                initiating_principal_id: None,
                target_id: parent.target_id.clone(),
                tool_call_id: child_call_id,
                tool_name: "exec/background".to_string(),
                request: serde_json::json!({
                    "kind": "background_exec",
                    "task_id": task_id,
                    "command": "long-running-before-restart",
                    "process_group_id": 424242,
                    "artifact_path": "/tmp/restart-background.log",
                    "started_at": chrono::Utc::now(),
                    "effective_boundary": {}
                }),
                retry_safety: ExecutionRetrySafety::ReconcileRequired,
                requires_approval: false,
            })
            .await
            .unwrap();
        let claim_token = "restart-background-claim";
        job = applied_background_job(
            manager
                .claim(
                    &job.id,
                    job.revision,
                    JobClaim {
                        worker_id: "dead-runtime",
                        claim_token,
                        lease_expires_at: chrono::Utc::now() + chrono::Duration::minutes(2),
                        approval_ref: None,
                    },
                )
                .await
                .unwrap(),
            "claim",
        )
        .unwrap();
        job = applied_background_job(
            manager
                .heartbeat(
                    &job.id,
                    job.revision,
                    JobHeartbeat {
                        claim_token,
                        lease_expires_at: chrono::Utc::now() + chrono::Duration::minutes(2),
                        side_effect_started_at: Some(chrono::Utc::now()),
                        progress_ref: Some("/tmp/restart-background.log"),
                    },
                )
                .await
                .unwrap(),
            "side-effect boundary",
        )
        .unwrap();
        assert_eq!(job.status, ExecutionJobStatus::Running);
        assert!(!get_tasks_map().contains_key(&task_id));

        // The parent `exec` Action has already returned the detached-task
        // receipt by the time a real Runtime can restart.  Only the child
        // process is still physically outstanding.  Keep the fixture faithful
        // to that boundary so restart reconciliation cannot manufacture an
        // unrelated lost parent Action.
        let parent_job = manager
            .store()
            .get_execution_job(&parent.parent_job_id)
            .await
            .unwrap()
            .unwrap();
        let parent_claim_token = format!("test-parent-claim-{}", parent.activation_id);
        let parent_terminal = applied_background_job(
            manager
                .finish(
                    &parent_job.id,
                    parent_job.revision,
                    Some(&parent_claim_token),
                    JobOutcome::Succeeded {
                        result_event_id: None,
                        result_refs: Vec::new(),
                        exit_code: None,
                    },
                )
                .await
                .unwrap(),
            "parent detached receipt",
        )
        .unwrap();
        assert_eq!(parent_terminal.status, ExecutionJobStatus::Succeeded);

        let recovery = manager
            .reconcile_startup(
                crate::memory::WorkerCoordinationMode::ExclusiveProcess,
                store.as_ref(),
            )
            .await
            .unwrap();
        assert_eq!(recovery.lost_receipts.len(), 1);
        assert_eq!(
            scheduler
                .recover_terminal_background_outboxes()
                .await
                .unwrap(),
            1
        );
        // Recovery replay may try to arm delivery again, but Event/Outbox
        // identities remain deterministic and physically unique.
        scheduler
            .recover_terminal_background_outboxes()
            .await
            .unwrap();
        let lost = store.get_execution_job(&task_id).await.unwrap().unwrap();
        assert_eq!(lost.status, ExecutionJobStatus::Lost);
        let lost_event_id = lost.result_event_id.as_deref().unwrap();
        assert_eq!(
            store
                .query(QueryFilter {
                    event_id: Some(lost_event_id.to_string()),
                    ..Default::default()
                })
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .list_signal_outbox(crate::memory::SignalOutboxStatus::Pending, 16)
                .await
                .unwrap()
                .into_iter()
                .filter(|outbox| outbox.event_id == lost_event_id)
                .count(),
            1
        );

        let status = CURRENT_CONTEXT_ID
            .scope(
                parent.context_id.clone(),
                TaskStatusTool::new(Arc::clone(&scheduler))
                    .execute(&serde_json::json!({ "task_id": task_id }).to_string()),
            )
            .await
            .unwrap();
        let status: serde_json::Value = serde_json::from_str(&status).unwrap();
        assert_eq!(status["task"]["status"], "lost");
        assert_eq!(status["task"]["live_owner"], false);

        let listed = CURRENT_CONTEXT_ID
            .scope(
                parent.context_id.clone(),
                ListTasksTool::new(Arc::clone(&scheduler))
                    .execute(&serde_json::json!({ "include_finished": true }).to_string()),
            )
            .await
            .unwrap();
        let listed: serde_json::Value = serde_json::from_str(&listed).unwrap();
        assert_eq!(listed["count"], 1);
        assert_eq!(listed["tasks"][0]["task_id"], task_id);

        let checked = CURRENT_CONTEXT_ID
            .scope(
                parent.context_id.clone(),
                CheckTaskAfterTool::new(Arc::clone(&scheduler), 60)
                    .execute(&serde_json::json!({ "task_id": task_id }).to_string()),
            )
            .await
            .unwrap();
        let checked: serde_json::Value = serde_json::from_str(&checked).unwrap();
        assert_eq!(checked["scheduled"], false);
        assert_eq!(checked["task"]["status"], "lost");

        let timer_id = background_wake_timer_id(&task_id);
        timers.start();
        scheduler
            .timers
            .schedule(NewRuntimeTimer {
                id: timer_id.clone(),
                generation: 1,
                kind: RuntimeTimerKind::BackgroundWake,
                owner_id: task_id,
                due_at: chrono::Utc::now(),
                payload: serde_json::json!({
                    "generation": 1,
                    "wait_secs": 60,
                    "wake_source": "restart-test"
                }),
            })
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if store
                    .get_runtime_timer(&timer_id)
                    .await
                    .unwrap()
                    .is_some_and(|timer| timer.status == crate::memory::RuntimeTimerStatus::Fired)
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), receiver.recv())
                .await
                .is_err(),
            "lost Job 的陈旧 wait timer 不得伪造仍在运行 observation"
        );
    }

    #[tokio::test]
    async fn restart_closes_running_job_from_already_durable_result_event() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(database.path().to_string_lossy().as_ref())
                .await
                .unwrap(),
        );
        let manager = Arc::new(ExecutionJobManager::new(
            Arc::clone(&store) as Arc<dyn ExecutionJobStore>
        ));
        let route = ToolExecutionJobContext {
            parent_job_id: deterministic_job_id("activation-result-first", "parent-call").unwrap(),
            activation_id: "activation-result-first".to_string(),
            thread_id: "thread-result-first".to_string(),
            agent_id: "agent-result-first".to_string(),
            context_id: "context-result-first".to_string(),
            session_id: "session-result-first".to_string(),
            initiating_principal_id: None,
            target_id: crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
            tool_call_id: "parent-call".to_string(),
        };
        seed_test_execution_route(&store, &route, "root-result-first", "trigger-result-first")
            .await;
        let parent_job = manager
            .store()
            .get_execution_job(&route.parent_job_id)
            .await
            .unwrap()
            .unwrap();
        let parent_claim_token = format!("test-parent-claim-{}", route.activation_id);
        applied_background_job(
            manager
                .finish(
                    &parent_job.id,
                    parent_job.revision,
                    Some(&parent_claim_token),
                    JobOutcome::Succeeded {
                        result_event_id: None,
                        result_refs: Vec::new(),
                        exit_code: None,
                    },
                )
                .await
                .unwrap(),
            "finish parent",
        )
        .unwrap();

        let tool_call_id = "call-read-result-first";
        let mut job = manager
            .ensure(ExecutionJobSpec {
                activation_id: route.activation_id.clone(),
                thread_id: route.thread_id.clone(),
                agent_id: route.agent_id.clone(),
                context_id: route.context_id.clone(),
                session_id: route.session_id.clone(),
                initiating_principal_id: None,
                target_id: route.target_id.clone(),
                tool_call_id: tool_call_id.to_string(),
                tool_name: "read".to_string(),
                request: serde_json::json!({"path": "README.md"}),
                retry_safety: ExecutionRetrySafety::Idempotent,
                requires_approval: false,
            })
            .await
            .unwrap();
        let claim_token = "claim-read-result-first";
        job = applied_background_job(
            manager
                .claim(
                    &job.id,
                    job.revision,
                    JobClaim {
                        worker_id: "dead-runtime",
                        claim_token,
                        lease_expires_at: chrono::Utc::now() + chrono::Duration::minutes(2),
                        approval_ref: None,
                    },
                )
                .await
                .unwrap(),
            "claim read",
        )
        .unwrap();
        job = applied_background_job(
            manager
                .heartbeat(
                    &job.id,
                    job.revision,
                    JobHeartbeat {
                        claim_token,
                        lease_expires_at: chrono::Utc::now() + chrono::Duration::minutes(2),
                        side_effect_started_at: Some(chrono::Utc::now()),
                        progress_ref: None,
                    },
                )
                .await
                .unwrap(),
            "read side-effect boundary",
        )
        .unwrap();
        assert_eq!(job.status, ExecutionJobStatus::Running);

        let output = Event::new(
            format!("output_{}_{}", route.activation_id, tool_call_id),
            "System-Tool".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            serde_json::Map::from_iter([
                (
                    "context_id".to_string(),
                    serde_json::json!(route.context_id),
                ),
                (
                    "session_id".to_string(),
                    serde_json::json!(route.session_id),
                ),
                (
                    "activation_id".to_string(),
                    serde_json::json!(route.activation_id),
                ),
                ("thread_id".to_string(), serde_json::json!(route.thread_id)),
                (
                    "attempt_id".to_string(),
                    serde_json::json!(route.activation_id),
                ),
                ("tool_call_id".to_string(), serde_json::json!(tool_call_id)),
                ("caused_by".to_string(), serde_json::json!(tool_call_id)),
                ("tool_name".to_string(), serde_json::json!("read")),
                ("tool_status".to_string(), serde_json::json!("success")),
                (
                    "action_group_id".to_string(),
                    serde_json::json!("group-result-first"),
                ),
                (
                    "text".to_string(),
                    serde_json::json!("[path=README.md]\ncontents"),
                ),
            ]),
        );
        store.append(output.clone()).await.unwrap();

        // A crash may happen even earlier: the immutable tool result can win
        // while the Job projection is still queued and has never held a claim.
        // Startup recovery must adopt that fact without weakening normal
        // worker-fenced completion.
        let queued_call_id = "call-read-result-before-claim";
        let queued_job = manager
            .ensure(ExecutionJobSpec {
                activation_id: route.activation_id.clone(),
                thread_id: route.thread_id.clone(),
                agent_id: route.agent_id.clone(),
                context_id: route.context_id.clone(),
                session_id: route.session_id.clone(),
                initiating_principal_id: None,
                target_id: route.target_id.clone(),
                tool_call_id: queued_call_id.to_string(),
                tool_name: "read".to_string(),
                request: serde_json::json!({"path": "Cargo.toml"}),
                retry_safety: ExecutionRetrySafety::Idempotent,
                requires_approval: false,
            })
            .await
            .unwrap();
        assert_eq!(queued_job.status, ExecutionJobStatus::Queued);
        let queued_output = Event::new(
            format!("output_{}_{}", route.activation_id, queued_call_id),
            "System-Tool".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            serde_json::Map::from_iter([
                (
                    "context_id".to_string(),
                    serde_json::json!(route.context_id),
                ),
                (
                    "session_id".to_string(),
                    serde_json::json!(route.session_id),
                ),
                (
                    "activation_id".to_string(),
                    serde_json::json!(route.activation_id),
                ),
                ("thread_id".to_string(), serde_json::json!(route.thread_id)),
                (
                    "attempt_id".to_string(),
                    serde_json::json!(route.activation_id),
                ),
                (
                    "tool_call_id".to_string(),
                    serde_json::json!(queued_call_id),
                ),
                ("caused_by".to_string(), serde_json::json!(queued_call_id)),
                ("tool_name".to_string(), serde_json::json!("read")),
                ("tool_status".to_string(), serde_json::json!("success")),
                (
                    "action_group_id".to_string(),
                    serde_json::json!("group-result-first"),
                ),
                (
                    "text".to_string(),
                    serde_json::json!("[path=Cargo.toml]\ncontents"),
                ),
            ]),
        );
        store.append(queued_output.clone()).await.unwrap();

        let recovery = manager
            .reconcile_startup(
                crate::memory::WorkerCoordinationMode::ExclusiveProcess,
                store.as_ref(),
            )
            .await
            .unwrap();
        assert_eq!(recovery.recovered_receipts.len(), 2);
        assert!(recovery.lost_receipts.is_empty());
        assert!(recovery.requeue_receipts.is_empty());
        let recovered = store.get_execution_job(&job.id).await.unwrap().unwrap();
        assert_eq!(recovered.status, ExecutionJobStatus::Succeeded);
        assert_eq!(
            recovered.result_event_id.as_deref(),
            Some(output.id.as_str())
        );
        let recovered_queued = store
            .get_execution_job(&queued_job.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(recovered_queued.status, ExecutionJobStatus::Succeeded);
        assert_eq!(
            recovered_queued.result_event_id.as_deref(),
            Some(queued_output.id.as_str())
        );
        assert!(store
            .list_signal_outbox(crate::memory::SignalOutboxStatus::Pending, 16)
            .await
            .unwrap()
            .into_iter()
            .all(|entry| entry.event_id != output.id));
    }

    #[tokio::test]
    async fn background_completion_preserves_the_originating_causal_route() {
        let bus = Arc::new(crate::event::InMemoryEventBus::new());
        let (sender, mut receiver) = tokio::sync::mpsc::channel(4);
        bus.subscribe(
            "chat/tool_output".to_string(),
            Arc::new(move |event| {
                let sender = sender.clone();
                Box::pin(async move { sender.send(event).await.map_err(|error| error.into()) })
            }),
        );
        let tool = exec_tool_for_tests(Arc::clone(&bus));
        let route = ToolCausalRoute {
            thread_id: "thread-causal-background".to_string(),
            activation_id: "work-causal-background".to_string(),
            root_turn_id: "root-causal-background".to_string(),
            trigger_event_id: "trigger-causal-background".to_string(),
            trigger_sequence: 42,
        };
        let result = CURRENT_CAUSAL_ROUTE
            .scope(Some(route.clone()), async {
                tool.execute(
                    &serde_json::json!({
                        "command": "sleep 1 && printf done",
                        "wait_ms": 10
                    })
                    .to_string(),
                )
                .await
            })
            .await
            .unwrap();
        let result: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(result["execution"], "background");

        let completion = tokio::time::timeout(tokio::time::Duration::from_secs(3), receiver.recv())
            .await
            .expect("background task must finish")
            .expect("completion event must be published");
        assert_eq!(completion.payload["activation_id"], route.activation_id);
        assert_eq!(completion.payload["root_turn_id"], route.root_turn_id);
        assert_eq!(
            completion.payload["trigger_event_id"],
            route.trigger_event_id
        );
        assert_eq!(completion.payload["trigger_sequence"], 42);
    }

    #[tokio::test]
    async fn check_task_after_can_rearm_agent_chosen_checkpoints_without_killing_the_task() {
        let task_id = format!(
            "wait_rearm_{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        );
        let now = chrono::Utc::now();
        get_tasks_map().insert(
            task_id.clone(),
            BackgroundTask {
                id: task_id.clone(),
                cmd_str: "long-running-test".to_string(),
                pgid: i32::MAX,
                session_id: "wait-rearm-session".to_string(),
                context_id: "wait-rearm-context".to_string(),
                initiating_principal_id: None,
                causal_route: None,
                keep_running: false,
                started_at: now,
                last_output_at: now,
                output_bytes: 8,
                output_tail: "working\n".to_string(),
                wake_generation: 0,
                next_wakeup_at: None,
                status: BackgroundTaskStatus::Running,
                effective_network: false,
                permission_request_available: true,
                secret_env: Vec::new(),
                sandbox_backend: "test".to_string(),
                sandbox_status: "enforced".to_string(),
                artifact_path: "test-artifact.log".to_string(),
                ended_at: None,
                exit_code: None,
            },
        );

        let bus = Arc::new(crate::event::InMemoryEventBus::new());
        let (sender, mut receiver) = tokio::sync::mpsc::channel(4);
        bus.subscribe(
            "chat/tool_output".to_string(),
            Arc::new(move |event| {
                let sender = sender.clone();
                Box::pin(async move { sender.send(event).await.map_err(|error| error.into()) })
            }),
        );
        let (background_scheduler, _database) =
            start_test_background_scheduler(Arc::clone(&bus)).await;
        let check_tool = CheckTaskAfterTool::new(background_scheduler, 10);

        for _ in 0..2 {
            let result: serde_json::Value = serde_json::from_str(
                &check_tool
                    .execute(
                        &serde_json::json!({
                            "task_id": task_id,
                            "check_after_secs": 1
                        })
                        .to_string(),
                    )
                    .await
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(result["waiting"], true);
            assert_eq!(result["check_after_secs"], 1);

            let event = tokio::time::timeout(tokio::time::Duration::from_secs(2), receiver.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(event.payload["event"], "background_task_check_due");
            assert_eq!(event.payload["check_after_secs"], 1);
            assert!(event.payload["text"]
                .as_str()
                .unwrap()
                .contains("kill_task"));
            assert!(get_tasks_map()
                .get(&task_id)
                .is_some_and(|task| task.status == BackgroundTaskStatus::Running));
        }

        get_tasks_map().remove(&task_id);
    }

    #[tokio::test]
    async fn persisted_background_wake_orphan_is_absorbed_after_runtime_restart() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(database.path().to_string_lossy().as_ref())
                .await
                .unwrap(),
        );
        let task_id = format!(
            "background-orphan-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        );
        let timer_id = background_wake_timer_id(&task_id);
        store
            .upsert_runtime_timer(NewRuntimeTimer {
                id: timer_id.clone(),
                generation: 1,
                kind: RuntimeTimerKind::BackgroundWake,
                owner_id: task_id.clone(),
                due_at: chrono::Utc::now(),
                payload: serde_json::json!({
                    "task_id": task_id,
                    "generation": 1,
                    "wait_secs": 1,
                    "wake_source": "restart_fixture",
                }),
            })
            .await
            .unwrap();
        let persisted = store.get_runtime_timer(&timer_id).await.unwrap().unwrap();
        assert_eq!(persisted.kind, RuntimeTimerKind::BackgroundWake);
        assert_eq!(persisted.generation, 1);
        assert_eq!(persisted.payload["generation"], 1);
        assert_eq!(persisted.status, crate::memory::RuntimeTimerStatus::Pending);

        // ExecutionJob is not durable in this phase. A real process restart
        // therefore loses the live process owner; its persisted checkpoint
        // must be consumed without inventing a task result.
        let recovered_bus = Arc::new(InMemoryEventBus::new());
        let (sender, mut receiver) = tokio::sync::mpsc::channel(2);
        recovered_bus.subscribe(
            "chat/tool_output".to_string(),
            Arc::new(move |event| {
                let sender = sender.clone();
                Box::pin(async move { sender.send(event).await.map_err(|error| error.into()) })
            }),
        );
        let recovered_timers =
            Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>));
        let recovered_scheduler = Arc::new(BackgroundTaskScheduler::new(
            recovered_bus,
            Arc::clone(&store) as Arc<dyn EventStore>,
            Arc::clone(&recovered_timers),
        ));
        recovered_scheduler.register_timer_handler().unwrap();
        recovered_timers.start();
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if store
                    .get_runtime_timer(&timer_id)
                    .await
                    .unwrap()
                    .is_some_and(|timer| timer.status == crate::memory::RuntimeTimerStatus::Fired)
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), receiver.recv())
                .await
                .is_err(),
            "丢失物理进程所有权后不得伪造 background wake observation"
        );
    }

    #[tokio::test]
    async fn test_kill_task_pgid_cleanup() {
        let bus = Arc::new(crate::event::InMemoryEventBus::new());
        let exec_tool = exec_tool_for_tests(Arc::clone(&bus));
        let kill_tool = KillTaskTool::without_scheduler();

        let exec_args = serde_json::json!({
            "command": "sleep 100",
            "wait_ms": 1000
        });

        let res = exec_tool.execute(&exec_args.to_string()).await.unwrap();
        let result: serde_json::Value = serde_json::from_str(&res).unwrap();
        let task_id = result["task_id"].as_str().unwrap();

        let tasks = get_tasks_map();
        assert!(tasks.contains_key(task_id));

        let status: serde_json::Value = serde_json::from_str(
            &TaskStatusTool::without_scheduler()
                .execute(&serde_json::json!({ "task_id": task_id }).to_string())
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(status["task"]["status"], "running");
        assert_eq!(
            status["task"]["effective_boundary"]["network_enabled"],
            true
        );

        let listed: serde_json::Value = serde_json::from_str(
            &ListTasksTool::without_scheduler()
                .execute(&serde_json::json!({}).to_string())
                .await
                .unwrap(),
        )
        .unwrap();
        assert!(listed["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|task| task["task_id"] == task_id));

        let (background_scheduler, _database) =
            start_test_background_scheduler(Arc::clone(&bus)).await;
        let check_tool = CheckTaskAfterTool::new(background_scheduler, 300);
        let waiting: serde_json::Value = serde_json::from_str(
            &check_tool
                .execute(
                    &serde_json::json!({ "task_id": task_id, "check_after_secs": 30 }).to_string(),
                )
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(waiting["waiting"], true);
        assert_eq!(waiting["check_after_secs"], 30);
        assert!(waiting["check_at"].is_string());
        assert!(waiting["next_action"].as_str().unwrap().contains("reply"));

        let kill_args = serde_json::json!({
            "task_id": task_id
        });
        let kill_res = kill_tool.execute(&kill_args.to_string()).await.unwrap();
        let kill_result: serde_json::Value = serde_json::from_str(&kill_res).unwrap();
        assert_eq!(kill_result["killed"], true);
        for _ in 0..50 {
            if tasks
                .get(task_id)
                .is_some_and(|task| task.status == BackgroundTaskStatus::Killed)
            {
                break;
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
        }
        assert!(tasks
            .get(task_id)
            .is_some_and(|task| task.status == BackgroundTaskStatus::Killed));
        tasks.remove(task_id);
    }

    #[test]
    fn test_execution_buffer_keeps_bounded_utf8_tail() {
        let archive_file = NamedTempFile::new().unwrap();
        let archive_path = archive_file.path().to_string_lossy().to_string();
        let buffer = Arc::new(ExecutionBuffer {
            output: std::sync::Mutex::new(String::new()),
            archive: std::sync::Mutex::new(std::fs::File::create(&archive_path).unwrap()),
            event_pending: std::sync::Mutex::new(String::new()),
            archive_path: archive_path.clone(),
            truncated: AtomicBool::new(false),
            event_flush_scheduled: AtomicBool::new(false),
            max_bytes: 5,
            event_coalesce_ms: 10,
            max_event_chars: 128,
            injected_secret_values: Vec::new(),
            task_id: "buffer_test".to_string(),
            bus: Arc::new(crate::event::InMemoryEventBus::new()),
            session_id: "session_test".to_string(),
            context_id: "context_test".to_string(),
            initiating_principal_id: None,
            causal_route: None,
        });

        buffer.append("你好world", false);
        let output = buffer.get_all();
        assert!(output.contains("完整原始输出"));
        assert!(output.ends_with("world"));
        assert_eq!(std::fs::read_to_string(archive_path).unwrap(), "你好world");
    }

    #[tokio::test]
    async fn execution_buffer_coalesces_bursty_output_events_without_losing_archive() {
        let archive_file = NamedTempFile::new().unwrap();
        let archive_path = archive_file.path().to_string_lossy().to_string();
        let bus = Arc::new(crate::event::InMemoryEventBus::new());
        let (sender, mut receiver) = tokio::sync::mpsc::channel(4);
        bus.subscribe(
            "task/output/buffer_coalesce".to_string(),
            Arc::new(move |event| {
                let sender = sender.clone();
                Box::pin(async move { sender.send(event).await.map_err(|error| error.into()) })
            }),
        );
        let buffer = Arc::new(ExecutionBuffer {
            output: std::sync::Mutex::new(String::new()),
            archive: std::sync::Mutex::new(std::fs::File::create(&archive_path).unwrap()),
            event_pending: std::sync::Mutex::new(String::new()),
            archive_path: archive_path.clone(),
            truncated: AtomicBool::new(false),
            event_flush_scheduled: AtomicBool::new(false),
            max_bytes: 1024,
            event_coalesce_ms: 20,
            max_event_chars: 128,
            injected_secret_values: Vec::new(),
            task_id: "buffer_coalesce".to_string(),
            bus,
            session_id: "session_test".to_string(),
            context_id: "context_test".to_string(),
            initiating_principal_id: None,
            causal_route: None,
        });

        buffer.append("first\n", true);
        buffer.append("second\n", true);
        let event = tokio::time::timeout(tokio::time::Duration::from_secs(1), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.payload["coalesced_chars"], 13);
        assert_eq!(event.payload["text"], "first\nsecond\n");
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
        assert!(receiver.try_recv().is_err());
        assert_eq!(
            std::fs::read_to_string(archive_path).unwrap(),
            "first\nsecond\n"
        );
    }
}
