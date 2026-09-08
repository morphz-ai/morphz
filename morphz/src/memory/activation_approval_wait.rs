//! A durable tool-batch checkpoint, not a terminal Evaluation or a permission
//! grant. Readiness is derived from the exact Approval/Job revisions, so a
//! decision before, during or after host replacement cannot lose its wakeup.
use super::*;
use crate::event::{Event, TYPE_TOOL_OUTPUT};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone)]
pub struct ActivationApprovalWaitRequest {
    pub activation_id: String,
    pub expected_revision: u64,
    pub claimed_by: String,
    pub assistant_call_event_id: String,
    pub pending_approval_ids: Vec<String>,
    pub completed_output_event_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivationApprovalWaitCheckpoint {
    pub activation_id: String,
    pub assistant_call_event_id: String,
    pub approval_ids: Vec<String>,
}

pub(super) fn checkpoint_from_rows(
    activation_id: &str,
    rows: Vec<(String, String)>,
) -> Result<Option<ActivationApprovalWaitCheckpoint>, Error> {
    let Some((_, event_id)) = rows.first() else {
        return Ok(None);
    };
    if rows.iter().any(|(_, id)| id != event_id) {
        return Err("Approval checkpoint contains conflicting assistant-call identities".into());
    }
    Ok(Some(ActivationApprovalWaitCheckpoint {
        activation_id: activation_id.into(),
        assistant_call_event_id: event_id.clone(),
        approval_ids: rows.into_iter().map(|(id, _)| id).collect(),
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

// Resume on ANY change, including denial, cancellation or permission-policy
// re-evaluation. Waiting for ALL approvals would prevent the first approved
// command from running. Missing dependencies also require reconciliation;
// they must never turn into an immortal sleeping owner.
pub(super) const VIEW_QUERY: &str = r#"
    SELECT w.activation_id FROM activation_approval_waits w
    LEFT JOIN approval_requests a ON a.id = w.approval_id
    LEFT JOIN execution_jobs j ON j.id = w.job_id
    GROUP BY w.activation_id
    HAVING MIN(CASE WHEN a.status = 'pending_human'
        AND a.revision = w.approval_revision AND a.job_id = w.job_id
        AND j.status = 'waiting_approval' AND j.revision = w.job_revision
        AND j.activation_id = w.activation_id
        THEN 1 ELSE 0 END) = 1"#;

type Error = Box<dyn std::error::Error + Send + Sync>;

pub(super) fn validate(
    request: &ActivationApprovalWaitRequest,
    activation: &ThreadActivationRecord,
    thread: &ThreadRecord,
    call: &Event,
    jobs: &[ExecutionJobRecord],
    approvals: &[ApprovalRecord],
    outputs: &[Event],
) -> Result<(), Error> {
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
            .get("tool_calls")
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
    if approvals.is_empty()
        || approvals.len() != request.pending_approval_ids.len()
        || approvals
            .iter()
            .map(|a| &a.id)
            .collect::<HashSet<_>>()
            .len()
            != approvals.len()
    {
        return Err(
            "Approval checkpoint requires an exact nonempty set of pending human approvals".into(),
        );
    }
    let mut pending_jobs = HashSet::new();
    for approval in approvals {
        let job = jobs
            .iter()
            .find(|j| j.id == approval.job_id)
            .ok_or("Approval checkpoint Job is missing")?;
        if approval.status != ApprovalStatus::PendingHuman
            || job.status != ExecutionJobStatus::WaitingApproval
            || job.activation_id != activation.id
            || job.thread_id != thread.id
            || job.context_id != activation.context_id
            || job.session_id != activation.session_id
            || job.agent_id != activation.agent_id
            || job.claim_token.is_some()
            || job.side_effect_started_at.is_some()
            || !pending_jobs.insert(job.id.as_str())
            || remaining.remove(job.tool_call_id.as_str()) != Some(job.tool_name.as_str())
        {
            return Err("Approval checkpoint contains changed, claimed or unrelated work".into());
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
    if !remaining.is_empty()
        || jobs
            .iter()
            .any(|j| !j.status.is_terminal() && !pending_jobs.contains(j.id.as_str()))
    {
        return Err("Approval checkpoint cannot suspend unfinished sibling work".into());
    }
    Ok(())
}
