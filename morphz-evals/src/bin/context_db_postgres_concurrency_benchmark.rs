//! Multi-Context PostgreSQL saturation benchmark for the native ContextDB
//! mutation path.
//!
//! Every worker owns one independent Context and commits serially within that
//! Context. Workers run concurrently, so no logical row is shared across
//! workers. This isolates the scaling shape required by a multi-tenant cloud:
//! per-Context ordering remains strict while unrelated Contexts should consume
//! the PostgreSQL pool and server in parallel.

use morphz::context_store::{
    context_state_commitment, ContextMutationPlan, ContextNodeValue, ContextStateCommit,
    ContextStateMutation,
};
use morphz::event::Event;
use morphz::memory::postgres::PostgresStore;
use morphz::memory::{
    ContextStore, MindProjectionStore, NewAgent, NewCognitiveContext, NewMindProjection,
    SessionDirectoryStore, SessionProjectionMutation,
};
use morphz::observability::Observability;
use morphz::orchestrator::context::{ContextFrame, FrameIdentityProvenance, MindState};
use serde::Serialize;
use sqlx::postgres::PgPoolOptions;
use sqlx::{Executor, PgPool, Row};
use std::collections::BTreeSet;
use std::env;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{watch, Barrier};
use tokio::task::JoinSet;

type BenchError = Box<dyn std::error::Error + Send + Sync>;

const DATABASE_URL_ENV: &str = "MORPHZ_BENCH_POSTGRES_URL";
const APPLICATION_NAME: &str = "morphz_contextdb_concurrency";

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
        let millis = |value: u128| value as f64 / 1_000.0;
        Self {
            samples: micros.len(),
            mean_ms: if micros.is_empty() {
                0.0
            } else {
                millis(total) / micros.len() as f64
            },
            p50_ms: millis(nearest_rank(&micros, 50)),
            p95_ms: millis(nearest_rank(&micros, 95)),
            p99_ms: millis(nearest_rank(&micros, 99)),
            max_ms: millis(*micros.last().unwrap_or(&0)),
        }
    }
}

