//! Runtime adapter which makes a ContextDB AST the authoritative current Mind.
//!
//! The adapter intentionally keeps immutable Agent Trajectory facts and
//! scheduler/control state in the existing Runtime tables.  Because it shares
//! the same SQLite pool, all three persistence domains can still commit in one
//! physical transaction.

use super::context_db::{
    calculate_subtree_hash, canonicalize_body, AuthorityDomain, ContextAuthority, ContextDbError,
    ContextDbResult, ContextNodeDraft, ContextNodeRecord, ContextOperation, ContextSnapshot,
    ContextTransaction, CreateContextRequest, SqliteContextDb, MAX_TRANSACTION_OPERATIONS,
};
use crate::context_ast::{
    decode_context_head, decode_context_value, encode_context_head, encode_context_value,
    native_mind_state_hash_from_roots, ContextAstHead,
};
use crate::context_store::{
    context_state_commitment, relation_logical_id, ContextCollection, ContextMutationPlan,
    ContextNodeValue, ContextStateCommitment, ContextStateHead, ContextStateMutation,
    ContextStateRecord,
};
use crate::memory::{MindProjectionHead, MindProjectionRecord, NewMindProjection};
use crate::orchestrator::context::{mind_state_hash, mind_state_hash_matches, MindState};
use chrono::{DateTime, Utc};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Row, Sqlite, SqlitePool};
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
pub(crate) const ROOT_BODY: &str = "(context (schema morphz-runtime-mind-v2))";
const INTERNAL_ACTOR_ID: &str = "morphz-runtime-context-adapter";

#[derive(Debug, Clone)]
pub(crate) struct ContextDbRuntimeAdapter {
    db: SqliteContextDb,
}

pub(crate) type ProjectionMeta = ContextAstHead;

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
    /// Nodes whose structural identity/order/subtree hash were loaded, but
    /// whose payload was deliberately omitted. They are sibling hash inputs,
    /// never legal mutation targets or persistence outputs.
    pub(crate) hash_only_node_ids: BTreeSet<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct RuntimeStoragePatch {
    pub(crate) expected_context_revision: u64,
    pub(crate) next_context_revision: u64,
    pub(crate) root_hash: String,
    pub(crate) state_hash: String,
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

async fn initialize_runtime_heads(pool: &SqlitePool) -> ContextDbResult<()> {
    let mut transaction = pool.begin().await?;
    sqlx::query(
        r#"CREATE TABLE IF NOT EXISTS experimental_contextdb_runtime_heads (
               context_id TEXT PRIMARY KEY,
               revision INTEGER NOT NULL CHECK(revision >= 0),
               state_hash TEXT NOT NULL,
               head_event_id TEXT,
               updated_at TEXT NOT NULL,
               FOREIGN KEY(context_id)
                 REFERENCES experimental_contextdb_contexts(context_id)
                 ON DELETE CASCADE
           )"#,
    )
    .execute(&mut *transaction)
    .await?;
    // One-time, idempotent upgrade for ContextDB files created before the
    // explicit Runtime Mind head existed. Only the small metadata Node is read;
    // the full AST never has to be reconstructed during startup migration.
    let missing_heads = sqlx::query(
        r#"SELECT context_db.context_id, meta.body_sexpr
           FROM experimental_contextdb_contexts context_db
           JOIN experimental_contextdb_nodes meta
             ON meta.context_id = context_db.context_id
            AND meta.node_id = ?
           LEFT JOIN experimental_contextdb_runtime_heads head
             ON head.context_id = context_db.context_id
           WHERE head.context_id IS NULL"#,
    )
    .bind(META_NODE_ID)
    .fetch_all(&mut *transaction)
    .await?;
    for row in missing_heads {
        let context_id = row.get::<String, _>("context_id");
        let meta = decode_context_head(&row.get::<String, _>("body_sexpr"))
            .map_err(ContextDbError::Corrupt)?;
        persist_runtime_head(
            &mut transaction,
            &context_id,
            meta.revision,
            &meta.state_hash,
            meta.head_event_id.as_deref(),
            meta.updated_at,
        )
        .await?;
    }
    transaction.commit().await?;
    Ok(())
}

