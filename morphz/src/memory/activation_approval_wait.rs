//! A durable tool-batch checkpoint, not a terminal Evaluation or a permission
//! grant. Readiness is derived from the exact Approval/Job revisions, so a
//! decision before, during or after host replacement cannot lose its wakeup.
use super::*;
use crate::event::{Event, TYPE_TOOL_OUTPUT};
use std::collections::{HashMap, HashSet};
mod plan_graph;

pub(crate) struct PlanApprovalFrontier {
    pub plan_ids: Vec<String>,
    pub approval_ids: Vec<String>,
    pub infer_activation_ids: Vec<String>,
}

pub(super) struct InferApprovalDependency {
    pub activation: ThreadActivationRecord,
    pub initial_activation: ThreadActivationRecord,
    pub thread: ThreadRecord,
    pub request: Event,
    pub signal: ThreadSignalRecord,
}

fn validate_infer_child(child: &InferApprovalDependency) -> Result<(), Error> {
    let a = &child.activation;
    let t = &child.thread;
    if a.status != ThreadActivationStatus::Queued
        || a.claimed_by.is_some()
        || a.lease_expires_at.is_some()
        || t.lifecycle != ThreadLifecycle::Open
        || t.control_state != ThreadControlState::Active
        || a.generation != t.generation
    {
        return Err(ActivationApprovalWaitChanged.into());
    }
    if a.root_turn_id != t.root_turn_id
        || a.agent_id != t.agent_id
        || a.context_id != t.context_id
        || a.session_id != t.session_id
        || a.initiating_principal_id != t.initiating_principal_id
    {
        return Err("Approval checkpoint infer continuation has an unrelated route".into());
    }
    Ok(())
}

// This probe may race a child decision. Only the native checkpoint transaction
// and recursive readiness view authorize suspension, never these sampled reads.
async fn infer_frontier(
    store: &dyn RuntimeStore,
    plans: &[PlanExecutionRecord],
) -> Result<Vec<InferApprovalDependency>, Error> {
    let mut children = Vec::new();
    for plan in plans.iter().filter(|p| {
        p.status == PlanExecutionStatus::Waiting
            && p.pending_kind == Some(PlanExecutionWaitKind::Evaluation)
    }) {
        let Some(id) = &plan.pending_id else { continue };
        let Some(initial_activation) = store.get_thread_activation(id).await? else {
            continue;
        };
        let Some(thread) = store
            .get_thread_by_root(&initial_activation.root_turn_id)
            .await?
        else {
            continue;
        };
        let mut live = store
            .list_thread_activations_by_root(&thread.context_id, &thread.root_turn_id)
            .await?
            .into_iter()
            .filter(|a| !a.status.is_terminal());
        let Some(activation) = live.next() else {
            continue;
        };
        if live.next().is_some()
            || store
                .next_pending_thread_signal(&thread.id)
                .await?
                .is_some()
            || store
                .get_thread_activation_approval_wait(&activation.id)
                .await?
                .is_none()
            || store
                .dialogue_turn_activation_runnable(&activation.id)
                .await?
        {
            continue;
        }
        let Some(signal) = store
            .list_activation_signals(id)
            .await?
            .into_iter()
            .find(|s| s.id == stable_thread_signal_id(&thread.root_turn_id))
        else {
            continue;
        };
        let Some(request) = store
            .query(QueryFilter {
                event_id: Some(thread.root_turn_id.clone()),
                context_id: Some(thread.context_id.clone()),
                ..Default::default()
            })
            .await?
            .into_iter()
            .find(|e| e.id == thread.root_turn_id)
        else {
            continue;
        };
        children.push(InferApprovalDependency {
            activation,
            initial_activation,
            thread,
            request,
            signal,
        });
    }
    Ok(children)
}

