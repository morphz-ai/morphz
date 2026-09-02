#![cfg(feature = "context-db")]

use morphz::context_store::{
    context_state_commitment, relation_logical_id, ContextCollection, ContextMutationPlan,
    ContextNodeValue, ContextStateCommit, ContextStateMutation,
};
use morphz::event::Event;
use morphz::memory::postgres::PostgresStore;
use morphz::memory::{
    ContextRuntimeDirectoryRequest, ContextRuntimeSessionFilter, ContextRuntimeSnapshotStore,
    ContextStore, EventStore, MindProjectionStore, NewAgent, NewCognitiveContext,
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
use std::collections::BTreeSet;
use std::sync::Arc;

type TestError = Box<dyn std::error::Error + Send + Sync>;

fn state_hash(state: &MindState) -> String {
    morphz::context_store::context_state_hash(state).unwrap()
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
            value: ContextNodeValue::MutationClocks(next.mutation_clocks.clone()),
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
        PostgresStore::new_with_context_db(&scoped_url, 8, Arc::new(Observability::default()))
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
        .commit_context_mutation_transaction(
            &omitted_event,
            &[],
            &SessionProjectionMutation::default(),
            &omitted_plan,
            &omitted,
            &context_state_commitment(&omitted)?,
            &[],
        )
        .await
        .unwrap_err();
    assert!(omission.to_string().contains("commits native state"));
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
        .commit_context_mutation_transaction(
            &event,
            &[],
            &SessionProjectionMutation::default(),
            &mutation_plan(context_id, &initial, &next),
            &next,
            &context_state_commitment(&next)?,
            &[],
        )
        .await?;
    assert!(matches!(committed, ContextStateCommit::Committed { .. }));

    // A failure in a later Runtime projection must roll the earlier Context
    // AST mutation and Event append back in the same PostgreSQL transaction.
    let mut rejected = next.clone();
    rejected.version = 2;
    rejected.mutation_clocks.global_barrier_version = 2;
    let rejected_event = context_event("contextdb-pg-event-rejected", context_id);
    assert!(store
        .commit_context_mutation_transaction(
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
            &mutation_plan(context_id, &next, &rejected),
            &rejected,
            &context_state_commitment(&rejected)?,
            &[],
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
                .commit_context_mutation_transaction(
                    &first_event,
                    &[],
                    &SessionProjectionMutation::default(),
                    &plan,
                    &state,
                    &context_state_commitment(&state)?,
                    &[],
                )
                .await
        })
    };
    let second = {
        let store = Arc::clone(&store);
        let state = final_state.clone();
        tokio::spawn(async move {
            store
                .commit_context_mutation_transaction(
                    &second_event,
                    &[],
                    &SessionProjectionMutation::default(),
                    &plan,
                    &state,
                    &context_state_commitment(&state)?,
                    &[],
                )
                .await
        })
    };
    let outcomes = [first.await??, second.await??];
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(outcome, ContextStateCommit::Committed { .. }))
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(outcome, ContextStateCommit::Conflict { .. }))
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
                value: ContextNodeValue::Frame(frame_a.clone()),
                order: Some(0),
            },
            ContextStateMutation::Upsert {
                value: ContextNodeValue::Frame(frame_b.clone()),
                order: Some(1),
            },
            ContextStateMutation::Upsert {
                value: ContextNodeValue::Relation(relation.clone()),
                order: Some(0),
            },
            ContextStateMutation::Upsert {
                value: ContextNodeValue::Retired("pg-retired-observation".to_string()),
                order: None,
            },
            ContextStateMutation::Upsert {
                value: ContextNodeValue::Retiring(retirement.clone()),
                order: None,
            },
            ContextStateMutation::Upsert {
                value: ContextNodeValue::Protected(frame_b.id.clone()),
                order: None,
            },
            ContextStateMutation::Upsert {
                value: ContextNodeValue::Checkpoint(checkpoint.clone()),
                order: Some(0),
            },
            ContextStateMutation::Upsert {
                value: ContextNodeValue::MutationClocks(expanded.mutation_clocks.clone()),
                order: None,
            },
        ],
    );
    let expanded_event = context_event("contextdb-pg-event-expanded", context_id);
    assert!(matches!(
        store
            .commit_context_mutation_transaction(
                &expanded_event,
                &[],
                &SessionProjectionMutation::default(),
                &expanded_plan,
                &expanded,
                &context_state_commitment(&expanded)?,
                &[],
            )
            .await?,
        ContextStateCommit::Committed { .. }
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
                value: ContextNodeValue::Frame(reordered.frames[0].clone()),
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
                value: ContextNodeValue::MutationClocks(reordered.mutation_clocks.clone()),
                order: None,
            },
        ],
    );
    let reordered_event = context_event("contextdb-pg-event-reordered", context_id);
    assert!(matches!(
        store
            .commit_context_mutation_transaction(
                &reordered_event,
                &[],
                &SessionProjectionMutation::default(),
                &reordered_plan,
                &reordered,
                &context_state_commitment(&reordered)?,
                &[],
            )
            .await?,
        ContextStateCommit::Committed { .. }
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
                value: ContextNodeValue::MutationClocks(pruned.mutation_clocks.clone()),
                order: None,
            },
        ],
    );
    let pruned_event = context_event("contextdb-pg-event-pruned", context_id);
    assert!(matches!(
        store
            .commit_context_mutation_transaction(
                &pruned_event,
                &[],
                &SessionProjectionMutation::default(),
                &pruned_plan,
                &pruned,
                &context_state_commitment(&pruned)?,
                &[],
            )
            .await?,
        ContextStateCommit::Committed { .. }
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
            state: replaced.clone(),
        }],
    };
    assert!(matches!(
        store
            .commit_context_mutation_transaction(
                &replaced_event,
                &[],
                &SessionProjectionMutation::default(),
                &replaced_plan,
                &replaced,
                &context_state_commitment(&replaced)?,
                &[],
            )
            .await?,
        ContextStateCommit::Committed { .. }
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
            .commit_context_seed_transaction(
                &seed_event,
                seed_context_id,
                context_id,
                replaced.version,
                "pg-seed-snapshot-hash",
                "mind_snapshot",
                &seeded,
                &context_state_commitment(&seeded)?,
                &[],
            )
            .await?,
        ContextStateCommit::Committed { .. }
    ));
    assert_eq!(
        store
            .get_mind_projection(seed_context_id)
            .await?
            .unwrap()
            .state,
        serde_json::to_value(&seeded)?
    );
    let seed_snapshot = store
        .get_latest_mind_snapshot(seed_context_id)
        .await?
        .expect("a seed transaction must establish its revision-zero recovery boundary");
    assert_eq!(seed_snapshot.revision, 0);
    assert_eq!(seed_snapshot.state, serde_json::to_value(&seeded)?);
    assert_eq!(seed_snapshot.state_hash, state_hash(&seeded));
    assert_eq!(seed_snapshot.head_event_id, seed_event.id);
    let seed_provenance = sqlx::query_as::<_, (Option<String>, Option<i64>, Option<String>)>(
        r#"SELECT seed_context_id, seed_context_version, seed_snapshot_hash
           FROM cognitive_contexts WHERE id = $1"#,
    )
    .bind(seed_context_id)
    .fetch_one(store.pool())
    .await?;
    assert_eq!(seed_provenance.0.as_deref(), Some(context_id));
    assert_eq!(seed_provenance.1, Some(i64::try_from(replaced.version)?));
    assert_eq!(seed_provenance.2.as_deref(), Some("pg-seed-snapshot-hash"));
    assert_eq!(
        store
            .query(QueryFilter {
                context_id: Some(seed_context_id.to_string()),
                event_id: Some(seed_event.id.clone()),
                ..QueryFilter::default()
            })
            .await?
            .len(),
        1,
    );
    assert!(matches!(
        store
            .commit_context_seed_transaction(
                &seed_event,
                seed_context_id,
                context_id,
                replaced.version,
                "pg-seed-snapshot-hash",
                "mind_snapshot",
                &seeded,
                &context_state_commitment(&seeded)?,
                &[],
            )
            .await?,
        ContextStateCommit::Conflict {
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

    let directory_request = ContextRuntimeDirectoryRequest {
        context_id: context_id.to_string(),
        active_session_id: session_id.to_string(),
        active_after: chrono::Utc::now() - chrono::Duration::hours(24),
        max_full_sessions: 50,
        max_metadata_sessions: 50,
        known_context_state_revision: None,
        session_filter: ContextRuntimeSessionFilter::default(),
    };
    let directory = store
        .read_context_runtime_directory_snapshot(&directory_request)
        .await?
        .unwrap();
    let directory_revision = directory.revision.clone();
    let directory_head = directory
        .context_state_head
        .clone()
        .expect("ContextDB directory must expose its authoritative Mind head");
    assert_eq!(directory.context_state.unwrap().state, replaced);
    let mut resident_directory_request = directory_request.clone();
    resident_directory_request.known_context_state_revision = Some(directory_head.revision);
    let resident_directory = store
        .read_context_runtime_directory_snapshot(&resident_directory_request)
        .await?
        .unwrap();
    assert_eq!(resident_directory.context_state_head, Some(directory_head));
    assert!(resident_directory.context_state.is_none());
    assert_eq!(resident_directory.revision, directory_revision);
    let encoding_snapshot = store
        .read_context_encoding_state_snapshot(context_id, &[session_id.to_string()], true, None)
        .await?;
    let encoding_revision = encoding_snapshot
        .context_state_head
        .as_ref()
        .expect("ContextDB snapshot must expose its authoritative Mind head")
        .revision;
    assert_eq!(
        encoding_snapshot.context_state.as_ref().unwrap().state,
        replaced,
        "the physical model Context snapshot must read ContextDB rather than the conflicting legacy projection"
    );
    let resident_encoding_snapshot = store
        .read_context_encoding_state_snapshot(
            context_id,
            &[session_id.to_string()],
            true,
            Some(encoding_revision),
        )
        .await?;
    assert!(
        resident_encoding_snapshot.context_state.is_none(),
        "a revision-fenced resident Context must not transfer and rebuild every ContextDB Node"
    );
    assert_eq!(
        resident_encoding_snapshot
            .context_state_head
            .as_ref()
            .map(|head| head.revision),
        Some(encoding_revision)
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
        .read_context_encoding_state_snapshot(context_id, &[session_id.to_string()], true, None)
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
    let restarted =
        PostgresStore::new_with_context_db(&scoped_url, 4, Arc::new(Observability::default()))
            .await?;
    assert_eq!(
        restarted
            .get_mind_projection(context_id)
            .await?
            .unwrap()
            .state,
        serde_json::to_value(&replaced)?
    );
    assert_eq!(
        restarted
            .get_context_state(seed_context_id)
            .await?
            .expect("seeded Context must survive PostgreSQL Runtime restart")
            .state,
        seeded,
    );
    assert_eq!(
        restarted
            .get_latest_mind_snapshot(seed_context_id)
            .await?
            .expect("seed recovery boundary must survive PostgreSQL Runtime restart"),
        seed_snapshot,
    );
    drop(restarted);
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&administration)
        .await?;
    Ok(())
}

#[tokio::test]
async fn postgres_context_db_periodic_snapshot_boundary_is_atomic_sparse_and_restartable_when_configured(
) -> Result<(), TestError> {
    let Ok(database_url) = std::env::var("MORPHZ_TEST_POSTGRES_URL") else {
        return Ok(());
    };
    let (administration, schema, scoped_url) =
        isolated_database_url(&database_url, "snapshot_boundary").await?;
    let store =
        PostgresStore::new_with_context_db(&scoped_url, 8, Arc::new(Observability::default()))
            .await?;
    let context_id = "contextdb-pg-snapshot-boundary";
    create_bundle(
        &store,
        "contextdb-pg-snapshot-agent",
        context_id,
        "contextdb-pg-snapshot-session",
    )
    .await;

    let at_63 = MindState {
        version: 63,
        mutation_clocks: ContextMutationClocks {
            global_barrier_version: 63,
            ..ContextMutationClocks::default()
        },
        ..MindState::default()
    };
    store
        .initialize_mind_projection(projection(context_id, &at_63, Some("import-at-63")))
        .await?;

    let at_64 = MindState {
        version: 64,
        mutation_clocks: ContextMutationClocks {
            global_barrier_version: 64,
            ..at_63.mutation_clocks.clone()
        },
        ..at_63.clone()
    };
    let rejected_event = context_event("contextdb-pg-snapshot-rejected-64", context_id);
    store
        .append(Event::new(
            rejected_event.id.clone(),
            "Conflicting-Actor".to_string(),
            "test-conflict".to_string(),
            "test/conflict".to_string(),
            serde_json::Map::new(),
        ))
        .await?;
    assert!(store
        .commit_context_mutation_transaction(
            &rejected_event,
            &[],
            &SessionProjectionMutation::default(),
            &mutation_plan(context_id, &at_63, &at_64),
            &at_64,
            &context_state_commitment(&at_64)?,
            &[],
        )
        .await
        .is_err());
    assert_eq!(
        store
            .get_context_state(context_id)
            .await?
            .expect("revision-63 Context must remain installed")
            .state,
        at_63,
        "a later Event failure must roll the native revision-64 AST mutation back",
    );
    assert!(store.get_latest_mind_snapshot(context_id).await?.is_none());

    let event_64 = context_event("contextdb-pg-snapshot-event-64", context_id);
    assert!(matches!(
        store
            .commit_context_mutation_transaction(
                &event_64,
                &[],
                &SessionProjectionMutation::default(),
                &mutation_plan(context_id, &at_63, &at_64),
                &at_64,
                &context_state_commitment(&at_64)?,
                &[],
            )
            .await?,
        ContextStateCommit::Committed { .. }
    ));
    let snapshot_64 = store
        .get_latest_mind_snapshot(context_id)
        .await?
        .expect("revision 64 must create the periodic full-state snapshot");
    assert_eq!(snapshot_64.revision, 64);
    assert_eq!(snapshot_64.state, serde_json::to_value(&at_64)?);
    assert_eq!(snapshot_64.state_hash, state_hash(&at_64));
    assert_eq!(snapshot_64.head_event_id, event_64.id);

    let at_65 = MindState {
        version: 65,
        mutation_clocks: ContextMutationClocks {
            global_barrier_version: 65,
            ..at_64.mutation_clocks.clone()
        },
        ..at_64.clone()
    };
    let event_65 = context_event("contextdb-pg-snapshot-event-65", context_id);
    assert!(matches!(
        store
            .commit_context_mutation_transaction(
                &event_65,
                &[],
                &SessionProjectionMutation::default(),
                &mutation_plan(context_id, &at_64, &at_65),
                &at_65,
                &context_state_commitment(&at_65)?,
                &[],
            )
            .await?,
        ContextStateCommit::Committed { .. }
    ));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM mind_snapshots WHERE context_id = $1",)
            .bind(context_id)
            .fetch_one(store.pool())
            .await?,
        1,
        "revision 65 must not materialize a second full-state snapshot",
    );

    store.pool().close().await;
    drop(store);
    let restarted =
        PostgresStore::new_with_context_db(&scoped_url, 4, Arc::new(Observability::default()))
            .await?;
    assert_eq!(
        restarted
            .get_context_state(context_id)
            .await?
            .expect("Context must survive PostgreSQL Runtime restart")
            .state,
        at_65,
    );
    assert_eq!(
        restarted
            .get_latest_mind_snapshot(context_id)
            .await?
            .expect("periodic snapshot must survive PostgreSQL Runtime restart"),
        snapshot_64,
    );
    restarted.pool().close().await;
    drop(restarted);
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&administration)
        .await?;
    Ok(())
}

