use async_trait::async_trait;
use morphz::config::AppConfig;
use morphz::event::Event;
use morphz::llm::{Client, Message, Response, ToolDefinition};
use morphz::memory::postgres::PostgresStore;
use morphz::memory::{
    MessageDispatchMode, NewAgent, NewCognitiveContext, NewPrincipal, NewSession, RuntimeStore,
    SessionDirectoryStore, SessionMountKind,
};
use morphz::permission::{PermissionMode, ReviewerKind};
use morphz::runtime::{
    MorphzRuntime, RuntimeIdentity, RuntimeToolPolicy, SessionHandle, SessionMessageOptions,
};
use serde::Serialize;
use sqlx::postgres::PgPoolOptions;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{oneshot, Semaphore};
use tokio::task::JoinSet;

type BenchError = Box<dyn std::error::Error + Send + Sync>;

const DATABASE_URL_ENV: &str = "MORPHZ_BENCH_POSTGRES_URL";

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum Topology {
    /// Many external users communicate with one Agent through independent
    /// Sessions which share one cognitive Context.
    SharedContext,
    /// Every external user receives an independent Context while one Runtime
    /// process and one PostgreSQL pool serve all of them.
    IsolatedContexts,
}

impl Topology {
    fn from_env() -> Result<Self, BenchError> {
        match std::env::var("MORPHZ_BENCH_TOPOLOGY")
            .unwrap_or_else(|_| "shared_context".to_string())
            .as_str()
        {
            "shared_context" | "shared-context" => Ok(Self::SharedContext),
            "isolated_contexts" | "isolated-contexts" => Ok(Self::IsolatedContexts),
            value => Err(format!(
                "unsupported MORPHZ_BENCH_TOPOLOGY '{value}'; expected shared_context or isolated_contexts"
            )
            .into()),
        }
    }
}

#[derive(Debug, Serialize)]
struct LatencySummary {
    samples: usize,
    min_ms: f64,
    p50_ms: f64,
    p95_ms: f64,
    p99_ms: f64,
    max_ms: f64,
    mean_ms: f64,
}

impl LatencySummary {
    fn from_durations(samples: &[Duration]) -> Self {
        let mut micros = samples.iter().map(Duration::as_micros).collect::<Vec<_>>();
        micros.sort_unstable();
        let total = micros.iter().copied().sum::<u128>();
        let as_ms = |value: u128| value as f64 / 1_000.0;
        Self {
            samples: micros.len(),
            min_ms: as_ms(*micros.first().unwrap_or(&0)),
            p50_ms: as_ms(nearest_rank(&micros, 50)),
            p95_ms: as_ms(nearest_rank(&micros, 95)),
            p99_ms: as_ms(nearest_rank(&micros, 99)),
            max_ms: as_ms(*micros.last().unwrap_or(&0)),
            mean_ms: if micros.is_empty() {
                0.0
            } else {
                as_ms(total) / micros.len() as f64
            },
        }
    }
}

fn nearest_rank(sorted: &[u128], percentile: usize) -> u128 {
    if sorted.is_empty() {
        return 0;
    }
    let rank = (sorted.len() * percentile).div_ceil(100);
    sorted[rank.saturating_sub(1).min(sorted.len() - 1)]
}

#[derive(Debug, Serialize)]
struct BenchmarkConfig {
    topology: Topology,
    concurrency: usize,
    messages: usize,
    postgres_pool_size: u32,
    timeout_secs: u64,
    database_probe_samples: usize,
    model_delay_ms: u64,
}

#[derive(Debug, Serialize)]
struct BenchmarkReport {
    generated_at: chrono::DateTime<chrono::Utc>,
    postgres_server_version: String,
    schema: String,
    schema_cleaned: bool,
    config: BenchmarkConfig,
    database_select_one: LatencySummary,
    ingress: LatencySummary,
    end_to_end: LatencySummary,
    elapsed_ms: f64,
    throughput_messages_per_second: f64,
    accepted_messages: usize,
    replies: usize,
    model_calls: usize,
    peak_model_concurrency: usize,
    postgres_pool_connections: u32,
    postgres_pool_idle_connections: usize,
    success: bool,
}

struct ZeroWorkClient {
    delay: Duration,
    calls: AtomicUsize,
    active: AtomicUsize,
    peak_active: AtomicUsize,
}

#[async_trait]
impl Client for ZeroWorkClient {
    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
    ) -> Result<Response, BenchError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak_active.fetch_max(active, Ordering::SeqCst);
        if !self.delay.is_zero() {
            tokio::time::sleep(self.delay).await;
        }
        self.active.fetch_sub(1, Ordering::SeqCst);
        Ok(Response {
            content: "benchmark-ok".to_string(),
            tool_calls: Vec::new(),
        })
    }
}