/// Conservative readiness probe for releasing one Plan stack. These reads are
/// not the commit boundary: the enclosing immutable batch is revalidated under
/// the native transaction before its Activation can suspend. A changing or
/// unsupported frontier retains its live runner; it never grants authority.
pub(crate) async fn plan_approval_frontier(
    store: &dyn RuntimeStore,
    root: &PlanExecutionRecord,
) -> Result<Option<PlanApprovalFrontier>, Error> {
    if root.status != PlanExecutionStatus::Waiting {
        return Ok(None);
    }
    let Some(activation) = store.get_thread_activation(&root.activation_id).await? else {
        return Ok(None);
    };
    let Some(thread) = store.get_thread(&root.thread_id).await? else {
        return Ok(None);
    };
    let plans = store
        .list_plan_executions(PlanExecutionFilter {
            activation_id: Some(root.activation_id.clone()),
            include_terminal: true,
            limit: Some(4097),
            ..Default::default()
        })
        .await?;
    let groups = store
        .list_action_groups(ActionGroupFilter {
            activation_id: Some(root.activation_id.clone()),
            include_terminal: false,
            limit: Some(4097),
            ..Default::default()
        })
        .await?;
    let jobs = store
        .list_execution_jobs(ExecutionJobFilter {
            activation_id: Some(root.activation_id.clone()),
            status: Some(ExecutionJobStatus::WaitingApproval),
            limit: Some(4097),
            ..Default::default()
        })
        .await?;
    if plans.len() > 4096 || groups.len() > 4096 || jobs.len() > 4096 {
        return Ok(None);
    }
    let mut approvals = HashMap::new();
    for job in &jobs {
        if job.claim_token.is_some() || job.side_effect_started_at.is_some() {
            continue;
        }
        let pending = store
            .list_approvals(ApprovalFilter {
                job_id: Some(job.id.clone()),
                status: Some(ApprovalStatus::PendingHuman),
                pending_only: true,
                limit: Some(2),
            })
            .await?;
        if pending.len() == 1 {
            approvals.insert(job.id.as_str(), pending[0].id.clone());
        }
    }
    let pending_jobs = approvals.keys().copied().collect();
    let mut roots = HashMap::from([(root.tool_call_id.as_str(), "eval")]);
    let infer_children = infer_frontier(store, &plans).await?;
    let Ok(frontier) = plan_graph::validate(
        &mut roots,
        &activation,
        &thread,
        &plans,
        &groups,
        &jobs,
        &pending_jobs,
        &infer_children,
        false,
        root.objective_id
            .as_deref()
            .zip(root.objective_evaluation_id.as_deref()),
    ) else {
        return Ok(None);
    };
    Ok(Some(PlanApprovalFrontier {
        plan_ids: frontier.snapshots.into_iter().map(|p| p.id).collect(),
        approval_ids: frontier
            .job_ids
            .iter()
            .map(|id| approvals[id.as_str()].clone())
            .collect(),
        infer_activation_ids: frontier.infer_activation_ids.into_iter().collect(),
    }))
}

#[derive(Debug, Clone)]
pub struct ActivationApprovalWaitRequest {
    pub activation_id: String,
    pub expected_revision: u64,
    pub claimed_by: String,
    pub assistant_call_event_id: String,
    pub pending_approval_ids: Vec<String>,
    pub pending_infer_activation_ids: Vec<String>,
    pub completed_output_event_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivationApprovalWaitCheckpoint {
    pub activation_id: String,
    pub assistant_call_event_id: String,
    pub approval_ids: Vec<String>,
    pub infer_activation_ids: Vec<String>,
}

/// A decision or cancellation won before the checkpoint transaction. The
/// caller must replay the durable batch, not fail its owning Activation.
#[derive(Debug)]
pub struct ActivationApprovalWaitChanged;

impl std::fmt::Display for ActivationApprovalWaitChanged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Approval checkpoint dependencies changed before suspension")
    }
}
impl std::error::Error for ActivationApprovalWaitChanged {}

pub(super) fn checkpoint_from_rows(
    activation_id: &str,
    rows: Vec<(String, String)>,
    infer_rows: Vec<(String, String)>,
) -> Result<Option<ActivationApprovalWaitCheckpoint>, Error> {
    let Some((_, event_id)) = rows.first().or_else(|| infer_rows.first()) else {
        return Ok(None);
    };
    if rows.iter().chain(&infer_rows).any(|(_, id)| id != event_id) {
        return Err("Approval checkpoint contains conflicting assistant-call identities".into());
    }
    Ok(Some(ActivationApprovalWaitCheckpoint {
        activation_id: activation_id.into(),
        assistant_call_event_id: event_id.clone(),
        approval_ids: rows.into_iter().map(|(id, _)| id).collect(),
        infer_activation_ids: infer_rows.into_iter().map(|(id, _)| id).collect(),
    }))
}

