use super::{now_text, PostgresStore, StoreError};
use crate::memory::{
    EdgeCommandMutation, EdgeCommandOutputChunk, EdgeCommandRecord, EdgeCommandStatus,
    EdgeExecutionStore, EdgeOutputStream, EdgeReconciliationReport, ExecutionNodeMutation,
    ExecutionNodeRecord, ExecutionNodeStatus, NewEdgeCommand, NewExecutionNodeChallenge,
    NewNodePairingCode, PairExecutionNode,
};
use chrono::{DateTime, Utc};
use serde_json::Value as JsonValue;
use sqlx::{PgPool, Row};

pub(super) async fn migrate(pool: &PgPool) -> Result<(), StoreError> {
    for statement in [
        r#"CREATE TABLE IF NOT EXISTS execution_nodes (
            id TEXT PRIMARY KEY,
            revision BIGINT NOT NULL DEFAULT 1 CHECK(revision >= 1),
            owner_principal_id TEXT NOT NULL,
            name TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('online', 'offline', 'revoked')),
            device_key_fingerprint TEXT NOT NULL,
            device_public_key TEXT NOT NULL DEFAULT '',
            device_token_hash TEXT NOT NULL,
            device_token_expires_at TEXT,
            protocol_version BIGINT NOT NULL,
            platform TEXT,
            capabilities_json JSONB NOT NULL DEFAULT '[]'::jsonb,
            metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_seen_at TEXT
        )"#,
        r#"CREATE INDEX IF NOT EXISTS idx_execution_nodes_owner_status
            ON execution_nodes(owner_principal_id, status, updated_at DESC)"#,
        r#"ALTER TABLE execution_nodes ADD COLUMN IF NOT EXISTS device_public_key TEXT NOT NULL DEFAULT ''"#,
        r#"ALTER TABLE execution_nodes ADD COLUMN IF NOT EXISTS device_token_expires_at TEXT"#,
        r#"CREATE TABLE IF NOT EXISTS execution_node_pairing_codes (
            code_hash TEXT PRIMARY KEY,
            owner_principal_id TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            consumed_at TEXT,
            created_at TEXT NOT NULL
        )"#,
        r#"CREATE TABLE IF NOT EXISTS execution_node_challenges (
            id TEXT PRIMARY KEY,
            node_id TEXT NOT NULL REFERENCES execution_nodes(id) ON DELETE CASCADE,
            nonce_hash TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            consumed_at TEXT,
            created_at TEXT NOT NULL
        )"#,
        r#"CREATE INDEX IF NOT EXISTS idx_execution_node_challenges_node_expiry
            ON execution_node_challenges(node_id, expires_at)"#,
        r#"CREATE TABLE IF NOT EXISTS edge_execution_commands (
            job_id TEXT PRIMARY KEY REFERENCES execution_jobs(id) ON DELETE CASCADE,
            revision BIGINT NOT NULL DEFAULT 1 CHECK(revision >= 1),
            target_id TEXT NOT NULL REFERENCES execution_targets(id),
            provider_node_id TEXT NOT NULL REFERENCES execution_nodes(id),
            tool_name TEXT NOT NULL,
            arguments TEXT NOT NULL,
            route_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            status TEXT NOT NULL CHECK(status IN (
                'queued', 'claimed', 'succeeded', 'failed',
                'cancel_requested', 'cancelled', 'lost'
            )),
            claimed_by TEXT,
            claim_token TEXT,
            lease_expires_at TEXT,
            heartbeat_at TEXT,
            side_effect_started_at TEXT,
            progress TEXT,
            output TEXT,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            finished_at TEXT
        )"#,
        r#"ALTER TABLE edge_execution_commands
            ADD COLUMN IF NOT EXISTS route_json JSONB NOT NULL DEFAULT '{}'::jsonb"#,
        r#"CREATE INDEX IF NOT EXISTS idx_edge_commands_node_queue
            ON edge_execution_commands(provider_node_id, status, created_at, job_id)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_edge_commands_lease
            ON edge_execution_commands(status, lease_expires_at, job_id)"#,
        r#"CREATE OR REPLACE FUNCTION morphz_edge_command_terminal_guard()
            RETURNS trigger AS $$
            BEGIN
                IF OLD.status IN ('succeeded', 'failed', 'cancelled', 'lost')
                   AND NEW.status <> OLD.status THEN
                    RAISE EXCEPTION 'edge command terminal status is irreversible';
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql"#,
        r#"DROP TRIGGER IF EXISTS edge_commands_terminal_status_is_irreversible
            ON edge_execution_commands"#,
        r#"CREATE TRIGGER edge_commands_terminal_status_is_irreversible
            BEFORE UPDATE OF status ON edge_execution_commands
            FOR EACH ROW EXECUTE FUNCTION morphz_edge_command_terminal_guard()"#,
        r#"CREATE TABLE IF NOT EXISTS edge_command_output_chunks (
            job_id TEXT NOT NULL REFERENCES edge_execution_commands(job_id) ON DELETE CASCADE,
            sequence BIGINT NOT NULL CHECK(sequence >= 1),
            stream TEXT NOT NULL CHECK(stream IN ('stdout', 'stderr')),
            text TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY(job_id, sequence)
        )"#,
        r#"CREATE INDEX IF NOT EXISTS idx_edge_output_job_sequence
            ON edge_command_output_chunks(job_id, sequence)"#,
    ] {
        sqlx::query(statement).execute(pool).await?;
    }
    Ok(())
}

