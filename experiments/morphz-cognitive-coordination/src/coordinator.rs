use crate::authority::{
    issue_commit_certificate, verify_commit_certificate, AuthorityDomain, AuthorityKind,
    Ed25519MemberSigner,
};
use crate::digest::stable_digest;
use crate::error::{CoordinationError, CoordinationResult};
use crate::graph::ContributionGraphBuilder;
use crate::model::{
    CognitiveEvaluationPlan, CognitiveEvaluationRequest, CognitiveProposal, CoordinationOutcome,
    EvaluationAssignment, ParticipantDescriptor, SemanticSettlementRecord, UnionCommitIntent,
};
use crate::routing::ParticipantRouter;
use crate::settlement::SemanticSettlementEngine;
use crate::transport::{CognitiveEvaluationTransport, ProposalDraft, UnionCommitter};
use crate::EXPERIMENT_SPEC_VERSION;
use serde_json::json;
use std::collections::BTreeSet;
use std::sync::Arc;
use tokio::task::JoinSet;

pub struct CognitiveEvaluationCoordinator {
    router: Arc<dyn ParticipantRouter>,
    transport: Arc<dyn CognitiveEvaluationTransport>,
    graph_builder: Arc<dyn ContributionGraphBuilder>,
    settlement: Arc<dyn SemanticSettlementEngine>,
    committer: Arc<dyn UnionCommitter>,
}

impl CognitiveEvaluationCoordinator {
    pub fn new(
        router: Arc<dyn ParticipantRouter>,
        transport: Arc<dyn CognitiveEvaluationTransport>,
        graph_builder: Arc<dyn ContributionGraphBuilder>,
        settlement: Arc<dyn SemanticSettlementEngine>,
        committer: Arc<dyn UnionCommitter>,
    ) -> Self {
        Self {
            router,
            transport,
            graph_builder,
            settlement,
            committer,
        }
    }

    pub async fn execute(
        &self,
        request: CognitiveEvaluationRequest,
        participants: Vec<ParticipantDescriptor>,
        union_authority: &AuthorityDomain,
        certificate_signers: &[Ed25519MemberSigner],
    ) -> CoordinationResult<CoordinationOutcome> {
        let evaluated = self.evaluate(request, participants).await?;
        let request = evaluated.request;
        let contribution_graph = evaluated.contribution_graph;
        let settlement = evaluated.settlement;
        let target = request.commit_target.as_ref().ok_or_else(|| {
            CoordinationError::InvalidRequest(
                "an explicit Union commit target is required for execute; use evaluate for a non-committing result"
                    .to_string(),
            )
        })?;
        if target.authority_id != union_authority.authority_id {
            return Err(CoordinationError::InvalidRequest(
                "request and Union authority do not match".to_string(),
            ));
        }
        if union_authority.kind != AuthorityKind::Union {
            return Err(CoordinationError::InvalidRequest(
                "the commit authority must be a Union authority".to_string(),
            ));
        }
        let commit_intent =
            build_commit_intent(&request, union_authority, &contribution_graph, &settlement)?;
        let certificate =
            issue_commit_certificate(&commit_intent, union_authority, certificate_signers)?;
        verify_commit_certificate(&commit_intent, union_authority, &certificate)?;
        let commit_receipt = self
            .committer
            .commit(union_authority, &commit_intent, &certificate)
            .await?;

        Ok(CoordinationOutcome {
            request,
            plan: evaluated.plan,
            contribution_graph,
            settlement,
            commit_intent,
            certificate,
            commit_receipt,
        })
    }

