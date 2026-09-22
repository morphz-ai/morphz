use super::*;
use crate::memory::sqlite::SqliteStore;
use crate::memory::{
    ActivationStore, DelegationStore, NewAgent, SessionDirectoryStore, ThreadStore, TimerStore,
};
use tempfile::TempDir;

struct NeverCalledClient;

#[async_trait::async_trait]
impl Client for NeverCalledClient {
    async fn create_completion(
        &self,
        _: Vec<Message>,
        _: Vec<ToolDefinition>,
    ) -> Result<crate::llm::Response, DynError> {
        panic!("delegation result routing must not call a model");
    }
}

struct Fixture {
    _directory: TempDir,
    store: Arc<SqliteStore>,
    orchestrator: Arc<Orchestrator>,
}

impl Fixture {
    async fn new() -> Self {
        let directory = TempDir::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(directory.path().join("delegation.db").to_str().unwrap())
                .await
                .unwrap(),
        );
        store
            .ensure_agent(NewAgent {
                id: "agent".into(),
                title: "Agent".into(),
                root_context_id: "parent-context".into(),
            })
            .await
            .unwrap();
        store
            .create_context(NewCognitiveContext {
                id: "parent-context".into(),
                agent_id: "agent".into(),
                title: "Parent".into(),
            })
            .await
            .unwrap();
        store
            .create_session(NewSession {
                id: "parent-session".into(),
                agent_id: "agent".into(),
                context_id: "parent-context".into(),
                parent_session_id: None,
                title: "Parent".into(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        store
            .create_delegation_scaffold(
                NewCognitiveContext {
                    id: "child-context".into(),
                    agent_id: "agent".into(),
                    title: "Child".into(),
                },
                NewSession {
                    id: "child-session".into(),
                    agent_id: "agent".into(),
                    context_id: "child-context".into(),
                    parent_session_id: None,
                    title: "Child".into(),
                    mount_kind: SessionMountKind::DelegationProjection,
                },
                NewDelegation {
                    id: "delegation_test".into(),
                    agent_id: "agent".into(),
                    parent_context_id: "parent-context".into(),
                    parent_session_id: "parent-session".into(),
                    child_context_id: "child-context".into(),
                    child_session_id: "child-session".into(),
                    initiating_principal_id: None,
                    task: "Fix the bug".into(),
                    success_when: None,
                    context_scope: "mind_only".into(),
                },
            )
            .await
            .unwrap();
        store
            .update_delegation_status("delegation_test", DelegationStatus::Running, None)
            .await
            .unwrap();
        let config = OrchestratorConfig::default();
        let engine = Arc::new(
            ContextEngine::new(store.clone(), config.clone()).with_session_store(store.clone()),
        );
        let orchestrator = Orchestrator::new_test_with_context_engine(
            Arc::new(InMemoryEventBus::new()),
            store.clone(),
            None,
            store.clone(),
            Arc::new(NeverCalledClient),
            Arc::new(Registry::new()),
            config,
            engine,
            Arc::new(TimerEngine::new(store.clone() as Arc<dyn TimerStore>)),
            None,
        )
        .unwrap();
        Self {
            _directory: directory,
            store,
            orchestrator,
        }
    }

    async fn root(&self, id: &str, task: bool) -> Event {
        let mut root = Event::new(
            id.into(),
            if task {
                "System-Delegation"
            } else {
                "Parent-Agent"
            }
            .into(),
            if task {
                TYPE_USER_MESSAGE
            } else {
                TYPE_SESSION_SIGNAL
            }
            .into(),
            if task {
                "chat/user_message"
            } else {
                "chat/session_signal"
            }
            .into(),
            json!({
                "context_id": "child-context", "session_id": "child-session",
                "text": if task { "Fix the bug" } else { "Report progress" }
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        if task {
            root.payload.extend(
                json!({"delegation_id": "delegation_test", "return_context_id": "parent-context",
                    "return_session_id": "parent-session"})
                .as_object()
                .unwrap()
                .clone(),
            );
        }
        self.store.append(root.clone()).await.unwrap();
        self.store
            .ensure_thread(NewThread {
                id: stable_thread_id(id),
                agent_id: "agent".into(),
                context_id: "child-context".into(),
                session_id: "child-session".into(),
                initiating_principal_id: None,
                root_turn_id: id.into(),
                kind: ThreadKind::DialogueTurn,
                executor_kind: "self".into(),
                executor_id: None,
                target_id: None,
                supervision: ThreadSupervision::runtime("dialogue-router"),
            })
            .await
            .unwrap();
        root
    }

    async fn reply(&self, root: &Event, id: &str, topic: &str, terminal: bool) -> Event {
        let event = Event::new(
            id.into(),
            "Agent-Morphz".into(),
            TYPE_AGENT_CALL.into(),
            topic.into(),
            json!({"context_id": "child-context", "session_id": "child-session",
                "thread_id": stable_thread_id(&root.id), "root_turn_id": root.id,
                "text": id})
            .as_object()
            .unwrap()
            .clone(),
        );
        self.store.append(event.clone()).await.unwrap();
        if terminal {
            let thread = self
                .store
                .get_thread_by_root(&root.id)
                .await
                .unwrap()
                .unwrap();
            assert!(matches!(
                self.store
                    .update_thread(
                        &thread.id,
                        thread.revision,
                        None,
                        Some(ThreadLifecycle::Completed),
                        Some(id),
                        Some(id),
                        None,
                        None,
                    )
                    .await
                    .unwrap(),
                ThreadMutation::Updated(_)
            ));
        }
        event
    }

    async fn activate(&self, root: &Event) {
        let persisted = self
            .store
            .query(QueryFilter {
                event_id: Some(root.id.clone()),
                ..Default::default()
            })
            .await
            .unwrap()
            .remove(0);
        self.store
            .ensure_thread_activation(NewThreadActivation {
                id: stable_thread_activation_id(&root.id),
                agent_id: "agent".into(),
                context_id: "child-context".into(),
                session_id: "child-session".into(),
                initiating_principal_id: None,
                trigger_event_id: root.id.clone(),
                trigger_sequence: persisted.sequence.unwrap(),
                trigger_kind: root.event_type.clone(),
                parent_activation_id: None,
                root_turn_id: root.id.clone(),
            })
            .await
            .unwrap();
    }

    async fn delegation(&self) -> crate::memory::DelegationRecord {
        self.store
            .get_delegation("delegation_test")
            .await
            .unwrap()
            .unwrap()
    }

    async fn results(&self) -> Vec<Event> {
        self.store
            .query(QueryFilter {
                session_id: Some("parent-session".into()),
                topic: Some("chat/tool_output".into()),
                ..Default::default()
            })
            .await
            .unwrap()
    }

    async fn recover(&self) {
        self.orchestrator
            .recover_delegation(self.store.as_ref(), self.delegation().await)
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn delegation_result_progress_reply_cannot_complete_original_task() {
    for topic in ["chat/reply", "chat/no_reply"] {
        let f = Fixture::new().await;
        let task = f.root("delegation_start_delegation_test_123", true).await;
        let progress = f.root("progress-inquiry", false).await;
        let reply = f
            .reply(&progress, "code-not-changed-yet", topic, true)
            .await;
        f.orchestrator.handle_chat_event(reply).await.unwrap();
        assert_eq!(f.delegation().await.status, DelegationStatus::Running);
        assert!(f.results().await.is_empty());
        assert!(!f
            .store
            .get_thread_by_root(&task.id)
            .await
            .unwrap()
            .unwrap()
            .lifecycle
            .is_terminal());

        let actual = f
            .reply(&task, "actual-task-result", "runtime/thread_result", true)
            .await;
        f.orchestrator
            .handle_chat_event(actual.clone())
            .await
            .unwrap();
        f.orchestrator
            .handle_chat_event(actual.clone())
            .await
            .unwrap();
        assert_eq!(f.delegation().await.status, DelegationStatus::Completed);
        let results = f.results().await;
        assert_eq!(
            results.len(),
            1,
            "duplicate delivery must remain idempotent"
        );
        assert_eq!(
            results[0].payload.get("source_event_id"),
            Some(&json!(actual.id))
        );
    }
}

#[tokio::test]
async fn delegation_result_requires_committed_terminal_outcome_not_just_reply_topic() {
    let f = Fixture::new().await;
    let task = f.root("delegation_start_delegation_test_123", true).await;
    let draft = f
        .reply(&task, "still-waiting", "chat/no_reply", false)
        .await;
    f.orchestrator
        .handle_chat_event(draft.clone())
        .await
        .unwrap();
    assert_eq!(f.delegation().await.status, DelegationStatus::Running);
    let actual = f.reply(&task, "committed-result", "chat/reply", true).await;
    f.orchestrator.handle_chat_event(draft).await.unwrap();
    assert_eq!(f.delegation().await.status, DelegationStatus::Running);
    f.orchestrator.handle_chat_event(actual).await.unwrap();
    assert_eq!(f.delegation().await.status, DelegationStatus::Completed);
}

#[tokio::test]
async fn delegation_result_recovery_does_not_use_progress_reply_for_open_task() {
    let f = Fixture::new().await;
    let task = f.root("delegation_start_delegation_test_123", true).await;
    f.activate(&task).await;
    let progress = f.root("progress-inquiry", false).await;
    f.reply(&progress, "code-not-changed-yet", "chat/reply", true)
        .await;
    f.recover().await;
    assert_eq!(f.delegation().await.status, DelegationStatus::Running);
    assert!(f.results().await.is_empty());
}

#[tokio::test]
async fn delegation_result_recovery_reads_original_thread_result_not_latest_session_reply() {
    let f = Fixture::new().await;
    let task = f.root("delegation_start_delegation_test_123", true).await;
    let actual = f
        .reply(&task, "actual-task-result", "runtime/thread_result", true)
        .await;
    let progress = f.root("progress-inquiry", false).await;
    f.activate(&progress).await;
    for i in 0..105 {
        f.reply(
            &progress,
            &format!("unrelated-result-{i}"),
            "chat/reply",
            false,
        )
        .await;
    }
    f.recover().await;
    assert_eq!(f.delegation().await.status, DelegationStatus::Completed);
    let results = f.results().await;
    assert_eq!(results.len(), 1);
    assert_eq!(
        results[0].payload.get("source_event_id"),
        Some(&json!(actual.id))
    );
}

#[tokio::test]
async fn delegation_result_recovery_without_original_task_cannot_claim_progress_as_success() {
    let f = Fixture::new().await;
    let progress = f.root("progress-inquiry", false).await;
    f.reply(&progress, "code-not-changed-yet", "chat/reply", true)
        .await;
    f.recover().await;
    assert_eq!(f.delegation().await.status, DelegationStatus::Failed);
    assert!(f
        .results()
        .await
        .iter()
        .all(|event| event.payload.get("source_event_id").is_none()));
}

#[tokio::test]
async fn delegation_result_delivery_reply_cannot_complete_original_task() {
    let f = Fixture::new().await;
    let task = f.root("delegation_start_delegation_test_123", true).await;
    f.activate(&task).await;
    let mut delivery = Event::new(
        "delivery_reply_progress".into(),
        "Runtime-Delivery".into(),
        TYPE_AGENT_CALL.into(),
        "chat/reply".into(),
        json!({"context_id": "child-context", "session_id": "child-session",
            "root_turn_id": "delivery_reply_progress", "thread_kind": "delivery",
            "covers": ["progress-thread"], "text": "Code has not changed"})
        .as_object()
        .unwrap()
        .clone(),
    );
    f.store.append(delivery.clone()).await.unwrap();
    f.orchestrator
        .handle_chat_event(delivery.clone())
        .await
        .unwrap();
    assert_eq!(f.delegation().await.status, DelegationStatus::Running);
    // Even an incidental delegation_id is not proof of task ownership.
    delivery
        .payload
        .insert("delegation_id".into(), json!("delegation_test"));
    f.orchestrator.handle_chat_event(delivery).await.unwrap();
    assert_eq!(f.delegation().await.status, DelegationStatus::Running);
    assert!(f.results().await.is_empty());
}

#[tokio::test]
async fn delegation_result_rejects_missing_or_conflicting_causal_route() {
    let f = Fixture::new().await;
    let task = f.root("delegation_start_delegation_test_123", true).await;
    let result = f
        .reply(&task, "actual-task-result", "chat/reply", true)
        .await;
    for key in ["context_id", "session_id", "thread_id", "root_turn_id"] {
        for value in [None, Some(json!("unrelated"))] {
            let mut invalid = result.clone();
            invalid.payload.remove(key);
            if let Some(value) = value {
                invalid.payload.insert(key.into(), value);
            }
            assert!(
                !f.orchestrator
                    .complete_delegation_if_needed(&invalid, "child-session")
                    .await
                    .unwrap(),
                "accepted invalid {key}"
            );
        }
    }
    assert_eq!(f.delegation().await.status, DelegationStatus::Running);
    f.orchestrator.handle_chat_event(result).await.unwrap();
    assert_eq!(f.delegation().await.status, DelegationStatus::Completed);
}
