//! Runtime-owned provenance over actual persisted SQL facts. No Host ancestry
//! mock or recent-history page is used. This proves source attribution, not a
//! grant of business permission; current Platform membership is tested there.
use morphz::{
    config::AppConfig,
    event::Event,
    llm::{Client, Message, Response, ToolDefinition},
    memory::{
        objective_primary_execution_root_id, postgres::PostgresStore, sqlite::SqliteStore,
        stable_thread_id, NewAgent, NewCognitiveContext, NewObjective, NewPrincipal, NewSchedule,
        NewSession, NewThread, NewThreadActivation, RuntimeStore, SessionMountKind, ThreadKind,
        ThreadSupervision,
    },
    runtime::{MorphzRuntime, RuntimeIdentity, ThreadInputSource},
};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};

type Error = Box<dyn std::error::Error + Send + Sync>;
const AGENT: &str = "origin-agent";
const CONTEXT: &str = "origin-context";
const SESSION: &str = "origin-session";
const HUMAN: &str = "origin-human";
const INPUT: &str = "original-human-input";
const INPUT_WITHOUT_THREAD: &str = "direct-admitted-human-input";

struct NoModel;
#[async_trait::async_trait]
impl Client for NoModel {
    async fn create_completion(
        &self,
        _: Vec<Message>,
        _: Vec<ToolDefinition>,
    ) -> Result<Response, Error> {
        panic!("An exact input-source read must not invoke a model");
    }
}

fn event(id: &str, actor: &str, kind: &str, topic: &str, payload: Value) -> Event {
    Event::new(
        id.into(),
        actor.into(),
        kind.into(),
        topic.into(),
        payload.as_object().unwrap().clone(),
    )
}

fn thread(id: &str, root: &str, supervision: ThreadSupervision) -> NewThread {
    NewThread {
        response_annotations: morphz::response_annotations::Protocol::Off,
        model_alias: None,
        reasoning_effort: None,
        id: id.into(),
        agent_id: AGENT.into(),
        context_id: CONTEXT.into(),
        session_id: SESSION.into(),
        initiating_principal_id: Some(HUMAN.into()),
        root_turn_id: root.into(),
        kind: ThreadKind::Execution,
        executor_kind: "self".into(),
        executor_id: None,
        target_id: None,
        supervision,
    }
}

async fn runtime(store: Arc<dyn RuntimeStore>, directory: &Path) -> MorphzRuntime {
    let mut config = AppConfig::default();
    config.permissions.workspace_root = directory.to_string_lossy().into_owned();
    config.background_task.artifact_dir =
        directory.join("artifacts").to_string_lossy().into_owned();
    MorphzRuntime::builder(config, Arc::new(NoModel))
        .identity(RuntimeIdentity {
            agent_id: AGENT.into(),
            context_id: CONTEXT.into(),
            principal_id: HUMAN.into(),
        })
        .store("provenance-contract", store)
        .build()
        .await
        .unwrap()
}

