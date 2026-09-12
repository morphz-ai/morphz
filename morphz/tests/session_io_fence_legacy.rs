//! Opt-in real old-binary downgrade probes. Only fresh, dedicated fixtures.
#![cfg(feature = "experimental-session-io")]
use morphz::{
    config::{CognitiveStoreBackend, SqliteStorageConfig},
    memory::sqlite::SqliteStore,
    session_io::fence,
};
use sqlx::{Connection, Row};
use std::{path::Path, process::Output};

fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}
async fn legacy(temp: &Path, config: &Path, pg_url: Option<&str>, target: &str) -> Output {
    let binary =
        std::env::var("MORPHZ_SESSION_IO_LEGACY_BINARY").expect("explicit pre-IO executable");
    let mut command = tokio::process::Command::new(binary);
    command
        .current_dir(temp)
        .env("MORPHZ_HOME", temp.join("host"))
        .env_remove("MORPHZ_EXPERIMENTAL_FEATURES")
        .args([
            "storage",
            "migrate-cognitive-store",
            "--to",
            target,
            "--config-file",
        ])
        .arg(config)
        .args(["--format", "json"]);
    if let Some(url) = pg_url {
        command.env("FENCE_FIXTURE_DATABASE_URL", url);
    }
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        command.kill_on_drop(true).output(),
    )
    .await
    .unwrap()
    .unwrap()
}
async fn current_cli(path: &Path, install: bool, ack: bool) -> Output {
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_morphz"));
    command
        .current_dir(path.parent().unwrap())
        .env("MORPHZ_HOME", path.parent().unwrap().join("host"))
        .args(["storage", "session-io-fence", "--sqlite"])
        .arg(path);
    if install {
        command.arg("--install");
    }
    if ack {
        command.arg("--acknowledge-write-block");
    }
    command.output().await.unwrap()
}
async fn sqlite_snapshot(connection: &mut sqlx::SqliteConnection) -> Vec<(String, Vec<String>)> {
    let tables: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .fetch_all(&mut *connection).await.unwrap();
    let mut snapshot = vec![];
    for table in tables {
        let columns: Vec<String> = sqlx::query("SELECT name FROM pragma_table_info(?)")
            .bind(&table)
            .fetch_all(&mut *connection)
            .await
            .unwrap()
            .iter()
            .map(|row| format!("quote({})", quote(row.get::<&str, _>(0))))
            .collect();
        let rows: Vec<String> = sqlx::query_scalar(&format!(
            "SELECT json_array({}) AS row FROM {} ORDER BY row",
            columns.join(","),
            quote(&table)
        ))
        .fetch_all(&mut *connection)
        .await
        .unwrap();
        snapshot.push((table, rows));
    }
    snapshot
}

