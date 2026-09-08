use super::*;

async fn directed_input(
    store: &dyn RuntimeStore,
    o: &ObjectiveRecord,
    suffix: &str,
) -> (NewThreadSignal, NewThreadActivation) {
    let thread = store
        .ensure_thread(morphz::steering::objective_thread(o))
        .await
        .unwrap();
    let id = format!("objective-input-{suffix}");
    let mut input = event(
        id.clone(),
        "chat/user_message",
        "user_message",
        json!({
            "context_id":o.context_id,"session_id":o.coordinator_session_id,
            "text":"Synthetic directed input; keep existing approval decisions unchanged",
        }),
    );
    morphz::steering::route(
        &mut input,
        &morphz::steering::InputDestination::Objective {
            objective_id: o.id.clone(),
            generation: o.generation,
            reply_to_request_id: None,
        },
        &thread,
        Some(o),
    )
    .unwrap();
    store.append(input).await.unwrap();
    let sequence = store
        .query(QueryFilter {
            event_id: Some(id.clone()),
            ..Default::default()
        })
        .await
        .unwrap()
        .remove(0)
        .sequence
        .unwrap();
    (
        NewThreadSignal {
            id: stable_thread_signal_id(&id),
            thread_id: thread.id,
            thread_generation: thread.generation,
            event_id: id.clone(),
            principal_id: None,
            sequence,
            kind: "chat/steering".into(),
            parent_activation_id: None,
        },
        NewThreadActivation {
            id: format!("input-activation-{suffix}"),
            agent_id: o.agent_id.clone(),
            context_id: o.context_id.clone(),
            session_id: o.coordinator_session_id.clone(),
            initiating_principal_id: None,
            trigger_event_id: id,
            trigger_sequence: sequence,
            trigger_kind: "chat/steering".into(),
            parent_activation_id: None,
            root_turn_id: thread.root_turn_id,
        },
    )
}

async fn directed_input_ownership_contract(store: &dyn RuntimeStore) {
    for parked in [false, true] {
        let label = if parked { "input-parked" } else { "input-live" };
        let mut batch = seed(store, label).await;
        let owner = objective(store, &batch, label).await;
        bind(store, &mut batch, &owner, false).await;
        if parked {
            checkpoint(store, &batch).await;
        }
        let held = store.get_objective(&owner.id).await.unwrap().unwrap();
        let (input, activation) = directed_input(store, &held, label).await;
        for _ in 0..2 {
            assert!(store
                .claim_thread_signal_batch(input.clone(), activation.clone(), 32)
                .await
                .unwrap()
                .is_none());
            assert!(!store
                .list_runnable_pending_thread_signals(128)
                .await
                .unwrap()
                .iter()
                .any(|s| s.id == input.id));
            let signals = store
                .list_context_thread_signals(&held.context_id, None)
                .await
                .unwrap();
            assert_eq!(
                signals.iter().find(|s| s.id == input.id).unwrap().status,
                ThreadSignalStatus::Pending
            );
            assert_eq!(store.get_objective(&owner.id).await.unwrap().unwrap(), held);
            for job in &batch.jobs {
                assert_eq!(
                    store.get_execution_job(&job.id).await.unwrap().unwrap(),
                    *job
                );
            }
        }
        // A different Objective in the exact same Session is not fenced by
        // this owner's live lease or human-approval checkpoint.
        let other = store
            .create_objective(NewObjective {
                id: format!("unrelated-{label}"),
                agent_id: held.agent_id.clone(),
                context_id: held.context_id.clone(),
                coordinator_session_id: held.coordinator_session_id.clone(),
                delivery_session_id: held.delivery_session_id.clone(),
                parent_objective_id: None,
                source_event_id: held.source_event_id.clone(),
                initiating_principal_id: None,
                stated_objective: "Independent synthetic work".into(),
                token_budget: None,
            })
            .await
            .unwrap();
        let (other_input, other_activation) =
            directed_input(store, &other, &format!("other-{label}")).await;
        assert!(store
            .claim_thread_signal_batch(other_input, other_activation, 32)
            .await
            .unwrap()
            .is_some());
        if !parked {
            let remaining = (held.evaluation_lease_expires_at.unwrap() - Utc::now())
                .to_std()
                .unwrap_or_default();
            tokio::time::sleep(remaining + std::time::Duration::from_millis(25)).await;
            let next = morphz::steering::objective_thread(&held);
            let continuation = event(
                format!("continuation-{label}"),
                "chat/objective_continue",
                "objective_continue",
                json!({
                    "context_id":held.context_id,"session_id":held.coordinator_session_id,
                    "objective_id":held.id,"objective_evaluation_id":"must-not-overtake-input",
                    "root_turn_id":next.root_turn_id,
                }),
            );
            let attempt = || {
                store.claim_objective_evaluation_with_signal(
                    &held.id,
                    held.revision,
                    "must-not-overtake-input",
                    Utc::now() + Duration::seconds(30),
                    &continuation,
                    &next,
                )
            };
            assert!(
                matches!(attempt().await.unwrap(), ObjectiveMutation::Conflict { .. }),
                "an automatic continuation must not overtake already-pending user input"
            );
            assert!(store
                .list_runnable_pending_thread_signals(128)
                .await
                .unwrap()
                .iter()
                .any(|s| s.id == input.id));
            assert!(store
                .claim_thread_signal_batch(input, activation, 32)
                .await
                .unwrap()
                .is_some());
            assert!(
                matches!(attempt().await.unwrap(), ObjectiveMutation::Conflict { .. }),
                "a claimed user Signal reserves admission before its Evaluation is acquired"
            );
            assert!(
                store
                    .query(QueryFilter {
                        event_id: Some(continuation.id),
                        ..Default::default()
                    })
                    .await
                    .unwrap()
                    .is_empty(),
                "a losing automatic claim must not publish its Event"
            );
        }
    }
}

