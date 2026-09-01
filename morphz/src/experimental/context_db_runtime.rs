//! Runtime adapter which makes a ContextDB AST the authoritative current Mind.
//!
//! The adapter intentionally keeps immutable Agent Trajectory facts and
//! scheduler/control state in the existing Runtime tables.  Because it shares
//! the same SQLite pool, all three persistence domains can still commit in one
//! physical transaction.

use super::context_db::{
    AuthorityDomain, ContextAuthority, ContextDbError, ContextDbResult, ContextNodeDraft,
    ContextNodeRecord, ContextOperation, ContextSnapshot, ContextTransaction, CreateContextRequest,
    SqliteContextDb,
};
use super::ExperimentalFeaturePermit;
use crate::memory::{MindProjectionHead, MindProjectionRecord, NewMindProjection};
use crate::orchestrator::context::{
    ContextFrame, ContextMutationClocks, ContextRelation, FrameRetirement, MindCheckpoint,
    MindState,
};
use crate::sexpr::{self, SExpr};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use chrono::{DateTime, Utc};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Row, Sqlite, SqlitePool};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

const ROOT_NODE_ID: &str = "morphz/root";
const META_NODE_ID: &str = "morphz/meta";
const CLOCKS_NODE_ID: &str = "morphz/clocks";
const FRAMES_NODE_ID: &str = "morphz/frames";
const RELATIONS_NODE_ID: &str = "morphz/relations";
const RETIRED_NODE_ID: &str = "morphz/retired";
const RETIRING_NODE_ID: &str = "morphz/retiring";
const PROTECTED_NODE_ID: &str = "morphz/protected";
const CHECKPOINTS_NODE_ID: &str = "morphz/checkpoints";
const ROOT_BODY: &str = "(context (schema morphz-runtime-mind-v1))";
const INTERNAL_ACTOR_ID: &str = "morphz-runtime-context-adapter";

