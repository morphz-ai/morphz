//! Build real admitted Plan machines, never fabricated continuation state.
use super::*;
use morphz::plan_execution::*;
use morphz::sexpr_eval::{AllowList, PlanEffect};
use morphz::tool::{Registry, Tool};
use std::sync::Arc;

struct FixtureRead;
#[async_trait::async_trait]
impl Tool for FixtureRead {
    fn name(&self) -> &str {
        "read"
    }
    fn definition(&self) -> morphz::llm::ToolDefinition {
        morphz::llm::ToolDefinition {
            name: "read".into(),
            description: "synthetic read".into(),
            parameters: json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}),
        }
    }
    async fn execute(&self, _: &str) -> PlanExecutionResult<String> {
        panic!("native checkpoint validation must never execute a tool")
    }
}

struct HumanPlanner;
#[async_trait::async_trait]
impl PlanCallPlanner for HumanPlanner {
    async fn plan_call(
        &self,
        plan: &PlanExecutionRecord,
        effect: &PlanEffect,
        call_id: &str,
    ) -> PlanExecutionResult<NewExecutionJob> {
        let PlanEffect::Call {
            tool, arguments, ..
        } = effect
        else {
            panic!("not a Call")
        };
        Ok(NewExecutionJob {
            id: morphz::execution::deterministic_job_id(&plan.activation_id, call_id)?,
            activation_id: plan.activation_id.clone(),
            thread_id: plan.thread_id.clone(),
            agent_id: plan.agent_id.clone(),
            context_id: plan.context_id.clone(),
            session_id: plan.session_id.clone(),
            initiating_principal_id: plan.initiating_principal_id.clone(),
            target_id: morphz::execution_target::DEFAULT_EXECUTION_TARGET_ID.into(),
            tool_call_id: call_id.into(),
            tool_name: tool.clone(),
            request: json!({"arguments":arguments}),
            retry_safety: ExecutionRetrySafety::Idempotent,
            requires_approval: true,
        })
    }
}

async fn drive(c: &PlanExecutionCoordinator, plan: &PlanExecutionRecord) -> PlanDriveReceipt {
    c.drive_once(
        &plan.id,
        plan.revision,
        "fixture-plan",
        "fixture-claim",
        Utc::now() + Duration::minutes(1),
        &HumanPlanner,
    )
    .await
    .unwrap()
}

