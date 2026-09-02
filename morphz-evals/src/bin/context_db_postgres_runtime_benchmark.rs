//! Side-by-side PostgreSQL Runtime Mind benchmark for the legacy projection
//! path and the ContextDB-authoritative path.
//!
//! The benchmark alternates arm order on every sample so database cache and
//! short-lived host load do not consistently favor the second arm.

use morphz::config::OrchestratorConfig;
use morphz::context_store::{
    ContextMutationPlan, ContextNodeValue, ContextStateCommit, ContextStateMutation,
};
use morphz::event::Event;
use morphz::memory::postgres::PostgresStore;
use morphz::memory::{
    ContextStore, EventStore, MindProjectionStore, NewAgent, NewCognitiveContext,
    NewMindProjection, SessionDirectoryStore, SessionProjectionMutation,
};
use morphz::observability::Observability;
use morphz::orchestrator::context::{
    ContextEngine, ContextFrame, FrameIdentityProvenance, MindState,
};
use serde::Serialize;
use sqlx::postgres::PgPoolOptions;
use std::env;
use std::sync::Arc;
use std::time::{Duration, Instant};

type BenchError = Box<dyn std::error::Error + Send + Sync>;

const DATABASE_URL_ENV: &str = "MORPHZ_BENCH_POSTGRES_URL";

#[derive(Debug, Serialize)]
struct LatencySummary {
    samples: usize,
    mean_ms: f64,
    p50_ms: f64,
    p95_ms: f64,
    p99_ms: f64,
    max_ms: f64,
}

impl LatencySummary {
    fn from_durations(samples: &[Duration]) -> Self {
        let mut micros = samples.iter().map(Duration::as_micros).collect::<Vec<_>>();
        micros.sort_unstable();
        let total = micros.iter().copied().sum::<u128>();
        let as_ms = |value: u128| value as f64 / 1_000.0;
        Self {
            samples: micros.len(),
            mean_ms: if micros.is_empty() {
                0.0
            } else {
                as_ms(total) / micros.len() as f64
            },
            p50_ms: as_ms(nearest_rank(&micros, 50)),
            p95_ms: as_ms(nearest_rank(&micros, 95)),
            p99_ms: as_ms(nearest_rank(&micros, 99)),
            max_ms: as_ms(*micros.last().unwrap_or(&0)),
        }
    }
}

#[derive(Debug, Serialize)]
struct ArmReport {
    commit: LatencySummary,
    native_context_state_read: LatencySummary,
    /// Runtime-facing read after the first validated load has populated the
    /// exclusive-process Context working set.
    runtime_cached_context_read: LatencySummary,
    /// Legacy compatibility surface which serializes typed Context state
    /// through opaque JSON. It is retained temporarily for migration/audit.
    authoritative_mind_read: LatencySummary,
}

#[derive(Debug, Serialize)]
struct BenchmarkReport {
    generated_at: chrono::DateTime<chrono::Utc>,
    postgres_server_version: String,
    mind_json_bytes: usize,
    frames: usize,
    frame_body_bytes: usize,
    warmup_commits: usize,
    measured_commits: usize,
    measured_reads: usize,
    pool_size: u32,
    legacy: ArmReport,
    context_db: ArmReport,
    exact_final_state_match: bool,
    schemas_cleaned: bool,
}

fn nearest_rank(sorted: &[u128], percentile: usize) -> u128 {
    if sorted.is_empty() {
        return 0;
    }
    let rank = (sorted.len() * percentile).div_ceil(100);
    sorted[rank.saturating_sub(1).min(sorted.len() - 1)]
}

fn setting(name: &str, default: usize) -> Result<usize, BenchError> {
    let value = env::var(name)
        .ok()
        .map(|value| value.parse::<usize>())
        .transpose()?
        .unwrap_or(default);
    if value == 0 {
        return Err(format!("{name} must be greater than zero").into());
    }
    Ok(value)
}

fn scoped_url(database_url: &str, schema: &str) -> String {
    let separator = if database_url.contains('?') { '&' } else { '?' };
    format!("{database_url}{separator}options=-csearch_path%3D{schema}")
}

fn state_hash(state: &MindState) -> String {
    morphz::context_store::context_state_hash(state).expect("commit benchmark Mind")
}

fn initial_state(frame_count: usize, body_bytes: usize) -> MindState {
    MindState {
        frames: (0..frame_count)
            .map(|index| ContextFrame {
                id: format!("frame-{index:06}"),
                body: format!("(fact payload-{})", "x".repeat(body_bytes)),
                sources: Vec::new(),
                provenance: FrameIdentityProvenance::default(),
                revision: 1,
                created_version: 0,
                updated_version: 0,
            })
            .collect(),
        ..Default::default()
    }
}

