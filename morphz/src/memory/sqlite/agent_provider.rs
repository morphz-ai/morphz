use super::{begin_immediate_sqlite_transaction, parse_time, SqliteStore};
use crate::memory::{
    AgentProviderBindingRecord, AgentProviderBindingSet, AgentProviderBindingStore,
};
use chrono::Utc;
use sqlx::{Row, SqlitePool};
use std::collections::BTreeSet;

type StoreError = Box<dyn std::error::Error + Send + Sync>;

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
    pool: &SqlitePool,
    agent_id: &str,
) -> Result<Option<AgentProviderBindingSet>, StoreError> {
    let Some(scope) = sqlx::query(
        "SELECT agent_id, revision, created_at, updated_at FROM agent_provider_binding_scopes WHERE agent_id = ?",
    )
    .bind(agent_id)
    .fetch_optional(pool)
    .await?
    else {
        return Ok(None);
    };
    let rows = sqlx::query(
        "SELECT agent_id, account_id, bound_at FROM agent_provider_bindings WHERE agent_id = ? ORDER BY account_id",
    )
    .bind(agent_id)
    .fetch_all(pool)
    .await?;
    Ok(Some(AgentProviderBindingSet {
        agent_id: scope.get("agent_id"),
        revision: u64::try_from(scope.get::<i64, _>("revision"))?,
        bindings: rows
            .iter()
            .map(|row| AgentProviderBindingRecord {
                agent_id: row.get("agent_id"),
                account_id: row.get("account_id"),
                bound_at: parse_time(&row.get::<String, _>("bound_at")),
            })
            .collect(),
        created_at: parse_time(&scope.get::<String, _>("created_at")),
        updated_at: parse_time(&scope.get::<String, _>("updated_at")),
    }))
}

#[async_trait::async_trait]
impl AgentProviderBindingStore for SqliteStore {
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
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = begin_immediate_sqlite_transaction(&self.pool).await?;
        let inserted = sqlx::query(
            r#"INSERT OR IGNORE INTO agent_provider_binding_scopes
               (agent_id, revision, created_at, updated_at) VALUES (?, 1, ?, ?)"#,
        )
        .bind(agent_id)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?
        .rows_affected()
            == 1;
        if inserted {
            for account_id in account_ids {
                sqlx::query(
                    "INSERT INTO agent_provider_bindings (agent_id, account_id, bound_at) VALUES (?, ?, ?)",
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
        let agent_id =
            sqlx::query_scalar::<_, String>("SELECT agent_id FROM cognitive_contexts WHERE id = ?")
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
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = begin_immediate_sqlite_transaction(&self.pool).await?;
        let scope_inserted = sqlx::query(
            r#"INSERT OR IGNORE INTO agent_provider_binding_scopes
               (agent_id, revision, created_at, updated_at) VALUES (?, 1, ?, ?)"#,
        )
        .bind(agent_id)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?
        .rows_affected()
            == 1;
        let binding_inserted = sqlx::query(
            "INSERT OR IGNORE INTO agent_provider_bindings (agent_id, account_id, bound_at) VALUES (?, ?, ?)",
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
                "UPDATE agent_provider_binding_scopes SET revision = revision + 1, updated_at = ? WHERE agent_id = ?",
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
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = begin_immediate_sqlite_transaction(&self.pool).await?;
        sqlx::query(
            r#"INSERT OR IGNORE INTO agent_provider_binding_scopes
               (agent_id, revision, created_at, updated_at) VALUES (?, 1, ?, ?)"#,
        )
        .bind(agent_id)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        let deleted = sqlx::query(
            "DELETE FROM agent_provider_bindings WHERE agent_id = ? AND account_id = ?",
        )
        .bind(agent_id)
        .bind(account_id)
        .execute(&mut *tx)
        .await?
        .rows_affected()
            == 1;
        if deleted {
            sqlx::query(
                "UPDATE agent_provider_binding_scopes SET revision = revision + 1, updated_at = ? WHERE agent_id = ?",
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
            "SELECT agent_id, account_id, bound_at FROM agent_provider_bindings WHERE account_id = ? ORDER BY agent_id",
        )
        .bind(account_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .iter()
            .map(|row| AgentProviderBindingRecord {
                agent_id: row.get("agent_id"),
                account_id: row.get("account_id"),
                bound_at: parse_time(&row.get::<String, _>("bound_at")),
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::{NewAgent, NewCognitiveContext, SessionDirectoryStore};
    use tempfile::NamedTempFile;

    async fn create_agent(store: &SqliteStore, agent_id: &str, context_id: &str) {
        store
            .ensure_agent(NewAgent {
                id: agent_id.to_string(),
                title: agent_id.to_string(),
                root_context_id: context_id.to_string(),
            })
            .await
            .unwrap();
        store
            .ensure_context(NewCognitiveContext {
                id: context_id.to_string(),
                agent_id: agent_id.to_string(),
                title: context_id.to_string(),
            })
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn provider_accounts_are_reusable_and_empty_policy_is_durable() {
        let database = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(database.path().to_str().unwrap())
            .await
            .unwrap();
        create_agent(&store, "agent-a", "context-a").await;
        create_agent(&store, "agent-b", "context-b").await;
        create_agent(&store, "agent-empty", "context-empty").await;

        let a = store
            .initialize_agent_provider_bindings("agent-a", &["shared".to_string()])
            .await
            .unwrap();
        assert_eq!(a.revision, 1);
        assert_eq!(a.bindings[0].account_id, "shared");
        let b = store
            .initialize_agent_provider_bindings("agent-b", &["shared".to_string()])
            .await
            .unwrap();
        assert_eq!(b.bindings[0].account_id, "shared");

        let reverse = store
            .list_provider_account_agent_bindings("shared")
            .await
            .unwrap();
        assert_eq!(
            reverse
                .iter()
                .map(|binding| binding.agent_id.as_str())
                .collect::<Vec<_>>(),
            vec!["agent-a", "agent-b"]
        );

        let empty = store
            .initialize_agent_provider_bindings("agent-empty", &[])
            .await
            .unwrap();
        assert!(empty.bindings.is_empty());
        let still_empty = store
            .initialize_agent_provider_bindings("agent-empty", &["shared".to_string()])
            .await
            .unwrap();
        assert!(still_empty.bindings.is_empty());

        let changed = store
            .bind_agent_provider_account("agent-a", "second")
            .await
            .unwrap();
        assert_eq!(changed.revision, 2);
        let changed = store
            .unbind_agent_provider_account("agent-a", "shared")
            .await
            .unwrap();
        assert_eq!(changed.revision, 3);
        assert_eq!(changed.bindings[0].account_id, "second");

        let context_policy = store
            .get_context_agent_provider_bindings("context-b")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(context_policy.agent_id, "agent-b");
        assert_eq!(context_policy.bindings[0].account_id, "shared");
    }
}
