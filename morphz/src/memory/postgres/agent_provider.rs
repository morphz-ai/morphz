use super::{now_text, parse_time, PostgresStore, StoreError};
use crate::memory::{
    AgentProviderBindingRecord, AgentProviderBindingSet, AgentProviderBindingStore,
};
use sqlx::{PgPool, Row};
use std::collections::BTreeSet;

pub(super) async fn migrate(pool: &PgPool) -> Result<(), StoreError> {
    for statement in [
        r#"CREATE TABLE IF NOT EXISTS agent_provider_binding_scopes (
            agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
            revision BIGINT NOT NULL CHECK(revision >= 1),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )"#,
        r#"CREATE TABLE IF NOT EXISTS agent_provider_bindings (
            agent_id TEXT NOT NULL REFERENCES agent_provider_binding_scopes(agent_id)
                ON DELETE CASCADE,
            account_id TEXT NOT NULL,
            bound_at TEXT NOT NULL,
            PRIMARY KEY(agent_id, account_id)
        )"#,
        r#"CREATE INDEX IF NOT EXISTS idx_agent_provider_bindings_account
            ON agent_provider_bindings(account_id, agent_id)"#,
    ] {
        sqlx::query(statement).execute(pool).await?;
    }
    Ok(())
}

fn normalized_account_ids(account_ids: &[String]) -> Result<Vec<String>, StoreError> {
    let mut normalized = BTreeSet::new();
    for account_id in account_ids {
        let account_id = account_id.trim();
        if account_id.is_empty() {
            return Err("Provider Account ID cannot be empty".into());
        }
        normalized.insert(account_id.to_string());
    }
    Ok(normalized.into_iter().collect())
}

async fn load_binding_set(
    pool: &PgPool,
    agent_id: &str,
) -> Result<Option<AgentProviderBindingSet>, StoreError> {
    let Some(scope) = sqlx::query(
        "SELECT agent_id, revision, created_at, updated_at FROM agent_provider_binding_scopes WHERE agent_id = $1",
    )
    .bind(agent_id)
    .fetch_optional(pool)
    .await?
    else {
        return Ok(None);
    };
    let rows = sqlx::query(
        "SELECT agent_id, account_id, bound_at FROM agent_provider_bindings WHERE agent_id = $1 ORDER BY account_id",
    )
    .bind(agent_id)
    .fetch_all(pool)
    .await?;
    Ok(Some(AgentProviderBindingSet {
        agent_id: scope.get("agent_id"),
        revision: u64::try_from(scope.get::<i64, _>("revision"))?,
        bindings: rows
            .iter()
            .map(|row| {
                Ok(AgentProviderBindingRecord {
                    agent_id: row.get("agent_id"),
                    account_id: row.get("account_id"),
                    bound_at: parse_time(&row.get::<String, _>("bound_at"))?,
                })
            })
            .collect::<Result<Vec<_>, StoreError>>()?,
        created_at: parse_time(&scope.get::<String, _>("created_at"))?,
        updated_at: parse_time(&scope.get::<String, _>("updated_at"))?,
    }))
}

