//! Runtime-owned PTY resources, not pending Agent work. The two SQL backends
//! intentionally share one small relational contract and the same CAS rules.
use serde::{Deserialize, Serialize};

pub type TerminalStoreError = Box<dyn std::error::Error + Send + Sync>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TerminalStatus {
    Starting,
    Open,
    Exited,
    Closed,
    Lost,
}
impl TerminalStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Open => "open",
            Self::Exited => "exited",
            Self::Closed => "closed",
            Self::Lost => "lost",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalSessionRecord {
    pub id: String,
    pub session_id: String,
    pub context_id: String,
    pub principal_id: String,
    pub root_turn_id: Option<String>,
    pub source_job_id: Option<String>,
    #[serde(default)]
    pub scope_ref: Option<String>,
    #[serde(default)]
    pub creation_command_id: Option<String>,
    #[serde(default)]
    pub creation_request_hash: Option<String>,
    pub target_id: String,
    pub owner_instance_id: String,
    pub lease_expires_at: String,
    pub revision: u64,
    pub status: TerminalStatus,
    pub title: String,
    pub shell: String,
    pub cwd: String,
    pub rows: u16,
    pub cols: u16,
    pub policy_hash: String,
    pub sandbox_status: String,
    pub network_enabled: bool,
    pub last_input_job_id: Option<String>,
    #[serde(default)]
    pub last_human_command_id: Option<String>,
    pub last_input_status: Option<String>,
    pub exit_code: Option<u32>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct TerminalSessionFilter {
    pub session_id: String,
    pub context_id: String,
    pub principal_id: String,
    /// None means the authenticated Session, not a cross-Session wildcard.
    pub root_ids: Option<Vec<String>>,
    /// Host-issued source scope for Human-created resources, not authority.
    pub scope_ref: Option<String>,
    /// Exact creation coordinate; reading another page never opens its screen.
    pub cursor: Option<String>,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalCatalogCursor {
    pub created_at: String,
    pub id: String,
}
impl TerminalCatalogCursor {
    pub fn decode(value: Option<&str>) -> Result<Option<Self>, TerminalStoreError> {
        use base64::Engine;
        value
            .map(|value| {
                if value.is_empty() || value.len() > 2048 {
                    return Err("invalid terminal cursor".into());
                }
                let cursor: Self = serde_json::from_slice(
                    &base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(value)?,
                )?;
                if cursor.id.is_empty()
                    || cursor.id.len() > 500
                    || cursor.created_at.len() > 64
                    || chrono::DateTime::parse_from_rfc3339(&cursor.created_at).is_err()
                {
                    return Err("invalid terminal cursor".into());
                }
                Ok(cursor)
            })
            .transpose()
    }
    pub fn for_record(record: &TerminalSessionRecord) -> String {
        use base64::Engine;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&Self {
                created_at: record.created_at.clone(),
                id: record.id.clone(),
            })
            .expect("typed terminal coordinate"),
        )
    }
}

// Each authorized source and each equal/older cursor range has its own index
// seek and limit. Only bounded candidates enter the final merge. Lease time is
// live metadata, not a reason to sort every retained terminal before LIMIT.
macro_rules! terminal_catalog_query {
    ($database:ty, $filter:expr) => {{ (|| -> Result<sqlx::QueryBuilder<'_, $database>, crate::memory::terminal::TerminalStoreError> {
        use crate::memory::terminal::TerminalCatalogCursor;
        let f = $filter;
        let key = TerminalCatalogCursor::decode(f.cursor.as_deref())?;
        if f.root_ids.as_ref().is_some_and(|roots| roots.len() > 50 || roots.iter().any(|id| id.is_empty() || id.len() > 500)) { return Err("terminal source page exceeds its budget".into()); }
        let mut sources = Vec::new();
        match &f.root_ids {
            None => sources.push((None, None)),
            Some(roots) => {
                for root in roots { sources.push((Some(root), None)); }
                if let Some(scope) = &f.scope_ref { sources.push((None, Some(scope))); }
            }
        }
        let mut q = sqlx::QueryBuilder::<$database>::new("SELECT record_json,lease_expires_at FROM (");
        if sources.is_empty() { q.push("SELECT record_json,lease_expires_at,created_at,id FROM terminal_sessions WHERE 1=0"); }
        for (branch, (root, scope)) in sources.into_iter().enumerate() {
            for seek in 0..if key.is_some() { 2 } else { 1 } {
                if branch > 0 || seek > 0 { q.push(" UNION ALL "); }
                q.push("SELECT * FROM (SELECT record_json,lease_expires_at,created_at,id FROM terminal_sessions WHERE session_id=").push_bind(f.session_id.clone())
                    .push(" AND context_id=").push_bind(f.context_id.clone()).push(" AND principal_id=").push_bind(f.principal_id.clone());
                if let Some(root) = root { q.push(" AND root_turn_id=").push_bind(root.clone()); }
                if let Some(scope) = scope { q.push(" AND root_turn_id IS NULL AND scope_ref=").push_bind(scope.clone()); }
                if let Some(key) = &key {
                    if seek == 0 { q.push(" AND created_at=").push_bind(key.created_at.clone()).push(" AND id<").push_bind(key.id.clone()); }
                    else { q.push(" AND created_at<").push_bind(key.created_at.clone()); }
                }
                q.push(" ORDER BY created_at DESC,id DESC LIMIT ").push_bind(f.limit.clamp(1, 51) as i64).push(") source_range");
            }
        }
        q.push(") candidates ORDER BY created_at DESC,id DESC LIMIT ").push_bind(f.limit.clamp(1, 51) as i64);
        Ok(q)
    })() }};
}
pub(crate) use terminal_catalog_query;

