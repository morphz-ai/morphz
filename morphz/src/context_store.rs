//! Backend-neutral protocol for Morphz's authoritative structured Context.
//!
//! The Context domain emits these mutations while it applies an agent
//! transaction. SQLite, PostgreSQL and future ContextDB backends consume the
//! same plan; a backend must never infer a second semantic diff from two full
//! Mind snapshots.

use serde::{Deserialize, Serialize};

/// Stable logical collections inside the persisted Mind AST.
///
/// Physical table names, Node encodings and indexes are backend details. The
/// collection names are part of the versioned ContextStore protocol.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ContextCollection {
    Frame,
    Relation,
    Retired,
    Retiring,
    Protected,
    Checkpoint,
    MutationClocks,
}

impl ContextCollection {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Frame => "frame",
            Self::Relation => "relation",
            Self::Retired => "retired",
            Self::Retiring => "retiring",
            Self::Protected => "protected",
            Self::Checkpoint => "checkpoint",
            Self::MutationClocks => "mutation_clocks",
        }
    }
}

/// One net semantic change to the authoritative Context AST.
///
/// `body` is the canonical JSON representation of the domain record. The
/// shared Context codec converts it to the physical Node representation once;
/// individual backends do not serialize domain objects independently.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ContextStateMutation {
    Upsert {
        collection: ContextCollection,
        logical_id: String,
        body: serde_json::Value,
        /// Position in collections whose order is semantically observable.
        /// `None` is used for map/set-like collections.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        order: Option<u64>,
    },
    Remove {
        collection: ContextCollection,
        logical_id: String,
    },
    /// Reorders an existing vector-like collection without rewriting bodies.
    SetOrder {
        collection: ContextCollection,
        logical_ids: Vec<String>,
    },
    /// A deliberately broad semantic barrier, currently used by rollback and
    /// initial import/seed. Ordinary transactions must use local mutations.
    ReplaceMind { state: serde_json::Value },
}

impl ContextStateMutation {
    pub fn collection(&self) -> Option<ContextCollection> {
        match self {
            Self::Upsert { collection, .. }
            | Self::Remove { collection, .. }
            | Self::SetOrder { collection, .. } => Some(*collection),
            Self::ReplaceMind { .. } => None,
        }
    }
}

/// Deterministic state transition emitted by the Context domain.
///
/// Hashes fence both ends of the transition. The Store additionally performs
/// a revision CAS, then atomically persists the plan together with the Agent
/// Trajectory fact and directly coupled Runtime projections.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextMutationPlan {
    pub context_id: String,
    pub expected_revision: u64,
    pub next_revision: u64,
    pub expected_state_hash: String,
    pub next_state_hash: String,
    pub mutations: Vec<ContextStateMutation>,
}

impl ContextMutationPlan {
    pub fn validate_shape(&self) -> Result<(), String> {
        if self.context_id.trim().is_empty() {
            return Err("Context mutation plan has an empty context_id".to_string());
        }
        if self.next_revision != self.expected_revision.saturating_add(1) {
            return Err(format!(
                "Context mutation plan revision must advance exactly once: expected {}, next {}",
                self.expected_revision, self.next_revision
            ));
        }
        if self.expected_state_hash.is_empty() || self.next_state_hash.is_empty() {
            return Err("Context mutation plan must fence both state hashes".to_string());
        }
        // A transaction may mutate only Session attention. The Context head
        // still advances and both hash fences still apply even when there is
        // no component mutation.
        let broad = self
            .mutations
            .iter()
            .filter(|mutation| matches!(mutation, ContextStateMutation::ReplaceMind { .. }))
            .count();
        if broad > 1 || (broad == 1 && self.mutations.len() != 1) {
            return Err(
                "ReplaceMind is an exclusive broad barrier and cannot be mixed with local mutations"
                    .to_string(),
            );
        }
        for mutation in &self.mutations {
            match mutation {
                ContextStateMutation::Upsert { logical_id, .. }
                | ContextStateMutation::Remove { logical_id, .. }
                    if logical_id.trim().is_empty() =>
                {
                    return Err("Context mutation contains an empty logical identity".to_string());
                }
                ContextStateMutation::SetOrder {
                    collection,
                    logical_ids,
                } => {
                    if !matches!(
                        collection,
                        ContextCollection::Frame
                            | ContextCollection::Relation
                            | ContextCollection::Checkpoint
                    ) {
                        return Err(format!(
                            "collection '{}' has no observable vector order",
                            collection.as_str()
                        ));
                    }
                    let unique = logical_ids.iter().collect::<std::collections::HashSet<_>>();
                    if unique.len() != logical_ids.len() {
                        return Err(format!(
                            "collection '{}' order contains duplicate logical identities",
                            collection.as_str()
                        ));
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(mutations: Vec<ContextStateMutation>) -> ContextMutationPlan {
        ContextMutationPlan {
            context_id: "context-a".to_string(),
            expected_revision: 4,
            next_revision: 5,
            expected_state_hash: "before".to_string(),
            next_state_hash: "after".to_string(),
            mutations,
        }
    }

    #[test]
    fn local_plan_shape_is_valid() {
        plan(vec![ContextStateMutation::Upsert {
            collection: ContextCollection::Frame,
            logical_id: "frame-a".to_string(),
            body: serde_json::json!({"id": "frame-a"}),
            order: Some(0),
        }])
        .validate_shape()
        .unwrap();
    }

    #[test]
    fn broad_barrier_cannot_hide_local_mutations() {
        let error = plan(vec![
            ContextStateMutation::ReplaceMind {
                state: serde_json::json!({}),
            },
            ContextStateMutation::Remove {
                collection: ContextCollection::Frame,
                logical_id: "frame-a".to_string(),
            },
        ])
        .validate_shape()
        .unwrap_err();
        assert!(error.contains("exclusive broad barrier"));
    }

    #[test]
    fn set_order_rejects_duplicates_and_unordered_collections() {
        let duplicate = plan(vec![ContextStateMutation::SetOrder {
            collection: ContextCollection::Frame,
            logical_ids: vec!["frame-a".to_string(), "frame-a".to_string()],
        }])
        .validate_shape()
        .unwrap_err();
        assert!(duplicate.contains("duplicate"));

        let unordered = plan(vec![ContextStateMutation::SetOrder {
            collection: ContextCollection::Retired,
            logical_ids: vec!["frame-a".to_string()],
        }])
        .validate_shape()
        .unwrap_err();
        assert!(unordered.contains("no observable vector order"));
    }
}
