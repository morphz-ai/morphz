//! Demand-owned Delegation metadata. Status/role ranges seek before LIMIT.
use super::DelegationRecord;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
type Error = Box<dyn std::error::Error + Send + Sync>;
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DelegationPageQuery {
    pub context_id: Option<String>,
    pub session_id: Option<String>,
    pub include_terminal: bool,
    pub cursor: Option<String>,
    pub limit: usize,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DelegationPage {
    pub delegations: Vec<DelegationRecord>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
    pub bodies_loaded: bool,
}
#[derive(Serialize, Deserialize)]
pub(crate) struct Cursor {
    pub scope: String,
    pub clock: String,
    pub id: String,
}
impl DelegationPageQuery {
    pub fn page_limit(&self) -> usize {
        self.limit.clamp(1, 200)
    }
    fn scope(&self) -> String {
        format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(&self.context_id, &self.session_id, self.include_terminal))
                    .expect("scalar scope")
            )
        )
    }
    pub fn validate(&self) -> Result<(), Error> {
        self.key()?;
        Ok(())
    }
    pub(crate) fn key(&self) -> Result<Option<Cursor>, Error> {
        use base64::Engine;
        if self
            .context_id
            .iter()
            .chain(self.session_id.iter())
            .any(|id| id.is_empty() || id.len() > 512)
        {
            return Err("invalid Delegation scope".into());
        }
        self.cursor
            .as_ref()
            .map(|raw| {
                if raw.len() > 2048 {
                    return Err("invalid Delegation cursor".into());
                }
                let key: Cursor = serde_json::from_slice(
                    &base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(raw)?,
                )?;
                if key.scope != self.scope()
                    || key.id.is_empty()
                    || key.id.len() > 512
                    || key.clock.len() > 64
                    || chrono::DateTime::parse_from_rfc3339(&key.clock).is_err()
                {
                    return Err("Delegation cursor scope changed".into());
                }
                Ok(key)
            })
            .transpose()
    }
    pub(crate) fn cursor_for(&self, clock: String, id: String) -> String {
        use base64::Engine;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&Cursor {
                scope: self.scope(),
                clock,
                id,
            })
            .expect("scalar key"),
        )
    }
}
macro_rules! page_query {($db:ty,$request:expr)=>{{
 (||->Result<sqlx::QueryBuilder<'static,$db>,Box<dyn std::error::Error+Send+Sync>>{
  let r=$request;let key=r.key()?;let fetch=(r.page_limit()+1) as i64;
  let statuses=if r.include_terminal {vec!["queued","running","completed","failed","cancelled"]} else {vec!["queued","running"]};
  let roles=if r.context_id.is_some()||r.session_id.is_some(){vec!["parent","child"]}else{vec![""]};
  let mut q=sqlx::QueryBuilder::<$db>::new("SELECT d.id,d.agent_id,d.parent_context_id,d.parent_session_id,d.child_context_id,d.child_session_id,d.initiating_principal_id,substr(d.task,1,1000) AS task,CAST(NULL AS TEXT) AS success_when,substr(d.context_scope,1,1000) AS context_scope,d.status,d.result_event_id,d.created_at,d.updated_at FROM (SELECT DISTINCT id,updated_at FROM (");let mut ordinal=0;
  for role in roles {for status in &statuses {for equal in if key.is_some(){vec![true,false]}else{vec![false]} {
   if ordinal>0{q.push(" UNION ALL ");}ordinal+=1;
   q.push("SELECT * FROM (SELECT id,updated_at FROM delegations WHERE status=").push_bind((*status).to_owned());
   if let Some(session)=&r.session_id {q.push(" AND ").push(role).push("_session_id=").push_bind(session.clone());
    if let Some(context)=&r.context_id {q.push(" AND (parent_context_id=").push_bind(context.clone()).push(" OR child_context_id=").push_bind(context.clone()).push(")");}
   }else if let Some(context)=&r.context_id {q.push(" AND ").push(role).push("_context_id=").push_bind(context.clone());}
   if let Some(key)=&key {if equal {q.push(" AND updated_at=").push_bind(key.clock.clone()).push(" AND id>").push_bind(key.id.clone());}else{q.push(" AND updated_at<").push_bind(key.clock.clone());}}
   q.push(" ORDER BY updated_at DESC,id LIMIT ").push_bind(fetch).push(") delegation_range");
  }}}
  q.push(") selected_ranges ORDER BY updated_at DESC,id LIMIT ").push_bind(fetch).push(") selected JOIN delegations d ON d.id=selected.id ORDER BY selected.updated_at DESC,selected.id");Ok(q)
 })()
}};}
pub(crate) use page_query;
macro_rules! finish_page {
    ($rows:expr,$request:expr,$decode:expr) => {{
        let mut rows = $rows;
        let request = $request;
        let has_more = rows.len() > request.page_limit();
        rows.truncate(request.page_limit());
        let next_cursor = if has_more {
            rows.last().map(|row| {
                request.cursor_for(sqlx::Row::get(row, "updated_at"), sqlx::Row::get(row, "id"))
            })
        } else {
            None
        };
        let delegations = rows
            .iter()
            .map($decode)
            .collect::<Result<Vec<_>, Box<dyn std::error::Error + Send + Sync>>>()?;
        Ok(crate::memory::delegation_page::DelegationPage {
            delegations,
            has_more,
            next_cursor,
            bodies_loaded: false,
        })
    }};
}
pub(crate) use finish_page;
pub(crate) const INDEXES:&[&str]=&[
 "CREATE INDEX IF NOT EXISTS idx_delegation_page_parent_context ON delegations(parent_context_id,status,updated_at DESC,id)",
 "CREATE INDEX IF NOT EXISTS idx_delegation_page_child_context ON delegations(child_context_id,status,updated_at DESC,id)",
 "CREATE INDEX IF NOT EXISTS idx_delegation_page_parent_session ON delegations(parent_session_id,status,updated_at DESC,id)",
 "CREATE INDEX IF NOT EXISTS idx_delegation_page_child_session ON delegations(child_session_id,status,updated_at DESC,id)",
 "CREATE INDEX IF NOT EXISTS idx_delegation_page_status ON delegations(status,updated_at DESC,id)",
];
