use crate::event::{Event, InMemoryEventBus, TYPE_TOOL_OUTPUT};
use crate::llm::ToolDefinition;
use crate::memory::{
    EventStore, NewObjective, NewRuntimeTimer, ObjectiveMutation, ObjectiveRecord, ObjectiveStatus,
    ObjectiveStore, ObjectiveWaitCondition, QueryFilter, RuntimeTimerKind, RuntimeTimerRecord,
};
use crate::orchestrator::context::ContextEngine;
use crate::timer::{TimerDisposition, TimerEngine};
use crate::tool::{
    Tool, ToolExecutionClass, CURRENT_ATTEMPT_ID, CURRENT_CONTEXT_ID, CURRENT_PRINCIPAL_ID,
    CURRENT_SESSION_ID,
};
use chrono::{DateTime, Duration, Utc};
use dashmap::DashMap;
use serde::Deserialize;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::{watch, Mutex};

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

    fn execution_class(&self) -> ToolExecutionClass {
        ToolExecutionClass::LogicalInline
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
        let initiating_principal_id = CURRENT_PRINCIPAL_ID.try_with(Clone::clone).ok().flatten();
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
                .get_for_activation(&attempt_id)
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
                    && objective.initiating_principal_id == initiating_principal_id
                    && objective.parent_objective_id == parent_objective_id
                    && normalize_objective_statement(&objective.stated_objective)
                        == normalized_statement
            })
        {
            let adopted = if self
                .supervisor
                .evaluations
                .get_for_activation(&attempt_id)
                .is_none()
            {
                self.supervisor
                    .claim_routed_evaluation(&existing, &attempt_id, Some(&attempt_id), false)
                    .await?
            } else {
                None
            };
            if let Some(claimed) = &adopted {
                self.supervisor
                    .publish_state_event("evaluation_started", claimed, Some(&attempt_id))
                    .await?;
            } else {
                self.supervisor.reconcile(existing.clone()).await?;
            }
            let current = self.supervisor.get(&existing.id).await?.unwrap_or(existing);
            return Ok(serde_json::to_string_pretty(&json!({
                "status": "existing",
                "created": false,
                "objective_id": current.id,
                "objective_status": current.status,
                "revision": current.revision,
                "activation_adoption": if adopted.is_some() { "current-activation" } else { "already-routed-or-independent-continuation" },
                "guidance": "相同的非终态 Objective 已存在；不要重复创建。继续执行它，或在有权限时更新其状态。"
            }))?);
        }

        let nonce = Utc::now().timestamp_nanos_opt().unwrap_or(0);
        let objective_id = format!("objective-auto-{nonce}");
        let source_event_id = format!("objective_auto_request_{nonce}");
        let mut request_payload = vec![
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
        ];
        if let Some(principal_id) = &initiating_principal_id {
            request_payload.push(("principal_id".to_string(), json!(principal_id)));
        }
        let request_event = Event::new(
            source_event_id.clone(),
            "Agent-Morphz".to_string(),
            TYPE_OBJECTIVE_CONTROL.to_string(),
            "objective/autonomous_requested".to_string(),
            request_payload.into_iter().collect(),
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
                initiating_principal_id,
                stated_objective: stated_objective.to_string(),
                token_budget: args.token_budget,
            })
            .await?;

        let adopted = if self
            .supervisor
            .evaluations
            .get_for_activation(&attempt_id)
            .is_none()
        {
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
        } else {
            self.supervisor.reconcile(created.clone()).await?;
        }
        let current = self.supervisor.get(&created.id).await?.unwrap_or(created);

        Ok(serde_json::to_string_pretty(&json!({
            "status": "created",
            "created": true,
            "objective_id": current.id,
            "objective_status": current.status,
            "revision": current.revision,
            "context_id": current.context_id,
            "coordinator_session_id": current.coordinator_session_id,
            "parent_objective_id": current.parent_objective_id,
            "activation_adoption": if adopted.is_some() { "current-activation" } else { "independent-continuation" },
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

    fn execution_class(&self) -> ToolExecutionClass {
        ToolExecutionClass::LogicalInline
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
            .get_for_activation(&attempt_id)
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
pub struct ObjectiveEvaluationRegistry {
    by_objective: DashMap<String, ActiveObjectiveEvaluation>,
    by_activation: DashMap<String, ActiveObjectiveEvaluation>,
    /// A cancellation tombstone is keyed by the persistent Evaluation ID, not
    /// by Session.  It therefore cannot cancel an unrelated dialogue or a
    /// sibling Objective that happens to share the same coordinator Session.
    cancelled_evaluations: DashMap<String, String>,
    cancellation_epoch: watch::Sender<u64>,
}

impl Default for ObjectiveEvaluationRegistry {
    fn default() -> Self {
        let (cancellation_epoch, _) = watch::channel(0);
        Self {
            by_objective: DashMap::new(),
            by_activation: DashMap::new(),
            cancelled_evaluations: DashMap::new(),
            cancellation_epoch,
        }
    }
}

impl ObjectiveEvaluationRegistry {
    pub fn get_for_objective(&self, objective_id: &str) -> Option<ActiveObjectiveEvaluation> {
        self.by_objective
            .get(objective_id)
            .map(|entry| entry.clone())
    }

    pub fn get_for_activation(&self, activation_id: &str) -> Option<ActiveObjectiveEvaluation> {
        self.by_activation
            .get(canonical_activation_id(activation_id))
            .map(|entry| entry.clone())
    }

    pub fn bind_activation(&self, activation_id: &str, evaluation: ActiveObjectiveEvaluation) {
        self.by_activation.insert(
            canonical_activation_id(activation_id).to_string(),
            evaluation.clone(),
        );
        // Another Activation for the same Evaluation can bind after its peer
        // was cancelled. Bump the epoch after that late bind so it observes
        // the existing tombstone too.
        if self.evaluation_is_cancelled(&evaluation) {
            self.bump_cancellation_epoch();
        }
    }

    pub fn remove_activation(&self, activation_id: &str) {
        if let Some((_, evaluation)) = self
            .by_activation
            .remove(canonical_activation_id(activation_id))
        {
            self.cleanup_cancellation_tombstone(&evaluation);
        }
    }

    pub fn cancel_evaluation(&self, objective_id: &str, evaluation_id: &str) -> bool {
        let active = self.by_activation.iter().any(|entry| {
            entry.objective_id == objective_id && entry.evaluation_id == evaluation_id
        });
        if !active {
            // A not-yet-claimed continuation is rejected against the durable
            // Objective state before model execution, so no process-local
            // tombstone is needed (and none can leak if that route never arrives).
            return false;
        }
        self.cancelled_evaluations
            .insert(evaluation_id.to_string(), objective_id.to_string());
        self.bump_cancellation_epoch();
        true
    }

    pub fn activation_ids_for_evaluation(
        &self,
        objective_id: &str,
        evaluation_id: &str,
    ) -> Vec<String> {
        self.by_activation
            .iter()
            .filter(|entry| {
                entry.objective_id == objective_id && entry.evaluation_id == evaluation_id
            })
            .map(|entry| entry.key().clone())
            .collect()
    }

    pub fn clear_cancelled_evaluation(&self, objective_id: &str, evaluation_id: &str) {
        self.cancelled_evaluations
            .remove_if(evaluation_id, |_, cancelled_objective_id| {
                cancelled_objective_id == objective_id
            });
    }

    pub fn cancelled_activation(&self, activation_id: &str) -> Option<ActiveObjectiveEvaluation> {
        self.get_for_activation(activation_id)
            .filter(|evaluation| self.evaluation_is_cancelled(evaluation))
    }

    pub async fn wait_for_activation_cancellation(
        &self,
        activation_id: &str,
    ) -> ActiveObjectiveEvaluation {
        let mut cancellation = self.cancellation_epoch.subscribe();
        loop {
            if let Some(evaluation) = self.cancelled_activation(activation_id) {
                return evaluation;
            }
            // watch retains the latest epoch, so a cancellation between the
            // predicate above and this await cannot be lost.
            let _ = cancellation.changed().await;
        }
    }

    fn try_bind(
        &self,
        objective_id: &str,
        evaluation: ActiveObjectiveEvaluation,
    ) -> Result<(), ActiveObjectiveEvaluation> {
        debug_assert_eq!(objective_id, evaluation.objective_id);
        match self.by_objective.entry(objective_id.to_string()) {
            dashmap::mapref::entry::Entry::Vacant(entry) => {
                entry.insert(evaluation);
                Ok(())
            }
            dashmap::mapref::entry::Entry::Occupied(entry) => Err(entry.get().clone()),
        }
    }

    fn unbind(&self, objective_id: &str, evaluation_id: &str) {
        self.by_objective.remove_if(objective_id, |_, active| {
            active.evaluation_id == evaluation_id
        });
        // Activation routing has a longer lifetime than the Objective scheduling
        // slot. A pause/cancel releases the slot first, then signals the exact
        // running Activation.  The Orchestrator removes this binding only after
        // that Activation reaches a durable terminal state.
    }

    fn evaluation_is_cancelled(&self, evaluation: &ActiveObjectiveEvaluation) -> bool {
        self.cancelled_evaluations
            .get(&evaluation.evaluation_id)
            .is_some_and(|objective_id| objective_id.as_str() == evaluation.objective_id)
    }

    fn cleanup_cancellation_tombstone(&self, evaluation: &ActiveObjectiveEvaluation) {
        let still_bound_to_objective = self.by_objective.iter().any(|entry| {
            entry.objective_id == evaluation.objective_id
                && entry.evaluation_id == evaluation.evaluation_id
        });
        let still_bound_to_work = self.by_activation.iter().any(|entry| {
            entry.objective_id == evaluation.objective_id
                && entry.evaluation_id == evaluation.evaluation_id
        });
        if !still_bound_to_objective && !still_bound_to_work {
            self.clear_cancelled_evaluation(&evaluation.objective_id, &evaluation.evaluation_id);
        }
    }

    fn bump_cancellation_epoch(&self) {
        let next = (*self.cancellation_epoch.borrow()).wrapping_add(1);
        self.cancellation_epoch.send_replace(next);
    }
}

fn canonical_activation_id(attempt_id: &str) -> &str {
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
    timers: Arc<TimerEngine>,
    lease_duration: Duration,
    schedule_locks: DashMap<String, Arc<Mutex<()>>>,
    external_wait_subscriptions: DashMap<String, (u64, String, String)>,
    started: AtomicBool,
}

impl ObjectiveSupervisor {
    pub fn new(
        store: Arc<dyn ObjectiveStore>,
        audit_store: Arc<dyn EventStore>,
        bus: Arc<InMemoryEventBus>,
        evaluations: Arc<ObjectiveEvaluationRegistry>,
        timers: Arc<TimerEngine>,
        lease_duration: std::time::Duration,
    ) -> Self {
        let lease_duration =
            Duration::from_std(lease_duration).unwrap_or_else(|_| Duration::minutes(10));
        Self {
            store,
            audit_store,
            bus,
            evaluations,
            timers,
            lease_duration,
            schedule_locks: DashMap::new(),
            external_wait_subscriptions: DashMap::new(),
            started: AtomicBool::new(false),
        }
    }

    pub fn register_timer_handlers(self: &Arc<Self>) -> Result<(), DynError> {
        let supervisor = Arc::downgrade(self);
        self.timers
            .register_handler(RuntimeTimerKind::ObjectiveWait, move |timer| {
                let supervisor = supervisor.clone();
                async move {
                    let Some(supervisor) = supervisor.upgrade() else {
                        return Ok(TimerDisposition::Complete);
                    };
                    supervisor.dispatch_wait_timer(timer).await
                }
            })?;

        let supervisor = Arc::downgrade(self);
        self.timers
            .register_handler(RuntimeTimerKind::ObjectiveLease, move |timer| {
                let supervisor = supervisor.clone();
                async move {
                    let Some(supervisor) = supervisor.upgrade() else {
                        return Ok(TimerDisposition::Complete);
                    };
                    supervisor.dispatch_lease_timer(timer).await
                }
            })
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
            if objective.status == ObjectiveStatus::Active {
                if let Some(event) = self.find_persisted_wait_event(&objective).await? {
                    tracing::info!(
                        objective_id = %objective.id,
                        event_id = %event.id,
                        event_topic = %event.topic,
                        "Objective 启动恢复发现已持久化的等待完成事件"
                    );
                    self.wake_non_routed_event(&event).await?;
                    continue;
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

    /// Validate an embedded Objective route against the durable lease before
    /// the Orchestrator starts a model Evaluation.  This rejects a continuation
    /// that was queued before pause/cancel (including after a Runtime restart,
    /// when process-local cancellation tombstones no longer exist).
    pub async fn accepts_routed_evaluation(
        &self,
        objective_id: &str,
        evaluation_id: &str,
        objective_control_receipt: bool,
    ) -> Result<bool, DynError> {
        Ok(self
            .store
            .get_objective(objective_id)
            .await?
            .is_some_and(|objective| {
                (objective.status == ObjectiveStatus::Active
                    && objective.active_evaluation_id.as_deref() == Some(evaluation_id)
                    && objective
                        .evaluation_lease_expires_at
                        .is_some_and(|expires_at| expires_at > Utc::now()))
                    || (objective_control_receipt
                        && matches!(
                            objective.status,
                            ObjectiveStatus::Blocked
                                | ObjectiveStatus::Completed
                                | ObjectiveStatus::Failed
                        ))
            }))
    }

    /// Check the durable Objective fencing token owned by one Activation.
    /// Activations without an Objective route are not fenced here.
    pub async fn activation_fence_is_current(&self, activation_id: &str) -> Result<bool, DynError> {
        let Some(binding) = self.evaluations.get_for_activation(activation_id) else {
            return Ok(true);
        };
        if self.evaluations.evaluation_is_cancelled(&binding) {
            return Ok(false);
        }
        Ok(self
            .store
            .get_objective(&binding.objective_id)
            .await?
            .is_some_and(|objective| {
                objective.status == ObjectiveStatus::Active
                    && objective.wait_condition.is_none()
                    && objective.active_evaluation_id.as_deref()
                        == Some(binding.evaluation_id.as_str())
                    && objective
                        .evaluation_lease_expires_at
                        .is_some_and(|expires_at| expires_at > Utc::now())
            }))
    }

    /// Keep one exact Evaluation lease alive while its Activation is running.
    /// A replacement Evaluation changes `active_evaluation_id`; the stale
    /// heartbeat then loses the fence and returns so Orchestrator can cancel
    /// the old Activation before it performs more work.
    pub async fn maintain_activation_lease(
        &self,
        activation_id: &str,
    ) -> Result<ActiveObjectiveEvaluation, DynError> {
        let binding = self
            .evaluations
            .get_for_activation(activation_id)
            .ok_or_else(|| {
                format!("Activation '{activation_id}' 缺少 Objective Evaluation 路由")
            })?;
        let lease_duration = self
            .lease_duration
            .to_std()
            .unwrap_or_else(|_| std::time::Duration::from_secs(600));
        let heartbeat = (lease_duration / 3).max(std::time::Duration::from_millis(50));
        loop {
            tokio::time::sleep(heartbeat).await;
            if self.evaluations.evaluation_is_cancelled(&binding) {
                return Ok(binding);
            }
            let lease_expires_at = Utc::now() + self.lease_duration;
            match self
                .store
                .renew_objective_evaluation(
                    &binding.objective_id,
                    &binding.evaluation_id,
                    lease_expires_at,
                )
                .await?
            {
                ObjectiveMutation::Updated(_) => {
                    tracing::debug!(
                        objective_id = %binding.objective_id,
                        evaluation_id = %binding.evaluation_id,
                        activation_id,
                        lease_expires_at = %lease_expires_at,
                        "Objective Evaluation 运行中续租"
                    );
                }
                ObjectiveMutation::Conflict { current } => {
                    tracing::warn!(
                        objective_id = %binding.objective_id,
                        evaluation_id = %binding.evaluation_id,
                        activation_id,
                        active_evaluation_id = ?current.active_evaluation_id,
                        current_status = ?current.status,
                        "Objective Evaluation fencing token 已失效"
                    );
                    self.evaluations
                        .cancel_evaluation(&binding.objective_id, &binding.evaluation_id);
                    return Ok(binding);
                }
                ObjectiveMutation::NotFound => {
                    self.evaluations
                        .cancel_evaluation(&binding.objective_id, &binding.evaluation_id);
                    return Ok(binding);
                }
            }
        }
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

    /// Re-run scheduling policy for every non-terminal Objective in one
    /// Cognitive Context. Control paths call this only after the exact stopped
    /// Evaluation has received its cancellation signal, so the same Objective
    /// cannot claim a replacement before its old Activation is fenced.
    pub async fn reconcile_context(self: &Arc<Self>, context_id: &str) -> Result<(), DynError> {
        for objective in self
            .store
            .list_context_objectives(context_id, false)
            .await?
        {
            self.reconcile(objective).await?;
        }
        Ok(())
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
            if updated.status == ObjectiveStatus::Failed {
                self.reconcile_context(&updated.context_id).await?;
            }
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
        activation_id: &str,
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
                self.claim_routed_evaluation(&woken, &event.id, Some(activation_id), true)
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

    /// Close the crash window between committing a durable wake fact and
    /// dispatching it through the process-local EventBus. Only non-routed
    /// waits are eligible here; routed user/tool events are recovered by their
    /// own scheduler outboxes. The Objective update time is the lower bound so
    /// an event observed before the current wait was installed cannot wake it.
    async fn find_persisted_wait_event(
        &self,
        objective: &ObjectiveRecord,
    ) -> Result<Option<Event>, DynError> {
        let Some(wait) = objective.wait_condition.as_ref() else {
            return Ok(None);
        };
        let topic = match wait {
            ObjectiveWaitCondition::Permission { .. } => "runtime/approval_decision".to_string(),
            ObjectiveWaitCondition::ExternalEvent { topic, .. } => topic.clone(),
            ObjectiveWaitCondition::ResourceAvailable { .. } => {
                "runtime/resource_available".to_string()
            }
            ObjectiveWaitCondition::ToolTask { .. }
            | ObjectiveWaitCondition::Delegation { .. }
            | ObjectiveWaitCondition::Timer { .. }
            | ObjectiveWaitCondition::UserInput { .. } => return Ok(None),
        };
        let events = self
            .audit_store
            .query(QueryFilter {
                context_id: Some(objective.context_id.clone()),
                start_time: Some(objective.updated_at),
                topic: Some(topic),
                ..QueryFilter::default()
            })
            .await?;
        Ok(events
            .into_iter()
            .find(|event| wait_matches_event(wait, event)))
    }

    pub async fn terminal_outcome(self: &Arc<Self>, event: &Event) -> Result<(), DynError> {
        let Some(_session_id) = event
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
            .get("activation_id")
            .and_then(|value| value.as_str())
            .and_then(|activation_id| self.evaluations.get_for_activation(activation_id))
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
        self.cancel_lease_timer(&binding.objective_id).await?;
        self.evaluations
            .unbind(&binding.objective_id, &binding.evaluation_id);
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

    pub async fn record_prompt_tokens_for_activation(
        &self,
        activation_id: &str,
        tokens: usize,
    ) -> Result<(), DynError> {
        let Some(binding) = self.evaluations.get_for_activation(activation_id) else {
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
            self.cancel_objective_timers(&objective.id).await?;
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
            self.cancel_lease_timer(&objective.id).await?;
            match wait {
                ObjectiveWaitCondition::Timer { deadline } => {
                    self.remove_external_wait_subscription(&objective.id);
                    self.schedule_wait_timer(&objective, *deadline).await?;
                }
                ObjectiveWaitCondition::ExternalEvent { topic, .. } => {
                    self.cancel_wait_timer(&objective.id).await?;
                    self.register_external_wait_subscription(
                        &objective.id,
                        objective.revision,
                        topic,
                    );
                }
                _ => {
                    self.cancel_wait_timer(&objective.id).await?;
                    self.remove_external_wait_subscription(&objective.id);
                }
            }
            return Ok(());
        }
        self.cancel_wait_timer(&objective.id).await?;
        self.remove_external_wait_subscription(&objective.id);
        if let Some(expires_at) = objective.evaluation_lease_expires_at {
            if expires_at > Utc::now() {
                self.schedule_lease_expiry(&objective, expires_at).await?;
                return Ok(());
            }
            self.revoke_local_evaluation(&objective);
        }
        self.schedule(objective.id).await
    }

    async fn claim_routed_evaluation(
        self: &Arc<Self>,
        objective: &ObjectiveRecord,
        source_event_id: &str,
        activation_id: Option<&str>,
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
            .try_bind(&objective.id, local_binding)
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
            self.evaluations.unbind(&objective.id, &evaluation_id);
            return Ok(None);
        };
        if let Some(mut active) = self.evaluations.by_objective.get_mut(&objective.id) {
            if active.evaluation_id == evaluation_id {
                active.revision = claimed.revision;
            }
        }
        if let Some(activation_id) = activation_id {
            self.evaluations.bind_activation(
                activation_id,
                ActiveObjectiveEvaluation {
                    objective_id: claimed.id.clone(),
                    evaluation_id: evaluation_id.clone(),
                    revision: claimed.revision,
                    started_at: Utc::now(),
                },
            );
        }
        self.schedule_lease_expiry(&claimed, lease_expires_at)
            .await?;
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
            .try_bind(&objective.id, local_binding)
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
        let mut continuation_payload = vec![
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
        ];
        if let Some(principal_id) = &objective.initiating_principal_id {
            continuation_payload.push(("principal_id".to_string(), json!(principal_id)));
        }
        let continuation_event = Event::new(
            format!("objective_continue_{evaluation_id}"),
            "Runtime-ObjectiveSupervisor".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            continuation_payload.into_iter().collect(),
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
            self.evaluations.unbind(&objective.id, &evaluation_id);
            return Ok(());
        };
        if let Some(mut active) = self.evaluations.by_objective.get_mut(&objective.id) {
            if active.evaluation_id == evaluation_id {
                active.revision = claimed.revision;
            }
        }
        self.schedule_lease_expiry(&claimed, lease_expires_at)
            .await?;
        self.publish_state_event("evaluation_started", &claimed, None)
            .await?;
        self.bus.dispatch_persisted(continuation_event).await?;
        Ok(())
    }

    async fn schedule_lease_expiry(
        &self,
        objective: &ObjectiveRecord,
        expires_at: DateTime<Utc>,
    ) -> Result<(), DynError> {
        let Some(evaluation_id) = objective.active_evaluation_id.as_deref() else {
            self.cancel_lease_timer(&objective.id).await?;
            return Ok(());
        };
        self.timers
            .schedule(NewRuntimeTimer {
                id: objective_lease_timer_id(&objective.id),
                generation: objective.revision,
                kind: RuntimeTimerKind::ObjectiveLease,
                owner_id: objective.id.clone(),
                due_at: expires_at,
                payload: json!({
                    "objective_id": objective.id,
                    "evaluation_id": evaluation_id,
                    "lease_expires_at": expires_at,
                }),
            })
            .await?;
        Ok(())
    }

    async fn schedule_wait_timer(
        &self,
        objective: &ObjectiveRecord,
        deadline: DateTime<Utc>,
    ) -> Result<(), DynError> {
        self.timers
            .schedule(NewRuntimeTimer {
                id: objective_wait_timer_id(&objective.id),
                generation: objective.revision,
                kind: RuntimeTimerKind::ObjectiveWait,
                owner_id: objective.id.clone(),
                due_at: deadline,
                payload: json!({
                    "objective_id": objective.id,
                    "deadline": deadline,
                }),
            })
            .await?;
        Ok(())
    }

    async fn dispatch_wait_timer(
        self: Arc<Self>,
        timer: RuntimeTimerRecord,
    ) -> Result<TimerDisposition, DynError> {
        let Some(current) = self.store.get_objective(&timer.owner_id).await? else {
            return Ok(TimerDisposition::Complete);
        };
        let Some(ObjectiveWaitCondition::Timer { deadline }) = current.wait_condition.as_ref()
        else {
            return Ok(TimerDisposition::Complete);
        };
        if current.status != ObjectiveStatus::Active {
            return Ok(TimerDisposition::Complete);
        }
        if current.revision != timer.generation || *deadline != timer.due_at {
            self.schedule_wait_timer(&current, *deadline).await?;
            return Ok(TimerDisposition::Complete);
        }
        if *deadline > Utc::now() {
            return Ok(TimerDisposition::Reschedule {
                due_at: *deadline,
                reason: Some("Objective timer deadline 尚未到达".to_string()),
            });
        }
        match self
            .store
            .update_objective_state(
                &current.id,
                current.revision,
                ObjectiveStatus::Active,
                None,
                Some("计时等待已到期"),
            )
            .await?
        {
            ObjectiveMutation::Updated(woken) => {
                self.publish_state_event("wait_satisfied", &woken, Some("timer-deadline-reached"))
                    .await?;
                self.schedule(woken.id).await?;
            }
            ObjectiveMutation::Conflict { current } => self.reconcile(current).await?,
            ObjectiveMutation::NotFound => {}
        }
        Ok(TimerDisposition::Complete)
    }

    async fn dispatch_lease_timer(
        self: Arc<Self>,
        timer: RuntimeTimerRecord,
    ) -> Result<TimerDisposition, DynError> {
        let Some(current) = self.store.get_objective(&timer.owner_id).await? else {
            return Ok(TimerDisposition::Complete);
        };
        let Some(expires_at) = current.evaluation_lease_expires_at else {
            return Ok(TimerDisposition::Complete);
        };
        let timer_evaluation_id = timer
            .payload
            .get("evaluation_id")
            .and_then(serde_json::Value::as_str);
        if current.status != ObjectiveStatus::Active
            || current.wait_condition.is_some()
            || current.active_evaluation_id.as_deref() != timer_evaluation_id
        {
            return Ok(TimerDisposition::Complete);
        }
        if current.revision != timer.generation {
            self.schedule_lease_expiry(&current, expires_at).await?;
            return Ok(TimerDisposition::Complete);
        }
        if expires_at != timer.due_at {
            return Ok(TimerDisposition::Reschedule {
                due_at: expires_at,
                reason: Some("Objective Evaluation 已由运行中的 Activation 续租".to_string()),
            });
        }
        if expires_at > Utc::now() {
            return Ok(TimerDisposition::Reschedule {
                due_at: expires_at,
                reason: Some("Objective evaluation lease 尚未到期".to_string()),
            });
        }
        // Revoke the exact expired Evaluation before making the Objective
        // schedulable again. Its Activation observes the tombstone and stops;
        // a new claim receives a different evaluation_id fencing token.
        self.revoke_local_evaluation(&current);
        self.reconcile(current).await?;
        Ok(TimerDisposition::Complete)
    }

    async fn cancel_wait_timer(&self, objective_id: &str) -> Result<(), DynError> {
        self.timers
            .cancel(&objective_wait_timer_id(objective_id))
            .await?;
        Ok(())
    }

    async fn cancel_lease_timer(&self, objective_id: &str) -> Result<(), DynError> {
        self.timers
            .cancel(&objective_lease_timer_id(objective_id))
            .await?;
        Ok(())
    }

    async fn cancel_objective_timers(&self, objective_id: &str) -> Result<(), DynError> {
        self.cancel_wait_timer(objective_id).await?;
        self.cancel_lease_timer(objective_id).await
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
        if let Some(active) = self.evaluations.get_for_objective(&objective.id) {
            self.evaluations
                .unbind(&objective.id, &active.evaluation_id);
        }
    }

    fn revoke_local_evaluation(&self, objective: &ObjectiveRecord) {
        if let Some(evaluation_id) = objective.active_evaluation_id.as_deref() {
            self.evaluations
                .cancel_evaluation(&objective.id, evaluation_id);
        }
        self.clear_local_binding(objective);
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
        if let Some(principal_id) = &objective.initiating_principal_id {
            payload.push(("principal_id".to_string(), json!(principal_id)));
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
                "had_evaluation_lease".to_string(),
                json!(objective.active_evaluation_id.is_some()),
            ),
            (
                "wait_condition".to_string(),
                json!(objective.wait_condition),
            ),
        ];
        if let Some(principal_id) = &objective.initiating_principal_id {
            payload.push(("principal_id".to_string(), json!(principal_id)));
        }
        let event = Event::new(
            format!(
                "objective_recovered_{}_{}",
                objective.id,
                Utc::now().timestamp_nanos_opt().unwrap_or(0)
            ),
            "Runtime-ObjectiveSupervisor".to_string(),
            TYPE_OBJECTIVE_CONTROL.to_string(),
            "objective/recovered".to_string(),
            payload.into_iter().collect(),
        );
        self.audit_store.append(event.clone()).await?;
        self.bus.publish(event).await
    }
}

fn objective_wait_timer_id(objective_id: &str) -> String {
    format!("objective-wait:{objective_id}")
}

fn objective_lease_timer_id(objective_id: &str) -> String {
    format!("objective-lease:{objective_id}")
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
    use crate::memory::sqlite::SqliteStore;
    use crate::memory::{
        NewAgent, NewCognitiveContext, NewSession, SessionDirectoryStore as _, SessionMountKind,
        TimerStore,
    };
    use tempfile::NamedTempFile;

    #[tokio::test]
    async fn startup_recovers_a_persisted_external_wake_that_was_never_dispatched() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(&database.path().to_string_lossy())
                .await
                .unwrap(),
        );
        store
            .create_agent_bundle(
                NewAgent {
                    id: "agent-recovery".to_string(),
                    title: "Recovery Agent".to_string(),
                    root_context_id: "context-recovery".to_string(),
                },
                NewCognitiveContext {
                    id: "context-recovery".to_string(),
                    agent_id: "agent-recovery".to_string(),
                    title: "Recovery Context".to_string(),
                },
                NewSession {
                    id: "session-recovery".to_string(),
                    agent_id: "agent-recovery".to_string(),
                    context_id: "context-recovery".to_string(),
                    parent_session_id: None,
                    title: "Recovery Session".to_string(),
                    mount_kind: SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        store
            .create_objective(NewObjective {
                id: "objective-persisted-wake".to_string(),
                agent_id: "agent-recovery".to_string(),
                context_id: "context-recovery".to_string(),
                coordinator_session_id: "session-recovery".to_string(),
                delivery_session_id: "session-recovery".to_string(),
                parent_objective_id: None,
                source_event_id: "source-persisted-wake".to_string(),
                initiating_principal_id: Some("principal:recovery-user".to_string()),
                stated_objective: "外部事件到达后继续".to_string(),
                token_budget: None,
            })
            .await
            .unwrap();
        let waiting = store
            .update_objective_state(
                "objective-persisted-wake",
                1,
                ObjectiveStatus::Active,
                Some(ObjectiveWaitCondition::ExternalEvent {
                    topic: "build/released".to_string(),
                    correlation_id: "release-42".to_string(),
                }),
                Some("等待构建发布"),
            )
            .await
            .unwrap();
        assert!(matches!(waiting, ObjectiveMutation::Updated(_)));

        // This is the exact commit-before-dispatch crash window: the physical
        // fact is durable, but no EventBus instance has ever observed it.
        let wake_event = Event::new(
            "release-event-42".to_string(),
            "Build-System".to_string(),
            "external_event".to_string(),
            "build/released".to_string(),
            [
                ("context_id".to_string(), json!("context-recovery")),
                ("session_id".to_string(), json!("session-recovery")),
                ("correlation_id".to_string(), json!("release-42")),
            ]
            .into_iter()
            .collect(),
        );
        store.append(wake_event.clone()).await.unwrap();

        let bus = Arc::new(InMemoryEventBus::new());
        let timers = Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>));
        let supervisor = Arc::new(ObjectiveSupervisor::new(
            Arc::clone(&store) as Arc<dyn ObjectiveStore>,
            Arc::clone(&store) as Arc<dyn EventStore>,
            bus,
            Arc::new(ObjectiveEvaluationRegistry::default()),
            timers,
            std::time::Duration::from_secs(600),
        ));
        supervisor.start().await.unwrap();

        let recovered = store
            .get_objective("objective-persisted-wake")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(recovered.status, ObjectiveStatus::Active);
        assert!(recovered.wait_condition.is_none());
        assert!(recovered.active_evaluation_id.is_some());
        assert_eq!(recovered.continuation_sequence, 1);
        assert_eq!(
            recovered.initiating_principal_id.as_deref(),
            Some("principal:recovery-user")
        );
        let wait_events = store
            .query(QueryFilter {
                context_id: Some("context-recovery".to_string()),
                topic: Some("objective/wait_satisfied".to_string()),
                ..QueryFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(wait_events.len(), 1);
        assert_eq!(
            wait_events[0]
                .payload
                .get("principal_id")
                .and_then(serde_json::Value::as_str),
            Some("principal:recovery-user")
        );
        assert_eq!(
            wait_events[0]
                .payload
                .get("reason")
                .and_then(serde_json::Value::as_str),
            Some(wake_event.id.as_str())
        );
        let continuation_events = store
            .query(QueryFilter {
                context_id: Some("context-recovery".to_string()),
                topic: Some("chat/tool_output".to_string()),
                ..QueryFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(continuation_events.len(), 1);
        assert_eq!(
            continuation_events[0]
                .payload
                .get("principal_id")
                .and_then(serde_json::Value::as_str),
            Some("principal:recovery-user")
        );
    }

    #[test]
    fn evaluation_registry_serializes_each_objective_but_not_its_session() {
        let registry = ObjectiveEvaluationRegistry::default();
        let first = ActiveObjectiveEvaluation {
            objective_id: "objective-a".to_string(),
            evaluation_id: "evaluation-a".to_string(),
            revision: 2,
            started_at: Utc::now(),
        };
        assert!(registry.try_bind("objective-a", first.clone()).is_ok());
        registry.bind_activation("work-a", first.clone());
        assert_eq!(registry.get_for_activation("work-a"), Some(first.clone()));
        assert!(registry.get_for_activation("work-b").is_none());
        let competing = ActiveObjectiveEvaluation {
            objective_id: "objective-a".to_string(),
            evaluation_id: "evaluation-a-2".to_string(),
            revision: 3,
            started_at: Utc::now(),
        };
        assert_eq!(
            registry.try_bind("objective-a", competing),
            Err(first.clone())
        );
        let sibling = ActiveObjectiveEvaluation {
            objective_id: "objective-b".to_string(),
            evaluation_id: "evaluation-b".to_string(),
            revision: 2,
            started_at: Utc::now(),
        };
        assert!(registry.try_bind("objective-b", sibling.clone()).is_ok());
        registry.bind_activation("work-b", sibling.clone());
        registry.unbind("objective-a", "wrong-evaluation");
        assert_eq!(
            registry.get_for_objective("objective-a"),
            Some(first.clone())
        );
        assert_eq!(
            registry.get_for_objective("objective-b"),
            Some(sibling.clone())
        );
        registry.unbind("objective-a", "evaluation-a");
        assert!(registry.get_for_objective("objective-a").is_none());
        assert_eq!(
            registry.get_for_objective("objective-b"),
            Some(sibling.clone())
        );
        assert_eq!(registry.get_for_activation("work-a"), Some(first));
        registry.remove_activation("work-a");
        assert!(registry.get_for_activation("work-a").is_none());
        assert_eq!(registry.get_for_activation("work-b"), Some(sibling));
    }

    #[tokio::test]
    async fn evaluation_cancellation_targets_only_bound_work_and_cleans_its_tombstone() {
        let registry = Arc::new(ObjectiveEvaluationRegistry::default());
        let first = ActiveObjectiveEvaluation {
            objective_id: "objective-a".to_string(),
            evaluation_id: "evaluation-a".to_string(),
            revision: 2,
            started_at: Utc::now(),
        };
        let second = ActiveObjectiveEvaluation {
            objective_id: "objective-b".to_string(),
            evaluation_id: "evaluation-b".to_string(),
            revision: 4,
            started_at: Utc::now(),
        };
        registry.bind_activation("work-a", first.clone());
        registry.bind_activation("work-b", second.clone());

        let waiting = {
            let registry = Arc::clone(&registry);
            tokio::spawn(async move {
                registry
                    .wait_for_activation_cancellation("work-a_response_retry_1")
                    .await
            })
        };
        assert!(registry.cancel_evaluation("objective-a", "evaluation-a"));
        assert_eq!(waiting.await.unwrap(), first);
        assert!(registry.cancelled_activation("work-b").is_none());
        assert!(registry.cancelled_activation("unbound-dialogue").is_none());

        registry.remove_activation("work-a_response_retry_2");
        assert!(!registry.cancelled_evaluations.contains_key("evaluation-a"));
        assert_eq!(registry.get_for_activation("work-b"), Some(second));

        assert!(!registry.cancel_evaluation("objective-late", "evaluation-never-claimed"));
        assert!(!registry
            .cancelled_evaluations
            .contains_key("evaluation-never-claimed"));
    }

    #[tokio::test]
    async fn stale_evaluation_heartbeat_loses_fence_and_cancels_its_activation() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(&database.path().to_string_lossy())
                .await
                .unwrap(),
        );
        store
            .create_agent_bundle(
                NewAgent {
                    id: "agent-fence".to_string(),
                    title: "Fence Agent".to_string(),
                    root_context_id: "context-fence".to_string(),
                },
                NewCognitiveContext {
                    id: "context-fence".to_string(),
                    agent_id: "agent-fence".to_string(),
                    title: "Fence Context".to_string(),
                },
                NewSession {
                    id: "session-fence".to_string(),
                    agent_id: "agent-fence".to_string(),
                    context_id: "context-fence".to_string(),
                    parent_session_id: None,
                    title: "Fence Session".to_string(),
                    mount_kind: SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        let created = store
            .create_objective(NewObjective {
                id: "objective-fence".to_string(),
                agent_id: "agent-fence".to_string(),
                context_id: "context-fence".to_string(),
                coordinator_session_id: "session-fence".to_string(),
                delivery_session_id: "session-fence".to_string(),
                parent_objective_id: None,
                source_event_id: "source-fence".to_string(),
                initiating_principal_id: None,
                stated_objective: "verify stale evaluation fencing".to_string(),
                token_budget: None,
            })
            .await
            .unwrap();
        let claimed = match store
            .claim_objective_evaluation(
                &created.id,
                created.revision,
                "evaluation-old",
                Utc::now() + Duration::milliseconds(150),
            )
            .await
            .unwrap()
        {
            ObjectiveMutation::Updated(objective) => objective,
            mutation => panic!("unexpected claim: {mutation:?}"),
        };
        let registry = Arc::new(ObjectiveEvaluationRegistry::default());
        let binding = ActiveObjectiveEvaluation {
            objective_id: claimed.id.clone(),
            evaluation_id: "evaluation-old".to_string(),
            revision: claimed.revision,
            started_at: Utc::now(),
        };
        registry
            .try_bind("objective-fence", binding.clone())
            .unwrap();
        registry.bind_activation("activation-old", binding.clone());
        let supervisor = Arc::new(ObjectiveSupervisor::new(
            Arc::clone(&store) as Arc<dyn ObjectiveStore>,
            Arc::clone(&store) as Arc<dyn EventStore>,
            Arc::new(InMemoryEventBus::new()),
            Arc::clone(&registry),
            Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>)),
            std::time::Duration::from_millis(150),
        ));
        let heartbeat = {
            let supervisor = Arc::clone(&supervisor);
            tokio::spawn(
                async move { supervisor.maintain_activation_lease("activation-old").await },
            )
        };

        let released = match store
            .finish_objective_evaluation(&claimed.id, "evaluation-old", 0, 0)
            .await
            .unwrap()
        {
            ObjectiveMutation::Updated(objective) => objective,
            mutation => panic!("unexpected finish: {mutation:?}"),
        };
        let replacement = store
            .claim_objective_evaluation(
                &released.id,
                released.revision,
                "evaluation-new",
                Utc::now() + Duration::seconds(1),
            )
            .await
            .unwrap();
        assert!(matches!(replacement, ObjectiveMutation::Updated(_)));

        let revoked = tokio::time::timeout(std::time::Duration::from_secs(1), heartbeat)
            .await
            .expect("stale heartbeat must stop")
            .unwrap()
            .unwrap();
        assert_eq!(revoked, binding);
        assert_eq!(
            registry.cancelled_activation("activation-old"),
            Some(binding)
        );
        assert!(!supervisor
            .activation_fence_is_current("activation-old")
            .await
            .unwrap());
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
