//! Display-only Job headers. A page never opens physical tool arguments.
use super::{ExecutionJobFilter, ExecutionJobStatus};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobHeader {
    pub id: String,
    pub revision: u64,
    pub activation_id: String,
    pub thread_id: String,
    pub agent_id: String,
    pub context_id: String,
    pub session_id: String,
    pub initiating_principal_id: Option<String>,
    pub target_id: String,
    pub tool_name: String,
    pub tool_call_id: Option<String>,
    pub status: ExecutionJobStatus,
    pub created_at: String,
    pub updated_at: String,
    pub cancel_requested_at: Option<String>,
    pub error: Option<String>,
    pub exit_code: Option<i32>,
    pub result_event_id: Option<String>,
    pub approval_ref: Option<String>,
    pub request_loaded: bool,
}

/// Internal annotation proof, never a replacement physical request. Oversized
/// arguments stay unavailable rather than turning a prefix into valid JSON.
#[derive(Debug, Clone, Default)]
pub struct ProjectionRequest {
    pub request: Option<serde_json::Value>,
    pub bytes_read: usize,
    pub truncated: bool,
}
pub(crate) fn projection_request(
    bytes: Option<Vec<u8>>,
    budget: usize,
) -> Result<ProjectionRequest, Box<dyn std::error::Error + Send + Sync>> {
    let Some(bytes) = bytes else {
        return Ok(ProjectionRequest::default());
    };
    let bytes_read = bytes.len();
    let truncated = bytes_read > budget;
    Ok(ProjectionRequest {
        request: if truncated {
            None
        } else {
            Some(serde_json::from_slice(&bytes)?)
        },
        bytes_read,
        truncated,
    })
}
#[derive(Debug, Clone, Default)]
pub struct JobHeaderPage {
    pub items: Vec<JobHeader>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Cursor {
    scope: String,
    clock: String,
    id: String,
}
fn scope(filter: &ExecutionJobFilter) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&serde_json::json!([
                filter.context_id,
                filter.session_id,
                filter.thread_id,
                filter.thread_ids,
                filter.root_turn_ids,
                filter.visible_principal_id,
                filter.include_legacy_principal
            ]))
            .expect("typed read scope")
        )
    )
}
pub(crate) fn key(
    filter: &ExecutionJobFilter,
    cursor: Option<&str>,
) -> Result<Option<(String, String)>, Box<dyn std::error::Error + Send + Sync>> {
    use base64::Engine;
    if filter.status.is_some()
        || !filter.include_terminal
        || filter.activation_id.is_some()
        || filter.target_id.is_some()
        || filter.tool_name.is_some()
        || filter.context_id.is_none()
        || filter.session_id.is_none()
        || filter.visible_principal_id.is_none()
        || filter.thread_ids.len() > 100
        || filter.root_turn_ids.len() > 32
    {
        return Err("invalid Job header scope".into());
    }
    cursor
        .map(|raw| {
            if raw.len() > 4096 {
                return Err("invalid Job header cursor".into());
            }
            let value: Cursor = serde_json::from_slice(
                &base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(raw)?,
            )?;
            if value.scope != scope(filter)
                || value.id.is_empty()
                || value.id.len() > 512
                || value.clock.len() > 64
                || chrono::DateTime::parse_from_rfc3339(&value.clock).is_err()
            {
                return Err("Job header cursor scope changed".into());
            }
            Ok((value.clock, value.id))
        })
        .transpose()
}
pub(crate) fn finish(
    filter: &ExecutionJobFilter,
    mut items: Vec<JobHeader>,
    limit: usize,
) -> JobHeaderPage {
    use base64::Engine;
    let has_more = items.len() > limit;
    items.truncate(limit);
    let next_cursor = has_more
        .then(|| {
            items.last().map(|item| {
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
                    serde_json::to_vec(&Cursor {
                        scope: scope(filter),
                        clock: item.created_at.clone(),
                        id: item.id.clone(),
                    })
                    .expect("typed header cursor"),
                )
            })
        })
        .flatten();
    JobHeaderPage {
        items,
        has_more,
        next_cursor,
    }
}
// The shared predicate builder is used for headers and full native Jobs. The
// latter remains the authority for controls, annotation proofs and detail.
macro_rules! header_from_row {
    ($row:expr) => {{
        let r = $row;
        crate::memory::job_header::JobHeader {
            id: r.get("id"),
            revision: u64::try_from(r.get::<i64, _>("revision"))?,
            activation_id: r.get("activation_id"),
            thread_id: r.get("thread_id"),
            agent_id: r.get("agent_id"),
            context_id: r.get("context_id"),
            session_id: r.get("session_id"),
            initiating_principal_id: r.get("initiating_principal_id"),
            target_id: r.get("target_id"),
            tool_name: r.get("tool_name"),
            tool_call_id: r.get("tool_call_id"),
            status: serde_json::from_value(serde_json::Value::String(r.get("status")))?,
            created_at: r.get("created_at"),
            updated_at: r.get("updated_at"),
            cancel_requested_at: r.get("cancel_requested_at"),
            error: r.get("error"),
            exit_code: r.get("exit_code"),
            result_event_id: r.get("result_event_id"),
            approval_ref: r.get("approval_ref"),
            request_loaded: false,
        }
    }};
}
pub(crate) use header_from_row;
macro_rules! job_query {
    ($db:ty,$filter:expr,$columns:expr,$before:expr) => {
        crate::memory::job_header::job_query!($db, $filter, $columns, $before, false)
    };
    ($db:ty,$filter:expr,$columns:expr,$before:expr,$legacy:expr) => {{
        let filter = $filter;
        let mut query = sqlx::QueryBuilder::<$db>::new("SELECT ");
        query.push($columns).push(" FROM execution_jobs WHERE 1=1");
        if let Some(context_id) = filter.context_id {
            query.push(" AND context_id = ").push_bind(context_id);
        }
        if let Some(session_id) = filter.session_id {
            query.push(" AND session_id = ").push_bind(session_id);
        }
        if let Some(thread_id) = filter.thread_id {
            query.push(" AND thread_id = ").push_bind(thread_id);
        }
        if !filter.thread_ids.is_empty() {
            query.push(" AND thread_id IN (");
            let mut values = query.separated(", ");
            for id in filter.thread_ids {
                values.push_bind(id);
            }
            values.push_unseparated(")");
        }
        if !filter.root_turn_ids.is_empty() {
            query.push(" AND thread_id IN (SELECT id FROM threads WHERE root_turn_id IN (");
            let mut values = query.separated(", ");
            for id in filter.root_turn_ids {
                values.push_bind(id);
            }
            values.push_unseparated("))");
        }
        if let Some(principal) = filter.visible_principal_id {
            if $legacy {
                query.push(" AND initiating_principal_id IS NULL");
            } else {
                query
                    .push(" AND (initiating_principal_id=")
                    .push_bind(principal);
                if filter.include_legacy_principal {
                    query.push(" OR initiating_principal_id IS NULL");
                }
                query.push(")");
            }
        }
        if let Some(activation_id) = filter.activation_id {
            query.push(" AND activation_id = ").push_bind(activation_id);
        }
        if let Some(target_id) = filter.target_id {
            query.push(" AND target_id = ").push_bind(target_id);
        }
        if let Some(tool_name) = filter.tool_name {
            query.push(" AND tool_name = ").push_bind(tool_name);
        }
        if let Some(status) = filter.status {
            query.push(" AND status = ").push_bind(status.as_str());
        } else if !filter.include_terminal {
            query.push(" AND status IN ('queued', 'waiting_approval', 'running')");
        }

        if let Some((clock, id)) = $before {
            query
                .push(" AND (created_at,id)<(")
                .push_bind(clock)
                .push(",")
                .push_bind(id)
                .push(")");
        }
        if filter.newest_first {
            query.push(" ORDER BY created_at DESC,id DESC");
        } else {
            query.push(" ORDER BY created_at,id");
        }
        if let Some(limit) = filter.limit {
            query.push(" LIMIT ").push_bind(limit as i64);
        }
        query
    }};
}
pub(crate) use job_query;

