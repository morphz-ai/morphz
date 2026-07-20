use super::{
    append_event_in_tx, append_signal_outbox_in_tx, now_text, parse_time, PostgresStore, StoreError,
};
use crate::event::Event;
use crate::memory::{
    DelegationRecord, DelegationStatus, DelegationStore, NewDelegation, SessionDirectoryStore,
};
use serde_json::Value as JsonValue;
use sqlx::postgres::PgRow;
use sqlx::{PgPool, Row};

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

    async fn list_delegations(&self) -> Result<Vec<DelegationRecord>, StoreError> {
        sqlx::query(&format!(
            "SELECT {COLUMNS} FROM delegations ORDER BY updated_at DESC, id"
        ))
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
        append_event_in_tx(&mut tx, event).await?;
        append_signal_outbox_in_tx(&mut tx, event).await?;
        tx.commit().await?;
        Ok(true)
    }
}