fn parse_time(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .expect("PostgreSQL timestamp must be RFC3339")
        .with_timezone(&Utc)
}

fn node_from_row(row: &sqlx::postgres::PgRow) -> Result<ExecutionNodeRecord, StoreError> {
    Ok(ExecutionNodeRecord {
        id: row.get("id"),
        revision: u64::try_from(row.get::<i64, _>("revision"))?,
        owner_principal_id: row.get("owner_principal_id"),
        name: row.get("name"),
        status: ExecutionNodeStatus::parse(&row.get::<String, _>("status"))
            .ok_or("unknown execution node status")?,
        device_key_fingerprint: row.get("device_key_fingerprint"),
        device_public_key: row.get("device_public_key"),
        protocol_version: u32::try_from(row.get::<i64, _>("protocol_version"))?,
        platform: row.get("platform"),
        capabilities: serde_json::from_value(row.get::<JsonValue, _>("capabilities_json"))?,
        metadata: row.get("metadata_json"),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
        last_seen_at: row
            .get::<Option<String>, _>("last_seen_at")
            .as_deref()
            .map(parse_time),
    })
}

fn command_from_row(row: &sqlx::postgres::PgRow) -> Result<EdgeCommandRecord, StoreError> {
    Ok(EdgeCommandRecord {
        job_id: row.get("job_id"),
        revision: u64::try_from(row.get::<i64, _>("revision"))?,
        target_id: row.get("target_id"),
        provider_node_id: row.get("provider_node_id"),
        tool_name: row.get("tool_name"),
        arguments: row.get("arguments"),
        route: row.get("route_json"),
        status: EdgeCommandStatus::parse(&row.get::<String, _>("status"))
            .ok_or("unknown edge command status")?,
        claimed_by: row.get("claimed_by"),
        claim_token: row.get("claim_token"),
        lease_expires_at: row
            .get::<Option<String>, _>("lease_expires_at")
            .as_deref()
            .map(parse_time),
        heartbeat_at: row
            .get::<Option<String>, _>("heartbeat_at")
            .as_deref()
            .map(parse_time),
        side_effect_started_at: row
            .get::<Option<String>, _>("side_effect_started_at")
            .as_deref()
            .map(parse_time),
        progress: row.get("progress"),
        output: row.get("output"),
        error: row.get("error"),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
        finished_at: row
            .get::<Option<String>, _>("finished_at")
            .as_deref()
            .map(parse_time),
    })
}

fn output_chunk_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<EdgeCommandOutputChunk, StoreError> {
    Ok(EdgeCommandOutputChunk {
        job_id: row.get("job_id"),
        sequence: u64::try_from(row.get::<i64, _>("sequence"))?,
        stream: EdgeOutputStream::parse(&row.get::<String, _>("stream"))
            .ok_or("unknown Edge output stream")?,
        text: row.get("text"),
        created_at: parse_time(&row.get::<String, _>("created_at")),
    })
}

async fn get_node(pool: &PgPool, node_id: &str) -> Result<Option<ExecutionNodeRecord>, StoreError> {
    sqlx::query("SELECT * FROM execution_nodes WHERE id = $1")
        .bind(node_id)
        .fetch_optional(pool)
        .await?
        .as_ref()
        .map(node_from_row)
        .transpose()
}

