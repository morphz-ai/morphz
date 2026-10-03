//! Real schedule_tx/SQLite/Context regression with a scripted in-process
//! model transport. No external model or original application data is used.
use morphz::{
    config::AppConfig,
    context::{CustomKey, PutCustomCommand},
    llm::{model_visible_message_text, Client, Message, Response, ToolCallRepr, ToolDefinition},
    memory::{
        sqlite::SqliteStore, ActivationStore, CustomStore, NewSession, QueryFilter, RuntimeStore,
        SessionMountKind, ThreadGroupStatus, ThreadGroupStore, ThreadLifecycle,
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

type DynError = Box<dyn std::error::Error + Send + Sync>;

#[derive(Default)]
struct ScheduledCustomClient {
    calls: Mutex<HashMap<String, usize>>,
    roles: Mutex<HashMap<String, String>>,
    requests: Mutex<Vec<Vec<Message>>>,
    request_routes: Mutex<Vec<(String, String)>>,
}

#[async_trait::async_trait]
impl Client for ScheduledCustomClient {
    fn supports_async_cancellation(&self) -> bool {
        true
    }
    fn model(&self) -> Option<String> {
        Some("custom-scheduled-fixture".into())
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
        let current = &text[text
            .rfind("(evaluate ")
            .expect("actual Evaluation is present")..];
        let root_start = if let Some(start) = current.find("(origin-turn ") {
            start + "(origin-turn ".len()
        } else {
            current
                .find("(turn ")
                .expect("actual Runtime root is present")
                + "(turn ".len()
        };
        let root = current[root_start..].split(')').next().unwrap().to_string();
        let activation_start = current
            .find("(activation (id ")
            .expect("actual Runtime Activation is present")
            + "(activation (id ".len();
        let activation_id = current[activation_start..]
            .split(')')
            .next()
            .unwrap()
            .to_string();
        let mut roles = self.roles.lock().unwrap();
        let role = roles
            .entry(root.clone())
            .or_insert_with(|| {
                if current.contains("(kind dialogue-turn)") {
                    "parent".into()
                } else if current.contains("CUSTOM_CHILD_A1") {
                    "A1".into()
                } else if current.contains("CUSTOM_CHILD_A") {
                    "A".into()
                } else if current.contains("CUSTOM_CHILD_B") {
                    "B".into()
                } else {
                    panic!("unexpected first scheduled Evaluation: {current}")
                }
            })
            .clone();
        drop(roles);
        let mut calls = self.calls.lock().unwrap();
        let count = calls.entry(root.clone()).or_default();
        *count += 1;
        assert!(
            *count
                <= if role == "parent" || role == "A" {
                    3
                } else {
                    1
                },
            "only selection, schedule receipt, and actual Group-settled wake are allowed"
        );
        let first = *count == 1;
        drop(calls);
        self.request_routes
            .lock()
            .unwrap()
            .push((root, activation_id));
        self.requests.lock().unwrap().push(messages);
        assert!(
            self.requests.lock().unwrap().len() <= 8,
            "bounded model transport"
        );
        let (name, arguments) = if first && (role == "parent" || role == "A") {
            assert!(tools.iter().any(|tool| tool.name == "schedule_tx"));
            let children = if role == "parent" {
                vec![("A", "CUSTOM_CHILD_A"), ("B", "CUSTOM_CHILD_B")]
            } else {
                vec![("A1", "CUSTOM_CHILD_A1")]
            };
            let operations = children
                .into_iter()
                .map(|(id, intent)| {
                    json!({
                        "op":"spawn", "client_id":id, "intent":intent, "lifetime":"attached"
                    })
                })
                .collect::<Vec<_>>();
            (
                "schedule_tx",
                json!({"operations":operations,"_annotations":{
                    "execution":{"title":format!("Custom {role}"),"progress":"Create the actual attached children"}
                }}),
            )
        } else {
            assert!(tools.iter().any(|tool| tool.name == "reply"));
            (
                "reply",
                json!({"content":format!("Custom {role} complete"),"annotations":{
                    "execution":{"title":format!("Custom {role}"),"result":format!("Custom {role} complete")}
                }}),
            )
        };
        Ok(Response {
            content: String::new(),
            tool_calls: vec![ToolCallRepr {
                id: format!("custom-{role}-{name}"),
                r#type: "function".into(),
                func_name: name.into(),
                arguments: arguments.to_string(),
            }],
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn actual_four_node_scheduled_family_mounts_nonempty_frozen_custom_with_explicit_thread_ids()
{
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::ERROR)
        .with_test_writer()
        .try_init();
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(
        SqliteStore::new(
            directory
                .path()
                .join("custom-scheduled.sqlite")
                .to_str()
                .unwrap(),
        )
        .await
        .unwrap(),
    );
    let client = Arc::new(ScheduledCustomClient::default());
    let mut config = AppConfig::default();
    config.permissions.workspace_root = directory.path().to_string_lossy().into_owned();
    config.background_task.artifact_dir = directory
        .path()
        .join("artifacts")
        .to_string_lossy()
        .into_owned();
    let runtime = MorphzRuntime::builder(config, client.clone() as Arc<dyn Client>)
        .store(
            "sqlite:custom-scheduled-fixture",
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
            id: "custom-scheduled-session".into(),
            agent_id: identity.agent_id.clone(),
            context_id: identity.context_id.clone(),
            parent_session_id: None,
            title: "Scheduled Custom regression".into(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    let key = CustomKey {
        agent_id: identity.agent_id.clone(),
        namespace: "morphz.profile.agent".into(),
        principal_scope: None,
    };
    let command = PutCustomCommand {
        command_id: "custom-scheduled-profile".into(),
        expected_revision: 0,
        key: key.clone(),
        schema_tag: "morphz-agent-profile/v2".into(),
        body_sexpr: "(agent-profile (version 2) (identity (name ScheduledEcho)))".into(),
        authoring_state_sexpr: Some("(editor (inactive NEVER_PROJECT_AUTHORING_STATE))".into()),
        enabled: true,
    };
    store
        .put_custom(command.clone(), "trusted-test-host")
        .await
        .unwrap();
    let mut input = Request::parse(json!({"io_version":"1","client_message_id":"custom-scheduled-parent",
        "message":{"format":{"id":"morphz.chat","version":"1"},"content":{"encoding":"json","value":{"text":"CUSTOM_PARENT: create the attached A and B; A creates attached A1."}}}
    }).to_string().as_bytes(), &Limits::default()).unwrap();
    input.activation.response_annotations = Some(Protocol::V2);
    let accepted = session
        .send_io_as_principal(input, &identity.principal_id)
        .await
        .unwrap();
    assert_eq!(
        accepted.payload["client_message_id"],
        "custom-scheduled-parent"
    );
    let board = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let board = runtime
                .scheduler_snapshot(
                    &identity.context_id,
                    SchedulerQuery {
                        include_terminal: true,
                        limit: 50,
                    },
                )
                .await
                .unwrap();
            if board
                .threads
                .iter()
                .any(|snapshot| snapshot.thread.lifecycle == ThreadLifecycle::Failed)
            {
                let facts = board
                    .threads
                    .iter()
                    .map(|snapshot| {
                        (
                            &snapshot.thread.id,
                            &snapshot.thread.root_turn_id,
                            snapshot.thread.lifecycle,
                        )
                    })
                    .collect::<Vec<_>>();
                panic!(
                    "real scheduled family failed before completing: {facts:?}; requests={:?}",
                    client.calls.lock().unwrap()
                );
            }
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
    .expect("actual scheduled four-node family did not complete");
    let root_thread = board
        .threads
        .iter()
        .find(|snapshot| snapshot.thread.root_turn_id == accepted.id)
        .unwrap();
    let children = board
        .threads
        .iter()
        .filter(|snapshot| {
            snapshot.thread.supervision.parent_thread_id.as_deref()
                == Some(root_thread.thread.id.as_str())
        })
        .collect::<Vec<_>>();
    assert_eq!(children.len(), 2);
    let grandchild = board
        .threads
        .iter()
        .find(|snapshot| {
            snapshot
                .thread
                .supervision
                .parent_thread_id
                .as_ref()
                .is_some_and(|parent| children.iter().any(|child| &child.thread.id == parent))
        })
        .unwrap();
    assert_eq!(
        grandchild.thread.supervision.lifetime,
        morphz::memory::ThreadLifetime::Attached
    );
    let mut frozen = vec![];
    for snapshot in &board.threads {
        let thread = &snapshot.thread;
        assert_eq!(thread.response_annotations, Protocol::V2);
        assert_eq!(
            thread.initiating_principal_id.as_deref(),
            Some(identity.principal_id.as_str())
        );
        if thread.id != root_thread.thread.id {
            assert!(thread.root_turn_id.starts_with("scheduled_root_"));
            assert_ne!(
                thread.id,
                morphz::memory::stable_thread_id(&thread.root_turn_id),
                "actual schedule_tx ID must exercise the non-hash boundary"
            );
            let due = runtime
                .query_events(QueryFilter {
                    root_turn_id: Some(thread.root_turn_id.clone()),
                    topic: Some("chat/schedule_due".into()),
                    ..Default::default()
                })
                .await
                .unwrap();
            assert_eq!(due.len(), 1);
        }
        let manifest = store.get_thread_custom(&thread.id).await.unwrap().unwrap();
        assert_eq!(manifest.thread_id, thread.id);
        assert_eq!(manifest.entries.len(), 1);
        assert_eq!(manifest.entries[0].revision, 1);
        assert!(manifest
            .context_custom()
            .unwrap()
            .unwrap()
            .to_string()
            .contains("ScheduledEcho"));
        frozen.push(manifest);
    }
    let captured = client.requests.lock().unwrap().clone();
    assert!((6..=8).contains(&captured.len()), "two selections plus four completions, with at most two genuine Group-settled re-evaluations; no naming-only call");
    let counts = client.calls.lock().unwrap().clone();
    let roles = client.roles.lock().unwrap().clone();
    let mut observed = counts
        .iter()
        .map(|(root, count)| (roles[root].clone(), *count))
        .collect::<Vec<_>>();
    observed.sort();
    eprintln!("actual scripted family request counts: {observed:?}");
    let request_routes = client.request_routes.lock().unwrap().clone();
    assert_eq!(request_routes.len(), captured.len());
    assert_eq!(counts.values().sum::<usize>(), captured.len());
    for (root, count) in counts {
        let parent = roles[&root] == "parent" || roles[&root] == "A";
        if parent {
            assert!((2..=3).contains(&count));
        } else {
            assert_eq!(count, 1);
        }
        if count == 3 {
            let activation_id = &request_routes
                .iter()
                .filter(|(request_root, _)| request_root == &root)
                .nth(2)
                .unwrap()
                .1;
            let activation = store
                .get_thread_activation(activation_id)
                .await
                .unwrap()
                .unwrap();
            let thread = &board
                .threads
                .iter()
                .find(|snapshot| snapshot.thread.root_turn_id == root)
                .unwrap()
                .thread;
            assert_eq!(activation.root_turn_id, root);
            assert_eq!(activation.agent_id, thread.agent_id);
            assert_eq!(activation.context_id, thread.context_id);
            assert_eq!(activation.session_id, thread.session_id);
            assert_eq!(
                activation.initiating_principal_id,
                thread.initiating_principal_id
            );
            assert_eq!(activation.generation, thread.generation);
            let owned = store.list_activation_signals(&activation.id).await.unwrap();
            let mut event_ids = owned
                .iter()
                .filter(|signal| {
                    signal.thread_id == thread.id && signal.thread_generation == thread.generation
                })
                .map(|signal| signal.event_id.clone())
                .collect::<Vec<_>>();
            event_ids.push(activation.trigger_event_id.clone());
            let events = runtime
                .query_events(QueryFilter {
                    context_id: Some(thread.context_id.clone()),
                    session_id: Some(thread.session_id.clone()),
                    event_ids,
                    ..Default::default()
                })
                .await
                .unwrap();
            let barrier = events.iter().find(|event| event.topic == "chat/thread_group_terminal").expect("a third evaluation must own a real completed-Group wake, not metadata-only work");
            assert_eq!(barrier.payload["root_turn_id"], root);
            assert_eq!(barrier.payload["thread_id"], thread.id);
            assert_eq!(barrier.payload["thread_group_status"], "satisfied");
            assert_eq!(barrier.event_type, morphz::event::TYPE_TOOL_OUTPUT);
            assert_eq!(barrier.payload["tool_name"], "thread_group");
            assert_eq!(barrier.payload["tool_status"], "success");
            assert!(barrier.sequence.is_some());
            let group = store
                .get_thread_group(barrier.payload["thread_group_id"].as_str().unwrap())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(group.status, ThreadGroupStatus::Satisfied);
            assert_eq!(
                group.supervisor_kind,
                morphz::memory::ThreadSupervisorKind::Thread
            );
            assert_eq!(group.supervisor_id, thread.id);
            assert_eq!(group.generation, thread.generation);
            assert_eq!(group.context_id, thread.context_id);
            assert_eq!(group.session_id, thread.session_id);
            assert_eq!(group.barrier_event_id.as_deref(), Some(barrier.id.as_str()));
        }
    }
    for request in &captured {
        let text = request
            .iter()
            .map(model_visible_message_text)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("(custom ") && text.contains("ScheduledEcho"));
        assert!(!text.contains("NEVER_PROJECT_AUTHORING_STATE"));
    }
    let mut replacement = command;
    replacement.command_id = "custom-scheduled-profile-replacement".into();
    replacement.expected_revision = 1;
    replacement.body_sexpr = "(agent-profile (version 2) (identity (name LaterProfile)))".into();
    store
        .put_custom(replacement, "trusted-test-host")
        .await
        .unwrap();
    for manifest in frozen {
        assert_eq!(store.bind_thread_custom(&manifest.thread_id).await.unwrap(), manifest, "completed real Threads retain their frozen Custom rather than following the mutable head");
    }
}
