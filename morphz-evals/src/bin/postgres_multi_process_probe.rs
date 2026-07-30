use morphz::config::AppConfig;
use morphz::event::Event;
use morphz::llm::{Client, Message, Response, ToolDefinition};
use morphz::memory::postgres::PostgresStore;
use morphz::memory::{
    ActivationStore, DeliveryIngressStore, EventStore, ExecutionJobMutation, ExecutionJobStatus,
    ExecutionJobStore, ExecutionRetrySafety, MessageClaim, NewAgent, NewCognitiveContext,
    NewExecutionJob, NewSession, NewThread, NewThreadActivation, QueryFilter, RuntimeStore,
    SessionDirectoryStore, SessionMountKind, ThreadKind, ThreadStore, ThreadSupervision,
    WorkerCoordinationMode,
};
use morphz::permission::{PermissionMode, ReviewerKind};
use morphz::runtime::{MorphzRuntime, RuntimeIdentity, RuntimeToolPolicy};
use serde::Serialize;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::process::{Child, Command};

type ProbeError = Box<dyn std::error::Error + Send + Sync>;

const BASE_URL_ENV: &str = "MORPHZ_TEST_POSTGRES_URL";
const SCOPED_URL_ENV: &str = "MORPHZ_MULTI_PROCESS_POSTGRES_URL";

#[derive(Debug, Serialize)]
struct ProbeReport {
    generated_at: chrono::DateTime<chrono::Utc>,
    workers: usize,
    ready_workers: usize,
    model_calls: usize,
    replies: usize,
    crash_recovery_requeued: bool,
    elapsed_millis: u64,
    schema: String,
    success: bool,
}

struct ProbeClient {
    store: Arc<PostgresStore>,
    worker_id: String,
    calls: AtomicUsize,
}

#[async_trait::async_trait]
impl Client for ProbeClient {
    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
    ) -> Result<Response, ProbeError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        self.store
            .append(Event::new(
                format!("probe-model-call-{}-{call}", self.worker_id),
                format!("Runtime-{}", self.worker_id),
                "probe_model_call".to_string(),
                "probe/model_call".to_string(),
                json!({"worker_id": self.worker_id, "call": call})
                    .as_object()
                    .unwrap()
                    .clone(),
            ))
            .await?;
        Ok(Response {
            content: "multi-process-runtime-ok".to_string(),
            tool_calls: Vec::new(),
        })
    }
}

fn scoped_url(database_url: &str, schema: &str) -> String {
    let separator = if database_url.contains('?') { '&' } else { '?' };
    format!("{database_url}{separator}options=-csearch_path%3D{schema}")
}

