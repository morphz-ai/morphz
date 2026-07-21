use super::{
    append_event_in_tx, append_signal_outbox_in_tx, now_text, parse_time, timer_from_row,
    PostgresStore, StoreError,
};
use crate::event::Event;
use crate::memory::{
    DeliveryFlushCommit, DeliveryStatus, RuntimeTimerRecord, ThreadKind, ThreadLifecycle,
    ThreadMutation, ThreadRecord, ThreadStore,
};
use chrono::Duration;
use serde_json::{json, Value as JsonValue};
use sqlx::postgres::PgRow;
use sqlx::{PgPool, Row};

pub(super) async fn migrate(pool: &PgPool) -> Result<(), StoreError> {
    for statement in [
        r#"CREATE INDEX IF NOT EXISTS idx_pg_threads_context_status
           ON threads(context_id, status, updated_at DESC)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_threads_session_delivery
           ON threads(session_id, delivery_status, updated_at, id)"#,
        r#"ALTER TABLE signal_outbox ADD COLUMN IF NOT EXISTS signal_id TEXT"#,
        r#"ALTER TABLE signal_outbox ADD COLUMN IF NOT EXISTS resolved_at TEXT"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_signal_outbox_status_created
           ON signal_outbox(status, created_at, event_id)"#,
    ] {
        sqlx::query(statement).execute(pool).await?;
    }
    Ok(())
}

fn parse_kind(value: &str) -> Result<ThreadKind, StoreError> {
    match value {
        "dialogue_turn" => Ok(ThreadKind::DialogueTurn),
        "execution" => Ok(ThreadKind::Execution),
        "objective" => Ok(ThreadKind::Objective),
        "delivery" => Ok(ThreadKind::Delivery),
        other => Err(format!("未知 Thread kind: {other}").into()),
    }
}

fn parse_lifecycle(value: &str) -> Result<ThreadLifecycle, StoreError> {
    match value {
        "open" => Ok(ThreadLifecycle::Open),
        "completed" => Ok(ThreadLifecycle::Completed),
        "failed" => Ok(ThreadLifecycle::Failed),
        "cancelled" => Ok(ThreadLifecycle::Cancelled),
        other => Err(format!("未知 Thread lifecycle: {other}").into()),
    }
}

fn parse_delivery(value: &str) -> Result<DeliveryStatus, StoreError> {
    match value {
        "none" => Ok(DeliveryStatus::None),
        "pending" => Ok(DeliveryStatus::Pending),
        "deferred" => Ok(DeliveryStatus::Deferred),
        "delivered" => Ok(DeliveryStatus::Delivered),
        other => Err(format!("未知 Thread delivery status: {other}").into()),
    }
}

pub(super) fn thread_from_row(row: &PgRow) -> Result<ThreadRecord, StoreError> {
    Ok(ThreadRecord {
        id: row.get("id"),
        revision: u64::try_from(row.get::<i64, _>("revision"))?,
        agent_id: row.get("agent_id"),
        context_id: row.get("context_id"),
        session_id: row.get("session_id"),
        initiating_principal_id: row.get("initiating_principal_id"),
        root_turn_id: row.get("root_turn_id"),
        kind: parse_kind(&row.get::<String, _>("kind"))?,
        lifecycle: parse_lifecycle(&row.get::<String, _>("status"))?,
        executor_kind: row.get("executor_kind"),
        executor_id: row.get("executor_id"),
        target_id: row.get("target_id"),
        result_text: row.get("result_text"),
        result_event_id: row.get("result_event_id"),
        delivery_status: parse_delivery(&row.get::<String, _>("delivery_status"))?,
        delivery_event_id: row.get("delivery_event_id"),
        created_at: parse_time(&row.get::<String, _>("created_at"))?,
        updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
    })
}

