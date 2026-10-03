//! Actual SQLite/schedule_tx/no_reply(wait) regression. Scripted transport is
//! deterministic test data; no external model or user data is touched.
use morphz::{
    config::AppConfig,
    context::{CustomKey, PutCustomCommand},
    event::Event,
    llm::{model_visible_message_text, Client, Message, Response, ToolCallRepr, ToolDefinition},
    memory::{
        sqlite::SqliteStore, ActivationStore, CustomStore, ExecutionJobFilter, ExecutionJobStatus,
        ExecutionJobStore, NewSession, QueryFilter, RuntimeStore, SessionMountKind,
        ThreadGroupFilter, ThreadGroupStatus, ThreadGroupStore, ThreadLifecycle, ThreadStore,
        ThreadSupervisorKind, TimerStore,
    },
    orchestrator::context::ContextViewManifest,
    response_annotations::{
        annotations_from_authorized_event, AnnotationKind, ExecutionScope, Protocol,
        BUNDLE_PAYLOAD_KEY,
    },
    runtime::{MorphzRuntime, RuntimeToolPolicy, SchedulerQuery},
    session_io::{Limits, Request},
    sexpr::{parse, SExpr},
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
    requests: Mutex<Vec<CapturedRequest>>,
    leaves: Semaphore,
    read_before_spawn: bool,
}

fn nodes_named<'a>(expression: &'a SExpr, name: &str) -> Vec<&'a SExpr> {
    let mut pending = vec![expression];
    let mut found = Vec::new();
    while let Some(expression) = pending.pop() {
        if let SExpr::List(items) = expression {
            if matches!(items.first(), Some(SExpr::Atom(head)) if head == name) {
                found.push(expression);
            }
            pending.extend(items.iter().rev());
        }
    }
    found
}

fn atom_field<'a>(expression: &'a SExpr, field: &str) -> &'a str {
    match expression.get_path(&[field]) {
        Some(SExpr::Atom(value)) => value,
        _ => panic!("actual canonical node lacks scalar {field}: {expression}"),
    }
}

fn request_context(request: &CapturedRequest) -> SExpr {
    // Parse the actual model-facing Context subtree, not contract examples or
    // raw continuation arguments. Segment envelopes are decoded by the same
    // model-visible text helper used by production adapters.
    let contexts = request
        .messages
        .iter()
        .filter_map(|message| {
            let text = model_visible_message_text(message);
            let start = text.find("(context ")?;
            let mut depth = 0usize;
            let mut quoted = false;
            let mut escaped = false;
            for (offset, character) in text[start..].char_indices() {
                if escaped {
                    escaped = false;
                    continue;
                }
                if quoted && character == '\\' {
                    escaped = true;
                } else if character == '"' {
                    quoted = !quoted;
                } else if !quoted && character == '(' {
                    depth += 1;
                } else if !quoted && character == ')' {
                    depth -= 1;
                    if depth == 0 {
                        return Some(parse(&text[start..start + offset + 1]).unwrap());
                    }
                }
            }
            panic!("actual request contains an incomplete Context subtree");
        })
        .filter(|context| {
            let root = context
                .get_path(&["evaluate", "thread", "origin-turn"])
                .or_else(|| context.get_path(&["evaluate", "thread", "turn"]));
            root == Some(&SExpr::Atom(request.root.clone()))
        })
        .collect::<Vec<_>>();
    assert_eq!(
        contexts.len(),
        1,
        "one actual current Context must be encoded"
    );
    contexts.into_iter().next().unwrap()
}

fn raw_call_source<'a>(events: &'a [Event], call_id: &str) -> &'a Event {
    let sources = events
        .iter()
        .filter(|event| {
            event.payload[BUNDLE_PAYLOAD_KEY]["raw_response"]["tool_calls"]
                .as_array()
                .is_some_and(|calls| calls.iter().any(|call| call["id"] == call_id))
        })
        .collect::<Vec<_>>();
    assert_eq!(
        sources.len(),
        1,
        "actual carrier {call_id} has one durable source"
    );
    sources[0]
}

