//! The same transaction/ownership assertions run against both production DBs.
macro_rules! lifecycle {
    ($store:expr) => {{
        use crate::memory::{RuntimeDirectoryKind, RuntimeDirectoryQuery, SessionDirectoryStore};
        let store=$store;
        let request=RuntimeDirectoryQuery{kind:RuntimeDirectoryKind::Sessions,principal_id:Some("dir-human-a".into()),context_id:Some("dir-a".into()),limit:7,..Default::default()};
        sqlx::query("UPDATE sessions SET last_activity_at='2099-01-01T00:00:00.100Z' WHERE id='s-0002'").execute(&store.pool).await.unwrap();
        assert_eq!(store.read_runtime_directory_page(request.clone()).await.unwrap().sessions[0].id,"s-0002");
        let clock:String=sqlx::query_scalar("SELECT directory_activity_at FROM cognitive_contexts WHERE id='dir-a'").fetch_one(&store.pool).await.unwrap();
        assert_eq!(clock,"2099-01-01T00:00:00.100Z");
        let source:String=sqlx::query_scalar("SELECT updated_at FROM cognitive_contexts WHERE id='dir-a'").fetch_one(&store.pool).await.unwrap();
        assert_eq!(source,"2026-11-01T01:02:03.100Z","derived activity never rewrites authoritative Context time");
        let mut tx=store.pool.begin().await.unwrap();
        sqlx::query("UPDATE sessions SET last_activity_at='2098-01-01T00:00:00Z' WHERE id='s-0002'").execute(&mut *tx).await.unwrap();
        let projected:String=sqlx::query_scalar("SELECT directory_activity_at FROM session_principal_bindings WHERE session_id='s-0002' AND principal_id='dir-human-a'").fetch_one(&mut *tx).await.unwrap();
        assert_eq!(projected,"2098-01-01T00:00:00Z");
        tx.rollback().await.unwrap();
        let clock:String=sqlx::query_scalar("SELECT directory_activity_at FROM cognitive_contexts WHERE id='dir-a'").fetch_one(&store.pool).await.unwrap();
        assert_eq!(clock,"2099-01-01T00:00:00.100Z","both indexes roll back with the source transaction");
        sqlx::query("UPDATE session_principal_bindings SET unbound_at='2099-01-01T00:00:01Z' WHERE session_id='s-0002' AND principal_id='dir-human-a'").execute(&store.pool).await.unwrap();
        assert!(!store.read_runtime_directory_page(request.clone()).await.unwrap().sessions.iter().any(|row|row.id=="s-0002"));
        sqlx::query("UPDATE session_principal_bindings SET unbound_at=NULL WHERE session_id='s-0002' AND principal_id='dir-human-a'").execute(&store.pool).await.unwrap();
        assert_eq!(store.read_runtime_directory_page(request.clone()).await.unwrap().sessions[0].id,"s-0002");
        sqlx::query("UPDATE sessions SET status='archived' WHERE id='s-0002'").execute(&store.pool).await.unwrap();
        assert!(!store.read_runtime_directory_page(request.clone()).await.unwrap().sessions.iter().any(|row|row.id=="s-0002"));
        sqlx::query("UPDATE sessions SET status='active',context_id='dir-b' WHERE id='s-0002'").execute(&store.pool).await.unwrap();
        assert!(!store.read_runtime_directory_page(request.clone()).await.unwrap().sessions.iter().any(|row|row.id=="s-0002"));
        let moved=RuntimeDirectoryQuery{context_id:Some("dir-b".into()),..request.clone()};
        assert_eq!(store.read_runtime_directory_page(moved).await.unwrap().sessions[0].id,"s-0002");
        let old_clock:String=sqlx::query_scalar("SELECT directory_activity_at FROM cognitive_contexts WHERE id='dir-a'").fetch_one(&store.pool).await.unwrap();
        assert_ne!(old_clock,"2099-01-01T00:00:00.100Z");
        sqlx::query("DELETE FROM sessions WHERE id='s-0002'").execute(&store.pool).await.unwrap();
        let clock:String=sqlx::query_scalar("SELECT directory_activity_at FROM cognitive_contexts WHERE id='dir-b'").fetch_one(&store.pool).await.unwrap();
        assert_ne!(clock,"2099-01-01T00:00:00.100Z","deleting the newest Session recomputes only its Context");
    }};
}
pub(crate) use lifecycle;

