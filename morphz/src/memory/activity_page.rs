//! One demand-owned current-work collection. A continuation is a scoped
//! read coordinate, never a source of permission or lifecycle authority.
use super::{ObjectiveRecord, ScheduleRecord, ThreadRecord};
use serde::{Deserialize, Serialize};
type Error = Box<dyn std::error::Error + Send + Sync>;
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActivityCollection {
    Threads,
    Objectives,
    Schedules,
}
#[derive(Debug, Clone)]
pub struct ActivityPageQuery {
    pub context_id: String,
    pub collection: ActivityCollection,
    pub include_terminal: bool,
    pub cursor: Option<String>,
    pub limit: usize,
    pub metadata_only: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ActivityCursor {
    pub context_id: String,
    pub collection: ActivityCollection,
    pub include_terminal: bool,
    pub clock: String,
    pub id: String,
    pub bucket: i64,
}
impl ActivityPageQuery {
    pub fn limit(&self) -> usize {
        self.limit.clamp(1, 200)
    }
    pub(crate) fn key(&self) -> Result<Option<ActivityCursor>, Error> {
        use base64::Engine;
        self.cursor
            .as_ref()
            .map(|raw| {
                if raw.is_empty() || raw.len() > 4096 {
                    return Err("invalid activity cursor".into());
                }
                let key: ActivityCursor = serde_json::from_slice(
                    &base64::engine::general_purpose::URL_SAFE_NO_PAD
                        .decode(raw)
                        .map_err(|_| "invalid activity cursor")?,
                )
                .map_err(|_| "invalid activity cursor")?;
                if key.context_id != self.context_id
                    || key.collection != self.collection
                    || key.include_terminal != self.include_terminal
                    || key.id.is_empty()
                    || key.id.len() > 512
                    || key.clock.len() > 64
                    || chrono::DateTime::parse_from_rfc3339(&key.clock).is_err()
                    || !(0..=1).contains(&key.bucket)
                    || (self.collection == ActivityCollection::Schedules
                        && !self.include_terminal
                        && key.bucket != 0)
                {
                    return Err("activity cursor scope changed".into());
                }
                Ok(key)
            })
            .transpose()
    }
    pub(crate) fn cursor_for(&self, clock: String, id: String, bucket: i64) -> String {
        use base64::Engine;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&ActivityCursor {
                context_id: self.context_id.clone(),
                collection: self.collection,
                include_terminal: self.include_terminal,
                clock,
                id,
                bucket,
            })
            .expect("typed cursor"),
        )
    }
}
#[derive(Debug, Clone, Default)]
pub struct ActivityPage {
    pub threads: Vec<ThreadRecord>,
    pub objectives: Vec<ObjectiveRecord>,
    pub schedules: Vec<ScheduleRecord>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
}

// Select bounded ordering keys before opening the selected records. Separate
// exact status and equal/older ranges avoid a lifetime IN/sort before LIMIT.
macro_rules! activity_page_query {
 ($db:ty,$request:expr)=>{{(||->Result<sqlx::QueryBuilder<'static,$db>,Box<dyn std::error::Error+Send+Sync>> {
    use crate::memory::activity_page::ActivityCollection as K;
    let request=$request;let key=request.key()?;let count=(request.limit()+1) as i64;
    let (table,statuses):(&str,Vec<Option<&str>>)=match request.collection {
        K::Threads=>("threads",if request.include_terminal {vec![Some("open"),Some("completed"),Some("failed"),Some("cancelled")]}else{vec![Some("open")]}),
        K::Objectives=>("objectives",vec![None]),
        K::Schedules=>("schedules",vec![None]),
    };
    let mut q=sqlx::QueryBuilder::<$db>::new("SELECT ");
    if request.metadata_only {q.push(crate::memory::activity_page::metadata_columns(request.collection,stringify!($db).contains("Postgres")));}else{q.push("source.*");}
    q.push(" FROM (");
    let mut branch=0;
    for status in statuses {
      let buckets=if request.collection==K::Schedules && request.include_terminal {2}else{1};
      for bucket in 0..buckets {
       if key.as_ref().is_some_and(|k|request.collection==K::Schedules && bucket<k.bucket) {continue;}
       let seek=key.as_ref().filter(|k|request.collection!=K::Schedules || k.bucket==bucket);
       for range in 0..if seek.is_some(){2}else{1} {
        if branch>0 {q.push(" UNION ALL ");}branch+=1;
        q.push("SELECT * FROM (SELECT r.id,r.updated_at,").push(if request.collection==K::Schedules {"r.directory_bucket"}else{"0"}).push(" AS page_bucket FROM ").push(table).push(" r");
        if request.collection==K::Schedules {
          if stringify!($db).contains("Postgres") {
            q.push(" CROSS JOIN LATERAL (SELECT id FROM threads native WHERE native.id=r.thread_id AND native.context_id=").push_bind(request.context_id.clone()).push(" LIMIT 1) scope WHERE r.directory_context_id=").push_bind(request.context_id.clone());
          }else{
            q.push(" CROSS JOIN threads native WHERE native.id=r.thread_id AND native.context_id=").push_bind(request.context_id.clone()).push(" AND r.directory_context_id=").push_bind(request.context_id.clone());
          }
          q.push(" AND r.directory_bucket=").push_bind(bucket);
          if !request.include_terminal {q.push(" AND r.status IN ('queued','paused')");}
        }else{q.push(" WHERE r.context_id=").push_bind(request.context_id.clone());}
        if request.collection==K::Objectives && !request.include_terminal {q.push(" AND r.status IN ('active','paused','blocked')");}
        if let Some(status)=status {q.push(" AND r.status='").push(status).push("'");}
        if let Some(key)=seek {
          if range==0 {q.push(" AND r.updated_at=").push_bind(key.clock.clone()).push(" AND r.id>").push_bind(key.id.clone());}
          else {q.push(" AND r.updated_at<").push_bind(key.clock.clone());}
        }
        q.push(" ORDER BY r.updated_at DESC,r.id LIMIT ").push_bind(count).push(") activity_range");
       }
      }
    }
    q.push(" ORDER BY page_bucket,updated_at DESC,id LIMIT ").push_bind(count).push(") selected");
    if stringify!($db).contains("Postgres") {
        q.push(" CROSS JOIN LATERAL (SELECT * FROM ").push(table).push(" native WHERE native.id=selected.id LIMIT 1) source");
    } else {q.push(" CROSS JOIN ").push(table).push(" source WHERE source.id=selected.id");}
    q.push(" ORDER BY selected.page_bucket,selected.updated_at DESC,selected.id");
    Ok(q)
 })()}};
}
pub(crate) use activity_page_query;

