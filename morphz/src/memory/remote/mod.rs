//! Backend-independent, fenced remote persistence for the complete RuntimeStore.
//! The local SQLite instance only computes transactions. A remote failure never
//! acknowledges an operation or silently promotes that disposable replica.
mod lease;
#[cfg(test)]
mod observer_tests;
pub mod protocol;
mod quiescence;
pub mod recovery;
mod replica;

use super::*;
use crate::event::Event;
use crate::scheduler::*;
pub mod host_configuration;
pub mod host_credentials;
pub mod host_files;
pub mod host_lifecycle;
pub mod host_observers;
pub mod http;
use protocol::{Commit, Fence, Head, RemoteStoreTransport, StoreError, PROTOCOL};
use replica::Replica;
use std::{
    future::Future,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock,
    },
};
use tokio::sync::Mutex;

pub struct RemoteRuntimeStore {
    transport: Arc<dyn RemoteStoreTransport>,
    fence: Fence,
    replica: Mutex<Option<Replica>>,
    lost: Arc<AtomicBool>,
    lease_control: Option<Arc<dyn protocol::RemoteStoreLeaseTransport>>,
    _lease_guard: Option<lease::LeaseGuard>,
    observer_progress: OnceLock<Arc<host_observers::ObserverProgress>>,
}

/// Once a park RPC starts, only an explicit busy receipt proves this owner may
/// continue. Error, cancellation and success all fence local work immediately.
struct ParkDecision<'a> {
    lost: &'a AtomicBool,
    observers: Option<host_observers::ObserverPause>,
    busy: bool,
}

impl Drop for ParkDecision<'_> {
    fn drop(&mut self) {
        if !self.busy {
            self.lost.store(true, Ordering::Release);
            if let Some(observers) = self.observers.take() {
                observers.seal();
            }
        }
    }
}

impl RemoteRuntimeStore {
    pub async fn connect(
        transport: Arc<dyn RemoteStoreTransport>,
        fence: Fence,
    ) -> Result<Self, StoreError> {
        let store = Self {
            transport,
            fence,
            replica: Mutex::new(None),
            lost: Arc::new(AtomicBool::new(false)),
            lease_control: None,
            _lease_guard: None,
            observer_progress: OnceLock::new(),
        };
        // Connecting validates schema/ownership and restores the complete state;
        // never create a local empty Runtime because the remote is unreachable.
        *store.replica.lock().await = Some(store.restore().await?);
        Ok(store)
    }

    /// Claims a fresh process identity and starts renewal before restoring the
    /// replica. The caller must run Runtime recovery and then explicitly call
    /// `complete_recovery`. Dropping the Store stops renewal, never pretends to
    /// park possibly unfinished work; lease expiry schedules durable recovery.
    pub async fn connect_owned(
        transport: Arc<dyn protocol::RemoteStoreLeaseTransport>,
    ) -> Result<Self, StoreError> {
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce)
            .map_err(|error| format!("cannot generate compute owner identity: {error}"))?;
        let owner_id = format!(
            "runtime-{}",
            nonce
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        let started = tokio::time::Instant::now();
        let claimed = transport.claim(&owner_id).await?;
        if claimed.owner_id != owner_id {
            return Err("remote Store claimed a different owner".into());
        }
        let lost = Arc::new(AtomicBool::new(false));
        let guard =
            lease::LeaseGuard::start(transport.clone(), claimed.clone(), started, lost.clone())?;
        let store = Self {
            transport: transport.clone(),
            fence: claimed.fence(),
            replica: Mutex::new(None),
            lost,
            lease_control: Some(transport),
            _lease_guard: Some(guard),
            observer_progress: OnceLock::new(),
        };
        *store.replica.lock().await = Some(store.restore().await?);
        store.ensure_owned()?;
        Ok(store)
    }

    pub fn ownership_lost(&self) -> bool {
        self.lost.load(Ordering::Acquire)
    }

    pub fn compute_fence(&self) -> Fence {
        self.fence.clone()
    }