macro_rules! related_pages {
    ($db:ty,$store:expr) => {{
        use crate::memory::{SessionDirectoryStore,ThreadGroupStore,EventStore,RuntimeInventoryKind,RuntimeInventoryQuery};
        let store=$store;
        // Retained Events without derived causal columns still need exact,
        // scoped metadata lookup; they must not turn into an empty history.
        sqlx::query(r#"INSERT INTO events(id,timestamp,actor,type,topic,payload) VALUES ('metadata-legacy','2026-11-01T00:00:00Z','TEST','test','chat/user_message','{"context_id":"dir-a","session_id":"s-0004"}')"#).execute(&store.pool).await.unwrap();
        assert_eq!(store.event_session_points("dir-a",&["metadata-legacy".into(),"missing".into()]).await.unwrap(),vec!["s-0004".to_string()]);
        assert!(store.event_session_points("dir-b",&["metadata-legacy".into()]).await.unwrap().is_empty());
        assert!(store.event_session_points("dir-a",&vec!["metadata-legacy".to_string();501]).await.is_err());
        let mut preview=sqlx::QueryBuilder::<$db>::new("INSERT INTO events(id,timestamp,actor,type,topic,payload) VALUES ('metadata-preview','2026-11-01T00:00:00Z','TEST','test','chat/user_message',");
        preview.push_bind(sqlx::types::Json(serde_json::json!({"context_id":"dir-a","text":"x".repeat(1024*1024)}))).push(")");preview.build().execute(&store.pool).await.unwrap();
        let previews=store.event_input_previews("dir-a",&["metadata-preview".into()]).await.unwrap();assert_eq!(previews[0].1.len(),1000);assert!(store.event_input_previews("dir-b",&["metadata-preview".into()]).await.unwrap().is_empty());

        let mut tx=store.pool.begin().await.unwrap();
        for i in 0..85 {
            let id=format!("group-page-thread-{i:04}");
            let mut q=sqlx::QueryBuilder::<$db>::new("INSERT INTO threads(id,kind,agent_id,context_id,session_id,root_turn_id,status,executor_kind,created_at,updated_at) VALUES (");
            q.push_bind(id.clone()).push(",'execution','dir-agent','dir-a','s-0004',").push_bind(format!("root-{id}")).push(",'completed','test','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')");q.build().execute(&mut *tx).await.unwrap();
        }
        sqlx::query("INSERT INTO thread_groups(id,revision,context_id,session_id,supervisor_kind,supervisor_id,generation,policy,required_count,terminal_count,successful_count,status,created_at,updated_at) VALUES ('paged-group',1,'dir-a','s-0004','runtime','test',1,'all',85,85,85,'satisfied','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')").execute(&mut *tx).await.unwrap();
        for i in 0..85 {
            let mut q=sqlx::QueryBuilder::<$db>::new("INSERT INTO thread_group_members(group_id,thread_id,ordinal,required,status,created_at,updated_at) VALUES ('paged-group',");q.push_bind(format!("group-page-thread-{i:04}")).push(",").push_bind(i as i64).push(",TRUE,").push_bind(if i==84 {"pending"}else{"completed"}).push(",'2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')");q.build().execute(&mut *tx).await.unwrap();
        }
        for principal in [Some("dir-human-a"),Some("dir-human-b"),None] {for i in 0..55 {
            let id=format!("target-page-{}-{i:04}",principal.unwrap_or("shared"));
            let mut q=sqlx::QueryBuilder::<$db>::new("INSERT INTO execution_targets(id,owner_principal_id,kind,name,status,policy_digest,created_at,updated_at) VALUES (");q.push_bind(id).push(",").push_bind(principal).push(",'in_process_local','TEST target','online','test','2026-11-01T00:00:00Z','2026-11-01T00:00:00.100Z')");q.build().execute(&mut *tx).await.unwrap();
        }}
        tx.commit().await.unwrap();
        let counts=store.count_group_members(&["paged-group".to_string()]).await.unwrap();
        assert_eq!((counts[0].total,counts[0].required,counts[0].terminal,counts[0].successful),(85,85,84,84));
        let group=store.get_thread_group("paged-group").await.unwrap().unwrap();
        let input=crate::scheduler::SchedulerInvariantInput{objectives:&[],threads:&[],activations:&[],outcomes:&[],groups:std::slice::from_ref(&group),group_members:&[],dependencies:&[]};
        let audit=crate::scheduler::domain::audit_scheduler_invariants_with_group_counts(input,&counts);
        assert!(audit.iter().any(|v|v.code==crate::scheduler::SchedulerInvariantCode::GroupCountMismatch));
        assert!(audit.iter().any(|v|v.code==crate::scheduler::SchedulerInvariantCode::TerminalGroupHasPendingMember),"indexed integrity must detect a bad tail without hydrating that member");
        let mut cursor=None;let mut seen=Vec::new();
        loop {
            let page=store.read_group_member_page("paged-group",cursor.clone(),7).await.unwrap();
            assert!(page.items.len()<=7);seen.extend(page.items.iter().map(|row|row.ordinal));
            if !page.has_more {break;}assert_ne!(page.next_cursor,cursor);cursor=page.next_cursor;
        }
        assert_eq!(seen,(0..85).collect::<Vec<_>>());
        assert!(store.read_group_member_page("paged-group",Some("malformed".into()),7).await.is_err());
        let mut request=RuntimeInventoryQuery{kind:RuntimeInventoryKind::Targets,principal_id:"dir-human-a".into(),context_id:None,thread_id:None,target_id:None,active_only:false,cursor:None,limit:7};
        let mut seen=std::collections::HashSet::new();
        loop {
            let page=store.read_operator_inventory_page(request.clone()).await.unwrap();
            assert!(page.targets.len()<=7);
            for target in &page.targets {assert!(target.owner_principal_id.is_none()||target.owner_principal_id.as_deref()==Some("dir-human-a"));assert!(seen.insert(target.id.clone()),"duplicate target across cursor pages");}
            if !page.has_more {break;}assert_ne!(page.next_cursor,request.cursor);request.cursor=page.next_cursor;
        }
        assert_eq!(seen.iter().filter(|id|id.starts_with("target-page-")).count(),110);
        for kind in [RuntimeInventoryKind::Nodes,RuntimeInventoryKind::Leases,RuntimeInventoryKind::Objectives] {
            request.kind=kind;request.cursor=None;request.context_id=if kind==RuntimeInventoryKind::Objectives{Some("dir-a".into())}else{None};
            store.read_operator_inventory_page(request.clone()).await.unwrap();
        }
    }};
}
pub(crate) use related_pages;

macro_rules! approval_pages {
    ($db:ty,$store:expr)=>{{
        use crate::memory::{ApprovalStore,ExecutionJobStore,ActivationStore,ThreadStore,NewThread,ThreadKind,ThreadSupervision,NewThreadActivation,NewExecutionJob,ExecutionRetrySafety,NewApprovalRequest,ApprovalStatus};
        let store=$store;
        store.ensure_thread(NewThread {id:"approval-page-thread".into(),agent_id:"dir-agent".into(),context_id:"dir-a".into(),session_id:"s-0004".into(),initiating_principal_id:None,root_turn_id:"approval-page-root".into(),kind:ThreadKind::Execution,executor_kind:"self".into(),executor_id:None,target_id:None,supervision:ThreadSupervision::legacy(),model_alias:None,reasoning_effort:None,response_annotations:crate::response_annotations::Protocol::Off}).await.unwrap();
        store.ensure_thread_activation(NewThreadActivation{id:"approval-page-activation".into(),agent_id:"dir-agent".into(),context_id:"dir-a".into(),session_id:"s-0004".into(),initiating_principal_id:None,trigger_event_id:"approval-page-trigger".into(),trigger_sequence:1,trigger_kind:"chat/user_message".into(),parent_activation_id:None,root_turn_id:"approval-page-root".into()}).await.unwrap();
        let mut expected=std::collections::BTreeSet::new();
        for i in 0..55 {
            let job=store.create_execution_job(NewExecutionJob{id:format!("approval-page-job-{i:04}"),activation_id:"approval-page-activation".into(),thread_id:"approval-page-thread".into(),agent_id:"dir-agent".into(),context_id:"dir-a".into(),session_id:"s-0004".into(),initiating_principal_id:None,target_id:crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.into(),tool_call_id:format!("approval-page-call-{i:04}"),tool_name:"exec".into(),request:serde_json::json!({"command":"TEST"}),retry_safety:ExecutionRetrySafety::AtMostOnce,requires_approval:true}).await.unwrap();
            let action=serde_json::json!({"kind":"shell","command":"TEST bounded approval"});
            let requested=serde_json::json!({"network":false,"read_roots":["/TEST"]});
            let identity=crate::approval_authority::stable_approval_identity(&job.id,&action,&requested,"TEST page policy").unwrap();
            expected.insert(identity.approval_id.clone());
            store.ensure_approval_request(NewApprovalRequest{id:identity.approval_id,job_id:job.id,request_digest:identity.request_digest,policy_digest:identity.policy_digest,action,requested,justification:"TEST pending page".into(),pending_status:ApprovalStatus::PendingHuman}).await.unwrap();
        }
        sqlx::query("UPDATE approval_requests SET created_at='2026-11-01T01:02:03.100Z' WHERE status='pending_human'").execute(&store.pool).await.unwrap();
        // Large retained terminal history cannot become an input to this page.
        sqlx::query("WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<10000) INSERT INTO approval_requests(id,revision,job_id,request_digest,policy_digest,action_json,requested_json,justification,status,risk_tags_json,created_at,updated_at,decided_at) SELECT 'retained-approval-'||CAST(n AS TEXT),1,a.job_id,'retained-digest-'||CAST(n AS TEXT),a.policy_digest,a.action_json,a.requested_json,a.justification,'denied',a.risk_tags_json,'2000-01-01T00:00:00Z','2000-01-01T00:00:00Z','2000-01-01T00:00:00Z' FROM numbers CROSS JOIN (SELECT * FROM approval_requests ORDER BY id LIMIT 1) a").execute(&store.pool).await.unwrap();
        let mut cursor=None;let mut seen=std::collections::BTreeSet::new();
        loop {
            let page=store.read_pending_approval_page(cursor.as_deref(),7).await.unwrap();
            assert!(page.records.len()<=7);
            for row in &page.records {assert_eq!(row.status,ApprovalStatus::PendingHuman);assert!(seen.insert(row.id.clone()));assert_eq!(row.action["command"],"TEST bounded approval");}
            if !page.has_more {assert!(page.next_cursor.is_none());break;}
            assert_ne!(page.next_cursor,cursor);cursor=page.next_cursor;
        }
        assert_eq!(seen,expected);
        assert!(store.read_pending_approval_page(Some("bad-cursor"),7).await.is_err());
        let oversized=store.read_pending_approval_page(None,usize::MAX).await.unwrap();assert_eq!(oversized.records.len(),55);
        sqlx::query("WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<10000) INSERT INTO execution_jobs(id,revision,activation_id,thread_id,agent_id,context_id,session_id,initiating_principal_id,target_id,tool_call_id,tool_name,request_json,retry_safety,status,created_at,updated_at) SELECT 'large-pending-job-'||CAST(n AS TEXT),1,j.activation_id,j.thread_id,j.agent_id,j.context_id,j.session_id,j.initiating_principal_id,j.target_id,'large-pending-call-'||CAST(n AS TEXT),j.tool_name,j.request_json,j.retry_safety,j.status,j.created_at,j.updated_at FROM numbers CROSS JOIN (SELECT * FROM execution_jobs WHERE id='approval-page-job-0000') j").execute(&store.pool).await.unwrap();
        sqlx::query("WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<10000) INSERT INTO approval_requests(id,revision,job_id,request_digest,policy_digest,action_json,requested_json,justification,status,risk_tags_json,created_at,updated_at) SELECT 'large-pending-'||CAST(n AS TEXT),1,'large-pending-job-'||CAST(n AS TEXT),'large-pending-digest-'||CAST(n AS TEXT),a.policy_digest,a.action_json,a.requested_json,a.justification,CASE WHEN n%2=0 THEN 'pending_auto' ELSE 'pending_human' END,a.risk_tags_json,'2026-11-02T00:00:00.100Z','2026-11-02T00:00:00.100Z' FROM numbers CROSS JOIN (SELECT * FROM approval_requests WHERE status='pending_human' ORDER BY id LIMIT 1) a").execute(&store.pool).await.unwrap();
        let head=store.read_pending_approval_page(None,7).await.unwrap();assert_eq!(head.records.len(),7);assert!(head.has_more);

    }};
}
pub(crate) use approval_pages;

macro_rules! identity_recovery {
 ($db:ty,$store:expr,$postgres:expr)=>{{
  use crate::memory::{SessionDirectoryStore,RuntimeDirectoryKind,RuntimeDirectoryQuery};
  let store=$store;
  let count:i64=sqlx::query_scalar(if $postgres {"SELECT COUNT(*) FROM sessions WHERE status='active'"} else {"SELECT COUNT(*) FROM sessions s JOIN session_mounts sm ON sm.session_id=s.id AND sm.unmounted_at IS NULL WHERE s.status='active'"}).fetch_one(&store.pool).await.unwrap();
  let last:String=sqlx::query_scalar("SELECT id FROM sessions WHERE status='active' ORDER BY id DESC LIMIT 1").fetch_one(&store.pool).await.unwrap();
  let mut request=RuntimeDirectoryQuery {kind:RuntimeDirectoryKind::Sessions,identity_order:true,limit:200,..Default::default()};
  let mut previous=String::new();let mut seen=0;
  loop {
   let page=store.read_runtime_directory_page(request.clone()).await.unwrap();
   assert!(page.sessions.len()<=200);
   for row in &page.sessions {assert!(row.id>previous,"recovery cursor must seek stable IDs");previous=row.id.clone();seen+=1;}
   if seen==page.sessions.len() {
    let mut update=sqlx::QueryBuilder::<$db>::new("UPDATE sessions SET last_activity_at='2099-01-01T00:00:00Z' WHERE id=");update.push_bind(last.clone());update.build().execute(&store.pool).await.unwrap();
   }
   if !page.has_more {break;}
   assert!(page.next_cursor.is_some());assert_ne!(page.next_cursor,request.cursor);request.cursor=page.next_cursor;
  }
  assert_eq!(seen as i64,count,"activity changes cannot skip an unread startup route");assert_eq!(previous,last);
 }};
}
pub(crate) use identity_recovery;

macro_rules! transfer_recovery {
 ($db:ty,$store:expr,$postgres:expr)=>{{
  use crate::memory::{ThreadStore,TransferProjectionSource};
  let store=$store;
  let mut history=sqlx::QueryBuilder::<$db>::new("WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<10000) INSERT INTO threads(id,kind,agent_id,context_id,session_id,root_turn_id,status,executor_kind,executor_id,result_text,created_at,updated_at) SELECT 'old-transfer-'||CAST(n AS TEXT),'execution','dir-agent','dir-a','s-0004','old-transfer-root-'||CAST(n AS TEXT),'completed','artifact_transfer','old-job',");
  history.push_bind("X".repeat(4096)).push(",'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z' FROM numbers");history.build().execute(&store.pool).await.unwrap();
  for i in 0..55 {
   let mut query=sqlx::QueryBuilder::<$db>::new("INSERT INTO threads(id,kind,agent_id,context_id,session_id,root_turn_id,status,executor_kind,executor_id,created_at,updated_at) VALUES (");query.push_bind(format!("live-transfer-{i:04}")).push(",'execution','dir-agent','dir-a','s-0004',").push_bind(format!("live-transfer-root-{i:04}")).push(",'open','artifact_transfer',").push_bind(format!("live-transfer-job-{i:04}")).push(",'2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')");query.build().execute(&store.pool).await.unwrap();
  }
  let mut cursor=String::new();let mut seen=std::collections::BTreeSet::new();
  loop {
   let mut page=store.read_transfer_projection_recovery_page(TransferProjectionSource::OpenThreads,&cursor,7).await.unwrap();assert!(page.len()<=8);let more=page.len()>7;page.truncate(7);
   for row in &page {assert!(row.cursor_id>cursor);assert!(row.job_id.as_ref().unwrap().starts_with("live-transfer-job-"));assert!(seen.insert(row.thread_id.clone()));}
   if let Some(last)=page.last(){cursor=last.cursor_id.clone();}if !more {break;}
  }
  assert_eq!(seen.len(),55);
  // None of this active fixture is a transfer. The second path must not open
  // arbitrary Context/Thread/Activation bodies to establish that fact.
  assert!(store.read_transfer_projection_recovery_page(TransferProjectionSource::LiveActivations,"",7).await.unwrap().is_empty());
  use sqlx::{Execute,Row};
  let mut query=crate::memory::recovery::transfer_query!($db,TransferProjectionSource::OpenThreads,"live-transfer-0007",7usize,$postgres);let mut built=query.build();let args=built.take_arguments().unwrap().unwrap();
  let sql=format!("{}{}",if $postgres {"EXPLAIN (FORMAT JSON) "}else{"EXPLAIN QUERY PLAN "},built.sql());
  let rows=sqlx::query_with(&sql,args).fetch_all(&store.pool).await.unwrap();
  let plan=if $postgres {rows[0].get::<serde_json::Value,_>(0).to_string()}else{rows.iter().map(|row|row.get::<String,_>("detail")).collect::<Vec<_>>().join("\\n")};
  assert!(plan.contains("idx_transfer_thread_recovery"),"{plan}");
 }};
}
pub(crate) use transfer_recovery;

macro_rules! scheduler_recovery_pages {
 ($db:ty,$store:expr,$install:path)=>{{
    use crate::memory::{ThreadStore,SchedulerRecoverySource as K};
    let store=$store;
    let mut tx=store.pool.begin().await.unwrap();
    for i in 0..220 {
        let id=format!("recovery-thread-{i:04}");
        let event=format!("recovery-event-{i:04}");
        let mut q=sqlx::QueryBuilder::<$db>::new("INSERT INTO threads(id,kind,agent_id,context_id,session_id,root_turn_id,status,executor_kind,created_at,updated_at) VALUES (");
        q.push_bind(id.clone()).push(",'execution','dir-agent','dir-a','s-0004',").push_bind(format!("recovery-root-{i:04}")).push(",'open','TEST','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')");q.build().execute(&mut *tx).await.unwrap();
        let mut q=sqlx::QueryBuilder::<$db>::new("INSERT INTO events(id,timestamp,actor,type,topic,payload) VALUES (");q.push_bind(event.clone()).push(",'2026-11-01T00:00:00Z','TEST','test','TEST','{\"context_id\":\"dir-a\",\"session_id\":\"s-0004\"}')");q.build().execute(&mut *tx).await.unwrap();
        let mut q=sqlx::QueryBuilder::<$db>::new("INSERT INTO thread_activations(id,agent_id,context_id,session_id,trigger_event_id,trigger_sequence,trigger_kind,root_turn_id,status,created_at,updated_at) VALUES (");
        q.push_bind(format!("recovery-act-{i:04}")).push(",'dir-agent','dir-a','s-0004',").push_bind(event.clone()).push(",1,'TEST',").push_bind(format!("recovery-root-{i:04}")).push(",").push_bind(if i%2==0 {"queued"}else{"running"}).push(",'2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')");q.build().execute(&mut *tx).await.unwrap();
        let mut q=sqlx::QueryBuilder::<$db>::new("INSERT INTO thread_signals(id,thread_id,event_id,sequence,kind,status,created_at) VALUES (");q.push_bind(format!("recovery-signal-{i:04}")).push(",").push_bind(id).push(",").push_bind(event).push(",1,'TEST','pending','2026-11-01T00:00:00Z')");q.build().execute(&mut *tx).await.unwrap();
    }
    sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000) INSERT INTO events(id,timestamp,actor,type,topic,payload) SELECT 'recovery-many-event-'||CAST(i AS TEXT),'2026-11-01T00:00:00Z','TEST','test','TEST','{}' FROM n").execute(&mut *tx).await.unwrap();
    sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000) INSERT INTO thread_signals(id,thread_id,event_id,sequence,kind,status,created_at) SELECT 'recovery-many-signal-'||CAST(i AS TEXT),'recovery-thread-0000','recovery-many-event-'||CAST(i AS TEXT),i+1,'TEST','pending','2026-11-01T00:00:00Z' FROM n").execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    for kind in [K::LiveActivations,K::OpenThreads,K::PendingSignalThreads] {
        let mut after=String::new();let mut seen=std::collections::HashSet::new();let mut reads=0;
        loop {
            let mut page=store.read_scheduler_recovery_page(kind,"dir-a",&after,7).await.unwrap();reads+=1;assert!(page.len()<=8);
            let more=page.len()>7;page.truncate(7);
            for row in &page {assert_eq!(row.context_id,"dir-a");assert!(row.cursor_id>after);if row.entity_id.starts_with(if matches!(kind,K::LiveActivations){"recovery-act-"}else{"recovery-thread-"}) {seen.insert(row.entity_id.clone());}}
            if let Some(tail)=page.last(){after=tail.cursor_id.clone();}if !more {break;}
        }
        assert_eq!(seen.len(),220,"a bounded recovery must not truncate its later live work");
        assert!(reads<100,"the first Signal per Thread must not drain a 10000-Signal mailbox");
    }
    assert!(store.read_scheduler_recovery_page(K::LiveActivations,"dir-b","",7).await.unwrap().iter().all(|row|!row.entity_id.starts_with("recovery-act-")));
    assert!(store.recovery_owned_threads("dir-a",&["recovery-thread-0000".into()]).await.unwrap().contains(&"recovery-thread-0000".into()));
    assert!(store.recovery_owned_threads("dir-b",&["recovery-thread-0000".into()]).await.unwrap().is_empty());
    // Retained index backfill, source-row move and rollback keep original IDs,
    // sequences/statuses/clocks. The derived Context is never authority alone.
    sqlx::query("UPDATE thread_signals SET directory_context_id=NULL WHERE id='recovery-signal-0000'").execute(&store.pool).await.unwrap();
    $install(&store.pool).await.unwrap();
    let context:String=sqlx::query_scalar("SELECT directory_context_id FROM thread_signals WHERE id='recovery-signal-0000'").fetch_one(&store.pool).await.unwrap();assert_eq!(context,"dir-a");
    let mut tx=store.pool.begin().await.unwrap();
    sqlx::query("UPDATE threads SET context_id='dir-b' WHERE id='recovery-thread-0000'").execute(&mut *tx).await.unwrap();
    let context:String=sqlx::query_scalar("SELECT directory_context_id FROM thread_signals WHERE id='recovery-signal-0000'").fetch_one(&mut *tx).await.unwrap();assert_eq!(context,"dir-b");
    tx.rollback().await.unwrap();
    let context:String=sqlx::query_scalar("SELECT directory_context_id FROM thread_signals WHERE id='recovery-signal-0000'").fetch_one(&store.pool).await.unwrap();assert_eq!(context,"dir-a");
 }};
}
pub(crate) use scheduler_recovery_pages;