// Both native backends use the same relational contract. The remote backend
// journals these rows with the Activation and Timer in one fenced commit.
pub(super) const TABLE: &str = r#"CREATE TABLE IF NOT EXISTS activation_approval_waits (
    activation_id TEXT NOT NULL REFERENCES thread_activations(id) ON DELETE CASCADE,
    approval_id TEXT NOT NULL REFERENCES approval_requests(id),
    approval_revision BIGINT NOT NULL CHECK(approval_revision >= 1),
    job_id TEXT NOT NULL REFERENCES execution_jobs(id),
    job_revision BIGINT NOT NULL CHECK(job_revision >= 1),
    assistant_call_event_id TEXT NOT NULL REFERENCES events(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (activation_id, approval_id)
)"#;

pub(super) const PLAN_TABLE: &str = r#"CREATE TABLE IF NOT EXISTS activation_approval_plan_waits (
    activation_id TEXT NOT NULL REFERENCES thread_activations(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL REFERENCES plan_executions(id),
    plan_revision BIGINT NOT NULL CHECK(plan_revision >= 1),
    plan_status TEXT NOT NULL,
    group_id TEXT REFERENCES action_groups(id),
    group_revision BIGINT,
    group_status TEXT,
    CHECK ((group_id IS NULL AND group_revision IS NULL AND group_status IS NULL)
        OR (group_id IS NOT NULL AND group_revision >= 1 AND group_status IS NOT NULL)),
    PRIMARY KEY (activation_id, plan_id)
)"#;

pub(super) const INFER_TABLE: &str = r#"CREATE TABLE IF NOT EXISTS activation_approval_infer_waits (
    activation_id TEXT NOT NULL REFERENCES thread_activations(id) ON DELETE CASCADE,
    child_activation_id TEXT NOT NULL REFERENCES thread_activations(id),
    child_revision BIGINT NOT NULL CHECK(child_revision >= 1),
    child_thread_id TEXT NOT NULL REFERENCES threads(id),
    child_thread_revision BIGINT NOT NULL CHECK(child_thread_revision >= 1),
    child_generation BIGINT NOT NULL CHECK(child_generation >= 1),
    assistant_call_event_id TEXT NOT NULL REFERENCES events(id),
    CHECK(activation_id <> child_activation_id),
    PRIMARY KEY (activation_id, child_activation_id)
)"#;
pub(super) const INFER_INDEX: &str = "CREATE INDEX IF NOT EXISTS activation_approval_infer_child ON activation_approval_infer_waits(child_activation_id, activation_id)";

