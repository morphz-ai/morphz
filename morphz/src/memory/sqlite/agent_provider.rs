use super::{begin_immediate_sqlite_transaction, parse_time, SqliteStore};
use crate::memory::{
    AgentProviderBindingRecord, AgentProviderBindingSet, AgentProviderBindingStore,
    AgentProviderPolicyMode,
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
    // One statement keeps mode, exclusions and explicit grants in one snapshot.
    let rows = sqlx::query(
        "SELECT s.*, b.account_id, b.bound_at FROM agent_provider_binding_scopes s LEFT JOIN agent_provider_bindings b ON b.agent_id = s.agent_id WHERE s.agent_id = ? ORDER BY b.account_id",
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
            .filter_map(|row| {
                Some(AgentProviderBindingRecord {
                    agent_id: row.get("agent_id"),
                    account_id: row.get::<Option<String>, _>("account_id")?,
                    bound_at: parse_time(&row.get::<String, _>("bound_at")),
                })
            })
            .collect(),
        created_at: parse_time(&scope.get::<String, _>("created_at")),
        updated_at: parse_time(&scope.get::<String, _>("updated_at")),
    }))
}

#[async_trait::async_trait]
impl AgentProviderBindingStore for SqliteStore {
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
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = begin_immediate_sqlite_transaction(&self.pool).await?;
        let inserted = sqlx::query(
            r#"INSERT OR IGNORE INTO agent_provider_binding_scopes
               (agent_id, revision, mode, created_at, updated_at) VALUES (?, 1, ?, ?, ?)"#,
        )
        .bind(agent_id)
        .bind(mode.as_str())
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
        let mut tx = begin_immediate_sqlite_transaction(&self.pool).await?;
        let scope = sqlx::query("SELECT revision, mode, excluded_accounts_json FROM agent_provider_binding_scopes WHERE agent_id = ?")
            .bind(agent_id).fetch_optional(&mut *tx).await?
            .ok_or("Agent Provider policy is not initialized")?;
        let revision = u64::try_from(scope.get::<i64, _>("revision"))?;
        if expected_revision.is_some_and(|expected| expected != revision) {
            return Err(crate::memory::AgentProviderPolicyRevisionConflict {
                current_revision: revision,
            }
            .into());
        }
        let old_accounts = sqlx::query_scalar::<_, String>(
            "SELECT account_id FROM agent_provider_bindings WHERE agent_id = ? ORDER BY account_id",
        )
        .bind(agent_id)
        .fetch_all(&mut *tx)
        .await?;
        let exclusions: Vec<String> =
            serde_json::from_str(&scope.get::<String, _>("excluded_accounts_json"))?;
        if scope.get::<String, _>("mode") != mode.as_str()
            || old_accounts != account_ids
            || !exclusions.is_empty()
        {
            let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
            sqlx::query("DELETE FROM agent_provider_bindings WHERE agent_id = ?")
                .bind(agent_id)
                .execute(&mut *tx)
                .await?;
            for account_id in account_ids {
                sqlx::query("INSERT INTO agent_provider_bindings (agent_id, account_id, bound_at) VALUES (?, ?, ?)")
                    .bind(agent_id).bind(account_id).bind(&now).execute(&mut *tx).await?;
            }
            sqlx::query("UPDATE agent_provider_binding_scopes SET mode = ?, excluded_accounts_json = '[]', revision = revision + 1, updated_at = ? WHERE agent_id = ?")
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
        let scope = sqlx::query("SELECT mode, excluded_accounts_json FROM agent_provider_binding_scopes WHERE agent_id = ?")
            .bind(agent_id).fetch_one(&mut *tx).await?;
        let binding_inserted = if scope.get::<String, _>("mode") == "inherit" {
            let mut exclusions: BTreeSet<String> =
                serde_json::from_str(&scope.get::<String, _>("excluded_accounts_json"))?;
            let changed = exclusions.remove(account_id);
            if changed {
                sqlx::query("UPDATE agent_provider_binding_scopes SET excluded_accounts_json = ? WHERE agent_id = ?")
                    .bind(serde_json::to_string(&exclusions)?).bind(agent_id).execute(&mut *tx).await?;
            }
            changed
        } else {
            sqlx::query(
            "INSERT OR IGNORE INTO agent_provider_bindings (agent_id, account_id, bound_at) VALUES (?, ?, ?)",
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
        let scope = sqlx::query("SELECT mode, excluded_accounts_json FROM agent_provider_binding_scopes WHERE agent_id = ?")
            .bind(agent_id).fetch_one(&mut *tx).await?;
        let deleted = if scope.get::<String, _>("mode") == "inherit" {
            let mut exclusions: BTreeSet<String> =
                serde_json::from_str(&scope.get::<String, _>("excluded_accounts_json"))?;
            let changed = exclusions.insert(account_id.to_string());
            if changed {
                sqlx::query("UPDATE agent_provider_binding_scopes SET excluded_accounts_json = ? WHERE agent_id = ?")
                    .bind(serde_json::to_string(&exclusions)?).bind(agent_id).execute(&mut *tx).await?;
            }
            changed
        } else {
            sqlx::query("DELETE FROM agent_provider_bindings WHERE agent_id = ? AND account_id = ?")
                .bind(agent_id)
                .bind(account_id)
                .execute(&mut *tx)
                .await?
                .rows_affected()
                == 1
        };
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
    use std::sync::Arc;
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
    async fn inherited_provider_policy_exclusions_cas_and_legacy_migration_survive_restart() {
        let database = NamedTempFile::new().unwrap();
        let path = database.path().to_str().unwrap();
        let store = Arc::new(SqliteStore::new(path).await.unwrap());
        create_agent(&store, "inherited", "context-inherited").await;
        create_agent(&store, "legacy", "context-legacy").await;
        let policy = store
            .initialize_agent_provider_policy("inherited", AgentProviderPolicyMode::Inherit, &[])
            .await
            .unwrap();
        assert_eq!(policy.revision, 1);
        assert_eq!(
            store
                .bind_agent_provider_account("inherited", "account-a")
                .await
                .unwrap()
                .revision,
            1
        );
        let (a, b) = tokio::join!(
            store.unbind_agent_provider_account("inherited", "account-a"),
            store.unbind_agent_provider_account("inherited", "account-b"),
        );
        a.unwrap();
        b.unwrap();
        let excluded = store
            .get_agent_provider_bindings("inherited")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(excluded.revision, 3);
        assert_eq!(excluded.excluded_accounts, vec!["account-a", "account-b"]);
        assert_eq!(
            store
                .unbind_agent_provider_account("inherited", "account-a")
                .await
                .unwrap()
                .revision,
            3
        );
        assert!(store
            .set_agent_provider_policy(
                "inherited",
                AgentProviderPolicyMode::Restricted,
                &[],
                Some(1)
            )
            .await
            .unwrap_err()
            .downcast_ref::<crate::memory::AgentProviderPolicyRevisionConflict>()
            .is_some());
        assert_eq!(
            store
                .get_agent_provider_bindings("inherited")
                .await
                .unwrap()
                .unwrap(),
            excluded
        );
        store.pool.close().await;
        drop(store);
        let store = SqliteStore::new(path).await.unwrap();
        assert_eq!(
            store
                .get_agent_provider_bindings("inherited")
                .await
                .unwrap()
                .unwrap(),
            excluded
        );
        let restored = store
            .set_agent_provider_policy("inherited", AgentProviderPolicyMode::Inherit, &[], Some(3))
            .await
            .unwrap();
        assert_eq!(restored.revision, 4);
        assert!(restored.excluded_accounts.is_empty());
        assert_eq!(
            store
                .set_agent_provider_policy(
                    "inherited",
                    AgentProviderPolicyMode::Inherit,
                    &[],
                    Some(4)
                )
                .await
                .unwrap(),
            restored
        );
        assert!(store
            .initialize_agent_provider_policy(
                "legacy",
                AgentProviderPolicyMode::Inherit,
                &["invalid".into()]
            )
            .await
            .is_err());
        let legacy = store
            .initialize_agent_provider_bindings("legacy", &["shared".into()])
            .await
            .unwrap();
        // Simulate the pre-policy-mode table shape, preserving the old grants.
        sqlx::query("ALTER TABLE agent_provider_binding_scopes DROP COLUMN mode")
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("ALTER TABLE agent_provider_binding_scopes DROP COLUMN excluded_accounts_json")
            .execute(&store.pool)
            .await
            .unwrap();
        store.pool.close().await;
        let reopened = SqliteStore::new(path).await.unwrap();
        assert_eq!(
            reopened
                .get_agent_provider_bindings("legacy")
                .await
                .unwrap()
                .unwrap(),
            legacy
        );
        // An old empty row stays deny-all, rather than being guessed as inherit.
        assert_eq!(
            reopened
                .initialize_agent_provider_policy(
                    "inherited",
                    AgentProviderPolicyMode::Inherit,
                    &[]
                )
                .await
                .unwrap()
                .mode,
            AgentProviderPolicyMode::Restricted
        );
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
