use crate::approval::{
    AiAutoReviewProvider, ApprovalDecision, ApprovalProvider, DenyAllApprovalProvider,
    EscalatingApprovalProvider, HumanApprovalHub, HumanApprovalProvider, PendingHumanApproval,
};
use crate::config::AppConfig;
use crate::context_tools::{ContextTxTool, RecallTool};
use crate::event::{Event, InMemoryEventBus, TYPE_USER_MESSAGE};
use crate::llm::{Client, ReasoningEffort};
use crate::memory::sqlite::SqliteStore;
use crate::memory::{
    AgentBootstrapRecord, AgentRecord, CognitiveContextRecord, DelegationRecord, DelegationStatus,
    EvaluationWorkItemRecord, EventStore, MessageClaim, NewAgent, NewCognitiveContext,
    NewDelegation, NewObjective, NewSession, ObjectiveMutation, ObjectiveRecord, ObjectiveStatus,
    ObjectiveStore, ObjectiveWaitCondition, QueryFilter, SessionRecord, SessionStore,
    SessionUpdate,
};
use crate::objective::{
    ObjectiveCreateTool, ObjectiveEvaluationRegistry, ObjectiveSupervisor, ObjectiveUpdateTool,
};
use crate::orchestrator::context::{ContextEngine, ContextView};
use crate::orchestrator::orchestrator::Orchestrator;
use crate::permission::{PermissionBroker, PermissionProfile, ReviewerKind, SandboxMode};
use crate::tool::{
    DelegateTool, EditFileTool, ExecuteCommandTool, KillTaskTool, ListFilesTool, ListSkillsTool,
    ListTasksTool, ReadFileTool, Registry, ScheduleTxTool, SearchTool, SendMessageTool,
    TaskStatusTool, ThreadScheduler, WaitTaskTool, WriteFileTool,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};

pub type RuntimeError = Box<dyn std::error::Error + Send + Sync>;

static RUNTIME_ID_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeIdentity {
    pub agent_id: String,
    pub context_id: String,
}

impl Default for RuntimeIdentity {
    fn default() -> Self {
        Self {
            agent_id: "default-agent".to_string(),
            context_id: "context-default".to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RuntimeToolPolicy {
    pub context_only: bool,
    pub coding_eval: bool,
}

impl RuntimeToolPolicy {
    pub fn from_environment() -> Self {
        Self {
            context_only: env_flag_enabled("MORPHZ_CONTEXT_EVAL_MODE"),
            coding_eval: env_flag_enabled("MORPHZ_CODING_EVAL_MODE"),
        }
    }
}

pub struct MorphzRuntimeBuilder {
    config: AppConfig,
    client: Arc<dyn Client>,
    database_path: Option<String>,
    identity: RuntimeIdentity,
    tool_policy: RuntimeToolPolicy,
    approval_provider: Option<Arc<dyn ApprovalProvider>>,
}

impl MorphzRuntimeBuilder {
    pub fn new(config: AppConfig, client: Arc<dyn Client>) -> Self {
        Self {
            database_path: None,
            identity: RuntimeIdentity::default(),
            tool_policy: RuntimeToolPolicy::from_environment(),
            approval_provider: None,
            config,
            client,
        }
    }

    pub fn database_path(mut self, path: impl Into<String>) -> Self {
        self.database_path = Some(path.into());
        self
    }

    pub fn identity(mut self, identity: RuntimeIdentity) -> Self {
        self.identity = identity;
        self
    }

    pub fn tool_policy(mut self, policy: RuntimeToolPolicy) -> Self {
        self.tool_policy = policy;
        self
    }

    pub fn approval_provider(mut self, provider: Arc<dyn ApprovalProvider>) -> Self {
        self.approval_provider = Some(provider);
        self
    }

    pub async fn build(self) -> Result<MorphzRuntime, RuntimeError> {
        let database_path = self
            .database_path
            .unwrap_or_else(|| self.config.server.database_path.clone());
        let mut permission_config = self.config.permissions.clone();
        if database_path != ":memory:" {
            let database_path = absolute_runtime_path(&database_path);
            for protected in [
                database_path.clone(),
                PathBuf::from(format!("{}-wal", database_path.to_string_lossy())),
                PathBuf::from(format!("{}-shm", database_path.to_string_lossy())),
            ] {
                let protected = protected.to_string_lossy().into_owned();
                if !permission_config.protected_paths.contains(&protected) {
                    permission_config.protected_paths.push(protected);
                }
            }
        }
        let bus = Arc::new(InMemoryEventBus::new());
        let store =
            Arc::new(SqliteStore::new_with_config(&database_path, &self.config.memory).await?);
        let context_engine = Arc::new(
            ContextEngine::new(
                Arc::clone(&store) as Arc<dyn EventStore>,
                self.config.orchestrator.clone(),
            )
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>)
            .with_objective_store(Arc::clone(&store) as Arc<dyn ObjectiveStore>),
        );
        let human_approval_hub = HumanApprovalHub::default();
        let permission_profile = Arc::new(PermissionProfile::from_config(&permission_config)?);
        if permission_profile.sandbox_mode == SandboxMode::DangerFullAccess {
            tracing::warn!("完全访问权限已启用：文件工具与 Shell 均不受工作区或操作系统沙箱限制");
        }
        let approval_provider = match self.approval_provider {
            Some(provider) => provider,
            None => {
                let human_review: Arc<dyn ApprovalProvider> = Arc::new(HumanApprovalProvider::new(
                    human_approval_hub.clone(),
                    Arc::clone(&bus),
                    Arc::clone(&store) as Arc<dyn EventStore>,
                ));
                match permission_profile.reviewer {
                    ReviewerKind::AutoReview => Arc::new(EscalatingApprovalProvider::new(
                        Arc::new(AiAutoReviewProvider::new(
                            Arc::clone(&self.client),
                            Arc::clone(&store) as Arc<dyn EventStore>,
                        )),
                        human_review,
                    )) as Arc<dyn ApprovalProvider>,
                    ReviewerKind::User => human_review,
                    ReviewerKind::Deny => Arc::new(DenyAllApprovalProvider::new(
                        "当前权限 Profile 禁止边界外能力申请",
                    )),
                }
            }
        };
        let permissions = Arc::new(PermissionBroker::new(permission_profile, approval_provider));
        let objective_lease_secs = self
            .config
            .orchestrator
            .model_attempt_timeout_secs
            .saturating_mul(4)
            .saturating_add(self.config.orchestrator.tool_timeout_secs.saturating_mul(4))
            .max(600);
        let objective_evaluations = Arc::new(ObjectiveEvaluationRegistry::default());
        let objective_supervisor = Arc::new(ObjectiveSupervisor::new(
            Arc::clone(&store) as Arc<dyn ObjectiveStore>,
            Arc::clone(&store) as Arc<dyn EventStore>,
            Arc::clone(&bus),
            Arc::clone(&objective_evaluations),
            std::time::Duration::from_secs(objective_lease_secs),
        ));
        let registry = Arc::new(Registry::new());
        let thread_scheduler = Arc::new(ThreadScheduler::new(
            Arc::clone(&bus),
            Arc::clone(&store) as Arc<dyn SessionStore>,
            Arc::clone(&store) as Arc<dyn EventStore>,
        ));
        register_default_tools(DefaultToolDependencies {
            registry: &registry,
            context_engine: &context_engine,
            objective_supervisor: &objective_supervisor,
            permissions: &permissions,
            bus: &bus,
            thread_scheduler: &thread_scheduler,
            config: &self.config,
            policy: self.tool_policy,
        });
        let runtime_client = Arc::clone(&self.client);
        let orchestrator = Arc::new(
            Orchestrator::new_with_context_engine_and_objectives_and_supervisor(
                Arc::clone(&bus),
                Arc::clone(&store) as Arc<dyn EventStore>,
                self.client,
                Arc::clone(&registry),
                self.config.orchestrator.clone(),
                Arc::clone(&context_engine),
                objective_evaluations,
                Some(Arc::clone(&objective_supervisor)),
            ),
        );
        Ok(MorphzRuntime {
            inner: Arc::new(RuntimeInner {
                config: self.config,
                identity: self.identity,
                database_path,
                client: runtime_client,
                bus,
                store,
                registry,
                orchestrator,
                objective_supervisor,
                thread_scheduler,
                human_approval_hub,
                started: AtomicBool::new(false),
                start_lock: tokio::sync::Mutex::new(()),
            }),
        })
    }
}

struct DefaultToolDependencies<'a> {
    registry: &'a Arc<Registry>,
    context_engine: &'a Arc<ContextEngine>,
    objective_supervisor: &'a Arc<ObjectiveSupervisor>,
    permissions: &'a Arc<PermissionBroker>,
    bus: &'a Arc<InMemoryEventBus>,
    thread_scheduler: &'a Arc<ThreadScheduler>,
    config: &'a AppConfig,
    policy: RuntimeToolPolicy,
}

fn register_default_tools(dependencies: DefaultToolDependencies<'_>) {
    let DefaultToolDependencies {
        registry,
        context_engine,
        objective_supervisor,
        permissions,
        bus,
        thread_scheduler,
        config,
        policy,
    } = dependencies;
    registry.register(Arc::new(ContextTxTool::new(Arc::clone(context_engine))));
    registry.register(Arc::new(ObjectiveCreateTool::new(
        Arc::clone(objective_supervisor),
        Arc::clone(context_engine),
    )));
    registry.register(Arc::new(ObjectiveUpdateTool::new(
        Arc::clone(objective_supervisor),
        Arc::clone(context_engine),
    )));
    registry.register(Arc::new(SendMessageTool::new(
        Arc::clone(bus),
        context_engine
            .session_store()
            .expect("Runtime ContextEngine 必须配置 SessionStore"),
    )));
    registry.register(Arc::new(ScheduleTxTool::new(
        Arc::clone(thread_scheduler),
        context_engine
            .session_store()
            .expect("Runtime ContextEngine 必须配置 SessionStore"),
    )));
    if policy.context_only {
        return;
    }
    registry.register(Arc::new(WriteFileTool::new_with_runtime(
        Arc::clone(permissions),
        Arc::clone(bus),
    )));
    registry.register(Arc::new(ReadFileTool::new_with_permissions(Arc::clone(
        permissions,
    ))));
    registry.register(Arc::new(EditFileTool::new_with_runtime(
        Arc::clone(permissions),
        Arc::clone(bus),
    )));
    registry.register(Arc::new(ListFilesTool::new_with_permissions(Arc::clone(
        permissions,
    ))));
    registry.register(Arc::new(SearchTool::new_with_permissions(Arc::clone(
        permissions,
    ))));
    registry.register(Arc::new(RecallTool::new(Arc::clone(context_engine))));
    registry.register(Arc::new(ExecuteCommandTool::new_with_permissions(
        Arc::clone(bus),
        Arc::new(config.background_task.clone()),
        Arc::clone(permissions),
        config.orchestrator.tool_timeout_secs,
    )));
    registry.register(Arc::new(ListTasksTool));
    registry.register(Arc::new(TaskStatusTool));
    registry.register(Arc::new(WaitTaskTool::new(
        Arc::clone(bus),
        config.background_task.timeout_notify_secs,
    )));
    registry.register(Arc::new(KillTaskTool));
    if !policy.coding_eval {
        registry.register(Arc::new(DelegateTool::new(Arc::clone(bus))));
        registry.register(Arc::new(ListSkillsTool));
    }
}

struct RuntimeInner {
    config: AppConfig,
    identity: RuntimeIdentity,
    database_path: String,
    client: Arc<dyn Client>,
    bus: Arc<InMemoryEventBus>,
    store: Arc<SqliteStore>,
    registry: Arc<Registry>,
    orchestrator: Arc<Orchestrator>,
    objective_supervisor: Arc<ObjectiveSupervisor>,
    thread_scheduler: Arc<ThreadScheduler>,
    human_approval_hub: HumanApprovalHub,
    started: AtomicBool,
    start_lock: tokio::sync::Mutex<()>,
}

#[derive(Clone)]
pub struct MorphzRuntime {
    inner: Arc<RuntimeInner>,
}

impl MorphzRuntime {
    pub fn builder(config: AppConfig, client: Arc<dyn Client>) -> MorphzRuntimeBuilder {
        MorphzRuntimeBuilder::new(config, client)
    }

