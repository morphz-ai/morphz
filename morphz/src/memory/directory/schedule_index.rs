//! Context-leading Schedule read keys, maintained in the source transaction.
//! The live Thread relation remains the scope authority.
use sqlx::Row;
type Error = Box<dyn std::error::Error + Send + Sync>;
const BUCKET: &str = "CASE WHEN status IN ('queued','paused') THEN 0 ELSE 1 END";
macro_rules! backfill {
 ($db:ty,$pool:expr)=>{{
  let mut after=String::new();
  loop {
   let mut query=sqlx::QueryBuilder::<$db>::new("SELECT id FROM schedules WHERE (directory_context_id IS NULL OR directory_bucket IS NULL) AND id>");query.push_bind(after.clone()).push(" ORDER BY id LIMIT 200");
   let rows=query.build().fetch_all($pool).await?;if rows.is_empty(){break;}
   after=rows.last().unwrap().get("id");
   let mut update=sqlx::QueryBuilder::<$db>::new("UPDATE schedules SET directory_context_id=(SELECT context_id FROM threads WHERE threads.id=schedules.thread_id),directory_bucket=");update.push(BUCKET).push(" WHERE id IN (");
   {let mut ids=update.separated(",");for row in rows {ids.push_bind(row.get::<String,_>("id"));}}update.push(")");update.build().execute($pool).await?;
  }
 }};
}
pub(crate) async fn sqlite(pool: &sqlx::SqlitePool) -> Result<(), Error> {
    for (column, kind) in [
        ("directory_context_id", "TEXT"),
        ("directory_bucket", "INTEGER"),
    ] {
        let mut query = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
            "SELECT COUNT(*) FROM pragma_table_info('schedules') WHERE name=",
        );
        query.push_bind(column);
        let exists: i64 = query.build_query_scalar().fetch_one(pool).await?;
        if exists == 0 {
            sqlx::query(&format!("ALTER TABLE schedules ADD COLUMN {column} {kind}"))
                .execute(pool)
                .await?;
        }
    }
    for sql in [
  "CREATE INDEX IF NOT EXISTS idx_schedule_directory_missing ON schedules(id) WHERE directory_context_id IS NULL OR directory_bucket IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_schedule_directory ON schedules(directory_context_id,directory_bucket,updated_at DESC,id)",
  "CREATE TRIGGER IF NOT EXISTS morphz_schedule_directory_insert AFTER INSERT ON schedules BEGIN UPDATE schedules SET directory_context_id=(SELECT context_id FROM threads WHERE id=NEW.thread_id),directory_bucket=CASE WHEN status IN ('queued','paused') THEN 0 ELSE 1 END WHERE id=NEW.id; END",
  "CREATE TRIGGER IF NOT EXISTS morphz_schedule_directory_update AFTER UPDATE OF thread_id,status ON schedules WHEN OLD.thread_id IS NOT NEW.thread_id OR OLD.status IS NOT NEW.status BEGIN UPDATE schedules SET directory_context_id=(SELECT context_id FROM threads WHERE id=NEW.thread_id),directory_bucket=CASE WHEN status IN ('queued','paused') THEN 0 ELSE 1 END WHERE id=NEW.id; END",
  "CREATE TRIGGER IF NOT EXISTS morphz_thread_schedule_directory AFTER UPDATE OF context_id ON threads WHEN OLD.context_id IS NOT NEW.context_id BEGIN UPDATE schedules SET directory_context_id=NEW.context_id WHERE thread_id=NEW.id; END",
 ] {sqlx::query(sql).execute(pool).await?;}
    backfill!(sqlx::Sqlite, pool);
    Ok(())
}
pub(crate) async fn postgres(pool: &sqlx::PgPool) -> Result<(), Error> {
    for sql in [
  "ALTER TABLE schedules ADD COLUMN IF NOT EXISTS directory_context_id TEXT",
  "ALTER TABLE schedules ADD COLUMN IF NOT EXISTS directory_bucket INTEGER",
  "CREATE INDEX IF NOT EXISTS idx_schedule_directory_missing ON schedules(id) WHERE directory_context_id IS NULL OR directory_bucket IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_schedule_directory ON schedules(directory_context_id,directory_bucket,updated_at DESC,id)",
  "CREATE OR REPLACE FUNCTION morphz_schedule_directory() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE schedules SET directory_context_id=(SELECT context_id FROM threads WHERE id=NEW.thread_id),directory_bucket=CASE WHEN status IN ('queued','paused') THEN 0 ELSE 1 END WHERE id=NEW.id; RETURN NULL; END $$",
  "DO $morphz_trigger$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='schedules'::regclass AND tgname='morphz_schedule_directory_insert') THEN CREATE TRIGGER morphz_schedule_directory_insert AFTER INSERT ON schedules FOR EACH ROW EXECUTE FUNCTION morphz_schedule_directory(); END IF; END $morphz_trigger$",
  "DO $morphz_trigger$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='schedules'::regclass AND tgname='morphz_schedule_directory_update') THEN CREATE TRIGGER morphz_schedule_directory_update AFTER UPDATE OF thread_id,status ON schedules FOR EACH ROW WHEN (OLD.thread_id IS DISTINCT FROM NEW.thread_id OR OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION morphz_schedule_directory(); END IF; END $morphz_trigger$",
  "CREATE OR REPLACE FUNCTION morphz_thread_schedule_directory() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE schedules SET directory_context_id=NEW.context_id WHERE thread_id=NEW.id; RETURN NULL; END $$",
  "DO $morphz_trigger$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='threads'::regclass AND tgname='morphz_thread_schedule_directory') THEN CREATE TRIGGER morphz_thread_schedule_directory AFTER UPDATE OF context_id ON threads FOR EACH ROW WHEN (OLD.context_id IS DISTINCT FROM NEW.context_id) EXECUTE FUNCTION morphz_thread_schedule_directory(); END IF; END $morphz_trigger$",
 ] {sqlx::query(sql).execute(pool).await?;}
    backfill!(sqlx::Postgres, pool);
    Ok(())
}
macro_rules! schedule_inventory_query {
 ($db:ty,$context:expr,$terminal:expr,$limit:expr)=>{{
  let mut query=sqlx::QueryBuilder::<$db>::new("SELECT s.* FROM schedules s");
  // Preserve the ordered Schedule range as the driving relation. A plain
  // join allowed PostgreSQL to hash both retained lifetimes before LIMIT.
  // The limited lateral point is still a native scope proof BEFORE LIMIT,
  // never a post-page authorization filter. SQLite's CROSS JOIN has the same
  // driving-order contract without a backend planner switch or index hint.
  if stringify!($db).contains("Postgres") {
    query.push(" CROSS JOIN LATERAL (SELECT id FROM threads native_thread WHERE native_thread.id=s.thread_id AND native_thread.context_id=").push_bind($context.to_string()).push(" LIMIT 1) native_scope WHERE s.directory_context_id=").push_bind($context.to_string());
  }else{
    query.push(" CROSS JOIN threads native_thread WHERE native_thread.id=s.thread_id AND native_thread.context_id=").push_bind($context.to_string()).push(" AND s.directory_context_id=").push_bind($context.to_string());
  }
  if !$terminal {query.push(" AND s.directory_bucket=0 AND s.status IN ('queued','paused')");}
  query.push(" ORDER BY s.directory_bucket,s.updated_at DESC,s.id LIMIT ").push_bind($limit.clamp(1,201) as i64);query
 }};
}
pub(crate) use schedule_inventory_query;
