use crate::approval::{ApprovalAction, ApprovalProvider, CapabilityDelta, DenyAllApprovalProvider};
use crate::config::BackgroundTaskConfig;
use crate::event::{Event, InMemoryEventBus, TYPE_AGENT_CALL, TYPE_FILE_CHANGE, TYPE_TOOL_OUTPUT};
use crate::llm::ToolDefinition;
use crate::memory::{
    EventStore, NewScheduledIntent, NewWorkThread, QueryFilter, ScheduledIntentRecord,
    ScheduledIntentStatus, SessionStatus, SessionStore, WorkThreadKind,
};
use crate::permission::{
    ApprovalContext, FilesystemAccess, PermissionBroker, PermissionConfig, PermissionProfile,
    SandboxMode, ShellEnvironmentPolicy,
};
use crate::sandbox::{
    EnforcementStatus, NativeSandbox, NetworkPolicy, SandboxPolicy, ShellRequest,
};
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
const DEPENDENCY_RECHECK_SECS: u64 = 2;

tokio::task_local! {
    pub static CURRENT_SESSION_ID: String;
    pub static CURRENT_CONTEXT_ID: String;
    pub static CURRENT_ATTEMPT_ID: String;
    pub static CURRENT_CAUSAL_ROUTE: Option<ToolCausalRoute>;
}

#[derive(Debug, Clone)]
pub struct ToolCausalRoute {
    pub work_thread_id: String,
    pub work_item_id: String,
    pub root_turn_id: String,
    pub trigger_event_id: String,
    pub trigger_sequence: u64,
}

fn extend_causal_route(
    payload: &mut serde_json::Map<String, serde_json::Value>,
    route: Option<&ToolCausalRoute>,
) {
    let Some(route) = route else {
        return;
    };
    payload.insert(
        "work_thread_id".to_string(),
        serde_json::json!(route.work_thread_id),
    );
    payload.insert(
        "work_item_id".to_string(),
        serde_json::json!(route.work_item_id),
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

fn approval_context() -> ApprovalContext {
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
    }
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
    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>>;
}

pub struct Registry {
    tools: RwLock<HashMap<String, RegisteredTool>>,
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

    pub fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(name)
            .map(|entry| Arc::clone(&entry.tool))
    }

    pub fn definitions(&self) -> Vec<ToolDefinition> {
        self.tools
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .map(|entry| entry.definition.clone())
            .collect()
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

/// Durable timer and dependency dispatcher for schedule_tx. Timers are only
/// wake sources: when they become due they append one directed observation to
/// the target Thread mailbox. They never run model logic themselves.
pub struct ThreadScheduler {
    bus: Arc<InMemoryEventBus>,
    sessions: Arc<dyn SessionStore>,
    events: Arc<dyn EventStore>,
    armed_revisions: DashMap<String, u64>,
}

impl ThreadScheduler {
    pub fn new(
        bus: Arc<InMemoryEventBus>,
        sessions: Arc<dyn SessionStore>,
        events: Arc<dyn EventStore>,
    ) -> Self {
        Self {
            bus,
            sessions,
            events,
            armed_revisions: DashMap::new(),
        }
    }

    pub async fn recover(self: &Arc<Self>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        for intent in self
            .sessions
            .list_scheduled_intents(None, Some(ScheduledIntentStatus::Queued))
            .await?
        {
            self.arm(intent);
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
                    .get_work_thread_by_root(root)
                    .await?
                    .is_some_and(|thread| thread.lifecycle.is_terminal()),
                None => true,
            };
            if !terminal {
                self.bus.dispatch_persisted(event).await?;
            }
        }
        Ok(())
    }

    pub fn arm(self: &Arc<Self>, intent: ScheduledIntentRecord) {
        let already_armed = self
            .armed_revisions
            .get(&intent.id)
            .is_some_and(|revision| *revision == intent.revision);
        if already_armed {
            return;
        }
        self.armed_revisions
            .insert(intent.id.clone(), intent.revision);
        let scheduler = Arc::clone(self);
        tokio::spawn(async move {
            let due_at = intent.not_before.unwrap_or_else(chrono::Utc::now);
            let delay = (due_at - chrono::Utc::now()).to_std().unwrap_or_default();
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            if let Err(error) = scheduler.dispatch(intent).await {
                tracing::error!(?error, "Scheduled Intent dispatch 失败");
            }
        });
    }

    async fn dispatch(
        self: Arc<Self>,
        expected: ScheduledIntentRecord,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(current) = self.sessions.get_scheduled_intent(&expected.id).await? else {
            self.armed_revisions.remove(&expected.id);
            return Ok(());
        };
        if current.status != ScheduledIntentStatus::Queued || current.revision != expected.revision
        {
            self.armed_revisions.remove(&expected.id);
            if current.status == ScheduledIntentStatus::Queued {
                self.arm(current);
            }
            return Ok(());
        }
        if let Some(not_before) = current.not_before {
            if not_before > chrono::Utc::now() {
                self.armed_revisions.remove(&current.id);
                self.arm(current);
                return Ok(());
            }
        }

        let mut dependency_states = serde_json::Map::new();
        let mut dependencies_ready = true;
        for dependency_id in &current.dependency_thread_ids {
            let state = self.sessions.get_work_thread(dependency_id).await?;
            let status = state
                .as_ref()
                .map(|thread| thread.lifecycle.as_str())
                .unwrap_or("missing");
            dependency_states.insert(dependency_id.clone(), serde_json::json!(status));
            dependencies_ready &= state.is_some_and(|thread| thread.lifecycle.is_terminal());
        }
        if !dependencies_ready {
            self.armed_revisions.remove(&current.id);
            let scheduler = Arc::clone(&self);
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(DEPENDENCY_RECHECK_SECS)).await;
                scheduler.arm(current);
            });
            return Ok(());
        }

        let occurrence_revision = current.revision;
        let next_not_before = current.interval_seconds.map(|seconds| {
            chrono::Utc::now()
                + chrono::Duration::seconds(i64::try_from(seconds).unwrap_or(i64::MAX))
        });
        let owner = self
            .sessions
            .get_work_thread(&current.thread_id)
            .await?
            .ok_or_else(|| format!("Scheduled Intent '{}' 的目标 Thread 不存在", current.id))?;
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
            ("root_turn_id".to_string(), serde_json::json!(root_turn_id)),
            (
                "scheduled_intent_id".to_string(),
                serde_json::json!(current.id),
            ),
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
            self.armed_revisions.remove(&current.id);
            return Ok(());
        };
        self.armed_revisions.remove(&current.id);
        self.bus.dispatch_persisted(event).await?;
        if claimed.status == ScheduledIntentStatus::Queued {
            self.arm(claimed);
        }
        Ok(())
    }
}