    pub async fn start(&self) -> Result<(), RuntimeError> {
        let _guard = self.inner.start_lock.lock().await;
        if self.inner.started.load(Ordering::Acquire) {
            return Ok(());
        }
        if self
            .inner
            .store
            .get_agent(&self.inner.identity.agent_id)
            .await?
            .is_none()
        {
            self.inner
                .store
                .ensure_agent(NewAgent {
                    id: self.inner.identity.agent_id.clone(),
                    title: "默认 Agent".to_string(),
                    root_context_id: self.inner.identity.context_id.clone(),
                })
                .await?;
        }
        self.inner
            .store
            .ensure_context(NewCognitiveContext {
                id: self.inner.identity.context_id.clone(),
                agent_id: self.inner.identity.agent_id.clone(),
                title: "默认认知 Context".to_string(),
            })
            .await?;
        for session in self.inner.store.list_sessions(true).await? {
            self.inner
                .orchestrator
                .register_session_context(&session.id, &session.context_id);
        }
        Arc::clone(&self.inner.orchestrator).start().await?;
        Arc::clone(&self.inner.objective_supervisor).start().await?;
        self.inner.thread_scheduler.recover().await?;
        self.inner.started.store(true, Ordering::Release);
        Ok(())
    }

    pub fn config(&self) -> &AppConfig {
        &self.inner.config
    }

    pub fn identity(&self) -> &RuntimeIdentity {
        &self.inner.identity
    }

    pub fn database_path(&self) -> &str {
        &self.inner.database_path
    }

    /// Process-local model reasoning override used by subsequent evaluations.
    /// This is deliberately not persisted when changed through Dashboard.
    pub fn reasoning_effort(&self) -> Option<ReasoningEffort> {
        self.inner.client.reasoning_effort()
    }

    pub fn set_reasoning_effort(
        &self,
        effort: Option<ReasoningEffort>,
    ) -> Result<(), RuntimeError> {
        self.inner
            .client
            .set_reasoning_effort(effort)
            .map_err(Into::into)
    }

    pub fn tool_names(&self) -> Vec<String> {
        self.inner
            .registry
            .definitions()
            .iter()
            .map(|definition| definition.name.clone())
            .collect()
    }

    pub fn agent(&self, id: impl Into<String>) -> AgentHandle {
        AgentHandle {
            runtime: self.clone(),
            id: id.into(),
        }
    }

    pub fn context(&self, id: impl Into<String>) -> ContextHandle {
        ContextHandle {
            runtime: self.clone(),
            id: id.into(),
        }
    }

    pub fn session(&self, id: impl Into<String>) -> SessionHandle {
        SessionHandle {
            runtime: self.clone(),
            id: id.into(),
        }
    }

    pub async fn ensure_session(&self, session: NewSession) -> Result<SessionHandle, RuntimeError> {
        let id = session.id.clone();
        let session = self.inner.store.ensure_session(session).await?;
        self.inner
            .orchestrator
            .register_session_context(&session.id, &session.context_id);
        Ok(self.session(id))
    }

    pub async fn ensure_agent(&self, agent: NewAgent) -> Result<AgentRecord, RuntimeError> {
        self.inner.store.ensure_agent(agent).await
    }

    pub async fn ensure_context(
        &self,
        context: NewCognitiveContext,
    ) -> Result<CognitiveContextRecord, RuntimeError> {
        self.inner.store.ensure_context(context).await
    }

    pub async fn create_agent_bundle(
        &self,
        agent: NewAgent,
        context: NewCognitiveContext,
        session: NewSession,
    ) -> Result<AgentBootstrapRecord, RuntimeError> {
        let bundle = self
            .inner
            .store
            .create_agent_bundle(agent, context, session)
            .await?;
        self.inner.orchestrator.register_session_context(
            &bundle.initial_session.id,
            &bundle.initial_session.context_id,
        );
        Ok(bundle)
    }

    pub async fn list_agents(&self, archived: bool) -> Result<Vec<AgentRecord>, RuntimeError> {
        self.inner.store.list_agents(archived).await
    }

    pub async fn get_agent(&self, id: &str) -> Result<Option<AgentRecord>, RuntimeError> {
        self.inner.store.get_agent(id).await
    }

    pub async fn create_context(
        &self,
        context: NewCognitiveContext,
    ) -> Result<CognitiveContextRecord, RuntimeError> {
        self.inner.store.create_context(context).await
    }

    pub async fn get_context(
        &self,
        id: &str,
    ) -> Result<Option<CognitiveContextRecord>, RuntimeError> {
        self.inner.store.get_context(id).await
    }

    pub async fn list_contexts(
        &self,
        archived: bool,
    ) -> Result<Vec<CognitiveContextRecord>, RuntimeError> {
        self.inner.store.list_contexts(archived).await
    }

