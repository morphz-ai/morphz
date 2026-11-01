//! Metadata pages for navigation. A page never reads seed/Mind/Event payloads.
pub(crate) mod approval_index;
pub(crate) mod binding_agent;
pub(crate) mod index;
pub(crate) mod priority;
pub(crate) mod schedule_index;
#[cfg(test)]
pub(crate) mod tests;
use super::{AgentRecord, CognitiveContextRecord, SessionRecord};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeDirectoryKind {
    Agents,
    Contexts,
    #[default]
    Sessions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeDirectoryQuery {
    pub kind: RuntimeDirectoryKind,
    pub include_archived: bool,
    /// Stable ID seek for bounded startup/maintenance batches. HTTP pickers
    /// retain activity order and do not expose this recovery selector.
    #[serde(default)]
    pub identity_order: bool,
    pub cursor: Option<String>,
    pub limit: usize,
    pub principal_id: Option<String>,
    pub context_id: Option<String>,
    pub agent_id: Option<String>,
    pub ids: Option<Vec<String>>,
}

impl Default for RuntimeDirectoryQuery {
    fn default() -> Self {
        Self {
            kind: RuntimeDirectoryKind::Sessions,
            include_archived: false,
            identity_order: false,
            cursor: None,
            limit: 50,
            principal_id: None,
            context_id: None,
            agent_id: None,
            ids: None,
        }
    }
}

impl RuntimeDirectoryQuery {
    pub fn page_limit(&self) -> usize {
        self.limit.clamp(1, 200)
    }
    pub fn validate(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self
            .cursor
            .as_ref()
            .is_some_and(|cursor| cursor.is_empty() || cursor.len() > 2048)
        {
            return Err("invalid directory cursor".into());
        }
        if self.kind != RuntimeDirectoryKind::Sessions
            && (self.principal_id.is_some() || self.context_id.is_some())
        {
            return Err("Session scope cannot authorize another directory".into());
        }
        if self.ids.as_ref().is_some_and(|ids| {
            ids.len() > self.page_limit()
                || ids.len() > 50
                || ids.iter().any(|id| id.is_empty() || id.len() > 512)
                || self.cursor.is_some()
        }) {
            return Err("invalid metadata point selection".into());
        }
        self.decoded_cursor()?;
        if self.kind == RuntimeDirectoryKind::Agents && self.agent_id.is_some() {
            return Err("Agent scope cannot authorize the Agent directory".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct DirectoryCursor {
    pub sort_at: String,
    pub id: String,
}
impl DirectoryCursor {
    pub(crate) fn encode(&self) -> String {
        use base64::Engine;
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(self).expect("directory key is serializable"))
    }
}
impl RuntimeDirectoryQuery {
    pub(crate) fn decoded_cursor(
        &self,
    ) -> Result<Option<DirectoryCursor>, Box<dyn std::error::Error + Send + Sync>> {
        use base64::Engine;
        self.cursor
            .as_ref()
            .map(|cursor| {
                if cursor.is_empty() || cursor.len() > 2048 {
                    return Err("invalid directory cursor".into());
                }
                let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .decode(cursor)
                    .map_err(|_| "invalid directory cursor")?;
                let key: DirectoryCursor =
                    serde_json::from_slice(&raw).map_err(|_| "invalid directory cursor")?;
                if key.id.is_empty()
                    || key.id.len() > 512
                    || key.sort_at.len() > 64
                    || chrono::DateTime::parse_from_rfc3339(&key.sort_at).is_err()
                {
                    return Err("invalid directory cursor".into());
                }
                Ok(key)
            })
            .transpose()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RuntimeDirectoryPage {
    pub agents: Vec<AgentRecord>,
    pub contexts: Vec<CognitiveContextRecord>,
    pub sessions: Vec<SessionRecord>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
}

impl RuntimeDirectoryPage {
    pub(crate) fn finish(
        &mut self,
        kind: RuntimeDirectoryKind,
        limit: usize,
        cursor: Option<String>,
    ) {
        macro_rules! finish {
            ($rows:expr) => {{
                self.has_more = $rows.len() > limit;
                $rows.truncate(limit);
                self.next_cursor = if self.has_more { cursor.clone() } else { None };
            }};
        }
        match kind {
            RuntimeDirectoryKind::Agents => finish!(self.agents),
            RuntimeDirectoryKind::Contexts => finish!(self.contexts),
            RuntimeDirectoryKind::Sessions => finish!(self.sessions),
        }
    }
}

// Both backends execute this same selection. Kind is a typed whitelist; all
// external IDs/cursors remain bound parameters. The Principal-leading seek
// checks ownership before fetching Session metadata, rather than paging all
// Sessions and filtering unauthorized rows in memory.
macro_rules! directory_filters {
    ($query:expr,$request:expr,$alias:expr) => {{
        let request = $request;
        if !request.include_archived {
            $query.push(" AND ").push($alias).push(".status='active'");
        }
        if let Some(context) = request.context_id.as_deref() {
            $query
                .push(" AND ")
                .push($alias)
                .push(".context_id=")
                .push_bind(context);
        }
        if let Some(agent) = request.agent_id.as_deref() {
            $query
                .push(" AND ")
                .push($alias)
                .push(".agent_id=")
                .push_bind(agent);
        }
        if let Some(ids) = request.ids.as_ref().filter(|ids| !ids.is_empty()) {
            $query.push(" AND ").push($alias).push(".id IN (");
            {
                let mut list = $query.separated(",");
                for id in ids {
                    list.push_bind(id.as_str());
                }
            }
            $query.push(")");
        }
    }};
}
pub(crate) use directory_filters;
macro_rules! directory_query {
    ($db:ty,$request:expr,$postgres:expr)=>{{(||->Result<sqlx::QueryBuilder<'_,$db>,Box<dyn std::error::Error+Send+Sync>>{
        use crate::memory::RuntimeDirectoryKind;
        let request=$request;
        let cursor=request.decoded_cursor()?;
        let principal=request.kind==RuntimeDirectoryKind::Sessions && request.principal_id.is_some();
        let sort=if principal {"b.directory_activity_at"} else if request.kind==RuntimeDirectoryKind::Sessions {"d.last_activity_at"} else {"d.updated_at"};
        let id=if principal {"b.session_id"} else {"d.id"};
        let mut query=sqlx::QueryBuilder::<$db>::new("SELECT * FROM (");
        for range in 0..if cursor.is_some() && !request.identity_order {2}else{1} {
        if range>0 {query.push(" UNION ALL ");}
        query.push("SELECT * FROM (");
        query.push(match request.kind {
            RuntimeDirectoryKind::Agents=>"SELECT d.id,d.title,d.status,d.root_context_id,d.created_at,d.updated_at,",
            RuntimeDirectoryKind::Contexts=>"SELECT d.id,d.agent_id,d.title,d.status,d.created_at,d.updated_at,d.seed_context_id,d.seed_context_version,d.seed_snapshot_hash,NULL AS seed_projection,d.requested_hard_token_limit,d.token_budget_revision,",
            RuntimeDirectoryKind::Sessions=>"SELECT d.id,d.agent_id,d.context_id,d.parent_session_id,d.title,d.status,d.model_alias,d.reasoning_effort,d.permission_mode,d.sandbox_mode,d.default_target_id,d.context_sharing,d.created_at,d.updated_at,d.last_activity_at,",
        });
        if request.kind==RuntimeDirectoryKind::Sessions {
            query.push(if $postgres {"d.attention_state,d.attention_revision,d.attention_reason,d.attention_changed_at,d.attention_event_id,"}
                else {"sm.attention_state,sm.attention_revision,sm.attention_reason,sm.attention_changed_at,sm.attention_event_id,"});
        }
        query.push(if request.identity_order {"d.created_at"}else{sort}).push(" AS directory_sort_at FROM ");
        if principal {
            query.push("session_principal_bindings b");
            if $postgres {
                query.push(" CROSS JOIN LATERAL (SELECT sd.* FROM sessions sd WHERE sd.id=b.session_id LIMIT 1) d");
            } else {
                query.push(" CROSS JOIN sessions d JOIN session_mounts sm ON sm.session_id=d.id AND sm.unmounted_at IS NULL");
            }
            query.push(" WHERE b.principal_id=").push_bind(request.principal_id.as_deref().unwrap())
                .push(" AND b.unbound_at IS NULL AND b.directory_activity_at IS NOT NULL");
            if !$postgres {query.push(" AND d.id=b.session_id");}
            if !request.include_archived {query.push(" AND b.directory_status='active'");}
            if let Some(context)=request.context_id.as_deref() {query.push(" AND b.directory_context_id=").push_bind(context);}
            if let Some(agent)=request.agent_id.as_deref(){query.push(" AND b.directory_agent_id=").push_bind(agent);}
        } else {
            query.push(match request.kind {RuntimeDirectoryKind::Agents=>"agents d",RuntimeDirectoryKind::Contexts=>"cognitive_contexts d",RuntimeDirectoryKind::Sessions=>"sessions d"});
            if request.kind==RuntimeDirectoryKind::Sessions && !$postgres {query.push(" JOIN session_mounts sm ON sm.session_id=d.id AND sm.unmounted_at IS NULL");}
            query.push(" WHERE 1=1");
        }
        if let Some(cursor)=cursor.as_ref() {
            if request.identity_order {query.push(" AND ").push(id).push(" > ").push_bind(cursor.id.clone());}
            else if range==0 {query.push(" AND ").push(sort).push(" = ").push_bind(cursor.sort_at.clone()).push(" AND ").push(id).push(" > ").push_bind(cursor.id.clone());}
            else {query.push(" AND ").push(sort).push(" < ").push_bind(cursor.sort_at.clone());}
        }
        crate::memory::directory::directory_filters!(query,request,"d");
        if request.identity_order {query.push(" ORDER BY ").push(id);}
        else {query.push(" ORDER BY ").push(sort).push(" DESC,").push(id);}
        query.push(" LIMIT ").push_bind((request.page_limit()+1) as i64);
        query.push(") seek_page");
        }
        query.push(if request.identity_order {") directory_page ORDER BY id LIMIT "} else {") directory_page ORDER BY directory_sort_at DESC,id LIMIT "}).push_bind((request.page_limit()+1) as i64);
        Ok(query)
    })()}};
}
pub(crate) use directory_query;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CursorPage<T> {
    pub items: Vec<T>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
}

// Shared by the production overview reader and its plan regression. Counting
// Context activity in a correlated pre-sort must not be reintroduced here.
macro_rules! recent_contexts_query {
 ($db:ty,$archived:expr,$limit:expr)=>{{
  let mut query=sqlx::QueryBuilder::<$db>::new("SELECT c.id,c.agent_id,c.title,c.status,c.created_at,c.updated_at,c.seed_context_id,c.seed_context_version,c.seed_snapshot_hash,NULL AS seed_projection,c.requested_hard_token_limit,c.token_budget_revision FROM cognitive_contexts c");
  if !$archived {query.push(" WHERE c.status='active'");}
  query.push(" ORDER BY c.directory_activity_at DESC,c.id LIMIT ").push_bind(($limit).min(200) as i64);
  query
 }};
}
pub(crate) use recent_contexts_query;

macro_rules! terminal_thread_query {
 ($db:ty,$context:expr,$cursor:expr,$limit:expr)=>{{(||->Result<sqlx::QueryBuilder<'static,$db>,Box<dyn std::error::Error+Send+Sync>>{
  let request=crate::memory::RuntimeDirectoryQuery{cursor:$cursor.clone(),..Default::default()};let key=request.decoded_cursor()?;let limit=$limit.clamp(1,200);
  let mut query=sqlx::QueryBuilder::<$db>::new("SELECT * FROM (");
  for range in 0..if key.is_some(){2}else{1} {
   if range>0 {query.push(" UNION ALL ");}
   query.push("SELECT * FROM (SELECT * FROM threads WHERE context_id=").push_bind($context.to_string()).push(" AND status IN ('completed','failed','cancelled')");
   if let Some(key)=&key {if range==0 {query.push(" AND updated_at=").push_bind(key.sort_at.clone()).push(" AND id>").push_bind(key.id.clone());}else{query.push(" AND updated_at<").push_bind(key.sort_at.clone());}}
   query.push(" ORDER BY updated_at DESC,id LIMIT ").push_bind((limit+1) as i64).push(") terminal_range");
  }
  query.push(") terminal_heads ORDER BY updated_at DESC,id LIMIT ").push_bind((limit+1) as i64);Ok(query)
 })()}};
}
pub(crate) use terminal_thread_query;
