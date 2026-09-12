//! Native infer dependencies use actual admitted Programs, Events and Signals.
//! No LLM, shell command, permission grant or ownership rewrite is involved.
use super::*;
use morphz::plan_execution::*;
use std::sync::Arc;

struct NoCalls;
#[async_trait::async_trait]
impl PlanCallPlanner for NoCalls {
    async fn plan_call(
        &self,
        _: &PlanExecutionRecord,
        _: &morphz::sexpr_eval::PlanEffect,
        _: &str,
    ) -> PlanExecutionResult<NewExecutionJob> {
        panic!("an infer-only Plan cannot execute physical effects")
    }
}

async fn child(
    store: Arc<dyn RuntimeStore>,
    parent: &mut Batch,
    label: &str,
    successor: bool,
) -> Batch {
    child_with_objective(store, parent, label, successor, None).await
}

pub(super) async fn child_with_objective(
    store: Arc<dyn RuntimeStore>,
    parent: &mut Batch,
    label: &str,
    successor: bool,
    objective: Option<(&ObjectiveRecord, &str)>,
) -> Batch {
    let a = store
        .get_thread_activation(&parent.request.activation_id)
        .await
        .unwrap()
        .unwrap();
    let t = store
        .get_thread_by_root(&a.root_turn_id)
        .await
        .unwrap()
        .unwrap();
    let registry = Arc::new(morphz::tool::Registry::new());
    let source = "(eval (infer (returns String) \"synthetic checkpoint child\"))";
    let program = morphz::sexpr_eval::validate(
        source,
        &registry,
        &morphz::sexpr_eval::AllowList::new(Vec::<String>::new()),
    )
    .unwrap();
    let coordinator = PlanExecutionCoordinator::new(store.clone(), registry);
    let queued = coordinator
        .ensure(
            PlanExecutionRoute {
                activation_id: a.id.clone(),
                thread_id: t.id.clone(),
                agent_id: a.agent_id.clone(),
                context_id: a.context_id.clone(),
                session_id: a.session_id.clone(),
                initiating_principal_id: None,
                tool_call_id: "infer-plan".into(),
                objective_id: objective.map(|(o, _)| o.id.clone()),
                objective_evaluation_id: objective
                    .and_then(|(o, _)| o.active_evaluation_id.clone()),
            },
            &program,
            PlanArtifactBinding::default(),
        )
        .await
        .unwrap();
    let mut call = store
        .query(QueryFilter {
            event_id: Some(parent.request.assistant_call_event_id.clone()),
            ..Default::default()
        })
        .await
        .unwrap()
        .pop()
        .unwrap();
    call.id = format!("infer-call-{label}");
    call.sequence = None;
    call.payload.get_mut("tool_calls").unwrap().as_array_mut().unwrap().push(json!({
        "id":"infer-plan","type":"function","function":{"name":"eval","arguments":json!({"program":source}).to_string()}
    }));
    parent.request.assistant_call_event_id = call.id.clone();
    store.append(call).await.unwrap();
    if let Some((o, dependency)) = objective {
        store
            .append(event(
                format!("selection-{label}"),
                "runtime/tool_calls_selected",
                "runtime_event",
                json!({
                    "context_id":a.context_id,"session_id":a.session_id,
                    "activation_id":a.id,"attempt_id":a.id,"thread_id":t.id,
                    "objective_id":o.id,"objective_evaluation_id":o.active_evaluation_id,
                    "objective_revision":o.revision,"objective_evaluation_started_at":Utc::now(),
                    "objective_pending_dependency_id":dependency
                }),
            ))
            .await
            .unwrap();
    }
    let (request, child_id) = match coordinator
        .drive_once(
            &queued.id,
            queued.revision,
            "fixture-plan",
            "fixture-claim",
            Utc::now() + Duration::minutes(1),
            &NoCalls,
        )
        .await
        .unwrap()
    {
        PlanDriveReceipt::WaitingForEvaluation {
            request_event,
            activation_id,
            ..
        } => (request_event, activation_id),
        other => panic!("{other:?}"),
    };
    let request = store
        .query(QueryFilter {
            event_id: Some(request.id.clone()),
            ..Default::default()
        })
        .await
        .unwrap()
        .pop()
        .unwrap();
    let thread = store
        .get_thread_by_root(&request.id)
        .await
        .unwrap()
        .unwrap();
    let initial = store
        .claim_thread_signal_batch(
            NewThreadSignal {
                id: stable_thread_signal_id(&request.id),
                thread_id: thread.id.clone(),
                thread_generation: thread.generation,
                event_id: request.id.clone(),
                principal_id: None,
                sequence: request.sequence.unwrap(),
                kind: request.topic.clone(),
                parent_activation_id: Some(a.id.clone()),
            },
            NewThreadActivation {
                id: child_id,
                agent_id: a.agent_id.clone(),
                context_id: a.context_id.clone(),
                session_id: a.session_id.clone(),
                initiating_principal_id: None,
                trigger_event_id: request.id.clone(),
                trigger_sequence: request.sequence.unwrap(),
                trigger_kind: request.topic,
                parent_activation_id: Some(a.id),
                root_turn_id: request.id.clone(),
            },
            1,
        )
        .await
        .unwrap()
        .unwrap();
    let current = if successor {
        assert!(matches!(
            store
                .update_thread_activation(
                    &initial.id,
                    initial.revision,
                    ThreadActivationStatus::Succeeded,
                    None,
                    None,
                    None
                )
                .await
                .unwrap(),
            ThreadActivationMutation::Updated(_)
        ));
        let next_event = event(
            format!("next-{label}"),
            "chat/tool_output",
            TYPE_TOOL_OUTPUT,
            json!({"context_id":initial.context_id,"session_id":initial.session_id,"attempt_id":initial.id}),
        );
        store.append(next_event.clone()).await.unwrap();
        let persisted = store
            .query(QueryFilter {
                event_id: Some(next_event.id.clone()),
                ..Default::default()
            })
            .await
            .unwrap()
            .pop()
            .unwrap();
        store
            .ensure_thread_activation(NewThreadActivation {
                id: format!("next-activation-{label}"),
                agent_id: initial.agent_id,
                context_id: initial.context_id,
                session_id: initial.session_id,
                initiating_principal_id: None,
                trigger_event_id: persisted.id,
                trigger_sequence: persisted.sequence.unwrap(),
                trigger_kind: persisted.topic,
                parent_activation_id: Some(initial.id),
                root_turn_id: request.id,
            })
            .await
            .unwrap()
    } else {
        initial
    };
    let running = match store
        .update_thread_activation(
            &current.id,
            current.revision,
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
    parent
        .request
        .pending_infer_activation_ids
        .push(running.id.clone());
    seed_running_batch(store.as_ref(), &running, label).await
}

async fn contract(store: Arc<dyn RuntimeStore>, prefix: &str) {
    for change in ["cancel", "pause", "activation", "signal"] {
        let label = format!("{prefix}-{change}");
        let mut parent = seed(store.as_ref(), &label).await;
        let leaf = child(store.clone(), &mut parent, &format!("{label}-leaf"), false).await;
        checkpoint(store.as_ref(), &leaf).await;
        checkpoint(store.as_ref(), &parent).await;
        assert_waiting(store.as_ref(), &parent).await;
        let a = store
            .get_thread_activation(&leaf.request.activation_id)
            .await
            .unwrap()
            .unwrap();
        let t = store
            .get_thread_by_root(&a.root_turn_id)
            .await
            .unwrap()
            .unwrap();
        if matches!(change, "cancel" | "pause") {
            assert!(matches!(
                store
                    .control_thread(
                        &t.id,
                        t.revision,
                        if change == "cancel" {
                            ThreadControlAction::Cancel
                        } else {
                            ThreadControlAction::Pause
                        },
                        Some("synthetic state change"),
                        Some("fixture")
                    )
                    .await
                    .unwrap(),
                ThreadMutation::Updated(_)
            ));
        } else {
            let e = event(
                format!("input-{label}"),
                "chat/user_message",
                "user_message",
                json!({"context_id":a.context_id,"session_id":a.session_id,"root_turn_id":a.root_turn_id,"text":"synthetic directed input"}),
            );
            store.append(e.clone()).await.unwrap();
            let e = store
                .query(QueryFilter {
                    event_id: Some(e.id),
                    ..Default::default()
                })
                .await
                .unwrap()
                .pop()
                .unwrap();
            let new = NewThreadActivation {
                id: format!("new-{label}"),
                agent_id: a.agent_id,
                context_id: a.context_id,
                session_id: a.session_id,
                initiating_principal_id: None,
                trigger_event_id: e.id.clone(),
                trigger_sequence: e.sequence.unwrap(),
                trigger_kind: e.topic.clone(),
                parent_activation_id: Some(a.id),
                root_turn_id: a.root_turn_id,
            };
            if change == "activation" {
                store.ensure_thread_activation(new).await.unwrap();
            } else {
                assert!(store
                    .claim_thread_signal_batch(
                        NewThreadSignal {
                            id: stable_thread_signal_id(&e.id),
                            thread_id: t.id,
                            thread_generation: t.generation,
                            event_id: e.id,
                            principal_id: None,
                            sequence: e.sequence.unwrap(),
                            kind: e.topic,
                            parent_activation_id: new.parent_activation_id.clone(),
                        },
                        new,
                        1
                    )
                    .await
                    .unwrap()
                    .is_none());
            }
        }
        assert!(
            store
                .dialogue_turn_activation_runnable(&parent.request.activation_id)
                .await
                .unwrap(),
            "child {change} must invalidate the ancestor wait"
        );
    }
    for successor in [false, true] {
        let label = format!("{prefix}-{successor}");
        let mut parent = seed(store.as_ref(), &label).await;
        let mut middle = child(
            store.clone(),
            &mut parent,
            &format!("{label}-mid"),
            successor,
        )
        .await;
        let leaf = child(store.clone(), &mut middle, &format!("{label}-leaf"), false).await;
        // Running children cannot justify suspension, even with pending human Jobs.
        assert!(store
            .suspend_thread_activation_for_approval(parent.request.clone())
            .await
            .is_err());
        assert!(store
            .suspend_thread_activation_for_approval(middle.request.clone())
            .await
            .is_err());
        checkpoint(store.as_ref(), &leaf).await;
        checkpoint(store.as_ref(), &middle).await;
        let mut duplicate = parent.request.clone();
        duplicate
            .pending_infer_activation_ids
            .push(duplicate.pending_infer_activation_ids[0].clone());
        assert!(store
            .suspend_thread_activation_for_approval(duplicate)
            .await
            .is_err());
        let mut unrelated = parent.request.clone();
        unrelated.pending_infer_activation_ids = vec![leaf.request.activation_id.clone()];
        assert!(store
            .suspend_thread_activation_for_approval(unrelated)
            .await
            .is_err());
        checkpoint(store.as_ref(), &parent).await;
        for batch in [&parent, &middle, &leaf] {
            assert_waiting(store.as_ref(), batch).await;
            let saved = store
                .get_thread_activation_approval_wait(&batch.request.activation_id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                saved.infer_activation_ids,
                batch.request.pending_infer_activation_ids
            );
        }
        // One deepest decision must wake every ancestor immediately, before any
        // child claims or reconciles its pending Job. Direct parent waits remain.
        store
            .commit_approval_decision(
                &leaf.approvals[0].id,
                leaf.approvals[0].revision,
                ApprovalResolution::Deny {
                    rationale: "synthetic decision".into(),
                    risk_tags: vec![],
                },
            )
            .await
            .unwrap();
        for batch in [&leaf, &middle, &parent] {
            assert!(store
                .dialogue_turn_activation_runnable(&batch.request.activation_id)
                .await
                .unwrap());
        }
        let owner = store
            .get_thread(&parent.jobs[0].thread_id)
            .await
            .unwrap()
            .unwrap();
        store
            .control_thread(
                &owner.id,
                owner.revision,
                ThreadControlAction::Cancel,
                Some("fixture cleanup"),
                Some("fixture"),
            )
            .await
            .unwrap();
        assert!(store
            .get_thread_activation_approval_wait(&parent.request.activation_id)
            .await
            .unwrap()
            .is_none());
    }
    // The transactional proof must handle a deepest decision racing suspension.
    for i in 0..16 {
        let label = format!("{prefix}-race-{i}");
        let mut parent = seed(store.as_ref(), &label).await;
        let leaf = child(store.clone(), &mut parent, &format!("{label}-leaf"), false).await;
        checkpoint(store.as_ref(), &leaf).await;
        let child_thread = store
            .get_thread(&leaf.jobs[0].thread_id)
            .await
            .unwrap()
            .unwrap();
        let (suspension, decision) = tokio::join!(
            store.suspend_thread_activation_for_approval(parent.request.clone()),
            async {
                if i % 2 == 0 {
                    store
                        .commit_approval_decision(
                            &leaf.approvals[0].id,
                            leaf.approvals[0].revision,
                            ApprovalResolution::Deny {
                                rationale: "concurrent fixture".into(),
                                risk_tags: vec![],
                            },
                        )
                        .await?;
                } else {
                    store
                        .control_thread(
                            &child_thread.id,
                            child_thread.revision,
                            ThreadControlAction::Cancel,
                            Some("concurrent fixture"),
                            Some("fixture"),
                        )
                        .await?;
                }
                Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
            },
        );
        decision.unwrap();
        match suspension {
            Ok(ThreadActivationMutation::Updated(_)) => assert!(store
                .dialogue_turn_activation_runnable(&parent.request.activation_id)
                .await
                .unwrap()),
            Err(error) => assert!(
                error
                    .downcast_ref::<ActivationApprovalWaitChanged>()
                    .is_some(),
                "{error}"
            ),
            other => panic!("{other:?}"),
        }
    }
}

#[tokio::test]
async fn sqlite_infer_approval_dependencies_wake_ancestors() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Arc::new(
        SqliteStore::new(tmp.path().join("infer.sqlite").to_str().unwrap())
            .await
            .unwrap(),
    );
    contract(store, "sqlite-infer").await;
}

#[tokio::test]
#[ignore = "requires MORPHZ_TEST_POSTGRES_URL pointing to an isolated disposable schema"]
async fn postgres_infer_approval_dependencies_wake_ancestors() {
    let url = std::env::var("MORPHZ_TEST_POSTGRES_URL").unwrap();
    let store = Arc::new(
        morphz::memory::postgres::PostgresStore::new(&url, 4)
            .await
            .unwrap(),
    );
    contract(
        store,
        &format!("pg-infer-{}", Utc::now().timestamp_nanos_opt().unwrap()),
    )
    .await;
}
