use super::{
    append_direct_thread_signal_in_tx, append_event_in_tx, now_text, parse_time,
    thread::ensure_thread_in_tx, PostgresStore, StoreError,
};
use crate::event::Event;
use crate::memory::{
    stable_thread_id, DelegationFilter, DelegationRecord, DelegationStatus, DelegationStore,
    NewCognitiveContext, NewDelegation, NewSession, NewThread, SessionDirectoryStore, ThreadKind,
    ThreadSupervision,
};
use serde_json::Value as JsonValue;
use sqlx::postgres::{PgRow, Postgres};
use sqlx::{PgPool, QueryBuilder, Row};

const COLUMNS: &str = "id, agent_id, parent_context_id, parent_session_id, child_context_id, \
child_session_id, initiating_principal_id, task, success_when, context_scope, status, \
result_event_id, created_at, updated_at";

pub(super) async fn migrate(pool: &PgPool) -> Result<(), StoreError> {
    for statement in [
        r#"CREATE TABLE IF NOT EXISTS delegations (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL REFERENCES agents(id),
            parent_context_id TEXT NOT NULL REFERENCES cognitive_contexts(id),
            parent_session_id TEXT NOT NULL REFERENCES sessions(id),
            child_context_id TEXT NOT NULL REFERENCES cognitive_contexts(id),
            child_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
            initiating_principal_id TEXT,
            task TEXT NOT NULL,
            success_when TEXT,
            context_scope TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN (
                'queued', 'running', 'completed', 'failed', 'cancelled'
            )),
            result_event_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_delegations_parent
           ON delegations(parent_session_id, updated_at DESC)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_delegations_status
           ON delegations(status, updated_at, id)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_delegations_parent_context_updated
           ON delegations(parent_context_id, updated_at DESC, id)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_delegations_child_context_updated
           ON delegations(child_context_id, updated_at DESC, id)"#,
        r#"ALTER TABLE delegations
           ADD COLUMN IF NOT EXISTS initiating_principal_id TEXT"#,
    ] {
        sqlx::query(statement).execute(pool).await?;
    }
    Ok(())
}

fn parse_status(value: &str) -> Result<DelegationStatus, StoreError> {
    match value {
        "queued" => Ok(DelegationStatus::Queued),
        "running" => Ok(DelegationStatus::Running),
        "completed" => Ok(DelegationStatus::Completed),
        "failed" => Ok(DelegationStatus::Failed),
        "cancelled" => Ok(DelegationStatus::Cancelled),
        other => Err(format!("未知 Delegation status：'{other}'").into()),
    }
}

fn delegation_from_row(row: &PgRow) -> Result<DelegationRecord, StoreError> {
    Ok(DelegationRecord {
        id: row.get("id"),
        agent_id: row.get("agent_id"),
        parent_context_id: row.get("parent_context_id"),
        parent_session_id: row.get("parent_session_id"),
        child_context_id: row.get("child_context_id"),
        child_session_id: row.get("child_session_id"),
        initiating_principal_id: row.get("initiating_principal_id"),
        task: row.get("task"),
        success_when: row.get("success_when"),
        context_scope: row.get("context_scope"),
        status: parse_status(&row.get::<String, _>("status"))?,
        result_event_id: row.get("result_event_id"),
        created_at: parse_time(&row.get::<String, _>("created_at"))?,
        updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
    })
}

