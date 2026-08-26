use crate::digest::stable_digest;
use crate::error::{CoordinationError, CoordinationResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CognitiveEvaluationRequest {
    pub spec_version: String,
    pub request_id: String,
    pub objective_id: String,
    pub initiator_authority_id: String,
    /// Present only when the caller explicitly requests a later Union commit.
    /// Ordinary coordinated Evaluation is complete without a commit target.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit_target: Option<UnionCommitTarget>,
    pub question: String,
    #[serde(default)]
    pub shared_input: Value,
    pub routing: RoutingConstraints,
    pub settlement_policy: SettlementPolicyRef,
}

impl CognitiveEvaluationRequest {
    pub fn validate(&self) -> CoordinationResult<()> {
        for (field, value) in [
            ("spec_version", self.spec_version.as_str()),
            ("request_id", self.request_id.as_str()),
            ("objective_id", self.objective_id.as_str()),
            (
                "initiator_authority_id",
                self.initiator_authority_id.as_str(),
            ),
            ("question", self.question.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(CoordinationError::InvalidRequest(format!(
                    "{field} must not be empty"
                )));
            }
        }
        if let Some(target) = &self.commit_target {
            target.validate()?;
        }
        if self.settlement_policy.id.trim().is_empty()
            || self.settlement_policy.version.trim().is_empty()
        {
            return Err(CoordinationError::InvalidRequest(
                "settlement policy id and version must not be empty".to_string(),
            ));
        }
        self.routing.validate()
    }

    pub fn digest(&self) -> CoordinationResult<String> {
        stable_digest(self)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UnionCommitTarget {
    pub authority_id: String,
    pub context_id: String,
    pub session_id: String,
    pub base_version: u64,
}

impl UnionCommitTarget {
    pub fn validate(&self) -> CoordinationResult<()> {
        for (field, value) in [
            ("authority_id", self.authority_id.as_str()),
            ("context_id", self.context_id.as_str()),
            ("session_id", self.session_id.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(CoordinationError::InvalidRequest(format!(
                    "commit target {field} must not be empty"
                )));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RoutingConstraints {
    pub min_participants: usize,
    pub max_participants: usize,
    pub token_budget_per_participant: u64,
    pub max_total_token_budget: u64,
    #[serde(default)]
    pub required_capabilities: BTreeSet<String>,
    #[serde(default)]
    pub preferred_capabilities: BTreeSet<String>,
    #[serde(default)]
    pub allowed_authority_ids: BTreeSet<String>,
    /// Common model requirement applied to every selected participant unless
    /// an Authority-specific override is present.
    #[serde(default)]
    pub model: EvaluationModelRequest,
    #[serde(default)]
    pub participant_models: Vec<ParticipantModelRequest>,
}

impl RoutingConstraints {
    pub fn validate(&self) -> CoordinationResult<()> {
        if self.min_participants == 0 {
            return Err(CoordinationError::InvalidRequest(
                "min_participants must be greater than zero".to_string(),
            ));
        }
        if self.max_participants < self.min_participants {
            return Err(CoordinationError::InvalidRequest(
                "max_participants must be at least min_participants".to_string(),
            ));
        }
        if self.token_budget_per_participant == 0 {
            return Err(CoordinationError::InvalidRequest(
                "token_budget_per_participant must be greater than zero".to_string(),
            ));
        }
        let minimum = self
            .token_budget_per_participant
            .checked_mul(self.min_participants as u64)
            .ok_or_else(|| {
                CoordinationError::InvalidRequest("minimum token budget overflowed".to_string())
            })?;
        if self.max_total_token_budget < minimum {
            return Err(CoordinationError::InvalidRequest(format!(
                "max_total_token_budget must be at least {minimum}"
            )));
        }
        self.model.validate()?;
        let mut authorities = BTreeSet::new();
        for override_request in &self.participant_models {
            if override_request.authority_id.trim().is_empty()
                || !authorities.insert(override_request.authority_id.clone())
            {
                return Err(CoordinationError::InvalidRequest(
                    "participant model overrides require unique non-empty Authority ids"
                        .to_string(),
                ));
            }
            override_request.model.validate()?;
        }
        Ok(())
    }

    pub fn model_for(&self, authority_id: &str) -> &EvaluationModelRequest {
        self.participant_models
            .iter()
            .find(|item| item.authority_id == authority_id)
            .map(|item| &item.model)
            .unwrap_or(&self.model)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct EvaluationModelRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
}

impl EvaluationModelRequest {
    pub fn validate(&self) -> CoordinationResult<()> {
        if self
            .route
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
            || self
                .reasoning_effort
                .as_deref()
                .is_some_and(|value| value.trim().is_empty())
        {
            return Err(CoordinationError::InvalidRequest(
                "model route and reasoning effort must not be empty when provided".to_string(),
            ));
        }
        Ok(())
    }

    pub fn is_default(&self) -> bool {
        self.route.is_none() && self.reasoning_effort.is_none()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ParticipantModelRequest {
    pub authority_id: String,
    #[serde(flatten)]
    pub model: EvaluationModelRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelExecutionProfile {
    pub route: String,
    pub label: String,
    #[serde(default)]
    pub physical_models: Vec<String>,
    /// `None` means the Provider has not declared an exact vocabulary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supported_reasoning_efforts: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SettlementPolicyRef {
    pub id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ParticipantDescriptor {
    pub authority_id: String,
    pub agent_id: String,
    pub context_id: String,
    /// Empty in a handshake advertisement. The projection phase binds this
    /// participant capability to an Assignment-scoped execution Session.
    /// A Runtime Session is therefore never part of a node's durable identity.
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub capabilities: BTreeSet<String>,
    #[serde(default)]
    pub model_profiles: Vec<ModelExecutionProfile>,
    /// Effective local Runtime policy frozen by handshake. The coordinator
    /// copies this into an Assignment when no explicit override is requested.
    #[serde(default)]
    pub default_model: EvaluationModelRequest,
    pub max_token_budget: u64,
    pub priority: i32,
    pub enabled: bool,
}

impl ParticipantDescriptor {
    pub fn validate(&self) -> CoordinationResult<()> {
        for (field, value) in [
            ("authority_id", self.authority_id.as_str()),
            ("agent_id", self.agent_id.as_str()),
            ("context_id", self.context_id.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(CoordinationError::InvalidRequest(format!(
                    "participant {field} must not be empty"
                )));
            }
        }
        if self.max_token_budget == 0 {
            return Err(CoordinationError::InvalidRequest(
                "participant max_token_budget must be greater than zero".to_string(),
            ));
        }
        if self
            .capabilities
            .iter()
            .any(|capability| capability.trim().is_empty())
        {
            return Err(CoordinationError::InvalidRequest(
                "participant capabilities must not contain empty names".to_string(),
            ));
        }
        self.default_model.validate()?;
        let mut routes = BTreeSet::new();
        for profile in &self.model_profiles {
            if profile.route.trim().is_empty()
                || profile.label.trim().is_empty()
                || !routes.insert(profile.route.clone())
            {
                return Err(CoordinationError::InvalidRequest(
                    "participant model profiles require unique non-empty routes and labels"
                        .to_string(),
                ));
            }
            if profile
                .supported_reasoning_efforts
                .as_ref()
                .is_some_and(|levels| {
                    let unique = levels.iter().collect::<BTreeSet<_>>();
                    unique.len() != levels.len()
                        || levels.iter().any(|level| level.trim().is_empty())
                })
            {
                return Err(CoordinationError::InvalidRequest(format!(
                    "model route '{}' has invalid reasoning-effort declarations",
                    profile.route
                )));
            }
        }
        if let Some(default_route) = self.default_model.route.as_deref() {
            let profile = self
                .model_profiles
                .iter()
                .find(|profile| profile.route == default_route)
                .ok_or_else(|| {
                    CoordinationError::InvalidRequest(format!(
                        "default model route '{default_route}' is not advertised"
                    ))
                })?;
            if let Some(effort) = self.default_model.reasoning_effort.as_deref() {
                if profile
                    .supported_reasoning_efforts
                    .as_ref()
                    .is_some_and(|levels| !levels.iter().any(|level| level == effort))
                {
                    return Err(CoordinationError::InvalidRequest(format!(
                        "default reasoning effort '{effort}' is not advertised by route '{default_route}'"
                    )));
                }
            }
        }
        Ok(())
    }

    /// Assignment execution needs a concrete, request-scoped Session even
    /// though capability advertisements deliberately do not carry one.
    pub fn validate_assignment_route(&self) -> CoordinationResult<()> {
        self.validate()?;
        if self.session_id.trim().is_empty() {
            return Err(CoordinationError::InvalidRequest(
                "assigned participant session_id must not be empty".to_string(),
            ));
        }
        Ok(())
    }

    /// Resolves an abstract model request to the concrete logical route that
    /// this participant advertised during handshake. The returned value is
    /// frozen into the Evaluation Assignment so later local policy changes do
    /// not silently alter an in-flight coordinated Evaluation.
    pub fn resolve_model(
        &self,
        request: &EvaluationModelRequest,
    ) -> CoordinationResult<EvaluationModelRequest> {
        request.validate()?;
        if request.is_default() {
            return Ok(self.default_model.clone());
        }

        let mut candidates = self
            .model_profiles
            .iter()
            .filter(|profile| {
                request
                    .route
                    .as_deref()
                    .is_none_or(|route| profile.route == route)
            })
            .collect::<Vec<_>>();
        candidates.sort_by(|left, right| {
            let left_is_default = self.default_model.route.as_deref() == Some(left.route.as_str());
            let right_is_default =
                self.default_model.route.as_deref() == Some(right.route.as_str());
            right_is_default
                .cmp(&left_is_default)
                .then_with(|| left.route.cmp(&right.route))
        });

        let profile = candidates
            .into_iter()
            .find(|profile| {
                request.reasoning_effort.as_deref().is_none_or(|effort| {
                    profile
                        .supported_reasoning_efforts
                        .as_ref()
                        .is_some_and(|levels| levels.iter().any(|level| level == effort))
                })
            })
            .ok_or_else(|| {
                let reason = match (
                    request.route.as_deref(),
                    request.reasoning_effort.as_deref(),
                ) {
                    (Some(route), Some(effort)) => format!(
                        "model route '{route}' does not declare reasoning effort '{effort}'"
                    ),
                    (Some(route), None) => format!("model route '{route}' is unavailable"),
                    (None, Some(effort)) => format!(
                        "reasoning effort '{effort}' is not declared by an eligible model route"
                    ),
                    (None, None) => "participant advertises no eligible model route".to_string(),
                };
                CoordinationError::Routing(reason)
            })?;

        Ok(EvaluationModelRequest {
            route: Some(profile.route.clone()),
            reasoning_effort: request.reasoning_effort.clone().or_else(|| {
                (self.default_model.route.as_deref() == Some(profile.route.as_str()))
                    .then(|| self.default_model.reasoning_effort.clone())
                    .flatten()
            }),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RoutingRejection {
    pub authority_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectionSnapshot {
    pub context_id: String,
    pub session_id: String,
    pub context_version: u64,
    pub digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EvaluationAssignment {
    pub assignment_id: String,
    pub request_id: String,
    pub objective_id: String,
    pub participant: ParticipantDescriptor,
    /// Stable Authority identities visible for relationship claims. Sibling
    /// proposal contents remain hidden during independent Evaluation.
    #[serde(default)]
    pub peer_authority_ids: Vec<String>,
    pub question: String,
    pub shared_input: Value,
    pub projection: ProjectionSnapshot,
    pub token_budget: u64,
    /// Immutable per-Evaluation request negotiated before dispatch. Empty
    /// fields preserve the participant Runtime's advertised defaults.
    #[serde(default)]
    pub model: EvaluationModelRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CognitiveEvaluationPlan {
    pub plan_id: String,
    pub request_id: String,
    pub request_digest: String,
    pub assignments: Vec<EvaluationAssignment>,
    pub rejected: Vec<RoutingRejection>,
    pub total_token_budget: u64,
    pub routing_algorithm: String,
}

/// Coordinated Evaluation is a complete result in its own right. A caller may
/// inspect or settle this graph without granting authority to modify Union
/// Mind. Commit artifacts live only in `CoordinationOutcome`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CognitiveEvaluationResult {
    pub request: CognitiveEvaluationRequest,
    pub plan: CognitiveEvaluationPlan,
    pub contribution_graph: ContributionGraph,
    pub settlement: SemanticSettlementRecord,
    #[serde(default)]
    pub failures: Vec<ParticipantEvaluationFailure>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ParticipantEvaluationFailure {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignment_id: Option<String>,
    pub authority_id: String,
    pub stage: ParticipantEvaluationStage,
    pub error: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ParticipantEvaluationStage {
    Projection,
    Evaluation,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum ContributionRelationKind {
    Supports,
    ConflictsWith,
    Refines,
    Verifies,
    DerivedFrom,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClaimedContributionRelation {
    pub target_authority_id: String,
    pub relation: ContributionRelationKind,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CognitiveProposal {
    pub proposal_id: String,
    pub request_id: String,
    pub assignment_id: String,
    pub contributor_authority_id: String,
    pub agent_id: String,
    pub source_context_id: String,
    pub input_context_version: u64,
    pub input_projection_digest: String,
    pub statement: Value,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
    #[serde(default)]
    pub artifact_refs: Vec<String>,
    #[serde(default)]
    pub claimed_relations: Vec<ClaimedContributionRelation>,
    pub digest: String,
}

impl CognitiveProposal {
    /// Computes the content identity of a proposal without trusting its
    /// caller-supplied `proposal_id` or `digest` fields.
    pub fn expected_digest(&self) -> CoordinationResult<String> {
        stable_digest(&(
            self.request_id.as_str(),
            self.assignment_id.as_str(),
            self.contributor_authority_id.as_str(),
            self.agent_id.as_str(),
            self.source_context_id.as_str(),
            self.input_context_version,
            self.input_projection_digest.as_str(),
            &self.statement,
            &self.evidence_refs,
            &self.artifact_refs,
            &self.claimed_relations,
        ))
    }

    pub fn validate_integrity(&self) -> CoordinationResult<()> {
        let expected = self.expected_digest()?;
        if self.digest != expected
            || self.proposal_id != format!("proposal-{}", digest_suffix(&expected))
        {
            return Err(CoordinationError::Graph(format!(
                "proposal '{}' has an inconsistent content identity",
                self.proposal_id
            )));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContributionEdge {
    pub edge_id: String,
    pub from_proposal_id: String,
    pub to_proposal_id: String,
    pub relation: ContributionRelationKind,
    pub asserted_by_authority_id: String,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContributionGraph {
    pub request_id: String,
    pub proposals: Vec<CognitiveProposal>,
    pub edges: Vec<ContributionEdge>,
    pub digest: String,
}

impl ContributionGraph {
    pub fn expected_digest(&self) -> CoordinationResult<String> {
        stable_digest(&(self.request_id.as_str(), &self.proposals, &self.edges))
    }

    pub fn validate_integrity(&self) -> CoordinationResult<()> {
        if self.proposals.is_empty() {
            return Err(CoordinationError::Graph(
                "at least one proposal is required".to_string(),
            ));
        }
        let mut proposal_ids = BTreeSet::new();
        let mut authorities = BTreeSet::new();
        for proposal in &self.proposals {
            proposal.validate_integrity()?;
            if proposal.request_id != self.request_id
                || !proposal_ids.insert(proposal.proposal_id.clone())
                || !authorities.insert(proposal.contributor_authority_id.clone())
            {
                return Err(CoordinationError::Graph(
                    "contribution graph contains a duplicate or misbound proposal".to_string(),
                ));
            }
        }
        let mut edge_ids = BTreeSet::new();
        for edge in &self.edges {
            let expected_id = format!(
                "edge-{}",
                digest_suffix(&stable_digest(&(
                    edge.from_proposal_id.as_str(),
                    edge.to_proposal_id.as_str(),
                    edge.relation,
                    edge.asserted_by_authority_id.as_str(),
                ))?)
            );
            if edge.from_proposal_id == edge.to_proposal_id
                || !proposal_ids.contains(&edge.from_proposal_id)
                || !proposal_ids.contains(&edge.to_proposal_id)
                || edge.asserted_by_authority_id.trim().is_empty()
                || edge.edge_id != expected_id
                || !edge_ids.insert(edge.edge_id.clone())
            {
                return Err(CoordinationError::Graph(
                    "contribution graph contains an invalid edge".to_string(),
                ));
            }
        }
        if self.digest != self.expected_digest()? {
            return Err(CoordinationError::Graph(
                "contribution graph has an inconsistent content identity".to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SettlementDisposition {
    Accepted,
    Coexisting,
    Rejected,
    NeedsVerification,
    Deferred,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProposalDisposition {
    pub proposal_id: String,
    pub disposition: SettlementDisposition,
    pub rationale: String,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SemanticSettlementRecord {
    pub settlement_id: String,
    pub request_id: String,
    pub contribution_graph_digest: String,
    pub policy: SettlementPolicyRef,
    pub decided_by: Vec<String>,
    pub dispositions: Vec<ProposalDisposition>,
    #[serde(default)]
    pub dissenting_proposal_ids: Vec<String>,
    pub summary: Value,
    pub digest: String,
}

impl SemanticSettlementRecord {
    pub fn expected_digest(&self) -> CoordinationResult<String> {
        stable_digest(&(
            self.request_id.as_str(),
            self.contribution_graph_digest.as_str(),
            &self.policy,
            &self.decided_by,
            &self.dispositions,
            &self.dissenting_proposal_ids,
            &self.summary,
        ))
    }

    pub fn validate_integrity(&self) -> CoordinationResult<()> {
        if self.decided_by.is_empty() || self.decided_by.iter().any(|item| item.trim().is_empty()) {
            return Err(CoordinationError::Settlement(
                "semantic settlement must identify its decision procedure".to_string(),
            ));
        }
        let expected = self.expected_digest()?;
        if self.digest != expected
            || self.settlement_id != format!("settlement-{}", digest_suffix(&expected))
        {
            return Err(CoordinationError::Settlement(
                "semantic settlement has an inconsistent content identity".to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UnionCommitIntent {
    pub intent_id: String,
    pub request_id: String,
    pub union_authority_id: String,
    pub union_authority_version: u64,
    pub union_context_id: String,
    pub union_session_id: String,
    pub base_union_version: u64,
    pub contribution_graph_digest: String,
    pub settlement_digest: String,
    pub frame_id: String,
    pub frame_body: String,
    pub digest: String,
}

impl UnionCommitIntent {
    pub fn expected_frame_id(&self) -> CoordinationResult<String> {
        let digest = stable_digest(&(
            self.request_id.as_str(),
            self.contribution_graph_digest.as_str(),
            self.settlement_digest.as_str(),
            self.frame_body.as_str(),
        ))?;
        Ok(format!("union-frame-{}", digest_suffix(&digest)))
    }

    pub fn expected_digest(&self) -> CoordinationResult<String> {
        stable_digest(&(
            self.request_id.as_str(),
            self.union_authority_id.as_str(),
            self.union_authority_version,
            self.union_context_id.as_str(),
            self.union_session_id.as_str(),
            self.base_union_version,
            self.contribution_graph_digest.as_str(),
            self.settlement_digest.as_str(),
            self.frame_id.as_str(),
            self.frame_body.as_str(),
        ))
    }

    pub fn validate_integrity(&self) -> CoordinationResult<()> {
        let expected_frame_id = self.expected_frame_id()?;
        let expected_digest = self.expected_digest()?;
        if self.frame_id != expected_frame_id
            || self.digest != expected_digest
            || self.intent_id != format!("intent-{}", digest_suffix(&expected_digest))
        {
            return Err(CoordinationError::Certificate(
                "commit intent has an inconsistent content identity".to_string(),
            ));
        }
        let payload: Value = serde_json::from_str(&self.frame_body)?;
        if payload.get("kind").and_then(Value::as_str) != Some("experimental_union_cognition")
            || payload.get("request_id").and_then(Value::as_str) != Some(self.request_id.as_str())
        {
            return Err(CoordinationError::Certificate(
                "commit intent frame payload has an invalid kind or request binding".to_string(),
            ));
        }
        let graph: ContributionGraph = serde_json::from_value(
            payload.get("contribution_graph").cloned().ok_or_else(|| {
                CoordinationError::Certificate(
                    "commit intent frame payload has no contribution graph".to_string(),
                )
            })?,
        )?;
        let settlement: SemanticSettlementRecord = serde_json::from_value(
            payload.get("semantic_settlement").cloned().ok_or_else(|| {
                CoordinationError::Certificate(
                    "commit intent frame payload has no semantic settlement".to_string(),
                )
            })?,
        )?;
        graph.validate_integrity()?;
        settlement.validate_integrity()?;
        if graph.request_id != self.request_id
            || graph.digest != self.contribution_graph_digest
            || settlement.request_id != self.request_id
            || settlement.contribution_graph_digest != graph.digest
            || settlement.digest != self.settlement_digest
        {
            return Err(CoordinationError::Certificate(
                "commit intent frame payload is not bound to its declared graph and settlement"
                    .to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemberSignature {
    pub member_id: String,
    pub algorithm: String,
    pub signature_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CommitCertificate {
    pub certificate_id: String,
    pub authority_id: String,
    pub authority_version: u64,
    pub intent_digest: String,
    pub threshold_weight: u64,
    pub signatures: Vec<MemberSignature>,
    pub digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UnionCommitReceipt {
    pub request_id: String,
    pub union_context_id: String,
    pub transaction_id: String,
    pub before_version: u64,
    pub after_version: u64,
    pub frame_id: String,
    pub certificate_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CoordinationOutcome {
    pub request: CognitiveEvaluationRequest,
    pub plan: CognitiveEvaluationPlan,
    pub contribution_graph: ContributionGraph,
    pub settlement: SemanticSettlementRecord,
    pub commit_intent: UnionCommitIntent,
    pub certificate: CommitCertificate,
    pub commit_receipt: UnionCommitReceipt,
}

fn digest_suffix(digest: &str) -> &str {
    digest.strip_prefix("sha256:").unwrap_or(digest)
}

#[cfg(test)]
mod tests {
    use super::{EvaluationModelRequest, ModelExecutionProfile, ParticipantDescriptor};
    use std::collections::BTreeSet;

    fn participant() -> ParticipantDescriptor {
        ParticipantDescriptor {
            authority_id: "authority-a".to_string(),
            agent_id: "default-agent".to_string(),
            context_id: "context-default".to_string(),
            session_id: "session-default".to_string(),
            capabilities: BTreeSet::new(),
            model_profiles: vec![
                ModelExecutionProfile {
                    route: "fast".to_string(),
                    label: "Fast".to_string(),
                    physical_models: vec!["provider/model-fast".to_string()],
                    supported_reasoning_efforts: Some(vec!["low".to_string()]),
                    context_window: Some(64_000),
                    max_output_tokens: Some(8_000),
                },
                ModelExecutionProfile {
                    route: "deep".to_string(),
                    label: "Deep".to_string(),
                    physical_models: vec!["provider/model-deep".to_string()],
                    supported_reasoning_efforts: Some(vec![
                        "medium".to_string(),
                        "high".to_string(),
                    ]),
                    context_window: Some(128_000),
                    max_output_tokens: Some(16_000),
                },
            ],
            default_model: EvaluationModelRequest {
                route: Some("fast".to_string()),
                reasoning_effort: Some("low".to_string()),
            },
            max_token_budget: 10_000,
            priority: 0,
            enabled: true,
        }
    }

    #[test]
    fn reasoning_effort_can_select_a_non_default_advertised_route() {
        let resolved = participant()
            .resolve_model(&EvaluationModelRequest {
                route: None,
                reasoning_effort: Some("high".to_string()),
            })
            .unwrap();
        assert_eq!(resolved.route.as_deref(), Some("deep"));
        assert_eq!(resolved.reasoning_effort.as_deref(), Some("high"));
    }

    #[test]
    fn unsupported_route_effort_pair_is_rejected() {
        let error = participant()
            .resolve_model(&EvaluationModelRequest {
                route: Some("fast".to_string()),
                reasoning_effort: Some("high".to_string()),
            })
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("does not declare reasoning effort"));
    }
}
