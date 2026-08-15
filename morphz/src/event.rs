use chrono::{DateTime, Utc};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

pub const TYPE_USER_MESSAGE: &str = "user_message";
pub const TYPE_AGENT_CALL: &str = "agent_call";
pub const TYPE_TOOL_OUTPUT: &str = "tool_output";
pub const TYPE_FILE_CHANGE: &str = "file_change";
pub const TYPE_EXCEPTION: &str = "exception";
pub const TYPE_PROPOSAL: &str = "proposal";
pub const TYPE_CONTEXT_TRANSACTION: &str = "context_transaction";
pub const TYPE_CONTEXT_SEED: &str = "context_seed";
/// A question raised by an `infer` node while the Runtime was evaluating a
/// program the Agent submitted.
///
/// It is deliberately not a `user_message`: nobody asked. Rendering it as one
/// would invite the Agent to answer the user, when what is waiting on the value
/// is its own half-evaluated program.
pub const TYPE_INFER_REQUEST: &str = "infer_request";

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

// An Event is an immutable occurrence in episodic memory.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Event {
    pub id: String,
    /// Stable, monotonically increasing physical insertion order in the Event Store. It is absent
    /// while a newly created in-memory Event has not yet been persisted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u64>,
    pub timestamp: DateTime<Utc>,
    pub actor: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub topic: String,
    pub payload: serde_json::Map<String, JsonValue>,
}

impl Event {
    pub fn new(
        id: String,
        actor: String,
        event_type: String,
        topic: String,
        payload: serde_json::Map<String, JsonValue>,
    ) -> Self {
        Self {
            id,
            sequence: None,
            timestamp: Utc::now(),
            actor,
            event_type,
            topic,
            payload,
        }
    }
}

/// Whether one immutable Event is part of the Agent-visible Observation
/// projection. This predicate is shared by Context Encoding and persistence:
/// changing it in only one layer would make the online Projection disagree
/// with a full Ledger rebuild.
pub fn is_context_observation(event: &Event) -> bool {
    if event.topic == "chat/assistant_call"
        || event.topic == "chat/progress"
        || event.topic == "chat/no_reply"
        || event.topic == "chat/context_inspect"
        || event.topic == "chat/context_tx_committed"
        || event.topic == "chat/runtime_error"
        || event.topic.starts_with("runtime/")
    {
        return false;
    }
    if event.event_type == TYPE_TOOL_OUTPUT
        && event.payload.get("tool_name").and_then(JsonValue::as_str) == Some("context_tx")
    {
        return event
            .payload
            .get("text")
            .and_then(JsonValue::as_str)
            .is_some_and(|text| text.starts_with("执行失败:") || text.starts_with("执行拒绝:"));
    }
    matches!(
        event.event_type.as_str(),
        TYPE_USER_MESSAGE
            | TYPE_TOOL_OUTPUT
            | TYPE_AGENT_CALL
            | TYPE_EXCEPTION
            | TYPE_FILE_CHANGE
            | TYPE_INFER_REQUEST
    )
}

/// Whether accepting an immutable Event into a newly-created Activation adds
/// a genuinely new external fact to the Cognitive Context. This predicate is
/// intentionally narrower than `is_context_observation`: internal receipts,
/// delivery barriers and model continuations may be useful operationally, but
/// they must not age the Mind merely because Runtime is busy.
pub fn advances_cognitive_clock(event: &Event) -> bool {
    if event
        .payload
        .get("external_cognitive_fact")
        .and_then(JsonValue::as_bool)
        == Some(true)
    {
        return true;
    }
    if event.event_type == TYPE_USER_MESSAGE {
        return true;
    }
    if event.event_type == TYPE_TOOL_OUTPUT {
        return event.payload.get("tool_name").and_then(JsonValue::as_str) != Some("context_tx")
            && !matches!(
                event.topic.as_str(),
                "chat/progress"
                    | "chat/thread_completion_ready"
                    | "chat/context_tx_committed"
                    | "runtime/action_group_settled"
            );
    }
    if matches!(
        event.event_type.as_str(),
        TYPE_EXCEPTION | TYPE_FILE_CHANGE | TYPE_AGENT_CALL
    ) {
        return event.topic != "chat/assistant_call";
    }
    event.topic == "chat/schedule_due"
        || event.topic.starts_with("external/")
        || event.topic.starts_with("integration/")
        || event.topic.starts_with("delegation/")
        || event.topic.starts_with("approval/")
}