#[derive(Debug, Default, Serialize)]
struct ActivityPeak {
    pool_connections: u32,
    pool_in_use: u32,
    postgres_active: i64,
    postgres_waiting: i64,
    postgres_lock_waiting: i64,
    wait_events: BTreeSet<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
struct SchemaCounters {
    seq_scans: i64,
    index_scans: i64,
    tup_inserted: i64,
    tup_updated: i64,
    tup_deleted: i64,
    heap_blks_read: i64,
    heap_blks_hit: i64,
    index_blks_read: i64,
    index_blks_hit: i64,
    toast_blks_read: i64,
    toast_blks_hit: i64,
}

impl SchemaCounters {
    fn delta(&self, before: &Self) -> Self {
        Self {
            seq_scans: self.seq_scans - before.seq_scans,
            index_scans: self.index_scans - before.index_scans,
            tup_inserted: self.tup_inserted - before.tup_inserted,
            tup_updated: self.tup_updated - before.tup_updated,
            tup_deleted: self.tup_deleted - before.tup_deleted,
            heap_blks_read: self.heap_blks_read - before.heap_blks_read,
            heap_blks_hit: self.heap_blks_hit - before.heap_blks_hit,
            index_blks_read: self.index_blks_read - before.index_blks_read,
            index_blks_hit: self.index_blks_hit - before.index_blks_hit,
            toast_blks_read: self.toast_blks_read - before.toast_blks_read,
            toast_blks_hit: self.toast_blks_hit - before.toast_blks_hit,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
struct WalCounters {
    records: i64,
    full_page_images: i64,
    bytes: i64,
}

impl WalCounters {
    fn delta(&self, before: &Self) -> Self {
        Self {
            records: self.records - before.records,
            full_page_images: self.full_page_images - before.full_page_images,
            bytes: self.bytes - before.bytes,
        }
    }
}

#[derive(Debug, Serialize)]
struct LevelReport {
    concurrency: usize,
    contexts: usize,
    context_commits_per_context: usize,
    committed_context_commits: usize,
    elapsed_ms: f64,
    throughput_context_commits_per_second: f64,
    scale_vs_single: f64,
    linear_efficiency: f64,
    prepare_commitment: LatencySummary,
    store_commit: LatencySummary,
    select_one_under_load: LatencySummary,
    activity_peak: ActivityPeak,
    schema_delta: SchemaCounters,
    wal_delta: WalCounters,
    wal_bytes_per_context_commit: f64,
    conflicts: usize,
    errors: usize,
    exact_final_revisions: bool,
}

#[derive(Debug, Serialize)]
struct BenchmarkReport {
    generated_at: chrono::DateTime<chrono::Utc>,
    postgres_server_version: String,
    postgres_max_connections: i32,
    pool_size: u32,
    frame_count: usize,
    frame_body_bytes: usize,
    initial_mind_json_bytes: usize,
    levels: Vec<LevelReport>,
    schemas_cleaned: bool,
}

#[derive(Debug)]
struct WorkerReport {
    prepare: Vec<Duration>,
    commit: Vec<Duration>,
    committed: usize,
    conflicts: usize,
    errors: usize,
}

fn nearest_rank(sorted: &[u128], percentile: usize) -> u128 {
    if sorted.is_empty() {
        return 0;
    }
    let rank = (sorted.len() * percentile).div_ceil(100);
    sorted[rank.saturating_sub(1).min(sorted.len() - 1)]
}

fn env_usize(name: &str, default: usize) -> Result<usize, BenchError> {
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

fn concurrency_levels() -> Result<Vec<usize>, BenchError> {
    let raw = env::var("MORPHZ_CONTEXTDB_CONCURRENCY_LEVELS")
        .unwrap_or_else(|_| "1,2,4,8,16,32,64".to_string());
    let mut levels = raw
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::parse::<usize>)
        .collect::<Result<Vec<_>, _>>()?;
    levels.sort_unstable();
    levels.dedup();
    if levels.first() != Some(&1) || levels.contains(&0) {
        return Err("concurrency levels must contain 1 and only positive values".into());
    }
    Ok(levels)
}

fn scoped_url(database_url: &str, schema: &str) -> String {
    let separator = if database_url.contains('?') { '&' } else { '?' };
    format!(
        "{database_url}{separator}application_name={APPLICATION_NAME}&options=-csearch_path%3D{schema}"
    )
}

fn benchmark_state(frame_count: usize, body_bytes: usize) -> MindState {
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
        ..MindState::default()
    }
}

async fn schema_counters(pool: &PgPool, schema: &str) -> Result<SchemaCounters, BenchError> {
    let row = sqlx::query(
        r#"SELECT table_stats.*, io_stats.*
           FROM (
             SELECT COALESCE(SUM(seq_scan), 0)::BIGINT AS seq_scans,
                    COALESCE(SUM(idx_scan), 0)::BIGINT AS index_scans,
                    COALESCE(SUM(n_tup_ins), 0)::BIGINT AS tup_inserted,
                    COALESCE(SUM(n_tup_upd), 0)::BIGINT AS tup_updated,
                    COALESCE(SUM(n_tup_del), 0)::BIGINT AS tup_deleted
             FROM pg_stat_user_tables WHERE schemaname = $1
           ) table_stats
           CROSS JOIN (
             SELECT COALESCE(SUM(heap_blks_read), 0)::BIGINT AS heap_blks_read,
                    COALESCE(SUM(heap_blks_hit), 0)::BIGINT AS heap_blks_hit,
                    COALESCE(SUM(idx_blks_read), 0)::BIGINT AS index_blks_read,
                    COALESCE(SUM(idx_blks_hit), 0)::BIGINT AS index_blks_hit,
                    COALESCE(SUM(toast_blks_read), 0)::BIGINT AS toast_blks_read,
                    COALESCE(SUM(toast_blks_hit), 0)::BIGINT AS toast_blks_hit
             FROM pg_statio_user_tables WHERE schemaname = $1
           ) io_stats"#,
    )
    .bind(schema)
    .fetch_one(pool)
    .await?;
    Ok(SchemaCounters {
        seq_scans: row.get("seq_scans"),
        index_scans: row.get("index_scans"),
        tup_inserted: row.get("tup_inserted"),
        tup_updated: row.get("tup_updated"),
        tup_deleted: row.get("tup_deleted"),
        heap_blks_read: row.get("heap_blks_read"),
        heap_blks_hit: row.get("heap_blks_hit"),
        index_blks_read: row.get("index_blks_read"),
        index_blks_hit: row.get("index_blks_hit"),
        toast_blks_read: row.get("toast_blks_read"),
        toast_blks_hit: row.get("toast_blks_hit"),
    })
}

async fn wal_counters(pool: &PgPool) -> Result<WalCounters, BenchError> {
    let row = sqlx::query(
        r#"SELECT wal_records::BIGINT AS records,
                  wal_fpi::BIGINT AS full_page_images,
                  wal_bytes::NUMERIC::BIGINT AS bytes
           FROM pg_stat_wal"#,
    )
    .fetch_one(pool)
    .await?;
    Ok(WalCounters {
        records: row.get("records"),
        full_page_images: row.get("full_page_images"),
        bytes: row.get("bytes"),
    })
}

/// PostgreSQL backends publish table/IO counters lazily. Hold every currently
/// established Store connection at one barrier and force each backend to
/// flush its own local counters before taking a schema-scoped snapshot.
async fn force_store_stats_flush(pool: &PgPool) -> Result<(), BenchError> {
    let connections = usize::try_from(pool.size().max(1))?;
    let barrier = Arc::new(Barrier::new(connections + 1));
    let mut tasks = JoinSet::new();
    for _ in 0..connections {
        let pool = pool.clone();
        let barrier = Arc::clone(&barrier);
        tasks.spawn(async move {
            let mut connection = pool.acquire().await?;
            barrier.wait().await;
            connection
                .execute("SELECT pg_stat_force_next_flush()")
                .await?;
            Ok::<(), BenchError>(())
        });
    }
    barrier.wait().await;
    while let Some(result) = tasks.join_next().await {
        result??;
    }
    Ok(())
}

async fn prepare_contexts(
    store: &PostgresStore,
    prefix: &str,
    contexts: usize,
    initial: &MindState,
) -> Result<Vec<String>, BenchError> {
    let mut ids = Vec::with_capacity(contexts);
    let state_hash = context_state_commitment(initial)?.state_hash().to_string();
    for index in 0..contexts {
        let agent_id = format!("{prefix}-agent-{index}");
        let context_id = format!("{prefix}-context-{index}");
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
                context_id: context_id.clone(),
                revision: initial.version,
                state: serde_json::to_value(initial)?,
                state_hash: state_hash.clone(),
                head_event_id: None,
                recall_documents: Vec::new(),
            })
            .await?;
        ids.push(context_id);
    }
    Ok(ids)
}

async fn monitor_activity(
    store_pool: PgPool,
    monitor_pool: PgPool,
    mut stop: watch::Receiver<bool>,
) -> Result<ActivityPeak, BenchError> {
    let mut peak = ActivityPeak::default();
    loop {
        let size = store_pool.size();
        let idle = u32::try_from(store_pool.num_idle()).unwrap_or(u32::MAX);
        peak.pool_connections = peak.pool_connections.max(size);
        peak.pool_in_use = peak.pool_in_use.max(size.saturating_sub(idle));
        let rows = sqlx::query(
            r#"SELECT state, wait_event_type, wait_event
               FROM pg_stat_activity WHERE application_name = $1"#,
        )
        .bind(APPLICATION_NAME)
        .fetch_all(&monitor_pool)
        .await?;
        let mut active = 0i64;
        let mut waiting = 0i64;
        let mut lock_waiting = 0i64;
        for row in rows {
            // A backend can disappear between PostgreSQL collecting and
            // returning pg_stat_activity. Treat that transient NULL state as
            // non-active instead of letting the observer terminate the load.
            if row.get::<Option<String>, _>("state").as_deref() != Some("active") {
                continue;
            }
            active += 1;
            let wait_type = row.get::<Option<String>, _>("wait_event_type");
            let wait_event = row.get::<Option<String>, _>("wait_event");
            if let Some(wait_type) = wait_type.filter(|wait_type| wait_type != "Client") {
                waiting += 1;
                lock_waiting += i64::from(wait_type == "Lock");
                peak.wait_events.insert(format!(
                    "{wait_type}:{}",
                    wait_event.as_deref().unwrap_or("unknown")
                ));
            }
        }
        peak.postgres_active = peak.postgres_active.max(active);
        peak.postgres_waiting = peak.postgres_waiting.max(waiting);
        peak.postgres_lock_waiting = peak.postgres_lock_waiting.max(lock_waiting);

        tokio::select! {
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    break;
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(2)) => {}
        }
    }
    Ok(peak)
}

