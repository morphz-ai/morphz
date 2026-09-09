//! Deterministic, socket-free integration of the real RemoteRuntimeStore, its
//! SQLite replica/journal and park lifecycle. The fake authority only implements
//! fenced storage/receipts; it cannot skip any native quiescence or queue check.
use super::{host_observers::*, protocol::*, *};
use std::{
    collections::BTreeMap,
    future::{poll_fn, Future},
    sync::atomic::{AtomicU8, AtomicUsize},
    task::Poll,
    time::Duration,
};
use tokio::sync::Notify;

struct AuthorityState {
    owner: Option<Fence>,
    epoch: u64,
    recovered: bool,
    head: Head,
    records: BTreeMap<(String, String), Change>,
}
struct Authority {
    state: Mutex<AuthorityState>,
    park_mode: AtomicU8,
    park_calls: AtomicUsize,
    park_entered: Notify,
    park_release: Notify,
    head_calls: AtomicUsize,
    commit_calls: AtomicUsize,
    commit_mode: AtomicU8,
    commit_entered: Notify,
    commit_release: Notify,
}
impl Authority {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(AuthorityState {
                owner: None,
                epoch: 0,
                recovered: false,
                head: Head {
                    protocol: PROTOCOL.into(),
                    schema: None,
                    revision: 0,
                    sequence: 0,
                },
                records: BTreeMap::new(),
            }),
            park_mode: AtomicU8::new(0),
            park_calls: AtomicUsize::new(0),
            park_entered: Notify::new(),
            park_release: Notify::new(),
            head_calls: AtomicUsize::new(0),
            commit_calls: AtomicUsize::new(0),
            commit_mode: AtomicU8::new(0),
            commit_entered: Notify::new(),
            commit_release: Notify::new(),
        })
    }
    async fn owned(
        &self,
        fence: &Fence,
    ) -> Result<tokio::sync::MutexGuard<'_, AuthorityState>, StoreError> {
        let state = self.state.lock().await;
        if state.owner.as_ref() != Some(fence) {
            return Err("test authority: fenced".into());
        }
        Ok(state)
    }
}
#[async_trait::async_trait]
impl RemoteStoreTransport for Authority {
    async fn head(&self, fence: &Fence) -> Result<Head, StoreError> {
        self.head_calls.fetch_add(1, Ordering::SeqCst);
        Ok(self.owned(fence).await?.head.clone())
    }
    async fn page(
        &self,
        fence: &Fence,
        revision: u64,
        after: Option<&str>,
    ) -> Result<Page, StoreError> {
        let state = self.owned(fence).await?;
        assert_eq!(state.head.revision, revision);
        assert!(after.is_none());
        Ok(Page {
            head: state.head.clone(),
            records: state.records.values().cloned().collect(),
            next: None,
        })
    }
    async fn commit(&self, fence: &Fence, request: &Commit) -> Result<Head, StoreError> {
        self.commit_calls.fetch_add(1, Ordering::SeqCst);
        let mode = self.commit_mode.swap(0, Ordering::SeqCst);
        if mode == 1 {
            self.commit_entered.notify_one();
            self.commit_release.notified().await;
        }
        let mut state = self.owned(fence).await?;
        if state.head.revision != request.base_revision
            || state.head.sequence + 1 != request.sequence
        {
            return Err("test authority: snapshot conflict".into());
        }
        for change in &request.changes {
            let key = (change.table.clone(), change.key.clone());
            if change.values.is_some() {
                state.records.insert(key, change.clone());
            } else {
                state.records.remove(&key);
            }
        }
        state.head.schema = Some(request.schema.clone());
        state.head.revision += 1;
        state.head.sequence = request.sequence;
        let head = state.head.clone();
        drop(state);
        if mode == 2 {
            self.commit_entered.notify_one();
            self.commit_release.notified().await;
        }
        if mode == 3 {
            return Err("test authority: commit receipt lost".into());
        }
        Ok(head)
    }
}
#[async_trait::async_trait]
impl RemoteStoreLeaseTransport for Authority {
    async fn claim(&self, owner_id: &str) -> Result<Lease, StoreError> {
        let mut state = self.state.lock().await;
        assert!(state.owner.is_none());
        state.epoch += 1;
        let lease = Lease {
            owner_id: owner_id.into(),
            epoch: state.epoch,
            ttl_ms: 30_000,
        };
        state.owner = Some(lease.fence());
        state.recovered = false;
        Ok(lease)
    }
    async fn renew(&self, fence: &Fence) -> Result<Lease, StoreError> {
        let _state = self.owned(fence).await?;
        Ok(Lease {
            owner_id: fence.owner_id.clone(),
            epoch: fence.epoch,
            ttl_ms: 30_000,
        })
    }
    async fn complete_recovery(&self, fence: &Fence) -> Result<(), StoreError> {
        self.owned(fence).await?.recovered = true;
        Ok(())
    }
    async fn park(
        &self,
        fence: &Fence,
        revision: u64,
        _wake: Option<i64>,
    ) -> Result<ParkReceipt, StoreError> {
        self.park_calls.fetch_add(1, Ordering::SeqCst);
        let mode = self.park_mode.load(Ordering::SeqCst);
        if mode == 3 {
            self.park_entered.notify_one();
            self.park_release.notified().await;
        }
        let mut state = self.owned(fence).await?;
        assert!(state.recovered);
        assert_eq!(state.head.revision, revision);
        if mode == 1 {
            return Ok(ParkReceipt { parked: false });
        }
        if mode == 2 {
            return Err("test authority: transport failed before park commit".into());
        }
        state.owner = None;
        drop(state);
        if mode == 4 {
            self.park_entered.notify_one();
            self.park_release.notified().await;
        }
        if mode == 5 {
            return Err("test authority: park committed but receipt lost".into());
        }
        Ok(ParkReceipt { parked: true })
    }
}