#[async_trait::async_trait]
impl EdgeExecutionStore for PostgresStore {
    async fn wait_for_edge_command_change(&self, timeout: std::time::Duration) {
        let _ = tokio::time::timeout(timeout, self.edge_command_notify.notified()).await;
    }

    async fn create_node_pairing_code(
        &self,
        pairing: NewNodePairingCode,
    ) -> Result<(), StoreError> {
        if pairing.code_hash.trim().is_empty() || pairing.owner_principal_id.trim().is_empty() {
            return Err("Node pairing code hash/owner 不能为空".into());
        }
        if pairing.expires_at <= Utc::now() {
            return Err("Node pairing code 必须在未来过期".into());
        }
        sqlx::query(
            r#"INSERT INTO execution_node_pairing_codes
               (code_hash, owner_principal_id, expires_at, created_at) VALUES ($1, $2, $3, $4)"#,
        )
        .bind(pairing.code_hash)
        .bind(pairing.owner_principal_id)
        .bind(pairing.expires_at.to_rfc3339())
        .bind(now_text())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn pair_execution_node(
        &self,
        mut request: PairExecutionNode,
    ) -> Result<ExecutionNodeRecord, StoreError> {
        for (field, value) in [
            ("code_hash", request.code_hash.as_str()),
            ("node_id", request.node_id.as_str()),
            ("name", request.name.as_str()),
            (
                "device_key_fingerprint",
                request.device_key_fingerprint.as_str(),
            ),
            ("device_public_key", request.device_public_key.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(format!("Pair Execution Node {field} 不能为空").into());
            }
        }
        if !request.metadata.is_object() {
            return Err("Execution Node metadata 必须是 JSON object".into());
        }
        request.capabilities.sort();
        request.capabilities.dedup();
        let now = Utc::now();
        let now_value = now.to_rfc3339();
        let mut tx = self.pool.begin().await?;
        let pairing = sqlx::query(
            r#"SELECT owner_principal_id, expires_at, consumed_at
               FROM execution_node_pairing_codes WHERE code_hash = $1 FOR UPDATE"#,
        )
        .bind(&request.code_hash)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or("Node pairing code 无效")?;
        if pairing.get::<Option<String>, _>("consumed_at").is_some() {
            return Err("Node pairing code 已使用".into());
        }
        if parse_time(&pairing.get::<String, _>("expires_at")) <= now {
            return Err("Node pairing code 已过期".into());
        }
        sqlx::query(
            r#"INSERT INTO execution_nodes
               (id, revision, owner_principal_id, name, status, device_key_fingerprint,
                device_public_key, device_token_hash, protocol_version, platform, capabilities_json,
                metadata_json, created_at, updated_at, last_seen_at)
               VALUES ($1, 1, $2, $3, 'online', $4, $5, '', $6, $7, $8, $9, $10, $10, $10)"#,
        )
        .bind(&request.node_id)
        .bind(pairing.get::<String, _>("owner_principal_id"))
        .bind(&request.name)
        .bind(&request.device_key_fingerprint)
        .bind(&request.device_public_key)
        .bind(i64::from(request.protocol_version))
        .bind(&request.platform)
        .bind(serde_json::to_value(&request.capabilities)?)
        .bind(&request.metadata)
        .bind(&now_value)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE execution_node_pairing_codes SET consumed_at = $1 WHERE code_hash = $2 AND consumed_at IS NULL",
        )
        .bind(&now_value)
        .bind(&request.code_hash)
        .execute(&mut *tx)
        .await?;
        let row = sqlx::query("SELECT * FROM execution_nodes WHERE id = $1")
            .bind(&request.node_id)
            .fetch_one(&mut *tx)
            .await?;
        let node = node_from_row(&row)?;
        tx.commit().await?;
        Ok(node)
    }

