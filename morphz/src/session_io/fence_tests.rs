use super::*;
use crate::{
    config::{CognitiveStoreBackend, SqliteStorageConfig},
    event::Event,
    memory::{postgres::PostgresStore, sqlite::SqliteStore, EventStore, QueryFilter},
};
use sqlx::Executor;
use std::sync::Arc;
use tempfile::TempDir;

fn event(id: &str) -> Event {
    Event::new(
        id.into(),
        "fixture".into(),
        "fixture".into(),
        "test/fence".into(),
        serde_json::Map::new(),
    )
}
async fn open_sqlite(path: &Path) -> sqlx::SqliteConnection {
    sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(false),
    )
    .await
    .unwrap()
}
async fn compatible_sqlite(path: &str) -> SqliteStore {
    SqliteStore::new_for_runtime(
        path,
        &SqliteStorageConfig::default(),
        CognitiveStoreBackend::Legacy,
        true,
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn sqlite_explicit_fence_blocks_live_and_reopened_legacy_writers_but_not_readers() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("runtime.db");
    let old = SqliteStore::new(path.to_str().unwrap()).await.unwrap();
    old.append(event("before")).await.unwrap();
    assert!(!sqlite_status(&path).await.unwrap().installed);
    let mut raw_old = open_sqlite(&path).await;
    sqlx::query("UPDATE events SET actor=actor WHERE id='before'")
        .execute(&mut raw_old)
        .await
        .unwrap();
    let prepared = raw_old
        .prepare("UPDATE events SET actor='changed' WHERE id='before'")
        .await
        .unwrap();
    let backup = temp.path().join("before.db");
    sqlx::query("VACUUM INTO ?")
        .bind(backup.to_str().unwrap())
        .execute(&mut raw_old)
        .await
        .unwrap();
    let current = compatible_sqlite(path.to_str().unwrap()).await;
    let status = install_sqlite(&path).await.unwrap();
    assert!(status.installed && status.protected_tables > 30);
    assert_eq!(
        install_sqlite(&path).await.unwrap().protected_tables,
        status.protected_tables
    );
    assert!(old.append(event("old-live")).await.is_err());
    use sqlx::Statement;
    assert!(prepared.query().execute(&mut raw_old).await.is_err());
    for command in [
        "DELETE FROM events",
        "UPDATE events SET actor='corrupt'",
        "INSERT INTO events SELECT * FROM events",
    ] {
        assert!(
            sqlx::query(command).execute(&mut raw_old).await.is_err(),
            "{command}"
        );
    }
    assert_eq!(old.query(QueryFilter::default()).await.unwrap().len(), 1);
    assert!(SqliteStore::new(path.to_str().unwrap()).await.is_err());
    assert!(sqlx::query("DELETE FROM events")
        .execute(&mut open_sqlite(&path).await)
        .await
        .is_err());
    current.append(event("compatible-live")).await.unwrap();
    drop(current);
    let reopened = compatible_sqlite(path.to_str().unwrap()).await;
    reopened.append(event("compatible-reopen")).await.unwrap();
    let mut direct = open_sqlite(&path).await;
    sqlite_writer(&mut direct, true).await.unwrap();
    assert!(
        sqlx::query(&format!("UPDATE {GUARD} SET min_writer_version=0"))
            .execute(&mut direct)
            .await
            .is_err()
    );
    let restored = SqliteStore::new(backup.to_str().unwrap()).await.unwrap();
    restored.append(event("restored-old-writer")).await.unwrap();
    assert!(!sqlite_status(&backup).await.unwrap().installed);
    assert_eq!(
        reopened.query(QueryFilter::default()).await.unwrap().len(),
        3
    );
}

#[tokio::test]
async fn sqlite_install_is_atomic_and_drift_is_not_silently_repaired() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("atomic.db");
    let _store = SqliteStore::new(path.to_str().unwrap()).await.unwrap();
    let mut raw = open_sqlite(&path).await;
    // A conflicting name makes installation fail part-way through guard creation.
    let conflict = trigger_name("events", "INSERT");
    sqlx::query(&format!(
        "CREATE TRIGGER {} BEFORE INSERT ON events BEGIN SELECT 1; END",
        quoted(&conflict)
    ))
    .execute(&mut raw)
    .await
    .unwrap();
    assert!(install_sqlite(&path).await.is_err());
    assert!(!sqlite_status(&path).await.unwrap().installed);
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_schema WHERE type='trigger' AND name LIKE 'morphz_io_%'",
    )
    .fetch_one(&mut raw)
    .await
    .unwrap();
    assert_eq!(count, 1);
    sqlx::query(&format!("DROP TRIGGER {}", quoted(&conflict)))
        .execute(&mut raw)
        .await
        .unwrap();
    install_sqlite(&path).await.unwrap();
    sqlx::query("CREATE TABLE future_unprotected (id INTEGER)")
        .execute(&mut raw)
        .await
        .unwrap();
    assert!(sqlite_status(&path).await.is_err());
    assert!(SqliteStore::new_for_runtime(
        path.to_str().unwrap(),
        &SqliteStorageConfig::default(),
        CognitiveStoreBackend::Legacy,
        true
    )
    .await
    .is_err());
    assert!(install_sqlite(&path).await.is_err());
}

