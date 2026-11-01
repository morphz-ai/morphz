//! Bounded wait metadata for exact, already authorized Thread identities.
//! This does not open Events, Job arguments, Goal text or dependency metadata.
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ThreadWaitHead {
    pub thread_id: String,
    pub generation: u64,
    pub revision: u64,
    pub kinds: Vec<String>,
    pub resources: Vec<String>,
    pub resources_truncated: bool,
    pub until: Option<String>,
}
pub(crate) const INDEX:&str="CREATE INDEX IF NOT EXISTS idx_dependency_wait_head ON scheduler_dependencies(owner_kind,owner_id,owner_generation,status,required,dependency_kind,dependency_id)";
// Every branch is an exact parent/generation/revision seek. Kinds use complete
// indexed EXISTS (ten fixed kinds), resources use an independent 33-key head.
macro_rules! wait_head_query {($db:ty,$context:expr,$owners:expr)=>{{
 let mut q=sqlx::QueryBuilder::<$db>::new("");let mut branch=0;
 for (id,generation,revision) in $owners {
  let mut start=|q:&mut sqlx::QueryBuilder<'static,$db>|{if branch>0{q.push(" UNION ALL ");}branch+=1;};
  start(&mut q);q.push("SELECT t.id AS thread_id,'thread' AS owner,'verified' AS kind,CAST(NULL AS TEXT) AS detail FROM threads t WHERE t.context_id=").push_bind($context.to_owned()).push(" AND t.id=").push_bind(id.clone()).push(" AND t.generation=").push_bind(*generation as i64).push(" AND t.revision=").push_bind(*revision as i64).push(" AND t.status='open' AND t.control_state='active'");
  for owner in ["thread","objective"] {
   for kind in ["thread","thread_group","tool_task","delegation","timer","permission","user_input","external_event","resource","user_input_delivery"] {
    start(&mut q);q.push("SELECT t.id AS thread_id,").push_bind(owner.to_owned()).push(" AS owner,").push_bind(kind.to_owned()).push(" AS kind,CAST(NULL AS TEXT) AS detail FROM threads t WHERE t.context_id=").push_bind($context.to_owned()).push(" AND t.id=").push_bind(id.clone()).push(" AND t.generation=").push_bind(*generation as i64).push(" AND t.revision=").push_bind(*revision as i64).push(" AND t.status='open' AND t.control_state='active' AND EXISTS(SELECT 1 FROM scheduler_dependencies d WHERE d.owner_kind=").push_bind(owner.to_owned());
    if owner=="thread" {q.push(" AND d.owner_id=t.id AND d.owner_generation=t.generation");}
    else {q.push(" AND t.kind='execution' AND t.parent_thread_id IS NULL AND t.supervisor_kind='objective' AND t.origin_evaluation_id IS NULL AND d.owner_id=t.supervisor_id AND d.owner_generation=t.supervision_generation AND EXISTS(SELECT 1 FROM objectives o WHERE o.id=t.supervisor_id AND o.context_id=t.context_id AND o.coordinator_session_id=t.session_id AND o.generation=t.supervision_generation AND o.status='active' AND (o.active_evaluation_id IS NULL OR (o.evaluation_lease_expires_at IS NOT NULL AND o.evaluation_lease_expires_at<=").push_bind(chrono::Utc::now().to_rfc3339()).push(")))");}
    q.push(" AND d.status='pending' AND d.required=TRUE AND d.dependency_kind=").push_bind(if kind=="user_input_delivery"{"user_input"}else{kind}.to_owned());
    if kind=="user_input_delivery" || kind=="user_input" {
        let json=|key:&str|if stringify!($db).contains("Postgres"){format!("d.metadata_json::jsonb->>'{key}'")}else{format!("json_extract(d.metadata_json,'$.{key}')")};
        q.push(if kind=="user_input_delivery" {" AND ("}else{" AND NOT ("}).push("COALESCE(").push(json("source")).push(",'')='request_user_input' AND COALESCE(").push(json("request_event_id")).push(",'')=d.dependency_id AND COALESCE(").push(json("accepted_answer_event_id")).push(",'')<>'')");
    }
    q.push(")");
   }
   start(&mut q);q.push("SELECT * FROM (SELECT ").push_bind(id.clone()).push(" AS thread_id,").push_bind(owner.to_owned()).push(" AS owner,'resource_key' AS kind,SUBSTR(d.dependency_id,1,512) AS detail FROM scheduler_dependencies d WHERE d.owner_kind=").push_bind(owner.to_owned());
   if owner=="thread" {q.push(" AND d.owner_id=").push_bind(id.clone()).push(" AND d.owner_generation=").push_bind(*generation as i64);}
   else {q.push(" AND d.owner_id=(SELECT supervisor_id FROM threads WHERE id=").push_bind(id.clone()).push(") AND d.owner_generation=(SELECT supervision_generation FROM threads WHERE id=").push_bind(id.clone()).push(")");}
   if owner=="objective" {q.push(" AND EXISTS(SELECT 1 FROM threads t JOIN objectives o ON o.id=t.supervisor_id WHERE t.id=").push_bind(id.clone()).push(" AND t.context_id=").push_bind($context.to_owned()).push(" AND t.generation=").push_bind(*generation as i64).push(" AND t.revision=").push_bind(*revision as i64).push(" AND t.kind='execution' AND t.parent_thread_id IS NULL AND t.supervisor_kind='objective' AND t.origin_evaluation_id IS NULL AND o.context_id=t.context_id AND o.coordinator_session_id=t.session_id AND o.generation=t.supervision_generation AND o.status='active' AND (o.active_evaluation_id IS NULL OR (o.evaluation_lease_expires_at IS NOT NULL AND o.evaluation_lease_expires_at<=").push_bind(chrono::Utc::now().to_rfc3339()).push(")))");}
   q.push(" AND d.status='pending' AND d.required=TRUE AND d.dependency_kind='resource' AND EXISTS(SELECT 1 FROM threads t WHERE t.context_id=").push_bind($context.to_owned()).push(" AND t.id=").push_bind(id.clone()).push(" AND t.generation=").push_bind(*generation as i64).push(" AND t.revision=").push_bind(*revision as i64).push(" AND t.status='open' AND t.control_state='active') ORDER BY d.dependency_id LIMIT 33) resource_head");
  }
  for (kind,condition) in [
   ("permission","EXISTS(SELECT 1 FROM execution_jobs j WHERE j.thread_id=t.id AND j.context_id=t.context_id AND j.session_id=t.session_id AND j.status='waiting_approval')"),
   ("timer","EXISTS(SELECT 1 FROM schedules s WHERE s.thread_id=t.id AND s.status='queued' AND s.not_before IS NOT NULL)"),
   ("schedule_resume","EXISTS(SELECT 1 FROM schedules s WHERE s.thread_id=t.id AND s.status='paused') AND NOT EXISTS(SELECT 1 FROM schedules s WHERE s.thread_id=t.id AND s.status='queued')"),
  ] {
   start(&mut q);q.push("SELECT t.id AS thread_id,'thread' AS owner,").push_bind(kind.to_owned()).push(" AS kind,");
   if kind=="timer" {q.push("(SELECT s.not_before FROM schedules s WHERE s.thread_id=t.id AND s.status='queued' AND s.not_before IS NOT NULL ORDER BY s.not_before,s.id LIMIT 1)");}else{q.push("CAST(NULL AS TEXT)");}
   q.push(" AS detail FROM threads t WHERE t.context_id=").push_bind($context.to_owned()).push(" AND t.id=").push_bind(id.clone()).push(" AND t.generation=").push_bind(*generation as i64).push(" AND t.revision=").push_bind(*revision as i64).push(" AND t.status='open' AND t.control_state='active' AND ").push(condition);
  }
 }
 q
}};}
pub(crate) use wait_head_query;
macro_rules! collect_wait_heads {
    ($rows:expr,$owners:expr) => {{
        let mut result = Vec::new();
        for (id, generation, revision) in $owners {
            let rows = $rows
                .iter()
                .filter(|r| r.get::<String, _>("thread_id") == *id)
                .collect::<Vec<_>>();
            if !rows
                .iter()
                .any(|r| r.get::<String, _>("kind") == "verified")
            {
                continue;
            }
            let own = rows.iter().any(|r| {
                r.get::<String, _>("owner") == "thread"
                    && !["resource_key", "verified"].contains(&r.get::<String, _>("kind").as_str())
            });
            let selected = rows
                .iter()
                .filter(|r| r.get::<String, _>("owner") == if own { "thread" } else { "objective" })
                .collect::<Vec<_>>();
            let mut kinds = selected
                .iter()
                .filter_map(|r| {
                    let kind: String = r.get("kind");
                    (!["resource_key", "verified"].contains(&kind.as_str())).then_some(kind)
                })
                .collect::<Vec<_>>();
            kinds.sort();
            kinds.dedup();
            let mut resources = if kinds.iter().any(|k| k == "resource") {
                selected
                    .iter()
                    .filter(|r| r.get::<String, _>("kind") == "resource_key")
                    .filter_map(|r| r.get::<Option<String>, _>("detail"))
                    .collect::<Vec<_>>()
            } else {
                Vec::new()
            };
            let resources_truncated = resources.len() > 32;
            resources.sort();
            resources.dedup();
            resources.truncate(32);
            let until = selected
                .iter()
                .filter(|r| r.get::<String, _>("kind") == "timer")
                .filter_map(|r| r.get::<Option<String>, _>("detail"))
                .min();
            result.push(crate::memory::wait_head::ThreadWaitHead {
                thread_id: id.clone(),
                generation: *generation,
                revision: *revision,
                kinds,
                resources,
                resources_truncated,
                until,
            });
        }
        result
    }};
}
pub(crate) use collect_wait_heads;
