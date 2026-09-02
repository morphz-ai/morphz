//! Content-addressed storage for model-visible binary inputs.
//!
//! persisted Events retain only metadata and a storage reference. Bytes are
//! loaded, digest-checked, and converted to Provider-native content parts only
//! while assembling a model request.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::{Duration, SystemTime};

use base64::Engine as _;
use chrono::{DateTime, Utc};
use futures_util::{Stream, StreamExt as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt as _;
use tokio::sync::Mutex;

use crate::llm::{
    attachment_message, Message, ModelAttachment, ModelInputLimits, MODEL_ATTACHMENT_MESSAGE_NAME,
};
use crate::sdk::MessageAttachmentInput;

pub type ModelInputError = Box<dyn std::error::Error + Send + Sync>;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ModelInputUsage {
    pub attachment_count: usize,
    pub total_bytes: usize,
    pub largest_attachment_bytes: usize,
}

/// A message-input import which has durable bytes but is not yet owned by an
/// immutable persisted Event. The pending manifest is deliberately filesystem
/// durable: a Runtime crash between preparing bytes and `claim_message` can be
/// reconciled against the Event Store on the next start.
#[derive(Debug)]
pub struct PreparedMessageAttachments {
    metadata: Vec<Value>,
    root: PathBuf,
    scope_key: String,
    event_id: String,
    digests: Vec<String>,
    workspace_root: Option<PathBuf>,
    workspace_directory: Option<PathBuf>,
}

impl PreparedMessageAttachments {
    pub fn metadata(&self) -> &[Value] {
        &self.metadata
    }

    /// Commits filesystem ownership after the immutable Event transaction has
    /// committed. Failure to remove the manifest is recoverable: startup
    /// reconciliation will observe the Event and remove only the manifest.
    pub async fn commit(self) -> Result<(), ModelInputError> {
        remove_file_if_exists(&pending_manifest_path(&self.root, &self.event_id)).await
    }

    /// Removes only this candidate Event's references. Shared content blobs
    /// remain while another Event reference exists and are otherwise removed.
    pub async fn discard(self) -> Result<(), ModelInputError> {
        discard_prepared_message_attachments(
            &self.root,
            &self.scope_key,
            &self.event_id,
            &self.digests,
            self.workspace_directory.as_deref(),
        )
        .await
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MessageAttachmentRecovery {
    pub committed_manifests: usize,
    pub orphaned_imports: usize,
    pub deferred_live_imports: usize,
    pub invalid_manifests: usize,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageAttachmentStageStatus {
    Uploading,
    Ready,
    Consumed,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct MessageAttachmentStage {
    pub stage_id: String,
    pub principal_id: String,
    pub session_id: String,
    pub client_message_id: String,
    pub name: String,
    pub media_type: String,
    pub size_bytes: u64,
    pub offset: u64,
    pub expected_sha256: Option<String>,
    pub sha256: Option<String>,
    pub status: MessageAttachmentStageStatus,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub consumed_event_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewMessageAttachmentStage {
    pub stage_id: String,
    pub principal_id: String,
    pub session_id: String,
    pub client_message_id: String,
    pub name: String,
    pub media_type: String,
    pub size_bytes: u64,
    pub expected_sha256: Option<String>,
}

#[derive(Debug, Clone)]
pub struct StagedMessageAttachmentSource {
    pub stage_id: String,
    pub name: String,
    pub media_type: String,
    pub size_bytes: usize,
    pub sha256: String,
    pub path: PathBuf,
}

enum MessageAttachmentImportSource {
    Inline(Vec<u8>),
    Staged(PathBuf),
}

struct MessageAttachmentImport {
    name: String,
    media_type: String,
    size_bytes: usize,
    sha256: String,
    source: MessageAttachmentImportSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageAttachmentStageErrorKind {
    InvalidArgument,
    NotFound,
    Forbidden,
    Conflict,
    ResourceExhausted,
    Internal,
}

#[derive(Debug)]
pub struct MessageAttachmentStageError {
    pub kind: MessageAttachmentStageErrorKind,
    pub message: String,
}

impl MessageAttachmentStageError {
    fn new(kind: MessageAttachmentStageErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    fn internal(error: impl std::fmt::Display) -> Self {
        Self::new(MessageAttachmentStageErrorKind::Internal, error.to_string())
    }
}

impl std::fmt::Display for MessageAttachmentStageError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for MessageAttachmentStageError {}

pub type MessageAttachmentStageResult<T> = Result<T, MessageAttachmentStageError>;

/// Durable, resumable message-input staging. Stages are deliberately outside
/// the Event Ledger: they are drafts owned by one Principal, Session, and
/// client_message_id until an immutable user Event claims them.
#[derive(Clone)]
pub struct MessageAttachmentStageStore {
    root: PathBuf,
    ttl: Duration,
    locks: Arc<Mutex<HashMap<String, Weak<Mutex<()>>>>>,
}

impl MessageAttachmentStageStore {
    pub fn new(configured_root: impl AsRef<Path>, ttl: Duration) -> Result<Self, ModelInputError> {
        Ok(Self {
            root: absolute_root(configured_root.as_ref())?
                .join("message-inputs-v2")
                .join("staging"),
            ttl,
            locks: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub async fn create(
        &self,
        stage: NewMessageAttachmentStage,
        limits: ModelInputLimits,
    ) -> MessageAttachmentStageResult<MessageAttachmentStage> {
        validate_stage_identifier(&stage.stage_id, "attachment stage id")?;
        validate_stage_identifier(&stage.client_message_id, "client_message_id")?;
        if stage.principal_id.trim().is_empty() || stage.session_id.trim().is_empty() {
            return Err(stage_invalid(
                "attachment stage requires a Principal and Session",
            ));
        }
        let name =
            safe_attachment_name(&stage.name).map_err(|error| stage_invalid(error.to_string()))?;
        let media_type = safe_media_type(&stage.media_type, &name)
            .map_err(|error| stage_invalid(error.to_string()))?;
        let size_bytes = usize::try_from(stage.size_bytes)
            .map_err(|_| stage_exhausted("attachment size exceeds this platform"))?;
        validate_model_input_usage(
            ModelInputUsage {
                attachment_count: 1,
                total_bytes: size_bytes,
                largest_attachment_bytes: size_bytes,
            },
            limits,
            "this attachment stage",
        )
        .map_err(|error| stage_exhausted(error.to_string()))?;
        let expected_sha256 = stage
            .expected_sha256
            .as_deref()
            .map(normalize_sha256)
            .transpose()?;
        let lock = self.stage_lock(&stage.session_id, &stage.stage_id).await;
        let _guard = lock.lock().await;
        if let Some(existing) = self.read_record(&stage.session_id, &stage.stage_id).await? {
            if existing.expires_at <= Utc::now() {
                tokio::fs::remove_dir_all(
                    self.stage_directory(&stage.session_id, &stage.stage_id)?,
                )
                .await
                .map_err(MessageAttachmentStageError::internal)?;
            } else {
                if existing.principal_id == stage.principal_id
                    && existing.client_message_id == stage.client_message_id
                    && existing.name == name
                    && existing.media_type == media_type
                    && existing.size_bytes == stage.size_bytes
                    && existing.expected_sha256 == expected_sha256
                {
                    return Ok(existing);
                }
                return Err(MessageAttachmentStageError::new(
                    MessageAttachmentStageErrorKind::Conflict,
                    format!(
                        "attachment stage '{}' already exists with a different declaration",
                        stage.stage_id
                    ),
                ));
            }
        }
        let directory = self.stage_directory(&stage.session_id, &stage.stage_id)?;
        tokio::fs::create_dir_all(&directory)
            .await
            .map_err(MessageAttachmentStageError::internal)?;
        let created_at = Utc::now();
        let expires_at = created_at
            + chrono::Duration::from_std(self.ttl)
                .map_err(MessageAttachmentStageError::internal)?;
        let record = MessageAttachmentStage {
            stage_id: stage.stage_id,
            principal_id: stage.principal_id,
            session_id: stage.session_id,
            client_message_id: stage.client_message_id,
            name,
            media_type,
            size_bytes: stage.size_bytes,
            offset: 0,
            expected_sha256,
            sha256: None,
            status: MessageAttachmentStageStatus::Uploading,
            created_at,
            expires_at,
            consumed_event_id: None,
        };
        self.write_record(&record).await?;
        Ok(record)
    }

    pub async fn inspect(
        &self,
        principal_id: &str,
        session_id: &str,
        stage_id: &str,
    ) -> MessageAttachmentStageResult<MessageAttachmentStage> {
        let lock = self.stage_lock(session_id, stage_id).await;
        let _guard = lock.lock().await;
        let record = self
            .authorized_record(principal_id, session_id, stage_id)
            .await?;
        self.reject_expired(&record).await?;
        Ok(record)
    }

    pub async fn list(
        &self,
        principal_id: &str,
        session_id: &str,
        client_message_id: Option<&str>,
    ) -> MessageAttachmentStageResult<Vec<MessageAttachmentStage>> {
        let session_directory = self.session_directory(session_id);
        if !tokio::fs::try_exists(&session_directory)
            .await
            .map_err(MessageAttachmentStageError::internal)?
        {
            return Ok(Vec::new());
        }
        let mut entries = tokio::fs::read_dir(session_directory)
            .await
            .map_err(MessageAttachmentStageError::internal)?;
        let mut records = Vec::new();
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(MessageAttachmentStageError::internal)?
        {
            let Ok(bytes) = tokio::fs::read(entry.path().join("manifest.json")).await else {
                continue;
            };
            let Ok(index_record) = serde_json::from_slice::<MessageAttachmentStage>(&bytes) else {
                continue;
            };
            let stage_id = index_record.stage_id;
            let lock = self.stage_lock(session_id, &stage_id).await;
            let _guard = lock.lock().await;
            let Ok(record) = self
                .authorized_record(principal_id, session_id, &stage_id)
                .await
            else {
                continue;
            };
            if record.expires_at <= Utc::now()
                || client_message_id
                    .is_some_and(|message_id| record.client_message_id != message_id)
            {
                continue;
            }
            records.push(record);
        }
        records.sort_by_key(|record| record.created_at);
        Ok(records)
    }

    pub async fn upload<S, B, E>(
        &self,
        principal_id: &str,
        session_id: &str,
        stage_id: &str,
        requested_offset: u64,
        stream: S,
    ) -> MessageAttachmentStageResult<MessageAttachmentStage>
    where
        S: Stream<Item = Result<B, E>>,
        B: AsRef<[u8]>,
        E: std::fmt::Display,
    {
        futures_util::pin_mut!(stream);
        let lock = self.stage_lock(session_id, stage_id).await;
        let _guard = lock.lock().await;
        let mut record = self
            .authorized_record(principal_id, session_id, stage_id)
            .await?;
        self.reject_expired(&record).await?;
        if matches!(
            record.status,
            MessageAttachmentStageStatus::Ready | MessageAttachmentStageStatus::Consumed
        ) {
            return Ok(record);
        }
        if requested_offset != record.offset {
            return Err(MessageAttachmentStageError::new(
                MessageAttachmentStageErrorKind::Conflict,
                format!(
                    "attachment upload offset conflict; expected {}",
                    record.offset
                ),
            ));
        }
        let directory = self.stage_directory(session_id, stage_id)?;
        let partial_path = directory.join("content.partial");
        let final_path = directory.join("content");
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&partial_path)
            .await
            .map_err(MessageAttachmentStageError::internal)?;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| stage_invalid(error.to_string()))?;
            let bytes = chunk.as_ref();
            let next_offset = record.offset.saturating_add(bytes.len() as u64);
            if next_offset > record.size_bytes {
                return Err(stage_exhausted(
                    "attachment upload exceeds the declared size",
                ));
            }
            file.write_all(bytes)
                .await
                .map_err(MessageAttachmentStageError::internal)?;
            record.offset = next_offset;
        }
        file.sync_data()
            .await
            .map_err(MessageAttachmentStageError::internal)?;
        drop(file);
        if record.offset < record.size_bytes {
            self.write_record(&record).await?;
            return Ok(record);
        }
        let digest = sha256_file(&partial_path)
            .await
            .map_err(MessageAttachmentStageError::internal)?;
        if record
            .expected_sha256
            .as_deref()
            .is_some_and(|expected| expected != digest)
        {
            let _ = tokio::fs::remove_file(&partial_path).await;
            record.offset = 0;
            self.write_record(&record).await?;
            return Err(MessageAttachmentStageError::new(
                MessageAttachmentStageErrorKind::Conflict,
                "attachment digest does not match the declaration",
            ));
        }
        tokio::fs::rename(&partial_path, &final_path)
            .await
            .map_err(MessageAttachmentStageError::internal)?;
        record.sha256 = Some(digest);
        record.status = MessageAttachmentStageStatus::Ready;
        self.write_record(&record).await?;
        Ok(record)
    }

    pub async fn cancel(
        &self,
        principal_id: &str,
        session_id: &str,
        stage_id: &str,
    ) -> MessageAttachmentStageResult<()> {
        let lock = self.stage_lock(session_id, stage_id).await;
        let _guard = lock.lock().await;
        let record = self
            .authorized_record(principal_id, session_id, stage_id)
            .await?;
        if record.status == MessageAttachmentStageStatus::Consumed {
            return Err(MessageAttachmentStageError::new(
                MessageAttachmentStageErrorKind::Conflict,
                "an attachment stage already bound to a message cannot be cancelled",
            ));
        }
        tokio::fs::remove_dir_all(self.stage_directory(session_id, stage_id)?)
            .await
            .map_err(MessageAttachmentStageError::internal)
    }

    pub async fn resolve_for_message(
        &self,
        principal_id: &str,
        session_id: &str,
        client_message_id: &str,
        stage_ids: &[String],
    ) -> MessageAttachmentStageResult<Vec<StagedMessageAttachmentSource>> {
        let mut sources = Vec::with_capacity(stage_ids.len());
        let mut unique = std::collections::HashSet::new();
        for stage_id in stage_ids {
            if !unique.insert(stage_id) {
                continue;
            }
            let record = self.inspect(principal_id, session_id, stage_id).await?;
            if record.client_message_id != client_message_id {
                return Err(MessageAttachmentStageError::new(
                    MessageAttachmentStageErrorKind::Forbidden,
                    format!(
                        "attachment stage '{}' belongs to a different draft message",
                        stage_id
                    ),
                ));
            }
            if !matches!(
                record.status,
                MessageAttachmentStageStatus::Ready | MessageAttachmentStageStatus::Consumed
            ) {
                return Err(MessageAttachmentStageError::new(
                    MessageAttachmentStageErrorKind::Conflict,
                    format!("attachment stage '{}' is not ready", stage_id),
                ));
            }
            let sha256 = record.sha256.clone().ok_or_else(|| {
                MessageAttachmentStageError::new(
                    MessageAttachmentStageErrorKind::Conflict,
                    format!("attachment stage '{}' has no verified digest", stage_id),
                )
            })?;
            sources.push(StagedMessageAttachmentSource {
                stage_id: stage_id.clone(),
                name: record.name,
                media_type: record.media_type,
                size_bytes: usize::try_from(record.size_bytes)
                    .map_err(|_| stage_exhausted("attachment size exceeds this platform"))?,
                sha256,
                path: self.stage_directory(session_id, stage_id)?.join("content"),
            });
        }
        Ok(sources)
    }

    pub async fn mark_consumed(
        &self,
        principal_id: &str,
        session_id: &str,
        client_message_id: &str,
        stage_ids: &[String],
        event_id: &str,
    ) -> MessageAttachmentStageResult<()> {
        for stage_id in stage_ids {
            let lock = self.stage_lock(session_id, stage_id).await;
            let _guard = lock.lock().await;
            let mut record = self
                .authorized_record(principal_id, session_id, stage_id)
                .await?;
            if record.client_message_id != client_message_id {
                return Err(MessageAttachmentStageError::new(
                    MessageAttachmentStageErrorKind::Forbidden,
                    "attachment stage belongs to a different draft message",
                ));
            }
            if let Some(existing) = record.consumed_event_id.as_deref() {
                if existing == event_id {
                    continue;
                }
                return Err(MessageAttachmentStageError::new(
                    MessageAttachmentStageErrorKind::Conflict,
                    format!("attachment stage '{}' is already consumed", stage_id),
                ));
            }
            record.status = MessageAttachmentStageStatus::Consumed;
            record.consumed_event_id = Some(event_id.to_string());
            self.write_record(&record).await?;
        }
        Ok(())
    }

    pub async fn reap_expired(&self) -> MessageAttachmentStageResult<usize> {
        if !tokio::fs::try_exists(&self.root)
            .await
            .map_err(MessageAttachmentStageError::internal)?
        {
            return Ok(0);
        }
        let mut removed = 0;
        let mut sessions = tokio::fs::read_dir(&self.root)
            .await
            .map_err(MessageAttachmentStageError::internal)?;
        while let Some(session) = sessions
            .next_entry()
            .await
            .map_err(MessageAttachmentStageError::internal)?
        {
            let mut stages = match tokio::fs::read_dir(session.path()).await {
                Ok(stages) => stages,
                Err(_) => continue,
            };
            while let Some(stage) = stages
                .next_entry()
                .await
                .map_err(MessageAttachmentStageError::internal)?
            {
                let manifest = stage.path().join("manifest.json");
                let Ok(bytes) = tokio::fs::read(&manifest).await else {
                    continue;
                };
                let Ok(record) = serde_json::from_slice::<MessageAttachmentStage>(&bytes) else {
                    continue;
                };
                let lock = self.stage_lock(&record.session_id, &record.stage_id).await;
                let _guard = lock.lock().await;
                let Some(current) = self
                    .read_record(&record.session_id, &record.stage_id)
                    .await?
                else {
                    continue;
                };
                if current.expires_at <= Utc::now()
                    && tokio::fs::remove_dir_all(
                        self.stage_directory(&current.session_id, &current.stage_id)?,
                    )
                    .await
                    .is_ok()
                {
                    removed += 1;
                }
            }
        }
        Ok(removed)
    }

    async fn authorized_record(
        &self,
        principal_id: &str,
        session_id: &str,
        stage_id: &str,
    ) -> MessageAttachmentStageResult<MessageAttachmentStage> {
        let record = self
            .read_record(session_id, stage_id)
            .await?
            .ok_or_else(|| {
                MessageAttachmentStageError::new(
                    MessageAttachmentStageErrorKind::NotFound,
                    format!("attachment stage '{}' does not exist", stage_id),
                )
            })?;
        if record.principal_id != principal_id {
            return Err(MessageAttachmentStageError::new(
                MessageAttachmentStageErrorKind::Forbidden,
                "attachment stage belongs to a different Principal",
            ));
        }
        if record.session_id != session_id {
            return Err(MessageAttachmentStageError::new(
                MessageAttachmentStageErrorKind::Forbidden,
                "attachment stage belongs to a different Session",
            ));
        }
        Ok(record)
    }

    async fn reject_expired(
        &self,
        record: &MessageAttachmentStage,
    ) -> MessageAttachmentStageResult<()> {
        if record.expires_at > Utc::now() {
            return Ok(());
        }
        let _ =
            tokio::fs::remove_dir_all(self.stage_directory(&record.session_id, &record.stage_id)?)
                .await;
        Err(MessageAttachmentStageError::new(
            MessageAttachmentStageErrorKind::NotFound,
            format!("attachment stage '{}' has expired", record.stage_id),
        ))
    }

    async fn read_record(
        &self,
        session_id: &str,
        stage_id: &str,
    ) -> MessageAttachmentStageResult<Option<MessageAttachmentStage>> {
        let directory = self.stage_directory(session_id, stage_id)?;
        let path = directory.join("manifest.json");
        let bytes = match tokio::fs::read(path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(MessageAttachmentStageError::internal(error)),
        };
        let mut record: MessageAttachmentStage =
            serde_json::from_slice(&bytes).map_err(MessageAttachmentStageError::internal)?;
        let final_path = directory.join("content");
        let partial_path = directory.join("content.partial");
        if tokio::fs::try_exists(&final_path)
            .await
            .map_err(MessageAttachmentStageError::internal)?
        {
            let metadata = tokio::fs::metadata(&final_path)
                .await
                .map_err(MessageAttachmentStageError::internal)?;
            record.offset = metadata.len();
            if record.sha256.is_none() {
                record.sha256 = Some(
                    sha256_file(&final_path)
                        .await
                        .map_err(MessageAttachmentStageError::internal)?,
                );
            }
            if record.status == MessageAttachmentStageStatus::Uploading {
                record.status = MessageAttachmentStageStatus::Ready;
                self.write_record(&record).await?;
            }
        } else if tokio::fs::try_exists(&partial_path)
            .await
            .map_err(MessageAttachmentStageError::internal)?
        {
            record.offset = tokio::fs::metadata(partial_path)
                .await
                .map_err(MessageAttachmentStageError::internal)?
                .len();
        } else {
            record.offset = 0;
        }
        Ok(Some(record))
    }

    async fn write_record(
        &self,
        record: &MessageAttachmentStage,
    ) -> MessageAttachmentStageResult<()> {
        let directory = self.stage_directory(&record.session_id, &record.stage_id)?;
        tokio::fs::create_dir_all(&directory)
            .await
            .map_err(MessageAttachmentStageError::internal)?;
        let path = directory.join("manifest.json");
        let temporary = directory.join("manifest.json.partial");
        let document = serde_json::to_vec(record).map_err(MessageAttachmentStageError::internal)?;
        let mut file = tokio::fs::File::create(&temporary)
            .await
            .map_err(MessageAttachmentStageError::internal)?;
        file.write_all(&document)
            .await
            .map_err(MessageAttachmentStageError::internal)?;
        file.sync_all()
            .await
            .map_err(MessageAttachmentStageError::internal)?;
        drop(file);
        let rename_error = match tokio::fs::rename(&temporary, &path).await {
            Ok(()) => return Ok(()),
            Err(error) => error,
        };
        #[cfg(windows)]
        if tokio::fs::try_exists(&path)
            .await
            .map_err(MessageAttachmentStageError::internal)?
        {
            // Windows does not replace an existing destination with rename.
            // The per-stage lock keeps this short fallback window private to
            // the current Runtime process; Unix keeps its atomic replacement.
            tokio::fs::remove_file(&path)
                .await
                .map_err(MessageAttachmentStageError::internal)?;
            return tokio::fs::rename(&temporary, &path)
                .await
                .map_err(MessageAttachmentStageError::internal);
        }
        let _ = tokio::fs::remove_file(&temporary).await;
        Err(MessageAttachmentStageError::internal(rename_error))
    }

    async fn stage_lock(&self, session_id: &str, stage_id: &str) -> Arc<Mutex<()>> {
        let key = format!("{}:{stage_id}", session_scope_key(session_id));
        let mut locks = self.locks.lock().await;
        if locks.len() >= 1024 {
            locks.retain(|_, lock| lock.strong_count() > 0);
        }
        if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(Mutex::new(()));
        locks.insert(key, Arc::downgrade(&lock));
        lock
    }

    fn session_directory(&self, session_id: &str) -> PathBuf {
        self.root.join(session_scope_key(session_id))
    }

    fn stage_directory(
        &self,
        session_id: &str,
        stage_id: &str,
    ) -> MessageAttachmentStageResult<PathBuf> {
        validate_stage_identifier(stage_id, "attachment stage id")?;
        Ok(self
            .session_directory(session_id)
            .join(stage_scope_key(stage_id)))
    }
}

fn session_scope_key(session_id: &str) -> String {
    format!("{:x}", Sha256::digest(session_id.as_bytes()))
}

fn stage_scope_key(stage_id: &str) -> String {
    format!("{:x}", Sha256::digest(stage_id.as_bytes()))
}

fn validate_stage_identifier(value: &str, label: &str) -> MessageAttachmentStageResult<()> {
    if value.is_empty() || value.len() > 128 {
        return Err(stage_invalid(format!(
            "{label} length must be 1..=128 bytes"
        )));
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(stage_invalid(format!(
            "{label} may contain only ASCII letters, digits, -, _, ., and :"
        )));
    }
    Ok(())
}

fn normalize_sha256(value: &str) -> MessageAttachmentStageResult<String> {
    let digest = value.trim().strip_prefix("sha256:").unwrap_or(value.trim());
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(stage_invalid(
            "attachment sha256 must contain 64 hex digits",
        ));
    }
    Ok(digest.to_ascii_lowercase())
}

fn stage_invalid(message: impl Into<String>) -> MessageAttachmentStageError {
    MessageAttachmentStageError::new(MessageAttachmentStageErrorKind::InvalidArgument, message)
}

fn stage_exhausted(message: impl Into<String>) -> MessageAttachmentStageError {
    MessageAttachmentStageError::new(MessageAttachmentStageErrorKind::ResourceExhausted, message)
}

async fn sha256_file(path: &Path) -> Result<String, std::io::Error> {
    use tokio::io::AsyncReadExt as _;
    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 128 * 1024];
    loop {
        let count = file.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct PendingMessageAttachmentManifest {
    version: u8,
    event_id: String,
    scope_key: String,
    digests: Vec<String>,
    #[serde(default)]
    workspace_materialized: bool,
}

impl ModelInputUsage {
    pub(crate) fn add(&mut self, bytes: usize) -> Result<(), ModelInputError> {
        self.attachment_count = self
            .attachment_count
            .checked_add(1)
            .ok_or("model input attachment count overflow")?;
        self.total_bytes = self
            .total_bytes
            .checked_add(bytes)
            .ok_or("model input total attachment size overflow")?;
        self.largest_attachment_bytes = self.largest_attachment_bytes.max(bytes);
        Ok(())
    }
}

pub fn validate_model_input_usage(
    usage: ModelInputUsage,
    limits: ModelInputLimits,
    boundary: &str,
) -> Result<(), ModelInputError> {
    if let Some(limit) = limits.max_attachments {
        if usage.attachment_count > limit {
            return Err(format!(
                "{boundary} contains {} model input attachments, exceeding the limit of {}",
                usage.attachment_count, limit
            )
            .into());
        }
    }
    if let Some(limit) = limits.max_attachment_bytes {
        if usage.largest_attachment_bytes > limit {
            return Err(format!(
                "the largest model input attachment in {boundary} is {}, exceeding the per-attachment limit of {}",
                human_bytes(usage.largest_attachment_bytes),
                human_bytes(limit)
            )
            .into());
        }
    }
    if let Some(limit) = limits.max_total_bytes {
        if usage.total_bytes > limit {
            return Err(format!(
                "model input attachments in {boundary} total {}, exceeding the total limit of {}",
                human_bytes(usage.total_bytes),
                human_bytes(limit)
            )
            .into());
        }
    }
    Ok(())
}

/// Inspect the final Provider envelope rather than one intermediate Event.
/// This catches accumulation across multiple user messages and tool reads.
pub fn inspect_model_input_messages(
    messages: &[Message],
) -> Result<ModelInputUsage, ModelInputError> {
    let mut usage = ModelInputUsage::default();
    for message in messages {
        if message.name.as_deref() != Some(MODEL_ATTACHMENT_MESSAGE_NAME) {
            continue;
        }
        let attachments: Vec<ModelAttachment> = serde_json::from_str(&message.content)
            .map_err(|error| format!("invalid model input attachment envelope: {error}"))?;
        for attachment in attachments {
            usage.add(decoded_base64_len(&attachment.data_base64)?)?;
        }
    }
    Ok(usage)
}

pub async fn persist_model_input_attachments(
    configured_root: impl AsRef<Path>,
    category: &str,
    scope_id: &str,
    event_id: &str,
    attachments: Vec<MessageAttachmentInput>,
    limits: ModelInputLimits,
) -> Result<Vec<Value>, ModelInputError> {
    validate_category(category)?;
    let mut usage = ModelInputUsage::default();
    for attachment in &attachments {
        usage.add(attachment.data.len())?;
    }
    validate_model_input_usage(usage, limits, "this import")?;
    if attachments.is_empty() {
        return Ok(Vec::new());
    }

    let root = absolute_root(configured_root.as_ref())?;
    let scope_key = format!("{:x}", Sha256::digest(scope_id.as_bytes()));
    let directory = root.join(category).join(scope_key);
    tokio::fs::create_dir_all(&directory).await?;
    let directory = tokio::fs::canonicalize(&directory).await?;
    let mut metadata = Vec::with_capacity(attachments.len());

    for (index, attachment) in attachments.into_iter().enumerate() {
        let name = safe_attachment_name(&attachment.name)?;
        let media_type = safe_media_type(&attachment.media_type, &name)?;
        let digest = format!("{:x}", Sha256::digest(&attachment.data));
        let final_path = directory.join(&digest);
        if !tokio::fs::try_exists(&final_path).await? {
            let temporary_path = directory.join(format!(".{digest}.{event_id}.{index}.partial"));
            let mut file = tokio::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary_path)
                .await?;
            file.write_all(&attachment.data).await?;
            file.sync_data().await?;
            drop(file);
            match tokio::fs::rename(&temporary_path, &final_path).await {
                Ok(()) => {}
                Err(error) if tokio::fs::try_exists(&final_path).await.unwrap_or(false) => {
                    let _ = tokio::fs::remove_file(&temporary_path).await;
                    tracing::debug!(
                        path = %final_path.display(),
                        error = %error,
                    event_code = "model_input.concurrent_write_reused",
                    "Model-input attachment was reused from a concurrent write"
                    );
                }
                Err(error) => {
                    let _ = tokio::fs::remove_file(&temporary_path).await;
                    return Err(error.into());
                }
            }
        }
        metadata.push(json!({
            "id": format!("attachment_{digest}"),
            "name": name,
            "media_type": media_type,
            "size_bytes": attachment.data.len(),
            "sha256": digest,
            "storage_path": final_path.to_string_lossy(),
        }));
    }
    Ok(metadata)
}

/// Prepares message attachments without making the shared content blob itself
/// the Event reference. Every candidate Event receives an independent hard
/// link, so rejecting one idempotency claimant can never remove another
/// claimant's bytes. The pending manifest closes the crash window before the
/// Event transaction commits.
pub async fn prepare_message_input_attachments(
    configured_root: impl AsRef<Path>,
    scope_id: &str,
    event_id: &str,
    attachments: Vec<MessageAttachmentInput>,
    limits: ModelInputLimits,
) -> Result<PreparedMessageAttachments, ModelInputError> {
    prepare_message_input_attachments_for_workspace(
        configured_root,
        None::<&Path>,
        scope_id,
        event_id,
        attachments,
        limits,
    )
    .await
}

/// Prepare immutable attachment storage and, when a Workspace is supplied,
/// an independent Agent-owned copy with the original filename. The copy is
/// deliberately not a hard link: Agent tools may transform it without
/// mutating the Event-backed source or invalidating its digest.
pub async fn prepare_message_input_attachments_for_workspace(
    configured_root: impl AsRef<Path>,
    workspace_root: Option<impl AsRef<Path>>,
    scope_id: &str,
    event_id: &str,
    attachments: Vec<MessageAttachmentInput>,
    limits: ModelInputLimits,
) -> Result<PreparedMessageAttachments, ModelInputError> {
    prepare_message_input_imports_for_workspace(
        configured_root,
        workspace_root,
        scope_id,
        event_id,
        attachments,
        Vec::new(),
        limits,
    )
    .await
}

pub async fn prepare_message_input_imports_for_workspace(
    configured_root: impl AsRef<Path>,
    workspace_root: Option<impl AsRef<Path>>,
    scope_id: &str,
    event_id: &str,
    attachments: Vec<MessageAttachmentInput>,
    staged_attachments: Vec<StagedMessageAttachmentSource>,
    limits: ModelInputLimits,
) -> Result<PreparedMessageAttachments, ModelInputError> {
    safe_storage_segment(event_id, "Event id")?;
    let mut imports = Vec::with_capacity(attachments.len() + staged_attachments.len());
    for attachment in attachments {
        let size_bytes = attachment.data.len();
        let sha256 = format!("{:x}", Sha256::digest(&attachment.data));
        imports.push(MessageAttachmentImport {
            name: attachment.name,
            media_type: attachment.media_type,
            size_bytes,
            sha256,
            source: MessageAttachmentImportSource::Inline(attachment.data),
        });
    }
    for attachment in staged_attachments {
        imports.push(MessageAttachmentImport {
            name: attachment.name,
            media_type: attachment.media_type,
            size_bytes: attachment.size_bytes,
            sha256: attachment.sha256,
            source: MessageAttachmentImportSource::Staged(attachment.path),
        });
    }
    let mut usage = ModelInputUsage::default();
    for attachment in &imports {
        usage.add(attachment.size_bytes)?;
    }
    validate_model_input_usage(usage, limits, "this import")?;

    let root = absolute_root(configured_root.as_ref())?.join("message-inputs-v2");
    let scope_key = format!("{:x}", Sha256::digest(scope_id.as_bytes()));
    let workspace_root = match workspace_root {
        Some(workspace) => Some(
            tokio::fs::canonicalize(absolute_root(workspace.as_ref())?)
                .await
                .map_err(|error| {
                    format!("failed to resolve Agent Workspace for attachments: {error}")
                })?,
        ),
        None => None,
    };
    let workspace_directory = workspace_root.as_ref().map(|workspace| {
        workspace
            .join(".morphz")
            .join("attachments")
            .join(&scope_key)
            .join(event_id)
    });
    let mut prepared = PreparedMessageAttachments {
        metadata: Vec::with_capacity(imports.len()),
        root,
        scope_key,
        event_id: event_id.to_string(),
        digests: imports
            .iter()
            .map(|attachment| attachment.sha256.clone())
            .collect(),
        workspace_root,
        workspace_directory,
    };
    if imports.is_empty() {
        return Ok(prepared);
    }

    create_pending_manifest(&prepared).await?;
    let result = prepare_message_attachment_files(&mut prepared, imports).await;
    if let Err(error) = result {
        if let Err(cleanup_error) = discard_prepared_message_attachments(
            &prepared.root,
            &prepared.scope_key,
            &prepared.event_id,
            &prepared.digests,
            prepared.workspace_directory.as_deref(),
        )
        .await
        {
            tracing::warn!(
                event_id = %prepared.event_id,
                error = %cleanup_error,
                event_code = "model_input.message_prepare_cleanup_failed",
                "Failed to clean a partially prepared message-input import"
            );
        }
        return Err(error);
    }
    Ok(prepared)
}

async fn prepare_message_attachment_files(
    prepared: &mut PreparedMessageAttachments,
    attachments: Vec<MessageAttachmentImport>,
) -> Result<(), ModelInputError> {
    let blob_directory = prepared.root.join("blobs").join(&prepared.scope_key);
    let event_directory = prepared
        .root
        .join("events")
        .join(&prepared.scope_key)
        .join(&prepared.event_id);
    tokio::fs::create_dir_all(&blob_directory).await?;
    tokio::fs::create_dir_all(&event_directory).await?;
    let blob_directory = tokio::fs::canonicalize(blob_directory).await?;
    let event_directory = tokio::fs::canonicalize(event_directory).await?;

    for (index, attachment) in attachments.into_iter().enumerate() {
        let name = safe_attachment_name(&attachment.name)?;
        let media_type = safe_media_type(&attachment.media_type, &name)?;
        let digest = &prepared.digests[index];
        let blob_path = blob_directory.join(digest);
        match &attachment.source {
            MessageAttachmentImportSource::Inline(data) => {
                ensure_content_blob(&blob_path, data, &prepared.event_id, index).await?;
            }
            MessageAttachmentImportSource::Staged(path) => {
                ensure_content_blob_from_stage(
                    &blob_path,
                    path,
                    attachment.size_bytes,
                    digest,
                    &prepared.event_id,
                    index,
                )
                .await?;
            }
        }
        let event_path = event_directory.join(digest);
        if !tokio::fs::try_exists(&event_path).await? {
            // A concurrent rejected import may unlink the shared blob between
            // our existence check and hard_link. Recreate and retry once from
            // the bytes still owned by this request.
            match tokio::fs::hard_link(&blob_path, &event_path).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    match &attachment.source {
                        MessageAttachmentImportSource::Inline(data) => {
                            ensure_content_blob(&blob_path, data, &prepared.event_id, index)
                                .await?;
                        }
                        MessageAttachmentImportSource::Staged(path) => {
                            ensure_content_blob_from_stage(
                                &blob_path,
                                path,
                                attachment.size_bytes,
                                digest,
                                &prepared.event_id,
                                index,
                            )
                            .await?;
                        }
                    }
                    tokio::fs::hard_link(&blob_path, &event_path).await?;
                }
                Err(error) if tokio::fs::try_exists(&event_path).await.unwrap_or(false) => {
                    tracing::debug!(
                        path = %event_path.display(),
                        error = %error,
                        event_code = "model_input.message_reference_reused",
                        "Message-input Event reference was reused within the same import"
                    );
                }
                Err(error) => return Err(error.into()),
            }
        }
        let workspace_path = if let Some(workspace_directory) = &prepared.workspace_directory {
            let attachment_directory = workspace_directory.join(digest);
            tokio::fs::create_dir_all(&attachment_directory).await?;
            let attachment_directory = tokio::fs::canonicalize(attachment_directory).await?;
            if !prepared
                .workspace_root
                .as_ref()
                .is_some_and(|workspace| attachment_directory.starts_with(workspace))
            {
                return Err("workspace attachment directory escaped the Agent Workspace".into());
            }
            let workspace_path = attachment_directory.join(&name);
            match &attachment.source {
                MessageAttachmentImportSource::Inline(data) => {
                    ensure_workspace_attachment_copy(
                        &workspace_path,
                        data,
                        &prepared.event_id,
                        index,
                    )
                    .await?;
                }
                MessageAttachmentImportSource::Staged(path) => {
                    ensure_workspace_attachment_copy_from_stage(
                        &workspace_path,
                        path,
                        attachment.size_bytes,
                        digest,
                        &prepared.event_id,
                        index,
                    )
                    .await?;
                }
            }
            Some(workspace_path)
        } else {
            None
        };
        let mut item = json!({
            "id": format!("attachment_{digest}"),
            "name": name,
            "media_type": media_type,
            "size_bytes": attachment.size_bytes,
            "sha256": digest,
            "storage_path": event_path.to_string_lossy(),
        });
        if let Some(workspace_path) = workspace_path {
            item["workspace_path"] = json!(workspace_path.to_string_lossy());
        }
        prepared.metadata.push(item);
    }
    Ok(())
}

async fn ensure_workspace_attachment_copy(
    path: &Path,
    data: &[u8],
    event_id: &str,
    index: usize,
) -> Result<(), ModelInputError> {
    if tokio::fs::try_exists(path).await? {
        if tokio::fs::symlink_metadata(path)
            .await?
            .file_type()
            .is_symlink()
        {
            return Err(format!(
                "workspace attachment '{}' is an unexpected symbolic link",
                path.display()
            )
            .into());
        }
        let existing = tokio::fs::read(path).await?;
        if existing == data {
            return Ok(());
        }
        return Err(format!(
            "workspace attachment '{}' already exists with different content",
            path.display()
        )
        .into());
    }
    let temporary_path = path.with_extension(format!("morphz-{event_id}-{index}.partial"));
    let mut file = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary_path)
        .await?;
    if let Err(error) = file.write_all(data).await {
        drop(file);
        let _ = tokio::fs::remove_file(&temporary_path).await;
        return Err(error.into());
    }
    if let Err(error) = file.sync_data().await {
        drop(file);
        let _ = tokio::fs::remove_file(&temporary_path).await;
        return Err(error.into());
    }
    drop(file);
    if let Err(error) = tokio::fs::rename(&temporary_path, path).await {
        let _ = tokio::fs::remove_file(&temporary_path).await;
        return Err(error.into());
    }
    Ok(())
}

async fn ensure_workspace_attachment_copy_from_stage(
    path: &Path,
    source: &Path,
    expected_size: usize,
    expected_digest: &str,
    event_id: &str,
    index: usize,
) -> Result<(), ModelInputError> {
    if tokio::fs::try_exists(path).await? {
        verify_staged_file(path, expected_size, expected_digest).await?;
        return Ok(());
    }
    verify_staged_file(source, expected_size, expected_digest).await?;
    let temporary_path = path.with_extension(format!("morphz-{event_id}-{index}.partial"));
    if let Err(error) = tokio::fs::copy(source, &temporary_path).await {
        let _ = tokio::fs::remove_file(&temporary_path).await;
        return Err(error.into());
    }
    let file = tokio::fs::OpenOptions::new()
        .write(true)
        .open(&temporary_path)
        .await?;
    if let Err(error) = file.sync_all().await {
        drop(file);
        let _ = tokio::fs::remove_file(&temporary_path).await;
        return Err(error.into());
    }
    drop(file);
    if let Err(error) = tokio::fs::rename(&temporary_path, path).await {
        let _ = tokio::fs::remove_file(&temporary_path).await;
        return Err(error.into());
    }
    Ok(())
}

async fn ensure_content_blob(
    blob_path: &Path,
    data: &[u8],
    event_id: &str,
    index: usize,
) -> Result<(), ModelInputError> {
    if tokio::fs::try_exists(blob_path).await? {
        return Ok(());
    }
    let digest = blob_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("model input blob path is missing a digest")?;
    let temporary_path = blob_path.with_file_name(format!(".{digest}.{event_id}.{index}.partial"));
    let mut file = match tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary_path)
        .await
    {
        Ok(file) => file,
        Err(error)
            if error.kind() == std::io::ErrorKind::AlreadyExists
                && tokio::fs::try_exists(blob_path).await.unwrap_or(false) =>
        {
            return Ok(());
        }
        Err(error) => return Err(error.into()),
    };
    if let Err(error) = file.write_all(data).await {
        drop(file);
        let _ = tokio::fs::remove_file(&temporary_path).await;
        return Err(error.into());
    }
    if let Err(error) = file.sync_data().await {
        drop(file);
        let _ = tokio::fs::remove_file(&temporary_path).await;
        return Err(error.into());
    }
    drop(file);
    match tokio::fs::rename(&temporary_path, blob_path).await {
        Ok(()) => Ok(()),
        Err(error) if tokio::fs::try_exists(blob_path).await.unwrap_or(false) => {
            let _ = tokio::fs::remove_file(&temporary_path).await;
            tracing::debug!(
                path = %blob_path.display(),
                error = %error,
                event_code = "model_input.concurrent_message_blob_reused",
                "Message-input content blob was reused from a concurrent write"
            );
            Ok(())
        }
        Err(error) => {
            let _ = tokio::fs::remove_file(&temporary_path).await;
            Err(error.into())
        }
    }
}

async fn ensure_content_blob_from_stage(
    blob_path: &Path,
    source: &Path,
    expected_size: usize,
    expected_digest: &str,
    event_id: &str,
    index: usize,
) -> Result<(), ModelInputError> {
    verify_staged_file(source, expected_size, expected_digest).await?;
    if tokio::fs::try_exists(blob_path).await? {
        return Ok(());
    }
    let temporary_path = blob_path.with_file_name(format!(
        ".{expected_digest}.{event_id}.{index}.staged.partial"
    ));
    if let Err(error) = tokio::fs::copy(source, &temporary_path).await {
        let _ = tokio::fs::remove_file(&temporary_path).await;
        return Err(error.into());
    }
    if let Err(error) = verify_staged_file(&temporary_path, expected_size, expected_digest).await {
        let _ = tokio::fs::remove_file(&temporary_path).await;
        return Err(error);
    }
    let file = tokio::fs::OpenOptions::new()
        .write(true)
        .open(&temporary_path)
        .await?;
    if let Err(error) = file.sync_all().await {
        drop(file);
        let _ = tokio::fs::remove_file(&temporary_path).await;
        return Err(error.into());
    }
    drop(file);
    match tokio::fs::rename(&temporary_path, blob_path).await {
        Ok(()) => Ok(()),
        Err(error) if tokio::fs::try_exists(blob_path).await.unwrap_or(false) => {
            let _ = tokio::fs::remove_file(&temporary_path).await;
            tracing::debug!(
                path = %blob_path.display(),
                error = %error,
                event_code = "model_input.concurrent_staged_blob_reused",
                "Staged message-input content blob was reused from a concurrent import"
            );
            Ok(())
        }
        Err(error) => {
            let _ = tokio::fs::remove_file(&temporary_path).await;
            Err(error.into())
        }
    }
}

async fn verify_staged_file(
    path: &Path,
    expected_size: usize,
    expected_digest: &str,
) -> Result<(), ModelInputError> {
    let metadata = tokio::fs::symlink_metadata(path).await?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(format!(
            "staged attachment '{}' is not an immutable regular file",
            path.display()
        )
        .into());
    }
    if metadata.len() != expected_size as u64 {
        return Err(format!(
            "staged attachment '{}' failed size validation",
            path.display()
        )
        .into());
    }
    if sha256_file(path).await? != expected_digest {
        return Err(format!(
            "staged attachment '{}' failed digest validation",
            path.display()
        )
        .into());
    }
    Ok(())
}

async fn create_pending_manifest(
    prepared: &PreparedMessageAttachments,
) -> Result<(), ModelInputError> {
    let pending_directory = prepared.root.join("pending");
    tokio::fs::create_dir_all(&pending_directory).await?;
    let marker = pending_manifest_path(&prepared.root, &prepared.event_id);
    let temporary = marker.with_extension("json.partial");
    let document = serde_json::to_vec(&PendingMessageAttachmentManifest {
        version: 2,
        event_id: prepared.event_id.clone(),
        scope_key: prepared.scope_key.clone(),
        digests: prepared.digests.clone(),
        workspace_materialized: prepared.workspace_directory.is_some(),
    })?;
    let mut file = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .await?;
    if let Err(error) = file.write_all(&document).await {
        drop(file);
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error.into());
    }
    if let Err(error) = file.sync_data().await {
        drop(file);
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error.into());
    }
    drop(file);
    if let Err(error) = tokio::fs::rename(&temporary, marker).await {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error.into());
    }
    Ok(())
}

