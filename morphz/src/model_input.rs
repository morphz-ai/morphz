//! Content-addressed storage for model-visible binary inputs.
//!
//! persisted Events retain only metadata and a storage reference. Bytes are
//! loaded, digest-checked, and converted to Provider-native content parts only
//! while assembling a model request.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use base64::Engine as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt as _;

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

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct PendingMessageAttachmentManifest {
    version: u8,
    event_id: String,
    scope_key: String,
    digests: Vec<String>,
}

impl ModelInputUsage {
    pub(crate) fn add(&mut self, bytes: usize) -> Result<(), ModelInputError> {
        self.attachment_count = self
            .attachment_count
            .checked_add(1)
            .ok_or("模型输入附件数量溢出")?;
        self.total_bytes = self
            .total_bytes
            .checked_add(bytes)
            .ok_or("模型输入附件总大小溢出")?;
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
                "{boundary}包含 {} 个模型输入附件，超过 {} 个上限",
                usage.attachment_count, limit
            )
            .into());
        }
    }
    if let Some(limit) = limits.max_attachment_bytes {
        if usage.largest_attachment_bytes > limit {
            return Err(format!(
                "{boundary}中最大的模型输入附件为 {}，超过单个附件上限 {}",
                human_bytes(usage.largest_attachment_bytes),
                human_bytes(limit)
            )
            .into());
        }
    }
    if let Some(limit) = limits.max_total_bytes {
        if usage.total_bytes > limit {
            return Err(format!(
                "{boundary}的模型输入附件合计 {}，超过总量上限 {}",
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
            .map_err(|error| format!("模型输入附件信封无效：{error}"))?;
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
    validate_model_input_usage(usage, limits, "本次导入")?;
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
    safe_storage_segment(event_id, "Event id")?;
    let mut usage = ModelInputUsage::default();
    for attachment in &attachments {
        usage.add(attachment.data.len())?;
    }
    validate_model_input_usage(usage, limits, "本次导入")?;

    let root = absolute_root(configured_root.as_ref())?.join("message-inputs-v2");
    let scope_key = format!("{:x}", Sha256::digest(scope_id.as_bytes()));
    let mut prepared = PreparedMessageAttachments {
        metadata: Vec::with_capacity(attachments.len()),
        root,
        scope_key,
        event_id: event_id.to_string(),
        digests: attachments
            .iter()
            .map(|attachment| format!("{:x}", Sha256::digest(&attachment.data)))
            .collect(),
    };
    if attachments.is_empty() {
        return Ok(prepared);
    }

    create_pending_manifest(&prepared).await?;
    let result = prepare_message_attachment_files(&mut prepared, attachments).await;
    if let Err(error) = result {
        if let Err(cleanup_error) = discard_prepared_message_attachments(
            &prepared.root,
            &prepared.scope_key,
            &prepared.event_id,
            &prepared.digests,
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
    attachments: Vec<MessageAttachmentInput>,
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
        ensure_content_blob(&blob_path, &attachment.data, &prepared.event_id, index).await?;
        let event_path = event_directory.join(digest);
        if !tokio::fs::try_exists(&event_path).await? {
            // A concurrent rejected import may unlink the shared blob between
            // our existence check and hard_link. Recreate and retry once from
            // the bytes still owned by this request.
            match tokio::fs::hard_link(&blob_path, &event_path).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    ensure_content_blob(&blob_path, &attachment.data, &prepared.event_id, index)
                        .await?;
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
        prepared.metadata.push(json!({
            "id": format!("attachment_{digest}"),
            "name": name,
            "media_type": media_type,
            "size_bytes": attachment.data.len(),
            "sha256": digest,
            "storage_path": event_path.to_string_lossy(),
        }));
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
        .ok_or("模型输入 blob 路径缺少摘要")?;
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

async fn create_pending_manifest(
    prepared: &PreparedMessageAttachments,
) -> Result<(), ModelInputError> {
    let pending_directory = prepared.root.join("pending");
    tokio::fs::create_dir_all(&pending_directory).await?;
    let marker = pending_manifest_path(&prepared.root, &prepared.event_id);
    let temporary = marker.with_extension("json.partial");
    let document = serde_json::to_vec(&PendingMessageAttachmentManifest {
        version: 1,
        event_id: prepared.event_id.clone(),
        scope_key: prepared.scope_key.clone(),
        digests: prepared.digests.clone(),
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
    mut event_exists: F,
) -> Result<MessageAttachmentRecovery, ModelInputError>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<bool, ModelInputError>>,
{
    let root = absolute_root(configured_root.as_ref())?.join("message-inputs-v2");
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
            discard_prepared_message_attachments(
                &root,
                &manifest.scope_key,
                &manifest.event_id,
                &manifest.digests,
            )
            .await?;
            recovery.orphaned_imports += 1;
        }
    }
    Ok(recovery)
}

fn valid_pending_manifest(manifest: &PendingMessageAttachmentManifest) -> bool {
    manifest.version == 1
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
) -> Result<(), ModelInputError> {
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
            .ok_or("模型输入附件缺少有效 size_bytes")?;
        usage.add(size)?;
    }
    validate_model_input_usage(usage, limits, "本次附件装载")?;

    let root = tokio::fs::canonicalize(absolute_root(configured_root.as_ref())?).await?;
    let mut attachments = Vec::with_capacity(items.len());
    for item in items {
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .ok_or("模型输入附件缺少 name")?;
        let media_type = item
            .get("media_type")
            .and_then(Value::as_str)
            .unwrap_or("application/octet-stream");
        let expected_digest = item
            .get("sha256")
            .and_then(Value::as_str)
            .ok_or("模型输入附件缺少 sha256")?;
        let storage_path = item
            .get("storage_path")
            .and_then(Value::as_str)
            .ok_or("模型输入附件缺少 storage_path")?;
        let path = tokio::fs::canonicalize(storage_path).await?;
        if !path.starts_with(&root) {
            return Err(format!(
                "模型输入附件 '{}' 位于 Artifact Store 之外，拒绝读取",
                path.display()
            )
            .into());
        }
        let data = tokio::fs::read(&path).await?;
        let expected_size = item
            .get("size_bytes")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .ok_or("模型输入附件缺少有效 size_bytes")?;
        if data.len() != expected_size {
            return Err(format!("模型输入附件 '{}' 大小校验失败", name).into());
        }
        let actual_digest = format!("{:x}", Sha256::digest(&data));
        if actual_digest != expected_digest {
            return Err(format!("模型输入附件 '{}' 摘要校验失败", name).into());
        }
        attachments.push(ModelAttachment {
            name: name.to_string(),
            media_type: media_type.to_string(),
            data_base64: base64::engine::general_purpose::STANDARD.encode(data),
        });
    }
    Ok(Some(attachment_message(attachments)?))
}

pub(crate) fn decoded_base64_len(value: &str) -> Result<usize, ModelInputError> {
    let bytes = value.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return Err("模型输入附件 Base64 长度无效".into());
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
        .ok_or_else(|| "模型输入附件 Base64 大小溢出".into())
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
            json!({
                "id": item.get("id"),
                "name": item.get("name"),
                "media_type": item.get("media_type"),
                "size_bytes": item.get("size_bytes"),
                "sha256": item.get("sha256"),
                "source_event_id": source_event_id,
            })
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
        return Err("模型输入附件分类只能包含字母、数字、横线和下划线".into());
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
        return Err(format!("{label} 不能作为安全的存储路径片段").into());
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
        return Err("附件名称不能为空且不能超过 255 个字符".into());
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
        return Err(format!("附件 '{}' 的 media type 非法", name).into());
    }
    Ok(media_type.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(error.to_string().contains("摘要校验失败"));
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
        assert!(error.to_string().contains("Artifact Store 之外"));

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
        assert!(error.to_string().contains("单个附件上限"));
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
        assert!(error.to_string().contains("合计 36 B"));
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
        assert!(error.to_string().contains("43 个"));
        assert!(error.to_string().contains("32 个上限"));
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
}
