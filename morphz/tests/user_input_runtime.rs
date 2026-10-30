//! Scripted model values through the real Runtime, scheduler, native-call
//! continuation and cold executor restart. Not live-model acceptance.
use morphz::{
    config::AppConfig,
    llm::{Client, Message, Response, ToolCallRepr, ToolDefinition},
    memory::{NewSession, QueryFilter, SessionMountKind},
    runtime::MorphzRuntime,
    scheduler::{SchedulerQuery, SchedulerThreadSnapshot},
    session_io::{Limits, Request},
    user_input::{self, PendingUserInputRequest},
};
use serde_json::json;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;
type Error = Box<dyn std::error::Error + Send + Sync>;

struct QuestionModel(AtomicUsize);
#[async_trait::async_trait]
impl Client for QuestionModel {
    async fn create_completion(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
    ) -> Result<Response, Error> {
        let ordinal = self.0.fetch_add(1, Ordering::SeqCst);
        assert!(
            ordinal < 2,
            "waiting for a person must not poll or replay the model request"
        );
        assert!(
            tools.iter().any(|tool| tool.name == user_input::TOOL_NAME),
            "interactive native control must be advertised"
        );
        if ordinal == 0 {
            Ok(Response { content: String::new(), tool_calls: vec![ToolCallRepr {
                id: "real-question-call".into(), r#type: "function".into(), func_name: user_input::TOOL_NAME.into(),
                arguments: json!({"questions":[{"id":"preview","question":"Enable the synthetic preview?",
                    "options":[{"id":"yes","label":"Enable preview"},{"id":"no","label":"Keep it off"}]}]}).to_string(),
            }] })
        } else {
            let calls = messages
                .iter()
                .flat_map(|message| message.tool_calls.iter().flatten())
                .collect::<Vec<_>>();
            assert_eq!(
                calls
                    .iter()
                    .filter(|call| call.id == "real-question-call")
                    .count(),
                1,
                "the original real native call must survive the cold continuation"
            );
            let receipts = messages
                .iter()
                .filter(|message| {
                    message.role == "tool"
                        && message.tool_call_id.as_deref() == Some("real-question-call")
                })
                .collect::<Vec<_>>();
            assert_eq!(
                receipts.len(),
                1,
                "one correlated tool result, not an unmatched call or a synthetic new call"
            );
            let receipt: serde_json::Value = serde_json::from_str(&receipts[0].content)?;
            assert_eq!(receipt["status"], "answered");
            assert_eq!(receipt["answers"][0]["selected_option_ids"], json!(["yes"]));
            assert_eq!(receipt["answers"][0]["text"], "Only synthetic data.");
            Ok(Response {
                content: "TEST_ANSWER_RECEIVED".into(),
                tool_calls: vec![],
            })
        }
    }
}

async fn build(directory: &std::path::Path, model: Arc<QuestionModel>) -> MorphzRuntime {
    let mut config = AppConfig::default();
    config.permissions.workspace_root = directory.to_string_lossy().into_owned();
    config.background_task.artifact_dir =
        directory.join("artifacts").to_string_lossy().into_owned();
    let runtime = MorphzRuntime::builder(config, model)
        .database_path(directory.join("runtime.sqlite").to_str().unwrap())
        .build()
        .await
        .unwrap();
    runtime.start().await.unwrap();
    runtime
}

fn pending_checkpoint(
    thread: SchedulerThreadSnapshot,
) -> Option<(SchedulerThreadSnapshot, PendingUserInputRequest)> {
    // Thread inventory is read before the phase and question attachment. The
    // latter can belong to a newer commit which also promoted the Thread, so
    // require the complete parked checkpoint rather than a mixed projection.
    if thread.phase != morphz::memory::ThreadPhase::Waiting
        || thread.thread.kind != morphz::memory::ThreadKind::Execution
    {
        return None;
    }
    let question = thread.user_input_request.clone()?;
    Some((thread, question))
}