    pub async fn create_session(&self, session: NewSession) -> Result<SessionRecord, RuntimeError> {
        let session = self.inner.store.create_session(session).await?;
        self.inner
            .orchestrator
            .register_session_context(&session.id, &session.context_id);
        Ok(session)
    }

    pub async fn get_session(&self, id: &str) -> Result<Option<SessionRecord>, RuntimeError> {
        self.inner.store.get_session(id).await
    }

    pub async fn list_sessions(&self, archived: bool) -> Result<Vec<SessionRecord>, RuntimeError> {
        self.inner.store.list_sessions(archived).await
    }

    pub async fn list_context_sessions(
        &self,
        context_id: &str,
        archived: bool,
    ) -> Result<Vec<SessionRecord>, RuntimeError> {
        self.inner
            .store
            .list_context_sessions(context_id, archived)
            .await
    }

    pub async fn update_session(
        &self,
        id: &str,
        update: SessionUpdate,
    ) -> Result<Option<SessionRecord>, RuntimeError> {
        self.inner.store.update_session(id, update).await
    }

    pub async fn touch_session(
        &self,
        id: &str,
        timestamp: chrono::DateTime<chrono::Utc>,
    ) -> Result<(), RuntimeError> {
        self.inner.store.touch_session(id, timestamp).await
    }

    pub async fn create_delegation(
        &self,
        delegation: NewDelegation,
    ) -> Result<DelegationRecord, RuntimeError> {
        self.inner.store.create_delegation(delegation).await
    }

    pub async fn get_delegation(&self, id: &str) -> Result<Option<DelegationRecord>, RuntimeError> {
        self.inner.store.get_delegation(id).await
    }

    pub async fn list_delegations(&self) -> Result<Vec<DelegationRecord>, RuntimeError> {
        self.inner.store.list_delegations().await
    }

    pub async fn update_delegation_status(
        &self,
        id: &str,
        status: DelegationStatus,
        result_event_id: Option<&str>,
    ) -> Result<Option<DelegationRecord>, RuntimeError> {
        self.inner
            .store
            .update_delegation_status(id, status, result_event_id)
            .await
    }

    pub async fn create_objective(
        &self,
        objective: NewObjective,
    ) -> Result<ObjectiveRecord, RuntimeError> {
        self.inner.objective_supervisor.create(objective).await
    }

    pub async fn get_objective(&self, id: &str) -> Result<Option<ObjectiveRecord>, RuntimeError> {
        self.inner.objective_supervisor.get(id).await
    }

    pub async fn list_context_objectives(
        &self,
        context_id: &str,
        include_terminal: bool,
    ) -> Result<Vec<ObjectiveRecord>, RuntimeError> {
        self.inner
            .objective_supervisor
            .list(context_id, include_terminal)
            .await
    }

    pub async fn edit_objective(
        &self,
        id: &str,
        expected_revision: u64,
        stated_objective: &str,
    ) -> Result<ObjectiveMutation, RuntimeError> {
        self.inner
            .objective_supervisor
            .edit(id, expected_revision, stated_objective)
            .await
    }

    pub async fn update_objective_state(
        &self,
        id: &str,
        expected_revision: u64,
        status: ObjectiveStatus,
        wait_condition: Option<ObjectiveWaitCondition>,
        reason: Option<&str>,
    ) -> Result<ObjectiveMutation, RuntimeError> {
        self.inner
            .objective_supervisor
            .update_state(id, expected_revision, status, wait_condition, reason)
            .await
    }

    pub async fn pause_objective(
        &self,
        id: &str,
        expected_revision: u64,
        reason: &str,
    ) -> Result<ObjectiveMutation, RuntimeError> {
        let current = self
            .get_objective(id)
            .await?
            .ok_or_else(|| format!("Objective '{id}' 不存在"))?;
        let mutation = self
            .update_objective_state(
                id,
                expected_revision,
                ObjectiveStatus::Paused,
                None,
                Some(reason),
            )
            .await?;
        if matches!(&mutation, ObjectiveMutation::Updated(_)) {
            self.inner
                .orchestrator
                .cancel_session(&current.coordinator_session_id);
        }
        Ok(mutation)
    }

    pub async fn resume_objective(
        &self,
        id: &str,
        expected_revision: u64,
        reason: &str,
    ) -> Result<ObjectiveMutation, RuntimeError> {
        let current = self
            .get_objective(id)
            .await?
            .ok_or_else(|| format!("Objective '{id}' 不存在"))?;
        self.inner
            .orchestrator
            .resume_session(&current.coordinator_session_id);
        self.update_objective_state(
            id,
            expected_revision,
            ObjectiveStatus::Active,
            None,
            Some(reason),
        )
        .await
    }

    pub async fn cancel_objective(
        &self,
        id: &str,
        expected_revision: u64,
        reason: &str,
    ) -> Result<ObjectiveMutation, RuntimeError> {
        let current = self
            .get_objective(id)
            .await?
            .ok_or_else(|| format!("Objective '{id}' 不存在"))?;
        let mutation = self
            .update_objective_state(
                id,
                expected_revision,
                ObjectiveStatus::Cancelled,
                None,
                Some(reason),
            )
            .await?;
        if matches!(&mutation, ObjectiveMutation::Updated(_)) {
            self.inner
                .orchestrator
                .cancel_session(&current.coordinator_session_id);
        }
        Ok(mutation)
    }

    /// Cancel a Delegation and every active descendant it spawned. The requested root's parent
    /// is woken with a terminal delegate Observation so an attached evaluation cannot remain
    /// suspended forever.
    pub async fn cancel_delegation_tree(
        &self,
        id: &str,
    ) -> Result<Vec<DelegationRecord>, RuntimeError> {
        let delegations = self.inner.store.list_delegations().await?;
        let root = delegations
            .iter()
            .find(|delegation| delegation.id == id)
            .cloned()
            .ok_or_else(|| format!("Delegation '{}' 不存在", id))?;
        let mut pending_sessions = vec![root.child_session_id.clone()];
        let mut selected = Vec::new();
        let mut visited = std::collections::HashSet::new();
        while let Some(parent_session_id) = pending_sessions.pop() {
            for delegation in delegations.iter().filter(|delegation| {
                delegation.child_session_id == parent_session_id
                    || delegation.parent_session_id == parent_session_id
            }) {
                if !visited.insert(delegation.id.clone()) {
                    continue;
                }
                pending_sessions.push(delegation.child_session_id.clone());
                selected.push(delegation.clone());
            }
        }

        // Stop leaves before ancestors so a descendant cannot enqueue more work while its parent
        // is being cancelled.
        let mut cancelled = Vec::new();
        for delegation in selected.into_iter().rev() {
            if matches!(
                delegation.status,
                DelegationStatus::Completed
                    | DelegationStatus::Failed
                    | DelegationStatus::Cancelled
            ) {
                continue;
            }
            self.cancel_session(&delegation.child_session_id);
            if let Some(updated) = self
                .inner
                .store
                .update_delegation_status(&delegation.id, DelegationStatus::Cancelled, None)
                .await?
            {
                cancelled.push(updated);
            }
        }

        if cancelled.iter().any(|delegation| delegation.id == root.id) {
            self.inner
                .bus
                .publish(Event::new(
                    format!(
                        "delegation_cancelled_{}_{}",
                        root.id,
                        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
                    ),
                    "System-Delegation".to_string(),
                    crate::event::TYPE_TOOL_OUTPUT.to_string(),
                    "chat/tool_output".to_string(),
                    vec![
                        ("context_id".to_string(), json!(root.parent_context_id)),
                        ("session_id".to_string(), json!(root.parent_session_id)),
                        ("delegation_id".to_string(), json!(root.id)),
                        ("tool_name".to_string(), json!("delegate")),
                        ("tool_status".to_string(), json!("cancelled")),
                        (
                            "text".to_string(),
                            json!(json!({
                                "delegation_id": id,
                                "status": "cancelled",
                                "cancelled_descendants": cancelled.len().saturating_sub(1),
                                "guidance": "Delegation 已取消；请根据当前证据继续或向用户说明。"
                            })
                            .to_string()),
                        ),
                    ]
                    .into_iter()
                    .collect(),
                ))
                .await?;
        }
        Ok(cancelled)
    }

    pub async fn query_events(&self, filter: QueryFilter) -> Result<Vec<Event>, RuntimeError> {
        self.inner.store.query(filter).await
    }

    pub async fn publish(&self, event: Event) -> Result<(), RuntimeError> {
        self.inner.bus.publish(event).await
    }

