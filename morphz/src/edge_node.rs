//! Outbound Morphz Edge Node protocol client and worker loop.
//!
//! The Node never opens an inbound port. It authenticates with a device-only
//! credential, advertises explicitly scoped Targets, long-polls durable
//! commands, and executes them through the same local Tool registry,
//! PermissionBroker and NativeSandbox used by a single-machine Runtime.

use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use reqwest::StatusCode;
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::approval::{
    capability_lease_policy_digest, ApprovalDecision, ApprovalRequest, CapabilityDelta,
    CapabilityLeaseOffer,
};
use crate::artifact::{
    execution_arguments_from_transfer_request, transfer_request_from_tool_arguments,
    ArtifactLocation, ArtifactOverwritePolicy, ArtifactTransferStageKind,
    ARTIFACT_TRANSFER_TOOL_NAME,
};
pub use crate::execution_target::ManagedSshEndpoint;
use crate::execution_target::{
    edge_artifact_data_channel_from_route, edge_execution_scope_from_route,
    materialize_edge_directory_archive, prepare_managed_ssh_exec_arguments,
    stage_edge_directory_archive, ArtifactTransferRouteSnapshot, EdgeArtifactDataChannel,
    EdgeArtifactDataDirection, EdgeArtifactPayloadKind, EdgeExecutionScope, ExecutionRouteSnapshot,
    DEFAULT_EXECUTION_TARGET_ID, EDGE_EXECUTION_SCOPE_KEY,
};
use crate::memory::{
    EdgeCommandRecord, EdgeCommandStatus, ExecutionJobRecord, ExecutionNodeRecord,
    ExecutionTargetKind, ExecutionTargetRegistration,
};
use crate::runtime::MorphzRuntime;
use crate::sdk::{
    execution_node_connection_proof_message, AppendEdgeOutputCommand,
    CancelEdgeBackgroundExecutionCommand, ClaimEdgeCommand, ConnectExecutionNodeCommand,
    EdgeBackgroundExecutionLease, ExecutionNodeConnection, ExecutionNodeHeartbeatCommand,
    ExecutionNodeIdentityChallenge, FinishEdgeBackgroundExecutionCommand, FinishEdgeCommand,
    HeartbeatEdgeBackgroundExecutionCommand, HeartbeatEdgeCommand, PairExecutionNodeCommand,
    PairedExecutionNode, ReserveEdgeBackgroundExecutionCommand, RotateExecutionNodeKeyCommand,
};

pub type EdgeNodeError = Box<dyn Error + Send + Sync>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EdgeLocalCapabilityLease {
    pub id: String,
    pub principal_id: String,
    pub agent_id: String,
    pub thread_id: String,
    pub target_id: String,
    pub capability: String,
    pub requested: CapabilityDelta,
    pub policy_digest: String,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}

impl EdgeLocalCapabilityLease {
    fn active_at(&self, now: DateTime<Utc>) -> bool {
        self.revoked_at.is_none() && self.expires_at > now
    }
}

/// Provider-local lease registry. It never leaves the Edge Node and is not a
/// substitute for the cloud CapabilityLease. Both sides independently check
/// their own policy digest and either side may revoke.
#[derive(Clone)]
pub struct EdgeLocalCapabilityLeaseStore {
    path: Option<PathBuf>,
    leases: Arc<std::sync::Mutex<Vec<EdgeLocalCapabilityLease>>>,
}

impl EdgeLocalCapabilityLeaseStore {
    pub fn for_node(node_id: &str) -> Self {
        let file_id = format!("{:x}", Sha256::digest(node_id.as_bytes()));
        let path = crate::config::morphz_home_dir().map(|home| {
            home.join("edge")
                .join(format!("local-capability-leases-{file_id}.json"))
        });
        let leases = path
            .as_deref()
            .and_then(|path| std::fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            path,
            leases: Arc::new(std::sync::Mutex::new(leases)),
        }
    }

    pub fn list(&self) -> Vec<EdgeLocalCapabilityLease> {
        let mut leases = self
            .leases
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        leases.sort_by_key(|lease| lease.issued_at);
        leases
    }

    pub fn revoke(&self, lease_id: &str) -> Result<bool, EdgeNodeError> {
        let mut leases = self
            .leases
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(lease) = leases.iter_mut().find(|lease| lease.id == lease_id) else {
            return Ok(false);
        };
        if lease.revoked_at.is_none() {
            lease.revoked_at = Some(Utc::now());
            self.persist(&leases)?;
        }
        Ok(true)
    }

    fn covers(
        &self,
        scope: &EdgeExecutionScope,
        target_id: &str,
        capability: &str,
        requested: &CapabilityDelta,
        policy_digest: &str,
    ) -> bool {
        let now = Utc::now();
        self.leases
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .any(|lease| {
                lease.active_at(now)
                    && lease.principal_id == scope.principal_id
                    && lease.agent_id == scope.agent_id
                    && lease.thread_id == scope.thread_id
                    && lease.target_id == target_id
                    && lease.capability == capability
                    && lease.policy_digest == policy_digest
                    && requested.is_subset_of(&lease.requested)
            })
    }

    fn grant(&self, lease: EdgeLocalCapabilityLease) -> Result<(), EdgeNodeError> {
        let mut leases = self
            .leases
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        leases.retain(|current| current.id != lease.id);
        leases.push(lease);
        self.persist(&leases)
    }

    fn persist(&self, leases: &[EdgeLocalCapabilityLease]) -> Result<(), EdgeNodeError> {
        let Some(path) = self.path.as_deref() else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temporary = path.with_extension("json.tmp");
        std::fs::write(&temporary, serde_json::to_vec_pretty(leases)?)?;
        restrict_secret_file(&temporary)?;
        std::fs::rename(&temporary, path)?;
        restrict_secret_file(path)?;
        Ok(())
    }
}

pub struct EdgeDeviceIdentity {
    pub private_key_pkcs8: String,
    pub public_key: String,
    pub fingerprint: String,
}

pub fn generate_device_identity() -> Result<EdgeDeviceIdentity, EdgeNodeError> {
    let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
        .map_err(|_| "failed to generate Edge Ed25519 device key")?;
    let key_pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref())
        .map_err(|_| "failed to parse newly generated Edge Ed25519 device key")?;
    let public_key = key_pair.public_key().as_ref();
    Ok(EdgeDeviceIdentity {
        private_key_pkcs8: encode_hex(pkcs8.as_ref()),
        public_key: encode_hex(public_key),
        fingerprint: format!("sha256:{:x}", Sha256::digest(public_key)),
    })
}

// Deliberately no Debug: this value contains the device private key.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EdgeNodeCredentials {
    pub server_url: String,
    pub node_id: String,
    pub device_key_fingerprint: String,
    pub device_public_key: String,
    pub device_private_key_pkcs8: String,
}

impl EdgeNodeCredentials {
    pub fn default_path() -> Result<PathBuf, EdgeNodeError> {
        let home = crate::config::morphz_home_dir()
            .ok_or("cannot determine Morphz user configuration directory; Edge Node credentials cannot be saved")?;
        Ok(home.join("edge").join("credentials.json"))
    }

    pub fn load(path: &Path) -> Result<Self, EdgeNodeError> {
        Ok(serde_json::from_slice(&std::fs::read(path)?)?)
    }

    pub fn save(&self, path: &Path) -> Result<(), EdgeNodeError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temporary = path.with_extension("json.tmp");
        std::fs::write(&temporary, serde_json::to_vec_pretty(self)?)?;
        restrict_secret_file(&temporary)?;
        std::fs::rename(&temporary, path)?;
        restrict_secret_file(path)?;
        Ok(())
    }
}

#[cfg(unix)]
fn restrict_secret_file(path: &Path) -> Result<(), EdgeNodeError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn restrict_secret_file(_path: &Path) -> Result<(), EdgeNodeError> {
    // Windows deployments should additionally use an OS credential vault.
    // The bearer credential is still kept outside the workspace and never
    // enters a Prompt, Event or Execution Job.
    Ok(())
}

#[derive(Debug, Clone)]
pub struct EdgeNodeAdvertisement {
    pub platform: Option<String>,
    pub capabilities: Vec<String>,
    pub metadata: serde_json::Value,
    pub targets: Vec<ExecutionTargetRegistration>,
}

#[derive(Debug, Clone)]
pub struct EdgeWorkerConfig {
    pub worker_id: String,
    pub lease_seconds: u64,
    pub claim_wait_seconds: u64,
    pub heartbeat_interval: Duration,
}

impl Default for EdgeWorkerConfig {
    fn default() -> Self {
        Self {
            worker_id: format!("edge-worker-{}", std::process::id()),
            lease_seconds: 30,
            claim_wait_seconds: 20,
            heartbeat_interval: Duration::from_secs(10),
        }
    }
}

#[derive(Clone)]
pub struct EdgeGatewayClient {
    base_url: String,
    http: reqwest::Client,
    connection: Arc<tokio::sync::RwLock<Option<ExecutionNodeConnection>>>,
    connection_refresh: Arc<tokio::sync::Mutex<()>>,
}