macro_rules! session_priority {
    ($db:ty,$store:expr) => {{
        let store = $store;
        let before = store.get_session("s-0004").await.unwrap().unwrap();
        let top = store
            .list_context_sessions_bounded(&["dir-a".into()], true, 1)
            .await
            .unwrap();
        assert_eq!(
            top[0].id, "s-0004",
            "old live approval must outrank mere recency"
        );
        let rank: i32 = sqlx::query_scalar(
            "SELECT CAST(directory_priority AS INTEGER) FROM sessions WHERE id='s-0004'",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(rank, 0);
        let mut tx = store.pool.begin().await.unwrap();
        sqlx::query("UPDATE execution_jobs SET status='failed' WHERE session_id='s-0004'")
            .execute(&mut *tx)
            .await
            .unwrap();
        let rank: i32 = sqlx::query_scalar(
            "SELECT CAST(directory_priority AS INTEGER) FROM sessions WHERE id='s-0004'",
        )
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_eq!(
            rank, 2,
            "queued Activation still owns real work after approval Jobs finish"
        );
        tx.rollback().await.unwrap();
        let rank: i32 = sqlx::query_scalar(
            "SELECT CAST(directory_priority AS INTEGER) FROM sessions WHERE id='s-0004'",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(rank, 0);
        let after = store.get_session("s-0004").await.unwrap().unwrap();
        assert_eq!(before.updated_at, after.updated_at);
        assert_eq!(before.last_activity_at, after.last_activity_at);
        assert_eq!(before.status, after.status);
        // Both archive modes must use Context-leading maintained ordering; there
        // is no ROW_NUMBER/EXISTS over the entire registry before LIMIT.
        for archived in [true, false] {
            let contexts = vec!["dir-a".to_string()];
            let mut query = crate::memory::directory::priority::session_heads_query!(
                $db,
                &contexts,
                archived,
                7usize,
                stringify!($db).contains("Postgres")
            )
            .unwrap();
            assert!(!query.sql().contains("ROW_NUMBER"));
            let rows = query.build().fetch_all(&store.pool).await.unwrap();
            assert_eq!(rows.len(), 7);
        }
    }};
}
pub(crate) use session_priority;

macro_rules! inspection_pages {
 ($db:ty,$store:expr)=>{{
    use crate::memory::{ThreadStore,ExecutionJobStore,ApprovalStore};
    use crate::memory::inspection_page::{ThreadInspectionKind as K,ThreadInspectionQuery as Q};
    let store=$store;let thread=store.get_thread("approval-page-thread").await.unwrap().unwrap();
    let mut request=Q{kind:K::Jobs,activation_id:Some("approval-page-activation".into()),cursor:None,limit:Some(7)};
    let first=store.read_thread_inspection_page(&thread,&request).await.unwrap();
    assert_eq!(first.jobs.len(),7);assert!(first.has_more);assert!(first.jobs.iter().all(|job|job.request["command"]=="TEST"));
    request.cursor=first.next_cursor.clone();
    let next=store.read_thread_inspection_page(&thread,&request).await.unwrap();assert_eq!(next.jobs.len(),7);
    assert!(!next.jobs.iter().any(|row|first.jobs.iter().any(|old|old.id==row.id)));
    let mut foreign=thread.clone();foreign.context_id="dir-b".into();assert!(store.read_thread_inspection_page(&foreign,&request).await.unwrap().jobs.is_empty());
    foreign=thread.clone();foreign.id="other-thread".into();assert!(store.read_thread_inspection_page(&foreign,&request).await.is_err());
    let heads=store.list_execution_jobs_for_activations("dir-a",&["approval-page-activation".into()]).await.unwrap();assert_eq!(heads.len(),32,"one Activation cannot hydrate its 10055-Job lifetime");
    assert!(store.activation_jobs_exist("dir-a", &["approval-page-activation".into()]).await.unwrap());
    assert!(!store.activation_jobs_exist("dir-b", &["approval-page-activation".into()]).await.unwrap());
    assert!(!store.activation_jobs_exist("dir-a", &[]).await.unwrap());
    assert!(store.activation_jobs_exist("dir-a", &vec!["approval-page-activation".into();101]).await.is_err());
    let approvals=store.list_job_approvals("dir-a",&["approval-page-job-0000".into()]).await.unwrap();assert_eq!(approvals.len(),1,"one selected Job cannot hydrate historical approval revisions");
    for kind in [K::Activations,K::PendingSignals,K::Schedules] {
        let page=store.read_thread_inspection_page(&thread,&Q{kind,activation_id:None,cursor:None,limit:Some(7)}).await.unwrap();assert!(!page.has_more);
    }
    sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<55) INSERT INTO events(id,timestamp,actor,type,topic,payload) SELECT 'inspection-event-'||CAST(i AS TEXT),'2026-11-01T00:00:00.100Z','TEST','test','TEST','{}' FROM n").execute(&store.pool).await.unwrap();
        sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<55) INSERT INTO thread_signals(id,thread_id,event_id,sequence,kind,status,created_at) SELECT 'inspection-signal-'||CAST(i AS TEXT),'approval-page-thread','inspection-event-'||CAST(i AS TEXT),i,'TEST','claimed','2026-11-01T00:00:00.100Z' FROM n").execute(&store.pool).await.unwrap();
    sqlx::query("INSERT INTO activation_signals(activation_id,signal_id,ordinal) SELECT 'approval-page-activation',id,sequence FROM thread_signals WHERE thread_id='approval-page-thread'").execute(&store.pool).await.unwrap();
    let mut request=Q{kind:K::ActivationSignals,activation_id:Some("approval-page-activation".into()),cursor:None,limit:Some(7)};
    let mut seen=std::collections::HashSet::new();
    loop {
        let page=store.read_thread_inspection_page(&thread,&request).await.unwrap();assert!(page.signals.len()<=7);
        for row in page.signals {assert!(seen.insert(row.id));}
        if !page.has_more {break;}assert_ne!(request.cursor,page.next_cursor);request.cursor=page.next_cursor;
    }
    assert_eq!(seen.len(),55);
 }};
}
pub(crate) use inspection_pages;