async fn select_one_probe(
    pool: PgPool,
    mut stop: watch::Receiver<bool>,
    barrier: Arc<Barrier>,
) -> Result<Vec<Duration>, BenchError> {
    barrier.wait().await;
    let mut durations = Vec::new();
    while !*stop.borrow() {
        let started = Instant::now();
        let value: i32 = sqlx::query_scalar("SELECT 1").fetch_one(&pool).await?;
        if value != 1 {
            return Err("SELECT 1 returned a non-one value".into());
        }
        durations.push(started.elapsed());
        tokio::select! {
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    break;
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(1)) => {}
        }
    }
    Ok(durations)
}

async fn run_worker(
    store: Arc<PostgresStore>,
    context_id: String,
    worker_index: usize,
    operations: usize,
    body_bytes: usize,
    mut state: MindState,
    barrier: Arc<Barrier>,
) -> WorkerReport {
    let mut report = WorkerReport {
        prepare: Vec::with_capacity(operations),
        commit: Vec::with_capacity(operations),
        committed: 0,
        conflicts: 0,
        errors: 0,
    };
    let Ok(mut current_commitment) = context_state_commitment(&state) else {
        report.errors += operations;
        return report;
    };
    barrier.wait().await;
    for iteration in 0..operations {
        let expected_revision = state.version;
        let expected_state_hash = current_commitment.state_hash().to_string();
        let prepare_started = Instant::now();
        state.version += 1;
        let frame_index = iteration % state.frames.len();
        let frame = &mut state.frames[frame_index];
        frame.body = format!(
            "(fact (worker {worker_index}) (iteration {iteration}) payload-{})",
            "y".repeat(body_bytes)
        );
        frame.revision += 1;
        frame.updated_version = state.version;
        let mutation = ContextStateMutation::Upsert {
            value: ContextNodeValue::Frame(frame.clone()),
            order: Some(u64::try_from(frame_index).unwrap_or(u64::MAX)),
        };
        let Ok(next_commitment) = context_state_commitment(&state) else {
            report.errors += 1;
            break;
        };
        let plan = ContextMutationPlan {
            context_id: context_id.clone(),
            expected_revision,
            next_revision: state.version,
            expected_state_hash,
            next_state_hash: next_commitment.state_hash().to_string(),
            mutations: vec![mutation],
        };
        report.prepare.push(prepare_started.elapsed());
        let event = Event::new(
            format!("{context_id}-event-{iteration}"),
            "ContextDB-Concurrency-Benchmark".to_string(),
            "context_transaction".to_string(),
            "chat/context_tx_committed".to_string(),
            serde_json::json!({"context_id": context_id})
                .as_object()
                .expect("object payload")
                .clone(),
        );
        let commit_started = Instant::now();
        match store
            .commit_context_mutation_transaction(
                &event,
                &[],
                &SessionProjectionMutation::default(),
                &plan,
                &state,
                &next_commitment,
                &[],
            )
            .await
        {
            Ok(ContextStateCommit::Committed { .. }) => {
                report.commit.push(commit_started.elapsed());
                report.committed += 1;
                current_commitment = next_commitment;
            }
            Ok(ContextStateCommit::Conflict { .. }) => {
                report.commit.push(commit_started.elapsed());
                report.conflicts += 1;
                break;
            }
            Err(_) => {
                report.commit.push(commit_started.elapsed());
                report.errors += 1;
                break;
            }
        }
    }
    report
}

