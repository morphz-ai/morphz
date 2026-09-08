//! Native Store conformance. No Provider calls, real commands, or production
//! data. The same protocol assertions run against SQLite and disposable PG.
use chrono::{Duration, Utc};
use morphz::approval_authority::stable_approval_identity;
use morphz::event::{Event, TYPE_TOOL_OUTPUT};
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::*;
use serde_json::json;

#[path = "activation_approval_checkpoint/infer_children.rs"]
mod infer_children;
#[path = "activation_approval_checkpoint/nested_plans.rs"]
mod nested_plans;
#[path = "activation_approval_checkpoint/objective_owners.rs"]
mod objective_owners;

struct Batch {
    request: ActivationApprovalWaitRequest,
    jobs: Vec<ExecutionJobRecord>,
    approvals: Vec<ApprovalRecord>,
    timer: String,
}

fn event(id: String, topic: &str, kind: &str, payload: serde_json::Value) -> Event {
    Event::new(
        id,
        "checkpoint-fixture".into(),
        kind.into(),
        topic.into(),
        payload.as_object().unwrap().clone(),
    )
}

async fn seed(store: &dyn RuntimeStore, label: &str) -> Batch {
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
    let activation = format!("activation-{label}");
    let root = format!("root-{label}");
    store
        .append(event(
            root.clone(),
            "chat/user_message",
            "user_message",
            json!({
                "context_id":context,"session_id":session,"text":"synthetic checkpoint test"
            }),
        ))
        .await
        .unwrap();
    store
        .ensure_thread(NewThread {
            id: thread.clone(),
            agent_id: agent.clone(),
            context_id: context.clone(),
            session_id: session.clone(),
            initiating_principal_id: None,
            root_turn_id: root.clone(),
            kind: ThreadKind::DialogueTurn,
            executor_kind: "self".into(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::runtime("checkpoint-test"),
        })
        .await
        .unwrap();
    let current = store
        .ensure_thread_activation(NewThreadActivation {
            id: activation.clone(),
            agent_id: agent.clone(),
            context_id: context.clone(),
            session_id: session.clone(),
            initiating_principal_id: None,
            trigger_event_id: root.clone(),
            trigger_sequence: 1,
            trigger_kind: "chat/user_message".into(),
            parent_activation_id: None,
            root_turn_id: root,
        })
        .await
        .unwrap();
    let running = match store
        .update_thread_activation(
            &activation,
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
    seed_running_batch(store, &running, label).await
}

async fn seed_running_batch(
    store: &dyn RuntimeStore,
    running: &ThreadActivationRecord,
    label: &str,
) -> Batch {
    let activation = running.id.clone();
    let agent = running.agent_id.clone();
    let context = running.context_id.clone();
    let session = running.session_id.clone();
    let thread = store
        .get_thread_by_root(&running.root_turn_id)
        .await
        .unwrap()
        .unwrap()
        .id;
    let mut jobs = Vec::new();
    let mut approvals = Vec::new();
    for i in 0..2 {
        let job = NewExecutionJob {
            id: format!("job-{label}-{i}"),
            activation_id: activation.clone(),
            thread_id: thread.clone(),
            agent_id: agent.clone(),
            context_id: context.clone(),
            session_id: session.clone(),
            initiating_principal_id: running.initiating_principal_id.clone(),
            target_id: morphz::execution_target::DEFAULT_EXECUTION_TARGET_ID.into(),
            tool_call_id: format!("exec-{i}"),
            tool_name: "exec".into(),
            request: json!({"command":"true"}),
            retry_safety: ExecutionRetrySafety::AtMostOnce,
            requires_approval: true,
        };
        let action = json!({"kind":"shell","command":"true"});
        let requested = json!({"write_roots":["/checkpoint-fixture"]});
        let identity =
            stable_approval_identity(&job.id, &action, &requested, "checkpoint-test-policy")
                .unwrap();
        let approval = NewApprovalRequest {
            id: identity.approval_id,
            job_id: job.id.clone(),
            request_digest: identity.request_digest,
            policy_digest: identity.policy_digest,
            action,
            requested,
            justification: "Synthetic checkpoint".into(),
            pending_status: ApprovalStatus::PendingHuman,
        };
        let request_event = event(
            format!("requested-{}", approval.id),
            "runtime/approval_requested",
            "approval_requested",
            json!({
                "approval_id":approval.id,"job_id":job.id,"request_digest":approval.request_digest,"policy_digest":approval.policy_digest,
                "activation_id":activation,"thread_id":thread,"context_id":context,"session_id":session,"tool_call_id":job.tool_call_id,"principal_id":running.initiating_principal_id,
                "action":approval.action,"requested":approval.requested,"justification":approval.justification
            }),
        );
        match store
            .ensure_execution_job_with_approval(job, approval, &request_event)
            .await
            .unwrap()
        {
            ExecutionApprovalMutation::Created { job, approval } => {
                jobs.push(job);
                approvals.push(approval);
            }
            other => panic!("{other:?}"),
        }
    }
    let call = format!("call_{activation}");
    store
        .append(event(
            call.clone(),
            "chat/assistant_call",
            "agent_call",
            json!({
                "context_id":context,"session_id":session,"attempt_id":activation,"tool_calls":[
                    {"id":"exec-0","type":"function","function":{"name":"exec","arguments":"{}"}},
                    {"id":"exec-1","type":"function","function":{"name":"exec","arguments":"{}"}},
                    {"id":"read-done","type":"function","function":{"name":"read","arguments":"{}"}}
                ]
            }),
        ))
        .await
        .unwrap();
    let output = format!("output_{activation}_read-done");
    store.append(event(output.clone(),"tool/output",TYPE_TOOL_OUTPUT,json!({
        "context_id":context,"session_id":session,"attempt_id":activation,"tool_call_id":"read-done","text":"fixture result"
    }))).await.unwrap();
    let timer = format!("activation-lease-{label}");
    store
        .upsert_runtime_timer(NewRuntimeTimer {
            id: timer.clone(),
            generation: 1,
            kind: RuntimeTimerKind::ActivationLease,
            owner_id: activation.clone(),
            due_at: Utc::now() + Duration::minutes(10),
            payload: json!({}),
        })
        .await
        .unwrap();
    Batch {
        request: ActivationApprovalWaitRequest {
            pending_infer_activation_ids: vec![],
            activation_id: activation,
            expected_revision: running.revision,
            claimed_by: "worker-before-exit".into(),
            assistant_call_event_id: call,
            pending_approval_ids: approvals.iter().map(|a| a.id.clone()).collect(),
            completed_output_event_ids: vec![output],
        },
        jobs,
        approvals,
        timer,
    }
}

async fn checkpoint(store: &dyn RuntimeStore, batch: &Batch) -> ThreadActivationRecord {
    match store
        .suspend_thread_activation_for_approval(batch.request.clone())
        .await
        .unwrap()
    {
        ThreadActivationMutation::Updated(a) => a,
        other => panic!("{other:?}"),
    }
}

async fn assert_waiting(store: &dyn RuntimeStore, batch: &Batch) {
    let id = &batch.request.activation_id;
    let checkpoint = store
        .get_thread_activation_approval_wait(id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        checkpoint.assistant_call_event_id,
        batch.request.assistant_call_event_id
    );
    let mut expected = batch.request.pending_approval_ids.clone();
    expected.sort();
    assert_eq!(checkpoint.approval_ids, expected);
    let current = store.get_thread_activation(id).await.unwrap().unwrap();
    assert_eq!(current.status, ThreadActivationStatus::Queued);
    assert!(current.claimed_by.is_none() && current.lease_expires_at.is_none());
    assert!(!store.dialogue_turn_activation_runnable(id).await.unwrap());
    assert!(store
        .list_queued_thread_activations_for_admission(32, 0, 60_000)
        .await
        .unwrap()
        .iter()
        .all(|(a, _)| &a.id != id));
    assert!(matches!(
        store
            .update_thread_activation(
                id,
                current.revision,
                ThreadActivationStatus::Running,
                Some("stale-admission"),
                Some(Utc::now() + Duration::minutes(1)),
                None
            )
            .await
            .unwrap(),
        ThreadActivationMutation::Conflict { .. }
    ));
    for job in &batch.jobs {
        assert_eq!(
            store.get_execution_job(&job.id).await.unwrap().unwrap(),
            *job
        );
    }
    assert_eq!(
        store
            .get_thread(&batch.jobs[0].thread_id)
            .await
            .unwrap()
            .unwrap()
            .lifecycle,
        ThreadLifecycle::Open
    );
    assert_eq!(
        store
            .get_runtime_timer(&batch.timer)
            .await
            .unwrap()
            .unwrap()
            .status,
        RuntimeTimerStatus::Cancelled
    );
}

async fn resolve(store: &dyn RuntimeStore, batch: &Batch, kind: &str) {
    let a = &batch.approvals[0];
    let result = match kind {
        "allow" => {
            store
                .commit_approval_decision(
                    &a.id,
                    a.revision,
                    ApprovalResolution::Allow {
                        rationale: "fixture".into(),
                        risk_tags: vec![],
                    },
                )
                .await
        }
        "deny" => {
            store
                .commit_approval_decision(
                    &a.id,
                    a.revision,
                    ApprovalResolution::Deny {
                        rationale: "fixture".into(),
                        risk_tags: vec![],
                    },
                )
                .await
        }
        "cancel" => {
            store
                .commit_approval_cancellation(&a.id, a.revision, "fixture cancellation")
                .await
        }
        _ => unreachable!(),
    }
    .unwrap();
    assert!(matches!(result.mutation, ApprovalMutation::Updated(_)));
}

async fn assert_later_dialogue_is_not_blocked(store: &dyn RuntimeStore, batch: &Batch) {
    let job = &batch.jobs[0];
    let root = format!("later-{}", job.activation_id);
    store.append(event(root.clone(),"chat/user_message","user_message",json!({
        "context_id":job.context_id,"session_id":job.session_id,"text":"later independent dialogue"
    }))).await.unwrap();
    store
        .ensure_thread(NewThread {
            id: root.clone(),
            agent_id: job.agent_id.clone(),
            context_id: job.context_id.clone(),
            session_id: job.session_id.clone(),
            initiating_principal_id: None,
            root_turn_id: root.clone(),
            kind: ThreadKind::DialogueTurn,
            executor_kind: "self".into(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::runtime("checkpoint-test"),
        })
        .await
        .unwrap();
    let a = store
        .ensure_thread_activation(NewThreadActivation {
            id: root.clone(),
            agent_id: job.agent_id.clone(),
            context_id: job.context_id.clone(),
            session_id: job.session_id.clone(),
            initiating_principal_id: None,
            trigger_event_id: root.clone(),
            trigger_sequence: 2,
            trigger_kind: "chat/user_message".into(),
            parent_activation_id: None,
            root_turn_id: root.clone(),
        })
        .await
        .unwrap();
    assert!(store
        .dialogue_turn_activation_runnable(&a.id)
        .await
        .unwrap());
    assert!(store
        .list_queued_thread_activations_for_admission(32, 0, 60_000)
        .await
        .unwrap()
        .iter()
        .any(|(row, _)| row.id == a.id));
    let running = match store
        .update_thread_activation(
            &a.id,
            a.revision,
            ThreadActivationStatus::Running,
            Some("later-worker"),
            Some(Utc::now() + Duration::minutes(1)),
            None,
        )
        .await
        .unwrap()
    {
        ThreadActivationMutation::Updated(a) => a,
        other => panic!("later dialogue blocked: {other:?}"),
    };
    store
        .update_thread_activation(
            &a.id,
            running.revision,
            ThreadActivationStatus::Succeeded,
            None,
            None,
            None,
        )
        .await
        .unwrap();
}

async fn assert_resumable(store: &dyn RuntimeStore, batch: &Batch) {
    let id = &batch.request.activation_id;
    assert!(store.dialogue_turn_activation_runnable(id).await.unwrap());
    assert!(store
        .list_queued_thread_activations_for_admission(32, 0, 60_000)
        .await
        .unwrap()
        .iter()
        .any(|(a, _)| &a.id == id));
    assert_eq!(
        store
            .get_approval(&batch.approvals[1].id)
            .await
            .unwrap()
            .unwrap()
            .status,
        ApprovalStatus::PendingHuman
    );
    let current = store.get_thread_activation(id).await.unwrap().unwrap();
    assert!(matches!(
        store
            .update_thread_activation(
                id,
                current.revision,
                ThreadActivationStatus::Running,
                Some("worker-after-exit"),
                Some(Utc::now() + Duration::minutes(1)),
                None
            )
            .await
            .unwrap(),
        ThreadActivationMutation::Updated(_)
    ));
    // A second crash after claim must still recover the exact Model Attempt.
    // Admission did not consume a grant or create a replacement Job.
    assert_eq!(
        store
            .get_thread_activation_approval_wait(id)
            .await
            .unwrap()
            .unwrap()
            .assistant_call_event_id,
        batch.request.assistant_call_event_id
    );
    for job in &batch.jobs {
        assert_eq!(
            store.get_execution_job(&job.id).await.unwrap().unwrap(),
            *job
        );
    }
}

async fn rejected_checkpoints_leave_owner_unchanged(store: &dyn RuntimeStore, batch: &Batch) {
    let mut missing = batch.request.clone();
    missing.completed_output_event_ids.clear();
    assert!(store
        .suspend_thread_activation_for_approval(missing)
        .await
        .is_err());
    let mut partial = batch.request.clone();
    partial.pending_approval_ids.pop();
    assert!(store
        .suspend_thread_activation_for_approval(partial)
        .await
        .is_err());
    let mut wrong = batch.request.clone();
    wrong.claimed_by = "other-worker".into();
    assert!(store
        .suspend_thread_activation_for_approval(wrong)
        .await
        .is_err());
    let mut duplicate = batch.request.clone();
    duplicate.pending_approval_ids[1] = duplicate.pending_approval_ids[0].clone();
    assert!(store
        .suspend_thread_activation_for_approval(duplicate)
        .await
        .is_err());
    let mut stale = batch.request.clone();
    stale.expected_revision = 0;
    assert!(matches!(
        store
            .suspend_thread_activation_for_approval(stale)
            .await
            .unwrap(),
        ThreadActivationMutation::Conflict { .. }
    ));
    let current = store
        .get_thread_activation(&batch.request.activation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.revision, batch.request.expected_revision);
    assert_eq!(current.status, ThreadActivationStatus::Running);
    assert_eq!(
        store
            .get_runtime_timer(&batch.timer)
            .await
            .unwrap()
            .unwrap()
            .status,
        RuntimeTimerStatus::Pending
    );
}

#[tokio::test]
async fn sqlite_approval_checkpoint_survives_reopen_and_any_decision_resumes_original_activation() {
    for decision in ["allow", "deny", "cancel"] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("checkpoint.sqlite");
        let store = SqliteStore::new(path.to_str().unwrap()).await.unwrap();
        let batch = seed(&store, decision).await;
        rejected_checkpoints_leave_owner_unchanged(&store, &batch).await;
        checkpoint(&store, &batch).await;
        assert_waiting(&store, &batch).await;
        assert_later_dialogue_is_not_blocked(&store, &batch).await;
        drop(store);
        let reopened = SqliteStore::new(path.to_str().unwrap()).await.unwrap();
        assert_waiting(&reopened, &batch).await;
        resolve(&reopened, &batch, decision).await;
        drop(reopened);
        let resumed = SqliteStore::new(path.to_str().unwrap()).await.unwrap();
        assert_resumable(&resumed, &batch).await;
    }
}

#[tokio::test]
async fn sqlite_approval_checkpoint_decision_race_never_loses_readiness() {
    for i in 0..12 {
        let temp = tempfile::tempdir().unwrap();
        let store = SqliteStore::new(temp.path().join("race.sqlite").to_str().unwrap())
            .await
            .unwrap();
        let batch = seed(&store, &format!("race-{i}")).await;
        let (suspension, ()) = tokio::join!(
            store.suspend_thread_activation_for_approval(batch.request.clone()),
            resolve(&store, &batch, "allow")
        );
        let current = store
            .get_thread_activation(&batch.request.activation_id)
            .await
            .unwrap()
            .unwrap();
        if matches!(suspension, Ok(ThreadActivationMutation::Updated(_))) {
            assert_resumable(&store, &batch).await;
        } else {
            assert!(suspension.is_err());
            assert_eq!(current.status, ThreadActivationStatus::Running);
            assert_eq!(current.revision, batch.request.expected_revision);
        }
    }
}

#[tokio::test]
async fn sqlite_approval_waits_cannot_fill_the_bounded_admission_window() {
    let temp = tempfile::tempdir().unwrap();
    let store = SqliteStore::new(temp.path().join("queue.sqlite").to_str().unwrap())
        .await
        .unwrap();
    for i in 0..40 {
        let batch = seed(&store, &format!("waiting-{i:02}")).await;
        checkpoint(&store, &batch).await;
    }
    let batch = seed(&store, "ready-last").await;
    let a = store
        .get_thread_activation(&batch.request.activation_id)
        .await
        .unwrap()
        .unwrap();
    store
        .update_thread_activation(
            &a.id,
            a.revision,
            ThreadActivationStatus::Queued,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    let queue = store
        .list_queued_thread_activations_for_admission(1, 0, 60_000)
        .await
        .unwrap();
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].0.id, a.id);
}

async fn assert_decision_before_checkpoint(store: &dyn RuntimeStore, label: &str) {
    let batch = seed(store, label).await;
    resolve(store, &batch, "allow").await;
    assert!(store
        .suspend_thread_activation_for_approval(batch.request.clone())
        .await
        .is_err());
    let current = store
        .get_thread_activation(&batch.request.activation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.status, ThreadActivationStatus::Running);
    assert_eq!(current.revision, batch.request.expected_revision);
    assert_eq!(
        store
            .get_runtime_timer(&batch.timer)
            .await
            .unwrap()
            .unwrap()
            .status,
        RuntimeTimerStatus::Pending
    );
}

async fn assert_job_cancellation_wakes_checkpoint(store: &dyn RuntimeStore, label: &str) {
    let batch = seed(store, label).await;
    let current = checkpoint(store, &batch).await;
    let job = &batch.jobs[0];
    store
        .request_cancel_execution_job(&job.id, job.revision, Some("fixture cancellation"))
        .await
        .unwrap();
    assert!(store
        .dialogue_turn_activation_runnable(&current.id)
        .await
        .unwrap());
    assert!(store
        .list_queued_thread_activations_for_admission(32, 0, 60_000)
        .await
        .unwrap()
        .iter()
        .any(|(a, _)| a.id == current.id));
}

async fn assert_thread_cancel_clears_checkpoint(store: &dyn RuntimeStore, label: &str) {
    let batch = seed(store, label).await;
    checkpoint(store, &batch).await;
    let thread = store
        .get_thread(&batch.jobs[0].thread_id)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        store
            .control_thread(
                &thread.id,
                thread.revision,
                ThreadControlAction::Cancel,
                Some("fixture cancellation"),
                Some("checkpoint-test")
            )
            .await
            .unwrap(),
        ThreadMutation::Updated(_)
    ));
    assert!(store
        .get_thread_activation_approval_wait(&batch.request.activation_id)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        store
            .get_thread_activation(&batch.request.activation_id)
            .await
            .unwrap()
            .unwrap()
            .status,
        ThreadActivationStatus::Cancelled
    );
}