    pub async fn evaluate(
        &self,
        request: CognitiveEvaluationRequest,
        participants: Vec<ParticipantDescriptor>,
    ) -> CoordinationResult<crate::model::CognitiveEvaluationResult> {
        request.validate()?;
        if request.spec_version != EXPERIMENT_SPEC_VERSION {
            return Err(CoordinationError::InvalidRequest(format!(
                "unsupported experiment spec version '{}'",
                request.spec_version
            )));
        }
        ensure_independent_participants(&request, &participants)?;

        let selection = self.router.select(&request, &participants)?;
        let request_digest = request.digest()?;
        let (assignments, mut failures) = self
            .prepare_assignments(&request, selection.selected)
            .await?;
        if assignments.len() < request.routing.min_participants {
            return Err(CoordinationError::Transport(format!(
                "only {} participant projections succeeded, below required minimum {}; failures: {}",
                assignments.len(),
                request.routing.min_participants,
                failures
                    .iter()
                    .map(|failure| format!("{}: {}", failure.authority_id, failure.error))
                    .collect::<Vec<_>>()
                    .join("; ")
            )));
        }
        let total_token_budget = request
            .routing
            .token_budget_per_participant
            .checked_mul(assignments.len() as u64)
            .ok_or_else(|| {
                CoordinationError::Routing("assignment token budget overflowed".into())
            })?;
        let plan_digest = stable_digest(&(
            request.request_id.as_str(),
            request_digest.as_str(),
            &assignments,
            &selection.rejected,
            total_token_budget,
            selection.algorithm.as_str(),
        ))?;
        let plan = CognitiveEvaluationPlan {
            plan_id: format!("plan-{}", digest_suffix(&plan_digest)),
            request_id: request.request_id.clone(),
            request_digest,
            assignments,
            rejected: selection.rejected,
            total_token_budget,
            routing_algorithm: selection.algorithm,
        };

        let (proposals, evaluation_failures) = self.evaluate_assignments(&plan).await?;
        failures.extend(evaluation_failures);
        failures.sort_by(|left, right| left.authority_id.cmp(&right.authority_id));
        if proposals.len() < request.routing.min_participants {
            return Err(CoordinationError::Transport(format!(
                "only {} participant Evaluations succeeded, below required minimum {}; failures: {}",
                proposals.len(),
                request.routing.min_participants,
                failures
                    .iter()
                    .map(|failure| format!("{}: {}", failure.authority_id, failure.error))
                    .collect::<Vec<_>>()
                    .join("; ")
            )));
        }
        let contribution_graph = self.graph_builder.build(&request.request_id, proposals)?;
        contribution_graph.validate_integrity()?;
        let settlement = self
            .settlement
            .settle(&request, &contribution_graph)
            .await?;
        validate_settlement(&contribution_graph, &settlement)?;
        Ok(crate::model::CognitiveEvaluationResult {
            request,
            plan,
            contribution_graph,
            settlement,
            failures,
        })
    }

    async fn prepare_assignments(
        &self,
        request: &CognitiveEvaluationRequest,
        participants: Vec<ParticipantDescriptor>,
    ) -> CoordinationResult<(
        Vec<EvaluationAssignment>,
        Vec<crate::model::ParticipantEvaluationFailure>,
    )> {
        let mut tasks = JoinSet::new();
        for participant in participants {
            let transport = Arc::clone(&self.transport);
            let request = request.clone();
            tasks.spawn(async move {
                let authority_id = participant.authority_id.clone();
                let evaluated = async {
                    let projection = transport.project(&participant, &request).await?;
                    if projection.context_id != participant.context_id
                        || projection.session_id.trim().is_empty()
                    {
                        return Err(CoordinationError::Transport(format!(
                            "projection route for authority '{}' does not match the participant",
                            participant.authority_id
                        )));
                    }
                    let mut participant = participant;
                    participant.session_id = projection.session_id.clone();
                    participant.validate_assignment_route()?;
                    let identity = (
                        request.request_id.as_str(),
                        participant.authority_id.as_str(),
                        participant.agent_id.as_str(),
                        &projection,
                    );
                    let digest = stable_digest(&identity)?;
                    let model = participant
                        .resolve_model(request.routing.model_for(&participant.authority_id))?;
                    Ok(EvaluationAssignment {
                        assignment_id: format!("assignment-{}", digest_suffix(&digest)),
                        request_id: request.request_id,
                        objective_id: request.objective_id,
                        participant,
                        peer_authority_ids: Vec::new(),
                        question: request.question,
                        shared_input: request.shared_input,
                        projection,
                        token_budget: request.routing.token_budget_per_participant,
                        model,
                    })
                }
                .await;
                (authority_id, evaluated)
            });
        }
        let mut assignments = Vec::new();
        let mut failures = Vec::new();
        while let Some(result) = tasks.join_next().await {
            let (authority_id, evaluated) = result.map_err(|error| {
                CoordinationError::Transport(format!("projection task failed: {error}"))
            })?;
            match evaluated {
                Ok(assignment) => assignments.push(assignment),
                Err(error) => failures.push(crate::model::ParticipantEvaluationFailure {
                    assignment_id: None,
                    authority_id,
                    stage: crate::model::ParticipantEvaluationStage::Projection,
                    error: error.to_string(),
                }),
            }
        }
        assignments.sort_by(|left, right| left.assignment_id.cmp(&right.assignment_id));
        failures.sort_by(|left, right| left.authority_id.cmp(&right.authority_id));
        let authorities = assignments
            .iter()
            .map(|assignment| assignment.participant.authority_id.clone())
            .collect::<Vec<_>>();
        for assignment in &mut assignments {
            assignment.peer_authority_ids = authorities
                .iter()
                .filter(|authority_id| **authority_id != assignment.participant.authority_id)
                .cloned()
                .collect();
        }
        Ok((assignments, failures))
    }

