use morphz::config::AppConfig;
use morphz::llm::{Client, Message, Response, ToolDefinition};
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{
    ActivationStore as _, NewSession, NewThread, RuntimeStore, SessionMountKind,
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
async fn operator_close_dispatches_the_durable_parent_signal_without_restart() {
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

    runtime
        .control_thread(
            &runtime.identity().context_id,
            &child.id,
            child.revision,
            ThreadControlAction::Close,
            "operator cancelled the child",
        )
        .await
        .unwrap();

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
        .expect("operator close should persist one direct parent Signal");
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
