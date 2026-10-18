//! Real storage and Context Encoding coverage; no model calls or work replay.
use morphz::config::OrchestratorConfig;
use morphz::event::{Event, TYPE_AGENT_CALL, TYPE_USER_MESSAGE};
use morphz::memory::{postgres::PostgresStore, sqlite::SqliteStore};
use morphz::memory::{
    MindProjectionStore, NewAgent, NewCognitiveContext, NewMindProjection, NewSession,
    RuntimeStore, SessionMountKind,
};
use morphz::orchestrator::context::{ContextEngine, ContextViewManifest};
use serde_json::json;
use std::{collections::HashSet, sync::Arc};
type Error = Box<dyn std::error::Error + Send + Sync>;
const MIGRATION: &str = "20261018_01_terminal_delivery_observations";

fn event(id: &str, topic: &str, kind: &str, state: Option<&str>) -> Event {
    let text = match id {
        "question" => "合成问题：方案 A 为什么有效？",
        "continue" => "继续",
        _ => "Synthetic delivery did not complete",
    };
    let mut p = json!({"context_id":"delivery-context", "session_id":"delivery-session", "root_turn_id":"question", "caused_by":"question", "thread_id":"failed-thread", "text":text});
    if let Some(state) = state {
        p["terminal_kind"] = json!(state);
        p["attempt_id"] = json!("failed-internal-attempt");
    }
    Event::new(
        id.into(),
        "Agent-Morphz".into(),
        kind.into(),
        topic.into(),
        p.as_object().unwrap().clone(),
    )
}
async fn populate<S: RuntimeStore + 'static>(store: Arc<S>) -> Result<(), Error> {
    store
        .create_agent_bundle(
            NewAgent {
                id: "delivery-agent".into(),
                title: "Synthetic delivery test".into(),
                root_context_id: "delivery-context".into(),
            },
            NewCognitiveContext {
                id: "delivery-context".into(),
                agent_id: "delivery-agent".into(),
                title: "Synthetic delivery test".into(),
            },
            NewSession {
                id: "delivery-session".into(),
                agent_id: "delivery-agent".into(),
                context_id: "delivery-context".into(),
                parent_session_id: None,
                title: "Synthetic delivery test".into(),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await?;
    for e in [
        event("question", "chat/user_message", TYPE_USER_MESSAGE, None),
        event(
            "failed",
            "session/io_state",
            TYPE_AGENT_CALL,
            Some("failed"),
        ),
        event(
            "cancelled",
            "session/io_state",
            TYPE_AGENT_CALL,
            Some("cancelled"),
        ),
        event(
            "retired-state",
            "session/io_state",
            TYPE_AGENT_CALL,
            Some("failed"),
        ),
        event(
            "silent",
            "session/io_state",
            TYPE_AGENT_CALL,
            Some("silent"),
        ),
        event(
            "diagnostic",
            "runtime/response_protocol_error",
            "runtime_control",
            Some("failed"),
        ),
        event("continue", "chat/user_message", TYPE_USER_MESSAGE, None),
    ] {
        store.append(e).await?;
    }
    Ok(())
}
async fn assert_visible<S: RuntimeStore + 'static>(store: Arc<S>) -> Result<(), Error> {
    let events = store
        .query_session_projections("delivery-context", &["delivery-session".into()], false)
        .await?;
    let ids: HashSet<_> = events.iter().map(|e| e.id.as_str()).collect();
    for id in ["question", "failed", "cancelled", "continue"] {
        assert!(ids.contains(id), "missing {id}");
    }
    for id in ["silent", "diagnostic", "retired-state"] {
        assert!(!ids.contains(id), "unexpected {id}");
    }
    assert!(store
        .query_session_projections("other-context", &["delivery-session".into()], false)
        .await?
        .is_empty());
    assert!(store
        .query_session_projections("delivery-context", &["other-session".into()], false)
        .await?
        .is_empty());
    let engine = ContextEngine::new(store.clone(), OrchestratorConfig::default())
        .with_session_store(store.clone())
        .with_session_projection_store(store);
    let view = engine
        .build_context_encoding("delivery-context", "delivery-session", &HashSet::new())
        .await?;
    let resident = ContextViewManifest::from_view(&view, []).resident_event_ids;
    for id in ["question", "failed", "continue"] {
        assert!(
            resident.contains(&id.to_string()),
            "not in physical view: {id}"
        );
    }
    assert!(view.sexpr.contains("(response-disposition failed)"));
    let question = view
        .observations
        .iter()
        .find(|item| item.id == "question")
        .unwrap();
    assert!(
        view.sexpr
            .contains(&format!("(caused-by {})", question.reference)),
        "the failure must point to the exact visible question"
    );
    assert!(view.sexpr.contains("方案 A 为什么有效"));
    Ok(())
}
#[tokio::test]
async fn sqlite_terminal_delivery_backfill_and_encoding() -> Result<(), Error> {
    let dir = tempfile::TempDir::new()?;
    let path = dir.path().join("runtime.sqlite");
    let store = Arc::new(SqliteStore::new(&path.to_string_lossy()).await?);
    populate(store.clone()).await?;
    let pool = sqlx::SqlitePool::connect(&format!("sqlite:{}", path.display())).await?;
    // Simulate the old derived index only, keeping immutable Events intact.
    sqlx::query(
        "DELETE FROM session_projections WHERE event_id IN ('failed','cancelled','retired-state')",
    )
    .execute(&pool)
    .await?;
    store
        .initialize_mind_projection(NewMindProjection {
            context_id: "delivery-context".into(),
            revision: 0,
            state: json!({"version":0,"frames":[],"retired":["retired-state"]}),
            state_hash: "fixture".into(),
            head_event_id: None,
            recall_documents: vec![],
        })
        .await?;
    sqlx::query("DELETE FROM schema_migrations WHERE version=?")
        .bind(MIGRATION)
        .execute(&pool)
        .await?;
    drop(store);
    pool.close().await;
    let reopened = Arc::new(SqliteStore::new(&path.to_string_lossy()).await?);
    assert_visible(reopened).await
}
#[tokio::test]
async fn postgres_terminal_delivery_backfill_and_encoding() -> Result<(), Error> {
    let url = std::env::var("MORPHZ_TEST_POSTGRES_URL")
        .expect("dedicated PostgreSQL test URL is required; use prepareTestPostgres");
    let admin = sqlx::PgPool::connect(&url).await?;
    let schema = format!(
        "delivery_context_{}_{}",
        std::process::id(),
        chrono::Utc::now().timestamp_micros().unsigned_abs()
    );
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&admin)
        .await?;
    let scoped = format!(
        "{url}{}options=-csearch_path%3D{schema}",
        if url.contains('?') { '&' } else { '?' }
    );
    let store = Arc::new(PostgresStore::new(&scoped, 4).await?);
    populate(store.clone()).await?;
    sqlx::query(
        "DELETE FROM session_projections WHERE event_id IN ('failed','cancelled','retired-state')",
    )
    .execute(store.pool())
    .await?;
    store
        .initialize_mind_projection(NewMindProjection {
            context_id: "delivery-context".into(),
            revision: 0,
            state: json!({"version":0,"frames":[],"retired":["retired-state"]}),
            state_hash: "fixture".into(),
            head_event_id: None,
            recall_documents: vec![],
        })
        .await?;
    sqlx::query("DELETE FROM schema_migrations WHERE version=$1")
        .bind(MIGRATION)
        .execute(store.pool())
        .await?;
    store.pool().close().await;
    drop(store);
    let reopened = Arc::new(PostgresStore::new(&scoped, 4).await?);
    let result = assert_visible(reopened.clone()).await;
    reopened.pool().close().await;
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await?;
    admin.close().await;
    result
}
