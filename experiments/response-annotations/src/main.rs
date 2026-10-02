//! Synthetic-input, JSONL model transport for the response-annotation lab.
//! Never initializes a Runtime/DB, migrates config, executes tools, or starts a
//! health probe. Config credentials and native continuation stay in-process.
use morphz::config::{self, AppConfig, CredentialSource, ProviderConfig};
use morphz::llm::{
    provider_continuation_message, Client, FunctionCall, Message, ModelAttemptBinding,
    ModelAttemptBindingError, ModelFailure, ModelRequestContext, ModelRequestOptions,
    ModelStreamEvent, ModelStreamSender, ProviderContinuation, ReasoningEffort, Response, ToolCall,
    ToolDefinition, PROVIDER_CONTINUATION_MESSAGE_NAME,
};
use morphz::provider::routing::{EffectiveProviderCatalog, RoutedClient};
use morphz::provider::{build_configured_client, list_provider_models};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};

const MAX_CLIENT_CALLS: usize = 16;
type CompletionError = Box<dyn std::error::Error + Send + Sync>;
const MAX_LINE_BYTES: usize = 2 * 1024 * 1024;
const FIXED_CONFIG: &str =
    "/Users/shafreeck/Library/Application Support/MorphzWork-development/runtime/morphz.toml";
const FIXED_HOST_CORE: &str = "/Users/shafreeck/.morphz/morphz.toml";
const FIXED_HOST_MODELS: &str = "/Users/shafreeck/.morphz/models.toml";
const FIXED_HOST_ENV: &str = "/Users/shafreeck/.morphz/.env";

#[derive(Clone)]
struct Options {
    config: PathBuf,
    host_core: PathBuf,
    host_models: PathBuf,
    host_env: PathBuf,
    model: Option<String>,
    init_only: bool,
    catalogue_only: bool,
    catalogue_loopback: bool,
}

impl Options {
    fn parse() -> Result<Self, &'static str> {
        let mut options = Self {
            config: PathBuf::from(FIXED_CONFIG),
            host_core: PathBuf::from(FIXED_HOST_CORE),
            host_models: PathBuf::from(FIXED_HOST_MODELS),
            host_env: PathBuf::from(FIXED_HOST_ENV),
            model: None,
            init_only: false,
            catalogue_only: false,
            catalogue_loopback: false,
        };
        let mut args = std::env::args().skip(1);
        while let Some(flag) = args.next() {
            match flag.as_str() {
                "--init-only" => options.init_only = true,
                "--catalogue-only" => options.catalogue_only = true,
                "--catalogue-loopback" => {
                    options.catalogue_only = true;
                    options.catalogue_loopback = true;
                }
                "--config" => options.config = PathBuf::from(args.next().ok_or("cli_arguments")?),
                "--host-core" => {
                    options.host_core = PathBuf::from(args.next().ok_or("cli_arguments")?)
                }
                "--host-models" => {
                    options.host_models = PathBuf::from(args.next().ok_or("cli_arguments")?)
                }
                "--host-env" => {
                    options.host_env = PathBuf::from(args.next().ok_or("cli_arguments")?)
                }
                "--model" => options.model = Some(args.next().ok_or("cli_arguments")?),
                _ => return Err("cli_arguments"),
            }
        }
        // Deliberately do not turn this experiment into credential discovery.
        if options.config != Path::new(FIXED_CONFIG)
            || options.host_core != Path::new(FIXED_HOST_CORE)
            || options.host_models != Path::new(FIXED_HOST_MODELS)
            || options.host_env != Path::new(FIXED_HOST_ENV)
        {
            return Err("unapproved_config_path");
        }
        if options
            .model
            .as_ref()
            .is_some_and(|model| model.is_empty() || model.len() > 128)
        {
            return Err("invalid_model");
        }
        Ok(options)
    }
}

#[derive(Deserialize)]
struct Request {
    request_id: String,
    messages: Vec<Message>,
    tools: Vec<morphz::llm::ToolDefinition>,
    model: Option<String>,
}

fn emit(value: &Value) -> Result<(), &'static str> {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    serde_json::to_writer(&mut out, value).map_err(|_| "output_io")?;
    out.write_all(b"\n").map_err(|_| "output_io")?;
    out.flush().map_err(|_| "output_io")
}

fn merge(into: &mut toml::Value, next: toml::Value) {
    match (into, next) {
        (toml::Value::Table(left), toml::Value::Table(right)) => {
            for (key, value) in right {
                if let Some(existing) = left.get_mut(&key) {
                    merge(existing, value);
                } else {
                    left.insert(key, value);
                }
            }
        }
        (left, right) => *left = right,
    }
}

