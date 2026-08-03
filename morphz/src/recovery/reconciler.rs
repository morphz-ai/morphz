use crate::memory::{
    ObjectiveRecord, ThreadActivationRecord, ThreadControlState, ThreadGroupRecord,
    ThreadLifecycle, ThreadRecord, ThreadSupervisorKind,
};
use crate::scheduler::{
    SchedulerInvariantCode, SchedulerInvariantSeverity, SchedulerInvariantViolation,
};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReconcilerAction {
    /// Stop admission for one exact open Thread generation. No business
    /// lifecycle or result is inferred.
    QuarantineThread { thread_id: String, reason: String },
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReconcilerPlan {
    pub actions: Vec<ReconcilerAction>,
}

/// Pure planner for the deliberately narrow recovery boundary.
pub struct SchedulerReconciler;

impl SchedulerReconciler {
    /// Audits ownership and immutable barrier presence that cannot be derived
    /// from scheduler projection rows alone.
    pub fn audit_supervision(
        objectives: &[ObjectiveRecord],
        threads: &[ThreadRecord],
        activations: &[ThreadActivationRecord],
        groups: &[ThreadGroupRecord],
        existing_barrier_event_ids: &HashSet<String>,
    ) -> Vec<SchedulerInvariantViolation> {
        let objective_ids = objectives
            .iter()
            .filter(|objective| !objective.status.is_terminal())
            .map(|objective| objective.id.as_str())
            .collect::<HashSet<_>>();
        let activation_ids = activations
            .iter()
            .filter(|activation| !activation.status.is_terminal())
            .map(|activation| activation.id.as_str())
            .collect::<HashSet<_>>();
        let thread_generations = threads
            .iter()
            .filter(|thread| thread.lifecycle == ThreadLifecycle::Open)
            .map(|thread| (thread.id.as_str(), thread.generation))
            .collect::<HashSet<_>>();
        let mut violations = Vec::new();
        for group in groups {
            if group.status.is_terminal() {
                match group.barrier_event_id.as_ref() {
                    Some(event_id) if existing_barrier_event_ids.contains(event_id) => {}
                    Some(event_id) => violations.push(SchedulerInvariantViolation {
                        severity: SchedulerInvariantSeverity::Error,
                        code: SchedulerInvariantCode::TerminalGroupBarrierEventMissing,
                        entity_kind: "thread_group".into(),
                        entity_id: group.id.clone(),
                        detail: format!(
                            "terminal ThreadGroup 引用不存在的 barrier Event '{event_id}'"
                        ),
                    }),
                    None => violations.push(SchedulerInvariantViolation {
                        severity: SchedulerInvariantSeverity::Error,
                        code: SchedulerInvariantCode::TerminalGroupBarrierEventMissing,
                        entity_kind: "thread_group".into(),
                        entity_id: group.id.clone(),
                        detail: "terminal ThreadGroup 缺少 barrier Event 引用".into(),
                    }),
                }
                continue;
            }
            let owner_exists = match group.supervisor_kind {
                ThreadSupervisorKind::Thread => {
                    thread_generations.contains(&(group.supervisor_id.as_str(), group.generation))
                }
                ThreadSupervisorKind::Evaluation => {
                    activation_ids.contains(group.supervisor_id.as_str())
                }
                ThreadSupervisorKind::Objective => {
                    objective_ids.contains(group.supervisor_id.as_str())
                }
                ThreadSupervisorKind::Runtime => true,
                ThreadSupervisorKind::None | ThreadSupervisorKind::Legacy => false,
            };
            if !owner_exists {
                violations.push(SchedulerInvariantViolation {
                    severity: SchedulerInvariantSeverity::Quarantine,
                    code: SchedulerInvariantCode::GroupSupervisorMissing,
                    entity_kind: "thread_group".into(),
                    entity_id: group.id.clone(),
                    detail: format!(
                        "open ThreadGroup 的 {:?} supervisor '{}' 不存在或已终结",
                        group.supervisor_kind, group.supervisor_id
                    ),
                });
            }
        }
        violations
    }

    pub fn plan(
        violations: &[SchedulerInvariantViolation],
        threads: &[ThreadRecord],
        thread_ids_by_entity: &HashMap<(String, String), Vec<String>>,
    ) -> ReconcilerPlan {
        let threads_by_id = threads
            .iter()
            .map(|thread| (thread.id.as_str(), thread))
            .collect::<HashMap<_, _>>();
        let mut quarantined = HashSet::new();
        let mut actions = Vec::new();
        for violation in violations {
            if violation.severity != SchedulerInvariantSeverity::Quarantine {
                continue;
            }
            let key = (violation.entity_kind.clone(), violation.entity_id.clone());
            let candidates = if violation.entity_kind == "thread" {
                vec![violation.entity_id.clone()]
            } else {
                thread_ids_by_entity.get(&key).cloned().unwrap_or_default()
            };
            for thread_id in candidates {
                let Some(thread) = threads_by_id.get(thread_id.as_str()).copied() else {
                    continue;
                };
                if thread.lifecycle != ThreadLifecycle::Open
                    || thread.control_state != ThreadControlState::Active
                    || !quarantined.insert(thread_id.clone())
                {
                    continue;
                }
                actions.push(ReconcilerAction::QuarantineThread {
                    thread_id,
                    reason: format!(
                        "Scheduler invariant {:?}: {}",
                        violation.code, violation.detail
                    ),
                });
            }
        }
        ReconcilerPlan { actions }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::{
        DeliveryStatus, ThreadGroupPolicy, ThreadGroupStatus, ThreadKind, ThreadSupervision,
    };
    use crate::scheduler::{SchedulerInvariantCode, SchedulerInvariantViolation};
    use chrono::Utc;

    fn thread(id: &str) -> ThreadRecord {
        ThreadRecord {
            id: id.into(),
            revision: 1,
            generation: 1,
            agent_id: "agent-a".into(),
            context_id: "context-a".into(),
            session_id: "session-a".into(),
            initiating_principal_id: None,
            root_turn_id: format!("root-{id}"),
            kind: ThreadKind::Execution,
            lifecycle: ThreadLifecycle::Open,
            control_state: ThreadControlState::Active,
            executor_kind: "model".into(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::disposable("evaluation-a"),
            result_text: None,
            result_event_id: None,
            delivery_status: DeliveryStatus::None,
            delivery_event_id: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn only_quarantine_severity_can_pause_physical_admission() {
        let threads = vec![thread("thread-a")];
        let warning = SchedulerInvariantViolation {
            severity: SchedulerInvariantSeverity::Warning,
            code: SchedulerInvariantCode::ObjectiveWaitDisagreesWithDependencies,
            entity_kind: "thread".into(),
            entity_id: "thread-a".into(),
            detail: "diagnostic only".into(),
        };
        assert!(
            SchedulerReconciler::plan(&[warning], &threads, &HashMap::new())
                .actions
                .is_empty()
        );
    }

    #[test]
    fn attached_group_is_owned_by_the_open_parent_thread_generation() {
        let parent = thread("parent-thread");
        let now = Utc::now();
        let mut group = ThreadGroupRecord {
            id: "attached-group".into(),
            revision: 1,
            context_id: parent.context_id.clone(),
            session_id: parent.session_id.clone(),
            supervisor_kind: ThreadSupervisorKind::Thread,
            supervisor_id: parent.id.clone(),
            generation: parent.generation,
            policy: ThreadGroupPolicy::All,
            required_count: 1,
            terminal_count: 0,
            successful_count: 0,
            status: ThreadGroupStatus::Open,
            completion_contract: serde_json::Value::Object(Default::default()),
            terminal_summary: serde_json::Value::Object(Default::default()),
            barrier_event_id: None,
            created_at: now,
            updated_at: now,
            satisfied_at: None,
        };

        assert!(SchedulerReconciler::audit_supervision(
            &[],
            std::slice::from_ref(&parent),
            &[],
            std::slice::from_ref(&group),
            &HashSet::new(),
        )
        .is_empty());

        group.generation += 1;
        let violations =
            SchedulerReconciler::audit_supervision(&[], &[parent], &[], &[group], &HashSet::new());
        assert!(violations
            .iter()
            .any(|violation| { violation.code == SchedulerInvariantCode::GroupSupervisorMissing }));
    }

    #[test]
    fn every_terminal_group_requires_an_existing_barrier_event() {
        let now = Utc::now();
        let mut group = ThreadGroupRecord {
            id: "group-a".into(),
            revision: 1,
            context_id: "context-a".into(),
            session_id: "session-a".into(),
            supervisor_kind: ThreadSupervisorKind::Runtime,
            supervisor_id: "runtime".into(),
            generation: 1,
            policy: ThreadGroupPolicy::All,
            required_count: 0,
            terminal_count: 0,
            successful_count: 0,
            status: ThreadGroupStatus::Satisfied,
            completion_contract: serde_json::Value::Object(Default::default()),
            terminal_summary: serde_json::Value::Object(Default::default()),
            barrier_event_id: None,
            created_at: now,
            updated_at: now,
            satisfied_at: Some(now),
        };
        let violations = SchedulerReconciler::audit_supervision(
            &[],
            &[],
            &[],
            std::slice::from_ref(&group),
            &HashSet::new(),
        );
        assert!(violations.iter().any(|violation| {
            violation.code == SchedulerInvariantCode::TerminalGroupBarrierEventMissing
        }));

        group.barrier_event_id = Some("barrier-a".into());
        let violations = SchedulerReconciler::audit_supervision(
            &[],
            &[],
            &[],
            std::slice::from_ref(&group),
            &HashSet::new(),
        );
        assert!(violations.iter().any(|violation| {
            violation.code == SchedulerInvariantCode::TerminalGroupBarrierEventMissing
        }));

        let existing = HashSet::from(["barrier-a".to_string()]);
        assert!(
            SchedulerReconciler::audit_supervision(&[], &[], &[], &[group], &existing).is_empty()
        );
    }
}