fn env_usize(name: &str, default: usize) -> Result<usize, BenchError> {
    let value = std::env::var(name)
        .ok()
        .map(|value| value.parse::<usize>())
        .transpose()?
        .unwrap_or(default);
    if value == 0 {
        return Err(format!("{name} must be greater than zero").into());
    }
    Ok(value)
}

fn env_u64(name: &str, default: u64) -> Result<u64, BenchError> {
    Ok(std::env::var(name)
        .ok()
        .map(|value| value.parse::<u64>())
        .transpose()?
        .unwrap_or(default))
}

fn scoped_url(database_url: &str, schema: &str) -> String {
    let separator = if database_url.contains('?') { '&' } else { '?' };
    format!("{database_url}{separator}options=-csearch_path%3D{schema}")
}

fn causal_string<'a>(event: &'a Event, key: &str) -> Option<&'a str> {
    event
        .payload
        .get(key)
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            event
                .payload
                .get("causal_route")
                .and_then(serde_json::Value::as_object)
                .and_then(|route| route.get(key))
                .and_then(serde_json::Value::as_str)
        })
        .or_else(|| {
            event
                .payload
                .get("route")
                .and_then(serde_json::Value::as_object)
                .and_then(|route| route.get(key))
                .and_then(serde_json::Value::as_str)
        })
}

async fn database_probe(
    pool: sqlx::PgPool,
    samples: usize,
    concurrency: usize,
) -> Result<Vec<Duration>, BenchError> {
    for _ in 0..concurrency.min(8) {
        let _: i32 = sqlx::query_scalar("SELECT 1").fetch_one(&pool).await?;
    }
    let permits = Arc::new(Semaphore::new(concurrency));
    let mut tasks = JoinSet::new();
    for _ in 0..samples {
        let pool = pool.clone();
        let permits = Arc::clone(&permits);
        tasks.spawn(async move {
            let _permit = permits.acquire_owned().await?;
            let started = Instant::now();
            let value: i32 = sqlx::query_scalar("SELECT 1").fetch_one(&pool).await?;
            if value != 1 {
                return Err::<Duration, BenchError>("SELECT 1 returned an unexpected value".into());
            }
            Ok(started.elapsed())
        });
    }
    let mut durations = Vec::with_capacity(samples);
    while let Some(result) = tasks.join_next().await {
        durations.push(result??);
    }
    Ok(durations)
}

async fn build_sessions(
    runtime: &MorphzRuntime,
    topology: Topology,
    messages: usize,
    suffix: &str,
) -> Result<Vec<SessionHandle>, BenchError> {
    let mut sessions = Vec::with_capacity(messages);
    for index in 0..messages {
        let context_id = match topology {
            Topology::SharedContext => runtime.identity().context_id.clone(),
            Topology::IsolatedContexts => {
                let id = format!("load-context-{suffix}-{index}");
                runtime
                    .ensure_context(NewCognitiveContext {
                        id: id.clone(),
                        agent_id: runtime.identity().agent_id.clone(),
                        title: format!("Load Context {index}"),
                    })
                    .await?;
                id
            }
        };
        sessions.push(
            runtime
                .ensure_session(NewSession {
                    id: format!("load-session-{suffix}-{index}"),
                    agent_id: runtime.identity().agent_id.clone(),
                    context_id,
                    parent_session_id: None,
                    title: format!("Load Session {index}"),
                    mount_kind: SessionMountKind::ExistingContext,
                })
                .await?,
        );
    }
    Ok(sessions)
}