#[tokio::test]
#[ignore = "requires MORPHZ_SESSION_IO_LEGACY_BINARY pointing to a verified pre-IO executable"]
async fn real_old_binary_sqlite_write_rejection_preserves_every_table_and_backup_downgrade() {
    let temp = tempfile::TempDir::new().unwrap();
    let path = temp.path().join("runtime.db");
    let config = temp.path().join("runtime.toml");
    std::fs::write(
        &config,
        format!(
            "[storage]\nbackend='sqlite'\ncognitive_store='legacy'\n[storage.sqlite]\npath={}\n",
            serde_json::to_string(path.to_str().unwrap()).unwrap()
        ),
    )
    .unwrap();
    // Prove this exact old executable and command can initialize/write the fixture.
    let before = legacy(temp.path(), &config, None, "legacy").await;
    assert!(
        before.status.success(),
        "{}",
        String::from_utf8_lossy(&before.stderr)
    );
    let status = current_cli(&path, false, false).await;
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    std::fs::create_dir_all(temp.path().join("caller")).unwrap();
    let relative = tokio::process::Command::new(env!("CARGO_BIN_EXE_morphz"))
        .current_dir(temp.path().join("caller"))
        .env("MORPHZ_HOME", temp.path().join("host"))
        .arg("--cwd")
        .arg(temp.path())
        .args(["storage", "session-io-fence", "--sqlite", "runtime.db"])
        .output()
        .await
        .unwrap();
    assert!(
        relative.status.success(),
        "{}",
        String::from_utf8_lossy(&relative.stderr)
    );
    assert_eq!(relative.stdout, status.stdout);
    assert!(
        !serde_json::from_slice::<serde_json::Value>(&status.stdout).unwrap()["installed"]
            .as_bool()
            .unwrap()
    );
    assert!(!current_cli(&path, true, false).await.status.success());
    assert!(!fence::sqlite_status(&path).await.unwrap().installed);
    // Complete the current schema before taking the pre-IO backup.
    drop(
        SqliteStore::new_for_runtime(
            path.to_str().unwrap(),
            &SqliteStorageConfig::default(),
            CognitiveStoreBackend::Legacy,
            true,
        )
        .await
        .unwrap(),
    );
    let mut connection = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(&path),
    )
    .await
    .unwrap();
    let backup = temp.path().join("before.db");
    sqlx::query("VACUUM INTO ?")
        .bind(backup.to_str().unwrap())
        .execute(&mut connection)
        .await
        .unwrap();
    let installed = current_cli(&path, true, true).await;
    assert!(
        installed.status.success(),
        "{}",
        String::from_utf8_lossy(&installed.stderr)
    );
    let snapshot = sqlite_snapshot(&mut connection).await;
    let old = legacy(temp.path(), &config, None, "context_db").await;
    assert!(!old.status.success());
    let error = String::from_utf8_lossy(&old.stderr);
    assert!(
        error.contains("morphz_session_io_writer_version"),
        "{error}"
    );
    assert_eq!(snapshot, sqlite_snapshot(&mut connection).await);
    assert!(fence::sqlite_status(&path).await.unwrap().installed);
    let restore_config = temp.path().join("restore.toml");
    std::fs::write(
        &restore_config,
        format!(
            "[storage]\nbackend='sqlite'\ncognitive_store='legacy'\n[storage.sqlite]\npath={}\n",
            serde_json::to_string(backup.to_str().unwrap()).unwrap()
        ),
    )
    .unwrap();
    let restored = legacy(temp.path(), &restore_config, None, "context_db").await;
    assert!(
        restored.status.success(),
        "{}",
        String::from_utf8_lossy(&restored.stderr)
    );
    assert!(!fence::sqlite_status(&backup).await.unwrap().installed);
}

async fn pg_snapshot(connection: &mut sqlx::PgConnection) -> Vec<(String, Vec<String>)> {
    let tables: Vec<String> = sqlx::query_scalar("SELECT tablename::text FROM pg_catalog.pg_tables WHERE schemaname=current_schema() ORDER BY tablename")
        .fetch_all(&mut *connection).await.unwrap();
    let mut snapshot = vec![];
    for table in tables {
        let rows: Vec<String> = sqlx::query_scalar(&format!(
            "SELECT row_to_json(t)::text AS row FROM {} t ORDER BY row",
            quote(&table)
        ))
        .fetch_all(&mut *connection)
        .await
        .unwrap();
        snapshot.push((table, rows));
    }
    snapshot
}

