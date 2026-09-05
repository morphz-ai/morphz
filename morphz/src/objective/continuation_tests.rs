use super::*;
use crate::memory::{sqlite::SqliteStore, *};
use crate::scheduler::{NewSchedulerDependency, SchedulerDependencyKind};

async fn fixture() -> (
    tempfile::NamedTempFile,
    Arc<SqliteStore>,
    Arc<ObjectiveSupervisor>,
    ActiveObjectiveEvaluation,
) {
    let file = tempfile::NamedTempFile::new().unwrap();
    let store = Arc::new(
        SqliteStore::new(&file.path().to_string_lossy())
            .await
            .unwrap(),
    );
    store
        .create_agent_bundle(
            NewAgent {
                id: "agent-route".into(),
                title: "Route".into(),
                root_context_id: "context-route".into(),
            },
            NewCognitiveContext {
                id: "context-route".into(),
                agent_id: "agent-route".into(),
                title: "Route".into(),
            },
            NewSession {
                id: "session-route".into(),
                agent_id: "agent-route".into(),
                context_id: "context-route".into(),
                parent_session_id: None,
                title: "Route".into(),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await
        .unwrap();
    let objective = store
        .create_objective(NewObjective {
            id: "objective-route".into(),
            agent_id: "agent-route".into(),
            context_id: "context-route".into(),
            coordinator_session_id: "session-route".into(),
            delivery_session_id: "session-route".into(),
            parent_objective_id: None,
            source_event_id: "source-route".into(),
            initiating_principal_id: None,
            stated_objective: "Replace cancelled children and continue".into(),
            token_budget: None,
        })
        .await
        .unwrap();
    let ObjectiveMutation::Updated(waiting) = store
        .update_objective_state(
            &objective.id,
            objective.revision,
            ObjectiveStatus::Active,
            Some(ObjectiveWaitCondition::Timer {
                deadline: Utc::now() + Duration::hours(1),
            }),
            Some("pending wait"),
        )
        .await
        .unwrap()
    else {
        panic!("wait not installed")
    };
    let dependencies = store
        .list_scheduler_dependencies(SchedulerDependencyFilter {
            owner_kind: Some(SchedulerDependencyOwnerKind::Objective),
            owner_id: Some(objective.id.clone()),
            required_only: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(dependencies.len(), 1);
    let ObjectiveMutation::Updated(claimed) = store
        .claim_objective_interrupt_evaluation(
            &waiting.id,
            waiting.revision,
            "evaluation-route",
            Utc::now() + Duration::seconds(20),
            &dependencies[0].id,
        )
        .await
        .unwrap()
    else {
        panic!("interrupt not claimed")
    };
    let binding = ActiveObjectiveEvaluation {
        objective_id: claimed.id,
        evaluation_id: "evaluation-route".into(),
        revision: claimed.revision,
        started_at: Utc::now(),
        pending_dependency_id: Some(dependencies[0].id.clone()),
    };
    let supervisor = Arc::new(
        ObjectiveSupervisor::new(
            store.clone(),
            store.clone(),
            Arc::new(InMemoryEventBus::new()),
            Arc::new(ObjectiveEvaluationRegistry::default()),
            Arc::new(TimerEngine::new(store.clone())),
            std::time::Duration::from_secs(90),
        )
        .with_scheduler_dependency_store(store.clone()),
    );
    (file, store, supervisor, binding)
}

fn tool_successor(binding: &ActiveObjectiveEvaluation, ordinal: usize) -> Event {
    let mut event = Event::new(
        format!("tool-output-{ordinal}"),
        "Runtime".into(),
        TYPE_TOOL_OUTPUT.into(),
        "chat/tool_output".into(),
        serde_json::Map::new(),
    );
    binding.stamp_route(&mut event.payload);
    // Round-trip through durable Event JSON; no process-local registry fallback.
    serde_json::from_str(&serde_json::to_string(&event).unwrap()).unwrap()
}

#[tokio::test]
async fn interrupt_tool_continuations_preserve_exact_wait_across_admission_and_heartbeats() {
    let (_file, store, supervisor, binding) = fixture().await;
    let initial_lease = store
        .get_objective(&binding.objective_id)
        .await
        .unwrap()
        .unwrap()
        .evaluation_lease_expires_at
        .unwrap();
    for ordinal in 0..4 {
        let event = tool_successor(&binding, ordinal);
        let restored = ActiveObjectiveEvaluation::from_event(&event).unwrap();
        assert_eq!(restored, binding);
        let activation = format!("activation-{ordinal}");
        supervisor
            .evaluations
            .bind_activation(&activation, restored);
        assert!(supervisor
            .admit_routed_evaluation(
                &binding.objective_id,
                &binding.evaluation_id,
                false,
                &activation
            )
            .await
            .unwrap());
    }
    let admitted = store
        .get_objective(&binding.objective_id)
        .await
        .unwrap()
        .unwrap();
    assert!(
        admitted.evaluation_lease_expires_at.unwrap() > initial_lease + Duration::seconds(60),
        "short continuation must renew below half-lease before model work"
    );
    // Advance the actual heartbeat driver's clock, not random sleeps. Poll
    // it explicitly so SQLite IO cannot auto-advance virtual time indefinitely.
    tokio::time::pause();
    // SQLx connection acquisition also uses Tokio deadlines. Keep virtual
    // time under explicit test control while the SQLite worker performs IO.
    let mut clock_guard = tokio::task::JoinSet::new();
    clock_guard.spawn(async {
        loop {
            tokio::task::yield_now().await;
        }
    });
    let heartbeat = supervisor.maintain_activation_lease("activation-3");
    tokio::pin!(heartbeat);
    assert!(futures_util::poll!(heartbeat.as_mut()).is_pending());
    for _ in 0..3 {
        let before = store
            .get_objective(&binding.objective_id)
            .await
            .unwrap()
            .unwrap()
            .evaluation_lease_expires_at;
        for _ in 0..120 {
            tokio::time::advance(std::time::Duration::from_secs(1)).await;
            assert!(
                futures_util::poll!(heartbeat.as_mut()).is_pending(),
                "valid interrupt must not lose its lease"
            );
            let after = store
                .get_objective(&binding.objective_id)
                .await
                .unwrap()
                .unwrap()
                .evaluation_lease_expires_at;
            if after > before {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(
            store
                .get_objective(&binding.objective_id)
                .await
                .unwrap()
                .unwrap()
                .evaluation_lease_expires_at
                > before,
            "heartbeat must write a renewal"
        );
    }
    tokio::time::resume();
    clock_guard.abort_all();
    assert_eq!(
        store
            .get_scheduler_dependency(binding.pending_dependency_id.as_deref().unwrap())
            .await
            .unwrap()
            .unwrap()
            .status,
        SchedulerDependencyStatus::Pending
    );
}

#[tokio::test]
async fn interrupt_continuations_reject_missing_cancelled_competing_and_stale_routes() {
    for invalid in [
        "absent",
        "missing",
        "cancelled",
        "competing",
        "evaluation",
        "generation",
    ] {
        let (_file, store, supervisor, mut binding) = fixture().await;
        let dependency = store
            .get_scheduler_dependency(binding.pending_dependency_id.as_deref().unwrap())
            .await
            .unwrap()
            .unwrap();
        store
            .renew_objective_interrupt_evaluation(
                &binding.objective_id,
                &binding.evaluation_id,
                Utc::now() + Duration::seconds(90),
                &dependency.id,
            )
            .await
            .unwrap();
        match invalid {
            "absent" => binding.pending_dependency_id = None,
            "missing" => binding.pending_dependency_id = Some("missing-dependency".into()),
            "cancelled" => {
                store
                    .cancel_scheduler_dependencies(
                        SchedulerDependencyOwnerKind::Objective,
                        &binding.objective_id,
                        dependency.owner_generation,
                    )
                    .await
                    .unwrap();
            }
            "competing" => {
                store
                    .register_scheduler_dependency(NewSchedulerDependency {
                        id: "competing-dependency".into(),
                        owner_kind: dependency.owner_kind,
                        owner_id: dependency.owner_id.clone(),
                        owner_generation: dependency.owner_generation,
                        dependency_kind: SchedulerDependencyKind::Thread,
                        dependency_id: "other-thread".into(),
                        dependency_generation: 1,
                        required: true,
                        metadata: json!({}),
                    })
                    .await
                    .unwrap();
            }
            "evaluation" => binding.evaluation_id = "stale-evaluation".into(),
            "generation" => {
                let current = store
                    .get_objective(&binding.objective_id)
                    .await
                    .unwrap()
                    .unwrap();
                store
                    .update_objective_state(
                        &current.id,
                        current.revision,
                        ObjectiveStatus::Paused,
                        None,
                        Some("operator pause"),
                    )
                    .await
                    .unwrap();
            }
            _ => unreachable!(),
        }
        supervisor
            .evaluations
            .bind_activation("stale-continuation", binding.clone());
        assert!(
            !supervisor
                .admit_routed_evaluation(
                    &binding.objective_id,
                    &binding.evaluation_id,
                    false,
                    "stale-continuation"
                )
                .await
                .unwrap(),
            "{invalid}"
        );
        assert!(
            matches!(
                supervisor
                    .renew_objective_evaluation(
                        &binding.objective_id,
                        &binding.evaluation_id,
                        Utc::now() + Duration::seconds(90),
                        binding.pending_dependency_id.as_deref(),
                        "stale-continuation"
                    )
                    .await
                    .unwrap(),
                ObjectiveMutation::Conflict { .. }
            ),
            "{invalid}"
        );
    }
}
