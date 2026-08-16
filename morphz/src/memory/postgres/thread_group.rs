use super::{parse_time, PostgresStore, StoreError};
use crate::memory::{
    ThreadGroupFilter, ThreadGroupMemberRecord, ThreadGroupMemberStatus, ThreadGroupPolicy,
    ThreadGroupRecord, ThreadGroupStatus, ThreadGroupStore, ThreadLifecycle, ThreadOutcomeRecord,
    ThreadSupervisorKind,
};
use serde_json::Value as JsonValue;
use sqlx::{PgPool, Postgres, QueryBuilder, Row};

pub(super) async fn migrate(pool: &PgPool) -> Result<(), StoreError> {
    for statement in [
        r#"CREATE TABLE IF NOT EXISTS thread_groups (
            id TEXT PRIMARY KEY,
            revision BIGINT NOT NULL DEFAULT 1 CHECK(revision >= 1),
            context_id TEXT NOT NULL REFERENCES cognitive_contexts(id) ON DELETE CASCADE,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            supervisor_kind TEXT NOT NULL,
            supervisor_id TEXT NOT NULL,
            generation BIGINT NOT NULL CHECK(generation >= 1),
            policy TEXT NOT NULL CHECK(policy IN ('all', 'any')),
            required_count BIGINT NOT NULL CHECK(required_count > 0),
            terminal_count BIGINT NOT NULL DEFAULT 0,
            successful_count BIGINT NOT NULL DEFAULT 0,
            status TEXT NOT NULL CHECK(status IN ('open', 'satisfied', 'failed', 'cancelled')),
            completion_contract_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            terminal_summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            barrier_event_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            satisfied_at TEXT
        )"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_thread_groups_supervisor
           ON thread_groups(supervisor_kind, supervisor_id, status, created_at)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_thread_groups_context_status
           ON thread_groups(context_id, status, created_at)"#,
        r#"CREATE TABLE IF NOT EXISTS thread_group_members (
            group_id TEXT NOT NULL REFERENCES thread_groups(id) ON DELETE CASCADE,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
            ordinal BIGINT NOT NULL,
            required BOOLEAN NOT NULL DEFAULT TRUE,
            status TEXT NOT NULL DEFAULT 'pending'
              CHECK(status IN ('pending', 'completed', 'failed', 'cancelled')),
            outcome_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(group_id, ordinal),
            UNIQUE(group_id, thread_id)
        )"#,
        r#"ALTER TABLE thread_group_members
           DROP CONSTRAINT IF EXISTS thread_group_members_thread_id_key"#,
        r#"CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_thread_group_members_group_thread
           ON thread_group_members(group_id, thread_id)"#,
        r#"CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_thread_group_members_pending_thread
           ON thread_group_members(thread_id) WHERE status = 'pending'"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_thread_group_members_group_status
           ON thread_group_members(group_id, status, ordinal)"#,
    ] {
        sqlx::query(statement).execute(pool).await?;
    }
    Ok(())
}

pub(super) async fn migrate_attached_supervision_to_parent_threads(
    pool: &PgPool,
) -> Result<(), StoreError> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        r#"UPDATE threads AS child
           SET supervisor_kind = 'thread',
               supervisor_id = child.parent_thread_id,
               supervision_generation = parent.generation
           FROM threads AS parent
           WHERE child.parent_thread_id = parent.id
             AND child.lifetime = 'attached'
             AND child.status = 'open'
             AND child.supervisor_kind = 'evaluation'"#,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"WITH owners AS (
               SELECT DISTINCT ON (member.group_id)
                      member.group_id, child.supervisor_id, child.supervision_generation
               FROM thread_group_members AS member
               JOIN threads AS child ON child.id = member.thread_id
               WHERE child.supervisor_kind = 'thread'
               ORDER BY member.group_id, member.ordinal
           )
           UPDATE thread_groups AS grouped
           SET supervisor_kind = 'thread',
               supervisor_id = owner.supervisor_id,
               generation = owner.supervision_generation
           FROM owners AS owner
           WHERE grouped.status = 'open'
             AND grouped.supervisor_kind = 'evaluation'
             AND owner.group_id = grouped.id"#,
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