fn load_config(options: &Options) -> Result<AppConfig, &'static str> {
    // The production resolve_config() can migrate/split files. Only read the
    // exact approved layers and merge them in the same host -> explicit order.
    let mut combined = toml::Value::Table(Default::default());
    for (path, category) in [
        (&options.host_core, "read_host_core"),
        (&options.host_models, "read_host_models"),
        (&options.config, "read_development_config"),
    ] {
        let content = std::fs::read_to_string(path).map_err(|_| category)?;
        let parsed = content.parse::<toml::Value>().map_err(|_| "parse_config")?;
        merge(&mut combined, parsed);
    }
    let mut app: AppConfig = combined.try_into().map_err(|_| "deserialize_config")?;
    config::load_env(options.host_env.to_str().ok_or("invalid_config_path")?)
        .map_err(|_| "load_registered_host_environment")?;
    // Runtime override handling is process-local. It does not change files.
    app.apply_runtime_env_overrides()
        .map_err(|_| "runtime_environment")?;
    // Registered command credentials could perform external side effects;
    // this bounded experiment only permits normal Env/Keychain/None sources.
    if app
        .credentials
        .values()
        .any(|credential| matches!(credential.source, CredentialSource::Command))
    {
        return Err("command_credential_not_permitted");
    }
    app.llm.max_output_tokens = Some(app.llm.max_output_tokens.unwrap_or(8192).min(8192));
    app.llm.reasoning_effort = Some(ReasoningEffort::Low);
    Ok(app)
}

fn configured_endpoint_origin(raw: &str) -> Result<String, &'static str> {
    let url = url::Url::parse(raw).map_err(|_| "invalid_provider_endpoint")?;
    let origin = url.origin().ascii_serialization();
    // `raw` is always the existing selected configuration, never a caller
    // supplied URL. The exact existing LAN proxy is approved for this lab.
    let permitted_transport = url.scheme() == "https"
        || (url.scheme() == "http"
            && (matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
                || origin == "http://mini-m4.local:8317"));
    if !permitted_transport
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("provider_endpoint_not_approved");
    }
    // Path and any other native URL components never enter the lab log.
    // The configured client itself still uses the original full endpoint.
    Ok(origin)
}

fn failure_category(error: &(dyn std::error::Error + Send + Sync + 'static)) -> &'static str {
    error
        .downcast_ref::<ModelFailure>()
        .map(|failure| failure.kind.as_str())
        .unwrap_or("provider_error")
}

fn route_failure_category(error: &str) -> &'static str {
    // Inspect diagnostics in memory, returning fixed labels only. Arbitrary
    // error text may embed config values and must not enter the JSONL log.
    for (fragment, category) in [
        ("has no configured Model Route", "model_alias_unconfigured"),
        (
            "allowed_evaluation_models",
            "evaluation_allowlist_unconfigured",
        ),
        ("no model Provider is selected", "model_provider_unselected"),
        ("has no Provider candidates", "route_candidates_empty"),
        ("empty base_url", "provider_endpoint_empty"),
        ("missing Provider Instance", "provider_reference_missing"),
        ("is not defined", "provider_reference_missing"),
        ("has no Auth Account", "provider_account_missing"),
        ("missing Auth Account", "provider_account_missing"),
        ("empty credential_ref", "account_credential_reference_empty"),
        ("empty auth_adapter", "account_adapter_empty"),
        ("not compatible", "provider_protocol_incompatible"),
        ("does not match", "provider_protocol_incompatible"),
        ("already registered", "route_alias_duplicate"),
        ("AccountUnavailable", "route_account_unavailable"),
    ] {
        if error.contains(fragment) {
            return category;
        }
    }
    "route_initialization"
}

fn catalogue_failure_category(error: &str) -> &'static str {
    for (fragment, category) in [
        (
            "requires environment variable",
            "catalogue_credential_environment_missing",
        ),
        (
            "nonexistent Credential",
            "catalogue_credential_reference_missing",
        ),
        ("Keychain", "catalogue_keychain_resolution"),
        ("No matching entry", "catalogue_keychain_resolution"),
        ("No matching credential", "catalogue_keychain_entry_missing"),
        (
            "No default store",
            "catalogue_keychain_default_store_missing",
        ),
        ("Platform failure", "catalogue_keychain_platform_failure"),
        (
            "Couldn't access platform storage",
            "catalogue_keychain_access",
        ),
        ("is empty", "catalogue_credential_empty"),
        ("returned HTTP 401", "catalogue_http_401"),
        ("returned HTTP 403", "catalogue_http_403"),
        ("returned HTTP 404", "catalogue_http_404"),
        ("returned HTTP 429", "catalogue_http_429"),
        ("returned HTTP 500", "catalogue_http_500"),
        ("missing the data/models array", "catalogue_schema"),
        ("error decoding response body", "catalogue_response_decode"),
        ("error parsing", "catalogue_response_decode"),
        ("error reading a body", "catalogue_response_body"),
        (
            "requires build feature",
            "catalogue_profile_build_feature_missing",
        ),
        ("dns error", "catalogue_dns"),
        ("error sending request", "catalogue_transport"),
    ] {
        if error.contains(fragment) {
            return category;
        }
    }
    "catalogue_error"
}