fn checkpoint_snapshot() -> SchedulerThreadSnapshot {
    serde_json::from_value(json!({
        "thread": {
            "id": "checkpoint-thread", "revision": 1, "generation": 1,
            "agent_id": "checkpoint-agent", "context_id": "checkpoint-context",
            "session_id": "checkpoint-session", "root_turn_id": "checkpoint-root",
            "kind": "execution", "lifecycle": "open", "control_state": "active",
            "executor_kind": "plan", "supervision": morphz::memory::ThreadSupervision::legacy(),
            "delivery_status": "none", "created_at": "2026-10-26T00:00:00Z",
            "updated_at": "2026-10-26T00:00:00Z"
        },
        "phase": "running", "pending_signals": [], "activations": [], "schedules": [],
        "user_input_request": {
            "request_id": "checkpoint-question", "thread_id": "checkpoint-thread",
            "thread_generation": 1, "session_id": "checkpoint-session",
            "context_id": "checkpoint-context", "requested_at": "2026-10-26T00:00:00Z",
            "questions": [{"id": "scope", "question": "Only synthetic data?", "options": []}]
        }
    }))
    .unwrap()
}

#[test]
fn published_question_is_not_yet_a_cold_restart_checkpoint() {
    // Force CI's read interleaving: an older Running phase with a newly
    // committed question, followed by a coherent parked snapshot.
    let mut thread = checkpoint_snapshot();
    assert!(
        pending_checkpoint(thread.clone()).is_none(),
        "a pending question must not validate an older running snapshot"
    );
    thread.phase = morphz::memory::ThreadPhase::Waiting;
    let expected = thread.user_input_request.clone().unwrap();
    let (checkpoint, question) = pending_checkpoint(thread).unwrap();
    assert_eq!(checkpoint.phase, morphz::memory::ThreadPhase::Waiting);
    assert_eq!(question, expected);
}

#[test]
fn waiting_phase_with_older_dialogue_kind_is_not_a_cold_restart_checkpoint() {
    // Thread inventory is read before activations, dependencies and questions.
    // Reproduce CI's older DialogueTurn record with the new parked phase.
    let mut thread = checkpoint_snapshot();
    thread.phase = morphz::memory::ThreadPhase::Waiting;
    thread.thread.kind = morphz::memory::ThreadKind::DialogueTurn;
    assert!(thread.user_input_request.is_some());
    assert!(pending_checkpoint(thread.clone()).is_none());

    thread.thread.kind = morphz::memory::ThreadKind::Execution;
    thread.thread.revision += 1;
    let expected = thread.user_input_request.clone().unwrap();
    let (checkpoint, question) = pending_checkpoint(thread).unwrap();
    assert_eq!(
        checkpoint.thread.kind,
        morphz::memory::ThreadKind::Execution
    );
    assert_eq!(checkpoint.thread.revision, 2);
    assert_eq!(question, expected);
}

