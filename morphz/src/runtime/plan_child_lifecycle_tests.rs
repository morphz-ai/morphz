//! Real parallel Plan runners, durable Jobs and human approval; no remote model.
use super::*;
use crate::llm::{Message, Response, ToolCallRepr, ToolDefinition};
use crate::memory::*;
use crate::permission::PermissionMode;
use crate::secret_store::{HostEnvFileSecretBackend, SecretStore};
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

struct ParallelApprovalClient {
    program: String,
    calls: AtomicUsize,
}

struct GatedReview {
    calls: AtomicUsize,
    release: tokio::sync::Semaphore,
}
#[async_trait::async_trait]
impl ApprovalProvider for GatedReview {
    async fn review(
        &self,
        _: &crate::approval::ApprovalRequest,
    ) -> Result<ApprovalDecision, RuntimeError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.release.acquire().await.unwrap().forget();
        Ok(ApprovalDecision::AllowOnce {
            rationale: "synthetic callback".into(),
            risk_tags: vec![],
        })
    }
}

#[async_trait::async_trait]
impl Client for ParallelApprovalClient {
    async fn create_completion(
        &self,
        messages: Vec<Message>,
        _: Vec<ToolDefinition>,
    ) -> Result<Response, RuntimeError> {
        match self.calls.fetch_add(1, Ordering::SeqCst) {
            0 => Ok(Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: "parallel-approved-read".into(),
                    r#type: "function".into(),
                    func_name: "eval".into(),
                    arguments: json!({"program": self.program}).to_string(),
                }],
            }),
            1 => {
                let outputs = messages
                    .iter()
                    .filter(|m| m.role == "tool")
                    .collect::<Vec<_>>();
                assert_eq!(outputs.len(), 1);
                assert!(
                    outputs[0].content.contains("alpha-fixture"),
                    "{}",
                    outputs[0].content
                );
                assert!(
                    outputs[0].content.contains("beta-fixture"),
                    "{}",
                    outputs[0].content
                );
                Ok(Response {
                    content: "parallel-approved-read-complete".into(),
                    tool_calls: vec![],
                })
            }
            _ => panic!("unexpected model retry"),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn parallel_plan_reconciliation_preserves_durable_wait_without_child_stacks() {
    run_parallel_approval_case(false, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn parallel_plan_cancellation_releases_child_execution_stacks() {
    run_parallel_approval_case(true, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn parallel_plan_custom_reviewer_keeps_live_callback_until_it_decides() {
    run_parallel_approval_case(false, true).await;
}

async fn run_parallel_approval_case(cancel: bool, custom: bool) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    std::fs::create_dir(root.join("workspace")).unwrap();
    std::fs::write(root.join("alpha.txt"), "alpha-fixture").unwrap();
    std::fs::write(root.join("beta.txt"), "beta-fixture").unwrap();
    let program = format!(
        "(eval (requires (tools read)) (par (branch alpha (call read (path {}))) (branch beta (call read (path {})))))",
        serde_json::to_string(&root.join("alpha.txt")).unwrap(),
        serde_json::to_string(&root.join("beta.txt")).unwrap(),
    );
    let client = Arc::new(ParallelApprovalClient {
        program,
        calls: AtomicUsize::new(0),
    });
    let mut config = AppConfig::default();
    config.permissions.mode = PermissionMode::Custom;
    config.permissions.reviewer = ReviewerKind::User;
    config.permissions.read_only_outside_workspace = false;
    config.permissions.workspace_root = root.join("workspace").to_string_lossy().into_owned();
    let callback = Arc::new(GatedReview {
        calls: AtomicUsize::new(0),
        release: tokio::sync::Semaphore::new(0),
    });
    let mut builder = MorphzRuntime::builder(config, client.clone())
        .database_path(root.join("runtime.sqlite").to_string_lossy())
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
        });
    if custom {
        builder = builder.approval_provider(callback.clone());
    }
    let runtime = builder.build().await.unwrap();
    let mut replies = runtime.subscribe("chat/reply", 4);
    runtime.start().await.unwrap();
    let session = runtime
        .ensure_session(NewSession {
            id: "parallel-approval-session".into(),
            agent_id: runtime.identity().agent_id.clone(),
            context_id: runtime.identity().context_id.clone(),
            parent_session_id: None,
            title: "Synthetic parallel approvals".into(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    session
        .send(
            "read the two synthetic files",
            "Test",
            Some("parallel-approval-ingress".into()),
        )
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if custom {
                if callback.calls.load(Ordering::SeqCst) == 2 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                continue;
            }
            let pending = runtime.pending_approvals().await;
            let jobs = runtime
                .inner
                .store
                .list_execution_jobs(ExecutionJobFilter::default())
                .await
                .unwrap();
            if pending.len() == 2
                && jobs.len() == 2
                && runtime
                    .inner
                    .store
                    .get_thread_activation_approval_wait(&jobs[0].activation_id)
                    .await
                    .unwrap()
                    .is_some()
                && runtime.inner.orchestrator.active_plan_child_count() == 0
                && runtime.inner.orchestrator.waiting_plan_runner_count().await == 0
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("both Plan branches must reach the ordinary human boundary");
    // Recovery must retain the durable waits, not recreate sleeping child
    // stacks or duplicate human callback futures while approval is pending.
    for _ in 0..8 {
        runtime
            .inner
            .orchestrator
            .reconcile_durable_plans()
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let approvals = runtime
        .inner
        .store
        .list_approvals(ApprovalFilter::default())
        .await
        .unwrap();
    assert_eq!(approvals.len(), 2);
    assert!(approvals
        .iter()
        .all(|a| a.status == ApprovalStatus::PendingHuman));
    let jobs = runtime
        .inner
        .store
        .list_execution_jobs(ExecutionJobFilter {
            include_terminal: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(jobs.len(), 2);
    assert!(
        jobs.iter()
            .all(|j| j.status == ExecutionJobStatus::WaitingApproval
                && j.side_effect_started_at.is_none()),
        "{jobs:?}"
    );
    assert!(runtime.inner.human_approval_hub.pending().is_empty());
    assert_eq!(runtime.pending_approvals().await.len(), 2);
    assert_eq!(
        runtime.inner.orchestrator.waiting_plan_runner_count().await,
        if custom { 3 } else { 0 },
        "only a durable checkpoint may release the parent and child stacks"
    );
    assert_eq!(client.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        runtime.inner.orchestrator.active_plan_child_count(),
        if custom { 2 } else { 0 }
    );
    #[cfg(feature = "remote-store")]
    assert_eq!(runtime.hosted_process_is_quiescent(), !custom);
    if cancel {
        assert_eq!(
            runtime
                .cancel_session_durable(session.id(), "cancel the synthetic parallel read")
                .await
                .unwrap(),
            1
        );
        let cancelled_plans = runtime
            .inner
            .store
            .list_plan_executions(PlanExecutionFilter {
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(cancelled_plans.len(), 3);
        assert!(
            cancelled_plans.iter().all(|p| {
                p.status == PlanExecutionStatus::Cancelled
                    && p.pending_kind.is_none()
                    && p.pending_id.is_none()
                    && p.claimed_by.is_none()
                    && p.claim_token.is_none()
                    && p.lease_expires_at.is_none()
                    && p.finished_at.is_some()
            }),
            "cancellation must close the parent and both child Plans durably: {:?}",
            cancelled_plans
                .iter()
                .map(|p| (&p.id, p.status, p.pending_kind))
                .collect::<Vec<_>>()
        );
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while runtime.inner.orchestrator.active_plan_child_count() != 0
                || !runtime.inner.human_approval_hub.pending().is_empty()
            {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("cancelled child execution stacks must release their registrations");
        let jobs = runtime
            .inner
            .store
            .list_execution_jobs(ExecutionJobFilter {
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(jobs.len(), 2);
        assert!(jobs.iter().all(
            |j| j.status == ExecutionJobStatus::Cancelled && j.side_effect_started_at.is_none()
        ));
        assert_eq!(client.calls.load(Ordering::SeqCst), 1);
        let groups = runtime
            .inner
            .store
            .list_action_groups(ActionGroupFilter {
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(!groups.is_empty());
        assert!(
            groups.iter().all(|g| g.status.is_terminal()),
            "cancelled Plans must not strand their batch joins"
        );
        return;
    }
    if custom {
        assert_eq!(callback.calls.load(Ordering::SeqCst), 2);
        callback.release.add_permits(2);
    } else {
        for approval in &approvals {
            runtime
                .decide_approval(
                    &approval.id,
                    ApprovalDecision::AllowOnce {
                        rationale: "synthetic read only".into(),
                        risk_tags: vec![],
                    },
                )
                .await
                .unwrap();
        }
    }
    let reply = tokio::time::timeout(std::time::Duration::from_secs(10), replies.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reply.payload["text"], "parallel-approved-read-complete");
    assert_eq!(client.calls.load(Ordering::SeqCst), 2);
    let jobs = runtime
        .inner
        .store
        .list_execution_jobs(ExecutionJobFilter {
            include_terminal: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(jobs.len(), 2);
    assert!(jobs
        .iter()
        .all(|j| j.status == ExecutionJobStatus::Succeeded));
    let plans = runtime
        .inner
        .store
        .list_plan_executions(PlanExecutionFilter {
            include_terminal: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(plans.len(), 3);
    assert!(plans
        .iter()
        .all(|p| p.status == PlanExecutionStatus::Succeeded));
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while runtime.inner.orchestrator.active_plan_child_count() != 0 {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("completed child execution stacks must release their registrations");
}
