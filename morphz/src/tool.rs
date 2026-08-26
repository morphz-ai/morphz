use crate::approval::{ApprovalAction, ApprovalProvider, CapabilityDelta, DenyAllApprovalProvider};
use crate::config::BackgroundTaskConfig;
use crate::event::{
    Event, InMemoryEventBus, TYPE_AGENT_CALL, TYPE_FILE_CHANGE, TYPE_SESSION_SIGNAL,
    TYPE_TOOL_OUTPUT,
};
use crate::execution::{
    deterministic_job_id, ExecutionJobManager, ExecutionJobSpec, JobClaim, JobHeartbeat,
    JobOutcome, JobReceipt,
};
use crate::llm::{ModelAttachment, ToolDefinition};
use crate::memory::{
    stable_thread_id, EdgeOutputStream, EventStore, ExecutionJobFilter, ExecutionJobRecord,
    ExecutionJobStatus, ExecutionJobStore, ExecutionRetrySafety, NewObjective, NewRuntimeTimer,
    NewSchedule, NewScheduledObjective, NewThread, NewThreadGroup, NewThreadGroupMember,
    NewThreadGroupPlan, ObjectiveStatus, ObjectiveStore, ObjectiveWaitCondition, QueryFilter,
    RuntimeTimerKind, RuntimeTimerRecord, ScheduleMutation, ScheduleRecord, ScheduleStatus,
    ScheduledObjectiveWaitBinding, SessionSignalClaim, SessionStatus, SessionStore,
    ThreadGroupPolicy, ThreadKind, ThreadLifecycle, ThreadLifetime, ThreadPromotionMutation,
    ThreadPromotionRequest, ThreadRecord, ThreadSupervision, ThreadSupervisorKind,
};
use crate::objective::TYPE_OBJECTIVE_CONTROL;
use crate::orchestrator::context::ContextEngine;
use crate::permission::{
    ApprovalContext, ApprovalRequirement, FilesystemAccess, PermissionBroker, PermissionConfig,
    PermissionProfile, SandboxMode, ShellEnvironmentPolicy,
};
use crate::sandbox::{
    EnforcementStatus, NativeSandbox, NetworkPolicy, SandboxPolicy, ShellRequest,
};
use crate::scheduler::{
    KernelCommand, KernelCommandHeader, KernelCommandPayload, KernelResult, PromoteThreadCommand,
    SchedulerKernel, SpawnSupervisedGroupCommand,
};
use crate::timer::{TimerDisposition, TimerEngine};
use base64::Engine as _;
use dashmap::DashMap;
use glob::Pattern;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::fs::{OpenOptions, Permissions};
use std::future::Future;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, RwLock};
use tokio::io::{AsyncBufReadExt, BufReader};
use walkdir::WalkDir;

const MAX_SCHEDULE_OPERATIONS: usize = 32;
const MAX_SCHEDULE_INTENT_CHARS: usize = 1_000_000;
const BACKGROUND_TERMINAL_COMMIT_RETRY_INITIAL: std::time::Duration =
    std::time::Duration::from_millis(100);
const BACKGROUND_TERMINAL_COMMIT_RETRY_MAX: std::time::Duration = std::time::Duration::from_secs(5);

/// A physical process exit is an irreversible fact. Once the watcher has
/// observed it, losing one Store transaction must not strand the durable Job
/// in `running`/`kill_requested`. Keep the observation alive and retry the
/// atomic Job + Event + Thread Signal commit until it is durable.
async fn retry_background_terminal_commit<F, Fut>(
    task_id: &str,
    initial_delay: std::time::Duration,
    mut commit: F,
) -> bool
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<bool, Box<dyn std::error::Error + Send + Sync>>>,
{
    let mut failures = 0u64;
    let mut delay = initial_delay.max(std::time::Duration::from_millis(1));
    loop {
        match commit().await {
            Ok(committed) => return committed,
            Err(error) => {
                failures = failures.saturating_add(1);
                tracing::warn!(
                    task_id,
                    failures,
                    retry_delay_ms = delay.as_millis(),
                    %error,
                    event_code = "tool.background_job.terminal_commit_retry",
                    "Retrying the durable terminal commit for an observed background-process exit"
                );
                tokio::time::sleep(delay).await;
                delay = delay
                    .saturating_mul(2)
                    .min(BACKGROUND_TERMINAL_COMMIT_RETRY_MAX);
            }
        }
    }
}

fn should_renew_background_execution(
    status: ExecutionJobStatus,
    claim_matches: bool,
    cancellation_requested: bool,
) -> bool {
    status == ExecutionJobStatus::Running && claim_matches && !cancellation_requested
}

fn executable_secret_aliases(
    runtime_managed_ssh: bool,
    approved_secret_env: &[String],
) -> Vec<String> {
    if runtime_managed_ssh {
        approved_secret_env
            .iter()
            .filter(|name| name.as_str() == "SSH_AUTH_SOCK")
            .cloned()
            .collect()
    } else {
        approved_secret_env.to_vec()
    }
}

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

/// Typed, heap-allocated result produced by one tool execution.
///
/// `text` is the durable, recallable observation. `model_attachments` are an
/// ephemeral transport payload: the Orchestrator imports them into its
/// content-addressed model-input store before the result Event is committed,
/// then only stable references remain in persisted Events. This keeps binary data
/// out of Context while allowing the next model Attempt to receive native
/// multimodal content. Keeping this result behind a `Box` also prevents rich
/// tool payload support from enlarging every nested Runtime future.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolExecutionResult {
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub model_attachments: Vec<ModelAttachment>,
}

impl ToolExecutionResult {
    const TRANSPORT_VERSION: u64 = 1;

    pub fn text(text: impl Into<String>) -> Box<Self> {
        Box::new(Self {
            text: text.into(),
            model_attachments: Vec::new(),
        })
    }

    pub fn with_attachments(
        text: impl Into<String>,
        model_attachments: Vec<ModelAttachment>,
    ) -> Box<Self> {
        Box::new(Self {
            text: text.into(),
            model_attachments,
        })
    }

    /// Versioned wire representation used only by string-only Edge/SSH
    /// transports. Plain text remains plain text for backward compatibility.
    pub fn encode_transport(&self) -> Result<String, serde_json::Error> {
        if self.model_attachments.is_empty() {
            return Ok(self.text.clone());
        }
        serde_json::to_string(&serde_json::json!({
            "_morphz_tool_result": {
                "version": Self::TRANSPORT_VERSION,
                "text": self.text,
                "model_attachments": self.model_attachments,
            }
        }))
    }

    pub fn decode_transport(value: String) -> Box<Self> {
        let Some(envelope) = serde_json::from_str::<serde_json::Value>(&value)
            .ok()
            .and_then(|value| value.get("_morphz_tool_result").cloned())
        else {
            return Self::text(value);
        };
        if envelope.get("version").and_then(serde_json::Value::as_u64)
            != Some(Self::TRANSPORT_VERSION)
        {
            return Self::text(value);
        }
        let Some(text) = envelope.get("text").and_then(serde_json::Value::as_str) else {
            return Self::text(value);
        };
        let Some(model_attachments) = envelope
            .get("model_attachments")
            .cloned()
            .and_then(|attachments| serde_json::from_value(attachments).ok())
        else {
            return Self::text(value);
        };
        Self::with_attachments(text, model_attachments)
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum PrincipalArgs {
    VerifyIdentity { claimed_principal_id: String },
    ListSessions,
    VerifySession { session_id: String },
}

impl PrincipalArgs {
    fn action(&self) -> &'static str {
        match self {
            Self::VerifyIdentity { .. } => "verify_identity",
            Self::ListSessions => "list_sessions",
            Self::VerifySession { .. } => "verify_session",
        }
    }
}

pub struct PrincipalTool {
    sessions: Arc<dyn SessionStore>,
}

impl PrincipalTool {
    pub fn new(sessions: Arc<dyn SessionStore>) -> Self {
        Self { sessions }
    }

    async fn active_route(
        &self,
    ) -> Result<
        Option<(String, crate::memory::SessionRecord)>,
        Box<dyn std::error::Error + Send + Sync>,
    > {
        let session_id = CURRENT_SESSION_ID
            .try_with(Clone::clone)
            .map_err(|_| "principal requires an active Session route")?;
        let principal_id = CURRENT_PRINCIPAL_ID.try_with(Clone::clone).ok().flatten();
        let Some(principal_id) = principal_id else {
            return Ok(None);
        };
        let Some(session) = self.sessions.get_session(&session_id).await? else {
            return Err(format!("active Session '{session_id}' does not exist").into());
        };
        if !self
            .sessions
            .verify_session_principal(&session_id, &principal_id)
            .await?
        {
            return Ok(None);
        }
        Ok(Some((principal_id, session)))
    }
}

#[async_trait::async_trait]
impl Tool for PrincipalTool {
    fn name(&self) -> &str {
        "principal"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().to_string(),
            description: "Inspect Runtime-authoritative identity boundaries for the current Activation. The Runtime supplies the active Principal; the model cannot select or impersonate it. verify_identity checks a natural-language identity claim, list_sessions returns active Session IDs owned by this Principal within the current Agent, and verify_session checks whether one Session belongs to this Principal without disclosing foreign Session metadata. Identity facts do not decide disclosure.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["verify_identity", "list_sessions", "verify_session"],
                        "description": "Operation to perform"
                    },
                    "claimed_principal_id": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Required only for verify_identity. Stable Principal ID to verify, not a display name or Session ID"
                    },
                    "session_id": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Required only for verify_session. Session ID whose ownership should be checked"
                    }
                },
                "required": ["action"],
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
        let args: PrincipalArgs = serde_json::from_str(arguments)?;
        let action = args.action();
        let Some((active_principal_id, active_session)) = self.active_route().await? else {
            return Ok(serde_json::json!({
                "action": action,
                "available": false,
                "reason": "no_active_principal",
                "authority": "runtime"
            })
            .to_string());
        };
        let result = match args {
            PrincipalArgs::VerifyIdentity {
                claimed_principal_id,
            } => {
                let claimed = claimed_principal_id.trim();
                if claimed.is_empty() {
                    return Err("claimed_principal_id must not be empty".into());
                }
                serde_json::json!({
                    "action": "verify_identity",
                    "verified": claimed == active_principal_id,
                    "claimed_principal_id": claimed,
                    "active_principal_id": active_principal_id,
                    "session_binding_valid": true,
                    "authority": "runtime"
                })
            }
            PrincipalArgs::ListSessions => {
                let session_ids = self
                    .sessions
                    .list_principal_sessions(&active_principal_id, false)
                    .await?
                    .into_iter()
                    .filter(|candidate| candidate.agent_id == active_session.agent_id)
                    .map(|candidate| candidate.id)
                    .collect::<Vec<_>>();
                serde_json::json!({
                    "action": "list_sessions",
                    "principal_id": active_principal_id,
                    "agent_id": active_session.agent_id,
                    "session_ids": session_ids,
                    "authority": "runtime"
                })
            }
            PrincipalArgs::VerifySession {
                session_id: candidate_id,
            } => {
                let candidate_id = candidate_id.trim();
                if candidate_id.is_empty() {
                    return Err("session_id must not be empty".into());
                }
                let belongs = match self.sessions.get_session(candidate_id).await? {
                    Some(candidate) if candidate.agent_id == active_session.agent_id => {
                        self.sessions
                            .verify_session_principal(candidate_id, &active_principal_id)
                            .await?
                    }
                    _ => false,
                };
                serde_json::json!({
                    "action": "verify_session",
                    "session_id": candidate_id,
                    "belongs": belongs,
                    "principal_id": active_principal_id,
                    "authority": "runtime"
                })
            }
        };
        Ok(result.to_string())
    }
}

#[derive(Debug, Clone)]
pub struct ToolCausalRoute {
    pub thread_id: String,
    pub activation_id: String,
    /// Physical Provider request that selected this tool call. This remains
    /// distinct from `activation_id`, which owns persistence and recovery.
    pub model_attempt_id: Option<String>,
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
        .unwrap_or_else(|error| panic!("invalid PermissionConfig: {error}"));
    Arc::new(PermissionBroker::new(
        Arc::new(profile),
        Arc::new(DenyAllApprovalProvider::new(
            "the current tool has no out-of-bound permission approval provider",
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
    /// Decoded single-artifact ceiling for tools that can return model-visible
    /// binary input. Execution backends use this to preserve the same policy
    /// on local, Managed SSH and Edge targets.
    fn max_model_input_attachment_bytes(&self) -> Option<usize> {
        None
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

    /// Rich execution path used by Runtime-owned dispatch. Existing tools
    /// remain text-only by default; multimodal tools override this method
    /// without forcing every implementation to manufacture an envelope.
    async fn execute_result(
        &self,
        arguments: &str,
    ) -> Result<Box<ToolExecutionResult>, Box<dyn std::error::Error + Send + Sync>> {
        self.execute(arguments).await.map(ToolExecutionResult::text)
    }
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
                                "description": "Optional Execution Target ID. Omitting it on the first action of an unbound Thread binds target-default; an already bound Thread inherits its Target. An explicit conflicting value is rejected. Use schedule_tx.spawn for work on another Target."
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
            description: "Proactively send a message to another Session of the same Agent. This is not a reply to the active Session, does not end the current Evaluation, and does not trigger evaluation in the target Session. Reply to the active Session with ordinary assistant text.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "description": "Target Session ID; it must belong to the current Agent and cannot be the active Session"
                    },
                    "content": {
                        "type": "string",
                        "description": "Non-empty message to send to the target Session"
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
            .map_err(|_| "send_message is missing the current Session route")?;
        let source_context_id = CURRENT_CONTEXT_ID
            .try_with(Clone::clone)
            .map_err(|_| "send_message is missing the current Context route")?;
        let attempt_id = CURRENT_ATTEMPT_ID
            .try_with(Clone::clone)
            .map_err(|_| "send_message is missing the current Evaluation route")?;
        let target_session_id = args.session_id.trim();
        if target_session_id.is_empty() {
            return Err("send_message.session_id must not be empty".into());
        }
        if target_session_id == source_session_id {
            return Err(
                "send_message cannot reply to the current active Session; return ordinary assistant text instead".into(),
            );
        }
        if args.content.trim().is_empty() {
            return Err("send_message.content must not be empty".into());
        }
        if args.content.chars().count() > 1_000_000 {
            return Err("send_message.content exceeds 1,000,000 characters".into());
        }
        let source = self
            .sessions
            .get_session(&source_session_id)
            .await?
            .ok_or("Current Session does not exist")?;
        let target = self
            .sessions
            .get_session(target_session_id)
            .await?
            .ok_or_else(|| format!("Target Session '{target_session_id}' does not exist"))?;
        if source.agent_id != target.agent_id {
            return Err(
                "send_message can deliver only to a Session owned by the same Agent".into(),
            );
        }
        if target.status == SessionStatus::Archived {
            return Err("Target Session is archived and cannot receive new messages".into());
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
            "guidance": "The message was delivered to the target Session; the current Evaluation has not ended. If the current active Session needs a reply, eventually return ordinary assistant text."
        })
        .to_string())
    }
}

/// Durable, symmetric Session-to-Session coordination. Unlike
/// `send_message`, this tool does not emit an Assistant message into the
/// target dialogue. It commits a distinct internal Event and wakes a fresh
/// DialogueTurn owned by the target Session.
pub struct SessionSignalTool {
    bus: Arc<InMemoryEventBus>,
    events: Arc<dyn EventStore>,
    sessions: Arc<dyn SessionStore>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionSignalArgs {
    session_id: String,
    content: String,
}

impl SessionSignalTool {
    pub fn new(
        bus: Arc<InMemoryEventBus>,
        events: Arc<dyn EventStore>,
        sessions: Arc<dyn SessionStore>,
    ) -> Self {
        Self {
            bus,
            events,
            sessions,
        }
    }
}

#[async_trait::async_trait]
impl Tool for SessionSignalTool {
    fn name(&self) -> &str {
        "session_signal"
    }

    fn execution_class(&self) -> ToolExecutionClass {
        ToolExecutionClass::LogicalInline
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().to_string(),
            description: "Send an internal coordination message to another Session of the same Agent and actively evaluate it there. The target receives a distinct internal message, not a User or Assistant message. This call does not end the current Evaluation; the target may respond with the same tool.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "description": "Target Session ID owned by the current Agent; it cannot be the active Session"
                    },
                    "content": {
                        "type": "string",
                        "description": "Non-empty coordination message for the target Session"
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
        let args: SessionSignalArgs = serde_json::from_str(arguments)?;
        let source_session_id = CURRENT_SESSION_ID
            .try_with(Clone::clone)
            .map_err(|_| "session_signal is missing the current Session route")?;
        let source_context_id = CURRENT_CONTEXT_ID
            .try_with(Clone::clone)
            .map_err(|_| "session_signal is missing the current Context route")?;
        let source_attempt_id = CURRENT_ATTEMPT_ID
            .try_with(Clone::clone)
            .map_err(|_| "session_signal is missing the current Evaluation route")?;
        let causal_route = CURRENT_CAUSAL_ROUTE
            .try_with(Clone::clone)
            .map_err(|_| "session_signal is missing the current Activation causal route")?
            .ok_or("session_signal can execute only within a persisted Activation")?;
        let target_session_id = args.session_id.trim();
        let content = args.content.trim();
        if target_session_id.is_empty() {
            return Err("session_signal.session_id must not be empty".into());
        }
        if target_session_id == source_session_id {
            return Err("session_signal can deliver only to another Session".into());
        }
        if content.is_empty() {
            return Err("session_signal.content must not be empty".into());
        }
        if content.chars().count() > 1_000_000 {
            return Err("session_signal.content exceeds 1,000,000 characters".into());
        }

        let source = self
            .sessions
            .get_session(&source_session_id)
            .await?
            .ok_or("Current Session does not exist")?;
        if source.context_id != source_context_id {
            return Err("Current Session and Context have inconsistent causal routes".into());
        }
        let target = self
            .sessions
            .get_session(target_session_id)
            .await?
            .ok_or_else(|| format!("Target Session '{target_session_id}' does not exist"))?;
        if source.agent_id != target.agent_id {
            return Err("session_signal does not currently allow cross-Agent delivery".into());
        }
        if target.status == SessionStatus::Archived {
            return Err(
                "Target Session is archived and cannot receive internal coordination messages"
                    .into(),
            );
        }

        let digest = sha256_hex(
            format!(
                "{}\0{}\0{}\0{}",
                source_attempt_id, causal_route.activation_id, target_session_id, content
            )
            .as_bytes(),
        );
        let event_id = format!("session_signal_{}_{}", source_attempt_id, &digest[..16]);
        let root_event = self
            .events
            .query(QueryFilter {
                event_id: Some(causal_route.root_turn_id.clone()),
                context_id: Some(source_context_id.clone()),
                session_id: Some(source_session_id.clone()),
                ..QueryFilter::default()
            })
            .await?
            .into_iter()
            .find(|event| event.id == causal_route.root_turn_id);
        let reply_to_event_id = root_event
            .as_ref()
            .filter(|event| event.topic == "chat/session_signal")
            .map(|event| event.id.clone());
        let correlation_id = root_event
            .as_ref()
            .filter(|event| event.topic == "chat/session_signal")
            .and_then(|event| event.payload.get("correlation_id"))
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| event_id.clone());
        let initiating_principal_id = CURRENT_PRINCIPAL_ID.try_with(Clone::clone).ok().flatten();
        let mut payload = serde_json::Map::from_iter([
            ("agent_id".to_string(), serde_json::json!(&target.agent_id)),
            (
                "context_id".to_string(),
                serde_json::json!(&target.context_id),
            ),
            ("session_id".to_string(), serde_json::json!(&target.id)),
            (
                "source_context_id".to_string(),
                serde_json::json!(&source_context_id),
            ),
            (
                "source_session_id".to_string(),
                serde_json::json!(&source_session_id),
            ),
            (
                "source_thread_id".to_string(),
                serde_json::json!(&causal_route.thread_id),
            ),
            (
                "source_activation_id".to_string(),
                serde_json::json!(&causal_route.activation_id),
            ),
            (
                "source_attempt_id".to_string(),
                serde_json::json!(&source_attempt_id),
            ),
            (
                "source_root_turn_id".to_string(),
                serde_json::json!(&causal_route.root_turn_id),
            ),
            (
                "source_trigger_event_id".to_string(),
                serde_json::json!(&causal_route.trigger_event_id),
            ),
            (
                "correlation_id".to_string(),
                serde_json::json!(&correlation_id),
            ),
            ("dedupe_id".to_string(), serde_json::json!(&event_id)),
            ("text".to_string(), serde_json::json!(content)),
            (
                "cross_context".to_string(),
                serde_json::json!(source_context_id != target.context_id),
            ),
        ]);
        if let Some(reply_to_event_id) = &reply_to_event_id {
            payload.insert(
                "reply_to_event_id".to_string(),
                serde_json::json!(reply_to_event_id),
            );
        }
        if let Some(principal_id) = &initiating_principal_id {
            payload.insert("principal_id".to_string(), serde_json::json!(principal_id));
        }
        let event = Event::new(
            event_id.clone(),
            "Agent-SessionSignal".to_string(),
            TYPE_SESSION_SIGNAL.to_string(),
            "chat/session_signal".to_string(),
            payload,
        );
        match self.sessions.claim_session_signal(&event).await? {
            SessionSignalClaim::Accepted { event } => {
                self.bus.dispatch_persisted(event).await?;
                Ok(serde_json::json!({
                    "status": "signalled",
                    "session_id": target_session_id,
                    "event_id": event_id,
                    "correlation_id": correlation_id,
                    "duplicate": false,
                    "guidance": "The target Session has an independent internal DialogueTurn. Continue the current Evaluation normally; use session_signal again only when further coordination is needed."
                })
                .to_string())
            }
            SessionSignalClaim::Existing { event_id } => Ok(serde_json::json!({
                "status": "signalled",
                "session_id": target_session_id,
                "event_id": event_id,
                "correlation_id": correlation_id,
                "duplicate": true,
                "guidance": "This logical Signal was already committed; no duplicate target Activation was created."
            })
            .to_string()),
            SessionSignalClaim::InactiveSession => {
                Err("Target Session is archived and cannot receive internal coordination messages".into())
            }
            SessionSignalClaim::ForbiddenPrincipal { principal_id } => Err(format!(
                "Principal '{principal_id}' may not deliver an internal coordination message to target Session '{target_session_id}'"
            )
            .into()),
        }
    }
}

/// Durable control plane for long-running Shell processes. ExecutionJob owns
/// lifecycle truth; the process-local map only retains the live PGID and output
/// cache required to interact with a process owned by this Runtime instance.
fn new_background_claimant_id() -> String {
    static NEXT_INSTANCE: AtomicU64 = AtomicU64::new(0);
    let instance = NEXT_INSTANCE.fetch_add(1, Ordering::Relaxed);
    let mut random = [0_u8; 16];
    let nonce = if getrandom::fill(&mut random).is_ok() {
        random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    } else {
        chrono::Utc::now()
            .timestamp_nanos_opt()
            .unwrap_or_default()
            .to_string()
    };
    format!(
        "background-runtime:{}:{nonce}:{instance}",
        std::process::id()
    )
}

pub struct BackgroundTaskScheduler {
    bus: Arc<InMemoryEventBus>,
    events: Arc<dyn EventStore>,
    timers: Arc<TimerEngine>,
    claimant_id: String,
    execution_jobs: Option<Arc<ExecutionJobManager<dyn ExecutionJobStore>>>,
    sessions: Option<Arc<dyn SessionStore>>,
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
            claimant_id: new_background_claimant_id(),
            execution_jobs: None,
            sessions: None,
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
            claimant_id: new_background_claimant_id(),
            execution_jobs: Some(execution_jobs),
            sessions: None,
        }
    }

