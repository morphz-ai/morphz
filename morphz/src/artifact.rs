//! First-class, transport-neutral Artifact Transfer contracts.
//!
//! An Artifact is any byte sequence the Runtime is asked to move.  It may be
//! created by a user, an Agent, a Tool, or an external system; registering a
//! descriptor does **not** place its bytes in the Event Store or the Mind.
//! Paths are Target-local facts.  This module intentionally does not impose a
//! second workspace jail: the normal [`crate::permission::PermissionProfile`]
//! decides whether an absolute, relative, parent-traversing, or protected path
//! is allowed for each endpoint.

use std::collections::HashMap;
use std::collections::HashSet;
use std::error::Error;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::approval::{ApprovalAction, CapabilityDelta};
use crate::llm::ToolDefinition;
use crate::permission::{ApprovalRequirement, FilesystemAccess, PathDecision, PermissionBroker};
use crate::tool::{Tool, ToolExecutionClass, ToolExecutionRouting, CURRENT_EXECUTION_JOB};

pub type ArtifactTransferError = Box<dyn Error + Send + Sync>;

/// Typed control-plane cancellation.  Backends use this instead of encoding
/// cancellation in an arbitrary error string, allowing the Runtime to commit
/// `cancelled` rather than incorrectly presenting a user cancellation as a
/// failed physical transfer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArtifactTransferCancelled;

impl fmt::Display for ArtifactTransferCancelled {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Artifact Transfer was cancelled")
    }
}

impl Error for ArtifactTransferCancelled {}

pub fn is_artifact_transfer_cancelled(error: &(dyn Error + 'static)) -> bool {
    error.downcast_ref::<ArtifactTransferCancelled>().is_some()
}

/// Stable identity for one physical Edge relay leg.  It is shared by the
/// relay executor and cancellation/recovery controllers so both address the
/// exact same durable child Job without querying by a mutable display field.
pub fn artifact_transfer_relay_leg_job_id(parent_job_id: &str, leg: &str) -> String {
    let id_material = format!("{parent_job_id}\0artifact-relay\0{leg}");
    format!("job_{:x}", Sha256::digest(id_material.as_bytes()))
}

/// Model-visible Tool and Execution Target capability name. The Runtime keeps
/// `ArtifactTransfer*` as its internal domain vocabulary, while the external
/// operation stays consistent with the compact `read`/`write`/`exec` tool
/// namespace.
pub const ARTIFACT_TRANSFER_TOOL_NAME: &str = "transfer";
pub const ARTIFACT_TRANSFER_ROUTES_REQUEST_KEY: &str = "_morphz_artifact_transfer_routes";
/// Runtime-private idempotency key carried inside the frozen Execution Job
/// request. It is intentionally absent from the model-visible Tool schema.
pub const ARTIFACT_TRANSFER_ID_REQUEST_KEY: &str = "_morphz_artifact_transfer_id";

/// Best-effort data-plane progress emitted by physical transfer backends.
/// Lifecycle remains authoritative in ExecutionJob; this snapshot is
/// deliberately monotonic and disposable so reporting can never block bytes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtifactTransferProgress {
    pub phase: String,
    pub bytes_transferred: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_entry: Option<String>,
}

tokio::task_local! {
    pub static CURRENT_ARTIFACT_TRANSFER_PROGRESS:
        tokio::sync::mpsc::UnboundedSender<ArtifactTransferProgress>;
}

tokio::task_local! {
    /// A physical backend must cross this acknowledged boundary immediately
    /// before making the final destination visible. Runtime persists the
    /// boundary before acknowledging, closing the crash window between an
    /// external side effect and durable recovery policy.
    pub static CURRENT_ARTIFACT_TRANSFER_SIDE_EFFECT:
        tokio::sync::mpsc::UnboundedSender<tokio::sync::oneshot::Sender<()>>;
}

pub async fn mark_artifact_transfer_side_effect() -> Result<(), ArtifactTransferError> {
    let acknowledgement = match CURRENT_ARTIFACT_TRANSFER_SIDE_EFFECT.try_with(|sender| {
        let (acknowledge, acknowledged) = tokio::sync::oneshot::channel();
        sender
            .send(acknowledge)
            .map(|_| acknowledged)
            .map_err(|_| "Artifact Transfer side-effect coordinator 已关闭")
    }) {
        Ok(Ok(acknowledged)) => Some(acknowledged),
        Ok(Err(error)) => return Err(error.into()),
        // Direct unit use of a backend has no durable Runtime coordinator.
        // Production Execution Jobs always install this task-local channel.
        Err(_) => None,
    };
    if let Some(acknowledged) = acknowledgement {
        acknowledged
            .await
            .map_err(|_| "Artifact Transfer side-effect boundary 未被持久化")?;
    }
    Ok(())
}

/// Backends call this on their hot path. A slow or disconnected observer is
/// ignored: observability must never become part of transfer correctness.
pub fn report_artifact_transfer_progress(progress: ArtifactTransferProgress) {
    let _ = CURRENT_ARTIFACT_TRANSFER_PROGRESS.try_with(|sender| sender.send(progress));
}

pub fn report_artifact_bytes(
    phase: impl Into<String>,
    bytes_transferred: u64,
    total_bytes: Option<u64>,
) {
    report_artifact_transfer_progress(ArtifactTransferProgress {
        phase: phase.into(),
        bytes_transferred,
        total_bytes,
        current_entry: None,
    });
}

/// Runtime-owned byte staging.  Paths are derived only from durable Job IDs,
/// never from model/user paths, so data-channel endpoints cannot traverse the
/// host filesystem.  The directory contains transient bytes; lifecycle truth
/// remains in ExecutionJob and every stage can be rebuilt or garbage-collected.
#[derive(Debug, Clone)]
pub struct ArtifactTransferStageStore {
    root: Arc<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactTransferStageKind {
    RuntimeSource,
    EdgeUpload,
    EdgeLocal,
}

impl ArtifactTransferStageKind {
    fn file_name(self) -> &'static str {
        match self {
            Self::RuntimeSource => "runtime-source.bin",
            Self::EdgeUpload => "edge-upload.bin",
            Self::EdgeLocal => "edge-local.bin",
        }
    }
}

