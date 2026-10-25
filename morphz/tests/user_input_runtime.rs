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
            if let Some((thread, question)) = snapshot.threads.into_iter().find_map(|thread| {
                thread
                    .user_input_request
                    .clone()
                    .map(|question| (thread, question))
            }) {
                break (thread, question);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("real Runtime must persist the native question and expose its exact pending read model")
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
