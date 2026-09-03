use morphz::approval_authority::stable_approval_identity;
use morphz::config::AppConfig;
use morphz::context_state::MindState;
use morphz::context_store::context_state_hash;
use morphz::event::Event;
use morphz::execution::ExecutionJobManager;
use morphz::llm::{Client, Message, Response, ToolDefinition};
use morphz::memory::postgres::PostgresStore;
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{
    objective_primary_execution_root_id, stable_thread_id, stable_thread_signal_id,
    thread_supersede_event, ActivationStore, EdgeCommandMutation, EdgeCommandStatus,
    EdgeExecutionStore, EdgeOutputStream, ExecutionNodeMutation, ExecutionNodeStatus,
    SessionDirectoryStore,
};
use morphz::memory::{
    ActionGroupFilter, ActionGroupMemberStatus, ActionGroupStatus, ActionGroupStore,
    ActivationOutcomeCommit, AgentProviderBindingStore, ApprovalMutation, ApprovalResolution,
    ApprovalStatus, ApprovalStore, CapabilityLeaseFilter, CapabilityLeaseMutation,
    CapabilityLeaseRestriction, CapabilityLeaseScope, CapabilityLeaseStatus, CapabilityLeaseStore,
    CognitiveClockStore, ContextActivationCausalitySnapshot, ContextExecutionResourcesSnapshot,
    ContextRuntimeDirectoryRequest, ContextRuntimeSchedulerSnapshot, ContextRuntimeSessionFilter,
    DelegationFilter, DelegationStatus, DelegationStore, DeliveryFlushCommit, DeliveryIngressStore,
    DeliveryStatus, EventAppend, EventStore, ExecutionApprovalMutation, ExecutionApprovalStore,
    ExecutionJobMutation, ExecutionJobStatus, ExecutionJobStore, ExecutionJobTerminal,
    ExecutionRetrySafety, ExecutionTargetAuthorizationFilter, ExecutionTargetAuthorizationMutation,
    ExecutionTargetAuthorizationScope, ExecutionTargetAuthorizationStatus,
    ExecutionTargetAuthorizationStore, ExecutionTargetFilter, ExecutionTargetKind,
    ExecutionTargetMutation, ExecutionTargetRegistration, ExecutionTargetStatus,
    ExecutionTargetStore, MessageClaim, MessageDispatchMode, MindProjectionCommit,
    MindProjectionStore, NewActionGroup, NewActionGroupMember, NewAgent, NewApprovalRequest,
    NewCapabilityLease, NewCognitiveContext, NewDelegation, NewEdgeCommand, NewExecutionJob,
    NewExecutionNodeChallenge, NewExecutionTargetAuthorization, NewMindProjection,
    NewNodePairingCode, NewObjective, NewPrincipal, NewRuntimeTimer, NewSession, NewThread,
    NewThreadActivation, NewThreadSignal, ObjectiveMutation, ObjectiveStatus, ObjectiveStore,
    ObjectiveWaitCondition, PairExecutionNode, ProviderAccountStateMutation,
    ProviderAccountStateStore, ProviderAccountStatus, QueryFilter, RecallDocument,
    RecallDocumentKind, RecallProjectionStore, RuntimeTimerKind, RuntimeTimerStatus,
    ScheduleMutation, ScheduleStatus, ScheduleStore, SessionAttentionState, SessionAttentionUpdate,
    SessionContextSharing, SessionMountKind, SessionProjectionMutation, SessionProjectionStore,
    SessionSignalClaim, SessionStatus, SessionUpdate, SignalOutboxStatus, StorageMaintenanceStore,
    ThreadActivationMutation, ThreadActivationStatus, ThreadControlAction, ThreadGroupStore,
    ThreadKind, ThreadLifecycle, ThreadMutation, ThreadSignalStatus, ThreadStore,
    ThreadSupervision, TimerStore, TransientStorageRetention,
};
use morphz::permission::{PermissionMode, ReviewerKind, SandboxMode};
use morphz::runtime::{MorphzRuntime, RuntimeIdentity, RuntimeToolPolicy};
use morphz::scheduler::{
    KernelResult, NewSchedulerDependency, SchedulerDependencyFilter, SchedulerDependencyKind,
    SchedulerDependencyMutation, SchedulerDependencyOwnerKind, SchedulerDependencyStatus,
    SchedulerDependencyStore, SchedulerKernel,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::future::Future;
use std::pin::Pin;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use tempfile::{NamedTempFile, TempDir};
use tokio::sync::Barrier;

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
                    None,
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
            .ensure_agent(NewAgent {
                id: "sqlite-process-agent".to_string(),
                title: "SQLite Process Agent".to_string(),
                root_context_id: "sqlite-process-context".to_string(),
            })
            .await
            .unwrap();
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

struct ProcessDelayedReplyClient {
    call_marker: std::path::PathBuf,
}

#[async_trait::async_trait]
impl Client for ProcessDelayedReplyClient {
    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
    ) -> Result<Response, TestError> {
        std::fs::write(&self.call_marker, b"called")?;
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        Ok(Response {
            content: "multi-process-delayed-ok".to_string(),
            tool_calls: Vec::new(),
        })
    }
}

