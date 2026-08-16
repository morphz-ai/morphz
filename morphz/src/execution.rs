//! Durable execution-job control plane.
//!
//! This module deliberately stops at the persistence boundary.  It does not
//! execute a tool, own an OS process, or claim exactly-once delivery for an
//! external side effect.  In particular, restart reconciliation treats an
//! uncertain non-idempotent execution as `lost` rather than replaying it.

use std::{error::Error, fmt, sync::Arc};

use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};

use crate::event::{Event, TYPE_TOOL_OUTPUT};
use crate::memory::{
    ActionGroupFilter, ActionGroupStore, EventStore, ExecutionJobFilter, ExecutionJobMutation,
    ExecutionJobRecord, ExecutionJobStatus, ExecutionJobStore, ExecutionJobTerminal,
    ExecutionRetrySafety, NewExecutionJob, QueryFilter, WorkerCoordinationMode,
};
use crate::scheduler::{KernelResult, SchedulerKernel};

pub type ExecutionResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

const JOB_ID_DOMAIN: &[u8] = b"morphz.execution-job.v1\0";

/// Immutable input used to materialize one model Action as an Execution Job.
///
/// The Job identity is intentionally absent: the manager derives it from the
/// causal `(activation_id, tool_call_id)` pair, while the Store verifies that
/// the remaining routing fields agree with the Activation and Thread.
#[derive(Debug, Clone, PartialEq)]
pub struct ExecutionJobSpec {
    pub activation_id: String,
    pub thread_id: String,
    pub agent_id: String,
    pub context_id: String,
    pub session_id: String,
    pub initiating_principal_id: Option<String>,
    pub target_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub request: serde_json::Value,
    pub retry_safety: ExecutionRetrySafety,
    pub requires_approval: bool,
}

impl ExecutionJobSpec {
    pub fn into_new_job(self) -> ExecutionResult<NewExecutionJob> {
        let id = deterministic_job_id(&self.activation_id, &self.tool_call_id)?;
        validate_identity_part("target_id", &self.target_id)?;
        Ok(NewExecutionJob {
            id,
            activation_id: self.activation_id,
            thread_id: self.thread_id,
            agent_id: self.agent_id,
            context_id: self.context_id,
            session_id: self.session_id,
            initiating_principal_id: self.initiating_principal_id,
            target_id: self.target_id,
            tool_call_id: self.tool_call_id,
            tool_name: self.tool_name,
            request: self.request,
            retry_safety: self.retry_safety,
            requires_approval: self.requires_approval,
        })
    }
}

/// Stable physical identity for one Action inside one Activation.
///
/// Length-prefixing prevents ambiguous concatenations, and the domain prefix
/// prevents the digest from being confused with another Morphz identity.  The
/// function is deterministic, not secret; it must never be used as a claim
/// token or an authorization credential.
pub fn deterministic_job_id(activation_id: &str, tool_call_id: &str) -> ExecutionResult<String> {
    validate_identity_part("activation_id", activation_id)?;
    validate_identity_part("tool_call_id", tool_call_id)?;

    let mut digest = Sha256::new();
    digest.update(JOB_ID_DOMAIN);
    update_length_prefixed(&mut digest, activation_id.as_bytes());
    update_length_prefixed(&mut digest, tool_call_id.as_bytes());
    Ok(format!("job_{:x}", digest.finalize()))
}

fn validate_identity_part(field: &'static str, value: &str) -> ExecutionResult<()> {
    if value.trim().is_empty() {
        return Err(Box::new(ExecutionInputError { field }));
    }
    Ok(())
}

fn update_length_prefixed(digest: &mut Sha256, value: &[u8]) {
    digest.update((value.len() as u64).to_be_bytes());
    digest.update(value);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ExecutionInputError {
    field: &'static str,
}

impl fmt::Display for ExecutionInputError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Execution Job {} must not be empty", self.field)
    }
}

impl Error for ExecutionInputError {}

/// The manager operation whose optimistic-CAS result is being reported.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobOperation {
    Claim,
    Heartbeat,
    Requeue,
    RequestCancel,
    Finish,
    ReconcileObservedResult,
    ReconcileLost,
}

/// Typed projection of a Store mutation.  Callers must handle conflicts and
/// rejections explicitly instead of interpreting a string result as success.
#[derive(Debug, Clone, PartialEq)]
pub enum JobReceipt {
    Applied {
        operation: JobOperation,
        job: ExecutionJobRecord,
    },
    Existing {
        operation: JobOperation,
        job: ExecutionJobRecord,
    },
    Conflict {
        operation: JobOperation,
        current: ExecutionJobRecord,
    },
    Rejected {
        operation: JobOperation,
        current: ExecutionJobRecord,
        reason: String,
    },
    NotFound {
        operation: JobOperation,
    },
}

impl JobReceipt {
    pub fn from_mutation(operation: JobOperation, mutation: ExecutionJobMutation) -> Self {
        match mutation {
            ExecutionJobMutation::Updated(job) => Self::Applied { operation, job },
            ExecutionJobMutation::Existing(job) => Self::Existing { operation, job },
            ExecutionJobMutation::Conflict { current } => Self::Conflict { operation, current },
            ExecutionJobMutation::Rejected { current, reason } => Self::Rejected {
                operation,
                current,
                reason,
            },
            ExecutionJobMutation::NotFound => Self::NotFound { operation },
        }
    }

