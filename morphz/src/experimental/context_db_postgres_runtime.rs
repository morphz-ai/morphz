//! PostgreSQL persistence adapter for the authoritative Runtime Context AST.
//!
//! This module deliberately reuses the SQLite adapter's pure schema codec and
//! mutation compiler. PostgreSQL supplies row locking, bounded reads and bulk
//! persistence; it does not independently reinterpret Mind semantics.

use super::context_db::{AuthorityDomain, ContextDbError, ContextDbResult, ContextNodeRecord};
use super::context_db_runtime::{
    apply_runtime_operations_to_basis, compile_runtime_operations, decode_projection,
    decode_record, diff_nodes, expected_runtime_root_hash, materialize_runtime_snapshot,
    runtime_collection_spec, runtime_node_id, validate_new_projection, validate_plan_projection,
    validate_runtime_snapshot, ProjectionMeta, RuntimeContextSnapshot, RuntimeMutationBasis,
    RuntimeStoragePatch, META_NODE_ID, ROOT_NODE_ID,
};
use super::{ExperimentalFeaturePermit, CONTEXT_DB};
use crate::context_store::{ContextMutationPlan, ContextStateMutation};
use crate::memory::{MindProjectionHead, MindProjectionRecord, NewMindProjection};
use chrono::{DateTime, SecondsFormat, Utc};
use sqlx::postgres::PgRow;
use sqlx::{PgPool, Postgres, QueryBuilder, Row};
use std::collections::{BTreeSet, HashMap};

const POSTGRES_CONTEXTDB_SCHEMA_LOCK: i64 = 0x4D4F_5250_485A_4344_i64;
const SCHEMA_VERSION: i32 = 1;
// Nine bind parameters per insert row remain well below PostgreSQL's protocol
// parameter ceiling while keeping ordinary Runtime mutations at one statement.
const MAX_BULK_NODES: usize = 4_096;

#[derive(Debug, Clone)]
pub(crate) struct PostgresContextDbRuntimeAdapter {
    pool: PgPool,
}

#[derive(Debug)]
struct LockedRuntimeBasis {
    root_hash: String,
    mutation: RuntimeMutationBasis,
}

impl PostgresContextDbRuntimeAdapter {
    pub(crate) async fn attach(
        pool: PgPool,
        permit: ExperimentalFeaturePermit,
    ) -> ContextDbResult<Self> {
        if !permit.permits(CONTEXT_DB) {
            return Err(ContextDbError::FeatureDenied);
        }
        let adapter = Self { pool };
        adapter.initialize().await?;
        Ok(adapter)
    }

