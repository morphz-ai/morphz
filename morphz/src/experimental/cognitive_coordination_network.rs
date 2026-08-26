//! Authenticated transport for the Cognitive Coordination experiment.
//! Candidate nodes may come from a Coordination Mesh discovery provider or
//! from the legacy explicit peer topology. Discovery and heartbeat failure
//! never gate local Runtime startup.

use super::cognitive_coordination_discovery::{
    normalize_base_url, provider_from_spec, CoordinationDiscoveryProvider,
};
use super::cognitive_coordination_identity::{
    verify_identity_signature, CoordinationNodeIdentity, CoordinationTrustStore,
};
use super::cognitive_coordination_sdk::{CognitiveCoordinationBackend, CoordinatedEvaluationInput};
use super::{cognitive_coordination as domain, ExperimentalFeaturePermit, COGNITIVE_COORDINATION};
use crate::config::{
    CognitiveCoordinationConfig, CognitiveCoordinationParticipantConfig,
    CognitiveCoordinationPeerConfig,
};
use crate::memory::{
    NewWorkAssignment, WorkAssignmentCreateResult, WorkAssignmentMutation,
    WorkAssignmentMutationResult, WorkAssignmentRecord, WorkAssignmentStatus, WorkAssignmentStore,
};
use async_trait::async_trait;
use base64::Engine as _;
use domain::{
    CognitiveEvaluationCoordinator, CognitiveEvaluationRequest, CognitiveEvaluationTransport,
    CoordinationError, CoordinationResult, DeclaredRelationGraphBuilder, EvaluationAssignment,
    ParticipantDescriptor, PreserveAlternativesSettlement, ProjectionSnapshot, ProposalDraft,
    RoutingConstraints, SettlementPolicyRef, UnionCommitIntent, UnionCommitReceipt, UnionCommitter,
    EXPERIMENT_SPEC_VERSION,
};
use ring::hmac;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

type DynError = Box<dyn std::error::Error + Send + Sync>;