/// Reconciles only pending manifests; accepted Event directories are never
/// scanned. This keeps restart work proportional to interrupted imports, not
/// total retained attachment history. `event_exists` must query the immutable
/// Event Store by exact Event id.
pub async fn recover_pending_message_attachments<F, Fut>(
    configured_root: impl AsRef<Path>,
    grace: Duration,
    event_exists: F,
) -> Result<MessageAttachmentRecovery, ModelInputError>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<bool, ModelInputError>>,
{
    recover_pending_message_attachments_for_workspace(
        configured_root,
        None::<&Path>,
        grace,
        event_exists,
    )
    .await
}

pub async fn recover_pending_message_attachments_for_workspace<F, Fut>(
    configured_root: impl AsRef<Path>,
    workspace_root: Option<impl AsRef<Path>>,
    grace: Duration,
    mut event_exists: F,
) -> Result<MessageAttachmentRecovery, ModelInputError>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<bool, ModelInputError>>,
{
    let root = absolute_root(configured_root.as_ref())?.join("message-inputs-v2");
    let workspace_root = match workspace_root {
        Some(workspace) => Some(tokio::fs::canonicalize(absolute_root(workspace.as_ref())?).await?),
        None => None,
    };
    let pending_directory = root.join("pending");
    if !tokio::fs::try_exists(&pending_directory).await? {
        return Ok(MessageAttachmentRecovery::default());
    }
    let now = SystemTime::now();
    let mut recovery = MessageAttachmentRecovery::default();
    let mut entries = tokio::fs::read_dir(&pending_directory).await?;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let metadata = entry.metadata().await?;
        let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        if now.duration_since(modified).unwrap_or_default() < grace {
            recovery.deferred_live_imports += 1;
            continue;
        }
        let manifest = match tokio::fs::read(&path)
            .await
            .map_err(ModelInputError::from)
            .and_then(|bytes| serde_json::from_slice(&bytes).map_err(ModelInputError::from))
        {
            Ok(manifest) => manifest,
            Err(error) => {
                recovery.invalid_manifests += 1;
                tracing::warn!(
                    path = %path.display(),
                    error = %error,
                    event_code = "model_input.pending_manifest_invalid",
                    "Ignored an invalid pending message-input manifest"
                );
                continue;
            }
        };
        if !valid_pending_manifest(&manifest) {
            recovery.invalid_manifests += 1;
            tracing::warn!(
                path = %path.display(),
                event_code = "model_input.pending_manifest_unsafe",
                "Ignored an unsafe pending message-input manifest"
            );
            continue;
        }
        if event_exists(manifest.event_id.clone()).await? {
            remove_file_if_exists(&path).await?;
            recovery.committed_manifests += 1;
        } else {
            let workspace_directory = if manifest.workspace_materialized {
                workspace_root.as_ref().map(|workspace| {
                    workspace
                        .join(".morphz")
                        .join("attachments")
                        .join(&manifest.scope_key)
                        .join(&manifest.event_id)
                })
            } else {
                None
            };
            discard_prepared_message_attachments(
                &root,
                &manifest.scope_key,
                &manifest.event_id,
                &manifest.digests,
                workspace_directory.as_deref(),
            )
            .await?;
            recovery.orphaned_imports += 1;
        }
    }
    Ok(recovery)
}

