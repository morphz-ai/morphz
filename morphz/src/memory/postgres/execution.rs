//! PostgreSQL physical Execution Job authority.
//!
//! Jobs are revision-fenced aggregates. Worker mutations additionally carry a
//! per-claim token, so an expired or superseded worker cannot heartbeat or
//! publish a terminal result.

use super::{append_event_in_tx, now_text, parse_time, PostgresStore, StoreError};
use crate::event::Event;
use crate::memory::{
    ExecutionJobFilter, ExecutionJobMutation, ExecutionJobRecord, ExecutionJobStatus,
    ExecutionJobStore, ExecutionJobTerminal, ExecutionRetrySafety, NewExecutionJob,
};
use chrono::{DateTime, Utc};
use serde_json::Value as JsonValue;
use sqlx::postgres::PgRow;
use sqlx::{PgPool, Postgres, QueryBuilder, Row};

pub(super) async fn migrate(pool: &PgPool) -> Result<(), StoreError> {
    for statement in [
        r#"CREATE TABLE IF NOT EXISTS threads (
            id TEXT PRIMARY KEY,
            revision BIGINT NOT NULL DEFAULT 1,
            agent_id TEXT NOT NULL REFERENCES agents(id),
            context_id TEXT NOT NULL REFERENCES cognitive_contexts(id),
            session_id TEXT NOT NULL REFERENCES sessions(id),
            root_turn_id TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL,
            status TEXT NOT NULL,
            executor_kind TEXT NOT NULL,
            executor_id TEXT,
            result_text TEXT,
            result_event_id TEXT,
            delivery_status TEXT NOT NULL DEFAULT 'none',
            delivery_event_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )"#,
        r#"CREATE TABLE IF NOT EXISTS thread_activations (
            id TEXT PRIMARY KEY,
            revision BIGINT NOT NULL DEFAULT 1,
            agent_id TEXT NOT NULL REFERENCES agents(id),
            context_id TEXT NOT NULL REFERENCES cognitive_contexts(id),
            session_id TEXT NOT NULL REFERENCES sessions(id),
            trigger_event_id TEXT NOT NULL UNIQUE,
            trigger_sequence BIGINT NOT NULL,
            trigger_kind TEXT NOT NULL,
            parent_activation_id TEXT REFERENCES thread_activations(id),
            root_turn_id TEXT NOT NULL,
            context_snapshot_version BIGINT,
            status TEXT NOT NULL,
            claimed_by TEXT,
            lease_expires_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )"#,
        r#"CREATE TABLE IF NOT EXISTS execution_jobs (
            id TEXT PRIMARY KEY,
            revision BIGINT NOT NULL DEFAULT 1,
            activation_id TEXT NOT NULL REFERENCES thread_activations(id) ON DELETE CASCADE,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
            agent_id TEXT NOT NULL REFERENCES agents(id),
            context_id TEXT NOT NULL REFERENCES cognitive_contexts(id),
            session_id TEXT NOT NULL REFERENCES sessions(id),
            tool_call_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            request_json JSONB NOT NULL,
            status TEXT NOT NULL,
            retry_safety TEXT NOT NULL,
            claimed_by TEXT,
            claim_token TEXT,
            lease_expires_at TEXT,
            heartbeat_at TEXT,
            approval_ref TEXT,
            side_effect_started_at TEXT,
            cancel_requested_at TEXT,
            cancel_reason TEXT,
            progress_ref TEXT,
            result_event_id TEXT,
            result_refs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
            error TEXT,
            exit_code INTEGER,
            created_at TEXT NOT NULL,
            started_at TEXT,
            updated_at TEXT NOT NULL,
            finished_at TEXT,
            UNIQUE(activation_id, tool_call_id)
        )"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_execution_jobs_queue
           ON execution_jobs(status, created_at, id)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_execution_jobs_context_status
           ON execution_jobs(context_id, status, updated_at DESC)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_execution_jobs_thread_status
           ON execution_jobs(thread_id, status, created_at, id)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_execution_jobs_lease
           ON execution_jobs(status, lease_expires_at, id)"#,
        r#"CREATE OR REPLACE FUNCTION morphz_execution_job_terminal_guard()
           RETURNS trigger AS $$
           BEGIN
             IF OLD.status IN ('succeeded', 'failed', 'cancelled', 'lost')
                AND NEW.status <> OLD.status THEN
               RAISE EXCEPTION 'execution job terminal status is irreversible';
             END IF;
             RETURN NEW;
           END;
           $$ LANGUAGE plpgsql"#,
        r#"DO $$
           BEGIN
             IF NOT EXISTS (
               SELECT 1 FROM pg_trigger
               WHERE tgname = 'execution_jobs_terminal_status_is_irreversible'
             ) THEN
               CREATE TRIGGER execution_jobs_terminal_status_is_irreversible
               BEFORE UPDATE OF status ON execution_jobs
               FOR EACH ROW EXECUTE FUNCTION morphz_execution_job_terminal_guard();
             END IF;
           END $$"#,
    ] {
        sqlx::query(statement).execute(pool).await?;
    }
    Ok(())
}

