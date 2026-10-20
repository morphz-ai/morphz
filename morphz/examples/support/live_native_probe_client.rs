//! Example-only observer/fault injector. This is not a provider adapter or a
//! production recovery path. Every completion still calls the configured Client.
use morphz::{
    config::AppConfig,
    llm::{
        Client, Message, ModelAttemptBinding, ModelAttemptBindingError, ModelFailure,
        ModelFailureKind, ModelRequestContext, ModelRequestOptions, ModelRouteDiagnostic,
        ModelStreamEvent, ModelStreamSender, PromptTokenCount, ProviderAccountDiagnostic,
        ReasoningEffort, Response, ToolDefinition,
    },
    memory::{AgentProviderBindingStore, ProviderAccountStateStore},
    provider::auth::ProviderAuthManager,
};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

type DynError = Box<dyn std::error::Error + Send + Sync>;
const READ: &str = "session_io_probe_read";
// Deliberately invalid: an object field is followed by a bare unnamed object.
// Synthetic text only; no part of the user's failed request is copied here.
const INJECTED_ARGUMENTS: &str =
    r#"{"path":"review.txt",{"intent":"TEST injected malformed argument"}}"#;

#[derive(Clone, Debug, Serialize)]
pub struct InjectionReceipt {
    pub fault_injected: bool,
    pub natural_model_failure: bool,
    pub call_id: String,
    pub original_arguments_sha256: String,
    pub injected_arguments: String,
    pub original_stream_matches_response: bool,
    pub injected_stream_matches_response: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Audit {
    pub requests: Vec<Value>,
    pub blocked_requests: Vec<Value>,
    /// Genuine completed provider content/calls, before the explicit fault.
    /// Only synthetic probe inputs are ever sent by this example.
    pub provider_responses: Vec<Response>,
    pub unobserved_completion_entrypoints: usize,
    pub health_probes: usize,
    pub injection: Option<InjectionReceipt>,
    pub injected_response_provider_continuations_forwarded: usize,
}

pub struct ObservedClient {
    inner: Arc<dyn Client>,
    audit: Arc<Mutex<Audit>>,
    inject: bool,
    allowed_tools: Vec<String>,
    request_limit: usize,
}

impl ObservedClient {
    pub fn new(
        inner: Arc<dyn Client>,
        inject: bool,
        allowed_tools: Vec<String>,
        request_limit: usize,
    ) -> (Arc<Self>, Arc<Mutex<Audit>>) {
        let audit = Arc::new(Mutex::new(Audit::default()));
        (
            Arc::new(Self {
                inner,
                audit: audit.clone(),
                inject,
                allowed_tools,
                request_limit,
            }),
            audit,
        )
    }

    fn other_completion(&self) {
        self.audit.lock().unwrap().unobserved_completion_entrypoints += 1;
    }

