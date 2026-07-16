use crate::config::{
    AppConfig, CredentialConfig, CredentialSource, LlmConfig, ModelProtocol, ProviderConfig,
};
use crate::llm::{
    Client, Message, ModelStreamEvent, ModelStreamSender, PromptTokenAccuracy, PromptTokenCount,
    ReasoningEffort, Response, ToolCallRepr, ToolDefinition,
};
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Arc, RwLock};
use std::time::Duration;

type ProviderError = Box<dyn std::error::Error + Send + Sync>;
pub type ConfiguredClient = (Arc<dyn Client>, SelectedProvider);

#[derive(Debug, Clone)]
pub struct SelectedProvider {
    pub id: String,
    pub protocol: ModelProtocol,
    pub base_url: String,
    pub model: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProviderProbe {
    pub provider: String,
    pub protocol: String,
    pub base_url: String,
    pub models_discovered: usize,
    pub selected_model_available: Option<bool>,
    pub completion_stream_verified: bool,
    pub normalized_stream_events: usize,
    pub tool_call_verified: bool,
    pub catalog_error: Option<String>,
}

pub fn build_configured_client(
    app: &AppConfig,
    provider_override: Option<&str>,
    model_override: Option<&str>,
) -> Result<ConfiguredClient, ProviderError> {
    let provider_id = provider_override
        .map(str::to_string)
        .or_else(|| app.llm.provider.clone())
        .ok_or("尚未选择模型 Provider；请先运行 `morphz setup`")?;
    let provider = app
        .providers
        .get(&provider_id)
        .ok_or_else(|| format!("Provider '{provider_id}' 未在用户配置中定义"))?;
    if provider.base_url.trim().is_empty() {
        return Err(format!("Provider '{provider_id}' 的 base_url 不能为空").into());
    }
    let model = model_override.unwrap_or(&app.llm.model).trim().to_string();
    if model.is_empty() {
        return Err("模型名称不能为空".into());
    }
    let credential = resolve_provider_credential(app, provider)?;
    let client = ProtocolClient::new(provider, model.clone(), credential, &app.llm)?;
    let selected = SelectedProvider {
        id: provider_id,
        protocol: provider.protocol,
        base_url: provider.base_url.clone(),
        model,
    };
    Ok((Arc::new(client), selected))
}

fn resolve_provider_credential(
    app: &AppConfig,
    provider: &ProviderConfig,
) -> Result<Option<String>, ProviderError> {
    let Some(reference) = provider.credential.as_deref() else {
        return Ok(None);
    };
    let credential = app
        .credentials
        .get(reference)
        .ok_or_else(|| format!("Provider 引用了不存在的 Credential '{reference}'"))?;
    resolve_credential(reference, credential)
}

fn resolve_credential(
    id: &str,
    credential: &CredentialConfig,
) -> Result<Option<String>, ProviderError> {
    match credential.source {
        CredentialSource::None => Ok(None),
        CredentialSource::Env => {
            let name = credential
                .name
                .as_deref()
                .ok_or_else(|| format!("Credential '{id}' 缺少环境变量名称"))?;
            let value = std::env::var(name)
                .map_err(|_| format!("Credential '{id}' 需要环境变量 {name}"))?;
            if value.trim().is_empty() {
                Err(format!("Credential '{id}' 的环境变量 {name} 为空").into())
            } else {
                Ok(Some(value))
            }
        }
        CredentialSource::Keychain => {
            let account = credential.name.as_deref().unwrap_or(id);
            let service = credential.service.as_deref().unwrap_or("morphz");
            let value = keyring::Entry::new(service, account)?.get_password()?;
            if value.trim().is_empty() {
                Err(format!("Credential '{id}' 的 Keychain 值为空").into())
            } else {
                Ok(Some(value))
            }
        }
        CredentialSource::Command => resolve_command_credential(id, &credential.command),
    }
}

fn resolve_command_credential(
    id: &str,
    command: &[String],
) -> Result<Option<String>, ProviderError> {
    let executable = command
        .first()
        .ok_or_else(|| format!("Credential '{id}' 的 command 为空"))?;
    let mut child = Command::new(executable)
        .args(&command[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait()? {
            if !status.success() {
                return Err(format!("Credential '{id}' Helper 退出状态为 {status}").into());
            }
            let mut value = String::new();
            if let Some(mut stdout) = child.stdout.take() {
                stdout.read_to_string(&mut value)?;
            }
            let value = value.trim().to_string();
            if value.is_empty() {
                return Err(format!("Credential '{id}' Helper 返回了空值").into());
            }
            return Ok(Some(value));
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Credential '{id}' Helper 超过 5 秒未完成").into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

pub fn store_keychain_credential(
    service: &str,
    account: &str,
    secret: &str,
) -> Result<(), ProviderError> {
    if secret.is_empty() {
        return Err("拒绝把空凭证写入 Keychain".into());
    }
    keyring::Entry::new(service, account)?.set_password(secret)?;
    Ok(())
}

pub fn delete_keychain_credential(service: &str, account: &str) -> Result<(), ProviderError> {
    keyring::Entry::new(service, account)?.delete_credential()?;
    Ok(())
}

pub struct ProtocolClient {
    http: reqwest::Client,
    protocol: ModelProtocol,
    base_url: String,
    model: String,
    credential: Option<String>,
    headers: HeaderMap,
    max_retries: u32,
    initial_backoff_secs: u64,
    max_output_tokens: Option<u32>,
    reasoning_effort: RwLock<Option<ReasoningEffort>>,
}

impl ProtocolClient {
    fn new(
        provider: &ProviderConfig,
        model: String,
        credential: Option<String>,
        llm: &LlmConfig,
    ) -> Result<Self, ProviderError> {
        let mut headers = HeaderMap::new();
        for (name, value) in &provider.headers {
            headers.insert(
                HeaderName::from_bytes(name.as_bytes())?,
                HeaderValue::from_str(value)?,
            );
        }
        for (name, variable) in &provider.env_headers {
            let value = std::env::var(variable)
                .map_err(|_| format!("Provider Header '{name}' 需要环境变量 {variable}"))?;
            headers.insert(
                HeaderName::from_bytes(name.as_bytes())?,
                HeaderValue::from_str(&value)?,
            );
        }
        let http = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(llm.request_timeout_secs.max(1)))
            .build()?;
        Ok(Self {
            http,
            protocol: provider.protocol,
            base_url: provider.base_url.trim_end_matches('/').to_string(),
            model,
            credential,
            headers,
            max_retries: llm.max_retries.max(1),
            initial_backoff_secs: llm.initial_backoff_secs,
            max_output_tokens: llm.max_output_tokens,
            reasoning_effort: RwLock::new(llm.reasoning_effort),
        })
    }

    fn endpoint(&self) -> Result<String, ProviderError> {
        self.endpoint_for(false)
    }

    fn endpoint_for(&self, streaming: bool) -> Result<String, ProviderError> {
        let endpoint = match self.protocol {
            ModelProtocol::OpenaiResponses => format!("{}/responses", self.base_url),
            ModelProtocol::OpenaiChat => format!("{}/chat/completions", self.base_url),
            ModelProtocol::AnthropicMessages => format!("{}/messages", self.base_url),
            ModelProtocol::GeminiContent => {
                let mut url = reqwest::Url::parse(&self.base_url)?;
                let method = if streaming {
                    "streamGenerateContent"
                } else {
                    "generateContent"
                };
                url.path_segments_mut()
                    .map_err(|_| "Gemini Provider base_url 不能作为分层 URL")?
                    .push("models")
                    .push(&format!("{}:{method}", self.model));
                if streaming {
                    url.query_pairs_mut().append_pair("alt", "sse");
                }
                url.to_string()
            }
        };
        Ok(endpoint)
    }

    fn request(&self, messages: &[Message], tools: &[ToolDefinition]) -> Value {
        build_request(
            self.protocol,
            &self.model,
            self.max_output_tokens,
            self.reasoning_effort
                .read()
                .map(|effort| *effort)
                .unwrap_or(None),
            messages,
            tools,
        )
    }

    fn authorize(&self, mut request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        request = request.headers(self.headers.clone());
        if let Some(secret) = &self.credential {
            request = match self.protocol {
                ModelProtocol::OpenaiResponses | ModelProtocol::OpenaiChat => {
                    request.bearer_auth(secret)
                }
                ModelProtocol::AnthropicMessages => request
                    .header("x-api-key", secret)
                    .header("anthropic-version", "2023-06-01"),
                ModelProtocol::GeminiContent => request.header("x-goog-api-key", secret),
            };
        } else if self.protocol == ModelProtocol::AnthropicMessages {
            request = request.header("anthropic-version", "2023-06-01");
        }
        request
    }

    async fn send(&self, body: &Value) -> Result<Value, ProviderError> {
        let endpoint = self.endpoint()?;
        let mut attempt = 0;
        let mut backoff = Duration::from_secs(self.initial_backoff_secs);
        loop {
            attempt += 1;
            let request = self.authorize(self.http.post(&endpoint));
            match request.json(body).send().await {
                Ok(response) => {
                    let status = response.status();
                    if status.is_success() {
                        return Ok(response.json().await?);
                    }
                    let retryable = status.as_u16() == 429 || status.is_server_error();
                    let text = response.text().await.unwrap_or_default();
                    if retryable && attempt < self.max_retries {
                        tracing::warn!(
                            protocol = self.protocol.as_str(),
                            %status,
                            attempt,
                            max = self.max_retries,
                            "Provider 请求失败，准备重试"
                        );
                    } else {
                        return Err(format!(
                            "{} Provider 返回 HTTP {}: {}",
                            self.protocol.as_str(),
                            status,
                            text
                        )
                        .into());
                    }
                }
                Err(error) if attempt < self.max_retries => {
                    tracing::warn!(
                        protocol = self.protocol.as_str(),
                        %error,
                        attempt,
                        max = self.max_retries,
                        "Provider 网络错误，准备重试"
                    );
                }
                Err(error) => return Err(error.into()),
            }
            tokio::time::sleep(backoff).await;
            backoff = backoff.saturating_mul(2);
        }
    }

    async fn send_stream(
        &self,
        body: &Value,
        stream: &ModelStreamSender,
    ) -> Result<Response, ProviderError> {
        let endpoint = self.endpoint_for(true)?;
        let mut streaming_body = body.clone();
        if self.protocol != ModelProtocol::GeminiContent {
            streaming_body["stream"] = Value::Bool(true);
        }
        if self.protocol == ModelProtocol::OpenaiChat {
            streaming_body["stream_options"] = json!({"include_usage": true});
        }

        // Retrying is safe until a successful response is accepted and stream
        // events begin. Once any event has been consumed we must not replay the
        // request, because that could duplicate model output or tool calls.
        let mut attempt = 0;
        let mut backoff = Duration::from_secs(self.initial_backoff_secs);
        let response = loop {
            attempt += 1;
            let request = self.authorize(self.http.post(&endpoint));
            match request.json(&streaming_body).send().await {
                Ok(response) if response.status().is_success() => break response,
                Ok(response) => {
                    let status = response.status();
                    let retryable = status.as_u16() == 429 || status.is_server_error();
                    let text = response.text().await.unwrap_or_default();
                    if !retryable || attempt >= self.max_retries {
                        return Err(format!(
                            "{} 流式请求返回 HTTP {}: {}",
                            self.protocol.as_str(),
                            status,
                            text
                        )
                        .into());
                    }
                    tracing::warn!(
                        protocol = self.protocol.as_str(),
                        %status,
                        attempt,
                        max = self.max_retries,
                        "Provider 流建立失败，准备重试"
                    );
                }
                Err(error) if attempt < self.max_retries => {
                    tracing::warn!(
                        protocol = self.protocol.as_str(),
                        %error,
                        attempt,
                        max = self.max_retries,
                        "Provider 流建立发生网络错误，准备重试"
                    );
                }
                Err(error) => return Err(error.into()),
            }
            tokio::time::sleep(backoff).await;
            backoff = backoff.saturating_mul(2);
        };

        let mut accumulator = StreamAccumulator::default();
        let mut bytes = response.bytes_stream();
        let mut pending = Vec::new();
        while let Some(chunk) = bytes.next().await {
            pending.extend_from_slice(&chunk?);
            while let Some((frame, consumed)) = take_sse_frame(&pending) {
                pending.drain(..consumed);
                if let Some(data) = sse_data(&frame)? {
                    if data == "[DONE]" {
                        accumulator.terminal = true;
                        continue;
                    }
                    let event: Value = serde_json::from_str(&data).map_err(|error| {
                        format!("{} SSE 事件不是合法 JSON: {error}", self.protocol.as_str())
                    })?;
                    accumulator.apply(self.protocol, event, stream)?;
                }
            }
        }
        if !pending.is_empty() {
            if let Some(data) = sse_data(&pending)? {
                if data != "[DONE]" {
                    let event: Value = serde_json::from_str(&data)?;
                    accumulator.apply(self.protocol, event, stream)?;
                }
            }
        }
        accumulator.finish(stream)
    }

    pub async fn list_models(&self) -> Result<Vec<String>, ProviderError> {
        let endpoint = format!("{}/models", self.base_url);
        let response = self.authorize(self.http.get(&endpoint)).send().await?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(format!(
                "{} 模型目录返回 HTTP {}: {}",
                self.protocol.as_str(),
                status,
                text
            )
            .into());
        }
        let value: Value = response.json().await?;
        let rows = value
            .get("data")
            .or_else(|| value.get("models"))
            .and_then(Value::as_array)
            .ok_or_else(|| format!("{} 模型目录缺少 data/models 数组", self.protocol.as_str()))?;
        let mut models = rows
            .iter()
            .filter_map(|row| {
                row.get("id")
                    .or_else(|| row.get("name"))
                    .and_then(Value::as_str)
            })
            .map(|model| model.strip_prefix("models/").unwrap_or(model).to_string())
            .collect::<Vec<_>>();
        models.sort();
        models.dedup();
        Ok(models)
    }
}

pub async fn list_provider_models(
    app: &AppConfig,
    provider_id: &str,
) -> Result<Vec<String>, ProviderError> {
    let provider = app
        .providers
        .get(provider_id)
        .ok_or_else(|| format!("Provider '{provider_id}' 未定义"))?;
    let credential = resolve_provider_credential(app, provider)?;
    ProtocolClient::new(provider, app.llm.model.clone(), credential, &app.llm)?
        .list_models()
        .await
}

pub async fn probe_provider(
    app: &AppConfig,
    provider_id: &str,
    model: Option<&str>,
) -> Result<ProviderProbe, ProviderError> {
    let provider = app
        .providers
        .get(provider_id)
        .ok_or_else(|| format!("Provider '{provider_id}' 未定义"))?;
    let (models, catalog_error) = match list_provider_models(app, provider_id).await {
        Ok(models) => (models, None),
        Err(error) => (Vec::new(), Some(error.to_string())),
    };
    let selected_model_available = model.map(|model| models.iter().any(|item| item == model));
    let selected_model = model.unwrap_or(&app.llm.model).trim();
    if selected_model.is_empty() {
        return Err("Provider 测试需要模型 ID".into());
    }
    let credential = resolve_provider_credential(app, provider)?;
    let client = ProtocolClient::new(provider, selected_model.to_string(), credential, &app.llm)?;
    let probe_message = |content: &str| Message {
        role: "user".to_string(),
        content: content.to_string(),
        name: None,
        tool_call_id: None,
        tool_calls: None,
    };

    let (stream_tx, mut stream_rx) = tokio::sync::mpsc::unbounded_channel();
    let completion = client
        .create_completion_measured_stream(
            vec![probe_message(
                "Protocol health check. Reply with the plain text MORPHZ_OK and do not call tools.",
            )],
            Vec::new(),
            None,
            stream_tx,
        )
        .await?;
    let stream_events = std::iter::from_fn(|| stream_rx.try_recv().ok()).collect::<Vec<_>>();
    let completion_stream_verified = !completion.content.trim().is_empty()
        && stream_events
            .iter()
            .any(|event| matches!(event, ModelStreamEvent::Completed));

    let probe_tool = ToolDefinition {
        name: "morphz_probe".to_string(),
        description: "Protocol health-check tool. Call it exactly once when instructed."
            .to_string(),
        parameters: json!({
            "type": "object",
            "properties": {"value": {"type": "string"}},
            "required": ["value"],
            "additionalProperties": false
        }),
    };
    let (tool_tx, mut tool_rx) = tokio::sync::mpsc::unbounded_channel();
    let tool_response = client
        .create_completion_measured_stream(
            vec![probe_message(
                "Call morphz_probe exactly once with value MORPHZ_OK. Do not answer in plain text.",
            )],
            vec![probe_tool],
            None,
            tool_tx,
        )
        .await?;
    let tool_events = std::iter::from_fn(|| tool_rx.try_recv().ok()).collect::<Vec<_>>();
    let tool_call_verified = tool_response.tool_calls.iter().any(|call| {
        call.func_name == "morphz_probe"
            && serde_json::from_str::<Value>(&call.arguments)
                .ok()
                .and_then(|value| {
                    value
                        .get("value")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .as_deref()
                == Some("MORPHZ_OK")
    }) && tool_events
        .iter()
        .any(|event| matches!(event, ModelStreamEvent::ToolArgumentsDelta { .. }));
    Ok(ProviderProbe {
        provider: provider_id.to_string(),
        protocol: provider.protocol.as_str().to_string(),
        base_url: provider.base_url.clone(),
        models_discovered: models.len(),
        selected_model_available,
        completion_stream_verified,
        normalized_stream_events: stream_events.len() + tool_events.len(),
        tool_call_verified,
        catalog_error,
    })
}

#[async_trait::async_trait]
impl Client for ProtocolClient {
    fn reasoning_effort(&self) -> Option<ReasoningEffort> {
        self.reasoning_effort
            .read()
            .map(|effort| *effort)
            .unwrap_or(None)
    }

    fn set_reasoning_effort(&self, effort: Option<ReasoningEffort>) -> Result<(), String> {
        *self
            .reasoning_effort
            .write()
            .map_err(|_| "推理深度配置锁已损坏".to_string())? = effort;
        Ok(())
    }

    async fn count_prompt_tokens(
        &self,
        _scope: &str,
        messages: &[Message],
        tools: &[ToolDefinition],
    ) -> Result<Option<PromptTokenCount>, ProviderError> {
        let serialized = serde_json::to_string(&self.request(messages, tools))?;
        let ascii = serialized.chars().filter(char::is_ascii).count();
        let non_ascii = serialized.chars().count().saturating_sub(ascii);
        let tokens = (ascii.saturating_add(3) / 4).saturating_add(non_ascii);
        Ok(Some(PromptTokenCount {
            tokens,
            source: format!("{}-serialized-request-estimate", self.protocol.as_str()),
            model: self.model.clone(),
            accuracy: PromptTokenAccuracy::HeuristicEstimate,
            base_estimate_tokens: tokens,
            calibration_key: None,
        }))
    }

    async fn create_completion(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
    ) -> Result<Response, ProviderError> {
        let response = self.send(&self.request(&messages, &tools)).await?;
        parse_response(self.protocol, response)
    }

    async fn create_completion_measured_stream(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
        _measurement: Option<PromptTokenCount>,
        stream: ModelStreamSender,
    ) -> Result<Response, ProviderError> {
        let _ = stream.send(ModelStreamEvent::Started);
        match self
            .send_stream(&self.request(&messages, &tools), &stream)
            .await
        {
            Ok(response) => {
                let _ = stream.send(ModelStreamEvent::Completed);
                Ok(response)
            }
            Err(error) => {
                let _ = stream.send(ModelStreamEvent::Failed {
                    message: error.to_string(),
                });
                Err(error)
            }
        }
    }
}

#[derive(Debug, Default)]
struct StreamAccumulator {
    content: String,
    tools: BTreeMap<usize, StreamingToolCall>,
    gemini_tool_index: usize,
    terminal: bool,
}

#[derive(Debug, Default)]
struct StreamingToolCall {
    id: String,
    name: String,
    arguments: String,
    announced: bool,
    completed: bool,
}

impl StreamAccumulator {
    fn text(&mut self, text: &str, stream: &ModelStreamSender) {
        if text.is_empty() {
            return;
        }
        self.content.push_str(text);
        let _ = stream.send(ModelStreamEvent::TextDelta {
            text: text.to_string(),
        });
    }

    fn tool(
        &mut self,
        index: usize,
        id: Option<&str>,
        name: Option<&str>,
        stream: &ModelStreamSender,
    ) -> &mut StreamingToolCall {
        let tool = self.tools.entry(index).or_default();
        if let Some(id) = id.filter(|value| !value.is_empty()) {
            tool.id = id.to_string();
        }
        if let Some(name) = name.filter(|value| !value.is_empty()) {
            tool.name = name.to_string();
        }
        if !tool.announced && (!tool.id.is_empty() || !tool.name.is_empty()) {
            tool.announced = true;
            let _ = stream.send(ModelStreamEvent::ToolCallStarted {
                index,
                id: tool.id.clone(),
                name: tool.name.clone(),
            });
        }
        tool
    }

    fn arguments(&mut self, index: usize, delta: &str, stream: &ModelStreamSender) {
        if delta.is_empty() {
            return;
        }
        let tool = self.tools.entry(index).or_default();
        tool.arguments.push_str(delta);
        let _ = stream.send(ModelStreamEvent::ToolArgumentsDelta {
            index,
            delta: delta.to_string(),
        });
    }

    fn complete_tool(&mut self, index: usize, stream: &ModelStreamSender) {
        if let Some(tool) = self.tools.get_mut(&index) {
            if !tool.completed {
                tool.completed = true;
                let _ = stream.send(ModelStreamEvent::ToolCallCompleted { index });
            }
        }
    }

    fn usage(
        &self,
        prompt_tokens: Option<u64>,
        completion_tokens: Option<u64>,
        total_tokens: Option<u64>,
        stream: &ModelStreamSender,
    ) {
        if prompt_tokens.is_some() || completion_tokens.is_some() || total_tokens.is_some() {
            let _ = stream.send(ModelStreamEvent::Usage {
                prompt_tokens,
                completion_tokens,
                total_tokens,
            });
        }
    }

    fn apply(
        &mut self,
        protocol: ModelProtocol,
        event: Value,
        stream: &ModelStreamSender,
    ) -> Result<(), ProviderError> {
        match protocol {
            ModelProtocol::OpenaiChat => self.apply_openai_chat(event, stream),
            ModelProtocol::OpenaiResponses => self.apply_openai_responses(event, stream),
            ModelProtocol::AnthropicMessages => self.apply_anthropic(event, stream),
            ModelProtocol::GeminiContent => self.apply_gemini(event, stream),
        }
    }

    fn apply_openai_chat(
        &mut self,
        event: Value,
        stream: &ModelStreamSender,
    ) -> Result<(), ProviderError> {
        if let Some(usage) = event.get("usage") {
            self.usage(
                usage.get("prompt_tokens").and_then(Value::as_u64),
                usage.get("completion_tokens").and_then(Value::as_u64),
                usage.get("total_tokens").and_then(Value::as_u64),
                stream,
            );
        }
        let Some(choice) = event
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|v| v.first())
        else {
            return Ok(());
        };
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            match reason {
                "stop" | "tool_calls" | "function_call" => self.terminal = true,
                "length" => return Err("OpenAI Chat 流因输出长度限制被截断".into()),
                _ => return Err(format!("OpenAI Chat 流未完成: {reason}").into()),
            }
        }
        let delta = choice.get("delta").unwrap_or(&Value::Null);
        if let Some(text) = delta.get("content").and_then(Value::as_str) {
            self.text(text, stream);
        }
        for call in delta
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            self.tool(
                index,
                call.get("id").and_then(Value::as_str),
                call.pointer("/function/name").and_then(Value::as_str),
                stream,
            );
            if let Some(arguments) = call.pointer("/function/arguments").and_then(Value::as_str) {
                self.arguments(index, arguments, stream);
            }
        }
        Ok(())
    }

    fn apply_openai_responses(
        &mut self,
        event: Value,
        stream: &ModelStreamSender,
    ) -> Result<(), ProviderError> {
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match kind {
            "response.output_text.delta" => {
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    self.text(delta, stream);
                }
            }
            "response.output_item.added" => {
                let item = event.get("item").unwrap_or(&Value::Null);
                if item.get("type").and_then(Value::as_str) == Some("function_call") {
                    let index = event
                        .get("output_index")
                        .and_then(Value::as_u64)
                        .unwrap_or(0) as usize;
                    self.tool(
                        index,
                        item.get("call_id")
                            .or_else(|| item.get("id"))
                            .and_then(Value::as_str),
                        item.get("name").and_then(Value::as_str),
                        stream,
                    );
                }
            }
            "response.function_call_arguments.delta" => {
                let index = event
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    self.arguments(index, delta, stream);
                }
            }
            "response.function_call_arguments.done" => {
                let index = event
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                if self
                    .tools
                    .get(&index)
                    .is_some_and(|tool| tool.arguments.is_empty())
                {
                    if let Some(arguments) = event.get("arguments").and_then(Value::as_str) {
                        self.arguments(index, arguments, stream);
                    }
                }
                self.complete_tool(index, stream);
            }
            "response.output_item.done" => {
                let item = event.get("item").unwrap_or(&Value::Null);
                if item.get("type").and_then(Value::as_str) == Some("function_call") {
                    let index = event
                        .get("output_index")
                        .and_then(Value::as_u64)
                        .unwrap_or(0) as usize;
                    self.complete_tool(index, stream);
                }
            }
            "response.completed" => {
                self.terminal = true;
                if let Some(usage) = event.pointer("/response/usage") {
                    self.usage(
                        usage.get("input_tokens").and_then(Value::as_u64),
                        usage.get("output_tokens").and_then(Value::as_u64),
                        usage.get("total_tokens").and_then(Value::as_u64),
                        stream,
                    );
                }
            }
            "response.incomplete" | "response.failed" | "error" => {
                return Err(format!("OpenAI Responses 流失败: {event}").into());
            }
            _ => {}
        }
        Ok(())
    }