/// Human PTY control receipt. Input bytes are deliberately not stored here or
/// injected into Agent Context. The hash binds one identity to one request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalCommandRecord {
    pub id: String,
    pub terminal_id: String,
    pub principal_id: String,
    pub expected_revision: u64,
    pub request_hash: String,
    pub status: String,
    pub revision: u64,
    pub created_at: String,
}

#[async_trait::async_trait]
pub trait TerminalStore: Send + Sync {
    async fn terminal_count(
        &self,
        session: &str,
        context: &str,
        principal: &str,
    ) -> Result<u64, TerminalStoreError>;
    async fn terminal_command(
        &self,
        id: &str,
    ) -> Result<Option<TerminalCommandRecord>, TerminalStoreError>;
    async fn reserve_terminal_command(
        &self,
        command: &TerminalCommandRecord,
    ) -> Result<bool, TerminalStoreError>;
    async fn finish_terminal_command(
        &self,
        command: &TerminalCommandRecord,
    ) -> Result<(), TerminalStoreError>;
    async fn create_terminal(
        &self,
        record: &TerminalSessionRecord,
    ) -> Result<bool, TerminalStoreError>;
    async fn terminal(&self, id: &str)
        -> Result<Option<TerminalSessionRecord>, TerminalStoreError>;
    async fn terminals(
        &self,
        filter: &TerminalSessionFilter,
    ) -> Result<Vec<TerminalSessionRecord>, TerminalStoreError>;
    /// Control revision is independent of output. A write reservation advances
    /// it before physical input; receipt reconciliation uses the same revision.
    async fn compare_terminal(
        &self,
        expected: u64,
        record: &TerminalSessionRecord,
    ) -> Result<bool, TerminalStoreError>;
    async fn terminal_checkpoint(&self, id: &str) -> Result<Option<String>, TerminalStoreError>;
    async fn save_terminal_checkpoint(
        &self,
        id: &str,
        owner: &str,
        screen: &str,
    ) -> Result<(), TerminalStoreError>;
}

pub(crate) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS terminal_sessions (
 id TEXT PRIMARY KEY,
 session_id TEXT NOT NULL REFERENCES sessions(id),
 context_id TEXT NOT NULL,
 principal_id TEXT NOT NULL REFERENCES principals(id),
 root_turn_id TEXT NOT NULL,
 source_job_id TEXT NOT NULL UNIQUE REFERENCES execution_jobs(id),
 target_id TEXT NOT NULL REFERENCES execution_targets(id),
 owner_instance_id TEXT NOT NULL,
 lease_expires_at TEXT NOT NULL,
 revision BIGINT NOT NULL CHECK (revision > 0),
 status TEXT NOT NULL CHECK (status IN ('starting','open','exited','closed','lost')),
 created_at TEXT NOT NULL,
 record_json TEXT NOT NULL,
 screen_json TEXT
);
CREATE INDEX IF NOT EXISTS terminal_sessions_reader ON terminal_sessions(session_id,context_id,principal_id,created_at DESC,id);
CREATE INDEX IF NOT EXISTS terminal_sessions_root ON terminal_sessions(session_id,context_id,principal_id,root_turn_id,created_at DESC,id);
";

pub(crate) const COMMAND_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS terminal_commands (
 id TEXT PRIMARY KEY,
 terminal_id TEXT NOT NULL REFERENCES terminal_sessions(id),
 principal_id TEXT NOT NULL REFERENCES principals(id),
 expected_revision BIGINT NOT NULL CHECK(expected_revision > 0),
 request_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('reserved','submitted','rejected')),
 revision BIGINT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS terminal_commands_owner ON terminal_commands(terminal_id,principal_id,created_at);
";

