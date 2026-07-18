use morphz::config::OrchestratorConfig;
use morphz::event::Event;
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{
    EventAppend, EventStore, MindProjectionStore, NewCognitiveContext, NewSession, QueryFilter,
    SessionMountKind, SessionStore,
};
use morphz::orchestrator::context::{ContextEngine, MindProjectionAudit};
use serde::Serialize;
use serde_json::json;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;
use tempfile::TempDir;

type DynError = Box<dyn std::error::Error + Send + Sync>;

#[derive(Debug, Serialize)]
struct ThroughputMeasurement {
    operations: usize,
    commits: usize,
    elapsed_micros: u64,
    operations_per_second: f64,
    database_bytes: u64,
}

#[derive(Debug, Serialize)]
struct ContextScalabilityBenchmark {
    generated_at: chrono::DateTime<chrono::Utc>,
    target: String,
    event_count: usize,
    context_transactions: usize,
    batch_size: usize,
    payload_bytes: usize,
    single_event_append: ThroughputMeasurement,
    batch_event_append: ThroughputMeasurement,
    context_transaction_commit: ThroughputMeasurement,
    projection_hot_reads: ThroughputMeasurement,
    projection_audit: MindProjectionAudit,
}

fn elapsed_micros(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX)
}

fn operations_per_second(operations: usize, elapsed_micros: u64) -> f64 {
    if elapsed_micros == 0 {
        return operations as f64;
    }
    operations as f64 * 1_000_000.0 / elapsed_micros as f64
}

fn sqlite_bytes(path: &Path) -> u64 {
    [
        path.to_path_buf(),
        path.with_extension("db-wal"),
        path.with_extension("db-shm"),
    ]
    .into_iter()
    .filter_map(|path| std::fs::metadata(path).ok())
    .map(|metadata| metadata.len())
    .sum()
}

fn benchmark_event(index: usize, payload_bytes: usize) -> Event {
    Event::new(
        format!("benchmark-event-{index}"),
        "Scalability-Benchmark".to_string(),
        "user_message".to_string(),
        "chat/user_message".to_string(),
        [
            ("context_id".to_string(), json!("benchmark-context")),
            ("session_id".to_string(), json!("benchmark-session")),
            ("text".to_string(), json!("x".repeat(payload_bytes))),
        ]
        .into_iter()
        .collect(),
    )
}

async fn measure_event_appends(
    root: &Path,
    name: &str,
    event_count: usize,
    payload_bytes: usize,
    batch_size: usize,
) -> Result<ThroughputMeasurement, DynError> {
    let db = root.join(format!("{name}.db"));
    let store = SqliteStore::new(db.to_str().ok_or("Benchmark DB 路径不是 UTF-8")?).await?;
    let started = Instant::now();
    let mut commits = 0;
    for batch_start in (0..event_count).step_by(batch_size) {
        let batch_end = batch_start.saturating_add(batch_size).min(event_count);
        let entries = (batch_start..batch_end)
            .map(|index| EventAppend {
                event: benchmark_event(index, payload_bytes),
                signal_outbox: false,
            })
            .collect();
        store.append_batch(entries).await?;
        commits += 1;
    }
    let elapsed_micros = elapsed_micros(started);
    let stored = store
        .query(QueryFilter {
            context_id: Some("benchmark-context".to_string()),
            ..Default::default()
        })
        .await?;
    if stored.len() != event_count {
        return Err(format!(
            "Event benchmark 丢失数据：expected={event_count} actual={}",
            stored.len()
        )
        .into());
    }
    Ok(ThroughputMeasurement {
        operations: event_count,
        commits,
        elapsed_micros,
        operations_per_second: operations_per_second(event_count, elapsed_micros),
        database_bytes: sqlite_bytes(&db),
    })
}

async fn measure_context_transactions(
    root: &Path,
    transactions: usize,
) -> Result<
    (
        ThroughputMeasurement,
        ThroughputMeasurement,
        MindProjectionAudit,
    ),
    DynError,
