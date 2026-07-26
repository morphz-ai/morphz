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
use reqwest::StatusCode;
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::approval::{
    capability_lease_policy_digest, ApprovalDecision, ApprovalRequest, CapabilityDelta,
    CapabilityLeaseOffer,
};
pub use crate::execution_target::ManagedSshEndpoint;
use crate::execution_target::{
    edge_execution_scope_from_route, prepare_managed_ssh_exec_arguments, EdgeExecutionScope,
    ExecutionRouteSnapshot,
};
use crate::memory::{
    EdgeCommandRecord, EdgeCommandStatus, ExecutionNodeRecord, ExecutionTargetKind,
    ExecutionTargetRegistration,
};
use crate::runtime::MorphzRuntime;
use crate::sdk::{
    execution_node_connection_proof_message, AppendEdgeOutputCommand, ClaimEdgeCommand,
    ConnectExecutionNodeCommand, ExecutionNodeConnection, ExecutionNodeHeartbeatCommand,
    ExecutionNodeIdentityChallenge, FinishEdgeCommand, HeartbeatEdgeCommand,
    PairExecutionNodeCommand, PairedExecutionNode, RotateExecutionNodeKeyCommand,
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

/// Provider-local lease ledger. It never leaves the Edge Node and is not a
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
        .map_err(|_| "无法生成 Edge Ed25519 设备密钥")?;
    let key_pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref())
        .map_err(|_| "无法解析新生成的 Edge Ed25519 设备密钥")?;
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
            .ok_or("无法确定 Morphz 用户配置目录，不能保存 Edge Node 凭证")?;
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
            return Err("Edge server URL 必须以 http:// 或 https:// 开头".into());
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
            .ok_or("已领取的 Edge Command 缺少 claim_token")?;
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
            .ok_or("已领取的 Edge Command 缺少 claim_token")?;
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

    pub async fn append_output(
        &self,
        credentials: &EdgeNodeCredentials,
        command: &EdgeCommandRecord,
        chunk: crate::tool::ToolOutputChunk,
    ) -> Result<crate::memory::EdgeCommandOutputChunk, EdgeNodeError> {
        let claim_token = command
            .claim_token
            .as_deref()
            .ok_or("已领取的 Edge Command 缺少 claim_token")?;
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
        let key_pair =
            Ed25519KeyPair::from_pkcs8(&private_key).map_err(|_| "Edge 设备私钥损坏或格式无效")?;
        if encode_hex(key_pair.public_key().as_ref()) != credentials.device_public_key {
            return Err("Edge 设备私钥与已配对公钥不一致".into());
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
        return Err("Edge 密钥 hex 长度必须为偶数".into());
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let high = edge_hex_nibble(pair[0]).ok_or("Edge 密钥包含非十六进制字符")?;
            let low = edge_hex_nibble(pair[1]).ok_or("Edge 密钥包含非十六进制字符")?;
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
        return Err(format!("Edge Gateway 返回 HTTP {status}: {detail}").into());
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

        // Conservatively cross the durable boundary immediately before the
        // physical Tool future is first polled. A crash after this point is
        // reported as unknown/lost rather than risked as an automatic replay.
        command = self
            .gateway
            .heartbeat_command(
                &self.credentials,
                &command,
                true,
                Some("local sandbox and tool execution started".to_string()),
                self.config.lease_seconds,
            )
            .await?;

        let (execution_command, provider_local_preauthorized) =
            self.prepare_execution_command(&command)?;
        let local_authority_approved = self
            .authorize_local_capability(&execution_command, provider_local_preauthorized)
            .await?;
        let (output_tx, mut output_rx) = tokio::sync::mpsc::channel(64);
        let execution = self.runtime.execute_edge_tool_streaming(
            &execution_command,
            local_authority_approved,
            Some(output_tx),
        );
        tokio::pin!(execution);
        let mut heartbeat = tokio::time::interval(self.config.heartbeat_interval);
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut output_open = true;
        loop {
            tokio::select! {
                result = &mut execution => {
                    // The Tool future waits for both pipe readers before it
                    // completes, so sender closure now proves this drain is
                    // finite and preserves chunk-before-terminal ordering.
                    while let Some(chunk) = output_rx.recv().await {
                        self.gateway.append_output(&self.credentials, &command, chunk).await?;
                    }
                    match result {
                        Ok(output) => {
                            self.gateway.finish_command(
                                &self.credentials,
                                &command,
                                EdgeCommandStatus::Succeeded,
                                Some(output),
                                None,
                            ).await?;
                        }
                        Err(error) => {
                            self.gateway.finish_command(
                                &self.credentials,
                                &command,
                                EdgeCommandStatus::Failed,
                                None,
                                Some(error.to_string()),
                            ).await?;
                        }
                    }
                    return Ok(true);
                }
                chunk = output_rx.recv(), if output_open => {
                    match chunk {
                        Some(chunk) => {
                            self.gateway.append_output(&self.credentials, &command, chunk).await?;
                        }
                        None => output_open = false,
                    }
                }
                _ = heartbeat.tick() => {
                    self.advertise().await?;
                    command = self.gateway.heartbeat_command(
                        &self.credentials,
                        &command,
                        true,
                        Some("tool execution in progress".to_string()),
                        self.config.lease_seconds,
                    ).await?;
                    if command.status == EdgeCommandStatus::CancelRequested {
                        // Dropping the Tool future requests cancellation. OS process
                        // tools remain responsible for terminating their managed
                        // process group before their future is released.
                        self.gateway.finish_command(
                            &self.credentials,
                            &command,
                            EdgeCommandStatus::Cancelled,
                            None,
                            Some("cancelled by cloud control plane".to_string()),
                        ).await?;
                        return Ok(true);
                    }
                }
            }
        }
    }

    fn prepare_execution_command(
        &self,
        command: &EdgeCommandRecord,
    ) -> Result<(EdgeCommandRecord, bool), EdgeNodeError> {
        let route: ExecutionRouteSnapshot = serde_json::from_value(command.route.clone())?;
        if route.target_id != command.target_id
            || route.provider_node_id.as_deref() != Some(self.credentials.node_id.as_str())
        {
            return Err(format!(
                "Edge Command '{}' 的冻结 Route 与 Target/Provider 不一致",
                command.job_id
            )
            .into());
        }
        match route.backend_kind {
            ExecutionTargetKind::EdgeNode => Ok((command.clone(), false)),
            ExecutionTargetKind::ManagedSsh => {
                let endpoint_ref = route
                    .endpoint_ref
                    .as_deref()
                    .ok_or("Managed SSH Route 缺少 endpoint_ref")?;
                let endpoint = ManagedSshEndpoint::load(endpoint_ref)?;
                if command.tool_name != "exec" {
                    return Err(format!(
                        "Managed SSH v1 只支持 exec，Target '{}' 收到不受支持的工具 '{}'",
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
                Ok((prepared, true))
            }
            other => Err(format!(
                "Edge Node 不能承接 backend_kind='{}' 的 Route",
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
                    "Edge Node '{}' 在本地策略下执行 Target '{}' 的工具 '{}'：{}",
                    self.credentials.node_id,
                    command.target_id,
                    command.tool_name,
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
                tracing::info!(%rationale, target_id = %command.target_id, "Edge 本地审批允许一次执行");
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
                tracing::info!(%rationale, target_id = %command.target_id, "Edge 本地审批签发受限 Capability Lease");
                Ok(true)
            }
            ApprovalDecision::Deny { rationale, .. } => {
                Err(format!("Edge 本地审批拒绝执行: {rationale}").into())
            }
            ApprovalDecision::AskHuman { rationale, .. } => Err(format!(
                "Edge 本地审批需要人工确认，但当前本地审批通道尚未完成决定: {rationale}"
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
                    tracing::warn!(%error, delay_seconds = delay, "Edge Node 连接或执行失败，将退避重试");
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

#[cfg(test)]
mod tests {
    use super::*;

    fn scope() -> EdgeExecutionScope {
        EdgeExecutionScope {
            principal_id: "principal-a".to_string(),
            agent_id: "agent-a".to_string(),
            context_id: "context-a".to_string(),
            session_id: "session-a".to_string(),
            thread_id: "thread-a".to_string(),
        }
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
}
