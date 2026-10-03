//! Actual SQLite/schedule_tx/no_reply(wait) regression. Scripted transport is
//! deterministic test data; no external model or user data is touched.
use morphz::{
    config::AppConfig,
    context::{CustomKey, PutCustomCommand},
    llm::{model_visible_message_text, Client, Message, Response, ToolCallRepr, ToolDefinition},
    memory::{
        sqlite::SqliteStore, ActivationStore, CustomStore, NewSession, QueryFilter, RuntimeStore,
        SessionMountKind, ThreadGroupFilter, ThreadGroupStatus, ThreadGroupStore, ThreadLifecycle,
        ThreadStore, ThreadSupervisorKind, TimerStore,
    },
    response_annotations::Protocol,
    runtime::{MorphzRuntime, RuntimeToolPolicy, SchedulerQuery},
    session_io::{Limits, Request},
};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Semaphore;

type DynError = Box<dyn std::error::Error + Send + Sync>;

struct GroupWaitClient {
    calls: Mutex<HashMap<String, usize>>,
    roles: Mutex<HashMap<String, String>>,
    requests: Mutex<Vec<Vec<Message>>>,
    leaves: Semaphore,
}

impl Default for GroupWaitClient {
    fn default() -> Self {
        Self {
            calls: Mutex::new(HashMap::new()),
            roles: Mutex::new(HashMap::new()),
            requests: Mutex::new(Vec::new()),
            leaves: Semaphore::new(0),
        }
    }
}

#[async_trait::async_trait]
impl Client for GroupWaitClient {
    fn supports_async_cancellation(&self) -> bool {
        true
    }
    fn model(&self) -> Option<String> {
        Some("thread-group-wait-fixture".into())
    }