pub type EventHandler = Arc<
    dyn Fn(Event) -> BoxFuture<'static, Result<(), Box<dyn std::error::Error + Send + Sync>>>
        + Send
        + Sync,
>;

pub struct Subscription {
    id: String,
    topic_pattern: String,
    handler: EventHandler,
    durable: bool,
    serialize_durable: bool,
}

impl Subscription {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn topic_pattern(&self) -> &str {
        &self.topic_pattern
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct AsyncDispatchKey {
    subscription_id: String,
    event_id: String,
}

struct AsyncDispatchRegistration {
    in_flight: Arc<DashMap<AsyncDispatchKey, ()>>,
    key: AsyncDispatchKey,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct EphemeralObservationRegistration {
    observer_id: String,
    topic: String,
    scope_id: String,
}

impl Drop for AsyncDispatchRegistration {
    fn drop(&mut self) {
        self.in_flight.remove(&self.key);
    }
}

pub struct InMemoryEventBus {
    subscriptions: DashMap<String, Arc<Subscription>>,
    sub_counter: AtomicU64,
    error_handler: Arc<dyn Fn(Box<dyn std::error::Error + Send + Sync>, Event) + Send + Sync>,
    semaphore: Arc<tokio::sync::Semaphore>,
    /// Durable outbox retries may redispatch one Event while its original
    /// business handler is still waiting on a thread or admission gate. Keep
    /// one local delivery per subscription/Event pair so retries cannot fill
    /// the global business-handler semaphore with duplicate waiters.
    async_in_flight: Arc<DashMap<AsyncDispatchKey, ()>>,
    durable_lock: Arc<tokio::sync::Mutex<()>>,
    sync_handler_timeout: std::time::Duration,
    /// Process-local demand for expensive diagnostic projections. Registering
    /// interest never creates a Ledger fact; it only lets producers avoid
    /// constructing large transient payloads when nobody can consume them.
    ephemeral_observations: DashMap<EphemeralObservationRegistration, ()>,
}

impl Default for InMemoryEventBus {
    fn default() -> Self {
        Self::new()
    }
}

impl InMemoryEventBus {
    pub fn new() -> Self {
        Self::with_concurrency_limit(10)
    }

    pub fn with_concurrency_limit(limit: usize) -> Self {
        Self::with_limits(limit, std::time::Duration::from_secs(5))
    }

    fn with_limits(limit: usize, sync_handler_timeout: std::time::Duration) -> Self {
        Self {
            subscriptions: DashMap::new(),
            sub_counter: AtomicU64::new(0),
            error_handler: Arc::new(|err, ev| {
                tracing::error!(event_code = "event_bus.dispatch_failed", event_id = %ev.id, error = ?err, "EventBus dispatch failed");
            }),
            semaphore: Arc::new(tokio::sync::Semaphore::new(limit)),
            async_in_flight: Arc::new(DashMap::new()),
            durable_lock: Arc::new(tokio::sync::Mutex::new(())),
            sync_handler_timeout,
            ephemeral_observations: DashMap::new(),
        }
    }

    pub fn request_ephemeral_observation(
        &self,
        observer_id: impl Into<String>,
        topic: impl Into<String>,
        scope_id: impl Into<String>,
    ) {
        self.ephemeral_observations.insert(
            EphemeralObservationRegistration {
                observer_id: observer_id.into(),
                topic: topic.into(),
                scope_id: scope_id.into(),
            },
            (),
        );
    }

    pub fn clear_ephemeral_observations(&self, observer_id: &str) {
        self.ephemeral_observations
            .retain(|registration, _| registration.observer_id != observer_id);
    }

    pub fn ephemeral_observation_requested(&self, topic: &str, scope_id: &str) -> bool {
        self.ephemeral_observations.iter().any(|registration| {
            registration.key().topic == topic && registration.key().scope_id == scope_id
        })
    }

    pub fn set_error_handler<F>(&mut self, handler: F)
    where
        F: Fn(Box<dyn std::error::Error + Send + Sync>, Event) + Send + Sync + 'static,
    {
        self.error_handler = Arc::new(handler);
    }

    pub fn subscribe(&self, topic_pattern: String, handler: EventHandler) -> String {
        self.add_subscription(topic_pattern, handler, false, false)
    }