#[async_trait::async_trait]
impl AgentProviderBindingStore for PostgresStore {
    async fn initialize_agent_provider_bindings(
        &self,
        agent_id: &str,
        account_ids: &[String],
    ) -> Result<AgentProviderBindingSet, StoreError> {
        let agent_id = agent_id.trim();
        if agent_id.is_empty() {
            return Err("Agent ID cannot be empty".into());
        }
        let account_ids = normalized_account_ids(account_ids)?;
        let now = now_text();
        let mut tx = self.pool.begin().await?;
        let inserted = sqlx::query(
            r#"INSERT INTO agent_provider_binding_scopes
               (agent_id, revision, created_at, updated_at) VALUES ($1, 1, $2, $2)
               ON CONFLICT(agent_id) DO NOTHING"#,
        )
        .bind(agent_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?
        .rows_affected()
            == 1;
        if inserted {
            for account_id in account_ids {
                sqlx::query(
                    "INSERT INTO agent_provider_bindings (agent_id, account_id, bound_at) VALUES ($1, $2, $3)",
                )
                .bind(agent_id)
                .bind(account_id)
                .bind(&now)
                .execute(&mut *tx)
                .await?;
            }
        }
        tx.commit().await?;
        load_binding_set(&self.pool, agent_id)
            .await?
            .ok_or_else(|| "Agent Provider policy initialization was not persisted".into())
    }

    async fn get_agent_provider_bindings(
        &self,
        agent_id: &str,
    ) -> Result<Option<AgentProviderBindingSet>, StoreError> {
        load_binding_set(&self.pool, agent_id).await
    }

    async fn get_context_agent_provider_bindings(
        &self,
        context_id: &str,
    ) -> Result<Option<AgentProviderBindingSet>, StoreError> {
        let agent_id = sqlx::query_scalar::<_, String>(
            "SELECT agent_id FROM cognitive_contexts WHERE id = $1",
        )
        .bind(context_id)
        .fetch_optional(&self.pool)
        .await?;
        let Some(agent_id) = agent_id else {
            return Ok(None);
        };
        load_binding_set(&self.pool, &agent_id).await?.map_or_else(
            || Err(format!("Agent '{agent_id}' Provider policy is not initialized").into()),
            |bindings| Ok(Some(bindings)),
        )
    }

    async fn bind_agent_provider_account(
        &self,
        agent_id: &str,
        account_id: &str,
    ) -> Result<AgentProviderBindingSet, StoreError> {
        let agent_id = agent_id.trim();
        let account_id = account_id.trim();
        if agent_id.is_empty() || account_id.is_empty() {
            return Err("Agent ID and Provider Account ID cannot be empty".into());
        }
        let now = now_text();
        let mut tx = self.pool.begin().await?;
        let scope_inserted = sqlx::query(
            r#"INSERT INTO agent_provider_binding_scopes
               (agent_id, revision, created_at, updated_at) VALUES ($1, 1, $2, $2)
               ON CONFLICT(agent_id) DO NOTHING"#,
        )
        .bind(agent_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?
        .rows_affected()
            == 1;
        let binding_inserted = sqlx::query(
            r#"INSERT INTO agent_provider_bindings (agent_id, account_id, bound_at)
               VALUES ($1, $2, $3) ON CONFLICT(agent_id, account_id) DO NOTHING"#,
        )
        .bind(agent_id)
        .bind(account_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?
        .rows_affected()
            == 1;
        if binding_inserted && !scope_inserted {
            sqlx::query(
                "UPDATE agent_provider_binding_scopes SET revision = revision + 1, updated_at = $1 WHERE agent_id = $2",
            )
            .bind(&now)
            .bind(agent_id)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        load_binding_set(&self.pool, agent_id)
            .await?
            .ok_or_else(|| "Agent Provider binding was not persisted".into())
    }

    async fn unbind_agent_provider_account(
        &self,
        agent_id: &str,
        account_id: &str,
    ) -> Result<AgentProviderBindingSet, StoreError> {
        let agent_id = agent_id.trim();
        let account_id = account_id.trim();
        if agent_id.is_empty() || account_id.is_empty() {
            return Err("Agent ID and Provider Account ID cannot be empty".into());
        }
        let now = now_text();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            r#"INSERT INTO agent_provider_binding_scopes
               (agent_id, revision, created_at, updated_at) VALUES ($1, 1, $2, $2)
               ON CONFLICT(agent_id) DO NOTHING"#,
        )
        .bind(agent_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        let deleted = sqlx::query(
            "DELETE FROM agent_provider_bindings WHERE agent_id = $1 AND account_id = $2",
        )
        .bind(agent_id)
        .bind(account_id)
        .execute(&mut *tx)
        .await?
        .rows_affected()
            == 1;
        if deleted {
            sqlx::query(
                "UPDATE agent_provider_binding_scopes SET revision = revision + 1, updated_at = $1 WHERE agent_id = $2",
            )
            .bind(&now)
            .bind(agent_id)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        load_binding_set(&self.pool, agent_id)
            .await?
            .ok_or_else(|| "Agent Provider policy was not persisted".into())
    }

    async fn list_provider_account_agent_bindings(
        &self,
        account_id: &str,
    ) -> Result<Vec<AgentProviderBindingRecord>, StoreError> {
        let rows = sqlx::query(
            "SELECT agent_id, account_id, bound_at FROM agent_provider_bindings WHERE account_id = $1 ORDER BY agent_id",
        )
        .bind(account_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|row| {
                Ok(AgentProviderBindingRecord {
                    agent_id: row.get("agent_id"),
                    account_id: row.get("account_id"),
                    bound_at: parse_time(&row.get::<String, _>("bound_at"))?,
                })
            })
            .collect()
    }
}