// Mixed outer batch: two direct approval waits, a completed direct read, and
// a real eval root containing serial or parallel physical effects.
pub(super) async fn nested(
    store: Arc<dyn RuntimeStore>,
    label: &str,
    parallel: bool,
) -> (Batch, PlanExecutionCoordinator, Vec<PlanExecutionRecord>) {
    let mut batch = seed(store.as_ref(), label).await;
    let registry = Arc::new(Registry::new());
    registry.register(Arc::new(FixtureRead));
    let source = if parallel {
        r#"(eval (requires (tools read)) (par (branch a (call read (path "a"))) (branch done (add 20 22)) (branch b (call read (path "b")))))"#
    } else {
        r#"(eval (requires (tools read)) (call read (path "a")))"#
    };
    let program =
        morphz::sexpr_eval::validate(source, &registry, &AllowList::new(["read"])).unwrap();
    let job = &batch.jobs[0];
    let coordinator = PlanExecutionCoordinator::new(store.clone(), registry);
    let root = coordinator
        .ensure(
            PlanExecutionRoute {
                activation_id: job.activation_id.clone(),
                thread_id: job.thread_id.clone(),
                agent_id: job.agent_id.clone(),
                context_id: job.context_id.clone(),
                session_id: job.session_id.clone(),
                initiating_principal_id: None,
                tool_call_id: "eval-root".into(),
                objective_id: None,
                objective_evaluation_id: None,
            },
            &program,
            PlanArtifactBinding::default(),
        )
        .await
        .unwrap();
    batch.request.assistant_call_event_id = format!("nested-call-{label}");
    store.append(event(batch.request.assistant_call_event_id.clone(), "chat/assistant_call", "agent_call", json!({
        "context_id":job.context_id,"session_id":job.session_id,"attempt_id":job.activation_id,
        "tool_calls":[
            {"id":"exec-0","type":"function","function":{"name":"exec","arguments":"{}"}},
            {"id":"exec-1","type":"function","function":{"name":"exec","arguments":"{}"}},
            {"id":"read-done","type":"function","function":{"name":"read","arguments":"{}"}},
            {"id":"eval-root","type":"function","function":{"name":"eval","arguments":json!({"program":source}).to_string()}}
        ]
    }))).await.unwrap();
    // An unstarted, registered Plan is not a human wait checkpoint.
    assert!(store
        .suspend_thread_activation_for_approval(batch.request.clone())
        .await
        .is_err());
    let mut frontier = vec![root];
    let mut waiting = Vec::new();
    while let Some(plan) = frontier.pop() {
        match drive(&coordinator, &plan).await {
            PlanDriveReceipt::WaitingForActionGroup {
                plan,
                group,
                children,
                ..
            } => {
                let requests = store
                    .query(QueryFilter {
                        event_id: Some(group.assistant_call_event_id.clone()),
                        ..Default::default()
                    })
                    .await
                    .unwrap();
                assert_eq!(requests.len(), 1);
                assert_eq!(requests[0].topic, "runtime/plan_parallel_request");
                assert_eq!(requests[0].payload["action_group_id"], group.id);
                let replay = coordinator
                    .ensure_parallel_children_for_waiting(&plan)
                    .await
                    .unwrap();
                assert_eq!(
                    replay.iter().map(|p| &p.id).collect::<Vec<_>>(),
                    children.iter().map(|p| &p.id).collect::<Vec<_>>()
                );
                waiting.push(plan);
                frontier.extend(children);
            }
            PlanDriveReceipt::WaitingForPlanExecution { plan, child, .. } => {
                waiting.push(plan);
                frontier.push(*child);
            }
            PlanDriveReceipt::WaitingForExecutionJob { plan, job, .. } => {
                let action = json!({"kind":"read","path":"/synthetic"});
                let requested = json!({"read_roots":["/synthetic"]});
                let identity =
                    stable_approval_identity(&job.id, &action, &requested, "nested-fixture")
                        .unwrap();
                let approval = match store
                    .ensure_approval_request(NewApprovalRequest {
                        id: identity.approval_id,
                        job_id: job.id.clone(),
                        request_digest: identity.request_digest,
                        policy_digest: identity.policy_digest,
                        action,
                        requested,
                        justification: "Synthetic Plan checkpoint".into(),
                        pending_status: ApprovalStatus::PendingHuman,
                    })
                    .await
                    .unwrap()
                {
                    ApprovalMutation::Created(a) => a,
                    other => panic!("{other:?}"),
                };
                batch.request.pending_approval_ids.push(approval.id.clone());
                batch.approvals.push(approval);
                batch.jobs.push(*job);
                waiting.push(plan);
            }
            PlanDriveReceipt::Succeeded { value, .. } => assert_eq!(value, json!(42)),
            other => panic!("unexpected Plan boundary {other:?}"),
        }
    }
    (batch, coordinator, waiting)
}

