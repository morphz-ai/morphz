use super::{
    append_direct_thread_signal_in_tx, append_event_in_tx, now_text, parse_time,
    thread_group::group_from_row, timer_from_row, PostgresStore, StoreError,
};
use crate::event::Event;
use crate::memory::{
    evaluate_thread_group_contract, thread_cancellation_event, thread_group_barrier_event,
    thread_terminal_barrier_event, DeliveryFlushCommit, DeliveryStatus, NewThread,
    ObjectiveWaitCondition, RuntimeTimerRecord, ThreadControlAction, ThreadControlState,
    ThreadGroupStatus, ThreadKind, ThreadLifecycle, ThreadLifetime, ThreadMutation,
    ThreadOutcomeRecord, ThreadRecord, ThreadStore, ThreadSupervision, ThreadSupervisorKind,
};
use chrono::Duration;
use serde_json::{json, Value as JsonValue};
use sqlx::postgres::PgRow;
use sqlx::{PgPool, Postgres, Row, Transaction};

pub(super) async fn migrate(pool: &PgPool) -> Result<(), StoreError> {
    for statement in [
        r#"ALTER TABLE threads ADD COLUMN IF NOT EXISTS generation BIGINT NOT NULL DEFAULT 1"#,
        r#"ALTER TABLE threads ADD COLUMN IF NOT EXISTS control_state TEXT NOT NULL DEFAULT 'active'"#,
        r#"ALTER TABLE threads ADD COLUMN IF NOT EXISTS lifetime TEXT NOT NULL DEFAULT 'durable'"#,
        r#"ALTER TABLE threads ADD COLUMN IF NOT EXISTS supervisor_kind TEXT NOT NULL DEFAULT 'legacy'"#,
        r#"ALTER TABLE threads ADD COLUMN IF NOT EXISTS supervisor_id TEXT"#,
        r#"ALTER TABLE threads ADD COLUMN IF NOT EXISTS supervision_generation BIGINT NOT NULL DEFAULT 1"#,
        r#"ALTER TABLE threads ADD COLUMN IF NOT EXISTS origin_evaluation_id TEXT"#,
        r#"ALTER TABLE threads ADD COLUMN IF NOT EXISTS parent_thread_id TEXT"#,
        r#"ALTER TABLE threads ADD COLUMN IF NOT EXISTS thread_group_id TEXT"#,
        r#"ALTER TABLE threads ADD COLUMN IF NOT EXISTS completion_contract_json JSONB NOT NULL DEFAULT '{}'::jsonb"#,
        r#"UPDATE threads SET kind = 'execution' WHERE kind = 'objective'"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_threads_context_status
           ON threads(context_id, status, updated_at DESC)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_threads_session_delivery
           ON threads(session_id, delivery_status, updated_at, id)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_threads_session_status
           ON threads(session_id, status, updated_at DESC)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_threads_supervisor
           ON threads(supervisor_kind, supervisor_id, status, updated_at DESC)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_threads_group
           ON threads(thread_group_id, status, updated_at DESC)"#,
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

fn parse_control_state(value: &str) -> Result<ThreadControlState, StoreError> {
    match value {
        "active" => Ok(ThreadControlState::Active),
        "paused" => Ok(ThreadControlState::Paused),
        other => Err(format!("未知 Thread control state: {other}").into()),
    }
}

fn parse_lifetime(value: &str) -> Result<ThreadLifetime, StoreError> {
    match value {
        "attached" => Ok(ThreadLifetime::Attached),
        "durable" => Ok(ThreadLifetime::Durable),
        "disposable" => Ok(ThreadLifetime::Disposable),
        other => Err(format!("未知 Thread lifetime: {other}").into()),
    }
}

fn parse_supervisor_kind(value: &str) -> Result<ThreadSupervisorKind, StoreError> {
    match value {
        "thread" => Ok(ThreadSupervisorKind::Thread),
        "evaluation" => Ok(ThreadSupervisorKind::Evaluation),
        "objective" => Ok(ThreadSupervisorKind::Objective),
        "runtime" => Ok(ThreadSupervisorKind::Runtime),
        "none" => Ok(ThreadSupervisorKind::None),
        "legacy" => Ok(ThreadSupervisorKind::Legacy),
        other => Err(format!("未知 Thread supervisor kind: {other}").into()),
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
        generation: u64::try_from(row.get::<i64, _>("generation"))?,
        agent_id: row.get("agent_id"),
        context_id: row.get("context_id"),
        session_id: row.get("session_id"),
        initiating_principal_id: row.get("initiating_principal_id"),
        root_turn_id: row.get("root_turn_id"),
        kind: parse_kind(&row.get::<String, _>("kind"))?,
        lifecycle: parse_lifecycle(&row.get::<String, _>("status"))?,
        control_state: parse_control_state(&row.get::<String, _>("control_state"))?,
        executor_kind: row.get("executor_kind"),
        executor_id: row.get("executor_id"),
        target_id: row.get("target_id"),
        supervision: ThreadSupervision {
            lifetime: parse_lifetime(&row.get::<String, _>("lifetime"))?,
            supervisor_kind: parse_supervisor_kind(&row.get::<String, _>("supervisor_kind"))?,
            supervisor_id: row.get("supervisor_id"),
            generation: u64::try_from(row.get::<i64, _>("supervision_generation"))?,
            origin_evaluation_id: row.get("origin_evaluation_id"),
            parent_thread_id: row.get("parent_thread_id"),
            thread_group_id: row.get("thread_group_id"),
            completion_contract: row.get("completion_contract_json"),
        },
        result_text: row.get("result_text"),
        result_event_id: row.get("result_event_id"),
        delivery_status: parse_delivery(&row.get::<String, _>("delivery_status"))?,
        delivery_event_id: row.get("delivery_event_id"),
        created_at: parse_time(&row.get::<String, _>("created_at"))?,
        updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
    })
}

pub(super) async fn ensure_thread_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    thread: &NewThread,
) -> Result<ThreadRecord, StoreError> {
    thread.supervision.validate(thread.kind)?;
    let now = now_text();
    sqlx::query(
        r#"INSERT INTO threads
           (id, revision, agent_id, context_id, session_id, initiating_principal_id, root_turn_id,
            kind, status, executor_kind, executor_id, target_id,
            lifetime, supervisor_kind, supervisor_id, supervision_generation,
            origin_evaluation_id, parent_thread_id, thread_group_id, completion_contract_json,
            delivery_status, created_at, updated_at)
           VALUES ($1, 1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, $10,
                   $11, $12, $13, $14, $15, $16, $17, $18, 'none', $19, $19)
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
    .bind(thread.supervision.lifetime.as_str())
    .bind(thread.supervision.supervisor_kind.as_str())
    .bind(&thread.supervision.supervisor_id)
    .bind(i64::try_from(thread.supervision.generation)?)
    .bind(&thread.supervision.origin_evaluation_id)
    .bind(&thread.supervision.parent_thread_id)
    .bind(&thread.supervision.thread_group_id)
    .bind(&thread.supervision.completion_contract)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    let row = sqlx::query("SELECT * FROM threads WHERE root_turn_id = $1")
        .bind(&thread.root_turn_id)
        .fetch_one(&mut **tx)
        .await?;
    let existing = thread_from_row(&row)?;
    if existing.context_id != thread.context_id
        || existing.session_id != thread.session_id
        || existing.agent_id != thread.agent_id
        || existing.initiating_principal_id != thread.initiating_principal_id
        || existing.kind != thread.kind
        || existing.supervision != thread.supervision
    {
        return Err(format!(
            "Root Turn '{}' 已被不同 Thread 路由占用",
            thread.root_turn_id
        )
        .into());
    }
    Ok(existing)
}

#[async_trait::async_trait]
impl ThreadStore for PostgresStore {
    async fn ensure_thread(
        &self,
        thread: crate::memory::NewThread,
    ) -> Result<ThreadRecord, StoreError> {
        thread.supervision.validate(thread.kind)?;
        let now = now_text();
        sqlx::query(
            r#"INSERT INTO threads
               (id, revision, agent_id, context_id, session_id, initiating_principal_id, root_turn_id,
                kind, status, executor_kind, executor_id, target_id,
                lifetime, supervisor_kind, supervisor_id, supervision_generation,
                origin_evaluation_id, parent_thread_id, thread_group_id, completion_contract_json,
                delivery_status, created_at, updated_at)
               VALUES ($1, 1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, $10,
                       $11, $12, $13, $14, $15, $16, $17, $18, 'none', $19, $19)
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
        .bind(thread.supervision.lifetime.as_str())
        .bind(thread.supervision.supervisor_kind.as_str())
        .bind(&thread.supervision.supervisor_id)
        .bind(i64::try_from(thread.supervision.generation)?)
        .bind(&thread.supervision.origin_evaluation_id)
        .bind(&thread.supervision.parent_thread_id)
        .bind(&thread.supervision.thread_group_id)
        .bind(&thread.supervision.completion_contract)
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
        if existing.kind != thread.kind || existing.supervision != thread.supervision {
            return Err(format!("Root Turn '{}' 已被不同监督契约占用", thread.root_turn_id).into());
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

    async fn list_open_threads(&self, limit: usize) -> Result<Vec<ThreadRecord>, StoreError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let rows = sqlx::query(
            r#"SELECT *
               FROM threads
               WHERE status NOT IN ('completed', 'failed', 'cancelled')
               ORDER BY updated_at DESC, id
               LIMIT $1"#,
        )
        .bind(i64::try_from(limit)?)
        .fetch_all(&self.pool)
        .await?;
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
        thread: &NewThread,
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
        let thread = ensure_thread_in_tx(&mut tx, thread).await?;
        let inserted = append_event_in_tx(&mut tx, event).await?;
        append_direct_thread_signal_in_tx(&mut tx, event, &thread.id).await?;
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

    async fn control_thread(
        &self,
        id: &str,
        expected_revision: u64,
        action: ThreadControlAction,
        reason: Option<&str>,
        actor: Option<&str>,
    ) -> Result<ThreadMutation, StoreError> {
        let expected_revision = i64::try_from(expected_revision)?;
        if action == ThreadControlAction::Close {
            let mut tx = self.pool.begin().await?;
            let row = sqlx::query("SELECT * FROM threads WHERE id = $1 FOR UPDATE")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?;
            let Some(row) = row else {
                tx.commit().await?;
                return Ok(ThreadMutation::NotFound);
            };
            let current = thread_from_row(&row)?;
            if i64::try_from(current.revision)? != expected_revision
                || current.lifecycle != ThreadLifecycle::Open
            {
                tx.commit().await?;
                return Ok(ThreadMutation::Conflict { current });
            }

            let reason = reason.unwrap_or("Thread 被操作员关闭");
            let actor = actor.unwrap_or("Runtime-Operator");
            let now = now_text();
            let result_event = thread_cancellation_event(&current, reason, actor);
            append_event_in_tx(&mut tx, &result_event).await?;
            let terminal_event_sequence =
                sqlx::query_scalar::<_, i64>("SELECT sequence FROM events WHERE id = $1")
                    .bind(&result_event.id)
                    .fetch_one(&mut *tx)
                    .await?;
            let outcome_id = format!("outcome_{}_g{}", current.id, current.generation);
            let activation_id =
                format!("activation_control_{}_g{}", current.id, current.generation);
            sqlx::query(
                r#"INSERT INTO thread_activations
                   (id, revision, generation, agent_id, context_id, session_id,
                    initiating_principal_id, trigger_event_id, trigger_sequence, trigger_kind,
                    parent_activation_id, root_turn_id, status, claimed_by,
                    created_at, updated_at)
                   VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9,
                           NULL, $10, 'cancelled', NULL, $11, $11)"#,
            )
            .bind(&activation_id)
            .bind(i64::try_from(current.generation)?)
            .bind(&current.agent_id)
            .bind(&current.context_id)
            .bind(&current.session_id)
            .bind(&current.initiating_principal_id)
            .bind(&result_event.id)
            .bind(terminal_event_sequence)
            .bind(&result_event.event_type)
            .bind(&current.root_turn_id)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            // Keep the terminal Thread, its physical Activations and its
            // remaining input Signals consistent under the same row lock and
            // transaction. A late physical result must observe the generation
            // fence instead of leaving a recoverable zombie Activation.
            sqlx::query(
                r#"UPDATE thread_activations
                   SET revision = revision + 1, status = 'cancelled',
                       claimed_by = NULL, lease_expires_at = NULL, updated_at = $1
                   WHERE root_turn_id = $2 AND generation = $3 AND id <> $4
                     AND status IN ('queued', 'running')"#,
            )
            .bind(&now)
            .bind(&current.root_turn_id)
            .bind(i64::try_from(current.generation)?)
            .bind(&activation_id)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                r#"UPDATE thread_signals
                   SET status = 'acknowledged', acknowledged_at = $1
                   WHERE thread_id = $2 AND thread_generation = $3
                     AND status IN ('pending', 'claimed')"#,
            )
            .bind(&now)
            .bind(&current.id)
            .bind(i64::try_from(current.generation)?)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                r#"UPDATE schedules
                   SET revision = revision + 1, status = 'cancelled', updated_at = $1
                   WHERE thread_id = $2 AND status IN ('queued', 'paused')"#,
            )
            .bind(&now)
            .bind(&current.id)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                r#"UPDATE scheduler_dependencies
                   SET status = 'cancelled', updated_at = $1
                   WHERE owner_kind = 'thread' AND owner_id = $2
                     AND owner_generation = $3 AND status = 'pending'"#,
            )
            .bind(&now)
            .bind(&current.id)
            .bind(i64::try_from(current.generation)?)
            .execute(&mut *tx)
            .await?;
            let evidence_refs = serde_json::json!([result_event.id]);
            let unresolved_failures = serde_json::json!([reason]);
            let check_results = serde_json::json!({
                "passed": false,
                "cancelled_by": actor,
                "reason": reason,
            });
            let inserted = sqlx::query(
                r#"INSERT INTO thread_outcomes
                   (thread_id, outcome_id, thread_generation, root_turn_id, activation_id,
                    session_id, terminal_kind, disposition, event_id, summary,
                    artifact_refs_json, evidence_refs_json, check_results_json,
                    unresolved_failures_json, terminal_event_sequence, created_at, delivered_at)
                   VALUES ($1, $2, $3, $4, $5, $6, 'cancelled', 'no_reply', $7, $8,
                           '[]'::jsonb, $9, $10, $11, $12, $13, NULL)
                   ON CONFLICT(root_turn_id) DO NOTHING"#,
            )
            .bind(&current.id)
            .bind(&outcome_id)
            .bind(i64::try_from(current.generation)?)
            .bind(&current.root_turn_id)
            .bind(&activation_id)
            .bind(&current.session_id)
            .bind(&result_event.id)
            .bind(reason)
            .bind(&evidence_refs)
            .bind(&check_results)
            .bind(&unresolved_failures)
            .bind(terminal_event_sequence)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            if inserted.rows_affected() != 1 {
                tx.rollback().await?;
                let current = self
                    .get_thread(id)
                    .await?
                    .ok_or("Thread 关闭冲突后无法读取")?;
                return Ok(ThreadMutation::Conflict { current });
            }
            let updated = sqlx::query(
                r#"UPDATE threads
                   SET revision = revision + 1, generation = generation + 1,
                       control_state = 'active', status = 'cancelled',
                       result_text = $1, result_event_id = $2, updated_at = $3
                   WHERE id = $4 AND revision = $5 AND status = 'open'"#,
            )
            .bind(reason)
            .bind(&result_event.id)
            .bind(&now)
            .bind(id)
            .bind(expected_revision)
            .execute(&mut *tx)
            .await?;
            if updated.rows_affected() != 1 {
                tx.rollback().await?;
                let current = self
                    .get_thread(id)
                    .await?
                    .ok_or("Thread 关闭冲突后无法读取")?;
                return Ok(ThreadMutation::Conflict { current });
            }

            let outcome = ThreadOutcomeRecord {
                id: outcome_id.clone(),
                thread_id: current.id.clone(),
                thread_generation: current.generation,
                root_turn_id: current.root_turn_id.clone(),
                activation_id,
                session_id: current.session_id.clone(),
                terminal_kind: ThreadLifecycle::Cancelled,
                disposition: "no_reply".to_string(),
                summary: Some(reason.to_string()),
                result_event_id: result_event.id.clone(),
                artifact_refs: Vec::new(),
                evidence_refs: vec![result_event.id.clone()],
                check_results: check_results.clone(),
                unresolved_failures: vec![reason.to_string()],
                terminal_event_sequence: Some(u64::try_from(terminal_event_sequence)?),
                created_at: parse_time(&now)?,
                delivered_at: None,
            };

            if let Some(group_id) = current.supervision.thread_group_id.as_deref() {
                let member = sqlx::query(
                    r#"UPDATE thread_group_members
                       SET status = 'cancelled', outcome_id = $1, updated_at = $2
                       WHERE group_id = $3 AND thread_id = $4 AND status = 'pending'"#,
                )
                .bind(&outcome_id)
                .bind(&now)
                .bind(group_id)
                .bind(&current.id)
                .execute(&mut *tx)
                .await?;
                if member.rows_affected() != 1 {
                    return Err(format!(
                        "关闭 Thread '{}' 时无法原子收口 Group '{}' 成员",
                        current.id, group_id
                    )
                    .into());
                }
                let group_row = sqlx::query("SELECT * FROM thread_groups WHERE id = $1 FOR UPDATE")
                    .bind(group_id)
                    .fetch_one(&mut *tx)
                    .await?;
                let group = group_from_row(&group_row)?;
                let counts = sqlx::query(
                    r#"SELECT
                         COALESCE(SUM(CASE WHEN required AND status <> 'pending' THEN 1 ELSE 0 END), 0)::BIGINT
                           AS terminal_count,
                         COALESCE(SUM(CASE WHEN required AND status = 'completed' THEN 1 ELSE 0 END), 0)::BIGINT
                           AS successful_count
                       FROM thread_group_members WHERE group_id = $1"#,
                )
                .bind(group_id)
                .fetch_one(&mut *tx)
                .await?;
                let terminal_count = u64::try_from(counts.get::<i64, _>("terminal_count"))?;
                let successful_count = u64::try_from(counts.get::<i64, _>("successful_count"))?;
                let evaluation = evaluate_thread_group_contract(
                    group.policy,
                    group.required_count,
                    terminal_count,
                    successful_count,
                    &group.completion_contract,
                );
                let next_status = if group.status.is_terminal() {
                    group.status
                } else {
                    evaluation.status
                };
                let transitioned_to_terminal =
                    group.status == ThreadGroupStatus::Open && next_status.is_terminal();
                let terminal_summary = serde_json::json!({
                    "group_id": group.id,
                    "status": next_status.as_str(),
                    "policy": group.policy.as_str(),
                    "required_count": group.required_count,
                    "terminal_count": terminal_count,
                    "successful_count": successful_count,
                    "completion_contract": group.completion_contract,
                    "contract_results": evaluation.contract_results,
                    "last_outcome_id": outcome_id,
                    "last_thread_id": current.id,
                });
                let barrier_id = format!("thread_group_barrier_{}_g{}", group.id, group.generation);
                let barrier_event_id = if group.status.is_terminal() {
                    group.barrier_event_id.as_deref()
                } else if next_status.is_terminal() {
                    Some(barrier_id.as_str())
                } else {
                    None
                };
                let group_update = sqlx::query(
                    r#"UPDATE thread_groups
                       SET revision = revision + 1, terminal_count = $1,
                           successful_count = $2, status = $3,
                           terminal_summary_json = $4, barrier_event_id = $5,
                           updated_at = $6, satisfied_at = COALESCE(satisfied_at, $7)
                       WHERE id = $8"#,
                )
                .bind(i64::try_from(terminal_count)?)
                .bind(i64::try_from(successful_count)?)
                .bind(next_status.as_str())
                .bind(&terminal_summary)
                .bind(barrier_event_id)
                .bind(&now)
                .bind(if next_status.is_terminal() {
                    Some(now.as_str())
                } else {
                    None
                })
                .bind(group_id)
                .execute(&mut *tx)
                .await?;
                if transitioned_to_terminal && group_update.rows_affected() == 1 {
                    let terminal_group_row =
                        sqlx::query("SELECT * FROM thread_groups WHERE id = $1")
                            .bind(group_id)
                            .fetch_one(&mut *tx)
                            .await?;
                    let terminal_group = group_from_row(&terminal_group_row)?;
                    let parent =
                        if let Some(parent_id) = current.supervision.parent_thread_id.as_deref() {
                            sqlx::query("SELECT * FROM threads WHERE id = $1")
                                .bind(parent_id)
                                .fetch_optional(&mut *tx)
                                .await?
                                .as_ref()
                                .map(thread_from_row)
                                .transpose()?
                        } else {
                            None
                        };
                    let barrier = thread_group_barrier_event(&terminal_group, parent.as_ref())?;
                    append_event_in_tx(&mut tx, &barrier).await?;
                    match terminal_group.supervisor_kind {
                        ThreadSupervisorKind::Thread | ThreadSupervisorKind::Evaluation => {
                            let parent = parent
                                .as_ref()
                                .ok_or("attached Thread Group 关闭缺少 parent Thread")?;
                            if parent.lifecycle == ThreadLifecycle::Open {
                                append_direct_thread_signal_in_tx(&mut tx, &barrier, &parent.id)
                                    .await?;
                            }
                        }
                        ThreadSupervisorKind::Objective => {
                            sqlx::query(
                                r#"UPDATE scheduler_dependencies
                                   SET status = 'satisfied', satisfied_by_event_id = $1,
                                       satisfied_at = COALESCE(satisfied_at, $2), updated_at = $2
                                   WHERE dependency_kind = 'thread_group'
                                     AND dependency_id = $3 AND dependency_generation = $4
                                     AND status = 'pending'"#,
                            )
                            .bind(&barrier.id)
                            .bind(&now)
                            .bind(&terminal_group.id)
                            .bind(i64::try_from(terminal_group.generation)?)
                            .execute(&mut *tx)
                            .await?;
                            let legacy_wait =
                                serde_json::to_value(&ObjectiveWaitCondition::ThreadGroup {
                                    group_id: terminal_group.id.clone(),
                                })?;
                            sqlx::query(
                                r#"UPDATE objectives
                                   SET wait_condition_json = NULL, status_reason = NULL,
                                       revision = revision + 1, updated_at = $1
                                   WHERE id = $2 AND wait_condition_json = $3"#,
                            )
                            .bind(&now)
                            .bind(&terminal_group.supervisor_id)
                            .bind(legacy_wait)
                            .execute(&mut *tx)
                            .await?;
                        }
                        ThreadSupervisorKind::Runtime
                        | ThreadSupervisorKind::None
                        | ThreadSupervisorKind::Legacy => {}
                    }
                }
            } else {
                let parent =
                    if let Some(parent_id) = current.supervision.parent_thread_id.as_deref() {
                        sqlx::query("SELECT * FROM threads WHERE id = $1")
                            .bind(parent_id)
                            .fetch_optional(&mut *tx)
                            .await?
                            .as_ref()
                            .map(thread_from_row)
                            .transpose()?
                    } else {
                        None
                    };
                if let Some(barrier) =
                    thread_terminal_barrier_event(&current, &outcome, parent.as_ref())?
                {
                    append_event_in_tx(&mut tx, &barrier).await?;
                    if matches!(
                        current.supervision.supervisor_kind,
                        ThreadSupervisorKind::Thread | ThreadSupervisorKind::Evaluation
                    ) {
                        let parent = parent
                            .as_ref()
                            .ok_or("attached Thread 关闭缺少 parent Thread")?;
                        if parent.lifecycle == ThreadLifecycle::Open {
                            append_direct_thread_signal_in_tx(&mut tx, &barrier, &parent.id)
                                .await?;
                        }
                    }
                }
            }
            tx.commit().await?;
            return Ok(ThreadMutation::Updated(
                self.get_thread(id).await?.ok_or("Thread 关闭后无法读取")?,
            ));
        }
        let (control_state, lifecycle, generation_delta, predicate) = match action {
            ThreadControlAction::Pause => ("paused", "open", 0_i64, "control_state = 'active'"),
            ThreadControlAction::Resume => ("active", "open", 0_i64, "control_state = 'paused'"),
            ThreadControlAction::Close => unreachable!("Close 已由终态事务处理"),
        };
        let result = sqlx::query(&format!(
            "UPDATE threads SET revision = revision + 1, generation = generation + $1, control_state = $2, status = $3, updated_at = $4 WHERE id = $5 AND revision = $6 AND status = 'open' AND {predicate}"
        ))
        .bind(generation_delta)
        .bind(control_state)
        .bind(lifecycle)
        .bind(now_text())
        .bind(id)
        .bind(expected_revision)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 1 {
            return Ok(ThreadMutation::Updated(
                self.get_thread(id).await?.ok_or("Thread 控制后无法读取")?,
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
