//! Backend-neutral protocol for Morphz's authoritative structured Context.
//!
//! The Context domain emits these mutations while it applies an agent
//! transaction. SQLite, PostgreSQL and future ContextDB backends consume the
//! same plan; a backend must never infer a second semantic diff from two full
//! Mind snapshots.

use crate::context_state::{
    ContextFrame, ContextMutationClocks, ContextRelation, FrameRetirement, MindCheckpoint,
    MindState,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Computes the one backend-independent commitment for an authoritative
/// Context state.
///
/// Runtime code, storage adapters, migrations, integration tests and
/// benchmarks must use this protocol function. Reimplementing the fence as a
/// JSON digest would create a second state identity which ContextDB correctly
/// rejects.
pub fn context_state_hash(state: &MindState) -> Result<String, String> {
    context_state_commitment(state).map(|commitment| commitment.state_hash)
}

/// Opaque proof derived from one complete authoritative Context state.
///
/// The Runtime already has to compute the native state hash before it emits a
/// fenced mutation.  ContextDB also needs the seven canonical collection-root
/// hashes to compare the bounded patch with an independently materialized
/// full-state root. Keeping both in this non-serializable value lets the Store
/// reuse that work without weakening the independent integrity check or
/// putting backend-specific hashes into the mutation protocol.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextStateCommitment {
    revision: u64,
    state_hash: String,
    pub(crate) roots: Vec<(i64, String, String)>,
}

impl ContextStateCommitment {
    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn state_hash(&self) -> &str {
        &self.state_hash
    }

    pub(crate) fn roots(&self) -> &[(i64, String, String)] {
        &self.roots
    }
}

/// Computes the backend-independent state fence and its reusable physical
/// collection-root proof in one canonical S-expression traversal.
pub fn context_state_commitment(state: &MindState) -> Result<ContextStateCommitment, String> {
    let (state_hash, roots) = crate::context_ast::native_mind_state_commitment_parts(state)?;
    Ok(ContextStateCommitment {
        revision: state.version,
        state_hash,
        roots,
    })
}

/// Typed authoritative Context state returned to the Runtime.
///
/// This is the native read model. Unlike the legacy `MindProjectionRecord`,
/// it does not serialize the state through an opaque JSON value between the
/// Store and Context engine.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextStateRecord {
    pub context_id: String,
    pub revision: u64,
    pub state: MindState,
    pub state_hash: String,
    pub head_event_id: Option<String>,
    pub updated_at: DateTime<Utc>,
}

/// Small authoritative Context head returned after a native mutation commit.
///
/// A normal commit does not materialize the complete Mind merely to return a
/// compatibility projection to its caller.  The Runtime already owns the
/// exact `MindState` which produced the mutation plan; the Store returns only
/// the durable fence that proves which state won.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextStateHead {
    pub context_id: String,
    pub revision: u64,
    pub state_hash: String,
    pub head_event_id: Option<String>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ContextStateCommit {
    Committed { head: ContextStateHead },
    Conflict { current_revision: Option<u64> },
}

/// Stable logical identity for a relation value.
///
/// This encoding is deliberately owned by the Store protocol rather than by
/// an individual Runtime or database backend.  A previous preview used the
/// JSON serialization in the SQLite adapter while MVCC used this tuple
/// encoding, which would make an incremental remove address a different Node
/// from the corresponding insert.
pub fn relation_logical_id(subject: &str, relation: &str, object: &str) -> String {
    format!("{subject}\u{1f}{relation}\u{1f}{object}")
}

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

/// One native value stored in the persistent cognitive Context AST.
///
/// The variant is the schema tag. Its payload remains a typed domain value
/// until the shared Context AST codec renders the canonical S-expression.
/// This prevents a backend from interpreting an untyped JSON object or
/// inventing a backend-specific record encoding.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum ContextNodeValue {
    Frame(ContextFrame),
    Relation(ContextRelation),
    Retired(String),
    Retiring(FrameRetirement),
    Protected(String),
    Checkpoint(MindCheckpoint),
    MutationClocks(ContextMutationClocks),
}

impl ContextNodeValue {
    pub fn collection(&self) -> ContextCollection {
        match self {
            Self::Frame(_) => ContextCollection::Frame,
            Self::Relation(_) => ContextCollection::Relation,
            Self::Retired(_) => ContextCollection::Retired,
            Self::Retiring(_) => ContextCollection::Retiring,
            Self::Protected(_) => ContextCollection::Protected,
            Self::Checkpoint(_) => ContextCollection::Checkpoint,
            Self::MutationClocks(_) => ContextCollection::MutationClocks,
        }
    }