#[tokio::test]
async fn sqlite_fence_cli_requires_explicit_target_and_write_acknowledgement() {
    use crate::cli::morphz_command;
    for args in [
        vec!["morphz", "storage", "session-io-fence"],
        vec![
            "morphz",
            "storage",
            "session-io-fence",
            "--sqlite",
            "fixture.db",
            "--install",
        ],
        vec![
            "morphz",
            "storage",
            "session-io-fence",
            "--sqlite",
            "fixture.db",
            "--postgres-url-env",
            "FIXTURE_URL",
        ],
    ] {
        assert!(morphz_command().try_get_matches_from(args).is_err());
    }
    let invocation = crate::cli::morphz_command_line_parser_for(crate::i18n::Locale::English)
        .parse([
            "storage",
            "session-io-fence",
            "--sqlite",
            "fixture.db",
            "--install",
            "--acknowledge-write-block",
        ])
        .unwrap();
    assert!(invocation.has_option("install"));
    assert!(invocation.has_option("acknowledge-write-block"));
    assert!(invocation.option("sqlite").is_some());
    let temp = TempDir::new().unwrap();
    let absent = temp.path().join("missing.db");
    assert!(sqlite_status(&absent).await.is_err());
    assert!(install_sqlite(&absent).await.is_err());
    assert!(!absent.exists());
}

#[tokio::test]
async fn sqlite_install_waits_for_old_transaction_then_blocks_its_next_write() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("transaction.db");
    let old = SqliteStore::new(path.to_str().unwrap()).await.unwrap();
    old.append(event("before")).await.unwrap();
    let mut raw = open_sqlite(&path).await;
    let mut transaction = raw.begin_with("BEGIN IMMEDIATE").await.unwrap();
    sqlx::query("UPDATE events SET actor='before-install' WHERE id='before'")
        .execute(&mut *transaction)
        .await
        .unwrap();
    let install_path = path.clone();
    let mut pending = tokio::spawn(async move { install_sqlite(&install_path).await });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), &mut pending)
            .await
            .is_err()
    );
    assert!(!sqlite_status(&path).await.unwrap().installed);
    transaction.commit().await.unwrap();
    assert!(pending.await.unwrap().unwrap().installed);
    assert!(
        sqlx::query("UPDATE events SET actor='after-install' WHERE id='before'")
            .execute(&mut raw)
            .await
            .is_err()
    );
    assert_eq!(
        old.query(QueryFilter::default()).await.unwrap()[0].actor,
        "before-install"
    );
}

