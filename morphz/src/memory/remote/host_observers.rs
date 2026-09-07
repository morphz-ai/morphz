//! Pure local observer delivery state. No URL, credential, socket or HTTP client
//! lives here. The embedding must provide an authorized transport separately.
use super::protocol::{Fence, StoreError};
use crate::{
    event::Event,
    memory::{sqlite::SqliteStore, EventStore, QueryFilter},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

pub const MAX_OBSERVER_BATCH_BYTES: usize = 128 * 1024;
const MAX_EVENTS: usize = 64;
const MAX_SAFE_COUNTER: u64 = (1 << 53) - 1;

#[derive(Default)]
struct ProgressState {
    through: u64,
    publishing: bool,
    pending: bool,
    paused: bool,
    closed: bool,
}

/// Shared with the park check. It freezes acknowledgement and publication
/// while Runtime holds the replica lock and decides whether to release compute.
pub struct ObserverProgress {
    state: Mutex<ProgressState>,
    fence: Fence,
}
pub(super) struct ObserverPause(Arc<ObserverProgress>);
struct Publishing(Arc<ObserverProgress>);
impl ObserverProgress {
    pub(super) fn fence(&self) -> &Fence {
        &self.fence
    }
    pub(super) fn pause(self: &Arc<Self>) -> Option<ObserverPause> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.closed || state.paused || state.publishing || state.pending {
            return None;
        }
        state.paused = true;
        Some(ObserverPause(self.clone()))
    }
    fn publishing(self: &Arc<Self>) -> Option<Publishing> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.closed || state.paused || state.publishing {
            return None;
        }
        state.publishing = true;
        Some(Publishing(self.clone()))
    }
    fn advance(&self, through: u64) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.through = state.through.max(through);
    }
    fn pending(&self, pending: bool) {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .pending = pending;
    }
}
impl ObserverPause {
    /// A successful or ambiguous park permanently fences this process's queue.
    pub(super) fn seal(self) {
        self.0
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .closed = true;
    }