fn valid_pending_manifest(manifest: &PendingMessageAttachmentManifest) -> bool {
    matches!(manifest.version, 1 | 2)
        && (!manifest.workspace_materialized || manifest.version >= 2)
        && safe_storage_segment(&manifest.event_id, "Event id").is_ok()
        && is_sha256_hex(&manifest.scope_key)
        && manifest.digests.iter().all(|digest| is_sha256_hex(digest))
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

async fn discard_prepared_message_attachments(
    root: &Path,
    scope_key: &str,
    event_id: &str,
    digests: &[String],
    workspace_directory: Option<&Path>,
) -> Result<(), ModelInputError> {
    if let Some(workspace_directory) = workspace_directory {
        if tokio::fs::try_exists(workspace_directory).await? {
            tokio::fs::remove_dir_all(workspace_directory).await?;
        }
    }
    let event_directory = root.join("events").join(scope_key).join(event_id);
    if tokio::fs::try_exists(&event_directory).await? {
        tokio::fs::remove_dir_all(&event_directory).await?;
    }
    for digest in digests {
        let blob_path = root.join("blobs").join(scope_key).join(digest);
        if !tokio::fs::try_exists(&blob_path).await? {
            continue;
        }
        if content_blob_is_unreferenced(&blob_path).await? {
            // A concurrent preparer may link between this check and unlink.
            // Its event-owned hard link keeps the inode alive; a preparer that
            // has not linked yet recreates the shared name and retries.
            let _ = tokio::fs::remove_file(&blob_path).await;
        }
    }
    remove_file_if_exists(&pending_manifest_path(root, event_id)).await
}

fn pending_manifest_path(root: &Path, event_id: &str) -> PathBuf {
    root.join("pending").join(format!("{event_id}.json"))
}

async fn remove_file_if_exists(path: &Path) -> Result<(), ModelInputError> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(unix)]
async fn content_blob_is_unreferenced(path: &Path) -> Result<bool, ModelInputError> {
    use std::os::unix::fs::MetadataExt as _;

    Ok(tokio::fs::metadata(path).await?.nlink() == 1)
}