async fn run_message_load(
    runtime: MorphzRuntime,
    sessions: Vec<SessionHandle>,
    concurrency: usize,
    timeout: Duration,
    suffix: &str,
) -> Result<(Vec<Duration>, Vec<Duration>, Duration), BenchError> {
    let pending = Arc::new(Mutex::new(
        HashMap::<String, oneshot::Sender<Instant>>::new(),
    ));
    let mut replies = runtime.subscribe("*", sessions.len().saturating_mul(4).max(64));
    let pending_replies = Arc::clone(&pending);
    let expected_replies = sessions.len();
    let collector = tokio::spawn(async move {
        let deadline = tokio::time::Instant::now() + timeout;
        let mut received = 0usize;
        while received < expected_replies {
            let event = tokio::time::timeout_at(deadline, replies.recv())
                .await
                .map_err(|_| "timed out waiting for benchmark replies")?
                .ok_or("Runtime Event stream closed during benchmark")?;
            if event.topic != "chat/reply" {
                continue;
            }
            let Some(session_id) = causal_string(&event, "session_id") else {
                continue;
            };
            let sender = pending_replies
                .lock()
                .map_err(|_| "benchmark pending-reply mutex poisoned")?
                .remove(session_id);
            if let Some(sender) = sender {
                let _ = sender.send(Instant::now());
                received += 1;
            }
        }
        Ok::<usize, BenchError>(received)
    });

    let permits = Arc::new(Semaphore::new(concurrency));
    let wall_started = Instant::now();
    let mut tasks = JoinSet::new();
    for (index, session) in sessions.into_iter().enumerate() {
        let permits = Arc::clone(&permits);
        let pending = Arc::clone(&pending);
        let client_message_id = format!("load-client-{suffix}-{index}");
        tasks.spawn(async move {
            let _permit = permits.acquire_owned().await?;
            let (completed_tx, completed_rx) = oneshot::channel();
            pending
                .lock()
                .map_err(|_| "benchmark pending-reply mutex poisoned")?
                .insert(session.id().to_string(), completed_tx);
            let started = Instant::now();
            let receipt = session
                .send_as_principal_with_options(
                    format!("benchmark message {index}"),
                    "Runtime-Load-Benchmark",
                    "principal-runtime-load-benchmark",
                    Some(client_message_id),
                    SessionMessageOptions {
                        dispatch_mode: Some(MessageDispatchMode::Parallel),
                        ..SessionMessageOptions::default()
                    },
                )
                .await?;
            if receipt.duplicate {
                return Err::<(Duration, Duration), BenchError>(
                    "benchmark request unexpectedly resolved as a duplicate".into(),
                );
            }
            let ingress = started.elapsed();
            let completed_at = tokio::time::timeout(timeout, completed_rx)
                .await
                .map_err(|_| "timed out waiting for the benchmark reply notification")??;
            Ok((ingress, completed_at.duration_since(started)))
        });
    }

    let mut ingress = Vec::new();
    let mut end_to_end = Vec::new();
    while let Some(result) = tasks.join_next().await {
        let (ingress_sample, end_to_end_sample) = result??;
        ingress.push(ingress_sample);
        end_to_end.push(end_to_end_sample);
    }
    let received = collector.await??;
    if received != expected_replies {
        return Err(format!("expected {expected_replies} replies but observed {received}").into());
    }
    Ok((ingress, end_to_end, wall_started.elapsed()))
}

fn print_help() {
    println!(
        "Runtime + PostgreSQL load benchmark\n\n\
Required:\n  {DATABASE_URL_ENV}=postgresql://...\n\n\
Optional:\n  MORPHZ_BENCH_TOPOLOGY=shared_context|isolated_contexts\n  \
MORPHZ_BENCH_CONCURRENCY=16\n  MORPHZ_BENCH_MESSAGES=64\n  \
MORPHZ_BENCH_POSTGRES_POOL_SIZE=16\n  MORPHZ_BENCH_TIMEOUT_SECS=30\n  \
MORPHZ_BENCH_DATABASE_SAMPLES=64\n  MORPHZ_BENCH_MODEL_DELAY_MS=0\n  \
MORPHZ_BENCH_KEEP_SCHEMA=1"
    );
}