#[derive(Debug, Clone)]
pub(crate) struct ContextDbRuntimeAdapter {
    db: SqliteContextDb,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct ProjectionMeta {
    revision: u64,
    state_hash: String,
    head_event_id: Option<String>,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct RetiredEntry {
    id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct ProtectedEntry {
    id: String,
}

#[derive(Debug, Clone)]
struct DesiredNode {
    node_id: String,
    parent_id: String,
    order_key: i64,
    owner_domain: AuthorityDomain,
    body_sexpr: String,
}

#[derive(Debug, Clone)]
struct RuntimeContextSnapshot {
    context_id: String,
    revision: u64,
    root_node_id: String,
    root_hash: String,
    nodes: Vec<ContextNodeRecord>,
}

impl From<ContextSnapshot> for RuntimeContextSnapshot {
    fn from(snapshot: ContextSnapshot) -> Self {
        Self {
            context_id: snapshot.context_id,
            revision: snapshot.revision,
            root_node_id: snapshot.root_node_id,
            root_hash: snapshot.root_hash,
            nodes: snapshot.nodes,
        }
    }
}

impl DesiredNode {
    fn draft(&self) -> ContextNodeDraft {
        ContextNodeDraft {
            node_id: self.node_id.clone(),
            parent_id: Some(self.parent_id.clone()),
            order_key: self.order_key,
            owner_domain: self.owner_domain,
            body_sexpr: self.body_sexpr.clone(),
        }
    }
}

impl ContextDbRuntimeAdapter {
    pub(crate) async fn attach(
        pool: SqlitePool,
        permit: ExperimentalFeaturePermit,
    ) -> ContextDbResult<Self> {
        Ok(Self {
            db: SqliteContextDb::attach(pool, permit).await?,
        })
    }

    pub(crate) async fn install_projection_in_transaction(
        &self,
        transaction: &mut sqlx::Transaction<'_, Sqlite>,
        projection: &NewMindProjection,
        updated_at: DateTime<Utc>,
    ) -> ContextDbResult<MindProjectionRecord> {
        let context_exists = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM experimental_contextdb_contexts WHERE context_id = ?",
        )
        .bind(&projection.context_id)
        .fetch_one(&mut **transaction)
        .await?
            != 0;
        if context_exists {
            // Match the legacy `initialize_mind_projection` contract: once a
            // Context has an authoritative Mind, initialization is a read and
            // cannot overwrite it with a stale caller-side default.
            return self
                .load_projection_in_transaction(transaction, &projection.context_id)
                .await?
                .ok_or_else(|| {
                    ContextDbError::Corrupt(format!(
                        "Runtime Context '{}' exists without an authoritative Mind",
                        projection.context_id
                    ))
                });
        }
        let agent_id =
            sqlx::query_scalar::<_, String>("SELECT agent_id FROM cognitive_contexts WHERE id = ?")
                .bind(&projection.context_id)
                .fetch_optional(&mut **transaction)
                .await?
                .ok_or_else(|| {
                    ContextDbError::NotFound(format!("Runtime Context '{}'", projection.context_id))
                })?;
        let created = self
            .db
            .create_context_in_transaction(
                transaction,
                CreateContextRequest {
                    context_id: projection.context_id.clone(),
                    // Runtime does not yet expose a first-class tenant ID.
                    // Agent ownership is the narrowest durable isolation
                    // boundary available at this adapter layer.
                    tenant_id: agent_id.clone(),
                    agent_id,
                    authority: runtime_authority(),
                    root: ContextNodeDraft {
                        node_id: ROOT_NODE_ID.to_string(),
                        parent_id: None,
                        order_key: 0,
                        owner_domain: AuthorityDomain::RuntimeControl,
                        body_sexpr: ROOT_BODY.to_string(),
                    },
                },
            )
            .await?;
        let state = validate_new_projection(projection)?;
        self.sync_projection_against_snapshot(
            transaction,
            projection,
            updated_at,
            state,
            created.into(),
        )
        .await
    }

    pub(crate) async fn sync_projection_in_transaction(
        &self,
        transaction: &mut sqlx::Transaction<'_, Sqlite>,
        projection: &NewMindProjection,
        updated_at: DateTime<Utc>,
    ) -> ContextDbResult<MindProjectionRecord> {
        let state = validate_new_projection(projection)?;
        let snapshot = self
            .load_runtime_snapshot_in_transaction(transaction, &projection.context_id)
            .await?
            .ok_or_else(|| {
                ContextDbError::NotFound(format!("Context '{}'", projection.context_id))
            })?;
        self.sync_projection_against_snapshot(transaction, projection, updated_at, state, snapshot)
            .await
    }

    async fn sync_projection_against_snapshot(
        &self,
        transaction: &mut sqlx::Transaction<'_, Sqlite>,
        projection: &NewMindProjection,
        updated_at: DateTime<Utc>,
        state: MindState,
        snapshot: RuntimeContextSnapshot,
    ) -> ContextDbResult<MindProjectionRecord> {
        let desired = desired_nodes(
            &state,
            ProjectionMeta {
                revision: projection.revision,
                state_hash: projection.state_hash.clone(),
                head_event_id: projection.head_event_id.clone(),
                updated_at,
            },
        )?;
        let operations = diff_nodes(&snapshot, &desired)?;
        if !operations.is_empty() {
            let synchronization_identity = format!(
                "{}:{}:{}:{}",
                projection.context_id,
                projection.revision,
                projection.state_hash,
                projection.head_event_id.as_deref().unwrap_or("initial")
            );
            let synchronization_digest =
                format!("{:x}", Sha256::digest(synchronization_identity.as_bytes()));
            self.db
                .apply_transaction_in_transaction(
                    transaction,
                    ContextTransaction {
                        transaction_id: format!("runtime-mind-{synchronization_digest}"),
                        idempotency_key: format!("runtime-mind-{synchronization_digest}"),
                        context_id: projection.context_id.clone(),
                        base_revision: snapshot.revision,
                        authority: runtime_authority(),
                        operations,
                    },
                )
                .await?;
        }
        // `apply_transaction_in_transaction` has already fenced and persisted
        // the exact diff in this outer SQLite transaction. Re-reading and
        // reconstructing the entire AST here would add another full Context
        // query to every successful Mind commit without increasing safety.
        Ok(MindProjectionRecord {
            context_id: projection.context_id.clone(),
            revision: projection.revision,
            state: serde_json::to_value(state)?,
            state_hash: projection.state_hash.clone(),
            head_event_id: projection.head_event_id.clone(),
            updated_at,
        })
    }

    pub(crate) async fn load_projection_in_transaction(
        &self,
        transaction: &mut sqlx::Transaction<'_, Sqlite>,
        context_id: &str,
    ) -> ContextDbResult<Option<MindProjectionRecord>> {
        self.load_runtime_snapshot_in_transaction(transaction, context_id)
            .await?
            .map(|snapshot| decode_projection(&snapshot))
            .transpose()
    }

    pub(crate) async fn load_projection_heads_in_transaction(
        &self,
        transaction: &mut sqlx::Transaction<'_, Sqlite>,
        context_ids: &[String],
    ) -> ContextDbResult<Vec<MindProjectionHead>> {
        if context_ids.is_empty() {
            return Ok(Vec::new());
        }
        let rows = sqlx::query(
            r#"SELECT context.context_id, context.revision AS context_revision,
                      node.body_sexpr
               FROM experimental_contextdb_contexts context
               LEFT JOIN experimental_contextdb_nodes node
                 ON node.context_id = context.context_id
                AND node.node_id = ?
               WHERE context.context_id IN (SELECT value FROM json_each(?))"#,
        )
        .bind(META_NODE_ID)
        .bind(serde_json::to_string(context_ids)?)
        .fetch_all(&mut **transaction)
        .await?;
        let mut heads = rows
            .into_iter()
            .map(|row| {
                let context_id = row.get::<String, _>("context_id");
                let _context_revision = u64::try_from(row.get::<i64, _>("context_revision"))
                    .map_err(|_| {
                        ContextDbError::Corrupt(format!(
                            "Runtime Context '{context_id}' has an invalid revision"
                        ))
                    })?;
                let body = row.get::<Option<String>, _>("body_sexpr").ok_or_else(|| {
                    ContextDbError::Corrupt(format!(
                        "Runtime Context '{context_id}' is missing its projection metadata"
                    ))
                })?;
                let meta = decode_record::<ProjectionMeta>(&body, "projection-meta")?;
                Ok(MindProjectionHead {
                    context_id,
                    revision: meta.revision,
                    updated_at: meta.updated_at,
                })
            })
            .collect::<ContextDbResult<Vec<_>>>()?;
        heads.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.context_id.cmp(&right.context_id))
        });
        Ok(heads)
    }

    /// Loads the structural Runtime view in one SQL statement without
    /// materializing the public full canonical S-expression. Runtime decoding
    /// already parses every managed leaf and verifies the exact Mind hash, so
    /// constructing a second base64-heavy tree string here would be pure work.
    async fn load_runtime_snapshot_in_transaction(
        &self,
        transaction: &mut sqlx::Transaction<'_, Sqlite>,
        context_id: &str,
    ) -> ContextDbResult<Option<RuntimeContextSnapshot>> {
        let rows = sqlx::query(
            r#"SELECT context.context_id, context.revision AS context_revision,
                      context.root_node_id, context.root_hash,
                      node.node_id, node.parent_id, node.order_key,
                      node.owner_domain, node.node_revision, node.body_sexpr,
                      node.content_hash, node.subtree_hash
               FROM experimental_contextdb_contexts context
               LEFT JOIN experimental_contextdb_nodes node
                 ON node.context_id = context.context_id
               WHERE context.context_id = ?
               ORDER BY node.parent_id, node.order_key, node.node_id"#,
        )
        .bind(context_id)
        .fetch_all(&mut **transaction)
        .await?;
        let Some(first) = rows.first() else {
            return Ok(None);
        };
        if first.get::<Option<String>, _>("node_id").is_none() {
            return Err(ContextDbError::Corrupt(format!(
                "Context '{context_id}' contains no root Node"
            )));
        }
        let snapshot_context_id = first.get("context_id");
        let snapshot_revision = u64::try_from(first.get::<i64, _>("context_revision"))
            .map_err(|_| ContextDbError::Corrupt("invalid ContextDB revision".to_string()))?;
        let snapshot_root_node_id = first.get("root_node_id");
        let snapshot_root_hash = first.get("root_hash");
        let mut nodes = Vec::with_capacity(rows.len());
        for row in rows {
            nodes.push(ContextNodeRecord {
                node_id: row
                    .get::<Option<String>, _>("node_id")
                    .ok_or_else(|| ContextDbError::Corrupt("missing Node identity".to_string()))?,
                parent_id: row.get("parent_id"),
                order_key: row
                    .get::<Option<i64>, _>("order_key")
                    .ok_or_else(|| ContextDbError::Corrupt("missing Node order".to_string()))?,
                owner_domain: AuthorityDomain::from_storage(
                    &row.get::<Option<String>, _>("owner_domain")
                        .ok_or_else(|| {
                            ContextDbError::Corrupt("missing Node authority domain".to_string())
                        })?,
                )?,
                node_revision: u64::try_from(
                    row.get::<Option<i64>, _>("node_revision").ok_or_else(|| {
                        ContextDbError::Corrupt("missing Node revision".to_string())
                    })?,
                )
                .map_err(|_| ContextDbError::Corrupt("invalid Node revision".to_string()))?,
                body_sexpr: row.get::<Option<String>, _>("body_sexpr").ok_or_else(|| {
                    ContextDbError::Corrupt("missing Node S-expression".to_string())
                })?,
                content_hash: row
                    .get::<Option<String>, _>("content_hash")
                    .ok_or_else(|| {
                        ContextDbError::Corrupt("missing Node content hash".to_string())
                    })?,
                subtree_hash: row
                    .get::<Option<String>, _>("subtree_hash")
                    .ok_or_else(|| {
                        ContextDbError::Corrupt("missing Node subtree hash".to_string())
                    })?,
            });
        }
        let snapshot = RuntimeContextSnapshot {
            context_id: snapshot_context_id,
            revision: snapshot_revision,
            root_node_id: snapshot_root_node_id,
            root_hash: snapshot_root_hash,
            nodes,
        };
        validate_runtime_snapshot(&snapshot)?;
        Ok(Some(snapshot))
    }
}