impl ArtifactTransferStageStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: Arc::new(root.into().join("artifact-transfers")),
        }
    }

    pub fn stage_path(&self, job_id: &str, kind: ArtifactTransferStageKind) -> PathBuf {
        let key = format!("{:x}", Sha256::digest(job_id.as_bytes()));
        self.root.join(key).join(kind.file_name())
    }

    pub async fn prepare_stage_path(
        &self,
        job_id: &str,
        kind: ArtifactTransferStageKind,
    ) -> Result<PathBuf, ArtifactTransferError> {
        let path = self.stage_path(job_id, kind);
        let parent = path.parent().ok_or("Artifact stage 缺少父目录")?;
        tokio::fs::create_dir_all(parent).await?;
        Ok(path)
    }

    pub async fn remove_job(&self, job_id: &str) -> Result<(), ArtifactTransferError> {
        let path = self
            .stage_path(job_id, ArtifactTransferStageKind::RuntimeSource)
            .parent()
            .ok_or("Artifact stage 缺少 Job 目录")?
            .to_path_buf();
        match tokio::fs::remove_dir_all(path).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    /// Removes stages which cannot belong to any durable non-terminal Job.
    /// The store intentionally derives directory names from Job IDs, so a
    /// restart can perform bounded garbage collection without persisting a
    /// second lifecycle database next to the authoritative Execution Jobs.
    pub async fn cleanup_except<'a>(
        &self,
        active_job_ids: impl IntoIterator<Item = &'a str>,
    ) -> Result<u64, ArtifactTransferError> {
        let keep = active_job_ids
            .into_iter()
            .map(|job_id| format!("{:x}", Sha256::digest(job_id.as_bytes())))
            .collect::<HashSet<_>>();
        let mut removed = 0_u64;
        let mut entries = match tokio::fs::read_dir(self.root.as_ref()).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(error) => return Err(error.into()),
        };
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name().to_string_lossy().into_owned();
            if keep.contains(&name) {
                continue;
            }
            let file_type = entry.file_type().await?;
            if file_type.is_dir() {
                tokio::fs::remove_dir_all(entry.path()).await?;
            } else {
                tokio::fs::remove_file(entry.path()).await?;
            }
            removed = removed.saturating_add(1);
        }
        Ok(removed)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactOriginKind {
    User,
    Agent,
    Tool,
    External,
    Runtime,
    Unknown,
}

/// Optional provenance.  It is evidence about where the bytes came from, not
/// an ownership or disclosure decision and not a requirement for transfer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct ArtifactOrigin {
    pub kind: ArtifactOriginKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub principal_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub producer: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(deny_unknown_fields)]
pub struct ArtifactLocation {
    pub target_id: String,
    /// Optional stable workspace identity for diagnostics and stale-route
    /// detection.  Paths are still interpreted by the Target itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_identity: Option<String>,
    /// Target-local path.  It may be relative or absolute; permission and
    /// sandbox policy, rather than this value object, determine admissibility.
    pub path: String,
}