#[cfg(not(unix))]
async fn content_blob_is_unreferenced(_path: &Path) -> Result<bool, ModelInputError> {
    // Keep the shared cache conservatively on filesystems where Rust does not
    // expose link counts. Event-owned references are still cleaned correctly.
    Ok(false)
}

pub async fn attachment_message_from_metadata(
    configured_root: impl AsRef<Path>,
    items: &[Value],
    limits: ModelInputLimits,
) -> Result<Option<Message>, ModelInputError> {
    if items.is_empty() {
        return Ok(None);
    }
    let mut usage = ModelInputUsage::default();
    for item in items {
        let size = item
            .get("size_bytes")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .ok_or("model input attachment is missing a valid size_bytes")?;
        usage.add(size)?;
    }
    validate_model_input_usage(usage, limits, "this attachment load")?;

    let root = tokio::fs::canonicalize(absolute_root(configured_root.as_ref())?).await?;
    let mut attachments = Vec::with_capacity(items.len());
    for item in items {
        let loaded = read_stored_attachment_from_root(&root, item).await?;
        attachments.push(ModelAttachment {
            name: loaded.name,
            media_type: loaded.media_type,
            data_base64: base64::engine::general_purpose::STANDARD.encode(loaded.data),
        });
    }
    Ok(Some(attachment_message(attachments)?))
}