    fn apply_anthropic(
        &mut self,
        event: Value,
        stream: &ModelStreamSender,
    ) -> Result<(), ProviderError> {
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match kind {
            "message_start" => {
                self.usage(
                    event
                        .pointer("/message/usage/input_tokens")
                        .and_then(Value::as_u64),
                    None,
                    None,
                    stream,
                );
            }
            "content_block_start" => {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let block = event.get("content_block").unwrap_or(&Value::Null);
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(text) = block.get("text").and_then(Value::as_str) {
                            self.text(text, stream);
                        }
                    }
                    Some("tool_use") => {
                        self.tool(
                            index,
                            block.get("id").and_then(Value::as_str),
                            block.get("name").and_then(Value::as_str),
                            stream,
                        );
                    }
                    _ => {}
                }
            }
            "content_block_delta" => {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let delta = event.get("delta").unwrap_or(&Value::Null);
                match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => {
                        if let Some(text) = delta.get("text").and_then(Value::as_str) {
                            self.text(text, stream);
                        }
                    }
                    Some("input_json_delta") => {
                        if let Some(arguments) = delta.get("partial_json").and_then(Value::as_str) {
                            self.arguments(index, arguments, stream);
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                self.complete_tool(index, stream);
            }
            "message_delta" => {
                if event.pointer("/delta/stop_reason").and_then(Value::as_str) == Some("max_tokens")
                {
                    return Err("Anthropic 流因 max_tokens 被截断".into());
                }
                self.usage(
                    None,
                    event
                        .pointer("/usage/output_tokens")
                        .and_then(Value::as_u64),
                    None,
                    stream,
                );
            }
            "message_stop" => self.terminal = true,
            "error" => return Err(format!("Anthropic 流失败: {event}").into()),
            _ => {}
        }
        Ok(())
    }

