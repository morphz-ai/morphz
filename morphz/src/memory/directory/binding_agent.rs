//! Agent-filtered participant directory seeks. The original binding and Session
//! are still checked by the query; these disposable keys confer no authority.
use sqlx::Row;
type Error = Box<dyn std::error::Error + Send + Sync>;
const INDEXES:&[&str]=&[
    "CREATE INDEX IF NOT EXISTS idx_binding_agent_missing ON session_principal_bindings(session_id,principal_id) WHERE unbound_at IS NULL AND directory_agent_id IS NULL",
    "CREATE INDEX IF NOT EXISTS idx_binding_agent_activity ON session_principal_bindings(principal_id,unbound_at,directory_agent_id,directory_activity_at DESC,session_id)",
    "CREATE INDEX IF NOT EXISTS idx_binding_agent_status_activity ON session_principal_bindings(principal_id,unbound_at,directory_agent_id,directory_status,directory_activity_at DESC,session_id)",
    "CREATE INDEX IF NOT EXISTS idx_binding_agent_context_activity ON session_principal_bindings(principal_id,unbound_at,directory_agent_id,directory_context_id,directory_activity_at DESC,session_id)",
    "CREATE INDEX IF NOT EXISTS idx_binding_agent_context_status_activity ON session_principal_bindings(principal_id,unbound_at,directory_agent_id,directory_context_id,directory_status,directory_activity_at DESC,session_id)",
    "CREATE INDEX IF NOT EXISTS idx_sessions_agent_activity ON sessions(agent_id,last_activity_at DESC,id)",
    "CREATE INDEX IF NOT EXISTS idx_sessions_agent_status_activity ON sessions(agent_id,status,last_activity_at DESC,id)",
    "CREATE INDEX IF NOT EXISTS idx_sessions_agent_context_activity ON sessions(agent_id,context_id,last_activity_at DESC,id)",
    "CREATE INDEX IF NOT EXISTS idx_sessions_agent_context_status_activity ON sessions(agent_id,context_id,status,last_activity_at DESC,id)",
];
macro_rules! backfill {
 ($db:ty,$pool:expr)=>{{
    let mut key=(String::new(),String::new());
    loop{
        let mut q=sqlx::QueryBuilder::<$db>::new("SELECT session_id,principal_id FROM session_principal_bindings WHERE unbound_at IS NULL AND directory_agent_id IS NULL AND (session_id,principal_id)>(");q.push_bind(key.0.clone()).push(",").push_bind(key.1.clone()).push(") ORDER BY session_id,principal_id LIMIT 200");
        let rows=q.build().fetch_all($pool).await?;if rows.is_empty(){break;}
        let last=rows.last().unwrap();key=(last.get("session_id"),last.get("principal_id"));
        let mut tx=$pool.begin().await?;
        for row in rows{
            let mut q=sqlx::QueryBuilder::<$db>::new("UPDATE session_principal_bindings SET directory_agent_id=(SELECT agent_id FROM sessions WHERE id=session_principal_bindings.session_id) WHERE session_id=");q.push_bind(row.get::<String,_>("session_id")).push(" AND principal_id=").push_bind(row.get::<String,_>("principal_id"));q.build().execute(&mut *tx).await?;
        }
        tx.commit().await?;
    }
 }};
}
pub(crate) async fn sqlite(pool: &sqlx::SqlitePool) -> Result<(), Error> {
    if sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM pragma_table_info('session_principal_bindings') WHERE name='directory_agent_id'").fetch_one(pool).await?==0{
        sqlx::query("ALTER TABLE session_principal_bindings ADD COLUMN directory_agent_id TEXT").execute(pool).await?;
    }
    for sql in INDEXES {
        sqlx::query(sql).execute(pool).await?;
    }
    for sql in [
        "CREATE TRIGGER IF NOT EXISTS morphz_binding_agent_insert AFTER INSERT ON session_principal_bindings WHEN NEW.unbound_at IS NULL BEGIN UPDATE session_principal_bindings SET directory_agent_id=(SELECT agent_id FROM sessions WHERE id=NEW.session_id) WHERE session_id=NEW.session_id AND principal_id=NEW.principal_id; END",
        "CREATE TRIGGER IF NOT EXISTS morphz_binding_agent_rebind AFTER UPDATE OF unbound_at ON session_principal_bindings WHEN NEW.unbound_at IS NULL BEGIN UPDATE session_principal_bindings SET directory_agent_id=(SELECT agent_id FROM sessions WHERE id=NEW.session_id) WHERE session_id=NEW.session_id AND principal_id=NEW.principal_id; END",
        "CREATE TRIGGER IF NOT EXISTS morphz_session_binding_agent AFTER UPDATE OF agent_id ON sessions WHEN OLD.agent_id IS NOT NEW.agent_id BEGIN UPDATE session_principal_bindings SET directory_agent_id=NEW.agent_id WHERE session_id=NEW.id AND unbound_at IS NULL; END",
    ]{sqlx::query(sql).execute(pool).await?;}
    backfill!(sqlx::Sqlite, pool);
    Ok(())
}
pub(crate) async fn postgres(pool: &sqlx::PgPool) -> Result<(), Error> {
    sqlx::query(
        "ALTER TABLE session_principal_bindings ADD COLUMN IF NOT EXISTS directory_agent_id TEXT",
    )
    .execute(pool)
    .await?;
    for sql in INDEXES {
        sqlx::query(sql).execute(pool).await?;
    }
    for sql in [
        "CREATE OR REPLACE FUNCTION morphz_binding_agent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE session_principal_bindings SET directory_agent_id=(SELECT agent_id FROM sessions WHERE id=NEW.session_id) WHERE session_id=NEW.session_id AND principal_id=NEW.principal_id; RETURN NULL; END $$",
        "CREATE OR REPLACE FUNCTION morphz_session_binding_agent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE session_principal_bindings SET directory_agent_id=NEW.agent_id WHERE session_id=NEW.id AND unbound_at IS NULL; RETURN NULL; END $$",
        "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='session_principal_bindings'::regclass AND tgname='morphz_binding_agent_insert') THEN CREATE TRIGGER morphz_binding_agent_insert AFTER INSERT ON session_principal_bindings FOR EACH ROW WHEN (NEW.unbound_at IS NULL) EXECUTE FUNCTION morphz_binding_agent(); END IF; END $$",
        "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='session_principal_bindings'::regclass AND tgname='morphz_binding_agent_rebind') THEN CREATE TRIGGER morphz_binding_agent_rebind AFTER UPDATE OF unbound_at ON session_principal_bindings FOR EACH ROW WHEN (NEW.unbound_at IS NULL) EXECUTE FUNCTION morphz_binding_agent(); END IF; END $$",
        "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='sessions'::regclass AND tgname='morphz_session_binding_agent') THEN CREATE TRIGGER morphz_session_binding_agent AFTER UPDATE OF agent_id ON sessions FOR EACH ROW WHEN (OLD.agent_id IS DISTINCT FROM NEW.agent_id) EXECUTE FUNCTION morphz_session_binding_agent(); END IF; END $$",
    ]{sqlx::query(sql).execute(pool).await?;}
    backfill!(sqlx::Postgres, pool);
    Ok(())
}