// Resume on ANY change, including denial, cancellation or permission-policy
// re-evaluation. Waiting for ALL approvals would prevent the first approved
// command from running. Missing dependencies also require reconciliation;
// they must never turn into an immortal sleeping owner.
pub(super) const VIEW_QUERY: &str = r#"
    WITH RECURSIVE owners(activation_id) AS (
        SELECT activation_id FROM activation_approval_waits
        UNION SELECT activation_id FROM activation_approval_infer_waits
    ), invalid(activation_id) AS (
    SELECT w.activation_id FROM owners w
    LEFT JOIN thread_activations owner ON owner.id = w.activation_id
    WHERE owner.id IS NULL OR owner.status <> 'queued' OR EXISTS (
        SELECT 1 FROM activation_approval_waits aw
        LEFT JOIN approval_requests a ON a.id = aw.approval_id
        LEFT JOIN execution_jobs j ON j.id = aw.job_id
        WHERE aw.activation_id = w.activation_id AND
            (a.id IS NULL OR j.id IS NULL OR a.status <> 'pending_human'
             OR a.revision <> aw.approval_revision OR a.job_id <> aw.job_id
             OR j.status <> 'waiting_approval' OR j.revision <> aw.job_revision
             OR j.activation_id <> aw.activation_id)
    ) OR EXISTS (
        SELECT 1 FROM activation_approval_plan_waits pw
        LEFT JOIN plan_executions p ON p.id = pw.plan_id
        LEFT JOIN action_groups g ON g.id = pw.group_id
        WHERE pw.activation_id = w.activation_id AND
            (p.id IS NULL OR p.activation_id <> pw.activation_id
             OR p.revision <> pw.plan_revision OR p.status <> pw.plan_status
             OR (pw.group_id IS NOT NULL AND (g.id IS NULL
                 OR g.revision <> pw.group_revision OR g.status <> pw.group_status)))
    )
    OR EXISTS (
        SELECT 1 FROM plan_executions p
        WHERE p.activation_id = w.activation_id
          AND p.status NOT IN ('succeeded', 'failed', 'cancelled')
          AND NOT EXISTS (SELECT 1 FROM activation_approval_plan_waits pw
              WHERE pw.activation_id = w.activation_id AND pw.plan_id = p.id)
    )
    OR EXISTS (
        SELECT 1 FROM execution_jobs j
        WHERE j.activation_id = w.activation_id
          AND j.status NOT IN ('succeeded', 'failed', 'cancelled', 'lost')
          AND NOT EXISTS (SELECT 1 FROM activation_approval_waits jw
              WHERE jw.activation_id = w.activation_id AND jw.job_id = j.id)
    )
    OR EXISTS (
        SELECT 1 FROM activation_approval_infer_waits iw
        LEFT JOIN thread_activations c ON c.id = iw.child_activation_id
        LEFT JOIN threads t ON t.id = iw.child_thread_id
        WHERE iw.activation_id = w.activation_id AND
            (c.id IS NULL OR t.id IS NULL OR c.status <> 'queued'
             OR c.revision <> iw.child_revision OR t.revision <> iw.child_thread_revision
             OR c.root_turn_id <> t.root_turn_id OR c.generation <> iw.child_generation
             OR t.generation <> iw.child_generation OR t.status <> 'open'
             OR t.control_state <> 'active'
             OR NOT EXISTS (SELECT 1 FROM owners o WHERE o.activation_id = c.id)
             OR EXISTS (SELECT 1 FROM thread_activations sibling
                 WHERE sibling.root_turn_id = t.root_turn_id
                   AND sibling.status IN ('queued', 'running') AND sibling.id <> c.id)
             OR EXISTS (SELECT 1 FROM thread_signals s WHERE s.thread_id = t.id
                 AND s.thread_generation = t.generation AND s.status = 'pending'))
    )
    UNION
    SELECT iw.activation_id FROM activation_approval_infer_waits iw
    JOIN invalid child ON child.activation_id = iw.child_activation_id
    )
    SELECT activation_id FROM owners o WHERE NOT EXISTS (
        SELECT 1 FROM invalid i WHERE i.activation_id = o.activation_id
    )"#;

type Error = Box<dyn std::error::Error + Send + Sync>;

