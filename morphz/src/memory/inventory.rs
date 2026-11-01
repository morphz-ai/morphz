//! Bounded operator metadata pages. HTTP callers independently authorize the
//! Principal and never derive authority from a continuation or cached page.
use super::{CapabilityLeaseRecord, ExecutionNodeRecord, ExecutionTargetRecord};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeInventoryKind {
    Targets,
    Nodes,
    Leases,
    Objectives,
}
#[derive(Debug, Clone)]
pub struct RuntimeInventoryQuery {
    pub kind: RuntimeInventoryKind,
    pub principal_id: String,
    pub context_id: Option<String>,
    pub thread_id: Option<String>,
    pub target_id: Option<String>,
    pub active_only: bool,
    pub cursor: Option<String>,
    pub limit: usize,
}
impl RuntimeInventoryQuery {
    pub fn page_limit(&self) -> usize {
        self.limit.clamp(1, 200)
    }
    pub fn validate(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.principal_id.is_empty() {
            return Err("inventory Principal is required".into());
        }
        super::RuntimeDirectoryQuery {
            cursor: self.cursor.clone(),
            ..Default::default()
        }
        .decoded_cursor()?;
        Ok(())
    }
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RuntimeInventoryPage {
    pub targets: Vec<ExecutionTargetRecord>,
    pub nodes: Vec<ExecutionNodeRecord>,
    pub leases: Vec<CapabilityLeaseRecord>,
    pub objectives: Vec<serde_json::Value>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
}
macro_rules! inventory_query {
 ($db:ty,$request:expr)=>{{(||->Result<sqlx::QueryBuilder<'_,$db>,Box<dyn std::error::Error+Send+Sync>>{
  use crate::memory::inventory::RuntimeInventoryKind::*;
  let request=$request;let key=crate::memory::RuntimeDirectoryQuery{cursor:request.cursor.clone(),..Default::default()}.decoded_cursor()?;
  let sort=if request.kind==Leases {"issued_at"} else {"updated_at"};
  let branches=if request.kind==Targets {2} else {1};
  let mut q=sqlx::QueryBuilder::<$db>::new("SELECT * FROM (");
  for seek in 0..if key.is_some(){2}else{1} {
  for branch in 0..branches {
   if branch>0 || seek>0 {q.push(" UNION ALL ");}
   q.push("SELECT * FROM (SELECT ");
   if request.kind==Objectives {q.push("id,context_id,SUBSTR(stated_objective,1,240) AS stated_objective,status,updated_at");}else{q.push("*");}
   q.push(" FROM ").push(match request.kind {Targets=>"execution_targets",Nodes=>"execution_nodes",Leases=>"capability_leases",Objectives=>"objectives"}).push(" WHERE ");
   match request.kind {
    Targets if branch==0=>{q.push("owner_principal_id IS NULL");},
    Targets|Nodes=>{q.push("owner_principal_id=").push_bind(request.principal_id.clone());},
    Leases=>{q.push("principal_id=").push_bind(request.principal_id.clone());},
    Objectives=>{q.push("1=1");},
   }
   if let Some(id)=request.context_id.as_deref().filter(|_|request.kind==Objectives){q.push(" AND context_id=").push_bind(id);}
   if let Some(id)=request.thread_id.as_deref().filter(|_|request.kind==Leases){q.push(" AND thread_id=").push_bind(id);}
   if let Some(id)=request.target_id.as_deref().filter(|_|request.kind==Leases){q.push(" AND target_id=").push_bind(id);}
   if request.active_only {
    if request.kind==Objectives {q.push(" AND status IN ('active','paused','blocked')");}
    if request.kind==Leases {q.push(" AND status='active' AND expires_at>").push_bind(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos,true));}
   }
   if let Some(key)=key.as_ref(){if seek==0 {q.push(" AND ").push(sort).push(" = ").push_bind(key.sort_at.clone()).push(" AND id > ").push_bind(key.id.clone());}else{q.push(" AND ").push(sort).push(" < ").push_bind(key.sort_at.clone());}}
   q.push(" ORDER BY ").push(sort).push(" DESC,id LIMIT ").push_bind((request.page_limit()+1) as i64).push(") page_branch");
  }}
  q.push(") inventory ORDER BY ").push(sort).push(" DESC,id LIMIT ").push_bind((request.page_limit()+1) as i64);
  Ok(q)
 })()}};
}
pub(crate) use inventory_query;
