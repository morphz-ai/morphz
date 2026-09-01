#![cfg(feature = "experimental-context-db")]

use morphz::context_store::{
    relation_logical_id, ContextCollection, ContextMutationPlan, ContextStateMutation,
};
use morphz::event::Event;
use morphz::experimental::{self, CONTEXT_DB};
use morphz::memory::postgres::PostgresStore;
use morphz::memory::{
    ContextRuntimeDirectoryRequest, ContextRuntimeSessionFilter, ContextRuntimeSnapshotStore,
    EventStore, MindProjectionCommit, MindProjectionStore, NewAgent, NewCognitiveContext,
    NewMindProjection, NewSession, QueryFilter, RecallDocumentSearchRequest, RecallProjectionStore,
    SessionAttentionState, SessionAttentionUpdate, SessionDirectoryStore, SessionMountKind,
    SessionProjectionMutation, SessionProjectionStore,
};
use morphz::observability::Observability;
use morphz::orchestrator::context::{
    ContextFrame, ContextMutationClocks, ContextRelation, FrameIdentityProvenance, FrameRetirement,
    MindCheckpoint, MindState,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::sync::Arc;

type TestError = Box<dyn std::error::Error + Send + Sync>;

fn permit() -> experimental::ExperimentalFeaturePermit {
    experimental::require_enabled(&BTreeSet::from([CONTEXT_DB.to_string()]), CONTEXT_DB).unwrap()
}

fn state_hash(state: &MindState) -> String {
    format!("{:x}", Sha256::digest(serde_json::to_vec(state).unwrap()))
}

fn projection(context_id: &str, state: &MindState, event_id: Option<&str>) -> NewMindProjection {
    NewMindProjection {
        context_id: context_id.to_string(),
        revision: state.version,
        state: serde_json::to_value(state).unwrap(),
        state_hash: state_hash(state),
        head_event_id: event_id.map(str::to_string),
        recall_documents: Vec::new(),
    }
}

fn mutation_plan(context_id: &str, current: &MindState, next: &MindState) -> ContextMutationPlan {
    mutation_plan_with(
        context_id,
        current,
        next,
        vec![ContextStateMutation::Upsert {
            collection: ContextCollection::MutationClocks,
            logical_id: "mutation-clocks".to_string(),
            body: serde_json::to_value(&next.mutation_clocks).unwrap(),
            order: None,
        }],
    )
}

fn mutation_plan_with(
    context_id: &str,
    current: &MindState,
    next: &MindState,
    mutations: Vec<ContextStateMutation>,
) -> ContextMutationPlan {
    ContextMutationPlan {
        context_id: context_id.to_string(),
        expected_revision: current.version,
        next_revision: next.version,
        expected_state_hash: state_hash(current),
        next_state_hash: state_hash(next),
        mutations,
    }
}

fn context_event(id: &str, context_id: &str) -> Event {
    Event::new(
        id.to_string(),
        "Postgres-ContextDB-Conformance".to_string(),
        "context_transaction".to_string(),
        "chat/context_tx_committed".to_string(),
        json!({"context_id": context_id})
            .as_object()
            .unwrap()
            .clone(),
    )
}

async fn isolated_database_url(
    database_url: &str,
    label: &str,
) -> Result<(sqlx::PgPool, String, String), TestError> {
    let suffix = chrono::Utc::now()
        .timestamp_nanos_opt()
        .ok_or("timestamp does not fit i64")?;
    let schema = format!(
        "morphz_contextdb_{label}_{}_{}",
        std::process::id(),
        suffix.unsigned_abs()
    );
    let administration = sqlx::PgPool::connect(database_url).await?;
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&administration)
        .await?;
    let separator = if database_url.contains('?') { '&' } else { '?' };
    let scoped = format!("{database_url}{separator}options=-csearch_path%3D{schema}%2Cpublic");
    Ok((administration, schema, scoped))
}

