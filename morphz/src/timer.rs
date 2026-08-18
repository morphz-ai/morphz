use crate::memory::{NewRuntimeTimer, RuntimeTimerKind, RuntimeTimerRecord, TimerStore};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

type DynError = Box<dyn std::error::Error + Send + Sync>;
type TimerFuture = Pin<Box<dyn Future<Output = Result<TimerDisposition, DynError>> + Send>>;
type TimerHandler = Arc<dyn Fn(RuntimeTimerRecord) -> TimerFuture + Send + Sync>;

const TIMER_CLAIM_BATCH: usize = 64;
const TIMER_CLAIM_LEASE_SECS: i64 = 30;
const TIMER_ERROR_RETRY_SECS: i64 = 1;
const TIMER_MAX_IDLE_SECS: u64 = 30;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TimerDisposition {
    Complete,
    Reschedule {
        due_at: DateTime<Utc>,
        reason: Option<String>,
    },
}

/// One persistent physical clock queue for all Runtime scheduling policies.
/// It does not decide what a timer means: owner-specific handlers validate the
/// generation and commit the semantic state transition. The engine only owns
/// due ordering, leased claim, retry, cancellation, and restart recovery.
pub struct TimerEngine {
    store: Arc<dyn TimerStore>,
    handlers: RwLock<HashMap<RuntimeTimerKind, TimerHandler>>,
    wakeup: Arc<tokio::sync::Notify>,
    started: AtomicBool,
    claimant_id: String,
    claim_sequence: AtomicU64,
}

impl TimerEngine {
    pub fn new(store: Arc<dyn TimerStore>) -> Self {
        Self {
            store,
            handlers: RwLock::new(HashMap::new()),
            wakeup: Arc::new(tokio::sync::Notify::new()),
            started: AtomicBool::new(false),
            claimant_id: new_timer_claimant_id(),
            claim_sequence: AtomicU64::new(0),
        }
    }

    pub fn register_handler<F, Fut>(
        &self,
        kind: RuntimeTimerKind,
        handler: F,
    ) -> Result<(), DynError>
    where
        F: Fn(RuntimeTimerRecord) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<TimerDisposition, DynError>> + Send + 'static,
    {
        let mut handlers = self
            .handlers
            .write()
            .map_err(|_| "Runtime Timer handler registry poisoned")?;
        if handlers.contains_key(&kind) {
            return Err(format!("Runtime Timer kind '{}' 已注册 handler", kind.as_str()).into());
        }
        handlers.insert(kind, Arc::new(move |timer| Box::pin(handler(timer))));
        Ok(())
    }

    pub async fn schedule(&self, timer: NewRuntimeTimer) -> Result<RuntimeTimerRecord, DynError> {
        let timer = self.store.upsert_runtime_timer(timer).await?;
        self.wakeup.notify_one();
        Ok(timer)
    }

    pub async fn cancel(&self, id: &str) -> Result<bool, DynError> {
        let cancelled = self.store.cancel_runtime_timer(id).await?;
        if cancelled {
            self.wakeup.notify_one();
        }
        Ok(cancelled)
    }

    /// Bounded recovery view of physically live timers. Historical fired and
    /// cancelled rows are deliberately excluded so semantic schedulers can
    /// reconcile their owners without scanning all Timer records at startup.
    pub async fn list_live(&self) -> Result<Vec<RuntimeTimerRecord>, DynError> {
        let mut timers = self
            .store
            .list_runtime_timers(Some(crate::memory::RuntimeTimerStatus::Pending))
            .await?;
        timers.extend(
            self.store
                .list_runtime_timers(Some(crate::memory::RuntimeTimerStatus::Claimed))
                .await?,
        );
        Ok(timers)
    }

