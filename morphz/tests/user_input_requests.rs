use chrono::Utc;
use morphz::event::Event;
use morphz::memory::*;
use morphz::scheduler::{
    NewSchedulerDependency, SchedulerDependencyFilter, SchedulerDependencyKind,
    SchedulerDependencyOwnerKind, SchedulerDependencyStatus, SchedulerDependencyStore,
    SchedulerQuery,
};
use morphz::user_input::*;
use serde_json::json;
use std::sync::Arc;

struct TempSqliteDb {
    _directory: tempfile::TempDir,
    path: std::path::PathBuf,
}
impl TempSqliteDb {
    fn new() -> Result<Self, std::io::Error> {
        let directory = tempfile::Builder::new()
            .prefix("morphz-user-input-")
            .tempdir()?;
        let path = directory.path().join("runtime.sqlite");
        Ok(Self {
            _directory: directory,
            path,
        })
    }
    fn path(&self) -> &std::path::Path {
        &self.path
    }
}

async fn fixture(store: &dyn RuntimeStore) -> (ThreadRecord, ThreadActivationRecord, Event) {
    fixture_with_objective(store, false).await
}

async fn fixture_with_objective(
    store: &dyn RuntimeStore,
    owns_objective: bool,
) -> (ThreadRecord, ThreadActivationRecord, Event) {
    store
        .create_agent_bundle(
            NewAgent {
                id: "question-agent".into(),
                title: "Question test".into(),
                root_context_id: "question-context".into(),
            },
            NewCognitiveContext {
                id: "question-context".into(),
                agent_id: "question-agent".into(),
                title: "Question test".into(),
            },
            NewSession {
                id: "question-session".into(),
                agent_id: "question-agent".into(),
                context_id: "question-context".into(),
                parent_session_id: None,
                title: "Question test".into(),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await
        .unwrap();
    store
        .ensure_principal(NewPrincipal {
            id: "question-person".into(),
            provider_id: "runtime-default".into(),
            assurance: "test".into(),
            display_name: None,
        })
        .await
        .unwrap();
    store
        .bind_session_principal("question-session", "question-person")
        .await
        .unwrap();
    let original = Event::new("question-root".into(), "User".into(), morphz::event::TYPE_USER_MESSAGE.into(), "chat/user_message".into(),
        serde_json::from_value(json!({"context_id":"question-context","session_id":"question-session","principal_id":"question-person","client_message_id":"question-original","text":"Configure synthetic preview"})).unwrap());
    assert!(matches!(
        store
            .claim_message(
                "question-session",
                "question-original",
                &original,
                MessageDispatchMode::Parallel
            )
            .await
            .unwrap(),
        MessageClaim::Accepted { .. }
    ));
    let thread = store
        .get_thread_by_root(&original.id)
        .await
        .unwrap()
        .unwrap();
    let signal = store
        .next_pending_thread_signal(&thread.id)
        .await
        .unwrap()
        .unwrap();
    let activation = store
        .claim_thread_signal_batch(
            NewThreadSignal {
                id: signal.id,
                thread_id: thread.id.clone(),
                thread_generation: thread.generation,
                event_id: signal.event_id,
                principal_id: signal.principal_id,
                sequence: signal.sequence,
                kind: signal.kind.clone(),
                parent_activation_id: None,
            },
            NewThreadActivation {
                id: "question-activation".into(),
                agent_id: thread.agent_id.clone(),
                context_id: thread.context_id.clone(),
                session_id: thread.session_id.clone(),
                initiating_principal_id: thread.initiating_principal_id.clone(),
                trigger_event_id: original.id,
                trigger_sequence: signal.sequence,
                trigger_kind: signal.kind,
                parent_activation_id: None,
                root_turn_id: thread.root_turn_id.clone(),
            },
            DEFAULT_THREAD_SIGNAL_BATCH_LIMIT,
        )
        .await
        .unwrap()
        .unwrap();
    let activation = match store
        .update_thread_activation(
            &activation.id,
            activation.revision,
            ThreadActivationStatus::Running,
            Some("question-worker"),
            Some(Utc::now() + chrono::Duration::minutes(2)),
            None,
        )
        .await
        .unwrap()
    {
        ThreadActivationMutation::Updated(activation) => activation,
        other => panic!("unexpected claim: {other:?}"),
    };
    let questions = RequestUserInput::parse(r#"{"questions":[{"id":"preview","question":"Enable the synthetic preview?","options":[{"id":"yes","label":"Enable preview"},{"id":"no","label":"Keep it off"}]}]}"#).unwrap();
    let mut call = Event::new("question-native-call".into(), "Agent-Morphz".into(), morphz::event::TYPE_AGENT_CALL.into(), "chat/assistant_call".into(),
        serde_json::from_value(json!({"activation_id":activation.id,"attempt_id":activation.id,"thread_id":thread.id,"thread_generation":thread.generation,
            "root_turn_id":thread.root_turn_id,"session_id":thread.session_id,"context_id":thread.context_id,"principal_id":"question-person",
            "terminal_outcome":true,"outcome_disposition":DISPOSITION,"text":"",
            "tool_calls":[{"id":"question-call","type":"function","function":{"name":TOOL_NAME,"arguments":serde_json::to_string(&questions).unwrap()}}]})).unwrap());
    if owns_objective {
        let objective = store
            .create_objective(NewObjective {
                id: "question-objective".into(),
                agent_id: thread.agent_id.clone(),
                context_id: thread.context_id.clone(),
                coordinator_session_id: thread.session_id.clone(),
                delivery_session_id: thread.session_id.clone(),
                source_event_id: thread.root_turn_id.clone(),
                initiating_principal_id: thread.initiating_principal_id.clone(),
                stated_objective: "Synthetic question lifecycle".into(),
                parent_objective_id: None,
                model_alias: None,
                reasoning_effort: None,
                token_budget: None,
            })
            .await
            .unwrap();
        let objective = match store
            .claim_objective_evaluation(
                &objective.id,
                objective.revision,
                "question-evaluation",
                Utc::now() + chrono::Duration::minutes(2),
            )
            .await
            .unwrap()
        {
            ObjectiveMutation::Updated(value) => value,
            other => panic!("unexpected Evaluation: {other:?}"),
        };
        call.payload
            .insert("objective_id".into(), json!(objective.id));
        call.payload
            .insert("objective_generation".into(), json!(objective.generation));
        call.payload.insert(
            "objective_evaluation_id".into(),
            json!(objective.active_evaluation_id),
        );
        call.payload
            .insert("objective_revision".into(), json!(objective.revision));
    }
    store.append(call.clone()).await.unwrap();
    let event = request_event(&call, &thread, &questions).unwrap();
    (thread, activation, event)
}

async fn question_lifecycle(store: &dyn RuntimeStore, action: &str) {
    let (thread, activation, request) = fixture_with_objective(store, true).await;
    store
        .commit_activation_outcome(&activation.id, &request)
        .await
        .unwrap();
    let objective = store
        .get_objective("question-objective")
        .await
        .unwrap()
        .unwrap();
    assert!(
        objective.active_evaluation_id.is_none(),
        "asking must release the physical Evaluation lease"
    );
    assert_pending(store, &thread, &request).await;
    let mut legacy_bypass = reply(
        &thread,
        &request,
        "legacy-bypass",
        "Must not consume a saved question",
    );
    legacy_bypass.payload.insert(
        "input_destination".into(),
        json!({"kind":"objective", "objective_id":objective.id,
        "generation":objective.generation, "reply_to_request_id":request.id}),
    );
    assert!(
        store
            .claim_message(
                &thread.session_id,
                &legacy_bypass.id,
                &legacy_bypass,
                MessageDispatchMode::Parallel
            )
            .await
            .is_err(),
        "legacy free-text routing must not bypass a saved structured question"
    );
    assert_pending(store, &thread, &request).await;
    if action == "thread_cancel" {
        let current = store.get_thread(&thread.id).await.unwrap().unwrap();
        assert!(matches!(
            store
                .control_thread(
                    &thread.id,
                    current.revision,
                    ThreadControlAction::Cancel,
                    Some("Synthetic cancellation"),
                    Some("User")
                )
                .await
                .unwrap(),
            ThreadMutation::Updated(_)
        ));
    } else {
        let status = if action == "pause_resume" {
            ObjectiveStatus::Paused
        } else {
            ObjectiveStatus::Cancelled
        };
        let paused = match store
            .update_objective_state(
                &objective.id,
                objective.revision,
                status,
                None,
                Some("Synthetic lifecycle"),
                None,
            )
            .await
            .unwrap()
        {
            ObjectiveMutation::Updated(value) => value,
            other => panic!("unexpected Goal transition: {other:?}"),
        };
        if action == "pause_resume" {
            assert_pending(store, &thread, &request).await;
            let answer = reply(
                &thread,
                &request,
                "paused-answer",
                "Must not resume while paused",
            );
            assert!(store
                .claim_message(
                    &thread.session_id,
                    &answer.id,
                    &answer,
                    MessageDispatchMode::Parallel
                )
                .await
                .is_err());
            assert!(matches!(
                store
                    .update_objective_state(
                        &paused.id,
                        paused.revision,
                        ObjectiveStatus::Active,
                        None,
                        Some("Synthetic resume"),
                        None
                    )
                    .await
                    .unwrap(),
                ObjectiveMutation::Updated(_)
            ));
        }
    }
    assert!(store
        .list_pending_user_input_dependencies(std::slice::from_ref(&thread.id))
        .await
        .unwrap()
        .is_empty());
    let pending = store
        .list_scheduler_dependencies(SchedulerDependencyFilter {
            owner_kind: Some(SchedulerDependencyOwnerKind::Objective),
            owner_id: Some(objective.id),
            status: Some(SchedulerDependencyStatus::Pending),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(
        pending.is_empty(),
        "cancellation must not strand the paired Goal barrier"
    );
    let stale = reply(
        &thread,
        &request,
        "after-cancellation",
        "This old form must fail",
    );
    assert!(store
        .claim_message(
            &thread.session_id,
            &stale.id,
            &stale,
            MessageDispatchMode::Parallel
        )
        .await
        .is_err());
    assert!(store
        .query(QueryFilter {
            event_ids: vec![stale.id],
            ..Default::default()
        })
        .await
        .unwrap()
        .is_empty());
}

async fn question_preserves_other_waits(store: &dyn RuntimeStore) {
    let (thread, activation, request) = fixture_with_objective(store, true).await;
    let objective = store
        .get_objective("question-objective")
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        store
            .update_objective_state(
                &objective.id,
                objective.revision,
                ObjectiveStatus::Active,
                Some(ObjectiveWaitCondition::ResourceAvailable {
                    resource: "synthetic-ready".into()
                }),
                None,
                None
            )
            .await
            .unwrap(),
        ObjectiveMutation::Updated(_)
    ));
    store
        .register_scheduler_dependency(NewSchedulerDependency {
            id: "other-group".into(),
            owner_kind: SchedulerDependencyOwnerKind::Objective,
            owner_id: objective.id.clone(),
            owner_generation: objective.generation,
            dependency_kind: SchedulerDependencyKind::ThreadGroup,
            dependency_id: "synthetic-group".into(),
            dependency_generation: 1,
            required: true,
            metadata: json!({"source":"TEST"}),
        })
        .await
        .unwrap();
    store
        .commit_activation_outcome(&activation.id, &request)
        .await
        .unwrap();
    let mut supplement = reply(
        &thread,
        &request,
        "ordinary-goal-supplement",
        "Not an answer",
    );
    supplement.payload.insert(
        "input_destination".into(),
        json!({"kind":"objective", "objective_id":objective.id,"generation":objective.generation}),
    );
    store
        .claim_message(
            &thread.session_id,
            &supplement.id,
            &supplement,
            MessageDispatchMode::Parallel,
        )
        .await
        .unwrap();
    assert!(
        store
            .list_runnable_pending_thread_signals(20)
            .await
            .unwrap()
            .is_empty(),
        "a Goal supplement must not bypass its saved pending question"
    );
    let answer = reply(
        &thread,
        &request,
        "accepted-with-other-waits",
        "Synthetic only",
    );
    store
        .claim_message(
            &thread.session_id,
            &answer.id,
            &answer,
            MessageDispatchMode::Parallel,
        )
        .await
        .unwrap();
    assert!(store
        .list_runnable_pending_thread_signals(20)
        .await
        .unwrap()
        .is_empty());
    let edges = store
        .list_scheduler_dependencies(SchedulerDependencyFilter {
            owner_kind: Some(SchedulerDependencyOwnerKind::Objective),
            owner_id: Some(objective.id.clone()),
            status: Some(SchedulerDependencyStatus::Pending),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        edges.len(),
        3,
        "answer acceptance preserves both unrelated physical barriers"
    );
    let resource = edges
        .iter()
        .find(|edge| edge.dependency_kind == SchedulerDependencyKind::Resource)
        .unwrap();
    let ready = Event::new("synthetic-ready-event".into(), "Runtime-TEST".into(), "runtime_control".into(), "runtime/resource_available".into(),
        serde_json::from_value(json!({"context_id":thread.context_id,"session_id":thread.session_id,"resource":"synthetic-ready"})).unwrap());
    store.append(ready.clone()).await.unwrap();
    store
        .satisfy_scheduler_dependency(
            &resource.id,
            resource.owner_generation,
            resource.dependency_generation,
            &ready.id,
        )
        .await
        .unwrap();
    let current = store.get_objective(&objective.id).await.unwrap().unwrap();
    store
        .update_objective_state(
            &current.id,
            current.revision,
            ObjectiveStatus::Active,
            None,
            None,
            Some(&ready.id),
        )
        .await
        .unwrap();
    let group = store
        .get_scheduler_dependency("other-group")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        group.status,
        SchedulerDependencyStatus::Pending,
        "reconciling a resource mirror cannot cancel the other Group wait"
    );
    assert!(store
        .list_runnable_pending_thread_signals(20)
        .await
        .unwrap()
        .is_empty());
    store
        .satisfy_scheduler_dependency(
            &group.id,
            group.owner_generation,
            group.dependency_generation,
            &ready.id,
        )
        .await
        .unwrap();
    let runnable = store
        .list_runnable_pending_thread_signals(20)
        .await
        .unwrap();
    assert_eq!(runnable.len(), 1);
    assert_eq!(runnable[0].event_id, answer.id, "the accepted original answer, never the other primary Thread's input, owns the next admission");
    let barriers = store
        .list_active_objective_user_input_dependencies(std::slice::from_ref(&objective.id))
        .await
        .unwrap();
    assert_eq!(barriers.len(), 1);
    assert_eq!(
        barriers[0].metadata["accepted_answer_event_id"],
        json!(answer.id)
    );
    let current = store.get_objective(&objective.id).await.unwrap().unwrap();
    assert!(!matches!(
        store
            .claim_objective_evaluation(
                &current.id,
                current.revision,
                "must-not-overtake",
                Utc::now() + chrono::Duration::minutes(1)
            )
            .await
            .unwrap(),
        ObjectiveMutation::Updated(_)
    ));
}

#[tokio::test]
async fn sqlite_answer_reserves_original_admission_and_preserves_unrelated_waits() {
    let db = TempSqliteDb::new().unwrap();
    let store = morphz::memory::sqlite::SqliteStore::new(&db.path().to_string_lossy())
        .await
        .unwrap();
    question_preserves_other_waits(&store).await;
}

struct GoalAdmissionProbe {
    calls: std::sync::atomic::AtomicUsize,
    messages: std::sync::Mutex<Vec<morphz::llm::Message>>,
    started: tokio::sync::Notify,
}
#[async_trait::async_trait]
impl morphz::llm::Client for GoalAdmissionProbe {
    fn supports_async_cancellation(&self) -> bool {
        true
    }
    async fn create_completion(
        &self,
        messages: Vec<morphz::llm::Message>,
        _: Vec<morphz::llm::ToolDefinition>,
    ) -> Result<morphz::llm::Response, Box<dyn std::error::Error + Send + Sync>> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        *self.messages.lock().unwrap() = messages;
        self.started.notify_one();
        std::future::pending().await
    }
}

#[test]
fn sqlite_original_prelude_claims_its_goal_and_native_question_context_before_model_resume() {
    let db = TempSqliteDb::new().unwrap();
    let executor = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    executor.block_on(async {
        let store = Arc::new(
            morphz::memory::sqlite::SqliteStore::new(&db.path().to_string_lossy())
                .await
                .unwrap(),
        );
        let (thread, activation, request) = fixture_with_objective(store.as_ref(), true).await;
        store
            .commit_activation_outcome(&activation.id, &request)
            .await
            .unwrap();
        let model = Arc::new(GoalAdmissionProbe {
            calls: 0.into(),
            messages: Default::default(),
            started: Default::default(),
        });
        let mut config = morphz::config::AppConfig::default();
        config.permissions.workspace_root =
            db.path().parent().unwrap().to_string_lossy().into_owned();
        config.background_task.artifact_dir = db
            .path()
            .parent()
            .unwrap()
            .join("artifacts")
            .to_string_lossy()
            .into_owned();
        let runtime = morphz::runtime::MorphzRuntime::builder(config, model.clone())
            .store("TEST SQLite", store.clone())
            .identity(morphz::runtime::RuntimeIdentity {
                agent_id: thread.agent_id.clone(),
                context_id: thread.context_id.clone(),
                principal_id: "question-person".into(),
            })
            .build()
            .await
            .unwrap();
        let before = runtime
            .scheduler_snapshot(&thread.context_id, SchedulerQuery::default())
            .await
            .unwrap();
        assert_ne!(
            before
                .threads
                .iter()
                .find(|value| value.thread.id == thread.id)
                .unwrap()
                .user_input_request
                .as_ref()
                .unwrap()
                .reply_allowed,
            Some(false)
        );
        let goal = store
            .get_objective("question-objective")
            .await
            .unwrap()
            .unwrap();
        let paused = match store
            .update_objective_state(
                &goal.id,
                goal.revision,
                ObjectiveStatus::Paused,
                None,
                None,
                None,
            )
            .await
            .unwrap()
        {
            ObjectiveMutation::Updated(value) => value,
            other => panic!("{other:?}"),
        };
        let paused_view = runtime
            .scheduler_snapshot(&thread.context_id, SchedulerQuery::default())
            .await
            .unwrap();
        assert_eq!(
            paused_view
                .threads
                .iter()
                .find(|value| value.thread.id == thread.id)
                .unwrap()
                .user_input_request
                .as_ref()
                .unwrap()
                .reply_allowed,
            Some(false)
        );
        // This fixture needs the same lifetime to test cold admission rather than
        // an explicit user Resume (whose new generation intentionally invalidates
        // the old form). Rebuild a second independent fixture below.
        assert_eq!(paused.status, ObjectiveStatus::Paused);
        assert_eq!(model.calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    });
    drop(executor);

    let fresh = TempSqliteDb::new().unwrap();
    let executor = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    executor.block_on(async {
        let store = Arc::new(morphz::memory::sqlite::SqliteStore::new(&fresh.path().to_string_lossy()).await.unwrap());
        let (thread, activation, request) = fixture_with_objective(store.as_ref(), true).await;
        store.commit_activation_outcome(&activation.id, &request).await.unwrap();
        let model = Arc::new(GoalAdmissionProbe { calls: 0.into(), messages: Default::default(), started: Default::default() });
        let mut config = morphz::config::AppConfig::default();
        config.permissions.workspace_root = fresh.path().parent().unwrap().to_string_lossy().into_owned();
        config.background_task.artifact_dir = fresh.path().parent().unwrap().join("artifacts").to_string_lossy().into_owned();
        let runtime = morphz::runtime::MorphzRuntime::builder(config, model.clone()).store("TEST SQLite", store.clone())
            .identity(morphz::runtime::RuntimeIdentity { agent_id: thread.agent_id.clone(), context_id: thread.context_id.clone(), principal_id: "question-person".into() }).build().await.unwrap();
        runtime.start().await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(model.calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        let input = morphz::session_io::Request::parse(json!({"io_version":"1","client_message_id":"goal-answer",
            "message":{"format":{"id":"morphz.chat","version":"1"},"content":{"encoding":"json","value":{"text":"Enable preview\nSynthetic only"}}},
            "activation":{"mode":"evaluate","dispatch_mode":"parallel","input_destination":{"kind":"user_input","request_id":request.id,
                "thread_id":thread.id,"generation":thread.generation,"answers":[{"question_id":"preview","selected_option_ids":["yes"],"text":"Synthetic only"}]}}
        }).to_string().as_bytes(), &morphz::session_io::Limits::default()).unwrap();
        let answer = runtime.session(&thread.session_id).send_io_as_principal(input, "question-person").await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(20), model.started.notified()).await.expect("the original asking prelude must resume");
        assert_eq!(model.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        let goal = store.get_objective("question-objective").await.unwrap().unwrap();
        assert!(goal.active_evaluation_id.is_some());
        let activations = store.list_thread_activations_by_root(&thread.context_id, &thread.root_turn_id).await.unwrap();
        let evaluation = activations.iter().find(|activation| activation.trigger_event_id == answer.id).unwrap();
        assert_eq!(evaluation.trigger_event_id, answer.id);
        assert_eq!(evaluation.root_turn_id, thread.root_turn_id, "do not move this Human answer to the synthetic primary Goal root");
        {
            let messages = model.messages.lock().unwrap();
            assert_eq!(messages.iter().flat_map(|message| message.tool_calls.iter().flatten()).filter(|call| call.id == "question-call").count(), 1);
            assert_eq!(messages.iter().filter(|message| message.tool_call_id.as_deref() == Some("question-call")).count(), 1);
        }
        assert!(store.list_active_objective_user_input_dependencies(&[goal.id]).await.unwrap().is_empty());
    });
}

#[tokio::test]
async fn sqlite_question_cancellation_and_resume_invalidate_old_forms() {
    for action in ["thread_cancel", "goal_cancel", "pause_resume"] {
        let db = TempSqliteDb::new().unwrap();
        let store = morphz::memory::sqlite::SqliteStore::new(&db.path().to_string_lossy())
            .await
            .unwrap();
        question_lifecycle(&store, action).await;
    }
}

fn reply(thread: &ThreadRecord, request: &Event, id: &str, text: &str) -> Event {
    Event::new(id.into(), "User".into(), morphz::event::TYPE_USER_MESSAGE.into(), "chat/user_message".into(),
        serde_json::from_value(json!({"client_message_id":id,"session_id":thread.session_id,"context_id":thread.context_id,
            "principal_id":"question-person","text":format!("Enable preview\n{text}"),
            "input_destination":{"kind":"user_input","request_id":request.id,"thread_id":thread.id,"generation":thread.generation,
                "answers":[{"question_id":"preview","selected_option_ids":["yes"],"text":text}]}})).unwrap())
}

async fn assert_pending(store: &dyn RuntimeStore, thread: &ThreadRecord, request: &Event) {
    let edges = store
        .list_pending_user_input_dependencies(std::slice::from_ref(&thread.id))
        .await
        .unwrap();
    assert_eq!(edges.len(), 1);
    assert_eq!(
        pending_request(thread, &edges[0], request)
            .unwrap()
            .unwrap()
            .questions[0]
            .id,
        "preview"
    );
}

#[tokio::test]
async fn sqlite_question_is_durable_and_answer_is_exactly_once() {
    let db = TempSqliteDb::new().unwrap();
    let store = morphz::memory::sqlite::SqliteStore::new(&db.path().to_string_lossy())
        .await
        .unwrap();
    let (thread, activation, request) = fixture(&store).await;
    assert!(matches!(
        store
            .commit_activation_outcome(&activation.id, &request)
            .await
            .unwrap(),
        ActivationOutcomeCommit::Suspended { .. }
    ));
    assert!(
        matches!(store.commit_activation_outcome(&activation.id,&request).await.unwrap(), ActivationOutcomeCommit::Existing { event_id } if event_id==request.id)
    );
    let current = store.get_thread(&thread.id).await.unwrap().unwrap();
    assert_eq!(current.lifecycle, ThreadLifecycle::Open);
    assert_eq!(current.kind, ThreadKind::Execution);
    assert_eq!(
        store
            .get_thread_activation(&activation.id)
            .await
            .unwrap()
            .unwrap()
            .status,
        ThreadActivationStatus::Succeeded
    );
    assert_pending(&store, &current, &request).await;
    let reopened = morphz::memory::sqlite::SqliteStore::new(&db.path().to_string_lossy())
        .await
        .unwrap();
    assert_pending(&reopened, &current, &request).await;
    let event = reply(&current, &request, "answer-command", "Only synthetic data");
    assert!(matches!(
        reopened
            .claim_message(
                &current.session_id,
                &event.id,
                &event,
                MessageDispatchMode::Parallel
            )
            .await
            .unwrap(),
        MessageClaim::Accepted { .. }
    ));
    assert!(matches!(
        reopened
            .claim_message(
                &current.session_id,
                &event.id,
                &event,
                MessageDispatchMode::Parallel
            )
            .await
            .unwrap(),
        MessageClaim::Existing { .. }
    ));
    let duplicate = reply(&current, &request, "second-command", "Different answer");
    assert!(reopened
        .claim_message(
            &current.session_id,
            &duplicate.id,
            &duplicate,
            MessageDispatchMode::Parallel
        )
        .await
        .is_err());
    assert!(reopened
        .list_pending_user_input_dependencies(std::slice::from_ref(&current.id))
        .await
        .unwrap()
        .is_empty());
    let signal = reopened
        .thread_signal_for_event(&current.context_id, &event.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(signal.thread_id, current.id);
    assert_eq!(signal.thread_generation, current.generation);
    assert_eq!(signal.status, ThreadSignalStatus::Pending);
    assert!(reopened
        .get_thread_by_root(&event.id)
        .await
        .unwrap()
        .is_none());
    let results = reopened
        .query(QueryFilter {
            event_id: Some("output_question-activation_question-call".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].payload["answer_event_id"], event.id);
    assert!(
        reopened
            .thread_signal_for_event(&current.context_id, &results[0].id)
            .await
            .unwrap()
            .is_none(),
        "the receipt must not create another Evaluation"
    );
}

#[tokio::test]
async fn sqlite_rejects_forged_answers_without_consuming_the_question() {
    let db = TempSqliteDb::new().unwrap();
    let store = morphz::memory::sqlite::SqliteStore::new(&db.path().to_string_lossy())
        .await
        .unwrap();
    let (thread, activation, request) = fixture(&store).await;
    store
        .commit_activation_outcome(&activation.id, &request)
        .await
        .unwrap();
    let mut forged = reply(&thread, &request, "forged-answer", "Synthetic only");
    forged.payload["input_destination"]["answers"][0]["selected_option_ids"] = json!(["forged"]);
    assert!(store
        .claim_message(
            &thread.session_id,
            &forged.id,
            &forged,
            MessageDispatchMode::Parallel
        )
        .await
        .is_err());
    assert_pending(&store, &thread, &request).await;
    let mut stale = reply(&thread, &request, "stale-generation", "Synthetic only");
    stale.payload["input_destination"]["generation"] = json!(thread.generation + 1);
    assert!(store
        .claim_message(
            &thread.session_id,
            &stale.id,
            &stale,
            MessageDispatchMode::Parallel
        )
        .await
        .is_err());
    assert_pending(&store, &thread, &request).await;
    let mut changed = reply(&thread, &request, "substituted-text", "Synthetic only");
    changed.payload["text"] = json!("A model paraphrase instead of the actual choice");
    assert!(store
        .claim_message(
            &thread.session_id,
            &changed.id,
            &changed,
            MessageDispatchMode::Parallel
        )
        .await
        .is_err());
    assert_pending(&store, &thread, &request).await;
}

#[tokio::test]
async fn sqlite_competing_answers_accept_one_human_command() {
    let db = TempSqliteDb::new().unwrap();
    let store = Arc::new(
        morphz::memory::sqlite::SqliteStore::new(&db.path().to_string_lossy())
            .await
            .unwrap(),
    );
    let (thread, activation, request) = fixture(store.as_ref()).await;
    store
        .commit_activation_outcome(&activation.id, &request)
        .await
        .unwrap();
    let a = reply(&thread, &request, "answer-a", "A");
    let b = reply(&thread, &request, "answer-b", "B");
    let (a, b) = tokio::join!(
        store.claim_message(&thread.session_id, &a.id, &a, MessageDispatchMode::Parallel),
        store.claim_message(&thread.session_id, &b.id, &b, MessageDispatchMode::Parallel)
    );
    assert_eq!(
        usize::from(matches!(a, Ok(MessageClaim::Accepted { .. })))
            + usize::from(matches!(b, Ok(MessageClaim::Accepted { .. }))),
        1
    );
    assert!(a.is_err() || b.is_err());
}

async fn concurrent_answer_contract(store: &dyn RuntimeStore) {
    let (thread, activation, request) = fixture(store).await;
    store
        .commit_activation_outcome(&activation.id, &request)
        .await
        .unwrap();
    assert_pending(store, &thread, &request).await;
    let a = reply(&thread, &request, "answer-a", "A");
    let b = reply(&thread, &request, "answer-b", "B");
    let (a_result, b_result) = tokio::join!(
        store.claim_message(&thread.session_id, &a.id, &a, MessageDispatchMode::Parallel),
        store.claim_message(&thread.session_id, &b.id, &b, MessageDispatchMode::Parallel)
    );
    assert_eq!(
        usize::from(matches!(a_result, Ok(MessageClaim::Accepted { .. })))
            + usize::from(matches!(b_result, Ok(MessageClaim::Accepted { .. }))),
        1,
        "exactly one answer must commit: {a_result:?}, {b_result:?}"
    );
    let accepted = if a_result.is_ok() { &a } else { &b };
    assert!(matches!(
        store
            .claim_message(
                &thread.session_id,
                &accepted.id,
                accepted,
                MessageDispatchMode::Parallel
            )
            .await
            .unwrap(),
        MessageClaim::Existing { .. }
    ));
    let receipt_id = format!("output_{}_question-call", activation.id);
    let receipts = store
        .query(QueryFilter {
            event_ids: vec![receipt_id],
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].payload["answer_event_id"], json!(accepted.id));
    assert_eq!(receipts[0].payload["wake_policy"], json!("none"));
    let signal = store
        .next_pending_thread_signal(&thread.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        signal.event_id, accepted.id,
        "only the original asking Thread receives the Human answer"
    );
    assert!(store
        .list_pending_user_input_dependencies(&[thread.id])
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; required by the PostgreSQL CI contract inventory"]
async fn postgres_question_reply_and_lifecycle_contract() {
    let database_url = std::env::var("MORPHZ_TEST_POSTGRES_URL")
        .expect("a dedicated test PostgreSQL URL is mandatory; no production fallback");
    let admin = sqlx::PgPool::connect(&database_url).await.unwrap();
    for action in [
        "answers",
        "thread_cancel",
        "goal_cancel",
        "pause_resume",
        "other_waits",
    ] {
        let schema = format!(
            "question_{}_{}_{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap().unsigned_abs(),
            action
        );
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&admin)
            .await
            .unwrap();
        let separator = if database_url.contains('?') { '&' } else { '?' };
        let scoped = format!("{database_url}{separator}options=-csearch_path%3D{schema}");
        let store = morphz::memory::postgres::PostgresStore::new(&scoped, 8)
            .await
            .unwrap();
        if action == "answers" {
            concurrent_answer_contract(&store).await;
        } else if action == "other_waits" {
            question_preserves_other_waits(&store).await;
        } else {
            question_lifecycle(&store, action).await;
        }
        drop(store);
        // Only this test's freshly-created schema, never public or existing data.
        sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
            .execute(&admin)
            .await
            .unwrap();
    }
    admin.close().await;
}