fn runtime_authority() -> ContextAuthority {
    ContextAuthority::new(
        INTERNAL_ACTOR_ID,
        [AuthorityDomain::RuntimeControl, AuthorityDomain::AgentMind],
    )
}

fn desired_nodes(state: &MindState, meta: ProjectionMeta) -> ContextDbResult<Vec<DesiredNode>> {
    let mut nodes = vec![
        desired_record(
            META_NODE_ID,
            ROOT_NODE_ID,
            0,
            AuthorityDomain::RuntimeControl,
            "projection-meta",
            &meta,
        )?,
        desired_group(FRAMES_NODE_ID, 10, "frames"),
        desired_group(RELATIONS_NODE_ID, 20, "relations"),
        desired_group(RETIRED_NODE_ID, 30, "retired"),
        desired_group(RETIRING_NODE_ID, 40, "retiring"),
        desired_group(PROTECTED_NODE_ID, 50, "protected"),
        desired_group(CHECKPOINTS_NODE_ID, 60, "checkpoints"),
        desired_record(
            CLOCKS_NODE_ID,
            ROOT_NODE_ID,
            70,
            AuthorityDomain::AgentMind,
            "mutation-clocks",
            &state.mutation_clocks,
        )?,
    ];

    for (index, frame) in state.frames.iter().enumerate() {
        nodes.push(desired_record(
            &stable_node_id("frame", &frame.id),
            FRAMES_NODE_ID,
            checked_order(index)?,
            AuthorityDomain::AgentMind,
            "frame",
            frame,
        )?);
    }
    for (index, relation) in state.relations.iter().enumerate() {
        // Relations do not currently carry an explicit ID. Their complete
        // immutable value is therefore their stable identity.
        nodes.push(desired_record(
            &stable_node_id("relation", &serde_json::to_string(relation)?),
            RELATIONS_NODE_ID,
            checked_order(index)?,
            AuthorityDomain::AgentMind,
            "relation",
            relation,
        )?);
    }
    for (index, id) in state.retired.iter().enumerate() {
        nodes.push(desired_record(
            &stable_node_id("retired", id),
            RETIRED_NODE_ID,
            checked_order(index)?,
            AuthorityDomain::AgentMind,
            "retired-entry",
            &RetiredEntry { id: id.clone() },
        )?);
    }
    for (index, (id, retirement)) in state.retiring.iter().enumerate() {
        nodes.push(desired_record(
            &stable_node_id("retiring", id),
            RETIRING_NODE_ID,
            checked_order(index)?,
            AuthorityDomain::AgentMind,
            "retiring-entry",
            retirement,
        )?);
    }
    for (index, id) in state.protected.iter().enumerate() {
        nodes.push(desired_record(
            &stable_node_id("protected", id),
            PROTECTED_NODE_ID,
            checked_order(index)?,
            AuthorityDomain::AgentMind,
            "protected-entry",
            &ProtectedEntry { id: id.clone() },
        )?);
    }
    for (index, checkpoint) in state.checkpoints.iter().enumerate() {
        nodes.push(desired_record(
            &stable_node_id("checkpoint", &checkpoint.id),
            CHECKPOINTS_NODE_ID,
            checked_order(index)?,
            AuthorityDomain::AgentMind,
            "checkpoint",
            checkpoint,
        )?);
    }
    Ok(nodes)
}

