//! PostgreSQL Execution Target registry.

use super::{now_text, parse_time, PostgresStore, StoreError};
use crate::memory::{
    ExecutionTargetAuthorizationFilter, ExecutionTargetAuthorizationMutation,
    ExecutionTargetAuthorizationRecord, ExecutionTargetAuthorizationScope,
    ExecutionTargetAuthorizationStatus, ExecutionTargetAuthorizationStore, ExecutionTargetFilter,
    ExecutionTargetKind, ExecutionTargetMutation, ExecutionTargetRecord,
    ExecutionTargetRegistration, ExecutionTargetStatus, ExecutionTargetStore,
    NewExecutionTargetAuthorization,
};
use serde_json::Value as JsonValue;
use sqlx::postgres::PgRow;
use sqlx::{PgPool, Postgres, QueryBuilder, Row};

pub(super) async fn migrate(pool: &PgPool) -> Result<(), StoreError> {
    for statement in [
        r#"CREATE TABLE IF NOT EXISTS execution_targets (
            id TEXT PRIMARY KEY,
            revision BIGINT NOT NULL DEFAULT 1 CHECK(revision >= 1),
            owner_principal_id TEXT,
            provider_node_id TEXT,
            kind TEXT NOT NULL,
            name TEXT NOT NULL,
            status TEXT NOT NULL,
            platform TEXT,
            workspace_root TEXT,
            capabilities_json JSONB NOT NULL DEFAULT '[]'::jsonb,
            metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            policy_digest TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_seen_at TEXT
        )"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_execution_targets_owner_status
           ON execution_targets(owner_principal_id, status, updated_at DESC)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_execution_targets_provider_status
           ON execution_targets(provider_node_id, status, updated_at DESC)"#,
        r#"CREATE TABLE IF NOT EXISTS execution_target_authorizations (
            id TEXT PRIMARY KEY,
            revision BIGINT NOT NULL DEFAULT 1 CHECK(revision >= 1),
            target_id TEXT NOT NULL REFERENCES execution_targets(id) ON DELETE CASCADE,
            owner_principal_id TEXT NOT NULL,
            scope TEXT NOT NULL CHECK(scope IN ('agent', 'context', 'thread')),
            scope_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            revoked_at TEXT,
            revoke_reason TEXT,
            UNIQUE(target_id, owner_principal_id, scope, scope_id)
        )"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_target_authorizations_lookup
           ON execution_target_authorizations(target_id, owner_principal_id, status, scope, scope_id)"#,
        r#"INSERT INTO execution_targets
           (id, revision, kind, name, status, capabilities_json, metadata_json,
            policy_digest, created_at, updated_at, last_seen_at)
           VALUES ('target-default', 1, 'in_process_local',
                   'Default local execution environment', 'online', '[]'::jsonb, '{}'::jsonb,
                   '', CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text)
           ON CONFLICT (id) DO NOTHING"#,
        r#"ALTER TABLE execution_jobs ADD COLUMN IF NOT EXISTS target_id TEXT"#,
        r#"UPDATE execution_jobs SET target_id = 'target-default' WHERE target_id IS NULL"#,
        r#"ALTER TABLE execution_jobs ALTER COLUMN target_id SET NOT NULL"#,
        r#"DO $$
           BEGIN
             IF NOT EXISTS (
               SELECT 1 FROM pg_constraint WHERE conname = 'execution_jobs_target_id_fkey'
             ) THEN
               ALTER TABLE execution_jobs ADD CONSTRAINT execution_jobs_target_id_fkey
                 FOREIGN KEY (target_id) REFERENCES execution_targets(id);
             END IF;
           END $$"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_execution_jobs_target_status
           ON execution_jobs(target_id, status, created_at, id)"#,
    ] {
        sqlx::query(statement).execute(pool).await?;
    }
    Ok(())
}