async fn create_bundle(store: &PostgresStore, agent_id: &str, context_id: &str, session_id: &str) {
    store
        .create_agent_bundle(
            NewAgent {
                id: agent_id.to_string(),
                title: "PostgreSQL ContextDB Agent".to_string(),
                root_context_id: context_id.to_string(),
            },
            NewCognitiveContext {
                id: context_id.to_string(),
                agent_id: agent_id.to_string(),
                title: "PostgreSQL ContextDB Context".to_string(),
            },
            NewSession {
                id: session_id.to_string(),
                agent_id: agent_id.to_string(),
                context_id: context_id.to_string(),
                parent_session_id: None,
                title: "PostgreSQL ContextDB Session".to_string(),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn postgres_context_db_is_atomic_fenced_restartable_and_directory_consistent_when_configured(
) -> Result<(), TestError> {
    let Ok(database_url) = std::env::var("MORPHZ_TEST_POSTGRES_URL") else {
        return Ok(());
    };
    let (administration, schema, scoped_url) =
        isolated_database_url(&database_url, "authority").await?;
    let store = Arc::new(
        PostgresStore::new_with_context_db(
            &scoped_url,
            8,
            Arc::new(Observability::default()),
            permit(),
        )
        .await?,
    );
    let agent_id = "contextdb-pg-agent";
    let context_id = "contextdb-pg-context";
    let session_id = "contextdb-pg-session";
    create_bundle(&store, agent_id, context_id, session_id).await;

    let initial = MindState::default();
    let initial_projection = store
        .initialize_mind_projection(projection(context_id, &initial, None))
        .await?;
    assert_eq!(initial_projection.state, serde_json::to_value(&initial)?);

    // Reject a validly fenced but incomplete local plan atomically. This
    // catches emitter regressions before a later full read discovers that the
    // projection metadata and authoritative AST disagree.
    let mut omitted = initial.clone();
    omitted.version = 1;
    omitted
        .protected
        .insert("omitted-protected-frame".to_string());
    let omitted_event = context_event("contextdb-pg-event-omitted", context_id);
    let omitted_plan = ContextMutationPlan {
        context_id: context_id.to_string(),
        expected_revision: 0,
        next_revision: 1,
        expected_state_hash: state_hash(&initial),
        next_state_hash: state_hash(&omitted),
        mutations: Vec::new(),
    };
    let omission = store
        .commit_mind_projection_transaction(
            &omitted_event,
            &[],
            &SessionProjectionMutation::default(),
            Some(&omitted_plan),
            0,
            projection(context_id, &omitted, Some(&omitted_event.id)),
        )
        .await
        .unwrap_err();
    assert!(omission.to_string().contains("fenced projection requires"));
    assert_eq!(
        store.get_mind_projection(context_id).await?.unwrap().state,
        serde_json::to_value(&initial)?
    );
    assert!(store
        .query(QueryFilter {
            event_id: Some(omitted_event.id),
            ..QueryFilter::default()
        })
        .await?
        .is_empty());

    let mut next = initial.clone();
    next.version = 1;
    next.mutation_clocks.tracking_started_version = Some(1);
    next.mutation_clocks.global_barrier_version = 1;
    let event = context_event("contextdb-pg-event-1", context_id);
    let committed = store
        .commit_mind_projection_transaction(
            &event,
            &[],
            &SessionProjectionMutation::default(),
            Some(&mutation_plan(context_id, &initial, &next)),
            0,
            projection(context_id, &next, Some(&event.id)),
        )
        .await?;
    assert!(matches!(committed, MindProjectionCommit::Committed { .. }));

    // A failure in a later Runtime projection must roll the earlier Context
    // AST mutation and Event append back in the same PostgreSQL transaction.
    let mut rejected = next.clone();
    rejected.version = 2;
    rejected.mutation_clocks.global_barrier_version = 2;
    let rejected_event = context_event("contextdb-pg-event-rejected", context_id);
    assert!(store
        .commit_mind_projection_transaction(
            &rejected_event,
            &[SessionAttentionUpdate {
                session_id: session_id.to_string(),
                context_id: context_id.to_string(),
                expected_revision: 99,
                state: SessionAttentionState::Retired,
                reason: Some("force transaction rollback".to_string()),
                changed_at: chrono::Utc::now(),
                event_id: rejected_event.id.clone(),
            }],
            &SessionProjectionMutation::default(),
            Some(&mutation_plan(context_id, &next, &rejected)),
            1,
            projection(context_id, &rejected, Some(&rejected_event.id)),
        )
        .await
        .is_err());
    assert_eq!(
        store.get_mind_projection(context_id).await?.unwrap().state,
        serde_json::to_value(&next)?
    );
    assert!(store
        .query(QueryFilter {
            event_id: Some(rejected_event.id),
            ..QueryFilter::default()
        })
        .await?
        .is_empty());

    // Two independent commits sharing the same revision fence may race, but
    // exactly one Context authority transition may win.
    let mut final_state = next.clone();
    final_state.version = 2;
    final_state.mutation_clocks.frame_order_version = 2;
    let plan = mutation_plan(context_id, &next, &final_state);
    let first_event = context_event("contextdb-pg-event-race-a", context_id);
    let second_event = context_event("contextdb-pg-event-race-b", context_id);
    let first = {
        let store = Arc::clone(&store);
        let state = final_state.clone();
        let plan = plan.clone();
        tokio::spawn(async move {
            store
                .commit_mind_projection_transaction(
                    &first_event,
                    &[],
                    &SessionProjectionMutation::default(),
                    Some(&plan),
                    1,
                    projection(context_id, &state, Some(&first_event.id)),
                )
                .await
        })
    };
    let second = {
        let store = Arc::clone(&store);
        let state = final_state.clone();
        tokio::spawn(async move {
            store
                .commit_mind_projection_transaction(
                    &second_event,
                    &[],
                    &SessionProjectionMutation::default(),
                    Some(&plan),
                    1,
                    projection(context_id, &state, Some(&second_event.id)),
                )
                .await
        })
    };
    let outcomes = [first.await??, second.await??];
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(outcome, MindProjectionCommit::Committed { .. }))
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(outcome, MindProjectionCommit::Conflict { .. }))
            .count(),
        1
    );

    // Exercise every structural collection through the real PostgreSQL
    // adapter, then revise/reorder and remove them. Pure codec tests alone
    // cannot catch SQL binding, bulk-patch, ordering or delete regressions.
    let frame_a = ContextFrame {
        id: "pg-frame-a".to_string(),
        body: "(fact a)".to_string(),
        sources: vec!["pg-observation-a".to_string()],
        provenance: FrameIdentityProvenance::default(),
        revision: 1,
        created_version: 3,
        updated_version: 3,
    };
    let frame_b = ContextFrame {
        id: "pg-frame-b".to_string(),
        body: "(fact b)".to_string(),
        sources: vec!["pg-observation-b".to_string()],
        provenance: FrameIdentityProvenance::default(),
        revision: 1,
        created_version: 3,
        updated_version: 3,
    };
    let relation = ContextRelation {
        subject: frame_a.id.clone(),
        relation: "supports".to_string(),
        object: frame_b.id.clone(),
        created_version: 3,
    };
    let retirement = FrameRetirement {
        frame_id: frame_a.id.clone(),
        requested_frame_revision: 1,
        requested_mind_version: 3,
        requested_at_tick: 10,
        eligible_at_tick: 20,
        generation: 1,
        reason: "postgres conformance".to_string(),
    };
    let checkpoint = MindCheckpoint {
        id: "pg-checkpoint".to_string(),
        frames: vec![frame_a.clone(), frame_b.clone()],
        relations: vec![relation.clone()],
        retired: BTreeSet::from(["pg-retired-observation".to_string()]),
        retiring: Default::default(),
        protected: BTreeSet::from([frame_b.id.clone()]),
        created_version: 3,
    };
    let mut expanded = final_state.clone();
    expanded.version = 3;
    expanded.frames = vec![frame_a.clone(), frame_b.clone()];
    expanded.relations = vec![relation.clone()];
    expanded
        .retired
        .insert("pg-retired-observation".to_string());
    expanded
        .retiring
        .insert(frame_a.id.clone(), retirement.clone());
    expanded.protected.insert(frame_b.id.clone());
    expanded.checkpoints = vec![checkpoint.clone()];
    expanded.mutation_clocks.global_barrier_version = 3;
    let relation_id = relation_logical_id(&relation.subject, &relation.relation, &relation.object);
    let expanded_plan = mutation_plan_with(
        context_id,
        &final_state,
        &expanded,
        vec![
            ContextStateMutation::Upsert {
                collection: ContextCollection::Frame,
                logical_id: frame_a.id.clone(),
                body: serde_json::to_value(&frame_a)?,
                order: Some(0),
            },
            ContextStateMutation::Upsert {
                collection: ContextCollection::Frame,
                logical_id: frame_b.id.clone(),
                body: serde_json::to_value(&frame_b)?,
                order: Some(1),
            },
            ContextStateMutation::Upsert {
                collection: ContextCollection::Relation,
                logical_id: relation_id.clone(),
                body: serde_json::to_value(&relation)?,
                order: Some(0),
            },
            ContextStateMutation::Upsert {
                collection: ContextCollection::Retired,
                logical_id: "pg-retired-observation".to_string(),
                body: json!({"id": "pg-retired-observation"}),
                order: None,
            },
            ContextStateMutation::Upsert {
                collection: ContextCollection::Retiring,
                logical_id: frame_a.id.clone(),
                body: serde_json::to_value(&retirement)?,
                order: None,
            },
            ContextStateMutation::Upsert {
                collection: ContextCollection::Protected,
                logical_id: frame_b.id.clone(),
                body: json!({"id": frame_b.id}),
                order: None,
            },
            ContextStateMutation::Upsert {
                collection: ContextCollection::Checkpoint,
                logical_id: checkpoint.id.clone(),
                body: serde_json::to_value(&checkpoint)?,
                order: Some(0),
            },
            ContextStateMutation::Upsert {
                collection: ContextCollection::MutationClocks,
                logical_id: "mutation-clocks".to_string(),
                body: serde_json::to_value(&expanded.mutation_clocks)?,
                order: None,
            },
        ],
    );
    let expanded_event = context_event("contextdb-pg-event-expanded", context_id);
    assert!(matches!(
        store
            .commit_mind_projection_transaction(
                &expanded_event,
                &[],
                &SessionProjectionMutation::default(),
                Some(&expanded_plan),
                2,
                projection(context_id, &expanded, Some(&expanded_event.id)),
            )
            .await?,
        MindProjectionCommit::Committed { .. }
    ));

    let mut reordered = expanded.clone();
    reordered.version = 4;
    reordered.frames.swap(0, 1);
    reordered.frames[0].body = "(fact b revised)".to_string();
    reordered.frames[0].revision = 2;
    reordered.frames[0].updated_version = 4;
    reordered.mutation_clocks.frame_order_version = 4;
    let reordered_plan = mutation_plan_with(
        context_id,
        &expanded,
        &reordered,
        vec![
            ContextStateMutation::Upsert {
                collection: ContextCollection::Frame,
                logical_id: reordered.frames[0].id.clone(),
                body: serde_json::to_value(&reordered.frames[0])?,
                order: Some(0),
            },
            ContextStateMutation::SetOrder {
                collection: ContextCollection::Frame,
                logical_ids: reordered
                    .frames
                    .iter()
                    .map(|frame| frame.id.clone())
                    .collect(),
            },
            ContextStateMutation::Upsert {
                collection: ContextCollection::MutationClocks,
                logical_id: "mutation-clocks".to_string(),
                body: serde_json::to_value(&reordered.mutation_clocks)?,
                order: None,
            },
        ],
    );
    let reordered_event = context_event("contextdb-pg-event-reordered", context_id);
    assert!(matches!(
        store
            .commit_mind_projection_transaction(
                &reordered_event,
                &[],
                &SessionProjectionMutation::default(),
                Some(&reordered_plan),
                3,
                projection(context_id, &reordered, Some(&reordered_event.id)),
            )
            .await?,
        MindProjectionCommit::Committed { .. }
    ));

    let mut pruned = reordered.clone();
    pruned.version = 5;
    pruned.frames.retain(|frame| frame.id == frame_b.id);
    pruned.relations.clear();
    pruned.retired.clear();
    pruned.retiring.clear();
    pruned.protected.clear();
    pruned.checkpoints.clear();
    pruned.mutation_clocks.global_barrier_version = 5;
    let pruned_plan = mutation_plan_with(
        context_id,
        &reordered,
        &pruned,
        vec![
            ContextStateMutation::Remove {
                collection: ContextCollection::Frame,
                logical_id: frame_a.id.clone(),
            },
            ContextStateMutation::SetOrder {
                collection: ContextCollection::Frame,
                logical_ids: vec![frame_b.id.clone()],
            },
            ContextStateMutation::Remove {
                collection: ContextCollection::Relation,
                logical_id: relation_id,
            },
            ContextStateMutation::Remove {
                collection: ContextCollection::Retired,
                logical_id: "pg-retired-observation".to_string(),
            },
            ContextStateMutation::Remove {
                collection: ContextCollection::Retiring,
                logical_id: frame_a.id,
            },
            ContextStateMutation::Remove {
                collection: ContextCollection::Protected,
                logical_id: frame_b.id,
            },
            ContextStateMutation::Remove {
                collection: ContextCollection::Checkpoint,
                logical_id: checkpoint.id,
            },
            ContextStateMutation::Upsert {
                collection: ContextCollection::MutationClocks,
                logical_id: "mutation-clocks".to_string(),
                body: serde_json::to_value(&pruned.mutation_clocks)?,
                order: None,
            },
        ],
    );
    let pruned_event = context_event("contextdb-pg-event-pruned", context_id);
    assert!(matches!(
        store
            .commit_mind_projection_transaction(
                &pruned_event,
                &[],
                &SessionProjectionMutation::default(),
                Some(&pruned_plan),
                4,
                projection(context_id, &pruned, Some(&pruned_event.id)),
            )
            .await?,
        MindProjectionCommit::Committed { .. }
    ));

    // Rollback/checkpoint restoration intentionally crosses the broad
    // replacement barrier. Exercise that separate PostgreSQL path against a
    // real database instead of assuming the bounded local patch covers it.
    let replacement_frame = ContextFrame {
        id: "pg-replacement-frame".to_string(),
        body: "(fact broad-replacement)".to_string(),
        sources: vec!["pg-replacement-observation".to_string()],
        provenance: FrameIdentityProvenance::default(),
        revision: 1,
        created_version: 6,
        updated_version: 6,
    };
    let replaced = MindState {
        version: 6,
        frames: vec![replacement_frame],
        mutation_clocks: ContextMutationClocks {
            global_barrier_version: 6,
            ..ContextMutationClocks::default()
        },
        ..MindState::default()
    };
    let replaced_event = context_event("contextdb-pg-event-replaced", context_id);
    let replaced_plan = ContextMutationPlan {
        context_id: context_id.to_string(),
        expected_revision: 5,
        next_revision: 6,
        expected_state_hash: state_hash(&pruned),
        next_state_hash: state_hash(&replaced),
        mutations: vec![ContextStateMutation::ReplaceMind {
            state: serde_json::to_value(&replaced)?,
        }],
    };
    assert!(matches!(
        store
            .commit_mind_projection_transaction(
                &replaced_event,
                &[],
                &SessionProjectionMutation::default(),
                Some(&replaced_plan),
                5,
                projection(context_id, &replaced, Some(&replaced_event.id)),
            )
            .await?,
        MindProjectionCommit::Committed { .. }
    ));

    // Mind seeding keeps revision zero but replaces the empty authoritative
    // AST, records provenance and appends the seed Event in one transaction.
    // It is a distinct production path and must remain replay-fenced.
    let seed_context_id = "contextdb-pg-seed-context";
    create_bundle(
        &store,
        "contextdb-pg-seed-agent",
        seed_context_id,
        "contextdb-pg-seed-session",
    )
    .await;
    let empty_seed = MindState::default();
    store
        .initialize_mind_projection(projection(seed_context_id, &empty_seed, None))
        .await?;
    let seeded = MindState {
        frames: vec![ContextFrame {
            id: "pg-seeded-frame".to_string(),
            body: "(fact seeded)".to_string(),
            sources: vec!["pg-seed-source".to_string()],
            provenance: FrameIdentityProvenance::default(),
            revision: 1,
            created_version: 0,
            updated_version: 0,
        }],
        ..MindState::default()
    };
    let seed_event = context_event("contextdb-pg-seed-event", seed_context_id);
    assert!(matches!(
        store
            .commit_mind_seed_projection(
                &seed_event,
                context_id,
                replaced.version,
                "pg-seed-snapshot-hash",
                "mind_snapshot",
                projection(seed_context_id, &seeded, Some(&seed_event.id)),
            )
            .await?,
        MindProjectionCommit::Committed { .. }
    ));
    assert_eq!(
        store
            .get_mind_projection(seed_context_id)
            .await?
            .unwrap()
            .state,
        serde_json::to_value(&seeded)?
    );
    assert!(matches!(
        store
            .commit_mind_seed_projection(
                &seed_event,
                context_id,
                replaced.version,
                "pg-seed-snapshot-hash",
                "mind_snapshot",
                projection(seed_context_id, &seeded, Some(&seed_event.id)),
            )
            .await?,
        MindProjectionCommit::Conflict {
            current_revision: Some(0)
        }
    ));

    // A ContextDB-backed Runtime must not maintain the legacy current-Mind
    // tables as a hidden second authority. Prove both the absence of dual
    // writes and that deliberately conflicting legacy rows cannot influence
    // either the direct projection read or the one-statement directory read.
    let audit_pool = sqlx::PgPool::connect(&scoped_url).await?;
    let legacy_counts = sqlx::query_as::<_, (i64, i64)>(
        r#"SELECT
             (SELECT COUNT(*) FROM context_heads
              WHERE context_id = ANY($1)),
             (SELECT COUNT(*) FROM mind_projections
              WHERE context_id = ANY($1))"#,
    )
    .bind(vec![context_id, seed_context_id])
    .fetch_one(&audit_pool)
    .await?;
    assert_eq!(legacy_counts, (0, 0));
    let legacy_decoy_hash = "legacy-decoy-hash";
    let legacy_decoy_time = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        r#"INSERT INTO context_heads
           (context_id, revision, projection_hash, head_event_id, updated_at)
           VALUES ($1, 999, $2, 'legacy-decoy-event', $3)"#,
    )
    .bind(context_id)
    .bind(legacy_decoy_hash)
    .bind(&legacy_decoy_time)
    .execute(&audit_pool)
    .await?;
    sqlx::query(
        r#"INSERT INTO mind_projections
           (context_id, revision, state_json, state_hash, updated_at)
           VALUES ($1, 999, $2, $3, $4)"#,
    )
    .bind(context_id)
    .bind(json!({"legacy_decoy": true}))
    .bind(legacy_decoy_hash)
    .bind(&legacy_decoy_time)
    .execute(&audit_pool)
    .await?;
    assert_eq!(
        store.get_mind_projection(context_id).await?.unwrap().state,
        serde_json::to_value(&replaced)?
    );
    let heads = store
        .list_mind_projection_heads(&[context_id.to_string()])
        .await?;
    assert_eq!(heads.len(), 1);
    assert_eq!(heads[0].revision, replaced.version);

    let directory = store
        .read_context_runtime_directory_snapshot(&ContextRuntimeDirectoryRequest {
            context_id: context_id.to_string(),
            active_session_id: session_id.to_string(),
            active_after: chrono::Utc::now() - chrono::Duration::hours(24),
            max_full_sessions: 50,
            max_metadata_sessions: 50,
            session_filter: ContextRuntimeSessionFilter::default(),
        })
        .await?
        .unwrap();
    assert_eq!(
        directory.mind.unwrap().state,
        serde_json::to_value(&replaced)?
    );
    let encoding_snapshot = store
        .read_context_encoding_projection_snapshot(context_id, &[session_id.to_string()], true)
        .await?;
    assert_eq!(
        encoding_snapshot.mind.unwrap().state,
        serde_json::to_value(&replaced)?,
        "the physical model Context snapshot must read ContextDB rather than the conflicting legacy projection"
    );

    // PostgreSQL BIGSERIAL values are reserved before commit. Reproduce the
    // dangerous order explicitly: transaction A owns the lower sequence but
    // remains uncommitted; transaction B commits the higher sequence; the
    // physical View is captured; only then does A commit. A numeric MAX fence
    // alone would let A leak backwards into that already-built model request.
    let mut delayed = audit_pool.begin().await?;
    let delayed_sequence = sqlx::query_scalar::<_, i64>(
        r#"INSERT INTO events
           (id, timestamp, actor, type, topic, context_id, session_id,
            thread_id, activation_id, root_turn_id, objective_id, payload)
           VALUES ($1, $2, 'Concurrent writer', $3, 'chat/user_message', $4, $5,
                   NULL, NULL, NULL, NULL, $6)
           RETURNING sequence"#,
    )
    .bind("pg-causal-delayed-low-sequence")
    .bind(chrono::Utc::now().to_rfc3339())
    .bind(morphz::event::TYPE_USER_MESSAGE)
    .bind(context_id)
    .bind(session_id)
    .bind(json!({
        "context_id": context_id,
        "session_id": session_id,
        "text": "must not leak into an earlier physical View"
    }))
    .fetch_one(&mut *delayed)
    .await?;
    let delayed_outbox_time =
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
    sqlx::query(
        r#"INSERT INTO recall_projection_outbox
           (context_id, document_kind, document_id, generation, document_json,
            status, attempts, available_at, created_at, updated_at)
           VALUES ($1, 'event', $2, 1, $3, 'pending', 0, $4, $4, $4)"#,
    )
    .bind(context_id)
    .bind("pg-causal-delayed-low-sequence")
    .bind(json!({"retired": false}))
    .bind(&delayed_outbox_time)
    .execute(&mut *delayed)
    .await?;
    store
        .append(Event::new(
            "pg-causal-visible-high-sequence".to_string(),
            "Committed writer".to_string(),
            morphz::event::TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            json!({
                "context_id": context_id,
                "session_id": session_id,
                "text": "visible before the physical View"
            })
            .as_object()
            .unwrap()
            .clone(),
        ))
        .await?;
    let causal_view = store
        .read_context_encoding_projection_snapshot(context_id, &[session_id.to_string()], true)
        .await?;
    let visibility_snapshot = causal_view
        .event_visibility_snapshot
        .clone()
        .expect("PostgreSQL must issue a transaction visibility snapshot");
    assert!(
        i64::try_from(causal_view.event_sequence_upper_bound)? > delayed_sequence,
        "the committed Event must establish a higher numeric frontier"
    );
    delayed.commit().await?;
    let causally_visible = store
        .query(QueryFilter {
            context_id: Some(context_id.to_string()),
            through_sequence: Some(causal_view.event_sequence_upper_bound),
            event_visibility_snapshot: Some(visibility_snapshot),
            latest_k: Some(32),
            ..Default::default()
        })
        .await?;
    let causally_visible_ids = causally_visible
        .iter()
        .map(|event| event.id.as_str())
        .collect::<BTreeSet<_>>();
    assert!(causally_visible_ids.contains("pg-causal-visible-high-sequence"));
    assert!(
        !causally_visible_ids.contains("pg-causal-delayed-low-sequence"),
        "a transaction committed after the physical View must remain invisible even when its reserved sequence is below MAX(sequence)"
    );
    loop {
        let projected = store
            .project_recall_outbox_batch("pg-causal-visibility-worker", 64)
            .await?;
        if projected.claimed == 0 {
            break;
        }
    }
    let causally_recalled = store
        .query_recall_documents(RecallDocumentSearchRequest {
            context_id: context_id.to_string(),
            normalized_query: Some(morphz::memory::normalize_recall_text("physical View")),
            start_time: None,
            end_time: None,
            before_sequence: None,
            through_sequence: Some(causal_view.event_sequence_upper_bound),
            through_mind_version: Some(replaced.version),
            event_visibility_snapshot: causal_view.event_visibility_snapshot,
            excluded_event_ids: Vec::new(),
            excluded_frame_ids: Vec::new(),
            limit: 16,
        })
        .await?;
    let causally_recalled_ids = causally_recalled
        .iter()
        .map(|hit| hit.document_id.as_str())
        .collect::<BTreeSet<_>>();
    assert!(causally_recalled_ids.contains("pg-causal-visible-high-sequence"));
    assert!(
        !causally_recalled_ids.contains("pg-causal-delayed-low-sequence"),
        "the Recall projection must preserve the PostgreSQL transaction snapshot before ranking and LIMIT"
    );
    audit_pool.close().await;

    drop(store);
    let restarted = PostgresStore::new_with_context_db(
        &scoped_url,
        4,
        Arc::new(Observability::default()),
        permit(),
    )
    .await?;
    assert_eq!(
        restarted
            .get_mind_projection(context_id)
            .await?
            .unwrap()
            .state,
        serde_json::to_value(&replaced)?
    );
    drop(restarted);
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&administration)
        .await?;
    Ok(())
}