    fn apply_gemini(
        &mut self,
        event: Value,
        stream: &ModelStreamSender,
    ) -> Result<(), ProviderError> {
        if let Some(usage) = event.get("usageMetadata") {
            self.usage(
                usage.get("promptTokenCount").and_then(Value::as_u64),
                usage.get("candidatesTokenCount").and_then(Value::as_u64),
                usage.get("totalTokenCount").and_then(Value::as_u64),
                stream,
            );
        }
        let Some(candidate) = event
            .get("candidates")
            .and_then(Value::as_array)
            .and_then(|v| v.first())
        else {
            return Ok(());
        };
        let finish = candidate.get("finishReason").and_then(Value::as_str);
        if let Some(reason) = gemini_finish_failure(finish) {
            return Err(format!("Gemini 流未完成: {reason}").into());
        }
        if finish == Some("STOP") {
            self.terminal = true;
        }
        for part in candidate
            .pointer("/content/parts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                self.text(text, stream);
            }
            if let Some(call) = part.get("functionCall") {
                let index = self.gemini_tool_index;
                self.gemini_tool_index += 1;
                let id = call
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("gemini-call-{index}"));
                self.tool(
                    index,
                    Some(&id),
                    call.get("name").and_then(Value::as_str),
                    stream,
                );
                let arguments = serde_json::to_string(call.get("args").unwrap_or(&json!({})))?;
                self.arguments(index, &arguments, stream);
                self.complete_tool(index, stream);
            }
        }
        Ok(())
    }

    fn finish(mut self, stream: &ModelStreamSender) -> Result<Response, ProviderError> {
        if !self.terminal {
            return Err("Provider 流在协议终止事件之前断开".into());
        }
        let indices = self.tools.keys().copied().collect::<Vec<_>>();
        for index in indices {
            self.complete_tool(index, stream);
        }
        let tool_calls = self
            .tools
            .into_values()
            .map(|tool| ToolCallRepr {
                id: tool.id,
                r#type: "function".to_string(),
                func_name: tool.name,
                arguments: if tool.arguments.is_empty() {
                    "{}".to_string()
                } else {
                    tool.arguments
                },
            })
            .collect();
        ensure_nonempty(Response {
            content: self.content,
            tool_calls,
        })
    }
}

