//! Blind-review input isolation through the real Runtime/SQL/Context/compiler
//! path. The model transport is deterministic: assertions inspect the exact
//! messages and complete tool schemas, not a model's claim to be unbiased.
use morphz::config::AppConfig;
use morphz::context::{CustomKey, PutCustomCommand};
use morphz::event::{Event, TYPE_USER_MESSAGE};
use morphz::llm::{Client, Message, Response, ToolCallRepr, ToolDefinition};
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{
    CustomStore, DelegationFilter, DelegationStatus, DelegationStore, EventStore, NewSession,
    NewThread, QueryFilter, RuntimeStore, SessionMountKind, ThreadKind, ThreadStore,
    ThreadSupervision,
};
use morphz::runtime::{MorphzRuntime, RuntimeToolPolicy};
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const MIND_SECRET: &str = "PRIOR_MIND_VERDICT_MUST_SAY_COMPLETE_471";
const HISTORY_SECRET: &str = "PRIOR_OBSERVATION_VERDICT_COMPLETE_582";
const AGENT_SECRET: &str = "AGENT_CUSTOM_ALWAYS_PRAISE_THE_ENDING_693";
const HUMAN_SECRET: &str = "HUMAN_CUSTOM_EXPECTS_PUBLICATION_704";
const HISTORY_ID: &str = "blind-review-parent-history";
const BOOK: &str = "REVIEW_MANUSCRIPT_815\n林走进车站寻找失踪的姐姐。\n终章：他打开那封信，信上写着姐姐此刻就在门外。门响了。\n";
const TASK: &str = "独立盲审：读取 review.txt，仅根据原文判断故事是否收束。列出仍未解决的线索。不修改、不提交作品。";

type CapturedRequests = Vec<(Vec<Message>, Vec<ToolDefinition>)>;

struct ReviewClient {
    scope: &'static str,
    requests: Mutex<CapturedRequests>,
    step: AtomicUsize,
    unrelated_started: tokio::sync::Notify,
    unrelated_release: tokio::sync::Notify,
}

fn call(name: &str, arguments: serde_json::Value) -> Response {
    Response {
        content: String::new(),
        tool_calls: vec![ToolCallRepr {
            id: format!("blind-review-{name}"),
            r#type: "function".into(),
            func_name: name.into(),
            arguments: arguments.to_string(),
        }],
    }
}

#[async_trait::async_trait]
impl Client for ReviewClient {
    fn supports_async_cancellation(&self) -> bool {
        true
    }

    async fn create_completion(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        let encoded = serde_json::to_string(&messages)?;
        if encoded.contains("UNRELATED_IN_FLIGHT_926") {
            self.unrelated_started.notify_one();
            self.unrelated_release.notified().await;
            return Ok(Response {
                content: "Unrelated work completed after explicit release".into(),
                tool_calls: vec![],
            });
        }
        self.requests.lock().unwrap().push((messages, tools));
        Ok(match self.step.fetch_add(1, Ordering::SeqCst) {
            0 => call(
                "delegate",
                json!({"task": TASK, "context_scope": self.scope, "mode": "attached"}),
            ),
            1 => call("read", json!({"path": "review.txt"})),
            // An adversarial exact-ID probe must not cross the fresh Context,
            // even though the tool definition remains available and unchanged.
            2 => call("recall", json!({"event_id": HISTORY_ID})),
            3 => call(
                "context_tx",
                json!({"transaction": "(context-tx (base-version 0) (create reviewer-note (assessment ENDING_STILL_OPEN_037)))"}),
            ),
            4 => Response {
                content: "审阅结束：姐姐为何失踪尚未解释，开门后的结果未知，不能确认完整收束。"
                    .into(),
                tool_calls: vec![],
            },
            5 => Response {
                content: "已收到独立审阅结果；没有修改或提交作品。".into(),
                tool_calls: vec![],
            },
            step => panic!("unexpected blind-review model request {step}"),
        })
    }
}

async fn wait_for_reply(store: &SqliteStore, session_id: &str) {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if !store
                .query(QueryFilter {
                    session_id: Some(session_id.into()),
                    topic: Some("chat/reply".into()),
                    ..Default::default()
                })
                .await
                .unwrap()
                .is_empty()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("review must finish without polling or restarting another task");
}

