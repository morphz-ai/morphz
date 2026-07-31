//! PostgreSQL Action Group coordination authority.
//!
//! A Group exists only for two or more sibling Actions emitted by one model
//! response. Each member result remains an immutable Event. The final member
//! transaction alone appends the deterministic settled Event and Signal
//! Outbox record, so one model response produces exactly one continuation.

use super::{
    append_direct_thread_signal_in_tx, append_event_in_tx, now_text, parse_time, PostgresStore,
    StoreError,
};
use crate::event::Event;
use crate::memory::{
    ActionGroupFilter, ActionGroupMemberCommit, ActionGroupMemberRecord, ActionGroupMemberStatus,
    ActionGroupRecord, ActionGroupStatus, ActionGroupStore, NewActionGroup, NewActionGroupMember,
};
use chrono::{DateTime, Utc};
use serde_json::Value as JsonValue;
use sqlx::postgres::PgRow;
use sqlx::{PgPool, Postgres, QueryBuilder, Row};
use std::collections::HashSet;

pub(super) async fn migrate(pool: &PgPool) -> Result<(), StoreError> {
    for statement in [
        r#"CREATE TABLE IF NOT EXISTS action_groups (
            id TEXT PRIMARY KEY,
            revision BIGINT NOT NULL DEFAULT 1,
            activation_id TEXT NOT NULL REFERENCES thread_activations(id) ON DELETE CASCADE,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
            agent_id TEXT NOT NULL REFERENCES agents(id),
            context_id TEXT NOT NULL REFERENCES cognitive_contexts(id),
            session_id TEXT NOT NULL REFERENCES sessions(id),
            assistant_call_event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
            objective_id TEXT,
            objective_evaluation_id TEXT,
            objective_revision BIGINT,
            status TEXT NOT NULL,
            member_count BIGINT NOT NULL,
            terminal_member_count BIGINT NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            settled_at TEXT,
            CHECK(member_count >= 2),
            CHECK(terminal_member_count >= 0 AND terminal_member_count <= member_count)
        )"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_action_groups_context_status
           ON action_groups(context_id, status, updated_at DESC)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_action_groups_session_status
           ON action_groups(session_id, status, updated_at DESC)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_action_groups_activation
           ON action_groups(activation_id, created_at, id)"#,
        r#"CREATE TABLE IF NOT EXISTS action_group_members (
            group_id TEXT NOT NULL REFERENCES action_groups(id) ON DELETE CASCADE,
            ordinal BIGINT NOT NULL,
            tool_call_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            execution_job_id TEXT REFERENCES execution_jobs(id),
            status TEXT NOT NULL,
            result_event_id TEXT REFERENCES events(id),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(group_id, tool_call_id),
            UNIQUE(group_id, ordinal),
            CHECK(ordinal >= 0)
        )"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_action_group_members_job
           ON action_group_members(execution_job_id) WHERE execution_job_id IS NOT NULL"#,
    ] {
        sqlx::query(statement).execute(pool).await?;
    }
    Ok(())
}

fn parse_group_status(value: &str) -> Result<ActionGroupStatus, StoreError> {
    match value {
        "running" => Ok(ActionGroupStatus::Running),
        "settled" => Ok(ActionGroupStatus::Settled),
        "cancelled" => Ok(ActionGroupStatus::Cancelled),
        "lost" => Ok(ActionGroupStatus::Lost),
        other => Err(format!("未知 Action Group status：'{other}'").into()),
    }
}

fn parse_member_status(value: &str) -> Result<ActionGroupMemberStatus, StoreError> {
    match value {
        "pending" => Ok(ActionGroupMemberStatus::Pending),
        "succeeded" => Ok(ActionGroupMemberStatus::Succeeded),
        "failed" => Ok(ActionGroupMemberStatus::Failed),
        "cancelled" => Ok(ActionGroupMemberStatus::Cancelled),
        "lost" => Ok(ActionGroupMemberStatus::Lost),
        "skipped" => Ok(ActionGroupMemberStatus::Skipped),
        other => Err(format!("未知 Action Group member status：'{other}'").into()),
    }
}

fn optional_time(row: &PgRow, column: &str) -> Result<Option<DateTime<Utc>>, StoreError> {
    row.get::<Option<String>, _>(column)
        .as_deref()
        .map(parse_time)
        .transpose()
}