#[tokio::test]
#[ignore = "requires a dedicated fresh PostgreSQL test database"]
async fn postgres_explicit_fence_live_connections_atomicity_and_reopen() {
    let url = std::env::var("MORPHZ_SESSION_IO_FENCE_TEST_POSTGRES_URL")
        .expect("fresh test database URL");
    assert!(url
        .rsplit('/')
        .next()
        .unwrap()
        .starts_with("morphz_io_test_fence_"));
    let mut raw = sqlx::PgConnection::connect(&url).await.unwrap();
    let tables: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pg_catalog.pg_tables WHERE schemaname=current_schema()",
    )
    .fetch_one(&mut raw)
    .await
    .unwrap();
    assert_eq!(tables, 0, "fence test must start with a fresh database");
    let old = PostgresStore::new(&url, 2).await.unwrap();
    old.append(event("before")).await.unwrap();
    assert!(!postgres_status(&url).await.unwrap().installed);
    let prepared = raw
        .prepare("UPDATE events SET actor='changed' WHERE id='before'")
        .await
        .unwrap();
    // Force an error after table guards start being created: all DDL must roll back.
    sqlx::query(&format!("CREATE FUNCTION {FUNCTION}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$"))
        .execute(&mut raw).await.unwrap();
    assert!(install_postgres(&url).await.is_err());
    assert!(!postgres_status(&url).await.unwrap().installed);
    sqlx::query(&format!("DROP FUNCTION {FUNCTION}()"))
        .execute(&mut raw)
        .await
        .unwrap();
    let current = PostgresStore::new_for_runtime(
        &url,
        2,
        Arc::new(crate::observability::Observability::default()),
        CognitiveStoreBackend::Legacy,
        true,
    )
    .await
    .unwrap();
    // A legacy transaction completes before the fence's exclusive-lock boundary.
    let mut transaction = raw.begin().await.unwrap();
    sqlx::query("UPDATE events SET actor='before-install' WHERE id='before'")
        .execute(&mut *transaction)
        .await
        .unwrap();
    let install_url = url.clone();
    let mut pending = tokio::spawn(async move { install_postgres(&install_url).await });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), &mut pending)
            .await
            .is_err()
    );
    transaction.commit().await.unwrap();
    let status = pending.await.unwrap().unwrap();
    assert!(status.protected_tables > 30);
    assert_eq!(
        install_postgres(&url).await.unwrap().protected_tables,
        status.protected_tables
    );
    assert!(old.append(event("old-live")).await.is_err());
    use sqlx::Statement;
    assert!(prepared.query().execute(&mut raw).await.is_err());
    for command in [
        "DELETE FROM events",
        "UPDATE events SET actor='corrupt'",
        "INSERT INTO events SELECT * FROM events",
        "TRUNCATE events CASCADE",
    ] {
        assert!(
            sqlx::query(command).execute(&mut raw).await.is_err(),
            "{command}"
        );
    }
    assert_eq!(old.query(QueryFilter::default()).await.unwrap().len(), 1);
    assert!(PostgresStore::new(&url, 2).await.is_err());
    current.append(event("compatible-live")).await.unwrap();
    let connection = current.pool().acquire().await.unwrap();
    connection.close().await.unwrap();
    current
        .append(event("replacement-connection"))
        .await
        .unwrap();
    let restarted = PostgresStore::new_for_runtime(
        &url,
        2,
        Arc::new(crate::observability::Observability::default()),
        CognitiveStoreBackend::Legacy,
        true,
    )
    .await
    .unwrap();
    restarted.append(event("compatible-reopen")).await.unwrap();
    assert_eq!(
        restarted.query(QueryFilter::default()).await.unwrap().len(),
        4
    );
    // Even a compatible connection cannot accidentally lower the marker.
    postgres_writer(&mut raw, true).await.unwrap();
    assert!(
        sqlx::query(&format!("UPDATE {GUARD} SET min_writer_version=0"))
            .execute(&mut raw)
            .await
            .is_err()
    );
    sqlx::query("CREATE TABLE future_unprotected (id INTEGER)")
        .execute(&mut raw)
        .await
        .unwrap();
    assert!(postgres_status(&url).await.is_err());
    assert!(install_postgres(&url).await.is_err());
}