async fn seed(store: &dyn RuntimeStore) {
    store
        .create_agent_bundle(
            NewAgent {
                id: AGENT.into(),
                title: "Source contract".into(),
                root_context_id: CONTEXT.into(),
            },
            NewCognitiveContext {
                id: CONTEXT.into(),
                agent_id: AGENT.into(),
                title: "Source contract".into(),
            },
            NewSession {
                id: SESSION.into(),
                agent_id: AGENT.into(),
                context_id: CONTEXT.into(),
                parent_session_id: None,
                title: "Source contract".into(),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await
        .unwrap();
    for principal in [HUMAN, "other-human"] {
        store
            .ensure_principal(NewPrincipal {
                id: principal.into(),
                provider_id: "runtime-default".into(),
                assurance: "local".into(),
                display_name: None,
            })
            .await
            .unwrap();
    }
    store.bind_session_principal(SESSION, HUMAN).await.unwrap();
    store
        .ensure_session(NewSession {
            id: "other-session".into(),
            agent_id: AGENT.into(),
            context_id: CONTEXT.into(),
            parent_session_id: None,
            title: "Scope distractor".into(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    store
        .append(event(
            INPUT,
            "Session-Client",
            "session_message",
            "chat/user_message",
            json!({
                "context_id":CONTEXT, "session_id":SESSION, "principal_id":HUMAN,
                "client_message_id":"platform-input", "text":"Synthetic source contract input"
            }),
        ))
        .await
        .unwrap();
    let root = stable_thread_id(INPUT);
    store
        .ensure_thread(thread(&root, INPUT, ThreadSupervision::runtime("runtime")))
        .await
        .unwrap();

    // Real creation receipt and its durable Evaluation, rather than a model's
    // source_refs or a synthetic Goal root interpreted as a Human Event ID.
    let activation = "source-evaluation".to_owned();
    store
        .ensure_thread_activation(NewThreadActivation {
            id: activation.clone(),
            agent_id: AGENT.into(),
            context_id: CONTEXT.into(),
            session_id: SESSION.into(),
            initiating_principal_id: Some(HUMAN.into()),
            trigger_event_id: INPUT.into(),
            trigger_sequence: 1,
            trigger_kind: "user_message".into(),
            parent_activation_id: None,
            root_turn_id: INPUT.into(),
        })
        .await
        .unwrap();
    store
        .append(event(
            "goal-creation",
            "Agent-Morphz",
            "objective_control",
            "objective/autonomous_requested",
            json!({
                "context_id":CONTEXT, "session_id":SESSION, "principal_id":HUMAN,
                "requested_objective_id":"goal", "attempt_id":activation,
                "source_refs":["non-authoritative-model-claim"]
            }),
        ))
        .await
        .unwrap();
    store
        .create_objective(NewObjective {
            model_alias: None,
            reasoning_effort: None,
            id: "goal".into(),
            agent_id: AGENT.into(),
            context_id: CONTEXT.into(),
            coordinator_session_id: SESSION.into(),
            delivery_session_id: SESSION.into(),
            parent_objective_id: None,
            source_event_id: "goal-creation".into(),
            initiating_principal_id: Some(HUMAN.into()),
            stated_objective: "Synthetic autonomous source contract".into(),
            token_budget: None,
        })
        .await
        .unwrap();
    let goal_root = objective_primary_execution_root_id("goal", 1);
    let goal_thread = stable_thread_id(&goal_root);
    store
        .ensure_thread(thread(
            &goal_thread,
            &goal_root,
            ThreadSupervision::objective_primary_execution("goal", 1),
        ))
        .await
        .unwrap();
    store
        .ensure_thread(thread(
            "spawned-child",
            "spawned-root",
            ThreadSupervision::attached(&goal_thread, 1, "spawn-evaluation"),
        ))
        .await
        .unwrap();

    store
        .append(event(
            INPUT_WITHOUT_THREAD,
            "Session-Client",
            "session_message",
            "chat/user_message",
            json!({"context_id":CONTEXT,"session_id":SESSION,"principal_id":HUMAN,
                "client_message_id":"direct-admitted-platform-input","text":"Direct admission"}),
        ))
        .await
        .unwrap();
    store
        .create_objective(NewObjective {
            model_alias: None,
            reasoning_effort: None,
            id: "direct-admitted-goal".into(),
            agent_id: AGENT.into(),
            context_id: CONTEXT.into(),
            coordinator_session_id: SESSION.into(),
            delivery_session_id: SESSION.into(),
            parent_objective_id: None,
            source_event_id: INPUT_WITHOUT_THREAD.into(),
            initiating_principal_id: Some(HUMAN.into()),
            stated_objective: "Direct admitted Goal retains exact input".into(),
            token_budget: None,
        })
        .await
        .unwrap();
    let direct_goal_root = objective_primary_execution_root_id("direct-admitted-goal", 1);
    store
        .ensure_thread(thread(
            &stable_thread_id(&direct_goal_root),
            &direct_goal_root,
            ThreadSupervision::objective_primary_execution("direct-admitted-goal", 1),
        ))
        .await
        .unwrap();
    let adopted = thread(
        "adopted-schedule-thread",
        "adopted-schedule-root",
        ThreadSupervision::runtime("runtime"),
    );
    store
        .commit_schedule_transaction(
            &[],
            &[],
            std::slice::from_ref(&adopted),
            &[NewSchedule {
                id: "adopted-source-schedule".into(),
                thread_id: adopted.id.clone(),
                source_turn_id: INPUT_WITHOUT_THREAD.into(),
                intent: "Adopted Schedule retains its admitted input".into(),
                model_alias: None,
                reasoning_effort: None,
                not_before: None,
                interval_seconds: None,
                dependency_thread_ids: vec![],
            }],
            &[],
        )
        .await
        .unwrap();

    let infer = json!({ "context_id":CONTEXT, "session_id":SESSION, "principal_id":HUMAN, "agent_id":AGENT,
        "root_turn_id":"infer-root", "plan_execution_id":"plan", "parent_thread_id":"spawned-child" });
    store
        .append(event(
            "infer-root",
            "Runtime-Yao",
            "infer_request",
            "chat/infer_request",
            infer.clone(),
        ))
        .await
        .unwrap();
    let mut infer_thread = thread(
        "infer-child",
        "infer-root",
        ThreadSupervision::attached("spawned-child", 1, "infer-evaluation"),
    );
    infer_thread.executor_kind = "plan_infer".into();
    infer_thread.executor_id = Some("plan".into());
    store.ensure_thread(infer_thread.clone()).await.unwrap();
    let mut mismatch = infer_thread.clone();
    mismatch.id = "infer-plan-mismatch".into();
    mismatch.root_turn_id = "infer-plan-mismatch-root".into();
    mismatch.executor_id = Some("different-plan".into());
    let mut mismatch_event = infer.clone();
    mismatch_event["root_turn_id"] = json!(mismatch.root_turn_id);
    store
        .append(event(
            &mismatch.root_turn_id,
            "Runtime-Yao",
            "infer_request",
            "chat/infer_request",
            mismatch_event,
        ))
        .await
        .unwrap();
    store.ensure_thread(mismatch).await.unwrap();
    let mut mismatch = infer_thread.clone();
    mismatch.id = "infer-parent-mismatch".into();
    mismatch.root_turn_id = "infer-parent-mismatch-root".into();
    mismatch.supervision = ThreadSupervision::attached(&root, 1, "infer-evaluation");
    let mut mismatch_event = infer;
    mismatch_event["root_turn_id"] = json!(mismatch.root_turn_id);
    store
        .append(event(
            &mismatch.root_turn_id,
            "Runtime-Yao",
            "infer_request",
            "chat/infer_request",
            mismatch_event,
        ))
        .await
        .unwrap();
    store.ensure_thread(mismatch).await.unwrap();
    let mut mismatch = infer_thread;
    mismatch.id = "infer-human-root-bypass".into();
    mismatch.root_turn_id = "infer-human-root-bypass-root".into();
    store
        .append(event(
            &mismatch.root_turn_id,
            "Session-Client",
            "session_message",
            "chat/user_message",
            json!({
                "context_id":CONTEXT, "session_id":SESSION, "principal_id":HUMAN,
                "client_message_id":"another-human-input", "text":"Input is not an infer receipt"
            }),
        ))
        .await
        .unwrap();
    store.ensure_thread(mismatch).await.unwrap();

    for (id, scope) in [
        ("cross-principal", "principal"),
        ("cross-session", "session"),
        ("missing-parent", "missing"),
    ] {
        let mut child = thread(
            id,
            id,
            ThreadSupervision::attached(&root, 1, "scope-evaluation"),
        );
        match scope {
            "principal" => child.initiating_principal_id = Some("other-human".into()),
            "session" => child.session_id = "other-session".into(),
            _ => {
                child.supervision =
                    ThreadSupervision::attached("absent-parent", 1, "scope-evaluation")
            }
        }
        store.ensure_thread(child).await.unwrap();
    }
    store
        .ensure_thread(thread(
            "cycle-a",
            "cycle-root-a",
            ThreadSupervision::attached("cycle-b", 1, "cycle-evaluation"),
        ))
        .await
        .unwrap();
    store
        .ensure_thread(thread(
            "cycle-b",
            "cycle-root-b",
            ThreadSupervision::attached("cycle-a", 1, "cycle-evaluation"),
        ))
        .await
        .unwrap();
    let mut parent = root;
    for i in 0..65 {
        let id = format!("depth-{i}");
        store
            .ensure_thread(thread(
                &id,
                &format!("depth-root-{i}"),
                ThreadSupervision::attached(&parent, 1, "depth-evaluation"),
            ))
            .await
            .unwrap();
        parent = id;
    }
    let future_root = objective_primary_execution_root_id("goal", 2);
    store
        .ensure_thread(thread(
            &stable_thread_id(&future_root),
            &future_root,
            ThreadSupervision::objective_primary_execution("goal", 2),
        ))
        .await
        .unwrap();
    store
        .ensure_thread(thread(
            "noncanonical-goal",
            "fabricated-goal-root",
            ThreadSupervision::objective_primary_execution("goal", 1),
        ))
        .await
        .unwrap();

    // A timer has an explicit source variant, not an invented ordinary input.
    store
        .commit_schedule_transaction(
            &[],
            &[],
            &[thread(
                "scheduled",
                "scheduled-admission",
                ThreadSupervision::runtime("runtime"),
            )],
            &[NewSchedule {
                id: "schedule".into(),
                thread_id: "scheduled".into(),
                source_turn_id: "scheduled-admission".into(),
                intent: "Source contract timer".into(),
                model_alias: None,
                reasoning_effort: None,
                not_before: None,
                interval_seconds: None,
                dependency_thread_ids: vec![],
            }],
            &[],
        )
        .await
        .unwrap();
    store
        .ensure_thread(thread(
            "scheduled-child",
            "scheduled-child-root",
            ThreadSupervision::attached("scheduled", 1, "timer-evaluation"),
        ))
        .await
        .unwrap();
    let scheduled = thread(
        "ambiguous-scheduled",
        "ambiguous-admission",
        ThreadSupervision::runtime("runtime"),
    );
    let schedule = |id: &str, source: &str| NewSchedule {
        id: id.into(),
        thread_id: scheduled.id.clone(),
        source_turn_id: source.into(),
        intent: "Ambiguous proof must fail closed".into(),
        model_alias: None,
        reasoning_effort: None,
        not_before: None,
        interval_seconds: None,
        dependency_thread_ids: vec![],
    };
    store
        .commit_schedule_transaction(
            &[],
            &[],
            std::slice::from_ref(&scheduled),
            &[
                schedule("ambiguous-direct", "ambiguous-admission"),
                schedule("ambiguous-indirect", INPUT),
            ],
            &[],
        )
        .await
        .unwrap();
}

async fn seed_recovery(store: &dyn RuntimeStore) {
    let payload = json!({"context_id":CONTEXT,"session_id":SESSION,"root_turn_id":INPUT,
        "thread_id":stable_thread_id(INPUT),"principal_id":HUMAN,
        "dependency_id":"source-dependency","recovery_event_id":"source-available", "runtime_force_evaluation":true});
    store
        .append(event(
            "source-provider-resumed",
            "Runtime-ProviderRecovery",
            "tool_output",
            "runtime/provider_recovered",
            payload.clone(),
        ))
        .await
        .unwrap();
    store
        .append(event(
            "source-forged-resumed",
            "Model",
            "tool_output",
            "runtime/provider_recovered",
            payload,
        ))
        .await
        .unwrap();
}

async fn assert_recovery_projection(store: &dyn RuntimeStore) {
    let entries = store
        .query_session_timeline(SESSION, None, 100)
        .await
        .unwrap();
    let recovered = entries
        .iter()
        .find(|entry| entry.entry_id == "source-provider-resumed")
        .expect("Resumed status must survive cold history, not just WebSocket");
    assert_eq!(recovered.root_turn_id, INPUT);
    assert_eq!(recovered.display_kind, "progress");
    // Timeline final_event fixes the immutable row's source. Only display_kind
    // reply/error completes a response; a progress row is not Thread completion.
    assert!(recovered.final_event);
    assert!(recovered.attempt_id.is_none());
    assert!(!recovered.event.payload.contains_key("text"));
    assert!(!entries
        .iter()
        .any(|entry| entry.entry_id == "source-forged-resumed"));
}

async fn assert_sources(runtime: &MorphzRuntime) {
    let goal = stable_thread_id(&objective_primary_execution_root_id("goal", 1));
    let root = stable_thread_id(INPUT);
    for id in [&root, &goal, "spawned-child", "infer-child", "depth-62"] {
        let proof = runtime
            .session_thread_input_source(SESSION, id)
            .await
            .unwrap()
            .unwrap();
        match proof
            .source
            .unwrap_or_else(|| panic!("missing source for {id}"))
        {
            ThreadInputSource::Input {
                input_event,
                root_thread_id,
            } => {
                assert_eq!(input_event.id, INPUT);
                assert_eq!(input_event.payload["principal_id"], HUMAN);
                assert_eq!(root_thread_id.as_deref(), Some(root.as_str()));
            }
            _ => panic!("{id} must retain its original Human input"),
        }
    }
    let direct_goal = stable_thread_id(&objective_primary_execution_root_id(
        "direct-admitted-goal",
        1,
    ));
    for id in [&direct_goal, "adopted-schedule-thread"] {
        let proof = runtime
            .session_thread_input_source(SESSION, id)
            .await
            .unwrap()
            .unwrap();
        match proof
            .source
            .expect("An exact directly admitted input must remain readable")
        {
            ThreadInputSource::Input {
                input_event,
                root_thread_id,
            } => {
                assert_eq!(input_event.id, INPUT_WITHOUT_THREAD);
                assert_eq!(input_event.payload["principal_id"], HUMAN);
                assert!(root_thread_id.is_none());
            }
            _ => panic!("Do not substitute Schedule admission or fabricate a Human Thread"),
        }
    }
    for id in [
        "infer-plan-mismatch",
        "infer-parent-mismatch",
        "infer-human-root-bypass",
        "cross-principal",
        "missing-parent",
        "cycle-a",
        "cycle-b",
        "depth-64",
        "noncanonical-goal",
        "ambiguous-scheduled",
    ] {
        assert!(
            runtime
                .session_thread_input_source(SESSION, id)
                .await
                .unwrap()
                .unwrap()
                .source
                .is_none(),
            "unproven origin accepted: {id}"
        );
    }
    let future = stable_thread_id(&objective_primary_execution_root_id("goal", 2));
    assert!(runtime
        .session_thread_input_source(SESSION, &future)
        .await
        .unwrap()
        .unwrap()
        .source
        .is_none());
    assert!(runtime
        .session_thread_input_source(SESSION, "cross-session")
        .await
        .unwrap()
        .is_none());
    assert!(runtime
        .session_thread_input_source("other-session", "cross-session")
        .await
        .unwrap()
        .unwrap()
        .source
        .is_none());
    assert!(runtime
        .session_thread_input_source("other-session", &root)
        .await
        .unwrap()
        .is_none());
    assert!(runtime
        .session_thread_input_source(SESSION, "absent-thread")
        .await
        .unwrap()
        .is_none());
    for id in ["scheduled", "scheduled-child"] {
        match runtime
            .session_thread_input_source(SESSION, id)
            .await
            .unwrap()
            .unwrap()
            .source
            .unwrap()
        {
            ThreadInputSource::Schedule {
                schedule_id,
                source_turn_id,
                root_thread_id,
            } => {
                assert_eq!(schedule_id, "schedule");
                assert_eq!(source_turn_id, "scheduled-admission");
                assert_eq!(root_thread_id, "scheduled");
            }
            _ => panic!("Timer lineage must retain exact committed Schedule identity"),
        }
    }
}

#[tokio::test]
async fn sqlite_exact_thread_origins_survive_cold_reopen_and_reject_foreign_or_ambiguous_proof() {
    let directory = tempfile::tempdir().unwrap();
    let db = directory.path().join("source.sqlite");
    {
        let store = Arc::new(SqliteStore::new(db.to_str().unwrap()).await.unwrap());
        seed(store.as_ref()).await;
        seed_recovery(store.as_ref()).await;
        assert_recovery_projection(store.as_ref()).await;
        assert_sources(&runtime(store, directory.path()).await).await;
    }
    // Simulate only the old derived projection. Never remove or rewrite Events.
    let inspection = sqlx::SqlitePool::connect(&format!("sqlite://{}", db.display()))
        .await
        .unwrap();
    sqlx::query(
        "DELETE FROM schema_migrations WHERE version = '20261013_03_provider_resume_timeline'",
    )
    .execute(&inspection)
    .await
    .unwrap();
    sqlx::query("DELETE FROM session_message_timeline WHERE entry_id = 'source-provider-resumed'")
        .execute(&inspection)
        .await
        .unwrap();
    inspection.close().await;
    let reopened = Arc::new(SqliteStore::new(db.to_str().unwrap()).await.unwrap());
    assert_recovery_projection(reopened.as_ref()).await;
    let reopened = runtime(reopened, directory.path()).await;
    assert_sources(&reopened).await;
    assert_http_boundary(reopened).await;
}

async fn assert_http_boundary(runtime: MorphzRuntime) {
    use morphz::web::{Server, ServerDefaults};
    use std::time::Duration;
    let server = Server::new(
        runtime,
        ServerDefaults {
            agent_id: AGENT.into(),
            context_id: CONTEXT.into(),
        },
    );
    let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = reservation.local_addr().unwrap().to_string();
    drop(reservation);
    let url = format!("http://{address}");
    let handle = tokio::spawn(async move {
        server
            .start_with_dashboard_token(&address, Some("source-contract-token".into()))
            .await
            .unwrap();
    });
    let client = reqwest::Client::new();
    let path = format!("{url}/api/sessions/{SESSION}/threads/spawned-child/input-source");
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if client.get(&path).send().await.is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(client.get(&path).send().await.unwrap().status(), 401);
    let reply = client
        .get(&path)
        .bearer_auth("source-contract-token")
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status(), 200);
    let proof: Value = reply.json().await.unwrap();
    assert_eq!(proof["source"]["kind"], "input");
    assert_eq!(proof["source"]["input_event"]["id"], INPUT);
    let missing = client
        .get(format!(
            "{url}/api/sessions/{SESSION}/threads/absent/input-source"
        ))
        .bearer_auth("source-contract-token")
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), 404);
    let wrong_session = client
        .get(format!(
            "{url}/api/sessions/other-session/threads/spawned-child/input-source"
        ))
        .bearer_auth("source-contract-token")
        .send()
        .await
        .unwrap();
    assert_eq!(wrong_session.status(), 404);
    let unproven = client
        .get(format!(
            "{url}/api/sessions/{SESSION}/threads/cycle-a/input-source"
        ))
        .bearer_auth("source-contract-token")
        .send()
        .await
        .unwrap();
    assert_eq!(unproven.status(), 200);
    assert!(unproven.json::<Value>().await.unwrap()["source"].is_null());
    handle.abort();
}

#[tokio::test]
#[ignore = "requires an explicitly prepared dedicated PostgreSQL test database"]
async fn postgres_exact_thread_origins_survive_cold_reopen_and_reject_foreign_or_ambiguous_proof() {
    let database_url =
        std::env::var("MORPHZ_TEST_POSTGRES_URL").expect("dedicated PostgreSQL URL required");
    let schema = format!(
        "morphz_source_{}_{}",
        std::process::id(),
        chrono::Utc::now()
            .timestamp_nanos_opt()
            .unwrap()
            .unsigned_abs()
    );
    let admin = sqlx::PgPool::connect(&database_url).await.unwrap();
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&admin)
        .await
        .unwrap();
    let separator = if database_url.contains('?') { '&' } else { '?' };
    let scoped = format!("{database_url}{separator}options=-csearch_path%3D{schema}%2Cpublic");
    let directory = tempfile::tempdir().unwrap();
    {
        let store = Arc::new(PostgresStore::new(&scoped, 4).await.unwrap());
        seed(store.as_ref()).await;
        seed_recovery(store.as_ref()).await;
        assert_recovery_projection(store.as_ref()).await;
        assert_sources(&runtime(store.clone(), directory.path()).await).await;
        sqlx::query(
            "DELETE FROM schema_migrations WHERE version = '20261013_03_provider_resume_timeline'",
        )
        .execute(store.pool())
        .await
        .unwrap();
        sqlx::query(
            "DELETE FROM session_message_timeline WHERE entry_id = 'source-provider-resumed'",
        )
        .execute(store.pool())
        .await
        .unwrap();
        store.pool().close().await;
    }
    let reopened = Arc::new(PostgresStore::new(&scoped, 4).await.unwrap());
    assert_recovery_projection(reopened.as_ref()).await;
    assert_sources(&runtime(reopened.clone(), directory.path()).await).await;
    reopened.pool().close().await;
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}
