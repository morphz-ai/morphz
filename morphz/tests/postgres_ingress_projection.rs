//! Actual PostgreSQL ingress parity: indexed causal routes and the bounded
//! Session timeline must commit with admission, not in a later repair pass.
use morphz::event::Event;
use morphz::memory::postgres::PostgresStore;
use morphz::memory::{
    ActivationStore, DeliveryIngressStore, EventStore, MessageClaim, MessageDispatchMode, NewAgent,
    NewCognitiveContext, NewPrincipal, NewSession, NewThreadActivation, QueryFilter,
    SessionDirectoryStore, SessionMountKind, SessionTimelineStore, ThreadActivationStatus,
    ThreadStore,
};
use morphz::runtime::{MessageIngressError, MessageIngressErrorKind};
use serde_json::json;
use sqlx::Row;

type TestError = Box<dyn std::error::Error + Send + Sync>;

async fn bundle(store: &PostgresStore, label: &str) -> Result<(), TestError> {
    store
        .create_agent_bundle(
            NewAgent {
                id: format!("agent-{label}"),
                title: "Ingress projection test".into(),
                root_context_id: format!("context-{label}"),
            },
            NewCognitiveContext {
                id: format!("context-{label}"),
                agent_id: format!("agent-{label}"),
                title: "Ingress projection test".into(),
            },
            NewSession {
                id: format!("session-{label}"),
                agent_id: format!("agent-{label}"),
                context_id: format!("context-{label}"),
                parent_session_id: None,
                title: "Ingress projection test".into(),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await?;
    store
        .ensure_principal(NewPrincipal {
            id: "ingress-principal".into(),
            provider_id: "test".into(),
            assurance: "verified".into(),
            display_name: None,
        })
        .await?;
    store
        .bind_session_principal(&format!("session-{label}"), "ingress-principal")
        .await?;
    Ok(())
}

fn input(label: &str, id: &str, nested_route: bool) -> Event {
    let mut event = Event::new(
        id.into(),
        "Human".into(),
        "session_message".into(),
        "chat/user_message".into(),
        json!({
            "session_id": format!("session-{label}"),
            "context_id": format!("context-{label}"),
            "principal_id": "ingress-principal",
            "client_message_id": format!("client-{id}"),
            "attempt_id": format!("attempt-{id}"),
            "text": "Synthetic ingress projection fixture"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    let route = json!({
        "root_turn_id": id,
        "thread_id": format!("causal-thread-{id}"),
        "activation_id": format!("causal-activation-{id}"),
        "objective_id": format!("causal-objective-{id}")
    });
    if nested_route {
        event.payload.insert("route".into(), route);
    } else {
        event.payload.extend(route.as_object().unwrap().clone());
    }
    event.timestamp = chrono::DateTime::parse_from_rfc3339("2026-09-30T15:47:20.670650123Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    event
}

async fn claim(
    store: &PostgresStore,
    event: &Event,
    mode: MessageDispatchMode,
) -> Result<MessageClaim, TestError> {
    store
        .claim_message(
            event.payload["session_id"].as_str().unwrap(),
            event.payload["client_message_id"].as_str().unwrap(),
            event,
            mode,
        )
        .await
}

async fn assert_projection(
    store: &PostgresStore,
    pool: &sqlx::PgPool,
    event: &Event,
    causal_root: &str,
) -> Result<(), TestError> {
    let exact = store
        .query(QueryFilter {
            event_id: Some(event.id.clone()),
            ..Default::default()
        })
        .await?;
    assert_eq!(exact.len(), 1);
    let indexed = store
        .query(QueryFilter {
            root_turn_id: Some(causal_root.into()),
            session_id: Some(event.payload["session_id"].as_str().unwrap().into()),
            ..Default::default()
        })
        .await?;
    assert!(indexed.iter().any(|candidate| candidate.id == event.id));
    let timeline = store
        .query_session_timeline(event.payload["session_id"].as_str().unwrap(), None, 100)
        .await?;
    let item = timeline
        .iter()
        .find(|item| item.entry_id == event.payload["client_message_id"].as_str().unwrap())
        .expect("accepted input must be discoverable in bounded history");
    assert_eq!(item.event.id, event.id);
    // A steering message has its own input grant identity in the timeline,
    // while the immutable Event's causal root targets the original Thread.
    assert_eq!(item.root_turn_id, event.id);
    assert!(
        item.root_event.is_none(),
        "the input Event is already the timeline root"
    );
    assert_eq!(
        item.attempt_id.as_deref(),
        event.payload["attempt_id"].as_str()
    );
    assert_eq!(item.visible_at_micros, event.timestamp.timestamp_micros());
    assert_eq!(item.display_kind, "input");
    assert!(item.final_event);
    let row = sqlx::query(
        "SELECT timeline.source_sequence, events.sequence, timeline.output_visible_at_micros \
         FROM session_message_timeline timeline JOIN events ON events.id = timeline.source_event_id \
         WHERE timeline.source_event_id = $1",
    )
    .bind(&event.id)
    .fetch_one(pool)
    .await?;
    assert_eq!(
        row.get::<i64, _>("source_sequence"),
        row.get::<i64, _>("sequence")
    );
    assert!(row
        .get::<Option<i64>, _>("output_visible_at_micros")
        .is_none());
    Ok(())
}

// Include every durable participant of admission. Sequence gaps on rollback
// are normal PostgreSQL behavior and are intentionally not compared.
async fn admission_snapshot(pool: &sqlx::PgPool) -> Result<Vec<serde_json::Value>, TestError> {
    let mut counts = Vec::new();
    for table in [
        "session_message_requests",
        "principal_context_encounters",
        "events",
        "session_message_timeline",
        "session_projections",
        "recall_projection_outbox",
        "threads",
        "thread_signals",
        "thread_activations",
        "activation_signals",
        "scheduler_dependencies",
        "sessions",
    ] {
        counts.push(
            sqlx::query_scalar(&format!(
                "SELECT COALESCE(jsonb_agg(to_jsonb(row) ORDER BY to_jsonb(row)::text), '[]'::jsonb) FROM {table} row"
            ))
                .fetch_one(pool)
                .await?,
        );
    }
    Ok(counts)
}

async fn thinking_predecessor(store: &PostgresStore, label: &str) -> Result<(), TestError> {
    let event = input(label, &format!("predecessor-{label}"), false);
    assert!(matches!(
        claim(store, &event, MessageDispatchMode::Parallel).await?,
        MessageClaim::Accepted { .. }
    ));
    let sequence = store
        .query(QueryFilter {
            event_id: Some(event.id.clone()),
            ..Default::default()
        })
        .await?
        .pop()
        .unwrap()
        .sequence
        .unwrap();
    let activation_id = format!("activation-{label}");
    store
        .ensure_thread_activation(NewThreadActivation {
            id: activation_id.clone(),
            agent_id: format!("agent-{label}"),
            context_id: format!("context-{label}"),
            session_id: format!("session-{label}"),
            initiating_principal_id: Some("ingress-principal".into()),
            trigger_event_id: event.id.clone(),
            trigger_sequence: sequence,
            trigger_kind: event.topic.clone(),
            parent_activation_id: None,
            root_turn_id: event.id.clone(),
        })
        .await?;
    store
        .update_thread_activation(
            &activation_id,
            1,
            ThreadActivationStatus::Running,
            Some("test-worker"),
            Some(chrono::Utc::now() + chrono::Duration::minutes(10)),
            Some(1),
        )
        .await?;
    store
        .bind_activation_input_signals(&activation_id, &[event.id])
        .await?;
    Ok(())
}

async fn assertions(store: &PostgresStore, pool: &sqlx::PgPool) -> Result<(), TestError> {
    for (index, mode) in [
        MessageDispatchMode::Parallel,
        MessageDispatchMode::Interrupt,
        MessageDispatchMode::FollowUp,
    ]
    .into_iter()
    .enumerate()
    {
        let label = format!("ordinary-{index}");
        bundle(store, &label).await?;
        // Both payload layouts must use the same causal helper as the general
        // append path; supplying conflicting legacy fields cannot override top-level fields.
        for nested in [false, true] {
            let id = format!("input-{index}-{nested}");
            let mut event = input(&label, &id, nested);
            if !nested {
                event
                    .payload
                    .insert("route".into(), json!({"root_turn_id":"shadow-root"}));
            }
            assert!(matches!(
                claim(store, &event, mode).await?,
                MessageClaim::Accepted { .. }
            ));
            assert_projection(store, pool, &event, &id).await?;
            let row = sqlx::query("SELECT thread_id, activation_id, root_turn_id, objective_id FROM events WHERE id = $1")
                .bind(&id).fetch_one(pool).await?;
            assert_eq!(
                row.get::<String, _>("thread_id"),
                format!("causal-thread-{id}")
            );
            assert_eq!(
                row.get::<String, _>("activation_id"),
                format!("causal-activation-{id}")
            );
            assert_eq!(row.get::<String, _>("root_turn_id"), id);
            assert_eq!(
                row.get::<String, _>("objective_id"),
                format!("causal-objective-{id}")
            );
            let before = admission_snapshot(pool).await?;
            let (duplicate_a, duplicate_b) =
                tokio::join!(claim(store, &event, mode), claim(store, &event, mode));
            for duplicate in [duplicate_a?, duplicate_b?] {
                assert_eq!(
                    duplicate,
                    MessageClaim::Existing {
                        event_id: id.clone()
                    }
                );
            }
            assert_eq!(admission_snapshot(pool).await?, before);
            let mut conflicting = event.clone();
            conflicting.id = format!("conflicting-{id}");
            conflicting
                .payload
                .insert("text".into(), json!("Different synthetic fixture"));
            assert_eq!(
                claim(store, &conflicting, mode).await?,
                MessageClaim::Conflict {
                    event_id: id.clone()
                }
            );
            assert_eq!(admission_snapshot(pool).await?, before);
        }
    }

    bundle(store, "steering").await?;
    let root = input("steering", "steering-root", false);
    assert!(matches!(
        claim(store, &root, MessageDispatchMode::Parallel).await?,
        MessageClaim::Accepted { .. }
    ));
    let target = store.get_thread_by_root(&root.id).await?.unwrap();
    let mut steering = input("steering", "steering-input", false);
    steering.payload.insert(
        "input_destination".into(),
        json!({"kind":"thread", "thread_id":target.id, "generation":target.generation}),
    );
    assert!(matches!(
        claim(store, &steering, MessageDispatchMode::Parallel).await?,
        MessageClaim::Accepted { .. }
    ));
    assert_projection(store, pool, &steering, &root.id).await?;
    let persisted = store
        .query(QueryFilter {
            event_id: Some(steering.id.clone()),
            ..Default::default()
        })
        .await?
        .pop()
        .unwrap();
    assert_eq!(persisted.topic, "chat/steering");
    assert_eq!(persisted.payload["thread_id"], target.id);
    let before = admission_snapshot(pool).await?;
    assert_eq!(
        claim(store, &steering, MessageDispatchMode::Parallel).await?,
        MessageClaim::Existing {
            event_id: steering.id.clone()
        }
    );
    assert_eq!(admission_snapshot(pool).await?, before);

    let mut stale = input("steering", "steering-stale", false);
    stale.payload.insert(
        "input_destination".into(),
        json!({"kind":"thread", "thread_id":target.id, "generation":target.generation + 1}),
    );
    let error = claim(store, &stale, MessageDispatchMode::Parallel)
        .await
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<MessageIngressError>().unwrap().kind,
        MessageIngressErrorKind::Conflict
    );
    assert_eq!(admission_snapshot(pool).await?, before);
    store
        .ensure_principal(NewPrincipal {
            id: "other-principal".into(),
            provider_id: "test".into(),
            assurance: "verified".into(),
            display_name: None,
        })
        .await?;
    store
        .bind_session_principal("session-steering", "other-principal")
        .await?;
    let mut forbidden = input("steering", "steering-forbidden", false);
    forbidden
        .payload
        .insert("principal_id".into(), json!("other-principal"));
    forbidden.payload.insert(
        "input_destination".into(),
        json!({"kind":"thread", "thread_id":target.id, "generation":target.generation}),
    );
    let error = claim(store, &forbidden, MessageDispatchMode::Parallel)
        .await
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<MessageIngressError>().unwrap().kind,
        MessageIngressErrorKind::Forbidden
    );
    assert_eq!(admission_snapshot(pool).await?, before);

    // A timeline failure occurs after admission was selected. It must roll
    // back the entire CTE/transaction, including ordered route changes.
    for index in 0..3 {
        let label = format!("fault-{index}");
        bundle(store, &label).await?;
        thinking_predecessor(store, &label).await?;
    }
    sqlx::query("CREATE FUNCTION reject_test_timeline() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected timeline projection failure'; END $$")
        .execute(pool).await?;
    sqlx::query("CREATE TRIGGER reject_test_timeline BEFORE INSERT ON session_message_timeline FOR EACH ROW EXECUTE FUNCTION reject_test_timeline()")
        .execute(pool).await?;
    for (index, mode) in [
        MessageDispatchMode::Parallel,
        MessageDispatchMode::Interrupt,
        MessageDispatchMode::FollowUp,
    ]
    .into_iter()
    .enumerate()
    {
        let label = format!("fault-{index}");
        let event = input(&label, &format!("fault-input-{index}"), false);
        let before = admission_snapshot(pool).await?;
        let session_before: (String, Option<String>) =
            sqlx::query_as("SELECT updated_at, last_activity_at FROM sessions WHERE id = $1")
                .bind(format!("session-{label}"))
                .fetch_one(pool)
                .await?;
        assert!(claim(store, &event, mode)
            .await
            .unwrap_err()
            .to_string()
            .contains("injected timeline projection failure"));
        assert_eq!(admission_snapshot(pool).await?, before);
        let session_after: (String, Option<String>) =
            sqlx::query_as("SELECT updated_at, last_activity_at FROM sessions WHERE id = $1")
                .bind(format!("session-{label}"))
                .fetch_one(pool)
                .await?;
        assert_eq!(session_before, session_after);
        let mut unbound = event.clone();
        unbound
            .payload
            .insert("principal_id".into(), json!("unbound-principal"));
        assert!(matches!(
            claim(store, &unbound, mode).await?,
            MessageClaim::ForbiddenPrincipal { .. }
        ));
        assert_eq!(admission_snapshot(pool).await?, before);
    }
    let mut fault_steering = input("steering", "fault-steering", false);
    fault_steering.payload.insert(
        "input_destination".into(),
        json!({"kind":"thread", "thread_id":target.id, "generation":target.generation}),
    );
    let before = admission_snapshot(pool).await?;
    assert!(claim(store, &fault_steering, MessageDispatchMode::Parallel)
        .await
        .unwrap_err()
        .to_string()
        .contains("injected timeline projection failure"));
    assert_eq!(admission_snapshot(pool).await?, before);
    sqlx::query("DROP TRIGGER reject_test_timeline ON session_message_timeline")
        .execute(pool)
        .await?;
    for (index, mode) in [
        MessageDispatchMode::Parallel,
        MessageDispatchMode::Interrupt,
        MessageDispatchMode::FollowUp,
    ]
    .into_iter()
    .enumerate()
    {
        let event = input(
            &format!("fault-{index}"),
            &format!("fault-input-{index}"),
            false,
        );
        let MessageClaim::Accepted {
            event: accepted,
            interrupted,
        } = claim(store, &event, mode).await?
        else {
            panic!("same input must be admitted after the failing projection is removed");
        };
        if mode == MessageDispatchMode::Interrupt {
            assert_eq!(interrupted.unwrap().root_turn_id, "predecessor-fault-1");
            assert_eq!(
                store
                    .get_thread_activation("activation-fault-1")
                    .await?
                    .unwrap()
                    .status,
                ThreadActivationStatus::Cancelled
            );
        } else {
            assert!(interrupted.is_none());
            if mode == MessageDispatchMode::FollowUp {
                let predecessor = store
                    .get_thread_by_root("predecessor-fault-2")
                    .await?
                    .unwrap();
                assert_eq!(accepted.payload["after_thread_id"], predecessor.id);
            }
        }
        assert_projection(store, pool, &event, &event.id).await?;
    }
    assert!(matches!(
        claim(store, &fault_steering, MessageDispatchMode::Parallel).await?,
        MessageClaim::Accepted { .. }
    ));
    assert_projection(store, pool, &fault_steering, &root.id).await?;
    Ok(())
}

#[tokio::test]
async fn postgres_ingress_indexes_timeline_and_atomicity_when_configured() -> Result<(), TestError>
{
    let Ok(database_url) = std::env::var("MORPHZ_TEST_POSTGRES_URL") else {
        return Ok(());
    };
    let admin = sqlx::PgPool::connect(&database_url).await?;
    let schema = format!(
        "morphz_ingress_{}_{}",
        std::process::id(),
        chrono::Utc::now()
            .timestamp_nanos_opt()
            .unwrap()
            .unsigned_abs()
    );
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&admin)
        .await?;
    let separator = if database_url.contains('?') { '&' } else { '?' };
    // No public fallback: every migration and test mutation stays in the new
    // schema even when the configured database has existing validation data.
    let scoped = format!("{database_url}{separator}options=-csearch_path%3D{schema}");
    let store = PostgresStore::new(&scoped, 8).await?;
    let pool = sqlx::PgPool::connect(&scoped).await?;
    let result = assertions(&store, &pool).await;
    pool.close().await;
    drop(store);
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await?;
    result
}