fn parse_supervisor(value: &str) -> Result<ThreadSupervisorKind, StoreError> {
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

fn parse_policy(value: &str) -> Result<ThreadGroupPolicy, StoreError> {
    match value {
        "all" => Ok(ThreadGroupPolicy::All),
        "any" => Ok(ThreadGroupPolicy::Any),
        other => Err(format!("未知 Thread Group policy: {other}").into()),
    }
}

fn parse_status(value: &str) -> Result<ThreadGroupStatus, StoreError> {
    match value {
        "open" => Ok(ThreadGroupStatus::Open),
        "satisfied" => Ok(ThreadGroupStatus::Satisfied),
        "failed" => Ok(ThreadGroupStatus::Failed),
        "cancelled" => Ok(ThreadGroupStatus::Cancelled),
        other => Err(format!("未知 Thread Group status: {other}").into()),
    }
}

fn parse_member_status(value: &str) -> Result<ThreadGroupMemberStatus, StoreError> {
    match value {
        "pending" => Ok(ThreadGroupMemberStatus::Pending),
        "completed" => Ok(ThreadGroupMemberStatus::Completed),
        "failed" => Ok(ThreadGroupMemberStatus::Failed),
        "cancelled" => Ok(ThreadGroupMemberStatus::Cancelled),
        other => Err(format!("未知 Thread Group member status: {other}").into()),
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

pub(super) fn group_from_row(row: &sqlx::postgres::PgRow) -> Result<ThreadGroupRecord, StoreError> {
    Ok(ThreadGroupRecord {
        id: row.get("id"),
        revision: u64::try_from(row.get::<i64, _>("revision"))?,
        context_id: row.get("context_id"),
        session_id: row.get("session_id"),
        supervisor_kind: parse_supervisor(&row.get::<String, _>("supervisor_kind"))?,
        supervisor_id: row.get("supervisor_id"),
        generation: u64::try_from(row.get::<i64, _>("generation"))?,
        policy: parse_policy(&row.get::<String, _>("policy"))?,
        required_count: u64::try_from(row.get::<i64, _>("required_count"))?,
        terminal_count: u64::try_from(row.get::<i64, _>("terminal_count"))?,
        successful_count: u64::try_from(row.get::<i64, _>("successful_count"))?,
        status: parse_status(&row.get::<String, _>("status"))?,
        completion_contract: row.get("completion_contract_json"),
        terminal_summary: row.get("terminal_summary_json"),
        barrier_event_id: row.get("barrier_event_id"),
        created_at: parse_time(&row.get::<String, _>("created_at"))?,
        updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
        satisfied_at: row
            .get::<Option<String>, _>("satisfied_at")
            .map(|value| parse_time(&value))
            .transpose()?,
    })
}

fn member_from_row(row: &sqlx::postgres::PgRow) -> Result<ThreadGroupMemberRecord, StoreError> {
    Ok(ThreadGroupMemberRecord {
        group_id: row.get("group_id"),
        thread_id: row.get("thread_id"),
        ordinal: u64::try_from(row.get::<i64, _>("ordinal"))?,
        required: row.get("required"),
        status: parse_member_status(&row.get::<String, _>("status"))?,
        outcome_id: row.get("outcome_id"),
        created_at: parse_time(&row.get::<String, _>("created_at"))?,
        updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
    })
}

fn outcome_from_row(row: &sqlx::postgres::PgRow) -> Result<ThreadOutcomeRecord, StoreError> {
    Ok(ThreadOutcomeRecord {
        id: row.get("outcome_id"),
        thread_id: row.get("thread_id"),
        thread_generation: u64::try_from(row.get::<i64, _>("thread_generation"))?,
        root_turn_id: row.get("root_turn_id"),
        activation_id: row.get("activation_id"),
        session_id: row.get("session_id"),
        terminal_kind: parse_lifecycle(&row.get::<String, _>("terminal_kind"))?,
        disposition: row.get("disposition"),
        summary: row.get("summary"),
        result_event_id: row.get("event_id"),
        artifact_refs: serde_json::from_value(row.get::<JsonValue, _>("artifact_refs_json"))?,
        evidence_refs: serde_json::from_value(row.get::<JsonValue, _>("evidence_refs_json"))?,
        check_results: row.get::<JsonValue, _>("check_results_json"),
        unresolved_failures: serde_json::from_value(
            row.get::<JsonValue, _>("unresolved_failures_json"),
        )?,
        terminal_event_sequence: row
            .get::<Option<i64>, _>("terminal_event_sequence")
            .map(u64::try_from)
            .transpose()?,
        created_at: parse_time(&row.get::<String, _>("created_at"))?,
        delivered_at: row
            .get::<Option<String>, _>("delivered_at")
            .map(|value| parse_time(&value))
            .transpose()?,
    })
}

#[async_trait::async_trait]
impl ThreadGroupStore for PostgresStore {
    async fn get_thread_group(&self, id: &str) -> Result<Option<ThreadGroupRecord>, StoreError> {
        let row = sqlx::query("SELECT * FROM thread_groups WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(group_from_row).transpose()
    }

    async fn list_thread_groups(
        &self,
        filter: ThreadGroupFilter,
    ) -> Result<Vec<ThreadGroupRecord>, StoreError> {
        let mut query = QueryBuilder::<Postgres>::new("SELECT * FROM thread_groups WHERE TRUE");
        if let Some(value) = filter.context_id {
            query.push(" AND context_id = ").push_bind(value);
        }
        if let Some(value) = filter.session_id {
            query.push(" AND session_id = ").push_bind(value);
        }
        if let Some(value) = filter.supervisor_kind {
            query
                .push(" AND supervisor_kind = ")
                .push_bind(value.as_str());
        }
        if let Some(value) = filter.supervisor_id {
            query.push(" AND supervisor_id = ").push_bind(value);
        }
        if let Some(value) = filter.status {
            query.push(" AND status = ").push_bind(value.as_str());
        } else if !filter.include_terminal {
            query.push(" AND status = 'open'");
        }
        query.push(if filter.newest_first {
            " ORDER BY created_at DESC, id DESC"
        } else {
            " ORDER BY created_at, id"
        });
        if let Some(limit) = filter.limit {
            query.push(" LIMIT ").push_bind(i64::try_from(limit)?);
        }
        let rows = query.build().fetch_all(&self.pool).await?;
        rows.iter().map(group_from_row).collect()
    }

    async fn count_context_active_thread_groups(
        &self,
        context_id: &str,
    ) -> Result<usize, StoreError> {
        Ok(usize::try_from(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM thread_groups WHERE context_id = $1 AND status = 'open'",
            )
            .bind(context_id)
            .fetch_one(&self.pool)
            .await?,
        )?)
    }

    async fn list_thread_groups_by_ids(
        &self,
        context_id: &str,
        group_ids: &[String],
    ) -> Result<Vec<ThreadGroupRecord>, StoreError> {
        if group_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut query =
            QueryBuilder::<Postgres>::new("SELECT * FROM thread_groups WHERE context_id = ");
        query.push_bind(context_id).push(" AND id IN (");
        {
            let mut values = query.separated(", ");
            for group_id in group_ids {
                values.push_bind(group_id);
            }
        }
        query.push(") ORDER BY created_at, id");
        let rows = query.build().fetch_all(&self.pool).await?;
        rows.iter().map(group_from_row).collect()
    }

    async fn list_thread_group_members(
        &self,
        group_id: &str,
    ) -> Result<Vec<ThreadGroupMemberRecord>, StoreError> {
        let rows = sqlx::query(
            "SELECT * FROM thread_group_members WHERE group_id = $1 ORDER BY ordinal, thread_id",
        )
        .bind(group_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(member_from_row).collect()
    }

    async fn list_thread_group_members_for_groups(
        &self,
        group_ids: &[String],
    ) -> Result<Vec<(String, ThreadGroupMemberRecord)>, StoreError> {
        if group_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut query =
            QueryBuilder::<Postgres>::new("SELECT * FROM thread_group_members WHERE group_id IN (");
        {
            let mut values = query.separated(", ");
            for group_id in group_ids {
                values.push_bind(group_id);
            }
        }
        query.push(") ORDER BY group_id, ordinal, thread_id");
        let rows = query.build().fetch_all(&self.pool).await?;
        rows.iter()
            .map(|row| {
                let member = member_from_row(row)?;
                Ok((member.group_id.clone(), member))
            })
            .collect()
    }

    async fn get_thread_outcome(
        &self,
        thread_id: &str,
    ) -> Result<Option<ThreadOutcomeRecord>, StoreError> {
        let row = sqlx::query("SELECT * FROM thread_outcomes WHERE thread_id = $1")
            .bind(thread_id)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(outcome_from_row).transpose()
    }

    async fn list_thread_outcomes(
        &self,
        thread_ids: &[String],
    ) -> Result<Vec<ThreadOutcomeRecord>, StoreError> {
        if thread_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut query =
            QueryBuilder::<Postgres>::new("SELECT * FROM thread_outcomes WHERE thread_id IN (");
        {
            let mut values = query.separated(", ");
            for thread_id in thread_ids {
                values.push_bind(thread_id);
            }
        }
        query.push(") ORDER BY created_at, thread_id");
        let rows = query.build().fetch_all(&self.pool).await?;
        rows.iter().map(outcome_from_row).collect()
    }

    async fn list_thread_group_outcomes(
        &self,
        group_id: &str,
    ) -> Result<Vec<ThreadOutcomeRecord>, StoreError> {
        let rows = sqlx::query(
            r#"SELECT outcome.*
               FROM thread_group_members member
               JOIN thread_outcomes outcome ON outcome.thread_id = member.thread_id
               WHERE member.group_id = $1
               ORDER BY member.ordinal, outcome.created_at"#,
        )
        .bind(group_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(outcome_from_row).collect()
    }

    async fn list_thread_group_outcomes_for_groups(
        &self,
        group_ids: &[String],
    ) -> Result<Vec<(String, ThreadOutcomeRecord)>, StoreError> {
        if group_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut query = QueryBuilder::<Postgres>::new(
            "SELECT member.group_id AS outcome_group_id, outcome.* FROM thread_group_members member JOIN thread_outcomes outcome ON outcome.thread_id = member.thread_id WHERE member.group_id IN (",
        );
        {
            let mut values = query.separated(", ");
            for group_id in group_ids {
                values.push_bind(group_id);
            }
        }
        query.push(") ORDER BY member.group_id, member.ordinal, outcome.created_at");
        let rows = query.build().fetch_all(&self.pool).await?;
        rows.iter()
            .map(|row| {
                Ok((
                    row.try_get::<String, _>("outcome_group_id")?,
                    outcome_from_row(row)?,
                ))
            })
            .collect()
    }
}