    async fn create_execution_node_challenge(
        &self,
        challenge: NewExecutionNodeChallenge,
    ) -> Result<(), StoreError> {
        if challenge.id.trim().is_empty()
            || challenge.node_id.trim().is_empty()
            || challenge.nonce_hash.trim().is_empty()
            || challenge.expires_at <= Utc::now()
        {
            return Err("Execution Node challenge 参数无效".into());
        }
        let inserted = sqlx::query(
            r#"INSERT INTO execution_node_challenges
               (id, node_id, nonce_hash, expires_at, created_at)
               SELECT $1, $2, $3, $4, $5 WHERE EXISTS (
                 SELECT 1 FROM execution_nodes WHERE id = $2 AND status <> 'revoked'
               )"#,
        )
        .bind(challenge.id)
        .bind(challenge.node_id)
        .bind(challenge.nonce_hash)
        .bind(challenge.expires_at.to_rfc3339())
        .bind(now_text())
        .execute(&self.pool)
        .await?;
        if inserted.rows_affected() != 1 {
            return Err("Execution Node 不存在或已撤销".into());
        }
        Ok(())
    }

    async fn consume_execution_node_challenge(
        &self,
        node_id: &str,
        challenge_id: &str,
        nonce_hash: &str,
    ) -> Result<Option<ExecutionNodeRecord>, StoreError> {
        let now = now_text();
        let mut tx = self.pool.begin().await?;
        let updated = sqlx::query(
            r#"UPDATE execution_node_challenges SET consumed_at = $1
               WHERE id = $2 AND node_id = $3 AND nonce_hash = $4
                 AND consumed_at IS NULL AND expires_at > $1"#,
        )
        .bind(&now)
        .bind(challenge_id)
        .bind(node_id)
        .bind(nonce_hash)
        .execute(&mut *tx)
        .await?;
        let node = if updated.rows_affected() == 1 {
            sqlx::query("SELECT * FROM execution_nodes WHERE id = $1 AND status <> 'revoked'")
                .bind(node_id)
                .fetch_optional(&mut *tx)
                .await?
                .as_ref()
                .map(node_from_row)
                .transpose()?
        } else {
            None
        };
        tx.commit().await?;
        Ok(node)
    }

    async fn issue_execution_node_connection_token(
        &self,
        node_id: &str,
        token_hash: &str,
        expires_at: DateTime<Utc>,
    ) -> Result<Option<ExecutionNodeRecord>, StoreError> {
        if token_hash.trim().is_empty() || expires_at <= Utc::now() {
            return Err("Execution Node connection token 参数无效".into());
        }
        sqlx::query(
            r#"UPDATE execution_nodes SET device_token_hash = $1,
               device_token_expires_at = $2 WHERE id = $3 AND status <> 'revoked'"#,
        )
        .bind(token_hash)
        .bind(expires_at.to_rfc3339())
        .bind(node_id)
        .execute(&self.pool)
        .await?;
        self.authenticate_execution_node(node_id, token_hash).await
    }

    async fn authenticate_execution_node(
        &self,
        node_id: &str,
        device_token_hash: &str,
    ) -> Result<Option<ExecutionNodeRecord>, StoreError> {
        sqlx::query(
            "SELECT * FROM execution_nodes WHERE id = $1 AND device_token_hash = $2 AND device_token_expires_at > $3 AND status <> 'revoked'",
        )
        .bind(node_id)
        .bind(device_token_hash)
        .bind(now_text())
        .fetch_optional(&self.pool)
        .await?
        .as_ref()
        .map(node_from_row)
        .transpose()
    }

    async fn heartbeat_execution_node(
        &self,
        node_id: &str,
        platform: Option<String>,
        mut capabilities: Vec<String>,
        metadata: JsonValue,
    ) -> Result<Option<ExecutionNodeRecord>, StoreError> {
        if !metadata.is_object() {
            return Err("Execution Node metadata 必须是 JSON object".into());
        }
        capabilities.sort();
        capabilities.dedup();
        let Some(current) = get_node(&self.pool, node_id).await? else {
            return Ok(None);
        };
        if current.status == ExecutionNodeStatus::Revoked {
            return Ok(Some(current));
        }
        let changed = current.status != ExecutionNodeStatus::Online
            || current.platform != platform
            || current.capabilities != capabilities
            || current.metadata != metadata;
        let now = now_text();
        sqlx::query(
            r#"UPDATE execution_nodes SET revision = revision + $1, status = 'online',
               platform = $2, capabilities_json = $3, metadata_json = $4,
               updated_at = CASE WHEN $5 THEN $6 ELSE updated_at END, last_seen_at = $6
               WHERE id = $7 AND status <> 'revoked'"#,
        )
        .bind(if changed { 1_i64 } else { 0_i64 })
        .bind(platform)
        .bind(serde_json::to_value(capabilities)?)
        .bind(metadata)
        .bind(changed)
        .bind(now)
        .bind(node_id)
        .execute(&self.pool)
        .await?;
        get_node(&self.pool, node_id).await
    }