fn route_metadata(app: &AppConfig, model: &str) -> Value {
    let mut aliases: Vec<&str> = app.model_routes.keys().map(String::as_str).collect();
    for route in app.model_routes.values() {
        aliases.extend(route.aliases.iter().map(String::as_str));
    }
    if aliases.is_empty() && app.llm.provider.is_some() {
        aliases.push(app.llm.model.as_str());
        aliases.extend(app.llm.models.iter().map(String::as_str));
    }
    aliases.sort_unstable();
    aliases.dedup();
    aliases.truncate(40);
    let default_targets = app
        .model_routes
        .get(&app.llm.model)
        .map(|route| {
            route
                .candidates
                .iter()
                .take(4)
                .map(|candidate| {
                    let provider = app.provider_instances.get(&candidate.provider);
                    json!({
                        "physical_model":candidate.model,
                        "approved_endpoint_origin":provider.and_then(|p| configured_endpoint_origin(&p.base_url).ok()),
                        "protocol":provider.map(|p| p.protocol),
                        "account_count":provider.map(|p| p.accounts.len())
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({
        "kind":"route_metadata", "requested_model":model,
        "default_model":app.llm.model,
        "configured_aliases":aliases,
        "provider_count":app.provider_instances.len() + app.providers.len(),
        "account_count":app.auth_accounts.len(),
        "route_count":app.model_routes.len(),
        "default_route_targets":default_targets
    })
}

async fn inspect_catalogue(
    app: &AppConfig,
    model: &str,
    verified_loopback: bool,
) -> Result<(), &'static str> {
    let catalog = EffectiveProviderCatalog::from_config(app)
        .map_err(|error| route_failure_category(&error))?;
    let routed = RoutedClient::new(app, model.to_owned())
        .map_err(|error| route_failure_category(&error.to_string()))?;
    let binding = routed
        .primary_binding()
        .map_err(|error| route_failure_category(&error))?;
    let mut provider_id = binding.provider_instance_id.as_str();
    let mut provider = catalog
        .provider_instances
        .get(provider_id)
        .ok_or("provider_reference_missing")?;
    let mut account = catalog
        .auth_accounts
        .get(&binding.auth_account_id)
        .ok_or("provider_account_missing")?;
    let mut endpoint = provider.base_url.clone();
    let mut transport_source = "existing_configured_route";
    if verified_loopback {
        // Root verified this exact listener as the user's existing CLIProxyAPI
        // before authorizing this catalog-only, in-memory comparison.
        if let Some((id, local)) = catalog.provider_instances.iter().find(|(_, p)| {
            url::Url::parse(&p.base_url).ok().is_some_and(|url| {
                url.scheme() == "http"
                    && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
                    && url.port_or_known_default() == Some(8317)
            })
        }) {
            provider_id = id;
            provider = local;
            account = local
                .accounts
                .iter()
                .filter_map(|id| catalog.auth_accounts.get(id))
                .find(|account| account.enabled())
                .ok_or("provider_account_missing")?;
            endpoint = local.base_url.clone();
            transport_source = "existing_configured_loopback_provider";
        } else {
            endpoint = "http://127.0.0.1:8317/v1".into();
            transport_source = "registered_credential_for_verified_existing_cli_proxy";
        }
    }
    let origin = configured_endpoint_origin(&endpoint)?;
    let credential = match account.auth_adapter.as_str() {
        "none" => None,
        "credential" => Some(account.credential_ref.clone()),
        _ => return Err("catalogue_oauth_adapter_requires_runtime"),
    };
    let route = catalog
        .model_routes
        .get(&binding.route_id)
        .ok_or("model_alias_unconfigured")?;
    if verified_loopback {
        emit(&json!({
            "kind":"catalogue_mapping", "logical_alias":model,
            "physical_model":binding.physical_model, "endpoint_origin":origin,
            "protocol":provider.protocol, "transport_source":transport_source,
            "configuration_mutated":false
        }))?;
    } else {
        emit(&json!({
            "kind":"catalogue_mapping", "logical_alias":model,
            "physical_model":binding.physical_model,
            "provider_id":binding.provider_instance_id,
            "endpoint_origin":origin,
            "protocol":provider.protocol,
            "auth_adapter":account.auth_adapter,
            "existing_route":route,
            "host_models_path":FIXED_HOST_MODELS
        }))?;
    }
    // Reuse the normal registered-credential resolver without constructing a
    // Runtime/AuthManager or inspecting secret values. This temporary legacy
    // view lives in memory solely to call the public catalog-only API.
    let mut discovery_app = app.clone();
    // The public discovery API uses llm.model while building its transport;
    // retain the requested route's physical model, not an unrelated default
    // model whose optional compile-time transport profile could differ.
    discovery_app.llm.model = binding.physical_model.clone();
    discovery_app.providers.insert(
        provider_id.to_owned(),
        ProviderConfig {
            protocol: provider.protocol,
            base_url: endpoint,
            credential,
            models: provider.models.clone(),
            headers: provider.headers.clone(),
            env_headers: provider.env_headers.clone(),
        },
    );
    if let Err(error) = build_configured_client(
        &discovery_app,
        Some(provider_id),
        Some(&binding.physical_model),
    ) {
        emit(&json!({
            "kind":"catalogue_failure", "stage":"configured_client_materialization",
            "category":catalogue_failure_category(&error.to_string()),
            "http_status":null, "completion_requests":0
        }))?;
        return Err("catalogue_client_materialization");
    }
    let models = tokio::time::timeout(
        Duration::from_secs(60),
        list_provider_models(&discovery_app, provider_id),
    )
    .await
    .map_err(|_| "catalogue_timeout")?
    .map_err(|error| {
        let text = error.to_string();
        let status = text
            .split("model catalog returned HTTP ")
            .nth(1)
            .and_then(|tail| tail.get(..3))
            .and_then(|code| code.parse::<u16>().ok())
            .filter(|code| (100..600).contains(code));
        let category = catalogue_failure_category(&text);
        let _ = emit(&json!({
            "kind":"catalogue_failure", "stage":"get_models",
            "category":category, "http_status":status,
            "completion_requests":0
        }));
        category
    })?;
    let family_models: Vec<&str> = models
        .iter()
        .map(String::as_str)
        .filter(|id| id.starts_with("gpt-6"))
        .take(20)
        .collect();
    emit(&json!({
        "kind":"catalogue_result", "model_count":models.len(),
        "gpt_6_1_sol_present":models.iter().any(|id| id == "gpt-6.1-sol"),
        "gpt_6_family_models":if verified_loopback { Vec::<&str>::new() } else { family_models },
        "selected_model":model, "http_status":null, "http_status_category":"2xx",
        "completion_requests":0,
        "catalogue_source":"configured_provider_get_models"
    }))
}

fn assistant_key(message: &Message) -> Option<String> {
    if message.role != "assistant" {
        return None;
    }
    let calls = message.tool_calls.as_ref()?;
    if calls.is_empty() {
        return None;
    }
    serde_json::to_string(&calls.iter().map(|call| &call.id).collect::<Vec<_>>()).ok()
}

fn assistant_response(response: &Response) -> Message {
    Message {
        role: "assistant".into(),
        content: response.content.clone(),
        name: None,
        tool_call_id: None,
        tool_calls: Some(
            response
                .tool_calls
                .iter()
                .map(|call| ToolCall {
                    id: call.id.clone(),
                    r#type: call.r#type.clone(),
                    function: FunctionCall {
                        name: call.func_name.clone(),
                        arguments: call.arguments.clone(),
                    },
                })
                .collect(),
        ),
    }
}

struct StoredContinuation {
    assistant: Message,
    native: ProviderContinuation,
}

fn restore_continuations(
    messages: Vec<Message>,
    continuations: &HashMap<String, StoredContinuation>,
) -> Result<Vec<Message>, &'static str> {
    let mut restored = Vec::new();
    for message in messages {
        if message.name.as_deref() == Some(PROVIDER_CONTINUATION_MESSAGE_NAME) {
            return Err("caller_native_continuation_not_permitted");
        }
        if let Some(continuation) = assistant_key(&message)
            .as_ref()
            .and_then(|key| continuations.get(key))
        {
            // Never restore a native signature onto modified call arguments.
            // The driver executes stripped business args but must preserve the
            // original Provider-authored assistant/tool envelope in history.
            if message != continuation.assistant {
                return Err("continuation_assistant_mismatch");
            }
            restored.push(
                provider_continuation_message(continuation.native.clone())
                    .map_err(|_| "continuation_encoding")?,
            );
        }
        restored.push(message);
    }
    Ok(restored)
}

struct StreamState {
    continuation: Option<ProviderContinuation>,
    usage: Option<Value>,
    started: usize,
    native_continuation_events: usize,
    usage_events: usize,
    text_delta_events: usize,
    tool_arguments_delta_events: usize,
}

async fn bind_native_attempt(
    client: &dyn Client,
    model: &str,
    request_id: &str,
) -> Result<ModelAttemptBinding, ModelAttemptBindingError> {
    // These names are synthetic transport scope, not durable user identities.
    // No Runtime/DB authority is attached to this experiment's routed client.
    client
        .bind_requested_model_attempt(
            &ModelRequestContext {
                context_id: "synthetic-response-annotations-context".into(),
                session_id: "synthetic-response-annotations-session".into(),
                attempt_id: request_id.into(),
                objective_id: None,
                required_capabilities: Vec::new(),
            },
            Some(model),
        )
        .await
}

async fn complete_native_bound(
    client: &dyn Client,
    binding: &ModelAttemptBinding,
    messages: Vec<Message>,
    tools: Vec<ToolDefinition>,
    stream: ModelStreamSender,
) -> Result<Response, CompletionError> {
    // Match the production Orchestrator entry. Calling measured_stream() on
    // RoutedClient directly uses the Client trait's atomic compatibility
    // fallback and therefore cannot validate native deltas/usage/state.
    client
        .create_completion_bound_stream_with_options(
            binding,
            messages,
            tools,
            None,
            stream,
            ModelRequestOptions {
                reasoning_effort: Some(Some(ReasoningEffort::Low)),
            },
        )
        .await
}

fn binding_error_category(error: &ModelAttemptBindingError) -> &'static str {
    match error {
        ModelAttemptBindingError::AccountUnavailable(_) => "binding_account_unavailable",
        ModelAttemptBindingError::Configuration(_) => "binding_configuration",
        ModelAttemptBindingError::Runtime(_) => "binding_runtime",
    }
}

fn binding_metadata(binding: &ModelAttemptBinding) -> Value {
    // No account identity, credential, native continuation or full URL.
    json!({
        "requested_model":binding.requested_alias,
        "physical_model":binding.physical_model,
        "protocol":binding.protocol,
        "endpoint_origin":configured_endpoint_origin(&binding.endpoint).ok()
    })
}

fn forward_event(
    event: ModelStreamEvent,
    request_id: &str,
    elapsed_ms: u128,
    state: &mut StreamState,
) -> Result<(), &'static str> {
    match &event {
        ModelStreamEvent::ProviderContinuation { .. } => state.native_continuation_events += 1,
        ModelStreamEvent::Usage { .. } => state.usage_events += 1,
        ModelStreamEvent::TextDelta { .. } => state.text_delta_events += 1,
        ModelStreamEvent::ToolArgumentsDelta { .. } => state.tool_arguments_delta_events += 1,
        _ => {}
    }
    // Native continuation must never reach stdout, stderr, or a lab log.
    let event = match event {
        ModelStreamEvent::ProviderContinuation { continuation } => {
            state.continuation = Some(continuation);
            return Ok(());
        }
        ModelStreamEvent::Failed { .. } => json!({"kind":"failed","message":"provider_failure"}),
        ModelStreamEvent::Incomplete { .. } => {
            json!({"kind":"incomplete","reason":"provider_incomplete"})
        }
        ModelStreamEvent::Usage { usage } => {
            let mut value = serde_json::to_value(usage).map_err(|_| "event_encoding")?;
            if let Some(object) = value.as_object_mut() {
                object.remove("raw");
            }
            state.usage = Some(value.clone());
            json!({"kind":"usage","usage":value})
        }
        ModelStreamEvent::Started => {
            state.started += 1;
            json!({"kind":"started"})
        }
        other => serde_json::to_value(other).map_err(|_| "event_encoding")?,
    };
    emit(&json!({
        "kind":"stream", "request_id":request_id, "elapsed_ms":elapsed_ms, "event":event
    }))
}

async fn run() -> Result<(), &'static str> {
    let options = Options::parse()?;
    let app = load_config(&options)?;
    let model = options
        .model
        .as_deref()
        .unwrap_or(&app.llm.model)
        .to_owned();
    if options.catalogue_only {
        return inspect_catalogue(&app, &model, options.catalogue_loopback).await;
    }
    let (client, selected): (Arc<dyn Client>, _) =
        build_configured_client(&app, None, Some(&model)).map_err(|error| {
            let _ = emit(&route_metadata(&app, &model));
            route_failure_category(&error.to_string())
        })?;
    let base_url = configured_endpoint_origin(&selected.base_url).map_err(|category| {
        let origin = url::Url::parse(&selected.base_url)
            .ok()
            .map(|url| url.origin().ascii_serialization());
        let _ = emit(&json!({
            "kind":"route_metadata", "selected_model":selected.model,
            "protocol":selected.protocol, "endpoint_origin":origin,
            "endpoint_approved":false
        }));
        category
    })?;
    // Legacy configured providers can materialize their registered credential
    // without a request. Do not fabricate that guarantee for OAuth routes.
    let credential_reference_checked = if app.providers.contains_key(&selected.id) {
        let _ = build_configured_client(&app, Some(&selected.id), Some(&model))
            .map_err(|_| "registered_credential_resolution")?;
        true
    } else {
        false
    };
    emit(&json!({
        "kind":"ready", "model":selected.model, "protocol":selected.protocol,
        "base_url":base_url, "credential_reference_checked":credential_reference_checked,
        "base_url_scope":"origin_only",
        "maximum_client_calls":MAX_CLIENT_CALLS, "http_request_count_available":false,
        "native_continuation":"process_memory_only", "reasoning_effort":"low",
        "stream_entry":"native_bound_with_options",
        "max_output_tokens":app.llm.max_output_tokens
    }))?;
    if options.init_only {
        return Ok(());
    }
    let mut reader = BufReader::new(tokio::io::stdin());
    let mut line = String::new();
    let mut client_calls = 0;
    let mut total_started = 0;
    let mut continuations: HashMap<String, StoredContinuation> = HashMap::new();
    loop {
        line.clear();
        if reader.read_line(&mut line).await.map_err(|_| "input_io")? == 0 {
            return Ok(());
        }
        if line.len() > MAX_LINE_BYTES {
            emit(&json!({"kind":"error","category":"request_size_limit"}))?;
            continue;
        }
        let request: Request = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(_) => {
                emit(&json!({"kind":"error","category":"invalid_request"}))?;
                continue;
            }
        };
        if request.request_id.is_empty() || request.request_id.len() > 128 {
            emit(&json!({"kind":"error","category":"invalid_request_id"}))?;
            continue;
        }
        if request
            .model
            .as_ref()
            .is_some_and(|requested_model| requested_model != &model)
        {
            emit(
                &json!({"kind":"error","request_id":request.request_id,"category":"model_frozen"}),
            )?;
            continue;
        }
        if client_calls >= MAX_CLIENT_CALLS {
            emit(
                &json!({"kind":"error","request_id":request.request_id,"category":"client_call_limit"}),
            )?;
            continue;
        }
        let messages = match restore_continuations(request.messages, &continuations) {
            Ok(messages) => messages,
            Err(category) => {
                emit(&json!({"kind":"error","request_id":request.request_id,"category":category}))?;
                continue;
            }
        };
        let binding = match bind_native_attempt(client.as_ref(), &model, &request.request_id).await
        {
            Ok(binding) => binding,
            Err(error) => {
                emit(&json!({
                    "kind":"error", "request_id":request.request_id,
                    "category":binding_error_category(&error),
                    "client_call_count":client_calls, "http_request_count":null
                }))?;
                continue;
            }
        };
        configured_endpoint_origin(&binding.endpoint)?;
        emit(&json!({
            "kind":"binding", "request_id":request.request_id,
            "metadata":binding_metadata(&binding)
        }))?;
        client_calls += 1;
        let start = Instant::now();
        let mut state = StreamState {
            continuation: None,
            usage: None,
            started: 0,
            native_continuation_events: 0,
            usage_events: 0,
            text_delta_events: 0,
            tool_arguments_delta_events: 0,
        };
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let completion = tokio::time::timeout(
            Duration::from_secs(120),
            complete_native_bound(client.as_ref(), &binding, messages, request.tools, sender),
        );
        tokio::pin!(completion);
        let mut stream_open = true;
        let outcome = loop {
            tokio::select! {
                result = &mut completion => break result,
                event = receiver.recv(), if stream_open => {
                    if let Some(event) = event {
                        forward_event(event, &request.request_id, start.elapsed().as_millis(), &mut state)?;
                    } else {
                        stream_open = false;
                    }
                }
            }
        };
        while let Ok(event) = receiver.try_recv() {
            forward_event(
                event,
                &request.request_id,
                start.elapsed().as_millis(),
                &mut state,
            )?;
        }
        total_started += state.started;
        let native_events = json!({
            "continuation":state.native_continuation_events,
            "usage":state.usage_events,
            "text_delta":state.text_delta_events,
            "tool_arguments_delta":state.tool_arguments_delta_events
        });
        match outcome {
            Ok(Ok(response)) => {
                let assistant = assistant_response(&response);
                let preserved = match (assistant_key(&assistant), state.continuation) {
                    (Some(key), Some(continuation)) => {
                        continuations.insert(
                            key,
                            StoredContinuation {
                                assistant,
                                native: continuation,
                            },
                        );
                        true
                    }
                    _ => false,
                };
                emit(&json!({
                    "kind":"result", "request_id":request.request_id, "response":response,
                    "usage":state.usage, "elapsed_ms":start.elapsed().as_millis(),
                    "client_call_count":client_calls, "started_events_this_call":state.started,
                    "started_events_total":total_started, "http_request_count":null,
                    "continuation_preserved":preserved, "native_events":native_events,
                    "binding":binding_metadata(&binding)
                }))?;
            }
            Ok(Err(error)) => {
                emit(&json!({
                    "kind":"error", "request_id":request.request_id,
                    "category":failure_category(error.as_ref()), "client_call_count":client_calls,
                    "started_events_this_call":state.started, "started_events_total":total_started,
                    "http_request_count":null, "native_events":native_events
                }))?;
            }
            Err(_) => {
                emit(&json!({
                    "kind":"error", "request_id":request.request_id, "category":"request_timeout",
                    "client_call_count":client_calls, "started_events_this_call":state.started,
                    "started_events_total":total_started, "http_request_count":null,
                    "native_events":native_events
                }))?;
            }
        }
    }
}

