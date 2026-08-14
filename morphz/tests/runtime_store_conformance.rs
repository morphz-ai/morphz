use morphz::approval_authority::stable_approval_identity;
use morphz::config::AppConfig;
use morphz::event::Event;
use morphz::execution::ExecutionJobManager;
use morphz::llm::{Client, Message, Response, ToolDefinition};
use morphz::memory::postgres::PostgresStore;
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{
    objective_primary_execution_root_id, stable_thread_id, stable_thread_signal_id,
    ActivationStore, EdgeCommandMutation, EdgeCommandStatus, EdgeExecutionStore, EdgeOutputStream,
    ExecutionNodeMutation, ExecutionNodeStatus, SessionDirectoryStore,
};
use morphz::memory::{
    ActionGroupFilter, ActionGroupMemberStatus, ActionGroupStatus, ActionGroupStore,
    ActivationOutcomeCommit, ApprovalMutation, ApprovalResolution, ApprovalStatus, ApprovalStore,
    CapabilityLeaseFilter, CapabilityLeaseMutation, CapabilityLeaseStatus, CapabilityLeaseStore,
    CognitiveClockStore, DelegationStatus, DelegationStore, DeliveryFlushCommit,
    DeliveryIngressStore, DeliveryStatus, EventAppend, EventStore, ExecutionApprovalMutation,
    ExecutionApprovalStore, ExecutionJobMutation, ExecutionJobStatus, ExecutionJobStore,
    ExecutionJobTerminal, ExecutionRetrySafety, ExecutionTargetAuthorizationFilter,
    ExecutionTargetAuthorizationMutation, ExecutionTargetAuthorizationScope,
    ExecutionTargetAuthorizationStatus, ExecutionTargetAuthorizationStore, ExecutionTargetFilter,
    ExecutionTargetKind, ExecutionTargetMutation, ExecutionTargetRegistration,
    ExecutionTargetStatus, ExecutionTargetStore, MessageClaim, MindProjectionCommit,
    MindProjectionStore, NewActionGroup, NewActionGroupMember, NewAgent, NewApprovalRequest,
    NewCapabilityLease, NewCognitiveContext, NewDelegation, NewEdgeCommand, NewExecutionJob,
    NewExecutionNodeChallenge, NewExecutionTargetAuthorization, NewMindProjection,
    NewNodePairingCode, NewObjective, NewPrincipal, NewRuntimeTimer, NewSession, NewThread,
    NewThreadActivation, NewThreadSignal, ObjectiveMutation, ObjectiveStatus, ObjectiveStore,
    ObjectiveWaitCondition, PairExecutionNode, QueryFilter, RecallDocument, RecallDocumentKind,
    RecallProjectionStore, RuntimeTimerKind, RuntimeTimerStatus, ScheduleMutation, ScheduleStatus,
    ScheduleStore, SessionAttentionState, SessionAttentionUpdate, SessionMountKind,
    SessionProjectionMutation, SessionProjectionStore, SessionStatus, SessionUpdate,
    SignalOutboxStatus, ThreadActivationMutation, ThreadActivationStatus, ThreadControlAction,
    ThreadGroupStore, ThreadKind, ThreadLifecycle, ThreadMutation, ThreadSignalStatus, ThreadStore,
    TimerStore,
};
use morphz::permission::{PermissionMode, ReviewerKind};
use morphz::runtime::{MorphzRuntime, RuntimeIdentity, RuntimeToolPolicy};
use morphz::scheduler::{
    KernelResult, NewSchedulerDependency, SchedulerDependencyFilter, SchedulerDependencyKind,
    SchedulerDependencyMutation, SchedulerDependencyOwnerKind, SchedulerDependencyStatus,
    SchedulerDependencyStore, SchedulerKernel,
};
use serde_json::json;
use std::future::Future;
use std::pin::Pin;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tempfile::{NamedTempFile, TempDir};

type TestError = Box<dyn std::error::Error + Send + Sync>;
type AttentionFuture<'a> = Pin<
    Box<
        dyn Future<Output = Result<Option<(SessionAttentionState, u64, Option<String>)>, TestError>>
            + Send
            + 'a,
    >,
>;

fn assert_complete_runtime_store<T: morphz::memory::RuntimeStore>() {}

#[test]
fn sqlite_two_process_context_cas_is_fenced() {
    const ROLE_ENV: &str = "MORPHZ_TEST_SQLITE_PROCESS_ROLE";
    const DB_ENV: &str = "MORPHZ_TEST_SQLITE_PROCESS_DB";
    const SYNC_ENV: &str = "MORPHZ_TEST_SQLITE_PROCESS_SYNC";
    if let Ok(role) = std::env::var(ROLE_ENV) {
        let db = std::env::var(DB_ENV).unwrap();
        let sync = std::path::PathBuf::from(std::env::var(SYNC_ENV).unwrap());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = runtime.block_on(async {
            let store = SqliteStore::new(&db).await.unwrap();
            std::fs::write(sync.join(format!("ready-{role}")), b"ready").unwrap();
            while !sync.join("go").exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            let event = context_event(
                &format!("sqlite-process-event-{role}"),
                "sqlite-process-context",
            );
            store
                .commit_mind_projection_transaction(
                    &event,
                    &[],
                    &SessionProjectionMutation::default(),
                    0,
                    NewMindProjection {
                        context_id: "sqlite-process-context".to_string(),
                        revision: 1,
                        state: json!({"version": 1, "worker": role}),
                        state_hash: format!("sqlite-process-hash-{role}"),
                        head_event_id: Some(event.id.clone()),
                        recall_documents: Vec::new(),
                    },
                )
                .await
                .unwrap()
        });
        let outcome = match result {
            MindProjectionCommit::Committed { .. } => "committed",
            MindProjectionCommit::Conflict { .. } => "conflict",
        };
        std::fs::write(sync.join(format!("result-{role}")), outcome).unwrap();
        return;
    }

    let temp = TempDir::new().unwrap();
    let db = temp.path().join("shared.db");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let store = SqliteStore::new(db.to_str().unwrap()).await.unwrap();
        store
            .create_context(NewCognitiveContext {
                id: "sqlite-process-context".to_string(),
                agent_id: "sqlite-process-agent".to_string(),
                title: "SQLite Process Context".to_string(),
            })
            .await
            .unwrap();
        store
            .initialize_mind_projection(NewMindProjection {
                context_id: "sqlite-process-context".to_string(),
                revision: 0,
                state: json!({"version": 0}),
                state_hash: "sqlite-process-hash-0".to_string(),
                head_event_id: None,
                recall_documents: Vec::new(),
            })
            .await
            .unwrap();
    });

    let executable = std::env::current_exe().unwrap();
    let spawn = |role: &str| {
        Command::new(&executable)
            .arg("--exact")
            .arg("sqlite_two_process_context_cas_is_fenced")
            .arg("--nocapture")
            .env(ROLE_ENV, role)
            .env(DB_ENV, &db)
            .env(SYNC_ENV, temp.path())
            .spawn()
            .unwrap()
    };
    let mut first = spawn("a");
    let mut second = spawn("b");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while !(temp.path().join("ready-a").exists() && temp.path().join("ready-b").exists()) {
        assert!(
            std::time::Instant::now() < deadline,
            "SQLite child processes did not reach the shared barrier"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    std::fs::write(temp.path().join("go"), b"go").unwrap();
    assert!(first.wait().unwrap().success());
    assert!(second.wait().unwrap().success());
    let mut outcomes = [
        std::fs::read_to_string(temp.path().join("result-a")).unwrap(),
        std::fs::read_to_string(temp.path().join("result-b")).unwrap(),
    ];
    outcomes.sort();
    assert_eq!(outcomes, ["committed", "conflict"]);
}

#[derive(Default)]
struct MultiRuntimeReplyClient {
    calls: AtomicUsize,
}

#[async_trait::async_trait]
impl Client for MultiRuntimeReplyClient {
    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
    ) -> Result<Response, TestError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(Response {
            content: "multi-runtime-ok".to_string(),
            tool_calls: Vec::new(),
        })
    }
}

fn context_event(id: &str, context_id: &str) -> Event {
    Event::new(
        id.to_string(),
        "Store-Conformance".to_string(),
        "context_transaction".to_string(),
        "chat/context_tx_committed".to_string(),
        json!({"context_id": context_id})
            .as_object()
            .unwrap()
            .clone(),
    )
}

