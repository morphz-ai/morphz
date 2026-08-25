use crate::error::{CoordinationError, CoordinationResult};
use crate::model::{
    CognitiveEvaluationRequest, ContributionGraph, ContributionRelationKind, ProposalDisposition,
    SemanticSettlementRecord, SettlementDisposition,
};
use async_trait::async_trait;
use serde_json::json;
use std::collections::BTreeSet;

#[async_trait]
pub trait SemanticSettlementEngine: Send + Sync {
    async fn settle(
        &self,
        request: &CognitiveEvaluationRequest,
        graph: &ContributionGraph,
    ) -> CoordinationResult<SemanticSettlementRecord>;
}

/// Conservative policy for the first experiment.
///
/// It never treats majority, textual difference, or model confidence as truth.
/// A single proposal is accepted; exact mutually supporting alternatives are
/// accepted; unresolved alternatives and explicit conflicts remain coexisting.
#[derive(Debug, Default)]
pub struct PreserveAlternativesSettlement;

#[async_trait]
impl SemanticSettlementEngine for PreserveAlternativesSettlement {
    async fn settle(
        &self,
        request: &CognitiveEvaluationRequest,
        graph: &ContributionGraph,
    ) -> CoordinationResult<SemanticSettlementRecord> {
        if graph.request_id != request.request_id {
            return Err(CoordinationError::Settlement(format!(
                "graph belongs to request '{}', not '{}'",
                graph.request_id, request.request_id
            )));
        }
        if request.settlement_policy.id != "preserve-alternatives"
            || request.settlement_policy.version != "0"
        {
            return Err(CoordinationError::Settlement(format!(
                "policy '{}' is unsupported by PreserveAlternativesSettlement",
                request.settlement_policy.id
            )));
        }

        let conflicts = graph
            .edges
            .iter()
            .filter(|edge| edge.relation == ContributionRelationKind::ConflictsWith)
            .flat_map(|edge| [edge.from_proposal_id.clone(), edge.to_proposal_id.clone()])
            .collect::<BTreeSet<_>>();
        let supported = graph
            .edges
            .iter()
            .filter(|edge| edge.relation == ContributionRelationKind::Supports)
            .flat_map(|edge| [edge.from_proposal_id.clone(), edge.to_proposal_id.clone()])
            .collect::<BTreeSet<_>>();

        let only_one = graph.proposals.len() == 1;
        let mut dispositions = graph
            .proposals
            .iter()
            .map(|proposal| {
                let (disposition, rationale) = if only_one {
                    (
                        SettlementDisposition::Accepted,
                        "the only eligible proposal is accepted without claiming universal truth",
                    )
                } else if conflicts.contains(&proposal.proposal_id) {
                    (
                        SettlementDisposition::Coexisting,
                        "an explicit conflict remains unresolved and is preserved",
                    )
                } else if supported.contains(&proposal.proposal_id) {
                    (
                        SettlementDisposition::Accepted,
                        "an exact-statement support relation was deterministically verified",
                    )
                } else {
                    (
                        SettlementDisposition::Coexisting,
                        "the policy preserves an independent alternative without inferring conflict",
                    )
                };
                ProposalDisposition {
                    proposal_id: proposal.proposal_id.clone(),
                    disposition,
                    rationale: rationale.to_string(),
                    evidence_refs: proposal.evidence_refs.clone(),
                }
            })
            .collect::<Vec<_>>();
        dispositions.sort_by(|left, right| left.proposal_id.cmp(&right.proposal_id));

        let dissenting_proposal_ids = dispositions
            .iter()
            .filter(|item| item.disposition == SettlementDisposition::Coexisting)
            .map(|item| item.proposal_id.clone())
            .collect::<Vec<_>>();
        let accepted = dispositions
            .iter()
            .filter(|item| item.disposition == SettlementDisposition::Accepted)
            .map(|item| item.proposal_id.clone())
            .collect::<Vec<_>>();
        let coexisting = dissenting_proposal_ids.clone();
        let summary = json!({
            "accepted": accepted,
            "coexisting": coexisting,
            "policy_statement": "preserve unresolved alternatives and explicit dissent",
        });
        let mut settlement = SemanticSettlementRecord {
            settlement_id: String::new(),
            request_id: request.request_id.clone(),
            contribution_graph_digest: graph.digest.clone(),
            policy: request.settlement_policy.clone(),
            decided_by: vec!["policy:preserve-alternatives/0".to_string()],
            dispositions,
            dissenting_proposal_ids,
            summary,
            digest: String::new(),
        };
        settlement.digest = settlement.expected_digest()?;
        settlement.settlement_id = format!("settlement-{}", digest_suffix(&settlement.digest));
        Ok(settlement)
    }
}

fn digest_suffix(digest: &str) -> &str {
    digest.strip_prefix("sha256:").unwrap_or(digest)
}
