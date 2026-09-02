//! Backend-neutral cognitive Context state.
//!
//! These are persisted domain values, not orchestrator implementation
//! details. Keeping them outside `orchestrator::context` lets ContextStore
//! backends return a typed authoritative state without serializing through the
//! legacy opaque Mind Projection JSON contract.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// A cognitive unit created by the LLM itself.
///
/// The runtime does not interpret the business semantics of `body`; it
/// maintains only stable IDs, provenance, versions, and lifecycle.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextFrame {
    pub id: String,
    pub body: String,
    pub sources: Vec<String>,
    /// Runtime-derived identity lineage. This is evidence provenance, not an
    /// ownership or access-control decision made on behalf of the Agent.
    #[serde(default)]
    pub provenance: FrameIdentityProvenance,
    pub revision: u64,
    pub created_version: u64,
    pub updated_version: u64,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FrameProvenanceState {
    /// Legacy data or evidence whose Runtime origin is unavailable.
    #[default]
    Unknown,
    /// The Frame was formed directly, without declared source evidence.
    Unattributed,
    /// At least one declared source has Runtime-verifiable origin metadata.
    Attributed,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct FrameIdentityProvenance {
    pub formed_principal_id: Option<String>,
    pub formed_session_id: Option<String>,
    pub source_principal_ids: Vec<String>,
    pub source_session_ids: Vec<String>,
    pub state: FrameProvenanceState,
}

/// A semantic relation declared by the agent. The runtime interprets only the
/// old/new meaning of `supersedes`; other relation names remain open and
/// receive no implicit business inference.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextRelation {
    pub subject: String,
    pub relation: String,
    pub object: String,
    pub created_version: u64,
}

/// A model-requested retirement that is still inside its cognitive organizing
/// window. Generation and Frame revision fence later automatic finalization.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FrameRetirement {
    pub frame_id: String,
    pub requested_frame_revision: u64,
    pub requested_mind_version: u64,
    pub requested_at_tick: u64,
    pub eligible_at_tick: u64,
    pub generation: u64,
    pub reason: String,
}

/// A Mind restore point explicitly created by the agent. Snapshots exclude
/// other checkpoints to prevent recursive copying; the runtime exposes only
/// metadata in Context.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MindCheckpoint {
    pub id: String,
    pub frames: Vec<ContextFrame>,
    pub relations: Vec<ContextRelation>,
    pub retired: BTreeSet<String>,
    #[serde(default)]
    pub retiring: BTreeMap<String, FrameRetirement>,
    pub protected: BTreeSet<String>,
    pub created_version: u64,
}

/// Per-object mutation boundaries used to rebase stale Context transactions.
///
/// The global Mind version remains the physical commit sequence. These clocks
/// record semantic mutation boundaries which are not already represented by
/// `ContextFrame::{created_version, updated_version}`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextMutationClocks {
    /// Version from which object-local mutations are known to be tracked.
    /// Legacy materialized projections leave this empty; their first exact
    /// commit establishes the boundary.
    #[serde(default)]
    pub tracking_started_version: Option<u64>,
    /// Last change to an ID's active/retiring/retired/protected lifecycle.
    #[serde(default)]
    pub lifecycle_versions: BTreeMap<String, u64>,
    /// Last add/remove of one exact semantic relation edge.
    #[serde(default)]
    pub relation_versions: BTreeMap<String, u64>,
    /// Last mutation of Frame presentation order.
    #[serde(default)]
    pub frame_order_version: u64,
    /// Last create/drop of a checkpoint identity.
    #[serde(default)]
    pub checkpoint_versions: BTreeMap<String, u64>,
    /// Last operation, such as rollback, that replaced broad Mind state.
    #[serde(default)]
    pub global_barrier_version: u64,
}

/// Persistent Mind state owned by the agent.
///
/// `retired` may contain both Frame IDs and Observation IDs from persisted
/// Events. Retirement affects only the current Context viewport and never
/// deletes underlying facts.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct MindState {
    pub version: u64,
    pub frames: Vec<ContextFrame>,
    #[serde(default)]
    pub relations: Vec<ContextRelation>,
    pub retired: BTreeSet<String>,
    #[serde(default)]
    pub retiring: BTreeMap<String, FrameRetirement>,
    pub protected: BTreeSet<String>,
    #[serde(default)]
    pub checkpoints: Vec<MindCheckpoint>,
    #[serde(default)]
    pub mutation_clocks: ContextMutationClocks,
}