    /// Only call on the native replica while its RemoteRuntimeStore mutex is
    /// held. Producer timestamps are not a reliable append frontier.
    pub(super) async fn caught_up(&self, store: &SqliteStore) -> Result<bool, StoreError> {
        let events = store
            .query(QueryFilter {
                latest_k: Some(1),
                ..Default::default()
            })
            .await?;
        let latest = match events.last() {
            Some(event) => event
                .sequence
                .ok_or("authoritative Event has no physical sequence")?,
            None => 0,
        };
        let through = self
            .0
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .through;
        if through > latest {
            return Err("observer frontier is ahead of the authoritative Event Store".into());
        }
        Ok(through == latest)
    }
}
impl Drop for ObserverPause {
    fn drop(&mut self) {
        self.0
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .paused = false;
    }
}
impl Drop for Publishing {
    fn drop(&mut self) {
        self.0
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .publishing = false;
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ObserverBatch {
    pub sequence: u64,
    pub events: Vec<Event>,
    pub reset: bool,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObserverReceipt {
    pub epoch: u64,
    pub sequence: u64,
}

/// One bounded cycle of drafts followed by durable facts. Failed/ambiguous
/// attempts leave this exact batch at the front: the next attempt cannot reuse
/// its sequence with new content. Facts are certified only after the whole
/// cycle was acknowledged, even if earlier batches have already succeeded.
pub struct ObserverQueue {
    epoch: u64,
    sequence: u64,
    through: u64,
    staged_through: u64,
    pending: VecDeque<ObserverBatch>,
    progress: Arc<ObserverProgress>,
}
pub struct ObserverPublication<'a> {
    queue: &'a mut ObserverQueue,
    _permit: Publishing,
}
impl ObserverQueue {
    /// `initial_through` must come from the native startup snapshot. Existing
    /// readers are reset before opening the replacement host's HTTP port.
    pub fn new(fence: Fence, initial_through: u64) -> Result<Self, StoreError> {
        let epoch = fence.epoch;
        if fence.owner_id.is_empty()
            || fence.owner_id.len() > 256
            || epoch == 0
            || epoch > MAX_SAFE_COUNTER
            || initial_through > MAX_SAFE_COUNTER
        {
            return Err("invalid observer epoch or initial frontier".into());
        }
        let progress = Arc::new(ObserverProgress {
            state: Mutex::new(ProgressState::default()),
            fence,
        });
        progress.advance(initial_through);
        let mut queue = Self {
            epoch,
            sequence: 0,
            through: initial_through,
            staged_through: initial_through,
            pending: VecDeque::new(),
            progress,
        };
        queue.try_stage(&[], &[], true)?;
        Ok(queue)
    }
    pub fn progress(&self) -> Arc<ObserverProgress> {
        self.progress.clone()
    }
    pub fn through(&self) -> u64 {
        self.through
    }
    pub fn is_pending(&self) -> bool {
        !self.pending.is_empty()
    }
    /// `false` means the park barrier has frozen this queue. The caller retains
    /// its input and may retry only if the park decision reopens admission.
    pub fn try_stage(
        &mut self,
        durable: &[Event],
        drafts: &[Event],
        reset: bool,
    ) -> Result<bool, StoreError> {
        if self.is_pending() {
            return Err("observer cycle still awaiting acknowledgement".into());
        }
        if durable.len() > MAX_EVENTS || drafts.len() > MAX_EVENTS {
            return Err("observer cycle exceeds capacity".into());
        }
        let mut next_through = self.through;
        for event in durable {
            let sequence = event
                .sequence
                .ok_or("durable observer Event has no physical sequence")?;
            if sequence <= next_through || sequence > MAX_SAFE_COUNTER {
                return Err("durable observer frontier must advance in append order".into());
            }
            next_through = sequence;
        }
        if drafts
            .iter()
            .any(|event| event.sequence.is_some() || event.event_type != "runtime_ephemeral")
        {
            return Err("observer drafts cannot carry durable facts".into());
        }
        // Construct everything off to the side. Serialization/capacity failures
        // do not leave a partly staged cycle or consume sequence numbers.
        let mut batches = VecDeque::new();
        let mut sequence = self.sequence;
        let append = |batches: &mut VecDeque<ObserverBatch>,
                      sequence: &mut u64,
                      events: Vec<Event>,
                      reset|
         -> Result<(), StoreError> {
            *sequence = sequence
                .checked_add(1)
                .filter(|n| *n <= MAX_SAFE_COUNTER)
                .ok_or("observer sequence exhausted")?;
            batches.push_back(ObserverBatch {
                sequence: *sequence,
                events,
                reset,
            });
            Ok(())
        };
        if reset {
            append(&mut batches, &mut sequence, Vec::new(), true)?;
        }
        let mut batch = Vec::new();
        let mut size = 1024;
        for event in drafts.iter().chain(durable).filter(|event| visible(event)) {
            let bytes = serde_json::to_vec(event)?.len() + 1;
            if (size + bytes > MAX_OBSERVER_BATCH_BYTES || batch.len() == MAX_EVENTS)
                && !batch.is_empty()
            {
                append(
                    &mut batches,
                    &mut sequence,
                    std::mem::take(&mut batch),
                    false,
                )?;
                size = 1024;
            }
            if bytes + 1024 > MAX_OBSERVER_BATCH_BYTES {
                // An oversize fact is never truncated. Invalidate transient
                // displays so the client must fetch the complete durable API.
                append(&mut batches, &mut sequence, Vec::new(), true)?;
                continue;
            }
            size += bytes;
            batch.push(event.clone());
        }
        if !batch.is_empty() {
            append(&mut batches, &mut sequence, batch, false)?;
        }
        if batches.is_empty() && next_through != self.through {
            // Non-Session facts still advance the authoritative Event frontier.
            append(&mut batches, &mut sequence, Vec::new(), false)?;
        }
        // Install a complete cycle under the SAME lock used by park. Preparing
        // batches is local-only; a park racing with preparation wins before any
        // staged content, sequence or certified frontier can change.
        let mut state = self
            .progress
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.paused || state.closed {
            return Ok(false);
        }
        self.pending = batches;
        self.staged_through = next_through;
        state.pending = !self.pending.is_empty();
        Ok(true)
    }
    pub fn begin_publication(&mut self) -> Option<ObserverPublication<'_>> {
        if !self.is_pending() {
            return None;
        }
        let permit = self.progress.publishing()?;
        Some(ObserverPublication {
            queue: self,
            _permit: permit,
        })
    }
}
impl ObserverPublication<'_> {
    pub fn batch(&self) -> &ObserverBatch {
        self.queue
            .pending
            .front()
            .expect("publication owns a staged batch")
    }
    pub fn acknowledge(self, receipt: ObserverReceipt) -> Result<(), StoreError> {
        if receipt.epoch != self.queue.epoch || receipt.sequence != self.batch().sequence {
            return Err("observer acknowledgement does not match the staged batch".into());
        }
        self.queue.sequence = receipt.sequence;
        self.queue.pending.pop_front();
        if self.queue.pending.is_empty() {
            self.queue.through = self.queue.staged_through;
            self.queue.progress.advance(self.queue.through);
            self.queue.progress.pending(false);
        }
        Ok(())
    }
}
fn visible(event: &Event) -> bool {
    event.topic != "runtime/model_request_snapshot"
        && event
            .payload
            .get("session_id")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty() && id.len() <= 256)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn queue(epoch: u64, through: u64) -> ObserverQueue {
        ObserverQueue::new(
            Fence {
                owner_id: "synthetic-owner".into(),
                epoch,
            },
            through,
        )
        .unwrap()
    }
    fn event(sequence: Option<u64>, text: &str) -> Event {
        let mut event = Event::new(
            format!("e{}", sequence.unwrap_or(0)),
            "test".into(),
            if sequence.is_some() {
                "assistant"
            } else {
                "runtime_ephemeral"
            }
            .into(),
            "chat/reply".into(),
            serde_json::json!({"session_id":"s", "text":text})
                .as_object()
                .unwrap()
                .clone(),
        );
        event.sequence = sequence;
        event
    }
    fn ack(queue: &mut ObserverQueue) {
        let epoch = queue.epoch;
        let attempt = queue.begin_publication().unwrap();
        let sequence = attempt.batch().sequence;
        attempt
            .acknowledge(ObserverReceipt { epoch, sequence })
            .unwrap();
    }
    #[test]
    fn failed_ack_preserves_exact_batch_and_frontier_across_arbitrary_retries() {
        let mut queue = queue(3, 0);
        ack(&mut queue);
        queue
            .try_stage(
                &[event(Some(1), "complete")],
                &[event(None, "draft")],
                false,
            )
            .unwrap();
        let progress = queue.progress();
        let bytes = serde_json::to_vec(queue.begin_publication().unwrap().batch()).unwrap();
        assert_eq!(queue.through(), 0);
        assert!(queue
            .try_stage(&[event(Some(2), "new")], &[], false)
            .is_err());
        for receipt in [
            ObserverReceipt {
                epoch: 2,
                sequence: 2,
            },
            ObserverReceipt {
                epoch: 3,
                sequence: 99,
            },
        ] {
            let attempt = queue.begin_publication().unwrap();
            assert!(progress.pause().is_none());
            assert_eq!(serde_json::to_vec(attempt.batch()).unwrap(), bytes);
            assert!(attempt.acknowledge(receipt).is_err());
        }
        assert!(progress.pause().is_none());
        ack(&mut queue);
        assert_eq!(queue.through(), 1);
        assert!(!queue.is_pending());
        let pause = progress.pause().unwrap();
        assert!(!queue
            .try_stage(&[event(Some(2), "after pause")], &[], false)
            .unwrap());
        assert!(!queue.is_pending());
        assert!(queue.begin_publication().is_none());
        drop(pause);
        assert!(queue
            .try_stage(&[event(Some(2), "after pause")], &[], false)
            .unwrap());
        ack(&mut queue);
        assert_eq!(queue.through(), 2);
    }
    #[test]
    fn batch_splitting_certifies_only_after_last_ack_and_never_truncates_large_facts() {
        let mut queue = queue(1, 0);
        ack(&mut queue);
        queue
            .try_stage(
                &[
                    event(Some(1), &"a".repeat(80_000)),
                    event(Some(2), &"b".repeat(80_000)),
                ],
                &[],
                false,
            )
            .unwrap();
        ack(&mut queue);
        assert_eq!(queue.through(), 0);
        assert!(queue.is_pending());
        ack(&mut queue);
        assert_eq!(queue.through(), 2);
        queue
            .try_stage(
                &[event(Some(3), &"c".repeat(MAX_OBSERVER_BATCH_BYTES))],
                &[],
                false,
            )
            .unwrap();
        assert!(queue.begin_publication().unwrap().batch().reset);
        ack(&mut queue);
        assert_eq!(queue.through(), 3);
    }
    #[tokio::test]
    async fn park_requires_exact_native_append_frontier_not_an_empty_queue() {
        let replica = super::super::replica::Replica::create().await.unwrap();
        let mut queue = queue(1, 0);
        ack(&mut queue);
        let progress = queue.progress();
        assert!(progress
            .pause()
            .unwrap()
            .caught_up(&replica.store)
            .await
            .unwrap());
        let mut late = event(None, "late commit");
        late.payload.remove("session_id");
        replica.store.append(late).await.unwrap();
        assert!(!queue.is_pending());
        assert!(!progress
            .pause()
            .unwrap()
            .caught_up(&replica.store)
            .await
            .unwrap());
        let durable = replica
            .store
            .query(QueryFilter {
                after_sequence: Some(0),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(queue.try_stage(&durable, &[], false).unwrap());
        assert!(progress.pause().is_none());
        ack(&mut queue);
        assert!(progress
            .pause()
            .unwrap()
            .caught_up(&replica.store)
            .await
            .unwrap());
    }
    #[test]
    fn malformed_cycle_cannot_advance_frontier_or_leak_request_diagnostics() {
        let mut queue = queue(1, 0);
        ack(&mut queue);
        assert!(queue
            .try_stage(&[event(Some(2), "b"), event(Some(1), "a")], &[], false)
            .is_err());
        assert!(queue
            .try_stage(&[], &[event(Some(1), "not a draft")], false)
            .is_err());
        assert!(!queue.is_pending());
        let mut diagnostic = event(Some(1), "sensitive diagnostic");
        diagnostic.topic = "runtime/model_request_snapshot".into();
        assert!(queue.try_stage(&[diagnostic], &[], false).unwrap());
        assert!(queue.begin_publication().unwrap().batch().events.is_empty());
        ack(&mut queue);
        assert_eq!(queue.through(), 1);
    }

    #[test]
    fn counters_and_capacity_reject_atomically_without_consuming_sequence() {
        let fence = Fence {
            owner_id: "synthetic-owner".into(),
            epoch: 1,
        };
        assert!(ObserverQueue::new(fence.clone(), MAX_SAFE_COUNTER + 1).is_err());
        for epoch in [0, MAX_SAFE_COUNTER + 1] {
            assert!(ObserverQueue::new(
                Fence {
                    epoch,
                    ..fence.clone()
                },
                0
            )
            .is_err());
        }
        let mut queue = queue(1, 0);
        ack(&mut queue);
        assert!(queue
            .try_stage(&[event(Some(MAX_SAFE_COUNTER + 1), "invalid")], &[], false)
            .is_err());
        let drafts = vec![event(None, "draft"); MAX_EVENTS + 1];
        assert!(queue.try_stage(&[], &drafts, false).is_err());
        assert_eq!(queue.through(), 0);
        assert!(!queue.is_pending());
        assert_eq!(queue.sequence, 1);
        queue.sequence = MAX_SAFE_COUNTER;
        assert!(queue
            .try_stage(&[event(Some(1), "complete")], &[], false)
            .is_err());
        assert_eq!(queue.through(), 0);
        assert!(!queue.is_pending());
        assert_eq!(queue.sequence, MAX_SAFE_COUNTER);
    }
}