async fn assert_session_directory_conformance<S>(store: Arc<S>)
where
    S: SessionDirectoryStore + Send + Sync + 'static,
{
    store
        .ensure_principal(NewPrincipal {
            id: "o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat".to_string(),
            provider_id: "gateway-conformance".to_string(),
            assurance: "trusted-gateway".to_string(),
            display_name: Some("微信用户".to_string()),
        })
        .await
        .unwrap();
    store
        .bind_session_principal(
            "conformance-session",
            "o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat",
        )
        .await
        .unwrap();
    let external_id = store.search_principals("wechat", None, 20).await.unwrap();
    assert_eq!(external_id.entries.len(), 1);
    assert_eq!(
        external_id.entries[0].principal.id,
        "o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat"
    );
    assert_eq!(external_id.entries[0].active_session_count, 1);
    let external_name = store.search_principals("微信", None, 20).await.unwrap();
    assert_eq!(external_name.entries.len(), 1);

    let agent = store.get_agent("conformance-agent").await.unwrap().unwrap();
    assert_eq!(agent.root_context_id, "conformance-context");
    assert!(store
        .ensure_agent(NewAgent {
            id: agent.id.clone(),
            title: "ignored idempotent title".to_string(),
            root_context_id: "wrong-context".to_string(),
        })
        .await
        .is_err());

    let other_context = store
        .create_context(NewCognitiveContext {
            id: "conformance-other-context".to_string(),
            agent_id: agent.id.clone(),
            title: "Other Context".to_string(),
        })
        .await
        .unwrap();
    store
        .set_context_seed(
            &other_context.id,
            "conformance-context",
            7,
            "seed-hash",
            "seed-projection",
        )
        .await
        .unwrap();
    let seeded = store.get_context(&other_context.id).await.unwrap().unwrap();
    assert_eq!(seeded.seed_context_version, Some(7));
    assert_eq!(seeded.seed_snapshot_hash.as_deref(), Some("seed-hash"));

    assert!(store
        .create_session(NewSession {
            id: "invalid-cross-context-child".to_string(),
            agent_id: agent.id.clone(),
            context_id: other_context.id.clone(),
            parent_session_id: Some("conformance-session".to_string()),
            title: "Invalid".to_string(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .is_err());

    let race_session = NewSession {
        id: "conformance-directory-race".to_string(),
        agent_id: agent.id.clone(),
        context_id: "conformance-context".to_string(),
        parent_session_id: Some("conformance-session".to_string()),
        title: "Concurrent Session".to_string(),
        mount_kind: SessionMountKind::ExistingContext,
    };
    let first = {
        let store = Arc::clone(&store);
        let session = race_session.clone();
        tokio::spawn(async move { store.ensure_session(session).await })
    };
    let second = {
        let store = Arc::clone(&store);
        let session = race_session.clone();
        tokio::spawn(async move { store.ensure_session(session).await })
    };
    let first = first.await.unwrap().unwrap();
    let second = second.await.unwrap().unwrap();
    assert_eq!(first.id, second.id);
    assert_eq!(first.context_id, "conformance-context");

    let changed_at = chrono::Utc::now();
    let first_attention = {
        let store = Arc::clone(&store);
        let session_id = race_session.id.clone();
        tokio::spawn(async move {
            store
                .update_session_attention(SessionAttentionUpdate {
                    session_id,
                    context_id: "conformance-context".to_string(),
                    expected_revision: 0,
                    state: SessionAttentionState::Retired,
                    reason: Some("first".to_string()),
                    changed_at,
                    event_id: "directory-attention-a".to_string(),
                })
                .await
        })
    };
    let second_attention = {
        let store = Arc::clone(&store);
        let session_id = race_session.id.clone();
        tokio::spawn(async move {
            store
                .update_session_attention(SessionAttentionUpdate {
                    session_id,
                    context_id: "conformance-context".to_string(),
                    expected_revision: 0,
                    state: SessionAttentionState::Active,
                    reason: Some("second".to_string()),
                    changed_at,
                    event_id: "directory-attention-b".to_string(),
                })
                .await
        })
    };
    let attention_results = [
        first_attention.await.unwrap().unwrap(),
        second_attention.await.unwrap().unwrap(),
    ];
    assert_eq!(
        attention_results
            .iter()
            .filter(|result| result.is_some())
            .count(),
        1,
        "Session attention revision must admit one concurrent writer"
    );
    assert_eq!(
        store
            .get_session(&race_session.id)
            .await
            .unwrap()
            .unwrap()
            .attention_revision,
        1
    );

    let archived = store
        .update_session(
            &race_session.id,
            SessionUpdate {
                title: Some("Archived Session".to_string()),
                status: Some(SessionStatus::Archived),
            },
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(archived.status, SessionStatus::Archived);
    assert!(!store
        .list_context_sessions("conformance-context", false)
        .await
        .unwrap()
        .iter()
        .any(|session| session.id == race_session.id));
    assert!(store
        .list_context_sessions("conformance-context", true)
        .await
        .unwrap()
        .iter()
        .any(|session| session.id == race_session.id));
}

async fn assert_thread_store_conformance<S>(store: Arc<S>)
where
    S: morphz::memory::RuntimeStore + 'static,
{
    let thread = NewThread {
        id: "conformance-thread".to_string(),
        agent_id: "conformance-agent".to_string(),
        context_id: "conformance-context".to_string(),
        session_id: "conformance-session".to_string(),
        initiating_principal_id: None,
        root_turn_id: "root-conformance-thread".to_string(),
        kind: ThreadKind::Execution,
        executor_kind: "runtime".to_string(),
        executor_id: None,
        target_id: None,
        supervision: morphz::memory::ThreadSupervision::legacy(),
    };
    let first = {
        let store = Arc::clone(&store);
        let thread = thread.clone();
        tokio::spawn(async move { store.ensure_thread(thread).await })
    };
    let second = {
        let store = Arc::clone(&store);
        let thread = thread.clone();
        tokio::spawn(async move { store.ensure_thread(thread).await })
    };
    let first = first.await.unwrap().unwrap();
    let second = second.await.unwrap().unwrap();
    assert_eq!(first, second);
    let mut conflicting = thread.clone();
    conflicting.id = "different-thread-id".to_string();
    conflicting.context_id = "conformance-other-context".to_string();
    assert!(store.ensure_thread(conflicting).await.is_err());
    let bound = match store
        .bind_thread_target(&first.id, first.revision, "target-affinity-a")
        .await
        .unwrap()
    {
        ThreadMutation::Updated(thread) => thread,
        mutation => panic!("unexpected Thread target bind mutation: {mutation:?}"),
    };
    assert_eq!(bound.target_id.as_deref(), Some("target-affinity-a"));
    assert!(matches!(
        store
            .bind_thread_target(&bound.id, 1, "target-affinity-b")
            .await
            .unwrap(),
        ThreadMutation::Conflict { .. }
    ));

    let cas_thread = store
        .ensure_thread(NewThread {
            id: "conformance-thread-cas".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            session_id: "conformance-session".to_string(),
            initiating_principal_id: None,
            root_turn_id: "root-conformance-thread-cas".to_string(),
            kind: ThreadKind::DialogueTurn,
            executor_kind: "model".to_string(),
            executor_id: None,
            target_id: None,
            supervision: morphz::memory::ThreadSupervision::legacy(),
        })
        .await
        .unwrap();
    let cas_revision = cas_thread.revision;
    let first = {
        let store = Arc::clone(&store);
        let id = cas_thread.id.clone();
        tokio::spawn(async move {
            store
                .update_thread(
                    &id,
                    cas_revision,
                    None,
                    Some(ThreadLifecycle::Completed),
                    Some("first"),
                    Some("thread-result-a"),
                    Some(DeliveryStatus::Pending),
                    None,
                )
                .await
        })
    };
    let second = {
        let store = Arc::clone(&store);
        let id = cas_thread.id.clone();
        tokio::spawn(async move {
            store
                .update_thread(
                    &id,
                    cas_revision,
                    None,
                    Some(ThreadLifecycle::Failed),
                    Some("second"),
                    Some("thread-result-b"),
                    Some(DeliveryStatus::Pending),
                    None,
                )
                .await
        })
    };
    let mutations = [
        first.await.unwrap().unwrap(),
        second.await.unwrap().unwrap(),
    ];
    assert_eq!(
        mutations
            .iter()
            .filter(|mutation| matches!(mutation, ThreadMutation::Updated(_)))
            .count(),
        1
    );
    assert_eq!(
        mutations
            .iter()
            .filter(|mutation| matches!(mutation, ThreadMutation::Conflict { .. }))
            .count(),
        1
    );
    assert_eq!(
        store
            .list_session_delivery_threads("conformance-session", false)
            .await
            .unwrap()
            .len(),
        1
    );

    let timer = store
        .arm_delivery_flush_timer("conformance-delivery-timer", "conformance-session", 1, 5)
        .await
        .unwrap()
        .unwrap();
    let claimed = store
        .claim_due_runtime_timers(
            chrono::Utc::now() + chrono::Duration::seconds(10),
            "delivery-worker",
            chrono::Utc::now() + chrono::Duration::seconds(30),
            1,
        )
        .await
        .unwrap();
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].id, timer.id);
    let delivery_event = Event::new(
        "conformance-delivery-ready".to_string(),
        "Store-Conformance".to_string(),
        "runtime_control".to_string(),
        "chat/thread_completion_ready".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session",
            "completed_thread_ids": ["conformance-thread-cas"]
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    let delivery_thread = NewThread {
        id: "conformance-delivery-thread".to_string(),
        agent_id: "conformance-agent".to_string(),
        context_id: "conformance-context".to_string(),
        session_id: "conformance-session".to_string(),
        initiating_principal_id: None,
        root_turn_id: "root-conformance-delivery".to_string(),
        kind: ThreadKind::Delivery,
        executor_kind: "model".to_string(),
        executor_id: None,
        target_id: None,
        supervision: morphz::memory::ThreadSupervision::legacy(),
    };
    let kernel = SchedulerKernel::new(Arc::clone(&store) as Arc<dyn morphz::memory::RuntimeStore>);
    let delivery_command = morphz::controllers::DeliveryController::commit_delivery_outcome(
        &timer.id,
        timer.generation,
        delivery_event.clone(),
        Some(delivery_thread),
        "conformance-session",
        "Store-Conformance",
    );
    assert_eq!(
        match kernel.execute(delivery_command.clone()).await.unwrap() {
            KernelResult::DeliveryOutcomeCommitted(commit) => commit,
            result => panic!("unexpected Delivery Kernel result: {result:?}"),
        },
        DeliveryFlushCommit::Committed
    );
    assert_eq!(
        match kernel.execute(delivery_command).await.unwrap() {
            KernelResult::DeliveryOutcomeCommitted(commit) => commit,
            result => panic!("unexpected Delivery Kernel replay result: {result:?}"),
        },
        DeliveryFlushCommit::Existing {
            event_id: delivery_event.id.clone()
        }
    );
    assert_eq!(
        store
            .query(QueryFilter {
                event_id: Some(delivery_event.id),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1
    );
}

async fn assert_activation_store_conformance<S>(store: Arc<S>)
where
    S: ActivationStore
        + CognitiveClockStore
        + EventStore
        + ThreadGroupStore
        + ThreadStore
        + Send
        + Sync
        + 'static,
{
    let thread = store
        .ensure_thread(NewThread {
            id: "conformance-signal-thread".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            session_id: "conformance-session".to_string(),
            initiating_principal_id: None,
            root_turn_id: "root-conformance-signal-thread".to_string(),
            kind: ThreadKind::DialogueTurn,
            executor_kind: "model".to_string(),
            executor_id: None,
            target_id: None,
            supervision: morphz::memory::ThreadSupervision::legacy(),
        })
        .await
        .unwrap();
    let event = Event::new(
        "conformance-signal-event-a".to_string(),
        "user".to_string(),
        "user_message".to_string(),
        "chat/user".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    store
        .append_to_thread(event.clone(), &thread.id)
        .await
        .unwrap();
    let sequence = store
        .query(QueryFilter {
            event_id: Some(event.id.clone()),
            ..Default::default()
        })
        .await
        .unwrap()[0]
        .sequence
        .unwrap();
    let signal = NewThreadSignal {
        id: stable_thread_signal_id(&event.id),
        thread_id: thread.id.clone(),
        thread_generation: thread.generation,
        event_id: event.id.clone(),
        principal_id: None,
        sequence,
        kind: event.topic.clone(),
        parent_activation_id: None,
    };
    let activation = NewThreadActivation {
        id: "conformance-signal-activation-a".to_string(),
        agent_id: thread.agent_id.clone(),
        context_id: thread.context_id.clone(),
        session_id: thread.session_id.clone(),
        initiating_principal_id: None,
        trigger_event_id: event.id.clone(),
        trigger_sequence: sequence,
        trigger_kind: event.topic.clone(),
        parent_activation_id: None,
        root_turn_id: thread.root_turn_id.clone(),
    };
    let first = {
        let store = Arc::clone(&store);
        let signal = signal.clone();
        let activation = activation.clone();
        tokio::spawn(async move { store.claim_thread_signal_batch(signal, activation, 8).await })
    };
    let second = {
        let store = Arc::clone(&store);
        let signal = signal.clone();
        let activation = activation.clone();
        tokio::spawn(async move { store.claim_thread_signal_batch(signal, activation, 8).await })
    };
    let first = first.await.unwrap().unwrap().unwrap();
    let second = second.await.unwrap().unwrap().unwrap();
    assert_eq!(first.id, second.id);
    let clock = store
        .get_context_cognitive_clock("conformance-context")
        .await
        .unwrap();
    assert_eq!(
        clock.tick, 1,
        "one claimed external Signal batch advances once"
    );
    assert_eq!(
        clock.last_signal_batch_id.as_deref(),
        Some(first.id.as_str())
    );
    assert!(store
        .list_signal_outbox(SignalOutboxStatus::Pending, 16)
        .await
        .unwrap()
        .iter()
        .all(|outbox| outbox.event_id != event.id));
    assert_eq!(
        store
            .list_activation_signals(&first.id)
            .await
            .unwrap()
            .len(),
        1
    );
    let admission = store
        .list_queued_thread_activations_for_admission(8, 2, 60_000)
        .await
        .unwrap();
    assert!(admission.iter().any(|(record, class)| {
        record.id == first.id && *class == morphz::admission::AdmissionClass::InteractiveControl
    }));

    let first_revision = first.revision;
    let second_revision = second.revision;
    let first_update = {
        let store = Arc::clone(&store);
        let id = first.id.clone();
        tokio::spawn(async move {
            store
                .update_thread_activation(
                    &id,
                    first_revision,
                    ThreadActivationStatus::Running,
                    Some("worker-a"),
                    Some(chrono::Utc::now() + chrono::Duration::seconds(30)),
                    Some(1),
                )
                .await
        })
    };
    let second_update = {
        let store = Arc::clone(&store);
        let id = second.id.clone();
        tokio::spawn(async move {
            store
                .update_thread_activation(
                    &id,
                    second_revision,
                    ThreadActivationStatus::Running,
                    Some("worker-b"),
                    Some(chrono::Utc::now() + chrono::Duration::seconds(30)),
                    Some(1),
                )
                .await
        })
    };
    let updates = [
        first_update.await.unwrap().unwrap(),
        second_update.await.unwrap().unwrap(),
    ];
    assert_eq!(
        updates
            .iter()
            .filter(|mutation| matches!(mutation, ThreadActivationMutation::Updated(_)))
            .count(),
        1
    );
    assert_eq!(
        updates
            .iter()
            .filter(|mutation| matches!(mutation, ThreadActivationMutation::Conflict { .. }))
            .count(),
        1
    );

    let successor_thread = store
        .ensure_thread(NewThread {
            id: "conformance-dialogue-successor-thread".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            session_id: "conformance-session".to_string(),
            initiating_principal_id: None,
            root_turn_id: "root-conformance-dialogue-successor".to_string(),
            kind: ThreadKind::DialogueTurn,
            executor_kind: "model".to_string(),
            executor_id: None,
            target_id: None,
            supervision: morphz::memory::ThreadSupervision::legacy(),
        })
        .await
        .unwrap();
    let successor_event = Event::new(
        "conformance-dialogue-successor-event".to_string(),
        "user".to_string(),
        "user_message".to_string(),
        "chat/user".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    store
        .append_to_thread(successor_event.clone(), &successor_thread.id)
        .await
        .unwrap();
    let successor_sequence = store
        .query(QueryFilter {
            event_id: Some(successor_event.id.clone()),
            ..Default::default()
        })
        .await
        .unwrap()[0]
        .sequence
        .unwrap();
    let successor = store
        .claim_thread_signal_batch(
            NewThreadSignal {
                id: stable_thread_signal_id(&successor_event.id),
                thread_id: successor_thread.id.clone(),
                thread_generation: successor_thread.generation,
                event_id: successor_event.id.clone(),
                principal_id: None,
                sequence: successor_sequence,
                kind: successor_event.topic.clone(),
                parent_activation_id: None,
            },
            NewThreadActivation {
                id: "conformance-dialogue-successor-activation".to_string(),
                agent_id: successor_thread.agent_id.clone(),
                context_id: successor_thread.context_id.clone(),
                session_id: successor_thread.session_id.clone(),
                initiating_principal_id: None,
                trigger_event_id: successor_event.id.clone(),
                trigger_sequence: successor_sequence,
                trigger_kind: successor_event.topic.clone(),
                parent_activation_id: None,
                root_turn_id: successor_thread.root_turn_id.clone(),
            },
            8,
        )
        .await
        .unwrap()
        .unwrap();
    assert!(
        !store
            .dialogue_turn_activation_runnable(&successor.id)
            .await
            .unwrap(),
        "a running DialogueTurn must hold the durable Session lane"
    );
    assert!(store
        .release_dialogue_turn_activation(&first.id, chrono::Utc::now())
        .await
        .unwrap());
    assert!(
        !store
            .release_dialogue_turn_activation(&first.id, chrono::Utc::now())
            .await
            .unwrap(),
        "durable Dialogue lane release must be idempotent"
    );
    assert!(
        store
            .dialogue_turn_activation_runnable(&successor.id)
            .await
            .unwrap(),
        "the next DialogueTurn must become runnable while earlier physical work continues"
    );
    assert!(matches!(
        store
            .update_thread_activation(
                &successor.id,
                successor.revision,
                ThreadActivationStatus::Running,
                Some("successor-worker"),
                Some(chrono::Utc::now() + chrono::Duration::seconds(30)),
                Some(1),
            )
            .await
            .unwrap(),
        ThreadActivationMutation::Updated(_)
    ));

    let outcome_thread = store
        .ensure_thread(NewThread {
            id: "conformance-outcome-thread".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            session_id: "conformance-session".to_string(),
            initiating_principal_id: None,
            root_turn_id: "root-conformance-outcome-thread".to_string(),
            kind: ThreadKind::Execution,
            executor_kind: "runtime".to_string(),
            executor_id: None,
            target_id: None,
            supervision: morphz::memory::ThreadSupervision::legacy(),
        })
        .await
        .unwrap();
    let outcome_activation = store
        .ensure_thread_activation(NewThreadActivation {
            id: "conformance-outcome-activation".to_string(),
            agent_id: outcome_thread.agent_id.clone(),
            context_id: outcome_thread.context_id.clone(),
            session_id: outcome_thread.session_id.clone(),
            initiating_principal_id: None,
            trigger_event_id: "conformance-outcome-trigger".to_string(),
            trigger_sequence: 99,
            trigger_kind: "conformance".to_string(),
            parent_activation_id: None,
            root_turn_id: outcome_thread.root_turn_id.clone(),
        })
        .await
        .unwrap();
    let outcome_activation = match store
        .update_thread_activation(
            &outcome_activation.id,
            outcome_activation.revision,
            ThreadActivationStatus::Running,
            Some("conformance-worker"),
            Some(chrono::Utc::now() + chrono::Duration::seconds(30)),
            Some(1),
        )
        .await
        .unwrap()
    {
        ThreadActivationMutation::Updated(activation) => activation,
        mutation => panic!("outcome Activation must enter running before commit: {mutation:?}"),
    };
    let outcome_event = Event::new(
        "conformance-activation-outcome".to_string(),
        "Store-Conformance".to_string(),
        "agent_reply".to_string(),
        "runtime/thread_result".to_string(),
        json!({
            "context_id": outcome_thread.context_id,
            "session_id": outcome_thread.session_id,
            "thread_id": outcome_thread.id,
            "root_turn_id": outcome_thread.root_turn_id,
            "disposition": "deliver",
            "text": "outcome"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    assert_eq!(
        store
            .commit_activation_outcome(&outcome_activation.id, &outcome_event)
            .await
            .unwrap(),
        ActivationOutcomeCommit::Committed {
            ready_signal_event_ids: Vec::new()
        }
    );
    assert_eq!(
        store
            .commit_activation_outcome(&outcome_activation.id, &outcome_event)
            .await
            .unwrap(),
        ActivationOutcomeCommit::Existing {
            event_id: outcome_event.id.clone()
        }
    );
    let completed = store
        .get_thread("conformance-outcome-thread")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(completed.lifecycle, ThreadLifecycle::Completed);
    assert_eq!(completed.delivery_status, DeliveryStatus::Pending);
    let terminal_activation = store
        .get_thread_activation(&outcome_activation.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        terminal_activation.status,
        ThreadActivationStatus::Succeeded
    );
    assert!(terminal_activation.claimed_by.is_none());
    assert!(terminal_activation.lease_expires_at.is_none());

    // Operator control and a late physical result are allowed to race, but
    // they must still converge on exactly one authoritative terminal fact.
    // This fixture runs unchanged against SQLite and PostgreSQL so the two
    // backends cannot silently acquire different cancellation semantics.
    let race_thread = store
        .ensure_thread(NewThread {
            id: "conformance-control-outcome-race-thread".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            session_id: "conformance-session".to_string(),
            initiating_principal_id: None,
            root_turn_id: "root-conformance-control-outcome-race".to_string(),
            kind: ThreadKind::Execution,
            executor_kind: "runtime".to_string(),
            executor_id: None,
            target_id: None,
            supervision: morphz::memory::ThreadSupervision::legacy(),
        })
        .await
        .unwrap();
    let race_activation = store
        .ensure_thread_activation(NewThreadActivation {
            id: "conformance-control-outcome-race-activation".to_string(),
            agent_id: race_thread.agent_id.clone(),
            context_id: race_thread.context_id.clone(),
            session_id: race_thread.session_id.clone(),
            initiating_principal_id: None,
            trigger_event_id: "conformance-control-outcome-race-trigger".to_string(),
            trigger_sequence: 100,
            trigger_kind: "conformance".to_string(),
            parent_activation_id: None,
            root_turn_id: race_thread.root_turn_id.clone(),
        })
        .await
        .unwrap();
    let race_activation = match store
        .update_thread_activation(
            &race_activation.id,
            race_activation.revision,
            ThreadActivationStatus::Running,
            Some("conformance-race-worker"),
            Some(chrono::Utc::now() + chrono::Duration::seconds(30)),
            Some(1),
        )
        .await
        .unwrap()
    {
        ThreadActivationMutation::Updated(activation) => activation,
        mutation => panic!("race Activation must enter running: {mutation:?}"),
    };
    let race_outcome = Event::new(
        "conformance-control-outcome-race-result".to_string(),
        "Store-Conformance".to_string(),
        "agent_reply".to_string(),
        "runtime/thread_result".to_string(),
        json!({
            "context_id": race_thread.context_id,
            "session_id": race_thread.session_id,
            "thread_id": race_thread.id,
            "root_turn_id": race_thread.root_turn_id,
            "disposition": "deliver",
            "text": "late outcome"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    let control = {
        let store = Arc::clone(&store);
        let thread_id = race_thread.id.clone();
        tokio::spawn(async move {
            store
                .control_thread(
                    &thread_id,
                    race_thread.revision,
                    ThreadControlAction::Close,
                    Some("operator closes while result arrives"),
                    Some("Store-Conformance"),
                )
                .await
        })
    };
    let outcome = {
        let store = Arc::clone(&store);
        let activation_id = race_activation.id.clone();
        tokio::spawn(async move {
            store
                .commit_activation_outcome(&activation_id, &race_outcome)
                .await
        })
    };
    let control = control.await.unwrap().unwrap();
    let outcome = outcome.await.unwrap().unwrap();
    assert!(matches!(
        control,
        ThreadMutation::Updated(_) | ThreadMutation::Conflict { .. }
    ));
    assert!(matches!(
        outcome,
        ActivationOutcomeCommit::Committed { .. }
            | ActivationOutcomeCommit::Existing { .. }
            | ActivationOutcomeCommit::StaleGeneration
            | ActivationOutcomeCommit::StaleActivation
    ));
    let race_thread = store
        .get_thread("conformance-control-outcome-race-thread")
        .await
        .unwrap()
        .unwrap();
    assert!(race_thread.lifecycle.is_terminal());
    assert!(
        store
            .get_thread_outcome(&race_thread.id)
            .await
            .unwrap()
            .is_some(),
        "the winning transaction must leave one authoritative ThreadOutcome"
    );
    let race_activation = store
        .get_thread_activation("conformance-control-outcome-race-activation")
        .await
        .unwrap()
        .unwrap();
    assert!(race_activation.status.is_terminal());
    assert!(race_activation.claimed_by.is_none());
    assert!(race_activation.lease_expires_at.is_none());
}

async fn assert_scheduler_dependency_conformance<S>(store: Arc<S>)
where
    S: EventStore + SchedulerDependencyStore + Send + Sync + 'static,
{
    let dependency = NewSchedulerDependency {
        id: "conformance-scheduler-dependency".to_string(),
        owner_kind: SchedulerDependencyOwnerKind::Objective,
        owner_id: "conformance-objective".to_string(),
        owner_generation: 3,
        dependency_kind: SchedulerDependencyKind::ThreadGroup,
        dependency_id: "conformance-thread-group".to_string(),
        dependency_generation: 7,
        required: true,
        metadata: json!({"route": "conformance"}),
    };
    assert!(matches!(
        store
            .register_scheduler_dependency(dependency.clone())
            .await
            .unwrap(),
        SchedulerDependencyMutation::Updated(_)
    ));
    assert!(matches!(
        store
            .register_scheduler_dependency(dependency.clone())
            .await
            .unwrap(),
        SchedulerDependencyMutation::Existing(_)
    ));

    let mut conflicting = dependency.clone();
    conflicting.metadata = json!({"route": "different"});
    assert!(matches!(
        store
            .register_scheduler_dependency(conflicting)
            .await
            .unwrap(),
        SchedulerDependencyMutation::Conflict { .. }
    ));
    assert!(matches!(
        store
            .satisfy_scheduler_dependency(&dependency.id, 2, 7, "wrong-owner-generation")
            .await
            .unwrap(),
        SchedulerDependencyMutation::Conflict { .. }
    ));
    assert!(matches!(
        store
            .satisfy_scheduler_dependency(&dependency.id, 3, 6, "wrong-fact-generation")
            .await
            .unwrap(),
        SchedulerDependencyMutation::Conflict { .. }
    ));
    store
        .append(Event::new(
            "dependency-satisfied".to_string(),
            "Store-Conformance".to_string(),
            "scheduler_fact".to_string(),
            "runtime/dependency_satisfied".to_string(),
            json!({
                "context_id": "conformance-context",
                "session_id": "conformance-session"
            })
            .as_object()
            .unwrap()
            .clone(),
        ))
        .await
        .unwrap();
    assert!(matches!(
        store
            .satisfy_scheduler_dependency(&dependency.id, 3, 7, "dependency-satisfied")
            .await
            .unwrap(),
        SchedulerDependencyMutation::Updated(_)
    ));
    assert!(matches!(
        store
            .satisfy_scheduler_dependency(&dependency.id, 3, 7, "dependency-satisfied")
            .await
            .unwrap(),
        SchedulerDependencyMutation::Existing(_)
    ));
    let satisfied = store
        .list_scheduler_dependencies(SchedulerDependencyFilter {
            owner_kind: Some(SchedulerDependencyOwnerKind::Objective),
            owner_id: Some(dependency.owner_id.clone()),
            status: Some(SchedulerDependencyStatus::Satisfied),
            required_only: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(satisfied.len(), 1);
    assert_eq!(
        satisfied[0].satisfied_by_event_id.as_deref(),
        Some("dependency-satisfied")
    );

    let cancellable = NewSchedulerDependency {
        id: "conformance-scheduler-dependency-cancel".to_string(),
        dependency_id: "conformance-resource".to_string(),
        dependency_kind: SchedulerDependencyKind::Resource,
        ..dependency
    };
    store
        .register_scheduler_dependency(cancellable.clone())
        .await
        .unwrap();
    assert_eq!(
        store
            .cancel_scheduler_dependencies(
                SchedulerDependencyOwnerKind::Objective,
                &cancellable.owner_id,
                cancellable.owner_generation,
            )
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .get_scheduler_dependency(&cancellable.id)
            .await
            .unwrap()
            .unwrap()
            .status,
        SchedulerDependencyStatus::Cancelled
    );
}

async fn assert_schedule_store_conformance<S>(store: Arc<S>)
where
    S: ScheduleStore + ThreadStore + EventStore + Send + Sync + 'static,
{
    for (id, kind) in [
        ("conformance-schedule-thread", ThreadKind::Execution),
        ("conformance-dependency-thread", ThreadKind::Execution),
        ("conformance-dispatch-thread", ThreadKind::Execution),
    ] {
        store
            .ensure_thread(NewThread {
                id: id.to_string(),
                agent_id: "conformance-agent".to_string(),
                context_id: "conformance-context".to_string(),
                session_id: "conformance-session".to_string(),
                initiating_principal_id: None,
                root_turn_id: format!("root-{id}"),
                kind,
                executor_kind: "runtime".to_string(),
                executor_id: None,
                target_id: None,
                supervision: morphz::memory::ThreadSupervision::legacy(),
            })
            .await
            .unwrap();
    }

    let controlled = store
        .ensure_schedule(morphz::memory::NewSchedule {
            id: "conformance-schedule-control".to_string(),
            thread_id: "conformance-schedule-thread".to_string(),
            source_turn_id: "root-conformance-schedule-thread".to_string(),
            intent: "control-plane conformance".to_string(),
            not_before: Some(chrono::Utc::now() + chrono::Duration::hours(1)),
            interval_seconds: None,
            dependency_thread_ids: vec!["conformance-dependency-thread".to_string()],
        })
        .await
        .unwrap();
    let first_pause = {
        let store = Arc::clone(&store);
        tokio::spawn(async move {
            store
                .pause_schedule("conformance-schedule-control", controlled.revision)
                .await
        })
    };
    let second_pause = {
        let store = Arc::clone(&store);
        tokio::spawn(async move {
            store
                .pause_schedule("conformance-schedule-control", controlled.revision)
                .await
        })
    };
    let mutations = [
        first_pause.await.unwrap().unwrap(),
        second_pause.await.unwrap().unwrap(),
    ];
    assert_eq!(
        mutations
            .iter()
            .filter(|mutation| matches!(mutation, ScheduleMutation::Updated(_)))
            .count(),
        1
    );
    assert_eq!(
        mutations
            .iter()
            .filter(|mutation| matches!(mutation, ScheduleMutation::Conflict { .. }))
            .count(),
        1
    );
    let paused = mutations
        .into_iter()
        .find_map(|mutation| match mutation {
            ScheduleMutation::Updated(schedule) => Some(schedule),
            _ => None,
        })
        .unwrap();
    let resumed = match store
        .resume_schedule(&paused.id, paused.revision)
        .await
        .unwrap()
    {
        ScheduleMutation::Updated(schedule) => schedule,
        mutation => panic!("unexpected resume mutation: {mutation:?}"),
    };
    let rescheduled = match store
        .reschedule_schedule(
            &resumed.id,
            resumed.revision,
            Some(chrono::Utc::now() + chrono::Duration::hours(2)),
            Some(120),
        )
        .await
        .unwrap()
    {
        ScheduleMutation::Updated(schedule) => schedule,
        mutation => panic!("unexpected reschedule mutation: {mutation:?}"),
    };
    assert_eq!(rescheduled.interval_seconds, Some(120));
    assert!(matches!(
        store
            .cancel_schedule(&rescheduled.id, rescheduled.revision)
            .await
            .unwrap(),
        ScheduleMutation::Updated(schedule) if schedule.status == ScheduleStatus::Cancelled
    ));

    let dependency_schedule = store
        .ensure_schedule(morphz::memory::NewSchedule {
            id: "conformance-schedule-dependency".to_string(),
            thread_id: "conformance-schedule-thread".to_string(),
            source_turn_id: "root-conformance-schedule-thread".to_string(),
            intent: "wake after dependency".to_string(),
            not_before: None,
            interval_seconds: None,
            dependency_thread_ids: vec!["conformance-dependency-thread".to_string()],
        })
        .await
        .unwrap();
    let woken = store
        .wake_schedules_for_dependency("conformance-dependency-thread")
        .await
        .unwrap();
    assert!(woken.iter().any(|schedule| {
        schedule.id == dependency_schedule.id && schedule.revision > dependency_schedule.revision
    }));

    let dispatch = store
        .ensure_schedule(morphz::memory::NewSchedule {
            id: "conformance-schedule-dispatch".to_string(),
            thread_id: "conformance-dispatch-thread".to_string(),
            source_turn_id: "root-conformance-dispatch-thread".to_string(),
            intent: "dispatch once".to_string(),
            not_before: None,
            interval_seconds: None,
            dependency_thread_ids: Vec::new(),
        })
        .await
        .unwrap();
    let dispatch_event = Event::new(
        "conformance-schedule-due-event".to_string(),
        "Store-Conformance".to_string(),
        "runtime_control".to_string(),
        "chat/schedule_due".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session",
            "schedule_id": dispatch.id
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    let first_dispatch = {
        let store = Arc::clone(&store);
        let event = dispatch_event.clone();
        tokio::spawn(async move {
            store
                .commit_scheduled_dispatch(
                    "conformance-schedule-dispatch",
                    dispatch.revision,
                    None,
                    &event,
                )
                .await
        })
    };
    let second_dispatch = {
        let store = Arc::clone(&store);
        let event = dispatch_event.clone();
        tokio::spawn(async move {
            store
                .commit_scheduled_dispatch(
                    "conformance-schedule-dispatch",
                    dispatch.revision,
                    None,
                    &event,
                )
                .await
        })
    };
    let dispatches = [
        first_dispatch.await.unwrap().unwrap(),
        second_dispatch.await.unwrap().unwrap(),
    ];
    assert_eq!(dispatches.iter().filter(|value| value.is_some()).count(), 1);
    assert_eq!(
        store
            .query(QueryFilter {
                event_id: Some(dispatch_event.id.clone()),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1
    );

    let failed = store
        .commit_schedule_transaction(
            &[],
            &[],
            &[NewThread {
                id: "conformance-schedule-rolled-back-thread".to_string(),
                agent_id: "conformance-agent".to_string(),
                context_id: "conformance-context".to_string(),
                session_id: "conformance-session".to_string(),
                initiating_principal_id: None,
                root_turn_id: "root-conformance-schedule-rolled-back".to_string(),
                kind: ThreadKind::Execution,
                executor_kind: "runtime".to_string(),
                executor_id: None,
                target_id: None,
                supervision: morphz::memory::ThreadSupervision::legacy(),
            }],
            &[morphz::memory::NewSchedule {
                id: "conformance-invalid-schedule".to_string(),
                thread_id: "missing-conformance-thread".to_string(),
                source_turn_id: "missing-root".to_string(),
                intent: "must roll back".to_string(),
                not_before: None,
                interval_seconds: None,
                dependency_thread_ids: Vec::new(),
            }],
            &[],
        )
        .await;
    assert!(failed.is_err());
    assert!(store
        .get_thread("conformance-schedule-rolled-back-thread")
        .await
        .unwrap()
        .is_none());
    assert!(store
        .list_context_schedules("conformance-context")
        .await
        .unwrap()
        .iter()
        .any(|schedule| schedule.id == "conformance-schedule-dispatch"));
}

async fn assert_delivery_ingress_conformance<S>(store: Arc<S>)
where
    S: DeliveryIngressStore
        + EventStore
        + SessionDirectoryStore
        + SessionProjectionStore
        + ThreadStore
        + Send
        + Sync
        + 'static,
{
    let session = store
        .get_session("conformance-session")
        .await
        .unwrap()
        .unwrap();
    if session.attention_state != SessionAttentionState::Retired {
        store
            .update_session_attention(SessionAttentionUpdate {
                session_id: session.id.clone(),
                context_id: session.context_id.clone(),
                expected_revision: session.attention_revision,
                state: SessionAttentionState::Retired,
                reason: Some("delivery ingress conformance".to_string()),
                changed_at: chrono::Utc::now(),
                event_id: "conformance-ingress-retire".to_string(),
            })
            .await
            .unwrap()
            .unwrap();
    }

    let message = Event::new(
        "conformance-ingress-message".to_string(),
        "user".to_string(),
        "user_message".to_string(),
        "chat/user".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session",
            "text": "hello"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    let first_claim = {
        let store = Arc::clone(&store);
        let event = message.clone();
        tokio::spawn(async move {
            store
                .claim_message("conformance-session", "client-message-a", &event)
                .await
        })
    };
    let second_claim = {
        let store = Arc::clone(&store);
        let event = message.clone();
        tokio::spawn(async move {
            store
                .claim_message("conformance-session", "client-message-a", &event)
                .await
        })
    };
    let claims = [
        first_claim.await.unwrap().unwrap(),
        second_claim.await.unwrap().unwrap(),
    ];
    assert_eq!(
        claims
            .iter()
            .filter(|claim| matches!(claim, MessageClaim::Accepted))
            .count(),
        1
    );
    assert_eq!(
        claims
            .iter()
            .filter(|claim| matches!(claim, MessageClaim::Existing { event_id } if event_id == &message.id))
            .count(),
        1
    );
    assert_eq!(
        store
            .query(QueryFilter {
                event_id: Some(message.id.clone()),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store
            .query_session_projections(
                "conformance-context",
                &["conformance-session".to_string()],
                true,
            )
            .await
            .unwrap()
            .iter()
            .filter(|event| event.id == message.id)
            .count(),
        1,
        "accepted client message must enter Session Projection atomically",
    );
    let restored = store
        .get_session("conformance-session")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(restored.attention_state, SessionAttentionState::Active);
    assert_eq!(
        store
            .query(QueryFilter {
                event_id: Some(format!("runtime_session_restored_{}", message.id)),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1
    );

    let delivery_thread = store
        .ensure_thread(NewThread {
            id: "conformance-ingress-delivery-thread".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            session_id: "conformance-session".to_string(),
            initiating_principal_id: None,
            root_turn_id: "root-conformance-ingress-delivery".to_string(),
            kind: ThreadKind::Delivery,
            executor_kind: "runtime".to_string(),
            executor_id: None,
            target_id: None,
            supervision: morphz::memory::ThreadSupervision::legacy(),
        })
        .await
        .unwrap();
    let pending = match store
        .update_thread(
            &delivery_thread.id,
            delivery_thread.revision,
            None,
            Some(ThreadLifecycle::Completed),
            Some("delivered once"),
            Some("conformance-ingress-result"),
            Some(DeliveryStatus::Pending),
            None,
        )
        .await
        .unwrap()
    {
        ThreadMutation::Updated(thread) => thread,
        mutation => panic!("unexpected pending delivery mutation: {mutation:?}"),
    };
    let delivery = Event::new(
        "conformance-ingress-delivery".to_string(),
        "Store-Conformance".to_string(),
        "agent_reply".to_string(),
        "chat/assistant".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session",
            "text": "delivered once"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    let thread_ids = vec![pending.id.clone()];
    let first_delivery = {
        let store = Arc::clone(&store);
        let event = delivery.clone();
        let ids = thread_ids.clone();
        tokio::spawn(async move { store.commit_thread_delivery(&ids, &event).await })
    };
    let second_delivery = {
        let store = Arc::clone(&store);
        let event = delivery.clone();
        let ids = thread_ids.clone();
        tokio::spawn(async move { store.commit_thread_delivery(&ids, &event).await })
    };
    let deliveries = [
        first_delivery.await.unwrap().unwrap(),
        second_delivery.await.unwrap().unwrap(),
    ];
    assert_eq!(deliveries.iter().filter(|delivered| **delivered).count(), 1);
    let delivered = store.get_thread(&pending.id).await.unwrap().unwrap();
    assert_eq!(delivered.delivery_status, DeliveryStatus::Delivered);
    assert_eq!(
        delivered.delivery_event_id.as_deref(),
        Some(delivery.id.as_str())
    );
}

async fn assert_delegation_store_conformance<S>(store: Arc<S>)
where
    S: DelegationStore + EventStore + SessionDirectoryStore + Send + Sync + 'static,
{
    let child = store
        .create_session(NewSession {
            id: "conformance-delegation-child-session".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-other-context".to_string(),
            parent_session_id: None,
            title: "Delegation Child".to_string(),
            mount_kind: SessionMountKind::NewBlankContext,
        })
        .await
        .unwrap();
    let created = store
        .create_delegation(NewDelegation {
            id: "conformance-delegation".to_string(),
            agent_id: "conformance-agent".to_string(),
            parent_context_id: "conformance-context".to_string(),
            parent_session_id: "conformance-session".to_string(),
            child_context_id: child.context_id.clone(),
            child_session_id: child.id.clone(),
            initiating_principal_id: None,
            task: "perform delegated conformance work".to_string(),
            success_when: Some("result reaches parent exactly once".to_string()),
            context_scope: "child_session_only".to_string(),
        })
        .await
        .unwrap();
    assert_eq!(created.status, DelegationStatus::Queued);
    assert_eq!(
        store
            .get_delegation_by_child_session(&child.id)
            .await
            .unwrap()
            .unwrap()
            .id,
        created.id
    );
    assert!(store
        .list_delegations()
        .await
        .unwrap()
        .iter()
        .any(|delegation| delegation.id == created.id));
    let running = store
        .update_delegation_status(&created.id, DelegationStatus::Running, None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(running.status, DelegationStatus::Running);

    let wrong_route = Event::new(
        "conformance-delegation-wrong-route".to_string(),
        "Store-Conformance".to_string(),
        "delegation_result".to_string(),
        "runtime/delegation_result".to_string(),
        json!({
            "context_id": "conformance-other-context",
            "session_id": child.id,
            "delegation_id": running.id
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    assert!(store
        .commit_delegation_result(&running.id, &wrong_route)
        .await
        .is_err());
    assert_eq!(
        store
            .get_delegation(&running.id)
            .await
            .unwrap()
            .unwrap()
            .status,
        DelegationStatus::Running,
        "route validation failure must roll back the lifecycle update"
    );

    let result = Event::new(
        "conformance-delegation-result".to_string(),
        "Store-Conformance".to_string(),
        "delegation_result".to_string(),
        "runtime/delegation_result".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session",
            "delegation_id": running.id,
            "text": "delegated result"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    let first = {
        let store = Arc::clone(&store);
        let event = result.clone();
        let id = running.id.clone();
        tokio::spawn(async move { store.commit_delegation_result(&id, &event).await })
    };
    let second = {
        let store = Arc::clone(&store);
        let event = result.clone();
        let id = running.id.clone();
        tokio::spawn(async move { store.commit_delegation_result(&id, &event).await })
    };
    let commits = [
        first.await.unwrap().unwrap(),
        second.await.unwrap().unwrap(),
    ];
    assert_eq!(commits.iter().filter(|committed| **committed).count(), 1);
    let completed = store.get_delegation(&running.id).await.unwrap().unwrap();
    assert_eq!(completed.status, DelegationStatus::Completed);
    assert_eq!(
        completed.result_event_id.as_deref(),
        Some(result.id.as_str())
    );
    assert_eq!(
        store
            .query(QueryFilter {
                event_id: Some(result.id),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1
    );
}

/// Database-independent contract for the Context transaction boundary. A new
/// service Store must pass this exact suite before it can be selected by the
/// Runtime configuration.
async fn assert_context_transaction_conformance<S, F>(store: Arc<S>, read_attention: F)
where
    S: EventStore + MindProjectionStore + Send + Sync + 'static,
    F: for<'a> Fn(&'a S, &'a str) -> AttentionFuture<'a>,
{
    let context_id = "conformance-context";
    let session_id = "conformance-session";
    let initial = store
        .initialize_mind_projection(NewMindProjection {
            context_id: context_id.to_string(),
            revision: 0,
            state: json!({"version": 0, "frames": []}),
            state_hash: "hash-0".to_string(),
            head_event_id: None,
            recall_documents: Vec::new(),
        })
        .await
        .unwrap();
    assert_eq!(initial.revision, 0);

    let first_event = context_event("conformance-tx-a", context_id);
    let second_event = context_event("conformance-tx-b", context_id);
    let first = {
        let store = Arc::clone(&store);
        let event = first_event.clone();
        tokio::spawn(async move {
            store
                .commit_mind_projection_transaction(
                    &event,
                    &[SessionAttentionUpdate {
                        session_id: session_id.to_string(),
                        context_id: context_id.to_string(),
                        expected_revision: 0,
                        state: SessionAttentionState::Retired,
                        reason: Some("conformance".to_string()),
                        changed_at: chrono::Utc::now(),
                        event_id: event.id.clone(),
                    }],
                    &SessionProjectionMutation::default(),
                    0,
                    NewMindProjection {
                        context_id: context_id.to_string(),
                        revision: 1,
                        state: json!({"version": 1, "winner": "a"}),
                        state_hash: "hash-a".to_string(),
                        head_event_id: Some(event.id.clone()),
                        recall_documents: Vec::new(),
                    },
                )
                .await
        })
    };
    let second = {
        let store = Arc::clone(&store);
        let event = second_event.clone();
        tokio::spawn(async move {
            store
                .commit_mind_projection_transaction(
                    &event,
                    &[SessionAttentionUpdate {
                        session_id: session_id.to_string(),
                        context_id: context_id.to_string(),
                        expected_revision: 0,
                        state: SessionAttentionState::Active,
                        reason: Some("conformance".to_string()),
                        changed_at: chrono::Utc::now(),
                        event_id: event.id.clone(),
                    }],
                    &SessionProjectionMutation::default(),
                    0,
                    NewMindProjection {
                        context_id: context_id.to_string(),
                        revision: 1,
                        state: json!({"version": 1, "winner": "b"}),
                        state_hash: "hash-b".to_string(),
                        head_event_id: Some(event.id.clone()),
                        recall_documents: Vec::new(),
                    },
                )
                .await
        })
    };
    let first = first.await.unwrap().unwrap();
    let second = second.await.unwrap().unwrap();
    assert_eq!(
        [first.clone(), second.clone()]
            .into_iter()
            .filter(|result| matches!(result, MindProjectionCommit::Committed { .. }))
            .count(),
        1,
        "exactly one same-revision writer must commit"
    );
    assert_eq!(
        [first, second]
            .into_iter()
            .filter(|result| matches!(result, MindProjectionCommit::Conflict { .. }))
            .count(),
        1,
        "the competing writer must observe a typed conflict"
    );

    let projection = store
        .get_mind_projection(context_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(projection.revision, 1);
    let committed_events = store
        .query(QueryFilter {
            context_id: Some(context_id.to_string()),
            topic: Some("chat/context_tx_committed".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(committed_events.len(), 1);
    assert_eq!(
        projection.head_event_id.as_deref(),
        Some(committed_events[0].id.as_str())
    );

    let (_, attention_revision, attention_event_id) =
        read_attention(&store, session_id).await.unwrap().unwrap();
    assert_eq!(attention_revision, 1);
    assert_eq!(attention_event_id, projection.head_event_id);

    let duplicate_a = Event::new(
        "conformance-batch-duplicate".to_string(),
        "Store-Conformance".to_string(),
        "audit".to_string(),
        "runtime/conformance".to_string(),
        json!({"value": "a"}).as_object().unwrap().clone(),
    );
    let mut duplicate_b = duplicate_a.clone();
    duplicate_b.payload = json!({"value": "b"}).as_object().unwrap().clone();
    assert!(store
        .append_batch(vec![
            EventAppend {
                event: duplicate_a.clone(),
            },
            EventAppend { event: duplicate_b },
        ])
        .await
        .is_err());
    assert!(store
        .query(QueryFilter {
            event_id: Some(duplicate_a.id),
            ..Default::default()
        })
        .await
        .unwrap()
        .is_empty());
}

/// The online Session Projection is a current active-observation set, not a
/// second history log. Ledger append and Projection insertion are atomic;
/// retire/restore follow the Context transaction CAS order. Re-appending an
/// already persisted Event is idempotent and must not accidentally restore it.
async fn assert_session_projection_conformance<S>(store: Arc<S>)
where
    S: EventStore + MindProjectionStore + SessionProjectionStore + Send + Sync + 'static,
{
    let context_id = "conformance-context";
    let session_id = "conformance-session";
    let selected = vec![session_id.to_string()];
    let observation = Event::new(
        "conformance-session-observation".to_string(),
        "Store-Conformance".to_string(),
        morphz::event::TYPE_USER_MESSAGE.to_string(),
        "chat/user_message".to_string(),
        json!({
            "context_id": context_id,
            "session_id": session_id,
            "text": "projection conformance"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    store.append(observation.clone()).await.unwrap();
    assert_eq!(
        store
            .query_session_projections(context_id, &selected, true)
            .await
            .unwrap()
            .iter()
            .filter(|event| event.id == observation.id)
            .count(),
        1
    );

    let current = store
        .get_mind_projection(context_id)
        .await
        .unwrap()
        .unwrap();
    let retire_event = context_event("conformance-projection-retire", context_id);
    let retired = store
        .commit_mind_projection_transaction(
            &retire_event,
            &[],
            &SessionProjectionMutation {
                retired_event_ids: vec![observation.id.clone()],
                restored_event_ids: Vec::new(),
            },
            current.revision,
            NewMindProjection {
                context_id: context_id.to_string(),
                revision: current.revision + 1,
                state: json!({"version": current.revision + 1, "projection": "retired"}),
                state_hash: "conformance-projection-retired-hash".to_string(),
                head_event_id: Some(retire_event.id.clone()),
                recall_documents: Vec::new(),
            },
        )
        .await
        .unwrap();
    assert!(matches!(retired, MindProjectionCommit::Committed { .. }));
    assert!(store
        .query_session_projections(context_id, &selected, true)
        .await
        .unwrap()
        .iter()
        .all(|event| event.id != observation.id));

    store.append(observation.clone()).await.unwrap();
    assert!(store
        .query_session_projections(context_id, &selected, true)
        .await
        .unwrap()
        .iter()
        .all(|event| event.id != observation.id));

    let current = store
        .get_mind_projection(context_id)
        .await
        .unwrap()
        .unwrap();
    let restore_event = context_event("conformance-projection-restore", context_id);
    let restored = store
        .commit_mind_projection_transaction(
            &restore_event,
            &[],
            &SessionProjectionMutation {
                retired_event_ids: Vec::new(),
                restored_event_ids: vec![observation.id.clone()],
            },
            current.revision,
            NewMindProjection {
                context_id: context_id.to_string(),
                revision: current.revision + 1,
                state: json!({"version": current.revision + 1, "projection": "restored"}),
                state_hash: "conformance-projection-restored-hash".to_string(),
                head_event_id: Some(restore_event.id.clone()),
                recall_documents: Vec::new(),
            },
        )
        .await
        .unwrap();
    assert!(matches!(restored, MindProjectionCommit::Committed { .. }));
    assert_eq!(
        store
            .query_session_projections(context_id, &selected, true)
            .await
            .unwrap()
            .iter()
            .filter(|event| event.id == observation.id)
            .count(),
        1
    );
}

async fn assert_recall_projection_conformance<S>(store: Arc<S>)
where
    S: EventStore + RecallProjectionStore + Send + Sync + 'static,
{
    let context_id = "conformance-context";
    let long_chunks = morphz::memory::segment_recall_chunks(&format!(
        "{} 终点火炬只存在于旧上限之后",
        "普通历史内容 ".repeat(5_000)
    ));
    let documents = vec![
        RecallDocument {
            context_id: context_id.to_string(),
            document_kind: RecallDocumentKind::Frame,
            document_id: "memory/sandbox-permission".to_string(),
            revision: 3,
            searchable_text: morphz::memory::segment_recall_text(
                "memory/sandbox-permission 沙箱权限审批 Rust 沙箱",
            ),
            searchable_chunks: Vec::new(),
            preview: "沙箱权限审批应区分拒绝与可申请的能力扩张".to_string(),
            retired: true,
            updated_sequence: 20,
            state_hash: "recall-frame-hash".to_string(),
        },
        RecallDocument {
            context_id: context_id.to_string(),
            document_kind: RecallDocumentKind::Frame,
            document_id: "memory/related-case".to_string(),
            revision: 1,
            searchable_text: morphz::memory::segment_recall_text(
                "related case memory/sandbox-permission 后续案例",
            ),
            searchable_chunks: Vec::new(),
            preview: "后续案例".to_string(),
            retired: false,
            updated_sequence: 30,
            state_hash: "recall-related-hash".to_string(),
        },
        RecallDocument {
            context_id: context_id.to_string(),
            document_kind: RecallDocumentKind::Event,
            document_id: "recall-event".to_string(),
            revision: 0,
            searchable_text: morphz::memory::segment_recall_text("全角ＡＢＣ 与中文阳光电源"),
            searchable_chunks: Vec::new(),
            preview: "全角ＡＢＣ 与中文阳光电源".to_string(),
            retired: false,
            updated_sequence: 10,
            state_hash: "recall-event-hash".to_string(),
        },
        RecallDocument {
            context_id: context_id.to_string(),
            document_kind: RecallDocumentKind::Event,
            document_id: "recall-long-event".to_string(),
            revision: 0,
            searchable_text: long_chunks.first().cloned().unwrap(),
            searchable_chunks: long_chunks,
            preview: "普通历史内容".to_string(),
            retired: false,
            updated_sequence: 40,
            state_hash: "recall-long-event-hash".to_string(),
        },
        RecallDocument {
            context_id: context_id.to_string(),
            document_kind: RecallDocumentKind::Event,
            document_id: "recall-many-matching-chunks".to_string(),
            revision: 0,
            searchable_text: "共享 标记 chunk0".to_string(),
            searchable_chunks: (0..80)
                .map(|index| format!("共享 标记 chunk{index}"))
                .collect(),
            preview: "一个拥有许多匹配分块的文档".to_string(),
            retired: false,
            updated_sequence: 50,
            state_hash: "recall-many-matching-chunks-hash".to_string(),
        },
        RecallDocument {
            context_id: context_id.to_string(),
            document_kind: RecallDocumentKind::Event,
            document_id: "recall-second-shared-result".to_string(),
            revision: 0,
            searchable_text: "共享 标记 second".to_string(),
            searchable_chunks: Vec::new(),
            preview: "不能被前一个长文档的物理分块挤掉".to_string(),
            retired: false,
            updated_sequence: 45,
            state_hash: "recall-second-shared-result-hash".to_string(),
        },
    ];
    let audit = store
        .replace_recall_documents(context_id, &documents)
        .await
        .unwrap();
    assert_eq!(audit.frame_documents, 2);
    assert_eq!(audit.event_documents, 4);
    assert_eq!(audit.capability.unicode_normalization, "nfkc+lowercase");

    let chinese = store
        .search_recall_documents(
            context_id,
            &morphz::memory::normalize_recall_text("沙箱权限审批"),
            8,
        )
        .await
        .unwrap();
    assert_eq!(chinese[0].document_id, "memory/sandbox-permission");
    assert!(
        chinese[0].retired,
        "retired Frames remain lexically recallable"
    );

    let nfkc = store
        .search_recall_documents(context_id, &morphz::memory::normalize_recall_text("abc"), 8)
        .await
        .unwrap();
    assert!(nfkc.iter().any(|hit| hit.document_id == "recall-event"));

    let suffix = store
        .search_recall_documents(context_id, "终点火炬", 8)
        .await
        .unwrap();
    assert!(suffix
        .iter()
        .any(|hit| hit.document_id == "recall-long-event"));

    let logical_results = store
        .search_recall_documents(context_id, "共享标记", 2)
        .await
        .unwrap();
    assert_eq!(logical_results.len(), 2);
    assert!(logical_results
        .iter()
        .any(|hit| hit.document_id == "recall-many-matching-chunks"));
    assert!(logical_results
        .iter()
        .any(|hit| hit.document_id == "recall-second-shared-result"));

    let exact = store
        .search_recall_documents(
            context_id,
            &morphz::memory::normalize_recall_text("memory/sandbox-permission"),
            1,
        )
        .await
        .unwrap();
    assert_eq!(
        exact.len(),
        1,
        "the database must apply the requested limit"
    );
    assert_eq!(exact[0].document_id, "memory/sandbox-permission");

    // Both backends segment before indexing, so a two-character Chinese word —
    // the most common word form in the language — is an ordinary indexed term
    // on either store rather than a query that silently returns nothing.
    let short = store
        .search_recall_documents(
            context_id,
            &morphz::memory::normalize_recall_text("权限"),
            8,
        )
        .await
        .unwrap();
    assert!(
        short
            .iter()
            .any(|hit| hit.document_id == "memory/sandbox-permission"),
        "two-character Chinese query must stay searchable: {short:?}"
    );

    // A quoted query is the Agent's opt-in narrowing: it requires adjacency,
    // so terms that never neighbour each other stop matching.
    let phrase_miss = store
        .search_recall_documents(context_id, "\"权限 全角\"", 8)
        .await
        .unwrap();
    assert!(
        phrase_miss.is_empty(),
        "phrase query must require adjacency: {phrase_miss:?}"
    );

    let capability = store.recall_index_capability().await.unwrap();
    assert_eq!(
        capability.segmenter,
        morphz::memory::RECALL_SEGMENTER,
        "stored terms are only comparable against queries from the same segmenter"
    );

    for (index, timestamp) in ["2026-08-04T10:00:00Z", "2026-08-04T11:00:00Z"]
        .into_iter()
        .enumerate()
    {
        let mut event = Event::new(
            format!("recall-time-conformance-{index}"),
            "User".to_string(),
            morphz::event::TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            serde_json::json!({
                "context_id": context_id,
                "session_id": "conformance-session",
                "text": format!("时间窗口证据 {index}"),
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        event.timestamp = chrono::DateTime::parse_from_rfc3339(timestamp)
            .unwrap()
            .with_timezone(&chrono::Utc);
        store.append(event).await.unwrap();
    }
    let projected = store
        .project_recall_outbox_batch("recall-conformance-worker", 8)
        .await
        .unwrap();
    assert_eq!(projected.projected, 2);
    let start_time = chrono::DateTime::parse_from_rfc3339("2026-08-04T10:30:00Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    let end_time = chrono::DateTime::parse_from_rfc3339("2026-08-04T12:00:00Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    let timeline = store
        .query_recall_documents(morphz::memory::RecallDocumentSearchRequest {
            context_id: context_id.to_string(),
            normalized_query: None,
            start_time: Some(start_time),
            end_time: Some(end_time),
            before_sequence: None,
            limit: 1,
        })
        .await
        .unwrap();
    assert_eq!(timeline[0].document_id, "recall-time-conformance-1");
    let combined = store
        .query_recall_documents(morphz::memory::RecallDocumentSearchRequest {
            context_id: context_id.to_string(),
            normalized_query: Some("时间窗口".to_string()),
            start_time: None,
            end_time: Some(
                chrono::DateTime::parse_from_rfc3339("2026-08-04T11:00:00Z")
                    .unwrap()
                    .with_timezone(&chrono::Utc),
            ),
            before_sequence: None,
            limit: 8,
        })
        .await
        .unwrap();
    assert_eq!(combined.len(), 1);
    assert_eq!(combined[0].document_id, "recall-time-conformance-0");
}

async fn assert_timer_lease_conformance<S>(store: Arc<S>)
where
    S: TimerStore + Send + Sync + 'static,
{
    let due_at = chrono::Utc::now() - chrono::Duration::seconds(1);
    for index in 0..4 {
        store
            .upsert_runtime_timer(NewRuntimeTimer {
                id: format!("conformance-timer-{index}"),
                generation: 1,
                kind: RuntimeTimerKind::ActivationLease,
                owner_id: format!("activation-{index}"),
                due_at,
                payload: json!({"index": index}),
            })
            .await
            .unwrap();
    }
    let expires = chrono::Utc::now() + chrono::Duration::seconds(30);
    let first = {
        let store = Arc::clone(&store);
        tokio::spawn(async move {
            store
                .claim_due_runtime_timers(chrono::Utc::now(), "worker-a", expires, 4)
                .await
        })
    };
    let second = {
        let store = Arc::clone(&store);
        tokio::spawn(async move {
            store
                .claim_due_runtime_timers(chrono::Utc::now(), "worker-b", expires, 4)
                .await
        })
    };
    let first = first.await.unwrap().unwrap();
    let second = second.await.unwrap().unwrap();
    let mut claimed = first
        .iter()
        .chain(&second)
        .map(|timer| timer.id.clone())
        .collect::<Vec<_>>();
    claimed.sort();
    claimed.dedup();
    assert_eq!(claimed.len(), 4, "every due timer must be claimed once");
    assert_eq!(first.len() + second.len(), 4, "workers must not overlap");

    for timer in first.iter().chain(&second) {
        assert!(!store
            .complete_runtime_timer(&timer.id, timer.generation, "wrong-worker")
            .await
            .unwrap());
        assert!(store
            .complete_runtime_timer(
                &timer.id,
                timer.generation,
                timer.claimed_by.as_deref().unwrap(),
            )
            .await
            .unwrap());
        assert!(!store
            .complete_runtime_timer(
                &timer.id,
                timer.generation,
                timer.claimed_by.as_deref().unwrap(),
            )
            .await
            .unwrap());
    }
    assert_eq!(
        store
            .list_runtime_timers(Some(RuntimeTimerStatus::Fired))
            .await
            .unwrap()
            .len(),
        4
    );
}

async fn assert_objective_lease_conformance<S>(store: Arc<S>)
where
    S: EventStore
        + ObjectiveStore
        + ThreadStore
        + ThreadGroupStore
        + ActivationStore
        + Send
        + Sync
        + 'static,
{
    let created = store
        .create_objective(NewObjective {
            id: "conformance-objective".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            coordinator_session_id: "conformance-session".to_string(),
            delivery_session_id: "conformance-session".to_string(),
            parent_objective_id: None,
            source_event_id: "conformance-objective-source".to_string(),
            initiating_principal_id: None,
            stated_objective: "verify objective fencing".to_string(),
            token_budget: Some(10_000),
        })
        .await
        .unwrap();
    assert_eq!(created.revision, 1);

    let waiting = match store
        .update_objective_state(
            &created.id,
            created.revision,
            ObjectiveStatus::Active,
            Some(ObjectiveWaitCondition::ResourceAvailable {
                resource: "conformance-resource".to_string(),
            }),
            Some("conformance wait"),
        )
        .await
        .unwrap()
    {
        ObjectiveMutation::Updated(objective) => objective,
        mutation => panic!("unexpected wait mutation: {mutation:?}"),
    };
    assert!(matches!(
        store
            .claim_objective_evaluation(
                &waiting.id,
                waiting.revision,
                "blocked-evaluation",
                chrono::Utc::now() + chrono::Duration::seconds(30),
            )
            .await
            .unwrap(),
        ObjectiveMutation::Conflict { .. }
    ));
    let ready = match store
        .update_objective_state(
            &waiting.id,
            waiting.revision,
            ObjectiveStatus::Active,
            None,
            Some("resource available"),
        )
        .await
        .unwrap()
    {
        ObjectiveMutation::Updated(objective) => objective,
        mutation => panic!("unexpected ready mutation: {mutation:?}"),
    };

    let expires = chrono::Utc::now() + chrono::Duration::seconds(30);
    let first = {
        let store = Arc::clone(&store);
        let id = ready.id.clone();
        tokio::spawn(async move {
            store
                .claim_objective_evaluation(&id, ready.revision, "evaluation-a", expires)
                .await
        })
    };
    let second = {
        let store = Arc::clone(&store);
        let id = ready.id.clone();
        tokio::spawn(async move {
            store
                .claim_objective_evaluation(&id, ready.revision, "evaluation-b", expires)
                .await
        })
    };
    let first = first.await.unwrap().unwrap();
    let second = second.await.unwrap().unwrap();
    let mutations = [first, second];
    assert_eq!(
        mutations
            .iter()
            .filter(|mutation| matches!(mutation, ObjectiveMutation::Updated(_)))
            .count(),
        1
    );
    assert_eq!(
        mutations
            .iter()
            .filter(|mutation| matches!(mutation, ObjectiveMutation::Conflict { .. }))
            .count(),
        1
    );
    let winner = mutations
        .into_iter()
        .find_map(|mutation| match mutation {
            ObjectiveMutation::Updated(objective) => Some(objective),
            _ => None,
        })
        .expect("exactly one Objective evaluation must win the revision fence");
    assert!(winner.active_evaluation_id.is_some());

    let renewed_expiry = chrono::Utc::now() + chrono::Duration::minutes(2);
    let winner = match store
        .renew_objective_evaluation(
            &winner.id,
            winner.active_evaluation_id.as_deref().unwrap(),
            renewed_expiry,
        )
        .await
        .unwrap()
    {
        ObjectiveMutation::Updated(objective) => objective,
        mutation => panic!("unexpected renewal mutation: {mutation:?}"),
    };
    assert_eq!(
        winner.revision,
        ready.revision + 1,
        "lease heartbeat must not change the model-visible Objective revision"
    );
    assert_eq!(winner.evaluation_lease_expires_at, Some(renewed_expiry));
    assert!(matches!(
        store
            .renew_objective_evaluation(&winner.id, "stale-evaluation", renewed_expiry)
            .await
            .unwrap(),
        ObjectiveMutation::Conflict { .. }
    ));

    let usage = match store
        .record_objective_evaluation_usage(
            &winner.id,
            winner.active_evaluation_id.as_deref().unwrap(),
            7,
        )
        .await
        .unwrap()
    {
        ObjectiveMutation::Updated(objective) => objective,
        mutation => panic!("unexpected usage mutation: {mutation:?}"),
    };
    assert_eq!(usage.revision, winner.revision);
    let finished = match store
        .finish_objective_evaluation(
            &usage.id,
            usage.active_evaluation_id.as_deref().unwrap(),
            5,
            3,
        )
        .await
        .unwrap()
    {
        ObjectiveMutation::Updated(objective) => objective,
        mutation => panic!("unexpected finish mutation: {mutation:?}"),
    };
    assert_eq!(finished.tokens_used, 12);
    assert_eq!(finished.time_used_seconds, 3);

    let primary_root = objective_primary_execution_root_id(&finished.id, finished.generation);
    let continuation_thread = NewThread {
        id: stable_thread_id(&primary_root),
        agent_id: "conformance-agent".to_string(),
        context_id: "conformance-context".to_string(),
        session_id: "conformance-session".to_string(),
        initiating_principal_id: None,
        root_turn_id: primary_root,
        kind: ThreadKind::Execution,
        executor_kind: "model".to_string(),
        executor_id: Some(finished.id.clone()),
        target_id: None,
        supervision: morphz::memory::ThreadSupervision::objective_primary_execution(
            &finished.id,
            finished.generation,
        ),
    };

    let occupied_event = Event::new(
        "conformance-objective-conflict".to_string(),
        "Store-Conformance".to_string(),
        "audit".to_string(),
        "runtime/conformance".to_string(),
        json!({"value": "occupied"}).as_object().unwrap().clone(),
    );
    store.append(occupied_event).await.unwrap();
    let conflicting_signal = Event::new(
        "conformance-objective-conflict".to_string(),
        "Store-Conformance".to_string(),
        "runtime_control".to_string(),
        "runtime/objective_continue".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session",
            "objective_id": finished.id,
            "objective_evaluation_id": "rolled-back-evaluation",
            "root_turn_id": continuation_thread.root_turn_id
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    assert!(store
        .claim_objective_evaluation_with_signal(
            &finished.id,
            finished.revision,
            "rolled-back-evaluation",
            expires,
            &conflicting_signal,
            &continuation_thread,
        )
        .await
        .is_err());
    assert_eq!(
        store.get_objective(&finished.id).await.unwrap().unwrap(),
        finished,
        "Event conflict must roll back the Objective lease"
    );

    let event = Event::new(
        "conformance-objective-signal".to_string(),
        "Store-Conformance".to_string(),
        "runtime_control".to_string(),
        "runtime/objective_continue".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session",
            "objective_id": finished.id,
            "objective_evaluation_id": "evaluation-with-signal",
            "root_turn_id": continuation_thread.root_turn_id
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    let claimed = match store
        .claim_objective_evaluation_with_signal(
            &finished.id,
            finished.revision,
            "evaluation-with-signal",
            expires,
            &event,
            &continuation_thread,
        )
        .await
        .unwrap()
    {
        ObjectiveMutation::Updated(objective) => objective,
        mutation => panic!("unexpected continuation mutation: {mutation:?}"),
    };
    assert_eq!(
        store
            .query(QueryFilter {
                event_id: Some(event.id.clone()),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1,
        "Objective lease and continuation Event must commit atomically"
    );
    let thread = store
        .get_thread(&continuation_thread.id)
        .await
        .unwrap()
        .expect("Objective coordinator Thread must exist");
    assert_eq!(thread.lifecycle, ThreadLifecycle::Open);
    let signal = store
        .list_context_thread_signals(&thread.context_id, Some(ThreadSignalStatus::Pending))
        .await
        .unwrap()
        .into_iter()
        .find(|signal| signal.event_id == event.id)
        .expect("Objective continuation must materialize one pending Signal");
    let activation = store
        .claim_thread_signal_batch(
            NewThreadSignal {
                id: signal.id,
                thread_id: thread.id.clone(),
                thread_generation: thread.generation,
                event_id: event.id.clone(),
                principal_id: None,
                sequence: signal.sequence,
                kind: event.topic.clone(),
                parent_activation_id: None,
            },
            NewThreadActivation {
                id: "conformance-objective-activation-a".to_string(),
                agent_id: thread.agent_id.clone(),
                context_id: thread.context_id.clone(),
                session_id: thread.session_id.clone(),
                initiating_principal_id: None,
                trigger_event_id: event.id.clone(),
                trigger_sequence: signal.sequence,
                trigger_kind: event.topic.clone(),
                parent_activation_id: None,
                root_turn_id: thread.root_turn_id.clone(),
            },
            8,
        )
        .await
        .unwrap()
        .expect("Objective continuation must create one Activation");
    let activation = match store
        .update_thread_activation(
            &activation.id,
            activation.revision,
            ThreadActivationStatus::Running,
            Some("conformance-objective-worker"),
            Some(chrono::Utc::now() + chrono::Duration::seconds(30)),
            Some(thread.generation),
        )
        .await
        .unwrap()
    {
        ThreadActivationMutation::Updated(activation) => activation,
        mutation => panic!("Objective Activation must enter running: {mutation:?}"),
    };
    let outcome = Event::new(
        "conformance-objective-activation-outcome-a".to_string(),
        "Store-Conformance".to_string(),
        "agent_reply".to_string(),
        "runtime/thread_result".to_string(),
        json!({
            "context_id": thread.context_id,
            "session_id": thread.session_id,
            "thread_id": thread.id,
            "root_turn_id": thread.root_turn_id,
            "disposition": "deliver",
            "text": "finite evaluation outcome"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    assert_eq!(
        store
            .commit_activation_outcome(&activation.id, &outcome)
            .await
            .unwrap(),
        ActivationOutcomeCommit::Committed {
            ready_signal_event_ids: Vec::new()
        }
    );
    assert_eq!(
        store
            .get_thread_activation(&activation.id)
            .await
            .unwrap()
            .unwrap()
            .status,
        ThreadActivationStatus::Succeeded
    );
    assert_eq!(
        store
            .get_thread(&continuation_thread.id)
            .await
            .unwrap()
            .unwrap()
            .lifecycle,
        ThreadLifecycle::Open,
        "finite Evaluation outcome must not terminalize the Objective coordinator"
    );
    assert!(store
        .get_thread_outcome(&continuation_thread.id)
        .await
        .unwrap()
        .is_none());

    let finished_again = match store
        .finish_objective_evaluation(
            &claimed.id,
            claimed.active_evaluation_id.as_deref().unwrap(),
            0,
            0,
        )
        .await
        .unwrap()
    {
        ObjectiveMutation::Updated(objective) => objective,
        mutation => panic!("unexpected continuation finish mutation: {mutation:?}"),
    };
    let next_event = Event::new(
        "conformance-objective-signal-b".to_string(),
        "Store-Conformance".to_string(),
        "runtime_control".to_string(),
        "runtime/objective_continue".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session",
            "objective_id": finished_again.id,
            "objective_evaluation_id": "evaluation-with-signal-b",
            "root_turn_id": continuation_thread.root_turn_id
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    assert!(matches!(
        store
            .claim_objective_evaluation_with_signal(
                &finished_again.id,
                finished_again.revision,
                "evaluation-with-signal-b",
                expires,
                &next_event,
                &continuation_thread,
            )
            .await
            .unwrap(),
        ObjectiveMutation::Updated(_)
    ));
    assert_eq!(
        store
            .list_context_threads("conformance-context", false)
            .await
            .unwrap()
            .into_iter()
            .filter(|thread| {
                thread.kind == ThreadKind::Execution
                    && thread.supervision.supervisor_kind
                        == morphz::memory::ThreadSupervisorKind::Objective
                    && thread.supervision.origin_evaluation_id.is_none()
            })
            .count(),
        1,
        "successive Objective Evaluations must reuse one primary Execution Thread"
    );
}

async fn assert_action_group_conformance<S>(store: Arc<S>)
where
    S: ActionGroupStore + ActivationStore + EventStore + Send + Sync + 'static,
{
    let assistant_call = Event::new(
        "conformance-action-group-call".to_string(),
        "Store-Conformance".to_string(),
        morphz::event::TYPE_AGENT_CALL.to_string(),
        "chat/assistant_call".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session",
            "attempt_id": "conformance-activation",
            "activation_id": "conformance-activation",
            "thread_id": "conformance-thread",
            "root_turn_id": "root-conformance-thread"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    store.append(assistant_call.clone()).await.unwrap();
    let group = store
        .create_action_group(
            NewActionGroup {
                id: "conformance-action-group".to_string(),
                activation_id: "conformance-activation".to_string(),
                thread_id: "conformance-thread".to_string(),
                agent_id: "conformance-agent".to_string(),
                context_id: "conformance-context".to_string(),
                session_id: "conformance-session".to_string(),
                assistant_call_event_id: assistant_call.id,
                objective_id: None,
                objective_evaluation_id: None,
                objective_revision: None,
            },
            vec![
                NewActionGroupMember {
                    ordinal: 0,
                    tool_call_id: "group-call-a".to_string(),
                    tool_name: "read".to_string(),
                    execution_job_id: None,
                },
                NewActionGroupMember {
                    ordinal: 1,
                    tool_call_id: "group-call-b".to_string(),
                    tool_name: "search".to_string(),
                    execution_job_id: None,
                },
            ],
        )
        .await
        .unwrap();
    assert_eq!(group.status, ActionGroupStatus::Running);
    assert!(store
        .create_action_group(
            NewActionGroup {
                id: "invalid-single-action-group".to_string(),
                activation_id: "conformance-activation".to_string(),
                thread_id: "conformance-thread".to_string(),
                agent_id: "conformance-agent".to_string(),
                context_id: "conformance-context".to_string(),
                session_id: "conformance-session".to_string(),
                assistant_call_event_id: "unused-call".to_string(),
                objective_id: None,
                objective_evaluation_id: None,
                objective_revision: None,
            },
            vec![NewActionGroupMember {
                ordinal: 0,
                tool_call_id: "only-call".to_string(),
                tool_name: "read".to_string(),
                execution_job_id: None,
            }],
        )
        .await
        .is_err());

    let result = |call: &str| {
        Event::new(
            format!("conformance-action-result-{call}"),
            "Store-Conformance".to_string(),
            morphz::event::TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            json!({
                "context_id": "conformance-context",
                "session_id": "conformance-session",
                "attempt_id": "conformance-activation",
                "activation_id": "conformance-activation",
                "thread_id": "conformance-thread",
                "root_turn_id": "root-conformance-thread",
                "action_group_id": "conformance-action-group",
                "tool_call_id": call,
                "tool_name": "read",
                "tool_status": "success",
                "text": call
            })
            .as_object()
            .unwrap()
            .clone(),
        )
    };
    let settled = Event::new(
        "action_group_settled_conformance-action-group".to_string(),
        "Store-Conformance".to_string(),
        "runtime_control".to_string(),
        "runtime/action_group_settled".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session",
            "attempt_id": "conformance-activation",
            "activation_id": "conformance-activation",
            "thread_id": "conformance-thread",
            "root_turn_id": "root-conformance-thread",
            "action_group_id": "conformance-action-group",
            "member_count": 2,
            "wake_policy": "direct_signal"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    let first = {
        let store = Arc::clone(&store);
        let settled = settled.clone();
        let result = result("group-call-a");
        tokio::spawn(async move {
            store
                .commit_action_group_member_result(
                    "conformance-action-group",
                    "group-call-a",
                    ActionGroupMemberStatus::Succeeded,
                    &result,
                    &settled,
                )
                .await
        })
    };
    let second = {
        let store = Arc::clone(&store);
        let settled = settled.clone();
        let result = result("group-call-b");
        tokio::spawn(async move {
            store
                .commit_action_group_member_result(
                    "conformance-action-group",
                    "group-call-b",
                    ActionGroupMemberStatus::Succeeded,
                    &result,
                    &settled,
                )
                .await
        })
    };
    let commits = [
        first.await.unwrap().unwrap(),
        second.await.unwrap().unwrap(),
    ];
    assert_eq!(
        commits.iter().filter(|commit| commit.settled_now).count(),
        1,
        "only the final member transaction may settle and signal the Group"
    );
    let current = store
        .get_action_group("conformance-action-group")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.status, ActionGroupStatus::Settled);
    assert_eq!(current.terminal_member_count, 2);
    assert_eq!(
        store
            .list_action_groups(ActionGroupFilter {
                context_id: Some("conformance-context".to_string()),
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap()
            .iter()
            .filter(|group| group.id == "conformance-action-group")
            .count(),
        1
    );
    assert_eq!(
        store
            .query(QueryFilter {
                event_id: Some(settled.id.clone()),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1
    );
    let continuation_signals = store
        .list_context_thread_signals("conformance-context", Some(ThreadSignalStatus::Pending))
        .await
        .unwrap()
        .into_iter()
        .filter(|signal| signal.event_id == settled.id)
        .collect::<Vec<_>>();
    assert_eq!(
        continuation_signals.len(),
        1,
        "the settled Event must own exactly one direct durable continuation"
    );
    assert_eq!(continuation_signals[0].thread_id, "conformance-thread");
    assert_eq!(continuation_signals[0].thread_generation, 1);
    assert_eq!(
        store
            .list_signal_outbox(SignalOutboxStatus::Pending, 100)
            .await
            .unwrap()
            .iter()
            .filter(|entry| entry.event_id == settled.id)
            .count(),
        0,
        "same-database ActionGroup completion must not detour through Signal Outbox"
    );
}

fn execution_job(id: &str, tool_call_id: &str) -> NewExecutionJob {
    execution_job_on_target(
        id,
        tool_call_id,
        morphz::execution_target::DEFAULT_EXECUTION_TARGET_ID,
    )
}

fn execution_job_on_target(id: &str, tool_call_id: &str, target_id: &str) -> NewExecutionJob {
    NewExecutionJob {
        id: id.to_string(),
        activation_id: "conformance-activation".to_string(),
        thread_id: "conformance-thread".to_string(),
        agent_id: "conformance-agent".to_string(),
        context_id: "conformance-context".to_string(),
        session_id: "conformance-session".to_string(),
        initiating_principal_id: None,
        target_id: target_id.to_string(),
        tool_call_id: tool_call_id.to_string(),
        tool_name: "read".to_string(),
        request: json!({"path": "README.md"}),
        retry_safety: ExecutionRetrySafety::Idempotent,
        requires_approval: false,
    }
}

async fn assert_edge_execution_conformance<S>(store: Arc<S>)
where
    S: EdgeExecutionStore + ExecutionJobStore + Send + Sync + 'static,
{
    store
        .create_node_pairing_code(NewNodePairingCode {
            code_hash: "pairing-hash-conformance".to_string(),
            owner_principal_id: "principal:conformance".to_string(),
            expires_at: chrono::Utc::now() + chrono::Duration::minutes(1),
        })
        .await
        .unwrap();
    let node = store
        .pair_execution_node(PairExecutionNode {
            code_hash: "pairing-hash-conformance".to_string(),
            node_id: "node-conformance".to_string(),
            name: "Conformance Node".to_string(),
            device_key_fingerprint: "sha256:device-conformance".to_string(),
            device_public_key: "00112233".to_string(),
            protocol_version: 1,
            platform: Some("linux-x86_64".to_string()),
            capabilities: vec!["read".to_string(), "exec".to_string()],
            metadata: json!({"transport": "test"}),
        })
        .await
        .unwrap();
    assert_eq!(node.status, ExecutionNodeStatus::Online);
    assert!(store
        .authenticate_execution_node("node-conformance", "sha256:wrong")
        .await
        .unwrap()
        .is_none());
    store
        .create_execution_node_challenge(NewExecutionNodeChallenge {
            id: "challenge-conformance".to_string(),
            node_id: "node-conformance".to_string(),
            nonce_hash: "nonce-conformance".to_string(),
            expires_at: chrono::Utc::now() + chrono::Duration::minutes(1),
        })
        .await
        .unwrap();
    assert!(store
        .consume_execution_node_challenge(
            "node-conformance",
            "challenge-conformance",
            "nonce-conformance",
        )
        .await
        .unwrap()
        .is_some());
    assert!(store
        .consume_execution_node_challenge(
            "node-conformance",
            "challenge-conformance",
            "nonce-conformance",
        )
        .await
        .unwrap()
        .is_none());
    store
        .issue_execution_node_connection_token(
            "node-conformance",
            "sha256:token-conformance",
            chrono::Utc::now() + chrono::Duration::minutes(1),
        )
        .await
        .unwrap();
    assert!(store
        .authenticate_execution_node("node-conformance", "sha256:token-conformance")
        .await
        .unwrap()
        .is_some());
    let heartbeat_node = store
        .heartbeat_execution_node(
            "node-conformance",
            Some("linux-x86_64".to_string()),
            vec!["exec".to_string(), "read".to_string()],
            json!({"transport": "test"}),
        )
        .await
        .unwrap()
        .unwrap();
    let rotated = match store
        .rotate_execution_node_key(
            "node-conformance",
            heartbeat_node.revision,
            "sha256:rotated-device-conformance",
            "aabbccdd",
        )
        .await
        .unwrap()
    {
        ExecutionNodeMutation::Updated(node) => node,
        mutation => panic!("unexpected key rotation mutation: {mutation:?}"),
    };
    assert_eq!(rotated.device_public_key, "aabbccdd");
    assert!(
        store
            .authenticate_execution_node("node-conformance", "sha256:token-conformance")
            .await
            .unwrap()
            .is_none(),
        "key rotation must revoke existing connection tokens"
    );
    assert!(matches!(
        store
            .rotate_execution_node_key(
                "node-conformance",
                heartbeat_node.revision,
                "sha256:stale",
                "11223344",
            )
            .await
            .unwrap(),
        ExecutionNodeMutation::Conflict { .. }
    ));

    store
        .create_execution_job(execution_job_on_target(
            "conformance-edge-job",
            "tool-call-edge",
            "conformance-edge-target",
        ))
        .await
        .unwrap();
    let queued = store
        .create_edge_command(NewEdgeCommand {
            job_id: "conformance-edge-job".to_string(),
            target_id: "conformance-edge-target".to_string(),
            provider_node_id: "node-conformance".to_string(),
            tool_name: "read".to_string(),
            arguments: r#"{"path":"README.md"}"#.to_string(),
            route: json!({
                "route_id": "route:conformance-edge-target:r1",
                "target_id": "conformance-edge-target",
                "target_revision": 1,
                "provider_node_id": "node-conformance",
                "backend_kind": "edge_node",
                "endpoint_ref": null,
                "policy_digest": "policy:conformance"
            }),
        })
        .await
        .unwrap();
    assert_eq!(queued.status, EdgeCommandStatus::Queued);
    assert_eq!(
        store
            .create_edge_command(NewEdgeCommand {
                job_id: "conformance-edge-job".to_string(),
                target_id: "conformance-edge-target".to_string(),
                provider_node_id: "node-conformance".to_string(),
                tool_name: "read".to_string(),
                arguments: r#"{"path":"README.md"}"#.to_string(),
                route: queued.route.clone(),
            })
            .await
            .unwrap(),
        queued,
        "same job command replay must be idempotent"
    );
    let claimed = store
        .claim_edge_command(
            "node-conformance",
            "worker-conformance",
            "claim-conformance",
            chrono::Utc::now() + chrono::Duration::seconds(30),
            8,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claimed.status, EdgeCommandStatus::Claimed);
    assert!(matches!(
        store
            .heartbeat_edge_command(
                &claimed.job_id,
                claimed.revision,
                "stale-claim",
                chrono::Utc::now() + chrono::Duration::seconds(30),
                false,
                None,
            )
            .await
            .unwrap(),
        EdgeCommandMutation::Conflict { .. }
    ));
    let heartbeat = match store
        .heartbeat_edge_command(
            &claimed.job_id,
            claimed.revision,
            "claim-conformance",
            chrono::Utc::now() + chrono::Duration::seconds(30),
            true,
            Some("reading README".to_string()),
        )
        .await
        .unwrap()
    {
        EdgeCommandMutation::Updated(command) => command,
        mutation => panic!("unexpected Edge heartbeat mutation: {mutation:?}"),
    };
    assert!(heartbeat.side_effect_started_at.is_some());
    let stdout = store
        .append_edge_command_output(
            &heartbeat.job_id,
            "claim-conformance",
            EdgeOutputStream::Stdout,
            "first\n",
        )
        .await
        .unwrap();
    let stderr = store
        .append_edge_command_output(
            &heartbeat.job_id,
            "claim-conformance",
            EdgeOutputStream::Stderr,
            "second\n",
        )
        .await
        .unwrap();
    assert_eq!(stdout.sequence, 1);
    assert_eq!(stderr.sequence, 2);
    assert!(store
        .append_edge_command_output(
            &heartbeat.job_id,
            "stale-claim",
            EdgeOutputStream::Stdout,
            "forbidden",
        )
        .await
        .is_err());
    let chunks = store
        .list_edge_command_output(&heartbeat.job_id, 0, 20)
        .await
        .unwrap();
    assert_eq!(chunks, vec![stdout, stderr]);
    assert!(matches!(
        store
            .finish_edge_command(
                &heartbeat.job_id,
                heartbeat.revision - 1,
                "claim-conformance",
                EdgeCommandStatus::Succeeded,
                Some("done".to_string()),
                None,
            )
            .await
            .unwrap(),
        EdgeCommandMutation::Conflict { .. }
    ));
    let finished = match store
        .finish_edge_command(
            &heartbeat.job_id,
            heartbeat.revision,
            "claim-conformance",
            EdgeCommandStatus::Succeeded,
            Some("done".to_string()),
            None,
        )
        .await
        .unwrap()
    {
        EdgeCommandMutation::Updated(command) => command,
        mutation => panic!("unexpected Edge terminal mutation: {mutation:?}"),
    };
    assert_eq!(finished.status, EdgeCommandStatus::Succeeded);
    assert!(store
        .append_edge_command_output(
            &finished.job_id,
            "claim-conformance",
            EdgeOutputStream::Stdout,
            "must not append after terminal",
        )
        .await
        .is_err());
    assert!(matches!(
        store
            .finish_edge_command(
                &finished.job_id,
                finished.revision,
                "claim-conformance",
                EdgeCommandStatus::Failed,
                None,
                Some("must not replace success".to_string()),
            )
            .await
            .unwrap(),
        EdgeCommandMutation::Conflict { .. }
    ));

    store
        .create_execution_job(execution_job_on_target(
            "conformance-edge-cancel-job",
            "tool-call-edge-cancel",
            "conformance-edge-target",
        ))
        .await
        .unwrap();
    store
        .create_edge_command(NewEdgeCommand {
            job_id: "conformance-edge-cancel-job".to_string(),
            target_id: "conformance-edge-target".to_string(),
            provider_node_id: "node-conformance".to_string(),
            tool_name: "read".to_string(),
            arguments: "{}".to_string(),
            route: json!({
                "route_id": "route:conformance-edge-target:r1",
                "target_id": "conformance-edge-target",
                "target_revision": 1,
                "provider_node_id": "node-conformance",
                "backend_kind": "edge_node",
                "endpoint_ref": null,
                "policy_digest": "policy:conformance"
            }),
        })
        .await
        .unwrap();
    assert_eq!(
        store
            .request_edge_command_cancel("conformance-edge-cancel-job")
            .await
            .unwrap()
            .unwrap()
            .status,
        EdgeCommandStatus::Cancelled
    );
}

async fn assert_execution_target_conformance<S>(store: Arc<S>)
where
    S: ExecutionTargetStore + Send + Sync + 'static,
{
    let registration = ExecutionTargetRegistration {
        id: "conformance-edge-target".to_string(),
        owner_principal_id: Some("principal:conformance".to_string()),
        provider_node_id: Some("node-conformance".to_string()),
        kind: ExecutionTargetKind::EdgeNode,
        name: "Conformance Edge Target".to_string(),
        status: ExecutionTargetStatus::Online,
        platform: Some("linux-x86_64".to_string()),
        workspace_root: Some("workspace-conformance".to_string()),
        capabilities: vec!["read".to_string(), "exec".to_string(), "read".to_string()],
        metadata: json!({"backend": "edge_node", "endpoint_ref": "workspace-a"}),
        policy_digest: "policy-conformance-v1".to_string(),
        last_seen_at: Some(chrono::Utc::now()),
    };
    let created = store
        .register_execution_target(registration.clone())
        .await
        .unwrap();
    assert_eq!(created.revision, 1);
    assert_eq!(created.capabilities, vec!["exec", "read"]);
    let heartbeat = store
        .register_execution_target(registration.clone())
        .await
        .unwrap();
    assert_eq!(heartbeat.revision, 1, "pure heartbeat is idempotent");
    let mut refreshed_registration = registration.clone();
    refreshed_registration.name = "Conformance Edge Target v2".to_string();
    let refreshed = store
        .register_execution_target(refreshed_registration)
        .await
        .unwrap();
    assert_eq!(refreshed.revision, 2);
    assert_eq!(
        store
            .list_execution_targets(ExecutionTargetFilter {
                owner_principal_id: Some("principal:conformance".to_string()),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1
    );

    let stale = store
        .set_execution_target_status(
            &created.id,
            created.revision,
            ExecutionTargetStatus::Offline,
        )
        .await
        .unwrap();
    assert!(matches!(stale, ExecutionTargetMutation::Conflict { .. }));
    let offline = store
        .set_execution_target_status(
            &refreshed.id,
            refreshed.revision,
            ExecutionTargetStatus::Offline,
        )
        .await
        .unwrap();
    let ExecutionTargetMutation::Updated(offline) = offline else {
        panic!("matching revision must update the target")
    };
    assert_eq!(offline.status, ExecutionTargetStatus::Offline);

    let mut illegal = registration;
    illegal.kind = ExecutionTargetKind::ManagedSsh;
    assert!(store.register_execution_target(illegal).await.is_err());
}

async fn assert_execution_target_authorization_conformance<S>(store: Arc<S>)
where
    S: ExecutionTargetAuthorizationStore + Send + Sync + 'static,
{
    let authorization = NewExecutionTargetAuthorization {
        id: "target-auth-conformance".to_string(),
        target_id: "conformance-edge-target".to_string(),
        owner_principal_id: "principal:conformance".to_string(),
        scope: ExecutionTargetAuthorizationScope::Thread,
        scope_id: "conformance-thread".to_string(),
    };
    let created = match store
        .authorize_execution_target(authorization.clone())
        .await
        .unwrap()
    {
        ExecutionTargetAuthorizationMutation::Created(record) => record,
        mutation => panic!("unexpected Target authorization create mutation: {mutation:?}"),
    };
    assert_eq!(created.status, ExecutionTargetAuthorizationStatus::Active);
    assert!(store
        .has_execution_target_authorization_history("conformance-edge-target")
        .await
        .unwrap());
    assert!(matches!(
        store
            .authorize_execution_target(authorization.clone())
            .await
            .unwrap(),
        ExecutionTargetAuthorizationMutation::Existing(_)
    ));
    assert_eq!(
        store
            .list_execution_target_authorizations(ExecutionTargetAuthorizationFilter {
                target_id: Some("conformance-edge-target".to_string()),
                owner_principal_id: Some("principal:conformance".to_string()),
                active_only: true,
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1
    );
    let revoked = match store
        .revoke_execution_target_authorization(&created.id, created.revision, "conformance revoke")
        .await
        .unwrap()
    {
        ExecutionTargetAuthorizationMutation::Updated(record) => record,
        mutation => panic!("unexpected Target authorization revoke mutation: {mutation:?}"),
    };
    assert_eq!(revoked.status, ExecutionTargetAuthorizationStatus::Revoked);
    assert!(store
        .list_execution_target_authorizations(ExecutionTargetAuthorizationFilter {
            target_id: Some("conformance-edge-target".to_string()),
            active_only: true,
            ..Default::default()
        })
        .await
        .unwrap()
        .is_empty());
    let reactivated = match store
        .authorize_execution_target(authorization)
        .await
        .unwrap()
    {
        ExecutionTargetAuthorizationMutation::Updated(record) => record,
        mutation => panic!("unexpected Target authorization reactivate mutation: {mutation:?}"),
    };
    assert_eq!(reactivated.revision, revoked.revision + 1);
    assert_eq!(
        reactivated.status,
        ExecutionTargetAuthorizationStatus::Active
    );
}

async fn assert_capability_lease_conformance<S>(store: Arc<S>)
where
    S: CapabilityLeaseStore + Send + Sync + 'static,
{
    let lease = NewCapabilityLease {
        id: "lease-conformance".to_string(),
        principal_id: "principal:conformance".to_string(),
        agent_id: "conformance-agent".to_string(),
        thread_id: "conformance-thread".to_string(),
        target_id: "conformance-edge-target".to_string(),
        capabilities: vec!["exec".to_string()],
        requested: json!({
            "network": true,
            "read_roots": ["/tmp/conformance"],
            "write_roots": [],
            "secret_env": []
        }),
        policy_digest: "policy:conformance".to_string(),
        issued_by_approval_id: None,
        expires_at: chrono::Utc::now() + chrono::Duration::minutes(10),
    };
    let created = match store.ensure_capability_lease(lease.clone()).await.unwrap() {
        CapabilityLeaseMutation::Created(lease) => lease,
        mutation => panic!("unexpected Capability Lease create mutation: {mutation:?}"),
    };
    assert_eq!(created.status, CapabilityLeaseStatus::Active);
    assert!(matches!(
        store.ensure_capability_lease(lease).await.unwrap(),
        CapabilityLeaseMutation::Existing(_)
    ));
    assert_eq!(
        store
            .list_capability_leases(CapabilityLeaseFilter {
                principal_id: Some("principal:conformance".to_string()),
                thread_id: Some("conformance-thread".to_string()),
                target_id: Some("conformance-edge-target".to_string()),
                active_at: Some(chrono::Utc::now()),
                ..CapabilityLeaseFilter::default()
            })
            .await
            .unwrap()
            .len(),
        1
    );
    let revoked = match store
        .revoke_capability_lease(&created.id, created.revision, "conformance revoke")
        .await
        .unwrap()
    {
        CapabilityLeaseMutation::Updated(lease) => lease,
        mutation => panic!("unexpected Capability Lease revoke mutation: {mutation:?}"),
    };
    assert_eq!(revoked.status, CapabilityLeaseStatus::Revoked);
    assert!(store
        .list_capability_leases(CapabilityLeaseFilter {
            principal_id: Some("principal:conformance".to_string()),
            active_at: Some(chrono::Utc::now()),
            ..CapabilityLeaseFilter::default()
        })
        .await
        .unwrap()
        .is_empty());
}

async fn assert_execution_job_conformance<S>(store: Arc<S>)
where
    S: morphz::memory::RuntimeStore + 'static,
{
    let created = store
        .create_execution_job(execution_job("conformance-job", "tool-call-a"))
        .await
        .unwrap();
    assert_eq!(created.revision, 1);
    assert_eq!(
        store
            .create_execution_job(execution_job("conformance-job", "tool-call-a"))
            .await
            .unwrap(),
        created,
        "exact causal replay must be idempotent"
    );

    let lease = chrono::Utc::now() + chrono::Duration::seconds(30);
    let first = {
        let store = Arc::clone(&store);
        tokio::spawn(async move {
            store
                .claim_execution_job("conformance-job", 1, "worker-a", "claim-a", lease, None)
                .await
        })
    };
    let second = {
        let store = Arc::clone(&store);
        tokio::spawn(async move {
            store
                .claim_execution_job("conformance-job", 1, "worker-b", "claim-b", lease, None)
                .await
        })
    };
    let mutations = [
        first.await.unwrap().unwrap(),
        second.await.unwrap().unwrap(),
    ];
    assert_eq!(
        mutations
            .iter()
            .filter(|mutation| matches!(mutation, ExecutionJobMutation::Updated(_)))
            .count(),
        1
    );
    let claimed = mutations
        .into_iter()
        .find_map(|mutation| match mutation {
            ExecutionJobMutation::Updated(job) => Some(job),
            _ => None,
        })
        .unwrap();
    assert_eq!(claimed.status, ExecutionJobStatus::Running);
    assert!(matches!(
        store
            .heartbeat_execution_job(
                &claimed.id,
                claimed.revision,
                "stale-claim",
                lease,
                None,
                None,
            )
            .await
            .unwrap(),
        ExecutionJobMutation::Rejected { .. }
    ));
    let heartbeat = match store
        .heartbeat_execution_job(
            &claimed.id,
            claimed.revision,
            claimed.claim_token.as_deref().unwrap(),
            lease,
            None,
            Some("progress://conformance"),
        )
        .await
        .unwrap()
    {
        ExecutionJobMutation::Updated(job) => job,
        mutation => panic!("unexpected heartbeat mutation: {mutation:?}"),
    };

    let result_event = Event::new(
        "conformance-tool-output".to_string(),
        "Store-Conformance".to_string(),
        morphz::event::TYPE_TOOL_OUTPUT.to_string(),
        "chat/tool_output".to_string(),
        json!({
            "context_id": heartbeat.context_id,
            "session_id": heartbeat.session_id,
            "activation_id": heartbeat.activation_id,
            "thread_id": heartbeat.thread_id,
            "tool_call_id": heartbeat.tool_call_id,
            "tool_name": heartbeat.tool_name,
            "output": ""
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    let terminal = ExecutionJobTerminal {
        status: ExecutionJobStatus::Succeeded,
        result_event_id: Some(result_event.id.clone()),
        result_refs: Vec::new(),
        error: None,
        exit_code: Some(0),
    };
    let kernel = SchedulerKernel::new(Arc::clone(&store) as Arc<dyn morphz::memory::RuntimeStore>);
    let outcome_command = morphz::controllers::ExecutionController::commit_job_outcome(
        &heartbeat.id,
        heartbeat.revision,
        heartbeat.claim_token.as_deref(),
        terminal.clone(),
        Some(result_event.clone()),
        false,
        "Store-Conformance",
    );
    let finished = match kernel.execute(outcome_command.clone()).await.unwrap() {
        KernelResult::ExecutionJobOutcomeCommitted(mutation) => match mutation {
            ExecutionJobMutation::Updated(job) => job,
            mutation => panic!("unexpected terminal mutation: {mutation:?}"),
        },
        result => panic!("unexpected Execution Kernel result: {result:?}"),
    };
    assert_eq!(finished.status, ExecutionJobStatus::Succeeded);
    assert!(matches!(
        match kernel.execute(outcome_command).await.unwrap() {
            KernelResult::ExecutionJobOutcomeCommitted(mutation) => mutation,
            result => panic!("unexpected Execution Kernel replay result: {result:?}"),
        },
        ExecutionJobMutation::Existing(_)
    ));
    assert_eq!(
        store
            .query(QueryFilter {
                event_id: Some(result_event.id),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1,
        "terminal Job and result Event must be committed exactly once"
    );

    let recoverable = store
        .create_execution_job(execution_job("conformance-requeue", "tool-call-b"))
        .await
        .unwrap();
    let claimed = match store
        .claim_execution_job(
            &recoverable.id,
            recoverable.revision,
            "worker-c",
            "claim-c",
            lease,
            None,
        )
        .await
        .unwrap()
    {
        ExecutionJobMutation::Updated(job) => job,
        mutation => panic!("unexpected recovery claim: {mutation:?}"),
    };
    assert!(matches!(
        store
            .requeue_execution_job(&claimed.id, claimed.revision)
            .await
            .unwrap(),
        ExecutionJobMutation::Updated(job) if job.status == ExecutionJobStatus::Queued
    ));
}

fn approval_bundle(
    job_id: &str,
    tool_call_id: &str,
) -> (NewExecutionJob, NewApprovalRequest, Event) {
    let mut job = execution_job(job_id, tool_call_id);
    job.requires_approval = true;
    job.tool_name = "exec".to_string();
    job.request = json!({"command": "curl https://example.com"});
    let action = json!({"tool": "exec", "command": "curl https://example.com"});
    let requested = json!({"network": true, "write_roots": []});
    let identity = stable_approval_identity(job_id, &action, &requested, "policy-v1").unwrap();
    let approval = NewApprovalRequest {
        id: identity.approval_id,
        job_id: job_id.to_string(),
        request_digest: identity.request_digest,
        policy_digest: identity.policy_digest,
        action,
        requested,
        justification: "network access is required".to_string(),
        pending_status: ApprovalStatus::PendingAuto,
    };
    let event = Event::new(
        format!("approval-request-{job_id}"),
        "Store-Conformance".to_string(),
        "approval_requested".to_string(),
        "runtime/approval_requested".to_string(),
        json!({
            "approval_id": approval.id,
            "job_id": job.id,
            "request_digest": approval.request_digest,
            "policy_digest": approval.policy_digest,
            "activation_id": job.activation_id,
            "thread_id": job.thread_id,
            "context_id": job.context_id,
            "session_id": job.session_id,
            "tool_call_id": job.tool_call_id,
            "action": approval.action,
            "requested": approval.requested,
            "justification": approval.justification
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    (job, approval, event)
}

async fn assert_approval_grant_conformance<S>(store: Arc<S>)
where
    S: ApprovalStore
        + EventStore
        + ExecutionApprovalStore
        + ExecutionJobStore
        + Send
        + Sync
        + 'static,
{
    let (job, approval, request_event) = approval_bundle("approval-job", "tool-call-approval");
    let created = store
        .ensure_execution_job_with_approval(job.clone(), approval.clone(), &request_event)
        .await
        .unwrap();
    let (job_record, approval_record) = match created {
        ExecutionApprovalMutation::Created { job, approval } => (job, approval),
        mutation => panic!("unexpected approval creation: {mutation:?}"),
    };
    assert_eq!(job_record.status, ExecutionJobStatus::WaitingApproval);
    assert!(matches!(
        store
            .ensure_execution_job_with_approval(job, approval, &request_event)
            .await
            .unwrap(),
        ExecutionApprovalMutation::Existing { .. }
    ));
    let decision = ApprovalResolution::Allow {
        rationale: "conformance allow".to_string(),
        risk_tags: vec!["network".to_string()],
    };
    let audit = store
        .commit_approval_decision(
            &approval_record.id,
            approval_record.revision,
            decision.clone(),
        )
        .await
        .unwrap();
    let allowed = match audit.mutation {
        ApprovalMutation::Updated(approval) => approval,
        mutation => panic!("unexpected approval decision: {mutation:?}"),
    };
    assert!(audit.event_created);
    assert_eq!(allowed.status, ApprovalStatus::Allowed);
    assert!(matches!(
        store
            .commit_approval_decision(&allowed.id, allowed.revision, decision)
            .await
            .unwrap()
            .mutation,
        ApprovalMutation::Existing(_)
    ));

    let lease = chrono::Utc::now() + chrono::Duration::seconds(30);
    let job_id = job_record.id.clone();
    let approval_id = allowed.id.clone();
    let job_revision = job_record.revision;
    let approval_revision = allowed.revision;
    let first = {
        let store = Arc::clone(&store);
        let job_id = job_id.clone();
        let approval_id = approval_id.clone();
        tokio::spawn(async move {
            store
                .claim_execution_job_with_grant(
                    &job_id,
                    job_revision,
                    &approval_id,
                    approval_revision,
                    "approval-worker-a",
                    "approval-claim-a",
                    lease,
                )
                .await
        })
    };
    let second = {
        let store = Arc::clone(&store);
        let job_id = job_id.clone();
        let approval_id = approval_id.clone();
        tokio::spawn(async move {
            store
                .claim_execution_job_with_grant(
                    &job_id,
                    job_revision,
                    &approval_id,
                    approval_revision,
                    "approval-worker-b",
                    "approval-claim-b",
                    lease,
                )
                .await
        })
    };
    let mutations = [
        first.await.unwrap().unwrap(),
        second.await.unwrap().unwrap(),
    ];
    assert_eq!(
        mutations
            .iter()
            .filter(|mutation| matches!(mutation, ExecutionApprovalMutation::Updated { .. }))
            .count(),
        1,
        "one-use Grant must be consumed by one worker only"
    );
    let (claimed_job, consumed) = mutations
        .into_iter()
        .find_map(|mutation| match mutation {
            ExecutionApprovalMutation::Updated { job, approval } => Some((job, approval)),
            _ => None,
        })
        .unwrap();
    assert!(consumed.grant_consumed_at.is_some());
    assert_eq!(
        claimed_job.claim_token.as_deref(),
        consumed.consumed_by_claim_token.as_deref()
    );
    assert!(matches!(
        store
            .claim_execution_job_with_grant(
                &claimed_job.id,
                job_revision,
                &consumed.id,
                approval_revision,
                claimed_job.claimed_by.as_deref().unwrap(),
                claimed_job.claim_token.as_deref().unwrap(),
                lease,
            )
            .await
            .unwrap(),
        ExecutionApprovalMutation::Existing { .. }
    ));

    let (job, approval, request_event) = approval_bundle("cancel-job", "tool-call-cancel");
    let created = store
        .ensure_execution_job_with_approval(job, approval, &request_event)
        .await
        .unwrap();
    let approval = match created {
        ExecutionApprovalMutation::Created { approval, .. } => approval,
        mutation => panic!("unexpected cancellable approval creation: {mutation:?}"),
    };
    let cancelled = store
        .commit_approval_cancellation(&approval.id, approval.revision, "user cancelled")
        .await
        .unwrap();
    assert!(matches!(
        cancelled.mutation,
        ApprovalMutation::Updated(record) if record.status == ApprovalStatus::Cancelled
    ));
}

/// Verifies that PostgreSQL authority is carried by the database rather than
/// by one `PostgresStore` value or one connection pool. The two stores below
/// are independently constructed, matching two Runtime processes connected to
/// the same service database.
async fn assert_independent_postgres_instances_share_fenced_authority(
    first: Arc<PostgresStore>,
    second: Arc<PostgresStore>,
) {
    let suffix = chrono::Utc::now()
        .timestamp_nanos_opt()
        .expect("current timestamp must fit i64");
    let agent_id = format!("multi-worker-agent-{suffix}");
    let context_id = format!("multi-worker-context-{suffix}");
    let session_id = format!("multi-worker-session-{suffix}");

    first
        .create_agent_bundle(
            NewAgent {
                id: agent_id.clone(),
                title: "Multi-worker Agent".to_string(),
                root_context_id: context_id.clone(),
            },
            NewCognitiveContext {
                id: context_id.clone(),
                agent_id: agent_id.clone(),
                title: "Multi-worker Context".to_string(),
            },
            NewSession {
                id: session_id.clone(),
                agent_id: agent_id.clone(),
                context_id: context_id.clone(),
                parent_session_id: None,
                title: "Multi-worker Session".to_string(),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await
        .unwrap();
    assert!(second.get_session(&session_id).await.unwrap().is_some());

    first
        .initialize_mind_projection(NewMindProjection {
            context_id: context_id.clone(),
            revision: 0,
            state: json!({"version": 0}),
            state_hash: format!("multi-worker-hash-0-{suffix}"),
            head_event_id: None,
            recall_documents: Vec::new(),
        })
        .await
        .unwrap();
    let event_a = context_event(&format!("multi-worker-tx-a-{suffix}"), &context_id);
    let event_b = context_event(&format!("multi-worker-tx-b-{suffix}"), &context_id);
    let projection_mutation_a = SessionProjectionMutation::default();
    let projection_mutation_b = SessionProjectionMutation::default();
    let (projection_a, projection_b) = tokio::join!(
        first.commit_mind_projection_transaction(
            &event_a,
            &[],
            &projection_mutation_a,
            0,
            NewMindProjection {
                context_id: context_id.clone(),
                revision: 1,
                state: json!({"version": 1, "worker": "a"}),
                state_hash: format!("multi-worker-hash-a-{suffix}"),
                head_event_id: Some(event_a.id.clone()),
                recall_documents: Vec::new(),
            },
        ),
        second.commit_mind_projection_transaction(
            &event_b,
            &[],
            &projection_mutation_b,
            0,
            NewMindProjection {
                context_id: context_id.clone(),
                revision: 1,
                state: json!({"version": 1, "worker": "b"}),
                state_hash: format!("multi-worker-hash-b-{suffix}"),
                head_event_id: Some(event_b.id.clone()),
                recall_documents: Vec::new(),
            },
        )
    );
    let projections = [projection_a.unwrap(), projection_b.unwrap()];
    assert_eq!(
        projections
            .iter()
            .filter(|mutation| matches!(mutation, MindProjectionCommit::Committed { .. }))
            .count(),
        1,
        "independent Runtime instances must admit one Context CAS writer"
    );
    assert_eq!(
        projections
            .iter()
            .filter(|mutation| matches!(mutation, MindProjectionCommit::Conflict { .. }))
            .count(),
        1
    );
    assert_eq!(
        second
            .get_mind_projection(&context_id)
            .await
            .unwrap()
            .unwrap()
            .revision,
        1
    );

    let thread_id = format!("multi-worker-thread-{suffix}");
    first
        .ensure_thread(NewThread {
            id: thread_id.clone(),
            agent_id: agent_id.clone(),
            context_id: context_id.clone(),
            session_id: session_id.clone(),
            initiating_principal_id: None,
            root_turn_id: format!("multi-worker-root-{suffix}"),
            kind: ThreadKind::Execution,
            executor_kind: "runtime".to_string(),
            executor_id: None,
            target_id: None,
            supervision: morphz::memory::ThreadSupervision::legacy(),
        })
        .await
        .unwrap();
    let activation_id = format!("multi-worker-activation-{suffix}");
    let activation = first
        .ensure_thread_activation(NewThreadActivation {
            id: activation_id.clone(),
            agent_id: agent_id.clone(),
            context_id: context_id.clone(),
            session_id: session_id.clone(),
            initiating_principal_id: None,
            trigger_event_id: format!("multi-worker-trigger-{suffix}"),
            trigger_sequence: 1,
            trigger_kind: "conformance".to_string(),
            parent_activation_id: None,
            root_turn_id: format!("multi-worker-root-{suffix}"),
        })
        .await
        .unwrap();
    let lease = chrono::Utc::now() + chrono::Duration::seconds(30);
    let (activation_a, activation_b) = tokio::join!(
        first.update_thread_activation(
            &activation.id,
            activation.revision,
            ThreadActivationStatus::Running,
            Some("runtime-a"),
            Some(lease),
            Some(1),
        ),
        second.update_thread_activation(
            &activation.id,
            activation.revision,
            ThreadActivationStatus::Running,
            Some("runtime-b"),
            Some(lease),
            Some(1),
        )
    );
    let activation_mutations = [activation_a.unwrap(), activation_b.unwrap()];
    assert_eq!(
        activation_mutations
            .iter()
            .filter(|mutation| matches!(mutation, ThreadActivationMutation::Updated(_)))
            .count(),
        1,
        "independent Runtime instances must not both own one Activation"
    );

    let job_id = format!("multi-worker-job-{suffix}");
    let created_job = first
        .create_execution_job(NewExecutionJob {
            id: job_id.clone(),
            activation_id,
            thread_id,
            agent_id: agent_id.clone(),
            context_id: context_id.clone(),
            session_id: session_id.clone(),
            initiating_principal_id: None,
            target_id: morphz::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
            tool_call_id: format!("multi-worker-tool-call-{suffix}"),
            tool_name: "read".to_string(),
            request: json!({"path": "README.md"}),
            retry_safety: ExecutionRetrySafety::Idempotent,
            requires_approval: false,
        })
        .await
        .unwrap();
    let (job_a, job_b) = tokio::join!(
        first.claim_execution_job(
            &created_job.id,
            created_job.revision,
            "runtime-a",
            "multi-worker-claim-a",
            lease,
            None,
        ),
        second.claim_execution_job(
            &created_job.id,
            created_job.revision,
            "runtime-b",
            "multi-worker-claim-b",
            lease,
            None,
        )
    );
    let job_mutations = [job_a.unwrap(), job_b.unwrap()];
    assert_eq!(
        job_mutations
            .iter()
            .filter(|mutation| matches!(mutation, ExecutionJobMutation::Updated(_)))
            .count(),
        1,
        "one physical Execution Job must have one worker owner"
    );
    let claimed_job = job_mutations
        .into_iter()
        .find_map(|mutation| match mutation {
            ExecutionJobMutation::Updated(job) => Some(job),
            _ => None,
        })
        .unwrap();
    let shared_recovery = ExecutionJobManager::new(Arc::clone(&second));
    let live_report = shared_recovery
        .reconcile_startup(
            morphz::memory::WorkerCoordinationMode::SharedLeases,
            second.as_ref(),
        )
        .await
        .unwrap();
    assert!(live_report.preserved_job_ids.contains(&claimed_job.id));
    assert!(live_report.requeue_receipts.iter().all(|receipt| receipt
        .applied_job()
        .is_none_or(|job| job.id != claimed_job.id)));
    assert!(matches!(
        second
            .requeue_execution_job(&claimed_job.id, claimed_job.revision)
            .await
            .unwrap(),
        ExecutionJobMutation::Updated(job) if job.status == ExecutionJobStatus::Queued
    ));

    let expired_job = first
        .create_execution_job(NewExecutionJob {
            id: format!("multi-worker-expired-job-{suffix}"),
            activation_id: created_job.activation_id.clone(),
            thread_id: created_job.thread_id.clone(),
            agent_id: agent_id.clone(),
            context_id: context_id.clone(),
            session_id: session_id.clone(),
            initiating_principal_id: None,
            target_id: morphz::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
            tool_call_id: format!("multi-worker-expired-tool-call-{suffix}"),
            tool_name: "read".to_string(),
            request: json!({"path": "README.md"}),
            retry_safety: ExecutionRetrySafety::Idempotent,
            requires_approval: false,
        })
        .await
        .unwrap();
    let short_lease = chrono::Utc::now() + chrono::Duration::milliseconds(150);
    let expired_job = match first
        .claim_execution_job(
            &expired_job.id,
            expired_job.revision,
            "runtime-a",
            "multi-worker-expiring-claim",
            short_lease,
            None,
        )
        .await
        .unwrap()
    {
        ExecutionJobMutation::Updated(job) => job,
        mutation => panic!("unexpected expiring Job claim: {mutation:?}"),
    };
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let expired_report = shared_recovery
        .reconcile_startup(
            morphz::memory::WorkerCoordinationMode::SharedLeases,
            second.as_ref(),
        )
        .await
        .unwrap();
    assert!(expired_report.requeue_receipts.iter().any(|receipt| receipt
        .applied_job()
        .is_some_and(|job| job.id == expired_job.id)));

    let objective = first
        .create_objective(NewObjective {
            id: format!("multi-worker-objective-{suffix}"),
            agent_id,
            context_id: context_id.clone(),
            coordinator_session_id: session_id.clone(),
            delivery_session_id: session_id,
            parent_objective_id: None,
            source_event_id: format!("multi-worker-objective-source-{suffix}"),
            initiating_principal_id: None,
            stated_objective: "verify independent Runtime leases".to_string(),
            token_budget: None,
        })
        .await
        .unwrap();
    let (objective_a, objective_b) = tokio::join!(
        first.claim_objective_evaluation(
            &objective.id,
            objective.revision,
            "multi-worker-evaluation-a",
            lease,
        ),
        second.claim_objective_evaluation(
            &objective.id,
            objective.revision,
            "multi-worker-evaluation-b",
            lease,
        )
    );
    let objective_mutations = [objective_a.unwrap(), objective_b.unwrap()];
    assert_eq!(
        objective_mutations
            .iter()
            .filter(|mutation| matches!(mutation, ObjectiveMutation::Updated(_)))
            .count(),
        1,
        "one Objective evaluation lease must have one owner"
    );

    let due_at = chrono::Utc::now() - chrono::Duration::seconds(1);
    for index in 0..8 {
        first
            .upsert_runtime_timer(NewRuntimeTimer {
                id: format!("multi-worker-timer-{suffix}-{index}"),
                generation: 1,
                kind: RuntimeTimerKind::ActivationLease,
                owner_id: format!("multi-worker-timer-owner-{suffix}-{index}"),
                due_at,
                payload: json!({"index": index}),
            })
            .await
            .unwrap();
    }
    let (timers_a, timers_b) = tokio::join!(
        first.claim_due_runtime_timers(chrono::Utc::now(), "multi-worker-timer-claim-a", lease, 8,),
        second
            .claim_due_runtime_timers(chrono::Utc::now(), "multi-worker-timer-claim-b", lease, 8,)
    );
    let timers_a = timers_a.unwrap();
    let timers_b = timers_b.unwrap();
    let mut claimed_timer_ids = timers_a
        .iter()
        .chain(&timers_b)
        .map(|timer| timer.id.clone())
        .collect::<Vec<_>>();
    let claimed_count = claimed_timer_ids.len();
    claimed_timer_ids.sort();
    claimed_timer_ids.dedup();
    assert_eq!(claimed_timer_ids.len(), 8);
    assert_eq!(claimed_count, 8, "Timer claims must never overlap");
}

async fn assert_two_postgres_runtimes_deliver_one_dialogue_once(
    database_url: &str,
    administration_store: &PostgresStore,
) {
    let suffix = chrono::Utc::now()
        .timestamp_nanos_opt()
        .expect("current timestamp must fit i64");
    let schema = format!("runtime_worker_{suffix}");
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(administration_store.pool())
        .await
        .unwrap();
    let separator = if database_url.contains('?') { '&' } else { '?' };
    // Keep `public` visible because PostgreSQL extensions (for example
    // `pg_trgm`) are database-scoped and are commonly installed there. A
    // schema-isolated conformance run must isolate Morphz tables without
    // hiding extension functions from later test schemas.
    let scoped_url = format!("{database_url}{separator}options=-csearch_path%3D{schema}%2Cpublic");
    let first = Arc::new(PostgresStore::new(&scoped_url, 8).await.unwrap());
    let second = Arc::new(PostgresStore::new(&scoped_url, 8).await.unwrap());
    let agent_id = format!("runtime-worker-agent-{suffix}");
    let context_id = format!("runtime-worker-context-{suffix}");
    let session_id = format!("runtime-worker-session-{suffix}");
    first
        .create_agent_bundle(
            NewAgent {
                id: agent_id.clone(),
                title: "Runtime Worker Agent".to_string(),
                root_context_id: context_id.clone(),
            },
            NewCognitiveContext {
                id: context_id.clone(),
                agent_id: agent_id.clone(),
                title: "Runtime Worker Context".to_string(),
            },
            NewSession {
                id: session_id.clone(),
                agent_id: agent_id.clone(),
                context_id: context_id.clone(),
                parent_session_id: None,
                title: "Runtime Worker Session".to_string(),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await
        .unwrap();

    let mut config = AppConfig::default();
    config.permissions.mode = PermissionMode::Custom;
    config.permissions.reviewer = ReviewerKind::Deny;
    let client = Arc::new(MultiRuntimeReplyClient::default());
    let identity = RuntimeIdentity {
        agent_id,
        context_id: context_id.clone(),
        principal_id: "principal:conformance".to_string(),
    };
    let policy = RuntimeToolPolicy {
        context_only: true,
        coding_eval: true,
    };
    let runtime_a = MorphzRuntime::builder(config.clone(), client.clone())
        .store(
            "postgres:test-runtime-a",
            Arc::clone(&first) as Arc<dyn morphz::memory::RuntimeStore>,
        )
        .identity(identity.clone())
        .tool_policy(policy)
        .build()
        .await
        .unwrap();
    let runtime_b = MorphzRuntime::builder(config, client.clone())
        .store(
            "postgres:test-runtime-b",
            Arc::clone(&second) as Arc<dyn morphz::memory::RuntimeStore>,
        )
        .identity(identity)
        .tool_policy(policy)
        .build()
        .await
        .unwrap();
    runtime_a.start().await.unwrap();
    runtime_b.start().await.unwrap();

    let mut replies_a = runtime_a.subscribe("chat/reply", 4);
    let mut replies_b = runtime_b.subscribe("chat/reply", 4);
    runtime_a
        .session(&session_id)
        .send(
            "hello from a shared PostgreSQL Context",
            "Store-Conformance",
            Some(format!("runtime-worker-message-{suffix}")),
        )
        .await
        .unwrap();

    let reply = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::select! {
            event = replies_a.recv() => event,
            event = replies_b.recv() => event,
        }
    })
    .await
    .expect("one Runtime must deliver the dialogue")
    .expect("reply subscription must remain open");
    assert_eq!(reply.payload["text"], "multi-runtime-ok");
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(500), async {
            tokio::select! {
                event = replies_a.recv() => event,
                event = replies_b.recv() => event,
            }
        })
        .await
        .is_err(),
        "the competing Runtime must not produce a duplicate reply"
    );
    assert_eq!(client.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        first
            .query(QueryFilter {
                context_id: Some(context_id),
                session_id: Some(session_id),
                topic: Some("chat/reply".to_string()),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1,
        "the shared Ledger must contain one reply fact"
    );
}

#[tokio::test]
async fn sqlite_runtime_store_satisfies_context_transaction_conformance() {
    let database = NamedTempFile::new().unwrap();
    let store = Arc::new(
        SqliteStore::new(database.path().to_str().unwrap())
            .await
            .unwrap(),
    );
    store
        .create_agent_bundle(
            NewAgent {
                id: "conformance-agent".to_string(),
                title: "Conformance Agent".to_string(),
                root_context_id: "conformance-context".to_string(),
            },
            NewCognitiveContext {
                id: "conformance-context".to_string(),
                agent_id: "conformance-agent".to_string(),
                title: "Conformance Context".to_string(),
            },
            NewSession {
                id: "conformance-session".to_string(),
                agent_id: "conformance-agent".to_string(),
                context_id: "conformance-context".to_string(),
                parent_session_id: None,
                title: "Conformance Session".to_string(),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await
        .unwrap();
    assert_session_directory_conformance(Arc::clone(&store)).await;
    assert_context_transaction_conformance(Arc::clone(&store), |store, session_id| {
        Box::pin(async move {
            Ok(store.get_session(session_id).await?.map(|session| {
                (
                    session.attention_state,
                    session.attention_revision,
                    session.attention_event_id,
                )
            }))
        })
    })
    .await;
    assert_session_projection_conformance(Arc::clone(&store)).await;
    assert_recall_projection_conformance(Arc::clone(&store)).await;
    assert_thread_store_conformance(Arc::clone(&store)).await;
    assert_activation_store_conformance(Arc::clone(&store)).await;
    assert_scheduler_dependency_conformance(Arc::clone(&store)).await;
    assert_schedule_store_conformance(Arc::clone(&store)).await;
    assert_delivery_ingress_conformance(Arc::clone(&store)).await;
    assert_delegation_store_conformance(Arc::clone(&store)).await;
    assert_timer_lease_conformance(Arc::clone(&store)).await;
    assert_objective_lease_conformance(Arc::clone(&store)).await;
    store
        .ensure_thread_activation(NewThreadActivation {
            id: "conformance-activation".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            session_id: "conformance-session".to_string(),
            initiating_principal_id: None,
            trigger_event_id: "trigger-conformance-activation".to_string(),
            trigger_sequence: 1,
            trigger_kind: "conformance".to_string(),
            parent_activation_id: None,
            root_turn_id: "root-conformance-thread".to_string(),
        })
        .await
        .unwrap();
    assert_action_group_conformance(Arc::clone(&store)).await;
    assert_execution_target_conformance(Arc::clone(&store)).await;
    assert_execution_target_authorization_conformance(Arc::clone(&store)).await;
    assert_capability_lease_conformance(Arc::clone(&store)).await;
    assert_edge_execution_conformance(Arc::clone(&store)).await;
    assert_execution_job_conformance(Arc::clone(&store)).await;
    assert_approval_grant_conformance(store).await;
}

#[tokio::test]
async fn postgres_supported_capabilities_satisfy_the_same_conformance_suite_when_configured() {
    let Ok(database_url) = std::env::var("MORPHZ_TEST_POSTGRES_URL") else {
        return;
    };
    assert_complete_runtime_store::<PostgresStore>();
    // One configured PostgreSQL database may run this suite repeatedly or in
    // parallel. Keep every run in a fresh schema instead of requiring a
    // destructive cleanup of public tables or colliding on fixed fixture IDs.
    let suffix = chrono::Utc::now()
        .timestamp_nanos_opt()
        .expect("current timestamp must fit i64");
    let schema = format!("morphz_conformance_{}_{suffix}", std::process::id());
    let administration_pool = sqlx::PgPool::connect(&database_url).await.unwrap();
    // Extensions are database-scoped rather than tenant-schema-scoped. Keep
    // pg_trgm in `public` so every isolated Morphz schema can resolve the same
    // functions and operator classes while its own tables remain isolated.
    if let Err(error) = sqlx::query("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public")
        .execute(&administration_pool)
        .await
    {
        eprintln!("pg_trgm is unavailable to this test role; exercising degraded Recall: {error}");
    }
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&administration_pool)
        .await
        .unwrap();
    let separator = if database_url.contains('?') { '&' } else { '?' };
    // Morphz tables live in the per-run schema, while extension functions
    // remain available from `public` across repeated conformance runs.
    let scoped_url = format!("{database_url}{separator}options=-csearch_path%3D{schema}%2Cpublic");
    let store = Arc::new(PostgresStore::new(&scoped_url, 8).await.unwrap());
    let applied_migrations =
        sqlx::query_scalar::<_, String>("SELECT version FROM schema_migrations ORDER BY version")
            .fetch_all(store.pool())
            .await
            .unwrap()
            .into_iter()
            .collect::<std::collections::HashSet<_>>();
    for version in [
        "20260718_01_supported_capabilities",
        "20260719_01_session_projections",
        "20260720_01_recall_projection",
        "20260720_02_cognitive_clock",
        "20260723_01_recall_outbox_attention_projection",
        "20260719_02_action_groups",
        "20260718_02_execution_jobs",
        "20260721_01_execution_targets",
        "20260721_02_edge_execution",
        "20260718_03_approvals",
        "20260718_04_threads",
        "20260718_05_activations",
        "20260718_06_schedules",
        "20260718_07_delivery",
        "20260718_08_delegations",
        "20260731_01_scheduler_dependencies",
        "20260805_01_recall_chunked_index",
        "20260805_02_recall_chunk_event_backfill",
    ] {
        assert!(
            applied_migrations.contains(version),
            "missing PostgreSQL migration marker {version}"
        );
    }
    store
        .create_agent_bundle(
            NewAgent {
                id: "conformance-agent".to_string(),
                title: "Conformance Agent".to_string(),
                root_context_id: "conformance-context".to_string(),
            },
            NewCognitiveContext {
                id: "conformance-context".to_string(),
                agent_id: "conformance-agent".to_string(),
                title: "Conformance Context".to_string(),
            },
            NewSession {
                id: "conformance-session".to_string(),
                agent_id: "conformance-agent".to_string(),
                context_id: "conformance-context".to_string(),
                parent_session_id: None,
                title: "Conformance Session".to_string(),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await
        .unwrap();
    assert_session_directory_conformance(Arc::clone(&store)).await;
    assert_context_transaction_conformance(Arc::clone(&store), |store, session_id| {
        Box::pin(async move {
            Ok(store.get_session(session_id).await?.map(|session| {
                (
                    session.attention_state,
                    session.attention_revision,
                    session.attention_event_id,
                )
            }))
        })
    })
    .await;
    assert_session_projection_conformance(Arc::clone(&store)).await;
    assert_recall_projection_conformance(Arc::clone(&store)).await;
    assert_thread_store_conformance(Arc::clone(&store)).await;
    assert_activation_store_conformance(Arc::clone(&store)).await;
    assert_scheduler_dependency_conformance(Arc::clone(&store)).await;
    assert_schedule_store_conformance(Arc::clone(&store)).await;
    assert_delivery_ingress_conformance(Arc::clone(&store)).await;
    assert_delegation_store_conformance(Arc::clone(&store)).await;
    assert_timer_lease_conformance(Arc::clone(&store)).await;
    assert_objective_lease_conformance(Arc::clone(&store)).await;
    store
        .ensure_thread_activation(NewThreadActivation {
            id: "conformance-activation".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            session_id: "conformance-session".to_string(),
            initiating_principal_id: None,
            trigger_event_id: "trigger-conformance-activation".to_string(),
            trigger_sequence: 1,
            trigger_kind: "conformance".to_string(),
            parent_activation_id: None,
            root_turn_id: "root-conformance-thread".to_string(),
        })
        .await
        .unwrap();
    assert_action_group_conformance(Arc::clone(&store)).await;
    assert_execution_target_conformance(Arc::clone(&store)).await;
    assert_execution_target_authorization_conformance(Arc::clone(&store)).await;
    assert_capability_lease_conformance(Arc::clone(&store)).await;
    assert_edge_execution_conformance(Arc::clone(&store)).await;
    assert_execution_job_conformance(Arc::clone(&store)).await;
    assert_approval_grant_conformance(Arc::clone(&store)).await;

    let migration_observation = Event::new(
        "postgres-session-projection-migration-observation".to_string(),
        "Store-Conformance".to_string(),
        morphz::event::TYPE_USER_MESSAGE.to_string(),
        "chat/user_message".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session",
            "text": "postgres migration backfill"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    store.append(migration_observation.clone()).await.unwrap();
    let mut migration_reset = store.pool().begin().await.unwrap();
    sqlx::query("DELETE FROM session_projections WHERE event_id = $1")
        .bind(&migration_observation.id)
        .execute(&mut *migration_reset)
        .await
        .unwrap();
    sqlx::query("DELETE FROM schema_migrations WHERE version = $1")
        .bind("20260719_01_session_projections")
        .execute(&mut *migration_reset)
        .await
        .unwrap();
    migration_reset.commit().await.unwrap();

    let independent_store = Arc::new(PostgresStore::new(&scoped_url, 8).await.unwrap());
    assert!(independent_store
        .query_session_projections(
            "conformance-context",
            &["conformance-session".to_string()],
            true,
        )
        .await
        .unwrap()
        .iter()
        .any(|event| event.id == migration_observation.id));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM schema_migrations WHERE version = $1",)
            .bind("20260719_01_session_projections")
            .fetch_one(independent_store.pool())
            .await
            .unwrap(),
        1
    );
    assert_independent_postgres_instances_share_fenced_authority(
        Arc::clone(&store),
        Arc::clone(&independent_store),
    )
    .await;
    // This helper creates another isolated schema, so it must derive that
    // schema from the base database URL instead of stacking a second
    // `options=search_path` parameter on this run's already-scoped URL.
    assert_two_postgres_runtimes_deliver_one_dialogue_once(&database_url, &store).await;
}