async fn native_contract(store: Arc<dyn RuntimeStore>, prefix: &str) {
    for i in 0..8 {
        let (batch, _, _) =
            nested(store.clone(), &format!("{prefix}-decision-race-{i}"), true).await;
        let leaf = batch.approvals.last().unwrap();
        let (suspension, decision) = tokio::join!(
            store.suspend_thread_activation_for_approval(batch.request.clone()),
            store.commit_approval_decision(
                &leaf.id,
                leaf.revision,
                ApprovalResolution::Deny {
                    rationale: "synthetic concurrent decision".into(),
                    risk_tags: vec![],
                }
            ),
        );
        assert!(matches!(
            decision.unwrap().mutation,
            ApprovalMutation::Updated(_)
        ));
        if matches!(suspension, Ok(ThreadActivationMutation::Updated(_))) {
            assert_resumable(store.as_ref(), &batch).await;
        } else {
            let error = suspension.unwrap_err();
            assert!(
                error
                    .downcast_ref::<ActivationApprovalWaitChanged>()
                    .is_some(),
                "{error}"
            );
            let owner = store
                .get_thread_activation(&batch.request.activation_id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(owner.status, ThreadActivationStatus::Running);
            assert_eq!(owner.revision, batch.request.expected_revision);
        }
    }
    for late_kind in ["plan", "job"] {
        let label = format!("{prefix}-late-{late_kind}");
        let (batch, coordinator, plans) = nested(store.clone(), &label, false).await;
        checkpoint(store.as_ref(), &batch).await;
        let parent = &plans[0];
        if late_kind == "plan" {
            let program = serde_json::from_value(parent.program_json.clone()).unwrap();
            coordinator
                .ensure(
                    PlanExecutionRoute {
                        activation_id: parent.activation_id.clone(),
                        thread_id: parent.thread_id.clone(),
                        agent_id: parent.agent_id.clone(),
                        context_id: parent.context_id.clone(),
                        session_id: parent.session_id.clone(),
                        initiating_principal_id: None,
                        tool_call_id: "late-untracked-plan".into(),
                        objective_id: None,
                        objective_evaluation_id: None,
                    },
                    &program,
                    PlanArtifactBinding::default(),
                )
                .await
                .unwrap();
        } else {
            store
                .create_execution_job(NewExecutionJob {
                    id: format!("late-job-{label}"),
                    activation_id: parent.activation_id.clone(),
                    thread_id: parent.thread_id.clone(),
                    agent_id: parent.agent_id.clone(),
                    context_id: parent.context_id.clone(),
                    session_id: parent.session_id.clone(),
                    initiating_principal_id: None,
                    target_id: morphz::execution_target::DEFAULT_EXECUTION_TARGET_ID.into(),
                    tool_call_id: "late-untracked-job".into(),
                    tool_name: "read".into(),
                    request: json!({}),
                    retry_safety: ExecutionRetrySafety::Idempotent,
                    requires_approval: false,
                })
                .await
                .unwrap();
        }
        assert_resumable(store.as_ref(), &batch).await;
    }
    for parallel in [false, true] {
        let label = format!("{prefix}-{parallel}");
        let (batch, _, plans) = nested(store.clone(), &label, parallel).await;
        rejected_checkpoints_leave_owner_unchanged(store.as_ref(), &batch).await;
        checkpoint(store.as_ref(), &batch).await;
        assert_waiting(store.as_ref(), &batch).await;
        // A Plan cancellation, without changing any Approval or Job, must
        // invalidate readiness's exact Plan frontier and wake the same owner.
        let leaf = plans
            .iter()
            .find(|p| p.pending_kind == Some(PlanExecutionWaitKind::ExecutionJob))
            .unwrap();
        assert!(matches!(
            store
                .cancel_plan_execution(&leaf.id, leaf.revision, Some("fixture cancellation"))
                .await
                .unwrap(),
            PlanExecutionMutation::Updated(_)
        ));
        assert_resumable(store.as_ref(), &batch).await;
    }
    let (batch, _, plans) = nested(store.clone(), &format!("{prefix}-group"), true).await;
    checkpoint(store.as_ref(), &batch).await;
    let parent = plans
        .iter()
        .find(|p| p.pending_kind == Some(PlanExecutionWaitKind::ActionGroup))
        .unwrap();
    let group_id = parent.pending_id.as_ref().unwrap();
    let group = store.get_action_group(group_id).await.unwrap().unwrap();
    let members = store.list_action_group_members(group_id).await.unwrap();
    let payload = json!({"context_id":parent.context_id,"session_id":parent.session_id,"attempt_id":parent.activation_id,"action_group_id":group_id,"tool_call_id":members[0].tool_call_id});
    let output = event(
        format!("{prefix}-group-output"),
        "tool/output",
        TYPE_TOOL_OUTPUT,
        payload.clone(),
    );
    let settled = event(
        format!("{prefix}-group-settled"),
        "runtime/action_group_settled",
        "action_group_settled",
        payload,
    );
    store
        .commit_action_group_member_result(
            group_id,
            &members[0].tool_call_id,
            ActionGroupMemberStatus::Succeeded,
            &output,
            &settled,
        )
        .await
        .unwrap();
    assert!(
        store
            .get_action_group(group_id)
            .await
            .unwrap()
            .unwrap()
            .revision
            > group.revision
    );
    assert_resumable(store.as_ref(), &batch).await;

    // Complete the native join as well: cancelled, never-started reads refill
    // their Plans with failures; the parent persists one settled Group/result.
    let (batch, coordinator, plans) = nested(store.clone(), &format!("{prefix}-join"), true).await;
    checkpoint(store.as_ref(), &batch).await;
    for leaf in plans
        .iter()
        .filter(|p| p.pending_kind == Some(PlanExecutionWaitKind::ExecutionJob))
    {
        let id = leaf.pending_id.as_ref().unwrap();
        let job = store.get_execution_job(id).await.unwrap().unwrap();
        store
            .request_cancel_execution_job(id, job.revision, Some("synthetic denial"))
            .await
            .unwrap();
        let cancelled = store.get_execution_job(id).await.unwrap().unwrap();
        store
            .finish_execution_job(
                id,
                cancelled.revision,
                None,
                ExecutionJobTerminal {
                    status: ExecutionJobStatus::Cancelled,
                    result_event_id: None,
                    result_refs: vec![],
                    error: Some("synthetic denial".into()),
                    exit_code: None,
                },
            )
            .await
            .unwrap();
        coordinator
            .reconcile_execution_job(&leaf.id, id)
            .await
            .unwrap();
        let ready = store.get_plan_execution(&leaf.id).await.unwrap().unwrap();
        let result = drive(&coordinator, &ready).await;
        assert!(
            matches!(result, PlanDriveReceipt::Failed { .. }),
            "{result:?}"
        );
    }
    let parent = plans
        .iter()
        .find(|p| p.pending_kind == Some(PlanExecutionWaitKind::ActionGroup))
        .unwrap();
    let group_id = parent.pending_id.as_ref().unwrap();
    coordinator
        .reconcile_action_group(&parent.id, group_id)
        .await
        .unwrap();
    let ready = store.get_plan_execution(&parent.id).await.unwrap().unwrap();
    assert!(matches!(
        drive(&coordinator, &ready).await,
        PlanDriveReceipt::Failed { .. }
    ));
    let group = store.get_action_group(group_id).await.unwrap().unwrap();
    assert_eq!(group.status, ActionGroupStatus::Settled);
    assert_eq!(group.terminal_member_count, 3);
    // A replay is inert and does not replace immutable result Events.
    coordinator
        .reconcile_action_group(&parent.id, group_id)
        .await
        .unwrap();
    assert_eq!(
        store
            .get_action_group(group_id)
            .await
            .unwrap()
            .unwrap()
            .revision,
        group.revision
    );
    assert!(store
        .dialogue_turn_activation_runnable(&batch.request.activation_id)
        .await
        .unwrap());
}

#[tokio::test]
async fn sqlite_nested_plan_checkpoints_track_every_dependency() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Arc::new(
        SqliteStore::new(tmp.path().join("nested.sqlite").to_str().unwrap())
            .await
            .unwrap(),
    );
    native_contract(store, "sqlite-nested").await;
}