fn target_from_row(row: &PgRow) -> Result<ExecutionTargetRecord, StoreError> {
    Ok(ExecutionTargetRecord {
        id: row.get("id"),
        revision: u64::try_from(row.get::<i64, _>("revision"))?,
        owner_principal_id: row.get("owner_principal_id"),
        provider_node_id: row.get("provider_node_id"),
        kind: ExecutionTargetKind::parse(&row.get::<String, _>("kind"))
            .ok_or("未知 Execution Target kind")?,
        name: row.get("name"),
        status: ExecutionTargetStatus::parse(&row.get::<String, _>("status"))
            .ok_or("未知 Execution Target status")?,
        platform: row.get("platform"),
        workspace_root: row.get("workspace_root"),
        capabilities: serde_json::from_value(row.get("capabilities_json"))?,
        metadata: row.get("metadata_json"),
        policy_digest: row.get("policy_digest"),
        created_at: parse_time(&row.get::<String, _>("created_at"))?,
        updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
        last_seen_at: row
            .get::<Option<String>, _>("last_seen_at")
            .as_deref()
            .map(parse_time)
            .transpose()?,
    })
}

fn authorization_from_row(row: &PgRow) -> Result<ExecutionTargetAuthorizationRecord, StoreError> {
    Ok(ExecutionTargetAuthorizationRecord {
        id: row.get("id"),
        revision: u64::try_from(row.get::<i64, _>("revision"))?,
        target_id: row.get("target_id"),
        owner_principal_id: row.get("owner_principal_id"),
        scope: ExecutionTargetAuthorizationScope::parse(&row.get::<String, _>("scope"))
            .ok_or("未知 Execution Target authorization scope")?,
        scope_id: row.get("scope_id"),
        status: ExecutionTargetAuthorizationStatus::parse(&row.get::<String, _>("status"))
            .ok_or("未知 Execution Target authorization status")?,
        created_at: parse_time(&row.get::<String, _>("created_at"))?,
        updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
        revoked_at: row
            .get::<Option<String>, _>("revoked_at")
            .as_deref()
            .map(parse_time)
            .transpose()?,
        revoke_reason: row.get("revoke_reason"),
    })
}

fn validate_registration(registration: &ExecutionTargetRegistration) -> Result<(), StoreError> {
    if registration.id.trim().is_empty() || registration.name.trim().is_empty() {
        return Err("Execution Target id/name 不能为空".into());
    }
    if !registration.metadata.is_object() {
        return Err("Execution Target metadata 必须是 JSON object".into());
    }
    fn contains_secret(value: &JsonValue) -> bool {
        match value {
            JsonValue::Object(object) => object.iter().any(|(key, value)| {
                matches!(
                    key.to_ascii_lowercase().as_str(),
                    "token"
                        | "api_key"
                        | "apikey"
                        | "password"
                        | "private_key"
                        | "secret"
                        | "credential"
                ) || contains_secret(value)
            }),
            JsonValue::Array(values) => values.iter().any(contains_secret),
            _ => false,
        }
    }
    if contains_secret(&registration.metadata) {
        return Err("Execution Target metadata 禁止包含凭证值".into());
    }
    Ok(())
}

