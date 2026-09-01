//! Runtime adapter which makes a ContextDB AST the authoritative current Mind.
//!
//! The adapter intentionally keeps immutable Agent Trajectory facts and
//! scheduler/control state in the existing Runtime tables.  Because it shares
//! the same SQLite pool, all three persistence domains can still commit in one
//! physical transaction.

use super::context_db::{
    calculate_subtree_hash, canonicalize_body, AuthorityDomain, ContextAuthority, ContextDbError,
    ContextDbResult, ContextNodeDraft, ContextNodeRecord, ContextOperation, ContextSnapshot,
    ContextTransaction, CreateContextRequest, SqliteContextDb,
};
use super::ExperimentalFeaturePermit;
use crate::context_store::{
    relation_logical_id, ContextCollection, ContextMutationPlan, ContextStateMutation,
};
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
use sqlx::{QueryBuilder, Row, Sqlite, SqlitePool};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

pub(crate) const ROOT_NODE_ID: &str = "morphz/root";
pub(crate) const META_NODE_ID: &str = "morphz/meta";
pub(crate) const CLOCKS_NODE_ID: &str = "morphz/clocks";
pub(crate) const FRAMES_NODE_ID: &str = "morphz/frames";
pub(crate) const RELATIONS_NODE_ID: &str = "morphz/relations";
pub(crate) const RETIRED_NODE_ID: &str = "morphz/retired";
pub(crate) const RETIRING_NODE_ID: &str = "morphz/retiring";
pub(crate) const PROTECTED_NODE_ID: &str = "morphz/protected";
pub(crate) const CHECKPOINTS_NODE_ID: &str = "morphz/checkpoints";
pub(crate) const ROOT_BODY: &str = "(context (schema morphz-runtime-mind-v1))";
const INTERNAL_ACTOR_ID: &str = "morphz-runtime-context-adapter";