async fn assert_every_terminal_status_clears_checkpoint(store: &dyn RuntimeStore, label: &str) {
    for status in [
        ThreadActivationStatus::Succeeded,
        ThreadActivationStatus::Failed,
        ThreadActivationStatus::Cancelled,
    ] {
        let batch = seed(store, &format!("{label}-{}", status.as_str())).await;
        checkpoint(store, &batch).await;
        resolve(store, &batch, "allow").await;
        assert_resumable(store, &batch).await;
        let current = store
            .get_thread_activation(&batch.request.activation_id)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            store
                .update_thread_activation(&current.id, current.revision, status, None, None, None)
                .await
                .unwrap(),
            ThreadActivationMutation::Updated(a) if a.status == status
        ));
        assert!(
            store
                .get_thread_activation_approval_wait(&current.id)
                .await
                .unwrap()
                .is_none(),
            "terminal {status:?} retained its checkpoint"
        );
    }
}

#[tokio::test]
async fn sqlite_approval_checkpoint_clears_on_every_terminal_status() {
    let temp = tempfile::tempdir().unwrap();
    let store = SqliteStore::new(temp.path().join("terminal.sqlite").to_str().unwrap())
        .await
        .unwrap();
    assert_every_terminal_status_clears_checkpoint(&store, "terminal").await;
}

