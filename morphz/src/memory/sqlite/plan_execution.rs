//! SQLite authority for durable Runtime-owned Yao plan executions.

use super::{
    append_direct_thread_signal_in_transaction, append_event_in_transaction,
    ensure_execution_job_in_transaction, ensure_thread_in_transaction, parse_time, thread_from_row,
    SqliteStore,
};
use crate::memory::{
    stable_thread_id, NewExecutionJob, NewPlanExecution, NewThread, PlanEvaluationCommit,
    PlanExecutionFilter, PlanExecutionJobCommit, PlanExecutionMutation, PlanExecutionRecord,
    PlanExecutionStatus, PlanExecutionStore, PlanExecutionWaitKind, ThreadKind, ThreadSupervision,
};
use chrono::{DateTime, Utc};
use serde_json::Value as JsonValue;
use sqlx::sqlite::SqliteRow;
use sqlx::{QueryBuilder, Row, Sqlite};

type StoreError = Box<dyn std::error::Error + Send + Sync>;

fn now_text() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true)
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

fn optional_time(row: &SqliteRow, column: &str) -> Option<DateTime<Utc>> {
    row.get::<Option<String>, _>(column)
        .as_deref()
        .map(parse_time)
}

fn json_column(row: &SqliteRow, column: &str) -> Result<JsonValue, StoreError> {
    Ok(serde_json::from_str(&row.get::<String, _>(column))?)
}

fn optional_json_column(row: &SqliteRow, column: &str) -> Result<Option<JsonValue>, StoreError> {
    row.get::<Option<String>, _>(column)
        .map(|value| serde_json::from_str(&value))
        .transpose()
        .map_err(Into::into)
}

fn validate_infer_event_route(
    plan: &PlanExecutionRecord,
    event: &crate::event::Event,
) -> Result<(), StoreError> {
    let string = |key: &str| event.payload.get(key).and_then(JsonValue::as_str);
    if string("plan_execution_id") != Some(plan.id.as_str())
        || string("agent_id") != Some(plan.agent_id.as_str())
        || string("context_id") != Some(plan.context_id.as_str())
        || string("session_id") != Some(plan.session_id.as_str())
        || string("parent_activation_id") != Some(plan.activation_id.as_str())
    {
        return Err("PlanExecution 与 child Evaluation request 的因果 route 不一致".into());
    }
    if plan.initiating_principal_id.as_deref().is_some()
        && string("principal_id") != plan.initiating_principal_id.as_deref()
    {
        return Err("PlanExecution 与 child Evaluation request 的 Principal 不一致".into());
    }
    Ok(())
}

