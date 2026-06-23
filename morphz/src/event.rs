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

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

// Event 对应情境记忆中的不可变事件
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub id: String,
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
            timestamp: Utc::now(),
            actor,
            event_type,
            topic,
            payload,
        }
    }
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
}

impl Subscription {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn topic_pattern(&self) -> &str {
        &self.topic_pattern
    }
}

pub struct InMemoryEventBus {
    subscriptions: DashMap<String, Arc<Subscription>>,
    sub_counter: AtomicU64,
    error_handler: Arc<
        dyn Fn(Box<dyn std::error::Error + Send + Sync>, Event) + Send + Sync,
    >,
}

impl InMemoryEventBus {
    pub fn new() -> Self {
        Self {
            subscriptions: DashMap::new(),
            sub_counter: AtomicU64::new(0),
            error_handler: Arc::new(|err, ev| {
                eprintln!("\n⚠️ [事件总线错误] 事件ID: {}, 错误: {:?}", ev.id, err);
            }),
        }
    }

    pub fn set_error_handler<F>(&mut self, handler: F)
    where
        F: Fn(Box<dyn std::error::Error + Send + Sync>, Event) + Send + Sync + 'static,
    {
        self.error_handler = Arc::new(handler);
    }

    pub fn subscribe(&self, topic_pattern: String, handler: EventHandler) -> String {
        let id_val = self.sub_counter.fetch_add(1, Ordering::SeqCst) + 1;
        let sub_id = format!("sub_{}", id_val);

        let sub = Arc::new(Subscription {
            id: sub_id.clone(),
            topic_pattern,
            handler,
        });

        self.subscriptions.insert(sub_id.clone(), sub);
        sub_id
    }

    pub fn unsubscribe(&self, sub_id: &str) {
        self.subscriptions.remove(sub_id);
    }

    pub async fn publish(&self, ev: Event) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut sync_subs = Vec::new();
        let mut async_subs = Vec::new();

        for entry in self.subscriptions.iter() {
            let sub = entry.value();
            if match_topic(&sub.topic_pattern, &ev.topic) {
                if sub.topic_pattern == "*" {
                    sync_subs.push(Arc::clone(sub));
                } else {
                    async_subs.push(Arc::clone(sub));
                }
            }
        }

        // 1. 同步执行全局审计监听器
        for sub in sync_subs {
            let handler = Arc::clone(&sub.handler);
            let ev_clone = ev.clone();
            let ev_clone_for_err = ev_clone.clone();
            let err_handler = Arc::clone(&self.error_handler);
            if let Err(err) = handler(ev_clone).await {
                err_handler(err, ev_clone_for_err);
            }
        }

        // 2. 异步派发其他业务监听器
        for sub in async_subs {
            let handler = Arc::clone(&sub.handler);
            let ev_clone = ev.clone();
            let ev_clone_for_err = ev_clone.clone();
            let err_handler = Arc::clone(&self.error_handler);
            tokio::spawn(async move {
                if let Err(err) = handler(ev_clone).await {
                    err_handler(err, ev_clone_for_err);
                }
            });
        }

        Ok(())
    }
}

// match_topic 评估 topic 是否符合 pattern
fn match_topic(pattern: &str, topic: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if pattern == topic {
        return true;
    }
    // 支持 prefix/* 前缀通配符匹配
    if pattern.ends_with("/*") {
        let prefix = &pattern[..pattern.len() - 2];
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

        // 稍微等待下异步任务执行完毕
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

        let recs = records.lock().unwrap();
        // 应该包含 audit:chat/msg (同步) 和 chat/msg (异步)
        assert!(recs.contains(&"audit:chat/msg".to_string()));
        assert!(recs.contains(&"chat/msg".to_string()));
    }
}
