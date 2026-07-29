use super::{
    append_event_in_tx, append_signal_outbox_in_tx, now_text, parse_time, stored_event_in_tx,
    thread::thread_from_row, PostgresStore, StoreError,
};
use crate::admission::AdmissionClass;
use crate::event::Event;
use crate::memory::{
    ActivationOutcomeCommit, ActivationStore, DialogueTurnRetryMutation, DialogueTurnRetryRequest,
    NewThreadActivation, NewThreadSignal, SessionAttentionUpdate, SignalOutboxRecord,
    SignalOutboxStatus, ThreadActivationMutation, ThreadActivationRecord, ThreadActivationStatus,
    ThreadKind, ThreadLifecycle, ThreadSignalRecord, ThreadSignalStatus,
};
use chrono::{DateTime, Utc};
use serde_json::Value as JsonValue;
use sqlx::postgres::PgRow;
use sqlx::{PgPool, Row};

pub(super) async fn migrate(pool: &PgPool) -> Result<(), StoreError> {
    for statement in [
        r#"ALTER TABLE threads ADD COLUMN IF NOT EXISTS generation BIGINT NOT NULL DEFAULT 1"#,
        r#"ALTER TABLE thread_activations ADD COLUMN IF NOT EXISTS generation BIGINT NOT NULL DEFAULT 1"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_thread_activations_session_status
           ON thread_activations(session_id, status, updated_at DESC)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_thread_activations_context_status
           ON thread_activations(context_id, status, updated_at DESC)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_thread_activations_lease
           ON thread_activations(status, lease_expires_at)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_thread_activations_root_turn
           ON thread_activations(root_turn_id, updated_at)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_thread_activations_root_generation_status
           ON thread_activations(root_turn_id, generation, status, updated_at)"#,
        r#"CREATE TABLE IF NOT EXISTS thread_signals (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
            event_id TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
            principal_id TEXT,
            sequence BIGINT NOT NULL,
            kind TEXT NOT NULL,
            parent_activation_id TEXT REFERENCES thread_activations(id),
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            claimed_at TEXT,
            acknowledged_at TEXT
        )"#,
        r#"ALTER TABLE thread_signals ADD COLUMN IF NOT EXISTS principal_id TEXT"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_thread_signals_thread_status_sequence
           ON thread_signals(thread_id, status, sequence, id)"#,
        r#"CREATE TABLE IF NOT EXISTS activation_signals (
            activation_id TEXT NOT NULL REFERENCES thread_activations(id) ON DELETE CASCADE,
            signal_id TEXT NOT NULL UNIQUE REFERENCES thread_signals(id) ON DELETE CASCADE,
            ordinal BIGINT NOT NULL,
            PRIMARY KEY(activation_id, ordinal)
        )"#,
        r#"CREATE TABLE IF NOT EXISTS thread_outcomes (
            thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
            root_turn_id TEXT NOT NULL UNIQUE,
            activation_id TEXT NOT NULL REFERENCES thread_activations(id) ON DELETE CASCADE,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            disposition TEXT NOT NULL,
            event_id TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL
        )"#,
        r#"CREATE TABLE IF NOT EXISTS evaluation_outcomes (
            activation_id TEXT PRIMARY KEY REFERENCES thread_activations(id) ON DELETE CASCADE,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            disposition TEXT NOT NULL,
            event_id TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL
        )"#,
    ] {
        sqlx::query(statement).execute(pool).await?;
    }
    Ok(())
}

fn parse_activation_status(value: &str) -> Result<ThreadActivationStatus, StoreError> {
    match value {
        "queued" => Ok(ThreadActivationStatus::Queued),
        "running" => Ok(ThreadActivationStatus::Running),
        "waiting_tool" | "waiting_external" | "completed" | "succeeded" => {
            Ok(ThreadActivationStatus::Succeeded)
        }
        "cancelled" => Ok(ThreadActivationStatus::Cancelled),
        "failed" => Ok(ThreadActivationStatus::Failed),
        other => Err(format!("未知 Thread Activation 状态：'{other}'").into()),
    }
}

fn activation_status_storage(status: ThreadActivationStatus) -> &'static str {
    match status {
        ThreadActivationStatus::Queued => "queued",
        ThreadActivationStatus::Running => "running",
        ThreadActivationStatus::Succeeded => "completed",
        ThreadActivationStatus::Cancelled => "cancelled",
        ThreadActivationStatus::Failed => "failed",
    }
}

fn parse_signal_status(value: &str) -> Result<ThreadSignalStatus, StoreError> {
    match value {
        "pending" => Ok(ThreadSignalStatus::Pending),
        "claimed" => Ok(ThreadSignalStatus::Claimed),
        "acknowledged" => Ok(ThreadSignalStatus::Acknowledged),
        other => Err(format!("未知 Thread Signal 状态：'{other}'").into()),
    }
}

pub(super) fn activation_from_row(row: &PgRow) -> Result<ThreadActivationRecord, StoreError> {
    Ok(ThreadActivationRecord {
        id: row.get("id"),
        revision: u64::try_from(row.get::<i64, _>("revision"))?,
        generation: u64::try_from(row.get::<i64, _>("generation"))?,
        agent_id: row.get("agent_id"),
        context_id: row.get("context_id"),
        session_id: row.get("session_id"),
        initiating_principal_id: row.get("initiating_principal_id"),
        trigger_event_id: row.get("trigger_event_id"),
        trigger_sequence: u64::try_from(row.get::<i64, _>("trigger_sequence"))?,
        trigger_kind: row.get("trigger_kind"),
        parent_activation_id: row.get("parent_activation_id"),
        root_turn_id: row.get("root_turn_id"),
        context_snapshot_version: row
            .get::<Option<i64>, _>("context_snapshot_version")
            .map(u64::try_from)
            .transpose()?,
        status: parse_activation_status(&row.get::<String, _>("status"))?,
        claimed_by: row.get("claimed_by"),
        lease_expires_at: row
            .get::<Option<String>, _>("lease_expires_at")
            .as_deref()
            .map(parse_time)
            .transpose()?,
        created_at: parse_time(&row.get::<String, _>("created_at"))?,
        updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
    })
}