macro_rules! scoped_pending_pages {
 ($db:ty,$store:expr)=>{{
    use crate::memory::{ApprovalStore,ApprovalDecisionAuthority};
    let store=$store;
    // Original bindings, not derived keys alone, must authorize each page.
    sqlx::query("UPDATE execution_jobs SET initiating_principal_id='dir-human-a' WHERE id LIKE 'approval-page-job-%'").execute(&store.pool).await.unwrap();
    let authority=ApprovalDecisionAuthority{session_id:"s-0004".into(),principal_id:"dir-human-a".into()};
    let mut cursor=None;let mut seen=std::collections::HashSet::new();
    loop{
        let page=store.read_principal_pending_approval_page(&authority,cursor.as_deref(),7).await.unwrap();
        assert!(page.records.len()<=7);
        for record in page.records {assert!(seen.insert(record.id));assert!(record.job_id.starts_with("approval-page-job-"));}
        if !page.has_more{assert!(page.next_cursor.is_none());break;}
        assert_ne!(page.next_cursor,cursor);cursor=page.next_cursor;
    }
    assert_eq!(seen.len(),55);
    assert!(store.read_principal_pending_approval_page(&ApprovalDecisionAuthority{principal_id:"dir-human-b".into(),..authority.clone()},None,7).await.unwrap().records.is_empty());
    assert!(store.read_principal_pending_approval_page(&authority,Some("bad"),7).await.is_err());
    let mut tx=store.pool.begin().await.unwrap();
    sqlx::query("UPDATE session_principal_bindings SET unbound_at='2099-01-01T00:00:00Z' WHERE session_id='s-0004' AND principal_id='dir-human-a'").execute(&mut *tx).await.unwrap();
    // Native permission proof can be inspected in the same transaction; a
    // derived principal key must not make a retired binding look current.
    let mut query=crate::memory::approval_page::scoped_query!($db,None,Some(&authority),None,8usize).unwrap();
    assert!(query.build().fetch_all(&mut *tx).await.unwrap().is_empty());
    tx.rollback().await.unwrap();
    assert_eq!(store.read_principal_pending_approval_page(&authority,None,7).await.unwrap().records.len(),7);
 }};
}
pub(crate) use scoped_pending_pages;