    /// Register a persistence boundary that must complete successfully before an event is
    /// dispatched to business subscribers. Durable handlers are serialized across concurrent
    /// publishers and are deliberately not subject to the best-effort audit timeout.
    pub fn subscribe_durable(&self, topic_pattern: String, handler: EventHandler) -> String {
        self.add_subscription(topic_pattern, handler, true, true)
    }

    /// Register a durable boundary whose handler owns ordering and bounded
    /// backpressure itself. This is used by the Runtime Event Writer so
    /// concurrent publishers can enter one group-commit window. General
    /// durable subscribers should keep using `subscribe_durable`.
    pub(crate) fn subscribe_durable_writer(
        &self,
        topic_pattern: String,
        handler: EventHandler,
    ) -> String {
        self.add_subscription(topic_pattern, handler, true, false)
    }

    fn add_subscription(
        &self,
        topic_pattern: String,
        handler: EventHandler,
        durable: bool,
        serialize_durable: bool,
    ) -> String {
        let id_val = self.sub_counter.fetch_add(1, Ordering::SeqCst) + 1;
        let sub_id = format!("sub_{}", id_val);

        let sub = Arc::new(Subscription {
            id: sub_id.clone(),
            topic_pattern,
            handler,
            durable,
            serialize_durable,
        });

        self.subscriptions.insert(sub_id.clone(), sub);
        sub_id
    }

    pub fn unsubscribe(&self, sub_id: &str) {
        self.subscriptions.remove(sub_id);
    }

    pub async fn publish(&self, ev: Event) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.publish_with_options(ev, true, false).await
    }

    /// Delivers transient UI/progress events without crossing the durable
    /// Ledger boundary. Ephemeral events must never be used for user messages,
    /// tool receipts, Context transactions, replies, or any other physical
    /// fact that must survive restart.
    pub async fn publish_ephemeral(
        &self,
        ev: Event,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.publish_with_options(ev, false, false).await
    }

    /// Dispatch a durable fact that was committed atomically by another store
    /// transaction. This skips only the EventBus persistence boundary; normal
    /// audit and business subscribers still observe the event.
    pub async fn dispatch_persisted(
        &self,
        ev: Event,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.publish_with_options(ev, false, false).await
    }

    /// Dispatch an already-durable child handoff from a business handler that
    /// remains alive while it waits for that child. The child must not queue
    /// behind the parent's global business-handler permit, otherwise a
    /// saturated EventBus can deadlock the durable parent/child dependency.
    ///
    /// This only bypasses the process-local concurrency semaphore. Durable
    /// persistence, per-subscription/Event de-duplication, audit listeners,
    /// and the child's own admission controls remain unchanged.
    pub(crate) async fn dispatch_persisted_child_handoff(
        &self,
        ev: Event,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.publish_with_options(ev, false, true).await
    }

    async fn publish_with_options(
        &self,
        ev: Event,
        durable: bool,
        bypass_async_limit: bool,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut durable_subs = Vec::new();
        let mut durable_writer_subs = Vec::new();
        let mut sync_subs = Vec::new();
        let mut async_subs = Vec::new();

        for entry in self.subscriptions.iter() {
            let sub = entry.value();
            if match_topic(&sub.topic_pattern, &ev.topic) {
                if sub.durable {
                    if sub.serialize_durable {
                        durable_subs.push(Arc::clone(sub));
                    } else {
                        durable_writer_subs.push(Arc::clone(sub));
                    }
                } else if sub.topic_pattern == "*" {
                    sync_subs.push(Arc::clone(sub));
                } else {
                    async_subs.push(Arc::clone(sub));
                }
            }
        }

        // 1. Cross the reliable serialized persistence boundary first. Do not dispatch business
        // Events after a persistence failure.
        if durable && !durable_subs.is_empty() {
            let _durable_guard = self.durable_lock.lock().await;
            for sub in durable_subs {
                (sub.handler)(ev.clone()).await?;
            }
        }
        if durable {
            for sub in durable_writer_subs {
                (sub.handler)(ev.clone()).await?;
            }
        }

        // 2. Run best-effort global audit listeners synchronously. They cannot own persistence.
        for sub in sync_subs {
            let handler = Arc::clone(&sub.handler);
            let ev_clone = ev.clone();
            let ev_clone_for_err = ev_clone.clone();
            let err_handler = Arc::clone(&self.error_handler);
            match tokio::time::timeout(self.sync_handler_timeout, handler(ev_clone)).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => err_handler(error, ev_clone_for_err),
                Err(_) => err_handler(
                    std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        format!(
                            "全局事件审计 handler 超过 {:?} 未完成",
                            self.sync_handler_timeout
                        ),
                    )
                    .into(),
                    ev_clone_for_err,
                ),
            }
        }