async fn prepare_store(
    store: &PostgresStore,
    label: &str,
    state: &MindState,
) -> Result<(), BenchError> {
    let agent_id = format!("benchmark-agent-{label}");
    let context_id = format!("benchmark-context-{label}");
    store
        .create_agent(NewAgent {
            id: agent_id.clone(),
            title: agent_id.clone(),
            root_context_id: context_id.clone(),
        })
        .await?;
    store
        .create_context(NewCognitiveContext {
            id: context_id.clone(),
            agent_id,
            title: context_id.clone(),
        })
        .await?;
    store
        .initialize_mind_projection(NewMindProjection {
            context_id,
            revision: state.version,
            state: serde_json::to_value(state)?,
            state_hash: state_hash(state),
            head_event_id: None,
            recall_documents: Vec::new(),
        })
        .await?;
    Ok(())
}

async fn commit_once(
    store: &PostgresStore,
    label: &str,
    state: &mut MindState,
    body_bytes: usize,
    iteration: usize,
) -> Result<Duration, BenchError> {
    let context_id = format!("benchmark-context-{label}");
    let expected_revision = state.version;
    let expected_state_hash = state_hash(state);
    state.version += 1;
    let frame_index = iteration % state.frames.len();
    let frame = &mut state.frames[frame_index];
    frame.body = format!(
        "(fact (iteration {iteration}) payload-{})",
        "y".repeat(body_bytes)
    );
    frame.revision += 1;
    frame.updated_version = state.version;
    let frame_value = ContextNodeValue::Frame(frame.clone());
    let next_state_hash = state_hash(state);
    let mutation_plan = ContextMutationPlan {
        context_id: context_id.clone(),
        expected_revision,
        next_revision: state.version,
        expected_state_hash,
        next_state_hash: next_state_hash.clone(),
        mutations: vec![ContextStateMutation::Upsert {
            value: frame_value,
            order: Some(u64::try_from(frame_index)?),
        }],
    };
    let event = Event::new(
        format!("benchmark-{label}-event-{iteration}"),
        "Benchmark-Agent".to_string(),
        "context_transaction".to_string(),
        "chat/context_tx_committed".to_string(),
        serde_json::json!({"context_id": context_id})
            .as_object()
            .expect("object payload")
            .clone(),
    );
    let commitment = morphz::context_store::context_state_commitment(state)?;
    let started = Instant::now();
    let committed = store
        .commit_context_mutation_transaction(
            &event,
            &[],
            &SessionProjectionMutation::default(),
            &mutation_plan,
            state,
            &commitment,
            &[],
        )
        .await?;
    let elapsed = started.elapsed();
    if !matches!(committed, ContextStateCommit::Committed { .. }) {
        return Err(format!("{label} commit unexpectedly conflicted").into());
    }
    Ok(elapsed)
}

async fn read_once(
    store: &PostgresStore,
    context_id: &str,
    expected_revision: u64,
) -> Result<Duration, BenchError> {
    let started = Instant::now();
    let projection = store
        .get_mind_projection(context_id)
        .await?
        .ok_or_else(|| format!("benchmark Mind {context_id} is missing"))?;
    let elapsed = started.elapsed();
    if projection.revision != expected_revision {
        return Err(format!(
            "benchmark Mind {context_id} revision {} != {expected_revision}",
            projection.revision
        )
        .into());
    }
    Ok(elapsed)
}

async fn read_context_state_once(
    store: &PostgresStore,
    context_id: &str,
    expected_revision: u64,
) -> Result<Duration, BenchError> {
    let started = Instant::now();
    let state = store
        .get_context_state(context_id)
        .await?
        .ok_or_else(|| format!("benchmark Context state {context_id} is missing"))?;
    let elapsed = started.elapsed();
    if state.revision != expected_revision || state.state.version != expected_revision {
        return Err(format!(
            "benchmark Context state {context_id} revision {}/{} != {expected_revision}",
            state.revision, state.state.version
        )
        .into());
    }
    Ok(elapsed)
}

async fn read_runtime_context_once(
    engine: &ContextEngine,
    context_id: &str,
    expected_revision: u64,
) -> Result<Duration, BenchError> {
    let started = Instant::now();
    let revision = engine.mind_version(context_id).await?;
    let elapsed = started.elapsed();
    if revision != expected_revision {
        return Err(format!(
            "benchmark Runtime Context {context_id} revision {revision} != {expected_revision}"
        )
        .into());
    }
    Ok(elapsed)
}

