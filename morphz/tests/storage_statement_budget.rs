use morphz::event::Event;
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{
    ActivationStore, CognitiveClockStore, ContextCapabilityBindingStore,
    ContextRuntimeSnapshotStore, DeliveryIngressStore, EventStore, ExecutionJobStore,
    ExecutionTargetAuthorizationStore, ExecutionTargetStore, MessageClaim, MessageDispatchMode,
    MindProjectionStore, NewAgent, NewCognitiveContext, NewPrincipal, NewSession,
    NewThreadActivation, ObjectiveStore, RecallProjectionStore, SessionDirectoryStore,
    SessionMountKind, SessionProjectionStore, SessionStore, ThreadActivationStatus,
    WorkAssignmentStore, WorkerCoordinationMode,
};
use morphz::orchestrator::context::ContextEngine;
use serde_json::json;
use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tempfile::NamedTempFile;
use tracing::{Event as TracingEvent, Subscriber};
use tracing_subscriber::layer::Context as LayerContext;
use tracing_subscriber::prelude::*;
use tracing_subscriber::Layer;

const STEADY_CONTEXT_SAMPLES: usize = 20;
const DEFAULT_SQLITE_CONTEXT_P95_BUDGET_MS: u64 = 250;

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
struct SqlStatementCounter {
    statements: Arc<AtomicUsize>,
    pool_acquires: Arc<AtomicUsize>,
}

impl<S> Layer<S> for SqlStatementCounter
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

