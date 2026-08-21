use crate::memory::{
    objective_primary_execution_root_id, stable_thread_id, ObjectiveRecord, ObjectiveStatus,
    ObjectiveWaitCondition, ThreadActivationRecord, ThreadGroupMemberRecord, ThreadGroupRecord,
    ThreadGroupStatus, ThreadKind, ThreadLifecycle, ThreadOutcomeRecord, ThreadRecord,
    ThreadSupervisorKind,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

/// Projection which owns a dependency. The owner is not necessarily the
/// component that satisfies it; it is the lifecycle whose readiness depends
/// on the referenced fact.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum SchedulerDependencyOwnerKind {
    Objective,
    Thread,
    Plan,
    Schedule,
    Delivery,
}

impl SchedulerDependencyOwnerKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Objective => "objective",
            Self::Thread => "thread",
            Self::Plan => "plan",
            Self::Schedule => "schedule",
            Self::Delivery => "delivery",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "objective" => Self::Objective,
            "thread" => Self::Thread,
            "plan" => Self::Plan,
            "schedule" => Self::Schedule,
            "delivery" => Self::Delivery,
            _ => return None,
        })
    }
}

/// Runtime-owned fact which can make a scheduler owner runnable.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum SchedulerDependencyKind {
    Thread,
    ThreadGroup,
    ToolTask,
    Delegation,
    Timer,
    Permission,
    UserInput,
    ExternalEvent,
    Resource,
}

impl SchedulerDependencyKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Thread => "thread",
            Self::ThreadGroup => "thread_group",
            Self::ToolTask => "tool_task",
            Self::Delegation => "delegation",
            Self::Timer => "timer",
            Self::Permission => "permission",
            Self::UserInput => "user_input",
            Self::ExternalEvent => "external_event",
            Self::Resource => "resource",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "thread" => Self::Thread,
            "thread_group" => Self::ThreadGroup,
            "tool_task" => Self::ToolTask,
            "delegation" => Self::Delegation,
            "timer" => Self::Timer,
            "permission" => Self::Permission,
            "user_input" => Self::UserInput,
            "external_event" => Self::ExternalEvent,
            "resource" => Self::Resource,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum SchedulerDependencyStatus {
    Pending,
    Satisfied,
    Cancelled,
}

impl SchedulerDependencyStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Satisfied => "satisfied",
            Self::Cancelled => "cancelled",
        }
    }

    pub const fn is_terminal(self) -> bool {
        !matches!(self, Self::Pending)
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "pending" => Self::Pending,
            "satisfied" => Self::Satisfied,
            "cancelled" => Self::Cancelled,
            _ => return None,
        })
    }
}

/// Authoritative persistent dependency edge. Generations fence reuse of a
/// logical identity after restart/reopen; satisfying an older generation must
/// never release the current owner.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SchedulerDependencyRecord {
    pub id: String,
    pub owner_kind: SchedulerDependencyOwnerKind,
    pub owner_id: String,
    pub owner_generation: u64,
    pub dependency_kind: SchedulerDependencyKind,
    pub dependency_id: String,
    pub dependency_generation: u64,
    pub required: bool,
    pub status: SchedulerDependencyStatus,
    pub metadata: JsonValue,
    pub satisfied_by_event_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub satisfied_at: Option<DateTime<Utc>>,
}

/// Stable identity for one generation-fenced dependency edge. Replaying the
/// same Kernel Command therefore observes the same row, while reusing a
/// logical owner or dependency in a later lifecycle gets a distinct ID.
pub fn stable_scheduler_dependency_id(
    owner_kind: SchedulerDependencyOwnerKind,
    owner_id: &str,
    owner_generation: u64,
    dependency_kind: SchedulerDependencyKind,
    dependency_id: &str,
    dependency_generation: u64,
) -> String {
    let material = format!(
        "morphz.scheduler-dependency.v1\0{}\0{}\0{}\0{}\0{}\0{}",
        owner_kind.as_str(),
        owner_id,
        owner_generation,
        dependency_kind.as_str(),
        dependency_id,
        dependency_generation
    );
    let digest = format!("{:x}", Sha256::digest(material.as_bytes()));
    format!("scheduler_dependency_{}", &digest[..32])
}

