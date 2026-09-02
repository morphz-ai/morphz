//! Repeatable microbenchmark for the single-node ContextDB.
//!
//! Run with a release build:
//! `cargo run -p morphz --release --example context_db_sqlite_benchmark`
//!
//! Optional environment variables:
//! - `MORPHZ_CONTEXTDB_BENCH_MIB` (default: 1)
//! - `MORPHZ_CONTEXTDB_BENCH_ITERATIONS` (default: 200)
//! - `MORPHZ_CONTEXTDB_BENCH_CONTEXTS` (default: 8)
//! - `MORPHZ_CONTEXTDB_BENCH_WRITES_PER_CONTEXT` (default: 25)

use morphz::context_db::{
    AuthorityDomain, ContextAuthority, ContextNodeDraft, ContextOperation, ContextStore,
    ContextTransaction, CreateContextRequest, SqliteContextDb,
};
use std::env;
use std::time::{Duration, Instant};

fn setting(name: &str, default: usize) -> usize {
    env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn authority() -> ContextAuthority {
    ContextAuthority::new(
        "benchmark",
        [
            AuthorityDomain::RuntimeInput,
            AuthorityDomain::AgentMind,
            AuthorityDomain::RuntimeControl,
            AuthorityDomain::AgentControl,
            AuthorityDomain::SystemPolicy,
        ],
    )
}

fn node(
    node_id: impl Into<String>,
    parent_id: Option<&str>,
    order_key: i64,
    owner_domain: AuthorityDomain,
    body_sexpr: impl Into<String>,
) -> ContextNodeDraft {
    ContextNodeDraft {
        node_id: node_id.into(),
        parent_id: parent_id.map(str::to_string),
        order_key,
        owner_domain,
        body_sexpr: body_sexpr.into(),
    }
}

fn transaction(
    context_id: &str,
    base_revision: u64,
    key: impl Into<String>,
    operations: Vec<ContextOperation>,
) -> ContextTransaction {
    let key = key.into();
    ContextTransaction {
        transaction_id: format!("transaction-{key}"),
        idempotency_key: key,
        context_id: context_id.to_string(),
        base_revision,
        authority: authority(),
        operations,
    }
}

async fn create_benchmark_context(
    store: &SqliteContextDb,
    context_id: &str,
    payload_bytes: usize,
) -> (u64, u64) {
    let snapshot = store
        .create_context(CreateContextRequest {
            context_id: context_id.to_string(),
            tenant_id: "benchmark-tenant".to_string(),
            agent_id: "benchmark-agent".to_string(),
            authority: authority(),
            root: node(
                "root",
                None,
                0,
                AuthorityDomain::SystemPolicy,
                "(context (protocol (version 1)))",
            ),
        })
        .await
        .expect("create benchmark Context");
    let mut operations = vec![
        ContextOperation::InsertNode {
            node: node(
                "mind",
                Some("root"),
                10,
                AuthorityDomain::AgentMind,
                "(mind)",
            ),
        },
        ContextOperation::InsertNode {
            node: node(
                "hot-frame",
                Some("mind"),
                0,
                AuthorityDomain::AgentMind,
                "(frame (value initial))",
            ),
        },
    ];
    if payload_bytes > 0 {
        operations.push(ContextOperation::InsertNode {
            node: node(
                "cold-large-sibling",
                Some("mind"),
                10,
                AuthorityDomain::AgentMind,
                format!("(tool-result \"{}\")", "x".repeat(payload_bytes)),
            ),
        });
    }
    let receipt = store
        .apply_transaction(transaction(
            context_id,
            snapshot.revision,
            format!("bootstrap-{context_id}"),
            operations,
        ))
        .await
        .expect("bootstrap benchmark Context");
    (receipt.after_revision, 1)
}

fn percentile(samples: &[Duration], percentile: f64) -> Duration {
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    let index = ((sorted.len().saturating_sub(1)) as f64 * percentile).round() as usize;
    sorted[index]
}

fn print_latency(label: &str, samples: &[Duration]) {
    let total = samples.iter().copied().sum::<Duration>();
    let mean = total / u32::try_from(samples.len()).expect("sample count fits u32");
    println!(
        "{label}: n={} mean={:.3}ms p50={:.3}ms p95={:.3}ms p99={:.3}ms",
        samples.len(),
        mean.as_secs_f64() * 1_000.0,
        percentile(samples, 0.50).as_secs_f64() * 1_000.0,
        percentile(samples, 0.95).as_secs_f64() * 1_000.0,
        percentile(samples, 0.99).as_secs_f64() * 1_000.0,
    );
}

#[tokio::main]
async fn main() {
    let payload_mib = setting("MORPHZ_CONTEXTDB_BENCH_MIB", 1);
    let iterations = setting("MORPHZ_CONTEXTDB_BENCH_ITERATIONS", 200).max(1);
    let context_count = setting("MORPHZ_CONTEXTDB_BENCH_CONTEXTS", 8).max(1);
    let writes_per_context = setting("MORPHZ_CONTEXTDB_BENCH_WRITES_PER_CONTEXT", 25).max(1);
    let payload_bytes = payload_mib * 1024 * 1024;

    let directory = tempfile::tempdir().expect("temporary benchmark directory");
    let path = directory.path().join("context.db");
    let store = SqliteContextDb::open(&path)
        .await
        .expect("open ContextDB benchmark store");

    let setup_started = Instant::now();
    let (mut context_revision, initial_node_revision) =
        create_benchmark_context(&store, "large-context", payload_bytes).await;
    println!(
        "ContextDB SQLite benchmark: payload={}MiB iterations={} contexts={} writes/context={}",
        payload_mib, iterations, context_count, writes_per_context
    );
    println!(
        "setup: {:.3}ms",
        setup_started.elapsed().as_secs_f64() * 1_000.0
    );

    let mut commit_samples = Vec::with_capacity(iterations);
    for iteration in 0..iterations {
        let started = Instant::now();
        let receipt = store
            .apply_transaction(transaction(
                "large-context",
                context_revision,
                format!("local-{iteration}"),
                vec![ContextOperation::ReplaceNode {
                    node_id: "hot-frame".to_string(),
                    expected_node_revision: initial_node_revision
                        + u64::try_from(iteration).expect("iteration fits u64"),
                    body_sexpr: format!("(frame (value iteration-{iteration}))"),
                }],
            ))
            .await
            .expect("commit local benchmark mutation");
        commit_samples.push(started.elapsed());
        context_revision = receipt.after_revision;
    }
    print_latency("local leaf commit beside cold payload", &commit_samples);

    let read_iterations = iterations.min(25);
    let mut read_samples = Vec::with_capacity(read_iterations);
    for _ in 0..read_iterations {
        let started = Instant::now();
        let snapshot = store
            .get_context("large-context")
            .await
            .expect("read full benchmark Context");
        assert!(snapshot.canonical_sexpr.len() >= payload_bytes);
        read_samples.push(started.elapsed());
    }
    print_latency("full canonical Context read", &read_samples);

    let mut initial_revisions = Vec::with_capacity(context_count);
    for index in 0..context_count {
        initial_revisions.push(
            create_benchmark_context(&store, &format!("parallel-{index}"), 0)
                .await
                .0,
        );
    }
    let parallel_started = Instant::now();
    let mut tasks = Vec::with_capacity(context_count);
    for (index, mut revision) in initial_revisions.into_iter().enumerate() {
        let store = store.clone();
        tasks.push(tokio::spawn(async move {
            let context_id = format!("parallel-{index}");
            for (node_revision, write) in (1_u64..).zip(0..writes_per_context) {
                let receipt = store
                    .apply_transaction(transaction(
                        &context_id,
                        revision,
                        format!("parallel-{index}-{write}"),
                        vec![ContextOperation::ReplaceNode {
                            node_id: "hot-frame".to_string(),
                            expected_node_revision: node_revision,
                            body_sexpr: format!("(frame (value {index}-{write}))"),
                        }],
                    ))
                    .await
                    .expect("parallel Context mutation");
                revision = receipt.after_revision;
            }
        }));
    }
    for task in tasks {
        task.await.expect("parallel benchmark task");
    }
    let parallel_elapsed = parallel_started.elapsed();
    let parallel_writes = context_count * writes_per_context;
    println!(
        "independent Context write throughput: {} writes in {:.3}s = {:.1} tx/s",
        parallel_writes,
        parallel_elapsed.as_secs_f64(),
        parallel_writes as f64 / parallel_elapsed.as_secs_f64()
    );

    let report = store
        .audit_context("large-context")
        .await
        .expect("audit benchmark Context");
    assert!(report.matches, "benchmark integrity failure: {report:?}");
    let stats = store
        .inspect_context("large-context")
        .await
        .expect("inspect benchmark Context");
    println!(
        "logical Context body bytes={} nodes={} receipts={} sqlite_file_bytes={}",
        stats.logical_body_bytes,
        stats.node_count,
        stats.receipt_count,
        std::fs::metadata(&path)
            .map(|metadata| metadata.len())
            .unwrap_or(0)
    );
    store.close().await;
}