        // 3. Dispatch remaining business listeners asynchronously.
        for sub in async_subs {
            let dispatch_key = AsyncDispatchKey {
                subscription_id: sub.id.clone(),
                event_id: ev.id.clone(),
            };
            match self.async_in_flight.entry(dispatch_key.clone()) {
                dashmap::mapref::entry::Entry::Occupied(_) => continue,
                dashmap::mapref::entry::Entry::Vacant(entry) => {
                    entry.insert(());
                }
            }
            let handler = Arc::clone(&sub.handler);
            let ev_clone = ev.clone();
            let ev_clone_for_err = ev_clone.clone();
            let err_handler = Arc::clone(&self.error_handler);
            let semaphore = Arc::clone(&self.semaphore);
            let in_flight = Arc::clone(&self.async_in_flight);
            tokio::spawn(async move {
                let _registration = AsyncDispatchRegistration {
                    in_flight,
                    key: dispatch_key,
                };
                if bypass_async_limit {
                    if let Err(err) = handler(ev_clone).await {
                        err_handler(err, ev_clone_for_err);
                    }
                } else if let Ok(permit) = semaphore.acquire_owned().await {
                    let _permit = permit;
                    if let Err(err) = handler(ev_clone).await {
                        err_handler(err, ev_clone_for_err);
                    }
                }
            });
        }

        Ok(())
    }
}