fn signal_from_row(row: &PgRow) -> Result<ThreadSignalRecord, StoreError> {
    Ok(ThreadSignalRecord {
        id: row.get("id"),
        thread_id: row.get("thread_id"),
        event_id: row.get("event_id"),
        principal_id: row.get("principal_id"),
        sequence: u64::try_from(row.get::<i64, _>("sequence"))?,
        kind: row.get("kind"),
        parent_activation_id: row.get("parent_activation_id"),
        status: parse_signal_status(&row.get::<String, _>("status"))?,
        created_at: parse_time(&row.get::<String, _>("created_at"))?,
        claimed_at: row
            .get::<Option<String>, _>("claimed_at")
            .as_deref()
            .map(parse_time)
            .transpose()?,
        acknowledged_at: row
            .get::<Option<String>, _>("acknowledged_at")
            .as_deref()
            .map(parse_time)
            .transpose()?,
    })
}

fn outbox_from_row(row: &PgRow) -> Result<SignalOutboxRecord, StoreError> {
    let status = match row.get::<String, _>("status").as_str() {
        "pending" => SignalOutboxStatus::Pending,
        "materialized" => SignalOutboxStatus::Materialized,
        "discarded" => SignalOutboxStatus::Discarded,
        other => return Err(format!("未知 Signal Outbox 状态: {other}").into()),
    };
    Ok(SignalOutboxRecord {
        event_id: row.get("event_id"),
        status,
        signal_id: row.get("signal_id"),
        created_at: parse_time(&row.get::<String, _>("created_at"))?,
        resolved_at: row
            .get::<Option<String>, _>("resolved_at")
            .as_deref()
            .map(parse_time)
            .transpose()?,
    })
}

#[async_trait::async_trait]
impl ActivationStore for PostgresStore {
    async fn commit_context_transaction(
        &self,
        event: &Event,
        attention_updates: &[SessionAttentionUpdate],
    ) -> Result<(), StoreError> {
        let mut tx = self.pool.begin().await?;
        for update in attention_updates {
            let result = sqlx::query(
                r#"UPDATE sessions SET attention_state = $1,
                   attention_revision = attention_revision + 1, attention_reason = $2,
                   attention_changed_at = $3, attention_event_id = $4
                   WHERE id = $5 AND context_id = $6 AND attention_revision = $7"#,
            )
            .bind(update.state.as_str())
            .bind(&update.reason)
            .bind(
                update
                    .changed_at
                    .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
            )
            .bind(&update.event_id)
            .bind(&update.session_id)
            .bind(&update.context_id)
            .bind(i64::try_from(update.expected_revision)?)
            .execute(&mut *tx)
            .await?;
            if result.rows_affected() != 1 {
                return Err(format!(
                    "Session '{}' attention revision 冲突或 Context mount 不存在",
                    update.session_id
                )
                .into());
            }
        }
        append_event_in_tx(&mut tx, event).await?;
        tx.commit().await?;
        Ok(())
    }

