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
use sha2::{Digest, Sha256};
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
    seed_periodic_origins(store).await;
}

fn periodic_root(schedule: &str, revision: u64) -> String {
    let hash = format!(
        "{:x}",
        Sha256::digest(format!("{schedule}\0{revision}").as_bytes())
    );
    format!("scheduled_occurrence_{}", &hash[..24])
}

async fn seed_periodic_origins(store: &dyn RuntimeStore) {
    // The same read resolver must cover an admitted input, an inputless timer,
    // Objective ownership and nested infer. Commit real due Events/Signals,
    // including the pre-Activation state; no model or running timer is needed.
    store
        .ensure_thread(thread(
            "periodic-template",
            "periodic-template-root",
            ThreadSupervision::runtime("operator-schedule"),
        ))
        .await
        .unwrap();
    for (label, owner_id, source_id) in [
        (
            "input",
            "adopted-schedule-thread".to_owned(),
            INPUT_WITHOUT_THREAD,
        ),
        (
            "schedule",
            "periodic-template".to_owned(),
            "periodic-template-root",
        ),
        (
            "goal",
            stable_thread_id(&objective_primary_execution_root_id("goal", 1)),
            INPUT,
        ),
    ] {
        let schedule_id = format!("periodic-{label}");
        let schedule = store
            .ensure_schedule(NewSchedule {
                id: schedule_id.clone(),
                thread_id: owner_id.clone(),
                source_turn_id: source_id.into(),
                intent: format!("Periodic {label} origin"),
                model_alias: None,
                reasoning_effort: None,
                not_before: None,
                interval_seconds: Some(3600),
                dependency_thread_ids: vec![],
            })
            .await
            .unwrap();
        let root = periodic_root(&schedule_id, schedule.revision);
        let id = stable_thread_id(&root);
        let occurrence = thread(
            &id,
            &root,
            ThreadSupervision::runtime("schedule-occurrence-router"),
        );
        let due = event(
            &format!("schedule_due_{schedule_id}_r{}", schedule.revision),
            "Runtime-Scheduler",
            "tool_output",
            "chat/schedule_due",
            json!({
                "context_id":CONTEXT, "session_id":SESSION, "principal_id":HUMAN, "agent_id":AGENT,
                "root_turn_id":root, "schedule_id":schedule_id, "scheduled_thread_id":owner_id,
                "source_turn_id":source_id, "occurrence_revision":schedule.revision, "interval_seconds":3600,
            }),
        );
        assert!(store
            .commit_scheduled_dispatch(
                &schedule.id,
                schedule.revision,
                Some(chrono::Utc::now() + chrono::Duration::hours(1)),
                &due,
                Some(&occurrence)
            )
            .await
            .unwrap()
            .is_some());
        let child_id = format!("periodic-{label}-child");
        store
            .ensure_thread(thread(
                &child_id,
                &format!("periodic-{label}-child-root"),
                ThreadSupervision::attached(&id, 1, "periodic-parent-evaluation"),
            ))
            .await
            .unwrap();
        let infer_root = format!("periodic-{label}-infer-root");
        let plan = format!("periodic-{label}-plan");
        store.append(event(&infer_root, "Runtime-Yao", "infer_request", "chat/infer_request", json!({
            "context_id":CONTEXT, "session_id":SESSION, "principal_id":HUMAN, "agent_id":AGENT,
            "root_turn_id":infer_root, "plan_execution_id":plan, "parent_thread_id":child_id,
        }))).await.unwrap();
        let mut infer = thread(
            &format!("periodic-{label}-infer"),
            &infer_root,
            ThreadSupervision::attached(&child_id, 1, "periodic-infer-evaluation"),
        );
        infer.executor_kind = "plan_infer".into();
        infer.executor_id = Some(plan);
        store.ensure_thread(infer).await.unwrap();
    }
    for mutation in ["actor", "source", "principal", "uncommitted"] {
        let schedule_id = format!("unproven-periodic-{mutation}");
        let owner_id = format!("unproven-template-{mutation}");
        let mut owner = thread(
            &owner_id,
            &format!("unproven-root-{mutation}"),
            ThreadSupervision::runtime("operator"),
        );
        if mutation == "principal" {
            owner.initiating_principal_id = Some("other-human".into());
        }
        store.ensure_thread(owner).await.unwrap();
        let schedule = store
            .ensure_schedule(NewSchedule {
                id: schedule_id.clone(),
                thread_id: owner_id.clone(),
                source_turn_id: INPUT.into(),
                intent: "Unproven periodic admission".into(),
                model_alias: None,
                reasoning_effort: None,
                not_before: None,
                interval_seconds: Some(3600),
                dependency_thread_ids: vec![],
            })
            .await
            .unwrap();
        let root = periodic_root(&schedule_id, schedule.revision);
        let occurrence = thread(
            &stable_thread_id(&root),
            &root,
            ThreadSupervision::runtime("schedule-occurrence-router"),
        );
        let due = event(
            &format!("schedule_due_{schedule_id}_r{}", schedule.revision),
            if mutation == "actor" {
                "Model"
            } else {
                "Runtime-Scheduler"
            },
            "tool_output",
            "chat/schedule_due",
            json!({
                "context_id":CONTEXT, "session_id":SESSION, "principal_id":HUMAN, "agent_id":AGENT,
                "root_turn_id":root, "schedule_id":schedule_id, "scheduled_thread_id":owner_id,
                "source_turn_id": if mutation == "source" { INPUT_WITHOUT_THREAD } else { INPUT },
                "occurrence_revision":schedule.revision, "interval_seconds":3600,
            }),
        );
        if mutation == "uncommitted" {
            store.ensure_thread(occurrence).await.unwrap();
            store.append(due).await.unwrap();
        } else {
            assert!(store
                .commit_scheduled_dispatch(
                    &schedule.id,
                    schedule.revision,
                    Some(chrono::Utc::now() + chrono::Duration::hours(1)),
                    &due,
                    Some(&occurrence)
                )
                .await
                .unwrap()
                .is_some());
        }
    }
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
    for (label, source) in [
        ("input", Some(INPUT_WITHOUT_THREAD)),
        ("goal", Some(INPUT)),
        ("schedule", None),
    ] {
        let occurrence = stable_thread_id(&periodic_root(&format!("periodic-{label}"), 1));
        for id in [
            occurrence,
            format!("periodic-{label}-child"),
            format!("periodic-{label}-infer"),
        ] {
            let proof = runtime
                .session_thread_input_source(SESSION, &id)
                .await
                .unwrap()
                .unwrap();
            match (source, proof.source) {
                (Some(expected), Some(ThreadInputSource::Input { input_event, .. })) => {
                    assert_eq!(input_event.id, expected)
                }
                (None, Some(ThreadInputSource::Schedule { schedule_id, .. })) => {
                    assert_eq!(schedule_id, "periodic-schedule")
                }
                (_, proof) => panic!("Wrong periodic {label} source for {id}: {proof:?}"),
            }
            let detail = runtime.thread_detail(CONTEXT, &id).await.unwrap().unwrap();
            assert_eq!(
                detail
                    .snapshot
                    .source
                    .as_ref()
                    .map(|s| s.root_turn_id.as_str()),
                source
            );
            let records = morphz::sdk::MorphzSdk::new(runtime.clone())
                .session_execution_records(
                    HUMAN,
                    SESSION,
                    morphz::runtime::ExecutionRecordsQuery {
                        thread_id: Some(id.clone()),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
            assert_eq!(records.threads[0].id, id);
            assert_eq!(
                records.threads[0].initiating_principal_id.as_deref(),
                Some(HUMAN)
            );
            assert_eq!(
                records.source_root_id.as_deref(),
                source.or(Some("periodic-template-root"))
            );
        }
    }
    for mutation in ["actor", "source", "principal", "uncommitted"] {
        let id = stable_thread_id(&periodic_root(&format!("unproven-periodic-{mutation}"), 1));
        let view = runtime
            .session_thread_input_source(SESSION, &id)
            .await
            .unwrap()
            .unwrap();
        assert!(
            view.source.is_none(),
            "unproven periodic {mutation} cannot grant input association"
        );
        let records = morphz::sdk::MorphzSdk::new(runtime.clone())
            .session_execution_records(
                HUMAN,
                SESSION,
                morphz::runtime::ExecutionRecordsQuery {
                    thread_id: Some(id.clone()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(
            records.threads[0].id, id,
            "unresolved provenance cannot erase authorized facts"
        );
        assert!(records.source_root_id.is_none());
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
        "DELETE FROM schema_migrations WHERE version = '20261016_01_evaluation_results_timeline'",
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

#[tokio::test]
async fn sqlite_http_boundary_ignores_inherited_proxy_in_an_isolated_process() -> Result<(), Error>
{
    use std::{
        process::Stdio,
        sync::atomic::{AtomicUsize, Ordering},
        time::Duration,
    };

    const ORIGINAL_TEST: &str =
        "sqlite_exact_thread_origins_survive_cold_reopen_and_reject_foreign_or_ambiguous_proof";
    let directory = tempfile::tempdir()?;
    let log_path = directory.path().join("child.log");
    let stdout = std::fs::File::create(&log_path)?;
    let stderr = stdout.try_clone()?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let proxy_url = format!("http://{}", listener.local_addr()?);
    let hits = Arc::new(AtomicUsize::new(0));
    let proxy_hits = Arc::clone(&hits);
    let router = axum::Router::new().fallback(move || {
        proxy_hits.fetch_add(1, Ordering::SeqCst);
        async {
            (
                axum::http::StatusCode::BAD_GATEWAY,
                "Controlled test proxy: forwarding is forbidden",
            )
        }
    });
    let (shutdown, stopped) = tokio::sync::oneshot::channel::<()>();
    let mut proxy = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
    });

    // Never mutate this test runner's environment. The exact original test is
    // the child entry point, so it runs the full persisted-data/auth contract
    // without recursively launching this proxy regression.
    let mut child_exited = true;
    let child_result: Result<std::process::ExitStatus, Error> = async {
        // Prove the owned proxy is listening and returns 502 before measuring
        // the child's zero hits. It never connects to the request destination.
        let control = reqwest::Client::builder()
            .no_proxy()
            .proxy(reqwest::Proxy::all(&proxy_url)?)
            .timeout(Duration::from_secs(5))
            .build()?
            .get("http://127.0.0.1:1/controlled-proxy-check")
            .send()
            .await?;
        if control.status() != reqwest::StatusCode::BAD_GATEWAY
            || hits.load(Ordering::SeqCst) != 1
        {
            return Err("The controlled 502 proxy was not reached exactly once".into());
        }
        let mut command = tokio::process::Command::new(std::env::current_exe()?);
        command
            .args(["--exact", ORIGINAL_TEST, "--nocapture", "--test-threads=1"])
            .env_clear()
            .current_dir(directory.path())
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(stderr)
            .kill_on_drop(true);
        for name in ["PATH", "SystemRoot", "LANG", "LC_ALL"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        for name in [
            "HOME",
            "USERPROFILE",
            "XDG_CONFIG_HOME",
            "MORPHZ_HOME",
            "TMPDIR",
            "TEMP",
            "TMP",
        ] {
            command.env(name, directory.path());
        }
        for name in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ] {
            command.env(name, &proxy_url);
        }
        // An empty bypass list is intentional. In particular, do not depend
        // on '*' matching numeric loopback hosts in the upstream proxy crate.
        command.env("NO_PROXY", "").env("no_proxy", "");
        let mut child = command.spawn()?;
        child_exited = false;
        let wait = tokio::time::timeout(Duration::from_secs(90), child.wait()).await;
        match wait {
            Ok(Ok(status)) => {
                child_exited = true;
                Ok(status)
            }
            failure => {
                let kill = child.start_kill();
                let reap = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
                child_exited = matches!(&reap, Ok(Ok(_)));
                Err(format!(
                    "Proxy-isolated child did not finish: {failure:?}; kill: {kill:?}; reap: {reap:?}"
                )
                .into())
            }
        }
    }
    .await;

    // Attempt bounded shutdown before asserting and preserve all diagnostics.
    // An unconfirmed child exit must retain its directory, not delete live
    // SQLite/WAL/log files while relying on kill_on_drop's best-effort signal.
    let _ = shutdown.send(());
    let proxy_result = match tokio::time::timeout(Duration::from_secs(5), &mut proxy).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(result) => Err(format!("Controlled proxy shutdown failed: {result:?}")),
        Err(error) => {
            proxy.abort();
            let joined = proxy.await;
            Err(format!(
                "Controlled proxy shutdown timed out: {error}; join: {joined:?}"
            ))
        }
    };
    let log = std::fs::read_to_string(&log_path)
        .unwrap_or_else(|error| format!("Could not read child diagnostics: {error}"));
    let retained_directory = if child_exited {
        None
    } else {
        Some(directory.keep())
    };
    let requests = hits.load(Ordering::SeqCst);
    assert!(
        child_exited
            && child_result.as_ref().is_ok_and(|status| status.success())
            && proxy_result.is_ok()
            && requests == 1
            && log.contains(&format!("test {ORIGINAL_TEST} ... ok"))
            && log.contains("1 passed; 0 failed"),
        "The original SQLite contract must pass with zero child proxy requests \
         (one explicit control request only).\n\
         child: {child_result:?}; exited: {child_exited}; retained directory: {retained_directory:?}; \
         proxy: {proxy_result:?}; total requests: {requests}\n{log}"
    );
    Ok(())
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
    // This client talks only to the owned loopback server. A system proxy can
    // return 502 before that server binds; it is not the authentication boundary.
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let path = format!("{url}/api/sessions/{SESSION}/threads/spawned-child/input-source");
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if client
                .get(&path)
                .send()
                .await
                .is_ok_and(|response| response.status() == reqwest::StatusCode::UNAUTHORIZED)
            {
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
    let records_path = format!("{url}/api/sessions/{SESSION}/execution-records");
    assert_eq!(
        client.get(&records_path).send().await.unwrap().status(),
        401
    );
    let goal_thread = stable_thread_id(&objective_primary_execution_root_id("goal", 1));
    let read = client
        .get(&records_path)
        .bearer_auth("source-contract-token")
        .query(&[
            ("thread_id", goal_thread.as_str()),
            ("root_turn_ids", &json!([INPUT]).to_string()),
            ("include_descendants", "true"),
            ("limit", "100"),
        ])
        .send()
        .await
        .unwrap();
    let status = read.status();
    if status != 200 {
        panic!(
            "Execution records HTTP {status}: {}",
            read.text().await.unwrap()
        );
    }
    let page: Value = read.json().await.unwrap();
    assert_eq!(page["source_root_id"], INPUT);
    assert_eq!(page["threads"].as_array().unwrap().len(), 5);
    assert!(page["threads"][0].get("activations").is_none());
    for (parameters, status) in [
        (
            vec![
                ("thread_id", goal_thread.as_str()),
                ("root_turn_ids", "[\"foreign\"]"),
            ],
            403,
        ),
        (vec![("thread_id", "missing")], 404),
        (
            vec![
                ("thread_id", goal_thread.as_str()),
                ("root_turn_ids", "not-a-json-array"),
            ],
            400,
        ),
        (vec![("limit", "101")], 400),
        (vec![("principal_id", "other-human")], 403),
    ] {
        assert_eq!(
            client
                .get(&records_path)
                .bearer_auth("source-contract-token")
                .query(&parameters)
                .send()
                .await
                .unwrap()
                .status(),
            status
        );
    }
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
            "DELETE FROM schema_migrations WHERE version = '20261016_01_evaluation_results_timeline'",
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

// The inspector is tested against real Store/Runtime/SDK facts. Controlled
// application peers cannot prove SQL filtering-before-LIMIT or read purity.
async fn seed_execution_records(store: &dyn RuntimeStore) -> Vec<String> {
    use morphz::memory::{ExecutionRetrySafety, NewExecutionJob};
    let primary = stable_thread_id(&objective_primary_execution_root_id("goal", 1));
    let mut ids = vec![primary.clone(), "spawned-child".into()];
    for index in 0..11 {
        let id = format!("records-child-{index}");
        store
            .ensure_thread(thread(
                &id,
                &format!("records-root-{index}"),
                ThreadSupervision::attached(&primary, 1, "source-evaluation"),
            ))
            .await
            .unwrap();
        ids.push(id);
    }
    for index in 0..130 {
        let id = &ids[index % ids.len()];
        let root = store.get_thread(id).await.unwrap().unwrap().root_turn_id;
        let activation = format!("records-activation-{index}");
        store
            .ensure_thread_activation(NewThreadActivation {
                id: activation.clone(),
                agent_id: AGENT.into(),
                context_id: CONTEXT.into(),
                session_id: SESSION.into(),
                initiating_principal_id: Some(HUMAN.into()),
                trigger_event_id: format!("records-trigger-{index}"),
                trigger_sequence: index as u64 + 100,
                trigger_kind: "tool_result".into(),
                parent_activation_id: None,
                root_turn_id: root,
            })
            .await
            .unwrap();
        store
            .create_execution_job(NewExecutionJob {
                id: format!("records-job-{index:03}"),
                activation_id: activation,
                thread_id: id.clone(),
                agent_id: AGENT.into(),
                context_id: CONTEXT.into(),
                session_id: SESSION.into(),
                initiating_principal_id: Some(HUMAN.into()),
                target_id: "target-default".into(),
                tool_call_id: format!("records-call-{index}"),
                tool_name: "read".into(),
                request: json!({"path":"controlled-file","offset":index}),
                retry_safety: ExecutionRetrySafety::Idempotent,
                requires_approval: false,
            })
            .await
            .unwrap();
    }
    // Newer Jobs from another Principal would starve the visible page if the
    // SDK downloaded a bounded unfiltered page and filtered it afterwards.
    let mut foreign = thread(
        "foreign-records-thread",
        "foreign-records-root",
        ThreadSupervision::runtime("records-test"),
    );
    foreign.initiating_principal_id = Some("other-human".into());
    store.ensure_thread(foreign).await.unwrap();
    store
        .ensure_thread_activation(NewThreadActivation {
            id: "foreign-records-activation".into(),
            agent_id: AGENT.into(),
            context_id: CONTEXT.into(),
            session_id: SESSION.into(),
            initiating_principal_id: Some("other-human".into()),
            trigger_event_id: "foreign-records-trigger".into(),
            trigger_sequence: 500,
            trigger_kind: "tool_result".into(),
            parent_activation_id: None,
            root_turn_id: "foreign-records-root".into(),
        })
        .await
        .unwrap();
    for index in 0..140 {
        store
            .create_execution_job(NewExecutionJob {
                id: format!("foreign-job-{index:03}"),
                activation_id: "foreign-records-activation".into(),
                thread_id: "foreign-records-thread".into(),
                agent_id: AGENT.into(),
                context_id: CONTEXT.into(),
                session_id: SESSION.into(),
                initiating_principal_id: Some("other-human".into()),
                target_id: "target-default".into(),
                tool_call_id: format!("foreign-call-{index}"),
                tool_name: "read".into(),
                request: json!({"private":"other-principal"}),
                retry_safety: ExecutionRetrySafety::Idempotent,
                requires_approval: false,
            })
            .await
            .unwrap();
    }
    // An old running Job outside the newest display page must still determine
    // the real phase. Never infer phase from the displayed 100 records only.
    let claimed = store
        .claim_execution_job(
            "records-job-000",
            1,
            "controlled-worker",
            "controlled-token",
            chrono::Utc::now() + chrono::Duration::hours(1),
            None,
        )
        .await
        .unwrap();
    assert!(matches!(
        claimed,
        morphz::memory::ExecutionJobMutation::Updated(_)
    ));
    ids
}

async fn assert_execution_records(
    runtime: &MorphzRuntime,
    store: &dyn RuntimeStore,
    ids: &[String],
) {
    use morphz::{
        memory::ExecutionJobFilter,
        runtime::ExecutionRecordsQuery,
        sdk::{ExecutionJobQuery, MorphzSdk, SdkErrorCode},
    };
    let sdk = MorphzSdk::new(runtime.clone());
    let before = store
        .list_execution_jobs(ExecutionJobFilter {
            context_id: Some(CONTEXT.into()),
            include_terminal: true,
            ..Default::default()
        })
        .await
        .unwrap();
    let query = ExecutionRecordsQuery {
        thread_id: Some(ids[0].clone()),
        root_turn_ids: vec![INPUT.into()],
        include_descendants: true,
        limit: Some(100),
        ..Default::default()
    };
    let page = sdk
        .session_execution_records(HUMAN, SESSION, query.clone())
        .await
        .unwrap();
    assert_eq!(page.jobs.len(), 100);
    assert!(page.has_more_jobs);
    let family = store
        .read_thread_family_bounded(CONTEXT, SESSION, &ids[0], 64)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(page.threads.len(), family.threads.len());
    assert!(ids
        .iter()
        .all(|id| page.threads.iter().any(|thread| &thread.id == id)));
    assert_eq!(page.source_root_id.as_deref(), Some(INPUT));
    assert!(page
        .jobs
        .iter()
        .all(|job| job.id.starts_with("records-job-")));
    assert_eq!(page.jobs[0].id, "records-job-129");
    assert_eq!(page.jobs[99].id, "records-job-030");
    assert!(!page.jobs.iter().any(|job| job.id == "records-job-000"));
    assert_eq!(page.threads[0].phase, morphz::memory::ThreadPhase::Running);
    assert_eq!(
        page.threads[0].intent.as_deref(),
        Some("Synthetic autonomous source contract")
    );
    assert!(page
        .threads
        .iter()
        .all(|t| t.response_annotations.is_none()));
    let wire = serde_json::to_value(&page).unwrap();
    let encoded = serde_json::to_string(&wire).unwrap();
    assert!(!encoded.contains("model_attempt_events"));
    assert!(!encoded.contains("pending_signals"));
    assert!(wire["threads"][0].get("activations").is_none());
    assert!(
        encoded.len() < 200_000,
        "compact 100-Job page must not contain full histories"
    );
    let metadata = sdk
        .session_execution_records(
            HUMAN,
            SESSION,
            ExecutionRecordsQuery {
                metadata_only: true,
                ..query.clone()
            },
        )
        .await
        .unwrap();
    assert!(metadata.jobs.is_empty());
    assert!(metadata
        .threads
        .iter()
        .all(|t| t.response_annotations.is_none()));
    let scoped = sdk
        .session_execution_records(
            HUMAN,
            SESSION,
            ExecutionRecordsQuery {
                thread_ids: vec![ids[1].clone()],
                limit: Some(3),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(scoped.jobs.len(), 3);
    assert!(scoped.jobs.iter().all(|job| job.thread_id == ids[1]));
    let root = store
        .get_thread(&ids[1])
        .await
        .unwrap()
        .unwrap()
        .root_turn_id;
    let by_root = sdk
        .session_execution_records(
            HUMAN,
            SESSION,
            ExecutionRecordsQuery {
                root_turn_ids: vec![root.clone()],
                limit: Some(3),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        by_root.jobs.len(),
        3,
        "root predicate precedes LIMIT despite newer unrelated Jobs"
    );
    assert_eq!(
        by_root.jobs.iter().map(|job| &job.id).collect::<Vec<_>>(),
        scoped.jobs.iter().map(|job| &job.id).collect::<Vec<_>>()
    );
    let physical = sdk
        .list_execution_jobs(
            HUMAN,
            ExecutionJobQuery {
                context_id: Some(CONTEXT.into()),
                session_id: Some(SESSION.into()),
                thread_ids: vec![ids[1].clone()],
                root_turn_ids: vec![root],
                include_terminal: true,
                newest_first: true,
                limit: Some(3),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(physical.len(), 3);
    assert!(physical
        .iter()
        .all(|job| job.initiating_principal_id.as_deref() == Some(HUMAN)));
    assert_eq!(
        sdk.session_execution_records("other-human", SESSION, query.clone())
            .await
            .unwrap_err()
            .code,
        SdkErrorCode::Forbidden
    );
    assert_eq!(
        sdk.session_execution_records(
            HUMAN,
            SESSION,
            ExecutionRecordsQuery {
                root_turn_ids: vec!["forged-input".into()],
                ..query.clone()
            }
        )
        .await
        .unwrap_err()
        .code,
        SdkErrorCode::Forbidden
    );
    assert_eq!(
        sdk.session_execution_records(
            HUMAN,
            SESSION,
            ExecutionRecordsQuery {
                thread_id: Some("missing".into()),
                ..query.clone()
            }
        )
        .await
        .unwrap_err()
        .code,
        SdkErrorCode::NotFound
    );
    for invalid in [
        ExecutionRecordsQuery {
            limit: Some(0),
            ..Default::default()
        },
        ExecutionRecordsQuery {
            limit: Some(101),
            ..Default::default()
        },
        ExecutionRecordsQuery {
            thread_ids: vec!["id".into(); 101],
            ..Default::default()
        },
        ExecutionRecordsQuery {
            root_turn_ids: vec!["id".into(); 1025],
            ..Default::default()
        },
        ExecutionRecordsQuery {
            thread_id: Some(String::new()),
            ..Default::default()
        },
        ExecutionRecordsQuery {
            thread_id: Some(ids[0].clone()),
            thread_ids: vec![ids[1].clone()],
            ..Default::default()
        },
        ExecutionRecordsQuery {
            include_descendants: true,
            ..Default::default()
        },
    ] {
        assert_eq!(
            sdk.session_execution_records(HUMAN, SESSION, invalid)
                .await
                .unwrap_err()
                .code,
            SdkErrorCode::InvalidArgument
        );
    }
    let after = store
        .list_execution_jobs(ExecutionJobFilter {
            context_id: Some(CONTEXT.into()),
            include_terminal: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(before).unwrap(),
        serde_json::to_value(after).unwrap(),
        "reads may not revise, cancel, reclaim or wake any in-flight Job"
    );
}

#[tokio::test]
async fn sqlite_execution_records_are_bounded_filtered_before_limit_and_read_only() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(
        SqliteStore::new(directory.path().join("records.sqlite").to_str().unwrap())
            .await
            .unwrap(),
    );
    seed(store.as_ref()).await;
    let ids = seed_execution_records(store.as_ref()).await;
    let runtime = runtime(store.clone(), directory.path()).await;
    assert_execution_records(&runtime, store.as_ref(), &ids).await;
}

#[tokio::test]
async fn sqlite_execution_reader_index_is_added_after_legacy_principal_column_on_cold_reopen() {
    use sqlx::Row;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("legacy-records.sqlite");
    drop(SqliteStore::new(path.to_str().unwrap()).await.unwrap());
    let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}", path.display()))
        .await
        .unwrap();
    sqlx::query("DROP INDEX idx_execution_jobs_reader_history")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("ALTER TABLE execution_jobs DROP COLUMN initiating_principal_id")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    drop(SqliteStore::new(path.to_str().unwrap()).await.unwrap());
    let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}", path.display()))
        .await
        .unwrap();
    let index = sqlx::query("PRAGMA index_info(idx_execution_jobs_reader_history)")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(
        index
            .into_iter()
            .map(|row| row.get::<String, _>("name"))
            .collect::<Vec<_>>(),
        [
            "session_id",
            "context_id",
            "initiating_principal_id",
            "created_at",
            "id"
        ]
    );
    let plan = sqlx::query("EXPLAIN QUERY PLAN SELECT * FROM execution_jobs WHERE thread_id IN ('a','b') ORDER BY created_at DESC, id DESC LIMIT 101")
        .fetch_all(&pool).await.unwrap();
    assert!(
        plan.iter().any(|row| row
            .get::<String, _>("detail")
            .contains("idx_execution_jobs_thread_history")),
        "Thread history must use its bounded indexed lookup, not scan the global Job table"
    );
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires an explicitly prepared dedicated PostgreSQL test database"]
async fn postgres_execution_records_are_bounded_filtered_before_limit_and_read_only() {
    let database_url =
        std::env::var("MORPHZ_TEST_POSTGRES_URL").expect("dedicated PostgreSQL URL required");
    let schema = format!(
        "morphz_records_{}_{}",
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
    let store = Arc::new(PostgresStore::new(&scoped, 4).await.unwrap());
    seed(store.as_ref()).await;
    let ids = seed_execution_records(store.as_ref()).await;
    assert_execution_records(
        &runtime(store.clone(), directory.path()).await,
        store.as_ref(),
        &ids,
    )
    .await;
    store.pool().close().await;
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}
