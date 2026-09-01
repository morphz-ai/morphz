#![cfg(feature = "experimental-context-db")]

use morphz::context_store::{ContextCollection, ContextMutationPlan, ContextStateMutation};
use morphz::event::Event;
use morphz::experimental::{self, CONTEXT_DB};
use morphz::memory::postgres::PostgresStore;
use morphz::memory::{
    ContextRuntimeDirectoryRequest, ContextRuntimeSessionFilter, ContextRuntimeSnapshotStore,
    MindProjectionCommit, MindProjectionStore, NewAgent, NewCognitiveContext, NewMindProjection,
    NewSession, SessionDirectoryStore, SessionMountKind, SessionProjectionMutation,
};
use morphz::observability::Observability;
use morphz::orchestrator::context::MindState;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tracing::{Event as TracingEvent, Subscriber};
use tracing_subscriber::layer::Context as LayerContext;
use tracing_subscriber::prelude::*;
use tracing_subscriber::Layer;

type TestError = Box<dyn std::error::Error + Send + Sync>;

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

fn state_hash(state: &MindState) -> String {
    format!("{:x}", Sha256::digest(serde_json::to_vec(state).unwrap()))
}

fn permit() -> experimental::ExperimentalFeaturePermit {
    experimental::require_enabled(&BTreeSet::from([CONTEXT_DB.to_string()]), CONTEXT_DB).unwrap()
}

/// Runs in its own integration-test process so the PostgreSQL change listener
/// cannot contaminate the legacy Store's process-global SQL counters.
#[test]
fn postgres_context_db_hot_path_statement_budgets_are_enforced_when_configured() {
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
        run_budget(
            &database_url,
            Arc::clone(&statements),
            Arc::clone(&pool_acquires),
        )
        .await
        .unwrap();
    });
}

async fn run_budget(
    database_url: &str,
    statements: Arc<AtomicUsize>,
    pool_acquires: Arc<AtomicUsize>,
) -> Result<(), TestError> {
    let suffix = format!(
        "{}_{}",
        std::process::id(),
        chrono::Utc::now().timestamp_micros().unsigned_abs()
    );
    let schema = format!("morphz_contextdb_budget_{suffix}");
    let administration = sqlx::PgPool::connect(database_url).await?;
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&administration)
        .await?;
    let separator = if database_url.contains('?') { '&' } else { '?' };
    let scoped_url = format!("{database_url}{separator}options=-csearch_path%3D{schema}%2Cpublic");

    let store = PostgresStore::new_with_context_db(
        &scoped_url,
        8,
        Arc::new(Observability::default()),
        permit(),
    )
    .await?;
    let agent_id = format!("pg-contextdb-budget-agent-{suffix}");
    let context_id = format!("pg-contextdb-budget-context-{suffix}");
    let session_id = format!("pg-contextdb-budget-session-{suffix}");
    store
        .create_agent_bundle(
            NewAgent {
                id: agent_id.clone(),
                title: "PostgreSQL ContextDB Budget Agent".to_string(),
                root_context_id: context_id.clone(),
            },
            NewCognitiveContext {
                id: context_id.clone(),
                agent_id: agent_id.clone(),
                title: "PostgreSQL ContextDB Budget Context".to_string(),
            },
            NewSession {
                id: session_id.clone(),
                agent_id,
                context_id: context_id.clone(),
                parent_session_id: None,
                title: "PostgreSQL ContextDB Budget Session".to_string(),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await?;
    let initial = MindState::default();
    store
        .initialize_mind_projection(NewMindProjection {
            context_id: context_id.clone(),
            revision: 0,
            state: serde_json::to_value(&initial)?,
            state_hash: state_hash(&initial),
            head_event_id: None,
            recall_documents: Vec::new(),
        })
        .await?;

    statements.store(0, Ordering::Relaxed);
    pool_acquires.store(0, Ordering::Relaxed);
    let directory = store
        .read_context_runtime_directory_snapshot(&ContextRuntimeDirectoryRequest {
            context_id: context_id.clone(),
            active_session_id: session_id,
            active_after: chrono::Utc::now() - chrono::Duration::hours(24),
            max_full_sessions: 50,
            max_metadata_sessions: 50,
            session_filter: ContextRuntimeSessionFilter::default(),
        })
        .await?
        .unwrap();
    assert_eq!(
        directory.mind.unwrap().state,
        serde_json::to_value(&initial)?
    );
    assert_eq!(
        statements.load(Ordering::Relaxed),
        1,
        "the PostgreSQL ContextDB directory must remain one MVCC statement"
    );
    assert_eq!(pool_acquires.load(Ordering::Relaxed), 1);

    let mut next = initial.clone();
    next.version = 1;
    next.mutation_clocks.global_barrier_version = 1;
    let event = Event::new(
        format!("pg-contextdb-budget-event-{suffix}"),
        "Agent-Context".to_string(),
        "context_transaction".to_string(),
        "chat/context_tx_committed".to_string(),
        json!({"context_id": context_id})
            .as_object()
            .unwrap()
            .clone(),
    );
    let plan = ContextMutationPlan {
        context_id: context_id.clone(),
        expected_revision: 0,
        next_revision: 1,
        expected_state_hash: state_hash(&initial),
        next_state_hash: state_hash(&next),
        mutations: vec![ContextStateMutation::Upsert {
            collection: ContextCollection::MutationClocks,
            logical_id: "mutation-clocks".to_string(),
            body: serde_json::to_value(&next.mutation_clocks)?,
            order: None,
        }],
    };
    statements.store(0, Ordering::Relaxed);
    pool_acquires.store(0, Ordering::Relaxed);
    assert!(matches!(
        store
            .commit_mind_projection_transaction(
                &event,
                &[],
                &SessionProjectionMutation::default(),
                Some(&plan),
                0,
                NewMindProjection {
                    context_id,
                    revision: 1,
                    state: serde_json::to_value(&next)?,
                    state_hash: state_hash(&next),
                    head_event_id: Some(event.id.clone()),
                    recall_documents: Vec::new(),
                },
            )
            .await?,
        MindProjectionCommit::Committed { .. }
    ));
    assert_eq!(
        statements.load(Ordering::Relaxed),
        7,
        "an ordinary PostgreSQL ContextDB commit must retain BEGIN + five bounded SQL statements + COMMIT"
    );
    assert_eq!(pool_acquires.load(Ordering::Relaxed), 1);

    drop(store);
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&administration)
        .await?;
    Ok(())
}
