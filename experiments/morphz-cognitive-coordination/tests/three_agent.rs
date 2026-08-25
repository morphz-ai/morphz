use async_trait::async_trait;
use morphz_cognitive_coordination::{
    verify_commit_certificate, AuthorityDomain, AuthorityKind, CapabilityRouter,
    ClaimedContributionRelation, CognitiveEvaluationCoordinator, CognitiveEvaluationRequest,
    CognitiveEvaluationTransport, CommitCertificate, ContributionRelationKind, CoordinationError,
    CoordinationResult, DeclaredRelationGraphBuilder, Ed25519MemberSigner, EvaluationAssignment,
    ParticipantDescriptor, PreserveAlternativesSettlement, ProjectionSnapshot, ProposalDraft,
    QuorumPolicy, RoutingConstraints, SettlementDisposition, SettlementPolicyRef,
    UnionCommitIntent, UnionCommitReceipt, UnionCommitTarget, UnionCommitter,
    EXPERIMENT_SPEC_VERSION,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct StubTransport {
    drafts: BTreeMap<String, ProposalDraft>,
    projection_failures: BTreeSet<String>,
}

#[async_trait]
impl CognitiveEvaluationTransport for StubTransport {
    async fn project(
        &self,
        participant: &ParticipantDescriptor,
        _request: &CognitiveEvaluationRequest,
    ) -> CoordinationResult<ProjectionSnapshot> {
        if self.projection_failures.contains(&participant.authority_id) {
            return Err(CoordinationError::Transport(format!(
                "projection unavailable for '{}'",
                participant.authority_id
            )));
        }
        Ok(ProjectionSnapshot {
            context_id: participant.context_id.clone(),
            session_id: participant.session_id.clone(),
            context_version: 7,
            digest: format!("projection-digest-{}", participant.authority_id),
        })
    }

    async fn evaluate(
        &self,
        assignment: &EvaluationAssignment,
    ) -> CoordinationResult<ProposalDraft> {
        self.drafts
            .get(&assignment.participant.authority_id)
            .cloned()
            .ok_or_else(|| {
                CoordinationError::Transport(format!(
                    "no draft for '{}'",
                    assignment.participant.authority_id
                ))
            })
    }
}

#[derive(Default)]
struct MemoryUnionState {
    version: u64,
    receipts: BTreeMap<String, UnionCommitReceipt>,
}

#[derive(Default)]
struct MemoryUnionCommitter {
    state: Mutex<MemoryUnionState>,
}

#[async_trait]
impl UnionCommitter for MemoryUnionCommitter {
    async fn commit(
        &self,
        authority: &AuthorityDomain,
        intent: &UnionCommitIntent,
        certificate: &CommitCertificate,
    ) -> CoordinationResult<UnionCommitReceipt> {
        verify_commit_certificate(intent, authority, certificate)?;
        let mut state = self.state.lock().unwrap();
        if let Some(existing) = state.receipts.get(&certificate.digest) {
            return Ok(existing.clone());
        }
        if state.version != intent.base_union_version {
            return Err(CoordinationError::Commit(format!(
                "stale Union version {}; current version is {}",
                intent.base_union_version, state.version
            )));
        }
        let receipt = UnionCommitReceipt {
            request_id: intent.request_id.clone(),
            union_context_id: intent.union_context_id.clone(),
            transaction_id: certificate.certificate_id.clone(),
            before_version: state.version,
            after_version: state.version + 1,
            frame_id: intent.frame_id.clone(),
            certificate_digest: certificate.digest.clone(),
        };
        state.version += 1;
        state
            .receipts
            .insert(certificate.digest.clone(), receipt.clone());
        Ok(receipt)
    }
}

fn participant(id: &str, priority: i32) -> ParticipantDescriptor {
    ParticipantDescriptor {
        authority_id: format!("authority-{id}"),
        agent_id: format!("agent-{id}"),
        context_id: format!("context-{id}"),
        session_id: format!("session-{id}"),
        capabilities: BTreeSet::from(["reasoning".to_string()]),
        model_profiles: Vec::new(),
        default_model: Default::default(),
        max_token_budget: 1_000,
        priority,
        enabled: true,
    }
}

fn request(request_id: &str) -> CognitiveEvaluationRequest {
    CognitiveEvaluationRequest {
        spec_version: EXPERIMENT_SPEC_VERSION.to_string(),
        request_id: request_id.to_string(),
        objective_id: "objective-patent-example".to_string(),
        initiator_authority_id: "authority-initiator".to_string(),
        commit_target: Some(UnionCommitTarget {
            authority_id: "authority-union".to_string(),
            context_id: "context-union".to_string(),
            session_id: "session-union".to_string(),
            base_version: 0,
        }),
        question: "Choose a safe implementation direction.".to_string(),
        shared_input: json!({"constraint": "preserve dissent"}),
        routing: RoutingConstraints {
            min_participants: 3,
            max_participants: 3,
            token_budget_per_participant: 500,
            max_total_token_budget: 1_500,
            required_capabilities: BTreeSet::from(["reasoning".to_string()]),
            preferred_capabilities: BTreeSet::new(),
            allowed_authority_ids: BTreeSet::new(),
            model: Default::default(),
            participant_models: Vec::new(),
        },
        settlement_policy: SettlementPolicyRef {
            id: "preserve-alternatives".to_string(),
            version: "0".to_string(),
        },
    }
}

fn test_transport() -> StubTransport {
    StubTransport {
        drafts: BTreeMap::from([
            (
                "authority-a".to_string(),
                ProposalDraft {
                    statement: Value::String("adopt design X".to_string()),
                    evidence_refs: vec!["evidence-a".to_string()],
                    artifact_refs: Vec::new(),
                    claimed_relations: Vec::new(),
                },
            ),
            (
                "authority-b".to_string(),
                ProposalDraft {
                    statement: Value::String("adopt design Y".to_string()),
                    evidence_refs: vec!["evidence-b".to_string()],
                    artifact_refs: Vec::new(),
                    claimed_relations: vec![ClaimedContributionRelation {
                        target_authority_id: "authority-a".to_string(),
                        relation: ContributionRelationKind::ConflictsWith,
                        evidence_refs: vec!["evidence-conflict".to_string()],
                    }],
                },
            ),
            (
                "authority-c".to_string(),
                ProposalDraft {
                    statement: Value::String("adopt design X".to_string()),
                    evidence_refs: vec!["evidence-c".to_string()],
                    artifact_refs: Vec::new(),
                    claimed_relations: Vec::new(),
                },
            ),
        ]),
        projection_failures: BTreeSet::new(),
    }
}

#[tokio::test]
async fn three_independent_agents_form_a_quorum_certified_union_frame() {
    let signer_a = Ed25519MemberSigner::generate("member-a", "agent-a", 1).unwrap();
    let signer_b = Ed25519MemberSigner::generate("member-b", "agent-b", 1).unwrap();
    let signer_c = Ed25519MemberSigner::generate("member-c", "agent-c", 1).unwrap();
    let authority = AuthorityDomain {
        authority_id: "authority-union".to_string(),
        kind: AuthorityKind::Union,
        version: 1,
        members: vec![
            signer_a.authority_member(),
            signer_b.authority_member(),
            signer_c.authority_member(),
        ],
        quorum: QuorumPolicy {
            threshold_weight: 2,
        },
    };
    let committer = Arc::new(MemoryUnionCommitter::default());
    let coordinator = CognitiveEvaluationCoordinator::new(
        Arc::new(CapabilityRouter),
        Arc::new(test_transport()),
        Arc::new(DeclaredRelationGraphBuilder),
        Arc::new(PreserveAlternativesSettlement),
        committer.clone(),
    );
    let participants = vec![
        participant("a", 30),
        participant("b", 20),
        participant("c", 10),
    ];

    let signers = vec![signer_a, signer_c];
    let outcome = coordinator
        .execute(
            request("request-1"),
            participants.clone(),
            &authority,
            &signers,
        )
        .await
        .unwrap();

    assert_eq!(outcome.plan.assignments.len(), 3);
    assert_eq!(outcome.contribution_graph.proposals.len(), 3);
    assert!(outcome.contribution_graph.edges.iter().any(|edge| {
        edge.relation == ContributionRelationKind::ConflictsWith
            && edge.evidence_refs == vec!["evidence-conflict"]
    }));
    assert!(outcome
        .contribution_graph
        .edges
        .iter()
        .any(|edge| edge.relation == ContributionRelationKind::Supports));
    assert!(outcome
        .settlement
        .dispositions
        .iter()
        .any(|item| item.disposition == SettlementDisposition::Accepted));
    assert!(outcome
        .settlement
        .dispositions
        .iter()
        .any(|item| item.disposition == SettlementDisposition::Coexisting));
    assert_eq!(outcome.commit_receipt.before_version, 0);
    assert_eq!(outcome.commit_receipt.after_version, 1);
    assert_eq!(
        verify_commit_certificate(&outcome.commit_intent, &authority, &outcome.certificate)
            .unwrap(),
        2
    );

    let replay = coordinator
        .execute(
            request("request-1"),
            participants.clone(),
            &authority,
            &signers,
        )
        .await
        .unwrap();
    assert_eq!(replay.certificate, outcome.certificate);
    assert_eq!(replay.commit_receipt, outcome.commit_receipt);
    assert_eq!(committer.state.lock().unwrap().version, 1);

    let stale = coordinator
        .execute(request("request-2"), participants, &authority, &signers)
        .await
        .unwrap_err();
    assert!(matches!(stale, CoordinationError::Commit(_)));
    assert_eq!(committer.state.lock().unwrap().version, 1);
}

#[tokio::test]
async fn commit_is_not_attempted_without_certificate_quorum() {
    let signer_a = Ed25519MemberSigner::generate("member-a", "agent-a", 1).unwrap();
    let signer_b = Ed25519MemberSigner::generate("member-b", "agent-b", 1).unwrap();
    let signer_c = Ed25519MemberSigner::generate("member-c", "agent-c", 1).unwrap();
    let authority = AuthorityDomain {
        authority_id: "authority-union".to_string(),
        kind: AuthorityKind::Union,
        version: 1,
        members: vec![
            signer_a.authority_member(),
            signer_b.authority_member(),
            signer_c.authority_member(),
        ],
        quorum: QuorumPolicy {
            threshold_weight: 2,
        },
    };
    let committer = Arc::new(MemoryUnionCommitter::default());
    let coordinator = CognitiveEvaluationCoordinator::new(
        Arc::new(CapabilityRouter),
        Arc::new(test_transport()),
        Arc::new(DeclaredRelationGraphBuilder),
        Arc::new(PreserveAlternativesSettlement),
        committer.clone(),
    );
    let error = coordinator
        .execute(
            request("request-without-quorum"),
            vec![
                participant("a", 30),
                participant("b", 20),
                participant("c", 10),
            ],
            &authority,
            &[signer_a],
        )
        .await
        .unwrap_err();

    assert!(matches!(error, CoordinationError::Certificate(_)));
    assert_eq!(committer.state.lock().unwrap().version, 0);
}

#[tokio::test]
async fn coordinated_evaluation_preserves_partial_failure_above_the_minimum() {
    let mut transport = test_transport();
    transport.drafts.remove("authority-c");
    let coordinator = CognitiveEvaluationCoordinator::new(
        Arc::new(CapabilityRouter),
        Arc::new(transport),
        Arc::new(DeclaredRelationGraphBuilder),
        Arc::new(PreserveAlternativesSettlement),
        Arc::new(MemoryUnionCommitter::default()),
    );
    let mut request = request("request-partial-failure");
    request.commit_target = None;
    request.routing.min_participants = 2;

    let result = coordinator
        .evaluate(
            request,
            vec![
                participant("a", 30),
                participant("b", 20),
                participant("c", 10),
            ],
        )
        .await
        .unwrap();

    assert_eq!(result.plan.assignments.len(), 3);
    assert_eq!(result.contribution_graph.proposals.len(), 2);
    assert_eq!(result.failures.len(), 1);
    assert_eq!(result.failures[0].authority_id, "authority-c");
}

#[tokio::test]
async fn coordinated_evaluation_preserves_projection_failure_above_the_minimum() {
    let mut transport = test_transport();
    transport
        .projection_failures
        .insert("authority-c".to_string());
    let coordinator = CognitiveEvaluationCoordinator::new(
        Arc::new(CapabilityRouter),
        Arc::new(transport),
        Arc::new(DeclaredRelationGraphBuilder),
        Arc::new(PreserveAlternativesSettlement),
        Arc::new(MemoryUnionCommitter::default()),
    );
    let mut request = request("request-projection-failure");
    request.commit_target = None;
    request.routing.min_participants = 2;

    let result = coordinator
        .evaluate(
            request,
            vec![
                participant("a", 30),
                participant("b", 20),
                participant("c", 10),
            ],
        )
        .await
        .unwrap();

    assert_eq!(result.plan.assignments.len(), 2);
    assert_eq!(result.plan.total_token_budget, 1_000);
    assert_eq!(result.contribution_graph.proposals.len(), 2);
    assert_eq!(result.failures.len(), 1);
    assert_eq!(result.failures[0].authority_id, "authority-c");
    assert!(result.failures[0].assignment_id.is_none());
}

#[tokio::test]
async fn duplicate_authority_is_rejected_before_evaluation() {
    let signer_a = Ed25519MemberSigner::generate("member-a", "agent-a", 1).unwrap();
    let signer_b = Ed25519MemberSigner::generate("member-b", "agent-b", 1).unwrap();
    let authority = AuthorityDomain {
        authority_id: "authority-union".to_string(),
        kind: AuthorityKind::Union,
        version: 1,
        members: vec![signer_a.authority_member(), signer_b.authority_member()],
        quorum: QuorumPolicy {
            threshold_weight: 2,
        },
    };
    let committer = Arc::new(MemoryUnionCommitter::default());
    let coordinator = CognitiveEvaluationCoordinator::new(
        Arc::new(CapabilityRouter),
        Arc::new(test_transport()),
        Arc::new(DeclaredRelationGraphBuilder),
        Arc::new(PreserveAlternativesSettlement),
        committer.clone(),
    );
    let mut participants = vec![
        participant("a", 30),
        participant("b", 20),
        participant("c", 10),
    ];
    participants[1].authority_id = participants[0].authority_id.clone();
    let error = coordinator
        .execute(
            request("request-fake-independence"),
            participants,
            &authority,
            &[signer_a, signer_b],
        )
        .await
        .unwrap_err();

    assert!(matches!(error, CoordinationError::InvalidRequest(_)));
    assert_eq!(committer.state.lock().unwrap().version, 0);
}
