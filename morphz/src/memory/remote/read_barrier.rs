//! Read results are owned values after local computation. Their independent
//! fenced head RPCs may overlap, but no write, restore or park may pass them.
//! This is not a cache of authorization or a shared head receipt.
use super::{replica::Replica, StoreError};
use std::sync::Mutex;
use tokio::sync::Notify;

// Bound outstanding Store head RPCs even if callers flood the native interface.
// Writers use the same FIFO replica mutex, so readers cannot starve a writer.
const MAX_PENDING_READS: usize = 32;

#[derive(Default)]
struct State {
    pending: usize,
    invalidated: bool,
}

#[derive(Default)]
pub(super) struct ReadBarrier {
    state: Mutex<State>,
    drained: Notify,
}

pub(super) struct ReadValidation<'a> {
    barrier: &'a ReadBarrier,
    replica: &'a tokio::sync::Mutex<Option<Replica>>,
    validated: bool,
}

impl ReadBarrier {
    pub(super) fn at_capacity(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .pending
            >= MAX_PENDING_READS
    }

    pub(super) fn invalidated(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .invalidated
    }

    /// Caller holds the replica mutex and has computed a journal-empty result.
    pub(super) fn begin<'a>(
        &'a self,
        replica: &'a tokio::sync::Mutex<Option<Replica>>,
    ) -> Result<ReadValidation<'a>, StoreError> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.invalidated {
            return Err("remote RuntimeStore read snapshot was invalidated".into());
        }
        if state.pending >= MAX_PENDING_READS {
            return Err("remote RuntimeStore read validation capacity exceeded".into());
        }
        state.pending += 1;
        Ok(ReadValidation {
            barrier: self,
            replica,
            validated: false,
        })
    }

    /// Caller holds the replica mutex, so no new reader can enroll. Existing
    /// readers finish without acquiring that mutex; this cannot deadlock them.
    pub(super) async fn wait(&self) {
        loop {
            let notified = self.drained.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .pending
                == 0
            {
                return;
            }
            notified.await;
        }
    }

    /// Only after wait(), with the replica mutex held and the old slot empty.
    pub(super) fn reset(&self) -> Result<(), StoreError> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.pending != 0 {
            return Err("remote RuntimeStore cannot reset pending read validation".into());
        }
        state.invalidated = false;
        Ok(())
    }
}

impl ReadValidation<'_> {
    pub(super) fn validated(&mut self) {
        self.validated = true;
    }
}

impl Drop for ReadValidation<'_> {
    fn drop(&mut self) {
        let mut state = self
            .barrier
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !self.validated {
            // The flag remains authoritative even if a writer currently holds
            // the mutex. It must observe this before committing its own delta.
            state.invalidated = true;
            if let Ok(mut slot) = self.replica.try_lock() {
                *slot = None;
            }
        }
        state.pending -= 1;
        if state.pending == 0 {
            self.barrier.drained.notify_waiters();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        future::{poll_fn, Future},
        task::Poll,
        time::Duration,
    };

    #[tokio::test]
    async fn pending_reads_are_bounded_and_drain_without_lost_notification() {
        let barrier = ReadBarrier::default();
        let replica = tokio::sync::Mutex::new(None);
        let mut readers = Vec::new();
        for _ in 0..MAX_PENDING_READS {
            readers.push(barrier.begin(&replica).unwrap());
        }
        assert!(barrier.at_capacity());
        assert!(barrier.begin(&replica).is_err());
        assert!(barrier.reset().is_err());
        let waiting = barrier.wait();
        tokio::pin!(waiting);
        assert!(poll_fn(|cx| Poll::Ready(waiting.as_mut().poll(cx).is_pending())).await);
        for mut reader in readers {
            reader.validated();
        }
        tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .unwrap();
        assert!(!barrier.at_capacity());
        assert!(!barrier.invalidated());
        barrier.reset().unwrap();
        // Also cover completion before the waiter registers.
        tokio::time::timeout(Duration::from_secs(1), barrier.wait())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_failed_read_cannot_be_cleared_by_another_successful_read() {
        let barrier = ReadBarrier::default();
        let replica = tokio::sync::Mutex::new(None);
        let failed = barrier.begin(&replica).unwrap();
        let mut successful = barrier.begin(&replica).unwrap();
        let _writer = replica.lock().await;
        drop(failed); // Cannot acquire the replica mutex, but still poisons it.
        assert!(barrier.invalidated());
        assert!(barrier.reset().is_err());
        assert!(barrier.begin(&replica).is_err());
        successful.validated();
        drop(successful);
        barrier.wait().await;
        assert!(barrier.invalidated());
        barrier.reset().unwrap();
        assert!(!barrier.invalidated());
    }
}
