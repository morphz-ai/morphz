//! Experimental coordinated cognitive evaluation for Morphz.
//!
//! This crate intentionally lives outside the Runtime. Its domain objects and
//! orchestration rules are not stable Morphz kernel contracts.

mod authority;
mod coordinator;
mod digest;
mod error;
mod graph;
mod model;
mod routing;
mod settlement;
mod transport;

pub use authority::{
    issue_commit_certificate, verify_commit_certificate, AuthorityDomain, AuthorityKind,
    AuthorityMember, Ed25519MemberSigner, QuorumPolicy,
};
pub use coordinator::CognitiveEvaluationCoordinator;
pub use digest::stable_digest;
pub use error::{CoordinationError, CoordinationResult};
pub use graph::{ContributionGraphBuilder, DeclaredRelationGraphBuilder};
pub use model::*;
pub use routing::{CapabilityRouter, ParticipantRouter};
pub use settlement::{PreserveAlternativesSettlement, SemanticSettlementEngine};
pub use transport::{CognitiveEvaluationTransport, ProposalDraft, UnionCommitter};

pub const EXPERIMENT_SPEC_VERSION: &str = "morphz-cognitive-coordination/0.0.1";