/// A verified attachment loaded from the Runtime-owned Artifact Store.
///
/// Callers must obtain `metadata` from an authorized immutable Event. This
/// helper deliberately refuses caller-supplied paths outside the configured
/// store and verifies both the frozen size and digest before returning bytes.
pub struct StoredAttachment {
    pub name: String,
    pub media_type: String,
    pub data: Vec<u8>,
}

pub async fn read_stored_attachment(
    configured_root: impl AsRef<Path>,
    metadata: &Value,
) -> Result<StoredAttachment, ModelInputError> {
    let root = tokio::fs::canonicalize(absolute_root(configured_root.as_ref())?).await?;
    read_stored_attachment_from_root(&root, metadata).await
}

async fn read_stored_attachment_from_root(
    root: &Path,
    metadata: &Value,
) -> Result<StoredAttachment, ModelInputError> {
    let name = metadata
        .get("name")
        .and_then(Value::as_str)
        .ok_or("model input attachment is missing name")?;
    let media_type = metadata
        .get("media_type")
        .and_then(Value::as_str)
        .unwrap_or("application/octet-stream");
    let expected_digest = metadata
        .get("sha256")
        .and_then(Value::as_str)
        .ok_or("model input attachment is missing sha256")?;
    let storage_path = metadata
        .get("storage_path")
        .and_then(Value::as_str)
        .ok_or("model input attachment is missing storage_path")?;
    let path = tokio::fs::canonicalize(storage_path).await?;
    if !path.starts_with(root) {
        return Err(format!(
            "model input attachment '{}' is outside the Artifact Store; read rejected",
            path.display()
        )
        .into());
    }
    let data = tokio::fs::read(&path).await?;
    let expected_size = metadata
        .get("size_bytes")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or("model input attachment is missing a valid size_bytes")?;
    if data.len() != expected_size {
        return Err(format!("model input attachment '{}' failed size validation", name).into());
    }
    let actual_digest = format!("{:x}", Sha256::digest(&data));
    if actual_digest != expected_digest {
        return Err(format!("model input attachment '{}' failed digest validation", name).into());
    }
    Ok(StoredAttachment {
        name: name.to_string(),
        media_type: media_type.to_string(),
        data,
    })
}

