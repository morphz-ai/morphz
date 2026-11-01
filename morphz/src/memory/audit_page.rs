//! Stable-ID scalar batches for startup/committed supervision audits.
use super::ThreadActivationRecord;
use crate::scheduler::authority::*;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditSource {
    Objectives,
    Threads,
    Activations,
    Groups,
}
#[derive(Debug, Clone)]
pub struct AuditQuery {
    pub context_id: String,
    pub source: AuditSource,
    pub after: String,
    pub ids: Option<Vec<String>>,
    pub roots: Option<Vec<String>>,
    pub include_terminal: bool,
    pub limit: usize,
}
#[derive(Debug, Clone, Default)]
pub struct AuditPage {
    pub facts: AuthorityFacts,
    pub activations: Vec<ThreadActivationRecord>,
    pub has_more: bool,
    pub next_id: Option<String>,
}
#[derive(Debug, Clone)]
pub struct DependencyTarget {
    pub id: String,
    pub target: String,
}
#[derive(Debug, Clone, Copy)]
pub enum AuditWitness {
    Outcomes,
    PendingObjectives,
    Events,
}
pub(crate) const INDEXES:&[&str]=&[
 "CREATE INDEX IF NOT EXISTS idx_dependency_inspection ON scheduler_dependencies(owner_kind,owner_id,owner_generation,status,required,created_at DESC,id DESC)",
 "CREATE INDEX IF NOT EXISTS idx_audit_objective_live ON objectives(context_id,id) WHERE status IN ('active','paused','blocked')",
 "CREATE INDEX IF NOT EXISTS idx_audit_objective_all ON objectives(context_id,id)",
 "CREATE INDEX IF NOT EXISTS idx_audit_thread_all ON threads(context_id,id)",
 "CREATE INDEX IF NOT EXISTS idx_audit_activation_all ON thread_activations(context_id,id)",
 "CREATE INDEX IF NOT EXISTS idx_audit_activation_live ON thread_activations(context_id,id) WHERE status IN ('queued','running')",
 "CREATE INDEX IF NOT EXISTS idx_audit_group_all ON thread_groups(context_id,id)",
 "CREATE INDEX IF NOT EXISTS idx_audit_group_live ON thread_groups(context_id,id) WHERE status='open'",
 "CREATE INDEX IF NOT EXISTS idx_audit_primary ON threads(context_id,supervisor_kind,supervisor_id,supervision_generation,status,kind,origin_evaluation_id,created_at,id)",
 "CREATE INDEX IF NOT EXISTS idx_audit_pending_group ON scheduler_dependencies(owner_kind,owner_id,id) WHERE status='pending' AND dependency_kind='thread_group'",
 "CREATE INDEX IF NOT EXISTS idx_schedule_wait_time ON schedules(thread_id,status,not_before,id)",
];
macro_rules! audit_query {($db:ty,$request:expr)=>{{(||->Result<sqlx::QueryBuilder<'static,$db>,Box<dyn std::error::Error+Send+Sync>>{
 use crate::memory::audit_page::AuditSource as K;
 let r=$request;let limit=r.limit.clamp(1,200);
 if r.after.len()>512 || r.ids.as_ref().is_some_and(|v|v.len()>200) || r.roots.as_ref().is_some_and(|v|v.len()>200) || (r.roots.is_some()&&r.source!=K::Threads){return Err("audit coordinate exceeds scope".into());}
 let (table,columns,live)=match r.source{
 K::Objectives=>("objectives","id,context_id,coordinator_session_id,generation,status,CASE WHEN wait_condition_json IS NOT NULL THEN 1 ELSE 0 END AS has_legacy_wait","status IN ('active','paused','blocked')"),
 K::Threads=>("threads","id,context_id,session_id,revision,control_state,kind,status,generation,root_turn_id,created_at,supervisor_kind,supervisor_id,supervision_generation,origin_evaluation_id","status='open'"),
 K::Activations=>("thread_activations","*","status IN ('queued','running')"),
 K::Groups=>("thread_groups","id,context_id,session_id,supervisor_kind,supervisor_id,generation,status,required_count,terminal_count,successful_count,barrier_event_id,(SELECT COUNT(*) FROM thread_group_members m WHERE m.group_id=thread_groups.id) AS member_total,(SELECT COUNT(*) FROM thread_group_members m WHERE m.group_id=thread_groups.id AND m.required=TRUE) AS member_required,(SELECT COUNT(*) FROM thread_group_members m WHERE m.group_id=thread_groups.id AND m.required=TRUE AND m.status IN ('completed','failed','cancelled')) AS member_terminal,(SELECT COUNT(*) FROM thread_group_members m WHERE m.group_id=thread_groups.id AND m.required=TRUE AND m.status='completed') AS member_successful","status='open'"),
 };
 let mut q=sqlx::QueryBuilder::<$db>::new("SELECT ");q.push(columns).push(" FROM ").push(table).push(" WHERE context_id=").push_bind(r.context_id.clone());
 if let Some(ids)=&r.ids {if ids.is_empty(){q.push(" AND 1=0");}else{q.push(" AND id IN (");{let mut values=q.separated(",");for id in ids{values.push_bind(id.clone());}}q.push(")");}}
 else if let Some(roots)=&r.roots {if roots.is_empty(){q.push(" AND 1=0");}else{q.push(" AND root_turn_id IN (");{let mut values=q.separated(",");for id in roots{values.push_bind(id.clone());}}q.push(")");}}
 else {if !r.include_terminal{q.push(" AND ").push(live);}q.push(" AND id>").push_bind(r.after.clone());}
 q.push(" ORDER BY id LIMIT ").push_bind((limit+1) as i64);Ok(q)
})()}};}
pub(crate) use audit_query;
macro_rules! authority_row {($row:expr,$source:expr,$facts:expr)=>{{(||->Result<(),Box<dyn std::error::Error+Send+Sync>>{
 use crate::memory::audit_page::AuditSource as K;let r=$row;
 let parse=|field:&str|->Result<serde_json::Value,Box<dyn std::error::Error+Send+Sync>>{Ok(serde_json::Value::String(r.get::<String,_>(field)))};
 match $source{
 K::Objectives=>$facts.objectives.push(crate::scheduler::authority::ObjectiveAuthority{id:r.get("id"),context_id:r.get("context_id"),coordinator_session_id:r.get("coordinator_session_id"),generation:u64::try_from(r.get::<i64,_>("generation"))?,status:serde_json::from_value(parse("status")?)?,has_legacy_wait:r.get::<i32,_>("has_legacy_wait")!=0}),
 K::Threads=>$facts.threads.push(crate::scheduler::authority::ThreadAuthority{id:r.get("id"),context_id:r.get("context_id"),session_id:r.get("session_id"),revision:u64::try_from(r.get::<i64,_>("revision"))?,control_state:serde_json::from_value(parse("control_state")?)?,kind:serde_json::from_value(parse("kind")?)?,lifecycle:serde_json::from_value(parse("status")?)?,generation:u64::try_from(r.get::<i64,_>("generation"))?,root_turn_id:r.get("root_turn_id"),created_at:chrono::DateTime::parse_from_rfc3339(&r.get::<String,_>("created_at"))?.with_timezone(&chrono::Utc),supervision:crate::scheduler::authority::SupervisionAuthority{supervisor_kind:serde_json::from_value(parse("supervisor_kind")?)?,supervisor_id:r.get("supervisor_id"),generation:u64::try_from(r.get::<i64,_>("supervision_generation"))?,origin_evaluation_id:r.get("origin_evaluation_id")}}),
 K::Groups=>$facts.groups.push(crate::scheduler::authority::GroupAuthority{id:r.get("id"),context_id:r.get("context_id"),session_id:r.get("session_id"),supervisor_kind:serde_json::from_value(parse("supervisor_kind")?)?,supervisor_id:r.get("supervisor_id"),generation:u64::try_from(r.get::<i64,_>("generation"))?,status:serde_json::from_value(parse("status")?)?,required_count:u64::try_from(r.get::<i64,_>("required_count"))?,terminal_count:u64::try_from(r.get::<i64,_>("terminal_count"))?,successful_count:u64::try_from(r.get::<i64,_>("successful_count"))?,barrier_event_id:r.get("barrier_event_id"),member_counts:Some(crate::scheduler::domain::GroupMemberCounts{group_id:r.get("id"),total:u64::try_from(r.get::<i64,_>("member_total"))?,required:u64::try_from(r.get::<i64,_>("member_required"))?,terminal:u64::try_from(r.get::<i64,_>("member_terminal"))?,successful:u64::try_from(r.get::<i64,_>("member_successful"))?})}),
 K::Activations=>{},
 }Ok(())
})()}};}
pub(crate) use authority_row;
macro_rules! witness_query {($db:ty,$context:expr,$kind:expr,$ids:expr)=>{{
 use crate::memory::audit_page::AuditWitness as K;
 let mut q=sqlx::QueryBuilder::<$db>::new(match $kind {
 K::Outcomes=>"SELECT t.id,CAST(0 AS BIGINT) AS generation FROM threads t WHERE t.context_id=",
 K::PendingObjectives=>"SELECT o.id,o.generation FROM objectives o WHERE o.context_id=",
 K::Events=>"SELECT id,CAST(0 AS BIGINT) AS generation FROM events WHERE 1=1 AND ",
 });
 if matches!($kind,K::Events){q.push("1=1");}else{q.push_bind($context.to_owned());}
 q.push(" AND id IN (");{let mut values=q.separated(",");for id in $ids{values.push_bind(id.clone());}}q.push(")");
 match $kind {K::Outcomes=>{q.push(" AND EXISTS(SELECT 1 FROM thread_outcomes o WHERE o.thread_id=t.id)");},K::PendingObjectives=>{q.push(" AND EXISTS(SELECT 1 FROM scheduler_dependencies d WHERE d.owner_kind='objective' AND d.owner_id=o.id AND d.owner_generation=o.generation AND d.status='pending' AND d.required=TRUE)");},K::Events=>{}}
 q
}};}
pub(crate) use witness_query;
macro_rules! primary_query {($db:ty,$context:expr,$owners:expr)=>{{
 let mut q=sqlx::QueryBuilder::<$db>::new("");
 for (index,(id,generation)) in $owners.iter().enumerate(){
  if index>0{q.push(" UNION ALL ");}
  let expected=crate::memory::stable_thread_id(&crate::memory::objective_primary_execution_root_id(id,*generation));
  q.push("SELECT ").push_bind(id.clone()).push(" AS id,").push_bind(*generation as i64).push(" AS generation,COALESCE((SELECT id FROM threads WHERE id=").push_bind(expected).push(" AND context_id=").push_bind($context.to_owned()).push(" AND supervisor_kind='objective' AND supervisor_id=").push_bind(id.clone()).push(" AND supervision_generation=").push_bind(*generation as i64).push(" AND status='open' AND kind='execution' AND origin_evaluation_id IS NULL),(SELECT id FROM threads WHERE context_id=").push_bind($context.to_owned()).push(" AND supervisor_kind='objective' AND supervisor_id=").push_bind(id.clone()).push(" AND supervision_generation=").push_bind(*generation as i64).push(" AND status='open' AND kind='execution' AND origin_evaluation_id IS NULL ORDER BY created_at,id LIMIT 1)) AS preserved_id");
 }
 q
}};}
pub(crate) use primary_query;
macro_rules! dependency_query {
    ($db:ty,$context:expr,$owner:expr,$id:expr,$after:expr) => {{
        let kind = $owner;
        let mut q = sqlx::QueryBuilder::<$db>::new(
            "SELECT d.id,d.dependency_id FROM scheduler_dependencies d WHERE d.owner_kind=",
        );
        q.push_bind(kind.to_string())
            .push(" AND d.owner_id=")
            .push_bind($id.to_owned())
            .push(" AND d.status='pending' AND d.dependency_kind='thread_group' AND d.id>")
            .push_bind($after.to_owned())
            .push(" AND EXISTS(SELECT 1 FROM ")
            .push(if kind == "objective" {
                "objectives"
            } else {
                "threads"
            })
            .push(" owner WHERE owner.id=d.owner_id AND owner.context_id=")
            .push_bind($context.to_owned())
            .push(") ORDER BY d.id LIMIT 201");
        q
    }};
}
pub(crate) use dependency_query;
