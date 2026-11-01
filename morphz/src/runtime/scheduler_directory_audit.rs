//! Directory diagnostics use scalar witnesses, never child payload histories.
use super::*;
use crate::memory::audit_page::{AuditQuery, AuditSource as S, AuditWitness as W};
use crate::scheduler::authority::AuthorityFacts;
impl MorphzRuntime {
    pub(super) async fn scheduler_directory_invariants(
        &self,
        context: &str,
        objectives: &[ObjectiveRecord],
        threads: &[ThreadRecord],
        activations: &[ThreadActivationRecord],
        groups: &[crate::memory::ThreadGroupRecord],
        _counts: &[crate::scheduler::domain::GroupMemberCounts],
    ) -> Result<Vec<SchedulerInvariantViolation>, RuntimeError> {
        let store = &self.inner.store;
        let mut facts = AuthorityFacts {
            threads: threads.iter().map(Into::into).collect(),
            ..Default::default()
        };
        let mut objective_ids = objectives
            .iter()
            .map(|o| o.id.clone())
            .collect::<HashSet<_>>();
        objective_ids.extend(
            threads
                .iter()
                .filter(|t| {
                    t.supervision.supervisor_kind == crate::memory::ThreadSupervisorKind::Objective
                })
                .filter_map(|t| t.supervision.supervisor_id.clone()),
        );
        for ids in objective_ids.into_iter().collect::<Vec<_>>().chunks(200) {
            facts.objectives.extend(
                store
                    .scheduler_authority_page(&AuditQuery {
                        context_id: context.into(),
                        source: S::Objectives,
                        after: String::new(),
                        ids: Some(ids.to_vec()),
                        roots: None,
                        include_terminal: true,
                        limit: 200,
                    })
                    .await?
                    .facts
                    .objectives,
            );
        }
        let group_ids = groups.iter().map(|g| g.id.clone()).collect::<Vec<_>>();
        for ids in group_ids.chunks(200) {
            facts.groups.extend(
                store
                    .scheduler_authority_page(&AuditQuery {
                        context_id: context.into(),
                        source: S::Groups,
                        after: String::new(),
                        ids: Some(ids.to_vec()),
                        roots: None,
                        include_terminal: true,
                        limit: 200,
                    })
                    .await?
                    .facts
                    .groups,
            );
        }
        let counts = facts
            .groups
            .iter()
            .filter_map(|g| g.member_counts.clone())
            .collect::<Vec<_>>();
        let ids = threads.iter().map(|t| t.id.clone()).collect::<Vec<_>>();
        for ids in ids.chunks(200) {
            facts.outcome_threads.extend(
                store
                    .scheduler_authority_witnesses(context, W::Outcomes, ids)
                    .await?
                    .into_iter()
                    .map(|v| v.0),
            );
        }
        let ids = facts
            .objectives
            .iter()
            .map(|o| o.id.clone())
            .collect::<Vec<_>>();
        for ids in ids.chunks(200) {
            facts.pending_objective_owners.extend(
                store
                    .scheduler_authority_witnesses(context, W::PendingObjectives, ids)
                    .await?,
            );
        }
        let owners = facts
            .objectives
            .iter()
            .map(|o| (o.id.clone(), o.generation))
            .collect::<Vec<_>>();
        for owners in owners.chunks(200) {
            facts.preserved_primary.extend(
                store
                    .scheduler_primary_choices(context, owners)
                    .await?
                    .into_iter()
                    .map(|(id, generation, preserved)| ((id, generation), preserved)),
            );
        }
        let mut violations = crate::scheduler::domain::audit_scheduler_authority(
            SchedulerInvariantInput {
                objectives: &[],
                threads: &[],
                activations,
                outcomes: &[],
                groups: &[],
                group_members: &[],
                dependencies: &[],
            },
            &counts,
            &facts,
        );
        let ids = groups
            .iter()
            .filter_map(|g| g.barrier_event_id.clone())
            .collect::<Vec<_>>();
        let mut events = HashSet::new();
        for ids in ids.chunks(200) {
            events.extend(
                store
                    .scheduler_authority_witnesses(context, W::Events, ids)
                    .await?
                    .into_iter()
                    .map(|v| v.0),
            );
        }
        violations.extend(
            crate::recovery::SchedulerReconciler::audit_supervision_authority(
                &facts.objectives,
                &facts.threads,
                activations,
                &facts.groups,
                &events,
            ),
        );
        // A directory reports one indexed corruption witness per selected owner.
        // The committed integrity worker independently pages every offending edge.
        for (kind, id) in objectives
            .iter()
            .map(|o| ("objective", &o.id))
            .chain(threads.iter().map(|t| ("thread", &t.id)))
        {
            if let Some(edge) = store
                .scheduler_invalid_group_dependency(context, kind, id)
                .await?
            {
                violations.push(SchedulerInvariantViolation{severity:SchedulerInvariantSeverity::Quarantine,code:SchedulerInvariantCode::PendingDependencyTargetsTerminalGroup,entity_kind:"scheduler_dependency".into(),entity_id:edge,detail:"pending dependency points to a terminal ThreadGroup; directory shows the first witness for this owner".into()});
            }
        }
        violations.sort();
        violations.dedup();
        Ok(violations)
    }
}
