//! Disposable computation replica. TEMP triggers capture the final row delta
//! of native transactions, including cascades; rollbacks erase their journal
//! entries too. No Runtime acknowledgement is produced by this module.
use super::protocol::{Change, StoreError};
use crate::config::SqliteStorageConfig;
use crate::memory::sqlite::SqliteStore;
use sha2::{Digest, Sha256};
use sqlx::{Row, Sqlite, SqlitePool};
use std::sync::Arc;

pub(super) struct Table {
    name: String,
    columns: Vec<String>,
}

pub(super) struct Replica {
    pub store: Arc<SqliteStore>,
    pub schema: String,
    pub revision: u64,
    pub sequence: u64,
    tables: Vec<Table>,
}

fn ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}
fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn values_expression(table: &Table, prefix: &str) -> String {
    let fields = table
        .columns
        .iter()
        .map(|name| {
            let field = format!("{prefix}{}", ident(name));
            format!(
                "CASE typeof({field}) WHEN 'null' THEN json_array('null') \
            WHEN 'integer' THEN json_array('integer', CAST({field} AS TEXT)) \
            WHEN 'real' THEN json_array('real', printf('%!.26g', {field})) \
            WHEN 'blob' THEN json_array('blob', hex({field})) \
            ELSE json_array('text', {field}) END"
            )
        })
        .collect::<Vec<_>>();
    format!("json_array({})", fields.join(","))
}

