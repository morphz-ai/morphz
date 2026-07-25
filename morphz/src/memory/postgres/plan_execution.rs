//! PostgreSQL authority for durable Runtime-owned Yao plan executions.

use super::{now_text, parse_time, PostgresStore, StoreError};
use crate::memory::{
    NewExecutionJob, NewPlanExecution, PlanExecutionFilter, PlanExecutionJobCommit,
    PlanExecutionMutation, PlanExecutionRecord, PlanExecutionStatus, PlanExecutionStore,
    PlanExecutionWaitKind,
};
use chrono::{DateTime, Utc};
use serde_json::Value as JsonValue;
use sqlx::postgres::PgRow;
use sqlx::{PgPool, Postgres, QueryBuilder, Row};

pub(super) async fn migrate(pool: &PgPool) -> Result<(), StoreError> {
    for statement in [
        r#"CREATE TABLE IF NOT EXISTS plan_executions (
            id TEXT PRIMARY KEY,
            revision BIGINT NOT NULL DEFAULT 1 CHECK(revision >= 1),
            activation_id TEXT NOT NULL REFERENCES thread_activations(id) ON DELETE CASCADE,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
            agent_id TEXT NOT NULL REFERENCES agents(id),
            context_id TEXT NOT NULL REFERENCES cognitive_contexts(id),
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            initiating_principal_id TEXT,
            tool_call_id TEXT NOT NULL,
            objective_id TEXT,
            objective_evaluation_id TEXT,
            harness_id TEXT,
            harness_version TEXT,
            source_artifact_hash TEXT NOT NULL,
            ir_schema_version BIGINT NOT NULL CHECK(ir_schema_version >= 1),
            program_json JSONB NOT NULL,
            state_json JSONB NOT NULL,
            budget_json JSONB NOT NULL,
            status TEXT NOT NULL CHECK(status IN (
                'queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'
            )),
            pending_kind TEXT CHECK(pending_kind IN (
                'execution_job', 'action_group', 'evaluation'
            )),
            pending_id TEXT,
            claimed_by TEXT,
            claim_token TEXT,
            lease_expires_at TEXT,
            result_json JSONB,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            finished_at TEXT,
            UNIQUE(activation_id, tool_call_id),
            CHECK((status = 'waiting' AND pending_kind IS NOT NULL AND pending_id IS NOT NULL)
               OR (status <> 'waiting' AND pending_kind IS NULL AND pending_id IS NULL))
        )"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_plan_executions_queue
           ON plan_executions(status, lease_expires_at, created_at, id)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_plan_executions_context_status
           ON plan_executions(context_id, status, updated_at DESC)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_plan_executions_pending
           ON plan_executions(pending_kind, pending_id) WHERE status = 'waiting'"#,
        r#"CREATE OR REPLACE FUNCTION reject_plan_execution_terminal_reopen()
           RETURNS trigger AS $$
           BEGIN
             IF OLD.status IN ('succeeded', 'failed', 'cancelled')
                AND NEW.status <> OLD.status THEN
               RAISE EXCEPTION 'plan execution terminal status is irreversible';
             END IF;
             RETURN NEW;
           END;
           $$ LANGUAGE plpgsql"#,
        r#"DROP TRIGGER IF EXISTS plan_executions_terminal_status_is_irreversible
           ON plan_executions"#,
        r#"CREATE TRIGGER plan_executions_terminal_status_is_irreversible
           BEFORE UPDATE OF status ON plan_executions
           FOR EACH ROW EXECUTE FUNCTION reject_plan_execution_terminal_reopen()"#,
    ] {
        sqlx::query(statement).execute(pool).await?;
    }
    Ok(())
}

fn parse_status(value: &str) -> Result<PlanExecutionStatus, StoreError> {
    match value {
        "queued" => Ok(PlanExecutionStatus::Queued),
        "running" => Ok(PlanExecutionStatus::Running),
        "waiting" => Ok(PlanExecutionStatus::Waiting),
        "succeeded" => Ok(PlanExecutionStatus::Succeeded),
        "failed" => Ok(PlanExecutionStatus::Failed),
        "cancelled" => Ok(PlanExecutionStatus::Cancelled),
        other => Err(format!("未知 PlanExecution status：'{other}'").into()),
    }
}