fn desired_group(node_id: &str, order_key: i64, kind: &str) -> DesiredNode {
    DesiredNode {
        node_id: node_id.to_string(),
        parent_id: ROOT_NODE_ID.to_string(),
        order_key,
        owner_domain: AuthorityDomain::AgentMind,
        body_sexpr: format!("({kind})"),
    }
}

fn desired_record<T: Serialize>(
    node_id: &str,
    parent_id: &str,
    order_key: i64,
    owner_domain: AuthorityDomain,
    kind: &str,
    value: &T,
) -> ContextDbResult<DesiredNode> {
    Ok(DesiredNode {
        node_id: node_id.to_string(),
        parent_id: parent_id.to_string(),
        order_key,
        owner_domain,
        body_sexpr: encode_record(kind, value)?,
    })
}

fn checked_order(index: usize) -> ContextDbResult<i64> {
    i64::try_from(index)
        .map_err(|_| ContextDbError::Invalid("Mind component order exceeds i64".to_string()))
}

fn stable_node_id(kind: &str, logical_id: &str) -> String {
    let digest = Sha256::digest(logical_id.as_bytes());
    format!("morphz/{kind}/{digest:x}")
}

fn encode_record<T: Serialize>(kind: &str, value: &T) -> ContextDbResult<String> {
    let bytes = serde_json::to_vec(value)?;
    Ok(format!(
        "(morphz-record {kind} {})",
        URL_SAFE_NO_PAD.encode(bytes)
    ))
}