fn take_sse_frame(bytes: &[u8]) -> Option<(Vec<u8>, usize)> {
    let lf = bytes.windows(2).position(|window| window == b"\n\n");
    let crlf = bytes.windows(4).position(|window| window == b"\r\n\r\n");
    match (lf, crlf) {
        (Some(left), Some(right)) if left <= right => Some((bytes[..left].to_vec(), left + 2)),
        (Some(_), Some(right)) => Some((bytes[..right].to_vec(), right + 4)),
        (Some(index), None) => Some((bytes[..index].to_vec(), index + 2)),
        (None, Some(index)) => Some((bytes[..index].to_vec(), index + 4)),
        (None, None) => None,
    }
}

fn sse_data(frame: &[u8]) -> Result<Option<String>, ProviderError> {
    let text = std::str::from_utf8(frame)?;
    let data = text
        .lines()
        .filter_map(|line| line.trim_end_matches('\r').strip_prefix("data:"))
        .map(|line| line.strip_prefix(' ').unwrap_or(line))
        .collect::<Vec<_>>();
    if data.is_empty() {
        Ok(None)
    } else {
        Ok(Some(data.join("\n")))
    }
}

fn build_request(
    protocol: ModelProtocol,
    model: &str,
    max_output_tokens: Option<u32>,
    reasoning_effort: Option<ReasoningEffort>,
    messages: &[Message],
    tools: &[ToolDefinition],
) -> Value {
    match protocol {
        ModelProtocol::OpenaiChat => {
            build_openai_chat_request(model, max_output_tokens, reasoning_effort, messages, tools)
        }
        ModelProtocol::OpenaiResponses => build_openai_responses_request(
            model,
            max_output_tokens,
            reasoning_effort,
            messages,
            tools,
        ),
        ModelProtocol::AnthropicMessages => {
            build_anthropic_request(model, max_output_tokens, reasoning_effort, messages, tools)
        }
        ModelProtocol::GeminiContent => {
            build_gemini_request(max_output_tokens, reasoning_effort, messages, tools)
        }
    }
}