// Evaluates whether a topic matches a pattern.
fn match_topic(pattern: &str, topic: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if pattern == topic {
        return true;
    }
    // Supports `prefix/*` prefix wildcards.
    if let Some(prefix) = pattern.strip_suffix("/*") {
        return topic.starts_with(prefix) && topic[prefix.len()..].starts_with('/');
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[tokio::test]
    async fn test_match_topic() {
        assert!(match_topic("*", "chat/user_message"));
        assert!(match_topic("chat/*", "chat/user_message"));
        assert!(!match_topic("chat/*", "chat2/user_message"));
        assert!(match_topic("chat/user_message", "chat/user_message"));
        assert!(!match_topic("chat/user", "chat/user_message"));
    }

    #[tokio::test]
    async fn test_event_bus() {
        let bus = InMemoryEventBus::new();
        let records = Arc::new(Mutex::new(Vec::new()));

        let records_clone = Arc::clone(&records);
        bus.subscribe(
            "chat/*".to_string(),
            Arc::new(move |ev| {
                let r = Arc::clone(&records_clone);
                Box::pin(async move {
                    r.lock().unwrap().push(ev.topic);
                    Ok(())
                })
            }),
        );

        let records_clone2 = Arc::clone(&records);
        bus.subscribe(
            "*".to_string(),
            Arc::new(move |ev| {
                let r = Arc::clone(&records_clone2);
                Box::pin(async move {
                    r.lock().unwrap().push(format!("audit:{}", ev.topic));
                    Ok(())
                })
            }),
        );

        let ev = Event::new(
            "1".to_string(),
            "actor".to_string(),
            "type".to_string(),
            "chat/msg".to_string(),
            serde_json::Map::new(),
        );

        bus.publish(ev).await.unwrap();

        // Allow asynchronous tasks to finish.
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

        let recs = records.lock().unwrap();
        // Should contain `audit:chat/msg` (synchronous) and `chat/msg` (asynchronous).
        assert!(recs.contains(&"audit:chat/msg".to_string()));
        assert!(recs.contains(&"chat/msg".to_string()));
    }

    #[test]
    fn ephemeral_observation_demand_is_scoped_and_cleared_by_observer() {
        let bus = InMemoryEventBus::new();
        bus.request_ephemeral_observation("dashboard-a", "runtime/request", "session-a");
        bus.request_ephemeral_observation("dashboard-a", "runtime/other", "session-a");
        bus.request_ephemeral_observation("dashboard-b", "runtime/request", "session-b");

        assert!(bus.ephemeral_observation_requested("runtime/request", "session-a"));
        assert!(bus.ephemeral_observation_requested("runtime/request", "session-b"));
        assert!(!bus.ephemeral_observation_requested("runtime/request", "session-c"));

        bus.clear_ephemeral_observations("dashboard-a");
        assert!(!bus.ephemeral_observation_requested("runtime/request", "session-a"));
        assert!(!bus.ephemeral_observation_requested("runtime/other", "session-a"));
        assert!(bus.ephemeral_observation_requested("runtime/request", "session-b"));
    }

    #[tokio::test]
    async fn test_event_bus_backpressure() {
        // Create an EventBus with concurrency limited to 2.
        let bus = Arc::new(InMemoryEventBus::with_concurrency_limit(2));
        let active_count = Arc::new(Mutex::new(0));
        let max_concurrent = Arc::new(Mutex::new(0));

        let active_count_clone = Arc::clone(&active_count);
        let max_concurrent_clone = Arc::clone(&max_concurrent);

        bus.subscribe(
            "chat/*".to_string(),
            Arc::new(move |_ev| {
                let active = Arc::clone(&active_count_clone);
                let max_c = Arc::clone(&max_concurrent_clone);
                Box::pin(async move {
                    {
                        let mut act = active.lock().unwrap();
                        *act += 1;
                        let mut mc = max_c.lock().unwrap();
                        if *act > *mc {
                            *mc = *act;
                        }
                    }
                    // Simulate slow processing so concurrency remains observable.
                    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
                    {
                        let mut act = active.lock().unwrap();
                        *act -= 1;
                    }
                    Ok(())
                })
            }),
        );

        // Publish five Events concurrently.
        for i in 0..5 {
            let ev = Event::new(
                i.to_string(),
                "actor".to_string(),
                "type".to_string(),
                "chat/msg".to_string(),
                serde_json::Map::new(),
            );
            bus.publish(ev).await.unwrap();
        }

        // Wait for every Event to finish processing.
        tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;

        let mc = *max_concurrent.lock().unwrap();
        // The semaphore limit is 2, so observed concurrency must never exceed 2.
        assert!(
            mc <= 2 && mc > 0,
            "最大并发数量 {} 应该不超过 2 且大于 0",
            mc
        );
    }

    #[tokio::test]
    async fn duplicate_in_flight_dispatch_does_not_starve_an_unrelated_event() {
        let bus = Arc::new(InMemoryEventBus::with_concurrency_limit(2));
        let blocked_started = Arc::new(tokio::sync::Notify::new());
        let blocked_release = Arc::new(tokio::sync::Notify::new());
        let unrelated_seen = Arc::new(tokio::sync::Notify::new());
        let blocked_calls = Arc::new(AtomicU64::new(0));

        let started = Arc::clone(&blocked_started);
        let release = Arc::clone(&blocked_release);
        let unrelated = Arc::clone(&unrelated_seen);
        let calls = Arc::clone(&blocked_calls);
        bus.subscribe(
            "chat/*".to_string(),
            Arc::new(move |event| {
                let started = Arc::clone(&started);
                let release = Arc::clone(&release);
                let unrelated = Arc::clone(&unrelated);
                let calls = Arc::clone(&calls);
                Box::pin(async move {
                    if event.id == "blocked" {
                        calls.fetch_add(1, Ordering::SeqCst);
                        started.notify_one();
                        release.notified().await;
                    } else if event.id == "unrelated" {
                        unrelated.notify_one();
                    }
                    Ok(())
                })
            }),
        );

        let blocked = Event::new(
            "blocked".to_string(),
            "test".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            serde_json::Map::new(),
        );
        bus.dispatch_persisted(blocked.clone()).await.unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            blocked_started.notified(),
        )
        .await
        .expect("the original handler should start");

        // Model the Signal Outbox polling the same still-pending row many
        // times while the original handler is blocked behind its thread gate.
        for _ in 0..32 {
            bus.dispatch_persisted(blocked.clone()).await.unwrap();
        }
        bus.dispatch_persisted(Event::new(
            "unrelated".to_string(),
            "test".to_string(),
            TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            serde_json::Map::new(),
        ))
        .await
        .unwrap();

        tokio::time::timeout(std::time::Duration::from_secs(1), unrelated_seen.notified())
            .await
            .expect("duplicate redelivery must not consume the unrelated event's slot");
        assert_eq!(blocked_calls.load(Ordering::SeqCst), 1);
        blocked_release.notify_waiters();
    }

    #[tokio::test]
    async fn failed_async_dispatch_can_be_retried() {
        let bus = Arc::new(InMemoryEventBus::with_concurrency_limit(1));
        let attempts = Arc::new(AtomicU64::new(0));
        let completed = Arc::new(tokio::sync::Notify::new());
        let attempts_handler = Arc::clone(&attempts);
        let completed_handler = Arc::clone(&completed);
        bus.subscribe(
            "chat/test".to_string(),
            Arc::new(move |_event| {
                let attempts = Arc::clone(&attempts_handler);
                let completed = Arc::clone(&completed_handler);
                Box::pin(async move {
                    let attempt = attempts.fetch_add(1, Ordering::SeqCst) + 1;
                    if attempt == 1 {
                        return Err(std::io::Error::other("transient failure").into());
                    }
                    completed.notify_one();
                    Ok(())
                })
            }),
        );
        let event = Event::new(
            "retryable".to_string(),
            "test".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/test".to_string(),
            serde_json::Map::new(),
        );

        bus.dispatch_persisted(event.clone()).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while !bus.async_in_flight.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("a failed handler should release its in-flight registration");

        bus.dispatch_persisted(event).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), completed.notified())
            .await
            .expect("the durable retry should run after a transient failure");
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn nested_async_publish_does_not_deadlock_when_bus_is_at_capacity() {
        let bus = Arc::new(InMemoryEventBus::with_concurrency_limit(1));
        let nested_seen = Arc::new(std::sync::atomic::AtomicBool::new(false));

        let nested_seen_handler = Arc::clone(&nested_seen);
        bus.subscribe(
            "runtime/nested".to_string(),
            Arc::new(move |_event| {
                let nested_seen = Arc::clone(&nested_seen_handler);
                Box::pin(async move {
                    nested_seen.store(true, Ordering::SeqCst);
                    Ok(())
                })
            }),
        );

        let nested_bus = Arc::clone(&bus);
        bus.subscribe(
            "chat/start".to_string(),
            Arc::new(move |_event| {
                let nested_bus = Arc::clone(&nested_bus);
                Box::pin(async move {
                    nested_bus
                        .publish(Event::new(
                            "nested".to_string(),
                            "test".to_string(),
                            "runtime_control".to_string(),
                            "runtime/nested".to_string(),
                            serde_json::Map::new(),
                        ))
                        .await
                })
            }),
        );

        bus.publish(Event::new(
            "start".to_string(),
            "test".to_string(),
            "user_message".to_string(),
            "chat/start".to_string(),
            serde_json::Map::new(),
        ))
        .await
        .unwrap();

        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while !nested_seen.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("nested publish should complete after the outer handler releases its permit");
    }

    #[tokio::test]
    async fn stalled_global_audit_does_not_block_business_subscribers() {
        let bus = Arc::new(InMemoryEventBus::with_limits(
            2,
            std::time::Duration::from_millis(20),
        ));
        let business_seen = Arc::new(std::sync::atomic::AtomicBool::new(false));

        bus.subscribe(
            "*".to_string(),
            Arc::new(move |_event| {
                Box::pin(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    Ok(())
                })
            }),
        );
        let business_seen_handler = Arc::clone(&business_seen);
        bus.subscribe(
            "chat/test".to_string(),
            Arc::new(move |_event| {
                let business_seen = Arc::clone(&business_seen_handler);
                Box::pin(async move {
                    business_seen.store(true, Ordering::SeqCst);
                    Ok(())
                })
            }),
        );

        bus.publish(Event::new(
            "audit-timeout".to_string(),
            "test".to_string(),
            "user_message".to_string(),
            "chat/test".to_string(),
            serde_json::Map::new(),
        ))
        .await
        .unwrap();

        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while !business_seen.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("business subscriber should run after audit timeout");
    }

    #[tokio::test]
    async fn durable_subscriber_serializes_concurrent_publishers() {
        let bus = Arc::new(InMemoryEventBus::new());
        let active = Arc::new(AtomicU64::new(0));
        let max_active = Arc::new(AtomicU64::new(0));

        let active_handler = Arc::clone(&active);
        let max_handler = Arc::clone(&max_active);
        bus.subscribe_durable(
            "*".to_string(),
            Arc::new(move |_event| {
                let active = Arc::clone(&active_handler);
                let max_active = Arc::clone(&max_handler);
                Box::pin(async move {
                    let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                    max_active.fetch_max(current, Ordering::SeqCst);
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                })
            }),
        );

        let mut publishers = Vec::new();
        for index in 0..3 {
            let bus = Arc::clone(&bus);
            publishers.push(tokio::spawn(async move {
                bus.publish(Event::new(
                    format!("durable-{index}"),
                    "test".to_string(),
                    "test".to_string(),
                    "chat/test".to_string(),
                    serde_json::Map::new(),
                ))
                .await
                .unwrap();
            }));
        }
        for publisher in publishers {
            publisher.await.unwrap();
        }

        assert_eq!(max_active.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn durable_failure_prevents_business_dispatch() {
        let bus = Arc::new(InMemoryEventBus::new());
        let business_seen = Arc::new(std::sync::atomic::AtomicBool::new(false));
        bus.subscribe_durable(
            "*".to_string(),
            Arc::new(move |_event| {
                Box::pin(async move { Err(std::io::Error::other("ledger unavailable").into()) })
            }),
        );
        let business_seen_handler = Arc::clone(&business_seen);
        bus.subscribe(
            "chat/test".to_string(),
            Arc::new(move |_event| {
                let business_seen = Arc::clone(&business_seen_handler);
                Box::pin(async move {
                    business_seen.store(true, Ordering::SeqCst);
                    Ok(())
                })
            }),
        );

        let result = bus
            .publish(Event::new(
                "durable-failure".to_string(),
                "test".to_string(),
                "test".to_string(),
                "chat/test".to_string(),
                serde_json::Map::new(),
            ))
            .await;
        assert!(result.is_err());
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(!business_seen.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn ephemeral_event_reaches_live_subscriber_without_crossing_durable_boundary() {
        let bus = InMemoryEventBus::new();
        let durable = Arc::new(Mutex::new(Vec::new()));
        let live = Arc::new(Mutex::new(Vec::new()));
        let durable_capture = Arc::clone(&durable);
        bus.subscribe_durable(
            "runtime/model_stream".to_string(),
            Arc::new(move |event| {
                let capture = Arc::clone(&durable_capture);
                Box::pin(async move {
                    capture.lock().unwrap().push(event.id);
                    Ok(())
                })
            }),
        );
        let live_capture = Arc::clone(&live);
        bus.subscribe(
            "runtime/model_stream".to_string(),
            Arc::new(move |event| {
                let capture = Arc::clone(&live_capture);
                Box::pin(async move {
                    capture.lock().unwrap().push(event.id);
                    Ok(())
                })
            }),
        );

        bus.publish_ephemeral(Event::new(
            "draft-1".to_string(),
            "model".to_string(),
            "runtime_ephemeral".to_string(),
            "runtime/model_stream".to_string(),
            Default::default(),
        ))
        .await
        .unwrap();
        tokio::task::yield_now().await;

        assert!(durable.lock().unwrap().is_empty());
        assert_eq!(live.lock().unwrap().as_slice(), ["draft-1"]);
    }

    #[test]
    fn cognitive_clock_only_advances_for_new_external_facts() {
        let event = |event_type: &str, topic: &str, payload: serde_json::Value| {
            Event::new(
                format!("{event_type}-{topic}"),
                "test".to_string(),
                event_type.to_string(),
                topic.to_string(),
                payload.as_object().cloned().unwrap_or_default(),
            )
        };
        assert!(advances_cognitive_clock(&event(
            TYPE_USER_MESSAGE,
            "chat/user_message",
            serde_json::json!({"text": "new fact"}),
        )));
        assert!(advances_cognitive_clock(&event(
            TYPE_TOOL_OUTPUT,
            "chat/tool_output",
            serde_json::json!({"tool_name": "read", "text": "result"}),
        )));
        assert!(!advances_cognitive_clock(&event(
            TYPE_TOOL_OUTPUT,
            "chat/tool_output",
            serde_json::json!({"tool_name": "context_tx", "text": "committed"}),
        )));
        assert!(!advances_cognitive_clock(&event(
            TYPE_AGENT_CALL,
            "chat/assistant_call",
            serde_json::json!({"continuation": true}),
        )));
        assert!(!advances_cognitive_clock(&event(
            "runtime_control",
            "objective/supervisor_continuation",
            serde_json::json!({}),
        )));
        assert!(advances_cognitive_clock(&event(
            "integration_result",
            "integration/github",
            serde_json::json!({}),
        )));
    }
}