macro_rules! schedule_pages {
 ($db:ty,$store:expr)=>{{
    use crate::memory::ScheduleStore;
    let store=$store;
    for (status,prefix,count) in [("queued","live-page-schedule-",55),("completed","old-page-schedule-",10000)]{
        let mut q=sqlx::QueryBuilder::<$db>::new("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<");q.push_bind(count as i64).push(") INSERT INTO schedules(id,revision,thread_id,source_turn_id,intent,status,created_at,updated_at) SELECT ").push_bind(prefix).push("||CAST(i AS TEXT),1,'approval-page-thread','approval-page-root','TEST bounded schedules',").push_bind(status).push(",'2026-11-01T00:00:00.100Z','2026-11-01T00:00:00.100Z' FROM n");q.build().execute(&store.pool).await.unwrap();
    }
    let head=store.list_context_schedule_inventory_bounded("dir-a",false,7).await.unwrap();assert_eq!(head.len(),7);assert!(head.iter().all(|s|s.id.starts_with("live-page-")));
    let mut tx=store.pool.begin().await.unwrap();
    sqlx::query("UPDATE threads SET context_id='dir-b' WHERE id='approval-page-thread'").execute(&mut *tx).await.unwrap();
    let mut old=crate::memory::directory::schedule_index::schedule_inventory_query!($db,"dir-a",false,7usize);
    assert!(old.build().fetch_all(&mut *tx).await.unwrap().is_empty());
    let mut moved=crate::memory::directory::schedule_index::schedule_inventory_query!($db,"dir-b",false,7usize);
    assert_eq!(moved.build().fetch_all(&mut *tx).await.unwrap().len(),7);
    tx.rollback().await.unwrap();
    let (bucket,context):(i32,String)=sqlx::query_as("SELECT CAST(directory_bucket AS INTEGER),directory_context_id FROM schedules WHERE id='live-page-schedule-1'").fetch_one(&store.pool).await.unwrap();
    assert_eq!((bucket,context),(0,"dir-a".into()));
    let mut tx=store.pool.begin().await.unwrap();
    sqlx::query("UPDATE schedules SET status='completed' WHERE id='live-page-schedule-1'").execute(&mut *tx).await.unwrap();
    let bucket:i32=sqlx::query_scalar("SELECT CAST(directory_bucket AS INTEGER) FROM schedules WHERE id='live-page-schedule-1'").fetch_one(&mut *tx).await.unwrap();assert_eq!(bucket,1);
    tx.rollback().await.unwrap();
    assert_eq!(store.list_context_schedule_inventory_bounded("dir-a",false,7).await.unwrap().len(),7);
 }};
}
pub(crate) use schedule_pages;

