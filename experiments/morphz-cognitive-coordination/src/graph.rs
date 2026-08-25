use crate::digest::stable_digest;
use crate::error::{CoordinationError, CoordinationResult};
use crate::model::{
    CognitiveProposal, ContributionEdge, ContributionGraph, ContributionRelationKind,
};
use std::collections::{BTreeMap, BTreeSet};

pub trait ContributionGraphBuilder: Send + Sync {
    fn build(
        &self,
        request_id: &str,
        proposals: Vec<CognitiveProposal>,
    ) -> CoordinationResult<ContributionGraph>;
}

/// Builds only relations explicitly claimed by a contributor, plus exact
/// canonical-statement support edges. Mere difference is never interpreted as
/// conflict.
#[derive(Debug, Default)]
pub struct DeclaredRelationGraphBuilder;

impl ContributionGraphBuilder for DeclaredRelationGraphBuilder {
    fn build(
        &self,
        request_id: &str,
        mut proposals: Vec<CognitiveProposal>,
    ) -> CoordinationResult<ContributionGraph> {
        if proposals.is_empty() {
            return Err(CoordinationError::Graph(
                "at least one proposal is required".to_string(),
            ));
        }
        proposals.sort_by(|left, right| left.proposal_id.cmp(&right.proposal_id));
        let mut proposal_ids = BTreeSet::new();
        let mut by_authority = BTreeMap::new();
        for proposal in &proposals {
            proposal.validate_integrity()?;
            if proposal.request_id != request_id {
                return Err(CoordinationError::Graph(format!(
                    "proposal '{}' belongs to request '{}', not '{}'",
                    proposal.proposal_id, proposal.request_id, request_id
                )));
            }
            if !proposal_ids.insert(proposal.proposal_id.clone()) {
                return Err(CoordinationError::Graph(format!(
                    "duplicate proposal id '{}'",
                    proposal.proposal_id
                )));
            }
            if by_authority
                .insert(
                    proposal.contributor_authority_id.clone(),
                    proposal.proposal_id.clone(),
                )
                .is_some()
            {
                return Err(CoordinationError::Graph(format!(
                    "authority '{}' submitted more than one proposal",
                    proposal.contributor_authority_id
                )));
            }
        }

        let mut edges = Vec::new();
        let mut edge_keys = BTreeSet::new();
        for proposal in &proposals {
            for claim in &proposal.claimed_relations {
                let target = by_authority
                    .get(&claim.target_authority_id)
                    .ok_or_else(|| {
                        CoordinationError::Graph(format!(
                            "proposal '{}' refers to unknown target authority '{}'",
                            proposal.proposal_id, claim.target_authority_id
                        ))
                    })?;
                if target == &proposal.proposal_id {
                    return Err(CoordinationError::Graph(format!(
                        "proposal '{}' cannot relate to itself",
                        proposal.proposal_id
                    )));
                }
                let key = (
                    proposal.proposal_id.clone(),
                    target.clone(),
                    claim.relation,
                    proposal.contributor_authority_id.clone(),
                );
                if edge_keys.insert(key.clone()) {
                    let edge_id = format!("edge-{}", digest_suffix(&stable_digest(&key)?));
                    edges.push(ContributionEdge {
                        edge_id,
                        from_proposal_id: key.0,
                        to_proposal_id: key.1,
                        relation: key.2,
                        asserted_by_authority_id: key.3,
                        evidence_refs: claim.evidence_refs.clone(),
                    });
                }
            }
        }

        let statement_digests = proposals
            .iter()
            .map(|proposal| {
                stable_digest(&proposal.statement).map(|digest| (&proposal.proposal_id, digest))
            })
            .collect::<CoordinationResult<Vec<_>>>()?;
        for (left_index, (left_id, left_digest)) in statement_digests.iter().enumerate() {
            for (right_id, right_digest) in statement_digests.iter().skip(left_index + 1) {
                if left_digest != right_digest {
                    continue;
                }
                for (from, to) in [(left_id, right_id), (right_id, left_id)] {
                    let asserted_by = "runtime:exact-statement-equivalence".to_string();
                    let key = (
                        (*from).clone(),
                        (*to).clone(),
                        ContributionRelationKind::Supports,
                        asserted_by.clone(),
                    );
                    if edge_keys.insert(key.clone()) {
                        edges.push(ContributionEdge {
                            edge_id: format!("edge-{}", digest_suffix(&stable_digest(&key)?)),
                            from_proposal_id: key.0,
                            to_proposal_id: key.1,
                            relation: key.2,
                            asserted_by_authority_id: asserted_by,
                            evidence_refs: Vec::new(),
                        });
                    }
                }
            }
        }
        edges.sort_by(|left, right| left.edge_id.cmp(&right.edge_id));

        let digest = stable_digest(&(request_id, &proposals, &edges))?;
        Ok(ContributionGraph {
            request_id: request_id.to_string(),
            proposals,
            edges,
            digest,
        })
    }
}

fn digest_suffix(digest: &str) -> &str {
    digest.strip_prefix("sha256:").unwrap_or(digest)
}

#[cfg(test)]
mod tests {
    use super::{ContributionGraphBuilder, DeclaredRelationGraphBuilder};
    use crate::model::{ClaimedContributionRelation, CognitiveProposal, ContributionRelationKind};
    use serde_json::json;

    fn proposal(authority: &str, statement: &str) -> CognitiveProposal {
        let mut proposal = CognitiveProposal {
            proposal_id: format!("proposal-{authority}"),
            request_id: "request".to_string(),
            assignment_id: format!("assignment-{authority}"),
            contributor_authority_id: authority.to_string(),
            agent_id: format!("agent-{authority}"),
            source_context_id: format!("context-{authority}"),
            input_context_version: 1,
            input_projection_digest: "projection".to_string(),
            statement: json!(statement),
            evidence_refs: Vec::new(),
            artifact_refs: Vec::new(),
            claimed_relations: Vec::new(),
            digest: String::new(),
        };
        proposal.digest = proposal.expected_digest().unwrap();
        proposal.proposal_id = format!(
            "proposal-{}",
            proposal.digest.strip_prefix("sha256:").unwrap()
        );
        proposal
    }

    #[test]
    fn graph_preserves_declared_conflict_without_inventing_others() {
        let left = proposal("left", "x");
        let mut right = proposal("right", "y");
        right.claimed_relations.push(ClaimedContributionRelation {
            target_authority_id: "left".to_string(),
            relation: ContributionRelationKind::ConflictsWith,
            evidence_refs: vec!["evidence-1".to_string()],
        });
        right.digest = right.expected_digest().unwrap();
        right.proposal_id = format!("proposal-{}", right.digest.strip_prefix("sha256:").unwrap());
        let graph = DeclaredRelationGraphBuilder
            .build("request", vec![right, left])
            .unwrap();
        assert_eq!(graph.edges.len(), 1);
        assert_eq!(
            graph.edges[0].relation,
            ContributionRelationKind::ConflictsWith
        );
        assert_eq!(graph.edges[0].evidence_refs, vec!["evidence-1"]);
    }

    #[test]
    fn graph_rejects_a_proposal_modified_after_digesting() {
        let mut proposal = proposal("left", "x");
        proposal.statement = json!("tampered");
        let error = DeclaredRelationGraphBuilder
            .build("request", vec![proposal])
            .unwrap_err();
        assert!(error.to_string().contains("inconsistent content identity"));
    }
}
