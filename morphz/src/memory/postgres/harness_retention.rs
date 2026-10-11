use super::*;

#[async_trait::async_trait]
impl crate::memory::HarnessRetentionStore for PostgresStore {
    async fn required_harnesses(&self) -> Result<Vec<crate::harness::ExactHarnessRef>, StoreError> {
        let rows = sqlx::query(&crate::memory::harness_retention::required_harnesses_sql(
            true,
        ))
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(crate::harness::ExactHarnessRef {
                    id: row.try_get("harness_id")?,
                    version: row.try_get("harness_version")?,
                })
            })
            .collect()
    }
}
