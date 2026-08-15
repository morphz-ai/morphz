//! Content-addressed storage for model-visible binary inputs.
//!
//! Ledger Events retain only metadata and a storage reference. Bytes are
//! loaded, digest-checked, and converted to Provider-native content parts only
//! while assembling a model request.

use std::path::{Path, PathBuf};

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
}