#[async_trait::async_trait]
impl ExecutionTargetStore for PostgresStore {
    async fn register_execution_target(
        &self,
        mut registration: ExecutionTargetRegistration,
    ) -> Result<ExecutionTargetRecord, StoreError> {
        validate_registration(&registration)?;
        registration.capabilities.sort();
        registration.capabilities.dedup();
        let now = now_text();
        let last_seen = registration.last_seen_at.map(|value| value.to_rfc3339());
        let capabilities = serde_json::to_value(&registration.capabilities)?;
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            r#"INSERT INTO execution_targets
               (id, revision, owner_principal_id, provider_node_id, kind, name, status,
                platform, workspace_root, capabilities_json, metadata_json, policy_digest,
                created_at, updated_at, last_seen_at)
               VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, $13)
               ON CONFLICT (id) DO NOTHING"#,
        )
        .bind(&registration.id)
        .bind(&registration.owner_principal_id)
        .bind(&registration.provider_node_id)
        .bind(registration.kind.as_str())
        .bind(&registration.name)
        .bind(registration.status.as_str())
        .bind(&registration.platform)
        .bind(&registration.workspace_root)
        .bind(&capabilities)
        .bind(&registration.metadata)
        .bind(&registration.policy_digest)
        .bind(&now)
        .bind(&last_seen)
        .execute(&mut *tx)
        .await?;
        let row = sqlx::query("SELECT * FROM execution_targets WHERE id = $1 FOR UPDATE")
            .bind(&registration.id)
            .fetch_one(&mut *tx)
            .await?;
        let current = target_from_row(&row)?;
        if current.kind != registration.kind
            || current.owner_principal_id != registration.owner_principal_id
        {
            return Err(format!(
                "Execution Target '{}' 已被不同 kind/owner 占用",
                registration.id
            )
            .into());
        }
        if current.status == ExecutionTargetStatus::Disabled
            && registration.status != ExecutionTargetStatus::Disabled
        {
            tx.commit().await?;
            return Ok(current);
        }
        let changed = current.provider_node_id != registration.provider_node_id
            || current.name != registration.name
            || current.status != registration.status
            || current.platform != registration.platform
            || current.workspace_root != registration.workspace_root
            || current.capabilities != registration.capabilities
            || current.metadata != registration.metadata
            || current.policy_digest != registration.policy_digest;
        if changed {
            sqlx::query(
                r#"UPDATE execution_targets
                   SET revision = revision + 1, provider_node_id = $2, name = $3, status = $4,
                       platform = $5, workspace_root = $6, capabilities_json = $7,
                       metadata_json = $8, policy_digest = $9, updated_at = $10, last_seen_at = $11
                   WHERE id = $1"#,
            )
            .bind(&registration.id)
            .bind(&registration.provider_node_id)
            .bind(&registration.name)
            .bind(registration.status.as_str())
            .bind(&registration.platform)
            .bind(&registration.workspace_root)
            .bind(&capabilities)
            .bind(&registration.metadata)
            .bind(&registration.policy_digest)
            .bind(&now)
            .bind(&last_seen)
            .execute(&mut *tx)
            .await?;
        } else if last_seen.is_some() {
            sqlx::query("UPDATE execution_targets SET last_seen_at = $2 WHERE id = $1")
                .bind(&registration.id)
                .bind(&last_seen)
                .execute(&mut *tx)
                .await?;
        }
        let row = sqlx::query("SELECT * FROM execution_targets WHERE id = $1")
            .bind(&registration.id)
            .fetch_one(&mut *tx)
            .await?;
        let target = target_from_row(&row)?;
        tx.commit().await?;
        Ok(target)
    }

    async fn get_execution_target(
        &self,
        id: &str,
    ) -> Result<Option<ExecutionTargetRecord>, StoreError> {
        sqlx::query("SELECT * FROM execution_targets WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(target_from_row)
            .transpose()
    }

    async fn list_execution_targets(
        &self,
        filter: ExecutionTargetFilter,
    ) -> Result<Vec<ExecutionTargetRecord>, StoreError> {
        if filter.limit == Some(0) {
            return Ok(Vec::new());
        }
        let mut query = QueryBuilder::<Postgres>::new("SELECT * FROM execution_targets WHERE TRUE");
        if let Some(owner) = filter.owner_principal_id {
            query.push(" AND owner_principal_id = ").push_bind(owner);
        }
        if let Some(provider) = filter.provider_node_id {
            query.push(" AND provider_node_id = ").push_bind(provider);
        }
        if let Some(status) = filter.status {
            query.push(" AND status = ").push_bind(status.as_str());
        }
        query.push(" ORDER BY updated_at DESC, id");
        if let Some(limit) = filter.limit {
            query.push(" LIMIT ").push_bind(i64::try_from(limit)?);
        }
        let rows = query.build().fetch_all(&self.pool).await?;
        rows.iter().map(target_from_row).collect()
    }

    async fn set_execution_target_status(
        &self,
        id: &str,
        expected_revision: u64,
        status: ExecutionTargetStatus,
    ) -> Result<ExecutionTargetMutation, StoreError> {
        let updated = sqlx::query(
            r#"UPDATE execution_targets SET revision = revision + 1, status = $3, updated_at = $4
               WHERE id = $1 AND revision = $2 RETURNING *"#,
        )
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
        .bind(status.as_str())
        .bind(now_text())
        .fetch_optional(&self.pool)
        .await?;
        if let Some(row) = updated {
            return Ok(ExecutionTargetMutation::Updated(target_from_row(&row)?));
        }
        Ok(match self.get_execution_target(id).await? {
            Some(current) => ExecutionTargetMutation::Conflict { current },
            None => ExecutionTargetMutation::NotFound,
        })
    }
}

