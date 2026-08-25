use crate::authority::AuthorityDomain;
use crate::error::CoordinationResult;
use crate::model::{
    ClaimedContributionRelation, CognitiveEvaluationRequest, CommitCertificate,
    EvaluationAssignment, ParticipantDescriptor, ProjectionSnapshot, UnionCommitIntent,
    UnionCommitReceipt,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProposalDraft {
    pub statement: Value,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
    #[serde(default)]
    pub artifact_refs: Vec<String>,
    #[serde(default)]
    pub claimed_relations: Vec<ClaimedContributionRelation>,
}

#[async_trait]
pub trait CognitiveEvaluationTransport: Send + Sync {
    /// Freeze the exact local cognitive projection against which this
    /// participant will evaluate the request.
    async fn project(
        &self,
        participant: &ParticipantDescriptor,
        request: &CognitiveEvaluationRequest,
    ) -> CoordinationResult<ProjectionSnapshot>;

    /// Run one independent Evaluation. Implementations must not expose sibling
    /// proposals during this phase.
    async fn evaluate(
        &self,
        assignment: &EvaluationAssignment,
    ) -> CoordinationResult<ProposalDraft>;
}

#[async_trait]
pub trait UnionCommitter: Send + Sync {
    async fn commit(
        &self,
        authority: &AuthorityDomain,
        intent: &UnionCommitIntent,
        certificate: &CommitCertificate,
    ) -> CoordinationResult<UnionCommitReceipt>;
}
