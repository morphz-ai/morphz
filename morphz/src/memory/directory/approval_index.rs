//! Ordering keys only. Native Job, Session and binding relations remain the
//! authority and are checked before a page LIMIT.
use sqlx::Row;
type Error = Box<dyn std::error::Error + Send + Sync>;
const COLUMNS: &[(&str, &str)] = &[
    ("directory_context_id", "TEXT"),
    ("directory_session_id", "TEXT"),
    ("directory_principal_id", "TEXT"),
    ("directory_thread_id", "TEXT"),
];
const PROJECTION: &str = "(directory_context_id,directory_session_id,directory_principal_id,directory_thread_id)=(SELECT context_id,session_id,initiating_principal_id,thread_id FROM execution_jobs WHERE execution_jobs.id=approval_requests.job_id)";
macro_rules! backfill {
    ($db:ty,$pool:expr) => {{
        let mut after = String::new();
        loop {
            let mut q = sqlx::QueryBuilder::<$db>::new(
                "SELECT id FROM approval_requests WHERE directory_thread_id IS NULL AND id>",
            );
            q.push_bind(after.clone()).push(" ORDER BY id LIMIT 200");
            let rows = q.build().fetch_all($pool).await?;
            if rows.is_empty() {
                break;
            }
            after = rows.last().unwrap().get("id");
            let mut q = sqlx::QueryBuilder::<$db>::new("UPDATE approval_requests SET ");
            q.push(PROJECTION).push(" WHERE id IN (");
            {
                let mut keys = q.separated(",");
                for row in rows {
                    keys.push_bind(row.get::<String, _>("id"));
                }
            }
            q.push(")");
            q.build().execute($pool).await?;
        }
    }};
}
const INDEXES: &[&str] = &[
    "CREATE INDEX IF NOT EXISTS idx_approval_thread_missing ON approval_requests(id) WHERE directory_thread_id IS NULL",
    "CREATE INDEX IF NOT EXISTS idx_approval_execution_page ON approval_requests(directory_context_id,directory_session_id,directory_thread_id,status,created_at,id)",
    "CREATE INDEX IF NOT EXISTS idx_approval_session_page ON approval_requests(directory_context_id,directory_session_id,status,created_at,id)",
    "CREATE INDEX IF NOT EXISTS idx_approval_directory_missing ON approval_requests(id) WHERE directory_context_id IS NULL",
    "CREATE INDEX IF NOT EXISTS idx_approval_context_page ON approval_requests(directory_context_id,status,created_at,id)",
    "CREATE INDEX IF NOT EXISTS idx_approval_principal_page ON approval_requests(directory_session_id,directory_principal_id,status,created_at,id)",
];
pub(crate) async fn sqlite(pool: &sqlx::SqlitePool) -> Result<(), Error> {
    for (name, kind) in COLUMNS {
        let mut q = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
            "SELECT COUNT(*) FROM pragma_table_info('approval_requests') WHERE name=",
        );
        q.push_bind(*name);
        if q.build_query_scalar::<i64>().fetch_one(pool).await? == 0 {
            sqlx::query(&format!(
                "ALTER TABLE approval_requests ADD COLUMN {name} {kind}"
            ))
            .execute(pool)
            .await?;
        }
    }
    for sql in INDEXES {
        sqlx::query(sql).execute(pool).await?;
    }
    let installed:Option<String>=sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='morphz_approval_directory_insert'").fetch_optional(pool).await?;
    if !installed.is_some_and(|sql| sql.contains("directory_thread_id")) {
        let mut transaction = pool.begin().await?;
        for name in [
            "morphz_approval_directory_insert",
            "morphz_approval_directory_update",
            "morphz_approval_job_directory",
        ] {
            sqlx::query(&format!("DROP TRIGGER IF EXISTS {name}"))
                .execute(&mut *transaction)
                .await?;
        }
        for sql in [
        format!("CREATE TRIGGER IF NOT EXISTS morphz_approval_directory_insert AFTER INSERT ON approval_requests BEGIN UPDATE approval_requests SET {PROJECTION} WHERE id=NEW.id; END"),
        format!("CREATE TRIGGER IF NOT EXISTS morphz_approval_directory_update AFTER UPDATE OF job_id ON approval_requests WHEN OLD.job_id IS NOT NEW.job_id BEGIN UPDATE approval_requests SET {PROJECTION} WHERE id=NEW.id; END"),
        "CREATE TRIGGER IF NOT EXISTS morphz_approval_job_directory AFTER UPDATE OF context_id,session_id,initiating_principal_id,thread_id ON execution_jobs WHEN OLD.thread_id IS NOT NEW.thread_id OR OLD.context_id IS NOT NEW.context_id OR OLD.session_id IS NOT NEW.session_id OR OLD.initiating_principal_id IS NOT NEW.initiating_principal_id BEGIN UPDATE approval_requests SET directory_context_id=NEW.context_id,directory_session_id=NEW.session_id,directory_principal_id=NEW.initiating_principal_id,directory_thread_id=NEW.thread_id WHERE job_id=NEW.id; END".into(),
    ] {sqlx::query(&sql).execute(&mut *transaction).await?;}
        transaction.commit().await?;
    }
    backfill!(sqlx::Sqlite, pool);
    Ok(())
}
pub(crate) async fn postgres(pool: &sqlx::PgPool) -> Result<(), Error> {
    for (name, kind) in COLUMNS {
        sqlx::query(&format!(
            "ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS {name} {kind}"
        ))
        .execute(pool)
        .await?;
    }
    for sql in INDEXES {
        sqlx::query(sql).execute(pool).await?;
    }

    for sql in [
        format!("CREATE OR REPLACE FUNCTION morphz_approval_directory() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE approval_requests SET {PROJECTION} WHERE id=NEW.id; RETURN NULL; END $$"),
        "CREATE OR REPLACE FUNCTION morphz_approval_job_directory() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE approval_requests SET directory_context_id=NEW.context_id,directory_session_id=NEW.session_id,directory_principal_id=NEW.initiating_principal_id,directory_thread_id=NEW.thread_id WHERE job_id=NEW.id; RETURN NULL; END $$".into(),
        "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='approval_requests'::regclass AND tgname='morphz_approval_directory_insert') THEN CREATE TRIGGER morphz_approval_directory_insert AFTER INSERT ON approval_requests FOR EACH ROW EXECUTE FUNCTION morphz_approval_directory(); END IF; END $$".into(),
        "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='approval_requests'::regclass AND tgname='morphz_approval_directory_update') THEN CREATE TRIGGER morphz_approval_directory_update AFTER UPDATE OF job_id ON approval_requests FOR EACH ROW WHEN (OLD.job_id IS DISTINCT FROM NEW.job_id) EXECUTE FUNCTION morphz_approval_directory(); END IF; END $$".into(),
        "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='execution_jobs'::regclass AND tgname='morphz_approval_job_directory') THEN CREATE TRIGGER morphz_approval_job_directory AFTER UPDATE OF context_id,session_id,initiating_principal_id,thread_id ON execution_jobs FOR EACH ROW WHEN (OLD.thread_id IS DISTINCT FROM NEW.thread_id OR OLD.context_id IS DISTINCT FROM NEW.context_id OR OLD.session_id IS DISTINCT FROM NEW.session_id OR OLD.initiating_principal_id IS DISTINCT FROM NEW.initiating_principal_id) EXECUTE FUNCTION morphz_approval_job_directory(); END IF; END $$".into(),
    ] {sqlx::query(&sql).execute(pool).await?;}
    sqlx::query("DO $$ BEGIN DROP TRIGGER IF EXISTS morphz_approval_job_directory ON execution_jobs; CREATE TRIGGER morphz_approval_job_directory AFTER UPDATE OF context_id,session_id,initiating_principal_id,thread_id ON execution_jobs FOR EACH ROW WHEN (OLD.context_id IS DISTINCT FROM NEW.context_id OR OLD.session_id IS DISTINCT FROM NEW.session_id OR OLD.initiating_principal_id IS DISTINCT FROM NEW.initiating_principal_id OR OLD.thread_id IS DISTINCT FROM NEW.thread_id) EXECUTE FUNCTION morphz_approval_job_directory(); END $$").execute(pool).await?;
    backfill!(sqlx::Postgres, pool);
    Ok(())
}
