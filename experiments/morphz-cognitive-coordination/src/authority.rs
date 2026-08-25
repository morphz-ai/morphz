use crate::digest::stable_digest;
use crate::error::{CoordinationError, CoordinationResult};
use crate::model::{CommitCertificate, MemberSignature, UnionCommitIntent};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair, UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthorityKind {
    Agent,
    Project,
    Organization,
    Union,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthorityMember {
    pub member_id: String,
    pub agent_id: String,
    pub weight: u64,
    pub verification_key_base64: String,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QuorumPolicy {
    pub threshold_weight: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthorityDomain {
    pub authority_id: String,
    pub kind: AuthorityKind,
    pub version: u64,
    pub members: Vec<AuthorityMember>,
    pub quorum: QuorumPolicy,
}

impl AuthorityDomain {
    pub fn validate(&self) -> CoordinationResult<()> {
        if self.authority_id.trim().is_empty() {
            return Err(CoordinationError::Certificate(
                "authority_id must not be empty".to_string(),
            ));
        }
        if self.version == 0 {
            return Err(CoordinationError::Certificate(
                "authority version must be greater than zero".to_string(),
            ));
        }
        if self.quorum.threshold_weight == 0 {
            return Err(CoordinationError::Certificate(
                "quorum threshold must be greater than zero".to_string(),
            ));
        }
        let mut ids = BTreeSet::new();
        let mut verification_keys = BTreeSet::new();
        let mut total_active_weight = 0_u64;
        for member in &self.members {
            if member.member_id.trim().is_empty() || member.agent_id.trim().is_empty() {
                return Err(CoordinationError::Certificate(
                    "authority member identity must not be empty".to_string(),
                ));
            }
            if !ids.insert(member.member_id.clone()) {
                return Err(CoordinationError::Certificate(format!(
                    "duplicate authority member '{}'",
                    member.member_id
                )));
            }
            if member.weight == 0 {
                return Err(CoordinationError::Certificate(format!(
                    "authority member '{}' has zero weight",
                    member.member_id
                )));
            }
            BASE64_STANDARD
                .decode(&member.verification_key_base64)
                .map_err(|error| {
                    CoordinationError::Certificate(format!(
                        "authority member '{}' has an invalid verification key: {error}",
                        member.member_id
                    ))
                })?;
            if !verification_keys.insert(member.verification_key_base64.clone()) {
                return Err(CoordinationError::Certificate(
                    "authority members must use distinct verification keys".to_string(),
                ));
            }
            if member.active {
                total_active_weight =
                    total_active_weight
                        .checked_add(member.weight)
                        .ok_or_else(|| {
                            CoordinationError::Certificate(
                                "active authority weight overflowed".to_string(),
                            )
                        })?;
            }
        }
        if self.quorum.threshold_weight > total_active_weight {
            return Err(CoordinationError::Certificate(format!(
                "quorum threshold {} exceeds active member weight {}",
                self.quorum.threshold_weight, total_active_weight
            )));
        }
        Ok(())
    }
}

pub struct Ed25519MemberSigner {
    member_id: String,
    agent_id: String,
    weight: u64,
    key_pair: Arc<Ed25519KeyPair>,
}

impl Ed25519MemberSigner {
    pub fn generate(
        member_id: impl Into<String>,
        agent_id: impl Into<String>,
        weight: u64,
    ) -> CoordinationResult<Self> {
        let rng = SystemRandom::new();
        let document = Ed25519KeyPair::generate_pkcs8(&rng).map_err(|_| {
            CoordinationError::Certificate("failed to generate Ed25519 key".to_string())
        })?;
        let key_pair = Ed25519KeyPair::from_pkcs8(document.as_ref()).map_err(|_| {
            CoordinationError::Certificate("failed to load generated Ed25519 key".to_string())
        })?;
        Ok(Self {
            member_id: member_id.into(),
            agent_id: agent_id.into(),
            weight,
            key_pair: Arc::new(key_pair),
        })
    }

    pub fn authority_member(&self) -> AuthorityMember {
        AuthorityMember {
            member_id: self.member_id.clone(),
            agent_id: self.agent_id.clone(),
            weight: self.weight,
            verification_key_base64: BASE64_STANDARD.encode(self.key_pair.public_key().as_ref()),
            active: true,
        }
    }

    fn sign(&self, intent_digest: &str) -> MemberSignature {
        MemberSignature {
            member_id: self.member_id.clone(),
            algorithm: "ed25519".to_string(),
            signature_base64: BASE64_STANDARD
                .encode(self.key_pair.sign(intent_digest.as_bytes()).as_ref()),
        }
    }
}

pub fn issue_commit_certificate(
    intent: &UnionCommitIntent,
    authority: &AuthorityDomain,
    signers: &[Ed25519MemberSigner],
) -> CoordinationResult<CommitCertificate> {
    authority.validate()?;
    if intent.union_authority_id != authority.authority_id
        || intent.union_authority_version != authority.version
    {
        return Err(CoordinationError::Certificate(
            "commit intent is bound to a different authority revision".to_string(),
        ));
    }
    let mut signatures = signers
        .iter()
        .map(|signer| signer.sign(&intent.digest))
        .collect::<Vec<_>>();
    signatures.sort_by(|left, right| left.member_id.cmp(&right.member_id));
    let identity = (
        authority.authority_id.as_str(),
        authority.version,
        intent.digest.as_str(),
        authority.quorum.threshold_weight,
        &signatures,
    );
    let digest = stable_digest(&identity)?;
    let certificate = CommitCertificate {
        certificate_id: format!("certificate-{}", digest_suffix(&digest)),
        authority_id: authority.authority_id.clone(),
        authority_version: authority.version,
        intent_digest: intent.digest.clone(),
        threshold_weight: authority.quorum.threshold_weight,
        signatures,
        digest,
    };
    verify_commit_certificate(intent, authority, &certificate)?;
    Ok(certificate)
}

pub fn verify_commit_certificate(
    intent: &UnionCommitIntent,
    authority: &AuthorityDomain,
    certificate: &CommitCertificate,
) -> CoordinationResult<u64> {
    authority.validate()?;
    intent.validate_integrity()?;
    if certificate.authority_id != authority.authority_id
        || certificate.authority_version != authority.version
        || certificate.intent_digest != intent.digest
        || certificate.threshold_weight != authority.quorum.threshold_weight
    {
        return Err(CoordinationError::Certificate(
            "certificate binding does not match the commit intent and authority revision"
                .to_string(),
        ));
    }
    let expected_digest = stable_digest(&(
        certificate.authority_id.as_str(),
        certificate.authority_version,
        certificate.intent_digest.as_str(),
        certificate.threshold_weight,
        &certificate.signatures,
    ))?;
    if expected_digest != certificate.digest
        || certificate.certificate_id != format!("certificate-{}", digest_suffix(&expected_digest))
    {
        return Err(CoordinationError::Certificate(
            "certificate digest is inconsistent".to_string(),
        ));
    }

    let mut seen = BTreeSet::new();
    let mut signed_weight = 0_u64;
    for signature in &certificate.signatures {
        if !seen.insert(signature.member_id.clone()) {
            return Err(CoordinationError::Certificate(format!(
                "member '{}' signed more than once",
                signature.member_id
            )));
        }
        if signature.algorithm != "ed25519" {
            return Err(CoordinationError::Certificate(format!(
                "member '{}' used unsupported signature algorithm '{}'",
                signature.member_id, signature.algorithm
            )));
        }
        let member = authority
            .members
            .iter()
            .find(|member| member.member_id == signature.member_id && member.active)
            .ok_or_else(|| {
                CoordinationError::Certificate(format!(
                    "signature member '{}' is not active in the authority revision",
                    signature.member_id
                ))
            })?;
        let public_key = BASE64_STANDARD
            .decode(&member.verification_key_base64)
            .map_err(|error| CoordinationError::Certificate(error.to_string()))?;
        let signature_bytes = BASE64_STANDARD
            .decode(&signature.signature_base64)
            .map_err(|error| CoordinationError::Certificate(error.to_string()))?;
        UnparsedPublicKey::new(&ED25519, public_key)
            .verify(intent.digest.as_bytes(), &signature_bytes)
            .map_err(|_| {
                CoordinationError::Certificate(format!(
                    "signature from member '{}' is invalid",
                    signature.member_id
                ))
            })?;
        signed_weight = signed_weight.checked_add(member.weight).ok_or_else(|| {
            CoordinationError::Certificate("signed authority weight overflowed".to_string())
        })?;
    }
    if signed_weight < authority.quorum.threshold_weight {
        return Err(CoordinationError::Certificate(format!(
            "signed weight {signed_weight} is below quorum threshold {}",
            authority.quorum.threshold_weight
        )));
    }
    Ok(signed_weight)
}

fn digest_suffix(digest: &str) -> &str {
    digest.strip_prefix("sha256:").unwrap_or(digest)
}

#[cfg(test)]
mod tests {
    use super::{
        issue_commit_certificate, verify_commit_certificate, AuthorityDomain, AuthorityKind,
        Ed25519MemberSigner, QuorumPolicy,
    };
    use crate::model::{
        CognitiveProposal, ContributionGraph, ProposalDisposition, SemanticSettlementRecord,
        SettlementDisposition, SettlementPolicyRef, UnionCommitIntent,
    };
    use serde_json::{json, Value};

    fn intent() -> UnionCommitIntent {
        let mut proposal = CognitiveProposal {
            proposal_id: String::new(),
            request_id: "request".to_string(),
            assignment_id: "assignment".to_string(),
            contributor_authority_id: "contributor".to_string(),
            agent_id: "agent-a".to_string(),
            source_context_id: "source-context".to_string(),
            input_context_version: 1,
            input_projection_digest: "projection".to_string(),
            statement: Value::String("proposal".to_string()),
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
        let mut graph = ContributionGraph {
            request_id: "request".to_string(),
            proposals: vec![proposal.clone()],
            edges: Vec::new(),
            digest: String::new(),
        };
        graph.digest = graph.expected_digest().unwrap();
        let mut settlement = SemanticSettlementRecord {
            settlement_id: String::new(),
            request_id: "request".to_string(),
            contribution_graph_digest: graph.digest.clone(),
            policy: SettlementPolicyRef {
                id: "preserve-alternatives".to_string(),
                version: "0".to_string(),
            },
            decided_by: vec!["policy:test".to_string()],
            dispositions: vec![ProposalDisposition {
                proposal_id: proposal.proposal_id,
                disposition: SettlementDisposition::Accepted,
                rationale: "test".to_string(),
                evidence_refs: Vec::new(),
            }],
            dissenting_proposal_ids: Vec::new(),
            summary: json!({"accepted": true}),
            digest: String::new(),
        };
        settlement.digest = settlement.expected_digest().unwrap();
        settlement.settlement_id = format!(
            "settlement-{}",
            settlement.digest.strip_prefix("sha256:").unwrap()
        );
        let graph_digest = graph.digest.clone();
        let settlement_digest = settlement.digest.clone();
        let frame_body = serde_json::to_string(&json!({
            "kind": "experimental_union_cognition",
            "request_id": "request",
            "contribution_graph": &graph,
            "semantic_settlement": &settlement,
        }))
        .unwrap();
        let mut intent = UnionCommitIntent {
            intent_id: String::new(),
            request_id: "request".to_string(),
            union_authority_id: "union".to_string(),
            union_authority_version: 1,
            union_context_id: "context".to_string(),
            union_session_id: "session".to_string(),
            base_union_version: 0,
            contribution_graph_digest: graph_digest,
            settlement_digest,
            frame_id: String::new(),
            frame_body,
            digest: String::new(),
        };
        intent.frame_id = intent.expected_frame_id().unwrap();
        intent.digest = intent.expected_digest().unwrap();
        intent.intent_id = format!("intent-{}", intent.digest.strip_prefix("sha256:").unwrap());
        intent
    }

    #[test]
    fn two_of_three_certificate_is_verified_and_one_signature_is_rejected() {
        let a = Ed25519MemberSigner::generate("a", "agent-a", 1).unwrap();
        let b = Ed25519MemberSigner::generate("b", "agent-b", 1).unwrap();
        let c = Ed25519MemberSigner::generate("c", "agent-c", 1).unwrap();
        let authority = AuthorityDomain {
            authority_id: "union".to_string(),
            kind: AuthorityKind::Union,
            version: 1,
            members: vec![
                a.authority_member(),
                b.authority_member(),
                c.authority_member(),
            ],
            quorum: QuorumPolicy {
                threshold_weight: 2,
            },
        };
        assert!(issue_commit_certificate(&intent(), &authority, &[a]).is_err());
        let intent = intent();
        let certificate = issue_commit_certificate(&intent, &authority, &[b, c]).unwrap();
        assert_eq!(
            verify_commit_certificate(&intent, &authority, &certificate).unwrap(),
            2
        );

        let mut tampered = intent;
        tampered.frame_body.push(' ');
        assert!(verify_commit_certificate(&tampered, &authority, &certificate).is_err());
    }
}
