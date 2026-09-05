use super::*;

pub async fn assert_interrupt_frontier<
    S: ObjectiveStore + SchedulerDependencyStore + EventStore,
>(
    store: &S,
) {
    let objective = store
        .create_objective(NewObjective {
            id: "conformance-interrupt-frontier".into(),
            agent_id: "conformance-agent".into(),
            context_id: "conformance-context".into(),
            coordinator_session_id: "conformance-session".into(),
            delivery_session_id: "conformance-session".into(),
            parent_objective_id: None,
            source_event_id: "frontier-source".into(),
            initiating_principal_id: None,
            stated_objective: "preserve the exact wait across continuation".into(),
            token_budget: None,
        })
        .await
        .unwrap();
    let ObjectiveMutation::Updated(waiting) = store
        .update_objective_state(
            &objective.id,
            objective.revision,
            ObjectiveStatus::Active,
            Some(ObjectiveWaitCondition::ResourceAvailable {
                resource: "frontier-ready".into(),
            }),
            Some("wait for resource"),
        )
        .await
        .unwrap()
    else {
        panic!("wait")
    };
    let dependency = store
        .list_scheduler_dependencies(SchedulerDependencyFilter {
            owner_kind: Some(SchedulerDependencyOwnerKind::Objective),
            owner_id: Some(objective.id.clone()),
            status: Some(SchedulerDependencyStatus::Pending),
            ..Default::default()
        })
        .await
        .unwrap()
        .pop()
        .unwrap();
    let lease = chrono::Utc::now() + chrono::Duration::minutes(5);
    assert!(matches!(
        store
            .claim_objective_interrupt_evaluation(
                &objective.id,
                waiting.revision,
                "frontier-evaluation",
                lease,
                &dependency.id
            )
            .await
            .unwrap(),
        ObjectiveMutation::Updated(_)
    ));
    let renew = || {
        store.renew_objective_interrupt_evaluation(
            &objective.id,
            "frontier-evaluation",
            lease,
            &dependency.id,
        )
    };
    assert!(matches!(
        renew().await.unwrap(),
        ObjectiveMutation::Updated(_)
    ));
    let competing = NewSchedulerDependency {
        id: "frontier-competing".into(),
        owner_kind: dependency.owner_kind,
        owner_id: dependency.owner_id.clone(),
        owner_generation: dependency.owner_generation,
        dependency_kind: SchedulerDependencyKind::Resource,
        dependency_id: "different-resource".into(),
        dependency_generation: 1,
        required: true,
        metadata: json!({}),
    };
    store
        .register_scheduler_dependency(competing.clone())
        .await
        .unwrap();
    assert!(
        matches!(renew().await.unwrap(), ObjectiveMutation::Conflict { .. }),
        "a new pending dependency must fence the old interrupt"
    );
    let evidence = context_event("frontier-satisfied", "conformance-context");
    store.append(evidence.clone()).await.unwrap();
    store
        .satisfy_scheduler_dependency(
            &competing.id,
            competing.owner_generation,
            competing.dependency_generation,
            &evidence.id,
        )
        .await
        .unwrap();
    assert!(matches!(
        renew().await.unwrap(),
        ObjectiveMutation::Updated(_)
    ));
    store
        .satisfy_scheduler_dependency(
            &dependency.id,
            dependency.owner_generation,
            dependency.dependency_generation,
            &evidence.id,
        )
        .await
        .unwrap();
    assert!(
        matches!(renew().await.unwrap(), ObjectiveMutation::Conflict { .. }),
        "satisfied edge without cleared wait is not sufficient"
    );
    let current = store.get_objective(&objective.id).await.unwrap().unwrap();
    let ObjectiveMutation::Updated(ready) = store
        .update_objective_state(
            &current.id,
            current.revision,
            ObjectiveStatus::Active,
            None,
            Some("exact wait settled"),
        )
        .await
        .unwrap()
    else {
        panic!("ready")
    };
    assert!(
        matches!(renew().await.unwrap(), ObjectiveMutation::Updated(_)),
        "legitimate completion of the same wait must permit continuation"
    );
    assert!(matches!(
        store
            .renew_objective_interrupt_evaluation(
                &objective.id,
                "stale-evaluation",
                lease,
                &dependency.id
            )
            .await
            .unwrap(),
        ObjectiveMutation::Conflict { .. }
    ));
    assert!(matches!(
        store
            .renew_objective_interrupt_evaluation(
                &objective.id,
                "frontier-evaluation",
                lease,
                "missing-dependency"
            )
            .await
            .unwrap(),
        ObjectiveMutation::Conflict { .. }
    ));
    store
        .update_objective_state(
            &ready.id,
            ready.revision,
            ObjectiveStatus::Paused,
            None,
            Some("operator paused"),
        )
        .await
        .unwrap();
    assert!(
        matches!(renew().await.unwrap(), ObjectiveMutation::Conflict { .. }),
        "pause/generation change must retain ownership fencing"
    );
}
