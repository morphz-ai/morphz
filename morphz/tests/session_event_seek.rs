//! Session event heads/deltas must stay bounded in SQL, including upgrades.
#[path = "support/temp_sqlite.rs"]
mod temp_sqlite;

use morphz::event::Event;
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{EventStore, QueryFilter};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::Row;
use temp_sqlite::TempSqliteDb;

#[tokio::test]
async fn session_head_and_delta_seek_append_index_after_upgrade_without_reordering_events() {
    let database = TempSqliteDb::new().unwrap();
    let path = database.path().to_str().unwrap();
    let store = SqliteStore::new(path).await.unwrap();
    for n in 0..40 {
        let mut event = Event::new(
            format!("seek-{n}"),
            "fixture".into(),
            "fixture".into(),
            if n % 3 == 0 {
                "chat/context_inspect"
            } else {
                "chat/reply"
            }
            .into(),
            serde_json::json!({"session_id": if n % 2 == 0 { "one" } else { "two" }})
                .as_object()
                .unwrap()
                .clone(),
        );
        // Producer timestamps do not define the durable append frontier.
        event.timestamp -= chrono::Duration::seconds(n);
        store.append(event).await.unwrap();
    }
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(SqliteConnectOptions::new().filename(database.path()))
        .await
        .unwrap();
    let original: Vec<(i64, String)> = sqlx::query_as("SELECT rowid,id FROM events ORDER BY rowid")
        .fetch_all(&pool)
        .await
        .unwrap();
    // Simulate opening an existing pre-index database, not just a fresh schema.
    sqlx::query("DROP INDEX idx_events_session_sequence")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    drop(store);
    let upgraded = SqliteStore::new(path).await.unwrap();
    let reopened = SqliteStore::new(path).await.unwrap();
    // Inspect the upgraded database through a fresh diagnostic connection,
    // just like a new Runtime incarnation, not a pre-migration schema cache.
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(SqliteConnectOptions::new().filename(database.path()))
        .await
        .unwrap();
    let indexes: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events' ORDER BY name",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(
        indexes
            .iter()
            .any(|name| name == "idx_events_session_sequence"),
        "{indexes:?}"
    );
    for query in [
        "SELECT id FROM events WHERE session_id = ? AND topic != 'chat/context_inspect' ORDER BY rowid DESC LIMIT 1",
        "SELECT id FROM events WHERE session_id = ? AND rowid > 10 AND topic != 'chat/context_inspect' ORDER BY rowid ASC LIMIT 100",
        "SELECT id FROM events WHERE session_id = ? AND rowid < 30 AND topic != 'chat/context_inspect' ORDER BY rowid DESC LIMIT 100",
    ] {
        let plan = sqlx::query(&format!("EXPLAIN QUERY PLAN {query}"))
            .bind("one").fetch_all(&pool).await.unwrap()
            .iter().map(|r| r.get::<String, _>("detail")).collect::<Vec<_>>().join("\n");
        assert!(plan.contains("SEARCH events USING INDEX idx_events_session_sequence"), "{query}\n{plan}");
        assert!(!plan.contains("TEMP B-TREE") && !plan.contains("SCAN events"), "{query}\n{plan}");
    }
    let head = upgraded
        .query(QueryFilter {
            session_id: Some("one".into()),
            latest_k: Some(1),
            excluded_topics: vec!["chat/context_inspect".into()],
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(head[0].id, "seek-38");
    let prior = reopened
        .query(QueryFilter {
            session_id: Some("one".into()),
            latest_k: Some(2),
            before_sequence: head[0].sequence,
            excluded_topics: vec!["chat/context_inspect".into()],
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        prior.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
        ["seek-32", "seek-34"]
    );
    let delta = reopened
        .query(QueryFilter {
            session_id: Some("one".into()),
            top_k: Some(1),
            after_sequence: prior.last().unwrap().sequence,
            excluded_topics: vec!["chat/context_inspect".into()],
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(delta[0].id, head[0].id);
    let preserved: Vec<(i64, String)> =
        sqlx::query_as("SELECT rowid,id FROM events ORDER BY rowid")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        original, preserved,
        "index migration must preserve message identity and cursors"
    );
    pool.close().await;
}
