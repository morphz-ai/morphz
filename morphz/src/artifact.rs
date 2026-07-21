//! Transport-neutral artifact exchange contracts for distinct Execution Targets.
//!
//! Morphz deliberately does not assume that two Targets with the same path
//! share a filesystem.  A transfer is therefore described by stable Target
//! and Workspace identities plus a content digest.  Backends may use Git,
//! object storage, a shared mount, or an Edge transport, but all of them must
//! return the same receipt and remain behind the normal Execution Job safety
//! boundary.

use std::collections::HashMap;
use std::error::Error;
use std::path::{Component, Path};
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};

pub type ArtifactTransferError = Box<dyn Error + Send + Sync>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct ArtifactLocation {
    pub target_id: String,
    pub workspace_identity: String,
    /// A Target-local path. Absolute paths and parent traversal are forbidden
    /// because the Target backend, not the cloud Runtime, owns its root.
    pub relative_path: String,
}

impl ArtifactLocation {
    pub fn validate(&self) -> Result<(), ArtifactTransferError> {
        if self.target_id.trim().is_empty() {
            return Err("Artifact target_id 不能为空".into());
        }
        if self.workspace_identity.trim().is_empty() {
            return Err("Artifact workspace_identity 不能为空".into());
        }
        let path = Path::new(&self.relative_path);
        if self.relative_path.trim().is_empty() || path.is_absolute() {
            return Err("Artifact relative_path 必须是非空相对路径".into());
        }
        if path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err("Artifact relative_path 不能越过 Workspace 根目录".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtifactDescriptor {
    pub artifact_id: String,
    pub location: ArtifactLocation,
    /// Lowercase `sha256:<hex>` over the exact bytes.
    pub content_digest: String,
    pub size_bytes: u64,
    pub media_type: Option<String>,
}

impl ArtifactDescriptor {
    pub fn validate(&self) -> Result<(), ArtifactTransferError> {
        self.location.validate()?;
        validate_sha256_digest(&self.content_digest)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtifactTransferRequest {
    pub transfer_id: String,
    pub source: ArtifactDescriptor,
    pub destination: ArtifactLocation,
    /// The Harness or user may forbid replacing an existing Target-local path.
    pub overwrite: bool,
}

impl ArtifactTransferRequest {
    pub fn validate(&self) -> Result<(), ArtifactTransferError> {
        if self.transfer_id.trim().is_empty() {
            return Err("Artifact transfer_id 不能为空".into());
        }
        self.source.validate()?;
        self.destination.validate()?;
        if self.source.location.target_id == self.destination.target_id
            && self.source.location.workspace_identity == self.destination.workspace_identity
            && self.source.location.relative_path == self.destination.relative_path
        {
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
    pub backend: String,
}

/// One explicitly configured transport. Implementations do not receive raw
/// credentials from the model; opaque endpoint references remain in the
/// owning Target/Node trust domain.
#[async_trait::async_trait]
pub trait ArtifactTransferBackend: Send + Sync {
    fn name(&self) -> &'static str;

    async fn transfer(
        &self,
        request: &ArtifactTransferRequest,
    ) -> Result<ArtifactTransferReceipt, ArtifactTransferError>;
}

/// Registry keyed by an explicit backend name selected by a Harness or
/// control-plane policy. It intentionally has no implicit fallback: changing
/// transfer mechanisms can change credentials, consistency and side effects.
#[derive(Default)]
pub struct ArtifactTransferRegistry {
    backends: RwLock<HashMap<String, Arc<dyn ArtifactTransferBackend>>>,
}

impl ArtifactTransferRegistry {
    pub fn register(&self, backend: Arc<dyn ArtifactTransferBackend>) {
        self.backends
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(backend.name().to_string(), backend);
    }

    pub fn backend(&self, name: &str) -> Option<Arc<dyn ArtifactTransferBackend>> {
        self.backends
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(name)
            .cloned()
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
        backend: &str,
        request: &ArtifactTransferRequest,
    ) -> Result<ArtifactTransferReceipt, ArtifactTransferError> {
        request.validate()?;
        let implementation = self
            .backend(backend)
            .ok_or_else(|| format!("Artifact Transfer Backend '{backend}' 未注册"))?;
        let receipt = implementation.transfer(request).await?;
        if receipt.transfer_id != request.transfer_id
            || receipt.source.content_digest != request.source.content_digest
            || receipt.destination.location != request.destination
            || receipt.destination.content_digest != request.source.content_digest
        {
            return Err("Artifact Transfer receipt 与请求或内容摘要不一致".into());
        }
        receipt.destination.validate()?;
        Ok(receipt)
    }
}

fn validate_sha256_digest(value: &str) -> Result<(), ArtifactTransferError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err("Artifact content_digest 必须使用 sha256:<hex>".into());
    };
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Artifact SHA-256 摘要必须包含 64 个十六进制字符".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor(target: &str, workspace: &str, path: &str) -> ArtifactDescriptor {
        ArtifactDescriptor {
            artifact_id: "artifact-1".to_string(),
            location: ArtifactLocation {
                target_id: target.to_string(),
                workspace_identity: workspace.to_string(),
                relative_path: path.to_string(),
            },
            content_digest: format!("sha256:{}", "a".repeat(64)),
            size_bytes: 42,
            media_type: Some("text/plain".to_string()),
        }
    }

    #[test]
    fn artifact_locations_are_target_and_workspace_scoped() {
        let a = descriptor("target-a", "workspace", "src/lib.rs");
        let b = descriptor("target-b", "workspace", "src/lib.rs");
        assert_ne!(a.location, b.location);
        a.validate().unwrap();
        b.validate().unwrap();
    }

    #[test]
    fn artifact_location_rejects_workspace_escape() {
        let mut value = descriptor("target-a", "workspace", "../secret");
        assert!(value.validate().is_err());
        value.location.relative_path = "/tmp/secret".to_string();
        assert!(value.validate().is_err());
    }

    #[test]
    fn transfer_cannot_treat_one_location_as_a_copy() {
        let source = descriptor("target-a", "workspace", "result.bin");
        let request = ArtifactTransferRequest {
            transfer_id: "transfer-1".to_string(),
            destination: source.location.clone(),
            source,
            overwrite: false,
        };
        assert!(request.validate().is_err());
    }
}