> {
    let db = root.join("context.db");
    let store = Arc::new(SqliteStore::new(db.to_str().ok_or("Context DB 路径不是 UTF-8")?).await?);
    store
        .create_context(NewCognitiveContext {
            id: "benchmark-context".to_string(),
            agent_id: "benchmark-agent".to_string(),
            title: "Context Scalability Benchmark".to_string(),
        })
        .await?;
    store
        .create_session(NewSession {
            id: "benchmark-session".to_string(),
            agent_id: "benchmark-agent".to_string(),
            context_id: "benchmark-context".to_string(),
            parent_session_id: None,
            title: "Benchmark Session".to_string(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await?;
    let engine = ContextEngine::new(
        Arc::clone(&store) as Arc<dyn EventStore>,
        OrchestratorConfig::default(),
    )
    .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>)
    .with_mind_projection_store(Arc::clone(&store) as Arc<dyn MindProjectionStore>);

    let commit_started = Instant::now();
    for revision in 0..transactions {
        let transaction = if revision == 0 {
            "(context-tx (base-version 0) (create benchmark-frame (value 0)))".to_string()
        } else {
            format!(
                "(context-tx (base-version {revision}) (revise benchmark-frame (value {revision})))"
            )
        };
        engine
            .apply_context_transaction("benchmark-context", "benchmark-session", &transaction)
            .await?;
    }
    let commit_micros = elapsed_micros(commit_started);
    let commit_measurement = ThroughputMeasurement {
        operations: transactions,
        commits: transactions,
        elapsed_micros: commit_micros,
        operations_per_second: operations_per_second(transactions, commit_micros),
        database_bytes: sqlite_bytes(&db),
    };

    let hot_reads = transactions.max(1).saturating_mul(10);
    let reads_started = Instant::now();
    for _ in 0..hot_reads {
        let version = engine.mind_version("benchmark-context").await?;
        if version != transactions as u64 {
            return Err(format!(
                "Projection hot read revision 不一致：expected={transactions} actual={version}"
            )
            .into());
        }
    }
    let read_micros = elapsed_micros(reads_started);
    let read_measurement = ThroughputMeasurement {
        operations: hot_reads,
        commits: 0,
        elapsed_micros: read_micros,
        operations_per_second: operations_per_second(hot_reads, read_micros),
        database_bytes: sqlite_bytes(&db),
    };
    let audit = engine.audit_mind_projection("benchmark-context").await?;
    if !audit.matches {
        return Err("Context benchmark 的 Projection 审计失败".into());
    }
    Ok((commit_measurement, read_measurement, audit))
}

fn parse_positive(value: Option<&String>, default: usize, name: &str) -> Result<usize, DynError> {
    let value = match value {
        Some(value) => value.parse::<usize>()?,
        None => default,
    };
    if value == 0 {
        return Err(format!("{name} 必须大于 0").into());
    }
    Ok(value)
}

#[tokio::main]
async fn main() -> Result<(), DynError> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args
        .iter()
        .any(|arg| matches!(arg.as_str(), "-h" | "--help"))
        || args.len() > 3
    {
        println!(
            "usage: context_scalability_benchmark [EVENTS=5000] [CONTEXT_TX=257] [BATCH_SIZE=64]"
        );
        return Ok(());
    }
    let event_count = parse_positive(args.first(), 5_000, "EVENTS")?;
    let context_transactions = parse_positive(args.get(1), 257, "CONTEXT_TX")?;
    let batch_size = parse_positive(args.get(2), 64, "BATCH_SIZE")?;
    let payload_bytes = 512;
    let temp = TempDir::new()?;
    let single_event_append =
        measure_event_appends(temp.path(), "single", event_count, payload_bytes, 1).await?;
    let batch_event_append =
        measure_event_appends(temp.path(), "batch", event_count, payload_bytes, batch_size).await?;
    let (context_transaction_commit, projection_hot_reads, projection_audit) =
        measure_context_transactions(temp.path(), context_transactions).await?;
    let report = ContextScalabilityBenchmark {
        generated_at: chrono::Utc::now(),
        target: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        event_count,
        context_transactions,
        batch_size,
        payload_bytes,
        single_event_append,
        batch_event_append,
        context_transaction_commit,
        projection_hot_reads,
        projection_audit,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
