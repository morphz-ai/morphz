//! Single-node SQLite reference backend for the ContextDB experiment.
//!
//! The experiment deliberately does not implement the existing EventStore or
//! participate in Runtime construction.  Its authority is the current Context
//! AST itself.  Application Event History, Recall and audit history are not
//! prerequisites for reading or mutating that state.

use super::{ExperimentalFeaturePermit, CONTEXT_DB};
use crate::sexpr::{self, SExpr};
use async_trait::async_trait;
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{QueryBuilder, Row, Sqlite, SqlitePool};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fmt;
use std::path::Path;
use std::time::Duration;

const SCHEMA_VERSION: u32 = 1;
const MAX_TREE_DEPTH: usize = 128;
const MAX_TRANSACTION_OPERATIONS: usize = 4_096;
const MAX_TRANSACTION_BODY_BYTES: usize = 64 * 1024 * 1024;

pub type ContextDbResult<T> = Result<T, ContextDbError>;

#[derive(Debug)]
pub enum ContextDbError {
    FeatureDenied,
    Invalid(String),
    NotFound(String),
    AlreadyExists(String),
    Conflict {
        context_id: String,
        expected: u64,
        actual: u64,
    },
    Precondition(String),
    AuthorityDenied {
        actor_id: String,
        domain: AuthorityDomain,
    },
    IdempotencyReuse(String),
    Corrupt(String),
    Storage(sqlx::Error),
    Syntax(sexpr::ParserError),
    Codec(serde_json::Error),
}

impl fmt::Display for ContextDbError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::FeatureDenied => formatter.write_str(
                "ContextDB requires the compiled and operator-enabled context-db experiment",
            ),
            Self::Invalid(message) => write!(formatter, "invalid ContextDB request: {message}"),
            Self::NotFound(message) => write!(formatter, "ContextDB object not found: {message}"),
            Self::AlreadyExists(message) => {
                write!(formatter, "ContextDB object already exists: {message}")
            }
            Self::Conflict {
                context_id,
                expected,
                actual,
            } => write!(
                formatter,
                "Context '{context_id}' revision conflict: expected {expected}, current {actual}"
            ),
            Self::Precondition(message) => {
                write!(formatter, "ContextDB precondition failed: {message}")
            }
            Self::AuthorityDenied { actor_id, domain } => write!(
                formatter,
                "actor '{actor_id}' cannot modify authority domain '{}'",
                domain.as_str()
            ),
            Self::IdempotencyReuse(key) => write!(
                formatter,
                "idempotency key '{key}' was already used by a different transaction"
            ),
            Self::Corrupt(message) => write!(formatter, "ContextDB integrity error: {message}"),
            Self::Storage(error) => write!(formatter, "ContextDB SQLite error: {error}"),
            Self::Syntax(error) => write!(formatter, "ContextDB S-expression error: {error}"),
            Self::Codec(error) => write!(formatter, "ContextDB codec error: {error}"),
        }
    }
}

impl std::error::Error for ContextDbError {}

impl From<sqlx::Error> for ContextDbError {
    fn from(error: sqlx::Error) -> Self {
        Self::Storage(error)
    }
}

impl From<sexpr::ParserError> for ContextDbError {
    fn from(error: sexpr::ParserError) -> Self {
        Self::Syntax(error)
    }
}

impl From<serde_json::Error> for ContextDbError {
    fn from(error: serde_json::Error) -> Self {
        Self::Codec(error)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum AuthorityDomain {
    RuntimeInput,
    AgentMind,
    RuntimeControl,
    AgentControl,
    SystemPolicy,
}

impl AuthorityDomain {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RuntimeInput => "runtime_input",
            Self::AgentMind => "agent_mind",
            Self::RuntimeControl => "runtime_control",
            Self::AgentControl => "agent_control",
            Self::SystemPolicy => "system_policy",
        }
    }

