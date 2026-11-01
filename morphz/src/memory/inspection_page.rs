//! Demand-owned children of one exact Thread. Cursors never grant authority.
use super::{ExecutionJobRecord, ScheduleRecord, ThreadActivationRecord, ThreadSignalRecord};
use serde::{Deserialize, Serialize};
type Error = Box<dyn std::error::Error + Send + Sync>;
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThreadInspectionKind {
    Activations,
    Jobs,
    PendingSignals,
    ActivationSignals,
    Schedules,
    ModelEvents,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadInspectionQuery {
    pub kind: ThreadInspectionKind,
    pub activation_id: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Cursor {
    thread_id: String,
    kind: ThreadInspectionKind,
    activation_id: Option<String>,
    clock: String,
    id: String,
}
impl ThreadInspectionQuery {
    pub fn page_limit(&self) -> usize {
        self.limit.unwrap_or(32).clamp(1, 64)
    }
    pub(crate) fn key(&self, thread: &str) -> Result<Option<(String, String)>, Error> {
        use base64::Engine;
        if self
            .activation_id
            .as_ref()
            .is_some_and(|s| s.is_empty() || s.len() > 512)
            || (self.kind == ThreadInspectionKind::ActivationSignals
                && self.activation_id.is_none())
            || (self.activation_id.is_some()
                && !matches!(
                    self.kind,
                    ThreadInspectionKind::Jobs | ThreadInspectionKind::ActivationSignals
                ))
        {
            return Err("invalid inspection scope".into());
        }
        self.cursor
            .as_ref()
            .map(|s| {
                if s.len() > 4096 {
                    return Err("invalid inspection cursor".into());
                }
                let value: Cursor = serde_json::from_slice(
                    &base64::engine::general_purpose::URL_SAFE_NO_PAD
                        .decode(s)
                        .map_err(|_| "invalid inspection cursor")?,
                )
                .map_err(|_| "invalid inspection cursor")?;
                if value.thread_id != thread
                    || value.kind != self.kind
                    || value.activation_id != self.activation_id
                    || value.id.is_empty()
                    || value.id.len() > 512
                    || value.clock.len() > 64
                    || (if matches!(
                        self.kind,
                        ThreadInspectionKind::ActivationSignals | ThreadInspectionKind::ModelEvents
                    ) {
                        value.clock.parse::<u64>().is_err()
                    } else {
                        chrono::DateTime::parse_from_rfc3339(&value.clock).is_err()
                    })
                {
                    return Err("inspection cursor scope changed".into());
                }
                Ok((value.clock, value.id))
            })
            .transpose()
    }
    pub(crate) fn cursor_for(&self, thread: &str, clock: String, id: String) -> String {
        use base64::Engine;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&Cursor {
                thread_id: thread.into(),
                kind: self.kind,
                activation_id: self.activation_id.clone(),
                clock,
                id,
            })
            .expect("typed cursor"),
        )
    }
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ThreadInspectionPage {
    pub activations: Vec<ThreadActivationRecord>,
    #[serde(default, skip_serializing)]
    pub jobs: Vec<ExecutionJobRecord>,
    pub events: Vec<crate::event::Event>,
    pub signals: Vec<ThreadSignalRecord>,
    pub schedules: Vec<ScheduleRecord>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadInspectionContinuation {
    pub kind: ThreadInspectionKind,
    pub activation_id: Option<String>,
    pub next_cursor: String,
}
// Stable created-key ordering permits an exact source/history read without
// ranking the parent's lifetime. All external values are bound parameters.
macro_rules! inspection_query {
 ($db:ty,$thread:expr,$request:expr)=>{{(||->Result<sqlx::QueryBuilder<'static,$db>,Box<dyn std::error::Error+Send+Sync>>{
  use crate::memory::inspection_page::ThreadInspectionKind as K;
  let request=$request;let thread=$thread;let key=request.key(&thread.id)?;
  let mut query=sqlx::QueryBuilder::<$db>::new(match request.kind {
   K::Activations=>"SELECT r.*,r.created_at AS inspection_clock FROM thread_activations r WHERE r.context_id=",
   K::Jobs=>"SELECT r.*,r.created_at AS inspection_clock FROM execution_jobs r WHERE r.context_id=",
   K::PendingSignals=>"SELECT r.*,r.created_at AS inspection_clock FROM thread_signals r JOIN threads t ON t.id=r.thread_id WHERE t.context_id=",
   K::ActivationSignals=>"SELECT r.*,CAST(l.ordinal AS TEXT) AS inspection_clock FROM activation_signals l CROSS JOIN thread_signals r JOIN threads t ON t.id=r.thread_id WHERE r.id=l.signal_id AND t.context_id=",
   K::ModelEvents=>return Err("Model Events use the bounded Event store".into()),
   K::Schedules=>"SELECT r.*,r.created_at AS inspection_clock FROM schedules r JOIN threads t ON t.id=r.thread_id WHERE t.context_id=",
  });
  query.push_bind(thread.context_id.clone());
  if request.kind==K::Activations {query.push(" AND r.root_turn_id=").push_bind(thread.root_turn_id.clone());}
  else {query.push(" AND r.thread_id=").push_bind(thread.id.clone());}
  if let Some(activation)=&request.activation_id {query.push(if request.kind==K::ActivationSignals {" AND l.activation_id="} else {" AND r.activation_id="}).push_bind(activation.clone());}
  if request.kind==K::PendingSignals {query.push(" AND r.status='pending'");}
  let (clock,id)=if request.kind==K::ActivationSignals {("l.ordinal","l.signal_id")}else{("r.created_at","r.id")};
  if let Some((value,id_value))=key {
   query.push(" AND (").push(clock).push(",").push(id).push(") < (");
   if request.kind==K::ActivationSignals {query.push_bind(value.parse::<i64>()?);} else {query.push_bind(value);}
   query.push(",").push_bind(id_value).push(")");
  }
  query.push(" ORDER BY ").push(clock).push(" DESC,").push(id).push(" DESC LIMIT ").push_bind((request.page_limit()+1) as i64);
  Ok(query)
 })()}};
}
pub(crate) use inspection_query;
