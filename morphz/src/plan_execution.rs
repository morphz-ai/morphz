//! Durable bridge between Typed Plan IR and the Scheduler Kernel.
//!
//! This module owns no tool implementation, model client, approval policy or
//! executor. It advances deterministic [`PlanMachine`] control state and asks
//! a host planner to map each physical `call` effect onto the existing
//! Execution Job domain. The Store then commits the child Job and suspended
//! Plan in one transaction.

use std::error::Error;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};

use crate::event::{Event, TYPE_INFER_REQUEST};
use crate::execution::deterministic_job_id;
use crate::memory::{
    ExecutionJobRecord, ExecutionJobStatus, NewExecutionJob, NewPlanExecution,
    PlanEvaluationCommit, PlanExecutionFilter, PlanExecutionMutation, PlanExecutionRecord,
    PlanExecutionStatus, PlanExecutionWaitKind, QueryFilter, RuntimeStore, ThreadActivationStatus,
};
use crate::sexpr_eval::{decode_infer_result, PlanAdvance, PlanEffect, PlanMachine, Program};
use crate::tool::Registry;

pub type PlanExecutionResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

const PLAN_ID_DOMAIN: &[u8] = b"morphz.plan-execution.v1\0";
const EFFECT_ID_DOMAIN: &[u8] = b"morphz.plan-effect.v1\0";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanExecutionRoute {
    pub activation_id: String,
    pub thread_id: String,
    pub agent_id: String,
    pub context_id: String,
    pub session_id: String,
    pub initiating_principal_id: Option<String>,
    pub tool_call_id: String,
    pub objective_id: Option<String>,
    pub objective_evaluation_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PlanArtifactBinding {
    pub harness_id: Option<String>,
    pub harness_version: Option<String>,
    pub source_artifact_hash: Option<String>,
}

/// The only policy seam between Plan control and physical scheduling.
///
/// Implementations belong to the Orchestrator. They resolve Target, approval
/// requirement and retry safety, but do not create or claim the Job. Returning
/// a [`NewExecutionJob`] lets the coordinator validate deterministic identity
/// before the Store atomically materializes it with the Plan wait state.
#[async_trait::async_trait]
pub trait PlanCallPlanner: Send + Sync {
    async fn plan_call(
        &self,
        plan: &PlanExecutionRecord,
        effect: &PlanEffect,
        effect_tool_call_id: &str,
    ) -> PlanExecutionResult<NewExecutionJob>;
}

#[derive(Debug, Clone, PartialEq)]
pub enum PlanDriveReceipt {
    WaitingForExecutionJob {
        plan: PlanExecutionRecord,
        job: Box<ExecutionJobRecord>,
        existing: bool,
    },
    WaitingForEvaluation {
        plan: PlanExecutionRecord,
        request_event: Box<Event>,
        activation_id: String,
        existing: bool,
    },
    Succeeded {
        plan: PlanExecutionRecord,
        value: JsonValue,
    },
    Failed {
        plan: PlanExecutionRecord,
        error: String,
    },
    Conflict {
        current: Option<PlanExecutionRecord>,
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum PlanResumeReceipt {
    Queued(PlanExecutionRecord),
    Existing(PlanExecutionRecord),
    Conflict {
        current: Option<PlanExecutionRecord>,
        reason: String,
    },
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct PlanReconciliationReport {
    pub resumed: Vec<PlanExecutionRecord>,
    pub still_waiting: Vec<String>,
    pub conflicts: Vec<(String, String)>,
}

pub struct PlanExecutionCoordinator {
    store: Arc<dyn RuntimeStore>,
    registry: Arc<Registry>,
}

impl PlanExecutionCoordinator {
    pub fn new(store: Arc<dyn RuntimeStore>, registry: Arc<Registry>) -> Self {
        Self { store, registry }
    }

    pub fn store(&self) -> &Arc<dyn RuntimeStore> {
        &self.store
    }

    /// Creates the durable Plan identity and initial serializable machine.
    ///
    /// Repeating the same outer Function Call with the same program is
    /// idempotent. A different program under the same causal identity is
    /// rejected by the Store.
    pub async fn ensure(
        &self,
        route: PlanExecutionRoute,
        program: &Program,
        binding: PlanArtifactBinding,
    ) -> PlanExecutionResult<PlanExecutionRecord> {
        let id = deterministic_plan_execution_id(&route.activation_id, &route.tool_call_id)?;
        let machine = PlanMachine::new(program)?;
        let program_json = serde_json::to_value(program)?;
        let state_json = serde_json::to_value(&machine)?;
        let budget_json = machine.budget_json()?;
        let source_artifact_hash = binding.source_artifact_hash.unwrap_or_else(|| {
            format!(
                "sha256:{:x}",
                Sha256::digest(serde_json::to_vec(&program_json).unwrap_or_default())
            )
        });
        self.store
            .create_plan_execution(NewPlanExecution {
                id,
                activation_id: route.activation_id,
                thread_id: route.thread_id,
                agent_id: route.agent_id,
                context_id: route.context_id,
                session_id: route.session_id,
                initiating_principal_id: route.initiating_principal_id,
                tool_call_id: route.tool_call_id,
                objective_id: route.objective_id,
                objective_evaluation_id: route.objective_evaluation_id,
                harness_id: binding.harness_id,
                harness_version: binding.harness_version,
                source_artifact_hash,
                ir_schema_version: 1,
                program_json,
                state_json,
                budget_json,
            })
            .await
    }

    /// Claims and advances one Plan until the next durable boundary.
    ///
    /// `call` is handed to the existing Execution Job plane. `infer` appends a
    /// routed immutable request and suspends behind the child Activation the
    /// Scheduler derives from that request.
    pub async fn drive_once(
        &self,
        plan_id: &str,
        expected_revision: u64,
        worker_id: &str,
        claim_token: &str,
        lease_expires_at: DateTime<Utc>,
        planner: &dyn PlanCallPlanner,
    ) -> PlanExecutionResult<PlanDriveReceipt> {
        let claimed = self
            .store
            .claim_plan_execution(
                plan_id,
                expected_revision,
                worker_id,
                claim_token,
                lease_expires_at,
            )
            .await?;
        let running = match claimed {
            PlanExecutionMutation::Updated(record) | PlanExecutionMutation::Existing(record) => {
                record
            }
            PlanExecutionMutation::Conflict { current } => {
                return Ok(PlanDriveReceipt::Conflict {
                    current: Some(current),
                    reason: "PlanExecution claim revision 冲突".to_string(),
                })
            }
            PlanExecutionMutation::Rejected { current, reason } => {
                return Ok(PlanDriveReceipt::Conflict { current, reason })
            }
            PlanExecutionMutation::NotFound => {
                return Ok(PlanDriveReceipt::Conflict {
                    current: None,
                    reason: format!("PlanExecution '{plan_id}' 不存在"),
                })
            }
        };

        let advance: PlanExecutionResult<PlanDriveReceipt> = async {
            let mut machine: PlanMachine = serde_json::from_value(running.state_json.clone())
                .map_err(|error| {
                    format!("PlanExecution '{}' state 无法恢复: {error}", running.id)
                })?;
            match machine.advance(&self.registry) {
                PlanAdvance::Suspended(effect @ PlanEffect::Call { sequence, .. }) => {
                    let state_json = serde_json::to_value(&machine)?;
                    let budget_json = machine.budget_json()?;
                    let effect_tool_call_id = deterministic_plan_effect_id(&running.id, sequence)?;
                    let job = match planner
                        .plan_call(&running, &effect, &effect_tool_call_id)
                        .await
                    {
                        Ok(job) => job,
                        Err(error) => {
                            let message = format!("Yao call 规划失败: {error}");
                            let mutation = self
                                .store
                                .finish_plan_execution(
                                    &running.id,
                                    running.revision,
                                    claim_token,
                                    PlanExecutionStatus::Failed,
                                    &state_json,
                                    &budget_json,
                                    None,
                                    Some(&message),
                                )
                                .await?;
                            let plan = updated_or_conflict(mutation, "fail call planning")?;
                            return Ok(PlanDriveReceipt::Failed {
                                plan,
                                error: message,
                            });
                        }
                    };
                    if let Err(error) =
                        validate_planned_job(&running, &effect, &effect_tool_call_id, &job)
                    {
                        let message = format!("Yao call 规划结果非法: {error}");
                        let mutation = self
                            .store
                            .finish_plan_execution(
                                &running.id,
                                running.revision,
                                claim_token,
                                PlanExecutionStatus::Failed,
                                &state_json,
                                &budget_json,
                                None,
                                Some(&message),
                            )
                            .await?;
                        let plan = updated_or_conflict(mutation, "fail invalid call planning")?;
                        return Ok(PlanDriveReceipt::Failed {
                            plan,
                            error: message,
                        });
                    }
                    let committed = self
                        .store
                        .create_execution_job_and_suspend_plan(
                            &running.id,
                            running.revision,
                            claim_token,
                            &state_json,
                            &budget_json,
                            job,
                        )
                        .await?;
                    Ok(PlanDriveReceipt::WaitingForExecutionJob {
                        plan: committed.plan,
                        job: Box::new(committed.execution_job),
                        existing: committed.existing,
                    })
                }
                PlanAdvance::Suspended(effect @ PlanEffect::Infer { sequence, .. }) => {
                    let state_json = serde_json::to_value(&machine)?;
                    let budget_json = machine.budget_json()?;
                    let request_event = infer_request_event(&running, &effect)?;
                    let activation_id = deterministic_infer_activation_id(&request_event.id)?;
                    let committed: PlanEvaluationCommit = self
                        .store
                        .create_evaluation_and_suspend_plan(
                            &running.id,
                            running.revision,
                            claim_token,
                            &state_json,
                            &budget_json,
                            &request_event,
                            &activation_id,
                        )
                        .await?;
                    debug_assert_eq!(
                        deterministic_plan_effect_id(&running.id, sequence)?,
                        request_event
                            .payload
                            .get("plan_effect_id")
                            .and_then(JsonValue::as_str)
                            .unwrap_or_default()
                    );
                    Ok(PlanDriveReceipt::WaitingForEvaluation {
                        plan: committed.plan,
                        request_event: Box::new(committed.request_event),
                        activation_id: committed.activation_id,
                        existing: committed.existing,
                    })
                }
                PlanAdvance::Complete(value) => {
                    let state_json = serde_json::to_value(&machine)?;
                    let budget_json = machine.budget_json()?;
                    let mutation = self
                        .store
                        .finish_plan_execution(
                            &running.id,
                            running.revision,
                            claim_token,
                            PlanExecutionStatus::Succeeded,
                            &state_json,
                            &budget_json,
                            Some(&value),
                            None,
                        )
                        .await?;
                    let plan = updated_or_conflict(mutation, "complete")?;
                    Ok(PlanDriveReceipt::Succeeded { plan, value })
                }
                PlanAdvance::Failed(error) => {
                    let state_json = serde_json::to_value(&machine)?;
                    let budget_json = machine.budget_json()?;
                    let mutation = self
                        .store
                        .finish_plan_execution(
                            &running.id,
                            running.revision,
                            claim_token,
                            PlanExecutionStatus::Failed,
                            &state_json,
                            &budget_json,
                            None,
                            Some(&error.message),
                        )
                        .await?;
                    let plan = updated_or_conflict(mutation, "fail")?;
                    Ok(PlanDriveReceipt::Failed {
                        plan,
                        error: error.message,
                    })
                }
            }
        }
        .await;

        if let Err(error) = &advance {
            // A store error after claim (most commonly SQLITE_BUSY) used to
            // drop this Future while leaving the row `running` until its
            // lease expired. Release with the exact fence before propagating
            // the error, so replay can resume immediately and a stale worker
            // can never commit after a newer owner takes over.
            let release_deadline = running.lease_expires_at.unwrap_or_else(Utc::now);
            let mut delay = std::time::Duration::from_millis(25);
            loop {
                match self
                    .store
                    .release_plan_execution_claim(&running.id, running.revision, claim_token)
                    .await
                {
                    Ok(PlanExecutionMutation::Updated(requeued)) => {
                        tracing::warn!(
                                plan_execution_id = %requeued.id,
                                revision = requeued.revision,
                                %error,
                        event_code = "plan_execution.advance_failed_requeued",
                        "PlanExecution advance failed and was returned to queued under the claim fence"
                            );
                        break;
                    }
                    Ok(PlanExecutionMutation::Conflict { current })
                    | Ok(PlanExecutionMutation::Rejected {
                        current: Some(current),
                        ..
                    }) if current.status != PlanExecutionStatus::Running
                        || current.claim_token.as_deref() != Some(claim_token) =>
                    {
                        // A durable hand-off or a newer fenced owner already
                        // won. Never overwrite that authoritative state.
                        break;
                    }
                    Ok(PlanExecutionMutation::NotFound)
                    | Ok(PlanExecutionMutation::Rejected { current: None, .. }) => break,
                    Ok(PlanExecutionMutation::Existing(_))
                    | Ok(PlanExecutionMutation::Conflict { .. })
                    | Ok(PlanExecutionMutation::Rejected { .. }) => {
                        if Utc::now() >= release_deadline {
                            break;
                        }
                    }
                    Err(release_error) => {
                        if Utc::now() >= release_deadline {
                            tracing::error!(
                                    plan_execution_id = %running.id,
                                    %release_error,
                            event_code = "plan_execution.claim_release_failed",
                            "PlanExecution claim release kept failing after an error; waiting for lease recovery"
                                );
                            break;
                        }
                    }
                }
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(std::time::Duration::from_millis(500));
            }
        }
        advance
    }

    /// Requeues expired pure-control claims with their exact persisted fence.
    /// This is safe while the old Future still exists: clearing its token
    /// makes every later stale commit lose deterministically.
    pub async fn recover_expired_running(
        &self,
        context_id: Option<&str>,
        limit: usize,
    ) -> PlanExecutionResult<Vec<PlanExecutionRecord>> {
        let plans = self
            .store
            .list_plan_executions(PlanExecutionFilter {
                context_id: context_id.map(str::to_string),
                status: Some(PlanExecutionStatus::Running),
                include_terminal: false,
                limit: Some(limit.max(1)),
                ..PlanExecutionFilter::default()
            })
            .await?;
        let now = Utc::now();
        let mut recovered = Vec::new();
        for plan in plans {
            if !plan.lease_expires_at.is_some_and(|expiry| expiry <= now) {
                continue;
            }
            let Some(claim_token) = plan.claim_token.as_deref() else {
                continue;
            };
            match self
                .store
                .release_plan_execution_claim(&plan.id, plan.revision, claim_token)
                .await?
            {
                PlanExecutionMutation::Updated(plan) => recovered.push(plan),
                PlanExecutionMutation::Existing(_)
                | PlanExecutionMutation::Conflict { .. }
                | PlanExecutionMutation::Rejected { .. }
                | PlanExecutionMutation::NotFound => {}
            }
        }
        Ok(recovered)
    }

    /// Reconciles one terminal Execution Job into its exact suspended effect.
    ///
    /// The terminal Job is read from the authoritative Store and its route and
    /// deterministic identity are checked before caller-provided decoded
    /// output may enter the machine. Replaying after the Plan is already queued
    /// returns `Existing`.
    pub async fn resume_execution_job(
        &self,
        plan_id: &str,
        execution_job_id: &str,
        outcome: Result<JsonValue, String>,
    ) -> PlanExecutionResult<PlanResumeReceipt> {
        let Some(plan) = self.store.get_plan_execution(plan_id).await? else {
            return Ok(PlanResumeReceipt::Conflict {
                current: None,
                reason: format!("PlanExecution '{plan_id}' 不存在"),
            });
        };
        if plan.status != PlanExecutionStatus::Waiting
            || plan.pending_kind != Some(PlanExecutionWaitKind::ExecutionJob)
            || plan.pending_id.as_deref() != Some(execution_job_id)
        {
            return if matches!(
                plan.status,
                PlanExecutionStatus::Queued
                    | PlanExecutionStatus::Running
                    | PlanExecutionStatus::Succeeded
                    | PlanExecutionStatus::Failed
                    | PlanExecutionStatus::Cancelled
            ) {
                Ok(PlanResumeReceipt::Existing(plan))
            } else {
                Ok(PlanResumeReceipt::Conflict {
                    current: Some(plan),
                    reason: "PlanExecution 没有等待该 Execution Job".to_string(),
                })
            };
        }
        let job = self
            .store
            .get_execution_job(execution_job_id)
            .await?
            .ok_or_else(|| {
                format!(
                    "PlanExecution '{}' 引用的 Execution Job '{}' 不存在",
                    plan.id, execution_job_id
                )
            })?;
        validate_terminal_job_route(&plan, &job)?;

        let mut machine: PlanMachine = serde_json::from_value(plan.state_json.clone())
            .map_err(|error| format!("PlanExecution '{}' state 无法恢复: {error}", plan.id))?;
        let effect = machine.pending_effect().cloned().ok_or_else(|| {
            format!(
                "PlanExecution '{}' 等待 Job 但 machine 没有 effect",
                plan.id
            )
        })?;
        let PlanEffect::Call { sequence, .. } = effect else {
            return Err("PlanExecution 等待 Execution Job，但 pending effect 不是 call".into());
        };
        let expected_tool_call_id = deterministic_plan_effect_id(&plan.id, sequence)?;
        if job.tool_call_id != expected_tool_call_id
            || job.id != deterministic_job_id(&plan.activation_id, &expected_tool_call_id)?
        {
            return Err("Execution Job 与 Plan effect 的稳定身份不一致".into());
        }
        machine.resume_effect(sequence, normalize_job_outcome(&job, outcome))?;
        let state_json = serde_json::to_value(&machine)?;
        let budget_json = machine.budget_json()?;
        match self
            .store
            .resume_plan_execution(
                &plan.id,
                plan.revision,
                PlanExecutionWaitKind::ExecutionJob,
                execution_job_id,
                &state_json,
                &budget_json,
            )
            .await?
        {
            PlanExecutionMutation::Updated(record) | PlanExecutionMutation::Existing(record) => {
                Ok(PlanResumeReceipt::Queued(record))
            }
            PlanExecutionMutation::Conflict { current } => Ok(PlanResumeReceipt::Conflict {
                current: Some(current),
                reason: "PlanExecution result refill revision 冲突".to_string(),
            }),
            PlanExecutionMutation::Rejected { current, reason } => {
                Ok(PlanResumeReceipt::Conflict { current, reason })
            }
            PlanExecutionMutation::NotFound => Ok(PlanResumeReceipt::Conflict {
                current: None,
                reason: format!("PlanExecution '{}' 在 result refill 时消失", plan.id),
            }),
        }
    }

    /// Refills the exact suspended `infer` effect from one terminal child
    /// Activation.
    pub async fn resume_evaluation(
        &self,
        plan_id: &str,
        activation_id: &str,
        outcome: Result<JsonValue, String>,
    ) -> PlanExecutionResult<PlanResumeReceipt> {
        let Some(plan) = self.store.get_plan_execution(plan_id).await? else {
            return Ok(PlanResumeReceipt::Conflict {
                current: None,
                reason: format!("PlanExecution '{plan_id}' 不存在"),
            });
        };
        if plan.status != PlanExecutionStatus::Waiting
            || plan.pending_kind != Some(PlanExecutionWaitKind::Evaluation)
            || plan.pending_id.as_deref() != Some(activation_id)
        {
            return if matches!(
                plan.status,
                PlanExecutionStatus::Queued
                    | PlanExecutionStatus::Running
                    | PlanExecutionStatus::Succeeded
                    | PlanExecutionStatus::Failed
                    | PlanExecutionStatus::Cancelled
            ) {
                Ok(PlanResumeReceipt::Existing(plan))
            } else {
                Ok(PlanResumeReceipt::Conflict {
                    current: Some(plan),
                    reason: "PlanExecution 没有等待该 Evaluation".to_string(),
                })
            };
        }
        let activation = self
            .store
            .get_thread_activation(activation_id)
            .await?
            .ok_or_else(|| {
                format!(
                    "PlanExecution '{}' 引用的 child Activation '{}' 不存在",
                    plan.id, activation_id
                )
            })?;
        validate_terminal_evaluation_route(&plan, &activation)?;

        let mut machine: PlanMachine = serde_json::from_value(plan.state_json.clone())
            .map_err(|error| format!("PlanExecution '{}' state 无法恢复: {error}", plan.id))?;
        let effect = machine.pending_effect().cloned().ok_or_else(|| {
            format!(
                "PlanExecution '{}' 等待 Evaluation 但 machine 没有 effect",
                plan.id
            )
        })?;
        let PlanEffect::Infer {
            sequence, result, ..
        } = effect
        else {
            return Err("PlanExecution 等待 Evaluation，但 pending effect 不是 infer".into());
        };
        let request_event = infer_request_event(&plan, &effect)?;
        if deterministic_infer_activation_id(&request_event.id)? != activation.id {
            return Err("child Activation 与 Plan infer effect 的稳定身份不一致".into());
        }
        let outcome = match outcome {
            Ok(value) => decode_infer_result(result, value),
            Err(error) => Err(error),
        };
        machine.resume_effect(sequence, outcome)?;
        let state_json = serde_json::to_value(&machine)?;
        let budget_json = machine.budget_json()?;
        match self
            .store
            .resume_plan_execution(
                &plan.id,
                plan.revision,
                PlanExecutionWaitKind::Evaluation,
                activation_id,
                &state_json,
                &budget_json,
            )
            .await?
        {
            PlanExecutionMutation::Updated(record) | PlanExecutionMutation::Existing(record) => {
                Ok(PlanResumeReceipt::Queued(record))
            }
            PlanExecutionMutation::Conflict { current } => Ok(PlanResumeReceipt::Conflict {
                current: Some(current),
                reason: "PlanExecution infer result refill revision 冲突".to_string(),
            }),
            PlanExecutionMutation::Rejected { current, reason } => {
                Ok(PlanResumeReceipt::Conflict { current, reason })
            }
            PlanExecutionMutation::NotFound => Ok(PlanResumeReceipt::Conflict {
                current: None,
                reason: format!("PlanExecution '{}' 在 infer result refill 时消失", plan.id),
            }),
        }
    }

    /// Reads the authoritative child Activation/Thread outcome and refills the
    /// suspended Plan without relying on an in-process response channel.
    pub async fn reconcile_evaluation(
        &self,
        plan_id: &str,
        activation_id: &str,
    ) -> PlanExecutionResult<PlanResumeReceipt> {
        let activation = self
            .store
            .get_thread_activation(activation_id)
            .await?
            .ok_or_else(|| format!("child Activation '{activation_id}' 不存在"))?;
        if !activation.status.is_terminal() {
            return Ok(PlanResumeReceipt::Conflict {
                current: self.store.get_plan_execution(plan_id).await?,
                reason: format!(
                    "child Activation '{}' 当前为 {}，尚不能回填 PlanExecution",
                    activation.id,
                    activation.status.as_str()
                ),
            });
        }
        let outcome = self
            .durable_evaluation_outcome(plan_id, &activation)
            .await?;
        self.resume_evaluation(plan_id, activation_id, outcome)
            .await
    }

    /// Reads a terminal Job and its immutable result Event, then refills the
    /// exact suspended effect without trusting an in-process caller to carry
    /// the output across the crash boundary.
    pub async fn reconcile_execution_job(
        &self,
        plan_id: &str,
        execution_job_id: &str,
    ) -> PlanExecutionResult<PlanResumeReceipt> {
        let job = self
            .store
            .get_execution_job(execution_job_id)
            .await?
            .ok_or_else(|| format!("Execution Job '{execution_job_id}' 不存在"))?;
        if !job.status.is_terminal() {
            return Ok(PlanResumeReceipt::Conflict {
                current: self.store.get_plan_execution(plan_id).await?,
                reason: format!(
                    "Execution Job '{}' 当前为 {}，尚不能回填 PlanExecution",
                    job.id,
                    job.status.as_str()
                ),
            });
        }
        let outcome = self.durable_job_outcome(&job).await?;
        self.resume_execution_job(plan_id, execution_job_id, outcome)
            .await
    }

    /// Restart-safe bounded reconciliation. It only consumes authoritative
    /// terminal child facts; non-terminal children remain waiting and are
    /// left to the existing Execution Job recovery controller.
    pub async fn reconcile_waiting_execution_jobs(
        &self,
        context_id: Option<&str>,
        limit: usize,
    ) -> PlanExecutionResult<PlanReconciliationReport> {
        let plans = self
            .store
            .list_plan_executions(PlanExecutionFilter {
                context_id: context_id.map(str::to_string),
                status: Some(PlanExecutionStatus::Waiting),
                include_terminal: false,
                limit: Some(limit.max(1)),
                ..PlanExecutionFilter::default()
            })
            .await?;
        let mut report = PlanReconciliationReport::default();
        for plan in plans {
            if plan.pending_kind != Some(PlanExecutionWaitKind::ExecutionJob) {
                report.still_waiting.push(plan.id);
                continue;
            }
            let Some(job_id) = plan.pending_id.as_deref() else {
                report.conflicts.push((
                    plan.id,
                    "waiting(execution_job) 缺少 pending_id".to_string(),
                ));
                continue;
            };
            let Some(job) = self.store.get_execution_job(job_id).await? else {
                report
                    .conflicts
                    .push((plan.id, format!("引用的 Execution Job '{job_id}' 不存在")));
                continue;
            };
            if !job.status.is_terminal() {
                report.still_waiting.push(plan.id);
                continue;
            }
            match self.reconcile_execution_job(&plan.id, &job.id).await? {
                PlanResumeReceipt::Queued(record) | PlanResumeReceipt::Existing(record) => {
                    report.resumed.push(record);
                }
                PlanResumeReceipt::Conflict { reason, .. } => {
                    report.conflicts.push((plan.id, reason));
                }
            }
        }
        Ok(report)
    }

    /// Restart-safe bounded reconciliation for model-owned child Evaluations.
    pub async fn reconcile_waiting_evaluations(
        &self,
        context_id: Option<&str>,
        limit: usize,
    ) -> PlanExecutionResult<PlanReconciliationReport> {
        let plans = self
            .store
            .list_plan_executions(PlanExecutionFilter {
                context_id: context_id.map(str::to_string),
                status: Some(PlanExecutionStatus::Waiting),
                include_terminal: false,
                limit: Some(limit.max(1)),
                ..PlanExecutionFilter::default()
            })
            .await?;
        let mut report = PlanReconciliationReport::default();
        for plan in plans {
            if plan.pending_kind != Some(PlanExecutionWaitKind::Evaluation) {
                report.still_waiting.push(plan.id);
                continue;
            }
            let Some(activation_id) = plan.pending_id.as_deref() else {
                report
                    .conflicts
                    .push((plan.id, "waiting(evaluation) 缺少 pending_id".to_string()));
                continue;
            };
            let Some(activation) = self.store.get_thread_activation(activation_id).await? else {
                // The infer request and Outbox are committed atomically with
                // the Plan. A missing Activation may simply mean the router
                // has not materialized the durable request yet.
                report.still_waiting.push(plan.id);
                continue;
            };
            if !activation.status.is_terminal() {
                report.still_waiting.push(plan.id);
                continue;
            }
            // One logical infer Thread can span several Activations while the
            // model calls tools.  A successful Activation without a Thread
            // result only means that one step handed off to a successor; it
            // is not the terminal infer value.  Resolve the parent Plan from
            // the Thread outcome boundary, not from the first Activation.
            if activation.status == ThreadActivationStatus::Succeeded {
                let thread = self
                    .store
                    .get_thread_by_root(&activation.root_turn_id)
                    .await?;
                if thread.as_ref().is_some_and(|thread| {
                    thread.lifecycle == crate::memory::ThreadLifecycle::Open
                        && thread.result_event_id.is_none()
                }) {
                    report.still_waiting.push(plan.id);
                    continue;
                }
            }
            match self.reconcile_evaluation(&plan.id, &activation.id).await? {
                PlanResumeReceipt::Queued(record) | PlanResumeReceipt::Existing(record) => {
                    report.resumed.push(record);
                }
                PlanResumeReceipt::Conflict { reason, .. } => {
                    report.conflicts.push((plan.id, reason));
                }
            }
        }
        Ok(report)
    }

    async fn durable_evaluation_outcome(
        &self,
        plan_id: &str,
        activation: &crate::memory::ThreadActivationRecord,
    ) -> PlanExecutionResult<Result<JsonValue, String>> {
        match activation.status {
            ThreadActivationStatus::Succeeded => {
                let thread = self
                    .store
                    .get_thread_by_root(&activation.root_turn_id)
                    .await?
                    .ok_or_else(|| {
                        format!(
                            "child Activation '{}' 的 Thread '{}' 不存在",
                            activation.id, activation.root_turn_id
                        )
                    })?;
                if thread.executor_kind != "plan_infer"
                    || thread.executor_id.as_deref() != Some(plan_id)
                {
                    return Err(format!(
                        "child Thread '{}' 不属于 PlanExecution '{}'",
                        thread.id, plan_id
                    )
                    .into());
                }
                let event_id = thread.result_event_id.as_deref().ok_or_else(|| {
                    format!("child Thread '{}' 已完成但没有 result Event", thread.id)
                })?;
                let event = self
                    .store
                    .query(QueryFilter {
                        event_id: Some(event_id.to_string()),
                        context_id: Some(thread.context_id.clone()),
                        top_k: Some(1),
                        ..QueryFilter::default()
                    })
                    .await?
                    .into_iter()
                    .find(|event| event.id == event_id)
                    .ok_or_else(|| {
                        format!(
                            "child Thread '{}' 引用的结果 Event '{}' 不存在",
                            thread.id, event_id
                        )
                    })?;
                let value = event
                    .payload
                    .get("text")
                    .cloned()
                    .unwrap_or(JsonValue::Null);
                Ok(Ok(value))
            }
            ThreadActivationStatus::Failed => Ok(Err("child Evaluation 执行失败".to_string())),
            ThreadActivationStatus::Cancelled => Ok(Err("child Evaluation 已取消".to_string())),
            status => Err(format!(
                "child Activation '{}' 当前为 {}，不是可回填终态",
                activation.id,
                status.as_str()
            )
            .into()),
        }
    }

    async fn durable_job_outcome(
        &self,
        job: &ExecutionJobRecord,
    ) -> PlanExecutionResult<Result<JsonValue, String>> {
        match job.status {
            ExecutionJobStatus::Succeeded => {
                let Some(event_id) = job.result_event_id.as_deref() else {
                    // Empty physical output is a real successful result, not
                    // an absent completion signal.
                    return Ok(Ok(JsonValue::Null));
                };
                let mut events = self
                    .store
                    .query(QueryFilter {
                        event_id: Some(event_id.to_string()),
                        context_id: Some(job.context_id.clone()),
                        top_k: Some(1),
                        ..QueryFilter::default()
                    })
                    .await?;
                let event = events.pop().ok_or_else(|| {
                    format!(
                        "Execution Job '{}' 引用的结果 Event '{}' 不存在",
                        job.id, event_id
                    )
                })?;
                let value = match event.payload.get("text") {
                    Some(JsonValue::String(text)) if text.trim().is_empty() => JsonValue::Null,
                    Some(JsonValue::String(text)) => serde_json::from_str(text)
                        .unwrap_or_else(|_| JsonValue::String(text.clone())),
                    Some(value) => value.clone(),
                    None => JsonValue::Null,
                };
                Ok(Ok(value))
            }
            ExecutionJobStatus::Failed => Ok(Err(job
                .error
                .clone()
                .unwrap_or_else(|| "Execution Job 执行失败".to_string()))),
            ExecutionJobStatus::Cancelled => Ok(Err(job
                .error
                .clone()
                .unwrap_or_else(|| "Execution Job 已取消".to_string()))),
            ExecutionJobStatus::Lost => Ok(Err(job
                .error
                .clone()
                .unwrap_or_else(|| "Execution Job 执行事实不确定".to_string()))),
            status => Err(format!(
                "Execution Job '{}' 当前为 {}，不是可回填终态",
                job.id,
                status.as_str()
            )
            .into()),
        }
    }
}

pub fn deterministic_plan_execution_id(
    activation_id: &str,
    tool_call_id: &str,
) -> PlanExecutionResult<String> {
    stable_id(PLAN_ID_DOMAIN, "plan", activation_id, tool_call_id)
}

pub fn deterministic_plan_effect_id(
    plan_execution_id: &str,
    sequence: u64,
) -> PlanExecutionResult<String> {
    stable_id(
        EFFECT_ID_DOMAIN,
        "plan_effect",
        plan_execution_id,
        &sequence.to_string(),
    )
}

fn infer_request_event(
    plan: &PlanExecutionRecord,
    effect: &PlanEffect,
) -> PlanExecutionResult<Event> {
    let PlanEffect::Infer {
        sequence,
        request,
        tools,
        result,
    } = effect
    else {
        return Err("只有 infer effect 能生成内部求值请求".into());
    };
    let effect_id = deterministic_plan_effect_id(&plan.id, *sequence)?;
    let event_id = stable_id(
        b"morphz.plan-infer-request.v1\0",
        "infer_request",
        &plan.id,
        &sequence.to_string(),
    )?;
    let root_turn_id = event_id.clone();
    let mut payload = serde_json::Map::from_iter([
        ("agent_id".to_string(), JsonValue::String(plan.agent_id.clone())),
        (
            "context_id".to_string(),
            JsonValue::String(plan.context_id.clone()),
        ),
        (
            "session_id".to_string(),
            JsonValue::String(plan.session_id.clone()),
        ),
        (
            "root_turn_id".to_string(),
            JsonValue::String(root_turn_id),
        ),
        (
            "parent_activation_id".to_string(),
            JsonValue::String(plan.activation_id.clone()),
        ),
        (
            "parent_thread_id".to_string(),
            JsonValue::String(plan.thread_id.clone()),
        ),
        (
            "plan_execution_id".to_string(),
            JsonValue::String(plan.id.clone()),
        ),
        (
            "plan_effect_id".to_string(),
            JsonValue::String(effect_id),
        ),
        (
            "plan_effect_sequence".to_string(),
            JsonValue::from(*sequence),
        ),
        ("request".to_string(), JsonValue::Object(request.clone())),
        (
            "tools".to_string(),
            tools
                .as_ref()
                .map(|items| {
                    JsonValue::Array(items.iter().cloned().map(JsonValue::String).collect())
                })
                .unwrap_or(JsonValue::Null),
        ),
        (
            "result_kind".to_string(),
            JsonValue::String(result.as_str().to_string()),
        ),
        (
            "text".to_string(),
            JsonValue::String(format!(
                "这是 Runtime 正在执行的 Yao 程序提出的内部 infer 请求。请根据 request 中的任务与证据完成判断；可使用 tools 声明允许的工具补充证据。最终正文只返回供父 Plan 继续求值的结果，不要把它当作用户消息。{}\n\n{}",
                match result {
                    crate::sexpr_eval::InferResultKind::Text => "",
                    crate::sexpr_eval::InferResultKind::Json => "本节点声明 returns=json；最终正文必须只包含一个完整、合法的 JSON 值，不要使用 Markdown 代码围栏或附加说明。",
                },
                serde_json::to_string(&JsonValue::Object(request.clone()))?
            )),
        ),
    ]);
    if let Some(principal_id) = &plan.initiating_principal_id {
        payload.insert(
            "principal_id".to_string(),
            JsonValue::String(principal_id.clone()),
        );
    }
    if let Some(objective_id) = &plan.objective_id {
        payload.insert(
            "objective_id".to_string(),
            JsonValue::String(objective_id.clone()),
        );
    }
    if let Some(evaluation_id) = &plan.objective_evaluation_id {
        payload.insert(
            "objective_evaluation_id".to_string(),
            JsonValue::String(evaluation_id.clone()),
        );
    }
    let mut event = Event::new(
        event_id,
        "Runtime-Yao".to_string(),
        TYPE_INFER_REQUEST.to_string(),
        // An infer request is an internal evaluation input, but it still
        // enters the ordinary chat Signal router so the Scheduler can
        // materialize its child Activation.  Keep the dedicated Event type
        // to distinguish it from a user message.
        "chat/infer_request".to_string(),
        payload,
    );
    // Exact replay must be byte-identical. The claim transition timestamp is
    // already durable and remains stable if the caller loses the commit
    // response and retries this hand-off.
    event.timestamp = plan.updated_at;
    Ok(event)
}

pub fn deterministic_infer_activation_id(event_id: &str) -> PlanExecutionResult<String> {
    if event_id.trim().is_empty() {
        return Err("infer request Event id 不能为空".into());
    }
    let digest = Sha256::digest(event_id.as_bytes());
    let id = format!("work_{digest:x}");
    Ok(id[..29].to_string())
}

fn validate_terminal_evaluation_route(
    plan: &PlanExecutionRecord,
    activation: &crate::memory::ThreadActivationRecord,
) -> PlanExecutionResult<()> {
    if !activation.status.is_terminal() {
        return Err(format!("child Activation '{}' 尚未终结", activation.id).into());
    }
    if activation.agent_id != plan.agent_id
        || activation.context_id != plan.context_id
        || activation.session_id != plan.session_id
        || activation.initiating_principal_id != plan.initiating_principal_id
        || activation.parent_activation_id.as_deref() != Some(plan.activation_id.as_str())
    {
        return Err("PlanExecution 与 child Evaluation Activation 的因果 route 不一致".into());
    }
    Ok(())
}

fn stable_id(domain: &[u8], prefix: &str, left: &str, right: &str) -> PlanExecutionResult<String> {
    if left.trim().is_empty() || right.trim().is_empty() {
        return Err(format!("{prefix} identity 组成部分不能为空").into());
    }
    let mut digest = Sha256::new();
    digest.update(domain);
    for value in [left.as_bytes(), right.as_bytes()] {
        digest.update((value.len() as u64).to_be_bytes());
        digest.update(value);
    }
    Ok(format!("{prefix}_{:x}", digest.finalize()))
}

fn validate_planned_job(
    plan: &PlanExecutionRecord,
    effect: &PlanEffect,
    effect_tool_call_id: &str,
    job: &NewExecutionJob,
) -> PlanExecutionResult<()> {
    let PlanEffect::Call {
        tool, arguments, ..
    } = effect
    else {
        return Err("只有 call effect 可以规划 Execution Job".into());
    };
    let expected_id = deterministic_job_id(&plan.activation_id, effect_tool_call_id)?;
    if job.id != expected_id
        || job.tool_call_id != effect_tool_call_id
        || job.tool_name != *tool
        || job.activation_id != plan.activation_id
        || job.thread_id != plan.thread_id
        || job.agent_id != plan.agent_id
        || job.context_id != plan.context_id
        || job.session_id != plan.session_id
        || job.initiating_principal_id != plan.initiating_principal_id
    {
        return Err("PlanCallPlanner 返回的 Job 身份或因果 route 不一致".into());
    }
    // A planner may attach an immutable Target route snapshot to the request,
    // so request equality is not required. It must however retain the original
    // arguments rather than replace them with an unrelated payload.
    let request_arguments = job
        .request
        .get("arguments")
        .and_then(JsonValue::as_object)
        .or_else(|| job.request.as_object());
    let request_contains_arguments = request_arguments.is_some_and(|request| {
        arguments
            .iter()
            .all(|(name, value)| request.get(name) == Some(value))
    });
    if !request_contains_arguments {
        return Err("PlanCallPlanner 返回的 Job request 没有保留原始 call arguments".into());
    }
    Ok(())
}

fn validate_terminal_job_route(
    plan: &PlanExecutionRecord,
    job: &ExecutionJobRecord,
) -> PlanExecutionResult<()> {
    if !job.status.is_terminal() {
        return Err(format!(
            "Execution Job '{}' 尚未终结，不能恢复 PlanExecution",
            job.id
        )
        .into());
    }
    if job.activation_id != plan.activation_id
        || job.thread_id != plan.thread_id
        || job.agent_id != plan.agent_id
        || job.context_id != plan.context_id
        || job.session_id != plan.session_id
        || job.initiating_principal_id != plan.initiating_principal_id
    {
        return Err("Execution Job terminal route 与 PlanExecution 不一致".into());
    }
    Ok(())
}

fn normalize_job_outcome(
    job: &ExecutionJobRecord,
    outcome: Result<JsonValue, String>,
) -> Result<JsonValue, String> {
    match job.status {
        ExecutionJobStatus::Succeeded => outcome,
        ExecutionJobStatus::Failed => Err(job
            .error
            .clone()
            .or_else(|| outcome.err())
            .unwrap_or_else(|| "Execution Job 执行失败".to_string())),
        ExecutionJobStatus::Cancelled => Err(job
            .error
            .clone()
            .unwrap_or_else(|| "Execution Job 已取消".to_string())),
        ExecutionJobStatus::Lost => Err(job
            .error
            .clone()
            .unwrap_or_else(|| "Execution Job 执行事实不确定".to_string())),
        status => Err(format!("Execution Job 状态 {} 不是终态", status.as_str())),
    }
}

fn updated_or_conflict(
    mutation: PlanExecutionMutation,
    operation: &str,
) -> PlanExecutionResult<PlanExecutionRecord> {
    match mutation {
        PlanExecutionMutation::Updated(record) | PlanExecutionMutation::Existing(record) => {
            Ok(record)
        }
        PlanExecutionMutation::Conflict { current } => Err(format!(
            "PlanExecution {operation} revision 冲突：当前 {} r{}",
            current.id, current.revision
        )
        .into()),
        PlanExecutionMutation::Rejected { reason, .. } => {
            Err(format!("PlanExecution {operation} 被拒绝：{reason}").into())
        }
        PlanExecutionMutation::NotFound => {
            Err(format!("PlanExecution {operation} 时不存在").into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{Event, TYPE_TOOL_OUTPUT};
    use crate::execution_target::DEFAULT_EXECUTION_TARGET_ID;
    use crate::llm::ToolDefinition;
    use crate::memory::sqlite::SqliteStore;
    use crate::memory::{
        ActivationStore, ExecutionJobFilter, ExecutionJobMutation, ExecutionJobStore,
        ExecutionJobTerminal, ExecutionRetrySafety, NewCognitiveContext, NewSession, NewThread,
        NewThreadActivation, PlanExecutionStore, SessionDirectoryStore, SessionMountKind,
        ThreadActivationMutation, ThreadKind, ThreadStore,
    };
    use crate::sexpr_eval::{validate, AllowList};
    use crate::tool::Tool;
    use chrono::Duration;
    use tempfile::NamedTempFile;

    struct DefinitionOnlyTool;

    #[async_trait::async_trait]
    impl Tool for DefinitionOnlyTool {
        fn name(&self) -> &str {
            "read"
        }

        fn definition(&self) -> ToolDefinition {
            ToolDefinition {
                name: self.name().to_string(),
                description: "test read".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"]
                }),
            }
        }

        fn retry_safety(&self) -> ExecutionRetrySafety {
            ExecutionRetrySafety::Idempotent
        }

        async fn execute(&self, _arguments: &str) -> PlanExecutionResult<String> {
            panic!("PlanExecutionCoordinator must never execute a physical tool inline")
        }
    }

    struct TestPlanner;

    #[async_trait::async_trait]
    impl PlanCallPlanner for TestPlanner {
        async fn plan_call(
            &self,
            plan: &PlanExecutionRecord,
            effect: &PlanEffect,
            effect_tool_call_id: &str,
        ) -> PlanExecutionResult<NewExecutionJob> {
            let PlanEffect::Call {
                tool, arguments, ..
            } = effect
            else {
                return Err("test planner received non-call effect".into());
            };
            Ok(NewExecutionJob {
                id: deterministic_job_id(&plan.activation_id, effect_tool_call_id)?,
                activation_id: plan.activation_id.clone(),
                thread_id: plan.thread_id.clone(),
                agent_id: plan.agent_id.clone(),
                context_id: plan.context_id.clone(),
                session_id: plan.session_id.clone(),
                initiating_principal_id: plan.initiating_principal_id.clone(),
                target_id: DEFAULT_EXECUTION_TARGET_ID.to_string(),
                tool_call_id: effect_tool_call_id.to_string(),
                tool_name: tool.clone(),
                request: serde_json::json!({
                    "arguments": arguments,
                    "target_snapshot": {"id": DEFAULT_EXECUTION_TARGET_ID}
                }),
                retry_safety: ExecutionRetrySafety::Idempotent,
                requires_approval: false,
            })
        }
    }

    struct RejectingPlanner;

    #[async_trait::async_trait]
    impl PlanCallPlanner for RejectingPlanner {
        async fn plan_call(
            &self,
            _plan: &PlanExecutionRecord,
            _effect: &PlanEffect,
            _effect_tool_call_id: &str,
        ) -> PlanExecutionResult<NewExecutionJob> {
            Err("target is unavailable".into())
        }
    }

    async fn seed_route(store: &SqliteStore) -> PlanExecutionRoute {
        let context_id = "plan-coordinator-context".to_string();
        let session_id = "plan-coordinator-session".to_string();
        let thread_id = "plan-coordinator-thread".to_string();
        let activation_id = "plan-coordinator-activation".to_string();
        store
            .create_context(NewCognitiveContext {
                id: context_id.clone(),
                agent_id: "plan-agent".to_string(),
                title: "Plan Context".to_string(),
            })
            .await
            .unwrap();
        store
            .create_session(NewSession {
                id: session_id.clone(),
                agent_id: "plan-agent".to_string(),
                context_id: context_id.clone(),
                parent_session_id: None,
                title: "Plan Session".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        store
            .ensure_thread(NewThread {
                id: thread_id.clone(),
                agent_id: "plan-agent".to_string(),
                context_id: context_id.clone(),
                session_id: session_id.clone(),
                initiating_principal_id: None,
                root_turn_id: "plan-coordinator-turn".to_string(),
                kind: ThreadKind::Execution,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: crate::memory::ThreadSupervision::legacy(),
            })
            .await
            .unwrap();
        store
            .ensure_thread_activation(NewThreadActivation {
                id: activation_id.clone(),
                agent_id: "plan-agent".to_string(),
                context_id: context_id.clone(),
                session_id: session_id.clone(),
                initiating_principal_id: None,
                trigger_event_id: "plan-coordinator-trigger".to_string(),
                trigger_sequence: 1,
                trigger_kind: "runtime/plan".to_string(),
                parent_activation_id: None,
                root_turn_id: "plan-coordinator-turn".to_string(),
            })
            .await
            .unwrap();
        PlanExecutionRoute {
            activation_id,
            thread_id,
            agent_id: "plan-agent".to_string(),
            context_id,
            session_id,
            initiating_principal_id: None,
            tool_call_id: "outer-eval-call".to_string(),
            objective_id: None,
            objective_evaluation_id: None,
        }
    }

    fn updated_job(mutation: ExecutionJobMutation) -> ExecutionJobRecord {
        match mutation {
            ExecutionJobMutation::Updated(job) => job,
            other => panic!("expected updated ExecutionJob, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn physical_call_is_atomically_suspended_and_refilled_through_execution_job() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp_file.path().to_str().unwrap())
                .await
                .unwrap(),
        );
        let registry = Arc::new(Registry::new());
        registry.register(Arc::new(DefinitionOnlyTool));
        let program = validate(
            r#"(eval
                 (requires (tools read))
                 (seq
                   (bind body (call read (path "README.md")))
                   $body))"#,
            &registry,
            &AllowList::new(["read"]),
        )
        .unwrap();
        let route = seed_route(&store).await;
        let runtime_store: Arc<dyn RuntimeStore> = store.clone();
        let coordinator = PlanExecutionCoordinator::new(runtime_store, registry);
        let queued = coordinator
            .ensure(route, &program, PlanArtifactBinding::default())
            .await
            .unwrap();

        let (waiting, job) = match coordinator
            .drive_once(
                &queued.id,
                queued.revision,
                "plan-worker",
                "plan-claim-1",
                Utc::now() + Duration::minutes(1),
                &TestPlanner,
            )
            .await
            .unwrap()
        {
            PlanDriveReceipt::WaitingForExecutionJob {
                plan,
                job,
                existing,
            } => {
                assert!(!existing);
                (plan, job)
            }
            other => panic!("expected execution-job suspension, got {other:?}"),
        };
        assert_eq!(waiting.status, PlanExecutionStatus::Waiting);
        assert_eq!(waiting.pending_id.as_deref(), Some(job.id.as_str()));

        let running_job = updated_job(
            store
                .claim_execution_job(
                    &job.id,
                    job.revision,
                    "execution-worker",
                    "job-claim-1",
                    Utc::now() + Duration::minutes(1),
                    None,
                )
                .await
                .unwrap(),
        );
        let result_event = Event::new(
            "plan-coordinator-result".to_string(),
            "Test-Executor".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            serde_json::Map::from_iter([
                ("context_id".to_string(), serde_json::json!(job.context_id)),
                ("session_id".to_string(), serde_json::json!(job.session_id)),
                (
                    "activation_id".to_string(),
                    serde_json::json!(job.activation_id),
                ),
                ("thread_id".to_string(), serde_json::json!(job.thread_id)),
                (
                    "tool_call_id".to_string(),
                    serde_json::json!(job.tool_call_id),
                ),
                ("tool_name".to_string(), serde_json::json!("read")),
                ("tool_status".to_string(), serde_json::json!("success")),
                ("text".to_string(), serde_json::json!("README contents")),
            ]),
        );
        let terminal_job = updated_job(
            store
                .finish_execution_job_with_event(
                    &running_job.id,
                    running_job.revision,
                    Some("job-claim-1"),
                    ExecutionJobTerminal {
                        status: ExecutionJobStatus::Succeeded,
                        result_event_id: Some(result_event.id.clone()),
                        result_refs: Vec::new(),
                        error: None,
                        exit_code: Some(0),
                    },
                    &result_event,
                    false,
                )
                .await
                .unwrap(),
        );
        assert_eq!(terminal_job.status, ExecutionJobStatus::Succeeded);

        let mut report = coordinator
            .reconcile_waiting_execution_jobs(Some(&waiting.context_id), 16)
            .await
            .unwrap();
        assert!(report.conflicts.is_empty());
        assert!(report.still_waiting.is_empty());
        assert_eq!(report.resumed.len(), 1);
        let resumed = report.resumed.pop().unwrap();
        assert_eq!(resumed.status, PlanExecutionStatus::Queued);

        match coordinator
            .drive_once(
                &resumed.id,
                resumed.revision,
                "plan-worker",
                "plan-claim-2",
                Utc::now() + Duration::minutes(1),
                &TestPlanner,
            )
            .await
            .unwrap()
        {
            PlanDriveReceipt::Succeeded { plan, value } => {
                assert_eq!(value, serde_json::json!("README contents"));
                assert_eq!(plan.status, PlanExecutionStatus::Succeeded);
            }
            other => panic!("expected completed plan, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_call_planning_error_terminates_the_claimed_plan_instead_of_stranding_it() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp_file.path().to_str().unwrap())
                .await
                .unwrap(),
        );
        let registry = Arc::new(Registry::new());
        registry.register(Arc::new(DefinitionOnlyTool));
        let program = validate(
            r#"(eval (requires (tools read)) (call read (path "README.md")))"#,
            &registry,
            &AllowList::new(["read"]),
        )
        .unwrap();
        let route = seed_route(&store).await;
        let runtime_store: Arc<dyn RuntimeStore> = store.clone();
        let coordinator = PlanExecutionCoordinator::new(runtime_store, registry);
        let queued = coordinator
            .ensure(route, &program, PlanArtifactBinding::default())
            .await
            .unwrap();

        let failed = coordinator
            .drive_once(
                &queued.id,
                queued.revision,
                "plan-worker",
                "plan-rejected-claim",
                Utc::now() + Duration::minutes(1),
                &RejectingPlanner,
            )
            .await
            .unwrap();

        match failed {
            PlanDriveReceipt::Failed { plan, error } => {
                assert_eq!(plan.status, PlanExecutionStatus::Failed);
                assert!(error.contains("target is unavailable"), "got: {error}");
            }
            other => panic!("expected failed PlanExecution, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn expired_running_plan_is_fenced_and_requeued_for_immediate_recovery() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp_file.path().to_str().unwrap())
                .await
                .unwrap(),
        );
        let registry = Arc::new(Registry::new());
        let program = validate(
            r#"(eval (seq "done"))"#,
            &registry,
            &AllowList::new(Vec::<String>::new()),
        )
        .unwrap();
        let route = seed_route(&store).await;
        let runtime_store: Arc<dyn RuntimeStore> = store.clone();
        let coordinator = PlanExecutionCoordinator::new(runtime_store, registry);
        let queued = coordinator
            .ensure(route, &program, PlanArtifactBinding::default())
            .await
            .unwrap();
        let running = match store
            .claim_plan_execution(
                &queued.id,
                queued.revision,
                "abandoned-worker",
                "abandoned-claim",
                Utc::now() - Duration::seconds(1),
            )
            .await
            .unwrap()
        {
            PlanExecutionMutation::Updated(running) => running,
            other => panic!("expected running PlanExecution, got {other:?}"),
        };

        let recovered = coordinator
            .recover_expired_running(Some(&running.context_id), 16)
            .await
            .unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].id, running.id);
        assert_eq!(recovered[0].status, PlanExecutionStatus::Queued);
        assert!(recovered[0].claim_token.is_none());
        assert!(recovered[0].lease_expires_at.is_none());

        let persisted = store
            .get_plan_execution(&running.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(persisted.status, PlanExecutionStatus::Queued);
        assert!(persisted.revision > running.revision);
    }

    #[tokio::test]
    async fn infer_is_atomically_suspended_and_refilled_through_child_activation() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp_file.path().to_str().unwrap())
                .await
                .unwrap(),
        );
        let registry = Arc::new(Registry::new());
        let program = validate(
            r#"(eval
                 (seq
                   (bind judgement
                     (infer
                       (task "判断证据是否充分")
                       (returns json)
                       (evidence "A")))
                   $judgement))"#,
            &registry,
            &AllowList::new(Vec::<String>::new()),
        )
        .unwrap();
        let route = seed_route(&store).await;
        let runtime_store: Arc<dyn RuntimeStore> = store.clone();
        let coordinator = PlanExecutionCoordinator::new(runtime_store, registry);
        let queued = coordinator
            .ensure(route, &program, PlanArtifactBinding::default())
            .await
            .unwrap();

        let (waiting, request_event, activation_id) = match coordinator
            .drive_once(
                &queued.id,
                queued.revision,
                "plan-worker",
                "plan-infer-claim-1",
                Utc::now() + Duration::minutes(1),
                &TestPlanner,
            )
            .await
            .unwrap()
        {
            PlanDriveReceipt::WaitingForEvaluation {
                plan,
                request_event,
                activation_id,
                existing,
            } => {
                assert!(!existing);
                (plan, request_event, activation_id)
            }
            other => panic!("expected evaluation suspension, got {other:?}"),
        };
        assert_eq!(waiting.status, PlanExecutionStatus::Waiting);
        assert_eq!(
            waiting.pending_kind,
            Some(PlanExecutionWaitKind::Evaluation)
        );
        assert_eq!(waiting.pending_id.as_deref(), Some(activation_id.as_str()));
        assert_eq!(request_event.payload["result_kind"], "json");

        // The durable infer hand-off intentionally precedes asynchronous
        // Scheduler materialization.  A reconciler observing this crash
        // window must keep waiting instead of turning the missing child into
        // a failed Plan.
        let pre_materialization = coordinator
            .reconcile_waiting_evaluations(Some(&waiting.context_id), 16)
            .await
            .unwrap();
        assert!(pre_materialization.resumed.is_empty());
        assert!(pre_materialization.conflicts.is_empty());
        assert_eq!(pre_materialization.still_waiting, vec![waiting.id.clone()]);

        let child_thread = store
            .get_thread_by_root(&request_event.id)
            .await
            .unwrap()
            .expect("atomic infer hand-off must materialize its supervised child Thread");
        assert_eq!(child_thread.executor_kind, "plan_infer");
        assert_eq!(
            child_thread.executor_id.as_deref(),
            Some(waiting.id.as_str())
        );
        let child_activation = store
            .ensure_thread_activation(NewThreadActivation {
                id: activation_id.clone(),
                agent_id: waiting.agent_id.clone(),
                context_id: waiting.context_id.clone(),
                session_id: waiting.session_id.clone(),
                initiating_principal_id: waiting.initiating_principal_id.clone(),
                trigger_event_id: request_event.id.clone(),
                trigger_sequence: 2,
                trigger_kind: TYPE_INFER_REQUEST.to_string(),
                parent_activation_id: Some(waiting.activation_id.clone()),
                root_turn_id: request_event.id.clone(),
            })
            .await
            .unwrap();
        let result_event = Event::new(
            "plan-infer-result".to_string(),
            "Test-Evaluator".to_string(),
            "agent/result".to_string(),
            "plan/infer_result".to_string(),
            serde_json::Map::from_iter([
                (
                    "context_id".to_string(),
                    serde_json::json!(waiting.context_id),
                ),
                (
                    "session_id".to_string(),
                    serde_json::json!(waiting.session_id),
                ),
                ("thread_id".to_string(), serde_json::json!(child_thread.id)),
                (
                    "root_turn_id".to_string(),
                    serde_json::json!(request_event.id),
                ),
                (
                    "disposition".to_string(),
                    serde_json::json!("complete_internal_evaluation"),
                ),
                (
                    "text".to_string(),
                    serde_json::json!(r#"{"sufficient":true,"next":"continue"}"#),
                ),
            ]),
        );
        let child_activation = match store
            .update_thread_activation(
                &child_activation.id,
                child_activation.revision,
                ThreadActivationStatus::Running,
                Some("plan-infer-test-worker"),
                Some(Utc::now() + Duration::minutes(1)),
                None,
            )
            .await
            .unwrap()
        {
            ThreadActivationMutation::Updated(record) => record,
            other => panic!("expected running child activation, got {other:?}"),
        };
        assert_eq!(child_activation.status, ThreadActivationStatus::Running);

        // A running child without a committed outcome is still in flight.
        // Production commits the logical Thread outcome first and only then
        // closes the physical Activation projection.
        let between_tool_steps = coordinator
            .reconcile_waiting_evaluations(Some(&waiting.context_id), 16)
            .await
            .unwrap();
        assert!(between_tool_steps.resumed.is_empty());
        assert!(between_tool_steps.conflicts.is_empty());
        assert_eq!(between_tool_steps.still_waiting, vec![waiting.id.clone()]);

        store
            .commit_activation_outcome(&activation_id, &result_event)
            .await
            .unwrap();
        let terminal_child = store
            .get_thread_activation(&child_activation.id)
            .await
            .unwrap()
            .expect("atomic outcome commit must retain the child Activation");
        assert_eq!(terminal_child.status, ThreadActivationStatus::Succeeded);
        assert!(terminal_child.revision > child_activation.revision);

        let resumed = match coordinator
            .reconcile_evaluation(&waiting.id, &activation_id)
            .await
            .unwrap()
        {
            PlanResumeReceipt::Queued(plan) => plan,
            other => panic!("expected queued plan after infer refill, got {other:?}"),
        };
        match coordinator
            .drive_once(
                &resumed.id,
                resumed.revision,
                "plan-worker",
                "plan-infer-claim-2",
                Utc::now() + Duration::minutes(1),
                &TestPlanner,
            )
            .await
            .unwrap()
        {
            PlanDriveReceipt::Succeeded { plan, value } => {
                assert_eq!(
                    value,
                    serde_json::json!({"sufficient": true, "next": "continue"})
                );
                assert_eq!(plan.status, PlanExecutionStatus::Succeeded);
            }
            other => panic!("expected completed infer plan, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn malformed_json_infer_result_fails_closed_after_restart_without_physical_call() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp_file.path().to_str().unwrap())
                .await
                .unwrap(),
        );
        let registry = Arc::new(Registry::new());
        registry.register(Arc::new(DefinitionOnlyTool));
        let program = validate(
            r#"(eval
                 (requires (tools read))
                 (seq
                   (bind decision
                     (infer
                       (task "返回后续 read 的结构化决策")
                       (returns json)))
                   (call read (path $decision.path))))"#,
            &registry,
            &AllowList::new(["read"]),
        )
        .unwrap();
        let route = seed_route(&store).await;
        let runtime_store: Arc<dyn RuntimeStore> = store.clone();
        let coordinator = PlanExecutionCoordinator::new(runtime_store, registry.clone());
        let queued = coordinator
            .ensure(route, &program, PlanArtifactBinding::default())
            .await
            .unwrap();
        let (waiting, request_event, activation_id) = match coordinator
            .drive_once(
                &queued.id,
                queued.revision,
                "plan-worker-before-restart",
                "plan-malformed-claim-1",
                Utc::now() + Duration::minutes(1),
                &TestPlanner,
            )
            .await
            .unwrap()
        {
            PlanDriveReceipt::WaitingForEvaluation {
                plan,
                request_event,
                activation_id,
                ..
            } => (plan, request_event, activation_id),
            other => panic!("expected evaluation suspension, got {other:?}"),
        };

        let child_thread = store
            .get_thread_by_root(&request_event.id)
            .await
            .unwrap()
            .expect("atomic infer hand-off must survive restart as its supervised child Thread");
        assert_eq!(child_thread.executor_kind, "plan_infer");
        assert_eq!(
            child_thread.executor_id.as_deref(),
            Some(waiting.id.as_str())
        );
        let child_activation = store
            .ensure_thread_activation(NewThreadActivation {
                id: activation_id.clone(),
                agent_id: waiting.agent_id.clone(),
                context_id: waiting.context_id.clone(),
                session_id: waiting.session_id.clone(),
                initiating_principal_id: waiting.initiating_principal_id.clone(),
                trigger_event_id: request_event.id.clone(),
                trigger_sequence: 2,
                trigger_kind: TYPE_INFER_REQUEST.to_string(),
                parent_activation_id: Some(waiting.activation_id.clone()),
                root_turn_id: request_event.id.clone(),
            })
            .await
            .unwrap();
        let child_activation = match store
            .update_thread_activation(
                &child_activation.id,
                child_activation.revision,
                ThreadActivationStatus::Running,
                Some("plan-infer-malformed-test-worker"),
                Some(Utc::now() + Duration::minutes(1)),
                None,
            )
            .await
            .unwrap()
        {
            ThreadActivationMutation::Updated(record) => record,
            other => panic!("expected running child activation, got {other:?}"),
        };
        assert_eq!(child_activation.status, ThreadActivationStatus::Running);
        let malformed_result = Event::new(
            "plan-malformed-infer-result".to_string(),
            "Test-Evaluator".to_string(),
            "agent/result".to_string(),
            "plan/infer_result".to_string(),
            serde_json::Map::from_iter([
                (
                    "context_id".to_string(),
                    serde_json::json!(waiting.context_id),
                ),
                (
                    "session_id".to_string(),
                    serde_json::json!(waiting.session_id),
                ),
                ("thread_id".to_string(), serde_json::json!(child_thread.id)),
                (
                    "root_turn_id".to_string(),
                    serde_json::json!(request_event.id),
                ),
                (
                    "text".to_string(),
                    serde_json::json!("```json\n{\"path\":\"README.md\"}\n```"),
                ),
            ]),
        );
        store
            .commit_activation_outcome(&activation_id, &malformed_result)
            .await
            .unwrap();
        let terminal_child = store
            .get_thread_activation(&child_activation.id)
            .await
            .unwrap()
            .expect("atomic malformed outcome commit must retain the child Activation");
        assert_eq!(terminal_child.status, ThreadActivationStatus::Succeeded);
        assert!(terminal_child.revision > child_activation.revision);

        // Recreate the coordinator to prove recovery only depends on durable
        // Plan, Thread and Event facts rather than an in-process response.
        drop(coordinator);
        let runtime_store: Arc<dyn RuntimeStore> = store.clone();
        let restarted = PlanExecutionCoordinator::new(runtime_store, registry);
        let resumed = match restarted
            .reconcile_evaluation(&waiting.id, &activation_id)
            .await
            .unwrap()
        {
            PlanResumeReceipt::Queued(plan) => plan,
            other => panic!("expected queued plan after durable refill, got {other:?}"),
        };
        match restarted
            .drive_once(
                &resumed.id,
                resumed.revision,
                "plan-worker-after-restart",
                "plan-malformed-claim-2",
                Utc::now() + Duration::minutes(1),
                &TestPlanner,
            )
            .await
            .unwrap()
        {
            PlanDriveReceipt::Failed { plan, error } => {
                assert_eq!(plan.status, PlanExecutionStatus::Failed);
                assert!(error.contains("合法 JSON"), "got: {error}");
            }
            other => panic!("expected fail-closed plan, got {other:?}"),
        }
        let jobs = store
            .list_execution_jobs(ExecutionJobFilter {
                context_id: Some(waiting.context_id),
                include_terminal: true,
                ..ExecutionJobFilter::default()
            })
            .await
            .unwrap();
        assert!(
            jobs.is_empty(),
            "malformed infer output must not reach the following physical call"
        );
    }
}
