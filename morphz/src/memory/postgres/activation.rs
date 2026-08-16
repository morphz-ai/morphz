use super::{
    append_direct_thread_signal_in_tx, append_event_in_tx, now_text, parse_time,
    stored_event_in_tx, thread::thread_from_row, PostgresStore, StoreError,
};
use crate::admission::AdmissionClass;
use crate::event::{Event, TYPE_TOOL_OUTPUT};
use crate::memory::{
    evaluate_thread_completion_contract, evaluate_thread_group_contract, ActivationContextCounts,
    ActivationOutcomeCommit, ActivationStore, DialogueTurnRetryMutation, DialogueTurnRetryRequest,
    NewThreadActivation, NewThreadSignal, ObjectiveCompletionIntent, ObjectiveStatus,
    ObjectiveWaitCondition, SessionAttentionUpdate, SignalOutboxRecord, SignalOutboxStatus,
    ThreadActivationMutation, ThreadActivationRecord, ThreadActivationStatus, ThreadGroupPolicy,
    ThreadGroupStatus, ThreadKind, ThreadLifecycle, ThreadSignalRecord, ThreadSignalStatus,
    ThreadSupervisorKind,
};
use crate::scheduler::{
    stable_scheduler_dependency_id, SchedulerDependencyKind, SchedulerDependencyOwnerKind,
};
use chrono::{DateTime, Utc};
use serde_json::Value as JsonValue;
use sqlx::postgres::PgRow;
use sqlx::{PgPool, Postgres, QueryBuilder, Row};
use std::collections::HashSet;

pub(super) async fn migrate(pool: &PgPool) -> Result<(), StoreError> {
    for statement in [
        r#"ALTER TABLE threads ADD COLUMN IF NOT EXISTS generation BIGINT NOT NULL DEFAULT 1"#,
        r#"ALTER TABLE thread_activations ADD COLUMN IF NOT EXISTS generation BIGINT NOT NULL DEFAULT 1"#,
        r#"ALTER TABLE thread_activations ADD COLUMN IF NOT EXISTS dialogue_lane_released_at TEXT"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_thread_activations_session_status
           ON thread_activations(session_id, status, updated_at DESC)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_thread_activations_context_status
           ON thread_activations(context_id, status, updated_at DESC)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_thread_activations_context_updated
           ON thread_activations(context_id, updated_at DESC, id)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_thread_activations_context_active_created
           ON thread_activations(context_id, created_at, id)
           WHERE status IN ('queued', 'running')"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_thread_activations_active_updated
           ON thread_activations(updated_at DESC, id)
           WHERE status IN ('queued', 'running')"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_thread_activations_lease
           ON thread_activations(status, lease_expires_at)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_thread_activations_root_turn
           ON thread_activations(root_turn_id, updated_at)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_thread_activations_root_generation_status
           ON thread_activations(root_turn_id, generation, status, updated_at)"#,
        r#"CREATE TABLE IF NOT EXISTS thread_signals (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
            thread_generation BIGINT NOT NULL DEFAULT 1,
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
        r#"ALTER TABLE thread_signals ADD COLUMN IF NOT EXISTS thread_generation BIGINT NOT NULL DEFAULT 1"#,
        r#"ALTER TABLE thread_signals ADD COLUMN IF NOT EXISTS principal_id TEXT"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_thread_signals_thread_status_sequence
           ON thread_signals(thread_id, status, sequence, id)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_thread_signals_status_sequence
           ON thread_signals(status, sequence, id)"#,
        r#"CREATE TABLE IF NOT EXISTS activation_signals (
            activation_id TEXT NOT NULL REFERENCES thread_activations(id) ON DELETE CASCADE,
            signal_id TEXT NOT NULL UNIQUE REFERENCES thread_signals(id) ON DELETE CASCADE,
            ordinal BIGINT NOT NULL,
            PRIMARY KEY(activation_id, ordinal)
        )"#,
        r#"CREATE TABLE IF NOT EXISTS thread_outcomes (
            thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
            outcome_id TEXT NOT NULL UNIQUE,
            thread_generation BIGINT NOT NULL DEFAULT 1,
            root_turn_id TEXT NOT NULL UNIQUE,
            activation_id TEXT NOT NULL REFERENCES thread_activations(id) ON DELETE CASCADE,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            terminal_kind TEXT NOT NULL DEFAULT 'completed',
            disposition TEXT NOT NULL,
            event_id TEXT NOT NULL UNIQUE,
            summary TEXT,
            artifact_refs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
            evidence_refs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
            check_results_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            unresolved_failures_json JSONB NOT NULL DEFAULT '[]'::jsonb,
            terminal_event_sequence BIGINT,
            created_at TEXT NOT NULL,
            delivered_at TEXT
        )"#,
        r#"ALTER TABLE thread_outcomes ADD COLUMN IF NOT EXISTS outcome_id TEXT"#,
        r#"ALTER TABLE thread_outcomes ADD COLUMN IF NOT EXISTS thread_generation BIGINT NOT NULL DEFAULT 1"#,
        r#"ALTER TABLE thread_outcomes ADD COLUMN IF NOT EXISTS terminal_kind TEXT NOT NULL DEFAULT 'completed'"#,
        r#"ALTER TABLE thread_outcomes ADD COLUMN IF NOT EXISTS summary TEXT"#,
        r#"ALTER TABLE thread_outcomes ADD COLUMN IF NOT EXISTS artifact_refs_json JSONB NOT NULL DEFAULT '[]'::jsonb"#,
        r#"ALTER TABLE thread_outcomes ADD COLUMN IF NOT EXISTS evidence_refs_json JSONB NOT NULL DEFAULT '[]'::jsonb"#,
        r#"ALTER TABLE thread_outcomes ADD COLUMN IF NOT EXISTS check_results_json JSONB NOT NULL DEFAULT '{}'::jsonb"#,
        r#"ALTER TABLE thread_outcomes ADD COLUMN IF NOT EXISTS unresolved_failures_json JSONB NOT NULL DEFAULT '[]'::jsonb"#,
        r#"ALTER TABLE thread_outcomes ADD COLUMN IF NOT EXISTS terminal_event_sequence BIGINT"#,
        r#"ALTER TABLE thread_outcomes ADD COLUMN IF NOT EXISTS delivered_at TEXT"#,
        r#"UPDATE thread_outcomes SET outcome_id = 'outcome_' || event_id WHERE outcome_id IS NULL OR outcome_id = ''"#,
        r#"CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_thread_outcomes_outcome_id ON thread_outcomes(outcome_id)"#,
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

pub(super) async fn migrate_thread_signal_notifications(pool: &PgPool) -> Result<(), StoreError> {
    // PostgreSQL delivers NOTIFY only after the surrounding transaction
    // commits, exactly matching the scheduler's durable visibility boundary.
    // The trigger also covers an explicit requeue to `pending`.
    for statement in [
        r#"CREATE OR REPLACE FUNCTION morphz_notify_thread_signal_change()
           RETURNS trigger AS $function$
           BEGIN
             PERFORM pg_notify('morphz_thread_signal_change', current_schema());
             RETURN NEW;
           END;
           $function$ LANGUAGE plpgsql"#,
        r#"DROP TRIGGER IF EXISTS trg_morphz_thread_signal_change ON thread_signals"#,
        r#"CREATE TRIGGER trg_morphz_thread_signal_change
           AFTER INSERT OR UPDATE OF status ON thread_signals
           FOR EACH ROW
           WHEN (NEW.status = 'pending')
           EXECUTE FUNCTION morphz_notify_thread_signal_change()"#,
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
        dialogue_lane_released_at: row
            .get::<Option<String>, _>("dialogue_lane_released_at")
            .as_deref()
            .map(parse_time)
            .transpose()?,
        created_at: parse_time(&row.get::<String, _>("created_at"))?,
        updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
    })
}

