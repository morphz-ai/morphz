use super::{now_text, parse_time, PostgresStore, StoreError};
use crate::memory::{
    AgentBootstrapRecord, AgentRecord, CognitiveContextRecord, ContextSessionCount,
    ContextTokenBudgetMutation, ContextUpdate, NewAgent, NewCognitiveContext, NewPrincipal,
    NewSession, PrincipalDirectoryEntry, PrincipalDirectoryPage, PrincipalRecord,
    SessionAttentionState, SessionAttentionUpdate, SessionDirectoryStore, SessionMountKind,
    SessionPrincipalBinding, SessionRecord, SessionStatus, SessionUpdate,
};
use chrono::{DateTime, Utc};
use sqlx::postgres::PgRow;
use sqlx::Row;

const AGENT_COLUMNS: &str = "id, title, status, root_context_id, created_at, updated_at";
const CONTEXT_COLUMNS: &str = "id, agent_id, title, status, created_at, updated_at, \
seed_context_id, seed_context_version, seed_snapshot_hash, seed_projection, \
requested_hard_token_limit, token_budget_revision";
const SESSION_COLUMNS: &str = "id, agent_id, context_id, parent_session_id, title, status, \
created_at, updated_at, last_activity_at, attention_state, attention_revision, \
attention_reason, attention_changed_at, attention_event_id";

fn parse_status(value: &str) -> Result<SessionStatus, StoreError> {
    match value {
        "active" => Ok(SessionStatus::Active),
        "archived" => Ok(SessionStatus::Archived),
        other => Err(format!("未知 Session 状态: {other}").into()),
    }
}

fn parse_attention(value: &str) -> Result<SessionAttentionState, StoreError> {
    match value {
        "active" => Ok(SessionAttentionState::Active),
        "retired" => Ok(SessionAttentionState::Retired),
        other => Err(format!("未知 Session attention 状态: {other}").into()),
    }
}

fn agent_from_row(row: &PgRow) -> Result<AgentRecord, StoreError> {
    Ok(AgentRecord {
        id: row.get("id"),
        title: row.get("title"),
        status: parse_status(&row.get::<String, _>("status"))?,
        root_context_id: row.get("root_context_id"),
        created_at: parse_time(&row.get::<String, _>("created_at"))?,
        updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
    })
}

fn context_from_row(row: &PgRow) -> Result<CognitiveContextRecord, StoreError> {
    Ok(CognitiveContextRecord {
        id: row.get("id"),
        agent_id: row.get("agent_id"),
        title: row.get("title"),
        status: parse_status(&row.get::<String, _>("status"))?,
        created_at: parse_time(&row.get::<String, _>("created_at"))?,
        updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
        seed_context_id: row.get("seed_context_id"),
        seed_context_version: row
            .get::<Option<i64>, _>("seed_context_version")
            .map(u64::try_from)
            .transpose()?,
        seed_snapshot_hash: row.get("seed_snapshot_hash"),
        seed_projection: row.get("seed_projection"),
        requested_hard_token_limit: row
            .get::<Option<i64>, _>("requested_hard_token_limit")
            .map(u64::try_from)
            .transpose()?,
        token_budget_revision: u64::try_from(row.get::<i64, _>("token_budget_revision"))?,
    })
}

fn session_from_row(row: &PgRow) -> Result<SessionRecord, StoreError> {
    Ok(SessionRecord {
        id: row.get("id"),
        agent_id: row.get("agent_id"),
        context_id: row.get("context_id"),
        parent_session_id: row.get("parent_session_id"),
        title: row.get("title"),
        status: parse_status(&row.get::<String, _>("status"))?,
        created_at: parse_time(&row.get::<String, _>("created_at"))?,
        updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
        last_activity_at: parse_time(&row.get::<String, _>("last_activity_at"))?,
        attention_state: parse_attention(&row.get::<String, _>("attention_state"))?,
        attention_revision: u64::try_from(row.get::<i64, _>("attention_revision"))?,
        attention_reason: row.get("attention_reason"),
        attention_changed_at: row
            .get::<Option<String>, _>("attention_changed_at")
            .as_deref()
            .map(parse_time)
            .transpose()?,
        attention_event_id: row.get("attention_event_id"),
    })
}

fn principal_from_row(row: &PgRow) -> Result<PrincipalRecord, StoreError> {
    Ok(PrincipalRecord {
        id: row.get("id"),
        provider_id: row.get("provider_id"),
        assurance: row.get("assurance"),
        display_name: row.get("display_name"),
        created_at: parse_time(&row.get::<String, _>("created_at"))?,
        updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
    })
}