fn record_from_row(row: &SqliteRow) -> Result<PlanExecutionRecord, StoreError> {
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
        program_json: json_column(row, "program_json")?,
        state_json: json_column(row, "state_json")?,
        budget_json: json_column(row, "budget_json")?,
        status: parse_status(&row.get::<String, _>("status"))?,
        pending_kind: row
            .get::<Option<String>, _>("pending_kind")
            .as_deref()
            .map(parse_wait_kind)
            .transpose()?,
        pending_id: row.get("pending_id"),
        claimed_by: row.get("claimed_by"),
        claim_token: row.get("claim_token"),
        lease_expires_at: optional_time(row, "lease_expires_at"),
        result_json: optional_json_column(row, "result_json")?,
        error: row.get("error"),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
        finished_at: optional_time(row, "finished_at"),
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

async fn current(store: &SqliteStore, id: &str) -> Result<Option<PlanExecutionRecord>, StoreError> {
    sqlx::query("SELECT * FROM plan_executions WHERE id = ?")
        .bind(id)
        .fetch_optional(&store.pool)
        .await?
        .as_ref()
        .map(record_from_row)
        .transpose()
}

async fn failed_mutation(
    store: &SqliteStore,
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
impl PlanExecutionStore for SqliteStore {
    async fn create_plan_execution(
        &self,
        execution: NewPlanExecution,
    ) -> Result<PlanExecutionRecord, StoreError> {
        validate_new(&execution)?;
        let now = now_text();
        sqlx::query(
            r#"INSERT OR IGNORE INTO plan_executions
               (id, revision, activation_id, thread_id, agent_id, context_id, session_id,
                initiating_principal_id, tool_call_id, objective_id, objective_evaluation_id,
                harness_id, harness_version, source_artifact_hash, ir_schema_version,
                program_json, state_json, budget_json, status, created_at, updated_at)
               VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)"#,
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
        .bind(serde_json::to_string(&execution.program_json)?)
        .bind(serde_json::to_string(&execution.state_json)?)
        .bind(serde_json::to_string(&execution.budget_json)?)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;

        let existing = sqlx::query(
            "SELECT * FROM plan_executions WHERE activation_id = ? AND tool_call_id = ?",
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
        let mut query = QueryBuilder::<Sqlite>::new("SELECT * FROM plan_executions WHERE 1=1");
        if let Some(context_id) = filter.context_id {
            query.push(" AND context_id = ").push_bind(context_id);
        }
        if let Some(session_id) = filter.session_id {
            query.push(" AND session_id = ").push_bind(session_id);
        }
        if let Some(activation_id) = filter.activation_id {
            query.push(" AND activation_id = ").push_bind(activation_id);
        }
        if let Some(tool_call_id) = filter.tool_call_id {
            query.push(" AND tool_call_id = ").push_bind(tool_call_id);
        }
        if let Some(objective_id) = filter.objective_id {
            query.push(" AND objective_id = ").push_bind(objective_id);
        }
        if let Some(objective_evaluation_id) = filter.objective_evaluation_id {
            query
                .push(" AND objective_evaluation_id = ")
                .push_bind(objective_evaluation_id);
        }
        if let Some(harness_id) = filter.harness_id {
            query.push(" AND harness_id = ").push_bind(harness_id);
        }
        if let Some(harness_version) = filter.harness_version {
            query
                .push(" AND harness_version = ")
                .push_bind(harness_version);
        }
        if let Some(source_artifact_hash) = filter.source_artifact_hash {
            query
                .push(" AND source_artifact_hash = ")
                .push_bind(source_artifact_hash);
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
               SET revision = revision + 1, status = 'running', claimed_by = ?,
                   claim_token = ?, lease_expires_at = ?, updated_at = ?
               WHERE id = ? AND revision = ?
                 AND (status = 'queued'
                   OR (status = 'running' AND lease_expires_at IS NOT NULL
                       AND lease_expires_at <= ?))
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
               SET revision = revision + 1, lease_expires_at = ?, state_json = ?,
                   budget_json = ?, updated_at = ?
               WHERE id = ? AND revision = ? AND status = 'running' AND claim_token = ?
               RETURNING *"#,
        )
        .bind(lease_expires_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
        .bind(serde_json::to_string(state_json)?)
        .bind(serde_json::to_string(budget_json)?)
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

    async fn release_plan_execution_claim(
        &self,
        id: &str,
        expected_revision: u64,
        claim_token: &str,
    ) -> Result<PlanExecutionMutation, StoreError> {
        let row = sqlx::query(
            r#"UPDATE plan_executions
               SET revision = revision + 1, status = 'queued', claimed_by = NULL,
                   claim_token = NULL, lease_expires_at = NULL, updated_at = ?
               WHERE id = ? AND revision = ? AND status = 'running' AND claim_token = ?
               RETURNING *"#,
        )
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
                    "PlanExecution release fence 不匹配",
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
               SET revision = revision + 1, status = 'waiting', state_json = ?,
                   budget_json = ?, pending_kind = ?, pending_id = ?,
                   claimed_by = NULL, claim_token = NULL, lease_expires_at = NULL,
                   updated_at = ?
               WHERE id = ? AND revision = ? AND status = 'running' AND claim_token = ?
               RETURNING *"#,
        )
        .bind(serde_json::to_string(state_json)?)
        .bind(serde_json::to_string(budget_json)?)
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
        let current_row = sqlx::query("SELECT * FROM plan_executions WHERE id = ?")
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
            let (execution_job, _) = ensure_execution_job_in_transaction(&mut tx, &job).await?;
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
            ensure_execution_job_in_transaction(&mut tx, &job).await?;
        let updated = sqlx::query(
            r#"UPDATE plan_executions
               SET revision = revision + 1, status = 'waiting', state_json = ?,
                   budget_json = ?, pending_kind = 'execution_job', pending_id = ?,
                   claimed_by = NULL, claim_token = NULL, lease_expires_at = NULL,
                   updated_at = ?
               WHERE id = ? AND revision = ? AND status = 'running' AND claim_token = ?
               RETURNING *"#,
        )
        .bind(serde_json::to_string(state_json)?)
        .bind(serde_json::to_string(budget_json)?)
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

    async fn create_evaluation_and_suspend_plan(
        &self,
        plan_id: &str,
        expected_revision: u64,
        claim_token: &str,
        state_json: &JsonValue,
        budget_json: &JsonValue,
        request_event: &crate::event::Event,
        activation_id: &str,
    ) -> Result<PlanEvaluationCommit, StoreError> {
        if activation_id.trim().is_empty() {
            return Err("PlanExecution child Activation id 不能为空".into());
        }
        let mut tx = self.pool.begin().await?;
        let current_row = sqlx::query("SELECT * FROM plan_executions WHERE id = ?")
            .bind(plan_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| format!("PlanExecution '{plan_id}' 不存在"))?;
        let current_plan = record_from_row(&current_row)?;

        if current_plan.status == PlanExecutionStatus::Waiting
            && current_plan.pending_kind == Some(PlanExecutionWaitKind::Evaluation)
            && current_plan.pending_id.as_deref() == Some(activation_id)
        {
            if current_plan.state_json != *state_json || current_plan.budget_json != *budget_json {
                return Err(format!(
                    "PlanExecution '{}' 已等待 Evaluation '{}'，但重放的 machine state 不同",
                    plan_id, activation_id
                )
                .into());
            }
            let row = sqlx::query(
                "SELECT timestamp, actor, type, topic, payload FROM events WHERE id = ?",
            )
            .bind(&request_event.id)
            .fetch_one(&mut *tx)
            .await?;
            let stored_payload: JsonValue = serde_json::from_str(&row.get::<String, _>("payload"))?;
            let same = row.get::<String, _>("timestamp")
                == request_event
                    .timestamp
                    .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true)
                && row.get::<String, _>("actor") == request_event.actor
                && row.get::<String, _>("type") == request_event.event_type
                && row.get::<String, _>("topic") == request_event.topic
                && stored_payload == JsonValue::Object(request_event.payload.clone());
            if !same {
                return Err(format!(
                    "PlanExecution '{}' 的 infer request Event '{}' 被不同内容占用",
                    plan_id, request_event.id
                )
                .into());
            }
            tx.commit().await?;
            return Ok(PlanEvaluationCommit {
                plan: current_plan,
                request_event: request_event.clone(),
                activation_id: activation_id.to_string(),
                existing: true,
            });
        }

        if current_plan.revision != expected_revision
            || current_plan.status != PlanExecutionStatus::Running
            || current_plan.claim_token.as_deref() != Some(claim_token)
        {
            return Err(format!(
                "PlanExecution '{}' 不能提交 Evaluation hand-off：期待 running r{} fence，当前为 {} r{}",
                plan_id,
                expected_revision,
                current_plan.status.as_str(),
                current_plan.revision
            )
            .into());
        }
        validate_infer_event_route(&current_plan, request_event)?;

        let parent_row = sqlx::query("SELECT * FROM threads WHERE id = ?")
            .bind(&current_plan.thread_id)
            .fetch_one(&mut *tx)
            .await?;
        let parent_thread = thread_from_row(&parent_row)?;
        let supervision = match (
            current_plan.objective_id.as_ref(),
            current_plan.objective_evaluation_id.as_ref(),
        ) {
            (Some(objective_id), Some(evaluation_id)) => ThreadSupervision::objective(
                objective_id.clone(),
                evaluation_id.clone(),
                parent_thread.supervision.generation,
                Some(parent_thread.id.clone()),
            ),
            _ => ThreadSupervision::runtime("event-router"),
        };
        let child_thread = ensure_thread_in_transaction(
            &mut tx,
            &NewThread {
                id: stable_thread_id(&request_event.id),
                agent_id: current_plan.agent_id.clone(),
                context_id: current_plan.context_id.clone(),
                session_id: current_plan.session_id.clone(),
                initiating_principal_id: current_plan.initiating_principal_id.clone(),
                root_turn_id: request_event.id.clone(),
                kind: ThreadKind::Execution,
                executor_kind: "plan_infer".to_string(),
                executor_id: Some(current_plan.id.clone()),
                target_id: None,
                supervision,
            },
        )
        .await?;
        append_event_in_transaction(&mut tx, request_event).await?;
        append_direct_thread_signal_in_transaction(&mut tx, request_event, &child_thread.id)
            .await?;
        let updated = sqlx::query(
            r#"UPDATE plan_executions
               SET revision = revision + 1, status = 'waiting', state_json = ?,
                   budget_json = ?, pending_kind = 'evaluation', pending_id = ?,
                   claimed_by = NULL, claim_token = NULL, lease_expires_at = NULL,
                   updated_at = ?
               WHERE id = ? AND revision = ? AND status = 'running' AND claim_token = ?
               RETURNING *"#,
        )
        .bind(serde_json::to_string(state_json)?)
        .bind(serde_json::to_string(budget_json)?)
        .bind(activation_id)
        .bind(now_text())
        .bind(plan_id)
        .bind(i64::try_from(expected_revision)?)
        .bind(claim_token)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(updated) = updated else {
            return Err(format!(
                "PlanExecution '{}' Evaluation hand-off 在同一事务内丢失 fence",
                plan_id
            )
            .into());
        };
        let plan = record_from_row(&updated)?;
        tx.commit().await?;
        Ok(PlanEvaluationCommit {
            plan,
            request_event: request_event.clone(),
            activation_id: activation_id.to_string(),
            existing: false,
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
               SET revision = revision + 1, status = 'queued', state_json = ?,
                   budget_json = ?, pending_kind = NULL, pending_id = NULL, updated_at = ?
               WHERE id = ? AND revision = ? AND status = 'waiting'
                 AND pending_kind = ? AND pending_id = ?
               RETURNING *"#,
        )
        .bind(serde_json::to_string(state_json)?)
        .bind(serde_json::to_string(budget_json)?)
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
               SET revision = revision + 1, status = ?, state_json = ?, budget_json = ?,
                   result_json = ?, error = ?, claimed_by = NULL, claim_token = NULL,
                   lease_expires_at = NULL, updated_at = ?, finished_at = ?
               WHERE id = ? AND revision = ? AND status = 'running' AND claim_token = ?
               RETURNING *"#,
        )
        .bind(status.as_str())
        .bind(serde_json::to_string(state_json)?)
        .bind(serde_json::to_string(budget_json)?)
        .bind(result_json.map(serde_json::to_string).transpose()?)
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
               SET revision = revision + 1, status = 'cancelled', error = ?,
                   pending_kind = NULL, pending_id = NULL, claimed_by = NULL,
                   claim_token = NULL, lease_expires_at = NULL,
                   updated_at = ?, finished_at = ?
               WHERE id = ? AND revision = ?
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::{
        ActivationStore, EventStore, ExecutionJobStore, ExecutionRetrySafety, NewCognitiveContext,
        NewSession, NewThread, NewThreadActivation, QueryFilter, SessionDirectoryStore,
        SessionMountKind, SignalOutboxStatus, ThreadKind, ThreadStore,
    };
    use chrono::Duration;
    use tempfile::NamedTempFile;

    async fn seed_plan_route(store: &SqliteStore, suffix: &str) -> NewPlanExecution {
        let context_id = format!("plan-context-{suffix}");
        let session_id = format!("plan-session-{suffix}");
        let thread_id = format!("plan-thread-{suffix}");
        let activation_id = format!("plan-activation-{suffix}");
        let root_turn_id = format!("plan-root-{suffix}");
        store
            .create_context(NewCognitiveContext {
                id: context_id.clone(),
                agent_id: "plan-agent".to_string(),
                title: "Plan Context".to_string(),
            })
            .await
            .unwrap();
        store
            .create_session(NewSession {
                id: session_id.clone(),
                agent_id: "plan-agent".to_string(),
                context_id: context_id.clone(),
                parent_session_id: None,
                title: "Plan Session".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        store
            .ensure_thread(NewThread {
                id: thread_id.clone(),
                agent_id: "plan-agent".to_string(),
                context_id: context_id.clone(),
                session_id: session_id.clone(),
                initiating_principal_id: None,
                root_turn_id: root_turn_id.clone(),
                kind: ThreadKind::Execution,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: crate::memory::ThreadSupervision::legacy(),
            })
            .await
            .unwrap();
        store
            .ensure_thread_activation(NewThreadActivation {
                id: activation_id.clone(),
                agent_id: "plan-agent".to_string(),
                context_id: context_id.clone(),
                session_id: session_id.clone(),
                initiating_principal_id: None,
                trigger_event_id: format!("plan-trigger-{suffix}"),
                trigger_sequence: 1,
                trigger_kind: "runtime/plan".to_string(),
                parent_activation_id: None,
                root_turn_id,
            })
            .await
            .unwrap();
        NewPlanExecution {
            id: format!("plan-{suffix}"),
            activation_id,
            thread_id,
            agent_id: "plan-agent".to_string(),
            context_id,
            session_id,
            initiating_principal_id: None,
            tool_call_id: format!("call-{suffix}"),
            objective_id: Some(format!("objective-{suffix}")),
            objective_evaluation_id: None,
            harness_id: Some("builtin/coding".to_string()),
            harness_version: Some("1".to_string()),
            source_artifact_hash: format!("sha256:{suffix}"),
            ir_schema_version: 1,
            program_json: serde_json::json!({"op": "seq", "body": []}),
            state_json: serde_json::json!({"stack": [], "bindings": {}}),
            budget_json: serde_json::json!({"steps_remaining": 64}),
        }
    }

    fn updated(mutation: PlanExecutionMutation) -> PlanExecutionRecord {
        match mutation {
            PlanExecutionMutation::Updated(record) => record,
            other => panic!("expected updated PlanExecution, got {other:?}"),
        }
    }

    fn child_job(plan: &NewPlanExecution, suffix: &str) -> NewExecutionJob {
        NewExecutionJob {
            id: format!("plan-child-job-{suffix}"),
            activation_id: plan.activation_id.clone(),
            thread_id: plan.thread_id.clone(),
            agent_id: plan.agent_id.clone(),
            context_id: plan.context_id.clone(),
            session_id: plan.session_id.clone(),
            initiating_principal_id: plan.initiating_principal_id.clone(),
            target_id: crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
            tool_call_id: format!("plan-effect-{suffix}"),
            tool_name: "read".to_string(),
            request: serde_json::json!({"path": "README.md"}),
            retry_safety: ExecutionRetrySafety::Idempotent,
            requires_approval: false,
        }
    }

    #[tokio::test]
    async fn plan_execution_lifecycle_is_fenced_and_survives_restart() {
        let tmp_file = NamedTempFile::new().unwrap();
        let path = tmp_file.path().to_string_lossy().to_string();
        let store = SqliteStore::new(&path).await.unwrap();
        let new = seed_plan_route(&store, "lifecycle").await;

        let queued = store.create_plan_execution(new.clone()).await.unwrap();
        assert_eq!(queued.revision, 1);
        assert_eq!(queued.status, PlanExecutionStatus::Queued);
        assert_eq!(
            store.create_plan_execution(new.clone()).await.unwrap(),
            queued
        );

        let mut conflicting = new.clone();
        conflicting.program_json = serde_json::json!({"op": "reply"});
        assert!(store
            .create_plan_execution(conflicting)
            .await
            .unwrap_err()
            .to_string()
            .contains("causal key"));

        let running = updated(
            store
                .claim_plan_execution(
                    &queued.id,
                    queued.revision,
                    "worker-a",
                    "claim-a",
                    Utc::now() + Duration::minutes(1),
                )
                .await
                .unwrap(),
        );
        assert_eq!(running.status, PlanExecutionStatus::Running);

        assert!(matches!(
            store
                .heartbeat_plan_execution(
                    &running.id,
                    running.revision,
                    "stale-claim",
                    Utc::now() + Duration::minutes(1),
                    &running.state_json,
                    &running.budget_json,
                )
                .await
                .unwrap(),
            PlanExecutionMutation::Rejected { .. }
        ));

        let waiting = updated(
            store
                .suspend_plan_execution(
                    &running.id,
                    running.revision,
                    "claim-a",
                    &serde_json::json!({"stack": ["after-call"]}),
                    &serde_json::json!({"steps_remaining": 63}),
                    PlanExecutionWaitKind::ExecutionJob,
                    "job-a",
                )
                .await
                .unwrap(),
        );
        assert_eq!(waiting.status, PlanExecutionStatus::Waiting);
        assert_eq!(
            waiting.pending_kind,
            Some(PlanExecutionWaitKind::ExecutionJob)
        );

        assert!(matches!(
            store
                .resume_plan_execution(
                    &waiting.id,
                    waiting.revision,
                    PlanExecutionWaitKind::ExecutionJob,
                    "different-job",
                    &waiting.state_json,
                    &waiting.budget_json,
                )
                .await
                .unwrap(),
            PlanExecutionMutation::Rejected { .. }
        ));

        let queued_again = updated(
            store
                .resume_plan_execution(
                    &waiting.id,
                    waiting.revision,
                    PlanExecutionWaitKind::ExecutionJob,
                    "job-a",
                    &serde_json::json!({"stack": [], "value": {"ok": true}}),
                    &serde_json::json!({"steps_remaining": 62}),
                )
                .await
                .unwrap(),
        );
        let running_again = updated(
            store
                .claim_plan_execution(
                    &queued_again.id,
                    queued_again.revision,
                    "worker-b",
                    "claim-b",
                    Utc::now() + Duration::minutes(1),
                )
                .await
                .unwrap(),
        );
        let succeeded = updated(
            store
                .finish_plan_execution(
                    &running_again.id,
                    running_again.revision,
                    "claim-b",
                    PlanExecutionStatus::Succeeded,
                    &running_again.state_json,
                    &running_again.budget_json,
                    Some(&serde_json::json!({"answer": 42})),
                    None,
                )
                .await
                .unwrap(),
        );
        assert_eq!(succeeded.status, PlanExecutionStatus::Succeeded);
        assert_eq!(
            succeeded.result_json,
            Some(serde_json::json!({"answer": 42}))
        );
        assert!(matches!(
            store
                .cancel_plan_execution(&succeeded.id, succeeded.revision, Some("too late"))
                .await
                .unwrap(),
            PlanExecutionMutation::Rejected { .. }
        ));

        store.pool.close().await;
        let restarted = SqliteStore::new(&path).await.unwrap();
        assert_eq!(
            restarted
                .get_plan_execution(&succeeded.id)
                .await
                .unwrap()
                .unwrap()
                .status,
            PlanExecutionStatus::Succeeded
        );
    }

    #[tokio::test]
    async fn expired_plan_claim_can_be_taken_over_but_old_fence_cannot_write() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        let queued = store
            .create_plan_execution(seed_plan_route(&store, "takeover").await)
            .await
            .unwrap();
        let expired = updated(
            store
                .claim_plan_execution(
                    &queued.id,
                    queued.revision,
                    "worker-old",
                    "claim-old",
                    Utc::now() - Duration::seconds(1),
                )
                .await
                .unwrap(),
        );
        let current = updated(
            store
                .claim_plan_execution(
                    &expired.id,
                    expired.revision,
                    "worker-new",
                    "claim-new",
                    Utc::now() + Duration::minutes(1),
                )
                .await
                .unwrap(),
        );
        assert_eq!(current.claimed_by.as_deref(), Some("worker-new"));
        assert!(matches!(
            store
                .heartbeat_plan_execution(
                    &current.id,
                    current.revision,
                    "claim-old",
                    Utc::now() + Duration::minutes(1),
                    &current.state_json,
                    &current.budget_json,
                )
                .await
                .unwrap(),
            PlanExecutionMutation::Rejected { .. }
        ));
    }

    #[tokio::test]
    async fn infer_request_and_plan_wait_commit_atomically_and_replay_exactly() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        let new = seed_plan_route(&store, "infer-handoff").await;
        let queued = store.create_plan_execution(new.clone()).await.unwrap();
        let running = updated(
            store
                .claim_plan_execution(
                    &queued.id,
                    queued.revision,
                    "worker-infer",
                    "claim-infer",
                    Utc::now() + Duration::minutes(1),
                )
                .await
                .unwrap(),
        );
        let event = crate::event::Event::new(
            "infer-request-atomic".to_string(),
            "Runtime-Yao".to_string(),
            crate::event::TYPE_INFER_REQUEST.to_string(),
            "chat/infer_request".to_string(),
            serde_json::Map::from_iter([
                ("agent_id".to_string(), serde_json::json!(running.agent_id)),
                (
                    "context_id".to_string(),
                    serde_json::json!(running.context_id),
                ),
                (
                    "session_id".to_string(),
                    serde_json::json!(running.session_id),
                ),
                (
                    "parent_activation_id".to_string(),
                    serde_json::json!(running.activation_id),
                ),
                (
                    "plan_execution_id".to_string(),
                    serde_json::json!(running.id),
                ),
                ("root_turn_id".to_string(), serde_json::json!("infer-root")),
                ("text".to_string(), serde_json::json!("judge this")),
            ]),
        );
        let state = serde_json::json!({"stack": ["infer"]});
        let budget = serde_json::json!({"infers_left": 7});
        let committed = store
            .create_evaluation_and_suspend_plan(
                &running.id,
                running.revision,
                "claim-infer",
                &state,
                &budget,
                &event,
                "infer-activation",
            )
            .await
            .unwrap();
        assert!(!committed.existing);
        assert_eq!(committed.plan.status, PlanExecutionStatus::Waiting);
        assert_eq!(
            committed.plan.pending_kind,
            Some(PlanExecutionWaitKind::Evaluation)
        );
        assert_eq!(
            committed.plan.pending_id.as_deref(),
            Some("infer-activation")
        );
        assert_eq!(
            store
                .query(QueryFilter {
                    event_id: Some(event.id.clone()),
                    ..QueryFilter::default()
                })
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(store
            .list_signal_outbox(SignalOutboxStatus::Pending, 8)
            .await
            .unwrap()
            .iter()
            .all(|entry| entry.event_id != event.id));
        let signals = store
            .list_context_thread_signals(&running.context_id, None)
            .await
            .unwrap();
        assert_eq!(
            signals
                .iter()
                .filter(|signal| signal.event_id == event.id)
                .count(),
            1,
            "infer request 必须与 Plan waiting 状态原子提交为一个 Direct Thread Signal"
        );

        let replay = store
            .create_evaluation_and_suspend_plan(
                &running.id,
                running.revision,
                "claim-infer",
                &state,
                &budget,
                &event,
                "infer-activation",
            )
            .await
            .unwrap();
        assert!(replay.existing);
        assert_eq!(replay.plan, committed.plan);
    }

    #[tokio::test]
    async fn child_job_and_plan_wait_are_atomic_idempotent_and_route_fenced() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        let new = seed_plan_route(&store, "child-handoff").await;
        let queued = store.create_plan_execution(new.clone()).await.unwrap();
        let running = updated(
            store
                .claim_plan_execution(
                    &queued.id,
                    queued.revision,
                    "plan-worker",
                    "plan-fence",
                    Utc::now() + Duration::minutes(1),
                )
                .await
                .unwrap(),
        );
        let state = serde_json::json!({"pending": {"kind": "call", "sequence": 1}});
        let budget = serde_json::json!({"calls_left": 63});
        let job = child_job(&new, "child-handoff");

        let committed = store
            .create_execution_job_and_suspend_plan(
                &running.id,
                running.revision,
                "plan-fence",
                &state,
                &budget,
                job.clone(),
            )
            .await
            .unwrap();
        assert!(!committed.existing);
        assert_eq!(committed.plan.status, PlanExecutionStatus::Waiting);
        assert_eq!(
            committed.plan.pending_kind,
            Some(PlanExecutionWaitKind::ExecutionJob)
        );
        assert_eq!(
            committed.plan.pending_id.as_deref(),
            Some(committed.execution_job.id.as_str())
        );

        let replay = store
            .create_execution_job_and_suspend_plan(
                &running.id,
                running.revision,
                "plan-fence",
                &state,
                &budget,
                job.clone(),
            )
            .await
            .unwrap();
        assert!(replay.existing);
        assert_eq!(replay.plan, committed.plan);
        assert_eq!(replay.execution_job, committed.execution_job);

        let mut wrong_route = job;
        wrong_route.session_id = "foreign-session".to_string();
        assert!(store
            .create_execution_job_and_suspend_plan(
                &running.id,
                running.revision,
                "plan-fence",
                &state,
                &budget,
                wrong_route,
            )
            .await
            .is_err());
        assert_eq!(
            store
                .get_execution_job(&committed.execution_job.id)
                .await
                .unwrap()
                .unwrap(),
            committed.execution_job
        );
    }
}
