//! Native cancellation must close owned Plans without a running reconciler.
use chrono::{Duration, Utc};
use morphz::event::Event;
use morphz::memory::{sqlite::SqliteStore, *};
use serde_json::json;

async fn seed(store: &dyn RuntimeStore, label: &str) -> NewPlanExecution {
    let agent = format!("agent-{label}");
    let context = format!("context-{label}");
    let session = format!("session-{label}");
    store
        .create_agent_bundle(
            NewAgent {
                id: agent.clone(),
                title: label.into(),
                root_context_id: context.clone(),
            },
            NewCognitiveContext {
                id: context.clone(),
                agent_id: agent.clone(),
                title: label.into(),
            },
            NewSession {
                id: session.clone(),
                agent_id: agent.clone(),
                context_id: context.clone(),
                parent_session_id: None,
                title: label.into(),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await
        .unwrap();
    let thread = format!("thread-{label}");
    let root = format!("root-{label}");
    let activation = format!("activation-{label}");
    store
        .ensure_thread(NewThread {
            id: thread.clone(),
            agent_id: agent.clone(),
            context_id: context.clone(),
            session_id: session.clone(),
            initiating_principal_id: None,
            root_turn_id: root.clone(),
            kind: ThreadKind::Execution,
            executor_kind: "self".into(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::runtime("plan-cancel-test"),
        })
        .await
        .unwrap();
    store
        .ensure_thread_activation(NewThreadActivation {
            id: activation.clone(),
            agent_id: agent.clone(),
            context_id: context.clone(),
            session_id: session.clone(),
            initiating_principal_id: None,
            trigger_event_id: root.clone(),
            trigger_sequence: 1,
            trigger_kind: "runtime/plan".into(),
            parent_activation_id: None,
            root_turn_id: root,
        })
        .await
        .unwrap();
    NewPlanExecution {
        id: format!("plan-{label}"),
        activation_id: activation,
        thread_id: thread,
        agent_id: agent,
        context_id: context,
        session_id: session,
        initiating_principal_id: None,
        tool_call_id: format!("call-{label}"),
        objective_id: None,
        objective_evaluation_id: None,
        harness_id: None,
        harness_version: None,
        source_artifact_hash: format!("sha256:{label}"),
        ir_schema_version: 1,
        program_json: json!({"synthetic":true}),
        state_json: json!({"steps":[]}),
        budget_json: json!({"steps_remaining":100}),
    }
}

fn updated(mutation: PlanExecutionMutation) -> PlanExecutionRecord {
    match mutation {
        PlanExecutionMutation::Updated(p) => p,
        other => panic!("{other:?}"),
    }
}

async fn cancel(store: &dyn RuntimeStore, thread: &ThreadRecord) {
    assert!(matches!(
        store
            .control_thread(
                &thread.id,
                thread.revision,
                ThreadControlAction::Cancel,
                Some("synthetic cancellation"),
                Some("Test")
            )
            .await
            .unwrap(),
        ThreadMutation::Updated(_)
    ));
}

fn assert_closed(p: &PlanExecutionRecord) {
    assert_eq!(p.status, PlanExecutionStatus::Cancelled, "{}", p.id);
    assert!(p.pending_kind.is_none() && p.pending_id.is_none());
    assert!(p.claimed_by.is_none() && p.claim_token.is_none() && p.lease_expires_at.is_none());
    assert!(p.finished_at.is_some());
    assert_eq!(p.error.as_deref(), Some("synthetic cancellation"));
}

fn group_request(plan: &NewPlanExecution) -> (NewActionGroup, Vec<NewActionGroupMember>) {
    (
        NewActionGroup {
            id: format!("group-{}", plan.id),
            activation_id: plan.activation_id.clone(),
            thread_id: plan.thread_id.clone(),
            agent_id: plan.agent_id.clone(),
            context_id: plan.context_id.clone(),
            session_id: plan.session_id.clone(),
            assistant_call_event_id: format!("group-call-{}", plan.id),
            objective_id: None,
            objective_evaluation_id: None,
            objective_revision: None,
        },
        (0..2)
            .map(|ordinal| NewActionGroupMember {
                ordinal,
                tool_call_id: format!("branch-{ordinal}"),
                tool_name: "read".into(),
                execution_job_id: None,
            })
            .collect(),
    )
}

fn group_event(group: &NewActionGroup, index: Option<usize>) -> Event {
    let topic = if index.is_some() {
        "tool/read"
    } else {
        "runtime/action_group_settled"
    };
    let mut payload = json!({ "action_group_id":group.id, "context_id":group.context_id,
        "session_id":group.session_id, "thread_id":group.thread_id, "activation_id":group.activation_id,
        "wake_policy":"direct_signal", "output":"synthetic result" });
    if let Some(i) = index {
        payload["tool_call_id"] = json!(format!("branch-{i}"));
    }
    Event::new(
        format!(
            "{}-{}",
            group.id,
            index.map_or("settled".into(), |i| i.to_string())
        ),
        "Test".into(),
        "tool_output".into(),
        topic.into(),
        payload.as_object().unwrap().clone(),
    )
}

async fn persist_group_call(store: &dyn RuntimeStore, group: &NewActionGroup) {
    store
        .append(Event::new(
            group.assistant_call_event_id.clone(),
            "Test".into(),
            morphz::event::TYPE_AGENT_CALL.into(),
            "chat/assistant_call".into(),
            json!({"context_id":group.context_id, "session_id":group.session_id,
            "activation_id":group.activation_id, "thread_id":group.thread_id})
            .as_object()
            .unwrap()
            .clone(),
        ))
        .await
        .unwrap();
}

async fn group_cancellation_contract(store: &dyn RuntimeStore, label: &str) {
    let plan = seed(store, label).await;
    let thread = store.get_thread(&plan.thread_id).await.unwrap().unwrap();
    let (group, members) = group_request(&plan);
    persist_group_call(store, &group).await;
    store
        .create_action_group(group.clone(), members.clone())
        .await
        .unwrap();
    let first = group_event(&group, Some(0));
    let settled = group_event(&group, None);
    let before = store
        .commit_action_group_member_result(
            &group.id,
            "branch-0",
            ActionGroupMemberStatus::Succeeded,
            &first,
            &settled,
        )
        .await
        .unwrap();
    cancel(store, &thread).await;
    let closed = store.get_action_group(&group.id).await.unwrap().unwrap();
    assert_eq!(closed.status, ActionGroupStatus::Cancelled);
    assert_eq!(closed.terminal_member_count, 1);
    assert!(closed.settled_at.is_some());
    assert_eq!(
        store
            .create_action_group(group.clone(), members.clone())
            .await
            .unwrap(),
        closed
    );
    let replay = store
        .commit_action_group_member_result(
            &group.id,
            "branch-0",
            ActionGroupMemberStatus::Succeeded,
            &first,
            &settled,
        )
        .await
        .unwrap();
    assert_eq!(replay.member, before.member);
    assert!(replay.existing);
    let remaining = store.list_action_group_members(&group.id).await.unwrap();
    assert_eq!(remaining[1].status, ActionGroupMemberStatus::Pending);
    assert!(
        remaining[1].result_event_id.is_none(),
        "do not manufacture unobserved member results"
    );
    let late_result = store
        .commit_action_group_member_result(
            &group.id,
            "branch-1",
            ActionGroupMemberStatus::Succeeded,
            &group_event(&group, Some(1)),
            &settled,
        )
        .await
        .unwrap();
    assert!(!late_result.settled_now);
    assert_eq!(late_result.group.status, ActionGroupStatus::Cancelled);
    assert_eq!(late_result.group.terminal_member_count, 2);
    assert!(store
        .query(QueryFilter {
            event_id: Some(settled.id.clone()),
            ..Default::default()
        })
        .await
        .unwrap()
        .is_empty());
    let mut late = group.clone();
    late.id.push_str("-late");
    late.assistant_call_event_id.push_str("-late");
    assert!(store
        .create_action_group(late.clone(), members)
        .await
        .is_err());
    assert!(store.get_action_group(&late.id).await.unwrap().is_none());
}

async fn group_races_cancel(store: &dyn RuntimeStore, label: &str) {
    for i in 0..12 {
        let plan = seed(store, &format!("{label}-{i}")).await;
        let thread = store.get_thread(&plan.thread_id).await.unwrap().unwrap();
        let (group, members) = group_request(&plan);
        persist_group_call(store, &group).await;
        let (created, ()) = tokio::join!(
            store.create_action_group(group.clone(), members),
            cancel(store, &thread)
        );
        let saved = store.get_action_group(&group.id).await.unwrap();
        match created {
            Ok(_) => assert_eq!(saved.unwrap().status, ActionGroupStatus::Cancelled),
            Err(e) => {
                assert!(e.to_string().contains("live owner"), "{e}");
                assert!(saved.is_none());
            }
        }
    }
    for i in 0..12 {
        let plan = seed(store, &format!("{label}-settle-{i}")).await;
        let thread = store.get_thread(&plan.thread_id).await.unwrap().unwrap();
        let (group, members) = group_request(&plan);
        persist_group_call(store, &group).await;
        store
            .create_action_group(group.clone(), members)
            .await
            .unwrap();
        let settled = group_event(&group, None);
        store
            .commit_action_group_member_result(
                &group.id,
                "branch-0",
                ActionGroupMemberStatus::Succeeded,
                &group_event(&group, Some(0)),
                &settled,
            )
            .await
            .unwrap();
        let second = group_event(&group, Some(1));
        let (result, ()) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::join!(
                store.commit_action_group_member_result(
                    &group.id,
                    "branch-1",
                    ActionGroupMemberStatus::Succeeded,
                    &second,
                    &settled
                ),
                cancel(store, &thread)
            )
        })
        .await
        .expect("settlement/cancellation lock order must not deadlock");
        let closed = store.get_action_group(&group.id).await.unwrap().unwrap();
        let receipt = result.unwrap();
        assert_eq!(closed.terminal_member_count, 2);
        assert_eq!(
            closed.status,
            if receipt.settled_now {
                ActionGroupStatus::Settled
            } else {
                ActionGroupStatus::Cancelled
            }
        );
    }
}

async fn cancellation_contract(store: &dyn RuntimeStore, label: &str) -> Vec<String> {
    let new = seed(store, label).await;
    let thread = store.get_thread(&new.thread_id).await.unwrap().unwrap();
    let mut live = Vec::new();
    let mut terminal = None;
    for i in 0..7 {
        let mut request = new.clone();
        request.id = format!("{}-{i}", new.id);
        request.tool_call_id = format!("{}-{i}", new.tool_call_id);
        let mut plan = store.create_plan_execution(request).await.unwrap();
        if i > 0 {
            plan = updated(
                store
                    .claim_plan_execution(
                        &plan.id,
                        plan.revision,
                        "old-worker",
                        "old-claim",
                        Utc::now() + Duration::minutes(1),
                    )
                    .await
                    .unwrap(),
            );
        }
        if (2..6).contains(&i) {
            let kind = [
                PlanExecutionWaitKind::ExecutionJob,
                PlanExecutionWaitKind::Evaluation,
                PlanExecutionWaitKind::ActionGroup,
                PlanExecutionWaitKind::PlanExecution,
            ][i - 2];
            plan = updated(
                store
                    .suspend_plan_execution(
                        &plan.id,
                        plan.revision,
                        "old-claim",
                        &plan.state_json,
                        &plan.budget_json,
                        kind,
                        "synthetic-child",
                    )
                    .await
                    .unwrap(),
            );
        } else if i == 6 {
            plan = updated(
                store
                    .finish_plan_execution(
                        &plan.id,
                        plan.revision,
                        "old-claim",
                        PlanExecutionStatus::Succeeded,
                        &plan.state_json,
                        &plan.budget_json,
                        Some(&json!({"completed":true})),
                        None,
                    )
                    .await
                    .unwrap(),
            );
            terminal = Some(plan);
            continue;
        }
        live.push(plan);
    }
    // A different Thread in the SAME Session must remain untouched.
    let mut sibling = new.clone();
    sibling.id.push_str("-sibling");
    sibling.thread_id.push_str("-sibling");
    sibling.activation_id.push_str("-sibling");
    store
        .ensure_thread(NewThread {
            id: sibling.thread_id.clone(),
            agent_id: new.agent_id.clone(),
            context_id: new.context_id.clone(),
            session_id: new.session_id.clone(),
            initiating_principal_id: None,
            root_turn_id: format!("sibling-root-{label}"),
            kind: ThreadKind::Execution,
            executor_kind: "self".into(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::runtime("plan-cancel-test"),
        })
        .await
        .unwrap();
    store
        .ensure_thread_activation(NewThreadActivation {
            id: sibling.activation_id.clone(),
            agent_id: new.agent_id.clone(),
            context_id: new.context_id.clone(),
            session_id: new.session_id.clone(),
            initiating_principal_id: None,
            trigger_event_id: format!("sibling-root-{label}"),
            trigger_sequence: 1,
            trigger_kind: "runtime/plan".into(),
            parent_activation_id: None,
            root_turn_id: format!("sibling-root-{label}"),
        })
        .await
        .unwrap();
    let sibling_plan = store.create_plan_execution(sibling.clone()).await.unwrap();
    assert!(matches!(
        store
            .control_thread(
                &thread.id,
                thread.revision + 100,
                ThreadControlAction::Cancel,
                None,
                None
            )
            .await
            .unwrap(),
        ThreadMutation::Conflict { .. }
    ));
    for p in &live {
        assert_eq!(
            store.get_plan_execution(&p.id).await.unwrap().as_ref(),
            Some(p)
        );
    }
    cancel(store, &thread).await;
    for old in &live {
        let closed = store.get_plan_execution(&old.id).await.unwrap().unwrap();
        assert_closed(&closed);
        assert_eq!(closed.revision, old.revision + 1);
        assert!(!matches!(
            store
                .claim_plan_execution(
                    &old.id,
                    old.revision,
                    "late-worker",
                    "late-claim",
                    Utc::now() + Duration::minutes(1)
                )
                .await
                .unwrap(),
            PlanExecutionMutation::Updated(_)
        ));
        if old.status == PlanExecutionStatus::Running {
            assert!(!matches!(
                store
                    .finish_plan_execution(
                        &old.id,
                        old.revision,
                        "old-claim",
                        PlanExecutionStatus::Succeeded,
                        &old.state_json,
                        &old.budget_json,
                        Some(&json!("late")),
                        None
                    )
                    .await
                    .unwrap(),
                PlanExecutionMutation::Updated(_)
            ));
        }
    }
    let terminal = terminal.unwrap();
    assert_eq!(
        store.get_plan_execution(&terminal.id).await.unwrap(),
        Some(terminal)
    );
    assert_eq!(
        store.get_plan_execution(&sibling_plan.id).await.unwrap(),
        Some(sibling_plan)
    );
    // Replaying an existing causal key is still valid after cancellation.
    let mut replay = new.clone();
    replay.id.push_str("-0");
    replay.tool_call_id.push_str("-0");
    assert_closed(&store.create_plan_execution(replay).await.unwrap());
    assert!(
        store.create_plan_execution(new.clone()).await.is_err(),
        "late child must not be created"
    );
    assert!(store.get_plan_execution(&new.id).await.unwrap().is_none());
    let mut wrong_route = sibling.clone();
    wrong_route.id.push_str("-wrong");
    wrong_route.tool_call_id.push_str("-wrong");
    wrong_route.thread_id = new.thread_id;
    assert!(store.create_plan_execution(wrong_route).await.is_err());
    live.into_iter().map(|p| p.id).collect()
}

async fn creation_races_cancel(store: &dyn RuntimeStore, label: &str) {
    for i in 0..12 {
        let new = seed(store, &format!("{label}-{i}")).await;
        let thread = store.get_thread(&new.thread_id).await.unwrap().unwrap();
        let (created, ()) = tokio::join!(
            store.create_plan_execution(new.clone()),
            cancel(store, &thread)
        );
        let persisted = store.get_plan_execution(&new.id).await.unwrap();
        match created {
            Ok(_) => assert_closed(&persisted.unwrap()),
            Err(error) => {
                assert!(error.to_string().contains("live owner"), "{error}");
                assert!(persisted.is_none());
            }
        }
    }
}

async fn job_handoff_races_cancel(store: &dyn RuntimeStore, label: &str) {
    for i in 0..12 {
        let new = seed(store, &format!("{label}-{i}")).await;
        let thread = store.get_thread(&new.thread_id).await.unwrap().unwrap();
        let queued = store.create_plan_execution(new.clone()).await.unwrap();
        let plan = updated(
            store
                .claim_plan_execution(
                    &queued.id,
                    queued.revision,
                    "worker",
                    "claim",
                    Utc::now() + Duration::minutes(1),
                )
                .await
                .unwrap(),
        );
        let job = NewExecutionJob {
            id: format!("job-{}", new.id),
            activation_id: new.activation_id,
            thread_id: new.thread_id,
            agent_id: new.agent_id,
            context_id: new.context_id,
            session_id: new.session_id,
            initiating_principal_id: None,
            target_id: morphz::execution_target::DEFAULT_EXECUTION_TARGET_ID.into(),
            tool_call_id: new.tool_call_id,
            tool_name: "read".into(),
            request: json!({"path":"synthetic"}),
            retry_safety: ExecutionRetrySafety::Idempotent,
            requires_approval: false,
        };
        let job_id = job.id.clone();
        let (handoff, ()) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::join!(
                store.create_execution_job_and_suspend_plan(
                    &plan.id,
                    plan.revision,
                    "claim",
                    &plan.state_json,
                    &plan.budget_json,
                    job
                ),
                cancel(store, &thread)
            )
        })
        .await
        .expect("physical handoff and cancellation must share the owner-first lock order");
        assert_closed(&store.get_plan_execution(&plan.id).await.unwrap().unwrap());
        let child = store.get_execution_job(&job_id).await.unwrap();
        match handoff {
            Ok(_) => assert!(child.unwrap().side_effect_started_at.is_none()),
            Err(e) => {
                assert!(e.to_string().contains("cancelled"), "{e}");
                assert!(child.is_none());
            }
        }
    }
}

