use crate::event::{Event, InMemoryEventBus, TYPE_TOOL_OUTPUT};
use crate::llm::ToolDefinition;
use crate::memory::{
    EventStore, NewObjective, ObjectiveMutation, ObjectiveRecord, ObjectiveStatus, ObjectiveStore,
    ObjectiveWaitCondition,
};
use crate::orchestrator::context::ContextEngine;
use crate::tool::{Tool, CURRENT_ATTEMPT_ID, CURRENT_CONTEXT_ID, CURRENT_SESSION_ID};
use chrono::{DateTime, Duration, Utc};
use dashmap::DashMap;
use serde::Deserialize;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;

type DynError = Box<dyn std::error::Error + Send + Sync>;

pub const TYPE_OBJECTIVE_CONTROL: &str = "objective_control";

#[derive(Debug, Deserialize)]
struct ObjectiveCreateArgs {
    stated_objective: String,
    reason: String,
    #[serde(default)]
    source_refs: Vec<String>,
    #[serde(default)]
    parent_objective_id: Option<String>,
    #[serde(default)]
    token_budget: Option<u64>,
}

/// 允许模型把当前工作显式升级为 First-Class Objective。Context、Session、
/// Agent、Objective ID 与 source event 都由 Runtime 注入或生成，模型不能
/// 借此跨路由创建控制对象。
pub struct ObjectiveCreateTool {
    supervisor: Arc<ObjectiveSupervisor>,
    context_engine: Arc<ContextEngine>,
    creation_locks: DashMap<String, Arc<Mutex<()>>>,
}

impl ObjectiveCreateTool {
    pub fn new(supervisor: Arc<ObjectiveSupervisor>, context_engine: Arc<ContextEngine>) -> Self {
        Self {
            supervisor,
            context_engine,
            creation_locks: DashMap::new(),
        }
    }
}

#[async_trait::async_trait]
impl Tool for ObjectiveCreateTool {
    fn name(&self) -> &str {
        "objective_create"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "objective_create".to_string(),
            description: "把当前 Session 中确实需要跨多次 Evaluation、异步等待或 Runtime 重启继续推进的工作创建为持久 First-Class Objective。普通问答、一次求值内可完成的动作、仅为记录 Todo 或延长执行时间时不得使用。Runtime 自动绑定当前 Agent/Context/Session 并生成 ID；成功后继续当前工作，不要为同一目标重复创建。可在当前 Objective 内显式创建子 Objective，但 parent_objective_id 必须是当前正在求值的 Objective。".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "stated_objective": {
                        "type": "string",
                        "description": "稳定、完整、可审计的长期目标陈述；保留用户要求、范围和完成条件，不要只写下一步动作"
                    },
                    "reason": {
                        "type": "string",
                        "description": "为什么该工作需要 First-Class Objective，而不是在当前普通 Evaluation 内直接完成"
                    },
                    "source_refs": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "当前 Context Ledger 引用，如用户要求或形成目标的证据 @e27；Runtime 验证引用存在，没有合适引用时传空数组"
                    },
                    "parent_objective_id": {
                        "type": "string",
                        "description": "仅创建子 Objective 时填写，且必须等于当前正在求值的 Objective ID；独立 Objective 省略"
                    },
                    "token_budget": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "可选 Prompt Token 预算；省略表示继承 Runtime 的无显式 Objective 预算策略"
                    }
                },
                "required": ["stated_objective", "reason", "source_refs"]
            }),
        }
    }

    async fn execute(&self, arguments: &str) -> Result<String, DynError> {
        let args: ObjectiveCreateArgs = serde_json::from_str(arguments)?;
        let session_id = CURRENT_SESSION_ID
            .try_with(Clone::clone)
            .map_err(|_| "objective_create 缺少 Runtime 注入的当前 Session")?;
        let context_id = CURRENT_CONTEXT_ID
            .try_with(Clone::clone)
            .map_err(|_| "objective_create 缺少 Runtime 注入的当前 Context")?;
        let attempt_id = CURRENT_ATTEMPT_ID
            .try_with(Clone::clone)
            .map_err(|_| "objective_create 缺少 Runtime 注入的当前 Evaluation")?;
        let stated_objective = args.stated_objective.trim();
        if stated_objective.is_empty() {
            return Err("objective_create.stated_objective 不能为空".into());
        }
        let reason = args.reason.trim();
        if reason.is_empty() {
            return Err("objective_create.reason 不能为空".into());
        }
        if reason.chars().count() > 10_000 {
            return Err("objective_create.reason 超过 10,000 字符上限".into());
        }
        if args.source_refs.len() > 64 {
            return Err("objective_create.source_refs 最多允许 64 个引用".into());
        }
        if args.token_budget == Some(0) {
            return Err("objective_create.token_budget 必须大于 0".into());
        }

        let session_store = self
            .context_engine
            .session_store()
            .ok_or("objective_create 缺少 Runtime SessionStore")?;
        let session = session_store
            .get_session(&session_id)
            .await?
            .ok_or_else(|| format!("当前 Session '{session_id}' 不存在"))?;
        if session.context_id != context_id {
            return Err("objective_create 的当前 Session/Context 路由不一致".into());
        }

        let mut source_event_ids = Vec::with_capacity(args.source_refs.len());
        for source_ref in &args.source_refs {
            let event = self
                .context_engine
                .find_event(&context_id, source_ref)
                .await?
                .ok_or_else(|| format!("source_ref '{source_ref}' 不存在或不属于当前 Context"))?;
            source_event_ids.push(event.id);
        }

        let parent_objective_id = args
            .parent_objective_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string);
        if let Some(parent_id) = parent_objective_id.as_deref() {
            let active = self
                .supervisor
                .evaluations
                .get(&session_id)
                .ok_or("只有当前正在求值的 Objective 才能作为自主创建的 parent")?;
            if active.objective_id != parent_id {
                return Err(format!(
                    "parent_objective_id 必须是当前 Objective '{}'",
                    active.objective_id
                )
                .into());
            }
            let parent = self
                .supervisor
                .get(parent_id)
                .await?
                .ok_or_else(|| format!("父 Objective '{parent_id}' 不存在"))?;
            if parent.context_id != context_id
                || parent.coordinator_session_id != session_id
                || parent.status.is_terminal()
            {
                return Err(
                    "父 Objective 必须属于当前 Context/coordinator Session 且尚未终止".into(),
                );
            }
        }

        let lock_key = format!("{context_id}\0{session_id}");
        let creation_lock = self
            .creation_locks
            .entry(lock_key)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        let _guard = creation_lock.lock().await;
        let normalized_statement = normalize_objective_statement(stated_objective);
        if let Some(existing) = self
            .supervisor
            .list(&context_id, false)
            .await?
            .into_iter()
            .find(|objective| {
                objective.coordinator_session_id == session_id
                    && objective.parent_objective_id == parent_objective_id
                    && normalize_objective_statement(&objective.stated_objective)
                        == normalized_statement
            })
        {
            return Ok(serde_json::to_string_pretty(&json!({
                "status": "existing",
                "created": false,
                "objective_id": existing.id,
                "objective_status": existing.status,
                "revision": existing.revision,
                "guidance": "相同的非终态 Objective 已存在；不要重复创建。继续执行它，或在有权限时更新其状态。"
            }))?);
        }

        let nonce = Utc::now().timestamp_nanos_opt().unwrap_or(0);
        let objective_id = format!("objective-auto-{nonce}");
        let source_event_id = format!("objective_auto_request_{nonce}");
        let request_event = Event::new(
            source_event_id.clone(),
            "Agent-Morphz".to_string(),
            TYPE_OBJECTIVE_CONTROL.to_string(),
            "objective/autonomous_requested".to_string(),
            vec![
                ("context_id".to_string(), json!(context_id)),
                ("session_id".to_string(), json!(session_id)),
                ("attempt_id".to_string(), json!(attempt_id)),
                ("requested_objective_id".to_string(), json!(objective_id)),
                ("stated_objective".to_string(), json!(stated_objective)),
                ("reason".to_string(), json!(reason)),
                ("source_refs".to_string(), json!(args.source_refs)),
                ("source_event_ids".to_string(), json!(source_event_ids)),
                (
                    "parent_objective_id".to_string(),
                    json!(parent_objective_id),
                ),
                ("token_budget".to_string(), json!(args.token_budget)),
            ]
            .into_iter()
            .collect(),
        );
        self.supervisor
            .audit_store
            .append(request_event.clone())
            .await?;
        self.supervisor.bus.publish(request_event).await?;

        let created = self
            .supervisor
            .store
            .create_objective(NewObjective {
                id: objective_id,
                agent_id: session.agent_id,
                context_id: context_id.clone(),
                coordinator_session_id: session_id.clone(),
                delivery_session_id: session_id.clone(),
                parent_objective_id,
                source_event_id,
                stated_objective: stated_objective.to_string(),
                token_budget: args.token_budget,
            })
            .await?;

        let adopted = if self.supervisor.evaluations.get(&session_id).is_none() {
            self.supervisor
                .claim_routed_evaluation(&created, &attempt_id, Some(&attempt_id), false)
                .await?
        } else {
            None
        };
        self.supervisor
            .publish_state_event("created", &created, Some(reason))
            .await?;
        if let Some(claimed) = &adopted {
            self.supervisor
                .publish_state_event("evaluation_started", claimed, Some(&attempt_id))
                .await?;
        }

        Ok(serde_json::to_string_pretty(&json!({
            "status": "created",
            "created": true,
            "objective_id": created.id,
            "objective_status": created.status,
            "revision": adopted.as_ref().map(|objective| objective.revision).unwrap_or(created.revision),
            "context_id": created.context_id,
            "coordinator_session_id": created.coordinator_session_id,
            "parent_objective_id": created.parent_objective_id,
            "activation_adoption": if adopted.is_some() { "current-activation" } else { "queued-behind-current-objective" },
            "guidance": "Objective 已持久化。不要重复创建；继续当前工作。普通文本或 no_reply 只结束当前 Activation，Objective 未完成时 Supervisor 会自动续跑。"
        }))?)
    }
}