async fn persist_runtime_head(
    transaction: &mut sqlx::Transaction<'_, Sqlite>,
    context_id: &str,
    revision: u64,
    state_hash: &str,
    head_event_id: Option<&str>,
    updated_at: DateTime<Utc>,
) -> ContextDbResult<()> {
    sqlx::query(
        r#"INSERT INTO experimental_contextdb_runtime_heads
           (context_id, revision, state_hash, head_event_id, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(context_id) DO UPDATE SET
             revision = excluded.revision,
             state_hash = excluded.state_hash,
             head_event_id = excluded.head_event_id,
             updated_at = excluded.updated_at"#,
    )
    .bind(context_id)
    .bind(
        i64::try_from(revision).map_err(|_| {
            ContextDbError::Invalid("Mind revision exceeds SQLite INTEGER".to_string())
        })?,
    )
    .bind(state_hash)
    .bind(head_event_id)
    .bind(updated_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

impl ContextDbRuntimeAdapter {
    pub(crate) async fn attach(pool: SqlitePool) -> ContextDbResult<Self> {
        let db = SqliteContextDb::attach(pool.clone()).await?;
        initialize_runtime_heads(&pool).await?;
        Ok(Self { db })
    }

    pub(crate) async fn install_context_state_in_transaction(
        &self,
        transaction: &mut sqlx::Transaction<'_, Sqlite>,
        context_id: &str,
        state: &MindState,
        commitment: &ContextStateCommitment,
        head_event_id: Option<&str>,
        updated_at: DateTime<Utc>,
    ) -> ContextDbResult<ContextStateRecord> {
        if commitment.revision() != state.version
            || commitment != &context_state_commitment(state).map_err(ContextDbError::Invalid)?
        {
            return Err(ContextDbError::Precondition(
                "Context initialization state differs from its native commitment".to_string(),
            ));
        }
        let context_exists = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM experimental_contextdb_contexts WHERE context_id = ?",
        )
        .bind(context_id)
        .fetch_one(&mut **transaction)
        .await?
            != 0;
        if context_exists {
            return self
                .load_context_state_in_transaction(transaction, context_id)
                .await?
                .ok_or_else(|| {
                    ContextDbError::Corrupt(format!(
                        "Runtime Context '{context_id}' exists without authoritative state"
                    ))
                });
        }
        let agent_id =
            sqlx::query_scalar::<_, String>("SELECT agent_id FROM cognitive_contexts WHERE id = ?")
                .bind(context_id)
                .fetch_optional(&mut **transaction)
                .await?
                .ok_or_else(|| {
                    ContextDbError::NotFound(format!("Runtime Context '{context_id}'"))
                })?;
        let created = self
            .db
            .create_context_in_transaction(
                transaction,
                CreateContextRequest {
                    context_id: context_id.to_string(),
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
        self.sync_context_state_against_snapshot(
            transaction,
            context_id,
            state,
            commitment,
            head_event_id,
            updated_at,
            created.into(),
        )
        .await
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
        next_state: &MindState,
        next_commitment: &ContextStateCommitment,
        head_event_id: &str,
        updated_at: DateTime<Utc>,
    ) -> ContextDbResult<ContextStateHead> {
        plan.validate_shape().map_err(ContextDbError::Invalid)?;
        let next_head = ProjectionMeta {
            revision: plan.next_revision,
            state_hash: plan.next_state_hash.clone(),
            head_event_id: Some(head_event_id.to_string()),
            updated_at,
        };
        if next_state.version != plan.next_revision
            || next_commitment.revision() != plan.next_revision
            || next_commitment.state_hash() != plan.next_state_hash
        {
            return Err(ContextDbError::Precondition(
                "native next state commitment differs from its Context Mutation fence".to_string(),
            ));
        }
        let expected_root_hash =
            expected_runtime_root_hash_from_commitment(next_commitment, next_head.clone())?;

        if matches!(
            plan.mutations.as_slice(),
            [ContextStateMutation::ReplaceMind { .. }]
        ) {
            let ContextStateMutation::ReplaceMind { state: replacement } = &plan.mutations[0]
            else {
                unreachable!("ReplaceMind shape was checked above")
            };
            if replacement != next_state {
                return Err(ContextDbError::Precondition(
                    "ReplaceMind body differs from its native next-state fence".to_string(),
                ));
            }
            let snapshot = self
                .load_runtime_snapshot_in_transaction(transaction, &plan.context_id)
                .await?
                .ok_or_else(|| {
                    ContextDbError::NotFound(format!("Context '{}'", plan.context_id))
                })?;
            let committed = self
                .sync_context_state_against_snapshot(
                    transaction,
                    &plan.context_id,
                    replacement,
                    next_commitment,
                    Some(head_event_id),
                    updated_at,
                    snapshot,
                )
                .await?;
            return Ok(ContextStateHead {
                context_id: committed.context_id,
                revision: committed.revision,
                state_hash: committed.state_hash,
                head_event_id: committed.head_event_id,
                updated_at: committed.updated_at,
            });
        }

        let basis = self.load_runtime_mutation_basis(transaction, plan).await?;
        let current_meta =
            decode_context_head(&basis.meta_node.body_sexpr).map_err(ContextDbError::Corrupt)?;
        if current_meta.revision != plan.expected_revision
            || current_meta.state_hash != plan.expected_state_hash
        {
            return Err(ContextDbError::Conflict {
                context_id: plan.context_id.clone(),
                expected: plan.expected_revision,
                actual: current_meta.revision,
            });
        }

        let operations =
            compile_runtime_operations(plan, &next_head, &basis.meta_node, &basis.nodes)?;
        let expected_patch =
            apply_runtime_operations_to_basis(&plan.context_id, &basis, &operations)?;
        if expected_patch.state_hash != plan.next_state_hash {
            return Err(ContextDbError::Precondition(format!(
                "Context Mutation commits native state '{}' but its next-state fence requires '{}'",
                expected_patch.state_hash, plan.next_state_hash
            )));
        }
        if expected_patch.root_hash != expected_root_hash {
            return Err(ContextDbError::Precondition(format!(
                "incremental physical root '{}' differs from full-state root '{}'",
                expected_patch.root_hash, expected_root_hash
            )));
        }
        let receipt = self
            .db
            .apply_transaction_in_transaction(
                transaction,
                ContextTransaction {
                    transaction_id: format!("runtime-context-{head_event_id}"),
                    idempotency_key: format!("runtime-context-{head_event_id}"),
                    context_id: plan.context_id.clone(),
                    base_revision: basis.context_revision,
                    authority: runtime_authority(),
                    operations,
                },
            )
            .await?;
        if receipt.root_hash != expected_patch.root_hash {
            return Err(ContextDbError::Precondition(format!(
                "Context Mutation produced root '{}' but its fenced projection requires '{}'",
                receipt.root_hash, expected_patch.root_hash
            )));
        }
        persist_runtime_head(
            transaction,
            &plan.context_id,
            plan.next_revision,
            &plan.next_state_hash,
            Some(head_event_id),
            updated_at,
        )
        .await?;

        Ok(ContextStateHead {
            context_id: plan.context_id.clone(),
            revision: plan.next_revision,
            state_hash: plan.next_state_hash.clone(),
            head_event_id: Some(head_event_id.to_string()),
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
        let commitment = context_state_commitment(&state).map_err(ContextDbError::Invalid)?;
        let committed = self
            .sync_context_state_against_snapshot(
                transaction,
                &projection.context_id,
                &state,
                &commitment,
                projection.head_event_id.as_deref(),
                updated_at,
                snapshot,
            )
            .await?;
        Ok(MindProjectionRecord {
            context_id: committed.context_id,
            revision: committed.revision,
            state: serde_json::to_value(committed.state)?,
            state_hash: committed.state_hash,
            head_event_id: committed.head_event_id,
            updated_at: committed.updated_at,
        })
    }

    // These fields form one fenced snapshot/AST synchronization boundary;
    // keeping them explicit makes the transaction's preconditions auditable.
    #[allow(clippy::too_many_arguments)]
    async fn sync_context_state_against_snapshot(
        &self,
        transaction: &mut sqlx::Transaction<'_, Sqlite>,
        context_id: &str,
        state: &MindState,
        commitment: &ContextStateCommitment,
        head_event_id: Option<&str>,
        updated_at: DateTime<Utc>,
        snapshot: RuntimeContextSnapshot,
    ) -> ContextDbResult<ContextStateRecord> {
        if commitment.revision() != state.version
            || commitment != &context_state_commitment(state).map_err(ContextDbError::Invalid)?
        {
            return Err(ContextDbError::Precondition(
                "broad Context state differs from its native commitment".to_string(),
            ));
        }
        let state_hash = commitment.state_hash().to_string();
        let desired = desired_nodes(
            state,
            ProjectionMeta {
                revision: state.version,
                state_hash: state_hash.clone(),
                head_event_id: head_event_id.map(str::to_string),
                updated_at,
            },
        )?;
        let operations = diff_nodes(&snapshot, &desired)?;
        let expected_root_hash = expected_runtime_root_hash_from_commitment(
            commitment,
            ProjectionMeta {
                revision: state.version,
                state_hash: state_hash.clone(),
                head_event_id: head_event_id.map(str::to_string),
                updated_at,
            },
        )?;
        let actual_root_hash = if !operations.is_empty() {
            let synchronization_identity = format!(
                "{}:{}:{}:{}",
                context_id,
                state.version,
                state_hash,
                head_event_id.unwrap_or("initial")
            );
            let synchronization_digest =
                format!("{:x}", Sha256::digest(synchronization_identity.as_bytes()));
            let mut base_revision = snapshot.revision;
            let mut root_hash = snapshot.root_hash;
            for (chunk_index, chunk) in operations.chunks(MAX_TRANSACTION_OPERATIONS).enumerate() {
                let chunk_identity =
                    format!("runtime-mind-{synchronization_digest}-chunk-{chunk_index}");
                let receipt = self
                    .db
                    .apply_transaction_in_transaction(
                        transaction,
                        ContextTransaction {
                            transaction_id: chunk_identity.clone(),
                            idempotency_key: chunk_identity,
                            context_id: context_id.to_string(),
                            base_revision,
                            authority: runtime_authority(),
                            operations: chunk.to_vec(),
                        },
                    )
                    .await?;
                base_revision = receipt.after_revision;
                root_hash = receipt.root_hash;
            }
            root_hash
        } else {
            snapshot.root_hash
        };
        if actual_root_hash != expected_root_hash {
            return Err(ContextDbError::Precondition(format!(
                "broad Context synchronization produced root '{actual_root_hash}' but its fenced projection requires '{expected_root_hash}'"
            )));
        }
        persist_runtime_head(
            transaction,
            context_id,
            state.version,
            &state_hash,
            head_event_id,
            updated_at,
        )
        .await?;
        // `apply_transaction_in_transaction` has already fenced and persisted
        // the exact diff in this outer SQLite transaction. Re-reading and
        // reconstructing the entire AST here would add another full Context
        // query to every successful Mind commit without increasing safety.
        Ok(ContextStateRecord {
            context_id: context_id.to_string(),
            revision: state.version,
            state: state.clone(),
            state_hash,
            head_event_id: head_event_id.map(str::to_string),
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

    pub(crate) async fn load_context_state_in_transaction(
        &self,
        transaction: &mut sqlx::Transaction<'_, Sqlite>,
        context_id: &str,
    ) -> ContextDbResult<Option<ContextStateRecord>> {
        self.load_runtime_snapshot_in_transaction(transaction, context_id)
            .await?
            .map(|snapshot| decode_context_state(&snapshot))
            .transpose()
    }

    /// Decodes one statement-consistent ContextDB AST directly into the
    /// backend-neutral ContextStore read model. Runtime hot reads must use
    /// this entry point rather than reconstructing the legacy JSON projection.
    pub(crate) fn decode_context_state_snapshot_json(
        &self,
        encoded: &str,
    ) -> ContextDbResult<Option<ContextStateRecord>> {
        serde_json::from_str::<Option<RuntimeContextSnapshot>>(encoded)?
            .map(|snapshot| {
                validate_runtime_snapshot(&snapshot)?;
                decode_context_state(&snapshot)
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
            r#"SELECT context_id, revision, updated_at
               FROM experimental_contextdb_runtime_heads
               WHERE context_id IN (SELECT value FROM json_each(?))"#,
        )
        .bind(serde_json::to_string(context_ids)?)
        .fetch_all(&mut **transaction)
        .await?;
        let mut heads = rows
            .into_iter()
            .map(|row| {
                let context_id = row.get::<String, _>("context_id");
                Ok(MindProjectionHead {
                    context_id,
                    revision: u64::try_from(row.get::<i64, _>("revision")).map_err(|_| {
                        ContextDbError::Corrupt("invalid Runtime Mind revision".to_string())
                    })?,
                    updated_at: DateTime::parse_from_rfc3339(&row.get::<String, _>("updated_at"))
                        .map_err(|error| ContextDbError::Corrupt(error.to_string()))?
                        .with_timezone(&Utc),
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

    pub(crate) async fn load_context_state_heads_in_transaction(
        &self,
        transaction: &mut sqlx::Transaction<'_, Sqlite>,
        context_ids: &[String],
    ) -> ContextDbResult<Vec<ContextStateHead>> {
        if context_ids.is_empty() {
            return Ok(Vec::new());
        }
        let rows = sqlx::query(
            r#"SELECT context_id, revision, state_hash, head_event_id, updated_at
               FROM experimental_contextdb_runtime_heads
               WHERE context_id IN (SELECT value FROM json_each(?))"#,
        )
        .bind(serde_json::to_string(context_ids)?)
        .fetch_all(&mut **transaction)
        .await?;
        let mut heads = rows
            .into_iter()
            .map(|row| {
                Ok(ContextStateHead {
                    context_id: row.get("context_id"),
                    revision: u64::try_from(row.get::<i64, _>("revision")).map_err(|_| {
                        ContextDbError::Corrupt("invalid Runtime Context revision".to_string())
                    })?,
                    state_hash: row.get("state_hash"),
                    head_event_id: row.get("head_event_id"),
                    updated_at: DateTime::parse_from_rfc3339(&row.get::<String, _>("updated_at"))
                        .map_err(|error| ContextDbError::Corrupt(error.to_string()))?
                        .with_timezone(&Utc),
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

        let mut node_ids = BTreeSet::from([ROOT_NODE_ID.to_string(), META_NODE_ID.to_string()]);
        let mut collection_parents = BTreeSet::new();
        let mut fully_loaded_parents = BTreeSet::new();
        for mutation in &plan.mutations {
            match mutation {
                ContextStateMutation::Upsert { value, .. } => {
                    let collection = value.collection();
                    node_ids.insert(runtime_node_id(collection, &value.logical_id())?);
                    collection_parents
                        .insert(runtime_collection_spec(collection)?.parent_id.to_string());
                }
                ContextStateMutation::Remove {
                    collection,
                    logical_id,
                } => {
                    node_ids.insert(runtime_node_id(*collection, logical_id)?);
                    collection_parents
                        .insert(runtime_collection_spec(*collection)?.parent_id.to_string());
                }
                ContextStateMutation::SetOrder { collection, .. } => {
                    let parent_id = runtime_collection_spec(*collection)?.parent_id.to_string();
                    collection_parents.insert(parent_id.clone());
                    // Reordering may persist any member. Ordinary upsert and
                    // remove operations need sibling subtree hashes only.
                    fully_loaded_parents.insert(parent_id);
                }
                ContextStateMutation::ReplaceMind { .. } => {
                    return Err(ContextDbError::Invalid(
                        "ReplaceMind must use the broad replacement path".to_string(),
                    ));
                }
            }
        }

        let fully_loaded_node_ids = node_ids
            .iter()
            .cloned()
            .chain(collection_parents.iter().cloned())
            .collect::<Vec<_>>();
        let fully_loaded_parents = fully_loaded_parents
            .into_iter()
            // Preserve payloads below an explicitly addressed record if the
            // Runtime schema later grows descendants below today's leaves.
            .chain(node_ids.iter().cloned())
            .collect::<Vec<_>>();
        let node_ids_json = serde_json::to_string(&node_ids)?;
        let collection_parents_json = serde_json::to_string(&collection_parents)?;
        let fully_loaded_node_ids_json = serde_json::to_string(&fully_loaded_node_ids)?;
        let fully_loaded_parents_json = serde_json::to_string(&fully_loaded_parents)?;
        let rows = sqlx::query(
            r#"SELECT node_id, parent_id, order_key, owner_domain, node_revision,
                      CASE WHEN node_id IN (SELECT value FROM json_each(?))
                                  OR parent_id IN (SELECT value FROM json_each(?))
                           THEN body_sexpr ELSE NULL END AS body_sexpr,
                      CASE WHEN node_id IN (SELECT value FROM json_each(?))
                                  OR parent_id IN (SELECT value FROM json_each(?))
                           THEN content_hash ELSE NULL END AS content_hash,
                      subtree_hash
               FROM experimental_contextdb_nodes
               WHERE context_id = ?
                 AND (node_id IN (SELECT value FROM json_each(?))
                      OR parent_id = ?
                      OR parent_id IN (SELECT value FROM json_each(?))
                      OR parent_id IN (SELECT value FROM json_each(?)))
               ORDER BY parent_id, order_key, node_id"#,
        )
        .bind(&fully_loaded_node_ids_json)
        .bind(&fully_loaded_parents_json)
        .bind(&fully_loaded_node_ids_json)
        .bind(&fully_loaded_parents_json)
        .bind(&plan.context_id)
        .bind(&node_ids_json)
        .bind(ROOT_NODE_ID)
        .bind(&collection_parents_json)
        .bind(&node_ids_json)
        .fetch_all(&mut **transaction)
        .await?;
        let mut hash_only_node_ids = BTreeSet::new();
        let mut nodes = HashMap::with_capacity(rows.len());
        for row in rows {
            let node_id = row.get::<String, _>("node_id");
            let body_sexpr = row.get::<Option<String>, _>("body_sexpr");
            let content_hash = row.get::<Option<String>, _>("content_hash");
            if body_sexpr.is_some() != content_hash.is_some() {
                return Err(ContextDbError::Corrupt(format!(
                    "Runtime Context '{}' Node '{node_id}' returned a partial payload",
                    plan.context_id
                )));
            }
            if body_sexpr.is_none() {
                hash_only_node_ids.insert(node_id.clone());
            }
            let record = ContextNodeRecord {
                node_id,
                parent_id: row.get("parent_id"),
                order_key: row.get("order_key"),
                owner_domain: AuthorityDomain::from_storage(&row.get::<String, _>("owner_domain"))?,
                node_revision: u64::try_from(row.get::<i64, _>("node_revision"))
                    .map_err(|_| ContextDbError::Corrupt("invalid Node revision".to_string()))?,
                body_sexpr: body_sexpr.unwrap_or_default(),
                content_hash: content_hash.unwrap_or_default(),
                subtree_hash: row.get("subtree_hash"),
            };
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
        if hash_only_node_ids.remove(META_NODE_ID) {
            return Err(ContextDbError::Corrupt(format!(
                "Runtime Context '{}' projection metadata was not fully loaded",
                plan.context_id
            )));
        }
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
            hash_only_node_ids,
        })
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct RuntimeCollectionSpec {
    pub(crate) physical_kind: &'static str,
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
            parent_id: FRAMES_NODE_ID,
            ordered: true,
            default_order: 0,
        },
        ContextCollection::Relation => RuntimeCollectionSpec {
            physical_kind: "relation",
            parent_id: RELATIONS_NODE_ID,
            ordered: true,
            default_order: 0,
        },
        ContextCollection::Retired => RuntimeCollectionSpec {
            physical_kind: "retired",
            parent_id: RETIRED_NODE_ID,
            ordered: false,
            default_order: 0,
        },
        ContextCollection::Retiring => RuntimeCollectionSpec {
            physical_kind: "retiring",
            parent_id: RETIRING_NODE_ID,
            ordered: false,
            default_order: 0,
        },
        ContextCollection::Protected => RuntimeCollectionSpec {
            physical_kind: "protected",
            parent_id: PROTECTED_NODE_ID,
            ordered: false,
            default_order: 0,
        },
        ContextCollection::Checkpoint => RuntimeCollectionSpec {
            physical_kind: "checkpoint",
            parent_id: CHECKPOINTS_NODE_ID,
            ordered: true,
            default_order: 0,
        },
        ContextCollection::MutationClocks => RuntimeCollectionSpec {
            physical_kind: "mutation-clocks",
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

pub(crate) fn compile_runtime_operations(
    plan: &ContextMutationPlan,
    next_head: &ProjectionMeta,
    meta_node: &ContextNodeRecord,
    existing_nodes: &HashMap<String, ContextNodeRecord>,
) -> ContextDbResult<Vec<ContextOperation>> {
    let mut upserts =
        BTreeMap::<(ContextCollection, String), (ContextNodeValue, Option<u64>)>::new();
    let mut removes = BTreeSet::<(ContextCollection, String)>::new();
    let mut orders = BTreeMap::<ContextCollection, Vec<String>>::new();

    for mutation in &plan.mutations {
        match mutation {
            ContextStateMutation::Upsert { value, order } => {
                let collection = value.collection();
                let logical_id = value.logical_id();
                let key = (collection, logical_id.clone());
                if removes.contains(&key)
                    || upserts
                        .insert(key.clone(), (value.clone(), *order))
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

    for ((collection, logical_id), (value, supplied_order)) in &upserts {
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
            body_sexpr: encode_context_value(value).map_err(ContextDbError::Invalid)?,
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

    let desired_meta = desired_meta_node(
        META_NODE_ID,
        ROOT_NODE_ID,
        0,
        AuthorityDomain::RuntimeControl,
        next_head,
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
                require_loaded_mutation_payload(basis, node_id)?;
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
                require_loaded_mutation_payload(basis, node_id)?;
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
                require_loaded_mutation_payload(basis, node_id)?;
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
    let state_hash = native_state_hash_from_nodes(
        &nodes,
        plan_next_revision_from_operations(&basis.meta_node, operations)?,
    )?;

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
    if let Some(node_id) = updated_nodes
        .iter()
        .find(|node| basis.hash_only_node_ids.contains(&node.node_id))
        .map(|node| node.node_id.as_str())
    {
        return Err(ContextDbError::Corrupt(format!(
            "hash-only sibling Node '{node_id}' unexpectedly became a persistence output"
        )));
    }
    updated_nodes.sort_by(|left, right| left.node_id.cmp(&right.node_id));
    let next_context_revision = basis
        .context_revision
        .checked_add(1)
        .ok_or_else(|| ContextDbError::Invalid("Context revision overflow".to_string()))?;
    Ok(RuntimeStoragePatch {
        expected_context_revision: basis.context_revision,
        next_context_revision,
        root_hash,
        state_hash,
        deleted_node_ids,
        inserted_nodes,
        updated_nodes,
    })
}

fn plan_next_revision_from_operations(
    current_meta_node: &ContextNodeRecord,
    operations: &[ContextOperation],
) -> ContextDbResult<u64> {
    let replacement = operations
        .iter()
        .find_map(|operation| match operation {
            ContextOperation::ReplaceNode {
                node_id,
                body_sexpr,
                ..
            } if node_id == META_NODE_ID => Some(body_sexpr),
            _ => None,
        })
        .ok_or_else(|| {
            ContextDbError::Precondition(
                "Context Mutation does not advance native Mind metadata".to_string(),
            )
        })?;
    let current =
        decode_context_head(&current_meta_node.body_sexpr).map_err(ContextDbError::Corrupt)?;
    let next = decode_context_head(replacement).map_err(ContextDbError::Invalid)?;
    let ordinary_advance = next.revision == current.revision.saturating_add(1);
    // Mind seeding is the one domain transition which deliberately keeps the
    // target Context at revision zero while replacing its initial empty Mind.
    // Keep this exception exact: it may happen only once, must acquire an
    // Event head, and must change the state commitment.  A generic same-
    // revision rewrite would bypass the Context CAS contract.
    let initial_seed = current.revision == 0
        && next.revision == 0
        && current.head_event_id.is_none()
        && next.head_event_id.is_some()
        && current.state_hash != next.state_hash;
    if !ordinary_advance && !initial_seed {
        return Err(ContextDbError::Precondition(
            "Context Mutation metadata must advance exactly once unless it is the one-time revision-zero Seed"
                .to_string(),
        ));
    }
    Ok(next.revision)
}

fn native_state_hash_from_nodes(
    nodes: &HashMap<String, ContextNodeRecord>,
    revision: u64,
) -> ContextDbResult<String> {
    let roots = [
        (10, FRAMES_NODE_ID),
        (20, RELATIONS_NODE_ID),
        (30, RETIRED_NODE_ID),
        (40, RETIRING_NODE_ID),
        (50, PROTECTED_NODE_ID),
        (60, CHECKPOINTS_NODE_ID),
        (70, CLOCKS_NODE_ID),
    ]
    .into_iter()
    .map(|(order, node_id)| {
        let node = nodes.get(node_id).ok_or_else(|| {
            ContextDbError::Corrupt(format!("native Mind root '{node_id}' is missing"))
        })?;
        if node.parent_id.as_deref() != Some(ROOT_NODE_ID) || node.order_key != order {
            return Err(ContextDbError::Corrupt(format!(
                "native Mind root '{node_id}' has an invalid parent/order"
            )));
        }
        Ok((order, node_id.to_string(), node.subtree_hash.clone()))
    })
    .collect::<ContextDbResult<Vec<_>>>()?;
    native_mind_state_hash_from_roots(revision, &roots).map_err(ContextDbError::Corrupt)
}

fn require_loaded_mutation_payload(
    basis: &RuntimeMutationBasis,
    node_id: &str,
) -> ContextDbResult<()> {
    if basis.hash_only_node_ids.contains(node_id) {
        return Err(ContextDbError::Corrupt(format!(
            "Runtime mutation targeted hash-only sibling Node '{node_id}'"
        )));
    }
    Ok(())
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
        desired_meta_node(
            META_NODE_ID,
            ROOT_NODE_ID,
            0,
            AuthorityDomain::RuntimeControl,
            &meta,
        )?,
        desired_group(FRAMES_NODE_ID, 10, "frames"),
        desired_group(RELATIONS_NODE_ID, 20, "relations"),
        desired_group(RETIRED_NODE_ID, 30, "retired"),
        desired_group(RETIRING_NODE_ID, 40, "retiring"),
        desired_group(PROTECTED_NODE_ID, 50, "protected"),
        desired_group(CHECKPOINTS_NODE_ID, 60, "checkpoints"),
        desired_value_node(
            CLOCKS_NODE_ID,
            ROOT_NODE_ID,
            70,
            AuthorityDomain::AgentMind,
            &ContextNodeValue::MutationClocks(state.mutation_clocks.clone()),
        )?,
    ];

    for (index, frame) in state.frames.iter().enumerate() {
        nodes.push(desired_value_node(
            &stable_node_id("frame", &frame.id),
            FRAMES_NODE_ID,
            checked_order(index)?,
            AuthorityDomain::AgentMind,
            &ContextNodeValue::Frame(frame.clone()),
        )?);
    }
    for (index, relation) in state.relations.iter().enumerate() {
        // Relations do not currently carry an explicit ID. The shared
        // ContextStore protocol owns their tuple identity so every backend and
        // the MVCC layer address the same record.
        nodes.push(desired_value_node(
            &stable_node_id(
                "relation",
                &relation_logical_id(&relation.subject, &relation.relation, &relation.object),
            ),
            RELATIONS_NODE_ID,
            checked_order(index)?,
            AuthorityDomain::AgentMind,
            &ContextNodeValue::Relation(relation.clone()),
        )?);
    }
    for id in &state.retired {
        nodes.push(desired_value_node(
            &stable_node_id("retired", id),
            RETIRED_NODE_ID,
            0,
            AuthorityDomain::AgentMind,
            &ContextNodeValue::Retired(id.clone()),
        )?);
    }
    for (id, retirement) in &state.retiring {
        nodes.push(desired_value_node(
            &stable_node_id("retiring", id),
            RETIRING_NODE_ID,
            0,
            AuthorityDomain::AgentMind,
            &ContextNodeValue::Retiring(retirement.clone()),
        )?);
    }
    for id in &state.protected {
        nodes.push(desired_value_node(
            &stable_node_id("protected", id),
            PROTECTED_NODE_ID,
            0,
            AuthorityDomain::AgentMind,
            &ContextNodeValue::Protected(id.clone()),
        )?);
    }
    for (index, checkpoint) in state.checkpoints.iter().enumerate() {
        nodes.push(desired_value_node(
            &stable_node_id("checkpoint", &checkpoint.id),
            CHECKPOINTS_NODE_ID,
            checked_order(index)?,
            AuthorityDomain::AgentMind,
            &ContextNodeValue::Checkpoint(checkpoint.clone()),
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
    let commitment = context_state_commitment(&state).map_err(ContextDbError::Invalid)?;
    let snapshot = materialize_context_state_snapshot(
        context_id,
        &state,
        &commitment,
        projection.head_event_id.as_deref(),
        updated_at,
    )?;
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
            "materialized Runtime Context '{context_id}' did not reproduce its exact legacy Mind Projection"
        )));
    }
    Ok(snapshot)
}

/// Materializes the exact native ContextStore AST used by every backend.
///
/// Initialization, migration verification and explicit broad replacement all
/// share this constructor. The authoritative typed state never serializes
/// through `NewMindProjection` on these native paths.
pub(crate) fn materialize_context_state_snapshot(
    context_id: &str,
    state: &MindState,
    commitment: &ContextStateCommitment,
    head_event_id: Option<&str>,
    updated_at: DateTime<Utc>,
) -> ContextDbResult<RuntimeContextSnapshot> {
    if commitment.revision() != state.version
        || commitment.state_hash()
            != context_state_commitment(state)
                .map_err(ContextDbError::Invalid)?
                .state_hash()
    {
        return Err(ContextDbError::Precondition(format!(
            "Runtime Context '{context_id}' state differs from its native commitment"
        )));
    }
    let meta = ProjectionMeta {
        revision: state.version,
        state_hash: commitment.state_hash().to_string(),
        head_event_id: head_event_id.map(str::to_string),
        updated_at,
    };
    let desired = desired_nodes(state, meta)?;
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
    let reconstructed = decode_context_state(&snapshot)?;
    let expected = ContextStateRecord {
        context_id: context_id.to_string(),
        revision: state.version,
        state: state.clone(),
        state_hash: commitment.state_hash().to_string(),
        head_event_id: head_event_id.map(str::to_string),
        updated_at,
    };
    if reconstructed != expected {
        return Err(ContextDbError::Corrupt(format!(
            "materialized Runtime Context '{context_id}' did not reproduce its exact typed state"
        )));
    }
    Ok(snapshot)
}

/// Computes the independent complete Runtime-tree commitment from the proof
/// produced while hashing the authoritative typed state. This performs no
/// second leaf encoding: it adds the operational metadata Node and physical
/// Runtime root to the seven canonical cognitive collection roots.
pub(crate) fn expected_runtime_root_hash_from_commitment(
    commitment: &ContextStateCommitment,
    meta: ProjectionMeta,
) -> ContextDbResult<String> {
    if commitment.revision() != meta.revision || commitment.state_hash() != meta.state_hash {
        return Err(ContextDbError::Precondition(
            "Context state commitment differs from Runtime projection metadata".to_string(),
        ));
    }
    let meta_body = encode_context_head(&meta).map_err(ContextDbError::Invalid)?;
    let meta_hash = calculate_subtree_hash(
        META_NODE_ID,
        AuthorityDomain::RuntimeControl,
        &meta_body,
        &[],
    );
    let mut root_children = Vec::with_capacity(commitment.roots().len() + 1);
    root_children.push((0, META_NODE_ID.to_string(), meta_hash));
    root_children.extend(commitment.roots().iter().cloned());
    root_children.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    Ok(calculate_subtree_hash(
        ROOT_NODE_ID,
        AuthorityDomain::RuntimeControl,
        ROOT_BODY,
        &root_children,
    ))
}

#[cfg(test)]
fn expected_runtime_root_hash_from_state_materialized(
    state: &MindState,
    meta: ProjectionMeta,
) -> ContextDbResult<String> {
    let desired = desired_nodes(state, meta)?;
    let mut nodes = HashMap::<String, DesiredNode>::with_capacity(desired.len());
    let mut hashes = HashMap::<String, String>::with_capacity(desired.len());
    for node in desired {
        let hash = calculate_subtree_hash(&node.node_id, node.owner_domain, &node.body_sexpr, &[]);
        if nodes.insert(node.node_id.clone(), node.clone()).is_some()
            || hashes.insert(node.node_id.clone(), hash).is_some()
        {
            return Err(ContextDbError::Invalid(format!(
                "Runtime Mind contains duplicate Node identity '{}'",
                node.node_id
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
    ] {
        let node = nodes.get(node_id).ok_or_else(|| {
            ContextDbError::Corrupt(format!(
                "expected Runtime group Node '{node_id}' is missing"
            ))
        })?;
        let mut children = nodes
            .values()
            .filter(|candidate| candidate.parent_id == node_id)
            .map(|candidate| {
                Ok((
                    candidate.order_key,
                    candidate.node_id.clone(),
                    hashes.get(&candidate.node_id).cloned().ok_or_else(|| {
                        ContextDbError::Corrupt(format!(
                            "expected Runtime child hash '{}' is missing",
                            candidate.node_id
                        ))
                    })?,
                ))
            })
            .collect::<ContextDbResult<Vec<_>>>()?;
        children.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
        hashes.insert(
            node_id.to_string(),
            calculate_subtree_hash(node_id, node.owner_domain, &node.body_sexpr, &children),
        );
    }

    let mut root_children = nodes
        .values()
        .filter(|candidate| candidate.parent_id == ROOT_NODE_ID)
        .map(|candidate| {
            Ok((
                candidate.order_key,
                candidate.node_id.clone(),
                hashes.get(&candidate.node_id).cloned().ok_or_else(|| {
                    ContextDbError::Corrupt(format!(
                        "expected Runtime root child hash '{}' is missing",
                        candidate.node_id
                    ))
                })?,
            ))
        })
        .collect::<ContextDbResult<Vec<_>>>()?;
    root_children.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    Ok(calculate_subtree_hash(
        ROOT_NODE_ID,
        AuthorityDomain::RuntimeControl,
        ROOT_BODY,
        &root_children,
    ))
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

fn desired_value_node(
    node_id: &str,
    parent_id: &str,
    order_key: i64,
    owner_domain: AuthorityDomain,
    value: &ContextNodeValue,
) -> ContextDbResult<DesiredNode> {
    Ok(DesiredNode {
        node_id: node_id.to_string(),
        parent_id: parent_id.to_string(),
        order_key,
        owner_domain,
        body_sexpr: encode_context_value(value).map_err(ContextDbError::Invalid)?,
    })
}

fn desired_meta_node(
    node_id: &str,
    parent_id: &str,
    order_key: i64,
    owner_domain: AuthorityDomain,
    value: &ProjectionMeta,
) -> ContextDbResult<DesiredNode> {
    Ok(DesiredNode {
        node_id: node_id.to_string(),
        parent_id: parent_id.to_string(),
        order_key,
        owner_domain,
        body_sexpr: encode_context_head(value).map_err(ContextDbError::Invalid)?,
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

    // Build adjacency once. The previous verifier scanned every Node again
    // for every visited Node, making a valid cold read O(N^2) even though the
    // persisted Runtime schema is a shallow tree. Large Contexts therefore
    // spent most of their cold-read time proving that leaves had no children.
    let mut children = HashMap::<&str, Vec<&ContextNodeRecord>>::new();
    for node in &snapshot.nodes {
        if let Some(parent_id) = node.parent_id.as_deref() {
            children.entry(parent_id).or_default().push(node);
        }
    }
    for siblings in children.values_mut() {
        siblings.sort_by(|left, right| {
            left.order_key
                .cmp(&right.order_key)
                .then_with(|| left.node_id.cmp(&right.node_id))
        });
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
            pending.extend(descendants.iter().map(|node| node.node_id.as_str()));
        }
    }
    if visited.len() != snapshot.nodes.len() {
        return Err(ContextDbError::Corrupt(format!(
            "Runtime Context '{}' contains Nodes unreachable from its root",
            snapshot.context_id
        )));
    }
    // Runtime's persisted schema is exactly two levels below its root. Hash
    // independent leaves in parallel, then fold the six collection parents
    // and the root in deterministic order. This retains every content and
    // subtree check while avoiding a serial SHA/base64-sized critical path on
    // cold startup.
    let leaf_hashes = snapshot
        .nodes
        .par_iter()
        .filter(|node| !children.contains_key(node.node_id.as_str()))
        .map(|node| {
            let hash = verify_runtime_node_hash(&snapshot.context_id, node, &[])?;
            Ok((node.node_id.clone(), hash))
        })
        .collect::<ContextDbResult<Vec<_>>>()?;
    let mut verified_hashes = leaf_hashes.into_iter().collect::<HashMap<_, _>>();
    for node_id in [
        FRAMES_NODE_ID,
        RELATIONS_NODE_ID,
        RETIRED_NODE_ID,
        RETIRING_NODE_ID,
        PROTECTED_NODE_ID,
        CHECKPOINTS_NODE_ID,
        ROOT_NODE_ID,
    ] {
        let node = required_node(&by_id, node_id)?;
        let child_hashes = children
            .get(node_id)
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .map(|child| {
                Ok((
                    child.order_key,
                    child.node_id.clone(),
                    verified_hashes
                        .get(&child.node_id)
                        .cloned()
                        .ok_or_else(|| {
                            ContextDbError::Corrupt(format!(
                                "Runtime Context '{}' is missing verified child hash '{}'",
                                snapshot.context_id, child.node_id
                            ))
                        })?,
                ))
            })
            .collect::<ContextDbResult<Vec<_>>>()?;
        let hash = verify_runtime_node_hash(&snapshot.context_id, node, &child_hashes)?;
        verified_hashes.insert(node_id.to_string(), hash);
    }
    if verified_hashes.len() != snapshot.nodes.len() {
        return Err(ContextDbError::Corrupt(format!(
            "Runtime Context '{}' hash verification covered {} of {} Nodes",
            snapshot.context_id,
            verified_hashes.len(),
            snapshot.nodes.len()
        )));
    }
    Ok(())
}

fn verify_runtime_node_hash(
    context_id: &str,
    node: &ContextNodeRecord,
    child_hashes: &[(i64, String, String)],
) -> ContextDbResult<String> {
    // Every write is canonicalized before persistence. On read, hashing the
    // exact stored bytes is sufficient for the content/Merkle commitment;
    // parsing and serializing every body here would duplicate the typed
    // decoder immediately below. Fixed schema bodies are checked exactly and
    // every record body is still parsed once by `decode_projection`.
    let content_hash = format!("{:x}", Sha256::digest(node.body_sexpr.as_bytes()));
    if content_hash != node.content_hash {
        return Err(ContextDbError::Corrupt(format!(
            "Runtime Context '{context_id}' Node '{}' content hash is invalid",
            node.node_id
        )));
    }
    let calculated = calculate_subtree_hash(
        &node.node_id,
        node.owner_domain,
        &node.body_sexpr,
        child_hashes,
    );
    if calculated != node.subtree_hash {
        return Err(ContextDbError::Corrupt(format!(
            "Runtime Context '{context_id}' Node '{}' subtree hash is invalid",
            node.node_id
        )));
    }
    Ok(calculated)
}

pub(crate) fn decode_projection(
    snapshot: &RuntimeContextSnapshot,
) -> ContextDbResult<MindProjectionRecord> {
    let record = decode_context_state(snapshot)?;
    Ok(MindProjectionRecord {
        context_id: record.context_id,
        revision: record.revision,
        state: serde_json::to_value(record.state)?,
        state_hash: record.state_hash,
        head_event_id: record.head_event_id,
        updated_at: record.updated_at,
    })
}

/// Decodes the authoritative Runtime AST directly into the typed Context
/// state consumed by the orchestrator. The caller must first validate the
/// physical snapshot and its Merkle commitment.
pub(crate) fn decode_context_state(
    snapshot: &RuntimeContextSnapshot,
) -> ContextDbResult<ContextStateRecord> {
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
    let mut children_by_parent = HashMap::<&str, Vec<&ContextNodeRecord>>::new();
    for node in &snapshot.nodes {
        if let Some(parent_id) = node.parent_id.as_deref() {
            children_by_parent.entry(parent_id).or_default().push(node);
        }
    }
    for children in children_by_parent.values_mut() {
        children.sort_by(|left, right| {
            left.order_key
                .cmp(&right.order_key)
                .then_with(|| left.node_id.cmp(&right.node_id))
        });
    }
    let children = |parent_id| {
        children_by_parent
            .get(parent_id)
            .map(Vec::as_slice)
            .unwrap_or_default()
    };
    let meta = decode_context_head(&required_node(&by_id, META_NODE_ID)?.body_sexpr)
        .map_err(ContextDbError::Corrupt)?;
    let clocks = match decode_context_value(
        &required_node(&by_id, CLOCKS_NODE_ID)?.body_sexpr,
        ContextCollection::MutationClocks,
    )
    .map_err(ContextDbError::Corrupt)?
    {
        ContextNodeValue::MutationClocks(clocks) => clocks,
        _ => unreachable!("mutation clock decoder returned another collection"),
    };

    let frames = decode_runtime_children(children(FRAMES_NODE_ID), ContextCollection::Frame)?
        .into_iter()
        .map(|value| match value {
            ContextNodeValue::Frame(frame) => Ok(frame),
            _ => Err(ContextDbError::Corrupt(
                "Frame collection decoded a non-Frame value".to_string(),
            )),
        })
        .collect::<ContextDbResult<Vec<_>>>()?;
    let relations =
        decode_runtime_children(children(RELATIONS_NODE_ID), ContextCollection::Relation)?
            .into_iter()
            .map(|value| match value {
                ContextNodeValue::Relation(relation) => Ok(relation),
                _ => Err(ContextDbError::Corrupt(
                    "Relation collection decoded a non-Relation value".to_string(),
                )),
            })
            .collect::<ContextDbResult<Vec<_>>>()?;
    let retired = decode_runtime_children(children(RETIRED_NODE_ID), ContextCollection::Retired)?
        .into_iter()
        .map(|value| match value {
            ContextNodeValue::Retired(id) => Ok(id),
            _ => Err(ContextDbError::Corrupt(
                "Retired collection decoded another value".to_string(),
            )),
        })
        .collect::<ContextDbResult<BTreeSet<_>>>()?;
    let retiring_entries =
        decode_runtime_children(children(RETIRING_NODE_ID), ContextCollection::Retiring)?;
    let mut retiring = BTreeMap::new();
    for value in retiring_entries {
        let ContextNodeValue::Retiring(entry) = value else {
            return Err(ContextDbError::Corrupt(
                "Retiring collection decoded another value".to_string(),
            ));
        };
        if retiring.insert(entry.frame_id.clone(), entry).is_some() {
            return Err(ContextDbError::Corrupt(
                "duplicate retiring Frame identity".to_string(),
            ));
        }
    }
    let protected =
        decode_runtime_children(children(PROTECTED_NODE_ID), ContextCollection::Protected)?
            .into_iter()
            .map(|value| match value {
                ContextNodeValue::Protected(id) => Ok(id),
                _ => Err(ContextDbError::Corrupt(
                    "Protected collection decoded another value".to_string(),
                )),
            })
            .collect::<ContextDbResult<BTreeSet<_>>>()?;
    let checkpoints =
        decode_runtime_children(children(CHECKPOINTS_NODE_ID), ContextCollection::Checkpoint)?
            .into_iter()
            .map(|value| match value {
                ContextNodeValue::Checkpoint(checkpoint) => Ok(checkpoint),
                _ => Err(ContextDbError::Corrupt(
                    "Checkpoint collection decoded another value".to_string(),
                )),
            })
            .collect::<ContextDbResult<Vec<_>>>()?;

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
    let state_hash = canonical_mind_state_hash(&state)?;
    if state_hash != meta.state_hash {
        return Err(ContextDbError::Corrupt(format!(
            "Runtime Context '{}' reconstructed Mind hash '{}' differs from '{}'; refusing a partial or mixed state",
            snapshot.context_id, state_hash, meta.state_hash
        )));
    }
    Ok(ContextStateRecord {
        context_id: snapshot.context_id.clone(),
        revision: meta.revision,
        state,
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

fn decode_runtime_children(
    children: &[&ContextNodeRecord],
    collection: ContextCollection,
) -> ContextDbResult<Vec<ContextNodeValue>> {
    children
        .par_iter()
        .map(|node| {
            let value = decode_context_value(&node.body_sexpr, collection)
                .map_err(ContextDbError::Corrupt)?;
            let expected = runtime_node_id(collection, &value.logical_id())?;
            if node.node_id != expected {
                return Err(ContextDbError::Corrupt(format!(
                    "Runtime record '{}' has Node identity '{}', expected '{}'",
                    collection.as_str(),
                    node.node_id,
                    expected
                )));
            }
            Ok(value)
        })
        .collect()
}

fn canonical_mind_state_hash(state: &MindState) -> ContextDbResult<String> {
    mind_state_hash(state).map_err(ContextDbError::Invalid)
}

/// Converts a valid historical Mind Projection into the one canonical hash
/// schema written by ContextDB.
///
/// Legacy Projection readers deliberately accept several historical hash
/// views because serde-defaulted fields changed the serialized fence without
/// changing the Mind. ContextDB must not carry that compatibility matrix into
/// its authoritative hot path: explicit migration validates the recorded
/// historical fence once, materializes all defaults, and writes the current
/// canonical hash.
pub(crate) fn canonicalize_legacy_projection(
    projection: &NewMindProjection,
) -> ContextDbResult<NewMindProjection> {
    let state: MindState = serde_json::from_value(projection.state.clone())?;
    if state.version != projection.revision {
        return Err(ContextDbError::Precondition(format!(
            "Mind state version {} does not match projection revision {}",
            state.version, projection.revision
        )));
    }
    let recorded_hash_matches =
        mind_state_hash_matches(&state, &projection.state_hash).map_err(ContextDbError::Invalid)?;
    if !recorded_hash_matches {
        return Err(ContextDbError::Precondition(format!(
            "Mind state does not match supplied historical projection hash '{}'",
            projection.state_hash
        )));
    }
    Ok(NewMindProjection {
        context_id: projection.context_id.clone(),
        revision: projection.revision,
        state: serde_json::to_value(&state)?,
        state_hash: canonical_mind_state_hash(&state)?,
        head_event_id: projection.head_event_id.clone(),
        recall_documents: projection.recall_documents.clone(),
    })
}

pub(crate) fn validate_new_projection(
    projection: &NewMindProjection,
) -> ContextDbResult<MindState> {
    let state: MindState = serde_json::from_value(projection.state.clone())?;
    let calculated_hash = canonical_mind_state_hash(&state)?;
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
    use crate::orchestrator::context::{
        ContextFrame, ContextMutationClocks, ContextRelation, FrameIdentityProvenance,
        FrameProvenanceState, FrameRetirement, MindCheckpoint,
    };

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
            .any(|node| node.body_sexpr.contains("(body (fact a))")));
        assert!(desired
            .iter()
            .all(|node| !node.body_sexpr.contains("morphz-record")));
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
    fn direct_full_state_commitment_matches_materialized_runtime_tree() {
        let state = sample_state();
        let projection = projection(&state, "event-seven");
        let updated_at = DateTime::parse_from_rfc3339("2026-09-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let materialized =
            materialize_runtime_snapshot("context-a", &projection, updated_at).unwrap();
        let commitment = context_state_commitment(&state).unwrap();
        let direct = expected_runtime_root_hash_from_commitment(
            &commitment,
            ProjectionMeta {
                revision: projection.revision,
                state_hash: projection.state_hash.clone(),
                head_event_id: projection.head_event_id.clone(),
                updated_at,
            },
        )
        .unwrap();
        let independently_materialized = expected_runtime_root_hash_from_state_materialized(
            &state,
            ProjectionMeta {
                revision: projection.revision,
                state_hash: projection.state_hash.clone(),
                head_event_id: projection.head_event_id.clone(),
                updated_at,
            },
        )
        .unwrap();

        assert_eq!(direct, materialized.root_hash);
        assert_eq!(direct, independently_materialized);
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
        assert_eq!(patch.state_hash, next_projection.state_hash);

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
            hash_only_node_ids: BTreeSet::new(),
        }
    }

    #[test]
    fn bounded_patch_uses_sibling_hash_without_loading_sibling_payload() {
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
        let mut basis = mutation_basis_from_snapshot_for_test(&snapshot);
        let sibling_id = stable_node_id("frame", "frame-b");
        let sibling = basis.nodes.get_mut(&sibling_id).unwrap();
        sibling.body_sexpr.clear();
        sibling.content_hash.clear();
        basis.hash_only_node_ids.insert(sibling_id.clone());

        let patch = apply_runtime_operations_to_basis("context-a", &basis, &operations).unwrap();
        let expected =
            materialize_runtime_snapshot("context-a", &next_projection, next_time).unwrap();
        assert_eq!(patch.root_hash, expected.root_hash);
        assert!(!patch
            .updated_nodes
            .iter()
            .any(|node| node.node_id == sibling_id));
    }
}