fn group_from_row(row: &PgRow) -> Result<ActionGroupRecord, StoreError> {
    Ok(ActionGroupRecord {
        id: row.get("id"),
        revision: u64::try_from(row.get::<i64, _>("revision"))?,
        activation_id: row.get("activation_id"),
        thread_id: row.get("thread_id"),
        agent_id: row.get("agent_id"),
        context_id: row.get("context_id"),
        session_id: row.get("session_id"),
        assistant_call_event_id: row.get("assistant_call_event_id"),
        objective_id: row.get("objective_id"),
        objective_evaluation_id: row.get("objective_evaluation_id"),
        objective_revision: row
            .get::<Option<i64>, _>("objective_revision")
            .map(u64::try_from)
            .transpose()?,
        status: parse_group_status(&row.get::<String, _>("status"))?,
        member_count: u64::try_from(row.get::<i64, _>("member_count"))?,
        terminal_member_count: u64::try_from(row.get::<i64, _>("terminal_member_count"))?,
        created_at: parse_time(&row.get::<String, _>("created_at"))?,
        updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
        settled_at: optional_time(row, "settled_at")?,
    })
}

fn member_from_row(row: &PgRow) -> Result<ActionGroupMemberRecord, StoreError> {
    Ok(ActionGroupMemberRecord {
        group_id: row.get("group_id"),
        ordinal: u64::try_from(row.get::<i64, _>("ordinal"))?,
        tool_call_id: row.get("tool_call_id"),
        tool_name: row.get("tool_name"),
        execution_job_id: row.get("execution_job_id"),
        status: parse_member_status(&row.get::<String, _>("status"))?,
        result_event_id: row.get("result_event_id"),
        created_at: parse_time(&row.get::<String, _>("created_at"))?,
        updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
    })
}

fn validate_group(
    group: &NewActionGroup,
    members: &[NewActionGroupMember],
) -> Result<(), StoreError> {
    if members.len() < 2 {
        return Err("Action Group 至少需要两个成员；单 Action 应直接使用 ExecutionJob".into());
    }
    for (field, value) in [
        ("id", group.id.as_str()),
        ("activation_id", group.activation_id.as_str()),
        ("thread_id", group.thread_id.as_str()),
        ("agent_id", group.agent_id.as_str()),
        ("context_id", group.context_id.as_str()),
        ("session_id", group.session_id.as_str()),
        (
            "assistant_call_event_id",
            group.assistant_call_event_id.as_str(),
        ),
    ] {
        if value.trim().is_empty() {
            return Err(format!("Action Group {field} 不能为空").into());
        }
    }
    let mut calls = HashSet::new();
    let mut ordinals = HashSet::new();
    for member in members {
        if member.tool_call_id.trim().is_empty() || member.tool_name.trim().is_empty() {
            return Err("Action Group member tool_call_id/tool_name 不能为空".into());
        }
        if !calls.insert(member.tool_call_id.as_str()) || !ordinals.insert(member.ordinal) {
            return Err("Action Group member 的 tool_call_id/ordinal 必须唯一".into());
        }
    }
    Ok(())
}

