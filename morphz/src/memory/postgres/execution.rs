//! PostgreSQL physical Execution Job authority.
//!
//! Jobs are revision-fenced aggregates. Worker mutations additionally carry a
//! per-claim token, so an expired or superseded worker cannot heartbeat or
//! publish a terminal result.

use super::{
    activation::activation_from_row, append_direct_thread_signal_in_tx, append_event_in_tx,
    now_text, parse_time, thread::thread_from_row, PostgresStore, StoreError,
};
use crate::event::Event;
use crate::memory::{
    ArtifactTransferExecutionRecord, ExecutionJobContextCounts, ExecutionJobFilter,
    ExecutionJobMonitorRecord, ExecutionJobMutation, ExecutionJobRecord, ExecutionJobStatus,
    ExecutionJobStore, ExecutionJobTerminal, ExecutionRetrySafety, NewArtifactTransferExecution,
    NewExecutionJob, ThreadKind,
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
            generation BIGINT NOT NULL DEFAULT 1,
            agent_id TEXT NOT NULL REFERENCES agents(id),
            context_id TEXT NOT NULL REFERENCES cognitive_contexts(id),
            session_id TEXT NOT NULL REFERENCES sessions(id),
            initiating_principal_id TEXT,
            root_turn_id TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL,
            status TEXT NOT NULL,
            control_state TEXT NOT NULL DEFAULT 'active',
            executor_kind TEXT NOT NULL,
            executor_id TEXT,
            target_id TEXT,
            lifetime TEXT NOT NULL DEFAULT 'durable',
            supervisor_kind TEXT NOT NULL DEFAULT 'legacy',
            supervisor_id TEXT,
            supervision_generation BIGINT NOT NULL DEFAULT 1,
            origin_evaluation_id TEXT,
            parent_thread_id TEXT,
            thread_group_id TEXT,
            completion_contract_json JSONB NOT NULL DEFAULT '{}'::jsonb,
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
            generation BIGINT NOT NULL DEFAULT 1,
            agent_id TEXT NOT NULL REFERENCES agents(id),
            context_id TEXT NOT NULL REFERENCES cognitive_contexts(id),
            session_id TEXT NOT NULL REFERENCES sessions(id),
            initiating_principal_id TEXT,
            trigger_event_id TEXT NOT NULL UNIQUE,
            trigger_sequence BIGINT NOT NULL,
            trigger_kind TEXT NOT NULL,
            parent_activation_id TEXT REFERENCES thread_activations(id),
            root_turn_id TEXT NOT NULL,
            context_snapshot_version BIGINT,
            admission_rank SMALLINT NOT NULL DEFAULT 3 CHECK(admission_rank BETWEEN 0 AND 4),
            status TEXT NOT NULL,
            claimed_by TEXT,
            lease_expires_at TEXT,
            dialogue_lane_released_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )"#,
        r#"ALTER TABLE threads ADD COLUMN IF NOT EXISTS initiating_principal_id TEXT"#,
        r#"ALTER TABLE threads ADD COLUMN IF NOT EXISTS target_id TEXT"#,
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
        r#"CREATE INDEX IF NOT EXISTS idx_pg_threads_supervisor
           ON threads(supervisor_kind, supervisor_id, status, updated_at DESC)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_threads_group
           ON threads(thread_group_id, status, updated_at DESC)"#,
        r#"ALTER TABLE thread_activations ADD COLUMN IF NOT EXISTS initiating_principal_id TEXT"#,
        r#"ALTER TABLE thread_activations ADD COLUMN IF NOT EXISTS generation BIGINT NOT NULL DEFAULT 1"#,
        r#"ALTER TABLE thread_activations ADD COLUMN IF NOT EXISTS dialogue_lane_released_at TEXT"#,
        r#"ALTER TABLE thread_activations ADD COLUMN IF NOT EXISTS admission_rank SMALLINT NOT NULL DEFAULT 3 CHECK(admission_rank BETWEEN 0 AND 4)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_thread_activations_admission_queue
           ON thread_activations(admission_rank, created_at, id)
           WHERE status = 'queued'"#,
        r#"CREATE TABLE IF NOT EXISTS execution_jobs (
            id TEXT PRIMARY KEY,
            revision BIGINT NOT NULL DEFAULT 1,
            activation_id TEXT NOT NULL REFERENCES thread_activations(id) ON DELETE CASCADE,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
            agent_id TEXT NOT NULL REFERENCES agents(id),
            context_id TEXT NOT NULL REFERENCES cognitive_contexts(id),
            session_id TEXT NOT NULL REFERENCES sessions(id),
            initiating_principal_id TEXT,
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
        r#"ALTER TABLE execution_jobs ADD COLUMN IF NOT EXISTS initiating_principal_id TEXT"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_execution_jobs_queue
           ON execution_jobs(status, created_at, id)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_execution_jobs_context_status
           ON execution_jobs(context_id, status, updated_at DESC)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_execution_jobs_context_active_created
           ON execution_jobs(context_id, created_at, id)
           WHERE status IN ('queued', 'waiting_approval', 'running')"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_execution_jobs_thread_status
           ON execution_jobs(thread_id, status, created_at, id)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_execution_jobs_tool_status
           ON execution_jobs(tool_name, status, created_at, id)"#,
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

