//! Transactional navigation index. Permissions remain the live binding row.
use sqlx::Row;
type Error = Box<dyn std::error::Error + Send + Sync>;

macro_rules! backfill {
    ($db:ty,$pool:expr) => {{
        let mut cursor=(String::new(),String::new());
        loop {
            let mut query=sqlx::QueryBuilder::<$db>::new("SELECT session_id,principal_id FROM session_principal_bindings WHERE unbound_at IS NULL AND directory_activity_at IS NULL AND (session_id,principal_id) > (");
            query.push_bind(cursor.0.clone()).push(",").push_bind(cursor.1.clone()).push(") ORDER BY session_id,principal_id LIMIT 200");
            let rows=query.build().fetch_all($pool).await?;
            if rows.is_empty() {break;}
            let keys=rows.iter().map(|row|(row.get::<String,_>("session_id"),row.get::<String,_>("principal_id"))).collect::<Vec<_>>();
            let mut tx=$pool.begin().await?;
            for (session,principal) in &keys {
                let mut update=sqlx::QueryBuilder::<$db>::new("UPDATE session_principal_bindings SET (directory_context_id,directory_activity_at,directory_status)=(SELECT context_id,last_activity_at,status FROM sessions WHERE id=");
                update.push_bind(session.as_str()).push(") WHERE session_id=").push_bind(session.as_str()).push(" AND principal_id=").push_bind(principal.as_str());
                update.build().execute(&mut *tx).await?;
            }
            tx.commit().await?;
            cursor=keys.last().unwrap().clone();
        }
    }};
}

macro_rules! backfill_context_activity {
    ($db:ty,$pool:expr,$greatest:expr) => {{
        let mut cursor=String::new();
        loop {
            let mut query=sqlx::QueryBuilder::<$db>::new("SELECT id FROM cognitive_contexts WHERE directory_activity_at IS NULL AND id > ");
            query.push_bind(cursor.clone()).push(" ORDER BY id LIMIT 200");
            let rows=query.build().fetch_all($pool).await?;
            if rows.is_empty() {break;}
            let keys=rows.iter().map(|row|row.get::<String,_>("id")).collect::<Vec<_>>();
            let mut tx=$pool.begin().await?;
            for id in &keys {
                let mut update=sqlx::QueryBuilder::<$db>::new("UPDATE cognitive_contexts SET directory_activity_at=");
                update.push($greatest).push("(updated_at,COALESCE((SELECT last_activity_at FROM sessions WHERE context_id=cognitive_contexts.id ORDER BY last_activity_at DESC,id LIMIT 1),updated_at)) WHERE id=").push_bind(id.as_str());
                update.build().execute(&mut *tx).await?;
            }
            tx.commit().await?;
            cursor=keys.last().unwrap().clone();
        }
    }};
}