pub(super) async fn bootstrap_causality(
    pool: &PgPool,
    agent_id: &str,
    context_id: &str,
    session_id: &str,
    thread_id: &str,
    activation_id: &str,
) -> Result<(), StoreError> {
    let now = now_text();
    let root_turn_id = format!("root-{thread_id}");
    let mut tx = pool.begin().await?;
    sqlx::query(
        r#"INSERT INTO threads
           (id, revision, agent_id, context_id, session_id, root_turn_id,
            kind, status, executor_kind, delivery_status, created_at, updated_at)
           VALUES ($1, 1, $2, $3, $4, $5, 'execution', 'open',
                   'runtime', 'none', $6, $6)"#,
    )
    .bind(thread_id)
    .bind(agent_id)
    .bind(context_id)
    .bind(session_id)
    .bind(&root_turn_id)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"INSERT INTO thread_activations
           (id, revision, agent_id, context_id, session_id, trigger_event_id,
            trigger_sequence, trigger_kind, root_turn_id, status, created_at, updated_at)
           VALUES ($1, 1, $2, $3, $4, $5, 1, 'conformance', $6,
                   'running', $7, $7)"#,
    )
    .bind(activation_id)
    .bind(agent_id)
    .bind(context_id)
    .bind(session_id)
    .bind(format!("trigger-{activation_id}"))
    .bind(root_turn_id)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

fn parse_status(value: &str) -> Result<ExecutionJobStatus, StoreError> {
    match value {
        "queued" => Ok(ExecutionJobStatus::Queued),
        "waiting_approval" => Ok(ExecutionJobStatus::WaitingApproval),
        "running" => Ok(ExecutionJobStatus::Running),
        "succeeded" => Ok(ExecutionJobStatus::Succeeded),
        "failed" => Ok(ExecutionJobStatus::Failed),
        "cancelled" => Ok(ExecutionJobStatus::Cancelled),
        "lost" => Ok(ExecutionJobStatus::Lost),
        other => Err(format!("未知 Execution Job status：'{other}'").into()),
    }
}

fn parse_retry_safety(value: &str) -> Result<ExecutionRetrySafety, StoreError> {
    match value {
        "idempotent" => Ok(ExecutionRetrySafety::Idempotent),
        "reconcile_required" => Ok(ExecutionRetrySafety::ReconcileRequired),
        "at_most_once" => Ok(ExecutionRetrySafety::AtMostOnce),
        other => Err(format!("未知 Execution Job retry safety：'{other}'").into()),
    }
}