#[tokio::test]
async fn sqlite_nested_plan_checkpoint_survives_reopen() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("reopen.sqlite");
    let store = Arc::new(SqliteStore::new(path.to_str().unwrap()).await.unwrap());
    let (batch, c, _) = nested(store.clone(), "reopen-nested", true).await;
    checkpoint(store.as_ref(), &batch).await;
    drop(c);
    drop(store);
    let reopened = SqliteStore::new(path.to_str().unwrap()).await.unwrap();
    assert_waiting(&reopened, &batch).await;
    // Resolve a nested leaf, not one of the direct outer-batch approvals.
    let leaf = batch.approvals.last().unwrap();
    reopened
        .commit_approval_decision(
            &leaf.id,
            leaf.revision,
            ApprovalResolution::Deny {
                rationale: "synthetic nested denial".into(),
                risk_tags: vec![],
            },
        )
        .await
        .unwrap();
    assert_resumable(&reopened, &batch).await;
}

#[tokio::test]
async fn sqlite_nested_plan_checkpoints_preserve_dependencies_until_owner_closes() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("cancel.sqlite");
    let store = Arc::new(SqliteStore::new(path.to_str().unwrap()).await.unwrap());
    let (batch, _, plans) = nested(store.clone(), "cancel-nested", true).await;
    checkpoint(store.as_ref(), &batch).await;
    let pool = sqlx::SqlitePool::connect(&format!("sqlite:{}", path.display()))
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM activation_approval_plan_waits")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        count, 4,
        "snapshot includes the terminal constant branch too"
    );
    assert!(sqlx::query("DELETE FROM plan_executions WHERE id = ?")
        .bind(&plans[0].id)
        .execute(&pool)
        .await
        .is_err());
    let owner = store
        .get_thread(&batch.jobs[0].thread_id)
        .await
        .unwrap()
        .unwrap();
    store
        .control_thread(
            &owner.id,
            owner.revision,
            ThreadControlAction::Cancel,
            Some("synthetic cancel"),
            Some("fixture"),
        )
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM activation_approval_plan_waits")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert!(store
        .get_thread_activation_approval_wait(&batch.request.activation_id)
        .await
        .unwrap()
        .is_none());
    for plan in &plans {
        assert_eq!(
            store
                .get_plan_execution(&plan.id)
                .await
                .unwrap()
                .unwrap()
                .status,
            PlanExecutionStatus::Cancelled
        );
    }
}

#[tokio::test]
#[ignore = "requires MORPHZ_TEST_POSTGRES_URL pointing to an isolated disposable schema"]
async fn postgres_nested_plan_checkpoints_track_every_dependency() {
    let url = std::env::var("MORPHZ_TEST_POSTGRES_URL").unwrap();
    let store = Arc::new(
        morphz::memory::postgres::PostgresStore::new(&url, 4)
            .await
            .unwrap(),
    );
    native_contract(
        store,
        &format!("pg-nested-{}", Utc::now().timestamp_nanos_opt().unwrap()),
    )
    .await;
}
