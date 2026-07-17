//! Async, single-node admission controller for durable Thread Activations.
//!
//! [`crate::admission`] owns deterministic ordering and capacity policy.  This
//! module adds the small amount of process-local coordination needed to wait
//! for a slot while the authoritative Activation remains `queued` in the
//! SessionStore.  A granted permit is intentionally held for the complete
//! Activation, not merely for one model request.

use crate::admission::{
    reserved_lane_decision, AdmissionClass, AdmissionEntry, AdmissionKey, AdmissionQueueError,
    AgingPolicy, CapacityDecision, FairAdmissionQueue, InFlightUsage, ReservedLaneCapacity,
};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};
use tokio::sync::Notify;

/// Process-local settings derived from the public Runtime configuration.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ActivationAdmissionLimits {
    pub total_slots: usize,
    pub dialogue_delivery_slots: usize,
    pub max_queued: usize,
    pub dialogue_delivery_queue_slots: usize,
    pub aging_promotion_interval_ms: u64,
}

impl ActivationAdmissionLimits {
    fn normalized(self) -> Self {
        let total_slots = self.total_slots.max(1);
        let max_queued = self.max_queued.max(1);
        Self {
            total_slots,
            // A one-slot Runtime cannot both reserve a slot and execute
            // general work.  Keep at least one physical general slot; fixed
            // class ordering still lets dialogue win whenever that slot is
            // free.
            dialogue_delivery_slots: self
                .dialogue_delivery_slots
                .min(total_slots.saturating_sub(1)),
            max_queued,
            // Like the execution reservation, the queue reservation must not
            // make general work impossible to admit. A one-row window can
            // still serve either lane according to fixed class ordering.
            dialogue_delivery_queue_slots: self
                .dialogue_delivery_queue_slots
                .min(max_queued.saturating_sub(1)),
            aging_promotion_interval_ms: self.aging_promotion_interval_ms.max(1),
        }
    }

    fn general_queue_limit(self) -> usize {
        self.max_queued
            .saturating_sub(self.dialogue_delivery_queue_slots)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ActivationAdmissionError {
    Queue(AdmissionQueueError),
    /// The same durable Activation is already represented by another local
    /// waiter or permit.  The caller must not start a sibling execution.
    AlreadyLocal(String),
    /// The bounded in-memory scheduling window is full.  This is a delay, not
    /// a rejection: the authoritative Activation remains durably `queued` and
    /// must be reconsidered by the Runtime after the window changes.
    WindowFull {
        id: String,
        class: AdmissionClass,
        queued: usize,
        limit: usize,
        reserved_for_dialogue_delivery: usize,
    },
}

impl fmt::Display for ActivationAdmissionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Queue(error) => error.fmt(f),
            Self::AlreadyLocal(id) => {
                write!(f, "Thread Activation '{id}' 已在本 Runtime 等待或执行")
            }
            Self::WindowFull {
                id,
                class,
                queued,
                limit,
                reserved_for_dialogue_delivery,
            } => write!(
                f,
                "Thread Activation '{id}' 延迟准入：内存调度窗口已满，class={class:?}, queued={queued}, limit={limit}, reserved_dialogue_delivery={reserved_for_dialogue_delivery}"
            ),
        }
    }
}

impl std::error::Error for ActivationAdmissionError {}

impl From<AdmissionQueueError> for ActivationAdmissionError {
    fn from(value: AdmissionQueueError) -> Self {
        Self::Queue(value)
    }
}

#[derive(Debug)]
struct ControllerState {
    queue: FairAdmissionQueue<()>,
    /// Only rows with a live local waiter are selectable.  Recovered durable
    /// rows may be rebuilt before their Event handlers are dispatched.
    waiters: HashSet<String>,
    in_flight: HashMap<String, AdmissionClass>,
}

#[derive(Debug)]
struct ControllerInner {
    limits: ActivationAdmissionLimits,
    state: Mutex<ControllerState>,
    /// Broadcast wake for Activation waiters. These waiters always re-check
    /// state while registering, so a broadcast notification is appropriate.
    changed: Notify,
    /// Stored single-consumer wake for the durable refill loop. Unlike
    /// `notify_waiters`, `notify_one` retains a permit when the loop has not
    /// reached its await yet, closing the startup/re-arm lost-wakeup window.
    refill_changed: Notify,
}

