//! Actual Runtime + physical read tools, in three separate OS processes.
//! No model API, real credentials, or user files are used.
#![cfg(feature = "remote-store")]
use morphz::config::AppConfig;
use morphz::llm::{Client, Message, Response, ToolCallRepr, ToolDefinition};
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::*;
use morphz::permission::{PermissionMode, ReviewerKind};
use morphz::runtime::{MorphzRuntime, RuntimeToolPolicy};
use morphz::secret_store::{HostEnvFileSecretBackend, SecretStore};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

struct FixtureClient {
    root: PathBuf,
    stage: String,
    nested: bool,
    infer: bool,
    calls: AtomicUsize,
}

/// Uses the real objective_create/objective_update tools around the existing
/// physical batch. The synthetic model's assertions ignore only those control
/// receipts; the Runtime persists and compiles the complete actual history.
struct ObjectiveFixtureClient {
    inner: Arc<FixtureClient>,
    native: Arc<SqliteStore>,
    completing: std::sync::atomic::AtomicBool,
}

#[async_trait::async_trait]
impl Client for ObjectiveFixtureClient {
    fn supports_async_cancellation(&self) -> bool {
        true
    }
    async fn create_completion(
        &self,
        mut messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        if self.completing.load(Ordering::SeqCst) {
            assert!(messages.iter().any(
                |m| m.role == "tool" && m.tool_call_id.as_deref() == Some("complete-objective")
            ));
            return Ok(Response {
                content: "checkpoint-batch-complete".into(),
                tool_calls: vec![],
            });
        }
        messages
            .retain(|m| m.role != "tool" || m.tool_call_id.as_deref() != Some("create-objective"));
        let initial = matches!(self.inner.stage.as_str(), "initial" | "live")
            && self.inner.calls.load(Ordering::SeqCst) == 0;
        let mut response = self.inner.create_completion(messages, tools).await?;
        if initial {
            response.tool_calls.insert(0, ToolCallRepr {
                id: "create-objective".into(), r#type: "function".into(), func_name: "objective_create".into(),
                arguments: json!({"stated_objective":"Verify the synthetic approval batch across process exits; accept one exact outside read and deny the other, then report completion", "reason":"The test explicitly spans multiple Runtime processes", "source_refs":[]}).to_string(),
            });
        } else if response.content == "checkpoint-batch-complete" {
            let objectives = self.native.list_recoverable_objectives().await?;
            assert_eq!(objectives.len(), 1);
            let objective = &objectives[0];
            self.completing.store(true, Ordering::SeqCst);
            response = Response { content: String::new(), tool_calls: vec![ToolCallRepr {
                id: "complete-objective".into(), r#type: "function".into(), func_name: "objective_update".into(),
                arguments: json!({"objective_id":objective.id,"base_revision":objective.revision,"status":"completed","reason":"The native test verified the exact allowed read and rejected sibling without duplicate work", "evidence_refs":[]}).to_string(),
            }] };
        }
        Ok(response)
    }
}