    pub fn with_session_store(mut self, sessions: Arc<dyn SessionStore>) -> Self {
        self.sessions = Some(sessions);
        self
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
            return Err("Background-task Scheduler has no ExecutionJob Store configured".into());
        };
        let parent_job = manager
            .store()
            .get_execution_job(&parent.parent_job_id)
            .await?
            .ok_or_else(|| {
                format!(
                    "Parent ExecutionJob '{}' does not exist",
                    parent.parent_job_id
                )
            })?;
        if parent_job.status != ExecutionJobStatus::Running
            || parent_job.cancel_requested_at.is_some()
        {
            return Err(format!(
                "parent ExecutionJob '{}' is cancelled or no longer running; background child attachment rejected",
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
            return Err("Background-task Scheduler has no ExecutionJob Store configured".into());
        };
        self.ensure_parent_accepts_background_child(parent).await?;
        let (_, child_tool_call_id) = self.durable_task_identity(parent)?;
        let request = {
            let task = get_tasks_map().get(task_id).ok_or_else(|| {
                format!("Live handle for background process '{task_id}' does not exist")
            })?;
            serde_json::json!({
                "kind": "background_exec",
                "parent_job_id": parent.parent_job_id,
                "task_id": task.id,
                "command": task.cmd_str,
                "process_group_id": task.pgid,
                "started_at": task.started_at,
                "artifact_path": task.artifact_path,
                "keep_running": task.keep_running,
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
                "background task ID '{}' does not match derived ExecutionJob '{}'",
                task_id, job.id
            )
            .into());
        }
        if job.status != ExecutionJobStatus::Queued {
            return Err(format!(
                "background ExecutionJob '{}' is currently {} and cannot adopt a new process",
                job.id,
                job.status.as_str()
            )
            .into());
        }
        self.ensure_parent_accepts_background_child(parent).await?;
        let claim_token = format!(
            "background-claim-{}-{}-{}",
            job.id,
            self.claimant_id,
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        let lease_expires_at = chrono::Utc::now() + chrono::Duration::minutes(2);
        job = applied_background_job(
            manager
                .claim(
                    &job.id,
                    job.revision,
                    JobClaim {
                        worker_id: &self.claimant_id,
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
        let timers = Arc::clone(&self.timers);
        tokio::spawn(async move {
            let mut last_heartbeat_at = std::time::Instant::now();
            loop {
                // Cancellation can be requested by another Runtime process.
                // Poll the fenced Job cheaply while keeping lease writes at
                // their established 30-second cadence.
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                let Ok(Some(job)) = manager.store().get_execution_job(&job_id).await else {
                    break;
                };
                let owns_job = job.claim_token.as_deref() == Some(claim_token.as_str());
                let renewable = should_renew_background_execution(
                    job.status,
                    owns_job,
                    job.cancel_requested_at.is_some(),
                );
                if job.status.is_terminal() || !owns_job {
                    break;
                }
                if job.cancel_requested_at.is_some() {
                    if let Err(error) = timers.cancel(&background_wake_timer_id(&job_id)).await {
                        tracing::warn!(
                            execution_job_id = %job_id,
                            %error,
                            event_code = "tool.background_job.remote_cancel_timer_failed",
                            "Could not cancel a background checkpoint after observing a durable cancellation request"
                        );
                    }
                    match terminate_local_background_process(&job_id) {
                        Ok(Some((process_group_id, killed))) => tracing::info!(
                            execution_job_id = %job_id,
                            process_group_id,
                            killed,
                            event_code = "tool.background_job.remote_cancel_observed",
                            "The physical background owner observed a cross-Runtime cancellation request"
                        ),
                        Ok(None) => tracing::debug!(
                            execution_job_id = %job_id,
                            event_code = "tool.background_job.remote_cancel_owner_gone",
                            "The durable cancellation owner no longer has a live process handle"
                        ),
                        Err(error) => {
                            tracing::error!(
                                execution_job_id = %job_id,
                                %error,
                                event_code = "tool.background_job.remote_cancel_failed",
                                "The physical background owner could not terminate its process group; retrying"
                            );
                            continue;
                        }
                    }
                    break;
                }
                if !renewable {
                    break;
                }
                if last_heartbeat_at.elapsed() < std::time::Duration::from_secs(30) {
                    continue;
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
                    Ok(JobReceipt::Applied { .. }) | Ok(JobReceipt::Existing { .. }) => {
                        last_heartbeat_at = std::time::Instant::now();
                    }
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
                return Err(format!("Background ExecutionJob '{task_id}' does not exist").into());
            };
            if job.status.is_terminal() {
                self.maybe_escalate_terminal_background_result(&job).await?;
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
                "\n[background task {} finished, status: {}, exit code: {}]{}\n--- output ---\n{}",
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
                    error: format!("Background process exited with code {exit_code}"),
                    exit_code: Some(exit_code),
                }
            };
            // A detached service may legitimately outlive the Execution
            // Thread that launched it. Its physical terminal fact and result
            // Event must still commit, but a terminal (or deleted) owner can
            // no longer accept a Direct Signal. Re-evaluate on every retry so
            // a Thread racing to terminal state cannot permanently strand the
            // Job in running + cancel_requested. Supervisor-owned attached
            // children must not Session-escalate: that would steal the result
            // from their parent Thread supervisor.
            let owner = if let Some(sessions) = self.sessions.as_ref() {
                sessions.get_thread(&job.thread_id).await?
            } else {
                None
            };
            let route = if self.sessions.is_none() {
                WakeRoute::DirectThread {
                    thread_id: job.thread_id.clone(),
                }
            } else {
                resolve_wake_route(
                    BackgroundWakeKind::TerminalResult,
                    false,
                    &job.session_id,
                    owner.as_ref(),
                )
            };
            let wake_thread = matches!(route, WakeRoute::DirectThread { .. });
            match &route {
                WakeRoute::DirectThread { .. } => {}
                WakeRoute::SessionEscalation { .. } if owner.is_none() => {
                    tracing::warn!(
                        execution_job_id = %job.id,
                        thread_id = %job.thread_id,
                        event_code = "tool.background_result.owner_missing",
                        "Committing a background result without a Direct Signal because its Thread owner is missing"
                    );
                }
                WakeRoute::SessionEscalation { .. } => {}
                WakeRoute::Suppress { reason } => {
                    tracing::info!(
                        execution_job_id = %job.id,
                        thread_id = %job.thread_id,
                        ?reason,
                        event_code = "tool.background_result.supervisor_owned_suppressed",
                        "Persisting a background result without Session escalation because typed wake routing forbids upgrading a supervisor-owned child"
                    );
                }
            }
            match manager
                .finish_with_event(
                    &job.id,
                    job.revision,
                    job.claim_token.as_deref(),
                    outcome,
                    &event,
                    wake_thread,
                )
                .await?
            {
                JobReceipt::Applied { .. } | JobReceipt::Existing { .. } => {
                    // The in-memory task must remain non-terminal until its
                    // completion Event and exact Thread Signal are durable.
                    // Otherwise an Evaluation
                    // finishing concurrently can observe "0 active tasks",
                    // commit no_reply, and terminalize the Thread before this
                    // causal result reaches its mailbox.
                    mark_background_task_terminal(task_id, exit_code);
                    if wake_thread {
                        self.bus.dispatch_persisted(event).await?;
                    } else if matches!(route, WakeRoute::SessionEscalation { .. }) {
                        self.bus.dispatch_persisted(event.clone()).await?;
                        self.escalate_terminal_result_to_session(&job, &event)
                            .await?;
                    } else {
                        self.bus.dispatch_persisted(event).await?;
                    }
                    return Ok(true);
                }
                JobReceipt::Conflict { .. } => continue,
                JobReceipt::Rejected { reason, .. } => return Err(reason.into()),
                JobReceipt::NotFound { .. } => {
                    return Err(
                        format!("Background ExecutionJob '{task_id}' does not exist").into(),
                    );
                }
            }
        }
        Err(format!(
            "Background ExecutionJob '{task_id}' remained in revision contention during completion"
        )
        .into())
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
    /// terminal commit and its directed Thread Signal. Replaying this scan is
    /// safe because Event and Signal identities are deterministic and the
    /// transaction-local append is idempotent.
    pub async fn recover_terminal_background_outboxes(
        &self,
    ) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
        let Some(manager) = &self.execution_jobs else {
            return Ok(0);
        };
        let jobs = manager
            .store()
            .list_terminal_execution_jobs_needing_signal("exec/background")
            .await?;
        let mut armed = 0;
        for job in jobs {
            if let Some(sessions) = self.sessions.as_ref() {
                match sessions.get_thread(&job.thread_id).await? {
                    Some(thread) if !thread.lifecycle.is_terminal() => {}
                    Some(thread) => {
                        tracing::debug!(
                            execution_job_id = %job.id,
                            thread_id = %thread.id,
                            thread_lifecycle = thread.lifecycle.as_str(),
                            event_code = "tool.background_result.thread_terminal_escalation",
                            "Recovering a terminal background result by escalating to the owning Session"
                        );
                        self.maybe_escalate_terminal_background_result(&job).await?;
                        armed += 1;
                        continue;
                    }
                    None => {
                        tracing::warn!(
                            execution_job_id = %job.id,
                            thread_id = %job.thread_id,
                            event_code = "tool.background_result.owner_missing_escalation",
                            "Recovering a terminal background result whose Thread owner is missing by escalating to the owning Session"
                        );
                        self.maybe_escalate_terminal_background_result(&job).await?;
                        armed += 1;
                        continue;
                    }
                }
            }
            let event_id = job.result_event_id.as_deref().ok_or_else(|| {
                format!(
                    "Background ExecutionJob '{}' is lost but has no result Event",
                    job.id
                )
            })?;
            let mut events = self
                .events
                .query(QueryFilter {
                    event_id: Some(event_id.to_string()),
                    ..Default::default()
                })
                .await?;
            if events.len() != 1 {
                return Err(format!(
                    "background ExecutionJob '{}' has an invalid number of lost-result Events '{}': {}",
                    job.id,
                    event_id,
                    events.len()
                )
                .into());
            }
            self.events
                .append_to_thread(events.remove(0), &job.thread_id)
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
            return Err(format!(
                "Background task '{task_id}' does not belong to the current Context"
            )
            .into());
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
                tool_name: Some("exec/background".to_string()),
                include_terminal: include_finished,
                ..Default::default()
            })
            .await?;
        let mut snapshots = jobs
            .into_iter()
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
            return Err("Background-task Scheduler has no ExecutionJob Store configured".into());
        };
        let mut job = self
            .get_background_job(task_id)
            .await?
            .ok_or_else(|| format!("Background task '{task_id}' was not found"))?;
        if !context_id.is_empty() && job.context_id != context_id {
            return Err(format!(
                "Background task '{task_id}' does not belong to the current Context"
            )
            .into());
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
                        "background ExecutionJob '{}' cancellation request was rejected: {}",
                        current.id, reason
                    )
                    .into());
                }
                JobReceipt::NotFound { .. } => {
                    return Err(
                        format!("Background ExecutionJob '{task_id}' does not exist").into(),
                    );
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
        let Some((task_pgid, killed)) = terminate_local_background_process(task_id)? else {
            return Ok(serde_json::json!({
                "kind": "background_task_kill",
                "task_id": task_id,
                "execution_job_id": job.id,
                "status": "cancel_requested",
                "killed": false,
                "owner_local": false,
                "reason": "owned_by_another_runtime",
                "guidance": "Cancellation intent is durable. The Runtime instance holding the physical process polls this fenced Job and will terminate the process group; observe the terminal ExecutionJob result instead of retrying kill_task."
            }));
        };
        self.cancel(task_id).await;
        if killed {
            Ok(serde_json::json!({
                "kind": "background_task_kill",
                "task_id": task_id,
                "execution_job_id": job.id,
                "status": "cancel_requested",
                "process_group_id": task_pgid,
                "killed": true,
                "owner_local": true,
                "guidance": "Cancellation intent is durable. The ExecutionJob reaches terminal cancelled only after the observed process exit is committed."
            }))
        } else {
            Ok(serde_json::json!({
                "kind": "background_task_kill",
                "task_id": task_id,
                "execution_job_id": job.id,
                "status": "cancel_requested",
                "process_group_id": task_pgid,
                "killed": false,
                "owner_local": true,
                "reason": "process_group_not_found",
                "guidance": "Cancellation intent is durable. Wait for the process watcher to commit the real terminal state; the Runtime does not guess cancelled from ESRCH."
            }))
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
                        "failed to terminate process group {} for Activation '{}': {}; cancellation intent remains persisted",
                        pgid, activation_id, error
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
                "check_after_secs must be between 1 and {MAX_TASK_WAIT_SECS} seconds"
            ));
        }
        if let Some(manager) = self.execution_jobs.as_ref() {
            // Durable path: the semantic checkpoint (generation + due_at) and
            // the physical BackgroundWake timer are committed in one Store
            // transaction, so a peer Runtime claiming the timer sees the same
            // authoritative state. The local task map is refreshed only after
            // the commit and remains a same-process convenience hint.
            match get_tasks_map().get(task_id) {
                Some(task) if task.status.is_terminal() => {
                    return Err(format!(
                        "Background task '{task_id}' has already ended; no further wait is needed"
                    ));
                }
                Some(_) => {}
                None => {
                    return Err(format!(
                        "background task '{task_id}' was not found; it may have been removed by the history retention policy"
                    ));
                }
            }
            let registration = manager
                .store()
                .register_background_checkpoint(task_id, check_after_secs, wake_source)
                .await
                .map_err(|error| {
                    format!("Failed to persist background-task checkpoint: {error}")
                })?;
            if let Some(mut task) = get_tasks_map().get_mut(task_id) {
                task.wake_generation = registration.checkpoint_generation;
                task.next_wakeup_at = Some(registration.due_at);
            }
            // The composite transaction wrote the Timer row directly, so the
            // dispatcher never observed it through TimerEngine::schedule.
            self.timers.notify_schedule_changed();
            return Ok(registration.due_at);
        }
        let (generation, wakeup_at) = {
            let tasks = get_tasks_map();
            let mut task = tasks
                .get_mut(task_id)
                .ok_or_else(|| format!("Background task '{task_id}' was not found; it may have been removed by the history-retention policy"))?;
            if task.status.is_terminal() {
                return Err(format!(
                    "Background task '{task_id}' has already ended; no further wait is needed"
                ));
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
            return Err(format!(
                "Failed to persist background-task wake-up: {error}"
            ));
        }
        Ok(wakeup_at)
    }

    pub async fn cancel(&self, task_id: &str) {
        if let Err(error) = self.timers.cancel(&background_wake_timer_id(task_id)).await {
            tracing::warn!(event_code = "tool.background_timer.cancel_failed", task_id, %error, "Failed to cancel the background-task wake Timer");
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
        let authoritative_job = if let Some(manager) = self.execution_jobs.as_ref() {
            let Some(job) = self.get_background_job(&timer.owner_id).await? else {
                return Ok(TimerDisposition::Complete);
            };
            if job.checkpoint_generation != Some(generation) || job.checkpoint_due_at.is_none() {
                return Ok(TimerDisposition::Complete);
            }
            if job.status.is_terminal() {
                manager
                    .store()
                    .clear_background_checkpoint(&job.id, generation)
                    .await?;
                return Ok(TimerDisposition::Complete);
            }
            if job
                .checkpoint_due_at
                .is_some_and(|due| due > chrono::Utc::now())
            {
                return Ok(TimerDisposition::Reschedule {
                    due_at: job.checkpoint_due_at.expect("checked Some"),
                    reason: Some("durable background checkpoint is not due yet".to_string()),
                });
            }
            Some(job)
        } else {
            None
        };
        let mut payload = {
            let tasks = get_tasks_map();
            match tasks.get_mut(&timer.owner_id) {
                Some(mut task) => {
                    // In durable mode the local map is output/PGID cache only;
                    // lifecycle, generation, and due time came from the Job
                    // above. Keep the old checks solely for the memory-only
                    // scheduler used by isolated tests/embedders.
                    if authoritative_job.is_none() {
                        if task.status.is_terminal() || task.wake_generation != generation {
                            return Ok(TimerDisposition::Complete);
                        }
                        if task
                            .next_wakeup_at
                            .is_some_and(|due| due > chrono::Utc::now())
                        {
                            return Ok(TimerDisposition::Reschedule {
                                due_at: task.next_wakeup_at.expect("checked Some"),
                                reason: Some("background checkpoint is not due yet".to_string()),
                            });
                        }
                        task.next_wakeup_at = None;
                    }
                    background_check_due_payload(&task, check_after_secs, wake_source)
                }
                None => {
                    // Runtime Timers are claimed from a shared Store, while an
                    // OS process handle exists only in the Runtime that
                    // launched it. A peer must still deliver the durable
                    // checkpoint instead of consuming the Timer as an orphan.
                    let Some(job) = authoritative_job.as_ref() else {
                        return Ok(TimerDisposition::Complete);
                    };
                    background_check_due_payload_from_job(job, check_after_secs, wake_source)
                }
            }
        };
        if let Some(job) = authoritative_job.as_ref() {
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
        let thread_id = if let Some(job) = authoritative_job.as_ref() {
            Some(job.thread_id.clone())
        } else {
            get_tasks_map().get(&timer.owner_id).and_then(|task| {
                task.causal_route
                    .as_ref()
                    .map(|route| route.thread_id.clone())
            })
        }
        .ok_or_else(|| {
            format!(
                "Background-task checkpoint '{}' is missing an authoritative Thread route",
                timer.owner_id
            )
        })?;
        // Typed routing owns the Thread→Session decision. An early terminal/
        // missing-owner escalate would steal supervisor-owned attached children.
        let owner = if let Some(sessions) = self.sessions.as_ref() {
            sessions.get_thread(&thread_id).await?
        } else {
            None
        };
        // Without a Session store the original Thread mailbox is the only route.
        let route = if self.sessions.is_none() {
            WakeRoute::DirectThread {
                thread_id: thread_id.clone(),
            }
        } else {
            resolve_wake_route(
                BackgroundWakeKind::Checkpoint,
                authoritative_job
                    .as_ref()
                    .is_some_and(|job| job.status.is_terminal()),
                authoritative_job
                    .as_ref()
                    .map(|job| job.session_id.as_str())
                    .unwrap_or(""),
                owner.as_ref(),
            )
        };
        match route {
            WakeRoute::DirectThread { thread_id: target } => {
                if let (Some(job), Some(sessions)) =
                    (authoritative_job.as_ref(), self.sessions.as_ref())
                {
                    match sessions
                        .claim_background_thread_wake(&event, &job.id, generation, &target)
                        .await?
                    {
                        crate::memory::BackgroundThreadWakeClaim::Accepted { event } => {
                            self.bus.dispatch_persisted(event).await?;
                        }
                        crate::memory::BackgroundThreadWakeClaim::Existing { .. }
                        | crate::memory::BackgroundThreadWakeClaim::StaleCheckpoint => {}
                        crate::memory::BackgroundThreadWakeClaim::MissingThread
                        | crate::memory::BackgroundThreadWakeClaim::InactiveThread { .. } => {
                            // The Thread changed after the optimistic route
                            // read. Re-resolve through the atomic Session path;
                            // it owns the same generation CAS.
                            return self
                                .escalate_checkpoint_to_session(
                                    Some(job),
                                    event.payload.clone(),
                                    generation,
                                )
                                .await;
                        }
                    }
                } else {
                    self.events.append_to_thread(event.clone(), &target).await?;
                    self.bus.dispatch_persisted(event).await?;
                }
                Ok(TimerDisposition::Complete)
            }
            WakeRoute::SessionEscalation { .. } => {
                if owner.is_none() {
                    tracing::warn!(
                        task_id = %timer.owner_id,
                        thread_id,
                        event_code = "tool.background_checkpoint.thread_missing_escalation",
                        "Escalating a background checkpoint to the owning Session because its durable Thread owner is missing"
                    );
                } else {
                    tracing::info!(
                        task_id = %timer.owner_id,
                        thread_id,
                        thread_lifecycle = owner
                            .as_ref()
                            .map(|thread| thread.lifecycle.as_str())
                            .unwrap_or("missing"),
                        event_code = "tool.background_checkpoint.thread_terminal_escalation",
                        "Escalating a background checkpoint to the owning Session because its Execution Thread is terminal"
                    );
                }
                self.escalate_checkpoint_to_session(
                    authoritative_job.as_ref(),
                    event.payload.clone(),
                    generation,
                )
                .await
            }
            WakeRoute::Suppress { reason } => {
                if let Some(job) = authoritative_job.as_ref() {
                    if let Some(sessions) = self.sessions.as_ref() {
                        let outcome = match reason {
                            WakeSuppression::JobAlreadyTerminal => {
                                "background_checkpoint_job_terminal"
                            }
                            WakeSuppression::SupervisorOwnedChild => {
                                "background_checkpoint_supervisor_owned_child"
                            }
                        };
                        sessions
                            .suppress_background_checkpoint(
                                &event, &job.id, generation, outcome, false,
                            )
                            .await?;
                    } else if let Some(manager) = self.execution_jobs.as_ref() {
                        manager
                            .store()
                            .clear_background_checkpoint(&job.id, generation)
                            .await?;
                    }
                }
                tracing::debug!(
                    task_id = %timer.owner_id,
                    thread_id,
                    ?reason,
                    event_code = "tool.background_checkpoint.wake_suppressed",
                    "Background checkpoint wake was suppressed by typed wake routing"
                );
                Ok(TimerDisposition::Complete)
            }
        }
    }

    /// Controlled Thread→Session escalation for one due background checkpoint.
    /// The checkpoint payload becomes a fresh DialogueTurn root in the owning
    /// Session (a Runtime Wake Event); the terminal Thread identity is
    /// preserved only as `source_thread_id`/`source_activation_id` provenance.
    /// Route resolution, Event persistence, DialogueTurn creation, and
    /// checkpoint clearing happen in one Store transaction.
    async fn escalate_checkpoint_to_session(
        &self,
        job: Option<&ExecutionJobRecord>,
        mut payload: serde_json::Map<String, serde_json::Value>,
        generation: u64,
    ) -> Result<TimerDisposition, Box<dyn std::error::Error + Send + Sync>> {
        let Some(job) = job else {
            // Without the durable Job there is no authoritative Session route;
            // silent convergence is the only safe disposition for a stale timer.
            return Ok(TimerDisposition::Complete);
        };
        let Some(sessions) = self.sessions.as_ref() else {
            return Ok(TimerDisposition::Complete);
        };
        prepare_background_session_wake_payload(&mut payload);
        payload.insert("session_id".to_string(), serde_json::json!(job.session_id));
        payload.insert("context_id".to_string(), serde_json::json!(job.context_id));
        payload.insert(
            "source_thread_id".to_string(),
            serde_json::json!(job.thread_id),
        );
        payload.insert(
            "source_activation_id".to_string(),
            serde_json::json!(job.activation_id),
        );
        payload.insert(
            "checkpoint_generation".to_string(),
            serde_json::json!(generation),
        );
        payload.insert("wake_kind".to_string(), serde_json::json!("checkpoint"));
        let event = Event::new(
            format!("background_wake_{}_g{}", job.id, generation),
            "System-TaskMonitor".to_string(),
            crate::event::TYPE_RUNTIME_WAKE.to_string(),
            "runtime/background_wake".to_string(),
            payload,
        );
        match sessions
            .claim_background_session_wake(&event, &job.id, Some(generation))
            .await?
        {
            crate::memory::BackgroundSessionWakeClaim::Accepted { event } => {
                self.bus.dispatch_persisted(event).await?;
            }
            crate::memory::BackgroundSessionWakeClaim::Existing { event_id } => {
                tracing::debug!(
                    execution_job_id = %job.id,
                    event_id,
                    event_code = "tool.background_checkpoint.wake_replay",
                    "Background checkpoint wake was already committed; skipping redelivery"
                );
            }
            crate::memory::BackgroundSessionWakeClaim::StaleCheckpoint => {
                tracing::debug!(
                    execution_job_id = %job.id,
                    generation,
                    event_code = "tool.background_checkpoint.stale_generation",
                    "Dropped a background checkpoint wake whose durable generation no longer matches"
                );
            }
            crate::memory::BackgroundSessionWakeClaim::ArchivedSession => {
                tracing::warn!(
                    execution_job_id = %job.id,
                    session_id = %job.session_id,
                    event_code = "tool.background_checkpoint.session_archived",
                    "Background checkpoint wake was suppressed for an archived Session and recorded atomically"
                );
            }
            crate::memory::BackgroundSessionWakeClaim::MissingSession => {
                tracing::error!(
                    execution_job_id = %job.id,
                    session_id = %job.session_id,
                    event_code = "tool.background_checkpoint.session_missing",
                    "Background checkpoint wake found no owning Session; ExecutionJob Session foreign key integrity is broken"
                );
            }
            crate::memory::BackgroundSessionWakeClaim::RouteConflict {
                registered_context_id,
            } => {
                tracing::error!(
                    execution_job_id = %job.id,
                    session_id = %job.session_id,
                    event_context_id = %job.context_id,
                    registered_context_id,
                    event_code = "tool.background_checkpoint.context_route_conflict",
                    "Background checkpoint wake Context route conflicted with its Session registry; checkpoint was closed with operator attention"
                );
            }
            crate::memory::BackgroundSessionWakeClaim::ForbiddenPrincipal { principal_id } => {
                tracing::warn!(
                    execution_job_id = %job.id,
                    principal_id,
                    event_code = "tool.background_checkpoint.principal_unbound",
                    "Dropped a background checkpoint wake whose principal is no longer bound to the Session"
                );
            }
        }
        Ok(TimerDisposition::Complete)
    }

    /// Controlled Thread→Session escalation for one terminal background result
    /// whose owning Execution Thread can no longer accept a Direct Signal.
    /// The physical TYPE_TOOL_OUTPUT result Event remains the Job's
    /// `result_event_id`; this wake Event is a fresh DialogueTurn root.
    /// Pass `expected_checkpoint_generation = None` so an unrelated armed
    /// checkpoint is not cleared.
    async fn escalate_terminal_result_to_session(
        &self,
        job: &ExecutionJobRecord,
        result_event: &Event,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(sessions) = self.sessions.as_ref() else {
            return Ok(());
        };
        let mut payload = result_event.payload.clone();
        prepare_background_session_wake_payload(&mut payload);
        payload.insert("session_id".to_string(), serde_json::json!(job.session_id));
        payload.insert("context_id".to_string(), serde_json::json!(job.context_id));
        payload.insert(
            "source_thread_id".to_string(),
            serde_json::json!(job.thread_id),
        );
        payload.insert(
            "source_activation_id".to_string(),
            serde_json::json!(job.activation_id),
        );
        payload.insert(
            "result_event_id".to_string(),
            serde_json::json!(result_event.id),
        );
        payload.insert(
            "wake_kind".to_string(),
            serde_json::json!("terminal_result"),
        );
        payload.insert(
            "event".to_string(),
            serde_json::json!("background_task_terminal"),
        );
        if let Some(principal_id) = job.initiating_principal_id.as_deref() {
            payload.insert("principal_id".to_string(), serde_json::json!(principal_id));
        }
        let event = Event::new(
            format!("background_wake_result_{}", job.id),
            "System-TaskMonitor".to_string(),
            crate::event::TYPE_RUNTIME_WAKE.to_string(),
            "runtime/background_wake".to_string(),
            payload,
        );
        match sessions
            .claim_background_session_wake(&event, &job.id, None)
            .await?
        {
            crate::memory::BackgroundSessionWakeClaim::Accepted { event } => {
                self.bus.dispatch_persisted(event).await?;
            }
            crate::memory::BackgroundSessionWakeClaim::Existing { event_id } => {
                tracing::debug!(
                    execution_job_id = %job.id,
                    event_id,
                    event_code = "tool.background_result.wake_replay",
                    "Background terminal-result Session wake was already committed; skipping redelivery"
                );
            }
            crate::memory::BackgroundSessionWakeClaim::StaleCheckpoint => {
                tracing::debug!(
                    execution_job_id = %job.id,
                    event_code = "tool.background_result.stale_generation",
                    "Dropped a terminal-result Session wake whose durable generation no longer matches"
                );
            }
            crate::memory::BackgroundSessionWakeClaim::ArchivedSession => {
                tracing::warn!(
                    execution_job_id = %job.id,
                    session_id = %job.session_id,
                    event_code = "tool.background_result.session_archived",
                    "Terminal-result Session wake was suppressed for an archived Session and recorded atomically"
                );
            }
            crate::memory::BackgroundSessionWakeClaim::MissingSession => {
                tracing::error!(
                    execution_job_id = %job.id,
                    session_id = %job.session_id,
                    event_code = "tool.background_result.session_missing",
                    "Terminal-result Session wake found no owning Session; ExecutionJob Session foreign key integrity is broken"
                );
            }
            crate::memory::BackgroundSessionWakeClaim::RouteConflict {
                registered_context_id,
            } => {
                tracing::error!(
                    execution_job_id = %job.id,
                    session_id = %job.session_id,
                    event_context_id = %job.context_id,
                    registered_context_id,
                    event_code = "tool.background_result.context_route_conflict",
                    "Terminal-result Session wake Context route conflicted with its Session registry and was closed with operator attention"
                );
            }
            crate::memory::BackgroundSessionWakeClaim::ForbiddenPrincipal { principal_id } => {
                tracing::warn!(
                    execution_job_id = %job.id,
                    principal_id,
                    event_code = "tool.background_result.principal_unbound",
                    "Dropped a terminal-result Session wake whose principal is no longer bound to the Session"
                );
            }
        }
        Ok(())
    }

    async fn maybe_escalate_terminal_background_result(
        &self,
        job: &ExecutionJobRecord,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(sessions) = self.sessions.as_ref() else {
            return Ok(());
        };
        let owner = sessions.get_thread(&job.thread_id).await?;
        match resolve_wake_route(
            BackgroundWakeKind::TerminalResult,
            false,
            &job.session_id,
            owner.as_ref(),
        ) {
            WakeRoute::DirectThread { .. } => return Ok(()),
            WakeRoute::Suppress { reason } => {
                tracing::debug!(
                    execution_job_id = %job.id,
                    ?reason,
                    event_code = "tool.background_result.wake_suppressed",
                    "Skipped terminal-result Session escalation by typed wake routing"
                );
                return Ok(());
            }
            WakeRoute::SessionEscalation { .. } => {}
        }
        let Some(event_id) = job.result_event_id.as_deref() else {
            return Ok(());
        };
        let mut events = self
            .events
            .query(QueryFilter {
                event_id: Some(event_id.to_string()),
                ..Default::default()
            })
            .await?;
        if events.len() != 1 {
            return Ok(());
        }
        self.escalate_terminal_result_to_session(job, &events.remove(0))
            .await
    }
}

fn applied_background_job(
    receipt: JobReceipt,
    operation: &str,
) -> Result<ExecutionJobRecord, Box<dyn std::error::Error + Send + Sync>> {
    match receipt {
        JobReceipt::Applied { job, .. } | JobReceipt::Existing { job, .. } => Ok(job),
        JobReceipt::Conflict { current, .. } => Err(format!(
            "background ExecutionJob {} {} revision conflict (current r{})",
            current.id, operation, current.revision
        )
        .into()),
        JobReceipt::Rejected {
            current, reason, ..
        } => Err(format!(
            "background ExecutionJob {} {} was rejected: {}",
            current.id, operation, reason
        )
        .into()),
        JobReceipt::NotFound { .. } => {
            Err(format!("Background ExecutionJob does not exist during {operation}").into())
        }
    }
}

/// Why a background wake is being delivered. Shared owner-state resolution
/// never implies a shared fallback: TerminalResult and Checkpoint choose
/// independently among DirectThread, Session upgrade, and suppression.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BackgroundWakeKind {
    TerminalResult,
    Checkpoint,
}

/// Typed reason a wake must not be upgraded to a Session DialogueTurn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WakeSuppression {
    /// Stale BackgroundWake Timer whose Job already reached a terminal status.
    JobAlreadyTerminal,
    /// Attached child owned by a Thread/Evaluation supervisor. Session
    /// escalation would steal the result from that supervisor.
    SupervisorOwnedChild,
}

/// Authoritative delivery target for one background wake.
#[derive(Debug, Clone, PartialEq, Eq)]
enum WakeRoute {
    DirectThread { thread_id: String },
    SessionEscalation { session_id: String },
    Suppress { reason: WakeSuppression },
}

/// Convert a physical background-result/checkpoint payload into a fresh
/// Session DialogueTurn payload. The old physical route remains available as
/// explicit `source_*` provenance, but must not be interpreted as the parent
/// or root of the new Runtime Wake.
fn prepare_background_session_wake_payload(
    payload: &mut serde_json::Map<String, serde_json::Value>,
) {
    for key in [
        "wake_policy",
        "activation_id",
        "attempt_id",
        "thread_id",
        "root_turn_id",
        "parent_activation_id",
        "trigger_event_id",
        "trigger_sequence",
    ] {
        payload.remove(key);
    }
    payload.insert(
        "wake_policy".to_string(),
        serde_json::json!("session_fallback"),
    );
}

fn owner_accepts_direct_signal(owner: &ThreadRecord) -> bool {
    !owner.lifecycle.is_terminal()
}

fn supervisor_owned_child(owner: &ThreadRecord) -> bool {
    matches!(
        owner.supervision.supervisor_kind,
        ThreadSupervisorKind::Thread | ThreadSupervisorKind::Evaluation
    )
}

fn resolve_wake_route(
    kind: BackgroundWakeKind,
    job_is_terminal: bool,
    session_id: &str,
    owner: Option<&ThreadRecord>,
) -> WakeRoute {
    // Checkpoints of an already-terminal Job are stale Timers. Terminal-result
    // recovery still needs a Session upgrade even though the Job row is terminal,
    // so this guard is kind-specific.
    if job_is_terminal && kind == BackgroundWakeKind::Checkpoint {
        return WakeRoute::Suppress {
            reason: WakeSuppression::JobAlreadyTerminal,
        };
    }
    match owner {
        Some(thread) if owner_accepts_direct_signal(thread) => WakeRoute::DirectThread {
            thread_id: thread.id.clone(),
        },
        Some(thread) if supervisor_owned_child(thread) => WakeRoute::Suppress {
            reason: WakeSuppression::SupervisorOwnedChild,
        },
        Some(thread) => WakeRoute::SessionEscalation {
            session_id: if session_id.is_empty() {
                thread.session_id.clone()
            } else {
                session_id.to_string()
            },
        },
        None => WakeRoute::SessionEscalation {
            session_id: session_id.to_string(),
        },
    }
}

fn background_wake_timer_id(task_id: &str) -> String {
    format!("background-wake:{task_id}")
}

#[cfg(test)]
mod wake_route_tests {
    use super::*;
    use crate::memory::{DeliveryStatus, ThreadControlState};

    fn thread(lifecycle: ThreadLifecycle, supervision: ThreadSupervision) -> ThreadRecord {
        ThreadRecord {
            id: "thread-wake".into(),
            revision: 1,
            generation: 1,
            agent_id: "agent-wake".into(),
            context_id: "context-wake".into(),
            session_id: "session-wake".into(),
            initiating_principal_id: None,
            root_turn_id: "root-wake".into(),
            kind: ThreadKind::Execution,
            lifecycle,
            control_state: ThreadControlState::Active,
            executor_kind: "self".into(),
            executor_id: None,
            target_id: None,
            supervision,
            result_text: None,
            result_event_id: None,
            delivery_status: DeliveryStatus::None,
            delivery_event_id: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        }
    }

    fn evaluation_attached() -> ThreadSupervision {
        let mut supervision = ThreadSupervision::attached("parent-thread", 1, "eval-wake");
        supervision.supervisor_kind = ThreadSupervisorKind::Evaluation;
        supervision
    }

    #[test]
    fn open_owner_always_takes_the_direct_thread() {
        let owner = thread(
            ThreadLifecycle::Open,
            ThreadSupervision::attached("parent-thread", 1, "eval-wake"),
        );
        for kind in [
            BackgroundWakeKind::TerminalResult,
            BackgroundWakeKind::Checkpoint,
        ] {
            assert_eq!(
                resolve_wake_route(kind, false, "session-job", Some(&owner)),
                WakeRoute::DirectThread {
                    thread_id: owner.id.clone(),
                },
            );
        }
    }

    #[test]
    fn terminal_supervisor_owned_child_is_suppressed() {
        for supervision in [
            ThreadSupervision::attached("parent-thread", 1, "eval-wake"),
            evaluation_attached(),
        ] {
            let owner = thread(ThreadLifecycle::Completed, supervision);
            for kind in [
                BackgroundWakeKind::TerminalResult,
                BackgroundWakeKind::Checkpoint,
            ] {
                assert_eq!(
                    resolve_wake_route(kind, false, "session-job", Some(&owner)),
                    WakeRoute::Suppress {
                        reason: WakeSuppression::SupervisorOwnedChild,
                    },
                );
            }
        }
    }

    #[test]
    fn terminal_non_child_owner_escalates_to_session() {
        let owner = thread(ThreadLifecycle::Completed, ThreadSupervision::legacy());
        assert_eq!(
            resolve_wake_route(
                BackgroundWakeKind::TerminalResult,
                false,
                "session-job",
                Some(&owner),
            ),
            WakeRoute::SessionEscalation {
                session_id: "session-job".into(),
            },
        );
        assert_eq!(
            resolve_wake_route(BackgroundWakeKind::Checkpoint, false, "", Some(&owner),),
            WakeRoute::SessionEscalation {
                session_id: owner.session_id.clone(),
            },
        );
    }

    #[test]
    fn missing_owner_escalates_to_the_job_session() {
        assert_eq!(
            resolve_wake_route(
                BackgroundWakeKind::TerminalResult,
                false,
                "session-job",
                None,
            ),
            WakeRoute::SessionEscalation {
                session_id: "session-job".into(),
            },
        );
    }

    #[test]
    fn terminal_job_suppresses_only_stale_checkpoints() {
        let owner = thread(ThreadLifecycle::Open, ThreadSupervision::legacy());
        assert_eq!(
            resolve_wake_route(
                BackgroundWakeKind::Checkpoint,
                true,
                "session-job",
                Some(&owner),
            ),
            WakeRoute::Suppress {
                reason: WakeSuppression::JobAlreadyTerminal,
            },
        );
        assert_eq!(
            resolve_wake_route(
                BackgroundWakeKind::TerminalResult,
                true,
                "session-job",
                Some(&owner),
            ),
            WakeRoute::DirectThread {
                thread_id: owner.id.clone(),
            },
        );
    }
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
        let queued = self
            .sessions
            .list_schedules(None, Some(ScheduleStatus::Queued))
            .await?;
        // The owner row is authoritative. A crash may happen after pause or
        // cancel commits but before its timer is cancelled; proactively clean
        // only physically live Schedule timers before the Timer Engine starts.
        // Historical Schedule rows and fired/cancelled Timer rows are not a
        // recovery work set and must not be read on every startup.
        for timer in self
            .timers
            .list_live()
            .await?
            .into_iter()
            .filter(|timer| timer.kind == RuntimeTimerKind::Schedule)
        {
            let owner_is_queued = self
                .sessions
                .get_schedule(&timer.owner_id)
                .await?
                .is_some_and(|intent| intent.status == ScheduleStatus::Queued);
            if !owner_is_queued {
                self.timers.cancel(&timer.id).await?;
            }
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
        for event in self.sessions.list_undelivered_schedule_events().await? {
            let root_turn_id = event
                .payload
                .get("root_turn_id")
                .and_then(|value| value.as_str());
            let root = root_turn_id
                .ok_or_else(|| format!("Schedule Event '{}' is missing root_turn_id", event.id))?;
            let thread = self
                .sessions
                .get_thread_by_root(root)
                .await?
                .ok_or_else(|| {
                    format!(
                        "Schedule Event '{}' is missing its authoritative Thread",
                        event.id
                    )
                })?;
            if thread.lifecycle.is_terminal() {
                tracing::debug!(
                    event_id = %event.id,
                    thread_id = %thread.id,
                    thread_lifecycle = thread.lifecycle.as_str(),
                    event_code = "tool.schedule_recovery.thread_terminal",
                    "Skipped redelivery of a persisted Schedule Event after its target Thread reached terminal state"
                );
                continue;
            }
            self.events
                .append_to_thread(event.clone(), &thread.id)
                .await?;
            self.bus.dispatch_persisted(event).await?;
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
                    reason: Some("Schedule has not reached not_before".to_string()),
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
            .ok_or_else(|| format!("Target Thread for Schedule '{}' does not exist", current.id))?;
        let root_turn_id = if current.interval_seconds.is_some() {
            scheduled_occurrence_root(&current.id, occurrence_revision)
        } else {
            owner.root_turn_id.clone()
        };
        let occurrence_thread = current.interval_seconds.map(|_| NewThread {
            id: stable_thread_id(&root_turn_id),
            agent_id: owner.agent_id.clone(),
            context_id: owner.context_id.clone(),
            session_id: owner.session_id.clone(),
            initiating_principal_id: owner.initiating_principal_id.clone(),
            root_turn_id: root_turn_id.clone(),
            kind: ThreadKind::Execution,
            executor_kind: "self".to_string(),
            executor_id: None,
            target_id: owner.target_id.clone(),
            supervision: ThreadSupervision::runtime("schedule-occurrence-router"),
        });
        let objective_interrupt = if current.interval_seconds.is_none()
            && owner.supervision.supervisor_kind == ThreadSupervisorKind::Objective
            && owner.supervision.origin_evaluation_id.is_none()
        {
            owner
                .supervision
                .supervisor_id
                .as_deref()
                .filter(|objective_id| {
                    owner.root_turn_id
                        == crate::memory::objective_primary_execution_root_id(
                            objective_id,
                            owner.supervision.generation,
                        )
                })
                .map(|objective_id| (objective_id.to_string(), owner.supervision.generation))
        } else {
            None
        };
        let event_id = format!("schedule_due_{}_r{}", current.id, occurrence_revision);
        let mut payload = vec![
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
                "model_alias".to_string(),
                serde_json::json!(current.model_alias),
            ),
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
        ];
        if let Some((objective_id, objective_generation)) = objective_interrupt {
            payload.extend([
                ("objective_interrupt".to_string(), serde_json::json!(true)),
                (
                    "objective_phase".to_string(),
                    serde_json::json!("interrupt"),
                ),
                (
                    "wake_source".to_string(),
                    serde_json::json!("schedule-enqueue"),
                ),
                ("objective_id".to_string(), serde_json::json!(objective_id)),
                (
                    "objective_generation".to_string(),
                    serde_json::json!(objective_generation),
                ),
            ]);
        }
        let event = Event::new(
            event_id,
            "Runtime-Scheduler".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/schedule_due".to_string(),
            payload.into_iter().collect(),
        );
        let Some(claimed) = self
            .sessions
            .commit_scheduled_dispatch(
                &current.id,
                current.revision,
                next_not_before,
                &event,
                occurrence_thread.as_ref(),
            )
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
    kernel: Option<Arc<SchedulerKernel>>,
    allowed_evaluation_models: std::collections::HashSet<String>,
    evaluation_model_policy: Option<Arc<ContextEngine>>,
}

impl ScheduleTxTool {
    pub fn new(scheduler: Arc<ThreadScheduler>, sessions: Arc<dyn SessionStore>) -> Self {
        Self {
            scheduler,
            sessions,
            objectives: None,
            kernel: None,
            allowed_evaluation_models: std::collections::HashSet::new(),
            evaluation_model_policy: None,
        }
    }

    /// Grants the Agent authority to select these model routes for scheduled
    /// Evaluations. The primary model is supplied by the Runtime together with
    /// any explicit `llm.allowed_evaluation_models` entries. An omitted model
    /// remains an inheritance request rather than being rewritten here.
    pub fn with_allowed_evaluation_models(
        mut self,
        models: impl IntoIterator<Item = String>,
    ) -> Self {
        self.allowed_evaluation_models = models
            .into_iter()
            .map(|model| model.trim().to_string())
            .filter(|model| !model.is_empty())
            .collect();
        self
    }

    /// Bind model authorization to the Runtime's live Evaluation policy.
    /// Static allowlists remain available for narrow unit fixtures, while the
    /// production registry observes Dashboard/config edits immediately.
    pub fn with_evaluation_model_policy(mut self, context_engine: Arc<ContextEngine>) -> Self {
        self.evaluation_model_policy = Some(context_engine);
        self
    }

    fn allowed_evaluation_models(&self) -> std::collections::HashSet<String> {
        self.evaluation_model_policy
            .as_ref()
            .map(|context_engine| {
                context_engine
                    .agent_allowed_evaluation_models()
                    .into_iter()
                    .collect()
            })
            .unwrap_or_else(|| self.allowed_evaluation_models.clone())
    }

    pub fn with_objective_store(mut self, objectives: Arc<dyn ObjectiveStore>) -> Self {
        self.objectives = Some(objectives);
        self
    }

    pub fn with_scheduler_kernel(mut self, kernel: Arc<SchedulerKernel>) -> Self {
        self.kernel = Some(kernel);
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
                return Err(
                    "Internal error: create operations cannot enter the Schedule control plane"
                        .into(),
                );
            }
        };
        if schedule_id.trim().is_empty() {
            return Err("schedule_id must not be empty".into());
        }
        let inspected = self.scheduler.inspect(schedule_id).await?;
        if let Some(intent) = &inspected {
            let target = self
                .sessions
                .get_thread(&intent.thread_id)
                .await?
                .ok_or_else(|| {
                    format!("Target Thread for Schedule '{}' does not exist", intent.id)
                })?;
            if target.context_id != context_id {
                return Err(
                    "A Schedule from another Context cannot be inspected or modified".into(),
                );
            }
        }

        let (operation_name, mutation) = match operation {
            ScheduleOperation::Inspect { .. } => {
                return Ok(crate::local_time::localized_runtime_json(serde_json::json!({
                    "status": if inspected.is_some() { "ok" } else { "not_found" },
                    "operation": "inspect",
                    "schedule": inspected,
                    "guidance": "Subsequent mutations must submit the current revision returned here; the Runtime rejects stale revisions."
                }))
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
                    return Err("Provide only one of not_before and delay_seconds".into());
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
        route: &ToolCausalRoute,
        parent_thread: &ThreadRecord,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        if parent_thread.id != route.thread_id || parent_thread.lifecycle != ThreadLifecycle::Open {
            return Err("The current parent Thread route is stale, so the attached Thread cannot be promoted".into());
        }
        let context_id = parent_thread.context_id.as_str();
        let session_id = parent_thread.session_id.as_str();
        let target =
            self.sessions.get_thread(&thread_id).await?.ok_or_else(|| {
                format!("Thread '{thread_id}' selected for promotion does not exist")
            })?;
        if target.context_id != context_id || target.session_id != session_id {
            return Err(
                "Only an attached Thread in the current Context/Session can be promoted".into(),
            );
        }
        if target.lifecycle != ThreadLifecycle::Open
            || target.supervision.lifetime != ThreadLifetime::Attached
        {
            return Err("Only an attached Thread that is still open can be promoted".into());
        }
        let owned_by_parent_thread = target.supervision.supervisor_kind
            == ThreadSupervisorKind::Thread
            && target.supervision.supervisor_id.as_deref() == Some(route.thread_id.as_str())
            && target.supervision.parent_thread_id.as_deref() == Some(route.thread_id.as_str())
            && target.supervision.generation == parent_thread.generation;
        let owned_by_legacy_activation = target.supervision.supervisor_kind
            == ThreadSupervisorKind::Evaluation
            && target.supervision.supervisor_id.as_deref() == Some(route.activation_id.as_str())
            && target.supervision.origin_evaluation_id.as_deref()
                == Some(route.activation_id.as_str());
        if !owned_by_parent_thread && !owned_by_legacy_activation {
            return Err(
                "An attached Thread owned by another parent Thread generation cannot be promoted"
                    .into(),
            );
        }
        let source_group_id = target
            .supervision
            .thread_group_id
            .clone()
            .ok_or("Attached Thread has no source Thread Group, so supervision cannot be transferred safely")?;
        let objectives = self.objectives.as_ref().ok_or(
            "Current Runtime has no Objective Store configured and cannot promote a durable Thread",
        )?;

        let (objective_id, expected_objective_revision, new_objective_spec, completion_criteria) =
            match objective_binding {
                ScheduleObjectiveBinding::Current => {
                    let objective_id = CURRENT_OBJECTIVE_ID
                        .try_with(Clone::clone)
                        .ok()
                        .flatten()
                        .ok_or(
                        "the current Evaluation is not bound to an Objective, so objective.mode=current cannot be used",
                    )?;
                    let objective = objectives
                        .get_objective(&objective_id)
                        .await?
                        .ok_or_else(|| format!("Objective '{objective_id}' does not exist"))?;
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
                        return Err("objective_id must not be empty".into());
                    }
                    let objective = objectives
                        .get_objective(&objective_id)
                        .await?
                        .ok_or_else(|| format!("Objective '{objective_id}' does not exist"))?;
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
                        return Err("objective.mode=create requires a non-empty objective and completion criteria".into());
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
                        "adopt an already running attached Thread; completion criteria: {new_completion_criteria}"
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
                    "Thread '{}' was atomically transferred from the current parent Thread to Objective '{}'",
                    thread_id, objective_id
                ),
            })
            .as_object()
            .expect("thread promotion event payload")
            .clone(),
        );
        let request = ThreadPromotionRequest {
            thread_id,
            expected_thread_revision: expected_revision,
            source_group_id,
            objective_id,
            expected_objective_revision,
            new_objective,
            target_group,
            promoted_event,
        };
        let mutation = if let Some(kernel) = &self.kernel {
            let command_id = format!("kernel_command_{}", request.promoted_event.id);
            match kernel
                .execute(KernelCommand {
                    header: KernelCommandHeader::new(
                        command_id,
                        route.trigger_event_id.clone(),
                        route.root_turn_id.clone(),
                        "Agent-Morphz",
                    )
                    .with_fence(expected_revision, Some(target_generation)),
                    payload: KernelCommandPayload::PromoteThread(PromoteThreadCommand { request }),
                })
                .await?
            {
                KernelResult::ThreadPromoted(mutation) => mutation,
                _ => {
                    return Err(
                        "Scheduler Kernel returned an invalid Thread-promotion result".into(),
                    )
                }
            }
        } else {
            // Constructor compatibility for narrow unit fixtures. Runtime
            // assembly always injects the Kernel and therefore cannot use this
            // direct Store bridge.
            self.sessions.promote_attached_thread(request).await?
        };
        Ok(
            crate::local_time::localized_runtime_json(thread_promotion_receipt(mutation))
                .to_string(),
        )
    }
}

fn schedule_mutation_receipt(operation: &str, mutation: ScheduleMutation) -> serde_json::Value {
    crate::local_time::localized_runtime_json(match mutation {
        ScheduleMutation::Updated(schedule) => serde_json::json!({
            "status": "updated",
            "operation": operation,
            "schedule": schedule,
            "guidance": "The Schedule and its matching Timer generation were finalized under the same revision."
        }),
        ScheduleMutation::Conflict { current } => serde_json::json!({
            "status": "conflict",
            "operation": operation,
            "schedule": current,
            "guidance": "The submitted expected_revision is stale. Re-decide from the returned current state instead of blindly retrying the old request."
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
    })
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
            "Objective '{}' is not an active Objective in the current Agent/Context/Session",
            objective.id
        )
        .into());
    }
    if objective.wait_condition.is_some() {
        return Err(format!(
            "Objective '{}' already has a wait condition and cannot adopt another independent Thread Group",
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
            "guidance": "The same Thread is now durable. The original Evaluation barrier is released and the Objective Group verifies its eventual terminal state. Do not create a duplicate Thread for the same work."
        }),
        ThreadPromotionMutation::Conflict {
            current_thread,
            current_objective,
        } => serde_json::json!({
            "status": "conflict",
            "operation": "promote",
            "thread": current_thread,
            "objective": current_objective,
            "guidance": "The Thread or Objective revision changed. Re-decide from current state instead of blindly retrying the stale promotion request."
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
        #[serde(default)]
        model: Option<String>,
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
        #[serde(default)]
        model: Option<String>,
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
                    "stated_objective": {"type": "string", "description": "New objective with an independent pause, resume, cancellation, and acceptance lifecycle"},
                    "completion_criteria": {"type": "string", "description": "Explicit completion criteria for the new Objective"},
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
            "thread_id": {"type": "string", "description": "Open attached Thread owned by the current parent Thread generation"},
            "expected_revision": {"type": "integer", "minimum": 1, "description": "Revision returned when the Thread was created or inspected; a stale value returns conflict"},
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
        let allowed_evaluation_models = self.allowed_evaluation_models();
        let mut allowed_models = allowed_evaluation_models
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        allowed_models.sort();
        let model_schema = serde_json::json!({
            "type": "string",
            "enum": allowed_models,
            "description": "Agent-authorized logical model route for this Evaluation; omit to inherit the Session or Runtime primary model"
        });
        ToolDefinition {
            name: self.name().to_string(),
            description: "Create or control supervised Thread schedules. One call may atomically create multiple sibling tasks: operations without `after` are independent and may run concurrently; array order does not serialize them. For two or more spawns, every spawn must provide a unique client_id so receipts and dependencies remain stable. spawn requires a lifetime: attached is checked by the current parent Thread generation; durable must bind a current, existing, or newly created Objective; disposable is best effort with no recovery or delivery guarantee. Multiple siblings may form one authoritative group(all|any) barrier. enqueue/spawn may select an Agent-authorized model route; omit model to inherit the Session model or Runtime primary model. Explicit invalid or unauthorized models fail the whole transaction without fallback. promote atomically transfers an already started attached Thread from the current parent to a current/existing/create Objective without restarting work. objective.mode=create atomically commits an independent Objective, initial wait, Thread, Group, and Schedule. promote and inspect/pause/resume/reschedule/cancel must be submitted alone and use expected_revision to prevent stale writes. not_before or delay_seconds sets timing, every_seconds sets recurrence, and after declares Thread dependencies. schedule_tx must be the only tool call in the response.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "operations": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": MAX_SCHEDULE_OPERATIONS,
                        "description": "Schedule operations committed atomically. Array order is used only for deterministic receipts; operations run concurrently unless `after` declares a dependency.",
                        "items": {
                            "oneOf": [
                                {
                                    "type": "object",
                                    "properties": {
                                        "op": {"const": "enqueue"},
                                        "thread_id": {"type": "string", "description": "Target Thread ID; omit for the current Thread"},
                                        "intent": {"type": "string", "description": "Natural-language intent to execute when the Thread wakes"},
                                        "not_before": {"type": "string", "description": "RFC3339 absolute time expressed in evaluation-environment.local-time with an explicit offset; prefer delay_seconds for a relative wait"},
                                        "delay_seconds": {"type": "integer", "minimum": 0},
                                        "after": {"type": "array", "items": {"type": "string"}, "description": "Dependency Thread IDs or $client_id references to spawns in this transaction"},
                                        "model": model_schema.clone()
                                    },
                                    "required": ["op", "intent"],
                                    "additionalProperties": false
                                },
                                {
                                    "type": "object",
                                    "properties": {
                                        "op": {"const": "spawn"},
                                        "client_id": {"type": "string", "description": "Transaction-local name referenced by later after entries as $client_id"},
                                        "intent": {"type": "string"},
                                        "not_before": {"type": "string", "description": "RFC3339 absolute time expressed in evaluation-environment.local-time with an explicit offset; prefer delay_seconds for a relative wait"},
                                        "delay_seconds": {"type": "integer", "minimum": 0},
                                        "every_seconds": {"type": "integer", "minimum": 1, "description": "Fixed recurrence interval; each due time creates an independent occurrence Thread"},
                                        "after": {"type": "array", "items": {"type": "string"}},
                                        "target": {"type": "string", "description": "Stable Execution Target ID for the new Execution Thread; omit to remain unbound until its first physical action"},
                                        "lifetime": {
                                            "type": "string",
                                            "enum": ["attached", "durable", "disposable"],
                                            "description": "attached results must be consumed by this parent lifecycle; durable must bind an Objective; disposable cannot be a required dependency"
                                        },
                                        "objective": {
                                            "oneOf": objective_binding_schema["oneOf"].clone(),
                                            "description": "Used only with lifetime=durable. current names the bound Objective; create is only for a genuinely independent durable lifecycle"
                                        },
                                        "completion": {
                                            "type": "object",
                                            "properties": {
                                                "required": {"type": "boolean", "default": true},
                                                "contract": {"type": "object", "description": "Bounded completion contract verifiable by the Runtime or Harness"}
                                            },
                                            "additionalProperties": false
                                        },
                                        "model": model_schema.clone()
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
                                        "expected_revision": {"type": "integer", "minimum": 1, "description": "Current revision returned by inspect; a stale value returns conflict"}
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
                                        "not_before": {"type": "string", "description": "New local RFC3339 absolute time with an explicit offset; mutually exclusive with delay_seconds"},
                                        "delay_seconds": {"type": "integer", "minimum": 0},
                                        "every_seconds": {"type": "integer", "minimum": 1, "description": "New recurrence interval; omit to make the schedule one-shot"}
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
                        "description": "Create a durable join barrier for sibling Threads in this transaction; attached spawns automatically create an all Group"
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
            return Err(format!(
                "schedule_tx.operations count must be within 1..={MAX_SCHEDULE_OPERATIONS}"
            )
            .into());
        }
        let spawn_count = args
            .operations
            .iter()
            .filter(|operation| matches!(operation, ScheduleOperation::Spawn { .. }))
            .count();
        if spawn_count > 1 {
            let mut client_ids = std::collections::HashSet::new();
            for operation in &args.operations {
                let ScheduleOperation::Spawn { client_id, .. } = operation else {
                    continue;
                };
                let client_id = client_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|client_id| !client_id.is_empty())
                    .ok_or("Each spawn must provide a non-empty client_id when several spawns are created concurrently")?;
                if !client_ids.insert(client_id) {
                    return Err("client_id values must be unique when several spawns are created concurrently".into());
                }
            }
        }
        for operation in &args.operations {
            let requested_model = match operation {
                ScheduleOperation::Enqueue { model, .. }
                | ScheduleOperation::Spawn { model, .. } => model.as_deref(),
                _ => None,
            };
            let Some(requested_model) = requested_model else {
                continue;
            };
            let requested_model = requested_model.trim();
            if requested_model.is_empty() {
                return Err(
                    "schedule_tx model must not be empty; omit the field to inherit the model"
                        .into(),
                );
            }
            if !self.allowed_evaluation_models().contains(requested_model) {
                return Err(format!(
                    "model route '{requested_model}' is not authorized for the Agent by llm.allowed_evaluation_models"
                )
                .into());
            }
        }
        let session_id = CURRENT_SESSION_ID
            .try_with(Clone::clone)
            .map_err(|_| "schedule_tx is missing the current Session route")?;
        let context_id = CURRENT_CONTEXT_ID
            .try_with(Clone::clone)
            .map_err(|_| "schedule_tx is missing the current Context route")?;
        let attempt_id = CURRENT_ATTEMPT_ID
            .try_with(Clone::clone)
            .map_err(|_| "schedule_tx is missing the current Evaluation route")?;
        let route = CURRENT_CAUSAL_ROUTE
            .try_with(Clone::clone)
            .ok()
            .flatten()
            .ok_or("schedule_tx is missing the current Thread route")?;
        let session = self
            .sessions
            .get_session(&session_id)
            .await?
            .ok_or("Current schedule_tx Session does not exist")?;
        if session.context_id != context_id {
            return Err("schedule_tx Session and Context routes are inconsistent".into());
        }
        let control_count = args
            .operations
            .iter()
            .filter(|operation| operation.is_control())
            .count();
        if control_count > 0 {
            if args.group.is_some() {
                return Err("A Schedule control operation cannot include a group".into());
            }
            if control_count != 1 || args.operations.len() != 1 {
                return Err(
                    "A Schedule control operation must be submitted alone and cannot be mixed with create operations or other control operations".into(),
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
            .ok_or("Current schedule_tx Thread does not exist")?;
        let promotion_count = args
            .operations
            .iter()
            .filter(|operation| operation.is_promotion())
            .count();
        if promotion_count > 0 {
            if args.group.is_some() {
                return Err("Thread promotion atomically creates a new Objective Group and cannot also include group".into());
            }
            if promotion_count != 1 || args.operations.len() != 1 {
                return Err("promote must be submitted alone and cannot be mixed with create, control, or other promotion operations".into());
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
                    &route,
                    &current_thread,
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
                return Err("objective.mode=create can be used only with lifetime=durable".into());
            }
            let stated_objective = stated_objective.trim();
            let completion_criteria = completion_criteria.trim();
            if stated_objective.is_empty() || completion_criteria.is_empty() {
                return Err(
                    "objective.mode=create requires a non-empty objective and completion criteria"
                        .into(),
                );
            }
            let candidate = (
                stated_objective.to_string(),
                completion_criteria.to_string(),
                *token_budget,
            );
            if let Some(existing) = &create_spec {
                if existing != &candidate {
                    return Err(
                        "one schedule_tx can atomically create only one Objective; multiple spawn operations must reuse an identical create declaration"
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
                        return Err("schedule_tx.spawn.client_id must be non-empty and unique within the transaction".into());
                    }
                    local_refs.insert(client_id.clone(), thread_id.clone());
                }
                let mut supervision = match lifetime {
                    ThreadLifetime::Attached => {
                        if objective.is_some() {
                            return Err(
                                "lifetime=attached is supervised by the current parent Thread generation and cannot carry an objective"
                                    .into(),
                            );
                        }
                        ThreadSupervision::attached(
                            route.thread_id.clone(),
                            current_thread.generation,
                            route.activation_id.clone(),
                        )
                    }
                    ThreadLifetime::Durable => {
                        let binding = objective.as_ref().ok_or(
                            "lifetime=durable must explicitly bind objective=current or objective=existing",
                        )?;
                        let objective_id = match binding {
                            ScheduleObjectiveBinding::Current => {
                                CURRENT_OBJECTIVE_ID
                                    .try_with(Clone::clone)
                                    .ok()
                                    .flatten()
                                    .ok_or("Current Evaluation is not bound to an Objective, so objective.mode=current cannot be used")?
                            }
                            ScheduleObjectiveBinding::Existing { objective_id } => {
                                objective_id.trim().to_string()
                            }
                            ScheduleObjectiveBinding::Create { .. } => created_objective_id
                                .clone()
                                .ok_or("objective.mode=create is missing its prepared Objective")?,
                        };
                        if objective_id.is_empty() {
                            return Err("objective_id must not be empty".into());
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
                                "the current Runtime has no Objective Store configured and cannot create a durable Thread",
                            )?;
                            let objective =
                                objectives.get_objective(&objective_id).await?.ok_or_else(
                                    || format!("Objective '{}' does not exist", objective_id),
                                )?;
                            if objective.agent_id != session.agent_id
                                || objective.context_id != context_id
                                || objective.coordinator_session_id != session_id
                                || objective.status != ObjectiveStatus::Active
                            {
                                return Err(format!(
                                    "Objective '{}' is not an active Objective in the current Agent/Context/Session",
                                    objective_id
                                )
                                .into());
                            }
                            if objective.wait_condition.is_some() {
                                return Err(format!(
                                    "Objective '{}' already has a wait condition and cannot bind a new required Thread Group",
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
                                "lifetime=disposable is not supervised by an Objective and cannot carry an objective"
                                    .into(),
                            );
                        }
                        if completion.required {
                            return Err(
                                "a disposable Thread does not guarantee recovery or delivery, so completion.required must be false"
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
                return Err("group requires at least one spawned Thread".into());
            }
            let first = prepared_supervisions[spawn_indices[0]]
                .as_ref()
                .expect("spawn supervision")
                .clone();
            if first.lifetime == ThreadLifetime::Disposable {
                return Err("A disposable Thread cannot join a supervised Thread Group".into());
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
                        "members of the same Thread Group must have identical lifetime, supervisor, and generation; split them into multiple schedule_tx calls"
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
                        .ok_or("Supervised Thread Group is missing supervisor_id")?,
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
                        "Objective Group '{}' is missing the revision fence for existing Objective '{}'",
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
                status_reason: "waiting for the supervised execution Thread Group to complete"
                    .to_string(),
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
                return Err(
                    "objective.mode=create has no corresponding initial durable Thread".into(),
                );
            }
            let initial_wait_condition = if let Some(group) = group_plans.iter().find(|plan| {
                plan.group.supervisor_id == *objective_id
                    && plan.group.supervisor_kind == crate::memory::ThreadSupervisorKind::Objective
            }) {
                ObjectiveWaitCondition::ThreadGroup {
                    group_id: group.group.id.clone(),
                }
            } else {
                return Err("The initial Thread for a new Objective must belong to the same supervised Thread Group".into());
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
                status_reason: format!("waiting for the first supervised executions to complete; completion criteria: {completion_criteria}"),
                created_event,
            });
        }

        let mut intents = Vec::with_capacity(args.operations.len());
        for (index, operation) in args.operations.into_iter().enumerate() {
            let (
                target_thread_id,
                intent,
                model_alias,
                not_before,
                delay_seconds,
                interval_seconds,
                after,
            ) = match operation {
                ScheduleOperation::Enqueue {
                    thread_id,
                    intent,
                    model,
                    not_before,
                    delay_seconds,
                    after,
                } => (
                    thread_id.unwrap_or_else(|| route.thread_id.clone()),
                    intent,
                    model,
                    not_before,
                    delay_seconds,
                    None,
                    after,
                ),
                ScheduleOperation::Spawn {
                    intent,
                    model,
                    not_before,
                    delay_seconds,
                    every_seconds,
                    after,
                    ..
                } => (
                    prepared[index].clone(),
                    intent,
                    model,
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
                return Err("Provide only one of not_before and delay_seconds".into());
            }
            let waits_for_future = not_before.is_some()
                || delay_seconds.is_some_and(|seconds| seconds > 0)
                || !after.is_empty();
            if target_thread_id == route.thread_id
                && current_thread.kind == ThreadKind::DialogueTurn
                && waits_for_future
            {
                return Err("A DialogueTurn Thread cannot suspend while waiting for a future time or dependency; use spawn to create an independent Execution Thread, then report the scheduling result to the current Session".into());
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
                    return Err("A Thread cannot depend on itself".into());
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
                model_alias: model_alias.map(|model| model.trim().to_string()),
                not_before,
                interval_seconds,
                dependency_thread_ids: dependencies,
            });
        }
        for intent in &intents {
            for dependency_id in &intent.dependency_thread_ids {
                let newly_created = threads.iter().any(|thread| thread.id == *dependency_id);
                if !newly_created && self.sessions.get_thread(dependency_id).await?.is_none() {
                    return Err(
                        format!("Dependency Thread '{dependency_id}' does not exist").into(),
                    );
                }
            }
        }
        let mut records = if let Some(kernel) = &self.kernel {
            match kernel
                .execute(crate::controllers::PlanController::spawn_supervised_group(
                    SpawnSupervisedGroupCommand {
                        objectives: scheduled_objectives.clone(),
                        objective_waits: objective_waits.clone(),
                        threads: threads.clone(),
                        schedules: intents.clone(),
                        groups: group_plans.clone(),
                    },
                    &route.trigger_event_id,
                    &route.root_turn_id,
                    "Agent-Morphz",
                ))
                .await?
            {
                KernelResult::SupervisedGroupSpawned { schedules } => schedules,
                _ => {
                    return Err(
                        "Scheduler Kernel returned an invalid schedule-transaction result".into(),
                    )
                }
            }
        } else {
            // Narrow unit fixtures may still construct ScheduleTxTool around a
            // SessionStore. Production Runtime never takes this bridge.
            self.sessions
                .commit_schedule_transaction(
                    &scheduled_objectives,
                    &objective_waits,
                    &threads,
                    &intents,
                    &group_plans,
                )
                .await?
        };
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
        let mut client_receipts = local_refs
            .iter()
            .map(|(client_id, thread_id)| {
                let schedule_id = records
                    .iter()
                    .find(|record| record.thread_id == *thread_id)
                    .map(|record| record.id.clone());
                serde_json::json!({
                    "client_id": client_id,
                    "thread_id": thread_id,
                    "schedule_id": schedule_id,
                })
            })
            .collect::<Vec<_>>();
        client_receipts
            .sort_by(|left, right| left["client_id"].as_str().cmp(&right["client_id"].as_str()));
        Ok(crate::local_time::localized_runtime_json(serde_json::json!({
            "status": "committed",
            "operations": records,
            "client_receipts": client_receipts,
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
                "The scheduling plan was persisted atomically. A durable Thread's terminal state will wake its bound Objective; a disposable Thread does not guarantee recovery or delivery."
            } else {
                "The scheduling plan and Thread Group were persisted atomically. The Group emits one barrier when its all/any condition is reached; attached wakes the parent Thread and durable wakes its bound Objective."
            }
        }))
        .to_string())
    }
}

fn validate_schedule_intent(intent: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if intent.trim().is_empty() {
        return Err("schedule_tx intent must not be empty".into());
    }
    if intent.chars().count() > MAX_SCHEDULE_INTENT_CHARS {
        return Err(
            format!("schedule_tx intent exceeds {MAX_SCHEDULE_INTENT_CHARS} characters").into(),
        );
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
                .map_err(|error| format!("not_before is not a valid RFC 3339 timestamp: {error}"))?
                .with_timezone(&chrono::Utc),
        ));
    }
    Ok(delay_seconds.map(|seconds| {
        chrono::Utc::now() + chrono::Duration::seconds(i64::try_from(seconds).unwrap_or(i64::MAX))
    }))
}

pub(crate) fn scheduled_occurrence_root(intent_id: &str, revision: u64) -> String {
    let digest = sha256_hex(format!("{intent_id}\0{revision}").as_bytes());
    format!("scheduled_occurrence_{}", &digest[..24])
}

// ==========================================
// Production-grade background long-running task supervision.
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

/// Ask the process-local physical owner to terminate one background process.
/// A missing entry means this Runtime is only a durable control-plane peer;
/// callers must keep the cancellation request rather than guessing success.
fn terminate_local_background_process(task_id: &str) -> Result<Option<(i32, bool)>, String> {
    let Some(process_group_id) = get_tasks_map().get(task_id).map(|task| task.pgid) else {
        return Ok(None);
    };
    if let Some(mut task) = get_tasks_map().get_mut(task_id) {
        task.status = BackgroundTaskStatus::KillRequested;
        task.wake_generation = task.wake_generation.wrapping_add(1);
        task.next_wakeup_at = None;
    }
    match nix::sys::signal::killpg(
        nix::unistd::Pid::from_raw(process_group_id),
        nix::sys::signal::Signal::SIGKILL,
    ) {
        Ok(()) => Ok(Some((process_group_id, true))),
        Err(nix::errno::Errno::ESRCH) => Ok(Some((process_group_id, false))),
        Err(error) => Err(format!(
            "force-killing process group {process_group_id} encountered a system error: {error:?}; the cancellation request remains persisted"
        )),
    }
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
    crate::local_time::localized_runtime_json(serde_json::json!({
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
    }))
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
    crate::local_time::localized_runtime_json(serde_json::json!({
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
        "next_wakeup_at": job.checkpoint_due_at,
        "checkpoint_generation": job.checkpoint_generation,
        "checkpoint_due_at": job.checkpoint_due_at,
        "exit_code": job.exit_code,
        "error": job.error,
        "cancel_reason": job.cancel_reason,
        "effective_boundary": job.request.get("effective_boundary"),
        "artifact_path": job.request.get("artifact_path"),
        "result_refs": job.result_refs,
        "live_owner": live.is_some(),
    }))
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
        "(task has not produced output yet)".to_string()
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
        "The checkpoint for background task {} at {} seconds has been reached; the task is still running and the Runtime did not terminate it.\n--- Recent output ---\n{}\n\nDecide how to proceed: call check_task_after if there is a specific next-check deadline; otherwise continue relying on the completion event to wake you; call kill_task if it should not continue.",
        task.id, check_after_secs, output_tail
    )));
    extend_causal_route(&mut payload, task.causal_route.as_ref());
    payload
}

fn background_check_due_payload_from_job(
    job: &ExecutionJobRecord,
    check_after_secs: u64,
    wake_source: &str,
) -> serde_json::Map<String, serde_json::Value> {
    let started_at = job
        .request
        .get("started_at")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&chrono::Utc))
        .or(job.started_at)
        .unwrap_or(job.created_at);
    let task_status = if job.cancel_requested_at.is_some() {
        "cancel_requested"
    } else {
        job.status.as_str()
    };
    let mut payload = serde_json::Map::from_iter([
        ("context_id".to_string(), serde_json::json!(job.context_id)),
        ("session_id".to_string(), serde_json::json!(job.session_id)),
        ("thread_id".to_string(), serde_json::json!(job.thread_id)),
        (
            "activation_id".to_string(),
            serde_json::json!(job.activation_id),
        ),
        ("tool_name".to_string(), serde_json::json!("check_task_after")),
        ("task_id".to_string(), serde_json::json!(job.id)),
        (
            "event".to_string(),
            serde_json::json!("background_task_check_due"),
        ),
        (
            "legacy_event".to_string(),
            serde_json::json!("background_task_wait_elapsed"),
        ),
        ("wake_source".to_string(), serde_json::json!(wake_source)),
        (
            "check_after_secs".to_string(),
            serde_json::json!(check_after_secs),
        ),
        ("wait_secs".to_string(), serde_json::json!(check_after_secs)),
        (
            "elapsed_secs".to_string(),
            serde_json::json!((chrono::Utc::now() - started_at).num_seconds().max(0)),
        ),
        ("task_status".to_string(), serde_json::json!(task_status)),
        ("last_output_age_secs".to_string(), serde_json::Value::Null),
        ("output_bytes".to_string(), serde_json::Value::Null),
        ("live_owner".to_string(), serde_json::json!(false)),
        (
            "artifact_path".to_string(),
            job.request
                .get("artifact_path")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
        ),
        (
            "effective_boundary".to_string(),
            job.request
                .get("effective_boundary")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({})),
        ),
        (
            "text".to_string(),
            serde_json::json!(format!(
                "The checkpoint for background task {} at {} seconds has been reached; another Runtime instance owns the task, so this scheduler has neither its in-process output buffer nor authority to terminate it. Use read_task to read persisted state; call check_task_after if there is a specific next-check deadline; call kill_task if it should not continue.",
                job.id, check_after_secs
            )),
        ),
    ]);
    if let Some(principal_id) = &job.initiating_principal_id {
        payload.insert("principal_id".to_string(), serde_json::json!(principal_id));
    }
    payload
}

// Shared live output-pipeline buffer.
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
            tracing::error!(event_code = "tool.exec_archive.write_failed", archive = %self.archive_path, %error, "Failed to write the raw exec-output archive");
        }
        {
            let mut guard = match self.output.lock() {
                Ok(guard) => guard,
                Err(poisoned) => {
                    tracing::error!(
                        event_code = "tool.execution_buffer.mutex_poisoned",
                        "ExecutionBuffer Mutex poisoned, recovering"
                    );
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
                "[This event merged {total_chars} characters and shows only the final {} characters; see {} for the complete output]\n{tail}",
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
                tracing::error!(
                    event_code = "tool.execution_buffer.get_all_mutex_poisoned",
                    "ExecutionBuffer Mutex poisoned in get_all, recovering"
                );
                poisoned.into_inner()
            }
        };
        if self.truncated.load(Ordering::Relaxed) {
            format!(
                "[Context preview was truncated at the buffer limit; complete raw output: {}]\n{}",
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

const EXEC_OUTPUT_DRAIN_TIMEOUT: tokio::time::Duration = tokio::time::Duration::from_secs(1);

async fn drain_exec_output_monitors(
    stdout_task: &mut tokio::task::JoinHandle<()>,
    stderr_task: &mut tokio::task::JoinHandle<()>,
    timeout: tokio::time::Duration,
) -> bool {
    let drained = tokio::time::timeout(timeout, async {
        let _ = (&mut *stdout_task).await;
        let _ = (&mut *stderr_task).await;
    })
    .await
    .is_ok();
    if !drained {
        stdout_task.abort();
        stderr_task.abort();
        let _ = stdout_task.await;
        let _ = stderr_task.await;
    }
    drained
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
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        format!(
            "Failed to read file metadata '{}': {}",
            path.display(),
            error
        )
    })?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "direct modification of symlink '{}' is prohibited because atomic replacement would change symlink semantics",
            path.display()
        ));
    }
    if !metadata.is_file() {
        return Err(format!("'{}' is not a regular file", path.display()));
    }
    let bytes = std::fs::read(path)
        .map_err(|error| format!("Failed to read file '{}': {}", path.display(), error))?;
    let content = String::from_utf8(bytes.clone())
        .map_err(|_| format!("File '{}' is not UTF-8 text", path.display()))?;
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
        .ok_or_else(|| format!("Write path '{}' has no parent directory", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Failed to create directory '{}': {}",
            parent.display(),
            error
        )
    })?;
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
                    "failed to create atomic-write temporary file '{}': {}",
                    temp_path.display(),
                    error
                )
            })?;
        file.write_all(content.as_bytes())
            .map_err(|error| format!("Failed to write temporary file: {}", error))?;
        if let Some(permissions) = permissions {
            file.set_permissions(permissions)
                .map_err(|error| format!("Failed to preserve file permissions: {}", error))?;
        }
        file.sync_all()
            .map_err(|error| format!("Failed to sync temporary file: {}", error))?;
        drop(file);
        std::fs::rename(&temp_path, path).map_err(|error| {
            format!(
                "atomic replacement '{}' -> '{}' failed: {}",
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
        "{}\n...[diff truncated; original length {} characters]",
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
                "File change committed: operation={} path={} sha256={}\n{}",
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
// 1. WriteFileTool: production-grade path and permission handling.
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
                    "description": "Path of the file to write, for example test.txt"
                },
                "content": {
                    "type": "string",
                    "description": "Text content to write"
                },
                "mode": {
                    "type": "string",
                    "enum": ["create", "overwrite"],
                    "description": "create permits only a new file; overwrite permits only an existing file and requires expected_sha256"
                },
                "expected_sha256": {
                    "type": "string",
                    "description": "Required for overwrite and must equal the SHA-256 from the latest read; mismatch rejects the write"
                }
            },
            "required": ["path", "content", "mode"]
        });

        ToolDefinition {
            name: "write".to_string(),
            description: "Atomically create or explicitly overwrite a UTF-8 text file. Prefer edit for existing code. overwrite requires expected_sha256 from read to prevent clobbering concurrent changes. Success returns diff/hash and creates a file_change observation.".to_string(),
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
            Err(error) => {
                return Ok(format!(
                    "System error: the permission policy rejected the write path: {error}"
                ))
            }
        };

        let (operation, before_content, before_sha256, before_bytes, permissions) = match args
            .mode
            .as_str()
        {
            "create" => {
                if absolute_path.exists() {
                    return Err(format!(
                        "create refuses to overwrite existing file '{}'; read it first, then use edit or overwrite",
                        args.path
                    )
                    .into());
                }
                ("create", String::new(), None, 0, None)
            }
            "overwrite" => {
                if !absolute_path.exists() {
                    return Err(format!(
                        "overwrite target '{}' does not exist; use mode=create for a new file",
                        args.path
                    )
                    .into());
                }
                let snapshot = read_text_snapshot(&absolute_path)?;
                let expected = args
                    .expected_sha256
                    .as_deref()
                    .ok_or("overwrite requires expected_sha256 from the most recent read")?;
                if expected != snapshot.sha256 {
                    return Err(format!(
                            "File version conflict: '{}' currently has sha256={}, but expected_sha256={}. Read it again before modifying it",
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
                return Err(format!(
                    "write.mode supports only create or overwrite; received '{other}'"
                )
                .into())
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
            "File write succeeded: operation={} path={} bytes={} sha256={}\n{}",
            operation,
            args.path,
            args.content.len(),
            after_sha256,
            bounded_text(&diff, 8_000)
        ))
    }
}

// ==========================================
// 2. ReadFileTool: production-grade path and permission handling.
// ==========================================
pub struct ReadFileTool {
    permissions: Arc<PermissionBroker>,
    max_model_input_attachment_bytes: usize,
}

impl ReadFileTool {
    pub fn new(config: Arc<PermissionConfig>) -> Self {
        Self {
            permissions: broker_from_config(config),
            max_model_input_attachment_bytes: crate::config::ModelInputConfig::default()
                .max_artifact_bytes,
        }
    }

    pub fn new_with_permissions(permissions: Arc<PermissionBroker>) -> Self {
        Self::new_with_permissions_and_limit(
            permissions,
            crate::config::ModelInputConfig::default().max_artifact_bytes,
        )
    }

    pub fn new_with_permissions_and_limit(
        permissions: Arc<PermissionBroker>,
        max_model_input_attachment_bytes: usize,
    ) -> Self {
        Self {
            permissions,
            max_model_input_attachment_bytes: max_model_input_attachment_bytes.max(1),
        }
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

    fn max_model_input_attachment_bytes(&self) -> Option<usize> {
        Some(self.max_model_input_attachment_bytes)
    }

    fn definition(&self) -> ToolDefinition {
        let params_json = serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path of the file to read, for example test.txt"
                },
                "start_line": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Optional 1-based start line; combine with end_line for an exact range"
                },
                "end_line": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Optional 1-based inclusive end line"
                },
                "query": {
                    "type": "string",
                    "description": "Optional case-insensitive literal query that returns line-numbered matching context; prefer it for implementation verification to avoid rereading the whole file or calling grep"
                },
                "context_lines": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 20,
                    "description": "Context lines before and after each query match; default 3"
                },
                "max_matches": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 100,
                    "description": "Maximum query matches to show; default 20"
                }
            },
            "required": ["path"]
        });

        ToolDefinition {
            name: "read".to_string(),
            description: "Read a file from the current Execution Target. UTF-8 text returns content plus byte count and SHA-256 for later edit/overwrite. JPEG, PNG, GIF, and WebP return a model-visible image attachment; do not pass line/query options for images. For a short text file pass only path. For a long text file use query for narrow line-numbered evidence or start_line/end_line for exact paging."
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
        self.execute_result(arguments)
            .await?
            .encode_transport()
            .map_err(Into::into)
    }

    async fn execute_result(
        &self,
        arguments: &str,
    ) -> Result<Box<ToolExecutionResult>, Box<dyn std::error::Error + Send + Sync>> {
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
            Err(e) => {
                return Ok(ToolExecutionResult::text(format!(
                    "System error: the permission policy rejected the read path: {e}"
                )))
            }
        };

        if !absolute_path.exists() {
            return Ok(ToolExecutionResult::text(format!(
                "System error: read failed because file path '{}' does not exist; verify the path.",
                args.path
            )));
        }

        // Sniff a bounded header before allocating the whole file. The exact
        // byte check below remains authoritative if the file changes between
        // metadata and read, but an obviously oversized image must not first
        // consume unbounded memory merely so Runtime can reject it.
        if let Ok(metadata) = tokio::fs::metadata(&absolute_path).await {
            if usize::try_from(metadata.len()).unwrap_or(usize::MAX)
                > self.max_model_input_attachment_bytes
            {
                use tokio::io::AsyncReadExt as _;
                if let Ok(mut file) = tokio::fs::File::open(&absolute_path).await {
                    let mut header = [0_u8; 12];
                    let bytes_read = file.read(&mut header).await.unwrap_or_default();
                    if supported_image_media_type(&header[..bytes_read]).is_some() {
                        return Err(format!(
                            "Image '{}' is {} bytes, exceeding the current per-file model-input limit of {} bytes",
                            args.path,
                            metadata.len(),
                            self.max_model_input_attachment_bytes,
                        )
                        .into());
                    }
                }
            }
        }

        let data = match tokio::fs::read(&absolute_path).await {
            Ok(data) => data,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                return Ok(ToolExecutionResult::text(format!(
                    "System error: permission denied while reading file '{}'; check the operating-system permissions or use a readable path.",
                    absolute_path.display()
                )))
            }
            Err(error) => {
                return Ok(ToolExecutionResult::text(format!(
                    "System error: failed to read file '{}': {:?}",
                    absolute_path.display(),
                    error
                )))
            }
        };
        let sha256 = sha256_hex(&data);
        if let Some(media_type) = supported_image_media_type(&data) {
            if args.start_line.is_some()
                || args.end_line.is_some()
                || args.query.is_some()
                || args.context_lines.is_some()
                || args.max_matches.is_some()
            {
                return Err("Image reads cannot use start_line, end_line, query, context_lines, or max_matches; pass only path".into());
            }
            if data.len() > self.max_model_input_attachment_bytes {
                return Err(format!(
                    "Image '{}' is {} bytes, exceeding the current per-file model-input limit of {} bytes",
                    args.path,
                    data.len(),
                    self.max_model_input_attachment_bytes,
                )
                .into());
            }
            let name = absolute_path
                .file_name()
                .and_then(|value| value.to_str())
                .filter(|value| !value.is_empty())
                .unwrap_or("image")
                .to_string();
            let text = serde_json::json!({
                "kind": "model_visible_artifact",
                "status": "loaded",
                "path": args.path,
                "name": name.clone(),
                "media_type": media_type,
                "size_bytes": data.len(),
                "sha256": sha256,
            })
            .to_string();
            return Ok(ToolExecutionResult::with_attachments(
                text,
                vec![ModelAttachment {
                    name,
                    media_type: media_type.to_string(),
                    data_base64: base64::engine::general_purpose::STANDARD.encode(data),
                }],
            ));
        }

        let content = String::from_utf8(data).map_err(|_| {
            format!(
                "file '{}' is neither UTF-8 text nor a supported JPEG, PNG, GIF, or WebP image",
                args.path
            )
        })?;
        let header = format!(
            "[path={}, bytes={}, sha256={}]\n",
            args.path,
            content.len(),
            sha256
        );
        if args.query.is_none() && args.start_line.is_none() && args.end_line.is_none() {
            return Ok(ToolExecutionResult::text(format!("{}{}", header, content)));
        }
        Ok(ToolExecutionResult::text(format!(
            "{}{}",
            header,
            select_file_lines(&content, &args)?
        )))
    }
}

