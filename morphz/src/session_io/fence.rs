//! Explicit, irreversible-in-place compatibility fence for Session IO storage.
//! Normal startup registers its connection capability but never installs guards.
//! This protects against older writers, not a hostile database owner/DDL actor.
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{Connection, Row};
use std::path::Path;

type Error = Box<dyn std::error::Error + Send + Sync>;
const GUARD: &str = "morphz_session_io_guard";
const FUNCTION: &str = "morphz_session_io_check_writer";
const SETTING: &str = "morphz.session_io_writer";
const VERSION: i64 = 1;

#[cfg(test)]
#[path = "fence_tests.rs"]
mod tests;

#[derive(Debug, Serialize)]
pub struct FenceStatus {
    pub installed: bool,
    pub min_writer_version: Option<i64>,
    pub protected_tables: usize,
}

fn absent() -> FenceStatus {
    FenceStatus {
        installed: false,
        min_writer_version: None,
        protected_tables: 0,
    }
}
fn quoted(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}
fn trigger_name(table: &str, operation: &str) -> String {
    format!(
        "morphz_io_{}_{operation}",
        &format!("{:x}", Sha256::digest(table.as_bytes()))[..24]
    )
}
fn compatible(enabled: bool) -> Result<(), Error> {
    if enabled {
        Ok(())
    } else {
        Err("Session IO storage requires an IO-enabled compatible writer; restore a pre-IO backup to downgrade".into())
    }
}

pub(crate) async fn sqlite_writer(
    connection: &mut sqlx::SqliteConnection,
    enabled: bool,
) -> Result<(), sqlx::Error> {
    use libsqlite3_sys as ffi;
    unsafe extern "C" fn legacy(
        ctx: *mut ffi::sqlite3_context,
        _: i32,
        _: *mut *mut ffi::sqlite3_value,
    ) {
        unsafe { ffi::sqlite3_result_int(ctx, 0) };
    }
    unsafe extern "C" fn io_v1(
        ctx: *mut ffi::sqlite3_context,
        _: i32,
        _: *mut *mut ffi::sqlite3_value,
    ) {
        unsafe { ffi::sqlite3_result_int(ctx, 1) };
    }
    let mut handle = connection.lock_handle().await?;
    // SQLx's locked handle excludes its worker for registration. Static callbacks
    // own no data and are safe for every future use of this physical connection.
    let code = unsafe {
        ffi::sqlite3_create_function_v2(
            handle.as_raw_handle().as_ptr(),
            c"morphz_session_io_writer_version".as_ptr(),
            0,
            ffi::SQLITE_UTF8 | ffi::SQLITE_INNOCUOUS,
            std::ptr::null_mut(),
            Some(if enabled { io_v1 } else { legacy }),
            None,
            None,
            None,
        )
    };
    if code == ffi::SQLITE_OK {
        Ok(())
    } else {
        Err(sqlx::Error::Protocol(format!(
            "SQLite IO writer registration failed: {code}"
        )))
    }
}