fn decode_record<T: DeserializeOwned>(body: &str, expected_kind: &str) -> ContextDbResult<T> {
    let mut forms = sexpr::parse_all(body)?;
    if forms.len() != 1 {
        return Err(ContextDbError::Corrupt(format!(
            "record '{expected_kind}' has {} top-level forms",
            forms.len()
        )));
    }
    let SExpr::List(parts) = forms.remove(0) else {
        return Err(ContextDbError::Corrupt(format!(
            "record '{expected_kind}' is not a list"
        )));
    };
    let [SExpr::Atom(head), SExpr::Atom(kind), SExpr::Atom(payload)] = parts.as_slice() else {
        return Err(ContextDbError::Corrupt(format!(
            "record '{expected_kind}' has an invalid shape"
        )));
    };
    if head != "morphz-record" || kind != expected_kind {
        return Err(ContextDbError::Corrupt(format!(
            "expected record kind '{expected_kind}', found head '{head}' kind '{kind}'"
        )));
    }
    let bytes = URL_SAFE_NO_PAD.decode(payload).map_err(|error| {
        ContextDbError::Corrupt(format!(
            "record '{expected_kind}' contains invalid base64url: {error}"
        ))
    })?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn diff_nodes(
    snapshot: &RuntimeContextSnapshot,
    desired: &[DesiredNode],
) -> ContextDbResult<Vec<ContextOperation>> {
    let existing = snapshot
        .nodes
        .iter()
        .map(|node| (node.node_id.as_str(), node))
        .collect::<HashMap<_, _>>();
    let desired_by_id = desired
        .iter()
        .map(|node| (node.node_id.as_str(), node))
        .collect::<HashMap<_, _>>();
    let mut operations = Vec::new();

    // Remove retired component leaves before inserts. Group and root nodes are
    // stable schema nodes and are never removed by synchronization.
    let mut removed = snapshot
        .nodes
        .iter()
        .filter(|node| {
            node.node_id.starts_with("morphz/")
                && node.node_id != ROOT_NODE_ID
                && !desired_by_id.contains_key(node.node_id.as_str())
        })
        .collect::<Vec<_>>();
    removed.sort_by(|left, right| right.node_id.cmp(&left.node_id));
    for node in removed {
        operations.push(ContextOperation::DeleteSubtree {
            node_id: node.node_id.clone(),
            expected_subtree_hash: node.subtree_hash.clone(),
        });
    }

    // Desired order places stable group parents before their leaves, making a
    // fresh install valid without a whole-tree rewrite.
    for node in desired {
        let Some(current) = existing.get(node.node_id.as_str()) else {
            operations.push(ContextOperation::InsertNode { node: node.draft() });
            continue;
        };
        if current.owner_domain != node.owner_domain {
            return Err(ContextDbError::Corrupt(format!(
                "managed Node '{}' changed authority domain",
                node.node_id
            )));
        }
        let moved = current.parent_id.as_deref() != Some(node.parent_id.as_str())
            || current.order_key != node.order_key;
        let replaced = current.body_sexpr != node.body_sexpr;
        if moved && replaced {
            // This combination is rare (a changed record is reordered in the
            // same commit). Recreate the leaf rather than manufacturing the
            // intermediate subtree hash required by a second CAS operation.
            if snapshot
                .nodes
                .iter()
                .any(|candidate| candidate.parent_id.as_deref() == Some(node.node_id.as_str()))
            {
                return Err(ContextDbError::Precondition(format!(
                    "managed parent Node '{}' cannot be moved and replaced together",
                    node.node_id
                )));
            }
            operations.push(ContextOperation::DeleteSubtree {
                node_id: node.node_id.clone(),
                expected_subtree_hash: current.subtree_hash.clone(),
            });
            operations.push(ContextOperation::InsertNode { node: node.draft() });
        } else if moved {
            operations.push(ContextOperation::MoveSubtree {
                node_id: node.node_id.clone(),
                expected_node_revision: current.node_revision,
                expected_subtree_hash: current.subtree_hash.clone(),
                new_parent_id: node.parent_id.clone(),
                new_order_key: node.order_key,
            });
        } else if replaced {
            operations.push(ContextOperation::ReplaceNode {
                node_id: node.node_id.clone(),
                expected_node_revision: current.node_revision,
                body_sexpr: node.body_sexpr.clone(),
            });
        }
    }
    Ok(operations)
}

fn validate_runtime_snapshot(snapshot: &RuntimeContextSnapshot) -> ContextDbResult<()> {
    if snapshot.root_node_id != ROOT_NODE_ID {
        return Err(ContextDbError::Corrupt(format!(
            "Runtime Context '{}' has unexpected root Node '{}'",
            snapshot.context_id, snapshot.root_node_id
        )));
    }
    let by_id = snapshot
        .nodes
        .iter()
        .map(|node| (node.node_id.as_str(), node))
        .collect::<HashMap<_, _>>();
    if by_id.len() != snapshot.nodes.len() {
        return Err(ContextDbError::Corrupt(format!(
            "Runtime Context '{}' contains duplicate Node identities",
            snapshot.context_id
        )));
    }
    let root = required_node(&by_id, ROOT_NODE_ID)?;
    if root.parent_id.is_some()
        || root.owner_domain != AuthorityDomain::RuntimeControl
        || root.body_sexpr != ROOT_BODY
        || root.subtree_hash != snapshot.root_hash
    {
        return Err(ContextDbError::Corrupt(format!(
            "Runtime Context '{}' has an invalid root Node",
            snapshot.context_id
        )));
    }

    let fixed_nodes = [
        (
            META_NODE_ID,
            ROOT_NODE_ID,
            0,
            AuthorityDomain::RuntimeControl,
            None,
        ),
        (
            FRAMES_NODE_ID,
            ROOT_NODE_ID,
            10,
            AuthorityDomain::AgentMind,
            Some("(frames)"),
        ),
        (
            RELATIONS_NODE_ID,
            ROOT_NODE_ID,
            20,
            AuthorityDomain::AgentMind,
            Some("(relations)"),
        ),
        (
            RETIRED_NODE_ID,
            ROOT_NODE_ID,
            30,
            AuthorityDomain::AgentMind,
            Some("(retired)"),
        ),
        (
            RETIRING_NODE_ID,
            ROOT_NODE_ID,
            40,
            AuthorityDomain::AgentMind,
            Some("(retiring)"),
        ),
        (
            PROTECTED_NODE_ID,
            ROOT_NODE_ID,
            50,
            AuthorityDomain::AgentMind,
            Some("(protected)"),
        ),
        (
            CHECKPOINTS_NODE_ID,
            ROOT_NODE_ID,
            60,
            AuthorityDomain::AgentMind,
            Some("(checkpoints)"),
        ),
        (
            CLOCKS_NODE_ID,
            ROOT_NODE_ID,
            70,
            AuthorityDomain::AgentMind,
            None,
        ),
    ];
    for (node_id, parent_id, order_key, owner_domain, exact_body) in fixed_nodes {
        let node = required_node(&by_id, node_id)?;
        if node.parent_id.as_deref() != Some(parent_id)
            || node.order_key != order_key
            || node.owner_domain != owner_domain
            || exact_body.is_some_and(|body| node.body_sexpr != body)
        {
            return Err(ContextDbError::Corrupt(format!(
                "Runtime Context '{}' has an invalid schema Node '{}'",
                snapshot.context_id, node_id
            )));
        }
    }

    let fixed_ids = std::iter::once(ROOT_NODE_ID)
        .chain(fixed_nodes.into_iter().map(|(node_id, ..)| node_id))
        .collect::<HashSet<_>>();
    let leaf_parents = HashSet::from([
        FRAMES_NODE_ID,
        RELATIONS_NODE_ID,
        RETIRED_NODE_ID,
        RETIRING_NODE_ID,
        PROTECTED_NODE_ID,
        CHECKPOINTS_NODE_ID,
    ]);
    for node in &snapshot.nodes {
        if fixed_ids.contains(node.node_id.as_str()) {
            continue;
        }
        let parent_id = node.parent_id.as_deref().ok_or_else(|| {
            ContextDbError::Corrupt(format!(
                "Runtime Context '{}' has a second root Node '{}'",
                snapshot.context_id, node.node_id
            ))
        })?;
        if !leaf_parents.contains(parent_id) || node.owner_domain != AuthorityDomain::AgentMind {
            return Err(ContextDbError::Corrupt(format!(
                "Runtime Context '{}' contains unmanaged Node '{}' under '{}'",
                snapshot.context_id, node.node_id, parent_id
            )));
        }
        if !by_id.contains_key(parent_id) {
            return Err(ContextDbError::Corrupt(format!(
                "Runtime Context '{}' Node '{}' references missing parent '{}'",
                snapshot.context_id, node.node_id, parent_id
            )));
        }
    }

    let mut children = HashMap::<&str, Vec<&str>>::new();
    for node in &snapshot.nodes {
        if let Some(parent_id) = node.parent_id.as_deref() {
            children
                .entry(parent_id)
                .or_default()
                .push(node.node_id.as_str());
        }
    }
    let mut visited = HashSet::new();
    let mut pending = vec![ROOT_NODE_ID];
    while let Some(node_id) = pending.pop() {
        if !visited.insert(node_id) {
            return Err(ContextDbError::Corrupt(format!(
                "Runtime Context '{}' contains a Node cycle at '{}'",
                snapshot.context_id, node_id
            )));
        }
        if let Some(descendants) = children.get(node_id) {
            pending.extend(descendants.iter().copied());
        }
    }
    if visited.len() != snapshot.nodes.len() {
        return Err(ContextDbError::Corrupt(format!(
            "Runtime Context '{}' contains Nodes unreachable from its root",
            snapshot.context_id
        )));
    }
    Ok(())
}

fn decode_projection(snapshot: &RuntimeContextSnapshot) -> ContextDbResult<MindProjectionRecord> {
    if snapshot.root_node_id != ROOT_NODE_ID {
        return Err(ContextDbError::Corrupt(format!(
            "Runtime Context '{}' has unexpected root Node '{}'",
            snapshot.context_id, snapshot.root_node_id
        )));
    }
    let by_id = snapshot
        .nodes
        .iter()
        .map(|node| (node.node_id.as_str(), node))
        .collect::<HashMap<_, _>>();
    let meta = decode_record::<ProjectionMeta>(
        &required_node(&by_id, META_NODE_ID)?.body_sexpr,
        "projection-meta",
    )?;
    let clocks = decode_record::<ContextMutationClocks>(
        &required_node(&by_id, CLOCKS_NODE_ID)?.body_sexpr,
        "mutation-clocks",
    )?;

    let frames =
        decode_runtime_children::<ContextFrame, _>(snapshot, FRAMES_NODE_ID, "frame", |frame| {
            Ok(stable_node_id("frame", &frame.id))
        })?;
    let relations = decode_runtime_children::<ContextRelation, _>(
        snapshot,
        RELATIONS_NODE_ID,
        "relation",
        |relation| {
            Ok(stable_node_id(
                "relation",
                &serde_json::to_string(relation)?,
            ))
        },
    )?;
    let retired = decode_runtime_children::<RetiredEntry, _>(
        snapshot,
        RETIRED_NODE_ID,
        "retired-entry",
        |entry| Ok(stable_node_id("retired", &entry.id)),
    )?
    .into_iter()
    .map(|entry| entry.id)
    .collect::<BTreeSet<_>>();
    let retiring_entries = decode_runtime_children::<FrameRetirement, _>(
        snapshot,
        RETIRING_NODE_ID,
        "retiring-entry",
        |entry| Ok(stable_node_id("retiring", &entry.frame_id)),
    )?;
    let mut retiring = BTreeMap::new();
    for entry in retiring_entries {
        if retiring.insert(entry.frame_id.clone(), entry).is_some() {
            return Err(ContextDbError::Corrupt(
                "duplicate retiring Frame identity".to_string(),
            ));
        }
    }
    let protected = decode_runtime_children::<ProtectedEntry, _>(
        snapshot,
        PROTECTED_NODE_ID,
        "protected-entry",
        |entry| Ok(stable_node_id("protected", &entry.id)),
    )?
    .into_iter()
    .map(|entry| entry.id)
    .collect::<BTreeSet<_>>();
    let checkpoints = decode_runtime_children::<MindCheckpoint, _>(
        snapshot,
        CHECKPOINTS_NODE_ID,
        "checkpoint",
        |checkpoint| Ok(stable_node_id("checkpoint", &checkpoint.id)),
    )?;

    let state = MindState {
        version: meta.revision,
        frames,
        relations,
        retired,
        retiring,
        protected,
        checkpoints,
        mutation_clocks: clocks,
    };
    let state_hash = mind_state_hash(&state)?;
    if state_hash != meta.state_hash {
        return Err(ContextDbError::Corrupt(format!(
            "Runtime Context '{}' reconstructed Mind hash '{}' differs from '{}'; refusing a partial or mixed state",
            snapshot.context_id, state_hash, meta.state_hash
        )));
    }
    Ok(MindProjectionRecord {
        context_id: snapshot.context_id.clone(),
        revision: meta.revision,
        state: serde_json::to_value(state)?,
        state_hash,
        head_event_id: meta.head_event_id,
        updated_at: meta.updated_at,
    })
}

fn required_node<'a>(
    by_id: &'a HashMap<&str, &'a super::context_db::ContextNodeRecord>,
    node_id: &str,
) -> ContextDbResult<&'a super::context_db::ContextNodeRecord> {
    by_id
        .get(node_id)
        .copied()
        .ok_or_else(|| ContextDbError::Corrupt(format!("required Node '{node_id}' is missing")))
}