fn build_openai_chat_request(
    model: &str,
    max_output_tokens: Option<u32>,
    reasoning_effort: Option<ReasoningEffort>,
    messages: &[Message],
    tools: &[ToolDefinition],
) -> Value {
    let mut request = json!({"model": model, "messages": messages});
    if let Some(max_tokens) = max_output_tokens {
        request["max_completion_tokens"] = json!(max_tokens);
    }
    if let Some(effort) = reasoning_effort {
        request["reasoning_effort"] = json!(effort.as_str());
    }
    if !tools.is_empty() {
        request["tools"] = Value::Array(
            tools
                .iter()
                .map(|tool| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": tool.parameters,
                        }
                    })
                })
                .collect(),
        );
    }
    request
}

fn build_openai_responses_request(
    model: &str,
    max_output_tokens: Option<u32>,
    reasoning_effort: Option<ReasoningEffort>,
    messages: &[Message],
    tools: &[ToolDefinition],
) -> Value {
    let mut input = Vec::new();
    for message in messages {
        if message.role == "tool" {
            input.push(json!({
                "type": "function_call_output",
                "call_id": message.tool_call_id,
                "output": message.content,
            }));
            continue;
        }
        if !message.content.is_empty() {
            input.push(json!({"role": message.role, "content": message.content}));
        }
        for call in message.tool_calls.as_deref().unwrap_or_default() {
            input.push(json!({
                "type": "function_call",
                "call_id": call.id,
                "name": call.function.name,
                "arguments": call.function.arguments,
            }));
        }
    }
    let mut request = json!({"model": model, "input": input});
    if let Some(max_tokens) = max_output_tokens {
        request["max_output_tokens"] = json!(max_tokens);
    }
    if let Some(effort) = reasoning_effort {
        request["reasoning"] = json!({"effort": effort.as_str()});
    }
    if !tools.is_empty() {
        request["tools"] = Value::Array(
            tools
                .iter()
                .map(|tool| {
                    json!({
                        "type": "function",
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.parameters,
                        "strict": false,
                    })
                })
                .collect(),
        );
    }
    request
}

