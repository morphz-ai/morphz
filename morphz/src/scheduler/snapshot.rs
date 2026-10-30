//! Authoritative scheduler read model shared by SDK, HTTP, CLI and UI.
//!
//! This module deliberately contains no persistence writes. Controllers and
//! presentation layers consume these typed projections instead of rebuilding
//! scheduler truth from Event topics or process-local task maps.

use super::{ObjectiveReadiness, SchedulerDependencyRecord, SchedulerInvariantViolation};
use crate::memory::{
    ApprovalRecord, CognitiveContextRecord, DeliveryStatus, ExecutionJobRecord, ExecutionJobStatus,
    ObjectiveRecord, ScheduleRecord, SessionRecord, ThreadActivationRecord,
    ThreadGroupMemberRecord, ThreadGroupRecord, ThreadOutcomeRecord, ThreadPhase, ThreadRecord,
    ThreadSignalRecord,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct SchedulerQuery {
    #[serde(default)]
    pub include_terminal: bool,
    #[serde(default = "default_scheduler_limit")]
    pub limit: usize,
}

const fn default_scheduler_limit() -> usize {
    200
}

impl Default for SchedulerQuery {
    fn default() -> Self {
        Self {
            include_terminal: false,
            limit: default_scheduler_limit(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulerResultSnapshot {
    pub event_id: Option<String>,
    pub status: ExecutionJobStatus,
    pub refs: Vec<String>,
    pub error: Option<String>,
    pub exit_code: Option<i32>,
    pub finished_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulerJobSnapshot {
    pub job: ExecutionJobRecord,
    pub approval: Option<ApprovalRecord>,
    pub result: Option<SchedulerResultSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulerActivationSnapshot {
    pub activation: ThreadActivationRecord,
    pub signals: Vec<ThreadSignalRecord>,
    pub jobs: Vec<SchedulerJobSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulerThreadSnapshot {
    /// The exact currently pending question. Neither prose nor a generic wait
    /// label is an alternative authority for its recipient or choices.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_input_request: Option<crate::user_input::PendingUserInputRequest>,
    /// Latest physically bound request, never today's mutable default model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_model: Option<crate::runtime::ExecutionModel>,
    /// Original authenticated input provenance, resolved by the Runtime even
    /// when this Thread has a synthetic scheduled/Objective root.
    pub source: Option<SchedulerSource>,
    /// Runtime-validated display metadata; lifecycle/phase/outcome below
    /// remain the only execution facts. Legacy/Off snapshots omit this key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_annotations: Option<crate::runtime::ThreadResponseAnnotations>,
    /// Original work assignment from a durable root Event or Schedule, not
    /// a model-generated summary of whatever tool happens to run now.
    #[serde(default)]
    pub intent: Option<String>,
    pub thread: ThreadRecord,
    pub phase: ThreadPhase,
    pub outcome: Option<ThreadOutcomeRecord>,
    pub pending_signals: Vec<ThreadSignalRecord>,
    pub activations: Vec<SchedulerActivationSnapshot>,
    pub schedules: Vec<ScheduleRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulerThreadGroupSnapshot {
    pub group: ThreadGroupRecord,
    pub members: Vec<ThreadGroupMemberRecord>,
    pub outcomes: Vec<ThreadOutcomeRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulerSource {
    /// The immutable Objective creation/input Event, never a model-selected
    /// evidence reference or a root synthesized from an identifier prefix.
    pub event_id: String,
    pub context_id: String,
    pub session_id: String,
    pub root_turn_id: String,
    pub activation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulerObjectiveSnapshot {
    pub objective: ObjectiveRecord,
    /// Runtime-validated creation provenance, independent of whether its
    /// creating Activation/Thread is in the bounded activity-history page.
    pub source: Option<SchedulerSource>,
    pub readiness: ObjectiveReadiness,
    pub dependencies: Vec<SchedulerDependencyRecord>,
    pub active_evaluation: Option<ThreadActivationRecord>,
}

/// Delivery is projected from the Thread's authoritative delivery columns.
/// A dedicated record keeps presentation code independent from Thread layout
/// while the Kernel remains the only writer of both lifecycle and delivery.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SchedulerDeliverySnapshot {
    pub thread_id: String,
    pub session_id: String,
    pub generation: u64,
    pub status: DeliveryStatus,
    pub event_id: Option<String>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

/// An external outbox is a true cross-boundary operation. Internal scheduler
/// Signals are intentionally excluded from this view.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SchedulerExternalOutboxSnapshot {
    pub id: String,
    pub kind: String,
    pub state: String,
    pub destination: Option<String>,
    pub detail: serde_json::Value,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulerAdmissionSnapshot {
    #[serde(flatten)]
    pub process: crate::activation_admission::ActivationAdmissionSnapshot,
    pub context_durable_queued: usize,
    pub context_durable_running: usize,
    pub context_loaded_queued: usize,
    pub context_in_flight: usize,
    pub context_deferred: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SchedulerSummary {
    pub open_threads: usize,
    pub pending_signals: usize,
    pub queued_activations: usize,
    pub running_activations: usize,
    pub active_jobs: usize,
    pub waiting_approval_jobs: usize,
    pub pending_approvals: usize,
    pub active_schedules: usize,
    pub deferred_activations: usize,
    pub runnable_objectives: usize,
    pub waiting_objectives: usize,
    pub invariant_violations: usize,
}

/// Disclosure for every collection whose detail is intentionally capped.
/// Summary counters remain exact; callers can open a focused aggregate or a
/// cursor-based diagnostic view when one of these flags is true.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SchedulerDetailBounds {
    pub limit: usize,
    pub has_more_sessions: bool,
    pub has_more_objectives: bool,
    pub has_more_threads: bool,
    pub has_more_activations: bool,
    pub has_more_signals: bool,
    pub has_more_jobs: bool,
    pub has_more_approvals: bool,
    pub has_more_schedules: bool,
    pub has_more_thread_groups: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulerSnapshot {
    pub context_id: String,
    pub generated_at: chrono::DateTime<chrono::Utc>,
    pub summary: SchedulerSummary,
    pub detail_bounds: SchedulerDetailBounds,
    pub admission: SchedulerAdmissionSnapshot,
    pub event_writer: crate::orchestrator::orchestrator::DurableEventWriterMetricsSnapshot,
    pub model_provider: crate::orchestrator::orchestrator::ModelProviderMetricsSnapshot,
    pub context_capacity: crate::orchestrator::context::ContextCapacityMetricsSnapshot,
    pub contexts: Vec<CognitiveContextRecord>,
    pub sessions: Vec<SessionRecord>,
    pub objectives: Vec<SchedulerObjectiveSnapshot>,
    /// Context-wide current Schedule inventory. It is deliberately separate
    /// from `threads[*].schedules`, whose causal detail is bounded by the
    /// recent-Thread page.
    pub schedules: Vec<ScheduleRecord>,
    pub threads: Vec<SchedulerThreadSnapshot>,
    pub thread_groups: Vec<SchedulerThreadGroupSnapshot>,
    pub deliveries: Vec<SchedulerDeliverySnapshot>,
    pub external_outboxes: Vec<SchedulerExternalOutboxSnapshot>,
    pub invariant_violations: Vec<SchedulerInvariantViolation>,
    pub orphan_activations: Vec<SchedulerActivationSnapshot>,
    pub orphan_signals: Vec<ThreadSignalRecord>,
    pub orphan_jobs: Vec<SchedulerJobSnapshot>,
    pub orphan_approvals: Vec<ApprovalRecord>,
}

pub fn job_snapshot(
    job: ExecutionJobRecord,
    approvals: &mut std::collections::HashMap<String, ApprovalRecord>,
) -> SchedulerJobSnapshot {
    let approval = approvals.remove(&job.id);
    let result = job.status.is_terminal().then(|| SchedulerResultSnapshot {
        event_id: job.result_event_id.clone(),
        status: job.status,
        refs: job.result_refs.clone(),
        error: job.error.clone(),
        exit_code: job.exit_code,
        finished_at: job.finished_at,
    });
    SchedulerJobSnapshot {
        job,
        approval,
        result,
    }
}

pub fn thread_phase(
    thread: &ThreadRecord,
    pending_signals: &[ThreadSignalRecord],
    activations: &[SchedulerActivationSnapshot],
    schedules: &[ScheduleRecord],
    dependencies: &[SchedulerDependencyRecord],
) -> ThreadPhase {
    let running = activations.iter().any(|activation| {
        activation.activation.status == crate::memory::ThreadActivationStatus::Running
            || activation
                .jobs
                .iter()
                .any(|job| job.job.status == ExecutionJobStatus::Running)
    });
    let runnable = activations.iter().any(|activation| {
        activation.activation.status == crate::memory::ThreadActivationStatus::Queued
            || activation
                .jobs
                .iter()
                .any(|job| job.job.status == ExecutionJobStatus::Queued)
    }) || pending_signals
        .iter()
        .any(|signal| signal.status == crate::memory::ThreadSignalStatus::Pending);
    let waiting = dependencies.iter().any(|dependency| {
        dependency.owner_kind == super::SchedulerDependencyOwnerKind::Thread
            && dependency.owner_id == thread.id
            && dependency.owner_generation == thread.generation
            && dependency.required
            && dependency.status == super::SchedulerDependencyStatus::Pending
    }) || activations.iter().any(|activation| {
        activation
            .jobs
            .iter()
            .any(|job| job.job.status == ExecutionJobStatus::WaitingApproval)
    }) || schedules.iter().any(|schedule| {
        matches!(
            schedule.status,
            crate::memory::ScheduleStatus::Queued | crate::memory::ScheduleStatus::Paused
        )
    });
    thread_phase_from_activity(thread, running, runnable, waiting)
}

/// Shared phase precedence for detailed Scheduler and bounded SQL projections.
pub(crate) fn thread_phase_from_activity(
    thread: &ThreadRecord,
    running: bool,
    runnable: bool,
    waiting: bool,
) -> ThreadPhase {
    if thread.lifecycle.is_terminal() {
        ThreadPhase::Idle
    } else if running {
        ThreadPhase::Running
    } else if runnable {
        ThreadPhase::Runnable
    } else if waiting {
        ThreadPhase::Waiting
    } else {
        ThreadPhase::Idle
    }
}