#[tokio::test]
async fn sqlite_approval_checkpoint_honors_earlier_decisions_and_later_job_cancellation() {
    let temp = tempfile::tempdir().unwrap();
    let store = SqliteStore::new(temp.path().join("decision.sqlite").to_str().unwrap())
        .await
        .unwrap();
    assert_decision_before_checkpoint(&store, "decision-first").await;
    assert_job_cancellation_wakes_checkpoint(&store, "job-cancellation").await;
    assert_thread_cancel_clears_checkpoint(&store, "thread-cancellation").await;
}

#[tokio::test]
#[ignore = "requires MORPHZ_TEST_POSTGRES_URL pointing to an isolated disposable schema"]
async fn postgres_approval_checkpoint_matches_sqlite() {
    let url = std::env::var("MORPHZ_TEST_POSTGRES_URL")
        .expect("explicit disposable PostgreSQL URL required");
    let store = morphz::memory::postgres::PostgresStore::new(&url, 4)
        .await
        .unwrap();
    for decision in ["allow", "deny", "cancel"] {
        let batch = seed(
            &store,
            &format!(
                "pg-{decision}-{}",
                Utc::now().timestamp_nanos_opt().unwrap()
            ),
        )
        .await;
        rejected_checkpoints_leave_owner_unchanged(&store, &batch).await;
        checkpoint(&store, &batch).await;
        assert_waiting(&store, &batch).await;
        assert_later_dialogue_is_not_blocked(&store, &batch).await;
        resolve(&store, &batch, decision).await;
        assert_resumable(&store, &batch).await;
    }
    let suffix = Utc::now().timestamp_nanos_opt().unwrap();
    assert_decision_before_checkpoint(&store, &format!("pg-before-{suffix}")).await;
    assert_job_cancellation_wakes_checkpoint(&store, &format!("pg-job-cancel-{suffix}")).await;
    assert_thread_cancel_clears_checkpoint(&store, &format!("pg-thread-cancel-{suffix}")).await;
    assert_every_terminal_status_clears_checkpoint(&store, &format!("pg-terminal-{suffix}")).await;
    normalized_batch_retains_model_attempt_boundary(&store, &format!("pg-normalized-{suffix}"))
        .await;
}