pub(crate) fn decoded_base64_len(value: &str) -> Result<usize, ModelInputError> {
    let bytes = value.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return Err("model input attachment has an invalid Base64 length".into());
    }
    let padding = if bytes.ends_with(b"==") {
        2
    } else if bytes.ends_with(b"=") {
        1
    } else {
        0
    };
    bytes
        .len()
        .checked_div(4)
        .and_then(|groups| groups.checked_mul(3))
        .and_then(|bytes| bytes.checked_sub(padding))
        .ok_or_else(|| "model input attachment Base64 size overflow".into())
}

fn human_bytes(bytes: usize) -> String {
    const MIB: usize = 1024 * 1024;
    const KIB: usize = 1024;
    if bytes >= MIB {
        format!("{:.1} MiB", bytes as f64 / MIB as f64)
    } else if bytes >= KIB {
        format!("{:.1} KiB", bytes as f64 / KIB as f64)
    } else {
        format!("{bytes} B")
    }
}

pub fn public_attachment_references(items: &[Value], source_event_id: &str) -> Vec<Value> {
    items
        .iter()
        .map(|item| {
            let mut reference = json!({
                "id": item.get("id"),
                "name": item.get("name"),
                "media_type": item.get("media_type"),
                "size_bytes": item.get("size_bytes"),
                "sha256": item.get("sha256"),
                "source_event_id": source_event_id,
            });
            if let Some(workspace_path) = item.get("workspace_path") {
                reference["workspace_path"] = workspace_path.clone();
            }
            reference
        })
        .collect()
}

fn absolute_root(configured_root: &Path) -> Result<PathBuf, ModelInputError> {
    let root = configured_root.to_path_buf();
    Ok(if root.is_absolute() {
        root
    } else {
        std::env::current_dir()?.join(root)
    })
}

fn validate_category(value: &str) -> Result<(), ModelInputError> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(
            "model input attachment category may contain only letters, digits, hyphens, and underscores"
                .into(),
        );
    }
    Ok(())
}

fn safe_storage_segment(value: &str, label: &str) -> Result<(), ModelInputError> {
    if value.is_empty()
        || value.len() > 255
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(format!("{label} is not a safe storage path segment").into());
    }
    Ok(())
}

fn safe_attachment_name(value: &str) -> Result<String, ModelInputError> {
    let name = Path::new(value.trim())
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if name.is_empty() || name.chars().count() > 255 {
        return Err("attachment name must contain 1 to 255 characters".into());
    }
    Ok(name)
}