#[tokio::test]
async fn postgres_context_db_default_switch_performs_exact_migration_when_configured(
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

    let rejected =
        PostgresStore::new_with_context_db(&scoped_url, 4, Arc::new(Observability::default()))
            .await
            .err()
            .ok_or("ContextDB startup unexpectedly migrated PostgreSQL state")?;
    assert!(rejected
        .to_string()
        .contains("storage migrate-cognitive-store --to context_db"));
    let transition = PostgresStore::migrate_cognitive_store(
        &scoped_url,
        4,
        morphz::config::CognitiveStoreBackend::ContextDb,
    )
    .await?;
    assert_eq!(transition.previous, None);
    assert_eq!(
        transition.selected,
        morphz::config::CognitiveStoreBackend::ContextDb
    );
    assert_eq!(transition.synchronized, 1);
    let authoritative =
        PostgresStore::new_with_context_db(&scoped_url, 4, Arc::new(Observability::default()))
            .await?;
    assert_eq!(
        authoritative
            .get_mind_projection("migration-context")
            .await?
            .unwrap(),
        expected
    );
    drop(authoritative);
    let report =
        PostgresStore::migrate_legacy_mind_projections_to_context_db(&scoped_url, 4).await?;
    assert_eq!(report.discovered, 1);
    assert_eq!(report.imported, 0);
    assert_eq!(report.already_authoritative, 1);
    let second =
        PostgresStore::migrate_legacy_mind_projections_to_context_db(&scoped_url, 4).await?;
    assert_eq!(second.discovered, 1);
    assert_eq!(second.imported, 0);
    assert_eq!(second.already_authoritative, 1);

    let authoritative =
        PostgresStore::new_with_context_db(&scoped_url, 4, Arc::new(Observability::default()))
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
async fn postgres_cognitive_store_switch_round_trips_without_hidden_dual_write(
) -> Result<(), TestError> {
    let Ok(database_url) = std::env::var("MORPHZ_TEST_POSTGRES_URL") else {
        return Ok(());
    };
    let (administration, schema, scoped_url) =
        isolated_database_url(&database_url, "store_switch").await?;
    let context_id = "postgres-cognitive-store-switch-context";
    let legacy =
        PostgresStore::new_with_legacy(&scoped_url, 4, Arc::new(Observability::default())).await?;
    create_bundle(
        &legacy,
        "postgres-cognitive-store-switch-agent",
        context_id,
        "postgres-cognitive-store-switch-session",
    )
    .await;
    let initial = MindState::default();
    legacy
        .initialize_context_state(
            context_id,
            &initial,
            &context_state_commitment(&initial)?,
            None,
            &[],
        )
        .await?;
    legacy.pool().close().await;
    drop(legacy);

    let rejected =
        PostgresStore::new_with_context_db(&scoped_url, 4, Arc::new(Observability::default()))
            .await
            .err()
            .ok_or("ContextDB startup unexpectedly migrated PostgreSQL state")?;
    assert!(rejected
        .to_string()
        .contains("storage migrate-cognitive-store --to context_db"));
    PostgresStore::migrate_cognitive_store(
        &scoped_url,
        4,
        morphz::config::CognitiveStoreBackend::ContextDb,
    )
    .await?;
    let context_db =
        PostgresStore::new_with_context_db(&scoped_url, 4, Arc::new(Observability::default()))
            .await?;
    assert_eq!(
        context_db
            .get_context_state(context_id)
            .await?
            .unwrap()
            .state,
        initial
    );
    let mut context_db_state = initial.clone();
    context_db_state.version = 1;
    context_db_state
        .protected
        .insert("postgres-context-db-only".to_string());
    let context_db_plan = mutation_plan_with(
        context_id,
        &initial,
        &context_db_state,
        vec![ContextStateMutation::ReplaceMind {
            state: context_db_state.clone(),
        }],
    );
    assert!(matches!(
        context_db
            .commit_context_mutation_transaction(
                &context_event("postgres-cognitive-store-context-db-event", context_id),
                &[],
                &SessionProjectionMutation::default(),
                &context_db_plan,
                &context_db_state,
                &context_state_commitment(&context_db_state)?,
                &[],
            )
            .await?,
        ContextStateCommit::Committed { .. }
    ));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT revision FROM context_heads WHERE context_id = $1")
            .bind(context_id)
            .fetch_one(context_db.pool())
            .await?,
        0,
        "normal ContextDB commits must not dual-write legacy"
    );
    context_db.pool().close().await;
    drop(context_db);

    let rejected =
        PostgresStore::new_with_legacy(&scoped_url, 4, Arc::new(Observability::default()))
            .await
            .err()
            .ok_or("legacy startup unexpectedly migrated PostgreSQL state")?;
    assert!(rejected
        .to_string()
        .contains("storage migrate-cognitive-store --to legacy"));
    PostgresStore::migrate_cognitive_store(
        &scoped_url,
        4,
        morphz::config::CognitiveStoreBackend::Legacy,
    )
    .await?;
    let legacy =
        PostgresStore::new_with_legacy(&scoped_url, 4, Arc::new(Observability::default())).await?;
    assert_eq!(
        legacy.get_context_state(context_id).await?.unwrap().state,
        context_db_state
    );
    let mut legacy_state = context_db_state.clone();
    legacy_state.version = 2;
    legacy_state
        .protected
        .insert("postgres-legacy-only".to_string());
    let legacy_plan = mutation_plan_with(
        context_id,
        &context_db_state,
        &legacy_state,
        vec![ContextStateMutation::ReplaceMind {
            state: legacy_state.clone(),
        }],
    );
    assert!(matches!(
        legacy
            .commit_context_mutation_transaction(
                &context_event("postgres-cognitive-store-legacy-event", context_id),
                &[],
                &SessionProjectionMutation::default(),
                &legacy_plan,
                &legacy_state,
                &context_state_commitment(&legacy_state)?,
                &[],
            )
            .await?,
        ContextStateCommit::Committed { .. }
    ));
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT revision FROM experimental_contextdb_runtime_heads WHERE context_id = $1"
        )
        .bind(context_id)
        .fetch_one(legacy.pool())
        .await?,
        1,
        "normal legacy commits must not dual-write ContextDB"
    );
    legacy.pool().close().await;
    drop(legacy);

    let rejected =
        PostgresStore::new_with_context_db(&scoped_url, 4, Arc::new(Observability::default()))
            .await
            .err()
            .ok_or("ContextDB startup unexpectedly migrated PostgreSQL state")?;
    assert!(rejected
        .to_string()
        .contains("storage migrate-cognitive-store --to context_db"));
    PostgresStore::migrate_cognitive_store(
        &scoped_url,
        4,
        morphz::config::CognitiveStoreBackend::ContextDb,
    )
    .await?;
    let context_db =
        PostgresStore::new_with_context_db(&scoped_url, 4, Arc::new(Observability::default()))
            .await?;
    let final_state = context_db.get_context_state(context_id).await?.unwrap();
    assert_eq!(final_state.revision, 2);
    assert_eq!(final_state.state, legacy_state);
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT active_store FROM cognitive_store_control WHERE singleton = 1"
        )
        .fetch_one(context_db.pool())
        .await?,
        "context_db"
    );
    context_db.pool().close().await;
    drop(context_db);
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&administration)
        .await?;
    Ok(())
}

