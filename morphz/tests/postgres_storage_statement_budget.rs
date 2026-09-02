use morphz::event::Event;
use morphz::memory::postgres::PostgresStore;
use morphz::memory::{
    ActivationStore, CognitiveClockStore, ContextCapabilityBindingStore,
    ContextRuntimeDirectoryRequest, ContextRuntimeSessionFilter, ContextRuntimeSnapshotStore,
    DeliveryIngressStore, EventStore, ExecutionJobStore, ExecutionTargetAuthorizationStore,
    ExecutionTargetStore, MessageClaim, MessageDispatchMode, NewAgent, NewCognitiveContext,
    NewPrincipal, NewSession, NewThreadActivation, ObjectiveStore, RecallProjectionStore,
    SessionAttentionState, SessionAttentionUpdate, SessionContextSharing, SessionDirectoryStore,
    SessionMountKind, SessionProjectionStore, SessionStatus, SessionStore, SessionUpdate,
    ThreadActivationStatus, WorkAssignmentStore, WorkerCoordinationMode,
};
use morphz::orchestrator::context::ContextEngine;
use serde_json::json;
use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tracing::{Event as TracingEvent, Subscriber};
use tracing_subscriber::layer::Context as LayerContext;
use tracing_subscriber::prelude::*;
use tracing_subscriber::Layer;

const STEADY_CONTEXT_SAMPLES: usize = 20;
const DEFAULT_POSTGRES_CONTEXT_P95_BUDGET_MS: u64 = 500;

fn configured_duration_ms(name: &str, default_ms: u64) -> Duration {
    let milliseconds = std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(default_ms);
    Duration::from_millis(milliseconds)
}

fn p95(samples: &mut [Duration]) -> Duration {
    assert!(!samples.is_empty());
    samples.sort_unstable();
    let index = (samples.len() * 95).div_ceil(100).saturating_sub(1);
    samples[index]
}

#[derive(Clone)]
struct PostgresOperationCounter {
    statements: Arc<AtomicUsize>,
    pool_acquires: Arc<AtomicUsize>,
}

impl<S> Layer<S> for PostgresOperationCounter
where
    S: Subscriber,
{
    fn on_event(&self, event: &TracingEvent<'_>, _context: LayerContext<'_, S>) {
        match event.metadata().target() {
            "sqlx::query" => {
                self.statements.fetch_add(1, Ordering::Relaxed);
            }
            "sqlx::pool::acquire" => {
                self.pool_acquires.fetch_add(1, Ordering::Relaxed);
            }
            _ => {}
        }
    }
}