#[tokio::test]
#[ignore = "requires a verified old executable and a fresh dedicated PostgreSQL database"]
async fn live_old_servers_lose_write_authority_at_explicit_cutover_on_both_backends() {
    use morphz::memory::EventStore;
    let pg_url = std::env::var("MORPHZ_SESSION_IO_LIVE_LEGACY_POSTGRES_URL").unwrap();
    assert!(reqwest::Url::parse(&pg_url)
        .unwrap()
        .path()
        .starts_with("/morphz_io_test_fence_"));
    let mut pg = sqlx::PgConnection::connect(&pg_url).await.unwrap();
    assert!(pg_snapshot(&mut pg).await.is_empty());
    let binary = std::env::var("MORPHZ_SESSION_IO_LEGACY_BINARY").unwrap();
    for postgres in [false, true] {
        let temp = tempfile::TempDir::new().unwrap();
        let path = temp.path().join("live.db");
        let config = temp.path().join("live.toml");
        let storage = if postgres {
            "[storage]\nbackend='postgres'\ncognitive_store='legacy'\n[storage.postgres]\nurl_env='FENCE_FIXTURE_DATABASE_URL'\n".to_string()
        } else {
            format!("[storage]\nbackend='sqlite'\ncognitive_store='legacy'\n[storage.sqlite]\npath={}\n", serde_json::to_string(path.to_str().unwrap()).unwrap())
        };
        std::fs::write(&config, storage).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let log_path = temp.path().join("old-server.log");
        let log = std::fs::File::create(&log_path).unwrap();
        let mut old = tokio::process::Command::new(&binary)
            .current_dir(temp.path())
            .env("MORPHZ_HOME", temp.path().join("host"))
            .env("FENCE_FIXTURE_DATABASE_URL", &pg_url)
            .env("MORPHZ_DASHBOARD_TOKEN", "isolated-fence-test-token")
            .env_remove("MORPHZ_EXPERIMENTAL_FEATURES")
            .args(["serve", "--bind", &address.to_string(), "--config-file"])
            .arg(&config)
            .args(["--log-level", "error"])
            .stdout(log.try_clone().unwrap())
            .stderr(log)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let client = reqwest::Client::new();
        let origin = format!("http://{address}");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            if client
                .get(format!("{origin}/api/status"))
                .bearer_auth("isolated-fence-test-token")
                .send()
                .await
                .is_ok_and(|response| response.status().is_success())
            {
                break;
            }
            assert!(
                old.try_wait().unwrap().is_none() && std::time::Instant::now() < deadline,
                "{}",
                std::fs::read_to_string(&log_path).unwrap()
            );
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        }
        let before = client
            .post(format!("{origin}/api/sessions"))
            .bearer_auth("isolated-fence-test-token")
            .json(&serde_json::json!({"id":"legacy-before","title":"Before explicit cutover"}))
            .send()
            .await
            .unwrap();
        assert!(
            before.status().is_success(),
            "{}",
            before.text().await.unwrap()
        );
        let compatible: Box<dyn EventStore> = if postgres {
            let store = morphz::memory::postgres::PostgresStore::new_for_runtime(
                &pg_url,
                2,
                std::sync::Arc::new(morphz::observability::Observability::default()),
                CognitiveStoreBackend::Legacy,
                true,
            )
            .await
            .unwrap();
            fence::install_postgres(&pg_url).await.unwrap();
            Box::new(store)
        } else {
            let store = SqliteStore::new_for_runtime(
                path.to_str().unwrap(),
                &SqliteStorageConfig::default(),
                CognitiveStoreBackend::Legacy,
                true,
            )
            .await
            .unwrap();
            fence::install_sqlite(&path).await.unwrap();
            Box::new(store)
        };
        compatible
            .append(morphz::event::Event::new(
                "new-writer-live".into(),
                "fixture".into(),
                "fixture".into(),
                "test/fence".into(),
                serde_json::Map::new(),
            ))
            .await
            .unwrap();
        assert!(
            old.try_wait().unwrap().is_none(),
            "the old server must still be running at cutover"
        );
        let after = client
            .post(format!("{origin}/api/sessions"))
            .bearer_auth("isolated-fence-test-token")
            .json(&serde_json::json!({"id":"legacy-after","title":"Must not be persisted"}))
            .send()
            .await
            .unwrap();
        assert!(!after.status().is_success());
        let body = after.text().await.unwrap();
        assert!(
            body.contains("Incompatible Session IO writer")
                || body.contains("morphz_session_io_writer_version"),
            "{body}"
        );
        let count: i64 = if postgres {
            sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE id='legacy-after'")
                .fetch_one(&mut pg)
                .await
                .unwrap()
        } else {
            let mut connection = sqlx::SqliteConnection::connect_with(
                &sqlx::sqlite::SqliteConnectOptions::new().filename(&path),
            )
            .await
            .unwrap();
            sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE id='legacy-after'")
                .fetch_one(&mut connection)
                .await
                .unwrap()
        };
        assert_eq!(count, 0);
        assert!(client
            .get(format!("{origin}/api/sessions"))
            .bearer_auth("isolated-fence-test-token")
            .send()
            .await
            .unwrap()
            .status()
            .is_success());
        old.kill().await.unwrap();
        old.wait().await.unwrap();
    }
}

