use chrono::{Duration, Utc};
use morphz::event::Event;
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{
    ActivationOutcomeCommit, ActivationStore as _, EventStore as _, NewAgent, NewCognitiveContext,
    NewObjective, NewSession, NewThread, NewThreadActivation, NewThreadGroup, NewThreadGroupMember,
    NewThreadGroupPlan, ObjectiveStore as _, ScheduleStore as _, SessionDirectoryStore as _,
    SessionMountKind, ThreadActivationMutation, ThreadActivationStatus, ThreadGroupPolicy,
    ThreadKind, ThreadStore as _, ThreadSupervision, ThreadSupervisorKind,
};
use serde_json::json;
use tempfile::NamedTempFile;

#[tokio::test]
async fn objective_group_terminal_commit_returns_its_durable_supervisor_wake() {
    let database = NamedTempFile::new().unwrap();
    let store = SqliteStore::new(database.path().to_str().unwrap())
        .await
        .unwrap();
    store
        .create_agent_bundle(
            NewAgent {
                id: "objective-handoff-agent".to_string(),
                title: "Objective handoff".to_string(),
                root_context_id: "objective-handoff-context".to_string(),
            },
            NewCognitiveContext {
                id: "objective-handoff-context".to_string(),
                agent_id: "objective-handoff-agent".to_string(),
                title: "Objective handoff".to_string(),
            },
            NewSession {
                id: "objective-handoff-session".to_string(),
                agent_id: "objective-handoff-agent".to_string(),
                context_id: "objective-handoff-context".to_string(),
                parent_session_id: None,
                title: "Objective handoff".to_string(),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await
        .unwrap();
    let objective = store
        .create_objective(NewObjective {
            id: "objective-handoff".to_string(),
            agent_id: "objective-handoff-agent".to_string(),
            context_id: "objective-handoff-context".to_string(),
            coordinator_session_id: "objective-handoff-session".to_string(),
            delivery_session_id: "objective-handoff-session".to_string(),
            parent_objective_id: None,
            source_event_id: "objective-handoff-source".to_string(),
            initiating_principal_id: None,
            stated_objective: "resume after the group barrier".to_string(),
            token_budget: None,
        })
        .await
        .unwrap();
    let group_id = "objective-handoff-group";
    let thread_id = "objective-handoff-child";
    let root_turn_id = "objective-handoff-child-root";
    let mut supervision = ThreadSupervision::objective(
        objective.id.clone(),
        "objective-handoff-evaluation".to_string(),
        objective.generation,
        None,
    );
    supervision.thread_group_id = Some(group_id.to_string());
    store
        .commit_schedule_transaction(
            &[],
            &[],
            &[NewThread {
                id: thread_id.to_string(),
                agent_id: objective.agent_id.clone(),
                context_id: objective.context_id.clone(),
                session_id: objective.coordinator_session_id.clone(),
                initiating_principal_id: None,
                root_turn_id: root_turn_id.to_string(),
                kind: ThreadKind::Execution,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision,
            }],
            &[],
            &[NewThreadGroupPlan {
                group: NewThreadGroup {
                    id: group_id.to_string(),
                    context_id: objective.context_id.clone(),
                    session_id: objective.coordinator_session_id.clone(),
                    supervisor_kind: ThreadSupervisorKind::Objective,
                    supervisor_id: objective.id.clone(),
                    generation: objective.generation,
                    policy: ThreadGroupPolicy::All,
                    completion_contract: json!({}),
                },
                members: vec![NewThreadGroupMember {
                    thread_id: thread_id.to_string(),
                    ordinal: 0,
                    required: true,
                }],
            }],
        )
        .await
        .unwrap();

    let trigger = Event::new(
        "objective-handoff-trigger".to_string(),
        "fixture".to_string(),
        "runtime_control".to_string(),
        "runtime/test".to_string(),
        serde_json::Map::from_iter([
            ("context_id".to_string(), json!(objective.context_id)),
            (
                "session_id".to_string(),
                json!(objective.coordinator_session_id),
            ),
            ("root_turn_id".to_string(), json!(root_turn_id)),
        ]),
    );
    store.append(trigger.clone()).await.unwrap();
    let trigger_sequence = store
        .query(morphz::memory::QueryFilter {
            event_id: Some(trigger.id.clone()),
            ..Default::default()
        })
        .await
        .unwrap()[0]
        .sequence
        .unwrap();
    let activation = store
        .ensure_thread_activation(NewThreadActivation {
            id: "objective-handoff-activation".to_string(),
            agent_id: objective.agent_id.clone(),
            context_id: objective.context_id.clone(),
            session_id: objective.coordinator_session_id.clone(),
            initiating_principal_id: None,
            trigger_event_id: trigger.id,
            trigger_sequence,
            trigger_kind: trigger.topic,
            parent_activation_id: None,
            root_turn_id: root_turn_id.to_string(),
        })
        .await
        .unwrap();
    let running = match store
        .update_thread_activation(
            &activation.id,
            activation.revision,
            ThreadActivationStatus::Running,
            Some("objective-handoff-worker"),
            Some(Utc::now() + Duration::minutes(5)),
            None,
        )
        .await
        .unwrap()
    {
        ThreadActivationMutation::Updated(running) => running,
        mutation => panic!("unexpected activation claim: {mutation:?}"),
    };
    let terminal = Event::new(
        "objective-handoff-terminal".to_string(),
        "fixture".to_string(),
        "agent_call".to_string(),
        "runtime/thread_result".to_string(),
        serde_json::Map::from_iter([
            ("context_id".to_string(), json!(objective.context_id)),
            (
                "session_id".to_string(),
                json!(objective.coordinator_session_id),
            ),
            ("thread_id".to_string(), json!(thread_id)),
            ("root_turn_id".to_string(), json!(root_turn_id)),
            ("activation_id".to_string(), json!(running.id)),
            ("disposition".to_string(), json!("no_reply")),
            ("terminal_kind".to_string(), json!("completed")),
            ("text".to_string(), json!("child complete")),
        ]),
    );
    let barrier_id = format!("thread_group_barrier_{group_id}_g1");
    assert_eq!(
        store
            .commit_activation_outcome(&running.id, &terminal)
            .await
            .unwrap(),
        ActivationOutcomeCommit::Committed {
            ready_signal_event_ids: Vec::new(),
            ready_supervisor_event_ids: vec![barrier_id.clone()],
        }
    );
    let stored = store
        .query(morphz::memory::QueryFilter {
            event_id: Some(barrier_id.clone()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].topic, "runtime/thread_group_terminal");
    assert_eq!(stored[0].payload["objective_id"], objective.id);

    let direct_thread_id = "objective-handoff-direct-child";
    let direct_root_turn_id = "objective-handoff-direct-root";
    store
        .ensure_thread(NewThread {
            id: direct_thread_id.to_string(),
            agent_id: objective.agent_id.clone(),
            context_id: objective.context_id.clone(),
            session_id: objective.coordinator_session_id.clone(),
            initiating_principal_id: None,
            root_turn_id: direct_root_turn_id.to_string(),
            kind: ThreadKind::Execution,
            executor_kind: "self".to_string(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::objective(
                objective.id.clone(),
                "objective-handoff-direct-evaluation",
                objective.generation,
                None,
            ),
        })
        .await
        .unwrap();
    let direct_trigger = Event::new(
        "objective-handoff-direct-trigger".to_string(),
        "fixture".to_string(),
        "runtime_control".to_string(),
        "runtime/test".to_string(),
        serde_json::Map::from_iter([
            ("context_id".to_string(), json!(objective.context_id)),
            (
                "session_id".to_string(),
                json!(objective.coordinator_session_id),
            ),
            ("root_turn_id".to_string(), json!(direct_root_turn_id)),
        ]),
    );
    store.append(direct_trigger.clone()).await.unwrap();
    let direct_trigger_sequence = store
        .query(morphz::memory::QueryFilter {
            event_id: Some(direct_trigger.id.clone()),
            ..Default::default()
        })
        .await
        .unwrap()[0]
        .sequence
        .unwrap();
    let direct_activation = store
        .ensure_thread_activation(NewThreadActivation {
            id: "objective-handoff-direct-activation".to_string(),
            agent_id: objective.agent_id.clone(),
            context_id: objective.context_id.clone(),
            session_id: objective.coordinator_session_id.clone(),
            initiating_principal_id: None,
            trigger_event_id: direct_trigger.id,
            trigger_sequence: direct_trigger_sequence,
            trigger_kind: direct_trigger.topic,
            parent_activation_id: None,
            root_turn_id: direct_root_turn_id.to_string(),
        })
        .await
        .unwrap();
    let direct_running = match store
        .update_thread_activation(
            &direct_activation.id,
            direct_activation.revision,
            ThreadActivationStatus::Running,
            Some("objective-handoff-worker"),
            Some(Utc::now() + Duration::minutes(5)),
            None,
        )
        .await
        .unwrap()
    {
        ThreadActivationMutation::Updated(running) => running,
        mutation => panic!("unexpected direct activation claim: {mutation:?}"),
    };
    let direct_terminal = Event::new(
        "objective-handoff-direct-terminal".to_string(),
        "fixture".to_string(),
        "agent_call".to_string(),
        "runtime/thread_result".to_string(),
        serde_json::Map::from_iter([
            ("context_id".to_string(), json!(objective.context_id)),
            (
                "session_id".to_string(),
                json!(objective.coordinator_session_id),
            ),
            ("thread_id".to_string(), json!(direct_thread_id)),
            ("root_turn_id".to_string(), json!(direct_root_turn_id)),
            ("activation_id".to_string(), json!(direct_running.id)),
            ("disposition".to_string(), json!("no_reply")),
            ("terminal_kind".to_string(), json!("completed")),
            ("text".to_string(), json!("direct child complete")),
        ]),
    );
    let direct_barrier_id = format!("thread_terminal_{direct_thread_id}_g1");
    assert_eq!(
        store
            .commit_activation_outcome(&direct_running.id, &direct_terminal)
            .await
            .unwrap(),
        ActivationOutcomeCommit::Committed {
            ready_signal_event_ids: Vec::new(),
            ready_supervisor_event_ids: vec![direct_barrier_id.clone()],
        }
    );
    let direct_barrier = store
        .query(morphz::memory::QueryFilter {
            event_id: Some(direct_barrier_id),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(direct_barrier.len(), 1);
    assert_eq!(direct_barrier[0].topic, "runtime/thread_terminal");
    assert_eq!(direct_barrier[0].payload["objective_id"], objective.id);
}
