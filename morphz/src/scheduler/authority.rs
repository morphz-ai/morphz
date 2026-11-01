//! Scalar authority witnesses for complete, paged integrity checks. These
//! contain no Goal text, results, tool arguments, contracts or Event payloads.
use crate::memory::*;
use std::collections::{HashMap, HashSet};
#[derive(Debug, Clone)]
pub struct ObjectiveAuthority {
    pub id: String,
    pub context_id: String,
    pub coordinator_session_id: String,
    pub generation: u64,
    pub status: ObjectiveStatus,
    pub has_legacy_wait: bool,
}
impl From<&ObjectiveRecord> for ObjectiveAuthority {
    fn from(v: &ObjectiveRecord) -> Self {
        Self {
            id: v.id.clone(),
            context_id: v.context_id.clone(),
            coordinator_session_id: v.coordinator_session_id.clone(),
            generation: v.generation,
            status: v.status,
            has_legacy_wait: v.wait_condition.is_some(),
        }
    }
}
#[derive(Debug, Clone)]
pub struct SupervisionAuthority {
    pub supervisor_kind: ThreadSupervisorKind,
    pub supervisor_id: Option<String>,
    pub generation: u64,
    pub origin_evaluation_id: Option<String>,
}
#[derive(Debug, Clone)]
pub struct ThreadAuthority {
    pub id: String,
    pub context_id: String,
    pub session_id: String,
    pub revision: u64,
    pub control_state: ThreadControlState,
    pub kind: ThreadKind,
    pub lifecycle: ThreadLifecycle,
    pub generation: u64,
    pub root_turn_id: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub supervision: SupervisionAuthority,
}
impl From<&ThreadRecord> for ThreadAuthority {
    fn from(v: &ThreadRecord) -> Self {
        Self {
            id: v.id.clone(),
            context_id: v.context_id.clone(),
            session_id: v.session_id.clone(),
            revision: v.revision,
            control_state: v.control_state,
            kind: v.kind,
            lifecycle: v.lifecycle,
            generation: v.generation,
            root_turn_id: v.root_turn_id.clone(),
            created_at: v.created_at,
            supervision: SupervisionAuthority {
                supervisor_kind: v.supervision.supervisor_kind,
                supervisor_id: v.supervision.supervisor_id.clone(),
                generation: v.supervision.generation,
                origin_evaluation_id: v.supervision.origin_evaluation_id.clone(),
            },
        }
    }
}
#[derive(Debug, Clone)]
pub struct GroupAuthority {
    pub id: String,
    pub context_id: String,
    pub session_id: String,
    pub supervisor_kind: ThreadSupervisorKind,
    pub supervisor_id: String,
    pub generation: u64,
    pub status: ThreadGroupStatus,
    pub required_count: u64,
    pub terminal_count: u64,
    pub successful_count: u64,
    pub barrier_event_id: Option<String>,
    pub member_counts: Option<super::domain::GroupMemberCounts>,
}
impl From<&ThreadGroupRecord> for GroupAuthority {
    fn from(v: &ThreadGroupRecord) -> Self {
        Self {
            id: v.id.clone(),
            context_id: v.context_id.clone(),
            session_id: v.session_id.clone(),
            supervisor_kind: v.supervisor_kind,
            supervisor_id: v.supervisor_id.clone(),
            generation: v.generation,
            status: v.status,
            required_count: v.required_count,
            terminal_count: v.terminal_count,
            successful_count: v.successful_count,
            barrier_event_id: v.barrier_event_id.clone(),
            member_counts: None,
        }
    }
}
#[derive(Debug, Clone, Default)]
pub struct AuthorityFacts {
    pub objectives: Vec<ObjectiveAuthority>,
    pub threads: Vec<ThreadAuthority>,
    pub groups: Vec<GroupAuthority>,
    pub outcome_threads: HashSet<String>,
    pub pending_objective_owners: HashSet<(String, u64)>,
    /// Complete indexed owner-wide choice, independent of this Thread page.
    pub preserved_primary: HashMap<(String, u64), String>,
}
