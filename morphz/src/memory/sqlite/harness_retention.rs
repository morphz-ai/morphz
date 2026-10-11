use super::*;

#[async_trait::async_trait]
impl crate::memory::HarnessRetentionStore for SqliteStore {
    async fn required_harnesses(
        &self,
    ) -> Result<Vec<crate::harness::ExactHarnessRef>, Box<dyn std::error::Error + Send + Sync>>
    {
        let rows = sqlx::query(&crate::memory::harness_retention::required_harnesses_sql(
            false,
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