impl ControllerInner {
    fn notify_change(&self) {
        self.changed.notify_waiters();
        self.refill_changed.notify_one();
    }
}

/// Runtime-owned, cancellation-safe admission controller.
#[derive(Clone, Debug)]
pub struct ActivationAdmissionController {
    inner: Arc<ControllerInner>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RestoreQueuedOutcome {
    Restored,
    AlreadyTracked,
    DeferredWindowFull,
}

impl ActivationAdmissionController {
    pub fn new(limits: ActivationAdmissionLimits) -> Self {
        let limits = limits.normalized();
        Self {
            inner: Arc::new(ControllerInner {
                limits,
                state: Mutex::new(ControllerState {
                    queue: FairAdmissionQueue::new(AgingPolicy::every(
                        limits.aging_promotion_interval_ms,
                    )),
                    waiters: HashSet::new(),
                    in_flight: HashMap::new(),
                }),
                changed: Notify::new(),
                refill_changed: Notify::new(),
            }),
        }
    }

    pub fn limits(&self) -> ActivationAdmissionLimits {
        self.inner.limits
    }

    /// Place one already-durable `queued` row into the bounded in-memory
    /// scheduling window. Rows which do not fit remain in SQLite and are
    /// reconsidered by the Orchestrator refill loop.
    pub fn restore_queued(
        &self,
        key: AdmissionKey,
    ) -> Result<RestoreQueuedOutcome, ActivationAdmissionError> {
        let mut state = self.lock_state();
        if state.in_flight.contains_key(&key.id)
            || state.queue.iter().any(|entry| entry.key.id == key.id)
        {
            return Ok(RestoreQueuedOutcome::AlreadyTracked);
        }
        if self.check_queue_capacity(&state, &key).is_err() {
            return Ok(RestoreQueuedOutcome::DeferredWindowFull);
        }
        state.queue.push(AdmissionEntry::new(key, ()))?;
        drop(state);
        self.inner.notify_change();
        Ok(RestoreQueuedOutcome::Restored)
    }

    /// Remove a row which became terminal or was claimed by another execution
    /// before this controller granted it.
    pub fn forget(&self, id: &str) -> bool {
        let mut state = self.lock_state();
        state.waiters.remove(id);
        let removed = state.queue.remove(id).is_some();
        drop(state);
        if removed {
            self.inner.notify_change();
        }
        removed
    }

    pub fn queued_len(&self) -> usize {
        self.lock_state().queue.len()
    }

    pub fn in_flight_len(&self) -> usize {
        self.lock_state().in_flight.len()
    }

    /// Whether this process currently owns the physical execution permit for
    /// the durable Activation.  This is intentionally narrower than
    /// [`Self::contains`]: a queued row or waiter is locally known, but only an
    /// in-flight permit proves that re-dispatching an expired lease would race
    /// a still-running execution in this Runtime.
    pub fn is_in_flight(&self, id: &str) -> bool {
        self.lock_state().in_flight.contains_key(id)
    }

    pub fn contains(&self, id: &str) -> bool {
        let state = self.lock_state();
        state.in_flight.contains_key(id) || state.queue.iter().any(|entry| entry.key.id == id)
    }

    /// Notification used by the Runtime to refill the bounded window from the
    /// durable queue. It carries no state; SQLite remains authoritative.
    pub async fn wait_for_change(&self) {
        self.inner.refill_changed.notified().await;
    }