#[async_trait::async_trait]
impl ThreadStore for PostgresStore {
    async fn ensure_thread(
        &self,
        thread: crate::memory::NewThread,
    ) -> Result<ThreadRecord, StoreError> {
        let now = now_text();
        sqlx::query(
            r#"INSERT INTO threads
               (id, revision, agent_id, context_id, session_id, initiating_principal_id, root_turn_id,
                kind, status, executor_kind, executor_id, target_id, delivery_status,
                created_at, updated_at)
               VALUES ($1, 1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, $10, 'none', $11, $11)
               ON CONFLICT DO NOTHING"#,
        )
        .bind(&thread.id)
        .bind(&thread.agent_id)
        .bind(&thread.context_id)
        .bind(&thread.session_id)
        .bind(&thread.initiating_principal_id)
        .bind(&thread.root_turn_id)
        .bind(thread.kind.as_str())
        .bind(&thread.executor_kind)
        .bind(&thread.executor_id)
        .bind(&thread.target_id)
        .bind(now)
        .execute(&self.pool)
        .await?;
        let mut existing = self
            .get_thread_by_root(&thread.root_turn_id)
            .await?
            .ok_or("Thread 并发创建后无法读取")?;
        if existing.initiating_principal_id.is_none() && thread.initiating_principal_id.is_some() {
            sqlx::query(
                "UPDATE threads SET initiating_principal_id = $1 WHERE id = $2 AND initiating_principal_id IS NULL",
            )
            .bind(&thread.initiating_principal_id)
            .bind(&existing.id)
            .execute(&self.pool)
            .await?;
            existing = self
                .get_thread(&existing.id)
                .await?
                .ok_or("Thread Principal 迁移后无法读取")?;
        }
        if existing.context_id != thread.context_id
            || existing.session_id != thread.session_id
            || existing.agent_id != thread.agent_id
        {
            return Err(format!("Root Turn '{}' 已被不同 Thread 占用", thread.root_turn_id).into());
        }
        if thread.initiating_principal_id.is_some()
            && existing.initiating_principal_id != thread.initiating_principal_id
        {
            return Err(format!(
                "Root Turn '{}' 的 initiating Principal 不一致",
                thread.root_turn_id
            )
            .into());
        }
        Ok(existing)
    }