    async fn initialize(&self) -> ContextDbResult<()> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock($1)")
            .bind(POSTGRES_CONTEXTDB_SCHEMA_LOCK)
            .execute(&mut *transaction)
            .await?;
        sqlx::query(
            r#"CREATE TABLE IF NOT EXISTS experimental_contextdb_contexts (
                   context_id TEXT PRIMARY KEY
                     REFERENCES cognitive_contexts(id) ON DELETE CASCADE,
                   tenant_id TEXT NOT NULL,
                   agent_id TEXT NOT NULL,
                   revision BIGINT NOT NULL CHECK(revision >= 1),
                   root_node_id TEXT NOT NULL,
                   root_hash TEXT NOT NULL,
                   schema_version INTEGER NOT NULL,
                   created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
               )"#,
        )
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            r#"CREATE TABLE IF NOT EXISTS experimental_contextdb_nodes (
                   context_id TEXT NOT NULL
                     REFERENCES experimental_contextdb_contexts(context_id)
                     ON DELETE CASCADE,
                   node_id TEXT NOT NULL,
                   parent_id TEXT,
                   order_key BIGINT NOT NULL,
                   owner_domain TEXT NOT NULL,
                   node_revision BIGINT NOT NULL CHECK(node_revision >= 1),
                   body_sexpr TEXT NOT NULL,
                   content_hash TEXT NOT NULL,
                   subtree_hash TEXT NOT NULL,
                   PRIMARY KEY(context_id, node_id)
               )"#,
        )
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            r#"CREATE INDEX IF NOT EXISTS idx_experimental_contextdb_nodes_parent
               ON experimental_contextdb_nodes(context_id, parent_id, order_key, node_id)"#,
        )
        .execute(&mut *transaction)
        .await?;
        // Bounded idempotency receipts contain transaction identity and a
        // digest only. They are neither Agent Trajectory nor replay history.
        sqlx::query(
            r#"CREATE TABLE IF NOT EXISTS experimental_contextdb_receipts (
                   context_id TEXT NOT NULL
                     REFERENCES experimental_contextdb_contexts(context_id)
                     ON DELETE CASCADE,
                   idempotency_key TEXT NOT NULL,
                   request_hash TEXT NOT NULL,
                   receipt_json JSONB NOT NULL,
                   committed_at TEXT NOT NULL,
                   PRIMARY KEY(context_id, idempotency_key)
               )"#,
        )
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    pub(crate) async fn pending_legacy_count(&self) -> ContextDbResult<i64> {
        Ok(sqlx::query_scalar::<_, i64>(
            r#"SELECT COUNT(*)
               FROM (
                 SELECT context_id FROM context_heads
                 UNION
                 SELECT context_id FROM mind_projections
               ) legacy
               WHERE NOT EXISTS (
                 SELECT 1 FROM experimental_contextdb_contexts authoritative
                 WHERE authoritative.context_id = legacy.context_id
               )"#,
        )
        .fetch_one(&self.pool)
        .await?)
    }

    pub(crate) async fn install_projection_in_transaction(
        &self,
        transaction: &mut sqlx::Transaction<'_, Postgres>,
        projection: &NewMindProjection,
        updated_at: DateTime<Utc>,
    ) -> ContextDbResult<MindProjectionRecord> {
        let existing = sqlx::query_scalar::<_, i64>(
            r#"SELECT revision FROM experimental_contextdb_contexts
               WHERE context_id = $1 FOR UPDATE"#,
        )
        .bind(&projection.context_id)
        .fetch_optional(&mut **transaction)
        .await?;
        if existing.is_some() {
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

        let ownership =
            sqlx::query("SELECT agent_id FROM cognitive_contexts WHERE id = $1 FOR UPDATE")
                .bind(&projection.context_id)
                .fetch_optional(&mut **transaction)
                .await?
                .ok_or_else(|| {
                    ContextDbError::NotFound(format!("Runtime Context '{}'", projection.context_id))
                })?;
        let agent_id = ownership.get::<String, _>("agent_id");
        let snapshot =
            materialize_runtime_snapshot(&projection.context_id, projection, updated_at)?;
        let now = updated_at.to_rfc3339_opts(SecondsFormat::Nanos, true);
        sqlx::query(
            r#"INSERT INTO experimental_contextdb_contexts
               (context_id, tenant_id, agent_id, revision, root_node_id,
                root_hash, schema_version, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)"#,
        )
        .bind(&projection.context_id)
        .bind(&agent_id)
        .bind(&agent_id)
        .bind(i64::try_from(snapshot.revision).map_err(|_| {
            ContextDbError::Invalid("Context revision exceeds PostgreSQL BIGINT".to_string())
        })?)
        .bind(&snapshot.root_node_id)
        .bind(&snapshot.root_hash)
        .bind(SCHEMA_VERSION)
        .bind(&now)
        .execute(&mut **transaction)
        .await?;
        insert_nodes(transaction, &projection.context_id, &snapshot.nodes).await?;
        Ok(MindProjectionRecord {
            context_id: projection.context_id.clone(),
            revision: projection.revision,
            state: projection.state.clone(),
            state_hash: projection.state_hash.clone(),
            head_event_id: projection.head_event_id.clone(),
            updated_at,
        })
    }

    pub(crate) async fn sync_projection_in_transaction(
        &self,
        transaction: &mut sqlx::Transaction<'_, Postgres>,
        projection: &NewMindProjection,
        updated_at: DateTime<Utc>,
    ) -> ContextDbResult<MindProjectionRecord> {
        let state = validate_new_projection(projection)?;
        let snapshot = self
            .load_runtime_snapshot_for_update(transaction, &projection.context_id)
            .await?
            .ok_or_else(|| {
                ContextDbError::NotFound(format!("Context '{}'/Mind", projection.context_id))
            })?;
        let desired = super::context_db_runtime::desired_nodes(
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
            let basis = mutation_basis_from_snapshot(&snapshot)?;
            let patch =
                apply_runtime_operations_to_basis(&projection.context_id, &basis, &operations)?;
            let root_hash = patch.root_hash.clone();
            persist_patch(transaction, &projection.context_id, &patch, updated_at).await?;
            root_hash
        } else {
            snapshot.root_hash
        };
        if actual_root_hash != expected_root_hash {
            return Err(ContextDbError::Precondition(format!(
                "broad Context synchronization produced root '{actual_root_hash}' but its fenced projection requires '{expected_root_hash}'"
            )));
        }
        Ok(MindProjectionRecord {
            context_id: projection.context_id.clone(),
            revision: projection.revision,
            state: projection.state.clone(),
            state_hash: projection.state_hash.clone(),
            head_event_id: projection.head_event_id.clone(),
            updated_at,
        })
    }

    pub(crate) async fn apply_mutation_plan_in_transaction(
        &self,
        transaction: &mut sqlx::Transaction<'_, Postgres>,
        plan: &ContextMutationPlan,
        projection: &NewMindProjection,
        updated_at: DateTime<Utc>,
    ) -> ContextDbResult<MindProjectionRecord> {
        plan.validate_shape().map_err(ContextDbError::Invalid)?;
        validate_new_projection(projection)?;
        validate_plan_projection(plan, projection)?;
        let expected_root_hash =
            expected_runtime_root_hash(&projection.context_id, projection, updated_at)?;
        if matches!(
            plan.mutations.as_slice(),
            [ContextStateMutation::ReplaceMind { .. }]
        ) {
            let ContextStateMutation::ReplaceMind { state } = &plan.mutations[0] else {
                unreachable!("ReplaceMind shape was checked above")
            };
            if state != &projection.state {
                return Err(ContextDbError::Precondition(
                    "ReplaceMind body differs from the fenced next projection".to_string(),
                ));
            }
            return self
                .sync_projection_in_transaction(transaction, projection, updated_at)
                .await;
        }

        let basis = self.load_runtime_mutation_basis(transaction, plan).await?;
        let meta = decode_projection_meta(&basis.mutation.meta_node.body_sexpr)?;
        if meta.revision != plan.expected_revision || meta.state_hash != plan.expected_state_hash {
            return Err(ContextDbError::Conflict {
                context_id: plan.context_id.clone(),
                expected: plan.expected_revision,
                actual: meta.revision,
            });
        }
        let operations = compile_runtime_operations(
            plan,
            projection,
            updated_at,
            &basis.mutation.meta_node,
            &basis.mutation.nodes,
        )?;
        let patch = apply_runtime_operations_to_basis(
            &projection.context_id,
            &basis.mutation,
            &operations,
        )?;
        if patch.root_hash != expected_root_hash {
            return Err(ContextDbError::Precondition(format!(
                "Context Mutation produced root '{}' but its fenced projection requires '{}'",
                patch.root_hash, expected_root_hash
            )));
        }
        if patch.root_hash == basis.root_hash {
            return Err(ContextDbError::Precondition(
                "Context Mutation advanced metadata without changing the authoritative root hash"
                    .to_string(),
            ));
        }
        persist_patch(transaction, &projection.context_id, &patch, updated_at).await?;
        Ok(MindProjectionRecord {
            context_id: projection.context_id.clone(),
            revision: projection.revision,
            state: projection.state.clone(),
            state_hash: projection.state_hash.clone(),
            head_event_id: projection.head_event_id.clone(),
            updated_at,
        })
    }

    pub(crate) async fn load_projection_in_transaction(
        &self,
        transaction: &mut sqlx::Transaction<'_, Postgres>,
        context_id: &str,
    ) -> ContextDbResult<Option<MindProjectionRecord>> {
        self.load_runtime_snapshot_in_transaction(transaction, context_id)
            .await?
            .map(|snapshot| decode_projection(&snapshot))
            .transpose()
    }

    pub(crate) async fn load_projection_heads_in_transaction(
        &self,
        transaction: &mut sqlx::Transaction<'_, Postgres>,
        context_ids: &[String],
    ) -> ContextDbResult<Vec<MindProjectionHead>> {
        if context_ids.is_empty() {
            return Ok(Vec::new());
        }
        let rows = sqlx::query(
            r#"SELECT context.context_id, node.body_sexpr
               FROM experimental_contextdb_contexts context
               LEFT JOIN experimental_contextdb_nodes node
                 ON node.context_id = context.context_id
                AND node.node_id = $1
               WHERE context.context_id = ANY($2)"#,
        )
        .bind(META_NODE_ID)
        .bind(context_ids)
        .fetch_all(&mut **transaction)
        .await?;
        let mut heads = rows
            .into_iter()
            .map(|row| {
                let context_id = row.get::<String, _>("context_id");
                let body = row.get::<Option<String>, _>("body_sexpr").ok_or_else(|| {
                    ContextDbError::Corrupt(format!(
                        "Runtime Context '{context_id}' is missing its projection metadata"
                    ))
                })?;
                let meta = decode_projection_meta(&body)?;
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

    pub(crate) fn decode_projection_snapshot_value(
        &self,
        value: serde_json::Value,
    ) -> ContextDbResult<Option<MindProjectionRecord>> {
        serde_json::from_value::<Option<RuntimeContextSnapshot>>(value)?
            .map(|snapshot| {
                validate_runtime_snapshot(&snapshot)?;
                decode_projection(&snapshot)
            })
            .transpose()
    }

    async fn load_runtime_snapshot_in_transaction(
        &self,
        transaction: &mut sqlx::Transaction<'_, Postgres>,
        context_id: &str,
    ) -> ContextDbResult<Option<RuntimeContextSnapshot>> {
        load_runtime_snapshot(transaction, context_id, false).await
    }

    async fn load_runtime_snapshot_for_update(
        &self,
        transaction: &mut sqlx::Transaction<'_, Postgres>,
        context_id: &str,
    ) -> ContextDbResult<Option<RuntimeContextSnapshot>> {
        load_runtime_snapshot(transaction, context_id, true).await
    }

    async fn load_runtime_mutation_basis(
        &self,
        transaction: &mut sqlx::Transaction<'_, Postgres>,
        plan: &ContextMutationPlan,
    ) -> ContextDbResult<LockedRuntimeBasis> {
        let context = sqlx::query(
            r#"SELECT revision, root_node_id, root_hash, schema_version
               FROM experimental_contextdb_contexts
               WHERE context_id = $1 FOR UPDATE"#,
        )
        .bind(&plan.context_id)
        .fetch_optional(&mut **transaction)
        .await?
        .ok_or_else(|| ContextDbError::NotFound(format!("Context '{}'", plan.context_id)))?;
        validate_schema_version(&context, &plan.context_id)?;
        let context_revision = positive_u64(&context, "revision", "Context revision")?;
        let root_node_id = context.get::<String, _>("root_node_id");
        let root_hash = context.get::<String, _>("root_hash");
        if root_node_id != ROOT_NODE_ID {
            return Err(ContextDbError::Corrupt(format!(
                "Runtime Context '{}' has unexpected root Node '{root_node_id}'",
                plan.context_id
            )));
        }

        let mut node_ids = BTreeSet::from([ROOT_NODE_ID.to_string(), META_NODE_ID.to_string()]);
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
                    collection_parents
                        .insert(runtime_collection_spec(*collection)?.parent_id.to_string());
                }
                ContextStateMutation::SetOrder { collection, .. } => {
                    collection_parents
                        .insert(runtime_collection_spec(*collection)?.parent_id.to_string());
                }
                ContextStateMutation::ReplaceMind { .. } => {
                    return Err(ContextDbError::Invalid(
                        "ReplaceMind must use the broad replacement path".to_string(),
                    ));
                }
            }
        }

        let rows = sqlx::query(
            r#"SELECT node_id, parent_id, order_key, owner_domain, node_revision,
                      body_sexpr, content_hash, subtree_hash
               FROM experimental_contextdb_nodes
               WHERE context_id = $1
                 AND (node_id = ANY($2)
                      OR parent_id = $3
                      OR parent_id = ANY($4)
                      OR parent_id = ANY($2))
               ORDER BY parent_id, order_key, node_id"#,
        )
        .bind(&plan.context_id)
        .bind(node_ids.iter().cloned().collect::<Vec<_>>())
        .bind(ROOT_NODE_ID)
        .bind(collection_parents.iter().cloned().collect::<Vec<_>>())
        .fetch_all(&mut **transaction)
        .await?;
        let mut nodes = rows
            .iter()
            .map(node_from_row)
            .collect::<ContextDbResult<Vec<_>>>()?
            .into_iter()
            .map(|node| (node.node_id.clone(), node))
            .collect::<HashMap<_, _>>();
        let meta_node = nodes.remove(META_NODE_ID).ok_or_else(|| {
            ContextDbError::Corrupt(format!(
                "Runtime Context '{}' is missing projection metadata",
                plan.context_id
            ))
        })?;
        let root = nodes.get(ROOT_NODE_ID).ok_or_else(|| {
            ContextDbError::Corrupt(format!(
                "Runtime Context '{}' is missing its root Node",
                plan.context_id
            ))
        })?;
        if root.parent_id.is_some()
            || root.owner_domain != AuthorityDomain::RuntimeControl
            || root.body_sexpr != super::context_db_runtime::ROOT_BODY
            || root.subtree_hash != root_hash
        {
            return Err(ContextDbError::Corrupt(format!(
                "Runtime Context '{}' has an invalid root Node",
                plan.context_id
            )));
        }
        Ok(LockedRuntimeBasis {
            root_hash,
            mutation: RuntimeMutationBasis {
                context_revision,
                meta_node,
                nodes,
            },
        })
    }
}

