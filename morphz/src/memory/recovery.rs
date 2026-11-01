//! Bounded startup recovery locators, not another execution authority.
#[derive(Debug, Clone, Copy)]
pub enum TransferProjectionSource {
    OpenThreads,
    LiveActivations,
}
#[derive(Debug, Clone)]
pub struct TransferProjectionCandidate {
    pub cursor_id: String,
    pub thread_id: String,
    pub job_id: Option<String>,
}
macro_rules! transfer_query {
 ($db:ty,$source:expr,$after:expr,$limit:expr,$postgres:expr)=>{{
  use crate::memory::TransferProjectionSource;
  let mut query=sqlx::QueryBuilder::<$db>::new(match $source {
   TransferProjectionSource::OpenThreads=>"SELECT t.id AS cursor_id,t.id AS thread_id,t.executor_id AS job_id FROM threads t WHERE t.status='open'",
   TransferProjectionSource::LiveActivations=>if $postgres {
    "SELECT a.id AS cursor_id,t.id AS thread_id,t.executor_id AS job_id FROM thread_activations a CROSS JOIN LATERAL (SELECT th.id,th.executor_id,th.executor_kind FROM threads th WHERE th.root_turn_id=a.root_turn_id LIMIT 1) t WHERE a.status IN ('queued','running')"
   }else{
    "SELECT a.id AS cursor_id,t.id AS thread_id,t.executor_id AS job_id FROM thread_activations a CROSS JOIN threads t WHERE a.status IN ('queued','running') AND t.root_turn_id=a.root_turn_id"
   },
  });
  query.push(" AND t.executor_kind='artifact_transfer' AND ")
    .push(match $source {TransferProjectionSource::OpenThreads=>"t.id",TransferProjectionSource::LiveActivations=>"a.id"})
    .push(" > ").push_bind($after.to_owned())
    .push(" ORDER BY cursor_id LIMIT ").push_bind(($limit.clamp(1,200)+1) as i64);
  query
 }};
}
pub(crate) use transfer_query;
