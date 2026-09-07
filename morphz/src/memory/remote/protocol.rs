//! A coarse-grained commit, never individual SQL requests. Integer values are
//! strings so nanosecond clocks and u64-derived SQLite identities survive JS.
use serde::{Deserialize, Serialize};

pub const PROTOCOL: &str = "morphz-runtime-store/1";
pub const MAX_COMMIT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_RECORD_BYTES: usize = 1024 * 1024;
pub type StoreError = Box<dyn std::error::Error + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Fence {
    pub owner_id: String,
    pub epoch: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Lease {
    pub owner_id: String,
    pub epoch: u64,
    /// Remaining duration measured by the authority. Clients use a monotonic
    /// clock started before the RPC, never compare their UTC clock with it.
    pub ttl_ms: u64,
}

impl Lease {
    pub fn fence(&self) -> Fence {
        Fence {
            owner_id: self.owner_id.clone(),
            epoch: self.epoch,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub table: String,
    pub key: String,
    pub values: Option<Vec<Vec<String>>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Head {
    pub protocol: String,
    pub schema: Option<String>,
    pub revision: u64,
    pub sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Commit {
    pub protocol: String,
    pub schema: String,
    pub base_revision: u64,
    pub sequence: u64,
    pub changes: Vec<Change>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Page {
    pub head: Head,
    pub records: Vec<Change>,
    pub next: Option<String>,
}

/// Transport is deployment-injected and authenticated outside model authority.
/// No method may select a different backend or return cached success on failure.
#[async_trait::async_trait]
pub trait RemoteStoreTransport: Send + Sync {
    async fn head(&self, fence: &Fence) -> Result<Head, StoreError>;
    async fn page(
        &self,
        fence: &Fence,
        revision: u64,
        after: Option<&str>,
    ) -> Result<Page, StoreError>;
    async fn commit(&self, fence: &Fence, request: &Commit) -> Result<Head, StoreError>;
}

#[async_trait::async_trait]
pub trait RemoteStoreLeaseTransport: RemoteStoreTransport {
    async fn claim(&self, owner_id: &str) -> Result<Lease, StoreError>;
    async fn renew(&self, fence: &Fence) -> Result<Lease, StoreError>;
    /// Only call after the Runtime's complete startup recovery, never just
    /// because the storage snapshot has finished downloading.
    async fn complete_recovery(&self, fence: &Fence) -> Result<(), StoreError>;
}