fn normalize_objective_statement(statement: &str) -> String {
    statement.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AgentObjectiveStatus {
    Active,
    Blocked,
    Completed,
}

#[derive(Debug, Deserialize)]
struct ObjectiveUpdateArgs {
    objective_id: String,
    base_revision: u64,
    status: AgentObjectiveStatus,
    reason: String,
    #[serde(default)]
    evidence_refs: Vec<String>,
    #[serde(default)]
    wait_condition: Option<ObjectiveWaitCondition>,
}

pub struct ObjectiveUpdateTool {
    supervisor: Arc<ObjectiveSupervisor>,
    context_engine: Arc<ContextEngine>,
}

impl ObjectiveUpdateTool {
    pub fn new(supervisor: Arc<ObjectiveSupervisor>, context_engine: Arc<ContextEngine>) -> Self {
        Self {
            supervisor,
            context_engine,
        }
    }
}

#[async_trait::async_trait]
impl Tool for ObjectiveUpdateTool {
    fn name(&self) -> &str {
        "objective_update"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "objective_update".to_string(),
            description: "显式提交当前长期 Objective 的 Runtime 控制状态。普通文本或 no_reply 只结束本次 Evaluation，不能替代 Objective 完成。completed 必须给出真实原因并引用已有证据；需要等待确定事件时保持 active 并提交 wait_condition；只有确实无法自动等待或继续推进时才用 blocked。Agent 无权通过此工具 pause/cancel。".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "objective_id": {
                        "type": "string",
                        "description": "kernel.objectives 中当前 Objective 的稳定 ID"
                    },
                    "base_revision": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "本次 Context Encoding 中看到的 Objective revision；冲突时必须重新读取最新状态"
                    },
                    "status": {
                        "type": "string",
                        "enum": ["active", "blocked", "completed"]
                    },
                    "reason": {
                        "type": "string",
                        "description": "为什么该状态符合当前客观证据；不能把 Context 压力、预算接近耗尽或想结束响应当作完成原因"
                    },
                    "evidence_refs": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "支持判断的当前 Context Ledger 引用，如 @e27；Runtime 只验证引用存在，不判断业务证据是否充分"
                    },
                    "wait_condition": {
                        "description": "仅 status=active 时使用的确定性唤醒条件。提交后 Runtime 不轮询，事件满足时自动恢复。",
                        "oneOf": [
                            {
                                "type": "object",
                                "properties": {
                                    "kind": { "const": "tool_task" },
                                    "task_id": { "type": "string" }
                                },
                                "required": ["kind", "task_id"]
                            },
                            {
                                "type": "object",
                                "properties": {
                                    "kind": { "const": "delegation" },
                                    "delegation_id": { "type": "string" }
                                },
                                "required": ["kind", "delegation_id"]
                            },
                            {
                                "type": "object",
                                "properties": {
                                    "kind": { "const": "timer" },
                                    "deadline": { "type": "string", "format": "date-time" }
                                },
                                "required": ["kind", "deadline"]
                            },
                            {
                                "type": "object",
                                "properties": {
                                    "kind": { "const": "permission" },
                                    "request_id": { "type": "string" }
                                },
                                "required": ["kind", "request_id"]
                            },
                            {
                                "type": "object",
                                "properties": {
                                    "kind": { "const": "user_input" },
                                    "session_id": { "type": "string" }
                                },
                                "required": ["kind", "session_id"]
                            },
                            {
                                "type": "object",
                                "properties": {
                                    "kind": { "const": "external_event" },
                                    "topic": { "type": "string" },
                                    "correlation_id": { "type": "string" }
                                },
                                "required": ["kind", "topic", "correlation_id"]
                            },
                            {
                                "type": "object",
                                "properties": {
                                    "kind": { "const": "resource_available" },
                                    "resource": { "type": "string" }
                                },
                                "required": ["kind", "resource"]
                            }
                        ]
                    }
                },
                "required": ["objective_id", "base_revision", "status", "reason", "evidence_refs"]
            }),
        }
    }

    async fn execute(&self, arguments: &str) -> Result<String, DynError> {
        let args: ObjectiveUpdateArgs = serde_json::from_str(arguments)?;
        let session_id = CURRENT_SESSION_ID
            .try_with(Clone::clone)
            .map_err(|_| "objective_update 缺少 Runtime 注入的当前 Session")?;
        let context_id = CURRENT_CONTEXT_ID
            .try_with(Clone::clone)
            .map_err(|_| "objective_update 缺少 Runtime 注入的当前 Context")?;
        let attempt_id = CURRENT_ATTEMPT_ID
            .try_with(Clone::clone)
            .map_err(|_| "objective_update 缺少 Runtime 注入的当前 Evaluation")?;
        let reason = args.reason.trim();
        if reason.is_empty() {
            return Err("objective_update.reason 不能为空".into());
        }
        if reason.chars().count() > 10_000 {
            return Err("objective_update.reason 超过 10,000 字符上限".into());
        }
        let objective = self
            .supervisor
            .get(&args.objective_id)
            .await?
            .ok_or_else(|| format!("Objective '{}' 不存在", args.objective_id))?;
        if objective.context_id != context_id || objective.coordinator_session_id != session_id {
            return Err(format!(
                "当前 Session/Context 无权修改 Objective '{}'",
                args.objective_id
            )
            .into());
        }
        let active = self
            .supervisor
            .evaluations
            .get_for_work_item(&attempt_id)
            .ok_or(
                "当前 Evaluation 不属于任何 Objective；不能接管共享 Context 中的其他 Objective",
            )?;
        if active.objective_id != objective.id {
            return Err(format!(
                "当前 Evaluation 只拥有 Objective '{}'，不能修改 '{}'",
                active.objective_id, objective.id
            )
            .into());
        }
        for evidence_ref in &args.evidence_refs {
            if self
                .context_engine
                .find_event(&context_id, evidence_ref)
                .await?
                .is_none()
            {
                return Err(
                    format!("evidence_ref '{}' 不存在或不属于当前 Context", evidence_ref).into(),
                );
            }
        }
        let (status, wait_condition) = match args.status {
            AgentObjectiveStatus::Completed => {
                if args.wait_condition.is_some() {
                    return Err("completed Objective 不能携带 wait_condition".into());
                }
                (ObjectiveStatus::Completed, None)
            }
            AgentObjectiveStatus::Blocked => {
                if args.wait_condition.is_some() {
                    return Err(
                        "存在确定性 wait_condition 时应保持 active，不能标记 blocked".into(),
                    );
                }
                (ObjectiveStatus::Blocked, None)
            }
            AgentObjectiveStatus::Active => {
                let wait_condition = args.wait_condition.ok_or(
                    "status=active 的 objective_update 必须携带确定性 wait_condition；无需等待时继续执行，不要提交空状态更新",
                )?;
                (ObjectiveStatus::Active, Some(wait_condition))
            }
        };
        let mutation = self
            .supervisor
            .update_state(
                &args.objective_id,
                args.base_revision,
                status,
                wait_condition,
                Some(reason),
            )
            .await?;
        Ok(serde_json::to_string_pretty(&match mutation {
            ObjectiveMutation::Updated(updated) => json!({
                "status": "committed",
                "objective_id": updated.id,
                "revision": updated.revision,
                "objective_status": updated.status,
                "wait_condition": updated.wait_condition,
                "evidence_refs": args.evidence_refs,
                "next_action": if updated.status.is_terminal() {
                    "返回无工具普通文本交付最终报告；它只结束当前 Evaluation。"
                } else if updated.status == ObjectiveStatus::Blocked {
                    "返回无工具普通文本向使用者说明阻塞原因；Runtime 将停止自动续跑，直到收到显式恢复。"
                } else if updated.wait_condition.is_some() {
                    "返回普通文本说明等待状态，或调用 no_reply 明确无需发送消息；Runtime 将在条件满足时唤醒。"
                } else {
                    "继续推进 Objective。"
                }
            }),
            ObjectiveMutation::Conflict { current } => json!({
                "status": "revision_conflict",
                "objective_id": current.id,
                "expected_revision": args.base_revision,
                "current_revision": current.revision,
                "current_status": current.status,
                "current_status_reason": current.status_reason,
                "wait_condition": current.wait_condition,
                "guidance": "以最新 Context Encoding 为准重新判断，禁止用过期 revision 覆盖。"
            }),
            ObjectiveMutation::NotFound => json!({
                "status": "not_found",
                "objective_id": args.objective_id
            }),
        })?)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveObjectiveEvaluation {
    pub objective_id: String,
    pub evaluation_id: String,
    pub revision: u64,
    pub started_at: DateTime<Utc>,
}

/// Runtime-local routing metadata. The persistent lease in ObjectiveStore is
/// authoritative; this registry only lets Orchestrator stamp terminal IO with
/// the Objective Evaluation that caused it.
#[derive(Default)]
pub struct ObjectiveEvaluationRegistry {
    by_session: DashMap<String, ActiveObjectiveEvaluation>,
    by_work_item: DashMap<String, ActiveObjectiveEvaluation>,
}

impl ObjectiveEvaluationRegistry {
    pub fn get(&self, session_id: &str) -> Option<ActiveObjectiveEvaluation> {
        self.by_session.get(session_id).map(|entry| entry.clone())
    }

    pub fn get_for_work_item(&self, work_item_id: &str) -> Option<ActiveObjectiveEvaluation> {
        self.by_work_item
            .get(canonical_work_item_id(work_item_id))
            .map(|entry| entry.clone())
    }

    pub fn bind_work_item(&self, work_item_id: &str, evaluation: ActiveObjectiveEvaluation) {
        self.by_work_item
            .insert(canonical_work_item_id(work_item_id).to_string(), evaluation);
    }

    pub fn remove_work_item(&self, work_item_id: &str) {
        self.by_work_item
            .remove(canonical_work_item_id(work_item_id));
    }

    fn try_bind(
        &self,
        session_id: &str,
        evaluation: ActiveObjectiveEvaluation,
    ) -> Result<(), ActiveObjectiveEvaluation> {
        match self.by_session.entry(session_id.to_string()) {
            dashmap::mapref::entry::Entry::Vacant(entry) => {
                entry.insert(evaluation);
                Ok(())
            }
            dashmap::mapref::entry::Entry::Occupied(entry) => Err(entry.get().clone()),
        }
    }

    fn unbind(&self, session_id: &str, evaluation_id: &str) {
        self.by_session.remove_if(session_id, |_, active| {
            active.evaluation_id == evaluation_id
        });
        self.by_work_item
            .retain(|_, active| active.evaluation_id != evaluation_id);
    }
}

fn canonical_work_item_id(attempt_id: &str) -> &str {
    attempt_id
        .split_once("_response_retry_")
        .map(|(base, _)| base)
        .unwrap_or(attempt_id)
}

/// Built-in policy module for persistent Objective scheduling. It owns no task
/// semantics: it only drives active/no-wait Objectives through successive
/// single Evaluations and stops at lifecycle or wait boundaries.
pub struct ObjectiveSupervisor {
    store: Arc<dyn ObjectiveStore>,
    audit_store: Arc<dyn EventStore>,
    bus: Arc<InMemoryEventBus>,
    evaluations: Arc<ObjectiveEvaluationRegistry>,
    lease_duration: Duration,
    schedule_locks: DashMap<String, Arc<Mutex<()>>>,
    lease_wakeups: DashMap<String, DateTime<Utc>>,
    wait_timer_wakeups: DashMap<String, (u64, DateTime<Utc>)>,
    external_wait_subscriptions: DashMap<String, (u64, String, String)>,
    started: AtomicBool,
}

impl ObjectiveSupervisor {
    pub fn new(
        store: Arc<dyn ObjectiveStore>,
        audit_store: Arc<dyn EventStore>,
        bus: Arc<InMemoryEventBus>,
        evaluations: Arc<ObjectiveEvaluationRegistry>,
        lease_duration: std::time::Duration,
    ) -> Self {
        let lease_duration =
            Duration::from_std(lease_duration).unwrap_or_else(|_| Duration::minutes(10));
        Self {
            store,
            audit_store,
            bus,
            evaluations,
            lease_duration,
            schedule_locks: DashMap::new(),
            lease_wakeups: DashMap::new(),
            wait_timer_wakeups: DashMap::new(),
            external_wait_subscriptions: DashMap::new(),
            started: AtomicBool::new(false),
        }
    }

    pub async fn start(self: Arc<Self>) -> Result<(), DynError> {
        if self.started.swap(true, Ordering::AcqRel) {
            return Ok(());
        }

        let supervisor = Arc::clone(&self);
        self.bus.subscribe(
            "objective/*".to_string(),
            Arc::new(move |event| {
                let supervisor = Arc::clone(&supervisor);
                Box::pin(async move { supervisor.handle_objective_event(event).await })
            }),
        );
        for topic in ["runtime/approval_decision", "runtime/resource_available"] {
            let supervisor = Arc::clone(&self);
            self.bus.subscribe(
                topic.to_string(),
                Arc::new(move |event| {
                    let supervisor = Arc::clone(&supervisor);
                    Box::pin(async move { supervisor.wake_non_routed_event(&event).await })
                }),
            );
        }
        for mut objective in self.store.list_recoverable_objectives().await? {
            self.publish_recovery_observation(&objective).await?;
            if objective.status != ObjectiveStatus::Active {
                if let Some(evaluation_id) = objective.active_evaluation_id.as_deref() {
                    if let ObjectiveMutation::Updated(recovered) = self
                        .store
                        .finish_objective_evaluation(&objective.id, evaluation_id, 0, 0)
                        .await?
                    {
                        objective = recovered;
                        self.publish_state_event("recovered_evaluation_released", &objective, None)
                            .await?;
                    }
                }
            }
            self.reconcile(objective).await?;
        }
        Ok(())
    }

    pub fn evaluations(&self) -> Arc<ObjectiveEvaluationRegistry> {
        Arc::clone(&self.evaluations)
    }

    pub async fn create(
        self: &Arc<Self>,
        objective: NewObjective,
    ) -> Result<ObjectiveRecord, DynError> {
        let created = self.store.create_objective(objective).await?;
        self.publish_state_event("created", &created, None).await?;
        self.reconcile(created.clone()).await?;
        Ok(created)
    }

    pub async fn get(&self, id: &str) -> Result<Option<ObjectiveRecord>, DynError> {
        self.store.get_objective(id).await
    }

    pub async fn list(
        &self,
        context_id: &str,
        include_terminal: bool,
    ) -> Result<Vec<ObjectiveRecord>, DynError> {
        self.store
            .list_context_objectives(context_id, include_terminal)
            .await
    }

    pub async fn edit(
        &self,
        id: &str,
        expected_revision: u64,
        stated_objective: &str,
    ) -> Result<ObjectiveMutation, DynError> {
        let mutation = self
            .store
            .edit_objective(id, expected_revision, stated_objective)
            .await?;
        if let ObjectiveMutation::Updated(updated) = &mutation {
            self.publish_state_event("edited", updated, None).await?;
        }
        Ok(mutation)
    }

    pub async fn update_state(
        self: &Arc<Self>,
        id: &str,
        expected_revision: u64,
        status: ObjectiveStatus,
        wait_condition: Option<ObjectiveWaitCondition>,
        reason: Option<&str>,
    ) -> Result<ObjectiveMutation, DynError> {
        let mut mutation = self
            .store
            .update_objective_state(id, expected_revision, status, wait_condition, reason)
            .await?;
        if let ObjectiveMutation::Updated(updated) = &mutation {
            if matches!(
                updated.status,
                ObjectiveStatus::Paused | ObjectiveStatus::Cancelled | ObjectiveStatus::Failed
            ) {
                if let Some(evaluation_id) = updated.active_evaluation_id.as_deref() {
                    mutation = self
                        .store
                        .finish_objective_evaluation(&updated.id, evaluation_id, 0, 0)
                        .await?;
                }
            }
        }
        if let ObjectiveMutation::Updated(updated) = &mutation {
            self.publish_state_event("updated", updated, reason).await?;
            self.reconcile(updated.clone()).await?;
        }
        Ok(mutation)
    }

    async fn handle_objective_event(self: Arc<Self>, event: Event) -> Result<(), DynError> {
        let Some(objective_id) = event
            .payload
            .get("objective_id")
            .and_then(|value| value.as_str())
        else {
            return Ok(());
        };
        if let Some(objective) = self.store.get_objective(objective_id).await? {
            self.reconcile(objective).await?;
        }
        Ok(())
    }

    /// Lifecycle hook invoked by Orchestrator while holding the target Session
    /// lane and before it evaluates a newly routed user/tool event. A matching
    /// wait is cleared and the physical event itself becomes the wake input;
    /// no duplicate synthetic continuation is emitted.
    pub async fn prepare_routed_event(
        self: &Arc<Self>,
        event: &Event,
        work_item_id: &str,
    ) -> Result<(), DynError> {
        let Some(context_id) = event
            .payload
            .get("context_id")
            .and_then(|value| value.as_str())
        else {
            return Ok(());
        };
        let route_session_id = event
            .payload
            .get("session_id")
            .and_then(|value| value.as_str());
        let objectives = self
            .store
            .list_context_objectives(context_id, false)
            .await?;
        for objective in objectives {
            let Some(wait) = objective.wait_condition.as_ref() else {
                continue;
            };
            if objective.status != ObjectiveStatus::Active || !wait_matches_event(wait, event) {
                continue;
            }
            let mutation = self
                .store
                .update_objective_state(
                    &objective.id,
                    objective.revision,
                    ObjectiveStatus::Active,
                    None,
                    Some(&format!("等待条件已由事件 {} 满足", event.id)),
                )
                .await?;
            let ObjectiveMutation::Updated(woken) = mutation else {
                continue;
            };
            self.publish_state_event("wait_satisfied", &woken, Some(&event.id))
                .await?;
            if route_session_id == Some(woken.coordinator_session_id.as_str()) {
                self.claim_routed_evaluation(&woken, &event.id, Some(work_item_id), true)
                    .await?;
            } else {
                self.reconcile(woken).await?;
            }
        }
        Ok(())
    }

    async fn wake_non_routed_event(self: &Arc<Self>, event: &Event) -> Result<(), DynError> {
        let Some(context_id) = event
            .payload
            .get("context_id")
            .and_then(|value| value.as_str())
        else {
            return Ok(());
        };
        let objectives = self
            .store
            .list_context_objectives(context_id, false)
            .await?;
        for objective in objectives {
            let Some(wait) = objective.wait_condition.as_ref() else {
                continue;
            };
            if objective.status != ObjectiveStatus::Active || !wait_matches_event(wait, event) {
                continue;
            }
            let mutation = self
                .store
                .update_objective_state(
                    &objective.id,
                    objective.revision,
                    ObjectiveStatus::Active,
                    None,
                    Some(&format!("等待条件已由事件 {} 满足", event.id)),
                )
                .await?;
            if let ObjectiveMutation::Updated(woken) = mutation {
                self.publish_state_event("wait_satisfied", &woken, Some(&event.id))
                    .await?;
                self.reconcile(woken).await?;
            }
        }
        Ok(())
    }

    pub async fn terminal_outcome(self: &Arc<Self>, event: &Event) -> Result<(), DynError> {
        let Some(session_id) = event
            .payload
            .get("session_id")
            .and_then(|value| value.as_str())
        else {
            return Ok(());
        };
        let Some(objective_id) = event
            .payload
            .get("objective_id")
            .and_then(|value| value.as_str())
        else {
            return Ok(());
        };
        let Some(evaluation_id) = event
            .payload
            .get("objective_evaluation_id")
            .and_then(|value| value.as_str())
        else {
            return Ok(());
        };
        let binding = event
            .payload
            .get("work_item_id")
            .and_then(|value| value.as_str())
            .and_then(|work_item_id| self.evaluations.get_for_work_item(work_item_id))
            .filter(|active| {
                active.objective_id == objective_id && active.evaluation_id == evaluation_id
            })
            .unwrap_or_else(|| ActiveObjectiveEvaluation {
                objective_id: objective_id.to_string(),
                evaluation_id: evaluation_id.to_string(),
                revision: event
                    .payload
                    .get("objective_revision")
                    .and_then(|value| value.as_u64())
                    .unwrap_or_default(),
                started_at: event.timestamp,
            });

        let elapsed_seconds = (Utc::now() - binding.started_at).num_seconds().max(0) as u64;
        let mutation = self
            .store
            .finish_objective_evaluation(
                &binding.objective_id,
                &binding.evaluation_id,
                0,
                elapsed_seconds,
            )
            .await?;
        self.lease_wakeups.remove(&binding.objective_id);
        self.evaluations.unbind(session_id, &binding.evaluation_id);
        let mut context_to_reconcile = None;
        match mutation {
            ObjectiveMutation::Updated(updated) => {
                context_to_reconcile = Some(updated.context_id.clone());
                self.publish_state_event("evaluation_finished", &updated, Some(&event.id))
                    .await?;
                self.reconcile(updated).await?;
            }
            ObjectiveMutation::Conflict { current } if current.status.is_terminal() => {
                context_to_reconcile = Some(current.context_id);
                // objective_update may have committed a terminal state before
                // the terminal response. Its outcome still releases local routing.
            }
            ObjectiveMutation::Conflict { current } => {
                context_to_reconcile = Some(current.context_id.clone());
                tracing::warn!(
                    objective_id = %binding.objective_id,
                    evaluation_id = %binding.evaluation_id,
                    current_revision = current.revision,
                    "Objective Evaluation 终止回执与持久化租约不一致"
                );
                self.reconcile(current).await?;
            }
            ObjectiveMutation::NotFound => {}
        }
        if let Some(context_id) = context_to_reconcile {
            for objective in self
                .store
                .list_context_objectives(&context_id, false)
                .await?
            {
                self.reconcile(objective).await?;
            }
        }
        Ok(())
    }

    pub async fn record_prompt_tokens(
        &self,
        session_id: &str,
        tokens: usize,
    ) -> Result<(), DynError> {
        let Some(binding) = self.evaluations.get(session_id) else {
            return Ok(());
        };
        let tokens = u64::try_from(tokens).unwrap_or(u64::MAX);
        match self
            .store
            .record_objective_evaluation_usage(
                &binding.objective_id,
                &binding.evaluation_id,
                tokens,
            )
            .await?
        {
            ObjectiveMutation::Updated(_) => {}
            ObjectiveMutation::Conflict { current } => {
                tracing::debug!(
                    objective_id = %binding.objective_id,
                    evaluation_id = %binding.evaluation_id,
                    current_status = ?current.status,
                    "Objective Prompt 计量未写入：Evaluation 已发生状态迁移"
                );
            }
            ObjectiveMutation::NotFound => {
                tracing::warn!(
                    objective_id = %binding.objective_id,
                    "Objective Prompt 计量未写入：Objective 不存在"
                );
            }
        }
        Ok(())
    }

    async fn reconcile(self: &Arc<Self>, objective: ObjectiveRecord) -> Result<(), DynError> {
        if !self.started.load(Ordering::Acquire) {
            return Ok(());
        }
        if objective.status != ObjectiveStatus::Active {
            self.lease_wakeups.remove(&objective.id);
            if !matches!(
                objective.status,
                ObjectiveStatus::Completed | ObjectiveStatus::Blocked
            ) {
                self.clear_local_binding(&objective);
            }
            self.remove_external_wait_subscription(&objective.id);
            return Ok(());
        }
        if let Some(wait) = &objective.wait_condition {
            self.lease_wakeups.remove(&objective.id);
            match wait {
                ObjectiveWaitCondition::Timer { deadline } => {
                    self.remove_external_wait_subscription(&objective.id);
                    self.schedule_wait_timer(objective.id, objective.revision, *deadline);
                }
                ObjectiveWaitCondition::ExternalEvent { topic, .. } => {
                    self.register_external_wait_subscription(
                        &objective.id,
                        objective.revision,
                        topic,
                    );
                }
                _ => self.remove_external_wait_subscription(&objective.id),
            }
            return Ok(());
        }
        self.remove_external_wait_subscription(&objective.id);
        if let Some(expires_at) = objective.evaluation_lease_expires_at {
            if expires_at > Utc::now() {
                self.schedule_lease_expiry(objective.id, expires_at);
                return Ok(());
            }
            self.clear_local_binding(&objective);
        }
        self.schedule(objective.id).await
    }

    async fn claim_routed_evaluation(
        self: &Arc<Self>,
        objective: &ObjectiveRecord,
        source_event_id: &str,
        work_item_id: Option<&str>,
        publish_started: bool,
    ) -> Result<Option<ObjectiveRecord>, DynError> {
        let evaluation_id = format!(
            "objective_eval_{}_{}_{}",
            objective.id,
            objective.continuation_sequence.saturating_add(1),
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        );
        let local_binding = ActiveObjectiveEvaluation {
            objective_id: objective.id.clone(),
            evaluation_id: evaluation_id.clone(),
            revision: objective.revision,
            started_at: Utc::now(),
        };
        if self
            .evaluations
            .try_bind(&objective.coordinator_session_id, local_binding)
            .is_err()
        {
            return Ok(None);
        }
        let lease_expires_at = Utc::now() + self.lease_duration;
        let claimed = self
            .store
            .claim_objective_evaluation(
                &objective.id,
                objective.revision,
                &evaluation_id,
                lease_expires_at,
            )
            .await?;
        let ObjectiveMutation::Updated(claimed) = claimed else {
            self.evaluations
                .unbind(&objective.coordinator_session_id, &evaluation_id);
            return Ok(None);
        };
        if let Some(mut active) = self
            .evaluations
            .by_session
            .get_mut(&objective.coordinator_session_id)
        {
            if active.evaluation_id == evaluation_id {
                active.revision = claimed.revision;
            }
        }
        if let Some(work_item_id) = work_item_id {
            self.evaluations.bind_work_item(
                work_item_id,
                ActiveObjectiveEvaluation {
                    objective_id: claimed.id.clone(),
                    evaluation_id: evaluation_id.clone(),
                    revision: claimed.revision,
                    started_at: Utc::now(),
                },
            );
        }
        self.schedule_lease_expiry(claimed.id.clone(), lease_expires_at);
        if publish_started {
            self.publish_state_event("evaluation_started", &claimed, Some(source_event_id))
                .await?;
        }
        Ok(Some(claimed))
    }

    async fn schedule(self: &Arc<Self>, objective_id: String) -> Result<(), DynError> {
        let lock = self
            .schedule_locks
            .entry(objective_id.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        let _guard = lock.lock().await;
        let Some(objective) = self.store.get_objective(&objective_id).await? else {
            return Ok(());
        };
        if objective.status != ObjectiveStatus::Active || objective.wait_condition.is_some() {
            return Ok(());
        }
        if objective
            .evaluation_lease_expires_at
            .is_some_and(|expires_at| expires_at > Utc::now())
        {
            return Ok(());
        }
        let evaluation_id = format!(
            "objective_eval_{}_{}_{}",
            objective.id,
            objective.continuation_sequence.saturating_add(1),
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        );
        let local_binding = ActiveObjectiveEvaluation {
            objective_id: objective.id.clone(),
            evaluation_id: evaluation_id.clone(),
            revision: objective.revision,
            started_at: Utc::now(),
        };
        if self
            .evaluations
            .try_bind(&objective.coordinator_session_id, local_binding)
            .is_err()
        {
            return Ok(());
        }
        let lease_expires_at = Utc::now() + self.lease_duration;
        let claimed_revision = objective.revision.saturating_add(1);
        let continuation = format!(
            "(objective-continuation (id {}) (revision {}) (evaluation {}) (reason active-no-wait) (instruction \"Continue the stated objective autonomously. Audit remaining requirements against current evidence. If complete, call objective_update before the final reply; if waiting, record a precise wait condition; otherwise make new progress.\"))",
            objective.id, claimed_revision, evaluation_id
        );
        let continuation_event = Event::new(
            format!("objective_continue_{evaluation_id}"),
            "Runtime-ObjectiveSupervisor".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            vec![
                ("context_id".to_string(), json!(objective.context_id)),
                (
                    "session_id".to_string(),
                    json!(objective.coordinator_session_id),
                ),
                ("objective_id".to_string(), json!(objective.id)),
                ("objective_revision".to_string(), json!(claimed_revision)),
                ("objective_evaluation_id".to_string(), json!(evaluation_id)),
                ("runtime_force_evaluation".to_string(), json!(true)),
                ("tool_name".to_string(), json!("objective_supervisor")),
                ("tool_status".to_string(), json!("success")),
                ("wake_source".to_string(), json!("active-no-wait")),
                ("text".to_string(), json!(continuation)),
            ]
            .into_iter()
            .collect(),
        );
        let claimed = self
            .store
            .claim_objective_evaluation_with_signal(
                &objective.id,
                objective.revision,
                &evaluation_id,
                lease_expires_at,
                &continuation_event,
            )
            .await?;
        let ObjectiveMutation::Updated(claimed) = claimed else {
            self.evaluations
                .unbind(&objective.coordinator_session_id, &evaluation_id);
            return Ok(());
        };
        if let Some(mut active) = self
            .evaluations
            .by_session
            .get_mut(&objective.coordinator_session_id)
        {
            if active.evaluation_id == evaluation_id {
                active.revision = claimed.revision;
            }
        }
        self.schedule_lease_expiry(claimed.id.clone(), lease_expires_at);
        self.publish_state_event("evaluation_started", &claimed, None)
            .await?;
        self.bus.dispatch_persisted(continuation_event).await?;
        Ok(())
    }

    fn schedule_lease_expiry(self: &Arc<Self>, objective_id: String, expires_at: DateTime<Utc>) {
        if self
            .lease_wakeups
            .get(&objective_id)
            .is_some_and(|existing| *existing == expires_at)
        {
            return;
        }
        self.lease_wakeups.insert(objective_id.clone(), expires_at);
        let supervisor = Arc::clone(self);
        tokio::spawn(async move {
            let delay = (expires_at - Utc::now())
                .to_std()
                .unwrap_or(std::time::Duration::ZERO);
            tokio::time::sleep(delay).await;
            if supervisor
                .lease_wakeups
                .remove_if(&objective_id, |_, current| *current == expires_at)
                .is_none()
            {
                return;
            }
            if let Some(objective) = supervisor
                .store
                .get_objective(&objective_id)
                .await
                .ok()
                .flatten()
            {
                if let Err(error) = supervisor.reconcile(objective).await {
                    tracing::error!(objective_id, ?error, "Objective lease 到期恢复失败");
                }
            }
        });
    }

    fn schedule_wait_timer(
        self: &Arc<Self>,
        objective_id: String,
        revision: u64,
        deadline: DateTime<Utc>,
    ) {
        if self
            .wait_timer_wakeups
            .get(&objective_id)
            .is_some_and(|existing| *existing == (revision, deadline))
        {
            return;
        }
        self.wait_timer_wakeups
            .insert(objective_id.clone(), (revision, deadline));
        let supervisor = Arc::clone(self);
        tokio::spawn(async move {
            let delay = (deadline - Utc::now())
                .to_std()
                .unwrap_or(std::time::Duration::ZERO);
            tokio::time::sleep(delay).await;
            supervisor.wait_timer_wakeups.remove(&objective_id);
            let Some(current) = supervisor
                .store
                .get_objective(&objective_id)
                .await
                .ok()
                .flatten()
            else {
                return;
            };
            if current.revision != revision
                || !matches!(
                    current.wait_condition,
                    Some(ObjectiveWaitCondition::Timer { deadline: current_deadline })
                        if current_deadline == deadline
                )
            {
                return;
            }
            match supervisor
                .store
                .update_objective_state(
                    &objective_id,
                    revision,
                    ObjectiveStatus::Active,
                    None,
                    Some("计时等待已到期"),
                )
                .await
            {
                Ok(ObjectiveMutation::Updated(woken)) => {
                    if let Err(error) = supervisor
                        .publish_state_event(
                            "wait_satisfied",
                            &woken,
                            Some("timer-deadline-reached"),
                        )
                        .await
                    {
                        tracing::error!(objective_id, ?error, "Objective timer 审计失败");
                        return;
                    }
                    if let Err(error) = supervisor.reconcile(woken).await {
                        tracing::error!(objective_id, ?error, "Objective timer 续跑失败");
                    }
                }
                Ok(_) => {}
                Err(error) => {
                    tracing::error!(objective_id, ?error, "Objective timer 状态更新失败")
                }
            }
        });
    }

    fn register_external_wait_subscription(
        self: &Arc<Self>,
        objective_id: &str,
        revision: u64,
        topic: &str,
    ) {
        if self
            .external_wait_subscriptions
            .get(objective_id)
            .is_some_and(|existing| existing.0 == revision && existing.1 == topic)
        {
            return;
        }
        self.remove_external_wait_subscription(objective_id);
        let supervisor = Arc::clone(self);
        let subscription_id = self.bus.subscribe(
            topic.to_string(),
            Arc::new(move |event| {
                let supervisor = Arc::clone(&supervisor);
                Box::pin(async move { supervisor.wake_non_routed_event(&event).await })
            }),
        );
        self.external_wait_subscriptions.insert(
            objective_id.to_string(),
            (revision, topic.to_string(), subscription_id),
        );
    }

    fn remove_external_wait_subscription(&self, objective_id: &str) {
        if let Some((_, (_, _, subscription_id))) =
            self.external_wait_subscriptions.remove(objective_id)
        {
            self.bus.unsubscribe(&subscription_id);
        }
    }

    fn clear_local_binding(&self, objective: &ObjectiveRecord) {
        if let Some(active) = self.evaluations.get(&objective.coordinator_session_id) {
            if active.objective_id == objective.id {
                self.evaluations
                    .unbind(&objective.coordinator_session_id, &active.evaluation_id);
            }
        }
    }

    async fn publish_state_event(
        &self,
        action: &str,
        objective: &ObjectiveRecord,
        reason: Option<&str>,
    ) -> Result<(), DynError> {
        let mut payload = vec![
            ("context_id".to_string(), json!(objective.context_id)),
            (
                "session_id".to_string(),
                json!(objective.coordinator_session_id),
            ),
            ("objective_id".to_string(), json!(objective.id)),
            ("objective_revision".to_string(), json!(objective.revision)),
            ("objective_status".to_string(), json!(objective.status)),
            (
                "wait_condition".to_string(),
                json!(objective.wait_condition),
            ),
            (
                "active_evaluation_id".to_string(),
                json!(objective.active_evaluation_id),
            ),
        ];
        if let Some(reason) = reason {
            payload.push(("reason".to_string(), json!(reason)));
        }
        let event = Event::new(
            format!(
                "objective_{}_{}_{}",
                action,
                objective.id,
                Utc::now().timestamp_nanos_opt().unwrap_or(0)
            ),
            "Runtime-ObjectiveSupervisor".to_string(),
            TYPE_OBJECTIVE_CONTROL.to_string(),
            format!("objective/{action}"),
            payload.into_iter().collect(),
        );
        self.audit_store.append(event.clone()).await?;
        self.bus.publish(event).await
    }

    async fn publish_recovery_observation(
        &self,
        objective: &ObjectiveRecord,
    ) -> Result<(), DynError> {
        let event = Event::new(
            format!(
                "objective_recovered_{}_{}",
                objective.id,
                Utc::now().timestamp_nanos_opt().unwrap_or(0)
            ),
            "Runtime-ObjectiveSupervisor".to_string(),
            TYPE_OBJECTIVE_CONTROL.to_string(),
            "objective/recovered".to_string(),
            vec![
                ("context_id".to_string(), json!(objective.context_id)),
                (
                    "session_id".to_string(),
                    json!(objective.coordinator_session_id),
                ),
                ("objective_id".to_string(), json!(objective.id)),
                ("objective_revision".to_string(), json!(objective.revision)),
                ("objective_status".to_string(), json!(objective.status)),
                (
                    "had_evaluation_lease".to_string(),
                    json!(objective.active_evaluation_id.is_some()),
                ),
                (
                    "wait_condition".to_string(),
                    json!(objective.wait_condition),
                ),
            ]
            .into_iter()
            .collect(),
        );
        self.audit_store.append(event.clone()).await?;
        self.bus.publish(event).await
    }
}

fn wait_matches_event(wait: &ObjectiveWaitCondition, event: &Event) -> bool {
    let payload_str = |key: &str| event.payload.get(key).and_then(|value| value.as_str());
    match wait {
        ObjectiveWaitCondition::ToolTask { task_id } => {
            payload_str("task_id") == Some(task_id.as_str())
                && matches!(
                    payload_str("task_status"),
                    Some("succeeded" | "failed" | "killed")
                )
        }
        ObjectiveWaitCondition::Delegation { delegation_id } => {
            payload_str("delegation_id") == Some(delegation_id.as_str())
                && matches!(
                    payload_str("tool_status").or_else(|| payload_str("status")),
                    Some("success" | "completed" | "error" | "failed" | "cancelled")
                )
        }
        ObjectiveWaitCondition::Timer { .. } => false,
        ObjectiveWaitCondition::Permission { request_id } => {
            payload_str("approval_id") == Some(request_id.as_str())
        }
        ObjectiveWaitCondition::UserInput { session_id } => {
            event.event_type == crate::event::TYPE_USER_MESSAGE
                && payload_str("session_id") == Some(session_id.as_str())
        }
        ObjectiveWaitCondition::ExternalEvent {
            topic,
            correlation_id,
        } => {
            event.topic == *topic && payload_str("correlation_id") == Some(correlation_id.as_str())
        }
        ObjectiveWaitCondition::ResourceAvailable { resource } => {
            event.topic == "runtime/resource_available"
                && payload_str("resource") == Some(resource.as_str())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evaluation_registry_does_not_overwrite_an_active_session_lane() {
        let registry = ObjectiveEvaluationRegistry::default();
        let first = ActiveObjectiveEvaluation {
            objective_id: "objective-a".to_string(),
            evaluation_id: "evaluation-a".to_string(),
            revision: 2,
            started_at: Utc::now(),
        };
        assert!(registry.try_bind("session-a", first.clone()).is_ok());
        registry.bind_work_item("work-a", first.clone());
        assert_eq!(registry.get_for_work_item("work-a"), Some(first.clone()));
        assert!(registry.get_for_work_item("work-b").is_none());
        let second = ActiveObjectiveEvaluation {
            objective_id: "objective-b".to_string(),
            evaluation_id: "evaluation-b".to_string(),
            revision: 2,
            started_at: Utc::now(),
        };
        assert_eq!(registry.try_bind("session-a", second), Err(first.clone()));
        registry.unbind("session-a", "wrong-evaluation");
        assert_eq!(registry.get("session-a"), Some(first));
        registry.unbind("session-a", "evaluation-a");
        assert!(registry.get("session-a").is_none());
        assert!(registry.get_for_work_item("work-a").is_none());
    }

    #[test]
    fn wait_conditions_match_only_their_exact_physical_wake_event() {
        let event = |event_type: &str, topic: &str, payload: serde_json::Value| {
            Event::new(
                "event-1".to_string(),
                "test".to_string(),
                event_type.to_string(),
                topic.to_string(),
                payload.as_object().unwrap().clone(),
            )
        };
        let running = event(
            TYPE_TOOL_OUTPUT,
            "chat/tool_output",
            json!({"task_id":"task-1","task_status":"running"}),
        );
        let completed = event(
            TYPE_TOOL_OUTPUT,
            "chat/tool_output",
            json!({"task_id":"task-1","task_status":"succeeded"}),
        );
        let task_wait = ObjectiveWaitCondition::ToolTask {
            task_id: "task-1".to_string(),
        };
        assert!(!wait_matches_event(&task_wait, &running));
        assert!(wait_matches_event(&task_wait, &completed));

        let user_wait = ObjectiveWaitCondition::UserInput {
            session_id: "session-b".to_string(),
        };
        assert!(wait_matches_event(
            &user_wait,
            &event(
                crate::event::TYPE_USER_MESSAGE,
                "chat/user_message",
                json!({"session_id":"session-b"}),
            )
        ));
        assert!(!wait_matches_event(
            &user_wait,
            &event(
                crate::event::TYPE_USER_MESSAGE,
                "chat/user_message",
                json!({"session_id":"session-a"}),
            )
        ));

        let external_wait = ObjectiveWaitCondition::ExternalEvent {
            topic: "build/released".to_string(),
            correlation_id: "release-42".to_string(),
        };
        assert!(wait_matches_event(
            &external_wait,
            &event(
                "external_event",
                "build/released",
                json!({"correlation_id":"release-42"}),
            )
        ));
        assert!(!wait_matches_event(
            &external_wait,
            &event(
                "external_event",
                "build/released",
                json!({"correlation_id":"release-41"}),
            )
        ));
    }
}
