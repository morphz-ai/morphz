use morphz::config::AppConfig;
use morphz::event::{Event, TYPE_INFER_REQUEST, TYPE_USER_MESSAGE};
use morphz::llm::{Client, Message, Response, ToolCallRepr, ToolDefinition};
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{
    stable_thread_signal_id, ActivationStore as _, EventStore as _, NewAgent, NewCognitiveContext,
    NewSession, NewThread, NewThreadActivation, NewThreadSignal, PlanExecutionFilter,
    PlanExecutionStatus, PlanExecutionStore as _, QueryFilter, RuntimeStore,
    SessionDirectoryStore as _, SessionMountKind, ThreadKind, ThreadSignalStatus, ThreadStore as _,
};
use morphz::runtime::{MorphzRuntime, RuntimeToolPolicy};
use serde_json::json;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tempfile::NamedTempFile;

struct PlanInferClient {
    responses: Mutex<VecDeque<Response>>,
    calls: AtomicUsize,
}

impl PlanInferClient {
    fn new() -> Self {
        Self {
            responses: Mutex::new(VecDeque::from([
                Response {
                    content: String::new(),
                    tool_calls: vec![ToolCallRepr {
                        id: "eval-plan-infer-handoff".to_string(),
                        r#type: "function".to_string(),
                        func_name: "eval".to_string(),
                        arguments: json!({
                            "program": "(eval (infer (returns String) \"return the durable handoff value\"))"
                        })
                        .to_string(),
                    }],
                },
                Response {
                    content: "handoff-complete".to_string(),
                    tool_calls: Vec::new(),
                },
                Response {
                    content: "parent-finished".to_string(),
                    tool_calls: Vec::new(),
                },
            ])),
            calls: AtomicUsize::new(0),
        }
    }

    fn two_concurrent_infers() -> Self {
        Self {
            responses: Mutex::new(VecDeque::from([
                Response {
                    content: String::new(),
                    tool_calls: vec![
                        ToolCallRepr {
                            id: "eval-plan-infer-first".to_string(),
                            r#type: "function".to_string(),
                            func_name: "eval".to_string(),
                            arguments: json!({
                                "program": "(eval (infer (returns String) \"return the first value\"))"
                            })
                            .to_string(),
                        },
                        ToolCallRepr {
                            id: "eval-plan-infer-second".to_string(),
                            r#type: "function".to_string(),
                            func_name: "eval".to_string(),
                            arguments: json!({
                                "program": "(eval (infer (returns String) \"return the second value\"))"
                            })
                            .to_string(),
                        },
                    ],
                },
                Response {
                    content: "first-child-value".to_string(),
                    tool_calls: Vec::new(),
                },
                Response {
                    content: "second-child-value".to_string(),
                    tool_calls: Vec::new(),
                },
                Response {
                    content: "both-plans-finished".to_string(),
                    tool_calls: Vec::new(),
                },
            ])),
            calls: AtomicUsize::new(0),
        }
    }

    fn infer_with_child_tool() -> Self {
        Self {
            responses: Mutex::new(VecDeque::from([
                Response {
                    content: String::new(),
                    tool_calls: vec![ToolCallRepr {
                        id: "eval-plan-infer-child-tool".to_string(),
                        r#type: "function".to_string(),
                        func_name: "eval".to_string(),
                        arguments: json!({
                            "program": "(eval (requires (tools list_files)) (infer (returns String) (seq (call list_files (path \".\") (glob \"Cargo.toml\") (max_results 10)) \"inspect one workspace file\")))"
                        })
                        .to_string(),
                    }],
                },
                Response {
                    content: String::new(),
                    tool_calls: vec![ToolCallRepr {
                        id: "child-list-files".to_string(),
                        r#type: "function".to_string(),
                        func_name: "list_files".to_string(),
                        arguments: json!({
                            "path": ".",
                            "glob": "Cargo.toml",
                            "max_results": 10
                        })
                        .to_string(),
                    }],
                },
                Response {
                    content: "child-tool-finished".to_string(),
                    tool_calls: Vec::new(),
                },
                Response {
                    content: "parent-after-child-tool".to_string(),
                    tool_calls: Vec::new(),
                },
            ])),
            calls: AtomicUsize::new(0),
        }
    }
}

