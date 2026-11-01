//! Commit-visible, indexed locator pages. Locators never contain Event bodies.
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct EventTailCursor {
    pub sequence: u64,
    /// Transactions invisible to an earlier PostgreSQL read snapshot can later
    /// commit below its sequence head. Keep exact transaction seeks, not a
    /// historical overlap scan or a global writer lock.
    pub transactions: Vec<PendingTransaction>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PendingTransaction {
    pub id: u64,
    pub after: u64,
}
#[derive(Clone, Debug)]
pub struct EventLocator {
    pub id: String,
    pub sequence: u64,
}
#[derive(Clone, Debug)]
pub struct EventTailPage {
    pub records: Vec<EventLocator>,
    pub next: EventTailCursor,
    pub has_more: bool,
}
pub(crate) fn validate(
    cursor: &EventTailCursor,
    limit: usize,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if limit == 0 || limit > 1000 || cursor.transactions.len() > 1024 {
        return Err("Event tail exceeds its locator budget".into());
    }
    Ok(())
}

impl From<u64> for EventTailCursor {
    fn from(sequence: u64) -> Self {
        Self {
            sequence,
            transactions: Vec::new(),
        }
    }
}

// A collapsed Thread owns a title preview, never the original input body.
macro_rules! input_previews {
 ($db:ty,$pool:expr,$context:expr,$ids:expr,$postgres:expr)=>{{
  let context=$context;let ids=$ids;
  if ids.len()>200 || ids.iter().any(|id:&String|id.is_empty()||id.len()>512) {return Err("invalid Event preview points".into());}
  let mut result=Vec::new();
  for chunk in ids.chunks(50) {
   let extract=if $postgres {"CASE WHEN jsonb_typeof(payload->'intent')='string' THEN payload->>'intent' WHEN jsonb_typeof(payload->'task')='string' THEN payload->>'task' WHEN jsonb_typeof(payload->'text')='string' THEN payload->>'text' END"}else{"CASE WHEN json_type(payload,'$.intent')='text' THEN json_extract(payload,'$.intent') WHEN json_type(payload,'$.task')='text' THEN json_extract(payload,'$.task') WHEN json_type(payload,'$.text')='text' THEN json_extract(payload,'$.text') END"};
   let mut q=sqlx::QueryBuilder::<$db>::new("SELECT id,substr(");q.push(extract).push(",1,1000) AS preview FROM events WHERE id IN (");
   {let mut values=q.separated(",");for id in chunk {values.push_bind(id.clone());}}
   q.push(") AND (context_id=").push_bind(context.to_owned()).push(" OR (context_id IS NULL AND ").push(if $postgres {"payload->>'context_id'"}else{"json_extract(payload,'$.context_id')"}).push("=").push_bind(context.to_owned()).push("))");
   for row in q.build().fetch_all($pool).await? {if let Some(text)=sqlx::Row::get::<Option<String>,_>(&row,"preview") {result.push((sqlx::Row::get::<String,_>(&row,"id"),text));}}
  }Ok(result)
 }};
}
pub(crate) use input_previews;