#[tokio::main]
async fn main() -> Result<(), BenchError> {
    let database_url = env::var(DATABASE_URL_ENV)
        .map_err(|_| format!("set {DATABASE_URL_ENV} to an explicitly selected test database"))?;
    let frame_count = setting("MORPHZ_CONTEXTDB_RUNTIME_BENCH_FRAMES", 256)?;
    let body_bytes = setting("MORPHZ_CONTEXTDB_RUNTIME_BENCH_BODY_BYTES", 512)?;
    let warmups = setting("MORPHZ_CONTEXTDB_RUNTIME_BENCH_WARMUPS", 10)?;
    let iterations = setting("MORPHZ_CONTEXTDB_RUNTIME_BENCH_ITERATIONS", 200)?;
    let reads = setting("MORPHZ_CONTEXTDB_RUNTIME_BENCH_READS", 200)?;
    let pool_size = u32::try_from(setting("MORPHZ_CONTEXTDB_RUNTIME_BENCH_POOL_SIZE", 8)?)?;
    let suffix = format!(
        "{}_{}",
        std::process::id(),
        chrono::Utc::now().timestamp_micros().unsigned_abs()
    );
    let legacy_schema = format!("morphz_context_bench_legacy_{suffix}");
    let context_db_schema = format!("morphz_context_bench_contextdb_{suffix}");
    let administration = PgPoolOptions::new()
        .max_connections(2)
        .connect(&database_url)
        .await?;
    sqlx::query(&format!("CREATE SCHEMA {legacy_schema}"))
        .execute(&administration)
        .await?;
    sqlx::query(&format!("CREATE SCHEMA {context_db_schema}"))
        .execute(&administration)
        .await?;

    let legacy =
        Arc::new(PostgresStore::new(&scoped_url(&database_url, &legacy_schema), pool_size).await?);
    let context_db = Arc::new(
        PostgresStore::new_with_context_db(
            &scoped_url(&database_url, &context_db_schema),
            pool_size,
            Arc::new(Observability::default()),
        )
        .await?,
    );
    let server_version: String = sqlx::query_scalar("SHOW server_version")
        .fetch_one(legacy.pool())
        .await?;
    let initial = initial_state(frame_count, body_bytes);
    let mind_json_bytes = serde_json::to_vec(&initial)?.len();
    prepare_store(&legacy, "legacy", &initial).await?;
    prepare_store(&context_db, "context-db", &initial).await?;

    let mut legacy_state = initial.clone();
    let mut context_db_state = initial;
    for iteration in 0..warmups {
        if iteration % 2 == 0 {
            commit_once(&legacy, "legacy", &mut legacy_state, body_bytes, iteration).await?;
            commit_once(
                &context_db,
                "context-db",
                &mut context_db_state,
                body_bytes,
                iteration,
            )
            .await?;
        } else {
            commit_once(
                &context_db,
                "context-db",
                &mut context_db_state,
                body_bytes,
                iteration,
            )
            .await?;
            commit_once(&legacy, "legacy", &mut legacy_state, body_bytes, iteration).await?;
        }
    }

    let mut legacy_commits = Vec::with_capacity(iterations);
    let mut context_db_commits = Vec::with_capacity(iterations);
    for offset in 0..iterations {
        let iteration = warmups + offset;
        if iteration % 2 == 0 {
            legacy_commits.push(
                commit_once(&legacy, "legacy", &mut legacy_state, body_bytes, iteration).await?,
            );
            context_db_commits.push(
                commit_once(
                    &context_db,
                    "context-db",
                    &mut context_db_state,
                    body_bytes,
                    iteration,
                )
                .await?,
            );
        } else {
            context_db_commits.push(
                commit_once(
                    &context_db,
                    "context-db",
                    &mut context_db_state,
                    body_bytes,
                    iteration,
                )
                .await?,
            );
            legacy_commits.push(
                commit_once(&legacy, "legacy", &mut legacy_state, body_bytes, iteration).await?,
            );
        }
    }

    let mut legacy_reads = Vec::with_capacity(reads);
    let mut context_db_reads = Vec::with_capacity(reads);
    let mut legacy_native_reads = Vec::with_capacity(reads);
    let mut context_db_native_reads = Vec::with_capacity(reads);
    for iteration in 0..reads {
        if iteration % 2 == 0 {
            legacy_reads
                .push(read_once(&legacy, "benchmark-context-legacy", legacy_state.version).await?);
            context_db_reads.push(
                read_once(
                    &context_db,
                    "benchmark-context-context-db",
                    context_db_state.version,
                )
                .await?,
            );
        } else {
            context_db_reads.push(
                read_once(
                    &context_db,
                    "benchmark-context-context-db",
                    context_db_state.version,
                )
                .await?,
            );
            legacy_reads
                .push(read_once(&legacy, "benchmark-context-legacy", legacy_state.version).await?);
        }
    }

    let legacy_engine = ContextEngine::new(
        Arc::clone(&legacy) as Arc<dyn EventStore>,
        OrchestratorConfig::default(),
    )
    .with_context_store(Arc::clone(&legacy) as Arc<dyn morphz::memory::ContextStore>);
    let context_db_engine = ContextEngine::new(
        Arc::clone(&context_db) as Arc<dyn EventStore>,
        OrchestratorConfig::default(),
    )
    .with_context_store(Arc::clone(&context_db) as Arc<dyn morphz::memory::ContextStore>);
    // The first call includes the authoritative Store read, integrity
    // validation, and working-set population and is deliberately excluded.
    read_runtime_context_once(
        &legacy_engine,
        "benchmark-context-legacy",
        legacy_state.version,
    )
    .await?;
    read_runtime_context_once(
        &context_db_engine,
        "benchmark-context-context-db",
        context_db_state.version,
    )
    .await?;
    let mut legacy_runtime_cached_reads = Vec::with_capacity(reads);
    let mut context_db_runtime_cached_reads = Vec::with_capacity(reads);
    for iteration in 0..reads {
        if iteration % 2 == 0 {
            legacy_runtime_cached_reads.push(
                read_runtime_context_once(
                    &legacy_engine,
                    "benchmark-context-legacy",
                    legacy_state.version,
                )
                .await?,
            );
            context_db_runtime_cached_reads.push(
                read_runtime_context_once(
                    &context_db_engine,
                    "benchmark-context-context-db",
                    context_db_state.version,
                )
                .await?,
            );
        } else {
            context_db_runtime_cached_reads.push(
                read_runtime_context_once(
                    &context_db_engine,
                    "benchmark-context-context-db",
                    context_db_state.version,
                )
                .await?,
            );
            legacy_runtime_cached_reads.push(
                read_runtime_context_once(
                    &legacy_engine,
                    "benchmark-context-legacy",
                    legacy_state.version,
                )
                .await?,
            );
        }
    }
    for iteration in 0..reads {
        if iteration % 2 == 0 {
            legacy_native_reads.push(
                read_context_state_once(&legacy, "benchmark-context-legacy", legacy_state.version)
                    .await?,
            );
            context_db_native_reads.push(
                read_context_state_once(
                    &context_db,
                    "benchmark-context-context-db",
                    context_db_state.version,
                )
                .await?,
            );
        } else {
            context_db_native_reads.push(
                read_context_state_once(
                    &context_db,
                    "benchmark-context-context-db",
                    context_db_state.version,
                )
                .await?,
            );
            legacy_native_reads.push(
                read_context_state_once(&legacy, "benchmark-context-legacy", legacy_state.version)
                    .await?,
            );
        }
    }

    let legacy_projection = legacy
        .get_mind_projection("benchmark-context-legacy")
        .await?
        .expect("legacy Mind exists");
    let context_db_projection = context_db
        .get_mind_projection("benchmark-context-context-db")
        .await?
        .expect("ContextDB Mind exists");
    let exact_final_state_match = legacy_projection.state == context_db_projection.state
        && legacy_projection.state_hash == context_db_projection.state_hash
        && legacy_projection.revision == context_db_projection.revision;

    drop(legacy_engine);
    drop(context_db_engine);
    drop(legacy);
    drop(context_db);
    sqlx::query(&format!("DROP SCHEMA {legacy_schema} CASCADE"))
        .execute(&administration)
        .await?;
    sqlx::query(&format!("DROP SCHEMA {context_db_schema} CASCADE"))
        .execute(&administration)
        .await?;

    let report = BenchmarkReport {
        generated_at: chrono::Utc::now(),
        postgres_server_version: server_version,
        mind_json_bytes,
        frames: frame_count,
        frame_body_bytes: body_bytes,
        warmup_commits: warmups,
        measured_commits: iterations,
        measured_reads: reads,
        pool_size,
        legacy: ArmReport {
            commit: LatencySummary::from_durations(&legacy_commits),
            native_context_state_read: LatencySummary::from_durations(&legacy_native_reads),
            runtime_cached_context_read: LatencySummary::from_durations(
                &legacy_runtime_cached_reads,
            ),
            authoritative_mind_read: LatencySummary::from_durations(&legacy_reads),
        },
        context_db: ArmReport {
            commit: LatencySummary::from_durations(&context_db_commits),
            native_context_state_read: LatencySummary::from_durations(&context_db_native_reads),
            runtime_cached_context_read: LatencySummary::from_durations(
                &context_db_runtime_cached_reads,
            ),
            authoritative_mind_read: LatencySummary::from_durations(&context_db_reads),
        },
        exact_final_state_match,
        schemas_cleaned: true,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    if !report.exact_final_state_match {
        return Err("legacy and ContextDB final Mind states differ".into());
    }
    Ok(())
}