pub struct ScheduleTxTool {
    scheduler: Arc<ThreadScheduler>,
    sessions: Arc<dyn SessionStore>,
}

impl ScheduleTxTool {
    pub fn new(scheduler: Arc<ThreadScheduler>, sessions: Arc<dyn SessionStore>) -> Self {
        Self {
            scheduler,
            sessions,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScheduleTxArgs {
    operations: Vec<ScheduleOperation>,
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
    },
}

#[async_trait::async_trait]
impl Tool for ScheduleTxTool {
    fn name(&self) -> &str {
        "schedule_tx"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().to_string(),
            description: "原子提交 Thread 调度计划。enqueue 把意图串行加入现有 Work Thread；spawn 创建可并行的新 Work Thread。not_before 或 delay_seconds 可设置一次性定时，spawn 的 every_seconds 可创建周期调度；after 指定依赖 Thread，只有依赖进入终态后才唤醒。定时到期只是向目标 Thread mailbox 投递 observation，不会绕过 Thread 再开执行分支。schedule_tx 必须是本次响应中唯一的工具调用。".to_string(),
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
                                        "after": {"type": "array", "items": {"type": "string"}}
                                    },
                                    "required": ["op", "intent"],
                                    "additionalProperties": false
                                }
                            ]
                        }
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
            .ok_or("schedule_tx 缺少当前 Work Thread 路由")?;
        let session = self
            .sessions
            .get_session(&session_id)
            .await?
            .ok_or("schedule_tx 当前 Session 不存在")?;
        if session.context_id != context_id {
            return Err("schedule_tx Session 与 Context 路由不一致".into());
        }
        let current_thread = self
            .sessions
            .get_work_thread(&route.work_thread_id)
            .await?
            .ok_or("schedule_tx 当前 Work Thread 不存在")?;

        let mut threads = Vec::new();
        let mut prepared = Vec::new();
        let mut local_refs = HashMap::<String, String>::new();
        for (index, operation) in args.operations.iter().enumerate() {
            if let ScheduleOperation::Spawn { client_id, .. } = operation {
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
                threads.push(NewWorkThread {
                    id: thread_id.clone(),
                    agent_id: session.agent_id.clone(),
                    context_id: context_id.clone(),
                    session_id: session_id.clone(),
                    root_turn_id,
                    kind: WorkThreadKind::Work,
                    executor_kind: "self".to_string(),
                    executor_id: None,
                });
                prepared.push(thread_id);
            } else {
                prepared.push(String::new());
            }
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
                        thread_id.unwrap_or_else(|| route.work_thread_id.clone()),
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
                };
            validate_schedule_intent(&intent)?;
            if not_before.is_some() && delay_seconds.is_some() {
                return Err("not_before 与 delay_seconds 只能提供一个".into());
            }
            let waits_for_future = not_before.is_some()
                || delay_seconds.is_some_and(|seconds| seconds > 0)
                || !after.is_empty();
            if target_thread_id == route.work_thread_id
                && current_thread.kind == WorkThreadKind::Dialogue
                && waits_for_future
            {
                return Err("Dialogue Thread 不能挂起等待未来时间或依赖；请使用 spawn 创建独立 Work Thread，再向当前 Session 回复调度结果".into());
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
            intents.push(NewScheduledIntent {
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
                if !newly_created
                    && self
                        .sessions
                        .get_work_thread(dependency_id)
                        .await?
                        .is_none()
                {
                    return Err(format!("依赖 Thread '{dependency_id}' 不存在").into());
                }
            }
        }
        let mut records = self
            .sessions
            .commit_schedule_transaction(&threads, &intents)
            .await?;
        for record in &mut records {
            let continues_current_thread = record.thread_id == route.work_thread_id
                && record.not_before.is_none()
                && record.interval_seconds.is_none()
                && record.dependency_thread_ids.is_empty();
            if continues_current_thread {
                if let Some(dispatched) = self
                    .sessions
                    .claim_scheduled_intent(&record.id, record.revision, None)
                    .await?
                {
                    *record = dispatched;
                }
            } else {
                self.scheduler.arm(record.clone());
            }
        }
        Ok(serde_json::json!({
            "status": "committed",
            "operations": records,
            "created_thread_ids": threads.iter().map(|thread| &thread.id).collect::<Vec<_>>(),
            "guidance": "调度计划已原子持久化。到期或依赖满足时，Runtime 会把 intent 作为 observation 投递到目标 Thread mailbox；当前 Evaluation 尚未结束。"
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
    pub causal_route: Option<ToolCausalRoute>,
    pub started_at: chrono::DateTime<chrono::Utc>,
    pub last_output_at: chrono::DateTime<chrono::Utc>,
    pub output_bytes: usize,
    pub output_tail: String,
    pub wake_generation: u64,
    pub next_wakeup_at: Option<chrono::DateTime<chrono::Utc>>,
    pub status: BackgroundTaskStatus,
    pub effective_network: bool,
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
        "work_item_id": task.causal_route.as_ref().map(|route| &route.work_item_id),
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
            "secret_env": task.secret_env,
            "sandbox_backend": task.sandbox_backend,
            "sandbox_status": task.sandbox_status,
        },
        "artifact_path": task.artifact_path,
    })
}