pub(crate) fn human_session_schema(table: &str) -> String {
    SCHEMA
        .split("CREATE INDEX")
        .next()
        .unwrap()
        .replace("terminal_sessions", table)
        .replace("root_turn_id TEXT NOT NULL", "root_turn_id TEXT")
        .replace(
            "source_job_id TEXT NOT NULL UNIQUE",
            "source_job_id TEXT UNIQUE",
        )
        .replace(
            "target_id TEXT NOT NULL",
            "scope_ref TEXT,\n target_id TEXT NOT NULL",
        )
}
pub(crate) const SCOPE_INDEX: &str = "CREATE INDEX IF NOT EXISTS terminal_sessions_scope ON terminal_sessions(session_id,context_id,principal_id,scope_ref,created_at DESC,id)";
pub(crate) const CATALOG_INDEXES: &str = "
CREATE INDEX IF NOT EXISTS terminal_catalog_reader ON terminal_sessions(session_id,context_id,principal_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS terminal_catalog_root ON terminal_sessions(session_id,context_id,principal_id,root_turn_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS terminal_catalog_scope ON terminal_sessions(session_id,context_id,principal_id,scope_ref,created_at DESC,id DESC) WHERE root_turn_id IS NULL;
";

/// Only these static SQL statements use anonymous bind markers. No values are
/// interpolated; PostgreSQL gets its numbered markers, SQLite keeps `?`.
pub(crate) fn sql(statement: &str, postgres: bool) -> String {
    if !postgres {
        return statement.to_string();
    }
    let mut ordinal = 0;
    statement
        .chars()
        .map(|c| {
            if c == '?' {
                ordinal += 1;
                format!("${ordinal}")
            } else {
                c.to_string()
            }
        })
        .collect()
}

macro_rules! terminal_store {
    ($store:ty, $database:ty, $postgres:expr) => {
        #[async_trait::async_trait]
        impl crate::memory::terminal::TerminalStore for $store {
            async fn terminal_count(&self, session:&str, context:&str, principal:&str) -> Result<u64,crate::memory::terminal::TerminalStoreError> {
                let query = crate::memory::terminal::sql("SELECT COUNT(*) FROM terminal_sessions WHERE session_id=? AND context_id=? AND principal_id=?",$postgres);
                Ok(u64::try_from(sqlx::query_scalar::<$database,i64>(&query).bind(session).bind(context).bind(principal).fetch_one(&self.pool).await?)?)
            }
            async fn terminal_command(&self, id: &str) -> Result<Option<crate::memory::terminal::TerminalCommandRecord>, crate::memory::terminal::TerminalStoreError> {
                let q = crate::memory::terminal::sql("SELECT id,terminal_id,principal_id,expected_revision,request_hash,status,revision,created_at FROM terminal_commands WHERE id=?", $postgres);
                use sqlx::Row;
                sqlx::query(&q).bind(id).fetch_optional(&self.pool).await?.map(|r| Ok(crate::memory::terminal::TerminalCommandRecord {
                    id:r.try_get("id")?,terminal_id:r.try_get("terminal_id")?,principal_id:r.try_get("principal_id")?,expected_revision:u64::try_from(r.try_get::<i64,_>("expected_revision")?)?,request_hash:r.try_get("request_hash")?,status:r.try_get("status")?,revision:u64::try_from(r.try_get::<i64,_>("revision")?)?,created_at:r.try_get("created_at")?
                })).transpose()
            }
            async fn reserve_terminal_command(&self, r: &crate::memory::terminal::TerminalCommandRecord) -> Result<bool, crate::memory::terminal::TerminalStoreError> {
                let q=crate::memory::terminal::sql("INSERT INTO terminal_commands(id,terminal_id,principal_id,expected_revision,request_hash,status,revision,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING", $postgres);
                Ok(sqlx::query(&q).bind(&r.id).bind(&r.terminal_id).bind(&r.principal_id).bind(i64::try_from(r.expected_revision)?).bind(&r.request_hash).bind(&r.status).bind(i64::try_from(r.revision)?).bind(&r.created_at).execute(&self.pool).await?.rows_affected()==1)
            }
            async fn finish_terminal_command(&self, r: &crate::memory::terminal::TerminalCommandRecord) -> Result<(), crate::memory::terminal::TerminalStoreError> {
                let q=crate::memory::terminal::sql("UPDATE terminal_commands SET status=?,revision=? WHERE id=? AND terminal_id=? AND principal_id=? AND request_hash=? AND status='reserved'", $postgres);
                if sqlx::query(&q).bind(&r.status).bind(i64::try_from(r.revision)?).bind(&r.id).bind(&r.terminal_id).bind(&r.principal_id).bind(&r.request_hash).execute(&self.pool).await?.rows_affected()!=1 { return Err("terminal command receipt changed".into()); }
                Ok(())
            }
            async fn create_terminal(&self, r: &crate::memory::terminal::TerminalSessionRecord) -> Result<bool, crate::memory::terminal::TerminalStoreError> {
                let statement = crate::memory::terminal::sql("INSERT INTO terminal_sessions(id,session_id,context_id,principal_id,root_turn_id,source_job_id,scope_ref,target_id,owner_instance_id,lease_expires_at,revision,status,created_at,record_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING", $postgres);
                Ok(sqlx::query(&statement).bind(&r.id).bind(&r.session_id).bind(&r.context_id).bind(&r.principal_id).bind(&r.root_turn_id).bind(&r.source_job_id).bind(&r.scope_ref).bind(&r.target_id).bind(&r.owner_instance_id).bind(&r.lease_expires_at).bind(i64::try_from(r.revision)?).bind(r.status.as_str()).bind(&r.created_at).bind(serde_json::to_string(r)?).execute(&self.pool).await?.rows_affected() == 1)
            }
            async fn terminal(&self, id: &str) -> Result<Option<crate::memory::terminal::TerminalSessionRecord>, crate::memory::terminal::TerminalStoreError> {
                let statement = crate::memory::terminal::sql("SELECT record_json,lease_expires_at FROM terminal_sessions WHERE id=?", $postgres);
                let row = sqlx::query(&statement).bind(id).fetch_optional(&self.pool).await?;
                row.map(|row| { let mut r: crate::memory::terminal::TerminalSessionRecord = serde_json::from_str(&sqlx::Row::try_get::<String,_>(&row,"record_json")?)?; r.lease_expires_at=sqlx::Row::try_get(&row,"lease_expires_at")?; Ok(r) }).transpose()
            }
            async fn terminals(&self, f: &crate::memory::terminal::TerminalSessionFilter) -> Result<Vec<crate::memory::terminal::TerminalSessionRecord>, crate::memory::terminal::TerminalStoreError> {
                let mut q = crate::memory::terminal::terminal_catalog_query!($database, f)?;
                let rows = q.build().fetch_all(&self.pool).await?;
                rows.into_iter().map(|row| { let mut r: crate::memory::terminal::TerminalSessionRecord = serde_json::from_str(&sqlx::Row::try_get::<String,_>(&row,"record_json")?)?; r.lease_expires_at=sqlx::Row::try_get(&row,"lease_expires_at")?; Ok(r) }).collect()
            }
            async fn compare_terminal(&self, expected: u64, r: &crate::memory::terminal::TerminalSessionRecord) -> Result<bool, crate::memory::terminal::TerminalStoreError> {
                if !(r.revision == expected || r.revision == expected.saturating_add(1)) { return Err("invalid terminal revision transition".into()); }
                let statement = crate::memory::terminal::sql("UPDATE terminal_sessions SET revision=?,status=?,record_json=? WHERE id=? AND revision=? AND owner_instance_id=? AND COALESCE(source_job_id,'')=COALESCE(?,'') AND session_id=? AND context_id=? AND principal_id=? AND target_id=? AND COALESCE(root_turn_id,'')=COALESCE(?,'') AND COALESCE(scope_ref,'')=COALESCE(?,'')", $postgres);
                Ok(sqlx::query(&statement).bind(i64::try_from(r.revision)?).bind(r.status.as_str()).bind(serde_json::to_string(r)?).bind(&r.id).bind(i64::try_from(expected)?).bind(&r.owner_instance_id).bind(&r.source_job_id).bind(&r.session_id).bind(&r.context_id).bind(&r.principal_id).bind(&r.target_id).bind(&r.root_turn_id).bind(&r.scope_ref).execute(&self.pool).await?.rows_affected() == 1)
            }
            async fn terminal_checkpoint(&self, id: &str) -> Result<Option<String>, crate::memory::terminal::TerminalStoreError> {
                let statement = crate::memory::terminal::sql("SELECT screen_json FROM terminal_sessions WHERE id=?", $postgres);
                Ok(sqlx::query_scalar::<_,Option<String>>(&statement).bind(id).fetch_optional(&self.pool).await?.flatten())
            }
            async fn save_terminal_checkpoint(&self, id: &str, owner: &str, screen: &str) -> Result<(), crate::memory::terminal::TerminalStoreError> {
                if screen.len() > 524288 { return Err("terminal checkpoint exceeds 512 KiB".into()); }
                let statement = crate::memory::terminal::sql("UPDATE terminal_sessions SET screen_json=?,lease_expires_at=? WHERE id=? AND owner_instance_id=?", $postgres);
                let lease = (chrono::Utc::now()+chrono::Duration::seconds(20)).to_rfc3339();
                sqlx::query(&statement).bind(screen).bind(lease).bind(id).bind(owner).execute(&self.pool).await?;
                Ok(())
            }
        }
    };
}
pub(crate) use terminal_store;