/// PostgreSQL statement accounting has its own process-global subscriber and
/// runs only against an explicitly configured disposable database.
#[test]
fn postgres_hot_path_statement_budgets_are_enforced_when_configured() {
    let Ok(database_url) = std::env::var("MORPHZ_TEST_POSTGRES_URL") else {
        return;
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let statements = Arc::new(AtomicUsize::new(0));
    let pool_acquires = Arc::new(AtomicUsize::new(0));
    tracing::subscriber::set_global_default(
        tracing_subscriber::registry().with(
            PostgresOperationCounter {
                statements: Arc::clone(&statements),
                pool_acquires: Arc::clone(&pool_acquires),
            }
            .with_filter(tracing_subscriber::filter::filter_fn(|metadata| {
                matches!(metadata.target(), "sqlx::query" | "sqlx::pool::acquire")
            })),
        ),
    )
    .unwrap();

    runtime.block_on(async {
        let store = Arc::new(PostgresStore::new(&database_url, 8).await.unwrap());
        let suffix = format!(
            "{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_micros()
        );
        let agent_id = format!("pg-budget-agent-{suffix}");
        let context_id = format!("pg-budget-context-{suffix}");
        let session_id = format!("pg-budget-session-{suffix}");
        let principal_id = format!("pg-budget-principal-{suffix}");
        store
            .create_agent_bundle(
                NewAgent {
                    id: agent_id.clone(),
                    title: "Postgres Budget Agent".to_string(),
                    root_context_id: context_id.clone(),
                },
                NewCognitiveContext {
                    id: context_id.clone(),
                    agent_id: agent_id.clone(),
                    title: "Postgres Budget Context".to_string(),
                },
                NewSession {
                    id: session_id.clone(),
                    agent_id: agent_id.clone(),
                    context_id: context_id.clone(),
                    parent_session_id: None,
                    title: "Postgres Budget Session".to_string(),
                    mount_kind: SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        store
            .ensure_principal(NewPrincipal {
                id: principal_id.clone(),
                provider_id: "test".to_string(),
                assurance: "verified".to_string(),
                display_name: None,
            })
            .await
            .unwrap();
        store
            .bind_session_principal(&session_id, &principal_id)
            .await
            .unwrap();

        statements.store(0, Ordering::Relaxed);
        pool_acquires.store(0, Ordering::Relaxed);
        let directory = store
            .read_context_runtime_directory_snapshot(&ContextRuntimeDirectoryRequest {
                context_id: context_id.clone(),
                active_session_id: session_id.clone(),
                active_after: chrono::Utc::now() - chrono::Duration::hours(24),
                max_full_sessions: 50,
                max_metadata_sessions: 50,
                known_context_state_revision: None,
                session_filter: ContextRuntimeSessionFilter::default(),
            })
            .await
            .unwrap()
            .unwrap();
        assert_eq!(directory.sessions.len(), 1);
        assert_eq!(statements.load(Ordering::Relaxed), 1);
        assert_eq!(pool_acquires.load(Ordering::Relaxed), 1);

        let principal_a = format!("pg-budget-principal-a-{suffix}");
        let principal_b = format!("pg-budget-principal-b-{suffix}");
        for scoped_principal_id in [&principal_a, &principal_b] {
            store
                .ensure_principal(NewPrincipal {
                    id: scoped_principal_id.clone(),
                    provider_id: "test".to_string(),
                    assurance: "verified".to_string(),
                    display_name: None,
                })
                .await
                .unwrap();
        }
        for index in 0..80 {
            let scoped_principal_id = if index % 2 == 0 {
                &principal_a
            } else {
                &principal_b
            };
            store
                .create_session_for_principal(
                    NewSession {
                        id: format!("pg-budget-scale-session-{suffix}-{index:03}"),
                        agent_id: agent_id.clone(),
                        context_id: context_id.clone(),
                        parent_session_id: None,
                        title: format!("Postgres Scale Session {index:03}"),
                        mount_kind: SessionMountKind::ExistingContext,
                    },
                    scoped_principal_id,
                )
                .await
                .unwrap();
        }
        let old_session_id = format!("pg-budget-old-session-{suffix}");
        let archived_session_id = format!("pg-budget-archived-session-{suffix}");
        let retired_session_id = format!("pg-budget-retired-session-{suffix}");
        let isolated_session_id = format!("pg-budget-isolated-session-{suffix}");
        for id in [
            &old_session_id,
            &archived_session_id,
            &retired_session_id,
            &isolated_session_id,
        ] {
            store
                .create_session_for_principal(
                    NewSession {
                        id: id.clone(),
                        agent_id: agent_id.clone(),
                        context_id: context_id.clone(),
                        parent_session_id: None,
                        title: id.clone(),
                        mount_kind: SessionMountKind::ExistingContext,
                    },
                    &principal_a,
                )
                .await
                .unwrap();
        }
        store
            .touch_session(
                &old_session_id,
                chrono::Utc::now() - chrono::Duration::hours(48),
            )
            .await
            .unwrap();
        store
            .update_session(
                &archived_session_id,
                SessionUpdate {
                    status: Some(SessionStatus::Archived),
                    ..SessionUpdate::default()
                },
            )
            .await
            .unwrap();
        store
            .update_session_attention(SessionAttentionUpdate {
                session_id: retired_session_id,
                context_id: context_id.clone(),
                expected_revision: 0,
                state: SessionAttentionState::Retired,
                reason: Some("postgres-statement-budget-test".to_string()),
                changed_at: chrono::Utc::now(),
                event_id: format!("pg-budget-retired-event-{suffix}"),
            })
            .await
            .unwrap();
        store
            .set_session_context_sharing(&isolated_session_id, SessionContextSharing::Isolated)
            .await
            .unwrap();
        statements.store(0, Ordering::Relaxed);
        pool_acquires.store(0, Ordering::Relaxed);
        let bounded = store
            .read_context_runtime_directory_snapshot(&ContextRuntimeDirectoryRequest {
                context_id: context_id.clone(),
                active_session_id: session_id.clone(),
                active_after: chrono::Utc::now() - chrono::Duration::hours(24),
                max_full_sessions: 7,
                max_metadata_sessions: 3,
                known_context_state_revision: None,
                session_filter: ContextRuntimeSessionFilter::default(),
            })
            .await
            .unwrap()
            .unwrap();
        assert_eq!(bounded.sessions.len(), 7);
        assert!(bounded
            .sessions
            .iter()
            .any(|session| session.id == session_id));
        let unscoped_principals = bounded
            .principal_bindings
            .iter()
            .map(|binding| binding.principal_id.as_str())
            .collect::<std::collections::HashSet<_>>();
        assert!(unscoped_principals.contains(principal_a.as_str()));
        assert!(unscoped_principals.contains(principal_b.as_str()));
        assert_eq!(bounded.session_exclusions.outside_window, 1);
        assert_eq!(bounded.session_exclusions.archived, 1);
        assert_eq!(bounded.session_exclusions.retired, 1);
        assert_eq!(bounded.session_exclusions.isolated, 1);
        assert_eq!(bounded.session_exclusions.over_count, 74);
        assert_eq!(statements.load(Ordering::Relaxed), 1);
        assert_eq!(pool_acquires.load(Ordering::Relaxed), 1);

        // Principal scope is an opt-in storage predicate for callers that
        // need it. The Runtime default above is deliberately unscoped so one
        // Agent Context can retain Sessions from different Principals.
        let principal_scoped = store
            .read_context_runtime_directory_snapshot(&ContextRuntimeDirectoryRequest {
                context_id: context_id.clone(),
                active_session_id: session_id.clone(),
                active_after: chrono::Utc::now() - chrono::Duration::hours(24),
                max_full_sessions: 7,
                max_metadata_sessions: 3,
                known_context_state_revision: None,
                session_filter: ContextRuntimeSessionFilter {
                    principal_ids: Some(vec![principal_id.clone()]),
                },
            })
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            principal_scoped
                .sessions
                .iter()
                .map(|session| session.id.as_str())
                .collect::<Vec<_>>(),
            vec![session_id.as_str()]
        );
        assert_eq!(principal_scoped.session_exclusions.over_count, 0);
        assert!(principal_scoped
            .principal_bindings
            .iter()
            .all(|binding| binding.principal_id == principal_id));

        let event_id = format!("pg-budget-event-{suffix}");
        let message = Event::new(
            event_id.clone(),
            "test".to_string(),
            morphz::event::TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            json!({
                "context_id": context_id,
                "session_id": session_id,
                "principal_id": principal_id,
                "text": "measure the PostgreSQL atomic ingress command"
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        statements.store(0, Ordering::Relaxed);
        pool_acquires.store(0, Ordering::Relaxed);
        assert!(matches!(
            store
                .claim_message(
                    &session_id,
                    &format!("pg-budget-client-{suffix}"),
                    &message,
                    MessageDispatchMode::Parallel,
                )
                .await
                .unwrap(),
            MessageClaim::Accepted { .. }
        ));
        assert_eq!(
            statements.load(Ordering::Relaxed),
            1,
            "ordinary PostgreSQL ingress must remain one physical statement/round trip"
        );
        assert_eq!(pool_acquires.load(Ordering::Relaxed), 1);

        statements.store(0, Ordering::Relaxed);
        pool_acquires.store(0, Ordering::Relaxed);
        assert!(matches!(
            store
                .claim_message(
                    &session_id,
                    &format!("pg-budget-client-{suffix}"),
                    &message,
                    MessageDispatchMode::Parallel,
                )
                .await
                .unwrap(),
            MessageClaim::Existing { .. }
        ));
        assert_eq!(
            statements.load(Ordering::Relaxed),
            1,
            "ordinary PostgreSQL idempotent replay must remain one statement/round trip"
        );
        assert_eq!(pool_acquires.load(Ordering::Relaxed), 1);

        let mut conflicting_message = message.clone();
        conflicting_message.payload.insert(
            "text".to_string(),
            json!("a different PostgreSQL payload must conflict"),
        );
        statements.store(0, Ordering::Relaxed);
        pool_acquires.store(0, Ordering::Relaxed);
        assert!(matches!(
            store
                .claim_message(
                    &session_id,
                    &format!("pg-budget-client-{suffix}"),
                    &conflicting_message,
                    MessageDispatchMode::Parallel,
                )
                .await
                .unwrap(),
            MessageClaim::Conflict { .. }
        ));
        assert_eq!(
            statements.load(Ordering::Relaxed),
            1,
            "ordinary PostgreSQL conflicting replay must remain one statement/round trip"
        );
        assert_eq!(pool_acquires.load(Ordering::Relaxed), 1);

        statements.store(0, Ordering::Relaxed);
        pool_acquires.store(0, Ordering::Relaxed);
        let scheduler = store
            .read_context_runtime_scheduler_snapshot(&context_id, &[], 20, 32)
            .await
            .unwrap();
        assert_eq!(scheduler.threads.len(), 1);
        assert_eq!(scheduler.thread_signals.len(), 1);
        assert_eq!(statements.load(Ordering::Relaxed), 1);
        assert_eq!(pool_acquires.load(Ordering::Relaxed), 1);

        let thread = scheduler.threads.first().unwrap();
        let signal = scheduler.thread_signals.first().unwrap();
        let activation_id = format!("pg-budget-activation-{suffix}");
        store
            .ensure_thread_activation(NewThreadActivation {
                id: activation_id.clone(),
                agent_id,
                context_id: context_id.clone(),
                session_id: session_id.clone(),
                initiating_principal_id: Some(principal_id.clone()),
                trigger_event_id: signal.event_id.clone(),
                trigger_sequence: signal.sequence,
                trigger_kind: signal.kind.clone(),
                parent_activation_id: None,
                root_turn_id: thread.root_turn_id.clone(),
            })
            .await
            .unwrap();
        store
            .update_thread_activation(
                &activation_id,
                1,
                ThreadActivationStatus::Running,
                Some("pg-budget-worker"),
                Some(chrono::Utc::now() + chrono::Duration::seconds(30)),
                Some(1),
            )
            .await
            .unwrap();
        store
            .bind_activation_input_signals(&activation_id, std::slice::from_ref(&signal.event_id))
            .await
            .unwrap();

        statements.store(0, Ordering::Relaxed);
        pool_acquires.store(0, Ordering::Relaxed);
        let causality = store
            .read_context_activation_causality_snapshot(
                &context_id,
                &activation_id,
                &thread.root_turn_id,
                &signal.event_id,
            )
            .await
            .unwrap();
        assert_eq!(causality.activation_signals.len(), 1);
        assert_eq!(statements.load(Ordering::Relaxed), 1);
        assert_eq!(pool_acquires.load(Ordering::Relaxed), 1);

        statements.store(0, Ordering::Relaxed);
        pool_acquires.store(0, Ordering::Relaxed);
        let resources = store
            .read_context_execution_resources_snapshot(&context_id, Some(&principal_id), 16, 1_000)
            .await
            .unwrap();
        assert!(resources.background_jobs.is_empty());
        assert_eq!(statements.load(Ordering::Relaxed), 1);
        assert_eq!(pool_acquires.load(Ordering::Relaxed), 1);

        let engine = ContextEngine::new(
            Arc::clone(&store) as Arc<dyn EventStore>,
            morphz::config::OrchestratorConfig::default(),
        )
        .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>)
        .with_capability_binding_store(Arc::clone(&store) as Arc<dyn ContextCapabilityBindingStore>)
        .with_work_assignment_store(Arc::clone(&store) as Arc<dyn WorkAssignmentStore>)
        .with_runtime_snapshot_store(Arc::clone(&store) as Arc<dyn ContextRuntimeSnapshotStore>)
        .with_context_store(Arc::clone(&store) as Arc<dyn morphz::memory::ContextStore>)
        .with_session_projection_store(Arc::clone(&store) as Arc<dyn SessionProjectionStore>)
        .with_recall_projection_store(Arc::clone(&store) as Arc<dyn RecallProjectionStore>)
        .with_cognitive_clock_store(Arc::clone(&store) as Arc<dyn CognitiveClockStore>)
        .with_objective_store(Arc::clone(&store) as Arc<dyn ObjectiveStore>)
        .with_execution_job_store(Arc::clone(&store) as Arc<dyn ExecutionJobStore>)
        .with_execution_target_store(Arc::clone(&store) as Arc<dyn ExecutionTargetStore>)
        .with_execution_target_authorization_store(
            Arc::clone(&store) as Arc<dyn ExecutionTargetAuthorizationStore>
        )
        .with_worker_coordination_mode(WorkerCoordinationMode::SharedLeases);
        engine
            .build_context_encoding(&context_id, &session_id, &HashSet::new())
            .await
            .unwrap();
        statements.store(0, Ordering::Relaxed);
        pool_acquires.store(0, Ordering::Relaxed);
        engine
            .build_context_encoding(&context_id, &session_id, &HashSet::new())
            .await
            .unwrap();
        assert_eq!(
            statements.load(Ordering::Relaxed),
            4,
            "steady PostgreSQL Context compilation must remain four bounded statements"
        );
        assert_eq!(pool_acquires.load(Ordering::Relaxed), 4);

        statements.store(0, Ordering::Relaxed);
        pool_acquires.store(0, Ordering::Relaxed);
        let mut context_samples = Vec::with_capacity(STEADY_CONTEXT_SAMPLES);
        for _ in 0..STEADY_CONTEXT_SAMPLES {
            let started_at = Instant::now();
            engine
                .build_context_encoding(&context_id, &session_id, &HashSet::new())
                .await
                .unwrap();
            context_samples.push(started_at.elapsed());
        }
        assert_eq!(
            statements.load(Ordering::Relaxed),
            4 * STEADY_CONTEXT_SAMPLES,
            "repeated PostgreSQL Context compilation must retain its exact statement budget"
        );
        assert_eq!(
            pool_acquires.load(Ordering::Relaxed),
            4 * STEADY_CONTEXT_SAMPLES,
            "repeated PostgreSQL Context compilation must retain its exact pool-acquire budget"
        );
        let context_p95 = p95(&mut context_samples);
        let context_p95_budget = configured_duration_ms(
            "MORPHZ_TEST_POSTGRES_CONTEXT_P95_MS",
            DEFAULT_POSTGRES_CONTEXT_P95_BUDGET_MS,
        );
        assert!(
            context_p95 <= context_p95_budget,
            "steady PostgreSQL Context p95 {context_p95:?} exceeded local smoke budget {context_p95_budget:?}"
        );

        let activation = store
            .get_thread_activation(&activation_id)
            .await
            .unwrap()
            .unwrap();
        // Warm the third concurrent read connection used only by Activation
        // Contexts before enforcing steady-state physical-operation budgets.
        engine
            .build_context_encoding_for_activation(&context_id, &activation, &HashSet::new())
            .await
            .unwrap();
        statements.store(0, Ordering::Relaxed);
        pool_acquires.store(0, Ordering::Relaxed);
        engine
            .build_context_encoding_for_activation(&context_id, &activation, &HashSet::new())
            .await
            .unwrap();
        assert_eq!(statements.load(Ordering::Relaxed), 5);
        assert_eq!(pool_acquires.load(Ordering::Relaxed), 5);

        let interrupt_event = Event::new(
            format!("pg-budget-interrupt-event-{suffix}"),
            "test".to_string(),
            morphz::event::TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            json!({
                "context_id": context_id,
                "session_id": session_id,
                "principal_id": principal_id,
                "text": "interrupt the still-running PostgreSQL dialogue"
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        statements.store(0, Ordering::Relaxed);
        pool_acquires.store(0, Ordering::Relaxed);
        assert!(matches!(
            store
                .claim_message(
                    &session_id,
                    &format!("pg-budget-interrupt-client-{suffix}"),
                    &interrupt_event,
                    MessageDispatchMode::Interrupt,
                )
                .await
                .unwrap(),
            MessageClaim::Accepted {
                interrupted: Some(_),
                ..
            }
        ));
        assert_eq!(
            statements.load(Ordering::Relaxed),
            1,
            "an uncontended interrupting PostgreSQL ingress must remain one atomic statement/round trip"
        );
        assert_eq!(pool_acquires.load(Ordering::Relaxed), 1);

        let follow_up_event = Event::new(
            format!("pg-budget-follow-up-event-{suffix}"),
            "test".to_string(),
            morphz::event::TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            json!({
                "context_id": context_id,
                "session_id": session_id,
                "principal_id": principal_id,
                "text": "wait for the replacement dialogue to finish"
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        let follow_up_client_id = format!("pg-budget-follow-up-client-{suffix}");
        statements.store(0, Ordering::Relaxed);
        pool_acquires.store(0, Ordering::Relaxed);
        let accepted_follow_up = store
            .claim_message(
                &session_id,
                &follow_up_client_id,
                &follow_up_event,
                MessageDispatchMode::FollowUp,
            )
            .await
            .unwrap();
        assert!(matches!(
            accepted_follow_up,
            MessageClaim::Accepted {
                interrupted: None,
                ..
            }
        ));
        assert_eq!(
            statements.load(Ordering::Relaxed),
            1,
            "an uncontended follow-up PostgreSQL ingress must remain one atomic statement/round trip"
        );
        assert_eq!(pool_acquires.load(Ordering::Relaxed), 1);

        statements.store(0, Ordering::Relaxed);
        pool_acquires.store(0, Ordering::Relaxed);
        assert!(matches!(
            store
                .claim_message(
                    &session_id,
                    &follow_up_client_id,
                    &follow_up_event,
                    MessageDispatchMode::FollowUp,
                )
                .await
                .unwrap(),
            MessageClaim::Existing { .. }
        ));
        assert_eq!(
            statements.load(Ordering::Relaxed),
            1,
            "an uncontended ordered PostgreSQL idempotent replay must remain one atomic statement/round trip"
        );
        assert_eq!(pool_acquires.load(Ordering::Relaxed), 1);

        let batched_interrupt_event = Event::new(
            format!("pg-budget-batched-interrupt-event-{suffix}"),
            "test".to_string(),
            morphz::event::TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            json!({
                "context_id": context_id,
                "session_id": session_id,
                "principal_id": principal_id,
                "text": "batch another correction into the pending interrupt dialogue"
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        statements.store(0, Ordering::Relaxed);
        pool_acquires.store(0, Ordering::Relaxed);
        assert!(matches!(
            store
                .claim_message(
                    &session_id,
                    &format!("pg-budget-batched-interrupt-client-{suffix}"),
                    &batched_interrupt_event,
                    MessageDispatchMode::Interrupt,
                )
                .await
                .unwrap(),
            MessageClaim::Accepted {
                interrupted: None,
                ..
            }
        ));
        assert_eq!(
            statements.load(Ordering::Relaxed),
            1,
            "an uncontended pending interrupt batch must remain one atomic statement/round trip"
        );
        assert_eq!(pool_acquires.load(Ordering::Relaxed), 1);
    });
}