fn binding_from_row(row: &PgRow) -> Result<SessionPrincipalBinding, StoreError> {
    Ok(SessionPrincipalBinding {
        session_id: row.get("session_id"),
        principal_id: row.get("principal_id"),
        bound_at: parse_time(&row.get::<String, _>("bound_at"))?,
        unbound_at: row
            .get::<Option<String>, _>("unbound_at")
            .as_deref()
            .map(parse_time)
            .transpose()?,
    })
}

#[async_trait::async_trait]
impl SessionDirectoryStore for PostgresStore {
    async fn ensure_principal(
        &self,
        principal: NewPrincipal,
    ) -> Result<PrincipalRecord, StoreError> {
        if principal.id.trim().is_empty()
            || principal.provider_id.trim().is_empty()
            || principal.assurance.trim().is_empty()
        {
            return Err("Principal id/provider_id/assurance 不能为空".into());
        }
        let now = now_text();
        sqlx::query(
            r#"INSERT INTO principals
               (id, provider_id, assurance, display_name, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $5)
               ON CONFLICT(id) DO UPDATE SET
                 assurance = EXCLUDED.assurance,
                 display_name = COALESCE(EXCLUDED.display_name, principals.display_name),
                 updated_at = EXCLUDED.updated_at
               WHERE principals.provider_id = EXCLUDED.provider_id"#,
        )
        .bind(&principal.id)
        .bind(&principal.provider_id)
        .bind(&principal.assurance)
        .bind(&principal.display_name)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        let existing = self
            .get_principal(&principal.id)
            .await?
            .ok_or("Principal ensure 后无法读取")?;
        if existing.provider_id != principal.provider_id {
            return Err(format!(
                "Principal '{}' 已由 Provider '{}' 管理，不能改由 '{}' 接管",
                principal.id, existing.provider_id, principal.provider_id
            )
            .into());
        }
        Ok(existing)
    }

