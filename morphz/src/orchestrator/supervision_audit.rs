//! Complete supervision checks with bounded scalar batches and exact witnesses.
use super::*;
use crate::memory::audit_page::{AuditPage, AuditQuery, AuditSource as S, AuditWitness as W};
use crate::scheduler::authority::AuthorityFacts;
use crate::scheduler::SchedulerInvariantSeverity;
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct SupervisionAuditReport {
    pub violations: Vec<SchedulerInvariantViolation>,
    pub total: usize,
}
impl SupervisionAuditReport {
    pub fn len(&self) -> usize {
        self.total
    }
    pub fn is_empty(&self) -> bool {
        self.total == 0
    }
    fn observe(&mut self, rows: &[SchedulerInvariantViolation]) {
        self.total += rows.len();
        for row in rows {
            // All diagnostics reach the existing log sink; the retained comparison
            // sample is bounded and its complete count is reported separately.
            tracing::warn!(event_code="orchestrator.scheduler_authority.violation",code=?row.code,severity=?row.severity,entity_kind=%row.entity_kind,entity_id=%row.entity_id,detail=%row.detail,"Scheduler authority invariant");
            if self.violations.len() < 200 {
                self.violations.push(row.clone());
            }
        }
    }
}
impl Orchestrator {
    async fn authority_points(
        &self,
        context: &str,
        source: S,
        keys: &[String],
        roots: bool,
    ) -> Result<AuditPage, DynError> {
        let store = self.plan_store.as_ref().ok_or("Plan Store unavailable")?;
        let mut result = AuditPage::default();
        for ids in keys.chunks(200) {
            let page = store
                .scheduler_authority_page(&AuditQuery {
                    context_id: context.into(),
                    source,
                    after: String::new(),
                    ids: (!roots).then(|| ids.to_vec()),
                    roots: roots.then(|| ids.to_vec()),
                    include_terminal: true,
                    limit: 200,
                })
                .await?;
            if page.has_more {
                return Err("authority point batch exceeds unique identities".into());
            }
            result.facts.objectives.extend(page.facts.objectives);
            result.facts.threads.extend(page.facts.threads);
            result.facts.groups.extend(page.facts.groups);
            result.activations.extend(page.activations);
        }
        Ok(result)
    }
    async fn close_authority_graph(
        &self,
        context: &str,
        facts: &mut AuthorityFacts,
        activations: &mut Vec<ThreadActivationRecord>,
    ) -> Result<HashSet<String>, DynError> {
        let mut thread_ids = facts
            .groups
            .iter()
            .filter(|g| g.supervisor_kind == ThreadSupervisorKind::Thread)
            .map(|g| g.supervisor_id.clone())
            .collect::<Vec<_>>();
        let roots = activations
            .iter()
            .map(|a| a.root_turn_id.clone())
            .collect::<Vec<_>>();
        facts.threads.extend(
            self.authority_points(context, S::Threads, &roots, true)
                .await?
                .facts
                .threads,
        );
        facts.threads.extend(
            self.authority_points(context, S::Threads, &thread_ids, false)
                .await?
                .facts
                .threads,
        );
        let activation_ids = facts
            .groups
            .iter()
            .filter(|g| g.supervisor_kind == ThreadSupervisorKind::Evaluation)
            .map(|g| g.supervisor_id.clone())
            .collect::<Vec<_>>();
        activations.extend(
            self.authority_points(context, S::Activations, &activation_ids, false)
                .await?
                .activations,
        );
        let mut objective_ids = facts
            .threads
            .iter()
            .filter(|t| t.supervision.supervisor_kind == ThreadSupervisorKind::Objective)
            .filter_map(|t| t.supervision.supervisor_id.clone())
            .collect::<Vec<_>>();
        objective_ids.extend(
            facts
                .groups
                .iter()
                .filter(|g| g.supervisor_kind == ThreadSupervisorKind::Objective)
                .map(|g| g.supervisor_id.clone()),
        );
        facts.objectives.extend(
            self.authority_points(context, S::Objectives, &objective_ids, false)
                .await?
                .facts
                .objectives,
        );
        facts.threads.sort_by(|a, b| a.id.cmp(&b.id));
        facts.threads.dedup_by(|a, b| a.id == b.id);
        facts.objectives.sort_by(|a, b| a.id.cmp(&b.id));
        facts.objectives.dedup_by(|a, b| a.id == b.id);
        activations.sort_by(|a, b| a.id.cmp(&b.id));
        activations.dedup_by(|a, b| a.id == b.id);
        thread_ids = facts.threads.iter().map(|t| t.id.clone()).collect();
        objective_ids = facts.objectives.iter().map(|o| o.id.clone()).collect();
        let store = self.plan_store.as_ref().unwrap();
        for ids in thread_ids.chunks(200) {
            facts.outcome_threads.extend(
                store
                    .scheduler_authority_witnesses(context, W::Outcomes, ids)
                    .await?
                    .into_iter()
                    .map(|v| v.0),
            );
        }
        for ids in objective_ids.chunks(200) {
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
        let event_ids = facts
            .groups
            .iter()
            .filter_map(|g| g.barrier_event_id.clone())
            .collect::<Vec<_>>();
        let mut events = HashSet::new();
        for ids in event_ids.chunks(200) {
            events.extend(
                store
                    .scheduler_authority_witnesses(context, W::Events, ids)
                    .await?
                    .into_iter()
                    .map(|v| v.0),
            );
        }
        Ok(events)
    }
    async fn apply_authority_violations(
        &self,
        context: &str,
        facts: &AuthorityFacts,
        activations: &[ThreadActivationRecord],
        violations: &[SchedulerInvariantViolation],
    ) -> Result<(), DynError> {
        let mut routes = HashMap::new();
        for activation in activations {
            if let Some(thread) = facts
                .threads
                .iter()
                .find(|t| t.root_turn_id == activation.root_turn_id)
            {
                routes.insert(
                    ("activation".to_string(), activation.id.clone()),
                    vec![thread.id.clone()],
                );
            }
        }
        let plan = crate::recovery::SchedulerReconciler::plan_authority(
            violations,
            &facts.threads,
            &routes,
        );
        self.apply_authority_plan(context, &facts.threads, plan)
            .await?;
        // Only a real quarantinable Group violation opens its member pages. No
        // successful Group check materializes member/outcome histories.
        for id in violations
            .iter()
            .filter(|v| {
                v.severity == SchedulerInvariantSeverity::Quarantine
                    && v.entity_kind == "thread_group"
            })
            .map(|v| &v.entity_id)
            .collect::<HashSet<_>>()
        {
            let store = self.plan_store.as_ref().unwrap();
            let mut cursor = None;
            loop {
                let page = store.read_group_member_page(id, cursor.clone(), 64).await?;
                let ids = page
                    .items
                    .iter()
                    .map(|m| m.thread_id.clone())
                    .collect::<Vec<_>>();
                let threads = self
                    .authority_points(context, S::Threads, &ids, false)
                    .await?
                    .facts
                    .threads;
                let routes = HashMap::from([(("thread_group".to_string(), id.clone()), ids)]);
                let plan = crate::recovery::SchedulerReconciler::plan_authority(
                    violations, &threads, &routes,
                );
                self.apply_authority_plan(context, &threads, plan).await?;
                if !page.has_more {
                    break;
                }
                let next = page.next_cursor.ok_or("Group audit continuation missing")?;
                if cursor.as_ref() == Some(&next) {
                    return Err("Group audit continuation did not advance".into());
                }
                cursor = Some(next);
                tokio::task::yield_now().await;
            }
        }
        Ok(())
    }
    async fn apply_authority_plan(
        &self,
        context: &str,
        threads: &[crate::scheduler::authority::ThreadAuthority],
        plan: crate::recovery::ReconcilerPlan,
    ) -> Result<(), DynError> {
        let Some(kernel) = self.scheduler_kernel.as_ref() else {
            return Err("Scheduler Kernel unavailable".into());
        };
        for action in plan.actions {
            let crate::recovery::ReconcilerAction::QuarantineThread { thread_id, reason } = action;
            let Some(thread) = threads.iter().find(|t| t.id == thread_id) else {
                continue;
            };
            let command = crate::controllers::DialogueController::control_thread_fence(
                &thread.id,
                thread.revision,
                thread.generation,
                context,
                ThreadControlAction::Pause,
                reason.clone(),
                "Runtime-Reconciler",
            );
            match kernel.execute(command).await? {
                crate::scheduler::KernelResult::ThreadControlled(ThreadMutation::Updated(_)) => {
                    tracing::warn!(event_code="orchestrator.scheduler_reconciler.thread_quarantined",thread_id=%thread.id,reason=%reason,"Scheduler Reconciler quarantined an invariant violation")
                }
                crate::scheduler::KernelResult::ThreadControlled(
                    ThreadMutation::Conflict { .. } | ThreadMutation::NotFound,
                ) => {}
                _ => unreachable!("ControlThread result"),
            }
        }
        Ok(())
    }
    async fn audit_authority_batch(
        &self,
        context: &str,
        mut page: AuditPage,
        report: &mut SupervisionAuditReport,
    ) -> Result<(), DynError> {
        let owners = page
            .facts
            .objectives
            .iter()
            .map(|o| ("objective", o.id.clone()))
            .chain(page.facts.threads.iter().map(|t| ("thread", t.id.clone())))
            .collect::<Vec<_>>();
        let barriers = self
            .close_authority_graph(context, &mut page.facts, &mut page.activations)
            .await?;
        let counts = page
            .facts
            .groups
            .iter()
            .map(|g| {
                g.member_counts
                    .clone()
                    .ok_or("Group counter witness missing")
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut violations = crate::scheduler::domain::audit_scheduler_authority(
            crate::scheduler::SchedulerInvariantInput {
                objectives: &[],
                threads: &[],
                activations: &page.activations,
                outcomes: &[],
                groups: &[],
                group_members: &[],
                dependencies: &[],
            },
            &counts,
            &page.facts,
        );
        violations.extend(
            crate::recovery::SchedulerReconciler::audit_supervision_authority(
                &page.facts.objectives,
                &page.facts.threads,
                &page.activations,
                &page.facts.groups,
                &barriers,
            ),
        );
        violations.sort();
        violations.dedup();
        self.apply_authority_violations(context, &page.facts, &page.activations, &violations)
            .await?;
        report.observe(&violations);
        // All pending Group edges of the selected owners are checked, including
        // retained generations. Each independent target page carries no metadata.
        for (kind, id) in owners {
            let mut after = String::new();
            loop {
                let rows = self
                    .plan_store
                    .as_ref()
                    .unwrap()
                    .scheduler_dependency_targets(context, kind, &id, &after)
                    .await?;
                let more = rows.len() > 200;
                let rows = rows.into_iter().take(200).collect::<Vec<_>>();
                let ids = rows.iter().map(|d| d.target.clone()).collect::<Vec<_>>();
                let targets = self
                    .authority_points(context, S::Groups, &ids, false)
                    .await?;
                let bad=rows.iter().filter(|d|targets.facts.groups.iter().any(|g|g.id==d.target&&g.status.is_terminal())).map(|d|SchedulerInvariantViolation{severity:SchedulerInvariantSeverity::Quarantine,code:crate::scheduler::SchedulerInvariantCode::PendingDependencyTargetsTerminalGroup,entity_kind:"scheduler_dependency".into(),entity_id:d.id.clone(),detail:"pending dependency points to a terminal ThreadGroup".into()}).collect::<Vec<_>>();
                report.observe(&bad);
                // Exact terminal targets retain their own counters/barrier diagnostics.
                if !targets.facts.groups.is_empty() {
                    let mut facts = targets.facts;
                    let mut activations = Vec::new();
                    let events = self
                        .close_authority_graph(context, &mut facts, &mut activations)
                        .await?;
                    let counts = facts
                        .groups
                        .iter()
                        .map(|g| g.member_counts.clone().unwrap())
                        .collect::<Vec<_>>();
                    let mut checks = crate::scheduler::domain::audit_scheduler_authority(
                        crate::scheduler::SchedulerInvariantInput {
                            objectives: &[],
                            threads: &[],
                            activations: &activations,
                            outcomes: &[],
                            groups: &[],
                            group_members: &[],
                            dependencies: &[],
                        },
                        &counts,
                        &facts,
                    );
                    checks.extend(
                        crate::recovery::SchedulerReconciler::audit_supervision_authority(
                            &facts.objectives,
                            &facts.threads,
                            &activations,
                            &facts.groups,
                            &events,
                        ),
                    );
                    checks.sort();
                    checks.dedup();
                    self.apply_authority_violations(context, &facts, &activations, &checks)
                        .await?;
                    report.observe(&checks);
                }
                if !more {
                    break;
                }
                let next = rows.last().ok_or("dependency audit page empty")?.id.clone();
                if next <= after {
                    return Err("dependency audit continuation did not advance".into());
                }
                after = next;
                tokio::task::yield_now().await;
            }
        }
        Ok(())
    }
    pub(super) async fn audit_supervision_context_paged(
        &self,
        context: &str,
        include_terminal: bool,
    ) -> Result<SupervisionAuditReport, DynError> {
        let Some(store) = self.plan_store.as_ref() else {
            return Ok(Default::default());
        };
        if self.scheduler_kernel.is_none() {
            return Err("Scheduler Kernel unavailable".into());
        }
        let mut report = SupervisionAuditReport::default();
        for source in [S::Objectives, S::Threads, S::Activations, S::Groups] {
            let mut after = String::new();
            loop {
                let page = store
                    .scheduler_authority_page(&AuditQuery {
                        context_id: context.into(),
                        source,
                        after: after.clone(),
                        ids: None,
                        roots: None,
                        include_terminal,
                        limit: 200,
                    })
                    .await?;
                let next = page.next_id.clone();
                let more = page.has_more;
                self.audit_authority_batch(context, page, &mut report)
                    .await?;
                if !more {
                    break;
                }
                let next = next.ok_or("authority audit continuation missing")?;
                if next <= after {
                    return Err("authority audit continuation did not advance".into());
                }
                after = next;
                tokio::task::yield_now().await;
            }
        }
        report.violations.sort();
        Ok(report)
    }
}