pub(crate) fn active_background_task_count(session_id: &str, context_id: &str) -> usize {
    get_tasks_map()
        .iter()
        .filter(|task| task.session_id == session_id && task.context_id == context_id)
        .filter(|task| !task.status.is_terminal())
        .count()
}

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
        .filter(|task| !task.status.is_terminal())
        .count()
}

const MAX_TASK_WAIT_SECS: u64 = 365 * 24 * 60 * 60;

fn schedule_background_task_wakeup(
    bus: Arc<crate::event::InMemoryEventBus>,
    task_id: &str,
    wait_secs: u64,
    wake_source: &'static str,
) -> Result<chrono::DateTime<chrono::Utc>, String> {
    if !(1..=MAX_TASK_WAIT_SECS).contains(&wait_secs) {
        return Err(format!("wait_secs 必须在 1 到 {MAX_TASK_WAIT_SECS} 秒之间"));
    }

    let task_id = task_id.to_string();
    let (generation, wakeup_at) = {
        let tasks = get_tasks_map();
        let mut task = tasks
            .get_mut(&task_id)
            .ok_or_else(|| format!("未找到后台任务 '{task_id}'，它可能已被历史保留策略清理"))?;
        if task.status.is_terminal() {
            return Err(format!("后台任务 '{task_id}' 已经结束，无需继续等待"));
        }
        task.wake_generation = task.wake_generation.wrapping_add(1);
        let generation = task.wake_generation;
        let wakeup_at = chrono::Utc::now()
            + chrono::Duration::seconds(i64::try_from(wait_secs).unwrap_or(i64::MAX));
        task.next_wakeup_at = Some(wakeup_at);
        (generation, wakeup_at)
    };

    tokio::spawn(async move {
        tokio::time::sleep(tokio::time::Duration::from_secs(wait_secs)).await;
        let payload = {
            let tasks = get_tasks_map();
            let Some(mut task) = tasks.get_mut(&task_id) else {
                return;
            };
            if task.status.is_terminal() || task.wake_generation != generation {
                return;
            }
            task.next_wakeup_at = None;
            let elapsed_secs = (chrono::Utc::now() - task.started_at).num_seconds().max(0);
            let output_tail = if task.output_tail.is_empty() {
                "（任务尚未产生输出）".to_string()
            } else {
                task.output_tail.clone()
            };
            let mut payload = serde_json::Map::new();
            payload.insert("context_id".to_string(), serde_json::json!(task.context_id));
            payload.insert("session_id".to_string(), serde_json::json!(task.session_id));
            payload.insert("tool_name".to_string(), serde_json::json!("wait_task"));
            payload.insert("task_id".to_string(), serde_json::json!(task.id));
            payload.insert(
                "event".to_string(),
                serde_json::json!("background_task_wait_elapsed"),
            );
            payload.insert("wake_source".to_string(), serde_json::json!(wake_source));
            payload.insert("wait_secs".to_string(), serde_json::json!(wait_secs));
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
                    "secret_env": task.secret_env,
                    "sandbox_backend": task.sandbox_backend,
                    "sandbox_status": task.sandbox_status,
                }),
            );
            payload.insert("text".to_string(), serde_json::json!(format!(
                "为后台任务 {} 安排的 {} 秒等待已经结束；任务仍在运行，Runtime 没有终止它。\n--- 最近输出 ---\n{}\n\n请自行决定：继续等待时调用 wait_task 并设置新的 wait_secs；不应继续时调用 kill_task。",
                task.id, wait_secs, output_tail
            )));
            extend_causal_route(&mut payload, task.causal_route.as_ref());
            payload
        };

        let event = Event::new(
            format!(
                "task_wait_elapsed_{}_{}",
                task_id,
                chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
            ),
            "System-TaskMonitor".to_string(),
            crate::event::TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            payload,
        );
        let _ = bus.publish(event).await;
    });

    Ok(wakeup_at)
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
    causal_route: Option<ToolCausalRoute>,
}

