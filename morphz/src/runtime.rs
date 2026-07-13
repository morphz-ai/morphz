use crate::approval::{
    AiAutoReviewProvider, ApprovalDecision, ApprovalProvider, DenyAllApprovalProvider,
    EscalatingApprovalProvider, HumanApprovalHub, HumanApprovalProvider, PendingHumanApproval,
};
use crate::config::AppConfig;
use crate::context_tools::{ContextTxTool, RecallTool};
use crate::event::{Event, InMemoryEventBus, TYPE_USER_MESSAGE};
use crate::llm::Client;
use crate::memory::sqlite::SqliteStore;
use crate::memory::{
    AgentBootstrapRecord, AgentRecord, CognitiveContextRecord, DelegationRecord, DelegationStatus,
    EventStore, MessageClaim, NewAgent, NewCognitiveContext, NewDelegation, NewSession,
    QueryFilter, SessionRecord, SessionStore, SessionUpdate,
};
use crate::orchestrator::context::{ContextEngine, ContextView};
use crate::orchestrator::orchestrator::Orchestrator;
use crate::permission::{PermissionBroker, PermissionProfile, ReviewerKind, SandboxMode};
use crate::tool::{
    DelegateTool, EditFileTool, ExecuteCommandTool, KillTaskTool, ListFilesTool, ListSkillsTool,
    ReadFileTool, Registry, SearchTool, WriteFileTool,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
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
        let bus = Arc::new(InMemoryEventBus::new());
        let store =
            Arc::new(SqliteStore::new_with_config(&database_path, &self.config.memory).await?);
        let context_engine = Arc::new(
            ContextEngine::new(
                Arc::clone(&store) as Arc<dyn EventStore>,
                self.config.orchestrator.clone(),
            )
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>),
        );
        let human_approval_hub = HumanApprovalHub::default();
        let permission_profile =
            Arc::new(PermissionProfile::from_config(&self.config.permissions)?);
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
        let registry = Arc::new(Registry::new());
        register_default_tools(
            &registry,
            &context_engine,
            &permissions,
            &bus,
            &self.config,
            self.tool_policy,
        );
        let orchestrator = Arc::new(Orchestrator::new_with_context_engine(
            Arc::clone(&bus),
            Arc::clone(&store) as Arc<dyn EventStore>,
            self.client,
            Arc::clone(&registry),
            self.config.orchestrator.clone(),
            Arc::clone(&context_engine),
        ));
        Ok(MorphzRuntime {
            inner: Arc::new(RuntimeInner {
                config: self.config,
                identity: self.identity,
                database_path,
                bus,
                store,
                registry,
                orchestrator,
                human_approval_hub,
                started: AtomicBool::new(false),
                start_lock: tokio::sync::Mutex::new(()),
            }),
        })
    }
}

fn register_default_tools(
    registry: &Arc<Registry>,
    context_engine: &Arc<ContextEngine>,
    permissions: &Arc<PermissionBroker>,
    bus: &Arc<InMemoryEventBus>,
    config: &AppConfig,
    policy: RuntimeToolPolicy,
) {
    registry.register(Arc::new(ContextTxTool::new(Arc::clone(context_engine))));
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
    bus: Arc<InMemoryEventBus>,
    store: Arc<SqliteStore>,
    registry: Arc<Registry>,
    orchestrator: Arc<Orchestrator>,
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
        Arc::clone(&self.inner.orchestrator).start().await?;
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
        self.inner.store.ensure_session(session).await?;
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
        self.inner
            .store
            .create_agent_bundle(agent, context, session)
            .await
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
        self.inner.store.create_session(session).await
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
        self.inner
            .orchestrator
            .get_current_context(session_id)
            .await
    }

    pub async fn inspect_session_context_view(
        &self,
        session_id: &str,
    ) -> Result<ContextView, RuntimeError> {
        self.inner
            .orchestrator
            .get_current_context_view(session_id)
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

    #[async_trait::async_trait]
    impl Client for ReplyClient {
        async fn create_completion(
            &self,
            _messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
        ) -> Result<Response, RuntimeError> {
            Ok(Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: "runtime-reply".to_string(),
                    r#type: "function".to_string(),
                    func_name: "reply".to_string(),
                    arguments: json!({
                        "disposition": "deliver",
                        "content": "runtime-ok"
                    })
                    .to_string(),
                }],
            })
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
}