async fn load_runtime_snapshot(
    transaction: &mut sqlx::Transaction<'_, Postgres>,
    context_id: &str,
    for_update: bool,
) -> ContextDbResult<Option<RuntimeContextSnapshot>> {
    if !for_update {
        return load_runtime_snapshot_consistent(transaction, context_id).await;
    }
    let Some(context) = sqlx::query(
        r#"SELECT revision, root_node_id, root_hash, schema_version
           FROM experimental_contextdb_contexts
           WHERE context_id = $1 FOR UPDATE"#,
    )
    .bind(context_id)
    .fetch_optional(&mut **transaction)
    .await?
    else {
        return Ok(None);
    };
    validate_schema_version(&context, context_id)?;
    let rows = sqlx::query(
        r#"SELECT node_id, parent_id, order_key, owner_domain, node_revision,
                  body_sexpr, content_hash, subtree_hash
           FROM experimental_contextdb_nodes
           WHERE context_id = $1
           ORDER BY parent_id, order_key, node_id"#,
    )
    .bind(context_id)
    .fetch_all(&mut **transaction)
    .await?;
    if rows.is_empty() {
        return Err(ContextDbError::Corrupt(format!(
            "Context '{context_id}' contains no root Node"
        )));
    }
    let snapshot = RuntimeContextSnapshot {
        context_id: context_id.to_string(),
        revision: positive_u64(&context, "revision", "Context revision")?,
        root_node_id: context.get("root_node_id"),
        root_hash: context.get("root_hash"),
        nodes: rows
            .iter()
            .map(node_from_row)
            .collect::<ContextDbResult<Vec<_>>>()?,
    };
    validate_runtime_snapshot(&snapshot)?;
    Ok(Some(snapshot))
}

