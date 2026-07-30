use super::{
    append_event_in_tx, append_signal_outbox_in_tx, insert_new_objective_in_tx, now_text,
    objective_from_row, parse_time, thread::thread_from_row, thread_group::group_from_row,
    validate_new_objective, PostgresStore, StoreError,
};
use crate::event::{Event, TYPE_TOOL_OUTPUT};
use crate::memory::{
    evaluate_thread_group_contract, NewSchedule, NewScheduledObjective, NewThread,
    NewThreadGroupPlan, ObjectiveStore, ObjectiveWaitCondition, ScheduleMutation, ScheduleRecord,
    ScheduleStatus, ScheduleStore, ThreadGroupStatus, ThreadPromotionMutation,
    ThreadPromotionRecord, ThreadPromotionRequest, ThreadStore, ThreadSupervisorKind,
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
        objectives: &[NewScheduledObjective],
        threads: &[NewThread],
        intents: &[NewSchedule],
        groups: &[NewThreadGroupPlan],
    ) -> Result<Vec<ScheduleRecord>, StoreError> {
        let now = now_text();
        let mut validated_objectives = Vec::with_capacity(objectives.len());
        for scheduled in objectives {
            validated_objectives.push(validate_new_objective(self, &scheduled.objective).await?);
        }
        let mut tx = self.pool.begin().await?;
        for (scheduled, (stated_objective, token_budget)) in
            objectives.iter().zip(validated_objectives.iter())
        {
            insert_new_objective_in_tx(
                &mut tx,
                &scheduled.objective,
                stated_objective,
                *token_budget,
            )
            .await?;
        }
        for thread in threads {
            thread.supervision.validate(thread.kind)?;
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
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        }
        for plan in groups {
            if plan.group.generation == 0 {
                return Err("Thread Group generation 必须大于 0".into());
            }
            if plan.members.is_empty() {
                return Err(format!("Thread Group '{}' 没有成员", plan.group.id).into());
            }
            if matches!(
                plan.group.supervisor_kind,
                ThreadSupervisorKind::None | ThreadSupervisorKind::Legacy
            ) {
                return Err(format!(
                    "Thread Group '{}' 必须绑定 Evaluation、Objective 或 Runtime supervisor",
                    plan.group.id
                )
                .into());
            }
            let required_count = plan.members.iter().filter(|member| member.required).count();
            if required_count == 0 {
                return Err(format!("Thread Group '{}' 没有 required 成员", plan.group.id).into());
            }
            sqlx::query(
                r#"INSERT INTO thread_groups
                   (id, revision, context_id, session_id, supervisor_kind, supervisor_id,
                    generation, policy, required_count, terminal_count, successful_count,
                    status, completion_contract_json, terminal_summary_json,
                    created_at, updated_at)
                   VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, 0, 0, 'open',
                           $9, '{}'::jsonb, $10, $10)
                   ON CONFLICT(id) DO NOTHING"#,
            )
            .bind(&plan.group.id)
            .bind(&plan.group.context_id)
            .bind(&plan.group.session_id)
            .bind(plan.group.supervisor_kind.as_str())
            .bind(&plan.group.supervisor_id)
            .bind(i64::try_from(plan.group.generation)?)
            .bind(plan.group.policy.as_str())
            .bind(i64::try_from(required_count)?)
            .bind(&plan.group.completion_contract)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            for member in &plan.members {
                let thread = sqlx::query(
                    "SELECT context_id, session_id, supervisor_kind, supervisor_id, supervision_generation, thread_group_id FROM threads WHERE id = $1",
                )
                .bind(&member.thread_id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(|| {
                    format!(
                        "Thread Group '{}' 成员 Thread '{}' 不存在",
                        plan.group.id, member.thread_id
                    )
                })?;
                let group_id: Option<String> = thread.get("thread_group_id");
                let member_context_id: String = thread.get("context_id");
                let member_session_id: String = thread.get("session_id");
                let member_supervisor_kind: String = thread.get("supervisor_kind");
                let member_supervisor_id: Option<String> = thread.get("supervisor_id");
                if group_id.as_deref() != Some(plan.group.id.as_str())
                    || member_context_id != plan.group.context_id
                    || member_session_id != plan.group.session_id
                    || member_supervisor_kind != plan.group.supervisor_kind.as_str()
                    || member_supervisor_id.as_deref() != Some(plan.group.supervisor_id.as_str())
                    || u64::try_from(thread.get::<i64, _>("supervision_generation"))?
                        != plan.group.generation
                {
                    return Err(format!(
                        "Thread Group '{}' 与成员 Thread '{}' 的监督路由不一致",
                        plan.group.id, member.thread_id
                    )
                    .into());
                }
                sqlx::query(
                    r#"INSERT INTO thread_group_members
                       (group_id, thread_id, ordinal, required, status, created_at, updated_at)
                       VALUES ($1, $2, $3, $4, 'pending', $5, $5)
                       ON CONFLICT DO NOTHING"#,
                )
                .bind(&plan.group.id)
                .bind(&member.thread_id)
                .bind(i64::try_from(member.ordinal)?)
                .bind(member.required)
                .bind(&now)
                .execute(&mut *tx)
                .await?;
            }
        }
        for scheduled in objectives {
            match &scheduled.initial_wait_condition {
                ObjectiveWaitCondition::ThreadGroup { group_id } => {
                    let row = sqlx::query(
                        "SELECT supervisor_kind, supervisor_id FROM thread_groups WHERE id = $1",
                    )
                    .bind(group_id)
                    .fetch_optional(&mut *tx)
                    .await?
                    .ok_or_else(|| {
                        format!(
                            "Objective '{}' 的初始等待 Thread Group '{}' 不存在",
                            scheduled.objective.id, group_id
                        )
                    })?;
                    if row.get::<String, _>("supervisor_kind") != "objective"
                        || row.get::<String, _>("supervisor_id") != scheduled.objective.id
                    {
                        return Err(format!(
                            "Objective '{}' 的初始等待 Thread Group '{}' 未由该 Objective 监督",
                            scheduled.objective.id, group_id
                        )
                        .into());
                    }
                }
                other => {
                    return Err(format!(
                        "schedule_tx 创建 Objective 只能以 Thread 或 Thread Group 作为初始等待，收到 {other:?}"
                    )
                    .into());
                }
            }
            sqlx::query(
                r#"UPDATE objectives
                   SET wait_condition_json = $1, status_reason = $2, updated_at = $3
                   WHERE id = $4 AND revision = 1 AND status = 'active'"#,
            )
            .bind(serde_json::to_value(&scheduled.initial_wait_condition)?)
            .bind(scheduled.status_reason.trim())
            .bind(&now)
            .bind(&scheduled.objective.id)
            .execute(&mut *tx)
            .await?;
            append_event_in_tx(&mut tx, &scheduled.created_event).await?;
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

    async fn promote_attached_thread(
        &self,
        request: ThreadPromotionRequest,
    ) -> Result<ThreadPromotionMutation, StoreError> {
        if request.target_group.members.len() != 1
            || request.target_group.members[0].thread_id != request.thread_id
            || !request.target_group.members[0].required
        {
            return Err("Thread 升格必须创建恰好包含目标 Thread 的 required 单成员 Group".into());
        }
        if request.target_group.group.supervisor_kind != ThreadSupervisorKind::Objective
            || request.target_group.group.supervisor_id != request.objective_id
        {
            return Err("Thread 升格目标 Group 必须由目标 Objective 监督".into());
        }
        if request.new_objective.is_some() != request.expected_objective_revision.is_none() {
            return Err(
                "Thread 升格必须在 new_objective 与 expected_objective_revision 中恰好选择一个"
                    .into(),
            );
        }
        let validated_new_objective = if let Some(scheduled) = request.new_objective.as_ref() {
            if scheduled.objective.id != request.objective_id {
                return Err("Thread 升格的新 Objective ID 与目标监督者不一致".into());
            }
            if scheduled.initial_wait_condition
                != (ObjectiveWaitCondition::ThreadGroup {
                    group_id: request.target_group.group.id.clone(),
                })
            {
                return Err("Thread 升格创建的 Objective 必须等待目标 Thread Group".into());
            }
            Some(validate_new_objective(self, &scheduled.objective).await?)
        } else {
            None
        };
        let expected_thread_revision = i64::try_from(request.expected_thread_revision)?;
        let target_generation = i64::try_from(request.target_group.group.generation)?;
        let now = now_text();
        let mut tx = self.pool.begin().await?;
        let promoted = sqlx::query(
            r#"UPDATE threads
               SET revision = revision + 1,
                   lifetime = 'durable',
                   supervisor_kind = 'objective',
                   supervisor_id = $1,
                   supervision_generation = $2,
                   thread_group_id = $3,
                   updated_at = $4
               WHERE id = $5 AND revision = $6 AND status = 'open'
                 AND lifetime = 'attached' AND supervisor_kind = 'evaluation'
                 AND thread_group_id = $7"#,
        )
        .bind(&request.objective_id)
        .bind(target_generation)
        .bind(&request.target_group.group.id)
        .bind(&now)
        .bind(&request.thread_id)
        .bind(expected_thread_revision)
        .bind(&request.source_group_id)
        .execute(&mut *tx)
        .await?;
        if promoted.rows_affected() != 1 {
            tx.rollback().await?;
            let Some(current_thread) = self.get_thread(&request.thread_id).await? else {
                return Ok(ThreadPromotionMutation::NotFound);
            };
            let current_objective = self.get_objective(&request.objective_id).await?;
            if current_thread.revision != request.expected_thread_revision {
                return Ok(ThreadPromotionMutation::Conflict {
                    current_thread,
                    current_objective,
                });
            }
            return Ok(ThreadPromotionMutation::Rejected {
                current_thread,
                reason: "Thread 不是指定 Evaluation Group 中仍然 open 的 attached Thread"
                    .to_string(),
            });
        }

        let source_group_row = sqlx::query("SELECT * FROM thread_groups WHERE id = $1 FOR UPDATE")
            .bind(&request.source_group_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| format!("源 Thread Group '{}' 不存在", request.source_group_id))?;
        let source_group_before = group_from_row(&source_group_row)?;
        if source_group_before.status != ThreadGroupStatus::Open
            || source_group_before.supervisor_kind != ThreadSupervisorKind::Evaluation
        {
            return Err(format!(
                "源 Thread Group '{}' 不是 open Evaluation Group",
                request.source_group_id
            )
            .into());
        }

        let objective_row = if let (Some(scheduled), Some((stated_objective, token_budget))) = (
            request.new_objective.as_ref(),
            validated_new_objective.as_ref(),
        ) {
            insert_new_objective_in_tx(
                &mut tx,
                &scheduled.objective,
                stated_objective,
                *token_budget,
            )
            .await?;
            sqlx::query(
                r#"UPDATE objectives
                   SET wait_condition_json = $1, status_reason = $2, updated_at = $3
                   WHERE id = $4 AND revision = 1 AND status = 'active'"#,
            )
            .bind(serde_json::to_value(&scheduled.initial_wait_condition)?)
            .bind(scheduled.status_reason.trim())
            .bind(&now)
            .bind(&scheduled.objective.id)
            .execute(&mut *tx)
            .await?;
            append_event_in_tx(&mut tx, &scheduled.created_event).await?;
            sqlx::query("SELECT * FROM objectives WHERE id = $1")
                .bind(&request.objective_id)
                .fetch_one(&mut *tx)
                .await?
        } else {
            sqlx::query(
                "SELECT * FROM objectives WHERE id = $1 AND revision = $2 AND status = 'active' FOR UPDATE",
            )
            .bind(&request.objective_id)
            .bind(i64::try_from(
                request
                    .expected_objective_revision
                    .expect("validated existing Objective revision"),
            )?)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| {
                format!(
                    "Objective '{}' 不存在、不是 active 或 revision 已变化",
                    request.objective_id
                )
            })?
        };
        let objective = objective_from_row(&objective_row)?;
        let promoted_thread_row = sqlx::query("SELECT * FROM threads WHERE id = $1")
            .bind(&request.thread_id)
            .fetch_one(&mut *tx)
            .await?;
        let promoted_thread = thread_from_row(&promoted_thread_row)?;
        if objective.agent_id != promoted_thread.agent_id
            || objective.context_id != promoted_thread.context_id
            || objective.coordinator_session_id != promoted_thread.session_id
        {
            return Err("Objective 与升格 Thread 的 Agent/Context/Session 所有权不一致".into());
        }
        if request.target_group.group.context_id != promoted_thread.context_id
            || request.target_group.group.session_id != promoted_thread.session_id
        {
            return Err("升格目标 Group 与 Thread 的 Context/Session 不一致".into());
        }

        sqlx::query(
            r#"INSERT INTO thread_groups
               (id, revision, context_id, session_id, supervisor_kind, supervisor_id,
                generation, policy, required_count, terminal_count, successful_count,
                status, completion_contract_json, terminal_summary_json,
                created_at, updated_at)
               VALUES ($1, 1, $2, $3, 'objective', $4, $5, $6, 1, 0, 0, 'open',
                       $7, '{}'::jsonb, $8, $8)"#,
        )
        .bind(&request.target_group.group.id)
        .bind(&request.target_group.group.context_id)
        .bind(&request.target_group.group.session_id)
        .bind(&request.objective_id)
        .bind(target_generation)
        .bind(request.target_group.group.policy.as_str())
        .bind(&request.target_group.group.completion_contract)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        let released = sqlx::query(
            r#"UPDATE thread_group_members
               SET required = FALSE, status = 'cancelled', updated_at = $1
               WHERE group_id = $2 AND thread_id = $3
                 AND required = TRUE AND status = 'pending'"#,
        )
        .bind(&now)
        .bind(&request.source_group_id)
        .bind(&request.thread_id)
        .execute(&mut *tx)
        .await?;
        if released.rows_affected() != 1 {
            return Err("源 Thread Group 成员已经终止或已被其他升格事务释放".into());
        }
        sqlx::query(
            r#"INSERT INTO thread_group_members
               (group_id, thread_id, ordinal, required, status, created_at, updated_at)
               VALUES ($1, $2, 0, TRUE, 'pending', $3, $3)"#,
        )
        .bind(&request.target_group.group.id)
        .bind(&request.thread_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        let counts = sqlx::query(
            r#"SELECT
                 COUNT(*) FILTER (WHERE required) AS required_count,
                 COUNT(*) FILTER (WHERE required AND status <> 'pending') AS terminal_count,
                 COUNT(*) FILTER (WHERE required AND status = 'completed') AS successful_count
               FROM thread_group_members WHERE group_id = $1"#,
        )
        .bind(&request.source_group_id)
        .fetch_one(&mut *tx)
        .await?;
        let required_count = u64::try_from(counts.get::<i64, _>("required_count"))?;
        let terminal_count = u64::try_from(counts.get::<i64, _>("terminal_count"))?;
        let successful_count = u64::try_from(counts.get::<i64, _>("successful_count"))?;
        let source_evaluation = evaluate_thread_group_contract(
            source_group_before.policy,
            required_count,
            terminal_count,
            successful_count,
            &source_group_before.completion_contract,
        );
        let source_status = source_evaluation.status;
        let source_summary = serde_json::json!({
            "group_id": request.source_group_id,
            "status": source_status.as_str(),
            "policy": source_group_before.policy.as_str(),
            "required_count": required_count,
            "terminal_count": terminal_count,
            "successful_count": successful_count,
            "completion_contract": source_group_before.completion_contract,
            "contract_results": source_evaluation.contract_results,
            "released_thread_id": request.thread_id,
            "promoted_to_objective_id": request.objective_id,
            "promoted_to_group_id": request.target_group.group.id,
        });
        let source_barrier_id = format!(
            "thread_group_barrier_{}_g{}",
            request.source_group_id, source_group_before.generation
        );
        sqlx::query(
            r#"UPDATE thread_groups
               SET revision = revision + 1, required_count = $1, terminal_count = $2,
                   successful_count = $3, status = $4, terminal_summary_json = $5,
                   barrier_event_id = $6, updated_at = $7, satisfied_at = $8
               WHERE id = $9 AND status = 'open'"#,
        )
        .bind(i64::try_from(required_count)?)
        .bind(i64::try_from(terminal_count)?)
        .bind(i64::try_from(successful_count)?)
        .bind(source_status.as_str())
        .bind(&source_summary)
        .bind(if source_status.is_terminal() {
            Some(source_barrier_id.as_str())
        } else {
            None
        })
        .bind(&now)
        .bind(if source_status.is_terminal() {
            Some(now.as_str())
        } else {
            None
        })
        .bind(&request.source_group_id)
        .execute(&mut *tx)
        .await?;
        if source_status.is_terminal() {
            let parent_thread_id = promoted_thread
                .supervision
                .parent_thread_id
                .as_deref()
                .ok_or("升格 Thread 缺少原 Evaluation parent_thread_id")?;
            let parent = sqlx::query("SELECT session_id, root_turn_id FROM threads WHERE id = $1")
                .bind(parent_thread_id)
                .fetch_one(&mut *tx)
                .await?;
            let barrier = Event::new(
                source_barrier_id,
                "Runtime".to_string(),
                TYPE_TOOL_OUTPUT.to_string(),
                "chat/thread_group_terminal".to_string(),
                serde_json::json!({
                    "context_id": promoted_thread.context_id,
                    "session_id": parent.get::<String, _>("session_id"),
                    "thread_id": parent_thread_id,
                    "root_turn_id": parent.get::<String, _>("root_turn_id"),
                    "thread_group_id": request.source_group_id,
                    "thread_group_status": source_status.as_str(),
                    "wake_policy": "immediate",
                    "tool_name": "thread_group",
                    "tool_status": "success",
                    "text": format!(
                        "Thread '{}' 已升格为 Objective '{}' 的 durable Thread；原 Evaluation Group 已释放该成员",
                        request.thread_id, request.objective_id
                    ),
                    "terminal_summary": source_summary,
                })
                .as_object()
                .expect("promotion barrier payload")
                .clone(),
            );
            append_event_in_tx(&mut tx, &barrier).await?;
            append_signal_outbox_in_tx(&mut tx, &barrier).await?;
        }
        append_event_in_tx(&mut tx, &request.promoted_event).await?;
        let source_group_row = sqlx::query("SELECT * FROM thread_groups WHERE id = $1")
            .bind(&request.source_group_id)
            .fetch_one(&mut *tx)
            .await?;
        let target_group_row = sqlx::query("SELECT * FROM thread_groups WHERE id = $1")
            .bind(&request.target_group.group.id)
            .fetch_one(&mut *tx)
            .await?;
        let record = ThreadPromotionRecord {
            thread: promoted_thread,
            objective,
            source_group: group_from_row(&source_group_row)?,
            target_group: group_from_row(&target_group_row)?,
        };
        tx.commit().await?;
        Ok(ThreadPromotionMutation::Updated(record))
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