pub(super) fn execution_job_from_row(row: &PgRow) -> Result<ExecutionJobRecord, StoreError> {
    Ok(ExecutionJobRecord {
        id: row.get("id"),
        revision: u64::try_from(row.get::<i64, _>("revision"))?,
        activation_id: row.get("activation_id"),
        thread_id: row.get("thread_id"),
        agent_id: row.get("agent_id"),
        context_id: row.get("context_id"),
        session_id: row.get("session_id"),
        initiating_principal_id: row.get("initiating_principal_id"),
        target_id: row.get("target_id"),
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

fn execution_job_monitor_from_row(row: &PgRow) -> Result<ExecutionJobMonitorRecord, StoreError> {
    Ok(ExecutionJobMonitorRecord {
        id: row.get("id"),
        activation_id: row.get("activation_id"),
        thread_id: row.get("thread_id"),
        context_id: row.get("context_id"),
        session_id: row.get("session_id"),
        target_id: row.get("target_id"),
        tool_name: row.get("tool_name"),
        status: parse_status(&row.get::<String, _>("status"))?,
        progress_ref: row.get("progress_ref"),
        error: row.get("error"),
        updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
    })
}

fn optional_time(row: &PgRow, column: &str) -> Result<Option<DateTime<Utc>>, StoreError> {
    row.get::<Option<String>, _>(column)
        .as_deref()
        .map(parse_time)
        .transpose()
}

pub(super) fn validate_new_job(job: &NewExecutionJob) -> Result<(), StoreError> {
    for (field, value) in [
        ("id", job.id.as_str()),
        ("activation_id", job.activation_id.as_str()),
        ("thread_id", job.thread_id.as_str()),
        ("agent_id", job.agent_id.as_str()),
        ("context_id", job.context_id.as_str()),
        ("session_id", job.session_id.as_str()),
        ("target_id", job.target_id.as_str()),
        ("tool_call_id", job.tool_call_id.as_str()),
        ("tool_name", job.tool_name.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(format!("Execution Job {field} 不能为空").into());
        }
    }
    Ok(())
}

pub(super) async fn ensure_job_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    job: &NewExecutionJob,
) -> Result<(ExecutionJobRecord, bool), StoreError> {
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
                  activations.initiating_principal_id AS activation_principal_id,
                  activations.root_turn_id AS activation_root_turn_id,
                  threads.agent_id AS thread_agent_id,
                  threads.context_id AS thread_context_id,
                  threads.session_id AS thread_session_id,
                  threads.initiating_principal_id AS thread_principal_id,
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
        || causal
            .get::<Option<String>, _>("activation_principal_id")
            .as_ref()
            .is_some_and(|principal| Some(principal) != job.initiating_principal_id.as_ref())
        || causal
            .get::<Option<String>, _>("thread_principal_id")
            .as_ref()
            .is_some_and(|principal| Some(principal) != job.initiating_principal_id.as_ref())
    {
        return Err("Execution Job 的 Agent/Context/Session/Root Turn 因果边界不一致".into());
    }
    let target_status =
        sqlx::query_scalar::<_, String>("SELECT status FROM execution_targets WHERE id = $1")
            .bind(&job.target_id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or("Execution Job 引用的 Execution Target 不存在")?;
    if target_status == "disabled" {
        return Err("Execution Job 引用的 Execution Target 已禁用".into());
    }
    let inserted = sqlx::query(
        r#"INSERT INTO execution_jobs
           (id, revision, activation_id, thread_id, agent_id, context_id,
            session_id, initiating_principal_id, target_id, tool_call_id, tool_name, request_json, status,
            retry_safety, result_refs_json, created_at, updated_at)
           VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                   '[]'::jsonb, $14, $14)
           ON CONFLICT DO NOTHING"#,
    )
    .bind(&job.id)
    .bind(&job.activation_id)
    .bind(&job.thread_id)
    .bind(&job.agent_id)
    .bind(&job.context_id)
    .bind(&job.session_id)
    .bind(&job.initiating_principal_id)
    .bind(&job.target_id)
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
        || existing.target_id != job.target_id
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
    Ok((existing, inserted.rows_affected() == 1))
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
    async fn ensure_artifact_transfer_execution(
        &self,
        execution: NewArtifactTransferExecution,
    ) -> Result<ArtifactTransferExecutionRecord, StoreError> {
        validate_artifact_transfer_execution_shape(&execution)?;
        let mut tx = self.pool.begin().await?;

        append_event_in_tx(&mut tx, &execution.request_event).await?;
        let request_event_sequence = u64::try_from(
            sqlx::query_scalar::<_, i64>("SELECT sequence FROM events WHERE id = $1")
                .bind(&execution.request_event.id)
                .fetch_one(&mut *tx)
                .await?,
        )?;

        let now = now_text();
        execution
            .thread
            .supervision
            .validate(ThreadKind::Execution)?;
        sqlx::query(
            r#"INSERT INTO threads
               (id, revision, agent_id, context_id, session_id, initiating_principal_id,
                root_turn_id, kind, status, executor_kind, executor_id, target_id,
                lifetime, supervisor_kind, supervisor_id, supervision_generation,
                origin_evaluation_id, parent_thread_id, thread_group_id, completion_contract_json,
                delivery_status, created_at, updated_at)
               VALUES ($1, 1, $2, $3, $4, $5, $6, 'execution', 'open',
                       'artifact_transfer', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
                       'none', $17, $17)
               ON CONFLICT DO NOTHING"#,
        )
        .bind(&execution.thread.id)
        .bind(&execution.thread.agent_id)
        .bind(&execution.thread.context_id)
        .bind(&execution.thread.session_id)
        .bind(&execution.thread.initiating_principal_id)
        .bind(&execution.thread.root_turn_id)
        .bind(&execution.thread.executor_id)
        .bind(&execution.thread.target_id)
        .bind(execution.thread.supervision.lifetime.as_str())
        .bind(execution.thread.supervision.supervisor_kind.as_str())
        .bind(&execution.thread.supervision.supervisor_id)
        .bind(i64::try_from(execution.thread.supervision.generation)?)
        .bind(&execution.thread.supervision.origin_evaluation_id)
        .bind(&execution.thread.supervision.parent_thread_id)
        .bind(&execution.thread.supervision.thread_group_id)
        .bind(&execution.thread.supervision.completion_contract)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        let thread_row = sqlx::query("SELECT * FROM threads WHERE root_turn_id = $1")
            .bind(&execution.thread.root_turn_id)
            .fetch_one(&mut *tx)
            .await?;
        let thread = thread_from_row(&thread_row)?;
        if thread.id != execution.thread.id
            || thread.agent_id != execution.thread.agent_id
            || thread.context_id != execution.thread.context_id
            || thread.session_id != execution.thread.session_id
            || thread.initiating_principal_id != execution.thread.initiating_principal_id
            || thread.kind != ThreadKind::Execution
            || thread.executor_kind != "artifact_transfer"
            || thread.executor_id != execution.thread.executor_id
            || thread.target_id != execution.thread.target_id
            || thread.supervision != execution.thread.supervision
        {
            return Err(format!(
                "Artifact Transfer root '{}' 已被不同 Thread 占用",
                execution.thread.root_turn_id
            )
            .into());
        }

        sqlx::query(
            r#"INSERT INTO thread_activations
               (id, revision, generation, agent_id, context_id, session_id,
                initiating_principal_id, trigger_event_id, trigger_sequence, trigger_kind,
                parent_activation_id, root_turn_id, status, created_at, updated_at)
               VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8,
                       'runtime/artifact_transfer_requested', $9, $10, 'queued', $11, $11)
               ON CONFLICT DO NOTHING"#,
        )
        .bind(&execution.activation.id)
        .bind(i64::try_from(thread.generation)?)
        .bind(&execution.activation.agent_id)
        .bind(&execution.activation.context_id)
        .bind(&execution.activation.session_id)
        .bind(&execution.activation.initiating_principal_id)
        .bind(&execution.activation.trigger_event_id)
        .bind(i64::try_from(request_event_sequence)?)
        .bind(&execution.activation.parent_activation_id)
        .bind(&execution.activation.root_turn_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        let activation_row =
            sqlx::query("SELECT * FROM thread_activations WHERE trigger_event_id = $1")
                .bind(&execution.activation.trigger_event_id)
                .fetch_one(&mut *tx)
                .await?;
        let activation = activation_from_row(&activation_row)?;
        if activation.id != execution.activation.id
            || activation.agent_id != execution.activation.agent_id
            || activation.context_id != execution.activation.context_id
            || activation.session_id != execution.activation.session_id
            || activation.initiating_principal_id != execution.activation.initiating_principal_id
            || activation.root_turn_id != execution.activation.root_turn_id
            || activation.trigger_sequence != request_event_sequence
            || activation.trigger_kind != "runtime/artifact_transfer_requested"
            || activation.parent_activation_id != execution.activation.parent_activation_id
        {
            return Err(format!(
                "Artifact Transfer Event '{}' 已被不同 Activation 占用",
                execution.activation.trigger_event_id
            )
            .into());
        }

        let (job, _) = ensure_job_in_tx(&mut tx, &execution.job).await?;
        tx.commit().await?;
        Ok(ArtifactTransferExecutionRecord {
            request_event_sequence,
            thread,
            activation,
            job,
        })
    }

    async fn create_execution_job(
        &self,
        job: NewExecutionJob,
    ) -> Result<ExecutionJobRecord, StoreError> {
        let mut tx = self.pool.begin().await?;
        let (job, _) = ensure_job_in_tx(&mut tx, &job).await?;
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
        if let Some(target_id) = filter.target_id {
            query.push(" AND target_id = ").push_bind(target_id);
        }
        if let Some(tool_name) = filter.tool_name {
            query.push(" AND tool_name = ").push_bind(tool_name);
        }
        if let Some(status) = filter.status {
            query.push(" AND status = ").push_bind(status.as_str());
        } else if !filter.include_terminal {
            query.push(" AND status IN ('queued', 'waiting_approval', 'running')");
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

    async fn list_active_execution_jobs_for_contexts(
        &self,
        context_ids: &[String],
        limit: usize,
    ) -> Result<Vec<ExecutionJobMonitorRecord>, StoreError> {
        if context_ids.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let mut query = QueryBuilder::<Postgres>::new(
            "SELECT id, activation_id, thread_id, context_id, session_id, target_id, tool_name, status, progress_ref, error, updated_at FROM execution_jobs WHERE status IN ('queued', 'waiting_approval', 'running') AND context_id IN (",
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
            .map(execution_job_monitor_from_row)
            .collect()
    }

    async fn count_context_active_execution_jobs(
        &self,
        context_id: &str,
    ) -> Result<ExecutionJobContextCounts, StoreError> {
        let row = sqlx::query(
            r#"SELECT COUNT(*) AS active_jobs,
                      COALESCE(SUM(CASE WHEN job.status = 'waiting_approval' THEN 1 ELSE 0 END), 0)
                        AS waiting_approval_jobs
               FROM execution_jobs job
               INNER JOIN thread_activations activation ON activation.id = job.activation_id
               INNER JOIN threads thread ON thread.id = job.thread_id
               WHERE job.context_id = $1
                 AND job.status IN ('queued', 'waiting_approval', 'running')
                 AND activation.status IN ('queued', 'running')
                 AND thread.status = 'open'"#,
        )
        .bind(context_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(ExecutionJobContextCounts {
            active_jobs: usize::try_from(row.get::<i64, _>("active_jobs"))?,
            waiting_approval_jobs: usize::try_from(row.get::<i64, _>("waiting_approval_jobs"))?,
        })
    }

    async fn list_execution_jobs_for_activations(
        &self,
        context_id: &str,
        activation_ids: &[String],
    ) -> Result<Vec<ExecutionJobRecord>, StoreError> {
        if activation_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut records = Vec::new();
        for activation_ids in activation_ids.chunks(500) {
            let mut query =
                QueryBuilder::<Postgres>::new("SELECT * FROM execution_jobs WHERE context_id = ");
            query.push_bind(context_id).push(" AND activation_id IN (");
            {
                let mut values = query.separated(", ");
                for activation_id in activation_ids {
                    values.push_bind(activation_id);
                }
            }
            query.push(") ORDER BY created_at, id");
            let rows = query.build().fetch_all(&self.pool).await?;
            records.extend(
                rows.iter()
                    .map(execution_job_from_row)
                    .collect::<Result<Vec<_>, _>>()?,
            );
        }
        Ok(records)
    }

    async fn list_terminal_execution_jobs_needing_signal(
        &self,
        tool_name: &str,
    ) -> Result<Vec<ExecutionJobRecord>, StoreError> {
        let rows = sqlx::query(
            r#"SELECT j.*
               FROM execution_jobs j
               JOIN threads t ON t.id = j.thread_id AND t.status = 'open'
               WHERE j.tool_name = $1
                 AND j.status IN ('succeeded', 'failed', 'cancelled', 'lost')
                 AND j.result_event_id IS NOT NULL
                 AND NOT EXISTS (
                     SELECT 1 FROM thread_signals s
                     WHERE s.event_id = j.result_event_id
                 )
               ORDER BY j.finished_at, j.id"#,
        )
        .bind(tool_name)
        .fetch_all(&self.pool)
        .await?;
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
                 AND (side_effect_started_at IS NULL OR retry_safety = 'idempotent')
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
                "只有未请求取消、且尚未越过副作用边界或声明为 idempotent 的 running Job 可以恢复为 queued",
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
        if current.cancel_requested_at.is_some() {
            return Ok(ExecutionJobMutation::Updated(current));
        }
        let now = now_text();
        let result = sqlx::query(
            r#"UPDATE execution_jobs
               SET revision = revision + 1,
                   cancel_requested_at = COALESCE(cancel_requested_at, $1),
                   cancel_reason = CASE WHEN cancel_requested_at IS NULL THEN $2 ELSE cancel_reason END,
                   updated_at = $1
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
        wake_thread: bool,
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
                if wake_thread {
                    append_direct_thread_signal_in_tx(&mut tx, event, &current.thread_id).await?;
                }
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
        if wake_thread {
            append_direct_thread_signal_in_tx(&mut tx, event, &current.thread_id).await?;
        }
        let updated = sqlx::query("SELECT * FROM execution_jobs WHERE id = $1")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        let updated = execution_job_from_row(&updated)?;
        tx.commit().await?;
        Ok(ExecutionJobMutation::Updated(updated))
    }

    async fn reconcile_execution_job_from_event(
        &self,
        id: &str,
        expected_revision: u64,
        terminal: ExecutionJobTerminal,
        event: &Event,
        wake_thread: bool,
    ) -> Result<ExecutionJobMutation, StoreError> {
        if !terminal.status.is_terminal() {
            return Err("Execution Job reconcile 只能提交终态".into());
        }
        if terminal.result_event_id.as_deref() != Some(event.id.as_str()) {
            return Err("Execution Job reconcile result_event_id 必须等于既存 Event ID".into());
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
        verify_existing_event_in_tx(&mut tx, event).await?;

        let error = terminal
            .error
            .as_ref()
            .map(|value| value.chars().take(100_000).collect::<String>());
        if current.status.is_terminal() {
            let exact_replay = current.status == terminal.status
                && current.result_event_id.as_deref() == Some(event.id.as_str())
                && current.result_refs == terminal.result_refs
                && current.error == error
                && current.exit_code == terminal.exit_code;
            if exact_replay {
                if wake_thread {
                    append_direct_thread_signal_in_tx(&mut tx, event, &current.thread_id).await?;
                }
                tx.commit().await?;
                return Ok(ExecutionJobMutation::Existing(current));
            }
            tx.commit().await?;
            return Ok(ExecutionJobMutation::Rejected {
                current,
                reason: "Execution Job 已有不同终态，不能用既存 Event 覆盖".to_string(),
            });
        }
        if current.revision != expected_revision {
            tx.commit().await?;
            return Ok(ExecutionJobMutation::Conflict { current });
        }

        let now = now_text();
        let result = sqlx::query(
            r#"UPDATE execution_jobs
               SET revision = revision + 1, status = $1, lease_expires_at = NULL,
                   result_event_id = $2, result_refs_json = $3, error = $4,
                   exit_code = $5, updated_at = $6, finished_at = $7
               WHERE id = $8 AND revision = $9
                 AND status NOT IN ('succeeded', 'failed', 'cancelled', 'lost')"#,
        )
        .bind(terminal.status.as_str())
        .bind(&terminal.result_event_id)
        .bind(serde_json::to_value(&terminal.result_refs)?)
        .bind(&error)
        .bind(terminal.exit_code)
        .bind(&now)
        .bind(&now)
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() != 1 {
            tx.rollback().await?;
            return mutation_failure(
                self,
                id,
                expected_revision,
                "Execution Job 既存 Event 恢复前置条件不再成立",
            )
            .await;
        }
        if wake_thread {
            append_direct_thread_signal_in_tx(&mut tx, event, &current.thread_id).await?;
        }
        let updated = sqlx::query("SELECT * FROM execution_jobs WHERE id = $1")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        let updated = execution_job_from_row(&updated)?;
        tx.commit().await?;
        Ok(ExecutionJobMutation::Updated(updated))
    }
}

fn validate_artifact_transfer_execution_shape(
    execution: &NewArtifactTransferExecution,
) -> Result<(), StoreError> {
    if execution.request_event.topic != "runtime/artifact_transfer_requested"
        || execution.request_event.event_type != "runtime_control"
    {
        return Err(
            "Artifact Transfer 必须由 runtime/artifact_transfer_requested Event 启动".into(),
        );
    }
    if execution.thread.kind != ThreadKind::Execution
        || execution.thread.executor_kind != "artifact_transfer"
    {
        return Err("Artifact Transfer 必须使用 Execution/artifact_transfer Thread".into());
    }
    let event_context = execution
        .request_event
        .payload
        .get("context_id")
        .and_then(JsonValue::as_str);
    let event_session = execution
        .request_event
        .payload
        .get("session_id")
        .and_then(JsonValue::as_str);
    let event_thread = execution
        .request_event
        .payload
        .get("thread_id")
        .and_then(JsonValue::as_str);
    if execution.activation.trigger_event_id != execution.request_event.id
        || execution.activation.root_turn_id != execution.thread.root_turn_id
        || execution.job.activation_id != execution.activation.id
        || execution.job.thread_id != execution.thread.id
        || execution.job.tool_name != crate::artifact::ARTIFACT_TRANSFER_TOOL_NAME
        || execution.job.agent_id != execution.thread.agent_id
        || execution.job.context_id != execution.thread.context_id
        || execution.job.session_id != execution.thread.session_id
        || execution.activation.agent_id != execution.thread.agent_id
        || execution.activation.context_id != execution.thread.context_id
        || execution.activation.session_id != execution.thread.session_id
        || execution.job.initiating_principal_id != execution.thread.initiating_principal_id
        || execution.activation.initiating_principal_id != execution.thread.initiating_principal_id
        || event_context != Some(execution.thread.context_id.as_str())
        || event_session != Some(execution.thread.session_id.as_str())
        || event_thread != Some(execution.thread.id.as_str())
    {
        return Err("Artifact Transfer Event/Thread/Activation/Job 因果边界不一致".into());
    }
    Ok(())
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
        || !crate::memory::execution_job_result_topic_matches(&current.tool_name, &event.topic)
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

async fn verify_existing_event_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    event: &Event,
) -> Result<(), StoreError> {
    let Some(existing) = sqlx::query(
        r#"SELECT timestamp, actor, type, topic, context_id, session_id, payload
           FROM events WHERE id = $1"#,
    )
    .bind(&event.id)
    .fetch_optional(&mut **tx)
    .await?
    else {
        return Err(format!("Execution Job 恢复只能使用已持久化 Event '{}'", event.id).into());
    };
    let session_id = event.payload.get("session_id").and_then(JsonValue::as_str);
    let context_id = event
        .payload
        .get("context_id")
        .and_then(JsonValue::as_str)
        .or(session_id);
    let stored_timestamp =
        DateTime::parse_from_rfc3339(&existing.get::<String, _>("timestamp"))?.with_timezone(&Utc);
    let same = stored_timestamp == event.timestamp
        && existing.get::<String, _>("actor") == event.actor
        && existing.get::<String, _>("type") == event.event_type
        && existing.get::<String, _>("topic") == event.topic
        && existing.get::<Option<String>, _>("context_id").as_deref() == context_id
        && existing.get::<Option<String>, _>("session_id").as_deref() == session_id
        && existing.get::<JsonValue, _>("payload") == JsonValue::Object(event.payload.clone());
    if !same {
        return Err(format!(
            "Execution Job 恢复引用的 Event '{}' 与持久化事件内容不一致",
            event.id
        )
        .into());
    }
    Ok(())
}
