use morphz::approval_authority::stable_approval_identity;
use morphz::event::Event;
use morphz::memory::postgres::PostgresStore;
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{
    ApprovalMutation, ApprovalResolution, ApprovalStatus, ApprovalStore, EventAppend, EventStore,
    ExecutionApprovalMutation, ExecutionApprovalStore, ExecutionJobMutation, ExecutionJobStatus,
    ExecutionJobStore, ExecutionJobTerminal, ExecutionRetrySafety, MindProjectionCommit,
    MindProjectionStore, NewAgent, NewApprovalRequest, NewCognitiveContext, NewExecutionJob,
    NewMindProjection, NewObjective, NewRuntimeTimer, NewSession, NewThread, NewThreadActivation,
    ObjectiveMutation, ObjectiveStatus, ObjectiveStore, ObjectiveWaitCondition, QueryFilter,
    RuntimeTimerKind, RuntimeTimerStatus, SessionAttentionState, SessionAttentionUpdate,
    SessionMountKind, SessionStore, ThreadKind, TimerStore,
};
use serde_json::json;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use tempfile::NamedTempFile;

type TestError = Box<dyn std::error::Error + Send + Sync>;
type AttentionFuture<'a> = Pin<
    Box<
        dyn Future<Output = Result<Option<(SessionAttentionState, u64, Option<String>)>, TestError>>
            + Send
            + 'a,
    >,
>;

fn context_event(id: &str, context_id: &str) -> Event {
    Event::new(
        id.to_string(),
        "Store-Conformance".to_string(),
        "context_transaction".to_string(),
        "chat/context_tx_committed".to_string(),
        json!({"context_id": context_id})
            .as_object()
            .unwrap()
            .clone(),
    )
}