    async fn evaluate_assignments(
        &self,
        plan: &CognitiveEvaluationPlan,
    ) -> CoordinationResult<(
        Vec<CognitiveProposal>,
        Vec<crate::model::ParticipantEvaluationFailure>,
    )> {
        let mut tasks = JoinSet::new();
        for assignment in &plan.assignments {
            let transport = Arc::clone(&self.transport);
            let assignment = assignment.clone();
            tasks.spawn(async move {
                let evaluated = transport
                    .evaluate(&assignment)
                    .await
                    .and_then(|draft| proposal_from_draft(&assignment, draft));
                (assignment, evaluated)
            });
        }
        let mut proposals = Vec::new();
        let mut failures = Vec::new();
        while let Some(result) = tasks.join_next().await {
            let (assignment, evaluated) = result.map_err(|error| {
                CoordinationError::Transport(format!("evaluation task failed: {error}"))
            })?;
            match evaluated {
                Ok(proposal) => proposals.push(proposal),
                Err(error) => failures.push(crate::model::ParticipantEvaluationFailure {
                    assignment_id: Some(assignment.assignment_id),
                    authority_id: assignment.participant.authority_id,
                    stage: crate::model::ParticipantEvaluationStage::Evaluation,
                    error: error.to_string(),
                }),
            }
        }
        proposals.sort_by(|left, right| left.proposal_id.cmp(&right.proposal_id));
        failures.sort_by(|left, right| left.authority_id.cmp(&right.authority_id));
        Ok((proposals, failures))
    }
}

fn proposal_from_draft(
    assignment: &EvaluationAssignment,
    draft: ProposalDraft,
) -> CoordinationResult<CognitiveProposal> {
    if draft.statement.is_null()
        || draft
            .statement
            .as_str()
            .is_some_and(|statement| statement.trim().is_empty())
    {
        return Err(CoordinationError::Transport(format!(
            "participant '{}' returned an empty proposal",
            assignment.participant.authority_id
        )));
    }
    for relation in &draft.claimed_relations {
        if !assignment
            .peer_authority_ids
            .contains(&relation.target_authority_id)
        {
            return Err(CoordinationError::Transport(format!(
                "participant '{}' claimed a relation to non-peer authority '{}'",
                assignment.participant.authority_id, relation.target_authority_id
            )));
        }
    }
    let mut proposal = CognitiveProposal {
        proposal_id: String::new(),
        request_id: assignment.request_id.clone(),
        assignment_id: assignment.assignment_id.clone(),
        contributor_authority_id: assignment.participant.authority_id.clone(),
        agent_id: assignment.participant.agent_id.clone(),
        source_context_id: assignment.participant.context_id.clone(),
        input_context_version: assignment.projection.context_version,
        input_projection_digest: assignment.projection.digest.clone(),
        statement: draft.statement,
        evidence_refs: draft.evidence_refs,
        artifact_refs: draft.artifact_refs,
        claimed_relations: draft.claimed_relations,
        digest: String::new(),
    };
    proposal.digest = proposal.expected_digest()?;
    proposal.proposal_id = format!("proposal-{}", digest_suffix(&proposal.digest));
    Ok(proposal)
}