fn safe_media_type(value: &str, name: &str) -> Result<String, ModelInputError> {
    let media_type = value.trim();
    let media_type = if media_type.is_empty() {
        "application/octet-stream"
    } else {
        media_type
    };
    if media_type.chars().count() > 128
        || !media_type
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "/.+-".contains(character))
    {
        return Err(format!("attachment '{}' has an invalid media type", name).into());
    }
    Ok(media_type.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attachment_stage_limits() -> ModelInputLimits {
        ModelInputLimits {
            max_attachments: Some(8),
            max_attachment_bytes: Some(1024),
            max_total_bytes: Some(4096),
        }
    }

    fn new_attachment_stage(
        bytes: &[u8],
        stage_id: &str,
        client_message_id: &str,
    ) -> NewMessageAttachmentStage {
        NewMessageAttachmentStage {
            stage_id: stage_id.to_string(),
            principal_id: "principal-1".to_string(),
            session_id: "session-1".to_string(),
            client_message_id: client_message_id.to_string(),
            name: "quarterly report.pdf".to_string(),
            media_type: "application/pdf".to_string(),
            size_bytes: bytes.len() as u64,
            expected_sha256: Some(format!("{:x}", Sha256::digest(bytes))),
        }
    }

    async fn upload_stage_bytes(
        store: &MessageAttachmentStageStore,
        stage_id: &str,
        offset: u64,
        bytes: &[u8],
    ) -> MessageAttachmentStageResult<MessageAttachmentStage> {
        store
            .upload(
                "principal-1",
                "session-1",
                stage_id,
                offset,
                futures_util::stream::iter([Ok::<_, String>(bytes.to_vec())]),
            )
            .await
    }

    #[tokio::test]
    async fn attachment_stage_upload_resumes_after_restart_and_consumes_idempotently() {
        let root = tempfile::TempDir::new().unwrap();
        let bytes = b"durable-pdf-payload";
        let store =
            MessageAttachmentStageStore::new(root.path(), Duration::from_secs(3600)).unwrap();
        let created = store
            .create(
                new_attachment_stage(bytes, "stage-1", "client-message-1"),
                attachment_stage_limits(),
            )
            .await
            .unwrap();
        assert_eq!(created.status, MessageAttachmentStageStatus::Uploading);
        assert_eq!(created.offset, 0);

        let partial = upload_stage_bytes(&store, "stage-1", 0, &bytes[..7])
            .await
            .unwrap();
        assert_eq!(partial.offset, 7);
        assert_eq!(partial.status, MessageAttachmentStageStatus::Uploading);

        let restarted =
            MessageAttachmentStageStore::new(root.path(), Duration::from_secs(3600)).unwrap();
        assert_eq!(
            restarted
                .inspect("principal-1", "session-1", "stage-1")
                .await
                .unwrap()
                .offset,
            7
        );
        let conflict = upload_stage_bytes(&restarted, "stage-1", 0, &bytes[7..])
            .await
            .unwrap_err();
        assert_eq!(conflict.kind, MessageAttachmentStageErrorKind::Conflict);

        let ready = upload_stage_bytes(&restarted, "stage-1", 7, &bytes[7..])
            .await
            .unwrap();
        assert_eq!(ready.status, MessageAttachmentStageStatus::Ready);
        assert_eq!(ready.offset, bytes.len() as u64);
        let expected_digest = format!("{:x}", Sha256::digest(bytes));
        assert_eq!(ready.sha256.as_deref(), Some(expected_digest.as_str()));

        let forbidden = restarted
            .inspect("principal-2", "session-1", "stage-1")
            .await
            .unwrap_err();
        assert_eq!(forbidden.kind, MessageAttachmentStageErrorKind::Forbidden);
        let wrong_draft = restarted
            .resolve_for_message(
                "principal-1",
                "session-1",
                "client-message-2",
                &["stage-1".to_string()],
            )
            .await
            .unwrap_err();
        assert_eq!(wrong_draft.kind, MessageAttachmentStageErrorKind::Forbidden);

        let source = restarted
            .resolve_for_message(
                "principal-1",
                "session-1",
                "client-message-1",
                &["stage-1".to_string(), "stage-1".to_string()],
            )
            .await
            .unwrap();
        assert_eq!(
            source.len(),
            1,
            "duplicate stage ids must not duplicate input"
        );
        assert_eq!(tokio::fs::read(&source[0].path).await.unwrap(), bytes);

        restarted
            .mark_consumed(
                "principal-1",
                "session-1",
                "client-message-1",
                &["stage-1".to_string()],
                "event-1",
            )
            .await
            .unwrap();
        restarted
            .mark_consumed(
                "principal-1",
                "session-1",
                "client-message-1",
                &["stage-1".to_string()],
                "event-1",
            )
            .await
            .unwrap();
        let rebound = restarted
            .mark_consumed(
                "principal-1",
                "session-1",
                "client-message-1",
                &["stage-1".to_string()],
                "event-2",
            )
            .await
            .unwrap_err();
        assert_eq!(rebound.kind, MessageAttachmentStageErrorKind::Conflict);
        assert_eq!(
            restarted
                .inspect("principal-1", "session-1", "stage-1")
                .await
                .unwrap()
                .consumed_event_id
                .as_deref(),
            Some("event-1")
        );
        assert_eq!(
            restarted
                .cancel("principal-1", "session-1", "stage-1")
                .await
                .unwrap_err()
                .kind,
            MessageAttachmentStageErrorKind::Conflict
        );
    }

    #[tokio::test]
    async fn attachment_stage_rejects_bad_digest_and_reaps_expired_drafts() {
        let root = tempfile::TempDir::new().unwrap();
        let bytes = b"expected";
        let store =
            MessageAttachmentStageStore::new(root.path(), Duration::from_secs(3600)).unwrap();
        store
            .create(
                new_attachment_stage(bytes, "stage-bad-digest", "client-message-1"),
                attachment_stage_limits(),
            )
            .await
            .unwrap();
        let mismatch = upload_stage_bytes(&store, "stage-bad-digest", 0, b"mismatch")
            .await
            .unwrap_err();
        assert_eq!(mismatch.kind, MessageAttachmentStageErrorKind::Conflict);
        let reset = store
            .inspect("principal-1", "session-1", "stage-bad-digest")
            .await
            .unwrap();
        assert_eq!(reset.offset, 0);
        assert_eq!(reset.status, MessageAttachmentStageStatus::Uploading);

        let expiring = MessageAttachmentStageStore::new(root.path(), Duration::ZERO).unwrap();
        expiring
            .create(
                new_attachment_stage(b"x", "stage-expired", "client-message-2"),
                attachment_stage_limits(),
            )
            .await
            .unwrap();
        assert_eq!(expiring.reap_expired().await.unwrap(), 1);
        assert_eq!(
            expiring
                .inspect("principal-1", "session-1", "stage-expired")
                .await
                .unwrap_err()
                .kind,
            MessageAttachmentStageErrorKind::NotFound
        );
    }

    #[tokio::test]
    async fn staged_and_inline_attachments_materialize_without_aliasing_draft_storage() {
        let root = tempfile::TempDir::new().unwrap();
        let workspace = tempfile::TempDir::new().unwrap();
        let staged_bytes = b"staged-pdf";
        let store =
            MessageAttachmentStageStore::new(root.path(), Duration::from_secs(3600)).unwrap();
        store
            .create(
                new_attachment_stage(staged_bytes, "stage-import", "client-message-import"),
                attachment_stage_limits(),
            )
            .await
            .unwrap();
        upload_stage_bytes(&store, "stage-import", 0, staged_bytes)
            .await
            .unwrap();
        let staged = store
            .resolve_for_message(
                "principal-1",
                "session-1",
                "client-message-import",
                &["stage-import".to_string()],
            )
            .await
            .unwrap();
        let draft_path = staged[0].path.clone();

        let prepared = prepare_message_input_imports_for_workspace(
            root.path(),
            Some(workspace.path()),
            "session-1",
            "event-import",
            vec![MessageAttachmentInput {
                name: "notes.txt".to_string(),
                media_type: "text/plain".to_string(),
                data: b"inline-notes".to_vec(),
            }],
            staged,
            attachment_stage_limits(),
        )
        .await
        .unwrap();
        assert_eq!(prepared.metadata().len(), 2);
        let staged_metadata = prepared
            .metadata()
            .iter()
            .find(|item| item["name"] == "quarterly report.pdf")
            .unwrap();
        let immutable_path = PathBuf::from(staged_metadata["storage_path"].as_str().unwrap());
        let workspace_path = PathBuf::from(staged_metadata["workspace_path"].as_str().unwrap());
        assert_ne!(immutable_path, draft_path);
        assert_ne!(workspace_path, draft_path);
        assert_eq!(
            tokio::fs::read(&immutable_path).await.unwrap(),
            staged_bytes
        );
        assert_eq!(
            tokio::fs::read(&workspace_path).await.unwrap(),
            staged_bytes
        );

        tokio::fs::write(&workspace_path, b"agent-edited")
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read(&immutable_path).await.unwrap(),
            staged_bytes
        );
        assert_eq!(tokio::fs::read(&draft_path).await.unwrap(), staged_bytes);
        tokio::fs::write(&draft_path, b"local-draft-tamper")
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read(&immutable_path).await.unwrap(),
            staged_bytes,
            "Event storage must not share an inode with mutable staging storage"
        );
        prepared.discard().await.unwrap();
        assert!(!tokio::fs::try_exists(&immutable_path).await.unwrap());
        assert!(!tokio::fs::try_exists(&workspace_path).await.unwrap());
        assert!(tokio::fs::try_exists(&draft_path).await.unwrap());
    }

    #[tokio::test]
    async fn model_input_storage_keeps_bytes_out_of_public_reference_and_verifies_digest() {
        let root = tempfile::TempDir::new().unwrap();
        let bytes = b"\x89PNG\r\n\x1a\nmodel-input".to_vec();
        let metadata = persist_model_input_attachments(
            root.path(),
            "tool-inputs",
            "context-1",
            "output-1",
            vec![MessageAttachmentInput {
                name: "shot.png".to_string(),
                media_type: "image/png".to_string(),
                data: bytes.clone(),
            }],
            crate::config::ModelInputConfig::default().import_limits(),
        )
        .await
        .unwrap();
        assert_eq!(metadata.len(), 1);
        assert!(metadata[0].get("data_base64").is_none());
        assert!(metadata[0]["storage_path"]
            .as_str()
            .unwrap()
            .contains("tool-inputs"));

        let references = public_attachment_references(&metadata, "output-1");
        assert_eq!(references[0]["source_event_id"], "output-1");
        assert!(references[0].get("storage_path").is_none());
        assert!(references[0].get("data_base64").is_none());

        let message = attachment_message_from_metadata(
            root.path(),
            &metadata,
            crate::config::ModelInputConfig::default().request_limits(),
        )
        .await
        .unwrap()
        .unwrap();
        let attachments = crate::llm::model_attachments(&message).unwrap();
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].media_type, "image/png");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(&attachments[0].data_base64)
                .unwrap(),
            bytes
        );

        std::fs::write(
            metadata[0]["storage_path"].as_str().unwrap(),
            vec![0_u8; bytes.len()],
        )
        .unwrap();
        let error = attachment_message_from_metadata(
            root.path(),
            &metadata,
            crate::config::ModelInputConfig::default().request_limits(),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("failed digest validation"));
    }

    #[tokio::test]
    async fn model_input_storage_rejects_escape_and_oversized_attachment() {
        let root = tempfile::TempDir::new().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        let digest = format!("{:x}", Sha256::digest(b"outside"));
        let metadata = vec![json!({
            "name": "outside.png",
            "media_type": "image/png",
            "size_bytes": 7,
            "sha256": digest,
            "storage_path": outside.path(),
        })];
        let error = attachment_message_from_metadata(
            root.path(),
            &metadata,
            crate::config::ModelInputConfig::default().request_limits(),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("outside the Artifact Store"));

        let oversized = vec![0_u8; 33];
        let error = persist_model_input_attachments(
            root.path(),
            "tool-inputs",
            "context-1",
            "output-2",
            vec![MessageAttachmentInput {
                name: "huge.png".to_string(),
                media_type: "image/png".to_string(),
                data: oversized,
            }],
            ModelInputLimits {
                max_attachments: Some(8),
                max_attachment_bytes: Some(32),
                max_total_bytes: Some(64),
            },
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("per-attachment limit"));
    }

    #[test]
    fn final_request_usage_is_aggregated_across_attachment_messages() {
        let first = attachment_message(vec![ModelAttachment {
            name: "one.png".to_string(),
            media_type: "image/png".to_string(),
            data_base64: base64::engine::general_purpose::STANDARD.encode([1_u8; 17]),
        }])
        .unwrap();
        let second = attachment_message(vec![ModelAttachment {
            name: "two.png".to_string(),
            media_type: "image/png".to_string(),
            data_base64: base64::engine::general_purpose::STANDARD.encode([2_u8; 19]),
        }])
        .unwrap();
        let usage = inspect_model_input_messages(&[first, second]).unwrap();
        assert_eq!(usage.attachment_count, 2);
        assert_eq!(usage.total_bytes, 36);
        assert_eq!(usage.largest_attachment_bytes, 19);
        let error = validate_model_input_usage(
            usage,
            ModelInputLimits {
                max_attachments: Some(8),
                max_attachment_bytes: Some(64),
                max_total_bytes: Some(35),
            },
            "最终模型请求",
        )
        .unwrap_err();
        assert!(error.to_string().contains("total 36 B"));
    }

    #[test]
    fn default_policy_supports_large_screenshot_batches() {
        let config = crate::config::ModelInputConfig::default();
        let usage = ModelInputUsage {
            attachment_count: 43,
            total_bytes: 43 * 3 * 1024 * 1024,
            largest_attachment_bytes: 3 * 1024 * 1024,
        };
        validate_model_input_usage(usage, config.import_limits(), "43 张截图导入").unwrap();
        validate_model_input_usage(usage, config.request_limits(), "43 张截图请求").unwrap();

        let provider_limits = ModelInputLimits {
            max_attachments: Some(32),
            max_attachment_bytes: None,
            max_total_bytes: None,
        };
        let effective = config.request_limits().stricter(provider_limits);
        let error = validate_model_input_usage(usage, effective, "物理模型请求").unwrap_err();
        assert!(error.to_string().contains("43 model input attachments"));
        assert!(error.to_string().contains("limit of 32"));
    }

    #[tokio::test]
    async fn forty_three_images_round_trip_through_the_content_store() {
        let root = tempfile::TempDir::new().unwrap();
        let attachments = (0..43)
            .map(|index| MessageAttachmentInput {
                name: format!("shot-{index:02}.png"),
                media_type: "image/png".to_string(),
                data: [b"\x89PNG\r\n\x1a\n".as_slice(), &[index]].concat(),
            })
            .collect();
        let config = crate::config::ModelInputConfig::default();
        let metadata = persist_model_input_attachments(
            root.path(),
            "message-inputs",
            "session-43",
            "event-43",
            attachments,
            config.import_limits(),
        )
        .await
        .unwrap();
        assert_eq!(metadata.len(), 43);

        let message =
            attachment_message_from_metadata(root.path(), &metadata, config.request_limits())
                .await
                .unwrap()
                .unwrap();
        let model_attachments = crate::llm::model_attachments(&message).unwrap();
        assert_eq!(model_attachments.len(), 43);
        let usage = inspect_model_input_messages(&[message]).unwrap();
        assert_eq!(usage.attachment_count, 43);
        assert_eq!(usage.total_bytes, 43 * 9);
    }

    #[tokio::test]
    async fn message_attachment_candidates_are_isolated_and_recoverable() {
        let root = tempfile::TempDir::new().unwrap();
        let attachment = MessageAttachmentInput {
            name: "shared.png".to_string(),
            media_type: "image/png".to_string(),
            data: b"shared-image".to_vec(),
        };
        let first = prepare_message_input_attachments(
            root.path(),
            "session-1",
            "event-1",
            vec![attachment.clone()],
            crate::config::ModelInputConfig::default().import_limits(),
        )
        .await
        .unwrap();
        let second = prepare_message_input_attachments(
            root.path(),
            "session-1",
            "event-2",
            vec![attachment],
            crate::config::ModelInputConfig::default().import_limits(),
        )
        .await
        .unwrap();
        let first_path = PathBuf::from(first.metadata()[0]["storage_path"].as_str().unwrap());
        let second_path = PathBuf::from(second.metadata()[0]["storage_path"].as_str().unwrap());
        assert_ne!(first_path, second_path);
        assert_eq!(tokio::fs::read(&first_path).await.unwrap(), b"shared-image");
        assert_eq!(
            tokio::fs::read(&second_path).await.unwrap(),
            b"shared-image"
        );

        first.discard().await.unwrap();
        assert!(!tokio::fs::try_exists(&first_path).await.unwrap());
        assert_eq!(
            tokio::fs::read(&second_path).await.unwrap(),
            b"shared-image"
        );
        second.commit().await.unwrap();

        let orphan = prepare_message_input_attachments(
            root.path(),
            "session-1",
            "event-orphan",
            vec![MessageAttachmentInput {
                name: "orphan.png".to_string(),
                media_type: "image/png".to_string(),
                data: b"orphan-image".to_vec(),
            }],
            crate::config::ModelInputConfig::default().import_limits(),
        )
        .await
        .unwrap();
        let orphan_path = PathBuf::from(orphan.metadata()[0]["storage_path"].as_str().unwrap());
        drop(orphan);
        let deferred = recover_pending_message_attachments(
            root.path(),
            Duration::from_secs(60 * 60),
            |_event_id| async move { Ok(false) },
        )
        .await
        .unwrap();
        assert_eq!(deferred.deferred_live_imports, 1);
        assert!(tokio::fs::try_exists(&orphan_path).await.unwrap());
        let recovery = recover_pending_message_attachments(
            root.path(),
            Duration::ZERO,
            |event_id| async move { Ok(event_id == "event-2") },
        )
        .await
        .unwrap();
        assert_eq!(recovery.orphaned_imports, 1);
        assert!(!tokio::fs::try_exists(orphan_path).await.unwrap());
        assert!(tokio::fs::try_exists(second_path).await.unwrap());
    }

    #[tokio::test]
    async fn startup_recovery_commits_a_manifest_when_the_event_exists() {
        let root = tempfile::TempDir::new().unwrap();
        let prepared = prepare_message_input_attachments(
            root.path(),
            "session-1",
            "event-committed",
            vec![MessageAttachmentInput {
                name: "committed.png".to_string(),
                media_type: "image/png".to_string(),
                data: b"committed-image".to_vec(),
            }],
            crate::config::ModelInputConfig::default().import_limits(),
        )
        .await
        .unwrap();
        let path = PathBuf::from(prepared.metadata()[0]["storage_path"].as_str().unwrap());
        drop(prepared);

        let recovery = recover_pending_message_attachments(
            root.path(),
            Duration::ZERO,
            |event_id| async move { Ok(event_id == "event-committed") },
        )
        .await
        .unwrap();
        assert_eq!(recovery.committed_manifests, 1);
        assert_eq!(tokio::fs::read(path).await.unwrap(), b"committed-image");
        assert!(!tokio::fs::try_exists(
            root.path()
                .join("message-inputs-v2/pending/event-committed.json")
        )
        .await
        .unwrap());
    }

    #[tokio::test]
    async fn workspace_materialization_preserves_original_and_reclaims_orphans() {
        let store = tempfile::TempDir::new().unwrap();
        let workspace = tempfile::TempDir::new().unwrap();
        let input = MessageAttachmentInput {
            name: "../quarterly-report.docx".to_string(),
            media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                .to_string(),
            data: b"immutable-docx-bytes".to_vec(),
        };
        let prepared = prepare_message_input_attachments_for_workspace(
            store.path(),
            Some(workspace.path()),
            "session-workspace",
            "event-workspace",
            vec![input],
            crate::config::ModelInputConfig::default().import_limits(),
        )
        .await
        .unwrap();
        let metadata = &prepared.metadata()[0];
        let source_path = PathBuf::from(metadata["storage_path"].as_str().unwrap());
        let workspace_path = PathBuf::from(metadata["workspace_path"].as_str().unwrap());
        assert_eq!(workspace_path.file_name().unwrap(), "quarterly-report.docx");
        assert!(
            workspace_path.starts_with(tokio::fs::canonicalize(workspace.path()).await.unwrap())
        );
        assert_eq!(
            tokio::fs::read(&workspace_path).await.unwrap(),
            b"immutable-docx-bytes"
        );

        tokio::fs::write(&workspace_path, b"agent-transformed-copy")
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read(&source_path).await.unwrap(),
            b"immutable-docx-bytes",
            "the Agent-writable copy must not alias immutable Event storage"
        );
        prepared.discard().await.unwrap();
        assert!(!tokio::fs::try_exists(&workspace_path).await.unwrap());
        assert!(!tokio::fs::try_exists(&source_path).await.unwrap());

        let orphan = prepare_message_input_attachments_for_workspace(
            store.path(),
            Some(workspace.path()),
            "session-workspace",
            "event-orphan-workspace",
            vec![MessageAttachmentInput {
                name: "manual.pdf".to_string(),
                media_type: "application/pdf".to_string(),
                data: b"orphan-pdf".to_vec(),
            }],
            crate::config::ModelInputConfig::default().import_limits(),
        )
        .await
        .unwrap();
        let orphan_source = PathBuf::from(orphan.metadata()[0]["storage_path"].as_str().unwrap());
        let orphan_workspace =
            PathBuf::from(orphan.metadata()[0]["workspace_path"].as_str().unwrap());
        drop(orphan);
        let recovery = recover_pending_message_attachments_for_workspace(
            store.path(),
            Some(workspace.path()),
            Duration::ZERO,
            |_event_id| async move { Ok(false) },
        )
        .await
        .unwrap();
        assert_eq!(recovery.orphaned_imports, 1);
        assert!(!tokio::fs::try_exists(orphan_source).await.unwrap());
        assert!(!tokio::fs::try_exists(orphan_workspace).await.unwrap());
    }
}