#[tokio::main]
async fn main() -> Result<(), BenchError> {
    let database_url = env::var(DATABASE_URL_ENV)
        .map_err(|_| format!("set {DATABASE_URL_ENV} to an explicitly selected test database"))?;
    let levels = concurrency_levels()?;
    let operations_per_context = env_usize("MORPHZ_CONTEXTDB_CONCURRENCY_COMMITS_PER_CONTEXT", 32)?;
    let frame_count = env_usize("MORPHZ_CONTEXTDB_CONCURRENCY_FRAMES", 64)?;
    let frame_body_bytes = env_usize("MORPHZ_CONTEXTDB_CONCURRENCY_BODY_BYTES", 512)?;
    let pool_size = u32::try_from(env_usize("MORPHZ_CONTEXTDB_CONCURRENCY_POOL_SIZE", 32)?)?;
    let suffix = format!(
        "{}_{}",
        std::process::id(),
        chrono::Utc::now().timestamp_micros().unsigned_abs()
    );
    let schema = format!("morphz_contextdb_concurrency_{suffix}");
    let administration = PgPoolOptions::new()
        .max_connections(2)
        .connect(&database_url)
        .await?;
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&administration)
        .await?;
    let store = Arc::new(
        PostgresStore::new_with_context_db(
            &scoped_url(&database_url, &schema),
            pool_size,
            Arc::new(Observability::default()),
        )
        .await?,
    );
    let server_version: String = sqlx::query_scalar("SHOW server_version")
        .fetch_one(store.pool())
        .await?;
    let max_connections: i32 =
        sqlx::query_scalar("SELECT setting::INT FROM pg_settings WHERE name = 'max_connections'")
            .fetch_one(store.pool())
            .await?;
    let initial = benchmark_state(frame_count, frame_body_bytes);
    let initial_mind_json_bytes = serde_json::to_vec(&initial)?.len();
    let mut reports = Vec::with_capacity(levels.len());
    let mut single_throughput = 0.0;
    // The one-off migration connection is intentionally outside the Runtime
    // pool. Let PostgreSQL publish those bootstrap counters before the first
    // schema-scoped baseline so they cannot be attributed to concurrency=1.
    tokio::time::sleep(Duration::from_millis(1_100)).await;

    for concurrency in levels {
        let prefix = format!("bench-{suffix}-c{concurrency}");
        let context_ids = prepare_contexts(&store, &prefix, concurrency, &initial).await?;
        force_store_stats_flush(store.pool()).await?;
        let before = schema_counters(&administration, &schema).await?;
        let wal_before = wal_counters(&administration).await?;
        let barrier = Arc::new(Barrier::new(concurrency + 2));
        let (stop_tx, stop_rx) = watch::channel(false);
        let monitor = tokio::spawn(monitor_activity(
            store.pool().clone(),
            administration.clone(),
            stop_rx,
        ));
        let probe = tokio::spawn(select_one_probe(
            store.pool().clone(),
            stop_tx.subscribe(),
            Arc::clone(&barrier),
        ));
        let mut workers = JoinSet::new();
        for (worker_index, context_id) in context_ids.iter().cloned().enumerate() {
            workers.spawn(run_worker(
                Arc::clone(&store),
                context_id,
                worker_index,
                operations_per_context,
                frame_body_bytes,
                initial.clone(),
                Arc::clone(&barrier),
            ));
        }
        barrier.wait().await;
        let wall_started = Instant::now();
        let mut prepare = Vec::with_capacity(concurrency * operations_per_context);
        let mut commit = Vec::with_capacity(concurrency * operations_per_context);
        let mut committed = 0usize;
        let mut conflicts = 0usize;
        let mut errors = 0usize;
        while let Some(result) = workers.join_next().await {
            let worker = result?;
            prepare.extend(worker.prepare);
            commit.extend(worker.commit);
            committed += worker.committed;
            conflicts += worker.conflicts;
            errors += worker.errors;
        }
        let elapsed = wall_started.elapsed();
        let _ = stop_tx.send(true);
        let probe_durations = probe.await??;
        let peak = monitor.await??;
        force_store_stats_flush(store.pool()).await?;
        let after = schema_counters(&administration, &schema).await?;
        let wal_delta = wal_counters(&administration).await?.delta(&wal_before);
        let mut exact_final_revisions = true;
        for context_id in &context_ids {
            let state = store
                .get_context_state(context_id)
                .await?
                .ok_or_else(|| format!("Context '{context_id}' disappeared after benchmark"))?;
            exact_final_revisions &= state.revision == operations_per_context as u64;
        }
        let throughput = committed as f64 / elapsed.as_secs_f64();
        if concurrency == 1 {
            single_throughput = throughput;
        }
        let scale = if single_throughput == 0.0 {
            0.0
        } else {
            throughput / single_throughput
        };
        reports.push(LevelReport {
            concurrency,
            contexts: concurrency,
            context_commits_per_context: operations_per_context,
            committed_context_commits: committed,
            elapsed_ms: elapsed.as_secs_f64() * 1_000.0,
            throughput_context_commits_per_second: throughput,
            scale_vs_single: scale,
            linear_efficiency: scale / concurrency as f64,
            prepare_commitment: LatencySummary::from_durations(&prepare),
            store_commit: LatencySummary::from_durations(&commit),
            select_one_under_load: LatencySummary::from_durations(&probe_durations),
            activity_peak: peak,
            schema_delta: after.delta(&before),
            wal_bytes_per_context_commit: wal_delta.bytes as f64 / committed.max(1) as f64,
            wal_delta,
            conflicts,
            errors,
            exact_final_revisions,
        });
        if conflicts != 0 || errors != 0 || !exact_final_revisions {
            return Err(format!(
                "concurrency {concurrency} failed: conflicts={conflicts}, errors={errors}, exact_final_revisions={exact_final_revisions}"
            )
            .into());
        }
    }

    drop(store);
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&administration)
        .await?;
    let report = BenchmarkReport {
        generated_at: chrono::Utc::now(),
        postgres_server_version: server_version,
        postgres_max_connections: max_connections,
        pool_size,
        frame_count,
        frame_body_bytes,
        initial_mind_json_bytes,
        levels: reports,
        schemas_cleaned: true,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
