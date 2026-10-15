use super::PostgresStore;
crate::memory::terminal::terminal_store!(PostgresStore, sqlx::Postgres, true);

pub(super) async fn migrate(
    pool: &sqlx::PgPool,
) -> Result<(), crate::memory::terminal::TerminalStoreError> {
    let mut tx = pool.begin().await?;
    for statement in crate::memory::terminal::SCHEMA
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        sqlx::query(statement).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}
