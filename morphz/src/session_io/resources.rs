//! Resource identities name immutable Event-owned attachments, never paths or
//! URLs. Reading or reusing one requires the destination Session's authority.
use super::{Content, Data, IoError, IoResult, Message};
use crate::{
    event::Event,
    memory::QueryFilter,
    runtime::MorphzRuntime,
    sdk::{MessageAttachmentInput, MessageReferenceInput, MorphzSdk},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{json, Value};

pub fn resource_id(event: &str, attachment: &str) -> String {
    format!(
        "io-resource:{}",
        URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&(event, attachment)).expect("resource identity"))
    )
}
pub fn decode_id(id: &str) -> IoResult<(String, String)> {
    let invalid = || {
        IoError::new(
            "invalid_content_syntax",
            "Invalid immutable resource identity",
        )
    };
    if id.len() > 2048 {
        return Err(invalid());
    }
    let raw = id.strip_prefix("io-resource:").ok_or_else(invalid)?;
    let bytes = URL_SAFE_NO_PAD.decode(raw).map_err(|_| invalid())?;
    let (event, attachment): (String, String) =
        serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if event.is_empty() || attachment.is_empty() || resource_id(&event, &attachment) != id {
        return Err(invalid());
    }
    Ok((event, attachment))
}

#[derive(Default)]
pub struct ChatInputs {
    pub stages: Vec<String>,
    pub resources: Vec<String>,
    pub references: Vec<MessageReferenceInput>,
}

pub fn chat_inputs(message: &Message) -> IoResult<ChatInputs> {
    let mut inputs = ChatInputs::default();
    if message.format.id != "morphz.chat" {
        return Ok(inputs);
    }
    let Content::Json { value } = &message.content else {
        return Ok(inputs);
    };
    if let Some(items) = value.get("attachments") {
        let Data::Array(items) = items else {
            return Err(IoError::new(
                "schema_validation_failed",
                "Attachments must be an array",
            ));
        };
        if items.len() > 64 {
            return Err(IoError::new(
                "message_limit_exceeded",
                "Too many attachment references",
            ));
        }
        for item in items {
            let object = item.object()?;
            if object.len() != 1 {
                return Err(IoError::new(
                    "invalid_content_syntax",
                    "Attachment requires exactly stage_id or resource_id",
                ));
            }
            if let Some(id) = item
                .get("stage_id")
                .and_then(Data::string)
                .filter(|id| !id.is_empty() && id.len() <= 160)
            {
                if inputs.stages.contains(&id.to_string()) {
                    return Err(IoError::new(
                        "invalid_content_syntax",
                        "Duplicate attachment stage",
                    ));
                }
                inputs.stages.push(id.into());
            } else if let Some(id) = item.get("resource_id").and_then(Data::string) {
                decode_id(id)?;
                inputs.resources.push(id.into());
            } else {
                return Err(IoError::new(
                    "invalid_content_syntax",
                    "Invalid attachment identity",
                ));
            }
        }
    }
    if let Some(items) = value.get("references") {
        let Data::Array(items) = items else {
            return Err(IoError::new(
                "schema_validation_failed",
                "References must be an array",
            ));
        };
        if items.len() > 64 {
            return Err(IoError::new(
                "message_limit_exceeded",
                "Too many Session references",
            ));
        }
        for item in items {
            if item.object()?.len() != 2
                || item.get("kind").and_then(Data::string) != Some("session")
            {
                return Err(IoError::new(
                    "invalid_content_syntax",
                    "Only typed Session references are supported",
                ));
            }
            let id = item
                .get("session_id")
                .and_then(Data::string)
                .filter(|id| !id.is_empty() && id.len() <= 256)
                .ok_or_else(|| {
                    IoError::new("invalid_content_syntax", "Invalid Session reference")
                })?;
            inputs.references.push(MessageReferenceInput::Session {
                session_id: id.into(),
            });
        }
    }
    Ok(inputs)
}

