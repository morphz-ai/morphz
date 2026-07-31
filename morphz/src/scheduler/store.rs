use super::domain::{
    SchedulerDependencyFilter, SchedulerDependencyKind, SchedulerDependencyOwnerKind,
    SchedulerDependencyRecord,
};
use serde_json::Value as JsonValue;

#[derive(Debug, Clone, PartialEq)]
pub struct NewSchedulerDependency {
    pub id: String,
    pub owner_kind: SchedulerDependencyOwnerKind,
    pub owner_id: String,
    pub owner_generation: u64,
    pub dependency_kind: SchedulerDependencyKind,
    pub dependency_id: String,
    pub dependency_generation: u64,
    pub required: bool,
    pub metadata: JsonValue,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SchedulerDependencyMutation {
    Updated(SchedulerDependencyRecord),
    Existing(SchedulerDependencyRecord),
    Conflict {
        current: SchedulerDependencyRecord,
        reason: String,
    },
    NotFound,
}

/// Persistence boundary for scheduler readiness facts.
///
/// These methods are useful for queries and control operations. Business
/// hand-offs which create Threads/Groups and dependencies together must use a
/// Kernel transaction instead of calling `register` after the fact.
#[async_trait::async_trait]
pub trait SchedulerDependencyStore: Send + Sync {
    async fn register_scheduler_dependency(
        &self,
        dependency: NewSchedulerDependency,
    ) -> Result<SchedulerDependencyMutation, Box<dyn std::error::Error + Send + Sync>>;

    async fn get_scheduler_dependency(
        &self,
        id: &str,
    ) -> Result<Option<SchedulerDependencyRecord>, Box<dyn std::error::Error + Send + Sync>>;

    async fn list_scheduler_dependencies(
        &self,
        filter: SchedulerDependencyFilter,
    ) -> Result<Vec<SchedulerDependencyRecord>, Box<dyn std::error::Error + Send + Sync>>;

    /// Generation-fenced satisfaction. The immutable Event must already be
    /// part of the same Kernel transaction in business hot paths; this narrow
    /// method exists for external/manual facts and conformance testing.
    async fn satisfy_scheduler_dependency(
        &self,
        id: &str,
        owner_generation: u64,
        dependency_generation: u64,
        satisfied_by_event_id: &str,
    ) -> Result<SchedulerDependencyMutation, Box<dyn std::error::Error + Send + Sync>>;

    /// Cancels nonterminal edges owned by an obsolete generation. This is a
    /// lifecycle operation, not semantic satisfaction.
    async fn cancel_scheduler_dependencies(
        &self,
        owner_kind: SchedulerDependencyOwnerKind,
        owner_id: &str,
        owner_generation: u64,
    ) -> Result<u64, Box<dyn std::error::Error + Send + Sync>>;
}