pub(crate) async fn sqlite(pool: &sqlx::SqlitePool) -> Result<(), Error> {
    let present=sqlx::query_scalar::<_,String>("SELECT name FROM pragma_table_info('session_principal_bindings') WHERE name IN ('directory_context_id','directory_activity_at','directory_status')").fetch_all(pool).await?;
    for column in [
        "directory_context_id",
        "directory_activity_at",
        "directory_status",
    ] {
        if !present.iter().any(|name| name == column) {
            sqlx::query(&format!(
                "ALTER TABLE session_principal_bindings ADD COLUMN {column} TEXT"
            ))
            .execute(pool)
            .await?;
        }
    }
    if sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM pragma_table_info('cognitive_contexts') WHERE name='directory_activity_at'").fetch_one(pool).await? == 0 {
        sqlx::query("ALTER TABLE cognitive_contexts ADD COLUMN directory_activity_at TEXT").execute(pool).await?;
    }
    for statement in [
        "CREATE INDEX IF NOT EXISTS idx_inspection_activation ON thread_activations(context_id,root_turn_id,created_at DESC,id DESC)",
        "CREATE INDEX IF NOT EXISTS idx_inspection_job_activation ON execution_jobs(context_id,activation_id,created_at DESC,id DESC)",
        "CREATE INDEX IF NOT EXISTS idx_inspection_job_thread ON execution_jobs(context_id,thread_id,created_at DESC,id DESC)",
        "CREATE INDEX IF NOT EXISTS idx_inspection_signal ON thread_signals(thread_id,status,created_at DESC,id DESC)",
        "CREATE INDEX IF NOT EXISTS idx_inspection_signal_claim ON activation_signals(activation_id,ordinal DESC,signal_id DESC)",
        "CREATE INDEX IF NOT EXISTS idx_inspection_schedule ON schedules(thread_id,created_at DESC,id DESC)",
        "CREATE INDEX IF NOT EXISTS idx_inspection_job_approval ON approval_requests(job_id,created_at DESC,id DESC)",
        "CREATE INDEX IF NOT EXISTS idx_terminal_thread_page ON threads(context_id,updated_at DESC,id) WHERE status IN ('completed','failed','cancelled')",
        "CREATE INDEX IF NOT EXISTS idx_transfer_thread_recovery ON threads(executor_kind,id) WHERE status='open'",
        "CREATE INDEX IF NOT EXISTS idx_transfer_activation_recovery ON thread_activations(id,root_turn_id) WHERE status IN ('queued','running')",

        "CREATE INDEX IF NOT EXISTS idx_pending_approval_page ON approval_requests(status,created_at,id) WHERE status IN ('pending_auto','pending_human')",


        "CREATE TRIGGER IF NOT EXISTS morphz_binding_directory_insert AFTER INSERT ON session_principal_bindings WHEN NEW.unbound_at IS NULL BEGIN UPDATE session_principal_bindings SET (directory_context_id,directory_activity_at,directory_status)=(SELECT context_id,last_activity_at,status FROM sessions WHERE id=NEW.session_id) WHERE session_id=NEW.session_id AND principal_id=NEW.principal_id; END",
        "CREATE TRIGGER IF NOT EXISTS morphz_binding_directory_rebind AFTER UPDATE OF unbound_at ON session_principal_bindings WHEN NEW.unbound_at IS NULL BEGIN UPDATE session_principal_bindings SET (directory_context_id,directory_activity_at,directory_status)=(SELECT context_id,last_activity_at,status FROM sessions WHERE id=NEW.session_id) WHERE session_id=NEW.session_id AND principal_id=NEW.principal_id; END",
        "CREATE TRIGGER IF NOT EXISTS morphz_session_directory_touch AFTER UPDATE OF context_id,last_activity_at,status ON sessions BEGIN UPDATE session_principal_bindings SET directory_context_id=NEW.context_id,directory_activity_at=NEW.last_activity_at,directory_status=NEW.status WHERE session_id=NEW.id AND unbound_at IS NULL; END",
        "CREATE INDEX IF NOT EXISTS idx_directory_binding_missing ON session_principal_bindings(session_id,principal_id) WHERE unbound_at IS NULL AND directory_activity_at IS NULL",
        "CREATE INDEX IF NOT EXISTS idx_directory_binding_activity ON session_principal_bindings(principal_id,unbound_at,directory_activity_at DESC,session_id)",
        "CREATE INDEX IF NOT EXISTS idx_directory_binding_status_activity ON session_principal_bindings(principal_id,unbound_at,directory_status,directory_activity_at DESC,session_id)",
        "CREATE INDEX IF NOT EXISTS idx_directory_binding_context_activity ON session_principal_bindings(principal_id,unbound_at,directory_context_id,directory_activity_at DESC,session_id)",
        "CREATE INDEX IF NOT EXISTS idx_directory_binding_context_status_activity ON session_principal_bindings(principal_id,unbound_at,directory_context_id,directory_status,directory_activity_at DESC,session_id)",
        "CREATE INDEX IF NOT EXISTS idx_directory_agents_activity ON agents(updated_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_directory_agents_status_activity ON agents(status,updated_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_directory_contexts_activity ON cognitive_contexts(updated_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_directory_contexts_status_activity ON cognitive_contexts(status,updated_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_directory_contexts_agent_activity ON cognitive_contexts(agent_id,updated_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_directory_contexts_agent_status_activity ON cognitive_contexts(agent_id,status,updated_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_directory_sessions_activity ON sessions(last_activity_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_directory_sessions_status_activity ON sessions(status,last_activity_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_directory_sessions_context_status_activity ON sessions(context_id,status,last_activity_at DESC,id)",
    ] {sqlx::query(statement).execute(pool).await?;}
    for statement in [

        "CREATE INDEX IF NOT EXISTS idx_context_activity_missing ON cognitive_contexts(id) WHERE directory_activity_at IS NULL",
        "CREATE INDEX IF NOT EXISTS idx_context_activity ON cognitive_contexts(directory_activity_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_context_status_activity ON cognitive_contexts(status,directory_activity_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_context_session_activity ON sessions(context_id,last_activity_at DESC,id)",
        "CREATE TRIGGER IF NOT EXISTS morphz_context_activity_insert AFTER INSERT ON cognitive_contexts BEGIN UPDATE cognitive_contexts SET directory_activity_at=MAX(updated_at,COALESCE((SELECT last_activity_at FROM sessions WHERE context_id=NEW.id ORDER BY last_activity_at DESC,id LIMIT 1),updated_at)) WHERE id=NEW.id; END",
        "CREATE TRIGGER IF NOT EXISTS morphz_context_activity_touch AFTER UPDATE OF updated_at ON cognitive_contexts BEGIN UPDATE cognitive_contexts SET directory_activity_at=MAX(updated_at,COALESCE((SELECT last_activity_at FROM sessions WHERE context_id=NEW.id ORDER BY last_activity_at DESC,id LIMIT 1),updated_at)) WHERE id=NEW.id; END",
        "CREATE TRIGGER IF NOT EXISTS morphz_context_session_insert AFTER INSERT ON sessions BEGIN UPDATE cognitive_contexts SET directory_activity_at=MAX(updated_at,COALESCE((SELECT last_activity_at FROM sessions WHERE context_id=NEW.context_id ORDER BY last_activity_at DESC,id LIMIT 1),updated_at)) WHERE id=NEW.context_id AND directory_activity_at IS NOT MAX(updated_at,COALESCE((SELECT last_activity_at FROM sessions WHERE context_id=NEW.context_id ORDER BY last_activity_at DESC,id LIMIT 1),updated_at)); END",
        "CREATE TRIGGER IF NOT EXISTS morphz_context_session_delete AFTER DELETE ON sessions BEGIN UPDATE cognitive_contexts SET directory_activity_at=MAX(updated_at,COALESCE((SELECT last_activity_at FROM sessions WHERE context_id=OLD.context_id ORDER BY last_activity_at DESC,id LIMIT 1),updated_at)) WHERE id=OLD.context_id; END",
        "CREATE TRIGGER IF NOT EXISTS morphz_context_session_update AFTER UPDATE OF context_id,last_activity_at ON sessions BEGIN UPDATE cognitive_contexts SET directory_activity_at=MAX(updated_at,COALESCE((SELECT last_activity_at FROM sessions WHERE context_id=cognitive_contexts.id ORDER BY last_activity_at DESC,id LIMIT 1),updated_at)) WHERE id IN (OLD.context_id,NEW.context_id); END",
    ] {sqlx::query(statement).execute(pool).await?;}
    for statement in [

        "CREATE INDEX IF NOT EXISTS idx_group_member_page ON thread_group_members(group_id,ordinal,thread_id)",
        "CREATE INDEX IF NOT EXISTS idx_group_member_counts ON thread_group_members(group_id,required,status,thread_id)",
        "CREATE INDEX IF NOT EXISTS idx_activation_root_terminal_page ON thread_activations(context_id,root_turn_id,updated_at DESC,id DESC) WHERE status IN ('completed','cancelled','failed')",
        "CREATE INDEX IF NOT EXISTS idx_activation_root_live_page ON thread_activations(context_id,root_turn_id,created_at,id) WHERE status IN ('queued','running')",
        "CREATE INDEX IF NOT EXISTS idx_inventory_targets_owner_activity ON execution_targets(owner_principal_id,updated_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_inventory_nodes_owner_activity ON execution_nodes(owner_principal_id,updated_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_inventory_leases_principal_activity ON capability_leases(principal_id,issued_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_inventory_leases_principal_status_activity ON capability_leases(principal_id,status,issued_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_inventory_objectives_activity ON objectives(updated_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_inventory_objectives_context_activity ON objectives(context_id,updated_at DESC,id)",
    ] {sqlx::query(statement).execute(pool).await?;}
    backfill_context_activity!(sqlx::Sqlite, pool, "MAX");
    backfill!(sqlx::Sqlite, pool);
    Ok(())
}