#[async_trait::async_trait]
impl Client for PlanInferClient {
    fn supports_async_cancellation(&self) -> bool {
        true
    }

    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.responses
            .lock()
            .map_err(|_| "plan infer response mutex poisoned")?
            .pop_front()
            .ok_or_else(|| "plan infer response script exhausted".into())
    }
}

#[tokio::test]
async fn durable_plan_infer_dispatches_its_committed_signal_without_restart() {
    let database = NamedTempFile::new().unwrap();
    let store = Arc::new(
        SqliteStore::new(database.path().to_str().unwrap())
            .await
            .unwrap(),
    );
    let client = Arc::new(PlanInferClient::new());
    let mut config = AppConfig::default();
    config.orchestrator.event_bus.max_in_flight = 1;
    config.orchestrator.activation_admission.max_in_flight = 1;
    let runtime = MorphzRuntime::builder(config, client.clone())
        .store(
            "sqlite:plan-infer-handoff-test",
            Arc::clone(&store) as Arc<dyn RuntimeStore>,
        )
        .tool_policy(RuntimeToolPolicy {
            context_only: false,
            coding_eval: true,
        })
        .build()
        .await
        .unwrap();
    runtime.start().await.unwrap();
    let session = runtime
        .ensure_session(NewSession {
            id: "session-plan-infer-handoff".to_string(),
            agent_id: runtime.identity().agent_id.clone(),
            context_id: runtime.identity().context_id.clone(),
            parent_session_id: None,
            title: "Plan infer handoff".to_string(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    let mut replies = runtime.subscribe("chat/reply", 4);

    session
        .send(
            "exercise the durable plan infer handoff",
            "User-Test",
            Some("client-plan-infer-handoff".to_string()),
        )
        .await
        .unwrap();

    let reply = tokio::time::timeout(std::time::Duration::from_secs(10), replies.recv())
        .await
        .expect("durable plan infer should finish without a Runtime restart")
        .expect("reply stream should remain open");
    assert_eq!(reply.payload["text"], "parent-finished");
    assert_eq!(client.calls.load(Ordering::SeqCst), 3);

    let infer_events = runtime
        .query_events(QueryFilter {
            context_id: Some(runtime.identity().context_id.clone()),
            topic: Some("chat/infer_request".to_string()),
            top_k: Some(10),
            ..QueryFilter::default()
        })
        .await
        .unwrap();
    assert_eq!(infer_events.len(), 1);
    let infer_event = &infer_events[0];

    let infer_signal = store
        .list_context_thread_signals(&runtime.identity().context_id, None)
        .await
        .unwrap()
        .into_iter()
        .find(|signal| signal.event_id == infer_event.id)
        .expect("infer Event should own a durable Thread Signal");
    assert_ne!(infer_signal.status, ThreadSignalStatus::Pending);

    let child_activations = store
        .list_thread_activations_by_root(&runtime.identity().context_id, &infer_event.id)
        .await
        .unwrap();
    assert_eq!(child_activations.len(), 1);
    assert!(child_activations[0].status.is_terminal());

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
    let plans = loop {
        let plans = store
            .list_plan_executions(PlanExecutionFilter {
                context_id: Some(runtime.identity().context_id.clone()),
                include_terminal: true,
                ..PlanExecutionFilter::default()
            })
            .await
            .unwrap();
        if plans
            .first()
            .is_some_and(|plan| plan.status == PlanExecutionStatus::Succeeded)
            || tokio::time::Instant::now() >= deadline
        {
            break plans;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    };
    assert_eq!(plans.len(), 1);
    assert_eq!(plans[0].status, PlanExecutionStatus::Succeeded);
    assert_eq!(
        infer_signal.parent_activation_id.as_deref(),
        Some(plans[0].activation_id.as_str())
    );
    assert_eq!(
        child_activations[0].parent_activation_id.as_deref(),
        Some(plans[0].activation_id.as_str())
    );
}

#[tokio::test]
async fn plan_infer_tool_continuation_bypasses_its_waiting_parent_event_bus_slot() {
    let database = NamedTempFile::new().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    std::fs::write(
        workspace.path().join("Cargo.toml"),
        "[package]\nname = \"plan-infer-fixture\"\nversion = \"0.0.0\"\n",
    )
    .unwrap();
    let store = Arc::new(
        SqliteStore::new(database.path().to_str().unwrap())
            .await
            .unwrap(),
    );
    let client = Arc::new(PlanInferClient::infer_with_child_tool());
    let mut config = AppConfig::default();
    config.orchestrator.event_bus.max_in_flight = 1;
    config.orchestrator.activation_admission.max_in_flight = 1;
    config.permissions.workspace_root = workspace.path().to_string_lossy().into_owned();
    let runtime = MorphzRuntime::builder(config, client.clone())
        .store(
            "sqlite:plan-infer-child-tool-handoff-test",
            Arc::clone(&store) as Arc<dyn RuntimeStore>,
        )
        .tool_policy(RuntimeToolPolicy {
            context_only: false,
            coding_eval: true,
        })
        .build()
        .await
        .unwrap();
    runtime.start().await.unwrap();
    let session = runtime
        .ensure_session(NewSession {
            id: "session-plan-infer-child-tool-handoff".to_string(),
            agent_id: runtime.identity().agent_id.clone(),
            context_id: runtime.identity().context_id.clone(),
            parent_session_id: None,
            title: "Plan infer child tool handoff".to_string(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    let mut replies = runtime.subscribe("chat/reply", 4);

    session
        .send(
            "exercise a durable plan infer whose child calls a tool",
            "User-Test",
            Some("client-plan-infer-child-tool-handoff".to_string()),
        )
        .await
        .unwrap();

    let reply = match tokio::time::timeout(std::time::Duration::from_secs(10), replies.recv()).await
    {
        Ok(Some(reply)) => reply,
        Ok(None) => panic!("reply stream closed before the child tool continuation completed"),
        Err(_) => {
            let plans = store
                .list_plan_executions(PlanExecutionFilter {
                    context_id: Some(runtime.identity().context_id.clone()),
                    include_terminal: true,
                    ..PlanExecutionFilter::default()
                })
                .await
                .unwrap();
            let events = runtime
                .query_events(QueryFilter {
                    context_id: Some(runtime.identity().context_id.clone()),
                    top_k: Some(200),
                    ..QueryFilter::default()
                })
                .await
                .unwrap();
            panic!(
                "the child tool continuation queued behind its waiting parent; plans={:#?}; relevant_events={:#?}",
                plans
                    .iter()
                    .map(|plan| (
                        &plan.id,
                        &plan.tool_call_id,
                        plan.revision,
                        plan.status,
                        plan.pending_kind,
                        &plan.pending_id,
                        &plan.error,
                    ))
                    .collect::<Vec<_>>(),
                events
                    .iter()
                    .filter(|event| {
                        matches!(
                            event.topic.as_str(),
                            "chat/infer_request"
                                | "chat/assistant_call"
                                | "runtime/tool_calls_selected"
                                | "chat/tool_output"
                                | "chat/reply"
                        )
                    })
                    .map(|event| (&event.id, &event.topic, &event.payload))
                    .collect::<Vec<_>>()
            );
        }
    };
    assert_eq!(reply.payload["text"], "parent-after-child-tool");
    assert_eq!(client.calls.load(Ordering::SeqCst), 4);

    let plans = store
        .list_plan_executions(PlanExecutionFilter {
            context_id: Some(runtime.identity().context_id.clone()),
            include_terminal: true,
            ..PlanExecutionFilter::default()
        })
        .await
        .unwrap();
    assert_eq!(plans.len(), 1);
    assert_eq!(plans[0].status, PlanExecutionStatus::Succeeded);
}

#[tokio::test]
async fn concurrent_plan_infers_share_one_suspended_parent_admission_slot() {
    let database = NamedTempFile::new().unwrap();
    let store = Arc::new(
        SqliteStore::new(database.path().to_str().unwrap())
            .await
            .unwrap(),
    );
    let client = Arc::new(PlanInferClient::two_concurrent_infers());
    let mut config = AppConfig::default();
    config.orchestrator.event_bus.max_in_flight = 1;
    config.orchestrator.activation_admission.max_in_flight = 1;
    let runtime = MorphzRuntime::builder(config, client.clone())
        .store(
            "sqlite:concurrent-plan-infer-handoff-test",
            Arc::clone(&store) as Arc<dyn RuntimeStore>,
        )
        .tool_policy(RuntimeToolPolicy {
            context_only: false,
            coding_eval: true,
        })
        .build()
        .await
        .unwrap();
    runtime.start().await.unwrap();
    let session = runtime
        .ensure_session(NewSession {
            id: "session-concurrent-plan-infer-handoff".to_string(),
            agent_id: runtime.identity().agent_id.clone(),
            context_id: runtime.identity().context_id.clone(),
            parent_session_id: None,
            title: "Concurrent plan infer handoff".to_string(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    let mut replies = runtime.subscribe("chat/reply", 4);

    session
        .send(
            "exercise two durable plan infer handoffs",
            "User-Test",
            Some("client-concurrent-plan-infer-handoff".to_string()),
        )
        .await
        .unwrap();

    let reply = tokio::time::timeout(std::time::Duration::from_secs(10), replies.recv())
        .await
        .expect("both durable plan infers should finish with one physical slot")
        .expect("reply stream should remain open");
    if reply.payload["text"] != "both-plans-finished" {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        let events = runtime
            .query_events(QueryFilter {
                context_id: Some(runtime.identity().context_id.clone()),
                top_k: Some(100),
                ..QueryFilter::default()
            })
            .await
            .unwrap();
        let plans = store
            .list_plan_executions(PlanExecutionFilter {
                context_id: Some(runtime.identity().context_id.clone()),
                include_terminal: true,
                ..PlanExecutionFilter::default()
            })
            .await
            .unwrap();
        panic!(
            "unexpected reply={reply:?}, calls={}, plan_statuses={:#?}, relevant_events={:#?}",
            client.calls.load(Ordering::SeqCst),
            plans
                .iter()
                .map(|plan| (
                    &plan.id,
                    &plan.tool_call_id,
                    plan.revision,
                    plan.status,
                    &plan.error
                ))
                .collect::<Vec<_>>(),
            events
                .iter()
                .filter(|event| {
                    matches!(
                        event.topic.as_str(),
                        "chat/tool_output"
                            | "runtime/action_group_settled"
                            | "chat/infer_request"
                            | "plan/infer_result"
                            | "chat/reply"
                    )
                })
                .map(|event| (&event.id, &event.topic, &event.payload))
                .collect::<Vec<_>>()
        );
    }
    assert_eq!(reply.payload["text"], "both-plans-finished");
    assert_eq!(client.calls.load(Ordering::SeqCst), 4);

    // The public reply and each Plan terminal are separate durable rows. The
    // reply can become observable a scheduling instant before a concurrent
    // Plan runner's terminal row is visible to this independent reader. Wait
    // only for nonterminal convergence; a failed/cancelled Plan still breaks
    // immediately and remains a real regression.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
    let plans = loop {
        let plans = store
            .list_plan_executions(PlanExecutionFilter {
                context_id: Some(runtime.identity().context_id.clone()),
                include_terminal: true,
                ..PlanExecutionFilter::default()
            })
            .await
            .unwrap();
        let all_terminal = plans.len() == 2 && plans.iter().all(|plan| plan.status.is_terminal());
        if all_terminal || tokio::time::Instant::now() >= deadline {
            break plans;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    };
    assert_eq!(plans.len(), 2);
    if !plans
        .iter()
        .all(|plan| plan.status == PlanExecutionStatus::Succeeded)
    {
        let events = runtime
            .query_events(QueryFilter {
                context_id: Some(runtime.identity().context_id.clone()),
                top_k: Some(200),
                ..QueryFilter::default()
            })
            .await
            .unwrap();
        panic!(
            "concurrent Plan terminal states diverged: {:#?}; tool outputs={:#?}",
            plans
                .iter()
                .map(|plan| (
                    &plan.id,
                    &plan.tool_call_id,
                    plan.revision,
                    plan.status,
                    &plan.error,
                ))
                .collect::<Vec<_>>(),
            events
                .iter()
                .filter(|event| event.topic == "chat/tool_output")
                .map(|event| (&event.id, &event.payload))
                .collect::<Vec<_>>()
        );
    }
}

#[tokio::test]
async fn claiming_a_pre_fix_direct_signal_backfills_its_parent_activation() {
    let database = NamedTempFile::new().unwrap();
    let store = Arc::new(
        SqliteStore::new(database.path().to_str().unwrap())
            .await
            .unwrap(),
    );
    store
        .ensure_agent(NewAgent {
            id: "legacy-parent-agent".to_string(),
            title: "Legacy parent agent".to_string(),
            root_context_id: "legacy-parent-context".to_string(),
        })
        .await
        .unwrap();
    store
        .create_context(NewCognitiveContext {
            id: "legacy-parent-context".to_string(),
            agent_id: "legacy-parent-agent".to_string(),
            title: "Legacy parent route".to_string(),
        })
        .await
        .unwrap();
    store
        .create_session(NewSession {
            id: "legacy-parent-session".to_string(),
            agent_id: "legacy-parent-agent".to_string(),
            context_id: "legacy-parent-context".to_string(),
            parent_session_id: None,
            title: "Legacy parent route".to_string(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    let parent_thread = store
        .ensure_thread(NewThread {
            id: "legacy-parent-thread".to_string(),
            agent_id: "legacy-parent-agent".to_string(),
            context_id: "legacy-parent-context".to_string(),
            session_id: "legacy-parent-session".to_string(),
            initiating_principal_id: None,
            root_turn_id: "legacy-parent-root".to_string(),
            kind: ThreadKind::Execution,
            executor_kind: "self".to_string(),
            executor_id: None,
            target_id: None,
            supervision: morphz::memory::ThreadSupervision::legacy(),
        })
        .await
        .unwrap();
    let parent_event = Event::new(
        "legacy-parent-event".to_string(),
        "fixture".to_string(),
        TYPE_USER_MESSAGE.to_string(),
        "chat/user_message".to_string(),
        serde_json::Map::from_iter([
            ("context_id".to_string(), json!("legacy-parent-context")),
            ("session_id".to_string(), json!("legacy-parent-session")),
            ("root_turn_id".to_string(), json!("legacy-parent-root")),
        ]),
    );
    store.append(parent_event.clone()).await.unwrap();
    let parent_sequence = store
        .query(QueryFilter {
            event_id: Some(parent_event.id.clone()),
            ..QueryFilter::default()
        })
        .await
        .unwrap()[0]
        .sequence
        .unwrap();
    let parent_activation = store
        .ensure_thread_activation(NewThreadActivation {
            id: "legacy-parent-activation".to_string(),
            agent_id: "legacy-parent-agent".to_string(),
            context_id: "legacy-parent-context".to_string(),
            session_id: "legacy-parent-session".to_string(),
            initiating_principal_id: None,
            trigger_event_id: parent_event.id,
            trigger_sequence: parent_sequence,
            trigger_kind: "chat/user_message".to_string(),
            parent_activation_id: None,
            root_turn_id: parent_thread.root_turn_id,
        })
        .await
        .unwrap();

    let child_thread = store
        .ensure_thread(NewThread {
            id: "legacy-child-thread".to_string(),
            agent_id: "legacy-parent-agent".to_string(),
            context_id: "legacy-parent-context".to_string(),
            session_id: "legacy-parent-session".to_string(),
            initiating_principal_id: None,
            root_turn_id: "legacy-child-root".to_string(),
            kind: ThreadKind::Execution,
            executor_kind: "plan_infer".to_string(),
            executor_id: Some("legacy-plan".to_string()),
            target_id: None,
            supervision: morphz::memory::ThreadSupervision::runtime("event-router"),
        })
        .await
        .unwrap();
    let child_event = Event::new(
        "legacy-child-event".to_string(),
        "Runtime-Yao".to_string(),
        TYPE_INFER_REQUEST.to_string(),
        "chat/infer_request".to_string(),
        serde_json::Map::from_iter([
            ("context_id".to_string(), json!("legacy-parent-context")),
            ("session_id".to_string(), json!("legacy-parent-session")),
            ("root_turn_id".to_string(), json!("legacy-child-root")),
            (
                "parent_activation_id".to_string(),
                json!(parent_activation.id),
            ),
        ]),
    );
    store
        .append_to_thread(child_event.clone(), &child_thread.id)
        .await
        .unwrap();
    let child_sequence = store
        .query(QueryFilter {
            event_id: Some(child_event.id.clone()),
            ..QueryFilter::default()
        })
        .await
        .unwrap()[0]
        .sequence
        .unwrap();

    let raw_pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(SqliteConnectOptions::new().filename(database.path()))
        .await
        .unwrap();
    sqlx::query("UPDATE thread_signals SET parent_activation_id = NULL WHERE event_id = ?")
        .bind(&child_event.id)
        .execute(&raw_pool)
        .await
        .unwrap();
    raw_pool.close().await;

    let child_activation = store
        .claim_thread_signal_batch(
            NewThreadSignal {
                id: stable_thread_signal_id(&child_event.id),
                thread_id: child_thread.id,
                thread_generation: child_thread.generation,
                event_id: child_event.id.clone(),
                principal_id: None,
                sequence: child_sequence,
                kind: child_event.topic,
                parent_activation_id: Some(parent_activation.id.clone()),
            },
            NewThreadActivation {
                id: "legacy-child-activation".to_string(),
                agent_id: "legacy-parent-agent".to_string(),
                context_id: "legacy-parent-context".to_string(),
                session_id: "legacy-parent-session".to_string(),
                initiating_principal_id: None,
                trigger_event_id: child_event.id.clone(),
                trigger_sequence: child_sequence,
                trigger_kind: "chat/infer_request".to_string(),
                parent_activation_id: Some(parent_activation.id.clone()),
                root_turn_id: "legacy-child-root".to_string(),
            },
            32,
        )
        .await
        .unwrap()
        .expect("legacy pending Signal should materialize an Activation");
    assert_eq!(
        child_activation.parent_activation_id.as_deref(),
        Some(parent_activation.id.as_str())
    );
    let repaired_signal = store
        .list_context_thread_signals("legacy-parent-context", None)
        .await
        .unwrap()
        .into_iter()
        .find(|signal| signal.event_id == child_event.id)
        .unwrap();
    assert_eq!(
        repaired_signal.parent_activation_id.as_deref(),
        Some(parent_activation.id.as_str())
    );
}