/// A shared live-status range avoids ranking the whole Goal lifetime before
/// the page limit. This read index never changes an original Goal field.
pub(crate) const LIVE_GOAL_INDEX: &str = "CREATE INDEX IF NOT EXISTS idx_activity_objective_live_recent ON objectives(context_id,updated_at DESC,id) WHERE status IN ('active','paused','blocked')";

/// Text previews are explicitly marked by SchedulerDetailBounds.bodies_loaded.
/// These rows are read models only. Commands always re-read native authority.
pub(crate) fn metadata_columns(kind: ActivityCollection, postgres: bool) -> String {
    let (columns,preview)=match kind {
  ActivityCollection::Objectives=>("model_alias,reasoning_effort,id,agent_id,context_id,coordinator_session_id,delivery_session_id,parent_objective_id,source_event_id,initiating_principal_id,revision,generation,status,active_evaluation_id,evaluation_lease_expires_at,continuation_sequence,token_budget,tokens_used,time_used_seconds,created_at,updated_at","SUBSTR(source.stated_objective,1,1000) AS stated_objective,SUBSTR(source.status_reason,1,1000) AS status_reason,CAST(NULL AS TEXT) AS wait_condition_json,CAST(NULL AS TEXT) AS completion_intent_json"),
  ActivityCollection::Threads=>("response_annotations,model_alias,reasoning_effort,id,revision,generation,agent_id,context_id,session_id,initiating_principal_id,root_turn_id,kind,status,control_state,executor_kind,executor_id,target_id,lifetime,supervisor_kind,supervisor_id,supervision_generation,origin_evaluation_id,parent_thread_id,thread_group_id,result_event_id,delivery_status,delivery_event_id,created_at,updated_at","CAST(NULL AS TEXT) AS result_text,CAST('null' AS TEXT) AS completion_contract_json"),
  ActivityCollection::Schedules=>("reasoning_effort,id,revision,thread_id,source_turn_id,model_alias,status,not_before,interval_seconds,dependency_thread_ids_json,created_at,updated_at,directory_bucket","SUBSTR(source.intent,1,1000) AS intent"),
 };
    let result = format!(
        "{},{}",
        columns
            .split(',')
            .map(|name| format!("source.{name}"))
            .collect::<Vec<_>>()
            .join(","),
        preview
    );
    if postgres {
        result
            .replace(
                "CAST('null' AS TEXT) AS completion_contract_json",
                "CAST('null' AS JSONB) AS completion_contract_json",
            )
            .replace(
                "CAST(NULL AS TEXT) AS wait_condition_json",
                "CAST(NULL AS JSONB) AS wait_condition_json",
            )
            .replace(
                "CAST(NULL AS TEXT) AS completion_intent_json",
                "CAST(NULL AS JSONB) AS completion_intent_json",
            )
    } else {
        result
    }
}
