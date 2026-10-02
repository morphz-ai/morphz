use super::{begin_immediate_sqlite_transaction, SqliteStore};
use crate::agent_rom::*;
use crate::memory::AgentRomStore;
use chrono::{DateTime, Utc};
use sqlx::{sqlite::SqliteRow, Row, SqlitePool};
type Error = Box<dyn std::error::Error + Send + Sync>;

const SELECT_VERSION: &str = "SELECT h.entry_id,h.agent_id,h.namespace,h.principal_scope,v.revision,v.schema_tag,v.canonical_sexpr,v.canonical_authoring_state,v.canonical_format_version,v.content_hash,v.enabled,v.created_by,v.created_at FROM agent_rom_heads h JOIN agent_rom_versions v ON v.entry_id=h.entry_id";

pub(super) async fn migrate(pool: &SqlitePool) -> Result<(), Error> {
    let mut tx = begin_immediate_sqlite_transaction(pool).await?;
    let schema = r#"
    CREATE TABLE IF NOT EXISTS agent_rom_heads (
        entry_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id),
        namespace TEXT NOT NULL, principal_scope TEXT REFERENCES principals(id),
        current_revision INTEGER NOT NULL CHECK(current_revision >= 1),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS agent_rom_public_key ON agent_rom_heads(agent_id,namespace) WHERE principal_scope IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS agent_rom_private_key ON agent_rom_heads(agent_id,namespace,principal_scope) WHERE principal_scope IS NOT NULL;
    CREATE TABLE IF NOT EXISTS agent_rom_versions (
        entry_id TEXT NOT NULL REFERENCES agent_rom_heads(entry_id), revision INTEGER NOT NULL CHECK(revision >= 1),
        schema_tag TEXT NOT NULL, canonical_sexpr TEXT NOT NULL,
        canonical_format_version INTEGER NOT NULL, content_hash TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), created_by TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(entry_id,revision)
    );
    CREATE TABLE IF NOT EXISTS agent_rom_command_receipts (
        command_id TEXT PRIMARY KEY, actor_authority_id TEXT NOT NULL, request_hash TEXT NOT NULL,
        entry_id TEXT NOT NULL, expected_revision INTEGER NOT NULL CHECK(expected_revision >= 0),
        committed_revision INTEGER NOT NULL, committed_at TEXT NOT NULL,
        FOREIGN KEY(entry_id,committed_revision) REFERENCES agent_rom_versions(entry_id,revision)
    );
    CREATE TABLE IF NOT EXISTS thread_rom_mounts (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id), agent_id TEXT NOT NULL REFERENCES agents(id),
        initiating_principal_id TEXT REFERENCES principals(id), manifest_hash TEXT NOT NULL,
        compiler_hash TEXT NOT NULL, bound_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS thread_rom_bindings (
        thread_id TEXT NOT NULL REFERENCES thread_rom_mounts(thread_id), entry_id TEXT NOT NULL,
        revision INTEGER NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        PRIMARY KEY(thread_id,entry_id), UNIQUE(thread_id,ordinal),
        FOREIGN KEY(entry_id,revision) REFERENCES agent_rom_versions(entry_id,revision)
    );
    "#;
    // Prepared single statements keep the migration Future Send through the
    // remote replica's async-trait boundary (SQLx RawSql has an HRTB limitation).
    for statement in schema.split(';').map(str::trim).filter(|s| !s.is_empty()) {
        sqlx::query(statement).execute(&mut *tx).await?;
    }
    let migrated: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM schema_migrations WHERE version='20261002_01_agent_rom'",
    )
    .fetch_one(&mut *tx)
    .await?;
    if migrated == 0 {
        // Existing work must remain bound to no ROM, not acquire new settings on recovery.
        sqlx::query("INSERT INTO thread_rom_mounts(thread_id,agent_id,initiating_principal_id,manifest_hash,compiler_hash,bound_at) SELECT id,agent_id,initiating_principal_id,?,?,? FROM threads")
            .bind(manifest_hash(&[])).bind(compiler_hash()).bind(Utc::now().to_rfc3339()).execute(&mut *tx).await?;
        sqlx::query(
            "INSERT INTO schema_migrations(version,applied_at) VALUES('20261002_01_agent_rom',?)",
        )
        .bind(Utc::now().to_rfc3339())
        .execute(&mut *tx)
        .await?;
    }
    // SQLite has no ADD COLUMN IF NOT EXISTS. Inspect under the same immediate
    // write transaction so an old v1 database upgrades safely and only once.
    let columns = sqlx::query("PRAGMA table_info(agent_rom_versions)")
        .fetch_all(&mut *tx)
        .await?;
    if !columns.iter().any(|row| {
        row.try_get::<String, _>("name")
            .is_ok_and(|name| name == "canonical_authoring_state")
    }) {
        sqlx::query("ALTER TABLE agent_rom_versions ADD COLUMN canonical_authoring_state TEXT")
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES('20261002_02_agent_rom_authoring_state',?)")
        .bind(Utc::now().to_rfc3339()).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

fn record(row: SqliteRow) -> Result<AgentRomRecord, Error> {
    Ok(AgentRomRecord {
        entry_id: row.try_get("entry_id")?,
        key: AgentRomKey {
            agent_id: row.try_get("agent_id")?,
            namespace: row.try_get("namespace")?,
            principal_scope: row.try_get("principal_scope")?,
        },
        revision: u64::try_from(row.try_get::<i64, _>("revision")?)?,
        schema_tag: row.try_get("schema_tag")?,
        canonical_sexpr: row.try_get("canonical_sexpr")?,
        canonical_authoring_state: row.try_get("canonical_authoring_state")?,
        canonical_format_version: u32::try_from(
            row.try_get::<i64, _>("canonical_format_version")?,
        )?,
        content_hash: row.try_get("content_hash")?,
        enabled: row.try_get("enabled")?,
        created_by: row.try_get("created_by")?,
        created_at: DateTime::parse_from_rfc3339(&row.try_get::<String, _>("created_at")?)?
            .with_timezone(&Utc),
    })
}

async fn load_manifest(
    connection: &mut sqlx::SqliteConnection,
    thread_id: &str,
) -> Result<Option<ThreadRomManifest>, Error> {
    let Some(row) = sqlx::query("SELECT m.*,t.agent_id AS actual_agent,t.initiating_principal_id AS actual_principal FROM thread_rom_mounts m JOIN threads t ON t.id=m.thread_id WHERE m.thread_id=?").bind(thread_id).fetch_optional(&mut *connection).await? else { return Ok(None); };
    let agent_id: String = row.try_get("agent_id")?;
    let principal: Option<String> = row.try_get("initiating_principal_id")?;
    if agent_id != row.try_get::<String, _>("actual_agent")?
        || principal != row.try_get::<Option<String>, _>("actual_principal")?
    {
        return Err(AgentRomError::Integrity("Thread ROM mount route mismatch".into()).into());
    }
    let entries = sqlx::query(&format!("{SELECT_VERSION} JOIN thread_rom_bindings b ON b.entry_id=v.entry_id AND b.revision=v.revision WHERE b.thread_id=? ORDER BY b.ordinal"))
        .bind(thread_id).fetch_all(&mut *connection).await?.into_iter().map(record).collect::<Result<Vec<_>,_>>()?;
    let manifest = ThreadRomManifest {
        thread_id: thread_id.into(),
        agent_id,
        initiating_principal_id: principal,
        manifest_hash: row.try_get("manifest_hash")?,
        compiler_hash: row.try_get("compiler_hash")?,
        bound_at: DateTime::parse_from_rfc3339(&row.try_get::<String, _>("bound_at")?)?
            .with_timezone(&Utc),
        entries,
    }
    .without_authoring_state();
    if manifest.entries.is_empty() {
        if manifest.manifest_hash != manifest_hash(&[]) || manifest.compiler_hash != compiler_hash()
        {
            return Err(
                AgentRomError::Integrity("Empty ROM manifest integrity mismatch".into()).into(),
            );
        }
    } else {
        manifest.context_rom()?;
    }
    Ok(Some(manifest))
}

async fn validate_all_selections(
    connection: &mut sqlx::SqliteConnection,
    agent_id: &str,
) -> Result<(), Error> {
    // Aggregate only metadata. A public update must remain mountable with every
    // private scope; unrelated Humans' bodies are never loaded for this check.
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_rom_heads WHERE agent_id=?")
        .bind(agent_id)
        .fetch_one(&mut *connection)
        .await?;
    if total > ROM_MAX_SELECTED_ENTRIES as i64 {
        return Err(AgentRomError::Invalid(
            "Agent ROM configuration exceeds 32 entries (including disabled entries)".into(),
        )
        .into());
    }
    let rows = sqlx::query("SELECT h.principal_scope,COUNT(*) AS entries,SUM(length(CAST(v.canonical_sexpr AS BLOB))) AS bytes FROM agent_rom_heads h JOIN agent_rom_versions v ON v.entry_id=h.entry_id AND v.revision=h.current_revision WHERE h.agent_id=? AND v.enabled=1 GROUP BY h.principal_scope")
        .bind(agent_id).fetch_all(connection).await?;
    let mut public = (0i64, 0i64);
    let mut private = Vec::new();
    for row in rows {
        let count: i64 = row.try_get("entries")?;
        let bytes: i64 = row.try_get("bytes")?;
        if row
            .try_get::<Option<String>, _>("principal_scope")?
            .is_none()
        {
            public = (count, bytes);
        } else {
            private.push((count, bytes));
        }
    }
    private.push((0, 0));
    if private.into_iter().any(|p| {
        p.0 + public.0 > ROM_MAX_SELECTED_ENTRIES as i64
            || p.1 + public.1 > ROM_MAX_SELECTED_BYTES as i64
    }) {
        return Err(AgentRomError::Invalid(
            "Public + Human ROM selection exceeds 32 entries or 32 KiB".into(),
        )
        .into());
    }
    Ok(())
}

#[async_trait::async_trait]
impl AgentRomStore for SqliteStore {
    async fn get_agent_rom(&self, key: &AgentRomKey) -> Result<Option<AgentRomRecord>, Error> {
        validate_key(key)?;
        sqlx::query(&format!("{SELECT_VERSION} WHERE h.agent_id=? AND h.namespace=? AND h.principal_scope IS ? AND v.revision=h.current_revision"))
            .bind(&key.agent_id).bind(&key.namespace).bind(&key.principal_scope).fetch_optional(&self.pool).await?.map(record).transpose()
    }
    async fn list_agent_rom(
        &self,
        agent_id: &str,
        principal_scope: Option<&str>,
    ) -> Result<Vec<AgentRomRecord>, Error> {
        validate_key(&AgentRomKey {
            agent_id: agent_id.into(),
            namespace: "scope".into(),
            principal_scope: principal_scope.map(str::to_owned),
        })?;
        sqlx::query(&format!("{SELECT_VERSION} WHERE h.agent_id=? AND h.principal_scope IS ? AND v.revision=h.current_revision ORDER BY h.namespace,h.entry_id"))
            .bind(agent_id).bind(principal_scope).fetch_all(&self.pool).await?.into_iter().map(record).collect()
    }
    async fn put_agent_rom(
        &self,
        command: PutAgentRomCommand,
        actor_authority_id: &str,
    ) -> Result<AgentRomMutation, Error> {
        let (canonical, content_hash, request_hash) =
            prepare_command(&command, actor_authority_id)?;
        let authoring = canonicalize_authoring_state(command.authoring_state_sexpr.as_deref())?;
        let mut tx = begin_immediate_sqlite_transaction(&self.pool).await?;
        if let Some(row) =
            sqlx::query("SELECT * FROM agent_rom_command_receipts WHERE command_id=?")
                .bind(&command.command_id)
                .fetch_optional(&mut *tx)
                .await?
        {
            if row.try_get::<String, _>("actor_authority_id")? != actor_authority_id
                || row.try_get::<String, _>("request_hash")? != request_hash
            {
                return Err(AgentRomError::CommandReuse.into());
            }
            let receipt = AgentRomCommandReceipt {
                command_id: command.command_id,
                actor_authority_id: actor_authority_id.into(),
                request_hash,
                entry_id: row.try_get("entry_id")?,
                expected_revision: u64::try_from(row.try_get::<i64, _>("expected_revision")?)?,
                committed_revision: u64::try_from(row.try_get::<i64, _>("committed_revision")?)?,
                committed_at: DateTime::parse_from_rfc3339(
                    &row.try_get::<String, _>("committed_at")?,
                )?
                .with_timezone(&Utc),
            };
            let version = record(
                sqlx::query(&format!(
                    "{SELECT_VERSION} WHERE h.entry_id=? AND v.revision=?"
                ))
                .bind(&receipt.entry_id)
                .bind(receipt.committed_revision as i64)
                .fetch_one(&mut *tx)
                .await?,
            )?;
            tx.commit().await?;
            return Ok(AgentRomMutation::Committed {
                record: version,
                receipt,
                duplicate: true,
            });
        }
        if sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM agents WHERE id=?")
            .bind(&command.key.agent_id)
            .fetch_one(&mut *tx)
            .await?
            == 0
        {
            return Ok(AgentRomMutation::NotFound);
        }
        let current=sqlx::query(&format!("{SELECT_VERSION} WHERE h.agent_id=? AND h.namespace=? AND h.principal_scope IS ? AND v.revision=h.current_revision"))
            .bind(&command.key.agent_id).bind(&command.key.namespace).bind(&command.key.principal_scope).fetch_optional(&mut *tx).await?.map(record).transpose()?;
        if current.as_ref().map_or(0, |v| v.revision) != command.expected_revision {
            return Ok(AgentRomMutation::Conflict { current });
        }
        let now = Utc::now();
        let timestamp = now.to_rfc3339();
        let entry_id = current
            .as_ref()
            .map(|v| v.entry_id.clone())
            .unwrap_or_else(|| stable_entry_id(&command.key));
        let revision = command.expected_revision + 1;
        if current.is_none() {
            sqlx::query("INSERT INTO agent_rom_heads(entry_id,agent_id,namespace,principal_scope,current_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
                .bind(&entry_id).bind(&command.key.agent_id).bind(&command.key.namespace).bind(&command.key.principal_scope).bind(revision as i64).bind(&timestamp).bind(&timestamp).execute(&mut *tx).await?;
        } else {
            let updated=sqlx::query("UPDATE agent_rom_heads SET current_revision=?,updated_at=? WHERE entry_id=? AND current_revision=?").bind(revision as i64).bind(&timestamp).bind(&entry_id).bind(command.expected_revision as i64).execute(&mut *tx).await?;
            if updated.rows_affected() != 1 {
                return Err(AgentRomError::Integrity(
                    "ROM CAS changed while write lock held".into(),
                )
                .into());
            }
        }
        sqlx::query("INSERT INTO agent_rom_versions(entry_id,revision,schema_tag,canonical_sexpr,canonical_authoring_state,canonical_format_version,content_hash,enabled,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
            .bind(&entry_id).bind(revision as i64).bind(&command.schema_tag).bind(&canonical).bind(&authoring).bind(ROM_FORMAT_VERSION as i64).bind(&content_hash).bind(command.enabled).bind(actor_authority_id).bind(&timestamp).execute(&mut *tx).await?;
        validate_all_selections(&mut tx, &command.key.agent_id).await?;
        sqlx::query("INSERT INTO agent_rom_command_receipts(command_id,actor_authority_id,request_hash,entry_id,expected_revision,committed_revision,committed_at) VALUES(?,?,?,?,?,?,?)")
            .bind(&command.command_id).bind(actor_authority_id).bind(&request_hash).bind(&entry_id).bind(command.expected_revision as i64).bind(revision as i64).bind(&timestamp).execute(&mut *tx).await?;
        let version = AgentRomRecord {
            entry_id: entry_id.clone(),
            key: command.key,
            revision,
            schema_tag: command.schema_tag,
            canonical_sexpr: canonical,
            canonical_authoring_state: authoring,
            canonical_format_version: ROM_FORMAT_VERSION,
            content_hash,
            enabled: command.enabled,
            created_by: actor_authority_id.into(),
            created_at: now,
        };
        let receipt = AgentRomCommandReceipt {
            command_id: command.command_id,
            actor_authority_id: actor_authority_id.into(),
            request_hash,
            entry_id,
            expected_revision: command.expected_revision,
            committed_revision: revision,
            committed_at: now,
        };
        tx.commit().await?;
        Ok(AgentRomMutation::Committed {
            record: version,
            receipt,
            duplicate: false,
        })
    }
    async fn bind_thread_rom(&self, thread_id: &str) -> Result<ThreadRomManifest, Error> {
        let mut tx = begin_immediate_sqlite_transaction(&self.pool).await?;
        if let Some(manifest) = load_manifest(&mut tx, thread_id).await? {
            tx.commit().await?;
            return Ok(manifest);
        }
        let row = sqlx::query("SELECT agent_id,initiating_principal_id FROM threads WHERE id=?")
            .bind(thread_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| {
                AgentRomError::Invalid("Cannot bind ROM: Thread does not exist".into())
            })?;
        let agent_id: String = row.try_get("agent_id")?;
        let principal: Option<String> = row.try_get("initiating_principal_id")?;
        let mut entries=sqlx::query(&format!("{SELECT_VERSION} WHERE h.agent_id=? AND (h.principal_scope IS NULL OR h.principal_scope=?) AND v.revision=h.current_revision AND v.enabled=1 ORDER BY h.namespace,h.principal_scope,h.entry_id"))
            .bind(&agent_id).bind(&principal).fetch_all(&mut *tx).await?.into_iter().map(record).collect::<Result<Vec<_>,_>>()?;
        retain_new_thread_effective_rom(&mut entries);
        validate_selection(&entries)?;
        let manifest = ThreadRomManifest {
            thread_id: thread_id.into(),
            agent_id,
            initiating_principal_id: principal,
            manifest_hash: manifest_hash(&entries),
            compiler_hash: compiler_hash(),
            bound_at: Utc::now(),
            entries,
        }
        .without_authoring_state();
        sqlx::query("INSERT INTO thread_rom_mounts(thread_id,agent_id,initiating_principal_id,manifest_hash,compiler_hash,bound_at) VALUES(?,?,?,?,?,?)")
            .bind(thread_id).bind(&manifest.agent_id).bind(&manifest.initiating_principal_id).bind(&manifest.manifest_hash).bind(&manifest.compiler_hash).bind(manifest.bound_at.to_rfc3339()).execute(&mut *tx).await?;
        for (ordinal, entry) in manifest.entries.iter().enumerate() {
            sqlx::query("INSERT INTO thread_rom_bindings(thread_id,entry_id,revision,ordinal) VALUES(?,?,?,?)").bind(thread_id).bind(&entry.entry_id).bind(entry.revision as i64).bind(ordinal as i64).execute(&mut *tx).await?;
        }
        manifest.context_rom()?;
        tx.commit().await?;
        Ok(manifest)
    }
    async fn get_thread_rom(&self, thread_id: &str) -> Result<Option<ThreadRomManifest>, Error> {
        let mut connection = self.pool.acquire().await?;
        load_manifest(&mut connection, thread_id).await
    }
}