pub const HANDSHAKE_PATH: &str = "/api/experimental/cognitive-coordination/handshake";
pub const IDENTITY_PATH: &str = "/api/experimental/cognitive-coordination/identity";
pub const PROJECTION_PATH: &str = "/api/experimental/cognitive-coordination/projection";
pub const EVALUATE_PATH: &str = "/api/experimental/cognitive-coordination/evaluate";
pub const CANCEL_PATH: &str = "/api/experimental/cognitive-coordination/cancel";
const HMAC_AUTH_SPEC_VERSION: &str = "morphz-cognitive-coordination-auth/0.1";
const IDENTITY_AUTH_SPEC_VERSION: &str = "morphz-cognitive-coordination-ed25519/0.1";
pub const COORDINATION_ASSIGNMENT_KIND: &str = "cognitive_coordination/evaluation";
pub const COORDINATION_ASSIGNMENT_COORDINATOR_ROLE: &str = "coordinator";
pub const COORDINATION_ASSIGNMENT_PARTICIPANT_ROLE: &str = "participant";
static ENVELOPE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthenticatedEnvelope<T> {
    pub auth_spec_version: String,
    pub authority_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_key: Option<String>,
    pub issued_at_unix: i64,
    pub nonce: String,
    pub payload: T,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandshakeRequest {
    /// Empty in Coordination Mesh discovery mode because the remote Authority
    /// is learned from its signed identity.
    pub expected_authority_id: String,
    /// The sender's endpoint after it has identified itself in the shared Mesh
    /// source. A receiver may pin this signed identity only when the endpoint
    /// is also present in its own operator-declared Mesh.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender_endpoint: Option<String>,
    pub protocol_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandshakeAdvertisement {
    pub protocol_version: String,
    pub supported_operations: Vec<String>,
    pub participant: ParticipantDescriptor,
    pub issued_at: chrono::DateTime<chrono::Utc>,
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdentityAdvertisement {
    pub protocol_version: String,
    pub authority_id: String,
    pub issued_at: chrono::DateTime<chrono::Utc>,
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectionRequest {
    pub request_id: String,
    pub target_authority_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteEvaluationRequest {
    pub assignment: EvaluationAssignment,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteEvaluationResponse {
    pub draft: ProposalDraft,
    pub effective_model: domain::EvaluationModelRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CancelEvaluationRequest {
    pub assignment_id: String,
    pub target_authority_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CancelEvaluationResponse {
    pub assignment_id: String,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CoordinationPeerStatus {
    pub authority_id: String,
    pub base_url: String,
    pub enabled: bool,
    pub healthy: bool,
    pub latency_ms: Option<u64>,
    pub participant: Option<ParticipantDescriptor>,
    pub error: Option<String>,
    pub checked_at: chrono::DateTime<chrono::Utc>,
}

/// Process-scoped network service shared by the model-facing backend and the
/// Dashboard status surface. Secrets remain environment references in config.
pub struct CognitiveCoordinationNetworkService {
    config: CognitiveCoordinationConfig,
    client: reqwest::Client,
    discovery: Option<Arc<dyn CoordinationDiscoveryProvider>>,
    identity: Option<Arc<CoordinationNodeIdentity>>,
    trust_store: Option<Arc<CoordinationTrustStore>>,
    learned_routes: Arc<dashmap::DashMap<String, String>>,
    local_endpoint: Arc<RwLock<Option<String>>>,
    peer_statuses: Arc<RwLock<Vec<CoordinationPeerStatus>>>,
    accepted_nonces: Arc<Mutex<HashMap<String, i64>>>,
    assignment_store: Option<Arc<dyn WorkAssignmentStore>>,
    active_assignments: dashmap::DashMap<String, String>,
    heartbeat_started: AtomicBool,
}

impl CognitiveCoordinationNetworkService {
    pub fn new(
        permit: ExperimentalFeaturePermit,
        config: CognitiveCoordinationConfig,
    ) -> Result<Self, DynError> {
        Self::new_inner(permit, config, None, None)
    }

    pub fn new_with_secret_store(
        permit: ExperimentalFeaturePermit,
        config: CognitiveCoordinationConfig,
        secret_store: &crate::secret_store::SecretStore,
    ) -> Result<Self, DynError> {
        Self::new_inner(permit, config, Some(secret_store), None)
    }

    fn new_inner(
        permit: ExperimentalFeaturePermit,
        mut config: CognitiveCoordinationConfig,
        secret_store: Option<&crate::secret_store::SecretStore>,
        trust_path_override: Option<PathBuf>,
    ) -> Result<Self, DynError> {
        assert!(permit.permits(COGNITIVE_COORDINATION));
        let discovery = config.mesh.as_deref().map(provider_from_spec).transpose()?;
        let (identity, trust_store) = if discovery.is_some() {
            let secret_store = secret_store.ok_or(
                "Coordination Mesh requires the Runtime Secret Store for its node identity",
            )?;
            let identity = Arc::new(CoordinationNodeIdentity::load_or_create(secret_store)?);
            let participant = config
                .participant
                .get_or_insert_with(CognitiveCoordinationParticipantConfig::default);
            participant.authority_id = identity.authority_id().to_string();
            let trust_path = trust_path_override
                .or_else(|| crate::config::host_state_path("coordination-mesh-trust.json"))
                .ok_or("cannot determine Morphz home for Coordination Mesh trust state")?;
            (
                Some(identity),
                Some(Arc::new(CoordinationTrustStore::load(trust_path)?)),
            )
        } else {
            (None, None)
        };
        validate_config(&config)?;
        let client = crate::http_transport::client_builder(
            crate::http_transport::HttpProxyScope::Coordination,
        )
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(config.request_timeout_secs.max(1)))
        .build()?;
        Ok(Self {
            config,
            client,
            discovery,
            identity,
            trust_store,
            learned_routes: Arc::new(dashmap::DashMap::new()),
            local_endpoint: Arc::new(RwLock::new(None)),
            peer_statuses: Arc::new(RwLock::new(Vec::new())),
            accepted_nonces: Arc::new(Mutex::new(HashMap::new())),
            assignment_store: None,
            active_assignments: dashmap::DashMap::new(),
            heartbeat_started: AtomicBool::new(false),
        })
    }

    #[cfg(test)]
    fn new_with_test_state(
        permit: ExperimentalFeaturePermit,
        config: CognitiveCoordinationConfig,
        secret_store: &crate::secret_store::SecretStore,
        trust_path: PathBuf,
    ) -> Result<Self, DynError> {
        Self::new_inner(permit, config, Some(secret_store), Some(trust_path))
    }

    pub fn config(&self) -> &CognitiveCoordinationConfig {
        &self.config
    }

    pub fn with_assignment_store(mut self, store: Arc<dyn WorkAssignmentStore>) -> Self {
        self.assignment_store = Some(store);
        self
    }

    pub fn participant_config(&self) -> Result<&CognitiveCoordinationParticipantConfig, DynError> {
        self.config
            .participant
            .as_ref()
            .ok_or_else(|| "cognitive coordination participant is not configured".into())
    }

    pub fn request_timeout(&self) -> Duration {
        Duration::from_secs(self.config.request_timeout_secs.max(1))
    }

    pub fn handshake_timeout(&self) -> Duration {
        Duration::from_secs(self.config.handshake_timeout_secs.max(1))
    }

    pub fn peer(&self, authority_id: &str) -> Option<CognitiveCoordinationPeerConfig> {
        if let Some(peer) = self
            .config
            .peers
            .iter()
            .find(|peer| peer.enabled && peer.authority_id == authority_id)
        {
            return Some(peer.clone());
        }
        self.learned_routes
            .get(authority_id)
            .map(|base_url| CognitiveCoordinationPeerConfig {
                authority_id: authority_id.to_string(),
                base_url: base_url.value().clone(),
                token_env: String::new(),
                enabled: true,
            })
    }

    pub fn local_authority_id(&self) -> Result<&str, DynError> {
        Ok(self.participant_config()?.authority_id.as_str())
    }

    pub fn assignment_record_id(
        &self,
        external_id: &str,
        role: &str,
        context_id: &str,
    ) -> Result<String, DynError> {
        let authority_id = self.local_authority_id()?;
        let mut digest = Sha256::new();
        for value in [authority_id, context_id, role, external_id] {
            digest.update((value.len() as u64).to_be_bytes());
            digest.update(value.as_bytes());
        }
        let digest = digest.finalize();
        Ok(format!(
            "coord-assignment-{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&digest[..18])
        ))
    }

    pub async fn begin_assignment(
        &self,
        assignment: &EvaluationAssignment,
        host_agent_id: &str,
        host_context_id: &str,
        host_session_id: &str,
        role: &str,
        counterparty_id: &str,
    ) -> Result<Option<WorkAssignmentCreateResult>, DynError> {
        let Some(store) = self.assignment_store.as_ref() else {
            return Ok(None);
        };
        let id = self.assignment_record_id(&assignment.assignment_id, role, host_context_id)?;
        let summary = match role {
            COORDINATION_ASSIGNMENT_COORDINATOR_ROLE => format!(
                "Coordinate '{}' with Authority {}",
                assignment.question, assignment.participant.authority_id
            ),
            COORDINATION_ASSIGNMENT_PARTICIPANT_ROLE => format!(
                "Evaluate '{}' for Authority {}",
                assignment.question, counterparty_id
            ),
            _ => format!("Cognitive Evaluation: {}", assignment.question),
        };
        let lease_duration = chrono::Duration::from_std(self.request_timeout())
            .map_err(|_| "coordination request timeout exceeds the supported lease range")?;
        let lease_expires_at = chrono::Utc::now()
            .checked_add_signed(lease_duration)
            .ok_or("coordination Assignment lease deadline overflowed")?;
        Ok(Some(
            store
                .create_work_assignment(NewWorkAssignment {
                    id,
                    kind: COORDINATION_ASSIGNMENT_KIND.to_string(),
                    external_id: assignment.assignment_id.clone(),
                    agent_id: host_agent_id.to_string(),
                    context_id: host_context_id.to_string(),
                    session_id: host_session_id.to_string(),
                    role: role.to_string(),
                    request_id: Some(assignment.request_id.clone()),
                    objective_id: Some(assignment.objective_id.clone()),
                    counterparty_id: Some(counterparty_id.to_string()),
                    summary,
                    input: serde_json::to_value(assignment)?,
                    status: WorkAssignmentStatus::Running,
                    lease_expires_at,
                })
                .await?,
        ))
    }

    pub async fn transition_assignment(
        &self,
        assignment: Option<WorkAssignmentRecord>,
        status: WorkAssignmentStatus,
        output: Option<Value>,
        status_reason: Option<String>,
    ) -> Result<Option<WorkAssignmentRecord>, DynError> {
        let Some(mut current) = assignment else {
            return Ok(None);
        };
        let Some(store) = self.assignment_store.as_ref() else {
            return Ok(Some(current));
        };
        if current.status.is_terminal() {
            return Ok(Some(current));
        }
        for _ in 0..3 {
            match store
                .update_work_assignment(
                    &current.id,
                    WorkAssignmentMutation {
                        expected_revision: current.revision,
                        status,
                        output: output.clone(),
                        status_reason: status_reason.clone(),
                    },
                )
                .await?
            {
                WorkAssignmentMutationResult::Updated(updated) => return Ok(Some(updated)),
                WorkAssignmentMutationResult::Conflict(latest) if latest.status.is_terminal() => {
                    return Ok(Some(latest));
                }
                WorkAssignmentMutationResult::Conflict(latest) => current = latest,
                WorkAssignmentMutationResult::NotFound => {
                    return Err(format!(
                        "Work Assignment '{}' disappeared during a lifecycle transition",
                        current.id
                    )
                    .into());
                }
            }
        }
        Err(format!(
            "Work Assignment '{}' changed concurrently too many times",
            current.id
        )
        .into())
    }

    pub async fn list_assignments(
        &self,
        include_terminal: bool,
        limit: usize,
    ) -> Result<Vec<WorkAssignmentRecord>, DynError> {
        let Some(store) = self.assignment_store.as_ref() else {
            return Ok(Vec::new());
        };
        let Some(participant) = self.config.participant.as_ref() else {
            return Ok(Vec::new());
        };
        store
            .list_agent_work_assignments(
                &participant.agent_id,
                Some(COORDINATION_ASSIGNMENT_KIND),
                include_terminal,
                limit,
            )
            .await
    }

    /// Close nonterminal records only after their persisted execution lease
    /// has elapsed. A shared PostgreSQL Store may be used by multiple Runtime
    /// processes, so startup must never interrupt fresh work merely because it
    /// belongs to another healthy worker. The heartbeat repeats this sweep,
    /// which eventually closes work abandoned by a crashed process.
    pub async fn recover_interrupted_assignments(&self) -> Result<usize, DynError> {
        let now = chrono::Utc::now();
        let assignments = self
            .list_assignments(false, 10_000)
            .await?
            .into_iter()
            .filter(|assignment| assignment_has_expired(assignment, now))
            .collect::<Vec<_>>();
        let mut interrupted = 0;
        for assignment in assignments {
            let transitioned = self
                .transition_assignment(
                    Some(assignment),
                    WorkAssignmentStatus::Interrupted,
                    None,
                    Some(
                        "Runtime restarted before the coordinated Evaluation completed".to_string(),
                    ),
                )
                .await?;
            if transitioned
                .as_ref()
                .is_some_and(|record| record.status == WorkAssignmentStatus::Interrupted)
            {
                interrupted += 1;
            }
        }
        Ok(interrupted)
    }

    pub async fn participant_assignment(
        &self,
        external_id: &str,
    ) -> Result<Option<WorkAssignmentRecord>, DynError> {
        let Some(store) = self.assignment_store.as_ref() else {
            return Ok(None);
        };
        let participant = self.participant_config()?;
        let id = self.assignment_record_id(
            external_id,
            COORDINATION_ASSIGNMENT_PARTICIPANT_ROLE,
            &participant.context_id,
        )?;
        store.get_work_assignment(&id).await
    }

    pub fn register_active_assignment(&self, assignment_id: &str, session_id: &str) {
        self.active_assignments
            .insert(assignment_id.to_string(), session_id.to_string());
    }

    pub fn active_assignment_session(&self, assignment_id: &str) -> Option<String> {
        self.active_assignments
            .get(assignment_id)
            .map(|value| value.value().clone())
    }

    pub fn finish_active_assignment(&self, assignment_id: &str) {
        self.active_assignments.remove(assignment_id);
    }

    pub fn active_assignment_count(&self) -> usize {
        self.active_assignments.len()
    }

    pub fn verify_incoming<T: Serialize>(
        &self,
        envelope: &AuthenticatedEnvelope<T>,
    ) -> Result<(), DynError> {
        self.verify_incoming_with_trust(envelope, true)
    }

    pub async fn verify_incoming_handshake<T: Serialize>(
        &self,
        envelope: &AuthenticatedEnvelope<T>,
        sender_endpoint: Option<&str>,
    ) -> Result<(), DynError> {
        self.verify_incoming_with_trust(envelope, false)?;
        if self.discovery.is_some() {
            let sender_endpoint = sender_endpoint
                .ok_or("Coordination Mesh handshake requires the sender's Mesh endpoint")?;
            let sender_endpoint = normalize_base_url(sender_endpoint)?;
            if !self.mesh_contains_endpoint(&sender_endpoint).await? {
                return Err(format!(
                    "Coordination Mesh sender endpoint '{sender_endpoint}' is not present in the configured Mesh"
                )
                .into());
            }
            let public_key = envelope
                .public_key
                .as_deref()
                .ok_or("Coordination Mesh handshake is missing the sender public key")?;
            let already_pinned = self
                .trust_store()?
                .public_key(&envelope.authority_id)?
                .as_deref()
                == Some(public_key)
                && self
                    .trust_store()?
                    .endpoint(&envelope.authority_id)?
                    .as_deref()
                    == Some(sender_endpoint.as_str());
            if !already_pinned {
                // A signed endpoint claim is not proof that the caller
                // controls that endpoint. Resolve its public identity back
                // through the operator-authorized Mesh before pinning it.
                let claimed_peer = CognitiveCoordinationPeerConfig {
                    authority_id: envelope.authority_id.clone(),
                    base_url: sender_endpoint.clone(),
                    token_env: String::new(),
                    enabled: true,
                };
                tokio::time::timeout(self.handshake_timeout(), self.probe_identity(&claimed_peer))
                    .await
                    .map_err(|_| "Coordination Mesh reverse identity probe timed out")??;
            }
            self.trust_store()?.pin_or_verify(
                &sender_endpoint,
                &envelope.authority_id,
                public_key,
            )?;
            self.learned_routes
                .insert(envelope.authority_id.clone(), sender_endpoint);
        }
        Ok(())
    }

    pub fn mesh_enabled(&self) -> bool {
        self.discovery.is_some()
    }

    pub fn current_local_endpoint(&self) -> Option<String> {
        self.local_endpoint
            .read()
            .ok()
            .and_then(|endpoint| endpoint.clone())
    }

    fn trust_store(&self) -> Result<&CoordinationTrustStore, DynError> {
        self.trust_store
            .as_deref()
            .ok_or_else(|| "Coordination Mesh trust store is not configured".into())
    }

    async fn mesh_contains_endpoint(&self, endpoint: &str) -> Result<bool, DynError> {
        let Some(discovery) = self.discovery.as_deref() else {
            return Ok(false);
        };
        for candidate in discovery.resolve().await? {
            if normalize_base_url(&candidate.base_url)? == endpoint {
                return Ok(true);
            }
        }
        Ok(false)
    }

    async fn candidate_peers(&self) -> Result<Vec<CognitiveCoordinationPeerConfig>, DynError> {
        let Some(discovery) = self.discovery.as_deref() else {
            return Ok(self.config.peers.clone());
        };
        let endpoints = discovery.resolve().await?;
        let mut peers = Vec::with_capacity(endpoints.len());
        for endpoint in endpoints {
            let base_url = normalize_base_url(&endpoint.base_url)?;
            let authority_id = if self.current_local_endpoint().as_deref() == Some(&base_url) {
                self.local_authority_id()?.to_string()
            } else {
                self.trust_store()?
                    .authority_for_endpoint(&base_url)?
                    .unwrap_or_default()
            };
            peers.push(CognitiveCoordinationPeerConfig {
                authority_id,
                base_url,
                token_env: String::new(),
                enabled: true,
            });
        }
        Ok(peers)
    }

    fn verify_incoming_with_trust<T: Serialize>(
        &self,
        envelope: &AuthenticatedEnvelope<T>,
        require_trust: bool,
    ) -> Result<(), DynError> {
        match envelope.auth_spec_version.as_str() {
            IDENTITY_AUTH_SPEC_VERSION if self.identity.is_some() => {
                let public_key = envelope
                    .public_key
                    .as_deref()
                    .ok_or("Coordination Mesh envelope is missing its public key")?;
                verify_identity_envelope(envelope, public_key)?;
                if require_trust {
                    let trusted = self
                        .trust_store()?
                        .public_key(&envelope.authority_id)?
                        .ok_or_else(|| {
                            format!(
                                "Coordination Mesh Authority '{}' has not completed mutual discovery",
                                envelope.authority_id
                            )
                        })?;
                    if trusted != public_key {
                        return Err("Coordination Mesh Authority public key changed".into());
                    }
                }
            }
            HMAC_AUTH_SPEC_VERSION if self.identity.is_none() => {
                let secret = self.secret_for_authority(&envelope.authority_id)?;
                verify_signature(envelope, secret.as_bytes())?;
            }
            _ => return Err("unsupported Cognitive Coordination authentication version".into()),
        }
        let now = chrono::Utc::now().timestamp();
        let skew = (now - envelope.issued_at_unix).unsigned_abs();
        if skew > self.config.max_clock_skew_secs.max(1) {
            return Err(
                "coordination envelope timestamp is outside the accepted clock skew".into(),
            );
        }
        let mut nonces = self
            .accepted_nonces
            .lock()
            .map_err(|_| "coordination nonce lock is poisoned")?;
        let cutoff = now - i64::try_from(self.config.max_clock_skew_secs.max(1) * 2)?;
        nonces.retain(|_, issued_at| *issued_at >= cutoff);
        if nonces
            .insert(envelope.nonce.clone(), envelope.issued_at_unix)
            .is_some()
        {
            return Err("replayed coordination envelope nonce".into());
        }
        Ok(())
    }

    pub fn sign_response_to<T: Serialize + Clone>(
        &self,
        recipient_authority_id: &str,
        payload: T,
    ) -> Result<AuthenticatedEnvelope<T>, DynError> {
        if let Some(identity) = self.identity.as_deref() {
            return signed_identity_envelope(identity, payload);
        }
        let authority = self.local_authority_id()?.to_string();
        let secret = self.secret_for_authority(recipient_authority_id)?;
        signed_envelope(authority, payload, secret.as_bytes())
    }

    pub fn identity_advertisement(
        &self,
    ) -> Result<AuthenticatedEnvelope<IdentityAdvertisement>, DynError> {
        let identity = self
            .identity
            .as_deref()
            .ok_or("public node identity is available only in Coordination Mesh mode")?;
        let issued_at = chrono::Utc::now();
        signed_identity_envelope(
            identity,
            IdentityAdvertisement {
                protocol_version: EXPERIMENT_SPEC_VERSION.to_string(),
                authority_id: identity.authority_id().to_string(),
                issued_at,
                expires_at: issued_at
                    + chrono::Duration::seconds(i64::try_from(self.config.handshake_ttl_secs)?),
            },
        )
    }

    async fn probe_identity(
        &self,
        peer: &CognitiveCoordinationPeerConfig,
    ) -> Result<IdentityAdvertisement, DynError> {
        let url = format!("{}{}", peer.base_url.trim_end_matches('/'), IDENTITY_PATH);
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|error| coordination_transport_error(&peer.base_url, error.to_string()))?;
        let status = response.status();
        let bytes = response.bytes().await?;
        if !status.is_success() {
            return Err(
                coordination_http_error(&peer.base_url, "identity probe", status, &bytes).into(),
            );
        }
        let envelope: AuthenticatedEnvelope<IdentityAdvertisement> =
            serde_json::from_slice(&bytes)?;
        self.verify_peer_response(peer, &envelope)?;
        if envelope.payload.protocol_version != EXPERIMENT_SPEC_VERSION
            || envelope.payload.authority_id != envelope.authority_id
            || envelope.payload.expires_at <= chrono::Utc::now()
        {
            return Err("Coordination Mesh identity advertisement is invalid or expired".into());
        }
        let endpoint = normalize_base_url(&peer.base_url)?;
        if envelope.authority_id == self.local_authority_id()? {
            if let Ok(mut local) = self.local_endpoint.write() {
                *local = Some(endpoint);
            }
        } else {
            self.learned_routes
                .insert(envelope.authority_id.clone(), endpoint);
        }
        Ok(envelope.payload)
    }

    async fn probe_mesh_identities(&self, peers: Vec<CognitiveCoordinationPeerConfig>) {
        let mut tasks = tokio::task::JoinSet::new();
        for peer in peers.into_iter().filter(|peer| peer.enabled) {
            let service = self.clone_for_task();
            tasks.spawn(async move {
                let _ = tokio::time::timeout(
                    service.handshake_timeout(),
                    service.probe_identity(&peer),
                )
                .await;
            });
        }
        while tasks.join_next().await.is_some() {}
    }

    pub async fn handshake_all(&self) -> Vec<CoordinationPeerStatus> {
        let mut peers = match self.candidate_peers().await {
            Ok(peers) => peers,
            Err(error) => {
                return vec![CoordinationPeerStatus {
                    authority_id: "mesh".to_string(),
                    base_url: self
                        .discovery
                        .as_ref()
                        .map(|provider| provider.source_label())
                        .unwrap_or_default(),
                    enabled: true,
                    healthy: false,
                    latency_ms: None,
                    participant: None,
                    error: Some(error.to_string()),
                    checked_at: chrono::Utc::now(),
                }]
            }
        };
        if self.discovery.is_some() {
            self.probe_mesh_identities(peers).await;
            peers = match self.candidate_peers().await {
                Ok(peers) => peers,
                Err(error) => {
                    return vec![CoordinationPeerStatus {
                        authority_id: "mesh".to_string(),
                        base_url: self
                            .discovery
                            .as_ref()
                            .map(|provider| provider.source_label())
                            .unwrap_or_default(),
                        enabled: true,
                        healthy: false,
                        latency_ms: None,
                        participant: None,
                        error: Some(error.to_string()),
                        checked_at: chrono::Utc::now(),
                    }]
                }
            }
        }
        let mut statuses = self.handshake_peers(peers).await;
        statuses.retain(|status| {
            status.participant.as_ref().is_none_or(|participant| {
                participant.authority_id != self.local_authority_id().unwrap_or_default()
            })
        });
        statuses.sort_by(|left, right| left.authority_id.cmp(&right.authority_id));
        statuses
    }

    pub async fn refresh_peer_statuses(&self) -> Vec<CoordinationPeerStatus> {
        let statuses = self.handshake_all().await;
        if let Ok(mut current) = self.peer_statuses.write() {
            *current = statuses.clone();
        }
        statuses
    }

    pub fn peer_status_snapshot(&self) -> Vec<CoordinationPeerStatus> {
        self.peer_statuses
            .read()
            .map(|statuses| statuses.clone())
            .unwrap_or_default()
    }

    /// Start a best-effort health loop. Remote failure is reflected in the
    /// cached peer status and never becomes a local Runtime startup error.
    pub fn start_heartbeat(self: Arc<Self>) {
        if self
            .heartbeat_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        tokio::spawn(async move {
            loop {
                if let Err(error) = self.recover_interrupted_assignments().await {
                    tracing::warn!(
                        error = %error,
                        event_code = "runtime.cognitive_coordination.assignment_expiry_failed",
                        "Expired Cognitive Coordination Assignment recovery failed"
                    );
                }
                self.refresh_peer_statuses().await;
                tokio::time::sleep(Duration::from_secs(
                    self.config.heartbeat_interval_secs.max(1),
                ))
                .await;
            }
        });
    }

    async fn handshake_peers(
        &self,
        peers: Vec<CognitiveCoordinationPeerConfig>,
    ) -> Vec<CoordinationPeerStatus> {
        let mut tasks = tokio::task::JoinSet::new();
        for peer in peers.into_iter().filter(|peer| peer.enabled) {
            let service = self.clone_for_task();
            tasks.spawn(async move {
                let started = std::time::Instant::now();
                let result = match tokio::time::timeout(
                    service.handshake_timeout(),
                    service.handshake(&peer),
                )
                .await
                {
                    Ok(result) => result,
                    Err(_) => Err::<HandshakeAdvertisement, DynError>(
                        format!(
                            "peer handshake exceeded {} seconds",
                            service.config.handshake_timeout_secs
                        )
                        .into(),
                    ),
                };
                let authority_id = result
                    .as_ref()
                    .ok()
                    .map(|advertisement| advertisement.participant.authority_id.clone())
                    .filter(|authority| !authority.is_empty())
                    .unwrap_or_else(|| {
                        if peer.authority_id.is_empty() {
                            peer.base_url.clone()
                        } else {
                            peer.authority_id.clone()
                        }
                    });
                CoordinationPeerStatus {
                    authority_id,
                    base_url: peer.base_url,
                    enabled: peer.enabled,
                    healthy: result.is_ok(),
                    latency_ms: Some(started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64),
                    participant: result.as_ref().ok().map(|value| value.participant.clone()),
                    error: result.err().map(|error| error.to_string()),
                    checked_at: chrono::Utc::now(),
                }
            });
        }
        let mut statuses = Vec::new();
        while let Some(result) = tasks.join_next().await {
            match result {
                Ok(status) => statuses.push(status),
                Err(error) => statuses.push(CoordinationPeerStatus {
                    authority_id: "unknown".to_string(),
                    base_url: String::new(),
                    enabled: true,
                    healthy: false,
                    latency_ms: None,
                    participant: None,
                    error: Some(format!("handshake task failed: {error}")),
                    checked_at: chrono::Utc::now(),
                }),
            }
        }
        statuses
    }

    pub async fn handshake(
        &self,
        peer: &CognitiveCoordinationPeerConfig,
    ) -> Result<HandshakeAdvertisement, DynError> {
        let request = HandshakeRequest {
            expected_authority_id: peer.authority_id.clone(),
            sender_endpoint: self.current_local_endpoint(),
            protocol_version: EXPERIMENT_SPEC_VERSION.to_string(),
        };
        let response: AuthenticatedEnvelope<HandshakeAdvertisement> =
            self.post(peer, HANDSHAKE_PATH, request).await?;
        self.verify_peer_response(peer, &response)?;
        if response.payload.participant.authority_id != response.authority_id
            || (!peer.authority_id.is_empty()
                && response.payload.participant.authority_id != peer.authority_id)
            || response.payload.protocol_version != EXPERIMENT_SPEC_VERSION
            || response.payload.expires_at <= chrono::Utc::now()
        {
            return Err("peer handshake identity, version, or lease is invalid".into());
        }
        response.payload.participant.validate()?;
        let normalized = normalize_base_url(&peer.base_url)?;
        if response.payload.participant.authority_id == self.local_authority_id()? {
            if let Ok(mut local) = self.local_endpoint.write() {
                *local = Some(normalized);
            }
        } else {
            self.learned_routes.insert(
                response.payload.participant.authority_id.clone(),
                normalized,
            );
        }
        Ok(response.payload)
    }

    pub async fn project_remote(
        &self,
        participant: &ParticipantDescriptor,
        request_id: &str,
    ) -> CoordinationResult<ProjectionSnapshot> {
        let peer = self.peer(&participant.authority_id).ok_or_else(|| {
            CoordinationError::Transport(format!(
                "no static peer route for Authority '{}'",
                participant.authority_id
            ))
        })?;
        let response: AuthenticatedEnvelope<ProjectionSnapshot> = self
            .post(
                &peer,
                PROJECTION_PATH,
                ProjectionRequest {
                    request_id: request_id.to_string(),
                    target_authority_id: participant.authority_id.clone(),
                },
            )
            .await
            .map_err(|error| CoordinationError::Transport(error.to_string()))?;
        self.verify_peer_response(&peer, &response)
            .map_err(|error| CoordinationError::Transport(error.to_string()))?;
        Ok(response.payload)
    }

    pub async fn evaluate_remote(
        &self,
        assignment: &EvaluationAssignment,
    ) -> CoordinationResult<ProposalDraft> {
        let peer = self
            .peer(&assignment.participant.authority_id)
            .ok_or_else(|| {
                CoordinationError::Transport(format!(
                    "no static peer route for Authority '{}'",
                    assignment.participant.authority_id
                ))
            })?;
        let response: AuthenticatedEnvelope<RemoteEvaluationResponse> = match self
            .post(
                &peer,
                EVALUATE_PATH,
                RemoteEvaluationRequest {
                    assignment: assignment.clone(),
                },
            )
            .await
        {
            Ok(response) => response,
            Err(error) => {
                // Best-effort remote cancellation prevents a timed-out
                // coordinator from leaving an expensive model request alive.
                let _ = self.cancel_remote(assignment).await;
                return Err(CoordinationError::Transport(error.to_string()));
            }
        };
        self.verify_peer_response(&peer, &response)
            .map_err(|error| CoordinationError::Transport(error.to_string()))?;
        if response.payload.effective_model != assignment.model {
            return Err(CoordinationError::Transport(format!(
                "Authority '{}' executed a model policy different from its immutable Assignment",
                assignment.participant.authority_id
            )));
        }
        Ok(response.payload.draft)
    }

    pub async fn cancel_remote(&self, assignment: &EvaluationAssignment) -> Result<bool, DynError> {
        let peer = self
            .peer(&assignment.participant.authority_id)
            .ok_or("no static peer route for cancellation")?;
        let response: AuthenticatedEnvelope<CancelEvaluationResponse> = self
            .post(
                &peer,
                CANCEL_PATH,
                CancelEvaluationRequest {
                    assignment_id: assignment.assignment_id.clone(),
                    target_authority_id: assignment.participant.authority_id.clone(),
                },
            )
            .await?;
        self.verify_peer_response(&peer, &response)?;
        Ok(response.payload.cancelled)
    }

    async fn post<Request, Response>(
        &self,
        peer: &CognitiveCoordinationPeerConfig,
        path: &str,
        payload: Request,
    ) -> Result<AuthenticatedEnvelope<Response>, DynError>
    where
        Request: Serialize + Clone,
        Response: DeserializeOwned,
    {
        let envelope = if let Some(identity) = self.identity.as_deref() {
            signed_identity_envelope(identity, payload)?
        } else {
            let secret = peer_secret(peer)?;
            signed_envelope(
                self.local_authority_id()?.to_string(),
                payload,
                secret.as_bytes(),
            )?
        };
        let url = format!("{}{}", peer.base_url.trim_end_matches('/'), path);
        let response = self
            .client
            .post(url)
            .json(&envelope)
            .send()
            .await
            .map_err(|error| coordination_transport_error(&peer.base_url, error.to_string()))?;
        let status = response.status();
        let bytes = response.bytes().await?;
        if !status.is_success() {
            return Err(coordination_http_error(&peer.base_url, "peer", status, &bytes).into());
        }
        Ok(serde_json::from_slice(&bytes)?)
    }

    fn verify_peer_response<T: Serialize>(
        &self,
        peer: &CognitiveCoordinationPeerConfig,
        envelope: &AuthenticatedEnvelope<T>,
    ) -> Result<(), DynError> {
        if !peer.authority_id.is_empty() && envelope.authority_id != peer.authority_id {
            return Err("coordination response Authority mismatch".into());
        }
        let now = chrono::Utc::now().timestamp();
        if (now - envelope.issued_at_unix).unsigned_abs() > self.config.max_clock_skew_secs.max(1) {
            return Err("coordination response timestamp is outside accepted clock skew".into());
        }
        match envelope.auth_spec_version.as_str() {
            IDENTITY_AUTH_SPEC_VERSION if self.identity.is_some() => {
                let public_key = envelope
                    .public_key
                    .as_deref()
                    .ok_or("Coordination Mesh response is missing its public key")?;
                verify_identity_envelope(envelope, public_key)?;
                let endpoint = normalize_base_url(&peer.base_url)?;
                if envelope.authority_id != self.local_authority_id()? {
                    self.trust_store()?.pin_or_verify(
                        &endpoint,
                        &envelope.authority_id,
                        public_key,
                    )?;
                }
                Ok(())
            }
            HMAC_AUTH_SPEC_VERSION if self.identity.is_none() => {
                let secret = peer_secret(peer)?;
                verify_signature(envelope, secret.as_bytes())
            }
            _ => Err("coordination response authentication version mismatch".into()),
        }
    }

    fn local_secret(&self) -> Result<String, DynError> {
        let variable = self.participant_config()?.token_env.trim();
        read_nonempty_secret(variable)
    }

    fn secret_for_authority(&self, authority_id: &str) -> Result<String, DynError> {
        if self.local_authority_id()? == authority_id {
            return self.local_secret();
        }
        let peer = self.peer(authority_id).ok_or_else(|| {
            format!("Authority '{authority_id}' is not in the static coordination topology")
        })?;
        peer_secret(&peer)
    }

    fn clone_for_task(&self) -> Self {
        Self {
            config: self.config.clone(),
            client: self.client.clone(),
            discovery: self.discovery.clone(),
            identity: self.identity.clone(),
            trust_store: self.trust_store.clone(),
            learned_routes: Arc::clone(&self.learned_routes),
            local_endpoint: Arc::clone(&self.local_endpoint),
            peer_statuses: Arc::clone(&self.peer_statuses),
            accepted_nonces: Arc::clone(&self.accepted_nonces),
            assignment_store: self.assignment_store.clone(),
            active_assignments: dashmap::DashMap::new(),
            heartbeat_started: AtomicBool::new(false),
        }
    }
}

fn coordination_transport_error(base_url: &str, message: String) -> String {
    let hint = crate::http_transport::proxy_failure_hint(
        crate::http_transport::HttpProxyScope::Coordination,
        base_url,
    )
    .map(|hint| format!("; {hint}"))
    .unwrap_or_default();
    format!("coordination request to '{base_url}' failed: {message}{hint}")
}

fn coordination_http_error(
    base_url: &str,
    operation: &str,
    status: reqwest::StatusCode,
    bytes: &[u8],
) -> String {
    let message = serde_json::from_slice::<Value>(bytes)
        .ok()
        .and_then(|value| {
            value.get("error").and_then(|error| {
                error.as_str().map(str::to_string).or_else(|| {
                    error
                        .get("message")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
            })
        })
        .unwrap_or_else(|| String::from_utf8_lossy(bytes).trim().to_string());
    let detail = if message.is_empty() {
        format!("{operation} returned HTTP {status}")
    } else {
        format!("{operation} returned HTTP {status}: {message}")
    };
    if matches!(
        status,
        reqwest::StatusCode::BAD_GATEWAY | reqwest::StatusCode::GATEWAY_TIMEOUT
    ) {
        return coordination_transport_error(base_url, detail);
    }
    detail
}

struct NetworkEvaluationTransport {
    service: Arc<CognitiveCoordinationNetworkService>,
    host_agent_id: String,
    host_context_id: String,
    host_session_id: String,
}

#[async_trait]
impl CognitiveEvaluationTransport for NetworkEvaluationTransport {
    async fn project(
        &self,
        participant: &ParticipantDescriptor,
        request: &CognitiveEvaluationRequest,
    ) -> CoordinationResult<ProjectionSnapshot> {
        self.service
            .project_remote(participant, &request.request_id)
            .await
    }

    async fn evaluate(
        &self,
        assignment: &EvaluationAssignment,
    ) -> CoordinationResult<ProposalDraft> {
        let start = self
            .service
            .begin_assignment(
                assignment,
                &self.host_agent_id,
                &self.host_context_id,
                &self.host_session_id,
                COORDINATION_ASSIGNMENT_COORDINATOR_ROLE,
                &assignment.participant.authority_id,
            )
            .await
            .map_err(|error| CoordinationError::Transport(error.to_string()))?;
        if let Some(existing) = start.as_ref().filter(|result| !result.created) {
            if existing.record.status == WorkAssignmentStatus::Succeeded {
                if let Some(output) = existing.record.output.clone() {
                    return serde_json::from_value(output).map_err(|error| {
                        CoordinationError::Transport(format!(
                            "persisted Assignment '{}' has an invalid Proposal result: {error}",
                            existing.record.external_id
                        ))
                    });
                }
            }
            return Err(CoordinationError::Transport(format!(
                "Assignment '{}' already exists with status '{}' and cannot execute twice",
                existing.record.external_id,
                existing.record.status.as_str(),
            )));
        }
        let record = start.map(|result| result.record);
        match self.service.evaluate_remote(assignment).await {
            Ok(draft) => {
                let persisted = self
                    .service
                    .transition_assignment(
                        record,
                        WorkAssignmentStatus::Succeeded,
                        serde_json::to_value(&draft).ok(),
                        None,
                    )
                    .await
                    .map_err(|error| CoordinationError::Transport(error.to_string()))?;
                if let Some(record) = persisted {
                    if record.status != WorkAssignmentStatus::Succeeded {
                        return Err(CoordinationError::Transport(format!(
                            "Assignment '{}' completed remotely after its durable status became '{}'",
                            record.external_id,
                            record.status.as_str(),
                        )));
                    }
                }
                Ok(draft)
            }
            Err(error) => {
                self.service
                    .transition_assignment(
                        record,
                        WorkAssignmentStatus::Failed,
                        None,
                        Some(error.to_string()),
                    )
                    .await
                    .map_err(|store_error| {
                        CoordinationError::Transport(format!(
                            "{error}; additionally failed to persist Assignment outcome: {store_error}"
                        ))
                    })?;
                Err(error)
            }
        }
    }
}

struct CommitDisabled;

#[async_trait]
impl UnionCommitter for CommitDisabled {
    async fn commit(
        &self,
        _authority: &domain::AuthorityDomain,
        _intent: &UnionCommitIntent,
        _certificate: &domain::CommitCertificate,
    ) -> CoordinationResult<UnionCommitReceipt> {
        Err(CoordinationError::Commit(
            "coordinate.evaluate never commits Union Mind; use an explicit commit operation"
                .to_string(),
        ))
    }
}

#[async_trait]
impl CognitiveCoordinationBackend for Arc<CognitiveCoordinationNetworkService> {
    async fn evaluate(
        &self,
        input: CoordinatedEvaluationInput,
        invocation: super::cognitive_coordination_sdk::CognitiveCoordinationInvocation,
    ) -> Result<Value, DynError> {
        let statuses = self.handshake_all().await;
        let participants = statuses
            .iter()
            .filter_map(|status| status.participant.clone())
            .collect::<Vec<_>>();
        let advertised_authorities = participants
            .iter()
            .map(|participant| participant.authority_id.as_str())
            .collect::<BTreeSet<_>>();
        if let Some(unknown) = input
            .participant_models
            .iter()
            .find(|item| !advertised_authorities.contains(item.authority_id.as_str()))
        {
            return Err(format!(
                "model override names Authority '{}', but it has no valid handshake lease",
                unknown.authority_id
            )
            .into());
        }
        let minimum = input.min_participants.unwrap_or(1);
        if participants.len() < minimum {
            return Err(format!(
                "only {} paired participants completed handshake, below required minimum {}; status: {}",
                participants.len(),
                minimum,
                serde_json::to_string(&statuses)?
            )
            .into());
        }
        let maximum = input
            .max_participants
            .unwrap_or(participants.len())
            .max(minimum);
        let token_budget = input.token_budget_per_participant.unwrap_or(4_096);
        let request_id = new_request_id();
        let request = CognitiveEvaluationRequest {
            spec_version: EXPERIMENT_SPEC_VERSION.to_string(),
            request_id: request_id.clone(),
            objective_id: input
                .objective_id
                .clone()
                .unwrap_or_else(|| format!("objective-{request_id}")),
            initiator_authority_id: self.local_authority_id()?.to_string(),
            commit_target: None,
            question: input.question,
            shared_input: input.shared_input,
            routing: RoutingConstraints {
                min_participants: minimum,
                max_participants: maximum,
                token_budget_per_participant: token_budget,
                max_total_token_budget: token_budget.saturating_mul(maximum as u64),
                required_capabilities: normalized_set(input.required_capabilities),
                preferred_capabilities: normalized_set(input.preferred_capabilities),
                allowed_authority_ids: BTreeSet::new(),
                model: domain::EvaluationModelRequest {
                    route: input.model_route,
                    reasoning_effort: input.reasoning_effort,
                },
                participant_models: input
                    .participant_models
                    .into_iter()
                    .map(|item| domain::ParticipantModelRequest {
                        authority_id: item.authority_id,
                        model: domain::EvaluationModelRequest {
                            route: item.model_route,
                            reasoning_effort: item.reasoning_effort,
                        },
                    })
                    .collect(),
            },
            settlement_policy: SettlementPolicyRef {
                id: "preserve-alternatives".to_string(),
                version: "0".to_string(),
            },
        };
        let coordinator = CognitiveEvaluationCoordinator::new(
            Arc::new(domain::CapabilityRouter),
            Arc::new(NetworkEvaluationTransport {
                service: Arc::clone(self),
                host_agent_id: self.participant_config()?.agent_id.clone(),
                host_context_id: invocation.context_id.clone(),
                host_session_id: invocation.session_id.clone(),
            }),
            Arc::new(DeclaredRelationGraphBuilder),
            Arc::new(PreserveAlternativesSettlement),
            Arc::new(CommitDisabled),
        );
        let result = coordinator.evaluate(request, participants).await?;
        Ok(json!({
            "operation": "evaluate",
            "initiating_route": {
                "context_id": invocation.context_id,
                "session_id": invocation.session_id,
            },
            "result": result,
            "peer_status": statuses,
            "committed": false,
        }))
    }
}

fn normalized_set(values: Vec<String>) -> BTreeSet<String> {
    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

fn validate_config(config: &CognitiveCoordinationConfig) -> Result<(), DynError> {
    let participant = config
        .participant
        .as_ref()
        .ok_or("experimental.cognitive_coordination.participant is required")?;
    for (field, value) in [
        ("authority_id", participant.authority_id.as_str()),
        ("agent_id", participant.agent_id.as_str()),
        ("context_id", participant.context_id.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(format!("coordination participant {field} must not be empty").into());
        }
    }
    if participant.max_token_budget == 0
        || config.request_timeout_secs == 0
        || config.handshake_timeout_secs == 0
        || config.handshake_ttl_secs == 0
        || config.heartbeat_interval_secs == 0
        || config.max_clock_skew_secs == 0
    {
        return Err("coordination budgets and timeouts must be greater than zero".into());
    }
    if config.mesh.is_none() && participant.token_env.trim().is_empty() {
        return Err("coordination participant token_env must not be empty".into());
    }
    let mut authorities = BTreeSet::new();
    for peer in &config.peers {
        if config.mesh.is_none()
            && (peer.authority_id.trim().is_empty()
                || peer.base_url.trim().is_empty()
                || peer.token_env.trim().is_empty()
                || !authorities.insert(peer.authority_id.clone()))
        {
            return Err(
                "coordination peers require unique Authority ids, URLs, and token env names".into(),
            );
        }
        reqwest::Url::parse(&peer.base_url)?;
    }
    Ok(())
}

fn peer_secret(peer: &CognitiveCoordinationPeerConfig) -> Result<String, DynError> {
    read_nonempty_secret(peer.token_env.trim())
}

fn read_nonempty_secret(variable: &str) -> Result<String, DynError> {
    if variable.is_empty() {
        return Err("coordination secret environment variable name is empty".into());
    }
    let value = std::env::var(variable)
        .map_err(|_| format!("coordination secret environment variable '{variable}' is missing"))?;
    if value.trim().is_empty() {
        return Err(
            format!("coordination secret environment variable '{variable}' is empty").into(),
        );
    }
    Ok(value)
}

fn signed_envelope<T: Serialize + Clone>(
    authority_id: String,
    payload: T,
    secret: &[u8],
) -> Result<AuthenticatedEnvelope<T>, DynError> {
    let issued_at_unix = chrono::Utc::now().timestamp();
    let nonce = format!(
        "coord-{issued_at_unix}-{}",
        ENVELOPE_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let mut envelope = AuthenticatedEnvelope {
        auth_spec_version: HMAC_AUTH_SPEC_VERSION.to_string(),
        authority_id,
        public_key: None,
        issued_at_unix,
        nonce,
        payload,
        signature: String::new(),
    };
    let bytes = signing_bytes(&envelope)?;
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret);
    envelope.signature =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hmac::sign(&key, &bytes).as_ref());
    Ok(envelope)
}

fn signed_identity_envelope<T: Serialize + Clone>(
    identity: &CoordinationNodeIdentity,
    payload: T,
) -> Result<AuthenticatedEnvelope<T>, DynError> {
    let issued_at_unix = chrono::Utc::now().timestamp();
    let nonce = format!(
        "coord-{issued_at_unix}-{}",
        ENVELOPE_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let mut envelope = AuthenticatedEnvelope {
        auth_spec_version: IDENTITY_AUTH_SPEC_VERSION.to_string(),
        authority_id: identity.authority_id().to_string(),
        public_key: Some(identity.public_key().to_string()),
        issued_at_unix,
        nonce,
        payload,
        signature: String::new(),
    };
    envelope.signature = identity.sign(&signing_bytes(&envelope)?);
    Ok(envelope)
}

fn verify_identity_envelope<T: Serialize>(
    envelope: &AuthenticatedEnvelope<T>,
    public_key: &str,
) -> Result<(), DynError> {
    verify_identity_signature(
        &envelope.authority_id,
        public_key,
        &signing_bytes(envelope)?,
        &envelope.signature,
    )
}

fn verify_signature<T: Serialize>(
    envelope: &AuthenticatedEnvelope<T>,
    secret: &[u8],
) -> Result<(), DynError> {
    let signature = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(&envelope.signature)
        .map_err(|_| "coordination envelope signature is not valid base64url")?;
    let bytes = signing_bytes(envelope)?;
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret);
    hmac::verify(&key, &bytes, &signature)
        .map_err(|_| "coordination envelope signature verification failed".into())
}

fn signing_bytes<T: Serialize>(envelope: &AuthenticatedEnvelope<T>) -> Result<Vec<u8>, DynError> {
    Ok(serde_json::to_vec(&(
        envelope.auth_spec_version.as_str(),
        envelope.authority_id.as_str(),
        envelope.public_key.as_deref(),
        envelope.issued_at_unix,
        envelope.nonce.as_str(),
        &envelope.payload,
    ))?)
}

fn new_request_id() -> String {
    let now = chrono::Utc::now().timestamp_micros();
    format!(
        "coordination-{now}-{}",
        ENVELOPE_COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

fn assignment_has_expired(
    assignment: &WorkAssignmentRecord,
    now: chrono::DateTime<chrono::Utc>,
) -> bool {
    assignment.lease_expires_at <= now
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{CognitiveCoordinationParticipantConfig, CognitiveCoordinationPeerConfig};
    use crate::experimental::cognitive_coordination_sdk::{
        CognitiveCoordinationInvocation, CoordinatedParticipantModelInput,
    };
    use crate::memory::sqlite::SqliteStore;
    use crate::memory::{
        NewAgent, NewCognitiveContext, NewSession, SessionDirectoryStore, SessionMountKind,
    };
    use crate::secret_store::{SecretStore, SecretValueBackend};
    use axum::{extract::State, routing::post, Json, Router};
    use domain::{EvaluationModelRequest, ModelExecutionProfile};
    use std::sync::Mutex as StdMutex;

    #[test]
    fn coordination_http_error_reads_the_structured_api_envelope() {
        let message = coordination_http_error(
            "http://peer.local:8080",
            "peer",
            reqwest::StatusCode::UNAUTHORIZED,
            br#"{"error":{"code":"unauthorized","message":"reverse identity probe failed"}}"#,
        );
        assert_eq!(
            message,
            "peer returned HTTP 401 Unauthorized: reverse identity probe failed"
        );
    }

    #[derive(Clone)]
    struct MockPeer {
        authority_id: String,
        secret: String,
        participant: ParticipantDescriptor,
    }

    #[derive(Debug, Default)]
    struct MemorySecretBackend(StdMutex<HashMap<String, String>>);

    impl SecretValueBackend for MemorySecretBackend {
        fn backend_id(&self) -> &'static str {
            "coordination_mesh_test"
        }

        fn storage_kind(&self) -> &'static str {
            "memory"
        }

        fn put(&self, locator: &str, value: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(locator.into(), value.into());
            Ok(())
        }

        fn get(&self, locator: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(locator).cloned())
        }

        fn delete(&self, locator: &str) -> Result<bool, String> {
            Ok(self.0.lock().unwrap().remove(locator).is_some())
        }
    }

    #[derive(Clone)]
    struct MeshMockPeer {
        service: Arc<CognitiveCoordinationNetworkService>,
        participant: ParticipantDescriptor,
    }

    async fn mesh_mock_handshake(
        State(state): State<MeshMockPeer>,
        Json(envelope): Json<AuthenticatedEnvelope<HandshakeRequest>>,
    ) -> Json<AuthenticatedEnvelope<HandshakeAdvertisement>> {
        state
            .service
            .verify_incoming_handshake(&envelope, envelope.payload.sender_endpoint.as_deref())
            .await
            .unwrap();
        assert!(
            envelope.payload.expected_authority_id.is_empty()
                || envelope.payload.expected_authority_id
                    == state.service.local_authority_id().unwrap()
        );
        let issued_at = chrono::Utc::now();
        Json(
            state
                .service
                .sign_response_to(
                    &envelope.authority_id,
                    HandshakeAdvertisement {
                        protocol_version: EXPERIMENT_SPEC_VERSION.to_string(),
                        supported_operations: vec!["evaluate".to_string()],
                        participant: state.participant,
                        issued_at,
                        expires_at: issued_at + chrono::Duration::minutes(1),
                    },
                )
                .unwrap(),
        )
    }

    async fn mesh_mock_identity(
        State(state): State<MeshMockPeer>,
    ) -> Json<AuthenticatedEnvelope<IdentityAdvertisement>> {
        Json(state.service.identity_advertisement().unwrap())
    }

    async fn mock_handshake(
        State(state): State<MockPeer>,
        Json(envelope): Json<AuthenticatedEnvelope<HandshakeRequest>>,
    ) -> Json<AuthenticatedEnvelope<HandshakeAdvertisement>> {
        verify_signature(&envelope, state.secret.as_bytes()).unwrap();
        assert_eq!(envelope.payload.expected_authority_id, state.authority_id);
        let issued_at = chrono::Utc::now();
        Json(
            signed_envelope(
                state.authority_id,
                HandshakeAdvertisement {
                    protocol_version: EXPERIMENT_SPEC_VERSION.to_string(),
                    supported_operations: vec!["evaluate".to_string(), "cancel".to_string()],
                    participant: state.participant,
                    issued_at,
                    expires_at: issued_at + chrono::Duration::minutes(1),
                },
                state.secret.as_bytes(),
            )
            .unwrap(),
        )
    }

    async fn mock_projection(
        State(state): State<MockPeer>,
        Json(envelope): Json<AuthenticatedEnvelope<ProjectionRequest>>,
    ) -> Json<AuthenticatedEnvelope<ProjectionSnapshot>> {
        verify_signature(&envelope, state.secret.as_bytes()).unwrap();
        let request_id = envelope.payload.request_id;
        Json(
            signed_envelope(
                state.authority_id,
                ProjectionSnapshot {
                    context_id: state.participant.context_id,
                    session_id: format!("coord-eval-{request_id}"),
                    context_version: 7,
                    digest: "sha256:mock-projection".to_string(),
                },
                state.secret.as_bytes(),
            )
            .unwrap(),
        )
    }

    async fn mock_evaluate(
        State(state): State<MockPeer>,
        Json(envelope): Json<AuthenticatedEnvelope<RemoteEvaluationRequest>>,
    ) -> Json<AuthenticatedEnvelope<RemoteEvaluationResponse>> {
        verify_signature(&envelope, state.secret.as_bytes()).unwrap();
        let assignment = envelope.payload.assignment;
        assert_eq!(assignment.participant.authority_id, state.authority_id);
        let response = RemoteEvaluationResponse {
            draft: ProposalDraft {
                statement: json!({
                    "authority_id": state.authority_id,
                    "model_route": assignment.model.route,
                    "reasoning_effort": assignment.model.reasoning_effort,
                }),
                evidence_refs: vec!["evidence:mock".to_string()],
                artifact_refs: Vec::new(),
                claimed_relations: Vec::new(),
            },
            effective_model: assignment.model,
        };
        Json(signed_envelope(state.authority_id, response, state.secret.as_bytes()).unwrap())
    }

    async fn mock_cancel(
        State(state): State<MockPeer>,
        Json(envelope): Json<AuthenticatedEnvelope<CancelEvaluationRequest>>,
    ) -> Json<AuthenticatedEnvelope<CancelEvaluationResponse>> {
        verify_signature(&envelope, state.secret.as_bytes()).unwrap();
        Json(
            signed_envelope(
                state.authority_id,
                CancelEvaluationResponse {
                    assignment_id: envelope.payload.assignment_id,
                    cancelled: true,
                },
                state.secret.as_bytes(),
            )
            .unwrap(),
        )
    }

    fn mock_participant(authority_id: &str) -> ParticipantDescriptor {
        ParticipantDescriptor {
            authority_id: authority_id.to_string(),
            // Local identifiers intentionally match on every independent
            // Runtime; Authority namespaces them at the protocol boundary.
            agent_id: "default-agent".to_string(),
            context_id: "context-default".to_string(),
            session_id: String::new(),
            capabilities: BTreeSet::from(["general-reasoning".to_string()]),
            model_profiles: vec![
                ModelExecutionProfile {
                    route: "fast".to_string(),
                    label: "Fast".to_string(),
                    physical_models: vec!["provider/fast".to_string()],
                    supported_reasoning_efforts: Some(vec!["low".to_string()]),
                    context_window: Some(64_000),
                    max_output_tokens: Some(4_096),
                },
                ModelExecutionProfile {
                    route: "deep".to_string(),
                    label: "Deep".to_string(),
                    physical_models: vec!["provider/deep".to_string()],
                    supported_reasoning_efforts: Some(vec!["high".to_string()]),
                    context_window: Some(128_000),
                    max_output_tokens: Some(8_192),
                },
            ],
            default_model: EvaluationModelRequest {
                route: Some("fast".to_string()),
                reasoning_effort: Some("low".to_string()),
            },
            max_token_budget: 16_384,
            priority: 0,
            enabled: true,
        }
    }

    async fn start_mock_peer(
        authority_id: &str,
        secret: &str,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let state = MockPeer {
            authority_id: authority_id.to_string(),
            secret: secret.to_string(),
            participant: mock_participant(authority_id),
        };
        let router = Router::new()
            .route(HANDSHAKE_PATH, post(mock_handshake))
            .route(PROJECTION_PATH, post(mock_projection))
            .route(EVALUATE_PATH, post(mock_evaluate))
            .route(CANCEL_PATH, post(mock_cancel))
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (format!("http://{address}"), task)
    }

    #[test]
    fn authenticated_envelope_detects_tampering() {
        let mut envelope = signed_envelope(
            "authority-a".to_string(),
            HandshakeRequest {
                expected_authority_id: "authority-b".to_string(),
                sender_endpoint: None,
                protocol_version: EXPERIMENT_SPEC_VERSION.to_string(),
            },
            b"secret",
        )
        .unwrap();
        verify_signature(&envelope, b"secret").unwrap();
        envelope.payload.expected_authority_id = "authority-c".to_string();
        assert!(verify_signature(&envelope, b"secret").is_err());
    }

    #[test]
    fn identity_envelope_binds_the_authority_public_key_and_payload() {
        let document =
            ring::signature::Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new())
                .unwrap();
        let identity = CoordinationNodeIdentity::from_pkcs8_base64(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(document.as_ref()),
        )
        .unwrap();
        let mut envelope = signed_identity_envelope(
            &identity,
            HandshakeRequest {
                expected_authority_id: String::new(),
                sender_endpoint: Some("http://127.0.0.1:8080".to_string()),
                protocol_version: EXPERIMENT_SPEC_VERSION.to_string(),
            },
        )
        .unwrap();
        verify_identity_envelope(&envelope, identity.public_key()).unwrap();
        envelope.payload.protocol_version = "tampered".to_string();
        assert!(verify_identity_envelope(&envelope, identity.public_key()).is_err());
    }

    #[test]
    fn mesh_configuration_does_not_require_pairwise_hmac_secrets() {
        let config = CognitiveCoordinationConfig {
            mesh: Some("static:http://127.0.0.1:8080".to_string()),
            participant: Some(CognitiveCoordinationParticipantConfig {
                authority_id: "morphz-node-test".to_string(),
                token_env: String::new(),
                ..Default::default()
            }),
            ..Default::default()
        };
        validate_config(&config).unwrap();
    }

    #[tokio::test]
    async fn one_mesh_source_auto_identifies_nodes_pins_keys_and_reports_loss() {
        let listener_a = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let listener_b = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint_a = format!("http://{}", listener_a.local_addr().unwrap());
        let endpoint_b = format!("http://{}", listener_b.local_addr().unwrap());
        let mesh = format!("static:{endpoint_a},{endpoint_b}");
        let state = tempfile::tempdir().unwrap();
        let store_a = SecretStore::new(
            state.path().join("a-secrets.json"),
            Arc::new(MemorySecretBackend::default()),
        )
        .unwrap();
        let store_b = SecretStore::new(
            state.path().join("b-secrets.json"),
            Arc::new(MemorySecretBackend::default()),
        )
        .unwrap();
        let enabled = BTreeSet::from([COGNITIVE_COORDINATION.to_string()]);
        let config = |mesh: &str| CognitiveCoordinationConfig {
            mesh: Some(mesh.to_string()),
            participant: Some(CognitiveCoordinationParticipantConfig::default()),
            handshake_timeout_secs: 1,
            heartbeat_interval_secs: 1,
            ..Default::default()
        };
        let service_a = Arc::new(
            CognitiveCoordinationNetworkService::new_with_test_state(
                crate::experimental::require_enabled(&enabled, COGNITIVE_COORDINATION).unwrap(),
                config(&mesh),
                &store_a,
                state.path().join("a-trust.json"),
            )
            .unwrap(),
        );
        let service_b = Arc::new(
            CognitiveCoordinationNetworkService::new_with_test_state(
                crate::experimental::require_enabled(&enabled, COGNITIVE_COORDINATION).unwrap(),
                config(&mesh),
                &store_b,
                state.path().join("b-trust.json"),
            )
            .unwrap(),
        );
        let authority_a = service_a.local_authority_id().unwrap().to_string();
        let authority_b = service_b.local_authority_id().unwrap().to_string();
        assert_ne!(authority_a, authority_b);

        let router_a = Router::new()
            .route(IDENTITY_PATH, axum::routing::get(mesh_mock_identity))
            .route(HANDSHAKE_PATH, post(mesh_mock_handshake))
            .with_state(MeshMockPeer {
                service: Arc::clone(&service_a),
                participant: mock_participant(&authority_a),
            });
        let router_b = Router::new()
            .route(IDENTITY_PATH, axum::routing::get(mesh_mock_identity))
            .route(HANDSHAKE_PATH, post(mesh_mock_handshake))
            .with_state(MeshMockPeer {
                service: Arc::clone(&service_b),
                participant: mock_participant(&authority_b),
            });
        let server_a = tokio::spawn(async move {
            axum::serve(listener_a, router_a).await.unwrap();
        });
        let server_b = tokio::spawn(async move {
            axum::serve(listener_b, router_b).await.unwrap();
        });

        let status_a = service_a.refresh_peer_statuses().await;
        assert_eq!(status_a.len(), 1);
        assert!(status_a[0].healthy);
        assert_eq!(status_a[0].authority_id, authority_b);
        assert_eq!(
            service_a.current_local_endpoint().as_deref(),
            Some(endpoint_a.as_str())
        );

        let status_b = service_b.refresh_peer_statuses().await;
        assert_eq!(status_b.len(), 1);
        assert!(status_b[0].healthy);
        assert_eq!(status_b[0].authority_id, authority_a);
        assert_eq!(
            service_b.current_local_endpoint().as_deref(),
            Some(endpoint_b.as_str())
        );

        let rogue_document =
            ring::signature::Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new())
                .unwrap();
        let rogue = CoordinationNodeIdentity::from_pkcs8_base64(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(rogue_document.as_ref()),
        )
        .unwrap();
        let forged_endpoint_claim = signed_identity_envelope(
            &rogue,
            HandshakeRequest {
                expected_authority_id: authority_a.clone(),
                sender_endpoint: Some(endpoint_b.clone()),
                protocol_version: EXPERIMENT_SPEC_VERSION.to_string(),
            },
        )
        .unwrap();
        assert!(service_a
            .verify_incoming_handshake(
                &forged_endpoint_claim,
                forged_endpoint_claim.payload.sender_endpoint.as_deref(),
            )
            .await
            .is_err());

        server_b.abort();
        Arc::clone(&service_a).start_heartbeat();
        let mut observed_offline = false;
        for _ in 0..30 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            observed_offline = service_a
                .peer_status_snapshot()
                .iter()
                .any(|status| status.base_url == endpoint_b && !status.healthy);
            if observed_offline {
                break;
            }
        }
        assert!(
            observed_offline,
            "heartbeat did not report the stopped peer"
        );
        server_a.abort();
    }

    #[test]
    fn incoming_authentication_uses_the_senders_pairwise_secret_and_rejects_replay() {
        std::env::set_var("MORPHZ_TEST_COORD_SELF_AUTH", "self-secret");
        std::env::set_var("MORPHZ_TEST_COORD_PAIR_AUTH", "pair-secret");
        let enabled = BTreeSet::from([COGNITIVE_COORDINATION.to_string()]);
        let permit =
            crate::experimental::require_enabled(&enabled, COGNITIVE_COORDINATION).unwrap();
        let service = CognitiveCoordinationNetworkService::new(
            permit,
            CognitiveCoordinationConfig {
                participant: Some(CognitiveCoordinationParticipantConfig {
                    authority_id: "authority-a".to_string(),
                    token_env: "MORPHZ_TEST_COORD_SELF_AUTH".to_string(),
                    ..Default::default()
                }),
                peers: vec![CognitiveCoordinationPeerConfig {
                    authority_id: "authority-b".to_string(),
                    base_url: "http://127.0.0.1:1".to_string(),
                    token_env: "MORPHZ_TEST_COORD_PAIR_AUTH".to_string(),
                    enabled: true,
                }],
                ..Default::default()
            },
        )
        .unwrap();
        let envelope = signed_envelope(
            "authority-b".to_string(),
            HandshakeRequest {
                expected_authority_id: "authority-a".to_string(),
                sender_endpoint: None,
                protocol_version: EXPERIMENT_SPEC_VERSION.to_string(),
            },
            b"pair-secret",
        )
        .unwrap();
        service.verify_incoming(&envelope).unwrap();
        assert!(service.verify_incoming(&envelope).is_err());

        let wrong_secret =
            signed_envelope("authority-b".to_string(), envelope.payload, b"self-secret").unwrap();
        assert!(service.verify_incoming(&wrong_secret).is_err());
        std::env::remove_var("MORPHZ_TEST_COORD_SELF_AUTH");
        std::env::remove_var("MORPHZ_TEST_COORD_PAIR_AUTH");
    }

    #[tokio::test]
    async fn three_remote_nodes_negotiate_models_and_evaluate_over_authenticated_http() {
        let assignment_state = tempfile::tempdir().unwrap();
        let assignment_store = Arc::new(
            SqliteStore::new(
                assignment_state
                    .path()
                    .join("assignments.db")
                    .to_str()
                    .unwrap(),
            )
            .await
            .unwrap(),
        );
        assignment_store
            .create_agent_bundle(
                NewAgent {
                    id: "default-agent".to_string(),
                    title: "Coordinator".to_string(),
                    root_context_id: "context-origin".to_string(),
                },
                NewCognitiveContext {
                    id: "context-origin".to_string(),
                    agent_id: "default-agent".to_string(),
                    title: "Origin Context".to_string(),
                },
                NewSession {
                    id: "session-origin".to_string(),
                    agent_id: "default-agent".to_string(),
                    context_id: "context-origin".to_string(),
                    parent_session_id: None,
                    title: "Origin Session".to_string(),
                    mount_kind: SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        let peer_specs = [
            ("authority-a", "MORPHZ_TEST_COORD_A", "secret-a"),
            ("authority-b", "MORPHZ_TEST_COORD_B", "secret-b"),
            ("authority-c", "MORPHZ_TEST_COORD_C", "secret-c"),
        ];
        let mut peers = Vec::new();
        let mut servers = Vec::new();
        for (authority_id, variable, secret) in peer_specs {
            std::env::set_var(variable, secret);
            let (base_url, task) = start_mock_peer(authority_id, secret).await;
            peers.push(CognitiveCoordinationPeerConfig {
                authority_id: authority_id.to_string(),
                base_url,
                token_env: variable.to_string(),
                enabled: true,
            });
            servers.push(task);
        }
        std::env::set_var("MORPHZ_TEST_COORD_LOCAL", "local-secret");
        let config = CognitiveCoordinationConfig {
            participant: Some(CognitiveCoordinationParticipantConfig {
                authority_id: "authority-coordinator".to_string(),
                token_env: "MORPHZ_TEST_COORD_LOCAL".to_string(),
                ..Default::default()
            }),
            peers,
            request_timeout_secs: 10,
            handshake_timeout_secs: 2,
            handshake_ttl_secs: 60,
            max_clock_skew_secs: 60,
            ..Default::default()
        };
        let enabled = BTreeSet::from([COGNITIVE_COORDINATION.to_string()]);
        let permit =
            crate::experimental::require_enabled(&enabled, COGNITIVE_COORDINATION).unwrap();
        let assignment_store_dyn: Arc<dyn WorkAssignmentStore> = assignment_store;
        let service = Arc::new(
            CognitiveCoordinationNetworkService::new(permit, config)
                .unwrap()
                .with_assignment_store(assignment_store_dyn),
        );

        let response = CognitiveCoordinationBackend::evaluate(
            &service,
            CoordinatedEvaluationInput {
                operation: "evaluate".to_string(),
                question: "Compare three independent proposals.".to_string(),
                objective_id: None,
                shared_input: Value::Null,
                required_capabilities: vec!["general-reasoning".to_string()],
                preferred_capabilities: Vec::new(),
                min_participants: Some(3),
                max_participants: Some(3),
                token_budget_per_participant: Some(4_096),
                model_route: Some("deep".to_string()),
                reasoning_effort: Some("high".to_string()),
                participant_models: vec![CoordinatedParticipantModelInput {
                    authority_id: "authority-b".to_string(),
                    model_route: Some("fast".to_string()),
                    reasoning_effort: Some("low".to_string()),
                }],
            },
            CognitiveCoordinationInvocation {
                context_id: "context-origin".to_string(),
                session_id: "session-origin".to_string(),
            },
        )
        .await
        .unwrap();

        assert_eq!(response["committed"], false);
        assert_eq!(response["initiating_route"]["context_id"], "context-origin");
        assert_eq!(response["initiating_route"]["session_id"], "session-origin");
        let assignments = response["result"]["plan"]["assignments"]
            .as_array()
            .unwrap();
        assert_eq!(assignments.len(), 3);
        for assignment in assignments {
            let authority = assignment["participant"]["authority_id"].as_str().unwrap();
            let expected = if authority == "authority-b" {
                ("fast", "low")
            } else {
                ("deep", "high")
            };
            assert_eq!(assignment["model"]["route"], expected.0);
            assert_eq!(assignment["model"]["reasoning_effort"], expected.1);
        }
        assert_eq!(
            response["result"]["contribution_graph"]["proposals"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
        assert!(response["result"]["failures"]
            .as_array()
            .unwrap()
            .is_empty());
        let persisted = service.list_assignments(true, 16).await.unwrap();
        assert_eq!(persisted.len(), 3);
        assert!(persisted.iter().all(|assignment| {
            assignment.role == COORDINATION_ASSIGNMENT_COORDINATOR_ROLE
                && assignment.context_id == "context-origin"
                && assignment.session_id == "session-origin"
                && assignment.status == WorkAssignmentStatus::Succeeded
                && assignment.output.is_some()
        }));
        let mut expired = persisted[0].clone();
        expired.lease_expires_at = chrono::Utc::now() - chrono::Duration::seconds(1);
        assert!(assignment_has_expired(&expired, chrono::Utc::now()));
        expired.lease_expires_at = chrono::Utc::now() + chrono::Duration::seconds(10);
        assert!(!assignment_has_expired(&expired, chrono::Utc::now()));

        for server in servers {
            server.abort();
        }
        for (_, variable, _) in peer_specs {
            std::env::remove_var(variable);
        }
        std::env::remove_var("MORPHZ_TEST_COORD_LOCAL");
    }
}