async fn wait_for_event_count(
    store: &PostgresStore,
    context_id: &str,
    topic: &str,
    expected: usize,
    timeout: Duration,
) -> Result<usize, ProbeError> {
    let deadline = Instant::now() + timeout;
    loop {
        let count = store
            .query(QueryFilter {
                context_id: Some(context_id.to_string()),
                topic: Some(topic.to_string()),
                ..Default::default()
            })
            .await?
            .len();
        if count >= expected {
            return Ok(count);
        }
        if Instant::now() >= deadline {
            return Err(format!("等待 {topic} 超时：expected={expected} actual={count}").into());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn worker(args: &[String]) -> Result<(), ProbeError> {
    if args.len() != 5 {
        return Err("worker 参数必须为 WORKER_ID AGENT_ID CONTEXT_ID SESSION_ID".into());
    }
    let worker_id = &args[1];
    let agent_id = &args[2];
    let context_id = &args[3];
    let session_id = &args[4];
    let database_url = std::env::var(SCOPED_URL_ENV)
        .map_err(|_| format!("worker 缺少命名凭证环境变量 {SCOPED_URL_ENV}"))?;
    let store = Arc::new(PostgresStore::new(&database_url, 4).await?);
    let client = Arc::new(ProbeClient {
        store: Arc::clone(&store),
        worker_id: worker_id.clone(),
        calls: AtomicUsize::new(0),
    });
    let mut config = AppConfig::default();
    config.permissions.mode = PermissionMode::Custom;
    config.permissions.reviewer = ReviewerKind::Deny;
    let runtime = MorphzRuntime::builder(config, client)
        .store(
            format!("postgres:probe:{worker_id}"),
            Arc::clone(&store) as Arc<dyn RuntimeStore>,
        )
        .identity(RuntimeIdentity {
            agent_id: agent_id.clone(),
            context_id: context_id.clone(),
            principal_id: "principal-postgres-probe".to_string(),
        })
        .tool_policy(RuntimeToolPolicy {
            context_only: true,
            coding_eval: true,
        })
        .build()
        .await?;
    runtime.start().await?;
    store
        .append(Event::new(
            format!("probe-worker-ready-{worker_id}"),
            format!("Runtime-{worker_id}"),
            "probe_worker_ready".to_string(),
            "probe/worker_ready".to_string(),
            json!({
                "worker_id": worker_id,
                "context_id": context_id,
                "session_id": session_id
            })
            .as_object()
            .unwrap()
            .clone(),
        ))
        .await?;

    wait_for_event_count(&store, context_id, "chat/reply", 1, Duration::from_secs(10)).await?;
    // Give the competing process enough time to expose a duplicate if its
    // fencing is incorrect before either process exits.
    tokio::time::sleep(Duration::from_millis(400)).await;
    Ok(())
}

async fn claim_job_and_hold(args: &[String]) -> Result<(), ProbeError> {
    if args.len() != 2 {
        return Err("claim worker 参数必须为 JOB_ID".into());
    }
    let job_id = &args[1];
    let database_url = std::env::var(SCOPED_URL_ENV)
        .map_err(|_| format!("claim worker 缺少命名凭证环境变量 {SCOPED_URL_ENV}"))?;
    let store = PostgresStore::new(&database_url, 2).await?;
    let job = store
        .get_execution_job(job_id)
        .await?
        .ok_or_else(|| format!("Execution Job '{job_id}' 不存在"))?;
    let claimed = match store
        .claim_execution_job(
            &job.id,
            job.revision,
            "crash-owner-process",
            "crash-owner-claim",
            chrono::Utc::now() + chrono::Duration::milliseconds(500),
            None,
        )
        .await?
    {
        ExecutionJobMutation::Updated(job) => job,
        mutation => return Err(format!("crash worker claim 失败：{mutation:?}").into()),
    };
    store
        .append(Event::new(
            format!("probe-job-claimed-{job_id}"),
            "Crash-Owner-Process".to_string(),
            "probe_job_claimed".to_string(),
            "probe/job_claimed".to_string(),
            json!({
                "context_id": claimed.context_id,
                "session_id": claimed.session_id,
                "job_id": claimed.id,
                "lease_expires_at": claimed.lease_expires_at
            })
            .as_object()
            .unwrap()
            .clone(),
        ))
        .await?;
    tokio::time::sleep(Duration::from_secs(30)).await;
    Ok(())
}

async fn recover_job(args: &[String]) -> Result<(), ProbeError> {
    if args.len() != 2 {
        return Err("recovery worker 参数必须为 JOB_ID".into());
    }
    let job_id = &args[1];
    let database_url = std::env::var(SCOPED_URL_ENV)
        .map_err(|_| format!("recovery worker 缺少命名凭证环境变量 {SCOPED_URL_ENV}"))?;
    let store = Arc::new(PostgresStore::new(&database_url, 2).await?);
    let manager = morphz::execution::ExecutionJobManager::new(Arc::clone(&store));
    let report = manager
        .reconcile_startup(WorkerCoordinationMode::SharedLeases, store.as_ref())
        .await?;
    let requeued = report.requeue_receipts.iter().any(|receipt| {
        receipt
            .applied_job()
            .is_some_and(|job| job.id == *job_id && job.status == ExecutionJobStatus::Queued)
    });
    if !requeued {
        return Err(format!("recovery worker 未重排到期 Job '{job_id}'").into());
    }
    Ok(())
}

async fn wait_for_child(child: &mut Child, name: &str) -> Result<(), ProbeError> {
    match tokio::time::timeout(Duration::from_secs(12), child.wait()).await {
        Ok(result) => {
            let status = result?;
            if status.success() {
                Ok(())
            } else {
                Err(format!("{name} 退出失败：{status}").into())
            }
        }
        Err(_) => {
            child.kill().await?;
            Err(format!("{name} 超过 12 秒未退出").into())
        }
    }
}

async fn parent() -> Result<(), ProbeError> {
    let started = Instant::now();
    let database_url = std::env::var(BASE_URL_ENV)
        .map_err(|_| format!("请显式设置 {BASE_URL_ENV} 后再运行多进程验证"))?;
    let administration_store = PostgresStore::new(&database_url, 4).await?;
    let suffix = chrono::Utc::now()
        .timestamp_nanos_opt()
        .ok_or("当前时间戳超出 i64")?;
    let schema = format!("morphz_process_probe_{suffix}");
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(administration_store.pool())
        .await?;
    let scoped_url = scoped_url(&database_url, &schema);
    let store = Arc::new(PostgresStore::new(&scoped_url, 8).await?);
    let agent_id = format!("process-probe-agent-{suffix}");
    let context_id = format!("process-probe-context-{suffix}");
    let session_id = format!("process-probe-session-{suffix}");
    store
        .create_agent_bundle(
            NewAgent {
                id: agent_id.clone(),
                title: "Process Probe Agent".to_string(),
                root_context_id: context_id.clone(),
            },
            NewCognitiveContext {
                id: context_id.clone(),
                agent_id: agent_id.clone(),
                title: "Process Probe Context".to_string(),
            },
            NewSession {
                id: session_id.clone(),
                agent_id: agent_id.clone(),
                context_id: context_id.clone(),
                parent_session_id: None,
                title: "Process Probe Session".to_string(),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await?;

    let executable = std::env::current_exe()?;
    let spawn_worker = |worker_id: &str| -> Result<Child, ProbeError> {
        Ok(Command::new(&executable)
            .arg("--worker")
            .arg(worker_id)
            .arg(&agent_id)
            .arg(&context_id)
            .arg(&session_id)
            .env(SCOPED_URL_ENV, &scoped_url)
            .kill_on_drop(true)
            .spawn()?)
    };
    let mut worker_a = spawn_worker("a")?;
    let mut worker_b = spawn_worker("b")?;

    let ready_workers = wait_for_event_count(
        &store,
        &context_id,
        "probe/worker_ready",
        2,
        Duration::from_secs(10),
    )
    .await?;
    let message = Event::new(
        format!("probe-user-message-{suffix}"),
        "Process-Probe".to_string(),
        "user_message".to_string(),
        "chat/user_message".to_string(),
        json!({
            "context_id": context_id,
            "session_id": session_id,
            "client_message_id": format!("probe-client-message-{suffix}"),
            "text": "one message for two Runtime processes"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    assert_eq!(
        store
            .claim_message(
                &session_id,
                &format!("probe-client-message-{suffix}"),
                &message,
            )
            .await?,
        MessageClaim::Accepted
    );

    wait_for_child(&mut worker_a, "worker-a").await?;
    wait_for_child(&mut worker_b, "worker-b").await?;
    let model_calls = store
        .query(QueryFilter {
            topic: Some("probe/model_call".to_string()),
            ..Default::default()
        })
        .await?
        .len();
    let replies = store
        .query(QueryFilter {
            context_id: Some(context_id.clone()),
            session_id: Some(session_id.clone()),
            topic: Some("chat/reply".to_string()),
            ..Default::default()
        })
        .await?
        .len();

    let thread = store
        .ensure_thread(NewThread {
            id: format!("process-probe-crash-thread-{suffix}"),
            agent_id: agent_id.clone(),
            context_id: context_id.clone(),
            session_id: session_id.clone(),
            initiating_principal_id: None,
            root_turn_id: format!("process-probe-crash-root-{suffix}"),
            kind: ThreadKind::Execution,
            executor_kind: "runtime".to_string(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::runtime("postgres-multi-process-probe"),
        })
        .await?;
    let activation = store
        .ensure_thread_activation(NewThreadActivation {
            id: format!("process-probe-crash-activation-{suffix}"),
            agent_id: agent_id.clone(),
            context_id: context_id.clone(),
            session_id: session_id.clone(),
            initiating_principal_id: None,
            trigger_event_id: format!("process-probe-crash-trigger-{suffix}"),
            trigger_sequence: 2,
            trigger_kind: "probe".to_string(),
            parent_activation_id: None,
            root_turn_id: thread.root_turn_id.clone(),
        })
        .await?;
    let crash_job = store
        .create_execution_job(NewExecutionJob {
            id: format!("process-probe-crash-job-{suffix}"),
            activation_id: activation.id,
            thread_id: thread.id,
            agent_id,
            context_id: context_id.clone(),
            session_id: session_id.clone(),
            initiating_principal_id: None,
            target_id: morphz::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
            tool_call_id: format!("process-probe-crash-call-{suffix}"),
            tool_name: "read".to_string(),
            request: json!({"path": "README.md"}),
            retry_safety: ExecutionRetrySafety::Idempotent,
            requires_approval: false,
        })
        .await?;
    let mut crash_owner = Command::new(&executable)
        .arg("--claim-job")
        .arg(&crash_job.id)
        .env(SCOPED_URL_ENV, &scoped_url)
        .kill_on_drop(true)
        .spawn()?;
    wait_for_event_count(
        &store,
        &context_id,
        "probe/job_claimed",
        1,
        Duration::from_secs(10),
    )
    .await?;
    crash_owner.kill().await?;
    let _ = crash_owner.wait().await?;
    tokio::time::sleep(Duration::from_millis(650)).await;
    let mut recovery_worker = Command::new(&executable)
        .arg("--recover-job")
        .arg(&crash_job.id)
        .env(SCOPED_URL_ENV, &scoped_url)
        .kill_on_drop(true)
        .spawn()?;
    wait_for_child(&mut recovery_worker, "recovery-worker").await?;
    let crash_recovery_requeued = store
        .get_execution_job(&crash_job.id)
        .await?
        .is_some_and(|job| job.status == ExecutionJobStatus::Queued);

    let success = ready_workers == 2 && model_calls == 1 && replies == 1 && crash_recovery_requeued;
    let report = ProbeReport {
        generated_at: chrono::Utc::now(),
        workers: 2,
        ready_workers,
        model_calls,
        replies,
        crash_recovery_requeued,
        elapsed_millis: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        schema,
        success,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    if success {
        Ok(())
    } else {
        Err("多进程 single-flight 验证失败".into())
    }
}

#[tokio::main]
async fn main() -> Result<(), ProbeError> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.first().map(String::as_str) {
        Some("--worker") => worker(&args).await,
        Some("--claim-job") => claim_job_and_hold(&args).await,
        Some("--recover-job") => recover_job(&args).await,
        None => parent().await,
        _ => Err("usage: postgres_multi_process_probe".into()),
    }
}