pub fn declared_inputs(message: &Message, paths: &[String]) -> IoResult<ChatInputs> {
    let mut inputs = chat_inputs(message)?;
    if let Content::Resource { resource_id } = &message.content {
        inputs.resources.push(resource_id.clone());
    }
    if let Content::Json { value } = &message.content {
        for path in paths {
            let item = match super::projection::pointer(value, path) {
                Ok(item) => item,
                Err(error) if error.code == "resource_unavailable" => continue,
                Err(error) => return Err(error),
            };
            let items = match item {
                Data::Array(values) => values.iter().collect::<Vec<_>>(),
                _ => vec![item],
            };
            for item in items {
                if item.object()?.len() != 1 {
                    return Err(IoError::new(
                        "invalid_content_syntax",
                        "A resource field contains exactly resource_id or stage_id",
                    ));
                }
                if let Some(id) = item
                    .get("stage_id")
                    .and_then(Data::string)
                    .filter(|id| !id.is_empty() && id.len() <= 160)
                {
                    if inputs.stages.contains(&id.to_string()) {
                        return Err(IoError::new(
                            "invalid_content_syntax",
                            "Duplicate attachment stage",
                        ));
                    }
                    inputs.stages.push(id.into());
                } else {
                    let id = item
                        .get("resource_id")
                        .and_then(Data::string)
                        .ok_or_else(|| {
                            IoError::new("invalid_content_syntax", "Missing resource_id")
                        })?;
                    decode_id(id)?;
                    inputs.resources.push(id.into());
                }
            }
        }
    }
    if inputs.resources.len() + inputs.stages.len() > 64 {
        return Err(IoError::new("message_limit_exceeded", "Too many resources"));
    }
    Ok(inputs)
}

pub fn declared_ids(message: &Message, paths: &[String]) -> IoResult<Vec<String>> {
    let inputs = declared_inputs(message, paths)?;
    if !inputs.stages.is_empty() {
        return Err(IoError::new(
            "resource_unavailable",
            "Output resources must already be committed",
        ));
    }
    Ok(inputs.resources)
}

pub fn attachment_metadata(event: &Event, resource: &str) -> IoResult<Value> {
    let (event_id, attachment) = decode_id(resource)?;
    if event.id != event_id {
        return Err(IoError::new(
            "resource_unavailable",
            "Resource Event does not match",
        ));
    }
    event
        .payload
        .get("attachments")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(&attachment))
        })
        .cloned()
        .ok_or_else(|| {
            IoError::new(
                "resource_unavailable",
                "Resource is not owned by this Event",
            )
        })
}

pub fn public_metadata(event_id: &str, metadata: &Value) -> Value {
    json!({"resource_id": resource_id(event_id, metadata.get("id").and_then(Value::as_str).unwrap_or_default()),
        "source_event_id":event_id,"name":metadata.get("name"),"media_type":metadata.get("media_type"),
        "size_bytes":metadata.get("size_bytes"),"sha256":metadata.get("sha256")})
}

pub(crate) fn workspace_metadata(event_id: &str, metadata: &Value) -> Value {
    let mut resource = public_metadata(event_id, metadata);
    if let Some(path) = metadata
        .get("workspace_path")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty() && path.len() <= 4096)
    {
        resource["workspace_path"] = Value::String(path.into());
    }
    resource
}

pub fn event_resources(event: &Event) -> Vec<Value> {
    event
        .payload
        .get("io_resources")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| {
            event
                .payload
                .get("attachments")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .map(|metadata| public_metadata(&event.id, metadata))
                        .collect()
                })
                .unwrap_or_default()
        })
}

/// Privileged Agent Context metadata, distinct from path-free public download
/// receipts. This never reads bytes and never exposes Artifact Store paths.
/// The workspace copy is already owned by the accepted Event; normal `read`
/// still performs its physical permission checks at execution time.
pub(crate) fn context_resources(event: &Event) -> Vec<Value> {
    let mut resources = event_resources(event);
    let attachments = event.payload.get("attachments").and_then(Value::as_array);
    for resource in &mut resources {
        let Some(id) = resource.get("resource_id").and_then(Value::as_str) else {
            continue;
        };
        let Ok((owner, attachment_id)) = decode_id(id) else {
            continue;
        };
        let forwarded = event.topic == "chat/steering"
            && event.payload.get("source_event_id").and_then(Value::as_str) == Some(owner.as_str());
        if owner != event.id && !forwarded {
            continue;
        }
        let metadata = attachments.and_then(|items| {
            items.iter().find(|metadata| {
                metadata.get("id").and_then(Value::as_str) == Some(attachment_id.as_str())
            })
        });
        let path = metadata
            .and_then(|metadata| metadata.get("workspace_path"))
            .and_then(Value::as_str)
            .filter(|path| !path.is_empty() && path.len() <= 4096);
        if let (Some(path), Some(object)) = (path, resource.as_object_mut()) {
            object.insert("workspace_path".into(), Value::String(path.into()));
        }
    }
    resources
}