async fn pending(runtime: &MorphzRuntime) -> (SchedulerThreadSnapshot, PendingUserInputRequest) {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let snapshot = runtime
                .scheduler_snapshot(
                    &runtime.identity().context_id,
                    SchedulerQuery {
                        include_terminal: true,
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
            if let Some((thread, question)) =
                snapshot.threads.into_iter().find_map(pending_checkpoint)
            {
                break (thread, question);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect(
        "real Runtime must expose its exact pending question at the parked cold-restart checkpoint",
    )
}

#[test]
fn native_question_survives_cold_runtime_and_resumes_once_with_correlated_answer() {
    let directory = tempfile::TempDir::new().unwrap();
    let model = Arc::new(QuestionModel(AtomicUsize::new(0)));
    // Dropping this executor aborts all old Runtime tasks. The next scope builds
    // a new store and Runtime; no live actor or in-memory continuation survives.
    let question = {
        let executor = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        executor.block_on(async {
            let runtime = build(directory.path(), model.clone()).await;
            let session = runtime
                .ensure_session(NewSession {
                    id: "question-session".into(),
                    agent_id: runtime.identity().agent_id.clone(),
                    context_id: runtime.identity().context_id.clone(),
                    parent_session_id: None,
                    title: "TEST native question".into(),
                    mount_kind: SessionMountKind::ExistingContext,
                })
                .await
                .unwrap();
            let request = Request::parse(
                json!({"io_version":"1","client_message_id":"ask-native",
                "message":{"format":{"id":"morphz.chat","version":"1"},"content":{"encoding":"json",
                    "value":{"text":"TEST ask one synthetic question and wait for my answer"}}}})
                .to_string()
                .as_bytes(),
                &Limits::default(),
            )
            .unwrap();
            session
                .send_io_as_principal(request, &runtime.identity().principal_id)
                .await
                .unwrap();
            let (thread, question) = pending(&runtime).await;
            let durable_thread = runtime
                .session_thread_by_root(&question.session_id, &thread.thread.root_turn_id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(durable_thread.id, question.thread_id);
            assert_eq!(durable_thread.generation, question.thread_generation);
            assert_eq!(durable_thread.kind, morphz::memory::ThreadKind::Execution);
            let overview = runtime
                .runtime_overview(morphz::runtime::RuntimeOverviewQuery {
                    context_id: Some(question.context_id.clone()),
                    ..Default::default()
                })
                .await
                .unwrap();
            let session_state = overview
                .contexts
                .iter()
                .flat_map(|context| &context.sessions)
                .find(|session| session.session.id == question.session_id)
                .unwrap();
            assert_eq!(
                session_state.state,
                morphz::runtime::RuntimeSessionState::WaitingUser
            );
            assert!(session_state.attention_required);
            assert_eq!(thread.phase, morphz::memory::ThreadPhase::Waiting);
            assert_eq!(thread.thread.kind, morphz::memory::ThreadKind::Execution);
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert_eq!(model.0.load(Ordering::SeqCst), 1);
            question
        })
    };
    let executor = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    executor.block_on(async {
        let runtime = build(directory.path(), model.clone()).await;
        let (_, restored) = pending(&runtime).await;
        assert_eq!(restored, question);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(model.0.load(Ordering::SeqCst), 1, "restart is not an answer");
        let session = runtime.session(&question.session_id);
        let request = Request::parse(json!({"io_version":"1","client_message_id":"answer-native",
            "message":{"format":{"id":"morphz.chat","version":"1"},"content":{"encoding":"json",
                "value":{"text":"Enable preview\nOnly synthetic data."}}},
            "activation":{"mode":"evaluate","dispatch_mode":"parallel","input_destination":{
                "kind":"user_input","request_id":question.request_id,"thread_id":question.thread_id,
                "generation":question.thread_generation,"answers":[{"question_id":"preview","selected_option_ids":["yes"],"text":"Only synthetic data."}]}}
        }).to_string().as_bytes(), &Limits::default()).unwrap();
        let first = session.send_io_as_principal(request.clone(), &runtime.identity().principal_id).await.unwrap();
        let again = session.send_io_as_principal(request, &runtime.identity().principal_id).await.unwrap();
        assert_eq!(first.id, again.id, "same Human command returns its existing ingress receipt");
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let events = runtime.query_events(QueryFilter { context_id: Some(question.context_id.clone()),
                    topic: Some("chat/reply".into()), ..Default::default() }).await.unwrap();
                if events.iter().any(|event| event.payload.get("text").and_then(serde_json::Value::as_str) == Some("TEST_ANSWER_RECEIVED")) { break; }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await.expect("the resumed original Thread must publish the actual model reply");
        assert_eq!(model.0.load(Ordering::SeqCst), 2);
        let snapshot = runtime.scheduler_snapshot(&question.context_id, SchedulerQuery { include_terminal: true, ..Default::default() }).await.unwrap();
        assert!(snapshot.threads.iter().all(|thread| thread.user_input_request.is_none()));
        assert_eq!(snapshot.threads.iter().filter(|thread| thread.thread.id == question.thread_id).count(), 1);
    });
}