#[tokio::test]
async fn sqlite_directed_objective_input_waits_for_exact_owner() {
    let temp = tempfile::tempdir().unwrap();
    let store = SqliteStore::new(temp.path().join("directed.sqlite").to_str().unwrap())
        .await
        .unwrap();
    directed_input_ownership_contract(&store).await;
}

#[tokio::test]
#[ignore = "requires isolated MORPHZ_TEST_POSTGRES_URL"]
async fn postgres_directed_objective_input_waits_for_exact_owner() {
    let store = morphz::memory::postgres::PostgresStore::new(
        &std::env::var("MORPHZ_TEST_POSTGRES_URL").unwrap(),
        4,
    )
    .await
    .unwrap();
    directed_input_ownership_contract(&store).await;
}

async fn infer_admission_contract(store: std::sync::Arc<dyn RuntimeStore>) {
    use morphz::scheduler::{SchedulerDependencyFilter, SchedulerDependencyOwnerKind};
    let mut parent = seed(store.as_ref(), "objective-infer-admission").await;
    let activation = store
        .get_thread_activation(&parent.request.activation_id)
        .await
        .unwrap()
        .unwrap();
    let o = store
        .create_objective(NewObjective {
            id: "objective-infer-route".into(),
            agent_id: activation.agent_id,
            context_id: activation.context_id,
            coordinator_session_id: activation.session_id.clone(),
            delivery_session_id: activation.session_id,
            parent_objective_id: None,
            source_event_id: activation.trigger_event_id,
            initiating_principal_id: None,
            stated_objective: "Synthetic inherited infer dependency".into(),
            token_budget: None,
        })
        .await
        .unwrap();
    let ObjectiveMutation::Updated(waiting) = store
        .update_objective_state(
            &o.id,
            o.revision,
            ObjectiveStatus::Active,
            Some(ObjectiveWaitCondition::Timer {
                deadline: Utc::now() + Duration::hours(1),
            }),
            Some("synthetic dependency"),
        )
        .await
        .unwrap()
    else {
        panic!("wait was not installed")
    };
    let dependencies = store
        .list_scheduler_dependencies(SchedulerDependencyFilter {
            owner_kind: Some(SchedulerDependencyOwnerKind::Objective),
            owner_id: Some(o.id.clone()),
            required_only: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(dependencies.len(), 1);
    let dependency = &dependencies[0].id;
    let ObjectiveMutation::Updated(claimed) = store
        .claim_objective_interrupt_evaluation(
            &o.id,
            waiting.revision,
            "evaluation-infer-route",
            Utc::now() + Duration::minutes(5),
            dependency,
        )
        .await
        .unwrap()
    else {
        panic!("interrupt was not claimed")
    };
    let child = super::infer_children::child_with_objective(
        store.clone(),
        &mut parent,
        "objective-infer-leaf",
        false,
        Some((&claimed, dependency)),
    )
    .await;
    let request = ObjectiveActivationAdmission {
        objective_id: o.id.clone(),
        evaluation_id: "evaluation-infer-route".into(),
        activation_id: child.request.activation_id.clone(),
        claimed_by: "worker-before-exit".into(),
        lease_expires_at: Utc::now() + Duration::minutes(5),
        pending_dependency_id: Some(dependency.clone()),
    };
    let before = store
        .get_thread_activation(&request.activation_id)
        .await
        .unwrap()
        .unwrap();
    let trigger = store
        .query(QueryFilter {
            event_id: Some(before.trigger_event_id.clone()),
            ..Default::default()
        })
        .await
        .unwrap()
        .remove(0);
    assert!(
        trigger
            .payload
            .get("objective_pending_dependency_id")
            .is_none(),
        "must exercise inherited proof, not a stamped child trigger"
    );
    let mut wrong = request.clone();
    wrong.pending_dependency_id = Some("unrelated-dependency".into());
    assert!(store.admit_objective_activation(wrong).await.is_err());
    let mut stale = request.clone();
    stale.claimed_by = "stale-worker".into();
    assert!(store.admit_objective_activation(stale).await.is_err());
    assert!(matches!(
        store
            .admit_objective_activation(request.clone())
            .await
            .unwrap(),
        ObjectiveMutation::Updated(_)
    ));
    let after = store
        .get_thread_activation(&request.activation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after.revision, before.revision);
    assert_eq!(after.claimed_by, before.claimed_by);
    assert_eq!(after.lease_expires_at, before.lease_expires_at);
    assert_eq!(store.get_objective(&o.id).await.unwrap().unwrap(), claimed);
    store
        .update_objective_state(
            &o.id,
            claimed.revision,
            ObjectiveStatus::Paused,
            None,
            Some("synthetic pause"),
        )
        .await
        .unwrap();
    assert!(matches!(
        store.admit_objective_activation(request).await.unwrap(),
        ObjectiveMutation::Conflict { .. }
    ));
}

#[tokio::test]
async fn sqlite_objective_infer_admission_requires_exact_inherited_proof() {
    let temp = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(
        SqliteStore::new(temp.path().join("infer.sqlite").to_str().unwrap())
            .await
            .unwrap(),
    );
    infer_admission_contract(store).await;
}

#[tokio::test]
#[ignore = "requires isolated MORPHZ_TEST_POSTGRES_URL"]
async fn postgres_objective_infer_admission_requires_exact_inherited_proof() {
    let url = std::env::var("MORPHZ_TEST_POSTGRES_URL").unwrap();
    let store = std::sync::Arc::new(
        morphz::memory::postgres::PostgresStore::new(&url, 4)
            .await
            .unwrap(),
    );
    infer_admission_contract(store).await;
}

async fn objective(store: &dyn RuntimeStore, batch: &Batch, label: &str) -> ObjectiveRecord {
    let a = store
        .get_thread_activation(&batch.request.activation_id)
        .await
        .unwrap()
        .unwrap();
    let o = store
        .create_objective(NewObjective {
            id: format!("objective-{label}"),
            agent_id: a.agent_id,
            context_id: a.context_id,
            coordinator_session_id: a.session_id.clone(),
            delivery_session_id: a.session_id,
            parent_objective_id: None,
            source_event_id: a.trigger_event_id,
            initiating_principal_id: a.initiating_principal_id,
            stated_objective: "Synthetic approval ownership".into(),
            token_budget: None,
        })
        .await
        .unwrap();
    match store
        .claim_objective_evaluation(
            &o.id,
            o.revision,
            &format!("evaluation-{label}"),
            Utc::now() + Duration::seconds(2),
        )
        .await
        .unwrap()
    {
        ObjectiveMutation::Updated(o) => o,
        other => panic!("{other:?}"),
    }
}

async fn bind(store: &dyn RuntimeStore, batch: &mut Batch, o: &ObjectiveRecord, late: bool) {
    let mut call = store
        .query(QueryFilter {
            event_id: Some(batch.request.assistant_call_event_id.clone()),
            ..Default::default()
        })
        .await
        .unwrap()
        .remove(0);
    call.id = format!("objective-{}", call.id);
    call.sequence = None;
    if late {
        call.payload.get_mut("tool_calls").unwrap().as_array_mut().unwrap().push(json!({
            "id":"create-objective", "type":"function", "function":{"name":"objective_create", "arguments":"{}"}
        }));
        let output = event(
            format!("late-{}", call.id),
            "chat/tool_output",
            TYPE_TOOL_OUTPUT,
            json!({
                "context_id":o.context_id,"session_id":o.coordinator_session_id,
                "attempt_id":batch.request.activation_id,"tool_call_id":"create-objective",
                "tool_name":"objective_create","tool_status":"success","text":"fixture",
                "objective_id":o.id,"objective_evaluation_id":o.active_evaluation_id,
            }),
        );
        batch
            .request
            .completed_output_event_ids
            .push(output.id.clone());
        store.append(output).await.unwrap();
    } else {
        call.payload.insert("objective_id".into(), json!(o.id));
        call.payload.insert(
            "objective_evaluation_id".into(),
            json!(o.active_evaluation_id),
        );
    }
    batch.request.assistant_call_event_id = call.id.clone();
    store.append(call).await.unwrap();
}

async fn additional_owner(store: &dyn RuntimeStore, batch: &Batch, label: &str) -> Batch {
    additional_owner_as(store, batch, label, None).await
}

async fn additional_owner_as(
    store: &dyn RuntimeStore,
    batch: &Batch,
    label: &str,
    principal: Option<&str>,
) -> Batch {
    let a = store
        .get_thread_activation(&batch.request.activation_id)
        .await
        .unwrap()
        .unwrap();
    let root = format!("root-{label}");
    store
        .append(event(
            root.clone(),
            "chat/user_message",
            "user_message",
            json!({
                "context_id":a.context_id,"session_id":a.session_id,"text":"synthetic sibling", "principal_id":principal
            }),
        ))
        .await
        .unwrap();
    store
        .ensure_thread(NewThread {
            id: format!("thread-{label}"),
            agent_id: a.agent_id.clone(),
            context_id: a.context_id.clone(),
            session_id: a.session_id.clone(),
            initiating_principal_id: principal.map(str::to_owned),
            root_turn_id: root.clone(),
            kind: ThreadKind::Execution,
            executor_kind: "self".into(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::runtime("objective-approval-fixture"),
        })
        .await
        .unwrap();
    let next = store
        .ensure_thread_activation(NewThreadActivation {
            id: format!("activation-{label}"),
            agent_id: a.agent_id,
            context_id: a.context_id,
            session_id: a.session_id,
            initiating_principal_id: principal.map(str::to_owned),
            trigger_event_id: root.clone(),
            trigger_sequence: 2,
            trigger_kind: "chat/user_message".into(),
            parent_activation_id: None,
            root_turn_id: root,
        })
        .await
        .unwrap();
    let running = match store
        .update_thread_activation(
            &next.id,
            next.revision,
            ThreadActivationStatus::Running,
            Some("worker-before-exit"),
            Some(Utc::now() + Duration::minutes(10)),
            None,
        )
        .await
        .unwrap()
    {
        ThreadActivationMutation::Updated(a) => a,
        other => panic!("{other:?}"),
    };
    seed_running_batch(store, &running, label).await
}

async fn contract(store: &dyn RuntimeStore, late: bool) {
    let label = if late {
        "objective-late"
    } else {
        "objective-direct"
    };
    let mut first = seed(store, label).await;
    let mut second = additional_owner(store, &first, &format!("{label}-second")).await;
    let mut unrelated = additional_owner(store, &first, &format!("{label}-unrelated")).await;
    let other = objective(store, &unrelated, &format!("{label}-other")).await;
    bind(store, &mut unrelated, &other, false).await;
    let o = objective(store, &first, label).await;
    bind(store, &mut first, &o, late).await;
    bind(store, &mut second, &o, false).await;
    checkpoint(store, &first).await;
    assert!(
        store
            .get_objective_approval_wait(&o.id)
            .await
            .unwrap()
            .is_none(),
        "a second live owner still needs its lease"
    );
    checkpoint(store, &second).await;
    let wait = store
        .get_objective_approval_wait(&o.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(wait.activation_id, second.request.activation_id);
    assert_eq!(
        Some(wait.evaluation_id.as_str()),
        o.active_evaluation_id.as_deref()
    );
    assert_eq!(wait.objective_generation, o.generation);
    let parked = store.get_objective(&o.id).await.unwrap().unwrap();
    assert!(parked.evaluation_lease_expires_at.is_none());
    assert_eq!(parked.revision, o.revision);
    assert!(store
        .get_objective(&other.id)
        .await
        .unwrap()
        .unwrap()
        .evaluation_lease_expires_at
        .is_some());
    let evaluation = o.active_evaluation_id.as_ref().unwrap();
    assert!(matches!(
        store
            .renew_objective_evaluation(&o.id, evaluation, Utc::now() + Duration::minutes(10))
            .await
            .unwrap(),
        ObjectiveMutation::Conflict { .. }
    ));
    assert!(matches!(
        store
            .claim_objective_evaluation(
                &o.id,
                o.revision,
                "replacement",
                Utc::now() + Duration::minutes(10)
            )
            .await
            .unwrap(),
        ObjectiveMutation::Conflict { .. }
    ));
    tokio::time::sleep(std::time::Duration::from_millis(2100)).await;
    assert!(store
        .get_objective_approval_wait(&o.id)
        .await
        .unwrap()
        .is_some());
    assert!(matches!(
        store
            .claim_objective_evaluation(
                &o.id,
                o.revision,
                "replacement-after-time",
                Utc::now() + Duration::minutes(10)
            )
            .await
            .unwrap(),
        ObjectiveMutation::Conflict { .. }
    ));
    store
        .commit_approval_decision(
            &first.approvals[0].id,
            first.approvals[0].revision,
            ApprovalResolution::Deny {
                rationale: "synthetic wake".into(),
                risk_tags: vec![],
            },
        )
        .await
        .unwrap();
    let a = store
        .get_thread_activation(&first.request.activation_id)
        .await
        .unwrap()
        .unwrap();
    let resumed = match store
        .update_thread_activation(
            &a.id,
            a.revision,
            ThreadActivationStatus::Running,
            Some("worker-after-exit"),
            Some(Utc::now() + Duration::minutes(5)),
            None,
        )
        .await
        .unwrap()
    {
        ThreadActivationMutation::Updated(a) => a,
        other => panic!("{other:?}"),
    };
    let request = ObjectiveActivationAdmission {
        objective_id: o.id.clone(),
        evaluation_id: evaluation.clone(),
        activation_id: resumed.id,
        claimed_by: "worker-after-exit".into(),
        lease_expires_at: Utc::now() + Duration::minutes(5),
        pending_dependency_id: None,
    };
    let mut wrong = request.clone();
    wrong.claimed_by = "stale-worker".into();
    assert!(store.admit_objective_activation(wrong).await.is_err());
    let restored = match store.admit_objective_activation(request).await.unwrap() {
        ObjectiveMutation::Updated(o) => o,
        other => panic!("{other:?}"),
    };
    assert_eq!(restored.active_evaluation_id, o.active_evaluation_id);
    assert_eq!(restored.continuation_sequence, o.continuation_sequence);
    assert_eq!(restored.revision, o.revision);
    assert!(restored.evaluation_lease_expires_at.unwrap() > Utc::now());
    assert!(store
        .get_objective_approval_wait(&o.id)
        .await
        .unwrap()
        .is_none());
    assert!(store
        .get_approval(&first.approvals[1].id)
        .await
        .unwrap()
        .unwrap()
        .grant_consumed_at
        .is_none());

    let mut cancelled = seed(store, &format!("{label}-cancelled")).await;
    let cancelled_o = objective(store, &cancelled, &format!("{label}-cancelled")).await;
    bind(store, &mut cancelled, &cancelled_o, false).await;
    checkpoint(store, &cancelled).await;
    store
        .update_objective_state(
            &cancelled_o.id,
            cancelled_o.revision,
            ObjectiveStatus::Paused,
            None,
            Some("synthetic pause"),
        )
        .await
        .unwrap();
    assert!(store
        .get_objective_approval_wait(&cancelled_o.id)
        .await
        .unwrap()
        .is_none());
    assert!(matches!(
        store
            .renew_objective_evaluation(
                &cancelled_o.id,
                cancelled_o.active_evaluation_id.as_ref().unwrap(),
                Utc::now() + Duration::minutes(5)
            )
            .await
            .unwrap(),
        ObjectiveMutation::Conflict { .. }
    ));
}

#[tokio::test]
async fn sqlite_objective_approval_handoff_retains_exact_evaluation() {
    let temp = tempfile::tempdir().unwrap();
    let store = SqliteStore::new(temp.path().join("objective.sqlite").to_str().unwrap())
        .await
        .unwrap();
    contract(&store, false).await;
    contract(&store, true).await;
    principal_contract(&store).await;
}

#[tokio::test]
#[ignore = "requires isolated MORPHZ_TEST_POSTGRES_URL"]
async fn postgres_objective_approval_handoff_retains_exact_evaluation() {
    let url = std::env::var("MORPHZ_TEST_POSTGRES_URL").unwrap();
    let store = morphz::memory::postgres::PostgresStore::new(&url, 4)
        .await
        .unwrap();
    contract(&store, false).await;
    contract(&store, true).await;
    principal_contract(&store).await;
}

async fn principal_contract(store: &dyn RuntimeStore) {
    let base = seed(store, "principal-contract").await;
    let o = objective(store, &base, "principal-contract").await;
    store
        .ensure_principal(NewPrincipal {
            id: "alice-approval".into(),
            provider_id: "fixture".into(),
            assurance: "fixture".into(),
            display_name: None,
        })
        .await
        .unwrap();
    let mut directed =
        additional_owner_as(store, &base, "principal-directed", Some("alice-approval")).await;
    bind(store, &mut directed, &o, false).await;
    let request = ObjectiveActivationAdmission {
        objective_id: o.id.clone(),
        evaluation_id: o.active_evaluation_id.clone().unwrap(),
        activation_id: directed.request.activation_id.clone(),
        claimed_by: directed.request.claimed_by.clone(),
        lease_expires_at: Utc::now() + Duration::minutes(5),
        pending_dependency_id: None,
    };
    assert!(
        store
            .admit_objective_activation(request.clone())
            .await
            .is_err(),
        "a Principal label is not a Session binding"
    );
    store
        .bind_session_principal(&o.coordinator_session_id, "alice-approval")
        .await
        .unwrap();
    assert!(matches!(
        store.admit_objective_activation(request).await.unwrap(),
        ObjectiveMutation::Updated(_)
    ));
    let bob = store
        .create_objective(NewObjective {
            id: "explicit-bob-objective".into(),
            agent_id: o.agent_id.clone(),
            context_id: o.context_id.clone(),
            coordinator_session_id: o.coordinator_session_id.clone(),
            delivery_session_id: o.delivery_session_id.clone(),
            parent_objective_id: None,
            source_event_id: o.source_event_id.clone(),
            initiating_principal_id: Some("bob-approval".into()),
            stated_objective: "Explicit owner isolation".into(),
            token_budget: None,
        })
        .await
        .unwrap();
    let bob = match store
        .claim_objective_evaluation(
            &bob.id,
            bob.revision,
            "bob-evaluation",
            Utc::now() + Duration::minutes(5),
        )
        .await
        .unwrap()
    {
        ObjectiveMutation::Updated(o) => o,
        other => panic!("{other:?}"),
    };
    bind(store, &mut directed, &bob, false).await;
    assert!(
        store
            .admit_objective_activation(ObjectiveActivationAdmission {
                objective_id: bob.id,
                evaluation_id: "bob-evaluation".into(),
                activation_id: directed.request.activation_id,
                claimed_by: directed.request.claimed_by,
                lease_expires_at: Utc::now() + Duration::minutes(5),
                pending_dependency_id: None,
            })
            .await
            .is_err(),
        "Session participation must not override an explicit Objective Principal"
    );
}

#[tokio::test]
#[ignore = "requires isolated MORPHZ_TEST_POSTGRES_URL"]
async fn postgres_objective_approval_lock_contention_preserves_ownership() {
    use sqlx::Row;
    let url = std::env::var("MORPHZ_TEST_POSTGRES_URL").unwrap();
    let store = morphz::memory::postgres::PostgresStore::new(&url, 4)
        .await
        .unwrap();
    let pool = sqlx::PgPool::connect(&url).await.unwrap();
    let mut batch = seed(&store, "objective-locks").await;
    let o = objective(&store, &batch, "objective-locks").await;
    let o = match store
        .renew_objective_evaluation(
            &o.id,
            o.active_evaluation_id.as_ref().unwrap(),
            Utc::now() + Duration::minutes(5),
        )
        .await
        .unwrap()
    {
        ObjectiveMutation::Updated(o) => o,
        other => panic!("{other:?}"),
    };
    bind(&store, &mut batch, &o, false).await;
    let before = store
        .get_thread_activation(&batch.request.activation_id)
        .await
        .unwrap()
        .unwrap();
    let request = ObjectiveActivationAdmission {
        objective_id: o.id.clone(),
        evaluation_id: o.active_evaluation_id.clone().unwrap(),
        activation_id: before.id.clone(),
        claimed_by: before.claimed_by.clone().unwrap(),
        lease_expires_at: Utc::now() + Duration::minutes(5),
        pending_dependency_id: None,
    };
    // These locks model cancellation (Thread -> Objective) and an Objective
    // mutation respectively. Each native operation must rollback, not deadlock
    // or reinterpret a busy row as missing/unauthorized.
    for lock_objective in [false, true] {
        let mut held = pool.begin().await.unwrap();
        if lock_objective {
            sqlx::query("SELECT id FROM objectives WHERE id = $1 FOR UPDATE")
                .bind(&o.id)
                .fetch_one(&mut *held)
                .await
                .unwrap();
        } else {
            sqlx::query("SELECT id FROM threads WHERE root_turn_id = $1 FOR UPDATE")
                .bind(&before.root_turn_id)
                .fetch_one(&mut *held)
                .await
                .unwrap();
        }
        let checkpoint = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            store.suspend_thread_activation_for_approval(batch.request.clone()),
        )
        .await
        .expect("checkpoint deadlocked")
        .unwrap_err();
        assert!(
            checkpoint
                .downcast_ref::<ApprovalOwnershipContended>()
                .is_some(),
            "{checkpoint}"
        );
        let admission = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            store.admit_objective_activation(request.clone()),
        )
        .await
        .expect("admission deadlocked")
        .unwrap_err();
        assert!(
            admission
                .downcast_ref::<ApprovalOwnershipContended>()
                .is_some(),
            "{admission}"
        );
        // The losing transaction released Objective as well as Thread locks.
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            sqlx::query("SELECT id FROM objectives WHERE id = $1 FOR UPDATE")
                .bind(&o.id)
                .fetch_one(&mut *held),
        )
        .await
        .expect("rollback retained Objective lock")
        .unwrap();
        held.rollback().await.unwrap();
        let current = store
            .get_thread_activation(&before.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(current.revision, before.revision);
        assert_eq!(current.status, ThreadActivationStatus::Running);
        assert_eq!(current.claimed_by, before.claimed_by);
        assert_eq!(current.lease_expires_at, before.lease_expires_at);
        assert!(store
            .get_thread_activation_approval_wait(&before.id)
            .await
            .unwrap()
            .is_none());
        assert!(store
            .get_objective_approval_wait(&o.id)
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            store
                .get_objective(&o.id)
                .await
                .unwrap()
                .unwrap()
                .evaluation_lease_expires_at,
            o.evaluation_lease_expires_at
        );
    }
    assert!(matches!(
        store.admit_objective_activation(request).await.unwrap(),
        ObjectiveMutation::Updated(_)
    ));
    checkpoint(&store, &batch).await;
    let row = sqlx::query(
        "SELECT COUNT(*) AS count FROM objective_approval_waits WHERE objective_id = $1",
    )
    .bind(&o.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.get::<i64, _>("count"), 1);
    for approval in &batch.approvals {
        assert!(store
            .get_approval(&approval.id)
            .await
            .unwrap()
            .unwrap()
            .grant_consumed_at
            .is_none());
    }
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires isolated MORPHZ_TEST_POSTGRES_URL"]
async fn postgres_supervisor_retries_ownership_in_place_and_rechecks_pause() {
    use morphz::event::InMemoryEventBus;
    use morphz::objective::{
        ActiveObjectiveEvaluation, ObjectiveEvaluationRegistry, ObjectiveSupervisor,
    };
    use morphz::timer::TimerEngine;
    use std::sync::Arc;

    let url = std::env::var("MORPHZ_TEST_POSTGRES_URL").unwrap();
    let store = Arc::new(
        morphz::memory::postgres::PostgresStore::new(&url, 4)
            .await
            .unwrap(),
    );
    let pool = sqlx::PgPool::connect(&url).await.unwrap();
    let mut batch = seed(store.as_ref(), "supervisor-locks").await;
    let o = objective(store.as_ref(), &batch, "supervisor-locks").await;
    let o = match store
        .renew_objective_evaluation(
            &o.id,
            o.active_evaluation_id.as_ref().unwrap(),
            Utc::now() + Duration::minutes(5),
        )
        .await
        .unwrap()
    {
        ObjectiveMutation::Updated(o) => o,
        other => panic!("{other:?}"),
    };
    bind(store.as_ref(), &mut batch, &o, false).await;
    let before = store
        .get_thread_activation(&batch.request.activation_id)
        .await
        .unwrap()
        .unwrap();
    let registry = Arc::new(ObjectiveEvaluationRegistry::default());
    registry.bind_activation(
        &before.id,
        ActiveObjectiveEvaluation {
            objective_id: o.id.clone(),
            evaluation_id: o.active_evaluation_id.clone().unwrap(),
            revision: o.revision,
            started_at: Utc::now(),
            pending_dependency_id: None,
        },
    );
    let supervisor = Arc::new(
        ObjectiveSupervisor::new(
            store.clone(),
            store.clone(),
            Arc::new(InMemoryEventBus::new()),
            registry.clone(),
            Arc::new(TimerEngine::new(store.clone())),
            std::time::Duration::from_secs(90),
        )
        .with_activation_store(store.clone())
        .with_scheduler_dependency_store(store.clone()),
    );
    for pause in [false, true] {
        let mut held = pool.begin().await.unwrap();
        sqlx::query("SELECT id FROM threads WHERE root_turn_id = $1 FOR UPDATE")
            .bind(&before.root_turn_id)
            .fetch_one(&mut *held)
            .await
            .unwrap();
        let waiter = {
            let supervisor = supervisor.clone();
            let o = o.clone();
            let a = before.clone();
            tokio::spawn(async move {
                supervisor
                    .admit_routed_evaluation(
                        &o.id,
                        o.active_evaluation_id.as_ref().unwrap(),
                        false,
                        &a.id,
                        a.claimed_by.as_ref().unwrap(),
                    )
                    .await
            })
        };
        tokio::time::sleep(std::time::Duration::from_millis(180)).await;
        assert!(
            !waiter.is_finished(),
            "contention escaped as a failed admission"
        );
        let current = store
            .get_thread_activation(&before.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(current.status, ThreadActivationStatus::Running);
        assert_eq!(current.revision, before.revision);
        assert_eq!(current.claimed_by, before.claimed_by);
        assert_eq!(current.lease_expires_at, before.lease_expires_at);
        assert!(registry.get_for_activation(&before.id).is_some());
        if pause {
            let current = store.get_objective(&o.id).await.unwrap().unwrap();
            assert!(matches!(
                store
                    .update_objective_state(
                        &o.id,
                        current.revision,
                        ObjectiveStatus::Paused,
                        None,
                        Some("pause during contention")
                    )
                    .await
                    .unwrap(),
                ObjectiveMutation::Updated(_)
            ));
        }
        held.rollback().await.unwrap();
        let admitted = tokio::time::timeout(std::time::Duration::from_secs(3), waiter)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            admitted, !pause,
            "retry must honor current durable authority"
        );
    }
    pool.close().await;
}