#[tokio::test]
async fn postgres_context_db_requires_and_performs_explicit_exact_migration_when_configured(
) -> Result<(), TestError> {
    let Ok(database_url) = std::env::var("MORPHZ_TEST_POSTGRES_URL") else {
        return Ok(());
    };
    let (administration, schema, scoped_url) =
        isolated_database_url(&database_url, "migration").await?;
    let legacy = PostgresStore::new(&scoped_url, 4).await?;
    create_bundle(
        &legacy,
        "migration-agent",
        "migration-context",
        "migration-session",
    )
    .await;
    let state = MindState::default();
    let expected = legacy
        .initialize_mind_projection(projection("migration-context", &state, None))
        .await?;
    drop(legacy);

    assert!(PostgresStore::new_with_context_db(
        &scoped_url,
        4,
        Arc::new(Observability::default()),
        permit(),
    )
    .await
    .is_err());
    let report =
        PostgresStore::migrate_legacy_mind_projections_to_context_db(&scoped_url, 4, permit())
            .await?;
    assert_eq!(report.discovered, 1);
    assert_eq!(report.imported, 1);
    assert_eq!(report.already_authoritative, 0);
    let second =
        PostgresStore::migrate_legacy_mind_projections_to_context_db(&scoped_url, 4, permit())
            .await?;
    assert_eq!(second.discovered, 1);
    assert_eq!(second.imported, 0);
    assert_eq!(second.already_authoritative, 1);

    let authoritative = PostgresStore::new_with_context_db(
        &scoped_url,
        4,
        Arc::new(Observability::default()),
        permit(),
    )
    .await?;
    assert_eq!(
        authoritative
            .get_mind_projection("migration-context")
            .await?
            .unwrap(),
        expected
    );
    drop(authoritative);
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&administration)
        .await?;
    Ok(())
}