fn supported_image_media_type(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if data.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
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
            "invalid line range: start_line={}, end_line={}, file has {} lines",
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
            return Err("query must not be empty".into());
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
// 3. EditFileTool: precise local edits with version preconditions.
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
            description: "Perform exact text replacements in a previously read UTF-8 file under a SHA-256 version precondition. By default old_text must match exactly once; set replace_all=true explicitly to replace every match. All edits are validated before one atomic commit. Success returns diff/hash and creates a file_change observation.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Existing text file in the workspace" },
                    "expected_sha256": { "type": "string", "description": "Complete SHA-256 returned by the latest read" },
                    "edits": {
                        "type": "array",
                        "minItems": 1,
                        "items": {
                            "type": "object",
                            "properties": {
                                "old_text": { "type": "string", "minLength": 1, "description": "Text that must occur exactly in the original file" },
                                "new_text": { "type": "string", "description": "Replacement text; an empty string deletes the match" },
                                "replace_all": { "type": "boolean", "default": false, "description": "When false old_text must be unique; when true replace every match" }
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
            return Err("edit.edits requires at least one item".into());
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
                "file version conflict: '{}' currently has sha256={}, expected_sha256={}. Read it again before editing",
                args.path, snapshot.sha256, args.expected_sha256
            )
            .into());
        }

        let mut replacements = Vec::new();
        for (index, edit) in args.edits.iter().enumerate() {
            if edit.old_text.is_empty() {
                return Err(format!("edit.edits[{index}].old_text must not be empty").into());
            }
            let matches = snapshot
                .content
                .match_indices(&edit.old_text)
                .map(|(start, _)| start)
                .collect::<Vec<_>>();
            if matches.is_empty() {
                return Err(format!(
                    "edit.edits[{index}].old_text has no exact match in '{}'; read the file again and include more context",
                    args.path
                )
                .into());
            }
            if !edit.replace_all && matches.len() != 1 {
                return Err(format!(
                    "edit.edits[{index}].old_text matches {} times; edits require a unique match by default. Include more context in old_text or explicitly set replace_all=true",
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
                return Err("Two replacement ranges in edit overlap; merge them into one larger exact replacement".into());
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
            return Err("edit produced no content change".into());
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
            "File edit succeeded: path={} replacements={} bytes={} sha256={}\n{}",
            args.path,
            replacements.len(),
            updated.len(),
            after_sha256,
            bounded_text(&diff, 8_000)
        ))
    }
}