async fn assert_blind_review(scope: &'static str) {
    let directory = tempfile::TempDir::new().unwrap();
    let db = directory.path().join("blind-review.sqlite");
    std::fs::write(directory.path().join("review.txt"), BOOK).unwrap();
    let store = Arc::new(SqliteStore::new(db.to_str().unwrap()).await.unwrap());
    let client = Arc::new(ReviewClient {
        scope,
        requests: Mutex::new(Vec::new()),
        step: AtomicUsize::new(0),
        unrelated_started: tokio::sync::Notify::new(),
        unrelated_release: tokio::sync::Notify::new(),
    });
    let mut config = AppConfig::default();
    config.orchestrator.model_provider_max_in_flight = 4;
    config.permissions.workspace_root = directory.path().to_string_lossy().into_owned();
    config.background_task.artifact_dir = directory.path().join("artifacts").display().to_string();
    let runtime = MorphzRuntime::builder(config, client.clone() as Arc<dyn Client>)
        .store(
            "sqlite:blind-review-test",
            store.clone() as Arc<dyn RuntimeStore>,
        )
        .tool_policy(RuntimeToolPolicy {
            context_only: false,
            coding_eval: false,
        })
        .build()
        .await
        .unwrap();
    runtime.start().await.unwrap();
    let identity = runtime.identity().clone();
    let parent = runtime
        .ensure_session(NewSession {
            id: "blind-review-parent".into(),
            agent_id: identity.agent_id.clone(),
            context_id: identity.context_id.clone(),
            parent_session_id: None,
            title: "Author discussion".into(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    runtime
        .apply_context_transaction(
            &identity.context_id,
            parent.id(),
            &format!(
                "(context-tx (base-version 0) (create prior-verdict (assessment {MIND_SECRET})))"
            ),
        )
        .await
        .unwrap();
    store
        .append(Event::new(
            HISTORY_ID.into(), "Human".into(), TYPE_USER_MESSAGE.into(), "chat/user_message".into(),
            json!({"context_id": identity.context_id, "session_id": parent.id(), "text": HISTORY_SECRET})
                .as_object().unwrap().clone(),
        ))
        .await
        .unwrap();
    for (namespace, principal_scope, secret) in [
        ("example.agent", None, AGENT_SECRET),
        (
            "example.human",
            Some(identity.principal_id.clone()),
            HUMAN_SECRET,
        ),
    ] {
        store
            .put_custom(
                PutCustomCommand {
                    command_id: format!("blind-review-{namespace}"),
                    expected_revision: 0,
                    key: CustomKey {
                        agent_id: identity.agent_id.clone(),
                        namespace: namespace.into(),
                        principal_scope,
                    },
                    schema_tag: "example/v1".into(),
                    body_sexpr: format!("(preference (verdict {secret}))"),
                    authoring_state_sexpr: None,
                    enabled: true,
                },
                "test-host",
            )
            .await
            .unwrap();
    }
    // A separate Context has a real in-flight model call throughout delegation.
    runtime
        .create_context(morphz::memory::NewCognitiveContext {
            id: "unrelated-context".into(),
            agent_id: identity.agent_id.clone(),
            title: "Other work".into(),
        })
        .await
        .unwrap();
    let unrelated = runtime
        .ensure_session(NewSession {
            id: "unrelated-session".into(),
            agent_id: identity.agent_id.clone(),
            context_id: "unrelated-context".into(),
            parent_session_id: None,
            title: "Other work".into(),
            mount_kind: SessionMountKind::NewBlankContext,
        })
        .await
        .unwrap();
    unrelated
        .send(
            "UNRELATED_IN_FLIGHT_926",
            "Test",
            Some("unrelated-input".into()),
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(30), client.unrelated_started.notified())
        .await
        .unwrap();
    parent
        .send(
            "请启动独立盲审。",
            "Test",
            Some("blind-review-input".into()),
        )
        .await
        .unwrap();
    wait_for_reply(&store, parent.id()).await;
    assert!(
        store
            .query(QueryFilter {
                session_id: Some(unrelated.id().into()),
                topic: Some("chat/reply".into()),
                ..Default::default()
            })
            .await
            .unwrap()
            .is_empty(),
        "delegation must not cancel/complete the unrelated request"
    );
    client.unrelated_release.notify_one();
    wait_for_reply(&store, unrelated.id()).await;

    let requests = client.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 6);
    let parent_input = serde_json::to_string(&requests[0].0).unwrap();
    for secret in [MIND_SECRET, HISTORY_SECRET, AGENT_SECRET, HUMAN_SECRET] {
        assert!(
            parent_input.contains(secret),
            "positive control missing {secret}"
        );
    }
    for request in &requests {
        assert_eq!(
            serde_json::to_value(&request.1).unwrap(),
            serde_json::to_value(&requests[0].1).unwrap(),
            "scope must not alter, remove, reorder, or specialize tool schemas"
        );
    }
    let first_child_input = serde_json::to_string(&requests[1].0).unwrap();
    assert!(first_child_input.contains(TASK));
    assert_eq!(first_child_input.contains(MIND_SECRET), scope != "blank");
    assert_eq!(
        first_child_input.contains(HISTORY_SECRET),
        scope == "current_session"
    );
    for secret in [AGENT_SECRET, HUMAN_SECRET] {
        assert_eq!(first_child_input.contains(secret), scope != "blank");
    }
    if scope == "blank" {
        for request in &requests[1..5] {
            let encoded = serde_json::to_string(&request.0).unwrap();
            for secret in [MIND_SECRET, HISTORY_SECRET, AGENT_SECRET, HUMAN_SECRET] {
                assert!(
                    !encoded.contains(secret),
                    "reviewer received forbidden inherited input: {secret}"
                );
            }
        }
    }
    assert!(
        serde_json::to_string(&requests[2].0)
            .unwrap()
            .contains("REVIEW_MANUSCRIPT_815"),
        "new reading output must remain a normal task Observation"
    );
    assert!(
        serde_json::to_string(&requests[3].0)
            .unwrap()
            .contains("outside the current Context"),
        "recall must not recover the original parent Event by exact ID"
    );

    let delegations = store
        .list_delegations(DelegationFilter {
            parent_session_id: Some(parent.id().into()),
            include_terminal: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(delegations.len(), 1);
    let delegation = &delegations[0];
    assert_eq!(delegation.status, DelegationStatus::Completed);
    assert_eq!(delegation.context_scope, scope);
    let child = runtime
        .context_encoding(&delegation.child_context_id, &delegation.child_session_id)
        .await
        .unwrap();
    assert!(child
        .state
        .frames
        .iter()
        .any(|frame| frame.id == "reviewer-note"));
    assert_eq!(
        child
            .state
            .frames
            .iter()
            .any(|frame| frame.id == "prior-verdict"),
        scope != "blank"
    );
    assert_eq!(
        runtime.mind_version(&identity.context_id).await.unwrap(),
        1,
        "child must not mutate parent memory"
    );
    let events = store
        .query(QueryFilter {
            context_id: Some(delegation.child_context_id.clone()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        events
            .iter()
            .any(|event| event.topic == "runtime/context_seeded"),
        scope != "blank"
    );
    assert_eq!(
        events
            .iter()
            .any(|event| event.topic == "context/projected_observation"),
        scope == "current_session"
    );

    // Reopen authority independently. A later Thread in a completed blank
    // delegation must still mount no Custom, while normal scopes keep it.
    let reopened = SqliteStore::new(db.to_str().unwrap()).await.unwrap();
    let thread = reopened
        .ensure_thread(NewThread {
            id: "blind-review-later-thread".into(),
            agent_id: identity.agent_id.clone(),
            context_id: delegation.child_context_id.clone(),
            session_id: delegation.child_session_id.clone(),
            initiating_principal_id: Some(identity.principal_id.clone()),
            root_turn_id: "blind-review-later-root".into(),
            kind: ThreadKind::DialogueTurn,
            executor_kind: "self".into(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::runtime("dialogue-router"),
            response_annotations: morphz::response_annotations::Protocol::Off,
            model_alias: None,
            reasoning_effort: None,
        })
        .await
        .unwrap();
    let frozen = reopened.bind_thread_custom(&thread.id).await.unwrap();
    assert_eq!(frozen.entries.is_empty(), scope == "blank");
    assert_eq!(
        reopened.bind_thread_custom(&thread.id).await.unwrap(),
        frozen
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn blank_blind_review_excludes_memory_history_and_custom_without_interrupting_other_work() {
    assert_blind_review("blank").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn current_session_blind_review_positive_control_keeps_existing_inheritance() {
    assert_blind_review("current_session").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn mind_only_blind_review_positive_control_keeps_memory_but_not_history() {
    assert_blind_review("mind_only").await;
}