#[tokio::test]
async fn postgres_schema_bootstrap_never_removes_a_peer_runtime_fast_path() -> Result<(), TestError>
{
    let Ok(database_url) = std::env::var("MORPHZ_TEST_POSTGRES_URL") else {
        return Ok(());
    };
    let (administration, peer_schema, peer_url) =
        isolated_database_url(&database_url, "peer_runtime").await?;
    let peer = PostgresStore::new(&peer_url, 2).await?;
    drop(peer);

    let suffix = chrono::Utc::now()
        .timestamp_nanos_opt()
        .ok_or("timestamp does not fit i64")?;
    let transient_schema = format!(
        "morphz_contextdb_transient_runtime_{}_{}",
        std::process::id(),
        suffix.unsigned_abs()
    );
    sqlx::query(&format!("CREATE SCHEMA {transient_schema}"))
        .execute(&administration)
        .await?;
    let separator = if database_url.contains('?') { '&' } else { '?' };
    let transient_url = format!(
        "{database_url}{separator}options=-csearch_path%3D{transient_schema}%2C{peer_schema}"
    );
    let transient = PostgresStore::new_with_context_db(
        &transient_url,
        2,
        Arc::new(Observability::default()),
        permit(),
    )
    .await?;
    drop(transient);
    sqlx::query(&format!("DROP SCHEMA {transient_schema} CASCADE"))
        .execute(&administration)
        .await?;

    for function_name in [
        "morphz_try_claim_fresh_dialogue_activation_v1",
        "morphz_update_thread_activation_v1",
    ] {
        let exists = sqlx::query_scalar::<_, bool>(
            r#"SELECT EXISTS (
                 SELECT 1
                   FROM pg_proc function
                   JOIN pg_namespace namespace
                     ON namespace.oid = function.pronamespace
                  WHERE namespace.nspname = $1
                    AND function.proname = $2
               )"#,
        )
        .bind(&peer_schema)
        .bind(function_name)
        .fetch_one(&administration)
        .await?;
        assert!(
            exists,
            "bootstrapping and removing another schema must not delete {peer_schema}.{function_name}"
        );
    }

    sqlx::query(&format!("DROP SCHEMA {peer_schema} CASCADE"))
        .execute(&administration)
        .await?;
    Ok(())
}