/// This test deliberately lives in its own integration-test binary. SQLx's
/// SQLite worker emits query events from a separate OS thread, so statement
/// accounting needs a process-global subscriber; isolation prevents unrelated
/// parallel tests from contaminating the budget.
#[test]
fn sqlite_hot_path_statement_budgets_are_enforced() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let statements = Arc::new(AtomicUsize::new(0));
    let pool_acquires = Arc::new(AtomicUsize::new(0));
    let subscriber = tracing_subscriber::registry().with(
        SqlStatementCounter {
            statements: Arc::clone(&statements),
            pool_acquires: Arc::clone(&pool_acquires),
        }
        .with_filter(tracing_subscriber::filter::filter_fn(|metadata| {
            matches!(metadata.target(), "sqlx::query" | "sqlx::pool::acquire")
        })),
    );
    tracing::subscriber::set_global_default(subscriber).unwrap();

    runtime.block_on(async {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(database.path().to_str().unwrap())
                .await
                .unwrap(),
        );
        store
            .create_agent_bundle(
                NewAgent {
                    id: "statement-budget-agent".to_string(),
                    title: "Statement Budget Agent".to_string(),
                    root_context_id: "statement-budget-context".to_string(),
                },
                NewCognitiveContext {
                    id: "statement-budget-context".to_string(),
                    agent_id: "statement-budget-agent".to_string(),
                    title: "Statement Budget Context".to_string(),
                },
                NewSession {
                    id: "statement-budget-session".to_string(),
                    agent_id: "statement-budget-agent".to_string(),
                    context_id: "statement-budget-context".to_string(),
                    parent_session_id: None,
                    title: "Statement Budget Session".to_string(),
                    mount_kind: SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        store
            .ensure_principal(NewPrincipal {
                id: "statement-budget-principal".to_string(),
                provider_id: "test".to_string(),
                assurance: "verified".to_string(),
                display_name: None,
            })
            .await
            .unwrap();
        store
            .bind_session_principal("statement-budget-session", "statement-budget-principal")
            .await
            .unwrap();

        statements.store(0, Ordering::Relaxed);
        pool_acquires.store(0, Ordering::Relaxed);
        let snapshot = store
            .read_context_runtime_directory_snapshot("statement-budget-context")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(
            statements.load(Ordering::Relaxed),
            1,
            "the complete Runtime directory must remain one physical statement"
        );
        assert_eq!(pool_acquires.load(Ordering::Relaxed), 1);

        let message = Event::new(
            "statement-budget-event".to_string(),
            "test".to_string(),
            morphz::event::TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            json!({
                "context_id": "statement-budget-context",
                "session_id": "statement-budget-session",
                "principal_id": "statement-budget-principal",
                "text": "measure the atomic ingress command"
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
                    "statement-budget-session",
                    "statement-budget-client-message",
                    &message,
                    MessageDispatchMode::Parallel,
                )
                .await
                .unwrap(),
            MessageClaim::Accepted { .. }
        ));
        let ingress_statements = statements.load(Ordering::Relaxed);
        // This is a physical-operation budget, not permission to add
        // arbitrary reads. The normalized Event, recall, projection, Thread
        // and Signal writes are distinct durable authorities.
        assert_eq!(
            ingress_statements, 9,
            "accepted-message ingress changed its audited physical statement budget"
        );
        assert_eq!(
            pool_acquires.load(Ordering::Relaxed),
            1,
            "one atomic ingress command must acquire the SQLite pool exactly once"
        );

        statements.store(0, Ordering::Relaxed);
        pool_acquires.store(0, Ordering::Relaxed);
        assert!(matches!(
            store
                .claim_message(
                    "statement-budget-session",
                    "statement-budget-client-message",
                    &message,
                    MessageDispatchMode::Parallel,
                )
                .await
                .unwrap(),
            MessageClaim::Existing { .. }
        ));
        assert_eq!(
            statements.load(Ordering::Relaxed),
            3,
            "an SQLite idempotent replay must remain one short immediate transaction"
        );
        assert_eq!(pool_acquires.load(Ordering::Relaxed), 1);

        let mut conflicting_message = message.clone();
        conflicting_message.payload.insert(
            "text".to_string(),
            json!("a different payload must conflict without another write"),
        );
        statements.store(0, Ordering::Relaxed);
        pool_acquires.store(0, Ordering::Relaxed);
        assert!(matches!(
            store
                .claim_message(
                    "statement-budget-session",
                    "statement-budget-client-message",
                    &conflicting_message,
                    MessageDispatchMode::Parallel,
                )
                .await
                .unwrap(),
            MessageClaim::Conflict { .. }
        ));
        assert_eq!(
            statements.load(Ordering::Relaxed),
            3,
            "an SQLite conflicting replay must not execute the accepted-message write set"
        );
        assert_eq!(pool_acquires.load(Ordering::Relaxed), 1);

        statements.store(0, Ordering::Relaxed);
        pool_acquires.store(0, Ordering::Relaxed);
        let scheduler = store
            .read_context_runtime_scheduler_snapshot("statement-budget-context", &[], 20, 32)
            .await
            .unwrap();
        assert_eq!(scheduler.threads.len(), 1);
        assert_eq!(scheduler.thread_signals.len(), 1);
        assert_eq!(
            statements.load(Ordering::Relaxed),
            1,
            "the bounded scheduler graph must remain one physical statement"
        );
        assert_eq!(pool_acquires.load(Ordering::Relaxed), 1);

        let thread = scheduler.threads.first().unwrap();
        let signal = scheduler.thread_signals.first().unwrap();
        store
            .ensure_thread_activation(NewThreadActivation {
                id: "statement-budget-activation".to_string(),
                agent_id: "statement-budget-agent".to_string(),
                context_id: "statement-budget-context".to_string(),
                session_id: "statement-budget-session".to_string(),
                initiating_principal_id: Some("statement-budget-principal".to_string()),
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
                "statement-budget-activation",
                1,
                ThreadActivationStatus::Running,
                Some("statement-budget-worker"),
                Some(chrono::Utc::now() + chrono::Duration::seconds(30)),
                Some(1),
            )
            .await
            .unwrap();
        store
            .bind_activation_input_signals(
                "statement-budget-activation",
                std::slice::from_ref(&signal.event_id),
            )
            .await
            .unwrap();

        statements.store(0, Ordering::Relaxed);
        pool_acquires.store(0, Ordering::Relaxed);
        let causality = store
            .read_context_activation_causality_snapshot(
                "statement-budget-context",
                "statement-budget-activation",
                &thread.root_turn_id,
                &signal.event_id,
            )
            .await
            .unwrap();
        assert_eq!(causality.activation_signals.len(), 1);
        assert_eq!(causality.thread.as_ref().unwrap().id, thread.id);
        assert_eq!(
            causality.trigger_event.as_ref().unwrap().id,
            signal.event_id
        );
        assert_eq!(causality.root_sequence, Some(signal.sequence));
        assert_eq!(
            statements.load(Ordering::Relaxed),
            1,
            "Activation causality must remain one physical statement"
        );
        assert_eq!(pool_acquires.load(Ordering::Relaxed), 1);

        statements.store(0, Ordering::Relaxed);
        pool_acquires.store(0, Ordering::Relaxed);
        let execution_resources = store
            .read_context_execution_resources_snapshot(
                "statement-budget-context",
                Some("statement-budget-principal"),
                16,
                1_000,
            )
            .await
            .unwrap();
        assert!(execution_resources.background_jobs.is_empty());
        assert!(!execution_resources.execution_targets.is_empty());
        assert!(execution_resources.target_authorizations.is_empty());
        assert_eq!(
            statements.load(Ordering::Relaxed),
            1,
            "execution resources must remain one physical statement"
        );
        assert_eq!(pool_acquires.load(Ordering::Relaxed), 1);

        let engine = ContextEngine::new(
            Arc::clone(&store) as Arc<dyn EventStore>,
            morphz::config::OrchestratorConfig::default(),
        )
        .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>)
        .with_capability_binding_store(Arc::clone(&store) as Arc<dyn ContextCapabilityBindingStore>)
        .with_work_assignment_store(Arc::clone(&store) as Arc<dyn WorkAssignmentStore>)
        .with_runtime_snapshot_store(Arc::clone(&store) as Arc<dyn ContextRuntimeSnapshotStore>)
        .with_mind_projection_store(Arc::clone(&store) as Arc<dyn MindProjectionStore>)
        .with_session_projection_store(Arc::clone(&store) as Arc<dyn SessionProjectionStore>)
        .with_recall_projection_store(Arc::clone(&store) as Arc<dyn RecallProjectionStore>)
        .with_cognitive_clock_store(Arc::clone(&store) as Arc<dyn CognitiveClockStore>)
        .with_objective_store(Arc::clone(&store) as Arc<dyn ObjectiveStore>)
        .with_execution_job_store(Arc::clone(&store) as Arc<dyn ExecutionJobStore>)
        .with_execution_target_store(Arc::clone(&store) as Arc<dyn ExecutionTargetStore>)
        .with_execution_target_authorization_store(
            Arc::clone(&store) as Arc<dyn ExecutionTargetAuthorizationStore>
        )
        .with_worker_coordination_mode(WorkerCoordinationMode::ExclusiveProcess);
        // The first build may lazily migrate an Event-only Mind projection;
        // steady-state budgets begin after that one-time compatibility path.
        engine
            .build_context_encoding(
                "statement-budget-context",
                "statement-budget-session",
                &HashSet::new(),
            )
            .await
            .unwrap();
        statements.store(0, Ordering::Relaxed);
        pool_acquires.store(0, Ordering::Relaxed);
        engine
            .build_context_encoding(
                "statement-budget-context",
                "statement-budget-session",
                &HashSet::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            statements.load(Ordering::Relaxed),
            4,
            "steady Context compilation must remain four bounded snapshot statements"
        );
        assert_eq!(
            pool_acquires.load(Ordering::Relaxed),
            4,
            "each bounded Context snapshot may acquire the pool only once"
        );

        statements.store(0, Ordering::Relaxed);
        pool_acquires.store(0, Ordering::Relaxed);
        let mut context_samples = Vec::with_capacity(STEADY_CONTEXT_SAMPLES);
        for _ in 0..STEADY_CONTEXT_SAMPLES {
            let started_at = Instant::now();
            engine
                .build_context_encoding(
                    "statement-budget-context",
                    "statement-budget-session",
                    &HashSet::new(),
                )
                .await
                .unwrap();
            context_samples.push(started_at.elapsed());
        }
        assert_eq!(
            statements.load(Ordering::Relaxed),
            4 * STEADY_CONTEXT_SAMPLES,
            "repeated steady Context compilation must retain its exact statement budget"
        );
        assert_eq!(
            pool_acquires.load(Ordering::Relaxed),
            4 * STEADY_CONTEXT_SAMPLES,
            "repeated steady Context compilation must retain its exact pool-acquire budget"
        );
        let context_p95 = p95(&mut context_samples);
        let context_p95_budget = configured_duration_ms(
            "MORPHZ_TEST_SQLITE_CONTEXT_P95_MS",
            DEFAULT_SQLITE_CONTEXT_P95_BUDGET_MS,
        );
        assert!(
            context_p95 <= context_p95_budget,
            "steady SQLite Context p95 {context_p95:?} exceeded local smoke budget {context_p95_budget:?}"
        );

        let activation = store
            .get_thread_activation("statement-budget-activation")
            .await
            .unwrap()
            .unwrap();
        // Warm the third concurrent read connection used only by Activation
        // Contexts. SQLx connection initialization is a cold-pool concern,
        // while this gate intentionally measures steady semantic commands.
        engine
            .build_context_encoding_for_activation(
                "statement-budget-context",
                &activation,
                &HashSet::new(),
            )
            .await
            .unwrap();
        statements.store(0, Ordering::Relaxed);
        pool_acquires.store(0, Ordering::Relaxed);
        engine
            .build_context_encoding_for_activation(
                "statement-budget-context",
                &activation,
                &HashSet::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            statements.load(Ordering::Relaxed),
            5,
            "Activation Context adds exactly one causal snapshot to the steady four"
        );
        assert_eq!(pool_acquires.load(Ordering::Relaxed), 5);
    });
}