async fn infer_reconciliation_races_cancel(store: &dyn RuntimeStore, label: &str) {
    for cancel_child in [false, true] {
        for i in 0..6 {
            let new = seed(store, &format!("{label}-{cancel_child}-{i}")).await;
            let queued = store.create_plan_execution(new.clone()).await.unwrap();
            let running = updated(
                store
                    .claim_plan_execution(
                        &queued.id,
                        queued.revision,
                        "worker",
                        "claim",
                        Utc::now() + Duration::minutes(1),
                    )
                    .await
                    .unwrap(),
            );
            let event_id = format!("infer-{}", new.id);
            let activation_id =
                morphz::plan_execution::deterministic_infer_activation_id(&event_id).unwrap();
            let request = Event::new(event_id.clone(), "Test".into(), morphz::event::TYPE_INFER_REQUEST.into(),
                "chat/infer_request".into(), json!({"agent_id":new.agent_id, "context_id":new.context_id,
                    "session_id":new.session_id, "plan_execution_id":new.id,
                    "parent_activation_id":new.activation_id, "root_turn_id":event_id, "text":"synthetic infer"})
                    .as_object().unwrap().clone());
            store
                .create_evaluation_and_suspend_plan(
                    &running.id,
                    running.revision,
                    "claim",
                    &running.state_json,
                    &running.budget_json,
                    &request,
                    &activation_id,
                )
                .await
                .unwrap();
            let persisted = store
                .query(QueryFilter {
                    event_id: Some(event_id.clone()),
                    ..Default::default()
                })
                .await
                .unwrap()
                .pop()
                .unwrap();
            let child = store.get_thread_by_root(&event_id).await.unwrap().unwrap();
            let sequence = persisted.sequence.unwrap();
            let activation = store
                .claim_thread_signal_batch(
                    NewThreadSignal {
                        id: stable_thread_signal_id(&event_id),
                        thread_id: child.id.clone(),
                        thread_generation: child.generation,
                        event_id: event_id.clone(),
                        principal_id: None,
                        sequence,
                        kind: request.topic.clone(),
                        parent_activation_id: Some(new.activation_id.clone()),
                    },
                    NewThreadActivation {
                        id: activation_id.clone(),
                        agent_id: new.agent_id.clone(),
                        context_id: new.context_id.clone(),
                        session_id: new.session_id.clone(),
                        initiating_principal_id: None,
                        trigger_event_id: event_id.clone(),
                        trigger_sequence: sequence,
                        trigger_kind: request.topic.clone(),
                        parent_activation_id: Some(new.activation_id.clone()),
                        root_turn_id: event_id,
                    },
                    1,
                )
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                store
                    .reconcile_plan_evaluation_activation(&running.id, &activation_id)
                    .await
                    .unwrap()
                    .unwrap()
                    .id,
                activation.id
            );
            let target = if cancel_child {
                child
            } else {
                store.get_thread(&new.thread_id).await.unwrap().unwrap()
            };
            let (reconciled, ()) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                tokio::join!(
                    store.reconcile_plan_evaluation_activation(&running.id, &activation_id),
                    cancel(store, &target)
                )
            })
            .await
            .expect("infer reconciliation must not deadlock with parent or child cancellation");
            if !cancel_child {
                assert_closed(
                    &store
                        .get_plan_execution(&running.id)
                        .await
                        .unwrap()
                        .unwrap(),
                );
            }
            match reconciled {
                Ok(activation) => assert!(activation.is_some()),
                Err(e) => {
                    // This gate checks lock ordering, not infer-cancellation
                    // propagation. Cancellation may invalidate the exact
                    // generation route, but must not produce a database error.
                    let reason = e.to_string();
                    assert!(reason.contains("没有等待 child Activation")
                        || reason == "PlanExecution route is inconsistent with deterministic infer Activation"
                        || reason == "PlanExecution route is inconsistent with deterministic infer Signal"
                        || reason == "PlanExecution route is inconsistent with the existing parent Activation",
                        "{reason}");
                }
            }
        }
    }
}