#[async_trait::async_trait]
impl ActionGroupStore for PostgresStore {
    async fn create_action_group(
        &self,
        group: NewActionGroup,
        members: Vec<NewActionGroupMember>,
    ) -> Result<ActionGroupRecord, StoreError> {
        validate_group(&group, &members)?;
        let member_count = i64::try_from(members.len())?;
        let objective_revision = group.objective_revision.map(i64::try_from).transpose()?;
        let now = now_text();
        let mut tx = self.pool.begin().await?;
        let inserted = sqlx::query(
            r#"INSERT INTO action_groups
               (id, revision, activation_id, thread_id, agent_id, context_id, session_id,
                assistant_call_event_id, objective_id, objective_evaluation_id,
                objective_revision, status, member_count, terminal_member_count,
                created_at, updated_at, settled_at)
               VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                       'running', $11, 0, $12, $12, NULL)
               ON CONFLICT(id) DO NOTHING"#,
        )
        .bind(&group.id)
        .bind(&group.activation_id)
        .bind(&group.thread_id)
        .bind(&group.agent_id)
        .bind(&group.context_id)
        .bind(&group.session_id)
        .bind(&group.assistant_call_event_id)
        .bind(&group.objective_id)
        .bind(&group.objective_evaluation_id)
        .bind(objective_revision)
        .bind(member_count)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        if inserted.rows_affected() == 1 {
            for member in &members {
                sqlx::query(
                    r#"INSERT INTO action_group_members
                       (group_id, ordinal, tool_call_id, tool_name, execution_job_id,
                        status, result_event_id, created_at, updated_at)
                       VALUES ($1, $2, $3, $4, $5, 'pending', NULL, $6, $6)"#,
                )
                .bind(&group.id)
                .bind(i64::try_from(member.ordinal)?)
                .bind(&member.tool_call_id)
                .bind(&member.tool_name)
                .bind(&member.execution_job_id)
                .bind(&now)
                .execute(&mut *tx)
                .await?;
            }
        }
        let row = sqlx::query("SELECT * FROM action_groups WHERE id = $1 FOR UPDATE")
            .bind(&group.id)
            .fetch_one(&mut *tx)
            .await?;
        let current = group_from_row(&row)?;
        let current_members = sqlx::query(
            "SELECT * FROM action_group_members WHERE group_id = $1 ORDER BY ordinal, tool_call_id",
        )
        .bind(&group.id)
        .fetch_all(&mut *tx)
        .await?
        .iter()
        .map(member_from_row)
        .collect::<Result<Vec<_>, _>>()?;
        let exact_group = current.activation_id == group.activation_id
            && current.thread_id == group.thread_id
            && current.agent_id == group.agent_id
            && current.context_id == group.context_id
            && current.session_id == group.session_id
            && current.assistant_call_event_id == group.assistant_call_event_id
            && current.objective_id == group.objective_id
            && current.objective_evaluation_id == group.objective_evaluation_id
            && current.objective_revision == group.objective_revision;
        let exact_members = current_members.len() == members.len()
            && current_members
                .iter()
                .zip(members.iter())
                .all(|(current, requested)| {
                    current.ordinal == requested.ordinal
                        && current.tool_call_id == requested.tool_call_id
                        && current.tool_name == requested.tool_name
                        && current.execution_job_id == requested.execution_job_id
                });
        if !exact_group || !exact_members {
            tx.rollback().await?;
            return Err(format!("Action Group '{}' 的确定性身份被不同内容复用", group.id).into());
        }
        tx.commit().await?;
        Ok(current)
    }

    async fn get_action_group(&self, id: &str) -> Result<Option<ActionGroupRecord>, StoreError> {
        sqlx::query("SELECT * FROM action_groups WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(group_from_row)
            .transpose()
    }

    async fn list_action_groups(
        &self,
        filter: ActionGroupFilter,
    ) -> Result<Vec<ActionGroupRecord>, StoreError> {
        let mut query: QueryBuilder<'_, Postgres> =
            QueryBuilder::new("SELECT * FROM action_groups WHERE TRUE");
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
            query.push(" AND status = ").push_bind(status.as_str());
        } else if !filter.include_terminal {
            query.push(" AND status = 'running'");
        }
        query.push(if filter.newest_first {
            " ORDER BY created_at DESC, id DESC"
        } else {
            " ORDER BY created_at, id"
        });
        if let Some(limit) = filter.limit {
            query.push(" LIMIT ").push_bind(i64::try_from(limit)?);
        }
        query
            .build()
            .fetch_all(&self.pool)
            .await?
            .iter()
            .map(group_from_row)
            .collect()
    }

    async fn list_action_group_members(
        &self,
        group_id: &str,
    ) -> Result<Vec<ActionGroupMemberRecord>, StoreError> {
        sqlx::query(
            "SELECT * FROM action_group_members WHERE group_id = $1 ORDER BY ordinal, tool_call_id",
        )
        .bind(group_id)
        .fetch_all(&self.pool)
        .await?
        .iter()
        .map(member_from_row)
        .collect()
    }

    async fn commit_action_group_member_result(
        &self,
        group_id: &str,
        tool_call_id: &str,
        status: ActionGroupMemberStatus,
        result_event: &Event,
        settled_event: &Event,
    ) -> Result<ActionGroupMemberCommit, StoreError> {
        if !status.is_terminal() {
            return Err("Action Group member 只能提交终态结果".into());
        }
        if result_event
            .payload
            .get("action_group_id")
            .and_then(JsonValue::as_str)
            != Some(group_id)
            || result_event
                .payload
                .get("tool_call_id")
                .and_then(JsonValue::as_str)
                != Some(tool_call_id)
        {
            return Err("Action Group member 结果 Event 的 group/tool_call 路由不匹配".into());
        }
        if settled_event
            .payload
            .get("action_group_id")
            .and_then(JsonValue::as_str)
            != Some(group_id)
            || settled_event.topic != "runtime/action_group_settled"
        {
            return Err("Action Group settled Event 的路由或 topic 不匹配".into());
        }
        let mut tx = self.pool.begin().await?;
        let group_row = sqlx::query("SELECT * FROM action_groups WHERE id = $1 FOR UPDATE")
            .bind(group_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| format!("Action Group '{group_id}' 不存在"))?;
        let mut group = group_from_row(&group_row)?;
        let member_row = sqlx::query(
            "SELECT * FROM action_group_members WHERE group_id = $1 AND tool_call_id = $2 FOR UPDATE",
        )
        .bind(group_id)
        .bind(tool_call_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| format!("Action Group '{group_id}' 不包含调用 '{tool_call_id}'"))?;
        let mut member = member_from_row(&member_row)?;
        append_event_in_tx(&mut tx, result_event).await?;
        if member.status.is_terminal() {
            if member.status != status
                || member.result_event_id.as_deref() != Some(&result_event.id)
            {
                tx.rollback().await?;
                return Err(format!(
                    "Action Group '{group_id}' member '{tool_call_id}' 已由不同结果终结"
                )
                .into());
            }
            tx.commit().await?;
            return Ok(ActionGroupMemberCommit {
                group,
                member,
                settled_now: false,
                existing: true,
            });
        }
        if group.status != ActionGroupStatus::Running {
            tx.rollback().await?;
            return Err(format!(
                "Action Group '{group_id}' 已是 {}，不能再接收成员结果",
                group.status.as_str()
            )
            .into());
        }
        let now = now_text();
        let updated = sqlx::query(
            r#"UPDATE action_group_members
               SET status = $1, result_event_id = $2, updated_at = $3
               WHERE group_id = $4 AND tool_call_id = $5 AND status = 'pending'"#,
        )
        .bind(status.as_str())
        .bind(&result_event.id)
        .bind(&now)
        .bind(group_id)
        .bind(tool_call_id)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            return Err("Action Group member 的并发终态提交未命中".into());
        }
        let terminal_member_count = group.terminal_member_count.saturating_add(1);
        let settled_now = terminal_member_count == group.member_count;
        if settled_now {
            append_event_in_tx(&mut tx, settled_event).await?;
            if settled_event
                .payload
                .get("wake_policy")
                .and_then(JsonValue::as_str)
                == Some("direct_signal")
            {
                append_direct_thread_signal_in_tx(&mut tx, settled_event, &group.thread_id).await?;
            }
            sqlx::query(
                r#"UPDATE action_groups
                   SET revision = revision + 1, status = 'settled',
                       terminal_member_count = $1, updated_at = $2, settled_at = $2
                   WHERE id = $3 AND status = 'running'"#,
            )
            .bind(i64::try_from(terminal_member_count)?)
            .bind(&now)
            .bind(group_id)
            .execute(&mut *tx)
            .await?;
        } else {
            sqlx::query(
                r#"UPDATE action_groups
                   SET revision = revision + 1, terminal_member_count = $1, updated_at = $2
                   WHERE id = $3 AND status = 'running'"#,
            )
            .bind(i64::try_from(terminal_member_count)?)
            .bind(&now)
            .bind(group_id)
            .execute(&mut *tx)
            .await?;
        }
        group = group_from_row(
            &sqlx::query("SELECT * FROM action_groups WHERE id = $1")
                .bind(group_id)
                .fetch_one(&mut *tx)
                .await?,
        )?;
        member = member_from_row(
            &sqlx::query(
                "SELECT * FROM action_group_members WHERE group_id = $1 AND tool_call_id = $2",
            )
            .bind(group_id)
            .bind(tool_call_id)
            .fetch_one(&mut *tx)
            .await?,
        )?;
        tx.commit().await?;
        Ok(ActionGroupMemberCommit {
            group,
            member,
            settled_now,
            existing: false,
        })
    }
}