#[async_trait::async_trait]
impl Client for FixtureClient {
    fn supports_async_cancellation(&self) -> bool {
        true
    }
    async fn create_completion(
        &self,
        messages: Vec<Message>,
        _: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        let ordinal = self.calls.fetch_add(1, Ordering::SeqCst);
        let (stage, call_index) = if self.stage == "live" {
            if ordinal < 2 {
                ("initial", ordinal)
            } else {
                ("final", ordinal - 2)
            }
        } else {
            (self.stage.as_str(), ordinal)
        };
        if self.infer && stage == "cancel" {
            assert_eq!(call_index, 0, "cancellation must not re-evaluate the child");
            let tools = messages
                .iter()
                .filter(|m| m.role == "tool")
                .collect::<Vec<_>>();
            assert_eq!(tools.len(), 1);
            assert!(
                tools[0].content.contains("cancelled"),
                "{}",
                tools[0].content
            );
            return Ok(Response {
                content: "checkpoint-batch-complete".into(),
                tool_calls: Vec::new(),
            });
        }
        if self.infer && stage == "initial" && call_index == 0 {
            return Ok(Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: "eval-infer".into(),
                    r#type: "function".into(),
                    func_name: "eval".into(),
                    arguments: json!({"program": format!(
                        "(eval (requires (tools read)) (infer (returns String) (seq (call read (path {})) (call read (path {})) (call read (path {})) \"return the synthetic summary\")))",
                        json!(self.root.join("workspace/free.txt")),
                        json!(self.root.join("outside/one.txt")),
                        json!(self.root.join("outside/two.txt")),
                    )}).to_string(),
                }],
            });
        }
        if self.infer && stage == "final" && call_index == 1 {
            let tools = messages
                .iter()
                .filter(|m| m.role == "tool")
                .collect::<Vec<_>>();
            assert_eq!(tools.len(), 1);
            assert!(tools[0].content.contains("infer-checkpoint-value"));
            return Ok(Response {
                content: "checkpoint-batch-complete".into(),
                tool_calls: Vec::new(),
            });
        }
        assert_eq!(
            call_index,
            usize::from(self.infer && stage == "initial"),
            "unexpected extra model request"
        );
        if stage == "initial" {
            let mut calls = vec![ToolCallRepr {
                id: "read-0".into(),
                r#type: "function".into(),
                func_name: "read".into(),
                arguments: json!({"path":self.root.join("workspace/free.txt")}).to_string(),
            }];
            if self.nested {
                calls.push(ToolCallRepr {
                    id: "eval-root".into(), r#type: "function".into(), func_name: "eval".into(),
                    arguments: json!({"program":format!(
                        "(eval (requires (tools read)) (par (branch one (call read (path {}))) (branch two (call read (path {})))))",
                        json!(self.root.join("outside/one.txt")), json!(self.root.join("outside/two.txt")),
                    )}).to_string(),
                });
            } else {
                calls.extend(
                    ["outside/one.txt", "outside/two.txt"]
                        .into_iter()
                        .enumerate()
                        .map(|(i, name)| ToolCallRepr {
                            id: format!("read-{}", i + 1),
                            r#type: "function".into(),
                            func_name: "read".into(),
                            arguments: json!({"path":self.root.join(name)}).to_string(),
                        }),
                );
            }
            Ok(Response {
                content: String::new(),
                tool_calls: calls,
            })
        } else {
            assert_eq!(
                stage, "final",
                "resuming a partial batch must not call a model"
            );
            let tools = messages
                .iter()
                .filter(|m| m.role == "tool")
                .collect::<Vec<_>>();
            assert_eq!(
                tools.len(),
                if self.nested { 2 } else { 3 },
                "the resumed batch must contain every sibling result"
            );
            let content = tools
                .iter()
                .map(|m| m.content.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            assert!(content.contains("free-fixture"));
            if !self.nested {
                assert!(content.contains("approved-fixture"));
                assert!(content.contains("approval did not authorize"));
            } else {
                // The outer model receives the failed eval result, not the
                // internal physical read's permission-rejection envelope.
                assert!(content.contains("(par ...) failed"), "{content}");
                assert!(content.contains("synthetic denial"), "{content}");
            }
            assert!(!content.contains("must-not-be-read"));
            Ok(Response {
                content: if self.infer {
                    "\"infer-checkpoint-value\""
                } else {
                    "checkpoint-batch-complete"
                }
                .into(),
                tool_calls: Vec::new(),
            })
        }
    }
}