    pub fn ownership_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.lost)
    }

    /// The hosted embedding installs its observer delivery barrier once, before
    /// admitting HTTP. Ordinary/local Runtime embeddings do not select it.
    pub fn install_observer_progress(
        &self,
        progress: Arc<host_observers::ObserverProgress>,
    ) -> Result<(), StoreError> {
        if progress.fence() != &self.fence {
            return Err("observer barrier belongs to a different compute owner".into());
        }
        self.observer_progress
            .set(progress)
            .map_err(|_| "observer delivery barrier is already installed".into())
    }

    fn ensure_owned(&self) -> Result<(), StoreError> {
        if self.ownership_lost() {
            return Err(
                "remote RuntimeStore compute ownership lost; a new process must reclaim".into(),
            );
        }
        Ok(())
    }

    pub async fn complete_recovery(&self) -> Result<(), StoreError> {
        self.ensure_owned()?;
        self.lease_control
            .as_ref()
            .ok_or("this Store uses an externally managed compute fence")?
            .complete_recovery(&self.fence)
            .await
    }

    /// Caller holds a closed HTTP admission gate. Taking the replica mutex
    /// prevents native workers from claiming any new physical operation during
    /// the final snapshot and park RPC. No business state is cancelled/rewritten.
    pub async fn try_park(&self, process_idle: impl Fn() -> bool) -> Result<bool, StoreError> {
        let mut slot = self.replica.lock().await;
        self.ensure_owned()?;
        if !process_idle() {
            return Ok(false);
        }
        let mut replica = match slot.take() {
            Some(replica) => replica,
            None => self.restore().await?,
        };
        let head = self.transport.head(&self.fence).await?;
        self.validate_head(&head, &replica.schema)?;
        if head.revision != replica.revision || head.sequence != replica.sequence {
            replica = self.restore().await?;
        }
        let snapshot = quiescence::inspect(&replica.store).await?;
        if !snapshot.blockers.is_empty() || !process_idle() {
            tracing::debug!(event_code = "host.park.deferred", blockers = ?snapshot.blockers, "Native owners are not quiescent");
            *slot = Some(replica);
            return Ok(false);
        }
        let observer_pause = if let Some(progress) = self.observer_progress.get() {
            let Some(pause) = progress.pause() else {
                *slot = Some(replica);
                return Ok(false);
            };
            if !pause.caught_up(&replica.store).await? || !process_idle() {
                *slot = Some(replica);
                return Ok(false);
            }
            Some(pause)
        } else {
            None
        };
        // Keep both the replica lock and the observer pause until the durable
        // park decision. No new fact or publication may cross this boundary.
        let lease_control = self
            .lease_control
            .as_ref()
            .ok_or("parking requires owned compute")?;
        let mut decision = ParkDecision {
            lost: &self.lost,
            observers: observer_pause,
            busy: false,
        };
        let parked = lease_control
            .park(
                &self.fence,
                replica.revision,
                snapshot.next_wake.map(|time| time.timestamp_millis()),
            )
            .await?
            .parked;
        if !parked {
            decision.busy = true;
            *slot = Some(replica);
        }
        drop(decision);
        Ok(parked)
    }

    fn validate_head(&self, head: &Head, schema: &str) -> Result<(), StoreError> {
        const MAX_SAFE_COUNTER: u64 = (1 << 53) - 1;
        if head.revision > MAX_SAFE_COUNTER
            || head.sequence > MAX_SAFE_COUNTER
            || self.fence.epoch > MAX_SAFE_COUNTER
            || (head.schema.is_none() && (head.revision != 0 || head.sequence != 0))
        {
            return Err("invalid remote RuntimeStore head".into());
        }
        if head.protocol != PROTOCOL {
            return Err("unsupported remote RuntimeStore protocol".into());
        }
        if head.schema.as_ref().is_some_and(|remote| remote != schema) {
            return Err("remote RuntimeStore schema mismatch; explicit migration required".into());
        }
        Ok(())
    }

    async fn restore(&self) -> Result<Replica, StoreError> {
        let mut replica = Replica::create().await?;
        let head = self.transport.head(&self.fence).await?;
        self.validate_head(&head, &replica.schema)?;
        if head.schema.is_none() {
            let commit = Commit {
                protocol: PROTOCOL.into(),
                schema: replica.schema.clone(),
                base_revision: head.revision,
                sequence: head.sequence + 1,
                changes: replica.seed().await?,
            };
            let head = self.transport.commit(&self.fence, &commit).await?;
            self.validate_head(&head, &replica.schema)?;
            replica.revision = head.revision;
            replica.sequence = head.sequence;
        } else {
            replica.clear_seed().await?;
            let mut after = None;
            loop {
                let page = self
                    .transport
                    .page(&self.fence, head.revision, after.as_deref())
                    .await?;
                if page.head != head {
                    return Err("remote RuntimeStore snapshot changed during restore".into());
                }
                replica.import(&page.records).await?;
                if page.next.is_none() {
                    break;
                }
                if page.records.is_empty() || page.next == after {
                    return Err("remote RuntimeStore snapshot did not advance".into());
                }
                after = page.next;
            }
            replica.finish_import().await?;
            // Validate the fence and revision again even when the final page was
            // empty. A reclaimed owner must not start recovery on stale state.
            if self.transport.head(&self.fence).await? != head {
                return Err("remote RuntimeStore ownership or revision changed".into());
            }
            replica.revision = head.revision;
            replica.sequence = head.sequence;
        }
        replica.install_journal().await?;
        Ok(replica)
    }

    async fn execute<T, F, Fut>(&self, operation: F) -> Result<T, StoreError>
    where
        T: Send,
        F: FnOnce(Arc<sqlite::SqliteStore>) -> Fut + Send,
        Fut: Future<Output = T> + Send,
    {
        let mut slot = self.replica.lock().await;
        self.ensure_owned()?;
        // Taking ownership is a cancellation guard: any dropped future leaves
        // None. A speculative or ambiguously committed cache is never reused.
        let mut replica = match slot.take() {
            Some(replica) => replica,
            None => self.restore().await?,
        };
        // Compute speculatively against the last acknowledged replica. Nothing
        // escapes this method until the live-fenced head (read) or atomic CAS
        // receipt (write) validates it below. A pre-read cannot protect that
        // interval and only adds a serialized network roundtrip. Any conflict
        // or lost receipt leaves the slot empty, so the next call restores.
        let result = operation(replica.store.clone()).await;
        self.ensure_owned()?;
        let changes = replica.changes().await?;
        if changes.is_empty() {
            // Reads must not create durable writes merely to prove ownership.
            // The live-fenced head validates the exact snapshot used above.
            let head = self.transport.head(&self.fence).await?;
            self.validate_head(&head, &replica.schema)?;
            if head.revision != replica.revision || head.sequence != replica.sequence {
                return Err("remote RuntimeStore changed during read".into());
            }
            *slot = Some(replica);
            return Ok(result);
        }
        let commit = Commit {
            protocol: PROTOCOL.into(),
            schema: replica.schema.clone(),
            base_revision: replica.revision,
            sequence: replica.sequence + 1,
            changes,
        };
        if serde_json::to_vec(&commit)?.len() > protocol::MAX_COMMIT_BYTES
            || commit.changes.iter().any(|change| {
                serde_json::to_vec(change)
                    .map_or(true, |bytes| bytes.len() > protocol::MAX_RECORD_BYTES)
            })
        {
            return Err("remote RuntimeStore atomic operation exceeds backend capacity".into());
        }
        // Native operations returning Err may have deliberately persisted bookkeeping;
        // their delta must be committed before returning that original result.
        let head = self.transport.commit(&self.fence, &commit).await?;
        self.validate_head(&head, &replica.schema)?;
        if head.revision != replica.revision + 1 || head.sequence != commit.sequence {
            return Err("invalid remote RuntimeStore commit receipt".into());
        }
        replica.clear_journal().await?;
        replica.revision = head.revision;
        replica.sequence = head.sequence;
        *slot = Some(replica);
        Ok(result)
    }
}

include!(concat!(env!("OUT_DIR"), "/remote_store_impls.rs"));
