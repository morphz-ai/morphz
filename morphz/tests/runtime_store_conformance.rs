use morphz::approval_authority::stable_approval_identity;
use morphz::event::Event;
use morphz::memory::postgres::PostgresStore;
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{
    ActivationOutcomeCommit, ApprovalMutation, ApprovalResolution, ApprovalStatus, ApprovalStore,
    DelegationStatus, DelegationStore, DeliveryFlushCommit, DeliveryIngressStore, DeliveryStatus,
    EventAppend, EventStore, ExecutionApprovalMutation, ExecutionApprovalStore,
    ExecutionJobMutation, ExecutionJobStatus, ExecutionJobStore, ExecutionJobTerminal,
    ExecutionRetrySafety, MessageClaim, MindProjectionCommit, MindProjectionStore, NewAgent,
    NewApprovalRequest, NewCognitiveContext, NewDelegation, NewExecutionJob, NewMindProjection,
    NewObjective, NewRuntimeTimer, NewSession, NewThread, NewThreadActivation, NewThreadSignal,
    ObjectiveMutation, ObjectiveStatus, ObjectiveStore, ObjectiveWaitCondition, QueryFilter,
    RuntimeTimerKind, RuntimeTimerStatus, ScheduleMutation, ScheduleStatus, ScheduleStore,
    SessionAttentionState, SessionAttentionUpdate, SessionMountKind, SessionStatus, SessionUpdate,
    SignalOutboxStatus, ThreadActivationMutation, ThreadActivationStatus, ThreadKind,
    ThreadLifecycle, ThreadMutation, ThreadStore, TimerStore,
};
use morphz::memory::{ActivationStore, SessionDirectoryStore};
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

fn assert_complete_runtime_store<T: morphz::memory::RuntimeStore>() {}

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