#[derive(Debug, Clone)]
pub(crate) struct ContextDbRuntimeAdapter {
    db: SqliteContextDb,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct ProjectionMeta {
    pub(crate) revision: u64,
    pub(crate) state_hash: String,
    pub(crate) head_event_id: Option<String>,
    pub(crate) updated_at: DateTime<Utc>,
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
pub(crate) struct DesiredNode {
    pub(crate) node_id: String,
    pub(crate) parent_id: String,
    pub(crate) order_key: i64,
    pub(crate) owner_domain: AuthorityDomain,
    pub(crate) body_sexpr: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RuntimeContextSnapshot {
    pub(crate) context_id: String,
    pub(crate) revision: u64,
    pub(crate) root_node_id: String,
    pub(crate) root_hash: String,
    pub(crate) nodes: Vec<ContextNodeRecord>,
}

#[derive(Debug)]
pub(crate) struct RuntimeMutationBasis {
    pub(crate) context_revision: u64,
    pub(crate) meta_node: ContextNodeRecord,
    pub(crate) nodes: HashMap<String, ContextNodeRecord>,
}

#[derive(Debug, Clone)]
pub(crate) struct RuntimeStoragePatch {
    pub(crate) expected_context_revision: u64,
    pub(crate) next_context_revision: u64,
    pub(crate) root_hash: String,
    pub(crate) deleted_node_ids: Vec<String>,
    pub(crate) inserted_nodes: Vec<ContextNodeRecord>,
    pub(crate) updated_nodes: Vec<ContextNodeRecord>,
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

    /// Applies the domain-emitted Context Mutation plan without reconstructing
    /// and diffing the complete persisted Mind.
    ///
    /// Local mutations read only the addressed leaves. A SetOrder operation
    /// additionally reads that one ordered collection because exact membership
    /// is part of its fail-closed precondition. Rollback remains the explicit
    /// broad barrier and intentionally uses the full-state replacement path.
    pub(crate) async fn apply_mutation_plan_in_transaction(
        &self,
        transaction: &mut sqlx::Transaction<'_, Sqlite>,
        plan: &ContextMutationPlan,
        projection: &NewMindProjection,
        updated_at: DateTime<Utc>,
    ) -> ContextDbResult<MindProjectionRecord> {
        plan.validate_shape().map_err(ContextDbError::Invalid)?;
        let state = validate_new_projection(projection)?;
        validate_plan_projection(plan, projection)?;
        // The domain emits local mutations for performance, while the fenced
        // projection remains the semantic oracle for the complete next Mind.
        // Materializing its Merkle root is CPU-only: it never reloads the
        // current Context or derives a second database diff. Comparing this
        // commitment after applying the bounded mutation plan prevents an
        // omitted mutation from committing a structurally incomplete Mind.
        let expected_root_hash =
            expected_runtime_root_hash(&projection.context_id, projection, updated_at)?;

        if matches!(
            plan.mutations.as_slice(),
            [ContextStateMutation::ReplaceMind { .. }]
        ) {
            let ContextStateMutation::ReplaceMind { state: replacement } = &plan.mutations[0]
            else {
                unreachable!("ReplaceMind shape was checked above")
            };
            if replacement != &projection.state {
                return Err(ContextDbError::Precondition(
                    "ReplaceMind body differs from the fenced next projection".to_string(),
                ));
            }
            return self
                .sync_projection_in_transaction(transaction, projection, updated_at)
                .await;
        }

        let basis = self.load_runtime_mutation_basis(transaction, plan).await?;
        let current_meta =
            decode_record::<ProjectionMeta>(&basis.meta_node.body_sexpr, "projection-meta")?;
        if current_meta.revision != plan.expected_revision
            || current_meta.state_hash != plan.expected_state_hash
        {
            return Err(ContextDbError::Conflict {
                context_id: plan.context_id.clone(),
                expected: plan.expected_revision,
                actual: current_meta.revision,
            });
        }

        let operations = compile_runtime_operations(
            plan,
            projection,
            updated_at,
            &basis.meta_node,
            &basis.nodes,
        )?;
        let transaction_identity = projection.head_event_id.as_deref().ok_or_else(|| {
            ContextDbError::Precondition(
                "a Context Mutation projection must name its trajectory Event".to_string(),
            )
        })?;
        let receipt = self
            .db
            .apply_transaction_in_transaction(
                transaction,
                ContextTransaction {
                    transaction_id: format!("runtime-context-{transaction_identity}"),
                    idempotency_key: format!("runtime-context-{transaction_identity}"),
                    context_id: plan.context_id.clone(),
                    base_revision: basis.context_revision,
                    authority: runtime_authority(),
                    operations,
                },
            )
            .await?;
        if receipt.root_hash != expected_root_hash {
            return Err(ContextDbError::Precondition(format!(
                "Context Mutation produced root '{}' but its fenced projection requires '{}'",
                receipt.root_hash, expected_root_hash
            )));
        }

        Ok(MindProjectionRecord {
            context_id: projection.context_id.clone(),
            revision: projection.revision,
            state: serde_json::to_value(state)?,
            state_hash: projection.state_hash.clone(),
            head_event_id: projection.head_event_id.clone(),
            updated_at,
        })
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
        let expected_root_hash =
            expected_runtime_root_hash(&projection.context_id, projection, updated_at)?;
        let actual_root_hash = if !operations.is_empty() {
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
                .await?
                .root_hash
        } else {
            snapshot.root_hash
        };
        if actual_root_hash != expected_root_hash {
            return Err(ContextDbError::Precondition(format!(
                "broad Context synchronization produced root '{actual_root_hash}' but its fenced projection requires '{expected_root_hash}'"
            )));
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

    /// Decodes the authoritative Runtime projection from a structural
    /// ContextDB snapshot embedded in a larger storage query.
    ///
    /// Runtime directory reads use this entry point so the Context AST,
    /// Sessions and control state all come from one SQLite statement snapshot
    /// instead of adding a second ContextDB round trip. The exact same schema,
    /// topology and Mind-hash validation used by the direct loader remains the
    /// fail-closed boundary.
    pub(crate) fn decode_projection_snapshot_json(
        &self,
        encoded: &str,
    ) -> ContextDbResult<Option<MindProjectionRecord>> {
        serde_json::from_str::<Option<RuntimeContextSnapshot>>(encoded)?
            .map(|snapshot| {
                validate_runtime_snapshot(&snapshot)?;
                decode_projection(&snapshot)
            })
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

    async fn load_runtime_mutation_basis(
        &self,
        transaction: &mut sqlx::Transaction<'_, Sqlite>,
        plan: &ContextMutationPlan,
    ) -> ContextDbResult<RuntimeMutationBasis> {
        let context_revision = sqlx::query_scalar::<_, i64>(
            "SELECT revision FROM experimental_contextdb_contexts WHERE context_id = ?",
        )
        .bind(&plan.context_id)
        .fetch_optional(&mut **transaction)
        .await?
        .ok_or_else(|| ContextDbError::NotFound(format!("Context '{}'", plan.context_id)))?;
        let context_revision = u64::try_from(context_revision).map_err(|_| {
            ContextDbError::Corrupt(format!(
                "Runtime Context '{}' has an invalid storage revision",
                plan.context_id
            ))
        })?;

        let mut node_ids = BTreeSet::from([META_NODE_ID.to_string()]);
        let mut collection_parents = BTreeSet::new();
        for mutation in &plan.mutations {
            match mutation {
                ContextStateMutation::Upsert {
                    collection,
                    logical_id,
                    ..
                }
                | ContextStateMutation::Remove {
                    collection,
                    logical_id,
                } => {
                    node_ids.insert(runtime_node_id(*collection, logical_id)?);
                }
                ContextStateMutation::SetOrder { collection, .. } => {
                    collection_parents.insert(runtime_collection_spec(*collection)?.parent_id);
                }
                ContextStateMutation::ReplaceMind { .. } => {
                    return Err(ContextDbError::Invalid(
                        "ReplaceMind must use the broad replacement path".to_string(),
                    ));
                }
            }
        }

        let mut query = QueryBuilder::<Sqlite>::new(
            r#"SELECT node_id, parent_id, order_key, owner_domain, node_revision,
                      body_sexpr, content_hash, subtree_hash
               FROM experimental_contextdb_nodes
               WHERE context_id = "#,
        );
        query.push_bind(&plan.context_id).push(" AND (");
        query.push("node_id IN (");
        {
            let mut separated = query.separated(", ");
            for node_id in &node_ids {
                separated.push_bind(node_id);
            }
        }
        query.push(")");
        let query_parents = collection_parents
            .iter()
            .copied()
            .map(ToOwned::to_owned)
            .chain(node_ids.iter().cloned())
            .collect::<BTreeSet<_>>();
        if !query_parents.is_empty() {
            query.push(" OR parent_id IN (");
            {
                let mut separated = query.separated(", ");
                for parent_id in &query_parents {
                    separated.push_bind(parent_id);
                }
            }
            query.push(")");
        }
        query.push(") ORDER BY parent_id, order_key, node_id");
        let rows = query.build().fetch_all(&mut **transaction).await?;
        let mut nodes = HashMap::with_capacity(rows.len());
        for row in rows {
            let record = runtime_node_from_row(&row)?;
            if nodes.insert(record.node_id.clone(), record).is_some() {
                return Err(ContextDbError::Corrupt(format!(
                    "Runtime Context '{}' contains duplicate Node identities",
                    plan.context_id
                )));
            }
        }
        let meta_node = nodes.remove(META_NODE_ID).ok_or_else(|| {
            ContextDbError::Corrupt(format!(
                "Runtime Context '{}' is missing its projection metadata",
                plan.context_id
            ))
        })?;
        if meta_node.parent_id.as_deref() != Some(ROOT_NODE_ID)
            || meta_node.order_key != 0
            || meta_node.owner_domain != AuthorityDomain::RuntimeControl
        {
            return Err(ContextDbError::Corrupt(format!(
                "Runtime Context '{}' has invalid projection metadata placement",
                plan.context_id
            )));
        }
        if nodes
            .values()
            .any(|node| node.parent_id.as_deref() == Some(META_NODE_ID))
        {
            return Err(ContextDbError::Corrupt(format!(
                "Runtime Context '{}' projection metadata unexpectedly owns child Nodes",
                plan.context_id
            )));
        }
        Ok(RuntimeMutationBasis {
            context_revision,
            meta_node,
            nodes,
        })
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct RuntimeCollectionSpec {
    pub(crate) physical_kind: &'static str,
    pub(crate) record_kind: &'static str,
    pub(crate) parent_id: &'static str,
    pub(crate) ordered: bool,
    pub(crate) default_order: i64,
}

pub(crate) fn runtime_collection_spec(
    collection: ContextCollection,
) -> ContextDbResult<RuntimeCollectionSpec> {
    Ok(match collection {
        ContextCollection::Frame => RuntimeCollectionSpec {
            physical_kind: "frame",
            record_kind: "frame",
            parent_id: FRAMES_NODE_ID,
            ordered: true,
            default_order: 0,
        },
        ContextCollection::Relation => RuntimeCollectionSpec {
            physical_kind: "relation",
            record_kind: "relation",
            parent_id: RELATIONS_NODE_ID,
            ordered: true,
            default_order: 0,
        },
        ContextCollection::Retired => RuntimeCollectionSpec {
            physical_kind: "retired",
            record_kind: "retired-entry",
            parent_id: RETIRED_NODE_ID,
            ordered: false,
            default_order: 0,
        },
        ContextCollection::Retiring => RuntimeCollectionSpec {
            physical_kind: "retiring",
            record_kind: "retiring-entry",
            parent_id: RETIRING_NODE_ID,
            ordered: false,
            default_order: 0,
        },
        ContextCollection::Protected => RuntimeCollectionSpec {
            physical_kind: "protected",
            record_kind: "protected-entry",
            parent_id: PROTECTED_NODE_ID,
            ordered: false,
            default_order: 0,
        },
        ContextCollection::Checkpoint => RuntimeCollectionSpec {
            physical_kind: "checkpoint",
            record_kind: "checkpoint",
            parent_id: CHECKPOINTS_NODE_ID,
            ordered: true,
            default_order: 0,
        },
        ContextCollection::MutationClocks => RuntimeCollectionSpec {
            physical_kind: "mutation-clocks",
            record_kind: "mutation-clocks",
            parent_id: ROOT_NODE_ID,
            ordered: false,
            default_order: 70,
        },
    })
}

pub(crate) fn runtime_node_id(
    collection: ContextCollection,
    logical_id: &str,
) -> ContextDbResult<String> {
    if collection == ContextCollection::MutationClocks {
        if logical_id != "mutation-clocks" {
            return Err(ContextDbError::Invalid(format!(
                "mutation_clocks logical identity must be 'mutation-clocks', got '{logical_id}'"
            )));
        }
        Ok(CLOCKS_NODE_ID.to_string())
    } else {
        let spec = runtime_collection_spec(collection)?;
        Ok(stable_node_id(spec.physical_kind, logical_id))
    }
}

fn runtime_node_from_row(row: &sqlx::sqlite::SqliteRow) -> ContextDbResult<ContextNodeRecord> {
    Ok(ContextNodeRecord {
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

pub(crate) fn validate_plan_projection(
    plan: &ContextMutationPlan,
    projection: &NewMindProjection,
) -> ContextDbResult<()> {
    if plan.context_id != projection.context_id {
        return Err(ContextDbError::Precondition(format!(
            "Context Mutation targets '{}', projection targets '{}'",
            plan.context_id, projection.context_id
        )));
    }
    if plan.next_revision != projection.revision {
        return Err(ContextDbError::Precondition(format!(
            "Context Mutation next revision {} differs from projection revision {}",
            plan.next_revision, projection.revision
        )));
    }
    if plan.next_state_hash != projection.state_hash {
        return Err(ContextDbError::Precondition(format!(
            "Context Mutation next hash '{}' differs from projection hash '{}'",
            plan.next_state_hash, projection.state_hash
        )));
    }
    Ok(())
}

pub(crate) fn compile_runtime_operations(
    plan: &ContextMutationPlan,
    projection: &NewMindProjection,
    updated_at: DateTime<Utc>,
    meta_node: &ContextNodeRecord,
    existing_nodes: &HashMap<String, ContextNodeRecord>,
) -> ContextDbResult<Vec<ContextOperation>> {
    let mut upserts =
        BTreeMap::<(ContextCollection, String), (serde_json::Value, Option<u64>)>::new();
    let mut removes = BTreeSet::<(ContextCollection, String)>::new();
    let mut orders = BTreeMap::<ContextCollection, Vec<String>>::new();

    for mutation in &plan.mutations {
        match mutation {
            ContextStateMutation::Upsert {
                collection,
                logical_id,
                body,
                order,
            } => {
                let key = (*collection, logical_id.clone());
                if removes.contains(&key)
                    || upserts
                        .insert(key.clone(), (body.clone(), *order))
                        .is_some()
                {
                    return Err(ContextDbError::Invalid(format!(
                        "Context Mutation contains conflicting writes for '{}:{}'",
                        collection.as_str(),
                        logical_id
                    )));
                }
            }
            ContextStateMutation::Remove {
                collection,
                logical_id,
            } => {
                if *collection == ContextCollection::MutationClocks {
                    return Err(ContextDbError::Invalid(
                        "mutation_clocks cannot be removed".to_string(),
                    ));
                }
                let key = (*collection, logical_id.clone());
                if upserts.contains_key(&key) || !removes.insert(key) {
                    return Err(ContextDbError::Invalid(format!(
                        "Context Mutation contains conflicting removes for '{}:{}'",
                        collection.as_str(),
                        logical_id
                    )));
                }
            }
            ContextStateMutation::SetOrder {
                collection,
                logical_ids,
            } => {
                if orders.insert(*collection, logical_ids.clone()).is_some() {
                    return Err(ContextDbError::Invalid(format!(
                        "Context Mutation orders collection '{}' more than once",
                        collection.as_str()
                    )));
                }
            }
            ContextStateMutation::ReplaceMind { .. } => {
                return Err(ContextDbError::Invalid(
                    "ReplaceMind cannot be compiled as a local mutation".to_string(),
                ));
            }
        }
    }

    let mut operations = Vec::new();

    // Deletes happen first. A missing addressed record means the authoritative
    // tree is corrupt or the plan was built from a stale state; silently
    // treating it as an idempotent delete would conceal either condition.
    for (collection, logical_id) in &removes {
        let node_id = runtime_node_id(*collection, logical_id)?;
        let current = existing_nodes.get(&node_id).ok_or_else(|| {
            ContextDbError::Precondition(format!(
                "Context Mutation removes missing '{}:{}'",
                collection.as_str(),
                logical_id
            ))
        })?;
        ensure_runtime_leaf(existing_nodes, current)?;
        operations.push(ContextOperation::DeleteSubtree {
            node_id,
            expected_subtree_hash: current.subtree_hash.clone(),
        });
    }

    // Validate each explicit final order against final collection membership,
    // then index it for both upserts and order-only moves.
    let mut final_orders = BTreeMap::<ContextCollection, BTreeMap<String, i64>>::new();
    for (collection, logical_ids) in &orders {
        let spec = runtime_collection_spec(*collection)?;
        if !spec.ordered {
            return Err(ContextDbError::Invalid(format!(
                "collection '{}' has no observable order",
                collection.as_str()
            )));
        }
        let current_ids = existing_nodes
            .values()
            .filter(|node| node.parent_id.as_deref() == Some(spec.parent_id))
            .map(|node| node.node_id.clone())
            .collect::<BTreeSet<_>>();
        let mut expected_final_ids = current_ids;
        for (candidate_collection, logical_id) in &removes {
            if candidate_collection == collection {
                expected_final_ids.remove(&runtime_node_id(*collection, logical_id)?);
            }
        }
        for (candidate_collection, logical_id) in upserts.keys() {
            if candidate_collection == collection {
                expected_final_ids.insert(runtime_node_id(*collection, logical_id)?);
            }
        }
        let ordered_ids = logical_ids
            .iter()
            .map(|logical_id| runtime_node_id(*collection, logical_id))
            .collect::<ContextDbResult<BTreeSet<_>>>()?;
        if ordered_ids.len() != logical_ids.len() || ordered_ids != expected_final_ids {
            return Err(ContextDbError::Precondition(format!(
                "SetOrder for '{}' does not exactly describe final collection membership",
                collection.as_str()
            )));
        }
        let positions = logical_ids
            .iter()
            .enumerate()
            .map(|(index, logical_id)| {
                Ok((
                    logical_id.clone(),
                    i64::try_from(index).map_err(|_| {
                        ContextDbError::Invalid(format!(
                            "collection '{}' order exceeds SQLite INTEGER",
                            collection.as_str()
                        ))
                    })?,
                ))
            })
            .collect::<ContextDbResult<BTreeMap<_, _>>>()?;
        final_orders.insert(*collection, positions);
    }

    for ((collection, logical_id), (body, supplied_order)) in &upserts {
        let spec = runtime_collection_spec(*collection)?;
        let order_key = if spec.ordered {
            match final_orders
                .get(collection)
                .and_then(|positions| positions.get(logical_id))
            {
                Some(order) => *order,
                None => i64::try_from(supplied_order.ok_or_else(|| {
                    ContextDbError::Invalid(format!(
                        "ordered collection '{}:{}' is missing its order",
                        collection.as_str(),
                        logical_id
                    ))
                })?)
                .map_err(|_| {
                    ContextDbError::Invalid(format!(
                        "collection '{}:{}' order exceeds SQLite INTEGER",
                        collection.as_str(),
                        logical_id
                    ))
                })?,
            }
        } else {
            if supplied_order.is_some() {
                return Err(ContextDbError::Invalid(format!(
                    "unordered collection '{}:{}' supplied an order",
                    collection.as_str(),
                    logical_id
                )));
            }
            spec.default_order
        };
        let node_id = runtime_node_id(*collection, logical_id)?;
        let desired = DesiredNode {
            node_id: node_id.clone(),
            parent_id: spec.parent_id.to_string(),
            order_key,
            owner_domain: AuthorityDomain::AgentMind,
            body_sexpr: encode_mutation_record(*collection, logical_id, body)?,
        };
        let Some(current) = existing_nodes.get(&node_id) else {
            operations.push(ContextOperation::InsertNode {
                node: desired.draft(),
            });
            continue;
        };
        if current.owner_domain != AuthorityDomain::AgentMind {
            return Err(ContextDbError::Corrupt(format!(
                "managed Node '{}' changed authority domain",
                current.node_id
            )));
        }
        ensure_runtime_leaf(existing_nodes, current)?;
        let moved = current.parent_id.as_deref() != Some(spec.parent_id)
            || current.order_key != desired.order_key;
        let replaced = current.body_sexpr != desired.body_sexpr;
        if moved && replaced {
            operations.push(ContextOperation::DeleteSubtree {
                node_id: current.node_id.clone(),
                expected_subtree_hash: current.subtree_hash.clone(),
            });
            operations.push(ContextOperation::InsertNode {
                node: desired.draft(),
            });
        } else if moved {
            operations.push(ContextOperation::MoveSubtree {
                node_id: current.node_id.clone(),
                expected_node_revision: current.node_revision,
                expected_subtree_hash: current.subtree_hash.clone(),
                new_parent_id: spec.parent_id.to_string(),
                new_order_key: desired.order_key,
            });
        } else if replaced {
            operations.push(ContextOperation::ReplaceNode {
                node_id: current.node_id.clone(),
                expected_node_revision: current.node_revision,
                body_sexpr: desired.body_sexpr,
            });
        }
    }

    // Apply order-only moves after accounting for locally upserted records.
    for (collection, positions) in &final_orders {
        let spec = runtime_collection_spec(*collection)?;
        for (logical_id, order_key) in positions {
            if upserts.contains_key(&(*collection, logical_id.clone())) {
                continue;
            }
            let node_id = runtime_node_id(*collection, logical_id)?;
            let current = existing_nodes.get(&node_id).ok_or_else(|| {
                ContextDbError::Precondition(format!(
                    "SetOrder addresses missing '{}:{}'",
                    collection.as_str(),
                    logical_id
                ))
            })?;
            ensure_runtime_leaf(existing_nodes, current)?;
            if current.parent_id.as_deref() != Some(spec.parent_id) {
                return Err(ContextDbError::Corrupt(format!(
                    "ordered Node '{}' is outside collection '{}'",
                    node_id,
                    collection.as_str()
                )));
            }
            if current.order_key != *order_key {
                operations.push(ContextOperation::MoveSubtree {
                    node_id,
                    expected_node_revision: current.node_revision,
                    expected_subtree_hash: current.subtree_hash.clone(),
                    new_parent_id: spec.parent_id.to_string(),
                    new_order_key: *order_key,
                });
            }
        }
    }

    let desired_meta = desired_record(
        META_NODE_ID,
        ROOT_NODE_ID,
        0,
        AuthorityDomain::RuntimeControl,
        "projection-meta",
        &ProjectionMeta {
            revision: projection.revision,
            state_hash: projection.state_hash.clone(),
            head_event_id: projection.head_event_id.clone(),
            updated_at,
        },
    )?;
    if desired_meta.body_sexpr == meta_node.body_sexpr {
        return Err(ContextDbError::Precondition(
            "Context Mutation did not advance projection metadata".to_string(),
        ));
    }
    operations.push(ContextOperation::ReplaceNode {
        node_id: META_NODE_ID.to_string(),
        expected_node_revision: meta_node.node_revision,
        body_sexpr: desired_meta.body_sexpr,
    });
    Ok(operations)
}

/// Applies already-validated Runtime operations to a bounded structural basis.
///
/// The caller must supply the root, every root child, every directly addressed
/// Node, descendants of directly addressed Nodes, and every child of a touched
/// collection parent.  This makes local mutation cost proportional to changed
/// collections while still producing the exact global Merkle root.  The pure
/// transition is shared by PostgreSQL persistence and deterministic tests;
/// SQL is responsible only for locking and atomically storing this patch.
pub(crate) fn apply_runtime_operations_to_basis(
    context_id: &str,
    basis: &RuntimeMutationBasis,
    operations: &[ContextOperation],
) -> ContextDbResult<RuntimeStoragePatch> {
    let mut nodes = basis.nodes.clone();
    if nodes
        .insert(META_NODE_ID.to_string(), basis.meta_node.clone())
        .is_some()
    {
        return Err(ContextDbError::Corrupt(format!(
            "Runtime Context '{context_id}' mutation basis duplicates projection metadata"
        )));
    }
    let original = nodes.clone();
    let mut dirty_parents = BTreeSet::new();

    for operation in operations {
        match operation {
            ContextOperation::InsertNode { node } => {
                require_runtime_domain(node.owner_domain)?;
                let parent_id = node.parent_id.as_deref().ok_or_else(|| {
                    ContextDbError::Invalid(
                        "Runtime mutation cannot insert a second root".to_string(),
                    )
                })?;
                let parent = nodes.get(parent_id).ok_or_else(|| {
                    ContextDbError::Precondition(format!(
                        "Runtime mutation parent Node '{parent_id}' is absent from its locked basis"
                    ))
                })?;
                require_runtime_domain(parent.owner_domain)?;
                if nodes.contains_key(&node.node_id) {
                    return Err(ContextDbError::AlreadyExists(format!(
                        "Node '{}' in Context '{context_id}'",
                        node.node_id
                    )));
                }
                let (body_sexpr, content_hash) = canonicalize_body(&node.body_sexpr)?;
                let subtree_hash =
                    calculate_subtree_hash(&node.node_id, node.owner_domain, &body_sexpr, &[]);
                nodes.insert(
                    node.node_id.clone(),
                    ContextNodeRecord {
                        node_id: node.node_id.clone(),
                        parent_id: Some(parent_id.to_string()),
                        order_key: node.order_key,
                        owner_domain: node.owner_domain,
                        node_revision: 1,
                        body_sexpr,
                        content_hash,
                        subtree_hash,
                    },
                );
                dirty_parents.insert(parent_id.to_string());
            }
            ContextOperation::ReplaceNode {
                node_id,
                expected_node_revision,
                body_sexpr,
            } => {
                let children = runtime_child_descriptors(&nodes, node_id);
                let current = nodes
                    .get_mut(node_id)
                    .ok_or_else(|| ContextDbError::NotFound(format!("Node '{node_id}'")))?;
                require_runtime_domain(current.owner_domain)?;
                if current.node_revision != *expected_node_revision {
                    return Err(ContextDbError::Precondition(format!(
                        "Node '{node_id}' revision is {}, expected {expected_node_revision}",
                        current.node_revision
                    )));
                }
                let (canonical, content_hash) = canonicalize_body(body_sexpr)?;
                current.node_revision = current
                    .node_revision
                    .checked_add(1)
                    .ok_or_else(|| ContextDbError::Invalid("Node revision overflow".to_string()))?;
                current.body_sexpr = canonical;
                current.content_hash = content_hash;
                current.subtree_hash = calculate_subtree_hash(
                    &current.node_id,
                    current.owner_domain,
                    &current.body_sexpr,
                    &children,
                );
                if let Some(parent_id) = &current.parent_id {
                    dirty_parents.insert(parent_id.clone());
                }
            }
            ContextOperation::DeleteSubtree {
                node_id,
                expected_subtree_hash,
            } => {
                if node_id == ROOT_NODE_ID {
                    return Err(ContextDbError::Invalid(
                        "the Runtime Context root cannot be deleted".to_string(),
                    ));
                }
                let current = nodes
                    .get(node_id)
                    .cloned()
                    .ok_or_else(|| ContextDbError::NotFound(format!("Node '{node_id}'")))?;
                require_runtime_domain(current.owner_domain)?;
                if current.subtree_hash != *expected_subtree_hash {
                    return Err(ContextDbError::Precondition(format!(
                        "Node '{node_id}' subtree changed since it was read"
                    )));
                }
                let descendants = runtime_descendants(&nodes, node_id)?;
                for descendant_id in &descendants {
                    let descendant = nodes.get(descendant_id).ok_or_else(|| {
                        ContextDbError::Corrupt(format!(
                            "Runtime descendant '{descendant_id}' disappeared"
                        ))
                    })?;
                    require_runtime_domain(descendant.owner_domain)?;
                }
                if let Some(parent_id) = &current.parent_id {
                    let parent = nodes.get(parent_id).ok_or_else(|| {
                        ContextDbError::Corrupt(format!(
                            "Node '{node_id}' references missing parent '{parent_id}'"
                        ))
                    })?;
                    require_runtime_domain(parent.owner_domain)?;
                    dirty_parents.insert(parent_id.clone());
                }
                for descendant_id in descendants {
                    nodes.remove(&descendant_id);
                }
            }
            ContextOperation::MoveSubtree {
                node_id,
                expected_node_revision,
                expected_subtree_hash,
                new_parent_id,
                new_order_key,
            } => {
                if node_id == ROOT_NODE_ID {
                    return Err(ContextDbError::Invalid(
                        "the Runtime Context root cannot be moved".to_string(),
                    ));
                }
                let current = nodes
                    .get(node_id)
                    .cloned()
                    .ok_or_else(|| ContextDbError::NotFound(format!("Node '{node_id}'")))?;
                require_runtime_domain(current.owner_domain)?;
                if current.node_revision != *expected_node_revision
                    || current.subtree_hash != *expected_subtree_hash
                {
                    return Err(ContextDbError::Precondition(format!(
                        "Node '{node_id}' changed since it was read"
                    )));
                }
                let parent = nodes
                    .get(new_parent_id)
                    .ok_or_else(|| ContextDbError::NotFound(format!("Node '{new_parent_id}'")))?;
                require_runtime_domain(parent.owner_domain)?;
                if runtime_descendants(&nodes, node_id)?
                    .iter()
                    .any(|descendant| descendant == new_parent_id)
                {
                    return Err(ContextDbError::Invalid(format!(
                        "moving Node '{node_id}' below '{new_parent_id}' would create a cycle"
                    )));
                }
                if let Some(old_parent_id) = &current.parent_id {
                    dirty_parents.insert(old_parent_id.clone());
                }
                let current = nodes.get_mut(node_id).expect("Node was checked above");
                current.parent_id = Some(new_parent_id.clone());
                current.order_key = *new_order_key;
                current.node_revision = current
                    .node_revision
                    .checked_add(1)
                    .ok_or_else(|| ContextDbError::Invalid("Node revision overflow".to_string()))?;
                dirty_parents.insert(new_parent_id.clone());
            }
        }
    }

    // Runtime's schema is two levels deep. Recompute changed collection roots
    // before the global root; untouched collections contribute their persisted
    // Merkle roots without loading their leaf bodies.
    let mut collection_parents = dirty_parents
        .iter()
        .filter(|node_id| node_id.as_str() != ROOT_NODE_ID)
        .cloned()
        .collect::<Vec<_>>();
    collection_parents.sort();
    for parent_id in collection_parents {
        refresh_materialized_subtree_hash(&mut nodes, &parent_id)?;
        dirty_parents.insert(ROOT_NODE_ID.to_string());
    }
    if dirty_parents.contains(ROOT_NODE_ID) {
        refresh_materialized_subtree_hash(&mut nodes, ROOT_NODE_ID)?;
    }
    let root_hash = nodes
        .get(ROOT_NODE_ID)
        .ok_or_else(|| {
            ContextDbError::Corrupt("Runtime root is absent from mutation basis".to_string())
        })?
        .subtree_hash
        .clone();

    let mut deleted_node_ids = original
        .keys()
        .filter(|node_id| !nodes.contains_key(*node_id))
        .cloned()
        .collect::<Vec<_>>();
    deleted_node_ids.sort();
    let mut inserted_nodes = nodes
        .iter()
        .filter(|(node_id, _)| !original.contains_key(*node_id))
        .map(|(_, node)| node.clone())
        .collect::<Vec<_>>();
    inserted_nodes.sort_by(|left, right| left.node_id.cmp(&right.node_id));
    let mut updated_nodes = nodes
        .iter()
        .filter_map(|(node_id, node)| {
            original
                .get(node_id)
                .filter(|current| *current != node)
                .map(|_| node.clone())
        })
        .collect::<Vec<_>>();
    updated_nodes.sort_by(|left, right| left.node_id.cmp(&right.node_id));
    let next_context_revision = basis
        .context_revision
        .checked_add(1)
        .ok_or_else(|| ContextDbError::Invalid("Context revision overflow".to_string()))?;
    Ok(RuntimeStoragePatch {
        expected_context_revision: basis.context_revision,
        next_context_revision,
        root_hash,
        deleted_node_ids,
        inserted_nodes,
        updated_nodes,
    })
}

fn require_runtime_domain(domain: AuthorityDomain) -> ContextDbResult<()> {
    if matches!(
        domain,
        AuthorityDomain::RuntimeControl | AuthorityDomain::AgentMind
    ) {
        Ok(())
    } else {
        Err(ContextDbError::AuthorityDenied {
            actor_id: INTERNAL_ACTOR_ID.to_string(),
            domain,
        })
    }
}

fn runtime_child_descriptors(
    nodes: &HashMap<String, ContextNodeRecord>,
    parent_id: &str,
) -> Vec<(i64, String, String)> {
    let mut children = nodes
        .values()
        .filter(|candidate| candidate.parent_id.as_deref() == Some(parent_id))
        .map(|candidate| {
            (
                candidate.order_key,
                candidate.node_id.clone(),
                candidate.subtree_hash.clone(),
            )
        })
        .collect::<Vec<_>>();
    children.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    children
}

fn runtime_descendants(
    nodes: &HashMap<String, ContextNodeRecord>,
    node_id: &str,
) -> ContextDbResult<Vec<String>> {
    let mut descendants = Vec::new();
    let mut pending = vec![node_id.to_string()];
    let mut visited = HashSet::new();
    while let Some(candidate) = pending.pop() {
        if !visited.insert(candidate.clone()) {
            return Err(ContextDbError::Corrupt(format!(
                "Runtime mutation basis contains a Node cycle at '{candidate}'"
            )));
        }
        pending.extend(
            nodes
                .values()
                .filter(|node| node.parent_id.as_deref() == Some(candidate.as_str()))
                .map(|node| node.node_id.clone()),
        );
        descendants.push(candidate);
    }
    Ok(descendants)
}

fn ensure_runtime_leaf(
    existing_nodes: &HashMap<String, ContextNodeRecord>,
    node: &ContextNodeRecord,
) -> ContextDbResult<()> {
    if existing_nodes
        .values()
        .any(|candidate| candidate.parent_id.as_deref() == Some(node.node_id.as_str()))
    {
        return Err(ContextDbError::Corrupt(format!(
            "managed Mind record '{}' unexpectedly owns child Nodes",
            node.node_id
        )));
    }
    Ok(())
}

fn encode_mutation_record(
    collection: ContextCollection,
    logical_id: &str,
    body: &serde_json::Value,
) -> ContextDbResult<String> {
    let spec = runtime_collection_spec(collection)?;
    match collection {
        ContextCollection::Frame => {
            let value: ContextFrame = serde_json::from_value(body.clone())?;
            if value.id != logical_id {
                return Err(mutation_identity_error(collection, logical_id, &value.id));
            }
            encode_record(spec.record_kind, &value)
        }
        ContextCollection::Relation => {
            let value: ContextRelation = serde_json::from_value(body.clone())?;
            let actual = relation_logical_id(&value.subject, &value.relation, &value.object);
            if actual != logical_id {
                return Err(mutation_identity_error(collection, logical_id, &actual));
            }
            encode_record(spec.record_kind, &value)
        }
        ContextCollection::Retired => {
            let value: RetiredEntry = serde_json::from_value(body.clone())?;
            if value.id != logical_id {
                return Err(mutation_identity_error(collection, logical_id, &value.id));
            }
            encode_record(spec.record_kind, &value)
        }
        ContextCollection::Retiring => {
            let value: FrameRetirement = serde_json::from_value(body.clone())?;
            if value.frame_id != logical_id {
                return Err(mutation_identity_error(
                    collection,
                    logical_id,
                    &value.frame_id,
                ));
            }
            encode_record(spec.record_kind, &value)
        }
        ContextCollection::Protected => {
            let value: ProtectedEntry = serde_json::from_value(body.clone())?;
            if value.id != logical_id {
                return Err(mutation_identity_error(collection, logical_id, &value.id));
            }
            encode_record(spec.record_kind, &value)
        }
        ContextCollection::Checkpoint => {
            let value: MindCheckpoint = serde_json::from_value(body.clone())?;
            if value.id != logical_id {
                return Err(mutation_identity_error(collection, logical_id, &value.id));
            }
            encode_record(spec.record_kind, &value)
        }
        ContextCollection::MutationClocks => {
            if logical_id != "mutation-clocks" {
                return Err(mutation_identity_error(
                    collection,
                    "mutation-clocks",
                    logical_id,
                ));
            }
            let value: ContextMutationClocks = serde_json::from_value(body.clone())?;
            encode_record(spec.record_kind, &value)
        }
    }
}

fn mutation_identity_error(
    collection: ContextCollection,
    expected: &str,
    actual: &str,
) -> ContextDbError {
    ContextDbError::Precondition(format!(
        "Context Mutation identity mismatch in '{}': expected '{}', body contains '{}'",
        collection.as_str(),
        expected,
        actual
    ))
}

fn runtime_authority() -> ContextAuthority {
    ContextAuthority::new(
        INTERNAL_ACTOR_ID,
        [AuthorityDomain::RuntimeControl, AuthorityDomain::AgentMind],
    )
}

pub(crate) fn desired_nodes(
    state: &MindState,
    meta: ProjectionMeta,
) -> ContextDbResult<Vec<DesiredNode>> {
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
        // Relations do not currently carry an explicit ID. The shared
        // ContextStore protocol owns their tuple identity so every backend and
        // the MVCC layer address the same record.
        nodes.push(desired_record(
            &stable_node_id(
                "relation",
                &relation_logical_id(&relation.subject, &relation.relation, &relation.object),
            ),
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

/// Materializes the exact Runtime AST used by every ContextDB backend.
///
/// PostgreSQL migration/initialization and SQLite creation must not each
/// invent their own schema tree or Merkle calculation.  This pure constructor
/// is the shared compatibility boundary: if it decodes back to a projection,
/// that projection is byte-for-byte equivalent to the supplied Mind record.
pub(crate) fn materialize_runtime_snapshot(
    context_id: &str,
    projection: &NewMindProjection,
    updated_at: DateTime<Utc>,
) -> ContextDbResult<RuntimeContextSnapshot> {
    if context_id != projection.context_id {
        return Err(ContextDbError::Precondition(format!(
            "Runtime Context identity '{context_id}' differs from projection identity '{}'",
            projection.context_id
        )));
    }
    let state = validate_new_projection(projection)?;
    let desired = desired_nodes(
        &state,
        ProjectionMeta {
            revision: projection.revision,
            state_hash: projection.state_hash.clone(),
            head_event_id: projection.head_event_id.clone(),
            updated_at,
        },
    )?;
    let (root_body, root_content_hash) = canonicalize_body(ROOT_BODY)?;
    let mut nodes = HashMap::<String, ContextNodeRecord>::new();
    nodes.insert(
        ROOT_NODE_ID.to_string(),
        ContextNodeRecord {
            node_id: ROOT_NODE_ID.to_string(),
            parent_id: None,
            order_key: 0,
            owner_domain: AuthorityDomain::RuntimeControl,
            node_revision: 1,
            body_sexpr: root_body,
            content_hash: root_content_hash,
            subtree_hash: String::new(),
        },
    );
    for desired_node in desired {
        let (body_sexpr, content_hash) = canonicalize_body(&desired_node.body_sexpr)?;
        let subtree_hash = calculate_subtree_hash(
            &desired_node.node_id,
            desired_node.owner_domain,
            &body_sexpr,
            &[],
        );
        let record = ContextNodeRecord {
            node_id: desired_node.node_id.clone(),
            parent_id: Some(desired_node.parent_id),
            order_key: desired_node.order_key,
            owner_domain: desired_node.owner_domain,
            node_revision: 1,
            body_sexpr,
            content_hash,
            subtree_hash,
        };
        if nodes.insert(desired_node.node_id.clone(), record).is_some() {
            return Err(ContextDbError::Invalid(format!(
                "Runtime Mind contains duplicate Node identity '{}'",
                desired_node.node_id
            )));
        }
    }
    for node_id in [
        FRAMES_NODE_ID,
        RELATIONS_NODE_ID,
        RETIRED_NODE_ID,
        RETIRING_NODE_ID,
        PROTECTED_NODE_ID,
        CHECKPOINTS_NODE_ID,
        ROOT_NODE_ID,
    ] {
        refresh_materialized_subtree_hash(&mut nodes, node_id)?;
    }
    let root_hash = nodes
        .get(ROOT_NODE_ID)
        .ok_or_else(|| ContextDbError::Corrupt("materialized root disappeared".to_string()))?
        .subtree_hash
        .clone();
    let mut nodes = nodes.into_values().collect::<Vec<_>>();
    nodes.sort_by(|left, right| {
        left.parent_id
            .cmp(&right.parent_id)
            .then_with(|| left.order_key.cmp(&right.order_key))
            .then_with(|| left.node_id.cmp(&right.node_id))
    });
    let snapshot = RuntimeContextSnapshot {
        context_id: context_id.to_string(),
        revision: 1,
        root_node_id: ROOT_NODE_ID.to_string(),
        root_hash,
        nodes,
    };
    validate_runtime_snapshot(&snapshot)?;
    let reconstructed = decode_projection(&snapshot)?;
    let expected = MindProjectionRecord {
        context_id: projection.context_id.clone(),
        revision: projection.revision,
        state: projection.state.clone(),
        state_hash: projection.state_hash.clone(),
        head_event_id: projection.head_event_id.clone(),
        updated_at,
    };
    if reconstructed != expected {
        return Err(ContextDbError::Corrupt(format!(
            "materialized Runtime Context '{context_id}' did not reproduce its exact Mind Projection"
        )));
    }
    Ok(snapshot)
}

/// Computes the authoritative Runtime-tree commitment for a complete Mind
/// projection without reading from storage.
///
/// Native mutation persistence compares its bounded patch against this value.
/// This is intentionally distinct from rebuilding a diff: the Store still
/// writes only addressed Nodes, but a missing domain mutation cannot silently
/// advance projection metadata to a state the persisted AST does not contain.
pub(crate) fn expected_runtime_root_hash(
    context_id: &str,
    projection: &NewMindProjection,
    updated_at: DateTime<Utc>,
) -> ContextDbResult<String> {
    Ok(materialize_runtime_snapshot(context_id, projection, updated_at)?.root_hash)
}

fn refresh_materialized_subtree_hash(
    nodes: &mut HashMap<String, ContextNodeRecord>,
    node_id: &str,
) -> ContextDbResult<()> {
    let mut children = nodes
        .values()
        .filter(|candidate| candidate.parent_id.as_deref() == Some(node_id))
        .map(|candidate| {
            (
                candidate.order_key,
                candidate.node_id.clone(),
                candidate.subtree_hash.clone(),
            )
        })
        .collect::<Vec<_>>();
    children.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    let node = nodes.get_mut(node_id).ok_or_else(|| {
        ContextDbError::Corrupt(format!("materialized Node '{node_id}' is missing"))
    })?;
    node.subtree_hash = calculate_subtree_hash(
        &node.node_id,
        node.owner_domain,
        &node.body_sexpr,
        &children,
    );
    Ok(())
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

pub(crate) fn decode_record<T: DeserializeOwned>(
    body: &str,
    expected_kind: &str,
) -> ContextDbResult<T> {
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

pub(crate) fn diff_nodes(
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

pub(crate) fn validate_runtime_snapshot(snapshot: &RuntimeContextSnapshot) -> ContextDbResult<()> {
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
    let mut verified_hashes = HashMap::new();
    let mut verifying = HashSet::new();
    verify_runtime_merkle_node(
        &snapshot.context_id,
        ROOT_NODE_ID,
        &by_id,
        &mut verified_hashes,
        &mut verifying,
    )?;
    Ok(())
}

fn verify_runtime_merkle_node(
    context_id: &str,
    node_id: &str,
    by_id: &HashMap<&str, &ContextNodeRecord>,
    verified: &mut HashMap<String, String>,
    verifying: &mut HashSet<String>,
) -> ContextDbResult<String> {
    if let Some(hash) = verified.get(node_id) {
        return Ok(hash.clone());
    }
    if !verifying.insert(node_id.to_string()) {
        return Err(ContextDbError::Corrupt(format!(
            "Runtime Context '{context_id}' contains a Merkle cycle at '{node_id}'"
        )));
    }
    let node = required_node(by_id, node_id)?;
    let (canonical, content_hash) = canonicalize_body(&node.body_sexpr).map_err(|error| {
        ContextDbError::Corrupt(format!(
            "Runtime Context '{context_id}' Node '{node_id}' has a non-canonical body: {error}"
        ))
    })?;
    if canonical != node.body_sexpr || content_hash != node.content_hash {
        return Err(ContextDbError::Corrupt(format!(
            "Runtime Context '{context_id}' Node '{node_id}' content hash is invalid"
        )));
    }
    let mut children = by_id
        .values()
        .filter(|candidate| candidate.parent_id.as_deref() == Some(node_id))
        .copied()
        .collect::<Vec<_>>();
    children.sort_by(|left, right| {
        left.order_key
            .cmp(&right.order_key)
            .then_with(|| left.node_id.cmp(&right.node_id))
    });
    let mut child_hashes = Vec::with_capacity(children.len());
    for child in children {
        child_hashes.push((
            child.order_key,
            child.node_id.clone(),
            verify_runtime_merkle_node(context_id, &child.node_id, by_id, verified, verifying)?,
        ));
    }
    let calculated = calculate_subtree_hash(
        &node.node_id,
        node.owner_domain,
        &node.body_sexpr,
        &child_hashes,
    );
    if calculated != node.subtree_hash {
        return Err(ContextDbError::Corrupt(format!(
            "Runtime Context '{context_id}' Node '{node_id}' subtree hash is invalid"
        )));
    }
    verifying.remove(node_id);
    verified.insert(node_id.to_string(), calculated.clone());
    Ok(calculated)
}

pub(crate) fn decode_projection(
    snapshot: &RuntimeContextSnapshot,
) -> ContextDbResult<MindProjectionRecord> {
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
                &relation_logical_id(&relation.subject, &relation.relation, &relation.object),
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

pub(crate) fn validate_new_projection(
    projection: &NewMindProjection,
) -> ContextDbResult<MindState> {
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

    fn projection(state: &MindState, event_id: &str) -> NewMindProjection {
        NewMindProjection {
            context_id: "context-a".to_string(),
            revision: state.version,
            state: serde_json::to_value(state).unwrap(),
            state_hash: mind_state_hash(state).unwrap(),
            head_event_id: Some(event_id.to_string()),
            recall_documents: Vec::new(),
        }
    }

    #[test]
    fn materialized_runtime_tree_round_trips_and_verifies_every_merkle_hash() {
        let state = sample_state();
        let projection = projection(&state, "event-seven");
        let updated_at = DateTime::parse_from_rfc3339("2026-09-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let snapshot = materialize_runtime_snapshot("context-a", &projection, updated_at).unwrap();

        validate_runtime_snapshot(&snapshot).unwrap();
        assert_eq!(
            decode_projection(&snapshot).unwrap(),
            MindProjectionRecord {
                context_id: "context-a".to_string(),
                revision: 7,
                state: projection.state,
                state_hash: projection.state_hash,
                head_event_id: Some("event-seven".to_string()),
                updated_at,
            }
        );

        let mut corrupt = snapshot;
        corrupt
            .nodes
            .iter_mut()
            .find(|node| node.node_id == stable_node_id("frame", "frame-a"))
            .unwrap()
            .subtree_hash = "corrupt".to_string();
        assert!(matches!(
            validate_runtime_snapshot(&corrupt),
            Err(ContextDbError::Corrupt(_))
        ));
    }

    #[test]
    fn bounded_native_patch_matches_full_next_state_materialization() {
        let current = sample_state();
        let current_projection = projection(&current, "event-seven");
        let current_time = DateTime::parse_from_rfc3339("2026-09-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let snapshot =
            materialize_runtime_snapshot("context-a", &current_projection, current_time).unwrap();

        let mut next = current.clone();
        next.version = 8;
        next.frames[0].body = "(fact revised)".to_string();
        next.frames[0].revision += 1;
        next.frames[0].updated_version = 8;
        next.frames.swap(0, 1);
        next.protected.remove("frame-a");
        next.mutation_clocks.frame_order_version = 8;
        let next_projection = projection(&next, "event-eight");
        let next_time = DateTime::parse_from_rfc3339("2026-09-01T00:00:01Z")
            .unwrap()
            .with_timezone(&Utc);
        let desired = desired_nodes(
            &next,
            ProjectionMeta {
                revision: 8,
                state_hash: next_projection.state_hash.clone(),
                head_event_id: Some("event-eight".to_string()),
                updated_at: next_time,
            },
        )
        .unwrap();
        let operations = diff_nodes(&snapshot, &desired).unwrap();
        let basis = mutation_basis_from_snapshot_for_test(&snapshot);
        let patch = apply_runtime_operations_to_basis("context-a", &basis, &operations).unwrap();

        let expected =
            materialize_runtime_snapshot("context-a", &next_projection, next_time).unwrap();
        assert_eq!(patch.root_hash, expected.root_hash);

        let mut patched = snapshot
            .nodes
            .into_iter()
            .map(|node| (node.node_id.clone(), node))
            .collect::<HashMap<_, _>>();
        for node_id in patch.deleted_node_ids {
            patched.remove(&node_id);
        }
        for node in patch.inserted_nodes.into_iter().chain(patch.updated_nodes) {
            patched.insert(node.node_id.clone(), node);
        }
        let mut patched_nodes = patched.into_values().collect::<Vec<_>>();
        patched_nodes.sort_by(|left, right| {
            left.parent_id
                .cmp(&right.parent_id)
                .then_with(|| left.order_key.cmp(&right.order_key))
                .then_with(|| left.node_id.cmp(&right.node_id))
        });
        let patched_snapshot = RuntimeContextSnapshot {
            context_id: "context-a".to_string(),
            revision: patch.next_context_revision,
            root_node_id: ROOT_NODE_ID.to_string(),
            root_hash: patch.root_hash,
            nodes: patched_nodes,
        };
        validate_runtime_snapshot(&patched_snapshot).unwrap();
        assert_eq!(
            decode_projection(&patched_snapshot).unwrap().state,
            next_projection.state
        );
    }

    fn mutation_basis_from_snapshot_for_test(
        snapshot: &RuntimeContextSnapshot,
    ) -> RuntimeMutationBasis {
        let mut nodes = snapshot
            .nodes
            .iter()
            .cloned()
            .map(|node| (node.node_id.clone(), node))
            .collect::<HashMap<_, _>>();
        let meta_node = nodes.remove(META_NODE_ID).unwrap();
        RuntimeMutationBasis {
            context_revision: snapshot.revision,
            meta_node,
            nodes,
        }
    }
}