impl Replica {
    pub async fn create() -> Result<Self, StoreError> {
        // One in-memory connection is deliberate: this is an operation-serialized
        // execution cache, not a second WAL database or durable fallback.
        let config = SqliteStorageConfig {
            max_connections: 1,
            ..Default::default()
        };
        let store = Arc::new(SqliteStore::new_with_context_db(":memory:", &config).await?);
        let pool = store.computation_pool();
        let mut tables = Vec::new();
        for row in sqlx::query("PRAGMA main.table_list")
            .fetch_all(pool)
            .await?
        {
            let name: String = row.try_get("name")?;
            let kind: String = row.try_get("type")?;
            if name == "sqlite_sequence" {
                return Err(
                    "remote Store requires an explicit capture contract for AUTOINCREMENT counters"
                        .into(),
                );
            }
            if name.starts_with("sqlite_") || kind == "shadow" {
                continue;
            }
            // This read-only readiness projection owns no rows. Its DDL is
            // included in the schema hash below; all source tables are captured.
            if kind == "view" && name == "activation_pending_approval_waits" {
                continue;
            }
            if kind == "virtual" && name == "recall_documents_fts" {
                continue;
            }
            if kind != "table" || row.try_get::<i64, _>("wr")? != 0 {
                return Err(
                    format!("remote Store needs a capture contract for {kind} {name}").into(),
                );
            }
            let mut columns = Vec::new();
            for column in sqlx::query(&format!("PRAGMA main.table_xinfo({})", literal(&name)))
                .fetch_all(pool)
                .await?
            {
                if column.try_get::<i64, _>("hidden")? != 0 {
                    return Err(
                        format!("remote Store does not admit generated columns in {name}").into(),
                    );
                }
                let column: String = column.try_get("name")?;
                if column.eq_ignore_ascii_case("_rowid_") {
                    return Err("remote Store row identity is shadowed by a column".into());
                }
                columns.push(column);
            }
            tables.push(Table { name, columns });
        }
        tables.sort_by(|a, b| a.name.cmp(&b.name));
        let ddl: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
        ).fetch_all(pool).await?;
        // Data-only migrations also change compatibility even when DDL does not.
        // Include their identities, not wall-clock-dependent applied_at values.
        let migrations: Vec<String> =
            sqlx::query_scalar("SELECT version FROM schema_migrations ORDER BY version")
                .fetch_all(pool)
                .await?;
        let schema = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(ddl, migrations))?)
        );
        Ok(Self {
            store,
            schema,
            revision: 0,
            sequence: 0,
            tables,
        })
    }

    pub fn pool(&self) -> &SqlitePool {
        self.store.computation_pool()
    }

    pub async fn install_journal(&self) -> Result<(), StoreError> {
        sqlx::query("CREATE TEMP TABLE remote_delta (table_name TEXT NOT NULL, row_key TEXT NOT NULL, row_values TEXT, PRIMARY KEY(table_name, row_key))")
            .execute(self.pool()).await?;
        for table in &self.tables {
            let name = literal(&table.name);
            let upsert = format!(
                "INSERT INTO remote_delta VALUES ({name}, CAST(NEW._rowid_ AS TEXT), {}) \
                ON CONFLICT(table_name, row_key) DO UPDATE SET row_values = excluded.row_values;",
                values_expression(table, "NEW.")
            );
            let delete = format!(
                "INSERT INTO remote_delta VALUES ({name}, CAST(OLD._rowid_ AS TEXT), NULL) \
                ON CONFLICT(table_name, row_key) DO UPDATE SET row_values = NULL;"
            );
            for (suffix, event, statements) in [
                ("i", "INSERT", upsert.clone()),
                ("d", "DELETE", delete.clone()),
                ("u", "UPDATE", format!("{delete} {upsert}")),
            ] {
                let condition = if event == "UPDATE" {
                    let unchanged = table
                        .columns
                        .iter()
                        .map(|column| format!("OLD.{} IS NEW.{}", ident(column), ident(column)))
                        .collect::<Vec<_>>()
                        .join(" AND ");
                    format!(" WHEN NOT (OLD._rowid_ IS NEW._rowid_ AND {unchanged})")
                } else {
                    String::new()
                };
                let sql = format!("CREATE TEMP TRIGGER {} AFTER {event} ON main.{}{condition} BEGIN {statements} END",
                    ident(&format!("remote_{}_{suffix}", table.name)), ident(&table.name));
                sqlx::query(&sql).execute(self.pool()).await?;
            }
        }
        Ok(())
    }

    pub async fn changes(&self) -> Result<Vec<Change>, StoreError> {
        let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
            "SELECT table_name, row_key, row_values FROM temp.remote_delta ORDER BY table_name, row_key",
        ).fetch_all(self.pool()).await?;
        rows.into_iter()
            .map(|(table, key, values)| {
                Ok(Change {
                    table,
                    key,
                    values: values
                        .map(|value| serde_json::from_str(&value))
                        .transpose()?,
                })
            })
            .collect()
    }

    pub async fn clear_journal(&self) -> Result<(), StoreError> {
        sqlx::query("DELETE FROM temp.remote_delta")
            .execute(self.pool())
            .await?;
        Ok(())
    }

    pub async fn seed(&self) -> Result<Vec<Change>, StoreError> {
        let mut changes = Vec::new();
        for table in &self.tables {
            let rows: Vec<(String, String)> = sqlx::query_as(&format!(
                "SELECT CAST(_rowid_ AS TEXT), {} FROM {} ORDER BY _rowid_",
                values_expression(table, ""),
                ident(&table.name),
            ))
            .fetch_all(self.pool())
            .await?;
            for (key, values) in rows {
                changes.push(Change {
                    table: table.name.clone(),
                    key,
                    values: Some(serde_json::from_str(&values)?),
                });
            }
        }
        Ok(changes)
    }

    /// Called only on a freshly constructed replica, before journal capture.
    /// A failed or cancelled import is discarded in its entirety by the caller.
    pub async fn clear_seed(&self) -> Result<(), StoreError> {
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(self.pool())
            .await?;
        for table in &self.tables {
            sqlx::query(&format!("DELETE FROM {}", ident(&table.name)))
                .execute(self.pool())
                .await?;
        }
        Ok(())
    }

    pub async fn import(&self, records: &[Change]) -> Result<(), StoreError> {
        for record in records {
            let table = self
                .tables
                .iter()
                .find(|table| table.name == record.table)
                .ok_or("remote snapshot contains an unknown table")?;
            let values = record
                .values
                .as_ref()
                .ok_or("remote snapshot contains a tombstone")?;
            if values.len() != table.columns.len() {
                return Err("remote snapshot column count mismatch".into());
            }
            let columns = table
                .columns
                .iter()
                .map(|name| ident(name))
                .collect::<Vec<_>>()
                .join(",");
            let placeholders = vec!["?"; values.len() + 1].join(",");
            let statement = format!(
                "INSERT INTO {} (_rowid_, {columns}) VALUES ({placeholders})",
                ident(&table.name)
            );
            let mut query = sqlx::query(&statement).bind(record.key.parse::<i64>()?);
            for value in values {
                query = bind_value(query, value)?;
            }
            query.execute(self.pool()).await?;
        }
        Ok(())
    }

    pub async fn finish_import(&self) -> Result<(), StoreError> {
        if sqlx::query("PRAGMA foreign_key_check")
            .fetch_optional(self.pool())
            .await?
            .is_some()
        {
            return Err("remote snapshot violates relational integrity".into());
        }
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(self.pool())
            .await?;
        Ok(())
    }
}