    async fn create_completion(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
    ) -> Result<Response, DynError> {
        let text = messages
            .iter()
            .map(model_visible_message_text)
            .collect::<Vec<_>>()
            .join("\n");
        let current = &text[text.rfind("(evaluate ").expect("actual Evaluation")..];
        let start = current
            .find("(origin-turn ")
            .map(|start| start + "(origin-turn ".len())
            .unwrap_or_else(|| current.find("(turn ").expect("actual root") + "(turn ".len());
        let root = current[start..].split(')').next().unwrap().to_string();
        let role = {
            let mut roles = self.roles.lock().unwrap();
            roles
                .entry(root.clone())
                .or_insert_with(|| {
                    if current.contains("(kind dialogue-turn)") {
                        "parent".into()
                    } else if current.contains("GROUP_WAIT_A1") {
                        "A1".into()
                    } else if current.contains("GROUP_WAIT_A") {
                        "A".into()
                    } else if current.contains("GROUP_WAIT_B") {
                        "B".into()
                    } else {
                        panic!("unexpected scheduled request: {current}")
                    }
                })
                .clone()
        };
        let count = {
            let mut calls = self.calls.lock().unwrap();
            let count = calls.entry(root).or_default();
            *count += 1;
            *count
        };
        self.requests.lock().unwrap().push(messages);
        assert!(
            count
                <= if role == "parent" || role == "A" {
                    3
                } else {
                    1
                }
        );
        let (name, arguments) = if (role == "parent" || role == "A") && count == 1 {
            let children = if role == "parent" {
                vec![("A", "GROUP_WAIT_A"), ("B", "GROUP_WAIT_B")]
            } else {
                vec![("A1", "GROUP_WAIT_A1")]
            };
            (
                "schedule_tx",
                json!({"operations":children.into_iter().map(|(id,intent)|json!({
                    "op":"spawn","client_id":id,"intent":intent,"lifetime":"attached"
                })).collect::<Vec<_>>(),"_annotations":{"execution":{
                    "title":format!("Group {role}"),"progress":"Start the actual attached children"
                }}}),
            )
        } else if (role == "parent" || role == "A") && count == 2 {
            ("no_reply", json!({"mode":"wait","wait_secs":86400}))
        } else {
            if role == "B" || role == "A1" {
                // Test-only synchronization: the real leaf model requests are
                // already in flight. The host releases them only after both
                // real owner waiting Events have committed, so no fake Group
                // or pending-work fact is injected.
                self.leaves.acquire().await.unwrap().forget();
            }
            (
                "reply",
                json!({"content":format!("Group {role} complete"),"annotations":{
                    "execution":{"title":format!("Group {role}"),"result":format!("Group {role} complete")}
                }}),
            )
        };
        assert!(tools.iter().any(|tool| tool.name == name));
        Ok(Response {
            content: String::new(),
            tool_calls: vec![ToolCallRepr {
                id: format!("group-{role}-{count}"),
                r#type: "function".into(),
                func_name: name.into(),
                arguments: arguments.to_string(),
            }],
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn real_nonempty_custom_family_waits_for_its_dispatched_groups_without_protocol_retry() {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::ERROR)
        .with_test_writer()
        .try_init();
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(
        SqliteStore::new(directory.path().join("group-wait.sqlite").to_str().unwrap())
            .await
            .unwrap(),
    );
    let client = Arc::new(GroupWaitClient::default());
    let mut config = AppConfig::default();
    config.permissions.workspace_root = directory.path().to_string_lossy().into_owned();
    config.background_task.artifact_dir = directory
        .path()
        .join("artifacts")
        .to_string_lossy()
        .into_owned();
    let runtime = MorphzRuntime::builder(config, client.clone() as Arc<dyn Client>)
        .store(
            "sqlite:group-wait-fixture",
            store.clone() as Arc<dyn RuntimeStore>,
        )
        .tool_policy(RuntimeToolPolicy {
            context_only: true,
            coding_eval: false,
        })
        .build()
        .await
        .unwrap();
    runtime.start().await.unwrap();
    let identity = runtime.identity().clone();
    let session = runtime
        .ensure_session(NewSession {
            id: "group-wait-session".into(),
            agent_id: identity.agent_id.clone(),
            context_id: identity.context_id.clone(),
            parent_session_id: None,
            title: "Group wait regression".into(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    store
        .put_custom(
            PutCustomCommand {
                command_id: "group-wait-profile".into(),
                expected_revision: 0,
                key: CustomKey {
                    agent_id: identity.agent_id.clone(),
                    namespace: "morphz.profile.agent".into(),
                    principal_scope: None,
                },
                schema_tag: "morphz-agent-profile/v2".into(),
                body_sexpr: "(agent-profile (version 2) (identity (name WaitEcho)))".into(),
                authoring_state_sexpr: Some(
                    "(editor (inactive NEVER_PROJECT_WAIT_AUTHORING))".into(),
                ),
                enabled: true,
            },
            "trusted-test-host",
        )
        .await
        .unwrap();
    let mut input = Request::parse(json!({"io_version":"1","client_message_id":"group-wait-parent",
        "message":{"format":{"id":"morphz.chat","version":"1"},"content":{"encoding":"json","value":{"text":"GROUP_WAIT_PARENT: create attached A and B; A creates attached A1; await the owned Groups."}}}
    }).to_string().as_bytes(),&Limits::default()).unwrap();
    input.activation.response_annotations = Some(Protocol::V2);
    session
        .send_io_as_principal(input, &identity.principal_id)
        .await
        .unwrap();

    let waiting = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let errors = runtime
                .query_events(QueryFilter {
                    session_id: Some(session.id().into()),
                    topic: Some("runtime/response_protocol_error".into()),
                    ..Default::default()
                })
                .await
                .unwrap();
            assert!(
                errors.is_empty(),
                "actual owner wait was rejected: {:?}",
                errors
                    .iter()
                    .map(|event| &event.payload)
                    .collect::<Vec<_>>()
            );
            let waiting = runtime
                .query_events(QueryFilter {
                    session_id: Some(session.id().into()),
                    topic: Some("runtime/thread_waiting".into()),
                    ..Default::default()
                })
                .await
                .unwrap();
            if waiting.len() == 2 {
                break waiting;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("both real owner Groups must reach no_reply(wait)");
    for event in &waiting {
        assert_eq!(event.payload["model_disposition"], "wait");
        assert_eq!(event.payload["has_pending_thread_group"], true);
        assert_eq!(event.payload["active_background_tasks"], 0);
        assert_eq!(
            event.payload["pending_schedules"], 0,
            "the children are already dispatched, not queued schedules"
        );
        assert_eq!(event.payload["pending_routed_inputs"], 0);
        let activation = store
            .get_thread_activation(event.payload["attempt_id"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap();
        let thread = store
            .get_thread_by_root(&activation.root_turn_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(thread.lifecycle, ThreadLifecycle::Open);
        assert_eq!(thread.generation, activation.generation);
        let groups = store
            .list_thread_groups(ThreadGroupFilter {
                context_id: Some(thread.context_id.clone()),
                session_id: Some(thread.session_id.clone()),
                supervisor_kind: Some(ThreadSupervisorKind::Thread),
                supervisor_id: Some(thread.id.clone()),
                status: Some(ThreadGroupStatus::Open),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].generation, thread.generation);
        let timer = store
            .get_runtime_timer(event.payload["wait_timer_id"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(timer.owner_id, thread.id);
        assert_eq!(timer.payload["thread_generation"], thread.generation);
        assert_eq!(timer.payload["context_id"], thread.context_id);
        assert_eq!(timer.payload["session_id"], thread.session_id);
    }
    client.leaves.add_permits(2);
    let board = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let board = runtime
                .scheduler_snapshot(
                    &identity.context_id,
                    SchedulerQuery {
                        include_terminal: true,
                        limit: 16,
                    },
                )
                .await
                .unwrap();
            assert!(!board
                .threads
                .iter()
                .any(|snapshot| snapshot.thread.lifecycle == ThreadLifecycle::Failed));
            if board.threads.len() == 4
                && board
                    .threads
                    .iter()
                    .all(|snapshot| snapshot.thread.lifecycle == ThreadLifecycle::Completed)
            {
                break board;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("settled Groups must resume both real owners");
    let errors = runtime
        .query_events(QueryFilter {
            session_id: Some(session.id().into()),
            topic: Some("runtime/response_protocol_error".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(errors.is_empty());
    let groups = store
        .list_thread_groups(ThreadGroupFilter {
            context_id: Some(identity.context_id.clone()),
            session_id: Some(session.id().into()),
            supervisor_kind: Some(ThreadSupervisorKind::Thread),
            include_terminal: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(groups.len(), 2);
    for group in &groups {
        assert_eq!(group.status, ThreadGroupStatus::Satisfied);
        let owner = board
            .threads
            .iter()
            .find(|snapshot| snapshot.thread.id == group.supervisor_id)
            .unwrap();
        assert_eq!(group.generation, owner.thread.generation);
        let barrier = runtime
            .query_events(QueryFilter {
                event_id: Some(group.barrier_event_id.clone().unwrap()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(barrier.len(), 1);
        assert_eq!(barrier[0].topic, "chat/thread_group_terminal");
        assert_eq!(barrier[0].payload["thread_id"], owner.thread.id);
        assert_eq!(
            barrier[0].payload["root_turn_id"],
            owner.thread.root_turn_id
        );
        assert_eq!(barrier[0].payload["thread_group_status"], "satisfied");
        assert!(barrier[0].sequence.is_some());
    }
    for event in &waiting {
        let timer = store
            .get_runtime_timer(event.payload["wait_timer_id"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(timer.status, morphz::memory::RuntimeTimerStatus::Cancelled);
    }
    assert_eq!(client.requests.lock().unwrap().len(),8,"two selections, two waits, four final replies; no protocol correction or metadata-only request");
    let calls = client.calls.lock().unwrap().clone();
    let roles = client.roles.lock().unwrap().clone();
    for (root, count) in calls {
        assert_eq!(
            count,
            if roles[&root] == "parent" || roles[&root] == "A" {
                3
            } else {
                1
            }
        );
    }
    for snapshot in &board.threads {
        assert_eq!(snapshot.thread.response_annotations, Protocol::V2);
        let custom = store
            .get_thread_custom(&snapshot.thread.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(custom.entries.len(), 1);
        assert_eq!(custom.entries[0].revision, 1);
    }
    for messages in client.requests.lock().unwrap().iter() {
        let text = messages
            .iter()
            .map(model_visible_message_text)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("WaitEcho") && text.contains("(custom "));
        assert!(!text.contains("NEVER_PROJECT_WAIT_AUTHORING"));
    }
}
