//! Side-by-side Runtime commit benchmark for the legacy SQLite Mind path and
//! the experimental ContextDB-authoritative path.
//!
//! Run with:
//! `cargo run -p morphz --release --features experimental-context-db --example context_db_runtime_benchmark`
//!
//! Optional environment variables:
//! - `MORPHZ_CONTEXTDB_RUNTIME_BENCH_FRAMES` (default: 256)
//! - `MORPHZ_CONTEXTDB_RUNTIME_BENCH_BODY_BYTES` (default: 512)
//! - `MORPHZ_CONTEXTDB_RUNTIME_BENCH_ITERATIONS` (default: 200)
//! - `MORPHZ_CONTEXTDB_RUNTIME_BENCH_READS` (default: 200)

use morphz::config::SqliteStorageConfig;
use morphz::event::Event;
use morphz::experimental::{require_enabled, CONTEXT_DB};
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{
    MindProjectionCommit, MindProjectionStore, NewAgent, NewCognitiveContext, NewMindProjection,
    SessionDirectoryStore, SessionProjectionMutation,
};
use morphz::orchestrator::context::{ContextFrame, FrameIdentityProvenance, MindState};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::env;
use std::time::{Duration, Instant};

fn setting(name: &str, default: usize) -> usize {
    env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn state_hash(state: &MindState) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(state).expect("serialize benchmark Mind"))
    )
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

fn initial_state(frame_count: usize, body_bytes: usize) -> MindState {
    MindState {
        frames: (0..frame_count)
            .map(|index| ContextFrame {
                id: format!("frame-{index:06}"),
                body: format!("(fact \"{}\")", "x".repeat(body_bytes)),
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

async fn prepare_store(store: &SqliteStore, label: &str, state: &MindState) {
    let agent_id = format!("benchmark-agent-{label}");
    let context_id = format!("benchmark-context-{label}");
    store
        .create_agent(NewAgent {
            id: agent_id.clone(),
            title: agent_id.clone(),
            root_context_id: context_id.clone(),
        })
        .await
        .expect("create benchmark Agent");
    store
        .create_context(NewCognitiveContext {
            id: context_id.clone(),
            agent_id,
            title: context_id.clone(),
        })
        .await
        .expect("create benchmark Context");
    store
        .initialize_mind_projection(NewMindProjection {
            context_id,
            revision: state.version,
            state: serde_json::to_value(state).expect("serialize initial Mind"),
            state_hash: state_hash(state),
            head_event_id: None,
            recall_documents: Vec::new(),
        })
        .await
        .expect("initialize benchmark Mind");
}

async fn run_workload(
    store: &SqliteStore,
    label: &str,
    initial_state: &MindState,
    body_bytes: usize,
    iterations: usize,
    reads: usize,
) {
    let context_id = format!("benchmark-context-{label}");
    let mut state = initial_state.clone();
    let mut commit_samples = Vec::with_capacity(iterations);
    for iteration in 0..iterations {
        let expected_revision = state.version;
        state.version += 1;
        let frame_index = iteration % state.frames.len();
        let frame = &mut state.frames[frame_index];
        frame.body = format!(
            "(fact (iteration {iteration}) \"{}\")",
            "y".repeat(body_bytes)
        );
        frame.revision += 1;
        frame.updated_version = state.version;
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
        let started = Instant::now();
        let result = store
            .commit_mind_projection_transaction(
                &event,
                &[],
                &SessionProjectionMutation::default(),
                expected_revision,
                NewMindProjection {
                    context_id: context_id.clone(),
                    revision: state.version,
                    state: serde_json::to_value(&state).expect("serialize benchmark Mind"),
                    state_hash: state_hash(&state),
                    head_event_id: Some(event.id.clone()),
                    recall_documents: Vec::new(),
                },
            )
            .await
            .expect("commit benchmark Mind");
        assert!(matches!(result, MindProjectionCommit::Committed { .. }));
        commit_samples.push(started.elapsed());
    }
    print_latency(&format!("{label} full Runtime commit"), &commit_samples);

    let mut read_samples = Vec::with_capacity(reads);
    for _ in 0..reads {
        let started = Instant::now();
        let projection = store
            .get_mind_projection(&context_id)
            .await
            .expect("read benchmark Mind")
            .expect("benchmark Mind exists");
        assert_eq!(projection.revision, state.version);
        read_samples.push(started.elapsed());
    }
    print_latency(&format!("{label} authoritative Mind read"), &read_samples);
}

#[tokio::main]
async fn main() {
    let frame_count = setting("MORPHZ_CONTEXTDB_RUNTIME_BENCH_FRAMES", 256).max(1);
    let body_bytes = setting("MORPHZ_CONTEXTDB_RUNTIME_BENCH_BODY_BYTES", 512);
    let iterations = setting("MORPHZ_CONTEXTDB_RUNTIME_BENCH_ITERATIONS", 200).max(1);
    let reads = setting("MORPHZ_CONTEXTDB_RUNTIME_BENCH_READS", 200).max(1);
    println!(
        "ContextDB Runtime benchmark: frames={frame_count} initial_body_bytes={body_bytes} iterations={iterations} reads={reads}"
    );
    let state = initial_state(frame_count, body_bytes);
    println!(
        "initial Mind JSON bytes={}",
        serde_json::to_vec(&state)
            .expect("serialize benchmark Mind")
            .len()
    );

    let directory = tempfile::tempdir().expect("temporary benchmark directory");
    let legacy_path = directory.path().join("legacy.db");
    let context_db_path = directory.path().join("context-db.db");
    let legacy = SqliteStore::new_with_config(
        legacy_path.to_str().expect("legacy path"),
        &SqliteStorageConfig::default(),
    )
    .await
    .expect("open legacy Runtime store");
    let permit = require_enabled(&BTreeSet::from([CONTEXT_DB.to_string()]), CONTEXT_DB)
        .expect("ContextDB feature permit");
    let context_db = SqliteStore::new_with_context_db(
        context_db_path.to_str().expect("ContextDB path"),
        &SqliteStorageConfig::default(),
        permit,
    )
    .await
    .expect("open ContextDB Runtime store");

    prepare_store(&legacy, "legacy", &state).await;
    prepare_store(&context_db, "context-db", &state).await;
    run_workload(&legacy, "legacy", &state, body_bytes, iterations, reads).await;
    run_workload(
        &context_db,
        "context-db",
        &state,
        body_bytes,
        iterations,
        reads,
    )
    .await;
}