    pub fn start(self: &Arc<Self>) -> bool {
        if self.started.swap(true, Ordering::AcqRel) {
            return false;
        }
        let engine = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                let Some(current) = engine.upgrade() else {
                    break;
                };
                if let Err(error) = current.dispatch_due_once().await {
                    tracing::error!(event_code = "timer.dispatcher.failed", %error, "Runtime Timer dispatcher failed; retaining the durable Timer for retry");
                }
                let delay = current.next_sleep_duration().await;
                let wakeup = Arc::clone(&current.wakeup);
                drop(current);
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    _ = wakeup.notified() => {}
                }
            }
        });
        true
    }

    pub async fn dispatch_due_once(&self) -> Result<usize, DynError> {
        let now = Utc::now();
        let sequence = self.claim_sequence.fetch_add(1, Ordering::Relaxed);
        let claim_token = format!(
            "timer-claim-{}-{}-{}",
            self.claimant_id,
            now.timestamp_nanos_opt().unwrap_or_default(),
            sequence
        );
        let claimed = self
            .store
            .claim_due_runtime_timers(
                now,
                &claim_token,
                now + ChronoDuration::seconds(TIMER_CLAIM_LEASE_SECS),
                TIMER_CLAIM_BATCH,
            )
            .await?;
        let claimed_count = claimed.len();
        for timer in claimed {
            let handler = self
                .handlers
                .read()
                .map_err(|_| "Runtime Timer handler registry poisoned")?
                .get(&timer.kind)
                .cloned();
            let disposition = match handler {
                Some(handler) => handler(timer.clone()).await,
                None => Err(format!(
                    "Runtime Timer kind '{}' 尚未注册 handler",
                    timer.kind.as_str()
                )
                .into()),
            };
            match disposition {
                Ok(TimerDisposition::Complete) => {
                    // A handler may atomically advance the owner and schedule a newer generation
                    // under the same timer ID. In that case this conditional completion is
                    // deliberately a no-op and the new pending generation remains authoritative.
                    self.store
                        .complete_runtime_timer(&timer.id, timer.generation, &claim_token)
                        .await?;
                }
                Ok(TimerDisposition::Reschedule { due_at, reason }) => {
                    self.store
                        .retry_runtime_timer(
                            &timer.id,
                            timer.generation,
                            &claim_token,
                            due_at,
                            reason.as_deref(),
                        )
                        .await?;
                    self.wakeup.notify_one();
                }
                Err(error) => {
                    let message = error.to_string();
                    tracing::error!(event_code = "timer.handler.failed", timer_id = %timer.id, timer_kind = timer.kind.as_str(), %error, "Runtime Timer handler failed");
                    self.store
                        .retry_runtime_timer(
                            &timer.id,
                            timer.generation,
                            &claim_token,
                            Utc::now() + ChronoDuration::seconds(TIMER_ERROR_RETRY_SECS),
                            Some(&message),
                        )
                        .await?;
                    self.wakeup.notify_one();
                }
            }
        }
        Ok(claimed_count)
    }

    async fn next_sleep_duration(&self) -> std::time::Duration {
        let Ok(next_due_at) = self.store.next_runtime_timer_due_at().await else {
            return std::time::Duration::from_secs(TIMER_ERROR_RETRY_SECS as u64);
        };
        next_due_at
            .map(|due_at| {
                (due_at - Utc::now())
                    .to_std()
                    .unwrap_or(std::time::Duration::ZERO)
            })
            .unwrap_or_else(|| std::time::Duration::from_secs(TIMER_MAX_IDLE_SECS))
            .min(std::time::Duration::from_secs(TIMER_MAX_IDLE_SECS))
    }
}

fn new_timer_claimant_id() -> String {
    static NEXT_INSTANCE: AtomicU64 = AtomicU64::new(0);
    let instance = NEXT_INSTANCE.fetch_add(1, Ordering::Relaxed);
    let mut random = [0_u8; 16];
    let nonce = if getrandom::fill(&mut random).is_ok() {
        random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    } else {
        chrono::Utc::now()
            .timestamp_nanos_opt()
            .unwrap_or_default()
            .to_string()
    };
    format!("{}-{nonce}-{instance}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::sqlite::SqliteStore;
    use crate::memory::RuntimeTimerStatus;
    use std::sync::atomic::AtomicUsize;
    use tempfile::NamedTempFile;

    #[test]
    fn timer_claimants_are_unique_inside_one_process() {
        assert_ne!(new_timer_claimant_id(), new_timer_claimant_id());
    }

    #[tokio::test]
    async fn timer_engine_fires_persisted_timer_once() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(database.path().to_string_lossy().as_ref())
                .await
                .unwrap(),
        );
        let engine = Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>));
        let fired = Arc::new(AtomicUsize::new(0));
        engine
            .register_handler(RuntimeTimerKind::Schedule, {
                let fired = Arc::clone(&fired);
                move |_| {
                    let fired = Arc::clone(&fired);
                    async move {
                        fired.fetch_add(1, Ordering::SeqCst);
                        Ok(TimerDisposition::Complete)
                    }
                }
            })
            .unwrap();
        assert!(engine.start());
        assert!(!engine.start());
        engine
            .schedule(NewRuntimeTimer {
                id: "timer-engine-once".to_string(),
                generation: 1,
                kind: RuntimeTimerKind::Schedule,
                owner_id: "schedule-engine-once".to_string(),
                due_at: Utc::now() + ChronoDuration::milliseconds(20),
                payload: serde_json::json!({}),
            })
            .await
            .unwrap();

        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if store
                    .get_runtime_timer("timer-engine-once")
                    .await
                    .unwrap()
                    .is_some_and(|timer| timer.status == RuntimeTimerStatus::Fired)
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(fired.load(Ordering::SeqCst), 1);
    }
}