macro_rules! activity_pages {
 ($db:ty,$store:expr)=>{{
    use crate::memory::ThreadStore;
    use crate::memory::activity_page::{ActivityCollection as K,ActivityPageQuery as Q};
    let store=$store;
    for (status,prefix,count) in [("active","activity-goal-",55),("completed","activity-old-goal-",10000)] {
        let mut q=sqlx::QueryBuilder::<$db>::new("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<");
        q.push_bind(count as i64).push(") INSERT INTO objectives(id,agent_id,context_id,coordinator_session_id,delivery_session_id,source_event_id,stated_objective,revision,status,created_at,updated_at) SELECT ").push_bind(prefix).push("||CAST(i AS TEXT),'dir-agent','dir-a','s-0004','s-0004','TEST-activity-source','TEST bounded goal',1,").push_bind(status).push(",'2026-11-01T00:00:00.100Z','2026-11-01T00:00:00.100Z' FROM n");
        q.build().execute(&store.pool).await.unwrap();
    }
    for collection in [K::Objectives,K::Schedules,K::Threads] {
        let mut query=Q{context_id:"dir-a".into(),collection,include_terminal:false,cursor:None,limit:7,metadata_only:true};
        let mut seen=std::collections::HashSet::new();
        loop {
            let page=store.read_activity_page(&query).await.unwrap();
            let ids=page.objectives.iter().map(|r|r.id.clone()).chain(page.schedules.iter().map(|r|r.id.clone())).chain(page.threads.iter().map(|r|r.id.clone())).collect::<Vec<_>>();
            assert!(ids.len()<=7);for id in ids {assert!(seen.insert(id),"a raw equal-clock cursor repeated a row");}
            if !page.has_more {assert!(page.next_cursor.is_none());break;}
            assert_ne!(query.cursor,page.next_cursor);
            let mut foreign=query.clone();foreign.context_id="dir-b".into();foreign.cursor=page.next_cursor.clone();assert!(store.read_activity_page(&foreign).await.is_err());
            let mut other=query.clone();other.collection=if collection==K::Threads{K::Objectives}else{K::Threads};other.cursor=page.next_cursor.clone();assert!(store.read_activity_page(&other).await.is_err());
            query.cursor=page.next_cursor;
        }
        if collection==K::Objectives {assert_eq!(seen.len(),55);}
        if collection==K::Schedules {assert_eq!(seen.len(),55);}
    }
 }};
}
pub(crate) use activity_pages;

macro_rules! job_header_pages {
 ($db:ty,$store:expr)=>{{
    use crate::memory::{ExecutionJobStore,ExecutionJobFilter,ThreadStore};
    let store=$store;
    let payload=sqlx::types::Json(serde_json::json!({"command":"TEST","large":"x".repeat(2*1024*1024)}));
    let mut update=sqlx::QueryBuilder::<$db>::new("UPDATE execution_jobs SET request_json=");update.push_bind(payload).push(" WHERE id='approval-page-job-0000'");update.build().execute(&store.pool).await.unwrap();
    let filter=ExecutionJobFilter{context_id:Some("dir-a".into()),session_id:Some("s-0004".into()),thread_id:Some("approval-page-thread".into()),visible_principal_id:Some("dir-human-a".into()),include_terminal:true,newest_first:true,..Default::default()};
    let mut cursor=None;let mut seen=std::collections::HashSet::new();
    loop {
        let page=store.read_job_header_page(filter.clone(),cursor.as_deref(),7).await.unwrap();
        assert!(page.items.len()<=7);assert!(serde_json::to_vec(&page.items).unwrap().len()<16384,"a header cannot hydrate a 2MiB tool request");
        for job in page.items {assert!(!job.request_loaded);assert!(seen.insert(job.id));}
        if !page.has_more {assert!(page.next_cursor.is_none());break;}
        assert_ne!(page.next_cursor,cursor);
        let foreign=ExecutionJobFilter{visible_principal_id:Some("dir-human-b".into()),..filter.clone()};
        assert!(store.read_job_header_page(foreign,page.next_cursor.as_deref(),7).await.is_err());
        cursor=page.next_cursor;
    }
    let thread=store.get_thread("approval-page-thread").await.unwrap().unwrap();
    let head=store.thread_wait_heads("dir-a",&[(thread.id.clone(),thread.generation,thread.revision)]).await.unwrap();
    assert_eq!(head.len(),1);assert!(head[0].kinds.iter().any(|kind|kind=="permission"));
    assert!(store.thread_wait_heads("dir-b",&[(thread.id.clone(),thread.generation,thread.revision)]).await.unwrap().is_empty());
    assert!(store.thread_wait_heads("dir-a",&[(thread.id.clone(),thread.generation+1,thread.revision)]).await.unwrap().is_empty());
    assert_eq!(seen.len(),55);
    assert_eq!(store.get_execution_job("approval-page-job-0000").await.unwrap().unwrap().request["large"].as_str().unwrap().len(),2*1024*1024,"physical request remains intact for explicit detail/control reads");
 }};
}
pub(crate) use job_header_pages;

