use super::SqliteStore;
crate::memory::terminal::terminal_store!(SqliteStore, sqlx::Sqlite, false);

pub(super) async fn migrate(
    pool: &sqlx::SqlitePool,
) -> Result<(), crate::memory::terminal::TerminalStoreError> {
    let mut tx = super::begin_immediate_sqlite_transaction(pool).await?;
    for statement in [
        crate::memory::terminal::SCHEMA,
        crate::memory::terminal::COMMAND_SCHEMA,
    ]
    .join(";")
    .split(';')
    .map(str::trim)
    .filter(|s| !s.is_empty())
    {
        sqlx::query(statement).execute(&mut *tx).await?;
    }
    sqlx::query("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES('20261016_01_terminal_sessions',?)").bind(chrono::Utc::now().to_rfc3339()).execute(&mut *tx).await?;
    sqlx::query("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES('20261016_02_terminal_commands',?)").bind(chrono::Utc::now().to_rfc3339()).execute(&mut *tx).await?;
    tx.commit().await?;
    migrate_human(pool).await
}

async fn migrate_human(
    pool: &sqlx::SqlitePool,
) -> Result<(), crate::memory::terminal::TerminalStoreError> {
    use sqlx::Row;
    let mut connection = pool.acquire().await?;
    let columns = sqlx::query("PRAGMA table_info(terminal_sessions)")
        .fetch_all(&mut *connection)
        .await?;
    if columns
        .iter()
        .any(|row| row.get::<String, _>("name") == "scope_ref")
    {
        return Ok(());
    }
    // Rebuild on this one connection, never return it with foreign keys off.
    // Child tables keep their original FK name, rows and receipt identities.
    sqlx::query("PRAGMA foreign_keys=OFF")
        .execute(&mut *connection)
        .await?;
    let result: Result<(), crate::memory::terminal::TerminalStoreError> = async {
        sqlx::query("BEGIN IMMEDIATE").execute(&mut *connection).await?;
        let columns=sqlx::query("PRAGMA table_info(terminal_sessions)").fetch_all(&mut *connection).await?;
        if columns.iter().any(|row|row.get::<String,_>("name")=="scope_ref") {
            sqlx::query("COMMIT").execute(&mut *connection).await?;
            return Ok(());
        }
        sqlx::query(&crate::memory::terminal::human_session_schema("terminal_sessions_human_migration")).execute(&mut *connection).await?;
        sqlx::query("INSERT INTO terminal_sessions_human_migration(id,session_id,context_id,principal_id,root_turn_id,source_job_id,target_id,owner_instance_id,lease_expires_at,revision,status,created_at,record_json,screen_json) SELECT id,session_id,context_id,principal_id,root_turn_id,source_job_id,target_id,owner_instance_id,lease_expires_at,revision,status,created_at,record_json,screen_json FROM terminal_sessions").execute(&mut *connection).await?;
        sqlx::query("DROP TABLE terminal_sessions").execute(&mut *connection).await?;
        sqlx::query("ALTER TABLE terminal_sessions_human_migration RENAME TO terminal_sessions").execute(&mut *connection).await?;
        for statement in crate::memory::terminal::SCHEMA.split(';').filter(|s| s.trim().starts_with("CREATE INDEX")) {
            sqlx::query(statement).execute(&mut *connection).await?;
        }
        sqlx::query(crate::memory::terminal::SCOPE_INDEX).execute(&mut *connection).await?;
        for table in ["terminal_sessions", "terminal_commands"] {
            if !sqlx::query(&format!("PRAGMA foreign_key_check({table})")).fetch_all(&mut *connection).await?.is_empty() { return Err("terminal migration foreign-key check failed".into()); }
        }
        sqlx::query("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES('20261016_03_terminal_human_origin',?)").bind(chrono::Utc::now().to_rfc3339()).execute(&mut *connection).await?;
        sqlx::query("COMMIT").execute(&mut *connection).await?;
        Ok(())
    }.await;
    if result.is_err() {
        let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
    }
    if let Err(error) = sqlx::query("PRAGMA foreign_keys=ON")
        .execute(&mut *connection)
        .await
    {
        connection.close().await?;
        return Err(error.into());
    }
    result
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn terminal_human_migration_preserves_legacy_rows_checkpoints_and_child_receipts() {
        use sqlx::Row;
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for statement in [
            "PRAGMA foreign_keys=ON",
            "CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,applied_at TEXT NOT NULL)",
            "CREATE TABLE sessions(id TEXT PRIMARY KEY)",
            "CREATE TABLE principals(id TEXT PRIMARY KEY)",
            "CREATE TABLE execution_jobs(id TEXT PRIMARY KEY)",
            "CREATE TABLE execution_targets(id TEXT PRIMARY KEY)",
            "INSERT INTO sessions VALUES('session')",
            "INSERT INTO principals VALUES('human')",
            "INSERT INTO execution_jobs VALUES('job')",
            "INSERT INTO execution_targets VALUES('target-default')",
        ] {
            sqlx::query(statement).execute(&pool).await.unwrap();
        }
        for statement in [
            crate::memory::terminal::SCHEMA,
            crate::memory::terminal::COMMAND_SCHEMA,
        ]
        .join(";")
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        {
            sqlx::query(statement).execute(&pool).await.unwrap();
        }
        let original =
            r#"{"id":"legacy","root_turn_id":"real-root","source_job_id":"job","title":"原终端"}"#;
        let screen = r#"{"text":"中文 checkpoint","sequence":12}"#;
        sqlx::query("INSERT INTO terminal_sessions(id,session_id,context_id,principal_id,root_turn_id,source_job_id,target_id,owner_instance_id,lease_expires_at,revision,status,created_at,record_json,screen_json) VALUES('legacy','session','context','human','real-root','job','target-default','owner','later',9,'open','before',?,?)").bind(original).bind(screen).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO terminal_commands VALUES('receipt','legacy','human',8,'original-hash','submitted',9,'before')").execute(&pool).await.unwrap();
        super::migrate(&pool).await.unwrap();
        let row = sqlx::query("SELECT * FROM terminal_sessions WHERE id='legacy'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.get::<String, _>("record_json"), original);
        assert_eq!(row.get::<String, _>("screen_json"), screen);
        assert_eq!(row.get::<String, _>("root_turn_id"), "real-root");
        assert_eq!(row.get::<String, _>("source_job_id"), "job");
        assert_eq!(row.get::<i64, _>("revision"), 9);
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT request_hash FROM terminal_commands WHERE id='receipt'"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            "original-hash"
        );
        sqlx::query("INSERT INTO terminal_sessions(id,session_id,context_id,principal_id,scope_ref,target_id,owner_instance_id,lease_expires_at,revision,status,created_at,record_json) VALUES('direct','session','context','human','human-scope','target-default','owner','later',1,'starting','after','{}')").execute(&pool).await.unwrap();
        super::migrate(&pool).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT scope_ref FROM terminal_sessions WHERE id='direct'"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            "human-scope"
        );
        assert!(sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&pool)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("PRAGMA foreign_keys")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
        assert!(
            sqlx::query("DELETE FROM terminal_sessions WHERE id='legacy'")
                .execute(&pool)
                .await
                .is_err(),
            "receipt foreign key remains enforced after rebuild"
        );
        pool.close().await;
    }
}
