use super::{
    append_event_in_tx, append_signal_outbox_in_tx, now_text, parse_time, PostgresStore, StoreError,
};
use crate::event::Event;
use crate::memory::{
    NewSchedule, NewThread, ScheduleMutation, ScheduleRecord, ScheduleStatus, ScheduleStore,
};
use chrono::{DateTime, Utc};
use serde_json::Value as JsonValue;
use sqlx::postgres::PgRow;
use sqlx::{PgPool, Row};

pub(super) async fn migrate(pool: &PgPool) -> Result<(), StoreError> {
    for statement in [
        r#"CREATE TABLE IF NOT EXISTS schedules (
            id TEXT PRIMARY KEY,
            revision BIGINT NOT NULL DEFAULT 1 CHECK(revision >= 1),
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
            source_turn_id TEXT NOT NULL,
            intent TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN (
                'queued', 'paused', 'dispatched', 'completed', 'cancelled'
            )),
            not_before TEXT,
            interval_seconds BIGINT CHECK(interval_seconds IS NULL OR interval_seconds > 0),
            dependency_thread_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_schedules_due
           ON schedules(status, not_before, created_at, id)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_schedules_thread_status
           ON schedules(thread_id, status, updated_at DESC)"#,
        r#"CREATE TABLE IF NOT EXISTS schedule_dependencies (
            schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
            dependency_thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
            PRIMARY KEY(schedule_id, dependency_thread_id)
        )"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_schedule_dependencies_thread
           ON schedule_dependencies(dependency_thread_id, schedule_id)"#,
        r#"CREATE OR REPLACE FUNCTION morphz_schedule_terminal_guard()
           RETURNS trigger AS $$
           BEGIN
             IF OLD.status IN ('completed', 'cancelled') AND NEW.status <> OLD.status THEN
               RAISE EXCEPTION 'schedule terminal status is irreversible';
             END IF;
             RETURN NEW;
           END;
           $$ LANGUAGE plpgsql"#,
        r#"DO $$
           BEGIN
             IF NOT EXISTS (
               SELECT 1 FROM pg_trigger
               WHERE tgname = 'schedules_terminal_status_is_irreversible'
             ) THEN
               CREATE TRIGGER schedules_terminal_status_is_irreversible
               BEFORE UPDATE OF status ON schedules
               FOR EACH ROW EXECUTE FUNCTION morphz_schedule_terminal_guard();
             END IF;
           END $$"#,
    ] {
        sqlx::query(statement).execute(pool).await?;
    }
    Ok(())
}

fn parse_status(value: &str) -> Result<ScheduleStatus, StoreError> {
    match value {
        "queued" => Ok(ScheduleStatus::Queued),
        "paused" => Ok(ScheduleStatus::Paused),
        "dispatched" => Ok(ScheduleStatus::Dispatched),
        "completed" => Ok(ScheduleStatus::Completed),
        "cancelled" => Ok(ScheduleStatus::Cancelled),
        other => Err(format!("未知 Schedule status：'{other}'").into()),
    }
}

fn schedule_from_row(row: &PgRow) -> Result<ScheduleRecord, StoreError> {
    Ok(ScheduleRecord {
        id: row.get("id"),
        revision: u64::try_from(row.get::<i64, _>("revision"))?,
        thread_id: row.get("thread_id"),
        source_turn_id: row.get("source_turn_id"),
        intent: row.get("intent"),
        status: parse_status(&row.get::<String, _>("status"))?,
        not_before: row
            .get::<Option<String>, _>("not_before")
            .as_deref()
            .map(parse_time)
            .transpose()?,
        interval_seconds: row
            .get::<Option<i64>, _>("interval_seconds")
            .map(u64::try_from)
            .transpose()?,
        dependency_thread_ids: serde_json::from_value(
            row.get::<JsonValue, _>("dependency_thread_ids_json"),
        )?,
        created_at: parse_time(&row.get::<String, _>("created_at"))?,
        updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
    })
}

fn encoded_dependencies(intent: &NewSchedule) -> Result<JsonValue, StoreError> {
    Ok(serde_json::to_value(&intent.dependency_thread_ids)?)
}

fn encoded_time(value: Option<DateTime<Utc>>) -> Option<String> {
    value.map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
}