async fn sqlite_tables(connection: &mut sqlx::SqliteConnection) -> Result<Vec<String>, Error> {
    Ok(sqlx::query_scalar("SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .fetch_all(connection).await?)
}
fn sqlite_trigger(table: &str, operation: &str) -> String {
    let condition = if table == GUARD {
        String::new()
    } else {
        format!(" WHEN morphz_session_io_writer_version() <> 1 OR COALESCE((SELECT min_writer_version FROM {GUARD} WHERE singleton=1), -1) <> 1")
    };
    format!("CREATE TRIGGER {} BEFORE {operation} ON {}{condition} BEGIN SELECT RAISE(ABORT, 'Incompatible Session IO writer or immutable IO guard'); END",
        quoted(&trigger_name(table, operation)), quoted(table))
}
pub(crate) async fn sqlite_check(
    connection: &mut sqlx::SqliteConnection,
    enabled: bool,
) -> Result<(), Error> {
    if sqlite_inspect(connection).await?.installed {
        compatible(enabled)?;
    }
    Ok(())
}
async fn sqlite_inspect(connection: &mut sqlx::SqliteConnection) -> Result<FenceStatus, Error> {
    let exists: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name=?")
            .bind(GUARD)
            .fetch_one(&mut *connection)
            .await?;
    if exists == 0 {
        return Ok(absent());
    }
    let row = sqlx::query(&format!(
        "SELECT min_writer_version, manifest FROM {GUARD} WHERE singleton=1"
    ))
    .fetch_one(&mut *connection)
    .await?;
    let version: i64 = row.try_get(0)?;
    if version != VERSION {
        return Err("Unsupported Session IO storage version".into());
    }
    let manifest: Vec<String> = serde_json::from_str(row.try_get::<&str, _>(1)?)?;
    if manifest != sqlite_tables(connection).await? {
        return Err("Session IO guard table coverage changed; explicit migration required".into());
    }
    let triggers: Vec<(String, String)> =
        sqlx::query_as("SELECT name, sql FROM sqlite_schema WHERE type='trigger'")
            .fetch_all(&mut *connection)
            .await?;
    for table in &manifest {
        for operation in ["INSERT", "UPDATE", "DELETE"] {
            let expected = sqlite_trigger(table, operation);
            if !triggers.iter().any(|(name, sql)| {
                name == &trigger_name(table, operation) && sql.trim_end_matches(';') == expected
            }) {
                return Err(format!(
                    "Session IO guard missing or modified for {table}/{operation}"
                )
                .into());
            }
        }
    }
    Ok(FenceStatus {
        installed: true,
        min_writer_version: Some(version),
        protected_tables: manifest.len(),
    })
}
/// Read only. Never creates a database or installs a guard.
pub async fn sqlite_status(path: &Path) -> Result<FenceStatus, Error> {
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false);
    let mut connection = sqlx::SqliteConnection::connect_with(&options).await?;
    sqlite_inspect(&mut connection).await
}
/// Operator-authorized migration only. Rollback requires a pre-install backup.
pub async fn install_sqlite(path: &Path) -> Result<FenceStatus, Error> {
    compatible(true)?;
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .busy_timeout(std::time::Duration::from_secs(5));
    let mut connection = sqlx::SqliteConnection::connect_with(&options).await?;
    sqlite_writer(&mut connection, true).await?;
    let mut transaction = connection.begin_with("BEGIN IMMEDIATE").await?;
    if !sqlite_inspect(&mut transaction).await?.installed {
        let tables = sqlite_tables(&mut transaction).await?;
        require_runtime(&tables)?;
        sqlx::query(&format!("CREATE TABLE {GUARD} (singleton INTEGER PRIMARY KEY CHECK(singleton=1), min_writer_version INTEGER NOT NULL, manifest TEXT NOT NULL)"))
            .execute(&mut *transaction).await?;
        let tables = sqlite_tables(&mut transaction).await?;
        sqlx::query(&format!("INSERT INTO {GUARD} VALUES (1, ?, ?)"))
            .bind(VERSION)
            .bind(serde_json::to_string(&tables)?)
            .execute(&mut *transaction)
            .await?;
        for table in tables {
            for operation in ["INSERT", "UPDATE", "DELETE"] {
                sqlx::query(&sqlite_trigger(&table, operation))
                    .execute(&mut *transaction)
                    .await?;
            }
        }
    }
    transaction.commit().await?;
    sqlite_inspect(&mut connection).await
}
fn require_runtime(tables: &[String]) -> Result<(), Error> {
    if !["events", "sessions"]
        .iter()
        .all(|table| tables.iter().any(|name| name == table))
    {
        return Err(
            "Initialize and back up the Runtime database before installing the Session IO fence"
                .into(),
        );
    }
    Ok(())
}

pub(crate) async fn postgres_writer(
    connection: &mut sqlx::PgConnection,
    enabled: bool,
) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT set_config($1, $2, false)")
        .bind(SETTING)
        .bind(if enabled { "1" } else { "0" })
        .execute(connection)
        .await?;
    Ok(())
}
async fn postgres_tables(
    connection: &mut sqlx::PgConnection,
    schema: &str,
) -> Result<Vec<String>, Error> {
    Ok(sqlx::query_scalar("SELECT c.relname::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p') ORDER BY c.relname")
        .bind(schema).fetch_all(connection).await?)
}
fn postgres_function(schema: &str) -> String {
    format!("BEGIN\nIF TG_TABLE_NAME = '{GUARD}' THEN RAISE EXCEPTION 'Immutable Session IO guard'; END IF;\nIF COALESCE(pg_catalog.current_setting('{SETTING}', true), '') <> '1' OR COALESCE((SELECT min_writer_version FROM {}.{GUARD} WHERE singleton=1), -1) <> 1 THEN RAISE EXCEPTION 'Incompatible Session IO writer'; END IF;\nRETURN NULL;\nEND;", quoted(schema))
}
pub(crate) async fn postgres_check(
    connection: &mut sqlx::PgConnection,
    enabled: bool,
) -> Result<(), Error> {
    if postgres_inspect(connection).await?.installed {
        compatible(enabled)?;
    }
    Ok(())
}
async fn postgres_inspect(connection: &mut sqlx::PgConnection) -> Result<FenceStatus, Error> {
    let schema: String = sqlx::query_scalar("SELECT current_schema()::text")
        .fetch_one(&mut *connection)
        .await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind='r')")
        .bind(&schema).bind(GUARD).fetch_one(&mut *connection).await?;
    if !exists {
        return Ok(absent());
    }
    let row = sqlx::query(&format!(
        "SELECT min_writer_version, manifest FROM {}.{GUARD} WHERE singleton=1",
        quoted(&schema)
    ))
    .fetch_one(&mut *connection)
    .await?;
    let version: i64 = row.try_get(0)?;
    if version != VERSION {
        return Err("Unsupported Session IO storage version".into());
    }
    let manifest: Vec<String> = serde_json::from_str(row.try_get::<&str, _>(1)?)?;
    if manifest != postgres_tables(connection, &schema).await? {
        return Err("Session IO guard table coverage changed; explicit migration required".into());
    }
    let body: Option<String> = sqlx::query_scalar("SELECT p.prosrc FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE n.nspname=$1 AND p.proname=$2 AND p.pronargs=0 AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog'] AND l.lanname='plpgsql'")
        .bind(&schema).bind(FUNCTION).fetch_optional(&mut *connection).await?;
    if body.as_deref() != Some(&postgres_function(&schema)) {
        return Err("Session IO guard function missing or modified".into());
    }
    let triggers: Vec<(String, String)> = sqlx::query_as("SELECT c.relname::text, t.tgname::text FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid WHERE n.nspname=$1 AND p.pronamespace=n.oid AND p.proname=$2 AND p.pronargs=0 AND NOT t.tgisinternal AND t.tgtype=62 AND t.tgenabled='A' AND t.tgqual IS NULL AND t.tgnargs=0")
        .bind(&schema).bind(FUNCTION).fetch_all(&mut *connection).await?;
    for table in &manifest {
        if !triggers.contains(&(table.clone(), trigger_name(table, "write"))) {
            return Err(format!("Session IO guard missing or modified for {table}").into());
        }
    }
    Ok(FenceStatus {
        installed: true,
        min_writer_version: Some(version),
        protected_tables: manifest.len(),
    })
}
pub async fn postgres_status(url: &str) -> Result<FenceStatus, Error> {
    let mut connection = sqlx::PgConnection::connect(url).await?;
    let mut transaction = connection.begin().await?;
    sqlx::query("SET TRANSACTION READ ONLY")
        .execute(&mut *transaction)
        .await?;
    postgres_inspect(&mut transaction).await
}
/// Explicit operator migration, never called by Runtime startup.
pub async fn install_postgres(url: &str) -> Result<FenceStatus, Error> {
    compatible(true)?;
    let mut connection = sqlx::PgConnection::connect(url).await?;
    postgres_writer(&mut connection, true).await?;
    let mut transaction = connection.begin().await?;
    sqlx::query("SET LOCAL lock_timeout='5s'")
        .execute(&mut *transaction)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(crate::memory::postgres::SCHEMA_MIGRATION_LOCK)
        .execute(&mut *transaction)
        .await?;
    if !postgres_inspect(&mut transaction).await?.installed {
        let schema: String = sqlx::query_scalar("SELECT current_schema()::text")
            .fetch_one(&mut *transaction)
            .await?;
        let tables = postgres_tables(&mut transaction, &schema).await?;
        require_runtime(&tables)?;
        let qualified = tables
            .iter()
            .map(|table| format!("{}.{}", quoted(&schema), quoted(table)))
            .collect::<Vec<_>>()
            .join(", ");
        sqlx::query(&format!("LOCK TABLE {qualified} IN ACCESS EXCLUSIVE MODE"))
            .execute(&mut *transaction)
            .await?;
        sqlx::query(&format!("CREATE TABLE {}.{GUARD} (singleton BIGINT PRIMARY KEY CHECK(singleton=1), min_writer_version BIGINT NOT NULL, manifest TEXT NOT NULL)", quoted(&schema)))
            .execute(&mut *transaction).await?;
        let tables = postgres_tables(&mut transaction, &schema).await?;
        sqlx::query(&format!(
            "INSERT INTO {}.{GUARD} VALUES (1, $1, $2)",
            quoted(&schema)
        ))
        .bind(VERSION)
        .bind(serde_json::to_string(&tables)?)
        .execute(&mut *transaction)
        .await?;
        let function = format!("{}.{}", quoted(&schema), quoted(FUNCTION));
        sqlx::query(&format!("CREATE FUNCTION {function}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fence${}$fence$", postgres_function(&schema)))
            .execute(&mut *transaction).await?;
        for table in tables {
            let target = format!("{}.{}", quoted(&schema), quoted(&table));
            let trigger = quoted(&trigger_name(&table, "write"));
            sqlx::query(&format!("CREATE TRIGGER {trigger} BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON {target} FOR EACH STATEMENT EXECUTE FUNCTION {function}()"))
                .execute(&mut *transaction).await?;
            sqlx::query(&format!(
                "ALTER TABLE {target} ENABLE ALWAYS TRIGGER {trigger}"
            ))
            .execute(&mut *transaction)
            .await?;
        }
    }
    transaction.commit().await?;
    postgres_inspect(&mut connection).await
}
