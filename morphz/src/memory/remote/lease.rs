//! Lease renewal has no dependency on the Runtime transaction mutex, output
//! delivery, tool completion, or replica reconstruction.
use super::protocol::*;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{task::JoinHandle, time::Instant};

pub(super) struct LeaseGuard {
    task: JoinHandle<()>,
}

impl Drop for LeaseGuard {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl LeaseGuard {
    pub fn start(
        transport: Arc<dyn RemoteStoreLeaseTransport>,
        lease: Lease,
        started: Instant,
        lost: Arc<AtomicBool>,
    ) -> Result<Self, StoreError> {
        let fence = lease.fence();
        if lease.ttl_ms == 0 || lease.ttl_ms > 24 * 60 * 60 * 1000 || fence.owner_id.is_empty() {
            return Err("invalid remote Store lease".into());
        }
        let mut deadline = started + Duration::from_millis(lease.ttl_ms);
        if deadline <= Instant::now() {
            return Err("remote Store lease expired during claim".into());
        }
        let task =
            tokio::spawn(async move {
                loop {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    tokio::time::sleep((remaining / 3).min(Duration::from_secs(10))).await;
                    if lost.load(Ordering::Acquire) {
                        break;
                    }
                    let started = Instant::now();
                    let result = tokio::time::timeout_at(deadline, transport.renew(&fence)).await;
                    match result {
                        Ok(Ok(lease))
                            if lease.fence() == fence
                                && lease.ttl_ms > 0
                                && lease.ttl_ms <= 24 * 60 * 60 * 1000 =>
                        {
                            deadline = started + Duration::from_millis(lease.ttl_ms);
                            if deadline > Instant::now() {
                                continue;
                            }
                        }
                        _ => {}
                    }
                    lost.store(true, Ordering::Release);
                    tracing::error!(event_code = "memory.remote_store.ownership_lost",
                    "Remote Store ownership could not be renewed; this compute instance is fenced");
                    break;
                }
            });
        Ok(Self { task })
    }
}