    pub fn subscribe(&self, topic: impl Into<String>, capacity: usize) -> RuntimeEventStream {
        let (sender, receiver) = tokio::sync::mpsc::channel(capacity.max(1));
        let subscription_id = self.inner.bus.subscribe(
            topic.into(),
            Arc::new(move |event| {
                let sender = sender.clone();
                Box::pin(async move {
                    let _ = sender.send(event).await;
                    Ok(())
                })
            }),
        );
        RuntimeEventStream {
            receiver,
            bus: Arc::downgrade(&self.inner.bus),
            subscription_id,
        }
    }

    pub fn pending_approvals(&self) -> Vec<PendingHumanApproval> {
        self.inner.human_approval_hub.pending()
    }

    pub fn decide_approval(
        &self,
        approval_id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), String> {
        self.inner.human_approval_hub.decide(approval_id, decision)
    }

    pub fn cancel_session(&self, session_id: &str) -> bool {
        self.inner.orchestrator.cancel_session(session_id)
    }

    pub async fn inspect_session_context(
        &self,
        session_id: &str,
    ) -> Result<crate::sexpr::SExpr, RuntimeError> {
        let view = self.inspect_session_context_view(session_id).await?;
        Ok(crate::sexpr::parse(&view.sexpr)?)
    }

    pub async fn inspect_session_context_view(
        &self,
        session_id: &str,
    ) -> Result<ContextView, RuntimeError> {
        let session = self
            .inner
            .store
            .get_session(session_id)
            .await?
            .ok_or_else(|| format!("Session '{}' 不存在", session_id))?;
        self.inner
            .orchestrator
            .get_context_encoding(&session.context_id, session_id)
            .await
    }

    pub async fn session_attention_state(
        &self,
        session_id: &str,
    ) -> Result<SessionRecord, RuntimeError> {
        self.inner
            .store
            .get_session(session_id)
            .await?
            .ok_or_else(|| format!("Session '{}' 不存在", session_id).into())
    }

    pub async fn active_evaluation_work_items(
        &self,
        context_id: &str,
    ) -> Result<Vec<EvaluationWorkItemRecord>, RuntimeError> {
        self.inner
            .store
            .list_context_evaluation_work_items(context_id, false)
            .await
    }

    pub async fn mind_version(&self, context_id: &str) -> Result<u64, RuntimeError> {
        self.inner.orchestrator.mind_version(context_id).await
    }

    pub async fn seed_context_from_mind(
        &self,
        source_context_id: &str,
        source_version: Option<u64>,
        target_context_id: &str,
    ) -> Result<crate::orchestrator::context::MindSeedReceipt, RuntimeError> {
        self.inner
            .orchestrator
            .seed_context_from_mind(source_context_id, source_version, target_context_id)
            .await
    }

    pub async fn context_encoding(
        &self,
        context_id: &str,
        session_id: &str,
    ) -> Result<ContextView, RuntimeError> {
        self.inner
            .orchestrator
            .get_context_encoding(context_id, session_id)
            .await
    }
}

pub struct RuntimeEventStream {
    receiver: tokio::sync::mpsc::Receiver<Event>,
    bus: Weak<InMemoryEventBus>,
    subscription_id: String,
}

impl RuntimeEventStream {
    pub async fn recv(&mut self) -> Option<Event> {
        self.receiver.recv().await
    }

    pub fn try_recv(&mut self) -> Result<Event, tokio::sync::mpsc::error::TryRecvError> {
        self.receiver.try_recv()
    }
}

impl Drop for RuntimeEventStream {
    fn drop(&mut self) {
        if let Some(bus) = self.bus.upgrade() {
            bus.unsubscribe(&self.subscription_id);
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MessageReceipt {
    pub event_id: String,
    pub client_message_id: String,
    pub duplicate: bool,
}

#[derive(Clone)]
pub struct SessionHandle {
    runtime: MorphzRuntime,
    id: String,
}

impl SessionHandle {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub async fn record(&self) -> Result<Option<SessionRecord>, RuntimeError> {
        self.runtime.get_session(&self.id).await
    }

    pub async fn send(
        &self,
        text: impl Into<String>,
        actor: impl Into<String>,
        client_message_id: Option<String>,
    ) -> Result<MessageReceipt, RuntimeError> {
        let session = self
            .runtime
            .get_session(&self.id)
            .await?
            .ok_or_else(|| format!("Session '{}' 不存在", self.id))?;
        if session.status == crate::memory::SessionStatus::Archived {
            return Err("归档 Session 不能接收新消息".into());
        }
        let text = text.into().trim().to_string();
        if text.is_empty() {
            return Err("消息正文不能为空".into());
        }
        if text.chars().count() > 1_000_000 {
            return Err("消息正文超过 1,000,000 字符".into());
        }
        let client_message_id = client_message_id.unwrap_or_else(|| runtime_id("client"));
        let event_id = runtime_id("msg");
        let event = Event::new(
            event_id.clone(),
            actor.into(),
            TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            [
                ("context_id".to_string(), json!(session.context_id)),
                ("session_id".to_string(), json!(self.id)),
                ("client_message_id".to_string(), json!(client_message_id)),
                ("text".to_string(), json!(text)),
            ]
            .into_iter()
            .collect(),
        );
        match self
            .runtime
            .inner
            .store
            .claim_message(&self.id, &client_message_id, &event)
            .await?
        {
            MessageClaim::Existing { event_id } => Ok(MessageReceipt {
                event_id,
                client_message_id,
                duplicate: true,
            }),
            MessageClaim::Accepted => {
                self.runtime.publish(event).await?;
                Ok(MessageReceipt {
                    event_id,
                    client_message_id,
                    duplicate: false,
                })
            }
        }
    }

    pub fn cancel(&self) -> bool {
        self.runtime.cancel_session(&self.id)
    }

    pub async fn inspect_context(&self) -> Result<crate::sexpr::SExpr, RuntimeError> {
        self.runtime.inspect_session_context(&self.id).await
    }

    pub async fn inspect_context_view(&self) -> Result<ContextView, RuntimeError> {
        self.runtime.inspect_session_context_view(&self.id).await
    }

    pub async fn events(&self, after_sequence: Option<u64>) -> Result<Vec<Event>, RuntimeError> {
        self.runtime
            .query_events(QueryFilter {
                session_id: Some(self.id.clone()),
                top_k: Some(1_000),
                ..Default::default()
            })
            .await
            .map(|events| {
                events
                    .into_iter()
                    .filter(|event| {
                        after_sequence
                            .is_none_or(|after| event.sequence.is_some_and(|seq| seq > after))
                    })
                    .collect()
            })
    }
}

#[derive(Clone)]
pub struct AgentHandle {
    runtime: MorphzRuntime,
    id: String,
}

impl AgentHandle {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub async fn record(&self) -> Result<Option<AgentRecord>, RuntimeError> {
        self.runtime.get_agent(&self.id).await
    }
}

#[derive(Clone)]
pub struct ContextHandle {
    runtime: MorphzRuntime,
    id: String,
}

impl ContextHandle {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub async fn record(&self) -> Result<Option<CognitiveContextRecord>, RuntimeError> {
        self.runtime.get_context(&self.id).await
    }

    pub async fn sessions(&self, archived: bool) -> Result<Vec<SessionRecord>, RuntimeError> {
        self.runtime.list_context_sessions(&self.id, archived).await
    }
}

fn runtime_id(prefix: &str) -> String {
    let sequence = RUNTIME_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!(
        "{}_{}_{}_{}",
        prefix,
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        std::process::id(),
        sequence
    )
}

fn absolute_runtime_path(path: impl AsRef<std::path::Path>) -> PathBuf {
    let path = path.as_ref();
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn env_flag_enabled(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::{Message, Response, ToolCallRepr, ToolDefinition};
    use crate::permission::PermissionMode;
    use tempfile::NamedTempFile;

    struct ReplyClient;

    fn text_response(content: impl Into<String>) -> Response {
        Response {
            content: content.into(),
            tool_calls: Vec::new(),
        }
    }

    fn no_reply_response(id: impl Into<String>) -> Response {
        Response {
            content: String::new(),
            tool_calls: vec![ToolCallRepr {
                id: id.into(),
                r#type: "function".to_string(),
                func_name: "no_reply".to_string(),
                arguments: json!({}).to_string(),
            }],
        }
    }

    #[async_trait::async_trait]
    impl Client for ReplyClient {
        async fn create_completion(
            &self,
            _messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            Ok(text_response("runtime-ok"))
        }
    }

    struct ObjectiveCompletingClient {
        calls: AtomicU64,
    }

    struct ObjectiveBlockedClient {
        calls: AtomicU64,
    }

    struct ObjectiveLongRunClient {
        calls: AtomicU64,
    }

    struct ObjectiveAutonomousCreateClient {
        calls: AtomicU64,
    }

    struct ObjectiveWaitingClient {
        calls: AtomicU64,
    }

    struct ObjectiveRecoveryClient {
        calls: AtomicU64,
    }

    struct SharedContextObjectiveClient {
        calls: AtomicU64,
    }

    struct ConcurrentObjectiveRouteClient {
        objective_started: tokio::sync::Notify,
        release_objective: tokio::sync::Notify,
    }

    #[async_trait::async_trait]
    impl Client for ConcurrentObjectiveRouteClient {
        async fn create_completion(
            &self,
            messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            let context = messages
                .iter()
                .map(|message| message.content.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            if context.contains("unrelated concurrent message") {
                return Ok(text_response("unrelated-user-reply"));
            }
            if context.contains("objective-continuation") {
                self.objective_started.notify_one();
                self.release_objective.notified().await;
                return Ok(no_reply_response("objective-concurrent-no-reply"));
            }
            Err("concurrent Objective route test received an unknown Evaluation".into())
        }
    }

    #[async_trait::async_trait]
    impl Client for ObjectiveBlockedClient {
        async fn create_completion(
            &self,
            _messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call > 0 {
                return Ok(text_response("objective-needs-user-decision"));
            }
            let arguments = json!({
                "objective_id": "objective-blocked",
                "base_revision": 2,
                "status": "blocked",
                "reason": "缺少只能由使用者提供的必要决策",
                "evidence_refs": []
            });
            Ok(Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: format!("objective-blocked-call-{call}"),
                    r#type: "function".to_string(),
                    func_name: "objective_update".to_string(),
                    arguments: arguments.to_string(),
                }],
            })
        }
    }

    #[async_trait::async_trait]
    impl Client for ObjectiveLongRunClient {
        async fn create_completion(
            &self,
            messages: Vec<Message>,
            tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call < 100 {
                return Ok(no_reply_response(format!("objective-long-run-call-{call}")));
            }
            if !tools.iter().any(|tool| tool.name == "objective_update") {
                return Ok(text_response("long-objective-complete"));
            }
            let arguments = json!({
                "objective_id": "objective-long-run",
                "base_revision": objective_revision_from_messages(
                    &messages,
                    "objective-long-run"
                ),
                "status": "completed",
                "reason": "已跨越一百次持续求值并完成确定性验收",
                "evidence_refs": []
            });
            Ok(Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: format!("objective-long-run-call-{call}"),
                    r#type: "function".to_string(),
                    func_name: "objective_update".to_string(),
                    arguments: arguments.to_string(),
                }],
            })
        }
    }