macro_rules! terminal_catalog_pages {
 ($db:ty,$store:expr)=>{{
    use crate::memory::terminal::{TerminalSessionFilter,TerminalSessionRecord,TerminalCatalogCursor,TerminalStore};
    let store=$store;
    let mut q=sqlx::QueryBuilder::<$db>::new("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000) INSERT INTO terminal_sessions(id,session_id,context_id,principal_id,root_turn_id,source_job_id,scope_ref,target_id,owner_instance_id,lease_expires_at,revision,status,created_at,record_json) SELECT 'foreign-catalog-'||CAST(i AS TEXT),'s-0004','dir-a','dir-human-a',NULL,NULL,'foreign-scope','target-page-dir-human-a-0000','TEST','2099-01-01T00:00:00Z',1,'open','2026-11-01T01:00:00.100Z','{}' FROM n");
    q.build().execute(&store.pool).await.unwrap();
    for i in 0..55 {
        let record:TerminalSessionRecord=serde_json::from_value(serde_json::json!({
          "id":format!("page-terminal-{i:04}"),"session_id":"s-0004","context_id":"dir-a","principal_id":"dir-human-a",
          "root_turn_id":null,"source_job_id":null,"scope_ref":"catalog-owned","creation_command_id":format!("TEST-{i}"),
          "target_id":"target-page-dir-human-a-0000","owner_instance_id":"TEST","lease_expires_at":"2026-11-01T00:00:00Z",
          "revision":1,"status":"closed","title":"TEST page","shell":"/bin/sh","cwd":"/tmp","rows":24,"cols":80,
          "policy_hash":"TEST","sandbox_status":"TEST","network_enabled":false,"last_input_job_id":null,"last_input_status":null,"exit_code":0,
          "created_at":"2026-11-01T01:00:00.100Z","updated_at":"2026-11-01T01:00:00.100Z"
        })).unwrap();
        assert!(store.create_terminal(&record).await.unwrap());
    }
    let mut filter=TerminalSessionFilter {session_id:"s-0004".into(),context_id:"dir-a".into(),principal_id:"dir-human-a".into(),root_ids:Some(vec![]),scope_ref:Some("catalog-owned".into()),cursor:None,limit:8};
    let mut seen=std::collections::HashSet::new();
    loop {
        let page=store.terminals(&filter).await.unwrap();assert!(page.len()<=8);
        for record in page.iter().take(7){assert!(record.id.starts_with("page-terminal-"));assert!(seen.insert(record.id.clone()));}
        if page.len()<=7 {break;}
        let next=TerminalCatalogCursor::for_record(&page[6]);assert_ne!(filter.cursor.as_ref(),Some(&next));filter.cursor=Some(next);
    }
    assert_eq!(seen.len(),55,"raw equal-clock cursor must reach the entire explicitly requested catalog");
    filter.scope_ref=Some("another-scope".into());filter.cursor=None;assert!(store.terminals(&filter).await.unwrap().is_empty());
    filter.cursor=Some("broken".into());assert!(store.terminals(&filter).await.is_err());
    filter.cursor=None;filter.root_ids=Some(vec!["root".to_string();51]);assert!(store.terminals(&filter).await.is_err());
 }};
}
pub(crate) use terminal_catalog_pages;

macro_rules! plan_cases {
    ($db:ty) => {{
        let authority = crate::memory::ApprovalDecisionAuthority {
            session_id: "s-0004".into(),
            principal_id: "dir-human-a".into(),
        };
        let contexts = vec!["dir-a".to_string()];
        let cursor = crate::memory::directory::DirectoryCursor {
            sort_at: "2026-01-01T00:00:00Z".into(),
            id: "old-transfer-5000".into(),
        }
        .encode();
        let terminal_key=crate::memory::terminal::TerminalCatalogCursor::for_record(&serde_json::from_value::<crate::memory::terminal::TerminalSessionRecord>(serde_json::json!({
          "id":"page-terminal-0030","session_id":"s-0004","context_id":"dir-a","principal_id":"dir-human-a",
          "root_turn_id":null,"source_job_id":null,"target_id":"TEST","owner_instance_id":"TEST","lease_expires_at":"2026-11-01T00:00:00Z",
          "revision":1,"status":"closed","title":"TEST","shell":"/bin/sh","cwd":"/tmp","rows":24,"cols":80,"policy_hash":"TEST",
          "sandbox_status":"TEST","network_enabled":false,"last_input_job_id":null,"last_input_status":null,"exit_code":0,
          "created_at":"2026-11-01T01:00:00.100Z","updated_at":"2026-11-01T01:00:00.100Z"
        })).unwrap());
        vec![
            ("Job header continuation",crate::memory::job_header::header_query!($db,crate::memory::ExecutionJobFilter {
                context_id:Some("dir-a".into()),session_id:Some("s-0004".into()),thread_id:Some("approval-page-thread".into()),visible_principal_id:Some("dir-human-a".into()),include_terminal:true,newest_first:true,limit:Some(8),..Default::default()
            },Some(("2099-01-01T00:00:00Z".to_string(),"zzzz".to_string())))),
            ("current Goal continuation",crate::memory::activity_page::activity_page_query!($db,&crate::memory::activity_page::ActivityPageQuery {
                context_id:"dir-a".into(),collection:crate::memory::activity_page::ActivityCollection::Objectives,metadata_only:true,include_terminal:false,
                cursor:Some(crate::memory::activity_page::ActivityPageQuery{context_id:"dir-a".into(),collection:crate::memory::activity_page::ActivityCollection::Objectives,metadata_only:true,include_terminal:false,cursor:None,limit:7}.cursor_for("2026-11-01T00:00:00.100Z".into(),"activity-goal-30".into(),0)),limit:7,
            }).unwrap()),
            ("current Schedule continuation",crate::memory::activity_page::activity_page_query!($db,&crate::memory::activity_page::ActivityPageQuery {
                context_id:"dir-a".into(),collection:crate::memory::activity_page::ActivityCollection::Schedules,metadata_only:true,include_terminal:false,
                cursor:Some(crate::memory::activity_page::ActivityPageQuery{context_id:"dir-a".into(),collection:crate::memory::activity_page::ActivityCollection::Schedules,metadata_only:true,include_terminal:false,cursor:None,limit:7}.cursor_for("2026-11-01T00:00:00.100Z".into(),"live-page-schedule-30".into(),0)),limit:7,
            }).unwrap()),
            ("live Activation recovery",crate::memory::recovery::scheduler_query!($db,crate::memory::SchedulerRecoverySource::LiveActivations,"dir-a","recovery-act-0100",7usize)),
            ("pending mailbox recovery",crate::memory::recovery::scheduler_query!($db,crate::memory::SchedulerRecoverySource::PendingSignalThreads,"dir-a","recovery-thread-0100",7usize)),
            ("open Thread recovery",crate::memory::recovery::scheduler_query!($db,crate::memory::SchedulerRecoverySource::OpenThreads,"dir-a","recovery-thread-0100",7usize)),
            ("deep scoped terminal catalog",crate::memory::terminal::terminal_catalog_query!($db,&crate::memory::terminal::TerminalSessionFilter {
                session_id:"s-0004".into(),context_id:"dir-a".into(),principal_id:"dir-human-a".into(),root_ids:Some(vec![]),scope_ref:Some("catalog-owned".into()),cursor:Some(terminal_key),limit:8,
            }).unwrap()),
            (
                "context approvals",
                crate::memory::approval_page::scoped_query!($db, Some("dir-a"), None, None, 8usize)
                    .unwrap(),
            ),
            (
                "principal approvals",
                crate::memory::approval_page::scoped_query!(
                    $db,
                    None,
                    Some(&authority),
                    None,
                    8usize
                )
                .unwrap(),
            ),
            (
                "live schedules",
                crate::memory::directory::schedule_index::schedule_inventory_query!(
                    $db, "dir-a", false, 8usize
                ),
            ),
            (
                "retained schedule head",
                crate::memory::directory::schedule_index::schedule_inventory_query!(
                    $db, "dir-a", true, 8usize
                ),
            ),
            (
                "deep terminal Thread continuation",
                crate::memory::directory::terminal_thread_query!(
                    $db,
                    "dir-a",
                    Some(cursor),
                    7usize
                )
                .unwrap(),
            ),
            (
                "priority Session head",
                crate::memory::directory::priority::session_heads_query!(
                    $db,
                    &contexts,
                    true,
                    8usize,
                    stringify!($db).contains("Postgres")
                )
                .unwrap(),
            ),
        ]
    }};
}
pub(crate) use plan_cases;