    fn validate_scope(&self, response: &Response) -> Result<(), DynError> {
        if let Some(call) = response
            .tool_calls
            .iter()
            .find(|call| !self.allowed_tools.contains(&call.func_name))
        {
            return Err(gate_failure(format!(
                "Live probe stopped before dispatch: tool {} is outside this synthetic case",
                call.func_name
            )));
        }
        Ok(())
    }
}

fn gate_failure(message: impl Into<String>) -> DynError {
    // A failed test precondition is terminal, not a transient provider failure
    // that Runtime should recover with another paid model request.
    Box::new(ModelFailure::new(
        ModelFailureKind::InvalidModelOrRequest,
        message.into(),
    ))
}

/// Rewrites only a single, originally valid native read call. All other stream
/// events (including usage, opaque provider continuation and body) are retained
/// verbatim, in order. This helper never creates an LLM response.
fn inject_once(
    response: &mut Response,
    events: &mut Vec<ModelStreamEvent>,
) -> Result<InjectionReceipt, DynError> {
    if response.tool_calls.len() != 1 {
        return Err("Injection requires exactly one genuine native read call".into());
    }
    let call = &mut response.tool_calls[0];
    if call.func_name != READ || call.id.is_empty() {
        return Err("Injection requires a genuine session_io_probe_read call ID".into());
    }
    let original: Value = serde_json::from_str(&call.arguments)?;
    morphz::session_io::Data::parse(
        call.arguments.as_bytes(),
        &morphz::session_io::Limits::default(),
    )?
    .object()?;
    if !original.is_object() || original["path"] != "review.txt" {
        return Err("Injection requires originally valid synthetic review.txt arguments".into());
    }
    if original
        .as_object()
        .unwrap()
        .keys()
        .any(|key| !matches!(key.as_str(), "path" | "_morphz"))
    {
        return Err("Injection requires valid business fields before corruption".into());
    }
    let starts = events
        .iter()
        .filter_map(|event| match event {
            ModelStreamEvent::ToolCallStarted { index, id, name }
                if id == &call.id && name == READ =>
            {
                Some(*index)
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    if starts.len() != 1 {
        return Err("Injection requires one matching streamed native call identity".into());
    }
    let index = starts[0];
    let original_stream = events
        .iter()
        .filter_map(|event| match event {
            ModelStreamEvent::ToolArgumentsDelta { index: i, delta } if *i == index => {
                Some(delta.as_str())
            }
            _ => None,
        })
        .collect::<String>();
    if original_stream != call.arguments {
        return Err(
            "Original provider stream and completed arguments disagree; not injecting".into(),
        );
    }
    if events
        .iter()
        .filter(|event| {
            matches!(event, ModelStreamEvent::ToolCallCompleted { index: i } if *i == index)
        })
        .count()
        != 1
    {
        return Err("Injection requires a completed genuine native tool stream".into());
    }
    let receipt = InjectionReceipt {
        fault_injected: true,
        natural_model_failure: false,
        call_id: call.id.clone(),
        original_arguments_sha256: format!("{:x}", Sha256::digest(call.arguments.as_bytes())),
        injected_arguments: INJECTED_ARGUMENTS.into(),
        original_stream_matches_response: true,
        injected_stream_matches_response: true,
    };
    let mut replaced = false;
    *events = std::mem::take(events)
        .into_iter()
        .filter_map(|event| match event {
            ModelStreamEvent::ToolArgumentsDelta { index: i, .. } if i == index => {
                if replaced {
                    None
                } else {
                    replaced = true;
                    Some(ModelStreamEvent::ToolArgumentsDelta {
                        index,
                        delta: INJECTED_ARGUMENTS.into(),
                    })
                }
            }
            event => Some(event),
        })
        .collect();
    if !replaced {
        return Err("Injection has no genuine streamed arguments to replace".into());
    }
    call.arguments = INJECTED_ARGUMENTS.into();
    Ok(receipt)
}

#[async_trait::async_trait]
impl Client for ObservedClient {
    fn replace_provider_catalog(&self, config: &AppConfig) -> Result<(), String> {
        self.inner.replace_provider_catalog(config)
    }
    fn attach_provider_auth_manager(&self, manager: Arc<ProviderAuthManager>) {
        self.inner.attach_provider_auth_manager(manager)
    }
    fn attach_provider_account_state_store(&self, store: Arc<dyn ProviderAccountStateStore>) {
        self.inner.attach_provider_account_state_store(store)
    }
    fn attach_agent_provider_binding_store(&self, store: Arc<dyn AgentProviderBindingStore>) {
        self.inner.attach_agent_provider_binding_store(store)
    }
    fn provider_resource_key(&self) -> String {
        self.inner.provider_resource_key()
    }
    fn provider_resource_key_for_requested_model(&self, model: Option<&str>) -> String {
        self.inner.provider_resource_key_for_requested_model(model)
    }
    fn provider_resource_key_for_binding(&self, binding: &ModelAttemptBinding) -> String {
        self.inner.provider_resource_key_for_binding(binding)
    }
    fn prefers_structured_delta_cache_transport(&self, model: Option<&str>) -> bool {
        self.inner.prefers_structured_delta_cache_transport(model)
    }
    fn supports_async_cancellation(&self) -> bool {
        self.inner.supports_async_cancellation()
    }
    fn model(&self) -> Option<String> {
        self.inner.model()
    }
    fn set_model(&self, model: &str) -> Result<(), String> {
        self.inner.set_model(model)
    }
    fn model_is_agent_allowed(&self, model: &str) -> bool {
        self.inner.model_is_agent_allowed(model)
    }
    fn reasoning_effort(&self) -> Option<ReasoningEffort> {
        self.inner.reasoning_effort()
    }
    fn set_reasoning_effort(&self, effort: Option<ReasoningEffort>) -> Result<(), String> {
        self.inner.set_reasoning_effort(effort)
    }
    async fn bind_model_attempt(
        &self,
        request: &ModelRequestContext,
    ) -> Result<ModelAttemptBinding, ModelAttemptBindingError> {
        self.inner.bind_model_attempt(request).await
    }
    async fn bind_requested_model_attempt(
        &self,
        request: &ModelRequestContext,
        model: Option<&str>,
    ) -> Result<ModelAttemptBinding, ModelAttemptBindingError> {
        self.inner
            .bind_requested_model_attempt(request, model)
            .await
    }
    async fn diagnose_model_route(
        &self,
        alias: &str,
        account: Option<&str>,
    ) -> Result<ModelRouteDiagnostic, DynError> {
        self.inner.diagnose_model_route(alias, account).await
    }
    async fn diagnose_provider_account(
        &self,
        account: &str,
        model: Option<&str>,
    ) -> Result<ProviderAccountDiagnostic, DynError> {
        self.inner.diagnose_provider_account(account, model).await
    }
    async fn count_prompt_tokens(
        &self,
        scope: &str,
        messages: &[Message],
        tools: &[ToolDefinition],
    ) -> Result<Option<PromptTokenCount>, DynError> {
        self.inner.count_prompt_tokens(scope, messages, tools).await
    }
    async fn count_prompt_tokens_for_requested_model(
        &self,
        scope: &str,
        model: Option<&str>,
        messages: &[Message],
        tools: &[ToolDefinition],
    ) -> Result<Option<PromptTokenCount>, DynError> {
        self.inner
            .count_prompt_tokens_for_requested_model(scope, model, messages, tools)
            .await
    }
    async fn create_completion(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
    ) -> Result<Response, DynError> {
        self.other_completion();
        self.inner.create_completion(messages, tools).await
    }
    async fn create_completion_measured(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
        measurement: Option<PromptTokenCount>,
    ) -> Result<Response, DynError> {
        self.other_completion();
        self.inner
            .create_completion_measured(messages, tools, measurement)
            .await
    }
    async fn create_completion_measured_stream(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
        measurement: Option<PromptTokenCount>,
        stream: ModelStreamSender,
    ) -> Result<Response, DynError> {
        self.other_completion();
        self.inner
            .create_completion_measured_stream(messages, tools, measurement, stream)
            .await
    }
    async fn create_completion_bound_stream(
        &self,
        binding: &ModelAttemptBinding,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
        measurement: Option<PromptTokenCount>,
        stream: ModelStreamSender,
    ) -> Result<Response, DynError> {
        self.other_completion();
        self.inner
            .create_completion_bound_stream(binding, messages, tools, measurement, stream)
            .await
    }
    async fn create_completion_bound_stream_with_options(
        &self,
        binding: &ModelAttemptBinding,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
        measurement: Option<PromptTokenCount>,
        stream: ModelStreamSender,
        options: ModelRequestOptions,
    ) -> Result<Response, DynError> {
        let prompt = messages
            .iter()
            .map(morphz::llm::model_visible_message_text)
            .collect::<Vec<_>>()
            .join("\n");
        {
            let mut audit = self.audit.lock().unwrap();
            let error_visible = audit.injection.as_ref().is_some_and(|injection| {
                prompt.contains(&injection.call_id)
                    && prompt.contains("INVALID_TOOL_ARGUMENTS")
                    && prompt.contains("valid JSON object")
            });
            let request = json!({
                "ordinal":audit.requests.len()+1,
                "entrypoint":"create_completion_bound_stream_with_options",
                "physical_model":binding.physical_model,
                "protocol":binding.protocol,
                "provider_adapter":binding.provider_adapter,
                "binding_sha256":format!("{:x}",Sha256::digest(serde_json::to_vec(binding)?)),
                "tools_sha256":format!("{:x}",Sha256::digest(serde_json::to_vec(&tools)?)),
                "native_v3_in_context":prompt.contains("(carrier native_v3)"),
                "rejection_with_call_id_visible":error_visible,
                "provider_continuation_marker_present":messages.iter().any(|message|message.name.as_deref()==Some(morphz::llm::PROVIDER_CONTINUATION_MESSAGE_NAME)),
                "output_encoding":format!("{:?}",options.output_encoding),
                "tool_choice":format!("{:?}",options.tool_choice),
                "reasoning_effort":format!("{:?}",options.reasoning_effort),
                // Fresh synthetic Context only. Preserve opaque continuation
                // identity/hash, never expose the provider's private reasoning.
                "messages":messages.iter().map(|message|{
                    if message.name.as_deref()==Some(morphz::llm::PROVIDER_CONTINUATION_MESSAGE_NAME) {
                        json!({"role":message.role,"name":message.name,"opaque_content_sha256":format!("{:x}",Sha256::digest(message.content.as_bytes()))})
                    } else {
                        json!(message)
                    }
                }).collect::<Vec<_>>(),
            });
            if audit.requests.len() >= self.request_limit {
                audit.blocked_requests.push(request);
                return Err(gate_failure(
                    "Live probe exceeded this case's explicit request budget",
                ));
            }
            audit.requests.push(request);
        }
        let inject = self.inject && self.audit.lock().unwrap().injection.is_none();
        if !inject {
            let response = self
                .inner
                .create_completion_bound_stream_with_options(
                    binding,
                    messages,
                    tools,
                    measurement,
                    stream,
                    options,
                )
                .await?;
            self.audit
                .lock()
                .unwrap()
                .provider_responses
                .push(response.clone());
            self.validate_scope(&response)?;
            return Ok(response);
        }
        // Only the deliberately injected first response is held at the test
        // boundary, so original completed JSON can be proven valid before it
        // is corrupted. Subsequent genuine responses stream without buffering.
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let result = self
            .inner
            .create_completion_bound_stream_with_options(
                binding,
                messages,
                tools,
                measurement,
                sender,
                options,
            )
            .await;
        let mut events = Vec::new();
        while let Ok(event) = receiver.try_recv() {
            events.push(event);
        }
        let mut response = match result {
            Ok(response) => response,
            Err(error) => {
                for event in events {
                    let _ = stream.send(event);
                }
                return Err(error);
            }
        };
        self.audit
            .lock()
            .unwrap()
            .provider_responses
            .push(response.clone());
        self.validate_scope(&response)?;
        let receipt = inject_once(&mut response, &mut events).map_err(|error| {
            gate_failure(format!("Fault-injection precondition failed: {error}"))
        })?;
        {
            let mut audit = self.audit.lock().unwrap();
            audit.injected_response_provider_continuations_forwarded += events
                .iter()
                .filter(|event| matches!(event, ModelStreamEvent::ProviderContinuation { .. }))
                .count();
            audit.injection = Some(receipt);
        }
        for event in events {
            let _ = stream.send(event);
        }
        Ok(response)
    }
    async fn probe_health(&self) -> Result<(), DynError> {
        self.audit.lock().unwrap().health_probes += 1;
        self.inner.probe_health().await
    }
    async fn probe_health_bound(&self, binding: &ModelAttemptBinding) -> Result<(), DynError> {
        self.audit.lock().unwrap().health_probes += 1;
        self.inner.probe_health_bound(binding).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use morphz::llm::{ModelUsage, ProviderContinuation, ToolCallRepr};

    fn fixture() -> (Response, Vec<ModelStreamEvent>) {
        let args = r#"{"path":"review.txt","_morphz":{"execution":{"title":"TEST"},"intent":"TEST read"}}"#;
        (
            Response {
                content: "TEST genuine progress".into(),
                tool_calls: vec![ToolCallRepr {
                    id: "TEST-original-provider-call".into(),
                    r#type: "function".into(),
                    func_name: READ.into(),
                    arguments: args.into(),
                }],
            },
            vec![
                ModelStreamEvent::Started,
                ModelStreamEvent::TextDelta {
                    text: "TEST genuine progress".into(),
                },
                ModelStreamEvent::ToolCallStarted {
                    index: 0,
                    id: "TEST-original-provider-call".into(),
                    name: READ.into(),
                },
                ModelStreamEvent::ToolArgumentsDelta {
                    index: 0,
                    delta: args[..20].into(),
                },
                ModelStreamEvent::ToolArgumentsDelta {
                    index: 0,
                    delta: args[20..].into(),
                },
                ModelStreamEvent::ToolCallCompleted { index: 0 },
                ModelStreamEvent::ProviderContinuation {
                    continuation: ProviderContinuation::OpenaiChat {
                        reasoning_content: "TEST opaque provider reasoning, not public text".into(),
                    },
                },
                ModelStreamEvent::Usage {
                    usage: ModelUsage {
                        input_tokens: Some(11),
                        output_tokens: Some(7),
                        ..Default::default()
                    },
                },
                ModelStreamEvent::Completed,
            ],
        )
    }

    #[test]
    fn injected_fault_preserves_identity_body_and_stream_response_consistency() {
        let (mut response, mut events) = fixture();
        let original = response.clone();
        let unaffected = events
            .iter()
            .filter(|event| !matches!(event, ModelStreamEvent::ToolArgumentsDelta { .. }))
            .cloned()
            .collect::<Vec<_>>();
        let receipt = inject_once(&mut response, &mut events).unwrap();
        assert!(receipt.fault_injected && !receipt.natural_model_failure);
        assert_eq!(response.content, original.content);
        assert_eq!(response.tool_calls[0].id, original.tool_calls[0].id);
        assert_eq!(
            response.tool_calls[0].func_name,
            original.tool_calls[0].func_name
        );
        assert!(serde_json::from_str::<Value>(&response.tool_calls[0].arguments).is_err());
        assert_eq!(
            events
                .iter()
                .filter_map(|event| match event {
                    ModelStreamEvent::ToolArgumentsDelta { delta, .. } => Some(delta.as_str()),
                    _ => None,
                })
                .collect::<String>(),
            response.tool_calls[0].arguments
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| !matches!(event, ModelStreamEvent::ToolArgumentsDelta { .. }))
                .cloned()
                .collect::<Vec<_>>(),
            unaffected
        );
        assert!(inject_once(&mut response, &mut events).is_err());
    }

    #[test]
    fn natural_invalid_response_or_stream_mismatch_is_not_reported_as_injection() {
        let (mut response, mut events) = fixture();
        response.tool_calls[0].arguments = INJECTED_ARGUMENTS.into();
        assert!(inject_once(&mut response, &mut events).is_err());
        let (mut response, mut events) = fixture();
        response.tool_calls[0].arguments = r#"{"path":"review.txt"}"#.into();
        assert!(inject_once(&mut response, &mut events).is_err());
        let (mut response, mut events) = fixture();
        response.tool_calls[0].id = "TEST-different-call".into();
        assert!(inject_once(&mut response, &mut events).is_err());
        let (mut response, mut events) = fixture();
        response.tool_calls.push(response.tool_calls[0].clone());
        assert!(inject_once(&mut response, &mut events).is_err());
    }
}