    #[async_trait::async_trait]
    impl Client for ObjectiveAutonomousCreateClient {
        async fn create_completion(
            &self,
            messages: Vec<Message>,
            tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call == 2 {
                return Ok(no_reply_response("objective-autonomous-call-2"));
            }
            if call > 3 {
                return Ok(text_response("autonomous-objective-complete"));
            }
            let (name, arguments) = match call {
                0 | 1 => {
                    let create = tools
                        .iter()
                        .find(|tool| tool.name == "objective_create")
                        .expect("普通 Evaluation 应提供 objective_create");
                    let properties = create.parameters["properties"]
                        .as_object()
                        .expect("objective_create properties");
                    assert!(!properties.contains_key("objective_id"));
                    assert!(!properties.contains_key("context_id"));
                    assert!(!properties.contains_key("session_id"));
                    (
                        "objective_create",
                        json!({
                            "stated_objective": "自主创建并完成一个跨 Evaluation 的持久目标",
                            "reason": "该验收明确要求跨 Evaluation 自动续跑并验证重启级控制对象",
                            "source_refs": []
                        }),
                    )
                }
                3 => {
                    let objective_id = autonomous_objective_id_from_messages(&messages);
                    (
                        "objective_update",
                        json!({
                            "objective_id": objective_id,
                            "base_revision": objective_revision_from_messages(
                                &messages,
                                &objective_id
                            ),
                            "status": "completed",
                            "reason": "已验证自主创建、幂等与 Supervisor 续跑",
                            "evidence_refs": []
                        }),
                    )
                }
                _ => unreachable!("handled terminal response above"),
            };
            Ok(Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: format!("objective-autonomous-call-{call}"),
                    r#type: "function".to_string(),
                    func_name: name.to_string(),
                    arguments: arguments.to_string(),
                }],
            })
        }
    }

    #[async_trait::async_trait]
    impl Client for SharedContextObjectiveClient {
        async fn create_completion(
            &self,
            messages: Vec<Message>,
            tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let context = messages
                .iter()
                .map(|message| message.content.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            let (session_id, objective_id) = if context.contains("(active-session session-a)") {
                ("session-a", "objective-a")
            } else if context.contains("(active-session session-b)") {
                ("session-b", "objective-b")
            } else {
                return Err("shared Context Objective test cannot identify active Session".into());
            };
            if !tools.iter().any(|tool| tool.name == "objective_update") {
                return Ok(text_response(format!("{session_id}-complete")));
            }
            let arguments = json!({
                "objective_id": objective_id,
                "base_revision": objective_revision_from_messages(&messages, objective_id),
                "status": "completed",
                "reason": format!("{session_id} 已完成自己的 Objective"),
                "evidence_refs": []
            });
            Ok(Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: format!(
                        "shared-objective-{}-{}",
                        session_id,
                        self.calls.load(Ordering::SeqCst)
                    ),
                    r#type: "function".to_string(),
                    func_name: "objective_update".to_string(),
                    arguments: arguments.to_string(),
                }],
            })
        }
    }

    fn objective_revision_from_messages(messages: &[Message], objective_id: &str) -> u64 {
        let marker = format!("(id {objective_id})");
        messages
            .iter()
            .find_map(|message| {
                let objective_at = message.content.find(&marker)?;
                let suffix = &message.content[objective_at..];
                let revision_at = suffix.find("(revision ")? + "(revision ".len();
                let digits = suffix[revision_at..]
                    .chars()
                    .take_while(char::is_ascii_digit)
                    .collect::<String>();
                digits.parse().ok()
            })
            .expect("Objective revision should be visible in Context Encoding")
    }

    fn autonomous_objective_id_from_messages(messages: &[Message]) -> String {
        const MARKER: &str = "(objective (id ";
        messages
            .iter()
            .find_map(|message| {
                let start = message.content.find(MARKER)? + MARKER.len();
                let suffix = &message.content[start..];
                let end = suffix.find(')')?;
                let id = &suffix[..end];
                id.starts_with("objective-auto-").then(|| id.to_string())
            })
            .expect("autonomous Objective should be visible in Context Encoding")
    }

    async fn objective_after_evaluation_release(
        runtime: &MorphzRuntime,
        objective_id: &str,
    ) -> ObjectiveRecord {
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                let objective = runtime
                    .get_objective(objective_id)
                    .await
                    .unwrap()
                    .expect("Objective should exist");
                if objective.active_evaluation_id.is_none() {
                    break objective;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("terminal reply should release its Objective Evaluation")
    }

    #[async_trait::async_trait]
    impl Client for ObjectiveRecoveryClient {
        async fn create_completion(
            &self,
            messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call > 0 {
                return Ok(text_response("recovered-objective-complete"));
            }
            let arguments = json!({
                "objective_id": "objective-recover",
                "base_revision": objective_revision_from_messages(&messages, "objective-recover"),
                "status": "completed",
                "reason": "重启后已恢复并完成",
                "evidence_refs": []
            });
            Ok(Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: format!("objective-recovery-call-{call}"),
                    r#type: "function".to_string(),
                    func_name: "objective_update".to_string(),
                    arguments: arguments.to_string(),
                }],
            })
        }
    }

    #[async_trait::async_trait]
    impl Client for ObjectiveWaitingClient {
        async fn create_completion(
            &self,
            _messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call == 1 {
                return Ok(no_reply_response("objective-wait-call-1"));
            }
            if call > 2 {
                return Ok(text_response("wait-objective-complete"));
            }
            let (name, arguments) = match call {
                0 => (
                    "objective_update",
                    json!({
                        "objective_id": "objective-wait",
                        "base_revision": 2,
                        "status": "active",
                        "reason": "必须等待已启动的后台任务产生物理终态",
                        "evidence_refs": [],
                        "wait_condition": {
                            "kind": "tool_task",
                            "task_id": "task-wait-42"
                        }
                    }),
                ),
                2 => (
                    "objective_update",
                    json!({
                        "objective_id": "objective-wait",
                        "base_revision": 6,
                        "status": "completed",
                        "reason": "后台任务已经成功结束",
                        "evidence_refs": []
                    }),
                ),
                _ => unreachable!("handled terminal response above"),
            };
            Ok(Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: format!("objective-wait-call-{call}"),
                    r#type: "function".to_string(),
                    func_name: name.to_string(),
                    arguments: arguments.to_string(),
                }],
            })
        }
    }

    #[async_trait::async_trait]
    impl Client for ObjectiveCompletingClient {
        async fn create_completion(
            &self,
            messages: Vec<Message>,
            tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call == 0 {
                assert!(tools.iter().any(|tool| tool.name == "objective_update"));
                assert!(messages
                    .iter()
                    .any(|message| message.content.contains("(objective-contract")));
                assert!(messages
                    .iter()
                    .any(|message| message.content.contains("objective-continuation")));
                return Ok(Response {
                    content: String::new(),
                    tool_calls: vec![ToolCallRepr {
                        id: "complete-objective".to_string(),
                        r#type: "function".to_string(),
                        func_name: "objective_update".to_string(),
                        arguments: json!({
                            "objective_id": "objective-runtime",
                            "base_revision": 2,
                            "status": "completed",
                            "reason": "测试目标已由确定性夹具完成",
                            "evidence_refs": []
                        })
                        .to_string(),
                    }],
                });
            }
            assert!(!tools.iter().any(|tool| tool.name == "objective_update"));
            Ok(text_response("objective-complete"))
        }
    }

    #[tokio::test]
    async fn runtime_builder_handles_message_event_and_context_through_one_api() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let runtime = MorphzRuntime::builder(config, Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        runtime.start().await.unwrap();
        let session = runtime
            .ensure_session(NewSession {
                id: "session-runtime".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Runtime test".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 8);
        let receipt = session
            .send("hello", "User-Test", Some("client-runtime".to_string()))
            .await
            .unwrap();
        assert!(!receipt.duplicate);
        let reply = tokio::time::timeout(std::time::Duration::from_secs(2), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            reply.payload.get("text").and_then(|value| value.as_str()),
            Some("runtime-ok")
        );
        assert_eq!(
            session.record().await.unwrap().unwrap().id,
            "session-runtime"
        );
        assert!(session.inspect_context().await.is_ok());
    }

    #[tokio::test]
    async fn objective_supervisor_continues_without_fake_user_message_and_stops_after_commit() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let client = Arc::new(ObjectiveCompletingClient {
            calls: AtomicU64::new(0),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        runtime
            .ensure_session(NewSession {
                id: "session-objective-runtime".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Objective runtime test".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 8);
        runtime
            .create_objective(NewObjective {
                id: "objective-runtime".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                coordinator_session_id: "session-objective-runtime".to_string(),
                delivery_session_id: "session-objective-runtime".to_string(),
                parent_objective_id: None,
                source_event_id: "runtime-test-source".to_string(),
                stated_objective: "完成 Supervisor 确定性回归测试".to_string(),
                token_budget: None,
            })
            .await
            .unwrap();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(3), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            reply.payload.get("text").and_then(|value| value.as_str()),
            Some("objective-complete")
        );
        assert_eq!(
            reply
                .payload
                .get("objective_id")
                .and_then(|value| value.as_str()),
            Some("objective-runtime")
        );
        let objective = objective_after_evaluation_release(&runtime, "objective-runtime").await;
        assert_eq!(objective.status, ObjectiveStatus::Completed);
        assert!(objective.active_evaluation_id.is_none());
        assert!(
            objective.tokens_used > 0,
            "Objective 应累计每次 Evaluation 的完整 Prompt 本地计量"
        );
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(client.calls.load(Ordering::SeqCst), 2);

        let events = runtime
            .query_events(QueryFilter {
                session_id: Some("session-objective-runtime".to_string()),
                top_k: Some(100),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(events
            .iter()
            .any(|event| event.topic == "objective/evaluation_started"));
        let continuation = events
            .iter()
            .find(|event| {
                event.topic == "chat/tool_output"
                    && event
                        .payload
                        .get("tool_name")
                        .and_then(|value| value.as_str())
                        == Some("objective_supervisor")
            })
            .expect("Supervisor should persist an internal continuation event");
        assert_ne!(continuation.event_type, TYPE_USER_MESSAGE);
    }

    #[tokio::test]
    async fn concurrent_user_reply_cannot_steal_an_active_objective_evaluation() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let client = Arc::new(ConcurrentObjectiveRouteClient {
            objective_started: tokio::sync::Notify::new(),
            release_objective: tokio::sync::Notify::new(),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        let session = runtime
            .ensure_session(NewSession {
                id: "session-objective-concurrent".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Concurrent Objective route test".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 8);
        runtime
            .create_objective(NewObjective {
                id: "objective-concurrent-route".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                coordinator_session_id: session.id().to_string(),
                delivery_session_id: session.id().to_string(),
                parent_objective_id: None,
                source_event_id: "objective-concurrent-source".to_string(),
                stated_objective: "保持一个尚未结束的 Objective Evaluation".to_string(),
                token_budget: None,
            })
            .await
            .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            client.objective_started.notified(),
        )
        .await
        .expect("Objective Evaluation should enter the model before the user message");

        session
            .send(
                "unrelated concurrent message",
                "User-Test",
                Some("objective-concurrent-user-message".to_string()),
            )
            .await
            .unwrap();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(2), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            reply.payload.get("text"),
            Some(&json!("unrelated-user-reply"))
        );
        assert!(reply.payload.get("objective_id").is_none());
        assert!(reply.payload.get("objective_evaluation_id").is_none());

        let active = runtime
            .get_objective("objective-concurrent-route")
            .await
            .unwrap()
            .unwrap();
        assert!(active.active_evaluation_id.is_some());
        runtime
            .cancel_objective(&active.id, active.revision, "结束并发路由确定性测试")
            .await
            .unwrap();
        client.release_objective.notify_one();
    }

    #[tokio::test]
    async fn blocked_objective_keeps_final_reply_routing_then_releases_its_evaluation() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let client = Arc::new(ObjectiveBlockedClient {
            calls: AtomicU64::new(0),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        runtime
            .ensure_session(NewSession {
                id: "session-objective-blocked".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Objective blocked test".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 8);
        runtime
            .create_objective(NewObjective {
                id: "objective-blocked".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                coordinator_session_id: "session-objective-blocked".to_string(),
                delivery_session_id: "session-objective-blocked".to_string(),
                parent_objective_id: None,
                source_event_id: "runtime-test-blocked-source".to_string(),
                stated_objective: "验证真实阻塞会交付说明并停止自动续跑".to_string(),
                token_budget: None,
            })
            .await
            .unwrap();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(3), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            reply.payload.get("text").and_then(|value| value.as_str()),
            Some("objective-needs-user-decision")
        );
        assert_eq!(
            reply
                .payload
                .get("objective_id")
                .and_then(|value| value.as_str()),
            Some("objective-blocked")
        );
        let objective = objective_after_evaluation_release(&runtime, "objective-blocked").await;
        assert_eq!(objective.status, ObjectiveStatus::Blocked);
        assert!(objective.active_evaluation_id.is_none());
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(client.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn active_objective_survives_more_than_one_hundred_model_evaluations() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let client = Arc::new(ObjectiveLongRunClient {
            calls: AtomicU64::new(0),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        runtime
            .ensure_session(NewSession {
                id: "session-objective-long-run".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Objective long-run test".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 8);
        runtime
            .create_objective(NewObjective {
                id: "objective-long-run".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                coordinator_session_id: "session-objective-long-run".to_string(),
                delivery_session_id: "session-objective-long-run".to_string(),
                parent_objective_id: None,
                source_event_id: "runtime-test-long-run-source".to_string(),
                stated_objective: "持续求值超过一百次后再显式完成".to_string(),
                token_budget: None,
            })
            .await
            .unwrap();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(10), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            reply.payload.get("text").and_then(|value| value.as_str()),
            Some("long-objective-complete")
        );
        let objective = objective_after_evaluation_release(&runtime, "objective-long-run").await;
        assert_eq!(objective.status, ObjectiveStatus::Completed);
        assert_eq!(objective.continuation_sequence, 101);
        assert_eq!(client.calls.load(Ordering::SeqCst), 102);
    }

    #[tokio::test]
    async fn llm_can_create_one_idempotent_objective_and_current_evaluation_is_adopted() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let client = Arc::new(ObjectiveAutonomousCreateClient {
            calls: AtomicU64::new(0),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        let session = runtime
            .ensure_session(NewSession {
                id: "session-objective-autonomous".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Autonomous Objective test".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 8);
        session
            .send(
                "请自主建立一个需要跨 Evaluation 完成的持久目标并完成它",
                "User-Test",
                Some("autonomous-objective-message".to_string()),
            )
            .await
            .unwrap();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(5), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            reply.payload.get("text").and_then(|value| value.as_str()),
            Some("autonomous-objective-complete")
        );
        let objective_id = reply
            .payload
            .get("objective_id")
            .and_then(|value| value.as_str())
            .expect("final reply should retain autonomous Objective routing")
            .to_string();
        assert!(objective_id.starts_with("objective-auto-"));
        let objective = objective_after_evaluation_release(&runtime, &objective_id).await;
        assert_eq!(objective.status, ObjectiveStatus::Completed);
        assert_eq!(objective.continuation_sequence, 2);
        assert_eq!(client.calls.load(Ordering::SeqCst), 5);

        let matching = runtime
            .list_context_objectives(&runtime.identity().context_id, true)
            .await
            .unwrap()
            .into_iter()
            .filter(|objective| {
                objective.stated_objective == "自主创建并完成一个跨 Evaluation 的持久目标"
            })
            .collect::<Vec<_>>();
        assert_eq!(matching.len(), 1, "重复 objective_create 必须幂等");

        let autonomous_requests = runtime
            .query_events(QueryFilter {
                topic: Some("objective/autonomous_requested".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(autonomous_requests.len(), 1);
        assert_eq!(
            autonomous_requests[0]
                .payload
                .get("requested_objective_id")
                .and_then(|value| value.as_str()),
            Some(objective_id.as_str())
        );

        let continuations = runtime
            .query_events(QueryFilter {
                session_id: Some("session-objective-autonomous".to_string()),
                topic: Some("chat/tool_output".to_string()),
                top_k: Some(100),
                ..Default::default()
            })
            .await
            .unwrap()
            .into_iter()
            .filter(|event| {
                event
                    .payload
                    .get("tool_name")
                    .and_then(|value| value.as_str())
                    == Some("objective_supervisor")
            })
            .count();
        assert_eq!(
            continuations, 1,
            "创建时应收编当前 Evaluation，只在第一次 reply 后续跑一次"
        );
    }

    #[tokio::test]
    async fn objective_wait_is_event_driven_and_the_matching_task_event_resumes_it_once() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let client = Arc::new(ObjectiveWaitingClient {
            calls: AtomicU64::new(0),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        runtime
            .ensure_session(NewSession {
                id: "session-objective-wait".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Objective wait test".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let mut no_reply = runtime.subscribe("chat/no_reply", 8);
        let mut replies = runtime.subscribe("chat/reply", 8);
        runtime
            .create_objective(NewObjective {
                id: "objective-wait".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                coordinator_session_id: "session-objective-wait".to_string(),
                delivery_session_id: "session-objective-wait".to_string(),
                parent_objective_id: None,
                source_event_id: "runtime-wait-source".to_string(),
                stated_objective: "等待后台任务后完成".to_string(),
                token_budget: None,
            })
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(3), no_reply.recv())
            .await
            .unwrap()
            .unwrap();
        let mut waiting = runtime
            .get_objective("objective-wait")
            .await
            .unwrap()
            .unwrap();
        for _ in 0..50 {
            if waiting.active_evaluation_id.is_none() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            waiting = runtime
                .get_objective("objective-wait")
                .await
                .unwrap()
                .unwrap();
        }
        assert_eq!(
            waiting.wait_condition,
            Some(ObjectiveWaitCondition::ToolTask {
                task_id: "task-wait-42".to_string()
            })
        );
        assert!(waiting.active_evaluation_id.is_none());
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(client.calls.load(Ordering::SeqCst), 2);

        runtime
            .publish(Event::new(
                "task-wait-42-completed".to_string(),
                "System-TaskMonitor".to_string(),
                crate::event::TYPE_TOOL_OUTPUT.to_string(),
                "chat/tool_output".to_string(),
                vec![
                    (
                        "context_id".to_string(),
                        json!(runtime.identity().context_id),
                    ),
                    ("session_id".to_string(), json!("session-objective-wait")),
                    ("task_id".to_string(), json!("task-wait-42")),
                    ("task_status".to_string(), json!("succeeded")),
                    ("tool_name".to_string(), json!("exec")),
                    ("text".to_string(), json!("background task succeeded")),
                ]
                .into_iter()
                .collect(),
            ))
            .await
            .unwrap();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(3), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            reply.payload.get("text").and_then(|value| value.as_str()),
            Some("wait-objective-complete")
        );
        assert_eq!(
            runtime
                .get_objective("objective-wait")
                .await
                .unwrap()
                .unwrap()
                .status,
            ObjectiveStatus::Completed
        );
        assert_eq!(client.calls.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn runtime_restart_recovers_an_expired_objective_evaluation_lease_once() {
        let database = NamedTempFile::new().unwrap();
        let database_path = database.path().to_string_lossy().into_owned();
        let store = SqliteStore::new(&database_path).await.unwrap();
        store
            .create_agent_bundle(
                NewAgent {
                    id: "default-agent".to_string(),
                    title: "Recovery Agent".to_string(),
                    root_context_id: "context-default".to_string(),
                },
                NewCognitiveContext {
                    id: "context-default".to_string(),
                    agent_id: "default-agent".to_string(),
                    title: "Recovery Context".to_string(),
                },
                NewSession {
                    id: "session-objective-recover".to_string(),
                    agent_id: "default-agent".to_string(),
                    context_id: "context-default".to_string(),
                    parent_session_id: None,
                    title: "Recovery Session".to_string(),
                    mount_kind: crate::memory::SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        store
            .create_objective(NewObjective {
                id: "objective-recover".to_string(),
                agent_id: "default-agent".to_string(),
                context_id: "context-default".to_string(),
                coordinator_session_id: "session-objective-recover".to_string(),
                delivery_session_id: "session-objective-recover".to_string(),
                parent_objective_id: None,
                source_event_id: "recovery-source".to_string(),
                stated_objective: "验证 Runtime 重启恢复".to_string(),
                token_budget: None,
            })
            .await
            .unwrap();
        let stale = store
            .claim_objective_evaluation(
                "objective-recover",
                1,
                "evaluation-from-dead-process",
                chrono::Utc::now() - chrono::Duration::seconds(1),
            )
            .await
            .unwrap();
        assert!(matches!(stale, ObjectiveMutation::Updated(_)));
        drop(store);

        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let client = Arc::new(ObjectiveRecoveryClient {
            calls: AtomicU64::new(0),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(&database_path)
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 8);
        runtime.start().await.unwrap();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(3), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            reply.payload.get("text").and_then(|value| value.as_str()),
            Some("recovered-objective-complete")
        );
        let recovered = runtime
            .get_objective("objective-recover")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(recovered.status, ObjectiveStatus::Completed);
        assert_eq!(recovered.continuation_sequence, 2);
        assert_eq!(client.calls.load(Ordering::SeqCst), 2);
        assert!(runtime
            .query_events(QueryFilter {
                topic: Some("objective/recovered".to_string()),
                ..Default::default()
            })
            .await
            .unwrap()
            .iter()
            .any(|event| {
                event
                    .payload
                    .get("objective_id")
                    .and_then(|value| value.as_str())
                    == Some("objective-recover")
            }));
    }

    #[tokio::test]
    async fn shared_context_objectives_keep_two_session_evaluations_and_replies_isolated() {
        let database = NamedTempFile::new().unwrap();
        let database_path = database.path().to_string_lossy().into_owned();
        let store = SqliteStore::new(&database_path).await.unwrap();
        store
            .create_agent_bundle(
                NewAgent {
                    id: "default-agent".to_string(),
                    title: "Shared Objective Agent".to_string(),
                    root_context_id: "context-default".to_string(),
                },
                NewCognitiveContext {
                    id: "context-default".to_string(),
                    agent_id: "default-agent".to_string(),
                    title: "Shared Objective Context".to_string(),
                },
                NewSession {
                    id: "session-a".to_string(),
                    agent_id: "default-agent".to_string(),
                    context_id: "context-default".to_string(),
                    parent_session_id: None,
                    title: "Session A".to_string(),
                    mount_kind: crate::memory::SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        store
            .create_session(NewSession {
                id: "session-b".to_string(),
                agent_id: "default-agent".to_string(),
                context_id: "context-default".to_string(),
                parent_session_id: None,
                title: "Session B".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        for (objective_id, session_id) in
            [("objective-a", "session-a"), ("objective-b", "session-b")]
        {
            store
                .create_objective(NewObjective {
                    id: objective_id.to_string(),
                    agent_id: "default-agent".to_string(),
                    context_id: "context-default".to_string(),
                    coordinator_session_id: session_id.to_string(),
                    delivery_session_id: session_id.to_string(),
                    parent_objective_id: None,
                    source_event_id: format!("source-{objective_id}"),
                    stated_objective: format!("完成 {session_id} 的独立目标"),
                    token_budget: None,
                })
                .await
                .unwrap();
        }
        drop(store);

        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let client = Arc::new(SharedContextObjectiveClient {
            calls: AtomicU64::new(0),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(&database_path)
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 8);
        runtime.start().await.unwrap();
        let mut delivered = std::collections::HashMap::new();
        while delivered.len() < 2 {
            let reply = tokio::time::timeout(std::time::Duration::from_secs(3), replies.recv())
                .await
                .unwrap()
                .unwrap();
            delivered.insert(
                reply
                    .payload
                    .get("session_id")
                    .and_then(|value| value.as_str())
                    .unwrap()
                    .to_string(),
                (
                    reply
                        .payload
                        .get("objective_id")
                        .and_then(|value| value.as_str())
                        .unwrap()
                        .to_string(),
                    reply
                        .payload
                        .get("text")
                        .and_then(|value| value.as_str())
                        .unwrap()
                        .to_string(),
                ),
            );
        }
        assert_eq!(
            delivered.get("session-a"),
            Some(&("objective-a".to_string(), "session-a-complete".to_string()))
        );
        assert_eq!(
            delivered.get("session-b"),
            Some(&("objective-b".to_string(), "session-b-complete".to_string()))
        );
        for objective_id in ["objective-a", "objective-b"] {
            assert_eq!(
                runtime
                    .get_objective(objective_id)
                    .await
                    .unwrap()
                    .unwrap()
                    .status,
                ObjectiveStatus::Completed
            );
        }
        assert_eq!(client.calls.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn persisted_objective_timer_wakes_after_restart_without_polling() {
        let database = NamedTempFile::new().unwrap();
        let database_path = database.path().to_string_lossy().into_owned();
        let store = SqliteStore::new(&database_path).await.unwrap();
        store
            .create_agent_bundle(
                NewAgent {
                    id: "default-agent".to_string(),
                    title: "Timer Agent".to_string(),
                    root_context_id: "context-default".to_string(),
                },
                NewCognitiveContext {
                    id: "context-default".to_string(),
                    agent_id: "default-agent".to_string(),
                    title: "Timer Context".to_string(),
                },
                NewSession {
                    id: "session-objective-recover".to_string(),
                    agent_id: "default-agent".to_string(),
                    context_id: "context-default".to_string(),
                    parent_session_id: None,
                    title: "Timer Session".to_string(),
                    mount_kind: crate::memory::SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        store
            .create_objective(NewObjective {
                id: "objective-recover".to_string(),
                agent_id: "default-agent".to_string(),
                context_id: "context-default".to_string(),
                coordinator_session_id: "session-objective-recover".to_string(),
                delivery_session_id: "session-objective-recover".to_string(),
                parent_objective_id: None,
                source_event_id: "timer-source".to_string(),
                stated_objective: "计时器到达后继续".to_string(),
                token_budget: None,
            })
            .await
            .unwrap();
        let deadline = chrono::Utc::now() + chrono::Duration::milliseconds(150);
        assert!(matches!(
            store
                .update_objective_state(
                    "objective-recover",
                    1,
                    ObjectiveStatus::Active,
                    Some(ObjectiveWaitCondition::Timer { deadline }),
                    Some("等待计时器到期"),
                )
                .await
                .unwrap(),
            ObjectiveMutation::Updated(_)
        ));
        drop(store);

        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let client = Arc::new(ObjectiveRecoveryClient {
            calls: AtomicU64::new(0),
        });
        let runtime = MorphzRuntime::builder(config, client.clone())
            .database_path(&database_path)
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        let mut replies = runtime.subscribe("chat/reply", 8);
        runtime.start().await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(client.calls.load(Ordering::SeqCst), 0);
        let reply = tokio::time::timeout(std::time::Duration::from_secs(3), replies.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            reply.payload.get("text").and_then(|value| value.as_str()),
            Some("recovered-objective-complete")
        );
        assert_eq!(client.calls.load(Ordering::SeqCst), 2);
        let objective = runtime
            .get_objective("objective-recover")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(objective.status, ObjectiveStatus::Completed);
        assert!(runtime
            .query_events(QueryFilter {
                topic: Some("objective/wait_satisfied".to_string()),
                ..Default::default()
            })
            .await
            .unwrap()
            .iter()
            .any(
                |event| event.payload.get("reason").and_then(|value| value.as_str())
                    == Some("timer-deadline-reached")
            ));
    }

    #[tokio::test]
    async fn inspect_session_context_uses_persisted_mount_before_first_message() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let runtime = MorphzRuntime::builder(config, Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        runtime
            .ensure_context(NewCognitiveContext {
                id: "persisted-context".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                title: "Persisted".to_string(),
            })
            .await
            .unwrap();
        runtime
            .ensure_session(NewSession {
                id: "persisted-session".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: "persisted-context".to_string(),
                parent_session_id: None,
                title: "Persisted".to_string(),
                mount_kind: crate::memory::SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();

        let view = runtime
            .inspect_session_context_view("persisted-session")
            .await
            .unwrap();
        assert_eq!(view.context_id, "persisted-context");
        assert!(runtime
            .inspect_session_context_view("unknown-session")
            .await
            .unwrap_err()
            .to_string()
            .contains("不存在"));
    }

    #[tokio::test]
    async fn cancelling_delegation_recursively_cancels_descendants() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::Deny;
        let runtime = MorphzRuntime::builder(config, Arc::new(ReplyClient))
            .database_path(database.path().to_string_lossy())
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: true,
            })
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        for context_id in ["cancel-child-context", "cancel-grand-context"] {
            runtime
                .create_context(NewCognitiveContext {
                    id: context_id.to_string(),
                    agent_id: runtime.identity().agent_id.clone(),
                    title: context_id.to_string(),
                })
                .await
                .unwrap();
        }
        for (session_id, context_id) in [
            ("cancel-root", runtime.identity().context_id.as_str()),
            ("cancel-child", "cancel-child-context"),
            ("cancel-grand", "cancel-grand-context"),
        ] {
            runtime
                .ensure_session(NewSession {
                    id: session_id.to_string(),
                    agent_id: runtime.identity().agent_id.clone(),
                    context_id: context_id.to_string(),
                    parent_session_id: None,
                    title: session_id.to_string(),
                    mount_kind: crate::memory::SessionMountKind::ExistingContext,
                })
                .await
                .unwrap();
        }
        for delegation in [
            NewDelegation {
                id: "cancel-delegation-root".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                parent_context_id: runtime.identity().context_id.clone(),
                parent_session_id: "cancel-root".to_string(),
                child_context_id: "cancel-child-context".to_string(),
                child_session_id: "cancel-child".to_string(),
                task: "child".to_string(),
                success_when: None,
                context_scope: "mind_only".to_string(),
            },
            NewDelegation {
                id: "cancel-delegation-child".to_string(),
                agent_id: runtime.identity().agent_id.clone(),
                parent_context_id: "cancel-child-context".to_string(),
                parent_session_id: "cancel-child".to_string(),
                child_context_id: "cancel-grand-context".to_string(),
                child_session_id: "cancel-grand".to_string(),
                task: "grand".to_string(),
                success_when: None,
                context_scope: "mind_only".to_string(),
            },
        ] {
            let id = delegation.id.clone();
            runtime.create_delegation(delegation).await.unwrap();
            runtime
                .update_delegation_status(&id, DelegationStatus::Running, None)
                .await
                .unwrap();
        }

        let cancelled = runtime
            .cancel_delegation_tree("cancel-delegation-root")
            .await
            .unwrap();
        assert_eq!(cancelled.len(), 2);
        for id in ["cancel-delegation-root", "cancel-delegation-child"] {
            assert_eq!(
                runtime.get_delegation(id).await.unwrap().unwrap().status,
                DelegationStatus::Cancelled
            );
        }
    }
}
