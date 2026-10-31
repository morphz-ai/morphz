//! A finite Harness must retain native Context maintenance before its entry.
//! The deterministic Provider measures pressure from an actual committed
//! retirement; returning a tool call alone cannot make the fixture healthy.

use super::*;
use crate::llm::{
    Client, Message, PromptTokenAccuracy, PromptTokenCount, Response, ToolCallRepr, ToolDefinition,
};
use crate::memory::sqlite::SqliteStore;
use crate::test_sqlite::TempSqliteDb;
use std::collections::BTreeSet;
use std::sync::atomic::AtomicUsize;
use std::sync::Mutex;

const SEED: &str = "finite-maintenance-seed";

struct MaintenanceClient {
    store: Arc<dyn RuntimeStore>,
    context_id: Mutex<String>,
    calls: AtomicUsize,
}

#[async_trait::async_trait]
impl Client for MaintenanceClient {
    async fn count_prompt_tokens(
        &self,
        _scope: &str,
        _messages: &[Message],
        _tools: &[ToolDefinition],
    ) -> Result<Option<PromptTokenCount>, RuntimeError> {
        let context_id = self.context_id.lock().unwrap().clone();
        let retired = self
            .store
            .get_context_state(&context_id)
            .await?
            .is_some_and(|record| record.state.retired.contains(SEED));
        let tokens = if retired { 1_000 } else { 2_900 };
        Ok(Some(PromptTokenCount {
            tokens,
            source: "TEST-committed-retirement-counter".into(),
            model: "TEST-maintenance".into(),
            accuracy: PromptTokenAccuracy::Exact,
            base_estimate_tokens: tokens,
            calibration_key: None,
            calibration_shape: None,
        }))
    }

    async fn create_completion(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
    ) -> Result<Response, RuntimeError> {
        assert_eq!(self.calls.fetch_add(1, Ordering::SeqCst), 0);
        assert!(messages.iter().any(|message| message
            .content
            .contains("The Runtime has entered critical-maintenance")));
        assert_eq!(
            tools
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<BTreeSet<_>>(),
            BTreeSet::from(["context_tx", "recall", "deliver_message", "no_reply"]),
            "native maintenance must survive the root scope; domain work remains unavailable"
        );
        let context_id = self.context_id.lock().unwrap().clone();
        assert!(
            self.store
                .list_execution_jobs(crate::memory::ExecutionJobFilter {
                    context_id: Some(context_id.clone()),
                    include_terminal: true,
                    ..Default::default()
                })
                .await?
                .is_empty(),
            "the entry's physical work must wait for maintenance"
        );
        let state = self
            .store
            .get_context_state(&context_id)
            .await?
            .unwrap()
            .state;
        assert!(!state.retired.contains(SEED));
        Ok(Response {
            content: String::new(),
            tool_calls: vec![ToolCallRepr {
                id: "maintain-before-finite-entry".into(),
                r#type: "function".into(),
                func_name: "context_tx".into(),
                arguments: serde_json::json!({"transaction": format!(
                    "(context-tx (base-version {}) (reason \"historical fixture summarized\") (create maintenance/retained (summary \"historical evidence remains recorded\")) (retire {SEED}))",
                    state.version
                )}).to_string(),
            }],
        })
    }
}