fn event(id: &str) -> Event {
    Event::new(
        id.into(),
        "test".into(),
        "test".into(),
        "test/observer".into(),
        serde_json::json!({"text":"synthetic"})
            .as_object()
            .unwrap()
            .clone(),
    )
}
fn draft() -> Event {
    let mut event = event("draft");
    event.event_type = "runtime_ephemeral".into();
    event
        .payload
        .insert("session_id".into(), "synthetic-session".into());
    event
}
fn ack(queue: &mut ObserverQueue, epoch: u64) {
    let publication = queue.begin_publication().unwrap();
    let sequence = publication.batch().sequence;
    publication
        .acknowledge(ObserverReceipt { epoch, sequence })
        .unwrap();
}
async fn setup() -> (Arc<Authority>, Arc<RemoteRuntimeStore>, ObserverQueue) {
    let authority = Authority::new();
    let store = Arc::new(
        RemoteRuntimeStore::connect_owned(authority.clone())
            .await
            .unwrap(),
    );
    store.complete_recovery().await.unwrap();
    let queue = ObserverQueue::new(store.compute_fence(), 0).unwrap();
    store.install_observer_progress(queue.progress()).unwrap();
    (authority, store, queue)
}
async fn catch_up(store: &RemoteRuntimeStore, queue: &mut ObserverQueue) {
    let events = store
        .query(QueryFilter {
            after_sequence: Some(queue.through()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(queue.try_stage(&events, &[], false).unwrap());
    while queue.is_pending() {
        ack(queue, store.compute_fence().epoch);
    }
}

#[tokio::test]
async fn native_park_requires_reset_ack_and_the_current_append_frontier() {
    let (authority, store, mut queue) = setup().await;
    let epoch = store.compute_fence().epoch;
    assert!(store.install_observer_progress(queue.progress()).is_err());
    assert!(!store.try_park(|| true).await.unwrap()); // Initial reset is unacknowledged.
    assert_eq!(authority.park_calls.load(Ordering::SeqCst), 0);
    ack(&mut queue, epoch);
    store.append(event("first")).await.unwrap();
    assert!(!store.try_park(|| true).await.unwrap()); // Empty queue is not caught up.
    catch_up(&store, &mut queue).await;
    let first_frontier = queue.through();
    let mut backdated = event("second");
    backdated.timestamp -= chrono::Duration::days(365);
    store.append(backdated).await.unwrap();
    assert!(!store.try_park(|| true).await.unwrap()); // Timestamp order cannot hide it.
    assert_eq!(authority.park_calls.load(Ordering::SeqCst), 0);
    catch_up(&store, &mut queue).await;
    assert!(queue.through() > first_frontier);

    authority.park_mode.store(1, Ordering::SeqCst);
    assert!(!store.try_park(|| true).await.unwrap()); // Explicit busy safely reopens.
    assert!(!store.ownership_lost());
    assert!(queue.try_stage(&[], &[draft()], false).unwrap());
    assert!(!store.try_park(|| true).await.unwrap()); // Ephemeral-only batch also pins.
    assert_eq!(authority.park_calls.load(Ordering::SeqCst), 1);
    ack(&mut queue, epoch);
    authority.park_mode.store(0, Ordering::SeqCst);
    assert!(store.try_park(|| true).await.unwrap());
    assert!(store.ownership_lost());
    assert!(!queue.try_stage(&[], &[draft()], false).unwrap());
    assert!(queue.begin_publication().is_none());
    assert!(store.query(QueryFilter::default()).await.is_err());
}

#[tokio::test]
async fn native_park_holds_replica_and_queue_through_the_authority_decision() {
    let (authority, store, mut queue) = setup().await;
    ack(&mut queue, store.compute_fence().epoch);
    authority.park_mode.store(3, Ordering::SeqCst);
    let parked_store = store.clone();
    let park = tokio::spawn(async move { parked_store.try_park(|| true).await });
    tokio::time::timeout(Duration::from_secs(5), authority.park_entered.notified())
        .await
        .unwrap();
    assert!(store.replica.try_lock().is_err());
    assert!(!queue.try_stage(&[], &[draft()], false).unwrap());
    assert!(!queue.is_pending());

    // Poll the actual write once: it MUST wait on the native replica mutex.
    let writer = store.append(event("must-not-write-after-park"));
    tokio::pin!(writer);
    assert!(poll_fn(|cx| Poll::Ready(writer.as_mut().poll(cx).is_pending())).await);
    authority.park_release.notify_one();
    assert!(park.await.unwrap().unwrap());
    assert!(writer.await.is_err());
    let replacement = RemoteRuntimeStore::connect_owned(authority).await.unwrap();
    assert!(replacement
        .query(QueryFilter::default())
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn cancellation_during_park_never_reopens_the_old_owner_or_publisher() {
    for mode in [3, 4] {
        // Cancellation before AND after the remote park commit.
        let (authority, store, mut queue) = setup().await;
        ack(&mut queue, store.compute_fence().epoch);
        authority.park_mode.store(mode, Ordering::SeqCst);
        let parked_store = store.clone();
        let park = tokio::spawn(async move { parked_store.try_park(|| true).await });
        tokio::time::timeout(Duration::from_secs(5), authority.park_entered.notified())
            .await
            .unwrap();
        park.abort();
        assert!(park.await.unwrap_err().is_cancelled());
        assert!(store.ownership_lost());
        assert!(!queue.try_stage(&[], &[draft()], false).unwrap());
        assert!(queue.progress().pause().is_none());
        assert!(store.append(event("after-cancellation")).await.is_err());
    }
}

#[tokio::test]
async fn ambiguous_park_receipts_fence_compute_without_changing_durable_facts() {
    for mode in [2, 5] {
        // Neither failure proves that this owner may continue.
        let (authority, store, mut queue) = setup().await;
        ack(&mut queue, store.compute_fence().epoch);
        store.append(event("preserved")).await.unwrap();
        catch_up(&store, &mut queue).await;
        authority.park_mode.store(mode, Ordering::SeqCst);
        assert!(store.try_park(|| true).await.is_err());
        assert!(store.ownership_lost());
        assert!(!queue.try_stage(&[], &[draft()], false).unwrap());
        // Simulate authority-side lease expiration if commit did not happen.
        authority.state.lock().await.owner = None;
        let replacement = RemoteRuntimeStore::connect_owned(authority).await.unwrap();
        let events = replacement.query(QueryFilter::default()).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "preserved");
    }
}

#[tokio::test]
async fn invalid_frontier_is_not_parked_and_does_not_fence_a_valid_owner() {
    let authority = Authority::new();
    let store = RemoteRuntimeStore::connect_owned(authority.clone())
        .await
        .unwrap();
    store.complete_recovery().await.unwrap();
    let mut queue = ObserverQueue::new(store.compute_fence(), 1).unwrap();
    ack(&mut queue, store.compute_fence().epoch);
    store.install_observer_progress(queue.progress()).unwrap();
    assert!(store
        .try_park(|| true)
        .await
        .unwrap_err()
        .to_string()
        .contains("ahead"));
    assert_eq!(authority.park_calls.load(Ordering::SeqCst), 0);
    assert!(!store.ownership_lost());
    assert!(queue.progress().pause().is_some());
    assert!(store
        .query(QueryFilter::default())
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn process_activity_rechecked_after_observer_frontier_read_defers_park() {
    let (authority, store, mut queue) = setup().await;
    ack(&mut queue, store.compute_fence().epoch);
    let checks = AtomicUsize::new(0);
    assert!(!store
        .try_park(|| checks.fetch_add(1, Ordering::SeqCst) < 2)
        .await
        .unwrap());
    assert_eq!(checks.load(Ordering::SeqCst), 3);
    assert_eq!(authority.park_calls.load(Ordering::SeqCst), 0);
    assert!(!store.ownership_lost());
    assert!(queue.progress().pause().is_some());
    assert!(queue.try_stage(&[], &[draft()], false).unwrap());
}

#[tokio::test]
async fn barrier_cannot_certify_a_different_compute_owner_or_epoch() {
    let authority = Authority::new();
    let store = RemoteRuntimeStore::connect_owned(authority).await.unwrap();
    let fence = store.compute_fence();
    for wrong in [
        Fence {
            owner_id: "another-agent-owner".into(),
            epoch: fence.epoch,
        },
        Fence {
            owner_id: fence.owner_id.clone(),
            epoch: fence.epoch + 1,
        },
    ] {
        let queue = ObserverQueue::new(wrong, 0).unwrap();
        assert!(store.install_observer_progress(queue.progress()).is_err());
    }
    let queue = ObserverQueue::new(fence, 0).unwrap();
    store.install_observer_progress(queue.progress()).unwrap();
}

// These execute the actual SQLite operation and journal. Only transport
// receipts are injected; no result/lease is synthesized by a model or UI.
#[tokio::test]
async fn remote_execution_uses_one_authority_roundtrip_per_cached_operation() {
    let (authority, store, _queue) = setup().await;
    authority.head_calls.store(0, Ordering::SeqCst);
    authority.commit_calls.store(0, Ordering::SeqCst);
    store.append(event("committed")).await.unwrap();
    assert_eq!(authority.commit_calls.load(Ordering::SeqCst), 1);
    assert_eq!(authority.head_calls.load(Ordering::SeqCst), 0);
    assert_eq!(store.query(QueryFilter::default()).await.unwrap().len(), 1);
    assert_eq!(authority.head_calls.load(Ordering::SeqCst), 1);
    assert_eq!(authority.commit_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn remote_execution_does_not_deliver_locally_computed_results_after_revocation() {
    for write in [false, true] {
        let (authority, store, _queue) = setup().await;
        store.append(event("existing")).await.unwrap();
        let revoked = authority.clone();
        let result = store
            .execute(|local| async move {
                let result = local.query(QueryFilter::default()).await.unwrap();
                if write {
                    local.append(event("must-not-escape")).await.unwrap();
                }
                revoked.state.lock().await.owner = None;
                result
            })
            .await;
        assert!(result.unwrap_err().to_string().contains("fenced"));
        assert!(store.replica.lock().await.is_none());
        let replacement = RemoteRuntimeStore::connect_owned(authority).await.unwrap();
        let events = replacement.query(QueryFilter::default()).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "existing");
    }
}

#[tokio::test]
async fn remote_execution_validates_the_exact_read_snapshot_and_write_base() {
    for write in [false, true] {
        let (authority, store, _queue) = setup().await;
        let other = RemoteRuntimeStore::connect(authority.clone(), store.compute_fence())
            .await
            .unwrap();
        let result = store
            .execute(|local| async move {
                let result = local.query(QueryFilter::default()).await.unwrap();
                if write {
                    local.append(event("rejected-local-write")).await.unwrap();
                }
                other
                    .append(event("concurrent-authority-write"))
                    .await
                    .unwrap();
                result
            })
            .await;
        assert!(result.is_err());
        assert!(store.replica.lock().await.is_none());
        let events = store.query(QueryFilter::default()).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "concurrent-authority-write");
    }
}

#[tokio::test]
async fn remote_execution_cancellation_and_lost_receipts_never_promote_speculation() {
    for mode in [1, 2, 3] {
        let (authority, store, _queue) = setup().await;
        authority.commit_mode.store(mode, Ordering::SeqCst);
        let writer = store.clone();
        let task = tokio::spawn(async move { writer.append(event("uncertain")).await });
        if mode != 3 {
            tokio::time::timeout(Duration::from_secs(5), authority.commit_entered.notified())
                .await
                .unwrap();
            assert!(!task.is_finished());
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
        } else {
            assert!(task.await.unwrap().is_err());
        }
        assert!(store.replica.lock().await.is_none());
        let events = store.query(QueryFilter::default()).await.unwrap();
        assert_eq!(events.len(), usize::from(mode != 1));
        store.append(event("next")).await.unwrap();
        assert_eq!(
            store.query(QueryFilter::default()).await.unwrap().len(),
            usize::from(mode != 1) + 1
        );
    }
}

#[tokio::test]
async fn remote_execution_commits_bookkeeping_before_returning_a_domain_error() {
    let (authority, store, _queue) = setup().await;
    authority.commit_calls.store(0, Ordering::SeqCst);
    let result: Result<Result<(), StoreError>, StoreError> = store
        .execute(|local| async move {
            local.append(event("domain-error-bookkeeping")).await?;
            Err("expected domain error".into())
        })
        .await;
    assert_eq!(
        result.unwrap().unwrap_err().to_string(),
        "expected domain error"
    );
    assert_eq!(authority.commit_calls.load(Ordering::SeqCst), 1);
    assert_eq!(store.query(QueryFilter::default()).await.unwrap().len(), 1);
}

#[tokio::test]
async fn remote_execution_never_delivers_a_read_under_a_changed_schema() {
    let (authority, store, _queue) = setup().await;
    let result = store
        .execute(|local| async move {
            let result = local.query(QueryFilter::default()).await.unwrap();
            authority.state.lock().await.head.schema = Some("incompatible-schema".into());
            result
        })
        .await;
    assert!(result.unwrap_err().to_string().contains("schema mismatch"));
    assert!(store.replica.lock().await.is_none());
}