fn bind_value<'q>(
    query: sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    value: &[String],
) -> Result<sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>>, StoreError> {
    Ok(match value {
        [kind] if kind == "null" => query.bind(Option::<String>::None),
        [kind, value] if kind == "integer" => query.bind(value.parse::<i64>()?),
        [kind, value] if kind == "real" => {
            let number: f64 = value.parse()?;
            if !number.is_finite() {
                return Err("remote snapshot has a non-finite real".into());
            }
            query.bind(number)
        }
        [kind, value] if kind == "text" => query.bind(value.clone()),
        [kind, value] if kind == "blob" => {
            if !value.len().is_multiple_of(2) || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err("remote snapshot contains invalid blob encoding".into());
            }
            let bytes: Result<Vec<_>, _> = value
                .as_bytes()
                .chunks_exact(2)
                .map(|bytes| {
                    u8::from_str_radix(std::str::from_utf8(bytes).expect("validated hex"), 16)
                })
                .collect();
            query.bind(bytes?)
        }
        _ => return Err("remote snapshot contains an unknown value encoding".into()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn complete_native_schema_roundtrips_without_a_local_durable_file() {
        let source = Replica::create().await.unwrap();
        let snapshot = source.seed().await.unwrap();
        assert!(source.tables.iter().any(|table| table.name == "events"));
        assert!(source
            .tables
            .iter()
            .any(|table| table.name == "execution_jobs"));
        assert!(source
            .tables
            .iter()
            .any(|table| table.name.starts_with("experimental_contextdb_")));
        let destination = Replica::create().await.unwrap();
        assert_eq!(source.schema, destination.schema);
        destination.clear_seed().await.unwrap();
        destination.import(&snapshot).await.unwrap();
        destination.finish_import().await.unwrap();
        assert_eq!(snapshot, destination.seed().await.unwrap());
        destination.install_journal().await.unwrap();
        assert!(destination.changes().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn capture_is_transactional_and_coalesces_multiple_updates() {
        let mut replica = Replica::create().await.unwrap();
        sqlx::query("CREATE TABLE capture_probe (id INTEGER PRIMARY KEY, counter INTEGER, fraction REAL, text_value TEXT, bytes BLOB, optional TEXT)")
            .execute(replica.pool()).await.unwrap();
        replica.tables.push(Table {
            name: "capture_probe".into(),
            columns: vec![
                "id",
                "counter",
                "fraction",
                "text_value",
                "bytes",
                "optional",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        });
        replica.install_journal().await.unwrap();
        let mut tx = replica.pool().begin().await.unwrap();
        sqlx::query("INSERT INTO capture_probe VALUES (1, 9223372036854775807, 0.12345678901234567, '事件', X'000AFF', NULL)")
            .execute(&mut *tx).await.unwrap();
        tx.rollback().await.unwrap();
        assert!(replica.changes().await.unwrap().is_empty());
        let mut tx = replica.pool().begin().await.unwrap();
        sqlx::query("INSERT INTO capture_probe VALUES (1, 9223372036854775807, 0.12345678901234567, '事件', X'000AFF', NULL)")
            .execute(&mut *tx).await.unwrap();
        sqlx::query("UPDATE capture_probe SET text_value = 'final'")
            .execute(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let changes = replica.changes().await.unwrap();
        assert_eq!(changes.len(), 1);
        let values = changes[0].values.as_ref().unwrap();
        assert_eq!(values[1], ["integer", "9223372036854775807"]);
        assert_eq!(
            values[2][1].parse::<f64>().unwrap().to_bits(),
            0.12345678901234567_f64.to_bits()
        );
        assert_eq!(values[3], ["text", "final"]);
        assert_eq!(values[4], ["blob", "000AFF"]);
        assert_eq!(values[5], ["null"]);
        sqlx::query("DELETE FROM capture_probe")
            .execute(replica.pool())
            .await
            .unwrap();
        assert!(replica.changes().await.unwrap()[0].values.is_none());
    }
}
