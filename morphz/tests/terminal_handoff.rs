use morphz::config::AppConfig;
use morphz::llm::{Client, Message, Response, ToolDefinition};
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{
    ActivationStore as _, ExecutionJobStatus, ExecutionJobStore as _, ExecutionRetrySafety,
    NewExecutionJob, NewSession, NewThread, NewThreadActivation, RuntimeStore, SessionMountKind,
    ThreadControlAction, ThreadKind, ThreadSignalStatus, ThreadStore as _, ThreadSupervision,
};
use morphz::runtime::MorphzRuntime;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tempfile::NamedTempFile;

struct TerminalHandoffClient {
    calls: AtomicUsize,
}

#[async_trait::async_trait]
impl Client for TerminalHandoffClient {
    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(Response {
            content: "parent observed the child cancellation".to_string(),
            tool_calls: Vec::new(),
        })
    }
}

#[tokio::test]
async fn operator_cancel_closes_physical_work_and_dispatches_the_parent_signal() {
    let database = NamedTempFile::new().unwrap();
    let store = Arc::new(
        SqliteStore::new(database.path().to_str().unwrap())
            .await
            .unwrap(),
    );
    let client = Arc::new(TerminalHandoffClient {
        calls: AtomicUsize::new(0),
    });
    let runtime = MorphzRuntime::builder(AppConfig::default(), client.clone())
        .store(
            "sqlite:terminal-handoff-test",
            Arc::clone(&store) as Arc<dyn RuntimeStore>,
        )
        .build()
        .await
        .unwrap();
    runtime.start().await.unwrap();
    let session = runtime
        .ensure_session(NewSession {
            id: "terminal-handoff-session".to_string(),
            agent_id: runtime.identity().agent_id.clone(),
            context_id: runtime.identity().context_id.clone(),
            parent_session_id: None,
            title: "Terminal handoff".to_string(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();

    let parent = store
        .ensure_thread(NewThread {
            id: "terminal-handoff-parent".to_string(),
            agent_id: runtime.identity().agent_id.clone(),
            context_id: runtime.identity().context_id.clone(),
            session_id: session.id().to_string(),
            initiating_principal_id: None,
            root_turn_id: "terminal-handoff-parent-root".to_string(),
            kind: ThreadKind::Execution,
            executor_kind: "self".to_string(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::legacy(),
        })
        .await
        .unwrap();
    let child = store
        .ensure_thread(NewThread {
            id: "terminal-handoff-child".to_string(),
            agent_id: runtime.identity().agent_id.clone(),
            context_id: runtime.identity().context_id.clone(),
            session_id: session.id().to_string(),
            initiating_principal_id: None,
            root_turn_id: "terminal-handoff-child-root".to_string(),
            kind: ThreadKind::Execution,
            executor_kind: "self".to_string(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::attached(
                parent.id.clone(),
                parent.generation,
                "terminal-handoff-evaluation",
            ),
        })
        .await
        .unwrap();
    let child_activation = store
        .ensure_thread_activation(NewThreadActivation {
            id: "terminal-handoff-child-activation".to_string(),
            agent_id: child.agent_id.clone(),
            context_id: child.context_id.clone(),
            session_id: child.session_id.clone(),
            initiating_principal_id: None,
            trigger_event_id: "terminal-handoff-child-trigger".to_string(),
            trigger_sequence: 1,
            trigger_kind: "test".to_string(),
            parent_activation_id: None,
            root_turn_id: child.root_turn_id.clone(),
        })
        .await
        .unwrap();
    let child_job = store
        .create_execution_job(NewExecutionJob {
            id: "terminal-handoff-child-job".to_string(),
            activation_id: child_activation.id.clone(),
            thread_id: child.id.clone(),
            agent_id: child.agent_id.clone(),
            context_id: child.context_id.clone(),
            session_id: child.session_id.clone(),
            initiating_principal_id: None,
            target_id: morphz::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
            tool_call_id: "terminal-handoff-child-call".to_string(),
            tool_name: "exec/background".to_string(),
            request: serde_json::json!({"command": "test fixture"}),
            retry_safety: ExecutionRetrySafety::ReconcileRequired,
            requires_approval: false,
        })
        .await
        .unwrap();

    runtime
        .control_thread(
            &runtime.identity().context_id,
            &child.id,
            child.revision,
            ThreadControlAction::Cancel,
            "operator cancelled the child",
        )
        .await
        .unwrap();

    let cancelled_job = store
        .get_execution_job(&child_job.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(cancelled_job.status, ExecutionJobStatus::Cancelled);
    assert!(cancelled_job.cancel_requested_at.is_some());

    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if client.calls.load(Ordering::SeqCst) == 1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the parent should be woken by the already-durable child barrier");

    let signal = store
        .list_context_thread_signals(&runtime.identity().context_id, None)
        .await
        .unwrap()
        .into_iter()
        .find(|signal| signal.thread_id == parent.id)
        .expect("operator cancellation should persist one direct parent Signal");
    assert_ne!(signal.status, ThreadSignalStatus::Pending);
    let activations = store
        .list_thread_activations_by_root(
            &runtime.identity().context_id,
            "terminal-handoff-parent-root",
        )
        .await
        .unwrap();
    assert_eq!(activations.len(), 1);
}