/// Each authorized Thread/principal range seeks independently before the tiny
/// final key merge. Only the final selected keys open header text columns.
macro_rules! header_query {($db:ty,$filter:expr,$before:expr)=>{{
 let original=$filter;let before=$before;
 let mut query=sqlx::QueryBuilder::<$db>::new("SELECT ");
 // Column names are static, never supplied by a client.
 for (index,column) in ["id","revision","activation_id","thread_id","agent_id","context_id","session_id","initiating_principal_id","target_id","tool_name","tool_call_id","status","created_at","updated_at","cancel_requested_at","error","exit_code","result_event_id","approval_ref"].iter().enumerate(){
  if index>0{query.push(",");}if *column=="error"{query.push("SUBSTR(source.error,1,1024) AS error");}else if *column=="tool_call_id"{query.push("CASE WHEN LENGTH(source.tool_call_id)<=512 THEN source.tool_call_id ELSE NULL END AS tool_call_id");}else{query.push("source.").push(*column);}
 }
 query.push(" FROM (");
 let thread_scopes=if original.thread_ids.is_empty(){vec![original.thread_id.clone()]}else{original.thread_ids.iter().map(|id|Some(id.clone())).collect::<Vec<_>>()};
 let mut branch=0;
 for thread in thread_scopes {for legacy in 0..if original.include_legacy_principal{2}else{1} {
  if branch>0{query.push(" UNION ALL ");}branch+=1;
  query.push("SELECT * FROM (SELECT id,created_at FROM execution_jobs WHERE context_id=").push_bind(original.context_id.clone().unwrap()).push(" AND session_id=").push_bind(original.session_id.clone().unwrap());
  if let Some(thread)=&thread {query.push(" AND thread_id=").push_bind(thread.clone());}
  if legacy==1{query.push(" AND initiating_principal_id IS NULL");}else{query.push(" AND initiating_principal_id=").push_bind(original.visible_principal_id.clone().unwrap());}
  if !original.root_turn_ids.is_empty(){query.push(" AND thread_id IN (SELECT id FROM threads WHERE context_id=").push_bind(original.context_id.clone().unwrap()).push(" AND session_id=").push_bind(original.session_id.clone().unwrap()).push(" AND root_turn_id IN (");{let mut values=query.separated(",");for root in &original.root_turn_ids{values.push_bind(root.clone());}}query.push("))");}
  if let Some((clock,id))=&before {query.push(" AND (created_at,id)<(").push_bind(clock.clone()).push(",").push_bind(id.clone()).push(")");}
  query.push(" ORDER BY created_at DESC,id DESC LIMIT ").push_bind(original.limit.unwrap_or(101) as i64).push(") job_range");
 }}
 query.push(" ORDER BY created_at DESC,id DESC LIMIT ").push_bind(original.limit.unwrap_or(101) as i64).push(") selected");
 if stringify!($db).contains("Postgres"){query.push(" CROSS JOIN LATERAL (SELECT * FROM execution_jobs native WHERE native.id=selected.id LIMIT 1) source");}else{query.push(" CROSS JOIN execution_jobs source WHERE source.id=selected.id");}
 query.push(" ORDER BY selected.created_at DESC,selected.id DESC");query
}};}
pub(crate) use header_query;
pub(crate) const HEADER_INDEXES:&[&str]=&[
 "CREATE INDEX IF NOT EXISTS idx_job_thread_reader_page ON execution_jobs(thread_id,initiating_principal_id,created_at DESC,id DESC)",
 "CREATE INDEX IF NOT EXISTS idx_binding_live_session_principal ON session_principal_bindings(session_id,principal_id) WHERE unbound_at IS NULL",
];