fn decode_runtime_children<T, F>(
    snapshot: &RuntimeContextSnapshot,
    parent_id: &str,
    kind: &str,
    expected_node_id: F,
) -> ContextDbResult<Vec<T>>
where
    T: DeserializeOwned,
    F: Fn(&T) -> ContextDbResult<String>,
{
    let mut children = snapshot
        .nodes
        .iter()
        .filter(|node| node.parent_id.as_deref() == Some(parent_id))
        .collect::<Vec<_>>();
    children.sort_by(|left, right| {
        left.order_key
            .cmp(&right.order_key)
            .then_with(|| left.node_id.cmp(&right.node_id))
    });
    children
        .into_iter()
        .map(|node| {
            let value = decode_record::<T>(&node.body_sexpr, kind)?;
            let expected = expected_node_id(&value)?;
            if node.node_id != expected {
                return Err(ContextDbError::Corrupt(format!(
                    "Runtime record '{}' has Node identity '{}', expected '{}'",
                    kind, node.node_id, expected
                )));
            }
            Ok(value)
        })
        .collect()
}

fn mind_state_hash(state: &MindState) -> ContextDbResult<String> {
    let bytes = serde_json::to_vec(state)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn validate_new_projection(projection: &NewMindProjection) -> ContextDbResult<MindState> {
    let state: MindState = serde_json::from_value(projection.state.clone())?;
    let calculated_hash = mind_state_hash(&state)?;
    if calculated_hash != projection.state_hash {
        return Err(ContextDbError::Precondition(format!(
            "Mind state hash '{}' does not match supplied projection hash '{}'",
            calculated_hash, projection.state_hash
        )));
    }
    if state.version != projection.revision {
        return Err(ContextDbError::Precondition(format!(
            "Mind state version {} does not match projection revision {}",
            state.version, projection.revision
        )));
    }
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::context::{FrameIdentityProvenance, FrameProvenanceState};

    fn sample_state() -> MindState {
        MindState {
            version: 7,
            frames: vec![
                ContextFrame {
                    id: "frame-a".to_string(),
                    body: "(fact a)".to_string(),
                    sources: vec!["event-a".to_string()],
                    provenance: FrameIdentityProvenance {
                        formed_principal_id: Some("principal-a".to_string()),
                        formed_session_id: Some("session-a".to_string()),
                        source_principal_ids: vec!["principal-a".to_string()],
                        source_session_ids: vec!["session-a".to_string()],
                        state: FrameProvenanceState::Attributed,
                    },
                    revision: 2,
                    created_version: 2,
                    updated_version: 7,
                },
                ContextFrame {
                    id: "frame-b".to_string(),
                    body: "(fact b)".to_string(),
                    sources: Vec::new(),
                    provenance: FrameIdentityProvenance::default(),
                    revision: 1,
                    created_version: 3,
                    updated_version: 3,
                },
            ],
            relations: vec![ContextRelation {
                subject: "frame-a".to_string(),
                relation: "supports".to_string(),
                object: "frame-b".to_string(),
                created_version: 4,
            }],
            retired: BTreeSet::from(["old-observation".to_string()]),
            retiring: BTreeMap::from([(
                "frame-b".to_string(),
                FrameRetirement {
                    frame_id: "frame-b".to_string(),
                    requested_frame_revision: 1,
                    requested_mind_version: 7,
                    requested_at_tick: 9,
                    eligible_at_tick: 12,
                    generation: 1,
                    reason: "test".to_string(),
                },
            )]),
            protected: BTreeSet::from(["frame-a".to_string()]),
            checkpoints: vec![MindCheckpoint {
                id: "checkpoint-a".to_string(),
                frames: Vec::new(),
                relations: Vec::new(),
                retired: BTreeSet::new(),
                retiring: BTreeMap::new(),
                protected: BTreeSet::new(),
                created_version: 6,
            }],
            mutation_clocks: ContextMutationClocks {
                tracking_started_version: Some(1),
                frame_order_version: 5,
                global_barrier_version: 0,
                ..Default::default()
            },
        }
    }

    #[test]
    fn structural_codec_round_trips_complete_mind_state() {
        let state = sample_state();
        let hash = mind_state_hash(&state).unwrap();
        let desired = desired_nodes(
            &state,
            ProjectionMeta {
                revision: state.version,
                state_hash: hash.clone(),
                head_event_id: Some("event-head".to_string()),
                updated_at: DateTime::parse_from_rfc3339("2026-09-01T00:00:00Z")
                    .unwrap()
                    .with_timezone(&Utc),
            },
        )
        .unwrap();
        assert!(desired.iter().any(|node| node.parent_id == FRAMES_NODE_ID));
        assert_eq!(
            desired
                .iter()
                .filter(|node| node.parent_id == FRAMES_NODE_ID)
                .count(),
            state.frames.len()
        );
        assert!(desired
            .iter()
            .filter(|node| node.parent_id == FRAMES_NODE_ID)
            .all(|node| !node.body_sexpr.contains("(fact a)")));
    }
}