    /// Wait until this durable Activation is selected by class, aging,
    /// hierarchical fairness, and reserved capacity.
    pub async fn acquire(
        &self,
        key: AdmissionKey,
    ) -> Result<ActivationAdmissionPermit, ActivationAdmissionError> {
        let id = key.id.clone();
        {
            let mut state = self.lock_state();
            if state.in_flight.contains_key(&id) || state.waiters.contains(&id) {
                return Err(ActivationAdmissionError::AlreadyLocal(id));
            }
            if !state.queue.iter().any(|entry| entry.key.id == id) {
                self.check_queue_capacity(&state, &key)?;
                state.queue.push(AdmissionEntry::new(key, ()))?;
            }
            state.waiters.insert(id.clone());
        }
        let mut waiting = WaitingRegistration {
            inner: Arc::clone(&self.inner),
            id: id.clone(),
            armed: true,
        };
        self.inner.notify_change();

        loop {
            // `notified()` alone is lazy. Explicitly enable the pinned future
            // before checking state so a release between the check and await
            // cannot be lost.
            let changed = self.inner.changed.notified();
            tokio::pin!(changed);
            let _ = changed.as_mut().enable();
            let admitted = {
                let mut state = self.lock_state();
                let waiters = state.waiters.clone();
                let usage = in_flight_usage(&state.in_flight);
                let capacity = ReservedLaneCapacity {
                    total_slots: self.inner.limits.total_slots,
                    dialogue_delivery_slots: self.inner.limits.dialogue_delivery_slots,
                };
                let next_id = state
                    .queue
                    .peek_next_where(now_ms(), |candidate, _| {
                        waiters.contains(&candidate.id)
                            && reserved_lane_decision(candidate.class, capacity, usage)
                                == CapacityDecision::Admit
                    })
                    .map(|entry| entry.key.id.clone());
                if next_id.as_deref() == Some(id.as_str()) {
                    let entry = state
                        .queue
                        .pop_next_where(now_ms(), |candidate, _| {
                            waiters.contains(&candidate.id)
                                && reserved_lane_decision(candidate.class, capacity, usage)
                                    == CapacityDecision::Admit
                        })
                        .expect("peeked admission row must remain selectable under one lock");
                    state.waiters.remove(&id);
                    state.in_flight.insert(id.clone(), entry.key.class);
                    true
                } else {
                    false
                }
            };
            if admitted {
                waiting.armed = false;
                self.inner.notify_change();
                return Ok(ActivationAdmissionPermit {
                    inner: Arc::clone(&self.inner),
                    id,
                    released: false,
                });
            }
            changed.await;
        }
    }

    fn check_queue_capacity(
        &self,
        state: &ControllerState,
        key: &AdmissionKey,
    ) -> Result<(), ActivationAdmissionError> {
        let limits = self.inner.limits;
        let (queued, limit) = if key.class.uses_reserved_lane() {
            (state.queue.len(), limits.max_queued)
        } else {
            let general_queued = state
                .queue
                .iter()
                .filter(|entry| !entry.key.class.uses_reserved_lane())
                .count();
            if state.queue.len() >= limits.max_queued {
                (state.queue.len(), limits.max_queued)
            } else {
                (general_queued, limits.general_queue_limit())
            }
        };
        if queued >= limit {
            return Err(ActivationAdmissionError::WindowFull {
                id: key.id.clone(),
                class: key.class,
                queued,
                limit,
                reserved_for_dialogue_delivery: limits.dialogue_delivery_queue_slots,
            });
        }
        Ok(())
    }

    fn lock_state(&self) -> MutexGuard<'_, ControllerState> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Holding this permit is the physical proof that an Activation may be
/// `running` in this process.
#[derive(Debug)]
pub struct ActivationAdmissionPermit {
    inner: Arc<ControllerInner>,
    id: String,
    released: bool,
}

impl ActivationAdmissionPermit {
    pub fn activation_id(&self) -> &str {
        &self.id
    }