fn execution_job_from_row(row: &PgRow) -> Result<ExecutionJobRecord, StoreError> {
    Ok(ExecutionJobRecord {
        id: row.get("id"),
        revision: u64::try_from(row.get::<i64, _>("revision"))?,
        activation_id: row.get("activation_id"),
        thread_id: row.get("thread_id"),
        agent_id: row.get("agent_id"),
        context_id: row.get("context_id"),
        session_id: row.get("session_id"),
        tool_call_id: row.get("tool_call_id"),
        tool_name: row.get("tool_name"),
        request: row.get("request_json"),
        status: parse_status(&row.get::<String, _>("status"))?,
        retry_safety: parse_retry_safety(&row.get::<String, _>("retry_safety"))?,
        claimed_by: row.get("claimed_by"),
        claim_token: row.get("claim_token"),
        lease_expires_at: optional_time(row, "lease_expires_at")?,
        heartbeat_at: optional_time(row, "heartbeat_at")?,
        approval_ref: row.get("approval_ref"),
        side_effect_started_at: optional_time(row, "side_effect_started_at")?,
        cancel_requested_at: optional_time(row, "cancel_requested_at")?,
        cancel_reason: row.get("cancel_reason"),
        progress_ref: row.get("progress_ref"),
        result_event_id: row.get("result_event_id"),
        result_refs: serde_json::from_value(row.get("result_refs_json"))?,
        error: row.get("error"),
        exit_code: row.get("exit_code"),
        created_at: parse_time(&row.get::<String, _>("created_at"))?,
        started_at: optional_time(row, "started_at")?,
        updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
        finished_at: optional_time(row, "finished_at")?,
    })
}

fn optional_time(row: &PgRow, column: &str) -> Result<Option<DateTime<Utc>>, StoreError> {
    row.get::<Option<String>, _>(column)
        .as_deref()
        .map(parse_time)
        .transpose()
}

fn validate_new_job(job: &NewExecutionJob) -> Result<(), StoreError> {
    for (field, value) in [
        ("id", job.id.as_str()),
        ("activation_id", job.activation_id.as_str()),
        ("thread_id", job.thread_id.as_str()),
        ("agent_id", job.agent_id.as_str()),
        ("context_id", job.context_id.as_str()),
        ("session_id", job.session_id.as_str()),
        ("tool_call_id", job.tool_call_id.as_str()),
        ("tool_name", job.tool_name.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(format!("Execution Job {field} 不能为空").into());
        }
    }
    Ok(())
}