    async fn list_execution_nodes(
        &self,
        owner_principal_id: &str,
    ) -> Result<Vec<ExecutionNodeRecord>, StoreError> {
        sqlx::query(
            "SELECT * FROM execution_nodes WHERE owner_principal_id = $1 ORDER BY updated_at DESC, id",
        )
        .bind(owner_principal_id)
        .fetch_all(&self.pool)
        .await?
        .iter()
        .map(node_from_row)
        .collect()
    }

    async fn revoke_execution_node(
        &self,
        node_id: &str,
        owner_principal_id: &str,
        expected_revision: u64,
    ) -> Result<Option<ExecutionNodeRecord>, StoreError> {
        sqlx::query(
            r#"UPDATE execution_nodes SET revision = revision + 1, status = 'revoked', updated_at = $1
               WHERE id = $2 AND owner_principal_id = $3 AND revision = $4"#,
        )
        .bind(now_text())
        .bind(node_id)
        .bind(owner_principal_id)
        .bind(i64::try_from(expected_revision)?)
        .execute(&self.pool)
        .await?;
        let row =
            sqlx::query("SELECT * FROM execution_nodes WHERE id = $1 AND owner_principal_id = $2")
                .bind(node_id)
                .bind(owner_principal_id)
                .fetch_optional(&self.pool)
                .await?;
        row.as_ref().map(node_from_row).transpose()
    }

    async fn rotate_execution_node_key(
        &self,
        node_id: &str,
        expected_revision: u64,
        device_key_fingerprint: &str,
        device_public_key: &str,
    ) -> Result<ExecutionNodeMutation, StoreError> {
        let Some(current) = get_node(&self.pool, node_id).await? else {
            return Ok(ExecutionNodeMutation::NotFound);
        };
        if current.revision != expected_revision || current.status == ExecutionNodeStatus::Revoked {
            return Ok(ExecutionNodeMutation::Conflict { current });
        }
        let updated = sqlx::query(
            r#"UPDATE execution_nodes SET revision = revision + 1,
               device_key_fingerprint = $1, device_public_key = $2,
               device_token_hash = '', device_token_expires_at = NULL, updated_at = $3
               WHERE id = $4 AND revision = $5 AND status <> 'revoked'"#,
        )
        .bind(device_key_fingerprint)
        .bind(device_public_key)
        .bind(now_text())
        .bind(node_id)
        .bind(i64::try_from(expected_revision)?)
        .execute(&self.pool)
        .await?;
        let current = get_node(&self.pool, node_id)
            .await?
            .ok_or("Execution Node 在设备密钥轮换后消失")?;
        if updated.rows_affected() == 1 {
            Ok(ExecutionNodeMutation::Updated(current))
        } else {
            Ok(ExecutionNodeMutation::Conflict { current })
        }
    }

    async fn create_edge_command(
        &self,
        command: NewEdgeCommand,
    ) -> Result<EdgeCommandRecord, StoreError> {
        let now = now_text();
        let inserted = sqlx::query(
            r#"INSERT INTO edge_execution_commands
               (job_id, revision, target_id, provider_node_id, tool_name, arguments, route_json,
                status, created_at, updated_at)
               VALUES ($1, 1, $2, $3, $4, $5, $6, 'queued', $7, $7)
               ON CONFLICT(job_id) DO NOTHING"#,
        )
        .bind(&command.job_id)
        .bind(&command.target_id)
        .bind(&command.provider_node_id)
        .bind(&command.tool_name)
        .bind(&command.arguments)
        .bind(&command.route)
        .bind(now)
        .execute(&self.pool)
        .await?
        .rows_affected()
            == 1;
        let row = sqlx::query("SELECT * FROM edge_execution_commands WHERE job_id = $1")
            .bind(&command.job_id)
            .fetch_one(&self.pool)
            .await?;
        let current = command_from_row(&row)?;
        if current.target_id != command.target_id
            || current.provider_node_id != command.provider_node_id
            || current.tool_name != command.tool_name
            || current.arguments != command.arguments
            || current.route != command.route
        {
            return Err(format!(
                "Edge Command '{}' 的确定性身份被不同请求复用",
                command.job_id
            )
            .into());
        }
        if inserted {
            self.edge_command_notify.notify_one();
        }
        Ok(current)
    }