/// Database-independent contract for the Context transaction boundary. A new
/// service Store must pass this exact suite before it can be selected by the
/// Runtime configuration.
async fn assert_context_transaction_conformance<S, F>(store: Arc<S>, read_attention: F)
where
    S: EventStore + MindProjectionStore + Send + Sync + 'static,
    F: for<'a> Fn(&'a S, &'a str) -> AttentionFuture<'a>,
{
    let context_id = "conformance-context";
    let session_id = "conformance-session";
    let initial = store
        .initialize_mind_projection(NewMindProjection {
            context_id: context_id.to_string(),
            revision: 0,
            state: json!({"version": 0, "frames": []}),
            state_hash: "hash-0".to_string(),
            head_event_id: None,
        })
        .await
        .unwrap();
    assert_eq!(initial.revision, 0);

    let first_event = context_event("conformance-tx-a", context_id);
    let second_event = context_event("conformance-tx-b", context_id);
    let first = {
        let store = Arc::clone(&store);
        let event = first_event.clone();
        tokio::spawn(async move {
            store
                .commit_mind_projection_transaction(
                    &event,
                    &[SessionAttentionUpdate {
                        session_id: session_id.to_string(),
                        context_id: context_id.to_string(),
                        expected_revision: 0,
                        state: SessionAttentionState::Retired,
                        reason: Some("conformance".to_string()),
                        changed_at: chrono::Utc::now(),
                        event_id: event.id.clone(),
                    }],
                    0,
                    NewMindProjection {
                        context_id: context_id.to_string(),
                        revision: 1,
                        state: json!({"version": 1, "winner": "a"}),
                        state_hash: "hash-a".to_string(),
                        head_event_id: Some(event.id.clone()),
                    },
                )
                .await
        })
    };
    let second = {
        let store = Arc::clone(&store);
        let event = second_event.clone();
        tokio::spawn(async move {
            store
                .commit_mind_projection_transaction(
                    &event,
                    &[SessionAttentionUpdate {
                        session_id: session_id.to_string(),
                        context_id: context_id.to_string(),
                        expected_revision: 0,
                        state: SessionAttentionState::Active,
                        reason: Some("conformance".to_string()),
                        changed_at: chrono::Utc::now(),
                        event_id: event.id.clone(),
                    }],
                    0,
                    NewMindProjection {
                        context_id: context_id.to_string(),
                        revision: 1,
                        state: json!({"version": 1, "winner": "b"}),
                        state_hash: "hash-b".to_string(),
                        head_event_id: Some(event.id.clone()),
                    },
                )
                .await
        })
    };
    let first = first.await.unwrap().unwrap();
    let second = second.await.unwrap().unwrap();
    assert_eq!(
        [first.clone(), second.clone()]
            .into_iter()
            .filter(|result| matches!(result, MindProjectionCommit::Committed { .. }))
            .count(),
        1,
        "exactly one same-revision writer must commit"
    );
    assert_eq!(
        [first, second]
            .into_iter()
            .filter(|result| matches!(result, MindProjectionCommit::Conflict { .. }))
            .count(),
        1,
        "the competing writer must observe a typed conflict"
    );

    let projection = store
        .get_mind_projection(context_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(projection.revision, 1);
    let committed_events = store
        .query(QueryFilter {
            context_id: Some(context_id.to_string()),
            topic: Some("chat/context_tx_committed".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(committed_events.len(), 1);
    assert_eq!(
        projection.head_event_id.as_deref(),
        Some(committed_events[0].id.as_str())
    );

    let (_, attention_revision, attention_event_id) =
        read_attention(&store, session_id).await.unwrap().unwrap();
    assert_eq!(attention_revision, 1);
    assert_eq!(attention_event_id, projection.head_event_id);

    let duplicate_a = Event::new(
        "conformance-batch-duplicate".to_string(),
        "Store-Conformance".to_string(),
        "audit".to_string(),
        "runtime/conformance".to_string(),
        json!({"value": "a"}).as_object().unwrap().clone(),
    );
    let mut duplicate_b = duplicate_a.clone();
    duplicate_b.payload = json!({"value": "b"}).as_object().unwrap().clone();
    assert!(store
        .append_batch(vec![
            EventAppend {
                event: duplicate_a.clone(),
                signal_outbox: false,
            },
            EventAppend {
                event: duplicate_b,
                signal_outbox: false,
            },
        ])
        .await
        .is_err());
    assert!(store
        .query(QueryFilter {
            event_id: Some(duplicate_a.id),
            ..Default::default()
        })
        .await
        .unwrap()
        .is_empty());
}

async fn assert_timer_lease_conformance<S>(store: Arc<S>)
where
    S: TimerStore + Send + Sync + 'static,
{
    let due_at = chrono::Utc::now() - chrono::Duration::seconds(1);
    for index in 0..4 {
        store
            .upsert_runtime_timer(NewRuntimeTimer {
                id: format!("conformance-timer-{index}"),
                generation: 1,
                kind: RuntimeTimerKind::ActivationLease,
                owner_id: format!("activation-{index}"),
                due_at,
                payload: json!({"index": index}),
            })
            .await
            .unwrap();
    }
    let expires = chrono::Utc::now() + chrono::Duration::seconds(30);
    let first = {
        let store = Arc::clone(&store);
        tokio::spawn(async move {
            store
                .claim_due_runtime_timers(chrono::Utc::now(), "worker-a", expires, 4)
                .await
        })
    };
    let second = {
        let store = Arc::clone(&store);
        tokio::spawn(async move {
            store
                .claim_due_runtime_timers(chrono::Utc::now(), "worker-b", expires, 4)
                .await
        })
    };
    let first = first.await.unwrap().unwrap();
    let second = second.await.unwrap().unwrap();
    let mut claimed = first
        .iter()
        .chain(&second)
        .map(|timer| timer.id.clone())
        .collect::<Vec<_>>();
    claimed.sort();
    claimed.dedup();
    assert_eq!(claimed.len(), 4, "every due timer must be claimed once");
    assert_eq!(first.len() + second.len(), 4, "workers must not overlap");

    for timer in first.iter().chain(&second) {
        assert!(!store
            .complete_runtime_timer(&timer.id, timer.generation, "wrong-worker")
            .await
            .unwrap());
        assert!(store
            .complete_runtime_timer(
                &timer.id,
                timer.generation,
                timer.claimed_by.as_deref().unwrap(),
            )
            .await
            .unwrap());
        assert!(!store
            .complete_runtime_timer(
                &timer.id,
                timer.generation,
                timer.claimed_by.as_deref().unwrap(),
            )
            .await
            .unwrap());
    }
    assert_eq!(
        store
            .list_runtime_timers(Some(RuntimeTimerStatus::Fired))
            .await
            .unwrap()
            .len(),
        4
    );
}

async fn assert_objective_lease_conformance<S>(store: Arc<S>)
where
    S: EventStore + ObjectiveStore + Send + Sync + 'static,
{
    let created = store
        .create_objective(NewObjective {
            id: "conformance-objective".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            coordinator_session_id: "conformance-session".to_string(),
            delivery_session_id: "conformance-session".to_string(),
            parent_objective_id: None,
            source_event_id: "conformance-objective-source".to_string(),
            stated_objective: "verify objective fencing".to_string(),
            token_budget: Some(10_000),
        })
        .await
        .unwrap();
    assert_eq!(created.revision, 1);

    let waiting = match store
        .update_objective_state(
            &created.id,
            created.revision,
            ObjectiveStatus::Active,
            Some(ObjectiveWaitCondition::ResourceAvailable {
                resource: "conformance-resource".to_string(),
            }),
            Some("conformance wait"),
        )
        .await
        .unwrap()
    {
        ObjectiveMutation::Updated(objective) => objective,
        mutation => panic!("unexpected wait mutation: {mutation:?}"),
    };
    assert!(matches!(
        store
            .claim_objective_evaluation(
                &waiting.id,
                waiting.revision,
                "blocked-evaluation",
                chrono::Utc::now() + chrono::Duration::seconds(30),
            )
            .await
            .unwrap(),
        ObjectiveMutation::Conflict { .. }
    ));
    let ready = match store
        .update_objective_state(
            &waiting.id,
            waiting.revision,
            ObjectiveStatus::Active,
            None,
            Some("resource available"),
        )
        .await
        .unwrap()
    {
        ObjectiveMutation::Updated(objective) => objective,
        mutation => panic!("unexpected ready mutation: {mutation:?}"),
    };

    let expires = chrono::Utc::now() + chrono::Duration::seconds(30);
    let first = {
        let store = Arc::clone(&store);
        let id = ready.id.clone();
        tokio::spawn(async move {
            store
                .claim_objective_evaluation(&id, ready.revision, "evaluation-a", expires)
                .await
        })
    };
    let second = {
        let store = Arc::clone(&store);
        let id = ready.id.clone();
        tokio::spawn(async move {
            store
                .claim_objective_evaluation(&id, ready.revision, "evaluation-b", expires)
                .await
        })
    };
    let first = first.await.unwrap().unwrap();
    let second = second.await.unwrap().unwrap();
    let mutations = [first, second];
    assert_eq!(
        mutations
            .iter()
            .filter(|mutation| matches!(mutation, ObjectiveMutation::Updated(_)))
            .count(),
        1
    );
    assert_eq!(
        mutations
            .iter()
            .filter(|mutation| matches!(mutation, ObjectiveMutation::Conflict { .. }))
            .count(),
        1
    );
    let winner = mutations
        .into_iter()
        .find_map(|mutation| match mutation {
            ObjectiveMutation::Updated(objective) => Some(objective),
            _ => None,
        })
        .expect("exactly one Objective evaluation must win the revision fence");
    assert!(winner.active_evaluation_id.is_some());

    let usage = match store
        .record_objective_evaluation_usage(
            &winner.id,
            winner.active_evaluation_id.as_deref().unwrap(),
            7,
        )
        .await
        .unwrap()
    {
        ObjectiveMutation::Updated(objective) => objective,
        mutation => panic!("unexpected usage mutation: {mutation:?}"),
    };
    assert_eq!(usage.revision, winner.revision);
    let finished = match store
        .finish_objective_evaluation(
            &usage.id,
            usage.active_evaluation_id.as_deref().unwrap(),
            5,
            3,
        )
        .await
        .unwrap()
    {
        ObjectiveMutation::Updated(objective) => objective,
        mutation => panic!("unexpected finish mutation: {mutation:?}"),
    };
    assert_eq!(finished.tokens_used, 12);
    assert_eq!(finished.time_used_seconds, 3);

    let occupied_event = Event::new(
        "conformance-objective-conflict".to_string(),
        "Store-Conformance".to_string(),
        "audit".to_string(),
        "runtime/conformance".to_string(),
        json!({"value": "occupied"}).as_object().unwrap().clone(),
    );
    store.append(occupied_event).await.unwrap();
    let conflicting_signal = Event::new(
        "conformance-objective-conflict".to_string(),
        "Store-Conformance".to_string(),
        "runtime_control".to_string(),
        "runtime/objective_continue".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session",
            "objective_id": finished.id,
            "objective_evaluation_id": "rolled-back-evaluation"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    assert!(store
        .claim_objective_evaluation_with_signal(
            &finished.id,
            finished.revision,
            "rolled-back-evaluation",
            expires,
            &conflicting_signal,
        )
        .await
        .is_err());
    assert_eq!(
        store.get_objective(&finished.id).await.unwrap().unwrap(),
        finished,
        "Event conflict must roll back the Objective lease"
    );

    let event = Event::new(
        "conformance-objective-signal".to_string(),
        "Store-Conformance".to_string(),
        "runtime_control".to_string(),
        "runtime/objective_continue".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session",
            "objective_id": finished.id,
            "objective_evaluation_id": "evaluation-with-signal"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    assert!(matches!(
        store
            .claim_objective_evaluation_with_signal(
                &finished.id,
                finished.revision,
                "evaluation-with-signal",
                expires,
                &event,
            )
            .await
            .unwrap(),
        ObjectiveMutation::Updated(_)
    ));
    assert_eq!(
        store
            .query(QueryFilter {
                event_id: Some(event.id),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1,
        "Objective lease and continuation Event must commit atomically"
    );
}

fn execution_job(id: &str, tool_call_id: &str) -> NewExecutionJob {
    NewExecutionJob {
        id: id.to_string(),
        activation_id: "conformance-activation".to_string(),
        thread_id: "conformance-thread".to_string(),
        agent_id: "conformance-agent".to_string(),
        context_id: "conformance-context".to_string(),
        session_id: "conformance-session".to_string(),
        tool_call_id: tool_call_id.to_string(),
        tool_name: "read".to_string(),
        request: json!({"path": "README.md"}),
        retry_safety: ExecutionRetrySafety::Idempotent,
        requires_approval: false,
    }
}

async fn assert_execution_job_conformance<S>(store: Arc<S>)
where
    S: EventStore + ExecutionJobStore + Send + Sync + 'static,
{
    let created = store
        .create_execution_job(execution_job("conformance-job", "tool-call-a"))
        .await
        .unwrap();
    assert_eq!(created.revision, 1);
    assert_eq!(
        store
            .create_execution_job(execution_job("conformance-job", "tool-call-a"))
            .await
            .unwrap(),
        created,
        "exact causal replay must be idempotent"
    );

    let lease = chrono::Utc::now() + chrono::Duration::seconds(30);
    let first = {
        let store = Arc::clone(&store);
        tokio::spawn(async move {
            store
                .claim_execution_job("conformance-job", 1, "worker-a", "claim-a", lease, None)
                .await
        })
    };
    let second = {
        let store = Arc::clone(&store);
        tokio::spawn(async move {
            store
                .claim_execution_job("conformance-job", 1, "worker-b", "claim-b", lease, None)
                .await
        })
    };
    let mutations = [
        first.await.unwrap().unwrap(),
        second.await.unwrap().unwrap(),
    ];
    assert_eq!(
        mutations
            .iter()
            .filter(|mutation| matches!(mutation, ExecutionJobMutation::Updated(_)))
            .count(),
        1
    );
    let claimed = mutations
        .into_iter()
        .find_map(|mutation| match mutation {
            ExecutionJobMutation::Updated(job) => Some(job),
            _ => None,
        })
        .unwrap();
    assert_eq!(claimed.status, ExecutionJobStatus::Running);
    assert!(matches!(
        store
            .heartbeat_execution_job(
                &claimed.id,
                claimed.revision,
                "stale-claim",
                lease,
                None,
                None,
            )
            .await
            .unwrap(),
        ExecutionJobMutation::Rejected { .. }
    ));
    let heartbeat = match store
        .heartbeat_execution_job(
            &claimed.id,
            claimed.revision,
            claimed.claim_token.as_deref().unwrap(),
            lease,
            None,
            Some("progress://conformance"),
        )
        .await
        .unwrap()
    {
        ExecutionJobMutation::Updated(job) => job,
        mutation => panic!("unexpected heartbeat mutation: {mutation:?}"),
    };

    let result_event = Event::new(
        "conformance-tool-output".to_string(),
        "Store-Conformance".to_string(),
        morphz::event::TYPE_TOOL_OUTPUT.to_string(),
        "chat/tool_output".to_string(),
        json!({
            "context_id": heartbeat.context_id,
            "session_id": heartbeat.session_id,
            "activation_id": heartbeat.activation_id,
            "thread_id": heartbeat.thread_id,
            "tool_call_id": heartbeat.tool_call_id,
            "tool_name": heartbeat.tool_name,
            "output": ""
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    let terminal = ExecutionJobTerminal {
        status: ExecutionJobStatus::Succeeded,
        result_event_id: Some(result_event.id.clone()),
        result_refs: Vec::new(),
        error: None,
        exit_code: Some(0),
    };
    let finished = match store
        .finish_execution_job_with_event(
            &heartbeat.id,
            heartbeat.revision,
            heartbeat.claim_token.as_deref(),
            terminal.clone(),
            &result_event,
        )
        .await
        .unwrap()
    {
        ExecutionJobMutation::Updated(job) => job,
        mutation => panic!("unexpected terminal mutation: {mutation:?}"),
    };
    assert_eq!(finished.status, ExecutionJobStatus::Succeeded);
    assert!(matches!(
        store
            .finish_execution_job_with_event(
                &finished.id,
                finished.revision,
                heartbeat.claim_token.as_deref(),
                terminal,
                &result_event,
            )
            .await
            .unwrap(),
        ExecutionJobMutation::Existing(_)
    ));
    assert_eq!(
        store
            .query(QueryFilter {
                event_id: Some(result_event.id),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1,
        "terminal Job and result Event must be committed exactly once"
    );

    let recoverable = store
        .create_execution_job(execution_job("conformance-requeue", "tool-call-b"))
        .await
        .unwrap();
    let claimed = match store
        .claim_execution_job(
            &recoverable.id,
            recoverable.revision,
            "worker-c",
            "claim-c",
            lease,
            None,
        )
        .await
        .unwrap()
    {
        ExecutionJobMutation::Updated(job) => job,
        mutation => panic!("unexpected recovery claim: {mutation:?}"),
    };
    assert!(matches!(
        store
            .requeue_execution_job(&claimed.id, claimed.revision)
            .await
            .unwrap(),
        ExecutionJobMutation::Updated(job) if job.status == ExecutionJobStatus::Queued
    ));
}

fn approval_bundle(
    job_id: &str,
    tool_call_id: &str,
) -> (NewExecutionJob, NewApprovalRequest, Event) {
    let mut job = execution_job(job_id, tool_call_id);
    job.requires_approval = true;
    job.tool_name = "exec".to_string();
    job.request = json!({"command": "curl https://example.com"});
    let action = json!({"tool": "exec", "command": "curl https://example.com"});
    let requested = json!({"network": true, "write_roots": []});
    let identity = stable_approval_identity(job_id, &action, &requested, "policy-v1").unwrap();
    let approval = NewApprovalRequest {
        id: identity.approval_id,
        job_id: job_id.to_string(),
        request_digest: identity.request_digest,
        policy_digest: identity.policy_digest,
        action,
        requested,
        justification: "network access is required".to_string(),
        pending_status: ApprovalStatus::PendingAuto,
    };
    let event = Event::new(
        format!("approval-request-{job_id}"),
        "Store-Conformance".to_string(),
        "approval_requested".to_string(),
        "runtime/approval_requested".to_string(),
        json!({
            "approval_id": approval.id,
            "job_id": job.id,
            "request_digest": approval.request_digest,
            "policy_digest": approval.policy_digest,
            "activation_id": job.activation_id,
            "thread_id": job.thread_id,
            "context_id": job.context_id,
            "session_id": job.session_id,
            "tool_call_id": job.tool_call_id,
            "action": approval.action,
            "requested": approval.requested,
            "justification": approval.justification
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    (job, approval, event)
}

async fn assert_approval_grant_conformance<S>(store: Arc<S>)
where
    S: ApprovalStore
        + EventStore
        + ExecutionApprovalStore
        + ExecutionJobStore
        + Send
        + Sync
        + 'static,
{
    let (job, approval, request_event) = approval_bundle("approval-job", "tool-call-approval");
    let created = store
        .ensure_execution_job_with_approval(job.clone(), approval.clone(), &request_event)
        .await
        .unwrap();
    let (job_record, approval_record) = match created {
        ExecutionApprovalMutation::Created { job, approval } => (job, approval),
        mutation => panic!("unexpected approval creation: {mutation:?}"),
    };
    assert_eq!(job_record.status, ExecutionJobStatus::WaitingApproval);
    assert!(matches!(
        store
            .ensure_execution_job_with_approval(job, approval, &request_event)
            .await
            .unwrap(),
        ExecutionApprovalMutation::Existing { .. }
    ));
    let decision = ApprovalResolution::Allow {
        rationale: "conformance allow".to_string(),
        risk_tags: vec!["network".to_string()],
    };
    let audit = store
        .commit_approval_decision(
            &approval_record.id,
            approval_record.revision,
            decision.clone(),
        )
        .await
        .unwrap();
    let allowed = match audit.mutation {
        ApprovalMutation::Updated(approval) => approval,
        mutation => panic!("unexpected approval decision: {mutation:?}"),
    };
    assert!(audit.event_created);
    assert_eq!(allowed.status, ApprovalStatus::Allowed);
    assert!(matches!(
        store
            .commit_approval_decision(&allowed.id, allowed.revision, decision)
            .await
            .unwrap()
            .mutation,
        ApprovalMutation::Existing(_)
    ));

    let lease = chrono::Utc::now() + chrono::Duration::seconds(30);
    let job_id = job_record.id.clone();
    let approval_id = allowed.id.clone();
    let job_revision = job_record.revision;
    let approval_revision = allowed.revision;
    let first = {
        let store = Arc::clone(&store);
        let job_id = job_id.clone();
        let approval_id = approval_id.clone();
        tokio::spawn(async move {
            store
                .claim_execution_job_with_grant(
                    &job_id,
                    job_revision,
                    &approval_id,
                    approval_revision,
                    "approval-worker-a",
                    "approval-claim-a",
                    lease,
                )
                .await
        })
    };
    let second = {
        let store = Arc::clone(&store);
        let job_id = job_id.clone();
        let approval_id = approval_id.clone();
        tokio::spawn(async move {
            store
                .claim_execution_job_with_grant(
                    &job_id,
                    job_revision,
                    &approval_id,
                    approval_revision,
                    "approval-worker-b",
                    "approval-claim-b",
                    lease,
                )
                .await
        })
    };
    let mutations = [
        first.await.unwrap().unwrap(),
        second.await.unwrap().unwrap(),
    ];
    assert_eq!(
        mutations
            .iter()
            .filter(|mutation| matches!(mutation, ExecutionApprovalMutation::Updated { .. }))
            .count(),
        1,
        "one-use Grant must be consumed by one worker only"
    );
    let (claimed_job, consumed) = mutations
        .into_iter()
        .find_map(|mutation| match mutation {
            ExecutionApprovalMutation::Updated { job, approval } => Some((job, approval)),
            _ => None,
        })
        .unwrap();
    assert!(consumed.grant_consumed_at.is_some());
    assert_eq!(
        claimed_job.claim_token.as_deref(),
        consumed.consumed_by_claim_token.as_deref()
    );
    assert!(matches!(
        store
            .claim_execution_job_with_grant(
                &claimed_job.id,
                job_revision,
                &consumed.id,
                approval_revision,
                claimed_job.claimed_by.as_deref().unwrap(),
                claimed_job.claim_token.as_deref().unwrap(),
                lease,
            )
            .await
            .unwrap(),
        ExecutionApprovalMutation::Existing { .. }
    ));

    let (job, approval, request_event) = approval_bundle("cancel-job", "tool-call-cancel");
    let created = store
        .ensure_execution_job_with_approval(job, approval, &request_event)
        .await
        .unwrap();
    let approval = match created {
        ExecutionApprovalMutation::Created { approval, .. } => approval,
        mutation => panic!("unexpected cancellable approval creation: {mutation:?}"),
    };
    let cancelled = store
        .commit_approval_cancellation(&approval.id, approval.revision, "user cancelled")
        .await
        .unwrap();
    assert!(matches!(
        cancelled.mutation,
        ApprovalMutation::Updated(record) if record.status == ApprovalStatus::Cancelled
    ));
}

#[tokio::test]
async fn sqlite_runtime_store_satisfies_context_transaction_conformance() {
    let database = NamedTempFile::new().unwrap();
    let store = Arc::new(
        SqliteStore::new(database.path().to_str().unwrap())
            .await
            .unwrap(),
    );
    store
        .create_agent_bundle(
            NewAgent {
                id: "conformance-agent".to_string(),
                title: "Conformance Agent".to_string(),
                root_context_id: "conformance-context".to_string(),
            },
            NewCognitiveContext {
                id: "conformance-context".to_string(),
                agent_id: "conformance-agent".to_string(),
                title: "Conformance Context".to_string(),
            },
            NewSession {
                id: "conformance-session".to_string(),
                agent_id: "conformance-agent".to_string(),
                context_id: "conformance-context".to_string(),
                parent_session_id: None,
                title: "Conformance Session".to_string(),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await
        .unwrap();
    assert_context_transaction_conformance(Arc::clone(&store), |store, session_id| {
        Box::pin(async move {
            Ok(store.get_session(session_id).await?.map(|session| {
                (
                    session.attention_state,
                    session.attention_revision,
                    session.attention_event_id,
                )
            }))
        })
    })
    .await;
    assert_timer_lease_conformance(Arc::clone(&store)).await;
    assert_objective_lease_conformance(Arc::clone(&store)).await;
    store
        .ensure_thread(NewThread {
            id: "conformance-thread".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            session_id: "conformance-session".to_string(),
            root_turn_id: "root-conformance-thread".to_string(),
            kind: ThreadKind::Execution,
            executor_kind: "runtime".to_string(),
            executor_id: None,
        })
        .await
        .unwrap();
    store
        .ensure_thread_activation(NewThreadActivation {
            id: "conformance-activation".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            session_id: "conformance-session".to_string(),
            trigger_event_id: "trigger-conformance-activation".to_string(),
            trigger_sequence: 1,
            trigger_kind: "conformance".to_string(),
            parent_activation_id: None,
            root_turn_id: "root-conformance-thread".to_string(),
        })
        .await
        .unwrap();
    assert_execution_job_conformance(Arc::clone(&store)).await;
    assert_approval_grant_conformance(store).await;
}

#[tokio::test]
async fn postgres_supported_capabilities_satisfy_the_same_conformance_suite_when_configured() {
    let Ok(database_url) = std::env::var("MORPHZ_TEST_POSTGRES_URL") else {
        return;
    };
    let store = Arc::new(PostgresStore::new(&database_url, 8).await.unwrap());
    store
        .bootstrap_context_for_conformance(
            "conformance-agent",
            "conformance-context",
            "conformance-session",
        )
        .await
        .unwrap();
    assert_context_transaction_conformance(Arc::clone(&store), |store, session_id| {
        Box::pin(async move { store.session_attention_for_conformance(session_id).await })
    })
    .await;
    assert_timer_lease_conformance(Arc::clone(&store)).await;
    assert_objective_lease_conformance(Arc::clone(&store)).await;
    store
        .bootstrap_execution_causality_for_conformance(
            "conformance-thread",
            "conformance-activation",
        )
        .await
        .unwrap();
    assert_execution_job_conformance(Arc::clone(&store)).await;
    assert_approval_grant_conformance(store).await;
}