#[tokio::main]
async fn main() -> Result<(), BenchError> {
    if std::env::args().any(|argument| argument == "--help" || argument == "-h") {
        print_help();
        return Ok(());
    }
    let database_url = std::env::var(DATABASE_URL_ENV)
        .map_err(|_| format!("set {DATABASE_URL_ENV} to an explicitly selected test database"))?;
    let topology = Topology::from_env()?;
    let concurrency = env_usize("MORPHZ_BENCH_CONCURRENCY", 16)?;
    let messages = env_usize("MORPHZ_BENCH_MESSAGES", concurrency.saturating_mul(4))?;
    let pool_size = u32::try_from(env_usize(
        "MORPHZ_BENCH_POSTGRES_POOL_SIZE",
        concurrency.clamp(4, 64),
    )?)?;
    let timeout_secs = env_u64("MORPHZ_BENCH_TIMEOUT_SECS", 30)?;
    let database_samples = env_usize("MORPHZ_BENCH_DATABASE_SAMPLES", messages.max(32))?;
    let model_delay_ms = env_u64("MORPHZ_BENCH_MODEL_DELAY_MS", 0)?;
    let keep_schema = std::env::var("MORPHZ_BENCH_KEEP_SCHEMA").as_deref() == Ok("1");
    let config_snapshot = BenchmarkConfig {
        topology,
        concurrency,
        messages,
        postgres_pool_size: pool_size,
        timeout_secs,
        database_probe_samples: database_samples,
        model_delay_ms,
    };

    let suffix = format!(
        "{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_micros()
    );
    let schema = format!("morphz_runtime_load_{}", suffix.replace('-', "_"));
    let administration_pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&database_url)
        .await?;
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&administration_pool)
        .await?;
    let scoped_database_url = scoped_url(&database_url, &schema);
    let store = Arc::new(PostgresStore::new(&scoped_database_url, pool_size).await?);
    let server_version: String = sqlx::query_scalar("SHOW server_version")
        .fetch_one(store.pool())
        .await?;
    let database_durations = database_probe(
        store.pool().clone(),
        database_samples,
        concurrency.min(pool_size as usize),
    )
    .await?;

    let agent_id = format!("load-agent-{suffix}");
    let context_id = format!("load-context-{suffix}");
    let bootstrap_session_id = format!("load-bootstrap-session-{suffix}");
    store
        .create_agent_bundle(
            NewAgent {
                id: agent_id.clone(),
                title: "Runtime Load Benchmark Agent".to_string(),
                root_context_id: context_id.clone(),
            },
            NewCognitiveContext {
                id: context_id.clone(),
                agent_id: agent_id.clone(),
                title: "Runtime Load Benchmark Context".to_string(),
            },
            NewSession {
                id: bootstrap_session_id,
                agent_id: agent_id.clone(),
                context_id: context_id.clone(),
                parent_session_id: None,
                title: "Runtime Load Benchmark Bootstrap".to_string(),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await?;
    let principal_id = "principal-runtime-load-benchmark";
    store
        .ensure_principal(NewPrincipal {
            id: principal_id.to_string(),
            provider_id: "runtime-default".to_string(),
            assurance: "runtime-default".to_string(),
            display_name: Some("Runtime load benchmark".to_string()),
        })
        .await?;

    let model = Arc::new(ZeroWorkClient {
        delay: Duration::from_millis(model_delay_ms),
        calls: AtomicUsize::new(0),
        active: AtomicUsize::new(0),
        peak_active: AtomicUsize::new(0),
    });
    let mut app_config = AppConfig::default();
    app_config.permissions.mode = PermissionMode::Custom;
    app_config.permissions.reviewer = ReviewerKind::Deny;
    app_config.orchestrator.event_bus.max_in_flight = concurrency.max(10);
    app_config.orchestrator.activation_admission.max_in_flight = concurrency.max(16);
    app_config.orchestrator.activation_admission.max_queued = messages.max(256);
    app_config.orchestrator.model_provider_max_in_flight = concurrency.max(4);
    let artifacts = tempfile::tempdir()?;
    app_config.background_task.artifact_dir = artifacts.path().to_string_lossy().into_owned();
    let runtime = MorphzRuntime::builder(app_config, model.clone())
        .store(
            format!("postgres:runtime-load:{suffix}"),
            store.clone() as Arc<dyn RuntimeStore>,
        )
        .identity(RuntimeIdentity {
            agent_id,
            context_id,
            principal_id: principal_id.to_string(),
        })
        .tool_policy(RuntimeToolPolicy {
            context_only: true,
            coding_eval: true,
        })
        .build()
        .await?;
    runtime.start().await?;
    let sessions = build_sessions(&runtime, topology, messages, &suffix).await?;
    let (ingress, end_to_end, elapsed) = run_message_load(
        runtime.clone(),
        sessions,
        concurrency,
        Duration::from_secs(timeout_secs),
        &suffix,
    )
    .await?;
    let calls = model.calls.load(Ordering::SeqCst);
    let replies = end_to_end.len();
    let success = ingress.len() == messages && replies == messages && calls == messages;
    let pool_connections = store.pool().size();
    let pool_idle = store.pool().num_idle();

    let mut report = BenchmarkReport {
        generated_at: chrono::Utc::now(),
        postgres_server_version: server_version,
        schema: schema.clone(),
        schema_cleaned: false,
        config: config_snapshot,
        database_select_one: LatencySummary::from_durations(&database_durations),
        ingress: LatencySummary::from_durations(&ingress),
        end_to_end: LatencySummary::from_durations(&end_to_end),
        elapsed_ms: elapsed.as_secs_f64() * 1_000.0,
        throughput_messages_per_second: messages as f64 / elapsed.as_secs_f64(),
        accepted_messages: ingress.len(),
        replies,
        model_calls: calls,
        peak_model_concurrency: model.peak_active.load(Ordering::SeqCst),
        postgres_pool_connections: pool_connections,
        postgres_pool_idle_connections: pool_idle,
        success,
    };

    if !keep_schema {
        sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
            .execute(&administration_pool)
            .await?;
        report.schema_cleaned = true;
    }
    println!("{}", serde_json::to_string_pretty(&report)?);
    if report.success {
        Ok(())
    } else {
        Err("runtime load benchmark did not complete every logical turn exactly once".into())
    }
}
