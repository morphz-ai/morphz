use super::{now_text, parse_time, PostgresStore, StoreError};
use crate::scheduler::{
    NewSchedulerDependency, SchedulerDependencyFilter, SchedulerDependencyKind,
    SchedulerDependencyMutation, SchedulerDependencyOwnerKind, SchedulerDependencyRecord,
    SchedulerDependencyStatus, SchedulerDependencyStore,
};
use sqlx::postgres::PgRow;
use sqlx::{PgPool, Postgres, QueryBuilder, Row};

pub(super) async fn migrate(pool: &PgPool) -> Result<(), StoreError> {
    for statement in [
        r#"CREATE TABLE IF NOT EXISTS scheduler_dependencies (
            id TEXT PRIMARY KEY,
            owner_kind TEXT NOT NULL CHECK(owner_kind IN ('objective', 'thread', 'plan', 'schedule', 'delivery')),
            owner_id TEXT NOT NULL,
            owner_generation BIGINT NOT NULL CHECK(owner_generation > 0),
            dependency_kind TEXT NOT NULL CHECK(dependency_kind IN ('thread', 'thread_group', 'tool_task', 'delegation', 'timer', 'permission', 'user_input', 'external_event', 'resource')),
            dependency_id TEXT NOT NULL,
            dependency_generation BIGINT NOT NULL CHECK(dependency_generation > 0),
            required BOOLEAN NOT NULL DEFAULT TRUE,
            status TEXT NOT NULL CHECK(status IN ('pending', 'satisfied', 'cancelled')),
            metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            satisfied_by_event_id TEXT REFERENCES events(id),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            satisfied_at TEXT,
            UNIQUE(owner_kind, owner_id, owner_generation, dependency_kind, dependency_id, dependency_generation)
        )"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_scheduler_dependencies_owner
           ON scheduler_dependencies(owner_kind, owner_id, owner_generation, status, required)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_scheduler_dependencies_fact
           ON scheduler_dependencies(dependency_kind, dependency_id, dependency_generation, status)"#,
    ] {
        sqlx::query(statement).execute(pool).await?;
    }
    Ok(())
}

fn dependency_from_row(row: &PgRow) -> Result<SchedulerDependencyRecord, StoreError> {
    let owner_kind = row.get::<String, _>("owner_kind");
    let dependency_kind = row.get::<String, _>("dependency_kind");
    let status = row.get::<String, _>("status");
    Ok(SchedulerDependencyRecord {
        id: row.get("id"),
        owner_kind: SchedulerDependencyOwnerKind::parse(&owner_kind)
            .ok_or_else(|| format!("未知 Scheduler dependency owner kind: {owner_kind}"))?,
        owner_id: row.get("owner_id"),
        owner_generation: u64::try_from(row.get::<i64, _>("owner_generation"))?,
        dependency_kind: SchedulerDependencyKind::parse(&dependency_kind)
            .ok_or_else(|| format!("未知 Scheduler dependency kind: {dependency_kind}"))?,
        dependency_id: row.get("dependency_id"),
        dependency_generation: u64::try_from(row.get::<i64, _>("dependency_generation"))?,
        required: row.get("required"),
        status: SchedulerDependencyStatus::parse(&status)
            .ok_or_else(|| format!("未知 Scheduler dependency status: {status}"))?,
        metadata: row.get("metadata_json"),
        satisfied_by_event_id: row.get("satisfied_by_event_id"),
        created_at: parse_time(&row.get::<String, _>("created_at"))?,
        updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
        satisfied_at: row
            .get::<Option<String>, _>("satisfied_at")
            .as_deref()
            .map(parse_time)
            .transpose()?,
    })
}

#[async_trait::async_trait]
impl SchedulerDependencyStore for PostgresStore {
    async fn register_scheduler_dependency(
        &self,
        dependency: NewSchedulerDependency,
    ) -> Result<SchedulerDependencyMutation, StoreError> {
        if dependency.owner_generation == 0 || dependency.dependency_generation == 0 {
            return Err("Scheduler dependency generation 必须大于 0".into());
        }
        if dependency.id.trim().is_empty()
            || dependency.owner_id.trim().is_empty()
            || dependency.dependency_id.trim().is_empty()
        {
            return Err("Scheduler dependency identity 不能为空".into());
        }
        let owner_generation = i64::try_from(dependency.owner_generation)?;
        let dependency_generation = i64::try_from(dependency.dependency_generation)?;
        let now = now_text();
        let mut tx = self.pool.begin().await?;
        let inserted = sqlx::query(
            r#"INSERT INTO scheduler_dependencies
               (id, owner_kind, owner_id, owner_generation,
                dependency_kind, dependency_id, dependency_generation,
                required, status, metadata_json, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10, $10)
               ON CONFLICT(id) DO NOTHING"#,
        )
        .bind(&dependency.id)
        .bind(dependency.owner_kind.as_str())
        .bind(&dependency.owner_id)
        .bind(owner_generation)
        .bind(dependency.dependency_kind.as_str())
        .bind(&dependency.dependency_id)
        .bind(dependency_generation)
        .bind(dependency.required)
        .bind(&dependency.metadata)
        .bind(&now)
        .execute(&mut *tx)
        .await?
        .rows_affected()
            == 1;
        let row = sqlx::query("SELECT * FROM scheduler_dependencies WHERE id = $1")
            .bind(&dependency.id)
            .fetch_optional(&mut *tx)
            .await?;
        tx.commit().await?;
        let Some(row) = row else {
            return Err("Scheduler dependency 写入后无法读取".into());
        };
        let current = dependency_from_row(&row)?;
        if inserted {
            return Ok(SchedulerDependencyMutation::Updated(current));
        }
        let exact = current.owner_kind == dependency.owner_kind
            && current.owner_id == dependency.owner_id
            && current.owner_generation == dependency.owner_generation
            && current.dependency_kind == dependency.dependency_kind
            && current.dependency_id == dependency.dependency_id
            && current.dependency_generation == dependency.dependency_generation
            && current.required == dependency.required
            && current.metadata == dependency.metadata;
        if exact {
            Ok(SchedulerDependencyMutation::Existing(current))
        } else {
            Ok(SchedulerDependencyMutation::Conflict {
                current,
                reason: "同一 Scheduler dependency ID 已被不同内容占用".to_string(),
            })
        }
    }

