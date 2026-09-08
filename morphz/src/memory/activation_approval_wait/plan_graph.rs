//! Prove that every unfinished Plan in an Activation is reachable from the
//! immutable assistant batch and suspended on the supplied human approvals.
//! This consumes no effect and grants no authority.
use super::*;
use crate::plan_execution::{
    deterministic_plan_effect_id, deterministic_plan_execution_id,
    deterministic_plan_parallel_branch_id, deterministic_plan_parallel_group_id,
    deterministic_plan_program_child_id,
};
use crate::sexpr_eval::{PlanEffect, PlanMachine};

pub(in crate::memory) struct Snapshot {
    pub id: String,
    pub revision: u64,
    pub status: String,
    pub group: Option<(String, u64, String)>,
}

pub(super) struct ValidatedFrontier {
    pub snapshots: Vec<Snapshot>,
    pub job_ids: HashSet<String>,
    pub infer_activation_ids: HashSet<String>,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn validate(
    remaining: &mut HashMap<&str, &str>,
    activation: &ThreadActivationRecord,
    thread: &ThreadRecord,
    plans: &[PlanExecutionRecord],
    groups: &[ActionGroupRecord],
    jobs: &[ExecutionJobRecord],
    pending_jobs: &HashSet<&str>,
    infer_children: &[InferApprovalDependency],
    require_all_plans: bool,
    objective_route: Option<(&str, &str)>,
) -> Result<ValidatedFrontier, Error> {
    let by_id: HashMap<_, _> = plans.iter().map(|p| (p.id.as_str(), p)).collect();
    let roots = remaining
        .iter()
        .filter(|(_, name)| **name == "eval")
        .map(|(id, _)| *id)
        .collect::<Vec<_>>();
    let mut visited = HashSet::new();
    let mut consumed_jobs = HashSet::new();
    let mut consumed_infers = HashSet::new();
    let mut snapshots = Vec::new();
    for call_id in roots {
        let root_id = deterministic_plan_execution_id(&activation.id, call_id)?;
        let mut queue = vec![(root_id.clone(), None::<JsonValue>)];
        let before = consumed_jobs.len() + consumed_infers.len();
        while let Some((id, expected_program)) = queue.pop() {
            if !visited.insert(id.clone()) || visited.len() > 4096 {
                return Err("Approval checkpoint Plan graph is cyclic, shared or too large".into());
            }
            let plan = by_id
                .get(id.as_str())
                .ok_or("Approval checkpoint Plan child is not durable")?;
            if plan.activation_id != activation.id
                || plan.thread_id != thread.id
                || plan.agent_id != activation.agent_id
                || plan.context_id != activation.context_id
                || plan.session_id != activation.session_id
                || plan.initiating_principal_id != activation.initiating_principal_id
                || plan.objective_id.as_deref() != objective_route.map(|(id, _)| id)
                || plan.objective_evaluation_id.as_deref() != objective_route.map(|(_, id)| id)
                || expected_program
                    .as_ref()
                    .is_some_and(|program| program != &plan.program_json)
                || deterministic_plan_execution_id(&activation.id, &plan.tool_call_id)? != plan.id
            {
                return Err(
                    "Approval checkpoint Plan graph has an unrelated owner or Program".into(),
                );
            }
            snapshots.push(Snapshot {
                id: plan.id.clone(),
                revision: plan.revision,
                status: plan.status.as_str().to_owned(),
                group: None,
            });
            if plan.status.is_terminal() {
                if id == root_id {
                    return Err(ActivationApprovalWaitChanged.into());
                }
                continue;
            }
            if plan.status != PlanExecutionStatus::Waiting
                || plan.claim_token.is_some()
                || plan.claimed_by.is_some()
                || plan.lease_expires_at.is_some()
            {
                return Err(ActivationApprovalWaitChanged.into());
            }
            let machine: PlanMachine = serde_json::from_value(plan.state_json.clone())?;
            let effect = machine
                .pending_effect()
                .ok_or("Approval checkpoint Plan has no pending effect")?;
            let pending = plan
                .pending_id
                .as_deref()
                .ok_or("Approval checkpoint Plan has no pending child")?;
            match (plan.pending_kind, effect) {
                (Some(PlanExecutionWaitKind::Evaluation), PlanEffect::Infer { .. }) => {
                    let child = infer_children
                        .iter()
                        .find(|child| child.initial_activation.id == pending)
                        .ok_or(ActivationApprovalWaitChanged)?;
                    // A concurrent cancel advances the Thread generation. It
                    // is a wakeup/replay, not a malformed historical route.
                    validate_infer_child(child)?;
                    validate_plan_evaluation_activation_route(
                        plan,
                        &child.request,
                        &child.thread,
                        &child.signal,
                        &child.initial_activation,
                        thread,
                        activation,
                        None,
                    )?;
                    let expected = crate::plan_execution::pending_infer_request_event(plan)?;
                    if expected.id != child.request.id || expected.payload != child.request.payload
                    {
                        return Err(
                            "Approval checkpoint infer Program differs from its durable request"
                                .into(),
                        );
                    }
                    if !consumed_infers.insert(child.activation.id.clone()) {
                        return Err("Approval checkpoint shares an infer continuation".into());
                    }
                }
                (
                    Some(PlanExecutionWaitKind::ExecutionJob),
                    PlanEffect::Call { sequence, tool, .. },
                ) => {
                    let call_id = deterministic_plan_effect_id(&plan.id, *sequence)?;
                    let job = jobs
                        .iter()
                        .find(|j| j.id == pending)
                        .ok_or("Approval checkpoint Plan Job is not durable")?;
                    if job.id != crate::execution::deterministic_job_id(&activation.id, &call_id)?
                        || job.tool_call_id != call_id
                        || job.tool_name != *tool
                    {
                        return Err(
                            "Approval checkpoint Plan and Job effect identities differ".into()
                        );
                    }
                    if !pending_jobs.contains(job.id.as_str()) {
                        return Err(ActivationApprovalWaitChanged.into());
                    }
                    if !consumed_jobs.insert(job.id.clone()) {
                        return Err(
                            "Approval checkpoint Plan graph shares a physical effect".into()
                        );
                    }
                }
                (
                    Some(PlanExecutionWaitKind::ActionGroup),
                    PlanEffect::Parallel { sequence, branches },
                ) => {
                    if pending != deterministic_plan_parallel_group_id(&plan.id, *sequence)? {
                        return Err("Approval checkpoint parallel join identity differs".into());
                    }
                    let group = groups
                        .iter()
                        .find(|g| g.id == pending)
                        .ok_or("Approval checkpoint parallel join is not durable")?;
                    if group.activation_id != activation.id
                        || group.thread_id != thread.id
                        || group.agent_id != activation.agent_id
                        || group.context_id != activation.context_id
                        || group.session_id != activation.session_id
                        || group.objective_id.as_deref() != objective_route.map(|(id, _)| id)
                        || group.objective_evaluation_id.as_deref()
                            != objective_route.map(|(_, id)| id)
                        || group.member_count != branches.len() as u64
                    {
                        return Err("Approval checkpoint parallel join route differs".into());
                    }
                    if group.status != ActionGroupStatus::Running {
                        return Err(ActivationApprovalWaitChanged.into());
                    }
                    snapshots.last_mut().expect("current Plan snapshot").group = Some((
                        group.id.clone(),
                        group.revision,
                        group.status.as_str().to_owned(),
                    ));
                    for branch in branches {
                        let call = deterministic_plan_parallel_branch_id(
                            &plan.id,
                            *sequence,
                            &branch.name,
                        )?;
                        queue.push((
                            deterministic_plan_execution_id(&activation.id, &call)?,
                            Some(serde_json::to_value(&branch.program)?),
                        ));
                    }
                }
                (
                    Some(PlanExecutionWaitKind::PlanExecution),
                    PlanEffect::Program {
                        sequence, value, ..
                    },
                ) => {
                    let child =
                        deterministic_plan_program_child_id(&activation.id, &plan.id, *sequence)?;
                    if pending != child {
                        return Err("Approval checkpoint Program child identity differs".into());
                    }
                    queue.push((child, Some(serde_json::to_value(&value.program)?)));
                }
                _ => {
                    return Err(
                        "Approval checkpoint Plan effect has no supported durable human wait"
                            .into(),
                    )
                }
            }
        }
        if consumed_jobs.len() + consumed_infers.len() == before {
            return Err(ActivationApprovalWaitChanged.into());
        }
        remaining.remove(call_id);
    }
    if require_all_plans
        && plans
            .iter()
            .any(|p| !p.status.is_terminal() && !visited.contains(&p.id))
    {
        return Err("Approval checkpoint cannot discard an unreachable unfinished Plan".into());
    }
    Ok(ValidatedFrontier {
        snapshots,
        job_ids: consumed_jobs,
        infer_activation_ids: consumed_infers,
    })
}