fn encoded_interval(value: Option<u64>) -> Result<Option<i64>, StoreError> {
    let value = value.map(i64::try_from).transpose()?;
    if value == Some(0) {
        return Err("Schedule interval 必须大于 0".into());
    }
    Ok(value)
}

async fn mutation_failure(
    store: &PostgresStore,
    id: &str,
    expected_revision: u64,
    reason: impl Into<String>,
) -> Result<ScheduleMutation, StoreError> {
    Ok(match store.get_schedule(id).await? {
        Some(current) if current.revision != expected_revision => {
            ScheduleMutation::Conflict { current }
        }
        Some(current) => ScheduleMutation::Rejected {
            current,
            reason: reason.into(),
        },
        None => ScheduleMutation::NotFound,
    })
}

async fn insert_dependencies(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    intent: &NewSchedule,
    dependencies: &JsonValue,
) -> Result<(), StoreError> {
    for dependency_thread_id in &intent.dependency_thread_ids {
        sqlx::query(
            r#"INSERT INTO schedule_dependencies (schedule_id, dependency_thread_id)
               SELECT $1, $2
               WHERE EXISTS (
                 SELECT 1 FROM schedules
                 WHERE id = $1 AND dependency_thread_ids_json = $3
               )
               ON CONFLICT DO NOTHING"#,
        )
        .bind(&intent.id)
        .bind(dependency_thread_id)
        .bind(dependencies)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

#[async_trait::async_trait]
impl ScheduleStore for PostgresStore {
    async fn ensure_schedule(&self, intent: NewSchedule) -> Result<ScheduleRecord, StoreError> {
        let interval = encoded_interval(intent.interval_seconds)?;
        let not_before = encoded_time(intent.not_before);
        let dependencies = encoded_dependencies(&intent)?;
        let now = now_text();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            r#"INSERT INTO schedules
               (id, revision, thread_id, source_turn_id, intent, status,
                not_before, interval_seconds, dependency_thread_ids_json,
                created_at, updated_at)
               VALUES ($1, 1, $2, $3, $4, 'queued', $5, $6, $7, $8, $8)
               ON CONFLICT(id) DO NOTHING"#,
        )
        .bind(&intent.id)
        .bind(&intent.thread_id)
        .bind(&intent.source_turn_id)
        .bind(&intent.intent)
        .bind(not_before)
        .bind(interval)
        .bind(&dependencies)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        insert_dependencies(&mut tx, &intent, &dependencies).await?;
        let row = sqlx::query("SELECT * FROM schedules WHERE id = $1")
            .bind(&intent.id)
            .fetch_one(&mut *tx)
            .await?;
        tx.commit().await?;
        schedule_from_row(&row)
    }

    async fn get_schedule(&self, id: &str) -> Result<Option<ScheduleRecord>, StoreError> {
        sqlx::query("SELECT * FROM schedules WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(schedule_from_row)
            .transpose()
    }

    async fn inspect_schedule(&self, id: &str) -> Result<Option<ScheduleRecord>, StoreError> {
        self.get_schedule(id).await
    }

    async fn pause_schedule(
        &self,
        id: &str,
        expected_revision: u64,
    ) -> Result<ScheduleMutation, StoreError> {
        let row = sqlx::query(
            r#"UPDATE schedules SET status = 'paused', revision = revision + 1,
               updated_at = $1
               WHERE id = $2 AND revision = $3 AND status = 'queued'
               RETURNING *"#,
        )
        .bind(now_text())
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
        .fetch_optional(&self.pool)
        .await?;
        match row {
            Some(row) => Ok(ScheduleMutation::Updated(schedule_from_row(&row)?)),
            None => {
                mutation_failure(self, id, expected_revision, "只有 queued Schedule 可以暂停").await
            }
        }
    }

    async fn resume_schedule(
        &self,
        id: &str,
        expected_revision: u64,
    ) -> Result<ScheduleMutation, StoreError> {
        let row = sqlx::query(
            r#"UPDATE schedules SET status = 'queued', revision = revision + 1,
               updated_at = $1
               WHERE id = $2 AND revision = $3 AND status = 'paused'
               RETURNING *"#,
        )
        .bind(now_text())
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
        .fetch_optional(&self.pool)
        .await?;
        match row {
            Some(row) => Ok(ScheduleMutation::Updated(schedule_from_row(&row)?)),
            None => {
                mutation_failure(self, id, expected_revision, "只有 paused Schedule 可以恢复").await
            }
        }
    }

    async fn reschedule_schedule(
        &self,
        id: &str,
        expected_revision: u64,
        not_before: Option<DateTime<Utc>>,
        interval_seconds: Option<u64>,
    ) -> Result<ScheduleMutation, StoreError> {
        let row = sqlx::query(
            r#"UPDATE schedules SET not_before = $1, interval_seconds = $2,
               revision = revision + 1, updated_at = $3
               WHERE id = $4 AND revision = $5 AND status IN ('queued', 'paused')
               RETURNING *"#,
        )
        .bind(encoded_time(not_before))
        .bind(encoded_interval(interval_seconds)?)
        .bind(now_text())
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
        .fetch_optional(&self.pool)
        .await?;
        match row {
            Some(row) => Ok(ScheduleMutation::Updated(schedule_from_row(&row)?)),
            None => {
                mutation_failure(
                    self,
                    id,
                    expected_revision,
                    "只有尚未派发的 queued/paused Schedule 可以重新调度",
                )
                .await
            }
        }
    }

    async fn cancel_schedule(
        &self,
        id: &str,
        expected_revision: u64,
    ) -> Result<ScheduleMutation, StoreError> {
        let row = sqlx::query(
            r#"UPDATE schedules SET status = 'cancelled', revision = revision + 1,
               updated_at = $1
               WHERE id = $2 AND revision = $3 AND status IN ('queued', 'paused')
               RETURNING *"#,
        )
        .bind(now_text())
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
        .fetch_optional(&self.pool)
        .await?;
        match row {
            Some(row) => Ok(ScheduleMutation::Updated(schedule_from_row(&row)?)),
            None => {
                mutation_failure(
                    self,
                    id,
                    expected_revision,
                    "只有尚未派发的 queued/paused Schedule 可以取消",
                )
                .await
            }
        }
    }

    async fn commit_schedule_transaction(
        &self,
        threads: &[NewThread],
        intents: &[NewSchedule],
    ) -> Result<Vec<ScheduleRecord>, StoreError> {
        let now = now_text();
        let mut tx = self.pool.begin().await?;
        for thread in threads {
            sqlx::query(
                r#"INSERT INTO threads
                   (id, revision, agent_id, context_id, session_id, initiating_principal_id, root_turn_id,
                    kind, status, executor_kind, executor_id, delivery_status,
                    created_at, updated_at)
                   VALUES ($1, 1, $2, $3, $4, $5, $6, $7, 'open', $8, $9,
                           'none', $10, $10)
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
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        }
        for intent in intents {
            let target = sqlx::query("SELECT status FROM threads WHERE id = $1")
                .bind(&intent.thread_id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(|| format!("Schedule '{}' 的目标 Thread 不存在", intent.id))?;
            let status: String = target.get("status");
            if matches!(status.as_str(), "failed" | "cancelled") {
                return Err(format!(
                    "Schedule '{}' 不能写入状态为 '{}' 的 Thread",
                    intent.id, status
                )
                .into());
            }
            let dependencies = encoded_dependencies(intent)?;
            sqlx::query(
                r#"INSERT INTO schedules
                   (id, revision, thread_id, source_turn_id, intent, status,
                    not_before, interval_seconds, dependency_thread_ids_json,
                    created_at, updated_at)
                   VALUES ($1, 1, $2, $3, $4, 'queued', $5, $6, $7, $8, $8)
                   ON CONFLICT(id) DO NOTHING"#,
            )
            .bind(&intent.id)
            .bind(&intent.thread_id)
            .bind(&intent.source_turn_id)
            .bind(&intent.intent)
            .bind(encoded_time(intent.not_before))
            .bind(encoded_interval(intent.interval_seconds)?)
            .bind(&dependencies)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            insert_dependencies(&mut tx, intent, &dependencies).await?;
        }
        let mut records = Vec::with_capacity(intents.len());
        for intent in intents {
            let row = sqlx::query("SELECT * FROM schedules WHERE id = $1")
                .bind(&intent.id)
                .fetch_one(&mut *tx)
                .await?;
            records.push(schedule_from_row(&row)?);
        }
        tx.commit().await?;
        Ok(records)
    }

    async fn list_schedules(
        &self,
        thread_id: Option<&str>,
        status: Option<ScheduleStatus>,
    ) -> Result<Vec<ScheduleRecord>, StoreError> {
        let rows = match (thread_id, status) {
            (Some(thread_id), Some(status)) => {
                sqlx::query("SELECT * FROM schedules WHERE thread_id = $1 AND status = $2 ORDER BY COALESCE(not_before, created_at), id")
                    .bind(thread_id).bind(status.as_str()).fetch_all(&self.pool).await?
            }
            (Some(thread_id), None) => {
                sqlx::query("SELECT * FROM schedules WHERE thread_id = $1 ORDER BY COALESCE(not_before, created_at), id")
                    .bind(thread_id).fetch_all(&self.pool).await?
            }
            (None, Some(status)) => {
                sqlx::query("SELECT * FROM schedules WHERE status = $1 ORDER BY COALESCE(not_before, created_at), id")
                    .bind(status.as_str()).fetch_all(&self.pool).await?
            }
            (None, None) => {
                sqlx::query("SELECT * FROM schedules ORDER BY COALESCE(not_before, created_at), id")
                    .fetch_all(&self.pool).await?
            }
        };
        rows.iter().map(schedule_from_row).collect()
    }

    async fn list_context_schedules(
        &self,
        context_id: &str,
    ) -> Result<Vec<ScheduleRecord>, StoreError> {
        let rows = sqlx::query(
            r#"SELECT schedules.* FROM schedules
               INNER JOIN threads ON threads.id = schedules.thread_id
               WHERE threads.context_id = $1
               ORDER BY COALESCE(schedules.not_before, schedules.created_at), schedules.id"#,
        )
        .bind(context_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(schedule_from_row).collect()
    }

    async fn wake_schedules_for_dependency(
        &self,
        dependency_thread_id: &str,
    ) -> Result<Vec<ScheduleRecord>, StoreError> {
        let rows = sqlx::query(
            r#"UPDATE schedules SET revision = revision + 1, updated_at = $1
               WHERE status = 'queued' AND id IN (
                 SELECT schedule_id FROM schedule_dependencies
                 WHERE dependency_thread_id = $2
               )
               RETURNING *"#,
        )
        .bind(now_text())
        .bind(dependency_thread_id)
        .fetch_all(&self.pool)
        .await?;
        let mut records = rows
            .iter()
            .map(schedule_from_row)
            .collect::<Result<Vec<_>, _>>()?;
        records.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(records)
    }

    async fn claim_schedule(
        &self,
        id: &str,
        expected_revision: u64,
        next_not_before: Option<DateTime<Utc>>,
    ) -> Result<Option<ScheduleRecord>, StoreError> {
        let next_status = if next_not_before.is_some() {
            ScheduleStatus::Queued
        } else {
            ScheduleStatus::Dispatched
        };
        sqlx::query(
            r#"UPDATE schedules SET revision = revision + 1, status = $1,
               not_before = COALESCE($2, not_before), updated_at = $3
               WHERE id = $4 AND revision = $5 AND status = 'queued'
               RETURNING *"#,
        )
        .bind(next_status.as_str())
        .bind(encoded_time(next_not_before))
        .bind(now_text())
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
        .fetch_optional(&self.pool)
        .await?
        .as_ref()
        .map(schedule_from_row)
        .transpose()
    }

    async fn commit_scheduled_dispatch(
        &self,
        id: &str,
        expected_revision: u64,
        next_not_before: Option<DateTime<Utc>>,
        event: &Event,
    ) -> Result<Option<ScheduleRecord>, StoreError> {
        let next_status = if next_not_before.is_some() {
            ScheduleStatus::Queued
        } else {
            ScheduleStatus::Dispatched
        };
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            r#"UPDATE schedules SET revision = revision + 1, status = $1,
               not_before = COALESCE($2, not_before), updated_at = $3
               WHERE id = $4 AND revision = $5 AND status = 'queued'
               RETURNING *"#,
        )
        .bind(next_status.as_str())
        .bind(encoded_time(next_not_before))
        .bind(now_text())
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(row) = row else {
            tx.rollback().await?;
            return Ok(None);
        };
        append_event_in_tx(&mut tx, event).await?;
        append_signal_outbox_in_tx(&mut tx, event).await?;
        let record = schedule_from_row(&row)?;
        tx.commit().await?;
        Ok(Some(record))
    }
}