    pub fn applied_job(&self) -> Option<&ExecutionJobRecord> {
        match self {
            Self::Applied { job, .. } | Self::Existing { job, .. } => Some(job),
            _ => None,
        }
    }
}

/// A proven terminal physical fact.  Empty output is represented by an empty
/// `result_refs` vector, never by withholding completion from the model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobOutcome {
    Succeeded {
        result_event_id: Option<String>,
        result_refs: Vec<String>,
        exit_code: Option<i32>,
    },
    Failed {
        result_event_id: Option<String>,
        result_refs: Vec<String>,
        error: String,
        exit_code: Option<i32>,
    },
    Cancelled {
        result_event_id: Option<String>,
        result_refs: Vec<String>,
        reason: Option<String>,
        exit_code: Option<i32>,
    },
    /// Runtime ownership was lost and external reality cannot be proved.  This
    /// is not equivalent to a normal tool failure and must remain visible.
    Lost {
        result_event_id: Option<String>,
        reason: String,
    },
}

impl From<JobOutcome> for ExecutionJobTerminal {
    fn from(outcome: JobOutcome) -> Self {
        match outcome {
            JobOutcome::Succeeded {
                result_event_id,
                result_refs,
                exit_code,
            } => Self {
                status: ExecutionJobStatus::Succeeded,
                result_event_id,
                result_refs,
                error: None,
                exit_code,
            },
            JobOutcome::Failed {
                result_event_id,
                result_refs,
                error,
                exit_code,
            } => Self {
                status: ExecutionJobStatus::Failed,
                result_event_id,
                result_refs,
                error: Some(error),
                exit_code,
            },
            JobOutcome::Cancelled {
                result_event_id,
                result_refs,
                reason,
                exit_code,
            } => Self {
                status: ExecutionJobStatus::Cancelled,
                result_event_id,
                result_refs,
                error: reason,
                exit_code,
            },
            JobOutcome::Lost {
                result_event_id,
                reason,
            } => Self {
                status: ExecutionJobStatus::Lost,
                result_event_id,
                result_refs: Vec::new(),
                error: Some(reason),
                exit_code: None,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobClaim<'a> {
    pub worker_id: &'a str,
    pub claim_token: &'a str,
    pub lease_expires_at: DateTime<Utc>,
    pub approval_ref: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobHeartbeat<'a> {
    pub claim_token: &'a str,
    pub lease_expires_at: DateTime<Utc>,
    /// Executors must persist this boundary before performing a side effect.
    /// It reduces the uncertainty window but does not manufacture exactly-once
    /// behavior for an external system.
    pub side_effect_started_at: Option<DateTime<Utc>>,
    pub progress_ref: Option<&'a str>,
}

/// Pure restart decision for a durable non-terminal Job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestartAction {
    /// No persistence change is required.
    Preserve,
    /// A fenced running -> queued transition is safe because the exact Action
    /// is idempotent and no side-effect boundary was persisted.
    Requeue { reason: String },
    /// Reality is uncertain; close the stale running record as `lost` and let a
    /// later semantic decision choose whether a new Action should be issued.
    MarkLost { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestartPlan {
    pub job_id: String,
    pub expected_revision: u64,
    pub action: RestartAction,
}

pub fn restart_plan(job: &ExecutionJobRecord) -> RestartPlan {
    let action = match job.status {
        ExecutionJobStatus::Queued | ExecutionJobStatus::WaitingApproval => RestartAction::Preserve,
        ExecutionJobStatus::Running
            if job.cancel_requested_at.is_none()
                && (job.side_effect_started_at.is_none()
                    || job.retry_safety == ExecutionRetrySafety::Idempotent) =>
        {
            RestartAction::Requeue {
                reason: if job.side_effect_started_at.is_none() {
                    "previous worker disappeared before the persisted side-effect boundary; a fenced requeue transition is safe".to_string()
                } else {
                    "previous worker disappeared after the side-effect boundary, but the exact Action is declared idempotent and is safe to replay".to_string()
                },
            }
        }
        ExecutionJobStatus::Running => RestartAction::MarkLost {
            reason: restart_lost_reason(job),
        },
        ExecutionJobStatus::Succeeded
        | ExecutionJobStatus::Failed
        | ExecutionJobStatus::Cancelled
        | ExecutionJobStatus::Lost => RestartAction::Preserve,
    };
    RestartPlan {
        job_id: job.id.clone(),
        expected_revision: job.revision,
        action,
    }
}

/// Startup recovery must distinguish an exclusive local Store from a shared
/// leased Store. In the latter case, a live future lease may belong to another
/// healthy Runtime process and is therefore authoritative evidence to wait.
pub fn startup_recovery_plan(
    job: &ExecutionJobRecord,
    coordination: WorkerCoordinationMode,
    now: chrono::DateTime<chrono::Utc>,
) -> RestartPlan {
    if matches!(
        coordination,
        WorkerCoordinationMode::SharedHostLeases | WorkerCoordinationMode::SharedLeases
    ) && job.status == ExecutionJobStatus::Running
        && job
            .lease_expires_at
            .is_some_and(|expires_at| expires_at > now)
    {
        return RestartPlan {
            job_id: job.id.clone(),
            expected_revision: job.revision,
            action: RestartAction::Preserve,
        };
    }
    restart_plan(job)
}

fn restart_lost_reason(job: &ExecutionJobRecord) -> String {
    if job.cancel_requested_at.is_some() {
        return "runtime restarted after cancellation was requested, but physical termination was not proven".to_string();
    }
    if job.side_effect_started_at.is_some() {
        return "runtime restarted after the persisted side-effect boundary; external outcome is unknown and automatic replay is forbidden".to_string();
    }
    match job.retry_safety {
        ExecutionRetrySafety::Idempotent => {
            "runtime restarted while the running Job outcome was not durably observed".to_string()
        }
        ExecutionRetrySafety::ReconcileRequired => {
            "runtime restarted with a reconcile-required Job; external state must be inspected before issuing another Action".to_string()
        }
        ExecutionRetrySafety::AtMostOnce => {
            "runtime restarted with an at-most-once Job; automatic replay is forbidden".to_string()
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct RestartReconcileReport {
    pub preserved_job_ids: Vec<String>,
    /// Non-terminal Job rows closed from an already durable immutable result
    /// Event. This repairs the crash window in which the Event commit won but
    /// the Execution Job terminal projection did not.
    pub recovered_receipts: Vec<JobReceipt>,
    pub requeue_receipts: Vec<JobReceipt>,
    pub lost_receipts: Vec<JobReceipt>,
}

/// Persistence-oriented manager for Execution Jobs.
#[derive(Debug, Clone)]
pub struct ExecutionJobManager<S: ?Sized> {
    store: Arc<S>,
    scheduler_kernel: Option<Arc<SchedulerKernel>>,
}

impl<S: ?Sized> ExecutionJobManager<S> {
    pub fn new(store: Arc<S>) -> Self {
        Self {
            store,
            scheduler_kernel: None,
        }
    }

    pub fn with_scheduler_kernel(mut self, scheduler_kernel: Arc<SchedulerKernel>) -> Self {
        self.scheduler_kernel = Some(scheduler_kernel);
        self
    }

    pub fn store(&self) -> &Arc<S> {
        &self.store
    }
}

impl<S> ExecutionJobManager<S>
where
    S: ExecutionJobStore + ?Sized,
{
    /// Idempotently materializes the causal Action.  The Store rejects reuse of
    /// the same identity with different immutable content.
    pub async fn ensure(&self, spec: ExecutionJobSpec) -> ExecutionResult<ExecutionJobRecord> {
        self.store.create_execution_job(spec.into_new_job()?).await
    }

    pub async fn claim(
        &self,
        id: &str,
        expected_revision: u64,
        claim: JobClaim<'_>,
    ) -> ExecutionResult<JobReceipt> {
        let mutation = self
            .store
            .claim_execution_job(
                id,
                expected_revision,
                claim.worker_id,
                claim.claim_token,
                claim.lease_expires_at,
                claim.approval_ref,
            )
            .await?;
        Ok(JobReceipt::from_mutation(JobOperation::Claim, mutation))
    }

    pub async fn heartbeat(
        &self,
        id: &str,
        expected_revision: u64,
        heartbeat: JobHeartbeat<'_>,
    ) -> ExecutionResult<JobReceipt> {
        let mutation = self
            .store
            .heartbeat_execution_job(
                id,
                expected_revision,
                heartbeat.claim_token,
                heartbeat.lease_expires_at,
                heartbeat.side_effect_started_at,
                heartbeat.progress_ref,
            )
            .await?;
        Ok(JobReceipt::from_mutation(JobOperation::Heartbeat, mutation))
    }

    pub async fn requeue(&self, id: &str, expected_revision: u64) -> ExecutionResult<JobReceipt> {
        let mutation = self
            .store
            .requeue_execution_job(id, expected_revision)
            .await?;
        Ok(JobReceipt::from_mutation(JobOperation::Requeue, mutation))
    }

    pub async fn request_cancel(
        &self,
        id: &str,
        expected_revision: u64,
        reason: Option<&str>,
    ) -> ExecutionResult<JobReceipt> {
        let mutation = self
            .store
            .request_cancel_execution_job(id, expected_revision, reason)
            .await?;
        Ok(JobReceipt::from_mutation(
            JobOperation::RequestCancel,
            mutation,
        ))
    }

    pub async fn finish(
        &self,
        id: &str,
        expected_revision: u64,
        claim_token: Option<&str>,
        outcome: JobOutcome,
    ) -> ExecutionResult<JobReceipt> {
        let terminal = outcome.into();
        let mutation = if let Some(kernel) = self.scheduler_kernel.as_ref() {
            commit_execution_job_outcome(
                kernel,
                id,
                expected_revision,
                claim_token,
                terminal,
                None,
                false,
            )
            .await?
        } else {
            self.store
                .finish_execution_job(id, expected_revision, claim_token, terminal)
                .await?
        };
        Ok(JobReceipt::from_mutation(JobOperation::Finish, mutation))
    }

    pub async fn finish_with_event(
        &self,
        id: &str,
        expected_revision: u64,
        claim_token: Option<&str>,
        outcome: JobOutcome,
        event: &Event,
        wake_thread: bool,
    ) -> ExecutionResult<JobReceipt> {
        let terminal = outcome.into();
        let mutation = if let Some(kernel) = self.scheduler_kernel.as_ref() {
            commit_execution_job_outcome(
                kernel,
                id,
                expected_revision,
                claim_token,
                terminal,
                Some(event.clone()),
                wake_thread,
            )
            .await?
        } else {
            self.store
                .finish_execution_job_with_event(
                    id,
                    expected_revision,
                    claim_token,
                    terminal,
                    event,
                    wake_thread,
                )
                .await?
        };
        Ok(JobReceipt::from_mutation(JobOperation::Finish, mutation))
    }

    pub async fn reconcile_observed_result(
        &self,
        id: &str,
        expected_revision: u64,
        outcome: JobOutcome,
        event: &Event,
        wake_thread: bool,
    ) -> ExecutionResult<JobReceipt> {
        let mutation = self
            .store
            .reconcile_execution_job_from_event(
                id,
                expected_revision,
                outcome.into(),
                event,
                wake_thread,
            )
            .await?;
        Ok(JobReceipt::from_mutation(
            JobOperation::ReconcileObservedResult,
            mutation,
        ))
    }

    /// Reconciles non-terminal Jobs when one Runtime process starts.
    ///
    /// An exclusive Store knows every previously running worker disappeared.
    /// A shared Store may still have healthy peers, so only expired/unleased
    /// running Jobs cross the recovery boundary. Queued and approval-waiting
    /// Jobs remain durable in both modes.
    pub async fn reconcile_startup<E: EventStore + ?Sized>(
        &self,
        coordination: WorkerCoordinationMode,
        events: &E,
        action_groups: Option<&dyn ActionGroupStore>,
    ) -> ExecutionResult<RestartReconcileReport> {
        let jobs = self
            .store
            .list_execution_jobs(ExecutionJobFilter::default())
            .await?;
        let mut report = RestartReconcileReport::default();
        let now = chrono::Utc::now();

        for job in jobs {
            let action_group_id = action_group_id_for_job(action_groups, &job).await?;
            let direct_wake = direct_thread_wake_for_job(&job, action_group_id.as_deref())?;
            if let Some(event) = durable_result_event_for_job(events, &job).await? {
                let outcome = observed_job_outcome(&event);
                let wake_policy = event
                    .payload
                    .get("wake_policy")
                    .and_then(serde_json::Value::as_str);
                let wake_thread =
                    direct_wake && !matches!(wake_policy, Some("none" | "delegation_result"));
                let receipt = self
                    .reconcile_observed_result(&job.id, job.revision, outcome, &event, wake_thread)
                    .await?;
                match &receipt {
                    JobReceipt::Applied { .. } | JobReceipt::Existing { .. } => {
                        report.recovered_receipts.push(receipt);
                        continue;
                    }
                    JobReceipt::Conflict { current, .. } if current.status.is_terminal() => {
                        report.preserved_job_ids.push(current.id.clone());
                        continue;
                    }
                    JobReceipt::Rejected {
                        current, reason, ..
                    } => {
                        return Err(format!(
                            "Execution Job '{}' 已有持久化结果 Event '{}'，但启动恢复被拒绝（{}）：{}",
                            current.id,
                            event.id,
                            current.status.as_str(),
                            reason
                        )
                        .into());
                    }
                    JobReceipt::Conflict { current, .. } => {
                        return Err(format!(
                            "Execution Job '{}' 从持久化结果 Event '{}' 恢复时发生 revision 冲突（当前 r{} / {}）",
                            current.id,
                            event.id,
                            current.revision,
                            current.status.as_str()
                        )
                        .into());
                    }
                    JobReceipt::NotFound { .. } => continue,
                }
            }
            if same_host_cancelled_background_exit_is_proven(&job, coordination) {
                let reason = "cancellation was requested and the owning host confirms that the managed process group no longer exists";
                let event = restart_cancelled_background_event(&job, reason);
                let result_refs = job
                    .request
                    .get("artifact_path")
                    .and_then(serde_json::Value::as_str)
                    .map(ToOwned::to_owned)
                    .into_iter()
                    .collect::<Vec<_>>();
                let receipt = self
                    .finish_with_event(
                        &job.id,
                        job.revision,
                        None,
                        JobOutcome::Cancelled {
                            result_event_id: Some(event.id.clone()),
                            result_refs,
                            reason: Some(reason.to_string()),
                            exit_code: None,
                        },
                        &event,
                        false,
                    )
                    .await?;
                match &receipt {
                    JobReceipt::Applied { .. } | JobReceipt::Existing { .. } => {
                        report.recovered_receipts.push(receipt);
                        continue;
                    }
                    JobReceipt::Conflict { current, .. } if current.status.is_terminal() => {
                        report.preserved_job_ids.push(current.id.clone());
                        continue;
                    }
                    JobReceipt::Rejected {
                        current, reason, ..
                    } => {
                        return Err(format!(
                            "Execution Job '{}' 的本地进程组已经消失，但 cancelled 恢复被拒绝（{}）：{}",
                            current.id,
                            current.status.as_str(),
                            reason
                        )
                        .into());
                    }
                    JobReceipt::Conflict { current, .. } => {
                        return Err(format!(
                            "Execution Job '{}' 的本地进程组已经消失，但 cancelled 恢复发生 revision 冲突（当前 r{} / {}）",
                            current.id,
                            current.revision,
                            current.status.as_str()
                        )
                        .into());
                    }
                    JobReceipt::NotFound { .. } => continue,
                }
            }
            let plan = startup_recovery_plan(&job, coordination, now);
            match &plan.action {
                RestartAction::Preserve => report.preserved_job_ids.push(job.id),
                RestartAction::Requeue { .. } => {
                    report
                        .requeue_receipts
                        .push(self.requeue(&job.id, job.revision).await?);
                }
                RestartAction::MarkLost { reason } => {
                    let wake_thread = direct_wake;
                    let event =
                        restart_lost_event(&job, reason, action_group_id.as_deref(), wake_thread);
                    let mutation = self
                        .store
                        .finish_execution_job_with_event(
                            &job.id,
                            job.revision,
                            None,
                            JobOutcome::Lost {
                                result_event_id: Some(event.id.clone()),
                                reason: reason.clone(),
                            }
                            .into(),
                            &event,
                            wake_thread,
                        )
                        .await?;
                    report.lost_receipts.push(JobReceipt::from_mutation(
                        JobOperation::ReconcileLost,
                        mutation,
                    ));
                }
            }
        }

        Ok(report)
    }
}

fn direct_thread_wake_for_job(
    job: &ExecutionJobRecord,
    action_group_id: Option<&str>,
) -> ExecutionResult<bool> {
    if action_group_id.is_some()
        || job.tool_name == crate::artifact::ARTIFACT_TRANSFER_TOOL_NAME
        || job.tool_name == "exec/background"
    {
        return Ok(false);
    }
    match job.request.get("_morphz_wake_thread") {
        Some(serde_json::Value::Bool(value)) => Ok(*value),
        Some(_) => Err(format!(
            "Execution Job '{}' 的 _morphz_wake_thread 不是 boolean",
            job.id
        )
        .into()),
        // Legacy ordinary physical Jobs predate the explicit join marker.
        // Their only supported non-direct routes had stable dedicated tool
        // names handled above; preserve the old standalone continuation.
        None => Ok(true),
    }
}

/// SQLite workers share one physical host, so the operating system can close
/// the restart gap for a cancelled managed process without waiting for a stale
/// database lease. Distributed stores deliberately skip this probe: a local
/// `ESRCH` says nothing about a process owned by another machine.
fn same_host_cancelled_background_exit_is_proven(
    job: &ExecutionJobRecord,
    coordination: WorkerCoordinationMode,
) -> bool {
    if coordination != WorkerCoordinationMode::SharedHostLeases
        || job.status != ExecutionJobStatus::Running
        || job.cancel_requested_at.is_none()
        || job.tool_name != "exec/background"
    {
        return false;
    }
    let Some(process_group_id) = job
        .request
        .get("process_group_id")
        .and_then(serde_json::Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
        .filter(|value| *value > 0)
    else {
        return false;
    };
    #[cfg(unix)]
    {
        matches!(
            nix::sys::signal::killpg(nix::unistd::Pid::from_raw(process_group_id), None),
            Err(nix::errno::Errno::ESRCH)
        )
    }
    #[cfg(not(unix))]
    {
        let _ = process_group_id;
        false
    }
}

async fn action_group_id_for_job(
    groups: Option<&dyn ActionGroupStore>,
    job: &ExecutionJobRecord,
) -> ExecutionResult<Option<String>> {
    if let Some(group_id) = job
        .request
        .get("_morphz_action_group_id")
        .and_then(serde_json::Value::as_str)
    {
        if group_id.trim().is_empty() {
            return Err(format!("Execution Job '{}' 的 Action Group route 为空", job.id).into());
        }
        return Ok(Some(group_id.to_string()));
    }
    let Some(groups) = groups else {
        return Ok(None);
    };
    let candidates = groups
        .list_action_groups(ActionGroupFilter {
            activation_id: Some(job.activation_id.clone()),
            include_terminal: true,
            ..Default::default()
        })
        .await?;
    let mut matches = Vec::new();
    for group in candidates {
        if groups
            .list_action_group_members(&group.id)
            .await?
            .iter()
            .any(|member| {
                member.execution_job_id.as_deref() == Some(job.id.as_str())
                    || (member.execution_job_id.is_none()
                        && member.tool_call_id == job.tool_call_id
                        && member.tool_name == job.tool_name)
            })
        {
            matches.push(group.id);
        }
    }
    match matches.as_slice() {
        [] => Ok(None),
        [group_id] => Ok(Some(group_id.clone())),
        _ => Err(format!(
            "Execution Job '{}' 匹配到多个 Action Group：{}",
            job.id,
            matches.join(", ")
        )
        .into()),
    }
}

async fn commit_execution_job_outcome(
    kernel: &SchedulerKernel,
    id: &str,
    expected_revision: u64,
    claim_token: Option<&str>,
    outcome: ExecutionJobTerminal,
    event: Option<Event>,
    wake_thread: bool,
) -> ExecutionResult<ExecutionJobMutation> {
    let result = kernel
        .execute(crate::controllers::ExecutionController::commit_job_outcome(
            id,
            expected_revision,
            claim_token,
            outcome,
            event,
            wake_thread,
            "Execution-Job-Manager",
        ))
        .await?;
    match result {
        KernelResult::ExecutionJobOutcomeCommitted(mutation) => Ok(mutation),
        other => Err(format!("Execution Job Kernel 返回意外结果：{other:?}").into()),
    }
}

async fn durable_result_event_for_job<E: EventStore + ?Sized>(
    events: &E,
    job: &ExecutionJobRecord,
) -> ExecutionResult<Option<Event>> {
    if job.status.is_terminal() {
        return Ok(None);
    }
    let event_id = format!("output_{}_{}", job.activation_id, job.tool_call_id);
    let mut matches = events
        .query(QueryFilter {
            event_id: Some(event_id.clone()),
            ..Default::default()
        })
        .await?;
    if matches.is_empty() {
        return Ok(None);
    }
    if matches.len() != 1 {
        return Err(format!(
            "Execution Job '{}' 的确定性结果 Event '{}' 数量异常：{}",
            job.id,
            event_id,
            matches.len()
        )
        .into());
    }
    let event = matches.remove(0);
    let payload_str = |key: &str| event.payload.get(key).and_then(serde_json::Value::as_str);
    let identity_matches = event.event_type == TYPE_TOOL_OUTPUT
        && event.topic == "chat/tool_output"
        && payload_str("context_id") == Some(job.context_id.as_str())
        && payload_str("session_id") == Some(job.session_id.as_str())
        && payload_str("activation_id") == Some(job.activation_id.as_str())
        && payload_str("thread_id") == Some(job.thread_id.as_str())
        && payload_str("tool_call_id") == Some(job.tool_call_id.as_str())
        && payload_str("tool_name") == Some(job.tool_name.as_str());
    if !identity_matches {
        return Err(format!(
            "Execution Job '{}' 的确定性结果 Event '{}' 因果身份不匹配；拒绝猜测恢复",
            job.id, event.id
        )
        .into());
    }
    Ok(Some(event))
}

fn observed_job_outcome(event: &Event) -> JobOutcome {
    let status = event
        .payload
        .get("tool_status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("error");
    let text = event
        .payload
        .get("text")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("工具结果 Event 没有提供文本")
        .to_string();
    let exit_code = event
        .payload
        .get("exit_code")
        .and_then(serde_json::Value::as_i64)
        .and_then(|value| i32::try_from(value).ok());
    let result_refs = event
        .payload
        .get("artifact_path")
        .and_then(serde_json::Value::as_str)
        .map(|value| vec![value.to_string()])
        .unwrap_or_default();
    match status {
        "success" | "succeeded" | "guarded" => JobOutcome::Succeeded {
            result_event_id: Some(event.id.clone()),
            result_refs,
            exit_code,
        },
        "cancelled" => JobOutcome::Cancelled {
            result_event_id: Some(event.id.clone()),
            result_refs,
            reason: Some(text),
            exit_code,
        },
        "lost" => JobOutcome::Lost {
            result_event_id: Some(event.id.clone()),
            reason: text,
        },
        _ => JobOutcome::Failed {
            result_event_id: Some(event.id.clone()),
            result_refs,
            error: text,
            exit_code,
        },
    }
}

fn restart_lost_event(
    job: &ExecutionJobRecord,
    reason: &str,
    action_group_id: Option<&str>,
    wake_thread: bool,
) -> Event {
    let mut payload = serde_json::Map::from_iter([
        ("context_id".to_string(), serde_json::json!(job.context_id)),
        ("session_id".to_string(), serde_json::json!(job.session_id)),
        (
            "attempt_id".to_string(),
            serde_json::json!(job.activation_id),
        ),
        (
            "activation_id".to_string(),
            serde_json::json!(job.activation_id),
        ),
        ("thread_id".to_string(), serde_json::json!(job.thread_id)),
        (
            "tool_call_id".to_string(),
            serde_json::json!(job.tool_call_id),
        ),
        ("caused_by".to_string(), serde_json::json!(job.tool_call_id)),
        ("tool_name".to_string(), serde_json::json!(job.tool_name)),
        ("tool_status".to_string(), serde_json::json!("lost")),
        (
            "wake_policy".to_string(),
            serde_json::json!(if wake_thread { "immediate" } else { "none" }),
        ),
        ("output_empty".to_string(), serde_json::json!(false)),
        ("text".to_string(), serde_json::json!(reason)),
    ]);
    if let Some(group_id) = action_group_id {
        payload.insert("action_group_id".to_string(), serde_json::json!(group_id));
    }
    Event::new(
        format!("output_{}_{}", job.activation_id, job.tool_call_id),
        "Runtime-ExecutionReconciler".to_string(),
        TYPE_TOOL_OUTPUT.to_string(),
        "chat/tool_output".to_string(),
        payload,
    )
}

fn restart_cancelled_background_event(job: &ExecutionJobRecord, reason: &str) -> Event {
    let mut payload = serde_json::Map::from_iter([
        ("context_id".to_string(), serde_json::json!(job.context_id)),
        ("session_id".to_string(), serde_json::json!(job.session_id)),
        (
            "attempt_id".to_string(),
            serde_json::json!(job.activation_id),
        ),
        (
            "activation_id".to_string(),
            serde_json::json!(job.activation_id),
        ),
        ("thread_id".to_string(), serde_json::json!(job.thread_id)),
        (
            "tool_call_id".to_string(),
            serde_json::json!(job.tool_call_id),
        ),
        ("caused_by".to_string(), serde_json::json!(job.tool_call_id)),
        ("tool_name".to_string(), serde_json::json!(job.tool_name)),
        ("tool_status".to_string(), serde_json::json!("cancelled")),
        ("wake_policy".to_string(), serde_json::json!("none")),
        ("output_empty".to_string(), serde_json::json!(false)),
        ("task_id".to_string(), serde_json::json!(job.id)),
        ("task_status".to_string(), serde_json::json!("cancelled")),
        ("process_status".to_string(), serde_json::json!("cancelled")),
        ("text".to_string(), serde_json::json!(reason)),
    ]);
    if let Some(effective_boundary) = job.request.get("effective_boundary") {
        payload.insert("effective_boundary".to_string(), effective_boundary.clone());
    }
    if let Some(artifact_path) = job.request.get("artifact_path") {
        payload.insert("artifact_path".to_string(), artifact_path.clone());
    }
    Event::new(
        format!("background_output_{}", job.id),
        "Runtime-ExecutionReconciler".to_string(),
        TYPE_TOOL_OUTPUT.to_string(),
        "chat/tool_output".to_string(),
        payload,
    )
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};
    use serde_json::json;

    use super::*;

    fn sample_job(status: ExecutionJobStatus, safety: ExecutionRetrySafety) -> ExecutionJobRecord {
        let now = Utc
            .with_ymd_and_hms(2026, 7, 17, 8, 0, 0)
            .single()
            .expect("valid timestamp");
        ExecutionJobRecord {
            id: "job_1".to_string(),
            revision: 3,
            activation_id: "activation_1".to_string(),
            thread_id: "thread_1".to_string(),
            agent_id: "agent_1".to_string(),
            context_id: "context_1".to_string(),
            session_id: "session_1".to_string(),
            initiating_principal_id: None,
            target_id: crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
            tool_call_id: "call_1".to_string(),
            tool_name: "exec".to_string(),
            request: json!({"command": "true"}),
            status,
            retry_safety: safety,
            claimed_by: None,
            claim_token: None,
            lease_expires_at: None,
            heartbeat_at: None,
            approval_ref: None,
            side_effect_started_at: None,
            cancel_requested_at: None,
            cancel_reason: None,
            progress_ref: None,
            result_event_id: None,
            result_refs: Vec::new(),
            error: None,
            exit_code: None,
            created_at: now,
            started_at: None,
            updated_at: now,
            finished_at: None,
        }
    }

    #[test]
    fn deterministic_id_is_stable_and_tuple_unambiguous() {
        let first = deterministic_job_id("ab", "c").expect("valid identity");
        assert_eq!(
            first,
            deterministic_job_id("ab", "c").expect("valid identity")
        );
        assert_ne!(
            first,
            deterministic_job_id("a", "bc").expect("valid identity")
        );
        assert!(first.starts_with("job_"));
        assert_eq!(first.len(), 4 + 64);
    }

    #[test]
    fn deterministic_id_rejects_empty_causal_parts() {
        assert!(deterministic_job_id(" ", "call").is_err());
        assert!(deterministic_job_id("activation", "").is_err());
    }

    #[test]
    fn queued_and_waiting_approval_survive_restart_unchanged() {
        for status in [
            ExecutionJobStatus::Queued,
            ExecutionJobStatus::WaitingApproval,
        ] {
            assert_eq!(
                restart_plan(&sample_job(status, ExecutionRetrySafety::AtMostOnce)).action,
                RestartAction::Preserve
            );
        }
    }

    #[test]
    fn clean_idempotent_running_job_requires_real_requeue_transition() {
        let plan = restart_plan(&sample_job(
            ExecutionJobStatus::Running,
            ExecutionRetrySafety::Idempotent,
        ));
        assert!(matches!(plan.action, RestartAction::Requeue { .. }));
    }

    #[test]
    fn idempotent_job_replays_after_side_effect_boundary() {
        let mut job = sample_job(
            ExecutionJobStatus::Running,
            ExecutionRetrySafety::Idempotent,
        );
        job.side_effect_started_at = Some(job.updated_at);
        assert!(matches!(
            restart_plan(&job).action,
            RestartAction::Requeue { .. }
        ));
    }

    #[test]
    fn every_uncancelled_job_replays_before_recorded_boundary() {
        for safety in [
            ExecutionRetrySafety::ReconcileRequired,
            ExecutionRetrySafety::AtMostOnce,
        ] {
            assert!(matches!(
                restart_plan(&sample_job(ExecutionJobStatus::Running, safety)).action,
                RestartAction::Requeue { .. }
            ));
        }
    }

    #[test]
    fn non_idempotent_job_is_lost_after_recorded_boundary() {
        for safety in [
            ExecutionRetrySafety::ReconcileRequired,
            ExecutionRetrySafety::AtMostOnce,
        ] {
            let mut job = sample_job(ExecutionJobStatus::Running, safety);
            job.side_effect_started_at = Some(job.updated_at);
            assert!(matches!(
                restart_plan(&job).action,
                RestartAction::MarkLost { .. }
            ));
        }
    }

    #[test]
    fn cancel_requested_running_job_is_not_replayed() {
        let mut job = sample_job(
            ExecutionJobStatus::Running,
            ExecutionRetrySafety::Idempotent,
        );
        job.cancel_requested_at = Some(job.updated_at);
        assert!(matches!(
            restart_plan(&job).action,
            RestartAction::MarkLost { .. }
        ));
    }

    #[test]
    fn shared_worker_startup_preserves_another_workers_live_lease() {
        let now = Utc.with_ymd_and_hms(2026, 7, 17, 8, 0, 0).single().unwrap();
        let mut job = sample_job(
            ExecutionJobStatus::Running,
            ExecutionRetrySafety::Idempotent,
        );
        job.lease_expires_at = Some(now + chrono::Duration::seconds(30));
        assert_eq!(
            startup_recovery_plan(&job, WorkerCoordinationMode::SharedLeases, now).action,
            RestartAction::Preserve
        );
        assert!(matches!(
            startup_recovery_plan(&job, WorkerCoordinationMode::ExclusiveProcess, now).action,
            RestartAction::Requeue { .. }
        ));
    }

    #[test]
    fn shared_worker_startup_recovers_only_after_the_lease_expires() {
        let now = Utc.with_ymd_and_hms(2026, 7, 17, 8, 0, 0).single().unwrap();
        let mut job = sample_job(
            ExecutionJobStatus::Running,
            ExecutionRetrySafety::Idempotent,
        );
        job.lease_expires_at = Some(now - chrono::Duration::milliseconds(1));
        assert!(matches!(
            startup_recovery_plan(&job, WorkerCoordinationMode::SharedLeases, now).action,
            RestartAction::Requeue { .. }
        ));
    }

    #[test]
    fn same_host_absent_process_group_proves_cancelled_background_exit() {
        let mut job = sample_job(
            ExecutionJobStatus::Running,
            ExecutionRetrySafety::ReconcileRequired,
        );
        job.tool_name = "exec/background".to_string();
        job.cancel_requested_at = Some(job.updated_at);
        job.request = json!({ "process_group_id": i32::MAX });

        assert!(same_host_cancelled_background_exit_is_proven(
            &job,
            WorkerCoordinationMode::SharedHostLeases,
        ));
        assert!(!same_host_cancelled_background_exit_is_proven(
            &job,
            WorkerCoordinationMode::SharedLeases,
        ));

        let event = restart_cancelled_background_event(&job, "process group absent");
        assert_eq!(event.id, format!("background_output_{}", job.id));
        assert_eq!(event.payload["task_status"], "cancelled");
        assert_eq!(event.payload["wake_policy"], "none");
    }

    #[test]
    fn typed_outcome_preserves_empty_success_output() {
        let terminal: ExecutionJobTerminal = JobOutcome::Succeeded {
            result_event_id: Some("event_1".to_string()),
            result_refs: Vec::new(),
            exit_code: Some(0),
        }
        .into();
        assert_eq!(terminal.status, ExecutionJobStatus::Succeeded);
        assert_eq!(terminal.result_refs, Vec::<String>::new());
        assert_eq!(terminal.error, None);
    }

    #[test]
    fn mutation_mapping_keeps_conflict_typed() {
        let current = sample_job(
            ExecutionJobStatus::Running,
            ExecutionRetrySafety::AtMostOnce,
        );
        let receipt = JobReceipt::from_mutation(
            JobOperation::Heartbeat,
            ExecutionJobMutation::Conflict {
                current: current.clone(),
            },
        );
        assert_eq!(
            receipt,
            JobReceipt::Conflict {
                operation: JobOperation::Heartbeat,
                current,
            }
        );
    }

    #[test]
    fn lost_group_member_routes_only_through_the_group_barrier() {
        let job = sample_job(
            ExecutionJobStatus::Running,
            ExecutionRetrySafety::AtMostOnce,
        );
        let event = restart_lost_event(&job, "outcome unknown", Some("group-1"), false);
        assert_eq!(event.payload["action_group_id"], "group-1");
        assert_eq!(event.payload["wake_policy"], "none");
        assert_eq!(event.payload["tool_status"], "lost");
    }

    #[test]
    fn standalone_lost_job_retains_one_direct_wake_route() {
        let job = sample_job(
            ExecutionJobStatus::Running,
            ExecutionRetrySafety::AtMostOnce,
        );
        let event = restart_lost_event(&job, "outcome unknown", None, true);
        assert!(!event.payload.contains_key("action_group_id"));
        assert_eq!(event.payload["wake_policy"], "immediate");
    }

    #[test]
    fn explicit_join_marker_overrides_legacy_direct_wake_fallback() {
        let mut job = sample_job(
            ExecutionJobStatus::Running,
            ExecutionRetrySafety::AtMostOnce,
        );
        job.request["_morphz_wake_thread"] = json!(false);
        assert!(!direct_thread_wake_for_job(&job, None).expect("valid join marker"));

        job.request["_morphz_wake_thread"] = json!("false");
        assert!(direct_thread_wake_for_job(&job, None).is_err());
    }
}
