//! Bounded startup recovery locators, not another execution authority.
#[derive(Default)]
pub(crate) struct ContextRecoveryPages {
    cursor: Option<String>,
    finished: bool,
}
impl ContextRecoveryPages {
    pub(crate) async fn next(
        &mut self,
        store: &dyn super::SessionDirectoryStore,
    ) -> Result<Option<Vec<super::CognitiveContextRecord>>, Box<dyn std::error::Error + Send + Sync>>
    {
        if self.finished {
            return Ok(None);
        }
        let page = store
            .read_runtime_directory_page(super::RuntimeDirectoryQuery {
                kind: super::RuntimeDirectoryKind::Contexts,
                identity_order: true,
                cursor: self.cursor.clone(),
                limit: 200,
                ..Default::default()
            })
            .await?;
        if page.has_more {
            let next = page
                .next_cursor
                .ok_or("Context recovery continuation is missing")?;
            if self.cursor.as_ref() == Some(&next) {
                return Err("Context recovery cursor did not advance".into());
            }
            self.cursor = Some(next);
        } else {
            self.finished = true;
        }
        Ok(Some(page.contexts))
    }
}
#[derive(Debug, Clone, Copy)]
pub enum TransferProjectionSource {
    OpenThreads,
    LiveActivations,
}
#[derive(Debug, Clone)]
pub struct TransferProjectionCandidate {
    pub cursor_id: String,
    pub thread_id: String,
    pub job_id: Option<String>,
}
macro_rules! transfer_query {
 ($db:ty,$source:expr,$after:expr,$limit:expr,$postgres:expr)=>{{
  use crate::memory::TransferProjectionSource;
  let mut query=sqlx::QueryBuilder::<$db>::new(match $source {
   TransferProjectionSource::OpenThreads=>"SELECT t.id AS cursor_id,t.id AS thread_id,t.executor_id AS job_id FROM threads t WHERE t.status='open'",
   TransferProjectionSource::LiveActivations=>if $postgres {
    "SELECT a.id AS cursor_id,t.id AS thread_id,t.executor_id AS job_id FROM thread_activations a CROSS JOIN LATERAL (SELECT th.id,th.executor_id,th.executor_kind FROM threads th WHERE th.root_turn_id=a.root_turn_id LIMIT 1) t WHERE a.status IN ('queued','running')"
   }else{
    "SELECT a.id AS cursor_id,t.id AS thread_id,t.executor_id AS job_id FROM thread_activations a CROSS JOIN threads t WHERE a.status IN ('queued','running') AND t.root_turn_id=a.root_turn_id"
   },
  });
  query.push(" AND t.executor_kind='artifact_transfer' AND ")
    .push(match $source {TransferProjectionSource::OpenThreads=>"t.id",TransferProjectionSource::LiveActivations=>"a.id"})
    .push(" > ").push_bind($after.to_owned())
    .push(" ORDER BY cursor_id LIMIT ").push_bind(($limit.clamp(1,200)+1) as i64);
  query
 }};
}
pub(crate) use transfer_query;

#[derive(Debug, Clone, Copy)]
pub enum SchedulerRecoverySource {
    LiveActivations,
    PendingSignalThreads,
    OpenThreads,
}

#[derive(Debug, Clone)]
pub struct SchedulerRecoveryLocator {
    pub cursor_id: String,
    pub context_id: String,
    pub entity_id: String,
    pub event_id: Option<String>,
}

