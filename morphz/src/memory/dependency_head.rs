//! Complete wait predicates and small, independently bounded identity heads.
//! The directory never opens dependency metadata or question bodies.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DependencyHead {
    pub owner_kind: String,
    pub owner_id: String,
    pub generation: u64,
    pub revision: u64,
    pub pending: bool,
    pub kinds: Vec<String>,
    pub resources: Vec<String>,
    pub resources_truncated: bool,
    pub question: Option<QuestionLocator>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionLocator {
    pub request_id: String,
    pub thread_id: String,
    pub thread_generation: u64,
}

macro_rules! dependency_head_query {
    ($db:ty,$context:expr,$owners:expr) => {{
        let mut q = sqlx::QueryBuilder::<$db>::new("");
        for (i,(kind,id,generation,revision)) in $owners.iter().enumerate() {
            if i>0 {q.push(" UNION ALL ");}
            let table=if kind=="objective" {"objectives"} else {"threads"};
            q.push("SELECT p.id,").push_bind(kind.clone()).push(" AS owner_kind,p.generation,p.revision,");
            let json=|key:&str| if stringify!($db).contains("Postgres") {
                format!("d.metadata_json::jsonb->>'{key}'")
            } else {format!("json_extract(d.metadata_json,'$.{key}')")};
            for (j,wait) in ["pending","thread","thread_group","tool_task","delegation","timer","permission","user_input","external_event","resource","user_input_delivery"].iter().enumerate() {
                if j>0 {q.push(",");}
                q.push("EXISTS(SELECT 1 FROM scheduler_dependencies d WHERE d.owner_kind=").push_bind(kind.clone()).push(" AND d.owner_id=p.id AND d.owner_generation=p.generation AND d.status='pending' AND d.required=TRUE");
                if *wait!="pending" {
                    q.push(" AND d.dependency_kind=").push_bind(if *wait=="user_input_delivery" {"user_input"} else {wait}.to_string());
                }
                if ["user_input","user_input_delivery"].contains(wait) {
                    q.push(if *wait=="user_input" {" AND NOT ("} else {" AND ("});
                    q.push("COALESCE(").push(json("source")).push(",'')='request_user_input' AND COALESCE(").push(json("request_event_id")).push(",'')=d.dependency_id AND COALESCE(").push(json("accepted_answer_event_id")).push(",'')<>'')");
                }
                q.push(") AS wait_").push(*wait);
            }
            q.push(" FROM ").push(table).push(" p WHERE p.context_id=").push_bind($context.to_owned()).push(" AND p.id=").push_bind(id.clone()).push(" AND p.generation=").push_bind(*generation as i64).push(" AND p.revision=").push_bind(*revision as i64);
        }
        q
    }};
}
pub(crate) use dependency_head_query;

// A separate child head is never interpreted as the complete dependency set.
// Two question identities detect the invalid multiple-current-request case.
macro_rules! dependency_identity_query {
    ($db:ty,$context:expr,$owners:expr) => {{
        let mut q=sqlx::QueryBuilder::<$db>::new("");let mut branch=0;
        for (kind,id,generation,revision) in $owners {
            let table=if kind=="objective" {"objectives"} else {"threads"};
            for resource in [true,false] {
                if branch>0 {q.push(" UNION ALL ");}branch+=1;
                q.push("SELECT * FROM (SELECT d.owner_kind,d.owner_id,d.dependency_kind,d.dependency_id,");
                for (i,key) in ["source","request_event_id","thread_id","thread_generation","accepted_answer_event_id"].iter().enumerate() {
                    if i>0 {q.push(",");}
                    if resource {q.push("CAST(NULL AS TEXT)");}
                    else if stringify!($db).contains("Postgres") {q.push("d.metadata_json::jsonb->>'").push(*key).push("'");}
                    else {q.push("CAST(json_extract(d.metadata_json,'$.").push(*key).push("') AS TEXT)");}
                    q.push(" AS meta_").push(*key);
                }
                q.push(" FROM scheduler_dependencies d WHERE d.owner_kind=").push_bind(kind.clone()).push(" AND d.owner_id=").push_bind(id.clone()).push(" AND d.owner_generation=").push_bind(*generation as i64).push(" AND d.status='pending' AND d.required=TRUE AND d.dependency_kind=").push_bind(if resource {"resource"} else {"user_input"}.to_owned()).push(" AND EXISTS(SELECT 1 FROM ").push(table).push(" p WHERE p.id=d.owner_id AND p.context_id=").push_bind($context.to_owned()).push(" AND p.generation=d.owner_generation AND p.revision=").push_bind(*revision as i64).push(") ORDER BY d.dependency_id,d.id LIMIT ").push(if resource {"33"} else {"2"}).push(") identity_head");
            }
        }
        q
    }};
}
pub(crate) use dependency_identity_query;

