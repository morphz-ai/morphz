//! Regression coverage for test-only SQLite file ownership. These tests use the
//! same SQLx WAL connection/pool lifecycle as SqliteStore without initializing
//! the unrelated Runtime or changing production journal/pool settings.

#[path = "support/temp_sqlite.rs"]
mod temp_sqlite;

use libsqlite3_hotbundle as _;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use temp_sqlite::TempSqliteDb;

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

async fn open_wal(path: &Path) -> SqlitePool {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal);
    let pool = SqlitePoolOptions::new()
        .max_connections(2)
        .connect_with(options)
        .await
        .unwrap();
    sqlx::query("CREATE TABLE fixture (id INTEGER PRIMARY KEY, content TEXT)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO fixture(content) VALUES ('owned temporary data')")
        .execute(&pool)
        .await
        .unwrap();
    assert!(sidecar(path, "-wal").metadata().unwrap().len() > 0);
    assert!(sidecar(path, "-shm").is_file());
    pool
}

#[test]
fn private_database_path_is_created_and_never_reused() {
    let first = TempSqliteDb::new().unwrap();
    let second = TempSqliteDb::new().unwrap();
    let ordinary_file = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(ordinary_file.path(), "unrelated user-like fixture").unwrap();
    assert_ne!(first.path(), second.path());
    assert_eq!(first.path().metadata().unwrap().len(), 0);
    let first_root = first.path().parent().unwrap().to_owned();
    drop(first);
    assert!(!first_root.exists());
    assert!(
        second.path().exists(),
        "another fixture must remain untouched"
    );
    assert_eq!(
        std::fs::read_to_string(ordinary_file.path()).unwrap(),
        "unrelated user-like fixture",
        "database cleanup must not scan/delete adjacent temporary files"
    );
}

#[test]
fn removes_database_and_sidecars_after_runtime_shutdown() {
    let database = TempSqliteDb::new().unwrap();
    let root = database.path().parent().unwrap().to_owned();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let pool = runtime.block_on(open_wal(database.path()));
    // SQLx close is async. This order intentionally exercises tests that end
    // their async runtime while a store clone still owns its pool.
    drop(runtime);
    drop(pool);
    drop(database);
    assert!(
        !root.exists(),
        "temporary WAL/SHM must not outlive their fixture"
    );
}

#[test]
fn removes_complete_database_directory_during_panic_unwind() {
    let database = TempSqliteDb::new().unwrap();
    let root = database.path().parent().unwrap().to_owned();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let pool = runtime.block_on(open_wal(database.path()));
    drop(runtime);
    drop(pool);
    let outcome = std::panic::catch_unwind(move || {
        let _database = database;
        panic!("simulated assertion failure after writing SQLite");
    });
    assert!(outcome.is_err());
    assert!(
        !root.exists(),
        "a failing test must not strand its database files"
    );
}

#[tokio::test]
async fn retains_database_for_reopen_and_cleans_after_explicit_pool_close() {
    let database = TempSqliteDb::new().unwrap();
    let root = database.path().parent().unwrap().to_owned();
    let pool = open_wal(database.path()).await;
    pool.close().await;
    let reopened = SqlitePoolOptions::new()
        .connect_with(SqliteConnectOptions::new().filename(database.path()))
        .await
        .unwrap();
    let content: String = sqlx::query_scalar("SELECT content FROM fixture")
        .fetch_one(&reopened)
        .await
        .unwrap();
    assert_eq!(content, "owned temporary data");
    reopened.close().await;
    drop(database);
    assert!(!root.exists());
}

// POSIX permits unlinking a database whose connection is still alive. This is
// precisely why NamedTempFile appears to clean up successfully on macOS/Linux
// while leaving WAL/SHM behind. Windows locks the open files instead.
#[cfg(unix)]
#[tokio::test]
async fn counterfactual_main_file_only_cleanup_leaks_live_sidecars() {
    let scope = tempfile::tempdir().unwrap();
    let main_file = tempfile::NamedTempFile::new_in(scope.path()).unwrap();
    let path = main_file.path().to_owned();
    let pool = open_wal(&path).await;
    drop(main_file);
    assert!(!path.exists());
    assert!(sidecar(&path, "-wal").exists());
    assert!(sidecar(&path, "-shm").exists());
    // The counterfactual itself owns a directory and explicitly closes its
    // connections, so proving the old bug does not create another leak.
    pool.close().await;
    scope.close().unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn directory_ownership_removes_sidecars_even_with_a_retained_pool_clone() {
    let database = TempSqliteDb::new().unwrap();
    let root = database.path().parent().unwrap().to_owned();
    let pool = open_wal(database.path()).await;
    let retained_pool = pool.clone();
    drop(pool);
    drop(database);
    assert!(
        !root.exists(),
        "an async pool clone must not strand named WAL/SHM files after fixture drop"
    );
    retained_pool.close().await;
    assert!(
        !root.exists(),
        "connection shutdown must not recreate the directory"
    );
}