/// Reads Context metadata and every AST Node from one PostgreSQL statement.
/// Under READ COMMITTED, splitting these into two statements can observe two
/// different committed versions and falsely report corruption during a valid
/// concurrent commit. This mirrors the existing legacy projection safeguard.
async fn load_runtime_snapshot_consistent(
    transaction: &mut sqlx::Transaction<'_, Postgres>,
    context_id: &str,
) -> ContextDbResult<Option<RuntimeContextSnapshot>> {
    let rows = sqlx::query(
        r#"SELECT context.revision AS context_revision,
                  context.root_node_id, context.root_hash,
                  context.schema_version,
                  node.node_id, node.parent_id, node.order_key,
                  node.owner_domain, node.node_revision, node.body_sexpr,
                  node.content_hash, node.subtree_hash
           FROM experimental_contextdb_contexts context
           LEFT JOIN experimental_contextdb_nodes node
             ON node.context_id = context.context_id
           WHERE context.context_id = $1
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
    validate_schema_version(first, context_id)?;
    let snapshot = RuntimeContextSnapshot {
        context_id: context_id.to_string(),
        revision: u64::try_from(first.get::<i64, _>("context_revision"))
            .map_err(|_| ContextDbError::Corrupt("invalid Context revision".to_string()))?,
        root_node_id: first.get("root_node_id"),
        root_hash: first.get("root_hash"),
        nodes: rows
            .iter()
            .map(|row| {
                Ok(ContextNodeRecord {
                    node_id: row.get::<Option<String>, _>("node_id").ok_or_else(|| {
                        ContextDbError::Corrupt("missing Node identity".to_string())
                    })?,
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
                    body_sexpr: row
                        .get::<Option<String>, _>("body_sexpr")
                        .ok_or_else(|| ContextDbError::Corrupt("missing Node body".to_string()))?,
                    content_hash: row.get::<Option<String>, _>("content_hash").ok_or_else(
                        || ContextDbError::Corrupt("missing Node content hash".to_string()),
                    )?,
                    subtree_hash: row.get::<Option<String>, _>("subtree_hash").ok_or_else(
                        || ContextDbError::Corrupt("missing Node subtree hash".to_string()),
                    )?,
                })
            })
            .collect::<ContextDbResult<Vec<_>>>()?,
    };
    validate_runtime_snapshot(&snapshot)?;
    Ok(Some(snapshot))
}

fn mutation_basis_from_snapshot(
    snapshot: &RuntimeContextSnapshot,
) -> ContextDbResult<RuntimeMutationBasis> {
    let mut nodes = snapshot
        .nodes
        .iter()
        .cloned()
        .map(|node| (node.node_id.clone(), node))
        .collect::<HashMap<_, _>>();
    let meta_node = nodes.remove(META_NODE_ID).ok_or_else(|| {
        ContextDbError::Corrupt(format!(
            "Runtime Context '{}' is missing projection metadata",
            snapshot.context_id
        ))
    })?;
    Ok(RuntimeMutationBasis {
        context_revision: snapshot.revision,
        meta_node,
        nodes,
    })
}

fn decode_projection_meta(body: &str) -> ContextDbResult<ProjectionMeta> {
    decode_record(body, "projection-meta")
}

async fn persist_patch(
    transaction: &mut sqlx::Transaction<'_, Postgres>,
    context_id: &str,
    patch: &RuntimeStoragePatch,
    updated_at: DateTime<Utc>,
) -> ContextDbResult<()> {
    if !patch.deleted_node_ids.is_empty() {
        let deleted = sqlx::query(
            r#"DELETE FROM experimental_contextdb_nodes
               WHERE context_id = $1 AND node_id = ANY($2)"#,
        )
        .bind(context_id)
        .bind(&patch.deleted_node_ids)
        .execute(&mut **transaction)
        .await?;
        if usize::try_from(deleted.rows_affected()).ok() != Some(patch.deleted_node_ids.len()) {
            return Err(ContextDbError::Precondition(
                "a Runtime Context Node disappeared during fenced deletion".to_string(),
            ));
        }
    }
    insert_nodes(transaction, context_id, &patch.inserted_nodes).await?;
    update_nodes(transaction, context_id, &patch.updated_nodes).await?;
    let changed = sqlx::query(
        r#"UPDATE experimental_contextdb_contexts
           SET revision = $1, root_hash = $2, updated_at = $3
           WHERE context_id = $4 AND revision = $5"#,
    )
    .bind(i64::try_from(patch.next_context_revision).map_err(|_| {
        ContextDbError::Invalid("Context revision exceeds PostgreSQL BIGINT".to_string())
    })?)
    .bind(&patch.root_hash)
    .bind(updated_at.to_rfc3339_opts(SecondsFormat::Nanos, true))
    .bind(context_id)
    .bind(i64::try_from(patch.expected_context_revision).map_err(|_| {
        ContextDbError::Invalid("Context revision exceeds PostgreSQL BIGINT".to_string())
    })?)
    .execute(&mut **transaction)
    .await?;
    if changed.rows_affected() != 1 {
        return Err(ContextDbError::Precondition(
            "Runtime Context revision changed during its locked mutation".to_string(),
        ));
    }
    Ok(())
}

async fn insert_nodes(
    transaction: &mut sqlx::Transaction<'_, Postgres>,
    context_id: &str,
    nodes: &[ContextNodeRecord],
) -> ContextDbResult<()> {
    if nodes.is_empty() {
        return Ok(());
    }
    let encoded = nodes
        .iter()
        .map(|node| {
            Ok((
                node,
                i64::try_from(node.node_revision).map_err(|_| {
                    ContextDbError::Invalid("Node revision exceeds PostgreSQL BIGINT".to_string())
                })?,
            ))
        })
        .collect::<ContextDbResult<Vec<_>>>()?;
    for chunk in encoded.chunks(MAX_BULK_NODES) {
        let mut query = QueryBuilder::<Postgres>::new(
            r#"INSERT INTO experimental_contextdb_nodes
               (context_id, node_id, parent_id, order_key, owner_domain,
                node_revision, body_sexpr, content_hash, subtree_hash) "#,
        );
        query.push_values(chunk, |mut row, (node, node_revision)| {
            row.push_bind(context_id)
                .push_bind(&node.node_id)
                .push_bind(&node.parent_id)
                .push_bind(node.order_key)
                .push_bind(node.owner_domain.as_str())
                .push_bind(*node_revision)
                .push_bind(&node.body_sexpr)
                .push_bind(&node.content_hash)
                .push_bind(&node.subtree_hash);
        });
        let inserted = query.build().execute(&mut **transaction).await?;
        if usize::try_from(inserted.rows_affected()).ok() != Some(chunk.len()) {
            return Err(ContextDbError::Precondition(
                "Runtime Context bulk Node insert was incomplete".to_string(),
            ));
        }
    }
    Ok(())
}

async fn update_nodes(
    transaction: &mut sqlx::Transaction<'_, Postgres>,
    context_id: &str,
    nodes: &[ContextNodeRecord],
) -> ContextDbResult<()> {
    if nodes.is_empty() {
        return Ok(());
    }
    let encoded = nodes
        .iter()
        .map(|node| {
            Ok((
                node,
                i64::try_from(node.node_revision).map_err(|_| {
                    ContextDbError::Invalid("Node revision exceeds PostgreSQL BIGINT".to_string())
                })?,
            ))
        })
        .collect::<ContextDbResult<Vec<_>>>()?;
    for chunk in encoded.chunks(MAX_BULK_NODES) {
        let mut query = QueryBuilder::<Postgres>::new(
            r#"UPDATE experimental_contextdb_nodes AS target
               SET parent_id = patch.parent_id,
                   order_key = patch.order_key,
                   owner_domain = patch.owner_domain,
                   node_revision = patch.node_revision,
                   body_sexpr = patch.body_sexpr,
                   content_hash = patch.content_hash,
                   subtree_hash = patch.subtree_hash
               FROM ("#,
        );
        query.push_values(chunk, |mut row, (node, node_revision)| {
            row.push_bind(&node.node_id)
                .push_bind(&node.parent_id)
                .push_bind(node.order_key)
                .push_bind(node.owner_domain.as_str())
                .push_bind(*node_revision)
                .push_bind(&node.body_sexpr)
                .push_bind(&node.content_hash)
                .push_bind(&node.subtree_hash);
        });
        query.push(
            r#") AS patch(node_id, parent_id, order_key, owner_domain,
                          node_revision, body_sexpr, content_hash, subtree_hash)
               WHERE target.context_id = "#,
        );
        query
            .push_bind(context_id)
            .push(" AND target.node_id = patch.node_id");
        let updated = query.build().execute(&mut **transaction).await?;
        if usize::try_from(updated.rows_affected()).ok() != Some(chunk.len()) {
            return Err(ContextDbError::Precondition(
                "Runtime Context bulk Node update was incomplete".to_string(),
            ));
        }
    }
    Ok(())
}

fn node_from_row(row: &PgRow) -> ContextDbResult<ContextNodeRecord> {
    Ok(ContextNodeRecord {
        node_id: row.get("node_id"),
        parent_id: row.get("parent_id"),
        order_key: row.get("order_key"),
        owner_domain: AuthorityDomain::from_storage(&row.get::<String, _>("owner_domain"))?,
        node_revision: positive_u64(row, "node_revision", "Node revision")?,
        body_sexpr: row.get("body_sexpr"),
        content_hash: row.get("content_hash"),
        subtree_hash: row.get("subtree_hash"),
    })
}

fn validate_schema_version(row: &PgRow, context_id: &str) -> ContextDbResult<()> {
    let version = row.get::<i32, _>("schema_version");
    if version != SCHEMA_VERSION {
        return Err(ContextDbError::Corrupt(format!(
            "Runtime Context '{context_id}' uses unsupported ContextDB schema version {version}"
        )));
    }
    Ok(())
}

fn positive_u64(row: &PgRow, column: &str, label: &str) -> ContextDbResult<u64> {
    u64::try_from(row.get::<i64, _>(column))
        .map_err(|_| ContextDbError::Corrupt(format!("invalid {label}")))
}