impl ArtifactLocation {
    pub fn validate(&self) -> Result<(), ArtifactTransferError> {
        if self.target_id.trim().is_empty() {
            return Err("Artifact target_id 不能为空".into());
        }
        if self.path.trim().is_empty() {
            return Err("Artifact path 不能为空".into());
        }
        if self
            .workspace_identity
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
        {
            return Err("Artifact workspace_identity 不能是空字符串".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ArtifactDescriptor {
    pub artifact_id: String,
    pub location: ArtifactLocation,
    /// Lowercase `sha256:<hex>` over the logical Artifact content. For a
    /// file this is the exact byte digest; for a directory it is the stable
    /// tree-manifest digest and deliberately excludes transport envelopes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<ArtifactOrigin>,
}

impl ArtifactDescriptor {
    pub fn validate(&self) -> Result<(), ArtifactTransferError> {
        if self.artifact_id.trim().is_empty() {
            return Err("Artifact artifact_id 不能为空".into());
        }
        self.location.validate()?;
        if let Some(digest) = &self.content_digest {
            validate_sha256_digest(digest)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactOverwritePolicy {
    /// Fail if the destination already exists.
    #[default]
    Deny,
    /// Atomically replace the destination after the new bytes are verified.
    Replace,
}

/// Stable intent submitted by a model, SDK, or HTTP caller.  The caller names
/// the endpoints and safety policy, but never a transport/backend or a
/// credential.  Runtime freezes both Execution Routes before creating the
/// durable ExecutionJob.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ArtifactTransferRequest {
    pub transfer_id: String,
    pub source: ArtifactLocation,
    pub destination: ArtifactLocation,
    #[serde(default)]
    pub overwrite: ArtifactOverwritePolicy,
    /// Optional source precondition.  When supplied, a changed source is a
    /// conflict rather than silently transferring different bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_source_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<ArtifactOrigin>,
}

impl ArtifactTransferRequest {
    pub fn validate(&self) -> Result<(), ArtifactTransferError> {
        if self.transfer_id.trim().is_empty() {
            return Err("Artifact transfer_id 不能为空".into());
        }
        self.source.validate()?;
        self.destination.validate()?;
        if let Some(digest) = &self.expected_source_digest {
            validate_sha256_digest(digest)?;
        }
        if self.source == self.destination {
            return Err("Artifact source 与 destination 不能是同一位置".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtifactTransferReceipt {
    pub transfer_id: String,
    pub source: ArtifactDescriptor,
    pub destination: ArtifactDescriptor,
    /// Runtime-selected transport (for example `local_copy` or
    /// `managed_ssh`).  This is observability, not caller-controlled policy.
    pub transport: String,
    pub bytes_transferred: u64,
}

impl ArtifactTransferReceipt {
    pub fn validate_against(
        &self,
        request: &ArtifactTransferRequest,
    ) -> Result<(), ArtifactTransferError> {
        self.source.validate()?;
        self.destination.validate()?;
        if self.transfer_id != request.transfer_id
            || self.source.location != request.source
            || self.destination.location != request.destination
            || self.source.content_digest != self.destination.content_digest
            || self.source.size_bytes != self.destination.size_bytes
            || self.bytes_transferred != self.source.size_bytes.unwrap_or_default()
        {
            return Err("Artifact Transfer receipt 与请求或内容摘要不一致".into());
        }
        if request.expected_source_digest.is_some()
            && request.expected_source_digest != self.source.content_digest
        {
            return Err("Artifact source 已变化，不满足 expected_source_digest".into());
        }
        Ok(())
    }
}

/// Runtime-owned transport. Implementations never receive model-authored
/// credentials and advertise whether they can handle the already-frozen
/// route pair.
#[async_trait::async_trait]
pub trait ArtifactTransferBackend: Send + Sync {
    fn name(&self) -> &'static str;
    fn supports(&self, request: &ArtifactTransferRequest) -> bool;

    async fn transfer(
        &self,
        request: &ArtifactTransferRequest,
    ) -> Result<ArtifactTransferReceipt, ArtifactTransferError>;
}

/// Host policy registry.  Selection is deterministic by registration order
/// after sorting names, and is never supplied by a model/Harness.
#[derive(Default)]
pub struct ArtifactTransferRegistry {
    backends: RwLock<HashMap<String, Arc<dyn ArtifactTransferBackend>>>,
}

/// Local file transport. It is deliberately streaming and stages bytes in
/// the destination directory before an atomic publish. The same Permission
/// Broker used by read/write/exec authorizes both endpoints.
pub struct LocalArtifactTransferBackend {
    permissions: Arc<PermissionBroker>,
}

impl LocalArtifactTransferBackend {
    pub fn new(permissions: Arc<PermissionBroker>) -> Self {
        Self { permissions }
    }
}

#[async_trait::async_trait]
impl ArtifactTransferBackend for LocalArtifactTransferBackend {
    fn name(&self) -> &'static str {
        "local_copy"
    }

    fn supports(&self, request: &ArtifactTransferRequest) -> bool {
        request.source.target_id == request.destination.target_id
    }

    async fn transfer(
        &self,
        request: &ArtifactTransferRequest,
    ) -> Result<ArtifactTransferReceipt, ArtifactTransferError> {
        request.validate()?;
        let (source, destination, requested) =
            local_transfer_paths_and_delta(&self.permissions, request)?;
        self.permissions
            .authorize_delta(
                artifact_transfer_approval_action(&destination),
                requested,
                format!(
                    "传输 Artifact：读取 '{}' 并写入 '{}'",
                    source.display(),
                    destination.display()
                ),
                crate::tool::current_approval_context(),
            )
            .await?;
        transfer_local_file(request, source, destination).await
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct TransferArtifactArgs {
    /// Supplied only by Runtime/SDK adapters after identity and permission
    /// checks. A model cannot discover this field from the Tool schema.
    #[serde(default, rename = "_morphz_artifact_transfer_id")]
    runtime_transfer_id: Option<String>,
    source: ArtifactLocation,
    destination: ArtifactLocation,
    #[serde(default)]
    overwrite: ArtifactOverwritePolicy,
    #[serde(default)]
    expected_source_digest: Option<String>,
    #[serde(default)]
    media_type: Option<String>,
    #[serde(default)]
    origin: Option<ArtifactOrigin>,
}

impl TransferArtifactArgs {
    fn into_request(self, fallback_transfer_id: String) -> ArtifactTransferRequest {
        ArtifactTransferRequest {
            transfer_id: self.runtime_transfer_id.unwrap_or(fallback_transfer_id),
            source: self.source,
            destination: self.destination,
            overwrite: self.overwrite,
            expected_source_digest: self.expected_source_digest,
            media_type: self.media_type,
            origin: self.origin,
        }
    }
}

pub fn transfer_request_from_tool_arguments(
    arguments: &str,
    transfer_id: impl Into<String>,
) -> Result<ArtifactTransferRequest, ArtifactTransferError> {
    let args: TransferArtifactArgs = serde_json::from_str(arguments)?;
    let request = args.into_request(transfer_id.into());
    request.validate()?;
    Ok(request)
}

/// Encode the transport-neutral portion of a transfer intent exactly as the
/// model-visible Tool contract expects it. `transfer_id` is deliberately not
/// part of Tool arguments: Runtime derives/fixes physical identity from the
/// durable Execution Job while SDK callers retain their idempotency key in the
/// domain request.
pub fn tool_arguments_from_transfer_request(
    request: &ArtifactTransferRequest,
) -> Result<String, ArtifactTransferError> {
    request.validate()?;
    Ok(serde_json::to_string(&serde_json::json!({
        "source": request.source,
        "destination": request.destination,
        "overwrite": request.overwrite,
        "expected_source_digest": request.expected_source_digest,
        "media_type": request.media_type,
        "origin": request.origin,
    }))?)
}

/// Encodes the exact immutable request stored in an Execution Job. Unlike the
/// model-facing arguments, this includes Runtime's stable transfer identity.
pub fn execution_arguments_from_transfer_request(
    request: &ArtifactTransferRequest,
) -> Result<String, ArtifactTransferError> {
    request.validate()?;
    Ok(serde_json::to_string(&serde_json::json!({
        (ARTIFACT_TRANSFER_ID_REQUEST_KEY): request.transfer_id,
        "source": request.source,
        "destination": request.destination,
        "overwrite": request.overwrite,
        "expected_source_digest": request.expected_source_digest,
        "media_type": request.media_type,
        "origin": request.origin,
    }))?)
}

/// Model-visible intent boundary. It never accepts a transport/backend or
/// credentials. Runtime planning freezes both Target routes before this Tool
/// is allowed to execute.
pub struct TransferTool {
    permissions: Arc<PermissionBroker>,
    transports: Arc<ArtifactTransferRegistry>,
}

impl TransferTool {
    pub fn new(permissions: Arc<PermissionBroker>) -> Self {
        let transports = Arc::new(ArtifactTransferRegistry::default());
        transports.register(Arc::new(LocalArtifactTransferBackend::new(Arc::clone(
            &permissions,
        ))));
        Self {
            permissions,
            transports,
        }
    }

    fn request(&self, arguments: &str) -> Result<ArtifactTransferRequest, ArtifactTransferError> {
        let transfer_id = CURRENT_EXECUTION_JOB
            .try_with(|job| {
                job.as_ref()
                    .map(|job| format!("transfer:{}", job.parent_job_id))
            })
            .ok()
            .flatten()
            .unwrap_or_else(|| {
                format!("transfer:sha256:{:x}", Sha256::digest(arguments.as_bytes()))
            });
        transfer_request_from_tool_arguments(arguments, transfer_id)
    }
}

#[async_trait::async_trait]
impl Tool for TransferTool {
    fn name(&self) -> &str {
        ARTIFACT_TRANSFER_TOOL_NAME
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().to_string(),
            description: "Reliably transfer a file between two Execution Targets. Declare only the source, destination, and overwrite policy; do not call ssh/scp/sftp, provide credentials, or select a backend. The Runtime freezes both routes, reuses the current permission review, verifies digests, and delivers atomically. User files, external files, and Agent or tool artifacts are all supported.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "source": artifact_location_schema("The source Execution Target and Target-local path"),
                    "destination": artifact_location_schema("The destination Execution Target and Target-local path"),
                    "overwrite": {
                        "type": "string",
                        "enum": ["deny", "replace"],
                        "default": "deny",
                        "description": "deny fails when the destination exists; replace atomically replaces it after digest verification"
                    },
                    "expected_source_digest": {
                        "type": "string",
                        "pattern": "^sha256:[0-9a-f]{64}$",
                        "description": "Optional source-content precondition that prevents replacement during transfer"
                    },
                    "media_type": { "type": "string" },
                    "origin": {
                        "type": "object",
                        "description": "Optional provenance evidence; it does not determine ownership or disclosure policy",
                        "properties": {
                            "kind": { "type": "string", "enum": ["user", "agent", "tool", "external", "runtime", "unknown"] },
                            "principal_id": { "type": "string" },
                            "session_id": { "type": "string" },
                            "producer": { "type": "string" }
                        },
                        "required": ["kind"],
                        "additionalProperties": false
                    }
                },
                "required": ["source", "destination"],
                "additionalProperties": false
            }),
        }
    }

    fn execution_class(&self) -> ToolExecutionClass {
        ToolExecutionClass::PhysicalJob
    }

    fn execution_routing(&self) -> ToolExecutionRouting {
        ToolExecutionRouting::ArtifactTransfer
    }

    fn approval_requirement(
        &self,
        arguments: &str,
    ) -> Result<Option<ApprovalRequirement>, ArtifactTransferError> {
        let request = self.request(arguments)?;
        let (_, destination, requested) =
            local_transfer_paths_and_delta(&self.permissions, &request)?;
        self.permissions.approval_requirement_for_delta(
            artifact_transfer_approval_action(&destination),
            requested,
            format!(
                "Artifact Transfer 需要读取 '{}' 并写入 '{}'",
                request.source.path, request.destination.path
            ),
        )
    }

    async fn execute(&self, arguments: &str) -> Result<String, ArtifactTransferError> {
        let request = self.request(arguments)?;
        let receipt = self.transports.transfer(&request).await?;
        Ok(serde_json::to_string(&receipt)?)
    }
}

fn artifact_location_schema(description: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "description": description,
        "properties": {
            "target_id": {
                "type": "string",
                "minLength": 1,
                "description": "Execution Target ID; the local machine is target-default"
            },
            "workspace_identity": {
                "type": "string",
                "description": "Optional stable Target Workspace identity used to diagnose stale routes"
            },
            "path": {
                "type": "string",
                "minLength": 1,
                "description": "Target-local path; the current permission Profile decides whether absolute or outside-Workspace paths are allowed"
            }
        },
        "required": ["target_id", "path"],
        "additionalProperties": false
    })
}

fn artifact_transfer_approval_action(destination: &Path) -> ApprovalAction {
    let _ = destination;
    ApprovalAction::ToolOperation {
        tool: ARTIFACT_TRANSFER_TOOL_NAME.to_string(),
        operation: "transfer".to_string(),
        target: None,
    }
}

fn local_transfer_paths_and_delta(
    permissions: &PermissionBroker,
    request: &ArtifactTransferRequest,
) -> Result<(PathBuf, PathBuf, CapabilityDelta), ArtifactTransferError> {
    let mut requested = CapabilityDelta::default();
    let source = local_path_decision(
        permissions,
        &request.source,
        FilesystemAccess::Read,
        &mut requested,
    )?;
    let destination = local_path_decision(
        permissions,
        &request.destination,
        FilesystemAccess::Write,
        &mut requested,
    )?;
    Ok((source, destination, requested))
}

fn local_path_decision(
    permissions: &PermissionBroker,
    location: &ArtifactLocation,
    access: FilesystemAccess,
    requested: &mut CapabilityDelta,
) -> Result<PathBuf, ArtifactTransferError> {
    // A remote path is meaningful only inside its own Execution Target.  The
    // cloud Runtime must not reinterpret it through the local filesystem
    // profile merely because both endpoints happen to name the same Target.
    // The selected remote executor performs the same read/write authorization
    // at the target-local physical boundary.
    if location.target_id != crate::execution_target::DEFAULT_EXECUTION_TARGET_ID {
        return Ok(PathBuf::from(&location.path));
    }
    match permissions.profile().inspect_path(&location.path, access)? {
        PathDecision::Allowed(path) => Ok(path),
        PathDecision::Denied(reason) => Err(reason.into()),
        PathDecision::NeedsApproval {
            candidate,
            resolved_anchor,
        } => {
            match access {
                FilesystemAccess::Read => requested.read_roots.push(resolved_anchor),
                FilesystemAccess::Write => requested.write_roots.push(resolved_anchor),
            }
            Ok(candidate)
        }
    }
}

async fn transfer_local_file(
    request: &ArtifactTransferRequest,
    source: PathBuf,
    destination: PathBuf,
) -> Result<ArtifactTransferReceipt, ArtifactTransferError> {
    let metadata = tokio::fs::metadata(&source).await?;
    if metadata.is_dir() {
        return transfer_local_directory(request, source, destination).await;
    }
    if !metadata.is_file() {
        return Err(format!(
            "Artifact source '{}' 既不是普通文件也不是目录",
            source.display()
        )
        .into());
    }
    let total_bytes = metadata.len();
    report_artifact_bytes("copying", 0, Some(total_bytes));
    let destination_parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or("Artifact destination 缺少父目录")?;
    // The destination denotes the final Artifact, not a requirement that all
    // ancestors were provisioned ahead of time. PermissionBroker has already
    // authorized this resolved write boundary.
    tokio::fs::create_dir_all(destination_parent).await?;
    if !tokio::fs::metadata(destination_parent).await?.is_dir() {
        return Err(format!(
            "Artifact destination 父路径 '{}' 不是目录",
            destination_parent.display()
        )
        .into());
    }
    if request.overwrite == ArtifactOverwritePolicy::Deny
        && tokio::fs::try_exists(&destination).await?
    {
        let (source_size, source_digest) = digest_file(&source).await?;
        let (destination_size, destination_digest) = digest_file(&destination).await?;
        if source_size == destination_size && source_digest == destination_digest {
            if request
                .expected_source_digest
                .as_deref()
                .is_some_and(|expected| expected != source_digest)
            {
                return Err("Artifact source digest 与前置条件冲突".into());
            }
            return Ok(file_transfer_receipt(
                request,
                source_size,
                source_digest,
                "local_copy_reconciled",
            ));
        }
        return Err(format!(
            "Artifact destination '{}' 已存在且内容不同",
            destination.display()
        )
        .into());
    }
    let temporary = unique_staging_path(destination_parent, &request.transfer_id, "part");
    let mut temporary_guard = StagingPathGuard::file(temporary.clone());

    let result = async {
        let mut reader = tokio::fs::File::open(&source).await?;
        let mut writer = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .await?;
        let mut hasher = Sha256::new();
        let mut bytes_transferred = 0_u64;
        let mut buffer = vec![0_u8; 128 * 1024];
        loop {
            let count = reader.read(&mut buffer).await?;
            if count == 0 {
                break;
            }
            writer.write_all(&buffer[..count]).await?;
            hasher.update(&buffer[..count]);
            bytes_transferred = bytes_transferred.saturating_add(count as u64);
            report_artifact_bytes("copying", bytes_transferred, Some(total_bytes));
        }
        writer.flush().await?;
        writer.sync_data().await?;
        drop(writer);
        let digest = format!("sha256:{:x}", hasher.finalize());
        if request
            .expected_source_digest
            .as_deref()
            .is_some_and(|expected| expected != digest)
        {
            return Err(format!(
                "Artifact source digest 冲突：期望 '{}'，实际 '{}'",
                request
                    .expected_source_digest
                    .as_deref()
                    .unwrap_or_default(),
                digest
            )
            .into());
        }
        match request.overwrite {
            ArtifactOverwritePolicy::Deny => {
                mark_artifact_transfer_side_effect().await?;
                // A hard link is the portable no-clobber publication primitive
                // for a staging file in the same directory.
                tokio::fs::hard_link(&temporary, &destination).await?;
                tokio::fs::remove_file(&temporary).await?;
            }
            ArtifactOverwritePolicy::Replace => {
                mark_artifact_transfer_side_effect().await?;
                if cfg!(windows) && tokio::fs::try_exists(&destination).await? {
                    tokio::fs::remove_file(&destination).await?;
                }
                tokio::fs::rename(&temporary, &destination).await?;
            }
        }
        temporary_guard.disarm();
        Ok::<_, ArtifactTransferError>(file_transfer_receipt(
            request,
            bytes_transferred,
            digest,
            "local_copy",
        ))
    }
    .await;
    result
}

async fn digest_file(path: &Path) -> Result<(u64, String), ArtifactTransferError> {
    let (size, digest) = digest_file_raw(path).await?;
    Ok((size, format!("sha256:{}", hex_digest(&digest))))
}

async fn digest_file_raw(path: &Path) -> Result<(u64, [u8; 32]), ArtifactTransferError> {
    let mut reader = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = vec![0_u8; 128 * 1024];
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        size = size.saturating_add(count as u64);
    }
    Ok((size, hasher.finalize().into()))
}

fn hex_digest(digest: &[u8; 32]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(64);
    for byte in digest {
        let _ = write!(&mut output, "{byte:02x}");
    }
    output
}

fn file_transfer_receipt(
    request: &ArtifactTransferRequest,
    bytes_transferred: u64,
    digest: String,
    transport: &str,
) -> ArtifactTransferReceipt {
    let artifact_id = format!("artifact:{digest}");
    let descriptor = |location: ArtifactLocation| ArtifactDescriptor {
        artifact_id: artifact_id.clone(),
        location,
        content_digest: Some(digest.clone()),
        size_bytes: Some(bytes_transferred),
        media_type: request.media_type.clone(),
        origin: request.origin.clone(),
    };
    ArtifactTransferReceipt {
        transfer_id: request.transfer_id.clone(),
        source: descriptor(request.source.clone()),
        destination: descriptor(request.destination.clone()),
        transport: transport.to_string(),
        bytes_transferred,
    }
}

/// Directory transfer uses a deterministic tree digest and stages a complete
/// sibling directory before publication. WalkDir never follows symlinks; on
/// Unix a symlink is recreated as metadata rather than dereferenced.
async fn transfer_local_directory(
    request: &ArtifactTransferRequest,
    source: PathBuf,
    destination: PathBuf,
) -> Result<ArtifactTransferReceipt, ArtifactTransferError> {
    let destination_parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or("Artifact directory destination 缺少父目录")?;
    tokio::fs::create_dir_all(destination_parent).await?;
    if !tokio::fs::metadata(destination_parent).await?.is_dir() {
        return Err(format!(
            "Artifact destination 父路径 '{}' 不是目录",
            destination_parent.display()
        )
        .into());
    }
    if request.overwrite == ArtifactOverwritePolicy::Deny
        && tokio::fs::try_exists(&destination).await?
    {
        if !tokio::fs::metadata(&destination).await?.is_dir() {
            return Err(format!(
                "Artifact destination '{}' 已存在且不是目录",
                destination.display()
            )
            .into());
        }
        let (source_size, source_digest) = inspect_local_directory_artifact(&source).await?;
        let (destination_size, destination_digest) =
            inspect_local_directory_artifact(&destination).await?;
        if source_size == destination_size && source_digest == destination_digest {
            if request
                .expected_source_digest
                .as_deref()
                .is_some_and(|expected| expected != source_digest)
            {
                return Err("Artifact directory source digest 与前置条件冲突".into());
            }
            let artifact_id = format!("artifact:{source_digest}");
            let descriptor = |location: ArtifactLocation| ArtifactDescriptor {
                artifact_id: artifact_id.clone(),
                location,
                content_digest: Some(source_digest.clone()),
                size_bytes: Some(source_size),
                media_type: request
                    .media_type
                    .clone()
                    .or_else(|| Some("application/vnd.morphz.directory".to_string())),
                origin: request.origin.clone(),
            };
            return Ok(ArtifactTransferReceipt {
                transfer_id: request.transfer_id.clone(),
                source: descriptor(request.source.clone()),
                destination: descriptor(request.destination.clone()),
                transport: "local_tree_copy_reconciled".to_string(),
                bytes_transferred: source_size,
            });
        }
        return Err(format!(
            "Artifact destination '{}' 已存在且内容不同",
            destination.display()
        )
        .into());
    }

    let temporary = unique_staging_path(destination_parent, &request.transfer_id, "tree");
    tokio::fs::create_dir(&temporary).await?;
    let mut temporary_guard = StagingPathGuard::directory(temporary.clone());
    let mut entries = walkdir::WalkDir::new(&source)
        .follow_links(false)
        .min_depth(1)
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?;
    entries.sort_by(|left, right| left.path().cmp(right.path()));

    let total_bytes = entries.iter().try_fold(0_u64, |total, entry| {
        let metadata = std::fs::symlink_metadata(entry.path())?;
        Ok::<_, std::io::Error>(if metadata.is_file() {
            total.saturating_add(metadata.len())
        } else {
            total
        })
    })?;
    report_artifact_bytes("copying_directory", 0, Some(total_bytes));

    let mut tree_hasher = Sha256::new();
    let mut bytes_transferred = 0_u64;
    for entry in entries {
        let relative = entry.path().strip_prefix(&source)?;
        let target = temporary.join(relative);
        hash_tree_entry_path(&mut tree_hasher, relative);
        let metadata = std::fs::symlink_metadata(entry.path())?;
        if metadata.is_dir() {
            tree_hasher.update(b"directory\0");
            tokio::fs::create_dir(&target).await?;
        } else if metadata.is_file() {
            tree_hasher.update(b"file\0");
            let (size, digest) = copy_file_and_digest(
                entry.path(),
                &target,
                bytes_transferred,
                total_bytes,
                relative,
            )
            .await?;
            tree_hasher.update(size.to_be_bytes());
            tree_hasher.update(digest);
            bytes_transferred = bytes_transferred.saturating_add(size);
        } else if metadata.file_type().is_symlink() {
            tree_hasher.update(b"symlink\0");
            let link_target = std::fs::read_link(entry.path())?;
            hash_os_string(&mut tree_hasher, link_target.as_os_str());
            recreate_symlink(&link_target, &target)?;
        } else {
            return Err(format!(
                "Artifact directory 包含不支持的文件类型：'{}'",
                entry.path().display()
            )
            .into());
        }
    }
    let digest = format!("sha256:{:x}", tree_hasher.finalize());
    if request
        .expected_source_digest
        .as_deref()
        .is_some_and(|expected| expected != digest)
    {
        return Err(format!(
            "Artifact directory source digest 冲突：期望 '{}'，实际 '{}'",
            request
                .expected_source_digest
                .as_deref()
                .unwrap_or_default(),
            digest
        )
        .into());
    }

    mark_artifact_transfer_side_effect().await?;
    publish_staged_path(
        &temporary,
        &destination,
        request.overwrite,
        &request.transfer_id,
    )
    .await?;
    temporary_guard.disarm();
    let artifact_id = format!("artifact:{digest}");
    let descriptor = |location: ArtifactLocation| ArtifactDescriptor {
        artifact_id: artifact_id.clone(),
        location,
        content_digest: Some(digest.clone()),
        size_bytes: Some(bytes_transferred),
        media_type: request
            .media_type
            .clone()
            .or_else(|| Some("application/vnd.morphz.directory".to_string())),
        origin: request.origin.clone(),
    };
    Ok(ArtifactTransferReceipt {
        transfer_id: request.transfer_id.clone(),
        source: descriptor(request.source.clone()),
        destination: descriptor(request.destination.clone()),
        transport: "local_tree_copy".to_string(),
        bytes_transferred,
    })
}

/// Compute the transport-independent identity of a directory Artifact.
///
/// Directory bytes may travel as a tar stream, multipart object, or another
/// backend-specific representation.  Receipts use this logical tree digest
/// and the sum of regular-file bytes, never the envelope digest/size.
pub(crate) async fn inspect_local_directory_artifact(
    source: &Path,
) -> Result<(u64, String), ArtifactTransferError> {
    let mut entries = walkdir::WalkDir::new(source)
        .follow_links(false)
        .min_depth(1)
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?;
    entries.sort_by(|left, right| left.path().cmp(right.path()));

    let mut tree_hasher = Sha256::new();
    let mut logical_bytes = 0_u64;
    for entry in entries {
        let relative = entry.path().strip_prefix(source)?;
        hash_tree_entry_path(&mut tree_hasher, relative);
        let metadata = std::fs::symlink_metadata(entry.path())?;
        if metadata.is_dir() {
            tree_hasher.update(b"directory\0");
        } else if metadata.is_file() {
            tree_hasher.update(b"file\0");
            let (size, digest) = digest_file_raw(entry.path()).await?;
            tree_hasher.update(size.to_be_bytes());
            tree_hasher.update(digest);
            logical_bytes = logical_bytes.saturating_add(size);
        } else if metadata.file_type().is_symlink() {
            tree_hasher.update(b"symlink\0");
            let target = std::fs::read_link(entry.path())?;
            hash_os_string(&mut tree_hasher, target.as_os_str());
        } else {
            return Err(format!(
                "Artifact directory 包含不支持的文件类型：'{}'",
                entry.path().display()
            )
            .into());
        }
    }
    Ok((
        logical_bytes,
        format!("sha256:{:x}", tree_hasher.finalize()),
    ))
}

async fn copy_file_and_digest(
    source: &Path,
    destination: &Path,
    base_bytes: u64,
    total_bytes: u64,
    relative: &Path,
) -> Result<(u64, [u8; 32]), ArtifactTransferError> {
    let mut reader = tokio::fs::File::open(source).await?;
    let mut writer = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .await?;
    let mut hasher = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = vec![0_u8; 128 * 1024];
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        writer.write_all(&buffer[..count]).await?;
        hasher.update(&buffer[..count]);
        size = size.saturating_add(count as u64);
        report_artifact_transfer_progress(ArtifactTransferProgress {
            phase: "copying_directory".to_string(),
            bytes_transferred: base_bytes.saturating_add(size),
            total_bytes: Some(total_bytes),
            current_entry: Some(relative.to_string_lossy().into_owned()),
        });
    }
    writer.flush().await?;
    writer.sync_data().await?;
    Ok((size, hasher.finalize().into()))
}

async fn publish_staged_path(
    staged: &Path,
    destination: &Path,
    overwrite: ArtifactOverwritePolicy,
    transfer_id: &str,
) -> Result<(), ArtifactTransferError> {
    match overwrite {
        ArtifactOverwritePolicy::Deny => tokio::fs::rename(staged, destination).await?,
        ArtifactOverwritePolicy::Replace => {
            if !tokio::fs::try_exists(destination).await? {
                tokio::fs::rename(staged, destination).await?;
                return Ok(());
            }
            let parent = destination
                .parent()
                .ok_or("Artifact destination 缺少父目录")?;
            let backup = unique_staging_path(parent, transfer_id, "backup");
            tokio::fs::rename(destination, &backup).await?;
            let mut backup_guard = StagingPathGuard::unknown(backup.clone());
            match tokio::fs::rename(staged, destination).await {
                Ok(()) => {
                    backup_guard.remove_now()?;
                }
                Err(error) => {
                    let _ = tokio::fs::rename(&backup, destination).await;
                    backup_guard.disarm();
                    return Err(error.into());
                }
            }
        }
    }
    Ok(())
}

fn unique_staging_path(parent: &Path, transfer_id: &str, suffix: &str) -> PathBuf {
    let safe_id = transfer_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    parent.join(format!(
        ".morphz-transfer-{safe_id}-{}-{suffix}",
        UtcTimestamp::now()
    ))
}

struct UtcTimestamp;

impl UtcTimestamp {
    fn now() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            .try_into()
            .unwrap_or(i64::MAX)
    }
}

#[derive(Clone, Copy)]
enum StagingPathKind {
    File,
    Directory,
    Unknown,
}

struct StagingPathGuard {
    path: PathBuf,
    kind: StagingPathKind,
    armed: bool,
}

impl StagingPathGuard {
    fn file(path: PathBuf) -> Self {
        Self {
            path,
            kind: StagingPathKind::File,
            armed: true,
        }
    }

    fn directory(path: PathBuf) -> Self {
        Self {
            path,
            kind: StagingPathKind::Directory,
            armed: true,
        }
    }

    fn unknown(path: PathBuf) -> Self {
        Self {
            path,
            kind: StagingPathKind::Unknown,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }

    fn remove_now(&mut self) -> std::io::Result<()> {
        remove_staging_path(&self.path, self.kind)?;
        self.armed = false;
        Ok(())
    }
}

impl Drop for StagingPathGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = remove_staging_path(&self.path, self.kind);
        }
    }
}

