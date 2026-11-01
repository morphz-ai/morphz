//! Operator pending-approval inventory; a cursor is ordering, never authority.
use super::{ApprovalRecord, RuntimeDirectoryQuery};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PendingApprovalRecordsPage {
    pub records: Vec<ApprovalRecord>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovalPageRequest {
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}
impl ApprovalPageRequest {
    pub fn page_limit(&self) -> usize {
        self.limit.unwrap_or(50).clamp(1, 200)
    }
    pub fn validate(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.limit.is_some_and(|limit| limit == 0 || limit > 200) {
            return Err("Approval page limit must be between 1 and 200".into());
        }
        key(self.cursor.as_deref())?;
        Ok(())
    }
}
pub(crate) fn key(
    cursor: Option<&str>,
) -> Result<Option<super::directory::DirectoryCursor>, Box<dyn std::error::Error + Send + Sync>> {
    let query = RuntimeDirectoryQuery {
        cursor: cursor.map(str::to_owned),
        ..Default::default()
    };
    query.validate()?;
    query.decoded_cursor()
}
macro_rules! pending_query {
    ($db:ty,$cursor:expr,$limit:expr) => {{
        (|| -> Result<sqlx::QueryBuilder<'static,$db>,Box<dyn std::error::Error+Send+Sync>> {
            let key=crate::memory::approval_page::key($cursor)?;
            let mut query=sqlx::QueryBuilder::<$db>::new("SELECT * FROM (");
            for (ordinal,status) in ["pending_auto","pending_human"].into_iter().enumerate() {
                if ordinal>0 {query.push(" UNION ALL ");}
                query.push("SELECT * FROM (SELECT * FROM approval_requests WHERE status IN ('pending_auto','pending_human') AND status=").push_bind(status);
                if let Some(key)=&key {query.push(" AND (created_at,id) > (").push_bind(key.sort_at.clone()).push(",").push_bind(key.id.clone()).push(")");}
                query.push(" ORDER BY created_at,id LIMIT ").push_bind(($limit.clamp(1,200)+1) as i64).push(") pending_status_page");
            }
            query.push(") pending_page ORDER BY created_at,id LIMIT ").push_bind(($limit.clamp(1,200)+1) as i64);
            Ok(query)
        })()
    }};
}
pub(crate) use pending_query;

/// Each pending status owns an independently limited index range. Permission
/// predicates are native relations, evaluated before LIMIT; derived keys are
/// only the path into that range.
macro_rules! scoped_query {
    ($db:ty,$context:expr,$authority:expr,$cursor:expr,$fetch:expr) => {{
        (|| -> Result<sqlx::QueryBuilder<'static,$db>,Box<dyn std::error::Error+Send+Sync>> {
            let context:Option<&str>=$context;
            let authority:Option<&crate::memory::ApprovalDecisionAuthority>=$authority;
            if context.is_none()&&authority.is_none(){return Err("An Approval page requires an explicit scope".into());}
            let key=crate::memory::approval_page::key($cursor)?;
            let fetch=$fetch.clamp(1,201) as i64;
            let statuses=if authority.is_some(){vec!["pending_human"]}else{vec!["pending_auto","pending_human"]};
            let mut query=sqlx::QueryBuilder::<$db>::new("SELECT * FROM (");
            for (ordinal,status) in statuses.into_iter().enumerate(){
                if ordinal>0{query.push(" UNION ALL ");}
                query.push("SELECT * FROM (SELECT a.* FROM approval_requests a WHERE a.status=").push_bind(status);
                if let Some(context)=context{
                    query.push(" AND a.directory_context_id=").push_bind(context.to_owned());
                    query.push(" AND EXISTS(SELECT 1 FROM execution_jobs j WHERE j.id=a.job_id AND j.context_id=").push_bind(context.to_owned()).push(")");
                }
                if let Some(authority)=authority{
                    query.push(" AND a.directory_session_id=").push_bind(authority.session_id.clone()).push(" AND a.directory_principal_id=").push_bind(authority.principal_id.clone());
                    query.push(" AND EXISTS(SELECT 1 FROM execution_jobs j JOIN sessions s ON s.id=j.session_id JOIN session_principal_bindings b ON b.session_id=s.id JOIN threads t ON t.id=j.thread_id JOIN thread_activations activation ON activation.id=j.activation_id WHERE j.id=a.job_id AND s.id=").push_bind(authority.session_id.clone()).push(" AND b.principal_id=").push_bind(authority.principal_id.clone()).push(" AND b.unbound_at IS NULL AND j.initiating_principal_id=b.principal_id AND s.status='active' AND j.status='waiting_approval' AND t.status='open' AND activation.status IN ('queued','running'))");
                }
                if let Some(key)=&key{query.push(" AND (a.created_at,a.id)>(").push_bind(key.sort_at.clone()).push(",").push_bind(key.id.clone()).push(")");}
                query.push(" ORDER BY a.created_at,a.id LIMIT ").push_bind(fetch).push(") scope_status_page");
            }
            query.push(") scoped_pending_page ORDER BY created_at,id LIMIT ").push_bind(fetch);Ok(query)
        })()
    }};
}
pub(crate) use scoped_query;