impl EdgeGatewayClient {
    pub fn new(server_url: impl Into<String>) -> Result<Self, EdgeNodeError> {
        let base_url = server_url.into().trim_end_matches('/').to_string();
        if !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
            return Err("Edge server URL must start with http:// or https://".into());
        }
        Ok(Self {
            base_url,
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(15))
                .build()?,
            connection: Arc::new(tokio::sync::RwLock::new(None)),
            connection_refresh: Arc::new(tokio::sync::Mutex::new(())),
        })
    }

    pub async fn pair(
        &self,
        command: PairExecutionNodeCommand,
    ) -> Result<PairedExecutionNode, EdgeNodeError> {
        self.send_json(self.http.post(self.url("/api/edge/pair")).json(&command))
            .await
    }

    pub async fn heartbeat_node(
        &self,
        credentials: &EdgeNodeCredentials,
        advertisement: &EdgeNodeAdvertisement,
    ) -> Result<ExecutionNodeRecord, EdgeNodeError> {
        let command = ExecutionNodeHeartbeatCommand {
            platform: advertisement.platform.clone(),
            capabilities: advertisement.capabilities.clone(),
            metadata: advertisement.metadata.clone(),
            targets: advertisement.targets.clone(),
        };
        self.send_json(
            self.authorized(
                self.http.post(self.url(&format!(
                    "/api/edge/nodes/{}/heartbeat",
                    credentials.node_id
                ))),
                credentials,
            )
            .await?
            .json(&command),
        )
        .await
    }

    pub async fn rotate_device_key(
        &self,
        credentials: &EdgeNodeCredentials,
        expected_revision: u64,
        identity: &EdgeDeviceIdentity,
    ) -> Result<ExecutionNodeRecord, EdgeNodeError> {
        let node: ExecutionNodeRecord = self
            .send_json(
                self.authorized(
                    self.http.post(self.url(&format!(
                        "/api/edge/nodes/{}/rotate-key",
                        credentials.node_id
                    ))),
                    credentials,
                )
                .await?
                .json(&RotateExecutionNodeKeyCommand {
                    expected_revision,
                    device_key_fingerprint: identity.fingerprint.clone(),
                    device_public_key: identity.public_key.clone(),
                }),
            )
            .await?;
        // The server atomically invalidates the old connection credential.
        // Never attempt another request with it after a successful rotation.
        *self.connection.write().await = None;
        Ok(node)
    }

    pub async fn claim(
        &self,
        credentials: &EdgeNodeCredentials,
        config: &EdgeWorkerConfig,
    ) -> Result<Option<EdgeCommandRecord>, EdgeNodeError> {
        let response = self
            .authorized(
                self.http.post(self.url(&format!(
                    "/api/edge/nodes/{}/jobs/claim?wait_seconds={}",
                    credentials.node_id,
                    config.claim_wait_seconds.min(25)
                ))),
                credentials,
            )
            .await?
            .json(&ClaimEdgeCommand {
                worker_id: config.worker_id.clone(),
                lease_seconds: config.lease_seconds,
            })
            .send()
            .await?;
        if response.status() == StatusCode::NO_CONTENT {
            return Ok(None);
        }
        let value: serde_json::Value = decode_response(response).await?;
        Ok(value
            .get("job")
            .cloned()
            .map(serde_json::from_value)
            .transpose()?)
    }

    pub async fn heartbeat_command(
        &self,
        credentials: &EdgeNodeCredentials,
        command: &EdgeCommandRecord,
        side_effect_started: bool,
        progress: Option<String>,
        lease_seconds: u64,
    ) -> Result<EdgeCommandRecord, EdgeNodeError> {
        let claim_token = command
            .claim_token
            .as_deref()
            .ok_or("claimed Edge Command is missing claim_token")?;
        self.send_json(
            self.authorized(
                self.http.post(self.url(&format!(
                    "/api/edge/nodes/{}/jobs/{}/heartbeat",
                    credentials.node_id, command.job_id
                ))),
                credentials,
            )
            .await?
            .json(&HeartbeatEdgeCommand {
                expected_revision: command.revision,
                claim_token: claim_token.to_string(),
                lease_seconds,
                side_effect_started,
                progress,
            }),
        )
        .await
    }

    pub async fn finish_command(
        &self,
        credentials: &EdgeNodeCredentials,
        command: &EdgeCommandRecord,
        status: EdgeCommandStatus,
        output: Option<String>,
        error: Option<String>,
    ) -> Result<EdgeCommandRecord, EdgeNodeError> {
        let claim_token = command
            .claim_token
            .as_deref()
            .ok_or("claimed Edge Command is missing claim_token")?;
        self.send_json(
            self.authorized(
                self.http.post(self.url(&format!(
                    "/api/edge/nodes/{}/jobs/{}/finish",
                    credentials.node_id, command.job_id
                ))),
                credentials,
            )
            .await?
            .json(&FinishEdgeCommand {
                expected_revision: command.revision,
                claim_token: claim_token.to_string(),
                status,
                output,
                error,
            }),
        )
        .await
    }

    pub async fn reserve_background_execution(
        &self,
        credentials: &EdgeNodeCredentials,
        command: &EdgeCommandRecord,
        worker_id: &str,
        background_source: &str,
        lease_seconds: u64,
    ) -> Result<EdgeBackgroundExecutionLease, EdgeNodeError> {
        let parent_claim_token = command
            .claim_token
            .as_deref()
            .ok_or("claimed Edge Command is missing claim_token")?;
        let mut digest = Sha256::new();
        digest.update(b"morphz.edge-background-claim.v1\0");
        digest.update(parent_claim_token.as_bytes());
        digest.update(command.job_id.as_bytes());
        let child_claim_token = format!("edge-background-{:x}", digest.finalize());
        self.send_json(
            self.authorized(
                self.http.post(self.url(&format!(
                    "/api/edge/nodes/{}/jobs/{}/background/reserve",
                    credentials.node_id, command.job_id
                ))),
                credentials,
            )
            .await?
            .json(&ReserveEdgeBackgroundExecutionCommand {
                expected_parent_revision: command.revision,
                parent_claim_token: parent_claim_token.to_string(),
                worker_id: worker_id.to_string(),
                child_claim_token,
                lease_seconds,
                background_source: background_source.to_string(),
            }),
        )
        .await
    }

    pub async fn heartbeat_background_execution(
        &self,
        credentials: &EdgeNodeCredentials,
        parent_job_id: &str,
        lease: &EdgeBackgroundExecutionLease,
        side_effect_started: bool,
        progress_ref: Option<String>,
        lease_seconds: u64,
    ) -> Result<ExecutionJobRecord, EdgeNodeError> {
        self.send_json(
            self.authorized(
                self.http.post(self.url(&format!(
                    "/api/edge/nodes/{}/jobs/{}/background/{}/heartbeat",
                    credentials.node_id, parent_job_id, lease.job.id
                ))),
                credentials,
            )
            .await?
            .json(&HeartbeatEdgeBackgroundExecutionCommand {
                expected_revision: lease.job.revision,
                claim_token: lease.claim_token.clone(),
                lease_seconds,
                side_effect_started,
                progress_ref,
            }),
        )
        .await
    }

    pub async fn finish_background_execution(
        &self,
        credentials: &EdgeNodeCredentials,
        parent_job_id: &str,
        lease: &EdgeBackgroundExecutionLease,
        exit_code: i32,
        output: String,
        residual_note: String,
    ) -> Result<bool, EdgeNodeError> {
        #[derive(Deserialize)]
        struct FinishReceipt {
            committed: bool,
        }
        let receipt: FinishReceipt = self
            .send_json(
                self.authorized(
                    self.http.post(self.url(&format!(
                        "/api/edge/nodes/{}/jobs/{}/background/{}/finish",
                        credentials.node_id, parent_job_id, lease.job.id
                    ))),
                    credentials,
                )
                .await?
                .json(&FinishEdgeBackgroundExecutionCommand {
                    claim_token: lease.claim_token.clone(),
                    exit_code,
                    output,
                    residual_note,
                }),
            )
            .await?;
        Ok(receipt.committed)
    }

    pub async fn cancel_background_execution(
        &self,
        credentials: &EdgeNodeCredentials,
        parent_job_id: &str,
        lease: &EdgeBackgroundExecutionLease,
        reason: &str,
    ) -> Result<ExecutionJobRecord, EdgeNodeError> {
        self.send_json(
            self.authorized(
                self.http.post(self.url(&format!(
                    "/api/edge/nodes/{}/jobs/{}/background/{}/cancel",
                    credentials.node_id, parent_job_id, lease.job.id
                ))),
                credentials,
            )
            .await?
            .json(&CancelEdgeBackgroundExecutionCommand {
                expected_revision: lease.job.revision,
                claim_token: lease.claim_token.clone(),
                reason: reason.to_string(),
            }),
        )
        .await
    }

    pub async fn append_output(
        &self,
        credentials: &EdgeNodeCredentials,
        command: &EdgeCommandRecord,
        chunk: crate::tool::ToolOutputChunk,
    ) -> Result<crate::memory::EdgeCommandOutputChunk, EdgeNodeError> {
        let claim_token = command
            .claim_token
            .as_deref()
            .ok_or("claimed Edge Command is missing claim_token")?;
        self.send_json(
            self.authorized(
                self.http.post(self.url(&format!(
                    "/api/edge/nodes/{}/jobs/{}/output",
                    credentials.node_id, command.job_id
                ))),
                credentials,
            )
            .await?
            .json(&AppendEdgeOutputCommand {
                claim_token: claim_token.to_string(),
                stream: chunk.stream,
                text: chunk.text,
            }),
        )
        .await
    }

    pub async fn download_artifact(
        &self,
        credentials: &EdgeNodeCredentials,
        command: &EdgeCommandRecord,
        destination: &Path,
        channel: &EdgeArtifactDataChannel,
    ) -> Result<(u64, String), EdgeNodeError> {
        let claim_token = command
            .claim_token
            .as_deref()
            .ok_or("claimed Edge Artifact Command is missing claim_token")?;
        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let partial = destination.with_extension("partial");
        if tokio::fs::try_exists(destination).await? {
            let (size, digest) = hash_edge_file(destination).await?;
            if validate_edge_channel_payload(channel, size, &digest).is_ok() {
                return Ok((size, digest));
            }
        }
        let mut last_error: Option<EdgeNodeError> = None;
        for attempt in 0..5_u32 {
            let offset = tokio::fs::metadata(&partial)
                .await
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            let response = self
                .authorized(
                    self.http.get(self.url(&format!(
                        "/api/edge/nodes/{}/jobs/{}/artifact/download?offset={offset}",
                        credentials.node_id, command.job_id
                    ))),
                    credentials,
                )
                .await?
                .header("x-morphz-claim-token", claim_token)
                .send()
                .await;
            let response = match response {
                Ok(response) if response.status().is_success() => response,
                Ok(response) => {
                    last_error = Some(decode_edge_error(response).await);
                    edge_transfer_backoff(attempt).await;
                    continue;
                }
                Err(error) => {
                    last_error = Some(error.into());
                    edge_transfer_backoff(attempt).await;
                    continue;
                }
            };
            let server_offset = response
                .headers()
                .get("x-morphz-artifact-offset")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok());
            if server_offset != Some(offset) {
                let _ = tokio::fs::remove_file(&partial).await;
                last_error = Some("Edge Artifact download offset negotiation failed".into());
                edge_transfer_backoff(attempt).await;
                continue;
            }
            let mut file = tokio::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&partial)
                .await?;
            let mut stream = response.bytes_stream();
            use tokio::io::AsyncWriteExt as _;
            let mut stream_failed = None;
            while let Some(chunk) = stream.next().await {
                match chunk {
                    Ok(chunk) => {
                        file.write_all(&chunk).await?;
                        file.flush().await?;
                    }
                    Err(error) => {
                        stream_failed = Some(error);
                        break;
                    }
                }
            }
            if let Some(error) = stream_failed {
                last_error = Some(error.into());
                edge_transfer_backoff(attempt).await;
                continue;
            }
            file.sync_all().await?;
            drop(file);
            let (size_bytes, digest) = hash_edge_file(&partial).await?;
            if let Err(error) = validate_edge_channel_payload(channel, size_bytes, &digest) {
                let _ = tokio::fs::remove_file(&partial).await;
                last_error = Some(error);
                edge_transfer_backoff(attempt).await;
                continue;
            }
            tokio::fs::rename(&partial, destination).await?;
            return Ok((size_bytes, digest));
        }
        Err(last_error.unwrap_or_else(|| "Edge Artifact download retries exhausted".into()))
    }

    pub async fn upload_artifact(
        &self,
        credentials: &EdgeNodeCredentials,
        command: &EdgeCommandRecord,
        source: &Path,
        channel: &EdgeArtifactDataChannel,
    ) -> Result<EdgeArtifactUploadReceipt, EdgeNodeError> {
        let claim_token = command
            .claim_token
            .as_deref()
            .ok_or("claimed Edge Artifact Command is missing claim_token")?;
        let (size_bytes, content_digest) = hash_edge_file(source).await?;
        validate_edge_channel_payload(channel, size_bytes, &content_digest)?;
        let mut last_error: Option<EdgeNodeError> = None;
        for attempt in 0..5_u32 {
            let status: EdgeArtifactUploadStatus = match self
                .send_json(
                    self.authorized(
                        self.http.get(self.url(&format!(
                            "/api/edge/nodes/{}/jobs/{}/artifact/upload",
                            credentials.node_id, command.job_id
                        ))),
                        credentials,
                    )
                    .await?
                    .header("x-morphz-claim-token", claim_token),
                )
                .await
            {
                Ok(status) => status,
                Err(error) => {
                    last_error = Some(error);
                    edge_transfer_backoff(attempt).await;
                    continue;
                }
            };
            if status.completed {
                return Ok(EdgeArtifactUploadReceipt {
                    job_id: command.job_id.clone(),
                    content_digest,
                    size_bytes,
                });
            }
            if status.offset > size_bytes {
                return Err("Runtime Artifact upload offset exceeds Edge source size".into());
            }
            let mut file = tokio::fs::File::open(source).await?;
            use tokio::io::AsyncSeekExt as _;
            file.seek(std::io::SeekFrom::Start(status.offset)).await?;
            let stream = futures_util::stream::try_unfold(file, |mut file| async move {
                use tokio::io::AsyncReadExt as _;
                let mut buffer = vec![0_u8; 128 * 1024];
                let count = file.read(&mut buffer).await?;
                if count == 0 {
                    Ok::<_, std::io::Error>(None)
                } else {
                    buffer.truncate(count);
                    Ok(Some((buffer, file)))
                }
            });
            let result: Result<EdgeArtifactUploadReceipt, EdgeNodeError> = self
                .send_json(
                    self.authorized(
                        self.http.put(self.url(&format!(
                            "/api/edge/nodes/{}/jobs/{}/artifact/upload",
                            credentials.node_id, command.job_id
                        ))),
                        credentials,
                    )
                    .await?
                    .header("x-morphz-claim-token", claim_token)
                    .header("x-morphz-artifact-offset", status.offset)
                    .header("x-morphz-artifact-total-size", size_bytes)
                    .header("x-morphz-content-digest", &content_digest)
                    .body(reqwest::Body::wrap_stream(stream)),
                )
                .await;
            match result {
                Ok(receipt) => {
                    validate_edge_channel_payload(
                        channel,
                        receipt.size_bytes,
                        &receipt.content_digest,
                    )?;
                    return Ok(receipt);
                }
                Err(error) => {
                    last_error = Some(error);
                    edge_transfer_backoff(attempt).await;
                }
            }
        }
        Err(last_error.unwrap_or_else(|| "Edge Artifact upload retries exhausted".into()))
    }

    async fn authorized(
        &self,
        request: reqwest::RequestBuilder,
        credentials: &EdgeNodeCredentials,
    ) -> Result<reqwest::RequestBuilder, EdgeNodeError> {
        Ok(request.bearer_auth(self.connection_token(credentials).await?))
    }

    async fn connection_token(
        &self,
        credentials: &EdgeNodeCredentials,
    ) -> Result<String, EdgeNodeError> {
        let refresh_before = chrono::Utc::now() + chrono::Duration::seconds(30);
        if let Some(connection) = self.connection.read().await.as_ref() {
            if connection.expires_at > refresh_before {
                return Ok(connection.token.clone());
            }
        }
        let _guard = self.connection_refresh.lock().await;
        if let Some(connection) = self.connection.read().await.as_ref() {
            if connection.expires_at > refresh_before {
                return Ok(connection.token.clone());
            }
        }
        let challenge: ExecutionNodeIdentityChallenge = self
            .send_json(self.http.post(self.url(&format!(
                "/api/edge/nodes/{}/challenge",
                credentials.node_id
            ))))
            .await?;
        let private_key = decode_hex(&credentials.device_private_key_pkcs8)?;
        let key_pair = Ed25519KeyPair::from_pkcs8(&private_key)
            .map_err(|_| "Edge device private key is corrupted or invalid")?;
        if encode_hex(key_pair.public_key().as_ref()) != credentials.device_public_key {
            return Err("Edge device private key does not match the paired public key".into());
        }
        let proof = execution_node_connection_proof_message(
            &credentials.node_id,
            &challenge.challenge_id,
            &challenge.nonce,
        );
        let connection: ExecutionNodeConnection = self
            .send_json(
                self.http
                    .post(self.url(&format!("/api/edge/nodes/{}/connect", credentials.node_id)))
                    .json(&ConnectExecutionNodeCommand {
                        challenge_id: challenge.challenge_id,
                        nonce: challenge.nonce,
                        signature: encode_hex(key_pair.sign(&proof).as_ref()),
                    }),
            )
            .await?;
        let token = connection.token.clone();
        *self.connection.write().await = Some(connection);
        Ok(token)
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    async fn send_json<T: DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<T, EdgeNodeError> {
        let response = request.send().await?;
        decode_response(response).await
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EdgeArtifactUploadReceipt {
    pub job_id: String,
    pub content_digest: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct EdgeArtifactUploadStatus {
    job_id: String,
    offset: u64,
    completed: bool,
}

async fn hash_edge_file(path: &Path) -> Result<(u64, String), EdgeNodeError> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut size = 0_u64;
    use tokio::io::AsyncReadExt as _;
    let mut buffer = vec![0_u8; 128 * 1024];
    loop {
        let count = file.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        size = size.saturating_add(count as u64);
    }
    Ok((size, format!("sha256:{:x}", hasher.finalize())))
}

async fn decode_edge_error(response: reqwest::Response) -> EdgeNodeError {
    let status = response.status();
    let detail = response
        .text()
        .await
        .unwrap_or_else(|error| error.to_string());
    format!("Edge Gateway returned HTTP {status}: {detail}").into()
}

async fn edge_transfer_backoff(attempt: u32) {
    let millis = 100_u64.saturating_mul(1_u64 << attempt.min(5));
    tokio::time::sleep(std::time::Duration::from_millis(millis)).await;
}

fn validate_edge_channel_payload(
    channel: &EdgeArtifactDataChannel,
    size_bytes: u64,
    digest: &str,
) -> Result<(), EdgeNodeError> {
    if channel
        .size_bytes
        .is_some_and(|expected| expected != size_bytes)
        || channel
            .expected_digest
            .as_deref()
            .is_some_and(|expected| expected != digest)
    {
        return Err(
            "Edge Artifact byte digest or size does not match the frozen data channel".into(),
        );
    }
    Ok(())
}

fn encode_hex(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    use std::fmt::Write as _;
    for byte in bytes {
        write!(&mut encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    encoded
}

fn decode_hex(value: &str) -> Result<Vec<u8>, EdgeNodeError> {
    if !value.len().is_multiple_of(2) {
        return Err("Edge key hex length must be even".into());
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let high = edge_hex_nibble(pair[0]).ok_or("Edge key contains a non-hex character")?;
            let low = edge_hex_nibble(pair[1]).ok_or("Edge key contains a non-hex character")?;
            Ok((high << 4) | low)
        })
        .collect()
}

fn edge_hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

async fn decode_response<T: DeserializeOwned>(
    response: reqwest::Response,
) -> Result<T, EdgeNodeError> {
    let status = response.status();
    let bytes = response.bytes().await?;
    if !status.is_success() {
        let detail = serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .and_then(|value| {
                value
                    .get("message")
                    .or_else(|| value.get("error"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| String::from_utf8_lossy(&bytes).into_owned());
        return Err(format!("Edge Gateway returned HTTP {status}: {detail}").into());
    }
    Ok(serde_json::from_slice(&bytes)?)
}

/// One outbound Node process can multiplex multiple Jobs by running this
/// method in several tasks. Server-side claim limits remain authoritative.
#[derive(Clone)]
pub struct EdgeNodeWorker {
    gateway: EdgeGatewayClient,
    credentials: EdgeNodeCredentials,
    advertisement: EdgeNodeAdvertisement,
    runtime: MorphzRuntime,
    config: EdgeWorkerConfig,
    local_leases: EdgeLocalCapabilityLeaseStore,
}

#[derive(Debug, Clone)]
enum PreparedEdgeArtifactChannel {
    RuntimeToEdge {
        channel: EdgeArtifactDataChannel,
        stage: PathBuf,
    },
    EdgeToRuntime {
        channel: EdgeArtifactDataChannel,
        stage: PathBuf,
    },
}

impl PreparedEdgeArtifactChannel {
    fn stage(&self) -> &Path {
        match self {
            Self::RuntimeToEdge { channel, stage } | Self::EdgeToRuntime { channel, stage } => {
                let _ = channel.direction;
                stage
            }
        }
    }
}

async fn prepare_edge_artifact_upload(
    stage: &Path,
    output: &str,
    channel: &EdgeArtifactDataChannel,
) -> Result<(PathBuf, EdgeArtifactDataChannel), EdgeNodeError> {
    let receipt: crate::artifact::ArtifactTransferReceipt = serde_json::from_str(output)?;
    let is_directory = receipt.source.media_type.as_deref()
        == Some("application/vnd.morphz.directory")
        || tokio::fs::metadata(stage).await?.is_dir();
    if !is_directory {
        let mut upload_channel = channel.clone();
        upload_channel.payload_kind = EdgeArtifactPayloadKind::File;
        return Ok((stage.to_path_buf(), upload_channel));
    }

    let archive = stage.with_extension("archive");
    let (size_bytes, digest) = stage_edge_directory_archive(stage, &archive).await?;
    let mut upload_channel = channel.clone();
    upload_channel.payload_kind = EdgeArtifactPayloadKind::DirectoryArchive;
    upload_channel.expected_digest = Some(digest);
    upload_channel.size_bytes = Some(size_bytes);
    Ok((archive, upload_channel))
}

async fn cleanup_edge_artifact_stages(stage: &Path) {
    for path in [
        stage.to_path_buf(),
        stage.with_extension("tree"),
        stage.with_extension("archive"),
        stage.with_extension("metadata.json"),
        stage.with_extension("archive.metadata.json"),
    ] {
        let _ = tokio::fs::remove_file(&path).await;
        let _ = tokio::fs::remove_dir_all(&path).await;
    }
}

const EDGE_OUTPUT_CHUNK_BYTES: usize = 60 * 1024;

#[cfg(test)]
async fn close_and_drain_buffered_tool_output(
    output_rx: &mut tokio::sync::mpsc::Receiver<crate::tool::ToolOutputChunk>,
) -> Vec<crate::tool::ToolOutputChunk> {
    output_rx.close();
    let mut buffered = Vec::new();
    while let Some(chunk) = output_rx.recv().await {
        buffered.push(chunk);
    }
    buffered
}

fn bounded_edge_output_chunks(
    chunk: crate::tool::ToolOutputChunk,
) -> Vec<crate::tool::ToolOutputChunk> {
    if chunk.text.len() <= EDGE_OUTPUT_CHUNK_BYTES {
        return vec![chunk];
    }
    let mut chunks = Vec::new();
    let mut remaining = chunk.text.as_str();
    while !remaining.is_empty() {
        let mut split = remaining.len().min(EDGE_OUTPUT_CHUNK_BYTES);
        while split > 0 && !remaining.is_char_boundary(split) {
            split -= 1;
        }
        let (text, rest) = remaining.split_at(split.max(1));
        chunks.push(crate::tool::ToolOutputChunk {
            stream: chunk.stream,
            text: text.to_string(),
        });
        remaining = rest;
    }
    chunks
}

async fn forward_edge_tool_output(
    gateway: EdgeGatewayClient,
    credentials: EdgeNodeCredentials,
    command: EdgeCommandRecord,
    mut output_rx: tokio::sync::mpsc::Receiver<crate::tool::ToolOutputChunk>,
    mut close_rx: tokio::sync::oneshot::Receiver<()>,
) -> Result<(), EdgeNodeError> {
    let mut closing = false;
    loop {
        tokio::select! {
            _ = &mut close_rx, if !closing => {
                closing = true;
                // Preserve chunks already accepted by the bounded channel,
                // but stop making the parent command wait for a detached
                // child's pipe monitors to reach EOF.
                output_rx.close();
            }
            chunk = output_rx.recv() => {
                let Some(chunk) = chunk else {
                    return Ok(());
                };
                for chunk in bounded_edge_output_chunks(chunk) {
                    gateway.append_output(&credentials, &command, chunk).await?;
                }
            }
        }
    }
}

#[derive(Debug, Clone)]
struct EdgeBackgroundReceipt {
    local_task_id: String,
    background_source: String,
}

fn edge_background_receipt(output: &str) -> Option<EdgeBackgroundReceipt> {
    let value: serde_json::Value = serde_json::from_str(output).ok()?;
    (value.get("execution").and_then(serde_json::Value::as_str) == Some("background"))
        .then(|| EdgeBackgroundReceipt {
            local_task_id: value
                .get("task_id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string(),
            background_source: value
                .get("background_source")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("wait_timeout")
                .to_string(),
        })
        .filter(|receipt| !receipt.local_task_id.is_empty())
}

fn rewrite_edge_background_receipt(
    output: &str,
    central_task_id: &str,
) -> Result<String, EdgeNodeError> {
    let mut value: serde_json::Value = serde_json::from_str(output)?;
    let object = value
        .as_object_mut()
        .ok_or("managed background receipt must be a JSON object")?;
    object.insert("task_id".to_string(), serde_json::json!(central_task_id));
    object.insert("owner".to_string(), serde_json::json!("edge_worker"));
    Ok(serde_json::to_string(&value)?)
}

async fn supervise_edge_background_task(
    gateway: EdgeGatewayClient,
    credentials: EdgeNodeCredentials,
    parent_job_id: String,
    mut lease: EdgeBackgroundExecutionLease,
    local_task_id: String,
    lease_seconds: u64,
    heartbeat_interval: Duration,
) {
    let mut heartbeat = tokio::time::interval(heartbeat_interval);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        heartbeat.tick().await;
        let Some(snapshot) = crate::tool::edge_background_task_snapshot(&local_task_id) else {
            tracing::error!(
                parent_execution_job_id = %parent_job_id,
                execution_job_id = %lease.job.id,
                local_task_id = %local_task_id,
                event_code = "edge.background.local_owner_missing",
                "Edge background supervisor lost its local process handle"
            );
            return;
        };
        if snapshot.status.is_terminal() {
            let residual_note = format!(
                "\n[full Edge stdout/stderr archive remains on node '{}' at '{}']",
                credentials.node_id, snapshot.artifact_path
            );
            match gateway
                .finish_background_execution(
                    &credentials,
                    &parent_job_id,
                    &lease,
                    snapshot.exit_code.unwrap_or(-1),
                    snapshot.output_tail,
                    residual_note,
                )
                .await
            {
                Ok(_) => return,
                Err(error) => {
                    // The process has already reached a local terminal state,
                    // but the durable owner is still this Worker. Keep retrying
                    // the idempotent terminal commit instead of abandoning a
                    // Running ExecutionJob after a transient transport or
                    // database failure. A later ownership conflict fences this
                    // Worker through the same endpoint.
                    tracing::error!(
                        parent_execution_job_id = %parent_job_id,
                        execution_job_id = %lease.job.id,
                        %error,
                        event_code = "edge.background.terminal_commit_failed",
                        "Edge background terminal result could not be committed; retrying while ownership remains valid"
                    );
                    continue;
                }
            }
        }
        match gateway
            .heartbeat_background_execution(
                &credentials,
                &parent_job_id,
                &lease,
                true,
                Some(crate::execution::edge_background_process_progress_ref(
                    &credentials.node_id,
                    snapshot.process_group_id,
                    &snapshot.artifact_path,
                )),
                lease_seconds,
            )
            .await
        {
            Ok(job) => {
                let cancelled = job.cancel_requested_at.is_some();
                lease.job = job;
                if cancelled {
                    if let Err(error) = crate::tool::cancel_edge_background_task(&local_task_id) {
                        tracing::error!(
                            execution_job_id = %lease.job.id,
                            %error,
                            event_code = "edge.background.cancel_failed",
                            "Edge Worker could not terminate the cancelled background process group"
                        );
                    }
                }
            }
            Err(error) => {
                // Lost ownership is a fence, not a reason to continue an
                // unowned process. The new owner/reconciliation path decides
                // the durable terminal state.
                let _ = crate::tool::cancel_edge_background_task(&local_task_id);
                tracing::warn!(
                    parent_execution_job_id = %parent_job_id,
                    execution_job_id = %lease.job.id,
                    %error,
                    event_code = "edge.background.ownership_lost",
                    "Edge background heartbeat lost ownership; terminated the local process"
                );
                return;
            }
        }
    }
}

impl EdgeNodeWorker {
    pub fn new(
        gateway: EdgeGatewayClient,
        credentials: EdgeNodeCredentials,
        advertisement: EdgeNodeAdvertisement,
        runtime: MorphzRuntime,
        config: EdgeWorkerConfig,
    ) -> Self {
        let local_leases = EdgeLocalCapabilityLeaseStore::for_node(&credentials.node_id);
        Self {
            gateway,
            credentials,
            advertisement,
            runtime,
            config,
            local_leases,
        }
    }

    pub async fn advertise(&self) -> Result<ExecutionNodeRecord, EdgeNodeError> {
        self.gateway
            .heartbeat_node(&self.credentials, &self.advertisement)
            .await
    }

    /// Claims and completes at most one Job. `false` means the bounded
    /// long-poll returned without work and is not an error.
    pub async fn poll_once(&self) -> Result<bool, EdgeNodeError> {
        self.advertise().await?;
        let Some(mut command) = self.gateway.claim(&self.credentials, &self.config).await? else {
            return Ok(false);
        };

        // Generic physical tools are at-most-once after first poll. Artifact
        // Transfer is different: it publishes through deterministic staging,
        // validates content, and is explicitly reconcile-safe after a crash.
        let reconcile_safe_transfer = command.tool_name == ARTIFACT_TRANSFER_TOOL_NAME;
        let exec_defers_side_effect_until_spawn = command.tool_name == "exec";
        command = self
            .gateway
            .heartbeat_command(
                &self.credentials,
                &command,
                !reconcile_safe_transfer && !exec_defers_side_effect_until_spawn,
                Some(if exec_defers_side_effect_until_spawn {
                    "local exec preflight started".to_string()
                } else {
                    "local sandbox and tool execution started".to_string()
                }),
                self.config.lease_seconds,
            )
            .await?;
        if command.status == EdgeCommandStatus::CancelRequested {
            self.finish_cancelled_command(&command).await?;
            return Ok(true);
        }

        let (execution_command, provider_local_preauthorized, artifact_channel) =
            match self.prepare_execution_command(&command).await {
                Ok(prepared) => prepared,
                Err(error) => {
                    self.finish_preflight_failure(&command, &error).await?;
                    return Ok(true);
                }
            };
        let local_authority_approved = match self
            .authorize_local_capability(&execution_command, provider_local_preauthorized)
            .await
        {
            Ok(approved) => approved,
            Err(error) => {
                self.finish_preflight_failure(&command, &error).await?;
                return Ok(true);
            }
        };
        let requested_background = if execution_command.tool_name == "exec" {
            match crate::tool::managed_exec_background_request(&execution_command.arguments) {
                Ok(request) => request,
                Err(error) => {
                    let error: EdgeNodeError = error;
                    self.finish_preflight_failure(&command, &error).await?;
                    return Ok(true);
                }
            }
        } else {
            None
        };
        let mut background_lease = if let Some(request) = requested_background.as_ref() {
            match self
                .gateway
                .reserve_background_execution(
                    &self.credentials,
                    &command,
                    &self.config.worker_id,
                    &request.background_source,
                    self.config.lease_seconds,
                )
                .await
            {
                Ok(lease) => Some(lease),
                Err(error) => {
                    self.finish_preflight_failure(&command, &error).await?;
                    return Ok(true);
                }
            }
        } else {
            None
        };
        let edge_background_context = (execution_command.tool_name == "exec").then(|| {
            crate::tool::EdgeBackgroundTaskContext {
                task_id: background_lease.as_ref().map_or_else(
                    || format!("edge-local-background-{}", command.job_id),
                    |lease| lease.job.id.clone(),
                ),
            }
        });
        let (output_tx, output_rx) = tokio::sync::mpsc::channel(64);
        let (output_close_tx, output_close_rx) = tokio::sync::oneshot::channel();
        let output_forwarder = forward_edge_tool_output(
            self.gateway.clone(),
            self.credentials.clone(),
            command.clone(),
            output_rx,
            output_close_rx,
        );
        tokio::pin!(output_forwarder);
        let (side_effect_tx, mut side_effect_rx) = tokio::sync::mpsc::unbounded_channel();
        let execution = crate::tool::CURRENT_EDGE_BACKGROUND_TASK.scope(
            edge_background_context,
            crate::artifact::CURRENT_ARTIFACT_TRANSFER_SIDE_EFFECT.scope(
                side_effect_tx.clone(),
                crate::tool::CURRENT_PHYSICAL_SIDE_EFFECT.scope(
                    side_effect_tx,
                    self.runtime.execute_edge_tool_streaming(
                        &execution_command,
                        local_authority_approved,
                        Some(output_tx),
                    ),
                ),
            ),
        );
        tokio::pin!(execution);
        let mut heartbeat = tokio::time::interval(self.config.heartbeat_interval);
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut side_effect_open = true;
        let mut side_effect_recorded = command.side_effect_started_at.is_some();
        let mut execution_result = None;
        let mut output_forwarded = false;
        let mut output_close_tx = Some(output_close_tx);
        loop {
            tokio::select! {
                result = &mut execution, if execution_result.is_none() => {
                    execution_result = Some(result);
                    if let Some(close) = output_close_tx.take() {
                        let _ = close.send(());
                    }
                }
                output_result = &mut output_forwarder, if !output_forwarded => {
                    if let Err(error) = output_result {
                        tracing::warn!(
                            execution_job_id = %command.job_id,
                            %error,
                            event_code = "edge.output.forwarding_failed",
                            "Edge output forwarding failed; preserving command ownership and terminal delivery"
                        );
                    }
                    output_forwarded = true;
                }
                side_effect = side_effect_rx.recv(), if side_effect_open => {
                    let Some(acknowledge) = side_effect else {
                        side_effect_open = false;
                        continue;
                    };
                    // The Artifact backend is blocked on this acknowledgement
                    // immediately before it makes the destination visible.
                    // Persist the remote side-effect boundary first so a
                    // cancelled or crashed Worker can never be replayed as if
                    // publication had not started.
                    if let Some(lease) = background_lease.as_mut() {
                        lease.job = self.gateway.heartbeat_background_execution(
                            &self.credentials,
                            &command.job_id,
                            lease,
                            true,
                            Some(format!(
                                "edge://{}/{}/output",
                                self.credentials.node_id, lease.job.id
                            )),
                            self.config.lease_seconds,
                        ).await?;
                    }
                    command = self.gateway.heartbeat_command(
                        &self.credentials,
                        &command,
                        true,
                        Some("artifact destination publication started".to_string()),
                        self.config.lease_seconds,
                    ).await?;
                    side_effect_recorded = true;
                    let _ = acknowledge.send(());
                }
                _ = heartbeat.tick() => {
                    if let Some(lease) = background_lease.as_mut() {
                        lease.job = self.gateway.heartbeat_background_execution(
                            &self.credentials,
                            &command.job_id,
                            lease,
                            side_effect_recorded,
                            Some(format!(
                                "edge://{}/{}/output",
                                self.credentials.node_id, lease.job.id
                            )),
                            self.config.lease_seconds,
                        ).await?;
                    }
                    command = self.gateway.heartbeat_command(
                        &self.credentials,
                        &command,
                        (!reconcile_safe_transfer && !exec_defers_side_effect_until_spawn)
                            || side_effect_recorded,
                        Some("tool execution in progress".to_string()),
                        self.config.lease_seconds,
                    ).await?;
                    if command.status == EdgeCommandStatus::CancelRequested {
                        // Dropping the Tool future requests cancellation. OS process
                        // tools remain responsible for terminating their managed
                        // process group before their future is released.
                        if let Some(mut lease) = background_lease.take() {
                            lease.job = self.gateway.cancel_background_execution(
                                &self.credentials,
                                &command.job_id,
                                &lease,
                                "parent Edge Command was cancelled before its background receipt was delivered",
                            ).await?;
                            let _ = crate::tool::cancel_edge_background_task(&lease.job.id);
                            let _ = self.gateway.finish_background_execution(
                                &self.credentials,
                                &command.job_id,
                                &lease,
                                -9,
                                String::new(),
                                "\n[Edge background launch was cancelled before receipt delivery]".to_string(),
                            ).await;
                        }
                        self.finish_cancelled_command(&command).await?;
                        return Ok(true);
                    }
                    self.advertise().await?;
                }
            }
            if output_forwarded {
                if let Some(result) = execution_result.take() {
                    let mut succeeded = false;
                    match result {
                        Ok(mut output) => {
                            let mut background_supervisor = None;
                            if let Some(receipt) = edge_background_receipt(&output) {
                                if background_lease.is_none() {
                                    let mut lease = self
                                        .gateway
                                        .reserve_background_execution(
                                            &self.credentials,
                                            &command,
                                            &self.config.worker_id,
                                            &receipt.background_source,
                                            self.config.lease_seconds,
                                        )
                                        .await?;
                                    lease.job = self
                                        .gateway
                                        .heartbeat_background_execution(
                                            &self.credentials,
                                            &command.job_id,
                                            &lease,
                                            true,
                                            Some(format!(
                                                "edge://{}/{}/output",
                                                self.credentials.node_id, lease.job.id
                                            )),
                                            self.config.lease_seconds,
                                        )
                                        .await?;
                                    background_lease = Some(lease);
                                }
                                let lease = background_lease
                                    .take()
                                    .ok_or("Edge background receipt has no durable child lease")?;
                                if requested_background.is_some()
                                    && receipt.local_task_id != lease.job.id
                                {
                                    return Err(format!(
                                        "Edge explicit background receipt task '{}' does not match reserved child '{}'",
                                        receipt.local_task_id, lease.job.id
                                    )
                                    .into());
                                }
                                let mut lease = lease;
                                let snapshot = crate::tool::edge_background_task_snapshot(
                                    &receipt.local_task_id,
                                )
                                .ok_or_else(|| {
                                    format!(
                                        "Edge background receipt '{}' has no physical process owner checkpoint",
                                        receipt.local_task_id
                                    )
                                })?;
                                let progress_ref =
                                    crate::execution::edge_background_process_progress_ref(
                                        &self.credentials.node_id,
                                        snapshot.process_group_id,
                                        &snapshot.artifact_path,
                                    );
                                lease.job = self
                                    .gateway
                                    .heartbeat_background_execution(
                                        &self.credentials,
                                        &command.job_id,
                                        &lease,
                                        true,
                                        Some(progress_ref),
                                        self.config.lease_seconds,
                                    )
                                    .await?;
                                output = rewrite_edge_background_receipt(&output, &lease.job.id)?;
                                background_supervisor = Some((lease, receipt.local_task_id));
                            }
                            let upload_error =
                                if let Some(PreparedEdgeArtifactChannel::EdgeToRuntime {
                                    channel,
                                    stage,
                                }) = artifact_channel.as_ref()
                                {
                                    match prepare_edge_artifact_upload(stage, &output, channel)
                                        .await
                                    {
                                        Ok((upload_path, upload_channel)) => self
                                            .gateway
                                            .upload_artifact(
                                                &self.credentials,
                                                &command,
                                                &upload_path,
                                                &upload_channel,
                                            )
                                            .await
                                            .err(),
                                        Err(error) => Some(error),
                                    }
                                } else {
                                    None
                                };
                            if let Some(error) = upload_error {
                                self.gateway
                                    .finish_command(
                                        &self.credentials,
                                        &command,
                                        EdgeCommandStatus::Failed,
                                        None,
                                        Some(format!("Artifact upload failed: {error}")),
                                    )
                                    .await?;
                            } else {
                                succeeded = true;
                                self.gateway
                                    .finish_command(
                                        &self.credentials,
                                        &command,
                                        EdgeCommandStatus::Succeeded,
                                        Some(output),
                                        None,
                                    )
                                    .await?;
                                if let Some((lease, local_task_id)) = background_supervisor {
                                    tokio::spawn(supervise_edge_background_task(
                                        self.gateway.clone(),
                                        self.credentials.clone(),
                                        command.job_id.clone(),
                                        lease,
                                        local_task_id,
                                        self.config.lease_seconds,
                                        self.config.heartbeat_interval,
                                    ));
                                }
                            }
                        }
                        Err(error) => {
                            if let Some(lease) = background_lease.take() {
                                let _ = self
                                    .gateway
                                    .finish_background_execution(
                                        &self.credentials,
                                        &command.job_id,
                                        &lease,
                                        -1,
                                        String::new(),
                                        format!("\n[Edge background spawn failed: {error}]"),
                                    )
                                    .await;
                            }
                            self.gateway
                                .finish_command(
                                    &self.credentials,
                                    &command,
                                    EdgeCommandStatus::Failed,
                                    None,
                                    Some(error.to_string()),
                                )
                                .await?;
                        }
                    }
                    // Preserve partial stages after a transport failure so a
                    // recovered deterministic Job resumes instead of sending
                    // the prefix again. Successful publication can be swept.
                    if succeeded {
                        if let Some(channel) = artifact_channel.as_ref() {
                            cleanup_edge_artifact_stages(channel.stage()).await;
                        }
                    }
                    return Ok(true);
                }
            }
        }
    }

    async fn finish_preflight_failure(
        &self,
        command: &EdgeCommandRecord,
        error: &EdgeNodeError,
    ) -> Result<(), EdgeNodeError> {
        self.gateway
            .finish_command(
                &self.credentials,
                command,
                EdgeCommandStatus::Failed,
                None,
                Some(format!("Edge local preflight failed: {error}")),
            )
            .await?;
        Ok(())
    }

    async fn finish_cancelled_command(
        &self,
        command: &EdgeCommandRecord,
    ) -> Result<(), EdgeNodeError> {
        self.gateway
            .finish_command(
                &self.credentials,
                command,
                EdgeCommandStatus::Cancelled,
                None,
                Some("cancelled by cloud control plane".to_string()),
            )
            .await?;
        Ok(())
    }

    async fn prepare_execution_command(
        &self,
        command: &EdgeCommandRecord,
    ) -> Result<(EdgeCommandRecord, bool, Option<PreparedEdgeArtifactChannel>), EdgeNodeError> {
        if command.tool_name == ARTIFACT_TRANSFER_TOOL_NAME {
            let channel = edge_artifact_data_channel_from_route(&command.route)?;
            let routes: ArtifactTransferRouteSnapshot =
                serde_json::from_value(command.route.clone())?;
            if routes.source.backend_kind == ExecutionTargetKind::ManagedSsh
                || routes.destination.backend_kind == ExecutionTargetKind::ManagedSsh
            {
                if channel.is_some() {
                    return Err(
                        "Edge proxy Managed SSH v1 does not accept a Runtime byte channel".into(),
                    );
                }
                let prepared = prepare_edge_proxy_artifact_transfer_command(
                    command,
                    &self.credentials.node_id,
                )?;
                // The transfer dispatcher below performs the exact local
                // filesystem/network approval. Avoid asking twice through the
                // generic Tool preflight, whose route shape is single-target.
                return Ok((prepared, true, None));
            }
            let stage = if channel.is_some() {
                Some(
                    self.runtime
                        .artifact_transfer_stages()
                        .prepare_stage_path(&command.job_id, ArtifactTransferStageKind::EdgeLocal)
                        .await?,
                )
            } else {
                None
            };
            if let (Some(channel), Some(stage)) = (channel.as_ref(), stage.as_ref()) {
                if channel.direction == EdgeArtifactDataDirection::RuntimeToEdge {
                    self.gateway
                        .download_artifact(&self.credentials, command, stage, channel)
                        .await?;
                }
            }
            let materialized_stage = match (channel.as_ref(), stage.as_ref()) {
                (Some(channel), Some(stage))
                    if channel.direction == EdgeArtifactDataDirection::RuntimeToEdge
                        && channel.payload_kind == EdgeArtifactPayloadKind::DirectoryArchive =>
                {
                    let tree = stage.with_extension("tree");
                    materialize_edge_directory_archive(stage, &tree).await?;
                    Some(tree)
                }
                _ => None,
            };
            let prepared = prepare_edge_local_artifact_transfer_command(
                command,
                &self.credentials.node_id,
                channel.as_ref(),
                materialized_stage.as_deref().or(stage.as_deref()),
            )?;
            let artifact_channel = match (channel, stage) {
                (Some(channel), Some(stage))
                    if channel.direction == EdgeArtifactDataDirection::RuntimeToEdge =>
                {
                    Some(PreparedEdgeArtifactChannel::RuntimeToEdge { channel, stage })
                }
                (Some(channel), Some(stage)) => {
                    Some(PreparedEdgeArtifactChannel::EdgeToRuntime { channel, stage })
                }
                _ => None,
            };
            return Ok((prepared, false, artifact_channel));
        }
        let route: ExecutionRouteSnapshot = serde_json::from_value(command.route.clone())?;
        if route.target_id != command.target_id
            || route.provider_node_id.as_deref() != Some(self.credentials.node_id.as_str())
        {
            return Err(format!(
                "frozen Route for Edge Command '{}' is inconsistent with Target/Provider",
                command.job_id
            )
            .into());
        }
        match route.backend_kind {
            ExecutionTargetKind::EdgeNode => Ok((command.clone(), false, None)),
            ExecutionTargetKind::ManagedSsh => {
                let endpoint_ref = route
                    .endpoint_ref
                    .as_deref()
                    .ok_or("Managed SSH Route is missing endpoint_ref")?;
                let endpoint = ManagedSshEndpoint::load(endpoint_ref)?;
                if command.tool_name != "exec" {
                    return Err(format!(
                        "Managed SSH v1 supports only exec; Target '{}' received unsupported tool '{}'",
                        command.target_id, command.tool_name
                    )
                    .into());
                }
                let mut prepared = command.clone();
                prepared.arguments = prepare_managed_ssh_exec_arguments(
                    endpoint_ref,
                    &endpoint,
                    &command.target_id,
                    &command.arguments,
                )?;
                Ok((prepared, true, None))
            }
            other => Err(format!(
                "Edge Node cannot serve a Route with backend_kind='{}'",
                other.as_str()
            )
            .into()),
        }
    }

    async fn authorize_local_capability(
        &self,
        command: &EdgeCommandRecord,
        provider_local_preauthorized: bool,
    ) -> Result<bool, EdgeNodeError> {
        if provider_local_preauthorized {
            return Ok(true);
        }
        let Some(requirement) = self.runtime.edge_tool_approval_requirement(command)? else {
            return Ok(false);
        };
        let scope = edge_execution_scope_from_route(&command.route)?;
        let route: ExecutionRouteSnapshot = serde_json::from_value(command.route.clone())?;
        let capability = requirement.action.lease_capability();
        let policy_digest = capability_lease_policy_digest(
            &self.runtime.execution_policy_digest(),
            &route.policy_digest,
        );
        if self.local_leases.covers(
            &scope,
            &command.target_id,
            &capability,
            &requirement.requested,
            &policy_digest,
        ) {
            return Ok(true);
        }

        let ttl = self
            .runtime
            .config()
            .edge_execution
            .capability_lease_ttl
            .as_secs()
            .max(1);
        let expires_at =
            Utc::now() + chrono::Duration::seconds(i64::try_from(ttl).unwrap_or(i64::MAX));
        let approval_id = format!(
            "edge-local-approval:{}:{}",
            command.job_id, command.revision
        );
        let decision = self
            .runtime
            .review_edge_tool_permission(&ApprovalRequest {
                approval_id: approval_id.clone(),
                context_id: scope.context_id.clone(),
                session_id: scope.session_id.clone(),
                attempt_id: command.job_id.clone(),
                thread_id: scope.thread_id.clone(),
                root_turn_id: command.job_id.clone(),
                trigger_event_id: command.job_id.clone(),
                trigger_sequence: 0,
                action: requirement.action,
                requested: requirement.requested.clone(),
                justification: format!(
                    "Edge Node '{}' executes tool '{}' on Target '{}' under local policy: {}",
                    self.credentials.node_id,
                    command.tool_name,
                    command.target_id,
                    requirement.justification
                ),
                lease_offer: Some(CapabilityLeaseOffer {
                    principal_id: scope.principal_id.clone(),
                    agent_id: scope.agent_id.clone(),
                    thread_id: scope.thread_id.clone(),
                    target_id: command.target_id.clone(),
                    capability: capability.clone(),
                    requested: requirement.requested.clone(),
                    policy_digest: policy_digest.clone(),
                    expires_at,
                }),
            })
            .await?;
        match decision {
            ApprovalDecision::AllowOnce { rationale, .. } => {
                tracing::info!(event_code = "edge.approval.allow_once", %rationale, target_id = %command.target_id, "Edge-local approval allowed one execution");
                Ok(true)
            }
            ApprovalDecision::AllowLease { rationale, .. } => {
                let id_material = format!(
                    "{}\0{}\0{}\0{}\0{}",
                    scope.principal_id,
                    scope.agent_id,
                    scope.thread_id,
                    command.target_id,
                    capability
                );
                let lease = EdgeLocalCapabilityLease {
                    id: format!(
                        "edge_local_lease_{:x}",
                        Sha256::digest(id_material.as_bytes())
                    ),
                    principal_id: scope.principal_id,
                    agent_id: scope.agent_id,
                    thread_id: scope.thread_id,
                    target_id: command.target_id.clone(),
                    capability,
                    requested: requirement.requested,
                    policy_digest,
                    issued_at: Utc::now(),
                    expires_at,
                    revoked_at: None,
                };
                self.local_leases.grant(lease)?;
                tracing::info!(event_code = "edge.approval.capability_lease_issued", %rationale, target_id = %command.target_id, "Edge-local approval issued a restricted Capability Lease");
                Ok(true)
            }
            ApprovalDecision::Deny { rationale, .. } => {
                Err(format!("Edge local approval rejected execution: {rationale}").into())
            }
            ApprovalDecision::AskHuman { rationale, .. } => Err(format!(
                "Edge local approval requires human confirmation, but the current local approval channel has not completed a decision: {rationale}"
            )
            .into()),
        }
    }

    /// Persistent outbound loop with bounded exponential reconnect backoff.
    /// A clean shutdown signal interrupts both long-poll and local execution;
    /// the cloud reconciler then applies the same side-effect-boundary rules
    /// used for process crashes and network loss.
    pub async fn run_until_shutdown(
        self,
        mut shutdown: tokio::sync::watch::Receiver<bool>,
    ) -> Result<(), EdgeNodeError> {
        let mut failures = 0_u32;
        loop {
            if *shutdown.borrow() {
                return Ok(());
            }
            let poll = self.poll_once();
            tokio::pin!(poll);
            let result = tokio::select! {
                result = &mut poll => result,
                changed = shutdown.changed() => {
                    if changed.is_err() || *shutdown.borrow() {
                        return Ok(());
                    }
                    continue;
                }
            };
            match result {
                Ok(_) => failures = 0,
                Err(error) => {
                    failures = failures.saturating_add(1);
                    let delay = 1_u64.checked_shl(failures.min(6)).unwrap_or(60).min(60);
                    tracing::warn!(event_code = "edge.connection_or_execution.retrying", %error, delay_seconds = delay, "Edge Node connection or execution failed; retrying with backoff");
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_secs(delay)) => {}
                        changed = shutdown.changed() => {
                            if changed.is_err() || *shutdown.borrow() {
                                return Ok(());
                            }
                        }
                    }
                }
            }
        }
    }
}

fn prepare_edge_proxy_artifact_transfer_command(
    command: &EdgeCommandRecord,
    node_id: &str,
) -> Result<EdgeCommandRecord, EdgeNodeError> {
    let routes: ArtifactTransferRouteSnapshot = serde_json::from_value(command.route.clone())?;
    let belongs_to_node = |route: &ExecutionRouteSnapshot| {
        matches!(
            route.backend_kind,
            ExecutionTargetKind::EdgeNode | ExecutionTargetKind::ManagedSsh
        ) && route.provider_node_id.as_deref() == Some(node_id)
    };
    if command.provider_node_id != node_id
        || !belongs_to_node(&routes.source)
        || !belongs_to_node(&routes.destination)
        || (routes.source.backend_kind != ExecutionTargetKind::ManagedSsh
            && routes.destination.backend_kind != ExecutionTargetKind::ManagedSsh)
    {
        return Err(format!(
            "Edge Artifact proxy Command '{}' is not an authoritative Route for the current Node",
            command.job_id
        )
        .into());
    }
    let scope = edge_execution_scope_from_route(&command.route)?;
    let localize_route = |mut route: ExecutionRouteSnapshot| {
        route.provider_node_id = None;
        if route.backend_kind == ExecutionTargetKind::EdgeNode {
            route.target_id = DEFAULT_EXECUTION_TARGET_ID.to_string();
            route.backend_kind = ExecutionTargetKind::InProcessLocal;
            route.endpoint_ref = None;
        }
        route
    };
    let localized = ArtifactTransferRouteSnapshot {
        source: localize_route(routes.source.clone()),
        destination: localize_route(routes.destination.clone()),
    };
    let mut request = transfer_request_from_tool_arguments(
        &command.arguments,
        format!("transfer:{}", command.job_id),
    )?;
    if request.source.target_id != routes.source.target_id
        || request.destination.target_id != routes.destination.target_id
    {
        return Err("Edge Artifact proxy request does not match the frozen Route".into());
    }
    request.source.target_id = localized.source.target_id.clone();
    request.destination.target_id = localized.destination.target_id.clone();

    let mut route = serde_json::to_value(&localized)?;
    route
        .as_object_mut()
        .ok_or("Edge Artifact proxy Route must be an object")?
        .insert(
            EDGE_EXECUTION_SCOPE_KEY.to_string(),
            serde_json::to_value(scope)?,
        );
    let mut prepared = command.clone();
    prepared.target_id = localized.destination.target_id.clone();
    prepared.arguments = execution_arguments_from_transfer_request(&request)?;
    prepared.route = route;
    Ok(prepared)
}

/// Localize the cloud-authoritative dual Target route into the Edge Node's
/// own execution namespace.  The remote Target IDs remain frozen in the
/// cloud-side Job/Receipt; the physical Tool only ever sees `target-default`
/// and is therefore authorized by the Edge Node's existing PermissionBroker.
fn prepare_edge_local_artifact_transfer_command(
    command: &EdgeCommandRecord,
    node_id: &str,
    channel: Option<&EdgeArtifactDataChannel>,
    stage: Option<&Path>,
) -> Result<EdgeCommandRecord, EdgeNodeError> {
    let routes: ArtifactTransferRouteSnapshot = serde_json::from_value(command.route.clone())?;
    let edge_route = match channel.map(|channel| channel.direction) {
        None if routes.source.backend_kind == ExecutionTargetKind::EdgeNode
            && routes.destination.backend_kind == ExecutionTargetKind::EdgeNode
            && routes.source.target_id == routes.destination.target_id =>
        {
            &routes.source
        }
        Some(EdgeArtifactDataDirection::RuntimeToEdge)
            if (routes.source.backend_kind == ExecutionTargetKind::InProcessLocal
                || routes.source.backend_kind == ExecutionTargetKind::EdgeNode)
                && routes.destination.backend_kind == ExecutionTargetKind::EdgeNode =>
        {
            &routes.destination
        }
        Some(EdgeArtifactDataDirection::EdgeToRuntime)
            if routes.source.backend_kind == ExecutionTargetKind::EdgeNode
                && (routes.destination.backend_kind == ExecutionTargetKind::InProcessLocal
                    || routes.destination.backend_kind == ExecutionTargetKind::EdgeNode) =>
        {
            &routes.source
        }
        _ => {
            return Err(format!(
                "dual Routes for Edge Artifact Command '{}' are inconsistent with the data channel",
                command.job_id
            )
            .into())
        }
    };
    if edge_route.target_id != command.target_id
        || edge_route.provider_node_id.as_deref() != Some(node_id)
        || command.provider_node_id != node_id
    {
        return Err(format!(
            "Edge Artifact Command '{}' is not an authoritative Route for the current Node",
            command.job_id
        )
        .into());
    }

    let scope = edge_execution_scope_from_route(&command.route)?;
    let mut request = transfer_request_from_tool_arguments(
        &command.arguments,
        format!("transfer:{}", command.job_id),
    )?;
    if request.source.target_id != routes.source.target_id
        || request.destination.target_id != routes.destination.target_id
    {
        return Err(format!(
            "request location for Edge Artifact Command '{}' is inconsistent with the frozen Route",
            command.job_id
        )
        .into());
    }
    match channel.map(|channel| channel.direction) {
        None => {
            request.source.target_id = DEFAULT_EXECUTION_TARGET_ID.to_string();
            request.destination.target_id = DEFAULT_EXECUTION_TARGET_ID.to_string();
        }
        Some(EdgeArtifactDataDirection::RuntimeToEdge) => {
            let stage = stage.ok_or("Runtime-to-Edge Artifact Command is missing a local stage")?;
            request.source = ArtifactLocation {
                target_id: DEFAULT_EXECUTION_TARGET_ID.to_string(),
                workspace_identity: None,
                path: stage.to_string_lossy().into_owned(),
            };
            request.destination.target_id = DEFAULT_EXECUTION_TARGET_ID.to_string();
            // File payload bytes are the logical Artifact. A directory payload
            // is only a transport archive, so retain the caller's logical
            // precondition and let the local directory Tool validate it.
            if channel.is_some_and(|value| value.payload_kind == EdgeArtifactPayloadKind::File) {
                request.expected_source_digest =
                    channel.and_then(|value| value.expected_digest.clone());
            }
        }
        Some(EdgeArtifactDataDirection::EdgeToRuntime) => {
            let stage = stage.ok_or("Edge-to-Runtime Artifact Command is missing a local stage")?;
            request.source.target_id = DEFAULT_EXECUTION_TARGET_ID.to_string();
            request.destination = ArtifactLocation {
                target_id: DEFAULT_EXECUTION_TARGET_ID.to_string(),
                workspace_identity: None,
                path: stage.to_string_lossy().into_owned(),
            };
            request.overwrite = ArtifactOverwritePolicy::Replace;
        }
    }

    let mut local_route = serde_json::to_value(edge_route)?;
    let object = local_route
        .as_object_mut()
        .ok_or("Edge local Route must be encoded as a JSON object")?;
    object.insert(
        "target_id".to_string(),
        serde_json::Value::String(DEFAULT_EXECUTION_TARGET_ID.to_string()),
    );
    object.insert(
        EDGE_EXECUTION_SCOPE_KEY.to_string(),
        serde_json::to_value(scope)?,
    );

    let mut prepared = command.clone();
    prepared.arguments = execution_arguments_from_transfer_request(&request)?;
    prepared.route = local_route;
    Ok(prepared)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifact::{ArtifactLocation, ArtifactOverwritePolicy, ArtifactTransferRequest};
    use axum::{
        body::{to_bytes, Body},
        extract::{Path as AxumPath, State},
        http::{HeaderMap, StatusCode},
        response::{IntoResponse, Response},
        routing::{get, post},
        Json, Router,
    };
    use std::collections::{HashMap, VecDeque};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct EdgeWorkerTestClient;

    #[async_trait::async_trait]
    impl crate::llm::Client for EdgeWorkerTestClient {
        async fn create_completion(
            &self,
            _messages: Vec<crate::llm::Message>,
            _tools: Vec<crate::llm::ToolDefinition>,
        ) -> Result<crate::llm::Response, Box<dyn std::error::Error + Send + Sync>> {
            Err("Edge worker execution test does not evaluate a model".into())
        }
    }

    #[derive(Clone)]
    struct EdgeWorkerGatewayState {
        node: ExecutionNodeRecord,
        queued: Arc<tokio::sync::Mutex<VecDeque<EdgeCommandRecord>>>,
        active: Arc<tokio::sync::Mutex<HashMap<String, EdgeCommandRecord>>>,
        finished: Arc<tokio::sync::Mutex<Vec<EdgeCommandRecord>>>,
        output_sequence: Arc<AtomicUsize>,
        command_heartbeats: Arc<AtomicUsize>,
        background_jobs: Arc<tokio::sync::Mutex<HashMap<String, ExecutionJobRecord>>>,
        background_finished: Arc<tokio::sync::Mutex<Vec<ExecutionJobRecord>>>,
    }

    async fn test_worker_node_heartbeat(
        State(state): State<EdgeWorkerGatewayState>,
        Json(_command): Json<ExecutionNodeHeartbeatCommand>,
    ) -> Json<ExecutionNodeRecord> {
        Json(state.node)
    }

    async fn test_worker_claim(
        State(state): State<EdgeWorkerGatewayState>,
        Json(_claim): Json<ClaimEdgeCommand>,
    ) -> Response {
        let Some(command) = state.queued.lock().await.pop_front() else {
            return StatusCode::NO_CONTENT.into_response();
        };
        state
            .active
            .lock()
            .await
            .insert(command.job_id.clone(), command.clone());
        Json(serde_json::json!({ "job": command })).into_response()
    }

    async fn test_worker_command_heartbeat(
        State(state): State<EdgeWorkerGatewayState>,
        AxumPath((_node_id, job_id)): AxumPath<(String, String)>,
        Json(heartbeat): Json<HeartbeatEdgeCommand>,
    ) -> Response {
        let mut active = state.active.lock().await;
        let command = active.get_mut(&job_id).unwrap();
        assert_eq!(command.revision, heartbeat.expected_revision);
        command.revision += 1;
        command.heartbeat_at = Some(Utc::now());
        command.lease_expires_at =
            Some(Utc::now() + chrono::Duration::seconds(heartbeat.lease_seconds as i64));
        if heartbeat.side_effect_started && command.side_effect_started_at.is_none() {
            command.side_effect_started_at = Some(Utc::now());
        }
        command.progress = heartbeat.progress;
        state.command_heartbeats.fetch_add(1, Ordering::SeqCst);
        Json(command.clone()).into_response()
    }

    async fn test_worker_append_output(
        State(state): State<EdgeWorkerGatewayState>,
        AxumPath((_node_id, job_id)): AxumPath<(String, String)>,
        Json(command): Json<AppendEdgeOutputCommand>,
    ) -> Json<crate::memory::EdgeCommandOutputChunk> {
        // Model a slow central consumer so a chatty foreground process can
        // fill the bounded local channel. Command heartbeats must remain
        // independent of this forwarding backpressure.
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let sequence = state.output_sequence.fetch_add(1, Ordering::SeqCst) as u64 + 1;
        Json(crate::memory::EdgeCommandOutputChunk {
            job_id,
            sequence,
            stream: command.stream,
            text: command.text,
            created_at: Utc::now(),
        })
    }

    async fn test_worker_finish(
        State(state): State<EdgeWorkerGatewayState>,
        AxumPath((_node_id, job_id)): AxumPath<(String, String)>,
        Json(finish): Json<FinishEdgeCommand>,
    ) -> Json<EdgeCommandRecord> {
        let mut active = state.active.lock().await;
        let mut command = active.remove(&job_id).unwrap();
        assert_eq!(command.revision, finish.expected_revision);
        command.revision += 1;
        command.status = finish.status;
        command.output = finish.output;
        command.error = finish.error;
        command.updated_at = Utc::now();
        command.finished_at = Some(command.updated_at);
        drop(active);
        state.finished.lock().await.push(command.clone());
        Json(command)
    }

    async fn test_worker_reserve_background(
        State(state): State<EdgeWorkerGatewayState>,
        AxumPath((_node_id, parent_job_id)): AxumPath<(String, String)>,
        Json(reserve): Json<ReserveEdgeBackgroundExecutionCommand>,
    ) -> Json<EdgeBackgroundExecutionLease> {
        let now = Utc::now();
        let task_id = format!("background-{parent_job_id}");
        let job = ExecutionJobRecord {
            id: task_id.clone(),
            revision: 2,
            activation_id: format!("activation-{parent_job_id}"),
            thread_id: "thread-a".to_string(),
            agent_id: "agent-a".to_string(),
            context_id: "context-a".to_string(),
            session_id: "session-a".to_string(),
            initiating_principal_id: Some("principal-a".to_string()),
            target_id: "target-edge-background".to_string(),
            tool_call_id: format!("{parent_job_id}:background"),
            tool_name: "exec/background".to_string(),
            request: serde_json::json!({
                "background_source": reserve.background_source,
            }),
            status: crate::memory::ExecutionJobStatus::Running,
            retry_safety: crate::memory::ExecutionRetrySafety::ReconcileRequired,
            claimed_by: Some(reserve.worker_id),
            claim_token: Some(reserve.child_claim_token.clone()),
            lease_expires_at: Some(now + chrono::Duration::seconds(30)),
            heartbeat_at: Some(now),
            approval_ref: None,
            side_effect_started_at: None,
            cancel_requested_at: None,
            cancel_reason: None,
            progress_ref: None,
            checkpoint_generation: None,
            checkpoint_due_at: None,
            result_event_id: None,
            result_refs: Vec::new(),
            error: None,
            exit_code: None,
            created_at: now,
            started_at: Some(now),
            updated_at: now,
            finished_at: None,
        };
        state
            .background_jobs
            .lock()
            .await
            .insert(task_id, job.clone());
        Json(EdgeBackgroundExecutionLease {
            job,
            claim_token: reserve.child_claim_token,
        })
    }

    async fn test_worker_heartbeat_background(
        State(state): State<EdgeWorkerGatewayState>,
        AxumPath((_node_id, _parent_job_id, task_id)): AxumPath<(String, String, String)>,
        Json(heartbeat): Json<HeartbeatEdgeBackgroundExecutionCommand>,
    ) -> Json<ExecutionJobRecord> {
        let mut jobs = state.background_jobs.lock().await;
        let job = jobs.get_mut(&task_id).unwrap();
        assert_eq!(job.revision, heartbeat.expected_revision);
        assert_eq!(
            job.claim_token.as_deref(),
            Some(heartbeat.claim_token.as_str())
        );
        job.revision += 1;
        job.heartbeat_at = Some(Utc::now());
        job.lease_expires_at = Some(Utc::now() + chrono::Duration::seconds(30));
        if heartbeat.side_effect_started && job.side_effect_started_at.is_none() {
            job.side_effect_started_at = Some(Utc::now());
        }
        job.progress_ref = heartbeat.progress_ref;
        Json(job.clone())
    }

    async fn test_worker_finish_background(
        State(state): State<EdgeWorkerGatewayState>,
        AxumPath((_node_id, _parent_job_id, task_id)): AxumPath<(String, String, String)>,
        Json(finish): Json<FinishEdgeBackgroundExecutionCommand>,
    ) -> Json<serde_json::Value> {
        let mut jobs = state.background_jobs.lock().await;
        let job = jobs.get_mut(&task_id).unwrap();
        assert_eq!(
            job.claim_token.as_deref(),
            Some(finish.claim_token.as_str())
        );
        job.revision += 1;
        job.status = if finish.exit_code == 0 {
            crate::memory::ExecutionJobStatus::Succeeded
        } else {
            crate::memory::ExecutionJobStatus::Failed
        };
        job.exit_code = Some(finish.exit_code);
        job.finished_at = Some(Utc::now());
        job.updated_at = job.finished_at.unwrap();
        state.background_finished.lock().await.push(job.clone());
        Json(serde_json::json!({ "committed": true }))
    }

    fn edge_worker_test_command(
        job_id: &str,
        node_id: &str,
        target_id: &str,
        arguments: serde_json::Value,
    ) -> EdgeCommandRecord {
        let mut route = serde_json::to_value(ExecutionRouteSnapshot {
            route_id: format!("route:{target_id}:r1"),
            target_id: target_id.to_string(),
            target_revision: 1,
            provider_node_id: Some(node_id.to_string()),
            backend_kind: ExecutionTargetKind::EdgeNode,
            endpoint_ref: None,
            policy_digest: "edge-worker-test-policy".to_string(),
        })
        .unwrap();
        route.as_object_mut().unwrap().insert(
            EDGE_EXECUTION_SCOPE_KEY.to_string(),
            serde_json::to_value(scope()).unwrap(),
        );
        let now = Utc::now();
        EdgeCommandRecord {
            job_id: job_id.to_string(),
            revision: 1,
            target_id: target_id.to_string(),
            provider_node_id: node_id.to_string(),
            tool_name: "exec".to_string(),
            arguments: arguments.to_string(),
            route,
            status: EdgeCommandStatus::Claimed,
            claimed_by: Some("edge-worker-test".to_string()),
            claim_token: Some(format!("claim-{job_id}")),
            lease_expires_at: Some(now + chrono::Duration::seconds(1)),
            heartbeat_at: Some(now),
            side_effect_started_at: None,
            progress: None,
            output: None,
            error: None,
            created_at: now,
            updated_at: now,
            finished_at: None,
        }
    }

    #[derive(Clone)]
    struct InterruptedArtifactUploadState {
        job_id: String,
        expected_digest: String,
        expected_size: u64,
        stored: Arc<tokio::sync::Mutex<Vec<u8>>>,
        offsets: Arc<tokio::sync::Mutex<Vec<u64>>>,
        attempts: Arc<AtomicUsize>,
    }

    async fn inspect_interrupted_artifact_upload(
        State(state): State<InterruptedArtifactUploadState>,
    ) -> impl IntoResponse {
        let offset = state.stored.lock().await.len() as u64;
        Json(EdgeArtifactUploadStatus {
            job_id: state.job_id,
            offset,
            completed: offset == state.expected_size,
        })
    }

    async fn receive_interrupted_artifact_upload(
        State(state): State<InterruptedArtifactUploadState>,
        headers: HeaderMap,
        body: Body,
    ) -> Response {
        let offset = headers
            .get("x-morphz-artifact-offset")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap();
        state.offsets.lock().await.push(offset);
        let bytes = to_bytes(body, usize::MAX).await.unwrap();
        let mut stored = state.stored.lock().await;
        if offset != stored.len() as u64 {
            return StatusCode::CONFLICT.into_response();
        }
        if state.attempts.fetch_add(1, Ordering::SeqCst) == 0 {
            // Simulate a network/server failure after a durable prefix has
            // arrived. The Edge client must inspect the authoritative offset
            // and seek its source instead of appending the whole file again.
            let retained = (bytes.len() / 2).max(1);
            stored.extend_from_slice(&bytes[..retained]);
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
        stored.extend_from_slice(&bytes);
        if stored.len() as u64 != state.expected_size {
            return StatusCode::CONFLICT.into_response();
        }
        Json(EdgeArtifactUploadReceipt {
            job_id: state.job_id,
            content_digest: state.expected_digest,
            size_bytes: state.expected_size,
        })
        .into_response()
    }

    fn scope() -> EdgeExecutionScope {
        EdgeExecutionScope {
            principal_id: "principal-a".to_string(),
            agent_id: "agent-a".to_string(),
            context_id: "context-a".to_string(),
            session_id: "session-a".to_string(),
            thread_id: "thread-a".to_string(),
        }
    }

    #[tokio::test]
    async fn parent_output_drain_is_bounded_by_buffer_not_background_sender_lifetime() {
        let (output_tx, mut output_rx) = tokio::sync::mpsc::channel(4);
        output_tx
            .send(crate::tool::ToolOutputChunk {
                stream: crate::memory::EdgeOutputStream::Stdout,
                text: "before-background-receipt".to_string(),
            })
            .await
            .unwrap();
        let background_monitor_sender = output_tx.clone();

        let buffered = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            close_and_drain_buffered_tool_output(&mut output_rx),
        )
        .await
        .expect("Edge parent drain waited for a background monitor sender to close");

        assert_eq!(buffered.len(), 1);
        assert_eq!(buffered[0].text, "before-background-receipt");
        assert!(
            background_monitor_sender
                .send(crate::tool::ToolOutputChunk {
                    stream: crate::memory::EdgeOutputStream::Stdout,
                    text: "after-background-receipt".to_string(),
                })
                .await
                .is_err(),
            "closed parent receiver must reject post-receipt stream chunks"
        );
    }

    #[tokio::test]
    async fn edge_worker_detaches_two_services_and_runs_sibling_before_background_exit() {
        let workspace = tempfile::TempDir::new().unwrap();
        let database = tempfile::NamedTempFile::new().unwrap();
        let release_first = workspace.path().join("release-first-service");
        let release_second = workspace.path().join("release-second-service");
        let first_completed = workspace.path().join("first-service-completed");
        let second_completed = workspace.path().join("second-service-completed");
        let sibling_completed = workspace.path().join("sibling-completed");
        let foreground_completed = workspace.path().join("foreground-completed");
        let node_id = "node-edge-background";
        let target_id = "target-edge-background";
        let commands = VecDeque::from([
            edge_worker_test_command(
                "edge-preflight-failure",
                node_id,
                target_id,
                serde_json::json!({
                    "command": "sleep 1 & echo unsafe-sibling",
                    "cwd": workspace.path()
                }),
            ),
            edge_worker_test_command(
                "edge-long-foreground",
                node_id,
                target_id,
                serde_json::json!({
                    "command": format!(
                        "dd if=/dev/zero bs=16384 count=96 2>/dev/null; sleep 0.15; printf foreground; touch '{}'",
                        foreground_completed.display()
                    ),
                    "cwd": workspace.path(),
                    "wait_ms": 1_000
                }),
            ),
            edge_worker_test_command(
                "edge-background-parent-1",
                node_id,
                target_id,
                serde_json::json!({
                    "command": format!(
                        "i=0; while [ ! -f '{}' ] && [ \"$i\" -lt 250 ]; do sleep 0.02; i=$((i + 1)); done; touch '{}'",
                        release_first.display(),
                        first_completed.display()
                    ),
                    "cwd": workspace.path(),
                    "wait_ms": 10,
                    "keep_running": true
                }),
            ),
            edge_worker_test_command(
                "edge-background-parent-2",
                node_id,
                target_id,
                serde_json::json!({
                    "command": format!(
                        "i=0; while [ ! -f '{}' ] && [ \"$i\" -lt 250 ]; do sleep 0.02; i=$((i + 1)); done; touch '{}'",
                        release_second.display(),
                        second_completed.display()
                    ),
                    "cwd": workspace.path(),
                    "background": true,
                    "keep_running": true
                }),
            ),
            edge_worker_test_command(
                "edge-quick-sibling",
                node_id,
                target_id,
                serde_json::json!({
                    "command": format!("touch '{}'", sibling_completed.display()),
                    "cwd": workspace.path(),
                    "wait_ms": 1_000
                }),
            ),
        ]);
        let now = Utc::now();
        let state = EdgeWorkerGatewayState {
            node: ExecutionNodeRecord {
                id: node_id.to_string(),
                revision: 1,
                owner_principal_id: "principal-a".to_string(),
                name: "Edge background test node".to_string(),
                status: crate::memory::ExecutionNodeStatus::Online,
                device_key_fingerprint: "test-fingerprint".to_string(),
                device_public_key: "test-public-key".to_string(),
                protocol_version: 1,
                platform: Some("test-unix".to_string()),
                capabilities: vec!["exec".to_string()],
                metadata: serde_json::json!({"test": true}),
                created_at: now,
                updated_at: now,
                last_seen_at: Some(now),
            },
            queued: Arc::new(tokio::sync::Mutex::new(commands)),
            active: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            finished: Arc::new(tokio::sync::Mutex::new(Vec::new())),
            output_sequence: Arc::new(AtomicUsize::new(0)),
            command_heartbeats: Arc::new(AtomicUsize::new(0)),
            background_jobs: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            background_finished: Arc::new(tokio::sync::Mutex::new(Vec::new())),
        };
        let app = Router::new()
            .route(
                "/api/edge/nodes/:node_id/heartbeat",
                post(test_worker_node_heartbeat),
            )
            .route(
                "/api/edge/nodes/:node_id/jobs/claim",
                post(test_worker_claim),
            )
            .route(
                "/api/edge/nodes/:node_id/jobs/:job_id/heartbeat",
                post(test_worker_command_heartbeat),
            )
            .route(
                "/api/edge/nodes/:node_id/jobs/:job_id/output",
                post(test_worker_append_output),
            )
            .route(
                "/api/edge/nodes/:node_id/jobs/:job_id/finish",
                post(test_worker_finish),
            )
            .route(
                "/api/edge/nodes/:node_id/jobs/:job_id/background/reserve",
                post(test_worker_reserve_background),
            )
            .route(
                "/api/edge/nodes/:node_id/jobs/:job_id/background/:task_id/heartbeat",
                post(test_worker_heartbeat_background),
            )
            .route(
                "/api/edge/nodes/:node_id/jobs/:job_id/background/:task_id/finish",
                post(test_worker_finish_background),
            )
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let mut config = crate::config::AppConfig::default();
        config.permissions.mode = crate::permission::PermissionMode::FullAccess;
        config.permissions.workspace_root = workspace.path().to_string_lossy().into_owned();
        config.background_task.artifact_dir = workspace
            .path()
            .join("artifacts")
            .to_string_lossy()
            .into_owned();
        config.background_task.timeout_notify_enabled = false;
        let runtime = MorphzRuntime::builder(config, Arc::new(EdgeWorkerTestClient))
            .database_path(database.path().to_string_lossy())
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        let gateway = EdgeGatewayClient::new(format!("http://{address}")).unwrap();
        *gateway.connection.write().await = Some(ExecutionNodeConnection {
            token: "edge-worker-test-connection".to_string(),
            expires_at: Utc::now() + chrono::Duration::minutes(5),
        });
        let credentials = EdgeNodeCredentials {
            server_url: format!("http://{address}"),
            node_id: node_id.to_string(),
            device_key_fingerprint: "unused".to_string(),
            device_public_key: "unused".to_string(),
            device_private_key_pkcs8: "unused".to_string(),
        };
        let advertisement = EdgeNodeAdvertisement {
            platform: Some("test-unix".to_string()),
            capabilities: vec!["exec".to_string()],
            metadata: serde_json::json!({"test": true}),
            targets: vec![ExecutionTargetRegistration {
                id: target_id.to_string(),
                owner_principal_id: None,
                provider_node_id: Some(node_id.to_string()),
                kind: ExecutionTargetKind::EdgeNode,
                name: "Edge background test target".to_string(),
                status: crate::memory::ExecutionTargetStatus::Online,
                platform: Some("test-unix".to_string()),
                workspace_root: Some(workspace.path().to_string_lossy().into_owned()),
                capabilities: vec!["exec".to_string()],
                metadata: serde_json::json!({"test": true}),
                policy_digest: "edge-worker-test-policy".to_string(),
                last_seen_at: Some(Utc::now()),
            }],
        };
        let worker = EdgeNodeWorker::new(
            gateway,
            credentials,
            advertisement,
            runtime.clone(),
            EdgeWorkerConfig {
                worker_id: "edge-worker-test".to_string(),
                lease_seconds: 2,
                claim_wait_seconds: 1,
                heartbeat_interval: std::time::Duration::from_millis(25),
            },
        );

        for expected_job in [
            "edge-preflight-failure",
            "edge-long-foreground",
            "edge-background-parent-1",
            "edge-background-parent-2",
            "edge-quick-sibling",
        ] {
            tokio::time::timeout(std::time::Duration::from_secs(1), worker.poll_once())
                .await
                .unwrap_or_else(|_| {
                    panic!("Edge parent command '{expected_job}' occupied its lease")
                })
                .unwrap();
        }
        assert!(sibling_completed.exists());
        assert!(foreground_completed.exists());
        assert!(
            !first_completed.exists() && !second_completed.exists(),
            "background services ended before the sibling command proved worker availability"
        );
        tokio::fs::write(&release_first, b"release").await.unwrap();
        tokio::fs::write(&release_second, b"release").await.unwrap();

        let finished = state.finished.lock().await.clone();
        assert_eq!(finished.len(), 5);
        assert_eq!(finished[0].job_id, "edge-preflight-failure");
        assert_eq!(finished[0].status, EdgeCommandStatus::Failed);
        assert!(finished[0].side_effect_started_at.is_none());
        assert!(finished[0]
            .error
            .as_deref()
            .is_some_and(|error| error.contains("cannot safely normalize")));
        for (index, expected_job) in [
            "edge-long-foreground",
            "edge-background-parent-1",
            "edge-background-parent-2",
            "edge-quick-sibling",
        ]
        .into_iter()
        .enumerate()
        {
            assert_eq!(finished[index + 1].job_id, expected_job);
            assert_eq!(finished[index + 1].status, EdgeCommandStatus::Succeeded);
        }
        let first_receipt: serde_json::Value =
            serde_json::from_str(finished[2].output.as_deref().unwrap()).unwrap();
        let second_receipt: serde_json::Value =
            serde_json::from_str(finished[3].output.as_deref().unwrap()).unwrap();
        assert_eq!(first_receipt["execution"], "background");
        assert_eq!(second_receipt["execution"], "background");
        let task_ids = [
            first_receipt["task_id"].as_str().unwrap().to_string(),
            second_receipt["task_id"].as_str().unwrap().to_string(),
        ];

        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while !first_completed.exists() || !second_completed.exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("Edge background services did not continue after their parent receipts");
        let terminal_jobs = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let terminals = state.background_finished.lock().await.clone();
                if terminals.len() == task_ids.len() {
                    break terminals;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("Edge background terminal Jobs were not durably recorded");
        assert_eq!(terminal_jobs.len(), 2);
        for task_id in &task_ids {
            let terminal_job = terminal_jobs
                .iter()
                .find(|job| job.id == *task_id)
                .expect("central terminal Edge background Job");
            assert_eq!(
                terminal_jobs
                    .iter()
                    .filter(|job| job.id == *task_id)
                    .count(),
                1,
                "one Edge background exit must have exactly one central terminal Job"
            );
            let checkpoint: serde_json::Value = serde_json::from_str(
                terminal_job
                    .progress_ref
                    .as_deref()
                    .expect("Edge background process checkpoint"),
            )
            .unwrap();
            assert_eq!(checkpoint["kind"], "edge_background_process");
            assert_eq!(checkpoint["node_id"], node_id);
            assert!(checkpoint["process_group_id"]
                .as_i64()
                .is_some_and(|pgid| pgid > 1));
            assert!(checkpoint["artifact_path"]
                .as_str()
                .is_some_and(|path| !path.is_empty()));
            assert_eq!(
                crate::execution::execution_job_process_group_id(terminal_job),
                None,
                "the central Runtime must not treat an Edge PID namespace as local"
            );
            assert!(runtime.get_execution_job(task_id).await.unwrap().is_none());
        }
        let local_terminal_events = runtime
            .query_events(crate::memory::QueryFilter {
                topic: Some("chat/tool_output".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(
            local_terminal_events.iter().all(|event| event
                .payload
                .get("task_id")
                .and_then(serde_json::Value::as_str)
                .is_none_or(|task_id| !task_ids.iter().any(|value| value == task_id))),
            "Edge-local Runtime must not duplicate central background terminal facts"
        );
        assert!(
            state.command_heartbeats.load(Ordering::SeqCst) >= 8,
            "long foreground execution and sibling commands must keep renewing their Edge leases"
        );
        server.abort();
    }

    #[tokio::test]
    async fn edge_artifact_upload_resumes_from_the_server_offset_after_interruption() {
        let temp = tempfile::TempDir::new().unwrap();
        let source = temp.path().join("resumable.bin");
        let bytes = (0..(384 * 1024 + 37))
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        tokio::fs::write(&source, &bytes).await.unwrap();
        let (size_bytes, content_digest) = hash_edge_file(&source).await.unwrap();
        let state = InterruptedArtifactUploadState {
            job_id: "edge-resumable-upload".to_string(),
            expected_digest: content_digest.clone(),
            expected_size: size_bytes,
            stored: Arc::new(tokio::sync::Mutex::new(Vec::new())),
            offsets: Arc::new(tokio::sync::Mutex::new(Vec::new())),
            attempts: Arc::new(AtomicUsize::new(0)),
        };
        let app = Router::new()
            .route(
                "/api/edge/nodes/:node_id/jobs/:job_id/artifact/upload",
                get(inspect_interrupted_artifact_upload).put(receive_interrupted_artifact_upload),
            )
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let client = EdgeGatewayClient::new(format!("http://{address}")).unwrap();
        *client.connection.write().await = Some(ExecutionNodeConnection {
            token: "test-connection".to_string(),
            expires_at: Utc::now() + chrono::Duration::minutes(5),
        });
        let credentials = EdgeNodeCredentials {
            server_url: format!("http://{address}"),
            node_id: "node-a".to_string(),
            device_key_fingerprint: "unused".to_string(),
            device_public_key: "unused".to_string(),
            device_private_key_pkcs8: "unused".to_string(),
        };
        let now = Utc::now();
        let command = EdgeCommandRecord {
            job_id: state.job_id.clone(),
            revision: 1,
            target_id: "target-edge".to_string(),
            provider_node_id: credentials.node_id.clone(),
            tool_name: ARTIFACT_TRANSFER_TOOL_NAME.to_string(),
            arguments: "{}".to_string(),
            route: serde_json::json!({}),
            status: EdgeCommandStatus::Claimed,
            claimed_by: Some("worker-a".to_string()),
            claim_token: Some("claim-a".to_string()),
            lease_expires_at: Some(now + chrono::Duration::minutes(1)),
            heartbeat_at: Some(now),
            side_effect_started_at: None,
            progress: None,
            output: None,
            error: None,
            created_at: now,
            updated_at: now,
            finished_at: None,
        };
        let receipt = client
            .upload_artifact(
                &credentials,
                &command,
                &source,
                &EdgeArtifactDataChannel {
                    direction: EdgeArtifactDataDirection::EdgeToRuntime,
                    payload_kind: EdgeArtifactPayloadKind::File,
                    expected_digest: Some(content_digest.clone()),
                    size_bytes: Some(size_bytes),
                },
            )
            .await
            .unwrap();
        server.abort();

        assert_eq!(receipt.content_digest, content_digest);
        assert_eq!(receipt.size_bytes, size_bytes);
        assert_eq!(*state.stored.lock().await, bytes);
        let offsets = state.offsets.lock().await.clone();
        assert_eq!(offsets.len(), 2);
        assert_eq!(offsets[0], 0);
        assert!(offsets[1] > 0 && offsets[1] < size_bytes);
    }

    #[test]
    fn provider_local_lease_is_thread_target_and_policy_scoped() {
        let store = EdgeLocalCapabilityLeaseStore {
            path: None,
            leases: Arc::new(std::sync::Mutex::new(Vec::new())),
        };
        let requested = CapabilityDelta {
            network: true,
            read_roots: vec![PathBuf::from("/workspace")],
            ..CapabilityDelta::default()
        };
        store
            .grant(EdgeLocalCapabilityLease {
                id: "lease-a".to_string(),
                principal_id: "principal-a".to_string(),
                agent_id: "agent-a".to_string(),
                thread_id: "thread-a".to_string(),
                target_id: "target-a".to_string(),
                capability: "exec".to_string(),
                requested: requested.clone(),
                policy_digest: "policy-a".to_string(),
                issued_at: Utc::now(),
                expires_at: Utc::now() + chrono::Duration::minutes(5),
                revoked_at: None,
            })
            .unwrap();
        assert!(store.covers(&scope(), "target-a", "exec", &requested, "policy-a"));
        let mut other_thread = scope();
        other_thread.thread_id = "thread-b".to_string();
        assert!(!store.covers(&other_thread, "target-a", "exec", &requested, "policy-a"));
        assert!(!store.covers(&scope(), "target-b", "exec", &requested, "policy-a"));
        assert!(!store.covers(&scope(), "target-a", "exec", &requested, "policy-b"));
        assert!(store.revoke("lease-a").unwrap());
        assert!(!store.covers(&scope(), "target-a", "exec", &requested, "policy-a"));
    }

    #[test]
    fn edge_local_artifact_transfer_is_localized_without_losing_authority() {
        let now = Utc::now();
        let route = ExecutionRouteSnapshot {
            route_id: "route:target-edge:r3".to_string(),
            target_id: "target-edge".to_string(),
            target_revision: 3,
            provider_node_id: Some("node-a".to_string()),
            backend_kind: ExecutionTargetKind::EdgeNode,
            endpoint_ref: None,
            policy_digest: "edge-policy".to_string(),
        };
        let routes = ArtifactTransferRouteSnapshot {
            source: route.clone(),
            destination: route,
        };
        let request = ArtifactTransferRequest {
            transfer_id: "transfer-a".to_string(),
            source: ArtifactLocation {
                target_id: "target-edge".to_string(),
                workspace_identity: Some("workspace-a".to_string()),
                path: "input/source.bin".to_string(),
            },
            destination: ArtifactLocation {
                target_id: "target-edge".to_string(),
                workspace_identity: Some("workspace-a".to_string()),
                path: "output/destination.bin".to_string(),
            },
            overwrite: ArtifactOverwritePolicy::Deny,
            expected_source_digest: None,
            media_type: Some("application/octet-stream".to_string()),
            origin: None,
        };
        let mut route_value = serde_json::to_value(routes).unwrap();
        route_value.as_object_mut().unwrap().insert(
            EDGE_EXECUTION_SCOPE_KEY.to_string(),
            serde_json::to_value(scope()).unwrap(),
        );
        let command = EdgeCommandRecord {
            job_id: "job-a".to_string(),
            revision: 1,
            target_id: "target-edge".to_string(),
            provider_node_id: "node-a".to_string(),
            tool_name: ARTIFACT_TRANSFER_TOOL_NAME.to_string(),
            arguments: execution_arguments_from_transfer_request(&request).unwrap(),
            route: route_value,
            status: EdgeCommandStatus::Claimed,
            claimed_by: Some("worker-a".to_string()),
            claim_token: Some("claim-a".to_string()),
            lease_expires_at: None,
            heartbeat_at: None,
            side_effect_started_at: None,
            progress: None,
            output: None,
            error: None,
            created_at: now,
            updated_at: now,
            finished_at: None,
        };

        let prepared =
            prepare_edge_local_artifact_transfer_command(&command, "node-a", None, None).unwrap();
        let localized =
            transfer_request_from_tool_arguments(&prepared.arguments, "unused").unwrap();
        assert_eq!(localized.transfer_id, "transfer-a");
        assert_eq!(localized.source.target_id, DEFAULT_EXECUTION_TARGET_ID);
        assert_eq!(localized.destination.target_id, DEFAULT_EXECUTION_TARGET_ID);
        assert_eq!(localized.source.path, "input/source.bin");
        assert_eq!(localized.destination.path, "output/destination.bin");
        assert_eq!(
            edge_execution_scope_from_route(&prepared.route).unwrap(),
            scope()
        );
        let local_route: ExecutionRouteSnapshot =
            serde_json::from_value(prepared.route.clone()).unwrap();
        assert_eq!(local_route.target_id, DEFAULT_EXECUTION_TARGET_ID);
        assert!(
            prepare_edge_local_artifact_transfer_command(&command, "node-b", None, None).is_err()
        );
    }

    #[test]
    fn runtime_edge_channels_localize_only_the_edge_physical_boundary() {
        let now = Utc::now();
        let local = ExecutionRouteSnapshot {
            route_id: "route:target-default:r1".to_string(),
            target_id: DEFAULT_EXECUTION_TARGET_ID.to_string(),
            target_revision: 1,
            provider_node_id: None,
            backend_kind: ExecutionTargetKind::InProcessLocal,
            endpoint_ref: None,
            policy_digest: "runtime-policy".to_string(),
        };
        let edge = ExecutionRouteSnapshot {
            route_id: "route:target-edge:r2".to_string(),
            target_id: "target-edge".to_string(),
            target_revision: 2,
            provider_node_id: Some("node-a".to_string()),
            backend_kind: ExecutionTargetKind::EdgeNode,
            endpoint_ref: None,
            policy_digest: "edge-policy".to_string(),
        };
        let request = ArtifactTransferRequest {
            transfer_id: "transfer-cross".to_string(),
            source: ArtifactLocation {
                target_id: DEFAULT_EXECUTION_TARGET_ID.to_string(),
                workspace_identity: None,
                path: "/runtime/source.bin".to_string(),
            },
            destination: ArtifactLocation {
                target_id: "target-edge".to_string(),
                workspace_identity: None,
                path: "edge/destination.bin".to_string(),
            },
            overwrite: ArtifactOverwritePolicy::Deny,
            expected_source_digest: Some(format!("sha256:{}", "a".repeat(64))),
            media_type: None,
            origin: None,
        };
        let routes = ArtifactTransferRouteSnapshot {
            source: local,
            destination: edge,
        };
        let mut route_value = serde_json::to_value(routes).unwrap();
        route_value.as_object_mut().unwrap().insert(
            EDGE_EXECUTION_SCOPE_KEY.to_string(),
            serde_json::to_value(scope()).unwrap(),
        );
        let channel = EdgeArtifactDataChannel {
            direction: EdgeArtifactDataDirection::RuntimeToEdge,
            payload_kind: EdgeArtifactPayloadKind::File,
            expected_digest: request.expected_source_digest.clone(),
            size_bytes: Some(7),
        };
        crate::execution_target::attach_edge_artifact_data_channel(&mut route_value, &channel)
            .unwrap();
        let command = EdgeCommandRecord {
            job_id: "job-cross".to_string(),
            revision: 1,
            target_id: "target-edge".to_string(),
            provider_node_id: "node-a".to_string(),
            tool_name: ARTIFACT_TRANSFER_TOOL_NAME.to_string(),
            arguments: execution_arguments_from_transfer_request(&request).unwrap(),
            route: route_value,
            status: EdgeCommandStatus::Claimed,
            claimed_by: Some("worker-a".to_string()),
            claim_token: Some("claim-a".to_string()),
            lease_expires_at: Some(Utc::now() + chrono::Duration::minutes(1)),
            heartbeat_at: None,
            side_effect_started_at: None,
            progress: None,
            output: None,
            error: None,
            created_at: now,
            updated_at: now,
            finished_at: None,
        };
        let stage = PathBuf::from("/runtime-owned/edge-local.bin");
        let prepared = prepare_edge_local_artifact_transfer_command(
            &command,
            "node-a",
            Some(&channel),
            Some(&stage),
        )
        .unwrap();
        let localized =
            transfer_request_from_tool_arguments(&prepared.arguments, "unused").unwrap();
        assert_eq!(localized.source.path, stage.to_string_lossy());
        assert_eq!(localized.destination.path, "edge/destination.bin");
        assert_eq!(localized.source.target_id, DEFAULT_EXECUTION_TARGET_ID);
        assert_eq!(localized.destination.target_id, DEFAULT_EXECUTION_TARGET_ID);
        assert_eq!(localized.expected_source_digest, channel.expected_digest);

        let directory_channel = EdgeArtifactDataChannel {
            direction: EdgeArtifactDataDirection::RuntimeToEdge,
            payload_kind: EdgeArtifactPayloadKind::DirectoryArchive,
            expected_digest: Some(format!("sha256:{}", "b".repeat(64))),
            size_bytes: Some(11),
        };
        let directory_stage = PathBuf::from("/runtime-owned/edge-local.tree");
        let directory_prepared = prepare_edge_local_artifact_transfer_command(
            &command,
            "node-a",
            Some(&directory_channel),
            Some(&directory_stage),
        )
        .unwrap();
        let directory_request =
            transfer_request_from_tool_arguments(&directory_prepared.arguments, "unused").unwrap();
        assert_eq!(
            directory_request.source.path,
            directory_stage.to_string_lossy()
        );
        // The archive digest protects channel bytes; the original digest is a
        // logical directory precondition and must survive localization.
        assert_eq!(
            directory_request.expected_source_digest,
            request.expected_source_digest
        );
    }

    #[tokio::test]
    async fn edge_directory_upload_uses_canonical_payload_without_changing_logical_receipt() {
        let temp = tempfile::TempDir::new().unwrap();
        let stage = temp.path().join("edge-local.bin");
        tokio::fs::create_dir_all(stage.join("nested"))
            .await
            .unwrap();
        tokio::fs::write(stage.join("nested/value.txt"), b"value")
            .await
            .unwrap();
        let logical_digest = format!("sha256:{}", "c".repeat(64));
        let location = ArtifactLocation {
            target_id: DEFAULT_EXECUTION_TARGET_ID.to_string(),
            workspace_identity: None,
            path: stage.display().to_string(),
        };
        let descriptor = crate::artifact::ArtifactDescriptor {
            artifact_id: format!("artifact:{logical_digest}"),
            location: location.clone(),
            content_digest: Some(logical_digest.clone()),
            size_bytes: Some(5),
            media_type: Some("application/vnd.morphz.directory".to_string()),
            origin: None,
        };
        let output = serde_json::to_string(&crate::artifact::ArtifactTransferReceipt {
            transfer_id: "directory-edge-upload".to_string(),
            source: descriptor.clone(),
            destination: descriptor,
            transport: "local_tree_copy".to_string(),
            bytes_transferred: 5,
        })
        .unwrap();
        let channel = EdgeArtifactDataChannel {
            direction: EdgeArtifactDataDirection::EdgeToRuntime,
            payload_kind: EdgeArtifactPayloadKind::Detect,
            expected_digest: None,
            size_bytes: None,
        };
        let (archive, payload_channel) = prepare_edge_artifact_upload(&stage, &output, &channel)
            .await
            .unwrap();
        assert_eq!(
            payload_channel.payload_kind,
            EdgeArtifactPayloadKind::DirectoryArchive
        );
        assert!(payload_channel.expected_digest.is_some());
        assert!(payload_channel.size_bytes.unwrap() > 0);
        assert!(tokio::fs::metadata(&archive).await.unwrap().is_file());

        let materialized = temp.path().join("materialized");
        materialize_edge_directory_archive(&archive, &materialized)
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read(materialized.join("nested/value.txt"))
                .await
                .unwrap(),
            b"value"
        );
        // The wire digest intentionally differs from and does not overwrite
        // the logical directory digest carried in `output`.
        assert_ne!(payload_channel.expected_digest, Some(logical_digest));
    }

    #[test]
    fn edge_proxy_localizes_edge_endpoint_but_preserves_managed_ssh_endpoint() {
        let now = Utc::now();
        let source = ExecutionRouteSnapshot {
            route_id: "route:edge:r1".to_string(),
            target_id: "target-edge".to_string(),
            target_revision: 1,
            provider_node_id: Some("node-a".to_string()),
            backend_kind: ExecutionTargetKind::EdgeNode,
            endpoint_ref: None,
            policy_digest: "edge-policy".to_string(),
        };
        let destination = ExecutionRouteSnapshot {
            route_id: "route:ssh:r4".to_string(),
            target_id: "target-ssh".to_string(),
            target_revision: 4,
            provider_node_id: Some("node-a".to_string()),
            backend_kind: ExecutionTargetKind::ManagedSsh,
            endpoint_ref: Some("server-a".to_string()),
            policy_digest: "ssh-policy".to_string(),
        };
        let routes = ArtifactTransferRouteSnapshot {
            source,
            destination,
        };
        let request = ArtifactTransferRequest {
            transfer_id: "transfer-proxy".to_string(),
            source: ArtifactLocation {
                target_id: "target-edge".to_string(),
                workspace_identity: None,
                path: "output/result.bin".to_string(),
            },
            destination: ArtifactLocation {
                target_id: "target-ssh".to_string(),
                workspace_identity: None,
                path: "/srv/result.bin".to_string(),
            },
            overwrite: ArtifactOverwritePolicy::Replace,
            expected_source_digest: None,
            media_type: None,
            origin: None,
        };
        let mut route = serde_json::to_value(routes).unwrap();
        route.as_object_mut().unwrap().insert(
            EDGE_EXECUTION_SCOPE_KEY.to_string(),
            serde_json::to_value(scope()).unwrap(),
        );
        let command = EdgeCommandRecord {
            job_id: "job-proxy".to_string(),
            revision: 1,
            target_id: "target-ssh".to_string(),
            provider_node_id: "node-a".to_string(),
            tool_name: ARTIFACT_TRANSFER_TOOL_NAME.to_string(),
            arguments: execution_arguments_from_transfer_request(&request).unwrap(),
            route,
            status: EdgeCommandStatus::Claimed,
            claimed_by: Some("worker-a".to_string()),
            claim_token: Some("claim-a".to_string()),
            lease_expires_at: None,
            heartbeat_at: None,
            side_effect_started_at: None,
            progress: None,
            output: None,
            error: None,
            created_at: now,
            updated_at: now,
            finished_at: None,
        };

        let prepared = prepare_edge_proxy_artifact_transfer_command(&command, "node-a").unwrap();
        let localized: ArtifactTransferRouteSnapshot =
            serde_json::from_value(prepared.route.clone()).unwrap();
        assert_eq!(
            localized.source.backend_kind,
            ExecutionTargetKind::InProcessLocal
        );
        assert_eq!(localized.source.target_id, DEFAULT_EXECUTION_TARGET_ID);
        assert_eq!(
            localized.destination.backend_kind,
            ExecutionTargetKind::ManagedSsh
        );
        assert_eq!(localized.destination.target_id, "target-ssh");
        assert_eq!(localized.destination.provider_node_id, None);
        assert_eq!(
            localized.destination.endpoint_ref.as_deref(),
            Some("server-a")
        );
        let localized_request =
            transfer_request_from_tool_arguments(&prepared.arguments, "unused").unwrap();
        assert_eq!(
            localized_request.source.target_id,
            DEFAULT_EXECUTION_TARGET_ID
        );
        assert_eq!(localized_request.destination.target_id, "target-ssh");
        assert_eq!(
            edge_execution_scope_from_route(&prepared.route).unwrap(),
            scope()
        );
        assert!(prepare_edge_proxy_artifact_transfer_command(&command, "node-b").is_err());
    }
}