fn build_anthropic_request(
    model: &str,
    max_output_tokens: Option<u32>,
    reasoning_effort: Option<ReasoningEffort>,
    messages: &[Message],
    tools: &[ToolDefinition],
) -> Value {
    let system = messages
        .iter()
        .filter(|message| message.role == "system")
        .map(|message| message.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut converted: Vec<Value> = Vec::new();
    for message in messages.iter().filter(|message| message.role != "system") {
        let (role, mut content) = if message.role == "tool" {
            (
                "user",
                vec![json!({
                    "type": "tool_result",
                    "tool_use_id": message.tool_call_id,
                    "content": message.content,
                })],
            )
        } else {
            let role = if message.role == "assistant" {
                "assistant"
            } else {
                "user"
            };
            let mut blocks = Vec::new();
            if !message.content.is_empty() {
                blocks.push(json!({"type": "text", "text": message.content}));
            }
            for call in message.tool_calls.as_deref().unwrap_or_default() {
                let input = serde_json::from_str::<Value>(&call.function.arguments)
                    .unwrap_or_else(|_| json!({"raw": call.function.arguments}));
                blocks.push(json!({
                    "type": "tool_use",
                    "id": call.id,
                    "name": call.function.name,
                    "input": input,
                }));
            }
            (role, blocks)
        };
        if content.is_empty() {
            continue;
        }
        if let Some(last) = converted.last_mut() {
            if last.get("role").and_then(Value::as_str) == Some(role) {
                if let Some(blocks) = last.get_mut("content").and_then(Value::as_array_mut) {
                    blocks.append(&mut content);
                    continue;
                }
            }
        }
        converted.push(json!({"role": role, "content": content}));
    }
    let mut request = json!({
        "model": model,
        "max_tokens": max_output_tokens.unwrap_or(8192),
        "messages": converted,
    });
    if !system.is_empty() {
        request["system"] = json!(system);
    }
    if let Some(effort) = reasoning_effort {
        request["output_config"] = json!({"effort": effort.as_str()});
    }
    if !tools.is_empty() {
        request["tools"] = Value::Array(
            tools
                .iter()
                .map(|tool| {
                    json!({
                        "name": tool.name,
                        "description": tool.description,
                        "input_schema": tool.parameters,
                    })
                })
                .collect(),
        );
    }
    request
}

fn build_gemini_request(
    max_output_tokens: Option<u32>,
    reasoning_effort: Option<ReasoningEffort>,
    messages: &[Message],
    tools: &[ToolDefinition],
) -> Value {
    let system = messages
        .iter()
        .filter(|message| message.role == "system")
        .map(|message| message.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut contents: Vec<Value> = Vec::new();
    for message in messages.iter().filter(|message| message.role != "system") {
        let (role, mut parts) = if message.role == "tool" {
            let response = serde_json::from_str::<Value>(&message.content)
                .unwrap_or_else(|_| json!({"output": message.content}));
            let mut function_response = json!({
                "name": message.name.as_deref().unwrap_or("tool"),
                "response": response,
            });
            if let Some(id) = message.tool_call_id.as_deref().filter(|id| !id.is_empty()) {
                function_response["id"] = json!(id);
            }
            ("user", vec![json!({"functionResponse": function_response})])
        } else {
            let role = if message.role == "assistant" {
                "model"
            } else {
                "user"
            };
            let mut parts = Vec::new();
            if !message.content.is_empty() {
                parts.push(json!({"text": message.content}));
            }
            for call in message.tool_calls.as_deref().unwrap_or_default() {
                let args = serde_json::from_str::<Value>(&call.function.arguments)
                    .unwrap_or_else(|_| json!({"raw": call.function.arguments}));
                let mut function_call = json!({"name": call.function.name, "args": args});
                if !call.id.is_empty() {
                    function_call["id"] = json!(call.id);
                }
                parts.push(json!({"functionCall": function_call}));
            }
            (role, parts)
        };
        if parts.is_empty() {
            continue;
        }
        if let Some(last) = contents.last_mut() {
            if last.get("role").and_then(Value::as_str) == Some(role) {
                if let Some(existing) = last.get_mut("parts").and_then(Value::as_array_mut) {
                    existing.append(&mut parts);
                    continue;
                }
            }
        }
        contents.push(json!({"role": role, "parts": parts}));
    }
    let mut request = json!({"contents": contents});
    if !system.is_empty() {
        request["systemInstruction"] = json!({"parts": [{"text": system}]});
    }
    if max_output_tokens.is_some() || reasoning_effort.is_some() {
        let mut generation_config = json!({});
        if let Some(max_tokens) = max_output_tokens {
            generation_config["maxOutputTokens"] = json!(max_tokens);
        }
        if let Some(effort) = reasoning_effort {
            generation_config["thinkingConfig"] = json!({"thinkingLevel": effort.as_str()});
        }
        request["generationConfig"] = generation_config;
    }
    if !tools.is_empty() {
        request["tools"] = json!([{
            "functionDeclarations": tools.iter().map(|tool| json!({
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            })).collect::<Vec<_>>()
        }]);
    }
    request
}

fn parse_response(protocol: ModelProtocol, value: Value) -> Result<Response, ProviderError> {
    match protocol {
        ModelProtocol::OpenaiChat => parse_openai_chat_response(value),
        ModelProtocol::OpenaiResponses => parse_openai_responses_response(value),
        ModelProtocol::AnthropicMessages => parse_anthropic_response(value),
        ModelProtocol::GeminiContent => parse_gemini_response(value),
    }
}

fn ensure_nonempty(response: Response) -> Result<Response, ProviderError> {
    if response.content.trim().is_empty() && response.tool_calls.is_empty() {
        Err("模型响应既没有非空正文，也没有工具调用".into())
    } else {
        Ok(response)
    }
}

fn parse_openai_chat_response(value: Value) -> Result<Response, ProviderError> {
    let choice = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .ok_or("OpenAI Chat 响应缺少 choices[0]")?;
    if choice.get("finish_reason").and_then(Value::as_str) == Some("length") {
        return Err("OpenAI Chat 响应因输出长度限制被截断".into());
    }
    let message = choice
        .get("message")
        .ok_or("OpenAI Chat 响应缺少 message")?;
    let content = message
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let tool_calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|call| ToolCallRepr {
            id: call
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            r#type: call
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("function")
                .to_string(),
            func_name: call
                .pointer("/function/name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            arguments: call
                .pointer("/function/arguments")
                .and_then(Value::as_str)
                .unwrap_or("{}")
                .to_string(),
        })
        .collect();
    ensure_nonempty(Response {
        content,
        tool_calls,
    })
}

fn parse_openai_responses_response(value: Value) -> Result<Response, ProviderError> {
    if value.get("status").and_then(Value::as_str) == Some("incomplete") {
        return Err(format!(
            "OpenAI Responses 响应不完整: {}",
            value.get("incomplete_details").unwrap_or(&Value::Null)
        )
        .into());
    }
    let mut content = Vec::new();
    let mut tool_calls = Vec::new();
    for item in value
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        match item.get("type").and_then(Value::as_str) {
            Some("message") => {
                for block in item
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        content.push(text.to_string());
                    }
                }
            }
            Some("function_call") => tool_calls.push(ToolCallRepr {
                id: item
                    .get("call_id")
                    .or_else(|| item.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                r#type: "function".to_string(),
                func_name: item
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                arguments: item
                    .get("arguments")
                    .and_then(Value::as_str)
                    .unwrap_or("{}")
                    .to_string(),
            }),
            _ => {}
        }
    }
    ensure_nonempty(Response {
        content: content.join(""),
        tool_calls,
    })
}

fn parse_anthropic_response(value: Value) -> Result<Response, ProviderError> {
    if value.get("stop_reason").and_then(Value::as_str) == Some("max_tokens") {
        return Err("Anthropic 响应因 max_tokens 被截断".into());
    }
    let mut content = Vec::new();
    let mut tool_calls = Vec::new();
    for block in value
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    content.push(text.to_string());
                }
            }
            Some("tool_use") => tool_calls.push(ToolCallRepr {
                id: block
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                r#type: "function".to_string(),
                func_name: block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                arguments: serde_json::to_string(block.get("input").unwrap_or(&json!({})))?,
            }),
            _ => {}
        }
    }
    ensure_nonempty(Response {
        content: content.join(""),
        tool_calls,
    })
}

fn parse_gemini_response(value: Value) -> Result<Response, ProviderError> {
    let candidate = value
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|candidates| candidates.first())
        .ok_or("Gemini 响应缺少 candidates[0]")?;
    let finish_reason = candidate.get("finishReason").and_then(Value::as_str);
    if let Some(reason) = gemini_finish_failure(finish_reason) {
        return Err(format!("Gemini 响应未完成: {reason}").into());
    }
    let mut content = Vec::new();
    let mut tool_calls = Vec::new();
    for (index, part) in candidate
        .pointer("/content/parts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        if let Some(text) = part.get("text").and_then(Value::as_str) {
            content.push(text.to_string());
        }
        if let Some(call) = part.get("functionCall") {
            tool_calls.push(ToolCallRepr {
                id: call
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("gemini-call-{index}")),
                r#type: "function".to_string(),
                func_name: call
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                arguments: serde_json::to_string(call.get("args").unwrap_or(&json!({})))?,
            });
        }
    }
    ensure_nonempty(Response {
        content: content.join(""),
        tool_calls,
    })
}