macro_rules! scalar_authority_heads {
 ($db:ty,$store:expr)=>{{
    use crate::memory::{ThreadStore,ObjectiveStore,ApprovalStore};
    use crate::memory::audit_page::{AuditQuery,AuditSource as S,AuditWitness as W};
    let store=$store;
    let large="x".repeat(2*1024*1024);
    let mut q=sqlx::QueryBuilder::<$db>::new("UPDATE objectives SET stated_objective=");q.push_bind(large).push(" WHERE id='activity-goal-1'");q.build().execute(&store.pool).await.unwrap();
    let preview=store.get_objective_preview("activity-goal-1").await.unwrap().unwrap();assert_eq!(preview.stated_objective.len(),1000);
    assert_eq!(store.get_objective("activity-goal-1").await.unwrap().unwrap().stated_objective.len(),2*1024*1024);
    let mut q=sqlx::QueryBuilder::<$db>::new("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000) INSERT INTO scheduler_dependencies(id,owner_kind,owner_id,owner_generation,dependency_kind,dependency_id,dependency_generation,required,status,metadata_json,created_at,updated_at) SELECT 'head-resource-'||CAST(i AS TEXT),'objective','activity-goal-1',1,'resource','resource-'||CAST(i AS TEXT),1,TRUE,'pending','{}','2026-11-01T00:00:00.100Z','2026-11-01T00:00:00.100Z' FROM n");q.build().execute(&store.pool).await.unwrap();
    let owners=vec![("objective".to_owned(),preview.id.clone(),preview.generation,preview.revision)];
    let heads=store.scheduler_dependency_heads("dir-a",&owners).await.unwrap();assert_eq!(heads.len(),1);let head=&heads[0];assert!(head.pending);assert_eq!(head.kinds,vec!["resource"]);assert_eq!(head.resources.len(),32);assert!(head.resources_truncated);assert!(serde_json::to_vec(&heads).unwrap().len()<16384);
    assert!(store.scheduler_dependency_heads("dir-b",&owners).await.unwrap().is_empty());
    let mut stale=owners.clone();stale[0].3+=1;assert!(store.scheduler_dependency_heads("dir-a",&stale).await.unwrap().is_empty());
    assert_eq!(store.scheduler_authority_witnesses("dir-a",W::PendingObjectives,&[preview.id.clone()]).await.unwrap(),vec![(preview.id.clone(),preview.generation)]);
    for source in [S::Objectives,S::Threads,S::Activations,S::Groups] {
      let mut after=String::new();let mut seen=std::collections::HashSet::new();
      loop{let page=store.scheduler_authority_page(&AuditQuery{context_id:"dir-a".into(),source,after:after.clone(),ids:None,roots:None,include_terminal:false,limit:7}).await.unwrap();
        let ids=page.facts.objectives.iter().map(|v|v.id.clone()).chain(page.facts.threads.iter().map(|v|v.id.clone())).chain(page.facts.groups.iter().map(|v|v.id.clone())).chain(page.activations.iter().map(|v|v.id.clone())).collect::<Vec<_>>();assert!(ids.len()<=7);for id in ids{assert!(seen.insert(id));}
        if !page.has_more {break;}let next=page.next_id.unwrap();assert!(next>after);after=next;
      }if source==S::Objectives{assert_eq!(seen.len(),55);}
    }
    let scope=crate::memory::approval_page::ExecutionApprovalScope{context_id:"dir-a".into(),session_id:"s-0004".into(),thread_id:Some("approval-page-thread".into()),root_ids:vec![]};
    let first=store.read_execution_pending_approval_page(&scope,None,7).await.unwrap();assert_eq!(first.records.len(),7);assert!(first.has_more);
    let next=store.read_execution_pending_approval_page(&scope,first.next_cursor.as_deref(),7).await.unwrap();assert_eq!(next.records.len(),7);assert!(!next.records.iter().any(|n|first.records.iter().any(|p|p.id==n.id)));
    let mut foreign=scope.clone();foreign.session_id="s-0003".into();assert!(store.read_execution_pending_approval_page(&foreign,first.next_cursor.as_deref(),7).await.is_err());
    let tail=scope.wrap(crate::memory::directory::DirectoryCursor{sort_at:"2026-11-02T00:00:00.100Z".into(),id:"large-pending-9999".into()}.encode());let end=store.read_execution_pending_approval_page(&scope,Some(&tail),7).await.unwrap();assert!(end.records.is_empty());assert!(!end.has_more);
    let before=store.count_session_principals(&["s-0004".into()]).await.unwrap()[0].1;
    sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000) INSERT INTO principals(id,provider_id,assurance,created_at,updated_at) SELECT 'head-principal-'||CAST(i AS TEXT),'TEST','verified','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z' FROM n").execute(&store.pool).await.unwrap();
    sqlx::query("INSERT INTO session_principal_bindings(session_id,principal_id,bound_at) SELECT 's-0004',id,'2026-11-01T00:00:00Z' FROM principals WHERE id LIKE 'head-principal-%'").execute(&store.pool).await.unwrap();
    assert_eq!(store.list_session_principal_bindings_bounded(&["s-0004".into()]).await.unwrap().len(),2);
    assert_eq!(store.count_session_principals(&["s-0004".into()]).await.unwrap()[0].1,before+10000);
 }};
}
pub(crate) use scalar_authority_heads;

macro_rules! delegation_pages {
 ($db:ty,$store:expr)=>{{
  use crate::memory::DelegationStore;
  use crate::memory::delegation_page::DelegationPageQuery as Q;
  let store=$store;
  let mut tx=store.pool.begin().await.unwrap();
  // One child Session per edge, mixed terminal/live states and mixed raw clocks.
  for i in 5..105 {
   let child=format!("s-{i:04}");let id=format!("delegation-page-{i:04}");
   let mut q=sqlx::QueryBuilder::<$db>::new("INSERT INTO delegations(id,agent_id,parent_context_id,parent_session_id,child_context_id,child_session_id,task,context_scope,status,created_at,updated_at) VALUES (");
   q.push_bind(id).push(",'dir-agent','dir-a','s-0004','dir-b',").push_bind(child).push(",").push_bind("x".repeat(32768)).push(",'isolated',").push_bind(if i%3==0{"completed"}else{"running"}).push(",'2026-11-01T00:00:00Z',").push_bind(if i%2==0{"2026-11-01T00:00:00.100Z"}else{"2026-11-01T00:00:00.200Z"}).push(")");q.build().execute(&mut *tx).await.unwrap();
  }
  tx.commit().await.unwrap();
  let mut request=Q{context_id:Some("dir-a".into()),session_id:Some("s-0004".into()),include_terminal:true,limit:7,cursor:None};
  let mut seen=std::collections::HashSet::new();
  loop {
   let page=store.read_delegation_page(&request).await.unwrap();assert!(page.delegations.len()<=7);assert!(!page.bodies_loaded);
   for row in &page.delegations {assert_eq!(row.task.len(),1000);assert!(seen.insert(row.id.clone()));}
   if !page.has_more {break;}assert_ne!(page.next_cursor,request.cursor);
   let mut foreign=request.clone();foreign.context_id=Some("dir-b".into());foreign.cursor=page.next_cursor.clone();assert!(store.read_delegation_page(&foreign).await.is_err());
   request.cursor=page.next_cursor;
  }
  assert_eq!(seen.len(),100);
  let live=store.read_delegation_page(&Q{include_terminal:false,cursor:None,..request.clone()}).await.unwrap();assert!(live.delegations.iter().all(|r|r.status==crate::memory::DelegationStatus::Running));
 }};
}
pub(crate) use delegation_pages;
