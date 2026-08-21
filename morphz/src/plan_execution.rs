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
    stable_thread_activation_id, ActionGroupMemberStatus, ActionGroupRecord, ActionGroupStatus,
    ExecutionJobRecord, ExecutionJobStatus, NewActionGroup, NewActionGroupMember, NewExecutionJob,
    NewPlanExecution, PlanEvaluationCommit, PlanExecutionFilter, PlanExecutionMutation,
    PlanExecutionRecord, PlanExecutionStatus, PlanExecutionWaitKind, QueryFilter, RuntimeStore,
    ThreadActivationStatus,
};
use crate::sexpr_eval::{
    decode_infer_result, decode_infer_result_with_admission, InferResultKind, PlanAdvance,
    PlanEffect, PlanMachine, Program, ProgramValueProvenance,
};
use crate::tool::Registry;

pub type PlanExecutionResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

const PLAN_ID_DOMAIN: &[u8] = b"morphz.plan-execution.v1\0";
const EFFECT_ID_DOMAIN: &[u8] = b"morphz.plan-effect.v1\0";
const PAR_GROUP_ID_DOMAIN: &[u8] = b"morphz.plan-par-group.v1\0";
const PAR_BRANCH_ID_DOMAIN: &[u8] = b"morphz.plan-par-branch.v1\0";
const PROGRAM_CHILD_ID_DOMAIN: &[u8] = b"morphz.plan-program-child.v1\0";