    fn release(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.in_flight.remove(&self.id);
        drop(state);
        self.inner.notify_change();
    }
}

impl Drop for ActivationAdmissionPermit {
    fn drop(&mut self) {
        self.release();
    }
}

/// A cancelled event-handler future stops being selectable, while its durable
/// queued row remains available for restart recovery.
struct WaitingRegistration {
    inner: Arc<ControllerInner>,
    id: String,
    armed: bool,
}

impl Drop for WaitingRegistration {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.waiters.remove(&self.id);
        drop(state);
        self.inner.notify_change();
    }
}

fn in_flight_usage(in_flight: &HashMap<String, AdmissionClass>) -> InFlightUsage {
    InFlightUsage {
        total: in_flight.len(),
        dialogue_delivery: in_flight
            .values()
            .filter(|class| class.uses_reserved_lane())
            .count(),
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn limits(total_slots: usize) -> ActivationAdmissionLimits {
        ActivationAdmissionLimits {
            total_slots,
            dialogue_delivery_slots: 1,
            max_queued: 8,
            dialogue_delivery_queue_slots: 2,
            aging_promotion_interval_ms: 60_000,
        }
    }

    fn key(id: &str, session: &str, class: AdmissionClass, created_at_ms: i64) -> AdmissionKey {
        AdmissionKey::new(id, "agent", "context", session, class, created_at_ms)
    }

    async fn wait_until(predicate: impl Fn() -> bool) {
        tokio::time::timeout(Duration::from_secs(1), async {
            while !predicate() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("condition timed out");
    }

    #[tokio::test]
    async fn dialogue_uses_reserved_capacity_while_background_is_saturated() {
        let controller = ActivationAdmissionController::new(limits(2));
        let first = controller
            .acquire(key(
                "background-1",
                "s1",
                AdmissionClass::ScheduledBackground,
                1,
            ))
            .await
            .unwrap();
        assert_eq!(controller.in_flight_len(), 1);

        let background = {
            let controller = controller.clone();
            tokio::spawn(async move {
                controller
                    .acquire(key(
                        "background-2",
                        "s2",
                        AdmissionClass::ScheduledBackground,
                        2,
                    ))
                    .await
                    .unwrap()
            })
        };
        wait_until(|| controller.queued_len() == 1).await;
        assert!(!background.is_finished());

        let dialogue = controller
            .acquire(key("dialogue", "s3", AdmissionClass::InteractiveControl, 3))
            .await
            .unwrap();
        assert_eq!(controller.in_flight_len(), 2);
        assert!(!background.is_finished());

        drop(dialogue);
        assert!(!background.is_finished(), "reserved slot stays protected");
        drop(first);
        let admitted_background = tokio::time::timeout(Duration::from_secs(1), background)
            .await
            .unwrap()
            .unwrap();
        drop(admitted_background);
    }

    #[tokio::test]
    async fn sessions_rotate_within_one_class() {
        let controller = ActivationAdmissionController::new(limits(1));
        let blocker = controller
            .acquire(key("blocker", "s0", AdmissionClass::InteractiveControl, 0))
            .await
            .unwrap();
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut tasks = Vec::new();
        for (id, session, created) in [
            ("s1-a", "s1", 1),
            ("s1-b", "s1", 2),
            ("s2-a", "s2", 3),
            ("s2-b", "s2", 4),
        ] {
            let controller = controller.clone();
            let order = Arc::clone(&order);
            tasks.push(tokio::spawn(async move {
                let permit = controller
                    .acquire(key(id, session, AdmissionClass::Objective, created))
                    .await
                    .unwrap();
                order
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push(id);
                drop(permit);
            }));
        }
        wait_until(|| controller.queued_len() == 4).await;
        drop(blocker);
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(
            *order
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            ["s1-a", "s2-a", "s1-b", "s2-b"]
        );
    }

    #[tokio::test]
    async fn queue_limit_reserves_waiting_room_and_defers_without_dropping() {
        let controller = ActivationAdmissionController::new(ActivationAdmissionLimits {
            total_slots: 1,
            dialogue_delivery_slots: 1,
            max_queued: 3,
            dialogue_delivery_queue_slots: 1,
            aging_promotion_interval_ms: 60_000,
        });
        controller
            .restore_queued(key("general-1", "s1", AdmissionClass::Objective, 1))
            .unwrap();
        controller
            .restore_queued(key("general-2", "s2", AdmissionClass::Objective, 2))
            .unwrap();

        let deferred = controller
            .acquire(key(
                "general-3",
                "s3",
                AdmissionClass::ScheduledBackground,
                3,
            ))
            .await
            .unwrap_err();
        assert!(matches!(
            deferred,
            ActivationAdmissionError::WindowFull { limit: 2, .. }
        ));

        controller
            .restore_queued(key("dialogue", "s4", AdmissionClass::InteractiveControl, 4))
            .unwrap();
        let deferred = controller
            .acquire(key("delivery-overflow", "s5", AdmissionClass::Delivery, 5))
            .await
            .unwrap_err();
        assert!(matches!(
            deferred,
            ActivationAdmissionError::WindowFull { limit: 3, .. }
        ));
    }

    #[test]
    fn reserved_rows_do_not_reduce_the_general_queue_budget_twice() {
        let controller = ActivationAdmissionController::new(ActivationAdmissionLimits {
            total_slots: 4,
            dialogue_delivery_slots: 1,
            max_queued: 8,
            dialogue_delivery_queue_slots: 2,
            aging_promotion_interval_ms: 60_000,
        });
        for (id, class) in [
            ("dialogue", AdmissionClass::InteractiveControl),
            ("delivery", AdmissionClass::Delivery),
        ] {
            assert_eq!(
                controller.restore_queued(key(id, id, class, 0)).unwrap(),
                RestoreQueuedOutcome::Restored
            );
        }
        for index in 0..6 {
            assert_eq!(
                controller
                    .restore_queued(key(
                        &format!("general-{index}"),
                        &format!("s-{index}"),
                        AdmissionClass::Objective,
                        index + 1,
                    ))
                    .unwrap(),
                RestoreQueuedOutcome::Restored
            );
        }
        assert_eq!(controller.queued_len(), 8);
    }

    #[test]
    fn one_row_window_cannot_reserve_away_all_general_work() {
        let controller = ActivationAdmissionController::new(ActivationAdmissionLimits {
            total_slots: 1,
            dialogue_delivery_slots: 1,
            max_queued: 1,
            dialogue_delivery_queue_slots: 1,
            aging_promotion_interval_ms: 60_000,
        });
        assert_eq!(controller.limits().dialogue_delivery_queue_slots, 0);
        assert_eq!(
            controller
                .restore_queued(key(
                    "background",
                    "s1",
                    AdmissionClass::ScheduledBackground,
                    1,
                ))
                .unwrap(),
            RestoreQueuedOutcome::Restored
        );
    }

    #[tokio::test]
    async fn durable_refill_notification_is_not_lost_before_waiter_starts() {
        let controller = ActivationAdmissionController::new(limits(1));
        controller
            .restore_queued(key(
                "queued-before-refill-loop",
                "s1",
                AdmissionClass::Objective,
                1,
            ))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), controller.wait_for_change())
            .await
            .expect("refill notification must retain one permit");
    }

    #[tokio::test]
    async fn rebuilt_queue_uses_persisted_age_and_not_restore_order() {
        let controller = ActivationAdmissionController::new(limits(1));
        let blocker = controller
            .acquire(key("blocker", "s0", AdmissionClass::InteractiveControl, 0))
            .await
            .unwrap();
        for row in [
            key("new", "s", AdmissionClass::Objective, 20),
            key("old", "s", AdmissionClass::Objective, 10),
        ] {
            controller.restore_queued(row).unwrap();
        }

        let new_waiter = {
            let controller = controller.clone();
            tokio::spawn(async move {
                controller
                    .acquire(key("new", "s", AdmissionClass::Objective, 20))
                    .await
                    .unwrap()
            })
        };
        let old_waiter = {
            let controller = controller.clone();
            tokio::spawn(async move {
                controller
                    .acquire(key("old", "s", AdmissionClass::Objective, 10))
                    .await
                    .unwrap()
            })
        };
        // Restored rows exist before their Event handlers register. Wait for
        // both handlers here so the assertion measures queue ordering rather
        // than Tokio task-start order.
        wait_until(|| controller.lock_state().waiters.len() == 2).await;
        drop(blocker);
        let old = tokio::time::timeout(Duration::from_secs(1), old_waiter)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(old.activation_id(), "old");
        assert!(!new_waiter.is_finished());
        drop(old);
        let new = tokio::time::timeout(Duration::from_secs(1), new_waiter)
            .await
            .unwrap()
            .unwrap();
        drop(new);
    }
}