#[async_trait::async_trait]
impl DelegationStore for PostgresStore {
    async fn create_delegation_scaffold(
        &self,
        context: NewCognitiveContext,
        session: NewSession,
        delegation: NewDelegation,
    ) -> Result<DelegationRecord, StoreError> {
        if context.id != session.context_id
            || context.id != delegation.child_context_id
            || session.id != delegation.child_session_id
            || context.agent_id != session.agent_id
            || context.agent_id != delegation.agent_id
            || session.parent_session_id.is_some()
        {
            return Err("Delegation scaffold 的 Context/Session/Agent 路由不一致".into());
        }
        let now = now_text();
        let mut tx = self.pool.begin().await?;
        let parent = sqlx::query("SELECT agent_id, context_id FROM sessions WHERE id = $1")
            .bind(&delegation.parent_session_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| format!("父 Session '{}' 不存在", delegation.parent_session_id))?;
        if parent.get::<String, _>("context_id") != delegation.parent_context_id
            || parent.get::<String, _>("agent_id") != delegation.agent_id
        {
            return Err("Delegation scaffold 的父 Session 路由不一致".into());
        }
        sqlx::query(
            "INSERT INTO cognitive_contexts \
             (id, agent_id, title, status, created_at, updated_at) \
             VALUES ($1, $2, $3, 'active', $4, $4)",
        )
        .bind(&context.id)
        .bind(&context.agent_id)
        .bind(&context.title)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO sessions \
             (id, agent_id, context_id, parent_session_id, title, status, created_at, updated_at, \
              last_activity_at, attention_state, attention_revision, mount_kind) \
             VALUES ($1, $2, $3, NULL, $4, 'active', $5, $5, $5, 'active', 0, $6)",
        )
        .bind(&session.id)
        .bind(&session.agent_id)
        .bind(&session.context_id)
        .bind(&session.title)
        .bind(&now)
        .bind(session.mount_kind.as_str())
        .execute(&mut *tx)
        .await?;
        let row = sqlx::query(&format!(
            r#"INSERT INTO delegations
               (id, agent_id, parent_context_id, parent_session_id,
                child_context_id, child_session_id, initiating_principal_id, task, success_when,
                context_scope, status, result_event_id, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'queued', NULL, $11, $11)
               RETURNING {COLUMNS}"#
        ))
        .bind(&delegation.id)
        .bind(&delegation.agent_id)
        .bind(&delegation.parent_context_id)
        .bind(&delegation.parent_session_id)
        .bind(&delegation.child_context_id)
        .bind(&delegation.child_session_id)
        .bind(&delegation.initiating_principal_id)
        .bind(&delegation.task)
        .bind(&delegation.success_when)
        .bind(&delegation.context_scope)
        .bind(&now)
        .fetch_one(&mut *tx)
        .await?;
        let created = delegation_from_row(&row)?;
        tx.commit().await?;
        Ok(created)
    }

    async fn create_delegation(
        &self,
        delegation: NewDelegation,
    ) -> Result<DelegationRecord, StoreError> {
        let parent = self
            .get_session(&delegation.parent_session_id)
            .await?
            .ok_or_else(|| format!("父 Session '{}' 不存在", delegation.parent_session_id))?;
        let child = self
            .get_session(&delegation.child_session_id)
            .await?
            .ok_or_else(|| format!("子 Session '{}' 不存在", delegation.child_session_id))?;
        if parent.context_id != delegation.parent_context_id
            || child.context_id != delegation.child_context_id
            || parent.agent_id != delegation.agent_id
            || child.agent_id != delegation.agent_id
        {
            return Err("Delegation 的 Agent/Context/Session 路由不一致".into());
        }
        let now = now_text();
        let row = sqlx::query(&format!(
            r#"INSERT INTO delegations
               (id, agent_id, parent_context_id, parent_session_id,
                child_context_id, child_session_id, initiating_principal_id, task, success_when,
                context_scope, status, result_event_id, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'queued', NULL, $11, $11)
               RETURNING {COLUMNS}"#
        ))
        .bind(&delegation.id)
        .bind(&delegation.agent_id)
        .bind(&delegation.parent_context_id)
        .bind(&delegation.parent_session_id)
        .bind(&delegation.child_context_id)
        .bind(&delegation.child_session_id)
        .bind(&delegation.initiating_principal_id)
        .bind(&delegation.task)
        .bind(&delegation.success_when)
        .bind(&delegation.context_scope)
        .bind(now)
        .fetch_one(&self.pool)
        .await?;
        delegation_from_row(&row)
    }

    async fn get_delegation(&self, id: &str) -> Result<Option<DelegationRecord>, StoreError> {
        sqlx::query(&format!("SELECT {COLUMNS} FROM delegations WHERE id = $1"))
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(delegation_from_row)
            .transpose()
    }

    async fn get_delegation_by_child_session(
        &self,
        child_session_id: &str,
    ) -> Result<Option<DelegationRecord>, StoreError> {
        sqlx::query(&format!(
            "SELECT {COLUMNS} FROM delegations WHERE child_session_id = $1"
        ))
        .bind(child_session_id)
        .fetch_optional(&self.pool)
        .await?
        .as_ref()
        .map(delegation_from_row)
        .transpose()
    }

    async fn list_delegations(
        &self,
        filter: DelegationFilter,
    ) -> Result<Vec<DelegationRecord>, StoreError> {
        let mut query: QueryBuilder<'_, Postgres> =
            QueryBuilder::new(format!("SELECT {COLUMNS} FROM delegations WHERE TRUE"));
        if let Some(value) = filter.agent_id {
            query.push(" AND agent_id = ").push_bind(value);
        }
        if let Some(value) = filter.parent_context_id {
            query.push(" AND parent_context_id = ").push_bind(value);
        }
        if let Some(value) = filter.parent_session_id {
            query.push(" AND parent_session_id = ").push_bind(value);
        }
        if let Some(value) = filter.child_context_id {
            query.push(" AND child_context_id = ").push_bind(value);
        }
        if let Some(value) = filter.child_session_id {
            query.push(" AND child_session_id = ").push_bind(value);
        }
        if let Some(value) = filter.related_context_id {
            query
                .push(" AND (parent_context_id = ")
                .push_bind(value.clone())
                .push(" OR child_context_id = ")
                .push_bind(value)
                .push(")");
        }
        if let Some(value) = filter.related_session_id {
            query
                .push(" AND (parent_session_id = ")
                .push_bind(value.clone())
                .push(" OR child_session_id = ")
                .push_bind(value)
                .push(")");
        }
        if !filter.related_context_ids.is_empty() {
            query.push(" AND (parent_context_id IN (");
            {
                let mut separated = query.separated(", ");
                for context_id in &filter.related_context_ids {
                    separated.push_bind(context_id);
                }
            }
            query.push(") OR child_context_id IN (");
            {
                let mut separated = query.separated(", ");
                for context_id in &filter.related_context_ids {
                    separated.push_bind(context_id);
                }
            }
            query.push("))");
        }
        if !filter.statuses.is_empty() {
            query.push(" AND status IN (");
            let mut separated = query.separated(", ");
            for status in filter.statuses {
                separated.push_bind(status.as_str());
            }
            separated.push_unseparated(")");
        } else if !filter.include_terminal {
            query.push(" AND status IN ('queued', 'running')");
        }
        match (filter.after_updated_at, filter.after_id) {
            (Some(updated_at), Some(id)) => {
                let updated_at = updated_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
                if filter.newest_first {
                    query
                        .push(" AND (updated_at < ")
                        .push_bind(updated_at.clone())
                        .push(" OR (updated_at = ")
                        .push_bind(updated_at)
                        .push(" AND id > ")
                        .push_bind(id)
                        .push("))");
                } else {
                    query
                        .push(" AND (updated_at > ")
                        .push_bind(updated_at.clone())
                        .push(" OR (updated_at = ")
                        .push_bind(updated_at)
                        .push(" AND id > ")
                        .push_bind(id)
                        .push("))");
                }
            }
            (None, None) => {}
            _ => return Err("Delegation keyset cursor 必须同时包含 updated_at 与 id".into()),
        }
        query.push(if filter.newest_first {
            " ORDER BY updated_at DESC, id"
        } else {
            " ORDER BY updated_at, id"
        });
        if let Some(limit) = filter.limit {
            query.push(" LIMIT ").push_bind(i64::try_from(limit)?);
        }
        query
            .build()
            .fetch_all(&self.pool)
            .await?
            .iter()
            .map(delegation_from_row)
            .collect()
    }

    async fn update_delegation_status(
        &self,
        id: &str,
        status: DelegationStatus,
        result_event_id: Option<&str>,
    ) -> Result<Option<DelegationRecord>, StoreError> {
        let row = sqlx::query(&format!(
            r#"UPDATE delegations SET status = $1,
               result_event_id = COALESCE($2, result_event_id), updated_at = $3
               WHERE id = $4 RETURNING {COLUMNS}"#
        ))
        .bind(status.as_str())
        .bind(result_event_id)
        .bind(now_text())
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.as_ref().map(delegation_from_row).transpose()
    }

    async fn commit_delegation_result(&self, id: &str, event: &Event) -> Result<bool, StoreError> {
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(&format!(
            r#"UPDATE delegations SET status = 'completed', result_event_id = $1,
               updated_at = $2
               WHERE id = $3 AND status IN ('queued', 'running')
               RETURNING {COLUMNS}"#
        ))
        .bind(&event.id)
        .bind(now_text())
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(row) = row else {
            let exists = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM delegations WHERE id = $1)",
            )
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
            tx.commit().await?;
            return if exists {
                Ok(false)
            } else {
                Err(format!("Delegation '{id}' 不存在").into())
            };
        };
        let delegation = delegation_from_row(&row)?;
        let event_context_id = event.payload.get("context_id").and_then(JsonValue::as_str);
        let event_session_id = event.payload.get("session_id").and_then(JsonValue::as_str);
        if event_context_id != Some(delegation.parent_context_id.as_str())
            || event_session_id != Some(delegation.parent_session_id.as_str())
        {
            tx.rollback().await?;
            return Err(
                format!("Delegation '{id}' 结果 Event 路由到错误的父 Context/Session").into(),
            );
        }
        if let Some(return_thread_id) = event.payload.get("thread_id").and_then(JsonValue::as_str) {
            let return_root_turn_id = event
                .payload
                .get("root_turn_id")
                .and_then(JsonValue::as_str)
                .ok_or("Attached Delegation 结果 Event 缺少 root_turn_id")?;
            let return_activation_id = event
                .payload
                .get("parent_activation_id")
                .and_then(JsonValue::as_str)
                .ok_or("Attached Delegation 结果 Event 缺少 parent_activation_id")?;
            let thread = sqlx::query(
                "SELECT agent_id, context_id, session_id, root_turn_id, status FROM threads WHERE id = $1 FOR UPDATE",
            )
            .bind(return_thread_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| {
                format!(
                    "Attached Delegation '{id}' return Thread '{return_thread_id}' 不存在"
                )
            })?;
            if thread.get::<String, _>("agent_id") != delegation.agent_id
                || thread.get::<String, _>("context_id") != delegation.parent_context_id
                || thread.get::<String, _>("session_id") != delegation.parent_session_id
                || thread.get::<String, _>("root_turn_id") != return_root_turn_id
            {
                tx.rollback().await?;
                return Err(format!(
                    "Attached Delegation '{id}' 结果 Event 的 return Thread 路由冲突"
                )
                .into());
            }
            let activation = sqlx::query(
                "SELECT context_id, session_id, root_turn_id FROM thread_activations WHERE id = $1 FOR SHARE",
            )
            .bind(return_activation_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| {
                format!(
                    "Attached Delegation '{id}' return Activation '{return_activation_id}' 不存在"
                )
            })?;
            if activation.get::<String, _>("context_id") != delegation.parent_context_id
                || activation.get::<String, _>("session_id") != delegation.parent_session_id
                || activation.get::<String, _>("root_turn_id") != return_root_turn_id
            {
                tx.rollback().await?;
                return Err(format!(
                    "Attached Delegation '{id}' 结果 Event 的 return Activation 路由冲突"
                )
                .into());
            }
            append_event_in_tx(&mut tx, event).await?;
            let thread_status: String = thread.get("status");
            if !matches!(thread_status.as_str(), "completed" | "failed" | "cancelled") {
                append_direct_thread_signal_in_tx(&mut tx, event, return_thread_id).await?;
            }
            tx.commit().await?;
            return Ok(true);
        }
        let thread = ensure_thread_in_tx(
            &mut tx,
            &NewThread {
                id: stable_thread_id(&event.id),
                agent_id: delegation.agent_id.clone(),
                context_id: delegation.parent_context_id.clone(),
                session_id: delegation.parent_session_id.clone(),
                initiating_principal_id: delegation.initiating_principal_id.clone(),
                root_turn_id: event.id.clone(),
                kind: ThreadKind::Execution,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: ThreadSupervision::runtime("delegation-router"),
            },
        )
        .await?;
        append_event_in_tx(&mut tx, event).await?;
        append_direct_thread_signal_in_tx(&mut tx, event, &thread.id).await?;
        tx.commit().await?;
        Ok(true)
    }
}