async fn normalized_batch_retains_model_attempt_boundary(store: &dyn RuntimeStore, label: &str) {
    let mut batch = seed(store, label).await;
    let mut call = store
        .query(QueryFilter {
            event_id: Some(batch.request.assistant_call_event_id.clone()),
            ..Default::default()
        })
        .await
        .unwrap()
        .pop()
        .unwrap();
    call.id = format!("call_model_attempt_{label}");
    call.sequence = None;
    call.payload.insert(
        "continuation_tool_calls".into(),
        call.payload["tool_calls"].clone(),
    );
    call.payload
        .get_mut("tool_calls")
        .unwrap()
        .as_array_mut()
        .unwrap()
        .push(json!({
            "id":"deduplicated-call", "type":"function", "function":{"name":"read","arguments":"{}"}
        }));
    store.append(call.clone()).await.unwrap();
    batch.request.assistant_call_event_id = call.id.clone();
    checkpoint(store, &batch).await;
    resolve(store, &batch, "allow").await;
    assert_resumable(store, &batch).await;
    // Simulate another owner loss after claim, before physical execution.
    let current = store
        .get_thread_activation(&batch.request.activation_id)
        .await
        .unwrap()
        .unwrap();
    store
        .update_thread_activation(
            &current.id,
            current.revision,
            ThreadActivationStatus::Queued,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .get_thread_activation_approval_wait(&current.id)
            .await
            .unwrap()
            .unwrap()
            .assistant_call_event_id,
        call.id
    );
    assert!(store
        .dialogue_turn_activation_runnable(&current.id)
        .await
        .unwrap());
}