pub(crate) async fn postgres(pool: &sqlx::PgPool) -> Result<(), Error> {
    for statement in [
        "CREATE INDEX IF NOT EXISTS idx_inspection_activation ON thread_activations(context_id,root_turn_id,created_at DESC,id DESC)",
        "CREATE INDEX IF NOT EXISTS idx_inspection_job_activation ON execution_jobs(context_id,activation_id,created_at DESC,id DESC)",
        "CREATE INDEX IF NOT EXISTS idx_inspection_job_thread ON execution_jobs(context_id,thread_id,created_at DESC,id DESC)",
        "CREATE INDEX IF NOT EXISTS idx_inspection_signal ON thread_signals(thread_id,status,created_at DESC,id DESC)",
        "CREATE INDEX IF NOT EXISTS idx_inspection_signal_claim ON activation_signals(activation_id,ordinal DESC,signal_id DESC)",
        "CREATE INDEX IF NOT EXISTS idx_inspection_schedule ON schedules(thread_id,created_at DESC,id DESC)",
        "CREATE INDEX IF NOT EXISTS idx_inspection_job_approval ON approval_requests(job_id,created_at DESC,id DESC)",
        "CREATE INDEX IF NOT EXISTS idx_terminal_thread_page ON threads(context_id,updated_at DESC,id) WHERE status IN ('completed','failed','cancelled')",
        "CREATE INDEX IF NOT EXISTS idx_transfer_thread_recovery ON threads(executor_kind,id) WHERE status='open'",
        "CREATE INDEX IF NOT EXISTS idx_transfer_activation_recovery ON thread_activations(id,root_turn_id) WHERE status IN ('queued','running')",

        "CREATE INDEX IF NOT EXISTS idx_pending_approval_page ON approval_requests(status,created_at,id) WHERE status IN ('pending_auto','pending_human')",


        "ALTER TABLE cognitive_contexts ADD COLUMN IF NOT EXISTS directory_activity_at TEXT",
        "ALTER TABLE session_principal_bindings ADD COLUMN IF NOT EXISTS directory_context_id TEXT",
        "ALTER TABLE session_principal_bindings ADD COLUMN IF NOT EXISTS directory_activity_at TEXT",
        "ALTER TABLE session_principal_bindings ADD COLUMN IF NOT EXISTS directory_status TEXT",
        r#"CREATE OR REPLACE FUNCTION morphz_binding_directory_refresh() RETURNS TRIGGER LANGUAGE plpgsql AS $body$ BEGIN
            SELECT context_id,last_activity_at,status INTO NEW.directory_context_id,NEW.directory_activity_at,NEW.directory_status FROM sessions WHERE id=NEW.session_id;
            RETURN NEW; END $body$"#,
        r#"CREATE OR REPLACE FUNCTION morphz_session_directory_refresh() RETURNS TRIGGER LANGUAGE plpgsql AS $body$ BEGIN
            UPDATE session_principal_bindings SET directory_context_id=NEW.context_id,directory_activity_at=NEW.last_activity_at,directory_status=NEW.status WHERE session_id=NEW.id AND unbound_at IS NULL;
            RETURN NEW; END $body$"#,
        "CREATE TRIGGER morphz_binding_directory_write BEFORE INSERT OR UPDATE OF unbound_at ON session_principal_bindings FOR EACH ROW EXECUTE FUNCTION morphz_binding_directory_refresh()",
        "CREATE TRIGGER morphz_session_directory_touch AFTER UPDATE OF context_id,last_activity_at,status ON sessions FOR EACH ROW EXECUTE FUNCTION morphz_session_directory_refresh()",
        "CREATE INDEX IF NOT EXISTS idx_pg_directory_binding_missing ON session_principal_bindings(session_id,principal_id) WHERE unbound_at IS NULL AND directory_activity_at IS NULL",
        "CREATE INDEX IF NOT EXISTS idx_pg_directory_binding_activity ON session_principal_bindings(principal_id,unbound_at,directory_activity_at DESC,session_id)",
        "CREATE INDEX IF NOT EXISTS idx_pg_directory_binding_status_activity ON session_principal_bindings(principal_id,unbound_at,directory_status,directory_activity_at DESC,session_id)",
        "CREATE INDEX IF NOT EXISTS idx_pg_directory_binding_context_activity ON session_principal_bindings(principal_id,unbound_at,directory_context_id,directory_activity_at DESC,session_id)",
        "CREATE INDEX IF NOT EXISTS idx_pg_directory_binding_context_status_activity ON session_principal_bindings(principal_id,unbound_at,directory_context_id,directory_status,directory_activity_at DESC,session_id)",
        "CREATE INDEX IF NOT EXISTS idx_pg_directory_agents_activity ON agents(updated_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_pg_directory_agents_status_activity ON agents(status,updated_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_pg_directory_contexts_activity ON cognitive_contexts(updated_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_pg_directory_contexts_status_activity ON cognitive_contexts(status,updated_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_pg_directory_contexts_agent_activity ON cognitive_contexts(agent_id,updated_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_pg_directory_contexts_agent_status_activity ON cognitive_contexts(agent_id,status,updated_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_pg_directory_sessions_activity ON sessions(last_activity_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_pg_directory_sessions_status_activity ON sessions(status,last_activity_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_pg_directory_sessions_context_status_activity ON sessions(context_id,status,last_activity_at DESC,id)",
    ] {sqlx::query(statement).execute(pool).await?;}
    for statement in [

        "CREATE INDEX IF NOT EXISTS idx_pg_context_activity_missing ON cognitive_contexts(id) WHERE directory_activity_at IS NULL",
        "CREATE INDEX IF NOT EXISTS idx_pg_context_activity ON cognitive_contexts(directory_activity_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_pg_context_status_activity ON cognitive_contexts(status,directory_activity_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_pg_context_session_activity ON sessions(context_id,last_activity_at DESC,id)",
        r#"CREATE OR REPLACE FUNCTION morphz_context_activity_refresh() RETURNS TRIGGER LANGUAGE plpgsql AS $body$ BEGIN
            NEW.directory_activity_at=GREATEST(NEW.updated_at,COALESCE((SELECT last_activity_at FROM sessions WHERE context_id=NEW.id ORDER BY last_activity_at DESC,id LIMIT 1),NEW.updated_at));
            RETURN NEW; END $body$"#,
        r#"CREATE OR REPLACE FUNCTION morphz_context_session_refresh() RETURNS TRIGGER LANGUAGE plpgsql AS $body$ DECLARE affected TEXT[]; BEGIN
            IF TG_OP='INSERT' THEN affected=ARRAY[NEW.context_id]; ELSIF TG_OP='DELETE' THEN affected=ARRAY[OLD.context_id]; ELSE affected=ARRAY[OLD.context_id,NEW.context_id]; END IF;
            UPDATE cognitive_contexts c SET directory_activity_at=GREATEST(c.updated_at,COALESCE((SELECT last_activity_at FROM sessions WHERE context_id=c.id ORDER BY last_activity_at DESC,id LIMIT 1),c.updated_at)) WHERE c.id=ANY(affected) AND c.directory_activity_at IS DISTINCT FROM GREATEST(c.updated_at,COALESCE((SELECT last_activity_at FROM sessions WHERE context_id=c.id ORDER BY last_activity_at DESC,id LIMIT 1),c.updated_at));
            RETURN NULL; END $body$"#,
        "CREATE TRIGGER morphz_context_activity_write BEFORE INSERT OR UPDATE OF updated_at ON cognitive_contexts FOR EACH ROW EXECUTE FUNCTION morphz_context_activity_refresh()",
        "CREATE TRIGGER morphz_context_session_write AFTER INSERT OR DELETE OR UPDATE OF context_id,last_activity_at ON sessions FOR EACH ROW EXECUTE FUNCTION morphz_context_session_refresh()",
    ] {sqlx::query(statement).execute(pool).await?;}
    for statement in [

        "CREATE INDEX IF NOT EXISTS idx_group_member_page ON thread_group_members(group_id,ordinal,thread_id)",
        "CREATE INDEX IF NOT EXISTS idx_group_member_counts ON thread_group_members(group_id,required,status,thread_id)",
        "CREATE INDEX IF NOT EXISTS idx_activation_root_terminal_page ON thread_activations(context_id,root_turn_id,updated_at DESC,id DESC) WHERE status IN ('completed','cancelled','failed')",
        "CREATE INDEX IF NOT EXISTS idx_activation_root_live_page ON thread_activations(context_id,root_turn_id,created_at,id) WHERE status IN ('queued','running')",
        "CREATE INDEX IF NOT EXISTS idx_inventory_targets_owner_activity ON execution_targets(owner_principal_id,updated_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_inventory_nodes_owner_activity ON execution_nodes(owner_principal_id,updated_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_inventory_leases_principal_activity ON capability_leases(principal_id,issued_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_inventory_leases_principal_status_activity ON capability_leases(principal_id,status,issued_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_inventory_objectives_activity ON objectives(updated_at DESC,id)",
        "CREATE INDEX IF NOT EXISTS idx_inventory_objectives_context_activity ON objectives(context_id,updated_at DESC,id)",
    ] {sqlx::query(statement).execute(pool).await?;}
    backfill_context_activity!(sqlx::Postgres, pool, "GREATEST");
    backfill!(sqlx::Postgres, pool);
    Ok(())
}
