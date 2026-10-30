use super::tests::seed_objective_bundle;
use super::*;
use crate::memory::{sqlite::SqliteStore, *};
use crate::model_selection::ModelSelection;

struct Fixture {
    supervisor: Arc<ObjectiveSupervisor>,
    store: Arc<SqliteStore>,
    objective: ObjectiveRecord,
    thread: ThreadRecord,
    failure: Event,
    database: crate::test_sqlite::TempSqliteDb,
}

fn supervisor(store: &Arc<SqliteStore>) -> Arc<ObjectiveSupervisor> {
    Arc::new(
        ObjectiveSupervisor::new(
            store.clone(),
            store.clone(),
            Arc::new(InMemoryEventBus::new()),
            Arc::new(ObjectiveEvaluationRegistry::default()),
            Arc::new(TimerEngine::new(store.clone())),
            std::time::Duration::from_secs(600),
        )
        .with_thread_store(store.clone())
        .with_session_store(store.clone())
        .with_activation_store(store.clone())
        .with_scheduler_dependency_store(store.clone())
        .with_scheduler_kernel(Arc::new(SchedulerKernel::new(store.clone()))),
    )
}

impl Fixture {
    async fn new() -> Self {
        Self::with_overrides(true).await
    }

    async fn with_overrides(explicit: bool) -> Self {
        let database = crate::test_sqlite::TempSqliteDb::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(database.path().to_str().unwrap())
                .await
                .unwrap(),
        );
        let created = seed_objective_bundle(&store, "thread-policy").await;
        let evaluation_id = "policy-evaluation";
        let ObjectiveMutation::Updated(objective) = store
            .claim_objective_evaluation(
                &created.id,
                created.revision,
                evaluation_id,
                Utc::now() + Duration::minutes(10),
            )
            .await
            .unwrap()
        else {
            panic!("claim must succeed")
        };
        let root = objective_primary_execution_root_id(&objective.id, objective.generation);
        let thread = store
            .ensure_thread(NewThread {
                response_annotations: Default::default(),
                model_alias: explicit.then(|| "old-route".into()),
                reasoning_effort: explicit.then(|| "max".into()),
                id: stable_thread_id(&root),
                agent_id: objective.agent_id.clone(),
                context_id: objective.context_id.clone(),
                session_id: objective.coordinator_session_id.clone(),
                initiating_principal_id: objective.initiating_principal_id.clone(),
                root_turn_id: root.clone(),
                kind: ThreadKind::Execution,
                executor_kind: "self".into(),
                executor_id: None,
                target_id: None,
                supervision: ThreadSupervision::objective_primary_execution(
                    &objective.id,
                    objective.generation,
                ),
            })
            .await
            .unwrap();
        let trigger = Event::new(
            root.clone(),
            "Runtime-ObjectiveSupervisor".into(),
            TYPE_TOOL_OUTPUT.into(),
            "chat/tool_output".into(),
            json!({
                "context_id": objective.context_id, "session_id": objective.coordinator_session_id,
                "objective_id": objective.id, "objective_evaluation_id": evaluation_id,
                "objective_revision": objective.revision, "root_turn_id": root,
                "thread_id": thread.id, "principal_id": objective.initiating_principal_id,
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        store.append(trigger.clone()).await.unwrap();
        let trigger = store
            .query(QueryFilter {
                event_id: Some(trigger.id),
                ..Default::default()
            })
            .await
            .unwrap()
            .remove(0);
        let activation = store
            .ensure_thread_activation(NewThreadActivation {
                id: "policy-activation".into(),
                agent_id: objective.agent_id.clone(),
                context_id: objective.context_id.clone(),
                session_id: objective.coordinator_session_id.clone(),
                initiating_principal_id: objective.initiating_principal_id.clone(),
                trigger_event_id: trigger.id,
                trigger_sequence: trigger.sequence.unwrap(),
                trigger_kind: TYPE_TOOL_OUTPUT.into(),
                parent_activation_id: None,
                root_turn_id: root.clone(),
            })
            .await
            .unwrap();
        let session = store
            .get_session(&objective.coordinator_session_id)
            .await
            .unwrap()
            .unwrap();
        let failure = Event::new("policy-request-failure".into(), "Agent-Morphz".into(),
            "agent_call".into(), "chat/no_reply".into(), json!({
                "context_id": objective.context_id, "session_id": objective.coordinator_session_id,
                "objective_id": objective.id, "objective_evaluation_id": evaluation_id,
                "objective_revision": objective.revision, "root_turn_id": root,
                "thread_id": thread.id, "thread_generation": thread.generation,
                "activation_id": activation.id, "runtime_failure_kind": "provider_configuration",
                "runtime_failure_stage": "llm_completion", "wait_resource": MODEL_CONFIGURATION_RESOURCE,
                "thread_evaluation_policy_revision": null,
                "session_evaluation_policy": crate::model_selection::SessionEvaluationSnapshot::new(
                    session.model_alias.as_deref(), session.reasoning_effort.as_deref(), !explicit, !explicit),
            }).as_object().unwrap().clone());
        Self {
            supervisor: supervisor(&store),
            store,
            objective,
            thread,
            failure,
            database,
        }
    }

    async fn clear_policy(&self) -> u64 {
        let current = self
            .store
            .get_thread(&self.thread.id)
            .await
            .unwrap()
            .unwrap();
        let ThreadMutation::Updated(updated) = self
            .store
            .update_thread_evaluation_policy(
                &current.id,
                current.revision,
                &ModelSelection::default(),
            )
            .await
            .unwrap()
        else {
            panic!("control must succeed")
        };
        updated.revision
    }

    async fn fail(&self) -> ObjectiveRecord {
        self.store.append(self.failure.clone()).await.unwrap();
        self.supervisor
            .terminal_outcome(&self.failure)
            .await
            .unwrap();
        self.store
            .get_objective(&self.objective.id)
            .await
            .unwrap()
            .unwrap()
    }

    async fn change_session(&self, model: Option<&str>, effort: Option<&str>) {
        self.store
            .update_session(
                &self.objective.coordinator_session_id,
                SessionUpdate {
                    model_alias: Some(model.map(ToOwned::to_owned)),
                    reasoning_effort: Some(effort.map(ToOwned::to_owned)),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .unwrap();
    }
}

#[tokio::test]
async fn inherited_session_change_before_failure_does_not_install_wait() {
    let fixture = Fixture::with_overrides(false).await;
    fixture.change_session(Some("new-route"), Some("low")).await;
    let current = fixture.fail().await;
    assert!(current.wait_condition.is_none());
    assert_eq!(
        fixture
            .store
            .get_thread(&fixture.thread.id)
            .await
            .unwrap()
            .unwrap(),
        fixture.thread
    );
}

#[tokio::test]
async fn session_change_preserves_explicit_primary_request_wait() {
    let fixture = Fixture::new().await;
    fixture.change_session(Some("new-route"), Some("low")).await;
    let current = fixture.fail().await;
    assert!(current.wait_condition.is_some());
    assert!(fixture
        .supervisor
        .release_obsolete_primary_policy_wait(&current)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn session_policy_recovery_requires_exact_primary_route_and_a_replaced_snapshot() {
    let fixture = Fixture::with_overrides(false).await;
    fixture.change_session(Some("new-route"), Some("low")).await;
    assert!(fixture
        .supervisor
        .primary_session_policy_changed(&fixture.objective, &fixture.failure)
        .await
        .unwrap());
    for (field, wrong) in [
        ("thread_id", json!("explicit-child")),
        ("root_turn_id", json!("child-root")),
        ("thread_generation", json!(fixture.thread.generation + 1)),
        ("context_id", json!("other-context")),
        ("session_id", json!("other-session")),
        ("objective_evaluation_id", json!("other-evaluation")),
        ("activation_id", json!("absent")),
    ] {
        let mut other = fixture.failure.clone();
        other.payload.insert(field.into(), wrong);
        assert!(
            !fixture
                .supervisor
                .primary_session_policy_changed(&fixture.objective, &other)
                .await
                .unwrap(),
            "{field}"
        );
    }
    let mut new_failure = fixture.failure.clone();
    new_failure.payload.insert(
        "session_evaluation_policy".into(),
        json!(crate::model_selection::SessionEvaluationSnapshot::new(
            Some("new-route"),
            Some("low"),
            true,
            true
        )),
    );
    assert!(!fixture.supervisor.primary_session_policy_changed(&fixture.objective, &new_failure).await.unwrap(),
        "a request already using the current Session policy cannot be released by a late change notification");
}

#[tokio::test]
async fn session_change_revert_or_missing_snapshot_does_not_release_wait() {
    for missing in [false, true] {
        let mut fixture = Fixture::with_overrides(false).await;
        if missing {
            fixture.failure.payload.remove("session_evaluation_policy");
        }
        let waiting = fixture.fail().await;
        fixture.change_session(Some("new-route"), Some("low")).await;
        if !missing {
            fixture.change_session(None, None).await;
        }
        assert!(fixture
            .supervisor
            .release_obsolete_primary_policy_wait(&waiting)
            .await
            .unwrap()
            .is_none());
    }
}

#[tokio::test]
async fn inherited_session_wait_recovers_after_reopen_without_notification() {
    let fixture = Fixture::with_overrides(false).await;
    let waiting = fixture.fail().await;
    fixture.change_session(Some("new-route"), Some("low")).await;
    let Fixture {
        supervisor: old_supervisor,
        store,
        database,
        ..
    } = fixture;
    drop(old_supervisor);
    drop(store);
    let reopened = Arc::new(
        SqliteStore::new(database.path().to_str().unwrap())
            .await
            .unwrap(),
    );
    let supervisor = supervisor(&reopened);
    supervisor
        .reconcile_durable_objective(waiting.clone(), false)
        .await
        .unwrap();
    let current = reopened.get_objective(&waiting.id).await.unwrap().unwrap();
    assert!(current.wait_condition.is_none());
    assert!(supervisor
        .current_scheduler_dependencies(&current)
        .await
        .unwrap()
        .unwrap()
        .iter()
        .all(|edge| edge.status != SchedulerDependencyStatus::Pending));
}

#[tokio::test]
async fn primary_policy_change_before_old_failure_does_not_install_wait() {
    let fixture = Fixture::new().await;
    let old_thread = fixture.thread.clone();
    fixture.clear_policy().await;
    let finished = fixture.fail().await;
    assert_eq!(finished.status, ObjectiveStatus::Active);
    assert!(finished.wait_condition.is_none());
    assert!(finished.active_evaluation_id.is_none());
    assert_eq!(finished.model_alias, fixture.objective.model_alias);
    assert_eq!(
        finished.reasoning_effort,
        fixture.objective.reasoning_effort
    );
    let current_thread = fixture
        .store
        .get_thread(&old_thread.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current_thread.generation, old_thread.generation);
    assert_eq!(current_thread.root_turn_id, old_thread.root_turn_id);
    assert_eq!(current_thread.supervision, old_thread.supervision);
}

#[tokio::test]
async fn another_sessions_policy_event_is_not_a_global_configuration_change_for_this_request() {
    let mut fixture = Fixture::new().await;
    fixture.failure.payload.insert(
        "model_request_started_at".into(),
        json!(Utc::now() - Duration::seconds(1)),
    );
    let foreign_session = "policy-unrelated-session";
    fixture
        .store
        .create_session(NewSession {
            id: foreign_session.into(),
            agent_id: fixture.objective.agent_id.clone(),
            context_id: fixture.objective.context_id.clone(),
            parent_session_id: None,
            title: "TEST independent model choice".into(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    fixture
        .store
        .append(Event::new(
            "unrelated-session-model-choice".into(),
            "Runtime-SessionModelConfiguration".into(),
            "runtime_control".into(),
            TYPE_MODEL_CONFIGURATION_CHANGED.into(),
            json!({
                "context_id": fixture.objective.context_id,
                "session_id": foreign_session,
                "resource": format!("session-model-configuration:{foreign_session}"),
                "reason": "session_evaluation_policy_changed",
                "previous_model": "route-a", "selected_model": "route-b",
                "previous_reasoning_effort": "max", "reasoning_effort": "low",
            })
            .as_object()
            .unwrap()
            .clone(),
        ))
        .await
        .unwrap();
    assert!(
        !fixture
            .supervisor
            .model_configuration_changed_since_attempt(&fixture.failure)
            .await
            .unwrap(),
        "another Session's choice cannot make this unchanged physical request runnable"
    );
}

#[tokio::test]
async fn primary_policy_change_after_failure_is_recovered_from_store_without_notification() {
    let fixture = Fixture::new().await;
    fixture.store.append(fixture.failure.clone()).await.unwrap();
    let ObjectiveMutation::Updated(finished) = fixture
        .store
        .finish_objective_evaluation(&fixture.objective.id, "policy-evaluation", 0, 0)
        .await
        .unwrap()
    else {
        panic!("finish must commit")
    };
    // Exercise the exact commit-before-notification crash boundary: the
    // Kernel writes the wait and cause, but no state Event is appended.
    let ObjectiveMutation::Updated(waiting) = fixture
        .supervisor
        .transition_objective(
            &finished,
            ObjectiveStatus::Active,
            Some(ObjectiveWaitCondition::ResourceAvailable {
                resource: MODEL_CONFIGURATION_RESOURCE.into(),
            }),
            Some("physical request failed"),
            &fixture.failure.id,
            "ObjectiveSupervisor-ProviderRecovery",
        )
        .await
        .unwrap()
    else {
        panic!("wait must commit")
    };
    let before_edges = fixture
        .supervisor
        .current_scheduler_dependencies(&waiting)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(before_edges.len(), 1);
    assert_eq!(
        before_edges[0].metadata["cause_event_id"],
        json!(fixture.failure.id)
    );
    let ObjectiveMutation::Updated(waiting) = fixture
        .supervisor
        .transition_objective(
            &waiting,
            ObjectiveStatus::Active,
            waiting.wait_condition.clone(),
            Some("duplicate same cause"),
            &fixture.failure.id,
            "ObjectiveSupervisor-ProviderRecovery",
        )
        .await
        .unwrap()
    else {
        panic!("duplicate cause must commit")
    };
    assert_eq!(
        fixture
            .supervisor
            .current_scheduler_dependencies(&waiting)
            .await
            .unwrap()
            .unwrap(),
        before_edges
    );
    assert!(fixture
        .store
        .query(QueryFilter {
            context_id: Some(waiting.context_id.clone()),
            topic: Some("objective/runtime_failure".into()),
            ..Default::default()
        })
        .await
        .unwrap()
        .is_empty());
    assert!(waiting.wait_condition.is_some());
    fixture.clear_policy().await;
    let objective_id = fixture.objective.id.clone();
    let Fixture {
        supervisor: old_supervisor,
        store,
        database,
        ..
    } = fixture;
    drop(old_supervisor);
    drop(store);
    // No policy Event was published, and the registry is recreated. This is
    // a real store reopen, not a claim of a killed-process integration test.
    let reopened = Arc::new(
        SqliteStore::new(database.path().to_str().unwrap())
            .await
            .unwrap(),
    );
    let supervisor = supervisor(&reopened);
    assert_eq!(
        supervisor
            .current_scheduler_dependencies(&waiting)
            .await
            .unwrap()
            .unwrap(),
        before_edges,
        "backfill must not manufacture another edge from the newer display revision"
    );
    supervisor
        .reconcile_durable_objective(waiting, false)
        .await
        .unwrap();
    let current = reopened
        .get_objective(&objective_id)
        .await
        .unwrap()
        .unwrap();
    assert!(current.wait_condition.is_none());
    let dependencies = supervisor
        .current_scheduler_dependencies(&current)
        .await
        .unwrap()
        .unwrap();
    assert!(dependencies
        .iter()
        .all(|edge| edge.status != SchedulerDependencyStatus::Pending));
    assert!(supervisor
        .release_obsolete_primary_policy_wait(&current)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn primary_policy_recovery_does_not_modify_explicit_objective_child() {
    let fixture = Fixture::new().await;
    let child = fixture
        .store
        .ensure_thread(NewThread {
            response_annotations: Default::default(),
            model_alias: Some("explicit-child-model".into()),
            reasoning_effort: Some("high".into()),
            id: stable_thread_id("policy-explicit-child"),
            agent_id: fixture.objective.agent_id.clone(),
            context_id: fixture.objective.context_id.clone(),
            session_id: fixture.objective.coordinator_session_id.clone(),
            initiating_principal_id: fixture.objective.initiating_principal_id.clone(),
            root_turn_id: "policy-explicit-child".into(),
            kind: ThreadKind::Execution,
            executor_kind: "self".into(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::objective(
                &fixture.objective.id,
                "policy-evaluation",
                fixture.objective.generation,
                Some(fixture.thread.id.clone()),
            ),
        })
        .await
        .unwrap();
    let waiting = fixture.fail().await;
    fixture.clear_policy().await;
    assert!(fixture
        .supervisor
        .release_obsolete_primary_policy_wait(&waiting)
        .await
        .unwrap()
        .is_some());
    assert_eq!(
        fixture.store.get_thread(&child.id).await.unwrap().unwrap(),
        child
    );
    assert_eq!(
        fixture
            .store
            .get_thread_evaluation_policy(&child.id)
            .await
            .unwrap()
            .unwrap()
            .control_revision,
        None
    );
}

#[tokio::test]
async fn reopen_does_not_resurrect_terminal_resource_dependency_from_display_wait() {
    let fixture = Fixture::new().await;
    let waiting = fixture.fail().await;
    let edges = fixture
        .supervisor
        .current_scheduler_dependencies(&waiting)
        .await
        .unwrap()
        .unwrap();
    let edge = &edges[0];
    assert!(matches!(
        fixture
            .store
            .satisfy_scheduler_dependency(
                &edge.id,
                edge.owner_generation,
                edge.dependency_generation,
                &fixture.failure.id
            )
            .await
            .unwrap(),
        SchedulerDependencyMutation::Updated(_)
    ));
    let expected = fixture
        .supervisor
        .current_scheduler_dependencies(&waiting)
        .await
        .unwrap()
        .unwrap();
    assert!(expected.iter().all(|edge| edge.status.is_terminal()));
    // Advance only the display revision, keeping the existing terminal edge
    // as authority. There is deliberately no new physical wait/cause.
    let ObjectiveMutation::Updated(waiting) = fixture
        .store
        .update_objective_state(
            &waiting.id,
            waiting.revision,
            ObjectiveStatus::Active,
            waiting.wait_condition.clone(),
            Some("same state"),
            None,
        )
        .await
        .unwrap()
    else {
        panic!("display update must commit")
    };
    let Fixture {
        supervisor: old,
        store,
        database,
        ..
    } = fixture;
    drop(old);
    drop(store);
    let reopened = Arc::new(
        SqliteStore::new(database.path().to_str().unwrap())
            .await
            .unwrap(),
    );
    let current = supervisor(&reopened)
        .current_scheduler_dependencies(&waiting)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current, expected);
}

#[tokio::test]
async fn new_policy_failure_is_not_released_by_late_policy_publisher() {
    let mut fixture = Fixture::new().await;
    let revision = fixture.clear_policy().await;
    fixture
        .failure
        .payload
        .insert("thread_evaluation_policy_revision".into(), json!(revision));
    let waiting = fixture.fail().await;
    assert!(waiting.wait_condition.is_some());
    let before = fixture
        .supervisor
        .current_scheduler_dependencies(&waiting)
        .await
        .unwrap();
    fixture
        .supervisor
        .reconcile_durable_objective(waiting.clone(), false)
        .await
        .unwrap();
    assert_eq!(
        fixture
            .store
            .get_objective(&waiting.id)
            .await
            .unwrap()
            .unwrap(),
        waiting
    );
    assert_eq!(
        fixture
            .supervisor
            .current_scheduler_dependencies(&waiting)
            .await
            .unwrap(),
        before
    );
}

#[tokio::test]
async fn missing_or_malformed_request_revision_does_not_authorize_policy_recovery() {
    for value in [None, Some(json!("old")), Some(json!(-1))] {
        let mut fixture = Fixture::new().await;
        fixture.clear_policy().await;
        match value {
            Some(value) => {
                fixture
                    .failure
                    .payload
                    .insert("thread_evaluation_policy_revision".into(), value);
            }
            None => {
                fixture
                    .failure
                    .payload
                    .remove("thread_evaluation_policy_revision");
            }
        }
        let waiting = fixture.fail().await;
        assert!(waiting.wait_condition.is_some());
        assert!(fixture
            .supervisor
            .release_obsolete_primary_policy_wait(&waiting)
            .await
            .unwrap()
            .is_none());
    }
}

#[tokio::test]
async fn primary_policy_recovery_requires_exact_generation_session_and_evaluation() {
    let fixture = Fixture::new().await;
    fixture.clear_policy().await;
    assert!(fixture
        .supervisor
        .primary_request_policy_changed(&fixture.objective, &fixture.failure)
        .await
        .unwrap());
    for (field, wrong) in [
        ("thread_id", json!("explicit-child")),
        ("root_turn_id", json!("child-root")),
        ("thread_generation", json!(fixture.thread.generation + 1)),
        ("context_id", json!("other-context")),
        ("session_id", json!("other-session")),
        ("objective_evaluation_id", json!("other-evaluation")),
        ("activation_id", json!("absent")),
    ] {
        let mut other = fixture.failure.clone();
        other.payload.insert(field.into(), wrong);
        assert!(
            !fixture
                .supervisor
                .primary_request_policy_changed(&fixture.objective, &other)
                .await
                .unwrap(),
            "{field}"
        );
    }
    let mut next_lifetime = fixture.objective.clone();
    next_lifetime.generation += 1;
    assert!(!fixture
        .supervisor
        .primary_request_policy_changed(&next_lifetime, &fixture.failure)
        .await
        .unwrap());
}

#[tokio::test]
async fn resource_wait_without_exact_failure_cause_and_stale_wait_snapshot_stay_fenced() {
    let fixture = Fixture::new().await;
    fixture.clear_policy().await;
    let ObjectiveMutation::Updated(finished) = fixture
        .store
        .finish_objective_evaluation(&fixture.objective.id, "policy-evaluation", 0, 0)
        .await
        .unwrap()
    else {
        panic!("finish must commit")
    };
    // A user/Agent-created wait has the same resource, but no Runtime failure
    // receipt. Policy recovery must not reinterpret it.
    let ObjectiveMutation::Updated(waiting) = fixture
        .store
        .update_objective_state(
            &finished.id,
            finished.revision,
            ObjectiveStatus::Active,
            Some(ObjectiveWaitCondition::ResourceAvailable {
                resource: MODEL_CONFIGURATION_RESOURCE.into(),
            }),
            Some("explicit wait"),
            None,
        )
        .await
        .unwrap()
    else {
        panic!("wait must commit")
    };
    assert!(fixture
        .supervisor
        .release_obsolete_primary_policy_wait(&waiting)
        .await
        .unwrap()
        .is_none());

    let fixture = Fixture::new().await;
    let waiting = fixture.fail().await;
    fixture.clear_policy().await;
    let ObjectiveMutation::Updated(newer) = fixture
        .store
        .update_objective_state(
            &waiting.id,
            waiting.revision,
            ObjectiveStatus::Active,
            Some(ObjectiveWaitCondition::ResourceAvailable {
                resource: "model-provider:new-request".into(),
            }),
            Some("newer wait"),
            None,
        )
        .await
        .unwrap()
    else {
        panic!("newer wait must commit")
    };
    assert!(fixture
        .supervisor
        .release_obsolete_primary_policy_wait(&waiting)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        fixture
            .store
            .get_objective(&waiting.id)
            .await
            .unwrap()
            .unwrap(),
        newer
    );
}