async fn assert_later_request_receipts(
    runtime: &MorphzRuntime,
    store: &SqliteStore,
    client: &GroupWaitClient,
    waiting: &[Event],
) {
    let requests = client.requests.lock().unwrap().clone();
    let session = "group-wait-session";
    let queued = runtime
        .query_events(QueryFilter {
            session_id: Some(session.into()),
            topic: Some("runtime/model_attempt_state".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        queued.iter().filter(|event| event.payload["state"] == "queued").count(),
        10,
        "all actual business requests are counted, with no annotation-only or protocol repair request"
    );
    let jobs = store
        .list_execution_jobs(ExecutionJobFilter {
            session_id: Some(session.into()),
            include_terminal: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        jobs.len(),
        2,
        "only the two requested readonly Recall Jobs are physical"
    );
    for job in &jobs {
        assert_eq!(job.tool_name, "recall");
        assert_eq!(job.status, ExecutionJobStatus::Succeeded);
        assert!(job.result_event_id.is_some());
        assert!(!job.request.to_string().contains("_annotations"));
    }

    for request in requests
        .iter()
        .filter(|request| (request.role == "parent" || request.role == "A") && request.count == 4)
    {
        let thread = store
            .get_thread_by_root(&request.root)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(thread.session_id, session);
        assert_eq!(thread.response_annotations, Protocol::V2);
        let events = runtime
            .query_events(QueryFilter {
                context_id: Some(thread.context_id.clone()),
                session_id: Some(thread.session_id.clone()),
                root_turn_id: Some(thread.root_turn_id.clone()),
                topic: Some("chat/assistant_call".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        let final_source = raw_call_source(&events, &format!("group-{}-4", request.role));
        let manifest: ContextViewManifest =
            serde_json::from_value(final_source.payload["context_view_manifest"].clone()).unwrap();
        assert_eq!(manifest.context_id, thread.context_id);
        let context = request_context(request);
        let current_activation = context.get_path(&["evaluate", "activation"]).unwrap();
        let current_activation_id = atom_field(current_activation, "id");
        assert_eq!(final_source.payload["activation_id"], current_activation_id);
        let final_activation = store
            .get_thread_activation(current_activation_id)
            .await
            .unwrap()
            .unwrap();
        let owner_wait = waiting
            .iter()
            .find(|event| event.payload["thread_id"] == thread.id)
            .unwrap();
        assert_ne!(owner_wait.payload["activation_id"], final_activation.id);
        assert_eq!(final_activation.trigger_kind, "chat/thread_group_terminal");
        let barrier = runtime
            .query_events(QueryFilter {
                event_id: Some(final_activation.trigger_event_id.clone()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(barrier.len(), 1);
        assert_eq!(barrier[0].topic, "chat/thread_group_terminal");
        assert_eq!(barrier[0].payload["thread_id"], thread.id);
        assert!(barrier[0].sequence.unwrap() <= manifest.event_sequence_upper_bound);
        assert!(owner_wait.sequence.unwrap() < barrier[0].sequence.unwrap());

        let receipts = nodes_named(&context, "response-annotation-receipt");
        for receipt in &receipts {
            assert_eq!(atom_field(receipt, "execution"), thread.id);
            assert_eq!(
                atom_field(receipt, "generation"),
                thread.generation.to_string()
            );
            assert_eq!(atom_field(receipt, "protocol"), "v2");
            assert!(
                receipt.get_path(&["effective"]).is_none(),
                "acceptance is not a projection winner or tool success"
            );
        }
        for count in [1, 2] {
            let call_id = format!("group-{}-{count}", request.role);
            let source = raw_call_source(&events, &call_id);
            let sequence = source.sequence.unwrap();
            assert!(sequence <= manifest.event_sequence_upper_bound);
            assert_eq!(source.payload["context_id"], thread.context_id);
            assert_eq!(source.payload["session_id"], thread.session_id);
            assert_eq!(source.payload["root_turn_id"], thread.root_turn_id);
            assert_eq!(source.payload["thread_id"], thread.id);
            assert_eq!(source.payload["thread_generation"], thread.generation);
            assert_eq!(source.payload["response_annotations"], "v2");
            assert_eq!(
                source.payload["principal_id"].as_str(),
                thread.initiating_principal_id.as_deref()
            );
            let activation_id = source.payload["activation_id"].as_str().unwrap();
            let source_activation = store
                .get_thread_activation(activation_id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(source_activation.root_turn_id, thread.root_turn_id);
            assert_eq!(source_activation.generation, thread.generation);
            assert_eq!(source_activation.agent_id, thread.agent_id);
            assert_eq!(source_activation.context_id, thread.context_id);
            assert_eq!(source_activation.session_id, thread.session_id);
            assert_eq!(
                source_activation.initiating_principal_id,
                thread.initiating_principal_id
            );
            assert_ne!(source_activation.id, final_activation.id);
            let scope = ExecutionScope {
                execution_id: thread.id.clone(),
                generation: thread.generation,
            };
            let bundle = annotations_from_authorized_event(source, &scope)
                .unwrap()
                .unwrap();
            assert_eq!(bundle.protocol, Protocol::V2);
            assert!(bundle
                .records
                .iter()
                .any(|record| record.kind == AnnotationKind::Progress));
            assert!(bundle
                .records
                .iter()
                .any(|record| record.kind == AnnotationKind::Intent
                    && record.call_id.as_deref() == Some(call_id.as_str())));
            if count == 1 {
                assert!(!bundle
                    .records
                    .iter()
                    .any(|record| record.kind == AnnotationKind::Result));
                assert!(bundle
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.path.ends_with("execution.result")));
            }
            let raw = &bundle.raw_response.tool_calls[0];
            let raw_arguments: serde_json::Value = serde_json::from_str(&raw.arguments).unwrap();
            assert!(raw_arguments.get("_annotations").is_some());
            assert_eq!(
                source.payload["continuation_tool_calls"][0]["function"]["arguments"],
                raw.arguments
            );
            let business: serde_json::Value = serde_json::from_str(
                source.payload["tool_calls"][0]["function"]["arguments"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap();
            let mut expected_business = raw_arguments;
            expected_business
                .as_object_mut()
                .unwrap()
                .remove("_annotations");
            assert_eq!(
                business, expected_business,
                "metadata must not reach either business tool"
            );
            if count == 1 {
                let immediate = requests
                    .iter()
                    .find(|candidate| candidate.root == request.root && candidate.count == 2)
                    .unwrap();
                let replayed = immediate
                    .messages
                    .iter()
                    .flat_map(|message| message.tool_calls.iter().flatten())
                    .find(|call| call.id == call_id)
                    .expect("actual native continuation retains the exact previous call");
                assert_eq!(replayed.function.arguments, raw.arguments);
            }
            let matches = receipts
                .iter()
                .filter(|receipt| atom_field(receipt, "source-event") == source.id)
                .collect::<Vec<_>>();
            if matches.is_empty() {
                let observation_ids = nodes_named(&context, "observation")
                    .iter()
                    .filter_map(|observation| observation.get_path(&["id"]))
                    .collect::<Vec<_>>();
                eprintln!("missing receipt diagnostics: role={}, receipts={}, source_visible={}, current_activation={}, observation_ids={observation_ids:?}",
                    request.role, receipts.len(), context.to_string().contains(&source.id), current_activation_id);
            }
            assert_eq!(matches.len(), 1,
                "later Group-wake request must contain the actual prior accepted annotation receipt: role={}, call={call_id}, source={}, seq={sequence}", request.role, source.id);
            let receipt = matches[0];
            assert_eq!(atom_field(receipt, "source-seq"), sequence.to_string());
            assert_eq!(atom_field(receipt, "activation"), source_activation.id);
            assert_eq!(
                atom_field(receipt, "model-attempt"),
                source.payload["model_attempt_id"].as_str().unwrap()
            );
            assert_eq!(atom_field(receipt, "state"), "accepted");
            assert_eq!(atom_field(receipt, "truncated"), "false");
            assert_eq!(
                atom_field(receipt, "diagnostic-count"),
                bundle.diagnostics.len().to_string()
            );
            assert_eq!(atom_field(receipt, "omitted-diagnostics"), "0");
            let records = nodes_named(receipt.get_path(&["accepted"]).unwrap(), "record");
            assert!(records
                .iter()
                .any(|record| atom_field(record, "kind") == "execution.progress"));
            assert!(records
                .iter()
                .any(|record| atom_field(record, "kind") == "execution.title"));
            assert!(records
                .iter()
                .any(|record| atom_field(record, "kind") == "intent"
                    && atom_field(record, "call-id") == call_id));
            assert!(!records
                .iter()
                .any(|record| atom_field(record, "kind") == "execution.result"));
            for record in &records {
                assert!(
                    record.get_path(&["value"]).is_none(),
                    "receipt must not duplicate generated prose"
                );
                assert!(record.get_path(&["effective"]).is_none());
            }
        }
    }
}

#[derive(Clone)]
struct CapturedRequest {
    root: String,
    role: String,
    count: usize,
    messages: Vec<Message>,
}

impl Default for GroupWaitClient {
    fn default() -> Self {
        Self {
            calls: Mutex::new(HashMap::new()),
            roles: Mutex::new(HashMap::new()),
            requests: Mutex::new(Vec::new()),
            leaves: Semaphore::new(0),
            read_before_spawn: false,
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
            let count = calls.entry(root.clone()).or_default();
            *count += 1;
            *count
        };
        self.requests.lock().unwrap().push(CapturedRequest {
            root,
            role: role.clone(),
            count,
            messages,
        });
        let spawn_count = if self.read_before_spawn { 2 } else { 1 };
        assert!(
            count
                <= if role == "parent" || role == "A" {
                    spawn_count + 2
                } else {
                    1
                }
        );
        let owner = role == "parent" || role == "A";
        let (name, arguments) = if owner && self.read_before_spawn && count == 1 {
            (
                "recall",
                json!({"query":"GROUP_WAIT_PARENT","limit":128,"_annotations":{
                    "execution":{"title":format!("Group {role}"),
                        "progress":"Read the persisted synthetic task before dispatch",
                        "result":"This work result is a candidate, not a completed execution"},
                    "intent":"Read the synthetic task without changing it"
                }}),
            )
        } else if owner && count == spawn_count {
            let children = if role == "parent" {
                vec![("A", "GROUP_WAIT_A"), ("B", "GROUP_WAIT_B")]
            } else {
                vec![("A1", "GROUP_WAIT_A1")]
            };
            let mut arguments = json!({"operations":children.into_iter().map(|(id,intent)|json!({
                "op":"spawn","client_id":id,"intent":intent,"lifetime":"attached"
            })).collect::<Vec<_>>(),"_annotations":{"execution":{
                "title":format!("Group {role}"),"progress":"Start the actual attached children"
            }}});
            if self.read_before_spawn {
                arguments["_annotations"]["intent"] =
                    json!("Dispatch the actual attached children into their owned Group");
            }
            ("schedule_tx", arguments)
        } else if owner && count == spawn_count + 1 {
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
        assert!(
            tools.iter().any(|tool| tool.name == name),
            "fixture requests actual tool {name:?} for role={role}, request={count}, \
             read_before_spawn={}; supplied tools={:?}; actual Evaluation={current}",
            self.read_before_spawn,
            tools
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>()
        );
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
    run_group_wait(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn accepted_annotation_receipts_survive_real_group_wake_into_a_new_activation_request() {
    run_group_wait(true).await;
}

async fn run_group_wait(read_before_spawn: bool) {
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
    let client = Arc::new(GroupWaitClient {
        read_before_spawn,
        ..Default::default()
    });
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
            // The original waiting-only regression needs only logical Context
            // tools. The receipt chain also executes the real, physical Recall
            // tool, which normal Runtime registration intentionally omits in
            // context-only mode. Do not pretend that a missing tool is a
            // receipt failure or change the original regression's tool policy.
            context_only: !read_before_spawn,
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
    assert_eq!(
        client.requests.lock().unwrap().len(),
        if read_before_spawn { 10 } else { 8 },
        "two selections, two waits, four final replies and only the two requested reads; no protocol correction or metadata-only request"
    );
    let calls = client.calls.lock().unwrap().clone();
    let roles = client.roles.lock().unwrap().clone();
    for (root, count) in calls {
        assert_eq!(
            count,
            if roles[&root] == "parent" || roles[&root] == "A" {
                if read_before_spawn {
                    4
                } else {
                    3
                }
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
    for request in client.requests.lock().unwrap().iter() {
        let text = request
            .messages
            .iter()
            .map(model_visible_message_text)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("WaitEcho") && text.contains("(custom "));
        assert!(!text.contains("NEVER_PROJECT_WAIT_AUTHORING"));
    }
    if read_before_spawn {
        assert_later_request_receipts(&runtime, &store, &client, &waiting).await;
    }
}