pub(crate) const SCHEDULER_RECOVERY_INDEXES: &str = "
CREATE INDEX IF NOT EXISTS activation_recovery_queued ON thread_activations(context_id,id) WHERE status='queued';
CREATE INDEX IF NOT EXISTS activation_recovery_running ON thread_activations(context_id,id) WHERE status='running';
CREATE INDEX IF NOT EXISTS signal_recovery_pending_thread ON thread_signals(directory_context_id,thread_id,sequence,id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS thread_recovery_open ON threads(context_id,id) WHERE status='open';
CREATE INDEX IF NOT EXISTS thread_recovery_required_dependency ON scheduler_dependencies(owner_id) WHERE owner_kind='thread' AND required=TRUE AND status='pending';
";

pub(crate) async fn sqlite_scheduler_indexes(
    pool: &sqlx::SqlitePool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use sqlx::Row;
    let mut tx = pool.begin().await?;
    let columns = sqlx::query("PRAGMA table_info(thread_signals)")
        .fetch_all(&mut *tx)
        .await?;
    if !columns
        .iter()
        .any(|row| row.get::<String, _>("name") == "directory_context_id")
    {
        sqlx::query("ALTER TABLE thread_signals ADD COLUMN directory_context_id TEXT")
            .execute(&mut *tx)
            .await?;
    }
    for sql in [
      "CREATE TRIGGER IF NOT EXISTS signal_recovery_directory_insert AFTER INSERT ON thread_signals BEGIN UPDATE thread_signals SET directory_context_id=(SELECT context_id FROM threads WHERE id=NEW.thread_id) WHERE id=NEW.id; END",
      "CREATE TRIGGER IF NOT EXISTS signal_recovery_directory_update AFTER UPDATE OF thread_id,status ON thread_signals BEGIN UPDATE thread_signals SET directory_context_id=(SELECT context_id FROM threads WHERE id=NEW.thread_id) WHERE id=NEW.id; END",
      "CREATE TRIGGER IF NOT EXISTS signal_recovery_thread_move AFTER UPDATE OF context_id ON threads WHEN OLD.context_id<>NEW.context_id BEGIN UPDATE thread_signals SET directory_context_id=NEW.context_id WHERE thread_id=NEW.id; END",
      "CREATE INDEX IF NOT EXISTS signal_recovery_directory_missing ON thread_signals(id) WHERE status='pending' AND directory_context_id IS NULL",
    ] {sqlx::query(sql).execute(&mut *tx).await?;}
    tx.commit().await?;
    loop {
        let ids=sqlx::query_scalar::<_,String>("SELECT id FROM thread_signals WHERE status='pending' AND directory_context_id IS NULL ORDER BY id LIMIT 200").fetch_all(pool).await?;
        if ids.is_empty() {
            break;
        }
        let mut q=sqlx::QueryBuilder::<sqlx::Sqlite>::new("UPDATE thread_signals SET directory_context_id=(SELECT context_id FROM threads WHERE id=thread_signals.thread_id) WHERE id IN (");
        {
            let mut keys = q.separated(",");
            for id in &ids {
                keys.push_bind(id);
            }
        }
        q.push(")");
        q.build().execute(pool).await?;
        // Check the exact backfilled page, not an arbitrary unresolved row.
        // Another missing parent outside this page must not hide its failure.
        let mut check = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
            "SELECT id FROM thread_signals WHERE status='pending' AND directory_context_id IS NULL AND id IN (",
        );
        {
            let mut keys = check.separated(",");
            for id in &ids {
                keys.push_bind(id);
            }
        }
        check.push(") LIMIT 1");
        let missing: Option<String> = check.build_query_scalar().fetch_optional(pool).await?;
        if missing.is_some() {
            return Err("Signal recovery index has a missing native Thread".into());
        }
    }
    let mut tx = pool.begin().await?;
    for statement in SCHEDULER_RECOVERY_INDEXES
        .split(';')
        .filter(|sql| !sql.trim().is_empty())
    {
        sqlx::query(statement).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn postgres_scheduler_indexes(
    pool: &sqlx::PgPool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut tx = pool.begin().await?;
    for sql in [
      "ALTER TABLE thread_signals ADD COLUMN IF NOT EXISTS directory_context_id TEXT",
      "CREATE OR REPLACE FUNCTION morphz_signal_recovery_directory() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.directory_context_id=(SELECT context_id FROM threads WHERE id=NEW.thread_id); RETURN NEW; END $$",
      "CREATE OR REPLACE FUNCTION morphz_signal_recovery_thread_move() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE thread_signals SET directory_context_id=NEW.context_id WHERE thread_id=NEW.id; RETURN NEW; END $$",
      "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='signal_recovery_directory_write' AND tgrelid='thread_signals'::regclass) THEN CREATE TRIGGER signal_recovery_directory_write BEFORE INSERT OR UPDATE OF thread_id,status ON thread_signals FOR EACH ROW EXECUTE FUNCTION morphz_signal_recovery_directory(); END IF; IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='signal_recovery_thread_move' AND tgrelid='threads'::regclass) THEN CREATE TRIGGER signal_recovery_thread_move AFTER UPDATE OF context_id ON threads FOR EACH ROW WHEN(OLD.context_id IS DISTINCT FROM NEW.context_id) EXECUTE FUNCTION morphz_signal_recovery_thread_move(); END IF; END $$",
      "CREATE INDEX IF NOT EXISTS signal_recovery_directory_missing ON thread_signals(id) WHERE status='pending' AND directory_context_id IS NULL",
    ] {sqlx::query(sql).execute(&mut *tx).await?;}
    tx.commit().await?;
    loop {
        let rows=sqlx::query("SELECT id FROM thread_signals WHERE status='pending' AND directory_context_id IS NULL ORDER BY id LIMIT 200").fetch_all(pool).await?;
        use sqlx::Row;
        let ids = rows
            .iter()
            .map(|row| row.get::<String, _>("id"))
            .collect::<Vec<_>>();
        if ids.is_empty() {
            break;
        }
        sqlx::query("UPDATE thread_signals SET directory_context_id=(SELECT context_id FROM threads WHERE id=thread_signals.thread_id) WHERE id=ANY($1)").bind(&ids).execute(pool).await?;
        // Check the exact backfilled page, not an arbitrary unresolved row.
        // Another missing parent outside this page must not hide its failure.
        let mut check = sqlx::QueryBuilder::<sqlx::Postgres>::new(
            "SELECT id FROM thread_signals WHERE status='pending' AND directory_context_id IS NULL AND id IN (",
        );
        {
            let mut keys = check.separated(",");
            for id in &ids {
                keys.push_bind(id);
            }
        }
        check.push(") LIMIT 1");
        let missing: Option<String> = check.build_query_scalar().fetch_optional(pool).await?;
        if missing.is_some() {
            return Err("Signal recovery index has a missing native Thread".into());
        }
    }
    let mut tx = pool.begin().await?;
    for statement in SCHEDULER_RECOVERY_INDEXES
        .split(';')
        .filter(|sql| !sql.trim().is_empty())
    {
        sqlx::query(statement).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Pending Signal rows are ordered by Thread, then sequence. A recovery page
/// dispatches its first Signal per Thread and advances past the last Thread;
/// its native mailbox then owns the remaining Signals. No lifetime DISTINCT,
/// grouping scan, or in-memory all-Thread set is needed to find those heads.
macro_rules! scheduler_query {
    ($db:ty,$source:expr,$context:expr,$after:expr,$limit:expr) => {{
        use crate::memory::SchedulerRecoverySource;
        let source=$source; let context=$context; let after=$after;
        let count=($limit.clamp(1,200)+1) as i64;
        let mut q=sqlx::QueryBuilder::<$db>::new("");
        match source {
            SchedulerRecoverySource::OpenThreads => {
                q.push("SELECT id AS cursor_id,context_id,id AS entity_id,CAST(NULL AS TEXT) AS event_id FROM threads WHERE context_id=").push_bind(context.to_string())
                    .push(" AND status='open' AND id>").push_bind(after.to_string()).push(" ORDER BY id LIMIT ").push_bind(count);
            }
            SchedulerRecoverySource::PendingSignalThreads => {
                q.push("SELECT s.thread_id AS cursor_id,s.directory_context_id AS context_id,s.thread_id AS entity_id,s.event_id FROM thread_signals s ");
                if stringify!($db).contains("Postgres") {
                    q.push("CROSS JOIN LATERAL (SELECT id FROM threads t WHERE t.id=s.thread_id AND t.context_id=s.directory_context_id LIMIT 1) native WHERE ");
                } else {q.push("CROSS JOIN threads native WHERE native.id=s.thread_id AND native.context_id=s.directory_context_id AND ");}
                q.push("s.directory_context_id=").push_bind(context.to_string())
                    .push(" AND s.status='pending' AND s.thread_id>").push_bind(after.to_string())
                    .push(" ORDER BY s.thread_id,s.sequence,s.id LIMIT ").push_bind(count);
            }
            SchedulerRecoverySource::LiveActivations => {
                q.push("SELECT * FROM (");
                for (index,status) in ["queued","running"].iter().enumerate() {
                    if index>0 {q.push(" UNION ALL ");}
                    q.push("SELECT * FROM (SELECT id AS cursor_id,context_id,id AS entity_id,CAST(NULL AS TEXT) AS event_id FROM thread_activations WHERE context_id=").push_bind(context.to_string())
                        .push(" AND status=").push_bind(status.to_string()).push(" AND id>").push_bind(after.to_string())
                        .push(" ORDER BY id LIMIT ").push_bind(count).push(") status_head");
                }
                q.push(") heads ORDER BY cursor_id LIMIT ").push_bind(count);
            }
        }
        q
    }};
}
pub(crate) use scheduler_query;

macro_rules! owned_threads_query {
    ($db:ty,$context:expr,$ids:expr) => {{
        let mut q=sqlx::QueryBuilder::<$db>::new("SELECT t.id FROM threads t WHERE t.context_id=");
        q.push_bind($context.to_string()).push(" AND t.id IN (");
        {let mut ids=q.separated(",");for id in $ids {ids.push_bind(id.clone());}}
        q.push(") AND (EXISTS(SELECT 1 FROM thread_activations a WHERE a.context_id=t.context_id AND a.root_turn_id=t.root_turn_id AND a.status IN ('queued','running'))
            OR EXISTS(SELECT 1 FROM schedules s WHERE s.thread_id=t.id AND s.status='queued')
            OR EXISTS(SELECT 1 FROM thread_signals s WHERE s.thread_id=t.id AND s.status='pending')
            OR EXISTS(SELECT 1 FROM scheduler_dependencies d WHERE d.owner_kind='thread' AND d.owner_id=t.id AND d.required=TRUE AND d.status='pending')
            OR EXISTS(SELECT 1 FROM execution_jobs j WHERE j.thread_id=t.id AND j.status IN ('queued','waiting_approval','running')))");
        q
    }};
}
pub(crate) use owned_threads_query;
