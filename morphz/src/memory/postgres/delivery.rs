use super::{append_event_in_tx, append_signal_outbox_in_tx, now_text, PostgresStore, StoreError};
use crate::event::Event;
use crate::memory::{DeliveryIngressStore, MessageClaim};
use serde_json::{json, Value as JsonValue};
use sqlx::{PgPool, Row};

pub(super) async fn migrate(pool: &PgPool) -> Result<(), StoreError> {
    for statement in [
        r#"CREATE TABLE IF NOT EXISTS session_message_requests (
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            client_message_id TEXT NOT NULL,
            event_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY(session_id, client_message_id),
            UNIQUE(event_id)
        )"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_session_message_requests_event
           ON session_message_requests(event_id)"#,
    ] {
        sqlx::query(statement).execute(pool).await?;
    }
    Ok(())
}

#[async_trait::async_trait]
impl DeliveryIngressStore for PostgresStore {
    async fn commit_thread_delivery(
        &self,
        thread_ids: &[String],
        event: &Event,
    ) -> Result<bool, StoreError> {
        if thread_ids.is_empty() {
            return Err("Thread delivery 至少覆盖一个 thread_id".into());
        }
        let session_id = event
            .payload
            .get("session_id")
            .and_then(JsonValue::as_str)
            .ok_or("Thread delivery Event 缺少 session_id")?;
        let now = now_text();
        let mut tx = self.pool.begin().await?;
        for thread_id in thread_ids {
            let result = sqlx::query(
                r#"UPDATE threads SET revision = revision + 1,
                   delivery_status = 'delivered', delivery_event_id = $1,
                   updated_at = $2
                   WHERE id = $3 AND session_id = $4
                     AND delivery_status IN ('pending', 'deferred')"#,
            )
            .bind(&event.id)
            .bind(&now)
            .bind(thread_id)
            .bind(session_id)
            .execute(&mut *tx)
            .await?;
            if result.rows_affected() != 1 {
                tx.rollback().await?;
                return Ok(false);
            }
        }
        append_event_in_tx(&mut tx, event).await?;
        tx.commit().await?;
        Ok(true)
    }

    async fn claim_message(
        &self,
        session_id: &str,
        client_message_id: &str,
        event: &Event,
    ) -> Result<MessageClaim, StoreError> {
        let event_session_id = event
            .payload
            .get("session_id")
            .and_then(JsonValue::as_str)
            .ok_or("用户消息缺少 session_id")?;
        let event_context_id = event
            .payload
            .get("context_id")
            .and_then(JsonValue::as_str)
            .ok_or("用户消息缺少 context_id")?;
        let mut tx = self.pool.begin().await?;
        let session = sqlx::query(
            r#"SELECT context_id, attention_state, attention_revision
               FROM sessions WHERE id = $1 FOR UPDATE"#,
        )
        .bind(session_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| format!("Session '{session_id}' 不存在"))?;
        let registry_context_id: String = session.get("context_id");
        if event_session_id != session_id || event_context_id != registry_context_id {
            return Err(format!(
                "消息路由与 Session Registry 不一致：请求 Session='{}'，Event Session='{}'，Event Context='{}'，Registry Context='{}'",
                session_id, event_session_id, event_context_id, registry_context_id
            )
            .into());
        }

        let inserted = sqlx::query(
            r#"INSERT INTO session_message_requests
               (session_id, client_message_id, event_id, created_at)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT(session_id, client_message_id) DO NOTHING"#,
        )
        .bind(session_id)
        .bind(client_message_id)
        .bind(&event.id)
        .bind(now_text())
        .execute(&mut *tx)
        .await?;
        if inserted.rows_affected() == 0 {
            let existing: String = sqlx::query_scalar(
                r#"SELECT event_id FROM session_message_requests
                   WHERE session_id = $1 AND client_message_id = $2"#,
            )
            .bind(session_id)
            .bind(client_message_id)
            .fetch_one(&mut *tx)
            .await?;
            tx.commit().await?;
            return Ok(MessageClaim::Existing { event_id: existing });
        }

        append_event_in_tx(&mut tx, event).await?;
        append_signal_outbox_in_tx(&mut tx, event).await?;
        let timestamp = event
            .timestamp
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query("UPDATE sessions SET updated_at = $1, last_activity_at = $1 WHERE id = $2")
            .bind(&timestamp)
            .bind(session_id)
            .execute(&mut *tx)
            .await?;

        if session.get::<String, _>("attention_state") == "retired" {
            let restore_event_id = format!("runtime_session_restored_{}", event.id);
            let next_revision = session.get::<i64, _>("attention_revision") + 1;
            sqlx::query(
                r#"UPDATE sessions SET attention_state = 'active',
                   attention_revision = attention_revision + 1,
                   attention_reason = 'new directed user message',
                   attention_changed_at = $1, attention_event_id = $2,
                   updated_at = $1
                   WHERE id = $3 AND attention_state = 'retired'"#,
            )
            .bind(&timestamp)
            .bind(&restore_event_id)
            .bind(session_id)
            .execute(&mut *tx)
            .await?;
            let restore = Event {
                id: restore_event_id,
                sequence: None,
                timestamp: event.timestamp,
                actor: "Runtime-SessionAttention".to_string(),
                event_type: "runtime_control".to_string(),
                topic: "runtime/session_restored".to_string(),
                payload: json!({
                    "context_id": event_context_id,
                    "session_id": session_id,
                    "trigger_event_id": event.id,
                    "trigger_kind": "user_message",
                    "attention_revision": next_revision
                })
                .as_object()
                .unwrap()
                .clone(),
            };
            append_event_in_tx(&mut tx, &restore).await?;
        }
        tx.commit().await?;
        Ok(MessageClaim::Accepted)
    }
}