fn runtime_environment_value(
    route: &PlanExecutionRoute,
    binding: &PlanArtifactBinding,
    plan_execution_id: &str,
) -> JsonValue {
    let evaluation_id = route
        .objective_evaluation_id
        .as_deref()
        .unwrap_or(&route.activation_id);
    let harness_binding_id = binding.harness_id.as_deref().map(|harness_id| {
        binding.harness_version.as_deref().map_or_else(
            || harness_id.to_string(),
            |version| format!("{harness_id}@{version}"),
        )
    });
    crate::yao::structural_record_value([
        (
            "agent".to_string(),
            crate::yao::reference_value("Agent", &route.agent_id),
        ),
        (
            "evaluation".to_string(),
            crate::yao::reference_value("Evaluation", evaluation_id),
        ),
        (
            "context".to_string(),
            crate::yao::reference_value("Context", &route.context_id),
        ),
        (
            "objective".to_string(),
            crate::yao::optional_reference_value("Objective", route.objective_id.as_deref()),
        ),
        (
            "harness".to_string(),
            crate::yao::optional_reference_value("HarnessBinding", harness_binding_id.as_deref()),
        ),
        (
            "capabilities".to_string(),
            crate::yao::reference_value("CapabilitySet", plan_execution_id),
        ),
        (
            "principal".to_string(),
            crate::yao::optional_reference_value(
                "Principal",
                route.initiating_principal_id.as_deref(),
            ),
        ),
        (
            "execution_target".to_string(),
            crate::yao::optional_reference_value("ExecutionTarget", None),
        ),
    ])
}

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
    WaitingForActionGroup {
        plan: PlanExecutionRecord,
        group: Box<ActionGroupRecord>,
        children: Vec<PlanExecutionRecord>,
        existing: bool,
    },
    WaitingForPlanExecution {
        plan: PlanExecutionRecord,
        child: Box<PlanExecutionRecord>,
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
    pub scanned: usize,
    pub next_cursor: Option<(DateTime<Utc>, String)>,
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
        let mut machine = PlanMachine::new(program)?;
        machine.bind_runtime_environment(runtime_environment_value(&route, &binding, &id))?;
        let program_json = serde_json::to_value(program)?;
        let state_json = serde_json::to_value(&machine)?;
        let budget_json = machine.budget_json()?;
        let source_artifact_hash = binding.source_artifact_hash.unwrap_or_else(|| {
            program.typed_program().map_or_else(
                || {
                    format!(
                        "sha256:{:x}",
                        Sha256::digest(serde_json::to_vec(&program_json).unwrap_or_default())
                    )
                },
                |typed| typed.source_hash.clone(),
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
            loop {
                match machine.advance(&self.registry) {
                    PlanAdvance::Suspended(effect @ PlanEffect::Call { sequence, .. }) => {
                        let state_json = serde_json::to_value(&machine)?;
                        let budget_json = machine.budget_json()?;
                        let effect_tool_call_id =
                            deterministic_plan_effect_id(&running.id, sequence)?;
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
                        return Ok(PlanDriveReceipt::WaitingForExecutionJob {
                            plan: committed.plan,
                            job: Box::new(committed.execution_job),
                            existing: committed.existing,
                        });
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
                        return Ok(PlanDriveReceipt::WaitingForEvaluation {
                            plan: committed.plan,
                            request_event: Box::new(committed.request_event),
                            activation_id: committed.activation_id,
                            existing: committed.existing,
                        });
                    }
                    PlanAdvance::Suspended(effect @ PlanEffect::Parallel { sequence, .. }) => {
                        let state_json = serde_json::to_value(&machine)?;
                        let budget_json = machine.budget_json()?;
                        let group_id = deterministic_plan_parallel_group_id(&running.id, sequence)?;
                        let (group, members) =
                            parallel_group_request(&running, &effect, &group_id)?;
                        let existed_before =
                            self.store.get_action_group(&group_id).await?.is_some();
                        let group = self.store.create_action_group(group, members).await?;
                        let mutation = self
                            .store
                            .suspend_plan_execution(
                                &running.id,
                                running.revision,
                                claim_token,
                                &state_json,
                                &budget_json,
                                PlanExecutionWaitKind::ActionGroup,
                                &group_id,
                            )
                            .await?;
                        let plan = updated_or_conflict(mutation, "suspend on par Action Group")?;
                        let children = self
                            .materialize_parallel_children(&plan, &effect, &group_id)
                            .await?;
                        return Ok(PlanDriveReceipt::WaitingForActionGroup {
                            plan,
                            group: Box::new(group),
                            children,
                            existing: existed_before,
                        });
                    }
                    PlanAdvance::Suspended(effect @ PlanEffect::Program { sequence, .. }) => {
                        let state_json = serde_json::to_value(&machine)?;
                        let budget_json = machine.budget_json()?;
                        let child_id = deterministic_plan_program_child_id(
                            &running.activation_id,
                            &running.id,
                            sequence,
                        )?;
                        let existed_before =
                            self.store.get_plan_execution(&child_id).await?.is_some();
                        let mutation = self
                            .store
                            .suspend_plan_execution(
                                &running.id,
                                running.revision,
                                claim_token,
                                &state_json,
                                &budget_json,
                                PlanExecutionWaitKind::PlanExecution,
                                &child_id,
                            )
                            .await?;
                        let plan = updated_or_conflict(mutation, "suspend on Program child Plan")?;
                        let child = self
                            .materialize_program_child(&plan, &effect, &child_id)
                            .await?;
                        return Ok(PlanDriveReceipt::WaitingForPlanExecution {
                            plan,
                            child: Box::new(child),
                            existing: existed_before,
                        });
                    }
                    PlanAdvance::Suspended(effect @ PlanEffect::Host { sequence, .. }) => {
                        let outcome = self.execute_host_effect(&running, &effect).await;
                        machine.resume_effect(sequence, outcome)?;
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
                        return Ok(PlanDriveReceipt::Succeeded { plan, value });
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
                        return Ok(PlanDriveReceipt::Failed {
                            plan,
                            error: error.message,
                        });
                    }
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

    /// Executes one Runtime-profile Host effect behind an immutable replay
    /// receipt. If the process crashes after the Event commit but before the
    /// Plan checkpoint, the next owner returns the stored result instead of
    /// observing a newer view or submitting a second proposal.
    async fn execute_host_effect(
        &self,
        plan: &PlanExecutionRecord,
        effect: &PlanEffect,
    ) -> Result<JsonValue, String> {
        let PlanEffect::Host {
            sequence,
            operation,
            arguments,
            result,
        } = effect
        else {
            return Err("只有 Host effect 可以进入 Runtime Host executor".to_string());
        };
        let event_id =
            deterministic_plan_effect_id(&plan.id, *sequence).map_err(|error| error.to_string())?;
        let existing = self
            .store
            .query(QueryFilter {
                event_id: Some(event_id.clone()),
                context_id: Some(plan.context_id.clone()),
                top_k: Some(1),
                ..QueryFilter::default()
            })
            .await
            .map_err(|error| error.to_string())?
            .into_iter()
            .next();
        if let Some(existing) = existing {
            if existing
                .payload
                .get("plan_execution_id")
                .and_then(JsonValue::as_str)
                != Some(plan.id.as_str())
                || existing
                    .payload
                    .get("effect_sequence")
                    .and_then(JsonValue::as_u64)
                    != Some(*sequence)
                || existing
                    .payload
                    .get("operation")
                    .and_then(JsonValue::as_str)
                    != Some(operation.as_str())
                || existing.payload.get("arguments") != Some(&JsonValue::Object(arguments.clone()))
            {
                return Err(format!(
                    "Host effect Event '{}' 已被不同的因果内容占用",
                    existing.id
                ));
            }
            return existing
                .payload
                .get("result")
                .cloned()
                .ok_or_else(|| format!("Host effect Event '{}' 缺少 result", existing.id));
        }

        let raw = self
            .execute_new_host_operation(plan, &event_id, operation, arguments)
            .await?;
        let value = normalize_host_result(result.clone(), raw)?;
        let (event_type, topic) = host_event_class(operation);
        let mut payload = serde_json::Map::from_iter([
            (
                "plan_execution_id".to_string(),
                JsonValue::String(plan.id.clone()),
            ),
            ("effect_sequence".to_string(), JsonValue::from(*sequence)),
            (
                "operation".to_string(),
                JsonValue::String(operation.clone()),
            ),
            (
                "arguments".to_string(),
                JsonValue::Object(arguments.clone()),
            ),
            ("result".to_string(), value.clone()),
            (
                "context_id".to_string(),
                JsonValue::String(plan.context_id.clone()),
            ),
            (
                "session_id".to_string(),
                JsonValue::String(plan.session_id.clone()),
            ),
            (
                "thread_id".to_string(),
                JsonValue::String(plan.thread_id.clone()),
            ),
            (
                "activation_id".to_string(),
                JsonValue::String(plan.activation_id.clone()),
            ),
            (
                "wake_policy".to_string(),
                JsonValue::String("none".to_string()),
            ),
        ]);
        if let Some(objective_id) = &plan.objective_id {
            payload.insert(
                "objective_id".to_string(),
                JsonValue::String(objective_id.clone()),
            );
        }
        if let Some(principal_id) = &plan.initiating_principal_id {
            payload.insert(
                "principal_id".to_string(),
                JsonValue::String(principal_id.clone()),
            );
        }
        let mut event = Event::new(
            event_id,
            "Runtime-Yao".to_string(),
            event_type.to_string(),
            topic.to_string(),
            payload,
        );
        event.timestamp = plan.updated_at;
        self.store
            .append(event)
            .await
            .map_err(|error| error.to_string())?;
        Ok(value)
    }

    async fn execute_new_host_operation(
        &self,
        plan: &PlanExecutionRecord,
        event_id: &str,
        operation: &str,
        arguments: &serde_json::Map<String, JsonValue>,
    ) -> Result<JsonValue, String> {
        match operation {
            "host.view" => {
                let reference = arguments.get("ref").ok_or("host.view 缺少 ref 参数")?;
                let (kind, id) = crate::yao::reference_view(reference)
                    .ok_or("host.view ref 参数不是有效的 opaque Ref")?;
                self.authorized_host_view(plan, kind, id).await
            }
            "evidence.commit" | "outcome.commit" => {
                let candidate = arguments
                    .get("candidate")
                    .ok_or_else(|| format!("{operation} 缺少 candidate 参数"))?;
                let kind = if operation == "evidence.commit" {
                    let candidate = crate::yao::evidence_candidate_view(candidate)
                        .ok_or("evidence.commit candidate 不是合法 EvidenceCandidate")?;
                    for reference in candidate.refs {
                        self.require_committed_reference_in_context(plan, reference, "Evidence")
                            .await?;
                    }
                    "Evidence"
                } else {
                    let candidate = crate::yao::outcome_candidate_view(candidate)
                        .ok_or("outcome.commit candidate 不是合法 OutcomeCandidate")?;
                    for reference in candidate.evidence {
                        self.require_committed_reference_in_context(plan, reference, "Evidence")
                            .await?;
                    }
                    "Outcome"
                };
                Ok(crate::yao::reference_value(kind, event_id))
            }
            "objective.report" | "objective.propose-wait" => {
                self.require_current_objective_ref(plan, arguments, "objective")?;
                if operation == "objective.report" {
                    if let Some(evidence) = arguments.get("evidence") {
                        let evidence = evidence
                            .as_array()
                            .ok_or("objective.report evidence 必须是 Ref<Evidence> 列表")?;
                        for reference in evidence {
                            self.require_committed_reference_in_context(
                                plan, reference, "Evidence",
                            )
                            .await?;
                        }
                    }
                }
                Ok(JsonValue::Null)
            }
            "objective.propose-completion" => {
                self.require_current_objective_ref(plan, arguments, "objective")?;
                self.require_event_ref_in_context(plan, arguments, "outcome", "Outcome")
                    .await?;
                Ok(JsonValue::Null)
            }
            "context.propose" => {
                let transaction = arguments
                    .get("transaction")
                    .ok_or("context.propose 缺少 transaction 参数")?;
                if transaction.is_null() {
                    return Err("context.propose transaction 不能是 nil".to_string());
                }
                Ok(serde_json::json!({
                    "proposal_id": event_id,
                    "status": "submitted",
                }))
            }
            other => Err(format!("未知 Morphz Host operation '{other}'")),
        }
    }

    fn require_current_objective_ref(
        &self,
        plan: &PlanExecutionRecord,
        arguments: &serde_json::Map<String, JsonValue>,
        argument: &str,
    ) -> Result<(), String> {
        let expected = plan
            .objective_id
            .as_deref()
            .ok_or("当前 Plan 没有 Objective authority")?;
        let value = arguments
            .get(argument)
            .ok_or_else(|| format!("缺少 {argument} 参数"))?;
        let (kind, id) = crate::yao::reference_view(value)
            .ok_or_else(|| format!("{argument} 不是有效的 opaque Ref"))?;
        if kind != "Objective" || id != expected {
            return Err(format!(
                "{argument} Ref 不属于当前 Plan 的 Objective authority"
            ));
        }
        Ok(())
    }

    async fn require_event_ref_in_context(
        &self,
        plan: &PlanExecutionRecord,
        arguments: &serde_json::Map<String, JsonValue>,
        argument: &str,
        expected_kind: &str,
    ) -> Result<(), String> {
        let value = arguments
            .get(argument)
            .ok_or_else(|| format!("缺少 {argument} 参数"))?;
        self.require_committed_reference_in_context(plan, value, expected_kind)
            .await
    }

    async fn require_committed_reference_in_context(
        &self,
        plan: &PlanExecutionRecord,
        value: &JsonValue,
        expected_kind: &str,
    ) -> Result<(), String> {
        let (kind, id) = crate::yao::reference_view(value)
            .ok_or_else(|| format!("值不是有效的 opaque Ref<{expected_kind}>"))?;
        if kind != expected_kind {
            return Err(format!("需要 Ref<{expected_kind}>，实际是 Ref<{kind}>"));
        }
        let event = self
            .store
            .query(QueryFilter {
                event_id: Some(id.to_string()),
                context_id: Some(plan.context_id.clone()),
                top_k: Some(1),
                ..QueryFilter::default()
            })
            .await
            .map_err(|error| error.to_string())?
            .into_iter()
            .find(|event| event.id == id)
            .ok_or_else(|| format!("Ref<{expected_kind}> 不属于当前 Context 或尚未提交"))?;
        let expected_operation = match expected_kind {
            "Evidence" => "evidence.commit",
            "Outcome" => "outcome.commit",
            other => return Err(format!("Host 不支持验证 Ref<{other}> 的提交来源")),
        };
        if event.payload.get("operation").and_then(JsonValue::as_str) != Some(expected_operation) {
            return Err(format!(
                "Event '{id}' 不是 Runtime 提交的 Ref<{expected_kind}>"
            ));
        }
        Ok(())
    }

    async fn authorized_host_view(
        &self,
        plan: &PlanExecutionRecord,
        kind: &str,
        id: &str,
    ) -> Result<JsonValue, String> {
        match kind {
            "Agent" if id == plan.agent_id => Ok(serde_json::json!({"id": id})),
            "Evaluation"
                if Some(id) == plan.objective_evaluation_id.as_deref()
                    || (plan.objective_evaluation_id.is_none() && id == plan.activation_id) =>
            {
                let program: Program = serde_json::from_value(plan.program_json.clone())
                    .map_err(|error| format!("Plan Program 无法读取: {error}"))?;
                Ok(serde_json::json!({
                    "id": id,
                    "owner": "runtime",
                    "causal_parent": plan.objective_id,
                    "start_time": plan.created_at.to_rfc3339(),
                    "budget_summary": plan.budget_json,
                    "result_contract": program.typed_program().map(|typed| &typed.output),
                }))
            }
            "Context" if id == plan.context_id => {
                let projection = self
                    .store
                    .get_mind_projection(id)
                    .await
                    .map_err(|error| error.to_string())?;
                Ok(serde_json::json!({
                    "id": id,
                    "agent_identity": plan.agent_id,
                    "active_mind_projection_identity": projection.as_ref().map(|value| &value.state_hash),
                    "revision": projection.as_ref().map(|value| value.revision),
                    "authorized_summary": null,
                }))
            }
            "Objective" if plan.objective_id.as_deref() == Some(id) => {
                let objective = self
                    .store
                    .get_objective(id)
                    .await
                    .map_err(|error| error.to_string())?
                    .ok_or_else(|| format!("Objective '{id}' 不存在"))?;
                if objective.context_id != plan.context_id || objective.agent_id != plan.agent_id {
                    return Err("Objective Ref 越过当前 Plan 的 Context/Agent authority".into());
                }
                Ok(serde_json::json!({
                    "id": objective.id,
                    "stated_objective": objective.stated_objective,
                    "status": objective.status.as_str(),
                    "wait_condition_summary": objective.wait_condition,
                    "completion_intent": objective.completion_intent,
                    "revision": objective.revision,
                    "verified_progress_summary": {
                        "tokens_used": objective.tokens_used,
                        "time_used_seconds": objective.time_used_seconds,
                    },
                }))
            }
            "HarnessBinding" => {
                let expected = plan.harness_id.as_deref().map(|harness_id| {
                    plan.harness_version.as_deref().map_or_else(
                        || harness_id.to_string(),
                        |version| format!("{harness_id}@{version}"),
                    )
                });
                if expected.as_deref() != Some(id) {
                    return Err("HarnessBinding Ref 不属于当前 Plan".to_string());
                }
                Ok(serde_json::json!({
                    "id": id,
                    "package_id": plan.harness_id,
                    "version": plan.harness_version,
                    "source_artifact_hash": plan.source_artifact_hash,
                    "binding_identity": id,
                }))
            }
            "CapabilitySet" => {
                let runtime_capability = extract_runtime_capability_ref(&plan.state_json);
                if runtime_capability.as_deref() != Some(id) {
                    return Err("CapabilitySet Ref 不属于当前 Plan 的 inherited authority".into());
                }
                let program: Program = serde_json::from_value(plan.program_json.clone())
                    .map_err(|error| format!("Plan Program 无法读取: {error}"))?;
                Ok(serde_json::json!({
                    "id": id,
                    "descriptions": program.typed_program().map(|typed| &typed.effects),
                }))
            }
            "Principal" if plan.initiating_principal_id.as_deref() == Some(id) => {
                Ok(serde_json::json!({"id": id, "policy_summary": "initiating-principal"}))
            }
            "Evidence" | "Outcome" => {
                let event = self
                    .store
                    .query(QueryFilter {
                        event_id: Some(id.to_string()),
                        context_id: Some(plan.context_id.clone()),
                        top_k: Some(1),
                        ..QueryFilter::default()
                    })
                    .await
                    .map_err(|error| error.to_string())?
                    .into_iter()
                    .next()
                    .ok_or_else(|| format!("Ref<{kind}> '{id}' 不存在于当前 Context"))?;
                let expected_operation = if kind == "Evidence" {
                    "evidence.commit"
                } else {
                    "outcome.commit"
                };
                if event.payload.get("operation").and_then(JsonValue::as_str)
                    != Some(expected_operation)
                {
                    return Err(format!("Event '{id}' 不是已提交的 Ref<{kind}>"));
                }
                Ok(serde_json::json!({
                    "id": event.id,
                    "kind": kind,
                    "content_hash": format!("sha256:{:x}", Sha256::digest(serde_json::to_vec(&event.payload).unwrap_or_default())),
                    "producer": event.actor,
                    "source": event.payload.get("plan_execution_id"),
                    "verification_status": "runtime-committed",
                    "references": event.payload.get("arguments"),
                }))
            }
            "ExecutionTarget" => {
                Err("当前 Plan 没有绑定可公开观察的 ExecutionTarget Ref".to_string())
            }
            _ => Err(format!(
                "Ref<{kind}> '{id}' 不属于当前 Plan 的 Host View authority"
            )),
        }
    }

    async fn materialize_parallel_children(
        &self,
        parent: &PlanExecutionRecord,
        effect: &PlanEffect,
        group_id: &str,
    ) -> PlanExecutionResult<Vec<PlanExecutionRecord>> {
        let PlanEffect::Parallel { sequence, branches } = effect else {
            return Err("只有 par effect 可以物化 branch Plans".into());
        };
        let expected_group_id = deterministic_plan_parallel_group_id(&parent.id, *sequence)?;
        if expected_group_id != group_id {
            return Err("par effect 与 Action Group 稳定身份不一致".into());
        }
        let mut output = Vec::with_capacity(branches.len());
        for branch in branches {
            let branch_call_id =
                deterministic_plan_parallel_branch_id(&parent.id, *sequence, &branch.name)?;
            let id = deterministic_plan_execution_id(&parent.activation_id, &branch_call_id)?;
            let program_json = serde_json::to_value(&branch.program)?;
            let state_json = serde_json::to_value(&branch.machine)?;
            let budget_json = branch.machine.budget_json()?;
            let source_artifact_hash = if parent.harness_id.is_some() {
                parent.source_artifact_hash.clone()
            } else if let Some(typed) = branch.program.typed_program() {
                typed.source_hash.clone()
            } else {
                format!(
                    "sha256:{:x}",
                    Sha256::digest(serde_json::to_vec(&program_json).unwrap_or_default())
                )
            };
            output.push(
                self.store
                    .create_plan_execution(NewPlanExecution {
                        id,
                        activation_id: parent.activation_id.clone(),
                        thread_id: parent.thread_id.clone(),
                        agent_id: parent.agent_id.clone(),
                        context_id: parent.context_id.clone(),
                        session_id: parent.session_id.clone(),
                        initiating_principal_id: parent.initiating_principal_id.clone(),
                        tool_call_id: branch_call_id,
                        objective_id: parent.objective_id.clone(),
                        objective_evaluation_id: parent.objective_evaluation_id.clone(),
                        harness_id: parent.harness_id.clone(),
                        harness_version: parent.harness_version.clone(),
                        source_artifact_hash,
                        ir_schema_version: parent.ir_schema_version,
                        program_json,
                        state_json,
                        budget_json,
                    })
                    .await?,
            );
        }
        Ok(output)
    }

    pub async fn ensure_parallel_children_for_waiting(
        &self,
        parent: &PlanExecutionRecord,
    ) -> PlanExecutionResult<Vec<PlanExecutionRecord>> {
        if parent.status != PlanExecutionStatus::Waiting
            || parent.pending_kind != Some(PlanExecutionWaitKind::ActionGroup)
        {
            return Err(format!(
                "PlanExecution '{}' 当前不是 waiting(action_group)",
                parent.id
            )
            .into());
        }
        let group_id = parent
            .pending_id
            .as_deref()
            .ok_or("waiting(action_group) 缺少 pending_id")?;
        let machine: PlanMachine = serde_json::from_value(parent.state_json.clone())?;
        let effect = machine
            .pending_effect()
            .ok_or("waiting(action_group) 缺少 pending par effect")?;
        self.materialize_parallel_children(parent, effect, group_id)
            .await
    }

    async fn materialize_program_child(
        &self,
        parent: &PlanExecutionRecord,
        effect: &PlanEffect,
        child_id: &str,
    ) -> PlanExecutionResult<PlanExecutionRecord> {
        let PlanEffect::Program {
            sequence,
            value,
            machine,
        } = effect
        else {
            return Err("只有 Program effect 可以物化 child Plan".into());
        };
        let expected_id =
            deterministic_plan_program_child_id(&parent.activation_id, &parent.id, *sequence)?;
        if expected_id != child_id {
            return Err("Program effect 与 child Plan 稳定身份不一致".into());
        }
        let child_call_id = deterministic_plan_program_call_id(&parent.id, *sequence)?;
        let program_json = serde_json::to_value(&value.program)?;
        let state_json = serde_json::to_value(machine.as_ref())?;
        let budget_json = machine.budget_json()?;
        self.store
            .create_plan_execution(NewPlanExecution {
                id: child_id.to_string(),
                activation_id: parent.activation_id.clone(),
                thread_id: parent.thread_id.clone(),
                agent_id: parent.agent_id.clone(),
                context_id: parent.context_id.clone(),
                session_id: parent.session_id.clone(),
                initiating_principal_id: parent.initiating_principal_id.clone(),
                tool_call_id: child_call_id,
                objective_id: parent.objective_id.clone(),
                objective_evaluation_id: parent.objective_evaluation_id.clone(),
                harness_id: parent.harness_id.clone(),
                harness_version: parent.harness_version.clone(),
                source_artifact_hash: if parent.harness_id.is_some() {
                    parent.source_artifact_hash.clone()
                } else {
                    value.hash.clone()
                },
                ir_schema_version: parent.ir_schema_version,
                program_json,
                state_json,
                budget_json,
            })
            .await
    }

    pub async fn ensure_program_child_for_waiting(
        &self,
        parent: &PlanExecutionRecord,
    ) -> PlanExecutionResult<PlanExecutionRecord> {
        if parent.status != PlanExecutionStatus::Waiting
            || parent.pending_kind != Some(PlanExecutionWaitKind::PlanExecution)
        {
            return Err(format!(
                "PlanExecution '{}' 当前不是 waiting(plan_execution)",
                parent.id
            )
            .into());
        }
        let child_id = parent
            .pending_id
            .as_deref()
            .ok_or("waiting(plan_execution) 缺少 pending_id")?;
        let machine: PlanMachine = serde_json::from_value(parent.state_json.clone())?;
        let effect = machine
            .pending_effect()
            .ok_or("waiting(plan_execution) 缺少 pending Program effect")?;
        self.materialize_program_child(parent, effect, child_id)
            .await
    }

    pub async fn reconcile_program_child(
        &self,
        plan_id: &str,
        child_id: &str,
    ) -> PlanExecutionResult<PlanResumeReceipt> {
        let Some(plan) = self.store.get_plan_execution(plan_id).await? else {
            return Ok(PlanResumeReceipt::Conflict {
                current: None,
                reason: format!("PlanExecution '{plan_id}' 不存在"),
            });
        };
        if plan.status != PlanExecutionStatus::Waiting
            || plan.pending_kind != Some(PlanExecutionWaitKind::PlanExecution)
            || plan.pending_id.as_deref() != Some(child_id)
        {
            return if plan.status.is_terminal()
                || matches!(
                    plan.status,
                    PlanExecutionStatus::Queued | PlanExecutionStatus::Running
                ) {
                Ok(PlanResumeReceipt::Existing(plan))
            } else {
                Ok(PlanResumeReceipt::Conflict {
                    current: Some(plan),
                    reason: "PlanExecution 没有等待该 child Plan".to_string(),
                })
            };
        }
        let mut machine: PlanMachine = serde_json::from_value(plan.state_json.clone())?;
        let effect = machine
            .pending_effect()
            .cloned()
            .ok_or("waiting(plan_execution) 的 PlanMachine 缺少 pending effect")?;
        let PlanEffect::Program {
            sequence, value, ..
        } = &effect
        else {
            return Err("waiting(plan_execution) 的 pending effect 不是 Program".into());
        };
        if deterministic_plan_program_child_id(&plan.activation_id, &plan.id, *sequence)?
            != child_id
        {
            return Err("Plan 与 Program child 的稳定身份不一致".into());
        }
        let child = self
            .materialize_program_child(&plan, &effect, child_id)
            .await?;
        if child.activation_id != plan.activation_id
            || child.thread_id != plan.thread_id
            || child.agent_id != plan.agent_id
            || child.context_id != plan.context_id
            || child.session_id != plan.session_id
            || child.source_artifact_hash
                != if plan.harness_id.is_some() {
                    plan.source_artifact_hash.clone()
                } else {
                    value.hash.clone()
                }
        {
            return Err("Program child Plan 与 parent route 或 Program hash 不一致".into());
        }
        if !child.status.is_terminal() {
            return Ok(PlanResumeReceipt::Conflict {
                current: Some(plan),
                reason: format!("Program child Plan '{child_id}' 尚未终结"),
            });
        }
        let outcome = match child.status {
            PlanExecutionStatus::Succeeded => {
                Ok(child.result_json.clone().unwrap_or(JsonValue::Null))
            }
            PlanExecutionStatus::Failed | PlanExecutionStatus::Cancelled => Err(child
                .error
                .clone()
                .unwrap_or_else(|| format!("child Plan status={}", child.status.as_str()))),
            _ => unreachable!("terminal checked above"),
        };
        machine.resume_effect(*sequence, outcome)?;
        let state_json = serde_json::to_value(&machine)?;
        let budget_json = machine.budget_json()?;
        match self
            .store
            .resume_plan_execution(
                &plan.id,
                plan.revision,
                PlanExecutionWaitKind::PlanExecution,
                child_id,
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
                reason: "Program child join revision 冲突".to_string(),
            }),
            PlanExecutionMutation::Rejected { current, reason } => {
                Ok(PlanResumeReceipt::Conflict { current, reason })
            }
            PlanExecutionMutation::NotFound => Ok(PlanResumeReceipt::Conflict {
                current: None,
                reason: format!("PlanExecution '{}' 在 Program child join 时消失", plan.id),
            }),
        }
    }

    /// Converges a durable `par` barrier from its child Plan terminal facts.
    /// Exact child/group identities come from the parent's persisted pending
    /// effect, so this method is safe after worker replacement and partial
    /// branch materialization.
    pub async fn reconcile_action_group(
        &self,
        plan_id: &str,
        group_id: &str,
    ) -> PlanExecutionResult<PlanResumeReceipt> {
        let Some(plan) = self.store.get_plan_execution(plan_id).await? else {
            return Ok(PlanResumeReceipt::Conflict {
                current: None,
                reason: format!("PlanExecution '{plan_id}' 不存在"),
            });
        };
        if plan.status != PlanExecutionStatus::Waiting
            || plan.pending_kind != Some(PlanExecutionWaitKind::ActionGroup)
            || plan.pending_id.as_deref() != Some(group_id)
        {
            return if plan.status.is_terminal()
                || matches!(
                    plan.status,
                    PlanExecutionStatus::Queued | PlanExecutionStatus::Running
                ) {
                Ok(PlanResumeReceipt::Existing(plan))
            } else {
                Ok(PlanResumeReceipt::Conflict {
                    current: Some(plan),
                    reason: "PlanExecution 没有等待该 Action Group".to_string(),
                })
            };
        }
        let mut machine: PlanMachine = serde_json::from_value(plan.state_json.clone())?;
        let effect = machine
            .pending_effect()
            .cloned()
            .ok_or("waiting(action_group) 的 PlanMachine 缺少 pending effect")?;
        let PlanEffect::Parallel { sequence, branches } = &effect else {
            return Err("waiting(action_group) 的 pending effect 不是 par".into());
        };
        if deterministic_plan_parallel_group_id(&plan.id, *sequence)? != group_id {
            return Err("Plan 与 Action Group 的稳定身份不一致".into());
        }
        let children = self
            .materialize_parallel_children(&plan, &effect, group_id)
            .await?;
        let group = self
            .store
            .get_action_group(group_id)
            .await?
            .ok_or_else(|| format!("Action Group '{group_id}' 不存在"))?;
        let settled_event = parallel_group_settled_event(&plan, &group);
        for (branch, child) in branches.iter().zip(children.iter()) {
            if !child.status.is_terminal() {
                return Ok(PlanResumeReceipt::Conflict {
                    current: Some(plan),
                    reason: format!("par branch '{}' 尚未终结", branch.name),
                });
            }
            let branch_call_id =
                deterministic_plan_parallel_branch_id(&plan.id, *sequence, &branch.name)?;
            let status = match child.status {
                PlanExecutionStatus::Succeeded => ActionGroupMemberStatus::Succeeded,
                PlanExecutionStatus::Failed => ActionGroupMemberStatus::Failed,
                PlanExecutionStatus::Cancelled => ActionGroupMemberStatus::Cancelled,
                _ => unreachable!("terminal checked above"),
            };
            let result_event =
                parallel_branch_result_event(&plan, group_id, &branch_call_id, &branch.name, child);
            self.store
                .commit_action_group_member_result(
                    group_id,
                    &branch_call_id,
                    status,
                    &result_event,
                    &settled_event,
                )
                .await?;
        }
        let group = self
            .store
            .get_action_group(group_id)
            .await?
            .ok_or_else(|| format!("Action Group '{group_id}' 在 join 前消失"))?;
        if group.status != ActionGroupStatus::Settled {
            return Ok(PlanResumeReceipt::Conflict {
                current: Some(plan),
                reason: format!("Action Group '{group_id}' 尚未 settled"),
            });
        }
        let mut values = Vec::with_capacity(branches.len());
        let mut failures = Vec::new();
        for (branch, child) in branches.iter().zip(children.iter()) {
            match child.status {
                PlanExecutionStatus::Succeeded => values.push((
                    branch.name.clone(),
                    child.result_json.clone().unwrap_or(JsonValue::Null),
                )),
                status => failures.push(format!(
                    "{}: {} ({})",
                    branch.name,
                    child.error.as_deref().unwrap_or("no error detail"),
                    status.as_str()
                )),
            }
        }
        let outcome = if failures.is_empty() {
            Ok(crate::yao::structural_record_value(values))
        } else {
            Err(failures.join("; "))
        };
        machine.resume_effect(*sequence, outcome)?;
        let state_json = serde_json::to_value(&machine)?;
        let budget_json = machine.budget_json()?;
        match self
            .store
            .resume_plan_execution(
                &plan.id,
                plan.revision,
                PlanExecutionWaitKind::ActionGroup,
                group_id,
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
                reason: "PlanExecution par join revision 冲突".to_string(),
            }),
            PlanExecutionMutation::Rejected { current, reason } => {
                Ok(PlanResumeReceipt::Conflict { current, reason })
            }
            PlanExecutionMutation::NotFound => Ok(PlanResumeReceipt::Conflict {
                current: None,
                reason: format!("PlanExecution '{}' 在 par join 时消失", plan.id),
            }),
        }
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
                lease_expires_at_or_before: Some(Utc::now()),
                include_terminal: false,
                limit: Some(limit.max(1)),
                ..PlanExecutionFilter::default()
            })
            .await?;
        let mut recovered = Vec::new();
        for plan in plans {
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
            .reconcile_plan_evaluation_activation(&plan.id, activation_id)
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
        let request_event = infer_request_event(&plan, &effect)?;
        let PlanEffect::Infer {
            sequence, result, ..
        } = effect
        else {
            return Err("PlanExecution 等待 Evaluation，但 pending effect 不是 infer".into());
        };
        if deterministic_infer_activation_id(&request_event.id)? != activation.id {
            return Err("child Activation 与 Plan infer effect 的稳定身份不一致".into());
        }
        let outcome = match outcome {
            Ok(value) => decode_infer_result_with_admission(
                result,
                value,
                &self.registry,
                ProgramValueProvenance {
                    parent_plan_execution_id: plan.id.clone(),
                    producer_evaluation_id: activation_id.to_string(),
                    terminal_event_id: None,
                    validation_version: "yao-0.1".to_string(),
                },
            ),
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
        self.reconcile_waiting_execution_jobs_page(context_id, None, None, limit)
            .await
    }

    pub async fn reconcile_waiting_execution_jobs_page(
        &self,
        context_id: Option<&str>,
        after_updated_at: Option<DateTime<Utc>>,
        after_id: Option<String>,
        limit: usize,
    ) -> PlanExecutionResult<PlanReconciliationReport> {
        let plans = self
            .store
            .list_plan_executions(PlanExecutionFilter {
                context_id: context_id.map(str::to_string),
                status: Some(PlanExecutionStatus::Waiting),
                pending_kind: Some(PlanExecutionWaitKind::ExecutionJob),
                include_terminal: false,
                oldest_first: true,
                after_updated_at,
                after_id,
                limit: Some(limit.max(1)),
                ..PlanExecutionFilter::default()
            })
            .await?;
        let mut report = PlanReconciliationReport {
            scanned: plans.len(),
            next_cursor: plans.last().map(|plan| (plan.updated_at, plan.id.clone())),
            ..PlanReconciliationReport::default()
        };
        for plan in plans {
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
        self.reconcile_waiting_evaluations_page(context_id, None, None, limit)
            .await
    }

    pub async fn reconcile_waiting_evaluations_page(
        &self,
        context_id: Option<&str>,
        after_updated_at: Option<DateTime<Utc>>,
        after_id: Option<String>,
        limit: usize,
    ) -> PlanExecutionResult<PlanReconciliationReport> {
        let plans = self
            .store
            .list_plan_executions(PlanExecutionFilter {
                context_id: context_id.map(str::to_string),
                status: Some(PlanExecutionStatus::Waiting),
                pending_kind: Some(PlanExecutionWaitKind::Evaluation),
                include_terminal: false,
                oldest_first: true,
                after_updated_at,
                after_id,
                limit: Some(limit.max(1)),
                ..PlanExecutionFilter::default()
            })
            .await?;
        let mut report = PlanReconciliationReport {
            scanned: plans.len(),
            next_cursor: plans.last().map(|plan| (plan.updated_at, plan.id.clone())),
            ..PlanReconciliationReport::default()
        };
        for plan in plans {
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

fn host_event_class(operation: &str) -> (&'static str, &'static str) {
    match operation {
        "evidence.commit" => ("evidence", "runtime/yao/evidence"),
        "outcome.commit" => ("outcome", "runtime/yao/outcome"),
        "objective.report"
        | "objective.propose-wait"
        | "objective.propose-completion"
        | "context.propose" => ("proposal", "runtime/yao/proposal"),
        _ => ("runtime_control", "runtime/yao/host_effect"),
    }
}

fn normalize_host_result(kind: InferResultKind, raw: JsonValue) -> Result<JsonValue, String> {
    let transport = match &kind {
        InferResultKind::Yao {
            ty: crate::yao::Type::Named(name),
            definitions,
            ..
        } => {
            let Some(crate::yao::TypeDefinition::Record { fields, .. }) = definitions.get(name)
            else {
                return Err(format!(
                    "host.view returns {name}，但它不是已声明的 record projection"
                ));
            };
            let object = raw
                .as_object()
                .ok_or_else(|| format!("host.view 无法把非 object 值投影为 {name}"))?;
            let selected = fields
                .iter()
                .map(|field| {
                    object
                        .get(&field.name)
                        .cloned()
                        .map(|value| {
                            normalize_host_projection_field(&field.ty, value, definitions)
                                .map(|value| (field.name.clone(), value))
                        })
                        .ok_or_else(|| {
                            format!("Host projection '{name}' 不提供字段 '{}'", field.name)
                        })?
                })
                .collect::<Result<serde_json::Map<_, _>, _>>()?;
            serde_json::json!({
                "$yao": {
                    "kind": "record",
                    "type": name,
                    "fields": selected,
                }
            })
        }
        InferResultKind::Yao {
            ty: crate::yao::Type::StructuralRecord(fields),
            definitions,
            ..
        } => {
            let object = raw
                .as_object()
                .ok_or("host.view structural return 需要 object projection")?;
            let selected = fields
                .iter()
                .map(|(name, ty)| {
                    object
                        .get(name)
                        .cloned()
                        .map(|value| {
                            normalize_host_projection_field(ty, value, definitions)
                                .map(|value| (name.clone(), value))
                        })
                        .ok_or_else(|| format!("Host projection 不提供字段 '{name}'"))?
                })
                .collect::<Result<serde_json::Map<_, _>, _>>()?;
            JsonValue::Object(selected)
        }
        InferResultKind::Yao {
            ty: crate::yao::Type::Json,
            ..
        }
        | InferResultKind::Json => raw,
        InferResultKind::Yao {
            ty: crate::yao::Type::Ref(_) | crate::yao::Type::Nil,
            ..
        } => raw,
        InferResultKind::Yao { ty, .. } => {
            return Err(format!(
                "Morphz Host operation 不允许把 authority projection 解码为 {ty:?}"
            ))
        }
        InferResultKind::Text => raw,
    };
    decode_infer_result(kind, transport)
}

fn normalize_host_projection_field(
    ty: &crate::yao::Type,
    raw: JsonValue,
    definitions: &std::collections::BTreeMap<String, crate::yao::TypeDefinition>,
) -> Result<JsonValue, String> {
    use crate::yao::Type;
    match ty {
        Type::Option(inner) => {
            if raw.is_null() {
                Ok(serde_json::json!({"$yao": {
                    "kind": "option",
                    "variant": "none"
                }}))
            } else {
                Ok(serde_json::json!({"$yao": {
                    "kind": "option",
                    "variant": "some",
                    "value": normalize_host_projection_field(inner, raw, definitions)?,
                }}))
            }
        }
        Type::List(element) => raw
            .as_array()
            .ok_or_else(|| format!("Host projection 不能把 {raw} 转为 List"))?
            .iter()
            .cloned()
            .map(|value| normalize_host_projection_field(element, value, definitions))
            .collect::<Result<Vec<_>, _>>()
            .map(JsonValue::Array),
        Type::Map(element) => raw
            .as_object()
            .ok_or_else(|| format!("Host projection 不能把 {raw} 转为 Map"))?
            .iter()
            .map(|(name, value)| {
                normalize_host_projection_field(element, value.clone(), definitions)
                    .map(|value| (name.clone(), value))
            })
            .collect::<Result<serde_json::Map<_, _>, _>>()
            .map(JsonValue::Object),
        Type::StructuralRecord(fields) => {
            let object = raw
                .as_object()
                .ok_or_else(|| format!("Host projection 不能把 {raw} 转为 structural record"))?;
            fields
                .iter()
                .map(|(name, ty)| {
                    let value = object
                        .get(name)
                        .cloned()
                        .ok_or_else(|| format!("Host projection 不提供字段 '{name}'"))?;
                    normalize_host_projection_field(ty, value, definitions)
                        .map(|value| (name.clone(), value))
                })
                .collect::<Result<serde_json::Map<_, _>, _>>()
                .map(JsonValue::Object)
        }
        Type::Named(name) => {
            let Some(crate::yao::TypeDefinition::Record { fields, .. }) = definitions.get(name)
            else {
                return Err(format!(
                    "Host projection 不支持嵌套的非 record Named type '{name}'"
                ));
            };
            let object = raw
                .as_object()
                .ok_or_else(|| format!("Host projection 不能把 {raw} 转为 {name}"))?;
            let fields = fields
                .iter()
                .map(|field| {
                    let value = object.get(&field.name).cloned().ok_or_else(|| {
                        format!("Host projection '{name}' 不提供字段 '{}'", field.name)
                    })?;
                    normalize_host_projection_field(&field.ty, value, definitions)
                        .map(|value| (field.name.clone(), value))
                })
                .collect::<Result<serde_json::Map<_, _>, _>>()?;
            Ok(serde_json::json!({"$yao": {
                "kind": "record",
                "type": name,
                "fields": fields,
            }}))
        }
        _ => Ok(raw),
    }
}

fn extract_runtime_capability_ref(state_json: &JsonValue) -> Option<String> {
    serde_json::from_value::<PlanMachine>(state_json.clone())
        .ok()?
        .runtime_reference_id("capabilities")
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

pub fn deterministic_plan_parallel_group_id(
    plan_execution_id: &str,
    sequence: u64,
) -> PlanExecutionResult<String> {
    stable_id(
        PAR_GROUP_ID_DOMAIN,
        "plan_par_group",
        plan_execution_id,
        &sequence.to_string(),
    )
}

pub fn deterministic_plan_parallel_branch_id(
    plan_execution_id: &str,
    sequence: u64,
    branch_name: &str,
) -> PlanExecutionResult<String> {
    let group_id = deterministic_plan_parallel_group_id(plan_execution_id, sequence)?;
    stable_id(
        PAR_BRANCH_ID_DOMAIN,
        "plan_par_branch",
        &group_id,
        branch_name,
    )
}

pub fn deterministic_plan_program_call_id(
    plan_execution_id: &str,
    sequence: u64,
) -> PlanExecutionResult<String> {
    stable_id(
        PROGRAM_CHILD_ID_DOMAIN,
        "plan_program_call",
        plan_execution_id,
        &sequence.to_string(),
    )
}

pub fn deterministic_plan_program_child_id(
    activation_id: &str,
    plan_execution_id: &str,
    sequence: u64,
) -> PlanExecutionResult<String> {
    let call_id = deterministic_plan_program_call_id(plan_execution_id, sequence)?;
    deterministic_plan_execution_id(activation_id, &call_id)
}

fn parallel_group_request(
    plan: &PlanExecutionRecord,
    effect: &PlanEffect,
    group_id: &str,
) -> PlanExecutionResult<(NewActionGroup, Vec<NewActionGroupMember>)> {
    let PlanEffect::Parallel { sequence, branches } = effect else {
        return Err("只有 par effect 可以创建 Action Group".into());
    };
    if branches.len() < 2 {
        return Err("par Action Group 至少需要两个 branch".into());
    }
    let members = branches
        .iter()
        .enumerate()
        .map(|(ordinal, branch)| {
            Ok(NewActionGroupMember {
                ordinal: u64::try_from(ordinal)?,
                tool_call_id: deterministic_plan_parallel_branch_id(
                    &plan.id,
                    *sequence,
                    &branch.name,
                )?,
                tool_name: format!("yao.par/{}", branch.name),
                execution_job_id: None,
            })
        })
        .collect::<PlanExecutionResult<Vec<_>>>()?;
    Ok((
        NewActionGroup {
            id: group_id.to_string(),
            activation_id: plan.activation_id.clone(),
            thread_id: plan.thread_id.clone(),
            agent_id: plan.agent_id.clone(),
            context_id: plan.context_id.clone(),
            session_id: plan.session_id.clone(),
            assistant_call_event_id: format!("plan_par_request_{}_{}", plan.id, sequence),
            objective_id: plan.objective_id.clone(),
            objective_evaluation_id: plan.objective_evaluation_id.clone(),
            objective_revision: None,
        },
        members,
    ))
}

fn parallel_branch_result_event(
    parent: &PlanExecutionRecord,
    group_id: &str,
    branch_call_id: &str,
    branch_name: &str,
    child: &PlanExecutionRecord,
) -> Event {
    let mut event = Event::new(
        format!("plan_par_result_{}", child.id),
        "Runtime-Yao".to_string(),
        "runtime_control".to_string(),
        "runtime/plan_branch_result".to_string(),
        serde_json::Map::from_iter([
            (
                "action_group_id".to_string(),
                JsonValue::String(group_id.to_string()),
            ),
            (
                "tool_call_id".to_string(),
                JsonValue::String(branch_call_id.to_string()),
            ),
            (
                "branch_name".to_string(),
                JsonValue::String(branch_name.to_string()),
            ),
            (
                "parent_plan_execution_id".to_string(),
                JsonValue::String(parent.id.clone()),
            ),
            (
                "plan_execution_id".to_string(),
                JsonValue::String(child.id.clone()),
            ),
            (
                "context_id".to_string(),
                JsonValue::String(parent.context_id.clone()),
            ),
            (
                "session_id".to_string(),
                JsonValue::String(parent.session_id.clone()),
            ),
            (
                "status".to_string(),
                JsonValue::String(child.status.as_str().to_string()),
            ),
            (
                "result".to_string(),
                child.result_json.clone().unwrap_or(JsonValue::Null),
            ),
            (
                "error".to_string(),
                child
                    .error
                    .clone()
                    .map(JsonValue::String)
                    .unwrap_or(JsonValue::Null),
            ),
            (
                "wake_policy".to_string(),
                JsonValue::String("none".to_string()),
            ),
        ]),
    );
    event.timestamp = child.finished_at.unwrap_or(child.updated_at);
    event
}

fn parallel_group_settled_event(parent: &PlanExecutionRecord, group: &ActionGroupRecord) -> Event {
    let mut event = Event::new(
        format!("plan_par_settled_{}", group.id),
        "Runtime-Yao".to_string(),
        "runtime_control".to_string(),
        "runtime/action_group_settled".to_string(),
        serde_json::Map::from_iter([
            (
                "action_group_id".to_string(),
                JsonValue::String(group.id.clone()),
            ),
            (
                "plan_execution_id".to_string(),
                JsonValue::String(parent.id.clone()),
            ),
            (
                "context_id".to_string(),
                JsonValue::String(parent.context_id.clone()),
            ),
            (
                "session_id".to_string(),
                JsonValue::String(parent.session_id.clone()),
            ),
            (
                "member_count".to_string(),
                JsonValue::from(group.member_count),
            ),
            (
                "wake_policy".to_string(),
                JsonValue::String("none".to_string()),
            ),
        ]),
    );
    event.timestamp = group.created_at;
    event
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
    let result_instruction = match result {
        crate::sexpr_eval::InferResultKind::Text => String::new(),
        crate::sexpr_eval::InferResultKind::Json => "本节点声明 returns=json；最终正文必须只包含一个完整、合法的 JSON 值，不要使用 Markdown 代码围栏或附加说明。".to_string(),
        crate::sexpr_eval::InferResultKind::Yao {
            ty: crate::yao::Type::Program { .. },
            ..
        } => "本节点要求返回一个 Yao Program Value 候选。最终正文必须只包含一个合法 JSON 对象，格式为 {\"source\":\"(eval ...)\"}；source 必须遵循 Context Encoding 中唯一的 Yao Language Card，不得包含 (version ...)；不要使用 Markdown 代码围栏、解释或额外字段。Runtime 将执行解析、类型检查、effect 上限校验、规范化、哈希与持久化，禁止直接执行源码字符串。".to_string(),
        crate::sexpr_eval::InferResultKind::Yao { ty, .. } => format!(
            "本节点声明 typed Yao 返回类型 {ty:?}；最终正文必须只包含该值的合法 JSON transport，不要使用 Markdown 代码围栏或附加说明。"
        ),
    };
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
                .unwrap_or_else(|| JsonValue::Array(Vec::new())),
        ),
        (
            "result_kind".to_string(),
            JsonValue::String(result.as_str().to_string()),
        ),
        (
            "text".to_string(),
            JsonValue::String(format!(
                "这是 Runtime 正在执行的 Yao 程序提出的内部 infer 请求。请根据 request 中的任务与证据完成判断；可使用 tools 声明允许的工具补充证据。最终正文只返回供父 Plan 继续求值的结果，不要把它当作用户消息。{}\n\n{}",
                result_instruction,
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

/// Reconstructs the immutable infer request owned by a waiting Plan. This is
/// used by the live reconciler to redispatch a durable pending Signal when the
/// asynchronous router has not yet materialized its deterministic child
/// Activation.
pub fn pending_infer_request_event(plan: &PlanExecutionRecord) -> PlanExecutionResult<Event> {
    if plan.status != PlanExecutionStatus::Waiting
        || plan.pending_kind != Some(PlanExecutionWaitKind::Evaluation)
    {
        return Err(format!("PlanExecution '{}' 当前没有等待 infer Evaluation", plan.id).into());
    }
    let machine: PlanMachine = serde_json::from_value(plan.state_json.clone())?;
    let effect = machine
        .pending_effect()
        .ok_or_else(|| format!("PlanExecution '{}' 缺少 pending infer effect", plan.id))?;
    let event = infer_request_event(plan, effect)?;
    let activation_id = deterministic_infer_activation_id(&event.id)?;
    if plan.pending_id.as_deref() != Some(activation_id.as_str()) {
        return Err(format!(
            "PlanExecution '{}' 的 pending Evaluation 与 infer Event 不一致",
            plan.id
        )
        .into());
    }
    Ok(event)
}

pub fn deterministic_infer_activation_id(event_id: &str) -> PlanExecutionResult<String> {
    if event_id.trim().is_empty() {
        return Err("infer request Event id 不能为空".into());
    }
    Ok(stable_thread_activation_id(event_id))
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
        ActivationStore, EventStore, ExecutionJobFilter, ExecutionJobMutation, ExecutionJobStore,
        ExecutionJobTerminal, ExecutionRetrySafety, NewCognitiveContext, NewSession, NewThread,
        NewThreadActivation, NewThreadSignal, PlanExecutionStore, SessionDirectoryStore,
        SessionMountKind, ThreadActivationMutation, ThreadKind, ThreadStore,
    };
    use crate::sexpr_eval::{
        admit_program_value_candidate, validate, AllowList, PlanProgramValue,
        ProgramValueProvenance,
    };
    use crate::tool::Tool;
    use chrono::Duration;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
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
            .create_test_context(NewCognitiveContext {
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
    async fn runtime_context_is_injected_and_host_view_replays_its_immutable_receipt() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp_file.path().to_str().unwrap())
                .await
                .unwrap(),
        );
        let registry = Arc::new(Registry::new());
        let program = validate(
            r#"(eval
                 (host.view $runtime.context (returns Json)))"#,
            &registry,
            &AllowList::new(std::iter::empty::<&str>()),
        )
        .unwrap();
        let route = seed_route(&store).await;
        let expected_context_id = route.context_id.clone();
        let runtime_store: Arc<dyn RuntimeStore> = store.clone();
        let coordinator = PlanExecutionCoordinator::new(runtime_store, registry);
        let queued = coordinator
            .ensure(route, &program, PlanArtifactBinding::default())
            .await
            .unwrap();
        assert_eq!(
            queued.source_artifact_hash,
            program.typed_program().unwrap().source_hash
        );

        let mut machine: PlanMachine = serde_json::from_value(queued.state_json.clone()).unwrap();
        assert_eq!(
            machine.runtime_reference_id("context").as_deref(),
            Some(expected_context_id.as_str())
        );
        let effect = match machine.advance(&coordinator.registry) {
            PlanAdvance::Suspended(effect @ PlanEffect::Host { .. }) => effect,
            other => panic!("expected Host boundary, got {other:?}"),
        };
        let first = coordinator
            .execute_host_effect(&queued, &effect)
            .await
            .unwrap();
        let replay = coordinator
            .execute_host_effect(&queued, &effect)
            .await
            .unwrap();
        assert_eq!(first, replay);
        assert_eq!(first["id"], expected_context_id);
        let receipt_id = deterministic_plan_effect_id(&queued.id, effect.sequence()).unwrap();
        let receipts = store
            .query(QueryFilter {
                event_id: Some(receipt_id),
                context_id: Some(queued.context_id.clone()),
                ..QueryFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(receipts.len(), 1, "replay must not append a second Event");

        match coordinator
            .drive_once(
                &queued.id,
                queued.revision,
                "host-worker",
                "host-claim",
                Utc::now() + Duration::minutes(1),
                &TestPlanner,
            )
            .await
            .unwrap()
        {
            PlanDriveReceipt::Succeeded { value, .. } => assert_eq!(value, first),
            other => panic!("expected completed host Plan, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn host_view_normalizes_optional_fields_into_typed_yao_values() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp_file.path().to_str().unwrap())
                .await
                .unwrap(),
        );
        let registry = Arc::new(Registry::new());
        let program = validate(
            r#"(eval
                 (types
                   (record ContextProjection
                     (id String)
                     (revision (Option Int))))
                 (host.view $runtime.context (returns ContextProjection)))"#,
            &registry,
            &AllowList::new(std::iter::empty::<&str>()),
        )
        .unwrap();
        let route = seed_route(&store).await;
        let runtime_store: Arc<dyn RuntimeStore> = store.clone();
        let coordinator = PlanExecutionCoordinator::new(runtime_store, registry);
        let queued = coordinator
            .ensure(route, &program, PlanArtifactBinding::default())
            .await
            .unwrap();
        let value = match coordinator
            .drive_once(
                &queued.id,
                queued.revision,
                "typed-view-worker",
                "typed-view-claim",
                Utc::now() + Duration::minutes(1),
                &TestPlanner,
            )
            .await
            .unwrap()
        {
            PlanDriveReceipt::Succeeded { value, .. } => value,
            other => panic!("expected typed Host view, got {other:?}"),
        };
        assert_eq!(value["$yao"]["type"], "ContextProjection");
        assert_eq!(
            value["$yao"]["fields"]["revision"]["$yao"]["variant"],
            "none"
        );
    }

    #[tokio::test]
    async fn evidence_and_outcome_candidates_commit_once_and_return_opaque_refs() {
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
                   (bind checked
                     (evidence.commit
                       (evidence
                         (kind "test-result")
                         (value (dict (passed true)))
                         (refs))))
                   (outcome.commit
                     (outcome
                       (status succeeded)
                       (value (dict (summary "verified")))
                       (evidence $checked)))))"#,
            &registry,
            &AllowList::new(std::iter::empty::<&str>()),
        )
        .unwrap();
        let route = seed_route(&store).await;
        let runtime_store: Arc<dyn RuntimeStore> = store.clone();
        let coordinator = PlanExecutionCoordinator::new(runtime_store, registry);
        let queued = coordinator
            .ensure(route, &program, PlanArtifactBinding::default())
            .await
            .unwrap();

        let value = match coordinator
            .drive_once(
                &queued.id,
                queued.revision,
                "commit-worker",
                "commit-claim",
                Utc::now() + Duration::minutes(1),
                &TestPlanner,
            )
            .await
            .unwrap()
        {
            PlanDriveReceipt::Succeeded { value, .. } => value,
            other => panic!("expected committed Outcome, got {other:?}"),
        };
        let (kind, outcome_id) = crate::yao::reference_view(&value).unwrap();
        assert_eq!(kind, "Outcome");
        let evidence_id = deterministic_plan_effect_id(&queued.id, 1).unwrap();
        assert_eq!(
            outcome_id,
            deterministic_plan_effect_id(&queued.id, 2).unwrap()
        );
        for (id, operation) in [
            (evidence_id, "evidence.commit"),
            (outcome_id.to_string(), "outcome.commit"),
        ] {
            let events = store
                .query(QueryFilter {
                    event_id: Some(id),
                    context_id: Some(queued.context_id.clone()),
                    ..QueryFilter::default()
                })
                .await
                .unwrap();
            assert_eq!(events.len(), 1);
            assert_eq!(
                events[0].payload["operation"],
                JsonValue::String(operation.to_string())
            );
        }
    }

    #[tokio::test]
    async fn host_commit_rejects_forged_candidates_and_uncommitted_reference_kinds() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp_file.path().to_str().unwrap())
                .await
                .unwrap(),
        );
        let registry = Arc::new(Registry::new());
        let program = validate(
            r#"(eval (evidence.commit
                 (evidence (kind "test-result") (value true) (refs))))"#,
            &registry,
            &AllowList::new(std::iter::empty::<&str>()),
        )
        .unwrap();
        let route = seed_route(&store).await;
        let runtime_store: Arc<dyn RuntimeStore> = store.clone();
        let coordinator = PlanExecutionCoordinator::new(runtime_store, registry);
        let queued = coordinator
            .ensure(route, &program, PlanArtifactBinding::default())
            .await
            .unwrap();

        let forged = serde_json::Map::from_iter([(
            "candidate".to_string(),
            serde_json::json!({"$yao": {
                "kind": "evidence_candidate",
                "evidence_kind": "test-result",
                "value": true,
                "refs": [],
                "injected": true
            }}),
        )]);
        let error = coordinator
            .execute_new_host_operation(&queued, "forged", "evidence.commit", &forged)
            .await
            .unwrap_err();
        assert!(error.contains("EvidenceCandidate"), "got: {error}");

        let unrelated = Event::new(
            "not-committed-evidence".to_string(),
            "Test".to_string(),
            "observation".to_string(),
            "test/unrelated".to_string(),
            serde_json::json!({"context_id": queued.context_id})
                .as_object()
                .unwrap()
                .clone(),
        );
        store.append(unrelated).await.unwrap();
        let wrong_origin = serde_json::Map::from_iter([(
            "candidate".to_string(),
            serde_json::json!({"$yao": {
                "kind": "outcome_candidate",
                "status": "succeeded",
                "value": null,
                "evidence": [crate::yao::reference_value("Evidence", "not-committed-evidence")]
            }}),
        )]);
        let error = coordinator
            .execute_new_host_operation(&queued, "wrong-origin", "outcome.commit", &wrong_origin)
            .await
            .unwrap_err();
        assert!(error.contains("不是 Runtime 提交"), "got: {error}");

        let unauthorized_objective = serde_json::Map::from_iter([
            (
                "objective".to_string(),
                crate::yao::reference_value("Objective", "foreign-objective"),
            ),
            ("progress".to_string(), serde_json::json!({"done": true})),
        ]);
        let error = coordinator
            .execute_new_host_operation(
                &queued,
                "wrong-objective",
                "objective.report",
                &unauthorized_objective,
            )
            .await
            .unwrap_err();
        assert!(error.contains("没有 Objective authority"), "got: {error}");
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
    async fn waiting_plan_keyset_pages_do_not_starve_a_later_terminal_child() {
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
        let first_route = seed_route(&store).await;
        let mut second_route = first_route.clone();
        second_route.tool_call_id = "outer-eval-call-second".to_string();
        let runtime_store: Arc<dyn RuntimeStore> = store.clone();
        let coordinator = PlanExecutionCoordinator::new(runtime_store, registry);

        let first = coordinator
            .ensure(first_route, &program, PlanArtifactBinding::default())
            .await
            .unwrap();
        let first_waiting = match coordinator
            .drive_once(
                &first.id,
                first.revision,
                "plan-worker-first",
                "plan-claim-first",
                Utc::now() + Duration::minutes(1),
                &TestPlanner,
            )
            .await
            .unwrap()
        {
            PlanDriveReceipt::WaitingForExecutionJob { plan, .. } => plan,
            other => panic!("expected first waiting plan, got {other:?}"),
        };
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        let second = coordinator
            .ensure(second_route, &program, PlanArtifactBinding::default())
            .await
            .unwrap();
        let (second_waiting, second_job) = match coordinator
            .drive_once(
                &second.id,
                second.revision,
                "plan-worker-second",
                "plan-claim-second",
                Utc::now() + Duration::minutes(1),
                &TestPlanner,
            )
            .await
            .unwrap()
        {
            PlanDriveReceipt::WaitingForExecutionJob { plan, job, .. } => (plan, job),
            other => panic!("expected second waiting plan, got {other:?}"),
        };
        let running_job = updated_job(
            store
                .claim_execution_job(
                    &second_job.id,
                    second_job.revision,
                    "execution-worker",
                    "job-claim-second",
                    Utc::now() + Duration::minutes(1),
                    None,
                )
                .await
                .unwrap(),
        );
        let result_event = Event::new(
            "plan-second-result".to_string(),
            "Test-Executor".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            serde_json::Map::from_iter([
                (
                    "context_id".to_string(),
                    serde_json::json!(second_job.context_id),
                ),
                (
                    "session_id".to_string(),
                    serde_json::json!(second_job.session_id),
                ),
                (
                    "activation_id".to_string(),
                    serde_json::json!(second_job.activation_id),
                ),
                (
                    "thread_id".to_string(),
                    serde_json::json!(second_job.thread_id),
                ),
                (
                    "tool_call_id".to_string(),
                    serde_json::json!(second_job.tool_call_id),
                ),
                ("tool_name".to_string(), serde_json::json!("read")),
                ("tool_status".to_string(), serde_json::json!("success")),
                ("text".to_string(), serde_json::json!("second result")),
            ]),
        );
        updated_job(
            store
                .finish_execution_job_with_event(
                    &running_job.id,
                    running_job.revision,
                    Some("job-claim-second"),
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

        let first_page = coordinator
            .reconcile_waiting_execution_jobs_page(None, None, None, 1)
            .await
            .unwrap();
        assert_eq!(first_page.still_waiting, vec![first_waiting.id]);
        assert!(first_page.resumed.is_empty());
        let (updated_at, id) = first_page.next_cursor.unwrap();
        let second_page = coordinator
            .reconcile_waiting_execution_jobs_page(None, Some(updated_at), Some(id), 1)
            .await
            .unwrap();
        assert_eq!(second_page.resumed.len(), 1);
        assert_eq!(second_page.resumed[0].id, second_waiting.id);
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
                       (returns Json)
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
        assert_eq!(request_event.payload["result_kind"], "yao");

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
        let stored_request = store
            .query(QueryFilter {
                event_id: Some(request_event.id.clone()),
                context_id: Some(waiting.context_id.clone()),
                top_k: Some(1),
                ..QueryFilter::default()
            })
            .await
            .unwrap()
            .into_iter()
            .next()
            .expect("atomic infer hand-off must persist its trigger Event");
        let trigger_sequence = stored_request
            .sequence
            .expect("persisted infer request must own a sequence");
        let child_activation = store
            .claim_thread_signal_batch(
                NewThreadSignal {
                    id: crate::memory::stable_thread_signal_id(&request_event.id),
                    thread_id: child_thread.id.clone(),
                    thread_generation: child_thread.generation,
                    event_id: request_event.id.clone(),
                    principal_id: waiting.initiating_principal_id.clone(),
                    sequence: trigger_sequence,
                    kind: request_event.topic.clone(),
                    parent_activation_id: Some(waiting.activation_id.clone()),
                },
                NewThreadActivation {
                    id: activation_id.clone(),
                    agent_id: waiting.agent_id.clone(),
                    context_id: waiting.context_id.clone(),
                    session_id: waiting.session_id.clone(),
                    initiating_principal_id: waiting.initiating_principal_id.clone(),
                    trigger_event_id: request_event.id.clone(),
                    trigger_sequence,
                    trigger_kind: request_event.topic.clone(),
                    parent_activation_id: Some(waiting.activation_id.clone()),
                    root_turn_id: request_event.id.clone(),
                },
                crate::memory::DEFAULT_THREAD_SIGNAL_BATCH_LIMIT,
            )
            .await
            .unwrap()
            .expect("pending infer Signal must materialize its deterministic child Activation");
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

        // Emulate the exact pre-fix direct-Signal row shape observed in a
        // production database: the Signal was claimed, the linked child
        // Activation completed, but neither projection retained the explicit
        // Plan parent. Recovery may fill only these NULLs after validating the
        // complete deterministic route.
        let raw_pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(SqliteConnectOptions::new().filename(tmp_file.path()))
            .await
            .unwrap();
        sqlx::query("UPDATE thread_signals SET parent_activation_id = NULL WHERE event_id = ?")
            .bind(&request_event.id)
            .execute(&raw_pool)
            .await
            .unwrap();
        sqlx::query("UPDATE thread_activations SET parent_activation_id = NULL WHERE id = ?")
            .bind(&activation_id)
            .execute(&raw_pool)
            .await
            .unwrap();
        sqlx::query("UPDATE thread_activations SET parent_activation_id = ? WHERE id = ?")
            .bind(&activation_id)
            .bind(&activation_id)
            .execute(&raw_pool)
            .await
            .unwrap();
        assert!(store
            .reconcile_plan_evaluation_activation(&waiting.id, &activation_id)
            .await
            .is_err());
        let conflicting_parent: Option<String> =
            sqlx::query_scalar("SELECT parent_activation_id FROM thread_activations WHERE id = ?")
                .bind(&activation_id)
                .fetch_one(&raw_pool)
                .await
                .unwrap();
        assert_eq!(conflicting_parent.as_deref(), Some(activation_id.as_str()));
        sqlx::query("UPDATE thread_activations SET parent_activation_id = NULL WHERE id = ?")
            .bind(&activation_id)
            .execute(&raw_pool)
            .await
            .unwrap();
        raw_pool.close().await;

        let resumed = match coordinator
            .reconcile_evaluation(&waiting.id, &activation_id)
            .await
            .unwrap()
        {
            PlanResumeReceipt::Queued(plan) => plan,
            other => panic!("expected queued plan after infer refill, got {other:?}"),
        };
        let repaired_activation = store
            .get_thread_activation(&activation_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            repaired_activation.parent_activation_id.as_deref(),
            Some(waiting.activation_id.as_str())
        );
        let repaired_signal = store
            .list_context_thread_signals(&waiting.context_id, None)
            .await
            .unwrap()
            .into_iter()
            .find(|signal| signal.event_id == request_event.id)
            .unwrap();
        assert_eq!(
            repaired_signal.parent_activation_id.as_deref(),
            Some(waiting.activation_id.as_str())
        );
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
                 (types (record ReadDecision (path String)))
                 (seq
                   (bind decision
                     (infer
                       (task "返回后续 read 的结构化决策")
                       (returns ReadDecision)))
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
        let stored_request = store
            .query(QueryFilter {
                event_id: Some(request_event.id.clone()),
                context_id: Some(waiting.context_id.clone()),
                top_k: Some(1),
                ..QueryFilter::default()
            })
            .await
            .unwrap()
            .into_iter()
            .next()
            .expect("atomic infer hand-off must persist its trigger Event");
        let trigger_sequence = stored_request
            .sequence
            .expect("persisted infer request must own a sequence");
        let child_activation = store
            .claim_thread_signal_batch(
                NewThreadSignal {
                    id: crate::memory::stable_thread_signal_id(&request_event.id),
                    thread_id: child_thread.id.clone(),
                    thread_generation: child_thread.generation,
                    event_id: request_event.id.clone(),
                    principal_id: waiting.initiating_principal_id.clone(),
                    sequence: trigger_sequence,
                    kind: request_event.topic.clone(),
                    parent_activation_id: Some(waiting.activation_id.clone()),
                },
                NewThreadActivation {
                    id: activation_id.clone(),
                    agent_id: waiting.agent_id.clone(),
                    context_id: waiting.context_id.clone(),
                    session_id: waiting.session_id.clone(),
                    initiating_principal_id: waiting.initiating_principal_id.clone(),
                    trigger_event_id: request_event.id.clone(),
                    trigger_sequence,
                    trigger_kind: request_event.topic.clone(),
                    parent_activation_id: Some(waiting.activation_id.clone()),
                    root_turn_id: request_event.id.clone(),
                },
                crate::memory::DEFAULT_THREAD_SIGNAL_BATCH_LIMIT,
            )
            .await
            .unwrap()
            .expect("pending infer Signal must materialize its deterministic child Activation");
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

    #[tokio::test]
    async fn typed_par_materializes_durable_child_plans_and_recovers_the_join() {
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
                 (par
                   (branch alpha (call read (path "a")))
                   (branch beta (call read (path "b")))))"#,
            &registry,
            &AllowList::new(["read"]),
        )
        .unwrap();
        let route = seed_route(&store).await;
        let runtime_store: Arc<dyn RuntimeStore> = store.clone();
        let coordinator = PlanExecutionCoordinator::new(runtime_store, Arc::clone(&registry));
        let queued = coordinator
            .ensure(route, &program, PlanArtifactBinding::default())
            .await
            .unwrap();
        let (parent, group, children) = match coordinator
            .drive_once(
                &queued.id,
                queued.revision,
                "par-parent-worker",
                "par-parent-claim",
                Utc::now() + Duration::minutes(1),
                &TestPlanner,
            )
            .await
            .unwrap()
        {
            PlanDriveReceipt::WaitingForActionGroup {
                plan,
                group,
                children,
                existing,
            } => {
                assert!(!existing);
                (plan, group, children)
            }
            other => panic!("expected Action Group suspension, got {other:?}"),
        };
        assert_eq!(
            parent.pending_kind,
            Some(PlanExecutionWaitKind::ActionGroup)
        );
        assert_eq!(children.len(), 2);
        assert_eq!(group.member_count, 2);
        let replayed_children = coordinator
            .ensure_parallel_children_for_waiting(&parent)
            .await
            .unwrap();
        assert_eq!(
            replayed_children
                .iter()
                .map(|child| child.id.as_str())
                .collect::<Vec<_>>(),
            children
                .iter()
                .map(|child| child.id.as_str())
                .collect::<Vec<_>>(),
            "recovery must materialize the same child identities"
        );
        for child in &children {
            assert_eq!(
                child.source_artifact_hash,
                child.program_json["root"]["program"]["source_hash"]
                    .as_str()
                    .unwrap()
            );
        }

        for (index, child) in children.into_iter().enumerate() {
            let (waiting_child, job) = match coordinator
                .drive_once(
                    &child.id,
                    child.revision,
                    &format!("par-child-worker-{index}"),
                    &format!("par-child-claim-{index}"),
                    Utc::now() + Duration::minutes(1),
                    &TestPlanner,
                )
                .await
                .unwrap()
            {
                PlanDriveReceipt::WaitingForExecutionJob { plan, job, .. } => (plan, job),
                other => panic!("expected branch ExecutionJob, got {other:?}"),
            };
            let job_claim = format!("par-job-claim-{index}");
            let running_job = updated_job(
                store
                    .claim_execution_job(
                        &job.id,
                        job.revision,
                        "par-job-worker",
                        &job_claim,
                        Utc::now() + Duration::minutes(1),
                        None,
                    )
                    .await
                    .unwrap(),
            );
            let result_event = Event::new(
                format!("par-tool-result-{index}"),
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
                    (
                        "text".to_string(),
                        serde_json::json!(format!("value-{index}")),
                    ),
                ]),
            );
            updated_job(
                store
                    .finish_execution_job_with_event(
                        &running_job.id,
                        running_job.revision,
                        Some(&job_claim),
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
            let resumed = match coordinator
                .reconcile_execution_job(&waiting_child.id, &job.id)
                .await
                .unwrap()
            {
                PlanResumeReceipt::Queued(plan) => plan,
                other => panic!("expected queued branch after tool result, got {other:?}"),
            };
            match coordinator
                .drive_once(
                    &resumed.id,
                    resumed.revision,
                    &format!("par-child-finish-worker-{index}"),
                    &format!("par-child-finish-claim-{index}"),
                    Utc::now() + Duration::minutes(1),
                    &TestPlanner,
                )
                .await
                .unwrap()
            {
                PlanDriveReceipt::Succeeded { plan, value } => {
                    assert_eq!(plan.status, PlanExecutionStatus::Succeeded);
                    assert_eq!(value, serde_json::json!(format!("value-{index}")));
                }
                other => panic!("expected terminal branch, got {other:?}"),
            }
            if index == 0 {
                match coordinator
                    .reconcile_action_group(&parent.id, &group.id)
                    .await
                    .unwrap()
                {
                    PlanResumeReceipt::Conflict { current, reason } => {
                        assert_eq!(
                            current.unwrap().status,
                            PlanExecutionStatus::Waiting,
                            "a terminal prefix must not release the parent barrier"
                        );
                        assert!(reason.contains("尚未终结"), "got: {reason}");
                    }
                    other => panic!("par joined before every branch settled: {other:?}"),
                }
            }
        }

        drop(coordinator);
        let runtime_store: Arc<dyn RuntimeStore> = store.clone();
        let restarted = PlanExecutionCoordinator::new(runtime_store, registry);
        let resumed_parent = match restarted
            .reconcile_action_group(&parent.id, &group.id)
            .await
            .unwrap()
        {
            PlanResumeReceipt::Queued(plan) => plan,
            other => panic!("expected parent queued after recovered join, got {other:?}"),
        };
        match restarted
            .drive_once(
                &resumed_parent.id,
                resumed_parent.revision,
                "par-parent-finish-worker",
                "par-parent-finish-claim",
                Utc::now() + Duration::minutes(1),
                &TestPlanner,
            )
            .await
            .unwrap()
        {
            PlanDriveReceipt::Succeeded { value, .. } => {
                let fields = value["$yao"]["fields"].as_array().unwrap();
                assert_eq!(fields[0]["name"], "alpha");
                assert_eq!(fields[0]["value"], "value-0");
                assert_eq!(fields[1]["name"], "beta");
                assert_eq!(fields[1]["value"], "value-1");
            }
            other => panic!("expected joined parent completion, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn typed_par_aggregates_failure_only_after_every_branch_is_terminal() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp_file.path().to_str().unwrap())
                .await
                .unwrap(),
        );
        let registry = Arc::new(Registry::new());
        let program = validate(
            r#"(eval
                 (par
                   (branch broken
                     (seq (host.view $runtime.context (returns Json)) (div 1 0)))
                   (branch healthy
                     (host.view $runtime.context (returns Json)))))"#,
            &registry,
            &AllowList::new(std::iter::empty::<&str>()),
        )
        .unwrap();
        let route = seed_route(&store).await;
        let runtime_store: Arc<dyn RuntimeStore> = store.clone();
        let coordinator = PlanExecutionCoordinator::new(runtime_store, registry);
        let queued = coordinator
            .ensure(route, &program, PlanArtifactBinding::default())
            .await
            .unwrap();
        let (parent, group, children) = match coordinator
            .drive_once(
                &queued.id,
                queued.revision,
                "failure-parent-worker",
                "failure-parent-claim",
                Utc::now() + Duration::minutes(1),
                &TestPlanner,
            )
            .await
            .unwrap()
        {
            PlanDriveReceipt::WaitingForActionGroup {
                plan,
                group,
                children,
                ..
            } => (plan, group, children),
            other => panic!("expected par suspension, got {other:?}"),
        };

        match coordinator
            .drive_once(
                &children[0].id,
                children[0].revision,
                "broken-worker",
                "broken-claim",
                Utc::now() + Duration::minutes(1),
                &TestPlanner,
            )
            .await
            .unwrap()
        {
            PlanDriveReceipt::Failed { error, .. } => {
                assert!(error.contains("zero"), "got: {error}")
            }
            other => panic!("broken branch should fail, got {other:?}"),
        }
        assert!(matches!(
            coordinator
                .reconcile_action_group(&parent.id, &group.id)
                .await
                .unwrap(),
            PlanResumeReceipt::Conflict { .. }
        ));

        assert!(matches!(
            coordinator
                .drive_once(
                    &children[1].id,
                    children[1].revision,
                    "healthy-worker",
                    "healthy-claim",
                    Utc::now() + Duration::minutes(1),
                    &TestPlanner,
                )
                .await
                .unwrap(),
            PlanDriveReceipt::Succeeded { .. }
        ));
        let resumed = match coordinator
            .reconcile_action_group(&parent.id, &group.id)
            .await
            .unwrap()
        {
            PlanResumeReceipt::Queued(plan) => plan,
            other => panic!("expected failed aggregate to queue parent, got {other:?}"),
        };
        match coordinator
            .drive_once(
                &resumed.id,
                resumed.revision,
                "failure-parent-finish-worker",
                "failure-parent-finish-claim",
                Utc::now() + Duration::minutes(1),
                &TestPlanner,
            )
            .await
            .unwrap()
        {
            PlanDriveReceipt::Failed { error, .. } => {
                assert!(error.contains("broken"), "got: {error}");
                assert!(error.contains("zero"), "got: {error}");
            }
            other => panic!("parent should receive aggregate failure, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn admitted_program_value_runs_as_a_durable_child_and_recovers_the_join() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp_file.path().to_str().unwrap())
                .await
                .unwrap(),
        );
        let registry = Arc::new(Registry::new());
        let parent_program = validate(
            r#"(eval
                 (seq
                   (bind generated
                     (infer
                       (task "produce a pure integer program")
                       (returns (Program Int (effects)))))
                   (run $generated)))"#,
            &registry,
            &AllowList::new(Vec::<String>::new()),
        )
        .unwrap();
        let mut parent_machine = PlanMachine::new(&parent_program).unwrap();
        let infer = match parent_machine.advance(&registry) {
            PlanAdvance::Suspended(effect @ PlanEffect::Infer { .. }) => effect,
            other => panic!("expected Program-producing infer, got {other:?}"),
        };
        let PlanEffect::Infer { result, .. } = infer.clone() else {
            unreachable!()
        };
        let crate::sexpr_eval::InferResultKind::Yao {
            ty: crate::yao::Type::Program { output, effects },
            ..
        } = result
        else {
            panic!("infer did not retain its Program contract")
        };
        let admitted = admit_program_value_candidate(
            &output,
            &effects,
            serde_json::json!({"source": r#"(eval (add 20 22))"#}),
            &registry,
            ProgramValueProvenance {
                parent_plan_execution_id: "durable-parent".into(),
                producer_evaluation_id: "durable-evaluation".into(),
                terminal_event_id: Some("durable-terminal-event".into()),
                validation_version: "yao-0.1".into(),
            },
        )
        .unwrap();
        parent_machine
            .resume_effect(infer.sequence(), Ok(admitted))
            .unwrap();

        let route = seed_route(&store).await;
        let parent_id =
            deterministic_plan_execution_id(&route.activation_id, &route.tool_call_id).unwrap();
        let parent = store
            .create_plan_execution(NewPlanExecution {
                id: parent_id,
                activation_id: route.activation_id,
                thread_id: route.thread_id,
                agent_id: route.agent_id,
                context_id: route.context_id,
                session_id: route.session_id,
                initiating_principal_id: route.initiating_principal_id,
                tool_call_id: route.tool_call_id,
                objective_id: route.objective_id,
                objective_evaluation_id: route.objective_evaluation_id,
                harness_id: None,
                harness_version: None,
                source_artifact_hash: "sha256:parent".into(),
                ir_schema_version: 1,
                program_json: serde_json::to_value(&parent_program).unwrap(),
                state_json: serde_json::to_value(&parent_machine).unwrap(),
                budget_json: parent_machine.budget_json().unwrap(),
            })
            .await
            .unwrap();
        let request_event = infer_request_event(&parent, &infer).unwrap();
        assert_eq!(request_event.payload["tools"], serde_json::json!([]));
        let instruction = request_event.payload["text"].as_str().unwrap();
        assert!(instruction.contains("{\"source\":\"(eval ...)\"}"));
        assert!(instruction.contains("唯一的 Yao Language Card"));
        assert!(instruction.contains("不得包含 (version ...)"));
        assert!(instruction.contains("禁止直接执行源码字符串"));
        let runtime_store: Arc<dyn RuntimeStore> = store.clone();
        let coordinator = PlanExecutionCoordinator::new(runtime_store, Arc::clone(&registry));
        let (waiting_parent, child) = match coordinator
            .drive_once(
                &parent.id,
                parent.revision,
                "program-parent-worker",
                "program-parent-claim",
                Utc::now() + Duration::minutes(1),
                &TestPlanner,
            )
            .await
            .unwrap()
        {
            PlanDriveReceipt::WaitingForPlanExecution {
                plan,
                child,
                existing,
            } => {
                assert!(!existing);
                (plan, *child)
            }
            other => panic!("expected Program child suspension, got {other:?}"),
        };
        assert_eq!(
            waiting_parent.pending_kind,
            Some(PlanExecutionWaitKind::PlanExecution)
        );
        let child_value: PlanProgramValue = {
            let machine: PlanMachine =
                serde_json::from_value(waiting_parent.state_json.clone()).unwrap();
            let PlanEffect::Program { value, .. } = machine.pending_effect().unwrap() else {
                unreachable!()
            };
            value.as_ref().clone()
        };
        assert_eq!(child.source_artifact_hash, child_value.hash);

        let terminal_child = match coordinator
            .drive_once(
                &child.id,
                child.revision,
                "program-child-worker",
                "program-child-claim",
                Utc::now() + Duration::minutes(1),
                &TestPlanner,
            )
            .await
            .unwrap()
        {
            PlanDriveReceipt::Succeeded { plan, value } => {
                assert_eq!(value, serde_json::json!(42));
                plan
            }
            other => panic!("expected pure Program child completion, got {other:?}"),
        };

        drop(coordinator);
        let runtime_store: Arc<dyn RuntimeStore> = store.clone();
        let restarted = PlanExecutionCoordinator::new(runtime_store, registry);
        let resumed_parent = match restarted
            .reconcile_program_child(&waiting_parent.id, &terminal_child.id)
            .await
            .unwrap()
        {
            PlanResumeReceipt::Queued(plan) => plan,
            other => panic!("expected parent queued after Program join, got {other:?}"),
        };
        match restarted
            .drive_once(
                &resumed_parent.id,
                resumed_parent.revision,
                "program-parent-finish-worker",
                "program-parent-finish-claim",
                Utc::now() + Duration::minutes(1),
                &TestPlanner,
            )
            .await
            .unwrap()
        {
            PlanDriveReceipt::Succeeded { value, .. } => {
                assert_eq!(value, serde_json::json!(42));
            }
            other => panic!("expected Program parent completion, got {other:?}"),
        }
    }
}