#[test]
fn sqlite_two_process_runtimes_keep_one_long_activation_owner() {
    const ROLE_ENV: &str = "MORPHZ_TEST_RUNTIME_PROCESS_ROLE";
    const DB_ENV: &str = "MORPHZ_TEST_RUNTIME_PROCESS_DB";
    const SYNC_ENV: &str = "MORPHZ_TEST_RUNTIME_PROCESS_SYNC";
    if let Ok(role) = std::env::var(ROLE_ENV) {
        let database = std::env::var(DB_ENV).unwrap();
        let sync = std::path::PathBuf::from(std::env::var(SYNC_ENV).unwrap());
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let store = Arc::new(SqliteStore::new(&database).await.unwrap());
            let mut config = AppConfig::default();
            config.permissions.mode = PermissionMode::Custom;
            config.permissions.reviewer = ReviewerKind::Deny;
            config.orchestrator.activation_lease_secs = 2;
            let client = Arc::new(ProcessDelayedReplyClient {
                call_marker: sync.join(format!("call-{role}")),
            });
            let runtime = MorphzRuntime::builder(config, client)
                .store(
                    format!("sqlite:process-runtime-{role}"),
                    store as Arc<dyn morphz::memory::RuntimeStore>,
                )
                .identity(RuntimeIdentity {
                    agent_id: "sqlite-process-runtime-agent".to_string(),
                    context_id: format!("sqlite-process-runtime-context-{role}"),
                    principal_id: format!("principal:sqlite-process-runtime-{role}"),
                })
                .tool_policy(RuntimeToolPolicy {
                    context_only: true,
                    coding_eval: true,
                })
                .build()
                .await
                .unwrap();
            runtime.start().await.unwrap();
            let mut replies = runtime.subscribe("chat/reply", 4);
            std::fs::write(sync.join(format!("ready-{role}")), b"ready").unwrap();
            while !sync.join("go").exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            if role == "a" {
                runtime
                    .session("sqlite-process-runtime-session-a")
                    .send(
                        "cross several lease windows",
                        "Store-Conformance",
                        Some("sqlite-process-runtime-message".to_string()),
                    )
                    .await
                    .unwrap();
            }
            // The model call deliberately spans several two-second lease
            // windows. Leave enough wall-clock headroom for this child
            // process to share a loaded test host with the other
            // multi-process conformance cases; the assertions below, rather
            // than a tight scheduler deadline, define the ownership
            // invariant under test.
            tokio::time::timeout(std::time::Duration::from_secs(20), async {
                loop {
                    tokio::select! {
                        reply = replies.recv() => {
                            if let Some(reply) = reply {
                                assert_eq!(reply.payload["text"], "multi-process-delayed-ok");
                                std::fs::write(sync.join(format!("reply-{role}")), b"reply").unwrap();
                                std::fs::write(sync.join("done"), b"done").unwrap();
                                break;
                            }
                        }
                        _ = tokio::time::sleep(std::time::Duration::from_millis(25)) => {
                            if sync.join("done").exists() {
                                break;
                            }
                        }
                    }
                }
            })
            .await
            .expect("one process Runtime must finish the shared Activation");
        });
        return;
    }

    let temp = TempDir::new().unwrap();
    let database = temp.path().join("shared-runtime.db");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let store = SqliteStore::new(database.to_str().unwrap()).await.unwrap();
        store
            .create_agent_bundle(
                NewAgent {
                    id: "sqlite-process-runtime-agent".to_string(),
                    title: "SQLite Process Runtime Agent".to_string(),
                    root_context_id: "sqlite-process-runtime-context-a".to_string(),
                },
                NewCognitiveContext {
                    id: "sqlite-process-runtime-context-a".to_string(),
                    agent_id: "sqlite-process-runtime-agent".to_string(),
                    title: "SQLite Process Runtime Context A".to_string(),
                },
                NewSession {
                    id: "sqlite-process-runtime-session-a".to_string(),
                    agent_id: "sqlite-process-runtime-agent".to_string(),
                    context_id: "sqlite-process-runtime-context-a".to_string(),
                    parent_session_id: None,
                    title: "SQLite Process Runtime Session A".to_string(),
                    mount_kind: SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        store
            .create_context(NewCognitiveContext {
                id: "sqlite-process-runtime-context-b".to_string(),
                agent_id: "sqlite-process-runtime-agent".to_string(),
                title: "SQLite Process Runtime Context B".to_string(),
            })
            .await
            .unwrap();
        store
            .create_session(NewSession {
                id: "sqlite-process-runtime-session-b".to_string(),
                agent_id: "sqlite-process-runtime-agent".to_string(),
                context_id: "sqlite-process-runtime-context-b".to_string(),
                parent_session_id: None,
                title: "SQLite Process Runtime Session B".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
    });

    let executable = std::env::current_exe().unwrap();
    let spawn = |role: &str| {
        Command::new(&executable)
            .arg("--exact")
            .arg("sqlite_two_process_runtimes_keep_one_long_activation_owner")
            .arg("--nocapture")
            .env(ROLE_ENV, role)
            .env(DB_ENV, &database)
            .env(SYNC_ENV, temp.path())
            .spawn()
            .unwrap()
    };
    let mut first = spawn("a");
    let mut second = spawn("b");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while !(temp.path().join("ready-a").exists() && temp.path().join("ready-b").exists()) {
        assert!(
            std::time::Instant::now() < deadline,
            "SQLite Runtime child processes did not reach the shared barrier"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    std::fs::write(temp.path().join("go"), b"go").unwrap();
    assert!(first.wait().unwrap().success());
    assert!(second.wait().unwrap().success());
    let call_count = ["call-a", "call-b"]
        .into_iter()
        .filter(|path| temp.path().join(path).exists())
        .count();
    let reply_count = ["reply-a", "reply-b"]
        .into_iter()
        .filter(|path| temp.path().join(path).exists())
        .count();
    assert_eq!(call_count, 1, "only one process may own the model call");
    assert_eq!(reply_count, 1, "only one process may publish the reply");
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

struct DelayedMultiRuntimeReplyClient {
    calls: AtomicUsize,
    delay: std::time::Duration,
}

#[async_trait::async_trait]
impl Client for DelayedMultiRuntimeReplyClient {
    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
    ) -> Result<Response, TestError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(self.delay).await;
        Ok(Response {
            content: "multi-runtime-delayed-ok".to_string(),
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
    assert_eq!(first.context_sharing, SessionContextSharing::Shared);
    let isolated = store
        .set_session_context_sharing(&race_session.id, SessionContextSharing::Isolated)
        .await
        .unwrap()
        .expect("new Session should remain available for context sharing policy updates");
    assert_eq!(isolated.context_sharing, SessionContextSharing::Isolated);
    assert_eq!(
        store
            .get_session(&race_session.id)
            .await
            .unwrap()
            .unwrap()
            .context_sharing,
        SessionContextSharing::Isolated,
        "context sharing policy must survive a fresh authoritative read"
    );
    store
        .bind_session_principal(&race_session.id, "o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat")
        .await
        .unwrap();

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
                model_alias: Some(Some("session-route-a".to_string())),
                reasoning_effort: Some(Some("high".to_string())),
                permission_mode: Some(Some(PermissionMode::RequestApproval)),
                sandbox_mode: Some(Some(SandboxMode::DangerFullAccess)),
                default_target_id: None,
            },
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(archived.status, SessionStatus::Archived);
    assert_eq!(archived.model_alias.as_deref(), Some("session-route-a"));
    assert_eq!(archived.reasoning_effort.as_deref(), Some("high"));
    assert_eq!(
        archived.permission_mode,
        Some(PermissionMode::RequestApproval)
    );
    assert_eq!(archived.sandbox_mode, Some(SandboxMode::DangerFullAccess));
    let principal_sessions = store
        .list_principal_sessions("o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat", true)
        .await
        .unwrap();
    let projected = principal_sessions
        .iter()
        .find(|session| session.id == race_session.id)
        .expect("Principal Session projection must include the bound Session");
    assert_eq!(projected.model_alias.as_deref(), Some("session-route-a"));
    assert_eq!(projected.reasoning_effort.as_deref(), Some("high"));
    assert_eq!(
        projected.permission_mode,
        Some(PermissionMode::RequestApproval)
    );
    assert_eq!(projected.sandbox_mode, Some(SandboxMode::DangerFullAccess));
    assert_eq!(projected.context_sharing, SessionContextSharing::Isolated);
    let inherited = store
        .update_session(
            &race_session.id,
            SessionUpdate {
                title: None,
                status: None,
                model_alias: Some(None),
                reasoning_effort: Some(None),
                permission_mode: Some(None),
                sandbox_mode: Some(None),
                default_target_id: None,
            },
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        inherited.model_alias, None,
        "clearing a Session model must restore Runtime inheritance"
    );
    assert_eq!(
        inherited.reasoning_effort, None,
        "clearing Session reasoning must restore Provider-default inference"
    );
    assert_eq!(
        inherited.permission_mode, None,
        "clearing a Session permission preset must restore Runtime inheritance"
    );
    assert_eq!(
        inherited.sandbox_mode, None,
        "clearing Session Sandbox must restore the Runtime startup Profile"
    );
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
    let start = Arc::new(Barrier::new(3));
    let first = {
        let store = Arc::clone(&store);
        let thread = thread.clone();
        let start = Arc::clone(&start);
        tokio::spawn(async move {
            start.wait().await;
            store.ensure_thread(thread).await
        })
    };
    let second = {
        let store = Arc::clone(&store);
        let thread = thread.clone();
        let start = Arc::clone(&start);
        tokio::spawn(async move {
            start.wait().await;
            store.ensure_thread(thread).await
        })
    };
    start.wait().await;
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
            .list_session_delivery_threads("conformance-session", false, 64)
            .await
            .unwrap()
            .len(),
        1
    );

    let timer = store
        .arm_delivery_flush_timer(
            "conformance-delivery-timer",
            "conformance-session",
            1,
            5,
            64,
        )
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

    // Supersede is a generation transition of one logical obligation, not a
    // replacement Thread. Both stores must fence old physical work and
    // publish exactly one durable correction Signal without changing the
    // supervision route which owns the eventual outcome.
    let supersede_thread = store
        .ensure_thread(NewThread {
            id: "conformance-supersede-thread".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            session_id: "conformance-session".to_string(),
            initiating_principal_id: None,
            root_turn_id: "root-conformance-supersede-thread".to_string(),
            kind: ThreadKind::Execution,
            executor_kind: "model".to_string(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::legacy(),
        })
        .await
        .unwrap();
    let old_activation = store
        .ensure_thread_activation(NewThreadActivation {
            id: "conformance-supersede-old-activation".to_string(),
            agent_id: supersede_thread.agent_id.clone(),
            context_id: supersede_thread.context_id.clone(),
            session_id: supersede_thread.session_id.clone(),
            initiating_principal_id: None,
            trigger_event_id: "conformance-supersede-old-trigger".to_string(),
            trigger_sequence: 1,
            trigger_kind: "conformance".to_string(),
            parent_activation_id: None,
            root_turn_id: supersede_thread.root_turn_id.clone(),
        })
        .await
        .unwrap();
    let supersede_event = thread_supersede_event(
        &supersede_thread,
        "Use the corrected implementation contract",
        "operator correction",
        "Store-Conformance",
    );
    let superseded = match store
        .supersede_thread(
            &supersede_thread.id,
            supersede_thread.revision,
            &supersede_event,
        )
        .await
        .unwrap()
    {
        ThreadMutation::Updated(thread) => thread,
        mutation => panic!("unexpected Thread supersede mutation: {mutation:?}"),
    };
    assert_eq!(superseded.id, supersede_thread.id);
    assert_eq!(superseded.generation, supersede_thread.generation + 1);
    assert_eq!(superseded.revision, supersede_thread.revision + 1);
    assert_eq!(superseded.lifecycle, ThreadLifecycle::Open);
    assert_eq!(superseded.supervision, supersede_thread.supervision);
    assert_eq!(
        store
            .get_thread_activation(&old_activation.id)
            .await
            .unwrap()
            .unwrap()
            .status,
        ThreadActivationStatus::Cancelled
    );
    let correction_signals = store
        .list_context_thread_signals("conformance-context", Some(ThreadSignalStatus::Pending))
        .await
        .unwrap()
        .into_iter()
        .filter(|signal| signal.event_id == supersede_event.id)
        .collect::<Vec<_>>();
    assert_eq!(correction_signals.len(), 1);
    assert_eq!(correction_signals[0].thread_id, superseded.id);
    assert_eq!(
        correction_signals[0].thread_generation,
        superseded.generation
    );
    assert_eq!(
        store
            .query(QueryFilter {
                event_id: Some(supersede_event.id.clone()),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(matches!(
        store
            .supersede_thread(
                &supersede_thread.id,
                supersede_thread.revision,
                &supersede_event,
            )
            .await
            .unwrap(),
        ThreadMutation::Conflict { .. }
    ));
    assert_eq!(
        store
            .query(QueryFilter {
                event_id: Some(supersede_event.id),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1,
        "a stale supersede retry must not duplicate its durable correction"
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
    let first_binding = store
        .bind_thread_activation_model(&first.id, "evaluation-route-a")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        first_binding.model_alias.as_deref(),
        Some("evaluation-route-a")
    );
    let replayed_binding = store
        .bind_thread_activation_model(&first.id, "evaluation-route-b")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        replayed_binding.model_alias.as_deref(),
        Some("evaluation-route-a"),
        "an Evaluation model is immutable after the first durable binding"
    );
    let first_reasoning = store
        .bind_thread_activation_reasoning_effort(&first.id, "high")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first_reasoning.reasoning_effort.as_deref(), Some("high"));
    let replayed_reasoning = store
        .bind_thread_activation_reasoning_effort(&first.id, "low")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        replayed_reasoning.reasoning_effort.as_deref(),
        Some("high"),
        "an Evaluation reasoning policy is immutable after its first durable binding"
    );
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

    // A Signal that arrives after an Activation has started remains pending
    // until it is actually compiled into a physical model request. Binding is
    // the durable ownership boundary and must be identical on both stores.
    let supplemental_event = Event::new(
        "conformance-signal-event-supplemental".to_string(),
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
        .append_to_thread(supplemental_event.clone(), &thread.id)
        .await
        .unwrap();
    assert_eq!(
        store
            .next_pending_thread_signal(&thread.id)
            .await
            .unwrap()
            .as_ref()
            .map(|signal| signal.event_id.as_str()),
        Some(supplemental_event.id.as_str())
    );
    let bound = store
        .bind_activation_input_signals(
            &first.id,
            &[
                supplemental_event.id.clone(),
                "event-without-signal".to_string(),
            ],
        )
        .await
        .unwrap();
    assert_eq!(bound.len(), 1);
    assert_eq!(bound[0].event_id, supplemental_event.id);
    assert_eq!(bound[0].status, ThreadSignalStatus::Claimed);
    assert!(store
        .next_pending_thread_signal(&thread.id)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        store
            .list_activation_signals(&first.id)
            .await
            .unwrap()
            .len(),
        2
    );
    let replayed = store
        .bind_activation_input_signals(&first.id, std::slice::from_ref(&supplemental_event.id))
        .await
        .unwrap();
    assert_eq!(replayed.len(), 1, "binding must be idempotent on recovery");
    assert_eq!(replayed[0].event_id, supplemental_event.id);

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
            ready_signal_event_ids: Vec::new(),
            ready_supervisor_event_ids: Vec::new()
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
                    ThreadControlAction::Cancel,
                    Some("operator cancels while result arrives"),
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

async fn assert_dialogue_interruption_conformance<S>(store: Arc<S>)
where
    S: morphz::memory::RuntimeStore + 'static,
{
    let session_id = "conformance-dialogue-interruption";
    store
        .create_session(NewSession {
            id: session_id.to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            parent_session_id: Some("conformance-session".to_string()),
            title: "Dialogue interruption conformance".to_string(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    store
        .bind_session_principal(session_id, "o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat")
        .await
        .unwrap();
    let message = |id: &str, text: &str| {
        Event::new(
            id.to_string(),
            "Store-Conformance".to_string(),
            morphz::event::TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            json!({
                "context_id": "conformance-context",
                "session_id": session_id,
                "principal_id": "o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat",
                "text": text
            })
            .as_object()
            .unwrap()
            .clone(),
        )
    };
    let first = message("conformance-interrupt-event-a", "first input");
    assert!(matches!(
        store
            .claim_message(
                session_id,
                "conformance-interrupt-client-a",
                &first,
                MessageDispatchMode::FollowUp,
            )
            .await
            .unwrap(),
        MessageClaim::Accepted {
            interrupted: None,
            ..
        }
    ));
    let first_thread = store.get_thread_by_root(&first.id).await.unwrap().unwrap();
    let first_signal = store
        .next_pending_thread_signal(&first_thread.id)
        .await
        .unwrap()
        .unwrap();
    let activation = store
        .claim_thread_signal_batch(
            NewThreadSignal {
                id: stable_thread_signal_id(&first.id),
                thread_id: first_thread.id.clone(),
                thread_generation: first_thread.generation,
                event_id: first.id.clone(),
                principal_id: None,
                sequence: first_signal.sequence,
                kind: first.topic.clone(),
                parent_activation_id: None,
            },
            NewThreadActivation {
                id: "conformance-interrupt-activation-a".to_string(),
                agent_id: "conformance-agent".to_string(),
                context_id: "conformance-context".to_string(),
                session_id: session_id.to_string(),
                initiating_principal_id: None,
                trigger_event_id: first.id.clone(),
                trigger_sequence: first_signal.sequence,
                trigger_kind: first.topic.clone(),
                parent_activation_id: None,
                root_turn_id: first.id.clone(),
            },
            32,
        )
        .await
        .unwrap()
        .unwrap();
    let running = match store
        .update_thread_activation(
            &activation.id,
            activation.revision,
            ThreadActivationStatus::Running,
            Some("conformance-interrupt-worker"),
            Some(chrono::Utc::now() + chrono::Duration::seconds(30)),
            None,
        )
        .await
        .unwrap()
    {
        ThreadActivationMutation::Updated(record) => record,
        other => panic!("unexpected Activation mutation: {other:?}"),
    };

    let second = message("conformance-interrupt-event-b", "second input");
    assert!(matches!(
        store
            .claim_message(
                session_id,
                "conformance-interrupt-client-b",
                &second,
                MessageDispatchMode::Interrupt,
            )
            .await
            .unwrap(),
        MessageClaim::Accepted {
            interrupted: Some(_),
            ..
        }
    ));
    assert_eq!(
        store
            .get_thread_activation(&running.id)
            .await
            .unwrap()
            .unwrap()
            .status,
        ThreadActivationStatus::Cancelled
    );

    let replacement = store.get_thread_by_root(&second.id).await.unwrap().unwrap();
    let pending = store
        .list_context_thread_signals("conformance-context", Some(ThreadSignalStatus::Pending))
        .await
        .unwrap()
        .into_iter()
        .filter(|signal| signal.thread_id == replacement.id)
        .collect::<Vec<_>>();
    assert_eq!(
        pending
            .iter()
            .map(|signal| signal.event_id.as_str())
            .collect::<Vec<_>>(),
        vec![first.id.as_str(), second.id.as_str()]
    );
    let replacement_activation = store
        .claim_thread_signal_batch(
            NewThreadSignal {
                id: stable_thread_signal_id(&second.id),
                thread_id: replacement.id.clone(),
                thread_generation: replacement.generation,
                event_id: second.id.clone(),
                principal_id: None,
                sequence: pending[1].sequence,
                kind: second.topic.clone(),
                parent_activation_id: None,
            },
            NewThreadActivation {
                id: "conformance-interrupt-activation-b".to_string(),
                agent_id: "conformance-agent".to_string(),
                context_id: "conformance-context".to_string(),
                session_id: session_id.to_string(),
                initiating_principal_id: None,
                trigger_event_id: second.id.clone(),
                trigger_sequence: pending[1].sequence,
                trigger_kind: second.topic.clone(),
                parent_activation_id: None,
                root_turn_id: second.id.clone(),
            },
            32,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(replacement_activation.trigger_event_id, second.id);
    assert_eq!(
        store
            .list_activation_signals(&replacement_activation.id)
            .await
            .unwrap()
            .iter()
            .map(|signal| signal.event_id.as_str())
            .collect::<Vec<_>>(),
        vec![first.id.as_str(), second.id.as_str()]
    );

    let replacement_running = match store
        .update_thread_activation(
            &replacement_activation.id,
            replacement_activation.revision,
            ThreadActivationStatus::Running,
            Some("conformance-interrupt-worker-b"),
            Some(chrono::Utc::now() + chrono::Duration::seconds(30)),
            None,
        )
        .await
        .unwrap()
    {
        ThreadActivationMutation::Updated(record) => record,
        other => panic!("unexpected replacement Activation mutation: {other:?}"),
    };
    assert!(store
        .release_dialogue_turn_activation(&replacement_running.id, chrono::Utc::now())
        .await
        .unwrap());

    let third = message("conformance-interrupt-event-c", "third input");
    assert!(matches!(
        store
            .claim_message(
                session_id,
                "conformance-interrupt-client-c",
                &third,
                MessageDispatchMode::Interrupt,
            )
            .await
            .unwrap(),
        MessageClaim::Accepted {
            interrupted: None,
            ..
        }
    ));
    assert_eq!(
        store
            .get_thread_activation(&replacement_running.id)
            .await
            .unwrap()
            .unwrap()
            .status,
        ThreadActivationStatus::Running,
        "once execution has released the dialogue lane, a follow-up message must not cancel it"
    );

    let dispatch_session_id = "conformance-dialogue-dispatch";
    store
        .create_session(NewSession {
            id: dispatch_session_id.to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            parent_session_id: Some("conformance-session".to_string()),
            title: "Dialogue dispatch conformance".to_string(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    store
        .bind_session_principal(
            dispatch_session_id,
            "o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat",
        )
        .await
        .unwrap();
    let dispatch_message = |id: &str, text: &str| {
        Event::new(
            id.to_string(),
            "Store-Conformance".to_string(),
            morphz::event::TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            json!({
                "context_id": "conformance-context",
                "session_id": dispatch_session_id,
                "principal_id": "o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat",
                "text": text
            })
            .as_object()
            .unwrap()
            .clone(),
        )
    };

    let first = dispatch_message("conformance-dispatch-event-a", "first serial input");
    store
        .claim_message(
            dispatch_session_id,
            "conformance-dispatch-client-a",
            &first,
            MessageDispatchMode::FollowUp,
        )
        .await
        .unwrap();
    let first_thread = store.get_thread_by_root(&first.id).await.unwrap().unwrap();
    let first_signal = store
        .next_pending_thread_signal(&first_thread.id)
        .await
        .unwrap()
        .unwrap();
    let first_activation = store
        .claim_thread_signal_batch(
            NewThreadSignal {
                id: stable_thread_signal_id(&first.id),
                thread_id: first_thread.id.clone(),
                thread_generation: first_thread.generation,
                event_id: first.id.clone(),
                principal_id: None,
                sequence: first_signal.sequence,
                kind: first.topic.clone(),
                parent_activation_id: None,
            },
            NewThreadActivation {
                id: "conformance-dispatch-activation-a".to_string(),
                agent_id: "conformance-agent".to_string(),
                context_id: "conformance-context".to_string(),
                session_id: dispatch_session_id.to_string(),
                initiating_principal_id: None,
                trigger_event_id: first.id.clone(),
                trigger_sequence: first_signal.sequence,
                trigger_kind: first.topic.clone(),
                parent_activation_id: None,
                root_turn_id: first.id.clone(),
            },
            32,
        )
        .await
        .unwrap()
        .unwrap();
    let first_running = match store
        .update_thread_activation(
            &first_activation.id,
            first_activation.revision,
            ThreadActivationStatus::Running,
            Some("conformance-dispatch-worker-a"),
            Some(chrono::Utc::now() + chrono::Duration::seconds(30)),
            None,
        )
        .await
        .unwrap()
    {
        ThreadActivationMutation::Updated(record) => record,
        other => panic!("unexpected first dispatch Activation mutation: {other:?}"),
    };

    let follow_up = dispatch_message("conformance-dispatch-event-b", "strict follow-up");
    let routed_follow_up = match store
        .claim_message(
            dispatch_session_id,
            "conformance-dispatch-client-b",
            &follow_up,
            MessageDispatchMode::FollowUp,
        )
        .await
        .unwrap()
    {
        MessageClaim::Accepted { event, .. } => event,
        other => panic!("unexpected follow-up claim: {other:?}"),
    };
    assert_eq!(
        routed_follow_up
            .payload
            .get("dispatch_mode")
            .and_then(serde_json::Value::as_str),
        Some("follow_up")
    );
    assert_eq!(
        routed_follow_up
            .payload
            .get("after_thread_id")
            .and_then(serde_json::Value::as_str),
        Some(first_thread.id.as_str())
    );
    let follow_up_thread = store
        .get_thread_by_root(&follow_up.id)
        .await
        .unwrap()
        .unwrap();
    let follow_up_signal = store
        .next_pending_thread_signal(&follow_up_thread.id)
        .await
        .unwrap()
        .unwrap();
    let follow_up_activation = store
        .claim_thread_signal_batch(
            NewThreadSignal {
                id: stable_thread_signal_id(&follow_up.id),
                thread_id: follow_up_thread.id.clone(),
                thread_generation: follow_up_thread.generation,
                event_id: follow_up.id.clone(),
                principal_id: None,
                sequence: follow_up_signal.sequence,
                kind: follow_up.topic.clone(),
                parent_activation_id: None,
            },
            NewThreadActivation {
                id: "conformance-dispatch-activation-b".to_string(),
                agent_id: "conformance-agent".to_string(),
                context_id: "conformance-context".to_string(),
                session_id: dispatch_session_id.to_string(),
                initiating_principal_id: None,
                trigger_event_id: follow_up.id.clone(),
                trigger_sequence: follow_up_signal.sequence,
                trigger_kind: follow_up.topic.clone(),
                parent_activation_id: None,
                root_turn_id: follow_up.id.clone(),
            },
            32,
        )
        .await
        .unwrap()
        .unwrap();
    assert!(!store
        .dialogue_turn_activation_runnable(&follow_up_activation.id)
        .await
        .unwrap());

    assert!(matches!(
        store
            .update_thread_activation(
                &first_running.id,
                first_running.revision,
                ThreadActivationStatus::Succeeded,
                None,
                None,
                None,
            )
            .await
            .unwrap(),
        ThreadActivationMutation::Updated(_)
    ));
    let first_thread = store.get_thread(&first_thread.id).await.unwrap().unwrap();
    assert!(matches!(
        store
            .update_thread(
                &first_thread.id,
                first_thread.revision,
                None,
                Some(ThreadLifecycle::Completed),
                Some("first serial reply"),
                Some("conformance-dispatch-reply-a"),
                Some(DeliveryStatus::Delivered),
                Some("conformance-dispatch-reply-a"),
            )
            .await
            .unwrap(),
        ThreadMutation::Updated(_)
    ));
    assert!(store
        .dialogue_turn_activation_runnable(&follow_up_activation.id)
        .await
        .unwrap());
    assert!(matches!(
        store
            .update_thread_activation(
                &follow_up_activation.id,
                follow_up_activation.revision,
                ThreadActivationStatus::Running,
                Some("conformance-dispatch-worker-b"),
                Some(chrono::Utc::now() + chrono::Duration::seconds(30)),
                None,
            )
            .await
            .unwrap(),
        ThreadActivationMutation::Updated(_)
    ));

    let parallel = dispatch_message("conformance-dispatch-event-c", "parallel input");
    let routed_parallel = match store
        .claim_message(
            dispatch_session_id,
            "conformance-dispatch-client-c",
            &parallel,
            MessageDispatchMode::Parallel,
        )
        .await
        .unwrap()
    {
        MessageClaim::Accepted { event, .. } => event,
        other => panic!("unexpected parallel claim: {other:?}"),
    };
    assert_eq!(
        routed_parallel
            .payload
            .get("dispatch_mode")
            .and_then(serde_json::Value::as_str),
        Some("parallel")
    );
    assert!(routed_parallel.payload.get("after_thread_id").is_none());
    let parallel_thread = store
        .get_thread_by_root(&parallel.id)
        .await
        .unwrap()
        .unwrap();
    let parallel_signal = store
        .next_pending_thread_signal(&parallel_thread.id)
        .await
        .unwrap()
        .unwrap();
    let parallel_activation = store
        .claim_thread_signal_batch(
            NewThreadSignal {
                id: stable_thread_signal_id(&parallel.id),
                thread_id: parallel_thread.id.clone(),
                thread_generation: parallel_thread.generation,
                event_id: parallel.id.clone(),
                principal_id: None,
                sequence: parallel_signal.sequence,
                kind: parallel.topic.clone(),
                parent_activation_id: None,
            },
            NewThreadActivation {
                id: "conformance-dispatch-activation-c".to_string(),
                agent_id: "conformance-agent".to_string(),
                context_id: "conformance-context".to_string(),
                session_id: dispatch_session_id.to_string(),
                initiating_principal_id: None,
                trigger_event_id: parallel.id.clone(),
                trigger_sequence: parallel_signal.sequence,
                trigger_kind: parallel.topic.clone(),
                parent_activation_id: None,
                root_turn_id: parallel.id.clone(),
            },
            32,
        )
        .await
        .unwrap()
        .unwrap();
    assert!(store
        .dialogue_turn_activation_runnable(&parallel_activation.id)
        .await
        .unwrap());

    // A Provider wait ends the physical Activation but intentionally leaves
    // the logical DialogueTurn open. An interrupt must replace that suspended
    // turn just like an in-flight model call; otherwise a later Provider
    // health/configuration recovery can replay the obsolete user message long
    // after newer messages have completed.
    let wait_session_id = "conformance-dialogue-provider-wait-interruption";
    store
        .create_session(NewSession {
            id: wait_session_id.to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            parent_session_id: Some("conformance-session".to_string()),
            title: "Provider wait interruption conformance".to_string(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    store
        .bind_session_principal(wait_session_id, "o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat")
        .await
        .unwrap();
    let wait_message = |id: &str, text: &str| {
        Event::new(
            id.to_string(),
            "Store-Conformance".to_string(),
            morphz::event::TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            json!({
                "context_id": "conformance-context",
                "session_id": wait_session_id,
                "principal_id": "o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat",
                "text": text
            })
            .as_object()
            .unwrap()
            .clone(),
        )
    };
    let waiting_message = wait_message(
        "conformance-provider-wait-interrupt-event-a",
        "obsolete waiting input",
    );
    store
        .claim_message(
            wait_session_id,
            "conformance-provider-wait-interrupt-client-a",
            &waiting_message,
            MessageDispatchMode::FollowUp,
        )
        .await
        .unwrap();
    let waiting_thread = store
        .get_thread_by_root(&waiting_message.id)
        .await
        .unwrap()
        .unwrap();
    let waiting_signal = store
        .next_pending_thread_signal(&waiting_thread.id)
        .await
        .unwrap()
        .unwrap();
    let waiting_activation = store
        .claim_thread_signal_batch(
            NewThreadSignal {
                id: stable_thread_signal_id(&waiting_message.id),
                thread_id: waiting_thread.id.clone(),
                thread_generation: waiting_thread.generation,
                event_id: waiting_message.id.clone(),
                principal_id: None,
                sequence: waiting_signal.sequence,
                kind: waiting_message.topic.clone(),
                parent_activation_id: None,
            },
            NewThreadActivation {
                id: "conformance-provider-wait-interrupt-activation-a".to_string(),
                agent_id: "conformance-agent".to_string(),
                context_id: "conformance-context".to_string(),
                session_id: wait_session_id.to_string(),
                initiating_principal_id: None,
                trigger_event_id: waiting_message.id.clone(),
                trigger_sequence: waiting_signal.sequence,
                trigger_kind: waiting_message.topic.clone(),
                parent_activation_id: None,
                root_turn_id: waiting_message.id.clone(),
            },
            32,
        )
        .await
        .unwrap()
        .unwrap();
    let waiting_activation = match store
        .update_thread_activation(
            &waiting_activation.id,
            waiting_activation.revision,
            ThreadActivationStatus::Running,
            Some("conformance-provider-wait-worker"),
            Some(chrono::Utc::now() + chrono::Duration::seconds(30)),
            None,
        )
        .await
        .unwrap()
    {
        ThreadActivationMutation::Updated(record) => record,
        other => panic!("unexpected Provider-wait Activation mutation: {other:?}"),
    };
    let wait_outcome = Event::new(
        "conformance-provider-wait-outcome-a".to_string(),
        "Store-Conformance".to_string(),
        "agent_reply".to_string(),
        "runtime/provider_wait".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": wait_session_id,
            "thread_id": waiting_thread.id,
            "root_turn_id": waiting_thread.root_turn_id,
            "disposition": "provider_wait",
            "provider_resource": "model-route:conformance-provider-wait",
            "provider_wait_generation": 1
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    let dependency_id = match store
        .commit_activation_outcome(&waiting_activation.id, &wait_outcome)
        .await
        .unwrap()
    {
        ActivationOutcomeCommit::Suspended { dependency_id } => dependency_id,
        other => panic!("Provider wait must suspend the DialogueTurn: {other:?}"),
    };
    assert_eq!(
        store
            .get_thread_activation(&waiting_activation.id)
            .await
            .unwrap()
            .unwrap()
            .status,
        ThreadActivationStatus::Succeeded
    );
    assert_eq!(
        store
            .get_thread(&waiting_thread.id)
            .await
            .unwrap()
            .unwrap()
            .lifecycle,
        ThreadLifecycle::Open
    );

    let interrupting_message = wait_message(
        "conformance-provider-wait-interrupt-event-b",
        "new replacement input",
    );
    let interrupted = match store
        .claim_message(
            wait_session_id,
            "conformance-provider-wait-interrupt-client-b",
            &interrupting_message,
            MessageDispatchMode::Interrupt,
        )
        .await
        .unwrap()
    {
        MessageClaim::Accepted {
            interrupted: Some(interrupted),
            ..
        } => interrupted,
        other => panic!("Provider wait must be atomically interrupted: {other:?}"),
    };
    assert_eq!(interrupted.activation_id, waiting_activation.id);
    assert_eq!(interrupted.thread_id, waiting_thread.id);
    assert_eq!(
        store
            .get_thread(&waiting_thread.id)
            .await
            .unwrap()
            .unwrap()
            .lifecycle,
        ThreadLifecycle::Cancelled
    );
    let dependency = store
        .get_scheduler_dependency(&dependency_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(dependency.status, SchedulerDependencyStatus::Cancelled);

    let replacement = store
        .get_thread_by_root(&interrupting_message.id)
        .await
        .unwrap()
        .unwrap();
    let pending = store
        .list_context_thread_signals("conformance-context", Some(ThreadSignalStatus::Pending))
        .await
        .unwrap()
        .into_iter()
        .filter(|signal| signal.thread_id == replacement.id)
        .map(|signal| signal.event_id)
        .collect::<Vec<_>>();
    assert_eq!(
        pending,
        vec![waiting_message.id.clone(), interrupting_message.id.clone()],
        "the interrupted input remains context for the replacement turn without retaining an independently recoverable obligation"
    );

    // Model a later startup/provider recovery using only durable state. The
    // cancelled dependency must reject the wake atomically and the recovery
    // Event must not be appended, so a restart cannot reanimate the old turn.
    let recovery_event = Event::new(
        "conformance-provider-wait-recovery-after-interrupt".to_string(),
        "Runtime-ProviderRecovery".to_string(),
        morphz::event::TYPE_TOOL_OUTPUT.to_string(),
        "runtime/provider_recovered".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": wait_session_id,
            "thread_id": waiting_thread.id,
            "root_turn_id": waiting_thread.root_turn_id,
            "thread_generation": waiting_thread.generation,
            "resource": dependency.dependency_id,
            "dependency_id": dependency.id,
            "runtime_force_evaluation": true,
            "wake_policy": "direct_signal"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    assert!(store
        .satisfy_thread_resource_dependency(
            &dependency.id,
            dependency.owner_generation,
            dependency.dependency_generation,
            "conformance-provider-recovery-fact-after-interrupt",
            &recovery_event,
        )
        .await
        .is_err());
    assert!(store
        .query(QueryFilter {
            event_id: Some(recovery_event.id),
            ..Default::default()
        })
        .await
        .unwrap()
        .is_empty());
}

async fn assert_principal_first_seen_conformance<S>(store: Arc<S>)
where
    S: DeliveryIngressStore + SessionDirectoryStore + Send + Sync + 'static,
{
    const PRINCIPAL_A: &str = "conformance-first-seen-principal-a";
    const PRINCIPAL_B: &str = "conformance-first-seen-principal-b";
    for principal_id in [PRINCIPAL_A, PRINCIPAL_B] {
        store
            .ensure_principal(NewPrincipal {
                id: principal_id.to_string(),
                provider_id: "conformance".to_string(),
                assurance: "verified".to_string(),
                display_name: None,
            })
            .await
            .unwrap();
    }
    for (session_id, principal_id) in [
        ("conformance-first-seen-session-a1", PRINCIPAL_A),
        ("conformance-first-seen-session-a2", PRINCIPAL_A),
        ("conformance-first-seen-session-b", PRINCIPAL_B),
    ] {
        store
            .create_session(NewSession {
                id: session_id.to_string(),
                agent_id: "conformance-agent".to_string(),
                context_id: "conformance-context".to_string(),
                parent_session_id: Some("conformance-session".to_string()),
                title: session_id.to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        store
            .bind_session_principal(session_id, principal_id)
            .await
            .unwrap();
    }

    let claim = |session_id: &'static str,
                 principal_id: &'static str,
                 event_id: &'static str,
                 client_message_id: &'static str| {
        let store = Arc::clone(&store);
        async move {
            let event = Event::new(
                event_id.to_string(),
                "Store-Conformance".to_string(),
                morphz::event::TYPE_USER_MESSAGE.to_string(),
                "chat/user_message".to_string(),
                json!({
                    "context_id": "conformance-context",
                    "session_id": session_id,
                    "principal_id": principal_id,
                    "text": event_id
                })
                .as_object()
                .unwrap()
                .clone(),
            );
            match store
                .claim_message(
                    session_id,
                    client_message_id,
                    &event,
                    MessageDispatchMode::Parallel,
                )
                .await
                .unwrap()
            {
                MessageClaim::Accepted { event, .. } => event,
                other => panic!("unexpected first-seen message claim: {other:?}"),
            }
        }
    };

    let first_a = claim(
        "conformance-first-seen-session-a1",
        PRINCIPAL_A,
        "conformance-first-seen-event-a1",
        "conformance-first-seen-client-a1",
    )
    .await;
    assert_eq!(
        first_a
            .payload
            .get("principal_first_seen_in_context")
            .and_then(serde_json::Value::as_bool),
        Some(true)
    );
    assert_eq!(
        first_a
            .payload
            .get("principal_encounter_id")
            .and_then(serde_json::Value::as_str),
        Some("principal_encounter_conformance-first-seen-event-a1")
    );

    let second_a = claim(
        "conformance-first-seen-session-a1",
        PRINCIPAL_A,
        "conformance-first-seen-event-a2",
        "conformance-first-seen-client-a2",
    )
    .await;
    assert!(!second_a
        .payload
        .contains_key("principal_first_seen_in_context"));

    let other_session_a = claim(
        "conformance-first-seen-session-a2",
        PRINCIPAL_A,
        "conformance-first-seen-event-a3",
        "conformance-first-seen-client-a3",
    )
    .await;
    assert!(!other_session_a
        .payload
        .contains_key("principal_first_seen_in_context"));

    let first_b = claim(
        "conformance-first-seen-session-b",
        PRINCIPAL_B,
        "conformance-first-seen-event-b1",
        "conformance-first-seen-client-b1",
    )
    .await;
    assert_eq!(
        first_b
            .payload
            .get("principal_first_seen_in_context")
            .and_then(serde_json::Value::as_bool),
        Some(true)
    );
}

async fn assert_concurrent_parallel_ingress_conformance<S>(store: Arc<S>)
where
    S: DeliveryIngressStore
        + EventStore
        + SessionDirectoryStore
        + SessionProjectionStore
        + ThreadStore
        + ActivationStore
        + Send
        + Sync
        + 'static,
{
    const PRINCIPAL: &str = "conformance-concurrent-ingress-principal";
    const SESSION: &str = "conformance-concurrent-ingress-session";
    store
        .ensure_principal(NewPrincipal {
            id: PRINCIPAL.to_string(),
            provider_id: "conformance".to_string(),
            assurance: "verified".to_string(),
            display_name: None,
        })
        .await
        .unwrap();
    store
        .create_session(NewSession {
            id: SESSION.to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            parent_session_id: Some("conformance-session".to_string()),
            title: SESSION.to_string(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    store
        .bind_session_principal(SESSION, PRINCIPAL)
        .await
        .unwrap();

    let replay_event = Event::new(
        "conformance-concurrent-replay-event".to_string(),
        "Store-Conformance".to_string(),
        morphz::event::TYPE_USER_MESSAGE.to_string(),
        "chat/user_message".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": SESSION,
            "principal_id": PRINCIPAL,
            "text": "the same client request races itself"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    let replay_barrier = Arc::new(Barrier::new(3));
    let claim = |store: Arc<S>, barrier: Arc<Barrier>| {
        let event = replay_event.clone();
        tokio::spawn(async move {
            barrier.wait().await;
            store
                .claim_message(
                    SESSION,
                    "conformance-concurrent-replay-client",
                    &event,
                    MessageDispatchMode::Parallel,
                )
                .await
        })
    };
    let first = claim(Arc::clone(&store), Arc::clone(&replay_barrier));
    let second = claim(Arc::clone(&store), Arc::clone(&replay_barrier));
    replay_barrier.wait().await;
    let claims = [
        first.await.unwrap().unwrap(),
        second.await.unwrap().unwrap(),
    ];
    assert_eq!(
        claims
            .iter()
            .filter(|claim| matches!(claim, MessageClaim::Accepted { .. }))
            .count(),
        1,
        "one idempotency key must create exactly one accepted message"
    );
    assert_eq!(
        claims
            .iter()
            .filter(|claim| matches!(claim, MessageClaim::Existing { .. }))
            .count(),
        1,
        "the concurrent replay must observe the committed authority"
    );
    let replay_thread = store
        .get_thread_by_root(&replay_event.id)
        .await
        .unwrap()
        .expect("accepted message must own one DialogueTurn");
    assert_eq!(
        store
            .list_context_thread_signals("conformance-context", None)
            .await
            .unwrap()
            .iter()
            .filter(|signal| signal.event_id == replay_event.id)
            .count(),
        1
    );
    assert_eq!(
        store
            .query_session_projections("conformance-context", &[SESSION.to_string()], true)
            .await
            .unwrap()
            .iter()
            .filter(|event| event.id == replay_event.id)
            .count(),
        1,
        "Parallel ingress must project the accepted user message atomically"
    );

    let conflict_barrier = Arc::new(Barrier::new(3));
    let conflicting_claim = |store: Arc<S>, barrier: Arc<Barrier>, suffix: &'static str| {
        tokio::spawn(async move {
            barrier.wait().await;
            let event_id = format!("conformance-concurrent-conflict-event-{suffix}");
            let event = Event::new(
                event_id.clone(),
                "Store-Conformance".to_string(),
                morphz::event::TYPE_USER_MESSAGE.to_string(),
                "chat/user_message".to_string(),
                json!({
                    "context_id": "conformance-context",
                    "session_id": SESSION,
                    "principal_id": PRINCIPAL,
                    "text": format!("conflicting payload {suffix}")
                })
                .as_object()
                .unwrap()
                .clone(),
            );
            let claim = store
                .claim_message(
                    SESSION,
                    "conformance-concurrent-conflict-client",
                    &event,
                    MessageDispatchMode::Parallel,
                )
                .await?;
            Ok::<_, TestError>((event_id, claim))
        })
    };
    let conflict_a = conflicting_claim(Arc::clone(&store), Arc::clone(&conflict_barrier), "a");
    let conflict_b = conflicting_claim(Arc::clone(&store), Arc::clone(&conflict_barrier), "b");
    conflict_barrier.wait().await;
    let conflicting = [
        conflict_a.await.unwrap().unwrap(),
        conflict_b.await.unwrap().unwrap(),
    ];
    let accepted_conflict_event_id = conflicting
        .iter()
        .find_map(|(event_id, claim)| {
            matches!(claim, MessageClaim::Accepted { .. }).then(|| event_id.clone())
        })
        .expect("one conflicting request must win the idempotency key");
    assert_eq!(
        conflicting
            .iter()
            .filter(|(_, claim)| matches!(claim, MessageClaim::Accepted { .. }))
            .count(),
        1
    );
    assert_eq!(
        conflicting
            .iter()
            .filter(|(_, claim)| matches!(claim, MessageClaim::Conflict { .. }))
            .count(),
        1,
        "the losing payload must be reported as a conflict, not as a replay"
    );
    let conflict_authority_event_id = conflicting
        .iter()
        .find_map(|(_, claim)| match claim {
            MessageClaim::Conflict { event_id } => Some(event_id),
            _ => None,
        })
        .expect("the losing request must identify the winning Event");
    assert_eq!(conflict_authority_event_id, &accepted_conflict_event_id);
    let conflicting_event_ids = conflicting
        .iter()
        .map(|(event_id, _)| event_id.clone())
        .collect::<Vec<_>>();
    assert_eq!(
        store
            .query(QueryFilter {
                context_id: Some("conformance-context".to_string()),
                ..Default::default()
            })
            .await
            .unwrap()
            .iter()
            .filter(|event| conflicting_event_ids.contains(&event.id))
            .count(),
        1,
        "a conflicting concurrent request must not leave a second Event"
    );
    assert_eq!(
        store
            .query_session_projections("conformance-context", &[SESSION.to_string()], true)
            .await
            .unwrap()
            .iter()
            .filter(|event| conflicting_event_ids.contains(&event.id))
            .count(),
        1,
        "a conflicting concurrent request must project only its winning Event"
    );

    let independent_barrier = Arc::new(Barrier::new(3));
    let independent_claim = |store: Arc<S>, barrier: Arc<Barrier>, suffix: &'static str| {
        tokio::spawn(async move {
            barrier.wait().await;
            let event_id = format!("conformance-concurrent-independent-{suffix}");
            let event = Event::new(
                event_id.clone(),
                "Store-Conformance".to_string(),
                morphz::event::TYPE_USER_MESSAGE.to_string(),
                "chat/user_message".to_string(),
                json!({
                    "context_id": "conformance-context",
                    "session_id": SESSION,
                    "principal_id": PRINCIPAL,
                    "text": suffix
                })
                .as_object()
                .unwrap()
                .clone(),
            );
            let claim = store
                .claim_message(
                    SESSION,
                    &format!("conformance-concurrent-independent-client-{suffix}"),
                    &event,
                    MessageDispatchMode::Parallel,
                )
                .await?;
            Ok::<_, TestError>((event_id, claim))
        })
    };
    let independent_a =
        independent_claim(Arc::clone(&store), Arc::clone(&independent_barrier), "a");
    let independent_b =
        independent_claim(Arc::clone(&store), Arc::clone(&independent_barrier), "b");
    independent_barrier.wait().await;
    let independent = [
        independent_a.await.unwrap().unwrap(),
        independent_b.await.unwrap().unwrap(),
    ];
    for (event_id, claim) in &independent {
        assert!(matches!(claim, MessageClaim::Accepted { .. }));
        let thread = store
            .get_thread_by_root(event_id)
            .await
            .unwrap()
            .expect("independent Parallel message must retain its own Thread");
        assert_ne!(thread.id, replay_thread.id);
    }
    let projected_independent = store
        .query_session_projections("conformance-context", &[SESSION.to_string()], true)
        .await
        .unwrap();
    for (event_id, _) in &independent {
        assert_eq!(
            projected_independent
                .iter()
                .filter(|event| &event.id == event_id)
                .count(),
            1,
            "each independent Parallel Event must enter Observation exactly once"
        );
    }

    const FIRST_SEEN_PRINCIPAL: &str = "conformance-concurrent-first-seen-principal";
    store
        .ensure_principal(NewPrincipal {
            id: FIRST_SEEN_PRINCIPAL.to_string(),
            provider_id: "conformance".to_string(),
            assurance: "verified".to_string(),
            display_name: None,
        })
        .await
        .unwrap();
    for session_id in [
        "conformance-concurrent-first-seen-session-a",
        "conformance-concurrent-first-seen-session-b",
    ] {
        store
            .create_session(NewSession {
                id: session_id.to_string(),
                agent_id: "conformance-agent".to_string(),
                context_id: "conformance-context".to_string(),
                parent_session_id: Some("conformance-session".to_string()),
                title: session_id.to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        store
            .bind_session_principal(session_id, FIRST_SEEN_PRINCIPAL)
            .await
            .unwrap();
    }
    let first_seen_barrier = Arc::new(Barrier::new(3));
    let first_seen_claim =
        |store: Arc<S>, barrier: Arc<Barrier>, session_id: &'static str, suffix: &'static str| {
            tokio::spawn(async move {
                barrier.wait().await;
                let event = Event::new(
                    format!("conformance-concurrent-first-seen-event-{suffix}"),
                    "Store-Conformance".to_string(),
                    morphz::event::TYPE_USER_MESSAGE.to_string(),
                    "chat/user_message".to_string(),
                    json!({
                        "context_id": "conformance-context",
                        "session_id": session_id,
                        "principal_id": FIRST_SEEN_PRINCIPAL,
                        "text": suffix
                    })
                    .as_object()
                    .unwrap()
                    .clone(),
                );
                store
                    .claim_message(
                        session_id,
                        &format!("conformance-concurrent-first-seen-client-{suffix}"),
                        &event,
                        MessageDispatchMode::Parallel,
                    )
                    .await
            })
        };
    let first_seen_a = first_seen_claim(
        Arc::clone(&store),
        Arc::clone(&first_seen_barrier),
        "conformance-concurrent-first-seen-session-a",
        "a",
    );
    let first_seen_b = first_seen_claim(
        Arc::clone(&store),
        Arc::clone(&first_seen_barrier),
        "conformance-concurrent-first-seen-session-b",
        "b",
    );
    first_seen_barrier.wait().await;
    let first_seen_claims = [
        first_seen_a.await.unwrap().unwrap(),
        first_seen_b.await.unwrap().unwrap(),
    ];
    assert_eq!(
        first_seen_claims
            .iter()
            .filter_map(|claim| match claim {
                MessageClaim::Accepted { event, .. } => Some(event),
                _ => None,
            })
            .filter(|event| {
                event
                    .payload
                    .get("principal_first_seen_in_context")
                    .and_then(serde_json::Value::as_bool)
                    == Some(true)
            })
            .count(),
        1,
        "a Principal's first encounter must remain unique across concurrent Sessions"
    );
}

async fn assert_concurrent_ordered_ingress_conformance<S>(store: Arc<S>)
where
    S: DeliveryIngressStore
        + SessionDirectoryStore
        + ThreadStore
        + ActivationStore
        + Send
        + Sync
        + 'static,
{
    const PRINCIPAL: &str = "conformance-concurrent-ordered-principal";
    store
        .ensure_principal(NewPrincipal {
            id: PRINCIPAL.to_string(),
            provider_id: "conformance".to_string(),
            assurance: "verified".to_string(),
            display_name: None,
        })
        .await
        .unwrap();

    let create_session = |session_id: &'static str| {
        let store = Arc::clone(&store);
        async move {
            store
                .create_session(NewSession {
                    id: session_id.to_string(),
                    agent_id: "conformance-agent".to_string(),
                    context_id: "conformance-context".to_string(),
                    parent_session_id: Some("conformance-session".to_string()),
                    title: session_id.to_string(),
                    mount_kind: SessionMountKind::ExistingContext,
                })
                .await
                .unwrap();
            store
                .bind_session_principal(session_id, PRINCIPAL)
                .await
                .unwrap();
        }
    };

    const FOLLOW_UP_SESSION: &str = "conformance-concurrent-follow-up-session";
    create_session(FOLLOW_UP_SESSION).await;
    let follow_up_barrier = Arc::new(Barrier::new(3));
    let claim_follow_up = |store: Arc<S>, barrier: Arc<Barrier>, suffix: &'static str| {
        tokio::spawn(async move {
            let event_id = format!("conformance-concurrent-follow-up-event-{suffix}");
            let event = Event::new(
                event_id.clone(),
                "Store-Conformance".to_string(),
                morphz::event::TYPE_USER_MESSAGE.to_string(),
                "chat/user_message".to_string(),
                json!({
                    "context_id": "conformance-context",
                    "session_id": FOLLOW_UP_SESSION,
                    "principal_id": PRINCIPAL,
                    "text": suffix
                })
                .as_object()
                .unwrap()
                .clone(),
            );
            barrier.wait().await;
            let claim = store
                .claim_message(
                    FOLLOW_UP_SESSION,
                    &format!("conformance-concurrent-follow-up-client-{suffix}"),
                    &event,
                    MessageDispatchMode::FollowUp,
                )
                .await?;
            Ok::<_, TestError>((event_id, claim))
        })
    };
    let follow_up_a = claim_follow_up(Arc::clone(&store), Arc::clone(&follow_up_barrier), "a");
    let follow_up_b = claim_follow_up(Arc::clone(&store), Arc::clone(&follow_up_barrier), "b");
    follow_up_barrier.wait().await;
    let follow_ups = [
        follow_up_a.await.unwrap().unwrap(),
        follow_up_b.await.unwrap().unwrap(),
    ];
    assert!(follow_ups
        .iter()
        .all(|(_, claim)| matches!(claim, MessageClaim::Accepted { .. })));
    let first = follow_ups
        .iter()
        .find(|(_, claim)| match claim {
            MessageClaim::Accepted { event, .. } => !event.payload.contains_key("after_thread_id"),
            _ => false,
        })
        .expect("the first concurrent follow-up must start the ordered chain");
    let second = follow_ups
        .iter()
        .find(|(_, claim)| match claim {
            MessageClaim::Accepted { event, .. } => event.payload.contains_key("after_thread_id"),
            _ => false,
        })
        .expect("the second concurrent follow-up must observe its committed predecessor");
    let MessageClaim::Accepted {
        event: second_event,
        ..
    } = &second.1
    else {
        unreachable!()
    };
    assert_eq!(
        second_event
            .payload
            .get("after_thread_id")
            .and_then(serde_json::Value::as_str),
        Some(stable_thread_id(&first.0).as_str()),
        "ordered ingress must take its predecessor snapshot after the Session lock"
    );

    const INTERRUPT_SESSION: &str = "conformance-concurrent-interrupt-session";
    create_session(INTERRUPT_SESSION).await;
    let interrupt_barrier = Arc::new(Barrier::new(3));
    let claim_interrupt = |store: Arc<S>, barrier: Arc<Barrier>, suffix: &'static str| {
        tokio::spawn(async move {
            let event_id = format!("conformance-concurrent-interrupt-event-{suffix}");
            let event = Event::new(
                event_id.clone(),
                "Store-Conformance".to_string(),
                morphz::event::TYPE_USER_MESSAGE.to_string(),
                "chat/user_message".to_string(),
                json!({
                    "context_id": "conformance-context",
                    "session_id": INTERRUPT_SESSION,
                    "principal_id": PRINCIPAL,
                    "text": suffix
                })
                .as_object()
                .unwrap()
                .clone(),
            );
            barrier.wait().await;
            let claim = store
                .claim_message(
                    INTERRUPT_SESSION,
                    &format!("conformance-concurrent-interrupt-client-{suffix}"),
                    &event,
                    MessageDispatchMode::Interrupt,
                )
                .await?;
            Ok::<_, TestError>((event_id, claim))
        })
    };
    let interrupt_a = claim_interrupt(Arc::clone(&store), Arc::clone(&interrupt_barrier), "a");
    let interrupt_b = claim_interrupt(Arc::clone(&store), Arc::clone(&interrupt_barrier), "b");
    interrupt_barrier.wait().await;
    let interrupts = [
        interrupt_a.await.unwrap().unwrap(),
        interrupt_b.await.unwrap().unwrap(),
    ];
    assert!(interrupts.iter().all(|(_, claim)| matches!(
        claim,
        MessageClaim::Accepted {
            interrupted: None,
            ..
        }
    )));
    let interrupt_event_ids = interrupts
        .iter()
        .map(|(event_id, _)| event_id.as_str())
        .collect::<Vec<_>>();
    let interrupt_signals = store
        .list_context_thread_signals("conformance-context", None)
        .await
        .unwrap()
        .into_iter()
        .filter(|signal| interrupt_event_ids.contains(&signal.event_id.as_str()))
        .collect::<Vec<_>>();
    assert_eq!(interrupt_signals.len(), 2);
    assert_eq!(
        interrupt_signals[0].thread_id, interrupt_signals[1].thread_id,
        "the second concurrent interrupt must observe and batch into the first pending Thread"
    );
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
    S: ScheduleStore
        + ThreadStore
        + ActivationStore
        + EventStore
        + ObjectiveStore
        + Send
        + Sync
        + 'static,
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
            model_alias: None,
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
            model_alias: None,
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
            model_alias: None,
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
                    None,
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
                    None,
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

    let recurring = store
        .ensure_schedule(morphz::memory::NewSchedule {
            id: "conformance-schedule-recurring".to_string(),
            thread_id: "conformance-dispatch-thread".to_string(),
            source_turn_id: "root-conformance-dispatch-thread".to_string(),
            intent: "dispatch recurring occurrence".to_string(),
            model_alias: None,
            not_before: None,
            interval_seconds: Some(60),
            dependency_thread_ids: Vec::new(),
        })
        .await
        .unwrap();
    let occurrence_root = "root-conformance-schedule-occurrence";
    let occurrence = NewThread {
        id: stable_thread_id(occurrence_root),
        agent_id: "conformance-agent".to_string(),
        context_id: "conformance-context".to_string(),
        session_id: "conformance-session".to_string(),
        initiating_principal_id: None,
        root_turn_id: occurrence_root.to_string(),
        kind: ThreadKind::Execution,
        executor_kind: "self".to_string(),
        executor_id: None,
        target_id: None,
        supervision: morphz::memory::ThreadSupervision::runtime("schedule-occurrence-router"),
    };
    let recurring_event = Event::new(
        "conformance-schedule-recurring-event".to_string(),
        "Store-Conformance".to_string(),
        "tool_output".to_string(),
        "chat/schedule_due".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session",
            "root_turn_id": occurrence_root,
            "schedule_id": recurring.id
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    assert!(store
        .commit_scheduled_dispatch(
            &recurring.id,
            recurring.revision,
            Some(chrono::Utc::now() + chrono::Duration::seconds(60)),
            &recurring_event,
            Some(&occurrence),
        )
        .await
        .unwrap()
        .is_some());
    let persisted_occurrence = store
        .get_thread_by_root(occurrence_root)
        .await
        .unwrap()
        .expect("recurring dispatch must create the occurrence Thread atomically");
    assert_eq!(persisted_occurrence.id, occurrence.id);
    let recurring_signal = store
        .list_context_thread_signals("conformance-context", Some(ThreadSignalStatus::Pending))
        .await
        .unwrap()
        .into_iter()
        .find(|signal| signal.event_id == recurring_event.id)
        .expect("recurring dispatch must commit one direct occurrence Signal");
    assert_eq!(recurring_signal.thread_id, occurrence.id);

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
                model_alias: None,
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

    let objective = store
        .create_objective(NewObjective {
            id: "conformance-schedule-objective".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            coordinator_session_id: "conformance-session".to_string(),
            delivery_session_id: "conformance-session".to_string(),
            parent_objective_id: None,
            source_event_id: "conformance-schedule-objective-source".to_string(),
            initiating_principal_id: None,
            stated_objective: "fence supervised schedules on pause".to_string(),
            token_budget: None,
        })
        .await
        .unwrap();
    let objective_thread = store
        .ensure_thread(NewThread {
            id: "conformance-schedule-objective-thread".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            session_id: "conformance-session".to_string(),
            initiating_principal_id: None,
            root_turn_id: "conformance-schedule-objective-root".to_string(),
            kind: ThreadKind::Execution,
            executor_kind: "self".to_string(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::objective(
                &objective.id,
                "conformance-schedule-evaluation",
                objective.generation,
                None,
            ),
        })
        .await
        .unwrap();
    let supervised = store
        .ensure_schedule(morphz::memory::NewSchedule {
            id: "conformance-schedule-objective-timer".to_string(),
            thread_id: objective_thread.id,
            source_turn_id: objective_thread.root_turn_id,
            intent: "must close with its Objective generation".to_string(),
            model_alias: None,
            not_before: None,
            interval_seconds: Some(2),
            dependency_thread_ids: Vec::new(),
        })
        .await
        .unwrap();
    assert!(matches!(
        store
            .update_objective_state(
                &objective.id,
                objective.revision,
                ObjectiveStatus::Paused,
                None,
                Some("store conformance pause"),
            )
            .await
            .unwrap(),
        ObjectiveMutation::Updated(_)
    ));
    let supervised = store.get_schedule(&supervised.id).await.unwrap().unwrap();
    assert_eq!(supervised.status, ScheduleStatus::Cancelled);
    assert!(store
        .claim_schedule(&supervised.id, supervised.revision, None)
        .await
        .unwrap()
        .is_none());
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
            "principal_id": "o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat",
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
                .claim_message(
                    "conformance-session",
                    "client-message-a",
                    &event,
                    MessageDispatchMode::FollowUp,
                )
                .await
        })
    };
    let second_claim = {
        let store = Arc::clone(&store);
        let event = message.clone();
        tokio::spawn(async move {
            store
                .claim_message(
                    "conformance-session",
                    "client-message-a",
                    &event,
                    MessageDispatchMode::FollowUp,
                )
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
            .filter(|claim| matches!(claim, MessageClaim::Accepted { .. }))
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

    let conflicting_message = Event::new(
        "conformance-ingress-message-conflict".to_string(),
        "user".to_string(),
        "user_message".to_string(),
        "chat/user".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session",
            "principal_id": "o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat",
            "text": "different"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    assert_eq!(
        store
            .claim_message(
                "conformance-session",
                "client-message-a",
                &conflicting_message,
                MessageDispatchMode::FollowUp,
            )
            .await
            .unwrap(),
        MessageClaim::Conflict {
            event_id: message.id.clone()
        }
    );

    let racing_message = |id: &str, text: &str| {
        Event::new(
            id.to_string(),
            "user".to_string(),
            "user_message".to_string(),
            "chat/user".to_string(),
            json!({
                "context_id": "conformance-context",
                "session_id": "conformance-session",
                "principal_id": "o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat",
                "text": text
            })
            .as_object()
            .unwrap()
            .clone(),
        )
    };
    let racing_a = racing_message("conformance-ingress-race-a", "A");
    let racing_b = racing_message("conformance-ingress-race-b", "B");
    let claim_a = {
        let store = Arc::clone(&store);
        let event = racing_a.clone();
        tokio::spawn(async move {
            store
                .claim_message(
                    "conformance-session",
                    "client-message-race",
                    &event,
                    MessageDispatchMode::FollowUp,
                )
                .await
        })
    };
    let claim_b = {
        let store = Arc::clone(&store);
        let event = racing_b.clone();
        tokio::spawn(async move {
            store
                .claim_message(
                    "conformance-session",
                    "client-message-race",
                    &event,
                    MessageDispatchMode::FollowUp,
                )
                .await
        })
    };
    let racing_claims = [
        claim_a.await.unwrap().unwrap(),
        claim_b.await.unwrap().unwrap(),
    ];
    assert_eq!(
        racing_claims
            .iter()
            .filter(|claim| matches!(claim, MessageClaim::Accepted { .. }))
            .count(),
        1
    );
    assert_eq!(
        racing_claims
            .iter()
            .filter(|claim| matches!(claim, MessageClaim::Conflict { .. }))
            .count(),
        1
    );
    assert_eq!(
        store
            .query(QueryFilter {
                event_ids: vec![racing_a.id, racing_b.id],
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1
    );

    store
        .create_session(NewSession {
            id: "conformance-ingress-reference".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            parent_session_id: Some("conformance-session".to_string()),
            title: "Referenced Session".to_string(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    store
        .bind_session_principal(
            "conformance-ingress-reference",
            "o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat",
        )
        .await
        .unwrap();
    let referenced_message = Event::new(
        "conformance-ingress-reference-message".to_string(),
        "user".to_string(),
        "user_message".to_string(),
        "chat/user".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session",
            "principal_id": "o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat",
            "text": "coordinate with the referenced Session",
            "references": [{
                "kind": "session",
                "session_id": "conformance-ingress-reference",
                "title": "Referenced Session",
                "context_id": "conformance-context",
                "agent_id": "conformance-agent"
            }]
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    assert!(matches!(
        store
            .claim_message(
                "conformance-session",
                "client-message-reference",
                &referenced_message,
                MessageDispatchMode::FollowUp,
            )
            .await
            .unwrap(),
        MessageClaim::Accepted { .. }
    ));

    store
        .create_session(NewSession {
            id: "conformance-ingress-reference-unbound".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            parent_session_id: Some("conformance-session".to_string()),
            title: "Unbound referenced Session".to_string(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    let forbidden_reference = Event::new(
        "conformance-ingress-reference-forbidden".to_string(),
        "user".to_string(),
        "user_message".to_string(),
        "chat/user".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session",
            "principal_id": "o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat",
            "text": "forbidden reference",
            "references": [{
                "kind": "session",
                "session_id": "conformance-ingress-reference-unbound",
                "title": "Unbound referenced Session",
                "context_id": "conformance-context",
                "agent_id": "conformance-agent"
            }]
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    assert!(matches!(
        store
            .claim_message(
                "conformance-session",
                "client-message-reference-forbidden",
                &forbidden_reference,
                MessageDispatchMode::FollowUp,
            )
            .await
            .unwrap(),
        MessageClaim::ForbiddenReference { .. }
    ));
    assert!(store
        .query(QueryFilter {
            event_id: Some(forbidden_reference.id),
            ..Default::default()
        })
        .await
        .unwrap()
        .is_empty());

    store
        .update_session(
            "conformance-ingress-reference",
            SessionUpdate {
                title: None,
                status: Some(SessionStatus::Archived),
                model_alias: None,
                reasoning_effort: None,
                permission_mode: None,
                sandbox_mode: None,
                default_target_id: None,
            },
        )
        .await
        .unwrap();
    let inactive_reference = Event::new(
        "conformance-ingress-reference-inactive".to_string(),
        "user".to_string(),
        "user_message".to_string(),
        "chat/user".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session",
            "principal_id": "o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat",
            "text": "inactive reference",
            "references": [{
                "kind": "session",
                "session_id": "conformance-ingress-reference",
                "title": "Referenced Session",
                "context_id": "conformance-context",
                "agent_id": "conformance-agent"
            }]
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    assert!(matches!(
        store
            .claim_message(
                "conformance-session",
                "client-message-reference-inactive",
                &inactive_reference,
                MessageDispatchMode::FollowUp,
            )
            .await
            .unwrap(),
        MessageClaim::InactiveReference { .. }
    ));

    let route_mismatch = Event::new(
        "conformance-ingress-route-mismatch".to_string(),
        "user".to_string(),
        morphz::event::TYPE_USER_MESSAGE.to_string(),
        "chat/user_message".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-ingress-reference-unbound",
            "principal_id": "o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat",
            "text": "the Event route must match the claimed Session"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    assert!(store
        .claim_message(
            "conformance-session",
            "client-message-route-mismatch",
            &route_mismatch,
            MessageDispatchMode::Parallel,
        )
        .await
        .is_err());
    assert!(
        store
            .query(QueryFilter {
                event_id: Some(route_mismatch.id),
                ..Default::default()
            })
            .await
            .unwrap()
            .is_empty(),
        "a rejected route must not leave a durable Event behind"
    );

    store
        .create_session(NewSession {
            id: "conformance-ingress-unbound".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            parent_session_id: None,
            title: "Unbound ingress".to_string(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    let unbound_message = Event::new(
        "conformance-ingress-unbound-message".to_string(),
        "user".to_string(),
        "user_message".to_string(),
        "chat/user".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-ingress-unbound",
            "principal_id": "o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat",
            "text": "forbidden"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    let unbound_malformed_reference = Event::new(
        "conformance-ingress-unbound-malformed-reference".to_string(),
        "user".to_string(),
        morphz::event::TYPE_USER_MESSAGE.to_string(),
        "chat/user_message".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-ingress-unbound",
            "principal_id": "o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat",
            "text": "source authority takes precedence over reference diagnostics",
            "references": [{
                "kind": "unsupported",
                "session_id": "conformance-session",
                "context_id": "conformance-context",
                "agent_id": "conformance-agent"
            }]
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    assert!(matches!(
        store
            .claim_message(
                "conformance-ingress-unbound",
                "client-message-unbound-malformed-reference",
                &unbound_malformed_reference,
                MessageDispatchMode::Parallel,
            )
            .await
            .unwrap(),
        MessageClaim::ForbiddenPrincipal { .. }
    ));
    assert!(store
        .query(QueryFilter {
            event_id: Some(unbound_malformed_reference.id),
            ..Default::default()
        })
        .await
        .unwrap()
        .is_empty());
    assert!(matches!(
        store
            .claim_message(
                "conformance-ingress-unbound",
                "client-message-unbound",
                &unbound_message,
                MessageDispatchMode::FollowUp,
            )
            .await
            .unwrap(),
        MessageClaim::ForbiddenPrincipal { .. }
    ));
    store
        .bind_session_principal(
            "conformance-ingress-unbound",
            "o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat",
        )
        .await
        .unwrap();
    store
        .update_session(
            "conformance-ingress-unbound",
            SessionUpdate {
                title: None,
                status: Some(SessionStatus::Archived),
                model_alias: None,
                reasoning_effort: None,
                permission_mode: None,
                sandbox_mode: None,
                default_target_id: None,
            },
        )
        .await
        .unwrap();
    let archived_message = Event::new(
        "conformance-ingress-archived-message".to_string(),
        "user".to_string(),
        "user_message".to_string(),
        "chat/user".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-ingress-unbound",
            "principal_id": "o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat",
            "text": "inactive"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    assert_eq!(
        store
            .claim_message(
                "conformance-ingress-unbound",
                "client-message-archived",
                &archived_message,
                MessageDispatchMode::FollowUp,
            )
            .await
            .unwrap(),
        MessageClaim::InactiveSession
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

async fn assert_session_signal_conformance<S>(store: Arc<S>)
where
    S: ActivationStore
        + DeliveryIngressStore
        + EventStore
        + SessionDirectoryStore
        + ThreadStore
        + Send
        + Sync
        + 'static,
{
    store
        .create_session(NewSession {
            id: "conformance-signal-target".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            parent_session_id: Some("conformance-session".to_string()),
            title: "Signal target".to_string(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    store
        .ensure_context(NewCognitiveContext {
            id: "conformance-signal-cross-context".to_string(),
            agent_id: "conformance-agent".to_string(),
            title: "Cross-context signal target".to_string(),
        })
        .await
        .unwrap();
    store
        .create_session(NewSession {
            id: "conformance-signal-cross-target".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-signal-cross-context".to_string(),
            parent_session_id: None,
            title: "Cross-context signal Session".to_string(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();

    let signal_event = |id: &str,
                        source_context_id: &str,
                        source_session_id: &str,
                        target_context_id: &str,
                        target_session_id: &str,
                        text: &str| {
        Event::new(
            id.to_string(),
            "Agent-SessionSignal".to_string(),
            morphz::event::TYPE_SESSION_SIGNAL.to_string(),
            "chat/session_signal".to_string(),
            json!({
                "agent_id": "conformance-agent",
                "context_id": target_context_id,
                "session_id": target_session_id,
                "source_context_id": source_context_id,
                "source_session_id": source_session_id,
                "source_thread_id": "conformance-source-thread",
                "source_activation_id": "conformance-source-activation",
                "source_attempt_id": "conformance-source-attempt",
                "source_root_turn_id": "conformance-source-root",
                "source_trigger_event_id": "conformance-source-trigger",
                "correlation_id": id,
                "dedupe_id": id,
                "text": text,
                "cross_context": source_context_id != target_context_id
            })
            .as_object()
            .unwrap()
            .clone(),
        )
    };

    let same_context = signal_event(
        "conformance-session-signal",
        "conformance-context",
        "conformance-session",
        "conformance-context",
        "conformance-signal-target",
        "coordinate in the shared Context",
    );
    let mut forbidden_principal_signal = signal_event(
        "conformance-session-signal-forbidden-principal",
        "conformance-context",
        "conformance-session",
        "conformance-context",
        "conformance-signal-target",
        "must not cross the Principal boundary",
    );
    forbidden_principal_signal.payload.insert(
        "principal_id".to_string(),
        json!("o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat"),
    );
    assert!(matches!(
        store
            .claim_session_signal(&forbidden_principal_signal)
            .await
            .unwrap(),
        SessionSignalClaim::ForbiddenPrincipal { .. }
    ));
    assert!(store
        .query(QueryFilter {
            event_id: Some(forbidden_principal_signal.id),
            ..Default::default()
        })
        .await
        .unwrap()
        .is_empty());
    let first = {
        let store = Arc::clone(&store);
        let event = same_context.clone();
        tokio::spawn(async move { store.claim_session_signal(&event).await })
    };
    let second = {
        let store = Arc::clone(&store);
        let event = same_context.clone();
        tokio::spawn(async move { store.claim_session_signal(&event).await })
    };
    let claims = [
        first.await.unwrap().unwrap(),
        second.await.unwrap().unwrap(),
    ];
    assert_eq!(
        claims
            .iter()
            .filter(|claim| matches!(claim, SessionSignalClaim::Accepted { .. }))
            .count(),
        1
    );
    assert_eq!(
        claims
            .iter()
            .filter(|claim| matches!(claim, SessionSignalClaim::Existing { event_id } if event_id == &same_context.id))
            .count(),
        1
    );
    let mut conflicting_signal = same_context.clone();
    conflicting_signal.payload.insert(
        "text".to_string(),
        json!("same Event ID must not be rebound"),
    );
    assert!(store
        .claim_session_signal(&conflicting_signal)
        .await
        .is_err());
    assert_eq!(
        store
            .query(QueryFilter {
                event_id: Some(same_context.id.clone()),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1
    );
    let target_thread = store
        .get_thread_by_root(&same_context.id)
        .await
        .unwrap()
        .expect("Session Signal must atomically create its target DialogueTurn");
    assert_eq!(target_thread.session_id, "conformance-signal-target");
    assert_eq!(target_thread.kind, ThreadKind::DialogueTurn);
    assert_eq!(
        store
            .list_context_thread_signals("conformance-context", None)
            .await
            .unwrap()
            .iter()
            .filter(|signal| signal.event_id == same_context.id)
            .count(),
        1
    );

    let reply = signal_event(
        "conformance-session-signal-reply",
        "conformance-context",
        "conformance-signal-target",
        "conformance-context",
        "conformance-session",
        "symmetric reply",
    );
    assert!(matches!(
        store.claim_session_signal(&reply).await.unwrap(),
        SessionSignalClaim::Accepted { .. }
    ));
    assert_eq!(
        store
            .get_thread_by_root(&reply.id)
            .await
            .unwrap()
            .unwrap()
            .session_id,
        "conformance-session"
    );

    let cross_context = signal_event(
        "conformance-session-signal-cross-context",
        "conformance-context",
        "conformance-session",
        "conformance-signal-cross-context",
        "conformance-signal-cross-target",
        "explicit bridge only",
    );
    assert!(matches!(
        store.claim_session_signal(&cross_context).await.unwrap(),
        SessionSignalClaim::Accepted { .. }
    ));
    let persisted_cross = store
        .query(QueryFilter {
            event_id: Some(cross_context.id.clone()),
            context_id: Some("conformance-signal-cross-context".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(persisted_cross.len(), 1);
    assert_eq!(persisted_cross[0].payload["cross_context"], true);
    assert_eq!(
        store
            .query(QueryFilter {
                event_id: Some(cross_context.id.clone()),
                context_id: Some("conformance-context".to_string()),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        0,
        "cross-Context coordination must not copy the signal into the source Context",
    );

    store
        .update_session(
            "conformance-signal-target",
            SessionUpdate {
                title: None,
                status: Some(SessionStatus::Archived),
                model_alias: None,
                reasoning_effort: None,
                permission_mode: None,
                sandbox_mode: None,
                default_target_id: None,
            },
        )
        .await
        .unwrap();
    let archived = signal_event(
        "conformance-session-signal-archived",
        "conformance-context",
        "conformance-session",
        "conformance-context",
        "conformance-signal-target",
        "must reject",
    );
    assert_eq!(
        store.claim_session_signal(&archived).await.unwrap(),
        SessionSignalClaim::InactiveSession
    );
    assert!(store
        .query(QueryFilter {
            event_id: Some(archived.id),
            ..Default::default()
        })
        .await
        .unwrap()
        .is_empty());

    store
        .ensure_agent(NewAgent {
            id: "conformance-other-agent".to_string(),
            title: "Other Agent".to_string(),
            root_context_id: "conformance-signal-other-context".to_string(),
        })
        .await
        .unwrap();
    store
        .ensure_context(NewCognitiveContext {
            id: "conformance-signal-other-context".to_string(),
            agent_id: "conformance-other-agent".to_string(),
            title: "Other Context".to_string(),
        })
        .await
        .unwrap();
    store
        .create_session(NewSession {
            id: "conformance-other-session".to_string(),
            agent_id: "conformance-other-agent".to_string(),
            context_id: "conformance-signal-other-context".to_string(),
            parent_session_id: None,
            title: "Other Session".to_string(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    let cross_agent = signal_event(
        "conformance-session-signal-cross-agent",
        "conformance-context",
        "conformance-session",
        "conformance-signal-other-context",
        "conformance-other-session",
        "must reject",
    );
    assert!(store.claim_session_signal(&cross_agent).await.is_err());
}

async fn assert_delegation_store_conformance<S>(store: Arc<S>)
where
    S: DelegationStore
        + EventStore
        + SessionDirectoryStore
        + ThreadStore
        + ActivationStore
        + Send
        + Sync
        + 'static,
{
    let scaffold_context_id = "conformance-delegation-scaffold-context";
    let scaffold_session_id = "conformance-delegation-scaffold-session";
    let scaffold = store
        .create_delegation_scaffold(
            NewCognitiveContext {
                id: scaffold_context_id.to_string(),
                agent_id: "conformance-agent".to_string(),
                title: "Atomic Delegation Scaffold".to_string(),
            },
            NewSession {
                id: scaffold_session_id.to_string(),
                agent_id: "conformance-agent".to_string(),
                context_id: scaffold_context_id.to_string(),
                parent_session_id: None,
                title: "Atomic Delegation Session".to_string(),
                mount_kind: SessionMountKind::DelegationProjection,
            },
            NewDelegation {
                id: "conformance-delegation-scaffold".to_string(),
                agent_id: "conformance-agent".to_string(),
                parent_context_id: "conformance-context".to_string(),
                parent_session_id: "conformance-session".to_string(),
                child_context_id: scaffold_context_id.to_string(),
                child_session_id: scaffold_session_id.to_string(),
                initiating_principal_id: None,
                task: "create one atomic delegation scaffold".to_string(),
                success_when: None,
                context_scope: "mind_only".to_string(),
            },
        )
        .await
        .unwrap();
    assert_eq!(scaffold.status, DelegationStatus::Queued);
    assert!(store
        .get_context(scaffold_context_id)
        .await
        .unwrap()
        .is_some());
    assert!(store
        .get_session(scaffold_session_id)
        .await
        .unwrap()
        .is_some());

    let rejected_context_id = "conformance-rejected-delegation-context";
    let rejected_session_id = "conformance-rejected-delegation-session";
    assert!(store
        .create_delegation_scaffold(
            NewCognitiveContext {
                id: rejected_context_id.to_string(),
                agent_id: "conformance-agent".to_string(),
                title: "Must Roll Back".to_string(),
            },
            NewSession {
                id: rejected_session_id.to_string(),
                agent_id: "conformance-agent".to_string(),
                context_id: rejected_context_id.to_string(),
                parent_session_id: None,
                title: "Must Roll Back".to_string(),
                mount_kind: SessionMountKind::DelegationProjection,
            },
            NewDelegation {
                id: "conformance-rejected-delegation".to_string(),
                agent_id: "conformance-agent".to_string(),
                parent_context_id: "conformance-context".to_string(),
                parent_session_id: "missing-parent-session".to_string(),
                child_context_id: rejected_context_id.to_string(),
                child_session_id: rejected_session_id.to_string(),
                initiating_principal_id: None,
                task: "must not leave half a scaffold".to_string(),
                success_when: None,
                context_scope: "mind_only".to_string(),
            },
        )
        .await
        .is_err());
    assert!(store
        .get_context(rejected_context_id)
        .await
        .unwrap()
        .is_none());
    assert!(store
        .get_session(rejected_session_id)
        .await
        .unwrap()
        .is_none());

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
        .list_delegations(Default::default())
        .await
        .unwrap()
        .iter()
        .any(|delegation| delegation.id == created.id));
    let related = store
        .list_delegations(DelegationFilter {
            related_context_id: Some(created.parent_context_id.clone()),
            include_terminal: false,
            newest_first: true,
            limit: Some(1),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(related, vec![created.clone()]);
    assert!(store
        .list_delegations(DelegationFilter {
            related_context_id: Some("unrelated-context".to_string()),
            include_terminal: true,
            limit: Some(1),
            ..Default::default()
        })
        .await
        .unwrap()
        .is_empty());
    assert!(store
        .list_delegations(DelegationFilter {
            include_terminal: false,
            newest_first: false,
            after_updated_at: Some(created.updated_at),
            after_id: Some(created.id.clone()),
            limit: Some(1),
            ..Default::default()
        })
        .await
        .unwrap()
        .is_empty());
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

    // An attached Delegation is a suspended continuation of the exact
    // scheduler Thread which invoked it. Its terminal result must not become
    // a fresh delegation-router root: doing so strands Objective/Thread Group
    // ownership even though the Sub Agent and detached continuation finish.
    let routed_context_id = "conformance-attached-delegation-context";
    let routed_session_id = "conformance-attached-delegation-session";
    store
        .ensure_context(NewCognitiveContext {
            id: routed_context_id.to_string(),
            agent_id: "conformance-agent".to_string(),
            title: "Attached Delegation Child".to_string(),
        })
        .await
        .unwrap();
    store
        .create_session(NewSession {
            id: routed_session_id.to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: routed_context_id.to_string(),
            parent_session_id: None,
            title: "Attached Delegation Child".to_string(),
            mount_kind: SessionMountKind::DelegationProjection,
        })
        .await
        .unwrap();
    let routed = store
        .create_delegation(NewDelegation {
            id: "conformance-attached-delegation".to_string(),
            agent_id: "conformance-agent".to_string(),
            parent_context_id: "conformance-context".to_string(),
            parent_session_id: "conformance-session".to_string(),
            child_context_id: routed_context_id.to_string(),
            child_session_id: routed_session_id.to_string(),
            initiating_principal_id: None,
            task: "return to the exact scheduled Thread".to_string(),
            success_when: None,
            context_scope: "current_session".to_string(),
        })
        .await
        .unwrap();
    let routed = store
        .update_delegation_status(&routed.id, DelegationStatus::Running, None)
        .await
        .unwrap()
        .unwrap();
    let return_thread = store
        .ensure_thread(NewThread {
            id: "conformance-attached-return-thread".to_string(),
            agent_id: routed.agent_id.clone(),
            context_id: routed.parent_context_id.clone(),
            session_id: routed.parent_session_id.clone(),
            initiating_principal_id: None,
            root_turn_id: "conformance-attached-return-root".to_string(),
            kind: ThreadKind::Execution,
            executor_kind: "self".to_string(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::runtime("scheduled-objective-regression"),
        })
        .await
        .unwrap();
    let return_activation = store
        .ensure_thread_activation(NewThreadActivation {
            id: "conformance-attached-return-activation".to_string(),
            agent_id: return_thread.agent_id.clone(),
            context_id: return_thread.context_id.clone(),
            session_id: return_thread.session_id.clone(),
            initiating_principal_id: None,
            trigger_event_id: "conformance-attached-return-trigger".to_string(),
            trigger_sequence: 1,
            trigger_kind: "chat/schedule_due".to_string(),
            parent_activation_id: None,
            root_turn_id: return_thread.root_turn_id.clone(),
        })
        .await
        .unwrap();
    let routed_result = Event::new(
        "conformance-attached-delegation-result".to_string(),
        "Store-Conformance".to_string(),
        "delegation_result".to_string(),
        "chat/tool_output".to_string(),
        json!({
            "context_id": routed.parent_context_id,
            "session_id": routed.parent_session_id,
            "delegation_id": routed.id,
            "thread_id": return_thread.id,
            "root_turn_id": return_thread.root_turn_id,
            "activation_id": return_activation.id,
            "parent_activation_id": return_activation.id,
            "text": "attached result"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    assert!(store
        .commit_delegation_result(&routed.id, &routed_result)
        .await
        .unwrap());
    let routed_signals = store
        .list_context_thread_signals("conformance-context", None)
        .await
        .unwrap()
        .into_iter()
        .filter(|signal| signal.event_id == routed_result.id)
        .collect::<Vec<_>>();
    assert_eq!(routed_signals.len(), 1);
    assert_eq!(routed_signals[0].thread_id, return_thread.id);
    assert_eq!(
        routed_signals[0].parent_activation_id.as_deref(),
        Some(return_activation.id.as_str())
    );
    assert!(
        store
            .get_thread(&stable_thread_id(&routed_result.id))
            .await
            .unwrap()
            .is_none(),
        "attached Delegation result must not create a detached delegation-router Thread"
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
                    None,
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
                    None,
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
/// second history log. Event append and Projection insertion are atomic;
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
    let mut retired_state = MindState {
        version: current.revision + 1,
        ..MindState::default()
    };
    retired_state
        .protected
        .insert("projection:retired".to_string());
    let retire_event = context_event("conformance-projection-retire", context_id);
    let retired = store
        .commit_mind_projection_transaction(
            &retire_event,
            &[],
            &SessionProjectionMutation {
                retired_event_ids: vec![observation.id.clone()],
                restored_event_ids: Vec::new(),
            },
            None,
            current.revision,
            NewMindProjection {
                context_id: context_id.to_string(),
                revision: current.revision + 1,
                state: serde_json::to_value(&retired_state).unwrap(),
                state_hash: context_state_hash(&retired_state).unwrap(),
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
    let retired_snapshot = store
        .read_context_encoding_state_snapshot(context_id, &selected, true, None)
        .await
        .unwrap();
    assert!(retired_snapshot
        .context_state
        .as_ref()
        .is_some_and(|record| record.state.protected.contains("projection:retired")));
    let retired_revision = retired_snapshot
        .context_state_head
        .as_ref()
        .expect("snapshot must expose its authoritative Mind head")
        .revision;
    assert_eq!(
        retired_snapshot.context_state.as_ref().unwrap().revision,
        retired_revision
    );
    let resident_snapshot = store
        .read_context_encoding_state_snapshot(context_id, &selected, true, Some(retired_revision))
        .await
        .unwrap();
    assert!(
        resident_snapshot.context_state.is_none(),
        "matching resident revision must omit the duplicate Mind payload"
    );
    assert_eq!(
        resident_snapshot
            .context_state_head
            .as_ref()
            .map(|head| head.revision),
        Some(retired_revision)
    );
    assert!(
        retired_snapshot
            .events
            .iter()
            .all(|event| event.id != observation.id),
        "one read snapshot must not combine retired Mind with active source Observation"
    );

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
    let mut restored_state = MindState {
        version: current.revision + 1,
        ..MindState::default()
    };
    restored_state
        .protected
        .insert("projection:restored".to_string());
    let restore_event = context_event("conformance-projection-restore", context_id);
    let restored = store
        .commit_mind_projection_transaction(
            &restore_event,
            &[],
            &SessionProjectionMutation {
                retired_event_ids: Vec::new(),
                restored_event_ids: vec![observation.id.clone()],
            },
            None,
            current.revision,
            NewMindProjection {
                context_id: context_id.to_string(),
                revision: current.revision + 1,
                state: serde_json::to_value(&restored_state).unwrap(),
                state_hash: context_state_hash(&restored_state).unwrap(),
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
    let restored_snapshot = store
        .read_context_encoding_state_snapshot(context_id, &selected, true, Some(retired_revision))
        .await
        .unwrap();
    assert!(
        restored_snapshot.context_state.is_some(),
        "a changed authoritative revision must return the new Mind payload"
    );
    assert!(restored_snapshot
        .context_state
        .as_ref()
        .is_some_and(|record| record.state.protected.contains("projection:restored")));
    assert_eq!(
        restored_snapshot
            .events
            .iter()
            .filter(|event| event.id == observation.id)
            .count(),
        1,
        "one read snapshot must pair restored Mind with the restored Observation"
    );

    let writer_store = Arc::clone(&store);
    let writer_observation_id = observation.id.clone();
    let writer_done = Arc::new(AtomicBool::new(false));
    let writer_done_signal = Arc::clone(&writer_done);
    let writer = tokio::spawn(async move {
        for index in 0..32_u64 {
            let current = writer_store
                .get_mind_projection(context_id)
                .await
                .unwrap()
                .unwrap();
            let active = index % 2 == 1;
            let event = context_event(
                &format!("conformance-context-snapshot-toggle-{index}"),
                context_id,
            );
            let mutation = if active {
                SessionProjectionMutation {
                    retired_event_ids: Vec::new(),
                    restored_event_ids: vec![writer_observation_id.clone()],
                }
            } else {
                SessionProjectionMutation {
                    retired_event_ids: vec![writer_observation_id.clone()],
                    restored_event_ids: Vec::new(),
                }
            };
            let mut next_state = MindState {
                version: current.revision + 1,
                ..MindState::default()
            };
            next_state
                .protected
                .insert("snapshot_observation_state_known".to_string());
            if active {
                next_state
                    .protected
                    .insert("snapshot_observation_active".to_string());
            }
            let committed = writer_store
                .commit_mind_projection_transaction(
                    &event,
                    &[],
                    &mutation,
                    None,
                    current.revision,
                    NewMindProjection {
                        context_id: context_id.to_string(),
                        revision: current.revision + 1,
                        state: serde_json::to_value(&next_state).unwrap(),
                        state_hash: context_state_hash(&next_state).unwrap(),
                        head_event_id: Some(event.id.clone()),
                        recall_documents: Vec::new(),
                    },
                )
                .await
                .unwrap();
            assert!(matches!(committed, MindProjectionCommit::Committed { .. }));
            tokio::task::yield_now().await;
        }
        writer_done_signal.store(true, Ordering::SeqCst);
    });
    for _ in 0..512 {
        let snapshot = store
            .read_context_encoding_state_snapshot(context_id, &selected, true, None)
            .await
            .unwrap();
        if let Some(active) = snapshot
            .context_state
            .as_ref()
            .filter(|record| {
                record
                    .state
                    .protected
                    .contains("snapshot_observation_state_known")
            })
            .map(|record| {
                record
                    .state
                    .protected
                    .contains("snapshot_observation_active")
            })
        {
            let observed = snapshot
                .events
                .iter()
                .any(|event| event.id == observation.id);
            assert_eq!(
                observed, active,
                "Mind and Session Projection must come from one database snapshot"
            );
        }
        if writer_done.load(Ordering::SeqCst) {
            break;
        }
        tokio::task::yield_now().await;
    }
    writer.await.unwrap();
}

async fn assert_recall_projection_conformance<S>(store: Arc<S>)
where
    S: EventStore + RecallProjectionStore + Send + Sync + 'static,
{
    let context_id = "conformance-context";
    let long_document = morphz::memory::segment_recall_text(&format!(
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
            legacy_searchable_chunks: Vec::new(),
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
            legacy_searchable_chunks: Vec::new(),
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
            legacy_searchable_chunks: Vec::new(),
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
            searchable_text: long_document,
            legacy_searchable_chunks: Vec::new(),
            preview: "普通历史内容".to_string(),
            retired: false,
            updated_sequence: 40,
            state_hash: "recall-long-event-hash".to_string(),
        },
        RecallDocument {
            context_id: context_id.to_string(),
            document_kind: RecallDocumentKind::Event,
            document_id: "recall-large-shared-document".to_string(),
            revision: 0,
            searchable_text: (0..80)
                .map(|index| format!("共享 标记 section{index}"))
                .collect::<Vec<_>>()
                .join(" "),
            legacy_searchable_chunks: Vec::new(),
            preview: "一个包含许多匹配位置的完整文档".to_string(),
            retired: false,
            updated_sequence: 50,
            state_hash: "recall-large-shared-document-hash".to_string(),
        },
        RecallDocument {
            context_id: context_id.to_string(),
            document_kind: RecallDocumentKind::Event,
            document_id: "recall-second-shared-result".to_string(),
            revision: 0,
            searchable_text: "共享 标记 second".to_string(),
            legacy_searchable_chunks: Vec::new(),
            preview: "不能被前一个长文档挤掉".to_string(),
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
        .any(|hit| hit.document_id == "recall-large-shared-document"));
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

    // This conformance helper shares one Context with earlier Store checks.
    // Rebuild deliberately preserves any authoritative Outbox intents those
    // checks committed, so drain them before measuring the two new timeline
    // Events below.
    loop {
        let batch = store
            .project_recall_outbox_batch("recall-conformance-prefill", 64)
            .await
            .unwrap();
        if batch.claimed == 0 {
            break;
        }
    }

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
    let non_resident_events = store
        .query(QueryFilter {
            context_id: Some(context_id.to_string()),
            excluded_event_ids: vec!["recall-time-conformance-1".to_string()],
            latest_k: Some(1),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        non_resident_events
            .iter()
            .map(|event| event.id.as_str())
            .collect::<Vec<_>>(),
        vec!["recall-time-conformance-0"],
        "Event-store residency exclusions must execute before ORDER/LIMIT"
    );
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
            through_sequence: None,
            through_mind_version: None,
            event_visibility_snapshot: None,
            excluded_event_ids: Vec::new(),
            excluded_frame_ids: Vec::new(),
            limit: 1,
        })
        .await
        .unwrap();
    assert_eq!(timeline[0].document_id, "recall-time-conformance-1");
    let non_resident_timeline = store
        .query_recall_documents(morphz::memory::RecallDocumentSearchRequest {
            context_id: context_id.to_string(),
            normalized_query: None,
            start_time: Some(
                chrono::DateTime::parse_from_rfc3339("2026-08-04T09:30:00Z")
                    .unwrap()
                    .with_timezone(&chrono::Utc),
            ),
            end_time: Some(end_time),
            before_sequence: None,
            through_sequence: None,
            through_mind_version: None,
            event_visibility_snapshot: None,
            excluded_event_ids: vec!["recall-time-conformance-1".to_string()],
            excluded_frame_ids: Vec::new(),
            limit: 1,
        })
        .await
        .unwrap();
    assert_eq!(
        non_resident_timeline[0].document_id, "recall-time-conformance-0",
        "resident exclusions must be applied by the backend before LIMIT"
    );
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
            through_sequence: None,
            through_mind_version: None,
            event_visibility_snapshot: None,
            excluded_event_ids: Vec::new(),
            excluded_frame_ids: Vec::new(),
            limit: 8,
        })
        .await
        .unwrap();
    assert_eq!(combined.len(), 1);
    assert_eq!(combined[0].document_id, "recall-time-conformance-0");

    let causal_snapshot = store
        .query_recall_documents(morphz::memory::RecallDocumentSearchRequest {
            context_id: context_id.to_string(),
            normalized_query: Some("时间窗口".to_string()),
            start_time: None,
            end_time: None,
            before_sequence: None,
            through_sequence: Some(non_resident_timeline[0].updated_sequence),
            through_mind_version: Some(10),
            event_visibility_snapshot: None,
            excluded_event_ids: Vec::new(),
            excluded_frame_ids: Vec::new(),
            limit: 8,
        })
        .await
        .unwrap();
    assert_eq!(causal_snapshot.len(), 1);
    assert_eq!(
        causal_snapshot[0].document_id, "recall-time-conformance-0",
        "Recall must apply the physical Context View frontier inside SQL before ranking and LIMIT"
    );
    let pre_frame_view = store
        .query_recall_documents(morphz::memory::RecallDocumentSearchRequest {
            context_id: context_id.to_string(),
            normalized_query: Some(morphz::memory::normalize_recall_text(
                "memory/sandbox-permission",
            )),
            start_time: None,
            end_time: None,
            before_sequence: None,
            // Event and Mind clocks are intentionally different domains. A
            // large Event frontier must not admit a Frame updated at a later
            // Mind revision than the physical model View.
            through_sequence: Some(u64::try_from(i64::MAX).unwrap()),
            through_mind_version: Some(19),
            event_visibility_snapshot: None,
            excluded_event_ids: Vec::new(),
            excluded_frame_ids: Vec::new(),
            limit: 8,
        })
        .await
        .unwrap();
    assert!(
        pre_frame_view.is_empty(),
        "Frame Recall must use the Mind revision fence rather than comparing a Frame version with an Event sequence"
    );

    // Model the exact rebuild race: maintenance captured `documents`, then a
    // new authoritative Event committed before the replacement transaction.
    // The Event's transactional Outbox intent is the only durable bridge from
    // that stale rebuild snapshot to the current Recall projection. Rebuild
    // must preserve it rather than silently losing the new fact.
    let concurrent_event = Event::new(
        "recall-concurrent-with-rebuild".to_string(),
        "User".to_string(),
        morphz::event::TYPE_USER_MESSAGE.to_string(),
        "chat/user_message".to_string(),
        serde_json::json!({
            "context_id": context_id,
            "session_id": "conformance-session",
            "text": "并发重建唯一火花",
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    store.append(concurrent_event.clone()).await.unwrap();
    store
        .replace_recall_documents(context_id, &documents)
        .await
        .unwrap();
    let projected = store
        .project_recall_outbox_batch("recall-rebuild-race-worker", 8)
        .await
        .unwrap();
    assert_eq!(
        projected.projected, 1,
        "a stale rebuild must preserve concurrently committed Outbox intents"
    );
    let concurrent = store
        .search_recall_documents(
            context_id,
            &morphz::memory::normalize_recall_text("唯一火花"),
            8,
        )
        .await
        .unwrap();
    assert!(
        concurrent
            .iter()
            .any(|hit| hit.document_id == concurrent_event.id),
        "the post-snapshot Event must converge into Recall after rebuild: {concurrent:?}"
    );
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
        + SchedulerDependencyStore
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
    let amendment_root = objective_primary_execution_root_id(&waiting.id, waiting.generation);
    let amendment_event = Event::new(
        "conformance-objective-amendment".to_string(),
        "Runtime-ObjectiveSupervisor".to_string(),
        "objective_control".to_string(),
        "chat/objective_amended".to_string(),
        [
            ("context_id".to_string(), json!(waiting.context_id)),
            (
                "session_id".to_string(),
                json!(waiting.coordinator_session_id),
            ),
            ("root_turn_id".to_string(), json!(amendment_root)),
            ("objective_id".to_string(), json!(waiting.id)),
            (
                "objective_revision".to_string(),
                json!(waiting.revision + 1),
            ),
            (
                "objective_generation".to_string(),
                json!(waiting.generation),
            ),
            ("objective_interrupt".to_string(), json!(true)),
        ]
        .into_iter()
        .collect(),
    );
    let amendment_thread = NewThread {
        id: stable_thread_id(&amendment_root),
        agent_id: waiting.agent_id.clone(),
        context_id: waiting.context_id.clone(),
        session_id: waiting.coordinator_session_id.clone(),
        initiating_principal_id: waiting.initiating_principal_id.clone(),
        root_turn_id: amendment_root,
        kind: ThreadKind::Execution,
        executor_kind: "self".to_string(),
        executor_id: None,
        target_id: None,
        supervision: ThreadSupervision::objective_primary_execution(
            waiting.id.clone(),
            waiting.generation,
        ),
    };
    let waiting = match store
        .amend_objective_with_signal(
            &waiting.id,
            waiting.revision,
            "verify amended objective fencing",
            &amendment_event,
            &amendment_thread,
        )
        .await
        .unwrap()
    {
        ObjectiveMutation::Updated(objective) => objective,
        mutation => panic!("unexpected amendment mutation: {mutation:?}"),
    };
    assert!(matches!(
        waiting.wait_condition,
        Some(ObjectiveWaitCondition::ResourceAvailable { .. })
    ));
    assert!(store
        .list_context_thread_signals(&waiting.context_id, None)
        .await
        .unwrap()
        .iter()
        .any(|signal| signal.event_id == amendment_event.id));

    let dependencies = store
        .list_scheduler_dependencies(SchedulerDependencyFilter {
            owner_kind: Some(SchedulerDependencyOwnerKind::Objective),
            owner_id: Some(waiting.id.clone()),
            status: Some(SchedulerDependencyStatus::Pending),
            required_only: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(dependencies.len(), 1);
    assert!(matches!(
        store
            .claim_objective_interrupt_evaluation(
                &waiting.id,
                waiting.revision,
                "wrong-interrupt-evaluation",
                chrono::Utc::now() + chrono::Duration::seconds(30),
                "wrong-dependency",
            )
            .await
            .unwrap(),
        ObjectiveMutation::Conflict { .. }
    ));
    let interrupted = match store
        .claim_objective_interrupt_evaluation(
            &waiting.id,
            waiting.revision,
            "interrupt-evaluation",
            chrono::Utc::now() + chrono::Duration::seconds(30),
            &dependencies[0].id,
        )
        .await
        .unwrap()
    {
        ObjectiveMutation::Updated(objective) => objective,
        mutation => panic!("unexpected interrupt claim: {mutation:?}"),
    };
    assert_eq!(interrupted.wait_condition, waiting.wait_condition);
    assert!(matches!(
        store
            .renew_objective_evaluation(
                &interrupted.id,
                "interrupt-evaluation",
                chrono::Utc::now() + chrono::Duration::seconds(45),
            )
            .await
            .unwrap(),
        ObjectiveMutation::Conflict { .. }
    ));
    assert!(matches!(
        store
            .renew_objective_interrupt_evaluation(
                &interrupted.id,
                "interrupt-evaluation",
                chrono::Utc::now() + chrono::Duration::seconds(45),
                &dependencies[0].id,
            )
            .await
            .unwrap(),
        ObjectiveMutation::Updated(_)
    ));
    assert_eq!(
        store
            .get_scheduler_dependency(&dependencies[0].id)
            .await
            .unwrap()
            .unwrap()
            .status,
        SchedulerDependencyStatus::Pending,
        "interrupt admission must preserve the original crash-recovery wait"
    );
    let interrupted = match store
        .edit_objective(
            &interrupted.id,
            interrupted.revision,
            "verify corrected objective wording",
        )
        .await
        .unwrap()
    {
        ObjectiveMutation::Updated(objective) => objective,
        mutation => panic!("unexpected objective edit during interrupt: {mutation:?}"),
    };
    assert_eq!(
        interrupted.stated_objective,
        "verify corrected objective wording"
    );
    assert_eq!(interrupted.wait_condition, waiting.wait_condition);
    assert_eq!(
        interrupted.active_evaluation_id.as_deref(),
        Some("interrupt-evaluation"),
        "editing Objective intent must not replace its Evaluation lease"
    );
    assert_eq!(
        store
            .get_scheduler_dependency(&dependencies[0].id)
            .await
            .unwrap()
            .unwrap()
            .status,
        SchedulerDependencyStatus::Pending,
        "editing Objective intent must not satisfy or replace its wait"
    );
    let waiting = match store
        .finish_objective_evaluation(&interrupted.id, "interrupt-evaluation", 0, 0)
        .await
        .unwrap()
    {
        ObjectiveMutation::Updated(objective) => objective,
        mutation => panic!("unexpected interrupt finish: {mutation:?}"),
    };
    assert_eq!(waiting.wait_condition, interrupted.wait_condition);
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
            ready_signal_event_ids: Vec::new(),
            ready_supervisor_event_ids: Vec::new()
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
    S: ActionGroupStore
        + ActivationStore
        + EventStore
        + ExecutionJobStore
        + ThreadStore
        + Send
        + Sync
        + 'static,
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

    let recovery_call = Event::new(
        "call-conformance-action-group-recovery".to_string(),
        "Store-Conformance".to_string(),
        morphz::event::TYPE_AGENT_CALL.to_string(),
        "chat/assistant_call".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session",
            "activation_id": "conformance-activation",
            "thread_id": "conformance-thread",
            "root_turn_id": "root-conformance-thread"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    store.append(recovery_call.clone()).await.unwrap();
    let recovery_job_id = "conformance-action-group-recovery-job";
    let mut recovery_job = execution_job(recovery_job_id, "group-recovery-call");
    recovery_job.retry_safety = ExecutionRetrySafety::AtMostOnce;
    recovery_job.request = json!({
        "path": "README.md",
        "_morphz_action_group_id": "conformance-action-group-recovery"
    });
    let recovery_job = store.create_execution_job(recovery_job).await.unwrap();
    let recovery_group = store
        .create_action_group(
            NewActionGroup {
                id: "conformance-action-group-recovery".to_string(),
                activation_id: "conformance-activation".to_string(),
                thread_id: "conformance-thread".to_string(),
                agent_id: "conformance-agent".to_string(),
                context_id: "conformance-context".to_string(),
                session_id: "conformance-session".to_string(),
                assistant_call_event_id: recovery_call.id,
                objective_id: None,
                objective_evaluation_id: None,
                objective_revision: None,
            },
            vec![
                NewActionGroupMember {
                    ordinal: 0,
                    tool_call_id: "group-recovery-call".to_string(),
                    tool_name: "read".to_string(),
                    execution_job_id: Some(recovery_job_id.to_string()),
                },
                NewActionGroupMember {
                    ordinal: 1,
                    tool_call_id: "group-recovery-logical-call".to_string(),
                    tool_name: "search".to_string(),
                    execution_job_id: None,
                },
            ],
        )
        .await
        .unwrap();
    let recovery_members = store
        .list_action_group_members_for_groups(&[
            "conformance-action-group".to_string(),
            recovery_group.id.clone(),
        ])
        .await
        .unwrap();
    assert_eq!(
        recovery_members
            .iter()
            .filter(|member| member.group_id == recovery_group.id)
            .count(),
        2
    );
    let running_page = store
        .list_action_groups(ActionGroupFilter {
            include_terminal: false,
            newest_first: false,
            limit: Some(1),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(running_page, vec![recovery_group.clone()]);
    assert!(store
        .list_action_groups(ActionGroupFilter {
            include_terminal: false,
            newest_first: false,
            after_created_at: Some(recovery_group.created_at),
            after_id: Some(recovery_group.id.clone()),
            limit: Some(1),
            ..Default::default()
        })
        .await
        .unwrap()
        .is_empty());
    let recovery_job = match store
        .claim_execution_job(
            &recovery_job.id,
            recovery_job.revision,
            "group-recovery-worker",
            "group-recovery-claim",
            chrono::Utc::now() + chrono::Duration::minutes(1),
            None,
        )
        .await
        .unwrap()
    {
        ExecutionJobMutation::Updated(job) => job,
        mutation => panic!("unexpected Action Group recovery claim: {mutation:?}"),
    };
    let recovery_job = match store
        .heartbeat_execution_job(
            &recovery_job.id,
            recovery_job.revision,
            "group-recovery-claim",
            chrono::Utc::now() + chrono::Duration::minutes(1),
            Some(chrono::Utc::now()),
            None,
        )
        .await
        .unwrap()
    {
        ExecutionJobMutation::Updated(job) => job,
        mutation => panic!("unexpected Action Group recovery heartbeat: {mutation:?}"),
    };
    let manager: ExecutionJobManager<dyn ExecutionJobStore> =
        ExecutionJobManager::new(store.clone());
    let report = manager
        .reconcile_startup(
            morphz::memory::WorkerCoordinationMode::ExclusiveProcess,
            store.as_ref(),
            Some(store.as_ref()),
        )
        .await
        .unwrap();
    assert!(report.lost_receipts.iter().any(|receipt| receipt
        .applied_job()
        .is_some_and(|job| job.id == recovery_job.id)));
    let result = store
        .query(QueryFilter {
            event_id: Some("output_conformance-activation_group-recovery-call".to_string()),
            ..Default::default()
        })
        .await
        .unwrap()
        .into_iter()
        .next()
        .unwrap();
    assert_eq!(
        result.payload["action_group_id"],
        "conformance-action-group-recovery"
    );
    assert_eq!(result.payload["wake_policy"], "none");
    assert!(store
        .list_context_thread_signals("conformance-context", Some(ThreadSignalStatus::Pending))
        .await
        .unwrap()
        .iter()
        .all(|signal| signal.event_id != result.id));

    let late_group_call = Event::new(
        "conformance-late-action-group-call".to_string(),
        "Store-Conformance".to_string(),
        morphz::event::TYPE_AGENT_CALL.to_string(),
        "chat/assistant_call".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session",
            "activation_id": "conformance-activation",
            "thread_id": "conformance-thread",
            "root_turn_id": "root-conformance-thread"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    store.append(late_group_call.clone()).await.unwrap();
    let late_group = store
        .create_action_group(
            NewActionGroup {
                id: "conformance-late-action-group".to_string(),
                activation_id: "conformance-activation".to_string(),
                thread_id: "conformance-thread".to_string(),
                agent_id: "conformance-agent".to_string(),
                context_id: "conformance-context".to_string(),
                session_id: "conformance-session".to_string(),
                assistant_call_event_id: late_group_call.id,
                objective_id: None,
                objective_evaluation_id: None,
                objective_revision: None,
            },
            vec![
                NewActionGroupMember {
                    ordinal: 0,
                    tool_call_id: "late-group-call-a".to_string(),
                    tool_name: "read".to_string(),
                    execution_job_id: None,
                },
                NewActionGroupMember {
                    ordinal: 1,
                    tool_call_id: "late-group-call-b".to_string(),
                    tool_name: "search".to_string(),
                    execution_job_id: None,
                },
            ],
        )
        .await
        .unwrap();
    let late_result = |call: &str| {
        Event::new(
            format!("conformance-late-action-result-{call}"),
            "Store-Conformance".to_string(),
            morphz::event::TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            json!({
                "context_id": "conformance-context",
                "session_id": "conformance-session",
                "activation_id": "conformance-activation",
                "thread_id": "conformance-thread",
                "root_turn_id": "root-conformance-thread",
                "action_group_id": late_group.id.clone(),
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
    let late_settled = Event::new(
        "action_group_settled_conformance-late-action-group".to_string(),
        "Store-Conformance".to_string(),
        "runtime_control".to_string(),
        "runtime/action_group_settled".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session",
            "activation_id": "conformance-activation",
            "thread_id": "conformance-thread",
            "root_turn_id": "root-conformance-thread",
            "action_group_id": late_group.id.clone(),
            "member_count": 2,
            "wake_policy": "direct_signal"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    store
        .commit_action_group_member_result(
            &late_group.id,
            "late-group-call-a",
            ActionGroupMemberStatus::Succeeded,
            &late_result("late-group-call-a"),
            &late_settled,
        )
        .await
        .unwrap();
    let thread = store
        .get_thread("conformance-thread")
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        store
            .control_thread(
                &thread.id,
                thread.revision,
                ThreadControlAction::Cancel,
                Some("terminal before the final Action result"),
                Some("Store-Conformance"),
            )
            .await
            .unwrap(),
        ThreadMutation::Updated(_)
    ));
    let final_commit = store
        .commit_action_group_member_result(
            &late_group.id,
            "late-group-call-b",
            ActionGroupMemberStatus::Succeeded,
            &late_result("late-group-call-b"),
            &late_settled,
        )
        .await
        .unwrap();
    assert!(final_commit.settled_now);
    assert_eq!(
        store
            .get_action_group(&late_group.id)
            .await
            .unwrap()
            .unwrap()
            .status,
        ActionGroupStatus::Settled
    );
    assert_eq!(
        store
            .query(QueryFilter {
                event_id: Some(late_settled.id.clone()),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(store
        .list_context_thread_signals("conformance-context", None)
        .await
        .unwrap()
        .iter()
        .all(|signal| signal.event_id != late_settled.id));
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

    for (job_id, call_id) in [
        ("conformance-edge-revoke-queued", "tool-call-revoke-queued"),
        (
            "conformance-edge-revoke-claimed",
            "tool-call-revoke-claimed",
        ),
    ] {
        store
            .create_execution_job(execution_job_on_target(
                job_id,
                call_id,
                "conformance-edge-target",
            ))
            .await
            .unwrap();
        store
            .create_edge_command(NewEdgeCommand {
                job_id: job_id.to_string(),
                target_id: "conformance-edge-target".to_string(),
                provider_node_id: "node-conformance".to_string(),
                tool_name: "read".to_string(),
                arguments: "{}".to_string(),
                route: queued.route.clone(),
            })
            .await
            .unwrap();
    }
    let revoke_claimed = store
        .claim_edge_command(
            "node-conformance",
            "worker-revoke",
            "claim-revoke",
            chrono::Utc::now() + chrono::Duration::seconds(30),
            8,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(revoke_claimed.job_id, "conformance-edge-revoke-queued");
    let revoked = store
        .revoke_execution_node(
            "node-conformance",
            "principal:conformance",
            rotated.revision,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(revoked.status, ExecutionNodeStatus::Revoked);
    assert_eq!(
        store
            .get_edge_command("conformance-edge-revoke-queued")
            .await
            .unwrap()
            .unwrap()
            .status,
        EdgeCommandStatus::Lost,
        "a claimed command has an unknown outcome when its Node is revoked"
    );
    assert_eq!(
        store
            .get_edge_command("conformance-edge-revoke-claimed")
            .await
            .unwrap()
            .unwrap()
            .status,
        EdgeCommandStatus::Cancelled,
        "an unclaimed command must not remain queued for a revoked Node"
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
        .has_active_execution_target_authorization(
            "conformance-edge-target",
            "principal:conformance",
            "other-agent",
            "other-context",
            "conformance-thread",
        )
        .await
        .unwrap());
    assert!(!store
        .has_active_execution_target_authorization(
            "conformance-edge-target",
            "principal:conformance",
            "other-agent",
            "other-context",
            "other-thread",
        )
        .await
        .unwrap());
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
    assert!(!store
        .has_active_execution_target_authorization(
            "conformance-edge-target",
            "principal:conformance",
            "other-agent",
            "other-context",
            "conformance-thread",
        )
        .await
        .unwrap());
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
        scope: CapabilityLeaseScope::Thread,
        session_id: "conformance-session".to_string(),
        thread_id: "conformance-thread".to_string(),
        scope_id: "conformance-thread".to_string(),
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
    assert_eq!(created.scope, CapabilityLeaseScope::Thread);
    assert_eq!(created.session_id, "conformance-session");
    assert_eq!(created.scope_id, "conformance-thread");
    assert!(matches!(
        store.ensure_capability_lease(lease).await.unwrap(),
        CapabilityLeaseMutation::Existing(_)
    ));
    assert_eq!(
        store
            .list_capability_leases(CapabilityLeaseFilter {
                principal_id: Some("principal:conformance".to_string()),
                scope: Some(CapabilityLeaseScope::Thread),
                session_id: Some("conformance-session".to_string()),
                thread_id: Some("conformance-thread".to_string()),
                scope_id: Some("conformance-thread".to_string()),
                target_id: Some("conformance-edge-target".to_string()),
                capability: Some("exec".to_string()),
                active_at: Some(chrono::Utc::now()),
                ..CapabilityLeaseFilter::default()
            })
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(store
        .list_capability_leases(CapabilityLeaseFilter {
            principal_id: Some("principal:conformance".to_string()),
            thread_id: Some("conformance-thread".to_string()),
            target_id: Some("conformance-edge-target".to_string()),
            capability: Some("read".to_string()),
            active_at: Some(chrono::Utc::now()),
            ..CapabilityLeaseFilter::default()
        })
        .await
        .unwrap()
        .is_empty());
    let shortened_expiry = chrono::Utc::now() + chrono::Duration::minutes(5);
    let restricted_requested = json!({
        "network": false,
        "read_roots": ["/tmp/conformance"],
        "write_roots": [],
        "secret_env": []
    });
    let restricted = match store
        .restrict_capability_lease(
            &created.id,
            created.revision,
            CapabilityLeaseRestriction {
                requested: restricted_requested.clone(),
                expires_at: shortened_expiry,
            },
        )
        .await
        .unwrap()
    {
        CapabilityLeaseMutation::Updated(lease) => lease,
        mutation => panic!("unexpected Capability Lease restriction mutation: {mutation:?}"),
    };
    assert_eq!(restricted.requested, restricted_requested);
    assert_eq!(restricted.expires_at, shortened_expiry);
    let expansion_error = store
        .restrict_capability_lease(
            &restricted.id,
            restricted.revision,
            CapabilityLeaseRestriction {
                requested: json!({
                    "network": true,
                    "read_roots": ["/tmp/conformance"],
                    "write_roots": ["/tmp/conformance"],
                    "secret_env": []
                }),
                expires_at: restricted.expires_at,
            },
        )
        .await
        .expect_err("Capability Lease restriction must reject authority expansion");
    assert!(expansion_error
        .to_string()
        .contains("cannot expand its permission boundary"));
    let revoked = match store
        .revoke_capability_lease(&restricted.id, restricted.revision, "conformance revoke")
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

    let cancellable = store
        .create_execution_job(execution_job(
            "conformance-cancel-cause",
            "tool-call-cancel",
        ))
        .await
        .unwrap();
    let first_cancel = match store
        .request_cancel_execution_job(
            &cancellable.id,
            cancellable.revision,
            Some("first durable cause"),
        )
        .await
        .unwrap()
    {
        ExecutionJobMutation::Updated(job) => job,
        mutation => panic!("unexpected first cancellation mutation: {mutation:?}"),
    };
    let repeated = match store
        .request_cancel_execution_job(&first_cancel.id, first_cancel.revision, None)
        .await
        .unwrap()
    {
        ExecutionJobMutation::Updated(job) => job,
        mutation => panic!("unexpected repeated cancellation mutation: {mutation:?}"),
    };
    assert_eq!(repeated.revision, first_cancel.revision);
    assert_eq!(
        repeated.cancel_reason.as_deref(),
        Some("first durable cause"),
        "later cancellation requests must not rewrite the original cause"
    );
}

fn background_wake_event(
    id: &str,
    session_id: &str,
    job_id: &str,
    generation: u64,
    wake_kind: &str,
) -> Event {
    Event::new(
        id.to_string(),
        "System-TaskMonitor".to_string(),
        morphz::event::TYPE_RUNTIME_WAKE.to_string(),
        "runtime/background_wake".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": session_id,
            "task_id": job_id,
            "checkpoint_generation": generation,
            "wake_kind": wake_kind,
            "source_thread_id": "conformance-thread",
            "source_activation_id": "conformance-activation",
            "event": "background_task_check_due"
        })
        .as_object()
        .unwrap()
        .clone(),
    )
}

/// One shared contract for the durable `check_task_after` checkpoint and the
/// Thread -> Session wake upgrade. Both backends run this helper so parity is
/// proven by construction rather than by reading two implementations.
async fn assert_background_wake_checkpoint_conformance<S>(store: Arc<S>)
where
    S: morphz::memory::RuntimeStore + 'static,
{
    let mut specification = execution_job("conformance-wake-job", "tool-call-wake");
    specification.tool_name = "exec/background".to_string();
    let created = store.create_execution_job(specification).await.unwrap();
    assert_eq!(created.checkpoint_generation, None);
    assert_eq!(created.checkpoint_due_at, None);

    // Direct delivery has the same atomic contract as Session escalation.
    // This separate Job lets both backends prove Event + Signal + generation
    // clear without consuming the Session-fallback fixture below.
    let direct_thread = store
        .ensure_thread(NewThread {
            id: "conformance-wake-direct-thread".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            session_id: "conformance-session".to_string(),
            initiating_principal_id: None,
            root_turn_id: "root-conformance-wake-direct".to_string(),
            kind: ThreadKind::Execution,
            executor_kind: "runtime".to_string(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::legacy(),
        })
        .await
        .unwrap();
    let direct_activation = store
        .ensure_thread_activation(NewThreadActivation {
            id: "conformance-wake-direct-activation".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            session_id: "conformance-session".to_string(),
            initiating_principal_id: None,
            trigger_event_id: "trigger-conformance-wake-direct".to_string(),
            trigger_sequence: 1,
            trigger_kind: "conformance".to_string(),
            parent_activation_id: None,
            root_turn_id: direct_thread.root_turn_id.clone(),
        })
        .await
        .unwrap();
    let mut direct_specification =
        execution_job("conformance-wake-direct-job", "tool-call-wake-direct");
    direct_specification.tool_name = "exec/background".to_string();
    direct_specification.thread_id = direct_thread.id.clone();
    direct_specification.activation_id = direct_activation.id.clone();
    let direct_job = store
        .create_execution_job(direct_specification)
        .await
        .unwrap();
    let direct_registration = store
        .register_background_checkpoint(&direct_job.id, 60, "conformance-direct")
        .await
        .unwrap();
    let direct_event = Event::new(
        "conformance-wake-direct".to_string(),
        "System-TaskMonitor".to_string(),
        morphz::event::TYPE_TOOL_OUTPUT.to_string(),
        "chat/tool_output".to_string(),
        json!({
            "context_id": direct_job.context_id,
            "session_id": direct_job.session_id,
            "thread_id": direct_job.thread_id,
            "activation_id": direct_job.activation_id,
            "tool_call_id": direct_job.tool_call_id,
            "tool_name": direct_job.tool_name,
            "task_id": direct_job.id,
            "event": "background_task_check_due"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    assert!(matches!(
        store
            .claim_background_thread_wake(
                &direct_event,
                &direct_job.id,
                direct_registration.checkpoint_generation,
                &direct_job.thread_id,
            )
            .await
            .unwrap(),
        morphz::memory::BackgroundThreadWakeClaim::Accepted { .. }
    ));
    assert!(store
        .get_execution_job(&direct_job.id)
        .await
        .unwrap()
        .unwrap()
        .checkpoint_due_at
        .is_none());
    assert!(matches!(
        store
            .claim_background_thread_wake(
                &direct_event,
                &direct_job.id,
                direct_registration.checkpoint_generation,
                &direct_job.thread_id,
            )
            .await
            .unwrap(),
        morphz::memory::BackgroundThreadWakeClaim::Existing { .. }
    ));
    let mut conflicting_direct_event = direct_event.clone();
    conflicting_direct_event
        .payload
        .insert("event".to_string(), json!("different_checkpoint_payload"));
    assert!(
        store
            .claim_background_thread_wake(
                &conflicting_direct_event,
                &direct_job.id,
                direct_registration.checkpoint_generation,
                &direct_job.thread_id,
            )
            .await
            .is_err(),
        "an idempotent Thread wake must validate immutable Event content, not only its route"
    );
    assert_eq!(
        store
            .list_context_thread_signals("conformance-context", None)
            .await
            .unwrap()
            .iter()
            .filter(|signal| signal.event_id == direct_event.id)
            .count(),
        1
    );

    // 1. Arming is monotonic in `checkpoint_generation` and keeps exactly one
    //    durable Timer row; `runtime_timers` stays the single physical clock.
    let first = store
        .register_background_checkpoint(&created.id, 60, "conformance")
        .await
        .unwrap();
    assert_eq!(first.checkpoint_generation, 1);
    let second = store
        .register_background_checkpoint(&created.id, 90, "conformance")
        .await
        .unwrap();
    assert_eq!(second.checkpoint_generation, 2);
    assert_eq!(
        second.timer_id, first.timer_id,
        "one background Job must own exactly one durable Timer"
    );
    assert_eq!(
        store
            .list_runtime_timers(None)
            .await
            .unwrap()
            .iter()
            .filter(|timer| timer.id == first.timer_id)
            .count(),
        1,
        "re-arming must upsert the same Timer instead of creating a second one"
    );
    let timer = store
        .get_runtime_timer(&first.timer_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(timer.generation, 2);
    assert_eq!(timer.kind, RuntimeTimerKind::BackgroundWake);
    assert_eq!(timer.status, RuntimeTimerStatus::Pending);
    let armed = store.get_execution_job(&created.id).await.unwrap().unwrap();
    assert_eq!(armed.checkpoint_generation, Some(2));
    assert!(armed.checkpoint_due_at.is_some());

    // 2. A superseded generation must converge silently: no Event, no Thread.
    let stale = background_wake_event(
        "conformance-wake-stale",
        "conformance-session",
        &created.id,
        1,
        "checkpoint",
    );
    assert!(matches!(
        store
            .claim_background_session_wake(&stale, &created.id, Some(1))
            .await
            .unwrap(),
        morphz::memory::BackgroundSessionWakeClaim::StaleCheckpoint
    ));
    assert!(store
        .query(QueryFilter {
            event_id: Some(stale.id.clone()),
            ..Default::default()
        })
        .await
        .unwrap()
        .is_empty());

    // 3. The live generation upgrades the terminal Thread to a fresh
    //    DialogueTurn rooted at the wake Event and clears the checkpoint.
    let due = background_wake_event(
        "conformance-wake-due",
        "conformance-session",
        &created.id,
        2,
        "checkpoint",
    );
    assert!(matches!(
        store
            .claim_background_session_wake(&due, &created.id, Some(2))
            .await
            .unwrap(),
        morphz::memory::BackgroundSessionWakeClaim::Accepted { .. }
    ));
    let woken = store
        .get_thread_by_root(&due.id)
        .await
        .unwrap()
        .expect("an accepted Background Wake must create its own DialogueTurn");
    assert_eq!(woken.session_id, "conformance-session");
    assert_eq!(woken.kind, ThreadKind::DialogueTurn);
    assert_eq!(
        woken.root_turn_id, due.id,
        "the wake Event itself must become the new root turn"
    );
    let wake_signals = store
        .list_context_thread_signals("conformance-context", None)
        .await
        .unwrap();
    assert_eq!(
        wake_signals
            .iter()
            .filter(|signal| signal.event_id == due.id)
            .count(),
        1
    );

    // A pending Runtime Wake is not a user-input batch. A later explicit
    // Interrupt must get its own DialogueTurn rather than being folded into
    // the wake merely because that wake lacks a `dispatch_mode` field.
    store
        .ensure_principal(NewPrincipal {
            id: "conformance-wake-principal".to_string(),
            provider_id: "conformance".to_string(),
            assurance: "verified".to_string(),
            display_name: None,
        })
        .await
        .unwrap();
    store
        .bind_session_principal("conformance-session", "conformance-wake-principal")
        .await
        .unwrap();
    let user_after_wake = Event::new(
        "conformance-user-after-wake".to_string(),
        "Store-Conformance".to_string(),
        morphz::event::TYPE_USER_MESSAGE.to_string(),
        "chat/user_message".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session",
            "principal_id": "conformance-wake-principal",
            "dispatch_mode": "interrupt",
            "text": "please continue"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    assert!(matches!(
        store
            .claim_message(
                "conformance-session",
                "conformance-user-after-wake-client",
                &user_after_wake,
                MessageDispatchMode::Interrupt,
            )
            .await
            .unwrap(),
        MessageClaim::Accepted { .. }
    ));
    let user_thread = store
        .get_thread_by_root(&user_after_wake.id)
        .await
        .unwrap()
        .expect("an explicit user message must retain its own DialogueTurn root");
    assert_ne!(
        user_thread.id, woken.id,
        "user input must not coalesce into a pending Runtime Wake Thread"
    );
    let user_signal = store
        .list_context_thread_signals("conformance-context", None)
        .await
        .unwrap()
        .into_iter()
        .find(|signal| signal.event_id == user_after_wake.id)
        .expect("accepted user input must have one durable Signal");
    assert_eq!(user_signal.thread_id, user_thread.id);
    let cleared = store.get_execution_job(&created.id).await.unwrap().unwrap();
    assert_eq!(cleared.checkpoint_generation, Some(2));
    assert_eq!(
        cleared.checkpoint_due_at, None,
        "a delivered checkpoint must clear its due instant in the same transaction"
    );

    // 4. Exact replay covers the committed-Event-but-unfired-Timer crash
    //    window: idempotent, and never a second DialogueTurn.
    assert!(matches!(
        store
            .claim_background_session_wake(&due, &created.id, Some(2))
            .await
            .unwrap(),
        morphz::memory::BackgroundSessionWakeClaim::Existing { event_id } if event_id == due.id
    ));
    assert_eq!(
        store
            .list_context_thread_signals("conformance-context", None)
            .await
            .unwrap()
            .iter()
            .filter(|signal| signal.event_id == due.id)
            .count(),
        1,
        "replayed wake must not create a second Thread Signal"
    );

    // Deliberate typed suppression closes the same generation and records its
    // reason in the very same Store transaction.
    let suppressed_registration = store
        .register_background_checkpoint(&direct_job.id, 60, "conformance-suppressed")
        .await
        .unwrap();
    let suppressed_event = Event::new(
        "conformance-wake-suppressed".to_string(),
        "System-TaskMonitor".to_string(),
        morphz::event::TYPE_TOOL_OUTPUT.to_string(),
        "chat/tool_output".to_string(),
        json!({"task_id": direct_job.id, "event": "background_task_check_due"})
            .as_object()
            .unwrap()
            .clone(),
    );
    assert!(store
        .suppress_background_checkpoint(
            &suppressed_event,
            &direct_job.id,
            suppressed_registration.checkpoint_generation,
            "background_checkpoint_supervisor_owned_child",
            false,
        )
        .await
        .unwrap());
    let suppression_audit_id = format!(
        "background_wake_audit_{}_g{}",
        direct_job.id, suppressed_registration.checkpoint_generation
    );
    assert_eq!(
        store
            .query(QueryFilter {
                event_id: Some(suppression_audit_id),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1
    );

    // 5. Terminal-result fallback carries no generation and must not clobber a
    //    freshly armed newer checkpoint.
    let rearmed = store
        .register_background_checkpoint(&created.id, 120, "conformance")
        .await
        .unwrap();
    assert_eq!(rearmed.checkpoint_generation, 3);
    let terminal_wake = background_wake_event(
        "conformance-wake-terminal-result",
        "conformance-session",
        &created.id,
        3,
        "terminal_result",
    );
    assert!(matches!(
        store
            .claim_background_session_wake(&terminal_wake, &created.id, None)
            .await
            .unwrap(),
        morphz::memory::BackgroundSessionWakeClaim::Accepted { .. }
    ));
    let preserved = store.get_execution_job(&created.id).await.unwrap().unwrap();
    assert_eq!(preserved.checkpoint_generation, Some(3));
    assert!(
        preserved.checkpoint_due_at.is_some(),
        "terminal-result fallback must not clear an unrelated armed checkpoint"
    );

    // 6. Route failures are typed rather than silently upgraded.
    store
        .create_session(NewSession {
            id: "conformance-wake-archived".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            parent_session_id: None,
            title: "Archived wake target".to_string(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    let archived_thread = store
        .ensure_thread(NewThread {
            id: "conformance-wake-archived-thread".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            session_id: "conformance-wake-archived".to_string(),
            initiating_principal_id: None,
            root_turn_id: "root-conformance-wake-archived".to_string(),
            kind: ThreadKind::Execution,
            executor_kind: "runtime".to_string(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::legacy(),
        })
        .await
        .unwrap();
    let archived_activation = store
        .ensure_thread_activation(NewThreadActivation {
            id: "conformance-wake-archived-activation".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            session_id: "conformance-wake-archived".to_string(),
            initiating_principal_id: None,
            trigger_event_id: "trigger-conformance-wake-archived".to_string(),
            trigger_sequence: 1,
            trigger_kind: "conformance".to_string(),
            parent_activation_id: None,
            root_turn_id: archived_thread.root_turn_id.clone(),
        })
        .await
        .unwrap();
    let mut archived_specification =
        execution_job("conformance-wake-archived-job", "tool-call-wake-archived");
    archived_specification.tool_name = "exec/background".to_string();
    archived_specification.session_id = "conformance-wake-archived".to_string();
    archived_specification.thread_id = archived_thread.id.clone();
    archived_specification.activation_id = archived_activation.id.clone();
    let archived_job = store
        .create_execution_job(archived_specification)
        .await
        .unwrap();
    store
        .update_session(
            "conformance-wake-archived",
            SessionUpdate {
                title: None,
                status: Some(SessionStatus::Archived),
                model_alias: None,
                reasoning_effort: None,
                permission_mode: None,
                sandbox_mode: None,
                default_target_id: None,
            },
        )
        .await
        .unwrap();
    let archived_registration = store
        .register_background_checkpoint(&archived_job.id, 60, "conformance-archived")
        .await
        .unwrap();
    let archived = background_wake_event(
        "conformance-wake-archived-event",
        "conformance-wake-archived",
        &archived_job.id,
        archived_registration.checkpoint_generation,
        "checkpoint",
    );
    assert!(matches!(
        store
            .claim_background_session_wake(
                &archived,
                &archived_job.id,
                Some(archived_registration.checkpoint_generation),
            )
            .await
            .unwrap(),
        morphz::memory::BackgroundSessionWakeClaim::ArchivedSession
    ));
    assert!(store
        .query(QueryFilter {
            event_id: Some(archived.id.clone()),
            ..Default::default()
        })
        .await
        .unwrap()
        .is_empty());
    assert!(store
        .get_execution_job(&archived_job.id)
        .await
        .unwrap()
        .unwrap()
        .checkpoint_due_at
        .is_none());
    let archived_audit_id = format!(
        "background_wake_audit_{}_g{}",
        archived_job.id, archived_registration.checkpoint_generation
    );
    assert_eq!(
        store
            .query(QueryFilter {
                event_id: Some(archived_audit_id),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1,
        "archival suppression and checkpoint clear must commit atomically"
    );
    let wrong_session_registration = store
        .register_background_checkpoint(&created.id, 60, "conformance-missing")
        .await
        .unwrap();
    let wrong_session = background_wake_event(
        "conformance-wake-missing-event",
        "conformance-wake-unknown-session",
        &created.id,
        wrong_session_registration.checkpoint_generation,
        "checkpoint",
    );
    assert!(matches!(
        store
            .claim_background_session_wake(
                &wrong_session,
                &created.id,
                Some(wrong_session_registration.checkpoint_generation),
            )
            .await
            .unwrap(),
        morphz::memory::BackgroundSessionWakeClaim::RouteConflict {
            registered_context_id
        } if registered_context_id == "conformance-context"
    ));
    assert!(store
        .query(QueryFilter {
            event_id: Some(wrong_session.id.clone()),
            ..Default::default()
        })
        .await
        .unwrap()
        .is_empty());
    assert!(store
        .get_execution_job(&created.id)
        .await
        .unwrap()
        .unwrap()
        .checkpoint_due_at
        .is_none());
    let wrong_session_audit_id = format!(
        "background_wake_audit_{}_g{}",
        created.id, wrong_session_registration.checkpoint_generation
    );
    let wrong_session_audit = store
        .query(QueryFilter {
            event_id: Some(wrong_session_audit_id),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(wrong_session_audit.len(), 1);
    assert_eq!(
        wrong_session_audit[0]
            .payload
            .get("operator_attention")
            .and_then(serde_json::Value::as_bool),
        Some(true)
    );

    let route_conflict_registration = store
        .register_background_checkpoint(&created.id, 60, "conformance-route-conflict")
        .await
        .unwrap();
    let mut route_conflict = background_wake_event(
        "conformance-wake-route-conflict",
        "conformance-session",
        &created.id,
        route_conflict_registration.checkpoint_generation,
        "checkpoint",
    );
    route_conflict
        .payload
        .insert("context_id".to_string(), json!("conformance-wrong-context"));
    assert!(matches!(
        store
            .claim_background_session_wake(
                &route_conflict,
                &created.id,
                Some(route_conflict_registration.checkpoint_generation),
            )
            .await
            .unwrap(),
        morphz::memory::BackgroundSessionWakeClaim::RouteConflict {
            registered_context_id
        } if registered_context_id == "conformance-context"
    ));
    assert!(store
        .get_execution_job(&created.id)
        .await
        .unwrap()
        .unwrap()
        .checkpoint_due_at
        .is_none());

    // 7. A Job that reaches terminal state concurrently with a due Timer must
    //    not be re-armed; the stale Timer converges instead.
    let current = store.get_execution_job(&created.id).await.unwrap().unwrap();
    let lease = chrono::Utc::now() + chrono::Duration::seconds(30);
    let claimed = match store
        .claim_execution_job(
            &current.id,
            current.revision,
            "worker-wake",
            "claim-wake",
            lease,
            None,
        )
        .await
        .unwrap()
    {
        ExecutionJobMutation::Updated(job) => job,
        mutation => panic!("unexpected background claim: {mutation:?}"),
    };
    let owner = store
        .get_thread(&claimed.thread_id)
        .await
        .unwrap()
        .expect("background Job owner");
    match store
        .update_thread(
            &owner.id,
            owner.revision,
            None,
            Some(ThreadLifecycle::Completed),
            Some("conformance terminal-owner recovery"),
            None,
            None,
            None,
        )
        .await
        .unwrap()
    {
        ThreadMutation::Updated(_) => {}
        mutation => panic!("unexpected owner terminal mutation: {mutation:?}"),
    }
    let result_event = Event::new(
        "conformance-wake-job-output".to_string(),
        "Store-Conformance".to_string(),
        morphz::event::TYPE_TOOL_OUTPUT.to_string(),
        "chat/tool_output".to_string(),
        json!({
            "context_id": claimed.context_id,
            "session_id": claimed.session_id,
            "activation_id": claimed.activation_id,
            "thread_id": claimed.thread_id,
            "tool_call_id": claimed.tool_call_id,
            "tool_name": claimed.tool_name,
            "output": ""
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    let kernel = SchedulerKernel::new(Arc::clone(&store) as Arc<dyn morphz::memory::RuntimeStore>);
    let finished = match kernel
        .execute(
            morphz::controllers::ExecutionController::commit_job_outcome(
                &claimed.id,
                claimed.revision,
                claimed.claim_token.as_deref(),
                ExecutionJobTerminal {
                    status: ExecutionJobStatus::Succeeded,
                    result_event_id: Some(result_event.id.clone()),
                    result_refs: Vec::new(),
                    error: None,
                    exit_code: Some(0),
                },
                Some(result_event),
                false,
                "Store-Conformance",
            ),
        )
        .await
        .unwrap()
    {
        KernelResult::ExecutionJobOutcomeCommitted(ExecutionJobMutation::Updated(job)) => job,
        result => panic!("unexpected background terminal result: {result:?}"),
    };
    assert_eq!(finished.status, ExecutionJobStatus::Succeeded);
    assert!(
        store
            .list_terminal_execution_jobs_needing_signal("exec/background")
            .await
            .unwrap()
            .iter()
            .any(|job| job.id == finished.id),
        "terminal-owner crash windows must remain visible to startup recovery"
    );
    assert!(
        store
            .register_background_checkpoint(&created.id, 60, "conformance")
            .await
            .is_err(),
        "a terminal background Job must not arm another checkpoint"
    );
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
    let pending = store
        .list_context_pending_approvals(&job_record.context_id)
        .await
        .unwrap();
    assert!(pending.iter().any(|record| record.id == approval_record.id));
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
    assert!(!store
        .list_context_pending_approvals(&job_record.context_id)
        .await
        .unwrap()
        .iter()
        .any(|record| record.id == allowed.id));
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

    let (job, approval, request_event) = approval_bundle("cancel-job", "tool-call-approval-cancel");
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
            None,
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
            None,
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
            Some(second.as_ref()),
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
            Some(second.as_ref()),
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
        "the shared Event Store must contain one reply Event"
    );
}

#[tokio::test]
async fn sqlite_two_runtimes_with_different_contexts_keep_a_long_activation_single_owned() {
    let database = NamedTempFile::new().unwrap();
    let first = Arc::new(
        SqliteStore::new(database.path().to_str().unwrap())
            .await
            .unwrap(),
    );
    let second = Arc::new(
        SqliteStore::new(database.path().to_str().unwrap())
            .await
            .unwrap(),
    );
    first
        .create_agent_bundle(
            NewAgent {
                id: "sqlite-runtime-agent".to_string(),
                title: "SQLite Runtime Agent".to_string(),
                root_context_id: "sqlite-runtime-context-a".to_string(),
            },
            NewCognitiveContext {
                id: "sqlite-runtime-context-a".to_string(),
                agent_id: "sqlite-runtime-agent".to_string(),
                title: "SQLite Runtime Context A".to_string(),
            },
            NewSession {
                id: "sqlite-runtime-session-a".to_string(),
                agent_id: "sqlite-runtime-agent".to_string(),
                context_id: "sqlite-runtime-context-a".to_string(),
                parent_session_id: None,
                title: "SQLite Runtime Session A".to_string(),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await
        .unwrap();
    first
        .create_context(NewCognitiveContext {
            id: "sqlite-runtime-context-b".to_string(),
            agent_id: "sqlite-runtime-agent".to_string(),
            title: "SQLite Runtime Context B".to_string(),
        })
        .await
        .unwrap();
    first
        .create_session(NewSession {
            id: "sqlite-runtime-session-b".to_string(),
            agent_id: "sqlite-runtime-agent".to_string(),
            context_id: "sqlite-runtime-context-b".to_string(),
            parent_session_id: None,
            title: "SQLite Runtime Session B".to_string(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();

    let mut config = AppConfig::default();
    config.permissions.mode = PermissionMode::Custom;
    config.permissions.reviewer = ReviewerKind::Deny;
    // The provider delay crosses multiple original lease windows. The owner
    // must renew its own Activation while a peer Timer Engine is concurrently
    // claiming due timers from the same SQLite file.
    config.orchestrator.activation_lease_secs = 2;
    let client = Arc::new(DelayedMultiRuntimeReplyClient {
        calls: AtomicUsize::new(0),
        delay: std::time::Duration::from_secs(5),
    });
    let policy = RuntimeToolPolicy {
        context_only: true,
        coding_eval: true,
    };
    let runtime_a = MorphzRuntime::builder(config.clone(), client.clone())
        .store(
            "sqlite:test-runtime-a",
            Arc::clone(&first) as Arc<dyn morphz::memory::RuntimeStore>,
        )
        .identity(RuntimeIdentity {
            agent_id: "sqlite-runtime-agent".to_string(),
            context_id: "sqlite-runtime-context-a".to_string(),
            principal_id: "principal:sqlite-runtime-a".to_string(),
        })
        .tool_policy(policy)
        .build()
        .await
        .unwrap();
    let runtime_b = MorphzRuntime::builder(config, client.clone())
        .store(
            "sqlite:test-runtime-b",
            Arc::clone(&second) as Arc<dyn morphz::memory::RuntimeStore>,
        )
        .identity(RuntimeIdentity {
            agent_id: "sqlite-runtime-agent".to_string(),
            context_id: "sqlite-runtime-context-b".to_string(),
            principal_id: "principal:sqlite-runtime-b".to_string(),
        })
        .tool_policy(policy)
        .build()
        .await
        .unwrap();
    runtime_a.start().await.unwrap();
    runtime_b.start().await.unwrap();

    let mut replies_a = runtime_a.subscribe("chat/reply", 4);
    let mut replies_b = runtime_b.subscribe("chat/reply", 4);
    runtime_a
        .session("sqlite-runtime-session-a")
        .send(
            "hold this activation across lease windows",
            "Store-Conformance",
            Some("sqlite-runtime-long-message".to_string()),
        )
        .await
        .unwrap();
    let reply = tokio::time::timeout(std::time::Duration::from_secs(12), async {
        tokio::select! {
            event = replies_a.recv() => event,
            event = replies_b.recv() => event,
        }
    })
    .await
    .expect("one SQLite Runtime must finish the long Activation")
    .expect("reply subscription must remain open");
    assert_eq!(reply.payload["text"], "multi-runtime-delayed-ok");
    assert_eq!(client.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        first
            .query(QueryFilter {
                context_id: Some("sqlite-runtime-context-a".to_string()),
                session_id: Some("sqlite-runtime-session-a".to_string()),
                topic: Some("chat/reply".to_string()),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1
    );

    // Route the operator action through the Runtime whose default Context is
    // different from the active turn. It must close the durable Thread owned
    // by its peer instead of only notifying its own process-local registry.
    runtime_a
        .session("sqlite-runtime-session-a")
        .send(
            "cancel this turn from the peer runtime",
            "Store-Conformance",
            Some("sqlite-runtime-cancel-message".to_string()),
        )
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while client.calls.load(Ordering::SeqCst) < 2 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the second provider call must start before peer cancellation");
    assert!(
        runtime_b
            .cancel_session_durable(
                "sqlite-runtime-session-a",
                "peer Runtime conformance cancellation",
            )
            .await
            .unwrap()
            > 0
    );
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(6), async {
            tokio::select! {
                event = replies_a.recv() => event,
                event = replies_b.recv() => event,
            }
        })
        .await
        .is_err(),
        "the owner Runtime must drop its model future after durable peer cancellation"
    );
    assert_eq!(
        first
            .query(QueryFilter {
                context_id: Some("sqlite-runtime-context-a".to_string()),
                session_id: Some("sqlite-runtime-session-a".to_string()),
                topic: Some("chat/reply".to_string()),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1,
        "cancelled peer-owned Activation must not commit a late reply"
    );
}

async fn assert_provider_account_state_cas_conformance<S>(store: Arc<S>)
where
    S: ProviderAccountStateStore + 'static,
{
    let account_id = "provider-account-cas-conformance";
    let created = store
        .compare_and_set_provider_account_state(
            account_id,
            None,
            ProviderAccountStatus::Ready,
            None,
            None,
            false,
        )
        .await
        .unwrap();
    assert_eq!(created.revision, 1);
    assert!(store
        .compare_and_set_provider_account_state(
            account_id,
            None,
            ProviderAccountStatus::Disabled,
            None,
            Some("stale_absence"),
            false,
        )
        .await
        .is_err());
    let disabled = store
        .compare_and_set_provider_account_state(
            account_id,
            Some(created.revision),
            ProviderAccountStatus::Disabled,
            None,
            Some("operator_disabled"),
            false,
        )
        .await
        .unwrap();
    assert_eq!(disabled.revision, 2);
    assert_eq!(disabled.status, ProviderAccountStatus::Disabled);

    let route_a = store
        .compare_and_set_provider_route_account_state(
            "route-a",
            account_id,
            ProviderAccountStateMutation {
                expected_revision: None,
                status: ProviderAccountStatus::QuotaExhausted,
                cooldown_until: None,
                last_error_kind: Some("quota_exhausted".to_string()),
                mark_used: false,
            },
        )
        .await
        .unwrap();
    assert_eq!(route_a.revision, 1);
    assert_eq!(route_a.route_id, "route-a");
    assert_eq!(route_a.account_id, account_id);
    assert_eq!(route_a.status, ProviderAccountStatus::QuotaExhausted);
    assert!(store
        .get_provider_route_account_state("route-b", account_id)
        .await
        .unwrap()
        .is_none());
    assert!(store
        .compare_and_set_provider_route_account_state(
            "route-a",
            account_id,
            ProviderAccountStateMutation {
                expected_revision: None,
                status: ProviderAccountStatus::Ready,
                cooldown_until: None,
                last_error_kind: None,
                mark_used: false,
            },
        )
        .await
        .is_err());
    let recovered = store
        .compare_and_set_provider_route_account_state(
            "route-a",
            account_id,
            ProviderAccountStateMutation {
                expected_revision: Some(route_a.revision),
                status: ProviderAccountStatus::Ready,
                cooldown_until: None,
                last_error_kind: None,
                mark_used: false,
            },
        )
        .await
        .unwrap();
    assert_eq!(recovered.revision, 2);
    assert_eq!(recovered.status, ProviderAccountStatus::Ready);
}

async fn assert_agent_provider_binding_conformance<S>(store: Arc<S>)
where
    S: AgentProviderBindingStore + SessionDirectoryStore + 'static,
{
    let initial = store
        .get_agent_provider_bindings("conformance-agent")
        .await
        .unwrap()
        .expect("Agent Bootstrap must create an explicit empty Provider policy");
    assert_eq!(initial.revision, 1);
    assert!(initial.bindings.is_empty());

    let primary = store
        .bind_agent_provider_account("conformance-agent", "shared-account")
        .await
        .unwrap();
    assert_eq!(primary.revision, 2);
    assert_eq!(primary.bindings[0].account_id, "shared-account");
    let by_context = store
        .get_context_agent_provider_bindings("conformance-context")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(by_context.agent_id, "conformance-agent");
    assert_eq!(by_context.bindings[0].account_id, "shared-account");

    store
        .ensure_agent(NewAgent {
            id: "conformance-provider-binding-agent".to_string(),
            title: "Provider Binding Agent".to_string(),
            root_context_id: "conformance-provider-binding-context".to_string(),
        })
        .await
        .unwrap();
    store
        .initialize_agent_provider_bindings(
            "conformance-provider-binding-agent",
            &["shared-account".to_string()],
        )
        .await
        .unwrap();
    let shared = store
        .list_provider_account_agent_bindings("shared-account")
        .await
        .unwrap();
    assert_eq!(shared.len(), 2);

    store
        .ensure_agent(NewAgent {
            id: "conformance-empty-provider-agent".to_string(),
            title: "Empty Provider Agent".to_string(),
            root_context_id: "conformance-empty-provider-context".to_string(),
        })
        .await
        .unwrap();
    store
        .initialize_agent_provider_bindings("conformance-empty-provider-agent", &[])
        .await
        .unwrap();
    let still_empty = store
        .initialize_agent_provider_bindings(
            "conformance-empty-provider-agent",
            &["must-not-be-adopted".to_string()],
        )
        .await
        .unwrap();
    assert!(still_empty.bindings.is_empty());

    let unbound = store
        .unbind_agent_provider_account("conformance-agent", "shared-account")
        .await
        .unwrap();
    assert_eq!(unbound.revision, 3);
    assert!(unbound.bindings.is_empty());
    assert_eq!(
        store
            .list_provider_account_agent_bindings("shared-account")
            .await
            .unwrap()
            .len(),
        1
    );
}

async fn assert_context_runtime_directory_snapshot_conformance<S>(store: Arc<S>)
where
    S: morphz::memory::RuntimeStore + MindProjectionStore + 'static,
{
    let context_id = "conformance-context";
    let context = store
        .get_context(context_id)
        .await
        .unwrap()
        .expect("conformance Context must exist");
    let request = ContextRuntimeDirectoryRequest {
        context_id: context_id.to_string(),
        active_session_id: "conformance-session".to_string(),
        active_after: chrono::Utc::now() - chrono::Duration::hours(24),
        max_full_sessions: 50,
        max_metadata_sessions: 50,
        known_context_state_revision: None,
        session_filter: ContextRuntimeSessionFilter::default(),
    };
    let actual = store
        .read_context_runtime_directory_snapshot(&request)
        .await
        .unwrap()
        .expect("directory snapshot must exist");
    assert_eq!(actual.context, context);
    assert_eq!(
        actual.cognitive_clock,
        store.get_context_cognitive_clock(context_id).await.unwrap()
    );
    let legacy_state = store.get_mind_projection(context_id).await.unwrap();
    assert_eq!(
        actual.context_state.as_ref().map(|record| record.revision),
        legacy_state.as_ref().map(|record| record.revision)
    );
    assert_eq!(
        actual
            .context_state
            .as_ref()
            .map(|record| serde_json::to_value(&record.state).unwrap()),
        legacy_state.as_ref().map(|record| record.state.clone())
    );
    assert_eq!(
        actual.context_state_head.as_ref().map(|head| head.revision),
        actual.context_state.as_ref().map(|mind| mind.revision)
    );
    assert!(actual.sessions.len() <= 100);
    assert!(actual
        .sessions
        .iter()
        .any(|session| session.id == "conformance-session"));
    let selected_ids = actual
        .sessions
        .iter()
        .map(|session| session.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    assert!(actual
        .principal_bindings
        .iter()
        .all(|binding| selected_ids.contains(binding.session_id.as_str())));
    if let Some(revision) = actual.context_state.as_ref().map(|mind| mind.revision) {
        let mut fenced_request = request.clone();
        fenced_request.known_context_state_revision = Some(revision);
        let fenced = store
            .read_context_runtime_directory_snapshot(&fenced_request)
            .await
            .unwrap()
            .expect("revision-fenced directory snapshot must exist");
        assert_eq!(fenced.context_state_head, actual.context_state_head);
        assert!(
            fenced.context_state.is_none(),
            "a matching resident revision must omit the large Mind payload"
        );
        assert_eq!(
            fenced.revision, actual.revision,
            "payload transfer is not part of the directory content revision"
        );

        let mut stale_request = request.clone();
        stale_request.known_context_state_revision = Some(revision.saturating_add(1));
        let stale = store
            .read_context_runtime_directory_snapshot(&stale_request)
            .await
            .unwrap()
            .expect("stale-fenced directory snapshot must exist");
        assert_eq!(stale.context_state, actual.context_state);
    }
    assert_eq!(
        store
            .read_context_runtime_directory_snapshot(&ContextRuntimeDirectoryRequest {
                context_id: "missing-context".to_string(),
                active_session_id: "missing-session".to_string(),
                ..request
            })
            .await
            .unwrap(),
        None
    );
}

async fn assert_context_runtime_scheduler_snapshot_conformance<S>(store: Arc<S>)
where
    S: morphz::memory::RuntimeStore + 'static,
{
    let context_id = "conformance-context";
    let recent_terminal_limit = 20;
    let group_limit = 32;
    let mut delivery_thread_ids = store
        .list_context_threads(context_id, true)
        .await
        .unwrap()
        .into_iter()
        .filter(|thread| {
            matches!(
                thread.delivery_status,
                DeliveryStatus::Pending | DeliveryStatus::Deferred
            )
        })
        .map(|thread| thread.id)
        .collect::<Vec<_>>();
    delivery_thread_ids.sort();
    delivery_thread_ids.dedup();

    let active_threads = store.list_context_threads(context_id, false).await.unwrap();
    let active_thread_ids = active_threads
        .iter()
        .map(|thread| thread.id.clone())
        .collect::<Vec<_>>();
    let schedules = store
        .list_thread_schedules(context_id, &active_thread_ids)
        .await
        .unwrap()
        .into_iter()
        .filter(|schedule| schedule.status == ScheduleStatus::Queued)
        .collect::<Vec<_>>();
    let mut projected = active_threads;
    for thread_id in &delivery_thread_ids {
        if let Some(thread) = store.get_thread(thread_id).await.unwrap() {
            if thread.context_id == context_id
                && matches!(
                    thread.delivery_status,
                    DeliveryStatus::Pending | DeliveryStatus::Deferred
                )
                && !projected.iter().any(|current| current.id == thread.id)
            {
                projected.push(thread);
            }
        }
    }
    let mut recent_terminal = store
        .list_recent_terminal_threads(context_id, recent_terminal_limit)
        .await
        .unwrap()
        .into_iter()
        .filter(|thread| {
            !matches!(
                thread.delivery_status,
                DeliveryStatus::Pending | DeliveryStatus::Deferred
            ) && !projected.iter().any(|current| current.id == thread.id)
        })
        .collect::<Vec<_>>();
    recent_terminal.reverse();
    projected.extend(recent_terminal);

    let mut group_ids = projected
        .iter()
        .filter_map(|thread| thread.supervision.thread_group_id.clone())
        .collect::<Vec<_>>();
    group_ids.sort();
    group_ids.dedup();
    group_ids.truncate(group_limit);
    let groups = store
        .list_thread_groups_by_ids(context_id, &group_ids)
        .await
        .unwrap();
    let members = store
        .list_thread_group_members_for_groups(&group_ids)
        .await
        .unwrap()
        .into_iter()
        .map(|(_, member)| member)
        .collect::<Vec<_>>();
    let outcomes = store
        .list_thread_group_outcomes_for_groups(&group_ids)
        .await
        .unwrap()
        .into_iter()
        .map(|(_, outcome)| outcome)
        .collect::<Vec<_>>();
    let projected_thread_ids = projected
        .iter()
        .map(|thread| thread.id.clone())
        .collect::<Vec<_>>();
    let signals = store
        .list_context_thread_signals_for_threads(
            context_id,
            &projected_thread_ids,
            Some(ThreadSignalStatus::Pending),
        )
        .await
        .unwrap();
    let expected = ContextRuntimeSchedulerSnapshot::from_components(
        projected, groups, members, outcomes, schedules, signals,
    )
    .unwrap();
    let actual = store
        .read_context_runtime_scheduler_snapshot(
            context_id,
            &delivery_thread_ids,
            recent_terminal_limit,
            group_limit,
        )
        .await
        .unwrap();
    assert_eq!(actual, expected);

    let mut reversed_delivery_ids = delivery_thread_ids;
    reversed_delivery_ids.reverse();
    assert_eq!(
        store
            .read_context_runtime_scheduler_snapshot(
                context_id,
                &reversed_delivery_ids,
                recent_terminal_limit,
                group_limit,
            )
            .await
            .unwrap(),
        actual,
        "delivery input ordering must not perturb the scheduler snapshot"
    );
}

async fn assert_context_activation_causality_snapshot_conformance<S>(store: Arc<S>)
where
    S: morphz::memory::RuntimeStore + 'static,
{
    let context_id = "conformance-context";
    let activation = store
        .get_thread_activation("conformance-activation")
        .await
        .unwrap()
        .expect("conformance Activation must exist");
    let signals = store.list_activation_signals(&activation.id).await.unwrap();
    let thread = store
        .get_thread_by_root(&activation.root_turn_id)
        .await
        .unwrap();
    let trigger_event = store
        .query(QueryFilter {
            event_id: Some(activation.trigger_event_id.clone()),
            context_id: Some(context_id.to_string()),
            ..QueryFilter::default()
        })
        .await
        .unwrap()
        .into_iter()
        .next();
    let direct_root_event = store
        .query(QueryFilter {
            event_id: Some(activation.root_turn_id.clone()),
            context_id: Some(context_id.to_string()),
            ..QueryFilter::default()
        })
        .await
        .unwrap()
        .into_iter()
        .next();
    let first_activation = store
        .get_first_thread_activation_by_root(context_id, &activation.root_turn_id)
        .await
        .unwrap();
    let first_trigger_event = if direct_root_event.is_none() {
        if let Some(first) = &first_activation {
            store
                .query(QueryFilter {
                    event_id: Some(first.trigger_event_id.clone()),
                    context_id: Some(context_id.to_string()),
                    ..QueryFilter::default()
                })
                .await
                .unwrap()
                .into_iter()
                .next()
        } else {
            None
        }
    } else {
        None
    };
    let root_sequence = direct_root_event
        .as_ref()
        .and_then(|event| event.sequence)
        .or_else(|| {
            first_activation
                .as_ref()
                .map(|first| first.trigger_sequence)
        });
    let expected = ContextActivationCausalitySnapshot::from_components(
        signals,
        thread,
        trigger_event,
        direct_root_event.or(first_trigger_event),
        root_sequence,
    )
    .unwrap();
    let actual = store
        .read_context_activation_causality_snapshot(
            context_id,
            &activation.id,
            &activation.root_turn_id,
            &activation.trigger_event_id,
        )
        .await
        .unwrap();
    assert_eq!(actual, expected);
}

async fn assert_context_execution_resources_snapshot_conformance<S>(store: Arc<S>)
where
    S: morphz::memory::RuntimeStore + 'static,
{
    let context_id = "conformance-context";
    let principal_id = "principal:conformance";
    let target_limit = 16;
    let authorization_limit = 1_000;
    let jobs = store
        .list_execution_jobs(morphz::memory::ExecutionJobFilter {
            context_id: Some(context_id.to_string()),
            tool_name: Some("exec/background".to_string()),
            include_terminal: false,
            ..Default::default()
        })
        .await
        .unwrap();
    let expected = ContextExecutionResourcesSnapshot::from_components(
        jobs.clone(),
        store
            .list_execution_targets(ExecutionTargetFilter {
                visible_to_principal_id: Some(principal_id.to_string()),
                limit: Some(target_limit),
                ..Default::default()
            })
            .await
            .unwrap(),
        store
            .list_execution_target_authorizations(ExecutionTargetAuthorizationFilter {
                owner_principal_id: Some(principal_id.to_string()),
                limit: Some(authorization_limit),
                ..Default::default()
            })
            .await
            .unwrap(),
    )
    .unwrap();
    let actual = store
        .read_context_execution_resources_snapshot(
            context_id,
            Some(principal_id),
            target_limit,
            authorization_limit,
        )
        .await
        .unwrap();
    assert_eq!(actual, expected);

    let expected_anonymous = ContextExecutionResourcesSnapshot::from_components(
        jobs,
        store
            .list_execution_targets(ExecutionTargetFilter {
                owner_principal_is_null: true,
                limit: Some(target_limit),
                ..Default::default()
            })
            .await
            .unwrap(),
        Vec::new(),
    )
    .unwrap();
    assert_eq!(
        store
            .read_context_execution_resources_snapshot(
                context_id,
                None,
                target_limit,
                authorization_limit,
            )
            .await
            .unwrap(),
        expected_anonymous
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
    assert_agent_provider_binding_conformance(Arc::clone(&store)).await;
    assert_session_directory_conformance(Arc::clone(&store)).await;
    assert_principal_first_seen_conformance(Arc::clone(&store)).await;
    assert_concurrent_parallel_ingress_conformance(Arc::clone(&store)).await;
    assert_concurrent_ordered_ingress_conformance(Arc::clone(&store)).await;
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
    assert_dialogue_interruption_conformance(Arc::clone(&store)).await;
    assert_scheduler_dependency_conformance(Arc::clone(&store)).await;
    assert_schedule_store_conformance(Arc::clone(&store)).await;
    assert_delivery_ingress_conformance(Arc::clone(&store)).await;
    assert_session_signal_conformance(Arc::clone(&store)).await;
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
    assert_background_wake_checkpoint_conformance(Arc::clone(&store)).await;
    assert_provider_account_state_cas_conformance(Arc::clone(&store)).await;
    assert_approval_grant_conformance(Arc::clone(&store)).await;
    assert_context_runtime_scheduler_snapshot_conformance(Arc::clone(&store)).await;
    assert_context_activation_causality_snapshot_conformance(Arc::clone(&store)).await;
    assert_context_execution_resources_snapshot_conformance(Arc::clone(&store)).await;
    assert_context_runtime_directory_snapshot_conformance(store).await;
}

#[tokio::test]
async fn postgres_session_pooler_smoke_when_configured() {
    let Ok(database_url) = std::env::var("MORPHZ_TEST_POSTGRES_URL") else {
        return;
    };
    let deadline = std::time::Duration::from_secs(20);
    eprintln!("postgres smoke: connect");
    let pool = tokio::time::timeout(
        deadline,
        sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .acquire_timeout(deadline)
            .connect(&database_url),
    )
    .await
    .expect("PostgreSQL connection timed out")
    .expect("PostgreSQL connection failed");
    let value = tokio::time::timeout(
        deadline,
        sqlx::query_scalar::<_, i64>("SELECT 1::bigint").fetch_one(&pool),
    )
    .await
    .expect("PostgreSQL SELECT timed out")
    .expect("PostgreSQL SELECT failed");
    assert_eq!(value, 1);

    let suffix = chrono::Utc::now()
        .timestamp_nanos_opt()
        .expect("current timestamp must fit i64");
    let schema = format!("morphz_smoke_{}_{suffix}", std::process::id());
    eprintln!("postgres smoke: schema and transaction");
    tokio::time::timeout(
        deadline,
        sqlx::query(&format!("CREATE SCHEMA {schema}")).execute(&pool),
    )
    .await
    .expect("CREATE SCHEMA timed out")
    .expect("CREATE SCHEMA failed");
    let mut transaction = pool.begin().await.expect("BEGIN failed");
    let advisory_lock = sqlx::query_scalar::<_, bool>("SELECT pg_try_advisory_xact_lock(780871)")
        .fetch_one(&mut *transaction)
        .await
        .expect("transaction advisory lock failed");
    assert!(advisory_lock);
    sqlx::query(&format!(
        "CREATE TABLE {schema}.transaction_probe (id bigint PRIMARY KEY)"
    ))
    .execute(&mut *transaction)
    .await
    .expect("transaction DDL failed");
    transaction.rollback().await.expect("ROLLBACK failed");

    eprintln!("postgres smoke: LISTEN/NOTIFY");
    let channel = format!(
        "morphz_smoke_{}_{}",
        std::process::id(),
        suffix.unsigned_abs()
    );
    let mut listener =
        tokio::time::timeout(deadline, sqlx::postgres::PgListener::connect(&database_url))
            .await
            .expect("PgListener connection timed out")
            .expect("PgListener connection failed");
    tokio::time::timeout(deadline, listener.listen(&channel))
        .await
        .expect("LISTEN timed out")
        .expect("LISTEN failed");
    tokio::time::timeout(
        deadline,
        sqlx::query(&format!("NOTIFY {channel}, 'morphz-smoke'")).execute(&pool),
    )
    .await
    .expect("NOTIFY statement timed out")
    .expect("NOTIFY statement failed");
    let notification = tokio::time::timeout(deadline, listener.recv())
        .await
        .expect("notification delivery timed out")
        .expect("notification delivery failed");
    assert_eq!(notification.payload(), "morphz-smoke");

    eprintln!("postgres smoke: cleanup");
    tokio::time::timeout(
        deadline,
        sqlx::query(&format!("DROP SCHEMA {schema} CASCADE")).execute(&pool),
    )
    .await
    .expect("DROP SCHEMA timed out")
    .expect("DROP SCHEMA failed");
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
        "20260815_01_recall_whole_document_index",
        "20260815_02_recall_whole_document_event_backfill",
        "20260815_03_session_projection_sequences",
        "20260815_04_sql_performance_indexes",
        "20260816_01_thread_signal_notifications",
        "20260816_02_edge_command_notifications",
        "20260816_03_directory_domain_constraints",
        "20260816_04_core_domain_constraints",
        "20260820_01_tool_call_history",
        "20260820_02_principal_context_encounters",
        "20260901_01_agent_provider_bindings",
    ] {
        assert!(
            applied_migrations.contains(version),
            "missing PostgreSQL migration marker {version}"
        );
    }
    let directory_constraints = sqlx::query_scalar::<_, String>(
        r#"SELECT conname
           FROM pg_constraint
           WHERE conrelid IN ('agents'::regclass, 'cognitive_contexts'::regclass, 'sessions'::regclass)"#,
    )
    .fetch_all(store.pool())
    .await
    .unwrap()
    .into_iter()
    .collect::<std::collections::HashSet<_>>();
    for constraint in [
        "agents_status_domain",
        "cognitive_contexts_status_domain",
        "cognitive_contexts_token_budget_revision_nonnegative",
        "sessions_status_domain",
        "sessions_attention_state_domain",
        "sessions_attention_revision_nonnegative",
        "sessions_mount_kind_domain",
    ] {
        assert!(
            directory_constraints.contains(constraint),
            "missing PostgreSQL directory constraint {constraint}"
        );
    }
    let core_constraints = sqlx::query_scalar::<_, String>(
        r#"SELECT conname
           FROM pg_constraint
           WHERE conrelid IN (
             'signal_outbox'::regclass,
             'runtime_timers'::regclass,
             'objectives'::regclass,
             'threads'::regclass,
             'thread_activations'::regclass,
             'execution_jobs'::regclass,
             'action_groups'::regclass,
             'action_group_members'::regclass,
             'approval_requests'::regclass,
             'sessions'::regclass
           )"#,
    )
    .fetch_all(store.pool())
    .await
    .unwrap()
    .into_iter()
    .collect::<std::collections::HashSet<_>>();
    for constraint in [
        "signal_outbox_status_domain",
        "runtime_timers_kind_domain",
        "runtime_timers_status_domain",
        "objectives_status_domain",
        "threads_kind_domain",
        "threads_status_domain",
        "threads_supervisor_kind_domain",
        "thread_activations_status_domain",
        "execution_jobs_status_domain",
        "execution_jobs_retry_safety_domain",
        "action_groups_status_domain",
        "action_group_members_status_domain",
        "action_group_members_result_invariant",
        "approval_requests_status_domain",
        "sessions_parent_session_fk",
    ] {
        assert!(
            core_constraints.contains(constraint),
            "missing PostgreSQL core constraint {constraint}"
        );
    }
    let retention_now = chrono::Utc::now();
    let retention_old = (retention_now - chrono::Duration::days(30)).to_rfc3339();
    let retention_fresh = (retention_now + chrono::Duration::hours(1)).to_rfc3339();
    for event_id in ["pg-retention-old-event", "pg-retention-fresh-event"] {
        sqlx::query(
            r#"INSERT INTO events
               (id, timestamp, actor, type, topic, payload)
               VALUES ($1, $2, 'runtime', 'system', 'runtime/test', '{}'::jsonb)"#,
        )
        .bind(event_id)
        .bind(&retention_old)
        .execute(store.pool())
        .await
        .unwrap();
    }
    for (event_id, resolved_at) in [
        ("pg-retention-old-event", retention_old.as_str()),
        ("pg-retention-fresh-event", retention_fresh.as_str()),
    ] {
        sqlx::query(
            r#"INSERT INTO signal_outbox
               (event_id, status, signal_id, created_at, resolved_at)
               VALUES ($1, 'discarded', NULL, $2, $3)"#,
        )
        .bind(event_id)
        .bind(&retention_old)
        .bind(resolved_at)
        .execute(store.pool())
        .await
        .unwrap();
    }
    sqlx::query(
        r#"INSERT INTO execution_nodes
           (id, owner_principal_id, name, status, device_key_fingerprint,
            device_public_key, device_token_hash, protocol_version,
            created_at, updated_at)
           VALUES ('pg-retention-node', 'principal', 'node', 'offline',
                   'fingerprint', 'public-key', 'token', 1, $1, $1)"#,
    )
    .bind(&retention_old)
    .execute(store.pool())
    .await
    .unwrap();
    for (suffix, expires_at) in [
        ("old", retention_old.as_str()),
        ("fresh", retention_fresh.as_str()),
    ] {
        sqlx::query(
            r#"INSERT INTO execution_node_pairing_codes
               (code_hash, owner_principal_id, expires_at, created_at)
               VALUES ($1, 'principal', $2, $3)"#,
        )
        .bind(format!("pg-pairing-{suffix}"))
        .bind(expires_at)
        .bind(&retention_old)
        .execute(store.pool())
        .await
        .unwrap();
        sqlx::query(
            r#"INSERT INTO execution_node_challenges
               (id, node_id, nonce_hash, expires_at, created_at)
               VALUES ($1, 'pg-retention-node', $2, $3, $4)"#,
        )
        .bind(format!("pg-challenge-{suffix}"))
        .bind(format!("nonce-{suffix}"))
        .bind(expires_at)
        .bind(&retention_old)
        .execute(store.pool())
        .await
        .unwrap();
    }
    let retention_report = store
        .prune_transient_storage(TransientStorageRetention {
            resolved_signal_outbox_before: retention_now,
            expired_edge_credentials_before: retention_now,
            batch_limit: 10,
        })
        .await
        .unwrap();
    assert_eq!(retention_report.resolved_signal_outbox_deleted, 1);
    assert_eq!(retention_report.expired_pairing_codes_deleted, 1);
    assert_eq!(retention_report.expired_challenges_deleted, 1);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM events WHERE id LIKE 'pg-retention-%-event'",
        )
        .fetch_one(store.pool())
        .await
        .unwrap(),
        2,
        "PostgreSQL transient cleanup must preserve persisted Events"
    );
    let installed_indexes = sqlx::query_scalar::<_, String>(
        "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()",
    )
    .fetch_all(store.pool())
    .await
    .unwrap()
    .into_iter()
    .collect::<std::collections::HashSet<_>>();
    for index in [
        "idx_pg_threads_context_open_created",
        "idx_pg_thread_activations_context_active_created",
        "idx_pg_execution_jobs_context_active_created",
        "idx_pg_execution_jobs_tool_status",
        "idx_pg_plan_executions_wait_kind",
        "idx_pg_execution_targets_kind_provider_status",
        "idx_pg_session_projections_context_session_sequence",
        "idx_pg_session_message_requests_session_created",
    ] {
        assert!(
            installed_indexes.contains(index),
            "missing PostgreSQL performance index {index}"
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
    assert_agent_provider_binding_conformance(Arc::clone(&store)).await;
    assert_session_directory_conformance(Arc::clone(&store)).await;
    assert_principal_first_seen_conformance(Arc::clone(&store)).await;
    assert_concurrent_parallel_ingress_conformance(Arc::clone(&store)).await;
    assert_concurrent_ordered_ingress_conformance(Arc::clone(&store)).await;
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
    assert_dialogue_interruption_conformance(Arc::clone(&store)).await;
    assert_scheduler_dependency_conformance(Arc::clone(&store)).await;
    assert_schedule_store_conformance(Arc::clone(&store)).await;
    assert_delivery_ingress_conformance(Arc::clone(&store)).await;
    assert_session_signal_conformance(Arc::clone(&store)).await;
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
    assert_background_wake_checkpoint_conformance(Arc::clone(&store)).await;
    assert_provider_account_state_cas_conformance(Arc::clone(&store)).await;
    assert_approval_grant_conformance(Arc::clone(&store)).await;
    assert_context_runtime_scheduler_snapshot_conformance(Arc::clone(&store)).await;
    assert_context_activation_causality_snapshot_conformance(Arc::clone(&store)).await;
    assert_context_execution_resources_snapshot_conformance(Arc::clone(&store)).await;
    assert_context_runtime_directory_snapshot_conformance(Arc::clone(&store)).await;

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

    // Exercise the real PostgreSQL upgrade path, not only a fresh schema:
    // recreate the temporary chunk table, reset the new marker, and verify a
    // second Store collapses overlap and drops the obsolete physical layer.
    sqlx::query(
        r#"CREATE TABLE recall_document_chunks (
             context_id TEXT NOT NULL,
             document_kind TEXT NOT NULL,
             document_id TEXT NOT NULL,
             chunk_index BIGINT NOT NULL,
             searchable_text TEXT NOT NULL,
             PRIMARY KEY(context_id, document_kind, document_id, chunk_index)
           )"#,
    )
    .execute(store.pool())
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO recall_document_chunks VALUES
             ('conformance-context', 'event', 'recall-long-event', 0,
              'alpha beta gamma'),
             ('conformance-context', 'event', 'recall-long-event', 1,
              'beta gamma postgres migration suffix')"#,
    )
    .execute(store.pool())
    .await
    .unwrap();
    sqlx::query(
        r#"UPDATE recall_documents SET searchable_text = 'alpha beta gamma'
           WHERE context_id = 'conformance-context'
             AND document_kind = 'event' AND document_id = 'recall-long-event'"#,
    )
    .execute(store.pool())
    .await
    .unwrap();
    sqlx::query("DROP INDEX IF EXISTS idx_pg_recall_documents_terms")
        .execute(store.pool())
        .await
        .unwrap();
    sqlx::query(
        "DELETE FROM schema_migrations WHERE version = '20260815_01_recall_whole_document_index'",
    )
    .execute(store.pool())
    .await
    .unwrap();
    let migrated_store = PostgresStore::new(&scoped_url, 8).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT searchable_text FROM recall_documents WHERE document_id = 'recall-long-event'",
        )
        .fetch_one(migrated_store.pool())
        .await
        .unwrap(),
        "alpha beta gamma postgres migration suffix"
    );
    assert!(!sqlx::query_scalar::<_, bool>(
        "SELECT to_regclass('recall_document_chunks') IS NOT NULL",
    )
    .fetch_one(migrated_store.pool())
    .await
    .unwrap());
    assert!(migrated_store
        .search_recall_documents("conformance-context", "migration suffix", 8)
        .await
        .unwrap()
        .iter()
        .any(|hit| hit.document_id == "recall-long-event"));

    // A whole document can legitimately exceed PostgreSQL `tsvector`'s value
    // ceiling. The term-array GIN index must accept and find such a document
    // without forcing an arbitrary projection chunk size back into the model.
    let oversized_terms = (0..150_000)
        .map(|index| format!("oversized{index}"))
        .collect::<Vec<_>>()
        .join(" ");
    let oversized_single_term = "z".repeat(100_000);
    let oversized_document = format!("{oversized_terms} {oversized_single_term}");
    let oversized_keys = oversized_document
        .split_whitespace()
        .map(|term| format!("{:x}", Sha256::digest(term.as_bytes())))
        .collect::<Vec<_>>();
    sqlx::query(
        r#"INSERT INTO recall_documents
           (context_id, document_kind, document_id, revision, searchable_text,
            search_term_keys, preview, retired, updated_sequence, state_hash)
           VALUES ('conformance-context', 'frame', 'memory/postgres-oversized', 1,
                   $1, $2, 'oversized PostgreSQL document', FALSE, 99, 'oversized-hash')"#,
    )
    .bind(&oversized_document)
    .bind(&oversized_keys)
    .execute(migrated_store.pool())
    .await
    .unwrap();
    assert!(migrated_store
        .search_recall_documents("conformance-context", "oversized149999", 8)
        .await
        .unwrap()
        .iter()
        .any(|hit| hit.document_id == "memory/postgres-oversized"));
    assert!(migrated_store
        .search_recall_documents("conformance-context", &oversized_single_term, 8)
        .await
        .unwrap()
        .iter()
        .any(|hit| hit.document_id == "memory/postgres-oversized"));

    // This helper creates another isolated schema, so it must derive that
    // schema from the base database URL instead of stacking a second
    // `options=search_path` parameter on this run's already-scoped URL.
    assert_two_postgres_runtimes_deliver_one_dialogue_once(&database_url, &store).await;
}