#[tokio::test]
async fn critical_maintenance_resumes_the_exact_finite_harness_entry_once() {
    let database = TempSqliteDb::new().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let evidence = workspace.path().join("entry-evidence.txt");
    std::fs::write(&evidence, "TEST finite entry evidence").unwrap();
    let quoted = serde_json::to_string(&evidence.to_string_lossy()).unwrap();
    let package = HarnessPackage::from_source(
        "finite-maintenance.hns",
        &format!(
            r#"
      (manifest (id finite-maintenance) (version "1.0.0")
        (title "TEST finite maintenance") (capabilities (tools read)))
      (contract (identity "TEST maintenance before the exact entry"))
      (eval (requires (tools read))
        (seq (call read (path {quoted})) "finite-entry-resumed"))
    "#
        ),
    )
    .unwrap();
    let store: Arc<dyn RuntimeStore> = Arc::new(
        SqliteStore::new(database.path().to_str().unwrap())
            .await
            .unwrap(),
    );
    let client = Arc::new(MaintenanceClient {
        store: store.clone(),
        context_id: Mutex::new(String::new()),
        calls: AtomicUsize::new(0),
    });
    let mut config = AppConfig::default();
    config.orchestrator.context_soft_token_limit = 2_000;
    config.orchestrator.context_hard_token_limit = 3_000;
    config.orchestrator.context_maintenance_reserve_tokens = 200;
    config.permissions.mode = crate::permission::PermissionMode::Custom;
    config.permissions.workspace_root = workspace.path().to_string_lossy().into_owned();
    config.permissions.reviewer = ReviewerKind::Deny;
    let runtime = MorphzRuntime::builder(config, client.clone())
        .store("TEST finite maintenance SQLite", store.clone())
        .harness_package(package)
        .tool_policy(RuntimeToolPolicy {
            context_only: false,
            coding_eval: true,
        })
        .build()
        .await
        .unwrap();
    let context_id = runtime.identity().context_id.clone();
    *client.context_id.lock().unwrap() = context_id.clone();
    let mut replies = runtime.subscribe("chat/reply", 4);
    runtime.start().await.unwrap();
    let session = runtime
        .ensure_session(NewSession {
            id: "TEST-finite-maintenance".into(),
            agent_id: runtime.identity().agent_id.clone(),
            context_id: context_id.clone(),
            parent_session_id: None,
            title: "TEST finite maintenance".into(),
            mount_kind: crate::memory::SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    runtime.bind_default_principal(session.id()).await.unwrap();
    let seed = Event::new(
        SEED.into(),
        "TEST".into(),
        crate::event::TYPE_TOOL_OUTPUT.into(),
        "chat/tool_output".into(),
        serde_json::json!({
            "context_id": context_id, "session_id": session.id(),
            "tool_name": "TEST historical fixture", "text": "preserved historical evidence"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    store.append(seed.clone()).await.unwrap();
    let sent = session
        .send_as_principal_with_harness(
            "Execute the bound entry after any required native maintenance.",
            "User-Test",
            runtime.identity().principal_id.clone(),
            Some("TEST-finite-maintenance-input".into()),
            Some(crate::harness::ExactHarnessRef {
                id: "finite-maintenance".into(),
                version: "1.0.0".into(),
            }),
        )
        .await
        .unwrap();
    let reply = tokio::time::timeout(std::time::Duration::from_secs(5), replies.recv())
        .await
        .expect("committed maintenance must resume the original entry")
        .unwrap();
    assert_eq!(reply.payload["text"], "finite-entry-resumed");
    assert_eq!(reply.payload["root_turn_id"], sent.event_id);
    assert_eq!(client.calls.load(Ordering::SeqCst), 1);
    let state = store
        .get_context_state(&context_id)
        .await
        .unwrap()
        .unwrap()
        .state;
    assert!(state.retired.contains(SEED));
    assert!(state
        .frames
        .iter()
        .any(|frame| frame.id == "maintenance/retained"));
    let original = store
        .query(QueryFilter {
            event_id: Some(SEED.into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(original.len(), 1);
    assert_eq!(
        original[0].payload, seed.payload,
        "retirement preserves the original Event"
    );
    let commits = runtime
        .query_events(QueryFilter {
            session_id: Some(session.id().into()),
            topic: Some("chat/context_tx_committed".into()),
            top_k: Some(10),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(commits.len(), 1);
    let plans = store
        .list_plan_executions(crate::memory::PlanExecutionFilter {
            session_id: Some(session.id().into()),
            harness_id: Some("finite-maintenance".into()),
            harness_version: Some("1.0.0".into()),
            include_terminal: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(plans.len(), 1);
    assert_eq!(
        plans[0].status,
        crate::memory::PlanExecutionStatus::Succeeded
    );
    let jobs = store
        .list_execution_jobs(crate::memory::ExecutionJobFilter {
            session_id: Some(session.id().into()),
            include_terminal: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].tool_name, "read");
    assert_eq!(jobs[0].status, crate::memory::ExecutionJobStatus::Succeeded);
}