#[tokio::test]
async fn sqlite_plan_owner_cancellation_survives_reopen_without_reconciler() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("store.sqlite");
    let store = SqliteStore::new(path.to_str().unwrap()).await.unwrap();
    let ids = cancellation_contract(&store, "sqlite-close").await;
    drop(store);
    let reopened = SqliteStore::new(path.to_str().unwrap()).await.unwrap();
    for id in ids {
        assert_closed(&reopened.get_plan_execution(&id).await.unwrap().unwrap());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_plan_creation_races_owner_cancellation() {
    let tmp = tempfile::tempdir().unwrap();
    let store = SqliteStore::new(tmp.path().join("store.sqlite").to_str().unwrap())
        .await
        .unwrap();
    creation_races_cancel(&store, "sqlite-race").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_action_group_owner_cancellation_and_races() {
    let tmp = tempfile::tempdir().unwrap();
    let store = SqliteStore::new(tmp.path().join("store.sqlite").to_str().unwrap())
        .await
        .unwrap();
    group_cancellation_contract(&store, "sqlite-group").await;
    group_races_cancel(&store, "sqlite-group-race").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_plan_job_handoff_races_owner_cancellation() {
    let tmp = tempfile::tempdir().unwrap();
    let store = SqliteStore::new(tmp.path().join("store.sqlite").to_str().unwrap())
        .await
        .unwrap();
    job_handoff_races_cancel(&store, "sqlite-handoff").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_infer_reconciliation_races_parent_and_child_cancellation() {
    let tmp = tempfile::tempdir().unwrap();
    let store = SqliteStore::new(tmp.path().join("store.sqlite").to_str().unwrap())
        .await
        .unwrap();
    infer_reconciliation_races_cancel(&store, "sqlite-infer").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MORPHZ_TEST_POSTGRES_URL pointing to an isolated disposable database"]
async fn postgres_plan_owner_cancellation_matches_sqlite() {
    let url = std::env::var("MORPHZ_TEST_POSTGRES_URL")
        .expect("explicit disposable PostgreSQL URL required");
    let store = morphz::memory::postgres::PostgresStore::new(&url, 4)
        .await
        .unwrap();
    let label = format!("pg-{}", Utc::now().timestamp_nanos_opt().unwrap());
    cancellation_contract(&store, &label).await;
    creation_races_cancel(&store, &format!("{label}-race")).await;
    group_cancellation_contract(&store, &format!("{label}-group")).await;
    group_races_cancel(&store, &format!("{label}-group-race")).await;
    job_handoff_races_cancel(&store, &format!("{label}-handoff")).await;
    infer_reconciliation_races_cancel(&store, &format!("{label}-infer")).await;
}
