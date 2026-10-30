//! A detached process is not proof that its exited Runtime still owns delivery.
//! Never executes the persisted command. The Runtime-loop case owns a separate
//! synthetic monitor process and terminates only that fixture monitor.
use chrono::{Duration, Utc};
use morphz::event::InMemoryEventBus;
use morphz::execution::{
    deterministic_job_id, startup_recovery_plan, ExecutionJobManager, ExecutionJobSpec, JobClaim,
    JobHeartbeat, JobReceipt, RestartAction,
};
use morphz::memory::{sqlite::SqliteStore, *};
use morphz::response_annotations::Protocol;
use morphz::timer::TimerEngine;
use morphz::tool::BackgroundTaskScheduler;
use serde_json::json;
use std::sync::Arc;

struct Fixture {
    manager: Arc<ExecutionJobManager<dyn ExecutionJobStore>>,
    store: Arc<SqliteStore>,
    _directory: tempfile::TempDir,
}

fn applied(receipt: JobReceipt) -> ExecutionJobRecord {
    receipt
        .applied_job()
        .expect("fenced mutation applied")
        .clone()
}

impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(
            SqliteStore::new(directory.path().join("fixture.sqlite").to_str().unwrap())
                .await
                .unwrap(),
        );
        store
            .ensure_agent(NewAgent {
                id: "background-agent".into(),
                title: "Background recovery".into(),
                root_context_id: "background-context".into(),
            })
            .await
            .unwrap();
        store
            .ensure_context(NewCognitiveContext {
                id: "background-context".into(),
                agent_id: "background-agent".into(),
                title: "Background recovery".into(),
            })
            .await
            .unwrap();
        store
            .ensure_session(NewSession {
                id: "background-session".into(),
                agent_id: "background-agent".into(),
                context_id: "background-context".into(),
                parent_session_id: None,
                title: "Background recovery".into(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        store
            .ensure_thread(NewThread {
                id: "background-thread".into(),
                agent_id: "background-agent".into(),
                context_id: "background-context".into(),
                session_id: "background-session".into(),
                initiating_principal_id: None,
                root_turn_id: "background-root".into(),
                kind: ThreadKind::Execution,
                executor_kind: "self".into(),
                executor_id: None,
                target_id: None,
                supervision: ThreadSupervision::legacy(),
                model_alias: None,
                reasoning_effort: None,
                response_annotations: Protocol::Off,
            })
            .await
            .unwrap();
        store
            .ensure_thread_activation(NewThreadActivation {
                id: "background-activation".into(),
                agent_id: "background-agent".into(),
                context_id: "background-context".into(),
                session_id: "background-session".into(),
                initiating_principal_id: None,
                trigger_event_id: "background-trigger".into(),
                trigger_sequence: 7,
                trigger_kind: "chat/user_message".into(),
                parent_activation_id: None,
                root_turn_id: "background-root".into(),
            })
            .await
            .unwrap();
        let manager = Arc::new(ExecutionJobManager::new(
            Arc::clone(&store) as Arc<dyn ExecutionJobStore>
        ));
        Self {
            _directory: directory,
            store,
            manager,
        }
    }

    async fn background_job(
        &self,
        call: &str,
        owner: &str,
        future_lease: bool,
        edge_owner: bool,
    ) -> ExecutionJobRecord {
        let now = Utc::now();
        // Always use the real claim API with a valid future deadline. The
        // reconciler's explicit observation time advances past the short lease.
        let lease = now + Duration::seconds(if future_lease { 180 } else { 90 });
        let mut request = json!({
            "kind": "background_exec",
            "task_id": deterministic_job_id("background-activation", call).unwrap(),
            "command": "synthetic-not-executed",
            "keep_running": true,
        });
        if edge_owner {
            request["owner_kind"] = json!("edge_worker");
        }
        let job = self
            .manager
            .ensure(ExecutionJobSpec {
                activation_id: "background-activation".into(),
                thread_id: "background-thread".into(),
                agent_id: "background-agent".into(),
                context_id: "background-context".into(),
                session_id: "background-session".into(),
                initiating_principal_id: None,
                target_id: morphz::execution_target::DEFAULT_EXECUTION_TARGET_ID.into(),
                tool_call_id: call.into(),
                tool_name: "exec/background".into(),
                request,
                retry_safety: ExecutionRetrySafety::ReconcileRequired,
                requires_approval: false,
            })
            .await
            .unwrap();
        let claimed = applied(
            self.manager
                .claim(
                    &job.id,
                    job.revision,
                    JobClaim {
                        worker_id: owner,
                        claim_token: call,
                        lease_expires_at: lease,
                        approval_ref: None,
                    },
                )
                .await
                .unwrap(),
        );
        applied(
            self.manager
                .heartbeat(
                    &claimed.id,
                    claimed.revision,
                    JobHeartbeat {
                        claim_token: call,
                        lease_expires_at: lease,
                        side_effect_started_at: Some(now - Duration::seconds(30)),
                        progress_ref: None,
                    },
                )
                .await
                .unwrap(),
        )
    }
}

#[tokio::test]
async fn same_host_dead_background_owner_cannot_preserve_a_future_lease() {
    let fixture = Fixture::new().await;
    let owner = format!("background-runtime:{}:old-instance:0", i32::MAX);
    let job = fixture.background_job("future", &owner, true, false).await;
    assert!(matches!(
        startup_recovery_plan(&job, WorkerCoordinationMode::SharedHostLeases, Utc::now()).action,
        RestartAction::MarkLost { .. }
    ));
    assert_eq!(
        startup_recovery_plan(&job, WorkerCoordinationMode::SharedLeases, Utc::now()).action,
        RestartAction::Preserve,
        "a numeric PID is not cross-host liveness evidence"
    );
}

#[tokio::test]
async fn expired_background_owner_gets_one_uncertain_result_and_one_signal() {
    let fixture = Fixture::new().await;
    let owner = format!("background-runtime:{}:old-instance:0", i32::MAX);
    let job = fixture
        .background_job("expired", &owner, false, false)
        .await;
    let report = fixture
        .manager
        .reconcile_abandoned_runtime_jobs(
            WorkerCoordinationMode::SharedHostLeases,
            fixture.store.as_ref(),
            None,
            Utc::now() + Duration::seconds(120),
        )
        .await
        .unwrap();
    assert_eq!(report.lost_receipts.len(), 1);
    assert!(
        report.requeue_receipts.is_empty(),
        "never replay the command"
    );
    let lost = fixture
        .store
        .get_execution_job(&job.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(lost.status, ExecutionJobStatus::Lost);
    assert!(lost.error.as_deref().unwrap().contains("unknown"));
    let event_id = lost.result_event_id.as_deref().unwrap();
    assert_eq!(
        fixture
            .store
            .query(QueryFilter {
                event_id: Some(event_id.into()),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1
    );
    let scheduler = BackgroundTaskScheduler::new_with_execution_jobs(
        Arc::new(InMemoryEventBus::new()),
        Arc::clone(&fixture.store) as Arc<dyn EventStore>,
        Arc::new(TimerEngine::new(
            Arc::clone(&fixture.store) as Arc<dyn TimerStore>
        )),
        Arc::clone(&fixture.manager),
    )
    .with_session_store(Arc::clone(&fixture.store) as Arc<dyn SessionStore>);
    assert_eq!(
        scheduler
            .recover_terminal_background_outboxes()
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        scheduler
            .recover_terminal_background_outboxes()
            .await
            .unwrap(),
        0
    );
    let signals = fixture
        .store
        .list_context_thread_signals("background-context", None)
        .await
        .unwrap();
    assert_eq!(
        signals
            .iter()
            .filter(|signal| signal.event_id == event_id)
            .count(),
        1
    );
    let replay = fixture
        .manager
        .reconcile_abandoned_runtime_jobs(
            WorkerCoordinationMode::SharedHostLeases,
            fixture.store.as_ref(),
            None,
            Utc::now() + Duration::seconds(120),
        )
        .await
        .unwrap();
    assert!(replay.lost_receipts.is_empty());
}

#[tokio::test]
async fn background_recovery_preserves_live_unknown_remote_and_edge_authority() {
    let fixture = Fixture::new().await;
    let live = format!("background-runtime:{}:live-instance:0", std::process::id());
    let dead = format!("background-runtime:{}:old-instance:0", i32::MAX);
    let jobs = [
        fixture.background_job("live", &live, true, false).await,
        fixture
            .background_job("unknown", "background-runtime:unknown:0", true, false)
            .await,
        fixture.background_job("remote", &dead, true, false).await,
        fixture.background_job("edge", &dead, false, true).await,
    ];
    let report = fixture
        .manager
        .reconcile_abandoned_runtime_jobs(
            WorkerCoordinationMode::SharedLeases,
            fixture.store.as_ref(),
            None,
            Utc::now() + Duration::seconds(120),
        )
        .await
        .unwrap();
    assert!(report.lost_receipts.is_empty());
    assert!(report.requeue_receipts.is_empty());
    for job in jobs {
        let current = fixture
            .store
            .get_execution_job(&job.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(current.status, ExecutionJobStatus::Running);
        assert_eq!(current.revision, job.revision);
        assert_eq!(current.claim_token, job.claim_token);
    }
}

#[tokio::test]
async fn same_host_background_recovery_keeps_live_unknown_and_edge_fences() {
    let fixture = Fixture::new().await;
    let live = format!("background-runtime:{}:live-instance:0", std::process::id());
    let dead = format!("background-runtime:{}:old-instance:0", i32::MAX);
    let jobs = [
        fixture
            .background_job("host-live", &live, true, false)
            .await,
        fixture
            .background_job("host-unknown", "background-runtime:unknown:0", true, false)
            .await,
        fixture
            .background_job("host-edge", &dead, false, true)
            .await,
    ];
    let report = fixture
        .manager
        .reconcile_abandoned_runtime_jobs(
            WorkerCoordinationMode::SharedHostLeases,
            fixture.store.as_ref(),
            None,
            Utc::now() + Duration::seconds(120),
        )
        .await
        .unwrap();
    assert!(report.lost_receipts.is_empty());
    assert!(report.requeue_receipts.is_empty());
    for job in jobs {
        let current = fixture
            .store
            .get_execution_job(&job.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(current.status, ExecutionJobStatus::Running);
        assert_eq!(current.revision, job.revision);
        assert_eq!(current.claim_token, job.claim_token);
    }
}

#[tokio::test]
async fn distributed_background_recovery_uses_expiry_not_a_local_pid() {
    let fixture = Fixture::new().await;
    let owner = format!(
        "background-runtime:{}:remote-instance:0",
        std::process::id()
    );
    let job = fixture
        .background_job("remote-expired", &owner, false, false)
        .await;
    let report = fixture
        .manager
        .reconcile_abandoned_runtime_jobs(
            WorkerCoordinationMode::SharedLeases,
            fixture.store.as_ref(),
            None,
            Utc::now() + Duration::seconds(120),
        )
        .await
        .unwrap();
    assert_eq!(report.lost_receipts.len(), 1);
    assert!(report.requeue_receipts.is_empty());
    assert_eq!(
        fixture
            .store
            .get_execution_job(&job.id)
            .await
            .unwrap()
            .unwrap()
            .status,
        ExecutionJobStatus::Lost
    );
}

struct SyntheticClient;

#[async_trait::async_trait]
impl morphz::llm::Client for SyntheticClient {
    fn model(&self) -> Option<String> {
        Some("background-owner-fixture".into())
    }

    async fn create_completion(
        &self,
        _: Vec<morphz::llm::Message>,
        _: Vec<morphz::llm::ToolDefinition>,
    ) -> Result<morphz::llm::Response, Box<dyn std::error::Error + Send + Sync>> {
        Ok(morphz::llm::Response {
            content: "Synthetic monitor uncertainty observed; no command was replayed.".into(),
            tool_calls: vec![],
        })
    }
}

struct Monitor(std::process::Child);

impl Monitor {
    fn start() -> Self {
        #[cfg(unix)]
        let mut command = {
            let mut command = std::process::Command::new("/bin/sh");
            command.args(["-c", "exec sleep 30"]);
            command
        };
        #[cfg(windows)]
        let mut command = {
            let mut command = std::process::Command::new("powershell.exe");
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ]);
            command
        };
        let child = command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        Self(child)
    }
}

impl Drop for Monitor {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[tokio::test]
async fn actual_runtime_delivers_an_online_background_monitor_loss_once() {
    use morphz::config::{AppConfig, HumanDuration};
    use morphz::runtime::{MorphzRuntime, RuntimeIdentity, RuntimeToolPolicy};
    use morphz::secret_store::{HostEnvFileSecretBackend, SecretStore};

    let fixture = Fixture::new().await;
    let mut monitor = Monitor::start();
    assert!(monitor.0.try_wait().unwrap().is_none());
    let owner = format!("background-runtime:{}:fixture-monitor:0", monitor.0.id());
    let job = fixture
        .background_job("online-monitor", &owner, true, false)
        .await;
    let activation = fixture
        .store
        .get_thread_activation("background-activation")
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        fixture
            .store
            .update_thread_activation(
                &activation.id,
                activation.revision,
                ThreadActivationStatus::Succeeded,
                None,
                None,
                None
            )
            .await
            .unwrap(),
        ThreadActivationMutation::Updated(_)
    ));

    let mut config = AppConfig::default();
    config.llm.model = "background-owner-fixture".into();
    config.permissions.workspace_root = fixture._directory.path().to_string_lossy().into();
    config.background_task.artifact_dir = fixture
        ._directory
        .path()
        .join("artifacts")
        .to_string_lossy()
        .into();
    config.edge_execution.reconcile_interval = HumanDuration::from_secs(1);
    let runtime = MorphzRuntime::builder(config, Arc::new(SyntheticClient))
        .store("isolated-background-owner-fixture", fixture.store.clone())
        .identity(RuntimeIdentity {
            agent_id: "background-agent".into(),
            context_id: "background-context".into(),
            principal_id: "background-principal".into(),
        })
        .secret_store(Arc::new(
            SecretStore::new(
                fixture._directory.path().join("secrets.json"),
                Arc::new(HostEnvFileSecretBackend::new(
                    fixture._directory.path().join("test.env"),
                )),
            )
            .unwrap(),
        ))
        .tool_policy(RuntimeToolPolicy {
            context_only: true,
            coding_eval: false,
        })
        .build()
        .await
        .unwrap();
    runtime.start().await.unwrap();
    assert_eq!(
        fixture
            .store
            .get_execution_job(&job.id)
            .await
            .unwrap()
            .unwrap()
            .status,
        ExecutionJobStatus::Running,
        "startup must respect the monitor's live future lease"
    );
    monitor.0.kill().unwrap();
    monitor.0.wait().unwrap();

    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            let current = fixture
                .store
                .get_execution_job(&job.id)
                .await
                .unwrap()
                .unwrap();
            if current.status == ExecutionJobStatus::Lost {
                let event_id = current.result_event_id.as_deref().unwrap();
                let signals = fixture
                    .store
                    .list_context_thread_signals("background-context", None)
                    .await
                    .unwrap();
                if signals
                    .iter()
                    .filter(|signal| signal.event_id == event_id)
                    .count()
                    == 1
                {
                    assert_eq!(current.request, job.request);
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("the real online loop must deliver, without a manual outbox recovery call");
}