/// Lossless lowering from the legacy Objective display wait into the
/// authoritative scheduler dependency identity. The returned key contains no
/// natural-language interpretation: it is derived exclusively from the typed
/// wait variant and is therefore safe to use during migration and replay.
pub fn objective_wait_dependency_key(
    wait: &ObjectiveWaitCondition,
) -> (SchedulerDependencyKind, String) {
    match wait {
        ObjectiveWaitCondition::ToolTask { task_id } => {
            (SchedulerDependencyKind::ToolTask, task_id.clone())
        }
        ObjectiveWaitCondition::Delegation { delegation_id } => {
            (SchedulerDependencyKind::Delegation, delegation_id.clone())
        }
        ObjectiveWaitCondition::ThreadGroup { group_id } => {
            (SchedulerDependencyKind::ThreadGroup, group_id.clone())
        }
        ObjectiveWaitCondition::Timer { deadline } => (
            SchedulerDependencyKind::Timer,
            deadline.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
        ),
        ObjectiveWaitCondition::Permission { request_id } => {
            (SchedulerDependencyKind::Permission, request_id.clone())
        }
        ObjectiveWaitCondition::UserInput { session_id } => {
            (SchedulerDependencyKind::UserInput, session_id.clone())
        }
        ObjectiveWaitCondition::ExternalEvent {
            topic,
            correlation_id,
        } => (
            SchedulerDependencyKind::ExternalEvent,
            serde_json::json!({"topic": topic, "correlation_id": correlation_id}).to_string(),
        ),
        ObjectiveWaitCondition::ResourceAvailable { resource } => {
            (SchedulerDependencyKind::Resource, resource.clone())
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SchedulerDependencyFilter {
    pub owner_kind: Option<SchedulerDependencyOwnerKind>,
    pub owner_id: Option<String>,
    pub dependency_kind: Option<SchedulerDependencyKind>,
    pub dependency_id: Option<String>,
    pub status: Option<SchedulerDependencyStatus>,
    pub required_only: bool,
}

/// Readiness is derived; it is never stored as another independently mutable
/// lifecycle value.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ObjectiveReadiness {
    Runnable,
    Waiting { dependency_ids: Vec<String> },
    Leased { evaluation_id: String },
    Paused,
    Blocked,
    Terminal,
}

pub fn derive_objective_readiness(
    objective: &ObjectiveRecord,
    dependencies: &[SchedulerDependencyRecord],
    now: DateTime<Utc>,
) -> ObjectiveReadiness {
    if objective.status.is_terminal() {
        return ObjectiveReadiness::Terminal;
    }
    match objective.status {
        ObjectiveStatus::Paused => return ObjectiveReadiness::Paused,
        ObjectiveStatus::Blocked => return ObjectiveReadiness::Blocked,
        ObjectiveStatus::Active => {}
        ObjectiveStatus::Completed | ObjectiveStatus::Cancelled | ObjectiveStatus::Failed => {
            return ObjectiveReadiness::Terminal;
        }
    }

    if let (Some(evaluation_id), Some(expires_at)) = (
        objective.active_evaluation_id.as_ref(),
        objective.evaluation_lease_expires_at,
    ) {
        if expires_at > now {
            return ObjectiveReadiness::Leased {
                evaluation_id: evaluation_id.clone(),
            };
        }
    }

    let mut pending = dependencies
        .iter()
        .filter(|dependency| {
            dependency.owner_kind == SchedulerDependencyOwnerKind::Objective
                && dependency.owner_id == objective.id
                && dependency.owner_generation == objective.generation
                && dependency.required
                && dependency.status == SchedulerDependencyStatus::Pending
        })
        .map(|dependency| dependency.id.clone())
        .collect::<Vec<_>>();
    pending.sort();
    pending.dedup();
    if pending.is_empty() {
        ObjectiveReadiness::Runnable
    } else {
        ObjectiveReadiness::Waiting {
            dependency_ids: pending,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum SchedulerInvariantSeverity {
    Warning,
    Error,
    Quarantine,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum SchedulerInvariantCode {
    TerminalThreadMissingOutcome,
    OpenThreadHasOutcome,
    TerminalThreadHasLiveActivation,
    ActivationGenerationAheadOfThread,
    GroupCountMismatch,
    TerminalGroupHasPendingMember,
    SatisfiedGroupMissingBarrier,
    TerminalGroupBarrierEventMissing,
    GroupSupervisorMissing,
    PendingDependencyTargetsTerminalGroup,
    ObjectiveWaitDisagreesWithDependencies,
    ObjectivePrimaryExecutionOwnerMismatch,
    DuplicateObjectivePrimaryExecutionThread,
    OrphanActivation,
    OrphanSignal,
    OrphanExecutionJob,
    OrphanApproval,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct SchedulerInvariantViolation {
    pub severity: SchedulerInvariantSeverity,
    pub code: SchedulerInvariantCode,
    pub entity_kind: String,
    pub entity_id: String,
    pub detail: String,
}

pub struct SchedulerInvariantInput<'a> {
    pub objectives: &'a [ObjectiveRecord],
    pub threads: &'a [ThreadRecord],
    pub activations: &'a [ThreadActivationRecord],
    pub outcomes: &'a [ThreadOutcomeRecord],
    pub groups: &'a [ThreadGroupRecord],
    pub group_members: &'a [ThreadGroupMemberRecord],
    pub dependencies: &'a [SchedulerDependencyRecord],
}

/// Pure, side-effect-free invariant audit. Recovery code may use these facts
/// to quarantine or retry physical ownership, but it must not invent missing
/// business outcomes from them.
pub fn audit_scheduler_invariants(
    input: SchedulerInvariantInput<'_>,
) -> Vec<SchedulerInvariantViolation> {
    let outcomes_by_thread = input
        .outcomes
        .iter()
        .map(|outcome| (outcome.thread_id.as_str(), outcome))
        .collect::<HashMap<_, _>>();
    let threads_by_root = input
        .threads
        .iter()
        .map(|thread| (thread.root_turn_id.as_str(), thread))
        .collect::<HashMap<_, _>>();
    let groups_by_id = input
        .groups
        .iter()
        .map(|group| (group.id.as_str(), group))
        .collect::<HashMap<_, _>>();
    let objectives_by_id = input
        .objectives
        .iter()
        .map(|objective| (objective.id.as_str(), objective))
        .collect::<HashMap<_, _>>();
    let mut violations = Vec::new();
    let mut objective_primary_executions = HashMap::<(&str, u64), Vec<&ThreadRecord>>::new();

    for thread in input.threads {
        let outcome = outcomes_by_thread.get(thread.id.as_str()).copied();
        if thread.lifecycle.is_terminal() && outcome.is_none() {
            violations.push(violation(
                SchedulerInvariantSeverity::Quarantine,
                SchedulerInvariantCode::TerminalThreadMissingOutcome,
                "thread",
                &thread.id,
                "terminal Thread does not have exactly one ThreadOutcome",
            ));
        }
        if thread.lifecycle == ThreadLifecycle::Open && outcome.is_some() {
            violations.push(violation(
                SchedulerInvariantSeverity::Quarantine,
                SchedulerInvariantCode::OpenThreadHasOutcome,
                "thread",
                &thread.id,
                "open Thread already has a terminal ThreadOutcome",
            ));
        }

        if thread.lifecycle != ThreadLifecycle::Open
            || thread.kind != ThreadKind::Execution
            || thread.supervision.supervisor_kind != ThreadSupervisorKind::Objective
            || thread.supervision.origin_evaluation_id.is_some()
        {
            continue;
        }
        let objective = thread
            .supervision
            .supervisor_id
            .as_deref()
            .and_then(|objective_id| objectives_by_id.get(objective_id).copied());
        let owner_matches = objective.is_some_and(|objective| {
            objective.status == ObjectiveStatus::Active
                && thread.supervision.generation == objective.generation
        });
        if !owner_matches {
            violations.push(violation(
                SchedulerInvariantSeverity::Quarantine,
                SchedulerInvariantCode::ObjectivePrimaryExecutionOwnerMismatch,
                "thread",
                &thread.id,
                "the open primary execution Thread does not belong to the active Objective generation",
            ));
            continue;
        }
        let objective = objective.expect("owner_matches guarantees Objective presence");
        objective_primary_executions
            .entry((objective.id.as_str(), objective.generation))
            .or_default()
            .push(thread);
    }

    for ((objective_id, generation), mut threads) in objective_primary_executions {
        if threads.len() <= 1 {
            continue;
        }
        threads.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        let expected_id = stable_thread_id(&objective_primary_execution_root_id(
            objective_id,
            generation,
        ));
        let preserved_id = threads
            .iter()
            .find(|thread| thread.id == expected_id)
            .map(|thread| thread.id.clone())
            .unwrap_or_else(|| threads[0].id.clone());
        for thread in threads {
            if thread.id == preserved_id {
                continue;
            }
            violations.push(violation(
                SchedulerInvariantSeverity::Quarantine,
                SchedulerInvariantCode::DuplicateObjectivePrimaryExecutionThread,
                "thread",
                &thread.id,
                "an Objective generation has multiple open primary execution Threads",
            ));
        }
    }

    for activation in input.activations {
        let Some(thread) = threads_by_root
            .get(activation.root_turn_id.as_str())
            .copied()
        else {
            continue;
        };
        if activation.generation > thread.generation {
            violations.push(violation(
                SchedulerInvariantSeverity::Quarantine,
                SchedulerInvariantCode::ActivationGenerationAheadOfThread,
                "activation",
                &activation.id,
                "Activation generation exceeds its owning Thread generation",
            ));
        }
        if thread.lifecycle.is_terminal()
            && activation.generation == thread.generation
            && !activation.status.is_terminal()
        {
            violations.push(violation(
                SchedulerInvariantSeverity::Quarantine,
                SchedulerInvariantCode::TerminalThreadHasLiveActivation,
                "activation",
                &activation.id,
                "the current generation of a terminal Thread still has a non-terminal Activation",
            ));
        }
    }

    let mut members_by_group = HashMap::<&str, Vec<&ThreadGroupMemberRecord>>::new();
    for member in input.group_members {
        members_by_group
            .entry(member.group_id.as_str())
            .or_default()
            .push(member);
    }
    for group in input.groups {
        let members = members_by_group
            .get(group.id.as_str())
            .cloned()
            .unwrap_or_default();
        let required = members.iter().filter(|member| member.required).count() as u64;
        let terminal = members
            .iter()
            .filter(|member| member.required && member.status.is_terminal())
            .count() as u64;
        let successful = members
            .iter()
            .filter(|member| member.required && member.status.is_success())
            .count() as u64;
        if (required, terminal, successful)
            != (
                group.required_count,
                group.terminal_count,
                group.successful_count,
            )
        {
            violations.push(violation(
                SchedulerInvariantSeverity::Quarantine,
                SchedulerInvariantCode::GroupCountMismatch,
                "thread_group",
                &group.id,
                "ThreadGroup counters are inconsistent with authoritative member rows",
            ));
        }
        if group.status.is_terminal()
            && members
                .iter()
                .any(|member| member.required && !member.status.is_terminal())
        {
            violations.push(violation(
                SchedulerInvariantSeverity::Quarantine,
                SchedulerInvariantCode::TerminalGroupHasPendingMember,
                "thread_group",
                &group.id,
                "terminal ThreadGroup still has a required pending member",
            ));
        }
        if group.status == ThreadGroupStatus::Satisfied && group.barrier_event_id.is_none() {
            violations.push(violation(
                SchedulerInvariantSeverity::Error,
                SchedulerInvariantCode::SatisfiedGroupMissingBarrier,
                "thread_group",
                &group.id,
                "satisfied ThreadGroup is missing its atomically committed barrier Event",
            ));
        }
    }

    for dependency in input.dependencies {
        if dependency.status != SchedulerDependencyStatus::Pending
            || dependency.dependency_kind != SchedulerDependencyKind::ThreadGroup
        {
            continue;
        }
        if groups_by_id
            .get(dependency.dependency_id.as_str())
            .is_some_and(|group| group.status.is_terminal())
        {
            violations.push(violation(
                SchedulerInvariantSeverity::Quarantine,
                SchedulerInvariantCode::PendingDependencyTargetsTerminalGroup,
                "scheduler_dependency",
                &dependency.id,
                "pending dependency points to a terminal ThreadGroup",
            ));
        }
    }

    let pending_objective_owners = input
        .dependencies
        .iter()
        .filter(|dependency| {
            dependency.owner_kind == SchedulerDependencyOwnerKind::Objective
                && dependency.required
                && dependency.status == SchedulerDependencyStatus::Pending
        })
        .map(|dependency| (dependency.owner_id.as_str(), dependency.owner_generation))
        .collect::<HashSet<_>>();
    for objective in input.objectives {
        let dependencies_wait =
            pending_objective_owners.contains(&(objective.id.as_str(), objective.generation));
        let legacy_wait = objective.wait_condition.is_some();
        if dependencies_wait != legacy_wait {
            violations.push(violation(
                SchedulerInvariantSeverity::Warning,
                SchedulerInvariantCode::ObjectiveWaitDisagreesWithDependencies,
                "objective",
                &objective.id,
                "wait_condition is inconsistent with scheduler_dependencies during migration",
            ));
        }
    }

    violations
}

fn violation(
    severity: SchedulerInvariantSeverity,
    code: SchedulerInvariantCode,
    entity_kind: &str,
    entity_id: &str,
    detail: &str,
) -> SchedulerInvariantViolation {
    SchedulerInvariantViolation {
        severity,
        code,
        entity_kind: entity_kind.to_string(),
        entity_id: entity_id.to_string(),
        detail: detail.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::{
        DeliveryStatus, ObjectiveWaitCondition, ThreadActivationStatus, ThreadControlState,
        ThreadGroupMemberStatus, ThreadGroupPolicy, ThreadKind, ThreadSupervision,
        ThreadSupervisorKind,
    };
    use chrono::Duration;

    fn objective(now: DateTime<Utc>) -> ObjectiveRecord {
        ObjectiveRecord {
            id: "objective-1".into(),
            agent_id: "agent-1".into(),
            context_id: "context-1".into(),
            coordinator_session_id: "session-1".into(),
            delivery_session_id: "session-1".into(),
            parent_objective_id: None,
            source_event_id: "event-1".into(),
            initiating_principal_id: None,
            stated_objective: "finish".into(),
            revision: 3,
            generation: 3,
            status: ObjectiveStatus::Active,
            status_reason: None,
            wait_condition: None,
            completion_intent: None,
            active_evaluation_id: None,
            evaluation_lease_expires_at: None,
            continuation_sequence: 0,
            token_budget: None,
            tokens_used: 0,
            time_used_seconds: 0,
            created_at: now,
            updated_at: now,
        }
    }

    fn dependency(now: DateTime<Utc>) -> SchedulerDependencyRecord {
        SchedulerDependencyRecord {
            id: "dependency-1".into(),
            owner_kind: SchedulerDependencyOwnerKind::Objective,
            owner_id: "objective-1".into(),
            owner_generation: 3,
            dependency_kind: SchedulerDependencyKind::ThreadGroup,
            dependency_id: "group-1".into(),
            dependency_generation: 3,
            required: true,
            status: SchedulerDependencyStatus::Pending,
            metadata: JsonValue::Object(Default::default()),
            satisfied_by_event_id: None,
            created_at: now,
            updated_at: now,
            satisfied_at: None,
        }
    }

    fn thread(now: DateTime<Utc>, lifecycle: ThreadLifecycle) -> ThreadRecord {
        ThreadRecord {
            id: "thread-1".into(),
            revision: 1,
            generation: 1,
            agent_id: "agent-1".into(),
            context_id: "context-1".into(),
            session_id: "session-1".into(),
            initiating_principal_id: None,
            root_turn_id: "root-1".into(),
            kind: ThreadKind::Execution,
            lifecycle,
            control_state: ThreadControlState::Active,
            executor_kind: "runtime".into(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision {
                lifetime: crate::memory::ThreadLifetime::Durable,
                supervisor_kind: ThreadSupervisorKind::Objective,
                supervisor_id: Some("objective-1".into()),
                generation: 3,
                origin_evaluation_id: Some("evaluation-1".into()),
                parent_thread_id: None,
                thread_group_id: Some("group-1".into()),
                completion_contract: JsonValue::Object(Default::default()),
            },
            result_text: None,
            result_event_id: None,
            delivery_status: DeliveryStatus::None,
            delivery_event_id: None,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn readiness_uses_current_generation_dependencies_and_live_lease() {
        let now = Utc::now();
        let mut objective = objective(now);
        let current = dependency(now);
        let mut stale = current.clone();
        stale.id = "dependency-stale".into();
        stale.owner_generation = 2;

        assert_eq!(
            derive_objective_readiness(&objective, &[stale], now),
            ObjectiveReadiness::Runnable
        );
        assert_eq!(
            derive_objective_readiness(&objective, &[current], now),
            ObjectiveReadiness::Waiting {
                dependency_ids: vec!["dependency-1".into()]
            }
        );

        objective.active_evaluation_id = Some("evaluation-1".into());
        objective.evaluation_lease_expires_at = Some(now + Duration::seconds(30));
        assert_eq!(
            derive_objective_readiness(&objective, &[], now),
            ObjectiveReadiness::Leased {
                evaluation_id: "evaluation-1".into()
            }
        );
    }

    #[test]
    fn stale_terminal_group_dependency_is_quarantined() {
        let now = Utc::now();
        let mut objective = objective(now);
        objective.wait_condition = Some(ObjectiveWaitCondition::ThreadGroup {
            group_id: "group-1".into(),
        });
        let group = ThreadGroupRecord {
            id: "group-1".into(),
            revision: 2,
            context_id: "context-1".into(),
            session_id: "session-1".into(),
            supervisor_kind: ThreadSupervisorKind::Objective,
            supervisor_id: "objective-1".into(),
            generation: 3,
            policy: ThreadGroupPolicy::All,
            required_count: 1,
            terminal_count: 1,
            successful_count: 1,
            status: ThreadGroupStatus::Satisfied,
            completion_contract: JsonValue::Object(Default::default()),
            terminal_summary: JsonValue::Object(Default::default()),
            barrier_event_id: Some("barrier-1".into()),
            created_at: now,
            updated_at: now,
            satisfied_at: Some(now),
        };
        let member = ThreadGroupMemberRecord {
            group_id: "group-1".into(),
            thread_id: "thread-1".into(),
            ordinal: 0,
            required: true,
            status: ThreadGroupMemberStatus::Completed,
            outcome_id: Some("outcome-1".into()),
            created_at: now,
            updated_at: now,
        };
        let violations = audit_scheduler_invariants(SchedulerInvariantInput {
            objectives: &[objective],
            threads: &[],
            activations: &[],
            outcomes: &[],
            groups: &[group],
            group_members: &[member],
            dependencies: &[dependency(now)],
        });
        assert!(violations.iter().any(|violation| {
            violation.code == SchedulerInvariantCode::PendingDependencyTargetsTerminalGroup
                && violation.severity == SchedulerInvariantSeverity::Quarantine
        }));
    }

    #[test]
    fn terminal_thread_with_live_activation_is_quarantined() {
        let now = Utc::now();
        let thread = thread(now, ThreadLifecycle::Completed);
        let activation = ThreadActivationRecord {
            id: "activation-1".into(),
            revision: 1,
            generation: 1,
            agent_id: "agent-1".into(),
            context_id: "context-1".into(),
            session_id: "session-1".into(),
            initiating_principal_id: None,
            trigger_event_id: "trigger-1".into(),
            trigger_sequence: 1,
            trigger_kind: "test".into(),
            parent_activation_id: None,
            root_turn_id: "root-1".into(),
            model_alias: None,
            context_snapshot_version: None,
            status: ThreadActivationStatus::Running,
            claimed_by: Some("worker-1".into()),
            lease_expires_at: Some(now + Duration::seconds(30)),
            dialogue_lane_released_at: None,
            created_at: now,
            updated_at: now,
        };
        let violations = audit_scheduler_invariants(SchedulerInvariantInput {
            objectives: &[],
            threads: &[thread],
            activations: &[activation],
            outcomes: &[],
            groups: &[],
            group_members: &[],
            dependencies: &[],
        });
        assert!(violations.iter().any(|violation| {
            violation.code == SchedulerInvariantCode::TerminalThreadHasLiveActivation
        }));
        assert!(violations.iter().any(|violation| {
            violation.code == SchedulerInvariantCode::TerminalThreadMissingOutcome
        }));
    }

    #[test]
    fn only_one_current_objective_primary_execution_thread_remains_admissible() {
        let now = Utc::now();
        let objective = objective(now);
        let root = objective_primary_execution_root_id(&objective.id, objective.generation);
        let primary = ThreadRecord {
            id: stable_thread_id(&root),
            revision: 1,
            generation: 1,
            agent_id: objective.agent_id.clone(),
            context_id: objective.context_id.clone(),
            session_id: objective.coordinator_session_id.clone(),
            initiating_principal_id: None,
            root_turn_id: root,
            kind: ThreadKind::Execution,
            lifecycle: ThreadLifecycle::Open,
            control_state: ThreadControlState::Active,
            executor_kind: "self".into(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::objective_primary_execution(
                objective.id.clone(),
                objective.generation,
            ),
            result_text: None,
            result_event_id: None,
            delivery_status: DeliveryStatus::None,
            delivery_event_id: None,
            created_at: now,
            updated_at: now,
        };
        let mut duplicate = primary.clone();
        duplicate.id = "thread-duplicate".into();
        duplicate.root_turn_id = "objective-primary-execution-duplicate-root".into();
        duplicate.created_at = now + Duration::seconds(1);
        let mut stale = primary.clone();
        stale.id = "thread-stale".into();
        stale.root_turn_id = "objective-primary-execution-stale-root".into();
        stale.supervision.generation = objective.generation - 1;

        let violations = audit_scheduler_invariants(SchedulerInvariantInput {
            objectives: &[objective],
            threads: &[primary.clone(), duplicate.clone(), stale.clone()],
            activations: &[],
            outcomes: &[],
            groups: &[],
            group_members: &[],
            dependencies: &[],
        });
        assert!(violations.iter().any(|violation| {
            violation.code == SchedulerInvariantCode::DuplicateObjectivePrimaryExecutionThread
                && violation.entity_id == duplicate.id
        }));
        assert!(violations.iter().any(|violation| {
            violation.code == SchedulerInvariantCode::ObjectivePrimaryExecutionOwnerMismatch
                && violation.entity_id == stale.id
        }));
        assert!(!violations
            .iter()
            .any(|violation| violation.entity_id == primary.id));
    }
}