async fn store(root: &Path) -> Arc<SqliteStore> {
    Arc::new(
        SqliteStore::new(root.join("runtime.sqlite").to_str().unwrap())
            .await
            .unwrap(),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "subprocess fixture; invoked by approval_batch_resumes_across_real_process_exits"]
async fn approval_runtime_child() {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .with_test_writer()
        .try_init();
    let root = PathBuf::from(std::env::var("MORPHZ_APPROVAL_FIXTURE_ROOT").unwrap());
    let stage = std::env::var("MORPHZ_APPROVAL_FIXTURE_STAGE").unwrap();
    let native = store(&root).await;
    let objective = std::env::var("MORPHZ_APPROVAL_FIXTURE_OBJECTIVE").as_deref() == Ok("1");
    let client = Arc::new(FixtureClient {
        root: root.clone(),
        stage: stage.clone(),
        nested: std::env::var("MORPHZ_APPROVAL_FIXTURE_NESTED").as_deref() == Ok("1"),
        infer: std::env::var("MORPHZ_APPROVAL_FIXTURE_INFER").as_deref() == Ok("1"),
        calls: AtomicUsize::new(0),
    });
    let mut config = AppConfig::default();
    config.orchestrator.activation_admission.max_in_flight = 1;
    config.orchestrator.event_bus.max_in_flight = 1;
    // A deliberately short real lease lets the crash-only infer fixture
    // recover its still-live parent without editing durable ownership rows.
    if client.infer {
        config.orchestrator.activation_lease_secs = 3;
    }
    config.permissions.mode = PermissionMode::Custom;
    config.permissions.reviewer = ReviewerKind::User;
    config.permissions.read_only_outside_workspace = false;
    config.permissions.workspace_root = root.join("workspace").to_string_lossy().into_owned();
    config.background_task.artifact_dir = root.join("artifacts").to_string_lossy().into_owned();
    let model: Arc<dyn Client> = if objective {
        Arc::new(ObjectiveFixtureClient {
            inner: client.clone(),
            native: native.clone(),
            completing: std::sync::atomic::AtomicBool::new(false),
        })
    } else {
        client.clone()
    };
    let runtime = MorphzRuntime::builder(config, model)
        .store("sqlite:approval-fixture", native.clone())
        .secret_store(Arc::new(
            SecretStore::new(
                root.join("secrets.json"),
                Arc::new(HostEnvFileSecretBackend::new(root.join("test.env"))),
            )
            .unwrap(),
        ))
        .tool_policy(RuntimeToolPolicy {
            context_only: false,
            coding_eval: true,
        })
        .build()
        .await
        .unwrap();
    let mut replies = runtime.subscribe("chat/reply", 8);
    runtime.start().await.unwrap();
    if matches!(
        stage.as_str(),
        "pause-objective-commit"
            | "cancel-objective-commit"
            | "pause-objective-state-commit"
            | "cancel-objective-state-commit"
    ) {
        let objectives = native.list_recoverable_objectives().await.unwrap();
        assert_eq!(objectives.len(), 1);
        let held = &objectives[0];
        // Exercise the durable steps of pause_objective/cancel_objective,
        // then exit without destructors before physical cancellation begins.
        // There is no production failpoint or direct SQL ownership mutation.
        let status = if stage.starts_with("pause-") {
            ObjectiveStatus::Paused
        } else {
            ObjectiveStatus::Cancelled
        };
        let mutation = if stage.ends_with("-state-commit") {
            native
                .update_objective_state(
                    &held.id,
                    held.revision,
                    status,
                    None,
                    Some("synthetic exit before Evaluation release"),
                )
                .await
                .unwrap()
        } else {
            runtime
                .update_objective_state(
                    &held.id,
                    held.revision,
                    status,
                    None,
                    Some("synthetic exit after Objective control commit"),
                )
                .await
                .unwrap()
        };
        let ObjectiveMutation::Updated(committed) = mutation else {
            panic!("control commit failed")
        };
        assert_eq!(committed.status, status);
        assert_eq!(
            committed.active_evaluation_id.is_some(),
            stage.ends_with("-state-commit")
        );
        let jobs = native
            .list_execution_jobs(ExecutionJobFilter {
                include_terminal: false,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(
            jobs.len(),
            2,
            "the crash seam must precede physical cancellation"
        );
        assert!(jobs
            .iter()
            .all(|j| j.status == ExecutionJobStatus::WaitingApproval));
        assert_eq!(client.calls.load(Ordering::SeqCst), 0);
        std::process::exit(0);
    }
    if matches!(
        stage.as_str(),
        "pause-objective" | "cancel-objective" | "verify-stopped-objective"
    ) {
        if stage != "verify-stopped-objective" {
            let objectives = native.list_recoverable_objectives().await.unwrap();
            assert_eq!(objectives.len(), 1);
            let held = &objectives[0];
            assert!(held.evaluation_lease_expires_at.is_none());
            let mutation = if stage == "pause-objective" {
                runtime
                    .pause_objective(&held.id, held.revision, "synthetic cold pause")
                    .await
            } else {
                runtime
                    .cancel_objective(&held.id, held.revision, "synthetic cold cancellation")
                    .await
            }
            .unwrap();
            assert!(matches!(mutation, ObjectiveMutation::Updated(_)));
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let jobs = native
                    .list_execution_jobs(ExecutionJobFilter {
                        include_terminal: true,
                        ..Default::default()
                    })
                    .await
                    .unwrap();
                let plans = native
                    .list_plan_executions(PlanExecutionFilter {
                        include_terminal: true,
                        ..Default::default()
                    })
                    .await
                    .unwrap();
                if jobs.len() == 3
                    && jobs.iter().all(|job| job.status.is_terminal())
                    && plans.iter().all(|plan| plan.status.is_terminal())
                    && runtime.hosted_process_is_quiescent()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("cold Objective control must close its pending Jobs and release all live stacks");
        assert_eq!(
            client.calls.load(Ordering::SeqCst),
            0,
            "control must not re-evaluate a model"
        );
        return;
    }
    if stage == "cancel" {
        let jobs = native
            .list_execution_jobs(ExecutionJobFilter {
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap();
        let child = native
            .get_thread(&jobs[0].thread_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(child.executor_kind, "plan_infer");
        assert!(matches!(
            runtime
                .control_thread(
                    &child.context_id,
                    &child.id,
                    child.revision,
                    ThreadControlAction::Cancel,
                    "synthetic cancelled infer approval",
                )
                .await
                .unwrap(),
            ThreadMutation::Updated(_)
        ));
    }
    if stage == "initial" || stage == "live" {
        let session = runtime
            .ensure_session(NewSession {
                id: "approval-process-session".into(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Synthetic approval checkpoint".into(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        session
            .send(
                "read three synthetic files",
                "Checkpoint-Test",
                Some("checkpoint-ingress".into()),
            )
            .await
            .unwrap();
    }
    if stage == "live" {
        // Exercise ordinary decision -> live queue refill after both stacks
        // release. Restart recovery uses a different dispatch call site.
        for expected in [2, 1] {
            let pending = tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    let pending = native
                        .list_approvals(ApprovalFilter {
                            pending_only: true,
                            ..Default::default()
                        })
                        .await
                        .unwrap();
                    if pending.len() == expected && runtime.hosted_process_is_quiescent() {
                        let job = native
                            .get_execution_job(&pending[0].job_id)
                            .await
                            .unwrap()
                            .unwrap();
                        if native
                            .get_thread_activation_approval_wait(&job.activation_id)
                            .await
                            .unwrap()
                            .is_some_and(|wait| wait.approval_ids.len() == expected)
                        {
                            break pending;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("the live infer batch must checkpoint after each decision");
            assert_eq!(client.calls.load(Ordering::SeqCst), 2);
            let mut selected = None;
            for approval in pending {
                let job = native
                    .get_execution_job(&approval.job_id)
                    .await
                    .unwrap()
                    .unwrap();
                if expected == 1 || job.request["path"] == json!(root.join("outside/one.txt")) {
                    selected = Some(approval.id);
                    break;
                }
            }
            let decision = if expected == 2 {
                morphz::approval::ApprovalDecision::AllowOnce {
                    rationale: "synthetic exact read".into(),
                    risk_tags: vec![],
                }
            } else {
                morphz::approval::ApprovalDecision::Deny {
                    rationale: "synthetic denial".into(),
                    risk_tags: vec![],
                }
            };
            runtime
                .decide_approval(&selected.unwrap(), decision)
                .await
                .unwrap();
        }
    }
    if matches!(stage.as_str(), "final" | "cancel" | "live") {
        let reply = match tokio::time::timeout(Duration::from_secs(15), replies.recv()).await {
            Ok(reply) => reply.unwrap(),
            Err(error) => {
                let plans = native
                    .list_plan_executions(PlanExecutionFilter {
                        include_terminal: true,
                        ..Default::default()
                    })
                    .await
                    .unwrap();
                let jobs = native
                    .list_execution_jobs(ExecutionJobFilter {
                        include_terminal: true,
                        ..Default::default()
                    })
                    .await
                    .unwrap();
                let groups = native
                    .list_action_groups(ActionGroupFilter {
                        include_terminal: true,
                        ..Default::default()
                    })
                    .await
                    .unwrap();
                let events = native
                    .query(QueryFilter {
                        topic: Some("chat/tool_output".into()),
                        ..Default::default()
                    })
                    .await
                    .unwrap();
                panic!("final reply timed out: {error}; plans={:?}; jobs={:?}; groups={:?}; events={:?}",
                    plans.iter().map(|p| (&p.id, p.status, p.pending_kind, &p.error)).collect::<Vec<_>>(),
                    jobs.iter().map(|j| (&j.id, j.status)).collect::<Vec<_>>(),
                    groups.iter().map(|g| (&g.id, g.status)).collect::<Vec<_>>(),
                    events.iter().map(|e| (&e.topic, &e.payload)).collect::<Vec<_>>());
            }
        };
        assert_eq!(reply.payload["text"], "checkpoint-batch-complete");
    }
    let idle = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let jobs = native
                .list_execution_jobs(ExecutionJobFilter {
                    session_id: Some("approval-process-session".into()),
                    include_terminal: true,
                    ..Default::default()
                })
                .await
                .unwrap();
            if jobs.len() == 3 && runtime.hosted_process_is_quiescent() {
                let wait = native
                    .get_thread_activation_approval_wait(&jobs[0].activation_id)
                    .await
                    .unwrap();
                let expected = match stage.as_str() {
                    "initial" => 2,
                    "partial" => 1,
                    _ => 0,
                };
                if wait.as_ref().map_or(0, |wait| wait.approval_ids.len()) == expected {
                    if client.infer && matches!(stage.as_str(), "initial" | "partial") {
                        let plan = native
                            .list_plan_executions(PlanExecutionFilter {
                                include_terminal: true,
                                ..Default::default()
                            })
                            .await
                            .unwrap()
                            .pop()
                            .unwrap();
                        assert_eq!(plan.status, PlanExecutionStatus::Waiting);
                        assert_eq!(plan.pending_kind, Some(PlanExecutionWaitKind::Evaluation));
                        assert_eq!(
                            plan.pending_id.as_deref(),
                            Some(jobs[0].activation_id.as_str())
                        );
                        let parent_wait = native
                            .get_thread_activation_approval_wait(&plan.activation_id)
                            .await
                            .unwrap()
                            .expect("the infer parent must checkpoint before whole-host parking");
                        assert!(parent_wait.approval_ids.is_empty());
                        assert_eq!(
                            parent_wait.infer_activation_ids,
                            vec![jobs[0].activation_id.clone()]
                        );
                        let parent = native
                            .get_thread_activation(&plan.activation_id)
                            .await
                            .unwrap()
                            .unwrap();
                        assert_eq!(parent.status, ThreadActivationStatus::Queued);
                        assert!(parent.claimed_by.is_none());
                        assert!(parent.lease_expires_at.is_none());
                        let child = native
                            .get_thread_activation(&jobs[0].activation_id)
                            .await
                            .unwrap()
                            .unwrap();
                        assert_eq!(child.status, ThreadActivationStatus::Queued);
                        assert!(child.claimed_by.is_none());
                        assert!(child.lease_expires_at.is_none());
                    }
                    assert_eq!(
                        jobs.iter()
                            .filter(|j| j.status == ExecutionJobStatus::WaitingApproval)
                            .count(),
                        expected
                    );
                    assert!(jobs
                        .iter()
                        .filter(|j| j.status == ExecutionJobStatus::WaitingApproval)
                        .all(|j| j.side_effect_started_at.is_none()));
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    if idle.is_err() {
        let plans = native
            .list_plan_executions(PlanExecutionFilter {
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap();
        let snapshot = runtime
            .scheduler_snapshot(
                &runtime.identity().context_id,
                morphz::runtime::SchedulerQuery {
                    include_terminal: true,
                    limit: 100,
                },
            )
            .await
            .unwrap();
        let jobs = native
            .list_execution_jobs(ExecutionJobFilter {
                session_id: Some("approval-process-session".into()),
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap();
        let wait = match jobs.first() {
            Some(job) => native
                .get_thread_activation_approval_wait(&job.activation_id)
                .await
                .unwrap(),
            None => None,
        };
        panic!(
            "Runtime did not settle; stage={stage}, process_idle={}, wait={wait:?}, summary={:?}, admission={:?}, plans={:?}, jobs={:?}",
            runtime.hosted_process_is_quiescent(), snapshot.summary, snapshot.admission,
            plans.iter().map(|p| (&p.id, p.status, p.pending_kind, &p.error)).collect::<Vec<_>>(),
            jobs.iter().map(|j| (&j.id, j.status, &j.claimed_by)).collect::<Vec<_>>(),
        );
    }
    assert_eq!(
        client.calls.load(Ordering::SeqCst),
        if stage == "live" {
            4
        } else {
            usize::from(stage != "partial")
                * if client.infer && stage != "cancel" {
                    2
                } else {
                    1
                }
        }
    );
}

fn run_child(root: &Path, stage: &str, nested: bool, infer: bool) {
    run_child_with_objective(root, stage, nested, infer, false);
}

fn run_child_with_objective(root: &Path, stage: &str, nested: bool, infer: bool, objective: bool) {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "approval_runtime_child",
            "--ignored",
            "--nocapture",
        ])
        .env("MORPHZ_APPROVAL_FIXTURE_ROOT", root)
        .env("MORPHZ_APPROVAL_FIXTURE_STAGE", stage)
        .env(
            "MORPHZ_APPROVAL_FIXTURE_OBJECTIVE",
            if objective { "1" } else { "0" },
        )
        .env(
            "MORPHZ_APPROVAL_FIXTURE_NESTED",
            if nested { "1" } else { "0" },
        )
        .env(
            "MORPHZ_APPROVAL_FIXTURE_INFER",
            if infer { "1" } else { "0" },
        )
        .env_remove("RUST_MIN_STACK")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "child {stage} failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        !String::from_utf8_lossy(&output.stdout).contains("recovery_item_failed"),
        "Plan joins must not be misrouted through assistant-batch recovery: {}",
        String::from_utf8_lossy(&output.stdout)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn approval_batch_resumes_across_real_process_exits() {
    approval_process_case(false, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nested_plan_approval_resumes_across_real_process_exits() {
    approval_process_case(true, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn infer_child_approval_resumes_across_real_process_exits() {
    // Both parent and child checkpoint before each process exits.
    approval_process_case(false, true).await;
}

fn prepare_fixture() -> tempfile::TempDir {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    std::fs::create_dir(root.join("workspace")).unwrap();
    std::fs::create_dir(root.join("outside")).unwrap();
    std::fs::write(root.join("workspace/free.txt"), "free-fixture").unwrap();
    std::fs::write(root.join("outside/one.txt"), "approved-fixture").unwrap();
    std::fs::write(root.join("outside/two.txt"), "must-not-be-read").unwrap();
    temp
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_infer_approval_refill_uses_child_handoff() {
    let temp = prepare_fixture();
    run_child(temp.path(), "live", false, true);
    let native = store(temp.path()).await;
    let jobs = native
        .list_execution_jobs(ExecutionJobFilter {
            include_terminal: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(jobs.len(), 3);
    assert!(jobs.iter().all(|job| job.status.is_terminal()));
    assert!(jobs
        .iter()
        .find(|job| job.request["path"] == json!(temp.path().join("outside/two.txt")))
        .unwrap()
        .side_effect_started_at
        .is_none());
    let approvals = native
        .list_approvals(ApprovalFilter::default())
        .await
        .unwrap();
    assert_eq!(approvals.len(), 2);
    assert_eq!(
        approvals
            .iter()
            .filter(|a| a.grant_consumed_at.is_some())
            .count(),
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_checkpointed_infer_child_after_restart_closes_parent() {
    let temp = prepare_fixture();
    let root = temp.path();
    run_child(root, "initial", false, true);
    let native = store(root).await;
    let jobs = native
        .list_execution_jobs(ExecutionJobFilter {
            include_terminal: true,
            ..Default::default()
        })
        .await
        .unwrap();
    let free = jobs
        .iter()
        .find(|j| j.tool_call_id == "read-0")
        .unwrap()
        .clone();
    drop(native);
    run_child(root, "cancel", false, true);
    let native = store(root).await;
    assert_eq!(
        native.get_execution_job(&free.id).await.unwrap().unwrap(),
        free
    );
    let jobs = native
        .list_execution_jobs(ExecutionJobFilter {
            include_terminal: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(jobs.len(), 3);
    for job in jobs.iter().filter(|j| j.id != free.id) {
        assert_eq!(job.status, ExecutionJobStatus::Cancelled);
        assert!(job.side_effect_started_at.is_none());
    }
    assert!(native
        .get_thread_activation_approval_wait(&free.activation_id)
        .await
        .unwrap()
        .is_none());
    let child = native.get_thread(&free.thread_id).await.unwrap().unwrap();
    assert_eq!(child.lifecycle, ThreadLifecycle::Cancelled);
    let plans = native
        .list_plan_executions(PlanExecutionFilter {
            include_terminal: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(plans.len(), 1);
    assert_eq!(plans[0].status, PlanExecutionStatus::Failed);
    assert!(plans[0].error.as_deref().unwrap().contains("cancelled"));
    assert!(native
        .list_approvals(ApprovalFilter::default())
        .await
        .unwrap()
        .iter()
        .all(|a| a.grant_consumed_at.is_none()));
}

async fn approval_process_case(nested: bool, infer: bool) {
    approval_objective_process_case(nested, infer, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn objective_approval_prelude_resumes_across_real_process_exits() {
    approval_objective_process_case(false, false, true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn objective_infer_approval_resumes_across_real_process_exits() {
    approval_objective_process_case(false, true, true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn objective_parallel_approval_resumes_across_real_process_exits() {
    approval_objective_process_case(true, false, true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cold_objective_pause_closes_approval_owners() {
    objective_cold_control_case("pause-objective").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cold_objective_cancel_closes_approval_owners() {
    objective_cold_control_case("cancel-objective").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn objective_pause_commit_survives_exit_before_physical_cancellation() {
    objective_cold_control_case("pause-objective-commit").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn objective_cancel_commit_survives_exit_before_physical_cancellation() {
    objective_cold_control_case("cancel-objective-commit").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn objective_pause_state_commit_survives_exit_before_evaluation_release() {
    objective_cold_control_case("pause-objective-state-commit").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn objective_cancel_state_commit_survives_exit_before_evaluation_release() {
    objective_cold_control_case("cancel-objective-state-commit").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_objective_infer_approvals_wake_exact_owners() {
    let temp = prepare_fixture();
    run_child_with_objective(temp.path(), "live", false, true, true);
    let native = store(temp.path()).await;
    let objectives = native
        .list_session_objectives("context-default", "approval-process-session", true)
        .await
        .unwrap();
    assert_eq!(objectives.len(), 1);
    assert_eq!(objectives[0].status, ObjectiveStatus::Completed);
    assert!(native
        .get_objective_approval_wait(&objectives[0].id)
        .await
        .unwrap()
        .is_none());
}

async fn objective_cold_control_case(stage: &str) {
    for (nested, infer) in [(false, false), (true, false), (false, true)] {
        let temp = prepare_fixture();
        let root = temp.path();
        run_child_with_objective(root, "initial", nested, infer, true);
        let native = store(root).await;
        let jobs = native
            .list_execution_jobs(ExecutionJobFilter {
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap();
        let free = jobs
            .iter()
            .find(|j| j.tool_call_id == "read-0")
            .unwrap()
            .clone();
        drop(native);
        run_child_with_objective(root, stage, nested, infer, true);
        if stage.ends_with("-commit") {
            // Nothing after the committed control ran in the prior process.
            // Recovery, not the test, must close every exact old owner.
            run_child_with_objective(root, "verify-stopped-objective", nested, infer, true);
        }
        let native = store(root).await;
        assert_eq!(
            native.get_execution_job(&free.id).await.unwrap().unwrap(),
            free
        );
        for job in native
            .list_execution_jobs(ExecutionJobFilter {
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap()
            .iter()
            .filter(|j| j.id != free.id)
        {
            assert_eq!(job.status, ExecutionJobStatus::Cancelled);
            assert!(job.side_effect_started_at.is_none());
        }
        assert!(native
            .list_approvals(ApprovalFilter::default())
            .await
            .unwrap()
            .iter()
            .all(|a| !a.status.is_pending() && a.grant_consumed_at.is_none()));
        assert!(native
            .list_context_thread_activations(&free.context_id, false)
            .await
            .unwrap()
            .is_empty());
        let objectives = native
            .list_session_objectives(&free.context_id, &free.session_id, true)
            .await
            .unwrap();
        assert_eq!(objectives.len(), 1);
        assert_eq!(
            objectives[0].status,
            if stage.starts_with("pause-") {
                ObjectiveStatus::Paused
            } else {
                ObjectiveStatus::Cancelled
            }
        );
        assert!(objectives[0].active_evaluation_id.is_none());
        assert!(native
            .get_objective_approval_wait(&objectives[0].id)
            .await
            .unwrap()
            .is_none());
        drop(native);
        run_child_with_objective(root, "verify-stopped-objective", nested, infer, true);
    }
}

async fn approval_objective_process_case(nested: bool, infer: bool, objective: bool) {
    let temp = prepare_fixture();
    let root = temp.path();
    run_child_with_objective(root, "initial", nested, infer, objective);
    let native = store(root).await;
    let held = if objective {
        let rows = native.list_recoverable_objectives().await.unwrap();
        assert_eq!(rows.len(), 1);
        let o = rows[0].clone();
        assert!(o.active_evaluation_id.is_some());
        assert!(o.evaluation_lease_expires_at.is_none());
        let hold = native
            .get_objective_approval_wait(&o.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(Some(&hold.evaluation_id), o.active_evaluation_id.as_ref());
        Some(o)
    } else {
        None
    };
    let before = native
        .list_execution_jobs(ExecutionJobFilter {
            include_terminal: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(before.len(), 3);
    if objective && nested {
        let plans = native
            .list_plan_executions(PlanExecutionFilter {
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(plans
            .iter()
            .all(|p| p.objective_id.as_deref() == held.as_ref().map(|o| o.id.as_str())));
        // This creation-prelude dialogue has Evaluation ownership, not an
        // Objective-supervised Thread's capability-lease authority.
        assert!(before.iter().all(|job| job
            .request
            .get(morphz::approval::CAPABILITY_LEASE_OBJECTIVE_REQUEST_KEY)
            .is_none()));
    }
    let free = before
        .iter()
        .find(|j| j.tool_call_id == "read-0")
        .unwrap()
        .clone();
    assert_eq!(free.status, ExecutionJobStatus::Succeeded);
    let checkpoint = native
        .get_thread_activation_approval_wait(&free.activation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(checkpoint.approval_ids.len(), 2);
    let parent_checkpoint = if infer {
        let parent_id = native
            .list_plan_executions(PlanExecutionFilter {
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap()
            .pop()
            .unwrap()
            .activation_id;
        Some(
            native
                .get_thread_activation_approval_wait(&parent_id)
                .await
                .unwrap()
                .unwrap(),
        )
    } else {
        None
    };
    let one = before
        .iter()
        .find(|j| j.request["path"] == json!(root.join("outside/one.txt")))
        .unwrap();
    let approvals = native
        .list_approvals(ApprovalFilter {
            job_id: Some(one.id.clone()),
            ..Default::default()
        })
        .await
        .unwrap();
    let allowed = &approvals[0];
    native
        .commit_approval_decision(
            &allowed.id,
            allowed.revision,
            ApprovalResolution::Allow {
                rationale: "synthetic exact read".into(),
                risk_tags: Vec::new(),
            },
        )
        .await
        .unwrap();
    drop(native);
    run_child_with_objective(root, "partial", nested, infer, objective);
    let native = store(root).await;
    if let Some(held) = &held {
        let current = native.get_objective(&held.id).await.unwrap().unwrap();
        assert_eq!(current.active_evaluation_id, held.active_evaluation_id);
        assert_eq!(current.continuation_sequence, held.continuation_sequence);
        assert_eq!(current.revision, held.revision);
        assert!(current.evaluation_lease_expires_at.is_none());
        assert!(native
            .get_objective_approval_wait(&held.id)
            .await
            .unwrap()
            .is_some());
    }
    let remaining = native
        .get_thread_activation_approval_wait(&free.activation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        remaining.assistant_call_event_id,
        checkpoint.assistant_call_event_id
    );
    assert_eq!(remaining.approval_ids.len(), 1);
    if let Some(parent_checkpoint) = parent_checkpoint {
        assert_eq!(
            native
                .get_thread_activation_approval_wait(&parent_checkpoint.activation_id)
                .await
                .unwrap()
                .unwrap(),
            parent_checkpoint,
            "partial child execution must retain the original parent assistant-call boundary"
        );
    }
    assert!(checkpoint.approval_ids.contains(&remaining.approval_ids[0]));
    assert_eq!(
        native.get_execution_job(&free.id).await.unwrap().unwrap(),
        free,
        "completed sibling was replayed"
    );
    let approved = native.get_execution_job(&one.id).await.unwrap().unwrap();
    assert_eq!(approved.status, ExecutionJobStatus::Succeeded);
    assert!(native
        .get_approval(&allowed.id)
        .await
        .unwrap()
        .unwrap()
        .grant_consumed_at
        .is_some());
    let pending = native
        .list_approvals(ApprovalFilter {
            pending_only: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(pending.len(), 1);
    native
        .commit_approval_decision(
            &pending[0].id,
            pending[0].revision,
            ApprovalResolution::Deny {
                rationale: "synthetic denial".into(),
                risk_tags: Vec::new(),
            },
        )
        .await
        .unwrap();
    drop(native);
    run_child_with_objective(root, "final", nested, infer, objective);
    let native = store(root).await;
    if let Some(held) = &held {
        let current = native.get_objective(&held.id).await.unwrap().unwrap();
        assert_eq!(current.status, ObjectiveStatus::Completed);
        assert_eq!(current.continuation_sequence, held.continuation_sequence);
        assert!(native
            .get_objective_approval_wait(&held.id)
            .await
            .unwrap()
            .is_none());
    }
    assert_eq!(
        native.get_execution_job(&free.id).await.unwrap().unwrap(),
        free
    );
    assert_eq!(
        native.get_execution_job(&one.id).await.unwrap().unwrap(),
        approved
    );
    let after = native
        .list_execution_jobs(ExecutionJobFilter {
            include_terminal: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(after.len(), 3);
    assert!(after.iter().all(|j| j.status.is_terminal()));
    assert!(after
        .iter()
        .find(|j| j.request["path"] == json!(root.join("outside/two.txt")))
        .unwrap()
        .side_effect_started_at
        .is_none());
    let outputs = native
        .query(QueryFilter {
            topic: Some("chat/tool_output".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        outputs.len(),
        (if nested || infer { 4 } else { 3 }) + if objective { 2 } else { 0 }
    );
    let rejected = outputs
        .iter()
        .find(|e| e.payload["tool_status"] == "rejected")
        .unwrap();
    assert_eq!(rejected.payload["executed"], false);
    assert_eq!(rejected.payload["approval_status"], "denied");
    assert!(rejected.payload["text"]
        .as_str()
        .unwrap()
        .contains("approval did not authorize"));
    if nested {
        let plans = native
            .list_plan_executions(PlanExecutionFilter {
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(plans.len(), 3);
        assert!(plans.iter().all(|p| p.status.is_terminal()));
        assert!(outputs.iter().any(|e| e
            .payload
            .get("text")
            .and_then(|v| v.as_str())
            .is_some_and(|s| s.contains("approved-fixture"))));
    }
}