#[tokio::test]
async fn sqlite_approval_checkpoint_uses_normalized_batch_and_keeps_second_crash_boundary() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("normalized.sqlite");
    let store = SqliteStore::new(path.to_str().unwrap()).await.unwrap();
    normalized_batch_retains_model_attempt_boundary(&store, "normalized").await;
    drop(store);
    let store = SqliteStore::new(path.to_str().unwrap()).await.unwrap();
    assert_eq!(
        store
            .get_thread_activation_approval_wait("activation-normalized")
            .await
            .unwrap()
            .unwrap()
            .assistant_call_event_id,
        "call_model_attempt_normalized"
    );
}

#[cfg(feature = "remote-store")]
#[tokio::test]
#[ignore = "requires the real local Agent Cell workerd conformance server"]
async fn remote_approval_checkpoint_survives_two_empty_cache_restores() {
    use morphz::memory::remote::{
        http::HttpRemoteStoreTransport, protocol::Fence, RemoteRuntimeStore,
    };
    use std::sync::Arc;
    let base = std::env::var("MORPHZ_TEST_REMOTE_STORE_URL").expect("real workerd URL required");
    let label = format!(
        "approval-checkpoint-{}",
        Utc::now().timestamp_nanos_opt().unwrap()
    );
    let url = format!("{base}{label}");
    let connect = || {
        RemoteRuntimeStore::connect(
            Arc::new(HttpRemoteStoreTransport::new(&url, "conformance-only").unwrap()),
            Fence {
                owner_id: "runtime-conformance-owner".into(),
                epoch: 1,
            },
        )
    };
    let store = connect().await.unwrap();
    let batch = seed(&store, &label).await;
    checkpoint(&store, &batch).await;
    assert_waiting(&store, &batch).await;
    drop(store);
    let restored = connect().await.unwrap();
    assert_waiting(&restored, &batch).await;
    resolve(&restored, &batch, "allow").await;
    drop(restored);
    let resumed = connect().await.unwrap();
    assert_resumable(&resumed, &batch).await;
    let job = &batch.jobs[0];
    let approval = resumed
        .get_approval(&batch.approvals[0].id)
        .await
        .unwrap()
        .unwrap();
    let claimed = resumed
        .claim_execution_job_with_grant(
            &job.id,
            job.revision,
            &approval.id,
            approval.revision,
            "restored-worker",
            "one-claim",
            Utc::now() + Duration::minutes(1),
        )
        .await
        .unwrap();
    assert!(matches!(claimed, ExecutionApprovalMutation::Updated { .. }));
    let replay = resumed
        .claim_execution_job_with_grant(
            &job.id,
            job.revision,
            &approval.id,
            approval.revision,
            "restored-worker",
            "one-claim",
            Utc::now() + Duration::minutes(1),
        )
        .await
        .unwrap();
    assert!(matches!(replay, ExecutionApprovalMutation::Existing { .. }));
    let duplicate = resumed
        .claim_execution_job_with_grant(
            &job.id,
            job.revision,
            &approval.id,
            approval.revision,
            "other-worker",
            "second-claim",
            Utc::now() + Duration::minutes(1),
        )
        .await
        .unwrap();
    assert!(matches!(
        duplicate,
        ExecutionApprovalMutation::Conflict { .. }
    ));
    // Trigger-produced deletes must also be journaled, not only the CAS row.
    let activation = resumed
        .get_thread_activation(&batch.request.activation_id)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        resumed
            .update_thread_activation(
                &activation.id,
                activation.revision,
                ThreadActivationStatus::Failed,
                None,
                None,
                None,
            )
            .await
            .unwrap(),
        ThreadActivationMutation::Updated(_)
    ));
    drop(resumed);
    let terminal = connect().await.unwrap();
    assert!(terminal
        .get_thread_activation_approval_wait(&activation.id)
        .await
        .unwrap()
        .is_none());
}
