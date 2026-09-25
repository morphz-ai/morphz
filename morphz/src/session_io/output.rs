//! Typed delivery is logical IO, never a claim that physical work succeeded.
use super::{AcceptedInput, Data, IoError, IoResult, Limits, Message};
use crate::{
    event::Event,
    llm::ToolDefinition,
    memory::{QueryFilter, RuntimeStore},
    tool::{
        Tool, ToolExecutionClass, CURRENT_CAUSAL_ROUTE, CURRENT_CONTEXT_ID, CURRENT_PRINCIPAL_ID,
        CURRENT_SESSION_ID,
    },
};
use serde_json::json;
use std::sync::Arc;

pub fn validate_output(input: &AcceptedInput, message: &Message, _limits: &Limits) -> IoResult<()> {
    let binding = input
        .binding
        .accept_formats
        .iter()
        .find(|format| {
            format.format.id == message.format.id
                && format.format.version == message.format.version
                && format.format.encoding == message.content.encoding()
        })
        .ok_or_else(|| {
            IoError::new(
                "invalid_delivery_contract",
                "Output format was not accepted by the root input",
            )
        })?;
    if message.validation != "registered"
        || message
            .format
            .schema_hash
            .as_ref()
            .is_some_and(|hash| Some(hash) != binding.format.schema_hash.as_ref())
        || message
            .format
            .contract_hash
            .as_ref()
            .is_some_and(|hash| Some(hash) != binding.format.contract_hash.as_ref())
    {
        return Err(IoError::new(
            "format_definition_mismatch",
            "Output does not match its durable format binding",
        ));
    }
    super::validate_content(message, binding, &input.binding.limits)?;
    if !super::resources::chat_inputs(message)?.stages.is_empty() {
        return Err(IoError::new(
            "resource_unavailable",
            "Output resources must already belong to a committed Event",
        ));
    }
    super::projection::validate_budget(
        message,
        binding,
        &input.binding.limits,
        super::projection::definition_bytes(binding),
    )
}

pub fn missing_required(input: &AcceptedInput, outputs: &[Message]) -> bool {
    input.binding.required_formats.iter().any(|required| {
        !outputs.iter().any(|message| {
            message.format.id == required.id
                && message.format.version == required.version
                && message.content.encoding() == required.encoding
        })
    })
}

pub struct DeliverMessageTool {
    store: Arc<dyn RuntimeStore>,
    bus: Arc<crate::event::InMemoryEventBus>,
    limits: Limits,
    artifact_root: std::path::PathBuf,
    import_limits: crate::llm::ModelInputLimits,
}
impl DeliverMessageTool {
    pub fn new(
        store: Arc<dyn RuntimeStore>,
        bus: Arc<crate::event::InMemoryEventBus>,
        limits: Limits,
        artifact_root: std::path::PathBuf,
        import_limits: crate::llm::ModelInputLimits,
    ) -> Self {
        Self {
            store,
            bus,
            limits,
            artifact_root,
            import_limits,
        }
    }
}