// ==========================================
// 4. ListFilesTool / SearchTool: structured code discovery.
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
            description: "Recursively discover files inside directories allowed by the current Permission Profile. Supports glob, result limits, and hidden-file control. Use for code navigation instead of uncontrolled exec/ls/find output.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "default": ".", "description": "Search root directory" },
                    "glob": { "type": "string", "default": "**/*", "description": "Glob relative to path, for example **/*.rs" },
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
            return Err(format!("list_files.path '{}' is not a directory", args.path).into());
        }
        let pattern = Pattern::new(&args.glob)
            .map_err(|error| format!("Invalid glob '{}': {}", args.glob, error))?;
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
            description: "Run a size-bounded literal text search over UTF-8 source files inside directories allowed by the current Permission Profile. Returns paths, line numbers, and context. Use for code location instead of exec/rg/grep.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "minLength": 1, "description": "Literal search text, not a regular expression" },
                    "paths": { "type": "array", "minItems": 1, "items": { "type": "string" }, "description": "List of files or directories" },
                    "glob": { "type": "string", "default": "**/*", "description": "File filter within directories, for example **/*.rs" },
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
            return Err("search.paths requires at least one path".into());
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
                "the search tool requires access to a path outside its boundary: {}",
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
            return Err("search.query must not be empty".into());
        }
        if args.paths.is_empty() {
            return Err("search.paths requires at least one path".into());
        }
        let pattern = Pattern::new(&args.glob)
            .map_err(|error| format!("Invalid glob '{}': {}", args.glob, error))?;
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
                return Err(format!("Search path '{}' does not exist", input).into());
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
// 5. ExecuteCommandTool: asynchronous detach and process-group termination.
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
                "the current ExecuteCommandTool has no approval provider configured",
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
            .unwrap_or_else(|error| panic!("invalid PermissionConfig: {error}"));
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
                .expect("Failed to initialize the default Secret Store metadata catalog"),
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
                    "secret_env '{}' does not exist in the Secret Store or Runtime bootstrap environment",
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
            return Err(
                format!("secret_env contains invalid environment-variable name '{name}'").into(),
            );
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
                format!(
                    "Failed to resolve current sandbox permission directory '{}': {error}",
                    root.display()
                )
                .into()
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
            "exec prohibits using shell '&' to create an unmanaged background process. Run the command in the foreground; after wait_ms the Runtime will move it to the background automatically and return a task_id."
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
        Err(error) => Err(format!("Failed to inspect residual exec process group: {error}").into()),
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
        return "The current Permission Profile does not allow requesting additional capabilities; do not retry.".to_string();
    }
    let network = if network_enabled {
        "Network access is enabled; do not misclassify ordinary network-service errors as sandbox denials."
    } else {
        "Network access is disabled."
    };
    format!(
        "{network} Retry the same necessary command once with sandbox_permissions=require_escalated only when stderr or other evidence clearly shows that the failure was caused by missing network access, an out-of-boundary directory, or a secret environment variable. List only the minimum capabilities in requested_permissions and provide a justification. protected_paths and approval denials cannot be overridden."
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
                    "description": "Foreground Shell command to run in the terminal, for example 'cargo test' or 'ls'. Inject secrets by environment-variable name through requested_permissions.secret_env. Do not background a command with '&'."
                },
                "cwd": {
                    "type": "string",
                    "description": "Optional command working directory; defaults to workspace_root. An out-of-bound directory requires minimal permissions through require_escalated."
                },
                "wait_ms": {
                    "type": "integer",
                    "description": "Maximum milliseconds to wait synchronously for output. Default 10000; a longer test or build automatically transitions to managed background execution."
                },
                "keep_running": {
                    "type": "boolean",
                    "description": "Default false. Set true only for a persistent service such as a dev server, watcher, or backend that should outlive this turn; the Runtime then does not block turn completion on it. Keep false for builds, tests, and scripts that eventually exit and whose result is needed in this turn."
                },
                "sandbox_permissions": {
                    "type": "string",
                    "enum": ["use_default", "require_escalated"],
                    "description": "Default use_default runs in the current native sandbox. If the receipt and stderr explicitly prove failure due to missing network, out-of-bound path, or secret environment access, and that capability is required, retry the same necessary command once with require_escalated. Do not retry ordinary errors, protected_paths, or approval denials blindly."
                },
                "requested_permissions": {
                    "type": "object",
                    "description": "Minimal additional capabilities requested with require_escalated. Approval applies only to this exact command and cannot disable the sandbox.",
                    "properties": {
                        "network": {
                            "type": "boolean",
                            "description": "Whether this command requests network access."
                        },
                        "read_paths": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Additional read-only directories; relative paths resolve from workspace_root."
                        },
                        "write_paths": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Additional writable directories; relative paths resolve from workspace_root."
                        },
                        "secret_env": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Names of sensitive environment variables to inject into this child process. Pass names only, never values in command; one-time approval is required."
                        }
                    },
                    "additionalProperties": false
                },
                "justification": {
                    "type": "string",
                    "description": "Required with require_escalated: explain the direct relationship between the additional capability and the current user task."
                }
            },
            "required": ["command"]
        });

        ToolDefinition {
            name: "exec".to_string(),
            description: "Run a Shell command in the operating system's native sandbox, which by default permits configured workspace paths and denies network. Suitable for tests, builds, and formatting. Prefer list_files/search for discovery and edit/write for changes. Do not call ssh/scp/sftp directly on a local Target; resolve a managed_ssh Target and pass its ID as target so the Runtime manages the connection. Bind Managed SSH password aliases through resolve_target rather than requesting them as exec environment variables. When other network, path, or secret environment capabilities are truly needed, request the minimum through require_escalated for independent review. A boundary rejection receipt explains how to request it. After the wait timeout the Runtime manages the command in the background. Never create an unmanaged background process with '&'.".to_string(),
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
                "exec.cwd '{}' matches a protected_paths rule that cannot be overridden",
                cwd_input
            )
            .into());
        }
        if !resolved_cwd.candidate.is_dir() {
            return Err(format!("exec.cwd '{}' is not an existing directory", cwd_input).into());
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
                "requested_permissions can be used only with sandbox_permissions=require_escalated"
                    .into(),
            ),
            SandboxPermissionMode::RequireEscalated if !requested.is_empty() => {
                let justification = args
                    .justification
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or("require_escalated requires a non-empty justification")?;
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
                "exec.cwd '{}' matches a protected_paths rule that cannot be overridden",
                cwd_input
            )
            .into());
        }
        let exec_cwd = resolved_cwd.candidate;
        if !exec_cwd.is_dir() {
            return Err(format!("exec.cwd '{}' is not an existing directory", cwd_input).into());
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
            if !crate::execution_target::is_prepared_managed_ssh_exec_command(cmd_trimmed)
                || !args.requested_permissions.network
                || !args.requested_permissions.write_paths.is_empty()
                || args.sandbox_permissions != SandboxPermissionMode::RequireEscalated
            {
                return Err(
                    "Runtime Managed SSH authority allows only internally generated ssh commands and fixed network/Target-bound credential capabilities"
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
                    return Err("requested_permissions can be used only with sandbox_permissions=require_escalated".into());
                }
                SandboxPermissionMode::RequireEscalated if !requested.is_empty() => {
                    let justification = args
                        .justification
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .ok_or("require_escalated requires a non-empty justification")?;
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
            event_code = "tool.exec_boundary.prepared",
            "Prepared the operating-system execution boundary for exec"
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
        let secrets_to_inject =
            executable_secret_aliases(runtime_managed_ssh, &approved_secret_env);
        let resolved_secret_env =
            tokio::task::spawn_blocking(move || -> Result<Vec<(String, String)>, String> {
                secrets_to_inject
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
                            .ok_or_else(|| {
                                format!("secret_env '{}' does not exist in Runtime", name)
                            })?;
                        Ok((name, value))
                    })
                    .collect()
            })
            .await
            .map_err(|error| {
                format!("Secret Store blocking task terminated unexpectedly: {error}")
            })??;
        let mut injected_secret_values = Vec::with_capacity(resolved_secret_env.len());
        for (name, value) in resolved_secret_env {
            cmd.env(&name, &value);
            injected_secret_values.push(value);
        }

        let artifact_dir = std::path::PathBuf::from(&self.background_config.artifact_dir);
        std::fs::create_dir_all(&artifact_dir).map_err(|error| {
            format!(
                "failed to create exec raw-output archive directory '{}': {}",
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
        let pid = child.id().ok_or("Failed to obtain process ID")? as i32;
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
                    "failed to create exec raw-output archive '{}': {}",
                    archive_path.display(),
                    error
                )
                .into());
            }
        };

        let stdout = child.stdout.take().ok_or("Failed to capture stdout pipe")?;
        let stderr = child.stderr.take().ok_or("Failed to capture stderr pipe")?;

        let bus_clone = Arc::clone(&self.bus);
        let session_id_clone = session_id.clone();
        let context_id_clone = context_id.clone();
        let task_id_clone = task_id.clone();

        // Shared buffer.
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

        // Shared event-publication flag. Output remains synchronous and unpublished for the first N
        // seconds; publication starts only after the process detaches.
        let publish_flag = Arc::new(AtomicBool::new(false));
        let output_sink = CURRENT_TOOL_OUTPUT_SINK
            .try_with(Clone::clone)
            .ok()
            .flatten();

        let buffer_out = Arc::clone(&buffer);
        let publish_out = Arc::clone(&publish_flag);
        let stdout_sink = output_sink.clone();
        let mut stdout_task = tokio::spawn(async move {
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
        let mut stderr_task = tokio::spawn(async move {
            monitor_pipe(
                stderr,
                buffer_err,
                publish_err,
                EdgeOutputStream::Stderr,
                output_sink,
            )
            .await;
        });

        // Wait synchronously for the configured interval.
        let requested_wait = tokio::time::Duration::from_millis(args.wait_ms.unwrap_or(10_000));
        let remaining_sync_budget = self
            .max_sync_wait
            .saturating_sub(sync_budget_started_at.elapsed());
        let wait_duration = requested_wait.min(remaining_sync_budget);
        let wait_result = tokio::time::timeout(wait_duration, child.wait()).await;

        match wait_result {
            Ok(exit_status_res) => {
                // The command completed within the synchronous interval.
                tasks.remove(&task_id);
                process_group_guard.disarm();
                // `/bin/sh -c 'command &'` can exit while descendants keep running. The lexical
                // guard above catches normal cases; this process-group check is the fail-closed
                // backstop for dynamically constructed shell commands.
                let residual_processes_terminated = terminate_residual_process_group(pid)?;
                // Process exit does not imply asynchronous pipe readers have drained their kernel
                // pipes. Wait for both readers before loading the preview so artifacts and returned
                // results include trailing output.
                let output_drained = drain_exec_output_monitors(
                    &mut stdout_task,
                    &mut stderr_task,
                    EXEC_OUTPUT_DRAIN_TIMEOUT,
                )
                .await;
                let code = exit_status_res
                    .map(|s| s.code().unwrap_or(-1))
                    .unwrap_or(-1);
                let output_str = buffer.get_all();
                let boundary_remediation = (code != 0)
                    .then(|| boundary_remediation(permission_request_available, effective_network));
                if residual_processes_terminated {
                    return Err(format!(
                        "exec detected child processes still alive after the shell process exited and terminated the entire remaining process group. Self-backgrounding is prohibited; let the foreground command run past wait_ms so the Runtime can manage it.\n--- Captured output ---\n{output_str}"
                    )
                    .into());
                }
                if !output_drained {
                    return Err(format!(
                        "exec shell exited but inherited output pipes remained open. A detached descendant escaped the managed process group; self-daemonizing commands are prohibited because their completion cannot be tracked safely. Run the service in the foreground and let wait_ms hand it off to the Runtime.\n--- Captured output ---\n{output_str}"
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
                // The synchronous interval elapsed; detach as a background long-running task.
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
                            let _ = drain_exec_output_monitors(
                                &mut stdout_task,
                                &mut stderr_task,
                                EXEC_OUTPUT_DRAIN_TIMEOUT,
                            )
                            .await;
                            tasks.remove(&task_id);
                            return Err(format!(
                                "background process could not be handed off to a persistent ExecutionJob, so its process group was terminated: {error}"
                            )
                            .into());
                        }
                    }
                }
                publish_flag.store(true, Ordering::SeqCst);
                if let Some(mut task) = tasks.get_mut(&task_id) {
                    task.status = BackgroundTaskStatus::Running;
                }

                // An optional watchdog checkpoint wakes the LLM but never kills automatically. It is
                // disabled by default; the normal path relies only on task-completion Events. When
                // the agent has an explicit supervision deadline, `check_task_after` can override
                // the next check time, or `kill_task` can terminate the task.
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

                // Start a background coroutine that removes the map entry on final process exit and
                // publishes a completion Event for the model.
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
                    let output_drained = drain_exec_output_monitors(
                        &mut stdout_task,
                        &mut stderr_task,
                        EXEC_OUTPUT_DRAIN_TIMEOUT,
                    )
                    .await;
                    buffer_cleanup.flush_pending_now().await;
                    let tasks_cleanup = get_tasks_map();

                    let code = if output_drained {
                        wait_res.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1)
                    } else {
                        -1
                    };
                    let output_str = buffer_cleanup.get_all();
                    let residual_note = if !output_drained {
                        "\n[Runtime stopped waiting for inherited output pipes after the managed shell exited. A self-daemonized descendant escaped the managed process group, so this execution was failed instead of leaving its Activation permanently running.]"
                    } else {
                        match residual_cleanup {
                        Ok(true) => "\n[Runtime terminated an unmanaged child process group left after the shell exited. Do not self-background processes in exec commands.]",
                        Ok(false) => "",
                        Err(_) => "\n[Runtime could not confirm that the process group was fully cleaned up after the shell exited.]",
                        }
                    };
                    if let Some(scheduler) = &background_scheduler_cleanup {
                        if scheduler.execution_jobs.is_some() {
                            let scheduler_for_commit = Arc::clone(scheduler);
                            let retry_task_id = task_id_cleanup.clone();
                            let retry_output = Arc::<str>::from(output_str);
                            let retry_residual_note = Arc::<str>::from(residual_note);
                            retry_background_terminal_commit(
                                &task_id_cleanup,
                                BACKGROUND_TERMINAL_COMMIT_RETRY_INITIAL,
                                move || {
                                    let scheduler = Arc::clone(&scheduler_for_commit);
                                    let task_id = retry_task_id.clone();
                                    let output = Arc::clone(&retry_output);
                                    let residual_note = Arc::clone(&retry_residual_note);
                                    async move {
                                        scheduler
                                            .finish_background_execution(
                                                &task_id,
                                                code,
                                                output.as_ref(),
                                                residual_note.as_ref(),
                                            )
                                            .await
                                    }
                                },
                            )
                            .await;
                            scheduler.cancel(&task_id_cleanup).await;
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
                            "\n[Background task {} finished with exit code {}]{}\n--- Output ---\n{}",
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

                let elapsed_str = format!("{} ms", wait_duration.as_millis());

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
                    "guidance": "Task completion wakes the Runtime through Inbox. For ordinary waiting, call no_reply instead of a waiting tool. Use check_task_after for one checkpoint only when there is a real deadline or stall-monitoring need; call kill_task when work should not continue. Do not poll with sleep, ps, or repeated empty-log reads.",
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
        .ok_or_else(|| format!("Background task '{task_id}' was not found; it may have been removed by the history-retention policy"))?;
    if !task_visible_in_current_context(&task) {
        return Err(format!(
            "Background task '{task_id}' does not belong to the current Context"
        ));
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
            description: "List Runtime-managed background Shell tasks in the current Cognitive Context. Returns authoritative run state, effective network/sandbox boundary, last output time, and archive path. Do not infer task state with ps.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "include_finished": {
                        "type": "boolean",
                        "description": "Whether to include recently retained terminal tasks; default false."
                    },
                    "session_id": {
                        "type": "string",
                        "description": "Optional: include only tasks started by one Session."
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
            description: "Read authoritative state for one Runtime-managed background task. Use it to confirm whether the task is actually running, has the required network boundary, has stalled without output, and what terminal exit code it produced.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "Background task ID returned by exec."
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
            description: "Schedule one future checkpoint for a background task only when a real deadline or stall supervision is needed. Task completion already wakes the Runtime, so do not use this for ordinary waiting. It does not poll, consume an LLM call, or terminate the task. At the checkpoint, continue waiting from facts or call kill_task.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "Background task ID to supervise."
                    },
                    "check_after_secs": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_TASK_WAIT_SECS,
                        "description": "Seconds before waking the Agent to inspect the task; omit to use the configured supervision interval."
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
                .ok_or_else(|| format!("Background task '{}' was not found", args.task_id))?;
            if !current_context.is_empty() && job.context_id != current_context {
                return Err(format!(
                    "Background task '{}' does not belong to the current Context",
                    args.task_id
                )
                .into());
            }
            if job.status.is_terminal() {
                let live = get_tasks_map().get(&args.task_id);
                return Ok(serde_json::json!({
                    "kind": "background_task_check",
                    "scheduled": false,
                    "waiting": false,
                    "task": background_execution_snapshot(&job, live.as_deref()),
                    "next_action": "The task has ended. Continue directly from the durable ExecutionJob exit code and result.",
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
                "next_action": "The task has ended. Continue directly from its exit code and output.",
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
                            "next_action": "The task ended while the checkpoint was being scheduled. Continue directly from its exit code and output.",
                        })
                        .to_string());
                    }
                }
                return Err(error.into());
            }
        };
        let task = require_visible_task(&args.task_id)?;
        Ok(crate::local_time::localized_runtime_json(serde_json::json!({
            "kind": "background_task_check",
            "scheduled": true,
            "waiting": true,
            "check_after_secs": check_after_secs,
            "wait_secs": check_after_secs,
            "check_at": wakeup_at,
            "wakeup_at": wakeup_at,
            "task": background_task_snapshot(&task),
            "next_action": "If no immediate message is needed, call no_reply to end the current evaluation. Task completion or the checkpoint wakes the Runtime. Do not use sleep, ps, log polling, or immediately schedule another checkpoint.",
        }))
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
                    "description": "Background task ID to force-kill, for example task_1719234560"
                }
            },
            "required": ["task_id"]
        });

        ToolDefinition {
            name: "kill_task".to_string(),
            description:
                "Force-terminate an out-of-control or no-longer-needed managed background shell task, including its process tree and physical resources."
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
                return Err(format!(
                    "Background task '{}' does not belong to the current Context",
                    args.task_id
                )
                .into());
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
            let pgid = nix::unistd::Pid::from_raw(-task_pgid); // A negative PID targets the entire process group.
            match nix::sys::signal::kill(pgid, nix::sys::signal::Signal::SIGKILL) {
                Ok(_) => Ok(serde_json::json!({
                    "kind": "background_task_kill",
                    "task_id": args.task_id,
                    "status": "kill_requested",
                    "process_group_id": task_pgid,
                    "killed": true,
                    "guidance": "The process-exit event carries the final killed state and exit code."
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
                        Err(format!("Force-killing process group {} encountered an operating-system error: {:?}", task_pgid, e).into())
                    }
                }
            }
        } else {
            Err(format!(
                "background task '{}' was not found; it may have been removed by the retention policy",
                args.task_id
            )
            .into())
        }
    }
}