    async fn get_edge_command(
        &self,
        job_id: &str,
    ) -> Result<Option<EdgeCommandRecord>, StoreError> {
        sqlx::query("SELECT * FROM edge_execution_commands WHERE job_id = $1")
            .bind(job_id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(command_from_row)
            .transpose()
    }

    async fn claim_edge_command(
        &self,
        provider_node_id: &str,
        worker_id: &str,
        claim_token: &str,
        lease_expires_at: DateTime<Utc>,
        max_in_flight: usize,
    ) -> Result<Option<EdgeCommandRecord>, StoreError> {
        if max_in_flight == 0 {
            return Err("Edge Node max_in_flight 必须大于 0".into());
        }
        let now = now_text();
        let readiness = sqlx::query(
            r#"SELECT
                 EXISTS(SELECT 1 FROM edge_execution_commands
                        WHERE provider_node_id = $1 AND status = 'claimed'
                          AND lease_expires_at <= $2) AS has_expired,
                 EXISTS(SELECT 1 FROM edge_execution_commands
                        WHERE provider_node_id = $1 AND status = 'queued') AS has_queued,
                 (SELECT COUNT(*) FROM edge_execution_commands
                  WHERE provider_node_id = $1
                    AND status IN ('claimed', 'cancel_requested')) AS active"#,
        )
        .bind(provider_node_id)
        .bind(&now)
        .fetch_one(&self.pool)
        .await?;
        let has_expired = readiness.get::<bool, _>("has_expired");
        let has_queued = readiness.get::<bool, _>("has_queued");
        let active = usize::try_from(readiness.get::<i64, _>("active"))?;
        if !has_expired && (!has_queued || active >= max_in_flight) {
            return Ok(None);
        }
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            r#"UPDATE edge_execution_commands SET revision = revision + 1,
               status = CASE WHEN side_effect_started_at IS NULL THEN 'queued' ELSE 'lost' END,
               claimed_by = CASE WHEN side_effect_started_at IS NULL THEN NULL ELSE claimed_by END,
               claim_token = CASE WHEN side_effect_started_at IS NULL THEN NULL ELSE claim_token END,
               lease_expires_at = CASE WHEN side_effect_started_at IS NULL THEN NULL ELSE lease_expires_at END,
               finished_at = CASE WHEN side_effect_started_at IS NULL THEN NULL ELSE $1 END,
               error = CASE WHEN side_effect_started_at IS NULL THEN error ELSE 'Edge Worker lease expired after side-effect boundary' END,
               updated_at = $1
               WHERE provider_node_id = $2 AND status = 'claimed' AND lease_expires_at <= $1"#,
        )
        .bind(&now)
        .bind(provider_node_id)
        .execute(&mut *tx)
        .await?;
        let active = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM edge_execution_commands WHERE provider_node_id = $1 AND status IN ('claimed', 'cancel_requested')",
        )
        .bind(provider_node_id)
        .fetch_one(&mut *tx)
        .await?;
        if usize::try_from(active)? >= max_in_flight {
            tx.commit().await?;
            return Ok(None);
        }
        let candidate = sqlx::query(
            r#"SELECT job_id, revision FROM edge_execution_commands
               WHERE provider_node_id = $1 AND status = 'queued'
               ORDER BY created_at, job_id FOR UPDATE SKIP LOCKED LIMIT 1"#,
        )
        .bind(provider_node_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(candidate) = candidate else {
            tx.commit().await?;
            return Ok(None);
        };
        let job_id: String = candidate.get("job_id");
        let revision: i64 = candidate.get("revision");
        let updated = sqlx::query(
            r#"UPDATE edge_execution_commands SET revision = revision + 1, status = 'claimed',
               claimed_by = $1, claim_token = $2, lease_expires_at = $3,
               heartbeat_at = $4, updated_at = $4
               WHERE job_id = $5 AND revision = $6 AND status = 'queued'"#,
        )
        .bind(worker_id)
        .bind(claim_token)
        .bind(lease_expires_at.to_rfc3339())
        .bind(&now)
        .bind(&job_id)
        .bind(revision)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() == 0 {
            tx.commit().await?;
            return Ok(None);
        }
        let row = sqlx::query("SELECT * FROM edge_execution_commands WHERE job_id = $1")
            .bind(job_id)
            .fetch_one(&mut *tx)
            .await?;
        let command = command_from_row(&row)?;
        tx.commit().await?;
        Ok(Some(command))
    }