    pub fn logical_id(&self) -> String {
        match self {
            Self::Frame(frame) => frame.id.clone(),
            Self::Relation(relation) => {
                relation_logical_id(&relation.subject, &relation.relation, &relation.object)
            }
            Self::Retired(id) | Self::Protected(id) => id.clone(),
            Self::Retiring(retirement) => retirement.frame_id.clone(),
            Self::Checkpoint(checkpoint) => checkpoint.id.clone(),
            Self::MutationClocks(_) => "mutation-clocks".to_string(),
        }
    }
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
/// `value` remains a native domain value. The shared Context AST codec renders
/// it directly to the physical canonical S-expression once; individual
/// backends do not serialize or reinterpret domain objects independently.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ContextStateMutation {
    Upsert {
        value: ContextNodeValue,
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
    ReplaceMind { state: MindState },
}

impl ContextStateMutation {
    pub fn collection(&self) -> Option<ContextCollection> {
        match self {
            Self::Upsert { value, .. } => Some(value.collection()),
            Self::Remove { collection, .. } | Self::SetOrder { collection, .. } => {
                Some(*collection)
            }
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
        let expected_next = self
            .expected_revision
            .checked_add(1)
            .ok_or_else(|| "Context mutation plan revision overflow".to_string())?;
        if self.next_revision != expected_next {
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
        let mut written = std::collections::HashSet::new();
        let mut ordered = std::collections::HashSet::new();
        for mutation in &self.mutations {
            match mutation {
                ContextStateMutation::Upsert { value, .. }
                    if value.logical_id().trim().is_empty() =>
                {
                    return Err("Context mutation contains an empty logical identity".to_string());
                }
                ContextStateMutation::Remove { logical_id, .. } if logical_id.trim().is_empty() => {
                    return Err("Context mutation contains an empty logical identity".to_string());
                }
                ContextStateMutation::Upsert { value, order } => {
                    let collection = value.collection();
                    let logical_id = value.logical_id();
                    if !written.insert((collection, logical_id.clone())) {
                        return Err(format!(
                            "Context mutation writes '{}:{}' more than once",
                            collection.as_str(),
                            logical_id
                        ));
                    }
                    let requires_order = matches!(
                        collection,
                        ContextCollection::Frame
                            | ContextCollection::Relation
                            | ContextCollection::Checkpoint
                    );
                    if requires_order != order.is_some() {
                        return Err(format!(
                            "Context mutation order shape is invalid for '{}:{}'",
                            collection.as_str(),
                            logical_id
                        ));
                    }
                    if collection == ContextCollection::MutationClocks
                        && logical_id != "mutation-clocks"
                    {
                        return Err(
                            "mutation_clocks must use logical identity 'mutation-clocks'"
                                .to_string(),
                        );
                    }
                }
                ContextStateMutation::Remove {
                    collection,
                    logical_id,
                } => {
                    if *collection == ContextCollection::MutationClocks {
                        return Err("mutation_clocks cannot be removed".to_string());
                    }
                    if !written.insert((*collection, logical_id.clone())) {
                        return Err(format!(
                            "Context mutation writes '{}:{}' more than once",
                            collection.as_str(),
                            logical_id
                        ));
                    }
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
                    if !ordered.insert(*collection) {
                        return Err(format!(
                            "collection '{}' is ordered more than once",
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
            value: ContextNodeValue::Frame(ContextFrame {
                id: "frame-a".to_string(),
                body: "(fact a)".to_string(),
                sources: Vec::new(),
                provenance: Default::default(),
                revision: 1,
                created_version: 1,
                updated_version: 1,
            }),
            order: Some(0),
        }])
        .validate_shape()
        .unwrap();
    }

    #[test]
    fn broad_barrier_cannot_hide_local_mutations() {
        let error = plan(vec![
            ContextStateMutation::ReplaceMind {
                state: MindState::default(),
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

    #[test]
    fn relation_identity_is_structural_and_unambiguous() {
        assert_eq!(
            relation_logical_id("subject", "supersedes", "object"),
            "subject\u{1f}supersedes\u{1f}object"
        );
        assert_ne!(
            relation_logical_id("a", "bc", "d"),
            relation_logical_id("ab", "c", "d")
        );
    }
}
