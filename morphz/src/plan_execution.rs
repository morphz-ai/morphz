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

use crate::execution::deterministic_job_id;
use crate::memory::{
    ExecutionJobRecord, ExecutionJobStatus, NewExecutionJob, NewPlanExecution, PlanExecutionFilter,
    PlanExecutionMutation, PlanExecutionRecord, PlanExecutionStatus, PlanExecutionWaitKind,
    QueryFilter, RuntimeStore,
};
use crate::sexpr_eval::{PlanAdvance, PlanEffect, PlanMachine, Program};
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
        job: ExecutionJobRecord,
        existing: bool,
    },
    WaitingForInfer {
        plan: PlanExecutionRecord,
        effect: PlanEffect,
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
    /// `call` is handed to the existing Execution Job plane. `infer` is
    /// intentionally surfaced without executing it: the next integration
    /// slice must materialize a real child Evaluation before this claim can be
    /// released.
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

        let mut machine: PlanMachine = serde_json::from_value(running.state_json.clone())
            .map_err(|error| format!("PlanExecution '{}' state 无法恢复: {error}", running.id))?;
        match machine.advance(&self.registry) {
            PlanAdvance::Suspended(effect @ PlanEffect::Call { sequence, .. }) => {
                let state_json = serde_json::to_value(&machine)?;
                let budget_json = machine.budget_json()?;
                let effect_tool_call_id = deterministic_plan_effect_id(&running.id, sequence)?;
                let job = planner
                    .plan_call(&running, &effect, &effect_tool_call_id)
                    .await?;
                validate_planned_job(&running, &effect, &effect_tool_call_id, &job)?;
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
                    job: committed.execution_job,
                    existing: committed.existing,
                })
            }
            PlanAdvance::Suspended(effect @ PlanEffect::Infer { .. }) => {
                let state_json = serde_json::to_value(&machine)?;
                let budget_json = machine.budget_json()?;
                let mutation = self
                    .store
                    .heartbeat_plan_execution(
                        &running.id,
                        running.revision,
                        claim_token,
                        lease_expires_at,
                        &state_json,
                        &budget_json,
                    )
                    .await?;
                let plan = updated_or_conflict(mutation, "infer effect heartbeat")?;
                Ok(PlanDriveReceipt::WaitingForInfer { plan, effect })
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
        ActivationStore, ExecutionJobMutation, ExecutionJobStore, ExecutionJobTerminal,
        ExecutionRetrySafety, NewCognitiveContext, NewSession, NewThread, NewThreadActivation,
        SessionDirectoryStore, SessionMountKind, ThreadKind, ThreadStore,
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
}
