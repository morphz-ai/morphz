use super::{now_text, parse_time, PostgresStore, StoreError};
use crate::memory::{
    AgentProviderBindingRecord, AgentProviderBindingSet, AgentProviderBindingStore,
    AgentProviderPolicyMode,
};
use sqlx::{PgPool, Row};
use std::collections::BTreeSet;

pub(super) async fn migrate(pool: &PgPool) -> Result<(), StoreError> {
    for statement in [
        r#"CREATE TABLE IF NOT EXISTS agent_provider_binding_scopes (
            agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
            revision BIGINT NOT NULL CHECK(revision >= 1),
            mode TEXT NOT NULL DEFAULT 'restricted' CHECK(mode IN ('inherit', 'restricted')),
            excluded_accounts_json TEXT NOT NULL DEFAULT '[]',
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

pub(super) async fn migrate_policy_modes(pool: &PgPool) -> Result<(), StoreError> {
    for statement in [
        "ALTER TABLE agent_provider_binding_scopes ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'restricted' CHECK(mode IN ('inherit', 'restricted'))",
        "ALTER TABLE agent_provider_binding_scopes ADD COLUMN IF NOT EXISTS excluded_accounts_json TEXT NOT NULL DEFAULT '[]'",
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
    let rows = sqlx::query(
        "SELECT s.*, b.account_id, b.bound_at FROM agent_provider_binding_scopes s LEFT JOIN agent_provider_bindings b ON b.agent_id = s.agent_id WHERE s.agent_id = $1 ORDER BY b.account_id",
    )
    .bind(agent_id)
    .fetch_all(pool)
    .await?;
    let Some(scope) = rows.first() else {
        return Ok(None);
    };
    Ok(Some(AgentProviderBindingSet {
        agent_id: scope.get("agent_id"),
        revision: u64::try_from(scope.get::<i64, _>("revision"))?,
        mode: AgentProviderPolicyMode::parse(&scope.get::<String, _>("mode"))?,
        excluded_accounts: serde_json::from_str(&scope.get::<String, _>("excluded_accounts_json"))?,
        bindings: rows
            .iter()
            .filter(|row| row.get::<Option<String>, _>("account_id").is_some())
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
    async fn initialize_agent_provider_policy(
        &self,
        agent_id: &str,
        mode: AgentProviderPolicyMode,
        account_ids: &[String],
    ) -> Result<AgentProviderBindingSet, StoreError> {
        let agent_id = agent_id.trim();
        if agent_id.is_empty() {
            return Err("Agent ID cannot be empty".into());
        }
        let account_ids = normalized_account_ids(account_ids)?;
        if mode == AgentProviderPolicyMode::Inherit && !account_ids.is_empty() {
            return Err("Inherited Provider policy cannot contain explicit accounts".into());
        }
        let now = now_text();
        let mut tx = self.pool.begin().await?;
        let inserted = sqlx::query(
            r#"INSERT INTO agent_provider_binding_scopes
               (agent_id, revision, mode, created_at, updated_at) VALUES ($1, 1, $2, $3, $3)
               ON CONFLICT(agent_id) DO NOTHING"#,
        )
        .bind(agent_id)
        .bind(mode.as_str())
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

    async fn set_agent_provider_policy(
        &self,
        agent_id: &str,
        mode: AgentProviderPolicyMode,
        account_ids: &[String],
        expected_revision: Option<u64>,
    ) -> Result<AgentProviderBindingSet, StoreError> {
        let account_ids = normalized_account_ids(account_ids)?;
        if mode == AgentProviderPolicyMode::Inherit && !account_ids.is_empty() {
            return Err("Inherited Provider policy cannot contain explicit accounts".into());
        }
        let mut tx = self.pool.begin().await?;
        let scope = sqlx::query("SELECT revision, mode, excluded_accounts_json FROM agent_provider_binding_scopes WHERE agent_id = $1 FOR UPDATE")
            .bind(agent_id).fetch_optional(&mut *tx).await?
            .ok_or("Agent Provider policy is not initialized")?;
        let revision = u64::try_from(scope.get::<i64, _>("revision"))?;
        if expected_revision.is_some_and(|expected| expected != revision) {
            return Err(crate::memory::AgentProviderPolicyRevisionConflict {
                current_revision: revision,
            }
            .into());
        }
        let old_accounts = sqlx::query_scalar::<_, String>("SELECT account_id FROM agent_provider_bindings WHERE agent_id = $1 ORDER BY account_id")
            .bind(agent_id).fetch_all(&mut *tx).await?;
        let exclusions: Vec<String> =
            serde_json::from_str(&scope.get::<String, _>("excluded_accounts_json"))?;
        if scope.get::<String, _>("mode") != mode.as_str()
            || old_accounts != account_ids
            || !exclusions.is_empty()
        {
            let now = now_text();
            sqlx::query("DELETE FROM agent_provider_bindings WHERE agent_id = $1")
                .bind(agent_id)
                .execute(&mut *tx)
                .await?;
            for account_id in account_ids {
                sqlx::query("INSERT INTO agent_provider_bindings (agent_id, account_id, bound_at) VALUES ($1, $2, $3)")
                    .bind(agent_id).bind(account_id).bind(&now).execute(&mut *tx).await?;
            }
            sqlx::query("UPDATE agent_provider_binding_scopes SET mode = $1, excluded_accounts_json = '[]', revision = revision + 1, updated_at = $2 WHERE agent_id = $3")
                .bind(mode.as_str()).bind(&now).bind(agent_id).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        load_binding_set(&self.pool, agent_id)
            .await?
            .ok_or_else(|| "Agent Provider policy was not persisted".into())
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
        let scope = sqlx::query("SELECT mode, excluded_accounts_json FROM agent_provider_binding_scopes WHERE agent_id = $1 FOR UPDATE")
            .bind(agent_id).fetch_one(&mut *tx).await?;
        let binding_inserted = if scope.get::<String, _>("mode") == "inherit" {
            let mut exclusions: BTreeSet<String> =
                serde_json::from_str(&scope.get::<String, _>("excluded_accounts_json"))?;
            let changed = exclusions.remove(account_id);
            if changed {
                sqlx::query("UPDATE agent_provider_binding_scopes SET excluded_accounts_json = $1 WHERE agent_id = $2")
                    .bind(serde_json::to_string(&exclusions)?).bind(agent_id).execute(&mut *tx).await?;
            }
            changed
        } else {
            sqlx::query(
                r#"INSERT INTO agent_provider_bindings (agent_id, account_id, bound_at)
               VALUES ($1, $2, $3) ON CONFLICT(agent_id, account_id) DO NOTHING"#,
            )
            .bind(agent_id)
            .bind(account_id)
            .bind(&now)
            .execute(&mut *tx)
            .await?
            .rows_affected()
                == 1
        };
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
        let scope = sqlx::query("SELECT mode, excluded_accounts_json FROM agent_provider_binding_scopes WHERE agent_id = $1 FOR UPDATE")
            .bind(agent_id).fetch_one(&mut *tx).await?;
        let deleted = if scope.get::<String, _>("mode") == "inherit" {
            let mut exclusions: BTreeSet<String> =
                serde_json::from_str(&scope.get::<String, _>("excluded_accounts_json"))?;
            let changed = exclusions.insert(account_id.to_string());
            if changed {
                sqlx::query("UPDATE agent_provider_binding_scopes SET excluded_accounts_json = $1 WHERE agent_id = $2")
                    .bind(serde_json::to_string(&exclusions)?).bind(agent_id).execute(&mut *tx).await?;
            }
            changed
        } else {
            sqlx::query(
                "DELETE FROM agent_provider_bindings WHERE agent_id = $1 AND account_id = $2",
            )
            .bind(agent_id)
            .bind(account_id)
            .execute(&mut *tx)
            .await?
            .rows_affected()
                == 1
        };
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