// ==========================================
// 6. DelegateTool: concurrent sub-agent spawning.
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
            description: "Delegate a substantial task to a cognitively isolated Sub Agent. This does not create a new container, process, or physical sandbox: parent and child share the Runtime workspace, filesystem, and permission boundary, and Runtime configuration changes cannot create isolation. The default mode is attached: the Runtime suspends the current evaluation, does not wake it with the queued receipt as a new Observation, and resumes the current Session with the delegate result only after the Sub Agent finishes; do not poll recall. Use detached only when the task should explicitly continue in the background beyond the current turn. The Sub Agent inherits the shared Mind and, optionally, evidence from the current Session, but cannot directly modify the parent Mind; verify, report, or integrate its result yourself.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "task": {
                        "type": "string",
                        "description": "The complete task for the Sub Agent"
                    },
                    "success_when": {
                        "type": "string",
                        "description": "A verifiable completion condition"
                    },
                    "context_scope": {
                        "type": "string",
                        "enum": ["current_session", "mind_only"],
                        "description": "current_session inherits the Mind and current Session; mind_only inherits only the Mind",
                        "default": "current_session"
                    },
                    "mode": {
                        "type": "string",
                        "enum": ["attached", "detached"],
                        "description": "attached waits for the Sub Agent result before resuming the current evaluation; detached returns a queued receipt immediately and lets the current turn continue",
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
            return Err("delegate.task must not be empty".into());
        }
        if !matches!(args.context_scope.as_str(), "current_session" | "mind_only") {
            return Err(
                format!("Unsupported delegate.context_scope: {}", args.context_scope).into(),
            );
        }
        if !matches!(args.mode.as_str(), "attached" | "detached") {
            return Err(format!("Unsupported delegate.mode: {}", args.mode).into());
        }
        let parent_session_id = CURRENT_SESSION_ID
            .try_with(Clone::clone)
            .map_err(|_| "delegate must be called during Session evaluation")?;
        let parent_context_id = CURRENT_CONTEXT_ID
            .try_with(Clone::clone)
            .map_err(|_| "delegate is missing the current Context route")?;
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
                "The Sub Agent is queued. The Runtime waits for its result before resuming the current Session; do not poll."
            } else {
                "The Sub Agent is queued in the background. The current turn may continue or reply; its completed result will return to the current Session later."
            }
        })
        .to_string())
    }
}