fn parse_wait_kind(value: &str) -> Result<PlanExecutionWaitKind, StoreError> {
    match value {
        "execution_job" => Ok(PlanExecutionWaitKind::ExecutionJob),
        "action_group" => Ok(PlanExecutionWaitKind::ActionGroup),
        "evaluation" => Ok(PlanExecutionWaitKind::Evaluation),
        other => Err(format!("未知 PlanExecution wait kind：'{other}'").into()),
    }
}

fn optional_time(row: &PgRow, column: &str) -> Result<Option<DateTime<Utc>>, StoreError> {
    row.get::<Option<String>, _>(column)
        .as_deref()
        .map(parse_time)
        .transpose()
}

fn record_from_row(row: &PgRow) -> Result<PlanExecutionRecord, StoreError> {
    Ok(PlanExecutionRecord {
        id: row.get("id"),
        revision: u64::try_from(row.get::<i64, _>("revision"))?,
        activation_id: row.get("activation_id"),
        thread_id: row.get("thread_id"),
        agent_id: row.get("agent_id"),
        context_id: row.get("context_id"),
        session_id: row.get("session_id"),
        initiating_principal_id: row.get("initiating_principal_id"),
        tool_call_id: row.get("tool_call_id"),
        objective_id: row.get("objective_id"),
        objective_evaluation_id: row.get("objective_evaluation_id"),
        harness_id: row.get("harness_id"),
        harness_version: row.get("harness_version"),
        source_artifact_hash: row.get("source_artifact_hash"),
        ir_schema_version: u32::try_from(row.get::<i64, _>("ir_schema_version"))?,
        program_json: row.get("program_json"),
        state_json: row.get("state_json"),
        budget_json: row.get("budget_json"),
        status: parse_status(&row.get::<String, _>("status"))?,
        pending_kind: row
            .get::<Option<String>, _>("pending_kind")
            .as_deref()
            .map(parse_wait_kind)
            .transpose()?,
        pending_id: row.get("pending_id"),
        claimed_by: row.get("claimed_by"),
        claim_token: row.get("claim_token"),
        lease_expires_at: optional_time(row, "lease_expires_at")?,
        result_json: row.get("result_json"),
        error: row.get("error"),
        created_at: parse_time(&row.get::<String, _>("created_at"))?,
        updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
        finished_at: optional_time(row, "finished_at")?,
    })
}

fn validate_new(value: &NewPlanExecution) -> Result<(), StoreError> {
    for (field, text) in [
        ("id", value.id.as_str()),
        ("activation_id", value.activation_id.as_str()),
        ("thread_id", value.thread_id.as_str()),
        ("agent_id", value.agent_id.as_str()),
        ("context_id", value.context_id.as_str()),
        ("session_id", value.session_id.as_str()),
        ("tool_call_id", value.tool_call_id.as_str()),
        ("source_artifact_hash", value.source_artifact_hash.as_str()),
    ] {
        if text.trim().is_empty() {
            return Err(format!("PlanExecution {field} 不能为空").into());
        }
    }
    if value.ir_schema_version == 0 {
        return Err("PlanExecution ir_schema_version 必须大于 0".into());
    }
    Ok(())
}

fn same_immutable(existing: &PlanExecutionRecord, new: &NewPlanExecution) -> bool {
    existing.id == new.id
        && existing.activation_id == new.activation_id
        && existing.thread_id == new.thread_id
        && existing.agent_id == new.agent_id
        && existing.context_id == new.context_id
        && existing.session_id == new.session_id
        && existing.initiating_principal_id == new.initiating_principal_id
        && existing.tool_call_id == new.tool_call_id
        && existing.objective_id == new.objective_id
        && existing.objective_evaluation_id == new.objective_evaluation_id
        && existing.harness_id == new.harness_id
        && existing.harness_version == new.harness_version
        && existing.source_artifact_hash == new.source_artifact_hash
        && existing.ir_schema_version == new.ir_schema_version
        && existing.program_json == new.program_json
}