    async fn claim_thread_signal_batch(
        &self,
        mut signal: NewThreadSignal,
        activation: NewThreadActivation,
        max_signals: usize,
    ) -> Result<Option<ThreadActivationRecord>, StoreError> {
        if max_signals == 0 {
            return Err("Thread Signal batch 上限必须大于 0".into());
        }
        let max_signals = i64::try_from(max_signals)?;
        let now = now_text();
        let mut tx = self.pool.begin().await?;
        let candidate_thread_id = signal.thread_id.clone();
        if signal.kind == "chat/user_message" {
            // Lock the Session, rather than one candidate Thread, because the
            // dialogue lane is shared by every consecutive user input in that
            // Session and by every Runtime worker.
            sqlx::query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE")
                .bind(&activation.session_id)
                .fetch_one(&mut *tx)
                .await?;
        }
        let preexisting_signal_thread: Option<String> =
            sqlx::query_scalar("SELECT thread_id FROM thread_signals WHERE event_id = $1")
                .bind(&signal.event_id)
                .fetch_optional(&mut *tx)
                .await?;
        if let Some(thread_id) = preexisting_signal_thread.as_ref() {
            signal.thread_id = thread_id.clone();
        }
        let candidate_thread = sqlx::query("SELECT * FROM threads WHERE id = $1")
            .bind(&signal.thread_id)
            .fetch_one(&mut *tx)
            .await?;
        let candidate_thread = thread_from_row(&candidate_thread)?;
        let mut joined_dialogue_activation = None;
        if preexisting_signal_thread.is_none()
            && signal.kind == "chat/user_message"
            && candidate_thread.kind == ThreadKind::DialogueTurn
        {
            if let Some(row) = sqlx::query(
                r#"SELECT queued.*, thread.id AS routed_thread_id
                   FROM thread_activations queued
                   JOIN threads thread
                     ON thread.root_turn_id = queued.root_turn_id
                    AND thread.generation = queued.generation
                   WHERE queued.session_id = $1
                     AND queued.status = 'queued'
                     AND queued.trigger_kind = 'chat/user_message'
                     AND thread.kind = 'dialogue_turn'
                     AND thread.status = 'open'
                     AND thread.control_state = 'active'
                     AND (
                       SELECT COUNT(*)
                       FROM activation_signals links
                       WHERE links.activation_id = queued.id
                     ) < $2
                     AND queued.initiating_principal_id IS NOT DISTINCT FROM $3
                   ORDER BY queued.trigger_sequence, queued.id
                   LIMIT 1
                   FOR UPDATE OF queued, thread"#,
            )
            .bind(&activation.session_id)
            .bind(max_signals)
            .bind(&signal.principal_id)
            .fetch_optional(&mut *tx)
            .await?
            {
                signal.thread_id = row.get("routed_thread_id");
                joined_dialogue_activation = Some(activation_from_row(&row)?);
            }
        }
        sqlx::query(
            r#"INSERT INTO thread_signals
               (id, thread_id, event_id, principal_id, sequence, kind, parent_activation_id,
                status, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
               ON CONFLICT DO NOTHING"#,
        )
        .bind(&signal.id)
        .bind(&signal.thread_id)
        .bind(&signal.event_id)
        .bind(&signal.principal_id)
        .bind(i64::try_from(signal.sequence)?)
        .bind(&signal.kind)
        .bind(&signal.parent_activation_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        let stored_signal = sqlx::query("SELECT * FROM thread_signals WHERE event_id = $1")
            .bind(&signal.event_id)
            .fetch_one(&mut *tx)
            .await?;
        let mut stored_signal = signal_from_row(&stored_signal)?;
        if stored_signal.principal_id.is_none() && signal.principal_id.is_some() {
            sqlx::query(
                "UPDATE thread_signals SET principal_id = $1 WHERE id = $2 AND principal_id IS NULL",
            )
            .bind(&signal.principal_id)
            .bind(&stored_signal.id)
            .execute(&mut *tx)
            .await?;
            stored_signal.principal_id =
                sqlx::query_scalar("SELECT principal_id FROM thread_signals WHERE id = $1")
                    .bind(&stored_signal.id)
                    .fetch_one(&mut *tx)
                    .await?;
        }
        if stored_signal.thread_id != signal.thread_id {
            return Err(format!("Event '{}' 已路由到不同 Thread Signal", signal.event_id).into());
        }
        if signal.principal_id.is_some() && stored_signal.principal_id != signal.principal_id {
            return Err(format!(
                "Event '{}' 的 Thread Signal Principal 不一致",
                signal.event_id
            )
            .into());
        }
        if let Some(outbox) =
            sqlx::query("SELECT * FROM signal_outbox WHERE event_id = $1 FOR UPDATE")
                .bind(&stored_signal.event_id)
                .fetch_optional(&mut *tx)
                .await?
        {
            let outbox = outbox_from_row(&outbox)?;
            if outbox.status == SignalOutboxStatus::Materialized
                && outbox.signal_id.as_deref() != Some(stored_signal.id.as_str())
            {
                return Err(format!(
                    "Signal Outbox Event '{}' 已物化为不同 Signal",
                    stored_signal.event_id
                )
                .into());
            }
            sqlx::query(
                r#"UPDATE signal_outbox SET status = 'materialized', signal_id = $1,
                   resolved_at = $2 WHERE event_id = $3 AND status = 'pending'"#,
            )
            .bind(&stored_signal.id)
            .bind(&now)
            .bind(&stored_signal.event_id)
            .execute(&mut *tx)
            .await?;
        }
        if let Some(row) = sqlx::query(
            r#"SELECT activations.* FROM activation_signals links
               JOIN thread_activations activations ON activations.id = links.activation_id
               JOIN threads thread ON thread.root_turn_id = activations.root_turn_id
                                  AND thread.generation = activations.generation
               WHERE links.signal_id = $1"#,
        )
        .bind(&stored_signal.id)
        .fetch_optional(&mut *tx)
        .await?
        {
            let existing = activation_from_row(&row)?;
            if candidate_thread_id != stored_signal.thread_id {
                sqlx::query(
                    r#"DELETE FROM threads candidate
                       WHERE candidate.id = $1
                         AND NOT EXISTS (
                           SELECT 1 FROM thread_signals WHERE thread_id = candidate.id
                         )
                         AND NOT EXISTS (
                           SELECT 1 FROM thread_activations
                           WHERE root_turn_id = candidate.root_turn_id
                         )"#,
                )
                .bind(&candidate_thread_id)
                .execute(&mut *tx)
                .await?;
            }
            tx.commit().await?;
            return Ok(Some(existing));
        }

        if let Some(existing) = joined_dialogue_activation {
            let next_ordinal: i64 = sqlx::query_scalar(
                "SELECT COALESCE(MAX(ordinal), -1) + 1 FROM activation_signals WHERE activation_id = $1",
            )
            .bind(&existing.id)
            .fetch_one(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT INTO activation_signals (activation_id, signal_id, ordinal) VALUES ($1, $2, $3)",
            )
            .bind(&existing.id)
            .bind(&stored_signal.id)
            .bind(next_ordinal)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                r#"UPDATE thread_signals SET status = 'claimed', claimed_at = $1
                   WHERE id = $2 AND status = 'pending'"#,
            )
            .bind(&now)
            .bind(&stored_signal.id)
            .execute(&mut *tx)
            .await?;
            if candidate_thread_id != signal.thread_id {
                sqlx::query(
                    r#"DELETE FROM threads candidate
                       WHERE candidate.id = $1
                         AND NOT EXISTS (
                           SELECT 1 FROM thread_signals WHERE thread_id = candidate.id
                         )
                         AND NOT EXISTS (
                           SELECT 1 FROM thread_activations
                           WHERE root_turn_id = candidate.root_turn_id
                         )"#,
                )
                .bind(&candidate_thread_id)
                .execute(&mut *tx)
                .await?;
            }
            tx.commit().await?;
            tracing::debug!(
                session_id = %activation.session_id,
                activation_id = %existing.id,
                signal_id = %stored_signal.id,
                "连续用户输入已加入下一批 DialogueTurn"
            );
            return Ok(Some(existing));
        }

        // A Thread row lock is the cross-worker single-flight authority. Every
        // contender for this Thread observes the prior claim after acquiring it.
        let thread = sqlx::query("SELECT * FROM threads WHERE id = $1 FOR UPDATE")
            .bind(&signal.thread_id)
            .fetch_one(&mut *tx)
            .await?;
        let mut thread = thread_from_row(&thread)?;
        if thread.initiating_principal_id.is_none() && stored_signal.principal_id.is_some() {
            sqlx::query(
                "UPDATE threads SET initiating_principal_id = $1 WHERE id = $2 AND initiating_principal_id IS NULL",
            )
            .bind(&stored_signal.principal_id)
            .bind(&thread.id)
            .execute(&mut *tx)
            .await?;
            thread.initiating_principal_id =
                sqlx::query_scalar("SELECT initiating_principal_id FROM threads WHERE id = $1")
                    .bind(&thread.id)
                    .fetch_one(&mut *tx)
                    .await?;
        }
        if thread.agent_id != activation.agent_id
            || thread.context_id != activation.context_id
            || thread.session_id != activation.session_id
            || thread.root_turn_id != activation.root_turn_id
        {
            return Err(format!(
                "Thread Signal '{}' 与 Activation route 不一致",
                stored_signal.id
            )
            .into());
        }
        if thread.lifecycle.is_terminal() {
            sqlx::query(
                r#"UPDATE thread_signals SET status = 'acknowledged', acknowledged_at = $1
                   WHERE thread_id = $2 AND status = 'pending'"#,
            )
            .bind(&now)
            .bind(&thread.id)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            return Ok(None);
        }
        if thread.control_state == crate::memory::ThreadControlState::Paused {
            tx.commit().await?;
            return Ok(None);
        }
        sqlx::query(
            r#"UPDATE thread_signals signals
               SET status = 'acknowledged', acknowledged_at = $1
               WHERE signals.thread_id = $2 AND signals.status = 'pending'
                 AND signals.parent_activation_id IS NOT NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM thread_activations parent
                   WHERE parent.id = signals.parent_activation_id
                     AND parent.generation = $3
                 )"#,
        )
        .bind(&now)
        .bind(&thread.id)
        .bind(i64::try_from(thread.generation)?)
        .execute(&mut *tx)
        .await?;
        if let Some(row) = sqlx::query(
            r#"SELECT * FROM thread_activations
               WHERE root_turn_id = $1 AND trigger_event_id = $2
                 AND generation = $3
                 AND status IN ('queued', 'running') LIMIT 1"#,
        )
        .bind(&thread.root_turn_id)
        .bind(&stored_signal.event_id)
        .bind(i64::try_from(thread.generation)?)
        .fetch_optional(&mut *tx)
        .await?
        {
            let existing = activation_from_row(&row)?;
            sqlx::query(
                r#"INSERT INTO activation_signals (activation_id, signal_id, ordinal)
                   VALUES ($1, $2, 0) ON CONFLICT DO NOTHING"#,
            )
            .bind(&existing.id)
            .bind(&stored_signal.id)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                r#"UPDATE thread_signals SET status = 'claimed', claimed_at = $1
                   WHERE id = $2 AND status = 'pending'"#,
            )
            .bind(&now)
            .bind(&stored_signal.id)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            return Ok(Some(existing));
        }
        if sqlx::query_scalar::<_, bool>(
            r#"SELECT EXISTS(SELECT 1 FROM thread_activations
               WHERE root_turn_id = $1 AND generation = $2
                 AND status IN ('queued', 'running'))"#,
        )
        .bind(&thread.root_turn_id)
        .bind(i64::try_from(thread.generation)?)
        .fetch_one(&mut *tx)
        .await?
        {
            tx.commit().await?;
            return Ok(None);
        }
        let pending = sqlx::query(
            r#"SELECT * FROM thread_signals WHERE thread_id = $1 AND status = 'pending'
               ORDER BY sequence, id LIMIT $2 FOR UPDATE"#,
        )
        .bind(&thread.id)
        .bind(max_signals)
        .fetch_all(&mut *tx)
        .await?;
        if pending.is_empty() {
            tx.commit().await?;
            return Ok(None);
        }
        let primary = signal_from_row(&pending[0])?;
        let activation_principal = activation
            .initiating_principal_id
            .as_ref()
            .or(primary.principal_id.as_ref());
        if activation.initiating_principal_id.is_some()
            && primary.principal_id.is_some()
            && activation.initiating_principal_id != primary.principal_id
        {
            return Err(format!(
                "Activation '{}' 与其首个 Signal Principal 不一致",
                activation.id
            )
            .into());
        }
        if thread.initiating_principal_id.is_some()
            && activation_principal.is_some()
            && thread.initiating_principal_id.as_ref() != activation_principal
        {
            return Err(format!(
                "Thread '{}' 与 Activation '{}' Principal 不一致",
                thread.id, activation.id
            )
            .into());
        }
        sqlx::query(
            r#"INSERT INTO thread_activations
               (id, revision, generation, agent_id, context_id, session_id, initiating_principal_id, trigger_event_id,
                trigger_sequence, trigger_kind, parent_activation_id, root_turn_id,
                status, created_at, updated_at)
               VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'queued', $12, $12)"#,
        )
        .bind(&activation.id)
        .bind(i64::try_from(thread.generation)?)
        .bind(&activation.agent_id)
        .bind(&activation.context_id)
        .bind(&activation.session_id)
        .bind(activation_principal)
        .bind(&primary.event_id)
        .bind(i64::try_from(primary.sequence)?)
        .bind(&primary.kind)
        .bind(&primary.parent_activation_id)
        .bind(&activation.root_turn_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        let mut advances_clock = false;
        for row in &pending {
            let pending_signal = signal_from_row(row)?;
            if let Some(event) =
                stored_event_in_tx(&mut tx, &pending_signal.event_id, &thread.context_id).await?
            {
                if crate::event::advances_cognitive_clock(&event) {
                    advances_clock = true;
                    break;
                }
            }
        }
        if advances_clock {
            sqlx::query(
                r#"INSERT INTO context_cognitive_clocks
                   (context_id, tick, last_signal_batch_id, revision)
                   VALUES ($1, 1, $2, 1)
                   ON CONFLICT(context_id) DO UPDATE SET
                     tick = context_cognitive_clocks.tick + 1,
                     last_signal_batch_id = EXCLUDED.last_signal_batch_id,
                     revision = context_cognitive_clocks.revision + 1
                   WHERE context_cognitive_clocks.last_signal_batch_id IS DISTINCT FROM EXCLUDED.last_signal_batch_id"#,
            )
            .bind(&thread.context_id)
            .bind(&activation.id)
            .execute(&mut *tx)
            .await?;
        }
        for (ordinal, row) in pending.iter().enumerate() {
            let pending_signal = signal_from_row(row)?;
            sqlx::query(
                r#"INSERT INTO activation_signals (activation_id, signal_id, ordinal)
                   VALUES ($1, $2, $3)"#,
            )
            .bind(&activation.id)
            .bind(&pending_signal.id)
            .bind(i64::try_from(ordinal)?)
            .execute(&mut *tx)
            .await?;
            let claimed = sqlx::query(
                r#"UPDATE thread_signals SET status = 'claimed', claimed_at = $1
                   WHERE id = $2 AND status = 'pending'"#,
            )
            .bind(&now)
            .bind(&pending_signal.id)
            .execute(&mut *tx)
            .await?;
            if claimed.rows_affected() != 1 {
                return Err(format!(
                    "Thread Signal '{}' 在 Activation claim 中发生并发冲突",
                    pending_signal.id
                )
                .into());
            }
        }
        let row = sqlx::query("SELECT * FROM thread_activations WHERE id = $1")
            .bind(&activation.id)
            .fetch_one(&mut *tx)
            .await?;
        let created = activation_from_row(&row)?;
        tx.commit().await?;
        if advances_clock {
            tracing::debug!(
                context_id = %thread.context_id,
                activation_id = %activation.id,
                signal_count = pending.len(),
                "认知活动时钟已随唯一 Signal batch 推进"
            );
        }
        Ok(Some(created))
    }

    async fn list_signal_outbox(
        &self,
        status: SignalOutboxStatus,
        limit: usize,
    ) -> Result<Vec<SignalOutboxRecord>, StoreError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        sqlx::query(
            r#"SELECT outbox.* FROM signal_outbox outbox
               JOIN events ON events.id = outbox.event_id
               WHERE outbox.status = $1 ORDER BY events.sequence, outbox.event_id LIMIT $2"#,
        )
        .bind(status.as_str())
        .bind(i64::try_from(limit)?)
        .fetch_all(&self.pool)
        .await?
        .iter()
        .map(outbox_from_row)
        .collect()
    }

    async fn discard_signal_outbox(&self, event_id: &str) -> Result<bool, StoreError> {
        let result = sqlx::query(
            r#"UPDATE signal_outbox SET status = 'discarded', resolved_at = $1
               WHERE event_id = $2 AND status = 'pending'"#,
        )
        .bind(now_text())
        .bind(event_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    async fn list_context_thread_signals(
        &self,
        context_id: &str,
        status: Option<ThreadSignalStatus>,
    ) -> Result<Vec<ThreadSignalRecord>, StoreError> {
        let rows = if let Some(status) = status {
            sqlx::query(
                r#"SELECT signals.* FROM thread_signals signals
                   JOIN threads ON threads.id = signals.thread_id
                   WHERE threads.context_id = $1 AND signals.status = $2
                   ORDER BY signals.sequence, signals.id"#,
            )
            .bind(context_id)
            .bind(status.as_str())
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                r#"SELECT signals.* FROM thread_signals signals
                   JOIN threads ON threads.id = signals.thread_id
                   WHERE threads.context_id = $1 ORDER BY signals.sequence, signals.id"#,
            )
            .bind(context_id)
            .fetch_all(&self.pool)
            .await?
        };
        rows.iter().map(signal_from_row).collect()
    }

    async fn list_activation_signals(
        &self,
        activation_id: &str,
    ) -> Result<Vec<ThreadSignalRecord>, StoreError> {
        sqlx::query(
            r#"SELECT signals.* FROM activation_signals links
               JOIN thread_signals signals ON signals.id = links.signal_id
               WHERE links.activation_id = $1 ORDER BY links.ordinal"#,
        )
        .bind(activation_id)
        .fetch_all(&self.pool)
        .await?
        .iter()
        .map(signal_from_row)
        .collect()
    }

    async fn next_pending_thread_signal(
        &self,
        thread_id: &str,
    ) -> Result<Option<ThreadSignalRecord>, StoreError> {
        sqlx::query(
            r#"SELECT * FROM thread_signals WHERE thread_id = $1 AND status = 'pending'
               ORDER BY sequence, id LIMIT 1"#,
        )
        .bind(thread_id)
        .fetch_optional(&self.pool)
        .await?
        .as_ref()
        .map(signal_from_row)
        .transpose()
    }

    async fn ensure_thread_activation(
        &self,
        activation: NewThreadActivation,
    ) -> Result<ThreadActivationRecord, StoreError> {
        let now = now_text();
        sqlx::query(
            r#"INSERT INTO thread_activations
               (id, revision, generation, agent_id, context_id, session_id, initiating_principal_id, trigger_event_id,
                trigger_sequence, trigger_kind, parent_activation_id, root_turn_id,
                status, created_at, updated_at)
               VALUES ($1, 1, (SELECT generation FROM threads WHERE root_turn_id = $2), $3, $4, $5, $6, $7, $8, $9, $10, $2, 'queued', $11, $11)
               ON CONFLICT DO NOTHING"#,
        )
        .bind(&activation.id)
        .bind(&activation.root_turn_id)
        .bind(&activation.agent_id)
        .bind(&activation.context_id)
        .bind(&activation.session_id)
        .bind(&activation.initiating_principal_id)
        .bind(&activation.trigger_event_id)
        .bind(i64::try_from(activation.trigger_sequence)?)
        .bind(&activation.trigger_kind)
        .bind(&activation.parent_activation_id)
        .bind(now)
        .execute(&self.pool)
        .await?;
        let row = sqlx::query("SELECT * FROM thread_activations WHERE trigger_event_id = $1")
            .bind(&activation.trigger_event_id)
            .fetch_one(&self.pool)
            .await?;
        let mut existing = activation_from_row(&row)?;
        if existing.initiating_principal_id.is_none()
            && activation.initiating_principal_id.is_some()
        {
            sqlx::query(
                "UPDATE thread_activations SET initiating_principal_id = $1 WHERE id = $2 AND initiating_principal_id IS NULL",
            )
            .bind(&activation.initiating_principal_id)
            .bind(&existing.id)
            .execute(&self.pool)
            .await?;
            existing = self
                .get_thread_activation(&existing.id)
                .await?
                .ok_or("Thread Activation Principal 迁移后无法读取")?;
        }
        if existing.context_id != activation.context_id
            || existing.session_id != activation.session_id
            || existing.root_turn_id != activation.root_turn_id
            || (activation.initiating_principal_id.is_some()
                && existing.initiating_principal_id != activation.initiating_principal_id)
        {
            return Err(format!(
                "Trigger Event '{}' 已被不同 Thread Activation 占用",
                activation.trigger_event_id
            )
            .into());
        }
        Ok(existing)
    }

    async fn get_thread_activation(
        &self,
        id: &str,
    ) -> Result<Option<ThreadActivationRecord>, StoreError> {
        sqlx::query("SELECT * FROM thread_activations WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(activation_from_row)
            .transpose()
    }

    async fn list_context_thread_activations(
        &self,
        context_id: &str,
        include_terminal: bool,
    ) -> Result<Vec<ThreadActivationRecord>, StoreError> {
        let rows = if include_terminal {
            sqlx::query(
                "SELECT * FROM thread_activations WHERE context_id = $1 ORDER BY created_at, id",
            )
            .bind(context_id)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                r#"SELECT * FROM thread_activations WHERE context_id = $1
                   AND status NOT IN ('completed', 'cancelled', 'failed')
                   ORDER BY created_at, id"#,
            )
            .bind(context_id)
            .fetch_all(&self.pool)
            .await?
        };
        rows.iter().map(activation_from_row).collect()
    }

    async fn list_queued_thread_activations_for_admission(
        &self,
        limit: usize,
        dialogue_delivery_reserved_queue_slots: usize,
        aging_promotion_interval_ms: u64,
    ) -> Result<Vec<(ThreadActivationRecord, AdmissionClass)>, StoreError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let limit_i64 = i64::try_from(limit)?;
        let reserved = dialogue_delivery_reserved_queue_slots.min(limit.saturating_sub(1));
        let general_limit = limit_i64.saturating_sub(i64::try_from(reserved)?);
        let rows = sqlx::query(
            r#"WITH classified AS (
                 SELECT activations.*,
                   CASE
                     WHEN events.type = 'user_message' THEN 0
                     WHEN activations.trigger_kind = 'chat/thread_completion_ready' THEN 1
                     -- objective_id is projected on append, but Objective
                     -- entry Events such as `objective/requested` carry only
                     -- `requested_objective_id`. Keep the topic prefix so they
                     -- are not admitted as background work.
                     WHEN events.objective_id IS NOT NULL
                       OR events.payload ? 'objective_evaluation_id'
                       OR left(events.topic, 10) = 'objective/' THEN 2
                     WHEN events.payload @> '{"runtime_maintenance": true}'::jsonb
                       OR events.topic IN ('runtime/context_maintenance', 'chat/context_maintenance')
                       THEN 4
                     ELSE 3
                   END AS admission_rank
                 FROM thread_activations activations
                 JOIN events ON events.id = activations.trigger_event_id
                 JOIN threads ON threads.root_turn_id = activations.root_turn_id
                 WHERE activations.status = 'queued'
                   AND threads.executor_kind != 'artifact_transfer'
                   AND (
                     threads.kind != 'dialogue_turn'
                     OR (
                       NOT EXISTS (
                         SELECT 1
                         FROM thread_activations running
                         JOIN threads running_thread
                           ON running_thread.root_turn_id = running.root_turn_id
                          AND running_thread.generation = running.generation
                         WHERE running.session_id = activations.session_id
                           AND running.status = 'running'
                           AND running.id != activations.id
                           AND running_thread.kind = 'dialogue_turn'
                       )
                       AND NOT EXISTS (
                         SELECT 1
                         FROM thread_activations older
                         JOIN threads older_thread
                           ON older_thread.root_turn_id = older.root_turn_id
                          AND older_thread.generation = older.generation
                         WHERE older.session_id = activations.session_id
                           AND older.status = 'queued'
                           AND older.id != activations.id
                           AND older_thread.kind = 'dialogue_turn'
                           AND (
                             older.trigger_sequence < activations.trigger_sequence
                             OR (
                               older.trigger_sequence = activations.trigger_sequence
                               AND older.id < activations.id
                             )
                           )
                       )
                     )
                   )
               ), aged AS (
                 SELECT classified.*,
                   GREATEST(0, admission_rank - FLOOR(
                     GREATEST(0, EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - created_at::timestamptz)) * 1000)
                     / $1
                   )::BIGINT) AS effective_rank
                 FROM classified
               ), reserved_candidates AS (
                 SELECT * FROM aged WHERE admission_rank IN (0, 1)
                 ORDER BY effective_rank, created_at, id LIMIT $2
               ), general_candidates AS (
                 SELECT * FROM aged WHERE admission_rank NOT IN (0, 1)
                 ORDER BY effective_rank, created_at, id LIMIT $3
               ), candidates AS (
                 SELECT * FROM reserved_candidates UNION ALL SELECT * FROM general_candidates
               )
               SELECT * FROM candidates ORDER BY effective_rank, created_at, id LIMIT $2"#,
        )
        .bind(aging_promotion_interval_ms.max(1) as f64)
        .bind(limit_i64)
        .bind(general_limit)
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|row| {
                let activation = activation_from_row(row)?;
                let class = match row.get::<i32, _>("admission_rank") {
                    0 => AdmissionClass::InteractiveControl,
                    1 => AdmissionClass::Delivery,
                    2 => AdmissionClass::Objective,
                    3 => AdmissionClass::ScheduledBackground,
                    4 => AdmissionClass::Maintenance,
                    rank => return Err(format!("PostgreSQL 返回未知 admission rank {rank}").into()),
                };
                Ok((activation, class))
            })
            .collect()
    }

    async fn dialogue_turn_activation_runnable(
        &self,
        activation_id: &str,
    ) -> Result<bool, StoreError> {
        let runnable = sqlx::query_scalar::<_, bool>(
            r#"SELECT CASE
                 WHEN candidate_thread.kind != 'dialogue_turn' THEN TRUE
                 WHEN EXISTS (
                   SELECT 1
                   FROM thread_activations running
                   JOIN threads running_thread
                     ON running_thread.root_turn_id = running.root_turn_id
                    AND running_thread.generation = running.generation
                   WHERE running.session_id = candidate.session_id
                     AND running.status = 'running'
                     AND running.id != candidate.id
                     AND running_thread.kind = 'dialogue_turn'
                 ) THEN FALSE
                 WHEN EXISTS (
                   SELECT 1
                   FROM thread_activations older
                   JOIN threads older_thread
                     ON older_thread.root_turn_id = older.root_turn_id
                    AND older_thread.generation = older.generation
                   WHERE older.session_id = candidate.session_id
                     AND older.status = 'queued'
                     AND older.id != candidate.id
                     AND older_thread.kind = 'dialogue_turn'
                     AND (
                       older.trigger_sequence < candidate.trigger_sequence
                       OR (
                         older.trigger_sequence = candidate.trigger_sequence
                         AND older.id < candidate.id
                       )
                     )
                 ) THEN FALSE
                 ELSE TRUE
               END
               FROM thread_activations candidate
               JOIN threads candidate_thread
                 ON candidate_thread.root_turn_id = candidate.root_turn_id
                AND candidate_thread.generation = candidate.generation
               WHERE candidate.id = $1"#,
        )
        .bind(activation_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(runnable.unwrap_or(true))
    }

    async fn update_thread_activation(
        &self,
        id: &str,
        expected_revision: u64,
        status: ThreadActivationStatus,
        claimed_by: Option<&str>,
        lease_expires_at: Option<DateTime<Utc>>,
        context_snapshot_version: Option<u64>,
    ) -> Result<ThreadActivationMutation, StoreError> {
        let now = now_text();
        let mut tx = self.pool.begin().await?;
        if status == ThreadActivationStatus::Running {
            let route = sqlx::query(
                r#"SELECT activation.session_id, activation.status, thread.kind
                   FROM thread_activations activation
                   JOIN threads thread
                     ON thread.root_turn_id = activation.root_turn_id
                    AND thread.generation = activation.generation
                   WHERE activation.id = $1"#,
            )
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
            if let Some(route) = route {
                let queued_dialogue_turn = route.get::<String, _>("status") == "queued"
                    && route.get::<String, _>("kind") == "dialogue_turn";
                if queued_dialogue_turn {
                    let session_id = route.get::<String, _>("session_id");
                    sqlx::query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE")
                        .bind(&session_id)
                        .fetch_one(&mut *tx)
                        .await?;
                    let running_other: Option<String> = sqlx::query_scalar(
                        r#"SELECT activation.id
                           FROM thread_activations activation
                           JOIN threads thread
                             ON thread.root_turn_id = activation.root_turn_id
                            AND thread.generation = activation.generation
                           WHERE activation.session_id = $1
                             AND activation.status = 'running'
                             AND activation.id != $2
                             AND thread.kind = 'dialogue_turn'
                           LIMIT 1"#,
                    )
                    .bind(&session_id)
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await?;
                    let oldest_queued: Option<String> = sqlx::query_scalar(
                        r#"SELECT activation.id
                           FROM thread_activations activation
                           JOIN threads thread
                             ON thread.root_turn_id = activation.root_turn_id
                            AND thread.generation = activation.generation
                           WHERE activation.session_id = $1
                             AND activation.status = 'queued'
                             AND thread.kind = 'dialogue_turn'
                           ORDER BY activation.trigger_sequence, activation.id
                           LIMIT 1"#,
                    )
                    .bind(&session_id)
                    .fetch_optional(&mut *tx)
                    .await?;
                    if running_other.is_some() || oldest_queued.as_deref() != Some(id) {
                        tx.commit().await?;
                        return Ok(match self.get_thread_activation(id).await? {
                            Some(current) => ThreadActivationMutation::Conflict { current },
                            None => ThreadActivationMutation::NotFound,
                        });
                    }
                }
            }
        }
        let result = sqlx::query(
            r#"UPDATE thread_activations SET revision = revision + 1, status = $1,
               claimed_by = $2, lease_expires_at = $3,
               context_snapshot_version = COALESCE($4, context_snapshot_version), updated_at = $5
               WHERE id = $6 AND revision = $7"#,
        )
        .bind(activation_status_storage(status))
        .bind(claimed_by)
        .bind(
            lease_expires_at.map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true)),
        )
        .bind(context_snapshot_version.map(i64::try_from).transpose()?)
        .bind(&now)
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() == 1 {
            if status.is_terminal() {
                sqlx::query(
                    r#"UPDATE thread_signals SET status = 'acknowledged', acknowledged_at = $1
                       WHERE id IN (SELECT signal_id FROM activation_signals WHERE activation_id = $2)
                         AND status = 'claimed'"#,
                )
                .bind(&now)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            }
            let row = sqlx::query("SELECT * FROM thread_activations WHERE id = $1")
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
            let updated = activation_from_row(&row)?;
            tx.commit().await?;
            return Ok(ThreadActivationMutation::Updated(updated));
        }
        tx.commit().await?;
        Ok(match self.get_thread_activation(id).await? {
            Some(current) => ThreadActivationMutation::Conflict { current },
            None => ThreadActivationMutation::NotFound,
        })
    }

    async fn commit_activation_outcome(
        &self,
        activation_id: &str,
        event: &Event,
    ) -> Result<ActivationOutcomeCommit, StoreError> {
        let session_id = event
            .payload
            .get("session_id")
            .and_then(JsonValue::as_str)
            .ok_or("Evaluation outcome Event 缺少 session_id")?;
        let disposition = event
            .payload
            .get("disposition")
            .and_then(JsonValue::as_str)
            .unwrap_or("deliver");
        let root_turn_id = event
            .payload
            .get("root_turn_id")
            .and_then(JsonValue::as_str)
            .ok_or("Evaluation outcome Event 缺少 root_turn_id")?;
        let thread_id = event
            .payload
            .get("thread_id")
            .and_then(JsonValue::as_str)
            .ok_or("Evaluation outcome Event 缺少 thread_id")?;
        let now = now_text();
        let mut tx = self.pool.begin().await?;
        let activation_route = sqlx::query(
            r#"SELECT activation.generation AS activation_generation,
                      activation.status AS activation_status,
                      thread.generation AS thread_generation
               FROM thread_activations activation
               JOIN threads thread ON thread.root_turn_id = activation.root_turn_id
               WHERE activation.id = $1 AND thread.id = $2
               FOR UPDATE OF thread"#,
        )
        .bind(activation_id)
        .bind(thread_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| {
            format!(
                "Activation '{}' 或其 Thread '{}' 不存在",
                activation_id, thread_id
            )
        })?;
        let activation_generation: i64 = activation_route.get("activation_generation");
        let thread_generation: i64 = activation_route.get("thread_generation");
        if activation_generation != thread_generation {
            tx.commit().await?;
            return Ok(ActivationOutcomeCommit::StaleGeneration);
        }
        let activation_status: String = activation_route.get("activation_status");
        if activation_status != ThreadActivationStatus::Running.as_str() {
            let existing = sqlx::query_scalar::<_, String>(
                "SELECT event_id FROM thread_outcomes WHERE root_turn_id = $1",
            )
            .bind(root_turn_id)
            .fetch_optional(&mut *tx)
            .await?;
            tx.commit().await?;
            return Ok(match existing {
                Some(event_id) => ActivationOutcomeCommit::Existing { event_id },
                None => ActivationOutcomeCommit::StaleActivation,
            });
        }
        let result = sqlx::query(
            r#"INSERT INTO thread_outcomes
               (thread_id, root_turn_id, activation_id, session_id, disposition, event_id, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT(root_turn_id) DO NOTHING"#,
        )
        .bind(thread_id)
        .bind(root_turn_id)
        .bind(activation_id)
        .bind(session_id)
        .bind(disposition)
        .bind(&event.id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() == 0 {
            let existing = sqlx::query_scalar::<_, String>(
                "SELECT event_id FROM thread_outcomes WHERE root_turn_id = $1",
            )
            .bind(root_turn_id)
            .fetch_one(&mut *tx)
            .await?;
            tx.commit().await?;
            return Ok(ActivationOutcomeCommit::Existing { event_id: existing });
        }
        let result_text = event.payload.get("text").and_then(JsonValue::as_str);
        let thread_status =
            if event.topic == "chat/reply" && event.payload.get("runtime_failure_kind").is_some() {
                ThreadLifecycle::Failed.as_str()
            } else {
                ThreadLifecycle::Completed.as_str()
            };
        let (delivery_status, delivery_event_id) = match event.topic.as_str() {
            "chat/reply" => ("delivered", Some(event.id.as_str())),
            "runtime/thread_result" => ("pending", None),
            _ => ("none", None),
        };
        let terminal = sqlx::query(
            r#"UPDATE threads SET revision = revision + 1, status = $1,
               result_text = COALESCE($2, result_text), result_event_id = $3,
               delivery_status = $4, delivery_event_id = $5, updated_at = $6
               WHERE id = $7 AND root_turn_id = $8 AND session_id = $9
                 AND status NOT IN ('completed', 'failed', 'cancelled')"#,
        )
        .bind(thread_status)
        .bind(result_text)
        .bind(&event.id)
        .bind(delivery_status)
        .bind(delivery_event_id)
        .bind(&now)
        .bind(thread_id)
        .bind(root_turn_id)
        .bind(session_id)
        .execute(&mut *tx)
        .await?;
        if terminal.rows_affected() != 1 {
            return Err(
                format!("Evaluation outcome 无法原子提交 Thread '{thread_id}' 终态").into(),
            );
        }
        if let Some(covers) = event.payload.get("covers").and_then(JsonValue::as_array) {
            for covered_thread in covers.iter().filter_map(JsonValue::as_str) {
                let updated = sqlx::query(
                    r#"UPDATE threads SET revision = revision + 1,
                       delivery_status = 'delivered', delivery_event_id = $1, updated_at = $2
                       WHERE id = $3 AND session_id = $4
                         AND delivery_status IN ('pending', 'deferred')"#,
                )
                .bind(&event.id)
                .bind(&now)
                .bind(covered_thread)
                .bind(session_id)
                .execute(&mut *tx)
                .await?;
                if updated.rows_affected() != 1 {
                    return Err(format!(
                        "Delivery outcome 无法覆盖 Thread '{covered_thread}'：它不属于当前 Session、已被交付或不是 pending/deferred"
                    )
                    .into());
                }
            }
        }
        if let Some(covers) = event
            .payload
            .get("defer_covers")
            .and_then(JsonValue::as_array)
        {
            for covered_thread in covers.iter().filter_map(JsonValue::as_str) {
                sqlx::query(
                    r#"UPDATE threads SET revision = revision + 1,
                       delivery_status = 'deferred', updated_at = $1
                       WHERE id = $2 AND session_id = $3 AND delivery_status = 'pending'"#,
                )
                .bind(&now)
                .bind(covered_thread)
                .bind(session_id)
                .execute(&mut *tx)
                .await?;
            }
        }
        sqlx::query(
            r#"INSERT INTO evaluation_outcomes
               (activation_id, session_id, disposition, event_id, created_at)
               VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING"#,
        )
        .bind(activation_id)
        .bind(session_id)
        .bind(disposition)
        .bind(&event.id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
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
        Ok(ActivationOutcomeCommit::Committed)
    }

    async fn restart_dialogue_turn(
        &self,
        request: DialogueTurnRetryRequest,
    ) -> Result<DialogueTurnRetryMutation, StoreError> {
        let root_turn_id = request
            .event
            .payload
            .get("root_turn_id")
            .and_then(JsonValue::as_str)
            .ok_or("DialogueTurn retry Event 缺少 root_turn_id")?;
        let context_id = request
            .event
            .payload
            .get("context_id")
            .and_then(JsonValue::as_str)
            .ok_or("DialogueTurn retry Event 缺少 context_id")?;
        let session_id = request
            .event
            .payload
            .get("session_id")
            .and_then(JsonValue::as_str)
            .ok_or("DialogueTurn retry Event 缺少 session_id")?;
        let expected_revision = i64::try_from(request.expected_thread_revision)?;
        let now = now_text();
        let mut tx = self.pool.begin().await?;

        // Lock the logical Thread before the idempotency read.  Concurrent
        // callers using the same request id must observe the first caller's
        // durable retry Event rather than race through the initial absence
        // check and report a spurious revision conflict.
        let row = sqlx::query("SELECT * FROM threads WHERE root_turn_id = $1 FOR UPDATE")
            .bind(root_turn_id)
            .fetch_optional(&mut *tx)
            .await?;
        let Some(row) = row else {
            tx.commit().await?;
            return Ok(DialogueTurnRetryMutation::NotFound);
        };
        let current = thread_from_row(&row)?;
        if stored_event_in_tx(&mut tx, &request.event.id, context_id)
            .await?
            .is_some()
        {
            tx.commit().await?;
            return Ok(DialogueTurnRetryMutation::Existing {
                thread_id: current.id,
                generation: current.generation,
            });
        }

        if current.revision != request.expected_thread_revision {
            tx.commit().await?;
            return Ok(DialogueTurnRetryMutation::Conflict { current });
        }
        let rejected = if current.kind != ThreadKind::DialogueTurn {
            Some("只有 DialogueTurn 可以通过此原语重启".to_string())
        } else if !current.lifecycle.is_terminal() {
            Some("DialogueTurn 尚未进入终态".to_string())
        } else if current.context_id != context_id || current.session_id != session_id {
            Some("Retry Event 与 DialogueTurn route 不一致".to_string())
        } else if current.result_event_id.as_deref()
            != Some(request.expected_result_event_id.as_str())
        {
            Some("DialogueTurn 的当前结果已经变化".to_string())
        } else {
            None
        };
        if let Some(reason) = rejected {
            tx.commit().await?;
            return Ok(DialogueTurnRetryMutation::Rejected { current, reason });
        }
        let result_event =
            stored_event_in_tx(&mut tx, &request.expected_result_event_id, context_id).await?;
        if !result_event.as_ref().is_some_and(|event| {
            event.topic == "chat/reply" && event.payload.get("runtime_failure_kind").is_some()
        }) {
            tx.commit().await?;
            return Ok(DialogueTurnRetryMutation::Rejected {
                current,
                reason: "只有 Runtime 失败回复可以原位重试".to_string(),
            });
        }
        // The failure outcome and Thread terminal state are committed
        // atomically, while Activation cleanup is deliberately a separate
        // projection update.  A crash in between must not make an otherwise
        // retryable logical turn permanently unrestartable.
        sqlx::query(
            r#"UPDATE thread_activations
               SET revision = revision + 1, status = 'cancelled',
                   claimed_by = NULL, lease_expires_at = NULL, updated_at = $1
               WHERE root_turn_id = $2 AND generation = $3
                 AND status IN ('queued', 'running')"#,
        )
        .bind(&now)
        .bind(root_turn_id)
        .bind(i64::try_from(current.generation)?)
        .execute(&mut *tx)
        .await?;
        let generation = current.generation.saturating_add(1);
        let updated = sqlx::query(
            r#"UPDATE threads
               SET revision = revision + 1, generation = $1, status = 'open',
                   result_text = NULL, result_event_id = NULL,
                   delivery_status = 'none', delivery_event_id = NULL,
                   updated_at = $2
               WHERE id = $3 AND revision = $4"#,
        )
        .bind(i64::try_from(generation)?)
        .bind(&now)
        .bind(&current.id)
        .bind(expected_revision)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            let row = sqlx::query("SELECT * FROM threads WHERE id = $1")
                .bind(&current.id)
                .fetch_one(&mut *tx)
                .await?;
            let current = thread_from_row(&row)?;
            tx.commit().await?;
            return Ok(DialogueTurnRetryMutation::Conflict { current });
        }
        sqlx::query("DELETE FROM thread_outcomes WHERE thread_id = $1")
            .bind(&current.id)
            .execute(&mut *tx)
            .await?;
        append_event_in_tx(&mut tx, &request.event).await?;
        append_signal_outbox_in_tx(&mut tx, &request.event).await?;
        tx.commit().await?;
        Ok(DialogueTurnRetryMutation::Accepted {
            thread_id: current.id,
            generation,
        })
    }
}