    fn from_storage(value: &str) -> ContextDbResult<Self> {
        match value {
            "runtime_input" => Ok(Self::RuntimeInput),
            "agent_mind" => Ok(Self::AgentMind),
            "runtime_control" => Ok(Self::RuntimeControl),
            "agent_control" => Ok(Self::AgentControl),
            "system_policy" => Ok(Self::SystemPolicy),
            other => Err(ContextDbError::Corrupt(format!(
                "unknown authority domain '{other}'"
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
/// Trusted authorization context supplied by the Runtime adapter.
///
/// A transport must derive these grants from an authenticated capability; it
/// must never deserialize client- or model-asserted domains and treat them as
/// authority. ContextDB enforces granted domains but does not authenticate the
/// actor itself.
pub struct ContextAuthority {
    pub actor_id: String,
    pub granted_domains: BTreeSet<AuthorityDomain>,
}

impl ContextAuthority {
    pub fn new(
        actor_id: impl Into<String>,
        granted_domains: impl IntoIterator<Item = AuthorityDomain>,
    ) -> Self {
        Self {
            actor_id: actor_id.into(),
            granted_domains: granted_domains.into_iter().collect(),
        }
    }

    fn require(&self, domain: AuthorityDomain) -> ContextDbResult<()> {
        if self.granted_domains.contains(&domain) {
            Ok(())
        } else {
            Err(ContextDbError::AuthorityDenied {
                actor_id: self.actor_id.clone(),
                domain,
            })
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextNodeDraft {
    pub node_id: String,
    pub parent_id: Option<String>,
    pub order_key: i64,
    pub owner_domain: AuthorityDomain,
    /// One canonical S-expression list representing this logical Node without
    /// separately stored child Nodes.  Children are appended during rendering.
    pub body_sexpr: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreateContextRequest {
    pub context_id: String,
    pub tenant_id: String,
    pub agent_id: String,
    pub authority: ContextAuthority,
    pub root: ContextNodeDraft,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ContextOperation {
    InsertNode {
        node: ContextNodeDraft,
    },
    ReplaceNode {
        node_id: String,
        expected_node_revision: u64,
        body_sexpr: String,
    },
    DeleteSubtree {
        node_id: String,
        expected_subtree_hash: String,
    },
    MoveSubtree {
        node_id: String,
        expected_node_revision: u64,
        expected_subtree_hash: String,
        new_parent_id: String,
        new_order_key: i64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextTransaction {
    pub transaction_id: String,
    pub idempotency_key: String,
    pub context_id: String,
    pub base_revision: u64,
    /// Trusted authorization context, not an untrusted request field at a
    /// network or model boundary.
    pub authority: ContextAuthority,
    pub operations: Vec<ContextOperation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TransactionReceipt {
    pub transaction_id: String,
    pub context_id: String,
    pub before_revision: u64,
    pub after_revision: u64,
    pub rebased: bool,
    pub changed_node_ids: Vec<String>,
    pub root_hash: String,
    pub committed_at: String,
    #[serde(default)]
    pub idempotent_replay: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextNodeRecord {
    pub node_id: String,
    pub parent_id: Option<String>,
    pub order_key: i64,
    pub owner_domain: AuthorityDomain,
    pub node_revision: u64,
    pub body_sexpr: String,
    pub content_hash: String,
    pub subtree_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextSnapshot {
    pub context_id: String,
    pub tenant_id: String,
    pub agent_id: String,
    pub revision: u64,
    pub root_node_id: String,
    pub root_hash: String,
    pub canonical_sexpr: String,
    pub nodes: Vec<ContextNodeRecord>,
}

impl ContextSnapshot {
    pub fn node(&self, node_id: &str) -> Option<&ContextNodeRecord> {
        self.nodes.iter().find(|node| node.node_id == node_id)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextDbStats {
    pub context_id: String,
    pub revision: u64,
    pub node_count: u64,
    pub logical_body_bytes: u64,
    pub receipt_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextIntegrityReport {
    pub context_id: String,
    pub revision: u64,
    pub node_count: usize,
    pub root_hash: String,
    pub recomputed_root_hash: String,
    pub mismatched_node_ids: Vec<String>,
    pub matches: bool,
}

#[async_trait]
pub trait ContextStore: Send + Sync {
    async fn create_context(
        &self,
        request: CreateContextRequest,
    ) -> ContextDbResult<ContextSnapshot>;

    async fn get_context(&self, context_id: &str) -> ContextDbResult<ContextSnapshot>;

    async fn apply_transaction(
        &self,
        transaction: ContextTransaction,
    ) -> ContextDbResult<TransactionReceipt>;

    async fn inspect_context(&self, context_id: &str) -> ContextDbResult<ContextDbStats>;

    async fn audit_context(&self, context_id: &str) -> ContextDbResult<ContextIntegrityReport>;
}

#[derive(Debug, Clone)]
pub struct SqliteContextDb {
    pool: SqlitePool,
}

impl SqliteContextDb {
    pub async fn open(
        path: impl AsRef<Path>,
        permit: ExperimentalFeaturePermit,
    ) -> ContextDbResult<Self> {
        if !permit.permits(CONTEXT_DB) {
            return Err(ContextDbError::FeatureDenied);
        }
        let path = path.as_ref();
        // SQLite gives every independent `:memory:` connection a different
        // database. Keep that useful test/development mode on one connection;
        // file-backed stores retain a small concurrent reader pool.
        let max_connections = if path == Path::new(":memory:") { 1 } else { 8 };
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .busy_timeout(Duration::from_secs(10));
        let pool = SqlitePoolOptions::new()
            .max_connections(max_connections)
            .max_lifetime(None)
            .idle_timeout(None)
            .connect_with(options)
            .await?;
        let store = Self { pool };
        store.initialize().await?;
        Ok(store)
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }

    async fn initialize(&self) -> ContextDbResult<()> {
        sqlx::query(
            r#"CREATE TABLE IF NOT EXISTS experimental_contextdb_contexts (
                   context_id TEXT PRIMARY KEY,
                   tenant_id TEXT NOT NULL,
                   agent_id TEXT NOT NULL,
                   revision INTEGER NOT NULL CHECK(revision >= 1),
                   root_node_id TEXT NOT NULL,
                   root_hash TEXT NOT NULL,
                   schema_version INTEGER NOT NULL,
                   created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
               )"#,
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r#"CREATE TABLE IF NOT EXISTS experimental_contextdb_nodes (
                   context_id TEXT NOT NULL,
                   node_id TEXT NOT NULL,
                   parent_id TEXT,
                   order_key INTEGER NOT NULL,
                   owner_domain TEXT NOT NULL,
                   node_revision INTEGER NOT NULL CHECK(node_revision >= 1),
                   body_sexpr TEXT NOT NULL,
                   content_hash TEXT NOT NULL,
                   subtree_hash TEXT NOT NULL,
                   PRIMARY KEY(context_id, node_id),
                   FOREIGN KEY(context_id)
                     REFERENCES experimental_contextdb_contexts(context_id)
                     ON DELETE CASCADE
               )"#,
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r#"CREATE INDEX IF NOT EXISTS idx_experimental_contextdb_nodes_parent
               ON experimental_contextdb_nodes(context_id, parent_id, order_key, node_id)"#,
        )
        .execute(&self.pool)
        .await?;
        // This is an idempotency receipt cache, not an application Event Log.
        // It stores no replayable Context history or model content beyond the
        // transaction digest and bounded receipt.
        sqlx::query(
            r#"CREATE TABLE IF NOT EXISTS experimental_contextdb_receipts (
                   context_id TEXT NOT NULL,
                   idempotency_key TEXT NOT NULL,
                   request_hash TEXT NOT NULL,
                   receipt_json TEXT NOT NULL,
                   committed_at TEXT NOT NULL,
                   PRIMARY KEY(context_id, idempotency_key),
                   FOREIGN KEY(context_id)
                     REFERENCES experimental_contextdb_contexts(context_id)
                     ON DELETE CASCADE
               )"#,
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

#[derive(Debug, Clone)]
struct StoredNode {
    node_id: String,
    parent_id: Option<String>,
    order_key: i64,
    owner_domain: AuthorityDomain,
    node_revision: u64,
    body_sexpr: String,
    content_hash: String,
    subtree_hash: String,
}

impl StoredNode {
    fn public_record(&self) -> ContextNodeRecord {
        ContextNodeRecord {
            node_id: self.node_id.clone(),
            parent_id: self.parent_id.clone(),
            order_key: self.order_key,
            owner_domain: self.owner_domain,
            node_revision: self.node_revision,
            body_sexpr: self.body_sexpr.clone(),
            content_hash: self.content_hash.clone(),
            subtree_hash: self.subtree_hash.clone(),
        }
    }
}

#[derive(Debug)]
struct ContextMeta {
    context_id: String,
    tenant_id: String,
    agent_id: String,
    revision: u64,
    root_node_id: String,
    root_hash: String,
}

#[async_trait]
impl ContextStore for SqliteContextDb {
    async fn create_context(
        &self,
        request: CreateContextRequest,
    ) -> ContextDbResult<ContextSnapshot> {
        validate_identifier("context_id", &request.context_id)?;
        validate_identifier("tenant_id", &request.tenant_id)?;
        validate_identifier("agent_id", &request.agent_id)?;
        validate_identifier("authority.actor_id", &request.authority.actor_id)?;
        validate_identifier("root.node_id", &request.root.node_id)?;
        if request.root.parent_id.is_some() {
            return Err(ContextDbError::Invalid(
                "the Context root must not have a parent".to_string(),
            ));
        }
        request.authority.require(request.root.owner_domain)?;
        let (body_sexpr, content_hash) = canonicalize_body(&request.root.body_sexpr)?;
        let root_head = sexpr_head(&body_sexpr)?;
        if root_head != "context" {
            return Err(ContextDbError::Invalid(format!(
                "the root Node must be a (context ...) expression, got ({root_head} ...)"
            )));
        }
        let root_hash = calculate_subtree_hash(
            &request.root.node_id,
            request.root.owner_domain,
            &body_sexpr,
            &[],
        );
        let now = now_string();
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let inserted = sqlx::query(
            r#"INSERT OR IGNORE INTO experimental_contextdb_contexts
               (context_id, tenant_id, agent_id, revision, root_node_id,
                root_hash, schema_version, created_at, updated_at)
               VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)"#,
        )
        .bind(&request.context_id)
        .bind(&request.tenant_id)
        .bind(&request.agent_id)
        .bind(&request.root.node_id)
        .bind(&root_hash)
        .bind(i64::from(SCHEMA_VERSION))
        .bind(&now)
        .bind(&now)
        .execute(&mut *transaction)
        .await?;
        if inserted.rows_affected() == 0 {
            return Err(ContextDbError::AlreadyExists(format!(
                "Context '{}'",
                request.context_id
            )));
        }
        sqlx::query(
            r#"INSERT INTO experimental_contextdb_nodes
               (context_id, node_id, parent_id, order_key, owner_domain,
                node_revision, body_sexpr, content_hash, subtree_hash)
               VALUES (?, ?, NULL, ?, ?, 1, ?, ?, ?)"#,
        )
        .bind(&request.context_id)
        .bind(&request.root.node_id)
        .bind(request.root.order_key)
        .bind(request.root.owner_domain.as_str())
        .bind(&body_sexpr)
        .bind(&content_hash)
        .bind(&root_hash)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        self.get_context(&request.context_id).await
    }

    async fn get_context(&self, context_id: &str) -> ContextDbResult<ContextSnapshot> {
        validate_identifier("context_id", context_id)?;
        // Meta and Nodes must come from one SQLite read transaction.  Reading
        // them through separate pool acquisitions can otherwise combine a
        // pre-commit head with post-commit Nodes (or vice versa).
        let mut transaction = self.pool.begin().await?;
        let meta = load_context_meta_tx(&mut transaction, context_id).await?;
        let nodes = load_nodes_tx(&mut transaction, context_id).await?;
        let snapshot = build_snapshot(meta, nodes)?;
        transaction.commit().await?;
        Ok(snapshot)
    }

    async fn apply_transaction(
        &self,
        mut request: ContextTransaction,
    ) -> ContextDbResult<TransactionReceipt> {
        validate_transaction(&request)?;
        // Parse and canonicalize model-sized bodies before acquiring SQLite's
        // single writer. A large Tool Result must not hold the write lock while
        // the CPU validates S-expression syntax, and equivalent whitespace
        // must produce the same idempotency digest.
        normalize_transaction_bodies(&mut request)?;
        let request_hash = digest_bytes(&serde_json::to_vec(&request)?);
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;

        if let Some(row) = sqlx::query(
            r#"SELECT request_hash, receipt_json
               FROM experimental_contextdb_receipts
               WHERE context_id = ? AND idempotency_key = ?"#,
        )
        .bind(&request.context_id)
        .bind(&request.idempotency_key)
        .fetch_optional(&mut *transaction)
        .await?
        {
            let stored_hash = row.get::<String, _>("request_hash");
            if stored_hash != request_hash {
                return Err(ContextDbError::IdempotencyReuse(request.idempotency_key));
            }
            let mut receipt =
                serde_json::from_str::<TransactionReceipt>(&row.get::<String, _>("receipt_json"))?;
            receipt.idempotent_replay = true;
            transaction.commit().await?;
            return Ok(receipt);
        }

        let meta = load_context_meta_tx(&mut transaction, &request.context_id).await?;
        if request.base_revision > meta.revision {
            return Err(ContextDbError::Conflict {
                context_id: request.context_id,
                expected: request.base_revision,
                actual: meta.revision,
            });
        }
        let rebased = request.base_revision != meta.revision;
        let after_revision = meta
            .revision
            .checked_add(1)
            .ok_or_else(|| ContextDbError::Invalid("Context revision overflow".to_string()))?;
        let claimed = sqlx::query(
            r#"UPDATE experimental_contextdb_contexts
               SET revision = ?, updated_at = ?
               WHERE context_id = ? AND revision = ?"#,
        )
        .bind(i64::try_from(after_revision).map_err(|_| {
            ContextDbError::Invalid("Context revision exceeds SQLite INTEGER".to_string())
        })?)
        .bind(now_string())
        .bind(&request.context_id)
        .bind(i64::try_from(meta.revision).map_err(|_| {
            ContextDbError::Corrupt("negative or overflowing Context revision".to_string())
        })?)
        .execute(&mut *transaction)
        .await?;
        if claimed.rows_affected() != 1 {
            let actual = load_context_meta_tx(&mut transaction, &request.context_id)
                .await?
                .revision;
            return Err(ContextDbError::Conflict {
                context_id: request.context_id,
                expected: meta.revision,
                actual,
            });
        }

        let mut dirty_hash_nodes = BTreeSet::new();
        let mut changed_node_ids = BTreeSet::new();
        for operation in &request.operations {
            apply_operation(
                &mut transaction,
                &request.context_id,
                &meta.root_node_id,
                &request.authority,
                operation,
                &mut dirty_hash_nodes,
                &mut changed_node_ids,
            )
            .await?;
        }
        let root_hash = recompute_dirty_hashes(
            &mut transaction,
            &request.context_id,
            &meta.root_node_id,
            dirty_hash_nodes,
        )
        .await?;
        sqlx::query(
            r#"UPDATE experimental_contextdb_contexts
               SET root_hash = ?, updated_at = ?
               WHERE context_id = ? AND revision = ?"#,
        )
        .bind(&root_hash)
        .bind(now_string())
        .bind(&request.context_id)
        .bind(i64::try_from(after_revision).map_err(|_| {
            ContextDbError::Invalid("Context revision exceeds SQLite INTEGER".to_string())
        })?)
        .execute(&mut *transaction)
        .await?;

        let committed_at = now_string();
        let receipt = TransactionReceipt {
            transaction_id: request.transaction_id,
            context_id: request.context_id.clone(),
            before_revision: meta.revision,
            after_revision,
            rebased,
            changed_node_ids: changed_node_ids.into_iter().collect(),
            root_hash,
            committed_at: committed_at.clone(),
            idempotent_replay: false,
        };
        sqlx::query(
            r#"INSERT INTO experimental_contextdb_receipts
               (context_id, idempotency_key, request_hash, receipt_json, committed_at)
               VALUES (?, ?, ?, ?, ?)"#,
        )
        .bind(&request.context_id)
        .bind(&request.idempotency_key)
        .bind(&request_hash)
        .bind(serde_json::to_string(&receipt)?)
        .bind(&committed_at)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(receipt)
    }

    async fn inspect_context(&self, context_id: &str) -> ContextDbResult<ContextDbStats> {
        validate_identifier("context_id", context_id)?;
        let mut transaction = self.pool.begin().await?;
        let meta = load_context_meta_tx(&mut transaction, context_id).await?;
        let row = sqlx::query(
            r#"SELECT COUNT(*) AS node_count,
                      COALESCE(SUM(LENGTH(CAST(body_sexpr AS BLOB))), 0) AS body_bytes
               FROM experimental_contextdb_nodes WHERE context_id = ?"#,
        )
        .bind(context_id)
        .fetch_one(&mut *transaction)
        .await?;
        let receipt_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM experimental_contextdb_receipts WHERE context_id = ?",
        )
        .bind(context_id)
        .fetch_one(&mut *transaction)
        .await?;
        let stats = ContextDbStats {
            context_id: context_id.to_string(),
            revision: meta.revision,
            node_count: u64::try_from(row.get::<i64, _>("node_count"))
                .map_err(|_| ContextDbError::Corrupt("negative Context Node count".to_string()))?,
            logical_body_bytes: u64::try_from(row.get::<i64, _>("body_bytes")).map_err(|_| {
                ContextDbError::Corrupt("negative Context body byte count".to_string())
            })?,
            receipt_count: u64::try_from(receipt_count).map_err(|_| {
                ContextDbError::Corrupt("negative Context receipt count".to_string())
            })?,
        };
        transaction.commit().await?;
        Ok(stats)
    }

    async fn audit_context(&self, context_id: &str) -> ContextDbResult<ContextIntegrityReport> {
        validate_identifier("context_id", context_id)?;
        let mut transaction = self.pool.begin().await?;
        let meta = load_context_meta_tx(&mut transaction, context_id).await?;
        let nodes = load_nodes_tx(&mut transaction, context_id).await?;
        let report = audit_loaded_context(meta, nodes)?;
        transaction.commit().await?;
        Ok(report)
    }
}

fn validate_identifier(name: &str, value: &str) -> ContextDbResult<()> {
    if value.trim().is_empty() {
        return Err(ContextDbError::Invalid(format!("{name} must not be empty")));
    }
    if value.len() > 512 {
        return Err(ContextDbError::Invalid(format!("{name} exceeds 512 bytes")));
    }
    Ok(())
}

fn validate_transaction(transaction: &ContextTransaction) -> ContextDbResult<()> {
    validate_identifier("transaction_id", &transaction.transaction_id)?;
    validate_identifier("idempotency_key", &transaction.idempotency_key)?;
    validate_identifier("context_id", &transaction.context_id)?;
    validate_identifier("authority.actor_id", &transaction.authority.actor_id)?;
    if transaction.operations.is_empty() {
        return Err(ContextDbError::Invalid(
            "a Context transaction must contain at least one operation".to_string(),
        ));
    }
    if transaction.operations.len() > MAX_TRANSACTION_OPERATIONS {
        return Err(ContextDbError::Invalid(format!(
            "a Context transaction may contain at most {MAX_TRANSACTION_OPERATIONS} operations"
        )));
    }
    Ok(())
}

fn normalize_transaction_bodies(transaction: &mut ContextTransaction) -> ContextDbResult<()> {
    let mut input_body_bytes = 0usize;
    let mut canonical_body_bytes = 0usize;
    for operation in &mut transaction.operations {
        let body = match operation {
            ContextOperation::InsertNode { node } => &mut node.body_sexpr,
            ContextOperation::ReplaceNode { body_sexpr, .. } => body_sexpr,
            ContextOperation::DeleteSubtree { .. } | ContextOperation::MoveSubtree { .. } => {
                continue;
            }
        };
        input_body_bytes = input_body_bytes.checked_add(body.len()).ok_or_else(|| {
            ContextDbError::Invalid("Context transaction body size overflow".to_string())
        })?;
        if input_body_bytes > MAX_TRANSACTION_BODY_BYTES {
            return Err(ContextDbError::Invalid(format!(
                "Context transaction Node bodies exceed {MAX_TRANSACTION_BODY_BYTES} bytes"
            )));
        }
        let (canonical, _) = canonicalize_body(body)?;
        canonical_body_bytes = canonical_body_bytes
            .checked_add(canonical.len())
            .ok_or_else(|| {
                ContextDbError::Invalid("canonical Context body size overflow".to_string())
            })?;
        if canonical_body_bytes > MAX_TRANSACTION_BODY_BYTES {
            return Err(ContextDbError::Invalid(format!(
                "canonical Context transaction Node bodies exceed {MAX_TRANSACTION_BODY_BYTES} bytes"
            )));
        }
        *body = canonical;
    }
    Ok(())
}

fn canonicalize_body(input: &str) -> ContextDbResult<(String, String)> {
    let mut parsed_forms = sexpr::parse_all(input)?;
    if parsed_forms.len() != 1 {
        return Err(ContextDbError::Invalid(format!(
            "a Context Node body must contain exactly one top-level S-expression, got {}",
            parsed_forms.len()
        )));
    }
    let parsed = parsed_forms
        .pop()
        .expect("one Context Node expression was checked above");
    let SExpr::List(items) = &parsed else {
        return Err(ContextDbError::Invalid(
            "a Context Node body must be an S-expression list".to_string(),
        ));
    };
    if !matches!(items.first(), Some(SExpr::Atom(head)) if !head.is_empty()) {
        return Err(ContextDbError::Invalid(
            "a Context Node body must start with a non-empty atom".to_string(),
        ));
    }
    let canonical = parsed.to_string();
    let content_hash = digest_bytes(canonical.as_bytes());
    Ok((canonical, content_hash))
}

fn sexpr_head(canonical: &str) -> ContextDbResult<String> {
    let parsed = sexpr::parse(canonical)?;
    match parsed {
        SExpr::List(items) => match items.first() {
            Some(SExpr::Atom(head)) => Ok(head.clone()),
            _ => Err(ContextDbError::Corrupt(
                "stored Node has no S-expression head".to_string(),
            )),
        },
        SExpr::Atom(_) => Err(ContextDbError::Corrupt(
            "stored Node body is not a list".to_string(),
        )),
    }
}

fn digest_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn calculate_subtree_hash(
    node_id: &str,
    owner_domain: AuthorityDomain,
    body_sexpr: &str,
    children: &[(i64, String, String)],
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"morphz-contextdb-node-v1\0");
    hasher.update(node_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(owner_domain.as_str().as_bytes());
    hasher.update(b"\0");
    hasher.update(body_sexpr.as_bytes());
    for (order_key, child_id, child_hash) in children {
        hasher.update(b"\0child\0");
        hasher.update(order_key.to_be_bytes());
        hasher.update(child_id.as_bytes());
        hasher.update(b"\0");
        hasher.update(child_hash.as_bytes());
    }
    let digest = hasher.finalize();
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn now_string() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Nanos, true)
}

async fn load_context_meta_tx(
    transaction: &mut sqlx::Transaction<'_, Sqlite>,
    context_id: &str,
) -> ContextDbResult<ContextMeta> {
    let row = sqlx::query(
        r#"SELECT context_id, tenant_id, agent_id, revision,
                  root_node_id, root_hash, schema_version
           FROM experimental_contextdb_contexts WHERE context_id = ?"#,
    )
    .bind(context_id)
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or_else(|| ContextDbError::NotFound(format!("Context '{context_id}'")))?;
    context_meta_from_row(&row)
}

fn context_meta_from_row(row: &sqlx::sqlite::SqliteRow) -> ContextDbResult<ContextMeta> {
    let schema_version = row.get::<i64, _>("schema_version");
    if schema_version != i64::from(SCHEMA_VERSION) {
        return Err(ContextDbError::Corrupt(format!(
            "unsupported ContextDB schema version {schema_version}"
        )));
    }
    Ok(ContextMeta {
        context_id: row.get("context_id"),
        tenant_id: row.get("tenant_id"),
        agent_id: row.get("agent_id"),
        revision: u64::try_from(row.get::<i64, _>("revision"))
            .map_err(|_| ContextDbError::Corrupt("invalid Context revision".to_string()))?,
        root_node_id: row.get("root_node_id"),
        root_hash: row.get("root_hash"),
    })
}

async fn load_nodes_tx(
    transaction: &mut sqlx::Transaction<'_, Sqlite>,
    context_id: &str,
) -> ContextDbResult<Vec<StoredNode>> {
    let rows = sqlx::query(
        r#"SELECT node_id, parent_id, order_key, owner_domain, node_revision,
                  body_sexpr, content_hash, subtree_hash
           FROM experimental_contextdb_nodes
           WHERE context_id = ?
           ORDER BY parent_id, order_key, node_id"#,
    )
    .bind(context_id)
    .fetch_all(&mut **transaction)
    .await?;
    rows.iter().map(stored_node_from_row).collect()
}

fn stored_node_from_row(row: &sqlx::sqlite::SqliteRow) -> ContextDbResult<StoredNode> {
    Ok(StoredNode {
        node_id: row.get("node_id"),
        parent_id: row.get("parent_id"),
        order_key: row.get("order_key"),
        owner_domain: AuthorityDomain::from_storage(&row.get::<String, _>("owner_domain"))?,
        node_revision: u64::try_from(row.get::<i64, _>("node_revision"))
            .map_err(|_| ContextDbError::Corrupt("invalid Node revision".to_string()))?,
        body_sexpr: row.get("body_sexpr"),
        content_hash: row.get("content_hash"),
        subtree_hash: row.get("subtree_hash"),
    })
}

fn build_snapshot(meta: ContextMeta, nodes: Vec<StoredNode>) -> ContextDbResult<ContextSnapshot> {
    let (canonical_sexpr, visited) = render_loaded_tree(&meta.root_node_id, &nodes)?;
    if visited.len() != nodes.len() {
        let mut orphaned = nodes
            .iter()
            .filter(|node| !visited.contains(&node.node_id))
            .map(|node| node.node_id.clone())
            .collect::<Vec<_>>();
        orphaned.sort();
        return Err(ContextDbError::Corrupt(format!(
            "Context '{}' contains Nodes unreachable from root '{}': {}",
            meta.context_id,
            meta.root_node_id,
            orphaned.join(", ")
        )));
    }
    let root = nodes
        .iter()
        .find(|node| node.node_id == meta.root_node_id)
        .ok_or_else(|| {
            ContextDbError::Corrupt(format!(
                "Context '{}' root Node '{}' is missing",
                meta.context_id, meta.root_node_id
            ))
        })?;
    if root.parent_id.is_some() {
        return Err(ContextDbError::Corrupt(format!(
            "Context '{}' root Node has a parent",
            meta.context_id
        )));
    }
    if root.subtree_hash != meta.root_hash {
        return Err(ContextDbError::Corrupt(format!(
            "Context '{}' root hash does not match its root Node",
            meta.context_id
        )));
    }
    Ok(ContextSnapshot {
        context_id: meta.context_id,
        tenant_id: meta.tenant_id,
        agent_id: meta.agent_id,
        revision: meta.revision,
        root_node_id: meta.root_node_id,
        root_hash: meta.root_hash,
        canonical_sexpr,
        nodes: nodes.iter().map(StoredNode::public_record).collect(),
    })
}

fn render_loaded_tree(
    root_node_id: &str,
    nodes: &[StoredNode],
) -> ContextDbResult<(String, HashSet<String>)> {
    let by_id = nodes
        .iter()
        .map(|node| (node.node_id.clone(), node))
        .collect::<HashMap<_, _>>();
    let mut children = HashMap::<Option<String>, Vec<&StoredNode>>::new();
    for node in nodes {
        children
            .entry(node.parent_id.clone())
            .or_default()
            .push(node);
    }
    for values in children.values_mut() {
        values.sort_by(|left, right| {
            left.order_key
                .cmp(&right.order_key)
                .then_with(|| left.node_id.cmp(&right.node_id))
        });
    }
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    let rendered = render_loaded_node(
        root_node_id,
        &by_id,
        &children,
        &mut visiting,
        &mut visited,
        0,
    )?;
    Ok((rendered.to_string(), visited))
}

fn render_loaded_node(
    node_id: &str,
    by_id: &HashMap<String, &StoredNode>,
    children: &HashMap<Option<String>, Vec<&StoredNode>>,
    visiting: &mut HashSet<String>,
    visited: &mut HashSet<String>,
    depth: usize,
) -> ContextDbResult<SExpr> {
    if depth > MAX_TREE_DEPTH {
        return Err(ContextDbError::Corrupt(format!(
            "Context tree exceeds {MAX_TREE_DEPTH} levels"
        )));
    }
    if !visiting.insert(node_id.to_string()) {
        return Err(ContextDbError::Corrupt(format!(
            "Context tree contains a cycle at Node '{node_id}'"
        )));
    }
    let node = by_id.get(node_id).ok_or_else(|| {
        ContextDbError::Corrupt(format!("Context tree references missing Node '{node_id}'"))
    })?;
    let parsed = sexpr::parse(&node.body_sexpr)?;
    let SExpr::List(mut items) = parsed else {
        return Err(ContextDbError::Corrupt(format!(
            "Node '{node_id}' body is not a list"
        )));
    };
    if let Some(child_nodes) = children.get(&Some(node_id.to_string())) {
        for child in child_nodes {
            items.push(render_loaded_node(
                &child.node_id,
                by_id,
                children,
                visiting,
                visited,
                depth + 1,
            )?);
        }
    }
    visiting.remove(node_id);
    visited.insert(node_id.to_string());
    Ok(SExpr::List(items))
}

async fn load_node_tx(
    transaction: &mut sqlx::Transaction<'_, Sqlite>,
    context_id: &str,
    node_id: &str,
) -> ContextDbResult<StoredNode> {
    let row = sqlx::query(
        r#"SELECT node_id, parent_id, order_key, owner_domain, node_revision,
                  body_sexpr, content_hash, subtree_hash
           FROM experimental_contextdb_nodes
           WHERE context_id = ? AND node_id = ?"#,
    )
    .bind(context_id)
    .bind(node_id)
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or_else(|| ContextDbError::NotFound(format!("Node '{node_id}'")))?;
    stored_node_from_row(&row)
}

async fn load_child_hashes_tx(
    transaction: &mut sqlx::Transaction<'_, Sqlite>,
    context_id: &str,
    parent_id: &str,
) -> ContextDbResult<Vec<(i64, String, String)>> {
    let rows = sqlx::query(
        r#"SELECT order_key, node_id, subtree_hash
           FROM experimental_contextdb_nodes
           WHERE context_id = ? AND parent_id = ?
           ORDER BY order_key, node_id"#,
    )
    .bind(context_id)
    .bind(parent_id)
    .fetch_all(&mut **transaction)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            (
                row.get::<i64, _>("order_key"),
                row.get::<String, _>("node_id"),
                row.get::<String, _>("subtree_hash"),
            )
        })
        .collect())
}

async fn node_exists_tx(
    transaction: &mut sqlx::Transaction<'_, Sqlite>,
    context_id: &str,
    node_id: &str,
) -> ContextDbResult<bool> {
    Ok(sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(*) FROM experimental_contextdb_nodes
           WHERE context_id = ? AND node_id = ?"#,
    )
    .bind(context_id)
    .bind(node_id)
    .fetch_one(&mut **transaction)
    .await?
        > 0)
}

async fn apply_operation(
    transaction: &mut sqlx::Transaction<'_, Sqlite>,
    context_id: &str,
    root_node_id: &str,
    authority: &ContextAuthority,
    operation: &ContextOperation,
    dirty_hash_nodes: &mut BTreeSet<String>,
    changed_node_ids: &mut BTreeSet<String>,
) -> ContextDbResult<()> {
    match operation {
        ContextOperation::InsertNode { node } => {
            validate_identifier("node.node_id", &node.node_id)?;
            let parent_id = node.parent_id.as_deref().ok_or_else(|| {
                ContextDbError::Invalid("only Context creation may insert a root Node".to_string())
            })?;
            validate_identifier("node.parent_id", parent_id)?;
            if node_exists_tx(transaction, context_id, &node.node_id).await? {
                return Err(ContextDbError::AlreadyExists(format!(
                    "Node '{}'",
                    node.node_id
                )));
            }
            let parent = load_node_tx(transaction, context_id, parent_id).await?;
            authority.require(node.owner_domain)?;
            if parent.owner_domain != node.owner_domain {
                authority.require(parent.owner_domain)?;
            }
            let body_sexpr = node.body_sexpr.clone();
            let content_hash = digest_bytes(body_sexpr.as_bytes());
            let subtree_hash =
                calculate_subtree_hash(&node.node_id, node.owner_domain, &body_sexpr, &[]);
            sqlx::query(
                r#"INSERT INTO experimental_contextdb_nodes
                   (context_id, node_id, parent_id, order_key, owner_domain,
                    node_revision, body_sexpr, content_hash, subtree_hash)
                   VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)"#,
            )
            .bind(context_id)
            .bind(&node.node_id)
            .bind(parent_id)
            .bind(node.order_key)
            .bind(node.owner_domain.as_str())
            .bind(&body_sexpr)
            .bind(&content_hash)
            .bind(&subtree_hash)
            .execute(&mut **transaction)
            .await?;
            dirty_hash_nodes.insert(parent_id.to_string());
            changed_node_ids.insert(node.node_id.clone());
        }
        ContextOperation::ReplaceNode {
            node_id,
            expected_node_revision,
            body_sexpr,
        } => {
            let current = load_node_tx(transaction, context_id, node_id).await?;
            authority.require(current.owner_domain)?;
            if current.node_revision != *expected_node_revision {
                return Err(ContextDbError::Precondition(format!(
                    "Node '{node_id}' revision is {}, expected {expected_node_revision}",
                    current.node_revision
                )));
            }
            let canonical = body_sexpr.clone();
            let content_hash = digest_bytes(canonical.as_bytes());
            let children = load_child_hashes_tx(transaction, context_id, node_id).await?;
            let subtree_hash =
                calculate_subtree_hash(node_id, current.owner_domain, &canonical, &children);
            let next_node_revision = current
                .node_revision
                .checked_add(1)
                .ok_or_else(|| ContextDbError::Invalid("Node revision overflow".to_string()))?;
            sqlx::query(
                r#"UPDATE experimental_contextdb_nodes
                   SET node_revision = ?, body_sexpr = ?, content_hash = ?, subtree_hash = ?
                   WHERE context_id = ? AND node_id = ? AND node_revision = ?"#,
            )
            .bind(i64::try_from(next_node_revision).map_err(|_| {
                ContextDbError::Invalid("Node revision exceeds SQLite INTEGER".to_string())
            })?)
            .bind(&canonical)
            .bind(&content_hash)
            .bind(&subtree_hash)
            .bind(context_id)
            .bind(node_id)
            .bind(
                i64::try_from(current.node_revision)
                    .map_err(|_| ContextDbError::Corrupt("invalid Node revision".to_string()))?,
            )
            .execute(&mut **transaction)
            .await?;
            if let Some(parent_id) = current.parent_id {
                dirty_hash_nodes.insert(parent_id);
            }
            changed_node_ids.insert(node_id.clone());
        }
        ContextOperation::DeleteSubtree {
            node_id,
            expected_subtree_hash,
        } => {
            if node_id == root_node_id {
                return Err(ContextDbError::Invalid(
                    "the Context root cannot be retired by DeleteSubtree".to_string(),
                ));
            }
            let target = load_node_tx(transaction, context_id, node_id).await?;
            if target.subtree_hash != *expected_subtree_hash {
                return Err(ContextDbError::Precondition(format!(
                    "Node '{node_id}' subtree changed since it was read"
                )));
            }
            let subtree = load_subtree_tx(transaction, context_id, node_id).await?;
            for node in &subtree {
                authority.require(node.owner_domain)?;
            }
            if let Some(parent_id) = &target.parent_id {
                let parent = load_node_tx(transaction, context_id, parent_id).await?;
                if parent.owner_domain != target.owner_domain {
                    authority.require(parent.owner_domain)?;
                }
                dirty_hash_nodes.insert(parent_id.clone());
            }
            // There is intentionally no Archive or Event append here. With no
            // Recall extension installed, retirement is physical deletion of
            // the active authoritative AST subtree.
            sqlx::query(
                r#"WITH RECURSIVE subtree(node_id) AS (
                       SELECT ?
                   UNION
                   SELECT n.node_id
                       FROM experimental_contextdb_nodes n
                       JOIN subtree s ON n.parent_id = s.node_id
                       WHERE n.context_id = ?
                   )
                   DELETE FROM experimental_contextdb_nodes
                   WHERE context_id = ? AND node_id IN (SELECT node_id FROM subtree)"#,
            )
            .bind(node_id)
            .bind(context_id)
            .bind(context_id)
            .execute(&mut **transaction)
            .await?;
            changed_node_ids.extend(subtree.into_iter().map(|node| node.node_id));
        }
        ContextOperation::MoveSubtree {
            node_id,
            expected_node_revision,
            expected_subtree_hash,
            new_parent_id,
            new_order_key,
        } => {
            if node_id == root_node_id {
                return Err(ContextDbError::Invalid(
                    "the Context root cannot be moved".to_string(),
                ));
            }
            let target = load_node_tx(transaction, context_id, node_id).await?;
            if target.node_revision != *expected_node_revision
                || target.subtree_hash != *expected_subtree_hash
            {
                return Err(ContextDbError::Precondition(format!(
                    "Node '{node_id}' changed since it was read"
                )));
            }
            let subtree = load_subtree_tx(transaction, context_id, node_id).await?;
            for node in &subtree {
                authority.require(node.owner_domain)?;
            }
            let new_parent = load_node_tx(transaction, context_id, new_parent_id).await?;
            authority.require(new_parent.owner_domain)?;
            ensure_move_is_acyclic(transaction, context_id, node_id, new_parent_id).await?;
            if let Some(old_parent_id) = &target.parent_id {
                let old_parent = load_node_tx(transaction, context_id, old_parent_id).await?;
                authority.require(old_parent.owner_domain)?;
                dirty_hash_nodes.insert(old_parent_id.clone());
            }
            let next_node_revision = target
                .node_revision
                .checked_add(1)
                .ok_or_else(|| ContextDbError::Invalid("Node revision overflow".to_string()))?;
            sqlx::query(
                r#"UPDATE experimental_contextdb_nodes
                   SET parent_id = ?, order_key = ?, node_revision = ?
                   WHERE context_id = ? AND node_id = ? AND node_revision = ?"#,
            )
            .bind(new_parent_id)
            .bind(new_order_key)
            .bind(i64::try_from(next_node_revision).map_err(|_| {
                ContextDbError::Invalid("Node revision exceeds SQLite INTEGER".to_string())
            })?)
            .bind(context_id)
            .bind(node_id)
            .bind(
                i64::try_from(target.node_revision)
                    .map_err(|_| ContextDbError::Corrupt("invalid Node revision".to_string()))?,
            )
            .execute(&mut **transaction)
            .await?;
            dirty_hash_nodes.insert(new_parent_id.clone());
            changed_node_ids.insert(node_id.clone());
        }
    }
    Ok(())
}

async fn load_subtree_tx(
    transaction: &mut sqlx::Transaction<'_, Sqlite>,
    context_id: &str,
    root_node_id: &str,
) -> ContextDbResult<Vec<StoredNode>> {
    let rows = sqlx::query(
        r#"WITH RECURSIVE subtree(node_id) AS (
               SELECT ?
               UNION
               SELECT n.node_id
               FROM experimental_contextdb_nodes n
               JOIN subtree s ON n.parent_id = s.node_id
               WHERE n.context_id = ?
           )
           SELECT node_id, parent_id, order_key, owner_domain, node_revision,
                  body_sexpr, content_hash, subtree_hash
           FROM experimental_contextdb_nodes
           WHERE context_id = ? AND node_id IN (SELECT node_id FROM subtree)"#,
    )
    .bind(root_node_id)
    .bind(context_id)
    .bind(context_id)
    .fetch_all(&mut **transaction)
    .await?;
    rows.iter().map(stored_node_from_row).collect()
}

async fn ensure_move_is_acyclic(
    transaction: &mut sqlx::Transaction<'_, Sqlite>,
    context_id: &str,
    node_id: &str,
    new_parent_id: &str,
) -> ContextDbResult<()> {
    let mut current = Some(new_parent_id.to_string());
    let mut visited = HashSet::new();
    for _ in 0..=MAX_TREE_DEPTH {
        let Some(candidate) = current else {
            return Ok(());
        };
        if candidate == node_id {
            return Err(ContextDbError::Invalid(format!(
                "moving Node '{node_id}' below '{new_parent_id}' would create a cycle"
            )));
        }
        if !visited.insert(candidate.clone()) {
            return Err(ContextDbError::Corrupt(format!(
                "existing parent chain contains a cycle at Node '{candidate}'"
            )));
        }
        current = sqlx::query_scalar::<_, Option<String>>(
            r#"SELECT parent_id FROM experimental_contextdb_nodes
               WHERE context_id = ? AND node_id = ?"#,
        )
        .bind(context_id)
        .bind(&candidate)
        .fetch_optional(&mut **transaction)
        .await?
        .ok_or_else(|| ContextDbError::NotFound(format!("Node '{candidate}'")))?;
    }
    Err(ContextDbError::Corrupt(format!(
        "parent chain exceeds {MAX_TREE_DEPTH} levels"
    )))
}

async fn recompute_dirty_hashes(
    transaction: &mut sqlx::Transaction<'_, Sqlite>,
    context_id: &str,
    root_node_id: &str,
    dirty: BTreeSet<String>,
) -> ContextDbResult<String> {
    if dirty.is_empty() {
        return Ok(load_node_tx(transaction, context_id, root_node_id)
            .await?
            .subtree_hash);
    }

    // Resolve the complete dirty ancestor closure in one indexed recursive
    // query.  This keeps a leaf mutation proportional to tree depth without
    // reading unrelated Context bodies or issuing one SELECT per ancestor.
    let mut affected_query = QueryBuilder::<Sqlite>::new("WITH RECURSIVE requested(node_id) AS (");
    for (index, node_id) in dirty.iter().enumerate() {
        if index > 0 {
            affected_query.push(" UNION ALL ");
        }
        affected_query.push("SELECT ").push_bind(node_id);
    }
    affected_query
        .push(
            r#"), ancestors(node_id, parent_id) AS (
                   SELECT n.node_id, n.parent_id
                   FROM experimental_contextdb_nodes n
                   JOIN requested r ON r.node_id = n.node_id
                   WHERE n.context_id = "#,
        )
        .push_bind(context_id)
        .push(
            r#"
                   UNION
                   SELECT p.node_id, p.parent_id
                   FROM experimental_contextdb_nodes p
                   JOIN ancestors child ON child.parent_id = p.node_id
                   WHERE p.context_id = "#,
        )
        .push_bind(context_id)
        .push(
            r#"
               )
               SELECT n.node_id, n.parent_id, n.order_key, n.owner_domain,
                      n.node_revision, n.body_sexpr, n.content_hash, n.subtree_hash
               FROM experimental_contextdb_nodes n
               JOIN ancestors a ON a.node_id = n.node_id
               WHERE n.context_id = "#,
        )
        .push_bind(context_id);
    let affected_rows = affected_query.build().fetch_all(&mut **transaction).await?;
    let affected = affected_rows
        .iter()
        .map(stored_node_from_row)
        .collect::<ContextDbResult<Vec<_>>>()?
        .into_iter()
        .map(|node| (node.node_id.clone(), node))
        .collect::<HashMap<_, _>>();

    if affected.is_empty() {
        return Ok(load_node_tx(transaction, context_id, root_node_id)
            .await?
            .subtree_hash);
    }

    // Fetch the immediate child descriptors for every affected ancestor in a
    // second batched query.  Unaffected subtrees are represented solely by
    // their stored Merkle root; their bodies are never loaded or rewritten.
    let mut children_query = QueryBuilder::<Sqlite>::new(
        r#"SELECT parent_id, order_key, node_id, subtree_hash
           FROM experimental_contextdb_nodes
           WHERE context_id = "#,
    );
    children_query
        .push_bind(context_id)
        .push(" AND parent_id IN (");
    {
        let mut parent_ids = children_query.separated(", ");
        for node_id in affected.keys() {
            parent_ids.push_bind(node_id);
        }
    }
    children_query.push(") ORDER BY parent_id, order_key, node_id");
    let child_rows = children_query.build().fetch_all(&mut **transaction).await?;
    let mut children = HashMap::<String, Vec<(i64, String, String)>>::new();
    for row in child_rows {
        children
            .entry(row.get::<String, _>("parent_id"))
            .or_default()
            .push((
                row.get::<i64, _>("order_key"),
                row.get::<String, _>("node_id"),
                row.get::<String, _>("subtree_hash"),
            ));
    }

    let mut depth_cache = HashMap::new();
    let mut ordered = affected.keys().cloned().collect::<Vec<_>>();
    for node_id in &ordered {
        let mut visiting = HashSet::new();
        affected_node_depth(node_id, &affected, &mut depth_cache, &mut visiting)?;
    }
    ordered.sort_by(|left, right| {
        depth_cache
            .get(right)
            .cmp(&depth_cache.get(left))
            .then_with(|| left.cmp(right))
    });

    let mut computed = HashMap::<String, String>::new();
    for node_id in ordered {
        let node = affected.get(&node_id).ok_or_else(|| {
            ContextDbError::Corrupt(format!("affected Node '{node_id}' disappeared"))
        })?;
        let mut child_hashes = children.remove(&node_id).unwrap_or_default();
        for (_, child_id, child_hash) in &mut child_hashes {
            if let Some(updated_hash) = computed.get(child_id) {
                *child_hash = updated_hash.clone();
            }
        }
        let subtree_hash = calculate_subtree_hash(
            &node.node_id,
            node.owner_domain,
            &node.body_sexpr,
            &child_hashes,
        );
        if subtree_hash != node.subtree_hash {
            sqlx::query(
                r#"UPDATE experimental_contextdb_nodes SET subtree_hash = ?
                   WHERE context_id = ? AND node_id = ?"#,
            )
            .bind(&subtree_hash)
            .bind(context_id)
            .bind(&node_id)
            .execute(&mut **transaction)
            .await?;
        }
        computed.insert(node_id, subtree_hash);
    }

    if let Some(root_hash) = computed.remove(root_node_id) {
        Ok(root_hash)
    } else {
        Ok(load_node_tx(transaction, context_id, root_node_id)
            .await?
            .subtree_hash)
    }
}

fn affected_node_depth(
    node_id: &str,
    affected: &HashMap<String, StoredNode>,
    cache: &mut HashMap<String, usize>,
    visiting: &mut HashSet<String>,
) -> ContextDbResult<usize> {
    if let Some(depth) = cache.get(node_id) {
        return Ok(*depth);
    }
    if !visiting.insert(node_id.to_string()) {
        return Err(ContextDbError::Corrupt(format!(
            "parent chain contains a cycle at Node '{node_id}'"
        )));
    }
    let node = affected
        .get(node_id)
        .ok_or_else(|| ContextDbError::Corrupt(format!("affected Node '{node_id}' is missing")))?;
    let depth = match &node.parent_id {
        Some(parent_id) => {
            if !affected.contains_key(parent_id) {
                return Err(ContextDbError::Corrupt(format!(
                    "affected ancestor closure omits parent '{parent_id}' of Node '{node_id}'"
                )));
            }
            affected_node_depth(parent_id, affected, cache, visiting)?
                .checked_add(1)
                .ok_or_else(|| ContextDbError::Corrupt("Node depth overflow".to_string()))?
        }
        None => 0,
    };
    if depth > MAX_TREE_DEPTH {
        return Err(ContextDbError::Corrupt(format!(
            "parent chain exceeds {MAX_TREE_DEPTH} levels"
        )));
    }
    visiting.remove(node_id);
    cache.insert(node_id.to_string(), depth);
    Ok(depth)
}

fn audit_loaded_context(
    meta: ContextMeta,
    nodes: Vec<StoredNode>,
) -> ContextDbResult<ContextIntegrityReport> {
    let by_id = nodes
        .iter()
        .map(|node| (node.node_id.clone(), node))
        .collect::<HashMap<_, _>>();
    let mut children = HashMap::<String, Vec<&StoredNode>>::new();
    for node in &nodes {
        if let Some(parent_id) = &node.parent_id {
            if !by_id.contains_key(parent_id) {
                return Err(ContextDbError::Corrupt(format!(
                    "Node '{}' references missing parent '{parent_id}'",
                    node.node_id
                )));
            }
            children.entry(parent_id.clone()).or_default().push(node);
        }
    }
    for values in children.values_mut() {
        values.sort_by(|left, right| {
            left.order_key
                .cmp(&right.order_key)
                .then_with(|| left.node_id.cmp(&right.node_id))
        });
    }
    let mut visiting = HashSet::new();
    let mut computed = HashMap::new();
    let recomputed_root_hash = audit_node_hash(
        &meta.root_node_id,
        &by_id,
        &children,
        &mut visiting,
        &mut computed,
        0,
    )?;
    let mut mismatched_node_ids = nodes
        .iter()
        .filter(|node| computed.get(&node.node_id) != Some(&node.subtree_hash))
        .map(|node| node.node_id.clone())
        .collect::<Vec<_>>();
    for node in &nodes {
        let canonical_body_matches = canonicalize_body(&node.body_sexpr)
            .map(|(canonical, content_hash)| {
                canonical == node.body_sexpr && content_hash == node.content_hash
            })
            .unwrap_or(false);
        if !canonical_body_matches && !mismatched_node_ids.contains(&node.node_id) {
            mismatched_node_ids.push(node.node_id.clone());
        }
    }
    if computed.len() != nodes.len() {
        mismatched_node_ids.extend(
            nodes
                .iter()
                .filter(|node| !computed.contains_key(&node.node_id))
                .map(|node| node.node_id.clone()),
        );
    }
    mismatched_node_ids.sort();
    mismatched_node_ids.dedup();
    let matches = mismatched_node_ids.is_empty()
        && recomputed_root_hash == meta.root_hash
        && computed.len() == nodes.len();
    Ok(ContextIntegrityReport {
        context_id: meta.context_id,
        revision: meta.revision,
        node_count: nodes.len(),
        root_hash: meta.root_hash,
        recomputed_root_hash,
        mismatched_node_ids,
        matches,
    })
}

fn audit_node_hash(
    node_id: &str,
    by_id: &HashMap<String, &StoredNode>,
    children: &HashMap<String, Vec<&StoredNode>>,
    visiting: &mut HashSet<String>,
    computed: &mut HashMap<String, String>,
    depth: usize,
) -> ContextDbResult<String> {
    if depth > MAX_TREE_DEPTH {
        return Err(ContextDbError::Corrupt(format!(
            "Context tree exceeds {MAX_TREE_DEPTH} levels"
        )));
    }
    if let Some(hash) = computed.get(node_id) {
        return Ok(hash.clone());
    }
    if !visiting.insert(node_id.to_string()) {
        return Err(ContextDbError::Corrupt(format!(
            "Context tree contains a cycle at Node '{node_id}'"
        )));
    }
    let node = by_id.get(node_id).ok_or_else(|| {
        ContextDbError::Corrupt(format!("Context tree references missing Node '{node_id}'"))
    })?;
    let mut child_hashes = Vec::new();
    if let Some(child_nodes) = children.get(node_id) {
        for child in child_nodes {
            child_hashes.push((
                child.order_key,
                child.node_id.clone(),
                audit_node_hash(
                    &child.node_id,
                    by_id,
                    children,
                    visiting,
                    computed,
                    depth + 1,
                )?,
            ));
        }
    }
    let hash = calculate_subtree_hash(
        &node.node_id,
        node.owner_domain,
        &node.body_sexpr,
        &child_hashes,
    );
    visiting.remove(node_id);
    computed.insert(node_id.to_string(), hash.clone());
    Ok(hash)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::experimental::require_enabled;
    use std::sync::Arc;
    use tempfile::TempDir;
    use tokio::sync::Barrier;

    struct TestStore {
        _directory: TempDir,
        path: std::path::PathBuf,
        store: SqliteContextDb,
    }

    impl TestStore {
        async fn new() -> Self {
            let directory = tempfile::tempdir().expect("temporary ContextDB directory");
            let path = directory.path().join("context.db");
            let store = SqliteContextDb::open(&path, context_db_permit())
                .await
                .expect("open experimental ContextDB");
            Self {
                _directory: directory,
                path,
                store,
            }
        }
    }

    fn context_db_permit() -> ExperimentalFeaturePermit {
        let enabled = BTreeSet::from([CONTEXT_DB.to_string()]);
        require_enabled(&enabled, CONTEXT_DB).expect("test enabled ContextDB feature")
    }

    fn authority(
        actor_id: &str,
        domains: impl IntoIterator<Item = AuthorityDomain>,
    ) -> ContextAuthority {
        ContextAuthority::new(actor_id, domains)
    }

    fn all_authority() -> ContextAuthority {
        authority(
            "bootstrap",
            [
                AuthorityDomain::RuntimeInput,
                AuthorityDomain::AgentMind,
                AuthorityDomain::RuntimeControl,
                AuthorityDomain::AgentControl,
                AuthorityDomain::SystemPolicy,
            ],
        )
    }

    fn agent_authority() -> ContextAuthority {
        authority(
            "agent",
            [AuthorityDomain::AgentMind, AuthorityDomain::AgentControl],
        )
    }

    fn runtime_authority() -> ContextAuthority {
        authority(
            "runtime",
            [
                AuthorityDomain::RuntimeInput,
                AuthorityDomain::RuntimeControl,
            ],
        )
    }

    fn node(
        node_id: &str,
        parent_id: Option<&str>,
        order_key: i64,
        owner_domain: AuthorityDomain,
        body_sexpr: impl Into<String>,
    ) -> ContextNodeDraft {
        ContextNodeDraft {
            node_id: node_id.to_string(),
            parent_id: parent_id.map(str::to_string),
            order_key,
            owner_domain,
            body_sexpr: body_sexpr.into(),
        }
    }

    fn transaction(
        context_id: &str,
        base_revision: u64,
        key: &str,
        authority: ContextAuthority,
        operations: Vec<ContextOperation>,
    ) -> ContextTransaction {
        ContextTransaction {
            transaction_id: format!("transaction-{key}"),
            idempotency_key: key.to_string(),
            context_id: context_id.to_string(),
            base_revision,
            authority,
            operations,
        }
    }

    async fn create_context(store: &SqliteContextDb, context_id: &str) -> ContextSnapshot {
        store
            .create_context(CreateContextRequest {
                context_id: context_id.to_string(),
                tenant_id: "tenant-a".to_string(),
                agent_id: "agent-a".to_string(),
                authority: all_authority(),
                root: node(
                    "root",
                    None,
                    0,
                    AuthorityDomain::SystemPolicy,
                    "(context (protocol (version 1)))",
                ),
            })
            .await
            .expect("create Context")
    }

    async fn create_mind_with_frames(
        store: &SqliteContextDb,
        context_id: &str,
        frame_count: usize,
    ) -> ContextSnapshot {
        let initial = create_context(store, context_id).await;
        let mut operations = vec![
            ContextOperation::InsertNode {
                node: node(
                    "inbox",
                    Some("root"),
                    10,
                    AuthorityDomain::RuntimeInput,
                    "(inbox)",
                ),
            },
            ContextOperation::InsertNode {
                node: node(
                    "mind",
                    Some("root"),
                    20,
                    AuthorityDomain::AgentMind,
                    "(mind)",
                ),
            },
            ContextOperation::InsertNode {
                node: node(
                    "runtime",
                    Some("root"),
                    30,
                    AuthorityDomain::RuntimeControl,
                    "(runtime)",
                ),
            },
        ];
        for index in 0..frame_count {
            operations.push(ContextOperation::InsertNode {
                node: node(
                    &format!("frame-{index}"),
                    Some("mind"),
                    i64::try_from(index).expect("frame index"),
                    AuthorityDomain::AgentMind,
                    format!("(frame (value initial-{index}))"),
                ),
            });
        }
        store
            .apply_transaction(transaction(
                context_id,
                initial.revision,
                "bootstrap",
                all_authority(),
                operations,
            ))
            .await
            .expect("bootstrap Context tree");
        store
            .get_context(context_id)
            .await
            .expect("read bootstrapped Context")
    }

    fn replace_frame(
        context_id: &str,
        base_revision: u64,
        key: &str,
        frame_id: &str,
        expected_node_revision: u64,
        value: &str,
    ) -> ContextTransaction {
        transaction(
            context_id,
            base_revision,
            key,
            agent_authority(),
            vec![ContextOperation::ReplaceNode {
                node_id: frame_id.to_string(),
                expected_node_revision,
                body_sexpr: format!("(frame (value {value}))"),
            }],
        )
    }

    #[tokio::test]
    async fn creates_a_canonical_authoritative_context_ast() {
        let harness = TestStore::new().await;
        let snapshot = create_mind_with_frames(&harness.store, "canonical", 0).await;

        assert_eq!(snapshot.revision, 2);
        assert_eq!(snapshot.root_node_id, "root");
        assert_eq!(
            snapshot.canonical_sexpr,
            "(context (protocol (version 1)) (inbox) (mind) (runtime))"
        );
        assert_eq!(snapshot.node("root").unwrap().node_revision, 1);
        assert_eq!(snapshot.nodes.len(), 4);

        let report = harness.store.audit_context("canonical").await.unwrap();
        assert!(report.matches, "{report:?}");
        assert_eq!(report.node_count, 4);
        assert_eq!(report.root_hash, snapshot.root_hash);
    }

    #[tokio::test]
    async fn local_replace_updates_only_the_target_and_ancestor_path() {
        let harness = TestStore::new().await;
        let before = create_mind_with_frames(&harness.store, "locality", 2).await;
        let untouched_before = before.node("frame-1").unwrap().clone();

        sqlx::query(
            r#"CREATE TABLE test_contextdb_node_updates (
                   node_id TEXT NOT NULL
               )"#,
        )
        .execute(&harness.store.pool)
        .await
        .unwrap();
        sqlx::query(
            r#"CREATE TRIGGER test_contextdb_track_node_updates
               AFTER UPDATE ON experimental_contextdb_nodes
               BEGIN
                 INSERT INTO test_contextdb_node_updates(node_id) VALUES (NEW.node_id);
               END"#,
        )
        .execute(&harness.store.pool)
        .await
        .unwrap();

        let receipt = harness
            .store
            .apply_transaction(replace_frame(
                "locality",
                before.revision,
                "replace-frame-0",
                "frame-0",
                1,
                "changed",
            ))
            .await
            .unwrap();
        assert_eq!(receipt.changed_node_ids, vec!["frame-0"]);

        let updated = sqlx::query_scalar::<_, String>(
            "SELECT node_id FROM test_contextdb_node_updates ORDER BY rowid",
        )
        .fetch_all(&harness.store.pool)
        .await
        .unwrap();
        assert_eq!(updated, vec!["frame-0", "mind", "root"]);

        let after = harness.store.get_context("locality").await.unwrap();
        assert_eq!(after.revision, before.revision + 1);
        assert_eq!(after.node("frame-0").unwrap().node_revision, 2);
        assert_eq!(after.node("frame-1").unwrap(), &untouched_before);
        assert_ne!(after.root_hash, before.root_hash);
        assert!(after.canonical_sexpr.contains("(value changed)"));
        assert!(
            harness
                .store
                .audit_context("locality")
                .await
                .unwrap()
                .matches
        );
    }

    #[tokio::test]
    async fn stale_disjoint_writes_rebase_but_related_writes_conflict() {
        let harness = TestStore::new().await;
        let base = create_mind_with_frames(&harness.store, "occ", 2).await;

        let first = harness
            .store
            .apply_transaction(replace_frame(
                "occ",
                base.revision,
                "first",
                "frame-0",
                1,
                "first",
            ))
            .await
            .unwrap();
        assert!(!first.rebased);

        let disjoint = harness
            .store
            .apply_transaction(replace_frame(
                "occ",
                base.revision,
                "disjoint",
                "frame-1",
                1,
                "disjoint",
            ))
            .await
            .unwrap();
        assert!(disjoint.rebased);
        assert_eq!(disjoint.before_revision, first.after_revision);

        let related = harness
            .store
            .apply_transaction(replace_frame(
                "occ",
                base.revision,
                "related",
                "frame-0",
                1,
                "lost-update",
            ))
            .await;
        assert!(matches!(related, Err(ContextDbError::Precondition(_))));

        let final_snapshot = harness.store.get_context("occ").await.unwrap();
        assert_eq!(final_snapshot.revision, disjoint.after_revision);
        assert!(final_snapshot.canonical_sexpr.contains("(value first)"));
        assert!(final_snapshot.canonical_sexpr.contains("(value disjoint)"));
        assert!(!final_snapshot.canonical_sexpr.contains("lost-update"));
    }

    #[tokio::test]
    async fn idempotency_is_exact_and_failed_multi_operation_transactions_roll_back() {
        let harness = TestStore::new().await;
        let base = create_mind_with_frames(&harness.store, "idempotency", 2).await;
        let request = replace_frame(
            "idempotency",
            base.revision,
            "same-request",
            "frame-0",
            1,
            "once",
        );

        let committed = harness
            .store
            .apply_transaction(request.clone())
            .await
            .unwrap();
        let replayed = harness
            .store
            .apply_transaction(request.clone())
            .await
            .unwrap();
        assert_eq!(replayed.after_revision, committed.after_revision);
        assert_eq!(replayed.root_hash, committed.root_hash);
        assert!(replayed.idempotent_replay);

        let mut equivalent = request.clone();
        equivalent.operations = vec![ContextOperation::ReplaceNode {
            node_id: "frame-0".to_string(),
            expected_node_revision: 1,
            body_sexpr: "  ( frame   ( value once ) )  ".to_string(),
        }];
        let equivalent_replay = harness.store.apply_transaction(equivalent).await.unwrap();
        assert!(equivalent_replay.idempotent_replay);
        assert_eq!(equivalent_replay.after_revision, committed.after_revision);

        let mut reused = request;
        reused.operations = vec![ContextOperation::ReplaceNode {
            node_id: "frame-1".to_string(),
            expected_node_revision: 1,
            body_sexpr: "(frame (value different-request))".to_string(),
        }];
        assert!(matches!(
            harness.store.apply_transaction(reused).await,
            Err(ContextDbError::IdempotencyReuse(key)) if key == "same-request"
        ));

        let before_failed = harness.store.get_context("idempotency").await.unwrap();
        let failed = transaction(
            "idempotency",
            before_failed.revision,
            "must-rollback",
            agent_authority(),
            vec![
                ContextOperation::ReplaceNode {
                    node_id: "frame-1".to_string(),
                    expected_node_revision: 1,
                    body_sexpr: "(frame (value must-not-commit))".to_string(),
                },
                ContextOperation::ReplaceNode {
                    node_id: "frame-0".to_string(),
                    expected_node_revision: 999,
                    body_sexpr: "(frame (value impossible))".to_string(),
                },
            ],
        );
        assert!(matches!(
            harness.store.apply_transaction(failed).await,
            Err(ContextDbError::Precondition(_))
        ));
        let after_failed = harness.store.get_context("idempotency").await.unwrap();
        assert_eq!(after_failed, before_failed);

        let stats = harness.store.inspect_context("idempotency").await.unwrap();
        assert_eq!(stats.receipt_count, 2); // bootstrap + the one committed request
    }

    #[tokio::test]
    async fn authority_domains_protect_runtime_and_cross_domain_structure() {
        let harness = TestStore::new().await;
        let base = create_mind_with_frames(&harness.store, "authority", 1).await;

        let denied = transaction(
            "authority",
            base.revision,
            "agent-cannot-write-inbox",
            agent_authority(),
            vec![ContextOperation::ReplaceNode {
                node_id: "inbox".to_string(),
                expected_node_revision: 1,
                body_sexpr: "(inbox (forged true))".to_string(),
            }],
        );
        assert!(matches!(
            harness.store.apply_transaction(denied).await,
            Err(ContextDbError::AuthorityDenied {
                domain: AuthorityDomain::RuntimeInput,
                ..
            })
        ));

        let cross_domain_insert = transaction(
            "authority",
            base.revision,
            "runtime-cannot-hide-under-mind",
            runtime_authority(),
            vec![ContextOperation::InsertNode {
                node: node(
                    "runtime-under-mind",
                    Some("mind"),
                    99,
                    AuthorityDomain::RuntimeControl,
                    "(runtime-state)",
                ),
            }],
        );
        assert!(matches!(
            harness.store.apply_transaction(cross_domain_insert).await,
            Err(ContextDbError::AuthorityDenied {
                domain: AuthorityDomain::AgentMind,
                ..
            })
        ));

        let allowed = transaction(
            "authority",
            base.revision,
            "runtime-writes-inbox",
            runtime_authority(),
            vec![ContextOperation::ReplaceNode {
                node_id: "inbox".to_string(),
                expected_node_revision: 1,
                body_sexpr: "(inbox (observation accepted))".to_string(),
            }],
        );
        harness.store.apply_transaction(allowed).await.unwrap();
        let snapshot = harness.store.get_context("authority").await.unwrap();
        assert!(snapshot.canonical_sexpr.contains("(observation accepted)"));
        assert!(!snapshot.canonical_sexpr.contains("forged"));
        assert_eq!(snapshot.revision, base.revision + 1);
    }

    #[tokio::test]
    async fn move_and_physical_retire_preserve_tree_integrity_without_event_history() {
        let harness = TestStore::new().await;
        let base = create_mind_with_frames(&harness.store, "lifecycle", 1).await;
        let inserted = harness
            .store
            .apply_transaction(transaction(
                "lifecycle",
                base.revision,
                "insert-branch",
                all_authority(),
                vec![
                    ContextOperation::InsertNode {
                        node: node(
                            "branch",
                            Some("mind"),
                            50,
                            AuthorityDomain::AgentMind,
                            "(branch)",
                        ),
                    },
                    ContextOperation::InsertNode {
                        node: node(
                            "branch-leaf",
                            Some("branch"),
                            0,
                            AuthorityDomain::AgentMind,
                            "(leaf (value transient))",
                        ),
                    },
                ],
            ))
            .await
            .unwrap();
        let before_move = harness.store.get_context("lifecycle").await.unwrap();
        let branch_before = before_move.node("branch").unwrap().clone();

        harness
            .store
            .apply_transaction(transaction(
                "lifecycle",
                inserted.after_revision,
                "move-branch",
                all_authority(),
                vec![ContextOperation::MoveSubtree {
                    node_id: "branch".to_string(),
                    expected_node_revision: branch_before.node_revision,
                    expected_subtree_hash: branch_before.subtree_hash.clone(),
                    new_parent_id: "runtime".to_string(),
                    new_order_key: 5,
                }],
            ))
            .await
            .unwrap();
        let moved = harness.store.get_context("lifecycle").await.unwrap();
        let moved_branch = moved.node("branch").unwrap();
        assert_eq!(moved_branch.parent_id.as_deref(), Some("runtime"));
        assert_eq!(moved_branch.node_revision, branch_before.node_revision + 1);
        assert_eq!(moved_branch.subtree_hash, branch_before.subtree_hash);

        harness
            .store
            .apply_transaction(transaction(
                "lifecycle",
                moved.revision,
                "retire-branch",
                all_authority(),
                vec![ContextOperation::DeleteSubtree {
                    node_id: "branch".to_string(),
                    expected_subtree_hash: moved_branch.subtree_hash.clone(),
                }],
            ))
            .await
            .unwrap();
        let retired = harness.store.get_context("lifecycle").await.unwrap();
        assert!(retired.node("branch").is_none());
        assert!(retired.node("branch-leaf").is_none());
        assert!(!retired.canonical_sexpr.contains("transient"));
        assert!(
            harness
                .store
                .audit_context("lifecycle")
                .await
                .unwrap()
                .matches
        );

        let application_history_tables = sqlx::query_scalar::<_, String>(
            r#"SELECT name FROM sqlite_master
               WHERE type = 'table'
                 AND (lower(name) LIKE '%event%'
                      OR lower(name) LIKE '%archive%'
                      OR lower(name) LIKE '%history%')"#,
        )
        .fetch_all(&harness.store.pool)
        .await
        .unwrap();
        assert!(application_history_tables.is_empty());
    }

    #[tokio::test]
    async fn committed_context_survives_store_reopen_exactly() {
        let harness = TestStore::new().await;
        let before = create_mind_with_frames(&harness.store, "restart", 3).await;
        harness.store.close().await;

        let reopened = SqliteContextDb::open(&harness.path, context_db_permit())
            .await
            .unwrap();
        let after = reopened.get_context("restart").await.unwrap();
        assert_eq!(after, before);
        assert!(reopened.audit_context("restart").await.unwrap().matches);
        reopened.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_disjoint_updates_commit_and_same_node_races_conflict() {
        const WRITERS: usize = 24;
        let harness = TestStore::new().await;
        let base = create_mind_with_frames(&harness.store, "concurrent", WRITERS).await;
        let barrier = Arc::new(Barrier::new(WRITERS));
        let mut tasks = Vec::new();
        for index in 0..WRITERS {
            let store = harness.store.clone();
            let barrier = Arc::clone(&barrier);
            tasks.push(tokio::spawn(async move {
                barrier.wait().await;
                store
                    .apply_transaction(replace_frame(
                        "concurrent",
                        base.revision,
                        &format!("disjoint-{index}"),
                        &format!("frame-{index}"),
                        1,
                        &format!("committed-{index}"),
                    ))
                    .await
            }));
        }
        for task in tasks {
            task.await.unwrap().unwrap();
        }
        let after_disjoint = harness.store.get_context("concurrent").await.unwrap();
        assert_eq!(after_disjoint.revision, base.revision + WRITERS as u64);
        for index in 0..WRITERS {
            assert!(after_disjoint
                .canonical_sexpr
                .contains(&format!("(value committed-{index})")));
        }

        const RACERS: usize = 8;
        let race_base = after_disjoint.revision;
        let expected_node_revision = after_disjoint.node("frame-0").unwrap().node_revision;
        let barrier = Arc::new(Barrier::new(RACERS));
        let mut racers = Vec::new();
        for index in 0..RACERS {
            let store = harness.store.clone();
            let barrier = Arc::clone(&barrier);
            racers.push(tokio::spawn(async move {
                barrier.wait().await;
                store
                    .apply_transaction(replace_frame(
                        "concurrent",
                        race_base,
                        &format!("same-node-{index}"),
                        "frame-0",
                        expected_node_revision,
                        &format!("winner-{index}"),
                    ))
                    .await
            }));
        }
        let mut successes = 0;
        let mut conflicts = 0;
        for racer in racers {
            match racer.await.unwrap() {
                Ok(_) => successes += 1,
                Err(ContextDbError::Precondition(_)) => conflicts += 1,
                Err(error) => panic!("unexpected race result: {error}"),
            }
        }
        assert_eq!(successes, 1);
        assert_eq!(conflicts, RACERS - 1);
        let final_snapshot = harness.store.get_context("concurrent").await.unwrap();
        assert_eq!(final_snapshot.revision, race_base + 1);
        assert!(
            harness
                .store
                .audit_context("concurrent")
                .await
                .unwrap()
                .matches
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_reads_never_mix_context_head_and_node_versions() {
        let harness = TestStore::new().await;
        let base = create_mind_with_frames(&harness.store, "snapshot", 1).await;
        let writer_store = harness.store.clone();
        let writer = tokio::spawn(async move {
            let mut context_revision = base.revision;
            for (node_revision, iteration) in (1_u64..).zip(0..40) {
                let receipt = writer_store
                    .apply_transaction(replace_frame(
                        "snapshot",
                        context_revision,
                        &format!("snapshot-write-{iteration}"),
                        "frame-0",
                        node_revision,
                        &format!("iteration-{iteration}"),
                    ))
                    .await
                    .unwrap();
                context_revision = receipt.after_revision;
            }
        });

        for _ in 0..160 {
            let snapshot = harness.store.get_context("snapshot").await.unwrap();
            let frame_revision = snapshot.node("frame-0").unwrap().node_revision;
            // Bootstrap is Context revision 2 and the Frame starts at Node
            // revision 1. Every later transaction advances both once.
            assert_eq!(snapshot.revision, frame_revision + 1);
        }
        writer.await.unwrap();
    }

    #[tokio::test]
    async fn large_untouched_subtrees_are_not_read_rewritten_or_rehashed() {
        let harness = TestStore::new().await;
        let base = create_mind_with_frames(&harness.store, "large-locality", 1).await;
        let one_megabyte = "x".repeat(1024 * 1024);
        harness
            .store
            .apply_transaction(transaction(
                "large-locality",
                base.revision,
                "insert-large-sibling",
                all_authority(),
                vec![ContextOperation::InsertNode {
                    node: node(
                        "large-sibling",
                        Some("runtime"),
                        0,
                        AuthorityDomain::RuntimeControl,
                        format!("(tool-result \"{one_megabyte}\")"),
                    ),
                }],
            ))
            .await
            .unwrap();
        let before = harness.store.get_context("large-locality").await.unwrap();
        let large_before = before.node("large-sibling").unwrap().clone();
        let stats = harness
            .store
            .inspect_context("large-locality")
            .await
            .unwrap();
        assert!(stats.logical_body_bytes >= 1024 * 1024);

        sqlx::query(r#"CREATE TABLE test_large_contextdb_updates (node_id TEXT NOT NULL)"#)
            .execute(&harness.store.pool)
            .await
            .unwrap();
        sqlx::query(
            r#"CREATE TRIGGER test_large_contextdb_track_updates
               AFTER UPDATE ON experimental_contextdb_nodes
               BEGIN
                 INSERT INTO test_large_contextdb_updates(node_id) VALUES (NEW.node_id);
               END"#,
        )
        .execute(&harness.store.pool)
        .await
        .unwrap();

        harness
            .store
            .apply_transaction(replace_frame(
                "large-locality",
                before.revision,
                "small-change-next-to-large-tree",
                "frame-0",
                1,
                "small-change",
            ))
            .await
            .unwrap();
        let updated_large = sqlx::query_scalar::<_, i64>(
            r#"SELECT COUNT(*) FROM test_large_contextdb_updates
               WHERE node_id = 'large-sibling'"#,
        )
        .fetch_one(&harness.store.pool)
        .await
        .unwrap();
        assert_eq!(updated_large, 0);

        let after = harness.store.get_context("large-locality").await.unwrap();
        assert_eq!(after.node("large-sibling").unwrap(), &large_before);
        assert!(
            harness
                .store
                .audit_context("large-locality")
                .await
                .unwrap()
                .matches
        );
    }

    #[tokio::test]
    async fn integrity_audit_detects_physical_corruption() {
        let harness = TestStore::new().await;
        create_mind_with_frames(&harness.store, "audit", 1).await;
        sqlx::query(
            r#"UPDATE experimental_contextdb_nodes
               SET content_hash = 'corrupt'
               WHERE context_id = 'audit' AND node_id = 'frame-0'"#,
        )
        .execute(&harness.store.pool)
        .await
        .unwrap();

        let report = harness.store.audit_context("audit").await.unwrap();
        assert!(!report.matches);
        assert_eq!(report.mismatched_node_ids, vec!["frame-0"]);
    }

    #[tokio::test]
    async fn invalid_structure_and_future_revisions_leave_no_partial_state() {
        let harness = TestStore::new().await;
        let base = create_mind_with_frames(&harness.store, "invariants", 1).await;

        let duplicate = harness
            .store
            .create_context(CreateContextRequest {
                context_id: "invariants".to_string(),
                tenant_id: "another-tenant".to_string(),
                agent_id: "another-agent".to_string(),
                authority: all_authority(),
                root: node(
                    "another-root",
                    None,
                    0,
                    AuthorityDomain::SystemPolicy,
                    "(context)",
                ),
            })
            .await;
        assert!(matches!(duplicate, Err(ContextDbError::AlreadyExists(_))));

        let future = replace_frame(
            "invariants",
            base.revision + 10,
            "future-revision",
            "frame-0",
            1,
            "future",
        );
        assert!(matches!(
            harness.store.apply_transaction(future).await,
            Err(ContextDbError::Conflict {
                expected,
                actual,
                ..
            }) if expected == base.revision + 10 && actual == base.revision
        ));

        let mind = base.node("mind").unwrap();
        let cycle = transaction(
            "invariants",
            base.revision,
            "cycle",
            all_authority(),
            vec![ContextOperation::MoveSubtree {
                node_id: "mind".to_string(),
                expected_node_revision: mind.node_revision,
                expected_subtree_hash: mind.subtree_hash.clone(),
                new_parent_id: "frame-0".to_string(),
                new_order_key: 0,
            }],
        );
        assert!(matches!(
            harness.store.apply_transaction(cycle).await,
            Err(ContextDbError::Invalid(message)) if message.contains("cycle")
        ));

        let root_delete = transaction(
            "invariants",
            base.revision,
            "delete-root",
            all_authority(),
            vec![ContextOperation::DeleteSubtree {
                node_id: "root".to_string(),
                expected_subtree_hash: base.root_hash.clone(),
            }],
        );
        assert!(matches!(
            harness.store.apply_transaction(root_delete).await,
            Err(ContextDbError::Invalid(_))
        ));

        let malformed = replace_frame(
            "invariants",
            base.revision,
            "malformed-body",
            "frame-0",
            1,
            "valid-before-mutation",
        );
        let mut malformed = malformed;
        malformed.operations = vec![ContextOperation::ReplaceNode {
            node_id: "frame-0".to_string(),
            expected_node_revision: 1,
            body_sexpr: ")".to_string(),
        }];
        let malformed_error = harness
            .store
            .apply_transaction(malformed)
            .await
            .expect_err("malformed S-expression must fail");
        assert!(
            matches!(malformed_error, ContextDbError::Syntax(_)),
            "unexpected malformed body error: {malformed_error:?}"
        );

        assert_eq!(harness.store.get_context("invariants").await.unwrap(), base);
        let stats = harness.store.inspect_context("invariants").await.unwrap();
        assert_eq!(stats.receipt_count, 1); // only bootstrap committed
    }

    #[tokio::test]
    async fn in_memory_mode_uses_one_coherent_sqlite_database() {
        let store = SqliteContextDb::open(":memory:", context_db_permit())
            .await
            .unwrap();
        let created = create_context(&store, "memory").await;
        let loaded = store.get_context("memory").await.unwrap();
        assert_eq!(loaded, created);
        store.close().await;
    }

    #[test]
    fn node_body_canonicalization_preserves_balancing_but_rejects_multiple_roots() {
        let (balanced, _) = canonicalize_body("(frame (value accepted)").unwrap();
        assert_eq!(balanced, "(frame (value accepted))");
        assert!(matches!(
            canonicalize_body("(frame) (second-root)"),
            Err(ContextDbError::Invalid(message)) if message.contains("exactly one")
        ));
    }

    #[cfg(feature = "experimental-cognitive-coordination")]
    #[tokio::test]
    async fn a_permit_for_another_experiment_cannot_open_context_db() {
        use crate::experimental::COGNITIVE_COORDINATION;

        let directory = tempfile::tempdir().unwrap();
        let enabled = BTreeSet::from([COGNITIVE_COORDINATION.to_string()]);
        let wrong_permit = require_enabled(&enabled, COGNITIVE_COORDINATION).unwrap();
        assert!(matches!(
            SqliteContextDb::open(directory.path().join("wrong.db"), wrong_permit).await,
            Err(ContextDbError::FeatureDenied)
        ));
    }
}