impl ExecutionBuffer {
    fn append(self: &Arc<Self>, text: &str, publish: bool) {
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
                self.archive_path, &*guard
            )
        } else {
            guard.clone()
        }
    }
}

async fn monitor_pipe<R>(reader: R, buffer: Arc<ExecutionBuffer>, publish_ref: Arc<AtomicBool>)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    while let Ok(n) = reader.read_line(&mut line).await {
        if n == 0 {
            break;
        }
        let publish = publish_ref.load(Ordering::SeqCst);
        buffer.append(&line, publish);
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
    permissions: Arc<PermissionBroker>,
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
        let max_sync_wait_ms = tool_timeout_secs
            .saturating_mul(1000)
            .saturating_sub(250)
            .max(100);
        Self {
            bus,
            background_config,
            permissions,
            sandbox: NativeSandbox::for_current_platform(),
            max_sync_wait: tokio::time::Duration::from_millis(max_sync_wait_ms),
        }
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
        if std::env::var_os(normalized).is_none() {
            return Err(format!("secret_env '{}' 在 Runtime 环境中不存在", normalized).into());
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecuteCommandArgs {
    command: String,
    cwd: Option<String>,
    wait_ms: Option<u64>,
    #[serde(default)]
    sandbox_permissions: SandboxPermissionMode,
    #[serde(default)]
    requested_permissions: RequestedExecPermissions,
    justification: Option<String>,
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
                "sandbox_permissions": {
                    "type": "string",
                    "enum": ["use_default", "require_escalated"],
                    "description": "默认 use_default，在当前原生沙箱内运行；只有任务确实需要额外网络或路径能力时才使用 require_escalated。"
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
            description: "在当前操作系统的原生沙箱中执行 Shell 命令，默认仅允许配置的工作区路径且禁止网络。适合运行测试、编译和格式化；文件发现优先使用 list_files/search，修改优先使用 edit/write。确需额外网络或目录时使用 require_escalated 申请最小能力，由独立审批者决定。命令等待超时后由 Runtime 转为后台托管；禁止通过 '&' 自行创建非托管后台进程。".to_string(),
            parameters: params_json,
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
        request_context.session_id = session_id.clone();
        request_context.context_id = context_id.clone();
        request_context.attempt_id = attempt_id.clone();

        use std::process::Stdio;
        let cwd_input = args.cwd.as_deref().unwrap_or(".");
        let profile = self.permissions.profile();
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
        let (prepared, effective_network, approved_secret_env) = if profile.sandbox_mode
            == SandboxMode::WorkspaceWrite
        {
            let mut policy = SandboxPolicy {
                read_roots: profile.read_roots.clone(),
                write_roots: profile.write_roots.clone(),
                denied_read_paths: Vec::new(),
                denied_write_paths: Vec::new(),
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
            let protected = profile.existing_protected_paths(&policy.read_roots);
            for path in protected {
                policy.deny_path(path);
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
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if profile.shell_environment_policy == ShellEnvironmentPolicy::RemoveSensitive {
            for (key, _) in std::env::vars() {
                if is_sensitive_environment_name(&key) {
                    cmd.env_remove(key);
                }
            }
        }
        let effective_secret_env = approved_secret_env.clone();
        let mut injected_secret_values = Vec::new();
        for name in approved_secret_env {
            if let Some(value) = std::env::var_os(&name) {
                if let Some(value) = value.to_str().filter(|value| !value.is_empty()) {
                    injected_secret_values.push(value.to_string());
                }
                cmd.env(name, value);
            }
        }

        // 必须通过 pre_exec 分配独立的进程组，以便于进程组强杀
        unsafe {
            cmd.pre_exec(|| {
                let pid = nix::libc::getpid();
                nix::libc::setpgid(pid, pid);
                Ok(())
            });
        }

        let artifact_dir = std::path::PathBuf::from(&self.background_config.artifact_dir);
        std::fs::create_dir_all(&artifact_dir).map_err(|error| {
            format!(
                "无法创建 exec 原始输出归档目录 '{}': {}",
                artifact_dir.display(),
                error
            )
        })?;

        let mut child = cmd.spawn()?;
        let pid = child.id().ok_or("无法获取进程 ID")? as i32;

        let task_id = format!(
            "task_{}_{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
            pid
        );
        let archive_path = artifact_dir.join(format!("{}.log", task_id));
        let archive = match std::fs::File::create(&archive_path) {
            Ok(archive) => archive,
            Err(error) => {
                let _ = child.kill().await;
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
            causal_route: causal_route.clone(),
        });

        // 共享的“是否开启事件发布”标志 (前 N 秒同步时不发布，转入后台时才发布)
        let publish_flag = Arc::new(AtomicBool::new(false));

        let buffer_out = Arc::clone(&buffer);
        let publish_out = Arc::clone(&publish_flag);
        let stdout_task = tokio::spawn(async move {
            monitor_pipe(stdout, buffer_out, publish_out).await;
        });

        let buffer_err = Arc::clone(&buffer);
        let publish_err = Arc::clone(&publish_flag);
        let stderr_task = tokio::spawn(async move {
            monitor_pipe(stderr, buffer_err, publish_err).await;
        });

        // 将任务先行放入全局的任务 Map 以供超时或手动 kill
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
                causal_route: causal_route.clone(),
                started_at: now,
                last_output_at: now,
                output_bytes: 0,
                output_tail: String::new(),
                wake_generation: 0,
                next_wakeup_at: None,
                status: BackgroundTaskStatus::Starting,
                effective_network,
                secret_env: effective_secret_env.clone(),
                sandbox_backend: sandbox_backend.clone(),
                sandbox_status: sandbox_status.clone(),
                artifact_path: buffer.archive_path.clone(),
                ended_at: None,
                exit_code: None,
            },
        );

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
                        "secret_env": effective_secret_env,
                        "sandbox_backend": sandbox_backend,
                        "sandbox_status": sandbox_status,
                    },
                    "artifact_path": buffer.archive_path,
                    "output_empty": output_str.is_empty(),
                    "output": output_str,
                })
                .to_string())
            }
            Err(_) => {
                // 运行超时，正式脱离 (Detach) 为后台长任务
                publish_flag.store(true, Ordering::SeqCst);
                if let Some(mut task) = tasks.get_mut(&task_id) {
                    task.status = BackgroundTaskStatus::Running;
                }

                // 后台任务达到默认检查点时只唤醒 LLM，不自动 kill。Agent 后续可以通过
                // wait_task(wait_secs=...) 覆盖下一次唤醒时间，或调用 kill_task。
                if self.background_config.timeout_notify_enabled {
                    let _ = schedule_background_task_wakeup(
                        Arc::clone(&self.bus),
                        &task_id,
                        self.background_config.timeout_notify_secs.max(1),
                        "runtime_default",
                    );
                }

                // 启动一个后台协程，在进程最终退出时清理 map 并发送完成事件通知大模型
                let bus_cleanup = Arc::clone(&self.bus);
                let task_id_cleanup = task_id.clone();
                let session_id_cleanup = session_id.clone();
                let context_id_cleanup = context_id.clone();
                let buffer_cleanup = Arc::clone(&buffer);
                tokio::spawn(async move {
                    let wait_res = child.wait().await;
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
                    let final_status = if tasks_cleanup
                        .get(&task_id_cleanup)
                        .is_some_and(|task| task.status == BackgroundTaskStatus::KillRequested)
                    {
                        BackgroundTaskStatus::Killed
                    } else if code == 0 {
                        BackgroundTaskStatus::Succeeded
                    } else {
                        BackgroundTaskStatus::Failed
                    };
                    if let Some(mut task) = tasks_cleanup.get_mut(&task_id_cleanup) {
                        task.status = final_status;
                        task.exit_code = Some(code);
                        task.ended_at = Some(chrono::Utc::now());
                        task.wake_generation = task.wake_generation.wrapping_add(1);
                        task.next_wakeup_at = None;
                    }
                    let effective_boundary = tasks_cleanup.get(&task_id_cleanup).map(|task| {
                        serde_json::json!({
                            "network_enabled": task.effective_network,
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
                        "secret_env": effective_secret_env,
                        "sandbox_backend": sandbox_backend,
                        "sandbox_status": sandbox_status,
                    },
                    "artifact_path": buffer.archive_path,
                    "output_empty": output_str.is_empty(),
                    "output": output_str,
                    "guidance": "任务完成或默认检查时间到达会通过 Inbox 主动唤醒；不要用 sleep、ps 或重复读取空日志轮询。可调用 task_status 查看一次，或用 wait_task.wait_secs 安排下一次唤醒；不应继续时调用 kill_task。",
                })
                .to_string())
            }
        }
    }
}