#[tokio::main]
async fn main() {
    if let Err(category) = run().await {
        let _ = emit(&json!({"kind":"error","category":category}));
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Default)]
    struct NativeEntryOnlyClient {
        bindings: AtomicUsize,
        completions: AtomicUsize,
    }

    // Match async_trait's boxed signatures without adding a production or
    // experiment dependency merely for a fake transport.
    impl Client for NativeEntryOnlyClient {
        fn create_completion<'life0, 'async_trait>(
            &'life0 self,
            _messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
        ) -> Pin<Box<dyn Future<Output = Result<Response, CompletionError>> + Send + 'async_trait>>
        where
            'life0: 'async_trait,
            Self: 'async_trait,
        {
            Box::pin(async { panic!("atomic/unbound completion entry must not be used") })
        }

        fn bind_requested_model_attempt<'life0, 'life1, 'life2, 'async_trait>(
            &'life0 self,
            request: &'life1 ModelRequestContext,
            requested_model: Option<&'life2 str>,
        ) -> Pin<
            Box<
                dyn Future<Output = Result<ModelAttemptBinding, ModelAttemptBindingError>>
                    + Send
                    + 'async_trait,
            >,
        >
        where
            'life0: 'async_trait,
            'life1: 'async_trait,
            'life2: 'async_trait,
            Self: 'async_trait,
        {
            Box::pin(async move {
                assert_eq!(requested_model, Some("synthetic-native-model"));
                assert_eq!(request.context_id, "synthetic-response-annotations-context");
                assert_eq!(request.session_id, "synthetic-response-annotations-session");
                assert_eq!(request.attempt_id, "synthetic-request-1");
                assert_eq!(request.objective_id, None);
                assert!(request.required_capabilities.is_empty());
                self.bindings.fetch_add(1, Ordering::SeqCst);
                Ok(ModelAttemptBinding {
                    requested_alias: "synthetic-native-model".into(),
                    route_id: "synthetic-route".into(),
                    route_revision: "synthetic-revision".into(),
                    provider_instance_id: "synthetic-provider".into(),
                    auth_account_id: "synthetic-account".into(),
                    physical_model: "synthetic-physical-model".into(),
                    protocol: "openai-responses".into(),
                    provider_adapter: "synthetic-adapter".into(),
                    provider_adapter_version: "synthetic-v1".into(),
                    endpoint: "http://localhost:8317/v1".into(),
                    request_session_id: Some(request.session_id.clone()),
                    capabilities: Vec::new(),
                    model_input_limits: Default::default(),
                })
            })
        }

        fn create_completion_bound_stream_with_options<'life0, 'life1, 'async_trait>(
            &'life0 self,
            binding: &'life1 ModelAttemptBinding,
            _messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
            measurement: Option<morphz::llm::PromptTokenCount>,
            stream: ModelStreamSender,
            options: ModelRequestOptions,
        ) -> Pin<Box<dyn Future<Output = Result<Response, CompletionError>> + Send + 'async_trait>>
        where
            'life0: 'async_trait,
            'life1: 'async_trait,
            Self: 'async_trait,
        {
            Box::pin(async move {
                assert_eq!(binding.physical_model, "synthetic-physical-model");
                assert_eq!(options.reasoning_effort, Some(Some(ReasoningEffort::Low)));
                assert!(measurement.is_none());
                self.completions.fetch_add(1, Ordering::SeqCst);
                stream.send(ModelStreamEvent::Started).unwrap();
                stream
                    .send(ModelStreamEvent::TextDelta {
                        text: "native-".into(),
                    })
                    .unwrap();
                stream
                    .send(ModelStreamEvent::TextDelta {
                        text: "bound".into(),
                    })
                    .unwrap();
                stream
                    .send(ModelStreamEvent::Usage {
                        usage: morphz::llm::ModelUsage {
                            input_tokens: Some(10),
                            output_tokens: Some(2),
                            ..Default::default()
                        },
                    })
                    .unwrap();
                stream
                    .send(ModelStreamEvent::ProviderContinuation {
                        continuation: ProviderContinuation::OpenaiResponses {
                            reasoning_items: vec![json!({"encrypted_content":"synthetic-only"})],
                        },
                    })
                    .unwrap();
                stream.send(ModelStreamEvent::Completed).unwrap();
                Ok(Response {
                    content: "native-bound".into(),
                    tool_calls: Vec::new(),
                })
            })
        }
    }

    #[tokio::test]
    async fn bridge_uses_bound_options_native_entry_not_atomic_fallback() {
        let fake = NativeEntryOnlyClient::default();
        let client: &dyn Client = &fake;
        let binding = bind_native_attempt(client, "synthetic-native-model", "synthetic-request-1")
            .await
            .unwrap();
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let response = complete_native_bound(client, &binding, Vec::new(), Vec::new(), sender)
            .await
            .unwrap();
        assert_eq!(response.content, "native-bound");
        assert_eq!(fake.bindings.load(Ordering::SeqCst), 1);
        assert_eq!(fake.completions.load(Ordering::SeqCst), 1);
        let mut text_chunks = 0;
        let mut usage = false;
        let mut continuation = false;
        while let Ok(event) = receiver.try_recv() {
            match event {
                ModelStreamEvent::TextDelta { .. } => text_chunks += 1,
                ModelStreamEvent::Usage { usage: value } => usage = value.input_tokens == Some(10),
                ModelStreamEvent::ProviderContinuation { .. } => continuation = true,
                _ => {}
            }
        }
        assert_eq!(text_chunks, 2);
        assert!(usage && continuation);
        assert_eq!(
            binding_metadata(&binding),
            json!({
                "requested_model":"synthetic-native-model", "physical_model":"synthetic-physical-model",
                "protocol":"openai-responses", "endpoint_origin":"http://localhost:8317"
            })
        );
    }

    fn sample_response() -> Response {
        Response {
            content: "".into(),
            tool_calls: vec![morphz::llm::ToolCallRepr {
                id: "synthetic-call-1".into(),
                r#type: "function".into(),
                func_name: "read_fixture".into(),
                arguments: r#"{"_annotations":{"intent":"read"},"key":"os"}"#.into(),
            }],
        }
    }

    #[test]
    fn config_merge_is_in_memory_and_right_biased() {
        let mut left: toml::Value =
            "[llm]\nmodel = 'old'\n[providers.test]\nbase_url = 'http://localhost:8317/v1'"
                .parse()
                .unwrap();
        let right: toml::Value = "[llm]\nmodel = 'new'".parse().unwrap();
        merge(&mut left, right);
        assert_eq!(left["llm"]["model"].as_str(), Some("new"));
        assert_eq!(
            left["providers"]["test"]["base_url"].as_str(),
            Some("http://localhost:8317/v1")
        );
    }

    #[test]
    fn native_continuation_is_reinserted_before_unchanged_assistant() {
        let assistant = assistant_response(&sample_response());
        let native = ProviderContinuation::OpenaiResponses {
            reasoning_items: vec![
                json!({"type":"reasoning","encrypted_content":"synthetic-opaque"}),
            ],
        };
        let key = assistant_key(&assistant).unwrap();
        let stored = HashMap::from([(
            key,
            StoredContinuation {
                assistant: assistant.clone(),
                native: native.clone(),
            },
        )]);
        let restored = restore_continuations(vec![assistant.clone()], &stored).unwrap();
        assert_eq!(restored.len(), 2);
        assert_eq!(
            morphz::llm::provider_continuation(&restored[0]),
            Some(native)
        );
        assert_eq!(restored[1], assistant);
    }

    #[test]
    fn stripped_or_changed_provider_arguments_cannot_reuse_native_state() {
        let assistant = assistant_response(&sample_response());
        let key = assistant_key(&assistant).unwrap();
        let stored = HashMap::from([(
            key,
            StoredContinuation {
                assistant: assistant.clone(),
                native: ProviderContinuation::OpenaiResponses {
                    reasoning_items: vec![],
                },
            },
        )]);
        let mut changed = assistant;
        changed.tool_calls.as_mut().unwrap()[0].function.arguments = r#"{"key":"os"}"#.into();
        assert_eq!(
            restore_continuations(vec![changed], &stored).unwrap_err(),
            "continuation_assistant_mismatch"
        );
    }

    #[test]
    fn caller_cannot_supply_native_marker() {
        let marker = provider_continuation_message(ProviderContinuation::OpenaiResponses {
            reasoning_items: vec![],
        })
        .unwrap();
        assert_eq!(
            restore_continuations(vec![marker], &HashMap::new()).unwrap_err(),
            "caller_native_continuation_not_permitted"
        );
    }

    #[test]
    fn only_approved_credential_free_transports_are_permitted() {
        assert!(configured_endpoint_origin("http://127.0.0.1:8317/v1").is_ok());
        assert!(configured_endpoint_origin("http://mini-m4.local:8317/v1").is_ok());
        assert!(configured_endpoint_origin("https://configured.example/v1").is_ok());
        assert!(configured_endpoint_origin("http://example.test/v1").is_err());
        assert!(configured_endpoint_origin("http://mini-m4.local:8318/v1").is_err());
        assert!(configured_endpoint_origin("http://user:synthetic@127.0.0.1:8317/v1").is_err());
        assert!(configured_endpoint_origin("http://127.0.0.1:8317/v1?key=synthetic").is_err());
        assert!(configured_endpoint_origin("https://configured.example/v1#synthetic").is_err());
        assert_eq!(
            configured_endpoint_origin("http://mini-m4.local:8317/v1").unwrap(),
            "http://mini-m4.local:8317"
        );
    }
}