fn build_commit_intent(
    request: &CognitiveEvaluationRequest,
    authority: &AuthorityDomain,
    graph: &crate::model::ContributionGraph,
    settlement: &SemanticSettlementRecord,
) -> CoordinationResult<UnionCommitIntent> {
    let target = request.commit_target.as_ref().ok_or_else(|| {
        CoordinationError::InvalidRequest("Union commit target is missing".to_string())
    })?;
    let frame_payload = json!({
        "kind": "experimental_union_cognition",
        "request_id": request.request_id,
        "objective_id": request.objective_id,
        "contribution_graph": graph,
        "semantic_settlement": settlement,
    });
    let frame_body = serde_json::to_string(&frame_payload)?;
    let mut intent = UnionCommitIntent {
        intent_id: String::new(),
        request_id: request.request_id.clone(),
        union_authority_id: authority.authority_id.clone(),
        union_authority_version: authority.version,
        union_context_id: target.context_id.clone(),
        union_session_id: target.session_id.clone(),
        base_union_version: target.base_version,
        contribution_graph_digest: graph.digest.clone(),
        settlement_digest: settlement.digest.clone(),
        frame_id: String::new(),
        frame_body,
        digest: String::new(),
    };
    intent.frame_id = intent.expected_frame_id()?;
    intent.digest = intent.expected_digest()?;
    intent.intent_id = format!("intent-{}", digest_suffix(&intent.digest));
    Ok(intent)
}

fn validate_settlement(
    graph: &crate::model::ContributionGraph,
    settlement: &SemanticSettlementRecord,
) -> CoordinationResult<()> {
    graph.validate_integrity()?;
    settlement.validate_integrity()?;
    if settlement.request_id != graph.request_id
        || settlement.contribution_graph_digest != graph.digest
    {
        return Err(CoordinationError::Settlement(
            "settlement is bound to a different contribution graph".to_string(),
        ));
    }
    let expected = graph
        .proposals
        .iter()
        .map(|proposal| proposal.proposal_id.as_str())
        .collect::<BTreeSet<_>>();
    let actual = settlement
        .dispositions
        .iter()
        .map(|disposition| disposition.proposal_id.as_str())
        .collect::<BTreeSet<_>>();
    if expected != actual || actual.len() != settlement.dispositions.len() {
        return Err(CoordinationError::Settlement(
            "settlement must contain exactly one disposition for every proposal".to_string(),
        ));
    }
    Ok(())
}

fn ensure_independent_participants(
    request: &CognitiveEvaluationRequest,
    participants: &[ParticipantDescriptor],
) -> CoordinationResult<()> {
    let mut authorities = BTreeSet::new();
    for participant in participants {
        participant.validate()?;
        if let Some(target) = &request.commit_target {
            if participant.context_id == target.context_id
                || participant.session_id == target.session_id
            {
                return Err(CoordinationError::InvalidRequest(
                    "participant cognition must be isolated from the Union commit Context"
                        .to_string(),
                ));
            }
        }
        // Agent and Context identifiers are scoped by Authority. Session is
        // intentionally unbound until projection creates a request-scoped
        // execution route. Authority is the globally unique participant
        // identity at this protocol boundary.
        if !authorities.insert(&participant.authority_id) {
            return Err(CoordinationError::InvalidRequest(
                "participants must have distinct Authority identities".to_string(),
            ));
        }
    }
    Ok(())
}

fn digest_suffix(digest: &str) -> &str {
    digest.strip_prefix("sha256:").unwrap_or(digest)
}