fn gemini_finish_failure(reason: Option<&str>) -> Option<&str> {
    reason.filter(|reason| !reason.is_empty() && *reason != "STOP")
}

pub fn builtin_provider_catalog() -> BTreeMap<String, ProviderConfig> {
    BTreeMap::from([
        (
            "openai".to_string(),
            ProviderConfig {
                protocol: ModelProtocol::OpenaiResponses,
                base_url: "https://api.openai.com/v1".to_string(),
                credential: Some("openai".to_string()),
                ..ProviderConfig::default()
            },
        ),
        (
            "anthropic".to_string(),
            ProviderConfig {
                protocol: ModelProtocol::AnthropicMessages,
                base_url: "https://api.anthropic.com/v1".to_string(),
                credential: Some("anthropic".to_string()),
                ..ProviderConfig::default()
            },
        ),
        (
            "gemini".to_string(),
            ProviderConfig {
                protocol: ModelProtocol::GeminiContent,
                base_url: "https://generativelanguage.googleapis.com/v1beta".to_string(),
                credential: Some("gemini".to_string()),
                ..ProviderConfig::default()
            },
        ),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::{FunctionCall, ToolCall};
    use axum::{
        body::Body,
        response::Response as AxumResponse,
        routing::{get, post},
        Json, Router,
    };

    fn sse(body: &'static str) -> AxumResponse {
        AxumResponse::builder()
            .header("content-type", "text/event-stream")
            .body(Body::from(body))
            .unwrap()
    }

    fn messages() -> Vec<Message> {
        vec![
            Message {
                role: "system".to_string(),
                content: "system".to_string(),
                name: None,
                tool_call_id: None,
                tool_calls: None,
            },
            Message {
                role: "assistant".to_string(),
                content: String::new(),
                name: None,
                tool_call_id: None,
                tool_calls: Some(vec![ToolCall {
                    id: "call-1".to_string(),
                    r#type: "function".to_string(),
                    function: FunctionCall {
                        name: "read_file".to_string(),
                        arguments: "{\"path\":\"README.md\"}".to_string(),
                    },
                }]),
            },
            Message {
                role: "tool".to_string(),
                content: "contents".to_string(),
                name: Some("read_file".to_string()),
                tool_call_id: Some("call-1".to_string()),
                tool_calls: None,
            },
        ]
    }

    fn tools() -> Vec<ToolDefinition> {
        vec![ToolDefinition {
            name: "read_file".to_string(),
            description: "read".to_string(),
            parameters: json!({"type":"object"}),
        }]
    }

    #[test]
    fn protocol_requests_preserve_tool_call_and_result_identity() {
        let messages = messages();
        let tools = tools();
        let responses = build_request(
            ModelProtocol::OpenaiResponses,
            "m",
            Some(100),
            None,
            &messages,
            &tools,
        );
        assert_eq!(responses["input"][1]["call_id"], "call-1");
        assert_eq!(responses["input"][2]["call_id"], "call-1");

        let anthropic = build_request(
            ModelProtocol::AnthropicMessages,
            "m",
            Some(100),
            None,
            &messages,
            &tools,
        );
        assert_eq!(anthropic["messages"][0]["content"][0]["id"], "call-1");
        assert_eq!(
            anthropic["messages"][1]["content"][0]["tool_use_id"],
            "call-1"
        );

        let gemini = build_request(
            ModelProtocol::GeminiContent,
            "m",
            Some(100),
            None,
            &messages,
            &tools,
        );
        assert_eq!(
            gemini["contents"][0]["parts"][0]["functionCall"]["name"],
            "read_file"
        );
        assert_eq!(
            gemini["contents"][1]["parts"][0]["functionResponse"]["name"],
            "read_file"
        );
    }

    #[test]
    fn reasoning_effort_maps_to_each_native_protocol_without_model_name_inference() {
        let messages = messages();
        let tools = tools();
        let chat = build_request(
            ModelProtocol::OpenaiChat,
            "model",
            None,
            Some(ReasoningEffort::High),
            &messages,
            &tools,
        );
        assert_eq!(chat["reasoning_effort"], "high");

        let responses = build_request(
            ModelProtocol::OpenaiResponses,
            "gemini-through-a-proxy",
            None,
            Some(ReasoningEffort::High),
            &messages,
            &tools,
        );
        assert_eq!(responses["reasoning"]["effort"], "high");
        assert!(responses.get("reasoning_effort").is_none());

        let anthropic = build_request(
            ModelProtocol::AnthropicMessages,
            "model",
            None,
            Some(ReasoningEffort::Medium),
            &messages,
            &tools,
        );
        assert_eq!(anthropic["output_config"]["effort"], "medium");

        let gemini = build_request(
            ModelProtocol::GeminiContent,
            "model",
            None,
            Some(ReasoningEffort::Low),
            &messages,
            &tools,
        );
        assert_eq!(
            gemini["generationConfig"]["thinkingConfig"]["thinkingLevel"],
            "low"
        );

        let provider_default = build_request(
            ModelProtocol::OpenaiResponses,
            "model",
            None,
            None,
            &messages,
            &tools,
        );
        assert!(provider_default.get("reasoning").is_none());
    }

    #[test]
    fn protocol_responses_normalize_text_and_function_calls() {
        let openai = parse_response(
            ModelProtocol::OpenaiResponses,
            json!({"status":"completed","output":[
                {"type":"message","content":[{"type":"output_text","text":"working"}]},
                {"type":"function_call","call_id":"c1","name":"reply","arguments":"{\"text\":\"done\"}"}
            ]}),
        )
        .unwrap();
        assert_eq!(openai.content, "working");
        assert_eq!(openai.tool_calls[0].func_name, "reply");

        let anthropic = parse_response(
            ModelProtocol::AnthropicMessages,
            json!({"stop_reason":"tool_use","content":[
                {"type":"text","text":"working"},
                {"type":"tool_use","id":"c1","name":"reply","input":{"text":"done"}}
            ]}),
        )
        .unwrap();
        assert_eq!(anthropic.tool_calls[0].arguments, "{\"text\":\"done\"}");

        let gemini = parse_response(
            ModelProtocol::GeminiContent,
            json!({"candidates":[{"finishReason":"STOP","content":{"parts":[
                {"text":"working"}, {"functionCall":{"name":"reply","args":{"text":"done"}}}
            ]}}]}),
        )
        .unwrap();
        assert_eq!(gemini.tool_calls[0].func_name, "reply");
    }

    #[test]
    fn configured_provider_never_infers_protocol_from_model_name() {
        let mut app = AppConfig::default();
        app.llm.provider = Some("proxy".to_string());
        app.llm.model = "gemini-looking-name".to_string();
        app.providers.insert(
            "proxy".to_string(),
            ProviderConfig {
                protocol: ModelProtocol::AnthropicMessages,
                base_url: "http://localhost:1234/v1".to_string(),
                ..ProviderConfig::default()
            },
        );

        let (_, selected) = build_configured_client(&app, None, None).unwrap();

        assert_eq!(selected.protocol, ModelProtocol::AnthropicMessages);
    }

    #[tokio::test]
    async fn all_protocol_clients_reach_their_native_endpoint() {
        let app = Router::new()
            .route(
                "/models",
                get(|| async { Json(json!({"data":[{"id":"model-b"},{"id":"model-a"}]})) }),
            )
            .route(
                "/chat/completions",
                post(|| async {
                    Json(json!({"choices":[{"finish_reason":"stop","message":{"content":"chat"}}]}))
                }),
            )
            .route(
                "/responses",
                post(|| async {
                    Json(json!({"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"responses"}]}]}))
                }),
            )
            .route(
                "/messages",
                post(|| async {
                    Json(json!({"stop_reason":"end_turn","content":[{"type":"text","text":"anthropic"}]}))
                }),
            )
            .route(
                "/models/test-model:generateContent",
                post(|| async {
                    Json(json!({"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"gemini"}]}}]}))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let base_url = format!("http://{address}");
        let prompt = vec![Message {
            role: "user".to_string(),
            content: "hello".to_string(),
            name: None,
            tool_call_id: None,
            tool_calls: None,
        }];

        for (protocol, expected) in [
            (ModelProtocol::OpenaiChat, "chat"),
            (ModelProtocol::OpenaiResponses, "responses"),
            (ModelProtocol::AnthropicMessages, "anthropic"),
            (ModelProtocol::GeminiContent, "gemini"),
        ] {
            let client = ProtocolClient::new(
                &ProviderConfig {
                    protocol,
                    base_url: base_url.clone(),
                    ..ProviderConfig::default()
                },
                "test-model".to_string(),
                None,
                &LlmConfig {
                    max_retries: 1,
                    ..LlmConfig::default()
                },
            )
            .unwrap();
            let response = client
                .create_completion(prompt.clone(), Vec::new())
                .await
                .unwrap();
            assert_eq!(response.content, expected, "protocol={protocol:?}");
            let models = client.list_models().await.unwrap();
            assert_eq!(models, ["model-a", "model-b"]);
        }
    }

    #[tokio::test]
    async fn all_protocol_streams_normalize_text_tools_and_lifecycle() {
        let app = Router::new()
            .route(
                "/chat/completions",
                post(|| async {
                    sse(concat!(
                        "data: {\"choices\":[{\"delta\":{\"content\":\"hel\"}}]}\n\n",
                        "data: {\"choices\":[{\"delta\":{\"content\":\"lo\",\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"reply\",\"arguments\":\"{\\\"text\\\":\"}}]}}]}\n\n",
                        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"done\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
                        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":4,\"total_tokens\":14}}\n\n",
                        "data: [DONE]\n\n"
                    ))
                }),
            )
            .route(
                "/responses",
                post(|| async {
                    sse(concat!(
                        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n",
                        "data: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"type\":\"function_call\",\"call_id\":\"c1\",\"name\":\"reply\"}}\n\n",
                        "data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":1,\"delta\":\"{\\\"text\\\":\\\"done\\\"}\"}\n\n",
                        "data: {\"type\":\"response.function_call_arguments.done\",\"output_index\":1}\n\n",
                        "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":10,\"output_tokens\":4,\"total_tokens\":14}}}\n\n"
                    ))
                }),
            )
            .route(
                "/messages",
                post(|| async {
                    sse(concat!(
                        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10}}}\n\n",
                        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
                        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}\n\n",
                        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"c1\",\"name\":\"reply\",\"input\":{}}}\n\n",
                        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"text\\\":\\\"done\\\"}\"}}\n\n",
                        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
                        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":4}}\n\n",
                        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
                    ))
                }),
            )
            .route(
                "/models/test-model:streamGenerateContent",
                post(|| async {
                    sse(concat!(
                        "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hello\"}]}}]}\n\n",
                        "data: {\"candidates\":[{\"finishReason\":\"STOP\",\"content\":{\"parts\":[{\"functionCall\":{\"name\":\"reply\",\"args\":{\"text\":\"done\"}}}]}}],\"usageMetadata\":{\"promptTokenCount\":10,\"candidatesTokenCount\":4,\"totalTokenCount\":14}}\n\n"
                    ))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let base_url = format!("http://{address}");
        let prompt = vec![Message {
            role: "user".to_string(),
            content: "hello".to_string(),
            name: None,
            tool_call_id: None,
            tool_calls: None,
        }];

        for protocol in [
            ModelProtocol::OpenaiChat,
            ModelProtocol::OpenaiResponses,
            ModelProtocol::AnthropicMessages,
            ModelProtocol::GeminiContent,
        ] {
            let client = ProtocolClient::new(
                &ProviderConfig {
                    protocol,
                    base_url: base_url.clone(),
                    ..ProviderConfig::default()
                },
                "test-model".to_string(),
                None,
                &LlmConfig::default(),
            )
            .unwrap();
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            let response = client
                .create_completion_measured_stream(prompt.clone(), Vec::new(), None, tx)
                .await
                .unwrap();
            assert_eq!(response.content, "hello", "protocol={protocol:?}");
            assert_eq!(response.tool_calls.len(), 1, "protocol={protocol:?}");
            assert_eq!(response.tool_calls[0].func_name, "reply");
            assert_eq!(response.tool_calls[0].arguments, "{\"text\":\"done\"}");
            let events = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
            assert_eq!(events.first(), Some(&ModelStreamEvent::Started));
            assert_eq!(events.last(), Some(&ModelStreamEvent::Completed));
            assert!(events.iter().any(|event| matches!(
                event,
                ModelStreamEvent::ToolArgumentsDelta { delta, .. } if delta.contains("done")
            )));
        }
    }

    #[tokio::test]
    async fn provider_probe_verifies_catalog_stream_and_tool_call_separately() {
        let app = Router::new()
            .route(
                "/models",
                get(|| async { Json(json!({"data":[{"id":"test-model"}]})) }),
            )
            .route(
                "/chat/completions",
                post(|Json(body): Json<Value>| async move {
                    if body.get("tools").and_then(Value::as_array).is_some_and(|v| !v.is_empty()) {
                        sse(concat!(
                            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"probe-1\",\"function\":{\"name\":\"morphz_probe\",\"arguments\":\"{\\\"value\\\":\\\"MORPHZ_OK\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
                            "data: [DONE]\n\n"
                        ))
                    } else {
                        sse(concat!(
                            "data: {\"choices\":[{\"delta\":{\"content\":\"MORPHZ_OK\"},\"finish_reason\":\"stop\"}]}\n\n",
                            "data: [DONE]\n\n"
                        ))
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let mut config = AppConfig::default();
        config.llm.model = "test-model".to_string();
        config.providers.insert(
            "local".to_string(),
            ProviderConfig {
                protocol: ModelProtocol::OpenaiChat,
                base_url: format!("http://{address}"),
                ..ProviderConfig::default()
            },
        );

        let probe = probe_provider(&config, "local", Some("test-model"))
            .await
            .unwrap();

        assert_eq!(probe.models_discovered, 1);
        assert_eq!(probe.selected_model_available, Some(true));
        assert!(probe.completion_stream_verified);
        assert!(probe.tool_call_verified);
        assert!(probe.normalized_stream_events >= 8);
        assert!(probe.catalog_error.is_none());
    }
}

#[cfg(test)]
mod conformance;