    async fn heartbeat_edge_command(
        &self,
        job_id: &str,
        expected_revision: u64,
        claim_token: &str,
        lease_expires_at: DateTime<Utc>,
        side_effect_started: bool,
        progress: Option<String>,
    ) -> Result<EdgeCommandMutation, StoreError> {
        let Some(current) = self.get_edge_command(job_id).await? else {
            return Ok(EdgeCommandMutation::NotFound);
        };
        if current.revision != expected_revision
            || current.claim_token.as_deref() != Some(claim_token)
            || current.status != EdgeCommandStatus::Claimed
        {
            return Ok(EdgeCommandMutation::Conflict { current });
        }
        let now = now_text();
        let updated = sqlx::query(
            r#"UPDATE edge_execution_commands SET revision = revision + 1,
               lease_expires_at = $1, heartbeat_at = $2,
               side_effect_started_at = CASE WHEN $3 THEN COALESCE(side_effect_started_at, $2) ELSE side_effect_started_at END,
               progress = COALESCE($4, progress), updated_at = $2
               WHERE job_id = $5 AND revision = $6 AND status = 'claimed' AND claim_token = $7"#,
        )
        .bind(lease_expires_at.to_rfc3339())
        .bind(now)
        .bind(side_effect_started)
        .bind(progress)
        .bind(job_id)
        .bind(i64::try_from(expected_revision)?)
        .bind(claim_token)
        .execute(&self.pool)
        .await?;
        let current = self
            .get_edge_command(job_id)
            .await?
            .ok_or("Edge Command disappeared after heartbeat")?;
        if updated.rows_affected() == 1 {
            Ok(EdgeCommandMutation::Updated(current))
        } else {
            Ok(EdgeCommandMutation::Conflict { current })
        }
    }

    async fn append_edge_command_output(
        &self,
        job_id: &str,
        claim_token: &str,
        stream: EdgeOutputStream,
        text: &str,
    ) -> Result<EdgeCommandOutputChunk, StoreError> {
        let mut tx = self.pool.begin().await?;
        let command = sqlx::query(
            "SELECT status, claim_token FROM edge_execution_commands WHERE job_id = $1 FOR UPDATE",
        )
        .bind(job_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(command) = command else {
            return Err(format!("Edge Command '{}' 不存在", job_id).into());
        };
        if command.get::<String, _>("status") != "claimed"
            || command.get::<Option<String>, _>("claim_token").as_deref() != Some(claim_token)
        {
            return Err(format!("Edge Command '{}' claim token 已失效", job_id).into());
        }
        let next_sequence = sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM edge_command_output_chunks WHERE job_id = $1",
        )
        .bind(job_id)
        .fetch_one(&mut *tx)
        .await?;
        let row = sqlx::query(
            r#"INSERT INTO edge_command_output_chunks
               (job_id, sequence, stream, text, created_at)
               VALUES ($1, $2, $3, $4, $5) RETURNING *"#,
        )
        .bind(job_id)
        .bind(next_sequence)
        .bind(stream.as_str())
        .bind(text)
        .bind(now_text())
        .fetch_one(&mut *tx)
        .await?;
        let chunk = output_chunk_from_row(&row)?;
        tx.commit().await?;
        Ok(chunk)
    }

    async fn list_edge_command_output(
        &self,
        job_id: &str,
        after_sequence: u64,
        limit: usize,
    ) -> Result<Vec<EdgeCommandOutputChunk>, StoreError> {
        let rows = sqlx::query(
            r#"SELECT * FROM edge_command_output_chunks
               WHERE job_id = $1 AND sequence > $2
               ORDER BY sequence ASC LIMIT $3"#,
        )
        .bind(job_id)
        .bind(i64::try_from(after_sequence)?)
        .bind(i64::try_from(limit.clamp(1, 1_000))?)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(output_chunk_from_row).collect()
    }