pub async fn read(
    runtime: &MorphzRuntime,
    principal: &str,
    session: &str,
    resource: &str,
) -> IoResult<(Value, MessageAttachmentInput)> {
    let sdk = MorphzSdk::new(runtime.clone());
    sdk.authorize_session(principal, session)
        .await
        .map_err(|_| IoError::new("forbidden", "Session resource is not accessible"))?;
    let (event_id, _) = decode_id(resource)?;
    let event = runtime
        .query_events(QueryFilter {
            event_id: Some(event_id),
            session_id: Some(session.into()),
            ..Default::default()
        })
        .await
        .map_err(|_| IoError::new("unavailable", "Resource lookup failed"))?
        .into_iter()
        .next()
        .ok_or_else(|| {
            IoError::new(
                "resource_unavailable",
                "Resource is not available in this Session",
            )
        })?;
    let metadata = attachment_metadata(&event, resource)?;
    let loaded = crate::model_input::read_stored_attachment(
        &runtime.config().background_task.artifact_dir,
        &metadata,
    )
    .await
    .map_err(|_| {
        IoError::new(
            "resource_unavailable",
            "Resource bytes are unavailable or failed integrity checks",
        )
    })?;
    // Revocation wins even if it happened while loading the bytes.
    sdk.authorize_session(principal, session)
        .await
        .map_err(|_| IoError::new("forbidden", "Session resource is no longer accessible"))?;
    Ok((
        public_metadata(&event.id, &metadata),
        MessageAttachmentInput {
            name: loaded.name,
            media_type: loaded.media_type,
            data: loaded.data,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_read_paths_are_privileged_metadata_not_public_download_paths() {
        let metadata = json!({"id":"attachment", "name":"book.txt", "size_bytes":1_000_000,
            "media_type":"text/plain", "sha256":"hash", "workspace_path":"/authorized/book.txt",
            "storage_path":"/private/artifacts/original", "body":"BODY_MUST_NOT_BE_PROJECTED"});
        let public = public_metadata("source", &metadata);
        assert!(public.get("workspace_path").is_none());
        assert!(public.get("storage_path").is_none());
        let context = workspace_metadata("source", &metadata);
        assert_eq!(context["workspace_path"], "/authorized/book.txt");
        assert!(context.get("storage_path").is_none());
        assert!(!context.to_string().contains("BODY_MUST_NOT_BE_PROJECTED"));
        let mut oversized = metadata;
        oversized["workspace_path"] = json!("x".repeat(4097));
        assert!(workspace_metadata("source", &oversized)
            .get("workspace_path")
            .is_none());
    }

    #[test]
    fn context_paths_require_exact_resource_owner_or_the_typed_forwarding_edge() {
        let metadata = json!({"id":"attachment", "name":"book.txt",
            "workspace_path":"/authorized/book.txt"});
        let mut event = Event::new(
            "source".into(),
            "Session-Client".into(),
            "session_message".into(),
            "chat/user_message".into(),
            serde_json::Map::new(),
        );
        event
            .payload
            .insert("attachments".into(), json!([metadata.clone()]));
        assert_eq!(
            context_resources(&event)[0]["workspace_path"],
            "/authorized/book.txt"
        );
        event.id = "forwarded".into();
        event.payload.insert(
            "io_resources".into(),
            json!([public_metadata("source", &metadata)]),
        );
        assert!(context_resources(&event)[0].get("workspace_path").is_none());
        event.topic = "chat/steering".into();
        event
            .payload
            .insert("source_event_id".into(), json!("wrong-source"));
        assert!(context_resources(&event)[0].get("workspace_path").is_none());
        event
            .payload
            .insert("source_event_id".into(), json!("source"));
        assert_eq!(
            context_resources(&event)[0]["workspace_path"],
            "/authorized/book.txt"
        );
        event.payload["attachments"][0]["id"] = json!("wrong-attachment");
        assert!(context_resources(&event)[0].get("workspace_path").is_none());
    }
}