fn remove_staging_path(path: &Path, kind: StagingPathKind) -> std::io::Result<()> {
    match kind {
        StagingPathKind::File => std::fs::remove_file(path),
        StagingPathKind::Directory => std::fs::remove_dir_all(path),
        StagingPathKind::Unknown => match std::fs::symlink_metadata(path) {
            Ok(metadata) if metadata.is_dir() => std::fs::remove_dir_all(path),
            Ok(_) => std::fs::remove_file(path),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        },
    }
}

fn hash_tree_entry_path(hasher: &mut Sha256, path: &Path) {
    hash_os_string(hasher, path.as_os_str());
}

fn hash_os_string(hasher: &mut Sha256, value: &std::ffi::OsStr) {
    let value = value.to_string_lossy();
    hasher.update(value.len().to_be_bytes());
    hasher.update(value.as_bytes());
}

#[cfg(unix)]
fn recreate_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn recreate_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    if target.is_dir() {
        std::os::windows::fs::symlink_dir(target, link)
    } else {
        std::os::windows::fs::symlink_file(target, link)
    }
}

impl ArtifactTransferRegistry {
    pub fn register(&self, backend: Arc<dyn ArtifactTransferBackend>) {
        self.backends
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(backend.name().to_string(), backend);
    }

    pub fn names(&self) -> Vec<String> {
        let mut names = self
            .backends
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        names.sort();
        names
    }