    async fn get_principal(&self, id: &str) -> Result<Option<PrincipalRecord>, StoreError> {
        let row = sqlx::query(
            "SELECT id, provider_id, assurance, display_name, created_at, updated_at FROM principals WHERE id = $1",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.as_ref().map(principal_from_row).transpose()
    }

    async fn search_principals(
        &self,
        query: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<PrincipalDirectoryPage, StoreError> {
        let normalized = query.trim().to_lowercase();
        let escaped = normalized
            .replace('\\', r"\\")
            .replace('%', r"\%")
            .replace('_', r"\_");
        let prefix = format!("{escaped}%");
        let fetch_limit = limit.clamp(1, 100).saturating_add(1);
        let rows = sqlx::query(
            r#"WITH matched AS (
                 SELECT id, provider_id, assurance, display_name, created_at, updated_at
                 FROM principals
                 WHERE ($1 = ''
                    OR lower(id) LIKE $2 ESCAPE '\'
                    OR lower(COALESCE(display_name, '')) LIKE $2 ESCAPE '\'
                    OR lower(provider_id) LIKE $2 ESCAPE '\')
                   AND ($3::text IS NULL OR id > $3)
                 ORDER BY id
                 LIMIT $4
               )
               SELECT m.id, m.provider_id, m.assurance, m.display_name,
                      m.created_at, m.updated_at,
                      COUNT(DISTINCT b.session_id)::BIGINT AS session_count,
                      COUNT(DISTINCT CASE WHEN s.status = 'active' THEN b.session_id END)::BIGINT
                        AS active_session_count,
                      COUNT(DISTINCT s.context_id)::BIGINT AS context_count,
                      MAX(s.last_activity_at) AS last_activity_at
               FROM matched m
               LEFT JOIN session_principal_bindings b
                 ON b.principal_id = m.id AND b.unbound_at IS NULL
               LEFT JOIN sessions s ON s.id = b.session_id
               GROUP BY m.id, m.provider_id, m.assurance, m.display_name,
                        m.created_at, m.updated_at
               ORDER BY m.id"#,
        )
        .bind(&normalized)
        .bind(&prefix)
        .bind(cursor)
        .bind(i64::try_from(fetch_limit)?)
        .fetch_all(&self.pool)
        .await?;
        let page_limit = fetch_limit.saturating_sub(1);
        let has_more = rows.len() > page_limit;
        let entries = rows
            .iter()
            .take(page_limit)
            .map(|row| {
                Ok(PrincipalDirectoryEntry {
                    principal: principal_from_row(row)?,
                    session_count: u64::try_from(row.get::<i64, _>("session_count"))?,
                    active_session_count: u64::try_from(row.get::<i64, _>("active_session_count"))?,
                    context_count: u64::try_from(row.get::<i64, _>("context_count"))?,
                    last_activity_at: row
                        .get::<Option<String>, _>("last_activity_at")
                        .as_deref()
                        .map(parse_time)
                        .transpose()?,
                })
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
        let next_cursor = has_more
            .then(|| entries.last().map(|entry| entry.principal.id.clone()))
            .flatten();
        Ok(PrincipalDirectoryPage {
            entries,
            next_cursor,
        })
    }

    async fn bind_session_principal(
        &self,
        session_id: &str,
        principal_id: &str,
    ) -> Result<SessionPrincipalBinding, StoreError> {
        let now = now_text();
        let row = sqlx::query(
            r#"INSERT INTO session_principal_bindings
               (session_id, principal_id, bound_at, unbound_at)
               VALUES ($1, $2, $3, NULL)
               ON CONFLICT(session_id, principal_id) DO UPDATE SET unbound_at = NULL
               RETURNING session_id, principal_id, bound_at, unbound_at"#,
        )
        .bind(session_id)
        .bind(principal_id)
        .bind(&now)
        .fetch_one(&self.pool)
        .await?;
        binding_from_row(&row)
    }

    async fn bind_all_sessions_to_principal(
        &self,
        principal_id: &str,
        include_archived: bool,
    ) -> Result<usize, StoreError> {
        let now = now_text();
        let result = sqlx::query(
            r#"INSERT INTO session_principal_bindings
               (session_id, principal_id, bound_at, unbound_at)
               SELECT id, $1, $2, NULL FROM sessions
               WHERE ($3 OR status != 'archived')
               ON CONFLICT(session_id, principal_id) DO UPDATE SET unbound_at = NULL
               WHERE session_principal_bindings.unbound_at IS NOT NULL"#,
        )
        .bind(principal_id)
        .bind(&now)
        .bind(include_archived)
        .execute(&self.pool)
        .await?;
        usize::try_from(result.rows_affected())
            .map_err(|_| "Session Principal 批量绑定数超出 usize".into())
    }

    async fn list_session_principals(
        &self,
        session_id: &str,
    ) -> Result<Vec<SessionPrincipalBinding>, StoreError> {
        let rows = sqlx::query(
            "SELECT session_id, principal_id, bound_at, unbound_at FROM session_principal_bindings WHERE session_id = $1 AND unbound_at IS NULL ORDER BY principal_id",
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(binding_from_row).collect()
    }

    async fn list_principal_sessions(
        &self,
        principal_id: &str,
        include_archived: bool,
    ) -> Result<Vec<SessionRecord>, StoreError> {
        let rows = sqlx::query(
            r#"SELECT s.id, s.agent_id, s.context_id, s.parent_session_id, s.title,
                      s.status, s.created_at, s.updated_at, s.last_activity_at,
                      s.attention_state, s.attention_revision, s.attention_reason,
                      s.attention_changed_at, s.attention_event_id, s.mount_kind
               FROM sessions s
               JOIN session_principal_bindings b ON b.session_id = s.id
               WHERE b.principal_id = $1 AND b.unbound_at IS NULL
                 AND ($2 OR s.status != 'archived')
               ORDER BY s.last_activity_at DESC, s.id"#,
        )
        .bind(principal_id)
        .bind(include_archived)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(session_from_row).collect()
    }

    async fn list_context_principal_bindings(
        &self,
        context_id: &str,
    ) -> Result<Vec<SessionPrincipalBinding>, StoreError> {
        let rows = sqlx::query(
            r#"SELECT b.session_id, b.principal_id, b.bound_at, b.unbound_at
               FROM session_principal_bindings b
               JOIN sessions s ON s.id = b.session_id
               WHERE s.context_id = $1 AND b.unbound_at IS NULL
               ORDER BY b.session_id, b.principal_id"#,
        )
        .bind(context_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(binding_from_row).collect()
    }

    async fn list_session_principal_bindings_bounded(
        &self,
        session_ids: &[String],
    ) -> Result<Vec<SessionPrincipalBinding>, StoreError> {
        if session_ids.is_empty() {
            return Ok(Vec::new());
        }
        let rows = sqlx::query(
            r#"SELECT session_id, principal_id, bound_at, unbound_at
               FROM session_principal_bindings
               WHERE unbound_at IS NULL AND session_id = ANY($1)
               ORDER BY session_id, principal_id"#,
        )
        .bind(session_ids)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(binding_from_row).collect()
    }

    async fn verify_session_principal(
        &self,
        session_id: &str,
        principal_id: &str,
    ) -> Result<bool, StoreError> {
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM session_principal_bindings WHERE session_id = $1 AND principal_id = $2 AND unbound_at IS NULL)",
        )
        .bind(session_id)
        .bind(principal_id)
        .fetch_one(&self.pool)
        .await
        .map_err(Into::into)
    }

    async fn create_agent_bundle(
        &self,
        agent: NewAgent,
        root_context: NewCognitiveContext,
        initial_session: NewSession,
    ) -> Result<AgentBootstrapRecord, StoreError> {
        if agent.id != root_context.agent_id
            || agent.id != initial_session.agent_id
            || agent.root_context_id != root_context.id
            || root_context.id != initial_session.context_id
            || initial_session.parent_session_id.is_some()
            || initial_session.mount_kind != SessionMountKind::NewBlankContext
        {
            return Err("Agent Bootstrap 的 Agent/Root Context/Initial Session 路由不一致".into());
        }
        let now = now_text();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            r#"INSERT INTO agents
               (id, title, status, root_context_id, created_at, updated_at)
               VALUES ($1, $2, 'active', $3, $4, $4)"#,
        )
        .bind(&agent.id)
        .bind(&agent.title)
        .bind(&agent.root_context_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            r#"INSERT INTO cognitive_contexts
               (id, agent_id, title, status, created_at, updated_at)
               VALUES ($1, $2, $3, 'active', $4, $4)"#,
        )
        .bind(&root_context.id)
        .bind(&root_context.agent_id)
        .bind(&root_context.title)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            r#"INSERT INTO sessions
               (id, agent_id, context_id, parent_session_id, title, status,
                created_at, updated_at, last_activity_at, attention_state,
                attention_revision, mount_kind)
               VALUES ($1, $2, $3, NULL, $4, 'active', $5, $5, $5,
                       'active', 0, 'new_blank_context')"#,
        )
        .bind(&initial_session.id)
        .bind(&initial_session.agent_id)
        .bind(&initial_session.context_id)
        .bind(&initial_session.title)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;

        Ok(AgentBootstrapRecord {
            agent: self
                .get_agent(&agent.id)
                .await?
                .ok_or("Agent Bootstrap 提交后无法读取 Agent")?,
            root_context: self
                .get_context(&root_context.id)
                .await?
                .ok_or("Agent Bootstrap 提交后无法读取 Root Context")?,
            initial_session: self
                .get_session(&initial_session.id)
                .await?
                .ok_or("Agent Bootstrap 提交后无法读取 Initial Session")?,
        })
    }

    async fn create_agent(&self, agent: NewAgent) -> Result<AgentRecord, StoreError> {
        let now = now_text();
        let row = sqlx::query(&format!(
            "INSERT INTO agents (id, title, status, root_context_id, created_at, updated_at) \
             VALUES ($1, $2, 'active', $3, $4, $4) RETURNING {AGENT_COLUMNS}"
        ))
        .bind(&agent.id)
        .bind(&agent.title)
        .bind(&agent.root_context_id)
        .bind(now)
        .fetch_one(&self.pool)
        .await?;
        agent_from_row(&row)
    }

    async fn ensure_agent(&self, agent: NewAgent) -> Result<AgentRecord, StoreError> {
        let now = now_text();
        sqlx::query(
            r#"INSERT INTO agents
               (id, title, status, root_context_id, created_at, updated_at)
               VALUES ($1, $2, 'active', $3, $4, $4)
               ON CONFLICT (id) DO NOTHING"#,
        )
        .bind(&agent.id)
        .bind(&agent.title)
        .bind(&agent.root_context_id)
        .bind(now)
        .execute(&self.pool)
        .await?;
        let existing = self
            .get_agent(&agent.id)
            .await?
            .ok_or("并发创建 Agent 失败")?;
        if existing.root_context_id != agent.root_context_id {
            return Err(format!(
                "Agent '{}' 的 Root Context 已是 '{}'，不能改为 '{}'",
                agent.id, existing.root_context_id, agent.root_context_id
            )
            .into());
        }
        Ok(existing)
    }

    async fn get_agent(&self, id: &str) -> Result<Option<AgentRecord>, StoreError> {
        sqlx::query(&format!("SELECT {AGENT_COLUMNS} FROM agents WHERE id = $1"))
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(agent_from_row)
            .transpose()
    }

    async fn list_agents(&self, include_archived: bool) -> Result<Vec<AgentRecord>, StoreError> {
        let sql = if include_archived {
            format!("SELECT {AGENT_COLUMNS} FROM agents ORDER BY updated_at DESC, id ASC")
        } else {
            format!(
                "SELECT {AGENT_COLUMNS} FROM agents WHERE status = 'active' \
                 ORDER BY updated_at DESC, id ASC"
            )
        };
        sqlx::query(&sql)
            .fetch_all(&self.pool)
            .await?
            .iter()
            .map(agent_from_row)
            .collect()
    }

    async fn create_context(
        &self,
        context: NewCognitiveContext,
    ) -> Result<CognitiveContextRecord, StoreError> {
        let now = now_text();
        let row = sqlx::query(&format!(
            "INSERT INTO cognitive_contexts \
             (id, agent_id, title, status, created_at, updated_at) \
             VALUES ($1, $2, $3, 'active', $4, $4) RETURNING {CONTEXT_COLUMNS}"
        ))
        .bind(&context.id)
        .bind(&context.agent_id)
        .bind(&context.title)
        .bind(now)
        .fetch_one(&self.pool)
        .await?;
        context_from_row(&row)
    }

    async fn ensure_context(
        &self,
        context: NewCognitiveContext,
    ) -> Result<CognitiveContextRecord, StoreError> {
        let now = now_text();
        sqlx::query(
            r#"INSERT INTO cognitive_contexts
               (id, agent_id, title, status, created_at, updated_at)
               VALUES ($1, $2, $3, 'active', $4, $4)
               ON CONFLICT (id) DO NOTHING"#,
        )
        .bind(&context.id)
        .bind(&context.agent_id)
        .bind(&context.title)
        .bind(now)
        .execute(&self.pool)
        .await?;
        let existing = self
            .get_context(&context.id)
            .await?
            .ok_or("并发创建 Context 失败")?;
        if existing.agent_id != context.agent_id {
            return Err(format!(
                "Context '{}' 已属于 Agent '{}'，不能重新挂载到 '{}'",
                context.id, existing.agent_id, context.agent_id
            )
            .into());
        }
        Ok(existing)
    }

    async fn get_context(&self, id: &str) -> Result<Option<CognitiveContextRecord>, StoreError> {
        sqlx::query(&format!(
            "SELECT {CONTEXT_COLUMNS} FROM cognitive_contexts WHERE id = $1"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        .as_ref()
        .map(context_from_row)
        .transpose()
    }

    async fn list_contexts(
        &self,
        include_archived: bool,
    ) -> Result<Vec<CognitiveContextRecord>, StoreError> {
        let sql = if include_archived {
            format!(
                "SELECT {CONTEXT_COLUMNS} FROM cognitive_contexts \
                 ORDER BY updated_at DESC, id ASC"
            )
        } else {
            format!(
                "SELECT {CONTEXT_COLUMNS} FROM cognitive_contexts WHERE status = 'active' \
                 ORDER BY updated_at DESC, id ASC"
            )
        };
        sqlx::query(&sql)
            .fetch_all(&self.pool)
            .await?
            .iter()
            .map(context_from_row)
            .collect()
    }

    async fn list_recent_contexts(
        &self,
        include_archived: bool,
        limit: usize,
    ) -> Result<Vec<CognitiveContextRecord>, StoreError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        sqlx::query(
            "SELECT c.id, c.agent_id, c.title, c.status, c.created_at, c.updated_at, \
                    c.seed_context_id, c.seed_context_version, c.seed_snapshot_hash, \
                    c.seed_projection, c.requested_hard_token_limit, c.token_budget_revision \
             FROM cognitive_contexts c \
             LEFT JOIN ( \
                 SELECT context_id, MAX(last_activity_at) AS last_activity_at \
                 FROM sessions GROUP BY context_id \
             ) activity ON activity.context_id = c.id \
             WHERE ($1 OR c.status = 'active') \
             ORDER BY GREATEST(c.updated_at, COALESCE(activity.last_activity_at, c.updated_at)) DESC, \
                      c.id ASC LIMIT $2",
        )
            .bind(include_archived)
            .bind(i64::try_from(limit)?)
            .fetch_all(&self.pool)
            .await?
            .iter()
            .map(context_from_row)
            .collect()
    }

    async fn update_context(
        &self,
        id: &str,
        update: ContextUpdate,
    ) -> Result<Option<CognitiveContextRecord>, StoreError> {
        if update.title.is_none() && update.status.is_none() {
            return self.get_context(id).await;
        }
        let Some(existing) = self.get_context(id).await? else {
            return Ok(None);
        };
        let title = update.title.unwrap_or(existing.title);
        let status = update.status.unwrap_or(existing.status);
        let now = now_text();
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            "UPDATE cognitive_contexts SET title = $1, status = $2, updated_at = $3 WHERE id = $4",
        )
        .bind(title)
        .bind(status.as_str())
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(None);
        }
        if status == SessionStatus::Archived {
            sqlx::query(
                "UPDATE sessions SET status = 'archived', updated_at = $1 WHERE context_id = $2 AND status != 'archived'",
            )
            .bind(&now)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        self.get_context(id).await
    }

    async fn update_context_token_budget(
        &self,
        id: &str,
        requested_hard_token_limit: Option<u64>,
        expected_revision: u64,
    ) -> Result<ContextTokenBudgetMutation, StoreError> {
        if requested_hard_token_limit == Some(0) {
            return Err("Context hard token limit 必须大于 0".into());
        }
        let requested = requested_hard_token_limit
            .map(i64::try_from)
            .transpose()
            .map_err(|_| "Context hard token limit 超出 PostgreSQL BIGINT 范围")?;
        let expected = i64::try_from(expected_revision)
            .map_err(|_| "Context token budget revision 超出 PostgreSQL BIGINT 范围")?;
        let now = now_text();
        let row = sqlx::query(&format!(
            r#"UPDATE cognitive_contexts
               SET requested_hard_token_limit = $1,
                   token_budget_revision = token_budget_revision + 1,
                   updated_at = $2
               WHERE id = $3 AND token_budget_revision = $4
               RETURNING {CONTEXT_COLUMNS}"#
        ))
        .bind(requested)
        .bind(now)
        .bind(id)
        .bind(expected)
        .fetch_optional(&self.pool)
        .await?;
        if let Some(row) = row {
            return Ok(ContextTokenBudgetMutation::Updated(context_from_row(&row)?));
        }
        Ok(match self.get_context(id).await? {
            Some(current) => ContextTokenBudgetMutation::Conflict(current),
            None => ContextTokenBudgetMutation::NotFound,
        })
    }

    async fn set_context_seed(
        &self,
        context_id: &str,
        source_context_id: &str,
        source_version: u64,
        snapshot_hash: &str,
        projection: &str,
    ) -> Result<(), StoreError> {
        let source_version = i64::try_from(source_version)?;
        let result = sqlx::query(
            r#"UPDATE cognitive_contexts
               SET seed_context_id = $1, seed_context_version = $2,
                   seed_snapshot_hash = $3, seed_projection = $4, updated_at = $5
               WHERE id = $6"#,
        )
        .bind(source_context_id)
        .bind(source_version)
        .bind(snapshot_hash)
        .bind(projection)
        .bind(now_text())
        .bind(context_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            return Err(format!("目标 Context '{context_id}' 不存在").into());
        }
        Ok(())
    }

    async fn create_session(&self, session: NewSession) -> Result<SessionRecord, StoreError> {
        let context = self
            .get_context(&session.context_id)
            .await?
            .ok_or_else(|| format!("父 Context '{}' 不存在", session.context_id))?;
        if context.agent_id != session.agent_id {
            return Err(format!(
                "Session '{}' 的 Agent '{}' 与 Context '{}' 的 Agent '{}' 不一致",
                session.id, session.agent_id, session.context_id, context.agent_id
            )
            .into());
        }
        if let Some(parent_id) = session.parent_session_id.as_deref() {
            let parent = self
                .get_session(parent_id)
                .await?
                .ok_or_else(|| format!("父 Session '{parent_id}' 不存在"))?;
            if parent.context_id != session.context_id {
                return Err(format!(
                    "父 Session '{}' 属于 Context '{}'，不能作为 Context '{}' 内 Session 的父级",
                    parent_id, parent.context_id, session.context_id
                )
                .into());
            }
        }
        let now = now_text();
        let row = sqlx::query(&format!(
            "INSERT INTO sessions \
             (id, agent_id, context_id, parent_session_id, title, status, created_at, updated_at, \
              last_activity_at, attention_state, attention_revision, mount_kind) \
             VALUES ($1, $2, $3, $4, $5, 'active', $6, $6, $6, 'active', 0, $7) \
             RETURNING {SESSION_COLUMNS}"
        ))
        .bind(&session.id)
        .bind(&session.agent_id)
        .bind(&session.context_id)
        .bind(&session.parent_session_id)
        .bind(&session.title)
        .bind(now)
        .bind(session.mount_kind.as_str())
        .fetch_one(&self.pool)
        .await?;
        session_from_row(&row)
    }

    async fn create_session_for_principal(
        &self,
        session: NewSession,
        principal_id: &str,
    ) -> Result<SessionRecord, StoreError> {
        if self.get_principal(principal_id).await?.is_none() {
            return Err(format!("Principal '{principal_id}' 不存在").into());
        }
        let context = self
            .get_context(&session.context_id)
            .await?
            .ok_or_else(|| format!("父 Context '{}' 不存在", session.context_id))?;
        if context.agent_id != session.agent_id {
            return Err(format!(
                "Session '{}' 的 Agent '{}' 与 Context '{}' 的 Agent '{}' 不一致",
                session.id, session.agent_id, session.context_id, context.agent_id
            )
            .into());
        }
        if let Some(parent_id) = session.parent_session_id.as_deref() {
            let parent = self
                .get_session(parent_id)
                .await?
                .ok_or_else(|| format!("父 Session '{parent_id}' 不存在"))?;
            if parent.context_id != session.context_id {
                return Err(format!(
                    "父 Session '{}' 属于 Context '{}'，不能作为 Context '{}' 内 Session 的父级",
                    parent_id, parent.context_id, session.context_id
                )
                .into());
            }
        }

        let now = now_text();
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(&format!(
            "INSERT INTO sessions \
             (id, agent_id, context_id, parent_session_id, title, status, created_at, updated_at, \
              last_activity_at, attention_state, attention_revision, mount_kind) \
             VALUES ($1, $2, $3, $4, $5, 'active', $6, $6, $6, 'active', 0, $7) \
             RETURNING {SESSION_COLUMNS}"
        ))
        .bind(&session.id)
        .bind(&session.agent_id)
        .bind(&session.context_id)
        .bind(&session.parent_session_id)
        .bind(&session.title)
        .bind(&now)
        .bind(session.mount_kind.as_str())
        .fetch_one(&mut *tx)
        .await?;
        sqlx::query(
            r#"INSERT INTO session_principal_bindings
               (session_id, principal_id, bound_at, unbound_at)
               VALUES ($1, $2, $3, NULL)"#,
        )
        .bind(&session.id)
        .bind(principal_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        session_from_row(&row)
    }

    async fn ensure_session(&self, session: NewSession) -> Result<SessionRecord, StoreError> {
        if let Some(existing) = self.get_session(&session.id).await? {
            if existing.context_id != session.context_id || existing.agent_id != session.agent_id {
                return Err(format!(
                    "Session '{}' 已挂载到 Agent '{}'/Context '{}'，拒绝重新路由到 Agent '{}'/Context '{}'",
                    session.id,
                    existing.agent_id,
                    existing.context_id,
                    session.agent_id,
                    session.context_id
                )
                .into());
            }
            return Ok(existing);
        }
        match self.create_session(session.clone()).await {
            Ok(created) => Ok(created),
            Err(error) => match self.get_session(&session.id).await? {
                Some(existing)
                    if existing.context_id == session.context_id
                        && existing.agent_id == session.agent_id =>
                {
                    Ok(existing)
                }
                Some(existing) => Err(format!(
                    "Session '{}' 已挂载到 Agent '{}'/Context '{}'，拒绝重新路由到 Agent '{}'/Context '{}'",
                    session.id,
                    existing.agent_id,
                    existing.context_id,
                    session.agent_id,
                    session.context_id
                )
                .into()),
                None => Err(error),
            },
        }
    }

    async fn get_session(&self, id: &str) -> Result<Option<SessionRecord>, StoreError> {
        sqlx::query(&format!(
            "SELECT {SESSION_COLUMNS} FROM sessions WHERE id = $1"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        .as_ref()
        .map(session_from_row)
        .transpose()
    }

    async fn list_sessions(
        &self,
        include_archived: bool,
    ) -> Result<Vec<SessionRecord>, StoreError> {
        let sql = if include_archived {
            format!(
                "SELECT {SESSION_COLUMNS} FROM sessions \
                 ORDER BY last_activity_at DESC, id ASC"
            )
        } else {
            format!(
                "SELECT {SESSION_COLUMNS} FROM sessions WHERE status = 'active' \
                 ORDER BY last_activity_at DESC, id ASC"
            )
        };
        sqlx::query(&sql)
            .fetch_all(&self.pool)
            .await?
            .iter()
            .map(session_from_row)
            .collect()
    }

    async fn list_context_sessions(
        &self,
        context_id: &str,
        include_archived: bool,
    ) -> Result<Vec<SessionRecord>, StoreError> {
        let sql = if include_archived {
            format!(
                "SELECT {SESSION_COLUMNS} FROM sessions WHERE context_id = $1 \
                 ORDER BY last_activity_at DESC, id ASC"
            )
        } else {
            format!(
                "SELECT {SESSION_COLUMNS} FROM sessions WHERE context_id = $1 AND status = 'active' \
                 ORDER BY last_activity_at DESC, id ASC"
            )
        };
        sqlx::query(&sql)
            .bind(context_id)
            .fetch_all(&self.pool)
            .await?
            .iter()
            .map(session_from_row)
            .collect()
    }

    async fn list_context_sessions_bounded(
        &self,
        context_ids: &[String],
        include_archived: bool,
        per_context_limit: usize,
    ) -> Result<Vec<SessionRecord>, StoreError> {
        if context_ids.is_empty() || per_context_limit == 0 {
            return Ok(Vec::new());
        }
        let sql = format!(
            r#"WITH ranked AS (
                 SELECT {SESSION_COLUMNS},
                        ROW_NUMBER() OVER (
                          PARTITION BY context_id
                          ORDER BY
                            CASE
                              WHEN EXISTS (
                                SELECT 1 FROM objectives o
                                WHERE o.context_id = sessions.context_id
                                  AND (
                                    o.coordinator_session_id = sessions.id
                                    OR o.delivery_session_id = sessions.id
                                  )
                                  AND (
                                    o.status = 'blocked'
                                    OR (
                                      o.status = 'active'
                                      AND o.wait_condition_json ->> 'kind' = 'user_input'
                                    )
                                  )
                              ) THEN 0
                              WHEN EXISTS (
                                SELECT 1 FROM thread_activations a
                                WHERE a.session_id = sessions.id AND a.status = 'running'
                              ) THEN 1
                              WHEN EXISTS (
                                SELECT 1 FROM thread_activations a
                                WHERE a.session_id = sessions.id AND a.status = 'queued'
                              ) THEN 2
                              WHEN EXISTS (
                                SELECT 1 FROM objectives o
                                WHERE o.context_id = sessions.context_id
                                  AND (
                                    o.coordinator_session_id = sessions.id
                                    OR o.delivery_session_id = sessions.id
                                  )
                                  AND o.status IN ('active', 'paused', 'blocked')
                              ) OR EXISTS (
                                SELECT 1 FROM threads t
                                WHERE t.session_id = sessions.id AND t.status = 'open'
                              ) THEN 3
                              ELSE 4
                            END,
                            last_activity_at DESC,
                            id
                        ) AS rank_in_context
                 FROM sessions
                 WHERE context_id = ANY($1) AND ($2 OR status = 'active')
               )
               SELECT {SESSION_COLUMNS}
               FROM ranked
               WHERE rank_in_context <= $3
               ORDER BY last_activity_at DESC, id"#
        );
        sqlx::query(&sql)
            .bind(context_ids)
            .bind(include_archived)
            .bind(i64::try_from(per_context_limit)?)
            .fetch_all(&self.pool)
            .await?
            .iter()
            .map(session_from_row)
            .collect()
    }

    async fn count_context_sessions(
        &self,
        context_ids: &[String],
    ) -> Result<Vec<ContextSessionCount>, StoreError> {
        if context_ids.is_empty() {
            return Ok(Vec::new());
        }
        let rows = sqlx::query(
            r#"SELECT context_id,
                      COUNT(*) FILTER (WHERE status = 'active') AS active_sessions,
                      COUNT(*) AS total_sessions,
                      MAX(last_activity_at) AS last_activity_at
               FROM sessions
               WHERE context_id = ANY($1)
               GROUP BY context_id"#,
        )
        .bind(context_ids)
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|row| {
                Ok(ContextSessionCount {
                    context_id: row.get("context_id"),
                    active_sessions: u64::try_from(row.get::<i64, _>("active_sessions"))?,
                    total_sessions: u64::try_from(row.get::<i64, _>("total_sessions"))?,
                    last_activity_at: row
                        .get::<Option<String>, _>("last_activity_at")
                        .as_deref()
                        .map(parse_time)
                        .transpose()?,
                })
            })
            .collect()
    }

    async fn update_session(
        &self,
        id: &str,
        update: SessionUpdate,
    ) -> Result<Option<SessionRecord>, StoreError> {
        if update.title.is_none() && update.status.is_none() {
            return self.get_session(id).await;
        }
        let Some(existing) = self.get_session(id).await? else {
            return Ok(None);
        };
        let title = update.title.unwrap_or(existing.title);
        let status = update.status.unwrap_or(existing.status);
        sqlx::query("UPDATE sessions SET title = $1, status = $2, updated_at = $3 WHERE id = $4")
            .bind(title)
            .bind(status.as_str())
            .bind(now_text())
            .bind(id)
            .execute(&self.pool)
            .await?;
        self.get_session(id).await
    }

    async fn touch_session(&self, id: &str, at: DateTime<Utc>) -> Result<(), StoreError> {
        let at = at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query("UPDATE sessions SET updated_at = $1, last_activity_at = $1 WHERE id = $2")
            .bind(at)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn update_session_attention(
        &self,
        update: SessionAttentionUpdate,
    ) -> Result<Option<SessionRecord>, StoreError> {
        let expected_revision = i64::try_from(update.expected_revision)?;
        let changed_at = update
            .changed_at
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE sessions
               SET attention_state = $1, attention_revision = attention_revision + 1,
                   attention_reason = $2, attention_changed_at = $3, attention_event_id = $4
               WHERE id = $5 AND context_id = $6 AND attention_revision = $7"#,
        )
        .bind(update.state.as_str())
        .bind(update.reason)
        .bind(changed_at)
        .bind(update.event_id)
        .bind(&update.session_id)
        .bind(update.context_id)
        .bind(expected_revision)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Ok(None);
        }
        self.get_session(&update.session_id).await
    }
}
