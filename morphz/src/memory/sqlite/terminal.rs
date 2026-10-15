use super::SqliteStore;
crate::memory::terminal::terminal_store!(SqliteStore, sqlx::Sqlite, false);

pub(super) async fn migrate(
    pool: &sqlx::SqlitePool,
) -> Result<(), crate::memory::terminal::TerminalStoreError> {
    let mut tx = super::begin_immediate_sqlite_transaction(pool).await?;
    for statement in crate::memory::terminal::SCHEMA
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        sqlx::query(statement).execute(&mut *tx).await?;
    }
    sqlx::query("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES('20261016_01_terminal_sessions',?)").bind(chrono::Utc::now().to_rfc3339()).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
