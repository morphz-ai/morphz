//! Bounded, read-only execution inspector. No model requests, task control,
//! history repair or full Thread-detail materialization belong in this path.
use super::*;
use crate::memory::{ExecutionJobFilter, ThreadActivityFlags};

#[derive(Debug)]
pub enum ExecutionRecordsError {
    InvalidQuery,
    NotFound,
    Forbidden,
    Conflict,
}

impl std::fmt::Display for ExecutionRecordsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidQuery => "Execution record query exceeds its bound or has invalid scope",
            Self::NotFound => "Session Thread not found",
            Self::Forbidden => "Thread source does not belong to the selected input",
            Self::Conflict => "Thread scope or generation changed during execution read",
        })
    }
}
impl std::error::Error for ExecutionRecordsError {}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ExecutionRecordsQuery {
    pub thread_id: Option<String>,
    #[serde(default)]
    pub thread_ids: Vec<String>,
    #[serde(default)]
    pub root_turn_ids: Vec<String>,
    #[serde(default)]
    pub include_descendants: bool,
    #[serde(default)]
    pub metadata_only: bool,
    pub limit: Option<usize>,
}

impl ExecutionRecordsQuery {
    pub fn validate(&self) -> Result<usize, ExecutionRecordsError> {
        let limit = self.limit.unwrap_or(100);
        let ids = self
            .thread_id
            .iter()
            .chain(self.thread_ids.iter())
            .chain(self.root_turn_ids.iter());
        let mut bytes = 0;
        for id in ids {
            bytes += id.len();
            if id.is_empty() || id.len() > 1024 || bytes > 65536 {
                return Err(ExecutionRecordsError::InvalidQuery);
            }
        }
        if !(1..=100).contains(&limit)
            || self.root_turn_ids.len() > 1024
            || self.thread_ids.len() > 100
            || (self.thread_id.is_some() && !self.thread_ids.is_empty())
            || (self.include_descendants && self.thread_id.is_none())
            || (self.metadata_only && self.thread_id.is_none() && self.thread_ids.is_empty())
        {
            return Err(ExecutionRecordsError::InvalidQuery);
        }
        Ok(limit)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionRecordThread {
    pub id: String,
    pub session_id: String,
    pub context_id: String,
    pub root_turn_id: String,
    pub parent_thread_id: Option<String>,
    pub generation: u64,
    pub revision: u64,
    pub lifecycle: ThreadLifecycle,
    pub control_state: ThreadControlState,
    pub phase: ThreadPhase,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    pub intent: Option<String>,
    pub response_annotations: Option<ThreadResponseAnnotations>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionRecords {
    pub session_id: String,
    pub context_id: String,
    pub selected_thread_id: Option<String>,
    /// Owner-resolved source, independent of a synthetic execution root.
    pub source_root_id: Option<String>,
    pub threads: Vec<ExecutionRecordThread>,
    pub threads_truncated: bool,
    pub jobs: Vec<ExecutionJobRecord>,
    pub has_more_jobs: bool,
    pub limit: usize,
}

impl MorphzRuntime {
    pub async fn session_execution_records(
        &self,
        context_id: &str,
        session_id: &str,
        principal_id: &str,
        query: ExecutionRecordsQuery,
    ) -> Result<ExecutionRecords, RuntimeError> {
        let limit = query.validate()?;
        let mut threads = Vec::new();
        let mut threads_truncated = false;
        let mut source_root_id = None;
        if let Some(id) = query.thread_id.as_deref() {
            let family = self
                .inner
                .store
                .read_thread_family_bounded(
                    context_id,
                    session_id,
                    id,
                    if query.include_descendants { 64 } else { 1 },
                )
                .await?
                .ok_or(ExecutionRecordsError::NotFound)?;
            threads = family.threads;
            threads_truncated = query.include_descendants && family.has_more;
            source_root_id = self
                .thread_origins(context_id, &threads[..1])
                .await?
                .remove(id)
                .map(|origin| match origin {
                    ThreadOrigin::Input { source, .. } => source.root_turn_id,
                    ThreadOrigin::Schedule { source_turn_id, .. } => source_turn_id,
                });
            if !query.root_turn_ids.is_empty()
                && !source_root_id
                    .as_ref()
                    .is_some_and(|root| query.root_turn_ids.contains(root))
            {
                return Err(ExecutionRecordsError::Forbidden.into());
            }
        } else if !query.thread_ids.is_empty() {
            threads = self
                .inner
                .store
                .list_threads_by_ids(context_id, &query.thread_ids)
                .await?;
            if threads.len() != query.thread_ids.iter().collect::<HashSet<_>>().len()
                || threads.iter().any(|thread| thread.session_id != session_id)
            {
                return Err(ExecutionRecordsError::NotFound.into());
            }
        }
        let selected_ids = threads
            .iter()
            .map(|thread| thread.id.clone())
            .collect::<Vec<_>>();
        let mut jobs = if query.metadata_only {
            Vec::new()
        } else {
            self.inner
                .store
                .list_execution_jobs(ExecutionJobFilter {
                    context_id: Some(context_id.to_owned()),
                    session_id: Some(session_id.to_owned()),
                    thread_ids: selected_ids,
                    root_turn_ids: if query.thread_id.is_some() {
                        Vec::new()
                    } else {
                        query.root_turn_ids
                    },
                    visible_principal_id: Some(principal_id.to_owned()),
                    include_legacy_principal: self.identity().principal_id == principal_id,
                    include_terminal: true,
                    newest_first: true,
                    limit: Some(limit + 1),
                    ..Default::default()
                })
                .await?
        };
        let has_more_jobs = jobs.len() > limit;
        jobs.truncate(limit);
        if query.thread_id.is_none() && query.thread_ids.is_empty() {
            let ids = jobs
                .iter()
                .map(|job| job.thread_id.clone())
                .collect::<HashSet<_>>();
            threads = self
                .inner
                .store
                .list_threads_by_ids(context_id, &ids.into_iter().collect::<Vec<_>>())
                .await?;
            threads.retain(|thread| thread.session_id == session_id);
        }
        let ids = threads
            .iter()
            .map(|thread| thread.id.clone())
            .collect::<Vec<_>>();
        let flags = self
            .inner
            .store
            .thread_activity_flags(context_id, &ids)
            .await?
            .into_iter()
            .map(|flags| (flags.thread_id.clone(), flags))
            .collect::<HashMap<_, _>>();
        let outcomes = self
            .inner
            .store
            .list_thread_outcomes(&ids)
            .await?
            .into_iter()
            .map(|outcome| (outcome.thread_id.clone(), outcome))
            .collect::<HashMap<_, _>>();
        let roots = threads
            .iter()
            .map(|thread| thread.root_turn_id.clone())
            .collect::<Vec<_>>();
        let intents = if query.metadata_only || ids.is_empty() {
            HashMap::new()
        } else {
            self.query_events(QueryFilter {
                context_id: Some(context_id.to_owned()),
                session_id: Some(session_id.to_owned()),
                event_ids: roots,
                top_k: Some(ids.len()),
                ..Default::default()
            })
            .await?
            .into_iter()
            .filter_map(|event| thread_input_intent(&event).map(|intent| (event.id, intent)))
            .collect::<HashMap<_, _>>()
        };
        // Keep the authoritative Goal-primary fallback, bounded by returned
        // Thread IDs rather than a Context objective/history scan.
        let mut objective_intents = HashMap::new();
        if !query.metadata_only {
            for thread in &threads {
                if thread.supervision.supervisor_kind
                    == crate::memory::ThreadSupervisorKind::Objective
                    && thread.supervision.origin_evaluation_id.is_none()
                {
                    if let Some(id) = thread.supervision.supervisor_id.as_deref() {
                        if !objective_intents.contains_key(id) {
                            let intent = self
                                .inner
                                .store
                                .get_objective(id)
                                .await?
                                .filter(|objective| objective.context_id == context_id)
                                .map(|objective| {
                                    objective
                                        .stated_objective
                                        .chars()
                                        .take(1000)
                                        .collect::<String>()
                                });
                            objective_intents.insert(id.to_owned(), intent);
                        }
                    }
                }
            }
        }
        let activation_ids = jobs
            .iter()
            .map(|job| job.activation_id.clone())
            .collect::<HashSet<_>>();
        let activations = self
            .inner
            .store
            .list_thread_activations_by_ids(
                context_id,
                &activation_ids.into_iter().collect::<Vec<_>>(),
            )
            .await?;
        let mut snapshots = threads
            .into_iter()
            .map(|thread| {
                let activity = flags
                    .get(&thread.id)
                    .cloned()
                    .unwrap_or_else(ThreadActivityFlags::default);
                let phase = crate::scheduler::snapshot::thread_phase_from_activity(
                    &thread,
                    activity.running,
                    activity.runnable,
                    activity.waiting,
                );
                let thread_activations = activations
                    .iter()
                    .filter(|activation| activation.root_turn_id == thread.root_turn_id)
                    .map(|activation| SchedulerActivationSnapshot {
                        activation: activation.clone(),
                        signals: Vec::new(),
                        jobs: jobs
                            .iter()
                            .filter(|job| job.activation_id == activation.id)
                            .map(|job| SchedulerJobSnapshot {
                                job: job.clone(),
                                approval: None,
                                result: None,
                            })
                            .collect(),
                    })
                    .collect();
                SchedulerThreadSnapshot {
                    source: None,
                    response_annotations: None,
                    intent: intents
                        .get(&thread.root_turn_id)
                        .cloned()
                        .or_else(|| {
                            thread
                                .supervision
                                .supervisor_id
                                .as_ref()
                                .and_then(|id| objective_intents.get(id))
                                .cloned()
                                .flatten()
                        })
                        .or(activity.schedule_intent),
                    outcome: outcomes.get(&thread.id).cloned(),
                    thread,
                    phase,
                    pending_signals: Vec::new(),
                    activations: thread_activations,
                    schedules: Vec::new(),
                }
            })
            .collect::<Vec<_>>();
        if !query.metadata_only {
            self.attach_response_annotations(context_id, &mut snapshots)
                .await?;
        }
        // Job revisions may change during the read. Immutable scope and
        // generation may not: never combine old annotations with a new Thread.
        let current = self
            .inner
            .store
            .list_threads_by_ids(context_id, &ids)
            .await?
            .into_iter()
            .map(|thread| (thread.id.clone(), thread))
            .collect::<HashMap<_, _>>();
        if snapshots.iter().any(|snapshot| {
            current.get(&snapshot.thread.id).is_none_or(|now| {
                now.session_id != snapshot.thread.session_id
                    || now.root_turn_id != snapshot.thread.root_turn_id
                    || now.generation != snapshot.thread.generation
                    || now.supervision != snapshot.thread.supervision
                    || now.initiating_principal_id != snapshot.thread.initiating_principal_id
            })
        }) {
            return Err(ExecutionRecordsError::Conflict.into());
        }
        Ok(ExecutionRecords {
            session_id: session_id.to_owned(),
            context_id: context_id.to_owned(),
            selected_thread_id: query.thread_id,
            source_root_id,
            threads_truncated,
            jobs,
            has_more_jobs,
            limit,
            threads: snapshots
                .into_iter()
                .map(|snapshot| {
                    let thread = snapshot.thread;
                    ExecutionRecordThread {
                        id: thread.id,
                        session_id: thread.session_id,
                        context_id: thread.context_id,
                        root_turn_id: thread.root_turn_id,
                        parent_thread_id: thread.supervision.parent_thread_id,
                        generation: thread.generation,
                        revision: thread.revision,
                        lifecycle: thread.lifecycle,
                        control_state: thread.control_state,
                        phase: snapshot.phase,
                        created_at: thread.created_at,
                        updated_at: thread.updated_at,
                        intent: snapshot.intent,
                        response_annotations: snapshot.response_annotations,
                    }
                })
                .collect(),
        })
    }
}
