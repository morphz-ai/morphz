//! Offline native validation of a staged restore candidate. This module never
//! constructs a Runtime, resolves credentials, claims ownership or starts work.
//! A valid snapshot is not proof about effects/inputs AFTER its recovery point.
use super::{protocol::Change, quiescence, replica::Replica};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt};

pub const RECOVERY_PROTOCOL: &str = "morphz-native-recovery/1";
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
const MAX_ROWS: u64 = 250_000;
const MAX_BYTES: usize = 64 * 1024 * 1024;

/// Deliberately fixed codes: parse/SQL errors can embed imported private data.
#[derive(Debug, PartialEq, Eq)]
pub struct RecoveryError(pub &'static str);
impl std::fmt::Display for RecoveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for RecoveryError {}
type Result<T> = std::result::Result<T, RecoveryError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryHeader {
    pub protocol: String,
    pub schema: String,
    pub fingerprint: String,
    pub records: u64,
    pub records_digest: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReport {
    pub protocol: &'static str,
    pub schema: String,
    pub fingerprint: String,
    pub records: u64,
    pub records_digest: String,
    pub execution_authority: &'static str,
    pub requires_reconciliation: bool,
    pub captured_work: Vec<&'static str>,
    pub next_wake_at_ms: Option<i64>,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RecoveryFrame {
    Header { header: RecoveryHeader },
    Page { records: Vec<Change> },
    End,
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn hash_json(value: &impl Serialize) -> Result<String> {
    let bytes =
        serde_json::to_vec(value).map_err(|_| RecoveryError("native_recovery_invalid_input"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
/// Arrays and tagged string values give a byte-identical JSON hash contract
/// with the Cloud boundary without relying on object-property ordering.
pub fn initial_digest(schema: &str, fingerprint: &str) -> Result<String> {
    hash_json(&(RECOVERY_PROTOCOL, schema, fingerprint))
}
pub fn extend_digest(previous: &str, record: &Change) -> Result<String> {
    hash_json(&(previous, (&record.table, &record.key, &record.values)))
}
pub async fn native_schema() -> Result<String> {
    Ok(Replica::create()
        .await
        .map_err(|_| RecoveryError("native_recovery_schema_unavailable"))?
        .schema)
}

pub struct NativeRecoveryVerifier {
    replica: Option<Replica>,
    header: RecoveryHeader,
    migrations: Vec<String>,
    rows: u64,
    bytes: usize,
    chain: String,
}
impl NativeRecoveryVerifier {
    pub async fn begin(header: RecoveryHeader) -> Result<Self> {
        if header.protocol != RECOVERY_PROTOCOL
            || !valid_hash(&header.schema)
            || !valid_hash(&header.fingerprint)
            || !valid_hash(&header.records_digest)
            || header.records > MAX_ROWS
        {
            return Err(RecoveryError("native_recovery_invalid_header"));
        }
        let replica = Replica::create()
            .await
            .map_err(|_| RecoveryError("native_recovery_schema_unavailable"))?;
        if replica.schema != header.schema {
            return Err(RecoveryError("native_recovery_schema_mismatch"));
        }
        let migrations =
            sqlx::query_scalar("SELECT version FROM schema_migrations ORDER BY version")
                .fetch_all(replica.pool())
                .await
                .map_err(|_| RecoveryError("native_recovery_schema_unavailable"))?;
        replica
            .clear_seed()
            .await
            .map_err(|_| RecoveryError("native_recovery_validation_failed"))?;
        let chain = initial_digest(&header.schema, &header.fingerprint)?;
        Ok(Self {
            replica: Some(replica),
            header,
            migrations,
            rows: 0,
            bytes: 0,
            chain,
        })
    }
    /// Any failed/cancelled page poisons this verifier. Never resume a partly
    /// imported in-memory SQL transaction as if the page had been atomic.
    pub async fn append(&mut self, records: &[Change]) -> Result<()> {
        let replica = self
            .replica
            .take()
            .ok_or(RecoveryError("native_recovery_verifier_invalid"))?;
        if records.is_empty()
            || records.len() > 500
            || self.rows + records.len() as u64 > self.header.records
        {
            return Err(RecoveryError("native_recovery_record_count_mismatch"));
        }
        let mut chain = self.chain.clone();
        for record in records {
            let encoded = serde_json::to_vec(&(&record.table, &record.key, &record.values))
                .map_err(|_| RecoveryError("native_recovery_invalid_record"))?;
            self.bytes = self
                .bytes
                .checked_add(encoded.len())
                .ok_or(RecoveryError("native_recovery_capacity_exceeded"))?;
            if encoded.len() > super::protocol::MAX_RECORD_BYTES || self.bytes > MAX_BYTES {
                return Err(RecoveryError("native_recovery_capacity_exceeded"));
            }
            chain = extend_digest(&chain, record)?;
        }
        replica
            .import(records)
            .await
            .map_err(|_| RecoveryError("native_recovery_invalid_record"))?;
        self.rows += records.len() as u64;
        self.chain = chain;
        self.replica = Some(replica);
        Ok(())
    }
    pub async fn finish(mut self) -> Result<RecoveryReport> {
        let replica = self
            .replica
            .take()
            .ok_or(RecoveryError("native_recovery_verifier_invalid"))?;
        if self.rows != self.header.records {
            return Err(RecoveryError("native_recovery_incomplete"));
        }
        if self.chain != self.header.records_digest {
            return Err(RecoveryError("native_recovery_digest_mismatch"));
        }
        replica
            .finish_import()
            .await
            .map_err(|_| RecoveryError("native_recovery_relational_integrity_failed"))?;
        let actual: Vec<String> =
            sqlx::query_scalar("SELECT version FROM schema_migrations ORDER BY version")
                .fetch_all(replica.pool())
                .await
                .map_err(|_| RecoveryError("native_recovery_validation_failed"))?;
        if actual != self.migrations {
            return Err(RecoveryError("native_recovery_migration_identity_mismatch"));
        }
        let work = quiescence::inspect(&replica.store)
            .await
            .map_err(|_| RecoveryError("native_recovery_work_inspection_failed"))?;
        Ok(RecoveryReport {
            protocol: RECOVERY_PROTOCOL,
            schema: self.header.schema,
            fingerprint: self.header.fingerprint,
            records: self.rows,
            records_digest: self.chain,
            execution_authority: "none",
            requires_reconciliation: true,
            captured_work: work.blockers,
            next_wake_at_ms: work.next_wake.map(|time| time.timestamp_millis()),
        })
    }
}

async fn frame(reader: &mut (impl AsyncBufRead + Unpin)) -> Result<Option<RecoveryFrame>> {
    let mut bytes = Vec::new();
    let size = (&mut *reader)
        .take((MAX_FRAME_BYTES + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .await
        .map_err(|_| RecoveryError("native_recovery_input_failed"))?;
    if size == 0 {
        return Ok(None);
    }
    if size > MAX_FRAME_BYTES {
        return Err(RecoveryError("native_recovery_frame_too_large"));
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| RecoveryError("native_recovery_invalid_input"))
}
/// Bounded NDJSON: one header, zero or more nonempty pages, one end, then EOF.
/// No success report before EOF; trailing/partial input cannot be ignored.
pub async fn verify_stream(mut reader: impl AsyncBufRead + Unpin) -> Result<RecoveryReport> {
    let Some(RecoveryFrame::Header { header }) = frame(&mut reader).await? else {
        return Err(RecoveryError("native_recovery_header_required"));
    };
    let mut verifier = NativeRecoveryVerifier::begin(header).await?;
    loop {
        match frame(&mut reader).await? {
            Some(RecoveryFrame::Page { records }) => verifier.append(&records).await?,
            Some(RecoveryFrame::End) => {
                if frame(&mut reader).await?.is_some() {
                    return Err(RecoveryError("native_recovery_trailing_input"));
                }
                return verifier.finish().await;
            }
            _ => return Err(RecoveryError("native_recovery_incomplete")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn fixture() -> (RecoveryHeader, Vec<Change>) {
        from_replica(Replica::create().await.unwrap()).await
    }
    async fn from_replica(source: Replica) -> (RecoveryHeader, Vec<Change>) {
        let records = source.seed().await.unwrap();
        let mut header = RecoveryHeader {
            protocol: RECOVERY_PROTOCOL.into(),
            schema: source.schema,
            fingerprint: "a".repeat(64),
            records: records.len() as u64,
            records_digest: String::new(),
        };
        seal(&mut header, &records);
        (header, records)
    }
    fn seal(header: &mut RecoveryHeader, records: &[Change]) {
        header.records = records.len() as u64;
        header.records_digest = records
            .iter()
            .try_fold(
                initial_digest(&header.schema, &header.fingerprint).unwrap(),
                |chain, record| extend_digest(&chain, record),
            )
            .unwrap();
    }
    async fn verify(header: RecoveryHeader, records: &[Change]) -> Result<RecoveryReport> {
        let mut verifier = NativeRecoveryVerifier::begin(header).await?;
        for page in records.chunks(10) {
            verifier.append(page).await?;
        }
        verifier.finish().await
    }
    #[tokio::test]
    async fn complete_native_snapshot_validates_without_execution_authority() {
        let (header, records) = fixture().await;
        let report = verify(header.clone(), &records).await.unwrap();
        assert_eq!(report.schema, header.schema);
        assert_eq!(report.records_digest, header.records_digest);
        assert_eq!(report.execution_authority, "none");
        assert!(report.requires_reconciliation);
        assert!(report.captured_work.is_empty());
    }
    #[tokio::test]
    async fn reports_due_native_work_without_claiming_or_firing_it() {
        use crate::memory::{NewRuntimeTimer, RuntimeTimerKind, TimerStore};
        let source = Replica::create().await.unwrap();
        let due = chrono::Utc::now() - chrono::Duration::seconds(1);
        source
            .store
            .upsert_runtime_timer(NewRuntimeTimer {
                id: "offline-timer".into(),
                generation: 1,
                kind: RuntimeTimerKind::Schedule,
                owner_id: "offline-schedule".into(),
                due_at: due,
                payload: serde_json::json!({}),
            })
            .await
            .unwrap();
        let (header, records) = from_replica(source).await;
        let report = verify(header, &records).await.unwrap();
        assert_eq!(report.captured_work, ["due_timer"]);
        assert_eq!(report.next_wake_at_ms, Some(due.timestamp_millis()));
        assert_eq!(report.execution_authority, "none");
        assert!(report.requires_reconciliation);
    }
    #[tokio::test]
    async fn correct_digest_cannot_hide_missing_relations_or_duplicate_rows() {
        let source = Replica::create().await.unwrap();
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(source.pool())
            .await
            .unwrap();
        sqlx::query("INSERT INTO session_projections(event_id, context_id, session_id, event_sequence) VALUES ('missing-event', 'synthetic-context', NULL, 1)")
            .execute(source.pool()).await.unwrap();
        let (header, records) = from_replica(source).await;
        assert_eq!(
            verify(header, &records).await.unwrap_err().0,
            "native_recovery_relational_integrity_failed"
        );
        let (mut header, mut records) = fixture().await;
        records.push(records[0].clone());
        seal(&mut header, &records);
        assert_eq!(
            verify(header, &records).await.unwrap_err().0,
            "native_recovery_invalid_record"
        );
    }
    #[tokio::test]
    async fn schema_digest_count_and_migration_mismatches_fail_closed() {
        let (header, records) = fixture().await;
        let mut bad = header.clone();
        bad.schema = "0".repeat(64);
        assert_eq!(
            NativeRecoveryVerifier::begin(bad).await.err().unwrap().0,
            "native_recovery_schema_mismatch"
        );
        let mut bad = header.clone();
        bad.records_digest = "0".repeat(64);
        assert_eq!(
            verify(bad, &records).await.unwrap_err().0,
            "native_recovery_digest_mismatch"
        );
        assert_eq!(
            verify(header.clone(), &records[..records.len() - 1])
                .await
                .unwrap_err()
                .0,
            "native_recovery_incomplete"
        );
        let without_migrations: Vec<_> = records
            .into_iter()
            .filter(|record| record.table != "schema_migrations")
            .collect();
        let mut bad = header;
        seal(&mut bad, &without_migrations);
        assert_eq!(
            verify(bad, &without_migrations).await.unwrap_err().0,
            "native_recovery_migration_identity_mismatch"
        );
    }
    #[tokio::test]
    async fn partial_page_failure_poisons_verifier_and_errors_do_not_echo_data() {
        let (mut header, mut records) = fixture().await;
        records.push(Change {
            table: "PRIVATE_DO_NOT_ECHO".into(),
            key: "1".into(),
            values: Some(vec![]),
        });
        seal(&mut header, &records);
        let mut verifier = NativeRecoveryVerifier::begin(header).await.unwrap();
        let partial = vec![records[0].clone(), records.last().unwrap().clone()];
        assert_eq!(
            verifier.append(&partial).await.unwrap_err().to_string(),
            "native_recovery_invalid_record"
        );
        assert_eq!(
            verifier.finish().await.unwrap_err().0,
            "native_recovery_verifier_invalid"
        );
    }
    #[tokio::test]
    async fn stream_requires_exact_end_and_bounded_input() {
        let (header, records) = fixture().await;
        let mut bytes = Vec::new();
        let frames = std::iter::once(RecoveryFrame::Header { header }).chain(
            records.chunks(100).map(|page| RecoveryFrame::Page {
                records: page.to_vec(),
            }),
        );
        for frame in frames {
            bytes.extend(serde_json::to_vec(&frame).unwrap());
            bytes.push(b'\n');
        }
        assert_eq!(
            verify_stream(&bytes[..]).await.unwrap_err().0,
            "native_recovery_incomplete"
        );
        bytes.extend(b"{\"kind\":\"end\"}\n");
        assert_eq!(
            verify_stream(&bytes[..]).await.unwrap().execution_authority,
            "none"
        );
        bytes.extend(b"{\"kind\":\"end\"}\n");
        assert_eq!(
            verify_stream(&bytes[..]).await.unwrap_err().0,
            "native_recovery_trailing_input"
        );
        assert_eq!(
            verify_stream(&vec![b'x'; MAX_FRAME_BYTES + 1][..])
                .await
                .unwrap_err()
                .0,
            "native_recovery_frame_too_large"
        );
    }
}