#[tokio::test]
#[ignore = "requires verified old binary, PostgreSQL tools and a fresh dedicated test database"]
async fn real_old_binary_postgres_write_rejection_preserves_every_table_and_backup_downgrade() {
    let url = std::env::var("MORPHZ_SESSION_IO_LEGACY_TEST_POSTGRES_URL").unwrap();
    let parsed = reqwest::Url::parse(&url).unwrap();
    assert!(parsed.path().starts_with("/morphz_io_test_fence_"));
    let mut connection = sqlx::PgConnection::connect(&url).await.unwrap();
    assert!(
        pg_snapshot(&mut connection).await.is_empty(),
        "must use a fresh test database"
    );
    let temp = tempfile::TempDir::new().unwrap();
    let config = temp.path().join("runtime.toml");
    std::fs::write(&config, "[storage]\nbackend='postgres'\ncognitive_store='legacy'\n[storage.postgres]\nurl_env='FENCE_FIXTURE_DATABASE_URL'\n").unwrap();
    let before = legacy(temp.path(), &config, Some(&url), "legacy").await;
    assert!(
        before.status.success(),
        "{}",
        String::from_utf8_lossy(&before.stderr)
    );
    drop(
        morphz::memory::postgres::PostgresStore::new_for_runtime(
            &url,
            2,
            std::sync::Arc::new(morphz::observability::Observability::default()),
            CognitiveStoreBackend::Legacy,
            true,
        )
        .await
        .unwrap(),
    );
    let tools = std::env::var("MORPHZ_SESSION_IO_POSTGRES_BIN_DIR").unwrap();
    let dump = tokio::process::Command::new(Path::new(&tools).join("pg_dump"))
        .args(["--format=custom", "--no-owner", "--dbname", &url])
        .output()
        .await
        .unwrap();
    assert!(
        dump.status.success(),
        "{}",
        String::from_utf8_lossy(&dump.stderr)
    );
    let backup = temp.path().join("before.dump");
    std::fs::write(&backup, dump.stdout).unwrap();
    fence::install_postgres(&url).await.unwrap();
    let snapshot = pg_snapshot(&mut connection).await;
    let old = legacy(temp.path(), &config, Some(&url), "context_db").await;
    assert!(!old.status.success());
    let error = String::from_utf8_lossy(&old.stderr);
    assert!(error.contains("Incompatible Session IO writer"), "{error}");
    assert_eq!(snapshot, pg_snapshot(&mut connection).await);
    assert!(fence::postgres_status(&url).await.unwrap().installed);
    let restore_name = format!("{}_restore", parsed.path().trim_start_matches('/'));
    sqlx::query(&format!("CREATE DATABASE {}", quote(&restore_name)))
        .execute(&mut connection)
        .await
        .unwrap();
    let mut restored_url = parsed.clone();
    restored_url.set_path(&restore_name);
    let restore = tokio::process::Command::new(Path::new(&tools).join("pg_restore"))
        .args([
            "--exit-on-error",
            "--no-owner",
            "--dbname",
            restored_url.as_str(),
        ])
        .arg(&backup)
        .output()
        .await
        .unwrap();
    assert!(
        restore.status.success(),
        "{}",
        String::from_utf8_lossy(&restore.stderr)
    );
    let restored = legacy(
        temp.path(),
        &config,
        Some(restored_url.as_str()),
        "context_db",
    )
    .await;
    assert!(
        restored.status.success(),
        "{}",
        String::from_utf8_lossy(&restored.stderr)
    );
    assert!(
        !fence::postgres_status(restored_url.as_str())
            .await
            .unwrap()
            .installed
    );
}