#[async_trait::async_trait]
impl Tool for DeliverMessageTool {
    fn name(&self) -> &str {
        "deliver_message"
    }
    fn execution_class(&self) -> ToolExecutionClass {
        ToolExecutionClass::LogicalInline
    }
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().into(),
            description: "Persist a complete typed output to the current active Session. Read its immutable root input delivery contract and application-format-definitions. Reuse delivery_id when retrying the same output. This does not finish the evaluation or execute business operations. Return ordinary assistant text for a normal chat reply; required structured formats must also be delivered. JSON is data, not proof of tool success. Cannot target another Session.".into(),
            parameters: json!({"type":"object","properties":{"delivery_id":{"type":"string"},"message":{"type":"object","properties":{"format":{"type":"object","properties":{"id":{"type":"string"},"version":{"type":"string"}},"required":["id","version"],"additionalProperties":false},"content":{"type":"object","properties":{"encoding":{"type":"string","enum":["json","utf8","resource"]},"value":{},"resource_id":{"type":"string"}},"required":["encoding"],"additionalProperties":false}},"required":["format","content"],"additionalProperties":false}},"required":["delivery_id","message"],"additionalProperties":false}),
        }
    }
    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let session = CURRENT_SESSION_ID
            .try_with(Clone::clone)
            .map_err(|_| "Missing active Session")?;
        let context = CURRENT_CONTEXT_ID
            .try_with(Clone::clone)
            .map_err(|_| "Missing active Context")?;
        let route = CURRENT_CAUSAL_ROUTE
            .try_with(Clone::clone)
            .ok()
            .flatten()
            .ok_or("Missing causal delivery route")?;
        let principal = CURRENT_PRINCIPAL_ID
            .try_with(Clone::clone)
            .ok()
            .flatten()
            .ok_or("Missing initiating Principal")?;
        if !self
            .store
            .verify_session_principal(&session, &principal)
            .await?
        {
            return Err("Principal is no longer authorized for this Session".into());
        }
        let root = self
            .store
            .query(QueryFilter {
                event_id: Some(route.root_turn_id.clone()),
                session_id: Some(session.clone()),
                ..Default::default()
            })
            .await?
            .into_iter()
            .next()
            .ok_or("Missing root input")?;
        let input: AcceptedInput = serde_json::from_value(
            root.payload
                .get("session_io")
                .cloned()
                .ok_or("The current root did not accept typed delivery")?,
        )?;
        // Both parsing and output validation use the root's frozen budget, not
        // the registry settings of a restarted process.
        let args = Data::parse(arguments.as_bytes(), &input.binding.limits)?;
        let object = args.object()?;
        if object.len() != 2 {
            return Err("Only delivery_id and message may be supplied".into());
        }
        let delivery_id = args
            .get("delivery_id")
            .and_then(Data::string)
            .ok_or("Missing delivery_id")?;
        if delivery_id.is_empty() || delivery_id.len() > 160 {
            return Err("Invalid delivery_id".into());
        }
        let source = args.get("message").ok_or("Missing message")?;
        let wire = format!(
            "{{\"io_version\":\"1\",\"client_message_id\":\"output-parser\",\"message\":{}}}",
            source.json()
        );
        let message = super::Request::parse(wire.as_bytes(), &input.binding.limits)?.message;
        validate_output(&input, &message, &self.limits)?;
        let output_binding = input
            .binding
            .accept_formats
            .iter()
            .find(|format| {
                format.format.id == message.format.id
                    && format.format.version == message.format.version
                    && format.format.encoding == message.content.encoding()
            })
            .expect("validated output binding");
        let digest = super::hash(&(route.root_turn_id.clone(), delivery_id));
        let id = format!("io_output_{}", digest.trim_start_matches("sha256:"));
        // Preparation uses this deterministic Event's filenames. Hold the
        // same OS lock across the authoritative retry lookup, preparation and
        // commit so a losing preparer cannot clean up a winning Event's files.
        let _files = super::file_lock::acquire(&self.artifact_root, &id).await?;
        if let Some(mut previous) = self
            .store
            .query(QueryFilter {
                event_id: Some(id.clone()),
                session_id: Some(session.clone()),
                ..Default::default()
            })
            .await?
            .into_iter()
            .next()
        {
            // Check the original committed identity before reading resources
            // again. The Store still rechecks current authority and content.
            previous.payload.insert("io_message".into(), json!(message));
            previous
                .payload
                .insert("principal_id".into(), json!(principal));
            self.store.commit_io_output(&previous).await?;
            return Ok(json!({"status":"committed","output_id":id,"event_id":id,"duplicate":true,"execution_complete":false}).to_string());
        }
        let mut attachments = Vec::new();
        let resource_paths = output_binding
            .definition
            .as_ref()
            .map(|definition| definition.resource_paths.as_slice())
            .unwrap_or_default();
        let mut usage = crate::model_input::ModelInputUsage::default();
        let original_resources = super::resources::declared_ids(&message, resource_paths)?;
        for resource in &original_resources {
            let (event_id, _) = super::resources::decode_id(resource)?;
            let source = self
                .store
                .query(QueryFilter {
                    event_id: Some(event_id),
                    session_id: Some(session.clone()),
                    ..Default::default()
                })
                .await?
                .into_iter()
                .next()
                .ok_or("Resource does not belong to this Session")?;
            let metadata = super::resources::attachment_metadata(&source, resource)?;
            let bytes =
                crate::model_input::read_stored_attachment(&self.artifact_root, &metadata).await?;
            usage.add(bytes.data.len())?;
            crate::model_input::validate_model_input_usage(
                usage,
                self.import_limits,
                "typed output resources",
            )?;
            attachments.push(crate::sdk::MessageAttachmentInput {
                name: bytes.name,
                media_type: bytes.media_type,
                data: bytes.data,
            });
        }
        let prepared = crate::model_input::prepare_message_input_attachments(
            &self.artifact_root,
            &session,
            &id,
            attachments,
            self.import_limits,
        )
        .await?;
        let resources = prepared
            .metadata()
            .iter()
            .zip(&original_resources)
            .map(|(metadata, original)| {
                let mut resource = super::resources::public_metadata(&id, metadata);
                resource["original_resource_id"] = json!(original);
                resource
            })
            .collect::<Vec<_>>();
        super::projection::validate_budget(
            &message,
            output_binding,
            &input.binding.limits,
            super::projection::definition_bytes(output_binding)
                .saturating_add(super::projection::resource_bytes(&resources)),
        )?;
        let event = Event::new(
            id.clone(),
            "Agent-Morphz".into(),
            crate::event::TYPE_AGENT_CALL.into(),
            "session/io_output".into(),
            serde_json::from_value(json!({
                "context_id":context,"session_id":session,"principal_id":principal,
                "thread_id":route.thread_id,"activation_id":route.activation_id,"root_turn_id":route.root_turn_id,
                "model_attempt_id":route.model_attempt_id,"trigger_event_id":route.trigger_event_id,
                "io_message":message,"io_format_binding":output_binding,"output_id":id,"delivery_id":delivery_id,
                "io_limits":input.binding.limits,"io_resources":resources,"attachments":prepared.metadata(),
                "validation":"accepted-binding"
            }))?,
        );
        let fresh = match self.store.commit_io_output(&event).await {
            Ok(fresh) => {
                prepared.commit().await?;
                fresh
            }
            // A concurrent delivery with this deterministic ID may have won,
            // or acknowledgement may have failed after commit. Do not unlink
            // its files. Existing durable pending-manifest recovery decides.
            Err(error) => return Err(error),
        };
        if fresh {
            let _ = self.bus.dispatch_persisted(event).await;
        }
        Ok(json!({"status":"committed","output_id":id,"event_id":id,"duplicate":!fresh,"execution_complete":false}).to_string())
    }
}

#[cfg(all(test, feature = "experimental-session-io"))]
include!("output_tests.rs");