async fn ensure_job_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    job: &NewExecutionJob,
) -> Result<ExecutionJobRecord, StoreError> {
    validate_new_job(job)?;
    let status = if job.requires_approval {
        ExecutionJobStatus::WaitingApproval
    } else {
        ExecutionJobStatus::Queued
    };
    let causal = sqlx::query(
        r#"SELECT activations.agent_id AS activation_agent_id,
                  activations.context_id AS activation_context_id,
                  activations.session_id AS activation_session_id,
                  activations.root_turn_id AS activation_root_turn_id,
                  threads.agent_id AS thread_agent_id,
                  threads.context_id AS thread_context_id,
                  threads.session_id AS thread_session_id,
                  threads.root_turn_id AS thread_root_turn_id
           FROM thread_activations activations CROSS JOIN threads threads
           WHERE activations.id = $1 AND threads.id = $2"#,
    )
    .bind(&job.activation_id)
    .bind(&job.thread_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or("Execution Job 引用的 Activation 或 Thread 不存在")?;
    if causal.get::<String, _>("activation_agent_id") != job.agent_id
        || causal.get::<String, _>("thread_agent_id") != job.agent_id
        || causal.get::<String, _>("activation_context_id") != job.context_id
        || causal.get::<String, _>("thread_context_id") != job.context_id
        || causal.get::<String, _>("activation_session_id") != job.session_id
        || causal.get::<String, _>("thread_session_id") != job.session_id
        || causal.get::<String, _>("activation_root_turn_id")
            != causal.get::<String, _>("thread_root_turn_id")
    {
        return Err("Execution Job 的 Agent/Context/Session/Root Turn 因果边界不一致".into());
    }
    sqlx::query(
        r#"INSERT INTO execution_jobs
           (id, revision, activation_id, thread_id, agent_id, context_id,
            session_id, tool_call_id, tool_name, request_json, status,
            retry_safety, result_refs_json, created_at, updated_at)
           VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                   '[]'::jsonb, $12, $12)
           ON CONFLICT DO NOTHING"#,
    )
    .bind(&job.id)
    .bind(&job.activation_id)
    .bind(&job.thread_id)
    .bind(&job.agent_id)
    .bind(&job.context_id)
    .bind(&job.session_id)
    .bind(&job.tool_call_id)
    .bind(&job.tool_name)
    .bind(&job.request)
    .bind(status.as_str())
    .bind(job.retry_safety.as_str())
    .bind(now_text())
    .execute(&mut **tx)
    .await?;
    let existing =
        sqlx::query("SELECT * FROM execution_jobs WHERE activation_id = $1 AND tool_call_id = $2")
            .bind(&job.activation_id)
            .bind(&job.tool_call_id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or("Execution Job 创建失败：ID 或因果唯一键已被其他记录占用")?;
    let existing = execution_job_from_row(&existing)?;
    let pending_status_conflict = matches!(
        existing.status,
        ExecutionJobStatus::Queued | ExecutionJobStatus::WaitingApproval
    ) && existing.status != status;
    if existing.id != job.id
        || existing.thread_id != job.thread_id
        || existing.agent_id != job.agent_id
        || existing.context_id != job.context_id
        || existing.session_id != job.session_id
        || existing.tool_name != job.tool_name
        || existing.request != job.request
        || pending_status_conflict
        || existing.retry_safety != job.retry_safety
    {
        return Err(format!(
            "Execution Job 因果键 ('{}', '{}') 已被不同请求占用",
            job.activation_id, job.tool_call_id
        )
        .into());
    }
    Ok(existing)
}

async fn mutation_failure(
    store: &PostgresStore,
    id: &str,
    expected_revision: u64,
    reason: impl Into<String>,
) -> Result<ExecutionJobMutation, StoreError> {
    Ok(match store.get_execution_job(id).await? {
        Some(current) if current.revision != expected_revision => {
            ExecutionJobMutation::Conflict { current }
        }
        Some(current) => ExecutionJobMutation::Rejected {
            current,
            reason: reason.into(),
        },
        None => ExecutionJobMutation::NotFound,
    })
}

fn validate_terminal_transition(
    current: &ExecutionJobRecord,
    claim_token: Option<&str>,
    terminal: &ExecutionJobTerminal,
) -> Result<(), String> {
    let worker_terminal = matches!(
        terminal.status,
        ExecutionJobStatus::Succeeded | ExecutionJobStatus::Failed
    );
    if worker_terminal
        && (current.status != ExecutionJobStatus::Running
            || claim_token.is_none_or(|token| {
                token.is_empty() || current.claim_token.as_deref() != Some(token)
            }))
    {
        return Err("succeeded/failed 需要当前 running claim token".to_string());
    }
    if worker_terminal && current.cancel_requested_at.is_some() {
        return Err(
            "已请求取消的 running Job 只能确认 cancelled，不能再提交 succeeded/failed".to_string(),
        );
    }
    if terminal.status == ExecutionJobStatus::Lost && current.status != ExecutionJobStatus::Running
    {
        return Err("只有 running Job 可以被 reconcile 为 lost".to_string());
    }
    if terminal.status == ExecutionJobStatus::Cancelled
        && current.status == ExecutionJobStatus::Running
        && current.cancel_requested_at.is_none()
        && claim_token != current.claim_token.as_deref()
    {
        return Err("running Job 只能由当前 worker 或已请求取消的控制面确认 cancelled".to_string());
    }
    Ok(())
}

#[async_trait::async_trait]
impl ExecutionJobStore for PostgresStore {
    async fn create_execution_job(
        &self,
        job: NewExecutionJob,
    ) -> Result<ExecutionJobRecord, StoreError> {
        let mut tx = self.pool.begin().await?;
        let job = ensure_job_in_tx(&mut tx, &job).await?;
        tx.commit().await?;
        Ok(job)
    }

    async fn get_execution_job(&self, id: &str) -> Result<Option<ExecutionJobRecord>, StoreError> {
        sqlx::query("SELECT * FROM execution_jobs WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(execution_job_from_row)
            .transpose()
    }

    async fn list_execution_jobs(
        &self,
        filter: ExecutionJobFilter,
    ) -> Result<Vec<ExecutionJobRecord>, StoreError> {
        if filter.limit == Some(0) {
            return Ok(Vec::new());
        }
        let mut query = QueryBuilder::<Postgres>::new("SELECT * FROM execution_jobs WHERE TRUE");
        if let Some(context_id) = filter.context_id {
            query.push(" AND context_id = ").push_bind(context_id);
        }
        if let Some(session_id) = filter.session_id {
            query.push(" AND session_id = ").push_bind(session_id);
        }
        if let Some(thread_id) = filter.thread_id {
            query.push(" AND thread_id = ").push_bind(thread_id);
        }
        if let Some(activation_id) = filter.activation_id {
            query.push(" AND activation_id = ").push_bind(activation_id);
        }
        if let Some(status) = filter.status {
            query.push(" AND status = ").push_bind(status.as_str());
        } else if !filter.include_terminal {
            query.push(" AND status NOT IN ('succeeded', 'failed', 'cancelled', 'lost')");
        }
        if filter.newest_first {
            query.push(" ORDER BY created_at DESC, id DESC");
        } else {
            query.push(" ORDER BY created_at, id");
        }
        if let Some(limit) = filter.limit {
            query.push(" LIMIT ").push_bind(i64::try_from(limit)?);
        }
        let rows = query.build().fetch_all(&self.pool).await?;
        rows.iter().map(execution_job_from_row).collect()
    }

    async fn claim_execution_job(
        &self,
        id: &str,
        expected_revision: u64,
        worker_id: &str,
        claim_token: &str,
        lease_expires_at: DateTime<Utc>,
        approval_ref: Option<&str>,
    ) -> Result<ExecutionJobMutation, StoreError> {
        if worker_id.trim().is_empty() || claim_token.trim().is_empty() {
            return Err("Execution Job worker_id/claim_token 不能为空".into());
        }
        let now = Utc::now();
        if lease_expires_at <= now {
            return Err("Execution Job claim lease 必须在未来".into());
        }
        let Some(current) = self.get_execution_job(id).await? else {
            return Ok(ExecutionJobMutation::NotFound);
        };
        if current.revision != expected_revision {
            return Ok(ExecutionJobMutation::Conflict { current });
        }
        if current.cancel_requested_at.is_some() {
            return Ok(ExecutionJobMutation::Rejected {
                current,
                reason: "已请求取消的 Execution Job 不能再 claim".to_string(),
            });
        }
        match current.status {
            ExecutionJobStatus::Queued => {}
            ExecutionJobStatus::WaitingApproval => {
                if approval_ref.is_none_or(|value| value.trim().is_empty()) {
                    return Ok(ExecutionJobMutation::Rejected {
                        current,
                        reason: "waiting_approval Job 必须携带非空 approval_ref".to_string(),
                    });
                }
            }
            _ => {
                return Ok(ExecutionJobMutation::Rejected {
                    current,
                    reason: "只有 queued/waiting_approval Job 可以被 claim".to_string(),
                });
            }
        }
        let now_text = now.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE execution_jobs
               SET revision = revision + 1, status = 'running', claimed_by = $1,
                   claim_token = $2, lease_expires_at = $3, heartbeat_at = $4,
                   approval_ref = COALESCE($5, approval_ref),
                   started_at = COALESCE(started_at, $4), updated_at = $4
               WHERE id = $6 AND revision = $7
                 AND status IN ('queued', 'waiting_approval')
                 AND cancel_requested_at IS NULL"#,
        )
        .bind(worker_id)
        .bind(claim_token)
        .bind(lease_expires_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
        .bind(&now_text)
        .bind(approval_ref)
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            return mutation_failure(
                self,
                id,
                expected_revision,
                "Execution Job claim 前置条件不再成立",
            )
            .await;
        }
        Ok(ExecutionJobMutation::Updated(
            self.get_execution_job(id)
                .await?
                .ok_or("Execution Job claim 后无法读取")?,
        ))
    }

    async fn heartbeat_execution_job(
        &self,
        id: &str,
        expected_revision: u64,
        claim_token: &str,
        lease_expires_at: DateTime<Utc>,
        side_effect_started_at: Option<DateTime<Utc>>,
        progress_ref: Option<&str>,
    ) -> Result<ExecutionJobMutation, StoreError> {
        if claim_token.trim().is_empty() {
            return Err("Execution Job claim_token 不能为空".into());
        }
        let now = Utc::now();
        if lease_expires_at <= now {
            return Err("Execution Job heartbeat lease 必须在未来".into());
        }
        let now_text = now.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE execution_jobs
               SET revision = revision + 1, lease_expires_at = $1, heartbeat_at = $2,
                   side_effect_started_at = COALESCE(side_effect_started_at, $3),
                   progress_ref = COALESCE($4, progress_ref), updated_at = $2
               WHERE id = $5 AND revision = $6 AND status = 'running'
                 AND claim_token = $7"#,
        )
        .bind(lease_expires_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
        .bind(&now_text)
        .bind(
            side_effect_started_at
                .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true)),
        )
        .bind(progress_ref)
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
        .bind(claim_token)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            return mutation_failure(
                self,
                id,
                expected_revision,
                "Execution Job heartbeat 需要当前 running claim token",
            )
            .await;
        }
        Ok(ExecutionJobMutation::Updated(
            self.get_execution_job(id)
                .await?
                .ok_or("Execution Job heartbeat 后无法读取")?,
        ))
    }

    async fn requeue_execution_job(
        &self,
        id: &str,
        expected_revision: u64,
    ) -> Result<ExecutionJobMutation, StoreError> {
        let result = sqlx::query(
            r#"UPDATE execution_jobs
               SET revision = revision + 1, status = 'queued', claimed_by = NULL,
                   claim_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
                   progress_ref = NULL, updated_at = $1
               WHERE id = $2 AND revision = $3 AND status = 'running'
                 AND retry_safety = 'idempotent'
                 AND side_effect_started_at IS NULL
                 AND cancel_requested_at IS NULL"#,
        )
        .bind(now_text())
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            return mutation_failure(
                self,
                id,
                expected_revision,
                "只有尚未越过副作用边界的 idempotent running Job 可以恢复为 queued",
            )
            .await;
        }
        Ok(ExecutionJobMutation::Updated(
            self.get_execution_job(id)
                .await?
                .ok_or("Execution Job requeue 后无法读取")?,
        ))
    }

    async fn request_cancel_execution_job(
        &self,
        id: &str,
        expected_revision: u64,
        reason: Option<&str>,
    ) -> Result<ExecutionJobMutation, StoreError> {
        let Some(current) = self.get_execution_job(id).await? else {
            return Ok(ExecutionJobMutation::NotFound);
        };
        if current.revision != expected_revision {
            return Ok(ExecutionJobMutation::Conflict { current });
        }
        if current.status.is_terminal() {
            return Ok(ExecutionJobMutation::Rejected {
                current,
                reason: "Execution Job 终态不可请求取消".to_string(),
            });
        }
        let reason = reason.map(|value| value.chars().take(10_000).collect::<String>());
        if current.cancel_requested_at.is_some() && current.cancel_reason == reason {
            return Ok(ExecutionJobMutation::Updated(current));
        }
        let now = now_text();
        let result = sqlx::query(
            r#"UPDATE execution_jobs
               SET revision = revision + 1,
                   cancel_requested_at = COALESCE(cancel_requested_at, $1),
                   cancel_reason = $2, updated_at = $1
               WHERE id = $3 AND revision = $4
                 AND status NOT IN ('succeeded', 'failed', 'cancelled', 'lost')"#,
        )
        .bind(&now)
        .bind(reason)
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            return mutation_failure(
                self,
                id,
                expected_revision,
                "Execution Job cancel 前置条件不再成立",
            )
            .await;
        }
        Ok(ExecutionJobMutation::Updated(
            self.get_execution_job(id)
                .await?
                .ok_or("Execution Job cancel request 后无法读取")?,
        ))
    }

    async fn finish_execution_job(
        &self,
        id: &str,
        expected_revision: u64,
        claim_token: Option<&str>,
        terminal: ExecutionJobTerminal,
    ) -> Result<ExecutionJobMutation, StoreError> {
        if !terminal.status.is_terminal() {
            return Err("Execution Job finish 只能提交终态".into());
        }
        let Some(current) = self.get_execution_job(id).await? else {
            return Ok(ExecutionJobMutation::NotFound);
        };
        if current.revision != expected_revision {
            return Ok(ExecutionJobMutation::Conflict { current });
        }
        if current.status.is_terminal() {
            return Ok(ExecutionJobMutation::Rejected {
                current,
                reason: "Execution Job 终态不可逆".to_string(),
            });
        }
        if let Err(reason) = validate_terminal_transition(&current, claim_token, &terminal) {
            return Ok(ExecutionJobMutation::Rejected { current, reason });
        }
        let now = now_text();
        let worker_terminal = matches!(
            terminal.status,
            ExecutionJobStatus::Succeeded | ExecutionJobStatus::Failed
        );
        let mut query = QueryBuilder::<Postgres>::new(
            "UPDATE execution_jobs SET revision = revision + 1, status = ",
        );
        query
            .push_bind(terminal.status.as_str())
            .push(", lease_expires_at = NULL, result_event_id = ")
            .push_bind(terminal.result_event_id)
            .push(", result_refs_json = ")
            .push_bind(serde_json::to_value(terminal.result_refs)?)
            .push(", error = ")
            .push_bind(
                terminal
                    .error
                    .map(|value| value.chars().take(100_000).collect::<String>()),
            )
            .push(", exit_code = ")
            .push_bind(terminal.exit_code)
            .push(", updated_at = ")
            .push_bind(now.clone())
            .push(", finished_at = ")
            .push_bind(now)
            .push(" WHERE id = ")
            .push_bind(id)
            .push(" AND revision = ")
            .push_bind(i64::try_from(expected_revision)?);
        if worker_terminal {
            query
                .push(" AND status = 'running' AND claim_token = ")
                .push_bind(claim_token);
        } else {
            query.push(" AND status NOT IN ('succeeded', 'failed', 'cancelled', 'lost')");
        }
        let result = query.build().execute(&self.pool).await?;
        if result.rows_affected() != 1 {
            return mutation_failure(
                self,
                id,
                expected_revision,
                "Execution Job terminal commit 前置条件不再成立",
            )
            .await;
        }
        Ok(ExecutionJobMutation::Updated(
            self.get_execution_job(id)
                .await?
                .ok_or("Execution Job terminal commit 后无法读取")?,
        ))
    }

    async fn finish_execution_job_with_event(
        &self,
        id: &str,
        expected_revision: u64,
        claim_token: Option<&str>,
        terminal: ExecutionJobTerminal,
        event: &Event,
    ) -> Result<ExecutionJobMutation, StoreError> {
        if !terminal.status.is_terminal() {
            return Err("Execution Job finish 只能提交终态".into());
        }
        if terminal.result_event_id.as_deref() != Some(event.id.as_str()) {
            return Err(
                "Execution Job terminal result_event_id 必须等于原子提交的 Event ID".into(),
            );
        }
        let mut tx = self.pool.begin().await?;
        let Some(row) = sqlx::query("SELECT * FROM execution_jobs WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
        else {
            tx.commit().await?;
            return Ok(ExecutionJobMutation::NotFound);
        };
        let current = execution_job_from_row(&row)?;
        validate_result_event(&current, event)?;
        if current.status.is_terminal() {
            let error = terminal
                .error
                .as_ref()
                .map(|value| value.chars().take(100_000).collect::<String>());
            let exact_replay = current.status == terminal.status
                && current.result_event_id.as_deref() == Some(event.id.as_str())
                && current.result_refs == terminal.result_refs
                && current.error == error
                && current.exit_code == terminal.exit_code;
            if exact_replay {
                append_event_in_tx(&mut tx, event).await?;
                tx.commit().await?;
                return Ok(ExecutionJobMutation::Existing(current));
            }
            tx.commit().await?;
            return Ok(ExecutionJobMutation::Rejected {
                current,
                reason: "Execution Job 已有不同终态或结果 Event，不能覆盖".to_string(),
            });
        }
        if current.revision != expected_revision {
            tx.commit().await?;
            return Ok(ExecutionJobMutation::Conflict { current });
        }
        if let Err(reason) = validate_terminal_transition(&current, claim_token, &terminal) {
            tx.commit().await?;
            return Ok(ExecutionJobMutation::Rejected { current, reason });
        }
        let now = now_text();
        let worker_terminal = matches!(
            terminal.status,
            ExecutionJobStatus::Succeeded | ExecutionJobStatus::Failed
        );
        let mut query = QueryBuilder::<Postgres>::new(
            "UPDATE execution_jobs SET revision = revision + 1, status = ",
        );
        query
            .push_bind(terminal.status.as_str())
            .push(", lease_expires_at = NULL, result_event_id = ")
            .push_bind(&terminal.result_event_id)
            .push(", result_refs_json = ")
            .push_bind(serde_json::to_value(&terminal.result_refs)?)
            .push(", error = ")
            .push_bind(
                terminal
                    .error
                    .as_ref()
                    .map(|value| value.chars().take(100_000).collect::<String>()),
            )
            .push(", exit_code = ")
            .push_bind(terminal.exit_code)
            .push(", updated_at = ")
            .push_bind(now.clone())
            .push(", finished_at = ")
            .push_bind(now)
            .push(" WHERE id = ")
            .push_bind(id)
            .push(" AND revision = ")
            .push_bind(i64::try_from(expected_revision)?);
        if worker_terminal {
            query
                .push(" AND status = 'running' AND claim_token = ")
                .push_bind(claim_token);
        } else {
            query.push(" AND status NOT IN ('succeeded', 'failed', 'cancelled', 'lost')");
        }
        let result = query.build().execute(&mut *tx).await?;
        if result.rows_affected() != 1 {
            tx.rollback().await?;
            return mutation_failure(
                self,
                id,
                expected_revision,
                "Execution Job terminal/Event 原子提交前置条件不再成立",
            )
            .await;
        }
        append_event_in_tx(&mut tx, event).await?;
        let updated = sqlx::query("SELECT * FROM execution_jobs WHERE id = $1")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        let updated = execution_job_from_row(&updated)?;
        tx.commit().await?;
        Ok(ExecutionJobMutation::Updated(updated))
    }
}