// ==========================================
// 5. Background task control plane
// ==========================================
pub struct ListTasksTool;
pub struct TaskStatusTool;
pub struct WaitTaskTool {
    bus: Arc<crate::event::InMemoryEventBus>,
    default_wait_secs: u64,
}
pub struct KillTaskTool;

impl WaitTaskTool {
    pub fn new(bus: Arc<crate::event::InMemoryEventBus>, default_wait_secs: u64) -> Self {
        Self {
            bus,
            default_wait_secs: default_wait_secs.clamp(1, MAX_TASK_WAIT_SECS),
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
struct WaitTaskArgs {
    task_id: String,
    wait_secs: Option<u64>,
}

#[async_trait::async_trait]
impl Tool for TaskStatusTool {
    fn name(&self) -> &str {
        "task_status"
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
        let task = require_visible_task(&args.task_id)?;
        Ok(serde_json::json!({
            "kind": "background_task_status",
            "task": background_task_snapshot(&task),
        })
        .to_string())
    }
}

#[async_trait::async_trait]
impl Tool for WaitTaskTool {
    fn name(&self) -> &str {
        "wait_task"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().to_string(),
            description: "为后台任务安排下一次事件驱动唤醒。该调用不会轮询或占用 LLM，也不会终止任务；wait_secs 到期或任务结束时 Runtime 会主动唤醒。届时可继续设置新的等待时间，或调用 kill_task。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "要等待的后台任务 ID。"
                    },
                    "wait_secs": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_TASK_WAIT_SECS,
                        "description": "多久后重新唤醒 Agent 检查该任务。省略时使用 Runtime 的默认后台检查间隔。"
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
        let args: WaitTaskArgs = serde_json::from_str(arguments)?;
        let task = require_visible_task(&args.task_id)?;
        let terminal = task.status.is_terminal();
        drop(task);
        if terminal {
            let task = require_visible_task(&args.task_id)?;
            return Ok(serde_json::json!({
                "kind": "background_task_wait",
                "waiting": false,
                "task": background_task_snapshot(&task),
                "next_action": "任务已经结束，直接根据退出码和输出继续处理。",
            })
            .to_string());
        }

        let wait_secs = args.wait_secs.unwrap_or(self.default_wait_secs);
        let wakeup_at = match schedule_background_task_wakeup(
            Arc::clone(&self.bus),
            &args.task_id,
            wait_secs,
            "agent_requested",
        ) {
            Ok(wakeup_at) => wakeup_at,
            Err(error) => {
                if let Ok(task) = require_visible_task(&args.task_id) {
                    if task.status.is_terminal() {
                        return Ok(serde_json::json!({
                            "kind": "background_task_wait",
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
            "kind": "background_task_wait",
            "waiting": true,
            "wait_secs": wait_secs,
            "wakeup_at": wakeup_at,
            "task": background_task_snapshot(&task),
            "next_action": "若无需立即发送消息，调用 no_reply 结束当前求值；任务结束或 wait_secs 到期时 Runtime 会主动唤醒。不要 sleep、ps、轮询日志或立即重复调用 wait_task。",
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

#[async_trait::async_trait]
impl Tool for ListSkillsTool {
    fn name(&self) -> &str {
        "list_skills"
    }

    fn definition(&self) -> ToolDefinition {
        let params_json = serde_json::json!({
            "type": "object",
            "properties": {}
        });

        ToolDefinition {
            name: "list_skills".to_string(),
            description: "扫描 ~/.agents/skills/ 和 ~/.morphz/skills/ 目录并列出当前可用的心智技能描述。大模型优先调用此工具发现新技能。".to_string(),
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

        let mut skill_list = Vec::new();

        for skills_dir in paths_to_scan {
            if !skills_dir.exists() {
                continue;
            }

            let mut entries = match tokio::fs::read_dir(&skills_dir).await {
                Ok(e) => e,
                Err(_) => continue,
            };

            while let Some(entry) = entries.next_entry().await? {
                let path = entry.path();
                if path.is_dir() {
                    let skill_md_path = path.join("SKILL.md");
                    if skill_md_path.exists() {
                        let content = tokio::fs::read_to_string(&skill_md_path).await?;
                        let mut name = path
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("unknown")
                            .to_string();
                        let mut description = "无详细描述".to_string();

                        if let Some(stripped) = content.strip_prefix("---") {
                            if let Some(end_idx) = stripped.find("---") {
                                let yaml_part = &stripped[..end_idx];
                                for line in yaml_part.lines() {
                                    let parts: Vec<&str> = line.splitn(2, ':').collect();
                                    if parts.len() == 2 {
                                        let key = parts[0].trim();
                                        let val = parts[1].trim().trim_matches('"');
                                        if key == "name" {
                                            name = val.to_string();
                                        } else if key == "description" {
                                            description = val.to_string();
                                        }
                                    }
                                }
                            }
                        }
                        skill_list.push(format!(
                            "- 技能名称: {}\n  描述: {}\n  路径: {}",
                            name,
                            description,
                            skill_md_path.to_string_lossy()
                        ));
                    }
                }
            }
        }

        if skill_list.is_empty() {
            Ok("目前标准技能库 (~/.agents/skills/ 和 ~/.morphz/skills/) 目录为空，暂无可用的外部技能。".to_string())
        } else {
            Ok(format!("发现以下可用技能：\n\n{}", skill_list.join("\n")))
        }
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
        NewAgent, NewCognitiveContext, NewScheduledIntent, NewSession, SessionMountKind,
        SessionStore, ThreadLifecycle,
    };
    use crate::permission::PermissionMode;
    #[cfg(target_os = "macos")]
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::sync::Weak;
    use tempfile::{NamedTempFile, TempDir};

    #[cfg(target_os = "macos")]
    static MACOS_SANDBOX_EXEC_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    static SECRET_ENV_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    struct ReplacementDefinitionTool;

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
                        "work-item-a".to_string(),
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
            .ensure_work_thread(NewWorkThread {
                id: "thread-current".to_string(),
                agent_id: "agent-scheduler".to_string(),
                context_id: "context-scheduler".to_string(),
                session_id: "session-scheduler".to_string(),
                root_turn_id: "root-current".to_string(),
                kind: WorkThreadKind::Dialogue,
                executor_kind: "self".to_string(),
                executor_id: None,
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
        let scheduler = Arc::new(ThreadScheduler::new(
            Arc::clone(&bus),
            Arc::clone(&sessions),
            Arc::clone(&store) as Arc<dyn EventStore>,
        ));
        let tool = ScheduleTxTool::new(Arc::clone(&scheduler), sessions);
        let due_at = (chrono::Utc::now() + chrono::Duration::milliseconds(40)).to_rfc3339();
        let arguments = serde_json::json!({
            "operations": [{
                "op": "spawn",
                "client_id": "reminder",
                "intent": "检查长期任务状态并根据真实结果继续",
                "not_before": due_at
            }]
        })
        .to_string();
        let route = Some(ToolCausalRoute {
            work_thread_id: "thread-current".to_string(),
            work_item_id: "work-current".to_string(),
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
        let records = store.list_scheduled_intents(None, None).await.unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].status, ScheduledIntentStatus::Dispatched);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(80), receiver.recv())
                .await
                .is_err()
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
                .ensure_work_thread(NewWorkThread {
                    id: (*thread_id).to_string(),
                    agent_id: "agent-scheduler-test".to_string(),
                    context_id: "context-scheduler-test".to_string(),
                    session_id: "session-scheduler-test".to_string(),
                    root_turn_id: (*root_turn_id).to_string(),
                    kind: WorkThreadKind::Work,
                    executor_kind: "self".to_string(),
                    executor_id: None,
                })
                .await
                .unwrap();
        }
        store
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
        let scheduler = Arc::new(ThreadScheduler::new(
            Arc::clone(&bus),
            Arc::clone(&store) as Arc<dyn SessionStore>,
            Arc::clone(&store) as Arc<dyn EventStore>,
        ));
        let intent = store
            .ensure_scheduled_intent(NewScheduledIntent {
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
        scheduler.arm(intent);

        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(150), receiver.recv())
                .await
                .is_err(),
            "依赖未结束时不应投递"
        );
        let dependency = store
            .get_work_thread("thread-dependency")
            .await
            .unwrap()
            .unwrap();
        store
            .update_work_thread(
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

        let event = tokio::time::timeout(std::time::Duration::from_secs(3), receiver.recv())
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
    async fn scheduler_recover_rearms_queued_intent_after_restart() {
        let database = NamedTempFile::new().unwrap();
        let store = scheduler_store_with_threads(
            &database,
            &[("thread-after-restart", "root-after-restart")],
        )
        .await;
        store
            .ensure_scheduled_intent(NewScheduledIntent {
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
        let restarted_scheduler = Arc::new(ThreadScheduler::new(
            Arc::clone(&bus),
            Arc::clone(&store) as Arc<dyn SessionStore>,
            Arc::clone(&store) as Arc<dyn EventStore>,
        ));
        restarted_scheduler.recover().await.unwrap();

        let event = tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            event.payload["scheduled_intent_id"],
            "schedule-after-restart"
        );
        assert_eq!(event.payload["intent"], "重启后继续执行");
        let recovered = store
            .get_scheduled_intent("schedule-after-restart")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(recovered.status, ScheduledIntentStatus::Dispatched);
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

    #[tokio::test]
    async fn test_file_tools() {
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
                    "wait_ms": 5000
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
        KillTaskTool
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
        KillTaskTool
            .execute(&serde_json::json!({ "task_id": task_id }).to_string())
            .await
            .unwrap();
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
            work_thread_id: "thread-causal-background".to_string(),
            work_item_id: "work-causal-background".to_string(),
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
        assert_eq!(completion.payload["work_item_id"], route.work_item_id);
        assert_eq!(completion.payload["root_turn_id"], route.root_turn_id);
        assert_eq!(
            completion.payload["trigger_event_id"],
            route.trigger_event_id
        );
        assert_eq!(completion.payload["trigger_sequence"], 42);
    }

    #[tokio::test]
    async fn wait_task_can_rearm_agent_chosen_wakeups_without_killing_the_task() {
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
                causal_route: None,
                started_at: now,
                last_output_at: now,
                output_bytes: 8,
                output_tail: "working\n".to_string(),
                wake_generation: 0,
                next_wakeup_at: None,
                status: BackgroundTaskStatus::Running,
                effective_network: false,
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
        let wait_tool = WaitTaskTool::new(Arc::clone(&bus), 10);

        for _ in 0..2 {
            let result: serde_json::Value = serde_json::from_str(
                &wait_tool
                    .execute(
                        &serde_json::json!({
                            "task_id": task_id,
                            "wait_secs": 1
                        })
                        .to_string(),
                    )
                    .await
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(result["waiting"], true);
            assert_eq!(result["wait_secs"], 1);

            let event = tokio::time::timeout(tokio::time::Duration::from_secs(2), receiver.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(event.payload["event"], "background_task_wait_elapsed");
            assert_eq!(event.payload["wait_secs"], 1);
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
    async fn test_kill_task_pgid_cleanup() {
        let bus = Arc::new(crate::event::InMemoryEventBus::new());
        let exec_tool = exec_tool_for_tests(Arc::clone(&bus));
        let kill_tool = KillTaskTool;

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
            &TaskStatusTool
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
            &ListTasksTool
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

        let wait_tool = WaitTaskTool::new(Arc::clone(&bus), 300);
        let waiting: serde_json::Value = serde_json::from_str(
            &wait_tool
                .execute(&serde_json::json!({ "task_id": task_id, "wait_secs": 30 }).to_string())
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(waiting["waiting"], true);
        assert_eq!(waiting["wait_secs"], 30);
        assert!(waiting["wakeup_at"].is_string());
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