// ==========================================
// 7. ListSkillsTool: conventional automatic skill discovery.
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
            description: "List managed-secret aliases and scope metadata available to the current Context and Session. This tool never returns secret values. To run a command with a secret, put only its alias in exec.requested_permissions.secret_env; the Runtime will review the request and inject the value into that one child process.".to_string(),
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
        Ok(crate::local_time::localized_runtime_json(serde_json::json!({
            "status": if secrets.is_empty() { "empty" } else { "ok" },
            "secrets": secrets,
            "value_backend": self.secret_store.backend_id(),
            "guidance": "This contains aliases only. Do not request, read, or echo values; put the required aliases in exec.requested_permissions.secret_env."
        }))
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
    let mut description = "No detailed description".to_string();
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
            description: "Discover the installed Skill capability catalog on demand. Call this before claiming that a capability is unavailable when the Function Calling tools offered in this turn do not directly satisfy the intent or a direct capability has clearly failed. It returns a compact name/description/path index. Select the most relevant item, use read to open its SKILL.md, and follow it to invoke the actual tool. Do not preload every Skill.".to_string(),
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
                "HOME is not configured, so Skill directories cannot be located."
            } else if skills.is_empty() {
                "The current Skill directories are empty. Claim that a capability is missing only if the direct tools in this turn also cannot satisfy the intent."
            } else {
                "Select the item most relevant to the current intent and use read on its SKILL.md path. Do not preload every Skill."
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
    format!(
        "... [first {} characters omitted]\n{}",
        total - max_chars,
        tail
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::{ApprovalDecision, ApprovalRequest};
    use crate::memory::sqlite::SqliteStore;
    use crate::memory::{
        ActivationStore as _, NewAgent, NewCognitiveContext, NewPrincipal, NewSchedule, NewSession,
        NewThreadActivation, ScheduleStore as _, SessionDirectoryStore as _, SessionMountKind,
        SessionStore, ThreadGroupStore as _, ThreadLifecycle, ThreadMutation, ThreadSignalStatus,
        ThreadStore as _, TimerStore,
    };
    use crate::permission::PermissionMode;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::sync::Weak;
    use tempfile::{NamedTempFile, TempDir};

    #[cfg(target_os = "macos")]
    static MACOS_SANDBOX_EXEC_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    static SECRET_ENV_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[tokio::test]
    async fn observed_background_exit_retries_terminal_commit_until_durable() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_for_commit = Arc::clone(&attempts);
        let committed = retry_background_terminal_commit(
            "job-terminal-retry",
            std::time::Duration::from_millis(1),
            move || {
                let attempts = Arc::clone(&attempts_for_commit);
                async move {
                    if attempts.fetch_add(1, AtomicOrdering::SeqCst) == 0 {
                        return Err::<bool, Box<dyn std::error::Error + Send + Sync>>(
                            std::io::Error::other("transient Store failure").into(),
                        );
                    }
                    Ok(true)
                }
            },
        )
        .await;

        assert!(committed);
        assert_eq!(attempts.load(AtomicOrdering::SeqCst), 2);
    }

    #[test]
    fn cancellation_request_stops_background_execution_heartbeat() {
        assert!(should_renew_background_execution(
            ExecutionJobStatus::Running,
            true,
            false,
        ));
        assert!(!should_renew_background_execution(
            ExecutionJobStatus::Running,
            true,
            true,
        ));
        assert!(!should_renew_background_execution(
            ExecutionJobStatus::Running,
            false,
            false,
        ));
        assert!(!should_renew_background_execution(
            ExecutionJobStatus::Cancelled,
            true,
            false,
        ));
    }

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
    async fn principal_tool_uses_runtime_identity_and_returns_only_owned_sessions() {
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
        store
            .create_session(NewSession {
                id: "owned-session".to_string(),
                agent_id: "verify-agent".to_string(),
                context_id: "verify-context".to_string(),
                parent_session_id: None,
                title: "Owned".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        store
            .bind_session_principal("owned-session", "principal:a")
            .await
            .unwrap();
        store
            .create_session(NewSession {
                id: "foreign-session".to_string(),
                agent_id: "verify-agent".to_string(),
                context_id: "verify-context".to_string(),
                parent_session_id: None,
                title: "Foreign".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        store
            .ensure_principal(NewPrincipal {
                id: "principal:b".to_string(),
                provider_id: "test".to_string(),
                assurance: "verified".to_string(),
                display_name: None,
            })
            .await
            .unwrap();
        store
            .bind_session_principal("foreign-session", "principal:b")
            .await
            .unwrap();
        let tool = PrincipalTool::new(store as Arc<dyn SessionStore>);
        let schema = tool.definition().parameters;
        assert_eq!(schema["type"], "object");
        assert!(schema.get("oneOf").is_none());
        assert_eq!(schema["required"], serde_json::json!(["action"]));
        assert_eq!(schema["additionalProperties"], false);

        let execute = |claim: &'static str| {
            let tool = &tool;
            CURRENT_SESSION_ID.scope(
                "verify-session".to_string(),
                CURRENT_PRINCIPAL_ID.scope(Some("principal:a".to_string()), async move {
                    tool.execute(
                        &serde_json::json!({
                            "action": "verify_identity",
                            "claimed_principal_id": claim
                        })
                        .to_string(),
                    )
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

        let listed = CURRENT_SESSION_ID
            .scope(
                "verify-session".to_string(),
                CURRENT_PRINCIPAL_ID.scope(Some("principal:a".to_string()), async {
                    tool.execute(r#"{"action":"list_sessions"}"#).await.unwrap()
                }),
            )
            .await;
        let listed: serde_json::Value = serde_json::from_str(&listed).unwrap();
        let session_ids = listed["session_ids"].as_array().unwrap();
        assert_eq!(session_ids.len(), 2);
        assert!(session_ids.iter().any(|id| id == "verify-session"));
        assert!(session_ids.iter().any(|id| id == "owned-session"));
        assert!(!session_ids.iter().any(|id| id == "foreign-session"));

        for (session_id, belongs) in [
            ("owned-session", true),
            ("foreign-session", false),
            ("missing-session", false),
        ] {
            let result = CURRENT_SESSION_ID
                .scope(
                    "verify-session".to_string(),
                    CURRENT_PRINCIPAL_ID.scope(Some("principal:a".to_string()), async {
                        tool.execute(
                            &serde_json::json!({
                                "action": "verify_session",
                                "session_id": session_id
                            })
                            .to_string(),
                        )
                        .await
                        .unwrap()
                    }),
                )
                .await;
            let result: serde_json::Value = serde_json::from_str(&result).unwrap();
            assert_eq!(result["belongs"], belongs);
        }
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
    ) -> (
        Arc<BackgroundTaskScheduler>,
        NamedTempFile,
        Arc<SqliteStore>,
    ) {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(database.path().to_string_lossy().as_ref())
                .await
                .unwrap(),
        );
        let timers = Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>));
        let scheduler = Arc::new(
            BackgroundTaskScheduler::new(
                bus,
                Arc::clone(&store) as Arc<dyn EventStore>,
                Arc::clone(&timers),
            )
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
        );
        scheduler.register_timer_handler().unwrap();
        timers.start();
        (scheduler, database, store)
    }

    fn start_test_durable_background_scheduler(
        bus: Arc<InMemoryEventBus>,
        store: Arc<SqliteStore>,
    ) -> Arc<BackgroundTaskScheduler> {
        let timers = Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>));
        let execution_jobs = Arc::new(ExecutionJobManager::new(
            Arc::clone(&store) as Arc<dyn ExecutionJobStore>
        ));
        let scheduler = Arc::new(
            BackgroundTaskScheduler::new_with_execution_jobs(
                bus,
                Arc::clone(&store) as Arc<dyn EventStore>,
                Arc::clone(&timers),
                execution_jobs,
            )
            .with_session_store(store as Arc<dyn SessionStore>),
        );
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
        seed_test_execution_route_with(
            store,
            parent,
            root_turn_id,
            trigger_event_id,
            crate::memory::ThreadSupervision::legacy(),
        )
        .await;
    }

    async fn seed_test_execution_route_with(
        store: &Arc<SqliteStore>,
        parent: &ToolExecutionJobContext,
        root_turn_id: &str,
        trigger_event_id: &str,
        supervision: crate::memory::ThreadSupervision,
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
                supervision,
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
        assert!(receipt["guidance"]
            .as_str()
            .unwrap()
            .contains("current Evaluation has not ended"));

        let event = receiver.recv().await.unwrap();
        assert_eq!(event.payload["session_id"], "session-b");
        assert_eq!(event.payload["context_id"], "context-b");
        assert_eq!(event.payload["source_session_id"], "session-a");
        assert_eq!(event.payload["text"], "background task finished");
        assert!(store
            .list_context_thread_signals("context-b", None)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn session_signal_commits_one_target_dialogue_turn_and_is_idempotent() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(database.path().to_string_lossy().as_ref())
                .await
                .unwrap(),
        );
        store
            .ensure_agent(NewAgent {
                id: "agent-session-signal".to_string(),
                title: "Session Signal Agent".to_string(),
                root_context_id: "context-session-signal-a".to_string(),
            })
            .await
            .unwrap();
        for context_id in ["context-session-signal-a", "context-session-signal-b"] {
            store
                .ensure_context(NewCognitiveContext {
                    id: context_id.to_string(),
                    agent_id: "agent-session-signal".to_string(),
                    title: context_id.to_string(),
                })
                .await
                .unwrap();
        }
        for (session_id, context_id) in [
            ("session-session-signal-a", "context-session-signal-a"),
            ("session-session-signal-b", "context-session-signal-b"),
        ] {
            store
                .ensure_session(NewSession {
                    id: session_id.to_string(),
                    agent_id: "agent-session-signal".to_string(),
                    context_id: context_id.to_string(),
                    parent_session_id: None,
                    title: session_id.to_string(),
                    mount_kind: SessionMountKind::ExistingContext,
                })
                .await
                .unwrap();
        }

        let bus = Arc::new(InMemoryEventBus::new());
        let (sender, mut receiver) = tokio::sync::mpsc::channel(2);
        bus.subscribe(
            "chat/session_signal".to_string(),
            Arc::new(move |event| {
                let sender = sender.clone();
                Box::pin(async move { sender.send(event).await.map_err(|error| error.into()) })
            }),
        );
        let tool = SessionSignalTool::new(
            Arc::clone(&bus),
            Arc::clone(&store) as Arc<dyn EventStore>,
            Arc::clone(&store) as Arc<dyn SessionStore>,
        );
        let arguments = serde_json::json!({
            "session_id": "session-session-signal-b",
            "content": "Please review the launch plan"
        })
        .to_string();
        let route = Some(ToolCausalRoute {
            thread_id: "thread-session-signal-a".to_string(),
            activation_id: "activation-session-signal-a".to_string(),
            model_attempt_id: None,
            root_turn_id: "root-session-signal-a".to_string(),
            trigger_event_id: "trigger-session-signal-a".to_string(),
            trigger_sequence: 7,
        });
        let execute = || {
            CURRENT_SESSION_ID.scope(
                "session-session-signal-a".to_string(),
                CURRENT_CONTEXT_ID.scope(
                    "context-session-signal-a".to_string(),
                    CURRENT_ATTEMPT_ID.scope(
                        "attempt-session-signal-a".to_string(),
                        CURRENT_CAUSAL_ROUTE.scope(route.clone(), tool.execute(&arguments)),
                    ),
                ),
            )
        };

        let first: serde_json::Value = serde_json::from_str(&execute().await.unwrap()).unwrap();
        assert_eq!(first["status"], "signalled");
        assert_eq!(first["duplicate"], false);
        let event = receiver.recv().await.unwrap();
        assert_eq!(event.topic, "chat/session_signal");
        assert_eq!(event.payload["context_id"], "context-session-signal-b");
        assert_eq!(event.payload["session_id"], "session-session-signal-b");
        assert_eq!(
            event.payload["source_context_id"],
            "context-session-signal-a"
        );
        assert_eq!(
            event.payload["source_session_id"],
            "session-session-signal-a"
        );
        assert_eq!(event.payload["cross_context"], true);

        let second: serde_json::Value = serde_json::from_str(&execute().await.unwrap()).unwrap();
        assert_eq!(second["duplicate"], true);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), receiver.recv())
                .await
                .is_err()
        );
        let signals = store
            .list_context_thread_signals("context-session-signal-b", None)
            .await
            .unwrap();
        assert_eq!(
            signals
                .iter()
                .filter(|signal| signal.event_id == event.id)
                .count(),
            1
        );
        let target_thread = store.get_thread_by_root(&event.id).await.unwrap().unwrap();
        assert_eq!(target_thread.session_id, "session-session-signal-b");
        assert_eq!(target_thread.context_id, "context-session-signal-b");
        assert_eq!(target_thread.kind, ThreadKind::DialogueTurn);
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
            model_attempt_id: None,
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
    async fn schedule_tx_atomically_creates_concurrent_tasks_with_independent_models() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(database.path().to_string_lossy().as_ref())
                .await
                .unwrap(),
        );
        store
            .ensure_agent(NewAgent {
                id: "agent-model-batch".to_string(),
                title: "Model Batch Agent".to_string(),
                root_context_id: "context-model-batch".to_string(),
            })
            .await
            .unwrap();
        store
            .ensure_context(NewCognitiveContext {
                id: "context-model-batch".to_string(),
                agent_id: "agent-model-batch".to_string(),
                title: "Model Batch Context".to_string(),
            })
            .await
            .unwrap();
        store
            .ensure_session(NewSession {
                id: "session-model-batch".to_string(),
                agent_id: "agent-model-batch".to_string(),
                context_id: "context-model-batch".to_string(),
                parent_session_id: None,
                title: "Model Batch Session".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        store
            .ensure_thread(NewThread {
                id: "thread-model-batch-current".to_string(),
                agent_id: "agent-model-batch".to_string(),
                context_id: "context-model-batch".to_string(),
                session_id: "session-model-batch".to_string(),
                initiating_principal_id: None,
                root_turn_id: "root-model-batch-current".to_string(),
                kind: ThreadKind::DialogueTurn,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: crate::memory::ThreadSupervision::legacy(),
            })
            .await
            .unwrap();

        let bus = Arc::new(InMemoryEventBus::new());
        let scheduler = start_test_scheduler(Arc::clone(&bus), Arc::clone(&store));
        let tool = ScheduleTxTool::new(
            Arc::clone(&scheduler),
            Arc::clone(&store) as Arc<dyn SessionStore>,
        )
        .with_allowed_evaluation_models(vec![
            "primary-route".to_string(),
            "fast-route".to_string(),
        ]);
        let arguments = serde_json::json!({
            "operations": [
                {
                    "op": "spawn",
                    "client_id": "research",
                    "intent": "research independently",
                    "lifetime": "attached",
                    "delay_seconds": 3600,
                    "model": "fast-route"
                },
                {
                    "op": "spawn",
                    "client_id": "review",
                    "intent": "review independently",
                    "lifetime": "attached",
                    "delay_seconds": 3600,
                    "model": "primary-route"
                }
            ],
            "group": {"policy": "all"}
        })
        .to_string();
        let route = Some(ToolCausalRoute {
            thread_id: "thread-model-batch-current".to_string(),
            activation_id: "activation-model-batch".to_string(),
            model_attempt_id: None,
            root_turn_id: "root-model-batch-current".to_string(),
            trigger_event_id: "trigger-model-batch".to_string(),
            trigger_sequence: 1,
        });
        let output = CURRENT_SESSION_ID
            .scope(
                "session-model-batch".to_string(),
                CURRENT_CONTEXT_ID.scope(
                    "context-model-batch".to_string(),
                    CURRENT_ATTEMPT_ID.scope(
                        "attempt-model-batch".to_string(),
                        CURRENT_CAUSAL_ROUTE.scope(route.clone(), tool.execute(&arguments)),
                    ),
                ),
            )
            .await
            .unwrap();
        let receipt: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(receipt["status"], "committed");
        assert_eq!(receipt["client_receipts"].as_array().unwrap().len(), 2);
        assert_eq!(receipt["thread_groups"].as_array().unwrap().len(), 1);
        let schedules = store.list_schedules(None, None).await.unwrap();
        assert_eq!(schedules.len(), 2);
        assert!(schedules
            .iter()
            .all(|schedule| schedule.dependency_thread_ids.is_empty()));
        assert!(schedules
            .iter()
            .any(|schedule| schedule.model_alias.as_deref() == Some("fast-route")));
        assert!(schedules
            .iter()
            .any(|schedule| schedule.model_alias.as_deref() == Some("primary-route")));

        let unauthorized = serde_json::json!({
            "operations": [{
                "op": "spawn",
                "client_id": "forbidden",
                "intent": "must roll back",
                "lifetime": "attached",
                "delay_seconds": 3600,
                "model": "not-authorized"
            }]
        })
        .to_string();
        let error = CURRENT_SESSION_ID
            .scope(
                "session-model-batch".to_string(),
                CURRENT_CONTEXT_ID.scope(
                    "context-model-batch".to_string(),
                    CURRENT_ATTEMPT_ID.scope(
                        "attempt-model-batch-forbidden".to_string(),
                        CURRENT_CAUSAL_ROUTE.scope(route, tool.execute(&unauthorized)),
                    ),
                ),
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("allowed_evaluation_models"));
        assert_eq!(store.list_schedules(None, None).await.unwrap().len(), 2);
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
            model_attempt_id: None,
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
            model_attempt_id: None,
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
        let spawn_route = ToolCausalRoute {
            thread_id: "thread-thread-promotion-parent".to_string(),
            activation_id: "evaluation-thread-promotion".to_string(),
            model_attempt_id: None,
            root_turn_id: "root-thread-promotion".to_string(),
            trigger_event_id: "user-thread-promotion".to_string(),
            trigger_sequence: 3,
        };
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
                        CURRENT_CAUSAL_ROUTE.scope(Some(spawn_route.clone()), tool.execute(&spawn)),
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
        let attached = store
            .get_thread(&thread_id)
            .await
            .unwrap()
            .expect("attached thread");
        assert_eq!(
            attached.supervision.supervisor_kind,
            ThreadSupervisorKind::Thread
        );
        assert_eq!(
            attached.supervision.supervisor_id.as_deref(),
            Some("thread-thread-promotion-parent")
        );
        assert_eq!(
            attached.supervision.origin_evaluation_id.as_deref(),
            Some("evaluation-thread-promotion")
        );
        let revision = attached.revision;

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
        let mut promote_route = spawn_route;
        promote_route.activation_id = "evaluation-thread-promotion-successor".to_string();
        promote_route.trigger_event_id = "tool-output-thread-promotion".to_string();
        promote_route.trigger_sequence += 1;
        let promote_output = CURRENT_SESSION_ID
            .scope(
                "session-thread-promotion".to_string(),
                CURRENT_CONTEXT_ID.scope(
                    "context-thread-promotion".to_string(),
                    CURRENT_ATTEMPT_ID.scope(
                        "attempt-thread-promotion".to_string(),
                        CURRENT_CAUSAL_ROUTE.scope(Some(promote_route), tool.execute(&promote)),
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
                model_alias: None,
                not_before: Some(due_at),
                interval_seconds: None,
                dependency_thread_ids: Vec::new(),
            })
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn peer_runtime_can_claim_and_dispatch_a_durable_schedule_timer() {
        let database = NamedTempFile::new().unwrap();
        let owner_store = scheduler_store_with_threads(
            &database,
            &[("thread-peer-schedule", "root-peer-schedule")],
        )
        .await;
        let peer_store = Arc::new(
            SqliteStore::new(database.path().to_string_lossy().as_ref())
                .await
                .unwrap(),
        );
        let owner_bus = Arc::new(InMemoryEventBus::new());
        let (owner, _owner_timers) = build_test_scheduler(owner_bus, Arc::clone(&owner_store));
        let peer_bus = Arc::new(InMemoryEventBus::new());
        let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
        peer_bus.subscribe(
            "chat/schedule_due".to_string(),
            Arc::new(move |event| {
                let sender = sender.clone();
                Box::pin(async move { sender.send(event).await.map_err(|error| error.into()) })
            }),
        );
        let (_peer, peer_timers) = build_test_scheduler(peer_bus, Arc::clone(&peer_store));
        let intent = seed_test_schedule(
            &owner_store,
            "schedule-peer-runtime",
            "thread-peer-schedule",
            chrono::Utc::now() - chrono::Duration::seconds(1),
        )
        .await;
        owner.arm(intent).await.unwrap();

        assert_eq!(peer_timers.dispatch_due_once().await.unwrap(), 1);
        let event = tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.payload["schedule_id"], "schedule-peer-runtime");
        assert_eq!(
            peer_store
                .list_context_thread_signals(
                    "context-scheduler-test",
                    Some(ThreadSignalStatus::Pending),
                )
                .await
                .unwrap()
                .len(),
            1,
            "peer dispatch must persist the target Thread Signal"
        );
    }

    #[tokio::test]
    async fn one_shot_schedule_to_objective_primary_thread_marks_interrupt_route() {
        let database = NamedTempFile::new().unwrap();
        let store = scheduler_store_with_threads(&database, &[]).await;
        let objective_id = "objective-scheduled-interrupt";
        let generation = 3;
        let root = crate::memory::objective_primary_execution_root_id(objective_id, generation);
        let thread_id = stable_thread_id(&root);
        store
            .ensure_thread(NewThread {
                id: thread_id.clone(),
                agent_id: "agent-scheduler-test".to_string(),
                context_id: "context-scheduler-test".to_string(),
                session_id: "session-scheduler-test".to_string(),
                initiating_principal_id: None,
                root_turn_id: root,
                kind: ThreadKind::Execution,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: ThreadSupervision::objective_primary_execution(
                    objective_id,
                    generation,
                ),
            })
            .await
            .unwrap();
        let bus = Arc::new(InMemoryEventBus::new());
        let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
        bus.subscribe(
            "chat/schedule_due".to_string(),
            Arc::new(move |event| {
                let sender = sender.clone();
                Box::pin(async move { sender.send(event).await.map_err(|error| error.into()) })
            }),
        );
        let (scheduler, timers) = build_test_scheduler(bus, Arc::clone(&store));
        let intent = seed_test_schedule(
            &store,
            "schedule-objective-interrupt",
            &thread_id,
            chrono::Utc::now() - chrono::Duration::seconds(1),
        )
        .await;
        scheduler.arm(intent).await.unwrap();
        assert_eq!(timers.dispatch_due_once().await.unwrap(), 1);
        let event = receiver.recv().await.unwrap();
        assert_eq!(event.payload["objective_interrupt"], true);
        assert_eq!(event.payload["objective_phase"], "interrupt");
        assert_eq!(event.payload["wake_source"], "schedule-enqueue");
        assert_eq!(event.payload["objective_id"], objective_id);
        assert_eq!(event.payload["objective_generation"], generation);
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
            model_attempt_id: None,
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
        let displayed_due_at = inspect["schedule"]["not_before"].as_str().unwrap();
        assert!(chrono::DateTime::parse_from_rfc3339(displayed_due_at).is_ok());
        assert!(
            !displayed_due_at.ends_with('Z'),
            "model-facing time: {displayed_due_at}"
        );

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
            0
        );
        assert_eq!(
            recovered_store
                .list_context_thread_signals("context-scheduler-test", None)
                .await
                .unwrap()
                .iter()
                .filter(|signal| signal.event_id == due_events[0].id)
                .count(),
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
                model_alias: None,
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
                model_alias: None,
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
                model_alias: None,
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
                model_alias: None,
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

    #[tokio::test]
    async fn recurring_schedule_routes_each_due_event_to_its_occurrence_thread() {
        let database = NamedTempFile::new().unwrap();
        let store = scheduler_store_with_threads(
            &database,
            &[("thread-recurring-template", "root-recurring-template")],
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
        let intent = store
            .ensure_schedule(NewSchedule {
                id: "schedule-recurring-route".to_string(),
                thread_id: "thread-recurring-template".to_string(),
                source_turn_id: "root-recurring-template".to_string(),
                intent: "run one independent recurring occurrence".to_string(),
                model_alias: None,
                not_before: Some(chrono::Utc::now() - chrono::Duration::seconds(1)),
                interval_seconds: Some(60),
                dependency_thread_ids: Vec::new(),
            })
            .await
            .unwrap();
        scheduler.arm(intent).await.unwrap();

        assert_eq!(timers.dispatch_due_once().await.unwrap(), 1);
        let event = receiver.recv().await.unwrap();
        let occurrence_root = event.payload["root_turn_id"].as_str().unwrap();
        let occurrence = store
            .get_thread_by_root(occurrence_root)
            .await
            .unwrap()
            .expect("recurring due commit must atomically materialize its occurrence Thread");
        let signal = store
            .list_context_thread_signals(
                "context-scheduler-test",
                Some(crate::memory::ThreadSignalStatus::Pending),
            )
            .await
            .unwrap()
            .into_iter()
            .find(|signal| signal.event_id == event.id)
            .expect("recurring due commit must append one pending Signal");
        assert_eq!(signal.thread_id, occurrence.id);
        assert_ne!(occurrence.id, "thread-recurring-template");
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

    /// Test helper: explicitly selects the full-access preset.
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
        assert!(write_res.contains("succeeded"));

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
    async fn read_image_returns_typed_attachment_and_round_trips_edge_transport() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("pixel.png");
        let png = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
            .unwrap();
        std::fs::write(&path, &png).unwrap();
        let read = ReadFileTool::new(permissive_security());
        let arguments = serde_json::json!({ "path": path }).to_string();

        let result = read.execute_result(&arguments).await.unwrap();
        assert_eq!(result.model_attachments.len(), 1);
        assert_eq!(result.model_attachments[0].name, "pixel.png");
        assert_eq!(result.model_attachments[0].media_type, "image/png");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(&result.model_attachments[0].data_base64)
                .unwrap(),
            png
        );
        let metadata: serde_json::Value = serde_json::from_str(&result.text).unwrap();
        assert_eq!(metadata["kind"], "model_visible_artifact");
        assert_eq!(metadata["size_bytes"], png.len());

        let transport = read.execute(&arguments).await.unwrap();
        let decoded = ToolExecutionResult::decode_transport(transport);
        assert_eq!(decoded, result);
    }

    #[tokio::test]
    async fn read_image_rejects_text_selectors_and_unknown_binary() {
        let tmp = TempDir::new().unwrap();
        let image = tmp.path().join("pixel.png");
        std::fs::write(&image, b"\x89PNG\r\n\x1a\nrest").unwrap();
        let binary = tmp.path().join("payload.bin");
        std::fs::write(&binary, b"\0\xff\0\xfe").unwrap();
        let read = ReadFileTool::new(permissive_security());

        let selector_error = read
            .execute_result(&serde_json::json!({ "path": image, "start_line": 1 }).to_string())
            .await
            .unwrap_err();
        assert!(selector_error
            .to_string()
            .contains("Image reads cannot use"));

        let binary_error = read
            .execute_result(&serde_json::json!({ "path": binary }).to_string())
            .await
            .unwrap_err();
        assert!(binary_error
            .to_string()
            .contains("is neither UTF-8 text nor a supported"));
    }

    #[tokio::test]
    async fn read_image_uses_the_runtime_supplied_artifact_limit() {
        let tmp = TempDir::new().unwrap();
        let image = tmp.path().join("pixel.png");
        std::fs::write(&image, b"\x89PNG\r\n\x1a\nmore-than-eight").unwrap();
        let read = ReadFileTool::new_with_permissions_and_limit(
            broker_from_config(permissive_security()),
            8,
        );
        let error = read
            .execute_result(&serde_json::json!({ "path": image }).to_string())
            .await
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("per-file model-input limit of 8 bytes"));
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
        assert!(create_error.to_string().contains("refuses to overwrite"));

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
        assert!(stale_error.to_string().contains("File version conflict"));
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
        assert!(stale.to_string().contains("version conflict"));

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
        assert!(ambiguous.to_string().contains("matches 2 times"));
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
        assert!(guidance.contains("only when stderr or other evidence clearly shows"));
        assert!(guidance.contains("protected_paths"));
    }

    #[tokio::test]
    async fn test_tool_path_permission_fallback() {
        let read_tool = ReadFileTool::new(permissive_security());
        // Read an obviously missing directory and verify a graceful error string instead of panic.
        let bad_args = serde_json::json!({
            "path": "/obviously_not_exist_dir/no_file.txt"
        });
        let res = read_tool.execute(&bad_args.to_string()).await.unwrap();
        assert!(res.contains("does not exist") || res.contains("System error"));
    }

    #[tokio::test]
    async fn default_profile_requires_approval_for_path_outside_allowed_roots() {
        // Absolute-path syntax is valid; `/etc/passwd` requires approval because its resolved path is
        // outside allowed roots.
        let read_tool = ReadFileTool::new(Arc::new(PermissionConfig::default()));
        let bad_args = serde_json::json!({
            "path": "/etc/passwd"
        });
        let res = read_tool.execute(&bad_args.to_string()).await.unwrap();
        assert!(res.contains("permission policy") || res.contains("System error"));
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

    #[test]
    fn managed_ssh_credential_aliases_are_audited_but_not_injected_as_process_environment() {
        let approved = vec![
            "SSH_AUTH_SOCK".to_string(),
            "SCNET_SSH_KEY".to_string(),
            "SCNET_SSH_KEY_PASSPHRASE".to_string(),
            "FEATURIZE_SSH_PASSWORD".to_string(),
        ];

        assert_eq!(
            executable_secret_aliases(true, &approved),
            vec!["SSH_AUTH_SOCK"]
        );
        assert_eq!(executable_secret_aliases(false, &approved), approved);
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

        assert!(error.to_string().contains("prohibits using shell '&'"));
    }

    #[tokio::test]
    async fn exec_output_monitor_drain_is_bounded_and_cancels_stuck_readers() {
        let mut stdout_task = tokio::spawn(std::future::pending::<()>());
        let mut stderr_task = tokio::spawn(std::future::pending::<()>());

        let drained = drain_exec_output_monitors(
            &mut stdout_task,
            &mut stderr_task,
            tokio::time::Duration::from_millis(10),
        )
        .await;

        assert!(!drained);
        assert!(stdout_task.is_finished());
        assert!(stderr_task.is_finished());
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

        assert!(error.to_string().contains("child processes still alive"));
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
        assert!(!denied.contains("exit code 0"));
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

        assert!(error.to_string().contains("permission review rejected"));
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
        assert!(result.contains("Context preview was truncated at the buffer limit"));

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

        // Start a long-running command with a short synchronous wait interval.
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
            0,
            "an already-materialized direct Thread Signal must not retain a pending Outbox row"
        );
        assert_eq!(
            store
                .list_context_thread_signals(&parent.context_id, None)
                .await
                .unwrap()
                .into_iter()
                .filter(|signal| signal.event_id == completion.id)
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
    async fn background_completion_escalates_to_session_after_owner_thread_is_terminal() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(database.path().to_string_lossy().as_ref())
                .await
                .unwrap(),
        );
        let bus = Arc::new(InMemoryEventBus::new());
        let (sender, mut receiver) = tokio::sync::mpsc::channel(4);
        {
            let sender = sender.clone();
            bus.subscribe(
                "chat/tool_output".to_string(),
                Arc::new(move |event| {
                    let sender = sender.clone();
                    Box::pin(async move { sender.send(event).await.map_err(|error| error.into()) })
                }),
            );
        }
        bus.subscribe(
            "runtime/background_wake".to_string(),
            Arc::new(move |event| {
                let sender = sender.clone();
                Box::pin(async move { sender.send(event).await.map_err(|error| error.into()) })
            }),
        );
        let scheduler =
            start_test_durable_background_scheduler(Arc::clone(&bus), Arc::clone(&store));
        let parent = ToolExecutionJobContext {
            parent_job_id: deterministic_job_id(
                "activation-terminal-owner-background",
                "exec-call-terminal-owner-background",
            )
            .unwrap(),
            activation_id: "activation-terminal-owner-background".to_string(),
            thread_id: "thread-terminal-owner-background".to_string(),
            agent_id: "agent-terminal-owner-background".to_string(),
            context_id: "context-terminal-owner-background".to_string(),
            session_id: "session-terminal-owner-background".to_string(),
            initiating_principal_id: None,
            target_id: crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
            tool_call_id: "exec-call-terminal-owner-background".to_string(),
        };
        seed_test_execution_route(
            &store,
            &parent,
            "root-terminal-owner-background",
            "trigger-terminal-owner-background",
        )
        .await;

        let manager = scheduler.execution_jobs.as_ref().unwrap();
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
                    "command": "service-owned-by-terminal-thread",
                    "process_group_id": 424242,
                    "artifact_path": "/tmp/terminal-owner-background.log",
                    "started_at": chrono::Utc::now(),
                    "effective_boundary": {}
                }),
                retry_safety: ExecutionRetrySafety::ReconcileRequired,
                requires_approval: false,
            })
            .await
            .unwrap();
        let claim_token = "terminal-owner-background-claim";
        job = applied_background_job(
            manager
                .claim(
                    &job.id,
                    job.revision,
                    JobClaim {
                        worker_id: "terminal-owner-background-worker",
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
                        progress_ref: Some("/tmp/terminal-owner-background.log"),
                    },
                )
                .await
                .unwrap(),
            "side-effect boundary",
        )
        .unwrap();
        job = applied_background_job(
            manager
                .request_cancel(&job.id, job.revision, Some("owner already terminal"))
                .await
                .unwrap(),
            "cancel request",
        )
        .unwrap();
        assert!(job.cancel_requested_at.is_some());

        let owner = store.get_thread(&parent.thread_id).await.unwrap().unwrap();
        let owner = match store
            .update_thread(
                &owner.id,
                owner.revision,
                None,
                Some(ThreadLifecycle::Completed),
                None,
                None,
                None,
                None,
            )
            .await
            .unwrap()
        {
            ThreadMutation::Updated(thread) => thread,
            other => panic!("unexpected Thread mutation: {other:?}"),
        };
        assert_eq!(owner.lifecycle, ThreadLifecycle::Completed);

        assert!(scheduler
            .finish_background_execution(&task_id, -9, "", "")
            .await
            .unwrap());
        let completion = tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
            .await
            .expect("terminal result Event must still be dispatched")
            .expect("completion channel must remain open");
        assert_eq!(completion.topic, "chat/tool_output");
        assert_eq!(completion.payload["task_status"], "cancelled");
        let terminal = store.get_execution_job(&task_id).await.unwrap().unwrap();
        assert_eq!(terminal.status, ExecutionJobStatus::Cancelled);
        assert_eq!(
            terminal.result_event_id.as_deref(),
            Some(completion.id.as_str())
        );
        assert_eq!(
            store
                .list_context_thread_signals(&parent.context_id, None)
                .await
                .unwrap()
                .iter()
                .filter(|signal| signal.event_id == completion.id)
                .count(),
            0,
            "a terminal owner Thread must not receive a new Direct Signal"
        );

        let wake = tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
            .await
            .expect(
                "a terminal background result must escalate to the owning Session as a Runtime Wake",
            )
            .expect("wake channel must remain open");
        assert_eq!(wake.topic, "runtime/background_wake");
        assert_eq!(wake.event_type, crate::event::TYPE_RUNTIME_WAKE);
        assert_eq!(wake.payload["event"], "background_task_terminal");
        assert_eq!(wake.payload["wake_kind"], "terminal_result");
        assert_eq!(wake.payload["task_status"], "cancelled");
        assert_eq!(wake.payload["session_id"], parent.session_id);
        assert_eq!(wake.payload["context_id"], parent.context_id);
        assert_eq!(wake.payload["source_thread_id"], parent.thread_id);
        assert_eq!(wake.payload["source_activation_id"], parent.activation_id);
        assert_eq!(wake.payload["result_event_id"], completion.id);
        assert_eq!(wake.payload["wake_policy"], "session_fallback");
        assert!(wake.payload.get("thread_id").is_none());
        assert!(wake.payload.get("activation_id").is_none());
        assert!(wake.payload.get("root_turn_id").is_none());
        let wake_signal_count = store
            .list_context_thread_signals(&parent.context_id, None)
            .await
            .unwrap()
            .into_iter()
            .filter(|signal| signal.event_id == wake.id)
            .count();
        assert_eq!(wake_signal_count, 1);
        let owning_after = store.get_thread(&parent.thread_id).await.unwrap().unwrap();
        assert_eq!(owning_after.lifecycle, ThreadLifecycle::Completed);
    }

    #[tokio::test]
    async fn terminal_supervisor_owned_child_completion_is_not_session_escalated() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(database.path().to_string_lossy().as_ref())
                .await
                .unwrap(),
        );
        let bus = Arc::new(InMemoryEventBus::new());
        let (sender, mut receiver) = tokio::sync::mpsc::channel(4);
        {
            let sender = sender.clone();
            bus.subscribe(
                "chat/tool_output".to_string(),
                Arc::new(move |event| {
                    let sender = sender.clone();
                    Box::pin(async move { sender.send(event).await.map_err(|error| error.into()) })
                }),
            );
        }
        bus.subscribe(
            "runtime/background_wake".to_string(),
            Arc::new(move |event| {
                let sender = sender.clone();
                Box::pin(async move { sender.send(event).await.map_err(|error| error.into()) })
            }),
        );
        let scheduler =
            start_test_durable_background_scheduler(Arc::clone(&bus), Arc::clone(&store));
        let parent = ToolExecutionJobContext {
            parent_job_id: deterministic_job_id(
                "activation-attached-owner-background",
                "exec-call-attached-owner-background",
            )
            .unwrap(),
            activation_id: "activation-attached-owner-background".to_string(),
            thread_id: "thread-attached-owner-background".to_string(),
            agent_id: "agent-attached-owner-background".to_string(),
            context_id: "context-attached-owner-background".to_string(),
            session_id: "session-attached-owner-background".to_string(),
            initiating_principal_id: None,
            target_id: crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
            tool_call_id: "exec-call-attached-owner-background".to_string(),
        };
        seed_test_execution_route_with(
            &store,
            &parent,
            "root-attached-owner-background",
            "trigger-attached-owner-background",
            ThreadSupervision::attached(
                "thread-attached-supervisor",
                1,
                "eval-attached-owner-background",
            ),
        )
        .await;

        let manager = scheduler.execution_jobs.as_ref().unwrap();
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
                    "command": "service-owned-by-attached-child",
                    "process_group_id": 464646,
                    "artifact_path": "/tmp/attached-owner-background.log",
                    "started_at": chrono::Utc::now(),
                    "effective_boundary": {}
                }),
                retry_safety: ExecutionRetrySafety::ReconcileRequired,
                requires_approval: false,
            })
            .await
            .unwrap();
        let claim_token = "attached-owner-background-claim";
        job = applied_background_job(
            manager
                .claim(
                    &job.id,
                    job.revision,
                    JobClaim {
                        worker_id: "attached-owner-background-worker",
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
                        progress_ref: Some("/tmp/attached-owner-background.log"),
                    },
                )
                .await
                .unwrap(),
            "side-effect boundary",
        )
        .unwrap();
        job = applied_background_job(
            manager
                .request_cancel(
                    &job.id,
                    job.revision,
                    Some("attached child already terminal"),
                )
                .await
                .unwrap(),
            "cancel request",
        )
        .unwrap();
        assert!(job.cancel_requested_at.is_some());

        let owner = store.get_thread(&parent.thread_id).await.unwrap().unwrap();
        assert_eq!(
            owner.supervision.supervisor_kind,
            ThreadSupervisorKind::Thread
        );
        let owner = match store
            .update_thread(
                &owner.id,
                owner.revision,
                None,
                Some(ThreadLifecycle::Completed),
                None,
                None,
                None,
                None,
            )
            .await
            .unwrap()
        {
            ThreadMutation::Updated(thread) => thread,
            other => panic!("unexpected Thread mutation: {other:?}"),
        };
        assert_eq!(owner.lifecycle, ThreadLifecycle::Completed);

        assert!(scheduler
            .finish_background_execution(&task_id, -9, "", "")
            .await
            .unwrap());
        let completion = tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
            .await
            .expect("terminal result Event must still be dispatched")
            .expect("completion channel must remain open");
        assert_eq!(completion.topic, "chat/tool_output");
        assert_eq!(completion.payload["task_status"], "cancelled");
        let terminal = store.get_execution_job(&task_id).await.unwrap().unwrap();
        assert_eq!(terminal.status, ExecutionJobStatus::Cancelled);
        assert_eq!(
            terminal.result_event_id.as_deref(),
            Some(completion.id.as_str())
        );
        assert_eq!(
            store
                .list_context_thread_signals(&parent.context_id, None)
                .await
                .unwrap()
                .iter()
                .filter(|signal| signal.event_id == completion.id)
                .count(),
            0,
            "a terminal attached child must not receive a new Direct Signal"
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(150), receiver.recv())
                .await
                .is_err(),
            "a terminal supervisor-owned attached child must not Session-escalate its result"
        );
        let owning_after = store.get_thread(&parent.thread_id).await.unwrap().unwrap();
        assert_eq!(owning_after.lifecycle, ThreadLifecycle::Completed);
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
                                    model_attempt_id: None,
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
        assert!(completion_outboxes.is_empty());
        assert_eq!(
            store
                .list_context_thread_signals(&parent.context_id, None)
                .await
                .unwrap()
                .iter()
                .filter(|signal| signal.event_id == completion.id)
                .count(),
            1,
            "durable background terminal outcome must wake its owner through one Direct Signal"
        );

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
        let scheduler = Arc::new(
            BackgroundTaskScheduler::new_with_execution_jobs(
                Arc::clone(&bus),
                Arc::clone(&store) as Arc<dyn EventStore>,
                Arc::clone(&timers),
                Arc::clone(&manager),
            )
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
        );
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
                None,
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
        assert_eq!(
            scheduler
                .recover_terminal_background_outboxes()
                .await
                .unwrap(),
            0,
            "replaying startup recovery must not arm a duplicate Thread Signal"
        );
        let owner = store.get_thread(&parent.thread_id).await.unwrap().unwrap();
        let owner = match store
            .update_thread(
                &owner.id,
                owner.revision,
                None,
                Some(ThreadLifecycle::Completed),
                None,
                None,
                None,
                None,
            )
            .await
            .unwrap()
        {
            ThreadMutation::Updated(thread) => thread,
            other => panic!("unexpected Thread mutation: {other:?}"),
        };
        assert_eq!(owner.lifecycle, ThreadLifecycle::Completed);
        assert_eq!(
            scheduler
                .recover_terminal_background_outboxes()
                .await
                .unwrap(),
            0,
            "startup recovery must not redeliver historical background results to a terminal Thread"
        );
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
            0,
            "direct terminal recovery must not leave a second pending transport envelope"
        );
        assert_eq!(
            store
                .list_context_thread_signals(&parent.context_id, None)
                .await
                .unwrap()
                .into_iter()
                .filter(|signal| signal.event_id == lost_event_id)
                .count(),
            1,
            "the immutable background outcome must materialize exactly one Thread Signal"
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
    async fn restart_closes_cancel_requested_background_when_local_process_is_absent() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(database.path().to_string_lossy().as_ref())
                .await
                .unwrap(),
        );
        let bus = Arc::new(InMemoryEventBus::new());
        let timers = Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>));
        let manager = Arc::new(ExecutionJobManager::new(
            Arc::clone(&store) as Arc<dyn ExecutionJobStore>
        ));
        let scheduler = Arc::new(
            BackgroundTaskScheduler::new_with_execution_jobs(
                Arc::clone(&bus),
                Arc::clone(&store) as Arc<dyn EventStore>,
                timers,
                Arc::clone(&manager),
            )
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
        );
        let parent = ToolExecutionJobContext {
            parent_job_id: deterministic_job_id(
                "activation-cancelled-restart-background",
                "exec-call-cancelled-restart-background",
            )
            .unwrap(),
            activation_id: "activation-cancelled-restart-background".to_string(),
            thread_id: "thread-cancelled-restart-background".to_string(),
            agent_id: "agent-cancelled-restart-background".to_string(),
            context_id: "context-cancelled-restart-background".to_string(),
            session_id: "session-cancelled-restart-background".to_string(),
            initiating_principal_id: None,
            target_id: crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
            tool_call_id: "exec-call-cancelled-restart-background".to_string(),
        };
        seed_test_execution_route(
            &store,
            &parent,
            "root-cancelled-restart-background",
            "trigger-cancelled-restart-background",
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
                    "command": "cancelled-before-restart",
                    "process_group_id": i32::MAX,
                    "artifact_path": "/tmp/cancelled-restart-background.log",
                    "started_at": chrono::Utc::now(),
                    "effective_boundary": {}
                }),
                retry_safety: ExecutionRetrySafety::ReconcileRequired,
                requires_approval: false,
            })
            .await
            .unwrap();
        let claim_token = "cancelled-restart-background-claim";
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
                        progress_ref: Some("/tmp/cancelled-restart-background.log"),
                    },
                )
                .await
                .unwrap(),
            "side-effect boundary",
        )
        .unwrap();
        let cancellation = scheduler
            .request_cancel_and_signal(&job.id, &parent.context_id)
            .await
            .expect("a peer Runtime must durably request cancellation without a local PGID");
        assert_eq!(cancellation["status"], "cancel_requested");
        assert_eq!(cancellation["owner_local"], false);
        assert_eq!(cancellation["reason"], "owned_by_another_runtime");
        job = store.get_execution_job(&job.id).await.unwrap().unwrap();
        assert_eq!(job.status, ExecutionJobStatus::Running);
        assert!(job.cancel_requested_at.is_some());
        assert!(job
            .lease_expires_at
            .is_some_and(|lease| lease > chrono::Utc::now()));

        let recovery = manager
            .reconcile_startup(
                crate::memory::WorkerCoordinationMode::SharedHostLeases,
                store.as_ref(),
                None,
            )
            .await
            .unwrap();
        assert_eq!(recovery.recovered_receipts.len(), 1);
        let terminal = store.get_execution_job(&task_id).await.unwrap().unwrap();
        assert_eq!(terminal.status, ExecutionJobStatus::Cancelled);
        assert_eq!(
            scheduler
                .recover_terminal_background_outboxes()
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            scheduler
                .recover_terminal_background_outboxes()
                .await
                .unwrap(),
            0,
            "replaying cancelled recovery must not arm a duplicate Thread Signal"
        );
        let event_id = terminal.result_event_id.unwrap();
        let event = store
            .query(QueryFilter {
                event_id: Some(event_id.clone()),
                ..Default::default()
            })
            .await
            .unwrap()
            .pop()
            .expect("cancelled recovery event");
        assert_eq!(event.payload["task_status"], "cancelled");
        assert_eq!(
            store
                .list_context_thread_signals(&parent.context_id, None)
                .await
                .unwrap()
                .iter()
                .filter(|signal| signal.event_id == event_id)
                .count(),
            1,
            "the repaired terminal fact must release the exact owning Thread wait"
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
                None,
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
            model_attempt_id: None,
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
        let (background_scheduler, _database, store) =
            start_test_background_scheduler(Arc::clone(&bus)).await;
        store
            .ensure_agent(NewAgent {
                id: "wait-rearm-agent".to_string(),
                title: "Wait rearm agent".to_string(),
                root_context_id: "wait-rearm-context".to_string(),
            })
            .await
            .unwrap();
        store
            .ensure_context(NewCognitiveContext {
                id: "wait-rearm-context".to_string(),
                agent_id: "wait-rearm-agent".to_string(),
                title: "Wait rearm context".to_string(),
            })
            .await
            .unwrap();
        store
            .ensure_session(NewSession {
                id: "wait-rearm-session".to_string(),
                agent_id: "wait-rearm-agent".to_string(),
                context_id: "wait-rearm-context".to_string(),
                parent_session_id: None,
                title: "Wait rearm session".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        store
            .ensure_thread(NewThread {
                id: "wait-rearm-thread".to_string(),
                agent_id: "wait-rearm-agent".to_string(),
                context_id: "wait-rearm-context".to_string(),
                session_id: "wait-rearm-session".to_string(),
                initiating_principal_id: None,
                root_turn_id: "wait-rearm-root".to_string(),
                kind: ThreadKind::Execution,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: crate::memory::ThreadSupervision::legacy(),
            })
            .await
            .unwrap();
        if let Some(mut task) = get_tasks_map().get_mut(&task_id) {
            task.causal_route = Some(ToolCausalRoute {
                thread_id: "wait-rearm-thread".to_string(),
                activation_id: "wait-rearm-activation".to_string(),
                model_attempt_id: None,
                root_turn_id: "wait-rearm-root".to_string(),
                trigger_event_id: "wait-rearm-trigger".to_string(),
                trigger_sequence: 1,
            });
        }
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
    async fn restart_recovers_terminal_result_after_owner_thread_completed() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(database.path().to_string_lossy().as_ref())
                .await
                .unwrap(),
        );
        let bus = Arc::new(InMemoryEventBus::new());
        let (sender, mut receiver) = tokio::sync::mpsc::channel(2);
        bus.subscribe(
            "runtime/background_wake".to_string(),
            Arc::new(move |event| {
                let sender = sender.clone();
                Box::pin(async move { sender.send(event).await.map_err(|error| error.into()) })
            }),
        );
        let timers = Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>));
        let manager = Arc::new(ExecutionJobManager::new(
            Arc::clone(&store) as Arc<dyn ExecutionJobStore>
        ));
        let scheduler = Arc::new(
            BackgroundTaskScheduler::new_with_execution_jobs(
                Arc::clone(&bus),
                Arc::clone(&store) as Arc<dyn EventStore>,
                timers,
                Arc::clone(&manager),
            )
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
        );
        let parent = ToolExecutionJobContext {
            parent_job_id: deterministic_job_id(
                "activation-terminal-owner-recovery",
                "exec-call-terminal-owner-recovery",
            )
            .unwrap(),
            activation_id: "activation-terminal-owner-recovery".to_string(),
            thread_id: "thread-terminal-owner-recovery".to_string(),
            agent_id: "agent-terminal-owner-recovery".to_string(),
            context_id: "context-terminal-owner-recovery".to_string(),
            session_id: "session-terminal-owner-recovery".to_string(),
            initiating_principal_id: None,
            target_id: crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
            tool_call_id: "exec-call-terminal-owner-recovery".to_string(),
        };
        seed_test_execution_route(
            &store,
            &parent,
            "root-terminal-owner-recovery",
            "trigger-terminal-owner-recovery",
        )
        .await;
        let child_tool_call_id = format!("{}:background", parent.tool_call_id);
        let mut job = manager
            .ensure(ExecutionJobSpec {
                activation_id: parent.activation_id.clone(),
                thread_id: parent.thread_id.clone(),
                agent_id: parent.agent_id.clone(),
                context_id: parent.context_id.clone(),
                session_id: parent.session_id.clone(),
                initiating_principal_id: None,
                target_id: parent.target_id.clone(),
                tool_call_id: child_tool_call_id,
                tool_name: "exec/background".to_string(),
                request: serde_json::json!({
                    "kind": "background_exec",
                    "task_id": "terminal-owner-recovery",
                    "command": "completed-before-wake",
                    "process_group_id": 454545,
                    "artifact_path": "/tmp/terminal-owner-recovery.log",
                    "started_at": chrono::Utc::now(),
                    "effective_boundary": {}
                }),
                retry_safety: ExecutionRetrySafety::ReconcileRequired,
                requires_approval: false,
            })
            .await
            .unwrap();
        let claim_token = "terminal-owner-recovery-claim";
        job = applied_background_job(
            manager
                .claim(
                    &job.id,
                    job.revision,
                    JobClaim {
                        worker_id: "crashed-runtime",
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
        let owner = store.get_thread(&parent.thread_id).await.unwrap().unwrap();
        assert!(matches!(
            store
                .update_thread(
                    &owner.id,
                    owner.revision,
                    None,
                    Some(ThreadLifecycle::Completed),
                    Some("turn completed before detached result"),
                    None,
                    None,
                    None,
                )
                .await
                .unwrap(),
            ThreadMutation::Updated(_)
        ));
        let result_event = Event::new(
            format!("background_output_{}", job.id),
            "System-TaskMonitor".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            serde_json::json!({
                "context_id": job.context_id.clone(),
                "session_id": job.session_id.clone(),
                "activation_id": job.activation_id.clone(),
                "thread_id": job.thread_id.clone(),
                "tool_call_id": job.tool_call_id.clone(),
                "tool_name": job.tool_name.clone(),
                "task_id": job.id.clone(),
                "task_status": "succeeded",
                "process_status": "succeeded",
                "exit_code": 0,
                "text": ""
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        applied_background_job(
            manager
                .finish_with_event(
                    &job.id,
                    job.revision,
                    job.claim_token.as_deref(),
                    JobOutcome::Succeeded {
                        result_event_id: Some(result_event.id.clone()),
                        result_refs: Vec::new(),
                        exit_code: Some(0),
                    },
                    &result_event,
                    false,
                )
                .await
                .unwrap(),
            "terminal result without wake",
        )
        .unwrap();

        assert_eq!(
            scheduler
                .recover_terminal_background_outboxes()
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            scheduler
                .recover_terminal_background_outboxes()
                .await
                .unwrap(),
            0
        );
        let wake = tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
            .await
            .expect("startup recovery must publish the persisted Session wake")
            .expect("wake receiver must remain open");
        assert_eq!(wake.payload["wake_kind"], "terminal_result");
        assert_eq!(wake.payload["result_event_id"], result_event.id);
        assert_eq!(wake.payload["source_thread_id"], parent.thread_id);
    }

    #[tokio::test]
    async fn peer_runtime_can_deliver_background_checkpoint_without_live_process_handle() {
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
        let scheduler = Arc::new(
            BackgroundTaskScheduler::new_with_execution_jobs(
                Arc::clone(&bus),
                Arc::clone(&store) as Arc<dyn EventStore>,
                Arc::clone(&timers),
                Arc::clone(&manager),
            )
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
        );
        let parent = ToolExecutionJobContext {
            parent_job_id: deterministic_job_id(
                "activation-peer-checkpoint",
                "exec-call-peer-checkpoint",
            )
            .unwrap(),
            activation_id: "activation-peer-checkpoint".to_string(),
            thread_id: "thread-peer-checkpoint".to_string(),
            agent_id: "agent-peer-checkpoint".to_string(),
            context_id: "context-peer-checkpoint".to_string(),
            session_id: "session-peer-checkpoint".to_string(),
            initiating_principal_id: None,
            target_id: crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
            tool_call_id: "exec-call-peer-checkpoint".to_string(),
        };
        seed_test_execution_route(
            &store,
            &parent,
            "root-peer-checkpoint",
            "trigger-peer-checkpoint",
        )
        .await;
        let child_tool_call_id = format!("{}:background", parent.tool_call_id);
        let task_id = deterministic_job_id(&parent.activation_id, &child_tool_call_id).unwrap();
        let mut job = manager
            .ensure(ExecutionJobSpec {
                activation_id: parent.activation_id.clone(),
                thread_id: parent.thread_id.clone(),
                agent_id: parent.agent_id.clone(),
                context_id: parent.context_id.clone(),
                session_id: parent.session_id.clone(),
                initiating_principal_id: None,
                target_id: parent.target_id.clone(),
                tool_call_id: child_tool_call_id,
                tool_name: "exec/background".to_string(),
                request: serde_json::json!({
                    "kind": "background_exec",
                    "task_id": task_id,
                    "command": "peer-owned-service",
                    "process_group_id": 424242,
                    "started_at": chrono::Utc::now(),
                    "artifact_path": "/tmp/peer-owned-service.log",
                    "effective_boundary": {}
                }),
                retry_safety: ExecutionRetrySafety::ReconcileRequired,
                requires_approval: false,
            })
            .await
            .unwrap();
        let claim_token = "peer-owned-background-claim";
        job = applied_background_job(
            manager
                .claim(
                    &job.id,
                    job.revision,
                    JobClaim {
                        worker_id: "peer-runtime",
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
        applied_background_job(
            manager
                .heartbeat(
                    &job.id,
                    job.revision,
                    JobHeartbeat {
                        claim_token,
                        lease_expires_at: chrono::Utc::now() + chrono::Duration::minutes(2),
                        side_effect_started_at: Some(chrono::Utc::now()),
                        progress_ref: Some("/tmp/peer-owned-service.log"),
                    },
                )
                .await
                .unwrap(),
            "side-effect boundary",
        )
        .unwrap();
        get_tasks_map().remove(&task_id);

        let registration = store
            .register_background_checkpoint(&job.id, 1, "peer-runtime-test")
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(1_050)).await;
        let timer = store
            .get_runtime_timer(&registration.timer_id)
            .await
            .unwrap()
            .expect("registered background wake timer must exist");
        assert_eq!(
            Arc::clone(&scheduler).dispatch_timer(timer).await.unwrap(),
            TimerDisposition::Complete
        );
        let checkpoint = tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
            .await
            .expect("peer Runtime must deliver the durable checkpoint")
            .expect("checkpoint channel must remain open");
        assert_eq!(checkpoint.payload["event"], "background_task_check_due");
        assert_eq!(checkpoint.payload["task_status"], "running");
        assert_eq!(checkpoint.payload["live_owner"], false);
        assert_eq!(checkpoint.payload["thread_id"], parent.thread_id);
        assert_eq!(checkpoint.payload["activation_id"], parent.activation_id);
        assert!(store
            .get_execution_job(&job.id)
            .await
            .unwrap()
            .unwrap()
            .checkpoint_due_at
            .is_none());
        assert_eq!(
            store
                .list_context_thread_signals(&parent.context_id, None)
                .await
                .unwrap()
                .into_iter()
                .filter(|signal| signal.event_id == checkpoint.id)
                .count(),
            1
        );
    }

    /// Regression for the check-task-wake bug (Mind frames
    /// check-task-wake-audit-v1 / check-task-wake-fix-design-v1).
    ///
    /// Normal usage arms a background checkpoint and then ends the turn with
    /// a terminal reply, which completes the owning Execution Thread. When
    /// the checkpoint timer later becomes due, the dispatch path must not
    /// silently discard it just because the owning Thread is terminal; the
    /// checkpoint must escalate to the owning Session as a fresh wake.
    ///
    /// This test pins the desired contract: it fails while the suppression
    /// bug exists (no Event is ever dispatched, so the receive times out)
    /// and passes once Thread -> Session escalation is implemented.
    #[tokio::test]
    async fn terminal_thread_background_checkpoint_escalates_to_session() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(database.path().to_string_lossy().as_ref())
                .await
                .unwrap(),
        );
        let bus = Arc::new(InMemoryEventBus::new());
        let (sender, mut receiver) = tokio::sync::mpsc::channel(2);
        bus.subscribe(
            "runtime/background_wake".to_string(),
            Arc::new(move |event| {
                let sender = sender.clone();
                Box::pin(async move { sender.send(event).await.map_err(|error| error.into()) })
            }),
        );
        let timers = Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>));
        let manager = Arc::new(ExecutionJobManager::new(
            Arc::clone(&store) as Arc<dyn ExecutionJobStore>
        ));
        let scheduler = Arc::new(
            BackgroundTaskScheduler::new_with_execution_jobs(
                Arc::clone(&bus),
                Arc::clone(&store) as Arc<dyn EventStore>,
                Arc::clone(&timers),
                Arc::clone(&manager),
            )
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
        );
        let parent = ToolExecutionJobContext {
            parent_job_id: deterministic_job_id(
                "activation-terminal-escalation",
                "exec-call-terminal-escalation",
            )
            .unwrap(),
            activation_id: "activation-terminal-escalation".to_string(),
            thread_id: "thread-terminal-escalation".to_string(),
            agent_id: "agent-terminal-escalation".to_string(),
            context_id: "context-terminal-escalation".to_string(),
            session_id: "session-terminal-escalation".to_string(),
            initiating_principal_id: None,
            target_id: crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
            tool_call_id: "exec-call-terminal-escalation".to_string(),
        };
        seed_test_execution_route(
            &store,
            &parent,
            "root-terminal-escalation",
            "trigger-terminal-escalation",
        )
        .await;

        // The owning Thread completes after the background work was
        // launched. This is the exact production shape of the bug: the turn
        // ends with a terminal reply while the task checkpoint is still
        // armed.
        let owning_thread = store.get_thread(&parent.thread_id).await.unwrap().unwrap();
        store
            .update_thread(
                &parent.thread_id,
                owning_thread.revision,
                None,
                Some(crate::memory::ThreadLifecycle::Completed),
                Some("turn ended while the background task kept running"),
                None,
                None,
                None,
            )
            .await
            .unwrap();

        let child_tool_call_id = format!("{}:background", parent.tool_call_id);
        let task_id = deterministic_job_id(&parent.activation_id, &child_tool_call_id).unwrap();
        let mut job = manager
            .ensure(ExecutionJobSpec {
                activation_id: parent.activation_id.clone(),
                thread_id: parent.thread_id.clone(),
                agent_id: parent.agent_id.clone(),
                context_id: parent.context_id.clone(),
                session_id: parent.session_id.clone(),
                initiating_principal_id: None,
                target_id: parent.target_id.clone(),
                tool_call_id: child_tool_call_id,
                tool_name: "exec/background".to_string(),
                request: serde_json::json!({
                    "kind": "background_exec",
                    "task_id": task_id,
                    "command": "terminal-escalation-service",
                    "process_group_id": 434343,
                    "started_at": chrono::Utc::now(),
                    "artifact_path": "/tmp/terminal-escalation-service.log",
                    "effective_boundary": {}
                }),
                retry_safety: ExecutionRetrySafety::ReconcileRequired,
                requires_approval: false,
            })
            .await
            .unwrap();
        let claim_token = "terminal-escalation-background-claim";
        job = applied_background_job(
            manager
                .claim(
                    &job.id,
                    job.revision,
                    JobClaim {
                        worker_id: "owner-runtime",
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
        applied_background_job(
            manager
                .heartbeat(
                    &job.id,
                    job.revision,
                    JobHeartbeat {
                        claim_token,
                        lease_expires_at: chrono::Utc::now() + chrono::Duration::minutes(2),
                        side_effect_started_at: Some(chrono::Utc::now()),
                        progress_ref: Some("/tmp/terminal-escalation-service.log"),
                    },
                )
                .await
                .unwrap(),
            "side-effect boundary",
        )
        .unwrap();
        get_tasks_map().remove(&task_id);

        // Arm the checkpoint through the durable composite Job+Timer
        // registration: ExecutionJob.checkpoint_generation/checkpoint_due_at
        // and the physical runtime_timers row commit in one transaction.
        let registration = store
            .register_background_checkpoint(&job.id, 1, "terminal-escalation-regression")
            .await
            .unwrap();
        let timer = store
            .get_runtime_timer(&registration.timer_id)
            .await
            .unwrap()
            .expect("registered background wake timer must exist");
        tokio::time::sleep(std::time::Duration::from_millis(1_050)).await;
        assert_eq!(
            Arc::clone(&scheduler).dispatch_timer(timer).await.unwrap(),
            TimerDisposition::Complete
        );

        // Desired contract: the due checkpoint escalates to the owning
        // Session as a fresh Runtime Wake DialogueTurn instead of being
        // discarded by the terminal-owning-Thread branch.
        let checkpoint = tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
            .await
            .expect(
                "a due background checkpoint must not be silently discarded when its owning Thread is terminal; it must escalate to the owning Session (check-task-wake-fix-design-v1)",
            )
            .expect("checkpoint channel must remain open");
        assert_eq!(checkpoint.topic, "runtime/background_wake");
        assert_eq!(checkpoint.payload["event"], "background_task_check_due");
        assert_eq!(checkpoint.payload["task_status"], "running");
        assert_eq!(checkpoint.payload["execution_job_id"], job.id);
        assert_eq!(checkpoint.payload["session_id"], parent.session_id);
        assert_eq!(checkpoint.payload["context_id"], parent.context_id);
        assert_eq!(checkpoint.payload["source_thread_id"], parent.thread_id);
        assert_eq!(checkpoint.payload["wake_policy"], "session_fallback");
        assert!(checkpoint.payload.get("thread_id").is_none());
        assert!(checkpoint.payload.get("activation_id").is_none());
        assert!(checkpoint.payload.get("root_turn_id").is_none());
        assert!(store
            .get_execution_job(&job.id)
            .await
            .unwrap()
            .unwrap()
            .checkpoint_due_at
            .is_none());
        // The wake Event becomes its own DialogueTurn root with exactly one
        // pending Signal; the terminal Thread survives only as provenance.
        let wake_signal_count = store
            .list_context_thread_signals(&parent.context_id, None)
            .await
            .unwrap()
            .into_iter()
            .filter(|signal| signal.event_id == checkpoint.id)
            .count();
        assert_eq!(wake_signal_count, 1);

        // Escalation must never revive the completed owning Thread.
        let owning_after = store.get_thread(&parent.thread_id).await.unwrap().unwrap();
        assert_eq!(owning_after.lifecycle.as_str(), "completed");
    }

    #[tokio::test]
    async fn terminal_supervisor_owned_child_checkpoint_is_not_session_escalated() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(database.path().to_string_lossy().as_ref())
                .await
                .unwrap(),
        );
        let bus = Arc::new(InMemoryEventBus::new());
        let (sender, mut receiver) = tokio::sync::mpsc::channel(4);
        {
            let sender = sender.clone();
            bus.subscribe(
                "chat/tool_output".to_string(),
                Arc::new(move |event| {
                    let sender = sender.clone();
                    Box::pin(async move { sender.send(event).await.map_err(|error| error.into()) })
                }),
            );
        }
        bus.subscribe(
            "runtime/background_wake".to_string(),
            Arc::new(move |event| {
                let sender = sender.clone();
                Box::pin(async move { sender.send(event).await.map_err(|error| error.into()) })
            }),
        );
        let timers = Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>));
        let manager = Arc::new(ExecutionJobManager::new(
            Arc::clone(&store) as Arc<dyn ExecutionJobStore>
        ));
        let scheduler = Arc::new(
            BackgroundTaskScheduler::new_with_execution_jobs(
                Arc::clone(&bus),
                Arc::clone(&store) as Arc<dyn EventStore>,
                Arc::clone(&timers),
                Arc::clone(&manager),
            )
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
        );
        let parent = ToolExecutionJobContext {
            parent_job_id: deterministic_job_id(
                "activation-attached-checkpoint",
                "exec-call-attached-checkpoint",
            )
            .unwrap(),
            activation_id: "activation-attached-checkpoint".to_string(),
            thread_id: "thread-attached-checkpoint".to_string(),
            agent_id: "agent-attached-checkpoint".to_string(),
            context_id: "context-attached-checkpoint".to_string(),
            session_id: "session-attached-checkpoint".to_string(),
            initiating_principal_id: None,
            target_id: crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
            tool_call_id: "exec-call-attached-checkpoint".to_string(),
        };
        seed_test_execution_route_with(
            &store,
            &parent,
            "root-attached-checkpoint",
            "trigger-attached-checkpoint",
            ThreadSupervision::attached(
                "thread-attached-supervisor",
                1,
                "eval-attached-checkpoint",
            ),
        )
        .await;

        let owning_thread = store.get_thread(&parent.thread_id).await.unwrap().unwrap();
        assert_eq!(
            owning_thread.supervision.supervisor_kind,
            ThreadSupervisorKind::Thread
        );
        store
            .update_thread(
                &parent.thread_id,
                owning_thread.revision,
                None,
                Some(crate::memory::ThreadLifecycle::Completed),
                Some("attached child completed while the background task kept running"),
                None,
                None,
                None,
            )
            .await
            .unwrap();

        let child_tool_call_id = format!("{}:background", parent.tool_call_id);
        let task_id = deterministic_job_id(&parent.activation_id, &child_tool_call_id).unwrap();
        let mut job = manager
            .ensure(ExecutionJobSpec {
                activation_id: parent.activation_id.clone(),
                thread_id: parent.thread_id.clone(),
                agent_id: parent.agent_id.clone(),
                context_id: parent.context_id.clone(),
                session_id: parent.session_id.clone(),
                initiating_principal_id: None,
                target_id: parent.target_id.clone(),
                tool_call_id: child_tool_call_id,
                tool_name: "exec/background".to_string(),
                request: serde_json::json!({
                    "kind": "background_exec",
                    "task_id": task_id,
                    "command": "attached-checkpoint-service",
                    "process_group_id": 454545,
                    "started_at": chrono::Utc::now(),
                    "artifact_path": "/tmp/attached-checkpoint-service.log",
                    "effective_boundary": {}
                }),
                retry_safety: ExecutionRetrySafety::ReconcileRequired,
                requires_approval: false,
            })
            .await
            .unwrap();
        let claim_token = "attached-checkpoint-background-claim";
        job = applied_background_job(
            manager
                .claim(
                    &job.id,
                    job.revision,
                    JobClaim {
                        worker_id: "owner-runtime",
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
        applied_background_job(
            manager
                .heartbeat(
                    &job.id,
                    job.revision,
                    JobHeartbeat {
                        claim_token,
                        lease_expires_at: chrono::Utc::now() + chrono::Duration::minutes(2),
                        side_effect_started_at: Some(chrono::Utc::now()),
                        progress_ref: Some("/tmp/attached-checkpoint-service.log"),
                    },
                )
                .await
                .unwrap(),
            "side-effect boundary",
        )
        .unwrap();
        get_tasks_map().remove(&task_id);

        let registration = store
            .register_background_checkpoint(&job.id, 1, "attached-checkpoint-regression")
            .await
            .unwrap();
        let timer = store
            .get_runtime_timer(&registration.timer_id)
            .await
            .unwrap()
            .expect("registered background wake timer must exist");
        tokio::time::sleep(std::time::Duration::from_millis(1_050)).await;
        assert_eq!(
            Arc::clone(&scheduler).dispatch_timer(timer).await.unwrap(),
            TimerDisposition::Complete
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(150), receiver.recv())
                .await
                .is_err(),
            "a terminal supervisor-owned attached child must not Session-escalate a due checkpoint"
        );
        assert_eq!(
            store
                .list_context_thread_signals(&parent.context_id, None)
                .await
                .unwrap()
                .len(),
            0,
            "suppressed attached-child checkpoints must not create a DialogueTurn"
        );
        let owning_after = store.get_thread(&parent.thread_id).await.unwrap().unwrap();
        assert_eq!(owning_after.lifecycle.as_str(), "completed");
        let job_after = store.get_execution_job(&job.id).await.unwrap().unwrap();
        assert!(job_after.checkpoint_due_at.is_none());
        let audit_id = format!(
            "background_wake_audit_{}_g{}",
            job.id, registration.checkpoint_generation
        );
        assert_eq!(
            store
                .query(QueryFilter {
                    event_id: Some(audit_id),
                    ..Default::default()
                })
                .await
                .unwrap()
                .len(),
            1,
            "suppressed attached-child checkpoint must retain a durable reason"
        );
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

        let (background_scheduler, _database, _store) =
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
        assert!(output.contains("complete raw output"));
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