    async fn finish_edge_command(
        &self,
        job_id: &str,
        expected_revision: u64,
        claim_token: &str,
        status: EdgeCommandStatus,
        output: Option<String>,
        error: Option<String>,
    ) -> Result<EdgeCommandMutation, StoreError> {
        if !status.is_terminal() {
            return Err("finish Edge Command 只接受终态".into());
        }
        let Some(current) = self.get_edge_command(job_id).await? else {
            return Ok(EdgeCommandMutation::NotFound);
        };
        if current.revision != expected_revision
            || current.claim_token.as_deref() != Some(claim_token)
            || !matches!(
                current.status,
                EdgeCommandStatus::Claimed | EdgeCommandStatus::CancelRequested
            )
        {
            return Ok(EdgeCommandMutation::Conflict { current });
        }
        let now = now_text();
        let updated = sqlx::query(
            r#"UPDATE edge_execution_commands SET revision = revision + 1, status = $1,
               output = $2, error = $3, updated_at = $4, finished_at = $4
               WHERE job_id = $5 AND revision = $6 AND claim_token = $7
                 AND status IN ('claimed', 'cancel_requested')"#,
        )
        .bind(status.as_str())
        .bind(output)
        .bind(error)
        .bind(now)
        .bind(job_id)
        .bind(i64::try_from(expected_revision)?)
        .bind(claim_token)
        .execute(&self.pool)
        .await?;
        let current = self
            .get_edge_command(job_id)
            .await?
            .ok_or("Edge Command disappeared after completion")?;
        if updated.rows_affected() == 1 {
            self.edge_command_notify.notify_one();
            Ok(EdgeCommandMutation::Updated(current))
        } else {
            Ok(EdgeCommandMutation::Conflict { current })
        }
    }

    async fn request_edge_command_cancel(
        &self,
        job_id: &str,
    ) -> Result<Option<EdgeCommandRecord>, StoreError> {
        let now = now_text();
        sqlx::query(
            r#"UPDATE edge_execution_commands SET revision = revision + 1,
               status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE 'cancel_requested' END,
               finished_at = CASE WHEN status = 'queued' THEN $1 ELSE finished_at END,
               updated_at = $1 WHERE job_id = $2 AND status IN ('queued', 'claimed')"#,
        )
        .bind(now)
        .bind(job_id)
        .execute(&self.pool)
        .await?;
        self.get_edge_command(job_id).await
    }

    async fn reconcile_edge_execution(
        &self,
        now: DateTime<Utc>,
        node_stale_before: DateTime<Utc>,
    ) -> Result<EdgeReconciliationReport, StoreError> {
        let now = now.to_rfc3339();
        let stale_before = node_stale_before.to_rfc3339();
        let mut tx = self.pool.begin().await?;
        let nodes = sqlx::query(
            r#"UPDATE execution_nodes SET revision = revision + 1, status = 'offline', updated_at = $1
               WHERE status = 'online' AND (last_seen_at IS NULL OR last_seen_at < $2)"#,
        )
        .bind(&now)
        .bind(&stale_before)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        let targets = sqlx::query(
            r#"UPDATE execution_targets SET revision = revision + 1, status = 'offline', updated_at = $1
               WHERE status = 'online' AND provider_node_id IN (
                   SELECT id FROM execution_nodes WHERE status IN ('offline', 'revoked')
               )"#,
        )
        .bind(&now)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        let requeued = sqlx::query(
            r#"UPDATE edge_execution_commands SET revision = revision + 1, status = 'queued',
               claimed_by = NULL, claim_token = NULL, lease_expires_at = NULL,
               heartbeat_at = NULL, updated_at = $1
               WHERE status = 'claimed' AND lease_expires_at <= $1
                 AND side_effect_started_at IS NULL"#,
        )
        .bind(&now)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        let lost = sqlx::query(
            r#"UPDATE edge_execution_commands SET revision = revision + 1, status = 'lost',
               error = 'Edge Worker lease expired after side-effect boundary or cancellation request',
               finished_at = $1, updated_at = $1
               WHERE lease_expires_at <= $1 AND (
                   (status = 'claimed' AND side_effect_started_at IS NOT NULL)
                   OR status = 'cancel_requested'
               )"#,
        )
        .bind(&now)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        tx.commit().await?;
        if requeued > 0 {
            self.edge_command_notify.notify_waiters();
        }
        Ok(EdgeReconciliationReport {
            nodes_marked_offline: nodes,
            targets_marked_offline: targets,
            commands_requeued: requeued,
            commands_marked_lost: lost,
        })
    }
}