pub(super) fn signal_from_row(row: &PgRow) -> Result<ThreadSignalRecord, StoreError> {
    Ok(ThreadSignalRecord {
        id: row.get("id"),
        thread_id: row.get("thread_id"),
        thread_generation: u64::try_from(row.get::<i64, _>("thread_generation"))?,
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
    async fn wait_for_thread_signal_change(&self, timeout: std::time::Duration) {
        let _ = tokio::time::timeout(timeout, self.thread_signal_notify.notified()).await;
    }

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
                r#"SELECT queued.*, thread.id AS routed_thread_id,
                          thread.generation AS routed_thread_generation
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
                signal.thread_generation =
                    u64::try_from(row.get::<i64, _>("routed_thread_generation"))?;
                joined_dialogue_activation = Some(activation_from_row(&row)?);
            }
        }
        sqlx::query(
            r#"INSERT INTO thread_signals
               (id, thread_id, thread_generation, event_id, principal_id, sequence, kind, parent_activation_id,
                status, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)
               ON CONFLICT DO NOTHING"#,
        )
        .bind(&signal.id)
        .bind(&signal.thread_id)
        .bind(i64::try_from(signal.thread_generation)?)
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
        if stored_signal.parent_activation_id.is_none() && signal.parent_activation_id.is_some() {
            sqlx::query(
                "UPDATE thread_signals SET parent_activation_id = $1 WHERE id = $2 AND parent_activation_id IS NULL",
            )
            .bind(&signal.parent_activation_id)
            .bind(&stored_signal.id)
            .execute(&mut *tx)
            .await?;
            stored_signal.parent_activation_id =
                sqlx::query_scalar("SELECT parent_activation_id FROM thread_signals WHERE id = $1")
                    .bind(&stored_signal.id)
                    .fetch_one(&mut *tx)
                    .await?;
        }
        let routed_generation: i64 =
            sqlx::query_scalar("SELECT generation FROM threads WHERE id = $1 FOR UPDATE")
                .bind(&stored_signal.thread_id)
                .fetch_one(&mut *tx)
                .await?;
        if stored_signal.thread_generation != u64::try_from(routed_generation)? {
            sqlx::query(
                r#"UPDATE thread_signals SET status = 'acknowledged', acknowledged_at = $1
                   WHERE id = $2 AND status = 'pending'"#,
            )
            .bind(&now)
            .bind(&stored_signal.id)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                r#"UPDATE signal_outbox SET status = 'discarded', resolved_at = $1
                   WHERE event_id = $2 AND status = 'pending'"#,
            )
            .bind(&now)
            .bind(&stored_signal.event_id)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            tracing::warn!(
                signal_id = %stored_signal.id,
                signal_generation = stored_signal.thread_generation,
                thread_generation = routed_generation,
                event_code = "memory.postgres.thread_signal.stale_generation_quarantined",
                "Quarantined a Thread Signal from a stale generation"
            );
            return Ok(None);
        }
        if stored_signal.thread_id != signal.thread_id {
            return Err(format!("Event '{}' 已路由到不同 Thread Signal", signal.event_id).into());
        }
        if stored_signal.thread_generation != signal.thread_generation {
            return Err(format!(
                "Event '{}' 的 Thread Signal generation {} != {}",
                signal.event_id, stored_signal.thread_generation, signal.thread_generation
            )
            .into());
        }
        if signal.principal_id.is_some() && stored_signal.principal_id != signal.principal_id {
            return Err(format!(
                "Event '{}' 的 Thread Signal Principal 不一致",
                signal.event_id
            )
            .into());
        }
        if signal.parent_activation_id.is_some()
            && stored_signal.parent_activation_id != signal.parent_activation_id
        {
            return Err(format!(
                "Event '{}' 的 Thread Signal parent Activation 不一致",
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
                event_code = "memory.postgres.dialogue_turn.input_batched",
                "Added consecutive user input to the next DialogueTurn batch"
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
        // Keep replayed user input in Ledger order, but let the newly arrived
        // Signal remain the unique cause of an interruption replacement.
        let trigger = pending
            .iter()
            .map(signal_from_row)
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .find(|pending_signal| pending_signal.event_id == activation.trigger_event_id)
            .unwrap_or_else(|| primary.clone());
        let activation_principal = activation
            .initiating_principal_id
            .as_ref()
            .or(trigger.principal_id.as_ref());
        if activation.initiating_principal_id.is_some()
            && trigger.principal_id.is_some()
            && activation.initiating_principal_id != trigger.principal_id
        {
            return Err(format!(
                "Activation '{}' 与其 Trigger Signal Principal 不一致",
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
                admission_rank, status, created_at, updated_at)
               VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 COALESCE((SELECT CASE
                   WHEN event.type = 'user_message' THEN 0
                   WHEN $9 = 'chat/thread_completion_ready' THEN 1
                   WHEN event.objective_id IS NOT NULL
                     OR event.payload ? 'objective_evaluation_id'
                     OR left(event.topic, 10) = 'objective/' THEN 2
                   WHEN event.payload @> '{"runtime_maintenance": true}'::jsonb
                     OR event.topic IN ('runtime/context_maintenance', 'chat/context_maintenance') THEN 4
                   ELSE 3 END
                 FROM events AS event WHERE event.id = $7), 3),
                 'queued', $12, $12)"#,
        )
        .bind(&activation.id)
        .bind(i64::try_from(thread.generation)?)
        .bind(&activation.agent_id)
        .bind(&activation.context_id)
        .bind(&activation.session_id)
        .bind(activation_principal)
        .bind(&trigger.event_id)
        .bind(i64::try_from(trigger.sequence)?)
        .bind(&trigger.kind)
        .bind(&trigger.parent_activation_id)
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
            event_code = "memory.postgres.cognitive_clock.advanced",
            "Advanced the cognitive-activity clock with the unique Signal batch"
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

    async fn list_context_thread_signals_bounded(
        &self,
        context_id: &str,
        status: Option<ThreadSignalStatus>,
        limit: usize,
    ) -> Result<Vec<ThreadSignalRecord>, StoreError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let mut query = QueryBuilder::<Postgres>::new(
            "SELECT signals.* FROM thread_signals signals INNER JOIN threads ON threads.id = signals.thread_id WHERE threads.context_id = ",
        );
        query.push_bind(context_id);
        if let Some(status) = status {
            query
                .push(" AND signals.status = ")
                .push_bind(status.as_str());
        }
        query
            .push(" ORDER BY signals.sequence, signals.id LIMIT ")
            .push_bind(i64::try_from(limit)?);
        query
            .build()
            .fetch_all(&self.pool)
            .await?
            .iter()
            .map(signal_from_row)
            .collect()
    }

    async fn count_context_activation_authority(
        &self,
        context_id: &str,
    ) -> Result<ActivationContextCounts, StoreError> {
        let row = sqlx::query(
            r#"SELECT
                 (SELECT COUNT(*) FROM thread_signals signals
                  INNER JOIN threads ON threads.id = signals.thread_id
                  WHERE threads.context_id = $1 AND signals.status = 'pending') AS pending_signals,
                 (SELECT COUNT(*) FROM thread_activations
                  WHERE context_id = $1 AND status = 'queued') AS queued_activations,
                 (SELECT COUNT(*) FROM thread_activations
                  WHERE context_id = $1 AND status = 'running') AS running_activations"#,
        )
        .bind(context_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(ActivationContextCounts {
            pending_signals: usize::try_from(row.get::<i64, _>("pending_signals"))?,
            queued_activations: usize::try_from(row.get::<i64, _>("queued_activations"))?,
            running_activations: usize::try_from(row.get::<i64, _>("running_activations"))?,
        })
    }

    async fn has_active_thread_activation_for_session(
        &self,
        context_id: &str,
        session_id: &str,
    ) -> Result<bool, StoreError> {
        Ok(sqlx::query_scalar::<_, bool>(
            r#"SELECT EXISTS(
                 SELECT 1 FROM thread_activations
                 WHERE context_id = $1 AND session_id = $2
                   AND status IN ('queued', 'running')
               )"#,
        )
        .bind(context_id)
        .bind(session_id)
        .fetch_one(&self.pool)
        .await?)
    }

    async fn list_runnable_pending_thread_signals(
        &self,
        limit: usize,
    ) -> Result<Vec<ThreadSignalRecord>, StoreError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let rows = sqlx::query(
            r#"SELECT signals.*
               FROM thread_signals signals
               JOIN threads thread ON thread.id = signals.thread_id
               WHERE signals.status = 'pending'
                 AND signals.thread_generation = thread.generation
                 AND thread.status = 'open'
                 AND thread.control_state = 'active'
                 AND NOT EXISTS (
                   SELECT 1 FROM thread_activations activation
                   WHERE activation.root_turn_id = thread.root_turn_id
                     AND activation.generation = thread.generation
                     AND activation.status IN ('queued', 'running')
                 )
               ORDER BY signals.sequence, signals.id
               LIMIT $1"#,
        )
        .bind(i64::try_from(limit)?)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(signal_from_row).collect()
    }

    async fn list_context_thread_signals_for_threads(
        &self,
        context_id: &str,
        thread_ids: &[String],
        status: Option<ThreadSignalStatus>,
    ) -> Result<Vec<ThreadSignalRecord>, StoreError> {
        if thread_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut query = QueryBuilder::<Postgres>::new(
            "SELECT signals.* FROM thread_signals signals JOIN threads ON threads.id = signals.thread_id WHERE threads.context_id = ",
        );
        query
            .push_bind(context_id)
            .push(" AND signals.thread_id IN (");
        {
            let mut values = query.separated(", ");
            for thread_id in thread_ids {
                values.push_bind(thread_id);
            }
        }
        query.push(")");
        if let Some(status) = status {
            query
                .push(" AND signals.status = ")
                .push_bind(status.as_str());
        }
        query.push(" ORDER BY signals.sequence, signals.id");
        let rows = query.build().fetch_all(&self.pool).await?;
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

    async fn list_activation_signals_for_activations(
        &self,
        activation_ids: &[String],
    ) -> Result<Vec<(String, ThreadSignalRecord)>, StoreError> {
        if activation_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut records = Vec::new();
        for activation_ids in activation_ids.chunks(500) {
            let mut query = QueryBuilder::<Postgres>::new(
                "SELECT links.activation_id AS link_activation_id, signals.* FROM activation_signals links JOIN thread_signals signals ON signals.id = links.signal_id WHERE links.activation_id IN (",
            );
            {
                let mut values = query.separated(", ");
                for activation_id in activation_ids {
                    values.push_bind(activation_id);
                }
            }
            query.push(") ORDER BY links.activation_id, links.ordinal");
            for row in query.build().fetch_all(&self.pool).await? {
                records.push((
                    row.try_get::<String, _>("link_activation_id")?,
                    signal_from_row(&row)?,
                ));
            }
        }
        Ok(records)
    }

    async fn bind_activation_input_signals(
        &self,
        activation_id: &str,
        event_ids: &[String],
    ) -> Result<Vec<ThreadSignalRecord>, StoreError> {
        if event_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut event_ids = event_ids.to_vec();
        event_ids.sort();
        event_ids.dedup();
        let now = now_text();
        let mut tx = self.pool.begin().await?;

        // Lock the current Thread before the Activation. Claim, recovery, and
        // terminal transitions use this same order, avoiding a cross-path
        // deadlock while preserving one authoritative owner per Signal.
        let route = sqlx::query(
            r#"SELECT activation.root_turn_id,
                      activation.generation AS activation_generation
               FROM thread_activations activation
               WHERE activation.id = $1"#,
        )
        .bind(activation_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| format!("Thread Activation '{activation_id}' 不存在"))?;
        let root_turn_id: String = route.get("root_turn_id");
        let activation_generation: i64 = route.get("activation_generation");
        let thread = sqlx::query(
            r#"SELECT id, generation FROM threads
               WHERE root_turn_id = $1 FOR UPDATE"#,
        )
        .bind(&root_turn_id)
        .fetch_one(&mut *tx)
        .await?;
        let thread_id: String = thread.get("id");
        let thread_generation: i64 = thread.get("generation");
        let activation = sqlx::query(
            r#"SELECT status, generation FROM thread_activations
               WHERE id = $1 FOR UPDATE"#,
        )
        .bind(activation_id)
        .fetch_one(&mut *tx)
        .await?;
        let activation_status: String = activation.get("status");
        let locked_activation_generation: i64 = activation.get("generation");
        if activation_status != ThreadActivationStatus::Running.as_str() {
            return Err(format!(
                "Thread Activation '{activation_id}' 不是 running，不能接管模型输入 Signal ({activation_status})"
            )
            .into());
        }
        if activation_generation != locked_activation_generation
            || activation_generation != thread_generation
        {
            return Err(format!("Thread Activation '{activation_id}' generation 已过期").into());
        }

        let mut next_ordinal: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(ordinal), -1) + 1 FROM activation_signals WHERE activation_id = $1",
        )
        .bind(activation_id)
        .fetch_one(&mut *tx)
        .await?;
        let mut selected_event_ids = HashSet::new();
        for event_id in event_ids {
            let row = sqlx::query(
                r#"SELECT signals.*, links.activation_id AS owner_activation_id
                   FROM thread_signals signals
                   LEFT JOIN activation_signals links ON links.signal_id = signals.id
                   WHERE signals.event_id = $1
                   FOR UPDATE OF signals"#,
            )
            .bind(&event_id)
            .fetch_optional(&mut *tx)
            .await?;
            let Some(row) = row else {
                // Tool Outputs with wake_policy=none intentionally have no
                // scheduler Signal and therefore require no ownership record.
                continue;
            };
            let signal = signal_from_row(&row)?;
            if signal.thread_id != thread_id || signal.thread_generation as i64 != thread_generation
            {
                return Err(format!(
                    "Thread Signal '{}' 不属于 Activation '{}' 的当前 Thread generation",
                    signal.id, activation_id
                )
                .into());
            }
            let owner: Option<String> = row.get("owner_activation_id");
            if let Some(owner) = owner {
                if owner != activation_id {
                    return Err(format!(
                        "Thread Signal '{}' 已由 Activation '{}' 接管",
                        signal.id, owner
                    )
                    .into());
                }
                selected_event_ids.insert(signal.event_id);
                continue;
            }
            if signal.status != ThreadSignalStatus::Pending {
                return Err(format!(
                    "Thread Signal '{}' 状态为 '{}' 但没有 Activation owner",
                    signal.id,
                    signal.status.as_str()
                )
                .into());
            }
            sqlx::query(
                "INSERT INTO activation_signals (activation_id, signal_id, ordinal) VALUES ($1, $2, $3)",
            )
            .bind(activation_id)
            .bind(&signal.id)
            .bind(next_ordinal)
            .execute(&mut *tx)
            .await?;
            let claimed = sqlx::query(
                r#"UPDATE thread_signals
                   SET status = 'claimed', claimed_at = $1
                   WHERE id = $2 AND thread_generation = $3 AND status = 'pending'"#,
            )
            .bind(&now)
            .bind(&signal.id)
            .bind(thread_generation)
            .execute(&mut *tx)
            .await?;
            if claimed.rows_affected() != 1 {
                return Err(
                    format!("Thread Signal '{}' 在模型输入接管时发生并发冲突", signal.id).into(),
                );
            }
            next_ordinal = next_ordinal.saturating_add(1);
            selected_event_ids.insert(signal.event_id);
        }
        tx.commit().await?;
        Ok(self
            .list_activation_signals(activation_id)
            .await?
            .into_iter()
            .filter(|signal| selected_event_ids.contains(&signal.event_id))
            .collect())
    }

    async fn next_pending_thread_signal(
        &self,
        thread_id: &str,
    ) -> Result<Option<ThreadSignalRecord>, StoreError> {
        sqlx::query(
            r#"SELECT signals.* FROM thread_signals signals
               JOIN threads thread ON thread.id = signals.thread_id
               WHERE signals.thread_id = $1 AND signals.status = 'pending'
                 AND signals.thread_generation = thread.generation
               ORDER BY signals.sequence, signals.id LIMIT 1"#,
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
                admission_rank, status, created_at, updated_at)
               VALUES ($1, 1, (SELECT generation FROM threads WHERE root_turn_id = $2), $3, $4, $5, $6, $7, $8, $9, $10, $2,
                 COALESCE((SELECT CASE
                   WHEN event.type = 'user_message' THEN 0
                   WHEN $9 = 'chat/thread_completion_ready' THEN 1
                   WHEN event.objective_id IS NOT NULL
                     OR event.payload ? 'objective_evaluation_id'
                     OR left(event.topic, 10) = 'objective/' THEN 2
                   WHEN event.payload @> '{"runtime_maintenance": true}'::jsonb
                     OR event.topic IN ('runtime/context_maintenance', 'chat/context_maintenance') THEN 4
                   ELSE 3 END
                 FROM events AS event WHERE event.id = $7), 3),
                 'queued', $11, $11)
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

    async fn list_thread_activations_by_ids(
        &self,
        context_id: &str,
        activation_ids: &[String],
    ) -> Result<Vec<ThreadActivationRecord>, StoreError> {
        let mut records = Vec::new();
        for activation_ids in activation_ids.chunks(500) {
            let mut query = QueryBuilder::<Postgres>::new(
                "SELECT * FROM thread_activations WHERE context_id = ",
            );
            query.push_bind(context_id).push(" AND id IN (");
            {
                let mut values = query.separated(", ");
                for activation_id in activation_ids {
                    values.push_bind(activation_id);
                }
            }
            query.push(") ORDER BY created_at, id");
            records.extend(
                query
                    .build()
                    .fetch_all(&self.pool)
                    .await?
                    .iter()
                    .map(activation_from_row)
                    .collect::<Result<Vec<_>, _>>()?,
            );
        }
        records.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(records)
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
                   AND status IN ('queued', 'running')
                   ORDER BY created_at, id"#,
            )
            .bind(context_id)
            .fetch_all(&self.pool)
            .await?
        };
        rows.iter().map(activation_from_row).collect()
    }

    async fn list_recent_terminal_thread_activations(
        &self,
        context_id: &str,
        limit: usize,
    ) -> Result<Vec<ThreadActivationRecord>, StoreError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let rows = sqlx::query(
            r#"SELECT * FROM thread_activations
               WHERE context_id = $1 AND status IN ('completed', 'cancelled', 'failed')
               ORDER BY updated_at DESC, id
               LIMIT $2"#,
        )
        .bind(context_id)
        .bind(i64::try_from(limit).map_err(|_| "Activation 查询上限超出 BIGINT 范围")?)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(activation_from_row).collect()
    }

    async fn list_thread_activations_by_root(
        &self,
        context_id: &str,
        root_turn_id: &str,
    ) -> Result<Vec<ThreadActivationRecord>, StoreError> {
        let rows = sqlx::query(
            r#"SELECT * FROM thread_activations
               WHERE context_id = $1 AND root_turn_id = $2
               ORDER BY created_at, id"#,
        )
        .bind(context_id)
        .bind(root_turn_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(activation_from_row).collect()
    }

    async fn list_thread_activations_by_roots(
        &self,
        context_id: &str,
        root_turn_ids: &[String],
    ) -> Result<Vec<ThreadActivationRecord>, StoreError> {
        if root_turn_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut query =
            QueryBuilder::<Postgres>::new("SELECT * FROM thread_activations WHERE context_id = ");
        query.push_bind(context_id).push(" AND root_turn_id IN (");
        {
            let mut values = query.separated(", ");
            for root_turn_id in root_turn_ids {
                values.push_bind(root_turn_id);
            }
        }
        query.push(") ORDER BY created_at, id");
        let rows = query.build().fetch_all(&self.pool).await?;
        rows.iter().map(activation_from_row).collect()
    }

    async fn list_scheduler_thread_activations_by_roots(
        &self,
        context_id: &str,
        root_turn_ids: &[String],
        terminal_limit_per_root: usize,
    ) -> Result<Vec<ThreadActivationRecord>, StoreError> {
        if root_turn_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut query = QueryBuilder::<Postgres>::new(
            "WITH selected AS MATERIALIZED (SELECT * FROM thread_activations WHERE context_id = ",
        );
        query.push_bind(context_id).push(" AND root_turn_id IN (");
        {
            let mut values = query.separated(", ");
            for root_turn_id in root_turn_ids {
                values.push_bind(root_turn_id);
            }
        }
        query.push(
            r#")), terminal_page AS (
                 SELECT id FROM (
                   SELECT id,
                          ROW_NUMBER() OVER (
                            PARTITION BY root_turn_id
                            ORDER BY updated_at DESC, id DESC
                          ) AS terminal_rank
                   FROM selected
                   WHERE status IN ('completed', 'cancelled', 'failed')
                 ) ranked WHERE terminal_rank <= "#,
        );
        query.push_bind(i64::try_from(terminal_limit_per_root)?);
        query.push(
            r#") SELECT * FROM selected
                WHERE status IN ('queued', 'running')
                   OR id IN (SELECT id FROM terminal_page)
                ORDER BY created_at, id"#,
        );
        let rows = query.build().fetch_all(&self.pool).await?;
        rows.iter().map(activation_from_row).collect()
    }

    async fn list_active_thread_activations(
        &self,
        limit: usize,
    ) -> Result<Vec<ThreadActivationRecord>, StoreError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let rows = sqlx::query(
            r#"SELECT *
               FROM thread_activations
               WHERE status IN ('queued', 'running')
               ORDER BY updated_at DESC, id
               LIMIT $1"#,
        )
        .bind(i64::try_from(limit)?)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(activation_from_row).collect()
    }

    async fn list_active_thread_activations_for_contexts(
        &self,
        context_ids: &[String],
        limit: usize,
    ) -> Result<Vec<ThreadActivationRecord>, StoreError> {
        if context_ids.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let mut query: QueryBuilder<'_, Postgres> = QueryBuilder::new(
            "SELECT * FROM thread_activations WHERE status IN ('queued', 'running') AND context_id IN (",
        );
        let mut separated = query.separated(", ");
        for context_id in context_ids {
            separated.push_bind(context_id);
        }
        separated.push_unseparated(") ORDER BY updated_at DESC, id LIMIT ");
        query.push_bind(i64::try_from(limit)?);
        query
            .build()
            .fetch_all(&self.pool)
            .await?
            .iter()
            .map(activation_from_row)
            .collect()
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
        let candidate_limit = i64::try_from(limit.saturating_mul(4).max(32))?;
        let limit_i64 = i64::try_from(limit)?;
        let reserved = dialogue_delivery_reserved_queue_slots.min(limit.saturating_sub(1));
        let general_limit = limit_i64.saturating_sub(i64::try_from(reserved)?);
        let rows = sqlx::query(
            r#"WITH raw_candidates AS (
                 (SELECT * FROM thread_activations
                  WHERE status = 'queued' AND admission_rank = 0
                  ORDER BY created_at, id LIMIT $1)
                 UNION ALL
                 (SELECT * FROM thread_activations
                  WHERE status = 'queued' AND admission_rank = 1
                  ORDER BY created_at, id LIMIT $1)
                 UNION ALL
                 (SELECT * FROM thread_activations
                  WHERE status = 'queued' AND admission_rank = 2
                  ORDER BY created_at, id LIMIT $1)
                 UNION ALL
                 (SELECT * FROM thread_activations
                  WHERE status = 'queued' AND admission_rank = 3
                  ORDER BY created_at, id LIMIT $1)
                 UNION ALL
                 (SELECT * FROM thread_activations
                  WHERE status = 'queued' AND admission_rank = 4
                  ORDER BY created_at, id LIMIT $1)
               ), eligible AS (
                 SELECT activations.*
                 FROM raw_candidates activations
                 JOIN threads ON threads.root_turn_id = activations.root_turn_id
                 WHERE threads.executor_kind != 'artifact_transfer'
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
                           AND running.dialogue_lane_released_at IS NULL
                           AND running.id != activations.id
                           AND running.root_turn_id != activations.root_turn_id
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
                             CASE WHEN older.parent_activation_id IS NOT NULL THEN 0 ELSE 1 END
                               < CASE WHEN activations.parent_activation_id IS NOT NULL THEN 0 ELSE 1 END
                             OR (
                               CASE WHEN older.parent_activation_id IS NOT NULL THEN 0 ELSE 1 END
                                 = CASE WHEN activations.parent_activation_id IS NOT NULL THEN 0 ELSE 1 END
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
                     )
                   )
               ), aged AS (
                 SELECT eligible.*,
                   GREATEST(0, admission_rank - FLOOR(
                     GREATEST(0, EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - created_at::timestamptz)) * 1000)
                     / $2
                   )::BIGINT) AS effective_rank
                 FROM eligible
               ), reserved_candidates AS (
                 SELECT * FROM aged WHERE admission_rank IN (0, 1)
                 ORDER BY effective_rank, created_at, id LIMIT $3
               ), general_candidates AS (
                 SELECT * FROM aged WHERE admission_rank NOT IN (0, 1)
                 ORDER BY effective_rank, created_at, id LIMIT $4
               ), candidates AS (
                 SELECT * FROM reserved_candidates UNION ALL SELECT * FROM general_candidates
               )
               SELECT * FROM candidates ORDER BY effective_rank, created_at, id LIMIT $3"#,
        )
        .bind(candidate_limit)
        .bind(aging_promotion_interval_ms.max(1) as f64)
        .bind(limit_i64)
        .bind(general_limit)
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|row| {
                let activation = activation_from_row(row)?;
                let class = match row.get::<i16, _>("admission_rank") {
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
                     AND running.dialogue_lane_released_at IS NULL
                     AND running.id != candidate.id
                     AND running.root_turn_id != candidate.root_turn_id
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
                       CASE WHEN older.parent_activation_id IS NOT NULL THEN 0 ELSE 1 END
                         < CASE WHEN candidate.parent_activation_id IS NOT NULL THEN 0 ELSE 1 END
                       OR (
                         CASE WHEN older.parent_activation_id IS NOT NULL THEN 0 ELSE 1 END
                           = CASE WHEN candidate.parent_activation_id IS NOT NULL THEN 0 ELSE 1 END
                         AND (
                           older.trigger_sequence < candidate.trigger_sequence
                           OR (
                             older.trigger_sequence = candidate.trigger_sequence
                             AND older.id < candidate.id
                           )
                         )
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

    async fn release_dialogue_turn_activation(
        &self,
        activation_id: &str,
        released_at: DateTime<Utc>,
    ) -> Result<bool, StoreError> {
        let released_at = released_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE thread_activations
               SET dialogue_lane_released_at = $1, revision = revision + 1,
                   updated_at = $1
               WHERE id = $2 AND status = 'running'
                 AND dialogue_lane_released_at IS NULL"#,
        )
        .bind(released_at)
        .bind(activation_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
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
                             AND activation.dialogue_lane_released_at IS NULL
                             AND activation.id != $2
                             AND activation.root_turn_id != (
                               SELECT root_turn_id FROM thread_activations WHERE id = $2
                             )
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
                           ORDER BY
                             CASE WHEN activation.parent_activation_id IS NOT NULL THEN 0 ELSE 1 END,
                             activation.trigger_sequence,
                             activation.id
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
                      thread.generation AS thread_generation,
                      thread.parent_thread_id AS parent_thread_id,
                      thread.thread_group_id AS thread_group_id,
                      thread.completion_contract_json AS completion_contract_json,
                      thread.kind AS thread_kind,
                      thread.supervisor_kind AS supervisor_kind,
                      thread.supervisor_id AS supervisor_id,
                      thread.origin_evaluation_id AS origin_evaluation_id
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
        let parent_thread_id: Option<String> = activation_route.get("parent_thread_id");
        let thread_group_id: Option<String> = activation_route.get("thread_group_id");
        let supervisor_kind = match activation_route
            .get::<String, _>("supervisor_kind")
            .as_str()
        {
            "thread" => ThreadSupervisorKind::Thread,
            "evaluation" => ThreadSupervisorKind::Evaluation,
            "objective" => ThreadSupervisorKind::Objective,
            "runtime" => ThreadSupervisorKind::Runtime,
            "none" => ThreadSupervisorKind::None,
            "legacy" => ThreadSupervisorKind::Legacy,
            other => return Err(format!("未知 Thread supervisor kind: {other}").into()),
        };
        let supervisor_id: Option<String> = activation_route.get("supervisor_id");
        let thread_kind: String = activation_route.get("thread_kind");
        let origin_evaluation_id: Option<String> = activation_route.get("origin_evaluation_id");
        if activation_generation != thread_generation {
            tx.commit().await?;
            return Ok(ActivationOutcomeCommit::StaleGeneration);
        }
        if let Some(event_id) = sqlx::query_scalar::<_, String>(
            "SELECT event_id FROM evaluation_outcomes WHERE activation_id = $1",
        )
        .bind(activation_id)
        .fetch_optional(&mut *tx)
        .await?
        {
            tx.commit().await?;
            return Ok(ActivationOutcomeCommit::Existing { event_id });
        }
        if let Some(event_id) = sqlx::query_scalar::<_, String>(
            "SELECT event_id FROM thread_outcomes WHERE root_turn_id = $1",
        )
        .bind(root_turn_id)
        .fetch_optional(&mut *tx)
        .await?
        {
            tx.commit().await?;
            return Ok(ActivationOutcomeCommit::Existing { event_id });
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
        if disposition == "provider_wait" {
            let resource = event
                .payload
                .get("provider_resource")
                .and_then(JsonValue::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or("Provider wait outcome 缺少 provider_resource")?;
            let dependency_generation = event
                .payload
                .get("provider_wait_generation")
                .and_then(JsonValue::as_u64)
                .filter(|value| *value > 0)
                .ok_or("Provider wait outcome 缺少有效的 provider_wait_generation")?;
            let thread_generation_u64 = u64::try_from(thread_generation)?;
            let dependency_id = stable_scheduler_dependency_id(
                SchedulerDependencyOwnerKind::Thread,
                thread_id,
                thread_generation_u64,
                SchedulerDependencyKind::Resource,
                resource,
                dependency_generation,
            );
            append_event_in_tx(&mut tx, event).await?;
            let activation_terminal = sqlx::query(
                r#"UPDATE thread_activations
                   SET revision = revision + 1, status = 'completed', claimed_by = NULL,
                       lease_expires_at = NULL, updated_at = $1
                   WHERE id = $2 AND generation = $3 AND status = 'running'"#,
            )
            .bind(&now)
            .bind(activation_id)
            .bind(activation_generation)
            .execute(&mut *tx)
            .await?;
            if activation_terminal.rows_affected() != 1 {
                return Err(format!(
                    "Provider wait outcome 无法原子结束 Activation '{}'",
                    activation_id
                )
                .into());
            }
            sqlx::query(
                r#"UPDATE thread_signals
                   SET status = 'acknowledged', acknowledged_at = $1
                   WHERE id IN (
                     SELECT signal_id FROM activation_signals WHERE activation_id = $2
                   ) AND status = 'claimed'"#,
            )
            .bind(&now)
            .bind(activation_id)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                r#"UPDATE scheduler_dependencies
                   SET status = 'cancelled', updated_at = $1
                   WHERE owner_kind = 'thread' AND owner_id = $2
                     AND owner_generation = $3 AND dependency_kind = 'resource'
                     AND dependency_id = $4 AND status = 'pending' AND id <> $5"#,
            )
            .bind(&now)
            .bind(thread_id)
            .bind(thread_generation)
            .bind(resource)
            .bind(&dependency_id)
            .execute(&mut *tx)
            .await?;
            let metadata = serde_json::json!({
                "source": "provider_wait",
                "context_id": event.payload.get("context_id").cloned().unwrap_or(JsonValue::Null),
                "session_id": session_id,
                "activation_id": activation_id,
                "wait_event_id": event.id,
                "runtime_failure_kind": event.payload.get("runtime_failure_kind").cloned().unwrap_or(JsonValue::Null),
                "runtime_failure_stage": event.payload.get("runtime_failure_stage").cloned().unwrap_or(JsonValue::Null),
                "runtime_failure_incident_id": event.payload.get("runtime_failure_incident_id").cloned().unwrap_or(JsonValue::Null),
            });
            let inserted = sqlx::query(
                r#"INSERT INTO scheduler_dependencies
                   (id, owner_kind, owner_id, owner_generation,
                    dependency_kind, dependency_id, dependency_generation,
                    required, status, metadata_json, created_at, updated_at)
                   VALUES ($1, 'thread', $2, $3, 'resource', $4, $5,
                           TRUE, 'pending', $6, $7, $7)
                   ON CONFLICT(id) DO NOTHING"#,
            )
            .bind(&dependency_id)
            .bind(thread_id)
            .bind(thread_generation)
            .bind(resource)
            .bind(i64::try_from(dependency_generation)?)
            .bind(&metadata)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            if inserted.rows_affected() != 1 {
                let row = sqlx::query("SELECT * FROM scheduler_dependencies WHERE id = $1")
                    .bind(&dependency_id)
                    .fetch_one(&mut *tx)
                    .await?;
                let current_owner_id: String = row.get("owner_id");
                let current_owner_generation: i64 = row.get("owner_generation");
                let current_kind: String = row.get("dependency_kind");
                let current_resource: String = row.get("dependency_id");
                let current_dependency_generation: i64 = row.get("dependency_generation");
                let current_status: String = row.get("status");
                if current_owner_id != thread_id
                    || current_owner_generation != thread_generation
                    || current_kind != "resource"
                    || current_resource != resource
                    || current_dependency_generation != i64::try_from(dependency_generation)?
                    || current_status != "pending"
                {
                    return Err(format!(
                        "Provider wait dependency ID '{}' 已被不同内容占用",
                        dependency_id
                    )
                    .into());
                }
            }
            let thread_update = sqlx::query(
                r#"UPDATE threads SET revision = revision + 1, updated_at = $1
                   WHERE id = $2 AND generation = $3 AND status = 'open'"#,
            )
            .bind(&now)
            .bind(thread_id)
            .bind(thread_generation)
            .execute(&mut *tx)
            .await?;
            if thread_update.rows_affected() != 1 {
                return Err(
                    format!("Provider wait outcome 的 Thread '{}' 已终结", thread_id).into(),
                );
            }
            sqlx::query(
                r#"INSERT INTO evaluation_outcomes
                   (activation_id, session_id, disposition, event_id, created_at)
                   VALUES ($1, $2, $3, $4, $5)"#,
            )
            .bind(activation_id)
            .bind(session_id)
            .bind(disposition)
            .bind(&event.id)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            let activity_at = event
                .timestamp
                .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
            sqlx::query("UPDATE sessions SET updated_at = $1, last_activity_at = $1 WHERE id = $2")
                .bind(activity_at)
                .bind(session_id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            return Ok(ActivationOutcomeCommit::Suspended { dependency_id });
        }
        let result_text = event.payload.get("text").and_then(JsonValue::as_str);
        let terminal_kind = event
            .payload
            .get("terminal_kind")
            .and_then(JsonValue::as_str)
            .filter(|value| matches!(*value, "completed" | "failed" | "cancelled"))
            .unwrap_or_else(|| {
                if event.topic == "chat/reply"
                    && event.payload.get("runtime_failure_kind").is_some()
                {
                    ThreadLifecycle::Failed.as_str()
                } else {
                    ThreadLifecycle::Completed.as_str()
                }
            });
        if terminal_kind == ThreadLifecycle::Completed.as_str() {
            let open_group_ids = sqlx::query_scalar::<_, String>(
                r#"SELECT id FROM thread_groups
                   WHERE ((supervisor_kind = 'thread'
                           AND supervisor_id = $1
                           AND generation = $2)
                          OR (supervisor_kind = 'evaluation'
                              AND supervisor_id = $3))
                     AND status = 'open'
                     AND terminal_count < required_count
                   ORDER BY created_at, id"#,
            )
            .bind(thread_id)
            .bind(thread_generation)
            .bind(activation_id)
            .fetch_all(&mut *tx)
            .await?;
            if !open_group_ids.is_empty() {
                tx.commit().await?;
                return Ok(ActivationOutcomeCommit::DeferredByOpenThreadGroups {
                    group_ids: open_group_ids,
                });
            }
        }
        let outcome_id = format!("outcome_{thread_id}_g{thread_generation}");
        let artifact_refs = event
            .payload
            .get("artifact_refs")
            .and_then(JsonValue::as_array)
            .cloned()
            .unwrap_or_default();
        let mut evidence_refs = event
            .payload
            .get("evidence_refs")
            .and_then(JsonValue::as_array)
            .cloned()
            .unwrap_or_default();
        if evidence_refs.is_empty() {
            evidence_refs.push(JsonValue::String(event.id.clone()));
        }
        let reported_check_results = event
            .payload
            .get("check_results")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        let reported_failures = event
            .payload
            .get("unresolved_failures")
            .and_then(JsonValue::as_array)
            .cloned()
            .unwrap_or_default();
        let completion_contract: JsonValue = activation_route.get("completion_contract_json");
        let terminal_lifecycle = match terminal_kind {
            "completed" => ThreadLifecycle::Completed,
            "failed" => ThreadLifecycle::Failed,
            "cancelled" => ThreadLifecycle::Cancelled,
            other => return Err(format!("未知 Thread terminal kind: {other}").into()),
        };
        let mut completion = evaluate_thread_completion_contract(
            &completion_contract,
            terminal_lifecycle,
            result_text,
            &artifact_refs,
            &evidence_refs,
            &reported_check_results,
            &reported_failures,
        );
        if terminal_lifecycle == ThreadLifecycle::Failed
            && completion.unresolved_failures.is_empty()
        {
            completion.unresolved_failures.push(
                event
                    .payload
                    .get("runtime_failure_kind")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("thread_failed")
                    .to_string(),
            );
        }
        let is_objective_primary_execution = thread_kind == ThreadKind::Execution.as_str()
            && supervisor_kind == ThreadSupervisorKind::Objective
            && supervisor_id.is_some()
            && origin_evaluation_id.is_none();
        let routed_objective_id = event
            .payload
            .get("objective_id")
            .and_then(JsonValue::as_str);
        let routed_evaluation_id = event
            .payload
            .get("objective_evaluation_id")
            .and_then(JsonValue::as_str);
        let objective_evaluation_elapsed_seconds = i64::try_from(
            event
                .payload
                .get("objective_evaluation_elapsed_seconds")
                .and_then(JsonValue::as_u64)
                .unwrap_or_default(),
        )?;
        let completion_objective_id = routed_objective_id.or_else(|| {
            is_objective_primary_execution
                .then_some(supervisor_id.as_deref())
                .flatten()
        });
        let mut objective_is_terminal = false;
        if let Some(objective_id) = completion_objective_id {
            let row = sqlx::query(
                r#"SELECT status, active_evaluation_id, completion_intent_json
                   FROM objectives WHERE id = $1 FOR UPDATE"#,
            )
            .bind(objective_id)
            .fetch_optional(&mut *tx)
            .await?;
            if let Some(row) = row {
                let status: String = row.get("status");
                objective_is_terminal =
                    matches!(status.as_str(), "completed" | "cancelled" | "failed");
                let active_evaluation_id: Option<String> = row.get("active_evaluation_id");
                let intent_json: Option<JsonValue> = row.get("completion_intent_json");
                if !objective_is_terminal
                    && terminal_lifecycle == ThreadLifecycle::Completed
                    && status == ObjectiveStatus::Active.as_str()
                {
                    if let Some(intent_json) = intent_json {
                        let intent: ObjectiveCompletionIntent =
                            serde_json::from_value(intent_json.clone())?;
                        let routed_completion_matches = routed_objective_id == Some(objective_id)
                            && routed_evaluation_id == Some(intent.evaluation_id.as_str());
                        let primary_completion_matches = is_objective_primary_execution
                            && supervisor_id.as_deref() == Some(objective_id);
                        if (routed_completion_matches || primary_completion_matches)
                            && intent.activation_id == activation_id
                            && active_evaluation_id.as_deref()
                                == Some(intent.evaluation_id.as_str())
                        {
                            let completed = sqlx::query(
                                r#"UPDATE objectives
                                   SET status = 'completed', status_reason = $1,
                                       wait_condition_json = NULL,
                                       completion_intent_json = NULL,
                                       active_evaluation_id = NULL,
                                       evaluation_lease_expires_at = NULL,
                                       time_used_seconds = time_used_seconds + $2,
                                       revision = revision + 1, updated_at = $3
                                   WHERE id = $4 AND status = 'active'
                                     AND active_evaluation_id = $5
                                     AND completion_intent_json = $6"#,
                            )
                            .bind(&intent.reason)
                            .bind(objective_evaluation_elapsed_seconds)
                            .bind(&now)
                            .bind(objective_id)
                            .bind(&intent.evaluation_id)
                            .bind(&intent_json)
                            .execute(&mut *tx)
                            .await?;
                            if completed.rows_affected() != 1 {
                                return Err(format!(
                                    "Objective '{}' completion intent 无法原子提交",
                                    objective_id
                                )
                                .into());
                            }
                            objective_is_terminal = true;
                        }
                    }
                }
            }
        }
        if is_objective_primary_execution && !objective_is_terminal {
            append_event_in_tx(&mut tx, event).await?;
            let activation_terminal_status = match terminal_lifecycle {
                ThreadLifecycle::Completed => ThreadActivationStatus::Succeeded,
                ThreadLifecycle::Failed => ThreadActivationStatus::Failed,
                ThreadLifecycle::Cancelled => ThreadActivationStatus::Cancelled,
                ThreadLifecycle::Open => {
                    return Err("Objective Activation outcome 不能以 open lifecycle 收口".into());
                }
            };
            let activation_terminal = sqlx::query(
                r#"UPDATE thread_activations
                   SET revision = revision + 1, status = $1, claimed_by = NULL,
                       lease_expires_at = NULL, updated_at = $2
                   WHERE id = $3 AND generation = $4 AND status = 'running'"#,
            )
            .bind(activation_status_storage(activation_terminal_status))
            .bind(&now)
            .bind(activation_id)
            .bind(activation_generation)
            .execute(&mut *tx)
            .await?;
            if activation_terminal.rows_affected() != 1 {
                return Err(format!(
                    "Objective Activation outcome 无法原子提交 Activation '{activation_id}' 终态"
                )
                .into());
            }
            sqlx::query(
                r#"UPDATE thread_signals SET status = 'acknowledged', acknowledged_at = $1
                   WHERE id IN (
                     SELECT signal_id FROM activation_signals WHERE activation_id = $2
                   ) AND status = 'claimed'"#,
            )
            .bind(&now)
            .bind(activation_id)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                r#"INSERT INTO evaluation_outcomes
                   (activation_id, session_id, disposition, event_id, created_at)
                   VALUES ($1, $2, $3, $4, $5)"#,
            )
            .bind(activation_id)
            .bind(session_id)
            .bind(disposition)
            .bind(&event.id)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            let activity_at = event
                .timestamp
                .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
            sqlx::query("UPDATE sessions SET updated_at = $1, last_activity_at = $1 WHERE id = $2")
                .bind(activity_at)
                .bind(session_id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            return Ok(ActivationOutcomeCommit::Committed {
                ready_signal_event_ids: Vec::new(),
                ready_supervisor_event_ids: Vec::new(),
            });
        }
        let check_results = completion.check_results;
        let unresolved_failures = completion
            .unresolved_failures
            .iter()
            .cloned()
            .map(JsonValue::String)
            .collect::<Vec<_>>();
        append_event_in_tx(&mut tx, event).await?;
        let terminal_event_sequence =
            sqlx::query_scalar::<_, i64>("SELECT sequence FROM events WHERE id = $1")
                .bind(&event.id)
                .fetch_one(&mut *tx)
                .await?;
        let result = sqlx::query(
            r#"INSERT INTO thread_outcomes
               (thread_id, outcome_id, thread_generation, root_turn_id, activation_id,
                session_id, terminal_kind, disposition, event_id, summary,
                artifact_refs_json, evidence_refs_json, check_results_json,
                unresolved_failures_json, terminal_event_sequence, created_at, delivered_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                       $13, $14, $15, $16, $17)
               ON CONFLICT(root_turn_id) DO NOTHING"#,
        )
        .bind(thread_id)
        .bind(&outcome_id)
        .bind(thread_generation)
        .bind(root_turn_id)
        .bind(activation_id)
        .bind(session_id)
        .bind(terminal_kind)
        .bind(disposition)
        .bind(&event.id)
        .bind(result_text)
        .bind(JsonValue::Array(artifact_refs.clone()))
        .bind(JsonValue::Array(evidence_refs.clone()))
        .bind(check_results.clone())
        .bind(JsonValue::Array(unresolved_failures.clone()))
        .bind(terminal_event_sequence)
        .bind(&now)
        .bind(if event.topic == "chat/reply" {
            Some(now.as_str())
        } else {
            None
        })
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() == 0 {
            let existing = sqlx::query_scalar::<_, String>(
                "SELECT event_id FROM thread_outcomes WHERE root_turn_id = $1",
            )
            .bind(root_turn_id)
            .fetch_one(&mut *tx)
            .await?;
            tx.rollback().await?;
            return Ok(ActivationOutcomeCommit::Existing { event_id: existing });
        }
        let thread_status = terminal_kind;
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
        sqlx::query(
            r#"UPDATE scheduler_dependencies
               SET status = 'cancelled', updated_at = $1
               WHERE owner_kind = 'thread' AND owner_id = $2
                 AND owner_generation = $3 AND status = 'pending'"#,
        )
        .bind(&now)
        .bind(thread_id)
        .bind(thread_generation)
        .execute(&mut *tx)
        .await?;
        let mut ready_signal_event_ids = Vec::new();
        let mut ready_supervisor_event_ids = Vec::new();
        if let Some(group_id) = thread_group_id.as_deref() {
            let member_status = match terminal_kind {
                "completed" if completion.passed => "completed",
                "completed" => "failed",
                "cancelled" => "cancelled",
                _ => "failed",
            };
            let member = sqlx::query(
                r#"UPDATE thread_group_members
                   SET status = $1, outcome_id = $2, updated_at = $3
                   WHERE group_id = $4 AND thread_id = $5 AND status = 'pending'"#,
            )
            .bind(member_status)
            .bind(&outcome_id)
            .bind(&now)
            .bind(group_id)
            .bind(thread_id)
            .execute(&mut *tx)
            .await?;
            if member.rows_affected() == 1 {
                let group = sqlx::query(
                    r#"SELECT policy, required_count, status, supervisor_kind,
                              supervisor_id, generation, context_id, session_id,
                              completion_contract_json
                       FROM thread_groups WHERE id = $1 FOR UPDATE"#,
                )
                .bind(group_id)
                .fetch_one(&mut *tx)
                .await?;
                let required_count = u64::try_from(group.get::<i64, _>("required_count"))?;
                let counts = sqlx::query(
                    r#"SELECT
                         COUNT(*) FILTER (WHERE required AND status <> 'pending')
                           AS terminal_count,
                         COUNT(*) FILTER (WHERE required AND status = 'completed')
                           AS successful_count
                       FROM thread_group_members WHERE group_id = $1"#,
                )
                .bind(group_id)
                .fetch_one(&mut *tx)
                .await?;
                let terminal_count = u64::try_from(counts.get::<i64, _>("terminal_count"))?;
                let successful_count = u64::try_from(counts.get::<i64, _>("successful_count"))?;
                let policy = match group.get::<String, _>("policy").as_str() {
                    "all" => ThreadGroupPolicy::All,
                    "any" => ThreadGroupPolicy::Any,
                    other => {
                        return Err(format!("未知 Thread Group policy: {other}").into());
                    }
                };
                let current_status = match group.get::<String, _>("status").as_str() {
                    "open" => ThreadGroupStatus::Open,
                    "satisfied" => ThreadGroupStatus::Satisfied,
                    "failed" => ThreadGroupStatus::Failed,
                    "cancelled" => ThreadGroupStatus::Cancelled,
                    other => {
                        return Err(format!("未知 Thread Group status: {other}").into());
                    }
                };
                let group_contract: JsonValue = group.get("completion_contract_json");
                let group_evaluation = evaluate_thread_group_contract(
                    policy,
                    required_count,
                    terminal_count,
                    successful_count,
                    &group_contract,
                );
                let next_status = group_evaluation.status;
                let terminal_summary = serde_json::json!({
                    "group_id": group_id,
                    "status": next_status.as_str(),
                    "policy": policy.as_str(),
                    "required_count": required_count,
                    "terminal_count": terminal_count,
                    "successful_count": successful_count,
                    "completion_contract": group_contract,
                    "contract_results": group_evaluation.contract_results,
                    "last_outcome_id": outcome_id,
                    "last_thread_id": thread_id,
                });
                let barrier_event_id = format!(
                    "thread_group_barrier_{}_g{}",
                    group_id,
                    group.get::<i64, _>("generation")
                );
                let group_update = sqlx::query(
                    r#"UPDATE thread_groups
                       SET revision = revision + 1, terminal_count = $1,
                           successful_count = $2, status = $3,
                           terminal_summary_json = $4, barrier_event_id = $5,
                           updated_at = $6, satisfied_at = $7
                       WHERE id = $8 AND status = 'open'"#,
                )
                .bind(i64::try_from(terminal_count)?)
                .bind(i64::try_from(successful_count)?)
                .bind(next_status.as_str())
                .bind(&terminal_summary)
                .bind(if next_status.is_terminal() {
                    Some(barrier_event_id.as_str())
                } else {
                    None
                })
                .bind(&now)
                .bind(if next_status.is_terminal() {
                    Some(now.as_str())
                } else {
                    None
                })
                .bind(group_id)
                .execute(&mut *tx)
                .await?;
                if current_status == ThreadGroupStatus::Open
                    && next_status.is_terminal()
                    && group_update.rows_affected() == 1
                {
                    let supervisor_kind = match group.get::<String, _>("supervisor_kind").as_str() {
                        "thread" => ThreadSupervisorKind::Thread,
                        "evaluation" => ThreadSupervisorKind::Evaluation,
                        "objective" => ThreadSupervisorKind::Objective,
                        "runtime" => ThreadSupervisorKind::Runtime,
                        "none" => ThreadSupervisorKind::None,
                        "legacy" => ThreadSupervisorKind::Legacy,
                        other => {
                            return Err(format!("未知 Thread supervisor kind: {other}").into());
                        }
                    };
                    let supervisor_id: String = group.get("supervisor_id");
                    let group_context_id: String = group.get("context_id");
                    let group_session_id: String = group.get("session_id");
                    let mut payload = serde_json::Map::new();
                    payload.insert(
                        "context_id".to_string(),
                        JsonValue::String(group_context_id),
                    );
                    payload.insert(
                        "thread_group_id".to_string(),
                        JsonValue::String(group_id.to_string()),
                    );
                    payload.insert(
                        "thread_group_status".to_string(),
                        JsonValue::String(next_status.as_str().to_string()),
                    );
                    payload.insert(
                        "wake_policy".to_string(),
                        JsonValue::String("direct_signal".into()),
                    );
                    payload.insert("terminal_summary".to_string(), terminal_summary);
                    let (topic, event_type, signal_target_thread_id) = match supervisor_kind {
                        ThreadSupervisorKind::Thread | ThreadSupervisorKind::Evaluation => {
                            let parent_id = parent_thread_id.as_deref().ok_or_else(|| {
                                format!(
                                    "attached Thread Group '{}' 的成员 '{}' 缺少 parent_thread_id",
                                    group_id, thread_id
                                )
                            })?;
                            let parent = sqlx::query(
                                "SELECT session_id, root_turn_id, status FROM threads WHERE id = $1",
                            )
                            .bind(parent_id)
                            .fetch_one(&mut *tx)
                            .await?;
                            payload.insert(
                                "session_id".to_string(),
                                JsonValue::String(parent.get("session_id")),
                            );
                            payload.insert(
                                "thread_id".to_string(),
                                JsonValue::String(parent_id.to_string()),
                            );
                            payload.insert(
                                "root_turn_id".to_string(),
                                JsonValue::String(parent.get("root_turn_id")),
                            );
                            payload.insert(
                                "tool_name".to_string(),
                                JsonValue::String("thread_group".into()),
                            );
                            payload.insert(
                                "tool_status".to_string(),
                                JsonValue::String(
                                    if next_status == ThreadGroupStatus::Satisfied {
                                        "success"
                                    } else {
                                        "error"
                                    }
                                    .into(),
                                ),
                            );
                            payload.insert(
                                "text".to_string(),
                                JsonValue::String(format!(
                                    "Thread Group '{}' 已终止：{}（{}/{} 成功）",
                                    group_id,
                                    next_status.as_str(),
                                    successful_count,
                                    required_count
                                )),
                            );
                            (
                                "chat/thread_group_terminal",
                                TYPE_TOOL_OUTPUT.to_string(),
                                (parent.get::<String, _>("status") == "open")
                                    .then(|| parent_id.to_string()),
                            )
                        }
                        ThreadSupervisorKind::Objective => {
                            payload.insert(
                                "session_id".to_string(),
                                JsonValue::String(group_session_id),
                            );
                            payload.insert(
                                "objective_id".to_string(),
                                JsonValue::String(supervisor_id.clone()),
                            );
                            payload.insert(
                                "correlation_id".to_string(),
                                JsonValue::String(group_id.to_string()),
                            );
                            (
                                "runtime/thread_group_terminal",
                                "runtime_control".to_string(),
                                None,
                            )
                        }
                        ThreadSupervisorKind::Runtime => {
                            payload.insert(
                                "session_id".to_string(),
                                JsonValue::String(group_session_id),
                            );
                            payload.insert(
                                "runtime_supervisor_id".to_string(),
                                JsonValue::String(supervisor_id.clone()),
                            );
                            (
                                "runtime/thread_group_terminal",
                                "runtime_control".to_string(),
                                None,
                            )
                        }
                        ThreadSupervisorKind::None | ThreadSupervisorKind::Legacy => {
                            return Err(format!(
                                "Thread Group '{}' 不能由 {:?} supervisor 收口",
                                group_id, supervisor_kind
                            )
                            .into());
                        }
                    };
                    let barrier = Event::new(
                        barrier_event_id,
                        "Runtime".to_string(),
                        event_type,
                        topic.to_string(),
                        payload,
                    );
                    append_event_in_tx(&mut tx, &barrier).await?;
                    if matches!(
                        supervisor_kind,
                        ThreadSupervisorKind::Objective | ThreadSupervisorKind::Runtime
                    ) {
                        ready_supervisor_event_ids.push(barrier.id.clone());
                    }
                    let group_generation = group.get::<i64, _>("generation");
                    sqlx::query(
                        r#"UPDATE scheduler_dependencies
                           SET status = 'satisfied', satisfied_by_event_id = $1,
                               satisfied_at = $2, updated_at = $2
                           WHERE dependency_kind = 'thread_group'
                             AND dependency_id = $3
                             AND dependency_generation = $4
                             AND status = 'pending'"#,
                    )
                    .bind(&barrier.id)
                    .bind(&now)
                    .bind(group_id)
                    .bind(group_generation)
                    .execute(&mut *tx)
                    .await?;
                    if supervisor_kind == ThreadSupervisorKind::Objective {
                        sqlx::query(
                            r#"UPDATE objectives
                               SET wait_condition_json = NULL, status_reason = NULL,
                                   revision = revision + 1, updated_at = $1
                               WHERE id = $2 AND wait_condition_json = $3"#,
                        )
                        .bind(&now)
                        .bind(&supervisor_id)
                        .bind(serde_json::to_value(ObjectiveWaitCondition::ThreadGroup {
                            group_id: group_id.to_string(),
                        })?)
                        .execute(&mut *tx)
                        .await?;
                    }
                    if let Some(target_thread_id) = signal_target_thread_id.as_deref() {
                        append_direct_thread_signal_in_tx(&mut tx, &barrier, target_thread_id)
                            .await?;
                        ready_signal_event_ids.push(barrier.id.clone());
                    }
                }
            }
        } else {
            let terminal_event_id = format!("thread_terminal_{thread_id}_g{thread_generation}");
            let mut payload = serde_json::Map::new();
            payload.insert(
                "context_id".to_string(),
                event
                    .payload
                    .get("context_id")
                    .cloned()
                    .ok_or("Evaluation outcome Event 缺少 context_id")?,
            );
            payload.insert(
                "thread_id".to_string(),
                JsonValue::String(thread_id.to_string()),
            );
            payload.insert(
                "thread_generation".to_string(),
                JsonValue::from(thread_generation),
            );
            payload.insert(
                "outcome_id".to_string(),
                JsonValue::String(outcome_id.clone()),
            );
            payload.insert(
                "terminal_kind".to_string(),
                JsonValue::String(terminal_kind.to_string()),
            );
            payload.insert(
                "wake_policy".to_string(),
                JsonValue::String("direct_signal".into()),
            );
            payload.insert(
                "terminal_summary".to_string(),
                serde_json::json!({
                    "thread_id": thread_id,
                    "outcome_id": outcome_id,
                    "terminal_kind": terminal_kind,
                    "summary": result_text,
                    "artifact_refs": artifact_refs,
                    "evidence_refs": evidence_refs,
                    "check_results": check_results,
                    "unresolved_failures": unresolved_failures,
                }),
            );
            let (topic, event_type, signal_target_thread_id) = match supervisor_kind {
                ThreadSupervisorKind::Thread | ThreadSupervisorKind::Evaluation => {
                    let parent_id = parent_thread_id.as_deref().ok_or_else(|| {
                        format!(
                            "attached Thread '{}' 缺少 parent_thread_id，无法向父 Thread 交付",
                            thread_id
                        )
                    })?;
                    let parent = sqlx::query(
                        "SELECT session_id, root_turn_id, status FROM threads WHERE id = $1",
                    )
                    .bind(parent_id)
                    .fetch_one(&mut *tx)
                    .await?;
                    payload.insert(
                        "session_id".to_string(),
                        JsonValue::String(parent.get("session_id")),
                    );
                    payload.insert(
                        "thread_id".to_string(),
                        JsonValue::String(parent_id.to_string()),
                    );
                    payload.insert(
                        "completed_thread_id".to_string(),
                        JsonValue::String(thread_id.to_string()),
                    );
                    payload.insert(
                        "root_turn_id".to_string(),
                        JsonValue::String(parent.get("root_turn_id")),
                    );
                    payload.insert("tool_name".to_string(), JsonValue::String("thread".into()));
                    payload.insert(
                        "tool_status".to_string(),
                        JsonValue::String(
                            if terminal_kind == ThreadLifecycle::Completed.as_str() {
                                "success"
                            } else {
                                "error"
                            }
                            .into(),
                        ),
                    );
                    payload.insert(
                        "text".to_string(),
                        JsonValue::String(format!(
                            "Thread '{}' 已终止：{}",
                            thread_id, terminal_kind
                        )),
                    );
                    (
                        "chat/thread_terminal",
                        TYPE_TOOL_OUTPUT.to_string(),
                        (parent.get::<String, _>("status") == "open")
                            .then(|| parent_id.to_string()),
                    )
                }
                ThreadSupervisorKind::Objective => {
                    payload.insert(
                        "session_id".to_string(),
                        JsonValue::String(session_id.to_string()),
                    );
                    payload.insert(
                        "objective_id".to_string(),
                        JsonValue::String(
                            supervisor_id
                                .clone()
                                .ok_or("durable Thread 缺少 Objective supervisor_id")?,
                        ),
                    );
                    payload.insert(
                        "correlation_id".to_string(),
                        JsonValue::String(thread_id.to_string()),
                    );
                    (
                        "runtime/thread_terminal",
                        "runtime_control".to_string(),
                        None,
                    )
                }
                ThreadSupervisorKind::Runtime => {
                    payload.insert(
                        "session_id".to_string(),
                        JsonValue::String(session_id.to_string()),
                    );
                    payload.insert(
                        "runtime_supervisor_id".to_string(),
                        JsonValue::String(
                            supervisor_id
                                .clone()
                                .ok_or("Runtime Thread 缺少 supervisor_id")?,
                        ),
                    );
                    (
                        "runtime/thread_terminal",
                        "runtime_control".to_string(),
                        None,
                    )
                }
                ThreadSupervisorKind::None | ThreadSupervisorKind::Legacy => {
                    ("", String::new(), None)
                }
            };
            if !topic.is_empty() {
                let terminal_event = Event::new(
                    terminal_event_id,
                    "Runtime".to_string(),
                    event_type,
                    topic.to_string(),
                    payload,
                );
                append_event_in_tx(&mut tx, &terminal_event).await?;
                if let Some(target_thread_id) = signal_target_thread_id.as_deref() {
                    append_direct_thread_signal_in_tx(&mut tx, &terminal_event, target_thread_id)
                        .await?;
                    ready_signal_event_ids.push(terminal_event.id.clone());
                } else if matches!(
                    supervisor_kind,
                    ThreadSupervisorKind::Objective | ThreadSupervisorKind::Runtime
                ) {
                    ready_supervisor_event_ids.push(terminal_event.id.clone());
                }
            }
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
        let activation_terminal_status = match terminal_lifecycle {
            ThreadLifecycle::Completed => ThreadActivationStatus::Succeeded,
            ThreadLifecycle::Failed => ThreadActivationStatus::Failed,
            ThreadLifecycle::Cancelled => ThreadActivationStatus::Cancelled,
            ThreadLifecycle::Open => {
                return Err("Thread outcome 不能以 open lifecycle 收口 Activation".into());
            }
        };
        let activation_terminal = sqlx::query(
            r#"UPDATE thread_activations
               SET revision = revision + 1, status = $1, claimed_by = NULL,
                   lease_expires_at = NULL, updated_at = $2
               WHERE id = $3 AND generation = $4 AND status = 'running'"#,
        )
        .bind(activation_status_storage(activation_terminal_status))
        .bind(&now)
        .bind(activation_id)
        .bind(activation_generation)
        .execute(&mut *tx)
        .await?;
        if activation_terminal.rows_affected() != 1 {
            return Err(format!(
                "Evaluation outcome 无法原子提交 Activation '{activation_id}' 终态"
            )
            .into());
        }
        sqlx::query(
            r#"UPDATE thread_signals SET status = 'acknowledged', acknowledged_at = $1
               WHERE id IN (
                 SELECT signal_id FROM activation_signals WHERE activation_id = $2
               ) AND status = 'claimed'"#,
        )
        .bind(&now)
        .bind(activation_id)
        .execute(&mut *tx)
        .await?;
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
        let activity_at = event
            .timestamp
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query("UPDATE sessions SET updated_at = $1, last_activity_at = $1 WHERE id = $2")
            .bind(activity_at)
            .bind(session_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(ActivationOutcomeCommit::Committed {
            ready_signal_event_ids,
            ready_supervisor_event_ids,
        })
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
        let principal_id = request
            .event
            .payload
            .get("principal_id")
            .and_then(JsonValue::as_str)
            .ok_or("DialogueTurn retry Event 缺少 principal_id")?;
        let expected_revision = i64::try_from(request.expected_thread_revision)?;
        let now = now_text();
        let mut tx = self.pool.begin().await?;

        // Every dialogue-ingress transaction takes mutable authority in the
        // same order: Session, then Thread/Activation. claim_message follows
        // this order while interrupting a live dialogue; reversing it here
        // creates a PostgreSQL deadlock when retry and interruption race.
        let session_status =
            sqlx::query_scalar::<_, String>("SELECT status FROM sessions WHERE id = $1 FOR UPDATE")
                .bind(session_id)
                .fetch_optional(&mut *tx)
                .await?;

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

        if session_status.as_deref() != Some("active") {
            tx.commit().await?;
            return Ok(DialogueTurnRetryMutation::Rejected {
                current,
                reason: "归档或不存在的 Session 不能重启 DialogueTurn".to_string(),
            });
        }
        let principal_is_bound = sqlx::query_scalar::<_, bool>(
            r#"SELECT EXISTS(
                 SELECT 1 FROM session_principal_bindings
                 WHERE session_id = $1 AND principal_id = $2 AND unbound_at IS NULL
               )"#,
        )
        .bind(session_id)
        .bind(principal_id)
        .fetch_one(&mut *tx)
        .await?;
        if !principal_is_bound {
            tx.commit().await?;
            return Ok(DialogueTurnRetryMutation::Rejected {
                current,
                reason: format!(
                    "Principal '{}' 未绑定到 Session '{}'，拒绝重启 DialogueTurn",
                    principal_id, session_id
                ),
            });
        }

        if current.revision != request.expected_thread_revision {
            tx.commit().await?;
            return Ok(DialogueTurnRetryMutation::Conflict { current });
        }
        let retryable_execution = current.kind == ThreadKind::Execution
            && current.supervision.supervisor_kind == ThreadSupervisorKind::Runtime
            && current.supervision.parent_thread_id.is_none()
            && current.supervision.thread_group_id.is_none()
            && current.supervision.origin_evaluation_id.is_none();
        let rejected = if current.kind != ThreadKind::DialogueTurn && !retryable_execution {
            Some(
                "只有 DialogueTurn 或 Runtime 直接监督的根 Execution Thread 可以原位重试"
                    .to_string(),
            )
        } else if !current.lifecycle.is_terminal() {
            Some("Thread 尚未进入终态".to_string())
        } else if current.context_id != context_id || current.session_id != session_id {
            Some("Retry Event 与 DialogueTurn route 不一致".to_string())
        } else if current.result_event_id.as_deref()
            != Some(request.expected_result_event_id.as_str())
        {
            Some("Thread 的当前结果已经变化".to_string())
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
        append_direct_thread_signal_in_tx(&mut tx, &request.event, &current.id).await?;
        tx.commit().await?;
        Ok(DialogueTurnRetryMutation::Accepted {
            thread_id: current.id,
            generation,
        })
    }
}