async fn current(
    store: &PostgresStore,
    id: &str,
) -> Result<Option<PlanExecutionRecord>, StoreError> {
    sqlx::query("SELECT * FROM plan_executions WHERE id = $1")
        .bind(id)
        .fetch_optional(&store.pool)
        .await?
        .as_ref()
        .map(record_from_row)
        .transpose()
}

async fn failed_mutation(
    store: &PostgresStore,
    id: &str,
    expected_revision: u64,
    reason: impl Into<String>,
) -> Result<PlanExecutionMutation, StoreError> {
    Ok(match current(store, id).await? {
        Some(current) if current.revision != expected_revision => {
            PlanExecutionMutation::Conflict { current }
        }
        Some(current) => PlanExecutionMutation::Rejected {
            current: Some(current),
            reason: reason.into(),
        },
        None => PlanExecutionMutation::NotFound,
    })
}

#[async_trait::async_trait]
impl PlanExecutionStore for PostgresStore {
    async fn create_plan_execution(
        &self,
        execution: NewPlanExecution,
    ) -> Result<PlanExecutionRecord, StoreError> {
        validate_new(&execution)?;
        let now = now_text();
        sqlx::query(
            r#"INSERT INTO plan_executions
               (id, revision, activation_id, thread_id, agent_id, context_id, session_id,
                initiating_principal_id, tool_call_id, objective_id, objective_evaluation_id,
                harness_id, harness_version, source_artifact_hash, ir_schema_version,
                program_json, state_json, budget_json, status, created_at, updated_at)
               VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                       $13, $14, $15, $16, $17, 'queued', $18, $19)
               ON CONFLICT DO NOTHING"#,
        )
        .bind(&execution.id)
        .bind(&execution.activation_id)
        .bind(&execution.thread_id)
        .bind(&execution.agent_id)
        .bind(&execution.context_id)
        .bind(&execution.session_id)
        .bind(&execution.initiating_principal_id)
        .bind(&execution.tool_call_id)
        .bind(&execution.objective_id)
        .bind(&execution.objective_evaluation_id)
        .bind(&execution.harness_id)
        .bind(&execution.harness_version)
        .bind(&execution.source_artifact_hash)
        .bind(i64::from(execution.ir_schema_version))
        .bind(&execution.program_json)
        .bind(&execution.state_json)
        .bind(&execution.budget_json)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;