    async fn get_scheduler_dependency(
        &self,
        id: &str,
    ) -> Result<Option<SchedulerDependencyRecord>, StoreError> {
        let row = sqlx::query("SELECT * FROM scheduler_dependencies WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(dependency_from_row).transpose()
    }

    async fn list_scheduler_dependencies(
        &self,
        filter: SchedulerDependencyFilter,
    ) -> Result<Vec<SchedulerDependencyRecord>, StoreError> {
        let mut builder =
            QueryBuilder::<Postgres>::new("SELECT * FROM scheduler_dependencies WHERE TRUE");
        if let Some(owner_kind) = filter.owner_kind {
            builder
                .push(" AND owner_kind = ")
                .push_bind(owner_kind.as_str());
        }
        if let Some(owner_id) = filter.owner_id {
            builder.push(" AND owner_id = ").push_bind(owner_id);
        }
        if let Some(dependency_kind) = filter.dependency_kind {
            builder
                .push(" AND dependency_kind = ")
                .push_bind(dependency_kind.as_str());
        }
        if let Some(dependency_id) = filter.dependency_id {
            builder
                .push(" AND dependency_id = ")
                .push_bind(dependency_id);
        }
        if let Some(status) = filter.status {
            builder.push(" AND status = ").push_bind(status.as_str());
        }
        if filter.required_only {
            builder.push(" AND required = TRUE");
        }
        builder.push(" ORDER BY created_at, id");
        builder
            .build()
            .fetch_all(&self.pool)
            .await?
            .iter()
            .map(dependency_from_row)
            .collect()
    }

    async fn satisfy_scheduler_dependency(
        &self,
        id: &str,
        owner_generation: u64,
        dependency_generation: u64,
        satisfied_by_event_id: &str,
    ) -> Result<SchedulerDependencyMutation, StoreError> {
        if satisfied_by_event_id.trim().is_empty() {
            return Err("Scheduler dependency satisfaction Event ID 不能为空".into());
        }
        let owner_generation_i64 = i64::try_from(owner_generation)?;
        let dependency_generation_i64 = i64::try_from(dependency_generation)?;
        let now = now_text();
        let result = sqlx::query(
            r#"UPDATE scheduler_dependencies
               SET status = 'satisfied', satisfied_by_event_id = $1,
                   satisfied_at = $2, updated_at = $2
               WHERE id = $3 AND owner_generation = $4 AND dependency_generation = $5
                 AND status = 'pending'"#,
        )
        .bind(satisfied_by_event_id)
        .bind(&now)
        .bind(id)
        .bind(owner_generation_i64)
        .bind(dependency_generation_i64)
        .execute(&self.pool)
        .await?;
        let Some(current) = self.get_scheduler_dependency(id).await? else {
            return Ok(SchedulerDependencyMutation::NotFound);
        };
        if result.rows_affected() == 1 {
            return Ok(SchedulerDependencyMutation::Updated(current));
        }
        if current.owner_generation == owner_generation
            && current.dependency_generation == dependency_generation
            && current.status == SchedulerDependencyStatus::Satisfied
            && current.satisfied_by_event_id.as_deref() == Some(satisfied_by_event_id)
        {
            return Ok(SchedulerDependencyMutation::Existing(current));
        }
        Ok(SchedulerDependencyMutation::Conflict {
            current,
            reason: "Scheduler dependency fence、状态或 satisfaction Event 不匹配".to_string(),
        })
    }

    async fn cancel_scheduler_dependencies(
        &self,
        owner_kind: SchedulerDependencyOwnerKind,
        owner_id: &str,
        owner_generation: u64,
    ) -> Result<u64, StoreError> {
        let owner_generation = i64::try_from(owner_generation)?;
        Ok(sqlx::query(
            r#"UPDATE scheduler_dependencies
               SET status = 'cancelled', updated_at = $1
               WHERE owner_kind = $2 AND owner_id = $3 AND owner_generation = $4
                 AND status = 'pending'"#,
        )
        .bind(now_text())
        .bind(owner_kind.as_str())
        .bind(owner_id)
        .bind(owner_generation)
        .execute(&self.pool)
        .await?
        .rows_affected())
    }
}