async fn assert_session_directory_conformance<S>(store: Arc<S>)
where
    S: SessionDirectoryStore + Send + Sync + 'static,
{
    let agent = store.get_agent("conformance-agent").await.unwrap().unwrap();
    assert_eq!(agent.root_context_id, "conformance-context");
    assert!(store
        .ensure_agent(NewAgent {
            id: agent.id.clone(),
            title: "ignored idempotent title".to_string(),
            root_context_id: "wrong-context".to_string(),
        })
        .await
        .is_err());

    let other_context = store
        .create_context(NewCognitiveContext {
            id: "conformance-other-context".to_string(),
            agent_id: agent.id.clone(),
            title: "Other Context".to_string(),
        })
        .await
        .unwrap();
    store
        .set_context_seed(
            &other_context.id,
            "conformance-context",
            7,
            "seed-hash",
            "seed-projection",
        )
        .await
        .unwrap();
    let seeded = store.get_context(&other_context.id).await.unwrap().unwrap();
    assert_eq!(seeded.seed_context_version, Some(7));
    assert_eq!(seeded.seed_snapshot_hash.as_deref(), Some("seed-hash"));

    assert!(store
        .create_session(NewSession {
            id: "invalid-cross-context-child".to_string(),
            agent_id: agent.id.clone(),
            context_id: other_context.id.clone(),
            parent_session_id: Some("conformance-session".to_string()),
            title: "Invalid".to_string(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .is_err());

    let race_session = NewSession {
        id: "conformance-directory-race".to_string(),
        agent_id: agent.id.clone(),
        context_id: "conformance-context".to_string(),
        parent_session_id: Some("conformance-session".to_string()),
        title: "Concurrent Session".to_string(),
        mount_kind: SessionMountKind::ExistingContext,
    };
    let first = {
        let store = Arc::clone(&store);
        let session = race_session.clone();
        tokio::spawn(async move { store.ensure_session(session).await })
    };
    let second = {
        let store = Arc::clone(&store);
        let session = race_session.clone();
        tokio::spawn(async move { store.ensure_session(session).await })
    };
    let first = first.await.unwrap().unwrap();
    let second = second.await.unwrap().unwrap();
    assert_eq!(first.id, second.id);
    assert_eq!(first.context_id, "conformance-context");

    let changed_at = chrono::Utc::now();
    let first_attention = {
        let store = Arc::clone(&store);
        let session_id = race_session.id.clone();
        tokio::spawn(async move {
            store
                .update_session_attention(SessionAttentionUpdate {
                    session_id,
                    context_id: "conformance-context".to_string(),
                    expected_revision: 0,
                    state: SessionAttentionState::Retired,
                    reason: Some("first".to_string()),
                    changed_at,
                    event_id: "directory-attention-a".to_string(),
                })
                .await
        })
    };
    let second_attention = {
        let store = Arc::clone(&store);
        let session_id = race_session.id.clone();
        tokio::spawn(async move {
            store
                .update_session_attention(SessionAttentionUpdate {
                    session_id,
                    context_id: "conformance-context".to_string(),
                    expected_revision: 0,
                    state: SessionAttentionState::Active,
                    reason: Some("second".to_string()),
                    changed_at,
                    event_id: "directory-attention-b".to_string(),
                })
                .await
        })
    };
    let attention_results = [
        first_attention.await.unwrap().unwrap(),
        second_attention.await.unwrap().unwrap(),
    ];
    assert_eq!(
        attention_results
            .iter()
            .filter(|result| result.is_some())
            .count(),
        1,
        "Session attention revision must admit one concurrent writer"
    );
    assert_eq!(
        store
            .get_session(&race_session.id)
            .await
            .unwrap()
            .unwrap()
            .attention_revision,
        1
    );

    let archived = store
        .update_session(
            &race_session.id,
            SessionUpdate {
                title: Some("Archived Session".to_string()),
                status: Some(SessionStatus::Archived),
            },
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(archived.status, SessionStatus::Archived);
    assert!(!store
        .list_context_sessions("conformance-context", false)
        .await
        .unwrap()
        .iter()
        .any(|session| session.id == race_session.id));
    assert!(store
        .list_context_sessions("conformance-context", true)
        .await
        .unwrap()
        .iter()
        .any(|session| session.id == race_session.id));
}

async fn assert_thread_store_conformance<S>(store: Arc<S>)
where
    S: EventStore + ThreadStore + TimerStore + Send + Sync + 'static,
{
    let thread = NewThread {
        id: "conformance-thread".to_string(),
        agent_id: "conformance-agent".to_string(),
        context_id: "conformance-context".to_string(),
        session_id: "conformance-session".to_string(),
        root_turn_id: "root-conformance-thread".to_string(),
        kind: ThreadKind::Execution,
        executor_kind: "runtime".to_string(),
        executor_id: None,
    };
    let first = {
        let store = Arc::clone(&store);
        let thread = thread.clone();
        tokio::spawn(async move { store.ensure_thread(thread).await })
    };
    let second = {
        let store = Arc::clone(&store);
        let thread = thread.clone();
        tokio::spawn(async move { store.ensure_thread(thread).await })
    };
    assert_eq!(
        first.await.unwrap().unwrap(),
        second.await.unwrap().unwrap()
    );
    let mut conflicting = thread.clone();
    conflicting.id = "different-thread-id".to_string();
    conflicting.context_id = "conformance-other-context".to_string();
    assert!(store.ensure_thread(conflicting).await.is_err());

    let cas_thread = store
        .ensure_thread(NewThread {
            id: "conformance-thread-cas".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            session_id: "conformance-session".to_string(),
            root_turn_id: "root-conformance-thread-cas".to_string(),
            kind: ThreadKind::DialogueTurn,
            executor_kind: "model".to_string(),
            executor_id: None,
        })
        .await
        .unwrap();
    let cas_revision = cas_thread.revision;
    let first = {
        let store = Arc::clone(&store);
        let id = cas_thread.id.clone();
        tokio::spawn(async move {
            store
                .update_thread(
                    &id,
                    cas_revision,
                    None,
                    Some(ThreadLifecycle::Completed),
                    Some("first"),
                    Some("thread-result-a"),
                    Some(DeliveryStatus::Pending),
                    None,
                )
                .await
        })
    };
    let second = {
        let store = Arc::clone(&store);
        let id = cas_thread.id.clone();
        tokio::spawn(async move {
            store
                .update_thread(
                    &id,
                    cas_revision,
                    None,
                    Some(ThreadLifecycle::Failed),
                    Some("second"),
                    Some("thread-result-b"),
                    Some(DeliveryStatus::Pending),
                    None,
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
            .filter(|mutation| matches!(mutation, ThreadMutation::Updated(_)))
            .count(),
        1
    );
    assert_eq!(
        mutations
            .iter()
            .filter(|mutation| matches!(mutation, ThreadMutation::Conflict { .. }))
            .count(),
        1
    );
    assert_eq!(
        store
            .list_session_delivery_threads("conformance-session", false)
            .await
            .unwrap()
            .len(),
        1
    );

    let timer = store
        .arm_delivery_flush_timer("conformance-delivery-timer", "conformance-session", 1, 5)
        .await
        .unwrap()
        .unwrap();
    let claimed = store
        .claim_due_runtime_timers(
            chrono::Utc::now() + chrono::Duration::seconds(10),
            "delivery-worker",
            chrono::Utc::now() + chrono::Duration::seconds(30),
            1,
        )
        .await
        .unwrap();
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].id, timer.id);
    let delivery_event = Event::new(
        "conformance-delivery-ready".to_string(),
        "Store-Conformance".to_string(),
        "runtime_control".to_string(),
        "chat/thread_completion_ready".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session",
            "completed_thread_ids": ["conformance-thread-cas"]
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    assert_eq!(
        store
            .commit_delivery_flush(&timer.id, timer.generation, &delivery_event)
            .await
            .unwrap(),
        DeliveryFlushCommit::Committed
    );
    assert_eq!(
        store
            .commit_delivery_flush(&timer.id, timer.generation, &delivery_event)
            .await
            .unwrap(),
        DeliveryFlushCommit::Existing {
            event_id: delivery_event.id.clone()
        }
    );
    assert_eq!(
        store
            .query(QueryFilter {
                event_id: Some(delivery_event.id),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1
    );
}

async fn assert_activation_store_conformance<S>(store: Arc<S>)
where
    S: ActivationStore + EventStore + ThreadStore + Send + Sync + 'static,
{
    let thread = store
        .ensure_thread(NewThread {
            id: "conformance-signal-thread".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            session_id: "conformance-session".to_string(),
            root_turn_id: "root-conformance-signal-thread".to_string(),
            kind: ThreadKind::DialogueTurn,
            executor_kind: "model".to_string(),
            executor_id: None,
        })
        .await
        .unwrap();
    let event = Event::new(
        "conformance-signal-event-a".to_string(),
        "user".to_string(),
        "user_message".to_string(),
        "chat/user".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    store
        .append_with_signal_outbox(event.clone())
        .await
        .unwrap();
    let sequence = store
        .query(QueryFilter {
            event_id: Some(event.id.clone()),
            ..Default::default()
        })
        .await
        .unwrap()[0]
        .sequence
        .unwrap();
    let signal = NewThreadSignal {
        id: "conformance-signal-a".to_string(),
        thread_id: thread.id.clone(),
        event_id: event.id.clone(),
        sequence,
        kind: event.topic.clone(),
        parent_activation_id: None,
    };
    let activation = NewThreadActivation {
        id: "conformance-signal-activation-a".to_string(),
        agent_id: thread.agent_id.clone(),
        context_id: thread.context_id.clone(),
        session_id: thread.session_id.clone(),
        trigger_event_id: event.id.clone(),
        trigger_sequence: sequence,
        trigger_kind: event.topic.clone(),
        parent_activation_id: None,
        root_turn_id: thread.root_turn_id.clone(),
    };
    let first = {
        let store = Arc::clone(&store);
        let signal = signal.clone();
        let activation = activation.clone();
        tokio::spawn(async move { store.claim_thread_signal_batch(signal, activation, 8).await })
    };
    let second = {
        let store = Arc::clone(&store);
        let signal = signal.clone();
        let activation = activation.clone();
        tokio::spawn(async move { store.claim_thread_signal_batch(signal, activation, 8).await })
    };
    let first = first.await.unwrap().unwrap().unwrap();
    let second = second.await.unwrap().unwrap().unwrap();
    assert_eq!(first.id, second.id);
    assert_eq!(
        store
            .list_signal_outbox(SignalOutboxStatus::Materialized, 16)
            .await
            .unwrap()
            .iter()
            .filter(|outbox| outbox.event_id == event.id)
            .count(),
        1
    );
    assert_eq!(
        store
            .list_activation_signals(&first.id)
            .await
            .unwrap()
            .len(),
        1
    );
    let admission = store
        .list_queued_thread_activations_for_admission(8, 2, 60_000)
        .await
        .unwrap();
    assert!(admission.iter().any(|(record, class)| {
        record.id == first.id && *class == morphz::admission::AdmissionClass::InteractiveControl
    }));

    let first_revision = first.revision;
    let second_revision = second.revision;
    let first_update = {
        let store = Arc::clone(&store);
        let id = first.id.clone();
        tokio::spawn(async move {
            store
                .update_thread_activation(
                    &id,
                    first_revision,
                    ThreadActivationStatus::Running,
                    Some("worker-a"),
                    Some(chrono::Utc::now() + chrono::Duration::seconds(30)),
                    Some(1),
                )
                .await
        })
    };
    let second_update = {
        let store = Arc::clone(&store);
        let id = second.id.clone();
        tokio::spawn(async move {
            store
                .update_thread_activation(
                    &id,
                    second_revision,
                    ThreadActivationStatus::Running,
                    Some("worker-b"),
                    Some(chrono::Utc::now() + chrono::Duration::seconds(30)),
                    Some(1),
                )
                .await
        })
    };
    let updates = [
        first_update.await.unwrap().unwrap(),
        second_update.await.unwrap().unwrap(),
    ];
    assert_eq!(
        updates
            .iter()
            .filter(|mutation| matches!(mutation, ThreadActivationMutation::Updated(_)))
            .count(),
        1
    );
    assert_eq!(
        updates
            .iter()
            .filter(|mutation| matches!(mutation, ThreadActivationMutation::Conflict { .. }))
            .count(),
        1
    );

    let outcome_thread = store
        .ensure_thread(NewThread {
            id: "conformance-outcome-thread".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            session_id: "conformance-session".to_string(),
            root_turn_id: "root-conformance-outcome-thread".to_string(),
            kind: ThreadKind::Execution,
            executor_kind: "runtime".to_string(),
            executor_id: None,
        })
        .await
        .unwrap();
    let outcome_activation = store
        .ensure_thread_activation(NewThreadActivation {
            id: "conformance-outcome-activation".to_string(),
            agent_id: outcome_thread.agent_id.clone(),
            context_id: outcome_thread.context_id.clone(),
            session_id: outcome_thread.session_id.clone(),
            trigger_event_id: "conformance-outcome-trigger".to_string(),
            trigger_sequence: 99,
            trigger_kind: "conformance".to_string(),
            parent_activation_id: None,
            root_turn_id: outcome_thread.root_turn_id.clone(),
        })
        .await
        .unwrap();
    let outcome_event = Event::new(
        "conformance-activation-outcome".to_string(),
        "Store-Conformance".to_string(),
        "agent_reply".to_string(),
        "runtime/thread_result".to_string(),
        json!({
            "context_id": outcome_thread.context_id,
            "session_id": outcome_thread.session_id,
            "thread_id": outcome_thread.id,
            "root_turn_id": outcome_thread.root_turn_id,
            "disposition": "deliver",
            "text": "outcome"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    assert_eq!(
        store
            .commit_activation_outcome(&outcome_activation.id, &outcome_event)
            .await
            .unwrap(),
        ActivationOutcomeCommit::Committed
    );
    assert_eq!(
        store
            .commit_activation_outcome(&outcome_activation.id, &outcome_event)
            .await
            .unwrap(),
        ActivationOutcomeCommit::Existing {
            event_id: outcome_event.id.clone()
        }
    );
    let completed = store
        .get_thread("conformance-outcome-thread")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(completed.lifecycle, ThreadLifecycle::Completed);
    assert_eq!(completed.delivery_status, DeliveryStatus::Pending);
}

async fn assert_schedule_store_conformance<S>(store: Arc<S>)
where
    S: ScheduleStore + ThreadStore + EventStore + Send + Sync + 'static,
{
    for (id, kind) in [
        ("conformance-schedule-thread", ThreadKind::Execution),
        ("conformance-dependency-thread", ThreadKind::Execution),
        ("conformance-dispatch-thread", ThreadKind::Execution),
    ] {
        store
            .ensure_thread(NewThread {
                id: id.to_string(),
                agent_id: "conformance-agent".to_string(),
                context_id: "conformance-context".to_string(),
                session_id: "conformance-session".to_string(),
                root_turn_id: format!("root-{id}"),
                kind,
                executor_kind: "runtime".to_string(),
                executor_id: None,
            })
            .await
            .unwrap();
    }

    let controlled = store
        .ensure_schedule(morphz::memory::NewSchedule {
            id: "conformance-schedule-control".to_string(),
            thread_id: "conformance-schedule-thread".to_string(),
            source_turn_id: "root-conformance-schedule-thread".to_string(),
            intent: "control-plane conformance".to_string(),
            not_before: Some(chrono::Utc::now() + chrono::Duration::hours(1)),
            interval_seconds: None,
            dependency_thread_ids: vec!["conformance-dependency-thread".to_string()],
        })
        .await
        .unwrap();
    let first_pause = {
        let store = Arc::clone(&store);
        tokio::spawn(async move {
            store
                .pause_schedule("conformance-schedule-control", controlled.revision)
                .await
        })
    };
    let second_pause = {
        let store = Arc::clone(&store);
        tokio::spawn(async move {
            store
                .pause_schedule("conformance-schedule-control", controlled.revision)
                .await
        })
    };
    let mutations = [
        first_pause.await.unwrap().unwrap(),
        second_pause.await.unwrap().unwrap(),
    ];
    assert_eq!(
        mutations
            .iter()
            .filter(|mutation| matches!(mutation, ScheduleMutation::Updated(_)))
            .count(),
        1
    );
    assert_eq!(
        mutations
            .iter()
            .filter(|mutation| matches!(mutation, ScheduleMutation::Conflict { .. }))
            .count(),
        1
    );
    let paused = mutations
        .into_iter()
        .find_map(|mutation| match mutation {
            ScheduleMutation::Updated(schedule) => Some(schedule),
            _ => None,
        })
        .unwrap();
    let resumed = match store
        .resume_schedule(&paused.id, paused.revision)
        .await
        .unwrap()
    {
        ScheduleMutation::Updated(schedule) => schedule,
        mutation => panic!("unexpected resume mutation: {mutation:?}"),
    };
    let rescheduled = match store
        .reschedule_schedule(
            &resumed.id,
            resumed.revision,
            Some(chrono::Utc::now() + chrono::Duration::hours(2)),
            Some(120),
        )
        .await
        .unwrap()
    {
        ScheduleMutation::Updated(schedule) => schedule,
        mutation => panic!("unexpected reschedule mutation: {mutation:?}"),
    };
    assert_eq!(rescheduled.interval_seconds, Some(120));
    assert!(matches!(
        store
            .cancel_schedule(&rescheduled.id, rescheduled.revision)
            .await
            .unwrap(),
        ScheduleMutation::Updated(schedule) if schedule.status == ScheduleStatus::Cancelled
    ));

    let dependency_schedule = store
        .ensure_schedule(morphz::memory::NewSchedule {
            id: "conformance-schedule-dependency".to_string(),
            thread_id: "conformance-schedule-thread".to_string(),
            source_turn_id: "root-conformance-schedule-thread".to_string(),
            intent: "wake after dependency".to_string(),
            not_before: None,
            interval_seconds: None,
            dependency_thread_ids: vec!["conformance-dependency-thread".to_string()],
        })
        .await
        .unwrap();
    let woken = store
        .wake_schedules_for_dependency("conformance-dependency-thread")
        .await
        .unwrap();
    assert!(woken.iter().any(|schedule| {
        schedule.id == dependency_schedule.id && schedule.revision > dependency_schedule.revision
    }));

    let dispatch = store
        .ensure_schedule(morphz::memory::NewSchedule {
            id: "conformance-schedule-dispatch".to_string(),
            thread_id: "conformance-dispatch-thread".to_string(),
            source_turn_id: "root-conformance-dispatch-thread".to_string(),
            intent: "dispatch once".to_string(),
            not_before: None,
            interval_seconds: None,
            dependency_thread_ids: Vec::new(),
        })
        .await
        .unwrap();
    let dispatch_event = Event::new(
        "conformance-schedule-due-event".to_string(),
        "Store-Conformance".to_string(),
        "runtime_control".to_string(),
        "chat/schedule_due".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session",
            "schedule_id": dispatch.id
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    let first_dispatch = {
        let store = Arc::clone(&store);
        let event = dispatch_event.clone();
        tokio::spawn(async move {
            store
                .commit_scheduled_dispatch(
                    "conformance-schedule-dispatch",
                    dispatch.revision,
                    None,
                    &event,
                )
                .await
        })
    };
    let second_dispatch = {
        let store = Arc::clone(&store);
        let event = dispatch_event.clone();
        tokio::spawn(async move {
            store
                .commit_scheduled_dispatch(
                    "conformance-schedule-dispatch",
                    dispatch.revision,
                    None,
                    &event,
                )
                .await
        })
    };
    let dispatches = [
        first_dispatch.await.unwrap().unwrap(),
        second_dispatch.await.unwrap().unwrap(),
    ];
    assert_eq!(dispatches.iter().filter(|value| value.is_some()).count(), 1);
    assert_eq!(
        store
            .query(QueryFilter {
                event_id: Some(dispatch_event.id.clone()),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1
    );

    let failed = store
        .commit_schedule_transaction(
            &[NewThread {
                id: "conformance-schedule-rolled-back-thread".to_string(),
                agent_id: "conformance-agent".to_string(),
                context_id: "conformance-context".to_string(),
                session_id: "conformance-session".to_string(),
                root_turn_id: "root-conformance-schedule-rolled-back".to_string(),
                kind: ThreadKind::Execution,
                executor_kind: "runtime".to_string(),
                executor_id: None,
            }],
            &[morphz::memory::NewSchedule {
                id: "conformance-invalid-schedule".to_string(),
                thread_id: "missing-conformance-thread".to_string(),
                source_turn_id: "missing-root".to_string(),
                intent: "must roll back".to_string(),
                not_before: None,
                interval_seconds: None,
                dependency_thread_ids: Vec::new(),
            }],
        )
        .await;
    assert!(failed.is_err());
    assert!(store
        .get_thread("conformance-schedule-rolled-back-thread")
        .await
        .unwrap()
        .is_none());
    assert!(store
        .list_context_schedules("conformance-context")
        .await
        .unwrap()
        .iter()
        .any(|schedule| schedule.id == "conformance-schedule-dispatch"));
}

async fn assert_delivery_ingress_conformance<S>(store: Arc<S>)
where
    S: DeliveryIngressStore
        + EventStore
        + SessionDirectoryStore
        + ThreadStore
        + Send
        + Sync
        + 'static,
{
    let session = store
        .get_session("conformance-session")
        .await
        .unwrap()
        .unwrap();
    if session.attention_state != SessionAttentionState::Retired {
        store
            .update_session_attention(SessionAttentionUpdate {
                session_id: session.id.clone(),
                context_id: session.context_id.clone(),
                expected_revision: session.attention_revision,
                state: SessionAttentionState::Retired,
                reason: Some("delivery ingress conformance".to_string()),
                changed_at: chrono::Utc::now(),
                event_id: "conformance-ingress-retire".to_string(),
            })
            .await
            .unwrap()
            .unwrap();
    }

    let message = Event::new(
        "conformance-ingress-message".to_string(),
        "user".to_string(),
        "user_message".to_string(),
        "chat/user".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session",
            "text": "hello"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    let first_claim = {
        let store = Arc::clone(&store);
        let event = message.clone();
        tokio::spawn(async move {
            store
                .claim_message("conformance-session", "client-message-a", &event)
                .await
        })
    };
    let second_claim = {
        let store = Arc::clone(&store);
        let event = message.clone();
        tokio::spawn(async move {
            store
                .claim_message("conformance-session", "client-message-a", &event)
                .await
        })
    };
    let claims = [
        first_claim.await.unwrap().unwrap(),
        second_claim.await.unwrap().unwrap(),
    ];
    assert_eq!(
        claims
            .iter()
            .filter(|claim| matches!(claim, MessageClaim::Accepted))
            .count(),
        1
    );
    assert_eq!(
        claims
            .iter()
            .filter(|claim| matches!(claim, MessageClaim::Existing { event_id } if event_id == &message.id))
            .count(),
        1
    );
    assert_eq!(
        store
            .query(QueryFilter {
                event_id: Some(message.id.clone()),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1
    );
    let restored = store
        .get_session("conformance-session")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(restored.attention_state, SessionAttentionState::Active);
    assert_eq!(
        store
            .query(QueryFilter {
                event_id: Some(format!("runtime_session_restored_{}", message.id)),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1
    );

    let delivery_thread = store
        .ensure_thread(NewThread {
            id: "conformance-ingress-delivery-thread".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-context".to_string(),
            session_id: "conformance-session".to_string(),
            root_turn_id: "root-conformance-ingress-delivery".to_string(),
            kind: ThreadKind::Delivery,
            executor_kind: "runtime".to_string(),
            executor_id: None,
        })
        .await
        .unwrap();
    let pending = match store
        .update_thread(
            &delivery_thread.id,
            delivery_thread.revision,
            None,
            Some(ThreadLifecycle::Completed),
            Some("delivered once"),
            Some("conformance-ingress-result"),
            Some(DeliveryStatus::Pending),
            None,
        )
        .await
        .unwrap()
    {
        ThreadMutation::Updated(thread) => thread,
        mutation => panic!("unexpected pending delivery mutation: {mutation:?}"),
    };
    let delivery = Event::new(
        "conformance-ingress-delivery".to_string(),
        "Store-Conformance".to_string(),
        "agent_reply".to_string(),
        "chat/assistant".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session",
            "text": "delivered once"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    let thread_ids = vec![pending.id.clone()];
    let first_delivery = {
        let store = Arc::clone(&store);
        let event = delivery.clone();
        let ids = thread_ids.clone();
        tokio::spawn(async move { store.commit_thread_delivery(&ids, &event).await })
    };
    let second_delivery = {
        let store = Arc::clone(&store);
        let event = delivery.clone();
        let ids = thread_ids.clone();
        tokio::spawn(async move { store.commit_thread_delivery(&ids, &event).await })
    };
    let deliveries = [
        first_delivery.await.unwrap().unwrap(),
        second_delivery.await.unwrap().unwrap(),
    ];
    assert_eq!(deliveries.iter().filter(|delivered| **delivered).count(), 1);
    let delivered = store.get_thread(&pending.id).await.unwrap().unwrap();
    assert_eq!(delivered.delivery_status, DeliveryStatus::Delivered);
    assert_eq!(
        delivered.delivery_event_id.as_deref(),
        Some(delivery.id.as_str())
    );
}

async fn assert_delegation_store_conformance<S>(store: Arc<S>)
where
    S: DelegationStore + EventStore + SessionDirectoryStore + Send + Sync + 'static,
{
    let child = store
        .create_session(NewSession {
            id: "conformance-delegation-child-session".to_string(),
            agent_id: "conformance-agent".to_string(),
            context_id: "conformance-other-context".to_string(),
            parent_session_id: None,
            title: "Delegation Child".to_string(),
            mount_kind: SessionMountKind::NewBlankContext,
        })
        .await
        .unwrap();
    let created = store
        .create_delegation(NewDelegation {
            id: "conformance-delegation".to_string(),
            agent_id: "conformance-agent".to_string(),
            parent_context_id: "conformance-context".to_string(),
            parent_session_id: "conformance-session".to_string(),
            child_context_id: child.context_id.clone(),
            child_session_id: child.id.clone(),
            task: "perform delegated conformance work".to_string(),
            success_when: Some("result reaches parent exactly once".to_string()),
            context_scope: "child_session_only".to_string(),
        })
        .await
        .unwrap();
    assert_eq!(created.status, DelegationStatus::Queued);
    assert_eq!(
        store
            .get_delegation_by_child_session(&child.id)
            .await
            .unwrap()
            .unwrap()
            .id,
        created.id
    );
    assert!(store
        .list_delegations()
        .await
        .unwrap()
        .iter()
        .any(|delegation| delegation.id == created.id));
    let running = store
        .update_delegation_status(&created.id, DelegationStatus::Running, None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(running.status, DelegationStatus::Running);

    let wrong_route = Event::new(
        "conformance-delegation-wrong-route".to_string(),
        "Store-Conformance".to_string(),
        "delegation_result".to_string(),
        "runtime/delegation_result".to_string(),
        json!({
            "context_id": "conformance-other-context",
            "session_id": child.id,
            "delegation_id": running.id
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    assert!(store
        .commit_delegation_result(&running.id, &wrong_route)
        .await
        .is_err());
    assert_eq!(
        store
            .get_delegation(&running.id)
            .await
            .unwrap()
            .unwrap()
            .status,
        DelegationStatus::Running,
        "route validation failure must roll back the lifecycle update"
    );

    let result = Event::new(
        "conformance-delegation-result".to_string(),
        "Store-Conformance".to_string(),
        "delegation_result".to_string(),
        "runtime/delegation_result".to_string(),
        json!({
            "context_id": "conformance-context",
            "session_id": "conformance-session",
            "delegation_id": running.id,
            "text": "delegated result"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    let first = {
        let store = Arc::clone(&store);
        let event = result.clone();
        let id = running.id.clone();
        tokio::spawn(async move { store.commit_delegation_result(&id, &event).await })
    };
    let second = {
        let store = Arc::clone(&store);
        let event = result.clone();
        let id = running.id.clone();
        tokio::spawn(async move { store.commit_delegation_result(&id, &event).await })
    };
    let commits = [
        first.await.unwrap().unwrap(),
        second.await.unwrap().unwrap(),
    ];
    assert_eq!(commits.iter().filter(|committed| **committed).count(), 1);
    let completed = store.get_delegation(&running.id).await.unwrap().unwrap();
    assert_eq!(completed.status, DelegationStatus::Completed);
    assert_eq!(
        completed.result_event_id.as_deref(),
        Some(result.id.as_str())
    );
    assert_eq!(
        store
            .query(QueryFilter {
                event_id: Some(result.id),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1
    );
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
    assert_session_directory_conformance(Arc::clone(&store)).await;
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
    assert_thread_store_conformance(Arc::clone(&store)).await;
    assert_activation_store_conformance(Arc::clone(&store)).await;
    assert_schedule_store_conformance(Arc::clone(&store)).await;
    assert_delivery_ingress_conformance(Arc::clone(&store)).await;
    assert_delegation_store_conformance(Arc::clone(&store)).await;
    assert_timer_lease_conformance(Arc::clone(&store)).await;
    assert_objective_lease_conformance(Arc::clone(&store)).await;
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
    assert_complete_runtime_store::<PostgresStore>();
    let store = Arc::new(PostgresStore::new(&database_url, 8).await.unwrap());
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
    assert_session_directory_conformance(Arc::clone(&store)).await;
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
    assert_thread_store_conformance(Arc::clone(&store)).await;
    assert_activation_store_conformance(Arc::clone(&store)).await;
    assert_schedule_store_conformance(Arc::clone(&store)).await;
    assert_delivery_ingress_conformance(Arc::clone(&store)).await;
    assert_delegation_store_conformance(Arc::clone(&store)).await;
    assert_timer_lease_conformance(Arc::clone(&store)).await;
    assert_objective_lease_conformance(Arc::clone(&store)).await;
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