        let existing = sqlx::query(
            "SELECT * FROM plan_executions WHERE activation_id = $1 AND tool_call_id = $2",
        )
        .bind(&execution.activation_id)
        .bind(&execution.tool_call_id)
        .fetch_one(&self.pool)
        .await?;
        let existing = record_from_row(&existing)?;
        if !same_immutable(&existing, &execution) {
            return Err(format!(
                "PlanExecution causal key '({}, {})' 已被不同程序或 route 占用",
                execution.activation_id, execution.tool_call_id
            )
            .into());
        }
        Ok(existing)
    }

    async fn get_plan_execution(
        &self,
        id: &str,
    ) -> Result<Option<PlanExecutionRecord>, StoreError> {
        current(self, id).await
    }

    async fn list_plan_executions(
        &self,
        filter: PlanExecutionFilter,
    ) -> Result<Vec<PlanExecutionRecord>, StoreError> {
        let mut query = QueryBuilder::<Postgres>::new("SELECT * FROM plan_executions WHERE TRUE");
        if let Some(context_id) = filter.context_id {
            query.push(" AND context_id = ").push_bind(context_id);
        }
        if let Some(session_id) = filter.session_id {
            query.push(" AND session_id = ").push_bind(session_id);
        }
        if let Some(activation_id) = filter.activation_id {
            query.push(" AND activation_id = ").push_bind(activation_id);
        }
        if let Some(status) = filter.status {
            query
                .push(" AND status = ")
                .push_bind(status.as_str().to_string());
        } else if !filter.include_terminal {
            query.push(" AND status NOT IN ('succeeded', 'failed', 'cancelled')");
        }
        query.push(" ORDER BY updated_at DESC, id");
        if let Some(limit) = filter.limit {
            query.push(" LIMIT ").push_bind(i64::try_from(limit)?);
        }
        query
            .build()
            .fetch_all(&self.pool)
            .await?
            .iter()
            .map(record_from_row)
            .collect()
    }

    async fn claim_plan_execution(
        &self,
        id: &str,
        expected_revision: u64,
        worker_id: &str,
        claim_token: &str,
        lease_expires_at: DateTime<Utc>,
    ) -> Result<PlanExecutionMutation, StoreError> {
        if worker_id.trim().is_empty() || claim_token.trim().is_empty() {
            return Ok(PlanExecutionMutation::Rejected {
                current: current(self, id).await?,
                reason: "PlanExecution claim 需要 worker_id 与 claim_token".to_string(),
            });
        }
        let now = now_text();
        let row = sqlx::query(
            r#"UPDATE plan_executions
               SET revision = revision + 1, status = 'running', claimed_by = $1,
                   claim_token = $2, lease_expires_at = $3, updated_at = $4
               WHERE id = $5 AND revision = $6
                 AND (status = 'queued'
                   OR (status = 'running' AND lease_expires_at IS NOT NULL
                       AND lease_expires_at <= $7))
               RETURNING *"#,
        )
        .bind(worker_id)
        .bind(claim_token)
        .bind(lease_expires_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
        .bind(&now)
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
        .bind(&now)
        .fetch_optional(&self.pool)
        .await?;
        match row {
            Some(row) => Ok(PlanExecutionMutation::Updated(record_from_row(&row)?)),
            None => {
                failed_mutation(self, id, expected_revision, "PlanExecution 当前不可 claim").await
            }
        }
    }

    async fn heartbeat_plan_execution(
        &self,
        id: &str,
        expected_revision: u64,
        claim_token: &str,
        lease_expires_at: DateTime<Utc>,
        state_json: &JsonValue,
        budget_json: &JsonValue,
    ) -> Result<PlanExecutionMutation, StoreError> {
        let row = sqlx::query(
            r#"UPDATE plan_executions
               SET revision = revision + 1, lease_expires_at = $1, state_json = $2,
                   budget_json = $3, updated_at = $4
               WHERE id = $5 AND revision = $6 AND status = 'running' AND claim_token = $7
               RETURNING *"#,
        )
        .bind(lease_expires_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
        .bind(state_json)
        .bind(budget_json)
        .bind(now_text())
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
        .bind(claim_token)
        .fetch_optional(&self.pool)
        .await?;
        match row {
            Some(row) => Ok(PlanExecutionMutation::Updated(record_from_row(&row)?)),
            None => {
                failed_mutation(
                    self,
                    id,
                    expected_revision,
                    "PlanExecution heartbeat fence 不匹配",
                )
                .await
            }
        }
    }

    async fn suspend_plan_execution(
        &self,
        id: &str,
        expected_revision: u64,
        claim_token: &str,
        state_json: &JsonValue,
        budget_json: &JsonValue,
        pending_kind: PlanExecutionWaitKind,
        pending_id: &str,
    ) -> Result<PlanExecutionMutation, StoreError> {
        if pending_id.trim().is_empty() {
            return Ok(PlanExecutionMutation::Rejected {
                current: current(self, id).await?,
                reason: "PlanExecution pending_id 不能为空".to_string(),
            });
        }
        let row = sqlx::query(
            r#"UPDATE plan_executions
               SET revision = revision + 1, status = 'waiting', state_json = $1,
                   budget_json = $2, pending_kind = $3, pending_id = $4,
                   claimed_by = NULL, claim_token = NULL, lease_expires_at = NULL,
                   updated_at = $5
               WHERE id = $6 AND revision = $7 AND status = 'running' AND claim_token = $8
               RETURNING *"#,
        )
        .bind(state_json)
        .bind(budget_json)
        .bind(pending_kind.as_str())
        .bind(pending_id)
        .bind(now_text())
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
        .bind(claim_token)
        .fetch_optional(&self.pool)
        .await?;
        match row {
            Some(row) => Ok(PlanExecutionMutation::Updated(record_from_row(&row)?)),
            None => {
                failed_mutation(
                    self,
                    id,
                    expected_revision,
                    "PlanExecution suspend fence 不匹配",
                )
                .await
            }
        }
    }

    async fn create_execution_job_and_suspend_plan(
        &self,
        plan_id: &str,
        expected_revision: u64,
        claim_token: &str,
        state_json: &JsonValue,
        budget_json: &JsonValue,
        job: NewExecutionJob,
    ) -> Result<PlanExecutionJobCommit, StoreError> {
        if job.id.trim().is_empty() {
            return Err("PlanExecution child Execution Job id 不能为空".into());
        }
        let mut tx = self.pool.begin().await?;
        let current_row = sqlx::query("SELECT * FROM plan_executions WHERE id = $1 FOR UPDATE")
            .bind(plan_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| format!("PlanExecution '{plan_id}' 不存在"))?;
        let current_plan = record_from_row(&current_row)?;

        if current_plan.status == PlanExecutionStatus::Waiting
            && current_plan.pending_kind == Some(PlanExecutionWaitKind::ExecutionJob)
            && current_plan.pending_id.as_deref() == Some(job.id.as_str())
        {
            if current_plan.state_json != *state_json || current_plan.budget_json != *budget_json {
                return Err(format!(
                    "PlanExecution '{}' 已等待 Execution Job '{}'，但重放的 machine state 不同",
                    plan_id, job.id
                )
                .into());
            }
            let (execution_job, _) = super::execution::ensure_job_in_tx(&mut tx, &job).await?;
            tx.commit().await?;
            return Ok(PlanExecutionJobCommit {
                plan: current_plan,
                execution_job,
                existing: true,
            });
        }

        if current_plan.revision != expected_revision
            || current_plan.status != PlanExecutionStatus::Running
            || current_plan.claim_token.as_deref() != Some(claim_token)
        {
            return Err(format!(
                "PlanExecution '{}' 不能提交 child hand-off：期待 running r{} fence，当前为 {} r{}",
                plan_id,
                expected_revision,
                current_plan.status.as_str(),
                current_plan.revision
            )
            .into());
        }
        if job.activation_id != current_plan.activation_id
            || job.thread_id != current_plan.thread_id
            || job.agent_id != current_plan.agent_id
            || job.context_id != current_plan.context_id
            || job.session_id != current_plan.session_id
            || job.initiating_principal_id != current_plan.initiating_principal_id
        {
            return Err("PlanExecution 与 child Execution Job 的因果 route 不一致".into());
        }

        let (execution_job, child_created) =
            super::execution::ensure_job_in_tx(&mut tx, &job).await?;
        let updated = sqlx::query(
            r#"UPDATE plan_executions
               SET revision = revision + 1, status = 'waiting', state_json = $1,
                   budget_json = $2, pending_kind = 'execution_job', pending_id = $3,
                   claimed_by = NULL, claim_token = NULL, lease_expires_at = NULL,
                   updated_at = $4
               WHERE id = $5 AND revision = $6 AND status = 'running' AND claim_token = $7
               RETURNING *"#,
        )
        .bind(state_json)
        .bind(budget_json)
        .bind(&execution_job.id)
        .bind(now_text())
        .bind(plan_id)
        .bind(i64::try_from(expected_revision)?)
        .bind(claim_token)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(updated) = updated else {
            return Err(format!(
                "PlanExecution '{}' child hand-off 在同一事务内丢失 fence",
                plan_id
            )
            .into());
        };
        let plan = record_from_row(&updated)?;
        tx.commit().await?;
        Ok(PlanExecutionJobCommit {
            plan,
            execution_job,
            existing: !child_created,
        })
    }

    async fn resume_plan_execution(
        &self,
        id: &str,
        expected_revision: u64,
        pending_kind: PlanExecutionWaitKind,
        pending_id: &str,
        state_json: &JsonValue,
        budget_json: &JsonValue,
    ) -> Result<PlanExecutionMutation, StoreError> {
        let row = sqlx::query(
            r#"UPDATE plan_executions
               SET revision = revision + 1, status = 'queued', state_json = $1,
                   budget_json = $2, pending_kind = NULL, pending_id = NULL, updated_at = $3
               WHERE id = $4 AND revision = $5 AND status = 'waiting'
                 AND pending_kind = $6 AND pending_id = $7
               RETURNING *"#,
        )
        .bind(state_json)
        .bind(budget_json)
        .bind(now_text())
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
        .bind(pending_kind.as_str())
        .bind(pending_id)
        .fetch_optional(&self.pool)
        .await?;
        match row {
            Some(row) => Ok(PlanExecutionMutation::Updated(record_from_row(&row)?)),
            None => {
                failed_mutation(
                    self,
                    id,
                    expected_revision,
                    "PlanExecution child route 不匹配",
                )
                .await
            }
        }
    }

    async fn finish_plan_execution(
        &self,
        id: &str,
        expected_revision: u64,
        claim_token: &str,
        status: PlanExecutionStatus,
        state_json: &JsonValue,
        budget_json: &JsonValue,
        result_json: Option<&JsonValue>,
        error: Option<&str>,
    ) -> Result<PlanExecutionMutation, StoreError> {
        if !matches!(
            status,
            PlanExecutionStatus::Succeeded | PlanExecutionStatus::Failed
        ) {
            return Ok(PlanExecutionMutation::Rejected {
                current: current(self, id).await?,
                reason: "finish_plan_execution 只接受 succeeded/failed".to_string(),
            });
        }
        let now = now_text();
        let row = sqlx::query(
            r#"UPDATE plan_executions
               SET revision = revision + 1, status = $1, state_json = $2, budget_json = $3,
                   result_json = $4, error = $5, claimed_by = NULL, claim_token = NULL,
                   lease_expires_at = NULL, updated_at = $6, finished_at = $7
               WHERE id = $8 AND revision = $9 AND status = 'running' AND claim_token = $10
               RETURNING *"#,
        )
        .bind(status.as_str())
        .bind(state_json)
        .bind(budget_json)
        .bind(result_json)
        .bind(error)
        .bind(&now)
        .bind(&now)
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
        .bind(claim_token)
        .fetch_optional(&self.pool)
        .await?;
        match row {
            Some(row) => Ok(PlanExecutionMutation::Updated(record_from_row(&row)?)),
            None => {
                failed_mutation(
                    self,
                    id,
                    expected_revision,
                    "PlanExecution terminal fence 不匹配",
                )
                .await
            }
        }
    }

    async fn cancel_plan_execution(
        &self,
        id: &str,
        expected_revision: u64,
        reason: Option<&str>,
    ) -> Result<PlanExecutionMutation, StoreError> {
        let now = now_text();
        let row = sqlx::query(
            r#"UPDATE plan_executions
               SET revision = revision + 1, status = 'cancelled', error = $1,
                   pending_kind = NULL, pending_id = NULL, claimed_by = NULL,
                   claim_token = NULL, lease_expires_at = NULL,
                   updated_at = $2, finished_at = $3
               WHERE id = $4 AND revision = $5
                 AND status NOT IN ('succeeded', 'failed', 'cancelled')
               RETURNING *"#,
        )
        .bind(reason)
        .bind(&now)
        .bind(&now)
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
        .fetch_optional(&self.pool)
        .await?;
        match row {
            Some(row) => Ok(PlanExecutionMutation::Updated(record_from_row(&row)?)),
            None => {
                failed_mutation(
                    self,
                    id,
                    expected_revision,
                    "PlanExecution 已终结或 revision 不匹配",
                )
                .await
            }
        }
    }
}