    async fn get_thread(&self, id: &str) -> Result<Option<ThreadRecord>, StoreError> {
        sqlx::query("SELECT * FROM threads WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(thread_from_row)
            .transpose()
    }

    async fn get_thread_by_root(
        &self,
        root_turn_id: &str,
    ) -> Result<Option<ThreadRecord>, StoreError> {
        sqlx::query("SELECT * FROM threads WHERE root_turn_id = $1")
            .bind(root_turn_id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(thread_from_row)
            .transpose()
    }

    async fn list_context_threads(
        &self,
        context_id: &str,
        include_terminal: bool,
    ) -> Result<Vec<ThreadRecord>, StoreError> {
        let rows = if include_terminal {
            sqlx::query("SELECT * FROM threads WHERE context_id = $1 ORDER BY created_at, id")
                .bind(context_id)
                .fetch_all(&self.pool)
                .await?
        } else {
            sqlx::query(
                r#"SELECT * FROM threads WHERE context_id = $1
                   AND status NOT IN ('completed', 'failed', 'cancelled')
                   ORDER BY created_at, id"#,
            )
            .bind(context_id)
            .fetch_all(&self.pool)
            .await?
        };
        rows.iter().map(thread_from_row).collect()
    }

    async fn list_session_delivery_threads(
        &self,
        session_id: &str,
        include_deferred: bool,
    ) -> Result<Vec<ThreadRecord>, StoreError> {
        let rows = if include_deferred {
            sqlx::query(
                r#"SELECT * FROM threads WHERE session_id = $1
                   AND delivery_status IN ('pending', 'deferred') ORDER BY updated_at, id"#,
            )
            .bind(session_id)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                r#"SELECT * FROM threads WHERE session_id = $1
                   AND delivery_status = 'pending' ORDER BY updated_at, id"#,
            )
            .bind(session_id)
            .fetch_all(&self.pool)
            .await?
        };
        rows.iter().map(thread_from_row).collect()
    }

    async fn list_pending_delivery_sessions(&self) -> Result<Vec<String>, StoreError> {
        Ok(sqlx::query_scalar::<_, String>(
            r#"SELECT DISTINCT pending.session_id
               FROM threads AS pending
               WHERE pending.delivery_status = 'pending'
                 AND NOT EXISTS (
                   SELECT 1 FROM signal_outbox AS outbox
                   JOIN events AS event ON event.id = outbox.event_id
                   WHERE event.session_id = pending.session_id
                     AND event.topic = 'chat/thread_completion_ready'
                     AND outbox.status = 'pending'
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM threads AS delivery
                   WHERE delivery.session_id = pending.session_id
                     AND delivery.kind = 'delivery'
                     AND delivery.status NOT IN ('completed', 'failed', 'cancelled')
                 )
               ORDER BY pending.session_id"#,
        )
        .fetch_all(&self.pool)
        .await?)
    }

    async fn arm_delivery_flush_timer(
        &self,
        timer_id: &str,
        session_id: &str,
        merge_window_secs: u64,
        max_wait_secs: u64,
    ) -> Result<Option<RuntimeTimerRecord>, StoreError> {
        if timer_id.trim().is_empty() || session_id.trim().is_empty() {
            return Err("Delivery Flush timer_id/session_id 不能为空".into());
        }
        if merge_window_secs == 0 || max_wait_secs == 0 {
            return Err("Delivery Flush merge_window/max_wait 必须大于 0".into());
        }
        let merge_window = Duration::seconds(i64::try_from(merge_window_secs)?);
        let max_wait = Duration::seconds(i64::try_from(max_wait_secs)?);
        let mut tx = self.pool.begin().await?;
        let locked =
            sqlx::query_scalar::<_, String>("SELECT id FROM sessions WHERE id = $1 FOR UPDATE")
                .bind(session_id)
                .fetch_optional(&mut *tx)
                .await?;
        if locked.is_none() {
            return Err(format!("Delivery Flush Session '{session_id}' 不存在").into());
        }
        let aggregate = sqlx::query(
            r#"SELECT MIN(updated_at) AS first_pending_at,
                      MAX(updated_at) AS latest_pending_at
               FROM threads WHERE session_id = $1 AND delivery_status = 'pending'"#,
        )
        .bind(session_id)
        .fetch_one(&mut *tx)
        .await?;
        let Some(first_pending_at) = aggregate.get::<Option<String>, _>("first_pending_at") else {
            tx.commit().await?;
            return Ok(None);
        };
        let latest_pending_at = aggregate
            .get::<Option<String>, _>("latest_pending_at")
            .ok_or("Delivery Flush pending aggregate 缺少 latest_pending_at")?;
        let first_pending = parse_time(&first_pending_at)?;
        let latest_pending = parse_time(&latest_pending_at)?;
        let due_at = std::cmp::min(latest_pending + merge_window, first_pending + max_wait);
        let delivery_rows = sqlx::query(
            r#"SELECT id, result_event_id FROM threads WHERE session_id = $1
               AND delivery_status IN ('pending', 'deferred') ORDER BY updated_at, id"#,
        )
        .bind(session_id)
        .fetch_all(&mut *tx)
        .await?;
        let completed_thread_ids = delivery_rows
            .iter()
            .map(|row| row.get::<String, _>("id"))
            .collect::<Vec<_>>();
        let result_event_ids = delivery_rows
            .iter()
            .filter_map(|row| row.get::<Option<String>, _>("result_event_id"))
            .collect::<Vec<_>>();
        let current_generation = sqlx::query_scalar::<_, i64>(
            "SELECT generation FROM runtime_timers WHERE id = $1 FOR UPDATE",
        )
        .bind(timer_id)
        .fetch_optional(&mut *tx)
        .await?
        .unwrap_or(0);
        let generation = current_generation
            .checked_add(1)
            .ok_or("Delivery Flush generation 溢出")?;
        let now = now_text();
        let payload = json!({
            "session_id": session_id,
            "first_pending_at": first_pending_at,
            "latest_pending_at": latest_pending_at,
            "merge_window_secs": merge_window_secs,
            "max_wait_secs": max_wait_secs,
            "completed_thread_ids": completed_thread_ids,
            "result_event_ids": result_event_ids,
        });
        sqlx::query(
            r#"INSERT INTO runtime_timers
               (id, generation, kind, owner_id, due_at, status, payload_json,
                created_at, updated_at)
               VALUES ($1, $2, 'delivery_flush', $3, $4, 'pending', $5, $6, $6)
               ON CONFLICT(id) DO UPDATE SET
                 generation = EXCLUDED.generation, kind = 'delivery_flush',
                 owner_id = EXCLUDED.owner_id, due_at = EXCLUDED.due_at,
                 status = 'pending', payload_json = EXCLUDED.payload_json,
                 claimed_by = NULL, claim_expires_at = NULL, last_error = NULL,
                 updated_at = EXCLUDED.updated_at, fired_at = NULL"#,
        )
        .bind(timer_id)
        .bind(generation)
        .bind(session_id)
        .bind(due_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
        .bind(payload)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        let row = sqlx::query("SELECT * FROM runtime_timers WHERE id = $1")
            .bind(timer_id)
            .fetch_one(&mut *tx)
            .await?;
        let timer = timer_from_row(&row)?;
        tx.commit().await?;
        Ok(Some(timer))
    }

    async fn commit_delivery_flush(
        &self,
        timer_id: &str,
        generation: u64,
        event: &Event,
    ) -> Result<DeliveryFlushCommit, StoreError> {
        if event.topic != "chat/thread_completion_ready" {
            return Err("Delivery Flush 只能提交 chat/thread_completion_ready Event".into());
        }
        let session_id = event
            .payload
            .get("session_id")
            .and_then(JsonValue::as_str)
            .ok_or("Delivery Flush Event 缺少 session_id")?;
        let generation = i64::try_from(generation)?;
        let mut tx = self.pool.begin().await?;
        let timer = sqlx::query(
            r#"SELECT generation, kind, owner_id, status FROM runtime_timers
               WHERE id = $1 FOR UPDATE"#,
        )
        .bind(timer_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(timer) = timer else {
            tx.commit().await?;
            return Ok(DeliveryFlushCommit::Stale);
        };
        if timer.get::<i64, _>("generation") != generation
            || timer.get::<String, _>("kind") != "delivery_flush"
            || timer.get::<String, _>("owner_id") != session_id
            || timer.get::<String, _>("status") != "claimed"
        {
            tx.commit().await?;
            return Ok(DeliveryFlushCommit::Stale);
        }
        let has_pending = sqlx::query_scalar::<_, bool>(
            r#"SELECT EXISTS(SELECT 1 FROM threads
               WHERE session_id = $1 AND delivery_status = 'pending')"#,
        )
        .bind(session_id)
        .fetch_one(&mut *tx)
        .await?;
        if !has_pending {
            tx.commit().await?;
            return Ok(DeliveryFlushCommit::Empty);
        }
        let inserted = append_event_in_tx(&mut tx, event).await?;
        append_signal_outbox_in_tx(&mut tx, event).await?;
        tx.commit().await?;
        Ok(if inserted {
            DeliveryFlushCommit::Committed
        } else {
            DeliveryFlushCommit::Existing {
                event_id: event.id.clone(),
            }
        })
    }

    async fn commit_delivery_flush_reply(
        &self,
        timer_id: &str,
        generation: u64,
        event: &Event,
    ) -> Result<DeliveryFlushCommit, StoreError> {
        if event.topic != "chat/reply" {
            return Err("Delivery Fast Path 只能提交 chat/reply Event".into());
        }
        let session_id = event
            .payload
            .get("session_id")
            .and_then(JsonValue::as_str)
            .ok_or("Delivery Fast Path Event 缺少 session_id")?;
        let covers = event
            .payload
            .get("covers")
            .and_then(JsonValue::as_array)
            .ok_or("Delivery Fast Path Event 缺少 covers")?
            .iter()
            .filter_map(JsonValue::as_str)
            .collect::<Vec<_>>();
        if covers.is_empty() {
            return Err("Delivery Fast Path 至少覆盖一个 Thread".into());
        }
        let generation = i64::try_from(generation)?;
        let mut tx = self.pool.begin().await?;
        let timer = sqlx::query(
            r#"SELECT generation, kind, owner_id, status FROM runtime_timers
               WHERE id = $1 FOR UPDATE"#,
        )
        .bind(timer_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(timer) = timer else {
            tx.commit().await?;
            return Ok(DeliveryFlushCommit::Stale);
        };
        if timer.get::<i64, _>("generation") != generation
            || timer.get::<String, _>("kind") != "delivery_flush"
            || timer.get::<String, _>("owner_id") != session_id
            || timer.get::<String, _>("status") != "claimed"
        {
            tx.commit().await?;
            return Ok(DeliveryFlushCommit::Stale);
        }
        if sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM events WHERE id = $1)")
            .bind(&event.id)
            .fetch_one(&mut *tx)
            .await?
        {
            tx.commit().await?;
            return Ok(DeliveryFlushCommit::Existing {
                event_id: event.id.clone(),
            });
        }
        let now = now_text();
        for thread_id in covers {
            let updated = sqlx::query(
                r#"UPDATE threads SET revision = revision + 1,
                   delivery_status = 'delivered', delivery_event_id = $1, updated_at = $2
                   WHERE id = $3 AND session_id = $4
                     AND delivery_status IN ('pending', 'deferred')"#,
            )
            .bind(&event.id)
            .bind(&now)
            .bind(thread_id)
            .bind(session_id)
            .execute(&mut *tx)
            .await?;
            if updated.rows_affected() != 1 {
                tx.rollback().await?;
                return Ok(DeliveryFlushCommit::Stale);
            }
        }
        append_event_in_tx(&mut tx, event).await?;
        let activity_at = event
            .timestamp
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query("UPDATE sessions SET updated_at = $1, last_activity_at = $1 WHERE id = $2")
            .bind(activity_at)
            .bind(session_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(DeliveryFlushCommit::Committed)
    }

    #[allow(clippy::too_many_arguments)]
    async fn update_thread(
        &self,
        id: &str,
        expected_revision: u64,
        kind: Option<ThreadKind>,
        lifecycle: Option<ThreadLifecycle>,
        result_text: Option<&str>,
        result_event_id: Option<&str>,
        delivery_status: Option<DeliveryStatus>,
        delivery_event_id: Option<&str>,
    ) -> Result<ThreadMutation, StoreError> {
        let expected_revision = i64::try_from(expected_revision)?;
        let result = sqlx::query(
            r#"UPDATE threads SET revision = revision + 1,
               kind = COALESCE($1, kind), status = COALESCE($2, status),
               result_text = COALESCE($3, result_text),
               result_event_id = COALESCE($4, result_event_id),
               delivery_status = COALESCE($5, delivery_status),
               delivery_event_id = COALESCE($6, delivery_event_id), updated_at = $7
               WHERE id = $8 AND revision = $9"#,
        )
        .bind(kind.map(ThreadKind::as_str))
        .bind(lifecycle.map(ThreadLifecycle::as_str))
        .bind(result_text)
        .bind(result_event_id)
        .bind(delivery_status.map(DeliveryStatus::as_str))
        .bind(delivery_event_id)
        .bind(now_text())
        .bind(id)
        .bind(expected_revision)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 1 {
            return Ok(ThreadMutation::Updated(
                self.get_thread(id).await?.ok_or("Thread 更新后无法读取")?,
            ));
        }
        Ok(match self.get_thread(id).await? {
            Some(current) => ThreadMutation::Conflict { current },
            None => ThreadMutation::NotFound,
        })
    }

    async fn bind_thread_target(
        &self,
        id: &str,
        expected_revision: u64,
        target_id: &str,
    ) -> Result<ThreadMutation, StoreError> {
        let expected_revision = i64::try_from(expected_revision)?;
        let result = sqlx::query(
            r#"UPDATE threads SET revision = revision + 1,
               target_id = $1, updated_at = $2
               WHERE id = $3 AND revision = $4
                 AND (target_id IS NULL OR target_id = $1)"#,
        )
        .bind(target_id)
        .bind(now_text())
        .bind(id)
        .bind(expected_revision)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 1 {
            return Ok(ThreadMutation::Updated(
                self.get_thread(id)
                    .await?
                    .ok_or("Thread Target 绑定后无法读取")?,
            ));
        }
        Ok(match self.get_thread(id).await? {
            Some(current) => ThreadMutation::Conflict { current },
            None => ThreadMutation::NotFound,
        })
    }
}