macro_rules! collect_dependency_heads {
    ($rows:expr,$identities:expr) => {{
        let mut result = Vec::new();
        for row in &$rows {
            let owner_kind: String = row.get("owner_kind");
            let owner_id: String = row.get("id");
            let selected = $identities
                .iter()
                .filter(|v| {
                    v.get::<String, _>("owner_id") == owner_id
                        && v.get::<String, _>("owner_kind") == owner_kind
                })
                .collect::<Vec<_>>();
            let resources = selected
                .iter()
                .filter(|v| v.get::<String, _>("dependency_kind") == "resource")
                .map(|v| v.get::<String, _>("dependency_id"))
                .collect::<Vec<_>>();
            let resources_truncated = resources.len() > 32;
            let mut resources = resources
                .into_iter()
                .take(32)
                .map(|v| v.chars().take(512).collect::<String>())
                .collect::<Vec<_>>();
            resources.sort();
            resources.dedup();
            let questions = selected
                .iter()
                .filter(|v| v.get::<String, _>("dependency_kind") == "user_input")
                .collect::<Vec<_>>();
            let question = if questions.len() == 1 {
                let v = questions[0];
                let request_id: String = v.get("dependency_id");
                let source: Option<String> = v.get("meta_source");
                let event: Option<String> = v.get("meta_request_event_id");
                let thread: Option<String> = v.get("meta_thread_id");
                let generation: Option<String> = v.get("meta_thread_generation");
                let accepted: Option<String> = v.get("meta_accepted_answer_event_id");
                match (thread, generation.and_then(|n| n.parse::<u64>().ok())) {
                    (Some(thread_id), Some(thread_generation))
                        if source.as_deref() == Some("request_user_input")
                            && event.as_deref() == Some(&request_id)
                            && accepted.as_deref().is_none_or(str::is_empty)
                            && thread_generation > 0
                            && !thread_id.is_empty()
                            && thread_id.len() <= 512
                            && request_id.len() <= 512 =>
                    {
                        Some(crate::memory::dependency_head::QuestionLocator {
                            request_id,
                            thread_id,
                            thread_generation,
                        })
                    }
                    _ => None,
                }
            } else {
                None
            };
            let kinds = [
                "thread",
                "thread_group",
                "tool_task",
                "delegation",
                "timer",
                "permission",
                "user_input",
                "external_event",
                "resource",
                "user_input_delivery",
            ]
            .into_iter()
            .filter(|kind| row.get::<bool, _>(format!("wait_{kind}").as_str()))
            .map(str::to_string)
            .collect();
            result.push(crate::memory::dependency_head::DependencyHead {
                owner_kind,
                owner_id,
                generation: row.get::<i64, _>("generation") as u64,
                revision: row.get::<i64, _>("revision") as u64,
                pending: row.get("wait_pending"),
                kinds,
                resources,
                resources_truncated,
                question,
            });
        }
        result
    }};
}
pub(crate) use collect_dependency_heads;