#[allow(clippy::too_many_arguments)]
pub(super) fn validate(
    request: &ActivationApprovalWaitRequest,
    activation: &ThreadActivationRecord,
    thread: &ThreadRecord,
    call: &Event,
    jobs: &[ExecutionJobRecord],
    approvals: &[ApprovalRecord],
    outputs: &[Event],
    plans: &[PlanExecutionRecord],
    groups: &[ActionGroupRecord],
    infer_children: &[InferApprovalDependency],
) -> Result<Vec<plan_graph::Snapshot>, Error> {
    if activation.status != ThreadActivationStatus::Running
        || activation.claimed_by.as_deref() != Some(request.claimed_by.as_str())
        || request.claimed_by.trim().is_empty()
        || activation
            .lease_expires_at
            .is_none_or(|at| at <= Utc::now())
        || thread.lifecycle != ThreadLifecycle::Open
        || thread.control_state != ThreadControlState::Active
        || thread.generation != activation.generation
        || thread.root_turn_id != activation.root_turn_id
    {
        return Err(
            "Approval checkpoint requires the live Activation owner and open Thread generation"
                .into(),
        );
    }
    let same_route = |event: &Event| {
        event.payload.get("context_id").and_then(JsonValue::as_str) == Some(&activation.context_id)
            && event.payload.get("session_id").and_then(JsonValue::as_str)
                == Some(&activation.session_id)
            && event.payload.get("attempt_id").and_then(JsonValue::as_str) == Some(&activation.id)
    };
    if call.topic != "chat/assistant_call"
        || !same_route(call)
        || call
            .payload
            .get("terminal_outcome")
            .and_then(JsonValue::as_bool)
            == Some(true)
    {
        return Err(
            "Approval checkpoint must reference this Activation's durable assistant call".into(),
        );
    }
    let calls: Vec<crate::llm::ToolCall> = serde_json::from_value(
        call.payload
            .get("continuation_tool_calls")
            .or_else(|| call.payload.get("tool_calls"))
            .cloned()
            .ok_or("Approval checkpoint has no tool batch")?,
    )?;
    let mut remaining: HashMap<_, _> = calls
        .iter()
        .map(|c| (c.id.as_str(), c.function.name.as_str()))
        .collect();
    if calls.is_empty()
        || remaining.len() != calls.len()
        || calls.iter().any(|c| c.id.trim().is_empty())
    {
        return Err("Approval checkpoint tool IDs must be nonempty and unique".into());
    }
    if (approvals.is_empty() && infer_children.is_empty())
        || approvals.len() != request.pending_approval_ids.len()
        || infer_children.len() != request.pending_infer_activation_ids.len()
        || infer_children
            .iter()
            .map(|c| &c.activation.id)
            .collect::<HashSet<_>>()
            .len()
            != infer_children.len()
        || approvals
            .iter()
            .map(|a| &a.id)
            .collect::<HashSet<_>>()
            .len()
            != approvals.len()
    {
        return Err(
            "Approval checkpoint requires an exact nonempty set of approval or infer dependencies"
                .into(),
        );
    }
    let mut pending_jobs = HashSet::new();
    let mut direct_jobs = HashSet::new();
    for approval in approvals {
        let job = jobs
            .iter()
            .find(|j| j.id == approval.job_id)
            .ok_or("Approval checkpoint Job is missing")?;
        if job.activation_id != activation.id
            || job.thread_id != thread.id
            || job.context_id != activation.context_id
            || job.session_id != activation.session_id
            || job.agent_id != activation.agent_id
            || job.claim_token.is_some()
            || job.side_effect_started_at.is_some()
            || !pending_jobs.insert(job.id.as_str())
        {
            return Err("Approval checkpoint contains changed, claimed or unrelated work".into());
        }
        if let Some(name) = remaining.get(job.tool_call_id.as_str()) {
            if *name != job.tool_name {
                return Err("Approval checkpoint direct Job tool differs from its batch".into());
            }
            remaining.remove(job.tool_call_id.as_str());
            direct_jobs.insert(job.id.clone());
        }
        if approval.status != ApprovalStatus::PendingHuman
            || job.status != ExecutionJobStatus::WaitingApproval
        {
            return Err(ActivationApprovalWaitChanged.into());
        }
    }
    for output in outputs {
        let id = output
            .payload
            .get("tool_call_id")
            .and_then(JsonValue::as_str)
            .ok_or("Approval checkpoint output has no tool call ID")?;
        if output.event_type != TYPE_TOOL_OUTPUT
            || !same_route(output)
            || remaining.remove(id).is_none()
        {
            return Err(
                "Approval checkpoint contains an unrelated or duplicate tool result".into(),
            );
        }
    }
    let frontier = plan_graph::validate(
        &mut remaining,
        activation,
        thread,
        plans,
        groups,
        jobs,
        &pending_jobs,
        infer_children,
        true,
        super::objective_approval_wait::binding_event(call, outputs)?
            .map(super::objective_approval_wait::route)
            .transpose()?
            .flatten(),
    )?;
    if frontier.infer_activation_ids.len() != infer_children.len()
        || pending_jobs
            .iter()
            .any(|id| !direct_jobs.contains(*id) && !frontier.job_ids.contains(*id))
        || !remaining.is_empty()
        || jobs
            .iter()
            .any(|j| !j.status.is_terminal() && !pending_jobs.contains(j.id.as_str()))
    {
        return Err("Approval checkpoint cannot suspend unfinished sibling work".into());
    }
    Ok(frontier.snapshots)
}