#[tokio::test]
async fn postgres_cognitive_store_migration_rejects_equal_revision_divergence(
) -> Result<(), TestError> {
    let Ok(database_url) = std::env::var("MORPHZ_TEST_POSTGRES_URL") else {
        return Ok(());
    };
    let (administration, schema, scoped_url) =
        isolated_database_url(&database_url, "store_divergence").await?;
    let context_id = "postgres-cognitive-store-divergence-context";
    let legacy =
        PostgresStore::new_with_legacy(&scoped_url, 4, Arc::new(Observability::default())).await?;
    create_bundle(
        &legacy,
        "postgres-cognitive-store-divergence-agent",
        context_id,
        "postgres-cognitive-store-divergence-session",
    )
    .await;
    let initial = MindState::default();
    legacy
        .initialize_context_state(
            context_id,
            &initial,
            &context_state_commitment(&initial)?,
            None,
            &[],
        )
        .await?;
    legacy.pool().close().await;
    drop(legacy);

    PostgresStore::migrate_cognitive_store(
        &scoped_url,
        4,
        morphz::config::CognitiveStoreBackend::ContextDb,
    )
    .await?;
    let context_db =
        PostgresStore::new_with_context_db(&scoped_url, 4, Arc::new(Observability::default()))
            .await?;
    let mut divergent = initial;
    divergent
        .protected
        .insert("inactive-store-divergence".to_string());
    let divergent_hash = state_hash(&divergent);
    sqlx::query(
        "UPDATE mind_projections SET state_json = $1, state_hash = $2 WHERE context_id = $3",
    )
    .bind(serde_json::to_value(&divergent)?)
    .bind(&divergent_hash)
    .bind(context_id)
    .execute(context_db.pool())
    .await?;
    sqlx::query("UPDATE context_heads SET projection_hash = $1 WHERE context_id = $2")
        .bind(divergent_hash)
        .bind(context_id)
        .execute(context_db.pool())
        .await?;
    context_db.pool().close().await;
    drop(context_db);

    let error = PostgresStore::migrate_cognitive_store(
        &scoped_url,
        4,
        morphz::config::CognitiveStoreBackend::Legacy,
    )
    .await
    .err()
    .ok_or("equal-revision PostgreSQL divergence unexpectedly migrated")?;
    assert!(error.to_string().contains("diverge at revision 0"));

    let reopened =
        PostgresStore::new_with_context_db(&scoped_url, 4, Arc::new(Observability::default()))
            .await?;
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT active_store FROM cognitive_store_control WHERE singleton = 1"
        )
        .fetch_one(reopened.pool())
        .await?,
        "context_db"
    );
    reopened.pool().close().await;
    drop(reopened);
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
    let transient =
        PostgresStore::new_with_context_db(&transient_url, 2, Arc::new(Observability::default()))
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