#[async_trait::async_trait]
impl ExecutionTargetAuthorizationStore for PostgresStore {
    async fn authorize_execution_target(
        &self,
        authorization: NewExecutionTargetAuthorization,
    ) -> Result<ExecutionTargetAuthorizationMutation, StoreError> {
        if authorization.id.trim().is_empty()
            || authorization.target_id.trim().is_empty()
            || authorization.owner_principal_id.trim().is_empty()
            || authorization.scope_id.trim().is_empty()
        {
            return Err("Execution Target authorization 字段不能为空".into());
        }
        let mut tx = self.pool.begin().await?;
        let target = sqlx::query(
            "SELECT owner_principal_id FROM execution_targets WHERE id = $1 FOR UPDATE",
        )
        .bind(&authorization.target_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or("Execution Target 不存在")?;
        if target
            .get::<Option<String>, _>("owner_principal_id")
            .as_deref()
            != Some(authorization.owner_principal_id.as_str())
        {
            return Err("只有 Target 所有者可以创建 scoped authorization".into());
        }
        let existing = sqlx::query(
            r#"SELECT * FROM execution_target_authorizations
               WHERE target_id = $1 AND owner_principal_id = $2 AND scope = $3 AND scope_id = $4
               FOR UPDATE"#,
        )
        .bind(&authorization.target_id)
        .bind(&authorization.owner_principal_id)
        .bind(authorization.scope.as_str())
        .bind(&authorization.scope_id)
        .fetch_optional(&mut *tx)
        .await?;
        let now = now_text();
        if let Some(row) = existing {
            let current = authorization_from_row(&row)?;
            if current.status == ExecutionTargetAuthorizationStatus::Active {
                tx.commit().await?;
                return Ok(ExecutionTargetAuthorizationMutation::Existing(current));
            }
            let row = sqlx::query(
                r#"UPDATE execution_target_authorizations
                   SET revision = revision + 1, status = 'active', updated_at = $2,
                       revoked_at = NULL, revoke_reason = NULL
                   WHERE id = $1 AND revision = $3 RETURNING *"#,
            )
            .bind(&current.id)
            .bind(&now)
            .bind(i64::try_from(current.revision)?)
            .fetch_optional(&mut *tx)
            .await?;
            if let Some(row) = row {
                let updated = authorization_from_row(&row)?;
                tx.commit().await?;
                return Ok(ExecutionTargetAuthorizationMutation::Updated(updated));
            }
            let row = sqlx::query("SELECT * FROM execution_target_authorizations WHERE id = $1")
                .bind(&current.id)
                .fetch_one(&mut *tx)
                .await?;
            let current = authorization_from_row(&row)?;
            tx.commit().await?;
            return Ok(ExecutionTargetAuthorizationMutation::Conflict { current });
        }
        let row = sqlx::query(
            r#"INSERT INTO execution_target_authorizations
               (id, revision, target_id, owner_principal_id, scope, scope_id, status,
                created_at, updated_at)
               VALUES ($1, 1, $2, $3, $4, $5, 'active', $6, $6)
               RETURNING *"#,
        )
        .bind(&authorization.id)
        .bind(&authorization.target_id)
        .bind(&authorization.owner_principal_id)
        .bind(authorization.scope.as_str())
        .bind(&authorization.scope_id)
        .bind(&now)
        .fetch_one(&mut *tx)
        .await?;
        let created = authorization_from_row(&row)?;
        tx.commit().await?;
        Ok(ExecutionTargetAuthorizationMutation::Created(created))
    }

    async fn get_execution_target_authorization(
        &self,
        id: &str,
    ) -> Result<Option<ExecutionTargetAuthorizationRecord>, StoreError> {
        sqlx::query("SELECT * FROM execution_target_authorizations WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(authorization_from_row)
            .transpose()
    }

    async fn list_execution_target_authorizations(
        &self,
        filter: ExecutionTargetAuthorizationFilter,
    ) -> Result<Vec<ExecutionTargetAuthorizationRecord>, StoreError> {
        if filter.limit == Some(0) {
            return Ok(Vec::new());
        }
        let mut query = QueryBuilder::<Postgres>::new(
            "SELECT * FROM execution_target_authorizations WHERE TRUE",
        );
        if let Some(target_id) = filter.target_id {
            query.push(" AND target_id = ").push_bind(target_id);
        }
        if let Some(owner) = filter.owner_principal_id {
            query.push(" AND owner_principal_id = ").push_bind(owner);
        }
        if let Some(scope) = filter.scope {
            query.push(" AND scope = ").push_bind(scope.as_str());
        }
        if let Some(scope_id) = filter.scope_id {
            query.push(" AND scope_id = ").push_bind(scope_id);
        }
        if filter.active_only {
            query.push(" AND status = 'active'");
        }
        query.push(" ORDER BY updated_at DESC, id");
        if let Some(limit) = filter.limit {
            query.push(" LIMIT ").push_bind(i64::try_from(limit)?);
        }
        let rows = query.build().fetch_all(&self.pool).await?;
        rows.iter().map(authorization_from_row).collect()
    }

    async fn revoke_execution_target_authorization(
        &self,
        id: &str,
        expected_revision: u64,
        reason: &str,
    ) -> Result<ExecutionTargetAuthorizationMutation, StoreError> {
        let current = self.get_execution_target_authorization(id).await?;
        let Some(current) = current else {
            return Ok(ExecutionTargetAuthorizationMutation::NotFound);
        };
        if current.status == ExecutionTargetAuthorizationStatus::Revoked {
            return Ok(ExecutionTargetAuthorizationMutation::Existing(current));
        }
        if current.revision != expected_revision {
            return Ok(ExecutionTargetAuthorizationMutation::Conflict { current });
        }
        let now = now_text();
        let updated = sqlx::query(
            r#"UPDATE execution_target_authorizations
               SET revision = revision + 1, status = 'revoked', updated_at = $2,
                   revoked_at = $2, revoke_reason = $3
               WHERE id = $1 AND revision = $4 AND status = 'active' RETURNING *"#,
        )
        .bind(id)
        .bind(&now)
        .bind(reason)
        .bind(i64::try_from(expected_revision)?)
        .fetch_optional(&self.pool)
        .await?;
        if let Some(row) = updated {
            return Ok(ExecutionTargetAuthorizationMutation::Updated(
                authorization_from_row(&row)?,
            ));
        }
        Ok(match self.get_execution_target_authorization(id).await? {
            Some(current) => ExecutionTargetAuthorizationMutation::Conflict { current },
            None => ExecutionTargetAuthorizationMutation::NotFound,
        })
    }

    async fn has_execution_target_authorization_history(
        &self,
        target_id: &str,
    ) -> Result<bool, StoreError> {
        Ok(sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM execution_target_authorizations WHERE target_id = $1",
        )
        .bind(target_id)
        .fetch_one(&self.pool)
        .await?
            > 0)
    }
}