    pub async fn transfer(
        &self,
        request: &ArtifactTransferRequest,
    ) -> Result<ArtifactTransferReceipt, ArtifactTransferError> {
        request.validate()?;
        let implementation = {
            let backends = self
                .backends
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let mut names = backends.keys().cloned().collect::<Vec<_>>();
            names.sort();
            names.into_iter().find_map(|name| {
                backends
                    .get(&name)
                    .filter(|backend| backend.supports(request))
                    .cloned()
            })
        }
        .ok_or("没有 Runtime Artifact Transport 能处理当前源与目的 Route")?;
        let receipt = implementation.transfer(request).await?;
        receipt.validate_against(request)?;
        Ok(receipt)
    }
}

fn validate_sha256_digest(value: &str) -> Result<(), ArtifactTransferError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err("Artifact content_digest 必须使用 sha256:<hex>".into());
    };
    if hex.len() != 64
        || !hex.bytes().all(|byte| byte.is_ascii_hexdigit())
        || hex.bytes().any(|byte| byte.is_ascii_uppercase())
    {
        return Err("Artifact SHA-256 摘要必须包含 64 个小写十六进制字符".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::{ApprovalDecision, ApprovalProvider, ApprovalRequest};
    use crate::execution_target::DEFAULT_EXECUTION_TARGET_ID;
    use crate::permission::{PermissionConfig, PermissionMode, PermissionProfile};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct CountingApprovalProvider {
        decision: ApprovalDecision,
        calls: Arc<AtomicUsize>,
    }

    #[async_trait::async_trait]
    impl ApprovalProvider for CountingApprovalProvider {
        async fn review(
            &self,
            _request: &ApprovalRequest,
        ) -> Result<ApprovalDecision, Box<dyn std::error::Error + Send + Sync>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.decision.clone())
        }
    }

    fn permission_broker(
        workspace: &Path,
        mode: PermissionMode,
        decision: ApprovalDecision,
        calls: Arc<AtomicUsize>,
    ) -> Arc<PermissionBroker> {
        let config = PermissionConfig {
            workspace_root: workspace.to_string_lossy().into_owned(),
            mode,
            ..PermissionConfig::default()
        };
        Arc::new(PermissionBroker::new(
            Arc::new(PermissionProfile::from_config(&config).unwrap()),
            Arc::new(CountingApprovalProvider { decision, calls }),
        ))
    }

    fn location(target: &str, path: &str) -> ArtifactLocation {
        ArtifactLocation {
            target_id: target.to_string(),
            workspace_identity: Some("workspace".to_string()),
            path: path.to_string(),
        }
    }

    #[test]
    fn artifact_locations_are_target_scoped_but_not_artificially_jailed() {
        let a = location("target-a", "../shared/result.bin");
        let b = location("target-b", "/opt/results/result.bin");
        assert_ne!(a, b);
        a.validate().unwrap();
        b.validate().unwrap();
    }

    #[test]
    fn transfer_cannot_treat_one_location_as_a_copy() {
        let source = location("target-a", "result.bin");
        let request = ArtifactTransferRequest {
            transfer_id: "transfer-1".to_string(),
            destination: source.clone(),
            source,
            overwrite: ArtifactOverwritePolicy::Deny,
            expected_source_digest: None,
            media_type: None,
            origin: None,
        };
        assert!(request.validate().is_err());
    }

    #[test]
    fn digest_is_optional_but_strict_when_present() {
        let mut request = ArtifactTransferRequest {
            transfer_id: "transfer-1".to_string(),
            source: location("target-a", "result.bin"),
            destination: location("target-b", "result.bin"),
            overwrite: ArtifactOverwritePolicy::Deny,
            expected_source_digest: None,
            media_type: None,
            origin: None,
        };
        request.validate().unwrap();
        request.expected_source_digest = Some(format!("sha256:{}", "A".repeat(64)));
        assert!(request.validate().is_err());
    }

    #[tokio::test]
    async fn local_file_transfer_is_content_verified_and_idempotent_without_clobbering() {
        let temp = tempfile::tempdir().unwrap();
        let source_path = temp.path().join("source.bin");
        let destination_path = temp.path().join("destination.bin");
        tokio::fs::write(&source_path, b"morphz artifact")
            .await
            .unwrap();
        let request = ArtifactTransferRequest {
            transfer_id: "file-transfer".to_string(),
            source: location("target-default", source_path.to_str().unwrap()),
            destination: location("target-default", destination_path.to_str().unwrap()),
            overwrite: ArtifactOverwritePolicy::Deny,
            expected_source_digest: None,
            media_type: Some("application/octet-stream".to_string()),
            origin: None,
        };
        let receipt = transfer_local_file(&request, source_path.clone(), destination_path.clone())
            .await
            .unwrap();
        receipt.validate_against(&request).unwrap();
        assert_eq!(
            tokio::fs::read(&destination_path).await.unwrap(),
            b"morphz artifact"
        );
        let replay = transfer_local_file(&request, source_path, destination_path)
            .await
            .unwrap();
        assert_eq!(replay.transport, "local_copy_reconciled");
        assert_eq!(
            replay.destination.content_digest,
            receipt.destination.content_digest
        );
    }

    #[tokio::test]
    async fn local_directory_transfer_preserves_tree_and_uses_manifest_digest() {
        let temp = tempfile::tempdir().unwrap();
        let source_path = temp.path().join("source-tree");
        let destination_path = temp.path().join("destination-tree");
        tokio::fs::create_dir(&source_path).await.unwrap();
        tokio::fs::create_dir(source_path.join("nested"))
            .await
            .unwrap();
        tokio::fs::write(source_path.join("root.txt"), b"root")
            .await
            .unwrap();
        tokio::fs::write(source_path.join("nested/leaf.txt"), b"leaf")
            .await
            .unwrap();
        let request = ArtifactTransferRequest {
            transfer_id: "tree-transfer".to_string(),
            source: location("target-default", source_path.to_str().unwrap()),
            destination: location("target-default", destination_path.to_str().unwrap()),
            overwrite: ArtifactOverwritePolicy::Deny,
            expected_source_digest: None,
            media_type: None,
            origin: None,
        };
        let receipt = transfer_local_file(&request, source_path, destination_path.clone())
            .await
            .unwrap();
        receipt.validate_against(&request).unwrap();
        assert_eq!(receipt.transport, "local_tree_copy");
        assert_eq!(receipt.bytes_transferred, 8);
        assert_eq!(
            tokio::fs::read(destination_path.join("nested/leaf.txt"))
                .await
                .unwrap(),
            b"leaf"
        );
        assert_eq!(
            receipt.destination.media_type.as_deref(),
            Some("application/vnd.morphz.directory")
        );
    }

    #[tokio::test]
    async fn transfer_uses_the_existing_permission_profile_for_workspace_and_approval_expansion() {
        for mode in [PermissionMode::RequestApproval, PermissionMode::AutoReview] {
            let workspace = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            let source = workspace.path().join("source.bin");
            let destination = outside.path().join(format!("{mode:?}-destination.bin"));
            tokio::fs::write(&source, b"approved transfer")
                .await
                .unwrap();
            let calls = Arc::new(AtomicUsize::new(0));
            let backend = LocalArtifactTransferBackend::new(permission_broker(
                workspace.path(),
                mode,
                ApprovalDecision::AllowOnce {
                    rationale: "test grants the exact transfer boundary".to_string(),
                    risk_tags: Vec::new(),
                },
                calls.clone(),
            ));
            let request = ArtifactTransferRequest {
                transfer_id: format!("permission-{mode:?}"),
                source: location(DEFAULT_EXECUTION_TARGET_ID, source.to_str().unwrap()),
                destination: location(DEFAULT_EXECUTION_TARGET_ID, destination.to_str().unwrap()),
                overwrite: ArtifactOverwritePolicy::Deny,
                expected_source_digest: None,
                media_type: None,
                origin: None,
            };
            backend.transfer(&request).await.unwrap();
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            assert_eq!(
                tokio::fs::read(destination).await.unwrap(),
                b"approved transfer"
            );
        }

        let workspace = tempfile::tempdir().unwrap();
        let source = workspace.path().join("inside-source.bin");
        let destination = workspace.path().join("inside-destination.bin");
        tokio::fs::write(&source, b"workspace transfer")
            .await
            .unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let backend = LocalArtifactTransferBackend::new(permission_broker(
            workspace.path(),
            PermissionMode::RequestApproval,
            ApprovalDecision::Deny {
                rationale: "must not be consulted".to_string(),
                risk_tags: Vec::new(),
            },
            calls.clone(),
        ));
        backend
            .transfer(&ArtifactTransferRequest {
                transfer_id: "workspace-needs-no-review".to_string(),
                source: location(DEFAULT_EXECUTION_TARGET_ID, source.to_str().unwrap()),
                destination: location(DEFAULT_EXECUTION_TARGET_ID, destination.to_str().unwrap()),
                overwrite: ArtifactOverwritePolicy::Deny,
                expected_source_digest: None,
                media_type: None,
                origin: None,
            })
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn transfer_respects_reviewer_denial_and_non_overridable_protected_paths() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let source = workspace.path().join("source.bin");
        let denied_destination = outside.path().join("denied.bin");
        tokio::fs::write(&source, b"denied transfer").await.unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let backend = LocalArtifactTransferBackend::new(permission_broker(
            workspace.path(),
            PermissionMode::RequestApproval,
            ApprovalDecision::Deny {
                rationale: "user denied".to_string(),
                risk_tags: Vec::new(),
            },
            calls.clone(),
        ));
        let error = backend
            .transfer(&ArtifactTransferRequest {
                transfer_id: "permission-denied".to_string(),
                source: location(DEFAULT_EXECUTION_TARGET_ID, source.to_str().unwrap()),
                destination: location(
                    DEFAULT_EXECUTION_TARGET_ID,
                    denied_destination.to_str().unwrap(),
                ),
                overwrite: ArtifactOverwritePolicy::Deny,
                expected_source_digest: None,
                media_type: None,
                origin: None,
            })
            .await
            .unwrap_err();
        assert!(error.to_string().contains("权限审批拒绝"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(!tokio::fs::try_exists(&denied_destination).await.unwrap());

        let protected_parent = workspace.path().join(".ssh");
        tokio::fs::create_dir(&protected_parent).await.unwrap();
        let protected_source = protected_parent.join("id_test");
        tokio::fs::write(&protected_source, b"secret")
            .await
            .unwrap();
        let protected_destination = workspace.path().join("must-not-exist");
        let calls = Arc::new(AtomicUsize::new(0));
        let backend = LocalArtifactTransferBackend::new(permission_broker(
            workspace.path(),
            PermissionMode::AutoReview,
            ApprovalDecision::AllowOnce {
                rationale: "review cannot override protected paths".to_string(),
                risk_tags: Vec::new(),
            },
            calls.clone(),
        ));
        let error = backend
            .transfer(&ArtifactTransferRequest {
                transfer_id: "protected-source".to_string(),
                source: location(
                    DEFAULT_EXECUTION_TARGET_ID,
                    protected_source.to_str().unwrap(),
                ),
                destination: location(
                    DEFAULT_EXECUTION_TARGET_ID,
                    protected_destination.to_str().unwrap(),
                ),
                overwrite: ArtifactOverwritePolicy::Deny,
                expected_source_digest: None,
                media_type: None,
                origin: None,
            })
            .await
            .unwrap_err();
        assert!(error.to_string().contains("protected_paths"));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(!tokio::fs::try_exists(&protected_destination).await.unwrap());
    }

    #[tokio::test]
    async fn full_access_transfer_does_not_invent_a_second_workspace_jail() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let source = outside.path().join("outside-source.bin");
        let destination = outside.path().join("outside-destination.bin");
        tokio::fs::write(&source, b"full access transfer")
            .await
            .unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let backend = LocalArtifactTransferBackend::new(permission_broker(
            workspace.path(),
            PermissionMode::FullAccess,
            ApprovalDecision::Deny {
                rationale: "full access must not ask".to_string(),
                risk_tags: Vec::new(),
            },
            calls.clone(),
        ));
        backend
            .transfer(&ArtifactTransferRequest {
                transfer_id: "full-access-outside-workspace".to_string(),
                source: location(DEFAULT_EXECUTION_TARGET_ID, source.to_str().unwrap()),
                destination: location(DEFAULT_EXECUTION_TARGET_ID, destination.to_str().unwrap()),
                overwrite: ArtifactOverwritePolicy::Deny,
                expected_source_digest: None,
                media_type: None,
                origin: None,
            })
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            tokio::fs::read(destination).await.unwrap(),
            b"full access transfer"
        );
    }
}