fn validate_result_event(current: &ExecutionJobRecord, event: &Event) -> Result<(), StoreError> {
    let event_context_id = event.payload.get("context_id").and_then(JsonValue::as_str);
    let event_session_id = event.payload.get("session_id").and_then(JsonValue::as_str);
    let event_tool_call_id = event
        .payload
        .get("tool_call_id")
        .and_then(JsonValue::as_str);
    let event_tool_name = event.payload.get("tool_name").and_then(JsonValue::as_str);
    let event_activation_id = event
        .payload
        .get("activation_id")
        .and_then(JsonValue::as_str);
    let event_thread_id = event.payload.get("thread_id").and_then(JsonValue::as_str);
    if event_context_id != Some(current.context_id.as_str())
        || event_session_id != Some(current.session_id.as_str())
        || event_tool_call_id != Some(current.tool_call_id.as_str())
        || event_tool_name != Some(current.tool_name.as_str())
        || event_activation_id != Some(current.activation_id.as_str())
        || event_thread_id != Some(current.thread_id.as_str())
        || event.topic != "chat/tool_output"
        || event.event_type != crate::event::TYPE_TOOL_OUTPUT
    {
        return Err(format!(
            "Execution Job '{}' 的结果 Event 路由或工具因果身份不匹配",
            current.id
        )
        .into());
    }
    Ok(())
}
